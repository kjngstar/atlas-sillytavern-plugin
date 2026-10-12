/**
 * atlas-sql-world-sources.ts — M3-05 / P10-R02：构造完整相关来源片段（世界建设用）。
 *
 * 纪律（改这个文件前先读一遍）：
 * 1. 来源必须**完整**：长条目按段落边界分块，每块记录 sourceKey 与 start/end 偏移，
 *    `text.slice(start, end) === chunk.text` 必须成立；装不下的块进 `deferred`（**显式延期**），
 *    装不下的来源进 `remaining`，**绝不静默 slice**（这正是「12000 字资料尾部的关系读不到」的老毛病）。
 * 2. 保留 key/hash：模型绑定来源靠 key+hash，UI 预览里的省略号文本不是完整资料——
 *    疑似宿主截断必须显式标记（WORLD_SOURCE_HOST_TRUNCATED），不能当成全文。
 *    宿主没给 hash 时从**实际原文**派生稳定摘要（`SOURCE_IDENTITY_DERIVED`），**绝不持久空 hash**。
 * 3. 缓存只在本 chat/branch 候选内复用：缓存键必须含 chat/branch + sourceKey + contentHash，
 *    **跨聊天沿用生成结果是禁止的**（世界书内容相同也不行，见 02 §9）。
 * 4. 关闭条目在宿主读取阶段已被剔除；这里再做一次防御性过滤，关闭项只记 remaining，不进模型。
 * 5. 来源里的指令只作资料：本模块只挑选/切块，不解释内容、不执行其中任何写作命令。
 * 6. P10：选取必须**跨来源公平轮转**（多来源逐轮至少轮到一个装得下的块，再分剩余预算），
 *    并区分 `consume`（消耗未处理块，账本由调用方推进）与 `context-only`（复查，不推进账本）。
 *    本模块**不写库**：持久账本在 atlas-construction-sources.ts，写入只经调用方的 RowMutation。
 */

import { stableHexHash } from './atlas-hash.ts';
import type { Issue, SourceSnapshotEntry } from './atlas-ops-contract.ts';

/** 单块默认字符上限；按段落边界切，段落超限时硬切并标记 hardSplit。 */
export const WORLD_SOURCE_CHUNK_CHARS = 2000;
/** 单次建设请求的来源总字符预算。 */
export const WORLD_SOURCE_MAX_CHARS = 24000;
/**
 * 切分规则版本（交接稿 §17.1）。
 *
 * 改变块大小、段落策略或 emoji 边界规则时**必须**改变这个版本或迁移进度：
 * 块键含它，因此换版本等于换一组块身份，旧块不会被误判成「同一块已处理」。
 */
export const WORLD_SOURCE_CHUNKING_VERSION = 1;

/** 宿主读取层已剔除此类条目；此处再兜一次（enabled === false 视为关闭）。 */
export type WorldSourceEntry = SourceSnapshotEntry & { enabled?: boolean };

export type WorldSourceChunk = {
  /** 原始来源 key（模型绑定来源用它）。 */
  sourceKey: string;
  /** 原始来源内容 hash（UI 截断与否都不改这个值）。 */
  contentHash: string;
  kind: SourceSnapshotEntry['kind'];
  /** 该来源内的片序号（0 基）与总片数。 */
  index: number;
  total: number;
  /** 在原文中的字符偏移：[start, end)；text 恒等于原文切片。UTF-16 code unit，不是字节偏移。 */
  start: number;
  end: number;
  text: string;
  /** 稳定块键：`sourceKey@contentHash@chunkingVersion#index`，供持久账本与去重复用。 */
  chunkKey: string;
  /** 切分规则版本：改变切分必须改版本，否则旧块会被误判成同一块。 */
  chunkingVersion: number;
  /** 段落本身超过块上限，被硬切（不是段落边界切割）。 */
  hardSplit: boolean;
};

export type WorldSourceRemaining = {
  sourceKey: string;
  contentHash: string;
  kind: string;
  /** 未被纳入本次请求的字符数。 */
  remainingChars: number;
  reason: string;
};

export type WorldSourceKnown = {
  sourceKey: string;
  contentHash: string;
  kind: string;
  chars: number;
  /** 文本疑似被宿主/UI 截断（尾部省略号等）——不可当成完整资料。 */
  hostTruncated: boolean;
  /** P10：该来源按当前切分规则会切成几块（0 表示空文本）。 */
  chunkCount: number;
  chunkingVersion: number;
};

/** 明确装不下 / 不该装的块：显式延期，绝不静默截断。 */
export type WorldSourceDeferred = {
  sourceKey: string;
  contentHash: string;
  chunkKey: string;
  index: number;
  start: number;
  end: number;
  chars: number;
  reason: string;
};

/** 选取模式（交接稿 §17.2 第 8 条）。 */
export type WorldSourceSelectionMode =
  /** 建设消费：未处理块优先，调用方按结果推进来源账本。 */
  | 'consume'
  /** 复查 / 布局 / repair 预览：只取内容，**不推进也不重置**来源账本。 */
  | 'context-only';

export type WorldSourceSelection = {
  chunks: WorldSourceChunk[];
  /** 未纳入的来源与未纳入字符数——有界，不静默丢弃。 */
  remaining: WorldSourceRemaining[];
  /** 本次看到的全部来源清单（含未纳入者），供 UI/诊断核对。 */
  known: WorldSourceKnown[];
  /** 本次选择结果的稳定哈希（含块键），进 contextHash 输入。 */
  selectionHash: string;
  /** 严格缓存键：chat/branch 隔离；跨聊天不共用。 */
  cacheKey: string;
  usedChars: number;
  maxChars: number;
  issues: Issue[];
  /** P10：本次选取模式。 */
  mode: WorldSourceSelectionMode;
  chunkingVersion: number;
  /** 装不下的具体块（本次实际检查过、判定不入批的）。 */
  deferred: WorldSourceDeferred[];
  /** consume 模式下因「已处理」被跳过的块数；context-only 恒为 0。 */
  skippedProcessed: number;
};

export type SelectWorldConstructionSourcesInput = {
  snapshot: readonly WorldSourceEntry[];
  /** 焦点地点名 / 关键词，用于相关性排序；不参与内容解释。 */
  focusTerms?: readonly string[];
  /** 严格缓存键的组成部分：不同 chat / branch 绝不共用缓存。 */
  chatId?: string;
  branchId?: string;
  maxChars?: number;
  chunkChars?: number;
  /** 本 chat 候选内的块缓存；键已含 chat/branch，跨聊天复用在结构上不可能。 */
  cache?: Map<string, WorldSourceChunk[]>;
  /** P10：选取模式，默认 `consume`（保持既有调用方语义）。 */
  mode?: WorldSourceSelectionMode;
  /** P10：切分规则版本，默认 `WORLD_SOURCE_CHUNKING_VERSION`。 */
  chunkingVersion?: number;
  /**
   * P10：consume 模式下**已处理**的块键。这些块不再重复装入「新来源」。
   * 空集合表示没有持久账本（旧调用方 / 首次运行）——行为与旧实现一致。
   */
  skipChunkKeys?: ReadonlySet<string> | readonly string[];
  /**
   * P10：只取这些块键（一个工作单元冻结的来源块）。检索不到（hash 变了 / 来源没了）的键
   * 记入 `deferred` 而不是当成空；未提供或为空时按公平轮转重新选取。
   */
  onlyChunkKeys?: readonly string[];
  /** P10：重试单元优先照顾的块键（放在本来源队列最前）。 */
  preferredChunkKeys?: readonly string[];
};

const KIND_WEIGHT: Record<string, number> = {
  lorebook: 3,
  story: 2,
  user: 2,
  simulation: 1,
  estimate: 1,
  migration: 0,
};

function makeIssue(code: string, path: string, message: string, severity: 'warning' | 'error', retryable: boolean): Issue {
  return { code, path, message, severity, retryable };
}

/** 疑似被宿主 / UI 截断：尾部省略号或明确的省略标记。 */
export function looksHostTruncated(text: string): boolean {
  const tail = text.slice(-24).trimEnd();
  return /(…|\.\.\.|⋯|【省略|（省略|\[省略|\[truncated\]|\(truncated\))$/i.test(tail);
}

/** 合法内容 hash：非空、无空白、长度合理即可（宿主给什么都照收，但不接受空）。 */
export function isUsableContentHash(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.length < 4 || text.length > 256) return false;
  return !/\s/.test(text);
}

/**
 * 内容身份（交接稿 §17.1）：宿主给的合法 hash 优先；缺失时从**实际原文**派生确定摘要。
 *
 * 返回 `derived: true` 表示这是程序摘要（调用方据此报 `SOURCE_IDENTITY_DERIVED`），
 * 但**任何情况下都不会持久一个空 hash**。
 */
export function contentIdentity(entry: WorldSourceEntry): { contentHash: string; derived: boolean } {
  const provided = (entry as { hash?: unknown }).hash;
  if (isUsableContentHash(provided)) return { contentHash: String(provided).trim(), derived: false };
  const text = typeof entry.text === 'string' ? entry.text : '';
  return { contentHash: `derived:${stableHexHash(text)}`, derived: true };
}

/** 把文本按「空行分隔」切成连续段落区间；区间**无缝铺满** [0, len)。 */
function paragraphs(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const separator = /\n[ \t\r]*\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = separator.exec(text)) !== null) {
    const end = match.index + match[0].length;
    spans.push({ start, end });
    start = end;
  }
  if (start < text.length) spans.push({ start, end: text.length });
  return spans;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 硬切边界校正：不要把一个代理对（emoji / 补充平面字符）切成两半。
 *
 * - 切点正好落在高代理之后 → 往前退一位（那个高代理跟它的低位一起留在本块）；
 * - 退到起点也没位置时，往前**扩**一位（宁可超限一个字，也不留半个字符）。
 *
 * 无论怎么调，`end > start` 恒成立，因此分块循环不会卡住，切片仍然无缝铺满原文。
 */
function safeHardBoundary(text: string, start: number, end: number, limit: number): number {
  let cut = Math.min(end, start + Math.max(1, limit));
  if (cut >= text.length) return text.length;
  const at = text.charCodeAt(cut - 1);
  const next = text.charCodeAt(cut);
  if (isHighSurrogate(at) && isLowSurrogate(next)) {
    if (cut - 1 > start) return cut - 1;
    return Math.min(text.length, cut + 1);
  }
  return cut;
}

/** 按段落边界切块；单段落超限时硬切成 chunkChars 片（标记 hardSplit）。恒为连续子串。 */
export function chunkSourceText(
  text: string,
  chunkChars: number,
  sourceKey: string,
  contentHash: string,
  kind: SourceSnapshotEntry['kind'],
  chunkingVersion: number = WORLD_SOURCE_CHUNKING_VERSION,
): WorldSourceChunk[] {
  const size = Math.max(1, Math.floor(chunkChars));
  const version = Number.isFinite(chunkingVersion) && chunkingVersion > 0
    ? Math.floor(chunkingVersion)
    : WORLD_SOURCE_CHUNKING_VERSION;
  const spans: Array<{ start: number; end: number; hardSplit: boolean }> = [];
  let current: { start: number; end: number } | null = null;
  for (const paragraph of paragraphs(text)) {
    const length = paragraph.end - paragraph.start;
    if (length > size) {
      if (current) {
        spans.push({ ...current, hardSplit: false });
        current = null;
      }
      let cursor = paragraph.start;
      while (cursor < paragraph.end) {
        const end = safeHardBoundary(text, cursor, paragraph.end, size);
        spans.push({ start: cursor, end, hardSplit: true });
        if (end <= cursor) break; // 理论不可达：安全网，防止死循环
        cursor = end;
      }
      continue;
    }
    if (!current) current = { start: paragraph.start, end: paragraph.end };
    else if (paragraph.end - current.start <= size) current.end = paragraph.end;
    else {
      spans.push({ ...current, hardSplit: false });
      current = { start: paragraph.start, end: paragraph.end };
    }
  }
  if (current) spans.push({ ...current, hardSplit: false });

  const total = spans.length;
  return spans.map((span, index) => ({
    sourceKey,
    contentHash,
    kind,
    index,
    total,
    start: span.start,
    end: span.end,
    text: text.slice(span.start, span.end),
    chunkKey: `${sourceKey}@${contentHash}@${version}#${index}`,
    chunkingVersion: version,
    hardSplit: span.hardSplit,
  }));
}

/**
 * 块偏移自检（§17.1 / SRC02）：每块 `original.slice(start,end) === chunk.text`，
 * 且相邻块首尾相接（无遗漏、无重叠）。
 */
export function chunkOffsetsValid(original: string, chunks: readonly WorldSourceChunk[]): boolean {
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.start !== cursor) return false;
    if (chunk.end < chunk.start) return false;
    if (original.slice(chunk.start, chunk.end) !== chunk.text) return false;
    cursor = chunk.end;
  }
  return cursor === original.length && chunks.length > 0;
}

/** 把 chunkKey 解析回身份（账本与单元冻结块键共用）。 */
export function parseChunkKey(chunkKey: string): { sourceKey: string; contentHash: string; chunkingVersion: number; index: number } | null {
  const match = /^(.*)@([^@]*)@(\d+)#(\d+)$/.exec(chunkKey);
  if (!match) return null;
  return {
    sourceKey: match[1],
    contentHash: match[2],
    chunkingVersion: Number(match[3]),
    index: Number(match[4]),
  };
}

function relevance(entry: WorldSourceEntry, focusTerms: readonly string[]): number {
  const weight = KIND_WEIGHT[entry.kind] ?? 0;
  const haystack = `${entry.key}\n${entry.text}`.toLowerCase();
  let hits = 0;
  for (const term of focusTerms) {
    const needle = String(term ?? '').trim().toLowerCase();
    if (needle.length === 0) continue;
    if (haystack.includes(needle)) hits += 1;
  }
  return weight * 1000 + Math.min(hits, 50);
}

type SourceBucket = {
  key: string;
  contentHash: string;
  kind: string;
  relevance: number;
  chunks: WorldSourceChunk[];
  cursor: number;
};

/**
 * 按「完整、可复现、chat 隔离、跨来源公平」的规则挑选本次建设请求要带的来源块。
 *
 * 排序：相关性（kind 权重 + 焦点词命中）降序，同分按 key 升序 —— 完全确定性。
 * 预算：**逐轮轮转**——每一轮里每个还有块的来源各取一个装得下的块；
 * 装不下的块进 `deferred`（显式延期，不截断塞进剩余空间），其来源记 remaining。
 * 任何来源都不会被静默 slice，任何已处理块（consume 模式）都不会被重复装入。
 */
export function selectWorldConstructionSources(input: SelectWorldConstructionSourcesInput): WorldSourceSelection {
  const snapshot = Array.isArray(input?.snapshot) ? input.snapshot : [];
  const focusTerms = (input?.focusTerms ?? []).map((term) => String(term ?? ''));
  const maxChars = Number.isFinite(input?.maxChars) ? Math.max(0, Math.floor(input.maxChars as number)) : WORLD_SOURCE_MAX_CHARS;
  const chunkChars = Number.isFinite(input?.chunkChars) ? Math.max(1, Math.floor(input.chunkChars as number)) : WORLD_SOURCE_CHUNK_CHARS;
  const cacheKey = `${input.chatId ?? ''}|${input.branchId ?? ''}`;
  const mode: WorldSourceSelectionMode = input?.mode === 'context-only' ? 'context-only' : 'consume';
  const chunkingVersion = Number.isFinite(input?.chunkingVersion) && (input.chunkingVersion as number) > 0
    ? Math.floor(input.chunkingVersion as number)
    : WORLD_SOURCE_CHUNKING_VERSION;
  const skipSet = input?.skipChunkKeys instanceof Set
    ? (input.skipChunkKeys as ReadonlySet<string>)
    : new Set<string>((input?.skipChunkKeys ?? []) as readonly string[]);
  const onlySet = (input?.onlyChunkKeys ?? []).length > 0
    ? new Set<string>((input?.onlyChunkKeys ?? []).map(String))
    : null;
  const preferred = new Set<string>((input?.preferredChunkKeys ?? []).map(String));

  const issues: Issue[] = [];
  const known: WorldSourceKnown[] = [];
  const remaining: WorldSourceRemaining[] = [];
  const deferred: WorldSourceDeferred[] = [];
  const cache = input?.cache;

  const usable: WorldSourceEntry[] = [];
  const identity = new Map<string, { contentHash: string; derived: boolean }>();
  const seenKeys = new Set<string>();
  for (const entry of snapshot) {
    if (!entry || typeof entry.key !== 'string' || entry.key.trim().length === 0) continue;
    const key = entry.key.trim();
    if (seenKeys.has(key)) continue; // 同 key 只认第一条，避免同 key 双份进提示词
    seenKeys.add(key);

    const text = typeof entry.text === 'string' ? entry.text : '';
    const hostTruncated = looksHostTruncated(text);
    const { contentHash, derived } = contentIdentity(entry);
    identity.set(key, { contentHash, derived });
    if (derived && text.length > 0) {
      issues.push(
        makeIssue(
          'SOURCE_IDENTITY_DERIVED',
          `$.sources.${key}`,
          `来源「${key}」没有可用的内容 hash；已按**实际原文**派生稳定摘要 ${contentHash}（不会持久空 hash）。`,
          'warning',
          false,
        ),
      );
    }
    const chunkSlot = `${cacheKey}|${key}@${contentHash}|${chunkChars}|v${chunkingVersion}`;
    let sourceChunks = cache?.get(chunkSlot);
    if (!sourceChunks && text.length > 0) {
      sourceChunks = chunkSourceText(text, chunkChars, key, contentHash, entry.kind, chunkingVersion);
      // 只有严格含 chat/branch 的键才写入缓存 —— 跨聊天沿用生成结果是不可能的。
      cache?.set(chunkSlot, sourceChunks);
    }
    known.push({
      sourceKey: key,
      contentHash,
      kind: String(entry.kind ?? ''),
      chars: text.length,
      hostTruncated,
      chunkCount: sourceChunks?.length ?? 0,
      chunkingVersion,
    });

    if (entry.enabled === false) {
      remaining.push({
        sourceKey: key,
        contentHash,
        kind: String(entry.kind ?? ''),
        remainingChars: text.length,
        reason: '来源已关闭（enabled=false），不作为资料进入模型',
      });
      continue;
    }
    if (hostTruncated) {
      issues.push(
        makeIssue(
          'WORLD_SOURCE_HOST_TRUNCATED',
          `$.sources.${key}`,
          `来源「${key}」的文本疑似被宿主 / UI 截断（尾部省略号），不能当成完整资料；已按实际到手内容分块。`,
          'warning',
          false,
        ),
      );
    }
    usable.push(entry);
  }

  usable.sort((a, b) => {
    const diff = relevance(b, focusTerms) - relevance(a, focusTerms);
    if (diff !== 0) return diff;
    const keyA = a.key.trim();
    const keyB = b.key.trim();
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });

  // 建立每个来源的块队列（含缓存复用）。
  const buckets: SourceBucket[] = [];
  for (const entry of usable) {
    const key = entry.key.trim();
    const text = typeof entry.text === 'string' ? entry.text : '';
    const { contentHash } = identity.get(key) ?? contentIdentity(entry);
    if (text.length === 0) {
      remaining.push({ sourceKey: key, contentHash, kind: String(entry.kind ?? ''), remainingChars: 0, reason: '来源为空文本' });
      continue;
    }
    const chunkSlot = `${cacheKey}|${key}@${contentHash}|${chunkChars}|v${chunkingVersion}`;
    let sourceChunks = cache?.get(chunkSlot);
    if (!sourceChunks) {
      sourceChunks = chunkSourceText(text, chunkChars, key, contentHash, entry.kind, chunkingVersion);
      cache?.set(chunkSlot, sourceChunks);
    }
    if (sourceChunks.length > 1) {
      issues.push(
        makeIssue(
          'WORLD_SOURCE_CHUNKED',
          `$.sources.${key}`,
          `来源「${key}」共 ${text.length} 字，按段落边界切为 ${sourceChunks.length} 块（含边界偏移），尾部内容可读。`,
          'warning',
          false,
        ),
      );
    }
    buckets.push({
      key,
      contentHash,
      kind: String(entry.kind ?? ''),
      relevance: relevance(entry, focusTerms),
      chunks: sourceChunks,
      cursor: 0,
    });
  }

  const chunks: WorldSourceChunk[] = [];
  let usedChars = 0;
  let skippedProcessed = 0;
  const byKey = new Map<string, WorldSourceChunk>();
  for (const bucket of buckets) for (const chunk of bucket.chunks) byKey.set(chunk.chunkKey, chunk);

  const take = (bucket: SourceBucket, chunk: WorldSourceChunk): void => {
    chunks.push(chunk);
    usedChars += chunk.end - chunk.start;
    bucket.cursor += 1;
    byKey.delete(chunk.chunkKey); // 已纳入本批，不再重复
  };

  if (onlySet) {
    // 单元冻结的块键：严格只取这些（不再自由选取）。检索不到的键显式延期。
    const taken = new Set<string>();
    for (const chunkKey of onlySet) {
      const chunk = byKey.get(chunkKey);
      if (!chunk) {
        deferred.push({
          sourceKey: '', contentHash: '', chunkKey, index: -1, start: -1, end: -1, chars: 0,
          reason: '该块在当前来源快照中已不存在（来源已关闭、原文 hash 变更或切分版本变化），本单元不再消费它。',
        });
        continue;
      }
      const length = chunk.end - chunk.start;
      if (usedChars + length > maxChars) {
        deferred.push({
          sourceKey: chunk.sourceKey, contentHash: chunk.contentHash, chunkKey: chunk.chunkKey,
          index: chunk.index, start: chunk.start, end: chunk.end, chars: length,
          reason: `本次来源预算 ${maxChars} 字符不足，该块不静默截断，显式延期到下一批。`,
        });
        continue;
      }
      chunks.push(chunk);
      usedChars += length;
      taken.add(chunk.chunkKey);
      byKey.delete(chunk.chunkKey);
    }
    for (const bucket of buckets) {
      const left = bucket.chunks.filter((chunk) => !taken.has(chunk.chunkKey));
      if (left.length === 0) continue;
      const droppedChars = left.reduce((sum, chunk) => sum + (chunk.end - chunk.start), 0);
      remaining.push({
        sourceKey: bucket.key,
        contentHash: bucket.contentHash,
        kind: bucket.kind,
        remainingChars: droppedChars,
        reason: `本单元只消费冻结的块；该来源另有 ${left.length} 块未纳入本次请求`,
      });
    }
  } else {
    // 公平轮转：每一轮里每个还有块的来源各取一个装得下的块。
    // 同轮顺序 = 相关性降序（同分 key 升序），由 buckets 的既有排序保证。
    type Queue = { bucket: SourceBucket; queue: WorldSourceChunk[] };
    const queues: Queue[] = buckets.map((bucket) => {
      const head = bucket.chunks.filter((chunk) => preferred.has(chunk.chunkKey));
      const headKeys = new Set(head.map((chunk) => chunk.chunkKey));
      const rest = bucket.chunks.filter((chunk) => !headKeys.has(chunk.chunkKey));
      // 首选（重试块）排前面；consume 模式下已处理的块直接不排队。
      const visible = (chunk: WorldSourceChunk): boolean => mode === 'context-only' || !skipSet.has(chunk.chunkKey);
      const queue = [...head.filter(visible), ...rest.filter(visible)];
      return { bucket, queue };
    });

    if (mode === 'consume') {
      for (const bucket of buckets) {
        for (const chunk of bucket.chunks) if (skipSet.has(chunk.chunkKey)) skippedProcessed += 1;
      }
    }

    if (!onlySet && queues.every((entry) => entry.queue.length === 0)) {
      // 全部来源都已被处理过（consume 模式）——不是错误，但要如实说清楚。
      for (const bucket of buckets) {
        remaining.push({
          sourceKey: bucket.key,
          contentHash: bucket.contentHash,
          kind: bucket.kind,
          remainingChars: 0,
          reason: '该来源的块在本次会话范围内均已被有效处理（不重复装入「新来源」）',
        });
      }
    }

    for (let round = 0; round < 100000; round += 1) {
      let progressed = false;
      for (const entry of queues) {
        const chunk = entry.queue[entry.bucket.cursor];
        if (!chunk) continue;
        const length = chunk.end - chunk.start;
        if (usedChars + length > maxChars) {
          // 不截断塞进剩余空间：显式延期，让别的来源先试（它们的块可能更小）。
          deferred.push({
            sourceKey: chunk.sourceKey, contentHash: chunk.contentHash, chunkKey: chunk.chunkKey,
            index: chunk.index, start: chunk.start, end: chunk.end, chars: length,
            reason: `本次来源预算 ${maxChars} 字符不足（已用 ${usedChars}），该块不静默截断，显式延期到下一批。`,
          });
          entry.bucket.cursor += 1;
          continue;
        }
        take(entry.bucket, chunk);
        progressed = true;
      }
      if (!progressed) break;
    }

    // 未纳入的来源：字符数按**尚未排队**的部分统计（有界、不静默）。
    for (const entry of queues) {
      const left = entry.queue.slice(entry.bucket.cursor);
      if (left.length === 0) continue;
      const droppedChars = left.reduce((sum, chunk) => sum + (chunk.end - chunk.start), 0);
      remaining.push({
        sourceKey: entry.bucket.key,
        contentHash: entry.bucket.contentHash,
        kind: entry.bucket.kind,
        remainingChars: droppedChars,
        reason: `本次来源预算 ${maxChars} 字符不足，该来源剩余 ${left.length} 块未纳入（完整块键/偏移已保留，可下一轮继续）`,
      });
    }
  }

  if (remaining.some((item) => item.reason.startsWith('本次来源预算'))) {
    issues.push(
      makeIssue(
        'WORLD_SOURCE_TRUNCATED',
        '$.sources',
        `本次来源预算 ${maxChars} 字符不足；未纳入的来源、剩余字符数与具体延期块已记入 remaining/deferred，未静默 slice。`,
        'warning',
        false,
      ),
    );
  }

  return {
    chunks,
    remaining,
    known,
    selectionHash: stableHexHash(chunks.map((chunk) => `${chunk.chunkKey}:${chunk.end - chunk.start}`).join('\u0001')),
    cacheKey,
    usedChars,
    maxChars,
    issues,
    mode,
    chunkingVersion,
    deferred,
    skippedProcessed,
  };
}
