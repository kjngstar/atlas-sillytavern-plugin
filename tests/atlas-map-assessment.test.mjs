/**
 * atlas-map-assessment.test.mjs — P14/R04 §21.1–21.2：地图完整性评估（COMP01–COMP05）。
 *
 * 纪律：期望/已表示集合走**真实来源** —— 概览与室内场景由 kit 生成器产出，
 * 视图过滤走 `filterSceneForView`，DTO 走 `querySpatialScene`。不手搓假场景来「验证」。
 *
 * 覆盖：
 *   COMP01 5 个应表示地点、1 个没有任何表示 → missingIds 含它，partial。
 *   COMP02 同地点 shape+pin 只算一次；装饰（路纹/feature）不增加地点数量。
 *   COMP03 秘密地点与秘密路线不进 missingIds、不改变数量，也不改变公开几何。
 *   COMP04 粗位置人物可用列表表示；在途/离场人物不被报成漏画。
 *   COMP05 场景有效但路线端点未知 → 保留有效部分 + routeIssues；失败重建保留旧场景的
 *          「ready + failed + 未对齐」三件套；档案换模板后旧场景标 unsupported。
 *
 * 边界：不外网；数据只在内存。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as Kit from '../vendor/atlas-spatial/index.mjs';
import { makeSeedWith, IDS, insertRows } from './fixtures/atlas-sql/seed.mjs';
import { assessMapCompleteness } from '../src/atlas-map-assessment.ts';
import { querySpatialScene } from '../src/atlas-spatial-views.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';

const SQL = await (await import('sql.js')).default();
const BRANCH = IDS.branchMain;
const SCOPE = { chatId: IDS.chatA, branchId: BRANCH, revision: 5, viewMode: 'author' };

const MAP = 'M_SITE';
const SITE = 'L_SITE';
const ZONES = ['L_ZA', 'L_ZB', 'L_ZC', 'L_ZD', 'L_ZE'];
const SECRET = 'L_ZSEC';
const COARSE = 'C_COARSE';
const TRANSIT = 'C_TRANSIT';
const R_OK = 'R_OK';
const R_NOGEOM = 'R_NOGEOM';
const R_UNKNOWN_END = 'R_UNKNOWN_END';

function loc(id, over = {}) {
  return {
    branch_id: BRANCH, id, name: id, aliases_json: '[]', kind: 'other', description: '',
    parent_location_id: null, mobility: 'fixed', anchor_location_id: null, map_id: MAP,
    grid_x: null, grid_y: null, coord_precision: 'unknown', uncertainty_radius_cells: null,
    area_geometry_json: null, terrain: 'unknown', access_rules_json: null, vehicle_profile_json: null,
    existence_quality: 'confirmed', status: 'active', merged_into_id: null, row_rev: 1,
    created_turn_id: IDS.seedTurn, updated_turn_id: IDS.seedTurn, ...over,
  };
}

function mapRow(over = {}) {
  return {
    branch_id: BRANCH, id: MAP, name: '场地', kind: 'site', container_location_id: SITE,
    description: '', frame_json: { origin_x: 0, origin_y: 0, cols: 60, rows: 48 },
    meters_per_cell: null, scale_min_meters_per_cell: null, scale_max_meters_per_cell: null,
    scale_quality: 'uncalibrated', scale_basis_json: '{}', scale_locked: 0, calibration_rev: 1,
    background_asset_key: null, default_terrain: 'unknown', status: 'active', row_rev: 1,
    created_turn_id: IDS.seedTurn, updated_turn_id: IDS.seedTurn, ...over,
  };
}

/** 真实概览场景：只给需要画出来的分区。 */
function overviewScene(zoneIds, members, extra = {}) {
  const built = Kit.buildLayoutContext({
    scope: SCOPE, mapRow: mapRow(),
    locations: members, characters: [], items: [], routes: [],
  });
  assert.equal(built.ok, true, JSON.stringify(built.issues));
  const generated = Kit.generateOverview({
    surface: 'mixed',
    zones: zoneIds.map((id, index) => ({
      id, name: id, role: 'land', size: 'medium',
      sector: ['north', 'south', 'east', 'west', 'center'][index % 5],
    })),
  }, built.context);
  assert.equal(generated.ok, true, JSON.stringify(generated.issues));
  return generated.scene;
}

const allMembers = () => [loc(SITE, { kind: 'other', map_id: null }), ...[...ZONES, SECRET].map((id) => loc(id))];
/** 公开成员：不含秘密分区。 */
const publicMembers = () => [loc(SITE, { kind: 'other', map_id: null }), ...ZONES.map((id) => loc(id))];

/** COMP01–COMP05 的共同输入骨架。 */
function assess(scene, over = {}) {
  const members = over.members ?? allMembers();
  return assessMapCompleteness({
    map: { id: MAP, scale_quality: 'uncalibrated', frame_json: scene ? { atlasScene: scene } : {} },
    container: members.find((row) => row.id === SITE) ?? null,
    profile: { layoutKind: 'overview', unsupported: over.unsupported ?? [] },
    members,
    knownEntityIds: [...members.map((row) => row.id), COARSE, TRANSIT],
    saveState: 'saved',
    ...over,
  });
}

// ───────────────────────────── COMP01 ─────────────────────────────

test('COMP01：5 个应表示地点缺 1 个 → missingIds 含它，completeness=partial', () => {
  const members = allMembers();
  const scene = overviewScene([...ZONES.slice(0, 4), SECRET], members);
  const rendered = scene.layout.shapes.map((shape) => shape.id);
  assert.equal(rendered.length, 5, JSON.stringify(rendered));

  const withoutOne = assess(scene, { members: members.filter((row) => row.id !== SECRET) });
  assert.deepEqual(withoutOne.expectedIds, [...ZONES].sort(), '五个直属分区都是本图责任');
  assert.deepEqual(withoutOne.missingIds, ['L_ZE'], `只该缺没画的那一个：${JSON.stringify(withoutOne.renderedIds)}`);
  assert.equal(withoutOne.completeness, 'partial');
  assert.equal(withoutOne.semanticState, 'consistent');
  assert.equal(withoutOne.sceneState, 'ready');

  // 全部画出来 → complete（complete 只针对本图可见展示责任）。
  const full = assess(overviewScene([...ZONES, SECRET], members), { members });
  assert.deepEqual(full.missingIds, []);
  assert.equal(full.completeness, 'complete');
});

// ───────────────────────────── COMP02 ─────────────────────────────

test('COMP02：同地点 shape+pin 只算一次；装饰不增加地点数量', () => {
  const members = publicMembers();
  const scene = overviewScene([...ZONES], members);
  const before = assess(scene, { members });
  assert.deepEqual(before.missingIds, []);

  const withPin = JSON.parse(JSON.stringify(scene));
  withPin.layout.pins.push({ id: ZONES[0], name: ZONES[0], x: 5, y: 5 });
  const afterPin = assess(withPin, { members });
  assert.deepEqual(afterPin.renderedIds, before.renderedIds, '一个 shape 加一个同 ID 标记仍然只表示一个实体');
  assert.equal(afterPin.renderedIds.filter((id) => id === ZONES[0]).length, 1);
  assert.equal(afterPin.completeness, 'complete');

  const withDecor = JSON.parse(JSON.stringify(scene));
  withDecor.layout.features.push({ id: 'F_ROAD', type: 'road_texture', density: 'medium' });
  withDecor.layout.features.push({ id: 'F_FOREST', type: 'forest_texture', density: 'low' });
  assert.deepEqual(Kit.checkSceneDocument(withDecor), [], '加了装饰后场景仍必须合法');
  const afterDecor = assess(withDecor, { members });
  assert.deepEqual(afterDecor.renderedIds, before.renderedIds, '装饰（路纹/林纹）不是地点');
  assert.equal(afterDecor.expectedIds.includes('F_ROAD'), false);
  assert.equal(afterDecor.renderedIds.includes('F_ROAD'), false);
});

// ───────────────────────────── COMP03 ─────────────────────────────

test('COMP03：秘密地点与秘密路线不进 missingIds、不影响数量与公开几何', () => {
  const members = publicMembers();
  const scene = overviewScene([...ZONES, SECRET], [...members, loc(SECRET)]);
  // 真实的视图过滤：只允许公开分区可见。
  const filtered = Kit.filterSceneForView(scene, {
    scope: { ...SCOPE, viewMode: 'pov' },
    visibleLocations: [...ZONES],
    visibleCharacters: [], visibleItems: [], names: {},
  });
  assert.equal(filtered.ok, true, JSON.stringify(filtered.issues));
  const visibleScene = filtered.scene;
  assert.equal(visibleScene.layout.shapes.some((shape) => shape.id === SECRET), false, '秘密分区不得留在公开几何里');

  // POV 已经在**计算之前**过滤完：秘密成员与端点含秘密的路线根本不会传进来，
  // 所以评估里既没有它们的期望，也没有它们的缺项 —— 而不是算完了再把它们删掉。
  const result = assess(visibleScene, { members });
  assert.deepEqual(result.expectedIds, [...ZONES].sort(), '期望集合里没有秘密地点');
  assert.deepEqual(result.missingIds, []);
  assert.equal(result.renderedIds.includes(SECRET), false);
  const asText = JSON.stringify(result);
  assert.equal(asText.includes(SECRET), false, '秘密 ID 不得出现在任何评估字段里（含诊断）');
  assert.equal(asText.includes(TRANSIT), false);
  // 公开 bounds 只用公开几何算：过滤后的场景不含秘密分区。
  const bounds = visibleScene.layout.bounds;
  assert.ok(bounds.w > 0 && bounds.h > 0);
});

// ───────────────────────────── COMP04 ─────────────────────────────

test('COMP04：粗位置人物可用列表表示；在途/离场人物不被报成漏画', () => {
  const members = publicMembers();
  const scene = overviewScene([...ZONES], members);
  const result = assess(scene, {
    members,
    characters: [],
    listIds: [COARSE],
  });
  assert.equal(result.renderedIds.includes(COARSE), true, '粗定位名单是合法表示');
  assert.deepEqual(result.missingIds, []);
  assert.equal(result.completeness, 'complete');
  assert.equal(result.expectedIds.includes(TRANSIT), false, '在途/离场人物根本不在本图责任内');

  // 反例：明细位置的一个人物没画出来 → 必须报缺项。
  const detailed = assess(scene, { members, characters: [{ id: 'C_HERE' }], listIds: [COARSE] });
  assert.deepEqual(detailed.missingIds, ['C_HERE'], '有精确位置却没画的人物必须进 missingIds');
  assert.equal(detailed.completeness, 'partial');
});

// ───────────────────────────── COMP05 ─────────────────────────────

test('COMP05：路线端点未知保留有效部分；失败重建保留旧场景；换模板标 unsupported', () => {
  const members = publicMembers();
  const scene = overviewScene([...ZONES], members);

  const result = assess(scene, {
    members,
    routes: [
      { id: R_OK, from_location_id: ZONES[0], to_location_id: ZONES[1], geometry: { points: [{ x: 0, y: 0 }] } },
      { id: R_NOGEOM, from_location_id: ZONES[0], to_location_id: ZONES[2], geometry: null },
      { id: R_UNKNOWN_END, from_location_id: ZONES[0], to_location_id: 'L_NOT_HERE', geometry: { points: [] } },
    ],
  });
  const codes = result.routeIssues.map((item) => item.code).sort();
  assert.deepEqual(codes, ['MAP_ROUTE_ENDPOINT_UNKNOWN', 'MAP_ROUTE_GEOMETRY_MISSING'], JSON.stringify(result.routeIssues));
  assert.equal(result.expectedIds.includes(R_UNKNOWN_END), false, '端点未知的路线不进期望集合');
  // 有合法几何但没画出来的路线 → 是缺项（不是靠一条装饰线充数）。
  assert.equal(result.missingIds.includes(R_OK), true);
  assert.equal(result.completeness, 'partial');
  // 场景本身仍然有效：不能因为一条坏路线就宣称「没有场景」。
  assert.equal(result.sceneState, 'ready');
  assert.equal(result.semanticState, 'consistent', '路线问题走 routeIssues，不混进 semanticIssues');

  // 重建失败但保留旧有效场景：ready + failed + 未对齐（§21.1 明令）。
  const failed = assessMapCompleteness({
    map: { id: MAP, scale_quality: 'uncalibrated', frame_json: { atlasScene: scene, atlasLayoutRequest: { status: 'failed', kind: 'overview' } } },
    container: members[0],
    profile: { layoutKind: 'overview' },
    members: members.filter((row) => row.id !== SITE),
    knownEntityIds: members.map((row) => row.id),
    saveState: 'saved',
  });
  assert.equal(failed.sceneState, 'ready');
  assert.equal(failed.requestState, 'failed');
  assert.equal(failed.matchesCurrentInputs, false, '重建失败就不能说当前输入已对齐');
  assert.equal(failed.completeness, 'complete', '旧场景本身是完整的');
  assert.equal(failed.saveState, 'saved');

  // 档案换成复合场所（overview）而场景还是 floor → unsupported + 明确诊断。
  // 室内场景：必须已标定幅面，否则生成器明确拒（EXTENT_REQUIRED），不会给一个空场景充数。
  const floorBuilt = Kit.buildLayoutContext({
    scope: SCOPE,
    mapRow: mapRow({ meters_per_cell: 1, scale_quality: 'confirmed', frame_json: { origin_x: 0, origin_y: 0, cols: 24, rows: 20 } }),
    locations: [loc(SITE, { kind: 'other', map_id: null }), loc(ZONES[0], { kind: 'room', parent_location_id: SITE })],
    characters: [], items: [], routes: [],
  });
  assert.equal(floorBuilt.ok, true, JSON.stringify(floorBuilt.issues));
  const floorGenerated = Kit.generateFloor({ corridorWidth: 2, rooms: [{ id: ZONES[0], name: '房', side: 'north', w: 6, h: 5 }] }, floorBuilt.context);
  assert.equal(floorGenerated.ok, true, JSON.stringify(floorGenerated.issues));
  const floorScene = floorGenerated.scene;
  assert.equal(floorScene.layout.kind, 'floor');
  const mismatch = assessMapCompleteness({
    map: { id: MAP, scale_quality: 'uncalibrated', frame_json: { atlasScene: floorScene } },
    container: members[0],
    profile: { layoutKind: 'overview' },
    members: [],
    knownEntityIds: [ZONES[0]],
    saveState: 'unsaved',
  });
  assert.equal(mismatch.sceneState, 'unsupported');
  assert.equal(mismatch.matchesCurrentInputs, false);
  assert.ok(mismatch.semanticIssues.some((item) => item.code === 'MAP_SCENE_TEMPLATE_MISMATCH'));
  assert.equal(mismatch.semanticState, 'issues');
  assert.equal(mismatch.saveState, 'unsaved');

  // 没有场景 → unknown，不是 partial，也不是「缺 n 项」。
  const missing = assessMapCompleteness({
    map: { id: MAP, scale_quality: 'uncalibrated', frame_json: {} },
    container: members[0],
    profile: { layoutKind: 'overview' },
    members: members.filter((row) => row.id !== SITE),
    knownEntityIds: members.map((row) => row.id),
    saveState: 'saved',
  });
  assert.equal(missing.sceneState, 'missing');
  assert.equal(missing.completeness, 'unknown');
  assert.equal(missing.semanticState, 'unknown');
  assert.deepEqual(missing.missingIds, []);
  assert.equal(missing.requestState, 'idle');
});

// ───────────────────────── 真实 DTO 接线 ─────────────────────────

test('COMP-DTO：querySpatialScene 每张图都带 assessment，且 POV 的期望集合不含隐藏成员', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    insertRows(seed.db, 'entity_keys', [SITE, ...ZONES, SECRET].map((id) => ({ branch_id: BRANCH, id, kind: 'location' })));
    // 外键顺序：地点先落（map_id 暂空）→ 地图 → 回填 map_id。
    insertRows(seed.db, 'locations', allMembers().map((row) => ({ ...row, map_id: null })));
    const members = allMembers();
    const scene = overviewScene([...ZONES, SECRET], members);
    insertRows(seed.db, 'maps', [mapRow({ frame_json: { origin_x: 0, origin_y: 0, cols: 60, rows: 48, atlasScene: scene } })]);
    seed.db.run('UPDATE locations SET map_id = ? WHERE branch_id = ? AND id IN (?)'.replace('IN (?)', `IN (${[...ZONES, SECRET].map(() => '?').join(',')})`), [MAP, BRANCH, ...ZONES, SECRET]);
    // L_ZSEC 是秘密地点：作者视图可见，POV 不可见。
    seed.db.run(`UPDATE locations SET access_rules_json = ? WHERE branch_id = ? AND id = ?`, ['{"visibility":"secret"}', BRANCH, SECRET]);
    const route=queryBound(seed.db,'SELECT * FROM routes WHERE branch_id=? AND id=?',[BRANCH,IDS.R_AB])[0];
    insertRows(seed.db,'routes',[{...route,id:R_OK,from_location_id:ZONES[0],to_location_id:ZONES[1],map_id:MAP,geometry_json:{kind:'line',coordinates:[[1,1],[2,2]]},geometry_quality:'estimated'}]);

    const ctx = { db: seed.db, branchId: BRANCH, revision: 5, viewMode: 'author', povId: null, chatId: IDS.chatA };
    const author = querySpatialScene(ctx, { kind: 'scene', branchId: BRANCH }).items.find((item) => item.mapId === MAP);
    assert.ok(author, '必须有这张图的场景条目');
    assert.equal(author.assessment.version, 1);
    assert.equal(author.assessment.saveState, 'saved');
    assert.equal(author.assessment.sceneState, 'ready');
    assert.equal(author.assessment.metricQuality, 'uncalibrated');
    assert.ok(author.scene.layout.routes.some(route=>route.id===R_OK),'概览须使用实际保存且可绘制的路线');
    assert.ok(!author.assessment.missingIds.includes(R_OK),'SQL 路线已经下发时不能再报告漏画');
    assert.ok(author.assessment.expectedIds.includes(SECRET), `作者视图应把秘密分区算进本图责任：${JSON.stringify(author.assessment.expectedIds)}`);

    const pov = querySpatialScene({ ...ctx, viewMode: 'pov', povId: COARSE }, { kind: 'scene', branchId: BRANCH }).items.find((item) => item.mapId === MAP);
    assert.ok(pov, 'POV 也要拿到评估（说明「有没有缺项」不能靠 UI 猜）');
    assert.equal(pov.assessment.expectedIds.includes(SECRET), false, '秘密成员既不在期望集合，也不在缺项里');
    assert.equal(pov.assessment.missingIds.includes(SECRET), false);
    assert.equal(pov.assessment.renderedIds.includes(SECRET), false);
    assert.equal(JSON.stringify(pov.assessment).includes(SECRET), false, 'POV 的评估字段不得泄漏秘密 ID');
  } finally {
    seed.close();
  }
});
