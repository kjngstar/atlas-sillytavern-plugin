/**
 * M2-04：真实容器自引用回归（T05「地点落自己内图」）。
 *
 * 纪律：
 * - 用真实 SQL 夹具（tests/fixtures/atlas-sql/seed.mjs），不造假的「两个字符串相等」。
 * - 判据是**实际容器**：地点 L 的 `map_id` 所指地图，其 `container_location_id` 就是 L。
 * - 旧档自带的自容器对（夹具里 L3↔M2）必须**只读容忍**：不毒化之后的所有写入；
 *   只有「本次候选引入或恶化」才让对应原子组失败（09 报错定位表：旧问题与新恶化区别）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadSqlModule } from '../src/atlas-db-runtime.ts';
import { validateCandidate, validateGroup } from '../src/atlas-db-invariants.ts';
import { IDS, insertRows, makeSeedWith, selectOne } from './fixtures/atlas-sql/seed.mjs';

const BRANCH = IDS.branchMain;
const TURN = IDS.seedTurn;

function c(id) {
  return { branch_id: BRANCH, id, row_rev: 1, created_turn_id: TURN, updated_turn_id: TURN };
}

function locationRow(over = {}) {
  return {
    ...c(over.id),
    name: '测试地点',
    aliases_json: '[]',
    kind: 'room',
    description: '',
    parent_location_id: null,
    mobility: 'fixed',
    anchor_location_id: null,
    map_id: null,
    grid_x: null,
    grid_y: null,
    coord_precision: 'unknown',
    uncertainty_radius_cells: null,
    area_geometry_json: null,
    terrain: 'unknown',
    access_rules_json: null,
    vehicle_profile_json: null,
    existence_quality: 'inferred',
    status: 'active',
    merged_into_id: null,
    ...over,
  };
}

function mapRow(over = {}) {
  return {
    ...c(over.id),
    name: '测试地图',
    kind: 'interior',
    container_location_id: null,
    description: '',
    frame_json: JSON.stringify({ origin_x: 0, origin_y: 0, reference_width_cells: 20, reference_height_cells: 15 }),
    meters_per_cell: 1,
    scale_min_meters_per_cell: null,
    scale_max_meters_per_cell: null,
    scale_quality: 'uncalibrated',
    scale_basis_json: '{}',
    scale_locked: 0,
    calibration_rev: 1,
    background_asset_key: null,
    default_terrain: 'unknown',
    status: 'active',
    ...over,
  };
}

/** 地点详情必须先有 entity_keys 身份行（否则触发 ENTITY_KEY_KIND_MISMATCH）。 */
function addLocation(db, row) {
  insertRows(db, 'entity_keys', [{ branch_id: row.branch_id, id: row.id, kind: 'location' }]);
  insertRows(db, 'locations', [row]);
}

const topologyCodes = (result) =>
  result.violations.filter((v) => v.code.startsWith('INVARIANT_MAP_') || v.code === 'INVARIANT_LOCATION_MAP_SELF');

test('T05 命中：候选新建「地点落自己内图」的图对被拒，且报实际容器关系', async () => {
  const SQL = await loadSqlModule();
  const seed = await makeSeedWith(SQL);
  const db = seed.db;

  // M_SELF.container = L_SELF 且 L_SELF.map_id = M_SELF：互相引用的自容器对，由本组引入。
  const map = mapRow({ id: 'M_SELF', name: '自容器内图', container_location_id: 'L_SELF' });
  const loc = locationRow({
    id: 'L_SELF',
    name: '自容器房间',
    kind: 'room',
    map_id: 'M_SELF',
    grid_x: 2,
    grid_y: 3,
    coord_precision: 'exact',
  });
  // map → locations 与 locations → maps 两条外键都是 DEFERRABLE INITIALLY DEFERRED，可在同一事务内互插。
  db.run('BEGIN');
  insertRows(db, 'maps', [map]);
  addLocation(db, loc);
  db.run('COMMIT');
  assert.equal(selectOne(db, 'maps', BRANCH, 'M_SELF').container_location_id, 'L_SELF');
  assert.equal(selectOne(db, 'locations', BRANCH, 'L_SELF').map_id, 'M_SELF');

  const result = validateGroup(db, BRANCH, ['maps', 'locations'], ['M_SELF', 'L_SELF'], [
    { table: 'maps', rowId: 'M_SELF', row: map, before: null },
    { table: 'locations', rowId: 'L_SELF', row: loc, before: null },
  ]);

  const hit = result.violations.find((v) => v.code === 'INVARIANT_LOCATION_MAP_SELF');
  assert.ok(hit, `必须命中 INVARIANT_LOCATION_MAP_SELF，实际：${result.violations.map((v) => v.code).join(',')}`);
  assert.equal(hit.table, 'locations');
  assert.equal(hit.rowId, 'L_SELF', '报的是地点行，不是「两个 ID 字符串相等」');
  assert.equal(hit.field, 'map_id');
  assert.equal(result.ok, false);

  seed.close();
});

test('T05 合法地图不误报：夹具自带的旧自容器对在全库检查下零违规（不毒化未来写入）', async () => {
  const SQL = await loadSqlModule();
  const seed = await makeSeedWith(SQL);
  const db = seed.db;

  // 夹具确实带有旧档自容器对（教室 L3 ↔ 教室图 M2）——这是基线既有事实，不是造出来的。
  assert.equal(selectOne(db, 'locations', BRANCH, IDS.L3).map_id, IDS.M2);
  assert.equal(selectOne(db, 'maps', BRANCH, IDS.M2).container_location_id, IDS.L3);

  const full = validateCandidate(db, { branchId: BRANCH });
  assert.deepEqual(topologyCodes(full), [], '旧档问题不得让全库一致性检查失败');
  assert.equal(full.ok, true, '夹具世界必须整体干净');
  assert.equal(full.violations.length, 0);

  seed.close();
});

test('T05 只改 parent / 旧问题未恶化 / 独立合法组：都继续保存', async () => {
  const SQL = await loadSqlModule();
  const seed = await makeSeedWith(SQL);
  const db = seed.db;

  // (1) 只改 L3 的 parent（教室从「学校」改挂到「城市」）：旧自容器对既没引入也没恶化。
  const before = selectOne(db, 'locations', BRANCH, IDS.L3);
  const after = { ...before, parent_location_id: IDS.L1, row_rev: Number(before.row_rev) + 1 };
  db.run('BEGIN');
  db.run('UPDATE locations SET parent_location_id = ?, row_rev = ? WHERE branch_id = ? AND id = ?', [
    IDS.L1,
    after.row_rev,
    BRANCH,
    IDS.L3,
  ]);
  db.run('COMMIT');
  const parentOnly = validateGroup(db, BRANCH, ['locations'], [IDS.L3], [
    { table: 'locations', rowId: IDS.L3, row: after, before },
  ]);
  assert.deepEqual(topologyCodes(parentOnly), [], '旧自容器对不得因为无关 parent 改动而变成新问题');
  assert.equal(parentOnly.ok, true);
  assert.equal(selectOne(db, 'maps', BRANCH, IDS.M2).container_location_id, IDS.L3, '旧档结构保持只读不变');

  // (2) 独立合法组：新增一个真正的新房间（挂在教室内、画在教室图上，没有自己的新图）。
  const room = locationRow({
    id: 'L_NEW_ROOM',
    name: '新房间',
    kind: 'room',
    parent_location_id: IDS.L3,
    map_id: IDS.M2,
    grid_x: 8,
    grid_y: 4,
    coord_precision: 'layout',
  });
  db.run('BEGIN');
  addLocation(db, room);
  db.run('COMMIT');
  const fresh = validateGroup(db, BRANCH, ['locations'], ['L_NEW_ROOM'], [
    { table: 'locations', rowId: 'L_NEW_ROOM', row: room, before: null },
  ]);
  assert.deepEqual(topologyCodes(fresh), [], '合法新房间不得被旧档问题连坐');
  assert.equal(fresh.ok, true);

  // (3) 无 before 信息（向后兼容路径）也不得误报成新问题。
  const noBefore = validateGroup(db, BRANCH, ['locations'], [IDS.L3], [
    { table: 'locations', rowId: IDS.L3, row: after },
  ]);
  assert.deepEqual(topologyCodes(noBefore), [], '缺 before 时按「未改变」保守处理');

  seed.close();
});

test('T03/坏根传导：候选新增第二张无容器顶图 → 明确拒绝（INVARIANT_MAP_MULTIPLE_ROOTS）', async () => {
  const SQL = await loadSqlModule();
  const seed = await makeSeedWith(SQL);
  const db = seed.db;

  const extraRoot = mapRow({ id: 'M_ROOT2', name: '第二顶图', kind: 'world', container_location_id: null });
  db.run('BEGIN');
  insertRows(db, 'maps', [extraRoot]);
  db.run('COMMIT');

  const result = validateGroup(db, BRANCH, ['maps'], ['M_ROOT2'], [
    { table: 'maps', rowId: 'M_ROOT2', row: extraRoot, before: null },
  ]);
  const hit = result.violations.find((v) => v.code === 'INVARIANT_MAP_MULTIPLE_ROOTS');
  assert.ok(hit, `必须命中 INVARIANT_MAP_MULTIPLE_ROOTS，实际：${result.violations.map((v) => v.code).join(',')}`);
  assert.equal(hit.table, 'maps');
  assert.equal(hit.rowId, 'M_ROOT2', '报的是新引入的那张顶图');
  assert.equal(result.ok, false);

  // 该问题一旦被移除（回滚式还原），组边界重新干净。
  db.run('DELETE FROM maps WHERE branch_id = ? AND id = ?', [BRANCH, 'M_ROOT2']);
  const clean = validateGroup(db, BRANCH, ['maps'], [], []);
  assert.deepEqual(topologyCodes(clean), []);

  seed.close();
});
