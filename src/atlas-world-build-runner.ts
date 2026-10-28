/**
 * atlas-world-build-runner.ts — P09 §15 自动连续执行、停止与恢复的**决策层**。
 *
 * 这里只有「该不该开下一个窗口、开哪个、什么时候停」的判断，不做 I/O、不写库、不调模型：
 * - 控制面归一（start / batch / stop / retry-failed / next-window）；
 * - runner 票据与每聊天唯一所有权；
 * - 窗口身份、触发去重、失败指纹与「不盲重试」；
 * - 冻结窗口设置（connection / prompt / batching / requestsPerOperation）；
 * - 决策函数 `nextRunnerDecision`：把 §15.2 的伪代码变成可断言的分支；
 * - 账本汇总：请求账本跨窗口累计，不让「每个新窗口从零」；
 * - 刷新/恢复语义：刷新只读进度、下一次合法更新才续建。
 *
 * 明确不做：这里不实现路由、不实现宿主保存。控制面请求的**受理**在
 * `normalizeControlRequest`，实际执行仍要落到既有 prepare/AtomicGroup/SaveAck 链上。
 */

import {
  type WorldBuildJobV1,
  type WorldBuildJobStatus,
  type WorldBuildTargetV1,
  type WorldBuildWorkKind,
  type WorldBuildBatchTicketV1,
} from './atlas-world-build-contract.ts';
import {
  countBuildTargets,
  selectNextBuildUnits,
  type BuildBlockedCode,
  type BuildUnitV1,
} from './atlas-world-build-state.ts';

/* ------------------------------------------------------------------ *
 * §15.1 固定控制面
 * ------------------------------------------------------------------ */

export const WORLD_BUILD_CONTROL_ACTIONS = ['start', 'batch', 'stop', 'retry-failed', 'next-window'] as const;
export type WorldBuildControlAction = (typeof WORLD_BUILD_CONTROL_ACTIONS)[number];

/** 只有前两个会真的推进世界；后三个是控制/读取。 */
export const WORLD_BUILD_MUTATING_ACTIONS: readonly WorldBuildControlAction[] = ['start', 'batch'];

export type ControlScopeV1 = {
  action: WorldBuildControlAction;
  chatUid: string;
  branchId: string;
  /** 当前有效剧情楼层：票据不授权跨楼层提交。 */
  floorId: string;
  revision: number;
  storageRevision: number;
  /** 可选：显式绑定某个 job（retry-failed / stop 通常要带）。 */
  jobId: string | null;
};

export type ControlRejectionCode =
  | 'CONTROL_UNKNOWN_ACTION'
  | 'CONTROL_CHAT_REQUIRED'
  | 'CONTROL_BRANCH_REQUIRED'
  | 'CONTROL_FLOOR_REQUIRED'
  | 'CONTROL_REVISION_REQUIRED'
  | 'CONTROL_JOB_REQUIRED';

export type ControlRequestResult =
  | { ok: true; scope: ControlScopeV1; mutating: boolean }
  | { ok: false; code: ControlRejectionCode; message: string };

const CONTROL_ACTION_SET = new Set<string>(WORLD_BUILD_CONTROL_ACTIONS);

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 受理一个控制面请求。**不是模型语义 op**：只校验身份与必填项，
 * 供应商凭据一律不从这里进来（凭据只取现有连接设置）。
 */
export function normalizeControlRequest(input: Record<string, unknown> | null | undefined): ControlRequestResult {
  const action = text(input?.action);
  if (!CONTROL_ACTION_SET.has(action)) {
    return { ok: false, code: 'CONTROL_UNKNOWN_ACTION', message: `未知的建设控制动作 ${action || '（空）'}` };
  }
  const chatUid = text(input?.chatUid);
  if (!chatUid) return { ok: false, code: 'CONTROL_CHAT_REQUIRED', message: '控制请求必须绑定聊天' };
  const branchId = text(input?.branchId);
  if (!branchId) return { ok: false, code: 'CONTROL_BRANCH_REQUIRED', message: '控制请求必须绑定分支' };
  const floorId = text(input?.floorId);
  if (!floorId) return { ok: false, code: 'CONTROL_FLOOR_REQUIRED', message: '控制请求必须带当前有效楼层' };
  const revision = Number(input?.revision);
  if (!Number.isFinite(revision) || revision < 0) {
    return { ok: false, code: 'CONTROL_REVISION_REQUIRED', message: '控制请求必须带当前修订号' };
  }
  const storageRevisionRaw = Number(input?.storageRevision);
  const storageRevision = Number.isFinite(storageRevisionRaw) && storageRevisionRaw >= 0 ? storageRevisionRaw : revision;
  const jobId = text(input?.jobId) || null;
  const normalized = action as WorldBuildControlAction;
  if ((normalized === 'stop' || normalized === 'retry-failed') && !jobId) {
    return { ok: false, code: 'CONTROL_JOB_REQUIRED', message: `${normalized} 必须指定任务，不允许隐式挑一个` };
  }
  return {
    ok: true,
    mutating: WORLD_BUILD_MUTATING_ACTIONS.includes(normalized),
    scope: { action: normalized, chatUid, branchId, floorId, revision, storageRevision, jobId },
  };
}

/* ------------------------------------------------------------------ *
 * §15.5 每聊天唯一所有权 + 票据
 * ------------------------------------------------------------------ */

/** 所有权键按聊天，不按分支：同一聊天切分支也必须先把旧 runner 停掉。 */
export function runnerOwnershipKey(chatUid: string): string {
  return `world-build-runner:${text(chatUid)}`;
}

export type RunnerTicketV1 = {
  version: 1;
  jobId: string;
  chatUid: string;
  branchId: string;
  ownerFloorId: string;
  baseRevision: number;
  baseStorageRevision: number;
  sourceManifestHash: string;
  runEpoch: number;
  windowSequence: number;
};

export const RUNNER_TICKET_STALE_REASONS = [
  'job-mismatch',
  'chat-switched',
  'branch-switched',
  'owner-floor-moved',
  'revision-moved',
  'storage-revision-moved',
  'source-manifest-changed',
  'epoch-stale',
] as const;
export type RunnerTicketStaleReason = (typeof RUNNER_TICKET_STALE_REASONS)[number];

export type RunnerTicketCurrency = { live: boolean; reason: RunnerTicketStaleReason | null };

/**
 * 票据是否仍然有效。**顺序固定**（与 `isBatchTicketCurrent` 同一套比较轴）：
 * 先身份、再位置、再修订、最后 epoch —— 这样失效原因永远可复现。
 */
export function isRunnerTicketLive(ticket: RunnerTicketV1, current: Omit<RunnerTicketV1, 'version' | 'windowSequence'>): RunnerTicketCurrency {
  if (ticket.jobId !== current.jobId) return { live: false, reason: 'job-mismatch' };
  if (ticket.chatUid !== current.chatUid) return { live: false, reason: 'chat-switched' };
  if (ticket.branchId !== current.branchId) return { live: false, reason: 'branch-switched' };
  if (ticket.ownerFloorId !== current.ownerFloorId) return { live: false, reason: 'owner-floor-moved' };
  if (ticket.baseRevision !== current.baseRevision) return { live: false, reason: 'revision-moved' };
  if (ticket.baseStorageRevision !== current.baseStorageRevision) return { live: false, reason: 'storage-revision-moved' };
  if (ticket.sourceManifestHash !== current.sourceManifestHash) return { live: false, reason: 'source-manifest-changed' };
  if (ticket.runEpoch !== current.runEpoch) return { live: false, reason: 'epoch-stale' };
  return { live: true, reason: null };
}

/** 票据与批次票据必须描述同一件事：这一层防止两套票据各自漂移。 */
export function agreesWithBatchTicket(ticket: RunnerTicketV1, batch: WorldBuildBatchTicketV1): boolean {
  return ticket.jobId === batch.jobId
    && ticket.chatUid === batch.chatUid
    && ticket.branchId === batch.branchId
    && ticket.ownerFloorId === batch.ownerFloorId
    && ticket.baseRevision === batch.baseRevision
    && ticket.baseStorageRevision === batch.baseStorageRevision
    && ticket.sourceManifestHash === batch.sourceManifestHash
    && ticket.runEpoch === batch.runEpoch;
}

/** 切换聊天/分支 → 立即停旧 runner，且**不允许**把旧世界带过去。 */
export function shouldStopOnScopeChange(ticket: RunnerTicketV1, next: { chatUid: string; branchId: string }): boolean {
  return ticket.chatUid !== text(next.chatUid) || ticket.branchId !== text(next.branchId);
}

/* ------------------------------------------------------------------ *
 * §15.3 窗口身份、去重与失败指纹
 * ------------------------------------------------------------------ */

export type WindowSendLedgerV1 = { operation: number; extra: number };

export type RunnerWindowRecordV1 = {
  windowId: string;
  windowSequence: number;
  runEpoch: number;
  workKinds: WorldBuildWorkKind[];
  unitCount: number;
  sends: WindowSendLedgerV1;
  /** 这一窗口的结果是否真的按 SaveAck 保存了。没 ACK 的窗口不推进进度。 */
  saved: boolean;
  skippedReason: string | null;
  failureFingerprint: string | null;
  startedWallMs: number;
};

export type RunnerFailureRecordV1 = {
  attempts: number;
  lastWallMs: number;
  /** 反馈指纹：输入/资料变了，指纹就变，旧失败不再挡路。 */
  feedbackHash: string;
};

export type RunnerLedgerV1 = {
  windows: RunnerWindowRecordV1[];
  failures: Record<string, RunnerFailureRecordV1>;
  /** 已处理过的窗口签名，用来吃掉重复的 ended / after-commands 通知。 */
  triggers: string[];
};

export function emptyRunnerLedger(): RunnerLedgerV1 {
  return { windows: [], failures: {}, triggers: [] };
}

/** 窗口身份 = job + epoch + 序号 + 单元集合 + 目标输入签名；同签名即同窗口。 */
export function windowSignature(input: {
  jobId: string;
  runEpoch: number;
  windowSequence: number;
  unitIds: readonly string[];
  targetSignatures?: readonly string[];
}): string {
  const units = [...(input?.unitIds ?? [])].map((id) => String(id)).sort();
  const targets = [...(input?.targetSignatures ?? [])].map((id) => String(id)).sort();
  return JSON.stringify([text(input?.jobId), Number(input?.runEpoch ?? 0), Number(input?.windowSequence ?? 0), units, targets]);
}

/** 手动派发的一次触发签名（同一个通知重放时要能被认出来）。 */
export function triggerSignature(input: { chatUid: string; branchId: string; floorId: string; revision: number; jobId: string; runEpoch: number }): string {
  return JSON.stringify([text(input?.chatUid), text(input?.branchId), text(input?.floorId), Number(input?.revision ?? 0), text(input?.jobId), Number(input?.runEpoch ?? 0)]);
}

/**
 * 登记一次触发。**重复触发不重复发请求**：同一签名第二次进来只标记 duplicate，
 * 账本不变。调用方据此直接结束，而不是再跑一个窗口（§15.3）。
 */
export function registerTrigger(ledger: RunnerLedgerV1, signature: string): { ledger: RunnerLedgerV1; duplicate: boolean } {
  if (ledger.triggers.includes(signature)) return { ledger, duplicate: true };
  return { ledger: { ...ledger, triggers: [...ledger.triggers, signature] }, duplicate: false };
}

export function failureFingerprint(input: {
  targetId: string;
  inputSignature: string;
  code: string;
  /** 失败正文的稳定摘要；没有就传空串（空串不算「有新反馈」）。 */
  feedbackHash?: string;
}): string {
  return JSON.stringify([text(input?.targetId), text(input?.inputSignature), text(input?.code)]);
}

/** 同一个指纹最多自动尝试这么多次；之后必须等新反馈或显式 retry-failed。 */
export const MAX_UNCHANGED_FAILURE_ATTEMPTS = 2;

/**
 * 该不该跳过这个失败目标。
 * 三种情况：没有失败记录（不跳）、已有新反馈（不跳，但重置计数）、
 * 无新反馈且达上限（跳过，并在 reason 里说清等什么）。
 */
export function shouldSkipFailure(
  ledger: RunnerLedgerV1,
  fingerprint: string,
  feedbackHash = '',
): { skip: boolean; reason: string } {
  const record = ledger.failures[fingerprint];
  if (!record) return { skip: false, reason: '' };
  if (feedbackHash && feedbackHash !== record.feedbackHash) return { skip: false, reason: '' };
  if (record.attempts >= MAX_UNCHANGED_FAILURE_ATTEMPTS) {
    return { skip: true, reason: '同一个失败指纹已连续失败且没有新反馈：等显式 retry-failed 或新资料' };
  }
  return { skip: false, reason: '' };
}

export function recordFailure(ledger: RunnerLedgerV1, fingerprint: string, feedbackHash: string, wallMs: number): RunnerLedgerV1 {
  const previous = ledger.failures[fingerprint];
  const sameFeedback = previous && (!feedbackHash || feedbackHash === previous.feedbackHash);
  const attempts = sameFeedback ? previous.attempts + 1 : 1;
  return {
    ...ledger,
    failures: { ...ledger.failures, [fingerprint]: { attempts, lastWallMs: wallMs, feedbackHash: sameFeedback ? previous.feedbackHash : feedbackHash } },
  };
}

export function appendWindow(ledger: RunnerLedgerV1, record: RunnerWindowRecordV1): RunnerLedgerV1 {
  return { ...ledger, windows: [...ledger.windows, record] };
}

export type RunnerLedgerSummaryV1 = {
  windows: number;
  savedWindows: number;
  skippedWindows: number;
  units: number;
  requests: { operation: number; extra: number; total: number };
  failedFingerprints: number;
};

/**
 * 跨窗口累计账本。§15 完成条件里「总请求账本可核对，不出现每新窗口都从零」就是这张表。
 */
export function summarizeRunnerLedger(ledger: RunnerLedgerV1): RunnerLedgerSummaryV1 {
  let operation = 0;
  let extra = 0;
  let units = 0;
  let saved = 0;
  let skipped = 0;
  for (const window of ledger.windows) {
    operation += Math.max(0, Number(window.sends?.operation ?? 0));
    extra += Math.max(0, Number(window.sends?.extra ?? 0));
    units += Math.max(0, Number(window.unitCount ?? 0));
    if (window.saved) saved += 1;
    if (window.skippedReason) skipped += 1;
  }
  return {
    windows: ledger.windows.length,
    savedWindows: saved,
    skippedWindows: skipped,
    units,
    requests: { operation, extra, total: operation + extra },
    failedFingerprints: Object.keys(ledger.failures).length,
  };
}

/* ------------------------------------------------------------------ *
 * §15.3 冻结窗口设置
 * ------------------------------------------------------------------ */

export type FrozenWindowSettingsV1 = {
  connectionId: string;
  promptHash: string;
  batching: { newUnitsPerRetry: number; maxUnitsPerWindow: number };
  requestsPerOperation: number;
  frozenAtWallMs: number;
};

export type FreezeIssue = { code: string; message: string };

/**
 * 窗口开始时冻结设置：一个窗口内绝不换连接、换提示词、换批配额。
 * 缺连接/缺提示词**不是**静默用默认值，而是明确报出、让 runner 暂停（§15.4 最后一条）。
 */
export function freezeWindowSettings(input: {
  connectionId?: string | null;
  promptHash?: string | null;
  batching?: { newUnitsPerRetry?: number; maxUnitsPerWindow?: number } | null;
  requestsPerOperation?: number | null;
  nowWallMs?: number;
}): { frozen: FrozenWindowSettingsV1 | null; issues: FreezeIssue[] } {
  const issues: FreezeIssue[] = [];
  const connectionId = text(input?.connectionId);
  if (!connectionId) issues.push({ code: 'WINDOW_CONNECTION_MISSING', message: '没有可用的连接：窗口不开，等配置补好' });
  const promptHash = text(input?.promptHash);
  if (!promptHash) issues.push({ code: 'WINDOW_PROMPT_MISSING', message: '没有可用的提示词版本：窗口不开，不用空提示词顶上' });
  const requests = Number(input?.requestsPerOperation);
  if (!Number.isInteger(requests) || requests < 0) {
    issues.push({ code: 'WINDOW_REQUESTS_INVALID', message: 'requestsPerOperation 必须为非负整数；0 表示不限制，不用默认值硬跑' });
  }
  if (issues.length) return { frozen: null, issues };
  const retry = Number(input?.batching?.newUnitsPerRetry);
  const maxUnits = Number(input?.batching?.maxUnitsPerWindow);
  return {
    frozen: {
      connectionId,
      promptHash,
      batching: {
        newUnitsPerRetry: Number.isFinite(retry) && retry > 0 ? Math.floor(retry) : 3,
        maxUnitsPerWindow: Number.isFinite(maxUnits) && maxUnits > 0 ? Math.floor(maxUnits) : 1,
      },
      requestsPerOperation: Math.floor(requests),
      frozenAtWallMs: Number(input?.nowWallMs ?? 0),
    },
    issues: [],
  };
}

/* ------------------------------------------------------------------ *
 * §15.2 决策
 * ------------------------------------------------------------------ */

export type RunnerPauseCode =
  | 'RUNNER_TICKET_STALE'
  | 'RUNNER_SAVE_NOT_ACKED'
  | 'RUNNER_CONNECTION_MISSING'
  | 'RUNNER_PERMISSION_DENIED'
  | 'RUNNER_SOURCE_SCAN_STALLED'
  | 'RUNNER_NO_BUILD_WORK';

export type RunnerFinishReason =
  | 'ticket-stale'
  | 'job-missing'
  | 'job-scope-mismatch'
  | 'duplicate-window'
  | 'blocked-no-work'
  | 'unchanged-failure'
  | 'control-requested';

export type RunnerDecision =
  | { kind: 'run-window'; windowSequence: number; units: BuildUnitV1[]; workKinds: WorldBuildWorkKind[]; frozen: FrozenWindowSettingsV1; signature: string }
  | { kind: 'await-save'; windowSequence: number; message: string }
  | { kind: 'pause'; code: RunnerPauseCode; message: string }
  | { kind: 'finish'; reason: RunnerFinishReason; message: string }
  | { kind: 'terminal'; status: WorldBuildJobStatus; message: string };

export type RunnerDecisionInput = {
  ticket: RunnerTicketV1;
  /** 当前世界状态；用来判票据是否还新鲜。 */
  current: Omit<RunnerTicketV1, 'version' | 'windowSequence'>;
  job: WorldBuildJobV1 | null;
  targets: readonly WorldBuildTargetV1[];
  ledger: RunnerLedgerV1;
  /** 本窗口设置（先算再判；缺失即暂停）。 */
  settings: { frozen: FrozenWindowSettingsV1 | null; issues: FreezeIssue[] };
  policy: { totalOperations: number; maxNewLocations: number; maxNewRoutes: number };
  sourceScanComplete: boolean;
  /** 来源扫描连续无进度次数（≥2 即视为停滞）。 */
  sourceScanStalls?: number;
  /** 正在等待宿主持久化 ACK：这时不开始新窗口。 */
  saving?: boolean;
  /** 权限 / 配置前置：任一为 false 即暂停，不再往下走。 */
  preflight?: { permissionOk?: boolean };
  /** 触发签名（同一签名重复进来直接结束）。 */
  trigger?: string;
  /** 显式 retry-failed 控制请求。 */
  retryFailed?: boolean;
  nowWallMs?: number;
};

/** 窗口只允许这七类建设/证据工作；正文推演阶段永远不从这里发。 */
export const RUNNER_WORK_KINDS: readonly WorldBuildWorkKind[] = [
  'source-scan',
  'settlement-plan',
  'entity-construction',
  'map-layout',
  'route-reconcile',
  'npc-initial-placement',
  'state-reconcile',
];

const BLOCKED_FINISH_REASONS: Readonly<Record<BuildBlockedCode, string>> = {
  INITIALIZATION_PRIORITY: '初始化任务还在进行：本任务让路，等它结束',
  DEPENDENCY_NOT_DONE: '依赖还没完成：等上层做完',
  DEPENDENCY_FAILED: '依赖已失败：等明确重试或新资料',
  DEPENDENCY_WAITING_FOR_ENTRY: '依赖是延后内部：等剧情真的进入',
  WAITING_FOR_ENTRY: '目标在等剧情进入',
  BUDGET_DEFERRED: '本窗口预算装不下：显式延期',
};

/**
 * §15.2 的伪代码，逐条落成分支。调用方拿到 `run-window` 才真的发请求；
 * 其余三类都必须**安静结束**，不许为了「看起来在干活」空转。
 */
export function nextRunnerDecision(input: RunnerDecisionInput): RunnerDecision {
  // 1) 正在保存：等 ACK，绝不并发开新窗口（§15.4「正在保存时不能说停止即撤回已保存」）。
  if (input.saving) {
    return { kind: 'await-save', windowSequence: input.ticket.windowSequence, message: '结果正在按 SaveAck 保存：保存完成前不开新窗口' };
  }
  // 2) 触发去重：SillyTavern 重放 ended / after-commands 不得重复发请求。
  if (input.trigger) {
    const registered = registerTrigger(input.ledger, input.trigger);
    if (registered.duplicate) return { kind: 'finish', reason: 'duplicate-window', message: '同一触发已经处理过：不重复发请求' };
  }
  // 3) 票据新鲜度。
  const currency = isRunnerTicketLive(input.ticket, input.current);
  if (!currency.live) {
    const switched = currency.reason === 'chat-switched' || currency.reason === 'branch-switched';
    return switched
      ? { kind: 'finish', reason: 'job-scope-mismatch', message: `聊天/分支已切换（${currency.reason}）：旧 runner 立即结束，不把旧世界带过来` }
      : { kind: 'finish', reason: 'ticket-stale', message: `票据失效（${currency.reason}）：不再开始新窗口` };
  }
  // 4) 任务存在性。
  const job = input.job;
  if (!job) return { kind: 'finish', reason: 'job-missing', message: '任务不存在或已被删除：结束' };
  if (job.id !== input.ticket.jobId || job.branchId !== input.ticket.branchId) {
    return { kind: 'finish', reason: 'job-scope-mismatch', message: '任务与票据不是同一个世界：结束' };
  }
  // 5) 权限与配置前置：缺失就暂停，不要每次刷新弹自动请求。
  if (input.preflight?.permissionOk === false) {
    return { kind: 'pause', code: 'RUNNER_PERMISSION_DENIED', message: '没有执行权限：暂停，等授权' };
  }
  if (!input.settings.frozen) {
    return { kind: 'pause', code: 'RUNNER_CONNECTION_MISSING', message: input.settings.issues[0]?.message ?? '窗口设置不完整：暂停' };
  }
  // 6) 已停止/暂停的任务不再自动起跑（stop 幂等，pending 保留）。
  if (job.status === 'paused') {
    return { kind: 'finish', reason: 'control-requested', message: `任务已暂停（${job.stopReason ?? '未给原因'}）：不自动恢复` };
  }
  // 7) 来源扫描没有进度：明确暂停原因，不无限重扫。
  if (!input.sourceScanComplete && (input.sourceScanStalls ?? 0) >= 2) {
    return { kind: 'pause', code: 'RUNNER_SOURCE_SCAN_STALLED', message: '来源扫描连续没有进度：暂停并说明原因，不反复重扫' };
  }
  // 8) 调度下一窗口。
  const schedule = selectNextBuildUnits({
    job,
    targets: input.targets,
    sourceScanComplete: input.sourceScanComplete,
    policy: input.policy,
    branchId: job.branchId,
    currentFloorId: input.ticket.ownerFloorId,
    limit: input.settings.frozen.batching.maxUnitsPerWindow,
    schedulerSeq: job.nextWindowSequence,
  });
  const units = schedule.selected.filter((unit) => RUNNER_WORK_KINDS.includes(unit.workKind));
  /**
   * 终态只看**必建分母**，不看调度器的 `terminal`：
   * 调度器的 `terminal` 是「没有可调度的活」，而延后的内部恰好属于「没活但不该算失败」，
   * 两者混用会把「等剧情进入」说成「全部完成」（§10.2 第 3 条、§15.2）。
   */
  const counts = countBuildTargets(input.targets);
  if (counts.requiredPending === 0 && units.length === 0) {
    const withIssues = counts.requiredFailed + counts.requiredBlocked > 0;
    const deferred = counts.deferredInteriors > 0 ? `；另有 ${counts.deferredInteriors} 个内部延后到剧情进入，不计失败` : '';
    return {
      kind: 'terminal',
      status: withIssues ? 'completed-with-issues' : 'completed',
      message: `${withIssues ? '必建目标已完成，但有失败或阻塞项' : '所有必建目标都已完成'}${deferred}：提交终态并结束`,
    };
  }
  if (units.length === 0) {
    const retryable = input.retryFailed === true;
    const unchanged = input.ledger.failures;
    // §15.2：重复且无变化的失败是**结束**，不是暂停 —— 暂停意味着等待外部动作，
    // 而这里等的是「新资料或显式 retry-failed」，属于本次 runner 周期的终点。
    if (!retryable && Object.values(unchanged).some((record) => record.attempts >= MAX_UNCHANGED_FAILURE_ATTEMPTS)) {
      return { kind: 'finish', reason: 'unchanged-failure', message: '存在连续无变化的失败：等新反馈或显式 retry-failed，不盲重试' };
    }
    const first = schedule.blocked[0];
    return {
      kind: 'finish',
      reason: first ? 'blocked-no-work' : 'blocked-no-work',
      message: first ? `${first.targetId ? `${first.targetId}：` : ''}${BLOCKED_FINISH_REASONS[first.code] ?? first.message}` : '当前没有可开工的单元',
    };
  }
  const windowSequence = job.nextWindowSequence;
  const signature = windowSignature({
    jobId: job.id,
    runEpoch: job.runEpoch,
    windowSequence,
    unitIds: units.map((unit) => unit.unitId),
    targetSignatures: units.flatMap((unit) => input.targets.filter((target) => unit.targetIds.includes(target.id)).map((target) => target.inputSignature)),
  });
  return {
    kind: 'run-window',
    windowSequence,
    units,
    workKinds: [...new Set(units.map((unit) => unit.workKind))],
    frozen: input.settings.frozen,
    signature,
  };
}

/* ------------------------------------------------------------------ *
 * §15.4 停止、刷新与恢复
 * ------------------------------------------------------------------ */

export type StopOutcomeV1 = {
  job: WorldBuildJobV1;
  /** 恒 false：已经 ACK 的结果不会被「停止」撤回。 */
  withdrewSaved: false;
  /** stop 幂等：重复调用不改变 job。 */
  idempotent: boolean;
  message: string;
};

/**
 * 停止。幂等：已经在 stopped 状态就原样返回，不重复抬 epoch
 * （重复抬 epoch 会让在途候选的失效原因变得不可复现）。
 */
export function stopBuildRun(job: WorldBuildJobV1, reason = 'stopped'): StopOutcomeV1 {
  if (job.status === 'paused' && job.stopReason === reason) {
    return { job, withdrewSaved: false, idempotent: true, message: '已经停止：不重复失效，不删除世界' };
  }
  return {
    job: { ...job, status: 'paused', stopReason: reason, runEpoch: job.runEpoch + 1 },
    withdrewSaved: false,
    idempotent: false,
    message: '已停止：本次 runner 票据失效，不再开始新窗口；已 ACK 的结果保留',
  };
}

export const WORLD_BUILD_TRIGGERS = ['allowed-map-update', 'foreground-turn', 'refresh', 'manual-open'] as const;
export type WorldBuildTrigger = (typeof WORLD_BUILD_TRIGGERS)[number];

/**
 * 下一次合法更新才续建。**刷新/手动打开永远不自动发请求**（§15.4）：
 * 刷新只读进度，界面上把旧的 running 显示成「等待下次触发」。
 */
export function shouldAutoResume(trigger: WorldBuildTrigger, job: WorldBuildJobV1 | null): { resume: boolean; reason: string } {
  if (!job) return { resume: false, reason: '没有可续建的任务' };
  if (trigger === 'refresh') return { resume: false, reason: '刷新只读进度：零发送，等下一次合法世界更新' };
  if (trigger === 'manual-open') return { resume: false, reason: '手动打开不自动起跑：只在合法更新时续建' };
  if (job.status === 'completed') return { resume: false, reason: '任务已经完成' };
  if (job.status === 'completed-with-issues') return { resume: false, reason: '必建目标已完成但有失败/阻塞：需要显式重试' };
  if (job.status === 'cancelled') return { resume: false, reason: '任务已取消' };
  if (job.status === 'paused') return { resume: false, reason: `任务已暂停（${job.stopReason ?? '未给原因'}）：需要显式重试` };
  return { resume: true, reason: '合法的世界更新：自动续建未完成工作，不需要额外的继续建图按钮' };
}

export type RunnerDisplayStateV1 = {
  status: WorldBuildJobStatus;
  /** 展示用文案；刷新后不复述「正在运行」。 */
  label: string;
  /** 恒 false：展示层不许触发请求。 */
  autoFetch: false;
  /** 需要一次合法世界更新才会继续。 */
  waitingForTrigger: boolean;
};

/** §15.4：刷新/重开聊天只读进度；旧 running 在展示上视为「等待下次触发」。 */
export function refreshDisplayState(job: WorldBuildJobV1 | null): RunnerDisplayStateV1 {
  if (!job) return { status: 'pending', label: '尚无建设任务', autoFetch: false, waitingForTrigger: false };
  if (job.status === 'running') {
    return { status: 'running', label: '上次退出时仍在建设：等待下一次合法世界更新继续', autoFetch: false, waitingForTrigger: true };
  }
  if (job.status === 'paused') {
    return { status: 'paused', label: `已暂停：${job.stopReason ?? '未给原因'}`, autoFetch: false, waitingForTrigger: true };
  }
  if (job.status === 'completed') return { status: 'completed', label: '建设已完成', autoFetch: false, waitingForTrigger: false };
  if (job.status === 'completed-with-issues') return { status: 'completed-with-issues', label: '必建目标已完成，但有失败或阻塞项', autoFetch: false, waitingForTrigger: true };
  if (job.status === 'cancelled') return { status: 'cancelled', label: '建设已取消', autoFetch: false, waitingForTrigger: false };
  return { status: job.status, label: '等待开始建设', autoFetch: false, waitingForTrigger: false };
}

/** 一次 runner 周期的收尾：释放所有权，绝不残留「我还持有锁」。 */
export function releaseRunner(ownershipKey: string): { ownershipKey: string; released: true } {
  return { ownershipKey, released: true };
}
