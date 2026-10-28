/**
 * atlas-world-build-lore-delta.test.mjs — P13 §19.1 / §19.2：世界书增量。
 *
 * 要证明的四件事：
 * 1. 只有变了的那条来源影响到的目标入队，别的图进度**不清零**；
 * 2. 初始化期间来的新资料进增量队列，**不扩初始分母**（否则初始化永远结束不了）；
 * 3. 来源被删/读取许可被收回：已生成的地图与事实保留，未读块标 blocked，候选作废；
 * 4. 旧 hash 拿不到时如实标 superseded，不用新文本冒充旧 hash 已扫描。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LORE_DELTA_REASONS,
  diffLoreManifest,
  incrementalPolicyDuringInitialize,
  planLoreDelta,
  planPermissionRevocation,
  planStaleHashReplacement,
  shouldWaitForEntry,
} from '../src/atlas-lore-delta.ts';

const src = (sourceKey, contentHash, extra = {}) => ({ sourceKey, contentHash, ...extra });

test('§19.1 变更判定只认 key+hash+许可，不靠长度相似猜', () => {
  const before = [src('W1', 'aaa'), src('W2', 'bbb'), src('W3', 'ccc')];
  const after = [
    src('W1', 'aaa'),          // 没变
    src('W2', 'bbb2'),         // 内容变了
    src('W9', 'ddd'),          // 新增
  ];
  const diff = diffLoreManifest(before, after);
  assert.deepEqual(diff.unchanged.map((e) => e.sourceKey), ['W1']);
  assert.deepEqual(diff.changed.map((e) => e.sourceKey), ['W2']);
  assert.deepEqual(diff.added.map((e) => e.sourceKey), ['W9']);
  assert.deepEqual(diff.removed.map((e) => e.sourceKey), ['W3']);
  assert.deepEqual([...LORE_DELTA_REASONS], ['source-added', 'source-changed', 'permission-revoked', 'permission-granted', 'source-removed']);
});

test('§19.1 只有相关实体/图入队，未受影响目标的进度不清零', () => {
  const previous = [
    src('W1', 'aaa', { targetIds: ['T_town_a'] }),
    src('W2', 'bbb', { targetIds: ['T_town_b'] }),
  ];
  const next = [
    src('W1', 'aaa2', { targetIds: ['T_town_a'] }),   // 只有 A 城这条来源变了
    src('W2', 'bbb', { targetIds: ['T_town_b'] }),
  ];
  const plan = planLoreDelta({
    previous,
    next,
    targetMaps: new Map([['T_town_a', 'M1'], ['T_town_b', 'M2'], ['T_town_c', 'M3']]),
  });
  assert.deepEqual(plan.enqueue.map((entry) => `${entry.targetId}:${entry.reason}`), ['T_town_a:source-changed']);
  assert.deepEqual(plan.untouchedTargetIds, ['T_town_b', 'T_town_c'], 'B 城与未受影响的 C 都必须保持已处理');
});

test('§19.1 来源消失不等于世界消失：地图与事实保留，只记资料缺失', () => {
  const plan = planLoreDelta({
    previous: [src('W7', 'hash7', { targetIds: ['T_keep'] })],
    next: [],
  });
  assert.deepEqual(plan.missingSources, [{ sourceKey: 'W7', affectedTargetIds: ['T_keep'] }]);
  assert.equal(plan.enqueue.length, 0, '来源消失不产生「重建」任务');
  assert.ok(plan.issues.some((issue) => issue.code === 'LORE_SOURCE_MISSING_FACTS_KEPT'));
  assert.ok(
    plan.issues.find((issue) => issue.code === 'LORE_SOURCE_MISSING_FACTS_KEPT').message.includes('保留'),
    '必须明说已登记的地图与事实保留',
  );
});

test('§19.2 初始化期间新资料进增量队列，初始分母冻结', () => {
  const policy = incrementalPolicyDuringInitialize({
    initialScopeSourceKeys: ['W1', 'W2'],
    incomingSourceKeys: ['W2', 'W3', 'W4'],
  });
  assert.deepEqual(policy.frozenInitialScope, ['W1', 'W2']);
  assert.deepEqual(policy.incrementalQueue, ['W3', 'W4']);
  assert.equal(policy.denominatorChanged, false, '分母不能因为读到新条目而变大');
});

test('§19.2 许可被收回：未读块 blocked、候选作废、已生成结果保留、run ticket 失效', () => {
  const plan = planPermissionRevocation({
    revokedSourceKeys: ['W1'],
    unreadChunkKeys: ['W1:0:aaa:0', 'W1:0:aaa:1'],
    pendingCandidateIds: ['cand_1'],
    alreadyProducedTargetIds: ['T_town_a'],
  });
  assert.deepEqual(plan.blockedChunkKeys, ['W1:0:aaa:0', 'W1:0:aaa:1']);
  assert.deepEqual(plan.cancelledCandidateIds, ['cand_1']);
  assert.deepEqual(plan.keptTargetIds, ['T_town_a']);
  assert.equal(plan.runTicketInvalidated, true);

  const noop = planPermissionRevocation({ revokedSourceKeys: [] });
  assert.equal(noop.runTicketInvalidated, false);
  assert.deepEqual(noop.blockedChunkKeys, []);
});

test('§19.2 旧 hash 拿不到：标 superseded，不把新文本当成旧 hash 已扫描', () => {
  const plan = planStaleHashReplacement({
    oldContentHash: 'oldhash123',
    newContentHash: 'newhash456',
    oldUnreadChunkKeys: ['W1:0:oldhash123:3'],
  });
  assert.deepEqual(plan.supersededChunkKeys, ['W1:0:oldhash123:3']);
  assert.equal(plan.resumeWithHash, 'newhash456');
  assert.equal(plan.acceptsOldHashAsScanned, false);
  assert.ok(plan.issues.some((issue) => issue.code === 'LORE_STALE_HASH_SUPERSEDED'));
});

test('§19.1 只有作者明确要求的目标才等实际进入；有未读块就先读', () => {
  assert.deepEqual(shouldWaitForEntry({ targetRequiresEntry: true }), { wait: true, reason: 'ENTRY_REQUIRED' });
  assert.deepEqual(shouldWaitForEntry({ targetRequiresEntry: false }), { wait: false, reason: 'PROCEED' });
  assert.deepEqual(
    shouldWaitForEntry({ targetRequiresEntry: true, hasUnreadChunks: true }),
    { wait: false, reason: 'UNREAD_CHUNKS' },
    '还有没读的内容就先读，不因为「没进去过」把整个任务卡死',
  );
});
