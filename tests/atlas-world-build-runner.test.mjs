/**
 * atlas-world-build-runner.test.mjs — P09 §15 连续执行、停止与恢复的决策层。
 *
 * 覆盖：
 * 1. 控制面受理（start/batch/stop/retry-failed/next-window）与必填项。
 * 2. runner 票据新鲜度、每聊天唯一所有权、切聊天立即停。
 * 3. 窗口身份与触发去重（重放 ended/after-commands 不重复发请求）。
 * 4. 失败指纹与「不盲重试」上限。
 * 5. 冻结窗口设置：缺连接/缺提示词就暂停，不拿默认值硬跑。
 * 6. `nextRunnerDecision` 的分支顺序：保存中 → 去重 → 票据 → 任务 → 权限 → 暂停 → 调度 → 开窗。
 * 7. 停止幂等、不清 pending、不撤回已 ACK；刷新零发送、下一次合法更新才续建。
 * 8. 账本跨窗口累计。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_UNCHANGED_FAILURE_ATTEMPTS,
  RUNNER_TICKET_STALE_REASONS,
  agreesWithBatchTicket,
  appendWindow,
  emptyRunnerLedger,
  failureFingerprint,
  freezeWindowSettings,
  isRunnerTicketLive,
  nextRunnerDecision,
  normalizeControlRequest,
  recordFailure,
  refreshDisplayState,
  registerTrigger,
  releaseRunner,
  runnerOwnershipKey,
  shouldAutoResume,
  shouldSkipFailure,
  shouldStopOnScopeChange,
  stopBuildRun,
  summarizeRunnerLedger,
  triggerSignature,
  windowSignature,
} from '../src/atlas-world-build-runner.ts';

const BRANCH = 'main-A';
const CHAT = 'chat-A';
const FLOOR = 'turn-7';

const job = (overrides = {}) => ({
  version: 1, id: 'job-1', branchId: BRANCH, kind: 'initialize', status: 'running',
  sourceManifestHash: 'manifest-1', policyVersion: 'policy-1', originFloorId: FLOOR,
  runEpoch: 3, nextWindowSequence: 2, committedWindowSequence: 1,
  cumulativeTransports: 4, cumulativeWindows: 1, stopReason: null, ...overrides,
});

const target = (overrides = {}) => ({
  version: 1, id: 'T1', jobId: 'job-1', subjectId: 'L1', workKind: 'entity-construction',
  requirement: 'source-required', depth: 0, dependencyIds: [], inputSignature: 'sig-1',
  status: 'pending', attempts: 0, failureFingerprint: null, lastErrorCode: null,
  originFloorId: FLOOR, eventId: null, ...overrides,
});

const ticket = (overrides = {}) => ({
  version: 1, jobId: 'job-1', chatUid: CHAT, branchId: BRANCH, ownerFloorId: FLOOR,
  baseRevision: 9, baseStorageRevision: 4, sourceManifestHash: 'manifest-1',
  runEpoch: 3, windowSequence: 2, ...overrides,
});

const current = (overrides = {}) => ({
  jobId: 'job-1', chatUid: CHAT, branchId: BRANCH, ownerFloorId: FLOOR,
  baseRevision: 9, baseStorageRevision: 4, sourceManifestHash: 'manifest-1', runEpoch: 3, ...overrides,
});

const settings = () => freezeWindowSettings({
  connectionId: 'conn-1', promptHash: 'prompt-1',
  batching: { newUnitsPerRetry: 3, maxUnitsPerWindow: 1 }, requestsPerOperation: 4,
});

const decide = (overrides = {}) => nextRunnerDecision({
  ticket: ticket(), current: current(), job: job(), targets: [target()],
  ledger: emptyRunnerLedger(), settings: settings(),
  policy: { totalOperations: 64, maxNewLocations: 12, maxNewRoutes: 16 },
  sourceScanComplete: true, ...overrides,
});

// ── 1. 控制面 ───────────────────────────────────────────────────────────────

test('P09: 控制面只认五个动作，未知动作直接拒', () => {
  for (const action of ['start', 'batch', 'stop', 'retry-failed', 'next-window']) {
    const needJob = action === 'stop' || action === 'retry-failed';
    const result = normalizeControlRequest({ action, chatUid: CHAT, branchId: BRANCH, floorId: FLOOR, revision: 9, jobId: needJob ? 'job-1' : undefined });
    assert.equal(result.ok, true, `${action} 必须受理`);
  }
  assert.equal(normalizeControlRequest({ action: 'rebuild-everything', chatUid: CHAT, branchId: BRANCH, floorId: FLOOR, revision: 9 }).code, 'CONTROL_UNKNOWN_ACTION');
  assert.equal(normalizeControlRequest({ chatUid: CHAT }).code, 'CONTROL_UNKNOWN_ACTION');
});

test('P09: 控制请求必须带聊天/分支/楼层/修订，缺一项就拒', () => {
  const base = { action: 'start', chatUid: CHAT, branchId: BRANCH, floorId: FLOOR, revision: 9 };
  assert.equal(normalizeControlRequest({ ...base, chatUid: '' }).code, 'CONTROL_CHAT_REQUIRED');
  assert.equal(normalizeControlRequest({ ...base, branchId: ' ' }).code, 'CONTROL_BRANCH_REQUIRED');
  assert.equal(normalizeControlRequest({ ...base, floorId: undefined }).code, 'CONTROL_FLOOR_REQUIRED');
  assert.equal(normalizeControlRequest({ ...base, revision: undefined }).code, 'CONTROL_REVISION_REQUIRED');
  assert.equal(normalizeControlRequest({ ...base, revision: -1 }).code, 'CONTROL_REVISION_REQUIRED');
});

test('P09: stop / retry-failed 必须点名任务，不允许隐式挑一个', () => {
  assert.equal(normalizeControlRequest({ action: 'stop', chatUid: CHAT, branchId: BRANCH, floorId: FLOOR, revision: 9 }).code, 'CONTROL_JOB_REQUIRED');
  assert.equal(normalizeControlRequest({ action: 'retry-failed', chatUid: CHAT, branchId: BRANCH, floorId: FLOOR, revision: 9 }).code, 'CONTROL_JOB_REQUIRED');
  assert.equal(normalizeControlRequest({ action: 'start', chatUid: CHAT, branchId: BRANCH, floorId: FLOOR, revision: 9 }).ok, true);
});

test('P09: 只有 start/batch 会推进世界，其余是控制/读取', () => {
  const mutating = (action, jobId) => normalizeControlRequest({ action, chatUid: CHAT, branchId: BRANCH, floorId: FLOOR, revision: 9, jobId }).mutating;
  assert.equal(mutating('start'), true);
  assert.equal(mutating('batch'), true);
  assert.equal(mutating('stop', 'job-1'), false);
  assert.equal(mutating('retry-failed', 'job-1'), false);
  assert.equal(mutating('next-window'), false);
});

// ── 2. 票据与所有权 ─────────────────────────────────────────────────────────

test('P09: 票据每一项失效都能复现原因，顺序固定', () => {
  assert.deepEqual(RUNNER_TICKET_STALE_REASONS, ['job-mismatch', 'chat-switched', 'branch-switched', 'owner-floor-moved', 'revision-moved', 'storage-revision-moved', 'source-manifest-changed', 'epoch-stale']);
  const cases = [
    [{ jobId: 'job-2' }, 'job-mismatch'],
    [{ chatUid: 'chat-B' }, 'chat-switched'],
    [{ branchId: 'main-B' }, 'branch-switched'],
    [{ ownerFloorId: 'turn-8' }, 'owner-floor-moved'],
    [{ baseRevision: 10 }, 'revision-moved'],
    [{ baseStorageRevision: 5 }, 'storage-revision-moved'],
    [{ sourceManifestHash: 'manifest-2' }, 'source-manifest-changed'],
    [{ runEpoch: 4 }, 'epoch-stale'],
  ];
  for (const [override, reason] of cases) {
    const currency = isRunnerTicketLive(ticket(), current(override));
    assert.equal(currency.live, false, `${reason} 必须让票据失效`);
    assert.equal(currency.reason, reason);
  }
  assert.deepEqual(isRunnerTicketLive(ticket(), current()), { live: true, reason: null });
});

test('P09: 票据与批次票据描述同一件事，否则视为漂移', () => {
  const batch = { version: 1, jobId: 'job-1', windowSequence: 2, unitIds: ['U1'], chatUid: CHAT, branchId: BRANCH, ownerFloorId: FLOOR, causalFloorId: FLOOR, baseRevision: 9, baseStorageRevision: 4, sourceManifestHash: 'manifest-1', runEpoch: 3, inputSignature: 'sig-1' };
  assert.equal(agreesWithBatchTicket(ticket(), batch), true);
  assert.equal(agreesWithBatchTicket(ticket(), { ...batch, runEpoch: 2 }), false, 'epoch 不一致就是两套票据');
});

test('P09: 所有权按聊天，切聊天/切分支都必须先停旧 runner', () => {
  assert.equal(runnerOwnershipKey(CHAT), `world-build-runner:${CHAT}`);
  assert.notEqual(runnerOwnershipKey('chat-A'), runnerOwnershipKey('chat-B'));
  assert.equal(shouldStopOnScopeChange(ticket(), { chatUid: 'chat-B', branchId: BRANCH }), true);
  assert.equal(shouldStopOnScopeChange(ticket(), { chatUid: CHAT, branchId: 'main-B' }), true);
  assert.equal(shouldStopOnScopeChange(ticket(), { chatUid: CHAT, branchId: BRANCH }), false);
  assert.deepEqual(releaseRunner(runnerOwnershipKey(CHAT)), { ownershipKey: `world-build-runner:${CHAT}`, released: true });
});

// ── 3. 去重与失败指纹 ───────────────────────────────────────────────────────

test('P09: 同一触发重放第二次不再发请求', () => {
  const signature = triggerSignature({ chatUid: CHAT, branchId: BRANCH, floorId: FLOOR, revision: 9, jobId: 'job-1', runEpoch: 3 });
  const first = registerTrigger(emptyRunnerLedger(), signature);
  assert.equal(first.duplicate, false);
  const second = registerTrigger(first.ledger, signature);
  assert.equal(second.duplicate, true, 'SillyTavern 重放 ended/after-commands 不得重复发请求');
  assert.equal(second.ledger, first.ledger, '重复触发不该改动账本');
  const other = registerTrigger(first.ledger, triggerSignature({ chatUid: CHAT, branchId: BRANCH, floorId: FLOOR, revision: 10, jobId: 'job-1', runEpoch: 3 }));
  assert.equal(other.duplicate, false, '修订变了是新的合法触发');
});

test('P09: 窗口签名按单元集合规范化，顺序不同仍是同一窗口', () => {
  const a = windowSignature({ jobId: 'job-1', runEpoch: 3, windowSequence: 2, unitIds: ['U2', 'U1'] });
  const b = windowSignature({ jobId: 'job-1', runEpoch: 3, windowSequence: 2, unitIds: ['U1', 'U2'] });
  assert.equal(a, b);
  const c = windowSignature({ jobId: 'job-1', runEpoch: 3, windowSequence: 3, unitIds: ['U1', 'U2'] });
  assert.notEqual(a, c, '序号变了就是新窗口');
});

test('P09: 失败指纹相同的目标最多自动试两次，之后等新反馈或显式重试', () => {
  const fingerprint = failureFingerprint({ targetId: 'T1', inputSignature: 'sig-1', code: 'LAYOUT_INVALID' });
  let ledger = emptyRunnerLedger();
  assert.equal(shouldSkipFailure(ledger, fingerprint).skip, false, '没失败过不跳');
  ledger = recordFailure(ledger, fingerprint, 'fb-1', 1000);
  assert.equal(shouldSkipFailure(ledger, fingerprint, 'fb-1').skip, false);
  ledger = recordFailure(ledger, fingerprint, 'fb-1', 2000);
  assert.equal(ledger.failures[fingerprint].attempts, MAX_UNCHANGED_FAILURE_ATTEMPTS);
  assert.equal(shouldSkipFailure(ledger, fingerprint, 'fb-1').skip, true, '无新反馈且到上限就不再自动领取');
  assert.equal(shouldSkipFailure(ledger, fingerprint, 'fb-2').skip, false, '有新反馈就放行');
  const changed = recordFailure(ledger, fingerprint, 'fb-2', 3000);
  assert.equal(changed.failures[fingerprint].attempts, 1, '新反馈把计数重置，不是继续累加');
});

// ── 4. 冻结窗口设置 ─────────────────────────────────────────────────────────

test('P09: 窗口设置缺连接/缺提示词就报出来，不拿默认值硬跑', () => {
  const missingConnection = freezeWindowSettings({ connectionId: '', promptHash: 'p', requestsPerOperation: 4 });
  assert.equal(missingConnection.frozen, null);
  assert.equal(missingConnection.issues[0].code, 'WINDOW_CONNECTION_MISSING');
  const missingPrompt = freezeWindowSettings({ connectionId: 'c', promptHash: '  ', requestsPerOperation: 4 });
  assert.equal(missingPrompt.issues[0].code, 'WINDOW_PROMPT_MISSING');
  const unlimited = freezeWindowSettings({ connectionId: 'c', promptHash: 'p', requestsPerOperation: 0 });
  assert.equal(unlimited.frozen.requestsPerOperation, 0);
  assert.deepEqual(unlimited.issues, []);
  for (const invalid of [-1, 2.9, NaN]) {
    const rejected = freezeWindowSettings({ connectionId: 'c', promptHash: 'p', requestsPerOperation: invalid });
    assert.equal(rejected.frozen, null);
    assert.equal(rejected.issues[0].code, 'WINDOW_REQUESTS_INVALID');
  }
});

test('P09: 冻结后的设置在一个窗口内固定，空批配额才退回 3:1', () => {
  const frozen = freezeWindowSettings({ connectionId: 'c', promptHash: 'p', batching: {}, requestsPerOperation: 2, nowWallMs: 77 });
  assert.equal(frozen.frozen.batching.newUnitsPerRetry, 3);
  assert.equal(frozen.frozen.batching.maxUnitsPerWindow, 1);
  assert.equal(frozen.frozen.requestsPerOperation, 2);
  assert.equal(frozen.frozen.frozenAtWallMs, 77);
});

// ── 5. 决策分支 ─────────────────────────────────────────────────────────────

test('P09: 正在保存时只等 ACK，不开新窗口也不撤回已保存', () => {
  const decision = decide({ saving: true });
  assert.equal(decision.kind, 'await-save');
  assert.equal(decision.windowSequence, 2);
});

test('P09: 票据失效就结束，切聊天单独说明', () => {
  assert.equal(decide({ current: current({ runEpoch: 4 }) }).kind, 'finish');
  assert.equal(decide({ current: current({ runEpoch: 4 }) }).reason, 'ticket-stale');
  const switched = decide({ current: current({ chatUid: 'chat-B' }) });
  assert.equal(switched.reason, 'job-scope-mismatch');
  assert.match(switched.message, /不把旧世界带过来/);
});

test('P09: 没有任务、任务与票据不同世界都结束', () => {
  assert.equal(decide({ job: null }).reason, 'job-missing');
  assert.equal(decide({ job: job({ branchId: 'main-B' }) }).reason, 'job-scope-mismatch');
});

test('P09: 权限缺失与设置缺失都暂停，不空转', () => {
  const denied = decide({ preflight: { permissionOk: false } });
  assert.equal(denied.kind, 'pause');
  assert.equal(denied.code, 'RUNNER_PERMISSION_DENIED');
  const noConnection = decide({ settings: freezeWindowSettings({ connectionId: '', promptHash: 'p', requestsPerOperation: 1 }) });
  assert.equal(noConnection.kind, 'pause');
  assert.equal(noConnection.code, 'RUNNER_CONNECTION_MISSING');
});

test('P09: 已暂停的任务不会被自动恢复', () => {
  const decision = decide({ job: job({ status: 'paused', stopReason: 'stopped' }) });
  assert.equal(decision.kind, 'finish');
  assert.equal(decision.reason, 'control-requested');
  assert.match(decision.message, /stopped/);
});

test('P09: 来源扫描连续两次没有进度 → 明确暂停原因', () => {
  const decision = decide({ sourceScanComplete: false, sourceScanStalls: 2 });
  assert.equal(decision.kind, 'pause');
  assert.equal(decision.code, 'RUNNER_SOURCE_SCAN_STALLED');
});

test('P09: 所有目标完成 → 交终态，不空转一轮', () => {
  const decision = decide({ targets: [target({ status: 'done' })] });
  assert.equal(decision.kind, 'terminal');
  assert.equal(decision.status, 'completed');
});

test('P09: 只有延后内部时按必建分母收尾，并在消息里点出延后项', () => {
  const waiting = decide({ targets: [target({ status: 'waiting-for-entry' })] });
  // §10.2 第 3 条：waiting-for-entry 不计必建分母，也不阻止初始化的结束 —— 所以这里是终态，
  // 但消息必须说明「还有内部在等剧情」，不能让人以为全都建完了。
  assert.equal(waiting.kind, 'terminal');
  assert.equal(waiting.status, 'completed');
  assert.match(waiting.message, /延后到剧情进入/);
});

test('P09: 依赖已失败 → 安静结束并说清在等什么，不重做', () => {
  const dependency = decide({ targets: [target({ id: 'T1', status: 'failed' }), target({ id: 'T2', dependencyIds: ['T1'] })] });
  assert.equal(dependency.kind, 'finish');
  assert.equal(dependency.reason, 'blocked-no-work');
  assert.match(dependency.message, /依赖已失败/);
});

test('P09: 有可开工单元才发窗口，窗口身份带上 epoch 与序号', () => {
  const decision = decide();
  assert.equal(decision.kind, 'run-window');
  assert.equal(decision.windowSequence, 2);
  assert.deepEqual(decision.workKinds, ['entity-construction']);
  assert.equal(decision.units.length, 1);
  assert.equal(decision.frozen.connectionId, 'conn-1');
  assert.match(decision.signature, /job-1/);
});

test('P09: 只有建设类工作会进窗口，正文推演阶段不从这里发', () => {
  const decision = decide();
  for (const workKind of decision.workKinds) {
    assert.ok(['source-scan', 'settlement-plan', 'entity-construction', 'map-layout', 'route-reconcile', 'npc-initial-placement', 'state-reconcile'].includes(workKind), `${workKind} 必须是建设类`);
  }
});

test('P09: 重复触发在决策层就被吃掉，不开第二个窗口', () => {
  const trigger = triggerSignature({ chatUid: CHAT, branchId: BRANCH, floorId: FLOOR, revision: 9, jobId: 'job-1', runEpoch: 3 });
  const first = decide({ trigger });
  assert.equal(first.kind, 'run-window');
  const ledger = registerTrigger(emptyRunnerLedger(), trigger).ledger;
  const second = decide({ trigger, ledger });
  assert.equal(second.kind, 'finish');
  assert.equal(second.reason, 'duplicate-window');
});

test('P09: 有活干但卡在无变化失败上时结束，不盲重试', () => {
  const fingerprint = failureFingerprint({ targetId: 'T1', inputSignature: 'sig-1', code: 'LAYOUT_INVALID' });
  let ledger = emptyRunnerLedger();
  ledger = recordFailure(ledger, fingerprint, '', 1);
  ledger = recordFailure(ledger, fingerprint, '', 2);
  // T2 还 pending（所以不是终态），但依赖 T1 已失败 → 没有可开工单元，
  // 且同一失败指纹已到上限：§15.2 要求结束，而不是再跑一轮同样的请求。
  const decision = decide({ targets: [target({ id: 'T1', status: 'failed' }), target({ id: 'T2', dependencyIds: ['T1'] })], ledger });
  assert.equal(decision.kind, 'finish');
  assert.equal(decision.reason, 'unchanged-failure');
  assert.match(decision.message, /不盲重试/);
  // 显式 retry-failed 时同样的输入要能继续开工，而不是沿用旧结论。
  const retried = decide({ targets: [target({ id: 'T1', status: 'failed' })], ledger, retryFailed: true });
  assert.equal(retried.kind, 'terminal', '只有这一个必建目标且已失败 → 带问题收尾');
  assert.equal(retried.status, 'completed-with-issues');
});

test('P09: 全部必建目标失败时按带问题收尾，不报成功', () => {
  const decision = decide({ targets: [target({ status: 'failed' })] });
  assert.equal(decision.kind, 'terminal');
  assert.equal(decision.status, 'completed-with-issues');
});

// ── 6. 停止 / 刷新 / 续建 ───────────────────────────────────────────────────

test('P09: 停止幂等，不删除任务、不撤回已保存', () => {
  const first = stopBuildRun(job());
  assert.equal(first.job.status, 'paused');
  assert.equal(first.job.runEpoch, 4, '停止要让在途候选失效');
  assert.equal(first.withdrewSaved, false);
  assert.equal(first.idempotent, false);
  const second = stopBuildRun(first.job);
  assert.equal(second.idempotent, true);
  assert.equal(second.job, first.job, '重复停止不重复抬 epoch');
  assert.equal(second.job.status, 'paused', 'stop 不清 pending，也不删除世界');
});

test('P09: 刷新与手动打开永远零发送，只有合法更新才续建', () => {
  assert.equal(shouldAutoResume('refresh', job()).resume, false);
  assert.equal(shouldAutoResume('manual-open', job()).resume, false);
  assert.equal(shouldAutoResume('allowed-map-update', job()).resume, true);
  assert.equal(shouldAutoResume('foreground-turn', job()).resume, true);
  assert.equal(shouldAutoResume('allowed-map-update', job({ status: 'completed' })).resume, false);
  assert.equal(shouldAutoResume('allowed-map-update', job({ status: 'paused' })).resume, false, '暂停的要显式重试');
  assert.equal(shouldAutoResume('allowed-map-update', null).resume, false);
});

test('P09: 刷新展示把旧 running 说成等待下次触发，且 autoFetch 恒 false', () => {
  const running = refreshDisplayState(job({ status: 'running' }));
  assert.equal(running.autoFetch, false);
  assert.equal(running.waitingForTrigger, true);
  assert.match(running.label, /等待下一次合法世界更新/);
  assert.equal(refreshDisplayState(null).autoFetch, false);
  for (const status of ['pending', 'running', 'paused', 'completed', 'completed-with-issues', 'cancelled']) {
    assert.equal(refreshDisplayState(job({ status })).autoFetch, false, `${status} 的展示层都不许发请求`);
  }
});

// ── 7. 账本 ─────────────────────────────────────────────────────────────────

test('P09: 请求账本跨窗口累计，不是每个窗口从零', () => {
  let ledger = emptyRunnerLedger();
  ledger = appendWindow(ledger, { windowId: 'w1', windowSequence: 1, runEpoch: 3, workKinds: ['entity-construction'], unitCount: 2, sends: { operation: 3, extra: 1 }, saved: true, skippedReason: null, failureFingerprint: null, startedWallMs: 1 });
  ledger = appendWindow(ledger, { windowId: 'w2', windowSequence: 2, runEpoch: 3, workKinds: ['map-layout'], unitCount: 1, sends: { operation: 2, extra: 0 }, saved: true, skippedReason: null, failureFingerprint: null, startedWallMs: 2 });
  ledger = appendWindow(ledger, { windowId: 'w3', windowSequence: 3, runEpoch: 3, workKinds: [], unitCount: 0, sends: { operation: 0, extra: 0 }, saved: false, skippedReason: 'blocked-no-work', failureFingerprint: null, startedWallMs: 3 });
  const summary = summarizeRunnerLedger(ledger);
  assert.equal(summary.windows, 3);
  assert.equal(summary.savedWindows, 2);
  assert.equal(summary.skippedWindows, 1);
  assert.equal(summary.units, 3);
  assert.deepEqual(summary.requests, { operation: 5, extra: 1, total: 6 }, '账本要能核对总请求');
});

test('P09: 空账本的汇总必须是零，而不是 undefined', () => {
  assert.deepEqual(summarizeRunnerLedger(emptyRunnerLedger()), { windows: 0, savedWindows: 0, skippedWindows: 0, units: 0, requests: { operation: 0, extra: 0, total: 0 }, failedFingerprints: 0 });
});

test('P09: 没 ACK 的窗口不算保存，也不推进进度', () => {
  const ledger = appendWindow(emptyRunnerLedger(), { windowId: 'w1', windowSequence: 1, runEpoch: 3, workKinds: ['map-layout'], unitCount: 1, sends: { operation: 1, extra: 0 }, saved: false, skippedReason: null, failureFingerprint: null, startedWallMs: 1 });
  assert.equal(summarizeRunnerLedger(ledger).savedWindows, 0);
});
