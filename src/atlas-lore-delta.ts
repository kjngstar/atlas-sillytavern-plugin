/**
 * atlas-lore-delta.ts — §19.1 / §19.2：世界书增量发现与初始化期间的资料变化。
 *
 * 这一层只回答「哪些来源变了、要重排哪些目标、哪些进度**不能**清、哪些资料**不能**当成世界消失」。
 * 不写库、不排队、不调模型：真正的入队由建设任务层执行，这里给出可断言的判定。
 *
 * 三条硬纪律：
 * - 增量只影响**相关**实体/图：一个来源改名，不能把其它已处理完的地图进度清零。
 * - 删除来源 ≠ 删除世界事实：没有明确拆毁事件就不清理地图，只记「资料缺失」。
 * - 旧 hash 未读内容已拿不到时，标 superseded/blocked 并说清楚，**不能拿新文本冒充旧 hash 已扫描**。
 */

import type { Issue } from './atlas-ops-contract.ts';

export const LORE_DELTA_REASONS = [
  'source-added',
  'source-changed',
  'permission-revoked',
  'permission-granted',
  'source-removed',
] as const;
export type LoreDeltaReason = (typeof LORE_DELTA_REASONS)[number];

export type LoreSourceEntry = {
  sourceKey: string;
  contentHash: string;
  /** 读取许可：本轮是否还能读这条来源的内容。 */
  readable?: boolean;
  /** 这条来源影响的实体/目标（由目标账目给出，不在本层推导）。 */
  targetIds?: readonly string[];
};

export type LoreManifest = readonly LoreSourceEntry[];

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function issue(code: string, path: string, message: string, severity: 'warning' | 'error' = 'warning'): Issue {
  return { code, path, message, severity, retryable: false };
}

/** 读取状态归一：缺省视为可读（老调用方不传该字段）。 */
function readable(entry: LoreSourceEntry): boolean {
  return entry?.readable !== false;
}

/**
 * §19.1：比较 sourceKey + contentHash + 读取许可。
 *
 * 判断只有一条：**同 key 同 hash 且仍可读 = 没有新资料**，其余一律给出明确原因，
 * 不做「长度差不多就算没变」这种猜测。
 */
export function diffLoreManifest(previous: LoreManifest, next: LoreManifest): {
  added: LoreSourceEntry[];
  changed: LoreSourceEntry[];
  unchanged: LoreSourceEntry[];
  removed: LoreSourceEntry[];
  permissionRevoked: LoreSourceEntry[];
  permissionGranted: LoreSourceEntry[];
} {
  const before = new Map<string, LoreSourceEntry>();
  for (const entry of previous ?? []) {
    const key = str(entry?.sourceKey);
    if (key !== '') before.set(key, entry);
  }
  const after = new Map<string, LoreSourceEntry>();
  for (const entry of next ?? []) {
    const key = str(entry?.sourceKey);
    if (key !== '') after.set(key, entry);
  }

  const added: LoreSourceEntry[] = [];
  const changed: LoreSourceEntry[] = [];
  const unchanged: LoreSourceEntry[] = [];
  const permissionRevoked: LoreSourceEntry[] = [];
  const permissionGranted: LoreSourceEntry[] = [];

  for (const [key, entry] of after) {
    const old = before.get(key);
    if (!old) {
      // 新来源不算「许可恢复」，只是新增。
      added.push(entry);
      continue;
    }
    if (readable(old) && !readable(entry)) permissionRevoked.push(entry);
    else if (!readable(old) && readable(entry) && str(old.contentHash) === str(entry.contentHash)) permissionGranted.push(entry);

    if (str(old.contentHash) !== str(entry.contentHash)) changed.push(entry);
    else if (readable(old) === readable(entry)) unchanged.push(entry);
  }

  const removed: LoreSourceEntry[] = [];
  for (const [key, entry] of before) {
    if (!after.has(key)) removed.push(entry);
  }

  return { added, changed, unchanged, removed, permissionRevoked, permissionGranted };
}

/**
 * §19.1：只有相关实体/图入队；未受影响目标的 processed 进度**不清零**。
 *
 * 入队粒度是「目标」，不是「整个 job」：一个来源变了，不应该让别的城镇重新布一遍局。
 */
export function planLoreDelta(input: {
  previous: LoreManifest;
  next: LoreManifest;
  /** 已知目标的所属地图：用于把「同一张图上的其它目标」算作未受影响。 */
  targetMaps?: ReadonlyMap<string, string | null>;
}): {
  enqueue: Array<{ targetId: string; sourceKey: string; reason: LoreDeltaReason }>;
  /** 明确不清进度的目标（诊断用：证明没有「整世界重扫」）。 */
  untouchedTargetIds: string[];
  /** 来源消失：保留世界事实，只记资料缺失。 */
  missingSources: Array<{ sourceKey: string; affectedTargetIds: string[] }>;
  issues: Issue[];
} {
  const diff = diffLoreManifest(input?.previous ?? [], input?.next ?? []);
  const enqueue: Array<{ targetId: string; sourceKey: string; reason: LoreDeltaReason }> = [];
  const touched = new Set<string>();

  const push = (entry: LoreSourceEntry, reason: LoreDeltaReason): void => {
    const sourceKey = str(entry?.sourceKey);
    for (const targetId of entry?.targetIds ?? []) {
      const id = str(targetId);
      if (id === '') continue;
      touched.add(id);
      enqueue.push({ targetId: id, sourceKey, reason });
    }
  };

  for (const entry of diff.added) push(entry, 'source-added');
  for (const entry of diff.changed) push(entry, 'source-changed');
  // 许可被收回的目标也要入队：不是重读，而是让队列知道「这批不能再读它」。
  for (const entry of diff.permissionRevoked) push(entry, 'permission-revoked');
  for (const entry of diff.permissionGranted) push(entry, 'permission-granted');

  const known = [...(input?.targetMaps?.keys() ?? [])];
  const untouchedTargetIds = known.filter((id) => !touched.has(id)).sort();

  const missingSources = diff.removed.map((entry) => ({
    sourceKey: str(entry?.sourceKey),
    affectedTargetIds: [...(entry?.targetIds ?? [])].map(str).filter((id) => id !== ''),
  }));

  const issues: Issue[] = [];
  if (missingSources.length > 0) {
    issues.push(issue(
      'LORE_SOURCE_MISSING_FACTS_KEPT',
      '$.sources',
      `${missingSources.length} 条来源本轮已消失：已登记的地图与事实保留，资料缺失不等于世界被拆毁`,
    ));
  }
  if (diff.permissionRevoked.length > 0) {
    issues.push(issue(
      'LORE_PERMISSION_REVOKED',
      '$.sources',
      `${diff.permissionRevoked.length} 条来源读取许可被收回：后续批次不再读取，已生成结果保留`,
      'warning',
    ));
  }
  return { enqueue, untouchedTargetIds, missingSources, issues };
}

/**
 * §19.2：初始化期间来了新资料，**不扩初始分母**。
 *
 * 否则每读一条新世界书，分母就变大一次，初始化永远结束不了。
 */
export function incrementalPolicyDuringInitialize(input: {
  initialScopeSourceKeys: readonly string[];
  incomingSourceKeys: readonly string[];
}): {
  frozenInitialScope: string[];
  incrementalQueue: string[];
  denominatorChanged: boolean;
} {
  const frozen = [...new Set((input?.initialScopeSourceKeys ?? []).map(str).filter((key) => key !== ''))];
  const known = new Set(frozen);
  const incrementalQueue = [...new Set((input?.incomingSourceKeys ?? []).map(str).filter((key) => key !== '' && !known.has(key)))];
  return { frozenInitialScope: frozen, incrementalQueue, denominatorChanged: false };
}

/**
 * §19.2：读取许可在批次之间被收回。
 *
 * - 未读块标 `blocked`（不是「已扫描」）；
 * - 依赖失效许可的候选不能继续发布；
 * - 已经生成的事实/地图保留；
 * - 当前 run ticket 失效，需要按新许可重读计划。
 */
export function planPermissionRevocation(input: {
  revokedSourceKeys: readonly string[];
  unreadChunkKeys?: readonly string[];
  pendingCandidateIds?: readonly string[];
  alreadyProducedTargetIds?: readonly string[];
}): {
  blockedChunkKeys: string[];
  cancelledCandidateIds: string[];
  keptTargetIds: string[];
  runTicketInvalidated: boolean;
  issues: Issue[];
} {
  const revoked = new Set((input?.revokedSourceKeys ?? []).map(str).filter((key) => key !== ''));
  if (revoked.size === 0) {
    return { blockedChunkKeys: [], cancelledCandidateIds: [], keptTargetIds: [...(input?.alreadyProducedTargetIds ?? [])].map(str), runTicketInvalidated: false, issues: [] };
  }
  const blockedChunkKeys = [...new Set((input?.unreadChunkKeys ?? []).map(str).filter((key) => key !== ''))];
  // 候选一律取消发布：不判断「这条候选是不是刚好用了那条来源」，许可没了就不发。
  const cancelledCandidateIds = [...new Set((input?.pendingCandidateIds ?? []).map(str).filter((id) => id !== ''))];
  return {
    blockedChunkKeys,
    cancelledCandidateIds,
    keptTargetIds: [...new Set((input?.alreadyProducedTargetIds ?? []).map(str).filter((id) => id !== ''))],
    runTicketInvalidated: true,
    issues: [issue(
      'LORE_RUN_TICKET_INVALIDATED',
      '$.sources',
      '读取许可已变化：本次 run ticket 失效，未提交候选作废；已完成的事实与地图保留',
      'warning',
    )],
  };
}

/**
 * §19.2：旧 hash 的未读内容已经拿不到时，如实标注，不用新文本冒充旧 hash 已扫描。
 */
export function planStaleHashReplacement(input: {
  oldContentHash: string;
  newContentHash: string;
  oldUnreadChunkKeys?: readonly string[];
}): {
  supersededChunkKeys: string[];
  resumeWithHash: string;
  acceptsOldHashAsScanned: false;
  issues: Issue[];
} {
  const oldHash = str(input?.oldContentHash);
  const newHash = str(input?.newContentHash);
  const supersededChunkKeys = [...new Set((input?.oldUnreadChunkKeys ?? []).map(str).filter((key) => key !== ''))];
  const issues: Issue[] = [];
  if (oldHash !== '' && newHash !== '' && oldHash !== newHash) {
    issues.push(issue(
      'LORE_STALE_HASH_SUPERSEDED',
      '$.sources',
      `旧内容 ${oldHash.slice(0, 8)} 的未读块已不可获取：标记 superseded，后续增量按 ${newHash.slice(0, 8)} 继续；不把新文本当成旧 hash 已扫描`,
      'warning',
    ));
  }
  return { supersededChunkKeys, resumeWithHash: newHash, acceptsOldHashAsScanned: false, issues };
}

/**
 * §19.1：只有**作者明确要求**来源的内部目标才「等实际进入」。
 *
 * 普通来源缺 `source-required` 的目标继续往下建，不因为「还没进过那儿」把整个 job 卡住。
 */
export function shouldWaitForEntry(input: {
  targetRequiresEntry: boolean;
  targetKind?: string;
  hasUnreadChunks?: boolean;
}): { wait: boolean; reason: 'ENTRY_REQUIRED' | 'UNREAD_CHUNKS' | 'PROCEED' } {
  if (input?.hasUnreadChunks === true) return { wait: false, reason: 'UNREAD_CHUNKS' };
  if (input?.targetRequiresEntry === true) return { wait: true, reason: 'ENTRY_REQUIRED' };
  return { wait: false, reason: 'PROCEED' };
}
