/**
 * atlas-spatial-profile.test.mjs — P13/R03 §20：室外 / 沿线 / 复合场所档案（SITE01–SITE04）。
 *
 * 纪律：走**真实链路** —— installSchema / 真实候选事务（compileSqlSceneMaps + applyGroups）/
 * deriveLayoutSites / buildSqlLayoutTask / generateOverview / buildSceneMutation / queryMapView。
 * 不 mock 几何、不自己造 context、不断言「常量存在」这种废话。
 *
 * 覆盖：
 *   SITE01 复合驿站：可见已知建筑 + 开放场地/停靠区 + 入口；进入建筑看它自己的室内图。
 *   SITE02 庭院/停靠区不是室内模板（不生成窗户/匿名房间）；官道是已登记路线，不是纯纹理线。
 *   SITE03 档案切换失败保留旧 scene；回退（journal 逆变更）恢复档案与场景。
 *   SITE04 缺资料 → unknown；名字像"驿站/庭院"不自动确认；不新造 SQL 地点/事件/物品。
 *   另含：档案 → 布局 kind 的唯一 resolver（city 类型默认不被降级）、读写拒绝非法档案。
 *
 * 边界：不调用外网；数据只存在于内存。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as Kit from '../vendor/atlas-spatial/index.mjs';
import { makeSeedWith, IDS, insertRows, selectOne, countRows } from './fixtures/atlas-sql/seed.mjs';
import { applyGroups } from '../src/atlas-db-commit.ts';
import { createTableReadPort } from '../src/atlas-db-readport.ts';
import { compileSqlSceneMaps } from '../src/atlas-sql-scene-maps.ts';
import { buildSqlLayoutTask, deriveLayoutSites } from '../src/atlas-sql-layout-task.ts';
import { queryMapView } from '../src/atlas-db-views.ts';
import {
  SPATIAL_PROFILE_FRAME_KEY,
  boundCorridorIdOf,
  normalizeRequestedProfileMode,
  readSpatialProfile,
  resolveSpatialProfile,
  writeSpatialProfile,
} from '../src/atlas-spatial-profile.ts';

const SQL = await (await import('sql.js')).default();
const BRANCH = IDS.branchMain;
const TURN = 'turn_profile';
const SCOPE = { chatId: IDS.chatA, branchId: BRANCH, revision: 5, viewMode: 'author' };

// 复合驿站：场地 + 已知建筑 + 开放停靠区；建筑里有房间；官道与沿途地点。
const SITE = 'L_SITE';
const BLD = 'L_BLD';
const YARD = 'L_YARD';
const GUARD = 'L_GUARD';
const ROOM = 'L_ROOM';
const ROAD = 'L_ROAD';
const TOWN = 'L_TOWN';
const GHOST = 'L_GHOST';
const MAP_SITE = 'M_SITE';
const MAP_BLD = 'M_BLD';
const MAP_YARD = 'M_YARD';
const MAP_ROAD = 'M_ROAD';
const MAP_GHOST = 'M_GHOST';
const R_ROAD = 'R_ROAD';

// ───────────────────────────── 夹具 ─────────────────────────────

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
    frame_json: { origin_x: 0, origin_y: 0, cols: 100, rows: 80 },
    meters_per_cell: null, scale_min_meters_per_cell: null, scale_max_meters_per_cell: null,
    scale_quality: 'uncalibrated', scale_basis_json: '{}', scale_locked: 0, calibration_rev: 1,
    background_asset_key: null, default_terrain: 'unknown', status: 'active', row_rev: 1,
    created_turn_id: IDS.seedTurn, updated_turn_id: IDS.seedTurn, ...over,
  };
}

function routeRow(id, from, to, over = {}) {
  return {
    branch_id: BRANCH, id, from_location_id: from, to_location_id: to, kind: 'road',
    bidirectional: 1, map_id: null, geometry_json: null, geometry_quality: 'estimated',
    geometry_rev: 1, distance_m: 12000, distance_min_m: 12000, distance_max_m: 12000,
    distance_basis: 'narrative', terrain: 'road', allowed_modes_json: '["walk","ride"]',
    access_rules_json: null, travel_time_override_json: null, status: 'open', status_reason: '',
    row_rev: 1, created_turn_id: IDS.seedTurn, updated_turn_id: IDS.seedTurn, ...over,
  };
}

function insertTurn(db, id) {
  db.run(
    `INSERT INTO turns (id, branch_id, parent_turn_id, host_message_uid, host_variant_key, kind, input_hash, story_hash, base_revision, committed_revision, clock_before_s, elapsed_json, clock_after_s, rng_seed, ruleset_version, decisions_json, receipt_json, attempts_json, status, created_wall_ms, prepared_wall_ms)
     VALUES (?, ?, NULL, NULL, NULL, 'manual', ?, NULL, 0, 0, 0, ?, 0, ?, 'atlas-1', ?, NULL, ?, 'pending', ?, ?)`,
    [id, BRANCH, `hash_${id}`, JSON.stringify({ min_s: 0, nominal_s: 0, max_s: 0, quality: 'explicit', basis_refs: [] }), `rng_${id}`,
      JSON.stringify({ operations: [], attention_decisions: [], outcome_decisions: [], random_draws: [] }),
      JSON.stringify([]), 1_700_000_000_000, 1_700_000_000_000],
  );
}

async function siteSeed() {
  const seed = await makeSeedWith(SQL);
  insertTurn(seed.db, TURN);
  insertRows(seed.db, 'entity_keys', [
    SITE, BLD, YARD, GUARD, ROOM, ROAD, TOWN, GHOST,
  ].map((id) => ({ branch_id: BRANCH, id, kind: 'location' })));
  // 外键顺序：地点（map_id 暂空）→ 地图 → 回填 map_id → 路线。
  insertRows(seed.db, 'locations', [
    loc(SITE, { name: '驿站', kind: 'other' }),
    loc(BLD, { name: '驿站客栈', kind: 'building', parent_location_id: SITE }),
    loc(YARD, { name: '停靠场院', kind: 'other', parent_location_id: SITE }),
    loc(GUARD, { name: '门房', kind: 'room', parent_location_id: YARD }),
    loc(ROOM, { name: '客房', kind: 'room', parent_location_id: BLD }),
    loc(ROAD, { name: '官道', kind: 'other' }),
    loc(TOWN, { name: '下个镇子', kind: 'other' }),
    loc(GHOST, { name: '驿站庭院', kind: 'other' }),
  ]);
  insertRows(seed.db, 'maps', [
    mapRow(MAP_SITE, { name: '驿站场地', kind: 'site', container_location_id: SITE, frame_json: { origin_x: 0, origin_y: 0, cols: 60, rows: 48 } }),
    mapRow(MAP_BLD, { name: '客栈室内', kind: 'interior', container_location_id: BLD, frame_json: { origin_x: 0, origin_y: 0, cols: 24, rows: 20 } }),
    mapRow(MAP_YARD, { name: '停靠场院', kind: 'region', container_location_id: YARD, frame_json: { origin_x: 0, origin_y: 0, cols: 40, rows: 32 } }),
    mapRow(MAP_ROAD, { name: '官道沿线', kind: 'region', container_location_id: ROAD, frame_json: { origin_x: 0, origin_y: 0, cols: 80, rows: 40 } }),
    mapRow(MAP_GHOST, { name: '复合驿站', kind: 'site', container_location_id: GHOST, frame_json: { origin_x: 0, origin_y: 0, cols: 40, rows: 32 } }),
  ]);
  seed.db.run('UPDATE locations SET map_id = ? WHERE id IN (?, ?)', [MAP_SITE, BLD, YARD]);
  seed.db.run('UPDATE locations SET map_id = ? WHERE id = ?', [MAP_BLD, ROOM]);
  seed.db.run('UPDATE locations SET map_id = ? WHERE id = ?', [MAP_YARD, GUARD]);
  seed.db.run('UPDATE locations SET map_id = ? WHERE id = ?', [MAP_ROAD, TOWN]);
  insertRows(seed.db, 'routes', [routeRow(R_ROAD, ROAD, TOWN)]);
  return seed;
}

function applyCtx(attempt = 'attempt_profile', turn = TURN) {
  return { branchId: BRANCH, turnId: turn, attemptId: attempt };
}

/** 走真实候选事务写档案（与 map/profile 命令同一条 compileSqlSceneMaps 落盘路径）。 */
function writeProfile(seed, mapId, mode, attempt = 'attempt_profile') {
  const group = compileSqlSceneMaps({
    db: seed.db, branchId: BRANCH, turnId: TURN, clockS: 0,
    makeId: (kind, opId, alias) => `${kind}_${alias}`,
    profile: { mapId, mode },
  });
  assert.ok(group, `写档案 ${mapId}=${String(mode)} 必须产出变更组`);
  const applied = applyGroups(seed.db, [group], applyCtx(attempt));
  assert.equal(applied.groups[0].status, 'applied', JSON.stringify(applied));
  assert.equal(applied.groups[0].changedRows, group.mutations.length, '档案的每一行变更都必须真的落库');
  return { group, applied };
}

const frameOf = (seed, mapId) => JSON.parse(selectOne(seed.db, 'maps', BRANCH, mapId).frame_json);
const entryOf = (derived, mapId) => derived.entries.find((entry) => entry.mapId === mapId);
const scopeOf = (task) => {
  const scopes = [];
  for (const line of String(task.request.messages[1].content).split('\n')) {
    if (!line.startsWith('本图：')) continue;
    scopes.push(...JSON.parse(line.slice('本图：'.length)));
  }
  return scopes;
};

// ───────────────────────── SITE01 · 复合驿站 ─────────────────────────

test('SITE01 复合驿站：可见建筑 + 开放场院 + 入口；进入建筑走它自己的室内图', async () => {
  const seed = await siteSeed();
  try {
    const out = writeProfile(seed, MAP_SITE, 'compound');
    assert.equal(out.applied.groups[0].changedRows, 1, JSON.stringify(out.applied));

    const derived = deriveLayoutSites(createTableReadPort(seed.db), BRANCH);
    const site = entryOf(derived, MAP_SITE);
    assert.ok(site, '站点图必须在派生结果里');
    assert.equal(site.profile.profile.mode, 'compound');
    assert.equal(site.profile.profile.basis, 'author');
    assert.equal(site.profile.navigationName, '复合场所');
    assert.equal(site.kind, 'overview', '复合场所是概览图，不是两排室内房间');
    assert.equal(site.profile.partial, false, JSON.stringify(site.profile.unsupported));
    // 复合图上可见的成员：已知建筑 + 开放场院（它的入口/足迹责任由档案声明）。
    const siteMemberIds = site.own.map((row) => String(row.id)).sort();
    assert.deepEqual(siteMemberIds, [BLD, YARD].sort(), `复合图的直属成员：${JSON.stringify(siteMemberIds)}`);
    assert.deepEqual([...site.profile.responsibility].sort(), ['entrances', 'footprints', 'surface'].sort());

    // 进入建筑 = 它有自己的室内图，档案为室内、布局 kind 为 floor。
    const bld = entryOf(derived, MAP_BLD);
    assert.ok(bld, '建筑必须有自己的一张图');
    assert.equal(bld.kind, 'floor', '进入建筑的室内图按 floor 生成');
    assert.equal(bld.profile.profile.mode, 'interior');
    assert.equal(bld.profile.profile.basis, 'typed-default');

    // 提示词必须把两套模板的禁区分别讲清楚（模型看不到 resolver，只看得到文字）。
    const task = buildSqlLayoutTask(seed.db, BRANCH, {
      anchor: { chatUid: IDS.chatA, branchId: BRANCH, baseRevision: 0, baseStorageRevision: 0 },
      userText: '', assistantText: '', sourceSnapshot: [],
      layoutMaps: [MAP_SITE, MAP_BLD],
    }, TURN);
    assert.ok(task, '有具体图必须产出布局任务');
    assert.deepEqual(task.mapIds,[MAP_SITE]);assert.deepEqual(task.remainingLocationIds,[MAP_BLD]);
    const childTask=buildSqlLayoutTask(seed.db,BRANCH,{anchor:task.request.anchor,userText:'',assistantText:'',sourceSnapshot:[],layoutMaps:task.remainingLocationIds},TURN+'_child');
    const text = task.request.messages[1].content+'\n'+childTask.request.messages[1].content;
    assert.ok(text.includes('compound=画外场与真实建筑足迹'), '复合档案的禁区必须进提示词');
    assert.ok(text.includes('interior=只画已登记房间与通道'), '室内档案的说明必须进提示词');
    assert.ok(!text.includes('compound=undefined'), '档案说明不能是空的');
    const scopeSite = scopeOf(task).find((scope) => scope.name === '驿站场地');
    assert.equal(scopeSite.kind, 'overview');
    assert.equal(scopeSite.profile.mode, 'compound');
    assert.equal(scopeSite.profile.basis, 'author');
    assert.deepEqual(scopeSite.profile.forbidden, ['把整座场所做成"两排室内房间"']);
  } finally {
    seed.close();
  }
});

// ───────────────────────── SITE02 · 场院与官道 ─────────────────────────

test('SITE02 停靠场院不是室内模板；官道是已登记路线而不是纯纹理线', async () => {
  const seed = await siteSeed();
  try {
    writeProfile(seed, MAP_YARD, 'outdoor');
    writeProfile(seed, MAP_ROAD, 'linear');

    const derived = deriveLayoutSites(createTableReadPort(seed.db), BRANCH);
    const yard = entryOf(derived, MAP_YARD);
    assert.equal(yard.profile.profile.mode, 'outdoor');
    assert.equal(yard.kind, 'overview', '场院不能退化成室内 floor 模板');
    // 场院里登记的门房（room）当前生成器表达不了：明说 partial，不替换实体类型凑成功。
    assert.equal(yard.profile.partial, true);
    assert.deepEqual(yard.profile.unsupported.map((item) => item.id), [GUARD]);
    assert.match(yard.profile.unsupported[0].reason, /室外档案不生成匿名室内房间/);
    assert.ok(derived.issues.some((item) => item.code === 'SPATIAL_PROFILE_MEMBER_UNSUPPORTED'));

    const road = entryOf(derived, MAP_ROAD);
    assert.equal(road.profile.profile.mode, 'linear');
    assert.equal(road.kind, 'overview');
    // 有真实登记的官道路线：不报「没有已登记路线」。
    assert.ok(!derived.issues.some((item) => item.code === 'SPATIAL_PROFILE_NO_REGISTERED_ROUTE'));

    const task = buildSqlLayoutTask(seed.db, BRANCH, {
      anchor: { chatUid: IDS.chatA, branchId: BRANCH, baseRevision: 0, baseStorageRevision: 0 },
      userText: '', assistantText: '', sourceSnapshot: [],
      layoutMaps: [MAP_YARD, MAP_ROAD],
    }, TURN);
    const remainingTask=task.remainingLocationIds.length?buildSqlLayoutTask(seed.db,BRANCH,{anchor:task.request.anchor,userText:'',assistantText:'',sourceSnapshot:[],layoutMaps:task.remainingLocationIds},TURN+'_next'):null;
    const scopes=[...scopeOf(task),...(remainingTask?scopeOf(remainingTask):[])];
    const text = task.request.messages[1].content+'\n'+(remainingTask?.request.messages[1].content??'');
    assert.ok(text.includes('outdoor=只画范围/足迹/入口'), '室外档案的禁区必须进提示词');
    assert.ok(text.includes('linear=路线必须是目录中已登记的 route'), '沿线档案必须声明路线来源');
    const scopeYard = scopes.find((scope) => scope.name === '停靠场院');
    assert.equal(scopeYard.kind, 'overview');
    assert.deepEqual(scopeYard.baselineRooms, [], '室外图不能带室内 baselineRooms（不生成窗户/匿名房间）');
    assert.deepEqual(scopeYard.profile.unsupported.map((item) => item.kind), ['room']);
    const scopeRoad = scopes.find((scope) => scope.name === '官道沿线');
    assert.equal(scopeRoad.profile.mode, 'linear');
    assert.ok(scopeRoad.profile.forbidden.includes('把道路路线当作纯装饰纹理线'));

    // 官道没有被当成纯纹理：路线仍登记在案，且沿线图把路线当成员（把路线删掉就必须报警）。
    seed.db.run('DELETE FROM routes WHERE branch_id = ? AND id = ?', [BRANCH, R_ROAD]);
    const withoutRoute = deriveLayoutSites(createTableReadPort(seed.db), BRANCH);
    assert.equal(entryOf(withoutRoute, MAP_ROAD).profile.profile.mode, 'linear', '档案本身不变');
    assert.ok(withoutRoute.issues.some((item) => item.code === 'SPATIAL_PROFILE_NO_REGISTERED_ROUTE'),
      '没有已登记路线时必须明说，不能用 road_texture 装饰假装道路');
  } finally {
    seed.close();
  }
});

// ───────────────────────── SITE03 · 切换失败与回退 ─────────────────────────

test('SITE03 存档切换失败保留旧 scene；回退恢复档案与场景', async () => {
  const seed = await siteSeed();
  try {
    // 先给站点图一个**真实生成**的概览场景（不是手写 DTO）。
    const mapRowNow = selectOne(seed.db, 'maps', BRANCH, MAP_SITE);
    const locationsForContext = [SITE, BLD, YARD].map((id) => loc(id, {
      ...(id === SITE ? { name: '驿站', kind: 'other' } : {}),
      ...(id === BLD ? { name: '驿站客栈', kind: 'building', parent_location_id: SITE } : {}),
      ...(id === YARD ? { name: '停靠场院', kind: 'other', parent_location_id: SITE } : {}),
      map_id: id === SITE ? null : MAP_SITE,
    }));
    const built = Kit.buildLayoutContext({
      scope: SCOPE, mapRow: { ...mapRowNow, frame_json: JSON.parse(mapRowNow.frame_json) },
      locations: locationsForContext, characters: [], items: [], routes: [],
    });
    assert.equal(built.ok, true, JSON.stringify(built.issues));
    const generated = Kit.generateOverview({
      surface: 'mixed',
      zones: [
        { id: BLD, name: '驿站客栈', role: 'other', size: 'medium', sector: 'north' },
        { id: YARD, name: '停靠场院', role: 'land', size: 'medium', sector: 'south' },
      ],
    }, built.context);
    assert.equal(generated.ok, true, JSON.stringify(generated.issues));
    const saved = Kit.buildSceneMutation({
      result: generated, mapRow: { ...mapRowNow, frame_json: JSON.parse(mapRowNow.frame_json) },
      scope: SCOPE, currentScope: SCOPE, turnId: TURN, operationId: 'op_site_scene', expectedRowRev: 1,
    });
    assert.equal(saved.ok, true, JSON.stringify(saved.issues));
    const sceneFrame = saved.mutation.after.frame_json;
    assert.ok(sceneFrame.atlasScene, '真实生成的概览场景必须落在 frame 里');
    seed.db.run('UPDATE maps SET frame_json = ?, row_rev = row_rev + 1 WHERE branch_id = ? AND id = ?',
      [JSON.stringify(sceneFrame), BRANCH, MAP_SITE]);

    // ① 非法模式：明确拒绝，frame 逐字节不变。
    const before = selectOne(seed.db, 'maps', BRANCH, MAP_SITE).frame_json;
    assert.throws(() => compileSqlSceneMaps({
      db: seed.db, branchId: BRANCH, turnId: TURN, clockS: 0,
      makeId: (kind, opId, alias) => `${kind}_${alias}`,
      profile: { mapId: MAP_SITE, mode: 'parking' },
    }), (error) => error.code === 'INVALID_PAYLOAD' && /枚举/.test(error.message),
    '未支持的 role=parking 不能被当成合法档案写进去');
    assert.equal(selectOne(seed.db, 'maps', BRANCH, MAP_SITE).frame_json, before, '拒绝时不得改动存档');
    assert.equal(normalizeRequestedProfileMode('驿站'), null, '名字不能当档案');

    // ② 合法切换：只写档案命名空间，旧 scene 原样保留（等下一轮候选成功才换图）。
    const out = writeProfile(seed, MAP_SITE, 'compound', 'attempt_profile_ok');
    assert.equal(out.applied.groups[0].changedRows, 1, JSON.stringify(out.applied));
    const afterFrame = frameOf(seed, MAP_SITE);
    assert.equal(afterFrame[SPATIAL_PROFILE_FRAME_KEY].mode, 'compound');
    assert.equal(afterFrame[SPATIAL_PROFILE_FRAME_KEY].basis, 'author');
    assert.deepEqual(afterFrame.atlasScene, sceneFrame.atlasScene, '切档案不得顺手改写已保存场景');

    // ②′ 下一轮布局写回场景时，档案命名空间必须**存活**（否则一次重画就把作者的选择抹了）。
    const relayout = Kit.compileSceneGroup({
      request: { kind: 'overview', spec: { surface: 'forest', zones: [{ id: YARD, name: '停靠场院', role: 'land', size: 'medium', sector: 'south' }] } },
      scope: SCOPE, currentScope: SCOPE,
      mapRow: { ...selectOne(seed.db, 'maps', BRANCH, MAP_SITE), frame_json: afterFrame },
      locations: locationsForContext, characters: [], items: [], routes: [],
      turnId: TURN, operationId: 'op_profile_survive',
    });
    assert.equal(relayout.ok, true, JSON.stringify(relayout.issues));
    const mapsMutation = relayout.group.mutations.find((mutation) => mutation.table === 'maps');
    assert.ok(mapsMutation, `重画必须产生 maps 变更：${JSON.stringify(relayout.group.mutations.map((m) => m.table))}`);
    const relayoutFrame = typeof mapsMutation.after.frame_json === 'string'
      ? JSON.parse(mapsMutation.after.frame_json) : mapsMutation.after.frame_json;
    assert.equal(relayoutFrame[SPATIAL_PROFILE_FRAME_KEY].mode, 'compound', '重画场景不得抹掉作者选的档案');

    // ③ 作者预览立刻可见；POV 只看到"这类空间叫什么"，看不到作者依据与内部枚举。
    const ctx = { db: seed.db, branchId: BRANCH, revision: 0, viewMode: 'author', povId: null };
    const author = queryMapView(ctx, { kind: 'map', branchId: BRANCH, mapId: MAP_SITE }).items[0];
    assert.equal(author.profile.mode, 'compound');
    assert.equal(author.profile.basis, 'author');
    assert.equal(author.profile.layoutKind, 'overview');
    assert.deepEqual([...author.profile.responsibility].sort(), ['entrances', 'footprints', 'surface'].sort());
    const pov = queryMapView({ ...ctx, viewMode: 'pov' }, { kind: 'map', branchId: BRANCH, mapId: MAP_SITE }).items[0];
    assert.equal(pov.profile.mode, 'compound', 'POV 仍要知道这是复合场所');
    assert.equal(pov.profile.basis, null, 'POV 不下发作者依据');
    assert.deepEqual(pov.profile.responsibility, []);
    assert.deepEqual(pov.profile.unsupported, []);

    // ④ 回退：journal 的逆变更必须把档案撤掉，场景仍逐字节一致。
    // 回退发生在**新的 turn** 里（真实 /sql/rollback 就是这样），否则幂等键会把它当重复。
    insertTurn(seed.db, 'turn_profile_rollback');
    const inverse = {
      ...out.group, id: 'scene_maps_profile_rollback', opIds: ['scene_maps_profile_rollback'],
      mutations: out.group.mutations.map((mutation) => ({ ...mutation, before: mutation.after, after: mutation.before })),
    };
    const rolled = applyGroups(seed.db, [inverse], applyCtx('attempt_profile_rollback', 'turn_profile_rollback'));
    assert.equal(rolled.groups[0].status, 'applied', JSON.stringify(rolled));
    const revertedFrame = frameOf(seed, MAP_SITE);
    assert.equal(SPATIAL_PROFILE_FRAME_KEY in revertedFrame, false, '回退后档案命名空间必须消失');
    assert.deepEqual(revertedFrame.atlasScene, sceneFrame.atlasScene, '回退后场景逐字节一致');
    const afterRollback = deriveLayoutSites(createTableReadPort(seed.db), BRANCH);
    assert.equal(entryOf(afterRollback, MAP_SITE).profile.profile.mode, 'unknown', '档案撤销后回到中性概览');
  } finally {
    seed.close();
  }
});

// ───────────────────────── SITE04 · 缺资料与不猜 ─────────────────────────

test('SITE04 缺资料是 unknown；名字相似不自动确认；不新造 SQL 实体', async () => {
  const seed = await siteSeed();
  try {
    const counts = () => ({
      locations: countRows(seed.db, 'locations', BRANCH),
      maps: countRows(seed.db, 'maps', BRANCH),
      routes: countRows(seed.db, 'routes', BRANCH),
      characters: countRows(seed.db, 'characters', BRANCH),
      items: countRows(seed.db, 'items', BRANCH),
      entityKeys: countRows(seed.db, 'entity_keys', BRANCH),
    });
    const before = counts();

    // 名字叫「复合驿站」，地点叫「驿站庭院」——名字从不参与判断。
    const nothing = resolveSpatialProfile({
      map: { id: MAP_GHOST, name: '复合驿站', frame_json: {} },
      container: { id: GHOST, name: '驿站庭院', kind: 'other' },
      members: [], routes: [],
    });
    assert.equal(nothing.profile.mode, 'unknown', '只有 other 这种中性类型默认，不按名字升格成 compound');
    assert.equal(nothing.profile.basis, 'typed-default');
    assert.equal(nothing.layoutKind, 'overview');

    // 连容器类型都没有 → 中性 unknown（不假装已确认用途/尺寸/地形）。
    const neutral = resolveSpatialProfile({ map: { id: 'M_NONE', frame_json: {} }, container: null, members: [], routes: [] });
    assert.equal(neutral.profile.mode, 'unknown');
    assert.equal(neutral.profile.basis, 'neutral');
    assert.ok(neutral.issues.some((item) => item.code === 'SPATIAL_PROFILE_NEUTRAL'));

    // 作者档案仍然生效，但世界实体一个都不新增。
    writeProfile(seed, MAP_GHOST, 'compound', 'attempt_profile_ghost');
    const derived = deriveLayoutSites(createTableReadPort(seed.db), BRANCH);
    assert.equal(entryOf(derived, MAP_GHOST).profile.profile.mode, 'compound');
    assert.equal(entryOf(derived, MAP_GHOST).kind, 'overview');
    assert.deepEqual(counts(), before, '切档案绝不新造 SQL 地点/地图/路线/人物/物品');
    assert.equal(selectOne(seed.db, 'locations', BRANCH, GHOST).kind, 'other', '档案不改变地点 kind');
  } finally {
    seed.close();
  }
});

// ───────────────────────── resolver 与读写（唯一权威面） ─────────────────────────

test('档案 resolver：类型默认 city 不被降级；读写拒绝非法档案；走廊绑定是可信来源', () => {
  // city/district 的类型默认有专属布局 kind：档案层不声称已确认用途，但布局不能被降级成概览。
  const city = resolveSpatialProfile({ map: { id: 'M_CITY', frame_json: {} }, container: { id: 'L_CITY', kind: 'city' }, members: [], routes: [] });
  assert.equal(city.profile.mode, 'unknown');
  assert.equal(city.profile.basis, 'typed-default');
  assert.equal(city.layoutKind, 'city');
  // 作者显式选概览时，作者的裁决优先于类型默认。
  const authored = resolveSpatialProfile({
    map: { id: 'M_CITY', frame_json: { [SPATIAL_PROFILE_FRAME_KEY]: { version: 1, mode: 'outdoor', basis: 'author' } } },
    container: { id: 'L_CITY', kind: 'city' }, members: [], routes: [],
  });
  assert.equal(authored.profile.mode, 'outdoor');
  assert.equal(authored.layoutKind, 'overview');

  // 绑定真实走廊 → 通行空间（可信关系来源，优先于类型默认，但不覆盖作者选择）。
  const corridor = resolveSpatialProfile({
    map: { id: 'M_HALL', frame_json: { atlasScene: { layout: { corridor: { entityId: 'L_CORR' } } } } },
    container: { id: 'L_SITE', kind: 'other' }, members: [], routes: [],
  });
  assert.equal(corridor.profile.mode, 'circulation');
  assert.equal(corridor.profile.basis, 'source-supported');
  assert.equal(corridor.layoutKind, 'floor');
  assert.equal(boundCorridorIdOf({ frame_json: { atlasScene: { layout: { corridor: { entityId: 'L_CORR' } } } } }), 'L_CORR');

  // 读写：非法版本/模式一律不采用，绝不猜。
  assert.equal(readSpatialProfile({ [SPATIAL_PROFILE_FRAME_KEY]: { version: 2, mode: 'outdoor', basis: 'author' } }).profile, null);
  assert.equal(readSpatialProfile({ [SPATIAL_PROFILE_FRAME_KEY]: { version: 1, mode: '驿站', basis: 'author' } }).profile, null);
  const written = writeSpatialProfile({ cols: 4 }, { version: 1, mode: 'linear', basis: 'author' });
  assert.equal(written.ok, true);
  assert.deepEqual(written.frame, { cols: 4, [SPATIAL_PROFILE_FRAME_KEY]: { version: 1, mode: 'linear', basis: 'author' } });
  assert.equal(writeSpatialProfile({}, { version: 2, mode: 'linear', basis: 'author' }).ok, false);
});
