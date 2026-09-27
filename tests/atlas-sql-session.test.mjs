/**
 * atlas-sql-session.test.mjs — H01–H03 / T12 / T13（部分）：单聊天 SQL 会话桥。
 *
 * 覆盖（§7.1–§7.3 / §16.1 / §16.4 / §18.3 T12+T13）：
 * - sqlMode 开关默认关闭，只接受严格 true；
 * - 新聊天（无信封）：source='new'、20 表、branch + migration turn、**没有「起点」地点**；
 *   第一轮成功提交后 `chatMetadata.atlas.database` 才有信封；
 * - 宿主保存失败：SESSION_WRITE_FAILED / coreSaved=false / 世界不发布 / 上一份信封逐字段不变；
 * - 宿主无完成信号（requested）：saved=false、保留候选、绝不 coreSaved=true；
 * - 复制聊天（信封 chat_uid ≠ 当前聊天）→ CHAT_CHANGED 且不写新聊天；
 * - 损坏 / 更高 schema 信封 → ENVELOPE_* / DB_SCHEMA_UNSUPPORTED，且**不建空世界**；
 * - 两个 chatUid 完全隔离（T12）；
 * - 同基版本并发只有一个提交成功，另一个 STALE_BASE；只有维护更新时不动 revision/head/clock（T13）；
 * - 旧档迁移：数量与 ID 不变、knowledge 保持 0、备份只返回不写进每楼、第二次不重复导入。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATLAS_SQL_MODE_KEY,
  closeSqlSession,
  isSqlModeEnabled,
  migrateSessionToSql,
  openSqlSession,
  persistSqlSession,
  runSqlTurn,
} from '../src/atlas-sql-session.ts';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { countRows, foreignKeyCheck, userTables } from './fixtures/atlas-sql/seed.mjs';

const NOW = 1_700_000_000_000;
const now = () => NOW;

/** 固定输出模型端口：按调用顺序返回预置文本。 */
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

function sourceSnapshot() {
  return [{ key: 'msg-1', text: '教师艾琳在圣光学校等候。', hash: 'hash-1', kind: 'story' }];
}

function turnInput(session, overrides = {}) {
  return {
    anchor: {
      chatUid: session.chatUid,
      branchId: session.branchId,
      parentTurnId: session.repo.internal.currentHeadTurnId(),
      hostMessageUid: 'msg-1',
      variantKey: 'v1',
      baseRevision: session.repo.internal.currentRevision(),
      baseStorageRevision: session.repo.storageRevision,
      inputHash: 'input-1',
      ...overrides,
    },
    userText: '他走进学校。',
    assistantText: '教师艾琳在圣光学校等候。',
    sourceSnapshot: sourceSnapshot(),
    phaseBatches: ['observe'],
    manual: false,
  };
}

/** 一个最小宿主：一份 chatMetadata + 一个可切换成败的保存函数。 */
function makeHost(chatMetadata = {}) {
  const saves = [];
  return {
    chatMetadata,
    saves,
    failing: false,
    async saveSession() {
      saves.push(saves.length + 1);
      if (this.failing) throw new Error('磁盘写入失败（模拟）');
      return { ok: true };
    },
  };
}

function envelopeOf(metadata) {
  return metadata?.atlas?.database ?? null;
}

function locationNames(session) {
  return queryBound(session.repo.db, 'SELECT name FROM locations WHERE branch_id = ?', [session.branchId]).map((row) => String(row.name));
}

/* ================================================================== *
 * 模式开关
 * ================================================================== */

test('sqlMode：默认关闭；只接受严格 true 的三种形状', () => {
  assert.equal(ATLAS_SQL_MODE_KEY, 'sqlMode');
  assert.equal(isSqlModeEnabled(undefined), false);
  assert.equal(isSqlModeEnabled(null), false);
  assert.equal(isSqlModeEnabled({}), false, '缺省必须关闭（既有行为一字不变）');
  assert.equal(isSqlModeEnabled(false), false);
  assert.equal(isSqlModeEnabled(true), true);
  assert.equal(isSqlModeEnabled({ sqlMode: true }), true);
  assert.equal(isSqlModeEnabled({ atlas: { sqlMode: true } }), true);
  assert.equal(isSqlModeEnabled({ atlas: { sqlMode: false } }), false);
  // 不猜用户意图：字符串 / 数字 / 缺省都不算启用
  assert.equal(isSqlModeEnabled({ sqlMode: 'true' }), false);
  assert.equal(isSqlModeEnabled({ sqlMode: 1 }), false);
  assert.equal(isSqlModeEnabled({ atlas: {} }), false);
});

/* ================================================================== *
 * T12：新聊天 / 隔离
 * ================================================================== */

test('T12-01 新聊天无信封：source=new、20 表、branch+migration turn、没有「起点」', async () => {
  const host = makeHost();
  const model = scriptedModel([locationOp('圣光学校', 'new:school')]);
  const session = await openSqlSession({
    chatUid: 'chat-new',
    chatMetadata: host.chatMetadata,
    saveSession: host.saveSession,
    modelPort: model,
    now,
  });
  try {
    assert.equal(session.source, 'new');
    assert.equal(session.envelopePresent, false);
    assert.equal(envelopeOf(host.chatMetadata), null, '成功提交前不得落盘');
    assert.equal(userTables(session.repo.db).length, 20, '必须恰 20 张用户表');
    assert.deepEqual(foreignKeyCheck(session.repo.db), []);

    const branch = queryBound(session.repo.db, 'SELECT * FROM branches WHERE id = ?', [session.branchId]);
    assert.equal(branch.length, 1);
    assert.equal(Number(branch[0].revision), 0);
    const turns = queryBound(session.repo.db, 'SELECT id, kind, status FROM turns WHERE branch_id = ?', [session.branchId]);
    assert.equal(turns.length, 1, '新库只有一条 migration/seed turn');
    assert.equal(turns[0].kind, 'migration');
    assert.equal(turns[0].status, 'committed');
    assert.equal(branch[0].head_turn_id, turns[0].id);
    assert.equal(countRows(session.repo.db, 'locations', session.branchId), 0, '不建「起点」地点');
    const start = queryBound(session.repo.db, "SELECT id FROM locations WHERE name IN ('起点','开始')", []);
    assert.equal(start.length, 0, '不得建立「起点」地点');

    // 第一轮成功提交：宿主确认后才 saved=true，并写入信封
    const result = await runSqlTurn(session, turnInput(session));
    assert.equal(result.saved, true);
    assert.equal(result.coreSaved, true);
    assert.equal(result.receipt.status, 'committed');
    const envelope = envelopeOf(host.chatMetadata);
    assert.ok(envelope, '成功提交后 chatMetadata.atlas.database 必须存在');
    assert.equal(envelope.format, 'atlas-sqlite');
    assert.equal(envelope.encoding, 'sqlite-base64');
    assert.equal(envelope.chat_uid, 'chat-new');
    assert.equal(envelope.storage_version, 1);
    assert.match(String(envelope.sha256), /^[0-9a-f]{64}$/);
    assert.ok(Number(envelope.byte_length) > 0);
    assert.equal(session.repo.internal.currentRevision(), 1);
    assert.deepEqual(locationNames(session), ['圣光学校'], '已确认保存的世界才对 queryView 可见');
  } finally {
    await closeSqlSession(session);
  }
});

test('T12-02 两个 chatUid 完全隔离：各自独立世界、互不串档', async () => {
  const hostA = makeHost();
  const hostB = makeHost();
  const sessionA = await openSqlSession({
    chatUid: 'chat-A',
    chatMetadata: hostA.chatMetadata,
    saveSession: hostA.saveSession,
    modelPort: scriptedModel([locationOp('圣光学校', 'new:school')]),
    now,
  });
  const sessionB = await openSqlSession({
    chatUid: 'chat-B',
    chatMetadata: hostB.chatMetadata,
    saveSession: hostB.saveSession,
    modelPort: scriptedModel([locationOp('圣光学校', 'new:school')]),
    now,
  });
  try {
    await runSqlTurn(sessionA, turnInput(sessionA));
    // 同名地点分别建在两个 chat 里：ID 必须不同，且 A 的 ID 在 B 里解析不到
    await runSqlTurn(sessionB, turnInput(sessionB, { hostMessageUid: 'msg-b', inputHash: 'input-b' }));
    assert.deepEqual(locationNames(sessionA), ['圣光学校']);
    assert.deepEqual(locationNames(sessionB), ['圣光学校']);
    const idA = String(queryBound(sessionA.repo.db, "SELECT id FROM locations WHERE name = '圣光学校'", [])[0].id);
    const idB = String(queryBound(sessionB.repo.db, "SELECT id FROM locations WHERE name = '圣光学校'", [])[0].id);
    assert.notEqual(idA, idB, '同名不同 chat 必须是两个不同身份');
    const inB = await sessionB.repo.queryView({ kind: 'entity', branchId: sessionB.branchId, entityId: idA });
    assert.equal(inB.metadata.reason, 'ENTITY_UNKNOWN', 'B 不得解析 A 的实体 ID');
    const inA = await sessionA.repo.queryView({ kind: 'entity', branchId: sessionA.branchId, entityId: idA });
    assert.equal(inA.items.length, 1);
    assert.equal(queryBound(sessionB.repo.db, 'SELECT COUNT(*) AS n FROM locations WHERE id = ?', [idA])[0].n, 0);
    assert.equal(envelopeOf(hostA.chatMetadata).chat_uid, 'chat-A');
    assert.equal(envelopeOf(hostB.chatMetadata).chat_uid, 'chat-B');
    assert.notEqual(sessionA.repo.db, sessionB.repo.db);
  } finally {
    await closeSqlSession(sessionA);
    await closeSqlSession(sessionB);
  }
});

/* ================================================================== *
 * 宿主保存的三种结果
 * ================================================================== */

test('T12-03 宿主保存失败：SESSION_WRITE_FAILED / coreSaved=false / 世界不发布 / 信封不变', async () => {
  const host = makeHost();
  const model = scriptedModel([locationOp('第一地点', 'new:first'), locationOp('第二地点', 'new:second')]);
  const session = await openSqlSession({
    chatUid: 'chat-fail',
    chatMetadata: host.chatMetadata,
    saveSession: host.saveSession.bind(host),
    modelPort: model,
    now,
  });
  try {
    const first = await runSqlTurn(session, turnInput(session, { hostMessageUid: 'm1', inputHash: 'i1' }));
    assert.equal(first.saved, true);
    const envelopeBefore = JSON.parse(JSON.stringify(envelopeOf(host.chatMetadata)));
    assert.deepEqual(locationNames(session), ['第一地点']);

    host.failing = true;
    const second = await runSqlTurn(session, turnInput(session, { hostMessageUid: 'm2', inputHash: 'i2' }));
    assert.equal(second.saved, false);
    assert.equal(second.coreSaved, false, '宿主没 saved 就绝不能 coreSaved=true');
    assert.ok(
      second.issues.some((issue) => issue.code === 'SESSION_WRITE_FAILED'),
      `应报 SESSION_WRITE_FAILED，实际：${JSON.stringify(second.issues.map((i) => i.code))}`,
    );
    assert.deepEqual(envelopeOf(host.chatMetadata), envelopeBefore, '上一份信封必须逐字段不变');
    assert.deepEqual(locationNames(session), ['第一地点'], '未确认的世界变更不得发布');
    assert.equal(session.repo.internal.currentRevision(), 1, '失败的回合不推进 revision');
    assert.equal(session.repo.getCandidate(second.commit.token), null, '失败必须丢弃候选');
  } finally {
    await closeSqlSession(session);
  }
});

test('T12-04 宿主无完成信号（requested）：saved=false、保留候选、不伪造 coreSaved', async () => {
  const host = makeHost();
  const session = await openSqlSession({
    chatUid: 'chat-requested',
    chatMetadata: host.chatMetadata,
    saveSession: host.saveSession,
    confirmSave: false,
    modelPort: scriptedModel([locationOp('待确认地点', 'new:pending')]),
    now,
  });
  try {
    const result = await runSqlTurn(session, turnInput(session));
    assert.equal(result.saved, false);
    assert.equal(result.coreSaved, false);
    assert.ok(result.issues.some((issue) => issue.code === 'HOST_SAVE_UNCONFIRMED' || issue.retryable === true));
    assert.ok(session.repo.getCandidate(result.commit.token), 'requested 必须保留候选待核对');
    assert.deepEqual(locationNames(session), [], '未确认的世界不发布');

    // 直接 persist 也必须是 saved:false + requested
    const persisted = await persistSqlSession(session, { commit: result.commit });
    assert.equal(persisted.saved, false);
    assert.equal(persisted.ack?.result, 'requested');
  } finally {
    await closeSqlSession(session);
  }
});

/* ================================================================== *
 * 复制聊天 / 损坏信封
 * ================================================================== */

test('T12-05 信封 chat_uid ≠ 当前聊天（复制聊天）→ CHAT_CHANGED，且不写新聊天', async () => {
  const hostA = makeHost();
  const sessionA = await openSqlSession({
    chatUid: 'chat-A',
    chatMetadata: hostA.chatMetadata,
    saveSession: hostA.saveSession,
    modelPort: scriptedModel([locationOp('圣光学校', 'new:school')]),
    now,
  });
  try {
    await runSqlTurn(sessionA, turnInput(sessionA));
    assert.ok(envelopeOf(hostA.chatMetadata));
  } finally {
    await closeSqlSession(sessionA);
  }

  // 宿主「复制聊天」：新聊天拿到旧 metadata
  const copied = { atlas: { database: JSON.parse(JSON.stringify(envelopeOf(hostA.chatMetadata))) } };
  const before = JSON.stringify(copied);
  const beforeBytes = copied.atlas.database.data.length;
  await assert.rejects(
    () =>
      openSqlSession({
        chatUid: 'chat-B',
        chatMetadata: copied,
        saveSession: async () => ({ ok: true }),
        modelPort: scriptedModel([]),
        now,
      }),
    (err) => {
      assert.equal(err.code, 'CHAT_CHANGED', `应报 CHAT_CHANGED，实际 ${err.code}`);
      assert.match(err.message, /chat-A/);
      assert.match(err.message, /chat-B/);
      return true;
    },
  );
  assert.equal(JSON.stringify(copied), before, '复制聊天不得被写入新聊天');
  assert.equal(copied.atlas.database.data.length, beforeBytes);
});

test('T12-06 损坏 / 更高 schema 信封：明确失败，且不建空世界', async () => {
  const good = await (async () => {
    const host = makeHost();
    const session = await openSqlSession({
      chatUid: 'chat-good',
      chatMetadata: host.chatMetadata,
      saveSession: host.saveSession,
      modelPort: scriptedModel([locationOp('圣光学校', 'new:school')]),
      now,
    });
    await runSqlTurn(session, turnInput(session));
    const envelope = JSON.parse(JSON.stringify(envelopeOf(host.chatMetadata)));
    await closeSqlSession(session);
    return envelope;
  })();

  // 1) 哈希对不上的损坏档
  const corrupt = { ...good, chat_uid: 'chat-corrupt', sha256: 'f'.repeat(64) };
  const metadataCorrupt = { atlas: { database: corrupt } };
  const beforeCorrupt = JSON.stringify(metadataCorrupt);
  const probeRepo = createSqlRepository({ chatUid: 'chat-corrupt', branchId: 'main', now });
  await assert.rejects(
    () =>
      openSqlSession({
        chatUid: 'chat-corrupt',
        chatMetadata: metadataCorrupt,
        saveSession: async () => ({ ok: true }),
        modelPort: scriptedModel([]),
        repository: probeRepo,
        now,
      }),
    (err) => {
      assert.match(String(err.code), /^ENVELOPE_/, `应是 ENVELOPE_* 失败，实际 ${err.code}`);
      return true;
    },
  );
  assert.equal(JSON.stringify(metadataCorrupt), beforeCorrupt, '损坏档必须原样保留');
  assert.throws(
    () => probeRepo.internal.currentRevision(),
    (err) => err && err.code === 'DB_NOT_OPEN',
    '损坏档不得建一个空世界',
  );

  // 2) 高于本实现的 schema_version
  const higher = { ...good, chat_uid: 'chat-higher', schema_version: 99 };
  const metadataHigher = { atlas: { database: higher } };
  const beforeHigher = JSON.stringify(metadataHigher);
  await assert.rejects(
    () =>
      openSqlSession({
        chatUid: 'chat-higher',
        chatMetadata: metadataHigher,
        saveSession: async () => ({ ok: true }),
        modelPort: scriptedModel([]),
        now,
      }),
    (err) => {
      assert.equal(err.code, 'DB_SCHEMA_UNSUPPORTED');
      return true;
    },
  );
  assert.equal(JSON.stringify(metadataHigher), beforeHigher, '更高版本存档保持只读原样');
});

/* ================================================================== *
 * T13：并发与维护
 * ================================================================== */

test('T13-01 同基版本并发：只有一个提交成功，另一个 STALE_BASE', async () => {
  const host = makeHost();
  const session = await openSqlSession({
    chatUid: 'chat-race',
    chatMetadata: host.chatMetadata,
    saveSession: host.saveSession,
    modelPort: scriptedModel([locationOp('甲地', 'new:jia'), locationOp('乙地', 'new:yi')]),
    now,
  });
  try {
    assert.equal(session.repo.internal.currentRevision(), 0);
    const [first, second] = await Promise.allSettled([
      runSqlTurn(session, turnInput(session, { hostMessageUid: 'm1', inputHash: 'i1' })),
      runSqlTurn(session, turnInput(session, { hostMessageUid: 'm2', inputHash: 'i2' })),
    ]);
    const results = [first, second];
    const committed = results.filter((r) => r.status === 'fulfilled' && r.value.saved === true);
    const stale = results.filter((r) => r.status === 'rejected' && r.reason && r.reason.code === 'STALE_BASE');
    assert.equal(committed.length, 1, `恰好一个提交成功，实际 ${JSON.stringify(results.map((r) => (r.status === 'fulfilled' ? r.value.saved : r.reason?.code)))}`);
    assert.equal(stale.length, 1, '后到者必须 STALE_BASE');
    assert.equal(session.repo.internal.currentRevision(), 1, '只推进一次业务 revision');
    const names = locationNames(session);
    assert.equal(names.length, 1, `只有一个候选被发布：${JSON.stringify(names)}`);
  } finally {
    await closeSqlSession(session);
  }
});

test('T13-02 只有维护更新：不改 branches.revision / head_turn_id / clock_s', async () => {
  const host = makeHost();
  const session = await openSqlSession({
    chatUid: 'chat-maint',
    chatMetadata: host.chatMetadata,
    saveSession: host.saveSession,
    modelPort: scriptedModel([locationOp('圣光学校', 'new:school')]),
    now,
  });
  try {
    const committed = await runSqlTurn(session, turnInput(session));
    assert.equal(committed.saved, true);
    const readBranch = () =>
      queryBound(session.repo.db, 'SELECT revision, head_turn_id, clock_s, clock_min_s, clock_max_s, simulation_cursor_s FROM branches WHERE id = ?', [session.branchId])[0];
    const before = { ...readBranch() };
    const storageBefore = session.repo.storageRevision;
    const envelopeStorageBefore = envelopeOf(host.chatMetadata).storage_revision;

    const maintenance = await session.repo.prepareMaintenance({
      anchor: {
        chatUid: 'chat-maint',
        branchId: session.branchId,
        parentTurnId: session.repo.internal.currentHeadTurnId(),
        hostMessageUid: 'maint-1',
        variantKey: 'maintenance',
        baseRevision: session.repo.internal.currentRevision(),
        baseStorageRevision: storageBefore,
        inputHash: 'maint-1',
      },
    });
    const persisted = await persistSqlSession(session, { commit: maintenance });
    assert.equal(persisted.saved, true, '维护保存同样要宿主确认');
    assert.deepEqual({ ...readBranch() }, before, '维护不得改 revision/head/clock');
    assert.equal(session.repo.storageRevision, storageBefore + 1, '每次导出递增 storageRevision');
    assert.equal(envelopeOf(host.chatMetadata).storage_revision, envelopeStorageBefore + 1, '维护保存要写回新的 storage_revision');
  } finally {
    await closeSqlSession(session);
  }
});

/* ================================================================== *
 * 迁移（T12 隔离 + §7.2 / E11–E14）
 * ================================================================== */

function legacyDoc() {
  return {
    chatMetadata: {
      atlas: {
        worldId: 'world-legacy',
        period: '第4期',
        tables: {
          schemaVersion: 1,
          worldId: 'world-legacy',
          branches: {
            main: {
              locations: [
                {
                  id: 'loc:1',
                  name: '旧城',
                  kind: 'city',
                  description: '城墙与市场',
                  mapId: 'world',
                  gridX: 3,
                  gridY: 4,
                  coordinateStatus: 'confirmed',
                  rumors: ['城主病重', '河道将开'],
                  period: 4,
                },
                { id: 'loc:2', name: '旧学校', kind: 'building', parentLocationId: 'loc:1', mapId: 'loc:1', gridX: 1, gridY: 2, rumors: [] },
                { id: 'loc:3', name: '旧教室', kind: 'room', parentLocationId: 'loc:2', mapId: 'loc:2', gridX: 5, gridY: 6, rumors: [] },
              ],
              characters: [
                { id: 'npc:1', name: '艾琳', identity: '学校教师', locationId: 'loc:2', thought: '先观察' },
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
        simulation: {
          schemaVersion: 1,
          worldId: 'world-legacy',
          branches: {
            main: { tasks: [], signals: [], deliveries: [], geoTopology: { edges: [], areas: [], vehicles: [] } },
          },
        },
      },
    },
  };
}

test('T12-07 旧档迁移：数量/ID 不变、knowledge=0、备份只返回、二次迁移不重复', async () => {
  const host = makeHost();
  const model = scriptedModel([]);
  const options = {
    chatUid: 'chat-migrate',
    chatMetadata: host.chatMetadata,
    saveSession: host.saveSession,
    modelPort: model,
    now,
  };
  const legacy = legacyDoc();
  const first = await migrateSessionToSql({ ...options, legacy });
  try {
    assert.equal(first.inspection.kind, 'legacy');
    assert.equal(first.inspection.counts.locations, 3);
    assert.equal(first.inspection.counts.characters, 4);
    assert.equal(first.inspection.counts.items, 2);
    assert.equal(first.inspection.counts.rumors, 2);
    assert.equal(first.session.source, 'migrated');
    assert.equal(first.saved, true, '迁移结果要经宿主确认保存');

    const counts = first.counts;
    assert.equal(counts.locations, 3);
    assert.equal(counts.characters, 4);
    assert.equal(counts.items, 2);
    assert.ok(counts.information >= 2, `旧 rumors 应转成 information：${counts.information}`);
    assert.ok(counts.rumor_fronts >= 2, `旧 rumors 应转成当地 fronts：${counts.rumor_fronts}`);
    assert.equal(counts.knowledge, 0, '旧 rumors 不得让所有人瞬间知情');

    // 稳定 ID 逐条保留
    for (const id of ['loc:1', 'loc:2', 'loc:3']) {
      assert.equal(queryBound(first.session.repo.db, 'SELECT COUNT(*) AS n FROM locations WHERE id = ?', [id])[0].n, 1, `地点 ${id} 保留原 ID`);
    }
    for (const id of ['npc:1', 'npc:2', 'npc:3', 'npc:4']) {
      assert.equal(queryBound(first.session.repo.db, 'SELECT COUNT(*) AS n FROM characters WHERE id = ?', [id])[0].n, 1, `人物 ${id} 保留原 ID`);
    }
    for (const id of ['item:1', 'item:2']) {
      assert.equal(queryBound(first.session.repo.db, 'SELECT COUNT(*) AS n FROM items WHERE id = ?', [id])[0].n, 1, `物品 ${id} 保留原 ID`);
    }

    // 备份只作为负载返回：不写进任何 turn，也不改旧档
    assert.equal(first.backup.kind, 'legacy_backup');
    assert.ok(first.backup.payload);
    const turnRows = queryBound(first.session.repo.db, 'SELECT attempts_json, decisions_json, receipt_json FROM turns', []);
    assert.equal(JSON.stringify(turnRows).includes('legacy_backup'), false, '备份不得写进每一楼');

    // 迁移后信封已落盘
    assert.equal(envelopeOf(host.chatMetadata).chat_uid, 'chat-migrate');

    // 第二次迁移：不重复导入、不重建世界
    const totalBefore = queryBound(first.session.repo.db, 'SELECT COUNT(*) AS n FROM locations', [])[0].n;
    const second = await migrateSessionToSql({ ...options, legacy });
    await closeSqlSession(second.session);
    assert.equal(second.mapped['kind:locations'] ?? 0, 0, '第二次不重复映射实体');
    assert.ok(second.issues.some((issue) => issue.code === 'MIGRATION_ALREADY_APPLIED'));
    assert.equal(second.counts.locations, totalBefore, '实体行数不因二次迁移变化');
    assert.equal(second.counts.knowledge, 0);
  } finally {
    await closeSqlSession(first.session);
  }
});

test('T12-09 世界书同步失败：核心仍保存，回执只说「世界已更新，世界书待同步」', async () => {
  const host = makeHost();
  const lorebook = {
    async listKeys() {
      return [];
    },
    async read() {
      return null;
    },
    async write() {
      throw new Error('世界书写入失败（模拟）');
    },
    async remove() {},
  };
  const session = await openSqlSession({
    chatUid: 'chat-sync',
    chatMetadata: host.chatMetadata,
    saveSession: host.saveSession,
    modelPort: scriptedModel([locationOp('圣光学校', 'new:school')]),
    lorebookPort: lorebook,
    buildProjection: (scope, revision) => [
      { key: `atlas:chat-sync:main:${scope}`, chatUid: 'chat-sync', branchId: 'main', scope, revision, content: '投影内容' },
    ],
    now,
  });
  try {
    const result = await runSqlTurn(session, turnInput(session));
    assert.equal(result.saved, true);
    assert.equal(result.coreSaved, true, '世界书失败不改变核心已保存的事实');
    const syncIssues = result.issues.filter((issue) => issue.code === 'WORLD_SYNC_FAILED');
    assert.equal(syncIssues.length, 1, `只应有一条 WORLD_SYNC_FAILED：${JSON.stringify(result.issues.map((i) => i.code))}`);
    assert.match(syncIssues[0].message, /世界已更新，世界书待同步/);
    assert.equal(
      result.issues.some((issue) => issue.code === 'COMMIT_FAILED' || issue.code === 'SESSION_WRITE_FAILED'),
      false,
      '两种错误不能混成一个 COMMIT_FAILED',
    );
    assert.equal(envelopeOf(host.chatMetadata).chat_uid, 'chat-sync');
    assert.deepEqual(locationNames(session), ['圣光学校'], '核心回合没有被同步失败回滚');
  } finally {
    await closeSqlSession(session);
  }
});

test('T12-08 损坏旧档：拒绝迁移（不当成「没有数据」），也不建空世界', async () => {
  const host = makeHost();
  const result = await migrateSessionToSql({
    chatUid: 'chat-broken',
    chatMetadata: host.chatMetadata,
    saveSession: host.saveSession,
    modelPort: scriptedModel([]),
    now,
    legacy: '{"chatMetadata": {"atlas": {',
  });
  assert.equal(result.inspection.kind, 'corrupt');
  assert.equal(result.session, null);
  assert.equal(result.saved, false);
  assert.ok(result.issues.some((issue) => issue.code === 'LEGACY_CORRUPT' && issue.severity === 'error'));
  assert.equal(envelopeOf(host.chatMetadata), null, '损坏档不得建空世界');
});
