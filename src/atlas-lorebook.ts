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
 *
 * B05（施工计划 §3-B05 / 问题 F10）：**聊天作用域与跨聊天隔离**。
 * 角色卡主世界书（`character.data.extensions.world`）随卡激活，**同一张卡的所有
 * 聊天共用同一本**，因此绝不能在共享主卡书里写「恒常的跨聊天动态条目」——那样
 * 两个并行聊天会互见对方的「Atlas 动向」。本模块按计划的优先级处理：
 *   1. 动态会话内容**优先走当前聊天的 `setExtensionPrompt` 注入通道**（port
 *      `injectTurn`）——注入是「当前聊天的一轮临时上下文」，天然不跨聊天；
 *   2. 没有注入通道（或注入失败）时，改为写**按 `chatId + worldId` 独立的专属
 *      世界书**（scopeBookName）：书名带 chat 指纹，聊天绑定槽只指向当前聊天这
 *      一本，两个聊天写的是两本不同的书；
 *   3. **静态用户世界书内容一律不动**：只有 comment 以 `ATLAS_LOREBOOK_PREFIX`
 *      开头的 Atlas 条目会被识别/清理，其余条目（用户设定）原样保留；
 *   4. 旧版写在共享书里的 Atlas 条目（无 chat 指纹的「Atlas 动向」等）**只在新
 *      路径写成功之后**才清理（migrated / cleanedShared）；新路径失败 → 旧条目
 *      原样保留，caller 继续走旧读取路径（旧档无损）。
 * 作用域缺席（port 未实现 `resolveChatScope`，例如 0.9.58 遗留调用点）时，本模块
 * 行为与 0.9.58 **逐字节一致**（单条共享滚动条目 + 聊天绑定槽），不擅自改变既有
 * 部署形态；作用域一旦接上，隔离立即生效。适配点见 `AtlasLorebookPort.resolveChatScope`
 * 与 `AtlasLorebookPort.injectTurn` 的注释。
 */

import type { World } from "../lib/world-schema.ts";
import { ATLAS_ERROR_CODES, AtlasError, type AtlasTurnReceipt } from "./atlas-contract.ts";
import {
  ATLAS_ITEM_DESTROYED_STATUS,
  type AtlasCharacterRow,
  type AtlasLocationRow,
  type AtlasThreeTablesV1,
} from "./atlas-tables.ts";

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
  /** B05：书名里 chat 指纹（确定性哈希）的十六进制位数——够唯一，又不吃书名长度 */
  SCOPE_HASH_CHARS: 10,
  /** B05：作用域键（chatId|worldId）登记用最大字符 */
  SCOPE_KEY_CHARS: 240,
  /** B05：注入通道文本最大字符（条目内容 + 一行边界说明） */
  INJECTION_CHARS: 560,
  /** E08：三表上下文里最多列几位身边人物 */
  TABLE_CHARACTERS_MAX: 6,
  /** E08：三表上下文里最多列几件地面物品 */
  TABLE_ITEMS_MAX: 4,
  /** E08：三表上下文单行最大字符 */
  TABLE_LINE_CHARS: 160,
} as const;

// ---------------------------------------------------------------------------
// B05：聊天作用域身份（chatId + worldId）——纯函数，零 IO
// ---------------------------------------------------------------------------

/**
 * B05：确定性摘要（双 seed 32 位 FNV-1a，16 位小写十六进制）。
 * 与 `atlas-simulation.ts` 的 `simulationDigest` 同一基座与同一写法，但本模块
 * 保持零跨模块依赖（只 import 类型），故自带一份最小实现；**不含时间与随机**。
 */
function atlasLorebookDigest(text: string): string {
  const fnv = (input: string, seed: number): number => {
    let hash = seed >>> 0;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  };
  const low = fnv(text, 0x811c9dc5).toString(16).padStart(8, "0");
  const high = fnv(`${text}#atlas`, 0x1000193).toString(16).padStart(8, "0");
  return low + high;
}

/**
 * B05 作用域：**「谁在哪个世界说话」**。
 *
 * - `chatId` 是当前酒馆聊天（`context().chatId` / `binding.chatId`）；
 * - `worldId` 是会话绑定的世界（`binding.worldId`，即 `world.id`）；
 * - `namespace` 是 Atlas 条目命名空间（换代用，默认 `atlas-moves`）。
 *
 * 这两个字段就是计划 §2.1「归属」的最小身份：同一个角色卡的两个聊天 `chatId`
 * 不同 → 作用域不同 → 动态内容不可能互相看见。IF 分支属于 D 段（分支键另有
 * `branchKey`），本阶段不引入，但 `namespace` 段已为将来「同聊天多序列」留好位置。
 */
export interface AtlasLorebookScope {
  chatId: string;
  worldId: string;
  namespace?: string;
}

/** 作用域输入（可为空——旧调用点、无绑定聊天都走这条） */
export type AtlasLorebookScopeInput = Partial<AtlasLorebookScope> | null | undefined;

/**
 * B05：把任意输入规范成**合法作用域**，非法 / 缺字段一律 → null
 * （调用方据此回退旧行为；绝不拿空 chatId 造一个"看似有作用域"的假身份）。
 */
export function normalizeAtlasLorebookScope(input: AtlasLorebookScopeInput): AtlasLorebookScope | null {
  if (!input || typeof input !== "object") return null;
  const chatId = typeof input.chatId === "string" ? input.chatId.trim() : "";
  const worldId = typeof input.worldId === "string" ? input.worldId.trim() : "";
  if (!chatId || !worldId) return null;
  const namespace = typeof input.namespace === "string" && input.namespace.trim() ? input.namespace.trim() : undefined;
  return namespace ? { chatId, worldId, namespace } : { chatId, worldId };
}

/**
 * B05：作用域里的一段「稳定键」。剔掉 `.` `:` `@` `<` `>` `/` `\`（世界书文件名与
 * 条目 comment 的分隔符都要避开），空白折叠成 `-`，超长时按 `前 40 字 + 哈希` 收敛
 * （哈希保证「前 40 字相同、尾巴不同」的两个 chatId 仍得到不同键，不静默合并）。
 */
function atlasLorebookScopeToken(raw: string, fallback: string): string {
  const cleaned = String(raw ?? "")
    .replace(/[.:@<>/\\]/g, "_")
    .replace(/\s+/g, "-")
    .trim();
  if (!cleaned) return fallback;
  if (cleaned.length <= 40) return cleaned;
  return `${cleaned.slice(0, 40)}-${atlasLorebookDigest(cleaned).slice(0, ATLAS_LOREBOOK_LIMITS.SCOPE_HASH_CHARS)}`;
}

/** B05：角色卡主世界书的**聊天指纹**（32 位 FNV-1a，确定性、不暴露原 chatId）。 */
export function atlasLorebookChatFingerprint(chatId: string): string {
  return atlasLorebookDigest(String(chatId ?? "")).slice(0, ATLAS_LOREBOOK_LIMITS.SCOPE_HASH_CHARS);
}

/**
 * B05：按 `chatId + worldId` 独立的**专属世界书名**（计划 §3-B05「书名/绑定须按
 * chatId + worldId 独立」）。形如：
 *   `Atlas · 星环余烬 · c-3f9a2b1c07`（chatId 短则直接内嵌可读键）
 *   `Atlas · 星环余烬 · c-1a2b3c4d5e`（chatId 长则改用确定性指纹）
 * 两个聊天得到两个不同的书名，因此**写的是两本书**，谁也不可能读到对方的条目；
 * 名字总长仍受 `BOOK_NAME_CHARS` 约束。
 */
export function scopeBookName(baseName: string, scope: AtlasLorebookScopeInput): string {
  const normalized = normalizeAtlasLorebookScope(scope);
  const base = `${String(baseName ?? "").trim()} · `;
  if (!normalized) {
    // 无作用域 → 沿用旧书名形态（绝不生成"共享书"以外的隐式作用域名）
    const fallback = baseName.trim();
    return (fallback || lorebookNameFor("")).slice(0, ATLAS_LOREBOOK_LIMITS.BOOK_NAME_CHARS);
  }
  const rawChat = String(normalized.chatId);
  const chatToken = /^[A-Za-z0-9_-]{1,20}$/.test(rawChat)
    ? rawChat
    : atlasLorebookChatFingerprint(rawChat);
  const suffix = `c-${chatToken}`;
  const room = ATLAS_LOREBOOK_LIMITS.BOOK_NAME_CHARS - suffix.length;
  return `${base.slice(0, Math.max(0, room - 1))}${suffix}`.slice(0, ATLAS_LOREBOOK_LIMITS.BOOK_NAME_CHARS);
}

/** Atlas 条目 comment 前缀（识别 / 回喂排除 / 存量清理都按前缀）。 */
export const ATLAS_LOREBOOK_PREFIX = {
  /** 0.9.40 唯一在产条目前缀（滚动条目 comment 与前缀相同，固定不带时段） */
  moves: "Atlas 动向",
  /** 0.9.39 及之前的逐轮事件条目（仅用于回喂排除与存量清理，不再生成） */
  events: "Atlas 事件",
  /** 0.9.35 常驻聚合条目（0.9.40 起废弃；保留前缀用于回喂排除与存量清理） */
  status: "Atlas 状态总览",
} as const;

/**
 * B05：世界书条目的「Atlas 协议命名空间」。作用域键 / 作用域条目 comment / 注入 key
 * 全部由它派生：**换命名空间 = 一次性换代**，旧代条目会被 classifyAtlasLorebookEntry
 * 判为 legacy（只在新路径写成功后才清理），不会与新代条目混淆。
 */
export const ATLAS_LOREBOOK_NAMESPACE = "atlas-moves";

/** B05：带聊天作用域的条目前缀（comment 形如 `atlas-moves@<key/chat@world>`）。 */
export const ATLAS_SCOPED_COMMENT_PREFIX = `${ATLAS_LOREBOOK_NAMESPACE}@<`;

/**
 * B05：按 `chatId + worldId` 唯一的作用域名（计划 §2.1 的会话身份；D09 将来直接复用）：
 * 形如 `atlas-moves/<chatKey>@<worldKey>`——两段都是「剔非法字符 + 有界」的稳定键，
 * 同一个聊天 + 同一个世界恒得同一个作用域名（可作确定性 ID 的基座），
 * 不同聊天（或不同世界）必得不同作用域名。
 */
export function atlasLorebookScopeKey(chatId: string, worldId: string, namespace: string = ATLAS_LOREBOOK_NAMESPACE): string {
  const chat = atlasLorebookScopeToken(chatId, "nokey");
  const world = atlasLorebookScopeToken(worldId, "noworld");
  return `${namespace}/${chat}@${world}`.slice(0, ATLAS_LOREBOOK_LIMITS.SCOPE_KEY_CHARS);
}

/**
 * B05：作用域内的**条目名**（= 唯一身份）。
 *
 * 兼容读取用前缀匹配（`startsWith(ATLAS_SCOPED_COMMENT_PREFIX)`），归属判定用整体
 * 相等（`classifyAtlasLorebookEntry`）——所以条目名的词表必须**只由冒号分段**，
 * 且这些段都不得包含 `<` `>` `@` 这些分隔符（`atlasLorebookScopeKey` 已剔除它们）。
 */
export const ATLAS_LOREBOOK_ENTRY_COMMENTS = {
  /** 滚动动向条目（对应 0.9.40 的「Atlas 动向」，但归属到具体聊天） */
  moves: "moves",
} as const;

/** B05：作用域条目的完整 comment（`atlas-moves@<key/chat@world:moves>`）。 */
export function atlasScopedEntryComment(scope: AtlasLorebookScope, entryName: string = ATLAS_LOREBOOK_ENTRY_COMMENTS.moves): string {
  const key = atlasLorebookScopeKey(scope.chatId, scope.worldId, scope.namespace ?? ATLAS_LOREBOOK_NAMESPACE);
  const name = atlasLorebookScopeToken(entryName, "entry");
  return `${ATLAS_SCOPED_COMMENT_PREFIX}${key}:${name}>`.slice(0, ATLAS_LOREBOOK_LIMITS.COMMENT_CHARS);
}

/** B05：注入通道 key（`setExtensionPrompt` 的第一参）——按聊天作用域命名，绝不串档。 */
export const ATLAS_LOREBOOK_INJECTION_KEY_PREFIX = `${ATLAS_LOREBOOK_NAMESPACE}:inject:`;

export function atlasLorebookInjectionKey(scope: AtlasLorebookScope): string {
  return `${ATLAS_LOREBOOK_INJECTION_KEY_PREFIX}${atlasLorebookScopeKey(scope.chatId, scope.worldId, scope.namespace ?? ATLAS_LOREBOOK_NAMESPACE)}`
    .slice(0, ATLAS_LOREBOOK_LIMITS.SCOPE_KEY_CHARS);
}

/** B05：两个作用域是否同一个（D09 判定「这条动向属于我这次聊天吗」直接用它）。 */
export function atlasLorebookScopeEquals(a: AtlasLorebookScope | null | undefined, b: AtlasLorebookScope | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const left = normalizeAtlasLorebookScope(a);
  const right = normalizeAtlasLorebookScope(b);
  if (!left || !right) return false;
  return atlasLorebookScopeKey(left.chatId, left.worldId, left.namespace)
    === atlasLorebookScopeKey(right.chatId, right.worldId, right.namespace);
}

// ---------------------------------------------------------------------------
// B05：条目归属判定（纯函数）——「这条旧条目该不该清、动了会不会伤用户」
// ---------------------------------------------------------------------------

/**
 * 条目归属四态（B05 的核心纯判定结果）：
 * - `scoped-current`：comment = 当前 `chatId + worldId` 的条目 → 就地 upsert；
 * - `scoped-other`  ：带作用域但属于**别的聊天/世界** → 只能在共享书里清理（本聊天
 *                     的动向已走自己的新路径），绝不当成"我的"来覆盖；
 * - `legacy`        ：Atlas 前缀但**没有任何 chat 作用域**（0.9.58 及之前写在共享
 *                     主卡书里的「Atlas 动向 / 事件 / 状态总览」）→ 迁移候选，**只在
 *                     新路径写成功之后**才清理；
 * - `foreign`       ：不是 Atlas 条目（用户静态世界书内容）→ **永不移动、永不删除**。
 */
export type AtlasLorebookEntryReason = "scoped-current" | "scoped-other" | "legacy" | "foreign";

export interface AtlasLorebookEntryOwnership {
  reason: AtlasLorebookEntryReason;
  /** 是否 Atlas 自建条目（三个前缀之一，或带作用域的 Atlas 条目） */
  atlas: boolean;
  /** 是否属于「当前作用域」（作用域缺席时恒为 false） */
  owned: boolean;
  /** 是否可以清理（legacy / scoped-other 且非当前作用域）——**用户条目恒为 false** */
  pruneable: boolean;
  /** Atlas 条目在书里的**原始 comment**（`foreign` 时回空串，不外泄用户文本） */
  comment: string;
  /** 识别出的作用域键（`legacy` / `foreign` / `scoped-other` 时 null） */
  scopeKey: string | null;
}

function atlasEntryCommentPrefixMatch(comment: string): boolean {
  return Object.values(ATLAS_LOREBOOK_PREFIX).some((prefix) => comment.startsWith(prefix));
}

/**
 * B05：判定一条世界书条目相对当前作用域的归属。纯函数、只读 comment：
 *
 * - 先按 Atlas 前缀全集识别（`Atlas 动向` / `Atlas 事件` / `Atlas 状态总览`），
 *   再按 `ATLAS_SCOPED_COMMENT_PREFIX` 识别作用域条目；
 * - **用户条目（其余全部）判 foreign**：书名/内容/启停一概不动（计划 §3-B05
 *   「静态用户世界书不要移动」）；
 * - 作用域缺席（`scope` 为 null）时，任何 Atlas 条目都不可能 `owned`——
 *   调用方据此走 0.9.58 的旧行为，不会误删也不会误认。
 */
export function classifyAtlasLorebookEntry(rawComment: unknown, scope: AtlasLorebookScopeInput): AtlasLorebookEntryOwnership {
  const comment = typeof rawComment === "string" ? rawComment : "";
  const normalized = normalizeAtlasLorebookScope(scope);
  if (comment.startsWith(ATLAS_SCOPED_COMMENT_PREFIX)) {
    const expected = normalized ? atlasScopedEntryComment(normalized) : null;
    const owned = expected !== null && comment === expected;
    return {
      reason: owned ? "scoped-current" : "scoped-other",
      atlas: true,
      owned,
      pruneable: !owned,
      comment,
      // 只认「自己这条」的键：别的聊天的 comment 不反解（避免把别人的身份猜错）。
      scopeKey: owned && normalized ? atlasLorebookScopeKey(normalized.chatId, normalized.worldId, normalized.namespace) : null,
    };
  }
  if (atlasEntryCommentPrefixMatch(comment)) {
    return { reason: "legacy", atlas: true, owned: false, pruneable: true, comment, scopeKey: null };
  }
  return { reason: "foreign", atlas: false, owned: false, pruneable: false, comment: "", scopeKey: null };
}

export interface AtlasLorebookOwnershipSummary {
  /** 当前作用域条目数（就地 upsert） */
  current: number;
  /** 需要迁移/清理的**旧路径** Atlas 条目：无作用域旧条目 + 别的聊天的条目 */
  stale: number;
  /** 判为 foreign 的条目数（用户静态内容，永远不动） */
  foreign: number;
  /** `stale` 条目的 uid 列表（确定性顺序，方便清理与测试断言） */
  staleUids: string[];
}

/**
 * B05：扫一遍书里的条目，给出归属汇总。`uid` 顺序按 `data.entries` 的枚举顺序
 * （部分 ST 版本用数字键，故显式按数值排序后回退字典序，保证确定性）。
 */
export function summarizeAtlasLorebookOwnership(data: unknown, scope: AtlasLorebookScopeInput): AtlasLorebookOwnershipSummary {
  const record = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  const entries = record && record.entries && typeof record.entries === "object" && !Array.isArray(record.entries)
    ? record.entries as Record<string, unknown>
    : null;
  const summary: AtlasLorebookOwnershipSummary = { current: 0, stale: 0, foreign: 0, staleUids: [] };
  if (!entries) return summary;
  const uids = Object.keys(entries).sort((a, b) => {
    const left = Number(a);
    const right = Number(b);
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
    return a.localeCompare(b);
  });
  for (const uid of uids) {
    const raw = entries[uid];
    const comment = raw && typeof raw === "object" ? (raw as Record<string, unknown>).comment : "";
    const ownership = classifyAtlasLorebookEntry(comment, scope);
    if (ownership.reason === "scoped-current") summary.current += 1;
    else if (ownership.pruneable) {
      summary.stale += 1;
      summary.staleUids.push(uid);
    } else summary.foreign += 1;
  }
  return summary;
}

/**
 * B05：把动态会话内容编成**当前聊天的注入文本**（`setExtensionPrompt` 的 value）。
 * 纯函数、有界、确定性：同一份 plans 恒得同一段文本。注入是"这一轮临时上下文"，
 * 只对当前聊天生效——这正是计划要求的首选通道。
 */
export function buildAtlasInjectionText(plans: AtlasLorebookPlans | null | undefined): string {
  if (!plans || !Array.isArray(plans.entries) || plans.entries.length === 0) return "";
  const body = plans.entries.map((entry) => String(entry.content ?? "")).join("\n");
  return `【Atlas 本轮动向 · 仅限当前聊天】\n${body}`.slice(0, ATLAS_LOREBOOK_LIMITS.INJECTION_CHARS);
}



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
 * E08：三表派生的一小段上下文（纯函数、有界、可重放）。
 *
 * 只取「玩家此刻真正相关」的三样东西，顺序固定（便于逐字节重放与人工核对）：
 *   1. 当前位置链（含上级：在钟楼二楼的房间里，也要知道自己在钟楼）；
 *   2. 当前地点在场人物的想法 / 行动倾向（这正是"下一轮这个人会怎么动"的依据）；
 *   3. 当前地点的**地面**物品（持有物与已销毁物不列——持有关系在人物那一行上）。
 * 条数超限时**如实写出还有多少**，不静默截断（与 D-02x 系列同一条纪律）。
 */
function buildTableContextLines(
  tableDelta?: { tables: AtlasThreeTablesV1; branchKey: string; currentLocationId: string | null } | null,
): string[] {
  if (!tableDelta) return [];
  const tables = tableDelta.tables;
  const locationById = new Map(tables.locations.map((row) => [row.id, row]));
  const currentRowId = tableDelta.currentLocationId === null || tableDelta.currentLocationId === undefined
    ? null
    : (String(tableDelta.currentLocationId).startsWith("loc:")
        ? String(tableDelta.currentLocationId)
        : `loc:${String(tableDelta.currentLocationId)}`);
  const current = currentRowId === null ? null : locationById.get(currentRowId) ?? null;
  if (!current) return [];
  // 1) 位置链（自下而上，有界到 4 层——与子图深度上限同量级）
  const chain: string[] = [];
  let cursor: AtlasLocationRow | undefined = current;
  const seen = new Set<string>();
  while (cursor && chain.length < 4 && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.push(cursor.name);
    cursor = cursor.parentLocationId === null ? undefined : locationById.get(cursor.parentLocationId);
  }
  const lines: string[] = [`位置链：${chain.reverse().join(" → ")}`];
  // 2) 身边人物
  const here = tables.characters.filter(
    (row: AtlasCharacterRow) => row.locationId === current.id && row.presence === "present",
  );
  const shown = here.slice(0, ATLAS_LOREBOOK_LIMITS.TABLE_CHARACTERS_MAX);
  for (const row of shown) {
    const bits = [row.thought.trim() ? `想法：${row.thought.trim()}` : "", row.actionTendency.trim() ? `行动倾向：${row.actionTendency.trim()}` : ""]
      .filter(Boolean)
      .join("；");
    lines.push(clip(`在场：${row.name}${bits ? `（${bits}）` : ""}`, ATLAS_LOREBOOK_LIMITS.TABLE_LINE_CHARS));
  }
  if (here.length > shown.length) lines.push(`在场：另有 ${here.length - shown.length} 位未列出`);
  // 3) 地面物品
  const groundItems = tables.items.filter(
    (row) => row.locationId === current.id && row.holderCharacterId === null && row.status !== ATLAS_ITEM_DESTROYED_STATUS,
  );
  const shownItems = groundItems.slice(0, ATLAS_LOREBOOK_LIMITS.TABLE_ITEMS_MAX);
  if (shownItems.length > 0) {
    lines.push(clip(
      `地面物品：${shownItems.map((row) => row.name).join("、")}${groundItems.length > shownItems.length ? ` 等 ${groundItems.length} 件` : ""}`,
      ATLAS_LOREBOOK_LIMITS.TABLE_LINE_CHARS,
    ));
  }
  return lines;
}

/**
 * commit 成功后，从世界状态派生滚动条目规划（0.9.40）。
 * - committed 才有条目；duplicate / failed → null（调用方跳过）。
 * - 每个 committed 回合（含零 effect——仅时间 / 位置推进）都产出同一条规划：
 *   writer 按 comment upsert 整体重写，「当前时间」永远最新（修复 0.9.39 及之前
 *   零 effect 回合不重写总览导致条目时间停在旧时段的矛盾）。
 * - 确定性：同世界状态 + 同回执 → 逐字节相同（可重放）。
 *
 * E08（可选第三参数）：`tableDelta` 存在时，条目**追加**三表派生的一小段上下文——
 * 当前位置链、身边人物的想法与行动倾向、当前地点的地面物品。
 * 纪律（计划 §3-E08「不要把所有三表写进酒馆正文，聊天分支隔离」）：
 * 1. 只送**有限**条数（常量在 `ATLAS_LOREBOOK_LIMITS`，越界就截断并如实写"还有 N 位"）；
 * 2. 只送与本轮相关的：当前地点链、该地点里的人、该地点的地面物品——
 *    不做全库导出，也不是"把三张表贴进世界书"；
 * 3. 分支隔离：只读 `branches[branchKey]` 这一份快照，绝不跨分支借未来事实。
 */
export function buildLorebookPlans(
  world: World,
  receipt: AtlasTurnReceipt,
  tableDelta?: { tables: AtlasThreeTablesV1; branchKey: string; currentLocationId: string | null } | null,
  /**
   * D09：本轮推演上下文。有 events 时「近期动向」**优先**取本分支的 `simulationEvents`——
   * 这正是 F2 的修复点：三表人物位置/想法会变，而旧 `world.stateEvents` 根本不新增，
   * 于是书和界面都不知道后台具体发生了什么。旧档不传该参数时退回旧路径，行为一字不变。
   *
   * 纪律（§2.3 / D09）：
   * 1. 只有**已发生**的事实进「近期动向」；意图显式标注「（意图）」，不把可能发生写成已发生；
   * 2. `hidden` 与**尚未送达**的消息不透出到主聊天注入（`authorOmniscient` 首版默认关闭）；
   * 3. 主角在已知地点时，消息要真的传到过那里才注入。
   */
  simulationDelta?: {
    branchKey: string;
    events?: readonly {
      simulationId: string; kind: string; status: string;
      visibility: string; summary: string; period: number;
    }[] | null;
    deliveries?: readonly {
      signalId: string; recipientType: string; recipientId: string;
    }[] | null;
    protagonistLocationIds?: readonly string[] | null;
    authorOmniscient?: boolean;
  } | null,
): AtlasLorebookPlans | null {
  if (receipt.status !== "committed") return null;
  /**
   * D09：把本分支的推演事件折成「近期动向」行。
   *
   * 只有**已发生**的事实能进来；意图显式标注「（意图）」，绝不把「可能发生」写成「已经发生」。
   * 「谁知道了」只认 deliveries 这条证据链：signal 事件要真的送达过才算动向；
   * 主角在已知地点时，消息还得真的传到过那里——作者界面能看到秘密，不等于远方人物自动知情。
   */
  function recentLinesFromSimulation(delta: typeof simulationDelta): string[] {
    if (!delta) return [];
    const omniscient = delta.authorOmniscient === true;
    const reachedLocations = new Map<string, Set<string>>();
    for (const delivery of delta.deliveries ?? []) {
      if (delivery.recipientType !== "location") continue;
      const set = reachedLocations.get(delivery.signalId) ?? new Set<string>();
      set.add(delivery.recipientId);
      reachedLocations.set(delivery.signalId, set);
    }
    const protagonistLocations = (delta.protagonistLocationIds ?? []).filter((id) => typeof id === "string");
    const lines: string[] = [];
    for (const event of [...(delta.events ?? [])].reverse()) {
      if (lines.length >= ATLAS_LOREBOOK_LIMITS.RECENT_LINES_MAX) break;
      // hidden 不进主聊天注入（作者显式全知开关除外）
      if (!omniscient && event.visibility === "hidden") continue;
      if (!omniscient && event.kind === "signal") {
        const reached = reachedLocations.get(event.simulationId);
        // 一条还没送到任何地方的消息，不算「已发生的动向」
        if (!reached || reached.size === 0) continue;
        if (protagonistLocations.length > 0 && !protagonistLocations.some((id) => reached.has(id))) continue;
      }
      const label = event.status === "intent-recorded" ? "（意图）" : "";
      lines.push(`· [第 ${String(event.period)} 时段] ${label}${clip(event.summary, ATLAS_LOREBOOK_LIMITS.RECENT_LINE_CHARS)}`);
    }
    return lines;
  }
  const index = buildNameIndex(world);
  const locationName = receipt.currentLocationId !== undefined && receipt.currentLocationId !== null
    ? index.points.get(String(receipt.currentLocationId)) ?? "未知地点"
    : null;
  const simulationRecent = recentLinesFromSimulation(simulationDelta);
  const legacyRecent = (world.stateEvents ?? [])
    .slice(-ATLAS_LOREBOOK_LIMITS.RECENT_LINES_MAX)
    .reverse()
    .map((e) => `· [第 ${String(e.at)} 时段] ${clip(stripEngineNotes(e.narrativeSummary ?? ""), ATLAS_LOREBOOK_LIMITS.RECENT_LINE_CHARS)}`);
  // D09：推演事件优先；没有（旧档 / 本轮无事件）才退回 world.stateEvents 旧路径
  const recent = simulationRecent.length > 0 ? simulationRecent : legacyRecent;
  const lines = [
    "【世界动向】本条目由 Atlas 每轮推演后自动更新：以下是当前时间点的权威世界动向，进行剧情分析时以此最新数据为准，优先级高于其他背景设定。",
    `当前时间：第 ${String(receipt.currentTime)} 时段`,
    ...(locationName ? [`当前位置：${locationName}`] : []),
    ...buildTableContextLines(tableDelta),
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
   *
   * **B05 提醒**：这本书随卡激活、**同一张卡的所有聊天共用**。接上 `resolveChatScope`
   * 之后 writer 只在里面**清理**旧 Atlas 条目（legacy / 别的聊天的 scoped 条目），
   * 绝不再往里写当前聊天的动态内容；未接作用域时保持 0.9.58 旧行为。
   */
  resolvePreferredBook?(): Promise<string | null>;
  /**
   * B05 适配点①（**作用域**）：返回**当前聊天**的作用域（chatId + worldId）。
   *
   * 语义（调用方实现时照抄这一段）：
   * - `chatId` = `context().chatId`（或会话 `binding.chatId`），空 → 返回 null；
   * - `worldId` = 当前会话绑定的 `binding.worldId`，空 → 返回 null；
   * - 两个都拿不到（无活动聊天 / 未绑定世界）→ 返回 `null`，writer 回退 0.9.58
   *   旧行为（绝不拿半个身份硬凑作用域）。
   *
   * 具体适配点（**属 index.js 的 createLorebookPort，B05 不越界改**）：
   * ~~~js
   * // atlas-extension/index.js / createLorebookPort 内新增（B05 待接）：
   * async resolveChatScope() {
   *   try {
   *     const ctx = context();
   *     const chatId = typeof ctx?.chatId === "string" ? ctx.chatId.trim() : "";
   *     const worldId = String(binding?.worldId ?? "").trim(); // 来自当前聊天的 binding
   *     if (!chatId || !worldId) return null;
   *     return { chatId, worldId };
   *   } catch { return null; }
   * }
   * ~~~
   */
  resolveChatScope?(): Promise<AtlasLorebookScopeInput>;
  /**
   * B05 适配点②（**首选通道**）：把动态会话内容注入**当前聊天**的一轮上下文。
   *
   * 语义：
   * - `key` 必须是 `atlasLorebookInjectionKey(scope)`（按聊天作用域命名，不串档）；
   * - `value` 是 `buildAtlasInjectionText(plans)`（已带"仅限当前聊天"边界说明）；
   * - 失败必须 **throw**（writer 捕获后回退专属世界书路径）；清空注入内容时
   *   `value` 传空串（酒馆 `setExtensionPrompt(key, "", ...)` 即清空）。
   *
   * 具体适配点（**属 index.js，B05 不越界改**）：
   * ~~~js
   * // atlas-extension/index.js / createLorebookPort 内新增（B05 待接）：
   * async injectTurn(key, value) {
   *   const ctx = context();
   *   if (typeof ctx?.setExtensionPrompt !== "function") {
   *     throw new Error("setExtensionPrompt unavailable"); // → writer 回退专属书
   *   }
   *   ctx.setExtensionPrompt(key, value, 2, 4); // 与 installGenerateInterceptor 同档位
   * }
   * ~~~
   * 未实现时 writer 自动走专属世界书路径（功能不降级，只是多写一本按 chat 命名的书）。
   */
  injectTurn?(key: string, value: string): Promise<void>;
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
  /**
   * 绑定状态：
   * - `char-primary` = 写入当前角色卡的主世界书（**仅限未接 B05 作用域时的旧行为**；不占聊天绑定槽）；
   * - `bound-by-atlas` / `already-bound` / `conflict` = 专属书 + 聊天绑定槽（旧行为）；
   * - `skipped-conflict` = **B05**：共享主卡书被别的聊天绑定占用、专属书已写好，
   *   Atlas **绝不覆盖**用户/别的聊天的绑定（此时动态内容仍已按当前聊天落盘）；
   * - `injected` = **B05**：动态内容走当前聊天的 `setExtensionPrompt` 注入通道，
   *   世界书只做旧条目清理（不写专属书、不碰绑定）。
   */
  binding: "char-primary" | "bound-by-atlas" | "already-bound" | "conflict" | "skipped-conflict" | "injected";
  existingBookName: string | null;
  /** 同步后书内的全部 Atlas 条目（面板可见性用） */
  entries: AtlasLorebookEntryView[];
  /** B05：当前作用域键（`atlas-moves/<chat>@<world>`）；作用域缺席 → null */
  scopeKey: string | null;
  /** B05：动态内容实际落点——`injection` 优于 `book`；`none` = 旧行为下写进共享/专属书 */
  contentTarget: "injection" | "book" | "none";
  /** B05：本次**成功迁移**掉的旧路径 Atlas 条目数（legacy / 别的聊天） */
  migrated: number;
  /** B05：本次从共享主卡书清理掉的旧路径 Atlas 条目数 */
  cleanedShared: number;
  /** B05：清理后仍未归属当前作用域、且被保留的 Atlas 条目数（异常/冲突时如实上报） */
  keptForeign: number;
  /** B05：共享主卡书里是否已经不存在跨聊天动态条目 */
  sharedClean: boolean;
  /** B05：作用域条目的 comment（面板按它精确识别"我这条"） */
  scopedComment: string | null;
  /** B05：注入通道 key（`contentTarget === "injection"` 时非 null） */
  injectionKey: string | null;
  /** B05：当前作用域的条目视图（只含 `ownedAtlasEntries` 里的条目） */
  ownedEntries: AtlasLorebookEntryView[];
  /** B05：书里**全部** Atlas 条目视图（含别的聊天 / 旧版；面板排障用，不含用户条目） */
  ownedAtlasEntries: AtlasLorebookEntryView[];
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
  // B05：作用域条目（`atlas-moves@<…:moves>`）也算 Atlas 条目——条目名段决定类目。
  const category = comment.startsWith(ATLAS_LOREBOOK_PREFIX.moves) || comment.endsWith(":moves>")
    ? "moves" as const
    : comment.startsWith(ATLAS_LOREBOOK_PREFIX.events) || comment.endsWith(":events>")
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

/**
 * B05：书里**全部 Atlas 条目**的视图（含带作用域的条目，也含别的聊天写的条目），
 * **不含用户条目**——面板排障"这本书里到底有谁的动向"用它。分类规则：
 * 作用域条目的 `:moves>` 段 → moves，`:events>` 段 → events，其余按前缀判定。
 */
function collectAnyAtlasEntries(data: Record<string, unknown>): AtlasLorebookEntryView[] {
  const entries = data.entries as Record<string, unknown>;
  const out: AtlasLorebookEntryView[] = [];
  for (const raw of Object.values(entries)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const comment = typeof entry.comment === "string" ? entry.comment : "";
    const scoped = comment.startsWith(ATLAS_SCOPED_COMMENT_PREFIX);
    const legacyMatch = !scoped && atlasEntryCommentPrefixMatch(comment);
    if (!scoped && !legacyMatch) continue; // 用户条目不入视图（面板只显示 Atlas 自己的条目）
    const category: AtlasLorebookEntryView["category"] =
      comment.endsWith(":events>") || comment.startsWith(ATLAS_LOREBOOK_PREFIX.events) ? "events" : "moves";
    const keys = Array.isArray(entry.key) ? entry.key.map((k) => String(k)).slice(0, ATLAS_LOREBOOK_LIMITS.KEYS_MAX) : [];
    const content = typeof entry.content === "string" ? entry.content.slice(0, ATLAS_LOREBOOK_LIMITS.CONTENT_CHARS) : "";
    out.push({ category, comment, keys, content });
  }
  return out;
}

function entryCommentOf(raw: unknown): string {
  return raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).comment === "string"
    ? (raw as Record<string, unknown>).comment as string
    : "";
}

/** B05：按**继承到的作用域**改写条目 comment（作用域缺席时原样返回 → 与 0.9.58 逐字节一致）。 */
function commentForScope(comment: string, scope: AtlasLorebookScope | null): string {
  if (!scope) return comment;
  if (comment === ATLAS_MOVES_ENTRY_COMMENT) return atlasScopedEntryComment(scope);
  const moved = comment.startsWith(ATLAS_LOREBOOK_PREFIX.moves) ? ATLAS_LOREBOOK_ENTRY_COMMENTS.moves : null;
  if (moved) return atlasScopedEntryComment(scope, moved);
  if (comment.startsWith(ATLAS_LOREBOOK_PREFIX.events)) return atlasScopedEntryComment(scope, "events");
  return comment;
}

/** B05：作用域条目一律 `constant` 蓝灯（与 0.9.40 滚动条目同档），legacy 条目保持原语义。 */
function isConstantEntry(comment: string, fallback: boolean): boolean {
  if (comment.startsWith(ATLAS_SCOPED_COMMENT_PREFIX)) return true;
  return fallback;
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

  /**
   * 把规划真正写进某一本书（建书 / 按 comment upsert / 存量收敛 / 整书保存一次 /
   * 绑定槽）——0.9.58 的既有语义逐字保留。
   *
   * `scope` 非空时（B05）：条目 comment 继承当前聊天作用域，且**只清理本作用域的
   * 其它 Atlas 条目**，绝不删除别的聊天/旧版条目（那些由调用方在"新路径写成功
   * 之后"才动——见 syncTurn 的迁移顺序）。
   */
  async function writePlansInto(
    targetName: string,
    plans: AtlasLorebookPlans,
    scope: AtlasLorebookScope | null,
    cardMode: boolean,
  ): Promise<{
    data: Record<string, unknown>;
    created: boolean;
    written: number;
    pruned: number;
    binding: AtlasLorebookSyncResult["binding"];
    existingBookName: string | null;
    entries: AtlasLorebookEntryView[];
  }> {
    const { data, created } = await loadOrCreate(targetName);
    const entriesRecord = data.entries as Record<string, unknown>;

    let written = 0;
    for (const plan of plans.entries) {
      const comment = commentForScope(plan.comment, scope);
      const isConstant = isConstantEntry(comment, plan.constant === true);
      const existingUid = Object.keys(entriesRecord).find((uid) => entryCommentOf(entriesRecord[uid]) === comment);
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
          comment,
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
    // B05：接了作用域时"当前滚动条目"= 本作用域的条目，别的聊天/旧版条目**不动**
    //（它们不归本轮管；共享书的迁移顺序由 syncTurn 保证）。
    const keepComment = scope ? atlasScopedEntryComment(scope) : ATLAS_MOVES_ENTRY_COMMENT;
    let pruned = 0;
    const atlasPrefixes = Object.values(ATLAS_LOREBOOK_PREFIX);
    for (const [uid, raw] of Object.entries(entriesRecord)) {
      const comment = entryCommentOf(raw);
      const isAtlas = atlasPrefixes.some((prefix) => comment.startsWith(prefix))
        || (scope !== null && comment.startsWith(ATLAS_SCOPED_COMMENT_PREFIX));
      const isOwnEntry = scope
        ? comment === keepComment || comment.startsWith(`${ATLAS_SCOPED_COMMENT_PREFIX}${atlasLorebookScopeKey(scope.chatId, scope.worldId, scope.namespace)}`)
        : comment === ATLAS_MOVES_ENTRY_COMMENT;
      if (isAtlas && !isOwnEntry) {
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

    return { data, created, written, pruned, binding, existingBookName, entries: finalEntries };
  }

  /**
   * B05：从**共享主卡世界书**里清掉旧路径的动态 Atlas 条目——legacy（无作用域的
   * 0.9.58 条目）与别的聊天的 scoped 条目。**只删 Atlas 条目**：用户静态内容
   * （comment 不以 Atlas 前缀/作用域前缀开头）一个都不碰。
   *
   * 调用时机是硬约束：**必须在新路径（注入 / 专属书）写成功之后**。本函数自身
   * 失败只记 `keptForeign`，绝不把异常透出去打断已经成功的新路径。
   */
  async function cleanSharedBook(
    sharedName: string,
    scope: AtlasLorebookScope,
    scopedBook: string,
  ): Promise<{ migrated: number; cleanedShared: number; keptForeign: number; sharedClean: boolean }> {
    // 防御：共享书与专属书同名时（不可能，但别把新写的条目当旧条目删）直接跳过
    if (sharedName === scopedBook) return { migrated: 0, cleanedShared: 0, keptForeign: 0, sharedClean: true };
    try {
      const loaded = await port.loadBook(sharedName);
      const data = asEntriesRecord(loaded);
      if (!data) return { migrated: 0, cleanedShared: 0, keptForeign: 0, sharedClean: true };
      const entriesRecord = data.entries as Record<string, unknown>;
      let migrated = 0;
      for (const [uid, raw] of Object.entries(entriesRecord)) {
        const ownership = classifyAtlasLorebookEntry(entryCommentOf(raw), scope);
        // legacy = 0.9.58 写在共享书里的跨聊天动态条目；scoped-other = 别的聊天的
        // 遗留条目。两者在**新路径已成功**的前提下都可以从共享书里清掉。
        if (ownership.reason === "legacy" || ownership.reason === "scoped-other") {
          port.deleteEntry(data, uid);
          migrated += 1;
        }
      }
      if (migrated > 0) await port.saveBook(sharedName, data);
      const after = summarizeAtlasLorebookOwnership(data as unknown, scope);
      return { migrated, cleanedShared: migrated, keptForeign: after.stale, sharedClean: after.stale === 0 };
    } catch {
      return { migrated: 0, cleanedShared: 0, keptForeign: 0, sharedClean: false };
    }
  }

  /**
   * 0.9.58 旧路径（未接 B05 作用域时逐字节保留）：角色卡主世界书优先 → 否则
   * plans.bookName；条目 comment 不加作用域；绑定槽为空才绑定。返回结构补齐了
   * B05 的新字段（作用域相关字段全部为"无作用域"的中性值），老调用方只看旧字段。
   */
  async function legacySyncTurn(plans: AtlasLorebookPlans): Promise<AtlasLorebookSyncResult> {
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
    const written = await writePlansInto(targetName, plans, null, cardMode);
    return {
      bookName: targetName,
      created: written.created,
      written: written.written,
      pruned: written.pruned,
      binding: written.binding,
      existingBookName: written.existingBookName,
      entries: written.entries,
      // B05：无作用域 = 未接隔离（与 0.9.58 行为一致），如实标注而不是假装已隔离
      scopeKey: null,
      contentTarget: "none",
      migrated: 0,
      cleanedShared: 0,
      keptForeign: 0,
      sharedClean: false,
      scopedComment: null,
      injectionKey: null,
      ownedEntries: [],
      ownedAtlasEntries: collectAnyAtlasEntries(written.data),
    };
  }

  return {
    /**
     * 把一轮的条目规划写入动态内容落点（作者 2026-09-18 拍板：角色卡世界书优先；
     * B05 追加聊天作用域与跨聊天隔离）。
     *
     * **旧路径（未接作用域，与 0.9.58 逐字节一致）**：
     * 0. 端口能解析出角色卡主世界书 → 直接写该书（cardMode，不占聊天绑定槽）；
     *    否则目标 = plans.bookName（Atlas 专属书）；
     * 1. 书不存在 → createBook；存在但非法 → 拒绝（不覆盖）；
     * 2. 按 comment upsert（同轮重复同步不产生重复条目）；
     * 3. 0.9.40 收口：书里只保留唯一的「Atlas 动向」滚动条目——旧版逐轮条目
     *    （「Atlas 动向 · 第 X → Y 时段」「Atlas 事件 · …」）与「Atlas 状态总览」
     *    一律清除（作者 2026-09-21 拍板：世界书只要动向、不强调时段）；
     * 4. 整书保存一次；保存后不再改动 data（酒馆缓存不深拷贝）；
     * 5. 专属书模式下：聊天绑定槽为空才绑定；已绑定别的书 → conflict（绝不静默覆盖）。
     *
     * **B05 作用域路径（port 实现 resolveChatScope 时）——动态会话内容不许跨聊天**：
     * 1. 先算作用域（chatId + worldId，`scopeKey`）；两个字段都拿不到 → 回退旧路径；
     * 2. 动态内容**优先走当前聊天的 `setExtensionPrompt` 注入通道**（port.injectTurn）：
     *    注入是"这一轮临时上下文"，只对当前聊天生效 → 天然不跨聊天；
     * 3. 注入不可用 / 抛错 → 写**按 chatId + worldId 命名的专属世界书**
     *    （`scopeBookName`）：两个聊天写的是两本不同的书，名字/绑定各自独立；
     * 4. 共享主卡书**只读只清**：新路径写成功后，才清掉里面的 legacy / 别的聊天条目
     *    （这是"迁移旧 Atlas 条目仅在新路径成功后清理"）；新路径失败 → 旧条目原样
     *    保留（旧档无损，caller 继续走旧读取路径）；
     * 5. 作用域路径**绝不覆盖**别人的聊天绑定：已绑定的是别的书 → `skipped-conflict`；
     * 6. 静态用户世界书内容（非 Atlas 前缀）在任何路径下都不移动、不删除。
     */
    async syncTurn(plans: AtlasLorebookPlans, scopeInput?: AtlasLorebookScopeInput): Promise<AtlasLorebookSyncResult> {
      if (!plans || !Array.isArray(plans.entries) || plans.entries.length === 0) {
        throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "lorebook 规划为空，跳过写入。");
      }
      // 1) 作用域：显式传入优先；否则问端口（未实现 → null → 旧行为）
      let scopeInputValue = scopeInput;
      if (scopeInputValue === undefined && typeof port.resolveChatScope === "function") {
        try {
          scopeInputValue = await port.resolveChatScope();
        } catch {
          scopeInputValue = null; // 作用域解析失败 → 回退旧路径（宁可不隔离，也不能写错人）
        }
      }
      const scope = normalizeAtlasLorebookScope(scopeInputValue);
      if (!scope) return legacySyncTurn(plans);
      const scopeKey = atlasLorebookScopeKey(scope.chatId, scope.worldId, scope.namespace);
      const scopedBook = scopeBookName(plans.bookName, scope);
      const scopedComment = atlasScopedEntryComment(scope);
      const injectionKey = atlasLorebookInjectionKey(scope);

      // 2) 首选通道：当前聊天的 setExtensionPrompt 注入（临时上下文，不跨聊天）
      let injected = false;
      if (typeof port.injectTurn === "function") {
        try {
          await port.injectTurn(injectionKey, buildAtlasInjectionText(plans));
          injected = true;
        } catch {
          injected = false; // 注入失败 → 落回专属世界书（内容不丢）
        }
      }

      if (injected) {
        // 新路径已成功 → 才允许清共享书里的旧跨聊天动态条目
        let sharedName: string | null = null;
        if (typeof port.resolvePreferredBook === "function") {
          try {
            const preferred = await port.resolvePreferredBook();
            if (typeof preferred === "string" && preferred.trim()) sharedName = preferred;
          } catch {
            sharedName = null;
          }
        }
        const cleanup = sharedName
          ? await cleanSharedBook(sharedName, scope, scopedBook)
          : { migrated: 0, cleanedShared: 0, keptForeign: 0, sharedClean: true };
        return {
          bookName: scopedBook,
          created: false,
          // 动态内容走注入通道，**没有写进任何世界书**——计数如实为 0，
          // 「内容已送达」由 contentTarget:"injection" 与 injected 的 key 表达。
          written: 0,
          pruned: cleanup.cleanedShared,
          binding: "injected",
          existingBookName: sharedName,
          entries: [],
          scopeKey,
          contentTarget: "injection",
          migrated: cleanup.migrated,
          cleanedShared: cleanup.cleanedShared,
          keptForeign: cleanup.keptForeign,
          sharedClean: cleanup.sharedClean,
          scopedComment,
          injectionKey,
          ownedEntries: [],
          ownedAtlasEntries: [],
        };
      }

      // 3) 回退通道：按 chatId + worldId 独立的专属世界书
      const written = await writePlansInto(scopedBook, plans, scope, false);
      let binding = written.binding;
      let existingBookName = written.existingBookName;
      if (binding === "conflict") {
        // 已绑定别的书（可能是共享主卡书）→ 绝不覆盖；内容已在本聊天的专属书里
        binding = "skipped-conflict";
      }

      // 4) 新路径**成功之后**才清理共享主卡书里的旧路径动态条目
      let cardBook: string | null = null;
      if (typeof port.resolvePreferredBook === "function") {
        try {
          const preferred = await port.resolvePreferredBook();
          if (typeof preferred === "string" && preferred.trim()) cardBook = preferred;
        } catch {
          cardBook = null;
        }
      }
      const cleanup = cardBook
        ? await cleanSharedBook(cardBook, scope, scopedBook)
        : { migrated: 0, cleanedShared: 0, keptForeign: 0, sharedClean: true };

      return {
        bookName: scopedBook,
        created: written.created,
        written: written.written,
        // 旧路径 pruned（本作用域内的历史条目）+ 本次从共享书迁移掉的数量
        pruned: written.pruned + cleanup.cleanedShared,
        binding,
        existingBookName,
        entries: written.entries,
        scopeKey,
        contentTarget: "book",
        migrated: cleanup.migrated,
        cleanedShared: cleanup.cleanedShared,
        keptForeign: cleanup.keptForeign,
        sharedClean: cleanup.sharedClean,
        scopedComment,
        injectionKey,
        ownedEntries: written.entries.filter((item) => item.comment === scopedComment),
        ownedAtlasEntries: collectAnyAtlasEntries(written.data),
      };
    },

    /**
     * 聊天级生命周期（学 shujuku 的开场清理）：把目标书里**全部 Atlas** 条目清掉
     * （含当前滚动条目）。用于切到未绑定世界的新聊天——旧聊天的动向不该留在随卡
     * 激活的书里给新聊天看。切回旧聊天时由调用方按会话世界状态重建条目，数据本身
     * 在 chatMetadata.atlas 会话里，零丢失。
     * 目标书解析与 syncTurn 同口径（角色卡主书优先）；书不存在 = 没什么可清。
     *
     * B05 注意：作用域路径接上后，本函数是**旧路径的兜底**——当前聊天的动态内容已
     * 经写在按 `chatId + worldId` 命名的专属书 / 注入通道里，共享主卡书里通常只剩
     * 历史遗留条目。清理**只针对 Atlas 条目**：既有 `ATLAS_LOREBOOK_PREFIX` 三个
     * 中文前缀，也含 B05 的 `atlas-moves@<…>` 作用域条目；用户静态世界书内容一律
     * 保留（`classifyAtlasLorebookEntry` 判为 foreign 就绝不删）。
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
      let pruned = 0;
      for (const [uid, raw] of Object.entries(entriesRecord)) {
        const comment = entryCommentOf(raw);
        const isAtlas = Object.values(ATLAS_LOREBOOK_PREFIX).some((prefix) => comment.startsWith(prefix))
          || comment.startsWith(ATLAS_SCOPED_COMMENT_PREFIX);
        if (isAtlas) {
          port.deleteEntry(data, uid);
          pruned += 1;
        }
      }
      if (pruned > 0) await port.saveBook(targetName, data);
      return { bookName: targetName, pruned };
    },

    /**
     * 面板可见性快照（调用方持久化到 store 的 "lorebook" 文档）。
     *
     * C7（0.9.54）：`plans` 保留但下划线标注——快照内容完全来自 `result`
     * （bookName / created / written / pruned / binding / entries），plans 不影响输出。
     * 它是 writer 对外形状的一部分，调用方（index.js 两处会话钩子、atlas-lorebook 测试）
     * 均按 `snapshot(plans, result)` 调用；为消警而改签名会波及跨文件调用点，
     * 故按施工单 C7 的处置保留参数并注明。快照功能本身不动。
     *
     * B05：追加作用域字段（scopeKey / contentTarget / migrated / cleanedShared /
     * keptForeign / sharedClean / scopedComment / injectionKey / ownedEntries /
     * ownedAtlasEntries）。旧字段名与含义一个不改，旧读取方零影响。
     */
    snapshot(_plans: AtlasLorebookPlans, result: AtlasLorebookSyncResult) {
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
        // B05：聊天作用域（chatId + worldId）与跨聊天隔离状态
        scopeKey: result.scopeKey,
        contentTarget: result.contentTarget,
        migrated: result.migrated,
        cleanedShared: result.cleanedShared,
        keptForeign: result.keptForeign,
        sharedClean: result.sharedClean,
        scopedComment: result.scopedComment,
        injectionKey: result.injectionKey,
        ownedEntries: result.ownedEntries,
        ownedAtlasEntries: result.ownedAtlasEntries,
      };
    },
  };
}
