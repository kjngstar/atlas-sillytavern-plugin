/**
 * atlas-sql-server.test.mjs — H01–H04 / H13：SQL 模式的宿主路由与旧 UI DTO 适配器。
 *
 * 覆盖（§16.1 第 4 条 / §7.2 / §11.1 / §6.3 / §10.4）：
 * - 未注入 Repository：`/sql/*` 一律 `SQL_MODE_DISABLED`，不抛错、不建空世界，既有路由不受影响；
 * - 注入 Repository（同一核心）后：`/sql/turn` 走候选 → 宿主确认 → 只有 saved 才 coreSaved=true；
 * - `/sql/state`：空视图 → 空列表；>500 实体 → truncated=true + 精确 droppedCount，且**不删任何行**；
 * - `/sql/retry`：原 turn 已不是推演头 → RETRY_BASE_CHANGED（不把旧时点动作插进新状态）；
 * - `/sql/maintenance`：不改 branches.revision / head_turn_id / clock_s；
 * - `/sql/rollback`：回退到迁移基点后本轮世界行消失；
 * - `/sql/migrate`：旧档一次性迁入，数量/ID 保持；
 * - `toLegacyTurnReceipt`：partial → committed + rejectedGroups，完整 groups/issues 保留；
 * - `toPovStateDto`：作者开关只改 UI 过滤，注入范围逐字段不变。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAtlasServerCore, createMemoryDocumentStore } from './legacy/atlas-server-fixture.ts';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { LEGACY_ENTITY_CAP, toLegacyTurnReceipt, toPovStateDto } from '../src/atlas-db-state-adapter.ts';
import { insertRows, userTables } from './fixtures/atlas-sql/seed.mjs';

const NOW = 1_700_000_000_000;
const now = () => NOW;

function scriptedModel(responses) {
  const calls = [];
  return {
    calls,
    async request(req) {
      calls.push(req);
      const text = responses.length > 0 ? responses.shift() : '{"op":"noop"}';
      return { batchId: req.batchId, text, finishReason: 'stop', httpStatus: 200, durationMs: 3 };
    },
  };
}

function locationOp(name, ref) {
  return `{"op":"location.upsert","ref":"${ref}","data":{"name":"${name}","kind":"building"}}`;
}

function turnBody(overrides = {}) {
  return {
    chatUid: 'chat-sql',
    hostMessageUid: 'msg-1',
    variantKey: 'v1',
    inputHash: 'input-1',
    baseRevision: 0,
    userText: '他走进学校。',
    assistantText: '教师艾琳在圣光学校等候。',
    sourceSnapshot: [{ key: 'msg-1', text: '教师艾琳在圣光学校等候。', hash: 'hash-1', kind: 'story' }],
    phaseBatches: ['observe'],
    ...overrides,
  };
}

/** 组装一个注入了 Repository 的核心（Repository 与浏览器/本地模式是同一个业务核心）。 */
function makeSqlCore({ responses = [], chatUid = 'chat-sql' } = {}) {
  const store = createMemoryDocumentStore();
  const model = scriptedModel(responses);
  const repo = createSqlRepository({ chatUid, branchId: 'main', branchName: '主线', modelPort: model, now });
  const metadatas = new Map();
  const metadataFor = (uid) => {
    if (!metadatas.has(uid)) metadatas.set(uid, {});
    return metadatas.get(uid);
  };
  const core = createAtlasServerCore({
    store,
    now,
    sqlRepository: repo,
    sqlModelPort: model,
    sqlHost: (uid) => ({ chatMetadata: metadataFor(uid), saveSession: async () => ({ ok: true }) }),
  });
  return {
    core,
    repo,
    model,
    metadataFor,
    chatMetadata: metadataFor(chatUid),
    close: () => core.closeSqlSessions(),
  };
}

/** 直接把附加行写进运行库（§18.1：测试 case 自己在事务内创建附加行，不关外键）。 */
function seedManyLocations(repo, branchId, count, prefix = 'bulk') {
  const turnId = repo.internal.currentHeadTurnId();
  const mapId = `${prefix}_map`;
  repo.db.run('BEGIN');
  try {
    insertRows(repo.db, 'maps', [
      {
        branch_id: branchId,
        id: mapId,
        row_rev: 1,
        created_turn_id: turnId,
        updated_turn_id: turnId,
        name: '压力测试图',
        kind: 'world',
        container_location_id: null,
        description: '',
        frame_json: JSON.stringify({ origin_x: 0, origin_y: 0, reference_width_cells: 100, reference_height_cells: 100 }),
        meters_per_cell: 100,
        scale_min_meters_per_cell: 100,
        scale_max_meters_per_cell: 100,
        scale_quality: 'confirmed',
        scale_basis_json: '{}',
        scale_locked: 0,
        calibration_rev: 1,
        background_asset_key: null,
        default_terrain: 'unknown',
        status: 'active',
      },
    ]);
    const keys = [];
    const locations = [];
    for (let index = 0; index < count; index += 1) {
      const id = `${prefix}_loc_${index}`;
      keys.push({ branch_id: branchId, id, kind: 'location' });
      locations.push({
        branch_id: branchId,
        id,
        row_rev: 1,
        created_turn_id: turnId,
        updated_turn_id: turnId,
        name: `批量地点${index}`,
        aliases_json: '[]',
        kind: 'other',
        description: '',
        parent_location_id: null,
        mobility: 'fixed',
        anchor_location_id: null,
        map_id: mapId,
        grid_x: index % 90,
        grid_y: Math.floor(index / 90),
        coord_precision: 'exact',
        uncertainty_radius_cells: null,
        area_geometry_json: null,
        terrain: 'unknown',
        access_rules_json: null,
        vehicle_profile_json: null,
        existence_quality: 'confirmed',
        status: 'active',
        merged_into_id: null,
      });
    }
    insertRows(repo.db, 'entity_keys', keys);
    insertRows(repo.db, 'locations', locations);
    repo.db.run('COMMIT');
  } catch (err) {
    try {
      repo.db.run('ROLLBACK');
    } catch {
      /* 保留原始错误 */
    }
    throw err;
  }
  return mapId;
}

function totalRows(repo) {
  return userTables(repo.db).reduce(
    (sum, table) => sum + Number(queryBound(repo.db, `SELECT COUNT(*) AS n FROM ${table}`, [])[0].n ?? 0),
    0,
  );
}

/* ================================================================== *
 * H13 / SQL_MODE_DISABLED
 * ================================================================== */

test('H13 注入 sqlRuntime：核心包不静态引用 sql.js，运行时由独立 SQL 产物注入', async () => {
  const store = createMemoryDocumentStore();
  const model = scriptedModel([]);
  const repo = createSqlRepository({ chatUid: 'chat-inject', branchId: 'main', modelPort: model, now });
  const chatMetadata = {};
  const sessionModule = await import('../src/atlas-sql-session.ts');
  const real = await sessionModule.loadAtlasSqlRuntime();
  let opened = 0;
  const runtime = {
    ...real,
    openSqlSession: async (options) => {
      opened += 1;
      return real.openSqlSession(options);
    },
  };
  const core = createAtlasServerCore({
    store,
    now,
    sqlRepository: repo,
    sqlRuntime: runtime,
    sqlHost: { chatMetadata, saveSession: async () => ({ ok: true }) },
  });
  try {
    const result = await core.handle('POST', '/sql/state', { chatUid: 'chat-inject', kind: 'simulation' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.kind, 'simulation');
    assert.equal(result.body.data.state.revision, 0);
    assert.equal(opened, 1, '注入的运行时必须被真正使用（而不是偷偷走别的加载路径）');
    // 第二次请求复用同一会话：同一份世界权威
    await core.handle('POST', '/sql/state', { chatUid: 'chat-inject', kind: 'simulation' });
    assert.equal(opened, 1);
    assert.equal(core.sqlMode().sessions, 1);
  } finally {
    await core.closeSqlSessions();
  }
});

test('H13 未注入 Repository：/sql/* 全部 SQL_MODE_DISABLED，不崩也不建空世界', async () => {
  const core = createAtlasServerCore({ store: createMemoryDocumentStore(), now });
  assert.equal(core.sqlMode().enabled, false);
  assert.equal(core.sqlMode().sessions, 0);
  for (const route of ['/sql/turn', '/sql/retry', '/sql/rollback', '/sql/state', '/sql/maintenance', '/sql/migrate']) {
    const result = await core.handle('POST', route, { chatUid: 'chat-x' });
    assert.equal(result.status, 200, `${route} 不得抛错`);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.data.code, 'SQL_MODE_DISABLED');
    assert.equal(result.body.data.sqlMode, false);
    assert.equal(result.body.data.coreSaved, false);
    assert.ok(
      result.body.data.issues.some((issue) => issue.code === 'SQL_MODE_DISABLED'),
      `${route} 必须给出具名 SQL_MODE_DISABLED 问题`,
    );
  }
  // 带插件前缀的路径同样生效
  const prefixed = await core.handle('POST', '/api/plugins/atlas/sql/turn', { chatUid: 'chat-x' });
  assert.equal(prefixed.body.data.code, 'SQL_MODE_DISABLED');
  // 既有路由行为不受影响
  const health = await core.handle('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
});

/* ================================================================== *
 * H01 / H13：/sql/turn 走同一核心的 Repository
 * ================================================================== */

test('H01 /sql/turn：宿主确认才 coreSaved=true；信封写进 chatMetadata.atlas.database', async () => {
  const harness = makeSqlCore({ responses: [locationOp('圣光学校', 'new:school')] });
  try {
    assert.equal(harness.core.sqlMode().enabled, true);
    const result = await harness.core.handle('POST', '/sql/turn', turnBody());
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const data = result.body.data;
    assert.equal(data.coreSaved, true);
    assert.equal(data.receipt.status, 'committed');
    assert.equal(data.revision, 1);
    assert.ok(data.groups.length >= 1, '回执必须给出分组');
    assert.equal(data.legacyReceipt.status, 'committed');
    assert.equal(data.legacyReceipt.coreSaved, true);
    assert.equal(harness.core.sqlMode().sessions, 1, '同一 chat 只有一个会话（同一份世界权威）');
    assert.equal(userTables(harness.repo.db).length, 20);
    assert.ok(harness.chatMetadata.atlas.database, '宿主确认后必须落盘信封');
    assert.equal(harness.chatMetadata.atlas.database.chat_uid, 'chat-sql');

    // 读通道：turn_changes 变化可见（SQL 是唯一权威，旧 UI 只读适配）
    const state = await harness.core.handle('POST', '/sql/state', { chatUid: 'chat-sql', kind: 'changes' });
    assert.equal(state.status, 200);
    assert.ok(state.body.data.state.changes.length >= 1, '本轮变更应出现在变化视图');
    assert.equal(state.body.data.revision, 1);
  } finally {
    await harness.close();
  }
});

test('H01 /sql/turn：宿主保存失败 → coreSaved=false + SESSION_WRITE_FAILED，世界不发布', async () => {
  const store = createMemoryDocumentStore();
  const model = scriptedModel([locationOp('第一地点', 'new:first'), locationOp('第二地点', 'new:second')]);
  const repo = createSqlRepository({ chatUid: 'chat-sql', branchId: 'main', modelPort: model, now });
  const chatMetadata = {};
  let failing = false;
  const core = createAtlasServerCore({
    store,
    now,
    sqlRepository: repo,
    sqlModelPort: model,
    sqlHost: { chatMetadata, saveSession: async () => {
      if (failing) throw new Error('磁盘写入失败（模拟）');
      return { ok: true };
    } },
  });
  try {
    const first = await core.handle('POST', '/sql/turn', turnBody());
    assert.equal(first.body.data.coreSaved, true);
    const envelopeBefore = JSON.stringify(chatMetadata.atlas.database);
    failing = true;
    const second = await core.handle('POST', '/sql/turn', turnBody({ hostMessageUid: 'm2', inputHash: 'i2', baseRevision: 1 }));
    assert.equal(second.body.data.coreSaved, false);
    assert.equal(second.body.data.revision, 1, '失败不推进 revision');
    assert.ok(second.body.data.issues.some((issue) => issue.code === 'SESSION_WRITE_FAILED'));
    assert.equal(JSON.stringify(chatMetadata.atlas.database), envelopeBefore, '上一份信封必须保持不变');
    const names = queryBound(repo.db, 'SELECT name FROM locations', []).map((row) => String(row.name));
    assert.deepEqual(names, ['第一地点'], '失败回合的世界变更不得发布');
  } finally {
    await core.closeSqlSessions();
  }
});

/* ================================================================== *
 * H04：/sql/state 适配器
 * ================================================================== */

test('H04 /sql/state：空视图 → 空列表（绝不复用旧列表）', async () => {
  const harness = makeSqlCore({ responses: [locationOp('圣光学校', 'new:school')] });
  try {
    const empty = await harness.core.handle('POST', '/sql/state', { chatUid: 'chat-sql', kind: 'map' });
    assert.equal(empty.status, 200);
    const emptyDto = empty.body.data.state;
    assert.deepEqual(emptyDto.map.points, []);
    assert.deepEqual(emptyDto.npcDirectory, []);
    assert.deepEqual(emptyDto.objectDirectory, []);
    assert.deepEqual(emptyDto.tableMap.nearby.entries, []);
    assert.deepEqual(emptyDto.coarseList, []);
    assert.equal(emptyDto.metadata.total, 0);
    assert.equal(emptyDto.metadata.returned, 0);
    assert.equal(emptyDto.metadata.truncated, false, '没有丢行就不能说 truncated');
    assert.equal(emptyDto.metadata.droppedCount, 0);
    assert.equal(emptyDto.revision, 0);

    // nearby：未知实体 → 空条目 + 具名原因
    const nearby = await harness.core.handle('POST', '/sql/state', { chatUid: 'chat-sql', kind: 'nearby', entityId: 'nobody' });
    assert.deepEqual(nearby.body.data.state.npcDirectory, []);
    assert.equal(nearby.body.data.state.tableMap.nearby.total, 0);

    // changes：空时间线
    const changes = await harness.core.handle('POST', '/sql/state', { chatUid: 'chat-sql', kind: 'changes' });
    assert.deepEqual(changes.body.data.state.changes, []);

    // 有新行之后再查同一个视图：必须返回新列表（不是上一份缓存）
    await harness.core.handle('POST', '/sql/turn', turnBody());
    const after = await harness.core.handle('POST', '/sql/state', { chatUid: 'chat-sql', kind: 'changes' });
    assert.ok(after.body.data.state.changes.length >= 1);
    assert.notEqual(after.body.data.state.changes.length, 0);
  } finally {
    await harness.close();
  }
});

test('H04 /sql/state：>500 实体只是有界投影（truncated + 精确 droppedCount），不删任何行', async () => {
  const harness = makeSqlCore();
  try {
    await harness.core.handle('POST', '/sql/state', { chatUid: 'chat-sql', kind: 'map' }); // 打开运行库
    seedManyLocations(harness.repo, 'main', 620);
    const locationCount = Number(queryBound(harness.repo.db, 'SELECT COUNT(*) AS n FROM locations', [])[0].n);
    assert.equal(locationCount, 620);
    const rowsBefore = totalRows(harness.repo);

    const result = await harness.core.handle('POST', '/sql/state', { chatUid: 'chat-sql', kind: 'map' });
    const dto = result.body.data.state;
    assert.equal(dto.metadata.cap, LEGACY_ENTITY_CAP);
    assert.equal(LEGACY_ENTITY_CAP, 500);
    assert.equal(dto.metadata.total, 620, 'total 是完整查询结果的行数');
    assert.equal(dto.metadata.returned, 500);
    assert.equal(dto.metadata.truncated, true);
    assert.equal(dto.metadata.droppedCount, 120, '丢弃数必须精确');
    assert.equal(dto.map.points.length, 500, '地图点也只返回有界子集');
    assert.ok(dto.metadata.diagnostics.some((issue) => issue.code === 'LEGACY_ENTITY_CAP_APPLIED'));
    assert.match(String(dto.metadata.diagnostics[0].message), /120/);
    assert.equal(dto.map.pointCount, 620, 'pointCount 报真实总量，不是投影后的长度');

    // 有界投影绝不反过来删库
    assert.equal(Number(queryBound(harness.repo.db, 'SELECT COUNT(*) AS n FROM locations', [])[0].n), 620);
    assert.equal(totalRows(harness.repo), rowsBefore, '适配器不得改动数据库任何一行');

    // 显式提高上限：全部返回，truncated=false
    const wider = await harness.core.handle('POST', '/sql/state', { chatUid: 'chat-sql', kind: 'map', entityLimit: 1000 });
    assert.equal(wider.body.data.state.metadata.returned, 620);
    assert.equal(wider.body.data.state.metadata.truncated, false);
    assert.equal(wider.body.data.state.map.points.length, 620);
  } finally {
    await harness.close();
  }
});

test('§6.3 toLegacyTurnReceipt：partial → committed + rejectedGroups，完整 groups 保留', () => {
  const receipt = {
    turnId: 'turn-1',
    anchor: { chatUid: 'chat-sql', branchId: 'main', parentTurnId: 'turn-0', hostMessageUid: 'm1', variantKey: 'v1', baseRevision: 0, baseStorageRevision: 0, inputHash: 'i1' },
    status: 'partial',
    groups: [
      { groupId: 'g-ok', opIds: ['op-1'], status: 'applied', issues: [], changedRows: 2 },
      { groupId: 'g-bad', opIds: ['op-2'], status: 'rejected', issues: [{ code: 'REF_UNKNOWN', path: '$.op', message: '未知引用', severity: 'error', retryable: true }], changedRows: 0 },
    ],
    issues: [{ code: 'SOME_WARNING', path: '$', message: '注意', severity: 'warning', retryable: true }],
    clockBeforeS: 0,
    clockAfterS: 30,
    simulatedUntilS: 30,
    worldChanged: true,
    timeChanged: true,
  };
  const legacy = toLegacyTurnReceipt(receipt, { coreSaved: true });
  assert.equal(legacy.status, 'committed', '内部 partial 不强迫旧接口新增枚举');
  assert.deepEqual(legacy.rejectedGroups, ['g-bad']);
  assert.equal(legacy.coreSaved, true);
  assert.equal(legacy.warnings.length, 1);
  assert.equal(legacy.warnings[0].code, 'SOME_WARNING');
  assert.deepEqual(legacy.groups, receipt.groups, '完整分组必须保留');
  assert.deepEqual(legacy.receipt.groups, receipt.groups);
  assert.deepEqual(legacy.receipt.issues, receipt.issues);
  assert.equal(legacy.receipt.status, 'partial', '内部状态不丢');
  assert.equal(legacy.groupCounts.applied, 1);
  assert.equal(legacy.groupCounts.rejected, 1);

  // 原生 failed 始终失败；有独立有效时间变化的原生 partial 仍适配为 committed。
  const onlyRejected = { ...receipt, groups: [receipt.groups[1]] };
  assert.equal(toLegacyTurnReceipt({ ...onlyRejected, status: 'failed', worldChanged: false, timeChanged: false }).status, 'failed');
  assert.equal(toLegacyTurnReceipt({ ...onlyRejected, status: 'partial', worldChanged: false, timeChanged: true }).status, 'committed');
  assert.equal(toLegacyTurnReceipt({ ...receipt, status: 'failed', worldChanged: false, timeChanged: false }).status, 'failed');
  assert.equal(toLegacyTurnReceipt({ ...receipt, status: 'noop', groups: [], worldChanged: false, timeChanged: false }).status, 'noop');
  // 未由宿主确认时不得伪造 coreSaved
  assert.equal(toLegacyTurnReceipt(receipt).coreSaved, null);
});

test('§10.4 toPovStateDto：作者开关只改 UI 过滤，注入范围逐字段相同', () => {
  const projection = {
    povId: 'C1',
    isPovRow: false,
    knownLocations: [{ locationId: 'L1', name: '圣罗兰城', source: 'observation', firstReceivedAtS: 0, belief: 'believed' }],
    knownCharacters: [{ entityId: 'C2', name: '信使', belief: 'heard', attention: 'normal', reactionNote: '', identityKnown: true }],
    lastSeen: [{ entityId: 'C2', name: '信使', locationId: 'L1', atS: 10 }],
    knownFacts: [{ informationId: 'I1', title: '城主病重', content: '听说城主病重', truthForAuthor: 'false', belief: 'doubted', payload: null }],
    knownChannels: [{ channelId: 'CH1', name: '监视水晶', kind: 'surveillance' }],
    boundaries: ['字段级投影'],
  };
  const pov = toPovStateDto(projection, { viewMode: 'pov' });
  const author = toPovStateDto(projection, { viewMode: 'author' });
  assert.equal(pov.viewMode, 'pov');
  assert.equal(author.viewMode, 'author');
  assert.deepEqual(author.injectedScope, pov.injectedScope, '§10.4：切作者图不得扩大注入范围');
  assert.deepEqual(author.promptScope, pov.promptScope);
  assert.equal(author.injectionUnchangedByViewMode, true);
  assert.equal(pov.ui.showAuthorTruth, false);
  assert.equal(author.ui.showAuthorTruth, true);
  assert.equal(author.ui.displayOnly, true);
  assert.equal(author.ui.authorOnly.truthForAuthor[0].truthStatus, 'false');
  assert.deepEqual(pov.ui.authorOnly.truthForAuthor, author.ui.authorOnly.truthForAuthor);
});

test('§10.4 /sql/state kind=prompt：作者开关只影响 UI，注入范围不变', async () => {
  const harness = makeSqlCore();
  try {
    await harness.core.handle('POST', '/sql/state', { chatUid: 'chat-sql', kind: 'map' });
    const pov = await harness.core.handle('POST', '/sql/state', { chatUid: 'chat-sql', kind: 'prompt', viewMode: 'pov' });
    const author = await harness.core.handle('POST', '/sql/state', { chatUid: 'chat-sql', kind: 'prompt', viewMode: 'author' });
    assert.equal(pov.status, 200);
    assert.deepEqual(author.body.data.state.injectedScope, pov.body.data.state.injectedScope);
    assert.equal(author.body.data.state.ui.showAuthorTruth, true);
    assert.equal(pov.body.data.state.ui.showAuthorTruth, false);
    assert.ok(Array.isArray(pov.body.data.promptScope));
  } finally {
    await harness.close();
  }
});

/* ================================================================== *
 * H02 / H03 / 维护 / 迁移
 * ================================================================== */

test('H02 /sql/retry：原 turn 已不是推演头 → RETRY_BASE_CHANGED（不把旧时点动作插进新状态）', async () => {
  const harness = makeSqlCore({ responses: [locationOp('圣光学校', 'new:school')] });
  try {
    const turn = await harness.core.handle('POST', '/sql/turn', turnBody());
    assert.equal(turn.body.data.coreSaved, true);
    const head = harness.repo.internal.currentHeadTurnId();
    const retry = await harness.core.handle('POST', '/sql/retry', {
      chatUid: 'chat-sql',
      turnId: 'turn_that_is_not_head',
      attemptId: 'retry-1',
      clockS: 0,
      groups: [],
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.data.status, 'replay_required');
    assert.ok(retry.body.data.issues.some((issue) => issue.code === 'RETRY_BASE_CHANGED'));
    assert.equal(retry.body.data.coreSaved, false, '没有补交就不该保存');
    assert.equal(harness.repo.internal.currentHeadTurnId(), head, 'head 不得因为补交被改写');
  } finally {
    await harness.close();
  }
});

test('H02 /sql/retry：已成功的组只返回 duplicate，不重复插入、不第二次推进时间', async () => {
  const harness = makeSqlCore({ responses: [locationOp('圣光学校', 'new:school')] });
  try {
    const turn = await harness.core.handle('POST', '/sql/turn', turnBody());
    const turnId = turn.body.data.receipt.turnId;
    const change = queryBound(
      harness.repo.db,
      'SELECT target_table, target_row_id, operation_id FROM turn_changes WHERE turn_id = ? LIMIT 1',
      [turnId],
    )[0];
    assert.ok(change, '本轮必须有变更日志');
    const clockBefore = Number(queryBound(harness.repo.db, 'SELECT clock_s FROM branches WHERE id = ?', ['main'])[0].clock_s);
    const locationsBefore = Number(queryBound(harness.repo.db, 'SELECT COUNT(*) AS n FROM locations', [])[0].n);
    const table = String(change.target_table);
    const rowId = String(change.target_row_id);
    const opId = String(change.operation_id);
    const retry = await harness.core.handle('POST', '/sql/retry', {
      chatUid: 'chat-sql',
      turnId,
      attemptId: 'retry-dup',
      clockS: clockBefore,
      appliedKeys: [`${table}\u0000${rowId}\u0000${opId}`],
      groups: [
        {
          id: 'g_retry',
          opIds: [opId],
          dependsOn: [],
          readSet: [],
          mutations: [{ table, rowId, before: null, after: {}, sourceOpIds: [opId], basis: {} }],
        },
      ],
    });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.data.status, 'duplicate');
    assert.equal(retry.body.data.groups[0].status, 'duplicate');
    assert.equal(retry.body.data.groups[0].changedRows, 0);
    assert.equal(Number(queryBound(harness.repo.db, 'SELECT COUNT(*) AS n FROM locations', [])[0].n), locationsBefore, '不得重复插入/重复消耗');
    assert.equal(
      Number(queryBound(harness.repo.db, 'SELECT clock_s FROM branches WHERE id = ?', ['main'])[0].clock_s),
      clockBefore,
      '时间不得第二次前进',
    );
  } finally {
    await harness.close();
  }
});

test('H13 /sql/maintenance：保存维护结果但不改 revision/head/clock', async () => {
  const harness = makeSqlCore({ responses: [locationOp('圣光学校', 'new:school')] });
  try {
    const turn = await harness.core.handle('POST', '/sql/turn', turnBody());
    assert.equal(turn.body.data.coreSaved, true);
    const readBranch = () =>
      queryBound(harness.repo.db, 'SELECT revision, head_turn_id, clock_s, clock_min_s, clock_max_s, simulation_cursor_s FROM branches WHERE id = ?', ['main'])[0];
    const before = { ...readBranch() };
    const storageBefore = harness.repo.storageRevision;
    const result = await harness.core.handle('POST', '/sql/maintenance', { chatUid: 'chat-sql', hostMessageUid: 'maint-1' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.coreSaved, true);
    assert.equal(result.body.data.storageRevision, storageBefore + 1);
    assert.deepEqual({ ...readBranch() }, before, '维护不得改 revision/head/clock');
    assert.ok(result.body.data.envelope.sha256);
  } finally {
    await harness.close();
  }
});

test('H03 /sql/rollback：回退到迁移基点后本轮世界行消失，revision 前进', async () => {
  const harness = makeSqlCore({ responses: [locationOp('圣光学校', 'new:school')] });
  try {
    const turn = await harness.core.handle('POST', '/sql/turn', turnBody());
    assert.equal(turn.body.data.coreSaved, true);
    assert.equal(Number(queryBound(harness.repo.db, 'SELECT COUNT(*) AS n FROM locations', [])[0].n), 1);
    const migrationTurnId = String(queryBound(harness.repo.db, "SELECT id FROM turns WHERE kind = 'migration'", [])[0].id);
    const rollback = await harness.core.handle('POST', '/sql/rollback', {
      chatUid: 'chat-sql',
      targetParentTurnId: migrationTurnId,
      expectedRevision: 1,
    });
    assert.equal(rollback.status, 200, JSON.stringify(rollback.body));
    assert.equal(rollback.body.data.coreSaved, true);
    assert.equal(rollback.body.data.revision, 2);
    assert.equal(Number(queryBound(harness.repo.db, 'SELECT COUNT(*) AS n FROM locations', [])[0].n), 0, '本轮插入的地点必须被回退');
    const branch = queryBound(harness.repo.db, 'SELECT head_turn_id, revision FROM branches WHERE id = ?', ['main'])[0];
    assert.equal(String(branch.head_turn_id), migrationTurnId);
    assert.equal(Number(branch.revision), 2);
  } finally {
    await harness.close();
  }
});

test('§7.2 /sql/migrate：旧档一次性迁入，数量/ID 保持且不重复', async () => {
  const harness = makeSqlCore({ chatUid: 'chat-mig' });
  const legacy = {
    chatMetadata: {
      atlas: {
        worldId: 'world-legacy',
        tables: {
          schemaVersion: 1,
          worldId: 'world-legacy',
          branches: {
            main: {
              locations: [
                { id: 'loc:1', name: '旧城', kind: 'city', mapId: 'world', gridX: 3, gridY: 4, rumors: ['城主病重', '河道将开'] },
                { id: 'loc:2', name: '旧学校', kind: 'building', parentLocationId: 'loc:1' },
                { id: 'loc:3', name: '旧教室', kind: 'room', parentLocationId: 'loc:2' },
              ],
              characters: [
                { id: 'npc:1', name: '艾琳', identity: '学校教师', locationId: 'loc:2' },
                { id: 'npc:2', name: '信使', locationId: 'loc:1' },
                { id: 'npc:3', name: '刺客', locationId: 'loc:1' },
                { id: 'npc:4', name: '国王', locationId: 'loc:1' },
              ],
              items: [
                { id: 'item:1', name: '旧剑', kind: 'equipment', holderCharacterId: 'npc:1' },
                { id: 'item:2', name: '旧地图', locationId: 'loc:1' },
              ],
            },
          },
        },
        maps: { schemaVersion: 2, pointMeta: {}, submaps: {}, calibrations: {} },
      },
    },
  };
  try {
    const result = await harness.core.handle('POST', '/sql/migrate', { chatUid: 'chat-mig', legacy });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const data = result.body.data;
    assert.equal(data.inspection.kind, 'legacy');
    assert.equal(data.saved, true);
    assert.equal(data.counts.locations, 3);
    assert.equal(data.counts.characters, 4);
    assert.equal(data.counts.items, 2);
    assert.equal(data.counts.knowledge, 0, '旧 rumors 不得让所有人瞬间知情');
    assert.equal(data.backup.kind, 'legacy_backup');

    const state = await harness.core.handle('POST', '/sql/state', { chatUid: 'chat-mig', kind: 'entity', entityId: 'loc:1' });
    assert.equal(state.body.data.state.entities.length, 1);
    assert.equal(state.body.data.state.entities[0].kind, 'location');

    // 二次迁移不重复
    const again = await harness.core.handle('POST', '/sql/migrate', { chatUid: 'chat-mig', legacy });
    assert.equal(again.body.data.counts.locations, 3);
    assert.equal(again.body.data.mapped['kind:locations'] ?? 0, 0);
  } finally {
    await harness.close();
  }
});
