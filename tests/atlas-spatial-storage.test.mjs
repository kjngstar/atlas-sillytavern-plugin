/**
 * atlas-spatial-storage.test.mjs — M3/W09：空间候选提交、回退与分支的集成验收。
 *
 * 不用 mock applyGroups 替代原子性：走真实 schema / codec / applyGroups / journal / rollback，
 * 再叠加本轮新增的阶段：
 * - W00 新空图初始幅面（30×24m → 100×80 格）与 retained 分支；
 * - W01 候选事务内处理 pending 布局请求（maxJobs、稳定排序、失败整组恢复）；
 * - W02 失败请求标 failed 且保留旧 scene 与地点坐标；
 * - W04/W05 迁入迁出后的视觉锚点重建；
 * - W06/W07 fork 后子分支 scene 可读、父分支字节不变。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, insertRows, selectOne, foreignKeyCheck } from './fixtures/atlas-sql/seed.mjs';
import { installSchema } from '../src/atlas-db-schema.ts';
import { validateCandidate } from '../src/atlas-db-invariants.ts';
import { applyGroups } from '../src/atlas-db-commit.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { decodeRow } from '../src/atlas-db-codec.ts';
import { ensureInitialSpatialFrame, readSpatialFrame } from '../src/atlas-spatial-frame.ts';
import { applyPendingSpatialRequests, collectPendingRequests, recordFailedSpatialRequest } from '../src/atlas-spatial-candidate.ts';
import { reconcileOccupantsSpec } from '../src/atlas-spatial-occupants.ts';
import { copySceneForBranch } from '../src/atlas-spatial-branch.ts';
import { forkBranch } from '../src/atlas-db-branches.ts';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { armLayoutRetry } from '../src/atlas-spatial-candidate.ts';

const SQL = await (await import('sql.js')).default();
const BRANCH = IDS.branchMain;

async function fresh() {
  return makeSeedWith(SQL);
}

/** 一条「新空图」：无 scene、无已定位地点、尺度未锁也未确认。 */
function emptyMapRow(overrides = {}) {
  return {
    branch_id: BRANCH,
    id: 'M_NEW',
    name: '新图',
    kind: 'interior',
    container_location_id: null,
    description: '',
    frame_json: { origin_x: 0, origin_y: 0, cols: 100, rows: 100 },
    meters_per_cell: null,
    scale_min_meters_per_cell: null,
    scale_max_meters_per_cell: null,
    scale_quality: 'uncalibrated',
    scale_basis_json: '{}',
    scale_locked: 0,
    calibration_rev: 1,
    background_asset_key: null,
    default_terrain: 'unknown',
    status: 'active',
    row_rev: 1,
    created_turn_id: IDS.seedTurn,
    updated_turn_id: IDS.seedTurn,
    ...overrides,
  };
}

const SCOPE = { chatId: 'chat-A', branchId: BRANCH, revision: 3, viewMode: 'author' };

test('W00-01 新空图 30×24m 初始化成 100×80 格，尺度 estimated 且 calibration_rev 递增', () => {
  const result = ensureInitialSpatialFrame({
    mapRow: emptyMapRow(),
    scope: SCOPE,
    currentScope: SCOPE,
    expectedRowRev: 1,
    widthM: 30,
    heightM: 24,
    locations: [],
    turnId: 'turn_new',
    operationId: 'op_init',
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.status, 'prepared');
  const after = result.mutation.after;
  assert.equal(result.mutation.table, 'maps');
  assert.equal(result.mutation.rowId, 'M_NEW');
  assert.equal(result.mutation.before.row_rev, 1);
  assert.equal(after.row_rev, 2);
  assert.equal(after.frame_json.cols, 100);
  assert.equal(after.frame_json.rows, 80);
  assert.ok(Math.abs(after.meters_per_cell - 0.3) < 1e-9);
  assert.equal(after.scale_quality, 'estimated');
  assert.equal(after.calibration_rev, 2);
  assert.equal(after.updated_turn_id, 'turn_new');
  // 原 frame 的其他字段保留
  assert.equal(after.frame_json.origin_x, 0);
  assert.equal(after.frame_json.origin_y, 0);
  assert.deepEqual(result.mutation.sourceOpIds, ['op_init']);
});

test('W00-02 已确认尺度 / 已有 scene / 已定位地点：一律 retained，不写行', () => {
  const locked = ensureInitialSpatialFrame({
    mapRow: emptyMapRow({ scale_quality: 'confirmed' }),
    scope: SCOPE,
    currentScope: SCOPE,
    expectedRowRev: 1,
    widthM: 30,
    heightM: 24,
    turnId: 'turn_new',
    operationId: 'op_init',
  });
  assert.equal(locked.status, 'retained');
  assert.equal(locked.mutation, null);

  const withScene = ensureInitialSpatialFrame({
    mapRow: emptyMapRow({ frame_json: { origin_x: 0, atlasScene: { kind: 'atlas-scene', version: 1 } } }),
    scope: SCOPE,
    currentScope: SCOPE,
    expectedRowRev: 1,
    widthM: 30,
    heightM: 24,
    turnId: 'turn_new',
    operationId: 'op_init',
  });
  assert.equal(withScene.status, 'retained');
  assert.equal(withScene.mutation, null);

  const positioned = ensureInitialSpatialFrame({
    mapRow: emptyMapRow(),
    scope: SCOPE,
    currentScope: SCOPE,
    expectedRowRev: 1,
    widthM: 30,
    heightM: 24,
    locations: [{ branch_id: BRANCH, id: 'L9', map_id: 'M_NEW', status: 'active', grid_x: 3, grid_y: 4 }],
    turnId: 'turn_new',
    operationId: 'op_init',
  });
  assert.equal(positioned.status, 'retained');
  assert.equal(positioned.mutation, null);
});

test('W00-03 无尺寸：不报错，退回概览并记缺项', () => {
  const result = ensureInitialSpatialFrame({
    mapRow: emptyMapRow(),
    scope: SCOPE,
    currentScope: SCOPE,
    expectedRowRev: 1,
    turnId: 'turn_new',
    operationId: 'op_init',
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.status, 'retained');
  assert.equal(result.mutation, null);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'INITIAL_EXTENT_MISSING');
  assert.equal(result.issues[0].severity, 'warning');
});

test('W00-04 作用域漂移 / row_rev 不符：失败且不写行', () => {
  const stale = ensureInitialSpatialFrame({
    mapRow: emptyMapRow(),
    scope: SCOPE,
    currentScope: { ...SCOPE, revision: 4 },
    expectedRowRev: 1,
    widthM: 30,
    heightM: 24,
    turnId: 'turn_new',
    operationId: 'op_init',
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 'failed');
  assert.equal(stale.mutation, null);
  assert.equal(stale.issues[0].code, 'STALE_SCOPE');

  const wrongRev = ensureInitialSpatialFrame({
    mapRow: emptyMapRow(),
    scope: SCOPE,
    currentScope: SCOPE,
    expectedRowRev: 9,
    widthM: 30,
    heightM: 24,
    turnId: 'turn_new',
    operationId: 'op_init',
  });
  assert.equal(wrongRev.ok, false);
  assert.equal(wrongRev.issues[0].code, 'STALE_ROW');
});

test('W00-05 初始化结果落真实库后仍通过候选校验（帧跨度为正有限数）', async () => {
  const seed = await fresh();
  const row = emptyMapRow();
  insertRows(seed.db, 'maps', [row]);
  const result = ensureInitialSpatialFrame({
    mapRow: row,
    scope: SCOPE,
    currentScope: SCOPE,
    expectedRowRev: 1,
    widthM: 30,
    heightM: 24,
    turnId: IDS.seedTurn,
    operationId: 'op_init',
  });
  assert.equal(result.status, 'prepared');
  const after = result.mutation.after;
  seed.db.run('UPDATE maps SET frame_json=?, meters_per_cell=?, scale_quality=?, calibration_rev=?, row_rev=? WHERE branch_id=? AND id=?', [
    JSON.stringify(after.frame_json),
    after.meters_per_cell,
    after.scale_quality,
    after.calibration_rev,
    after.row_rev,
    BRANCH,
    'M_NEW',
  ]);
  assert.deepEqual(foreignKeyCheck(seed.db), []);
  const check = validateCandidate(seed.db, { branchId: BRANCH });
  assert.equal(check.ok, true, JSON.stringify(check.violations.slice(0, 3)));
  const stored = selectOne(seed.db, 'maps', BRANCH, 'M_NEW');
  assert.equal(Number(stored.row_rev), 2);
  const frame = JSON.parse(stored.frame_json);
  assert.equal(frame.cols, 100);
  assert.equal(frame.rows, 80);
});

test('W00-06 readSpatialFrame：scene 与 pending request 一次读出，互不覆盖', () => {
  // 没有 scene 的旧存档：键不存在（不是 null —— null 会被判成版本不支持）
  const frame = {
    origin_x: 0,
    atlasLayoutRequest: { requestId: 'req_1', kind: 'floor', spec: { rooms: [{ id: 'L3' }] } },
  };
  const read = readSpatialFrame(frame, { branchId: BRANCH, mapId: 'M2' });
  assert.equal(read.ok, true);
  assert.equal(read.scene, null);
  assert.equal(read.request.requestId, 'req_1');
  assert.equal(read.frame.origin_x, 0, '其他 frame 键保留');
  // 字符串 frame 也能读
  const fromString = readSpatialFrame(JSON.stringify(frame), { branchId: BRANCH, mapId: 'M2' });
  assert.equal(fromString.request.requestId, 'req_1');
});

/* ─────────────────── W01/W02：候选事务内的布局处理 ─────────────────── */

const TURN_SPATIAL = 'turn_spatial';

function insertTurn(db, id, branchId = BRANCH) {
  db.run(
    `INSERT INTO turns (id, branch_id, parent_turn_id, host_message_uid, host_variant_key, kind, input_hash, story_hash, base_revision, committed_revision, clock_before_s, elapsed_json, clock_after_s, rng_seed, ruleset_version, decisions_json, receipt_json, attempts_json, status, created_wall_ms, prepared_wall_ms)
     VALUES (?, ?, NULL, NULL, NULL, 'manual', ?, NULL, 0, 0, 0, ?, 0, ?, 'atlas-1', ?, NULL, ?, 'pending', ?, ?)`,
    [id, branchId, `hash_${id}`, JSON.stringify({ min_s: 0, nominal_s: 0, max_s: 0, quality: 'explicit', basis_refs: [] }), `rng_${id}`, JSON.stringify({ operations: [], attention_decisions: [], outcome_decisions: [], random_draws: [] }), JSON.stringify([]), 1_700_000_000_000, 1_700_000_000_000],
  );
}

/** 已确认尺度（1m/格）的室内图：初始化阶段 retained，只走编译/应用。 */
function floorMapRow(mapId, request) {
  return {
    branch_id: BRANCH,
    id: mapId,
    name: `${mapId} 平面图`,
    kind: 'interior',
    container_location_id: null,
    description: '',
    frame_json: {
      origin_x: 0,
      origin_y: 0,
      cols: 40,
      rows: 30,
      ...(request ? { atlasLayoutRequest: request } : {}),
    },
    meters_per_cell: 1,
    scale_min_meters_per_cell: 1,
    scale_max_meters_per_cell: 1,
    scale_quality: 'confirmed',
    scale_basis_json: '{}',
    scale_locked: 0,
    calibration_rev: 1,
    background_asset_key: null,
    default_terrain: 'unknown',
    status: 'active',
    row_rev: 1,
    created_turn_id: IDS.seedTurn,
    updated_turn_id: IDS.seedTurn,
  };
}

function roomRow(id, mapId, name) {
  return {
    branch_id: BRANCH,
    id,
    name,
    aliases_json: '[]',
    kind: 'room',
    description: '',
    parent_location_id: IDS.L2,
    mobility: 'fixed',
    anchor_location_id: null,
    map_id: mapId,
    grid_x: null,
    grid_y: null,
    coord_precision: 'unknown',
    uncertainty_radius_cells: null,
    area_geometry_json: null,
    terrain: 'unknown',
    access_rules_json: null,
    vehicle_profile_json: null,
    existence_quality: 'confirmed',
    status: 'active',
    merged_into_id: null,
    row_rev: 1,
    created_turn_id: IDS.seedTurn,
    updated_turn_id: IDS.seedTurn,
  };
}

function pendingRequest(requestId, spec) {
  return { requestId, operationId: `op_${requestId}`, kind: 'floor', spec, status: 'pending', createdTurnId: 'turn_prev' };
}

function floorSpec(aId, bId) {
  return { rooms: [{ id: aId, w: 8, h: 6, side: 'north' }, { id: bId, w: 6, h: 5, side: 'south' }] };
}

async function spatialSeed(mapIds, options = {}) {
  const seed = await fresh();
  insertTurn(seed.db, TURN_SPATIAL);
  const maps = [];
  const rooms = [];
  const keys = [];
  for (const mapId of mapIds) {
    const a = `${mapId}_A`;
    const b = `${mapId}_B`;
    const request = options.withRequest === false ? null : pendingRequest(`req_${mapId}`, floorSpec(a, b));
    maps.push(floorMapRow(mapId, request));
    rooms.push(roomRow(a, mapId, `${mapId} 北室`), roomRow(b, mapId, `${mapId} 南室`));
    keys.push({ branch_id: BRANCH, id: a, kind: 'location' }, { branch_id: BRANCH, id: b, kind: 'location' });
  }
  insertRows(seed.db, 'entity_keys', keys);
  insertRows(seed.db, 'maps', maps);
  insertRows(seed.db, 'locations', rooms);
  return seed;
}

function makePorts(state = {}) {
  return {
    applyGroups: (db, groups, ctx) => applyGroups(db, groups, ctx),
    queryBound,
    decodeRow,
    isCurrent: () => state.current !== false,
    branchId: BRANCH,
    turnId: TURN_SPATIAL,
    attemptId: 'attempt_spatial',
  };
}

function countTurnChanges(db, turnId = TURN_SPATIAL) {
  const rows = db.exec('SELECT COUNT(*) FROM turn_changes WHERE turn_id = ?', [turnId]);
  return rows.length ? Number(rows[0].values[0][0]) : 0;
}

function readStoredFrame(db, mapId) {
  const row = selectOne(db, 'maps', BRANCH, mapId);
  return typeof row.frame_json === 'string' ? JSON.parse(row.frame_json) : row.frame_json;
}

test('W01-01 三张待处理图：默认 maxJobs=2 只处理两张，第三张保持 pending', async () => {
  const seed = await spatialSeed(['M_F1', 'M_F2', 'M_F3']);
  seed.db.run('BEGIN');
  const out = applyPendingSpatialRequests({
    db: seed.db,
    scope: SCOPE,
    turnId: TURN_SPATIAL,
    ports: makePorts(),
  });
  assert.deepEqual(out.processed, ['req_M_F1', 'req_M_F2'], JSON.stringify(out.issues));
  assert.deepEqual(out.pending, ['req_M_F3']);
  // 前两张已落 scene 并消费请求；第三张仍是 pending
  const f1 = readStoredFrame(seed.db, 'M_F1');
  assert.ok(f1.atlasScene, `M_F1 未写入场景：${JSON.stringify(out.issues)}`);
  assert.equal(f1.atlasLayoutRequest, undefined, '成功应用后请求被消费，重开界面不会重复生成');
  const f3 = readStoredFrame(seed.db, 'M_F3');
  assert.equal(f3.atlasScene, undefined, '未处理的图不写场景');
  assert.equal(f3.atlasLayoutRequest.status, 'pending');
  seed.db.run('ROLLBACK');
});

test('W01-02 没有待处理请求：零写入，不新增任何变更日志', async () => {
  const seed = await spatialSeed(['M_F1'], { withRequest: false });
  seed.db.run('BEGIN');
  const before = countTurnChanges(seed.db);
  const out = applyPendingSpatialRequests({ db: seed.db, scope: SCOPE, turnId: TURN_SPATIAL, ports: makePorts() });
  assert.deepEqual(out.groups, []);
  assert.deepEqual(out.processed, []);
  assert.deepEqual(out.pending, []);
  assert.equal(countTurnChanges(seed.db), before, '无请求不得产生写入');
  assert.equal(Number(selectOne(seed.db, 'maps', BRANCH, 'M_F1').row_rev), 1);
  seed.db.run('ROLLBACK');
});

test('W01-03 处理中途世界切换：已处理的保留，剩下的立即停下并报 STALE_SCOPE', async () => {
  const seed = await spatialSeed(['M_F1', 'M_F2']);
  const state = { current: true, calls: 0 };
  seed.db.run('BEGIN');
  const out = applyPendingSpatialRequests({
    db: seed.db,
    scope: SCOPE,
    turnId: TURN_SPATIAL,
    maxJobs: 5,
    ports: {
      ...makePorts(),
      isCurrent: () => state.current,
      // 第一张写完就切换世界：后续组必须停下。
      applyGroups: (db, groups, ctx) => {
        const result = applyGroups(db, groups, ctx);
        state.calls += 1;
        if (state.calls >= 1) state.current = false;
        return result;
      },
    },
  });
  assert.deepEqual(out.processed, ['req_M_F1'], JSON.stringify(out.issues));
  assert.deepEqual(out.pending, ['req_M_F2']);
  assert.ok(out.issues.some((i) => i.code === 'STALE_SCOPE'), JSON.stringify(out.issues));
  assert.equal(readStoredFrame(seed.db, 'M_F2').atlasScene, undefined, '停止后不得再写第二张图');
  seed.db.run('ROLLBACK');
});

test('W01-04 布局失败：整组恢复，旧 scene 与地点坐标不变，请求标 failed', async () => {
  const seed = await spatialSeed(['M_F1']);
  seed.db.run('BEGIN');
  // 先成功生成一次，作为「旧场景」基线。
  const first = applyPendingSpatialRequests({ db: seed.db, scope: SCOPE, turnId: TURN_SPATIAL, ports: makePorts() });
  assert.deepEqual(first.processed, ['req_M_F1'], JSON.stringify(first.issues));
  const savedFrame = readStoredFrame(seed.db, 'M_F1');
  assert.ok(savedFrame.atlasScene, '基线场景未生成');

  // 再放一条必然失败的请求：房间引用了别的地图上的地点 L3（属于 M2）。
  const badRequest = pendingRequest('req_bad', { rooms: [{ id: 'L3', w: 6, h: 5, side: 'north' }] });
  seed.db.run('UPDATE maps SET frame_json = ? WHERE branch_id = ? AND id = ?', [
    JSON.stringify({ ...savedFrame, atlasLayoutRequest: badRequest }),
    BRANCH,
    'M_F1',
  ]);
  const before = selectOne(seed.db, 'locations', BRANCH, 'M_F1_A');

  const out = applyPendingSpatialRequests({ db: seed.db, scope: SCOPE, turnId: TURN_SPATIAL, ports: makePorts() });
  const frame = readStoredFrame(seed.db, 'M_F1');
  assert.deepEqual(frame.atlasScene, savedFrame.atlasScene, '旧场景必须原样保留');
  assert.equal(frame.atlasLayoutRequest.status, 'failed', JSON.stringify(out.issues));
  assert.ok(
    frame.atlasLayoutRequest.issues.some((i) => i.code === 'LOCATION_MAP_MISMATCH'),
    `失败原因未落库：${JSON.stringify(frame.atlasLayoutRequest.issues)}`,
  );
  const after = selectOne(seed.db, 'locations', BRANCH, 'M_F1_A');
  assert.equal(after.grid_x, before.grid_x, '地点坐标不得被失败的布局改写');
  assert.equal(after.grid_y, before.grid_y);
  assert.equal(Number(after.row_rev), Number(before.row_rev));
  seed.db.run('ROLLBACK');
});

test('W01-05 处理过程不提交：回滚后一切回到原点', async () => {
  const seed = await spatialSeed(['M_F1']);
  const beforeRev = Number(selectOne(seed.db, 'maps', BRANCH, 'M_F1').row_rev);
  seed.db.run('BEGIN');
  const out = applyPendingSpatialRequests({ db: seed.db, scope: SCOPE, turnId: TURN_SPATIAL, ports: makePorts() });
  assert.deepEqual(out.processed, ['req_M_F1']);
  assert.ok(Number(selectOne(seed.db, 'maps', BRANCH, 'M_F1').row_rev) > beforeRev, '事务内已写入');
  seed.db.run('ROLLBACK');
  assert.equal(Number(selectOne(seed.db, 'maps', BRANCH, 'M_F1').row_rev), beforeRev, '本函数不得 COMMIT');
  assert.equal(readStoredFrame(seed.db, 'M_F1').atlasScene, undefined);
});

test('W02-01 失败标记保留完整 Issue 字段；标记写不进去时抛核心错误', async () => {
  const seed = await spatialSeed(['M_F1']);
  seed.db.run('BEGIN');
  const mapRow = decodeRow('maps', selectOne(seed.db, 'maps', BRANCH, 'M_F1'), { allowExtra: true }).row;
  const request = pendingRequest('req_manual', floorSpec('M_F1_A', 'M_F1_B'));
  const result = recordFailedSpatialRequest({
    db: seed.db,
    mapRow,
    mapId: 'M_F1',
    request,
    issues: [{ code: 'X_TEST', path: '$.rooms[0].w', message: '测试用字段错误', severity: 'error', retryable: false }],
    turnId: TURN_SPATIAL,
    operationId: 'op_req_manual',
    ports: makePorts(),
  });
  assert.ok(result.group, JSON.stringify(result.issues));
  assert.equal(result.group.status, 'applied');
  const frame = readStoredFrame(seed.db, 'M_F1');
  assert.equal(frame.atlasLayoutRequest.status, 'failed');
  assert.equal(frame.atlasLayoutRequest.failedAtTurnId, TURN_SPATIAL);
  assert.deepEqual(frame.atlasLayoutRequest.issues, [
    { code: 'X_TEST', path: '$.rooms[0].w', message: '测试用字段错误', severity: 'error', retryable: false },
  ]);
  assert.equal(frame.atlasScene, undefined, '失败标记不制造场景');
  seed.db.run('ROLLBACK');
});

test('W01-06 collectPendingRequests：跳过非 floor/city 与缺 spec 的请求并给出警告', async () => {
  const seed = await spatialSeed(['M_F1']);
  const bad = floorMapRow('M_BAD', { requestId: 'req_bad', kind: 'dungeon', spec: { rooms: [] }, status: 'pending' });
  const noSpec = floorMapRow('M_NOSPEC', { requestId: 'req_nospec', kind: 'floor', status: 'pending' });
  const done = floorMapRow('M_DONE', { requestId: 'req_done', kind: 'floor', spec: { rooms: [] }, status: 'failed' });
  insertRows(seed.db, 'maps', [bad, noSpec, done]);
  const collected = collectPendingRequests(seed.db, SCOPE, makePorts());
  assert.deepEqual(collected.pending.map((p) => p.mapId), ['M_F1']);
  const codes = collected.issues.map((i) => i.code);
  assert.ok(codes.includes('LAYOUT_KIND_UNSUPPORTED'), JSON.stringify(codes));
  assert.ok(codes.includes('LAYOUT_SPEC_INVALID'), JSON.stringify(codes));
});

/* ─────────────────── W04：占用者按 SQL 归属对账 ─────────────────── */

const OCC_ROOMS = [{ id: 'M_F1_A', w: 8, h: 6, side: 'north' }, { id: 'M_F1_B', w: 6, h: 5, side: 'south' }];

const OCC_CHARACTERS = [
  { branch_id: BRANCH, id: 'C1', location_id: IDS.L2, status: 'active', map_id: null },
  { branch_id: BRANCH, id: 'C2', location_id: 'M_F1_A', status: 'active', map_id: 'M_F1' },
];

const OCC_ITEMS = [
  { branch_id: BRANCH, id: 'I_HELD', name: '怀表', location_id: null, holder_character_id: 'C1', container_item_id: null, status: 'active' },
  { branch_id: BRANCH, id: 'I_GROUND', name: '粉笔', location_id: 'M_F1_A', holder_character_id: null, container_item_id: null, status: 'active' },
];

/* ─────────────────── W06/W07：fork 时的场景迁移 ─────────────────── */

const FORK_ID = 'main-A-fork-spatial';

function deterministicMakeId(kind, opId, alias) {
  let h = 0x811c9dc5;
  const text = `${kind}\u0000${opId}\u0000${alias}`;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${kind}_${h.toString(16).padStart(8, '0')}`;
}

test('W07-01 fork：子分支场景可读，父分支字节不变，父 pending 请求不带过来', async () => {
  const seed = await spatialSeed(['M_F1']);
  try {
    seed.db.run('BEGIN');
    const first = applyPendingSpatialRequests({ db: seed.db, scope: SCOPE, turnId: TURN_SPATIAL, ports: makePorts() });
    assert.deepEqual(first.processed, ['req_M_F1'], JSON.stringify(first.issues));
    // 生成后再挂一条还没跑的请求：fork 不能把它带走。
    const saved = readStoredFrame(seed.db, 'M_F1');
    seed.db.run('UPDATE maps SET frame_json = ? WHERE branch_id = ? AND id = ?', [
      JSON.stringify({ ...saved, atlasLayoutRequest: pendingRequest('req_after', floorSpec('M_F1_A', 'M_F1_B')) }),
      BRANCH,
      'M_F1',
    ]);
    seed.db.run('COMMIT');
    const parentBytes = JSON.stringify(readStoredFrame(seed.db, 'M_F1'));

    const forked = forkBranch(
      { parentBranchId: BRANCH, newBranchId: FORK_ID, name: '空间分叉', forkTurnId: IDS.seedTurn, makeId: deterministicMakeId, nowWallMs: 1_700_000_000_001, rulesetVersion: 'atlas-1' },
      seed.db,
    );
    assert.ok(forked.copiedRows > 0, '应有行被复制');
    const childRow = selectOne(seed.db, 'maps', FORK_ID, 'M_F1');
    const childFrame = typeof childRow.frame_json === 'string' ? JSON.parse(childRow.frame_json) : childRow.frame_json;
    assert.ok(childFrame.atlasScene, '子分支没有场景');
    assert.equal(childFrame.atlasScene.branchId, FORK_ID);
    assert.equal(childFrame.atlasScene.sourceRevision, 0, 'sourceRevision 随分支基准重写');
    assert.equal(childFrame.atlasLayoutRequest, undefined, '父分支的 pending 请求不能带到子分支');
    assert.equal(childFrame.cols, 40, '其他 frame 字段保留');
    assert.equal(childFrame.rows, 30);
    assert.ok(childFrame.atlasScene.layout.rooms.length >= 2, '几何没有随 fork 带过去');
    assert.equal(JSON.stringify(readStoredFrame(seed.db, 'M_F1')), parentBytes, '父分支地图帧被改动了');
    assert.deepEqual(foreignKeyCheck(seed.db), []);
  } finally {
    seed.close();
  }
});

/* ─────────────────── W03/W08/W09：整轮集成 ─────────────────── */

async function spatialRepo() {
  const seed = await spatialSeed(['M_F1']);
  const bytes = seed.exportBytes();
  seed.close();
  const repo = createSqlRepository({
    chatUid: IDS.chatA,
    branchId: BRANCH,
    branchName: '主线',
    modelPort: null,
    now: () => 1_700_000_000_000,
    makeId: (kind, opId, alias) => `${kind.slice(0, 3)}_${Buffer.from(`${opId}:${alias}`).toString('hex').slice(0, 20)}`,
  });
  await repo.open({ bytes });
  return repo;
}

const LAYOUT_ANCHOR = {
  chatUid: IDS.chatA,
  branchId: BRANCH,
  parentTurnId: IDS.seedTurn,
  hostMessageUid: 'msg_layout',
  variantKey: 'v1',
  baseRevision: 0,
  baseStorageRevision: 0,
  inputHash: 'hash_layout',
};

test('W03-01 prepareTurn 钩子：受控轮里真的产出 maps + locations 空间变更', async () => {
  const repo = await spatialRepo();
  try {
    const prepared = await repo.prepareTurn({
      anchor: LAYOUT_ANCHOR,
      userText: '',
      assistantText: '',
      sourceSnapshot: [],
      phaseBatches: ['observe'],
      manual: true,
      operations: [],
      sceneMaps: false,
      isCurrent: () => true,
    });
    assert.equal(prepared.receipt.status, 'committed', JSON.stringify(prepared.receipt.issues ?? []));
    await repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'saved' });
    const stored = selectOne(repo.db, 'maps', BRANCH, 'M_F1');
    const frame = JSON.parse(stored.frame_json);
    assert.ok(frame.atlasScene, `prepareTurn 没有生成场景：${JSON.stringify(prepared.receipt.issues ?? [])}`);
    assert.equal(frame.atlasLayoutRequest, undefined, '请求已消费');
    assert.ok(Number(stored.row_rev) > 1, '地图行未更新');
    const room = selectOne(repo.db, 'locations', BRANCH, 'M_F1_A');
    assert.ok(Number(room.grid_x) > 0 && Number(room.grid_y) > 0, `房间坐标未写入：${JSON.stringify(room)}`);
    assert.deepEqual(foreignKeyCheck(repo.db), []);
  } finally {
    await repo.close();
  }
});

test('W08-01 armLayoutRetry：failed 重新武装后被同轮消费；没有失败请求是 noop', async () => {
  const seed = await spatialSeed(['M_F1']);
  try {
    seed.db.run('BEGIN');
    const mapRow = decodeRow('maps', selectOne(seed.db, 'maps', BRANCH, 'M_F1'), { allowExtra: true }).row;
    recordFailedSpatialRequest({
      db: seed.db,
      mapRow,
      mapId: 'M_F1',
      request: pendingRequest('req_fail', floorSpec('M_F1_A', 'M_F1_B')),
      issues: [{ code: 'LAYOUT_TEST_FAILURE', path: '$.rooms', message: '上一轮生成失败', severity: 'error', retryable: true }],
      turnId: TURN_SPATIAL,
      operationId: 'op_req_fail',
      ports: makePorts(),
    });
    assert.equal(readStoredFrame(seed.db, 'M_F1').atlasLayoutRequest.status, 'failed');

    const armed = armLayoutRetry({
      db: seed.db,
      branchId: BRANCH,
      mapId: 'M_F1',
      requestId: 'req_retry',
      operationId: 'op_retry',
      turnId: TURN_SPATIAL,
      ports: makePorts(),
    });
    assert.equal(armed.groups.length, 1);
    assert.equal(readStoredFrame(seed.db, 'M_F1').atlasLayoutRequest.status, 'pending');

    const out = applyPendingSpatialRequests({ db: seed.db, scope: SCOPE, turnId: TURN_SPATIAL, ports: makePorts() });
    assert.deepEqual(out.processed, ['req_retry'], JSON.stringify(out.issues));
    assert.ok(readStoredFrame(seed.db, 'M_F1').atlasScene, `重试后仍未生成场景：${JSON.stringify(out.issues)}｜${JSON.stringify(readStoredFrame(seed.db, 'M_F1').atlasLayoutRequest)}`);

    const noop = armLayoutRetry({
      db: seed.db,
      branchId: BRANCH,
      mapId: 'M_F1',
      requestId: 'req_retry2',
      operationId: 'op_retry2',
      turnId: TURN_SPATIAL,
      ports: makePorts(),
    });
    assert.deepEqual(noop.groups, [], '没有失败请求时不得写入');
    assert.equal(noop.issues[0].code, 'LAYOUT_RETRY_NOOP');
    seed.db.run('ROLLBACK');
  } finally {
    seed.close();
  }
});

test('W09-01 延迟外键失败：maps 与 locations 一起回到原值', async () => {
  const seed = await spatialSeed(['M_F1']);
  try {
    const mapBefore = selectOne(seed.db, 'maps', BRANCH, 'M_F1');
    const roomBefore = selectOne(seed.db, 'locations', BRANCH, 'M_F1_A');
    seed.db.run('BEGIN');
    const out = applyPendingSpatialRequests({ db: seed.db, scope: SCOPE, turnId: TURN_SPATIAL, ports: makePorts() });
    assert.deepEqual(out.processed, ['req_M_F1'], JSON.stringify(out.issues));
    // 破坏一个延迟外键：把房间的父地点指向一个不存在的行（DEFERRABLE INITIALLY DEFERRED，COMMIT 才炸）。
    seed.db.run('UPDATE locations SET parent_location_id = ? WHERE branch_id = ? AND id = ?', ['NOPE', BRANCH, 'M_F1_A']);
    let commitError = null;
    try {
      seed.db.run('COMMIT');
    } catch (err) {
      commitError = err;
    }
    assert.ok(commitError, '延迟外键违例必须在 COMMIT 处失败');
    seed.db.run('ROLLBACK');
    assert.equal(selectOne(seed.db, 'maps', BRANCH, 'M_F1').frame_json, mapBefore.frame_json, '地图帧必须回到原值');
    const roomAfter = selectOne(seed.db, 'locations', BRANCH, 'M_F1_A');
    assert.equal(Number(roomAfter.row_rev), Number(roomBefore.row_rev), '地点行必须回到原值');
    assert.equal(roomAfter.grid_x, roomBefore.grid_x);
    assert.equal(roomAfter.grid_y, roomBefore.grid_y);
  } finally {
    seed.close();
  }
});

test('W06-01 copySceneForBranch：纯函数、无场景旧帧原样保留、坏帧给明确诊断', () => {
  const frame = { origin_x: 0, cols: 40, atlasScene: { kind: 'atlas-scene', version: 1, mapId: 'M_F1', branchId: BRANCH, sourceRevision: 3 } };
  const copied = copySceneForBranch(frame, FORK_ID, 7);
  assert.equal(copied.sceneUsable, false, '缺几何的场景应标不可用');
  assert.equal(copied.frame.atlasScene.branchId, FORK_ID);
  assert.equal(copied.frame.atlasScene.sourceRevision, 7);
  assert.equal(copied.frame.atlasScene.provenance.copiedFromBranchId, BRANCH, '来源必须保留');
  assert.equal(frame.atlasScene.branchId, BRANCH, '父对象不能被改动');
  assert.equal(frame.atlasScene.sourceRevision, 3);
  assert.ok(copied.frame.atlasSceneUnavailable, '不可用的场景要标出来');

  const legacy = copySceneForBranch({ origin_x: 0 }, FORK_ID, 7);
  assert.deepEqual(legacy.frame, { origin_x: 0 });
  assert.equal(legacy.sceneUsable, false);
  assert.deepEqual(legacy.issues, []);

  const broken = copySceneForBranch('{不是 JSON', FORK_ID, 7);
  assert.equal(broken.ok, false);
  assert.equal(broken.issues[0].code, 'FRAME_JSON_INVALID');
});

test('W04-01 对账以 SQL 归属为准：跨房间移除、迁入补齐、持有物品不当地面物品', () => {
  const result = reconcileOccupantsSpec({
    scene: null,
    requestSpec: { rooms: OCC_ROOMS, actors: [{ id: 'C1', roomId: 'M_F1_A' }] },
    characters: OCC_CHARACTERS,
    items: OCC_ITEMS,
  });
  // C1 在学校（不在具体教室）→ 移除；C2 在 M_F1_A → 本轮就有锚点。
  assert.deepEqual(result.spec.actors.map((a) => `${a.id}>${a.roomId}`), ['C2>M_F1_A']);
  assert.deepEqual(result.deleted.actors, ['C1'], '迁出必须显式删除，否则「省略=保持」会留下旧锚点');
  assert.ok(result.issues.some((i) => i.code === 'ACTOR_LOCATION_MISMATCH'), JSON.stringify(result.issues));
  // 被持有的物品不当地面物品；无支撑组的地面物品进 looseItemMarkers，不删数据库行。
  assert.deepEqual(result.spec.items, []);
  assert.deepEqual(result.looseItemMarkers, [{ id: 'I_GROUND', roomId: 'M_F1_A', name: '粉笔', type: 'item' }]);
  assert.equal(result.dirty, true);
});

test('W04-02 已保存场景与当前归属一致时 dirty=false，不重复写', () => {
  const scene = {
    kind: 'atlas-scene',
    version: 1,
    mapId: 'M_F1',
    branchId: BRANCH,
    sourceRevision: 3,
    constraints: { rooms: OCC_ROOMS, contents: [], actors: [{ id: 'C2', roomId: 'M_F1_A' }], items: [] },
    layout: { kind: 'floor', rooms: [], groups: [], bodies: [], actors: [], items: [{ id: 'I_GROUND', x: 2, y: 2 }], doors: [], windows: [], lamps: [] },
  };
  const result = reconcileOccupantsSpec({
    scene,
    requestSpec: { rooms: OCC_ROOMS },
    characters: OCC_CHARACTERS,
    items: OCC_ITEMS,
  });
  assert.deepEqual(result.spec.actors.map((a) => a.id), ['C2']);
  assert.deepEqual(result.deleted.actors, []);
  assert.equal(result.dirty, false, '一致的对账结果不该触发重写');
});

/* ─────────────────── W05：迁入迁出的视觉锚点 ─────────────────── */

function itemRow(id, name, locationId, holderId) {
  return {
    branch_id: BRANCH,
    id,
    name,
    aliases_json: '[]',
    kind: 'object',
    description: '',
    quantity: 1,
    unit: '个',
    condition_note: '',
    owner_entity_id: null,
    holder_character_id: holderId,
    container_item_id: null,
    location_id: locationId,
    map_id: locationId ? 'M_F1' : null,
    grid_x: null,
    grid_y: null,
    coord_precision: 'unknown',
    uncertainty_radius_cells: null,
    properties_json: '[]',
    status: 'active',
    merged_into_id: null,
    row_rev: 1,
    created_turn_id: IDS.seedTurn,
    updated_turn_id: IDS.seedTurn,
  };
}

test('W05-01 迁入人物本轮就有锚点；地面物品有视觉点、持有物品没有', async () => {
  const seed = await spatialSeed(['M_F1']);
  seed.db.run('UPDATE characters SET location_id = ?, map_id = ? WHERE branch_id = ? AND id = ?', ['M_F1_A', 'M_F1', BRANCH, IDS.C1]);
  insertRows(seed.db, 'entity_keys', [
    { branch_id: BRANCH, id: 'I_GROUND', kind: 'item' },
    { branch_id: BRANCH, id: 'I_HELD', kind: 'item' },
  ]);
  insertRows(seed.db, 'items', [itemRow('I_GROUND', '粉笔', 'M_F1_A', null), itemRow('I_HELD', '怀表', null, IDS.C1)]);

  seed.db.run('BEGIN');
  const out = applyPendingSpatialRequests({ db: seed.db, scope: SCOPE, turnId: TURN_SPATIAL, ports: makePorts() });
  assert.deepEqual(out.processed, ['req_M_F1'], JSON.stringify(out.issues));
  const scene = readStoredFrame(seed.db, 'M_F1').atlasScene;
  assert.ok(scene, '场景未生成');
  assert.ok(
    scene.layout.actors.some((a) => a.id === IDS.C1),
    `迁入人物没有锚点：${JSON.stringify(scene.layout.actors)}`,
  );
  const itemIds = scene.layout.items.map((i) => i.id);
  assert.ok(itemIds.includes('I_GROUND'), `地面物品没有视觉点：${JSON.stringify(itemIds)}`);
  assert.ok(!itemIds.includes('I_HELD'), '被持有的物品不该出现在地面');
  seed.db.run('ROLLBACK');
});

test('W05-02 人物迁出后旧锚点被删除', async () => {
  const seed = await spatialSeed(['M_F1']);
  seed.db.run('UPDATE characters SET location_id = ?, map_id = ? WHERE branch_id = ? AND id = ?', ['M_F1_A', 'M_F1', BRANCH, IDS.C1]);
  seed.db.run('BEGIN');
  const first = applyPendingSpatialRequests({ db: seed.db, scope: SCOPE, turnId: TURN_SPATIAL, ports: makePorts() });
  assert.deepEqual(first.processed, ['req_M_F1'], JSON.stringify(first.issues));
  assert.ok(readStoredFrame(seed.db, 'M_F1').atlasScene.layout.actors.some((a) => a.id === IDS.C1));

  // 迁出：人物回到学校（不属于本布局的任何房间）。
  seed.db.run('UPDATE characters SET location_id = ?, map_id = NULL WHERE branch_id = ? AND id = ?', [IDS.L2, BRANCH, IDS.C1]);
  const saved = readStoredFrame(seed.db, 'M_F1');
  seed.db.run('UPDATE maps SET frame_json = ? WHERE branch_id = ? AND id = ?', [
    JSON.stringify({ ...saved, atlasLayoutRequest: pendingRequest('req_move', floorSpec('M_F1_A', 'M_F1_B')) }),
    BRANCH,
    'M_F1',
  ]);
  const second = applyPendingSpatialRequests({ db: seed.db, scope: SCOPE, turnId: TURN_SPATIAL, ports: makePorts() });
  assert.deepEqual(second.processed, ['req_move'], JSON.stringify(second.issues));
  const scene = readStoredFrame(seed.db, 'M_F1').atlasScene;
  assert.ok(
    !scene.layout.actors.some((a) => a.id === IDS.C1),
    `迁出后旧锚点仍在：${JSON.stringify(scene.layout.actors)}`,
  );
  seed.db.run('ROLLBACK');
});
