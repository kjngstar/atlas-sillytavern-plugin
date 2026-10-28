/**
 * atlas-world-build-state.ts — 世界建设任务在既有 construction_progress 上的版本化编码（P01）。
 *
 * 来源：执行计划 v2 §5.1、§5.2。这里**不新建第二套任务表**，全部落在 schema3 的
 * construction_progress 上，靠 `scope_key` + `subject_key` + payload 标识区分逻辑记录：
 *
 *   job     → scope  / scope_key=world-build:<jobId>  / subject_key=job
 *   target  → target / scope_key=world-build:<jobId>  / subject_key=target:<targetId>
 *   fact    → target / scope_key=world-facts:v1       / subject_key=fact:<factId>
 *
 * 纪律：
 * - payload 必须带 `payloadKind`，读取方先认 kind 再解码；旧行没有这个字段，
 *   一律当「旧 bootstrap/建设进度」处理，不猜、不升级、不删除。
 * - SQL 的四个 status 只是粗粒度；精确状态在 payload 里，`suspended` 可能是
 *   paused / waiting-for-entry / blocked / failed / cancelled 中的任何一个。
 * - 审计字段由 `progressRowMutation` 统一计算，本模块不自己拼 after。
 * - 单行 payload 有预算，超了直接报错——说明调用方把不该塞的 ID 塞进来了。
 */

import { stableHexHash } from './atlas-hash.ts';
import type { AtomicGroup, RowMutation } from './atlas-ops-contract.ts';
import {
  UNIT_TARGET_LIMIT,
  progressId,
  progressRowMutation,
  type ProgressMutationContext,
  type ProgressRow,
} from './atlas-construction-progress.ts';
import { rotationOrder, type ScheduledUnit } from './atlas-construction-scheduler.ts';
import type { WorldBuildCoverageV1 } from './atlas-world-contract.ts';
import {
  NPC_PLACEMENT_RECORD_KIND,
  npcPlacementRecordsFromProgress,
  type NpcPlacementRecord,
} from './atlas-world-build-plan.ts';
import type { SourceCoverageV1 } from './atlas-world-build-plan.ts';
import {
  WORLD_BUILD_JOB_PAYLOAD_KIND,
  WORLD_BUILD_TARGET_PAYLOAD_KIND,
  WORLD_FACT_PAYLOAD_KIND,
  WORLD_FACTS_SCOPE_KEY,
  decodeWorldBuildJob,
  decodeWorldBuildTarget,
  sqlStatusForJobStatus,
  sqlStatusForTargetStatus,
  worldBuildScopeKey,
  worldBuildTargetSubjectKey,
  worldFactSubjectKey,
  type WorldBuildJobKind,
  type WorldBuildJobStatus,
  type WorldBuildJobV1,
  type WorldBuildBatchTicketV1,
  type WorldBuildRequirement,
  type WorldBuildTargetV1,
  type WorldBuildWorkKind,
  type WorldBuildDecodeIssue,
} from './atlas-world-build-contract.ts';
import { decodeWorldFact, type WorldFactV1 } from './atlas-world-fact-policy.ts';

/**
 * 单行 payload 预算。
 *
 * 计划 §5.1：job 不内嵌全部目标和全文世界书。这里只限制分页后的建设账本元数据为 8 KiB；不限制模型操作内容；
 * 超出说明有调用方在往 payload 里倒世界清单，应当改成 target/fact 分页。
 */
export const WORLD_BUILD_PAYLOAD_BUDGET_BYTES = 8 * 1024;

/** payload 里的类型标识字段名。旧行没有它。 */
export const PAYLOAD_KIND_FIELD = 'payloadKind';

/* ------------------------------------------------------------------ *
 * 1 编码
 * ------------------------------------------------------------------ */

function utf8Bytes(text: string): number {
  // Node 与浏览器都有 TextEncoder；不用 Buffer，保证 Worker 可用。
  return new TextEncoder().encode(text).length;
}

function assertPayloadBudget(label: string, payload: Record<string, unknown>): void {
  const bytes = utf8Bytes(JSON.stringify(payload));
  if (bytes > WORLD_BUILD_PAYLOAD_BUDGET_BYTES) {
    throw new Error(
      `${label} payload ${bytes} 字节超过 ${WORLD_BUILD_PAYLOAD_BUDGET_BYTES} 字节预算：`
      + '任务不内嵌世界清单，目标与事实必须分页存成独立行',
    );
  }
}

/** job → payload。字段顺序固定，便于比对与测试。 */
export function encodeWorldBuildJobPayload(job: WorldBuildJobV1): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    [PAYLOAD_KIND_FIELD]: WORLD_BUILD_JOB_PAYLOAD_KIND,
    version: job.version,
    id: job.id,
    branchId: job.branchId,
    kind: job.kind,
    status: job.status,
    sourceManifestHash: job.sourceManifestHash,
    policyVersion: job.policyVersion,
    originFloorId: job.originFloorId,
    runEpoch: job.runEpoch,
    nextWindowSequence: job.nextWindowSequence,
    committedWindowSequence: job.committedWindowSequence,
    cumulativeTransports: job.cumulativeTransports,
    cumulativeWindows: job.cumulativeWindows,
    stopReason: job.stopReason,
  };
  assertPayloadBudget('world-build-job', payload);
  return payload;
}

/** target → payload。依赖列表与错误指纹都在有界字段里。 */
export function encodeWorldBuildTargetPayload(target: WorldBuildTargetV1): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    [PAYLOAD_KIND_FIELD]: WORLD_BUILD_TARGET_PAYLOAD_KIND,
    version: target.version,
    id: target.id,
    jobId: target.jobId,
    subjectId: target.subjectId,
    workKind: target.workKind,
    requirement: target.requirement,
    depth: target.depth,
    dependencyIds: [...target.dependencyIds],
    inputSignature: target.inputSignature,
    status: target.status,
    attempts: target.attempts,
    failureFingerprint: target.failureFingerprint,
    lastErrorCode: target.lastErrorCode,
    originFloorId: target.originFloorId,
    eventId: target.eventId,
  };
  assertPayloadBudget('world-build-target', payload);
  return payload;
}

/**
 * 事实 → payload。
 *
 * 只存短字段与来源定位（sourceKey/hash/span），**不复制世界书全文**：
 * 断言是出处与冲突层，正文与几何仍由业务行承载。
 */
export function encodeWorldFactPayload(fact: WorldFactV1): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    [PAYLOAD_KIND_FIELD]: WORLD_FACT_PAYLOAD_KIND,
    version: fact.version,
    id: fact.id,
    subjectId: fact.subjectId,
    predicate: fact.predicate,
    layer: fact.layer,
    origin: fact.origin,
    producer: fact.producer,
    sourceKey: fact.sourceKey,
    sourceHash: fact.sourceHash,
    sourceSpan: fact.sourceSpan,
    quality: fact.quality,
    effectiveTurnId: fact.effectiveTurnId,
    effectiveClockS: fact.effectiveClockS,
    supersedesFactId: fact.supersedesFactId,
    value: fact.value,
  };
  assertPayloadBudget('world-fact', payload);
  return payload;
}

/* ------------------------------------------------------------------ *
 * 2 稳定身份（行 ID 与 subject_key）
 * ------------------------------------------------------------------ */

export function worldBuildJobRowId(jobId: string): string {
  return progressId('scope', worldBuildScopeKey(jobId), 'job');
}

export function worldBuildTargetRowId(jobId: string, targetId: string): string {
  return progressId('target', worldBuildScopeKey(jobId), worldBuildTargetSubjectKey(targetId));
}

export function worldFactRowId(factId: string): string {
  return progressId('target', WORLD_FACTS_SCOPE_KEY, worldFactSubjectKey(factId));
}

/** job 行的输入签名：来源清单变了才需要重算，运行进度不参与签名。 */
export function worldBuildJobSignature(job: WorldBuildJobV1): string {
  return stableHexHash(['world-build-job', job.sourceManifestHash, job.policyVersion].join('\u0000'));
}

/* ------------------------------------------------------------------ *
 * 3 变更构造（交给 applyGroups / ACK）
 * ------------------------------------------------------------------ */

export function worldBuildJobMutation(
  ctx: ProgressMutationContext,
  before: Record<string, unknown> | null,
  job: WorldBuildJobV1,
): RowMutation {
  return progressRowMutation(
    ctx,
    {
      id: worldBuildJobRowId(job.id),
      scopeKey: worldBuildScopeKey(job.id),
      kind: 'scope',
      subjectKey: 'job',
    },
    before,
    {
      inputSignature: worldBuildJobSignature(job),
      status: sqlStatusForJobStatus(job.status),
      payload: encodeWorldBuildJobPayload(job),
    },
  );
}

export function worldBuildTargetMutation(
  ctx: ProgressMutationContext,
  before: Record<string, unknown> | null,
  target: WorldBuildTargetV1,
): RowMutation {
  return progressRowMutation(
    ctx,
    {
      id: worldBuildTargetRowId(target.jobId, target.id),
      scopeKey: worldBuildScopeKey(target.jobId),
      kind: 'target',
      subjectKey: worldBuildTargetSubjectKey(target.id),
    },
    before,
    {
      inputSignature: target.inputSignature,
      status: sqlStatusForTargetStatus(target.status),
      payload: encodeWorldBuildTargetPayload(target),
    },
  );
}

export function worldFactMutation(
  ctx: ProgressMutationContext,
  before: Record<string, unknown> | null,
  fact: WorldFactV1,
  /** 剧情驱动的状态事实可以显式给依据；缺省仍是「程序记账」。 */
  basis?: Record<string, unknown>,
): RowMutation {
  return progressRowMutation(
    ctx,
    {
      id: worldFactRowId(fact.id),
      scopeKey: WORLD_FACTS_SCOPE_KEY,
      kind: 'target',
      subjectKey: worldFactSubjectKey(fact.id),
    },
    before,
    {
      inputSignature: stableHexHash([
        'world-fact',
        fact.subjectId,
        fact.predicate,
        fact.effectiveTurnId,
        String(fact.effectiveClockS ?? ''),
      ].join('\u0000')),
      // 事实行不是「待建设工作」，用 processed 表示已记账；真实层信息在 payload 里。
      status: 'processed',
      payload: encodeWorldFactPayload(fact),
      ...(basis ? { basis } : {}),
    },
  );
}

/* ------------------------------------------------------------------ *
 * 4 读取：先认 namespace 与 payloadKind，再解码
 * ------------------------------------------------------------------ */

/** 从已解码的进度行里读 payload 标识；旧行没有这个字段时返回 null。 */
export function progressRowPayloadKind(row: ProgressRow): string | null {
  const raw = row.payload[PAYLOAD_KIND_FIELD];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

export function isWorldBuildJobRow(row: ProgressRow): boolean {
  return progressRowPayloadKind(row) === WORLD_BUILD_JOB_PAYLOAD_KIND;
}

export function isWorldBuildTargetRow(row: ProgressRow): boolean {
  return progressRowPayloadKind(row) === WORLD_BUILD_TARGET_PAYLOAD_KIND;
}

export function isWorldFactRow(row: ProgressRow): boolean {
  return progressRowPayloadKind(row) === WORLD_FACT_PAYLOAD_KIND;
}

/**
 * 旧建设进度行（0.9.x 的 bootstrap/local 进度、工作单元、来源账本）。
 * 判据是「没有 payloadKind」——不是「scope_key 长得像旧格式」，避免误伤新行。
 */
export function isLegacyConstructionRow(row: ProgressRow): boolean {
  return progressRowPayloadKind(row) === null;
}

/* —— P11 §17.1 NPC 一次性初始放置记录 —— */

/**
 * 放置记录也写进 `construction_progress`，用同一个 payloadKind 机制区分。
 *
 * 为什么不新建一张表：一次性记录本来就是「进度」，放进进度账本才能和
 * `target` 行一起被同一次分页扫描读到，也不需要升 schema 版本。
 */
export function isNpcPlacementRow(row: ProgressRow): boolean {
  const kind = progressRowPayloadKind(row);
  return kind === NPC_PLACEMENT_RECORD_KIND || row.payload.kind === NPC_PLACEMENT_RECORD_KIND;
}

/**
 * §17.1：读回「已经安排过初始位置的 NPC」。
 *
 * 这是 wiring 层唯一的读取口：`planNpcInitialPlacement` 拿到它就不会再安排第二遍，
 * 也就不会出现「每次更新都把他送回家」。
 */
export function readNpcPlacementRecords(rows: readonly ProgressRow[]): WorldBuildReadResult<NpcPlacementRecord> {
  const values: NpcPlacementRecord[] = [];
  const issues: WorldBuildRowIssue[] = [];
  let rejectedRows = 0;

  for (const row of rows) {
    if (!isNpcPlacementRow(row)) continue;
    if (!row.payloadOk) {
      rejectedRows += 1;
      issues.push({
        path: `row.${row.id}.payload_json`,
        code: 'NPC_PLACEMENT_PAYLOAD_UNREADABLE',
        message: '放置记录 payload 不是合法 JSON 对象；本次按「没安排过」处理，但会重新估计一次',
        rowId: row.id,
        scopeKey: row.scopeKey,
      });
      continue;
    }
    const records = npcPlacementRecordsFromProgress([{ payload: row.payload }]);
    if (records.length === 0) {
      rejectedRows += 1;
      issues.push({
        path: `row.${row.id}.payload_json`,
        code: 'NPC_PLACEMENT_RECORD_INCOMPLETE',
        message: '放置记录缺少 characterId/locationId，不能当作已放置',
        rowId: row.id,
        scopeKey: row.scopeKey,
      });
      continue;
    }
    values.push(...records);
  }
  return { values, issues, rejectedRows };
}

/** 读取问题：比通用解码问题多带行 ID 与 scope，方便定位到具体那一行。 */
export type WorldBuildRowIssue = WorldBuildDecodeIssue & { rowId: string; scopeKey: string };

export type WorldBuildReadResult<T> = {
  values: T[];
  issues: WorldBuildRowIssue[];
  /** 有 job/target/fact 标识但 payload 损坏或版本不认识的行数。 */
  rejectedRows: number;
};

function collectIssues(row: ProgressRow, issues: readonly WorldBuildDecodeIssue[]): WorldBuildRowIssue[] {
  return issues.map((issue) => ({ ...issue, rowId: row.id, scopeKey: row.scopeKey }));
}

/** 读全部建设任务（按 jobId 去重：同一 job 的 scope 行只有一个）。 */
export function readWorldBuildJobs(rows: readonly ProgressRow[]): WorldBuildReadResult<WorldBuildJobV1> {
  const values: WorldBuildJobV1[] = [];
  const issues: WorldBuildRowIssue[] = [];
  let rejectedRows = 0;

  for (const row of rows) {
    if (!isWorldBuildJobRow(row)) continue;
    if (!row.payloadOk) {
      rejectedRows += 1;
      issues.push({
        path: `row.${row.id}.payload_json`,
        code: 'WORLD_BUILD_PAYLOAD_UNREADABLE',
        message: 'payload 不是合法 JSON 对象',
        rowId: row.id,
        scopeKey: row.scopeKey,
      });
      continue;
    }
    const decoded = decodeWorldBuildJob(row.payload);
    if (!decoded.ok) {
      rejectedRows += 1;
      issues.push(...collectIssues(row, decoded.issues));
      continue;
    }
    values.push(decoded.value);
  }

  values.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return { values, issues, rejectedRows };
}

/** 读某个 job 下的目标；不给 jobId 时读全部。 */
export function readWorldBuildTargets(
  rows: readonly ProgressRow[],
  jobId?: string,
): WorldBuildReadResult<WorldBuildTargetV1> {
  const values: WorldBuildTargetV1[] = [];
  const issues: WorldBuildRowIssue[] = [];
  let rejectedRows = 0;

  for (const row of rows) {
    if (!isWorldBuildTargetRow(row)) continue;
    if (!row.payloadOk) {
      rejectedRows += 1;
      issues.push({
        path: `row.${row.id}.payload_json`,
        code: 'WORLD_BUILD_PAYLOAD_UNREADABLE',
        message: 'payload 不是合法 JSON 对象',
        rowId: row.id,
        scopeKey: row.scopeKey,
      });
      continue;
    }
    const decoded = decodeWorldBuildTarget(row.payload);
    if (!decoded.ok) {
      rejectedRows += 1;
      issues.push(...collectIssues(row, decoded.issues));
      continue;
    }
    if (jobId !== undefined && decoded.value.jobId !== jobId) continue;
    values.push(decoded.value);
  }

  values.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return { values, issues, rejectedRows };
}

/** 读全部来源断言。 */
export function readWorldFacts(rows: readonly ProgressRow[]): WorldBuildReadResult<WorldFactV1> {
  const values: WorldFactV1[] = [];
  const issues: WorldBuildRowIssue[] = [];
  let rejectedRows = 0;

  for (const row of rows) {
    if (!isWorldFactRow(row)) continue;
    if (!row.payloadOk) {
      rejectedRows += 1;
      issues.push({
        path: `row.${row.id}.payload_json`,
        code: 'WORLD_FACT_PAYLOAD_UNREADABLE',
        message: 'payload 不是合法 JSON 对象',
        rowId: row.id,
        scopeKey: row.scopeKey,
      });
      continue;
    }
    const decoded = decodeWorldFact(row.payload);
    if (!decoded.ok) {
      rejectedRows += 1;
      issues.push(...collectIssues(row, decoded.issues));
      continue;
    }
    values.push(decoded.value);
  }

  values.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return { values, issues, rejectedRows };
}

/**
 * 供旧扫描器使用的过滤：只保留「不是新契约行」的记录。
 *
 * 为什么需要它：`readProgressRows` 会把整张表读出来，旧 bootstrap 扫描器按
 * `rowsInScope(rows, 'bootstrap', ...)` 过滤虽然不会命中新行，但任何按 kind 全表统计的
 * 代码（覆盖率、行数上限）都会把事实行算进去。显式过滤比「恰好不冲突」可靠。
 */
export function legacyConstructionRows(rows: readonly ProgressRow[]): ProgressRow[] {
  return rows.filter((row) => isLegacyConstructionRow(row));
}

/* ------------------------------------------------------------------ *
 * 5 输入签名（§10.3）
 * ------------------------------------------------------------------ */

/**
 * 目标输入签名的**唯一**构造点。
 *
 * 只吃「让目标失效的东西」：主体身份、工作类别、要求、深度、依赖、明确来源 hash、
 * 设施方案版本、真实事件 ID。**刻意不接受** row_rev / 日志时间 / 进度状态 /
 * 自动生成坐标 / 本任务自产描述 —— 那些每轮都在变，进了签名就等于每轮重发。
 */
export type WorldBuildTargetSignatureInput = {
  subjectId: string | null;
  workKind: WorldBuildWorkKind;
  requirement: WorldBuildRequirement;
  depth: number;
  dependencyIds: readonly string[];
  /** 明确来源内容 hash（无序传入，内部排序后参与签名）。 */
  sourceHashes?: readonly string[];
  /** 设施方案版本 / 方案签名；方案没变就不该重排设施目标。 */
  settlementPlanVersion?: string | null;
  /** 真实事件（拆除、改建）ID；普通刷新不产生事件。 */
  eventId?: string | null;
};

export function worldBuildTargetInputSignature(input: WorldBuildTargetSignatureInput): string {
  return stableHexHash([
    'world-build-target',
    `subject:${input.subjectId ?? ''}`,
    `work:${input.workKind}`,
    `requirement:${input.requirement}`,
    `depth:${Math.max(0, Math.floor(input.depth))}`,
    `deps:${[...(input.dependencyIds ?? [])].map(String).sort().join(',')}`,
    `sources:${[...(input.sourceHashes ?? [])].map(String).sort().join(',')}`,
    `plan:${input.settlementPlanVersion ?? ''}`,
    `event:${input.eventId ?? ''}`,
  ].join('\u0001'));
}

/* ------------------------------------------------------------------ *
 * 6 只读规划：目标账目、覆盖与 job 状态（§10.2）
 * ------------------------------------------------------------------ */

/** 覆盖账目：必建分母按状态四分，**必须**与 requiredTargets 对齐。 */
export function countBuildTargets(targets: readonly WorldBuildTargetV1[]): {
  requiredTargets: number;
  requiredDone: number;
  requiredPending: number;
  requiredFailed: number;
  requiredBlocked: number;
  deferredInteriors: number;
  cancelled: number;
} {
  let requiredDone = 0;
  let requiredPending = 0;
  let requiredFailed = 0;
  let requiredBlocked = 0;
  let deferredInteriors = 0;
  let cancelled = 0;

  for (const target of targets) {
    switch (target.status) {
      case 'done':
        requiredDone += 1;
        break;
      case 'pending':
      case 'running':
        requiredPending += 1;
        break;
      case 'failed':
        requiredFailed += 1;
        break;
      case 'blocked':
        requiredBlocked += 1;
        break;
      case 'waiting-for-entry':
        // 不计必建分母、不算失败、也不阻止初始化结束（§10.2 第 3 条）。
        deferredInteriors += 1;
        break;
      case 'cancelled':
        cancelled += 1;
        break;
    }
    if (target.requirement === 'deferred-interior' && target.status !== 'done' && target.status !== 'waiting-for-entry') {
      deferredInteriors += 1;
    }
  }

  return {
    requiredTargets: requiredDone + requiredPending + requiredFailed + requiredBlocked,
    requiredDone,
    requiredPending,
    requiredFailed,
    requiredBlocked,
    deferredInteriors,
    cancelled,
  };
}

/** 发现是否做完：来源扫描与设施方案这两类工作不再有在途目标。 */
export function isDiscoveryComplete(targets: readonly WorldBuildTargetV1[]): boolean {
  return !targets.some(
    (target) => (target.workKind === 'source-scan' || target.workKind === 'settlement-plan')
      && (target.status === 'pending' || target.status === 'running'),
  );
}

/**
 * 组装 `WorldBuildCoverageV1`。
 *
 * `readyMaps` 由调用方按真实地图表给：这里不猜、不默认 0 —— 默认 0 会让
 * 「一张图都没 ready」看起来像「不需要图」，两者完全不同。
 */
export function buildWorldBuildCoverage(input: {
  job: WorldBuildJobV1;
  targets: readonly WorldBuildTargetV1[];
  sourceScanComplete: boolean;
  settlementPlansExpanded: boolean;
  maps: { registered: number; ready: number };
}): WorldBuildCoverageV1 {
  const counts = countBuildTargets(input.targets);
  const registeredMaps = Math.max(0, Math.floor(input.maps.registered));
  const readyMaps = Math.min(registeredMaps, Math.max(0, Math.floor(input.maps.ready)));
  const scopeSealed = input.sourceScanComplete && input.settlementPlansExpanded && isDiscoveryComplete(input.targets);
  return {
    version: 1,
    sourceScanComplete: input.sourceScanComplete,
    scopeSealed,
    requiredTargets: counts.requiredTargets,
    requiredDone: counts.requiredDone,
    requiredPending: counts.requiredPending,
    requiredFailed: counts.requiredFailed,
    requiredBlocked: counts.requiredBlocked,
    deferredInteriors: counts.deferredInteriors,
    registeredMaps,
    readyMaps,
    cumulativeTransports: Math.max(0, Math.floor(input.job.cumulativeTransports)),
    completedWithIssues: counts.requiredPending === 0 && (counts.requiredFailed > 0 || counts.requiredBlocked > 0),
  };
}

/**
 * 本窗口之后 job 应该是什么状态（§10.2）。
 *
 * - 还有在途必建 → running（`paused` 保持 paused，不因为一次调度就把暂停的活拉起来）；
 * - 在途清零且有失败/阻塞 → completed-with-issues，并释放初始化优先屏障；
 * - 在途清零且干净 → completed；
 * - cancelled 是终局，不会被自动改回。
 */
export function nextJobStatus(job: WorldBuildJobV1, coverage: WorldBuildCoverageV1): WorldBuildJobStatus {
  if (job.status === 'cancelled') return 'cancelled';
  if (job.status === 'paused') return 'paused';
  if (coverage.requiredPending > 0) return 'running';
  if (coverage.requiredFailed > 0 || coverage.requiredBlocked > 0) return 'completed-with-issues';
  return 'completed';
}

/* ------------------------------------------------------------------ *
 * 7 写入计划（只规划，不落库）
 * ------------------------------------------------------------------ */

export type WorldBuildStateInput = {
  job: WorldBuildJobV1;
  /** 本 job 已持久的目标（分页读出来，不在内存里全量）。 */
  targets: readonly WorldBuildTargetV1[];
  /** 本次发现新增的目标；同 ID 覆盖已存在的目标。 */
  discoveredTargets?: readonly WorldBuildTargetV1[];
  /** §9.1 来源覆盖：`sourceScanComplete` 只认它，不认「看起来读完了」。 */
  coverage: SourceCoverageV1;
  settlementPlansExpanded: boolean;
  maps: { registered: number; ready: number };
  ctx: ProgressMutationContext;
  /** 现有行原值（按 rowId），用于 before 与乐观并发 readSet。 */
  beforeRows?: ReadonlyMap<string, Record<string, unknown> | null>;
};

export type WorldBuildStatePlan = {
  groups: AtomicGroup[];
  coverage: WorldBuildCoverageV1;
  /** 规划后的 job（含状态变化）；调用方拿它更新内存态，不代表已落库。 */
  job: WorldBuildJobV1;
};

function mergeTargets(
  targets: readonly WorldBuildTargetV1[],
  discovered: readonly WorldBuildTargetV1[],
): WorldBuildTargetV1[] {
  const byId = new Map<string, WorldBuildTargetV1>();
  for (const target of targets) byId.set(target.id, target);
  for (const target of discovered) byId.set(target.id, target);
  return [...byId.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/**
 * §10：把一个窗口的发现结果表达成**原子组**。
 *
 * 只做三件事：合并目标账目、算覆盖、把状态变化写成 construction_progress 行。
 * 不调用模型、不写业务表、不碰几何 —— 那些由编译链与 ACK 负责。
 */
export function planWorldBuildMutation(input: WorldBuildStateInput): WorldBuildStatePlan {
  const targets = mergeTargets(input.targets ?? [], input.discoveredTargets ?? []);
  const sourceCoverage = buildWorldBuildCoverage({
    job: input.job,
    targets,
    sourceScanComplete: input.coverage?.sourceScanComplete === true,
    settlementPlansExpanded: input.settlementPlansExpanded === true,
    maps: input.maps,
  });

  const status = nextJobStatus(input.job, sourceCoverage);
  const job: WorldBuildJobV1 = {
    ...input.job,
    status,
    // 只有真的提交成功才推进窗口序号；这里只规划，所以沿用原值。
    stopReason: status === 'completed-with-issues'
      ? `存在 ${sourceCoverage.requiredFailed} 个失败 / ${sourceCoverage.requiredBlocked} 个阻塞目标`
      : input.job.stopReason,
  };

  const beforeRows = input.beforeRows ?? new Map<string, Record<string, unknown> | null>();
  const mutations: RowMutation[] = [];
  const readSet: Array<{ table: string; rowId: string; rowRev: number }> = [];

  const jobRowId = worldBuildJobRowId(job.id);
  const jobBefore = beforeRows.get(jobRowId) ?? null;
  const jobChanged = !jobBefore || jobBefore['payload_json'] !== JSON.stringify(encodeWorldBuildJobPayload(job));
  if (jobChanged) {
    mutations.push(worldBuildJobMutation(input.ctx, jobBefore, job));
    readSet.push({ table: 'construction_progress', rowId: jobRowId, rowRev: Number(jobBefore?.row_rev ?? 0) });
  }

  for (const target of input.discoveredTargets ?? []) {
    const rowId = worldBuildTargetRowId(target.jobId, target.id);
    const before = beforeRows.get(rowId) ?? null;
    // 同签名同状态的目标不重写：刷新/重复发现不该产生新行版本（§10.3）。
    if (before?.['payload_json'] === JSON.stringify(encodeWorldBuildTargetPayload(target))) continue;
    mutations.push(worldBuildTargetMutation(input.ctx, before, target));
    readSet.push({ table: 'construction_progress', rowId, rowRev: Number(before?.row_rev ?? 0) });
  }

  const groups: AtomicGroup[] = mutations.length === 0 ? [] : [{
    id: `world-build:${job.id}:state:${stableHexHash(mutations.map((item) => `${item.rowId}:${JSON.stringify(item.after)}`).join('|')).slice(0, 12)}`,
    opIds: [],
    dependsOn: [],
    readSet: readSet.sort((left, right) => (left.rowId < right.rowId ? -1 : left.rowId > right.rowId ? 1 : 0)),
    mutations,
    // 程序记账组：写的是进度表，不是世界业务变化（§15.4.13）。
    purpose: 'bookkeeping',
  }];

  return { groups, coverage: sourceCoverage, job };
}

/* ------------------------------------------------------------------ *
 * 10 在途失效（§11.3）
 * ------------------------------------------------------------------ */

/**
 * 作废当前在途运行：回退 / 重生成 / 切聊天 / 切分支 / 停止都调它。
 *
 * 三件事必须同时发生，少一件就会让旧响应写进新时间线：
 * 1. `runEpoch` 自增 —— 旧票据的 `epoch-stale` 判定靠它，不靠 wall time；
 * 2. 进行中的 job 降为 `paused` —— 本轮不再自动接着发；
 * 3. `cumulativeTransports` **保持不变** —— 已经发生的网络发送是历史消耗，
 *    回退不能把它退回去，导出时要区分「历史发送」与「当前有效累计」（§11.2）。
 */
export function invalidateBuildRun(job: WorldBuildJobV1, reason: string): WorldBuildJobV1 {
  const stopped = job.status === 'running' || job.status === 'pending';
  return {
    ...job,
    runEpoch: Math.max(0, Math.floor(job.runEpoch)) + 1,
    status: job.status === 'cancelled' ? 'cancelled' : stopped ? 'paused' : job.status,
    stopReason: reason.length > 0 ? reason : job.stopReason,
    cumulativeTransports: Math.max(0, Math.floor(job.cumulativeTransports)),
  };
}

/**
 * 批次入库前的最后一道守卫（§11.1、§11.4）。
 *
 * - 只允许**依附当前有效 head** 提交：`ownerFloorId` 必须是当前 head，防止把本批结果
 *   追加到旧楼层末尾伪装成「开局时早就生成了」；
 * - `originFloorId`（任务起因）与 `causalFloorId`（事件所在楼层）可以不同，但都必须存在；
 * - `requested` 不等于 `saved`：没有 saved ACK 时不得推进 `committedWindowSequence`。
 */
export function validateBatchCommit(input: {
  ticket: WorldBuildBatchTicketV1;
  /** job 上记录的任务起因楼层（票据本身不重复存）。 */
  jobOriginFloorId: string;
  currentHeadTurnId: string;
  savedAck: boolean;
}): { ok: true } | { ok: false; code: string; message: string } {
  const { ticket } = input;
  const head = String(input.currentHeadTurnId ?? '').trim();
  if (head.length === 0) {
    return { ok: false, code: 'WORLD_BUILD_HEAD_MISSING', message: '当前分支没有有效 head，无法确定本批该依附哪个楼层。' };
  }
  if (ticket.ownerFloorId !== head) {
    return {
      ok: false,
      code: 'WORLD_BUILD_CROSS_FLOOR_COMMIT',
      message: `本批声明的依附楼层是 ${ticket.ownerFloorId}，但当前有效 head 是 ${head}：不允许跨楼层提交，也不允许往旧楼层末尾追加记录。`,
    };
  }
  if (String(input.jobOriginFloorId ?? '').trim().length === 0) {
    return { ok: false, code: 'WORLD_BUILD_ORIGIN_FLOOR_MISSING', message: '批次必须能追到任务起因楼层（job.originFloorId）。' };
  }
  if (!input.savedAck) {
    return {
      ok: false,
      code: 'WORLD_BUILD_SAVE_NOT_ACKED',
      message: '没有 SaveAck.result=saved：requested 不等于 saved，本批不推进 committedWindowSequence，也不标记目标完成。',
    };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * 11 有界分页扫描（§10.3）
 * ------------------------------------------------------------------ */

/** 目录 / 进度行扫描的默认页大小。页大小是**有界**的，游标不是。 */
export const WORLD_BUILD_SCAN_PAGE_SIZE = 200;

export type WorldBuildTargetPage = {
  targets: WorldBuildTargetV1[];
  /** 下一窗口从这里继续；null 表示这一页之后没有更多。 */
  nextCursor: string | null;
  /** 本页是否已经扫到末尾。**不等于**世界结束——世界是否结束看 cursor 与总数。 */
  pageExhausted: boolean;
  /** 全量里还有多少个目标没扫到（用于证明「超过一页也没漏」）。 */
  remainingAfter: number;
};

/**
 * 分页读目标：游标持久、页有界。
 *
 * 绝不 `selectWhere(..., 1000)` 之后把「读到的最后一条」当世界结尾 —— 游标为 null
 * 只代表这一页读完了；调用方必须自己把 cursor 存下来继续扫。
 */
export function readWorldBuildTargetsPage(
  targets: readonly WorldBuildTargetV1[],
  cursor: string | null,
  pageSize = WORLD_BUILD_SCAN_PAGE_SIZE,
): WorldBuildTargetPage {
  const ordered = [...(targets ?? [])].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const size = Math.max(1, Math.floor(Number.isFinite(pageSize) ? pageSize : WORLD_BUILD_SCAN_PAGE_SIZE));
  let from = 0;
  if (cursor !== null && cursor.length > 0) {
    // `findIndex` 找不到更大的 ID 时返回 -1：那表示**已经扫到末尾**，
    // 不能 `Math.max(0, -1)` 变成 0 —— 那会把整页从头再读一遍，永远不会结束。
    const found = ordered.findIndex((target) => target.id > cursor);
    from = found < 0 ? ordered.length : found;
  }
  const page = ordered.slice(from, from + size);
  const remainingAfter = Math.max(0, ordered.length - from - page.length);
  return {
    targets: page,
    nextCursor: remainingAfter > 0 ? page[page.length - 1]?.id ?? null : null,
    pageExhausted: remainingAfter === 0,
    remainingAfter,
  };
}

/* ------------------------------------------------------------------ *
 * 9 调度：选下一批工作单元（§10.1）
 * ------------------------------------------------------------------ */

export const BUILD_BLOCKED_CODES = [
  /** 初始化还没结束，期间新增的增量工作让路。 */
  'INITIALIZATION_PRIORITY',
  /** 依赖还没做完（含依赖还在排队）。 */
  'DEPENDENCY_NOT_DONE',
  /** 依赖已经失败 / 阻塞：不重做，等明确重试或新资料。 */
  'DEPENDENCY_FAILED',
  /** 依赖是延后内部：子空间跟着等剧情进入。 */
  'DEPENDENCY_WAITING_FOR_ENTRY',
  /** 这个目标自己在等剧情进入。 */
  'WAITING_FOR_ENTRY',
  /** 本窗口预算装不下，显式延期。 */
  'BUDGET_DEFERRED',
] as const;
export type BuildBlockedCode = (typeof BUILD_BLOCKED_CODES)[number];

export type BuildBlockedReason = {
  targetId: string;
  code: BuildBlockedCode;
  /** 造成阻塞的依赖 / job；没有具体对象时为 null。 */
  dependencyId: string | null;
  message: string;
};

export type BuildUnitV1 = {
  unitId: string;
  jobId: string;
  jobKind: WorldBuildJobKind;
  workKind: WorldBuildWorkKind;
  targetIds: readonly string[];
  depth: number;
  status: 'pending' | 'retry';
  attemptCount: number;
};

/**
 * 层级推进顺序（§10.1）：来源发现 → 城镇设施方案 → 实体建设（世界/区域→城镇→建筑→内部）
 * → 地图布局 → 路线对账 → NPC 初始位置 → 状态对齐。
 *
 * 上层先给子空间提供身份与共享边界估计，再细化内部；不写成父子互等的循环依赖。
 */
export const WORLD_BUILD_WORK_LAYERS: Record<WorldBuildWorkKind, number> = {
  'source-scan': 0,
  'settlement-plan': 1,
  'entity-construction': 2,
  'map-layout': 3,
  'route-reconcile': 4,
  'npc-initial-placement': 5,
  'state-reconcile': 6,
};

export type WorldBuildScheduleInput = {
  job: WorldBuildJobV1;
  targets: readonly WorldBuildTargetV1[];
  /** 已提交的来源覆盖；来源没扫完时先做扫描，不做实体建设。 */
  sourceScanComplete: boolean;
  /** 现有预算设置（非 noop 操作共同总额与分类上限）。 */
  policy: { totalOperations: number; maxNewLocations: number; maxNewRoutes: number };
  branchId: string;
  /** 当前有效楼层；票据不授权跨楼层提交。 */
  currentFloorId: string;
  /** 本窗口最多选几个单元。 */
  limit?: number;
  /** 持久调度序号：3 新 : 1 重试的轮转位置由它决定。 */
  schedulerSeq?: number;
  /** 同分支的其他 job：初始化优先于期间新增的增量工作。 */
  otherJobs?: readonly WorldBuildJobV1[];
};

export type WorldBuildSchedule = {
  selected: BuildUnitV1[];
  blocked: BuildBlockedReason[];
  terminal: boolean;
};

function buildBlocked(targetId: string, code: BuildBlockedCode, dependencyId: string | null, message: string): BuildBlockedReason {
  return { targetId, code, dependencyId, message };
}

/** 初始化优先屏障：别的 job 是进行中的 initialize → 本 job 让路。 */
function initializationBarrier(input: WorldBuildScheduleInput): WorldBuildJobV1 | null {
  if (input.job.kind === 'initialize') return null;
  const active = (input.otherJobs ?? []).find(
    (job) => job.id !== input.job.id
      && job.kind === 'initialize'
      && (job.status === 'pending' || job.status === 'running'),
  );
  return active ?? null;
}

function layerOf(target: WorldBuildTargetV1): number {
  return WORLD_BUILD_WORK_LAYERS[target.workKind] ?? 99;
}

/**
 * §10.1：选下一批工作单元。
 *
 * 只读：不写库、不调模型。公平性**复用** `atlas-construction-scheduler` 的
 * 3 新 : 1 重试轮转，不在这里另造一套配额逻辑（否则两套规则迟早打架）。
 */
export function selectNextBuildUnits(input: WorldBuildScheduleInput): WorldBuildSchedule {
  const targets = [...(input.targets ?? [])].filter(Boolean);
  const byId = new Map(targets.map((target) => [target.id, target]));
  const terminal = !targets.some((target) => target.status === 'pending' || target.status === 'running');
  const blocked: BuildBlockedReason[] = [];

  const barrier = initializationBarrier(input);
  if (barrier) {
    return {
      selected: [],
      blocked: [buildBlocked('', 'INITIALIZATION_PRIORITY', barrier.id,
        `初始化任务 ${barrier.id} 还在进行：期间新增的增量工作先让路（§10.1）。`)],
      terminal,
    };
  }

  const eligible: WorldBuildTargetV1[] = [];
  for (const target of targets) {
    if (target.status === 'waiting-for-entry') {
      blocked.push(buildBlocked(target.id, 'WAITING_FOR_ENTRY', null, '内部延后到剧情真的进入，不计已绘制、不算失败。'));
      continue;
    }
    if (target.status === 'done' || target.status === 'cancelled') continue;
    if (target.status === 'blocked') {
      blocked.push(buildBlocked(target.id, 'DEPENDENCY_FAILED', null, target.lastErrorCode ?? '目标已阻塞，等资料恢复或显式重试。'));
      continue;
    }
    if (target.status === 'failed' && input.job.kind !== 'retry-failed') {
      // 已失败目标只有「明确重试」能在这一轮重新激活；普通刷新不复活它。
      continue;
    }

    const dependencies = (target.dependencyIds ?? []).map((id) => byId.get(id)).filter((dep): dep is WorldBuildTargetV1 => Boolean(dep));
    const failed = dependencies.find((dep) => dep.status === 'failed' || dep.status === 'blocked');
    if (failed) {
      blocked.push(buildBlocked(target.id, 'DEPENDENCY_FAILED', failed.id,
        `依赖 ${failed.id} 已失败 / 阻塞：本目标不重做，等明确重试或新资料（§10.2 第 4、6 条）。`));
      continue;
    }
    const waiting = dependencies.find((dep) => dep.status === 'waiting-for-entry');
    if (waiting) {
      blocked.push(buildBlocked(target.id, 'DEPENDENCY_WAITING_FOR_ENTRY', waiting.id,
        `依赖 ${waiting.id} 是延后内部：本目标跟着等剧情进入。`));
      continue;
    }
    const pending = dependencies.find((dep) => dep.status !== 'done');
    if (pending) {
      blocked.push(buildBlocked(target.id, 'DEPENDENCY_NOT_DONE', pending.id,
        `依赖 ${pending.id} 还没完成：先做上层，子空间不抢跑。`));
      continue;
    }
    eligible.push(target);
  }

  // 来源没扫完就先扫来源：不拿半份世界书去建实体。
  const scanning = eligible.filter((target) => target.workKind === 'source-scan');
  const pool = scanning.length > 0 ? scanning : eligible;
  if (pool.length === 0) return { selected: [], blocked, terminal };

  const layer = Math.min(...pool.map(layerOf));
  const inLayer = pool.filter((target) => layerOf(target) === layer);

  const limit = Math.max(1, Math.floor(Number.isFinite(input.limit ?? 1) ? (input.limit as number) : 1));
  const totalBudget = Math.max(0, Math.floor(Number.isFinite(input.policy?.totalOperations) ? input.policy.totalOperations : 0));
  const maxTargets = Math.min(inLayer.length, totalBudget, limit * UNIT_TARGET_LIMIT);
  if (maxTargets === 0) {
    for (const target of inLayer) {
      blocked.push(buildBlocked(target.id, 'BUDGET_DEFERRED', null, '本窗口预算为 0，目标显式延期而不是静默丢弃。'));
    }
    return { selected: [], blocked, terminal };
  }

  const pseudo = (target: WorldBuildTargetV1, status: 'pending' | 'retry'): ScheduledUnit => ({
    unitId: target.id,
    status,
    lastServedSeq: Math.max(0, Math.floor(target.attempts)),
    targetIds: [target.id],
    sourceChunkKeys: [],
    inputSignature: target.inputSignature,
    catalogueHash: '',
    attemptCount: Math.max(0, Math.floor(target.attempts)),
    bindings: {},
  });
  const fresh = inLayer.filter((target) => target.attempts === 0 && target.status !== 'failed').map((target) => pseudo(target, 'pending'));
  const retry = inLayer.filter((target) => target.attempts > 0 || target.status === 'failed').map((target) => pseudo(target, 'retry'));
  const ordered = rotationOrder(fresh, retry, input.schedulerSeq ?? 0).slice(0, maxTargets);

  const selected: BuildUnitV1[] = [];
  for (let cursor = 0; cursor < ordered.length; cursor += UNIT_TARGET_LIMIT) {
    if (selected.length >= limit) break;
    const slice = ordered.slice(cursor, cursor + UNIT_TARGET_LIMIT);
    const targetIds = slice.map((unit) => unit.unitId);
    const first = byId.get(targetIds[0]) ?? null;
    if (!first) continue;
    selected.push({
      // 单元 ID 由 job + 层 + 首个目标派生：同一输入反复调度得到同一个单元，
      // 不会靠换 unitId 把失败目标伪装成「全新任务」无限重试。
      unitId: `world-build:${input.job.id}:${first.workKind}:${first.id}`,
      jobId: input.job.id,
      jobKind: input.job.kind,
      workKind: first.workKind,
      targetIds,
      depth: first.depth,
      status: slice[0].status,
      attemptCount: Math.max(0, ...slice.map((unit) => unit.attemptCount)),
    });
  }

  const planned = new Set(selected.flatMap((unit) => unit.targetIds));
  for (const target of inLayer) {
    if (planned.has(target.id)) continue;
    blocked.push(buildBlocked(target.id, 'BUDGET_DEFERRED', null,
      '本窗口装不下（单元数或操作总额度已满），显式延期到下一窗口。'));
  }

  return { selected, blocked, terminal };
}
