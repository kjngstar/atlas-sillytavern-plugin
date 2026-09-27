/**
 * atlas-db-concurrency.test.mjs — T13 并发、单写者与 stop/regen（§18.3 / §7.3 / §7.4 / §16.4）。
 *
 * §18.3 必须覆盖的断言：
 * - 同业务 revision 并发仅一方提交（第二个必须 STALE_BASE，revision 只前进一次）；
 * - 只改 outbox 的快照可重放候选而不重调模型（维护保存不改业务行、模型调用数不增）；
 * - 真实业务变更后仍锚在旧 revision 的提交 → STALE_BASE；
 * - 保存前切聊 → CHAT_CHANGED，且另一个聊天的 metadata 不被触碰；
 * - stop → regen 新 variant 可在同一 base revision 上提交（停止不会永久卡死）；
 * - 提交锁把同一聊天的两次变更严格串行。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, countRows } from './fixtures/atlas-sql/seed.mjs';
import { SOURCE_SNAPSHOT } from './fixtures/atlas-sql/model-cases.mjs';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { commitLockMode, withChatCommitLock } from '../src/atlas-db-queue.ts';
import { createAtlasHostPort } from '../src/atlas-host-port.ts';
import { encodeSnapshot, sha256Hex } from '../src/atlas-db-envelope.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';

const SQL = await (await import('sql.js')).default();
const WALL = 1_700_000_000_000;

/** internal 表没有 branch_id 列，按全局计数。 */
const GLOBAL_TABLES = new Set(['turns', 'turn_changes', 'sync_outbox']);
function countIn(db, table, branchId) {
  if (GLOBAL_TABLES.has(table)) return Number(queryBound(db, `SELECT COUNT(*) AS n FROM ${table}`)[0].n);
  return countRows(db, table, branchId);
}

/** 确定性 makeId：同 (kind, opId, alias) → 同 ID（不依赖时间/随机）。 */
function makeId(kind, opId, alias) {
  let h = 0x811c9dc5;
  const text = `${kind}\u0000${opId}\u0000${alias}`;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${kind.slice(0, 3)}_${h.toString(16).padStart(8, '0')}_${Buffer.from(text).toString('hex').slice(-16)}`;
}

function scriptedModel(responses) {
  return {
    calls: [],
    async request(req) {
      this.calls.push(req);
      const text = responses.length > 0 ? responses.shift() : '{"op":"noop"}';
      return { batchId: req.batchId, text, finishReason: 'stop', httpStatus: 200, durationMs: 5 };
    },
  };
}

async function makeRepo({ responses = [], chatUid = IDS.chatA, now = () => WALL } = {}) {
  const model = scriptedModel(responses);
  const repo = createSqlRepository({ chatUid, branchId: IDS.branchMain, branchName: '主线', modelPort: model, now, makeId });
  const seed = await makeSeedWith(SQL);
  const bytes = seed.exportBytes();
  seed.close();
  await repo.open({ bytes });
  return { repo, model };
}

function anchorFor(baseRevision, overrides = {}) {
  return {
    chatUid: IDS.chatA,
    branchId: IDS.branchMain,
    parentTurnId: IDS.seedTurn,
    hostMessageUid: 'msg_concurrency',
    variantKey: 'v1',
    baseRevision,
    baseStorageRevision: 0,
    inputHash: 'input_concurrency',
    ...overrides,
  };
}

function turnInput(anchor, assistantText, overrides = {}) {
  return { anchor, userText: '', assistantText, sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false, ...overrides };
}

function branchRow(repo) {
  return queryBound(repo.db, 'SELECT revision, head_turn_id, clock_s, clock_min_s, clock_max_s FROM branches WHERE id = ?', [IDS.branchMain])[0];
}

/* ───────────── T13-01：同业务 revision 并发仅一方提交 ───────────── */

test(
  'T13-01 同业务 revision 并发：只有一方能提交，另一方必须 STALE_BASE（revision 只前进一次）',
  async () => {
    const { repo, model } = await makeRepo({
      responses: [
        '{"op":"character.upsert","ref":"C1","data":{"thought":"并发甲"}}',
        '{"op":"character.upsert","ref":"C1","data":{"thought":"并发乙"}}',
      ],
    });
    try {
      const settle = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
      const outcomes = await Promise.all([
        settle(withChatCommitLock(IDS.chatA, () => repo.prepareTurn(turnInput(anchorFor(0, { hostMessageUid: 'm_a', variantKey: 'va' }), '甲正文')))),
        settle(withChatCommitLock(IDS.chatA, () => repo.prepareTurn(turnInput(anchorFor(0, { hostMessageUid: 'm_b', variantKey: 'vb' }), '乙正文')))),
      ]);

      // §7.3 的提交顺序把 revision 复核放在**宿主保存之前**，§7.6 的保证是
      // 「同一基版本两次并发只有一个**有效提交**」——因此冲突在发布阶段解决：
      // 两个候选都可以准备出来，但只有一个 confirmSaved 会被接受。
      const candidates = outcomes.filter((o) => o.ok).map((o) => o.value);
      const prepareFailures = outcomes.filter((o) => !o.ok);
      assert.ok(
        candidates.length >= 1,
        `至少要有一方准备成功；准备阶段失败：${prepareFailures.map((o) => o.error.code).join(',') || '无'}`,
      );
      assert.equal(candidates.length + prepareFailures.length, 2);
      for (const failure of prepareFailures) {
        assert.equal(failure.error.code, 'STALE_BASE', '准备阶段若失败必须是 STALE_BASE');
      }

      const settleConfirm = (candidate) =>
        repo
          .confirmSaved({ token: candidate.token, snapshotSha256: candidate.snapshotSha256, result: 'saved' })
          .then(() => ({ ok: true }), (error) => ({ ok: false, error }));
      const confirmations = [];
      for (const candidate of candidates) confirmations.push(await settleConfirm(candidate));
      const accepted = confirmations.filter((c) => c.ok);
      const refused = confirmations.filter((c) => !c.ok);
      assert.equal(accepted.length, 1, `同一基版本只能有一个有效提交，实际 ${accepted.length} 个`);
      assert.equal(refused.length, candidates.length - 1, '其余候选必须全部被拒（不能静默忽略）');
      for (const loser of refused) {
        assert.equal(loser.error.code, 'STALE_BASE', `被拒的提交应是 STALE_BASE，实际 ${loser.error.code}`);
      }
      const winnerIndex = confirmations.findIndex((c) => c.ok);
      const winner = candidates[winnerIndex];
      assert.equal(winner.receipt.status, 'committed');

      const branch = branchRow(repo);
      assert.equal(Number(branch.revision), 1, 'revision 只能前进一次');
      assert.equal(branch.head_turn_id, winner.receipt.turnId, 'head 必须指向唯一胜者');
      assert.equal(queryBound(repo.db, 'SELECT id FROM turns WHERE id = ? AND status = ?', [winner.receipt.turnId, 'committed']).length, 1);
      for (const loser of candidates.filter((c) => c !== winner)) {
        assert.equal(queryBound(repo.db, 'SELECT id FROM turns WHERE id = ?', [loser.receipt.turnId]).length, 0, '败者的推演不得进入正式库');
      }
      assert.equal(model.calls.length, 2, '两侧都发过请求：拒绝必须发生在提交/发布阶段，不能靠不发请求掩盖');
    } finally {
      await repo.close();
    }
  },
);

/* ───────────── T13-02：只改 outbox 的快照可重放候选而不重调模型 ───────────── */

test('T13-02 只改 outbox 的快照：维护保存不改业务行、不重调模型，候选可重放', async () => {
  const { repo, model } = await makeRepo({
    responses: [
      '{"op":"character.upsert","ref":"C1","data":{"thought":"第一轮"}}',
      '{"op":"character.upsert","ref":"C2","data":{"thought":"重放的第二轮"}}',
    ],
  });
  try {
    const first = await repo.prepareTurn(turnInput(anchorFor(0, { hostMessageUid: 'm1' }), '第一楼。'));
    assert.equal(first.receipt.status, 'committed');
    await repo.confirmSaved({ token: first.token, snapshotSha256: first.snapshotSha256, result: 'saved' });

    // 只改 outbox 的维护快照
    const branchBefore = branchRow(repo);
    const businessBefore = ['characters', 'items', 'locations', 'events', 'information', 'knowledge', 'mention_candidates', 'entity_keys']
      .map((table) => [table, countIn(repo.db, table, IDS.branchMain)]);
    const pending = queryBound(repo.db, "SELECT id FROM sync_outbox WHERE status = 'pending'");
    assert.equal(pending.length, 1, '成功提交应登记一条同步意图');

    const modelCallsBefore = model.calls.length;
    const maintenance = await repo.prepareMaintenance({
      anchor: anchorFor(Number(branchBefore.revision), { hostMessageUid: 'maint_1', variantKey: 'maint' }),
      outboxResults: [
        {
          taskId: String(pending[0].id),
          expectedStatus: 'pending',
          nextStatus: 'succeeded',
          attemptCount: 1,
          completedWallMs: WALL + 1000,
        },
      ],
    });
    assert.equal(maintenance.kind, 'maintenance');
    assert.equal(maintenance.receipt, null, '维护不产生业务回执');
    assert.equal(model.calls.length, modelCallsBefore, '维护期间不得重新调用模型');
    await repo.confirmSaved({ token: maintenance.token, snapshotSha256: maintenance.snapshotSha256, result: 'saved' });
    assert.equal(model.calls.length, modelCallsBefore, '确认维护保存同样不得调用模型');

    // 业务行与分支推进指针必须逐项不变
    assert.deepEqual(branchRow(repo), branchBefore, '维护不得改 revision/head/clock');
    assert.deepEqual(
      ['characters', 'items', 'locations', 'events', 'information', 'knowledge', 'mention_candidates', 'entity_keys']
        .map((table) => [table, countIn(repo.db, table, IDS.branchMain)]),
      businessBefore,
      '维护不得增删任何业务表的行',
    );
    assert.equal(queryBound(repo.db, 'SELECT status FROM sync_outbox WHERE id = ?', [pending[0].id])[0].status, 'succeeded');
    assert.equal(Number(queryBound(repo.db, 'SELECT revision FROM branches WHERE id = ?', [IDS.branchMain])[0].revision), 1, '维护不推进 revision');

    // 维护后：与业务 revision 无关的候选可以按快照重放，且不需要重新请求模型
    const replay = await repo.prepareTurn(turnInput(anchorFor(1, { hostMessageUid: 'm2', parentTurnId: first.receipt.turnId }), '第二楼。'));
    assert.equal(replay.receipt.status, 'committed');
    assert.equal(model.calls.length, modelCallsBefore + 1, '重放业务轮只应调用一次模型，且不是维护触发的');
    await repo.confirmSaved({ token: replay.token, snapshotSha256: replay.snapshotSha256, result: 'saved' });
    const branchAfter = branchRow(repo);
    assert.equal(Number(branchAfter.revision), 2, '业务提交才推进 revision');
    assert.equal(branchAfter.head_turn_id, replay.receipt.turnId);
    assert.equal(queryBound(repo.db, 'SELECT thought FROM characters WHERE branch_id = ? AND id = ?', [IDS.branchMain, IDS.C2])[0].thought, '重放的第二轮');
    assert.equal(queryBound(repo.db, "SELECT COUNT(*) AS n FROM sync_outbox WHERE status = 'pending'")[0].n, 1, '维护不生成循环同步任务');
  } finally {
    await repo.close();
  }
});

/* ───────────── T13-03：真实业务变更 → STALE_BASE ───────────── */

test('T13-03 真实业务变更后：仍锚在旧 revision 的准备必须 STALE_BASE', async () => {
  const { repo } = await makeRepo({
    responses: [
      '{"op":"character.upsert","ref":"C1","data":{"thought":"真实变更"}}',
      '{"op":"character.upsert","ref":"C1","data":{"thought":"不该落地"}}',
    ],
  });
  try {
    const committed = await repo.prepareTurn(turnInput(anchorFor(0, { hostMessageUid: 'm1' }), '真实一。'));
    await repo.confirmSaved({ token: committed.token, snapshotSha256: committed.snapshotSha256, result: 'saved' });
    assert.equal(Number(branchRow(repo).revision), 1);

    await assert.rejects(
      () => repo.prepareTurn(turnInput(anchorFor(0, { hostMessageUid: 'm2' }), '还想从旧版本提交。')),
      (err) => err.code === 'STALE_BASE',
    );
    // 拒绝后正式库与 revision 均不变
    assert.equal(Number(branchRow(repo).revision), 1);
    assert.equal(queryBound(repo.db, 'SELECT thought FROM characters WHERE branch_id = ? AND id = ?', [IDS.branchMain, IDS.C1])[0].thought, '真实变更');

    // 锚在新 revision 上则正常通过
    const fresh = await repo.prepareTurn(turnInput(anchorFor(1, { hostMessageUid: 'm3', parentTurnId: committed.receipt.turnId }), '新版本提交。'));
    assert.equal(fresh.receipt.status, 'committed');
  } finally {
    await repo.close();
  }
});

/* ───────────── T13-04：保存前切聊 ───────────── */

test('T13-04 保存前切聊：CHAT_CHANGED，且另一个聊天的 metadata 不被触碰', async () => {
  const { repo } = await makeRepo({ responses: ['{"op":"character.upsert","ref":"C1","data":{"thought":"待保存"}}'] });
  try {
    const prepared = await repo.prepareTurn(turnInput(anchorFor(0, { hostMessageUid: 'm1' }), '待保存一。'));
    const envelope = await encodeSnapshot(prepared.snapshot, {
      chatUid: IDS.chatA,
      worldUid: 'world_chat_A',
      storageRevision: 1,
      activeBranchId: IDS.branchMain,
    });

    // 宿主上下文：先捕获 chat-A 的锚点，再切到 chat-B 保存
    const contextA = { chatId: IDS.chatA, chatMetadata: { atlas: { session: { marker: 'A 的会话' } } }, saveMetadata: async () => {} };
    const contextB = { chatId: IDS.chatB, chatMetadata: { atlas: { session: { marker: 'B 的会话' } } }, saveMetadata: async () => {} };
    let current = contextA;
    const port = createAtlasHostPort({ context: () => current, now: () => WALL });

    const capturedAnchor = port.captureAnchor();
    assert.equal(capturedAnchor.chatUid, IDS.chatA);
    assert.equal(port.isCurrent(capturedAnchor), true);
    const metadataBBefore = JSON.stringify(contextB.chatMetadata);
    const publishedBefore = await sha256Hex(await repo.exportCurrent());

    current = contextB; // 保存前切聊
    assert.equal(port.isCurrent(capturedAnchor), false);
    const ack = await port.saveCandidate({ capturedHostAnchor: capturedAnchor, prepared, envelope });
    assert.equal(ack.result, 'failed');
    assert.equal(ack.error.code, 'CHAT_CHANGED');
    assert.equal(ack.token, prepared.token);
    assert.equal(await sha256Hex(await repo.exportCurrent()), publishedBefore, '切聊被拒后正式库哈希必须不变');
    assert.equal(
      queryBound(repo.db, 'SELECT id FROM turns WHERE id = ?', [prepared.receipt.turnId]).length,
      0,
      '被拒绝的保存不得把候选的推演记录发布进正式库',
    );
    assert.equal(
      queryBound(repo.db, 'SELECT thought FROM characters WHERE branch_id = ? AND id = ?', [IDS.branchMain, IDS.C1])[0].thought,
      '',
      '被拒绝的保存不得改动正式库业务行',
    );

    // 切聊后 B 的 metadata 完全没动，A 也没有被写进 B
    assert.equal(JSON.stringify(contextB.chatMetadata), metadataBBefore, 'chat-B 的 metadata 不得被改动');
    assert.equal(contextB.chatMetadata.atlas.session.marker, 'B 的会话');
    assert.equal(contextB.chatMetadata.atlas.database, undefined, '不能把 chat-A 的信封写进 chat-B');

    // 宿主保存结果确认：先回到 chat-A，正常保存成功
    current = contextA;
    const anchorAgain = port.captureAnchor();
    const ok = await port.saveCandidate({ capturedHostAnchor: anchorAgain, prepared, envelope });
    assert.equal(ok.result, 'saved');
    assert.equal(contextA.chatMetadata.atlas.database.sha256, envelope.sha256);
  } finally {
    await repo.close();
  }
});

/* ───────────── T13-05：stop → regen 新 variant 可提交 ───────────── */

test('T13-05 stop→regen：丢弃被停止的候选后，同 base revision 的新 variant 仍可提交', async () => {
  const { repo } = await makeRepo({
    responses: [
      '{"op":"character.upsert","ref":"C1","data":{"thought":"被停止的候选"}}',
      '{"op":"character.upsert","ref":"C1","data":{"thought":"重生成后的候选"}}',
    ],
  });
  try {
    const stopped = await repo.prepareTurn(
      turnInput(anchorFor(0, { hostMessageUid: 'msg_swipe', variantKey: 'swipe-1' }), '第一次正文'),
    );
    assert.equal(stopped.receipt.status, 'committed');
    const stoppedTurnId = stopped.receipt.turnId;

    // 模拟用户 stop：候选被丢弃，正式库不变、revision 不推进
    await repo.discardPrepared(stopped.token);
    assert.equal(repo.getCandidate(stopped.token), null, '停止后候选必须真的消失');
    assert.equal(Number(branchRow(repo).revision), 0, '停止不得推进 revision');
    assert.equal(branchRow(repo).head_turn_id, IDS.seedTurn);
    assert.equal(queryBound(repo.db, 'SELECT thought FROM characters WHERE branch_id = ? AND id = ?', [IDS.branchMain, IDS.C1])[0].thought, '');

    // 同一 base revision、同一个 hostMessageUid、新的 variantKey：必须能重新提交
    const regenerated = await repo.prepareTurn(
      turnInput(anchorFor(0, { hostMessageUid: 'msg_swipe', variantKey: 'swipe-2' }), '重生成正文'),
    );
    assert.equal(regenerated.receipt.status, 'committed', `regen 必须能提交：${regenerated.receipt.issues.map((i) => i.code).join(',')}`);
    assert.notEqual(regenerated.receipt.turnId, stoppedTurnId, '不同 variant 必须是不同的推演候选');
    await repo.confirmSaved({ token: regenerated.token, snapshotSha256: regenerated.snapshotSha256, result: 'saved' });

    assert.equal(queryBound(repo.db, 'SELECT thought FROM characters WHERE branch_id = ? AND id = ?', [IDS.branchMain, IDS.C1])[0].thought, '重生成后的候选');
    assert.equal(Number(branchRow(repo).revision), 1, '只有新 variant 这一次提交');
    assert.equal(branchRow(repo).head_turn_id, regenerated.receipt.turnId);
    // 被停止的推演没有进入正式库
    assert.equal(
      queryBound(repo.db, 'SELECT id FROM turns WHERE id = ? AND status = ?', [stoppedTurnId, 'committed']).length,
      0,
      '被停止的候选不得出现在正式库的有效历史里',
    );
  } finally {
    await repo.close();
  }
});

/* ───────────── T13-06：提交锁串行 ───────────── */

test('T13-06 提交锁：同一聊天的两次真实变更严格串行（第一次结束第二次才开始）', async () => {
  const { repo } = await makeRepo({
    responses: [
      '{"op":"character.upsert","ref":"C1","data":{"thought":"锁下甲"}}',
      '{"op":"character.upsert","ref":"C1","data":{"thought":"锁下乙"}}',
    ],
  });
  try {
    const events = [];
    let firstReleased = false;
    // 准备 + 宿主确认是 §7.3 提交顺序里必须整体串行的两步，都放进同一把锁。
    const firstCommit = withChatCommitLock(IDS.chatA, async (info) => {
      assert.equal(info.chatUid, IDS.chatA);
      events.push('first-start');
      const prepared = await repo.prepareTurn(turnInput(anchorFor(0, { hostMessageUid: 'm_lock_a', variantKey: 'la' }), '甲正文'));
      assert.equal(prepared.receipt.status, 'committed');
      await repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'saved' });
      assert.equal(firstReleased, false, '第一次提交结束之前，第二次变更不得开始');
      events.push('first-end');
      firstReleased = true;
      return prepared;
    });
    const secondCommit = withChatCommitLock(IDS.chatA, async () => {
      events.push('second-start');
      assert.deepEqual(events, ['first-start', 'first-end', 'second-start'], '第二次必须等第一次结束后才开始');
      // 第二次变更看到的是第一次已经发布的 revision（严格串行、没有交叉写）
      const revisionBefore = Number(branchRow(repo).revision);
      assert.equal(revisionBefore, 1, '第二次进入锁时第一次已经发布');
      assert.equal(queryBound(repo.db, 'SELECT thought FROM characters WHERE branch_id = ? AND id = ?', [IDS.branchMain, IDS.C1])[0].thought, '锁下甲');
      const prepared = await repo.prepareTurn(
        turnInput(anchorFor(revisionBefore, IDS.seedTurn, 'm_lock_b', { variantKey: 'lb' }), '乙正文'),
      );
      await repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'saved' });
      events.push('second-end');
      return prepared;
    });

    const [, secondPrepared] = await Promise.all([firstCommit, secondCommit]);
    assert.deepEqual(events, ['first-start', 'first-end', 'second-start', 'second-end']);
    assert.equal(Number(branchRow(repo).revision), 2, '两次提交各自推进一步（严格串行、无交叉写）');
    assert.equal(branchRow(repo).head_turn_id, secondPrepared.receipt.turnId);
    assert.equal(queryBound(repo.db, 'SELECT thought FROM characters WHERE branch_id = ? AND id = ?', [IDS.branchMain, IDS.C1])[0].thought, '锁下乙');

    // 另一个聊天不被本聊天的队列阻塞（不同 key）
    const parallel = [];
    await Promise.all([
      withChatCommitLock(IDS.chatB, async () => {
        parallel.push('b');
      }),
      withChatCommitLock('chat-C', async () => {
        parallel.push('c');
      }),
    ]);
    assert.deepEqual([...parallel].sort(), ['b', 'c']);
  } finally {
    await repo.close();
  }
});

test('T13-07 提交锁模式可判定：报出实际使用的锁模式，不假装跨标签强一致', async () => {
  const mode = commitLockMode();
  assert.ok(mode === 'in-process' || mode === 'web-locks', `锁模式必须是已知值：${mode}`);
  await withChatCommitLock(IDS.chatA, async (info) => {
    assert.equal(info.chatUid, IDS.chatA);
    assert.equal(info.mode, mode);
    assert.ok(Number.isFinite(info.waitedMs) && info.waitedMs >= 0);
  });
});
