/**
 * atlas-db-host-save.test.mjs — T11（§18.3）：宿主保存适配与候选发布边界。
 *
 * §18.3 要求的断言：
 * - 缺 save 函数失败：`HOST_SAVE_UNAVAILABLE`、`result:'failed'`，绝不 `saved`/`true`（§16.4）；
 * - 明确失败有条件恢复 metadata：`SESSION_WRITE_FAILED`，且只在「同聊天 + 同 metadata 对象」时恢复；
 * - 无完成信号 request：宿主只排队时保留候选、显示「保存待确认」，不伪造 `coreSaved:true`；
 * - 确认丢失按耐久 hash 核对而非重复推进：等 → saved、不等 → not_saved、读不到 → unknown + `HOST_SAVE_UNCONFIRMED`；
 * - 保存中切 B 不污染 B：`CHAT_CHANGED`，B 的 `chatMetadata` 逐字段不变；
 * - late ack / hash 不符拒绝：`HOST_SAVE_HASH_MISMATCH`（适配器）与 `CANDIDATE_HASH_MISMATCH` /
 *   `CANDIDATE_UNKNOWN`（Repository），世界保持未发布。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, countRows } from './fixtures/atlas-sql/seed.mjs';
import { SOURCE_SNAPSHOT } from './fixtures/atlas-sql/model-cases.mjs';
import { createAtlasHostPort, describeHostCapabilities } from '../src/atlas-host-port.ts';
import { createHostSaveAdapter, saveCandidate, reconcileUnknownSave } from '../src/atlas-host-save.ts';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { encodeSnapshot, sha256Hex } from '../src/atlas-db-envelope.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';

const SQL = await (await import('sql.js')).default();

const BRANCH = IDS.branchMain;
const CHAT_A = IDS.chatA;
const CHAT_B = IDS.chatB;

async function makeEnvelope(chatUid = CHAT_A) {
  return encodeSnapshot(new Uint8Array([1, 2, 3, 4]), {
    chatUid,
    worldUid: 'world_1',
    storageRevision: 1,
    activeBranchId: BRANCH,
  });
}

async function makePrepared(sha = 'a'.repeat(64)) {
  const envelope = await makeEnvelope();
  return {
    envelope,
    prepared: {
      kind: 'turn',
      token: 'cand_t11',
      anchor: {
        chatUid: CHAT_A,
        branchId: BRANCH,
        parentTurnId: IDS.seedTurn,
        hostMessageUid: 'msg_t11',
        variantKey: 'v1',
        baseRevision: 0,
        baseStorageRevision: 0,
        inputHash: 'hash_t11',
      },
      snapshot: new Uint8Array([1, 2, 3, 4]),
      snapshotSha256: sha,
      receipt: { status: 'committed' },
      expiresWallMs: 1_700_000_600_000,
    },
  };
}

/** 宿主 stub：可保存的 chatMetadata + 可切聊天；保存函数行为由参数决定。 */
function makeHost({ chatId = CHAT_A, saveMetadata, canConfirm } = {}) {
  const state = {
    ctx: {
      chatId,
      chatMetadata: { atlas: { schemaVersion: 1, session: { rev: 7 } } },
      saveMetadata: saveMetadata === undefined ? async () => true : saveMetadata,
    },
  };
  const port = createAtlasHostPort({
    context: () => state.ctx,
    readBranchState: () => ({ branchId: BRANCH, revision: 0, storageRevision: 0 }),
    canConfirm,
  });
  return { state, port };
}

function anchorFor(chatUid, baseRevision, overrides = {}) {
  return {
    chatUid,
    branchId: BRANCH,
    parentTurnId: IDS.seedTurn,
    hostMessageUid: 'msg_t11',
    variantKey: 'v1',
    baseRevision,
    baseStorageRevision: 0,
    inputHash: 'hash_t11',
    ...overrides,
  };
}

/* ───────────────────────── 缺 save 函数失败 ───────────────────────── */

test('T11-01 缺 save 函数失败：HOST_SAVE_UNAVAILABLE / result failed，任何入口都不返回 saved', async () => {
  const { prepared, envelope } = await makePrepared();
  const hostAnchor = {
    chatUid: CHAT_A,
    hostChatId: CHAT_A,
    metadataIdentity: {},
    branchId: BRANCH,
    revision: 0,
    storageRevision: 0,
  };
  const input = { capturedHostAnchor: hostAnchor, prepared, envelope };

  // 1) 直接调用 saveCandidate：宿主没有可核实的保存函数。
  const outcome = await saveCandidate(input, { captureAnchor: () => hostAnchor, isCurrent: () => true, save: null });
  assert.equal(outcome.result, 'failed');
  assert.notEqual(outcome.result, 'saved');
  assert.equal(outcome.ack.result, 'failed');
  assert.equal(outcome.ack.error.code, 'HOST_SAVE_UNAVAILABLE');
  assert.equal(outcome.ack.error.severity, 'error');
  assert.equal(outcome.ack.error.retryable, false);
  assert.equal(outcome.ack.confirmedWallMs, undefined, '不得伪造确认时间');
  assert.equal(outcome.restoredMetadata, false);

  // 2) 适配器入口同样失败，不把「没有保存函数」当成功。
  const adapter = createHostSaveAdapter({ captureAnchor: () => hostAnchor, isCurrent: () => true, save: null });
  const ack = await adapter.saveCandidate(input);
  assert.equal(ack.result, 'failed');
  assert.notEqual(ack.result, 'saved');
  assert.equal(ack.error.code, 'HOST_SAVE_UNAVAILABLE');
  assert.ok(!('coreSaved' in ack) || ack.coreSaved !== true, '不得出现 coreSaved:true');

  // 3) 宿主端口在 saveMetadata / writeSession 都缺失时也必须明确报不可保存。
  const bare = { ctx: { chatId: CHAT_A, chatMetadata: { atlas: {} } } };
  const port = createAtlasHostPort({ context: () => bare.ctx, readBranchState: () => ({ branchId: BRANCH, revision: 0, storageRevision: 0 }) });
  const caps = port.capabilities();
  assert.equal(caps.hasSaveMetadata, false);
  assert.equal(caps.canConfirm, false);
  const portAck = await port.saveCandidate({ capturedHostAnchor: port.captureAnchor(), prepared, envelope });
  assert.equal(portAck.result, 'failed');
  assert.equal(portAck.error.code, 'HOST_SAVE_UNAVAILABLE');
  assert.equal(describeHostCapabilities({ context: () => bare.ctx }).hasSaveMetadata, false);
});

/* ───────────────────────── 明确失败有条件恢复 metadata ───────────────────────── */

/**
 * 保存前快照 `chatMetadata.atlas`：与 `src/atlas-sql-session.ts::snapshotAtlasForRestore` 同一语义。
 * 宿主端口会把新信封**就地**写进 `atlas.database`，所以恢复用的 previous 不能是那个被改过的对象。
 */
function snapshotAtlas(metadata) {
  const atlas = metadata?.['atlas'];
  if (atlas === null || typeof atlas !== 'object' || Array.isArray(atlas)) return atlas;
  const copy = { ...atlas };
  if (atlas['database'] === undefined) delete copy['database'];
  return copy;
}

test('T11-02 明确失败 → SESSION_WRITE_FAILED；只有同聊天且同 metadata 对象才恢复', async () => {
  const { state, port } = makeHost({
    saveMetadata: async () => {
      throw new Error('磁盘写满');
    },
  });
  const { prepared, envelope } = await makePrepared();
  const anchor = port.captureAnchor();
  const previous = snapshotAtlas(state.ctx.chatMetadata);
  const metadataBefore = structuredClone(state.ctx.chatMetadata);
  const atlasIdentity = state.ctx.chatMetadata.atlas;
  assert.equal(anchor.chatUid, CHAT_A);
  assert.equal(previous.database, undefined, '保存前快照里不应有未持久化的 envelope');

  const save = async () => {
    const ack = await port.saveCandidate({ capturedHostAnchor: anchor, prepared, envelope });
    return ack.result === 'failed'
      ? { confirmed: false, error: `${ack.error.code}: ${ack.error.message}` }
      : { confirmed: ack.result === 'saved' };
  };
  const restore = ({ chatUid, expectedIdentity }) => port.restoreMetadata({ chatUid, expectedIdentity, previous });

  const outcome = await saveCandidate(
    { capturedHostAnchor: anchor, prepared, envelope },
    { captureAnchor: () => port.captureAnchor(), isCurrent: () => true, save, restoreMetadata: restore },
  );
  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.ack.result, 'failed');
  assert.equal(outcome.ack.error.code, 'SESSION_WRITE_FAILED');
  assert.ok(outcome.ack.error.message.includes('磁盘写满'), '必须保留宿主失败原因');
  // 同聊天 + 同 metadata 对象：明确失败后才恢复本次尚未持久化的值。
  assert.equal(outcome.restoredMetadata, true);
  assert.equal(state.ctx.chatMetadata.atlas, atlasIdentity, '恢复数据库字段时保留其它字段所在的对象');
  assert.equal(state.ctx.chatMetadata.atlas.database, undefined, '未落盘的 envelope 不得留在 metadata 里');
  assert.deepEqual(state.ctx.chatMetadata.atlas, snapshotAtlas(metadataBefore));
  assert.equal(state.ctx.chatMetadata.atlas.session.rev, 7, '同聊天其它 metadata 值逐字段不变');
  assert.equal(state.ctx.chatMetadata.atlas.schemaVersion, 1);

  // 宿主保存调用直接抛错也是同一个明确失败。
  const thrown = await saveCandidate(
    { capturedHostAnchor: anchor, prepared, envelope },
    {
      captureAnchor: () => port.captureAnchor(),
      isCurrent: () => true,
      save: async () => {
        throw new Error('宿主写盘异常');
      },
      restoreMetadata: restore,
    },
  );
  assert.equal(thrown.ack.error.code, 'SESSION_WRITE_FAILED');
  assert.equal(state.ctx.chatMetadata.atlas, atlasIdentity);
  assert.equal(state.ctx.chatMetadata.atlas.database, undefined);

  // metadata 对象已被替换：拒绝恢复，且新对象逐字段不变。
  state.ctx.chatMetadata = { atlas: { schemaVersion: 1, other: true } };
  const beforeB = structuredClone(state.ctx.chatMetadata);
  const refused = await saveCandidate(
    { capturedHostAnchor: anchor, prepared, envelope },
    {
      captureAnchor: () => port.captureAnchor(),
      isCurrent: () => true,
      save: async () => ({ confirmed: false, error: '宿主写盘失败' }),
      restoreMetadata: restore,
    },
  );
  assert.equal(refused.result, 'failed');
  assert.equal(refused.ack.error.code, 'SESSION_WRITE_FAILED');
  assert.equal(refused.restoredMetadata, false, '对象已变时必须拒绝恢复');
  assert.deepEqual(state.ctx.chatMetadata, beforeB, '不得覆盖别人的 metadata');
  assert.equal(port.restoreMetadata({ chatUid: CHAT_A, expectedIdentity: anchor.metadataIdentity, previous }), false);

  // 即使对象一致，聊天已经切走也不能恢复。
  const identityNow = state.ctx.chatMetadata;
  assert.equal(port.restoreMetadata({ chatUid: CHAT_B, expectedIdentity: identityNow, previous }), false);
});

/* ───────────────────────── 无完成信号 → requested ───────────────────────── */

test('T11-03 无完成信号：只排队 → requested（保留候选），绝不 coreSaved:true', async () => {
  const { prepared, envelope } = await makePrepared();
  const hostAnchor = {
    chatUid: CHAT_A,
    hostChatId: CHAT_A,
    metadataIdentity: {},
    branchId: BRANCH,
    revision: 0,
    storageRevision: 0,
  };
  const input = { capturedHostAnchor: hostAnchor, prepared, envelope };

  // 宿主返回了对象但没有 confirmed → 只是排队。
  const queued = await saveCandidate(input, {
    captureAnchor: () => hostAnchor,
    isCurrent: () => true,
    save: async () => ({ confirmed: false }),
    canConfirm: true,
  });
  assert.equal(queued.result, 'requested');
  assert.equal(queued.ack.result, 'requested');
  assert.equal(queued.ack.error.code, 'HOST_SAVE_REQUESTED');
  assert.equal(queued.ack.error.severity, 'warning');
  assert.equal(queued.ack.confirmedWallMs, undefined);
  assert.equal(queued.restoredMetadata, false);
  assert.notEqual(queued.ack.result, 'saved');
  assert.ok(!('coreSaved' in queued) || queued.coreSaved !== true);

  // 宿主干脆不返回任何完成信号（void）。
  const silent = await saveCandidate(input, {
    captureAnchor: () => hostAnchor,
    isCurrent: () => true,
    save: async () => undefined,
    canConfirm: true,
  });
  assert.equal(silent.result, 'requested');
  assert.equal(silent.ack.error.code, 'HOST_SAVE_REQUESTED');

  // 宿主不提供确认/读回能力：明确 HOST_SAVE_UNCONFIRMED，仍是 requested。
  const unconfirmed = await saveCandidate(input, {
    captureAnchor: () => hostAnchor,
    isCurrent: () => true,
    save: async () => undefined,
    canConfirm: false,
  });
  assert.equal(unconfirmed.result, 'requested');
  assert.equal(unconfirmed.ack.result, 'requested');
  assert.equal(unconfirmed.ack.error.code, 'HOST_SAVE_UNCONFIRMED');

  // 宿主端口同样把「不提供确认能力」表达成 requested。
  const { port } = makeHost({ canConfirm: false });
  const portAck = await port.saveCandidate({ capturedHostAnchor: port.captureAnchor(), prepared, envelope });
  assert.equal(portAck.result, 'requested');
  assert.equal(portAck.error.code, 'HOST_SAVE_UNCONFIRMED');
  assert.notEqual(portAck.result, 'saved');
});

/* ───────────────────────── 确认丢失按耐久 hash 核对 ───────────────────────── */

function scriptedModel(responses) {
  const calls = [];
  return {
    calls,
    async request(req) {
      calls.push(req);
      const text = responses.length > 0 ? responses.shift() : '{"op":"noop"}';
      return { batchId: req.batchId, text, finishReason: 'stop', httpStatus: 200, durationMs: 5 };
    },
  };
}

async function makeRepo(responses) {
  const model = scriptedModel(responses);
  const repo = createSqlRepository({
    chatUid: CHAT_A,
    branchId: BRANCH,
    branchName: '主线',
    modelPort: model,
    now: () => 1_700_000_000_000,
    makeId: (kind, opId, alias) => `${kind.slice(0, 3)}_${Buffer.from(`${opId}:${alias}`).toString('hex').slice(0, 20)}`,
  });
  const seed = await makeSeedWith(SQL);
  const bytes = seed.exportBytes();
  seed.close();
  await repo.open({ bytes });
  return { repo, model };
}

test('T11-04 确认丢失按耐久 hash 核对：不假定未保存，也不重复推进世界', async () => {
  const { repo, model } = await makeRepo(['{"op":"character.upsert","ref":"C1","data":{"thought":"保存结果未知"}}']);
  try {
    const beforeHash = await sha256Hex(await repo.exportCurrent());
    const turnsBefore = Number(queryBound(repo.db, 'SELECT COUNT(*) AS n FROM turns')[0].n);
    const prepared = await repo.prepareTurn({
      anchor: anchorFor(CHAT_A, 0),
      userText: '',
      assistantText: '她改主意了。',
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    assert.equal(model.calls.length, 1);
    assert.equal(prepared.receipt.status, 'committed');

    // 宿主只排队：确认丢失，ack 保持 requested。
    const ack = { token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'requested' };
    await repo.confirmSaved(ack);
    assert.ok(repo.getCandidate(prepared.token), 'requested 时必须保留候选待核对');
    assert.equal(await sha256Hex(await repo.exportCurrent()), beforeHash, 'requested 不发布世界');

    // 读不到耐久存档 → unknown，不假定「未保存」，也不重新跑模型。
    const unknown = reconcileUnknownSave(ack, null);
    assert.equal(unknown.verdict, 'unknown');
    assert.equal(unknown.issue.code, 'HOST_SAVE_UNCONFIRMED');
    assert.equal(unknown.issue.severity, 'warning');

    // 耐久存档与候选一致 → saved；不一致 → not_saved。
    assert.equal(reconcileUnknownSave(ack, prepared.snapshotSha256).verdict, 'saved');
    assert.equal(reconcileUnknownSave(ack, 'f'.repeat(64)).verdict, 'not_saved');
    assert.equal(reconcileUnknownSave({ ...ack, result: 'saved' }, null).verdict, 'saved');

    // 核对而不是重复推进：模型没被再调一次，也没有多出 turn，正式库哈希仍然一致。
    assert.equal(model.calls.length, 1, '核对不得重新请求模型');
    assert.equal(Number(queryBound(repo.db, 'SELECT COUNT(*) AS n FROM turns')[0].n), turnsBefore);
    assert.equal(await sha256Hex(await repo.exportCurrent()), beforeHash);
    assert.equal(countRows(repo.db, 'characters', BRANCH), 4);

    // 核对结论是 saved 时，发布的是**同一个候选**，不是新一轮推演。
    await repo.confirmSaved({ ...ack, result: 'saved' });
    const published = queryBound(repo.db, 'SELECT thought FROM characters WHERE id = ?', [IDS.C1]);
    assert.equal(published[0].thought, '保存结果未知');
    assert.equal(model.calls.length, 1);
    assert.equal(Number(queryBound(repo.db, 'SELECT COUNT(*) AS n FROM turns')[0].n), turnsBefore + 1);
    assert.notEqual(await sha256Hex(await repo.exportCurrent()), beforeHash);
  } finally {
    await repo.close();
  }
});

/* ───────────────────────── 保存中切 B 不污染 B ───────────────────────── */

test('T11-05 保存中切 B 不污染 B：CHAT_CHANGED，B 的 chatMetadata 逐字段不变', async () => {
  const { state, port } = makeHost({
    saveMetadata: async () => {
      // 保存过程中用户切到 B：新的宿主聊天 + 新的 metadata 对象。
      state.ctx.chatId = CHAT_B;
      state.ctx.chatMetadata = { atlas: { schemaVersion: 1, session: { rev: 11 } } };
    },
  });
  const { prepared, envelope } = await makePrepared();
  const anchor = port.captureAnchor();
  assert.equal(anchor.chatUid, CHAT_A);

  const ack = await port.saveCandidate({ capturedHostAnchor: anchor, prepared, envelope });
  assert.equal(ack.result, 'failed');
  assert.equal(ack.error.code, 'CHAT_CHANGED');
  assert.equal(ack.confirmedWallMs, undefined);
  assert.equal(state.ctx.chatId, CHAT_B);
  assert.deepEqual(state.ctx.chatMetadata, { atlas: { schemaVersion: 1, session: { rev: 11 } } });
  assert.equal(state.ctx.chatMetadata.atlas.database, undefined, 'B 不得拿到 A 的存档');

  // 保存前就已经切走：同样拒绝，且 A/B 的 metadata 都不被写。
  const caseB = makeHost();
  const anchorB = caseB.port.captureAnchor();
  const beforeA = structuredClone(caseB.state.ctx.chatMetadata);
  caseB.state.ctx.chatId = CHAT_B;
  caseB.state.ctx.chatMetadata = { atlas: { schemaVersion: 1 } };
  const beforeB = structuredClone(caseB.state.ctx.chatMetadata);
  const ackBefore = await caseB.port.saveCandidate({ capturedHostAnchor: anchorB, prepared, envelope });
  assert.equal(ackBefore.result, 'failed');
  assert.equal(ackBefore.error.code, 'CHAT_CHANGED');
  assert.deepEqual(caseB.state.ctx.chatMetadata, beforeB);
  assert.equal(beforeB.atlas.database, undefined);
  assert.equal(caseB.port.isCurrent(anchorB), false);
  assert.equal(beforeA.atlas.database, undefined);
});

/* ───────────────────────── late ack / hash 不符拒绝 ───────────────────────── */

test('T11-06 late ack / hash 不符拒绝：HOST_SAVE_HASH_MISMATCH 与 CANDIDATE_HASH_MISMATCH/UNKNOWN 都不发布', async () => {
  const { prepared, envelope } = await makePrepared('a'.repeat(64));
  const hostAnchor = {
    chatUid: CHAT_A,
    hostChatId: CHAT_A,
    metadataIdentity: {},
    branchId: BRANCH,
    revision: 0,
    storageRevision: 0,
  };

  const mismatch = await saveCandidate(
    { capturedHostAnchor: hostAnchor, prepared, envelope },
    {
      captureAnchor: () => hostAnchor,
      isCurrent: () => true,
      save: async () => ({ confirmed: true, durableSha256: 'b'.repeat(64) }),
    },
  );
  assert.equal(mismatch.result, 'failed');
  assert.equal(mismatch.ack.result, 'failed');
  assert.equal(mismatch.ack.error.code, 'HOST_SAVE_HASH_MISMATCH');
  assert.equal(mismatch.ack.error.retryable, false);
  assert.equal(mismatch.restoredMetadata, false);
  assert.ok(mismatch.ack.error.message.includes(prepared.snapshotSha256));
  assert.ok(mismatch.ack.error.message.includes('b'.repeat(64)), '必须同时给出声明值与耐久值');

  // 一致时才 saved。
  const ok = await saveCandidate(
    { capturedHostAnchor: hostAnchor, prepared, envelope },
    {
      captureAnchor: () => hostAnchor,
      isCurrent: () => true,
      save: async () => ({ confirmed: true, durableSha256: prepared.snapshotSha256 }),
      now: () => 1_700_000_000_000,
    },
  );
  assert.equal(ok.result, 'saved');
  assert.equal(ok.ack.result, 'saved');
  assert.equal(ok.ack.confirmedWallMs, 1_700_000_000_000);

  // Repository 层：迟到的 ack（错 hash）与未知 token 都被拒绝，世界保持未发布。
  const { repo } = await makeRepo(['{"op":"character.upsert","ref":"C1","data":{"thought":"迟到 ack"}}']);
  try {
    const beforeHash = await sha256Hex(await repo.exportCurrent());
    const commit = await repo.prepareTurn({
      anchor: anchorFor(CHAT_A, 0),
      userText: '',
      assistantText: '她改了想法。',
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    await assert.rejects(
      () => repo.confirmSaved({ token: commit.token, snapshotSha256: 'deadbeef'.repeat(8), result: 'saved' }),
      (err) => err.code === 'CANDIDATE_HASH_MISMATCH',
    );
    assert.equal(await sha256Hex(await repo.exportCurrent()), beforeHash, 'hash 不符不得发布');
    assert.ok(repo.getCandidate(commit.token), 'hash 不符时候选仍未被消费，可继续核对');

    await assert.rejects(
      () => repo.confirmSaved({ token: 'cand_never_existed', snapshotSha256: commit.snapshotSha256, result: 'saved' }),
      (err) => err.code === 'CANDIDATE_UNKNOWN',
    );
    assert.equal(await sha256Hex(await repo.exportCurrent()), beforeHash);
    assert.equal(queryBound(repo.db, 'SELECT thought FROM characters WHERE id = ?', [IDS.C1])[0].thought, '');
  } finally {
    await repo.close();
  }
});
