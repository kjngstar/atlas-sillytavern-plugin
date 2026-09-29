/**
 * atlas-lore-selection.ts — P2-01
 *
 * 纯函数:接受一组世界书条目 + 关键词,按"激活/相关/地理背景"排序并截断
 * 到 ATLAS_LIMITS.LORE_SUPPLEMENT_CHARS 字符预算。输出包含选中条目 ID
 * 与每条被截断的字节数,便于上层在 diagnostic 记录用途与覆盖。
 *
 * 排序:确认激活 → 当前场景/正文/人物交集 → 地理背景;同分按书名 + UID 固定
 * 排序,字符预算保持 ATLAS_LIMITS.LORE_SUPPLEMENT_CHARS。空 keywords 不
 * 凭空激活;同一输入次序稳定;中文长内容优先保留含关键词片段。
 *
 * 注意:此模块不负责读取宿主世界书,只负责"已读到条目"的有界选取。
 */

export type AtlasLorePurpose = "turn" | "geo" | "bootstrap";

export interface AtlasLoreSelectionEntry {
  /** 条目稳定 id(可选) */
  uid?: string;
  /** 条目标题/触发关键词摘要 */
  title?: string;
  /** 来源书名(便于追踪) */
  bookName?: string;
  /** 宿主条目的明示触发词。 */
  keys?: readonly string[];
  /** 条目正文 */
  content: string;
  /** 是否被宿主标为激活(activate=false 视为不激活) */
  enabled: boolean;
}

export interface AtlasLoreSelectionInput {
  /** 候选条目(已按宿主语义过滤 disable 等) */
  entries: readonly AtlasLoreSelectionEntry[];
  /** 宿主本轮已激活条目 uid(可选) */
  activatedUids?: ReadonlySet<string>;
  /** 当前场景/正文/人物关键词(用于排序) */
  chatKeywords: ReadonlySet<string>;
  /** 当前回合正文/场景关键词(用于排序) */
  sceneKeywords: ReadonlySet<string>;
  /** 用途(影响截断与排序) */
  mode: AtlasLorePurpose;
  /** 字符预算上限 */
  maxChars: number;
  /** 每条正文最大字符(geo 默认更长) */
  perEntryChars?: number;
  /** 最多条目数 */
  maxEntries?: number;
}

export interface AtlasLoreSelectionResult {
  text: string;
  selectedUids: string[];
  /** 选中条目原始总长度 */
  selectedOriginalChars: number;
  /** 实际输出字符数 */
  selectedOutputChars: number;
  /** 被截断的条目数 */
  truncatedCount: number;
  /** 候选总数(已过滤 disable/空内容) */
  candidateCount: number;
  /** 来源模式 */
  sourceMode: AtlasLorePurpose;
}

const DEFAULT_PER_ENTRY_CHARS = 400;
const DEFAULT_GEO_PER_ENTRY_CHARS = 4_000;
const DEFAULT_MAX_ENTRIES = 60;
const GEO_TITLE_PREFIX = /(?:地图|地理|地点|地区|区域|领域|城镇|城市|城镇|关隘|道路|街道|聚落|场所|大陆|国家|地形|风土)/;

function stableUid(entry: AtlasLoreSelectionEntry, _idx: number): string {
  const fallback = `${entry.title ?? ""}:${entry.content.slice(0, 80)}`;
  return `${entry.bookName ?? "?"}:${entry.uid && entry.uid.length > 0 ? entry.uid : fallback}`;
}

function matchingExcerpt(content: string, keywords: readonly string[], limit: number): string {
  if (content.length <= limit) return content;
  const hit = keywords.filter((word) => word.length > 0)
    .map((word) => content.indexOf(word)).filter((at) => at >= 0).sort((a, b) => a - b)[0];
  const start = hit === undefined ? 0 : Math.max(0, Math.min(content.length - limit, hit - Math.floor(limit / 3)));
  return `${start > 0 ? "…" : ""}${content.slice(start, start + limit)}${start + limit < content.length ? "…" : ""}`;
}

function keywordScore(
  entry: AtlasLoreSelectionEntry,
  chat: ReadonlySet<string>,
  scene: ReadonlySet<string>,
): number {
  let score = 0;
  const text = (entry.title ?? "") + "\n" + (entry.keys ?? []).join("\n") + "\n" + entry.content;
  for (const k of chat) {
    if (k.length > 0 && text.includes(k)) score += 1;
  }
  for (const k of scene) {
    if (k.length > 0 && text.includes(k)) score += 5;
  }
  return score;
}

function isGeographicTitle(title: string): boolean {
  if (!title) return false;
  return GEO_TITLE_PREFIX.test(title);
}

export function selectAtlasLoreSupplement(
  input: AtlasLoreSelectionInput,
): AtlasLoreSelectionResult {
  const perEntryChars = input.perEntryChars
    ?? (input.mode === "geo" ? DEFAULT_GEO_PER_ENTRY_CHARS : DEFAULT_PER_ENTRY_CHARS);
  const maxEntries = input.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxChars = Math.max(0, input.maxChars | 0);

  const filtered: Array<AtlasLoreSelectionEntry & { __idx: number }> = [];
  for (let i = 0; i < input.entries.length; i++) {
    const e = input.entries[i];
    if (!e || e.enabled === false) continue;
    if (typeof e.content !== "string" || e.content.trim().length === 0) continue;
    filtered.push(Object.assign({}, e, { __idx: i }));
  }

  const activatedUids = input.activatedUids;
  const chat = input.chatKeywords;
  const scene = input.sceneKeywords;

  // 排序(确定性:不依赖输入次序,只用 bookName + uid 做 tiebreaker)
  filtered.sort((a, b) => {
    const aAct = activatedUids?.has(stableUid(a, a.__idx)) ? 1 : 0;
    const bAct = activatedUids?.has(stableUid(b, b.__idx)) ? 1 : 0;
    if (aAct !== bAct) return bAct - aAct;
    const aScore = keywordScore(a, chat, scene);
    const bScore = keywordScore(b, chat, scene);
    if (aScore !== bScore) return bScore - aScore;
    const aGeo = isGeographicTitle(a.title ?? "") ? 1 : 0;
    const bGeo = isGeographicTitle(b.title ?? "") ? 1 : 0;
    if (input.mode === "geo" && aGeo !== bGeo) return bGeo - aGeo;
    // 同分:短条目优先(精炼),但 mode='geo' 时长条目优先(详尽)
    const aLen = a.content.length;
    const bLen = b.content.length;
    if (aLen !== bLen) return input.mode === "geo" ? bLen - aLen : aLen - bLen;
    const aBook = a.bookName ?? "";
    const bBook = b.bookName ?? "";
    if (aBook !== bBook) return aBook < bBook ? -1 : 1;
    const aUid = stableUid(a, a.__idx);
    const bUid = stableUid(b, b.__idx);
    if (aUid !== bUid) return aUid < bUid ? -1 : 1;
    return 0;
  });

  const selectedUids: string[] = [];
  const out: string[] = [];
  let selectedOriginalChars = 0;
  let selectedOutputChars = 0;
  let truncatedCount = 0;

  for (const e of filtered) {
    if (selectedUids.length >= maxEntries) break;
    const uid = stableUid(e, e.__idx);
    const active = activatedUids?.has(uid) ?? false;
    const relevant = keywordScore(e, chat, scene) > 0;
    if (!active && !relevant && !(input.mode === "geo" && isGeographicTitle(e.title ?? ""))) continue;
    const title = (e.title ?? "").trim() || (e.bookName ?? "条目");
    const originalChars = e.content.length;
    const clipped = matchingExcerpt(e.content, [...scene, ...chat], perEntryChars);
    const line = `- [${e.bookName ?? "?"}] ${title}：${clipped.replace(/\s+/g, " ")}`;
    const lineLen = line.length + (out.length > 0 ? 1 : 0);
    if (selectedOutputChars + lineLen > maxChars) {
      // 预算用尽:不再继续
      break;
    }
    if (clipped.length < originalChars) truncatedCount += 1;
    selectedUids.push(uid);
    out.push(line);
    selectedOriginalChars += originalChars;
    selectedOutputChars += lineLen;
  }

  return {
    text: out.join("\n"),
    selectedUids,
    selectedOriginalChars,
    selectedOutputChars,
    truncatedCount,
    candidateCount: filtered.length,
    sourceMode: input.mode,
  };
}
