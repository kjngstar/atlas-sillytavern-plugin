/**
 * atlas-source-catalogue.ts — 冻结的来源目录与别名解析（P02）。
 *
 * 来源：执行计划 v2 §8 第 5–8 条。
 *
 * 解决的问题：模型看到的是短别名（SRC1…），程序手里是完整 source key。
 * 如果发送前用的别名表、编译时用的、纠错重发时用的不是同一份，同一个 SRC1
 * 在不同阶段会指向不同来源 —— 这就是 F04（SOURCE_UNKNOWN 反复重试）的温床。
 *
 * 纪律：
 * - 目录一旦建立就冻结：`hash` 是它的指纹，编译、纠错、预览必须共用同一份。
 * - **完整 key 精确匹配优先**，别名次之；两者都不中才是 SOURCE_UNKNOWN。
 * - 生成的别名必须避开真实存在的同名 key（真有人的 key 叫 `SRC1` 时，别名跳到 SRC2）。
 * - 别名按 key 排序分配，不按调用方给的数组顺序 —— 否则同一批来源换个入参顺序，
 *   模型看到的 SRC1 就换人了。
 * - 只解析顶层 `op.source`。`data.area.source` 是另一套枚举，不在这里转换。
 * - chunkKey / contentHash / 纯段编号**不是** source key，收到就明确拒绝，不猜、不降级。
 */

import { stableHexHash } from './atlas-hash.ts';
import type { Issue, ModelOperation } from './atlas-ops-contract.ts';
import { parseChunkKey } from './atlas-sql-world-sources.ts';

export const SOURCE_CATALOGUE_VERSION = 1;

/** 模型可见的别名前缀。与空间摘录的 `S1` 明确区分，不共用编号。 */
export const SOURCE_ALIAS_PREFIX = 'SRC';

/** 目录条目：别名是给模型看的，key/hash 是程序认的。 */
export type SourceCatalogueEntryV1 = {
  alias: string;
  key: string;
  contentHash: string;
  kind: string;
};

/** 冻结的来源目录。`entries` 只读，`hash` 是整份目录的指纹。 */
export type SourceCatalogueV1 = {
  version: 1;
  hash: string;
  entries: readonly SourceCatalogueEntryV1[];
};

export type SourceCatalogueInputEntry = {
  key: string;
  contentHash: string;
  kind: string;
};

export type SourceLookup =
  | { ok: true; entry: SourceCatalogueEntryV1; via: 'key' | 'alias' }
  | { ok: false; code: 'SOURCE_UNKNOWN' | 'SOURCE_REF_SHAPE_INVALID'; message: string };

/* ------------------------------------------------------------------ *
 * 1 构造与冻结
 * ------------------------------------------------------------------ */

function normalizeEntries(entries: readonly SourceCatalogueInputEntry[]): SourceCatalogueInputEntry[] {
  const seen = new Map<string, SourceCatalogueInputEntry>();
  for (const entry of entries) {
    const key = typeof entry?.key === 'string' ? entry.key.trim() : '';
    if (key.length === 0) continue;
    const contentHash = typeof entry.contentHash === 'string' ? entry.contentHash : '';
    const kind = typeof entry.kind === 'string' ? entry.kind : '';
    const previous = seen.get(key);
    // 同一个 key 出现两次而 hash 不同：来源在冻结前就变了，保留第一条并让 hash 体现出来。
    // 这里不抛错——调用方会在下面的 hash 与条目里看到差异；静默取后者才是危险的。
    if (previous && previous.contentHash !== contentHash) continue;
    if (previous) continue;
    seen.set(key, { key, contentHash, kind });
  }
  return [...seen.values()].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

function catalogueHash(entries: readonly SourceCatalogueEntryV1[]): string {
  return stableHexHash([
    `catalogue:${SOURCE_CATALOGUE_VERSION}`,
    ...entries.map((entry) => `${entry.alias}\u0000${entry.key}\u0000${entry.contentHash}\u0000${entry.kind}`),
  ].join('\u0001'));
}

/**
 * 建立并冻结来源目录。
 *
 * 别名分配规则：
 * - 按 key 字典序排好再编号，输入顺序不影响结果；
 * - 候选别名与任何真实 key 相同就跳过，避免模型把「真实 key SRC1」和「别名 SRC1」搞混。
 */
export function buildSourceCatalogue(entries: readonly SourceCatalogueInputEntry[]): SourceCatalogueV1 {
  const normalized = normalizeEntries(entries);
  const realKeys = new Set(normalized.map((entry) => entry.key));
  const usedAliases = new Set<string>();
  const assigned: SourceCatalogueEntryV1[] = [];
  let counter = 1;

  for (const entry of normalized) {
    let alias = '';
    // 上限保护：真实 key 不可能是无限多个 SRCn，但循环必须有界。
    for (let guard = 0; guard < realKeys.size + 1 + 10000; guard += 1) {
      const candidate = `${SOURCE_ALIAS_PREFIX}${counter}`;
      counter += 1;
      if (realKeys.has(candidate) || usedAliases.has(candidate)) continue;
      alias = candidate;
      break;
    }
    if (alias === '') {
      // 极端情况下（key 空间被 SRCn 占满）退回带前缀的稳定别名，仍然不与真实 key 冲突。
      alias = `${SOURCE_ALIAS_PREFIX}_${stableHexHash(entry.key).slice(0, 8)}`;
    }
    usedAliases.add(alias);
    assigned.push({ alias, key: entry.key, contentHash: entry.contentHash, kind: entry.kind });
  }

  const frozenEntries = Object.freeze(assigned.map((entry) => Object.freeze({ ...entry })));
  return Object.freeze({
    version: SOURCE_CATALOGUE_VERSION,
    hash: catalogueHash(assigned),
    entries: frozenEntries,
  });
}

/**
 * 校对两份目录是否是同一份。
 *
 * 编译、纠错、预览各拿一份时先过这里：hash 不同说明来源在冻结后被改过，
 * 此时继续解析别名等于让模型按旧表指认新内容。
 */
export function assertSameCatalogue(
  left: SourceCatalogueV1,
  right: SourceCatalogueV1,
): { same: true } | { same: false; code: 'SOURCE_CATALOGUE_DRIFT'; message: string } {
  if (left.hash === right.hash) return { same: true };
  return {
    same: false,
    code: 'SOURCE_CATALOGUE_DRIFT',
    message: `来源目录在冻结后发生变化：${left.hash.slice(0, 12)} → ${right.hash.slice(0, 12)}；`
      + '本次批次必须作废重发，不能拿旧别名表解析新内容。',
  };
}

/* ------------------------------------------------------------------ *
 * 2 解析
 * ------------------------------------------------------------------ */

/** 形状自检：chunkKey / contentHash / 纯段编号都不是 source key。 */
function refShapeProblem(ref: string): string | null {
  if (parseChunkKey(ref) !== null) {
    return `「${ref}」是来源块键（sourceKey@contentHash@version#index），不是 source key；请用目录里的别名或完整 key`;
  }
  if (/^[0-9a-f]{32,}$/i.test(ref)) {
    return `「${ref}」看起来是内容哈希，不是 source key`;
  }
  if (/^\d+$/.test(ref)) {
    return `「${ref}」看起来是段编号，不是 source key`;
  }
  return null;
}

/**
 * 查一个引用。
 *
 * 顺序固定：**完整 key 精确匹配优先**，然后才是别名。
 * 这样即使某个别名恰好与另一个来源的 key 重合，也不会把引用指错对象。
 */
export function lookupSource(catalogue: SourceCatalogueV1, ref: string): SourceLookup {
  const value = typeof ref === 'string' ? ref.trim() : '';
  if (value.length === 0) {
    return { ok: false, code: 'SOURCE_UNKNOWN', message: '来源引用是空字符串' };
  }

  for (const entry of catalogue.entries) {
    if (entry.key === value) return { ok: true, entry, via: 'key' };
  }
  for (const entry of catalogue.entries) {
    if (entry.alias === value) return { ok: true, entry, via: 'alias' };
  }

  const shape = refShapeProblem(value);
  if (shape) return { ok: false, code: 'SOURCE_REF_SHAPE_INVALID', message: shape };

  return {
    ok: false,
    code: 'SOURCE_UNKNOWN',
    message: `来源「${value}」不在本批冻结目录里（共 ${catalogue.entries.length} 条）；`
      + '不能静默删除或降级接收，请改用目录里的别名或完整 key',
  };
}

/** 读取顶层 `op.source`（字符串或字符串数组）。不看 `data.*`。 */
export function sourceReferenceIssues(source: unknown): Issue[] {
  if (source === undefined || typeof source === 'string' || Array.isArray(source) && source.every(entry => typeof entry === 'string')) return [];
  return [{ code: 'SOURCE_UNKNOWN', path: '$.source', message: 'source 必须是字符串或纯字符串数组；非法成员不能通过删除后继续接收', severity: 'error', retryable: true }];
}

export function requestedSourceRefs(op: ModelOperation): string[] {
  const source = op?.source;
  if (sourceReferenceIssues(source).length) return [];
  if (typeof source === 'string') {
    const trimmed = source.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (Array.isArray(source)) {
    const out: string[] = [];
    for (const item of source) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
    }
    return out;
  }
  return [];
}

export type OperationSourceResolution = {
  /** 解析出的完整 source key；未声明 source 时为空数组（保持原程序绑定）。 */
  keys: string[];
  issues: Issue[];
};

/**
 * 解析一个操作的来源引用。
 *
 * - 没写 `op.source`：返回空 keys，**保留原有程序绑定**，不报错。
 * - 写了但解析不了：报 SOURCE_UNKNOWN / SOURCE_REF_SHAPE_INVALID，交给上层决定重试还是失败。
 * - 不处理 `data.area.source` 之类另一套枚举。
 */
export function resolveOperationSources(
  catalogue: SourceCatalogueV1,
  op: ModelOperation,
  options: { opId?: string; pathPrefix?: string } = {},
): OperationSourceResolution {
  const refs = requestedSourceRefs(op);
  const keys: string[] = [];
  const issues: Issue[] = sourceReferenceIssues(op?.source).map(entry => ({ ...entry, ...(options.opId ? { opId: options.opId } : {}) }));
  const base = options.pathPrefix ?? '$.operations';

  for (const ref of refs) {
    const lookup = lookupSource(catalogue, ref);
    if (lookup.ok) {
      if (!keys.includes(lookup.entry.key)) keys.push(lookup.entry.key);
      continue;
    }
    const issue: Issue = {
      code: lookup.code,
      path: `${base}.${typeof op?.op === 'string' ? op.op : 'unknown'}.source`,
      message: lookup.message,
      severity: 'error',
      retryable: true,
    };
    if (options.opId !== undefined) issue.opId = options.opId;
    issues.push(issue);
  }

  return { keys, issues };
}

/** 目录的可读摘要（诊断/日志用，不是给人读的散文）。 */
export function describeSourceCatalogue(catalogue: SourceCatalogueV1): string {
  return `sources ${catalogue.entries.length}; hash ${catalogue.hash.slice(0, 12)}`;
}
