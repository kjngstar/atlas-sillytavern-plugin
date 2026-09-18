/**
 * atlas-lorebook.ts — ATLAS-09 世界书注入层。
 *
 * 目标（作者拍板）：commit 完成后，把「NPC 动向」「近期可触发的任务 / 活动」写成
 * Atlas 专属世界书条目，让主模型经酒馆正常世界书激活管线看到推演结果；
 * 当轮注入（setExtensionPrompt）仍只负责"本轮即时上下文"。
 *
 * 分层纪律：
 * - 本模块零 DOM、零酒馆依赖（酒馆 world-info API 由调用方以 port 注入），
 *   条目规划（buildLorebookPlans）是纯函数，在引擎核心 commit 成功后调用。
 * - 条目有界：每轮最多 2 条（动向 1 + 事件 1），关键词 / 内容 / 总量均有上限。
 * - 条目可追溯：内容尾部带「来源：第 X → Y 时段 + 回执号」。
 * - 面板可见：writer 返回快照，调用方自行持久化并渲染。
 * - 聊天绑定槽（chatMetadata.world_info）只有一个：只在为空时绑定，
 *   绝不静默覆盖用户已绑定的世界书（冲突时上报 conflict，由 UI 提示）。
 */

import type { StateEvent, World } from "../lib/world-schema.ts";
import { ATLAS_ERROR_CODES, AtlasError, type AtlasTurnReceipt } from "./atlas-contract.ts";

// ---------------------------------------------------------------------------
// 有界上限
// ---------------------------------------------------------------------------

export const ATLAS_LOREBOOK_LIMITS = {
  /** 单条目关键词上限 */
  KEYS_MAX: 8,
  /** 关键词单条最大字符 */
  KEY_CHARS: 64,
  /** 条目内容最大字符（含来源行） */
  CONTENT_CHARS: 480,
  /** 内容里摘要的最大字符 */
  SUMMARY_CHARS: 260,
  /** 内容里明细行（记忆 / 叙事）的最大字符 */
  DETAIL_CHARS: 120,
  /** 明细行数上限 */
  DETAIL_LINES_MAX: 4,
  /** 每轮条目上限（动向 1 + 事件 1） */
  ENTRIES_PER_TURN_MAX: 2,
  /** 动向类条目滚动保留数（超出删最旧） */
  MOVES_KEEP: 12,
  /** 事件类条目滚动保留数 */
  EVENTS_KEEP: 12,
  /** comment 最大字符 */
  COMMENT_CHARS: 96,
  /** 书名最大字符（含前缀） */
  BOOK_NAME_CHARS: 72,
} as const;

/** Atlas 条目 comment 前缀（修剪 / 识别都按前缀 + 时段号） */
export const ATLAS_LOREBOOK_PREFIX = {
  moves: "Atlas 动向 ·",
  events: "Atlas 事件 ·",
} as const;

// ---------------------------------------------------------------------------
// 世界书名：由世界名派生；剔除 ST 服务端文件名不接受的字符
// ---------------------------------------------------------------------------

export function lorebookNameFor(worldName: string): string {
  const clean = String(worldName ?? "")
    .replace(/[\\/:*?"<>|]/g, "")
    .trim()
    .slice(0, 32);
  const base = clean.length > 0 ? clean : "未命名世界";
  return `Atlas · ${base}`.slice(0, ATLAS_LOREBOOK_LIMITS.BOOK_NAME_CHARS);
}

// ---------------------------------------------------------------------------
// 条目规划（引擎侧，纯函数）
// ---------------------------------------------------------------------------

export interface AtlasLorebookPlanEntry {
  category: "moves" | "events";
  comment: string;
  keys: string[];
  content: string;
}

export interface AtlasLorebookPlans {
  bookName: string;
  entries: AtlasLorebookPlanEntry[];
}

interface NameIndex {
  characters: Map<string, string>;
  points: Map<string, string>;
  regions: Map<string, string>;
}

function buildNameIndex(world: World): NameIndex {
  const characters = new Map<string, string>();
  for (const c of world.characters ?? []) {
    if (c && c.id !== undefined && c.name) characters.set(String(c.id), String(c.name).slice(0, ATLAS_LOREBOOK_LIMITS.KEY_CHARS));
  }
  const points = new Map<string, string>();
  for (const p of world.points ?? []) {
    if (p && p.id !== undefined && p.name) points.set(String(p.id), String(p.name).slice(0, ATLAS_LOREBOOK_LIMITS.KEY_CHARS));
  }
  const regions = new Map<string, string>();
  for (const r of world.regions ?? []) {
    if (r && r.id !== undefined && r.name) regions.set(String(r.id), String(r.name).slice(0, ATLAS_LOREBOOK_LIMITS.KEY_CHARS));
  }
  return { characters, points, regions };
}

function dedupeKeys(values: string[]): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const key = String(raw ?? "").trim().slice(0, ATLAS_LOREBOOK_LIMITS.KEY_CHARS);
    if (key.length === 0) continue;
    if (out.some((existing) => existing === key)) continue;
    out.push(key);
    if (out.length >= ATLAS_LOREBOOK_LIMITS.KEYS_MAX) break;
  }
  return out;
}

function clip(text: string, max: number): string {
  const clean = String(text ?? "").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

function traceLine(receipt: AtlasTurnReceipt): string {
  return `[Atlas · 第 ${String(receipt.previousTime)} → ${String(receipt.currentTime)} 时段 · 回执 ${String(receipt.receiptId).slice(0, 16)}]`;
}

/** 从 effects / entityRefs 收集受影响实体 id（去重、有界）。 */
function involvedEntityIds(event: StateEvent): string[] {
  const ids: string[] = [];
  const push = (raw: unknown) => {
    const id = String(raw ?? "").trim();
    if (id.length === 0 || ids.includes(id)) return;
    ids.push(id);
  };
  for (const id of event.entityRefs ?? []) push(id);
  for (const effect of event.effects ?? []) {
    const record = effect as Record<string, unknown>;
    push(record?.entityId);
    push(record?.targetEntityId);
  }
  return ids.slice(0, ATLAS_LOREBOOK_LIMITS.KEYS_MAX * 2);
}

/** 明细行：本轮落在角色身上的记忆 / 叙事文本（有界）。 */
function detailLines(event: StateEvent, names: Map<string, string>): string[] {
  const lines: string[] = [];
  for (const effect of event.effects ?? []) {
    if (lines.length >= ATLAS_LOREBOOK_LIMITS.DETAIL_LINES_MAX) break;
    const record = effect as Record<string, unknown>;
    const kind = String(record?.kind ?? "");
    const text = typeof record?.text === "string" ? record.text.trim() : "";
    if (!text) continue;
    if (kind !== "appendMemoryRef" && kind !== "attachNarrativeEntry") continue;
    const name = names.get(String(record?.entityId ?? "")) ?? null;
    const who = name ? `${name}：` : "";
    lines.push(`· ${who}${clip(text, ATLAS_LOREBOOK_LIMITS.DETAIL_CHARS)}`);
  }
  return lines;
}

/**
 * commit 成功后，从账本事件派生世界书条目规划。
 * - committed 且有采用事件才有条目；duplicate / failed / 空轮 → null（调用方跳过）。
 * - 每轮最多 2 条：动向（关键词 = 涉及 NPC 名）+ 事件（关键词 = 所在地点名）。
 * - 没有可用关键词的条目直接省略；两条都省略 → null。
 * - 确定性：同世界状态 + 同回执 → 逐字节相同（可重放）。
 */
export function buildLorebookPlans(world: World, receipt: AtlasTurnReceipt): AtlasLorebookPlans | null {
  if (receipt.status !== "committed") return null;
  const adoptedIds = (receipt.adoptedEventIds ?? []).map((id) => String(id));
  if (adoptedIds.length === 0) return null;

  const event = (world.stateEvents ?? []).find((e) => e && adoptedIds.includes(String(e.id)));
  if (!event) return null;

  const index = buildNameIndex(world);
  const entries: AtlasLorebookPlanEntry[] = [];
  const trace = traceLine(receipt);
  const summary = clip(event.narrativeSummary ?? receipt.summary, ATLAS_LOREBOOK_LIMITS.SUMMARY_CHARS);

  // 动向：关键词 = 本轮被 effect 触及的角色名
  const involved = involvedEntityIds(event);
  const characterNames = dedupeKeys(involved.map((id) => index.characters.get(id) ?? "").filter(Boolean));
  if (characterNames.length > 0) {
    const lines = [summary, ...detailLines(event, index.characters), trace];
    entries.push({
      category: "moves",
      comment: clip(`${ATLAS_LOREBOOK_PREFIX.moves} 第 ${String(receipt.previousTime)} → ${String(receipt.currentTime)} 时段`, ATLAS_LOREBOOK_LIMITS.COMMENT_CHARS),
      keys: characterNames,
      content: lines.join("\n").slice(0, ATLAS_LOREBOOK_LIMITS.CONTENT_CHARS),
    });
  }

  // 事件：关键词 = 回执落点地点名（+ 地区名），让「走近某地」也能激活
  const locationKeys = dedupeKeys([
    receipt.currentLocationId !== undefined && receipt.currentLocationId !== null ? index.points.get(String(receipt.currentLocationId)) ?? "" : "",
  ]);
  if (locationKeys.length > 0) {
    const lines = [`近期可触发：${summary}`, trace];
    entries.push({
      category: "events",
      comment: clip(`${ATLAS_LOREBOOK_PREFIX.events} 第 ${String(receipt.currentTime)} 时段`, ATLAS_LOREBOOK_LIMITS.COMMENT_CHARS),
      keys: locationKeys,
      content: lines.join("\n").slice(0, ATLAS_LOREBOOK_LIMITS.CONTENT_CHARS),
    });
  }

  if (entries.length === 0) return null;
  return {
    bookName: lorebookNameFor(String(world.name ?? "")),
    entries: entries.slice(0, ATLAS_LOREBOOK_LIMITS.ENTRIES_PER_TURN_MAX),
  };
}

// ---------------------------------------------------------------------------
// 严格解析（UI 核心侧；引擎响应不可信）
// ---------------------------------------------------------------------------

function asBoundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  if (value.length > max) return null;
  return value;
}

export function parseAtlasLorebookPlans(raw: unknown): { ok: true; value: AtlasLorebookPlans } | { ok: false; error: AtlasError } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "lorebook 载荷必须是对象") };
  }
  const record = raw as Record<string, unknown>;
  const bookName = asBoundedString(record.bookName, ATLAS_LOREBOOK_LIMITS.BOOK_NAME_CHARS);
  if (!bookName || bookName.trim().length === 0) {
    return { ok: false, error: new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "lorebook.bookName 非法") };
  }
  if (!Array.isArray(record.entries) || record.entries.length === 0 || record.entries.length > ATLAS_LOREBOOK_LIMITS.ENTRIES_PER_TURN_MAX) {
    return { ok: false, error: new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "lorebook.entries 数量非法") };
  }
  const entries: AtlasLorebookPlanEntry[] = [];
  for (const item of record.entries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "lorebook 条目必须是对象") };
    }
    const entry = item as Record<string, unknown>;
    const category = entry.category === "moves" || entry.category === "events" ? entry.category : null;
    const comment = asBoundedString(entry.comment, ATLAS_LOREBOOK_LIMITS.COMMENT_CHARS);
    const content = asBoundedString(entry.content, ATLAS_LOREBOOK_LIMITS.CONTENT_CHARS);
    if (!category || !comment || !content) {
      return { ok: false, error: new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "lorebook 条目字段非法或超限") };
    }
    if (!Array.isArray(entry.keys) || entry.keys.length === 0 || entry.keys.length > ATLAS_LOREBOOK_LIMITS.KEYS_MAX) {
      return { ok: false, error: new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "lorebook 条目 keys 数量非法") };
    }
    const keys: string[] = [];
    for (const key of entry.keys) {
      const bounded = asBoundedString(key, ATLAS_LOREBOOK_LIMITS.KEY_CHARS);
      if (!bounded || bounded.trim().length === 0) {
        return { ok: false, error: new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "lorebook 条目 key 非法") };
      }
      keys.push(bounded);
    }
    entries.push({ category, comment, keys, content });
  }
  return { ok: true, value: { bookName, entries } };
}

// ---------------------------------------------------------------------------
// 写入器（浏览器侧；酒馆 world-info API 由 port 注入）
// ---------------------------------------------------------------------------

export interface AtlasLorebookPort {
  /** 深拷贝读取；书不存在 → null（实现方须吞掉"不存在"类错误） */
  loadBook(name: string): Promise<unknown | null>;
  createBook(name: string): Promise<void>;
  /** 整书保存；保存后调用方不再改动该 data（酒馆缓存不深拷贝） */
  saveBook(name: string, data: unknown): Promise<void>;
  /** 在 data.entries 里创建一条模板条目并按 patch 填字段（酒馆 createWorldInfoEntry） */
  createEntry(data: Record<string, unknown>, patch: { comment: string; keys: string[]; content: string }): unknown;
  deleteEntry(data: Record<string, unknown>, uid: string): void;
  /** 当前聊天绑定的世界书名（chatMetadata.world_info）；未绑定 → null */
  getChatBookName(): Promise<string | null>;
  bindChatBook(name: string): Promise<void>;
  /**
   * 首选目标世界书（作者 2026-09-18 拍板，参照 shujuku 角色卡世界书方式）：
   * 返回当前角色卡的主世界书名（character.data.extensions.world）时，
   * 条目直接写入该书、完全不占用聊天绑定槽；null / 未实现 → 回退
   * plans.bookName（Atlas 专属书 + 绑定空槽）。
   */
  resolvePreferredBook?(): Promise<string | null>;
}

export interface AtlasLorebookEntryView {
  category: "moves" | "events";
  comment: string;
  keys: string[];
  content: string;
}

export interface AtlasLorebookSyncResult {
  bookName: string;
  created: boolean;
  written: number;
  pruned: number;
  /** char-primary = 写入当前角色卡的主世界书（不占聊天绑定槽） */
  binding: "char-primary" | "bound-by-atlas" | "already-bound" | "conflict";
  existingBookName: string | null;
  /** 同步后书内的全部 Atlas 条目（面板可见性用） */
  entries: AtlasLorebookEntryView[];
}

function asEntriesRecord(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (!record.entries || typeof record.entries !== "object" || Array.isArray(record.entries)) return null;
  return record;
}

function entryView(raw: unknown): AtlasLorebookEntryView | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const comment = typeof entry.comment === "string" ? entry.comment : "";
  const category = comment.startsWith(ATLAS_LOREBOOK_PREFIX.moves)
    ? "moves" as const
    : comment.startsWith(ATLAS_LOREBOOK_PREFIX.events)
      ? "events" as const
      : null;
  if (!category) return null;
  const keys = Array.isArray(entry.key) ? entry.key.map((k) => String(k)).slice(0, ATLAS_LOREBOOK_LIMITS.KEYS_MAX) : [];
  const content = typeof entry.content === "string" ? entry.content.slice(0, ATLAS_LOREBOOK_LIMITS.CONTENT_CHARS) : "";
  return { category, comment, keys, content };
}

/** comment 里的时段号（取最后一个数字）；无 → -1（排最旧）。 */
function periodOf(comment: string): number {
  const matches = [...comment.matchAll(/(\d+)/g)];
  const last = matches[matches.length - 1];
  return last ? Number(last[1]) : -1;
}

function collectAtlasEntries(data: Record<string, unknown>): Array<{ uid: string; view: AtlasLorebookEntryView }> {
  const entries = data.entries as Record<string, unknown>;
  const out: Array<{ uid: string; view: AtlasLorebookEntryView }> = [];
  for (const [uid, raw] of Object.entries(entries)) {
    const view = entryView(raw);
    if (view) out.push({ uid, view });
  }
  return out;
}

export function createAtlasLorebookWriter(port: AtlasLorebookPort, opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now;

  async function loadOrCreate(name: string): Promise<{ data: Record<string, unknown>; created: boolean }> {
    const loaded = await port.loadBook(name);
    const existing = asEntriesRecord(loaded);
    if (existing) return { data: existing, created: false };
    if (loaded !== null && loaded !== undefined) {
      // 书存在但形状不合法：绝不能整书覆盖（可能不是 Atlas 建的书）
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "目标世界书载荷异常，跳过 Atlas 条目写入。");
    }
    await port.createBook(name);
    const created = await port.loadBook(name);
    const data = asEntriesRecord(created);
    if (!data) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "Atlas 世界书创建后无法读取。");
    }
    return { data, created: true };
  }

  return {
    /**
     * 把一轮的条目规划写入目标世界书（作者 2026-09-18 拍板：角色卡世界书优先）：
     * 0. 端口能解析出角色卡主世界书 → 直接写该书（cardMode，不占聊天绑定槽）；
     *    否则目标 = plans.bookName（Atlas 专属书）；
     * 1. 书不存在 → createBook；存在但非法 → 拒绝（不覆盖）；
     * 2. 按 comment upsert（同轮重复同步不产生重复条目）；
     * 3. 按类目滚动修剪（时段号新 → 旧保留 MOVES_KEEP / EVENTS_KEEP）；
     * 4. 整书保存一次；保存后不再改动 data（酒馆缓存不深拷贝）；
     * 5. 专属书模式下：聊天绑定槽为空才绑定；已绑定别的书 → conflict（绝不静默覆盖）。
     */
    async syncTurn(plans: AtlasLorebookPlans): Promise<AtlasLorebookSyncResult> {
      if (!plans || !Array.isArray(plans.entries) || plans.entries.length === 0) {
        throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "lorebook 规划为空，跳过写入。");
      }
      let targetName = plans.bookName;
      let cardMode = false;
      if (typeof port.resolvePreferredBook === "function") {
        try {
          const preferred = await port.resolvePreferredBook();
          if (typeof preferred === "string" && preferred.trim()) {
            targetName = preferred;
            cardMode = true;
          }
        } catch {
          // 目标解析失败 → 回退专属书路径
        }
      }
      const { data, created } = await loadOrCreate(targetName);
      const entriesRecord = data.entries as Record<string, unknown>;

      let written = 0;
      for (const plan of plans.entries) {
        const existingUid = Object.keys(entriesRecord).find((uid) => {
          const raw = entriesRecord[uid] as Record<string, unknown> | null;
          return raw && typeof raw.comment === "string" && raw.comment === plan.comment;
        });
        if (existingUid !== undefined) {
          const entry = entriesRecord[existingUid] as Record<string, unknown>;
          entry.key = [...plan.keys];
          entry.keysecondary = [];
          entry.content = plan.content;
          entry.disable = false;
          entry.constant = false;
        } else {
          port.createEntry(data, { comment: plan.comment, keys: [...plan.keys], content: plan.content });
        }
        written += 1;
      }

      // 滚动修剪：每类目只留最近 K 条
      let pruned = 0;
      const caps: Record<"moves" | "events", number> = { moves: ATLAS_LOREBOOK_LIMITS.MOVES_KEEP, events: ATLAS_LOREBOOK_LIMITS.EVENTS_KEEP };
      for (const category of ["moves", "events"] as const) {
        const pool = collectAtlasEntries(data)
          .filter((item) => item.view.category === category)
          .sort((a, b) => periodOf(b.view.comment) - periodOf(a.view.comment));
        for (const item of pool.slice(caps[category])) {
          port.deleteEntry(data, item.uid);
          pruned += 1;
        }
      }

      // 保存前抓一次全量视图（保存后不得再碰 data）
      const finalEntries = collectAtlasEntries(data).map((item) => item.view);

      await port.saveBook(targetName, data);

      // 聊天绑定：只有专属书模式才涉及绑定槽（角色卡世界书随角色激活，无需绑定）
      let binding: AtlasLorebookSyncResult["binding"];
      let existingBookName: string | null = null;
      if (cardMode) {
        binding = "char-primary";
      } else {
        const chatBook = await port.getChatBookName();
        if (chatBook === null || chatBook === "") {
          await port.bindChatBook(targetName);
          binding = "bound-by-atlas";
        } else if (chatBook === targetName) {
          binding = "already-bound";
        } else {
          binding = "conflict";
          existingBookName = chatBook;
        }
      }

      return {
        bookName: targetName,
        created,
        written,
        pruned,
        binding,
        existingBookName,
        entries: finalEntries,
      };
    },

    /** 面板可见性快照（调用方持久化到 store 的 "lorebook" 文档）。 */
    snapshot(plans: AtlasLorebookPlans, result: AtlasLorebookSyncResult) {
      return {
        schemaVersion: 1 as const,
        bookName: result.bookName,
        updatedAt: now(),
        created: result.created,
        written: result.written,
        pruned: result.pruned,
        binding: result.binding,
        existingBookName: result.existingBookName,
        entries: result.entries,
      };
    },
  };
}
