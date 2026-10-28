/**
 * atlas-world-build-scheduler.test.mjs — P04 持久任务、依赖与失败隔离。
 *
 * 覆盖 §10.1 调度层次（层级推进 / 初始化优先 / 3 新 : 1 重试复用）、§10.2 完成与失败
 * （失败不自动复活、waiting-for-entry 不阻塞结束、带问题完成）、§10.3 有界扫描与签名口径。
 *
 * 全部走纯函数：不写库、不调模型。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILD_BLOCKED_CODES,
  WORLD_BUILD_SCAN_PAGE_SIZE,
  buildWorldBuildCoverage,
  countBuildTargets,
  nextJobStatus,
  planWorldBuildMutation,
  readWorldBuildTargetsPage,
  selectNextBuildUnits,
  worldBuildTargetInputSignature,
} from '../src/atlas-world-build-state.ts';
import { UNIT_TARGET_LIMIT } from '../src/atlas-construction-progress.ts';
import { checkCoverageInvariant } from '../src/atlas-world-contract.ts';

const CTX = { branchId: 'B1', turnId: 'TURN_2', opId: 'op_world_build' };

function job(overrides = {}) {
  return {
    version: 1,
    id: 'J1',
    branchId: 'B1',
    kind: 'initialize',
    status: 'running',
    sourceManifestHash: 'manifest_1',
    policyVersion: 'policy_1',
    originFloorId: 'TURN_1',
    runEpoch: 1,
    nextWindowSequence: 1,
    committedWindowSequence: 0,
    cumulativeTransports: 0,
    cumulativeWindows: 0,
    stopReason: null,
    ...overrides,
  };
}

function target(overrides = {}) {
  return {
    version: 1,
    id: 'T1',
    jobId: 'J1',
    subjectId: 'L1',
    workKind: 'entity-construction',
    requirement: 'source-required',
    depth: 0,
    dependencyIds: [],
    inputSignature: 'sig_1',
    status: 'pending',
    attempts: 0,
    failureFingerprint: null,
    lastErrorCode: null,
    originFloorId: 'TURN_1',
    eventId: null,
    ...overrides,
  };
}

const POLICY = { totalOperations: 64, maxNewLocations: 12, maxNewRoutes: 16 };

const scheduleOf = (overrides = {}) => selectNextBuildUnits({
  job: job(),
  targets: [],
  sourceScanComplete: true,
  policy: POLICY,
  branchId: 'B1',
  currentFloorId: 'TURN_2',
  limit: 1,
  schedulerSeq: 0,
  ...overrides,
});

const coverageOf = (targets, overrides = {}) => buildWorldBuildCoverage({
  job: job(),
  targets,
  sourceScanComplete: true,
  settlementPlansExpanded: true,
  maps: { registered: 3, ready: 2 },
  ...overrides,
});

// ---------------------------------------------------------------------------
// §10.1 调度层次
// ---------------------------------------------------------------------------

test('P04 §10.1: 来源发现优先于实体建设', () => {
  const schedule = scheduleOf({
    sourceScanComplete: false,
    targets: [
      target({ id: 'T_ENTITY', workKind: 'entity-construction' }),
      target({ id: 'T_SCAN', workKind: 'source-scan' }),
    ],
  });
  assert.deepEqual(schedule.selected.flatMap((unit) => unit.targetIds), ['T_SCAN']);
});

test('P04 §10.1: 层内按工作类别推进（设施方案先于实体建设）', () => {
  const schedule = scheduleOf({
    targets: [
      target({ id: 'T_ENTITY', workKind: 'entity-construction' }),
      target({ id: 'T_PLAN', workKind: 'settlement-plan' }),
    ],
  });
  assert.deepEqual(schedule.selected.flatMap((unit) => unit.targetIds), ['T_PLAN']);
});

test('P04 §10.1: 父层没做完，子层不抢跑', () => {
  const schedule = scheduleOf({
    targets: [
      target({ id: 'T_PARENT', workKind: 'entity-construction', depth: 0 }),
      target({ id: 'T_CHILD', workKind: 'map-layout', depth: 1, dependencyIds: ['T_PARENT'] }),
    ],
  });
  assert.deepEqual(schedule.selected.flatMap((unit) => unit.targetIds), ['T_PARENT']);
  const blocked = schedule.blocked.find((item) => item.targetId === 'T_CHILD');
  assert.equal(blocked.code, 'DEPENDENCY_NOT_DONE');
  assert.equal(blocked.dependencyId, 'T_PARENT');
});

test('P04 §10.1: 初始化进行中，增量工作让路', () => {
  const schedule = scheduleOf({
    job: job({ id: 'J2', kind: 'lore-incremental' }),
    otherJobs: [job({ id: 'J1', kind: 'initialize', status: 'running' })],
    targets: [target({ id: 'T1', jobId: 'J2' })],
  });
  assert.deepEqual(schedule.selected, []);
  const barrier = schedule.blocked[0];
  assert.equal(barrier.code, 'INITIALIZATION_PRIORITY');
  assert.equal(barrier.dependencyId, 'J1', '屏障要带上是哪个 job 挡着');
});

test('P04 §10.1: 初始化结束后屏障释放', () => {
  const schedule = scheduleOf({
    job: job({ id: 'J2', kind: 'lore-incremental' }),
    otherJobs: [job({ id: 'J1', kind: 'initialize', status: 'completed' })],
    targets: [target({ id: 'T1', jobId: 'J2' })],
  });
  assert.deepEqual(schedule.selected.flatMap((unit) => unit.targetIds), ['T1']);
});

test('P04 §10.1: 公平轮转复用 3 新 : 1 重试（重试不会被饿死）', () => {
  const fresh = [0, 1, 2].map((index) => target({ id: `T_NEW_${index}`, attempts: 0, status: 'pending' }));
  const retry = [target({ id: 'T_RETRY', attempts: 2, status: 'pending' })];
  const targets = [...fresh, ...retry];

  const slot0 = scheduleOf({ targets, limit: 1, schedulerSeq: 0 });
  assert.equal(slot0.selected[0].targetIds[0], 'T_NEW_0');

  // 第 4 个位置（slot=3）该轮到重试。
  const slot3 = scheduleOf({ targets, limit: 1, schedulerSeq: 3 });
  assert.equal(slot3.selected[0].targetIds[0], 'T_RETRY');
  assert.equal(slot3.selected[0].status, 'retry');
});

test('P04 §10.1: 单元装得下的目标数受 UNIT_TARGET_LIMIT 约束', () => {
  const targets = Array.from({ length: UNIT_TARGET_LIMIT + 5 }, (_, index) => target({
    id: `T_${String(index).padStart(3, '0')}`,
  }));
  const schedule = scheduleOf({ targets, limit: 1 });
  assert.equal(schedule.selected.length, 1);
  assert.ok(schedule.selected[0].targetIds.length <= UNIT_TARGET_LIMIT);
});

test('P04 §10.1: limit 控制本窗口单元数，超出的显式延期', () => {
  // 一个单元最多装 UNIT_TARGET_LIMIT 个目标：目标数要超过这个量级，limit 才看得出来。
  const targets = Array.from({ length: UNIT_TARGET_LIMIT * 2 + 2 }, (_, index) => target({
    id: `T_${String(index).padStart(4, '0')}`,
  }));
  const schedule = scheduleOf({ targets, limit: 2, policy: { ...POLICY, totalOperations: 1000 } });
  assert.equal(schedule.selected.length, 2, 'limit=2 → 两个单元');
  assert.equal(schedule.selected[0].targetIds.length, UNIT_TARGET_LIMIT);
  assert.equal(schedule.selected[1].targetIds.length, UNIT_TARGET_LIMIT);
  assert.equal(schedule.selected[0].targetIds[0] !== schedule.selected[1].targetIds[0], true, '两个单元不能是同一批目标');

  const planned = schedule.selected.flatMap((unit) => unit.targetIds);
  assert.equal(new Set(planned).size, planned.length, '同一目标不能同时进两个单元');
  const deferred = schedule.blocked.filter((item) => item.code === 'BUDGET_DEFERRED');
  assert.equal(deferred.length, targets.length - planned.length);
  assert.ok(deferred.length > 0, '装不下的目标不能静默消失');
});

test('P04 §10.1: 目标数不超过单元容量时，一个单元装完（不为了凑 limit 拆批）', () => {
  const targets = Array.from({ length: 10 }, (_, index) => target({ id: `T_${String(index).padStart(3, '0')}` }));
  const schedule = scheduleOf({ targets, limit: 2 });
  assert.equal(schedule.selected.length, 1, '10 个目标一个单元就够，不该拆成两批');
  assert.equal(schedule.selected[0].targetIds.length, 10);
  assert.equal(schedule.blocked.length, 0);
});

test('P04 §10.1: 预算为 0 时什么都不选，且目标全部显式延期', () => {
  const schedule = scheduleOf({ targets: [target({ id: 'T1' })], policy: { ...POLICY, totalOperations: 0 } });
  assert.deepEqual(schedule.selected, []);
  assert.equal(schedule.blocked.length, 1);
  assert.equal(schedule.blocked[0].code, 'BUDGET_DEFERRED');
});

test('P04 §10.1: 同一输入反复调度得到同一个单元 ID（不靠换 ID 假装新任务）', () => {
  const targets = [target({ id: 'T1' })];
  const first = scheduleOf({ targets, schedulerSeq: 0 });
  const second = scheduleOf({ targets, schedulerSeq: 0 });
  assert.equal(first.selected[0].unitId, second.selected[0].unitId);
  assert.equal(first.selected[0].unitId, 'world-build:J1:entity-construction:T1');
});

// ---------------------------------------------------------------------------
// §10.2 完成与失败
// ---------------------------------------------------------------------------

test('P04 §10.2: 已失败目标不会被普通 job 自动复活', () => {
  const schedule = scheduleOf({ targets: [target({ id: 'T1', status: 'failed', attempts: 3 })] });
  assert.deepEqual(schedule.selected, []);
  assert.equal(schedule.blocked.length, 0, '失败是终态，不该刷成阻塞噪声');
});

test('P04 §10.2: retry-failed job 明确重试时才重新激活失败目标', () => {
  const schedule = scheduleOf({
    job: job({ kind: 'retry-failed' }),
    targets: [target({ id: 'T1', status: 'failed', attempts: 3 })],
  });
  assert.deepEqual(schedule.selected.flatMap((unit) => unit.targetIds), ['T1']);
  assert.equal(schedule.selected[0].status, 'retry');
});

test('P04 §10.2: 依赖失败时下游 blocked，原因带 dependencyId', () => {
  const schedule = scheduleOf({
    targets: [
      target({ id: 'T_FAIL', status: 'failed' }),
      target({ id: 'T_DOWN', workKind: 'map-layout', dependencyIds: ['T_FAIL'] }),
    ],
  });
  const blocked = schedule.blocked.find((item) => item.targetId === 'T_DOWN');
  assert.equal(blocked.code, 'DEPENDENCY_FAILED');
  assert.equal(blocked.dependencyId, 'T_FAIL');
});

test('P04 §10.2: waiting-for-entry 不阻塞结束、不算失败、也不会被选中', () => {
  const targets = [target({ id: 'T1', status: 'waiting-for-entry', requirement: 'deferred-interior' })];
  const schedule = scheduleOf({ targets });
  assert.deepEqual(schedule.selected, []);
  assert.equal(schedule.terminal, true, '待进入不阻止初始化结束');
  assert.equal(schedule.blocked[0].code, 'WAITING_FOR_ENTRY');

  const coverage = coverageOf(targets);
  assert.equal(coverage.requiredTargets, 0, '待进入不进必建分母');
  assert.equal(coverage.deferredInteriors, 1);
});

test('P04 §10.2: 依赖待进入时下游跟着等', () => {
  const schedule = scheduleOf({
    targets: [
      target({ id: 'T_ROOM', status: 'waiting-for-entry' }),
      target({ id: 'T_DOWN', workKind: 'map-layout', dependencyIds: ['T_ROOM'] }),
    ],
  });
  const blocked = schedule.blocked.find((item) => item.targetId === 'T_DOWN');
  assert.equal(blocked.code, 'DEPENDENCY_WAITING_FOR_ENTRY');
});

test('P04 §10.2: 全部完成时 terminal=true，还有在途时 terminal=false', () => {
  assert.equal(scheduleOf({ targets: [target({ status: 'done' })] }).terminal, true);
  assert.equal(scheduleOf({ targets: [target({ status: 'pending' })] }).terminal, false);
  assert.equal(scheduleOf({ targets: [target({ status: 'running' })] }).terminal, false);
});

test('P04 §10.2: 剩余只有失败/阻塞 → completed-with-issues 并说明原因', () => {
  const targets = [target({ id: 'T1', status: 'done' }), target({ id: 'T2', status: 'failed' })];
  const plan = planWorldBuildMutation({
    job: job(),
    targets,
    coverage: { sourceScanComplete: true, issues: [], version: 1 },
    settlementPlansExpanded: true,
    maps: { registered: 1, ready: 1 },
    ctx: CTX,
  });
  assert.equal(plan.job.status, 'completed-with-issues');
  assert.equal(plan.coverage.completedWithIssues, true);
  assert.ok(String(plan.job.stopReason).includes('失败'));
});

test('P04 §10.2: 干净完成 → completed；还有在途 → running', () => {
  const done = planWorldBuildMutation({
    job: job(),
    targets: [target({ status: 'done' })],
    coverage: { version: 1, sourceScanComplete: true, issues: [] },
    settlementPlansExpanded: true,
    maps: { registered: 1, ready: 1 },
    ctx: CTX,
  });
  assert.equal(done.job.status, 'completed');

  const running = coverageOf([target({ status: 'pending' })]);
  assert.equal(nextJobStatus(job(), running), 'running');
});

test('P04 §10.2: 暂停的 job 不会因为一次调度被拉起来；cancelled 是终局', () => {
  const paused = coverageOf([target({ status: 'pending' })]);
  assert.equal(nextJobStatus(job({ status: 'paused' }), paused), 'paused');
  const cancelled = coverageOf([target({ status: 'done' })]);
  assert.equal(nextJobStatus(job({ status: 'cancelled' }), cancelled), 'cancelled');
});

// ---------------------------------------------------------------------------
// §10.2 覆盖不变式
// ---------------------------------------------------------------------------

test('P04 §10.2: 必建四态之和等于分母，覆盖不变式成立', () => {
  const targets = [
    target({ id: 'T1', status: 'done' }),
    target({ id: 'T2', status: 'pending' }),
    target({ id: 'T3', status: 'failed' }),
    target({ id: 'T4', status: 'blocked' }),
    target({ id: 'T5', status: 'waiting-for-entry' }),
    target({ id: 'T6', status: 'cancelled' }),
  ];
  const counts = countBuildTargets(targets);
  assert.equal(counts.requiredTargets, 4);
  assert.equal(counts.requiredDone + counts.requiredPending + counts.requiredFailed + counts.requiredBlocked, counts.requiredTargets);

  const coverage = coverageOf(targets);
  assert.equal(checkCoverageInvariant(coverage), null, '不变式必须通过');
  assert.equal(coverage.requiredTargets, 4);
  assert.equal(coverage.cancelled, undefined, '取消的目标不进覆盖结构');
});

test('P04 §10.2: readyMaps 不会超过 registeredMaps', () => {
  const coverage = coverageOf([target({ status: 'done' })], { maps: { registered: 2, ready: 9 } });
  assert.equal(coverage.readyMaps, 2);
  assert.equal(checkCoverageInvariant(coverage), null);
});

test('P04 §10.2: scopeSealed 要来源扫描、设施方案与发现三者同时成立', () => {
  const targets = [target({ status: 'done' })];
  const sealed = coverageOf(targets);
  assert.equal(sealed.scopeSealed, true);

  assert.equal(coverageOf(targets, { sourceScanComplete: false }).scopeSealed, false);
  assert.equal(coverageOf(targets, { settlementPlansExpanded: false }).scopeSealed, false);
  assert.equal(coverageOf([...targets, target({ id: 'T_SCAN', workKind: 'source-scan', status: 'pending' })]).scopeSealed, false);
});

test('P04 §10.2: 关掉来源扫描不能同时把 sourceScanComplete 报成 true', () => {
  const coverage = coverageOf([target({ status: 'done' })], { sourceScanComplete: false });
  assert.equal(coverage.sourceScanComplete, false);
  assert.equal(coverage.scopeSealed, false);
});

// ---------------------------------------------------------------------------
// §10 写入计划：幂等与记账语义
// ---------------------------------------------------------------------------

test('P04: 相同发现重复规划不产生新行版本（刷新不该重发）', () => {
  const discovered = [target({ id: 'T1', status: 'pending' })];
  const first = planWorldBuildMutation({
    job: job(),
    targets: [],
    discoveredTargets: discovered,
    coverage: { version: 1, sourceScanComplete: true, issues: [] },
    settlementPlansExpanded: true,
    maps: { registered: 1, ready: 0 },
    ctx: CTX,
  });
  const group = first.groups[0];
  assert.ok(group);
  assert.equal(group.purpose, 'bookkeeping', '程序记账组，不是世界业务变化');
  assert.equal(group.mutations.length, 2, '首次必须同时保存缺失的 job 与发现的 target');
  assert.ok(group.mutations.every(mutation=>mutation.table==='construction_progress'));
  assert.deepEqual(group.mutations.map(mutation=>JSON.parse(mutation.after.payload_json).payloadKind).sort(),['world-build-job/v1','world-build-target/v1']);

  // 第二次：库里的行已经与发现结果一致 → 不再写。
  const beforeRows = new Map(group.mutations.map(mutation=>[mutation.rowId,mutation.after]));
  const second = planWorldBuildMutation({
    job: job(),
    targets: discovered,
    discoveredTargets: discovered,
    coverage: { version: 1, sourceScanComplete: true, issues: [] },
    settlementPlansExpanded: true,
    maps: { registered: 1, ready: 0 },
    ctx: CTX,
    beforeRows,
  });
  assert.deepEqual(second.groups, [], '同签名同状态不重写');
});

test('P04: readSet 带上 row_rev，供乐观并发判定', () => {
  const plan = planWorldBuildMutation({
    job: job(),
    targets: [],
    discoveredTargets: [target({ id: 'T1' })],
    coverage: { version: 1, sourceScanComplete: true, issues: [] },
    settlementPlansExpanded: true,
    maps: { registered: 1, ready: 0 },
    ctx: CTX,
    beforeRows: new Map([['x', { row_rev: 7 }]]),
  });
  const group = plan.groups[0];
  assert.equal(group.readSet[0].table, 'construction_progress');
  assert.equal(group.readSet[0].rowRev, 0, '没给 before 行时按新增处理');
});

test('P04: job 状态变化会写一条 job 行；状态没变就不写', () => {
  const changed = planWorldBuildMutation({
    job: job({ status: 'running' }),
    targets: [target({ status: 'done' })],
    coverage: { version: 1, sourceScanComplete: true, issues: [] },
    settlementPlansExpanded: true,
    maps: { registered: 1, ready: 1 },
    ctx: CTX,
  });
  assert.equal(changed.job.status, 'completed');
  assert.equal(changed.groups[0].mutations.filter((item) => item.after?.kind === 'scope').length, 1);
});

// ---------------------------------------------------------------------------
// §10.3 有界扫描不是全局截断
// ---------------------------------------------------------------------------

test('P04 §10.3: 1200 条目标分页扫完不重不漏', () => {
  const targets = Array.from({ length: 1200 }, (_, index) => target({ id: `T_${String(index).padStart(5, '0')}` }));
  const seen = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const page = readWorldBuildTargetsPage(targets, cursor, WORLD_BUILD_SCAN_PAGE_SIZE);
    seen.push(...page.targets.map((item) => item.id));
    pages += 1;
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
    assert.ok(pages < 20, '分页必须收敛');
  }
  assert.equal(pages, 6, '1200 / 200 = 6 页');
  assert.equal(seen.length, 1200);
  assert.equal(new Set(seen).size, 1200, '不许重复');
  assert.deepEqual(seen, targets.map((item) => item.id).sort());
});

test('P04 §10.3: 一页读完不等于世界结束', () => {
  const targets = Array.from({ length: 450 }, (_, index) => target({ id: `T_${String(index).padStart(4, '0')}` }));
  const page = readWorldBuildTargetsPage(targets, null, 200);
  assert.equal(page.targets.length, 200);
  assert.equal(page.pageExhausted, false);
  assert.equal(page.remainingAfter, 250, '还有多少没扫必须能报出来');
  assert.equal(page.nextCursor, page.targets[199].id);
});

test('P04 §10.3: 游标到末尾后返回空页，不会从头重读', () => {
  const targets = [target({ id: 'T1' }), target({ id: 'T2' })];
  const page = readWorldBuildTargetsPage(targets, 'T2', 200);
  assert.deepEqual(page.targets, []);
  assert.equal(page.nextCursor, null);
  assert.equal(page.pageExhausted, true);
});

test('P04 §10.3: 页大小非法时有界收敛，不退化成「读全表」', () => {
  const targets = Array.from({ length: 500 }, (_, index) => target({ id: `T_${String(index).padStart(4, '0')}` }));
  for (const size of [0, -5, 0.4]) {
    const page = readWorldBuildTargetsPage(targets, null, size);
    assert.equal(page.targets.length, 1, `pageSize=${size} 应收敛到 1`);
    assert.equal(page.remainingAfter, 499);
  }
  // NaN 不是「要 0 条」，是「没给合法值」：退回默认页大小，仍然有界。
  const fallback = readWorldBuildTargetsPage(targets, null, Number.NaN);
  assert.equal(fallback.targets.length, WORLD_BUILD_SCAN_PAGE_SIZE);
  assert.equal(fallback.pageExhausted, false);
});

// ---------------------------------------------------------------------------
// §10.3 签名口径
// ---------------------------------------------------------------------------

const SIGNATURE_BASE = {
  subjectId: 'L1',
  workKind: 'entity-construction',
  requirement: 'source-required',
  depth: 1,
  dependencyIds: ['T_A', 'T_B'],
  sourceHashes: ['h2', 'h1'],
  settlementPlanVersion: 'plan_1',
  eventId: null,
};

test('P04 §10.3: 签名与依赖/hash 顺序无关，同一输入恒等', () => {
  const base = worldBuildTargetInputSignature(SIGNATURE_BASE);
  assert.equal(base, worldBuildTargetInputSignature({ ...SIGNATURE_BASE, dependencyIds: ['T_B', 'T_A'], sourceHashes: ['h1', 'h2'] }));
});

test('P04 §10.3: 来源 hash 变化会让相关目标失效', () => {
  const base = worldBuildTargetInputSignature(SIGNATURE_BASE);
  assert.notEqual(base, worldBuildTargetInputSignature({ ...SIGNATURE_BASE, sourceHashes: ['h1', 'h3'] }));
});

test('P04 §10.3: 设施方案版本与真实事件参与签名，进度不参与', () => {
  const base = worldBuildTargetInputSignature(SIGNATURE_BASE);
  assert.notEqual(base, worldBuildTargetInputSignature({ ...SIGNATURE_BASE, settlementPlanVersion: 'plan_2' }));
  assert.notEqual(base, worldBuildTargetInputSignature({ ...SIGNATURE_BASE, eventId: 'EV_BURN' }));
  // 进度类字段根本不在签名输入里：多传也不会影响结果。
  assert.equal(base, worldBuildTargetInputSignature({ ...SIGNATURE_BASE, attempts: 9, status: 'failed', rowRev: 42 }));
});

test('P04 §10.3: 阻塞码都在白名单内', () => {
  const schedule = scheduleOf({
    targets: [
      target({ id: 'T_WAIT', status: 'waiting-for-entry' }),
      target({ id: 'T_DEP', dependencyIds: ['T_WAIT'] }),
      target({ id: 'T_FAIL', status: 'failed' }),
      target({ id: 'T_DOWN', dependencyIds: ['T_FAIL'] }),
    ],
  });
  for (const item of schedule.blocked) {
    assert.ok(BUILD_BLOCKED_CODES.includes(item.code), `阻塞码越界：${item.code}`);
    assert.equal(typeof item.message, 'string');
    assert.ok(item.message.length > 0);
  }
});
