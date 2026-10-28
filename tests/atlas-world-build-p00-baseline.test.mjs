/**
 * atlas-world-build-p00-baseline.test.mjs — P00 旧行为复现（计划 §1.3、§6「先复现」）。
 *
 * 这些测试**刻意断言旧行为**，用来证明「问题真实存在」并给后续阶段留对照。
 * P02 修共同预算、P06 修尺度与归图之后，这里的断言必须改成新行为——
 * 在那之前不许把它们删掉当「已修复」。
 *
 * 覆盖：
 *   F03 65 条合法操作只保留 64 条，剩余 1 条丢弃且不续跑（TOO_MANY_OPERATIONS）。
 *   F05 登记地图行 ≠ 已完成布局：有行、无 scene 的图会被算成「已建设」。
 *   F06 未标定 vehicle 100×100 格被估成 24×24 m（FLOOR_BASE_SIDE_M），小车家具明显过大。
 *
 * 数据全部匿名合成，不引用任何用户剧情。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, insertRows } from './fixtures/atlas-sql/seed.mjs';
import { createTableReadPort } from '../src/atlas-db-readport.ts';
import { deriveLayoutSites } from '../src/atlas-sql-layout-task.ts';
import { parseOperations } from '../src/atlas-ops-parser.ts';

const SQL = await (await import('sql.js')).default();
const BRANCH = IDS.branchMain;

function loc(id, over = {}) {
  return {
    branch_id: BRANCH, id, name: id, aliases_json: '[]', kind: 'other', description: '',
    parent_location_id: null, mobility: 'fixed', anchor_location_id: null, map_id: null,
    grid_x: null, grid_y: null, coord_precision: 'unknown', uncertainty_radius_cells: null,
    area_geometry_json: null, terrain: 'unknown', access_rules_json: null, vehicle_profile_json: null,
    existence_quality: 'confirmed', status: 'active', merged_into_id: null, row_rev: 1,
    created_turn_id: IDS.seedTurn, updated_turn_id: IDS.seedTurn, ...over,
  };
}

function mapRow(id, over = {}) {
  return {
    branch_id: BRANCH, id, name: `${id} 图`, kind: 'interior', container_location_id: null,
    description: '',
    frame_json: { origin_x: 0, origin_y: 0, cols: 100, rows: 100 },
    meters_per_cell: null, scale_min_meters_per_cell: null, scale_max_meters_per_cell: null,
    scale_quality: 'uncalibrated', scale_basis_json: '{}', scale_locked: 0, calibration_rev: 1,
    background_asset_key: null, default_terrain: 'unknown', status: 'active', row_rev: 1,
    created_turn_id: IDS.seedTurn, updated_turn_id: IDS.seedTurn, ...over,
  };
}

/** 地点必须先登记 entity_keys，否则外键/触发器会报 ENTITY_KEY_KIND_MISMATCH。 */
function insertLocation(seed, row) {
  insertRows(seed.db, 'entity_keys', [{ branch_id: BRANCH, id: row.id, kind: 'location' }]);
  insertRows(seed.db, 'locations', [row]);
}

/** 从派生结果里取某张图的 entry；取不到直接失败，避免「空对象也能过」。 */
function entryOf(derived, mapId) {
  const entry = derived.entries.find((item) => item.mapId === mapId);
  assert.ok(entry, `派生结果里应有地图 ${mapId}`);
  return entry;
}

/* ─────────────────────────── F03 ─────────────────────────── */

/**
 * 注意（P02 之后）：这里断言的是**解析器层**的旧行为，它保持不变——
 * 解析器始终是最后一道 64 条防线。
 * F03 回归：完整操作不再被解析器或隐藏共同总额截断；显式工作配额另行验证。
 * 这些断言验证原先丢失的第 65 条和后续路线现在都被保留。
 */
test('F03 回归：65 条合法操作完整保留，第 65 条也进入执行', () => {
  const lines = Array.from(
    { length: 65 },
    (_v, i) => `{"op":"character.upsert","ref":"C${i + 1}","data":{"thought":"观察${i + 1}。"}}`,
  );
  const result = parseOperations(lines.join('\n'), { phase: 'observe' });

  // 修复后完整保留已返回的有效操作
  assert.equal(result.operations.length, 65);
  // 不再生成旧的条数超限错误
  const tooMany = result.issues.filter((issue) => issue.code === 'TOO_MANY_OPERATIONS');
  assert.equal(tooMany.length, 0);
  // 第 65 条保留，回复不因条数被标为 incomplete
  assert.equal(result.incomplete, false);
  const carried = result.operations.filter((op) => op.value.ref === 'C65');
  assert.equal(carried.length, 1, '第 65 条完整保留');
});

test('F03 回归：地点与路线各 64 条时完整接收 128 条', () => {
  // 计划 F03 记录：construction 允许地点/路线各 64，解析器共同只收 64。
  const ops = [];
  for (let i = 0; i < 64; i += 1) {
    ops.push(`{"op":"location.upsert","ref":"L${i}","data":{"name":"地点${i}"}}`);
  }
  for (let i = 0; i < 64; i += 1) {
    ops.push(`{"op":"route.upsert","ref":"R${i}","data":{"from":"L0","to":"L1"}}`);
  }
  const result = parseOperations(ops.join('\n'), { phase: 'geography' });
  assert.equal(result.operations.length, 128, '完整接收已返回的有效操作');
  assert.equal(result.issues.some((issue) => issue.code === 'TOO_MANY_OPERATIONS'), false);
});

/* ─────────────────────────── F06 ─────────────────────────── */

test('F06 旧行为：未标定 vehicle 100×100 格被估成 24×24 m', async () => {
  const seed = await makeSeedWith(SQL);
  insertLocation(seed, loc('L_CART', { kind: 'vehicle', name: '匿名马车', mobility: 'fixed' }));
  insertRows(seed.db, 'maps', [
    mapRow('M_CART', { container_location_id: 'L_CART', kind: 'interior' }),
  ]);

  const derived = deriveLayoutSites(createTableReadPort(seed.db), BRANCH);
  const entry = entryOf(derived, 'M_CART');

  assert.equal(entry.kind, 'floor');
  assert.equal(entry.extent.units, 'meters', '未标定却输出米制');
  // 旧行为：整层底边固定 24 m，与 100×100 格的内容尺度无关
  assert.equal(entry.extent.width, 24);
  assert.equal(entry.extent.height, 24);
  // 换算下来 1 格 = 0.24 m，车厢里的箱子会被画成 0.24 m 见方
  assert.equal(entry.extent.width / 100, 0.24);
});

test('F06 旧行为：room 与 city 各自走固定基线，没有「类型化家具档案」', async () => {
  const seed = await makeSeedWith(SQL);
  insertLocation(seed, loc('L_ROOM', { kind: 'room', name: '匿名房间' }));
  insertLocation(seed, loc('L_CITY', { kind: 'city', name: '匿名城镇' }));
  insertRows(seed.db, 'maps', [
    mapRow('M_ROOM', { container_location_id: 'L_ROOM' }),
    mapRow('M_CITY', { container_location_id: 'L_CITY', kind: 'site' }),
  ]);

  const derived = deriveLayoutSites(createTableReadPort(seed.db), BRANCH);

  const room = entryOf(derived, 'M_ROOM');
  assert.equal(room.extent.width, 12, '单间房按 12 m 估');

  const city = entryOf(derived, 'M_CITY');
  // city solver 要求 900×700 画布，于是 100×100 格被放大到 1000×1000 m
  assert.equal(city.extent.width, 1000);
  assert.equal(city.extent.height, 1000);
});

test('F06 旧行为：已标定的直径不参与家具尺度，只缩放整图', async () => {
  const seed = await makeSeedWith(SQL);
  insertLocation(seed, loc('L_HALL', { kind: 'building', name: '匿名大厅' }));
  insertRows(seed.db, 'maps', [
    mapRow('M_HALL', { container_location_id: 'L_HALL', meters_per_cell: 0.5, scale_quality: 'confirmed' }),
  ]);

  const derived = deriveLayoutSites(createTableReadPort(seed.db), BRANCH);
  const entry = entryOf(derived, 'M_HALL');
  // 100 格 × 0.5 m = 50 m：标定生效，说明问题只出在「未标定 + 类型默认」这条路径
  assert.equal(entry.extent.width, 50);
  assert.equal(entry.extent.units, 'meters');
});

/* ─────────────────────────── F05 ─────────────────────────── */

test('F05 旧行为：登记即有 entry，但不代表布局已绘制出来', async () => {
  const seed = await makeSeedWith(SQL);
  insertLocation(seed, loc('L_A', { kind: 'building', name: '匿名建筑 A' }));
  insertLocation(seed, loc('L_B', { kind: 'building', name: '匿名建筑 B' }));
  insertLocation(seed, loc('L_C', { kind: 'building', name: '匿名建筑 C' }));
  insertRows(seed.db, 'maps', [
    // A：有 scene → 真的画过
    mapRow('M_A', {
      container_location_id: 'L_A',
      frame_json: {
        origin_x: 0, origin_y: 0, cols: 40, rows: 30,
        atlasScene: { kind: 'atlas-scene', version: 1, mapId: 'M_A' },
      },
    }),
    // B / C：只有地图行，没有 scene → 未绘制
    mapRow('M_B', { container_location_id: 'L_B' }),
    mapRow('M_C', { container_location_id: 'L_C' }),
  ]);

  const derived = deriveLayoutSites(createTableReadPort(seed.db), BRANCH);
  const seeded = ['M_A', 'M_B', 'M_C'].map((id) => entryOf(derived, id));
  assert.equal(seeded.length, 3, '三张图都有 entry —— 登记就算「在队列里」');

  const drawn = seeded.filter((entry) => {
    const frame = entry.map.frame_json;
    return frame && typeof frame === 'object' && frame.atlasScene !== undefined && frame.atlasScene !== null;
  });
  assert.equal(drawn.length, 1, '只有 1 张真的画了布局');

  // 旧行为：entry 数量（3）会被当成「已建设 3 个」上报，实际可用布局只有 1 个
  assert.notEqual(seeded.length, drawn.length);
});
