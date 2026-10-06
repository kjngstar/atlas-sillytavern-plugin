/**
 * atlas-db-views.test.mjs — T21 地图视图 / 附近 / 详情同 revision（§10.1–10.3）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, insertRows } from './fixtures/atlas-sql/seed.mjs';
import { createTableReadPort } from '../src/atlas-db-readport.ts';
import { queryChanges, queryDiagnostics, queryEntityDetail, queryMapView, queryNearby, querySimulationView } from '../src/atlas-db-views.ts';
import { ensureContainerMap } from '../src/atlas-ops-geography.ts';
import { boundaryContext, makeCompileContext } from './helpers/atlas-compile-context.mjs';

const SQL = await (await import('sql.js')).default();

async function seeded() {
  const seed = await makeSeedWith(SQL);
  const ctx = { db: seed.db, branchId: IDS.branchMain, revision: 0, viewMode: 'author', povId: null };
  return { seed, ctx };
}

test('T21-01 城市图：只知「在学校」的人物进粗定位名单，不叠加人物图标', async () => {
  const { seed, ctx } = await seeded();
  try {
    const result = queryMapView(ctx, { kind: 'map', branchId: IDS.branchMain });
    const world = result.items.find((m) => m.mapId === IDS.M1);
    assert.ok(world, '应有世界图');
    assert.ok(world.coarseList.some((c) => c.entityId === IDS.C1 && c.locationId === IDS.L2));
    assert.equal(world.points.some((p) => p.entityId === IDS.C1), false, '粗定位不画人物点');
    assert.equal(world.points.some((p) => p.entityId === IDS.L2), true, '地点本身是点位');
  } finally {
    seed.close();
  }
});

test('T21-02 教室子图：有精坐标的人物显示为独立点；近似点带范围', async () => {
  const { seed, ctx } = await seeded();
  try {
    seed.db.run(`UPDATE characters SET location_id = 'L3', map_id = 'M2', grid_x = 5, grid_y = 6, coord_precision = 'exact' WHERE branch_id = ? AND id = ?`, [
      IDS.branchMain,
      IDS.C1,
    ]);
    const result = queryMapView(ctx, { kind: 'map', branchId: IDS.branchMain, mapId: IDS.M2 });
    const room = result.items.find((m) => m.mapId === IDS.M2);
    assert.equal(room.containerLocationKind, 'room');
    const withoutPov={...ctx,povId:'unregistered-reader'};
    assert.equal(queryMapView(withoutPov,{kind:'map',branchId:IDS.branchMain,mapId:IDS.M2}).items[0].containerLocationKind,'room');
    assert.equal(queryMapView({...withoutPov,viewMode:'pov'},{kind:'map',branchId:IDS.branchMain,mapId:IDS.M2}).items[0].containerLocationKind,null);
    assert.ok(room.points.some((p) => p.entityId === IDS.C1 && p.markerQuality === 'exact'));
    seed.db.run(`UPDATE characters SET coord_precision = 'approximate', uncertainty_radius_cells = 1.5 WHERE branch_id = ? AND id = ?`, [
      IDS.branchMain,
      IDS.C1,
    ]);
    const again = queryMapView(ctx, { kind: 'map', branchId: IDS.branchMain, mapId: IDS.M2 });
    const point = again.items[0].points.find((p) => p.entityId === IDS.C1);
    assert.equal(point.markerQuality, 'approximate');
    assert.equal(point.radius, 1.5);
  } finally {
    seed.close();
  }
});

test('T21-03 估计路线标 dashed，确认路线不标', async () => {
  const { seed, ctx } = await seeded();
  try {
    const result = queryMapView(ctx, { kind: 'map', branchId: IDS.branchMain, mapId: IDS.M1 });
    const route = result.items[0].routes.find((r) => r.routeId === IDS.R_AB);
    assert.equal(route.geometryQuality, 'estimated');
    assert.equal(route.dashed, true, 'estimated 路线用虚线/估计标识');
    seed.db.run(`UPDATE routes SET geometry_quality = 'confirmed' WHERE branch_id = ? AND id = ?`, [IDS.branchMain, IDS.R_AB]);
    const again = queryMapView(ctx, { kind: 'map', branchId: IDS.branchMain, mapId: IDS.M1 });
    assert.equal(again.items[0].routes.find((r) => r.routeId === IDS.R_AB).dashed, false);
  } finally {
    seed.close();
  }
});

test('T21-04 revision 不一致时返回空视图并标 stale，不退回旧缓存', async () => {
  const { seed, ctx } = await seeded();
  try {
    const stale = queryMapView(ctx, { kind: 'map', branchId: IDS.branchMain, revision: 7 });
    assert.deepEqual(stale.items, []);
    assert.equal(stale.metadata.stale, true);
    assert.equal(stale.metadata.currentRevision, 0);
  } finally {
    seed.close();
  }
});

test('T21-05 空结果返回 []（UI 据此清卡片），且不沿用上次结果', async () => {
  const { seed, ctx } = await seeded();
  try {
    const empty = queryNearby(ctx, { kind: 'nearby', branchId: IDS.branchMain, entityId: 'NOT_EXIST' });
    assert.deepEqual(empty.items, []);
    const one = queryNearby(ctx, { kind: 'nearby', branchId: IDS.branchMain, entityId: IDS.C2 });
    assert.ok(one.items.length >= 1);
    const emptyAgain = queryNearby(ctx, { kind: 'nearby', branchId: IDS.branchMain, entityId: 'NOT_EXIST' });
    assert.deepEqual(emptyAgain.items, [], '第二次空查询也必须为空，不能返回上次结果');
  } finally {
    seed.close();
  }
});

test('T21-06 地点详情聚合子地点/在场/事件/风声，不给二十张裸表', async () => {
  const { seed, ctx } = await seeded();
  try {
    const detail = queryEntityDetail(ctx, { kind: 'entity', branchId: IDS.branchMain, entityId: IDS.L2 });
    assert.equal(detail.items.length, 1);
    const payload = detail.items[0];
    assert.equal(payload.kind, 'location');
    assert.deepEqual(payload.children.map((c) => c.id), [IDS.L3]);
    assert.deepEqual(payload.present.map((c) => c.id), [IDS.C1]);
    assert.ok(Array.isArray(payload.events));
    assert.ok(Array.isArray(payload.fronts));
  } finally {
    seed.close();
  }
});

test('T21-07 人物详情聚合关系/行动/行程/认知与统一位置解析', async () => {
  const { seed, ctx } = await seeded();
  try {
    const detail = queryEntityDetail(ctx, { kind: 'entity', branchId: IDS.branchMain, entityId: IDS.C1 });
    const payload = detail.items[0];
    assert.equal(payload.kind, 'character');
    assert.ok(payload.relations.some((r) => r.object_entity_id === IDS.F1));
    assert.ok(Array.isArray(payload.actions));
    assert.ok(Array.isArray(payload.journeys));
    assert.equal(payload.position.kind, 'at_location');
    assert.equal(payload.position.locationId, IDS.L2);
  } finally {
    seed.close();
  }
});

test('T21-08 三张图使用同一 revision（同一 ViewContext）', async () => {
  const { seed, ctx } = await seeded();
  try {
    const map = queryMapView(ctx, { kind: 'map', branchId: IDS.branchMain });
    const nearby = queryNearby(ctx, { kind: 'nearby', branchId: IDS.branchMain, entityId: IDS.C2 });
    const detail = queryEntityDetail(ctx, { kind: 'entity', branchId: IDS.branchMain, entityId: IDS.C1 });
    assert.equal(map.revision, nearby.revision);
    assert.equal(nearby.revision, detail.revision);
    assert.equal(map.branchId, IDS.branchMain);
  } finally {
    seed.close();
  }
});

test('T21-09 子图创建幂等：同容器只一张 active 地图，且查询不写库', async () => {
  const { seed } = await seeded();
  try {
    const tables = createTableReadPort(seed.db);
    const compileCtx = makeCompileContext({ seed, tables, phase: 'geography' });
    const before = seed.db.exec(`SELECT COUNT(*) FROM maps WHERE branch_id = '${IDS.branchMain}'`)[0].values[0][0];
    const first = ensureContainerMap(IDS.L1, compileCtx);
    assert.equal(first.created, true, '世界图不是容器图，应为城市新建一张内部图');
    insertRows(seed.db, 'maps', first.mutations.map((m) => m.after));
    const second = ensureContainerMap(IDS.L1, compileCtx);
    assert.equal(second.created, false, '已存在则复用');
    assert.equal(second.mapId, first.mapId);
    // 教室已有容器图 M2：直接复用，不新建
    const room = ensureContainerMap(IDS.L3, compileCtx);
    assert.equal(room.created, false);
    assert.equal(room.mapId, IDS.M2);
    const after = seed.db.exec(`SELECT COUNT(*) FROM maps WHERE branch_id = '${IDS.branchMain}'`)[0].values[0][0];
    assert.equal(Number(after), Number(before) + 1, '只新增一张');
    void boundaryContext;
  } finally {
    seed.close();
  }
});

test('T21-10 动向页：turn_changes 摘要可见，不只是「应用了 N 行」', async () => {
  const { seed, ctx } = await seeded();
  try {
    seed.db.run(
      `INSERT INTO turn_changes (id, turn_id, sequence, attempt_id, group_id, operation_id, target_table, target_row_id, operation, before_json, after_json, basis_json, summary)
       VALUES ('CH1', ?, 1, 'att', 'G1', 'OP1', 'characters', ?, 'update', ?, ?, ?, ?)`,
      [
        IDS.seedTurn,
        IDS.C1,
        JSON.stringify({ id: IDS.C1, thought: '' }),
        JSON.stringify({ id: IDS.C1, thought: '新的想法' }),
        JSON.stringify({ kind: 'story', reason: '正文观察' }),
        '修改characters「艾琳」：thought',
      ],
    );
    const changes = queryChanges(ctx, { kind: 'changes', branchId: IDS.branchMain });
    assert.equal(changes.items.length, 1);
    assert.equal(changes.items[0].table, 'characters');
    assert.ok(changes.items[0].summary.includes('艾琳'), '动向要显示可读摘要');
    assert.equal(changes.items[0].basis.reason, '正文观察');
  } finally {
    seed.close();
  }
});

test('T21-11 诊断页：分页游标给出完整导出语义（droppedCount=0，exportComplete）', async () => {
  const { seed, ctx } = await seeded();
  try {
    for (let i = 0; i < 150; i += 1) {
      // 唯一键 (turn_id, group_id, target_table, target_row_id)：每行必须是不同的因果组/行。
      seed.db.run(
        `INSERT INTO turn_changes (id, turn_id, sequence, attempt_id, group_id, operation_id, target_table, target_row_id, operation, basis_json, summary)
         VALUES (?, ?, ?, 'att', ?, ?, 'characters', ?, 'update', '{}', ?)`,
        [`CH${i}`, IDS.seedTurn, i + 1, `G${i}`, `OP${i}`, `ROW${i}`, `变更 ${i}`],
      );
    }
    const page1 = queryDiagnostics(ctx, { kind: 'diagnostics', branchId: IDS.branchMain, limit: 100 });
    assert.equal(page1.items.filter((i) => i.kind === 'change').length, 100);
    assert.equal(page1.metadata.totalCount, 150);
    assert.ok(page1.nextCursor);
    const page2 = queryDiagnostics(ctx, { kind: 'diagnostics', branchId: IDS.branchMain, limit: 100, cursor: page1.nextCursor });
    assert.equal(page2.items.filter((i) => i.kind === 'change').length, 50);
    assert.equal(page2.nextCursor, undefined);
    assert.equal(page1.metadata.exportComplete, true, '分页不截断导出');
    assert.equal(page1.metadata.droppedCount, 0);
  } finally {
    seed.close();
  }
});

test('T21-12 推进页：simulation 视图在 cursor < clock 时给出未结算提示', async () => {
  const { seed, ctx } = await seeded();
  try {
    seed.db.run(`UPDATE branches SET clock_s = 600, clock_min_s = 600, clock_max_s = 600, simulation_cursor_s = 120 WHERE id = ?`, [IDS.branchMain]);
    const view = querySimulationView(ctx, { kind: 'simulation', branchId: IDS.branchMain });
    assert.equal(view.items[0].pendingNotice !== null, true);
    assert.ok(String(view.items[0].pendingNotice).includes('后台尚在结算'));
    seed.db.run(`UPDATE branches SET simulation_cursor_s = 600 WHERE id = ?`, [IDS.branchMain]);
    const current = querySimulationView(ctx, { kind: 'simulation', branchId: IDS.branchMain });
    assert.equal(current.items[0].pendingNotice, null);
    assert.equal(current.metadata.pending, false);
  } finally {
    seed.close();
  }
});
