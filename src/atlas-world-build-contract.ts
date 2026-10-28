/**
 * atlas-world-build-contract.ts — 世界建设任务 / 目标 / 批次票据的契约与严格解码（P01）。
 *
 * 来源：Atlas 全局建图与空间行为开发执行计划 v2 §5.1、§5.2、§5.5。
 *
 * 规则：
 * - 只放类型、常量、稳定身份派生和严格解码器；不放实现流程、不放提示词、不放夹具。
 * - 这里**不**复用 `atlas-db-codec.ts` 的 `DecodeResult`：那套是「SQL 行 ↔ camelCase」的转换结果，
 *   形状带 `row`，而本模块解的是 JSON payload（没有 SQL 行）。名字相同、语义不同时另起，
 *   比强行共用一个看不出所以然的 `row` 字段诚实。
 * - 未知 `version`、非法枚举、错字段类型一律拒绝，不降级、不猜、不填默认值。
 * - 不 import 任何 Node 专有对象（无 Buffer/fs），浏览器与 Worker 可直接引用。
 */

import type { ProgressStatus } from './atlas-construction-progress.ts';

/* ------------------------------------------------------------------ *
 * 1 枚举白名单
 * ------------------------------------------------------------------ */

/** 任务级状态：只有这几个。`completed-with-issues` 不等于完成，也不等于失败。 */
export const WORLD_BUILD_JOB_STATUSES = [
  'pending',
  'running',
  'paused',
  'completed',
  'completed-with-issues',
  'cancelled',
] as const;
export type WorldBuildJobStatus = (typeof WORLD_BUILD_JOB_STATUSES)[number];

/**
 * 目标级状态。
 * `waiting-for-entry` 是「可延后的内部，等剧情真的进去」，**不是失败**；
 * `failed` 是「已用尽本次纠错额度」，不再自动抢占队列。
 */
export const WORLD_BUILD_TARGET_STATUSES = [
  'pending',
  'running',
  'done',
  'waiting-for-entry',
  'blocked',
  'failed',
  'cancelled',
] as const;
export type WorldBuildTargetStatus = (typeof WORLD_BUILD_TARGET_STATUSES)[number];

export const WORLD_BUILD_WORK_KINDS = [
  'source-scan',
  'entity-construction',
  'settlement-plan',
  'map-layout',
  'route-reconcile',
  'npc-initial-placement',
  'state-reconcile',
] as const;
export type WorldBuildWorkKind = (typeof WORLD_BUILD_WORK_KINDS)[number];

/** 必建 / 合理补出的外壳 / 可延后的内部——三者分母不同，不能混算。 */
export const WORLD_BUILD_REQUIREMENTS = ['source-required', 'inferred-shell', 'deferred-interior'] as const;
export type WorldBuildRequirement = (typeof WORLD_BUILD_REQUIREMENTS)[number];

export const WORLD_BUILD_JOB_KINDS = [
  'initialize',
  'lore-incremental',
  'entry',
  'plot-update',
  'retry-failed',
] as const;
export type WorldBuildJobKind = (typeof WORLD_BUILD_JOB_KINDS)[number];

/* ------------------------------------------------------------------ *
 * 2 payload 标识与命名空间（§5.2）
 * ------------------------------------------------------------------ */

/** 本轮 payload 版本。与数据库 schema 版本、进度队列策略版本各自独立，不能互相冒充。 */
export const WORLD_BUILD_JOB_PAYLOAD_VERSION = 1;
export const WORLD_BUILD_TARGET_PAYLOAD_VERSION = 1;
export const WORLD_BUILD_UNIT_PAYLOAD_VERSION = 1;

export const WORLD_BUILD_JOB_PAYLOAD_KIND = 'world-build-job/v1';
export const WORLD_BUILD_TARGET_PAYLOAD_KIND = 'world-build-target/v1';
export const WORLD_BUILD_UNIT_PAYLOAD_KIND = 'world-build-unit/v1';
export const SETTLEMENT_PLAN_PAYLOAD_KIND = 'settlement-plan/v1';
export const WORLD_FACT_PAYLOAD_KIND = 'world-fact/v1';

/** 来源断言元数据单独一个 scope：它们不是待建设地点，旧扫描器不能把它们当目标捡走。 */
export const WORLD_FACTS_SCOPE_KEY = 'world-facts:v1';

/** 建设任务的 scope_key：`world-build:<jobId>`。 */
export function worldBuildScopeKey(jobId: string): string {
  return `world-build:${jobId}`;
}

/** 目标是 scope 行下的 subject；同一 job 的所有目标共用一个 scope。 */
export function worldBuildTargetSubjectKey(targetId: string): string {
  return `target:${targetId}`;
}

export function worldBuildUnitSubjectKey(unitId: string): string {
  return `unit:${unitId}`;
}

/** 设施方案的一部分：按城镇 + 分片稳定切分，避免一个城镇的全部方案挤进一个 payload。 */
export function settlementPlanSubjectKey(townId: string, partId: string): string {
  return `settlement-plan:${townId}:${partId}`;
}

/** 来源断言的稳定身份：同一主体同一断言只有一个 ID，不随批次变化。 */
export function worldFactSubjectKey(stableId: string): string {
  return `fact:${stableId}`;
}

/* ------------------------------------------------------------------ *
 * 3 逻辑状态 → 既有 SQL status（§5.2）
 * ------------------------------------------------------------------ */

/**
 * 逻辑状态映射到 `construction_progress.status` 的四个既有值。
 *
 * 只在 SQL 层是粗粒度：**精确状态永远以 payload 为准**，不能看到 `suspended`
 * 就把 `waiting-for-entry`（等剧情进入）当成失败，也不能把 `paused` 当成取消。
 */
export function sqlStatusForJobStatus(status: WorldBuildJobStatus): ProgressStatus {
  switch (status) {
    case 'pending':
    case 'running':
      return 'pending';
    case 'completed':
    case 'completed-with-issues':
      return 'processed';
    case 'paused':
    case 'cancelled':
      return 'suspended';
  }
}

/**
 * 目标状态映射。
 *
 * `failed` 已达本次纠错额度 → `suspended`：不自动重试，重试必须由显式 `retry-failed` job 发起。
 * `blocked` / `waiting-for-entry` / `cancelled` 同样挂在 `suspended`，但三者语义完全不同，
 * 读取方必须看 payload 才能区分。
 */
export function sqlStatusForTargetStatus(status: WorldBuildTargetStatus): ProgressStatus {
  switch (status) {
    case 'pending':
    case 'running':
      return 'pending';
    case 'done':
      return 'processed';
    case 'waiting-for-entry':
    case 'blocked':
    case 'failed':
    case 'cancelled':
      return 'suspended';
  }
}

/** 进入开局必建分母的状态集合：`deferred-interior` 单列，不混进来。 */
export function countsTowardRequiredDenominator(status: WorldBuildTargetStatus): boolean {
  return status === 'pending' || status === 'running' || status === 'done'
    || status === 'blocked' || status === 'failed';
}

/** 终态：到达后不再自动调度，也不再阻塞新剧情地图队列。 */
export function isTerminalTargetStatus(status: WorldBuildTargetStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

/* ------------------------------------------------------------------ *
 * 4 契约形状（§5.1 / §5.5）
 * ------------------------------------------------------------------ */

export type WorldBuildTargetV1 = {
  version: 1;
  id: string;
  jobId: string;
  subjectId: string | null;
  workKind: WorldBuildWorkKind;
  requirement: WorldBuildRequirement;
  depth: number;
  dependencyIds: readonly string[];
  inputSignature: string;
  status: WorldBuildTargetStatus;
  attempts: number;
  failureFingerprint: string | null;
  lastErrorCode: string | null;
  /** 任务起因楼层；与批次写入楼层、事件楼层不是一回事。 */
  originFloorId: string;
  eventId: string | null;
};

export type WorldBuildJobV1 = {
  version: 1;
  id: string;
  branchId: string;
  kind: WorldBuildJobKind;
  status: WorldBuildJobStatus;
  sourceManifestHash: string;
  policyVersion: string;
  originFloorId: string;
  /** 失效序号：回退/分支切换/停止后自增，用来作废在途候选。**不用 wall time 顶替**。 */
  runEpoch: number;
  nextWindowSequence: number;
  committedWindowSequence: number;
  cumulativeTransports: number;
  cumulativeWindows: number;
  stopReason: string | null;
};

/**
 * 批次提交票据（§5.5）。
 *
 * `originFloorId`（任务起因）/ `ownerFloorId`（本批结果写入所依附的有效剧情楼层）/
 * `causalFloorId`（进入、改建等事件所在楼层）三者不能混用；票据**不授权跨楼层提交**。
 */
export type WorldBuildBatchTicketV1 = {
  version: 1;
  jobId: string;
  windowSequence: number;
  unitIds: readonly string[];
  chatUid: string;
  branchId: string;
  ownerFloorId: string;
  causalFloorId: string;
  baseRevision: number;
  baseStorageRevision: number;
  sourceManifestHash: string;
  runEpoch: number;
  inputSignature: string;
};

/* ------------------------------------------------------------------ *
 * 5 解码结果与严格解码
 * ------------------------------------------------------------------ */

/** 解码问题：路径 + 机器码 + 人能看懂的说明。坏 payload 必须报得出是哪一项坏了。 */
export type WorldBuildDecodeIssue = { path: string; code: string; message: string };

/**
 * 解码结果。
 * 失败时不返回半成品、不返回默认对象——调用方要么拿到完整契约，要么拿到具体问题清单。
 */
export type DecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: readonly WorldBuildDecodeIssue[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

class DecodeContext {
  readonly issues: WorldBuildDecodeIssue[] = [];

  fail(path: string, code: string, message: string): void {
    this.issues.push({ path, code, message });
  }

  /** 必填非空字符串：空串与纯空白都算缺失，避免把 `""` 当合法 ID。 */
  requiredString(source: Record<string, unknown>, key: string, path: string): string | null {
    const value = source[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      this.fail(`${path}.${key}`, 'WORLD_BUILD_FIELD_INVALID', `字段 ${key} 必须是非空字符串，实际是 ${describe(value)}`);
      return null;
    }
    return value;
  }

  /** 可空字符串：字段必须存在，值可以是 null，但不能是别的类型。 */
  nullableString(source: Record<string, unknown>, key: string, path: string): string | null {
    if (!hasOwn(source, key)) {
      this.fail(`${path}.${key}`, 'WORLD_BUILD_FIELD_MISSING', `缺少字段 ${key}（可空字段也必须显式给出 null）`);
      return null;
    }
    const value = source[key];
    if (value === null) return null;
    if (typeof value !== 'string') {
      this.fail(`${path}.${key}`, 'WORLD_BUILD_FIELD_INVALID', `字段 ${key} 必须是字符串或 null，实际是 ${describe(value)}`);
      return null;
    }
    return value;
  }

  /** 非负整数：计数/序号/深度不接受小数、负数、NaN、字符串数字。 */
  nonNegativeInteger(source: Record<string, unknown>, key: string, path: string): number | null {
    const value = source[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      this.fail(`${path}.${key}`, 'WORLD_BUILD_FIELD_INVALID', `字段 ${key} 必须是非负整数，实际是 ${describe(value)}`);
      return null;
    }
    return value;
  }

  /** 枚举白名单：报错时把实际值打出来，省得调用方猜。 */
  enumValue<T extends string>(
    source: Record<string, unknown>,
    key: string,
    path: string,
    allowed: readonly T[],
  ): T | null {
    const value = source[key];
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
      this.fail(
        `${path}.${key}`,
        'WORLD_BUILD_ENUM_INVALID',
        `字段 ${key} 必须是 ${allowed.join(' / ')}，实际是 ${describe(value)}`,
      );
      return null;
    }
    return value as T;
  }

  /** 字符串数组：去重不是解码器的责任；这里只保证元素类型正确、不出现空洞。 */
  stringArray(source: Record<string, unknown>, key: string, path: string): readonly string[] | null {
    const value = source[key];
    if (!Array.isArray(value)) {
      this.fail(`${path}.${key}`, 'WORLD_BUILD_FIELD_INVALID', `字段 ${key} 必须是字符串数组，实际是 ${describe(value)}`);
      return null;
    }
    const out: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item: unknown = value[index];
      if (typeof item !== 'string' || item.trim().length === 0) {
        this.fail(
          `${path}.${key}[${index}]`,
          'WORLD_BUILD_FIELD_INVALID',
          `数组元素必须是非空字符串，实际是 ${describe(item)}`,
        );
        return null;
      }
      out.push(item);
    }
    return out;
  }

  /** 版本位：只接受约定值，未知版本直接拒绝，不做「尽量解析」。 */
  version(source: Record<string, unknown>, path: string, expected: number): true | null {
    if (!hasOwn(source, 'version')) {
      this.fail(`${path}.version`, 'WORLD_BUILD_VERSION_MISSING', '缺少 version 字段，拒绝解码');
      return null;
    }
    const value = source['version'];
    if (value !== expected) {
      this.fail(
        `${path}.version`,
        'WORLD_BUILD_VERSION_UNSUPPORTED',
        `只接受 version=${expected}，实际是 ${describe(value)}`,
      );
      return null;
    }
    return true;
  }
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined（字段缺失）';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (typeof value === 'object') return `object{${Object.keys(value as Record<string, unknown>).slice(0, 6).join(',')}}`;
  return `${typeof value}:${String(value)}`;
}

function rootOf(value: unknown, ctx: DecodeContext, label: string): Record<string, unknown> | null {
  if (!isPlainObject(value)) {
    ctx.fail(label, 'WORLD_BUILD_SHAPE_INVALID', `${label} 必须是普通对象，实际是 ${describe(value)}`);
    return null;
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * 6 解码器
 * ------------------------------------------------------------------ */

/** 解码世界建设任务。字段缺失、枚举越界、version 未知、类型不符都返回具体路径。 */
export function decodeWorldBuildJob(value: unknown): DecodeResult<WorldBuildJobV1> {
  const ctx = new DecodeContext();
  const root = rootOf(value, ctx, 'job');
  if (!root) return { ok: false, issues: ctx.issues };

  ctx.version(root, 'job', WORLD_BUILD_JOB_PAYLOAD_VERSION);

  const id = ctx.requiredString(root, 'id', 'job');
  const branchId = ctx.requiredString(root, 'branchId', 'job');
  const kind = ctx.enumValue(root, 'kind', 'job', WORLD_BUILD_JOB_KINDS);
  const status = ctx.enumValue(root, 'status', 'job', WORLD_BUILD_JOB_STATUSES);
  const sourceManifestHash = ctx.requiredString(root, 'sourceManifestHash', 'job');
  const policyVersion = ctx.requiredString(root, 'policyVersion', 'job');
  const originFloorId = ctx.requiredString(root, 'originFloorId', 'job');
  const runEpoch = ctx.nonNegativeInteger(root, 'runEpoch', 'job');
  const nextWindowSequence = ctx.nonNegativeInteger(root, 'nextWindowSequence', 'job');
  const committedWindowSequence = ctx.nonNegativeInteger(root, 'committedWindowSequence', 'job');
  const cumulativeTransports = ctx.nonNegativeInteger(root, 'cumulativeTransports', 'job');
  const cumulativeWindows = ctx.nonNegativeInteger(root, 'cumulativeWindows', 'job');
  const stopReason = ctx.nullableString(root, 'stopReason', 'job');

  if (ctx.issues.length > 0) return { ok: false, issues: ctx.issues };

  // 以下断言安全：上面已确认非 null，且 issues 为空。
  const job: WorldBuildJobV1 = {
    version: WORLD_BUILD_JOB_PAYLOAD_VERSION,
    id: id as string,
    branchId: branchId as string,
    kind: kind as WorldBuildJobKind,
    status: status as WorldBuildJobStatus,
    sourceManifestHash: sourceManifestHash as string,
    policyVersion: policyVersion as string,
    originFloorId: originFloorId as string,
    runEpoch: runEpoch as number,
    nextWindowSequence: nextWindowSequence as number,
    committedWindowSequence: committedWindowSequence as number,
    cumulativeTransports: cumulativeTransports as number,
    cumulativeWindows: cumulativeWindows as number,
    stopReason: stopReason,
  };

  const sequenceIssue = validateWindowSequence(job);
  if (sequenceIssue) {
    ctx.fail('job.committedWindowSequence', 'WORLD_BUILD_SEQUENCE_INVALID', sequenceIssue);
    return { ok: false, issues: ctx.issues };
  }

  return { ok: true, value: job };
}

/**
 * 窗口序号不变式：已提交不能超过下一个待执行，累计窗口数不能超过下一个序号。
 * 这类错乱说明 payload 被写坏了，宁可拒绝也不要带着它去算预算。
 */
function validateWindowSequence(job: WorldBuildJobV1): string | null {
  if (job.committedWindowSequence > job.nextWindowSequence) {
    return `committedWindowSequence(${job.committedWindowSequence}) 不能大于 nextWindowSequence(${job.nextWindowSequence})`;
  }
  if (job.cumulativeWindows > job.nextWindowSequence) {
    return `cumulativeWindows(${job.cumulativeWindows}) 不能大于 nextWindowSequence(${job.nextWindowSequence})`;
  }
  return null;
}

/** 解码单个建设目标。 */
export function decodeWorldBuildTarget(value: unknown): DecodeResult<WorldBuildTargetV1> {
  const ctx = new DecodeContext();
  const root = rootOf(value, ctx, 'target');
  if (!root) return { ok: false, issues: ctx.issues };

  ctx.version(root, 'target', WORLD_BUILD_TARGET_PAYLOAD_VERSION);

  const id = ctx.requiredString(root, 'id', 'target');
  const jobId = ctx.requiredString(root, 'jobId', 'target');
  const subjectId = ctx.nullableString(root, 'subjectId', 'target');
  const workKind = ctx.enumValue(root, 'workKind', 'target', WORLD_BUILD_WORK_KINDS);
  const requirement = ctx.enumValue(root, 'requirement', 'target', WORLD_BUILD_REQUIREMENTS);
  const depth = ctx.nonNegativeInteger(root, 'depth', 'target');
  const dependencyIds = ctx.stringArray(root, 'dependencyIds', 'target');
  const inputSignature = ctx.requiredString(root, 'inputSignature', 'target');
  const status = ctx.enumValue(root, 'status', 'target', WORLD_BUILD_TARGET_STATUSES);
  const attempts = ctx.nonNegativeInteger(root, 'attempts', 'target');
  const failureFingerprint = ctx.nullableString(root, 'failureFingerprint', 'target');
  const lastErrorCode = ctx.nullableString(root, 'lastErrorCode', 'target');
  const originFloorId = ctx.requiredString(root, 'originFloorId', 'target');
  const eventId = ctx.nullableString(root, 'eventId', 'target');

  if (ctx.issues.length > 0) return { ok: false, issues: ctx.issues };

  const target: WorldBuildTargetV1 = {
    version: WORLD_BUILD_TARGET_PAYLOAD_VERSION,
    id: id as string,
    jobId: jobId as string,
    subjectId,
    workKind: workKind as WorldBuildWorkKind,
    requirement: requirement as WorldBuildRequirement,
    depth: depth as number,
    dependencyIds: dependencyIds as readonly string[],
    inputSignature: inputSignature as string,
    status: status as WorldBuildTargetStatus,
    attempts: attempts as number,
    failureFingerprint,
    lastErrorCode,
    originFloorId: originFloorId as string,
    eventId,
  };

  // 依赖环自检：自己依赖自己一定是坏数据。
  if (target.dependencyIds.includes(target.id)) {
    ctx.fail('target.dependencyIds', 'WORLD_BUILD_DEPENDENCY_SELF', '目标不能依赖自己');
    return { ok: false, issues: ctx.issues };
  }

  return { ok: true, value: target };
}

/** 解码批次提交票据。 */
export function decodeWorldBuildBatchTicket(value: unknown): DecodeResult<WorldBuildBatchTicketV1> {
  const ctx = new DecodeContext();
  const root = rootOf(value, ctx, 'ticket');
  if (!root) return { ok: false, issues: ctx.issues };

  ctx.version(root, 'ticket', 1);

  const jobId = ctx.requiredString(root, 'jobId', 'ticket');
  const windowSequence = ctx.nonNegativeInteger(root, 'windowSequence', 'ticket');
  const unitIds = ctx.stringArray(root, 'unitIds', 'ticket');
  const chatUid = ctx.requiredString(root, 'chatUid', 'ticket');
  const branchId = ctx.requiredString(root, 'branchId', 'ticket');
  const ownerFloorId = ctx.requiredString(root, 'ownerFloorId', 'ticket');
  const causalFloorId = ctx.requiredString(root, 'causalFloorId', 'ticket');
  const baseRevision = ctx.nonNegativeInteger(root, 'baseRevision', 'ticket');
  const baseStorageRevision = ctx.nonNegativeInteger(root, 'baseStorageRevision', 'ticket');
  const sourceManifestHash = ctx.requiredString(root, 'sourceManifestHash', 'ticket');
  const runEpoch = ctx.nonNegativeInteger(root, 'runEpoch', 'ticket');
  const inputSignature = ctx.requiredString(root, 'inputSignature', 'ticket');

  if (ctx.issues.length > 0) return { ok: false, issues: ctx.issues };

  if ((unitIds as readonly string[]).length === 0) {
    ctx.fail('ticket.unitIds', 'WORLD_BUILD_TICKET_EMPTY', '票据必须至少包含一个工作单元，空批次不允许提交');
    return { ok: false, issues: ctx.issues };
  }

  return {
    ok: true,
    value: {
      version: 1,
      jobId: jobId as string,
      windowSequence: windowSequence as number,
      unitIds: unitIds as readonly string[],
      chatUid: chatUid as string,
      branchId: branchId as string,
      ownerFloorId: ownerFloorId as string,
      causalFloorId: causalFloorId as string,
      baseRevision: baseRevision as number,
      baseStorageRevision: baseStorageRevision as number,
      sourceManifestHash: sourceManifestHash as string,
      runEpoch: runEpoch as number,
      inputSignature: inputSignature as string,
    },
  };
}

/**
 * 票据是否仍然有效（§5.5）。
 *
 * 失效条件：任务换了、换代了、分支变了、修订前进过、来源清单变了。
 * 只要命中一条就不能发布——过期候选写回去等于把别人的楼层改写掉。
 */
/**
 * 票据是否仍然有效（§11.3）。
 *
 * 判定顺序固定：先认「换了个世界」的（job / chat / branch），再认「时间线动了」的
 * （floor / revision / storageRevision），最后认「来源换了」的（manifest / epoch）。
 * 顺序固定是为了让同一个失效场景永远得到同一个 reason，测试和诊断才对得上。
 */
export function isBatchTicketCurrent(
  ticket: WorldBuildBatchTicketV1,
  current: {
    jobId: string;
    runEpoch: number;
    chatUid: string;
    branchId: string;
    ownerFloorId: string;
    baseRevision: number;
    baseStorageRevision: number;
    sourceManifestHash: string;
  },
): { current: true } | { current: false; reason: string } {
  if (ticket.jobId !== current.jobId) return { current: false, reason: 'job-mismatch' };
  // 切聊天：票据属于旧聊天，任何后续写入都会落到错误的会话里。
  if (ticket.chatUid !== current.chatUid) return { current: false, reason: 'chat-switched' };
  if (ticket.branchId !== current.branchId) return { current: false, reason: 'branch-switched' };
  // 切楼层 / 回退到别的楼层：批次依附的有效楼层已经不在了。
  if (ticket.ownerFloorId !== current.ownerFloorId) return { current: false, reason: 'owner-floor-moved' };
  if (ticket.baseRevision !== current.baseRevision) return { current: false, reason: 'revision-moved' };
  if (ticket.baseStorageRevision !== current.baseStorageRevision) {
    return { current: false, reason: 'storage-revision-moved' };
  }
  if (ticket.sourceManifestHash !== current.sourceManifestHash) {
    return { current: false, reason: 'source-manifest-changed' };
  }
  if (ticket.runEpoch !== current.runEpoch) return { current: false, reason: 'epoch-stale' };
  return { current: true };
}
