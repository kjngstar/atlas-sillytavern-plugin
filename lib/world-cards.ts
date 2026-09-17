// W0-01b：卡片 Agent 适配层
//
// 职责（来自 待办计划 README 的 W0-01b 详细交接要求）：
//  - 为事件 / 地点 / 人物 / 故事起点建立统一的 `sourceCardId + cardType` 适配层；
//  - 实现**稳定** `sourceRevision`：同一份卡内容永远得到同一版本号；
//  - 提供 `storyId + branchId` 作用域助手，保证「活动」只属于具体故事线；
//  - 源卡变更后标记「待复核」，**绝不静默重写作者手改过的 profile**；
//  - 构造会话检查点，并为 IF 派生提供无共享可写引用的深拷贝。
//
// 纯函数：无 React、无 DOM、**0 fetch**。可在 node:test 中直接调用。

import type {
  World,
  CardType,
  CardAgentProfile,
  CardAgentSession,
  CardSessionCheckpoint,
  StoryEntryAnchor,
} from "./world-schema.ts";
import { deepCloneJson, normalizeWorldReferences } from "./world-schema.ts";

// ---------------------------------------------------------------------------
// 1. 确定性序列化与稳定来源版本
// ---------------------------------------------------------------------------

/**
 * 稳定序列化：对象键按字典序排列，数组保持原序。
 * 目的：让「同一份内容」永远得到同一个字符串，与写入顺序无关，
 * 从而使 sourceRevision 不会因为键顺序变化而抖动。
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

/** FNV-1a 32 位哈希（十六进制，定长 8 位）。确定性，跨平台一致。 */
export function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * 计算一张卡的稳定来源版本。内容不变 → 版本不变；内容任一字段改变 → 版本改变。
 * 这是「源卡变更待复核」判定与会话启动快照的基础。
 */
export function computeCardRevision(card: unknown): string {
  return `rev-${hashString(stableStringify(card))}`;
}

// ---------------------------------------------------------------------------
// 2. 统一 sourceCardId + cardType 适配层
// ---------------------------------------------------------------------------

export type CardResolution = {
  found: boolean;
  cardType: CardType;
  sourceCardId: string;
  /** 稳定来源版本；卡片缺失时为 null */
  revision: string | null;
  /** 人类可读标签（事件标题 / 地点名 / 人物名 / 故事线标题） */
  label: string | null;
  /** 诊断原因：卡片不存在（引用可能指向已删除对象） */
  reason?: "missing";
};

/**
 * 把 `cardType + sourceCardId` 解析为世界里的真实对象，并给出其稳定版本。
 * 四类卡统一入口，调用方不需要知道事件存在 `events[regionId][]`、地点用数字 id 等差异。
 */
export function resolveSourceCard(world: World, cardType: CardType, sourceCardId: string): CardResolution {
  const base = { cardType, sourceCardId };
  const missing: CardResolution = { ...base, found: false, revision: null, label: null, reason: "missing" };

  if (cardType === "event") {
    const hit = Object.values(world.events ?? {})
      .flat()
      .find((e) => e && e.id === sourceCardId);
    if (!hit) return missing;
    return { ...base, found: true, revision: computeCardRevision(hit), label: hit.title ?? null };
  }
  if (cardType === "point") {
    // 地点 id 在 MapPoint 中是 number，卡片引用统一用字符串
    const hit = (world.points ?? []).find((p) => String(p.id) === sourceCardId);
    if (!hit) return missing;
    return { ...base, found: true, revision: computeCardRevision(hit), label: hit.name ?? null };
  }
  if (cardType === "character") {
    const hit = (world.characters ?? []).find((c) => c.id === sourceCardId);
    if (!hit) return missing;
    return { ...base, found: true, revision: computeCardRevision(hit), label: hit.name ?? null };
  }
  // story
  const hit = (world.stories ?? []).find((s) => s.id === sourceCardId);
  if (!hit) return missing;
  return { ...base, found: true, revision: computeCardRevision(hit), label: hit.title ?? null };
}

// ---------------------------------------------------------------------------
// 3. 源卡变更检测（待复核）
// ---------------------------------------------------------------------------

export type ProfileDrift = {
  profileId: string;
  /** 源卡是否已被删除 */
  missing: boolean;
  /** profile 记录的来源版本 */
  storedRevision: string;
  /** 当前源卡的稳定版本；缺失时为 null */
  currentRevision: string | null;
  /** 需要作者复核：源卡被删除，或内容已变化 */
  needsReview: boolean;
};

/**
 * 检测 profile 与其源卡之间是否发生漂移。
 * 只返回诊断结果，**不修改任何数据**；由调用方决定如何呈现「待复核」。
 */
export function detectProfileDrift(world: World, profile: CardAgentProfile): ProfileDrift {
  const resolution = resolveSourceCard(world, profile.cardType, profile.sourceCardId);
  const missing = !resolution.found;
  const currentRevision = resolution.revision;
  const needsReview = missing || currentRevision !== profile.sourceRevision;
  return {
    profileId: profile.id,
    missing,
    storedRevision: profile.sourceRevision,
    currentRevision,
    needsReview,
  };
}

/** 批量检测：返回需要复核的 profile id（源卡被删或内容已变）。 */
export function profilesNeedingReview(world: World): string[] {
  return (world.cardProfiles ?? [])
    .filter((p) => detectProfileDrift(world, p).needsReview)
    .map((p) => p.id);
}

// ---------------------------------------------------------------------------
// 4. 保留作者手改字段（编辑源卡绝不静默重写 profile）
// ---------------------------------------------------------------------------

/** 可被重新编译 / AI 草稿更新的字段（不含身份与版本字段） */
const COMPILABLE_FIELDS = [
  "participation",
  "roleConstraints",
  "summary",
  "sourceRefs",
  "activeFrom",
  "activeTo",
] as const;

export type CompilableField = (typeof COMPILABLE_FIELDS)[number];

/**
 * 把新编译结果并入现有 profile，**作者手改过的字段一律保留**。
 * 身份字段（id / cardType / sourceCardId）与来源版本由调用方显式处理，本函数不覆盖。
 * 返回新的 profile，不修改入参。
 */
export function mergeProfilePreservingManualEdits(
  current: CardAgentProfile,
  draft: Partial<Pick<CardAgentProfile, CompilableField>>,
): CardAgentProfile {
  const edited = new Set(current.manuallyEdited ?? []);
  const next: CardAgentProfile = { ...current };

  for (const field of COMPILABLE_FIELDS) {
    if (edited.has(field)) continue; // 作者手改过 → 保留原值
    if (!(field in draft)) continue; // 草稿没提供 → 不动
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (next as any)[field] = draft[field];
  }
  return next;
}

// ---------------------------------------------------------------------------
// 5. storyId + branchId 作用域
// ---------------------------------------------------------------------------

/**
 * 取某分支作用域内的卡片会话。
 * 「活动」只能属于具体故事线，不能全世界共享——因此必须同时匹配 storyId 与 branchId。
 */
export function cardSessionsInScope(
  sessions: CardAgentSession[],
  storyId: string,
  branchId: string,
): CardAgentSession[] {
  return sessions.filter((s) => s.storyId === storyId && s.branchId === branchId);
}

/** 作用域内处于「活动」状态的会话（唯一允许进入请求上下文的卡片会话）。 */
export function activeCardSessionsInScope(
  sessions: CardAgentSession[],
  storyId: string,
  branchId: string,
): CardAgentSession[] {
  return cardSessionsInScope(sessions, storyId, branchId).filter((s) => s.status === "active");
}

/**
 * 解析分支作用域。正史时 branchId 等于 storyId；IF 时 branchId 为该 IF 的 story id。
 * 未显式给出 branchId 时按正史处理。
 */
export function resolveBranchScope(storyId: string, branchId?: string | null): { storyId: string; branchId: string } {
  const branch = branchId && branchId.trim() ? branchId.trim() : storyId;
  return { storyId, branchId: branch };
}

// ---------------------------------------------------------------------------
// 6. 会话检查点与 IF 深拷贝
// ---------------------------------------------------------------------------

/** 构造检查点（可重建的最小状态引用；不保存可写世界状态）。 */
export function makeCheckpoint(input: {
  actionId?: string | null;
  at?: number | null;
  summary?: string;
  worldFlags?: string[];
}): CardSessionCheckpoint {
  return {
    ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
    ...(input.at !== undefined ? { at: input.at } : {}),
    ...(typeof input.summary === "string" ? { summary: input.summary } : {}),
    ...(Array.isArray(input.worldFlags) ? { worldFlags: [...input.worldFlags] } : {}),
  };
}

/**
 * 为一条新 IF 深拷贝其来源分支的卡片会话。
 * 新会话的 branchId 指向 IF；深拷贝保证正史与不同 IF 之间**无共享可写引用**。
 * 源分支没有会话时返回空数组；任一会话无法深拷贝（循环引用）→ 整体返回 null 拒绝。
 */
export function cloneCardSessionsForIF(
  world: World,
  sourceBranchId: string,
  targetStoryId: string,
  targetBranchId?: string,
): CardAgentSession[] | null {
  if (!targetStoryId.trim()) return null;
  const branch = resolveBranchScope(targetStoryId, targetBranchId).branchId;
  const sources = (world.cardSessions ?? []).filter((s) => s.branchId === sourceBranchId);
  const out: CardAgentSession[] = [];
  for (const session of sources) {
    const cloned = deepCloneJson(session);
    if (cloned === null) return null;
    out.push({ ...cloned, storyId: targetStoryId, branchId: branch });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 7. 入口锚点绑定校验
// ---------------------------------------------------------------------------

/**
 * 入口锚点是否至少绑定了「时间」或「地图」之一。
 * 计划要求：卡片可以**只绑地图或只绑时间**，两者都算有效；两者都没有才算无效。
 */
export function anchorHasBinding(anchor: StoryEntryAnchor): boolean {
  const hasTime = typeof anchor.at === "number";
  const hasMap =
    Boolean(anchor.regionId) ||
    Boolean(anchor.pointId) ||
    (typeof anchor.x === "number" && typeof anchor.y === "number");
  return hasTime || hasMap;
}

/** 锚点是否同时具备时间与地图绑定（用于 UI 展示完整度，不影响有效性）。 */
export function anchorHasFullBinding(anchor: StoryEntryAnchor): boolean {
  const hasTime = typeof anchor.at === "number";
  const hasMap =
    Boolean(anchor.regionId) ||
    Boolean(anchor.pointId) ||
    (typeof anchor.x === "number" && typeof anchor.y === "number");
  return hasTime && hasMap;
}

// ---------------------------------------------------------------------------
// 8. 卡片引用完整性（停用并保留诊断，绝不静默删除作者配置）
// ---------------------------------------------------------------------------

/**
 * 清理 / 停用卡片层的悬空引用：
 * - `CardAgentProfile` 源卡缺失 → **停用 + 标记待复核**（保留诊断，绝不静默删除）；
 *   来源版本漂移 → 标记待复核但保持启用（交作者决定）；失效连接 → 置空，不静默换模型。
 * - `CardAgentSession` 的 profile / story / branch 悬空 → **归档**（停用但保留可追溯历史）。
 * - `StoryEntryAnchor` 的地区 / 地点 / 事件悬空 → 置空；源卡缺失 → 标记失效入口并保留。
 *
 * 纯函数：返回新的 World，不修改入参。
 */
export function normalizeCardReferences(world: World): World {
  const connectionIds = new Set((world.connections ?? []).map((c) => c.id));
  const storyIds = new Set((world.stories ?? []).map((s) => s.id));
  const regionIds = new Set((world.regions ?? []).map((r) => r.id));
  const pointIds = new Set((world.points ?? []).map((p) => String(p.id)));
  const eventIds = new Set(
    Object.values(world.events ?? {})
      .flat()
      .map((e) => e?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );

  // 1. 卡片 Agent 静态配置
  const cardProfiles = (world.cardProfiles ?? []).map((p): CardAgentProfile => {
    const resolution = resolveSourceCard(world, p.cardType, p.sourceCardId);
    let next: CardAgentProfile = p;
    if (!resolution.found) {
      // 原卡已被删除 → 停用并标记待复核
      next = { ...next, enabled: false, needsReview: true };
    } else if (resolution.revision !== p.sourceRevision) {
      // 源卡内容已变化 → 只需复核，是否停用由作者决定
      next = { ...next, needsReview: true };
    }
    if (next.defaultConnectionId !== undefined) {
      const connection =
        next.defaultConnectionId && connectionIds.has(next.defaultConnectionId) ? next.defaultConnectionId : null;
      next = { ...next, defaultConnectionId: connection };
    }
    return next;
  });
  const profileIds = new Set(cardProfiles.map((p) => p.id));

  // 2. 卡片会话：作用域引用失效 → 归档（不再进入上下文，但保留审计）
  const cardSessions = (world.cardSessions ?? []).map((s): CardAgentSession => {
    const ok = profileIds.has(s.profileId) && storyIds.has(s.storyId) && storyIds.has(s.branchId);
    return ok ? s : { ...s, status: "archived" };
  });

  // 3. 入口锚点：引用失效 → 标记失效入口并保留；地区 / 地点 / 事件悬空 → 置空
  const entryAnchors = (world.entryAnchors ?? []).map((a): StoryEntryAnchor => {
    const resolution = resolveSourceCard(world, a.cardType, a.sourceCardId);
    const clean: StoryEntryAnchor = { ...a };
    if (clean.regionId && !regionIds.has(clean.regionId)) clean.regionId = null;
    if (clean.pointId && !pointIds.has(clean.pointId)) clean.pointId = null;
    if (clean.eventId && !eventIds.has(clean.eventId)) clean.eventId = null;
    clean.invalid = !resolution.found;
    return clean;
  });

  // 只回写原本存在的字段，避免给旧世界凭空长出空数组
  return {
    ...world,
    ...(world.cardProfiles ? { cardProfiles } : {}),
    ...(world.cardSessions ? { cardSessions } : {}),
    ...(world.entryAnchors ? { entryAnchors } : {}),
  };
}

/**
 * 完整引用清理：先跑 W0-01 的基础引用清理，再跑卡片层清理。
 * 放在本文件而非 world-schema.ts，是为了避免 world-schema ↔ world-cards 循环依赖。
 */
export function normalizeWorldReferencesWithCards(world: World): World {
  return normalizeCardReferences(normalizeWorldReferences(world));
}
