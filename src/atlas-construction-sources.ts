/**
 * atlas-construction-sources.ts — P10/R02：来源块持久账本（纯契约/状态变更，不碰 DB）。
 *
 * 这个文件负责「来源被读到哪了」这件事的**唯一权威记录**：
 * 1. source / chunk 行的稳定身份与读取；
 * 2. 游标 = **连续成功前缀**的派生值（尾部块先成功也不能让 cursor 越过缺口）；
 * 3. 状态变更 → RowMutation[]（由调用方随同一候选 + ACK 落盘）；
 * 4. §17.3「保守整体确认」的判定：六条全部满足，一个冻结单元的来源/目标才允许进 processed。
 *
 * 纪律：
 * - 持久行**不保存 chunk.text**：原文由当前相同 hash 的 sourceSnapshot 重新得到。
 * - 行 ID 由 kind+scopeKey+subjectKey 稳定派生（复用 progressId），不含时间/随机数。
 * - `source` 行按 (sourceKey, contentHash) 建行：hash 变了就是**另一行**，旧行保留不动
 *   （旧 hash 的块停止使用，但别的来源的 processed 区间一个格子都不丢）。
 * - 关闭/当前未提供的来源不进请求，但**保留账本**：不把「当前没激活」当作永久删除。
 */

import { stableHexHash } from './atlas-hash.ts';
import { progressId, uniqueSorted, type ProgressMutationContext, type ProgressRow, type ProgressStatus } from './atlas-construction-progress.ts';
import { parseChunkKey } from './atlas-sql-world-sources.ts';
import type { RowMutation } from './atlas-ops-contract.ts';

/** 来源账本 payload 自身的版本（与数据库 schema 版本分开管理）。 */
export const SOURCE_LEDGER_PAYLOAD_VERSION = 1;
/** 来源账本策略版本：进入 source 行签名；策略升级按明确规则重建。 */
export const SOURCE_LEDGER_POLICY_VERSION = 1;

export type ChunkLedgerEntry = {
  /** 稳定块键（= subject_key）。 */
  chunkKey: string;
  sourceKey: string;
  contentHash: string;
  chunkingVersion: number;
  index: number;
  total: number;
  start: number;
  end: number;
  chars: number;
  hardSplit: boolean;
  status: ProgressStatus;
  attempts: number;
  failureCode: string;
  row: ProgressRow;
};

export type SourceLedgerEntry = {
  /** (sourceKey, contentHash) 派生出的 subject_key。 */
  subjectKey: string;
  sourceKey: string;
  contentHash: string;
  kind: string;
  chars: number;
  chunkCount: number;
  /** 连续成功前缀的**派生值**（不越过缺口）。 */
  contiguousPrefixEnd: number;
  hostTruncated: boolean;
  status: ProgressStatus;
  row: ProgressRow;
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
}

/* ------------------------------------------------------------------ *
 * 1. 稳定身份
 * ------------------------------------------------------------------ */

export function sourceSubjectKey(sourceKey: string, contentHash: string): string {
  return `${sourceKey}@${contentHash}`;
}

/** 从块键解析四个身份分量；非法块键返回 null（不猜、不兜底成空块）。 */
export function chunkIdentity(chunkKey: string): { sourceKey: string; contentHash: string; chunkingVersion: number; index: number } | null {
  return parseChunkKey(chunkKey);
}

export function sourceRowId(scopeKey: string, subjectKey: string): string {
  return progressId('source', scopeKey, subjectKey);
}

export function chunkRowId(scopeKey: string, chunkKey: string): string {
  return progressId('chunk', scopeKey, chunkKey);
}

/* ------------------------------------------------------------------ *
 * 2. 读取
 * ------------------------------------------------------------------ */

export type SourceLedger = {
  sources: Map<string, SourceLedgerEntry>;
  chunks: Map<string, ChunkLedgerEntry>;
  /** 按 (sourceKey, contentHash) 分组的块（升序按 index）。 */
  chunksBySource: Map<string, ChunkLedgerEntry[]>;
};

export function readSourceLedger(rows: readonly ProgressRow[], scopeKey: string): SourceLedger {
  const sources = new Map<string, SourceLedgerEntry>();
  const chunks = new Map<string, ChunkLedgerEntry>();
  const chunksBySource = new Map<string, ChunkLedgerEntry[]>();

  for (const row of rows) {
    if (row.scopeKey !== scopeKey) continue;
    if (row.kind === 'source') {
      const payload = row.payload;
      const sourceKey = str(payload.sourceKey) || row.subjectKey;
      const contentHash = str(payload.contentHash);
      sources.set(row.subjectKey, {
        subjectKey: row.subjectKey,
        sourceKey,
        contentHash,
        kind: str(payload.kind),
        chars: num(payload.chars, 0),
        chunkCount: num(payload.chunkCount, 0),
        contiguousPrefixEnd: num(payload.contiguousPrefixEnd, 0),
        hostTruncated: payload.hostTruncated === true,
        status: row.status,
        row,
      });
      continue;
    }
    if (row.kind !== 'chunk') continue;
    const chunkKey = row.subjectKey;
    const parsed = chunkIdentity(chunkKey);
    const payload = row.payload;
    const entry: ChunkLedgerEntry = {
      chunkKey,
      sourceKey: str(payload.sourceKey) || parsed?.sourceKey || '',
      contentHash: str(payload.contentHash) || parsed?.contentHash || '',
      chunkingVersion: num(payload.chunkingVersion, parsed?.chunkingVersion ?? 0),
      index: num(payload.index, parsed?.index ?? -1),
      total: num(payload.total, 0),
      start: num(payload.start, -1),
      end: num(payload.end, -1),
      chars: num(payload.chars, 0),
      hardSplit: payload.hardSplit === true,
      status: row.status,
      attempts: num(payload.attempts, 0),
      failureCode: str(payload.failureCode),
      row,
    };
    chunks.set(chunkKey, entry);
    const groupKey = sourceSubjectKey(entry.sourceKey, entry.contentHash);
    const list = chunksBySource.get(groupKey) ?? [];
    list.push(entry);
    chunksBySource.set(groupKey, list);
  }
  for (const list of chunksBySource.values()) list.sort((a, b) => a.index - b.index || (a.start - b.start));
  return { sources, chunks, chunksBySource };
}

/**
 * 连续成功前缀（交接稿 §17.2 第 7 条）：从偏移 0 起，块首尾相接且全部 processed 才能前进。
 *
 * 即使尾部块先成功，只要中间有缺口或失败，cursor 就**停在缺口前** ——
 * 因此「已成功区间」必须靠 chunk 行的逐块状态表达，不能只靠一个数字。
 */
export function contiguousProcessedPrefix(chunks: readonly ChunkLedgerEntry[]): number {
  const ordered = [...chunks].sort((a, b) => a.start - b.start || a.index - b.index);
  let cursor = 0;
  for (const chunk of ordered) {
    if (chunk.start !== cursor) break; // 缺口：不越过
    if (chunk.status !== 'processed') break;
    cursor = chunk.end;
  }
  return cursor;
}

/** 已成功（processed）区间列表——供「下一次跳过已成功区间」使用。 */
export function processedRanges(chunks: readonly ChunkLedgerEntry[]): Array<{ start: number; end: number }> {
  const ordered = [...chunks].sort((a, b) => a.start - b.start || a.index - b.index);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const chunk of ordered) {
    if (chunk.status !== 'processed') continue;
    const last = ranges[ranges.length - 1];
    if (last && last.end === chunk.start) last.end = chunk.end;
    else ranges.push({ start: chunk.start, end: chunk.end });
  }
  return ranges;
}

/* ------------------------------------------------------------------ *
 * 3. 状态变更 → RowMutation
 * ------------------------------------------------------------------ */

function payloadText(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function ledgerMutation(
  ctx: ProgressMutationContext,
  row: { id: string; scopeKey: string; kind: 'source' | 'chunk'; subjectKey: string },
  before: Record<string, unknown> | null,
  fields: { inputSignature: string; status: ProgressStatus; payload: Record<string, unknown> },
): RowMutation {
  const audit = {
    branch_id: ctx.branchId,
    id: row.id,
    row_rev: before ? Number(before.row_rev ?? 1) + 1 : 1,
    created_turn_id: before ? String(before.created_turn_id ?? ctx.turnId) : ctx.turnId,
    updated_turn_id: ctx.turnId,
  };
  return {
    table: 'construction_progress',
    rowId: row.id,
    before,
    after: {
      ...audit,
      scope_key: row.scopeKey,
      kind: row.kind,
      subject_key: row.subjectKey,
      input_signature: fields.inputSignature,
      status: fields.status,
      last_served_seq: before ? Number(before.last_served_seq ?? 0) : 0,
      payload_json: payloadText(fields.payload),
    },
    sourceOpIds: [ctx.opId],
    basis: { kind: 'simulation', reason: '来源块进度记账（程序内部行，不是世界业务变化）' },
  };
}

/** 来源行签名：身份 + 切分规则版本 + 策略版本。内容变 = hash 变 = 新行，不改旧行签名。 */
export function sourceRowSignature(sourceKey: string, contentHash: string): string {
  return stableHexHash([sourceKey, contentHash, `policy:${SOURCE_LEDGER_POLICY_VERSION}`].join('\u0000'));
}

export function sourceRowMutation(
  ctx: ProgressMutationContext,
  scopeKey: string,
  before: Record<string, unknown> | null,
  fields: {
    sourceKey: string;
    contentHash: string;
    kind: string;
    chars: number;
    chunkCount: number;
    /** 连续成功前缀（调用方用 contiguousProcessedPrefix 现算，不沿用旧 payload）。 */
    contiguousPrefixEnd: number;
    hostTruncated: boolean;
    /** 当前来源是否仍被提供/启用；false 只影响 `enabled` 标记，**不删行**。 */
    enabled: boolean;
  },
): RowMutation {
  const subjectKey = sourceSubjectKey(fields.sourceKey, fields.contentHash);
  const payload: Record<string, unknown> = {
    version: SOURCE_LEDGER_PAYLOAD_VERSION,
    policyVersion: SOURCE_LEDGER_POLICY_VERSION,
    sourceKey: fields.sourceKey,
    contentHash: fields.contentHash,
    kind: fields.kind,
    chars: Math.max(0, Math.floor(fields.chars)),
    chunkCount: Math.max(0, Math.floor(fields.chunkCount)),
    contiguousPrefixEnd: Math.max(0, Math.floor(fields.contiguousPrefixEnd)),
    hostTruncated: fields.hostTruncated === true,
    enabled: fields.enabled !== false,
  };
  return ledgerMutation(
    ctx,
    { id: sourceRowId(scopeKey, subjectKey), scopeKey, kind: 'source', subjectKey },
    before,
    { inputSignature: sourceRowSignature(fields.sourceKey, fields.contentHash), status: 'processed', payload },
  );
}

export function chunkRowMutation(
  ctx: ProgressMutationContext,
  scopeKey: string,
  before: Record<string, unknown> | null,
  fields: {
    chunkKey: string;
    sourceKey: string;
    contentHash: string;
    chunkingVersion: number;
    index: number;
    total: number;
    start: number;
    end: number;
    hardSplit: boolean;
    status: ProgressStatus;
    attempts?: number;
    failureCode?: string | null;
  },
): RowMutation {
  const payload: Record<string, unknown> = {
    version: SOURCE_LEDGER_PAYLOAD_VERSION,
    sourceKey: fields.sourceKey,
    contentHash: fields.contentHash,
    chunkingVersion: Math.max(0, Math.floor(fields.chunkingVersion)),
    index: Math.max(0, Math.floor(fields.index)),
    total: Math.max(0, Math.floor(fields.total)),
    start: Math.max(0, Math.floor(fields.start)),
    end: Math.max(0, Math.floor(fields.end)),
    chars: Math.max(0, Math.floor(fields.end - fields.start)),
    hardSplit: fields.hardSplit === true,
    attempts: Math.max(0, Math.floor(fields.attempts ?? 0)),
  };
  if (fields.failureCode) payload.failureCode = String(fields.failureCode).slice(0, 64);
  return ledgerMutation(
    ctx,
    { id: chunkRowId(scopeKey, fields.chunkKey), scopeKey, kind: 'chunk', subjectKey: fields.chunkKey },
    before,
    {
      inputSignature: stableHexHash([fields.chunkKey, `policy:${SOURCE_LEDGER_POLICY_VERSION}`].join('\u0000')),
      status: fields.status,
      payload,
    },
  );
}

/* ------------------------------------------------------------------ *
 * 4. §17.3 保守整体确认
 * ------------------------------------------------------------------ */

export type UnitConfirmation = {
  /** 请求未被取消、超时，也未在保存前被判 stale。 */
  requestCompleted: boolean;
  /** payload 完整解析；响应不是空文本、不是截断 JSON。 */
  payloadComplete: boolean;
  /** normalize 未丢弃受保护/非法操作。 */
  normalizedClean: boolean;
  /** 全部该单元的有效业务组及依赖通过编译/应用/外键校验。 */
  appliedClean: boolean;
  /** 需要的身份与来源绑定没有未解决错误。 */
  identityResolved: boolean;
  /**
   * 最终完整候选获得 saved ACK。
   *
   * 调用方传 `true` 是**结构上成立**的：账本写入与业务写入在**同一个候选事务**里，
   * 候选没有拿到 saved ACK 时整份信封被丢弃，账本一个字节都不会生效。
   */
  savedAck: boolean;
};

export type ConfirmResult = { ok: boolean; reasons: string[] };

/**
 * 「一个冻结单元可以进 processed」的判定。
 *
 * **明确不做**：不由「某段被提到一次」「成功操作有 31 个」或「返回 HTTP 200」推断完成。
 * 任何一条不满足就留 retry（部分成功时已接受的业务组照常保存，但单元与涉及块不前进）。
 */
export function canConfirmUnit(input: UnitConfirmation): ConfirmResult {
  const reasons: string[] = [];
  if (!input.requestCompleted) reasons.push('REQUEST_INCOMPLETE');
  if (!input.payloadComplete) reasons.push('PAYLOAD_INCOMPLETE');
  if (!input.normalizedClean) reasons.push('NORMALIZE_DROPPED');
  if (!input.appliedClean) reasons.push('GROUP_REJECTED');
  if (!input.identityResolved) reasons.push('IDENTITY_UNRESOLVED');
  if (!input.savedAck) reasons.push('ACK_MISSING');
  return { ok: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ *
 * 5. 只读汇总（回执）
 * ------------------------------------------------------------------ */

export type SourceSummary = {
  scopeKey: string;
  sources: number;
  /** 当前快照下仍处于 enabled 的来源数。 */
  enabledSources: number;
  chunks: number;
  processedChunks: number;
  pendingChunks: number;
  retryChunks: number;
  suspendedChunks: number;
  /** 连续成功前缀（派生值）。 */
  contiguousPrefixEnd: number;
  /** 已成功（不连续也算）的总字符数。 */
  processedChars: number;
  totalChars: number;
};

export function summarizeSources(rows: readonly ProgressRow[], scopeKey: string): SourceSummary {
  const ledger = readSourceLedger(rows, scopeKey);
  const enabledSubjects = new Set([...ledger.sources.values()].filter(source => source.row.payload.enabled !== false).map(source => source.subjectKey));
  const chunkList = [...ledger.chunks.values()].filter(chunk => enabledSubjects.has(sourceSubjectKey(chunk.sourceKey, chunk.contentHash)));
  const byStatus = (status: ProgressStatus): number => chunkList.filter((chunk) => chunk.status === status).length;
  const processedChars = chunkList.filter((chunk) => chunk.status === 'processed').reduce((sum, chunk) => sum + chunk.chars, 0);
  // Include unsent blocks; summing registered chunks falsely reports completion.
  const totalChars = [...ledger.sources.values()].filter(source => enabledSubjects.has(source.subjectKey)).reduce((sum, source) => sum + source.chars, 0);
  let contiguousPrefixEnd = 0;
  for (const [subject, list] of ledger.chunksBySource) {
    if (!enabledSubjects.has(subject)) continue;
    contiguousPrefixEnd = Math.max(contiguousPrefixEnd, contiguousProcessedPrefix(list));
  }
  return {
    scopeKey,
    sources: ledger.sources.size,
    enabledSources: [...ledger.sources.values()].filter((source) => source.row.payload.enabled !== false).length,
    chunks: chunkList.length,
    processedChunks: byStatus('processed'),
    pendingChunks: byStatus('pending'),
    retryChunks: byStatus('retry'),
    suspendedChunks: byStatus('suspended'),
    contiguousPrefixEnd,
    processedChars,
    totalChars,
  };
}

/** 本批要消费的块键（升序去重，供单元冻结与回执）。 */
export function frozenChunkKeys(chunkKeys: readonly string[]): string[] {
  return uniqueSorted(chunkKeys);
}
