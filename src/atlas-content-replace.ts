/**
 * atlas-content-replace.ts — 0.9.16 内容替换规则库（照抄 shujuku 内容替换干法 + 作者需求增强）。
 *
 * shujuku 参照：src/service/runtime/helpers-context-tags.ts（removeAllMatchedBoundaries_ACU /
 * applyExcludeRulesToText_ACU）+ src/shared/defaults-json.js（contextExcludeRules 预制库）。
 * 作者需求增强：①规则带名称与开关（enabled）；②预制规则与手动规则同库平等，可改可删；
 * ③提供「恢复预制规则」。
 *
 * 执行口径（shujuku 同款，逐行对齐）：
 * - 字面词对（非正则），大小写不敏感；
 * - 栈式配对（嵌套 `<think><think></think></think>` 整体删除）；
 * - 区间合并后从尾向前删；未闭合的孤立开始词不删（shujuku 同款容忍）；
 * - 收尾压缩 3+ 连续空行并 trim。
 */

export interface AtlasContentReplaceRule {
  id: string;
  name: string;
  /** 开始词（字面，如 "<think"——不带右尖括号以兼容 "<think …>" 属性写法，shujuku 同款）。 */
  start: string;
  /** 结束词（字面，如 "</think>"）。 */
  end: string;
  /** 是否启用（作者需求：预制规则可关）。 */
  enabled: boolean;
  /** 是否预置默认规则（恢复预制按钮据此判断，不影响行为）。 */
  builtin?: boolean;
}

/** 预制规则库：词对照抄 shujuku defaults-json.js contextExcludeRules 全集，中文名为 Atlas 侧标注。 */
export const DEFAULT_CONTENT_REPLACE_RULES: Array<Omit<AtlasContentReplaceRule, "id">> = [
  { name: "思考段 thinking", start: "<thinking", end: "</thinking>", enabled: true, builtin: true },
  { name: "思考段 think", start: "<think", end: "</think>", enabled: true, builtin: true },
  { name: "思考段 thought", start: "<thought", end: "</thought>", enabled: true, builtin: true },
  { name: "免责声明", start: "<disclaimer", end: "</disclaimer>", enabled: true, builtin: true },
  { name: "JSON 补丁", start: "<JSONPatch", end: "</JSONPatch>", enabled: true, builtin: true },
  { name: "分析段", start: "<Analysis", end: "</Analysis>", enabled: true, builtin: true },
  { name: "变量更新", start: "<UpdateVariable", end: "</UpdateVariable>", enabled: true, builtin: true },
  { name: "吐槽段", start: "<tucao", end: "</tucao>", enabled: true, builtin: true },
  { name: "状态栏占位", start: "<StatusPlaceHolderImpl", end: "</StatusPlaceHolderImpl>", enabled: true, builtin: true },
  { name: "摘要段", start: "<summary", end: "</summary>", enabled: true, builtin: true },
  { name: "选项段", start: "<options", end: "</options>", enabled: true, builtin: true },
  { name: "复盘段", start: "<review", end: "</review>", enabled: true, builtin: true },
  { name: "润色段", start: "<refine", end: "</refine>", enabled: true, builtin: true },
  { name: "DM 校验段", start: "<dm_check", end: "</dm_check>", enabled: true, builtin: true },
  { name: "补充段", start: "<supplement", end: "</supplement>", enabled: true, builtin: true },
];

export const MAX_REPLACE_RULES = 50;
const MAX_RULE_NAME_CHARS = 64;
const MAX_RULE_BOUNDARY_CHARS = 256;

/**
 * 词对区间删除（照抄 shujuku removeAllMatchedBoundaries_ACU）：
 * 大小写不敏感；栈式配对支持嵌套；区间合并后从尾向前删；未闭合的开始词不删。
 */
function removeAllMatchedBoundaries(text: string, startBoundary: string, endBoundary: string): string {
  const source = String(text ?? "");
  const start = String(startBoundary || "");
  const end = String(endBoundary || "");
  if (!source || !start || !end) return source;

  const lowerSource = source.toLowerCase();
  const lowerStart = start.toLowerCase();
  const lowerEnd = end.toLowerCase();
  const openStartIndexes: number[] = [];
  const matchedRanges: Array<{ start: number; end: number }> = [];
  let searchIndex = 0;

  while (searchIndex < lowerSource.length) {
    const nextStartIdx = lowerSource.indexOf(lowerStart, searchIndex);
    const nextEndIdx = lowerSource.indexOf(lowerEnd, searchIndex);
    if (nextStartIdx === -1 && nextEndIdx === -1) break;

    const isStartBoundary = nextStartIdx !== -1
      && (nextEndIdx === -1 || nextStartIdx <= nextEndIdx);
    if (isStartBoundary) {
      openStartIndexes.push(nextStartIdx);
      searchIndex = nextStartIdx + lowerStart.length;
      continue;
    }

    if (openStartIndexes.length > 0) {
      const matchedStartIdx = openStartIndexes.pop()!;
      const matchedEndIdx = nextEndIdx + lowerEnd.length;
      if (matchedEndIdx > matchedStartIdx) {
        matchedRanges.push({ start: matchedStartIdx, end: matchedEndIdx });
      }
    }
    searchIndex = nextEndIdx + lowerEnd.length;
  }

  if (matchedRanges.length === 0) return source;

  matchedRanges.sort((left, right) => left.start - right.start || left.end - right.end);
  const mergedRanges: Array<{ start: number; end: number }> = [];
  matchedRanges.forEach((range) => {
    const previousRange = mergedRanges[mergedRanges.length - 1];
    if (!previousRange || range.start > previousRange.end) {
      mergedRanges.push({ ...range });
      return;
    }
    previousRange.end = Math.max(previousRange.end, range.end);
  });

  let result = source;
  for (let rangeIndex = mergedRanges.length - 1; rangeIndex >= 0; rangeIndex--) {
    const range = mergedRanges[rangeIndex]!;
    result = result.slice(0, range.start) + result.slice(range.end);
  }
  return result;
}

/** 对文本按顺序应用所有启用的替换规则（照抄 shujuku applyExcludeRulesToText_ACU 收尾口径）。 */
export function applyContentReplaceRules(text: string, rules: AtlasContentReplaceRule[]): string {
  let result = String(text ?? "");
  if (!result) return result;
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    const start = String(rule.start ?? "").trim();
    const end = String(rule.end ?? "").trim();
    if (!start || !end) continue;
    result = removeAllMatchedBoundaries(result, start, end);
  }
  return result.replace(/\n{3,}/g, "\n\n").trim();
}

/** 存储侧归一化：非法条目丢弃、去重、截断（宽容，绝不因坏条目炸库）。 */
export function normalizeContentReplaceRules(raw: unknown): AtlasContentReplaceRule[] {
  const normalized: AtlasContentReplaceRule[] = [];
  const seenIds = new Set<string>();
  const seenPairs = new Set<string>();
  if (!Array.isArray(raw)) return normalized;
  for (const entry of raw.slice(0, MAX_REPLACE_RULES * 2)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim().slice(0, 128) : null;
    const name = typeof record.name === "string" && record.name.trim() ? record.name.trim().slice(0, MAX_RULE_NAME_CHARS) : null;
    const start = typeof record.start === "string" ? record.start.trim().slice(0, MAX_RULE_BOUNDARY_CHARS) : "";
    const end = typeof record.end === "string" ? record.end.trim().slice(0, MAX_RULE_BOUNDARY_CHARS) : "";
    if (!id || !name || !start || !end) continue;
    if (seenIds.has(id)) continue;
    const pairKey = `${start}\u0000${end}`;
    if (seenPairs.has(pairKey)) continue;
    seenIds.add(id);
    seenPairs.add(pairKey);
    normalized.push({
      id,
      name,
      start,
      end,
      enabled: record.enabled !== false,
      ...(record.builtin === true ? { builtin: true } : {}),
    });
  }
  return normalized.slice(0, MAX_REPLACE_RULES);
}
