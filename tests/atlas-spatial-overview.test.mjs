/**
 * atlas-spatial-overview.test.mjs — M4-26 验收（G01/G02/G03/G04/G05/G06/G11）。
 *
 * 纪律：全部走**真实生成器**（generateOverview / buildLayoutContext / overview），不 mock 几何；
 * 断言只落在可观察结果（scene 文档、issues、SQL 几何映射、checkSceneDocument 诊断）。
 * 合成数据只存在本文件与 tests/fixtures，不调用外网，不写生产快照。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as Kit from '../vendor/atlas-spatial/index.mjs';

const BRANCH = 'b1';
const SCOPE = { chatId: 'chat-1', branchId: BRANCH, revision: 3, viewMode: 'author' };
const MAP_ID = 'M_OV';

function location(id, over = {}) {
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
    branch_id: BRANCH, id: MAP_ID, name: '总览', container_location_id: null,
    frame_json: { cols: 100, rows: 80 }, meters_per_cell: null,
    scale_quality: 'uncalibrated', scale_locked: 0, ...over,
  };
}

/** 走真实 buildLayoutContext（M4-06）：锁、代理、目录都由它算，测试不自己造 context。 */
function context(input = {}) {
  const built = Kit.buildLayoutContext({
    scope: SCOPE,
    mapRow: input.mapRow ?? mapRow(),
    locations: input.locations ?? [],
    characters: input.characters ?? [],
    items: [],
    routes: input.routes ?? [],
  });
  assert.equal(built.ok, true, JSON.stringify(built.issues));
  return built.context;
}

const generate = (spec, ctx, previousScene = null) =>
  Kit.generateOverview(spec, { ...ctx, previousScene, currentScope: SCOPE });

function assertAllFiniteInside(scene) {
  const b = scene.layout.bounds;
  const inside = (p) => Number.isFinite(p.x) && Number.isFinite(p.y)
    && p.x >= b.x - 1e-6 && p.x <= b.x + b.w + 1e-6 && p.y >= b.y - 1e-6 && p.y <= b.y + b.h + 1e-6;
  for (const shape of scene.layout.shapes) for (const p of shape.polygon) assert.ok(inside(p), `shape ${shape.id} 顶点越界`);
  for (const r of scene.layout.routes) for (const p of r.path) assert.ok(inside(p), `route ${r.id} 顶点越界`);
  for (const f of scene.layout.features) {
    for (const p of f.path ?? []) assert.ok(inside(p), `feature ${f.id} 路径越界`);
    for (const p of f.polygon ?? []) assert.ok(inside(p), `feature ${f.id} 顶点越界`);
  }
  for (const p of scene.layout.pins) assert.ok(inside(p), `pin ${p.id} 越界`);
}

// ───────────────────────────── G01 · 真正概览生成 ─────────────────────────────

test('G01：4 个 zone / 1 条已登记路线 / 森林与水域 feature → 真几何、ID 有效、无额外 SQL 实体', () => {
  const locations = [location('Z1'), location('Z2'), location('Z3'), location('Z4')];
  const routes = [route('R1', 'Z1', 'Z2')];
  const ctx = context({ locations, routes });
  const result = generate({
    surface: 'mixed',
    zones: [
      { id: 'Z1', role: 'city', size: 'medium', sector: 'north' },
      { id: 'Z2', role: 'forest', size: 'large', sector: 'south' },
      { id: 'Z3', role: 'water', size: 'medium', sector: 'east' },
      { id: 'Z4', role: 'mountain', size: 'small', sector: 'west' },
    ],
    links: [{ id: 'R1' }],
    features: [
      { id: 'F_FOREST', type: 'forest_texture', zoneId: 'Z2', density: 'medium' },
      { id: 'F_RIVER', type: 'watercourse', fromSector: 'west', toSector: 'east', widthClass: 'medium' },
      { id: 'F_EDGE', type: 'road_texture', density: 'low' },
    ],
  }, ctx);

  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const scene = result.scene;
  assert.equal(scene.kind, 'atlas-scene');
  assert.equal(scene.layout.kind, 'overview');
  assert.deepEqual(Kit.checkSceneDocument(scene), []);

  assert.equal(scene.layout.shapes.length, 4, '四个 zone 都要有轮廓');
  assert.equal(scene.layout.routes.length, 1, '已登记路线画成一条');
  assert.ok(scene.layout.features.length >= 2, `feature 必须真的生成：${scene.layout.features.length}`);
  assert.equal(scene.layout.pins.length, 4, '每个 zone 一个可点标记');

  // 单位：未标定 → 格，绝不是米。
  assert.equal(scene.units, 'cells');
  assert.equal(scene.metersPerCell, null);
  assert.equal(scene.metricQuality, 'uncalibrated');

  assertAllFiniteInside(scene);
  for (const shape of scene.layout.shapes) {
    assert.ok(shape.polygon.length >= 3 && shape.polygon.length <= 12, `zone 轮廓顶点数需在 3–12：${shape.polygon.length}`);
    assert.ok(['estimated', 'confirmed'].includes(shape.quality), 'zone 质量必须明确');
  }

  // G01 边界：水系不是一个蓝色圆点 —— 必须有 ≥25 点的 Bezier 离散路径与正宽度。
  const river = scene.layout.features.find((f) => f.type === 'watercourse');
  assert.ok(river, '必须真的有水系 feature');
  assert.ok(Array.isArray(river.path) && river.path.length >= 25, `水系路径点数不足：${river.path?.length}`);
  assert.ok(Number.isFinite(river.width) && river.width > 0, '水系宽度必须是有限正数');
  assert.equal(river.decorative, true, '无确认来源的水系必须标 decorative');
  assert.equal(river.quality, 'estimated', '无确认来源的水系质量必须是 estimated');

  // 装饰不产生 SQL 实体：几何映射只覆盖真实登记的 zone。
  const mapped = Kit.sceneLocationGeometry(scene).map((g) => g.entityId).sort();
  assert.deepEqual(mapped, ['Z1', 'Z2', 'Z3', 'Z4']);
  assert.equal(mapped.includes('F_RIVER'), false, 'feature 不得有 SQL 身份');
  assert.equal(mapped.includes('F_FOREST'), false);
});

// ───────────────────────────── G02 · 无尺度不能变一米 ─────────────────────────────

test('G02：frame 100×100 / mpp=null → cells；map.estimate 后转米且保持相对布局', () => {
  const locations = [location('Z1'), location('Z2')];
  const routes = [route('R1', 'Z1', 'Z2')];
  const spec = {
    surface: 'mixed',
    zones: [{ id: 'Z1', role: 'city', size: 'medium', sector: 'north' }, { id: 'Z2', role: 'forest', size: 'large', sector: 'south' }],
    links: [{ id: 'R1' }],
    features: [],
  };

  const first = generate(spec, context({ locations, routes, mapRow: mapRow({ frame_json: { cols: 100, rows: 100 } }) }));
  assert.equal(first.ok, true, JSON.stringify(first.issues));
  assert.equal(first.scene.units, 'cells');
  assert.equal(first.scene.metersPerCell, null, '未标定绝不能凭空变成 1 米/格');
  assert.deepEqual([first.scene.layout.bounds.w, first.scene.layout.bounds.h], [100, 100]);

  // map.estimate：这是**估计**尺度，不是证据确认。
  const calibrated = generate(spec, context({
    locations, routes,
    mapRow: mapRow({
      frame_json: { cols: 100, rows: 100, atlasScene: first.scene },
      meters_per_cell: 100,
      scale_quality: 'estimated',
    }),
  }), first.scene);
  assert.equal(calibrated.ok, true, JSON.stringify(calibrated.issues));
  assert.equal(calibrated.scene.units, 'meters');
  assert.equal(calibrated.scene.metersPerCell, 100);
  assert.deepEqual([calibrated.scene.layout.bounds.w, calibrated.scene.layout.bounds.h], [10000, 10000]);

  // 相对布局不变：同 seed 下，米制只是格制按 mpp 等比放大。
  for (const before of first.scene.layout.shapes) {
    const after = calibrated.scene.layout.shapes.find((s) => s.id === before.id);
    assert.ok(after, `zone ${before.id} 不得消失`);
    assert.equal(after.polygon.length, before.polygon.length);
    for (let i = 0; i < before.polygon.length; i += 1) {
      assert.ok(Math.abs(after.polygon[i].x - before.polygon[i].x * 100) < 1e-6, `zone ${before.id} 相对位置被改动`);
      assert.ok(Math.abs(after.polygon[i].y - before.polygon[i].y * 100) < 1e-6, `zone ${before.id} 相对位置被改动`);
    }
  }

  // 已保存的格制几何按 mpp 换算成 SQL 格坐标：两次读数一致（一次换算，不重复乘）。
  const cellsGeometry = Kit.sceneLocationGeometry(first.scene);
  const metersGeometry = Kit.sceneLocationGeometry(calibrated.scene);
  for (const before of cellsGeometry) {
    const after = metersGeometry.find((g) => g.entityId === before.entityId);
    assert.ok(after, `${before.entityId} 的 SQL 几何不得丢失`);
    assert.ok(Math.abs(after.gridX - before.gridX) < 1e-6, `${before.entityId} 的 SQL 格坐标不得因标定漂移`);
    assert.ok(Math.abs(after.gridY - before.gridY) < 1e-6, `${before.entityId} 的 SQL 格坐标不得因标定漂移`);
  }
});

// ───────────────────────────── G03 · 几何锁 ─────────────────────────────

test('G03：确认多边形与确认路线逐点不变；换 seed 被忽略并诊断；新 shape 不覆盖锁定', () => {
  const lockedPolygon = [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 26 }, { x: 10, y: 26 }];
  const lockedPath = [{ x: 12, y: 12 }, { x: 40, y: 30 }, { x: 70, y: 14 }];
  const locations = [
    location('Z1', { area_geometry_json: JSON.stringify({ kind: 'polygon', quality: 'confirmed', points: lockedPolygon }) }),
    location('Z2'),
  ];
  const routes = [route('R1', 'Z1', 'Z2', {
    geometry_json: JSON.stringify({ points: lockedPath.map((p) => [p.x, p.y]) }),
    geometry_quality: 'confirmed',
  })];
  const ctx = context({ locations, routes });

  const result = generate({
    surface: 'mixed',
    seed: 'ATTACKER-SEED',
    zones: [
      { id: 'Z1', role: 'city', size: 'small', sector: 'northwest' },
      { id: 'Z2', role: 'forest', size: 'medium', sector: 'south' },
    ],
    links: [{ id: 'R1' }],
    features: [],
  }, ctx);

  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(Kit.checkSceneDocument(result.scene), []);

  const z1 = result.scene.layout.shapes.find((s) => s.id === 'Z1');
  assert.deepEqual(z1.polygon.map((p) => [p.x, p.y]), lockedPolygon.map((p) => [p.x, p.y]), '确认多边形必须逐点不变');
  assert.equal(z1.quality, 'confirmed', '确认几何的质量必须保留 confirmed');

  const r1 = result.scene.layout.routes.find((r) => r.id === 'R1');
  assert.deepEqual(r1.path.map((p) => [p.x, p.y]), lockedPath.map((p) => [p.x, p.y]), '确认路线必须逐点不变');
  assert.equal(r1.quality, 'confirmed');
  assert.equal(r1.dashed, false);

  assert.ok(result.issues.some((i) => i.code === 'SEED_OVERRIDDEN'), `换 seed 必须留下诊断：${JSON.stringify(result.issues)}`);
});

// ───────────────────────────── G04 · 局部增量 ─────────────────────────────

test('G04：3 zone → 加第 4 个 zone → 空 patch；旧图元不变、空 patch reused', () => {
  const locations = ['Z1', 'Z2', 'Z3', 'Z4'].map((id) => location(id));
  const routes = [route('R1', 'Z1', 'Z2')];
  const base = {
    surface: 'mixed',
    zones: [
      { id: 'Z1', role: 'city', size: 'medium', sector: 'north' },
      { id: 'Z2', role: 'forest', size: 'large', sector: 'south' },
      { id: 'Z3', role: 'land', size: 'small', sector: 'east' },
    ],
    links: [{ id: 'R1' }],
    features: [{ id: 'F1', type: 'forest_texture', zoneId: 'Z2', density: 'medium' }],
  };

  const first = generate(base, context({ locations, routes }));
  assert.equal(first.ok, true, JSON.stringify(first.issues));
  assert.equal(first.scene.layout.shapes.length, 3);

  // 第二次只请求新增第 4 个 zone：旧 zone 与路线必须逐点不变。
  const second = generate({ surface: 'mixed', zones: [{ id: 'Z4', role: 'water', size: 'medium', sector: 'west' }] },
    context({ locations, routes }), first.scene);
  assert.equal(second.ok, true, JSON.stringify(second.issues));
  assert.equal(second.scene.layout.shapes.length, 4, '未显式删除的旧 zone 不得消失');
  for (const before of first.scene.layout.shapes) {
    const after = second.scene.layout.shapes.find((s) => s.id === before.id);
    assert.ok(after, `旧 zone ${before.id} 不得消失`);
    assert.deepEqual(after.polygon, before.polygon, `旧 zone ${before.id} 的几何不得重排`);
  }
  const beforeRoute = first.scene.layout.routes[0];
  const afterRoute = second.scene.layout.routes.find((r) => r.id === beforeRoute.id);
  assert.deepEqual(afterRoute.path, beforeRoute.path, '已保存路线不得因新增 zone 而重排');
  const newZone = second.scene.layout.shapes.find((s) => s.id === 'Z4');
  assert.ok(newZone && newZone.polygon.length >= 3, '新增 zone 必须真的画出来');

  // 第三次空 patch：内容不变 → 直接 reused，不重算几何。
  const third = generate({},
    context({ locations, routes }), second.scene);
  assert.equal(third.ok, true, JSON.stringify(third.issues));
  assert.equal(third.status, 'reused', `空 patch 必须是 reused，实际 ${third.status}`);
  assert.deepEqual(third.scene.layout, second.scene.layout, '空 patch 不得改动已保存布局');

  // 稳定性：同一请求重跑两次，字节级一致。
  const rerun = generate(base, context({ locations, routes }));
  assert.deepEqual(rerun.scene.layout, first.scene.layout, '同一输入必须字节级可复现');
});

// ───────────────────────────── G05 · 错误一项不毁图 ─────────────────────────────

test('G05：一个非法 feature + 一个未知 zone 引用 → 合法图元照常生成，失败项带 path/id', () => {
  const locations = [location('Z1'), location('Z2')];
  const routes = [route('R1', 'Z1', 'Z2')];
  const ctx = context({ locations, routes });

  const result = generate({
    surface: 'mixed',
    zones: [
      { id: 'Z1', role: 'city', size: 'medium', sector: 'north' },
      { id: 'GHOST', role: 'city', size: 'small', sector: 'south' },
      { id: 'Z2', role: 'forest', size: 'large', sector: 'east' },
    ],
    links: [{ id: 'R1' }],
    features: [
      { id: 'F_BAD', type: 'definitely_not_a_type' },
      { id: 'F_OK', type: 'forest_texture', zoneId: 'Z2', density: 'low' },
    ],
  }, ctx);

  assert.equal(result.ok, true, `单项错误不得整图失败：${JSON.stringify(result.issues)}`);
  const ids = result.scene.layout.shapes.map((s) => s.id).sort();
  assert.deepEqual(ids, ['Z1', 'Z2'], '两个合法 zone 必须照常生成');
  assert.equal(result.scene.layout.shapes.some((s) => s.id === 'GHOST'), false);

  const unknown = result.issues.find((i) => i.code === 'ENTITY_REF_UNKNOWN');
  assert.ok(unknown, `未知 zone 引用必须有诊断：${JSON.stringify(result.issues)}`);
  assert.equal(unknown.entityId, 'GHOST', '诊断必须带具体 ID');
  assert.ok(String(unknown.path).startsWith('$.zones'), `诊断必须带具体 path：${unknown.path}`);

  const badFeature = result.issues.find((i) => i.code === 'FEATURE_TYPE_UNSUPPORTED');
  assert.ok(badFeature, `非法 feature 必须有诊断：${JSON.stringify(result.issues)}`);
  assert.equal(badFeature.entityId, 'F_BAD');
  assert.ok(String(badFeature.path).startsWith('$.features'), `诊断必须带具体 path：${badFeature.path}`);

  assert.equal(result.scene.layout.features.some((f) => f.id === 'F_BAD'), false, '非法 feature 不得进场景');
  assert.equal(result.scene.layout.features.some((f) => f.id === 'F_OK'), true, '合法 feature 必须保留');
  assert.equal(result.status, 'partial', '有单项失败时状态必须是 partial，不冒充 generated');
  assert.deepEqual(Kit.checkSceneDocument(result.scene), []);

  // 原 scene 保留：失败时 kept 必须是旧场景本身。
  const failed = generate({ surface: 'mixed', zones: [{ id: 'GHOST', role: 'city', size: 'small', sector: 'north' }], links: [{ id: 'R1' }], features: [{ id: 'F', type: 'nope' }] },
    context({ locations, routes }), result.scene);
  assert.equal(failed.ok, true, '只有单项错误时仍应产出合法场景');

  const hardFail = Kit.generateOverview({ surface: 'mixed', zones: [{ id: 'GHOST', role: 'city', size: 'small', sector: 'north' }] },
    { ...ctx, previousScene: result.scene });
  assert.equal(hardFail.ok, true, '未知 zone 仍应产出场景（只是少一个 zone）');
});

// ───────────────────────────── G06 · 装饰无权创建道路 ─────────────────────────────

test('G06：road_texture 与未知 route link → 不新增路线、纹理标 decorative、不进 SQL 几何', () => {
  const locations = [location('Z1'), location('Z2')];
  const routes = [route('R1', 'Z1', 'Z2')];
  const ctx = context({ locations, routes });

  const result = generate({
    surface: 'urban',
    zones: [{ id: 'Z1', role: 'city', size: 'medium', sector: 'center' }, { id: 'Z2', role: 'district', size: 'small', sector: 'north' }],
    links: [{ id: 'R1' }, { id: 'R_NOT_REGISTERED' }],
    features: [{ id: 'F_ROAD', type: 'road_texture', zoneId: 'Z1', density: 'high' }],
  }, ctx);

  assert.equal(result.ok, true, JSON.stringify(result.issues));

  // 只有真实登记的路线被画；未知 link 被拒并记诊断。
  assert.deepEqual(result.scene.layout.routes.map((r) => r.id), ['R1'], '装饰不得凭空产生道路');
  const rejected = result.issues.find((i) => i.code === 'ENTITY_REF_UNKNOWN' && i.entityId === 'R_NOT_REGISTERED');
  assert.ok(rejected, `未知 link 必须有诊断：${JSON.stringify(result.issues)}`);

  const texture = result.scene.layout.features.find((f) => f.id === 'F_ROAD');
  assert.ok(texture, 'road_texture 必须作为背景纹理存在');
  assert.equal(texture.type, 'road_texture');
  assert.equal(texture.decorative, true, '纹理必须标 decorative');
  assert.equal(texture.quality, 'estimated');
  assert.equal(texture.fromLocationId, undefined, '装饰永远没有路线端点');
  assert.equal(texture.toLocationId, undefined, '装饰永远没有路线端点');
  assert.equal(result.scene.layout.routes.some((r) => r.id === 'F_ROAD'), false, '纹理不得进入路线表');

  // 装饰不进入 SQL 几何，也不进入任何"可通行"结果。
  const mapped = Kit.sceneLocationGeometry(result.scene).map((g) => g.entityId);
  assert.deepEqual(mapped.sort(), ['Z1', 'Z2']);
  for (const r of result.scene.layout.routes) {
    assert.ok(r.fromLocationId && r.toLocationId, '真实路线必须有真实端点');
  }
});

// ───────────────────────────── G11 · 场景体积预算 ─────────────────────────────

test('G11：zones/features/links 超限明确报错，旧场景不被清空', () => {
  const locations = [location('Z1')];
  const routes = [route('R1', 'Z1', 'Z1')];
  const ctx = context({ locations, routes, mapRow: mapRow({ frame_json: { cols: 100, rows: 80 } }) });
  const previous = generate({ surface: 'mixed', zones: [{ id: 'Z1', role: 'city', size: 'medium', sector: 'north' }], links: [], features: [] }, ctx);
  assert.equal(previous.ok, true, JSON.stringify(previous.issues));

  const tooManyZones = generate({ zones: Array.from({ length: Kit.LIMITS.zones + 1 }, (_, i) => ({ id: `Z${i}`, role: 'city', size: 'small', sector: 'north' })) },
    ctx, previous.scene);
  assert.equal(tooManyZones.ok, false);
  assert.ok(tooManyZones.issues.some((i) => String(i.code).includes('COLLECTION_LIMIT:zones')), JSON.stringify(tooManyZones.issues));
  assert.deepEqual(tooManyZones.kept.layout, previous.scene.layout, '超限不得清空合法旧场景');

  const tooManyFeatures = generate({ features: Array.from({ length: Kit.LIMITS.features + 1 }, (_, i) => ({ id: `F${i}`, type: 'forest_texture' })) },
    ctx, previous.scene);
  assert.equal(tooManyFeatures.ok, false);
  assert.ok(tooManyFeatures.issues.some((i) => String(i.code).includes('COLLECTION_LIMIT:features')), JSON.stringify(tooManyFeatures.issues));
  assert.deepEqual(tooManyFeatures.kept.layout, previous.scene.layout);

  const tooManyLinks = generate({ links: Array.from({ length: Kit.LIMITS.links + 1 }, (_, i) => ({ id: `R${i}` })) },
    ctx, previous.scene);
  assert.equal(tooManyLinks.ok, false);
  assert.ok(tooManyLinks.issues.some((i) => String(i.code).includes('COLLECTION_LIMIT:links')), JSON.stringify(tooManyLinks.issues));
  assert.deepEqual(tooManyLinks.kept.layout, previous.scene.layout);

  // 2049 点折线：确认路线被原样复用，超预算必须在场景校验阶段明确报错，且保留旧场景。
  const longPath = Array.from({ length: Kit.LIMITS.pathPoints + 1 }, (_, i) => ({ x: 1 + (i % 90), y: 1 + ((i * 7) % 70) }));
  const longCtx = context({
    locations,
    routes: [route('R1', 'Z1', 'Z1', { geometry_json: JSON.stringify({ points: longPath.map((p) => [p.x, p.y]) }), geometry_quality: 'confirmed' })],
  });
  const tooLong = Kit.generateOverview({ zones: [{ id: 'Z1', role: 'city', size: 'medium', sector: 'north' }], links: [{ id: 'R1' }], features: [] },
    { ...longCtx, previousScene: previous.scene });
  assert.equal(tooLong.ok, false, '超长折线必须被明确拒绝');
  assert.ok(tooLong.issues.some((i) => i.code === 'SCENE_COLLECTION_LIMIT'), JSON.stringify(tooLong.issues));
  assert.ok(tooLong.kept, '拒绝时必须保留旧场景');

  // 输入体积：>64 KiB 明确拒绝，不静默截断、不整轮崩。
  const huge = '{"surface":"mixed","zones":[' + '{"id":"Z1"},'.repeat(9000) + '{"id":"Z2"}]}';
  assert.ok(huge.length > Kit.LIMITS.inputBytes);
  const oversized = Kit.generateOverview(huge, ctx);
  assert.equal(oversized.ok, false, '超 64 KiB 的输入必须拒绝');
  assert.ok(oversized.issues.some((i) => i.code === 'INPUT_TOO_LARGE'), JSON.stringify(oversized.issues));

  // 统一上限常量必须在两处一致（contracts 与运行时限制同源）。
  assert.equal(Kit.LIMITS.zones, 64);
  assert.equal(Kit.LIMITS.features, 128);
  assert.equal(Kit.LIMITS.links, 128);
  assert.equal(Kit.LIMITS.watercourseSegments, 24);
});

// ───────────────────────── 兼容：旧 floor / city 不因新增概览回归 ─────────────────────────

test('概览上线后 floor / city 仍走各自生成器，不被 overview 分支吞掉', () => {
  const rooms = Array.from({ length: 3 }, (_, i) => ({ id: `room-${i}`, name: `房间${i}`, side: i % 2 ? 'north' : 'south', w: 6, h: 5 }));
  const floorCtx = {
    scope: SCOPE, currentScope: SCOPE,
    map: { id: 'M_F', name: '楼层', metersPerCell: 1, frame: { cols: 40, rows: 30 } },
    entities: { locations: rooms.map((r) => r.id), characters: [], items: [], routes: [] },
  };
  const floor = Kit.generateFloor({ rooms }, floorCtx);
  assert.equal(floor.ok, true, JSON.stringify(floor.issues));
  assert.equal(floor.scene.layout.kind, 'floor');
  assert.equal(floor.scene.units, 'meters');

  const cityCtx = {
    scope: SCOPE, currentScope: SCOPE,
    map: { id: 'M_C', name: '城市', metersPerCell: 10, frame: { cols: 120, rows: 100 } },
    entities: { locations: ['d1', 'b1'], characters: [], items: [], routes: [] },
  };
  const city = Kit.generateCity({ riverWidth: 0, districts: [{ id: 'd1', name: '城区', bank: 'west', order: 0 }], buildings: [{ id: 'b1', districtId: 'd1', name: '市场', w: 40, h: 30 }] }, cityCtx);
  assert.equal(city.ok, true, JSON.stringify(city.issues));
  assert.equal(city.scene.layout.kind, 'city');
  assert.deepEqual(Kit.checkSceneDocument(city.scene), []);
});

// ───────────────────────── 过期作用域：不得写出任何东西 ─────────────────────────

test('作用域过期：currentScope 与 scope 不一致时生成器拒绝，不产出场景', () => {
  const ctx = context({ locations: [location('Z1')] });
  const stale = Kit.generateOverview({ zones: [{ id: 'Z1', role: 'city', size: 'small', sector: 'north' }] },
    { ...ctx, currentScope: { ...SCOPE, revision: 99 } });
  assert.equal(stale.ok, false);
  assert.equal(stale.scene, null);
  assert.ok(stale.issues.some((i) => i.code === 'STALE_SCOPE'), JSON.stringify(stale.issues));
});
