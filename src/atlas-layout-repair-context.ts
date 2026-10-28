/**
 * atlas-layout-repair-context.ts — 定向纠错上下文（P06 §12.6）。
 *
 * 四张图里只有一张的 `city.enclosure` 错了，第二次就**只发那一张**，并且把
 * 「哪条校验错了、路径在哪、允许什么值、失败片段是什么、哪些锁和稳定实体必须保留」
 * 一起交给模型。成功过的图不重做，缺额不会把整批拖回重发。
 *
 * 纪律：
 * - 完整失败操作只留在候选内用于纠错，**不进安全日志**（本模块只产出纠错上下文）。
 * - 关联 mapId 从冻结目录 / opId / ref 解析，不按标题猜。
 * - 任意非法枚举都**不许**被悄悄改成一个合法值（例如把非法 enclosure 一律转 `open`）。
 * - 额度用尽的地图转 failed，其它目标继续；新窗口不能把同一个失败自动变回 fresh。
 */

import type { PlanIssue } from './atlas-world-contract.ts';

/**
 * 布局失败的七个类别（§12.6）。
 *
 * 分这么细是为了**分别处理**：缺回复可以原样重发，内容错要带纠错上下文，
 * 网络错要退避重试 —— 一条规则套所有失败，就会把「模型没答」和「答错枚举」混成一件事。
 */
export const LAYOUT_FAILURE_KINDS = [
  'missing-reply',
  'invalid-json',
  'invalid-reference',
  'validation-rejected',
  'geometry-rejected',
  'output-truncated',
  'transport-failed',
] as const;
export type LayoutFailureKind = (typeof LAYOUT_FAILURE_KINDS)[number];

export type RepairIssueRef = {
  code: string;
  path: string;
  allowedValues?: readonly string[];
};

export type LayoutFailureV1 = {
  mapId: string | null;
  kind: LayoutFailureKind;
  originBatchId: string;
  issues: readonly RepairIssueRef[];
};

/** 每种失败各自的处理方式：不能一条规则套所有失败。 */
export const REPAIR_STRATEGIES: Record<LayoutFailureKind, 'retry-same' | 'repair-context' | 'retry-later' | 'abandon'> = {
  'missing-reply': 'retry-same',
  'invalid-json': 'repair-context',
  'invalid-reference': 'repair-context',
  'validation-rejected': 'repair-context',
  'geometry-rejected': 'repair-context',
  'output-truncated': 'retry-same',
  'transport-failed': 'retry-later',
};

export type MapRepairTarget = {
  mapId: string;
  batchId: string;
  attempts: number;
};

export type LayoutRepairBatch = {
  /** 本轮要发的纠错批次 ID（带轮次，便于诊断对齐）。 */
  batchId: string;
  /** 只含失败图；成功图绝不出现。 */
  mapIds: string[];
  contexts: readonly RepairContext[];
};

export type RepairContext = {
  mapId: string;
  kind: LayoutFailureKind;
  strategy: (typeof REPAIR_STRATEGIES)[LayoutFailureKind];
  /** 校验失败的具体条目：code + path + 允许值。 */
  failures: readonly RepairIssueRef[];
  /** 必须保留的锁与稳定实体（防模型顺手重排）。 */
  preservedLockIds: readonly string[];
  preservedMemberIds: readonly string[];
};

export type LayoutRepairPlan = {
  batches: LayoutRepairBatch[];
  /** 额度用尽、本轮直接判 failed 的地图。 */
  failed: readonly { mapId: string; reason: string }[];
  issues: readonly PlanIssue[];
};

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function uniqueSorted(values: readonly unknown[]): string[] {
  return [...new Set(values.map(text).filter((value) => value.length > 0))].sort();
}

/** 枚举纠错提示：**只**列出允许值，不改写原值。 */
export function enumRepairHint(input: {
  path: string;
  invalidValue: unknown;
  allowedValues: readonly string[];
}): { code: string; path: string; allowedValues: string[]; message: string; invalidValue: string } {
  const invalidValue = text(input.invalidValue);
  const allowedValues = [...input.allowedValues];
  return {
    code: 'ENUM_INVALID',
    path: text(input.path),
    allowedValues,
    invalidValue,
    message: `${input.path} 收到非法值 ${invalidValue === '' ? '(空)' : invalidValue}，允许值只有 ${allowedValues.join(' / ')}。请自行选择合法值重发；不会把它悄悄改成 ${allowedValues[0]}。`,
  };
}

/**
 * §12.6：算本轮定向纠错批次。
 *
 * 规则：
 * - 只选有失败记录的地图；成功图（没有失败记录）即使在同一 originBatch 里也不重做；
 * - 同一张图多个失败合并进同一个上下文（不重复发同样的图）；
 * - 额度用尽 → 进 `failed`，不留在批次里无限重试；
 * - `transport-failed` 单独成批：网络问题不等同内容问题，重试节奏不同。
 */
export function planLayoutRepair(input: {
  failures: readonly LayoutFailureV1[];
  /** 现有地图与它们所属批次（用于判断是否同一 originBatch、以及重试次数）。 */
  maps: readonly MapRepairTarget[];
  /** 每个 map 的最大纠错次数。 */
  maxAttempts?: number;
  /** 需要保留的锁（按图）。 */
  locksByMap?: Readonly<Record<string, readonly string[]>>;
  /** 需要保留的稳定成员（按图）。 */
  membersByMap?: Readonly<Record<string, readonly string[]>>;
  /** 批次 ID 前缀，便于多窗口诊断区分。 */
  batchPrefix?: string;
}): LayoutRepairPlan {
  const issues: PlanIssue[] = [];
  const maxAttempts = Math.max(1, Math.floor(Number.isFinite(input?.maxAttempts) ? (input.maxAttempts as number) : 2));
  const prefix = text(input?.batchPrefix) || 'layout_repair';
  const byMap = new Map<string, MapRepairTarget>();
  for (const item of input?.maps ?? []) {
    const mapId = text(item?.mapId);
    if (mapId.length > 0) byMap.set(mapId, { mapId, batchId: text(item.batchId), attempts: Math.max(0, Math.floor(item.attempts)) });
  }

  const grouped = new Map<string, { kind: LayoutFailureKind; originBatchId: string; failures: RepairIssueRef[] }>();
  const failed: Array<{ mapId: string; reason: string }> = [];

  for (const failure of input?.failures ?? []) {
    const mapId = text(failure?.mapId);
    if (mapId.length === 0) {
      issues.push({
        code: 'LAYOUT_REPAIR_MAP_UNRESOLVED',
        path: '$.failures',
        message: '有失败记录解析不出 mapId（不能按标题猜）：这条失败不进入纠错批次，等目录/ref 修好再重试。',
        severity: 'warning',
        retryable: true,
      });
      continue;
    }
    const target = byMap.get(mapId) ?? null;
    const attempts = target?.attempts ?? 0;
    if (attempts >= maxAttempts) {
      failed.push({ mapId, reason: `纠错次数已达上限 ${maxAttempts}（失败类型 ${failure.kind}）` });
      issues.push({
        code: 'LAYOUT_REPAIR_EXHAUSTED',
        path: `$.maps.${mapId}`,
        message: `地图 ${mapId} 纠错次数已达上限 ${maxAttempts}：本轮判 failed 并继续其它目标；新窗口不会把它自动变回 fresh。`,
        severity: 'error',
        retryable: false,
        mapId,
      });
      continue;
    }
    const existing = grouped.get(mapId);
    const kind = failure.kind;
    if (existing) {
      existing.failures.push(...(failure.issues ?? []));
      // 同一张图多种失败：以更「内容性」的那种为准（内容问题需要纠错上下文）。
      if (REPAIR_STRATEGIES[kind] === 'repair-context') existing.kind = kind;
    } else {
      grouped.set(mapId, { kind, originBatchId: text(failure.originBatchId), failures: [...(failure.issues ?? [])] });
    }
  }

  const contexts: RepairContext[] = [...grouped.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([mapId, entry]) => ({
      mapId,
      kind: entry.kind,
      strategy: REPAIR_STRATEGIES[entry.kind],
      failures: entry.failures
        .map((item) => ({
          code: text(item.code),
          path: text(item.path),
          ...(Array.isArray(item.allowedValues) ? { allowedValues: [...item.allowedValues].map(text) } : {}),
        }))
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
      preservedLockIds: uniqueSorted(input?.locksByMap?.[mapId] ?? []),
      preservedMemberIds: uniqueSorted(input?.membersByMap?.[mapId] ?? []),
    }));

  // 网络失败单独成批：内容没问题，重发即可，不夹带纠错上下文。
  const transport = contexts.filter((context) => context.strategy === 'retry-later');
  const content = contexts.filter((context) => context.strategy !== 'retry-later');
  const batches: LayoutRepairBatch[] = [];
  if (content.length > 0) {
    batches.push({ batchId: `${prefix}_content`, mapIds: content.map((context) => context.mapId), contexts: content });
  }
  if (transport.length > 0) {
    batches.push({ batchId: `${prefix}_transport`, mapIds: transport.map((context) => context.mapId), contexts: transport });
  }

  return { batches, failed, issues };
}
