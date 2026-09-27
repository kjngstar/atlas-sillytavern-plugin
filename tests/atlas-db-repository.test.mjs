/**
 * atlas-db-repository.test.mjs — M1 最小链路验收（§18.5 M1 / T10 / T11）。
 *
 * 覆盖：
 * - 空候选库建库：20 表 + migration/seed turn + branch，**没有「起点」地点**
 * - 模型响应 → 解析 → 编译 → 分组 → 事务 → 导出 PreparedCommit
 * - 未被宿主确认前正式库不变（queryView 看不到候选改动）
 * - confirmSaved 只在 token+hash 一致且 saved 时发布
 * - 保存失败/身份变化时正式库哈希不变
 * - repository 与视图读到同一份权威
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, selectOne, countRows, foreignKeyCheck, userTables } from './fixtures/atlas-sql/seed.mjs';
import { SOURCE_SNAPSHOT, caseById } from './fixtures/atlas-sql/model-cases.mjs';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { createWorkerClient, handleWorkerMessage } from '../src/atlas-db-worker.ts';
import { createHostSaveAdapter, saveCandidate, reconcileUnknownSave } from '../src/atlas-host-save.ts';
import { withChatCommitLock } from '../src/atlas-db-queue.ts';
import { decodeSnapshot, encodeSnapshot, sha256Hex } from '../src/atlas-db-envelope.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';

const SQL = await (await import('sql.js')).default();

function anchorFor(chatUid, baseRevision, overrides = {}) {
  return {
    chatUid,
    branchId: IDS.branchMain,
    parentTurnId: IDS.seedTurn,
    hostMessageUid: 'msg_1',
    variantKey: 'v1',
    baseRevision,
    baseStorageRevision: 0,
    inputHash: 'input_hash_1',
    ...overrides,
  };
}

/** 固定输出模型端口：按调用顺序返回预置文本。 */
function scriptedModel(responses) {
  const calls = [];
  return {
    calls,
    async request(req) {
      calls.push(req);
      const text = responses.length > 0 ? responses.shift() : '{"op":"noop"}';
      return {
        batchId: req.batchId,
        text,
        finishReason: 'stop',
        httpStatus: 200,
        durationMs: 5,
      };
    },
  };
}

async function makeRepo({ responses = [], chatUid = IDS.chatA } = {}) {
  const model = scriptedModel(responses);
  const repo = createSqlRepository({ chatUid, branchId: IDS.branchMain, branchName: '主线', modelPort: model, now: () => 1_700_000_000_000, makeId: (kind, opId, alias) => `${kind.slice(0, 3)}_${Buffer.from(`${opId}:${alias}`).toString('hex').slice(0, 20)}` });
  const seed = await makeSeedWith(SQL);
  const bytes = seed.exportBytes();
  seed.close();
  await repo.open({ bytes });
  return { repo, model };
}

test('T10-01 打开存档：20 表、seed turn、branch、没有「起点」地点', async () => {
  const { repo } = await makeRepo();
  try {
    const db = repo.db;
    assert.equal(userTables(db).length, 20);
    assert.deepEqual(foreignKeyCheck(db), []);
    const branch = queryBound(db, 'SELECT id, head_turn_id, revision FROM branches WHERE id = ?', [IDS.branchMain]);
    assert.equal(branch.length, 1);
    assert.equal(branch[0].head_turn_id, IDS.seedTurn);
    assert.equal(Number(branch[0].revision), 0);
    const start = queryBound(db, "SELECT id FROM locations WHERE name IN ('起点','开始')");
    assert.equal(start.length, 0, '不得建立「起点」地点');
    const maps = queryBound(db, 'SELECT COUNT(*) AS n FROM maps');
    assert.ok(Number(maps[0].n) >= 1);
  } finally {
    await repo.close();
  }
});

test('T10-02 空库建世：只有 branch/seed turn，没有实体，也没有起点', async () => {
  const model = scriptedModel([]);
  const repo = createSqlRepository({ chatUid: 'chat-empty', branchId: IDS.branchMain, branchName: '主线', modelPort: model });
  try {
    await repo.open({});
    assert.equal(userTables(repo.db).length, 20);
    assert.equal(queryBound(repo.db, 'SELECT COUNT(*) AS n FROM branches')[0].n, 1);
    assert.equal(countRows(repo.db, 'locations', IDS.branchMain), 0);
    assert.equal(countRows(repo.db, 'characters', IDS.branchMain), 0);
    assert.equal(countRows(repo.db, 'maps', IDS.branchMain), 0, '不强制新建根图');
    const turns = queryBound(repo.db, 'SELECT kind, status FROM turns WHERE branch_id = ?', [IDS.branchMain]);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].kind, 'migration');
    assert.equal(turns[0].status, 'committed');
  } finally {
    await repo.close();
  }
});

test('T10-03 M1 最小贯通：观察正文 → 建人物+地点 → PreparedCommit（宿主未确认前正式库不变）', async () => {
  const { repo, model } = await makeRepo({
    responses: [
      '{"op":"character.upsert","ref":"new:elin","data":{"name":"艾琳","identity":"学校教师","location_ref":"new:school"}}\n{"op":"location.upsert","ref":"new:school","data":{"name":"圣光学校","kind":"building"}}',
    ],
  });
  const beforeBytes = await repo.exportCurrent();
  try {
    const anchor = anchorFor(IDS.chatA, 0);
    const prepared = await repo.prepareTurn({
      anchor,
      userText: '他走进学校。',
      assistantText: '教师艾琳在圣光学校等候。',
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    assert.equal(model.calls.length, 1);
    assert.equal(model.calls[0].phase, 'observe');
    assert.ok(prepared.snapshot instanceof Uint8Array);
    assert.ok(prepared.snapshot.length > 0);
    assert.match(prepared.snapshotSha256, /^[0-9a-f]{64}$/);
    assert.equal(prepared.receipt.status, 'committed');
    assert.equal(prepared.receipt.worldChanged, true);
    assert.ok(prepared.receipt.groups.some((g) => g.status === 'applied'));

    // 候选里的确写入了一个新地点与一个新人物（种子里已有同名「圣光学校」，不能靠名字判定）
    const candidate = repo.getCandidate(prepared.token);
    assert.ok(candidate, '候选应存在');
    const locs = queryBound(candidate.db, "SELECT id, name FROM locations WHERE name = '圣光学校' AND id <> ?", [IDS.L2]);
    assert.equal(locs.length, 1, '本轮应恰好新建一个「圣光学校」');
    const chars = queryBound(candidate.db, "SELECT id, name, location_id, grid_x, map_id FROM characters WHERE name = '艾琳' AND id <> 'C1'");
    assert.equal(chars.length, 1, '应恰好新建一个人物（种子里已有同名 C1 不计）');
    assert.equal(chars[0].location_id, locs[0].id, 'location_ref 必须指向同一批新建的地点 ID');
    assert.equal(chars[0].grid_x, null, '粗定位不得伪造精坐标');
    assert.equal(chars[0].map_id, null);

    // 正式库在确认前完全没变
    const afterBytes = await repo.exportCurrent();
    assert.equal(await sha256Hex(afterBytes), await sha256Hex(beforeBytes), '未确认保存前正式库不得变化');
    const view = await repo.queryView({ kind: 'map', branchId: IDS.branchMain });
    const newLocId = locs[0].id;
    const viewPointIds = view.items.flatMap((m) => [...m.points, ...m.coarseList].map((p) => p.entityId));
    assert.equal(viewPointIds.includes(newLocId), false, '正式视图不应看到候选改动');

    // 宿主确认后发布
    await repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'saved' });
    const published = queryBound(repo.db, 'SELECT name FROM locations WHERE name = ? AND id <> ?', ['圣光学校', IDS.L2]);
    assert.equal(published.length, 1);
    const branch = queryBound(repo.db, 'SELECT revision, head_turn_id FROM branches WHERE id = ?', [IDS.branchMain]);
    assert.equal(Number(branch[0].revision), 1);
    assert.notEqual(branch[0].head_turn_id, IDS.seedTurn);
  } finally {
    await repo.close();
  }
});

test('T10-04 P01 只有心理没有引文：不要求 quote，thought 变化，位置不变', async () => {
  const { repo } = await makeRepo({ responses: [caseById('P01').response] });
  try {
    const prepared = await repo.prepareTurn({
      anchor: anchorFor(IDS.chatA, 0),
      userText: '',
      assistantText: caseById('P01').sourceText,
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    assert.equal(prepared.receipt.status, 'committed');
    const codes = prepared.receipt.issues.map((i) => i.code);
    assert.equal(codes.includes('QUOTE_REQUIRED'), false);
    assert.equal(codes.includes('QUOTE_NOT_FOUND'), false);
    const candidate = repo.getCandidate(prepared.token);
    const row = queryBound(candidate.db, 'SELECT thought, location_id FROM characters WHERE id = ?', [IDS.C1]);
    assert.equal(row[0].thought, '他似乎在隐瞒什么。');
    assert.equal(row[0].location_id, IDS.L2, '位置不得被心理修改带偏');
  } finally {
    await repo.close();
  }
});

test('T10-05 P03 截断行：第一行提交，回执 partial，第二行报 JSON_SYNTAX', async () => {
  const { repo } = await makeRepo({ responses: [caseById('P03').response] });
  try {
    const prepared = await repo.prepareTurn({
      anchor: anchorFor(IDS.chatA, 0),
      userText: '',
      assistantText: caseById('P03').sourceText,
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    assert.equal(prepared.receipt.status, 'partial');
    assert.ok(prepared.receipt.issues.some((i) => i.code === 'JSON_SYNTAX' && i.line === 2));
    const candidate = repo.getCandidate(prepared.token);
    const row = queryBound(candidate.db, 'SELECT thought FROM characters WHERE id = ?', [IDS.C1]);
    assert.equal(row[0].thought, '先观察。');
    const broken = queryBound(candidate.db, "SELECT id FROM locations WHERE name = 'broken'");
    assert.equal(broken.length, 0, '不得补一个未知地点');
  } finally {
    await repo.close();
  }
});

test('T10-06 P06 noop：回执 noop、世界不变、没有 EMPTY_RESPONSE', async () => {
  const { repo } = await makeRepo({ responses: [caseById('P06').response] });
  try {
    const prepared = await repo.prepareTurn({
      anchor: anchorFor(IDS.chatA, 0),
      userText: '',
      assistantText: caseById('P06').sourceText,
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    assert.equal(prepared.receipt.status, 'noop');
    assert.equal(prepared.receipt.worldChanged, false);
    assert.equal(prepared.receipt.issues.some((i) => i.code === 'EMPTY_RESPONSE'), false);
    const branch = queryBound(repo.db, 'SELECT revision FROM branches WHERE id = ?', [IDS.branchMain]);
    assert.equal(Number(branch[0].revision), 0, 'noop 不推进 revision');
  } finally {
    await repo.close();
  }
});

test('T10-07 空回复：记 EMPTY_RESPONSE 且不发布候选（不是伪装成功）', async () => {
  const { repo } = await makeRepo({ responses: [''] });
  try {
    await assert.rejects(
      () =>
        repo.prepareTurn({
          anchor: anchorFor(IDS.chatA, 0),
          userText: '',
          assistantText: '无事发生。',
          sourceSnapshot: SOURCE_SNAPSHOT,
          phaseBatches: ['observe'],
          manual: false,
        }),
      (err) => {
        assert.equal(err.code, 'TURN_FAILED');
        const codes = err.detail.receipt.issues.map((i) => i.code);
        assert.ok(codes.includes('EMPTY_RESPONSE'), `实际 issues: ${codes.join(',')}`);
        return true;
      },
    );
    const branch = queryBound(repo.db, 'SELECT revision FROM branches WHERE id = ?', [IDS.branchMain]);
    assert.equal(Number(branch[0].revision), 0);
  } finally {
    await repo.close();
  }
});

test('T10-08 STALE_BASE：基版本不符时拒绝，不借用重放跨越业务变更', async () => {
  const { repo } = await makeRepo({ responses: ['{"op":"noop"}'] });
  try {
    await assert.rejects(
      () =>
        repo.prepareTurn({
          anchor: anchorFor(IDS.chatA, 99),
          userText: '',
          assistantText: '',
          sourceSnapshot: SOURCE_SNAPSHOT,
          phaseBatches: ['observe'],
          manual: false,
        }),
      (err) => err.code === 'STALE_BASE',
    );
  } finally {
    await repo.close();
  }
});

test('T10-09 错 token / 错 hash / 明确失败：都不能发布候选，正式库保持一致', async () => {
  const { repo } = await makeRepo({
    responses: ['{"op":"character.upsert","ref":"C1","data":{"thought":"换了想法"}}'],
  });
  try {
    const beforeHash = await sha256Hex(await repo.exportCurrent());
    const prepared = await repo.prepareTurn({
      anchor: anchorFor(IDS.chatA, 0),
      userText: '',
      assistantText: '她改变了主意。',
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    await assert.rejects(
      () => repo.confirmSaved({ token: 'cand_not_exist', snapshotSha256: prepared.snapshotSha256, result: 'saved' }),
      (err) => err.code === 'CANDIDATE_UNKNOWN',
    );
    await assert.rejects(
      () => repo.confirmSaved({ token: prepared.token, snapshotSha256: 'deadbeef', result: 'saved' }),
      (err) => err.code === 'CANDIDATE_HASH_MISMATCH',
    );
    assert.equal(await sha256Hex(await repo.exportCurrent()), beforeHash);
    // requested：保留候选、不发布
    await repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'requested' });
    assert.equal(await sha256Hex(await repo.exportCurrent()), beforeHash);
    assert.ok(repo.getCandidate(prepared.token), 'requested 时保留候选待确认');
    // failed：丢弃候选，正式库仍不变
    await repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'failed' });
    assert.equal(repo.getCandidate(prepared.token), null);
    assert.equal(await sha256Hex(await repo.exportCurrent()), beforeHash);
  } finally {
    await repo.close();
  }
});

test('T10-10 CHAT_CHANGED：另一个聊天的锚点不能写入本聊天', async () => {
  const { repo } = await makeRepo({ responses: ['{"op":"noop"}'], chatUid: IDS.chatA });
  try {
    await assert.rejects(
      () =>
        repo.prepareTurn({
          anchor: anchorFor(IDS.chatB, 0),
          userText: '',
          assistantText: '',
          sourceSnapshot: SOURCE_SNAPSHOT,
          phaseBatches: ['observe'],
          manual: false,
        }),
      (err) => err.code === 'CHAT_CHANGED',
    );
  } finally {
    await repo.close();
  }
});

test('T10-11 手动编辑走同一写入层；候选里落库且记 kind=manual', async () => {
  const { repo } = await makeRepo({ responses: [] });
  try {
    const prepared = await repo.prepareTurn({
      anchor: anchorFor(IDS.chatA, 0, { hostMessageUid: 'manual_1', variantKey: 'manual' }),
      userText: '手动改',
      assistantText: '',
      sourceSnapshot: [],
      phaseBatches: [],
      manual: true,
      operations: [{ op: 'character.upsert', ref: 'C1', data: { thought: '手动编辑的想法' } }],
    });
    assert.equal(prepared.receipt.status, 'committed');
    const candidate = repo.getCandidate(prepared.token);
    const row = queryBound(candidate.db, 'SELECT thought FROM characters WHERE id = ?', [IDS.C1]);
    assert.equal(row[0].thought, '手动编辑的想法');
    const turn = queryBound(candidate.db, 'SELECT kind FROM turns WHERE id = ?', [prepared.receipt.turnId]);
    assert.equal(turn[0].kind, 'manual');
  } finally {
    await repo.close();
  }
});

test('T10-12 回退：沿因果后继恢复 before，clock 与 revision 一致', async () => {
  const { repo } = await makeRepo({
    responses: ['{"op":"character.upsert","ref":"C1","data":{"thought":"第一楼的想法"}}'],
  });
  try {
    const prepared = await repo.prepareTurn({
      anchor: anchorFor(IDS.chatA, 0),
      userText: '',
      assistantText: '她想了想。',
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    await repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'saved' });
    assert.equal(queryBound(repo.db, 'SELECT thought FROM characters WHERE id = ?', [IDS.C1])[0].thought, '第一楼的想法');

    const rollback = await repo.prepareRollback({ chatUid: IDS.chatA, branchId: IDS.branchMain, targetParentTurnId: IDS.seedTurn, expectedRevision: 1 });
    await repo.confirmSaved({ token: rollback.token, snapshotSha256: rollback.snapshotSha256, result: 'saved' });
    const row = queryBound(repo.db, 'SELECT thought FROM characters WHERE id = ?', [IDS.C1]);
    assert.equal(row[0].thought, '', '回退后应恢复 before（空想法）');
    const branch = queryBound(repo.db, 'SELECT head_turn_id FROM branches WHERE id = ?', [IDS.branchMain]);
    assert.equal(branch[0].head_turn_id, IDS.seedTurn);
    assert.deepEqual(foreignKeyCheck(repo.db), []);
  } finally {
    await repo.close();
  }
});

test('T10-13 视图与 repository 读同一份权威；空结果返回空数组', async () => {
  const { repo } = await makeRepo({ responses: [] });
  try {
    const map = await repo.queryView({ kind: 'map', branchId: IDS.branchMain });
    assert.equal(map.items.length, 2, '种子里有两张图');
    const main = map.items.find((m) => m.mapId === IDS.M1);
    assert.ok(main.points.some((p) => p.entityId === IDS.L1));
    assert.ok(main.points.some((p) => p.entityId === IDS.C2), '有精坐标的人物应出现');
    // 只知「在学校」的人物进粗定位名单，不叠加人物图标
    assert.ok(main.coarseList.some((c) => c.entityId === IDS.C1 && c.locationId === IDS.L2));
    assert.equal(main.points.some((p) => p.entityId === IDS.C1), false);
    // 未标定/空结果
    const empty = await repo.queryView({ kind: 'nearby', branchId: IDS.branchMain, entityId: 'NOPE' });
    assert.deepEqual(empty.items, []);
    const stale = await repo.queryView({ kind: 'map', branchId: IDS.branchMain, revision: 42 });
    assert.equal(stale.items.length, 0);
    assert.equal(stale.metadata.stale, true);
  } finally {
    await repo.close();
  }
});

test('T10-14 快照信封：编码→解码 byte 一致；损坏存档不清空建世', async () => {
  const { repo } = await makeRepo({ responses: [] });
  try {
    const bytes = await repo.exportCurrent();
    const envelope = await encodeSnapshot(bytes, {
      chatUid: IDS.chatA,
      worldUid: 'world_1',
      storageRevision: 1,
      activeBranchId: IDS.branchMain,
    });
    const decoded = await decodeSnapshot(envelope);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.bytes.length, bytes.length);
    assert.deepEqual([...decoded.bytes], [...bytes]);

    const tampered = { ...envelope, sha256: 'f'.repeat(64) };
    const bad = await decodeSnapshot(tampered);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'ENVELOPE_HASH_MISMATCH');
    const higher = { ...envelope, schema_version: 99 };
    const unsupported = await decodeSnapshot(higher);
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.code, 'DB_SCHEMA_UNSUPPORTED');
    const notAnEnvelope = await decodeSnapshot(null);
    assert.equal(notAnEnvelope.ok, false);
  } finally {
    await repo.close();
  }
});

test('T10-15 prompt 不夹 SQL；只给该阶段允许的操作', async () => {
  const { repo, model } = await makeRepo({ responses: ['{"op":"noop"}'] });
  try {
    await repo.prepareTurn({
      anchor: anchorFor(IDS.chatA, 0),
      userText: '用户行动',
      assistantText: '正文',
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    const text = model.calls[0].messages.map((m) => m.content).join('\n');
    assert.equal(/CREATE\s+TABLE/i.test(text), false);
    assert.equal(/\bINSERT\s+INTO\b/i.test(text), false);
    assert.equal(/PRAGMA/i.test(text), false);
    assert.deepEqual([...model.calls[0].allowedOps].sort(), [
      'character.upsert', 'event.propose', 'faction.upsert', 'information.propose',
      'item.transfer', 'item.upsert', 'location.upsert', 'relation.upsert',
    ].sort());
    assert.ok(text.includes('C1='), '提示词应带程序提供的短引用');
  } finally {
    await repo.close();
  }
});

test('T10-16 Worker RPC：方法白名单、requestId 对应、异常序列化为 Issue', async () => {
  const { repo } = await makeRepo({ responses: [] });
  const sent = [];
  const worker = { postMessage: (m) => sent.push(m) };
  try {
    const ok = await handleWorkerMessage({ type: 'request', requestId: 'r1', method: 'query', payload: { kind: 'map', branchId: IDS.branchMain } }, repo, null);
    assert.equal(ok.type, 'response');
    assert.equal(ok.requestId, 'r1');
    assert.ok(Array.isArray(ok.result.items));

    const denied = await handleWorkerMessage({ type: 'request', requestId: 'r2', method: 'runSql', payload: {} }, repo, null);
    assert.equal(denied.error.code, 'WORKER_METHOD_NOT_ALLOWED');

    const noRepo = await handleWorkerMessage({ type: 'request', requestId: 'r3', method: 'confirmSaved', payload: { token: 'nope' } }, repo, null);
    assert.equal(noRepo.error.code, 'CANDIDATE_UNKNOWN');
    void sent;
  } finally {
    await repo.close();
  }
});

test('T10-17 Worker 客户端：迟到响应不更新 UI，超时与取消有明确错误码', async () => {
  const handlers = [];
  const worker = { postMessage: () => {}, addEventListener: (_t, fn) => handlers.push(fn) };
  const late = [];
  const client = createWorkerClient(worker, { timeoutMs: 20, onLateResponse: (m) => late.push(m) });
  await assert.rejects(() => client.request('query', {}), (err) => err.code === 'WORKER_TIMEOUT');
  // 迟到的响应只能进诊断回调，不能 resolve
  handlers[0]({ data: { type: 'response', requestId: 'rpc_1', result: { items: ['不该出现'] } } });
  assert.equal(late.length, 1);
  const promise = client.request('query', {});
  client.cancelAll();
  await assert.rejects(() => promise, (err) => err.code === 'WORKER_CANCELLED');
  client.close();
});

test('T10-18 宿主保存适配：缺 save 函数 → HOST_SAVE_UNAVAILABLE，绝不返回 true', async () => {
  const prepared = {
    kind: 'turn',
    token: 't1',
    anchor: anchorFor(IDS.chatA, 0),
    snapshot: new Uint8Array([1, 2, 3]),
    snapshotSha256: 'a'.repeat(64),
    receipt: { status: 'committed' },
    expiresWallMs: Date.now() + 1000,
  };
  const envelope = await encodeSnapshot(new Uint8Array([1, 2, 3]), {
    chatUid: IDS.chatA,
    worldUid: 'w',
    storageRevision: 1,
    activeBranchId: IDS.branchMain,
  });
  const hostAnchor = { chatUid: IDS.chatA, hostChatId: null, metadataIdentity: {}, branchId: IDS.branchMain, revision: 0, storageRevision: 0 };

  const noSave = await saveCandidate(
    { capturedHostAnchor: hostAnchor, prepared, envelope },
    { captureAnchor: () => hostAnchor, isCurrent: () => true, save: null },
  );
  assert.equal(noSave.result, 'failed');
  assert.equal(noSave.ack.result, 'failed');
  assert.equal(noSave.ack.error.code, 'HOST_SAVE_UNAVAILABLE');

  const chatChanged = await saveCandidate(
    { capturedHostAnchor: hostAnchor, prepared, envelope },
    { captureAnchor: () => hostAnchor, isCurrent: () => false, save: async () => ({ confirmed: true }) },
  );
  assert.equal(chatChanged.result, 'failed');
  assert.equal(chatChanged.ack.error.code, 'CHAT_CHANGED');

  const queued = await saveCandidate(
    { capturedHostAnchor: hostAnchor, prepared, envelope },
    { captureAnchor: () => hostAnchor, isCurrent: () => true, save: async () => ({ confirmed: false }), canConfirm: true },
  );
  assert.equal(queued.result, 'requested');

  const saved = await saveCandidate(
    { capturedHostAnchor: hostAnchor, prepared, envelope },
    { captureAnchor: () => hostAnchor, isCurrent: () => true, save: async () => ({ confirmed: true, durableSha256: 'a'.repeat(64) }) },
  );
  assert.equal(saved.result, 'saved');

  const mismatch = await saveCandidate(
    { capturedHostAnchor: hostAnchor, prepared, envelope },
    { captureAnchor: () => hostAnchor, isCurrent: () => true, save: async () => ({ confirmed: true, durableSha256: 'b'.repeat(64) }) },
  );
  assert.equal(mismatch.result, 'failed');
  assert.equal(mismatch.ack.error.code, 'HOST_SAVE_HASH_MISMATCH');

  const adapter = createHostSaveAdapter({ captureAnchor: () => hostAnchor, isCurrent: () => true, save: null });
  assert.equal(adapter.captureAnchor().chatUid, IDS.chatA);
});

test('T10-19 确认丢失按耐久哈希核对，不假定未保存而重复推进', () => {
  assert.equal(reconcileUnknownSave({ token: 't', snapshotSha256: 'a', result: 'requested' }, 'a').verdict, 'saved');
  assert.equal(reconcileUnknownSave({ token: 't', snapshotSha256: 'a', result: 'requested' }, 'b').verdict, 'not_saved');
  const unknown = reconcileUnknownSave({ token: 't', snapshotSha256: 'a', result: 'requested' }, null);
  assert.equal(unknown.verdict, 'unknown');
  assert.equal(unknown.issue.code, 'HOST_SAVE_UNCONFIRMED');
});

test('T10-20 单写者锁：同 chat 串行执行，第二个进入时第一个已完成', async () => {
  const order = [];
  const first = withChatCommitLock(IDS.chatA, async () => {
    order.push('first-start');
    await new Promise((r) => setTimeout(r, 10));
    order.push('first-end');
  });
  const second = withChatCommitLock(IDS.chatA, async () => {
    order.push('second-start');
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start']);
});

test('T10-21 维护入口：只改 outbox，不推进 clock/head/revision', async () => {
  const { repo } = await makeRepo({ responses: ['{"op":"character.upsert","ref":"C1","data":{"thought":"变化"}}'] });
  try {
    const prepared = await repo.prepareTurn({
      anchor: anchorFor(IDS.chatA, 0),
      userText: '',
      assistantText: '发生了什么。',
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    await repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'saved' });
    const branchBefore = queryBound(repo.db, 'SELECT revision, head_turn_id, clock_s FROM branches WHERE id = ?', [IDS.branchMain])[0];
    const tasks = queryBound(repo.db, "SELECT id, status, target_revision, attempt_count FROM sync_outbox WHERE status = 'pending'");
    assert.equal(tasks.length, 1, '成功提交应登记一条同步意图');

    const maintenance = await repo.prepareMaintenance({
      anchor: anchorFor(IDS.chatA, Number(branchBefore.revision), { hostMessageUid: 'maint_1', variantKey: 'maint' }),
      outboxResults: [
        {
          taskId: String(tasks[0].id),
          expectedStatus: 'pending',
          nextStatus: 'failed',
          attemptCount: 1,
          nextRetryWallMs: 1_700_000_600_000,
          lastErrorCode: 'WORLD_SYNC_FAILED',
          lastErrorMessage: '世界书不可用',
        },
      ],
    });
    assert.equal(maintenance.receipt, null);
    await repo.confirmSaved({ token: maintenance.token, snapshotSha256: maintenance.snapshotSha256, result: 'saved' });
    const after = queryBound(repo.db, 'SELECT revision, head_turn_id, clock_s FROM branches WHERE id = ?', [IDS.branchMain])[0];
    assert.deepEqual(after, branchBefore, '维护不得改变分支业务 revision/head/clock');
    const task = queryBound(repo.db, 'SELECT status, last_error_code FROM sync_outbox WHERE id = ?', [tasks[0].id])[0];
    assert.equal(task.status, 'failed');
    assert.equal(task.last_error_code, 'WORLD_SYNC_FAILED');
    const outboxCount = queryBound(repo.db, 'SELECT COUNT(*) AS n FROM sync_outbox');
    assert.equal(Number(outboxCount[0].n), 1, '维护不得产生新的同步任务');
  } finally {
    await repo.close();
  }
});

test('T10-22 重复提交同一基版本：第二次因 STALE_BASE 拒绝（只有一个有效提交）', async () => {
  const { repo } = await makeRepo({ responses: ['{"op":"character.upsert","ref":"C1","data":{"thought":"甲"}}'] });
  try {
    const first = await repo.prepareTurn({
      anchor: anchorFor(IDS.chatA, 0, { hostMessageUid: 'm1' }),
      userText: '',
      assistantText: '第一次。',
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    await repo.confirmSaved({ token: first.token, snapshotSha256: first.snapshotSha256, result: 'saved' });
    await assert.rejects(
      () =>
        repo.prepareTurn({
          anchor: anchorFor(IDS.chatA, 0, { hostMessageUid: 'm2' }),
          userText: '',
          assistantText: '第二次。',
          sourceSnapshot: SOURCE_SNAPSHOT,
          phaseBatches: ['observe'],
          manual: false,
        }),
      (err) => err.code === 'STALE_BASE',
    );
  } finally {
    await repo.close();
  }
});

test('T10-23 两个聊天隔离：chat-B 的库不含 chat-A 的改动', async () => {
  const { repo } = await makeRepo({ responses: ['{"op":"location.upsert","ref":"new:x","data":{"name":"A 独占地点","kind":"building"}}'] });
  let repoB = null;
  try {
    const prepared = await repo.prepareTurn({
      anchor: anchorFor(IDS.chatA, 0),
      userText: '',
      assistantText: '建了一个地点。',
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    await repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'saved' });

    const modelB = scriptedModel([]);
    repoB = createSqlRepository({ chatUid: IDS.chatB, branchId: IDS.branchMain, branchName: '主线', modelPort: modelB });
    const seedB = await makeSeedWith(SQL);
    const bytesB = seedB.exportBytes();
    seedB.close();
    await repoB.open({ bytes: bytesB });
    const found = queryBound(repoB.db, "SELECT id FROM locations WHERE name = 'A 独占地点'");
    assert.equal(found.length, 0, '另一聊天不得读到本聊天的实体');
  } finally {
    if (repoB) await repoB.close();
    await repo.close();
  }
});

test('T10-24 分支隔离：main-B 的行不受 main-A 提交影响', async () => {
  const { repo } = await makeRepo({ responses: ['{"op":"character.upsert","ref":"C1","data":{"thought":"主线变更"}}'] });
  try {
    const prepared = await repo.prepareTurn({
      anchor: anchorFor(IDS.chatA, 0),
      userText: '',
      assistantText: '主线。',
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    await repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'saved' });
    const rowB = queryBound(repo.db, 'SELECT thought FROM characters WHERE branch_id = ? AND id = ?', [IDS.branchB, IDS.C1]);
    assert.equal(rowB[0].thought, '', '另一分支的同一人物不得被改动');
  } finally {
    await repo.close();
  }
});

test('T10-25 关闭后再用：明确报 DB_NOT_OPEN，不静默成功', async () => {
  const { repo } = await makeRepo({ responses: [] });
  await repo.close();
  await assert.rejects(() => repo.exportCurrent(), (err) => err.code === 'DB_NOT_OPEN');
});

test('T10-26 反复打开关闭不累积候选（句柄清理）', async () => {
  for (let i = 0; i < 20; i += 1) {
    const { repo } = await makeRepo({ responses: [] });
    const candidate = await repo.createCandidate(anchorFor(IDS.chatA, 0));
    await repo.discardPrepared(candidate.token);
    await repo.close();
  }
  assert.ok(true, '20 次打开/建候选/丢弃/关闭未抛错');
});

test('T10-27 回执里每个失败组都能定位 group/op，且不伪装成全成功', async () => {
  const { repo } = await makeRepo({
    responses: [
      '{"op":"character.upsert","ref":"C1","data":{"location_ref":"new:missing"}}\n{"op":"character.upsert","ref":"C2","data":{"thought":"按原路继续。"}}',
    ],
  });
  try {
    const prepared = await repo.prepareTurn({
      anchor: anchorFor(IDS.chatA, 0),
      userText: '',
      assistantText: '分成两件事。',
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    assert.equal(prepared.receipt.status, 'partial');
    const applied = prepared.receipt.groups.filter((g) => g.status === 'applied');
    const failed = prepared.receipt.groups.filter((g) => g.status !== 'applied');
    assert.ok(applied.length >= 1, '无关有效组必须保留');
    assert.ok(failed.length >= 1, '失败组必须保留并单独报告');
    assert.ok(prepared.receipt.issues.some((i) => i.code === 'REF_UNKNOWN'), `实际 issues: ${prepared.receipt.issues.map((i) => i.code).join(',')}`);
    const candidate = repo.getCandidate(prepared.token);
    const c2 = queryBound(candidate.db, 'SELECT thought FROM characters WHERE id = ?', [IDS.C2]);
    assert.equal(c2[0].thought, '按原路继续。');
    const c1 = queryBound(candidate.db, 'SELECT location_id FROM characters WHERE id = ?', [IDS.C1]);
    assert.equal(c1[0].location_id, IDS.L2, '失败组不得改动 C1 的位置');
  } finally {
    await repo.close();
  }
});
