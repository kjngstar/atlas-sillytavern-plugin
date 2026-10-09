/**
 * atlas-spatial-floor-details.test.mjs — M4-28 验收（G08/G09）。
 *
 * 纪律：全部走**真实生成器**（generateFloor / buildLayoutContext / compileSceneGroup /
 * buildSceneMutation / readSceneFrame），不 mock 几何、不自己造 context。
 * 断言只落在可观察结果：scene 文档、issues（带 entityId）、SQL 变更集合、保存后读回。
 *
 * 覆盖：
 *   G08 · 室内陈设和通行 —— 家具在房间内、实体 marker 不穿墙、doorways 可达、
 *         solid 与装饰分开、无法放置项带 ID、非法项不拖累合法项。
 *   G09 · 粗定位不伪造精确点 —— 只知学校的 NPC 不进室内图、室内 NPC 只有 layout 点、
 *         人物表 coord_precision 不得升级 exact。
 *   另含：作用域过期、预算超限、缺 constraints 的旧场景兼容、保存后重开同一场景。
 *
 * 边界：不调用外网；数据只存在于内存。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as Kit from '../vendor/atlas-spatial/index.mjs';
import { charactersSql } from '../src/atlas-db-schema.ts';

const BRANCH = 'b1';
const SCOPE = { chatId: 'chat-1', branchId: BRANCH, revision: 3, viewMode: 'author' };
const MAP_ID = 'M_SCHOOL';
const SCHOOL = 'L_SCHOOL';
const R_CLASS = 'L_CLASS';
const R_LAB = 'L_LAB';
const C_STAR = 'C_STAR';   // 主角：明确在教室，xy 未知
const C_GUARD = 'C_GUARD'; // 明确在实验室，xy 未知
const C_MAYOR = 'C_MAYOR'; // 只知道「学校」这个粗地点
const I_BOOK = 'I_BOOK';
const I_ON_BED = 'I_ON_BED';

/** 02 §6.4：solid 类型参与碰撞；light/decor/doorway/stairs 不挡路。 */
const SOLID_TYPES = new Set(['shelf', 'desk', 'bench', 'reading', 'table', 'chair', 'bed', 'cabinet']);
const EPS = 1e-6;
const insideRect = (outer, inner) =>
  inner.x >= outer.x - EPS && inner.y >= outer.y - EPS
  && inner.x + inner.w <= outer.x + outer.w + EPS && inner.y + inner.h <= outer.y + outer.h + EPS;
const pointIn = (rect, p) =>
  p.x >= rect.x - EPS && p.x <= rect.x + rect.w + EPS && p.y >= rect.y - EPS && p.y <= rect.y + rect.h + EPS;

// ───────────────────────────── 夹具 ─────────────────────────────

function loc(id, over = {}) {
  return {
    branch_id: BRANCH, id, name: id, status: 'active', kind: 'room',
    parent_location_id: null, map_id: MAP_ID, grid_x: null, grid_y: null,
    coord_precision: 'unknown', area_geometry_json: null, ...over,
  };
}

function chr(id, over = {}) {
  return {
    branch_id: BRANCH, id, name: id, status: 'active',
    location_id: null, map_id: null, grid_x: null, grid_y: null, coord_precision: 'unknown', ...over,
  };
}

function item(id, locationId, over = {}) {
  return {
    branch_id: BRANCH, id, name: id, status: 'active', location_id: locationId,
    holder_character_id: null, container_item_id: null,
    map_id: null, grid_x: null, grid_y: null, coord_precision: 'unknown', ...over,
  };
}

const locations = () => [
  loc(SCHOOL, { kind: 'site', parent_location_id: null, map_id: null }),
  loc(R_CLASS, { kind: 'room', parent_location_id: SCHOOL }),
  loc(R_LAB, { kind: 'room', parent_location_id: SCHOOL }),
];
const characters = () => [
  chr(C_STAR, { location_id: R_CLASS }),
  chr(C_GUARD, { location_id: R_LAB }),
  chr(C_MAYOR, { location_id: SCHOOL }),
];
const items = () => [item(I_BOOK, R_CLASS), item(I_ON_BED, R_CLASS)];

function mapRow(over = {}) {
  return {
    branch_id: BRANCH, id: MAP_ID, name: '学校楼层', container_location_id: SCHOOL,
    frame_json: { cols: 24, rows: 20 }, meters_per_cell: 1,
    scale_quality: 'exact', scale_locked: 0, row_rev: 3, ...over,
  };
}

/** 走真实 buildLayoutContext：锁、代理、引用目录都由它算。 */
function context(extra = {}) {
  const built = Kit.buildLayoutContext({
    scope: SCOPE, mapRow: mapRow(), locations: locations(),
    characters: characters(), items: items(), routes: [], ...extra,
  });
  assert.equal(built.ok, true, JSON.stringify(built.issues));
  return built.context;
}

/**
 * G08 场景：两间 room（教室 / 实验室）、床/桌/柜/灯、门口结构、一个重要人物与地面物品。
 * 另含三个「必须被拒绝但不得拖累他人」的坏项：超大床、错误类型、放不上架子的物品。
 */
function floorSpec(over = {}) {
  return {
    rooms: [
      { id: R_CLASS, name: '教室', side: 'south', w: 8, h: 6 },
      { id: R_LAB, name: '实验室', side: 'north', w: 8, h: 6 },
    ],
    corridorWidth: 2,
    contents: [
      { id: 'F_BED', roomId: R_CLASS, type: 'bed', w: 2, h: 1.2 },
      { id: 'F_DESK', roomId: R_CLASS, type: 'desk', w: 2, h: 1 },
      { id: 'F_BENCH', roomId: R_CLASS, type: 'bench', w: 1, h: 0.4 },
      { id: 'F_DOOR', roomId: R_CLASS, type: 'doorway', w: 1.2, h: 0.3 },
      { id: 'F_CAB', roomId: R_LAB, type: 'cabinet', w: 1, h: 0.6 },
      { id: 'F_LAMP', roomId: R_LAB, type: 'light', w: 0.5, h: 0.5 },
      { id: 'F_HUGE', roomId: R_LAB, type: 'bed', w: 30, h: 30 },
      { id: 'F_WEIRD', roomId: R_CLASS, type: 'spaceship', w: 1, h: 1 },
    ],
    actors: [
      { id: C_STAR, roomId: R_CLASS, near: 'F_DESK' },
      { id: C_GUARD, roomId: R_LAB },
    ],
    items: [
      { id: I_BOOK, on: 'F_DESK' },
      { id: I_ON_BED, on: 'F_BED' },
    ],
    ...over,
  };
}

/** 干净场景：没有任何应被拒绝的条目，用于幂等 / 兼容断言。 */
function cleanSpec() {
  return {
    rooms: [
      { id: R_CLASS, name: '教室', side: 'south', w: 8, h: 6 },
      { id: R_LAB, name: '实验室', side: 'north', w: 8, h: 6 },
    ],
    corridorWidth: 2,
    contents: [
      { id: 'F_BED', roomId: R_CLASS, type: 'bed', w: 2, h: 1.2 },
      { id: 'F_DESK', roomId: R_CLASS, type: 'desk', w: 2, h: 1 },
      { id: 'F_CAB', roomId: R_LAB, type: 'cabinet', w: 1, h: 0.6 },
    ],
    actors: [
      { id: C_STAR, roomId: R_CLASS, near: 'F_DESK' },
      { id: C_GUARD, roomId: R_LAB },
    ],
    items: [{ id: I_BOOK, on: 'F_DESK' }],
  };
}

const generate = (spec, ctx, previousScene = null) =>
  Kit.generateFloor(spec, { ...ctx, previousScene });

const issueFor = (issues, code, entityId) =>
  issues.find((i) => i.code === code && i.entityId === entityId);

// ───────────────────────────── G08 · 室内陈设和通行 ─────────────────────────────

test('G08：家具在房间内、实体不穿墙、doorways 可达、solid 与装饰分开、坏项带 ID 且不拖累好项', () => {
  const result = generate(floorSpec(), context());
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const scene = result.scene;
  assert.equal(scene.units, 'meters');
  assert.equal(scene.metersPerCell, 1);
  assert.equal(scene.layout.kind, 'floor');
  assert.deepEqual(Kit.checkSceneDocument(scene), []);
  assert.deepEqual([scene.layout.bounds.w, scene.layout.bounds.h], [24, 20]);

  const roomById = new Map(scene.layout.rooms.map((r) => [r.id, r]));
  assert.equal(scene.layout.rooms.length, 2, '两间 room 都要落位');

  // 1) 六件合法陈设都在，超大床与错误类型都没进场景。
  const groupIds = scene.layout.groups.map((g) => g.id).sort();
  assert.deepEqual(groupIds, ['F_BED', 'F_BENCH', 'F_CAB', 'F_DESK', 'F_DOOR', 'F_LAMP']);
  assert.ok(!groupIds.includes('F_HUGE'), '塞不进房间的床绝不能偷偷放大到穿墙');
  assert.ok(!groupIds.includes('F_WEIRD'), '不支持的陈设类型不能进场景');

  // 2) 家具完全落在自己房间内（不穿墙）。
  for (const g of scene.layout.groups) {
    const room = roomById.get(g.roomId);
    assert.ok(room, `家具 ${g.id} 的房间不存在`);
    assert.ok(insideRect(room, g), `家具 ${g.id} 越出房间 ${g.roomId}`);
  }

  // 3) 实体渲染形状同样不穿墙，且 solid 标记与类型严格一致。
  for (const b of scene.layout.bodies) {
    const room = roomById.get(b.roomId);
    assert.ok(room, `实体 ${b.id} 的房间不存在`);
    assert.ok(insideRect(room, b), `实体 ${b.id} 越出房间 ${b.roomId}`);
    assert.equal(b.solid, SOLID_TYPES.has(b.type), `实体 ${b.id}(${b.type}) 的 solid 标记与类型不一致`);
  }
  assert.ok(scene.layout.bodies.some((b) => b.type === 'bed' && b.solid === true), '床必须挡路');
  assert.ok(scene.layout.bodies.some((b) => b.type === 'doorway' && b.solid === false), '门洞是通行结构，永不参与碰撞');
  assert.ok(scene.layout.bodies.some((b) => b.type === 'light' && b.solid === false), '灯是装饰，不挡路');

  // 4) 人物与地面物品的 markder 都在自己房间内，且人物没站进实体里。
  assert.equal(scene.layout.actors.length, 2, JSON.stringify(result.issues));
  const solidBodies = scene.layout.bodies.filter((b) => b.solid);
  for (const a of scene.layout.actors) {
    const room = roomById.get(a.roomId);
    assert.ok(pointIn(room, a), `人物 ${a.id} 越出房间 ${a.roomId}`);
    assert.ok(!solidBodies.some((b) => b.roomId === a.roomId && pointIn(b, a)), `人物 ${a.id} 站进了实体里`);
    assert.equal(a.type, 'person');
  }
  assert.equal(scene.layout.items.length, 1, '只有放得上桌子/柜台的地面物品才画出来');
  const book = scene.layout.items[0];
  assert.equal(book.id, I_BOOK);
  assert.equal(book.containerId, 'F_DESK');
  assert.equal(book.type, 'item');
  assert.ok(pointIn(roomById.get(book.roomId), book), `物品 ${book.id} 越出房间`);

  // 5) doorways 可达：每间房都有门口与开门弧，所有家具都有可达交互点。
  assert.equal(scene.layout.doors.length, scene.layout.rooms.length);
  assert.equal(scene.layout.doorSwings.length, scene.layout.rooms.length);
  assert.ok(!result.issues.some((i) => i.code === 'DETAIL_NOT_REACHABLE'), JSON.stringify(result.issues));
  for (const g of scene.layout.groups) {
    assert.ok(g.interaction, `家具 ${g.id} 没有可达的交互点`);
    assert.ok(pointIn(roomById.get(g.roomId), g.interaction), `家具 ${g.id} 的交互点越出房间`);
  }
  assert.ok(scene.layout.lamps.length >= 2, '每个房间至少一盏灯');
  assert.ok(scene.layout.windows.length >= 2, '房间要有窗');
  assert.ok(scene.layout.path.length >= 2, '两个不同房间的人物之间要有一条可读路径');
  for (const p of scene.layout.path) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), '路径点必须有限');

  // 6) 三个坏项都带 ID，且合法项一个都没被牵连。
  assert.ok(issueFor(result.issues, 'DETAIL_TOO_LARGE', 'F_HUGE'), JSON.stringify(result.issues));
  assert.ok(issueFor(result.issues, 'FURNITURE_TYPE_UNSUPPORTED', 'F_WEIRD'), JSON.stringify(result.issues));
  assert.ok(issueFor(result.issues, 'ITEM_CONTAINER_NOT_FOUND', I_ON_BED), JSON.stringify(result.issues));
  assert.equal(result.status, 'partial', '有被拒绝条目时状态是 partial，不是 generated');

  // 7) 所有数值有限、场景仍可读。
  const walk = (v) => {
    if (typeof v === 'number') assert.ok(Number.isFinite(v), '场景含非有限数值');
    else if (v && typeof v === 'object') for (const c of Object.values(v)) walk(c);
  };
  walk(scene);
});

test('G08：家具摆满后门口与通道依旧可达，没有一件家具被空间不足吞掉', () => {
  // 把教室填到接近容量：门口结构 + 四件实体，验证求解器不会把通道堵死。
  const spec = cleanSpec();
  spec.contents = [
    { id: 'F_BED', roomId: R_CLASS, type: 'bed', w: 2, h: 1.2 },
    { id: 'F_DESK', roomId: R_CLASS, type: 'desk', w: 2, h: 1 },
    { id: 'F_BENCH', roomId: R_CLASS, type: 'bench', w: 1, h: 0.4 },
    { id: 'F_CABINET', roomId: R_CLASS, type: 'cabinet', w: 1.5, h: 0.6 },
    { id: 'F_DOOR', roomId: R_CLASS, type: 'doorway', w: 1.2, h: 0.4 },
  ];
  const result = generate(spec, context());
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(Kit.checkSceneDocument(result.scene), []);
  assert.ok(
    !result.issues.some((i) => i.code === 'DETAIL_NOT_REACHABLE' || i.code === 'DETAIL_NO_SPACE'),
    JSON.stringify(result.issues),
  );
  assert.equal(result.scene.layout.groups.length, 5, '五件陈设都要落位');
  const roomById = new Map(result.scene.layout.rooms.map((r) => [r.id, r]));
  for (const g of result.scene.layout.groups) {
    assert.ok(g.interaction && pointIn(roomById.get(g.roomId), g.interaction), `家具 ${g.id} 不可达`);
  }
  // 门口结构永远不挡路，人物依旧能站到该房间。
  assert.ok(result.scene.layout.bodies.some((b) => b.type === 'doorway' && b.solid === false));
  assert.ok(result.scene.layout.actors.some((a) => a.id === C_STAR && a.roomId === R_CLASS));
});

// ───────────────────────────── G09 · 粗定位不伪造精确点 ─────────────────────────────

test('G09：只知学校的 NPC 不进室内图；室内 NPC 只有 layout 点；人物表精度不得升级 exact', () => {
  const chars = characters();
  const before = chars.map((c) => ({ id: c.id, coord_precision: c.coord_precision, map_id: c.map_id, grid_x: c.grid_x, grid_y: c.grid_y }));

  const result = Kit.compileSceneGroup({
    request: {
      kind: 'floor',
      spec: floorSpec({
        actors: [
          { id: C_STAR, roomId: R_CLASS, near: 'F_DESK' },
          { id: C_GUARD, roomId: R_LAB },
          { id: C_MAYOR, roomId: R_LAB }, // 只登记在「学校」，不属于这间房
        ],
      }),
    },
    scope: SCOPE, currentScope: SCOPE, mapRow: mapRow(),
    locations: locations(), characters: chars, items: items(), routes: [],
    turnId: 'T9', operationId: 'OP9',
  });

  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.status, 'prepared');
  const scene = result.scene;

  // 1) 学校级 NPC 被拒绝进图，并留下可诊断的原因与实体 ID。
  const mismatch = issueFor(result.issues, 'ACTOR_LOCATION_MISMATCH', C_MAYOR);
  assert.ok(mismatch, JSON.stringify(result.issues));
  assert.equal(mismatch.severity, 'warning');
  assert.ok(!scene.layout.actors.some((a) => a.id === C_MAYOR), '粗定位人物绝不能出现在室内 layout 点里');

  // 2) 室内 NPC 可以拿到 layout 点，但质量只能是 layout，绝不是 exact / confirmed。
  const star = scene.layout.actors.find((a) => a.id === C_STAR);
  assert.ok(star, JSON.stringify(result.issues));
  assert.equal(star.quality, 'layout');
  assert.equal(star.mapId, MAP_ID);
  assert.notEqual(star.quality, 'exact');
  assert.notEqual(star.quality, 'confirmed');
  const guard = scene.layout.actors.find((a) => a.id === C_GUARD);
  assert.ok(guard);
  assert.equal(guard.quality, 'layout');

  // 3) 编译产物一行都不写人物表：布局精度永远不会被提升为人物实际坐标。
  const tables = result.group ? [...new Set(result.group.mutations.map((m) => m.table))] : [];
  assert.ok(tables.includes('maps'), '必须写入地图行');
  assert.ok(tables.includes('locations'), '房间几何写地点表');
  assert.ok(!tables.includes('characters'), `布局不得写人物表：${JSON.stringify(tables)}`);
  for (const m of result.group?.mutations ?? []) {
    assert.notEqual(m.table, 'characters');
    if (m.table === 'locations') assert.equal(m.after.coord_precision, 'layout', '地点布局写入是 layout 精度');
  }

  // 4) 场景 → SQL 映射只映射房间，绝不含任何人物 ID。
  const mapped = Kit.sceneLocationGeometry(scene);
  assert.deepEqual(mapped.map((g) => g.entityId).sort(), [R_CLASS, R_LAB]);
  for (const g of mapped) assert.equal(g.precision, 'layout');
  for (const c of [C_STAR, C_GUARD, C_MAYOR]) assert.ok(!mapped.some((g) => g.entityId === c), `人物不该出现在地点几何映射：${c}`);

  // 5) 人物行本身没被碰过：C_MAYOR 仍是「未知坐标」，只能靠 location_id 出现在粗地点名单。
  assert.deepEqual(chars.map((c) => ({ id: c.id, coord_precision: c.coord_precision, map_id: c.map_id, grid_x: c.grid_x, grid_y: c.grid_y })), before);
  const mayor = chars.find((c) => c.id === C_MAYOR);
  assert.equal(mayor.coord_precision, 'unknown');
  assert.equal(mayor.map_id, null);
  assert.equal(mayor.grid_x, null);
  assert.equal(mayor.grid_y, null);
  assert.equal(mayor.location_id, SCHOOL, '只知学校 → 只在粗地点名单里按 location_id 出现');

  // 6) 表约束层面兜底：人物表根本不允许 layout，枚举里也没有 exact 之外的可疑自由度。
  const ddl = charactersSql();
  assert.match(ddl, /CHECK \(coord_precision <> 'layout'\)/);
  assert.match(ddl, /coord_precision TEXT NOT NULL DEFAULT 'unknown' CHECK \(coord_precision IN \('exact','approximate','unknown'\)\)/);
});

// ───────────────────────── 过期作用域 · 预算 · 保存后重开 · 旧档兼容 ─────────────────────────

test('floor：作用域过期立即失败，既不返回场景也不写出任何几何', () => {
  const stale = Kit.generateFloor(floorSpec(), { ...context(), currentScope: { ...SCOPE, revision: 99 } });
  assert.equal(stale.ok, false);
  assert.equal(stale.scene, null);
  assert.ok(stale.issues.some((i) => i.code === 'STALE_SCOPE'), JSON.stringify(stale.issues));

  const ok = Kit.generateFloor(cleanSpec(), context());
  assert.equal(ok.ok, true);
  const row = mapRow();
  const prepared = Kit.buildSceneMutation({
    result: ok, mapRow: row, scope: SCOPE, currentScope: { ...SCOPE, revision: 4 },
    turnId: 'T', operationId: 'OP', expectedRowRev: row.row_rev,
  });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.mutation, undefined);
  assert.ok(prepared.issues.some((i) => i.code === 'STALE_SCOPE'), JSON.stringify(prepared.issues));
});

test('floor：集合超预算时明确失败并保留原布局，不静默截断', () => {
  const contents = Array.from({ length: Kit.LIMITS.contents + 1 }, (_, i) => ({ id: `F_${i}`, roomId: R_CLASS, type: 'chair', w: 1, h: 1 }));
  const over = Kit.generateFloor(floorSpec({ contents }), context());
  assert.equal(over.ok, false);
  assert.ok(over.issues.some((i) => i.code.includes('COLLECTION_LIMIT')), JSON.stringify(over.issues));
  assert.equal(over.kept, null, '首次生成没有旧场景可保留时必须是 null，不能伪造');

  const good = Kit.generateFloor(cleanSpec(), context());
  assert.equal(good.ok, true);
  const withPrevious = Kit.generateFloor(floorSpec({ contents }), { ...context(), previousScene: good.scene });
  assert.equal(withPrevious.ok, false);
  assert.ok(withPrevious.kept, '失败必须保留已保存布局');
  assert.deepEqual(withPrevious.kept.layout.rooms, good.scene.layout.rooms);
});

test('floor：保存后重开读回同一场景；同一请求重跑为 reused，不重排已保存几何', () => {
  const first = Kit.generateFloor(cleanSpec(), context());
  assert.equal(first.ok, true, JSON.stringify(first.issues));

  const row = mapRow();
  const prepared = Kit.buildSceneMutation({
    result: first, mapRow: row, scope: SCOPE, currentScope: SCOPE,
    turnId: 'T1', operationId: 'OP1', expectedRowRev: row.row_rev,
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared.issues));
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.mutation.table, 'maps');
  assert.ok(prepared.mutation.after.row_rev > prepared.mutation.before.row_rev);

  const reopened = Kit.readSceneFrame(prepared.mutation.after.frame_json, { branchId: BRANCH, mapId: MAP_ID });
  assert.equal(reopened.ok, true, JSON.stringify(reopened.issues));
  assert.deepEqual(Kit.checkSceneDocument(reopened.scene), []);
  assert.deepEqual(reopened.scene, first.scene, '保存后重开必须读回同一场景');

  const again = Kit.generateFloor(cleanSpec(), { ...context(), previousScene: reopened.scene });
  assert.equal(again.ok, true, JSON.stringify(again.issues));
  assert.equal(again.status, 'reused', `无变化的请求必须走 reused：${again.status} ${JSON.stringify(again.issues)}`);
  assert.deepEqual(again.scene.layout.rooms, first.scene.layout.rooms, '复跑不得重排已保存房间');
  assert.deepEqual(again.scene.layout.groups, first.scene.layout.groups, '复跑不得重排已保存家具');

  // 地图行被别人改过 → 明确 STALE_ROW，不覆盖。
  const staleRow = Kit.buildSceneMutation({
    result: first, mapRow: { ...row, row_rev: row.row_rev + 1 }, scope: SCOPE, currentScope: SCOPE,
    turnId: 'T2', operationId: 'OP2', expectedRowRev: row.row_rev,
  });
  assert.equal(staleRow.ok, false);
  assert.ok(staleRow.issues.some((i) => i.code === 'STALE_ROW'), JSON.stringify(staleRow.issues));
});

test('floor：缺受控约束的旧场景按整图重建语义处理并留下告警，旧 city 仍走自己的生成器', () => {
  const first = Kit.generateFloor(cleanSpec(), context());
  assert.equal(first.ok, true);
  const legacy = Kit.clone(first.scene);
  delete legacy.constraints;

  const again = Kit.generateFloor(cleanSpec(), { ...context(), previousScene: legacy });
  assert.equal(again.ok, true, JSON.stringify(again.issues));
  assert.ok(again.issues.some((i) => i.code === 'CONSTRAINTS_LEGACY'), JSON.stringify(again.issues));
  assert.equal(again.scene.layout.rooms.length, 2);
  assert.equal(again.scene.layout.groups.length, 3);
  assert.deepEqual(Kit.checkSceneDocument(again.scene), []);

  // 旧 city（无 enclosure + 有旧场景）继续输出城墙，不被 floor 分支吞掉。
  const cityCtx = {
    scope: SCOPE, currentScope: SCOPE,
    map: { id: 'M_C', name: '旧城', metersPerCell: 10, frame: { cols: 120, rows: 100 }, scaleQuality: 'estimated', scaleLocked: false },
    entities: { locations: ['D1'], characters: [], items: [], routes: [] },
  };
  const city = Kit.generateCity(
    { riverWidth: 0, districts: [{ id: 'D1', name: '城区', bank: 'west', order: 0 }] },
    cityCtx,
  );
  assert.equal(city.ok, true, JSON.stringify(city.issues));
  assert.equal(city.scene.layout.kind, 'city');
  assert.equal(city.scene.layout.enclosure, 'open', '新城市默认开放边界');
  assert.deepEqual(Kit.checkSceneDocument(city.scene), []);
});
