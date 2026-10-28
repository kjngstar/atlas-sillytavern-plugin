/**
 * atlas-world-build-contract.test.mjs — P01 世界建设任务契约解码断言。
 *
 * 覆盖：job / target / ticket 正常解码；未知 version、非法枚举、错字段类型、
 * 缺失可空字段、依赖自环、空批次票据一律拒绝并报出具体路径；
 * 窗口序号不变式；票据失效判定；稳定身份派生不随输入顺序变化。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeWorldBuildJob,
  decodeWorldBuildTarget,
  decodeWorldBuildBatchTicket,
  isBatchTicketCurrent,
  worldBuildScopeKey,
  worldBuildTargetSubjectKey,
  worldBuildUnitSubjectKey,
  settlementPlanSubjectKey,
  worldFactSubjectKey,
  sqlStatusForJobStatus,
  sqlStatusForTargetStatus,
  countsTowardRequiredDenominator,
  isTerminalTargetStatus,
  WORLD_BUILD_JOB_PAYLOAD_KIND,
  WORLD_FACTS_SCOPE_KEY,
} from '../src/atlas-world-build-contract.ts';

/** 合法 job 夹具。测试只改想测的那个字段，避免每个用例重复 14 行。 */
function job(overrides = {}) {
  return {
    version: 1,
    id: 'job-1',
    branchId: 'branch-main',
    kind: 'initialize',
    status: 'running',
    sourceManifestHash: 'sha256:manifest',
    policyVersion: 'world-build/v1',
    originFloorId: 'floor-1',
    runEpoch: 0,
    nextWindowSequence: 2,
    committedWindowSequence: 1,
    cumulativeTransports: 5,
    cumulativeWindows: 1,
    stopReason: null,
    ...overrides,
  };
}

function target(overrides = {}) {
  return {
    version: 1,
    id: 'target-1',
    jobId: 'job-1',
    subjectId: 'loc-1',
    workKind: 'map-layout',
    requirement: 'source-required',
    depth: 2,
    dependencyIds: [],
    inputSignature: 'sig-1',
    status: 'pending',
    attempts: 0,
    failureFingerprint: null,
    lastErrorCode: null,
    originFloorId: 'floor-1',
    eventId: null,
    ...overrides,
  };
}

function ticket(overrides = {}) {
  return {
    version: 1,
    jobId: 'job-1',
    windowSequence: 1,
    unitIds: ['unit-1'],
    chatUid: 'chat-1',
    branchId: 'branch-main',
    ownerFloorId: 'floor-2',
    causalFloorId: 'floor-2',
    baseRevision: 3,
    baseStorageRevision: 3,
    sourceManifestHash: 'sha256:manifest',
    runEpoch: 0,
    inputSignature: 'sig-1',
    ...overrides,
  };
}

/** 断言解码失败，并且至少有一条 issue 的 path 命中预期（不允许「因为别的原因挂了」）。 */
function assertFails(result, expectedPath, expectedCode) {
  assert.equal(result.ok, false, '理应解码失败');
  const paths = result.issues.map((issue) => issue.path);
  assert.ok(paths.includes(expectedPath), `期望问题路径 ${expectedPath}，实际 ${paths.join(' | ')}`);
  if (expectedCode) {
    const codes = result.issues.map((issue) => issue.code);
    assert.ok(codes.includes(expectedCode), `期望问题码 ${expectedCode}，实际 ${codes.join(' | ')}`);
  }
}

/* ───────────────────────────── job ───────────────────────────── */

test('job：合法对象解码为完整契约', () => {
  const result = decodeWorldBuildJob(job());
  assert.equal(result.ok, true);
  assert.equal(result.value.id, 'job-1');
  assert.equal(result.value.kind, 'initialize');
  assert.equal(result.value.status, 'running');
  assert.equal(result.value.stopReason, null);
  assert.equal(result.value.cumulativeTransports, 5);
});

test('job：未知 version 直接拒绝，不做「尽量解析」', () => {
  assertFails(decodeWorldBuildJob(job({ version: 2 })), 'job.version', 'WORLD_BUILD_VERSION_UNSUPPORTED');
  assertFails(decodeWorldBuildJob(job({ version: '1' })), 'job.version', 'WORLD_BUILD_VERSION_UNSUPPORTED');
  const missing = job();
  delete missing.version;
  assertFails(decodeWorldBuildJob(missing), 'job.version', 'WORLD_BUILD_VERSION_MISSING');
});

test('job：非法枚举报出实际值', () => {
  const result = decodeWorldBuildJob(job({ status: 'done' }));
  assertFails(result, 'job.status', 'WORLD_BUILD_ENUM_INVALID');
  assert.match(result.issues[0].message, /pending|running|paused/);

  assertFails(decodeWorldBuildJob(job({ kind: 'bootstrap' })), 'job.kind', 'WORLD_BUILD_ENUM_INVALID');
});

test('job：计数类字段拒绝负数、小数与字符串数字', () => {
  assertFails(decodeWorldBuildJob(job({ runEpoch: -1 })), 'job.runEpoch');
  assertFails(decodeWorldBuildJob(job({ runEpoch: 1.5 })), 'job.runEpoch');
  assertFails(decodeWorldBuildJob(job({ runEpoch: '0' })), 'job.runEpoch');
  assertFails(decodeWorldBuildJob(job({ cumulativeTransports: Number.NaN })), 'job.cumulativeTransports');
});

test('job：可空字段必须显式给出 null，不能靠缺字段蒙混', () => {
  const missing = job();
  delete missing.stopReason;
  assertFails(decodeWorldBuildJob(missing), 'job.stopReason', 'WORLD_BUILD_FIELD_MISSING');
  // 显式 null 才是合法写法
  assert.equal(decodeWorldBuildJob(job({ stopReason: null })).ok, true);
});

test('job：窗口序号不变式——已提交不能超过下一个待执行', () => {
  const result = decodeWorldBuildJob(job({ committedWindowSequence: 3, nextWindowSequence: 2 }));
  assertFails(result, 'job.committedWindowSequence', 'WORLD_BUILD_SEQUENCE_INVALID');
  // 累计窗口数超过下一个序号同样说明写坏了
  assertFails(decodeWorldBuildJob(job({ cumulativeWindows: 9, nextWindowSequence: 2 })), 'job.committedWindowSequence');
});

test('job：非对象输入报形状错误而不是崩溃', () => {
  assertFails(decodeWorldBuildJob(null), 'job', 'WORLD_BUILD_SHAPE_INVALID');
  assertFails(decodeWorldBuildJob([]), 'job', 'WORLD_BUILD_SHAPE_INVALID');
  assertFails(decodeWorldBuildJob('job'), 'job', 'WORLD_BUILD_SHAPE_INVALID');
});

/* ──────────────────────────── target ──────────────────────────── */

test('target：合法对象解码，deferred-interior 与 waiting-for-entry 允许', () => {
  const result = decodeWorldBuildTarget(target({
    requirement: 'deferred-interior',
    status: 'waiting-for-entry',
    subjectId: null,
    eventId: 'evt-9',
  }));
  assert.equal(result.ok, true);
  assert.equal(result.value.requirement, 'deferred-interior');
  assert.equal(result.value.status, 'waiting-for-entry');
  assert.equal(result.value.subjectId, null);
  assert.equal(result.value.eventId, 'evt-9');
});

test('target：依赖自环被拒绝', () => {
  assertFails(
    decodeWorldBuildTarget(target({ dependencyIds: ['target-1'] })),
    'target.dependencyIds',
    'WORLD_BUILD_DEPENDENCY_SELF',
  );
});

test('target：依赖数组元素必须是非空字符串', () => {
  assertFails(decodeWorldBuildTarget(target({ dependencyIds: [''] })), 'target.dependencyIds[0]');
  assertFails(decodeWorldBuildTarget(target({ dependencyIds: [1] })), 'target.dependencyIds[0]');
  assertFails(decodeWorldBuildTarget(target({ dependencyIds: 'target-2' })), 'target.dependencyIds');
});

test('target：workKind / status / requirement 三个枚举都走白名单', () => {
  assertFails(decodeWorldBuildTarget(target({ workKind: 'layout' })), 'target.workKind', 'WORLD_BUILD_ENUM_INVALID');
  assertFails(decodeWorldBuildTarget(target({ status: 'processed' })), 'target.status', 'WORLD_BUILD_ENUM_INVALID');
  assertFails(decodeWorldBuildTarget(target({ requirement: 'must-have' })), 'target.requirement', 'WORLD_BUILD_ENUM_INVALID');
});

/* ──────────────────────────── ticket ──────────────────────────── */

test('ticket：合法票据解码，三个楼层字段各自独立', () => {
  const result = decodeWorldBuildBatchTicket(ticket({ causalFloorId: 'floor-7' }));
  assert.equal(result.ok, true);
  assert.equal(result.value.ownerFloorId, 'floor-2');
  assert.equal(result.value.causalFloorId, 'floor-7');
});

test('ticket：空批次与空字符串单元都被拒绝', () => {
  assertFails(decodeWorldBuildBatchTicket(ticket({ unitIds: [] })), 'ticket.unitIds', 'WORLD_BUILD_TICKET_EMPTY');
  assertFails(decodeWorldBuildBatchTicket(ticket({ unitIds: [''] })), 'ticket.unitIds[0]');
});

test('ticket：版本未知直接拒绝', () => {
  assertFails(decodeWorldBuildBatchTicket(ticket({ version: 3 })), 'ticket.version', 'WORLD_BUILD_VERSION_UNSUPPORTED');
});

/* ────────────────────── 票据失效判定 ────────────────────── */

test('isBatchTicketCurrent：全部一致才算有效', () => {
  const decoded = decodeWorldBuildBatchTicket(ticket());
  assert.equal(decoded.ok, true);
  const current = {
    jobId: 'job-1',
    runEpoch: 0,
    chatUid: 'chat-1',
    branchId: 'branch-main',
    ownerFloorId: 'floor-2',
    baseRevision: 3,
    baseStorageRevision: 3,
    sourceManifestHash: 'sha256:manifest',
  };
  assert.deepEqual(isBatchTicketCurrent(decoded.value, current), { current: true });
});

test('isBatchTicketCurrent：每一条失效原因都能单独触发', () => {
  const decoded = decodeWorldBuildBatchTicket(ticket());
  assert.equal(decoded.ok, true);
  const base = {
    jobId: 'job-1',
    runEpoch: 0,
    chatUid: 'chat-1',
    branchId: 'branch-main',
    ownerFloorId: 'floor-2',
    baseRevision: 3,
    baseStorageRevision: 3,
    sourceManifestHash: 'sha256:manifest',
  };
  const cases = [
    [{ ...base, jobId: 'job-2' }, 'job-mismatch'],
    [{ ...base, chatUid: 'chat-2' }, 'chat-switched'],
    [{ ...base, branchId: 'branch-other' }, 'branch-switched'],
    [{ ...base, ownerFloorId: 'floor-9' }, 'owner-floor-moved'],
    [{ ...base, baseRevision: 4 }, 'revision-moved'],
    [{ ...base, baseStorageRevision: 4 }, 'storage-revision-moved'],
    [{ ...base, sourceManifestHash: 'sha256:other' }, 'source-manifest-changed'],
    [{ ...base, runEpoch: 1 }, 'epoch-stale'],
  ];
  for (const [current, reason] of cases) {
    const verdict = isBatchTicketCurrent(decoded.value, current);
    assert.equal(verdict.current, false);
    assert.equal(verdict.reason, reason);
  }
});

/* ───────────────────── 状态映射与身份派生 ───────────────────── */

test('状态映射：逻辑状态落到既有四个 SQL status，不新增第五个', () => {
  const allowed = new Set(['pending', 'processed', 'retry', 'suspended']);
  const jobStatuses = ['pending', 'running', 'paused', 'completed', 'completed-with-issues', 'cancelled'];
  for (const status of jobStatuses) {
    assert.ok(allowed.has(sqlStatusForJobStatus(status)), `job ${status} 映射出越界值`);
  }
  const targetStatuses = ['pending', 'running', 'done', 'waiting-for-entry', 'blocked', 'failed', 'cancelled'];
  for (const status of targetStatuses) {
    assert.ok(allowed.has(sqlStatusForTargetStatus(status)), `target ${status} 映射出越界值`);
  }
});

test('状态映射：completed-with-issues 不是 completed，failed 不自动 retry', () => {
  assert.equal(sqlStatusForJobStatus('completed-with-issues'), 'processed');
  assert.notEqual(sqlStatusForJobStatus('completed-with-issues'), sqlStatusForJobStatus('cancelled'));
  // failed 已用尽纠错额度：落 suspended，重试只能由显式 retry-failed job 发起
  assert.equal(sqlStatusForTargetStatus('failed'), 'suspended');
  assert.equal(sqlStatusForTargetStatus('waiting-for-entry'), 'suspended');
});

test('分母与终态：deferred-interior 类的等待不算必建分母，也不阻塞新任务', () => {
  assert.equal(countsTowardRequiredDenominator('done'), true);
  assert.equal(countsTowardRequiredDenominator('failed'), true);
  assert.equal(countsTowardRequiredDenominator('waiting-for-entry'), false);
  assert.equal(isTerminalTargetStatus('done'), true);
  assert.equal(isTerminalTargetStatus('failed'), true);
  assert.equal(isTerminalTargetStatus('waiting-for-entry'), false);
  assert.equal(isTerminalTargetStatus('blocked'), false);
});

test('身份派生：scope/subject key 形状与 payload 标识固定', () => {
  assert.equal(worldBuildScopeKey('job-1'), 'world-build:job-1');
  assert.equal(worldBuildTargetSubjectKey('t1'), 'target:t1');
  assert.equal(worldBuildUnitSubjectKey('u1'), 'unit:u1');
  assert.equal(settlementPlanSubjectKey('town-1', 'p2'), 'settlement-plan:town-1:p2');
  assert.equal(worldFactSubjectKey('f1'), 'fact:f1');
  assert.equal(WORLD_FACTS_SCOPE_KEY, 'world-facts:v1');
  assert.equal(WORLD_BUILD_JOB_PAYLOAD_KIND, 'world-build-job/v1');
});
