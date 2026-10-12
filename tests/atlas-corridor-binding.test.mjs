/**
 * atlas-corridor-binding.test.mjs — P11/R03 §18：命名走廊只表达一次（COR01–COR06）。
 *
 * 纪律：全部走**真实链路**（parseOperations → compileOperations → compileSceneGroup →
 * generateFloor / layout-core / foundation / sceneLocationGeometry / filterSceneForView /
 * UI referenceGeometry），不 mock 几何、不自己造 context，也不断言常量存在。
 *
 * 覆盖：
 *   COR01 一个真实走廊 + 四间房：五个地点各只表达一次，没有第六个「匿名真实走廊」。
 *   COR02 沿入口/门拓扑可达四房：真实图连通 + 真实行走路径，不是只数 doors.length。
 *   COR03 走廊人物/陈设/名称/子图入口引用同一地点；点击进入其已有子图。
 *   COR04 没有命名走廊的旧场景仍可读可画；辅助 corridor 不成为 SQL 地点。
 *   COR05 绑定目标在旧 rooms 中时不会被增量合并再加回来；null 解除绑定有效。
 *   COR06 锁冲突保存旧 scene/地点坐标；隐藏走廊不泄漏实体 ID、名称、门端点或陈设。
 *   另含：编译器把 corridorLocationRef 当真实地点引用（别名解析/依赖/父图校验/模板归属）。
 *
 * 边界：不调用外网；数据只存在于内存。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as Kit from '../vendor/atlas-spatial/index.mjs';
import { referenceGeometry } from '../ui/atlas-reference-data.mjs';
import { projectReferenceData } from '../ui/atlas-reference-data.mjs';
import { makeSeedWith, IDS } from './fixtures/atlas-sql/seed.mjs';
import { SOURCE_SNAPSHOT } from './fixtures/atlas-sql/model-cases.mjs';
import { parseOperations } from '../src/atlas-ops-parser.ts';
import { compileOperations } from '../src/atlas-ops-compile.ts';
import { makeAnchor } from './helpers/atlas-compile-context.mjs';
import { createTableReadPort } from '../src/atlas-db-readport.ts';

const SQL = await (await import('sql.js')).default();

const BRANCH = 'b1';
const SCOPE = { chatId: 'chat-corr', branchId: BRANCH, revision: 5, viewMode: 'author' };
const MAP_ID = 'M_HALL';
const SUB_MAP = 'M_HALL_DEEP';
const SITE = 'L_SITE';
const CORR = 'L_CORR'; // 真实走廊：本图的通行空间
const R_N1 = 'L_RN1';
const R_N2 = 'L_RN2';
const R_S1 = 'L_RS1';
const R_S2 = 'L_RS2';
const C_N = 'C_N';
const C_S = 'C_S';
const C_HALL = 'C_HALL';
const CORR_NAME = '中央走廊';

const EPS = 1e-6;
const RECT_KEYS = ['x', 'y', 'w', 'h'];
const insideRect = (outer, inner) =>
  inner.x >= outer.x - EPS && inner.y >= outer.y - EPS
  && inner.x + inner.w <= outer.x + outer.w + EPS && inner.y + inner.h <= outer.y + outer.h + EPS;
const overlaps = (a, b) =>
  a.x < b.x + b.w - EPS && a.x + a.w > b.x + EPS && a.y < b.y + b.h - EPS && a.y + a.h > b.y + EPS;

// ───────────────────────────── 夹具 ─────────────────────────────

function loc(id, over = {}) {
  return {
    branch_id: BRANCH, id, name: id, status: 'active', kind: 'room',
    parent_location_id: SITE, map_id: MAP_ID, grid_x: null, grid_y: null,
    coord_precision: 'unknown', area_geometry_json: null, ...over,
  };
}
function chr(id, locationId, over = {}) {
  return {
    branch_id: BRANCH, id, name: id, status: 'active', location_id: locationId,
    map_id: null, grid_x: null, grid_y: null, coord_precision: 'unknown', ...over,
  };
}

const locations = (over = {}) => [
  loc(SITE, { kind: 'site', parent_location_id: null, map_id: null }),
  loc(CORR, { name: CORR_NAME }),
  loc(R_N1), loc(R_N2), loc(R_S1), loc(R_S2),
  ...(over.extra ?? []),
];
const characters = () => [chr(C_N, R_N1), chr(C_S, R_S1), chr(C_HALL, CORR)];

function mapRow(over = {}) {
  return {
    branch_id: BRANCH, id: MAP_ID, name: '白桦附楼', container_location_id: SITE,
    frame_json: { cols: 24, rows: 20 }, meters_per_cell: 1,
    scale_quality: 'exact', scale_locked: 0, row_rev: 3, ...over,
  };
}

function context(extra = {}) {
  const built = Kit.buildLayoutContext({
    scope: SCOPE, mapRow: mapRow(), locations: locations(extra.locationOver ?? {}),
    characters: characters(), items: [], routes: [], ...extra.contextOver,
  });
  assert.equal(built.ok, true, JSON.stringify(built.issues));
  return built.context;
}

/** 真实 buildLayoutContext → generateFloor（不走 compileSceneGroup，聚焦生成器契约）。 */
const generate = (spec, ctx, previousScene = null) =>
  Kit.generateFloor(spec, { ...ctx, previousScene });

/** 一个真实走廊 + 四间房；走廊里有陈设与一个人。 */
function boundSpec(over = {}) {
  return {
    corridorWidth: 3,
    corridorLocationRef: CORR,
    rooms: [
      { id: R_N1, name: '北一', side: 'north', w: 6, h: 5 },
      { id: R_N2, name: '北二', side: 'north', w: 6, h: 5 },
      { id: R_S1, name: '南一', side: 'south', w: 6, h: 5 },
      { id: R_S2, name: '南二', side: 'south', w: 6, h: 5 },
    ],
    contents: [
      { id: 'F_CAB', roomId: CORR, type: 'cabinet', w: 1.2, h: 0.6 },
      { id: 'F_DESK', roomId: R_N1, type: 'desk', w: 2, h: 1 },
    ],
    actors: [
      { id: C_HALL, roomId: CORR },
      { id: C_N, roomId: R_N1, near: 'F_DESK' },
      { id: C_S, roomId: R_S1 },
    ],
    items: [],
    ...over,
  };
}

/** 无命名走廊的对照 spec：走廊只是程序辅助通道。 */
function anonymousSpec(over = {}) {
  const spec = boundSpec(over);
  delete spec.corridorLocationRef;
  spec.contents = spec.contents.filter((f) => f.roomId !== CORR);
  spec.actors = spec.actors.filter((a) => a.roomId !== CORR);
  return spec;
}

const compile = (spec, ctx = context(), previousScene = null, over = {}) =>
  Kit.compileSceneGroup({
    request: { kind: 'floor', spec },
    scope: SCOPE, currentScope: over.currentScope ?? SCOPE, mapRow: mapRow(),
    locations: locations(over.locationOver ?? {}), characters: characters(), items: [], routes: [],
    turnId: 'T-CORR', operationId: 'OP-CORR', ...over.groupOver,
  });

// ───────────────────────── COR01 · 五个地点各只表达一次 ─────────────────────────

test('COR01：一个真实走廊 + 四间房 → 五个地点各只表达一次，没有第六个匿名真实走廊', () => {
  const result = generate(boundSpec(), context());
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.status, 'generated', `干净的绑定请求不该有告警：${JSON.stringify(result.issues)}`);
  const scene = result.scene;
  assert.deepEqual(Kit.checkSceneDocument(scene), []);

  // 1) 四间房 + 一条走廊，走廊地点绝不出现在 rooms 里（同一实体只表达一次）。
  assert.equal(scene.layout.rooms.length, 4, JSON.stringify(scene.layout.rooms));
  assert.ok(!scene.layout.rooms.some((r) => r.id === CORR), '绑定的走廊地点不得再作为普通房间排布');
  assert.equal(scene.layout.corridor.id, 'corridor', '程序几何 ID 保持 corridor，不破坏旧路径拓扑');
  assert.equal(scene.layout.corridor.entityId, CORR);
  assert.equal(scene.layout.corridor.name, CORR_NAME, '走廊名称来自真实地点行，不是模型编的');

  // 2) 场景 → SQL 几何映射：正好五个真实地点，且没有多余的「corridor」伪实体。
  const mapped = Kit.sceneLocationGeometry(scene);
  const ids = mapped.map((g) => g.entityId);
  assert.equal(ids.length, 5, JSON.stringify(ids));
  assert.deepEqual([...ids].sort(), [CORR, R_N1, R_N2, R_S1, R_S2].sort());
  assert.ok(!ids.includes('corridor'), '几何伪 ID 绝不能当地点回写');
  assert.equal(new Set(ids).size, 5, '五个地点各只表达一次');
  for (const g of mapped) {
    assert.ok(Number.isFinite(g.gridX) && Number.isFinite(g.gridY), `地点 ${g.entityId} 必须有有限坐标`);
    assert.equal(g.precision, 'layout');
  }
  // 3) 走廊几何就是程序算的那条带：横贯整幅、居中。
  const c = scene.layout.corridor;
  assert.deepEqual([c.x, c.w, c.h], [0, 24, 3]);
  assert.ok(Math.abs(c.y + c.h / 2 - 10) < EPS, '走廊必须居中');
});

// ───────────────────────── COR02 · 沿门拓扑可达四房 ─────────────────────────

test('COR02：沿入口/门拓扑真实可达四房（图连通 + 真实行走路径，不只数 doors）', () => {
  const scene = generate(boundSpec(), context()).scene;
  const layout = scene.layout;
  const corridor = layout.corridor;
  const rooms = new Map(layout.rooms.map((r) => [r.id, r]));

  // 1) 每个房间都有门，门开在走廊的边界上且落在这条走廊的跨度内。
  assert.equal(layout.doors.length, 4);
  for (const door of layout.doors) {
    const room = rooms.get(door.roomId);
    assert.ok(room, `门 ${door.id} 的房间不存在`);
    const boundary = room.side === 'north' ? corridor.y : corridor.y + corridor.h;
    assert.ok(Math.abs(door.y - boundary) < EPS, `门 ${door.id} 不在走廊边界上`);
    assert.ok(door.x >= corridor.x - EPS && door.x <= corridor.x + corridor.w + EPS, `门 ${door.id} 不在走廊跨度内`);
  }

  // 2) 房间绝不与走廊重叠（走廊是真空出来的通道，不是被房间压出来的缝）。
  for (const room of layout.rooms) assert.ok(!overlaps(room, corridor), `房间 ${room.id} 与走廊重叠`);

  // 3) 真实图连通：只沿「房间—门—走廊—门—房间」这一种拓扑做 BFS，四间房从入口都到得了。
  const graph = new Map([['corridor', new Set()]]);
  for (const room of layout.rooms) graph.set(room.id, new Set());
  for (const edge of layout.edges) {
    assert.equal(edge.to, 'corridor', '几何端点仍是程序走廊');
    assert.equal(edge.toEntityId, CORR, '语义端点解析为真实走廊地点');
    graph.get(edge.from).add('corridor');
    graph.get('corridor').add(edge.from);
  }
  const seen = new Set(['corridor']);
  const queue = ['corridor'];
  while (queue.length) {
    const node = queue.shift();
    for (const next of graph.get(node) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
  assert.deepEqual([...seen].sort(), ['corridor', R_N1, R_N2, R_S1, R_S2].sort(), '四房加走廊必须连通');

  // 4) 真实行走路径：北一 → 南一 的路径必须穿过走廊净空带（不是两段断线的房间内点集）。
  assert.ok(layout.path.length >= 4, `需要一条真实路径：${JSON.stringify(layout.path)}`);
  const cy = corridor.y + corridor.h / 2;
  assert.ok(
    layout.path.some((p) => Math.abs(p.y - cy) < EPS && p.x >= corridor.x - EPS && p.x <= corridor.x + corridor.w + EPS),
    `路径必须走走廊中间：${JSON.stringify(layout.path)}`,
  );
  for (const p of layout.path) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

// ───────────────────────── COR03 · 同一地点身份 ─────────────────────────

test('COR03：走廊人物、陈设、名称、子图入口引用同一地点；点击进入其已有子图', () => {
  const scene = generate(boundSpec(), context()).scene;
  const corridor = scene.layout.corridor;

  // 1) 走廊陈设落在走廊内、且绝不占用中央通行净空。
  const cab = scene.layout.groups.find((g) => g.id === 'F_CAB');
  assert.ok(cab, JSON.stringify(scene.layout.groups.map((g) => g.id)));
  assert.equal(cab.roomId, CORR);
  assert.ok(insideRect(corridor, cab), '走廊陈设必须完全在走廊内');
  assert.ok(cab.interaction, '走廊陈设必须有可点交互点');
  assert.ok(insideRect(corridor, { x: cab.interaction.x, y: cab.interaction.y, w: 0, h: 0 }));
  const passage = { x: corridor.x, y: corridor.y + 1.0, w: corridor.w, h: 1.0 };
  assert.ok(!overlaps(cab, passage), '中央通行净空不得被陈设占用');

  // 2) 走廊人物站在净空带上、roomId 与陈设相同、精度只能是 layout。
  const hall = scene.layout.actors.find((a) => a.id === C_HALL);
  assert.ok(hall, JSON.stringify(scene.layout.actors.map((a) => a.id)));
  assert.equal(hall.roomId, CORR);
  assert.equal(hall.quality, 'layout');
  assert.ok(
    Math.abs(hall.y - (corridor.y + corridor.h / 2)) < EPS,
    '走廊人物站在净空带上',
  );
  assert.ok(!scene.layout.groups.some((g) => overlaps(g, { x: hall.x - 0.18, y: hall.y - 0.18, w: 0.36, h: 0.36 })), '人物不站在陈设里');

  // 3) UI：走廊与房间共用同一 locationId，可点击进入该地点已有子图。
  const map = {
    mapId: MAP_ID, name: '白桦附楼', kind: 'interior', containerLocationId: SITE,
    containerLocationKind: 'building', metersPerCell: 1, points: [],
    frames: { frame: { cols: 24, rows: 20, reference_width_cells: 24, reference_height_cells: 20 } },
  };
  const geometry = referenceGeometry(map, scene, { viewMode: 'author' });
  assert.equal(geometry.kind, 'floor');
  assert.equal(geometry.geo.corridor.entityId, CORR, 'UI 走廊几何必须带真实地点身份');
  assert.equal(geometry.geo.corridor.name, CORR_NAME);
  const mark = geometry.marks.find((m) => m.id === CORR);
  assert.ok(mark, `走廊必须产生可点击标点：${JSON.stringify(geometry.marks.map((m) => m.id))}`);
  assert.equal(mark.type, 'poi');
  assert.equal(mark.silent, true, '走廊与房间一样安静显示，不另外画一个 POI 图标');
  assert.equal(mark.locationId, null);

  // 4) 真实导航投影：点它进的是这个地点**已有的**子图，不是新造的图。
  const projected = projectReferenceData({
    state: {},
    mapView: {
      branchId: BRANCH, revision: SCOPE.revision,
      items: [map, { mapId: SUB_MAP, name: '走廊内廊', containerLocationId: CORR, metersPerCell: 1, points: [] }],
    },
    sceneView: { items: [{ mapId: MAP_ID, scene }] },
    catalogView: {
      items: [
        { entityId: CORR, entityKind: 'location', locationKind: 'room', name: CORR_NAME, mapId: MAP_ID, summary: '' },
        { entityId: R_N1, entityKind: 'location', locationKind: 'room', name: '北一', mapId: MAP_ID, summary: '' },
      ],
    },
    viewMode: 'author',
  });
  const node = projected.ROOT.children?.find((n) => n.id === MAP_ID) ?? projected.ROOT;
  const projectedMark = node.marks.find((m) => m.id === CORR);
  assert.ok(projectedMark, `导航投影里必须有走廊标点：${JSON.stringify(node.marks.map((m) => m.id))}`);
  assert.deepEqual(projectedMark.node, { id: SUB_MAP, known: true }, '点击走廊标点进入它已有的子图');
});

// ───────────────────────── COR04 · 旧场景仍可读可画 ─────────────────────────

test('COR04：没有命名走廊的旧场景仍可读可画；辅助 corridor 不成为 SQL 地点', () => {
  const result = compile(anonymousSpec());
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.status, 'prepared');
  const scene = result.scene;
  assert.deepEqual(Kit.checkSceneDocument(scene), []);

  // 辅助通道没有实体身份，只有一个程序 ID。
  assert.equal(scene.layout.corridor.id, 'corridor');
  assert.equal(scene.layout.corridor.entityId, undefined);
  assert.equal(scene.layout.corridor.name, undefined);
  assert.equal(scene.layout.edges.every((e) => e.toEntityId === undefined), true);

  // 只回写四间真实房间，绝不冒出 'corridor' 这个伪地点，也不新建任何地点行。
  const mapped = Kit.sceneLocationGeometry(scene);
  assert.deepEqual(mapped.map((g) => g.entityId).sort(), [R_N1, R_N2, R_S1, R_S2].sort());
  const tables = [...new Set(result.group.mutations.map((m) => m.table))];
  assert.deepEqual(tables.sort(), ['locations', 'maps']);
  const locationMutations = result.group.mutations.filter((m) => m.table === 'locations');
  assert.deepEqual(locationMutations.map((m) => m.rowId).sort(), [R_N1, R_N2, R_S1, R_S2].sort());
  assert.ok(!result.group.mutations.some((m) => m.rowId === 'corridor'), '辅助通道不是地点');

  // 旧场景（无 corridorLocationRef 约束）重开仍然可读，且不因缺字段判为 legacy。
  const legacy = Kit.clone(scene);
  assert.ok(legacy.constraints !== undefined);
  const reopened = Kit.readSceneFrame(JSON.stringify({ atlasScene: legacy }), { branchId: BRANCH, mapId: MAP_ID });
  assert.equal(reopened.ok, true, JSON.stringify(reopened.issues));
  const again = generate(anonymousSpec(), context(), reopened.scene);
  assert.equal(again.ok, true, JSON.stringify(again.issues));
  assert.equal(again.status, 'reused', '同一请求重跑必须复用已保存场景');
  assert.equal(again.scene.layout.corridor.entityId, undefined);

  // UI 仍然画得出来（辅助通道有合法矩形，只是没有身份）。
  const map = { mapId: MAP_ID, name: '白桦附楼', kind: 'interior', containerLocationId: SITE, metersPerCell: 1, points: [] };
  const geometry = referenceGeometry(map, scene, { viewMode: 'author' });
  assert.ok(RECT_KEYS.every((k) => Number.isFinite(geometry.geo.corridor[k])));
  assert.equal(geometry.geo.corridor.entityId, null);
  assert.ok(!geometry.marks.some((m) => m.id === 'corridor'), '辅助通道不可点击，也不冒充实体');
});

// ───────────────────────── COR05 · 增量合并与解除绑定 ─────────────────────────

test('COR05：绑定目标在旧 rooms 中时不会被增量合并再加回来；null 解除绑定有效', () => {
  // 先做一版「走廊还是普通房间」的旧场景：它的 constraints.rooms 里就有 CORR。
  const older = generate(
    {
      corridorWidth: 3,
      rooms: [
        { id: R_N1, name: '北一', side: 'north', w: 6, h: 5 },
        { id: R_N2, name: '北二', side: 'north', w: 6, h: 5 },
        { id: CORR, name: CORR_NAME, side: 'north', w: 5, h: 5 },
        { id: R_S1, name: '南一', side: 'south', w: 6, h: 5 },
        { id: R_S2, name: '南二', side: 'south', w: 6, h: 5 },
      ],
      contents: [], actors: [], items: [],
    },
    context(),
  );
  assert.equal(older.ok, true, JSON.stringify(older.issues));
  assert.equal(older.scene.constraints.rooms.length, 5);
  assert.ok(older.scene.constraints.rooms.some((r) => r.id === CORR), '前置条件：旧约束里走廊是普通房间');

  // 1) 现在把它绑成命名走廊：旧 rooms 里的条目必须被移除，且不会再被合并加回来。
  const bound = generate(boundSpec(), context(), older.scene);
  assert.ok(bound.ok, JSON.stringify(bound.issues));
  const dedupe = bound.issues.find((i) => i.code === 'CORRIDOR_ROOM_DEDUPED');
  assert.ok(dedupe, JSON.stringify(bound.issues));
  assert.equal(dedupe.entityId, CORR);
  assert.equal(dedupe.severity, 'warning');
  assert.equal(bound.status, 'partial');
  assert.equal(bound.scene.layout.rooms.length, 4, JSON.stringify(bound.scene.layout.rooms.map((r) => r.id)));
  assert.ok(!bound.scene.layout.rooms.some((r) => r.id === CORR));
  assert.equal(bound.scene.layout.corridor.entityId, CORR);
  assert.ok(!bound.scene.constraints.rooms.some((r) => r.id === CORR), '保存的约束里也不能再有它');
  assert.equal(bound.scene.constraints.corridorLocationRef, CORR, '绑定必须随场景落盘，供下一轮「省略=保持」');
  const mapped = Kit.sceneLocationGeometry(bound.scene).map((g) => g.entityId);
  assert.equal(new Set(mapped).size, 5, '五个地点各只表达一次');

  // 2) 再跑一轮（省略 corridorLocationRef）→ 保持绑定，且不自增出第六个地点。
  const kept = generate(anonymousSpec({ corridorLocationRef: undefined }), context(), bound.scene);
  assert.ok(kept.ok, JSON.stringify(kept.issues));
  assert.equal(kept.scene.layout.corridor.entityId, CORR, '省略=保持既有绑定');
  assert.equal(Kit.sceneLocationGeometry(kept.scene).length, 5);

  // 3) null 显式解除：该地点回到普通房间，走廊恢复匿名辅助通道。
  const unbound = compile(
    {
      corridorWidth: 3,
      corridorLocationRef: null,
      rooms: [
        { id: R_N1, name: '北一', side: 'north', w: 6, h: 5 },
        { id: R_N2, name: '北二', side: 'north', w: 6, h: 5 },
        { id: CORR, name: CORR_NAME, side: 'north', w: 5, h: 5 },
        { id: R_S1, name: '南一', side: 'south', w: 6, h: 5 },
        { id: R_S2, name: '南二', side: 'south', w: 6, h: 5 },
      ],
      contents: [], actors: [], items: [],
    },
    context(), bound.scene,
  );
  assert.equal(unbound.ok, true, JSON.stringify(unbound.issues));
  assert.equal(unbound.scene.layout.corridor.entityId, undefined, 'null 必须真的解除绑定');
  assert.equal(unbound.scene.constraints.corridorLocationRef, null);
  assert.ok(unbound.scene.layout.rooms.some((r) => r.id === CORR), '解除后它可以重新作为普通房间');
  const unboundIds = Kit.sceneLocationGeometry(unbound.scene).map((g) => g.entityId);
  assert.equal(new Set(unboundIds).size, 5, '解除绑定后还是五个地点，各一次');

  // 4) 绑定/解除都只动几何：实体父链一个字节都不许改。
  for (const mutation of unbound.group.mutations) {
    if (mutation.table !== 'locations') continue;
    assert.equal(
      mutation.after.parent_location_id, mutation.before.parent_location_id,
      `解除绑定不得改变 ${mutation.rowId} 的父链`,
    );
    assert.equal(mutation.after.kind, mutation.before.kind);
  }
});

// ───────────────────────── COR06 · 锁冲突与隐藏走廊 ─────────────────────────

test('COR06：锁冲突保存旧 scene/地点坐标；隐藏走廊不泄漏实体 ID、名称、门端点或陈设', () => {
  const good = generate(boundSpec(), context());
  assert.equal(good.ok, true, JSON.stringify(good.issues));

  // 1) 已确认的走廊几何与新通道位置冲突 → 拒绝重建并保留旧场景，绝不删锁后排版。
  const confirmedArea = {
    kind: 'polygon', quality: 'confirmed', name: CORR_NAME,
    points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }],
  };
  const lockedContext = Kit.buildLayoutContext({
    scope: SCOPE, mapRow: mapRow(),
    locations: locations().map((row) => (row.id === CORR
      ? { ...row, kind: 'room', area_geometry_json: JSON.stringify(confirmedArea) }
      : row)),
    characters: characters(), items: [], routes: [],
  });
  assert.equal(lockedContext.ok, true, JSON.stringify(lockedContext.issues));
  assert.ok(lockedContext.context.locks.rooms[CORR], '前置条件：走廊地点带已确认矩形锁');
  const conflict = generate(boundSpec(), lockedContext.context, good.scene);
  assert.equal(conflict.ok, false, JSON.stringify(conflict.issues));
  assert.equal(conflict.scene, null);
  const issue = conflict.issues.find((i) => i.code === 'CORRIDOR_LOCK_CONFLICT');
  assert.ok(issue, JSON.stringify(conflict.issues));
  assert.equal(issue.entityId, CORR);
  assert.ok(conflict.kept, '冲突时必须保留旧场景');
  assert.deepEqual(conflict.kept.layout.corridor, good.scene.layout.corridor, '旧走廊几何不得被改写');
  assert.deepEqual(conflict.kept.layout.rooms, good.scene.layout.rooms, '旧房间坐标不得被改写');

  // 2) POV：走廊地点不可见 → 实体 ID、名称、陈设、人物全部不下发（连提示都不给）。
  const layout = good.scene.layout;
  const corridorGroupIds = layout.groups.filter((g) => g.roomId === CORR).map((g) => g.id);
  assert.ok(corridorGroupIds.length > 0, '前置条件：走廊里有陈设');
  const pov = Kit.filterSceneForView(good.scene, {
    scope: { ...SCOPE, viewMode: 'pov' },
    visibleLocations: [R_N1, R_N2, R_S1, R_S2],
    // 关键：走廊里的人物**本身是可见角色**，藏住他靠的是「走廊不可见」这条空间规则，
    // 不是靠角色可见性兜底 —— 否则这条断言会因为别的原因通过。
    visibleCharacters: [C_N, C_S, C_HALL],
    visibleItems: [],
  });
  assert.equal(pov.ok, true, JSON.stringify(pov.issues));
  const povLayout = pov.scene.layout;
  assert.equal(povLayout.corridor.entityId, undefined, '隐藏走廊不得下发实体 ID');
  assert.equal(povLayout.corridor.name, undefined, '隐藏走廊不得下发名称');
  assert.ok(RECT_KEYS.every((k) => Number.isFinite(povLayout.corridor[k])), '几何形状本身仍要能画');
  assert.ok(!povLayout.groups.some((g) => corridorGroupIds.includes(g.id)), '隐藏走廊的陈设不得泄漏');
  assert.ok(!povLayout.actors.some((a) => a.id === C_HALL), '隐藏走廊里的人物不得泄漏');
  assert.ok(!povLayout.lamps.some((l) => l.roomId === CORR), '走廊灯具不得泄漏');
  assert.ok(!povLayout.doors.some((d) => d.roomId === CORR), '不得出现走廊门端点');
  assert.equal(povLayout.doors.length, 4, '四间可见房间的门照常下发');
  const serialized = JSON.stringify(pov.scene);
  assert.ok(!serialized.includes(CORR), 'POV 结果里绝不能出现隐藏走廊的地点 ID');
  assert.ok(!serialized.includes(CORR_NAME), 'POV 结果里绝不能出现隐藏走廊的名称');
  assert.ok(!serialized.includes(C_HALL), 'POV 结果里绝不能出现走廊里的人物 ID');

  // 3) 走廊可见时身份与点击入口照常下发。
  const visible = Kit.filterSceneForView(good.scene, {
    scope: { ...SCOPE, viewMode: 'pov' },
    visibleLocations: [CORR, R_N1, R_N2, R_S1, R_S2],
    visibleCharacters: [C_N, C_S, C_HALL],
    visibleItems: [],
  });
  assert.equal(visible.ok, true, JSON.stringify(visible.issues));
  assert.equal(visible.scene.layout.corridor.entityId, CORR);
  assert.equal(visible.scene.layout.corridor.name, CORR_NAME);
  assert.ok(visible.scene.layout.groups.some((g) => corridorGroupIds.includes(g.id)));
});

// ───────────────────── 编译器：corridorLocationRef 是真实地点引用 ─────────────────────

const ANCHOR = makeAnchor();
const seedErrors = (out) => out.issues.filter((i) => i.severity === 'error');

function compileText(seed, text, extraRefs = []) {
  const parsed = parseOperations(text, { phase: 'geography' });
  const out = compileOperations({
    operations: parsed.operations,
    anchor: ANCHOR,
    phase: 'geography',
    clockS: 0,
    revision: 0,
    tables: createTableReadPort(seed.db),
    sources: { phase: 'geography', snapshot: SOURCE_SNAPSHOT, clockS: 0 },
    knownRefs: [...seed.refs.map((ref) => ({ alias: ref.alias, id: ref.id, kind: ref.kind })), ...extraRefs],
  });
  return out;
}

test('COR-ops-01：corridorLocationRef 解析成规范 ID、进依赖、随请求落盘（含 new: 前向声明）', async () => {
  const seed = await makeSeedWith(SQL);
  const text = [
    '{"op":"location.upsert","ref":"new:hall","data":{"name":"中央走廊","kind":"room","parent_ref":"L2"}}',
    '{"op":"map.layout.request","ref":"M2","data":{"kind":"floor","spec":{"rooms":[{"id":"L3","side":"north","w":5,"h":4}],"corridorLocationRef":"new:hall"}}}',
  ].join('\n');
  const out = compileText(seed, text);
  assert.deepEqual(seedErrors(out), [], `不应有 error：${JSON.stringify(out.issues)}`);
  const hallId = out.aliasById.get('hall');
  assert.match(hallId, /^loc_/, '前向声明的地点必须解析成规范 ID');
  const entry = out.results[1];
  const req = entry.result.mutations[0].after.frame_json.atlasLayoutRequest;
  assert.equal(req.spec.corridorLocationRef, hallId, '落盘必须写规范 ID，不是别名');
  assert.equal(req.spec.rooms[0].id, IDS.L3);
  assert.ok(entry.result.dependencies.includes(hallId), '走廊地点必须进依赖');
  seed.db.close();
});

test('COR-ops-02：别图的地点不能当本图的走廊（父图/子图不混用）', async () => {
  const seed = await makeSeedWith(SQL);
  // L2 归世界图 M1；把它当教室图 M2 的走廊 → 冲突，且不产生任何变更。
  const out = compileText(seed, '{"op":"map.layout.request","ref":"M2","data":{"kind":"floor","spec":{"rooms":[{"id":"L3","side":"north","w":5,"h":4}],"corridorLocationRef":"L2"}}}');
  const errs = seedErrors(out);
  assert.equal(errs.length, 1, JSON.stringify(out.issues));
  assert.equal(errs[0].code, 'LAYOUT_REQUEST_CONFLICT');
  assert.equal(out.results[0].result.mutations.length, 0, '冲突请求不得产生变更');
  seed.db.close();
});

test('COR-ops-03：不是地点的引用被拒绝（人物 → 类型不符；未登记别名 → REF_UNKNOWN）', async () => {
  const seed = await makeSeedWith(SQL);
  const mismatch = compileText(seed, '{"op":"map.layout.request","ref":"M2","data":{"kind":"floor","spec":{"rooms":[{"id":"L3","side":"north","w":5,"h":4}],"corridorLocationRef":"C1"}}}');
  const typeErr = seedErrors(mismatch).find((i) => i.code === 'REF_TYPE_MISMATCH');
  assert.ok(typeErr, JSON.stringify(mismatch.issues));
  assert.equal(typeErr.path, '$.data.spec.corridorLocationRef');
  assert.equal(mismatch.results[0].result.mutations.length, 0);

  const unknown = compileText(seed, '{"op":"map.layout.request","ref":"M2","data":{"kind":"floor","spec":{"rooms":[{"id":"L3","side":"north","w":5,"h":4}],"corridorLocationRef":"table1"}}}');
  const unknownErr = seedErrors(unknown).find((i) => i.code === 'REF_UNKNOWN');
  assert.ok(unknownErr, `家具局部 ID 不得被当作地点：${JSON.stringify(unknown.issues)}`);
  assert.equal(unknownErr.path, '$.data.spec.corridorLocationRef');
  assert.equal(unknown.results[0].result.mutations.length, 0);
  seed.db.close();
});

test('COR-ops-04：corridorLocationRef 只属于 floor 模板，形状错误直接拒绝该操作', async () => {
  const seed = await makeSeedWith(SQL);
  const city = compileText(seed, '{"op":"map.layout.request","ref":"M1","data":{"kind":"city","spec":{"districts":[{"id":"L1","bank":"west","order":0}],"corridorLocationRef":"L1"}}}');
  const cityErr = seedErrors(city).find((i) => i.code === 'ENUM_INVALID');
  assert.ok(cityErr, JSON.stringify(city.issues));
  assert.equal(cityErr.path, '$.data.spec.corridorLocationRef');
  assert.equal(city.results[0].result.mutations.length, 0);

  const blank = compileText(seed, '{"op":"map.layout.request","ref":"M2","data":{"kind":"floor","spec":{"rooms":[{"id":"L3","side":"north","w":5,"h":4}],"corridorLocationRef":"   "}}}');
  const blankErr = seedErrors(blank).find((i) => i.code === 'MINIMUM_FIELD_MISSING');
  assert.ok(blankErr, JSON.stringify(blank.issues));
  assert.equal(blank.results[0].result.mutations.length, 0);
  seed.db.close();
});

test('COR-ops-05：同一批两个请求在同一走廊上给不同值 → 冲突，不静默取最后一个', async () => {
  const seed = await makeSeedWith(SQL);
  const text = [
    '{"op":"location.upsert","ref":"new:hall1","data":{"name":"中央走廊","kind":"room","parent_ref":"L2"}}',
    '{"op":"location.upsert","ref":"new:hall2","data":{"name":"后廊","kind":"room","parent_ref":"L2"}}',
    '{"op":"map.layout.request","ref":"M2","data":{"kind":"floor","spec":{"rooms":[{"id":"L3","side":"north","w":5,"h":4}],"corridorLocationRef":"new:hall1"}}}',
    '{"op":"map.layout.request","ref":"M2","data":{"kind":"floor","spec":{"corridorLocationRef":"new:hall2"}}}',
  ].join('\n');
  const out = compileText(seed, text);
  const errs = seedErrors(out);
  assert.equal(errs.length, 1, JSON.stringify(out.issues));
  assert.equal(errs[0].code, 'LAYOUT_REQUEST_CONFLICT');
  assert.match(errs[0].path, /corridorLocationRef/, `冲突路径要指到走廊绑定：${errs[0].path}`);
  assert.equal(out.results[2].result.mutations.length, 1, '同批第一个请求本来会落盘，冲突必须让整批都不落盘');
  assert.equal(out.results[3].result.mutations.length, 0, '冲突请求不得落盘');
  seed.db.close();
});
