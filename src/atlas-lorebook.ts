/**
 * atlas-lorebook.ts — ATLAS-09 世界书注入层。
 *
 * 目标（作者拍板，0.9.40 收口）：commit 完成后，把世界的「当前动向」写成
 * Atlas 专属世界书条目，让主模型经酒馆正常世界书激活管线看到推演结果；
 * 当轮注入（setExtensionPrompt）仍只负责"本轮即时上下文"。
 *
 * 0.9.40 设计（作者 2026-09-21 拍板：世界书只要动向、不特意强调时段）：
 * - 单条滚动条目「Atlas 动向」：固定 comment（不带时段）、constant 蓝灯常驻，
 *   每个 committed 回合后整体重写内容（含零 effect 回合——当前时间必须永远最新）。
 * - 内容只保留叙事与权威状态（当前时间 / 位置 / 近期动向），剥离引擎附加的
 *   「（本轮无实体变化：仅时间 / 位置推进，未写入账本）」类无变化注记。
 * - 旧版逐轮条目（「Atlas 动向 · 第 X → Y 时段」「Atlas 事件 · …」）与
 *   0.9.35「Atlas 状态总览」由 writer 在同步时清理，存量书自动收敛为单条。
 *
 * 分层纪律：
 * - 本模块零 DOM、零酒馆依赖（酒馆 world-info API 由调用方以 port 注入），
 *   条目规划（buildLorebookPlans）是纯函数，在引擎核心 commit 成功后调用。
 * - 条目有界：内容 / key 均有上限；确定性：同世界状态 + 同回执 → 逐字节相同。
 * - 面板可见：writer 返回快照，调用方自行持久化并渲染。
 * - 聊天绑定槽（chatMetadata.world_info）只有一个：只在为空时绑定，
 *   绝不静默覆盖用户已绑定的世界书（冲突时上报 conflict，由 UI 提示）。
 */

import type { World } from "../lib/world-schema.ts";
import { ATLAS_ERROR_CODES, AtlasError, type AtlasTurnReceipt } from "./atlas-contract.ts";

// ---------------------------------------------------------------------------
// 有界上限
// ---------------------------------------------------------------------------

export const ATLAS_LOREBOOK_LIMITS = {
  /** 单条目关键词上限 */
  KEYS_MAX: 8,
  /** 关键词单条最大字符 */
  KEY_CHARS: 64,
  /** 条目内容最大字符 */
  CONTENT_CHARS: 480,
  /** 近期动向单行最大字符 */
  RECENT_LINE_CHARS: 160,
  /** 近期动向保留条数 */
  RECENT_LINES_MAX: 5,
  /** comment 最大字符 */
  COMMENT_CHARS: 96,
  /** 书名最大字符（含前缀） */
  BOOK_NAME_CHARS: 72,
} as const;

/** Atlas 条目 comment 前缀（识别 / 回喂排除 / 存量清理都按前缀）。 */
export const ATLAS_LOREBOOK_PREFIX = {
  /** 0.9.40 唯一在产条目前缀（滚动条目 comment 与前缀相同，固定不带时段） */
  moves: "Atlas 动向",
  /** 0.9.39 及之前的逐轮事件条目（仅用于回喂排除与存量清理，不再生成） */
  events: "Atlas 事件",
  /** 0.9.35 常驻聚合条目（0.9.40 起废弃；保留前缀用于回喂排除与存量清理） */
  status: "Atlas 状态总览",
} as const;

/** 滚动条目的固定 comment（不带时段——条目每轮整体重写，无需时段区分）。 */
export const ATLAS_MOVES_ENTRY_COMMENT = ATLAS_LOREBOOK_PREFIX.moves;

/** 滚动条目的占位 key（条目靠 constant 激活，key 仅为宿主兼容保留）。 */
export const ATLAS_MOVES_ENTRY_KEY = "Atlas 动向-Key";

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
  /** 常驻条目（constant 蓝灯）：滚动「Atlas 动向」恒为 true */
  constant?: boolean;
}

export interface AtlasLorebookPlans {
  bookName: string;
  entries: AtlasLorebookPlanEntry[];
}

interface NameIndex {
  points: Map<string, string>;
}

function buildNameIndex(world: World): NameIndex {
  const points = new Map<string, string>();
  for (const p of world.points ?? []) {
    if (p && p.id !== undefined && p.name) points.set(String(p.id), String(p.name).slice(0, ATLAS_LOREBOOK_LIMITS.KEY_CHARS));
  }
  return { points };
}

function clip(text: string, max: number): string {
  const clean = String(text ?? "").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 剥离引擎附加的「无变化」注记（作者 2026-09-21 反馈：世界书只保留叙事，
 * 「这里写时间没变化怎么还推进时段了」类引擎口径一律不进条目）。
 */
function stripEngineNotes(text: string): string {
  return String(text ?? "")
    .replace(/（本轮无[^）]*）/g, "")
    .replace(/本轮无世界变化。?/g, "")
    .trim();
}

/**
 * commit 成功后，从世界状态派生滚动条目规划（0.9.40）。
 * - committed 才有条目；duplicate / failed → null（调用方跳过）。
 * - 每个 committed 回合（含零 effect——仅时间 / 位置推进）都产出同一条规划：
 *   writer 按 comment upsert 整体重写，「当前时间」永远最新（修复 0.9.39 及之前
 *   零 effect 回合不重写总览导致条目时间停在旧时段的矛盾）。
 * - 确定性：同世界状态 + 同回执 → 逐字节相同（可重放）。
 */
export function buildLorebookPlans(world: World, receipt: AtlasTurnReceipt): AtlasLorebookPlans | null {
  if (receipt.status !== "committed") return null;
  const index = buildNameIndex(world);
  const locationName = receipt.currentLocationId !== undefined && receipt.currentLocationId !== null
    ? index.points.get(String(receipt.currentLocationId)) ?? "未知地点"
    : null;
  const recent = (world.stateEvents ?? [])
    .slice(-ATLAS_LOREBOOK_LIMITS.RECENT_LINES_MAX)
    .reverse()
    .map((e) => `· [第 ${String(e.at)} 时段] ${clip(stripEngineNotes(e.narrativeSummary ?? ""), ATLAS_LOREBOOK_LIMITS.RECENT_LINE_CHARS)}`);
  const lines = [
    "【世界动向】本条目由 Atlas 每轮推演后自动更新：以下是当前时间点的权威世界动向，进行剧情分析时以此最新数据为准，优先级高于其他背景设定。",
    `当前时间：第 ${String(receipt.currentTime)} 时段`,
    ...(locationName ? [`当前位置：${locationName}`] : []),
    "近期动向：",
    ...(recent.length > 0 ? recent : ["· （暂无已归档的世界变化）"]),
  ];
  const entry: AtlasLorebookPlanEntry = {
    category: "moves",
    comment: ATLAS_MOVES_ENTRY_COMMENT,
    keys: [ATLAS_MOVES_ENTRY_KEY],
    content: lines.join("\n").slice(0, ATLAS_LOREBOOK_LIMITS.CONTENT_CHARS),
    constant: true,
  };
  return {
    bookName: lorebookNameFor(String(world.name ?? "")),
    entries: [entry],
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
  if (!Array.isArray(record.entries) || record.entries.length === 0 || record.entries.length > 1) {
    return { ok: false, error: new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "lorebook.entries 数量非法") };
  }
  const item = record.entries[0];
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
  return {
    ok: true,
    value: {
      bookName,
      entries: [{ category, comment, keys, content, ...(entry.constant === true ? { constant: true } : {}) }],
    },
  };
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
  /** 在 data.entries 里创建一条模板条目并按 patch 填字段（酒馆 createWorldInfoEntry）。
   *  constant / order / position / preventRecursion 为常驻条目可选字段。 */
  createEntry(
    data: Record<string, unknown>,
    patch: {
      comment: string;
      keys: string[];
      content: string;
      constant?: boolean;
      order?: number;
      position?: number;
      preventRecursion?: boolean;
    },
  ): unknown;
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
     * 3. 0.9.40 收口：书里只保留唯一的「Atlas 动向」滚动条目——旧版逐轮条目
     *    （「Atlas 动向 · 第 X → Y 时段」「Atlas 事件 · …」）与「Atlas 状态总览」
     *    一律清除（作者 2026-09-21 拍板：世界书只要动向、不强调时段）；
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
        const isConstant = plan.constant === true;
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
          entry.constant = isConstant;
          if (isConstant) entry.prevent_recursion = true;
        } else {
          port.createEntry(data, {
            comment: plan.comment,
            keys: [...plan.keys],
            content: plan.content,
            ...(isConstant ? { constant: true, order: 9998, position: 0, preventRecursion: true } : {}),
          });
        }
        written += 1;
      }

      // 0.9.40 存量清理：凡 Atlas 条目但 comment 不是当前滚动条目 → 删除
      // （旧版逐轮条目 / 0.9.35 状态总览一次性收敛，之后每轮此循环都是 no-op）。
      // 注意不能走 collectAtlasEntries——entryView 只认 moves/events 前缀，
      // 「Atlas 状态总览」会漏删；这里按 Atlas 前缀全集直接扫原始 entries。
      let pruned = 0;
      const atlasPrefixes = Object.values(ATLAS_LOREBOOK_PREFIX);
      for (const [uid, raw] of Object.entries(entriesRecord)) {
        const comment = raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).comment === "string"
          ? (raw as Record<string, unknown>).comment as string
          : "";
        const isAtlas = atlasPrefixes.some((prefix) => comment.startsWith(prefix));
        if (isAtlas && comment !== ATLAS_MOVES_ENTRY_COMMENT) {
          port.deleteEntry(data, uid);
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

    /**
     * 0.9.47 聊天级生命周期（学 shujuku 的开场清理）：把目标书里**全部** Atlas
     * 前缀条目清掉（含当前滚动条目）。用于切到未绑定世界的新聊天——旧聊天的
     * 动向不该留在随卡激活的书里给新聊天看。切回旧聊天时由调用方按会话世界
     * 状态重建条目，数据本身在 chatMetadata.atlas 会话里，零丢失。
     * 目标书解析与 syncTurn 同口径（角色卡主书优先）；书不存在 = 没什么可清。
     */
    async purgeAll(): Promise<{ bookName: string | null; pruned: number }> {
      let targetName: string | null = null;
      if (typeof port.resolvePreferredBook === "function") {
        try {
          const preferred = await port.resolvePreferredBook();
          if (typeof preferred === "string" && preferred.trim()) targetName = preferred;
        } catch {
          return { bookName: null, pruned: 0 };
        }
      }
      if (!targetName) return { bookName: null, pruned: 0 };
      const loaded = await port.loadBook(targetName);
      const data = asEntriesRecord(loaded);
      if (!data) return { bookName: targetName, pruned: 0 };
      const entriesRecord = data.entries as Record<string, unknown>;
      const atlasPrefixes = Object.values(ATLAS_LOREBOOK_PREFIX);
      let pruned = 0;
      for (const [uid, raw] of Object.entries(entriesRecord)) {
        const comment = raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).comment === "string"
          ? (raw as Record<string, unknown>).comment as string
          : "";
        if (atlasPrefixes.some((prefix) => comment.startsWith(prefix))) {
          port.deleteEntry(data, uid);
          pruned += 1;
        }
      }
      if (pruned > 0) await port.saveBook(targetName, data);
      return { bookName: targetName, pruned };
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
