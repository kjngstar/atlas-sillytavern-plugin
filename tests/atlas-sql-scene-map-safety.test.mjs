/**
 * M2-11：P03 精确跨图保护 / P04 估计跨图与成员清理（真实 SQL + 真实 journal，不用替身断言）。
 *
 * 判据来源 05-验收场景：
 * - P03：L1 的 parent 从 A 改 B，旧 exact point + confirmed polygon，无 transform。
 *        必须 parent 更新、旧 map/xy/完整 area 保留、写 COORD_FRAME_MIGRATION_BLOCKED、不降级为 layout。
 * - P04：L1 是未锁定 layout 点，从 A 图移到 B 图，A 含 L1 与 L2 几何。
 *        必须只去掉 A 的 L1 锚点、L2 几何不变、B 有唯一 L1 示意入口。
 * - 「删除楼层后值应恢复」用真实 journal 倒序回放来验证，不用字符串替换糊过去。
 *
 * 本文件明确**不覆盖**的两条断言（属后续里程碑，当前代码里没有对应机制，不在这里假装通过）：
 * - 「新父图有 placementKind=proxy 可点击入口」→ 布局/场景阶段的代理入口（M4-33 与 M6）。
 * - 「sceneLocationGeometry/compileSceneGroup 不回写旧实坐标」→ 场景编译链的接线段（M2-12 之后）。
 *
 * 边界：不调用外网；数据只存在于内存临时数据库。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadSqlModule } from '../src/atlas-db-runtime.ts';
import { applyGroups } from '../src/atlas-db-commit.ts';
import { compileSqlSceneMaps } from '../src/atlas-sql-scene-maps.ts';
import { collectSceneMemberIds, pruneInvalidSceneMembers } from '../src/atlas-spatial-candidate.ts';
import { IDS, insertRows, makeSeedWith, selectOne } from './fixtures/atlas-sql/seed.mjs';

const BRANCH = IDS.branchMain;
const TURN = IDS.seedTurn;

/** A/B 两张同分支容器图；PA/PB 是两个一级地点，容器图分别挂在它们身上。 */
const MAP_A = 'MAP_A';
const MAP_B = 'MAP_B';
const PA = 'PA';
const PB = 'PB';
/** 被移动的地点，以及同图里必须完全不变的无关邻居。 */
const SUBJECT = 'T_SUBJECT';
const NEIGHBOUR = 'T_NEIGHBOUR';

const FRAME_CELLS = 40;
const POLYGON = {
  kind: 'polygon',
  points: [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 4 }, { x: 1, y: 4 }],
  quality: 'confirmed',
  source: 'author',
};
const NEIGHBOUR_POLYGON = {
  kind: 'polygon',
  points: [{ x: 20, y: 20 }, { x: 26, y: 20 }, { x: 26, y: 25 }, { x: 20, y: 25 }],
  quality: 'confirmed',
  source: 'author',
};

const c = (id) => ({ branch_id: BRANCH, id, row_rev: 1, created_turn_id: TURN, updated_turn_id: TURN });

function mapRow(id, container) {
  return {
    ...c(id),
    name: id,
    kind: 'site',
    container_location_id: container,
    description: '',
    frame_json: JSON.stringify({ origin_x: 0, origin_y: 0, cols: FRAME_CELLS, rows: FRAME_CELLS, reference_width_cells: FRAME_CELLS, reference_height_cells: FRAME_CELLS }),
    meters_per_cell: 1,
    scale_min_meters_per_cell: null,
    scale_max_meters_per_cell: null,
    scale_quality: 'estimated',
    scale_basis_json: '{}',
    scale_locked: 0,
    calibration_rev: 1,
    background_asset_key: null,
    default_terrain: 'unknown',
    status: 'active',
  };
}

function locationRow(id, over = {}) {
  return {
    ...c(id),
    name: id,
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

async function fixture() {
  const SQL = await loadSqlModule();
  const seed = await makeSeedWith(SQL);
  const db = seed.db;
  insertRows(db, 'entity_keys', [
    { branch_id: BRANCH, id: PA, kind: 'location' },
    { branch_id: BRANCH, id: PB, kind: 'location' },
    { branch_id: BRANCH, id: SUBJECT, kind: 'location' },
    { branch_id: BRANCH, id: NEIGHBOUR, kind: 'location' },
  ]);
  // 顺序受外键约束：maps.container_location_id → locations，locations.map_id → maps。
  insertRows(db, 'locations', [
    locationRow(PA, { name: '甲城', kind: 'city' }),
    locationRow(PB, { name: '乙城', kind: 'city' }),
  ]);
  insertRows(db, 'maps', [mapRow(MAP_A, PA), mapRow(MAP_B, PB)]);
  insertRows(db, 'locations', [
    locationRow(SUBJECT, { name: '目标屋', parent_location_id: PA, map_id: MAP_A, grid_x: 3, grid_y: 4, coord_precision: 'exact', area_geometry_json: JSON.stringify(POLYGON) }),
    locationRow(NEIGHBOUR, { name: '邻居屋', parent_location_id: PA, map_id: MAP_A, grid_x: 22, grid_y: 22, coord_precision: 'exact', area_geometry_json: JSON.stringify(NEIGHBOUR_POLYGON) }),
  ]);
  return db;
}

let opCounter = 0;
function compile(db) {
  opCounter += 1;
  return compileSqlSceneMaps({
    db, branchId: BRANCH, turnId: TURN, clockS: 0, ensureScenes: true,
    operationId: `op_m2_11_${opCounter}`,
    makeId: (kind, ignored, alias) => `${kind}_${alias}`,
  });
}

/**
 * 把「parent 从 PA 改到 PB」做成**同一回合里被 journal 记录**的真实写入，
 * 这样后面才能真的用回放来验证「删掉这一楼后值恢复」。
 */
let topologyCounter = 0;
function applyParentChange(db, parentLocationId) {
  topologyCounter += 1;
  const before = selectOne(db, 'locations', BRANCH, SUBJECT);
  const after = { ...before, parent_location_id: parentLocationId, row_rev: Number(before.row_rev) + 1, updated_turn_id: TURN };
  const group = {
    id: `grp_topology_${topologyCounter}`,
    opIds: [`op_topology_${topologyCounter}`],
    dependsOn: [],
    readSet: [],
    mutations: [{
      table: 'locations',
      rowId: SUBJECT,
      before,
      after,
      sourceOpIds: [`op_topology_${topologyCounter}`],
      basis: { kind: 'manual', reason: '作者改正父地点', certainty: 'confirmed' },
    }],
  };
  const result = applyGroups(db, [group], { branchId: BRANCH, turnId: TURN, attemptId: `topology_${topologyCounter}`, validate: true });
  assert.deepEqual(result.journalIssues, []);
  assert.ok(!result.groups.some((item) => item.status === 'rejected' || item.status === 'blocked'), JSON.stringify(result.groups));
}

const mutationsOf = (group, rowId) => (group?.mutations ?? []).filter((m) => m.rowId === rowId);
const issuesOf = (group) => group?.opIssues ?? [];
const issueMessages = (group, code) => issuesOf(group).filter((issue) => issue.code === code).map((issue) => issue.message);

/** 每个被移动的地点都必须能在 COORD_FRAME_MIGRATION_BLOCKED 的 message 里查到自己的 ID。 */
function assertBlockedMentions(group, locationId) {
  const messages = issueMessages(group, 'COORD_FRAME_MIGRATION_BLOCKED');
  assert.equal(messages.length, 1, `必须写且只写一条 COORD_FRAME_MIGRATION_BLOCKED：${JSON.stringify(issuesOf(group).map((i) => i.code))}`);
  assert.ok(messages[0].includes(locationId), `错误要能按 ID 查回来，message 里必须点名 ${locationId}：${messages[0]}`);
}

/**
 * journal 倒序回放 before，等价于「删掉这一楼」。
 *
 * 必须复刻产线 `applyRollbackPlan` 的 `normalizeValue`：journal 里存的是**已解码**的行
 * （`aliases_json` 等 JSON 列是数组/对象），写回前要重新 JSON.stringify，
 * 否则会把 `[]` 当裸值绑进 SQLite，落成 `{}` —— 那是回放器的锅，不是产线的锅。
 */
function normalizeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function revertTurn(db) {
  const rows = db.exec(`SELECT operation, target_table, target_row_id, before_json FROM turn_changes WHERE turn_id = '${TURN}' ORDER BY sequence DESC`)[0]?.values ?? [];
  for (const [operation, table, rowId, beforeJson] of rows) {
    if (operation === 'insert') {
      db.run(`DELETE FROM ${table} WHERE branch_id = ? AND id = ?`, [BRANCH, rowId]);
      continue;
    }
    if (operation === 'delete') continue;
    const before = JSON.parse(String(beforeJson));
    const columns = Object.keys(before);
    db.run(
      `UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE branch_id = ? AND id = ?`,
      [...columns.map((column) => normalizeValue(before[column])), BRANCH, rowId],
    );
  }
}

/** 某行在 journal 里的日志条数（按 (table,rowId) 统计），用于断言「编译没有给它加日志」。 */
function journalCount(db, table, rowId) {
  const rows = db.exec(`SELECT COUNT(*) FROM turn_changes WHERE turn_id = '${TURN}' AND target_table = '${table}' AND target_row_id = '${rowId}'`)[0]?.values ?? [];
  return Number(rows[0]?.[0] ?? 0);
}

/** 业务表快照（JSON 稳定序），用于比对「回放后是否恢复原值」。 */
function snapshot(db) {
  const read = (table) => (db.exec(`SELECT * FROM ${table} WHERE branch_id = '${BRANCH}'`) ?? [])
    .flatMap((result) => result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index]]))))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return JSON.stringify({ locations: read('locations'), maps: read('maps') });
}

test('P03 精确跨图保护：parent 更新、旧 map/xy/完整 polygon 保留、写 COORD_FRAME_MIGRATION_BLOCKED、不降级为 layout', async () => {
  const db = await fixture();
  const before = snapshot(db);
  applyParentChange(db, PB);

  const group = compile(db);
  assert.ok(group, '应有可回执的编译结果');
  assertBlockedMentions(group, SUBJECT);
  assert.equal(mutationsOf(group, SUBJECT).length, 0, '无 transform 时绝不许搬动已确认地点');
  assert.equal(mutationsOf(group, NEIGHBOUR).length, 0, '无关邻居一个字都不许改');

  // 被阻塞的行必须一个字都没改：编译前只有「父地点变更」那一条日志，
  // 编译回执不得再给 SUBJECT 添任何日志行。
  const journalBeforeCompile = journalCount(db, 'locations', SUBJECT);
  const applied = applyGroups(db, [group], { branchId: BRANCH, turnId: TURN, attemptId: 'p03', validate: true });
  assert.deepEqual(applied.journalIssues, []);
  assert.ok(!applied.groups.some((item) => item.status === 'rejected' || item.status === 'blocked'), `坐标阻塞不能让整块布局被拒绝：${JSON.stringify(applied.groups)}`);
  assert.equal(journalCount(db, 'locations', SUBJECT), journalBeforeCompile, '被阻塞的行不该被编译再写一条日志（它一个字都没改）');

  const after = selectOne(db, 'locations', BRANCH, SUBJECT);
  assert.equal(after.parent_location_id, PB, '导航 parent 必须已更新');
  assert.equal(after.map_id, MAP_A, '旧 map_id 必须保留');
  assert.equal(after.grid_x, 3);
  assert.equal(after.grid_y, 4);
  assert.equal(after.coord_precision, 'exact', '绝不降级为 layout');
  assert.equal(after.area_geometry_json !== null, true, '确认范围不能被清空');
  const area = JSON.parse(String(after.area_geometry_json));
  assert.equal(area.quality, 'confirmed');
  assert.deepEqual(area.points, POLYGON.points, '完整 polygon 必须逐点保留（不能只看一个中心点）');

  const neighbour = selectOne(db, 'locations', BRANCH, NEIGHBOUR);
  assert.equal(neighbour.map_id, MAP_A);
  assert.equal(neighbour.grid_x, 22);
  assert.equal(neighbour.grid_y, 22);
  assert.deepEqual(JSON.parse(String(neighbour.area_geometry_json)).points, NEIGHBOUR_POLYGON.points, '无关 L2 几何完全不变');

  // 删掉这一楼：journal 回放后业务值必须逐行恢复。
  revertTurn(db);
  assert.equal(snapshot(db), before, '回放 journal 后所有业务值必须恢复原状');
});

test('P04 估计跨图与成员清理：只去掉 A 的 L1 锚点、L2 几何不变、B 有唯一 L1 示意入口', async () => {
  const db = await fixture();
  // 前置状态：把 SUBJECT 落成「未锁定 layout 点、无确认范围」。这条裸 UPDATE 不进 journal，
  // 所以「回放 journal 后恢复原状」的基准必须取在它之后，否则等于拿不可回放的状态当期望值。
  db.run(`UPDATE locations SET coord_precision = 'layout', area_geometry_json = NULL WHERE branch_id = '${BRANCH}' AND id = '${SUBJECT}'`);
  const before = snapshot(db);
  applyParentChange(db, PB);

  const group = compile(db);
  assert.ok(group, '应有可回执的编译结果');
  const moved = mutationsOf(group, SUBJECT);
  assert.equal(moved.length, 1, `layout 点必须移到新图：${JSON.stringify((group?.mutations ?? []).map((m) => m.rowId))}`);
  assert.equal(moved[0].after.map_id, MAP_B, '要落到新父图 B');
  assert.equal(moved[0].after.coord_precision, 'layout');
  assert.ok(Number.isFinite(Number(moved[0].after.grid_x)) && Number.isFinite(Number(moved[0].after.grid_y)), '不得写 NaN');
  assert.ok(moved[0].after.grid_x >= 0 && moved[0].after.grid_x <= FRAME_CELLS && moved[0].after.grid_y >= 0 && moved[0].after.grid_y <= FRAME_CELLS, '必须落在 B 的幅面内');
  assert.equal(moved[0].after.area_geometry_json, null, 'layout 点没有确认范围，跨图后不得留旧图的范围');
  assert.equal(mutationsOf(group, NEIGHBOUR).length, 0, 'L2 完全不变');

  const applied = applyGroups(db, [group], { branchId: BRANCH, turnId: TURN, attemptId: 'p04', validate: true });
  assert.deepEqual(applied.journalIssues, []);
  assert.ok(!applied.groups.some((item) => item.status === 'rejected' || item.status === 'blocked'), JSON.stringify(applied.groups));

  const onA = db.exec(`SELECT id FROM locations WHERE branch_id = '${BRANCH}' AND map_id = '${MAP_A}' AND id = '${SUBJECT}'`)[0]?.values ?? [];
  assert.equal(onA.length, 0, 'A 图里的 L1 锚点必须被去掉');
  const onB = db.exec(`SELECT id FROM locations WHERE branch_id = '${BRANCH}' AND map_id = '${MAP_B}' AND id = '${SUBJECT}'`)[0]?.values ?? [];
  assert.equal(onB.length, 1, 'B 必须有且只有一个 L1 示意入口');

  const neighbour = selectOne(db, 'locations', BRANCH, NEIGHBOUR);
  assert.equal(neighbour.map_id, MAP_A, 'L2 仍在 A');
  assert.equal(neighbour.grid_x, 22);
  assert.equal(neighbour.grid_y, 22);
  assert.deepEqual(JSON.parse(String(neighbour.area_geometry_json)).points, NEIGHBOUR_POLYGON.points, 'L2 geometry 逐点不变');

  revertTurn(db);
  assert.equal(snapshot(db), before, '回放 journal 后 L1 回到 A、L2 与两张图恢复原状');
});

test('P04b 同场景重复编译幂等：第二次编译对同一批地点零变更', async () => {
  const db = await fixture();
  db.run(`UPDATE locations SET coord_precision = 'layout', area_geometry_json = NULL WHERE branch_id = '${BRANCH}' AND id = '${SUBJECT}'`);
  applyParentChange(db, PB);

  const first = compile(db);
  const applied = applyGroups(db, [first], { branchId: BRANCH, turnId: TURN, attemptId: 'p04b-1', validate: true });
  assert.ok(!applied.groups.some((item) => item.status === 'rejected' || item.status === 'blocked'), JSON.stringify(applied.groups));
  const placed = selectOne(db, 'locations', BRANCH, SUBJECT);
  assert.equal(placed.map_id, MAP_B);
  assert.equal(placed.coord_precision, 'layout');

  const second = compile(db);
  assert.equal(mutationsOf(second, SUBJECT).length, 0, `第二次编译不得再动同一地点：${JSON.stringify((second?.mutations ?? []).map((m) => m.rowId))}`);
  assert.equal(mutationsOf(second, NEIGHBOUR).length, 0);

  const third = compile(db);
  const settled = selectOne(db, 'locations', BRANCH, SUBJECT);
  assert.equal(settled.map_id, MAP_B);
  assert.equal(settled.grid_x, placed.grid_x, '重复编译不能让已排好的点抖动');
  assert.equal(settled.grid_y, placed.grid_y);
  assert.equal((third?.mutations ?? []).filter((m) => m.rowId === SUBJECT).length, 0);
});

test('M2-12 只剪已移走的局部锚点：搬走的房间+悬空家具组被剪，邻居、静态背景与在场角色一律不动', () => {
  const maps = [
    { id: 'MAP_ROOT', status: 'active', container_location_id: null },
    { id: MAP_A, status: 'active', container_location_id: PA },
    { id: MAP_B, status: 'active', container_location_id: PB },
  ];
  const locations = [
    { id: PA, status: 'active', parent_location_id: null, map_id: 'MAP_ROOT' },
    { id: PB, status: 'active', parent_location_id: null, map_id: 'MAP_ROOT' },
    // 已搬到 B：parent 与 map_id 都不再指向 A。
    { id: SUBJECT, status: 'active', parent_location_id: PB, map_id: MAP_B },
    { id: NEIGHBOUR, status: 'active', parent_location_id: PA, map_id: MAP_A },
  ];
  const characters = [
    { id: 'C_STAY', status: 'active', map_id: MAP_A, location_id: NEIGHBOUR },
    { id: 'C_GONE', status: 'active', map_id: MAP_B, location_id: SUBJECT },
  ];
  const items = [
    { id: 'I_GROUND', status: 'active', map_id: MAP_A, location_id: NEIGHBOUR },
    { id: 'I_GONE', status: 'active', map_id: MAP_B, location_id: SUBJECT },
  ];
  // 旧场景：A 图里同时留着已搬走的房间、仍在场的邻居房间，以及一个程序生成的静态装饰房间。
  const scene = {
    layout: { kind: 'floor', rooms: [{ id: SUBJECT }, { id: NEIGHBOUR }, { id: 'room_decor_1' }] },
    constraints: {
      rooms: [{ id: SUBJECT, side: 'north' }, { id: NEIGHBOUR, side: 'south' }, { id: 'room_decor_1', side: 'north' }],
      contents: [{ id: 'grp_subject', roomId: SUBJECT }, { id: 'grp_neighbour', roomId: NEIGHBOUR }],
      actors: [{ id: 'C_STAY', roomId: NEIGHBOUR }, { id: 'C_GONE', roomId: SUBJECT }],
      items: [{ id: 'I_GROUND', on: 'grp_neighbour' }, { id: 'I_GONE', on: 'grp_subject' }],
    },
  };

  const memberIds = collectSceneMemberIds({ mapId: MAP_A, maps, locations, characters, items });
  const result = pruneInvalidSceneMembers({ scene, mapId: MAP_A, memberIds });

  assert.deepEqual(result.deletes.rooms, [SUBJECT], '只剪已搬走的房间');
  assert.deepEqual(result.deletes.contents, ['grp_subject'], '房间没了，挂在它下面的家具组变成悬空引用，一并剪');
  assert.deepEqual(result.deletes.actors, ['C_GONE'], '离场角色只撤它自己的 marker');
  assert.deepEqual(result.deletes.items, ['I_GONE'], '离场物品只撤它自己的锚点');
  assert.ok(!result.pruned.includes(NEIGHBOUR), '仍在场的邻居房间一个字都不许动');
  assert.ok(!result.pruned.includes('room_decor_1'), 'id 不在实体表里的静态背景/程序装饰必须保留');
  assert.ok(!result.pruned.includes('C_STAY') && !result.pruned.includes('I_GROUND'), '在场角色/物品不被清空');
  assert.equal(result.issues.length, 1, '剪除必须留下一条可查的诊断');
  assert.equal(result.issues[0].code, 'SCENE_STALE_MEMBER_PRUNED');
  assert.ok(result.issues[0].message.includes(SUBJECT), '诊断要能按 ID 定位到被剪的锚点');

  // 只读：函数不许改写入参，旧场景的几何必须原样留着（剪除交给编译器的 deletes 走 journal）。
  assert.equal(scene.constraints.rooms.length, 3);
  assert.deepEqual(scene.layout.rooms.map((r) => r.id), [SUBJECT, NEIGHBOUR, 'room_decor_1']);
});
