/**
 * atlas-workbench-status.ts — P14 §20.1：工作台必需的建图状态（只读派生）。
 *
 * 计划允许「可用现有工作台组件适量增加状态」，但禁止「新建独立产品面板」、禁止「把提示消息
 * 插进酒馆聊天」、禁止「加手动改重要性/坐标/世界事实入口」。所以这里只产出一份**数据快照**，
 * 由既有工作台渲染；`chatInjection` 恒为 `false`，`manualOverrides` 恒为空数组。
 *
 * 关键纪律：
 * - 「已完成 / 必建待办 / 失败 / 依赖阻塞 / 等待实际进入」五个桶各自独立，`failed` 不是 `blocked`；
 * - 「真实地图布局数量」只引用调用方给的真实计数，缺失时是 `null`，不默认 0；
 * - 停止与集中重试只给**计划**（`stop` / `retryFailed`），执行仍由既有 runner 控制请求发起。
 */

import {
  countBuildTargets,
  isDiscoveryComplete,
  isLegacyConstructionRow,
} from './atlas-world-build-state.ts';
import type { WorldBuildJobV1, WorldBuildTargetV1, WorldBuildRequirement } from './atlas-world-build-contract.ts';
import { refreshDisplayState, type RunnerDisplayStateV1, type RunnerLedgerV1 } from './atlas-world-build-runner.ts';
import { planFailedRetry, type RetryCandidate } from './atlas-turn-analysis-groups.ts';

export type WorkbenchTotals = {
  /** 必建分母五桶（互不重叠）。 */
  required: { total: number; done: number; pending: number; failed: number; blocked: number };
  /** 可延后的内部：等剧情真的进去，不是失败。 */
  deferredInteriors: number;
  cancelled: number;
  /** 按 requirement 分组的原始计数（三分母不同，不能混算）。 */
  byRequirement: Record<WorldBuildRequirement, number>;
};

export type WorkbenchMapLayouts = {
  /** 全局登记的地图数；`null` = 读不到，不写 0 冒充「没有图」。 */
  registered: number | null;
  /** 已有真实布局（scene ready）的地图数。 */
  laidOut: number | null;
};

export type WorkbenchWindowStatus = {
  /** 当前进行中的窗口序号（已开始但未提交）。 */
  current: number | null;
  /** 已提交的窗口数。 */
  committed: number;
  /** 累计窗口数。 */
  cumulative: number;
  /** 累计真实传输次数。 */
  cumulativeTransports: number;
  /** 额外请求的原因分布（只来自账本里真实记录过的 skippedReason；没有账本就是 null）。 */
  extraReasons: Array<{ reason: string; windows: number }> | null;
  /** 账本是否存在：缺失时上面几个原因类字段一律 null，不伪造。 */
  ledgerAvailable: boolean;
};

export type WorkbenchContradictionItem = {
  issueId: string;
  code: string;
  objectId: string | null;
  floorRef: string;
  occurrences: number;
  message: string;
};

export type WorkbenchBuildStatus = {
  /** 没有建设任务时 `null`。 */
  job: {
    id: string;
    kind: WorldBuildJobV1['kind'];
    status: WorldBuildJobV1['status'];
    label: string;
    /** 恒 false：工作台展示层不许触发请求。 */
    autoFetch: false;
    waitingForTrigger: boolean;
  } | null;
  /** 当前阶段（人可读）。 */
  phase: string;
  sourceScan: { complete: boolean; discoveryComplete: boolean; scopeSealed: boolean } | null;
  totals: WorkbenchTotals;
  mapLayouts: WorkbenchMapLayouts;
  windows: WorkbenchWindowStatus;
  /** 可操作项：只给能力，不给入口按钮。 */
  actions: {
    canStop: boolean;
    canRetryFailed: boolean;
    /** 集中重试的明确范围说明（只含失败项）。 */
    retryScope: string | null;
    retryBlockedReason: string | null;
    /** 失败项清单：供「查看失败项」直接展开。 */
    failedTargets: RetryCandidate[];
    blockedTargets: RetryCandidate[];
  };
  /** 正文空间矛盾（按 floor/object/code 合并，不刷屏）。 */
  contradictions: WorkbenchContradictionItem[];
  /** 旧版建设行（迁移前）数量：只读提示，不参与新桶计数。 */
  legacyRows: number;
  /** 恒 false：进度/失败/矛盾只进工作台与诊断，不插聊天。 */
  chatInjection: false;
  /** 恒为空：本轮不新增人工纠正入口。 */
  manualOverrides: readonly never[];
};

const ZERO_REQUIREMENT: Record<WorldBuildRequirement, number> = {
  'source-required': 0,
  'inferred-shell': 0,
  'deferred-interior': 0,
};

function toRetryCandidate(target: WorldBuildTargetV1): RetryCandidate {
  return {
    targetRef: target.id,
    workKind: target.workKind,
    requirement: target.requirement,
    status: target.status,
    lastErrorCode: target.lastErrorCode,
    attempts: target.attempts,
  };
}

/** A live owner is required; a saved terminal job has no current window. */
function currentWindow(job: WorldBuildJobV1 | null, active:boolean): number | null {
  if (!job || !active) return null;
  const next = job.nextWindowSequence;
  if (!Number.isSafeInteger(next) || next <= 0) return null;
  return job.committedWindowSequence < next ? next : null;
}

function extraReasons(ledger: RunnerLedgerV1 | null | undefined): Array<{ reason: string; windows: number }> | null {
  if (!ledger || !Array.isArray(ledger.windows)) return null;
  const counts = new Map<string, number>();
  for (const window of ledger.windows) {
    const reason = typeof window?.skippedReason === 'string' && window.skippedReason ? window.skippedReason : null;
    if (!reason) continue;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([reason, windows]) => ({ reason, windows }));
}

export function buildWorkbenchStatus(input: {
  job: WorldBuildJobV1 | null;
  targets: readonly WorldBuildTargetV1[];
  maps?: WorkbenchMapLayouts | null;
  ledger?: RunnerLedgerV1 | null;
  auditSummary?: Pick<WorkbenchWindowStatus, 'ledgerAvailable' | 'extraReasons'> | null;
  draining?: boolean;
  windowActive?: boolean;
  sourceScanComplete?: boolean;
  settlementPlansExpanded?: boolean;
  legacyRowCount?: number;
  contradictions?: readonly WorkbenchContradictionItem[];
}): WorkbenchBuildStatus {
  const job = input?.job ?? null;
  const targets = Array.isArray(input?.targets) ? input.targets : [];
  const counts = countBuildTargets(targets);
  const byRequirement: Record<WorldBuildRequirement, number> = { ...ZERO_REQUIREMENT };
  for (const target of targets) {
    const requirement = target?.requirement;
    if (typeof requirement === 'string' && requirement in byRequirement) {
      byRequirement[requirement as WorldBuildRequirement] += 1;
    }
  }  const display: RunnerDisplayStateV1 = refreshDisplayState(job);
  const sourceScanComplete = input?.sourceScanComplete === true;
  const settlementExpanded = input?.settlementPlansExpanded === true;
  const discoveryComplete = isDiscoveryComplete(targets);
  const failed = targets.filter((target) => target.status === 'failed').map(toRetryCandidate);
  const blocked = targets.filter((target) => target.status === 'blocked').map(toRetryCandidate);
  const retryPlan = planFailedRetry(failed.concat(blocked));
  const ledger = input?.ledger ?? null;
  const phase = !job
    ? 'idle'
    : job.status === 'completed' || job.status === 'completed-with-issues'
      ? 'finished'
      : job.status === 'paused' || job.status === 'cancelled'
        ? 'stopped'
        : discoveryComplete && sourceScanComplete
          ? 'layout'
          : 'discovery';
  return {
    job: job
      ? { id: job.id, kind: job.kind, status: job.status, label: input.draining ? '停止中，等待在途请求结束' : display.label, autoFetch: false, waitingForTrigger: display.waitingForTrigger }
      : null,
    phase,
    sourceScan: job
      ? { complete: sourceScanComplete, discoveryComplete, scopeSealed: sourceScanComplete && settlementExpanded && discoveryComplete }
      : null,
    totals: {
      required: {
        total: counts.requiredTargets,
        done: counts.requiredDone,
        pending: counts.requiredPending,
        failed: counts.requiredFailed,
        blocked: counts.requiredBlocked,
      },
      deferredInteriors: counts.deferredInteriors,
      cancelled: counts.cancelled,
      byRequirement,
    },
    mapLayouts: {
      registered: typeof input?.maps?.registered === 'number' && Number.isFinite(input.maps.registered)
        ? Math.max(0, Math.floor(input.maps.registered)) : null,
      laidOut: typeof input?.maps?.laidOut === 'number' && Number.isFinite(input.maps.laidOut)
        ? Math.max(0, Math.floor(input.maps.laidOut)) : null,
    },
    windows: {
      current: currentWindow(job,input.windowActive===true),
      committed: job ? job.committedWindowSequence : 0,
      cumulative: job ? job.cumulativeWindows : 0,
      cumulativeTransports: job ? job.cumulativeTransports : 0,
      extraReasons: input.auditSummary?.extraReasons ?? extraReasons(ledger),
      ledgerAvailable: input.auditSummary?.ledgerAvailable ?? (!!ledger && Array.isArray(ledger.windows)),
    },
    actions: {
      // 已完成 / 已取消的任务没有「停止本次运行」的意义；暂停态重复停止是幂等的，但这里不再暴露。
      canStop: !!job && (job.status === 'running' || job.status === 'pending'),
      canRetryFailed: failed.length > 0 && !input.draining,
      retryBlockedReason: input.draining ? '在途请求尚未结束；结束后可重试失败项。' : null,
      retryScope: failed.length > 0 ? retryPlan.scope : null,
      failedTargets: failed,
      blockedTargets: blocked,
    },
    contradictions: Array.isArray(input?.contradictions) ? [...input.contradictions] : [],
    legacyRows: Number.isSafeInteger(input?.legacyRowCount) ? Math.max(0, input.legacyRowCount!) : 0,
    chatInjection: false,
    manualOverrides: [],
  };
}

/** 给「查看失败项」用的稳定排序：先按工作类型，再按目标 ID，读起来不乱跳。 */
export function sortWorkbenchFailures(items: readonly RetryCandidate[]): RetryCandidate[] {
  return [...(Array.isArray(items) ? items : [])].sort((left, right) => {
    const kindCompare = String(left?.workKind ?? '').localeCompare(String(right?.workKind ?? ''));
    if (kindCompare !== 0) return kindCompare;
    return String(left?.targetRef ?? '') < String(right?.targetRef ?? '') ? -1 : 1;
  });
}

/** 旧版建设行判定转发：工作台只需要计数，不需要另写一份「什么算旧行」。 */
export { isLegacyConstructionRow };
