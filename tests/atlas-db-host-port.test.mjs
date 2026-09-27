/**
 * atlas-db-host-port.test.mjs — B15/H01 宿主端口接线（T11）。
 *
 * 覆盖：缺 save 函数必须失败（不返回 true）；明确失败时可有条件恢复 metadata；
 * 无完成信号 → requested；保存中切聊天不污染 B；迟到 ack / hash 不符拒绝。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAtlasHostPort, describeHostCapabilities, readEnvelope } from '../src/atlas-host-port.ts';
import { encodeSnapshot } from '../src/atlas-db-envelope.ts';
import { IDS } from './fixtures/atlas-sql/seed.mjs';

function makeHost(overrides = {}) {
  const state = {
    ctx: {
      chatId: overrides.chatId ?? 'chat-A',
      chatMetadata: { atlas: { schemaVersion: 1, world: { id: 'world_1' } } },
      saveMetadata: overrides.saveMetadata ?? (async () => true),
    },
    saves: 0,
  };
  const options = {
    context: () => state.ctx,
    readBranchState: () => ({ branchId: IDS.branchMain, revision: 0, storageRevision: 0 }),
    ...overrides.options,
  };
  const port = createAtlasHostPort(options);
  return { state, port, options };
}

async function makePrepared(sha = 'a'.repeat(64)) {
  const envelope = await encodeSnapshot(new Uint8Array([1, 2, 3, 4]), {
    chatUid: IDS.chatA,
    worldUid: 'world_1',
    storageRevision: 1,
    activeBranchId: IDS.branchMain,
  });
  return {
    envelope,
    prepared: {
      kind: 'turn',
      token: 'cand_1',
      anchor: {
        chatUid: IDS.chatA,
        branchId: IDS.branchMain,
        parentTurnId: IDS.seedTurn,
        hostMessageUid: 'm1',
        variantKey: 'v1',
        baseRevision: 0,
        baseStorageRevision: 0,
        inputHash: 'h',
      },
      snapshot: new Uint8Array([1, 2, 3, 4]),
      snapshotSha256: sha,
      receipt: { status: 'committed' },
      expiresWallMs: Date.now() + 60_000,
    },
  };
}

test('T11-01 能力探测：缺 saveMetadata 时明确报告，不假装可保存', () => {
  const { port } = makeHost({ options: { context: () => ({ chatId: 'c', chatMetadata: {} }) } });
  const caps = port.capabilities();
  assert.equal(caps.hasChatMetadata, true);
  assert.equal(caps.hasSaveMetadata, false);
  assert.equal(caps.canConfirm, false);
});

test('T11-02 缺保存函数 → HOST_SAVE_UNAVAILABLE，绝不返回 saved', async () => {
  const state = { ctx: { chatId: 'chat-A', chatMetadata: { atlas: {} } } };
  const port = createAtlasHostPort({ context: () => state.ctx, readBranchState: () => ({ branchId: 'main-A', revision: 0, storageRevision: 0 }) });
  const { prepared, envelope } = await makePrepared();
  const anchor = port.captureAnchor();
  const ack = await port.saveCandidate({ capturedHostAnchor: anchor, prepared, envelope });
  assert.equal(ack.result, 'failed');
  assert.equal(ack.error.code, 'HOST_SAVE_UNAVAILABLE');
});

test('T11-03 保存成功：envelope 落到 chatMetadata.atlas.database 并返回 saved', async () => {
  const { state, port } = makeHost();
  const { prepared, envelope } = await makePrepared();
  const anchor = port.captureAnchor();
  const ack = await port.saveCandidate({ capturedHostAnchor: anchor, prepared, envelope });
  assert.equal(ack.result, 'saved');
  assert.equal(ack.snapshotSha256, prepared.snapshotSha256);
  const stored = state.ctx.chatMetadata.atlas.database;
  assert.equal(stored.sha256, envelope.sha256);
  assert.equal(readEnvelope({ context: () => state.ctx }).sha256, envelope.sha256);
});

test('T11-04 保存前切聊天 → CHAT_CHANGED，B 的 metadata 不被污染', async () => {
  const { state, port } = makeHost();
  const { prepared, envelope } = await makePrepared();
  const anchor = port.captureAnchor();
  // 切到 B：新建 metadata 对象
  state.ctx.chatId = 'chat-B';
  state.ctx.chatMetadata = { atlas: { schemaVersion: 1 } };
  const ack = await port.saveCandidate({ capturedHostAnchor: anchor, prepared, envelope });
  assert.equal(ack.result, 'failed');
  assert.equal(ack.error.code, 'CHAT_CHANGED');
  assert.equal(state.ctx.chatMetadata.atlas.database, undefined, 'B 的 metadata 不得写入 A 的存档');
});

test('T11-05 保存过程中切聊天 → 返回后仍要核对，不当作成功', async () => {
  const state = {
    ctx: {
      chatId: 'chat-A',
      chatMetadata: { atlas: {} },
      saveMetadata: async () => {
        state.ctx.chatId = 'chat-B';
        state.ctx.chatMetadata = { atlas: {} };
      },
    },
  };
  const port = createAtlasHostPort({ context: () => state.ctx, readBranchState: () => ({ branchId: 'main-A', revision: 0, storageRevision: 0 }) });
  const { prepared, envelope } = await makePrepared();
  const anchor = port.captureAnchor();
  const ack = await port.saveCandidate({ capturedHostAnchor: anchor, prepared, envelope });
  assert.equal(ack.result, 'failed');
  assert.equal(ack.error.code, 'CHAT_CHANGED');
});

test('T11-06 宿主保存抛错 → SESSION_WRITE_FAILED，并可有条件恢复 metadata', async () => {
  let restored = null;
  const { state, port } = makeHost({
    saveMetadata: async () => {
      throw new Error('disk full');
    },
  });
  const { prepared, envelope } = await makePrepared();
  const previous = state.ctx.chatMetadata.atlas;
  const anchor = port.captureAnchor();
  const ack = await port.saveCandidate({ capturedHostAnchor: anchor, prepared, envelope });
  assert.equal(ack.result, 'failed');
  assert.equal(ack.error.code, 'SESSION_WRITE_FAILED');
  restored = port.restoreMetadata({ chatUid: 'chat-A', expectedIdentity: anchor.metadataIdentity, previous });
  assert.equal(restored, true);
  assert.equal(state.ctx.chatMetadata.atlas, previous);
});

test('T11-07 metadata 对象已变时拒绝恢复（不覆盖别人的 metadata）', async () => {
  const { state, port } = makeHost({ saveMetadata: async () => { throw new Error('nope'); } });
  const { prepared, envelope } = await makePrepared();
  const anchor = port.captureAnchor();
  await port.saveCandidate({ capturedHostAnchor: anchor, prepared, envelope });
  state.ctx.chatMetadata = { atlas: { other: true } };
  const ok = port.restoreMetadata({ chatUid: 'chat-A', expectedIdentity: anchor.metadataIdentity, previous: {} });
  assert.equal(ok, false);
  assert.deepEqual(state.ctx.chatMetadata, { atlas: { other: true } });
});

test('T11-08 宿主不提供确认能力 → requested（保留候选，不伪造 saved）', async () => {
  const { port } = makeHost({ options: { canConfirm: false } });
  const { prepared, envelope } = await makePrepared();
  const anchor = port.captureAnchor();
  const ack = await port.saveCandidate({ capturedHostAnchor: anchor, prepared, envelope });
  assert.equal(ack.result, 'requested');
  assert.equal(ack.error.code, 'HOST_SAVE_UNCONFIRMED');
});

test('T11-09 会话文档与 envelope 同一次落盘（走既有 writeAtlasSession）', async () => {
  const calls = [];
  const state = {
    ctx: {
      chatId: 'chat-A',
      chatMetadata: { atlas: { schemaVersion: 1, session: { schemaVersion: 1, rev: 3 } } },
    },
  };
  const port = createAtlasHostPort({
    context: () => state.ctx,
    readBranchState: () => ({ branchId: 'main-A', revision: 0, storageRevision: 0 }),
    writeSession: async (contextFn, session, expectedChatId) => {
      calls.push({ session, expectedChatId });
    },
  });
  const { prepared, envelope } = await makePrepared();
  const anchor = port.captureAnchor();
  const ack = await port.saveCandidate({ capturedHostAnchor: anchor, prepared, envelope });
  assert.equal(ack.result, 'saved');
  assert.equal(calls.length, 1, '必须调用一次会话写回');
  assert.equal(calls[0].expectedChatId, 'chat-A');
  assert.equal(calls[0].session.rev, 3);
  assert.ok(state.ctx.chatMetadata.atlas.database, 'envelope 必须与 session 同一次写回');
});

test('T11-10 describeHostCapabilities 是纯函数，不修改 ctx', () => {
  const state = { ctx: { chatId: 'chat-A', chatMetadata: { atlas: {} }, saveMetadata: () => true } };
  const before = JSON.stringify(state.ctx.chatMetadata);
  const caps = describeHostCapabilities({ context: () => state.ctx });
  assert.equal(caps.hasSaveMetadata, true);
  assert.equal(caps.hostChatId, 'chat-A');
  assert.equal(JSON.stringify(state.ctx.chatMetadata), before);
});
