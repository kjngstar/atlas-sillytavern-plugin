/**
 * atlas-layout-repair-context.test.mjs — P06 §12.6 定向纠错。
 *
 * 核心回归：四图里只有一张 enclosure 错 → 第二次只发那一张，带上
 * 「哪条校验错了 / 路径 / 允许值 / 保留锁」，且**不把非法值悄悄改成 open**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYOUT_FAILURE_KINDS,
  REPAIR_STRATEGIES,
  enumRepairHint,
  planLayoutRepair,
} from '../src/atlas-layout-repair-context.ts';

const failure = (overrides = {}) => ({
  mapId: 'M1',
  kind: 'validation-rejected',
  originBatchId: 'batch_1',
  issues: [{ code: 'ENUM_INVALID', path: '$.data.spec.enclosure', allowedValues: ['open', 'wall'] }],
  ...overrides,
});

const mapOf = (overrides = {}) => ({ mapId: 'M1', batchId: 'batch_1', attempts: 0, ...overrides });

test('P06 §12.6: 四图只错一张 → 只发那一张，成功图不重做', () => {
  const plan = planLayoutRepair({
    failures: [failure({ mapId: 'M2' })],
    maps: [mapOf({ mapId: 'M1' }), mapOf({ mapId: 'M2' }), mapOf({ mapId: 'M3' }), mapOf({ mapId: 'M4' })],
  });
  assert.equal(plan.batches.length, 1);
  assert.deepEqual(plan.batches[0].mapIds, ['M2'], '只重做失败的那张');
  assert.equal(plan.batches[0].contexts.length, 1);
  assert.deepEqual(plan.failed, []);
});

test('P06 §12.6: 纠错上下文带上错误码、路径与允许值', () => {
  const plan = planLayoutRepair({ failures: [failure()], maps: [mapOf()] });
  const context = plan.batches[0].contexts[0];
  assert.equal(context.kind, 'validation-rejected');
  assert.equal(context.strategy, 'repair-context');
  assert.equal(context.failures.length, 1);
  assert.equal(context.failures[0].code, 'ENUM_INVALID');
  assert.equal(context.failures[0].path, '$.data.spec.enclosure');
  assert.deepEqual(context.failures[0].allowedValues, ['open', 'wall']);
});

test('P06 §12.6: 非法枚举提示只列允许值，不把原值改写成第一个合法值', () => {
  const hint = enumRepairHint({ path: '$.data.spec.enclosure', invalidValue: 'stone-open', allowedValues: ['open', 'wall'] });
  assert.equal(hint.code, 'ENUM_INVALID');
  assert.equal(hint.invalidValue, 'stone-open', '原值必须原样带出');
  assert.deepEqual(hint.allowedValues, ['open', 'wall']);
  assert.ok(hint.message.includes('open / wall'));
  assert.ok(hint.message.includes('不会把它悄悄改成 open'), '明确拒绝「一律转 open」的做法');
});

test('P06 §12.6: 缺回复与截断走原样重发，不带纠错上下文', () => {
  for (const kind of ['missing-reply', 'output-truncated']) {
    assert.equal(REPAIR_STRATEGIES[kind], 'retry-same');
  }
  const plan = planLayoutRepair({ failures: [failure({ kind: 'missing-reply', issues: [] })], maps: [mapOf()] });
  assert.equal(plan.batches.length, 1);
  assert.equal(plan.batches[0].contexts[0].strategy, 'retry-same');
});

test('P06 §12.6: 网络失败单独成批，不夹带内容纠错', () => {
  const plan = planLayoutRepair({
    failures: [failure({ mapId: 'M1' }), failure({ mapId: 'M2', kind: 'transport-failed', issues: [] })],
    maps: [mapOf({ mapId: 'M1' }), mapOf({ mapId: 'M2' })],
  });
  assert.equal(plan.batches.length, 2);
  assert.deepEqual(plan.batches.map((batch) => batch.batchId), ['layout_repair_content', 'layout_repair_transport']);
  assert.deepEqual(plan.batches[1].mapIds, ['M2']);
});

test('P06 §12.6: 纠错次数用尽 → 判 failed，不再无限重试', () => {
  const plan = planLayoutRepair({
    failures: [failure({ mapId: 'M1' })],
    maps: [mapOf({ mapId: 'M1', attempts: 2 })],
    maxAttempts: 2,
  });
  assert.deepEqual(plan.batches, []);
  assert.deepEqual(plan.failed, [{ mapId: 'M1', reason: '纠错次数已达上限 2（失败类型 validation-rejected）' }]);
  const issue = plan.issues.find((item) => item.code === 'LAYOUT_REPAIR_EXHAUSTED');
  assert.ok(issue);
  assert.equal(issue.retryable, false, '新窗口不能自动把它变回 fresh');
});

test('P06 §12.6: 解析不出 mapId 的失败不猜，报出来等目录修好', () => {
  const plan = planLayoutRepair({
    failures: [failure({ mapId: null })],
    maps: [mapOf()],
  });
  assert.deepEqual(plan.batches, []);
  const issue = plan.issues.find((item) => item.code === 'LAYOUT_REPAIR_MAP_UNRESOLVED');
  assert.ok(issue);
  assert.ok(issue.message.includes('不能按标题猜'));
});

test('P06 §12.6: 同一张图多种失败合并成一个上下文，以内容性失败为准', () => {
  const plan = planLayoutRepair({
    failures: [
      failure({ mapId: 'M1', kind: 'output-truncated', issues: [{ code: 'TRUNCATED', path: '$' }] }),
      failure({ mapId: 'M1', kind: 'geometry-rejected', issues: [{ code: 'GEOM_OVERLAP', path: '$.rooms' }] }),
    ],
    maps: [mapOf({ mapId: 'M1' })],
  });
  assert.equal(plan.batches.length, 1);
  assert.equal(plan.batches[0].contexts.length, 1, '同一张图只发一次');
  const context = plan.batches[0].contexts[0];
  assert.equal(context.kind, 'geometry-rejected', '内容性失败优先');
  assert.equal(context.failures.length, 2, '两个失败片段都要带上');
});

test('P06 §12.6: 失败条目按 path 排序，输出确定性', () => {
  const plan = planLayoutRepair({
    failures: [failure({
      issues: [
        { code: 'B', path: '$.z' },
        { code: 'A', path: '$.a' },
      ],
    })],
    maps: [mapOf()],
  });
  assert.deepEqual(plan.batches[0].contexts[0].failures.map((item) => item.path), ['$.a', '$.z']);
});

test('P06 §12.6: 锁与稳定实体原样带进纠错上下文', () => {
  const plan = planLayoutRepair({
    failures: [failure()],
    maps: [mapOf()],
    locksByMap: { M1: ['LOCK_MAIN_DOOR', 'LOCK_MAIN_DOOR'] },
    membersByMap: { M1: ['ROOM_HALL', 'ROOM_KITCHEN'] },
  });
  const context = plan.batches[0].contexts[0];
  assert.deepEqual(context.preservedLockIds, ['LOCK_MAIN_DOOR'], '去重');
  assert.deepEqual(context.preservedMemberIds, ['ROOM_HALL', 'ROOM_KITCHEN'], '稳定排序');
});

test('P06 §12.6: 七个失败类别都有明确策略，没有「什么都不做」', () => {
  assert.equal(LAYOUT_FAILURE_KINDS.length, 7);
  for (const kind of LAYOUT_FAILURE_KINDS) {
    const strategy = REPAIR_STRATEGIES[kind];
    assert.ok(['retry-same', 'repair-context', 'retry-later', 'abandon'].includes(strategy), `${kind} 缺策略`);
  }
});

test('P06 §12.6: 没有失败记录时不产生任何批次', () => {
  const plan = planLayoutRepair({ failures: [], maps: [mapOf()] });
  assert.deepEqual(plan.batches, []);
  assert.deepEqual(plan.failed, []);
  assert.deepEqual(plan.issues, []);
});
