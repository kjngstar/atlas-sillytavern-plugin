/**
 * atlas-other-container.test.mjs — P06 / N01：合法 other 容器与空场地自身示意（OTH01–OTH05）。
 *
 * 缺陷（N01）：容器地点 kind=other（庭院 / 官道 / 停靠区）在 `classify` 里落在白名单之外，
 * 直接返回 null —— 这类空间**永远拿不到布局**，也不会有任何诊断，界面上就是「没反应」。
 * 即使让它出图，空场地（没有子地点）也会生成一张什么都没有的概览。
 *
 * 覆盖：
 * - OTH01 三类合法 other 容器，自动与显式手动都进入布局处理（不静默 null）；
 * - OTH02 空场地有 selfArea、scene 合法、无假子地点、无室内窗户；
 * - OTH03 一个沿线地点 + 可投影路线真实相连；缺端点有诊断；
 * - OTH04 SQL 地点数量不因自身示意增加；容器 map_id / 父链 / 锁不被改变；
 * - OTH05 隐藏容器的 selfArea / 名称 / 几何范围不进入 POV。
 *
 * 全程走真实路径：buildSqlLayoutTask（选图）+ buildLayoutContext + generateOverview（生成）+
 * checkSceneDocument（契约）+ sceneLocationGeometry（回写清单）+ filterSceneForView（POV）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, insertRows } from './fixtures/atlas-sql/seed.mjs';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { buildSqlLayoutTask } from '../src/atlas-sql-layout-task.ts';
import { buildLayoutContext } from '../vendor/atlas-spatial/host-context.mjs';
import { generateOverview } from '../vendor/atlas-spatial/generation.mjs';
import { checkSceneDocument } from '../vendor/atlas-spatial/contracts.mjs';
import { sceneLocationGeometry } from '../vendor/atlas-spatial/storage.mjs';
import { filterSceneForView } from '../vendor/atlas-spatial/view-adapter.mjs';

const SQL = await (await import('sql.js')).default();
const BRANCH = IDS.branchMain;
const TURN = IDS.seedTurn;

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

function addOtherMap(db, { mapId, containerId, name, kind = 'other', mpp = null, cols = 40, rows = 30, parent = null }) {
  insertRows(db, 'entity_keys', [{ branch_id: BRANCH, id: containerId, kind: 'location' }]);
  // 容器自身不在任何地图坐标系里：map_id 与 grid_* 必须同为 null（schema CHECK），
  // 精度只能是 unknown —— 它没有「位置」，只有一块由自己图来表达的范围。
  insertRows(db, 'locations', [{
    branch_id: BRANCH, id: containerId, row_rev: 1, created_turn_id: TURN, updated_turn_id: TURN,
    name, aliases_json: '[]', kind, description: '', parent_location_id: parent, mobility: 'fixed',
    anchor_location_id: null, map_id: null, grid_x: null, grid_y: null, coord_precision: 'unknown',
    uncertainty_radius_cells: null, area_geometry_json: null, terrain: 'unknown',
    access_rules_json: null, vehicle_profile_json: null, existence_quality: 'confirmed',
    status: 'active', merged_into_id: null,
  }]);
  insertRows(db, 'maps', [{
    branch_id: BRANCH, id: mapId, row_rev: 1, created_turn_id: TURN, updated_turn_id: TURN,
    name: `场地图·${mapId}`, kind: 'site', container_location_id: containerId, description: '',
    frame_json: JSON.stringify({ origin_x: 0, origin_y: 0, reference_width_cells: cols, reference_height_cells: rows }),
    meters_per_cell: mpp, scale_min_meters_per_cell: mpp, scale_max_meters_per_cell: mpp,
    scale_quality: mpp ? 'confirmed' : 'uncalibrated', scale_basis_json: '{}', scale_locked: 0,
    calibration_rev: 1, background_asset_key: null, default_terrain: 'unknown', status: 'active',
  }]);
  return mapId;
}

function addChildLocation(db, { id, name, mapId, kind = 'other', parent }) {
  insertRows(db, 'entity_keys', [{ branch_id: BRANCH, id, kind: 'location' }]);
  insertRows(db, 'locations', [{
    branch_id: BRANCH, id, row_rev: 1, created_turn_id: TURN, updated_turn_id: TURN,
    name, aliases_json: '[]', kind, description: '', parent_location_id: parent ?? null, mobility: 'fixed',
    anchor_location_id: null, map_id: mapId, grid_x: 12, grid_y: 9, coord_precision: 'approximate',
    uncertainty_radius_cells: null, area_geometry_json: null, terrain: 'road',
    access_rules_json: null, vehicle_profile_json: null, existence_quality: 'confirmed',
    status: 'active', merged_into_id: null,
  }]);
}

function addRoute(db, { id, from, to, mapId, status = 'open' }) {
  insertRows(db, 'routes', [{
    branch_id: BRANCH, id, row_rev: 1, created_turn_id: TURN, updated_turn_id: TURN,
    from_location_id: from, to_location_id: to, kind: 'road', bidirectional: 1, map_id: mapId,
    geometry_json: null, geometry_quality: 'unknown', geometry_rev: 1, distance_m: null,
    distance_min_m: null, distance_max_m: null, distance_basis: 'unknown', terrain: 'road',
    allowed_modes_json: '["walk"]', access_rules_json: null, travel_time_override_json: null,
    status, status_reason: '',
  }]);
}

const scope = (viewMode = 'author') => ({ chatId: IDS.chatA, branchId: BRANCH, revision: 0, viewMode });

function contextFor(db, mapId, viewMode = 'author') {
  const built = buildLayoutContext({
    scope: scope(viewMode),
    mapRow: queryBound(db, 'SELECT * FROM maps WHERE branch_id = ? AND id = ?', [BRANCH, mapId])[0],
    locations: queryBound(db, 'SELECT * FROM locations WHERE branch_id = ?', [BRANCH]),
    characters: queryBound(db, 'SELECT * FROM characters WHERE branch_id = ?', [BRANCH]),
    items: queryBound(db, 'SELECT * FROM items WHERE branch_id = ?', [BRANCH]),
    routes: queryBound(db, 'SELECT * FROM routes WHERE branch_id = ?', [BRANCH]),
  });
  assert.equal(built.ok, true, JSON.stringify(built));
  return built.context;
}

function turnInput(extra = {}) {
  return {
    anchor: {
      chatUid: IDS.chatA, branchId: BRANCH, parentTurnId: TURN, hostMessageUid: 'msg_oth',
      variantKey: 'v1', baseRevision: 0, baseStorageRevision: 0, inputHash: 'input_oth',
    },
    userText: '看一眼庭院。', assistantText: '角色站在庭院里。',
    sourceSnapshot: [], phaseBatches: [], manual: false, layoutMaps: 'active', ...extra,
  };
}

function generate(db, mapId, input, viewMode = 'author') {
  const result = generateOverview(input, contextFor(db, mapId, viewMode));
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  return result.scene;
}

/* ------------------------------------------------------------------ *
 * OTH01：三类合法 other 容器都进入布局处理
 * ------------------------------------------------------------------ */

test('OTH01 庭院 / 官道 / 停靠区三类 other 容器，当前有人占用或显式手动时进入布局处理', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const cases = [
      { mapId: 'MAP_COURTYARD', containerId: 'LOC_COURTYARD', name: '后院庭院' },
      { mapId: 'MAP_ROAD', containerId: 'LOC_ROAD', name: '官道' },
      { mapId: 'MAP_STOP', containerId: 'LOC_STOP', name: '停靠区' },
    ];
    for (const item of cases) addOtherMap(seed.db, item);

    // 显式手动：与自动使用同一能力判断，逐张都能出图。
    for (const item of cases) {
      const explicit = buildSqlLayoutTask(seed.db, BRANCH, turnInput({ layoutMaps: [item.mapId] }), `turn_${item.mapId}`);
      assert.ok(explicit, `${item.name} 显式请求不得返回 null`);
      assert.deepEqual(explicit.mapIds, [item.mapId]);
      assert.equal(explicit.kinds[item.mapId], 'overview', 'other 首版固定走 overview');
      assert.equal(explicit.extents[item.mapId].units, 'cells', '未标定 → 格，不假设 1 格 = 1 米');
      assert.match(explicit.request.messages[1].content,/surface 只能为 mixed\/urban\/forest\/mountain\/water\/indoor\/void/);
      assert.equal(explicit.request.promptInput.injectionText,explicit.request.messages[1].content);
    }

    // 自动仅细化当前分支，不为远处所有未访问场所逐张调用模型。
    for(const item of cases){
      seed.db.run('UPDATE characters SET location_id=? WHERE branch_id=? AND id=?',[item.containerId,BRANCH,IDS.C1]);
      const task=buildSqlLayoutTask(seed.db,BRANCH,turnInput(),'turn_oth_auto');
      assert.ok([...task.mapIds,...task.remainingLocationIds].includes(item.mapId),`${item.name} 有人在场时进入自动布局`);
    }
  } finally {
    seed.close();
  }
});

/* ------------------------------------------------------------------ *
 * OTH02：空场地自身示意
 * ------------------------------------------------------------------ */

test('OTH02 空庭院：selfArea 可见、scene 合法、无假子地点、无室内窗户', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    addOtherMap(seed.db, { mapId: 'MAP_COURTYARD', containerId: 'LOC_COURTYARD', name: '后院庭院' });
    const scene = generate(seed.db, 'MAP_COURTYARD', { surface: 'mixed', zones: [] });

    assert.deepEqual(checkSceneDocument(scene), [], '空场地场景必须合法');
    assert.equal(scene.layout.kind, 'overview');
    assert.equal(scene.units, 'cells', '未标定必须用格，不谎称米制');
    assert.ok(scene.layout.selfArea, '空场地必须有自身示意');
    assert.equal(scene.layout.selfArea.locationId, 'LOC_COURTYARD');
    assert.equal(scene.layout.selfArea.quality, 'layout', '按 frame 生成的矩形只能是 layout');
    assert.equal(scene.layout.selfArea.source, 'frame');
    assert.ok(scene.layout.selfArea.polygon.length >= 3);
    assert.equal(scene.layout.selfArea.name, '后院庭院');

    assert.deepEqual(scene.layout.shapes, [], '不得因为空场地就伪造子地点轮廓');
    assert.deepEqual(scene.layout.routes, []);
    assert.equal(scene.layout.windows, undefined, '概览没有室内窗户这种字段');
    assert.equal(scene.layout.rooms, undefined);

    // 自身示意不进实体几何回写清单，容器不会被搬进自己的内部坐标系。
    assert.deepEqual(sceneLocationGeometry(scene), []);
    assert.ok(!(scene.layout.shapes ?? []).some((s) => s.id === 'LOC_COURTYARD'));
  } finally {
    seed.close();
  }
});

test('OTH02b 有子地点的图不再叠自身示意（避免大矩形压住真实轮廓）', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    addOtherMap(seed.db, { mapId: 'MAP_COURTYARD', containerId: 'LOC_COURTYARD', name: '后院庭院' });
    addChildLocation(seed.db, { id: 'LOC_SHED', name: '柴房', mapId: 'MAP_COURTYARD', kind: 'building', parent: 'LOC_COURTYARD' });
    const scene = generate(seed.db, 'MAP_COURTYARD', { surface: 'mixed', zones: [{ id: 'LOC_SHED', role: 'other' }] });
    assert.equal(scene.layout.selfArea, undefined, '有子地点时用 zones 表达，不再叠自身示意');
    assert.ok(scene.layout.shapes.some((s) => s.id === 'LOC_SHED'));
  } finally {
    seed.close();
  }
});

/* ------------------------------------------------------------------ *
 * OTH03：沿线地点与可投影路线
 * ------------------------------------------------------------------ */

test('OTH03 官道：沿线地点可见、可投影路线真实相连；缺端点有诊断', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    addOtherMap(seed.db, { mapId: 'MAP_ROAD', containerId: 'LOC_ROAD', name: '官道' });
    addChildLocation(seed.db, { id: 'LOC_MILE1', name: '一里亭', mapId: 'MAP_ROAD', kind: 'building', parent: 'LOC_ROAD' });
    addChildLocation(seed.db, { id: 'LOC_MILE2', name: '二里亭', mapId: 'MAP_ROAD', kind: 'building', parent: 'LOC_ROAD' });
    addRoute(seed.db, { id: 'R_MILE', from: 'LOC_MILE1', to: 'LOC_MILE2', mapId: 'MAP_ROAD' });

    // 两端都在本图：路线真实相连。
    const connected = generate(seed.db, 'MAP_ROAD', {
      surface: 'mixed',
      zones: [{ id: 'LOC_MILE1', role: 'other' }, { id: 'LOC_MILE2', role: 'other' }],
      links: [{ id: 'R_MILE' }],
    });
    assert.deepEqual(checkSceneDocument(connected), []);
    assert.equal(connected.layout.shapes.length, 2, '两个沿线地点都要有轮廓');
    assert.equal(connected.layout.routes.length, 1, '可投影路线必须真的连起来');
    assert.ok(connected.layout.routes[0].path.length >= 2);
    assert.equal(connected.layout.routes[0].fromLocationId, 'LOC_MILE1');
    assert.equal(connected.layout.routes[0].toLocationId, 'LOC_MILE2');

    // 只有一个沿线地点：仍然显示该地点，缺的另一端必须有诊断，不编造虚线到天边。
    const single = generate(seed.db, 'MAP_ROAD', {
      surface: 'mixed',
      zones: [{ id: 'LOC_MILE1', role: 'other' }],
      links: [{ id: 'R_MILE' }],
    });
    assert.equal(single.layout.shapes.length, 1, '已登记的那个地点必须显示');
    assert.equal(single.layout.routes.length, 0);
    assert.ok(
      single.layout.issues.some((issue) => issue.code === 'OVERVIEW_ROUTE_ENDPOINT_UNKNOWN'),
      `期望 OVERVIEW_ROUTE_ENDPOINT_UNKNOWN，实际 ${JSON.stringify(single.layout.issues)}`,
    );
  } finally {
    seed.close();
  }
});

/* ------------------------------------------------------------------ *
 * OTH04：不新增 SQL 地点、不改容器归属
 * ------------------------------------------------------------------ */

test('OTH04 生成自身示意不增加 SQL 地点，也不改容器 map_id / 父链 / 锁', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    addOtherMap(seed.db, { mapId: 'MAP_STOP', containerId: 'LOC_STOP', name: '停靠区', parent: IDS.L1 });
    const beforeLocations = JSON.stringify(queryBound(seed.db, 'SELECT * FROM locations WHERE branch_id = ? ORDER BY id', [BRANCH]));
    const beforeMaps = JSON.stringify(queryBound(seed.db, 'SELECT * FROM maps WHERE branch_id = ? ORDER BY id', [BRANCH]));

    const scene = generate(seed.db, 'MAP_STOP', { surface: 'mixed', zones: [] });
    assert.ok(scene.layout.selfArea);
    assert.deepEqual(sceneLocationGeometry(scene), [], '自身示意不得产生任何实体几何回写');

    assert.equal(
      JSON.stringify(queryBound(seed.db, 'SELECT * FROM locations WHERE branch_id = ? ORDER BY id', [BRANCH])),
      beforeLocations,
      '纯生成不得增删改 SQL 地点',
    );
    assert.equal(
      JSON.stringify(queryBound(seed.db, 'SELECT * FROM maps WHERE branch_id = ? ORDER BY id', [BRANCH])),
      beforeMaps,
      '生成不得改 maps 行（map_id / 父链 / 锁都保持原样）',
    );

    const container = queryBound(seed.db, 'SELECT map_id, parent_location_id FROM locations WHERE branch_id = ? AND id = ?', [BRANCH, 'LOC_STOP'])[0];
    assert.equal(container.map_id, null, '容器不被搬进自己的内部坐标系');
    assert.equal(container.parent_location_id, IDS.L1, '父链不被改写');
    const mapRow = queryBound(seed.db, 'SELECT container_location_id, scale_locked, calibration_rev FROM maps WHERE branch_id = ? AND id = ?', [BRANCH, 'MAP_STOP'])[0];
    assert.equal(mapRow.container_location_id, 'LOC_STOP');
    assert.equal(Number(mapRow.scale_locked), 0);
    assert.equal(Number(mapRow.calibration_rev), 1, '纯生成不动尺寸账本');
  } finally {
    seed.close();
  }
});

/* ------------------------------------------------------------------ *
 * OTH05：POV 不泄漏隐藏容器
 * ------------------------------------------------------------------ */

test('OTH05 隐藏容器的 selfArea、名称与几何范围不进入 POV', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    addOtherMap(seed.db, { mapId: 'MAP_COURTYARD', containerId: 'LOC_COURTYARD', name: '后院庭院' });
    const scene = generate(seed.db, 'MAP_COURTYARD', { surface: 'mixed', zones: [] });
    assert.ok(scene.layout.selfArea, '前提：作者视角有自身示意');

    // 作者视角：保留。
    const author = filterSceneForView(scene, { scope: scope('author') });
    assert.equal(author.ok, true, JSON.stringify(author));
    assert.ok(author.scene.layout.selfArea, '作者视角必须看得到自身示意');

    // POV + 容器可见：保留，但内部标记被剥离。
    const visible = filterSceneForView(scene, { scope: scope('pov'), visibleLocations: ['LOC_COURTYARD'], names: { LOC_COURTYARD: '后院庭院' } });
    assert.equal(visible.ok, true, JSON.stringify(visible));
    assert.ok(visible.scene.layout.selfArea, '容器可见时自身示意应下发');
    assert.equal(visible.scene.layout.selfArea.locationId, 'LOC_COURTYARD');
    assert.equal(visible.scene.layout.selfArea.name, '后院庭院');
    assert.deepEqual(Object.keys(visible.scene.layout.selfArea).sort(), ['locationId', 'name', 'polygon', 'quality', 'source']);
    assert.deepEqual(checkSceneDocument(visible.scene), []);

    // POV + 容器隐藏：范围、名称、id 一个都不许留。
    const hidden = filterSceneForView(scene, { scope: scope('pov'), visibleLocations: [] });
    assert.equal(hidden.ok, true, JSON.stringify(hidden));
    assert.equal(hidden.scene.layout.selfArea, undefined, '隐藏容器不得泄露自身示意');
    assert.equal(JSON.stringify(hidden.scene).includes('LOC_COURTYARD'), false, '隐藏容器的 id 不得出现在 POV 场景里');
    assert.equal(JSON.stringify(hidden.scene).includes('后院庭院'), false, '隐藏容器的名称不得出现在 POV 场景里');
  } finally {
    seed.close();
  }
});
