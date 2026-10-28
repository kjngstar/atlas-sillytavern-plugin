/**
 * atlas-npc-spatial-context.test.mjs — P11 §17.2「NPC 空间上下文」的接线证据。
 *
 * 不测纯函数（那是 atlas-scene-entry / atlas-scene-facts 的事），只测**真实链路**：
 * SQL 里的地点链 / 地图帧 / 空间 canonical → `buildDecisionContext` 的 actorSlices.scene。
 *
 * 要证明的五件事：
 * 1. 每个 actor 拿到的是**自己**位置的现场（地点链、入口、关键障碍真实占地、约束）。
 * 2. 别人的房间细节不泄漏：不在那儿的人拿不到那间屋子的家具与门。
 * 3. 位置未知就是 null —— 不拿目录里的地点名字填空。
 * 4. 与正文注入共用同一个属性构建器：同一条陈设的占地、挡路判定完全一致。
 * 5. 零写库：读多少次，数据库导出字节都不变。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { makeSeedWith, insertRows, IDS } from './fixtures/atlas-sql/seed.mjs';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { buildDecisionContext } from '../src/atlas-sim-decision-context.ts';
import { buildPovSceneLines } from '../src/atlas-db-knowledge-view.ts';

const SQL = await initSqlJs();
/** 密室：在**它自己的**室内图上（一张图只承载一个地点权威）。 */
const SECRET = 'L_SECRET';
const SECRET_MAP = 'M_SECRET';
/** 位置完全未知的 NPC。 */
const NOBODY = 'C_NOLOC';

/** 教室 L3 的空间权威：6×4 米，含书架（挡路）、玻璃隔断、木门。 */
const classroomCanonical = {
  version: 1,
  locationId: IDS.L3,
  revision: 1,
  size: { widthM: 6, heightM: 4 },
  furnishing: [
    { localId: `space:${IDS.L3}:furn:F1`, type: 'shelf', name: '书架', itemId: null, widthM: 3, heightM: 1, quality: 'confirmed' },
    { localId: `space:${IDS.L3}:furn:G1`, type: 'partition', name: '玻璃隔断', itemId: null, widthM: 2, heightM: 0.2, quality: 'confirmed' },
    { localId: `space:${IDS.L3}:furn:D1`, type: 'door', name: '木门', itemId: null, widthM: 1, heightM: 0.2, quality: 'confirmed' },
  ],
};

/** 密室 L_SECRET 的陈设：它绝不能出现在任何一个不在场者的切片里。 */
const secretCanonical = {
  version: 1,
  locationId: SECRET,
  revision: 1,
  size: { widthM: 3, heightM: 3 },
  furnishing: [
    { localId: `space:${SECRET}:furn:X1`, type: 'chest', name: '铁箱', itemId: null, widthM: 1, heightM: 0.6, quality: 'confirmed' },
  ],
};

const base = (seed, id) => ({
  branch_id: seed.branchId, id, row_rev: 1,
  created_turn_id: seed.seedTurnId, updated_turn_id: seed.seedTurnId,
});

async function fixture() {
  const seed = await makeSeedWith(SQL);
  const { db } = seed;
  db.run('BEGIN');

  // 教室图 M2：装教室自己的空间权威 + 已保存的内部布局。
  db.run('UPDATE maps SET frame_json = ? WHERE branch_id = ? AND id = ?', [
    JSON.stringify({
      origin_x: 0, origin_y: 0, reference_width_cells: 20, reference_height_cells: 15,
      atlasSpaceCanonical: classroomCanonical,
      atlasScene: { version: 1 },
    }),
    seed.branchId,
    IDS.M2,
  ]);

  // 密室图 M_SECRET：独立一张室内图，只承载密室。
  insertRows(db, 'maps', [{
    ...base(seed, SECRET_MAP),
    name: '密室图', kind: 'interior', container_location_id: null, description: '',
    frame_json: JSON.stringify({
      origin_x: 0, origin_y: 0, reference_width_cells: 8, reference_height_cells: 8,
      atlasSpaceCanonical: secretCanonical,
      atlasScene: { version: 1 },
    }),
    meters_per_cell: 1, scale_min_meters_per_cell: 1, scale_max_meters_per_cell: 1,
    scale_quality: 'confirmed', scale_basis_json: '{}', scale_locked: 0, calibration_rev: 1,
    background_asset_key: null, default_terrain: 'unknown', status: 'active',
  }]);

  insertRows(db, 'entity_keys', [{ branch_id: seed.branchId, id: SECRET, kind: 'location' }]);
  insertRows(db, 'locations', [{
    ...base(seed, SECRET),
    name: '锁着的密室', aliases_json: '[]', kind: 'room', description: '',
    parent_location_id: IDS.L2, mobility: 'fixed', anchor_location_id: null,
    map_id: SECRET_MAP, grid_x: 3, grid_y: 3, coord_precision: 'exact',
    uncertainty_radius_cells: null, area_geometry_json: null, terrain: 'unknown',
    access_rules_json: null, vehicle_profile_json: null,
    existence_quality: 'hypothetical', status: 'active', merged_into_id: null,
  }]);

  // 位置完全未知的 NPC：地点为空、也没有坐标。
  insertRows(db, 'entity_keys', [{ branch_id: seed.branchId, id: NOBODY, kind: 'character' }]);
  insertRows(db, 'characters', [{
    ...base(seed, NOBODY),
    name: '不知去向的人', aliases_json: '[]', role: 'npc', identity: '来历不明',
    description: '', personality: '', importance: 'supporting', importance_reason: '',
    thought: '他其实藏在密室', action_tendency: '', physical_status: 'alive', condition_note: '',
    location_id: null, map_id: null, grid_x: null, grid_y: null, coord_precision: 'unknown',
    uncertainty_radius_cells: null, mobility_profiles_json: '[]', capabilities_json: '[]',
    status: 'active', merged_into_id: null,
  }]);

  // 主角 C1 在教室里（seed 默认给他学校 L2；教室 L3 才是带空间权威的房间）。
  db.run('UPDATE characters SET location_id = ?, map_id = NULL, grid_x = NULL, grid_y = NULL, coord_precision = ? WHERE branch_id = ? AND id = ?', [
    IDS.L3, 'unknown', seed.branchId, IDS.C1,
  ]);

  db.run('COMMIT');
  return seed;
}

function sliceOf(context, entityId) {
  const slice = context.actorSlices.find((entry) => entry.entityId === entityId);
  assert.ok(slice, `${entityId} 必须有切片`);
  return slice;
}

test('§17.2 每个 actor 拿到自己位置的现场：地点链、入口、关键障碍的真实占地', async () => {
  const seed = await fixture();
  const context = buildDecisionContext({ actors: [{ entityId: IDS.C1 }], opportunities: [] }, { db: seed.db, branchId: seed.branchId });
  const slice = sliceOf(context, IDS.C1);

  assert.ok(slice.scene, '人物的位置明确时必须给空间切片');
  assert.equal(slice.scene.location.locationId, IDS.L3);
  assert.deepEqual(
    slice.scene.location.chain.map((node) => node.name),
    ['圣罗兰城', '圣光学校', '教室'],
    '祖先链要能看出他在城里、学校里',
  );
  assert.equal(slice.scene.location.units, 'meters');
  assert.equal(slice.scene.location.metersPerCell, 1);

  assert.deepEqual(slice.scene.entrances.map((entry) => entry.name), ['木门'], '门作为入口给出');
  const shelf = slice.scene.blockers.find((blocker) => blocker.name === '书架');
  assert.ok(shelf, '书架必须作为障碍出现');
  assert.equal(shelf.footprintCells, 3, '3×1 米在 1 米/格的地图上是 3 格');
  assert.equal(shelf.blocksMovement, true, '书架挡路（判定来自统一属性构建器）');
  assert.equal(slice.scene.truncated, false);

  // 引用键带上自己的地点，提示词层才有短引用可用。
  assert.ok(context.refs.includes(`location:${IDS.L3}`), '地点引用进入 refs');
  seed.close();
});

test('§17.2 别人房间的细节不泄漏：不在那儿的人拿不到那间屋子的家具与门', async () => {
  const seed = await fixture();
  const context = buildDecisionContext({ actors: [{ entityId: IDS.C2 }], opportunities: [] }, { db: seed.db, branchId: seed.branchId });
  const slice = sliceOf(context, IDS.C2);

  assert.ok(slice.scene, 'C2 在城里，位置是明确的');
  assert.equal(slice.scene.location.locationId, IDS.L1);
  assert.deepEqual(slice.scene.entrances, [], '城里的教室门不该出现在他的切片里');
  assert.deepEqual(slice.scene.blockers, []);
  const serialized = JSON.stringify(slice);
  assert.equal(serialized.includes('铁箱'), false, '密室的陈设不泄漏');
  assert.equal(serialized.includes(SECRET), false, '密室 ID 不泄漏');
  assert.equal(serialized.includes('书架'), false, '教室的陈设不泄漏');
  seed.close();
});

test('§17.2 位置未知就是 null，不拿目录里的地点名字填空', async () => {
  const seed = await fixture();
  const context = buildDecisionContext({ actors: [{ entityId: NOBODY }], opportunities: [] }, { db: seed.db, branchId: seed.branchId });
  const slice = sliceOf(context, NOBODY);
  assert.equal(slice.scene, null, '位置未知 → scene 为 null');
  assert.equal(JSON.stringify(slice).includes('圣罗兰'), false, '不能用城市名字冒充他在那儿');
  seed.close();
});

test('§17.2 与正文注入共用同一属性构建器：同一条陈设的占地/挡路判定完全一致', async () => {
  const seed = await fixture();

  const context = buildDecisionContext({ actors: [{ entityId: IDS.C1 }], opportunities: [] }, { db: seed.db, branchId: seed.branchId });
  const slice = sliceOf(context, IDS.C1);
  const lines = buildPovSceneLines(
    { db: seed.db, branchId: seed.branchId },
    { povId: IDS.C1, locationId: IDS.L3, position: { kind: 'at_location', precision: 'coarse' } },
  ).lines;

  const shelf = slice.scene.blockers.find((blocker) => blocker.name === '书架');
  const line = lines.find((entry) => entry.startsWith('关键陈设与障碍'));
  assert.ok(line, '正文必须给出关键陈设行');
  assert.ok(line.includes('书架（3×1 米，挡路）'), `正文措辞应与决策切片同源：${line}`);
  assert.equal(shelf.blocksMovement, true, '正文说挡路，决策切片也必须说挡路');
  assert.ok(lines.some((entry) => entry.startsWith('所在地点：圣罗兰城 › 圣光学校 › 教室')), '正文地点链同源');
  seed.close();
});

test('§17.2 读切片是零写入：连读多次数据库导出字节不变', async () => {
  const seed = await fixture();
  const before = seed.exportBytes();
  const tables = ['knowledge', 'events', 'characters', 'locations'];
  const counts = tables.map((table) => queryBound(seed.db, `SELECT COUNT(*) AS n FROM ${table} WHERE branch_id = ?`, [seed.branchId])[0].n);
  for (let index = 0; index < 5; index += 1) {
    buildDecisionContext({ actors: [{ entityId: IDS.C1 }, { entityId: IDS.C2 }, { entityId: NOBODY }], opportunities: [] }, { db: seed.db, branchId: seed.branchId });
  }
  const after = seed.exportBytes();
  assert.equal(Buffer.compare(Buffer.from(before), Buffer.from(after)), 0, '只读路径不得写库');
  const afterCounts = tables.map((table) => queryBound(seed.db, `SELECT COUNT(*) AS n FROM ${table} WHERE branch_id = ?`, [seed.branchId])[0].n);
  assert.deepEqual(afterCounts, counts);
  seed.close();
});
