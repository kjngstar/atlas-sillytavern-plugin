// W0-01c：默认移动提示基线与世界 Agent 根配置
//
// 职责（来自 待办计划 README 的 W0-01c 详细交接要求）：
//  - 版本化 `DefaultTravelBaseline`：无世界书、无地图比例、无世界 Agent 的旧世界
//    也能生成完整默认提示上下文；必须在 UI 可查看，版本要写进日志。
//  - 每个世界**唯一**的 `WorldAgentProfile`：编译该世界的世界书 / 地图 / 人物，
//    不含任何 story / IF 可写状态；删除 / 解析失败后所有故事**无条件回退**基线。
//  - 来源 revision 与失效回退：世界资料变化标记 `stale`，绝不静默覆盖。
//
// 纯函数：无 React、无 DOM、**0 fetch**。可在 node:test 中直接调用。

import type {
  World,
  DefaultTravelBaseline,
  WorldAgentProfile,
} from "./world-schema.ts";
import {
  DEFAULT_TRAVEL_BASELINE,
  DEFAULT_TRAVEL_BASELINE_VERSION,
  WORLD_AGENT_STATUSES,
} from "./world-schema.ts";
import { stableStringify, hashString } from "./world-cards.ts";

// ---------------------------------------------------------------------------
// 1. 默认移动提示基线（版本化系统常量）
// ---------------------------------------------------------------------------

/**
 * 取默认移动提示基线（返回深拷贝，防止调用方改写系统常量）。
 * 这是「未 Agent 化时每次故事请求都携带」的兜底基线，任何世界都能用。
 */
export function getDefaultTravelBaseline(): DefaultTravelBaseline {
  return JSON.parse(JSON.stringify(DEFAULT_TRAVEL_BASELINE)) as DefaultTravelBaseline;
}

export { DEFAULT_TRAVEL_BASELINE_VERSION };

/**
 * 把默认基线渲染成**可查看**的系统提示片段。
 * 硬性要求：基线不得隐藏在模型调用代码中，必须可展示给作者。
 */
export function buildBaselineSystemPrompt(
  baseline: DefaultTravelBaseline = DEFAULT_TRAVEL_BASELINE,
): string {
  const speeds = baseline.speedTiers
    .map((t) => `- ${t.label}（${t.id}）：每时段 ${t.cellsPerPeriod} 格`)
    .join("\n");
  const terrains = baseline.terrainTiers
    .map((t) => `- ${t.label}（${t.id}）：系数 ${t.factor}`)
    .join("\n");
  return [
    `【默认移动提示基线 ${baseline.version}】`,
    `距离公式：${baseline.distanceFormula}`,
    "速度档：",
    speeds,
    "地形档：",
    terrains,
    `无比例规则：${baseline.abstractRule}`,
    `输出约束：${baseline.outputConstraint}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 2. 世界 Agent 合法性（不含 story / IF 可写状态）
// ---------------------------------------------------------------------------

/** 世界 Agent 绝不能携带这些字段：它们是故事 / IF 的可写状态 */
const FORBIDDEN_WORLD_AGENT_KEYS = [
  "storyId",
  "branchId",
  "steps",
  "runtime",
  "storyRuntimes",
  "actions",
  "outcomes",
  "characterStates",
  "characterMemories",
] as const;

/** 检测世界 Agent 是否混入了 story / IF 可写状态（分层纪律的硬检查）。 */
export function worldAgentHasWritableStoryState(agent: unknown): boolean {
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) return false;
  const obj = agent as Record<string, unknown>;
  return FORBIDDEN_WORLD_AGENT_KEYS.some((key) => key in obj);
}

/** 世界 Agent 是否结构完整、可安全使用。 */
export function isValidWorldAgent(agent: WorldAgentProfile | null | undefined): agent is WorldAgentProfile {
  if (!agent || typeof agent !== "object") return false;
  if (typeof agent.id !== "string" || agent.id.length === 0) return false;
  if (typeof agent.worldId !== "string" || agent.worldId.length === 0) return false;
  if (!WORLD_AGENT_STATUSES.includes(agent.status)) return false;
  if (typeof agent.baselineVersion !== "string" || agent.baselineVersion.length === 0) return false;
  if (typeof agent.sourceRevision !== "string" || agent.sourceRevision.length === 0) return false;
  if (worldAgentHasWritableStoryState(agent)) return false;
  return true;
}

/** 一个世界的活动世界 Agent 数量；结构保证最多为 1（单值字段）。 */
export function countActiveWorldAgents(world: World): number {
  return isValidWorldAgent(world.worldAgent) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 3. 世界来源版本与漂移检测
// ---------------------------------------------------------------------------

/**
 * 计算当前世界的稳定来源版本：由全局提示词、世界书（含地区 / 地点条目）、
 * 地区、地点、人物和地图旅行设置共同决定。
 * 任一来源变化 → 版本变化，从而使世界 Agent 可被标记为「待刷新」。
 */
export function computeWorldSourceRevision(world: World): string {
  const bibleFingerprint = (entries: Array<{ id: string; title: string; content: string; enabled?: boolean }>) =>
    entries.map((e) => ({ id: e.id, title: e.title, content: e.content, enabled: e.enabled ?? true }));

  const fingerprint = {
    globalPrompt: world.globalPrompt ?? null,
    worldBible: bibleFingerprint(world.worldBible ?? []),
    regionBooks: (world.regions ?? []).map((r) => ({
      id: r.id,
      book: bibleFingerprint(r.worldBook ?? []),
    })),
    pointBooks: (world.points ?? []).map((p) => ({
      id: p.id,
      book: bibleFingerprint(p.worldBook ?? []),
    })),
    regions: (world.regions ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      x: r.coordinates?.x ?? null,
      y: r.coordinates?.y ?? null,
    })),
    points: (world.points ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      regionId: p.regionId ?? null,
    })),
    characters: (world.characters ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      description: c.description,
    })),
    travelSettings: world.travelSettings ?? null,
  };
  return `rev-${hashString(stableStringify(fingerprint))}`;
}

export type WorldAgentDrift = {
  /** 世界资料已变化，辅助待刷新 */
  stale: boolean;
  storedRevision: string | null;
  currentRevision: string;
};

/** 检测世界资料是否已变化（只诊断，绝不静默更新 profile）。 */
export function detectWorldAgentDrift(world: World): WorldAgentDrift {
  const currentRevision = computeWorldSourceRevision(world);
  const storedRevision = world.worldAgent?.sourceRevision ?? null;
  return {
    stale: storedRevision !== null && storedRevision !== currentRevision,
    storedRevision,
    currentRevision,
  };
}

// ---------------------------------------------------------------------------
// 4. 旅行上下文解析与无条件回退
// ---------------------------------------------------------------------------

/** 旅行上下文状态：无 Agent 为 `disabled`，其余对应世界 Agent 生命周期 */
export type TravelContextStatus = "disabled" | "ready" | "optimizing" | "active" | "stale";

export type TravelContext = {
  status: TravelContextStatus;
  /** **始终存在**：任何情况下都会携带的默认基线 */
  baseline: DefaultTravelBaseline;
  baselineVersion: string;
  /** 可注入的世界 Agent；不可用或已回退时为 null */
  worldAgent: WorldAgentProfile | null;
  /** 引用的世界 Agent revision；未使用时为 null */
  worldAgentRevision: string | null;
  /** 世界资料是否已变化（辅助待刷新） */
  stale: boolean;
  /** 人类可读诊断（UI 可查看） */
  reason: string;
};

/**
 * 解析当前世界的旅行上下文。
 * **任何**解析失败、删除或失效，都无条件回退到默认基线 —— 故事请求绝不因此中断。
 */
export function resolveTravelContext(world: World): TravelContext {
  const baseline = getDefaultTravelBaseline();
  const agent = world.worldAgent ?? null;

  if (!agent) {
    return {
      status: "disabled",
      baseline,
      baselineVersion: baseline.version,
      worldAgent: null,
      worldAgentRevision: null,
      stale: false,
      reason: "当前世界没有世界 Agent，按默认移动提示基线游玩。",
    };
  }

  if (!isValidWorldAgent(agent)) {
    return {
      status: "disabled",
      baseline,
      baselineVersion: baseline.version,
      worldAgent: null,
      worldAgentRevision: null,
      stale: false,
      reason: "世界 Agent 配置不完整或不可用，已无条件回退默认移动提示基线。",
    };
  }

  const drift = detectWorldAgentDrift(world);
  const hasGuide = Boolean(agent.travelGuide && agent.travelGuide.content.trim().length > 0);

  let status: TravelContextStatus;
  let reason: string;
  if (drift.stale) {
    status = "stale";
    reason = "世界资料已变化，世界 Agent 辅助待刷新；可继续使用旧版本，或显式刷新。";
  } else if (hasGuide) {
    status = "active";
    reason = "当前世界 Agent 可为所有故事提供世界观与旅行辅助。";
  } else if (agent.status === "optimizing") {
    status = "optimizing";
    reason = "正在生成世界辅助；其他故事仍可按默认基线游玩。";
  } else {
    status = "ready";
    reason = "世界 Agent 已建立来源清单，可供选择为辅助来源（暂无旅行辅助）。";
  }

  return {
    status,
    baseline,
    baselineVersion: baseline.version,
    worldAgent: agent,
    worldAgentRevision: agent.sourceRevision,
    stale: drift.stale,
    reason,
  };
}

/** 世界 Agent 的旅行辅助是否可被本次请求注入（只读叠加，不自行请求）。 */
export function isWorldAgentUsable(context: TravelContext): boolean {
  if (!context.worldAgent) return false;
  return context.status === "active" || context.status === "stale" || context.status === "ready";
}

// ---------------------------------------------------------------------------
// 5. 组合系统提示（基线 + 可选世界 Agent 辅助）
// ---------------------------------------------------------------------------

/**
 * 构造本次请求的旅行系统提示：**默认基线永远存在**，世界 Agent 辅助为可选叠加。
 * 末尾固定写入归因（基线版本 + 世界 Agent revision + 状态），便于日志与 UI 核对。
 */
export function buildTravelSystemPrompt(world: World): string {
  const ctx = resolveTravelContext(world);
  const parts = [buildBaselineSystemPrompt(ctx.baseline)];

  const guide = ctx.worldAgent?.travelGuide;
  if (isWorldAgentUsable(ctx) && guide && guide.content.trim()) {
    const assumptions = guide.assumptions && guide.assumptions.length
      ? `\n假设：\n${guide.assumptions.map((a) => `- ${a}`).join("\n")}`
      : "";
    parts.push(
      `【当前世界 Agent 旅行辅助 · revision ${ctx.worldAgentRevision}】\n${guide.content.trim()}${assumptions}`,
    );
  }

  parts.push(
    `【本次归因】基线版本 ${ctx.baselineVersion}；世界 Agent revision ${ctx.worldAgentRevision ?? "未使用"}；状态 ${ctx.status}${ctx.stale ? "（辅助待刷新）" : ""}。${ctx.reason}`,
  );
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// 6. 世界 Agent 引用清理（失效 → 回退基线，绝不保留半截配置）
// ---------------------------------------------------------------------------

/** 收集世界里所有可作为「来源 id」的合法标识（世界书 / 地区 / 地点 / 人物 / 事件 / 故事）。 */
function collectKnownSourceIds(world: World): Set<string> {
  const ids = new Set<string>();
  for (const e of world.worldBible ?? []) ids.add(e.id);
  for (const r of world.regions ?? []) {
    ids.add(r.id);
    for (const e of r.worldBook ?? []) ids.add(e.id);
  }
  for (const p of world.points ?? []) {
    ids.add(String(p.id));
    for (const e of p.worldBook ?? []) ids.add(e.id);
  }
  for (const c of world.characters ?? []) ids.add(c.id);
  for (const e of Object.values(world.events ?? {}).flat()) {
    if (e && typeof e.id === "string" && e.id.length > 0) ids.add(e.id);
  }
  for (const s of world.stories ?? []) ids.add(s.id);
  return ids;
}

/**
 * 清理世界 Agent 的悬空引用。
 * - 结构不完整或混入 story / IF 可写状态 → **丢弃该 Agent**（上层立即回退基线）；
 * - 失效连接 → 置空，绝不静默换模型；
 * - 悬空来源 id → 过滤。
 *
 * 纯函数：返回新的 World，不修改入参。
 */
export function normalizeTravelReferences(world: World): World {
  // 旧世界没有该字段 → 原样返回，不凭空生成
  if (world.worldAgent === undefined) return world;
  const agent = world.worldAgent;
  if (agent === null) return world;

  if (!isValidWorldAgent(agent)) {
    // 半截 / 被污染的配置不能保留：任何故事都应立即回到默认基线
    return { ...world, worldAgent: null };
  }

  const connectionIds = new Set((world.connections ?? []).map((c) => c.id));
  const known = collectKnownSourceIds(world);
  const next: WorldAgentProfile = { ...agent };
  if (next.sourceRefs) next.sourceRefs = next.sourceRefs.filter((id) => known.has(id));
  if (next.travelGuide && Array.isArray(next.travelGuide.sourceRefs)) {
    next.travelGuide = {
      ...next.travelGuide,
      sourceRefs: next.travelGuide.sourceRefs.filter((id) => known.has(id)),
    };
  }
  if (next.connectionId !== undefined) {
    next.connectionId =
      next.connectionId && connectionIds.has(next.connectionId) ? next.connectionId : null;
  }
  return { ...world, worldAgent: next };
}

/** 供日志写入的归因摘要（基线版本 + 世界 Agent revision 必须可识别）。 */
export function travelAttribution(world: World): {
  baselineVersion: string;
  worldAgentId: string | null;
  worldAgentRevision: string | null;
  status: TravelContextStatus;
} {
  const ctx = resolveTravelContext(world);
  return {
    baselineVersion: ctx.baselineVersion,
    worldAgentId: ctx.worldAgent?.id ?? null,
    worldAgentRevision: ctx.worldAgentRevision,
    status: ctx.status,
  };
}
