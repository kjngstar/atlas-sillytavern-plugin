/**
 * atlas-world-build-epoch.test.mjs — P05 §11.3/§11.4：在途票据失效与保存语义。
 *
 * 两个断言层次：
 * - `isBatchTicketCurrent`：八个失效维度逐个单独触发，reason 固定；
 * - `invalidateBuildRun` / `validateBatchCommit`：作废与入库守卫的语义边界。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isBatchTicketCurrent } from '../src/atlas-world-build-contract.ts';
import { invalidateBuildRun, validateBatchCommit } from '../src/atlas-world-build-state.ts';

function ticket(overrides = {}) {
  return {
    version: 1,
    jobId: 'J1',
    windowSequence: 1,
    unitIds: ['U1'],
    chatUid: 'chat-1',
    branchId: 'B1',
    ownerFloorId: 'FLOOR_HEAD',
    causalFloorId: 'FLOOR_EVENT',
    baseRevision: 3,
    baseStorageRevision: 3,
    sourceManifestHash: 'manifest_1',
    runEpoch: 0,
    inputSignature: 'sig_1',
    ...overrides,
  };
}

function current(overrides = {}) {
  return {
    jobId: 'J1',
    runEpoch: 0,
    chatUid: 'chat-1',
    branchId: 'B1',
    ownerFloorId: 'FLOOR_HEAD',
    baseRevision: 3,
    baseStorageRevision: 3,
    sourceManifestHash: 'manifest_1',
    ...overrides,
  };
}

function job(overrides = {}) {
  return {
    version: 1,
    id: 'J1',
    branchId: 'B1',
    kind: 'initialize',
    status: 'running',
    sourceManifestHash: 'manifest_1',
    policyVersion: 'policy_1',
    originFloorId: 'FLOOR_ORIGIN',
    runEpoch: 4,
    nextWindowSequence: 2,
    committedWindowSequence: 1,
    cumulativeTransports: 9,
    cumulativeWindows: 1,
    stopReason: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §11.3 失效维度
// ---------------------------------------------------------------------------

test('P05 §11.3: 全部一致时票据有效', () => {
  assert.deepEqual(isBatchTicketCurrent(ticket(), current()), { current: true });
});

test('P05 §11.3: 八个失效维度各自单独触发，reason 固定', () => {
  const cases = [
    ['job-mismatch', { jobId: 'J2' }],
    ['chat-switched', { chatUid: 'chat-2' }],
    ['branch-switched', { branchId: 'B2' }],
    ['owner-floor-moved', { ownerFloorId: 'FLOOR_OTHER' }],
    ['revision-moved', { baseRevision: 4 }],
    ['storage-revision-moved', { baseStorageRevision: 4 }],
    ['source-manifest-changed', { sourceManifestHash: 'manifest_2' }],
    ['epoch-stale', { runEpoch: 1 }],
  ];
  assert.equal(cases.length, 8);
  for (const [reason, patch] of cases) {
    const verdict = isBatchTicketCurrent(ticket(), current(patch));
    assert.equal(verdict.current, false, `${reason} 必须判定失效`);
    assert.equal(verdict.reason, reason);
  }
});

test('P05 §11.3: 切聊天优先于切分支——reason 稳定不随检查顺序漂移', () => {
  const verdict = isBatchTicketCurrent(ticket(), current({ chatUid: 'chat-2', branchId: 'B2', runEpoch: 3 }));
  assert.equal(verdict.reason, 'chat-switched');
});

test('P05 §11.3: 换 job 优先于一切时间线变化', () => {
  const verdict = isBatchTicketCurrent(ticket(), current({
    jobId: 'J2', chatUid: 'chat-2', branchId: 'B2', ownerFloorId: 'X', runEpoch: 9,
  }));
  assert.equal(verdict.reason, 'job-mismatch');
});

// ---------------------------------------------------------------------------
// §11.3 作废：runEpoch 自增，发送计数不退
// ---------------------------------------------------------------------------

test('P05 §11.3: 作废在途运行 → runEpoch 自增，旧票据立即过期', () => {
  const before = job();
  const after = invalidateBuildRun(before, '回退到上一楼层');
  assert.equal(after.runEpoch, before.runEpoch + 1);
  assert.equal(after.status, 'paused', '进行中的 job 不再自动接着发');
  assert.equal(after.stopReason, '回退到上一楼层');

  const verdict = isBatchTicketCurrent(ticket({ runEpoch: before.runEpoch }), current({ runEpoch: after.runEpoch }));
  assert.equal(verdict.current, false);
  assert.equal(verdict.reason, 'epoch-stale');
});

test('P05 §11.2: 作废不退还已发生的网络发送', () => {
  const after = invalidateBuildRun(job({ cumulativeTransports: 12 }), '切分支');
  assert.equal(after.cumulativeTransports, 12, '历史发送是已经发生的事实，不能因为回退抹掉');
});

test('P05 §11.3: 已取消的任务保持取消，不会被作废「复活」', () => {
  const after = invalidateBuildRun(job({ status: 'cancelled', runEpoch: 2 }), '停止');
  assert.equal(after.status, 'cancelled');
  assert.equal(after.runEpoch, 3, 'epoch 仍要前进：旧票据照样要失效');
});

test('P05 §11.3: 已完成的任务作废时不会被改回 running', () => {
  for (const status of ['completed', 'completed-with-issues', 'paused']) {
    const after = invalidateBuildRun(job({ status }), '切聊天');
    assert.equal(after.status, status, `${status} 不该被作废改成别的状态`);
  }
});

test('P05 §11.3: 反复作废只会单调前进，不会因为重复调用回到旧 epoch', () => {
  let currentJob = job({ runEpoch: 0 });
  const seen = [];
  for (let index = 0; index < 5; index += 1) {
    currentJob = invalidateBuildRun(currentJob, `第 ${index + 1} 次`);
    seen.push(currentJob.runEpoch);
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
});

// ---------------------------------------------------------------------------
// §11.4 保存语义
// ---------------------------------------------------------------------------

test('P05 §11.4: 依附楼层必须是当前 head，否则拒绝跨楼层提交', () => {
  const verdict = validateBatchCommit({
    ticket: ticket({ ownerFloorId: 'FLOOR_OLD' }),
    jobOriginFloorId: 'FLOOR_ORIGIN',
    currentHeadTurnId: 'FLOOR_HEAD',
    savedAck: true,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'WORLD_BUILD_CROSS_FLOOR_COMMIT');
  assert.ok(verdict.message.includes('FLOOR_OLD'));
  assert.ok(verdict.message.includes('FLOOR_HEAD'));
});

test('P05 §11.4: 没有 saved ACK 就不推进（requested ≠ saved）', () => {
  const verdict = validateBatchCommit({
    ticket: ticket(),
    jobOriginFloorId: 'FLOOR_ORIGIN',
    currentHeadTurnId: 'FLOOR_HEAD',
    savedAck: false,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'WORLD_BUILD_SAVE_NOT_ACKED');
  assert.ok(verdict.message.includes('committedWindowSequence'));
});

test('P05 §11.4: 没有有效 head 时拒绝提交，不拿别的楼层顶替', () => {
  const verdict = validateBatchCommit({
    ticket: ticket(),
    jobOriginFloorId: 'FLOOR_ORIGIN',
    currentHeadTurnId: '   ',
    savedAck: true,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'WORLD_BUILD_HEAD_MISSING');
});

test('P05 §11.4: 缺少任务起因楼层时拒绝（provenance 不完整）', () => {
  const verdict = validateBatchCommit({
    ticket: ticket(),
    jobOriginFloorId: '',
    currentHeadTurnId: 'FLOOR_HEAD',
    savedAck: true,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'WORLD_BUILD_ORIGIN_FLOOR_MISSING');
});

test('P05 §11.4: 起因楼层与依附楼层可以不同，但两者都要有', () => {
  const verdict = validateBatchCommit({
    ticket: ticket({ ownerFloorId: 'FLOOR_HEAD', causalFloorId: 'FLOOR_EVENT' }),
    jobOriginFloorId: 'FLOOR_ORIGIN',
    currentHeadTurnId: 'FLOOR_HEAD',
    savedAck: true,
  });
  assert.deepEqual(verdict, { ok: true });
});
