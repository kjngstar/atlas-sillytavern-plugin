/**
 * atlas-sql-world-sources.ts — M3-05：构造完整相关来源片段（世界建设用）。
 *
 * 纪律（改这个文件前先读一遍）：
 * 1. 来源必须**完整**：长条目按段落边界分块，每块记录 sourceKey 与 start/end 偏移，
 *    `text.slice(start, end) === chunk.text` 必须成立；装不下的来源进 `remaining`，
 *    **绝不静默 slice**（这正是「12000 字资料尾部的关系读不到」的老毛病）。
 * 2. 保留 key/hash：模型绑定来源靠 key+hash，UI 预览里的省略号文本不是完整资料——
 *    疑似宿主截断必须显式标记（WORLD_SOURCE_HOST_TRUNCATED），不能当成全文。
 * 3. 缓存只在本 chat/branch 候选内复用：缓存键必须含 chat/branch + sourceKey + contentHash，
 *    **跨聊天沿用生成结果是禁止的**（世界书内容相同也不行，见 02 §9）。
 * 4. 关闭条目在宿主读取阶段已被剔除；这里再做一次防御性过滤，关闭项只记 remaining，不进模型。
 * 5. 来源里的指令只作资料：本模块只挑选/切块，不解释内容、不执行其中任何写作命令。
 */

import { stableHexHash } from './atlas-hash.ts';
import type { Issue, SourceSnapshotEntry } from './atlas-ops-contract.ts';

/** 单块默认字符上限；按段落边界切，段落超限时硬切并标记 hardSplit。 */
export const WORLD_SOURCE_CHUNK_CHARS = 2000;
/** 单次建设请求的来源总字符预算。 */
export const WORLD_SOURCE_MAX_CHARS = 24000;

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
  /** 在原文中的字符偏移：[start, end)；text 恒等于原文切片。 */
  start: number;
  end: number;
  text: string;
  /** 稳定块键：sourceKey@contentHash#index，供缓存与去重复用。 */
  chunkKey: string;
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
};

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

/** 按段落边界切块；单段落超限时硬切成 chunkChars 片（标记 hardSplit）。恒为连续子串。 */
export function chunkSourceText(text: string, chunkChars: number, sourceKey: string, contentHash: string, kind: SourceSnapshotEntry['kind']): WorldSourceChunk[] {
  const size = Math.max(1, Math.floor(chunkChars));
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
        const end = Math.min(paragraph.end, cursor + size);
        spans.push({ start: cursor, end, hardSplit: true });
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
    chunkKey: `${sourceKey}@${contentHash}#${index}`,
    hardSplit: span.hardSplit,
  }));
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

/**
 * 按「完整、可复现、chat 隔离」的规则挑选本次建设请求要带的来源块。
 *
 * 排序：相关性（kind 权重 + 焦点词命中）降序，同分按 key 升序 —— 完全确定性。
 * 预算：按排序依次整块装入；装不下的来源整体记入 remaining（含剩余字符数），不截断原文。
 */
export function selectWorldConstructionSources(input: SelectWorldConstructionSourcesInput): WorldSourceSelection {
  const snapshot = Array.isArray(input?.snapshot) ? input.snapshot : [];
  const focusTerms = (input?.focusTerms ?? []).map((term) => String(term ?? ''));
  const maxChars = Number.isFinite(input?.maxChars) ? Math.max(0, Math.floor(input.maxChars as number)) : WORLD_SOURCE_MAX_CHARS;
  const chunkChars = Number.isFinite(input?.chunkChars) ? Math.max(1, Math.floor(input.chunkChars as number)) : WORLD_SOURCE_CHUNK_CHARS;
  const cacheKey = `${input.chatId ?? ''}|${input.branchId ?? ''}`;

  const issues: Issue[] = [];
  const known: WorldSourceKnown[] = [];
  const remaining: WorldSourceRemaining[] = [];

  const usable: WorldSourceEntry[] = [];
  const seenKeys = new Set<string>();
  for (const entry of snapshot) {
    if (!entry || typeof entry.key !== 'string' || entry.key.trim().length === 0) continue;
    const key = entry.key.trim();
    if (seenKeys.has(key)) continue; // 同 key 只认第一条，避免同 key 双份进提示词
    seenKeys.add(key);

    const text = typeof entry.text === 'string' ? entry.text : '';
    const hostTruncated = looksHostTruncated(text);
    known.push({
      sourceKey: key,
      contentHash: String(entry.hash ?? ''),
      kind: String(entry.kind ?? ''),
      chars: text.length,
      hostTruncated,
    });

    if (entry.enabled === false) {
      remaining.push({
        sourceKey: key,
        contentHash: String(entry.hash ?? ''),
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

  const cache = input?.cache;
  const chunks: WorldSourceChunk[] = [];
  let usedChars = 0;

  for (const entry of usable) {
    const key = entry.key.trim();
    const text = typeof entry.text === 'string' ? entry.text : '';
    const contentHash = String(entry.hash ?? '');

    if (text.length === 0) {
      remaining.push({ sourceKey: key, contentHash, kind: String(entry.kind ?? ''), remainingChars: 0, reason: '来源为空文本' });
      continue;
    }

    const cacheSlot = `${cacheKey}|${key}@${contentHash}|${chunkChars}`;
    let sourceChunks = cache?.get(cacheSlot);
    if (!sourceChunks) {
      sourceChunks = chunkSourceText(text, chunkChars, key, contentHash, entry.kind);
      // 只有严格含 chat/branch 的键才写入缓存 —— 跨聊天沿用生成结果是不可能的。
      cache?.set(cacheSlot, sourceChunks);
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

    let taken = 0;
    for (const chunk of sourceChunks) {
      const length = chunk.end - chunk.start;
      if (usedChars + length > maxChars) break;
      chunks.push(chunk);
      usedChars += length;
      taken += 1;
    }
    if (taken < sourceChunks.length) {
      const droppedChars = sourceChunks.slice(taken).reduce((sum, chunk) => sum + (chunk.end - chunk.start), 0);
      remaining.push({
        sourceKey: key,
        contentHash,
        kind: String(entry.kind ?? ''),
        remainingChars: droppedChars,
        reason: `本次来源预算 ${maxChars} 字符不足，该来源剩余 ${sourceChunks.length - taken} 块未纳入（完整 ID/偏移已保留，可下一轮继续）`,
      });
    }
  }

  if (remaining.some((item) => item.reason.startsWith('本次来源预算'))) {
    issues.push(
      makeIssue(
        'WORLD_SOURCE_TRUNCATED',
        '$.sources',
        `本次来源预算 ${maxChars} 字符不足；未纳入的来源与字符数已记入 remaining，未静默 slice。`,
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
  };
}
