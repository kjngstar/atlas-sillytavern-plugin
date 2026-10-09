/**
 * atlas-spatial-overview-visibility.test.mjs — M4-29 验收（G10）。
 *
 * 纪律：全部走**真实生成器 + 真实适配器**（generateOverview / projectMapView / filterSceneForView），
 * 不 mock 几何。断言只落在可观察结果：POV 场景文档、粗地点名单、以及**整份 JSON 里是否出现秘密字符串**。
 *
 * 覆盖：
 *   G10 · 隐藏背景过滤 —— hidden zone 的 ID/名称/几何/关联 feature 一律不下发 POV；
 *         指向 hidden 端点的 route 连同路径一起剔除；作者视图完整；
 *         全图公开材质（无 zoneId）保留，但不得暗示隐藏命名地点。
 *   另含：投影层就拦下隐藏点与标记隐藏的路线、作用域过期、预算超限、非法一项仍保合法项、旧 floor 的 POV 过滤。
 *
 * 边界：不调用外网；合成数据只存在于本文件。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as Kit from '../vendor/atlas-spatial/index.mjs';

const BRANCH = 'b1';
const SCOPE = { chatId: 'chat-1', branchId: BRANCH, revision: 3, viewMode: 'author' };
const POV = { ...SCOPE, viewMode: 'pov' };
const MAP_ID = 'M_WORLD';

/** 必须在 POV 输出里彻底消失的秘密串。 */
const SECRET_ZONE = 'ZONE_HIDDEN_TOWER';
const SECRET_ZONE_NAME = '黑塔秘密营地';
const SECRET_ROUTE = 'R_HIDDEN_ROAD';
const SECRET_FEATURE = 'F_SECRET_FOREST';

const PUB_A = 'Z_PUBLIC_A';
const PUB_B = 'Z_PUBLIC_B';

function loc(id, over = {}) {
  return {
    branch_id: BRANCH, id, name: id, status: 'active', kind: 'region',
    parent_location_id: null, map_id: MAP_ID, grid_x: null, grid_y: null,
    coord_precision: 'unknown', area_geometry_json: null, ...over,
  };
}

function route(id, from, to, over = {}) {
  return {
    branch_id: BRANCH, id, from_location_id: from, to_location_id: to, status: 'open',
    map_id: MAP_ID, geometry_json: null, geometry_quality: 'unknown', ...over,
  };
}

function mapRow(over = {}) {
  return {
    branch_id: BRANCH, id: MAP_ID, name: '总图', container_location_id: null,
    frame_json: { cols: 100, rows: 80 }, meters_per_cell: null,
    scale_quality: 'uncalibrated', scale_locked: 0, row_rev: 1, ...over,
  };
}

const LOCATIONS = () => [
  loc(PUB_A, { name: '公开广场' }),
  loc(PUB_B, { name: '公开集市' }),
  loc(SECRET_ZONE, { name: SECRET_ZONE_NAME }),
];
const ROUTES = () => [
  route('R_VISIBLE', PUB_A, PUB_B),
  route(SECRET_ROUTE, PUB_A, SECRET_ZONE),
];

/** 走真实 buildLayoutContext。 */
function context() {
  const built = Kit.buildLayoutContext({
    scope: SCOPE, mapRow: mapRow(), locations: LOCATIONS(),
    characters: [], items: [], routes: ROUTES(),
  });
  assert.equal(built.ok, true, JSON.stringify(built.issues));
  return built.context;
}

/** hidden zone + 指向 hidden 端点的 route + 挂 hidden zone 的 feature + 全图公开材质。 */
function overviewSpec(over = {}) {
  return {
    surface: 'mixed',
    zones: [
      { id: PUB_A, name: '公开广场', role: 'city', size: 'medium', sector: 'north' },
      { id: PUB_B, name: '公开集市', role: 'settlement', size: 'small', sector: 'east' },
      { id: SECRET_ZONE, name: SECRET_ZONE_NAME, role: 'ruins', size: 'small', sector: 'south' },
    ],
    links: [{ id: 'R_VISIBLE' }, { id: SECRET_ROUTE }],
    features: [
      { id: 'F_PUBLIC_FOREST', type: 'forest_texture', zoneId: PUB_B, density: 'medium' },
      { id: SECRET_FEATURE, type: 'forest_texture', zoneId: SECRET_ZONE, density: 'high' },
      { id: 'F_FULLMAP', type: 'road_texture', density: 'low' },
    ],
    ...over,
  };
}

const generate = (spec, ctx, previousScene = null) =>
  Kit.generateOverview(spec, { ...ctx, previousScene, currentScope: SCOPE });

/** 整份 POV 文档里不得出现任何秘密串 —— 这条比逐字段断言更难糊弄。 */
function assertNoSecretLeak(scene, ...secrets) {
  const json = JSON.stringify(scene);
  for (const s of secrets) assert.ok(!json.includes(s), `POV 输出泄露了：${s}`);
}

// ───────────────────────── G10 · 生成 + 过滤：隐藏背景 ─────────────────────────

test('G10：POV 不含 hidden zone 的 ID/名称/几何/关联 feature；指向它的 route 连路径一起剔除；作者视图完整', () => {
  const result = generate(overviewSpec(), context());
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const scene = result.scene;
  assert.equal(scene.layout.kind, 'overview');
  assert.deepEqual(Kit.checkSceneDocument(scene), []);

  // 生成阶段（作者视角）三块 zone / 两条 route / 三块 feature 都在。
  assert.equal(scene.layout.shapes.length, 3);
  assert.equal(scene.layout.routes.length, 2);
  assert.equal(scene.layout.features.length, 3);
  const hiddenShape = scene.layout.shapes.find((s) => s.id === SECRET_ZONE);
  assert.ok(hiddenShape, '生成时必须真的产出隐藏 zone，否则过滤测试没有意义');
  assert.ok(hiddenShape.polygon.length >= 3, '隐藏 zone 必须有真实几何才算被过滤，而不是本来就没画');
  assert.equal(hiddenShape.name, SECRET_ZONE_NAME);

  // 作者视图：完整，不做任何裁剪。
  const author = Kit.filterSceneForView(scene, { scope: SCOPE, visibleLocations: [], visibleCharacters: [], visibleItems: [] });
  assert.equal(author.ok, true, JSON.stringify(author.issues));
  assert.equal(author.scene.layout.shapes.length, 3);
  assert.equal(author.scene.layout.routes.length, 2);
  assert.equal(author.scene.layout.features.length, 3);
  assert.ok(JSON.stringify(author.scene).includes(SECRET_ZONE), '作者视图必须完整保留隐藏内容');

  // POV 视图：只承认两个公开地点。
  const pov = Kit.filterSceneForView(scene, {
    scope: POV, visibleLocations: [PUB_A, PUB_B], visibleCharacters: [], visibleItems: [],
  });
  assert.equal(pov.ok, true, JSON.stringify(pov.issues));
  const s = pov.scene.layout;

  // 1) 隐藏 zone 的 ID / 名称 / 几何 / 标点全部消失。
  assert.deepEqual(s.shapes.map((x) => x.id).sort(), [PUB_A, PUB_B]);
  assert.deepEqual(s.pins.map((x) => x.id).sort(), [PUB_A, PUB_B]);
  assert.ok(!s.shapes.some((x) => JSON.stringify(x).includes(SECRET_ZONE_NAME)), '隐藏 zone 的名称不得出现');

  // 2) 指向隐藏端点的 route 整条剔除；公开 route 仍在，并保留端点引用。
  assert.deepEqual(s.routes.map((r) => r.id), ['R_VISIBLE']);
  assert.equal(s.routes[0].fromLocationId, PUB_A);
  assert.equal(s.routes[0].toLocationId, PUB_B);

  // 3) 挂隐藏 zone 的 feature 剔除；全图公开材质保留但不得暗示隐藏命名地点。
  assert.deepEqual(s.features.map((f) => f.id).sort(), ['F_FULLMAP', 'F_PUBLIC_FOREST']);
  const fullMap = s.features.find((f) => f.id === 'F_FULLMAP');
  assert.equal(fullMap.zoneId, undefined, '全图公开材质不带 zone 身份');
  assert.equal(fullMap.name, undefined, '全图公开材质没有名字，不暗示任何命名地点');

  // 4) 整份 POV 文档无泄漏（连内部结构键、锁、placement 都不能带出去）。
  assertNoSecretLeak(pov.scene, SECRET_ZONE, SECRET_ZONE_NAME, SECRET_ROUTE, SECRET_FEATURE);
  assert.ok(!JSON.stringify(pov.scene).includes('structureKey'), '内部结构签名不得下发 POV');
  assert.ok(!JSON.stringify(pov.scene).includes('placement'));

  // 5) 关卡完整性：POV 文档本身仍是合法场景。
  assert.deepEqual(Kit.checkSceneDocument(pov.scene), []);
});

test('G10：可见集合为空时 POV 只剩全图公开材质，一条 route 都不下发', () => {
  const scene = generate(overviewSpec(), context()).scene;
  const pov = Kit.filterSceneForView(scene, { scope: POV, visibleLocations: [], visibleCharacters: [], visibleItems: [] });
  assert.equal(pov.ok, true, JSON.stringify(pov.issues));
  assert.deepEqual(pov.scene.layout.shapes, []);
  assert.deepEqual(pov.scene.layout.pins, []);
  assert.deepEqual(pov.scene.layout.routes, []);
  assert.deepEqual(pov.scene.layout.features.map((f) => f.id), ['F_FULLMAP']);
  assertNoSecretLeak(pov.scene, SECRET_ZONE, SECRET_ZONE_NAME, SECRET_ROUTE, SECRET_FEATURE);
  assert.deepEqual(Kit.checkSceneDocument(pov.scene), []);
});

// ───────────────────────── G10 · 投影层：隐藏点与标记隐藏的路线 ─────────────────────────

function viewResult(over = {}) {
  return {
    branchId: BRANCH,
    revision: SCOPE.revision,
    metadata: { stale: false },
    items: [{
      mapId: MAP_ID, name: '总图', metersPerCell: null, surface: 'mixed', scaleQuality: 'uncalibrated',
      frames: { frame: { cols: 100, rows: 80 } },
      points: [
        { entityId: PUB_A, kind: 'location', name: '公开广场', x: 10, y: 10, precision: 'layout', markerQuality: 'layout' },
        { entityId: PUB_B, kind: 'location', name: '公开集市', x: 20, y: 20, precision: 'layout', markerQuality: 'layout' },
        { entityId: SECRET_ZONE, kind: 'location', name: SECRET_ZONE_NAME, x: 50, y: 50, precision: 'layout', markerQuality: 'layout', hidden: true },
        { entityId: 'C_POV', kind: 'character', name: '星', x: 12, y: 12, precision: 'layout', markerQuality: 'layout' },
      ],
      routes: [
        { routeId: 'R_VISIBLE', mapId: MAP_ID, geometry: { kind: 'line', coordinates: [[10, 10], [20, 20]] }, geometryQuality: 'estimated', fromLocationId: PUB_A, toLocationId: PUB_B },
        { routeId: SECRET_ROUTE, mapId: MAP_ID, geometry: { kind: 'line', coordinates: [[10, 10], [50, 50]] }, geometryQuality: 'estimated', fromLocationId: PUB_A, toLocationId: SECRET_ZONE },
        { routeId: 'R_MARKED_HIDDEN', mapId: MAP_ID, geometry: { kind: 'line', coordinates: [[1, 1], [2, 2]] }, geometryQuality: 'confirmed', hidden: true },
      ],
      coarseList: [
        { entityId: PUB_A, name: '公开广场', locationId: null },
        { entityId: SECRET_ZONE, name: SECRET_ZONE_NAME, locationId: 'L_PARENT', hidden: true },
      ],
    }],
    ...over,
  };
}

test('G10：投影层就挡住隐藏点与隐藏路线；作者粗地点名单保留，POV 名单剔除隐藏项', () => {
  const projected = Kit.projectMapView({ view: viewResult(), mapId: MAP_ID, scope: POV });
  assert.equal(projected.ok, true, JSON.stringify(projected.issues));
  assert.equal(projected.status, 'ready');

  // 投影层：hidden 点根本不进场景。
  assert.deepEqual(projected.scene.layout.pins.map((p) => p.id).sort(), ['C_POV', PUB_A, PUB_B]);
  // 粗地点名单：隐藏项被剔除。
  assert.deepEqual(projected.coarseList.map((c) => c.entityId), [PUB_A]);

  const authorProjected = Kit.projectMapView({ view: viewResult(), mapId: MAP_ID, scope: SCOPE });
  assert.equal(authorProjected.ok, true);
  assert.equal(authorProjected.scene.layout.pins.length, 4, '作者视角隐藏点也要出现');
  assert.deepEqual(authorProjected.coarseList.map((c) => c.entityId).sort(), [PUB_A, SECRET_ZONE].sort());

  // 再走一遍显示层过滤：端点引用 + 显式 hidden 标记双重把关。
  const pov = Kit.filterSceneForView(projected.scene, {
    scope: POV, visibleLocations: [PUB_A, PUB_B], visibleCharacters: ['C_POV'], visibleItems: [],
  });
  assert.equal(pov.ok, true, JSON.stringify(pov.issues));
  assert.deepEqual(pov.scene.layout.routes.map((r) => r.id), ['R_VISIBLE']);
  assertNoSecretLeak(pov.scene, SECRET_ZONE, SECRET_ZONE_NAME, SECRET_ROUTE, 'R_MARKED_HIDDEN');
  assert.deepEqual(Kit.checkSceneDocument(pov.scene), []);

  // 作者视角：三条路线（含显式隐藏的那条）全在；标点仍是投影层剩下的三个（隐藏点已在投影层被拦）。
  const author = Kit.filterSceneForView(projected.scene, { scope: SCOPE });
  assert.equal(author.ok, true);
  assert.equal(author.scene.layout.routes.length, 3);
  assert.equal(author.scene.layout.pins.length, 3);
});

test('G10：投影层复用旧视图会被拒绝，损坏场景不得进入显示层', () => {
  const stale = Kit.projectMapView({ view: viewResult({ revision: SCOPE.revision + 1 }), mapId: MAP_ID, scope: POV });
  assert.equal(stale.ok, false);
  assert.ok(stale.issues.some((i) => i.code === 'VIEW_STALE'), JSON.stringify(stale.issues));

  const markedStale = Kit.projectMapView({ view: viewResult({ metadata: { stale: true } }), mapId: MAP_ID, scope: POV });
  assert.equal(markedStale.ok, false);
  assert.ok(markedStale.issues.some((i) => i.code === 'VIEW_STALE'));

  const scene = generate(overviewSpec(), context()).scene;
  const broken = Kit.clone(scene);
  broken.layout.bounds = { x: 0, y: 0, w: Number.NaN, h: 80 };
  const rejected = Kit.filterSceneForView(broken, { scope: POV, visibleLocations: [PUB_A] });
  assert.equal(rejected.ok, false, '损坏几何不能进入显示层');
  assert.equal(rejected.scene, null);
  assert.ok(rejected.issues.length > 0);

  const wrongBranch = Kit.filterSceneForView(scene, { scope: { ...POV, branchId: 'other' } });
  assert.equal(wrongBranch.ok, false);
  assert.ok(wrongBranch.issues.some((i) => i.code === 'SCENE_SCOPE_MISMATCH'));
});

// ───────────────── 非法一项仍保合法项 · 预算 · 作用域 · 旧 floor 兼容 ─────────────────

test('概览：feature 非法/挂错 zone 只跳该项，其余图元照常生成并保持可过滤', () => {
  const spec = overviewSpec();
  spec.features = [
    ...spec.features,
    { id: 'F_BAD_TYPE', type: 'spaceship', density: 'low' },
    { id: 'F_ORPHAN', type: 'forest_texture', zoneId: 'ZONE_NOT_IN_THIS_MAP', density: 'low' },
    { id: 'F_BAD_DENSITY', type: 'forest_texture', zoneId: PUB_A, density: 'insane' },
  ];
  const result = generate(spec, context());
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.ok(issueFor(result.issues, 'FEATURE_TYPE_UNSUPPORTED', 'F_BAD_TYPE'), JSON.stringify(result.issues));
  assert.ok(issueFor(result.issues, 'FEATURE_DENSITY_UNSUPPORTED', 'F_BAD_DENSITY'), JSON.stringify(result.issues));
  assert.ok(result.issues.some((i) => i.code === 'FEATURE_ZONE_UNKNOWN'), JSON.stringify(result.issues));
  assert.equal(result.status, 'partial');
  const ids = result.scene.layout.features.map((f) => f.id);
  assert.ok(ids.includes('F_PUBLIC_FOREST') && ids.includes('F_FULLMAP') && ids.includes(SECRET_FEATURE), JSON.stringify(ids));
  assert.ok(!ids.includes('F_BAD_TYPE') && !ids.includes('F_ORPHAN') && !ids.includes('F_BAD_DENSITY'));
  assert.deepEqual(Kit.checkSceneDocument(result.scene), []);

  const pov = Kit.filterSceneForView(result.scene, { scope: POV, visibleLocations: [PUB_A, PUB_B] });
  assert.equal(pov.ok, true);
  assertNoSecretLeak(pov.scene, SECRET_ZONE, SECRET_ZONE_NAME, SECRET_ROUTE, SECRET_FEATURE);
});

test('概览：作用域过期立即失败；集合超预算明确失败且保留旧场景', () => {
  const stale = Kit.generateOverview(overviewSpec(), { ...context(), currentScope: { ...SCOPE, revision: 99 } });
  assert.equal(stale.ok, false);
  assert.equal(stale.scene, null);
  assert.ok(stale.issues.some((i) => i.code === 'STALE_SCOPE'), JSON.stringify(stale.issues));

  const good = generate(overviewSpec(), context());
  assert.equal(good.ok, true);
  const features = Array.from({ length: Kit.LIMITS.features + 1 }, (_, i) => ({ id: `F_${i}`, type: 'forest_texture', zoneId: PUB_A }));
  const over = Kit.generateOverview(overviewSpec({ features }), { ...context(), previousScene: good.scene });
  assert.equal(over.ok, false);
  assert.ok(over.issues.some((i) => i.code.includes('COLLECTION_LIMIT')), JSON.stringify(over.issues));
  assert.ok(over.kept, '超预算失败必须保留已保存场景');
  assert.deepEqual(over.kept.layout.shapes, good.scene.layout.shapes);
});

test('旧 floor 场景的 POV 过滤：隐藏房间的家具/人物/物品一并消失，作者视图完整', () => {
  const R_A = 'L_ROOM_A';
  const R_B = 'L_ROOM_B';
  const C_A = 'C_A';
  const C_B = 'C_B';
  const I_A = 'I_A';
  const BRANCH_ID = 'b1';
  const floorCtx = {
    scope: SCOPE, currentScope: SCOPE,
    map: { id: 'M_HOUSE', name: '屋子', containerLocationId: 'L_HOUSE', metersPerCell: 1, frame: { cols: 20, rows: 16 }, scaleQuality: 'exact', scaleLocked: false },
    entities: { locations: [R_A, R_B], characters: [C_A, C_B], items: [I_A], routes: [] },
    locks: {}, placement: {}, locationsById: {}, routesById: {},
  };
  const floor = Kit.generateFloor({
    rooms: [
      { id: R_A, name: '公开房间', side: 'south', w: 6, h: 5 },
      { id: R_B, name: '隐藏房间', side: 'north', w: 6, h: 5 },
    ],
    corridorWidth: 2,
    contents: [
      { id: 'F_TABLE_A', roomId: R_A, type: 'table', w: 2, h: 1 },
      { id: 'F_TABLE_B', roomId: R_B, type: 'table', w: 2, h: 1 },
    ],
    actors: [{ id: C_A, roomId: R_A }, { id: C_B, roomId: R_B }],
    items: [{ id: I_A, on: 'F_TABLE_A' }],
  }, floorCtx);
  assert.equal(floor.ok, true, JSON.stringify(floor.issues));
  assert.equal(floor.scene.branchId, BRANCH_ID);
  assert.equal(floor.scene.layout.rooms.length, 2);

  const author = Kit.filterSceneForView(floor.scene, { scope: SCOPE });
  assert.equal(author.ok, true);
  assert.equal(author.scene.layout.rooms.length, 2);
  assert.equal(author.scene.layout.actors.length, 2);
  assert.equal(author.scene.layout.items.length, 1);

  const pov = Kit.filterSceneForView(floor.scene, {
    scope: POV, visibleLocations: [R_A], visibleCharacters: [C_A], visibleItems: [I_A],
  });
  assert.equal(pov.ok, true, JSON.stringify(pov.issues));
  const s = pov.scene.layout;
  assert.deepEqual(s.rooms.map((r) => r.id), [R_A]);
  for (const key of ['groups', 'bodies', 'doors', 'windows', 'lamps', 'doorSwings']) {
    assert.ok(s[key].every((p) => p.roomId === R_A), `${key} 里混进了隐藏房间的东西`);
  }
  assert.deepEqual(s.actors.map((a) => a.id), [C_A]);
  assert.deepEqual(s.items.map((i) => i.id), [I_A]);
  assert.deepEqual(s.path, [], 'POV 不下发房间间路径');
  assert.ok(!JSON.stringify(pov.scene).includes(R_B), '隐藏房间 ID 不得出现');
  assert.ok(!JSON.stringify(pov.scene).includes('隐藏房间'), '隐藏房间名称不得出现');
  assert.ok(!JSON.stringify(pov.scene).includes(C_B));
  assert.deepEqual(Kit.checkSceneDocument(pov.scene), []);
});

function issueFor(issues, code, entityId) {
  return issues.find((i) => i.code === code && i.entityId === entityId);
}
