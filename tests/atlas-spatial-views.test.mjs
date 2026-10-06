/**
 * atlas-spatial-views.test.mjs — M4/Q13：只读数据口的隔离、分页与坐标验收。
 *
 * 全部走真实 SQL seed（不 mock 视图）：
 * - scene：POV 序列化全文扫不出隐藏实体名/ID、inputSignature、spec；author 仍可见；
 * - 同 revision：修订不符一律空视图；
 * - 父子地图 / 多楼层：地点详情带回子地图与地面物品；
 * - routes/items 字段：可绘制几何、坏几何单项 issue、地面物品带 locationId、frame 已剥离；
 * - catalog：2001 条能翻到末页且不重复；POV 不给总数；
 * - diagnostics：60 条失败轮（>旧 50 上限）能翻完；
 * - 纯查询：四次读口跑完，存档字节与 turn_changes 行数一间不变。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, insertRows } from './fixtures/atlas-sql/seed.mjs';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { queryMapView, queryEntityDetail, queryDiagnostics } from '../src/atlas-db-views.ts';
import { querySpatialScene } from '../src/atlas-spatial-views.ts';
import { queryCatalog } from '../src/atlas-catalog-views.ts';
import { querySpatialFlows } from '../src/atlas-spatial-flow-views.ts';
import { queryTasks } from '../src/atlas-task-views.ts';

const SQL = await (await import('sql.js')).default();
const BRANCH = IDS.branchMain;

async function seeded() {
  const seed = await makeSeedWith(SQL);
  const branch = queryBound(seed.db, 'SELECT revision, clock_s, pov_character_id FROM branches WHERE id = ?', [BRANCH])[0];
  const ctx = {
    db: seed.db,
    branchId: BRANCH,
    revision: Number(branch.revision),
    viewMode: 'author',
    povId: String(branch.pov_character_id ?? IDS.C1),
    chatId: IDS.chatA,
  };
  return { seed, ctx };
}

function povCtx(ctx) {
  return { ...ctx, viewMode: 'pov' };
}

const HIDDEN = {
  room: 'L_SECRET',
  roomName: '密室',
  actor: 'C_SECRET',
  actorName: '潜伏者',
  item: 'I_SECRET',
  itemName: '暗格钥匙',
  signature: 'SECRET-SIG-DO-NOT-LEAK',
};

/** 业务表插行前先登记 entity_keys（触发器会校验 kind 一致）。 */
function addKeys(db, kind, ids) {
  insertRows(db, 'entity_keys', ids.map((id) => ({ branch_id: BRANCH, id, kind })));
}

/** 一间已知教室 + 一间密室（含隐藏人与物），外加一个待生成请求。 */
function classroomScene() {
  return {
    kind: 'atlas-scene',
    version: 1,
    generator: 'atlas-spatial-kit/1',
    mapId: IDS.M2,
    branchId: BRANCH,
    sourceRevision: 0,
    units: 'cells',
    metersPerCell: 1,
    metricQuality: 'confirmed',
    inputSignature: HIDDEN.signature,
    layout: {
      kind: 'floor',
      id: IDS.M2,
      name: '教室图',
      bounds: { x: 0, y: 0, w: 20, h: 15 },
      corridor: { x: 0, y: 6, w: 20, h: 3 },
      rooms: [
        { id: IDS.L3, name: '教室', x: 0, y: 0, w: 12, h: 8, side: 'north' },
        { id: HIDDEN.room, name: HIDDEN.roomName, x: 12, y: 8, w: 6, h: 6, side: 'south' },
      ],
      groups: [],
      bodies: [],
      doors: [],
      windows: [],
      lamps: [],
      doorSwings: [],
      actors: [
        { id: IDS.C3, name: '同学丙', roomId: IDS.L3, x: 4, y: 4, quality: 'layout' },
        { id: HIDDEN.actor, name: HIDDEN.actorName, roomId: HIDDEN.room, x: 14, y: 10, quality: 'layout' },
      ],
      items: [
        { id: 'I_GROUND', name: '粉笔盒', roomId: IDS.L3, x: 2, y: 2, quality: 'layout' },
        { id: HIDDEN.item, name: HIDDEN.itemName, roomId: HIDDEN.room, x: 15, y: 11, quality: 'layout' },
      ],
      path: [],
    },
  };
}

/** 把主角放进教室，并给主角补上「知道教室与同学丙」的认知，密室一律不给。 */
function seedPovKnowledge(db) {
  const turnId = IDS.seedTurn;
  queryBound(db, 'UPDATE characters SET location_id = ?, map_id = ?, grid_x = 5, grid_y = 6, coord_precision = ? WHERE branch_id = ? AND id = ?', [
    IDS.L3, IDS.M2, 'exact', BRANCH, IDS.C1,
  ]);
  queryBound(db, 'UPDATE characters SET location_id = ?, map_id = ?, grid_x = 6, grid_y = 6, coord_precision = ? WHERE branch_id = ? AND id = ?', [
    IDS.L3, IDS.M2, 'exact', BRANCH, IDS.C3,
  ]);
  insertRows(db, 'entity_keys', [
    { branch_id: BRANCH, id: HIDDEN.actor, kind: 'character' },
    { branch_id: BRANCH, id: HIDDEN.item, kind: 'item' },
    { branch_id: BRANCH, id: HIDDEN.room, kind: 'location' },
    { branch_id: BRANCH, id: 'I_GROUND', kind: 'item' },
  ]);
  insertRows(db, 'locations', [{
    branch_id: BRANCH, id: HIDDEN.room, row_rev: 1, created_turn_id: turnId, updated_turn_id: turnId,
    name: HIDDEN.roomName, aliases_json: '[]', kind: 'room', description: '', parent_location_id: IDS.L2,
    mobility: 'fixed', anchor_location_id: null, map_id: IDS.M2, grid_x: 14, grid_y: 10, coord_precision: 'exact',
    uncertainty_radius_cells: null, area_geometry_json: null, terrain: 'unknown', access_rules_json: null,
    vehicle_profile_json: null, existence_quality: 'confirmed', status: 'active', merged_into_id: null,
  }]);
  insertRows(db, 'characters', [{
    branch_id: BRANCH, id: HIDDEN.actor, row_rev: 1, created_turn_id: turnId, updated_turn_id: turnId,
    name: HIDDEN.actorName, aliases_json: '[]', role: 'npc', importance: 'supporting', importance_reason: '',
    identity: '', description: '', personality: '', thought: '', action_tendency: '', condition_note: '',
    physical_status: 'alive', coord_precision: 'exact', mobility_profiles_json: '[]', capabilities_json: '[]',
    location_id: HIDDEN.room, map_id: IDS.M2, grid_x: 14, grid_y: 10, uncertainty_radius_cells: null,
    status: 'active', merged_into_id: null,
  }]);
  insertRows(db, 'items', [{
    branch_id: BRANCH, id: HIDDEN.item, row_rev: 1, created_turn_id: turnId, updated_turn_id: turnId,
    name: HIDDEN.itemName, aliases_json: '[]', kind: 'object', unit: '', coord_precision: 'exact',
    properties_json: '[]', description: '', quantity: 1, condition_note: '', owner_entity_id: null,
    holder_character_id: null, container_item_id: null, location_id: HIDDEN.room, map_id: IDS.M2,
    grid_x: 15, grid_y: 11, uncertainty_radius_cells: null, status: 'active', merged_into_id: null,
  }]);
  const info = (id, subject, title) => ({
    branch_id: BRANCH, id, row_rev: 1, created_turn_id: turnId, updated_turn_id: turnId,
    kind: 'observation', title, content: title, truth_status: 'true', secrecy: 'public',
    topic_key: `topic_${id}`, content_hash: `hash_${id}`, subject_entity_id: subject,
    payload_json: '{}', created_at_s: 0, status: 'active',
  });
  insertRows(db, 'information', [info('INFO_L3', IDS.L3, '教室'), info('INFO_C3', IDS.C3, '同学丙')]);
  const know = (id, informationId) => ({
    branch_id: BRANCH, id, row_rev: 1, created_turn_id: turnId, updated_turn_id: turnId,
    is_pov: 0, knower_character_id: IDS.C1, information_id: informationId,
    first_received_at_s: 0, belief: 'heard', attention: 'normal', reaction_note: '', status: 'active',
  });
  insertRows(db, 'knowledge', [know('K_L3', 'INFO_L3'), know('K_C3', 'INFO_C3')]);
}

function writeSceneFrame(db, mapId, scene, extra = {}) {
  const frame = { origin_x: 0, origin_y: 0, reference_width_cells: 20, reference_height_cells: 15, ...extra };
  if (scene) frame.atlasScene = scene;
  queryBound(db, 'UPDATE maps SET frame_json = ? WHERE branch_id = ? AND id = ?', [JSON.stringify(frame), BRANCH, mapId]);
}

test('Q13-01 scene：POV 序列化全文扫不出隐藏实体、inputSignature 与待生成 spec；author 仍可见', async () => {
  const { seed, ctx } = await seeded();
  try {
    seedPovKnowledge(seed.db);
    writeSceneFrame(seed.db, IDS.M2, classroomScene(), { atlasLayoutRequest: { requestId: 'R1', status: 'pending', spec: { rooms: [HIDDEN.roomName] } } });

    const author = querySpatialScene(ctx, { kind: 'scene', branchId: BRANCH, mapId: IDS.M2 });
    const authorJson = JSON.stringify(author);
    assert.ok(authorJson.includes(HIDDEN.signature), 'author 必须能看到（否则本测试是假阳性）');
    assert.ok(authorJson.includes(HIDDEN.roomName));

    const pov = querySpatialScene(povCtx(ctx), { kind: 'scene', branchId: BRANCH, mapId: IDS.M2 });
    const povJson = JSON.stringify(pov);
    for (const secret of [HIDDEN.signature, HIDDEN.room, HIDDEN.roomName, HIDDEN.actor, HIDDEN.actorName, HIDDEN.item, HIDDEN.itemName]) {
      assert.ok(!povJson.includes(secret), `POV 响应泄漏：${secret}`);
    }
    for (const key of ['atlasLayoutRequest', 'atlasScene', 'inputSignature', '"spec"', 'structureKey']) {
      assert.ok(!povJson.includes(key), `POV 响应带了内部字段：${key}`);
    }
    const item = pov.items.find((entry) => entry.mapId === IDS.M2);
    assert.equal(item.sceneStatus, 'ready');
    assert.ok(JSON.stringify(item.scene).includes(IDS.L3), '已知教室仍应可见');
    assert.ok(!JSON.stringify(item.scene).includes('密室'));
  } finally {
    seed.close();
  }
});

test('Q13-02 同 revision：修订不符返回空视图，绝不拿上一修订当现状', async () => {
  const { seed, ctx } = await seeded();
  try {
    writeSceneFrame(seed.db, IDS.M2, classroomScene());
    const stale = querySpatialScene(ctx, { kind: 'scene', branchId: BRANCH, revision: ctx.revision + 1 });
    assert.deepEqual(stale.items, []);
    assert.equal(stale.metadata.stale, true);
    const ok = querySpatialScene(ctx, { kind: 'scene', branchId: BRANCH, revision: ctx.revision });
    assert.ok(ok.items.length > 0);
    assert.equal(ok.revision, ctx.revision);
    // 旧 sourceRevision 的场景允许静态复用，不因版本旧被判死。
    const item = ok.items.find((entry) => entry.mapId === IDS.M2);
    assert.equal(item.scene.sourceRevision, 0);
    assert.equal(item.sceneStatus, 'ready');
  } finally {
    seed.close();
  }
});

test('Q13-02b 无 scene 的旧档是合法状态：sceneStatus=missing 且仍带回 SQL 概览名单', async () => {
  const { seed, ctx } = await seeded();
  try {
    writeSceneFrame(seed.db, IDS.M2, null);
    const view = querySpatialScene(ctx, { kind: 'scene', branchId: BRANCH, mapId: IDS.M2 });
    const item = view.items.find((entry) => entry.mapId === IDS.M2);
    assert.equal(item.scene, null);
    assert.equal(item.sceneStatus, 'missing');
    assert.ok(Array.isArray(item.coarseList));
    const bad = querySpatialScene(ctx, { kind: 'scene', branchId: BRANCH, mapId: IDS.M1 });
    assert.equal(bad.items.find((entry) => entry.mapId === IDS.M1).sceneStatus, 'missing');
  } finally {
    seed.close();
  }
});

test('Q13-03 父子地图与多楼层：地点详情带回子地图、地面物品，且不把人物库存当地面标点', async () => {
  const { seed, ctx } = await seeded();
  try {
    insertRows(seed.db, 'entity_keys', [{ branch_id: BRANCH, id: 'I_GROUND', kind: 'item' }, { branch_id: BRANCH, id: 'I_HELD', kind: 'item' }]);
    insertRows(seed.db, 'items', [
      {
        branch_id: BRANCH, id: 'I_GROUND', row_rev: 1, created_turn_id: IDS.seedTurn, updated_turn_id: IDS.seedTurn,
        name: '粉笔盒', aliases_json: '[]', kind: 'object', unit: '', coord_precision: 'exact',
        properties_json: '[]', description: '', quantity: 1, condition_note: '', owner_entity_id: null,
        holder_character_id: null, container_item_id: null, location_id: IDS.L3, map_id: IDS.M2,
        grid_x: 2, grid_y: 2, uncertainty_radius_cells: null, status: 'active', merged_into_id: null,
      },
      {
        branch_id: BRANCH, id: 'I_HELD', row_rev: 1, created_turn_id: IDS.seedTurn, updated_turn_id: IDS.seedTurn,
        name: '随身钢笔', aliases_json: '[]', kind: 'object', unit: '', coord_precision: 'unknown',
        properties_json: '[]', description: '', quantity: 1, condition_note: '', owner_entity_id: null,
        holder_character_id: IDS.C1, container_item_id: null, location_id: null, map_id: null,
        grid_x: null, grid_y: null, uncertainty_radius_cells: null, status: 'active', merged_into_id: null,
      },
    ]);
    const detail = queryEntityDetail(ctx, { kind: 'entity', branchId: BRANCH, entityId: IDS.L3 });
    const item = detail.items[0];
    const groundIds = item.groundItems.map((entry) => String(entry.id));
    assert.ok(groundIds.includes('I_GROUND'), '地面物品必须列出来');
    assert.ok(!groundIds.includes('I_HELD'), '手持物品不能算地面物品');
    assert.ok(item.childMaps.some((map) => map.mapId === IDS.M2), '地点详情要给出子地图（多楼层）');
    assert.equal(item.childMaps.length, 1);

    const character = queryEntityDetail(ctx, { kind: 'entity', branchId: BRANCH, entityId: IDS.C1 });
    assert.ok(character.items[0].heldItems.some((entry) => String(entry.id) === 'I_HELD'));
    const mapView = queryMapView(ctx, { kind: 'map', branchId: BRANCH });
    const classroom = mapView.items.find((entry) => entry.mapId === IDS.M2);
    const markers = classroom.points.filter((point) => point.kind === 'item').map((point) => point.entityId);
    assert.ok(!markers.includes('I_HELD'), '人物库存不能同时作为地面标点');
  } finally {
    seed.close();
  }
});

test('Q13-04 routes/items 字段：好几何可绘、坏几何单项 issue、地面物品带 locationId、frame 已剥离', async () => {
  const { seed, ctx } = await seeded();
  try {
    const overview = {
      ...classroomScene(),
      mapId: IDS.M1,
      layout: { kind: 'overview', id: IDS.M1, name: '世界图', bounds: { x: 0, y: 0, w: 120, h: 80 }, pins: [], shapes: [], routes: [] },
    };
    writeSceneFrame(seed.db, IDS.M1, overview, { atlasLayoutRequest: { requestId: 'R0', status: 'pending', spec: { rooms: ['圣光学校'] } } });
    queryBound(seed.db, 'UPDATE routes SET geometry_json = ? WHERE branch_id = ? AND id = ?', [
      JSON.stringify({ kind: 'line', coordinates: [[10, 10], [12, 11]] }), BRANCH, IDS.R_AB,
    ]);
    insertRows(seed.db, 'routes', [{
      branch_id: BRANCH, id: 'R_BAD', row_rev: 1, created_turn_id: IDS.seedTurn, updated_turn_id: IDS.seedTurn,
      from_location_id: IDS.L2, to_location_id: IDS.L3, kind: 'path', bidirectional: 1, map_id: IDS.M1,
      geometry_json: '{not json', geometry_quality: 'unknown', geometry_rev: 1, distance_m: null,
      distance_min_m: null, distance_max_m: null, distance_basis: 'narrative', terrain: 'road',
      allowed_modes_json: '[]', access_rules_json: null, travel_time_override_json: null, status: 'open', status_reason: '',
    }]);
    // 地面物品：落在叶子地图（教室）容器地点里，由布局给出视觉锚点，并带回归属地点。
    insertRows(seed.db, 'entity_keys', [{ branch_id: BRANCH, id: 'I_GROUND', kind: 'item' }]);
    insertRows(seed.db, 'items', [{
      branch_id: BRANCH, id: 'I_GROUND', row_rev: 1, created_turn_id: IDS.seedTurn, updated_turn_id: IDS.seedTurn,
      name: '粉笔盒', aliases_json: '[]', kind: 'object', unit: '', coord_precision: 'unknown',
      properties_json: '[]', description: '', quantity: 1, condition_note: '', owner_entity_id: null,
      holder_character_id: null, container_item_id: null, location_id: IDS.L3, map_id: null,
      grid_x: null, grid_y: null, uncertainty_radius_cells: null, status: 'active', merged_into_id: null,
    }]);

    const world = queryMapView(ctx, { kind: 'map', branchId: BRANCH, mapId: IDS.M1 });
    const map = world.items[0];
    const good = map.routes.find((route) => route.routeId === IDS.R_AB);
    assert.ok(good.geometry, '有效 line 几何必须可绘');
    assert.equal(good.geometry.mapId, IDS.M1);
    assert.equal(good.geometry.units, 'cells');
    assert.equal(good.geometry.points.length, 2);
    const bad = map.routes.find((route) => route.routeId === 'R_BAD');
    assert.equal(bad.geometry, null, 'unknown/坏几何绝不画假线');
    assert.ok(world.metadata.routeIssues.some((issue) => issue.routeId === 'R_BAD'), '坏几何要给逐路由 issue');

    const raw = JSON.stringify(map.frames.frame);
    assert.ok(!raw.includes('atlasScene'), '普通 map 响应不含 atlasScene');
    assert.ok(!raw.includes('atlasLayoutRequest'), '普通 map 响应不含布局请求');

    const classroom = queryMapView(ctx, { kind: 'map', branchId: BRANCH, mapId: IDS.M2 }).items[0];
    const bench = classroom.points.find((point) => point.entityId === 'I_GROUND');
    assert.ok(bench, '地面物品要出现在所属地图上');
    assert.equal(bench.locationId, IDS.L3, '地面物品必须带归属地点');
  } finally {
    seed.close();
  }
});

test('Q13-05 catalog：2001 条能翻到末页、不重复；POV 不给总数', async () => {
  const { seed, ctx } = await seeded();
  try {
    const extra = [];
    const extraKeys = [];
    for (let i = 0; i < 2001; i += 1) {
      const id = `LX${String(i).padStart(4, '0')}`;
      extraKeys.push({ branch_id: BRANCH, id, kind: 'location' });
      extra.push({
        branch_id: BRANCH, id: `LX${String(i).padStart(4, '0')}`, row_rev: 1, created_turn_id: IDS.seedTurn, updated_turn_id: IDS.seedTurn,
        name: `目录地点${String(i).padStart(4, '0')}`, aliases_json: '[]', kind: 'room', description: '', parent_location_id: null,
        mobility: 'fixed', anchor_location_id: null, map_id: null, grid_x: null, grid_y: null, coord_precision: 'unknown',
        uncertainty_radius_cells: null, area_geometry_json: null, terrain: 'unknown', access_rules_json: null,
        vehicle_profile_json: null, existence_quality: 'confirmed', status: 'active', merged_into_id: null,
      });
    }
    insertRows(seed.db, 'entity_keys', extraKeys);
    insertRows(seed.db, 'locations', extra);

    const seen = [];
    let cursor;
    let pages = 0;
    do {
      const page = queryCatalog(ctx, { kind: 'catalog', branchId: BRANCH, entityKind: 'location', limit: 200, cursor });
      for (const entry of page.items) seen.push(entry.entityId);
      cursor = page.nextCursor;
      pages += 1;
      assert.ok(pages < 40, '分页没有收敛');
    } while (cursor);
    assert.equal(seen.length, 2004, '三个种子地点 + 2001 条 = 2004');
    assert.equal(new Set(seen).size, seen.length, '游标翻页不能重复导出同一条');
    assert.ok(seen.includes('LX2000'), '必须能翻到末页');

    const found = queryCatalog(ctx, { kind: 'catalog', branchId: BRANCH, entityKind: 'location', q: '教室' });
    assert.ok(found.items.some((entry) => entry.entityId === IDS.L3), '搜索要能找到不在当前地图的可见实体');

    const pov = queryCatalog(povCtx(ctx), { kind: 'catalog', branchId: BRANCH, entityKind: 'location' });
    assert.equal(pov.metadata.scanned, undefined, 'POV 不返回扫描总数');
    const povJson = JSON.stringify(pov);
    assert.ok(!povJson.includes('LX'), 'POV 目录不能吐出未认知实体');
  } finally {
    seed.close();
  }
});

test('Q13-06 diagnostics：60 条失败轮（超过旧的 50 上限）能翻完且不重复', async () => {
  const { seed, ctx } = await seeded();
  try {
    const turns = [];
    for (let i = 0; i < 60; i += 1) {
      turns.push({
        id: `FT${String(i).padStart(3, '0')}`, branch_id: BRANCH, parent_turn_id: null, host_message_uid: null, host_variant_key: null,
        kind: 'manual', input_hash: `h${i}`, story_hash: null, base_revision: 0, committed_revision: null, clock_before_s: 0,
        elapsed_json: '{}', clock_after_s: 0, rng_seed: `rng${i}`, ruleset_version: 'atlas-1', decisions_json: '{}',
        receipt_json: JSON.stringify({ turnId: `FT${i}`, status: 'partial', coreCommitted: true, groups: [{ groupId: `G${i}`, status: 'rejected', issues: [{ code: 'CHECK_FAILED', path: '$.field', message: '字段校验失败' }] }] }),
        attempts_json: '[]', status: 'partial', created_wall_ms: 1_700_000_000_000 + i, prepared_wall_ms: 1_700_000_000_000 + i,
      });
    }
    insertRows(seed.db, 'turns', turns);
    queryBound(seed.db, 'UPDATE branches SET revision = ? WHERE id = ?', [ctx.revision, BRANCH]);

    const seen = [];
    let cursor;
    let pages = 0;
    do {
      const page = queryDiagnostics(ctx, { kind: 'diagnostics', branchId: BRANCH, limit: 20, cursor });
      for (const entry of page.items) if (entry.kind === 'failed_turn') seen.push(entry.logId);
      cursor = page.nextCursor;
      pages += 1;
      assert.ok(pages < 30, '失败轮分页没有收敛');
    } while (cursor);
    assert.equal(seen.length, 60, `60 条失败轮必须全部可见（实际 ${seen.length}）`);
    assert.equal(new Set(seen).size, 60, '同一条记录不能跨页重复导出');

    const first = queryDiagnostics(ctx, { kind: 'diagnostics', branchId: BRANCH, limit: 20 });
    const issues = first.items.filter((entry) => entry.kind === 'issue');
    assert.ok(issues.length >= 1, '回执里的 groups/issues 要摊平成独立日志条目');
    assert.ok(issues.every((entry) => entry.code && entry.path && entry.groupId), '问题条目要带完整路径与组');
    assert.equal(first.metadata.droppedCount, 0);
    assert.equal(first.metadata.exportComplete, true);
  } finally {
    seed.close();
  }
});

test('Q13-07 纯查询无写：四个读口跑完，存档字节与 turn_changes 行数一间不变', async () => {
  const { seed, ctx } = await seeded();
  try {
    seedPovKnowledge(seed.db);
    writeSceneFrame(seed.db, IDS.M2, classroomScene());
    const beforeBytes = Buffer.from(seed.db.export()).toString('base64');
    const beforeChanges = Number(queryBound(seed.db, 'SELECT COUNT(*) AS n FROM turn_changes')[0].n);
    const beforeTurns = Number(queryBound(seed.db, 'SELECT COUNT(*) AS n FROM turns')[0].n);

    const queries = [
      () => querySpatialScene(ctx, { kind: 'scene', branchId: BRANCH }),
      () => querySpatialScene(povCtx(ctx), { kind: 'scene', branchId: BRANCH }),
      () => queryCatalog(ctx, { kind: 'catalog', branchId: BRANCH }),
      () => querySpatialFlows(ctx, { kind: 'flows', branchId: BRANCH, mapId: IDS.M1 }),
      () => queryTasks(ctx, { kind: 'tasks', branchId: BRANCH }),
    ];
    for (const run of queries) run();
    const afterBytes = Buffer.from(seed.db.export()).toString('base64');
    assert.equal(afterBytes, beforeBytes, '读口不得写库');
    assert.equal(Number(queryBound(seed.db, 'SELECT COUNT(*) AS n FROM turn_changes')[0].n), beforeChanges);
    assert.equal(Number(queryBound(seed.db, 'SELECT COUNT(*) AS n FROM turns')[0].n), beforeTurns);

    // 等待再久，flow 进度也不自己往前走。
    const a = querySpatialFlows(ctx, { kind: 'flows', branchId: BRANCH, mapId: IDS.M1 });
    const b = querySpatialFlows(ctx, { kind: 'flows', branchId: BRANCH, mapId: IDS.M1 });
    assert.deepEqual(
      a.items.map((flow) => [flow.flowId, flow.progress]),
      b.items.map((flow) => [flow.flowId, flow.progress]),
      '只读口的 flow 进度必须稳定',
    );
    assert.equal(a.metadata.readOnly, true);
  } finally {
    seed.close();
  }
});
