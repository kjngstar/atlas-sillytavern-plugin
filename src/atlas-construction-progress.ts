/**
 * atlas-construction-progress.ts — P09B/R01：持久建设进度与目标队列（纯契约/状态变更）。
 *
 * 这个文件只做三件事，**不碰数据库**：
 * 1. 稳定身份派生（scope_key / subject_key / 行 ID / unitId）；
 * 2. 目标发现（分页扫描 + 签名比对，决定哪些目标要重新入队）；
 * 3. 把「状态变更」表达成 RowMutation[]，交给调用方的 applyGroups/ACK 落盘。
 *
 * 纪律：
 * - 行 ID 由 kind+scopeKey+subjectKey 稳定派生，不含时间/随机数/临时 turnId。
 *   同一个目标在 fork 后的两个分支上得到同一个 ID（分支靠 branch_id 隔离）。
 * - 目标签名排除本任务的进度、时间、row_rev 与自身生成的坐标：
 *   否则本轮自己写的描述/结构会让签名立刻失效，队列永不收敛。
 * - 「不活动」由 status 判定，绝不因为「不在当前第一页」就判目标被删。
 */

import { ATLAS_RUNTIME_LIMITS } from './atlas-runtime-limits.ts';
import { stableHexHash } from './atlas-hash.ts';
import type { RowMutation } from './atlas-ops-contract.ts';
import type { TableReadPort } from './atlas-ops-compile-types.ts';

/** payload_json 自身的版本（与数据库 schema 版本分开管理，不能互相冒充）。 */
export const CONSTRUCTION_PAYLOAD_VERSION = 1;

/** 队列策略版本：进入 scope 行签名；策略升级按明确规则重排。 */
export const CONSTRUCTION_QUEUE_POLICY_VERSION = 1;

/** 单次发现的默认页大小与每次发现的行数上限（交接稿 §16.1 第 2 条）。 */
export const DISCOVERY_PAGE_SIZE = 200;
export const DISCOVERY_MAX_ROWS = 1000;

/** 一个工作单元最多冻结多少个目标（与 worldFillTargets 同口径）。 */
export const UNIT_TARGET_LIMIT = ATLAS_RUNTIME_LIMITS.worldFillTargets;

/** 新单元 : 重试单元 的轮转比（交接稿 §16.3）。 */
export const NEW_UNITS_PER_RETRY = 3;

/**
 * 同一个工作单元最多自动重试几次（§16.3「已知失败不在同一轮内无限重发；
 * 超过既有 repair 额度后等待后续显式续建/正常任务」）。
 *
 * 超过上限的单元转 `suspended`，它的目标退回 pending 并**带着已服务序号**排队，
 * 因此一次都没轮到的目标会排在前面 —— 永久失败的目标不能把整条队伍堵死。
 */
export const MAX_UNIT_ATTEMPTS = 3;

export type ProgressKind = 'scope' | 'target' | 'source' | 'chunk' | 'unit';
export type ProgressStatus = 'pending' | 'processed' | 'retry' | 'suspended';

/** 解码后的进度行（payload 已解析；坏 payload 不静默当成空对象，交由 `payloadOk` 说明）。 */
export type ProgressRow = {
  id: string;
  branchId: string;
  rowRev: number;
  kind: ProgressKind;
  scopeKey: string;
  subjectKey: string;
  inputSignature: string;
  status: ProgressStatus;
  lastServedSeq: number;
  payload: Record<string, unknown>;
  payloadOk: boolean;
  /** 原始 SQL 行（snake_case、已解码）：构造 RowMutation 的 before 时**必须**用它。 */
  raw: Record<string, unknown>;
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function byId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].filter((value) => value.length > 0).sort(byId);
}

/* ------------------------------------------------------------------ *
 * 1. 稳定身份
 * ------------------------------------------------------------------ */

/** bootstrap 每个聊天/分支下一个稳定逻辑 scope：不把本次根图列表、revision、turnId 放进 key。 */
export const BOOTSTRAP_SCOPE_KEY = 'bootstrap';

/**
 * local scope：由模式与**明确的逻辑焦点集合**稳定排序计算。
 * 普通位置变化导致的不同焦点属于新范围，旧范围进度保留（不清理、不迁移）。
 */
export function localScopeKey(focusIds: readonly string[]): string {
  const sorted = uniqueSorted(focusIds);
  return `local:${stableHexHash(sorted.join('\u0000')).slice(0, 16)}`;
}

export function scopeKeyFor(mode: 'bootstrap' | 'local', focusIds: readonly string[]): string {
  return mode === 'bootstrap' ? BOOTSTRAP_SCOPE_KEY : localScopeKey(focusIds);
}

/** 行 ID：kind + scopeKey + subjectKey 稳定派生。 */
export function progressId(kind: ProgressKind, scopeKey: string, subjectKey: string): string {
  return `cp_${kind}_${stableHexHash([kind, scopeKey, subjectKey].join('\u0000')).slice(0, 20)}`;
}

/**
 * 工作单元 ID：由 scope、本单元逻辑目标、来源块键与策略版本稳定派生。
 * `allocationSeq` 来自持久分配序号 —— 同一批目标在同一次分配里只得到一个 unitId，
 * 而本单元自己产生的有效业务写入**不会**让它自动变化。
 */
export function unitId(scopeKey: string, targetIds: readonly string[], chunkKeys: readonly string[], allocationSeq: number): string {
  return `cp_unit_${stableHexHash([
    scopeKey,
    uniqueSorted(targetIds).join(','),
    uniqueSorted(chunkKeys).join(','),
    `policy:${CONSTRUCTION_QUEUE_POLICY_VERSION}`,
    `seq:${allocationSeq}`,
  ].join('\u0000')).slice(0, 20)}`;
}

/**
 * 目标签名：**排除**进度、时间、row_rev 与自身生成的坐标。
 * 参与签名的只有「已接受的业务事实」：名称、类别、父链、状态、被作者确认的坐标与尺度。
 */
export function targetSignature(row: Record<string, unknown>): string {
  const precision = str(row.coord_precision).trim() || 'unknown';
  const confirmedPosition = precision === 'exact' || precision === 'confirmed'
    ? `${str(row.map_id)}@${str(row.grid_x)},${str(row.grid_y)}`
    : '';
  return stableHexHash([
    str(row.name),
    str(row.kind),
    str(row.parent_location_id),
    str(row.status).trim() || 'active',
    str(row.terrain).trim() || 'unknown',
    precision,
    confirmedPosition,
    str(row.merged_into_id),
  ].join('\u0000'));
}

/** 新目标或签名变化的目标需要重新入队；签名不变且已处理的目标跳过。 */
export function needsEnqueue(existing: Pick<ProgressRow, 'inputSignature' | 'status'> | null, signature: string): boolean {
  if (!existing) return true;
  if (existing.status === 'suspended') return true;
  return existing.inputSignature !== signature;
}

/* ------------------------------------------------------------------ *
 * 2. 读取
 * ------------------------------------------------------------------ */

function parsePayload(raw: unknown): { payload: Record<string, unknown>; ok: boolean } {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { payload: raw as Record<string, unknown>, ok: true };
  if (typeof raw === 'string' && raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { payload: parsed as Record<string, unknown>, ok: true };
    } catch {
      return { payload: {}, ok: false };
    }
  }
  return { payload: {}, ok: false };
}

/** 逐页读完分支的全部进度行（不受 selectWhere 的 1,001 行硬上限影响）。 */
export function readProgressRows(tables: TableReadPort, branchId: string): ProgressRow[] {
  const raw = typeof tables.selectPage === 'function'
    ? pageProgress(tables, branchId)
    : tables.selectWhere('construction_progress', { branch_id: branchId }, 1001);
  return raw.map((row) => {
    const { payload, ok } = parsePayload(row.payload_json);
    return {
      id: str(row.id),
      branchId: str(row.branch_id),
      rowRev: Number(row.row_rev ?? 0),
      kind: str(row.kind) as ProgressKind,
      scopeKey: str(row.scope_key),
      subjectKey: str(row.subject_key),
      inputSignature: str(row.input_signature),
      status: (str(row.status).trim() || 'pending') as ProgressStatus,
      lastServedSeq: Number(row.last_served_seq ?? 0),
      payload,
      payloadOk: ok,
      raw: row,
    };
  });
}

function pageProgress(tables: TableReadPort, branchId: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let afterId: string | null = null;
  for (let guard = 0; guard < 10000; guard += 1) {
    const page = tables.selectPage!('construction_progress', branchId, afterId, 500);
    if (page.length === 0) break;
    out.push(...page);
    const last = page[page.length - 1];
    const nextId = last && last.id !== undefined && last.id !== null ? String(last.id) : '';
    if (!nextId || nextId === afterId) break;
    afterId = nextId;
    if (page.length < 500) break;
  }
  return out;
}

export function rowsInScope(rows: readonly ProgressRow[], scopeKey: string, kind: ProgressKind): ProgressRow[] {
  return rows.filter((row) => row.scopeKey === scopeKey && row.kind === kind);
}

/* ------------------------------------------------------------------ *
 * 3. 目标发现（分页 + 签名比对）
 * ------------------------------------------------------------------ */

export type DiscoveryScanState = {
  /** 上一次扫描停在哪（排他游标）。空串表示下一轮从表头开始。 */
  scanAfterId: string;
  /** 扫描周期计数：到尾部后 +1 并回到表头，以便发现游标之前新插入的 ID。 */
  scanCycle: number;
  /** 持久分配序号：分配工作单元时递增，保证 unitId 稳定且不重复。 */
  allocationSeq: number;
  /** 调度序号：每次真正选出一个单元时递增。 */
  schedulerSeq: number;
};

export const EMPTY_SCAN_STATE: DiscoveryScanState = { scanAfterId: '', scanCycle: 0, allocationSeq: 0, schedulerSeq: 0 };

export function readScanState(row: ProgressRow | null): DiscoveryScanState {
  if (!row) return { ...EMPTY_SCAN_STATE };
  const p = row.payload;
  const text = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);
  const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback);
  return {
    scanAfterId: text(p.scanAfterId, ''),
    scanCycle: num(p.scanCycle, 0),
    allocationSeq: num(p.allocationSeq, 0),
    schedulerSeq: num(p.schedulerSeq, 0),
  };
}

export function isActiveLocation(row: Record<string, unknown>): boolean {
  const status = str(row.status).trim() || 'active';
  return status !== 'destroyed' && status !== 'merged' && status !== 'archived';
}

export type DiscoveryInput = {
  tables: TableReadPort;
  branchId: string;
  scopeKey: string;
  /** 本 scope 关心的目标根集合；空 = 全分支 active 地点（bootstrap）。 */
  focusIds: readonly string[];
  /** 已存在的进度行（调用方一次读好，避免重复分页）。 */
  rows: readonly ProgressRow[];
  maxAdditionalDepth?: number;
  pageSize?: number;
  maxRows?: number;
};

export type DiscoveryResult = {
  /** 需要新入队（新建或签名变化）的目标 ID。 */
  enqueueIds: string[];
  /** 签名未变且已处理 → 不再入建设队列。 */
  unchangedIds: string[];
  /** 本轮判定为不活动、需要 suspended 的目标行 ID。 */
  suspendTargetIds: string[];
  /** 扫描推进后的状态（调用方写回 scope 行）。 */
  scan: DiscoveryScanState;
  scannedRows: number;
  /** 达到本轮发现行数上限：剩余部分用持久 scanAfterId 交代，不静默丢。 */
  truncated: boolean;
  scannedToEnd: boolean;
};

/**
 * 目标发现（交接稿 §16.1）。
 *
 * 统一用 `id > scanAfterId` 分页，每页 200、每次发现至多 1,000 行；到尾部开启新一轮扫描
 * （`scanCycle+1`、游标归零），因此游标之前新插入的 ID 下一周期能被发现 ——
 * 既不永远向后，也不是每次只读开头。
 */
export function discoverTargets(input: DiscoveryInput): DiscoveryResult {
  const pageSize = Math.max(1, Math.min(DISCOVERY_PAGE_SIZE, input.pageSize ?? DISCOVERY_PAGE_SIZE));
  const maxRows = Math.max(1, Math.min(DISCOVERY_MAX_ROWS, input.maxRows ?? DISCOVERY_MAX_ROWS));
  const state = readScanState(rowsInScope(input.rows, input.scopeKey, 'scope')[0] ?? null);
  const focus = uniqueSorted(input.focusIds);
  const focusSet = new Set(focus);
  const maxDepth = Math.max(0, input.maxAdditionalDepth ?? 0);

  const existing = new Map<string, ProgressRow>();
  for (const row of rowsInScope(input.rows, input.scopeKey, 'target')) existing.set(row.subjectKey, row);

  const enqueueIds: string[] = [];
  const unchangedIds: string[] = [];
  const seen = new Set<string>();
  let scannedRows = 0;
  let afterId = state.scanAfterId;
  let scanCycle = state.scanCycle;
  let scannedToEnd = false;
  let truncated = false;

  for (let guard = 0; guard < 10000; guard += 1) {
    const remaining = maxRows - scannedRows;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const page = typeof input.tables.selectPage === 'function'
      ? input.tables.selectPage('locations', input.branchId, afterId, Math.min(pageSize, remaining))
      : input.tables.selectWhere('locations', { branch_id: input.branchId }, Math.min(pageSize, remaining));
    if (page.length === 0) {
      scannedToEnd = true;
      break;
    }
    for (const row of page) {
      const id = str(row.id);
      scannedRows += 1;
      if (!isActiveLocation(row)) continue;
      // 关注集合按**逐行父链**判定，不预先物化整棵子树：这样分页扫描才能覆盖超过
      // 单次查询上限（每表 200 条）的大量子地点，也不会每个节点都扫一次全表。
      if (!isWantedTarget(input.tables, input.branchId, focusSet, maxDepth, row)) continue;
      seen.add(id);
      const previous = existing.get(id) ?? null;
      if (needsEnqueue(previous, targetSignature(row))) {
        enqueueIds.push(id);
      } else {
        unchangedIds.push(id);
      }
    }
    const last = page[page.length - 1];
    const nextId = last && last.id !== undefined && last.id !== null ? String(last.id) : '';
    if (!nextId || nextId === afterId) {
      scannedToEnd = true;
      break;
    }
    afterId = nextId;
    if (page.length < Math.min(pageSize, remaining)) {
      scannedToEnd = true;
      break;
    }
  }

  if (scannedToEnd) {
    // 到尾部：开启新一轮扫描，游标归零。下一个周期能发现游标之前新插入的 ID。
    scanCycle += 1;
    afterId = '';
  }

  // 不活动/退役：只有**确实扫到过**的目标才能判 suspended（绝不凭「不在第一页」判删除）。
  const suspendTargetIds: string[] = [];
  if (scannedToEnd && focusSet.size === 0) {
    for (const [subjectKey, row] of existing) {
      if (seen.has(subjectKey)) continue;
      if (row.status === 'suspended') continue;
      const live = input.tables.selectOne('locations', input.branchId, subjectKey);
      if (live && isActiveLocation(live)) continue;
      suspendTargetIds.push(subjectKey);
    }
  }

  return {
    enqueueIds: uniqueSorted(enqueueIds),
    unchangedIds: uniqueSorted(unchangedIds),
    suspendTargetIds: uniqueSorted(suspendTargetIds),
    scan: { ...state, scanAfterId: afterId, scanCycle },
    scannedRows,
    truncated,
    scannedToEnd,
  };
}

/**
 * 这一行属于本 scope 的目标吗？
 *
 * - 无焦点（bootstrap）→ 全部 active 地点；
 * - 有焦点 → 自身是焦点，或位于某个焦点之下至多 `maxDepth` 层。
 *
 * 沿**真实 parent_location_id** 上行判定，每次最多 `maxDepth` 次主键查询；
 * 不物化子树、不做全表扫描，因此与分页扫描天然兼容。
 */
function isWantedTarget(
  tables: TableReadPort,
  branchId: string,
  focusSet: ReadonlySet<string>,
  maxDepth: number,
  row: Record<string, unknown>,
): boolean {
  if (focusSet.size === 0) return true;
  if (focusSet.has(str(row.id))) return true;
  let cursor = str(row.parent_location_id);
  for (let depth = 1; depth <= maxDepth && cursor.length > 0; depth += 1) {
    if (focusSet.has(cursor)) return true;
    const parent = tables.selectOne('locations', branchId, cursor);
    cursor = parent ? str(parent.parent_location_id) : '';
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 4. 状态变更 → RowMutation（调用方交给 applyGroups/ACK）
 * ------------------------------------------------------------------ */

export type ProgressMutationContext = {
  branchId: string;
  turnId: string;
  /** 组 ID / 幂等键来源；程序记账组固定用它。 */
  opId: string;
};

function payloadText(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function mutation(
  ctx: ProgressMutationContext,
  row: { id: string; scopeKey: string; kind: ProgressKind; subjectKey: string },
  before: Record<string, unknown> | null,
  fields: { inputSignature: string; status: ProgressStatus; lastServedSeq?: number; payload?: Record<string, unknown> },
): RowMutation {
  const audit = {
    branch_id: ctx.branchId,
    id: row.id,
    row_rev: before ? Number(before.row_rev ?? 1) + 1 : 1,
    created_turn_id: before ? String(before.created_turn_id ?? ctx.turnId) : ctx.turnId,
    updated_turn_id: ctx.turnId,
  };
  const after = {
    ...audit,
    scope_key: row.scopeKey,
    kind: row.kind,
    subject_key: row.subjectKey,
    input_signature: fields.inputSignature,
    status: fields.status,
    last_served_seq: fields.lastServedSeq ?? (before ? Number(before.last_served_seq ?? 0) : 0),
    payload_json: payloadText(fields.payload ?? {}),
  };
  return {
    table: 'construction_progress',
    rowId: row.id,
    before,
    after,
    sourceOpIds: [ctx.opId],
    basis: { kind: 'simulation', reason: '建设进度/调度记账（程序内部行，不是世界业务变化）' },
  };
}

export function scopeRowMutation(
  ctx: ProgressMutationContext,
  scopeKey: string,
  before: Record<string, unknown> | null,
  state: DiscoveryScanState,
  mode: 'bootstrap' | 'local',
  focusIds: readonly string[],
): RowMutation {
  const payload = {
    version: CONSTRUCTION_PAYLOAD_VERSION,
    policyVersion: CONSTRUCTION_QUEUE_POLICY_VERSION,
    mode,
    focusIds: uniqueSorted(focusIds),
    scanAfterId: state.scanAfterId,
    scanCycle: state.scanCycle,
    allocationSeq: state.allocationSeq,
    schedulerSeq: state.schedulerSeq,
  };
  return mutation(ctx, { id: progressId('scope', scopeKey, scopeKey), scopeKey, kind: 'scope', subjectKey: scopeKey }, before, {
    inputSignature: stableHexHash([scopeKey, `policy:${CONSTRUCTION_QUEUE_POLICY_VERSION}`, uniqueSorted(focusIds).join(',')].join('\u0000')),
    status: 'processed',
    payload,
  });
}

export function targetRowMutation(
  ctx: ProgressMutationContext,
  scopeKey: string,
  before: Record<string, unknown> | null,
  locationId: string,
  signature: string,
  status: ProgressStatus,
  payload: Record<string, unknown>,
  lastServedSeq?: number,
): RowMutation {
  return mutation(
    ctx,
    { id: progressId('target', scopeKey, locationId), scopeKey, kind: 'target', subjectKey: locationId },
    before,
    { inputSignature: signature, status, payload, ...(lastServedSeq === undefined ? {} : { lastServedSeq }) },
  );
}

export function unitRowMutation(
  ctx: ProgressMutationContext,
  scopeKey: string,
  before: Record<string, unknown> | null,
  id: string,
  fields: {
    inputSignature: string;
    status: ProgressStatus;
    lastServedSeq?: number;
    targetIds: readonly string[];
    sourceChunkKeys: readonly string[];
    catalogueHash: string;
    attemptCount?: number;
    failureCode?: string | null;
    /** 自动重试额度已用尽：单元不再自动入队，等后续显式续建/正常任务。 */
    exhausted?: boolean;
    /**
     * P10/R02 §17.3：本单元**已接受**的 `new:` 别名 → 真实 ID 绑定。
     * 只在有界 payload 内保存，且只有最终 saved ACK 之后才成为正式状态。
     */
    bindings?: Readonly<Record<string, string>>;
  },
): RowMutation {
  const payload: Record<string, unknown> = {
    version: CONSTRUCTION_PAYLOAD_VERSION,
    targetIds: uniqueSorted(fields.targetIds).slice(0, UNIT_TARGET_LIMIT),
    sourceChunkKeys: uniqueSorted(fields.sourceChunkKeys),
    catalogueHash: fields.catalogueHash,
    attemptCount: Math.max(0, Math.floor(fields.attemptCount ?? 0)),
  };
  if (fields.failureCode) payload.failureCode = fields.failureCode;
  if (fields.exhausted) payload.exhausted = true;
  const bindings = Object.entries(fields.bindings ?? {}).filter(([alias, id]) => alias.length > 0 && id.length > 0);
  if (bindings.length > 0) {
    // 有界：只留前 256 条，别名与真实 ID 都截到合理长度（payload 有 64 KiB 单行上限）。
    payload.bindings = Object.fromEntries(bindings.slice(0, 256).map(([alias, id]) => [alias.slice(0, 128), String(id).slice(0, 128)]));
  }
  return mutation(
    ctx,
    { id, scopeKey, kind: 'unit', subjectKey: id },
    before,
    { inputSignature: fields.inputSignature, status: fields.status, lastServedSeq: fields.lastServedSeq, payload },
  );
}

/** 已保存的目标：签名记的是**已接受业务状态**的签名，避免本轮自己的写入立刻让它失效。 */
export function acceptedSignature(after: Record<string, unknown>): string {
  return targetSignature(after);
}

/* ------------------------------------------------------------------ *
 * 5. 只读汇总（§16.5 回执）
 * ------------------------------------------------------------------ */

export type QueueSummary = {
  scopeKey: string;
  /** 本轮选择的目标数（作者可见范围）。 */
  selectedTargets: number;
  /** 有效处理数：已 processed 的目标。 */
  processedTargets: number;
  /** 待处理数：仍 pending 的目标。 */
  pendingTargets: number;
  suspendedTargets: number;
  /** 本轮来源块数（P10 接来源账本后才有非零值）。 */
  sourceChunks: number;
  /** 待办/重试单元数。 */
  pendingUnits: number;
  retryUnits: number;
  processedUnits: number;
  scanCycle: number;
  scanAfterId: string;
  deferredReason: string | null;
};

/**
 * 只读汇总一个 scope 的队列状态。
 *
 * `selectedTargets` 由调用方给出（本批真正请求的目标数），其余全部来自持久行 ——
 * 所以刷新/换聊天后仍能报出真实进度，而不是凭内存计数。
 */
export function summarizeScope(
  rows: readonly ProgressRow[],
  scopeKey: string,
  selectedTargets = 0,
  deferredReason: string | null = null,
): QueueSummary {
  const inScope = rows.filter((row) => row.scopeKey === scopeKey);
  const target = inScope.filter((row) => row.kind === 'target');
  const unit = inScope.filter((row) => row.kind === 'unit');
  const chunk = inScope.filter((row) => row.kind === 'chunk');
  const state = readScanState(inScope.find((row) => row.kind === 'scope') ?? null);
  const count = (status: ProgressStatus): number => target.filter((row) => row.status === status).length;
  return {
    scopeKey,
    selectedTargets: Math.max(0, Math.floor(selectedTargets)),
    processedTargets: count('processed'),
    pendingTargets: count('pending'),
    suspendedTargets: count('suspended'),
    sourceChunks: chunk.length,
    pendingUnits: unit.filter((row) => row.status === 'pending').length,
    retryUnits: unit.filter((row) => row.status === 'retry').length,
    processedUnits: unit.filter((row) => row.status === 'processed').length,
    scanCycle: state.scanCycle,
    scanAfterId: state.scanAfterId,
    deferredReason,
  };
}
