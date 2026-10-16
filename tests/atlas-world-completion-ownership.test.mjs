/**
 * atlas-world-completion-ownership.test.mjs — P07 / R04：建设完成状态所属地图（OWN01–OWN05）。
 *
 * 缺陷（R04）：内部图有成功结果，但完成标记的读写指向错误所属图。
 * 旧实现读的时候用「地点唯一的容器图」，写的时候退回 `firstFocus.map_id`（外部图），
 * 于是一个建设好的内部空间把完成状态写在了它外面的世界图上，外部图还被当成整批的代表。
 *
 * 覆盖：
 * - OWN01 学校在外图 M1、内部图 M_SCHOOL；内部记录正确，外部状态一个字节不变；
 * - OWN02 两个焦点一好一坏，逐图分别记结果，批次 status 汇总为 partial；
 * - OWN03 内部图本轮新建 → 最终读写都落在这张新图上；无图 / 冲突 / 地点缺失都有明确诊断；
 * - OWN04 无变化再次建设正确复用（WORLD_CONSTRUCTION_NOT_NEEDED）；回退恢复内部图状态；
 * - OWN05 实际 handleSqlMapAction 的建设回执指向内部图，与仓库状态一致。
 *
 * 全程走真实路径：createSqlRepository.prepareTurn（含 sceneMaps 步骤）+ journal/回退 +
 * handleSqlMapAction 回执。夹具只用 seed 合成实体，不带任何用户文本。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { handleSqlMapAction } from '../src/atlas-sql-map-actions.ts';
import { createBrowserSqlHost } from '../src/atlas-browser-sql-host.ts';
import { loadAtlasSqlRuntime } from '../src/atlas-sql-session.ts';
import { ATLAS_RUNTIME_LIMITS } from '../src/atlas-runtime-limits.ts';
import { resolveCompletionMaps, completionMapIds } from '../src/atlas-world-completion-ownership.ts';
import { createTableReadPort } from '../src/atlas-db-readport.ts';
import { makeSeedWith, IDS, insertRows } from './fixtures/atlas-sql/seed.mjs';

const SQL = await (await import('sql.js')).default();
const BRANCH = IDS.branchMain;
const TURN = IDS.seedTurn;
const noop = '{"op":"noop"}';

const model = (fn) => ({ calls: [], async request(req) { this.calls.push(req); return { batchId: req.batchId, text: fn(req, this.calls.length), httpStatus: 200, durationMs: 1 }; } });

/**
 * 观察阶段 noop；建设阶段在**本批焦点**下补一个真实房间。
 * 焦点别名从提示词里取（`focus=L4`），不硬编码 alias —— 目录别名按 ID 排序分配，
 * 测试夹具一旦增删实体就会漂移。
 */
const buildModel = () => model((req) => {
  if (!req.batchId.startsWith('construction_')) return noop;
  const focus = (req.messages[1].content.match(/focus=([^、\n]+)/) ?? [])[1];
  if (!focus) return noop;
  return JSON.stringify({ op: 'location.upsert', ref: 'new:room', data: { name: '测试门厅', kind: 'room', parent_ref: focus } });
});

const POLICY = {
  version: 1, density: 'balanced',
  maxNewLocations: ATLAS_RUNTIME_LIMITS.newLocationsPerBatch,
  maxNewRoutes: ATLAS_RUNTIME_LIMITS.newRoutesPerBatch,
  maxAdditionalDepth: 2,
};

/** 只盯住给定焦点本身：不向下展开子地点，避免把无关图拉进断言。 */
const SHALLOW_POLICY = { ...POLICY, maxAdditionalDepth: 0 };

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

function mapRow(db, { id, container, name, scene = false, status = 'active' }) {
  insertRows(db, 'maps', [{
    branch_id: BRANCH, id, row_rev: 1, created_turn_id: TURN, updated_turn_id: TURN,
    name, kind: 'interior', container_location_id: container, description: '',
    frame_json: JSON.stringify({ origin_x: 0, origin_y: 0, reference_width_cells: 20, reference_height_cells: 15, ...(scene ? { atlasScene: { kind: 'atlas-scene', version: 1, generator: 'test', mapId: id, branchId: BRANCH, sourceRevision: 0, units: 'cells', metersPerCell: 1, metricQuality: 'estimated', inputSignature: 'test', layout: { kind: 'floor' } } } : {}) }),
    meters_per_cell: 1, scale_min_meters_per_cell: 1, scale_max_meters_per_cell: 1, scale_quality: 'confirmed',
    scale_basis_json: '{}', scale_locked: 0, calibration_rev: 1, background_asset_key: null, default_terrain: 'unknown', status,
  }]);
}

function locationRow(db, { id, name, kind = 'building', parent = null, mapId = IDS.M1 }) {
  insertRows(db, 'entity_keys', [{ branch_id: BRANCH, id, kind: 'location' }]);
  insertRows(db, 'locations', [{
    branch_id: BRANCH, id, row_rev: 1, created_turn_id: TURN, updated_turn_id: TURN,
    name, aliases_json: '[]', kind, description: '', parent_location_id: parent, mobility: 'fixed',
    anchor_location_id: null, map_id: mapId, grid_x: mapId ? 6 : null, grid_y: mapId ? 6 : null,
    coord_precision: mapId ? 'approximate' : 'unknown', uncertainty_radius_cells: null,
    area_geometry_json: null, terrain: 'unknown', access_rules_json: null, vehicle_profile_json: null,
    existence_quality: 'confirmed', status: 'active', merged_into_id: null,
  }]);
}

async function seeded(port, setup) {
  const seed = await makeSeedWith(SQL);
  setup?.(seed.db);
  const bytes = seed.exportBytes();
  seed.close();
  const repo = createSqlRepository({ chatUid: IDS.chatA, branchId: BRANCH, modelPort: port });
  await repo.open({ bytes });
  return repo;
}

const input = (extra = {}) => ({
  anchor: {
    chatUid: IDS.chatA, branchId: BRANCH, parentTurnId: TURN, hostMessageUid: 'own',
    variantKey: 'v1', baseRevision: 0, baseStorageRevision: 0, inputHash: 'own',
  },
  userText: '建设当前场所。', assistantText: '结构已登记。', sourceSnapshot: [],
  phaseBatches: [], manual: false, sceneOnly: true,
  worldCompletion: { mode: 'local', focusLocationIds: [IDS.L2], policy: POLICY },
  ...extra,
});

function readFrame(db, mapId) {
  const row = queryBound(db, 'SELECT frame_json FROM maps WHERE branch_id = ? AND id = ?', [BRANCH, mapId])[0];
  if (!row) return null;
  return typeof row.frame_json === 'string' ? JSON.parse(row.frame_json) : row.frame_json;
}

const fillOf = (db, mapId) => readFrame(db, mapId)?.atlasWorldFill ?? null;

/* ------------------------------------------------------------------ *
 * OWN01：内部图持有完成状态，外部图不变
 * ------------------------------------------------------------------ */

test('OWN01 内部场景成功：完成状态落在内部图，外层世界图一个字节不变', async () => {
  const repo = await seeded(buildModel(), (db) => {
    locationRow(db, { id: 'T_SCHOOL', name: '测试学校', kind: 'building', parent: null, mapId: IDS.M1 });
    mapRow(db, { id: 'M_SCHOOL', container: 'T_SCHOOL', name: '学校内部图', scene: true });
  });
  try {
    const outerBefore = JSON.stringify(readFrame(repo.db, IDS.M1));
    // 焦点没有子地点，不会向下展开：本轮只可能有一张所属图。
    const prepared = await repo.prepareTurn(input({ worldCompletion: { mode: 'local', focusLocationIds: ['T_SCHOOL'], policy: POLICY } }));
    const candidate = repo.getCandidate(prepared.token).db;

    const inner = fillOf(candidate, 'M_SCHOOL');
    assert.ok(inner, '内部图必须持有本轮建设状态');
    assert.equal(inner.status, 'ready', `内部有序且可绘制 → ready，实际 ${JSON.stringify(inner)}`);
    assert.equal(inner.contextHash.length > 0, true);
    assert.equal(inner.completedTurnId, prepared.receipt.turnId);

    assert.equal(fillOf(candidate, IDS.M1), null, '外层世界图不得被写入完成状态');
    assert.equal(fillOf(candidate, IDS.M2), null, '没被要求的图也不该被牵连');
    assert.equal(JSON.stringify(readFrame(candidate, IDS.M1)), outerBefore, '外层世界图 frame 必须原样');
    assert.equal(JSON.stringify(readFrame(repo.db, IDS.M1)), outerBefore, '基线库同样未被触碰');
    assert.equal(prepared.receipt.status, 'committed', `内部成功且无其他所属图 → 本批就是 committed：${prepared.receipt.issues.map((i) => i.code).join(',')}`);

    // 新房间落在内部坐标系里，完成状态说的就是它。
    const room = queryBound(candidate, 'SELECT parent_location_id FROM locations WHERE branch_id = ? AND name = ?', [BRANCH, '测试门厅'])[0];
    assert.equal(room.parent_location_id, 'T_SCHOOL');
  } finally { await repo.close(); }
});

/* ------------------------------------------------------------------ *
 * OWN02：逐图分别记结果，批次汇总 partial
 * ------------------------------------------------------------------ */

test('OWN02 两个焦点一好一坏：逐图分别记结果，批次 status 汇总为 partial', async () => {
  const repo = await seeded(buildModel(), (db) => {
    locationRow(db, { id: 'T_A', name: '测试甲楼', kind: 'building', parent: null, mapId: IDS.M1 });
    locationRow(db, { id: 'T_B', name: '测试乙楼', kind: 'building', parent: null, mapId: IDS.M1 });
    mapRow(db, { id: 'M_A', container: 'T_A', name: '甲楼内部图', scene: true });
    mapRow(db, { id: 'M_B', container: 'T_B', name: '乙楼内部图', scene: false });
  });
  try {
    const prepared = await repo.prepareTurn(input({ worldCompletion: { mode: 'local', focusLocationIds: ['T_A', 'T_B'], policy: POLICY } }));
    const candidate = repo.getCandidate(prepared.token).db;

    const a = fillOf(candidate, 'M_A');
    const b = fillOf(candidate, 'M_B');
    assert.ok(a && b, '两个焦点各自都要有一份记录，不能只记一张图');
    assert.equal(a.status, 'ready', '有可绘制场景的那张图是 ready');
    assert.equal(b.status, 'partial', '没有可绘制场景的那张图只能 partial');
    assert.equal(b.reasonCode, 'WORLD_LAYOUT_PENDING');
    assert.equal(fillOf(candidate, IDS.M1), null, '两张图都有归属时，外层图不参与');
    const filledMaps = queryBound(candidate, 'SELECT id, frame_json FROM maps WHERE branch_id = ?', [BRANCH])
      .filter((row) => (typeof row.frame_json === 'string' ? JSON.parse(row.frame_json) : row.frame_json)?.atlasWorldFill)
      .map((row) => String(row.id)).sort();
    assert.deepEqual(filledMaps, ['M_A', 'M_B'], '记录集合必须恰好是两个所属图');
    assert.equal(prepared.receipt.status, 'partial', '批次 status 只是汇总：任何一张没 ready 就是 partial');
  } finally { await repo.close(); }
});

/* ------------------------------------------------------------------ *
 * OWN03：本轮新建内部图 / 无图 / 冲突 / 地点缺失
 * ------------------------------------------------------------------ */

test('OWN03a 内部图本轮由 sceneMaps 新建：最终读写都落在这张新图上', async () => {
  const repo = await seeded(buildModel(), (db) => locationRow(db, { id: 'T_NEW', name: '测试新楼', kind: 'building', parent: null, mapId: IDS.M1 }));
  try {
    const outerBefore = JSON.stringify(readFrame(repo.db, IDS.M1));
    const prepared = await repo.prepareTurn(input({ sceneMaps: true, worldCompletion: { mode: 'local', focusLocationIds: ['T_NEW'], policy: POLICY } }));
    const candidate = repo.getCandidate(prepared.token).db;

    const created = queryBound(candidate, "SELECT id FROM maps WHERE branch_id = ? AND container_location_id = ? AND status = 'active'", [BRANCH, 'T_NEW']);
    assert.equal(created.length, 1, '本轮应恰好为 T_NEW 建出一张内部图');
    const innerMapId = String(created[0].id);
    assert.ok(fillOf(candidate, innerMapId), `完成状态必须落在新建的内部图 ${innerMapId} 上`);
    assert.equal(fillOf(candidate, IDS.M1), null, '绝不回头写外部图');
    assert.equal(JSON.stringify(readFrame(candidate, IDS.M1)), outerBefore);
    const filledMaps = queryBound(candidate, 'SELECT id, frame_json FROM maps WHERE branch_id = ?', [BRANCH])
      .filter((row) => (typeof row.frame_json === 'string' ? JSON.parse(row.frame_json) : row.frame_json)?.atlasWorldFill)
      .map((row) => String(row.id));
    assert.deepEqual(filledMaps, [innerMapId], '本轮只有这一张所属图拿到记录');

    // 与解析器口径一致：读、写、回报用的是同一个 resolver。
    const owners = resolveCompletionMaps(createTableReadPort(candidate), BRANCH, ['T_NEW']);
    assert.deepEqual(completionMapIds(owners), [innerMapId]);
  } finally { await repo.close(); }
});

test('OWN03b 无容器图 / 多张容器图 / 地点缺失：诊断明确，不挑第一张、不用根图冒充', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const tables = createTableReadPort(seed.db);

    // 无容器图：needsContainerMap，而不是退化成「外部图」。
    const needOne = resolveCompletionMaps(tables, BRANCH, [IDS.L2]);
    assert.deepEqual(needOne.map((owner) => owner.completionMapId), [null]);
    assert.equal(needOne[0].needsContainerMap, true);
    assert.equal(needOne[0].issues[0].code, 'COMPLETION_NEEDS_CONTAINER_MAP');

    // 地点缺失：明确诊断，且不返回任何图。
    const missing = resolveCompletionMaps(tables, BRANCH, ['LOC_NOT_HERE']);
    assert.deepEqual(missing.map((owner) => owner.completionMapId), [null]);
    assert.equal(missing[0].needsContainerMap, false);
    assert.equal(missing[0].issues[0].code, 'COMPLETION_LOCATION_MISSING');

    // 多张 active 容器图 → 冲突：completionMapId 必须为 null，绝不挑 SQL 返回顺序里的第一张。
    // 正常库有 idx_maps_container_unique 兜底（同容器至多一张 active 图）；这里模拟一个
    // 迁移前就没有该唯一索引的旧库，用真实行喂进同一个 resolver。
    insertRows(seed.db, 'maps', [
      { branch_id: BRANCH, id: 'M_DUP_B', row_rev: 1, created_turn_id: TURN, updated_turn_id: TURN, name: '重复内部图乙', kind: 'interior', container_location_id: IDS.L2, description: '', frame_json: '{"origin_x":0,"origin_y":0,"reference_width_cells":20,"reference_height_cells":15}', meters_per_cell: 1, scale_min_meters_per_cell: 1, scale_max_meters_per_cell: 1, scale_quality: 'confirmed', scale_basis_json: '{}', scale_locked: 0, calibration_rev: 1, background_asset_key: null, default_terrain: 'unknown', status: 'archived' },
      { branch_id: BRANCH, id: 'M_DUP_A', row_rev: 1, created_turn_id: TURN, updated_turn_id: TURN, name: '重复内部图甲', kind: 'interior', container_location_id: IDS.L2, description: '', frame_json: '{"origin_x":0,"origin_y":0,"reference_width_cells":20,"reference_height_cells":15}', meters_per_cell: 1, scale_min_meters_per_cell: 1, scale_max_meters_per_cell: 1, scale_quality: 'confirmed', scale_basis_json: '{}', scale_locked: 0, calibration_rev: 1, background_asset_key: null, default_terrain: 'unknown', status: 'archived' },
    ]);
    // 只有一份 active 时仍应唯一命中；把它改成两份 active 需要越过唯一索引，因此用桩端口
    // 复现「库里真的有两张 active 图」这一历史状态，断言 resolver 的判定而不是 SQL 的顺序。
    const stub = {
      selectOne: (table, branchId, id) => (table === 'locations' && id === IDS.L2 ? tables.selectOne('locations', branchId, id) : null),
      selectWhere: (table, where) => (table === 'maps'
        ? [{ id: 'M_DUP_A', branch_id: BRANCH, status: 'active', container_location_id: IDS.L2 }, { id: 'M_DUP_B', branch_id: BRANCH, status: 'active', container_location_id: IDS.L2 }]
            .filter((row) => Object.entries(where).every(([key, value]) => row[key] === value))
        : []),
    };
    const conflicted = resolveCompletionMaps(stub, BRANCH, [IDS.L2]);
    assert.equal(conflicted[0].completionMapId, null, '冲突时不能挑第一张');
    assert.equal(conflicted[0].issues[0].code, 'COMPLETION_CONTAINER_MAP_CONFLICT');
    assert.deepEqual(conflicted[0].issues[0].relatedIds, ['M_DUP_A', 'M_DUP_B']);
    assert.equal(conflicted[0].issues[0].severity, 'error');
    assert.deepEqual(completionMapIds(conflicted), []);
  } finally { seed.close(); }
});

test('OWN03c 没有可用内部图：只留批次级兜底记录，且绝不写成 ready', async () => {
  const repo = await seeded(buildModel(), (db) => locationRow(db, { id: 'T_NOMAP', name: '测试无图楼', kind: 'building', parent: null, mapId: IDS.M1 }));
  try {
    const prepared = await repo.prepareTurn(input({ worldCompletion: { mode: 'local', focusLocationIds: ['T_NOMAP'], policy: POLICY } }));
    const candidate = repo.getCandidate(prepared.token).db;
    const rows = queryBound(candidate, 'SELECT id, frame_json FROM maps WHERE branch_id = ?', [BRANCH]);
    const withFill = rows.filter((row) => (typeof row.frame_json === 'string' ? JSON.parse(row.frame_json) : row.frame_json)?.atlasWorldFill);
    assert.deepEqual(withFill.map((row) => row.id), [IDS.M1], '没有内部图时只允许分支根图留一条兜底记录');
    const fallback = (typeof withFill[0].frame_json === 'string' ? JSON.parse(withFill[0].frame_json) : withFill[0].frame_json).atlasWorldFill;
    assert.equal(fallback.scope, 'batch-fallback');
    assert.notEqual(fallback.status, 'ready', '兜底记录绝不冒充完成状态');
    assert.equal(prepared.receipt.status, 'partial');
  } finally { await repo.close(); }
});

/* ------------------------------------------------------------------ *
 * OWN04：复用与回退
 * ------------------------------------------------------------------ */

test('OWN04 无变化再次建设复用（NOT_NEEDED）；回退恢复内部图状态', async () => {
  // 建设阶段只补一条不改变成员结构的描述：结构未变 → contextHash 不变 → 下一轮必须复用。
  const patchOp = JSON.stringify({ op: 'location.upsert', ref: IDS.L2, data: { description: '本轮核对过结构' } });
  const port = model((req) => (req.batchId.startsWith('construction_') ? patchOp : noop));
  const repo = await seeded(port, (db) => mapRow(db, { id: 'M_SCHOOL', container: IDS.L2, name: '学校内部图', scene: true }));
  const constructionCalls = () => port.calls.filter((call) => call.batchId.startsWith('construction_')).length;
  const ownInput = (extra = {}) => input({ worldCompletion: { mode: 'local', focusLocationIds: [IDS.L2], policy: SHALLOW_POLICY }, ...extra });
  try {
    const first = await repo.prepareTurn(ownInput());
    assert.equal(fillOf(repo.getCandidate(first.token).db, 'M_SCHOOL').status, 'ready');
    await repo.confirmSaved({ token: first.token, snapshotSha256: first.snapshotSha256, result: 'saved' });
    const saved = fillOf(repo.db, 'M_SCHOOL');
    assert.ok(saved, '保存后正式库持有内部图状态');
    assert.equal(constructionCalls(), 1);

    // 再建一次：结构未变、contextHash 未变、无缺项 → 不发建设请求（W07 的复用口径）。
    const second = await repo.prepareTurn(ownInput({
      anchor: { ...input().anchor, parentTurnId: first.receipt.turnId, hostMessageUid: 'own-2', inputHash: 'own-2', baseRevision: 1, baseStorageRevision: 1 },
    }));
    assert.equal(constructionCalls(), 1, '复用回合不得再发建设请求');
    assert.equal(fillOf(repo.getCandidate(second.token).db, 'M_SCHOOL').contextHash, saved.contextHash, '复用回合不改变内部图指纹');
    await repo.discardPrepared(second.token);

    // 回退到第一轮之前：内部图状态由 journal 一起恢复，不留半截记录。
    const rollback = await repo.prepareRollback({ chatUid: IDS.chatA, branchId: BRANCH, targetParentTurnId: first.receipt.turnId, expectedRevision: 1 });
    await repo.confirmSaved({ token: rollback.token, snapshotSha256: rollback.snapshotSha256, result: 'saved' });
    assert.equal(fillOf(repo.db, 'M_SCHOOL'), null, '回退必须把内部图完成状态一并撤销');
    assert.ok(readFrame(repo.db, 'M_SCHOOL')?.atlasScene, '内部图自身的内容（场景）保持原样');
  } finally { await repo.close(); }
});

/* ------------------------------------------------------------------ *
 * OWN05：真实 handleSqlMapAction 回执指向内部图
 * ------------------------------------------------------------------ */

test('OWN05 handleSqlMapAction 建设回执指向内部图，与仓库状态一致', async () => {
  const port = model((req, n) => {
    if (req.batchId.includes('_evidence_')) return '{"facts":[]}';
    if (req.batchId.startsWith('layout_')) {
      const line = req.messages[1].content.split('\n').find((item) => item.startsWith('本图：'));
      return JSON.parse(line.slice(3))
        .map((scope) => JSON.stringify({ op: 'map.layout.request', ref: scope.map, data: { kind: scope.kind, spec: scope.kind === 'floor' ? { rooms: scope.baselineRooms } : { surface: 'mixed' } } }))
        .join('\n');
    }
    // 初建：第一轮观察登记旅店与主角，第二轮建设在焦点场所下加一个厨房。
    return n === 1
      ? `${JSON.stringify({ op: 'location.upsert', ref: 'new:lodge', data: { name: '新旅店', kind: 'building' } })}\n${JSON.stringify({ op: 'character.upsert', ref: 'new:pov', data: { name: '测试主角', identity: '旅行者', role: 'protagonist', location_ref: 'new:lodge' } })}`
      : JSON.stringify({ op: 'location.upsert', ref: 'new:kitchen', data: { name: '厨房', kind: 'room', parent_ref: req.messages[1].content.match(/focus=([^、\n]+)/)[1] } });
  });
  const hostRecord = { chatUid: 'own05-chat', branchId: 'main', chatMetadata: {}, saveMetadata: async () => true };
  const provider = createBrowserSqlHost({ enabled: () => true, context: () => hostRecord, loadRuntime: loadAtlasSqlRuntime, modelPort: port });
  try {
    const session = await provider.session(hostRecord.chatUid);
    const branch = session.branchId;
    await handleSqlMapAction(session, 'map/bootstrap', { chatId: hostRecord.chatUid, requestId: 'initial', assistantText: '主角进入有厨房的旅店。' });
    // 保存会替换会话底层数据库句柄：每次查询都重新取，不缓存旧句柄。
    const read = () => session.repo.db;
    const lodge = queryBound(read(), 'SELECT id FROM locations WHERE branch_id = ? AND name = ?', [branch, '新旅店'])[0];
    assert.ok(lodge, '初建应登记旅店');
    const innerRow = queryBound(read(), "SELECT id FROM maps WHERE branch_id = ? AND container_location_id = ? AND status = 'active'", [branch, String(lodge.id)])[0];
    assert.ok(innerRow, '旅店必须有内部图');
    const innerMapId = String(innerRow.id);
    const rootMapId = String(queryBound(read(), 'SELECT root_map_id FROM branches WHERE id = ?', [branch])[0].root_map_id);
    assert.notEqual(innerMapId, rootMapId, '内部图不是根图');

    // 显式 build：回执里的完成状态所属图必须是内部图，且与仓库里的记录一致。
    const result = await handleSqlMapAction(session, 'map/build', {
      chatId: hostRecord.chatUid, requestId: 'build', mode: 'local', focusLocationIds: [String(lodge.id)],
      assistantText: '再核对一遍旅店内部。',
    });
    assert.equal(result.coreSaved, true, JSON.stringify(result.issues));
    const build = result.build;
    assert.ok(build, '建设动作必须交出 build 汇总');
    assert.equal(build.completionMapId, innerMapId, `回执必须指向内部图，实际 ${JSON.stringify(build)}`);
    assert.deepEqual(build.completionMapIds, [innerMapId]);
    assert.equal(build.focusMapId, innerMapId, '兼容字段也不能退回外部图');
    assert.deepEqual(build.mapStatuses, [{ mapId: innerMapId, status: 'ready' }]);
    assert.notEqual(build.status, 'deferred');
    const recorded = queryBound(read(), 'SELECT frame_json FROM maps WHERE branch_id = ? AND id = ?', [branch, innerMapId])[0];
    const frame = typeof recorded.frame_json === 'string' ? JSON.parse(recorded.frame_json) : recorded.frame_json;
    assert.ok(frame.atlasWorldFill, '内部图必须持有完成状态记录');
    assert.equal(frame.atlasWorldFill.completedTurnId, result.receipt.turnId, '回执与仓库状态必须一致');
    const rootFrame = queryBound(read(), 'SELECT frame_json FROM maps WHERE branch_id = ? AND id = ?', [branch, rootMapId])[0].frame_json;
    assert.equal(String(rootFrame).includes('atlasWorldFill'), false, '根图不得被写入完成状态');
  } finally { await provider.close(); }
});
