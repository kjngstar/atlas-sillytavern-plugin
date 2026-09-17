/**
 * atlas-relevance.ts — Atlas 回合相关性核心（纯函数，零 API、零 DOM、零随机）。
 *
 * 组合上级共享世界核心（不复制算法）：
 * - `resolveActionSources` / `selectTriggers` / `nearbyPoints`（world-engine）
 * - `charactersAtPoint` / `charactersInRegion` / `memoriesAt`（world-npc，N2 分支作用域）
 * - `deriveActionSeed`（持久化种子；文件内禁止 Math.random）
 * - `buildTravelHint`（严格 0 fetch 的旅行预览）
 *
 * 纪律：同输入 + 同世界状态 + 同种子 → 结果逐字节一致；远处无关 NPC 绝不注入。
 */

import type { World, WorldAction } from "../lib/world-schema.ts";
import {
  DEFAULT_NEARBY_RADIUS,
  buildTravelHint,
  deriveActionSeed,
  gridDistance,
  nearbyPoints,
  resolveActionSources,
  selectTriggers,
} from "../lib/world-engine.ts";
import { charactersAtPoint, charactersInRegion } from "../lib/world-npc.ts";
import { hashString } from "../lib/world-cards.ts";
import { ATLAS_LIMITS } from "./atlas-contract.ts";

export interface AtlasRelevanceInput {
  /** 当前世界时间（绑定分支运行态） */
  at: number;
  /** 正在游玩的线（正史 null / IF storyId） */
  branchId: string | null;
  chatId: string;
  messageId: string;
  currentPointId: string | null;
  currentRegionId: string | null;
  /** 已发生的世界标记（触发器条件用） */
  flags?: string[];
  /** 附近半径；缺省用共享核心默认值 */
  radius?: number;
  actorId?: string | null;
}

export type AtlasNpcHitReason = "samePoint" | "nearbyPoint" | "sameRegion";

export interface AtlasRelevanceResult {
  /** 本轮持久化种子（world.id + chat + message + at 派生，刷新重放一致） */
  seed: number;
  nearbyPointIds: string[];
  /** 命中 NPC（去重；同地点 → 附近（近→远） → 同地区，world 档案序稳定） */
  relevantNpcIds: string[];
  /** characterId → 全部命中原因（UI「为什么出现」） */
  npcReasons: Record<string, AtlasNpcHitReason[]>;
  triggerIds: string[];
  /** 世界书等可达来源（来自共享 resolveActionSources，含分支作用域） */
  sourceRefs: string[];
  /** 可达人物全集（含同行者与 actor） */
  characterIds: string[];
  radius: number;
}

/** 回合种子：chatId / messageId / at 全部持久化，因此刷新重放可得同一种子。 */
export function deriveAtlasTurnSeed(world: World, chatId: string, messageId: string, at: number): number {
  const actionCount = parseInt(hashString(`${chatId}|${messageId}`).slice(0, 8), 16) >>> 0;
  return deriveActionSeed(world, `atlas:${chatId}`, actionCount, at);
}

function pointById(world: World, pointId: string | null | undefined) {
  if (!pointId) return null;
  return (world.points ?? []).find((p) => String(p.id) === String(pointId)) ?? null;
}

/**
 * 计算本轮相关候选：附近地点、命中 NPC（带原因）、可达触发器与来源。
 * NPC 位置读取走共享 `charactersAtPoint` / `charactersInRegion`（N2 分支作用域），
 * 触发器与来源走共享 `resolveActionSources` + `selectTriggers`——本文件零自研算法。
 */
export function computeAtlasRelevance(world: World, input: AtlasRelevanceInput): AtlasRelevanceResult {
  const radius = typeof input.radius === "number" && input.radius > 0 ? input.radius : DEFAULT_NEARBY_RADIUS;
  const anchor = pointById(world, input.currentPointId);

  const nearbyWithDistance = anchor
    ? nearbyPoints(world, anchor.x, anchor.y, radius, String(anchor.id))
        .map((pointId) => {
          const point = pointById(world, pointId);
          return point ? { pointId, x: point.x, y: point.y } : null;
        })
        .filter((p): p is { pointId: string; x: number; y: number } => p !== null)
    : [];
  // 近→远排序（同距离保持 world.points 顺序，保证稳定）
  const nearbyPointIds = nearbyWithDistance
    .map((p) => ({ ...p, dist: anchor ? gridDistance(anchor.x, anchor.y, p.x, p.y) : 0 }))
    .sort((a, b) => a.dist - b.dist)
    .map((p) => p.pointId);

  const npcReasons: Record<string, AtlasNpcHitReason[]> = {};
  const orderedNpcIds: string[] = [];
  const pushNpc = (characterId: string, reason: AtlasNpcHitReason) => {
    const list = npcReasons[characterId] ?? [];
    list.push(reason);
    npcReasons[characterId] = list;
    if (!orderedNpcIds.includes(characterId)) orderedNpcIds.push(characterId);
  };

  if (input.currentPointId) {
    for (const id of charactersAtPoint(world, input.currentPointId, { branchId: input.branchId })) {
      pushNpc(id, "samePoint");
    }
  }
  for (const pointId of nearbyPointIds) {
    for (const id of charactersAtPoint(world, pointId, { branchId: input.branchId })) {
      pushNpc(id, "nearbyPoint");
    }
  }
  if (input.currentRegionId) {
    for (const id of charactersInRegion(world, input.currentRegionId, { branchId: input.branchId })) {
      pushNpc(id, "sameRegion");
    }
  }

  // 复用共享来源解析：构造一个「原地交互」行动即可拿到完整的
  // 地区 / 地点 / 附近 / 世界书 / 分支作用域 NPC 与触发器候选，不复制任何筛选算法。
  const pseudoAction: WorldAction = {
    id: `atlas-prepare-${hashString(`${input.chatId}|${input.messageId}`)}`,
    at: input.at,
    kind: "interact",
    actorId: input.actorId ?? null,
    fromPointId: input.currentPointId,
    fromRegionId: input.currentRegionId,
    toPointId: input.currentPointId,
    toRegionId: input.currentRegionId,
  };
  const sources = resolveActionSources(world, pseudoAction, {
    radius,
    branchId: input.branchId,
    companionIds: input.actorId ? [input.actorId] : [],
  });
  const triggers = selectTriggers(world, sources, {
    at: input.at,
    regionId: input.currentRegionId,
    pointId: input.currentPointId,
    characterIds: sources.characterIds,
    flags: input.flags ?? [],
  });

  return {
    seed: deriveAtlasTurnSeed(world, input.chatId, input.messageId, input.at),
    nearbyPointIds,
    relevantNpcIds: orderedNpcIds.slice(0, ATLAS_LIMITS.REF_ARRAY),
    npcReasons,
    triggerIds: triggers.map((t) => t.id).slice(0, ATLAS_LIMITS.REF_ARRAY),
    sourceRefs: sources.worldBookIds.slice(0, ATLAS_LIMITS.REF_ARRAY),
    characterIds: sources.characterIds.slice(0, ATLAS_LIMITS.REF_ARRAY),
    radius,
  };
}

export interface AtlasTravelPreviewInput {
  fromPointId: string;
  toPointId: string;
  speedTierId?: string | null;
}

/**
 * 旅行预览：完全复用共享 `buildTravelHint`（基线 + 地形 + 速度档），
 * 映射为 Atlas 契约的 travelPreview 形状；起点或终点不存在 → null。
 * 只读：不推进时间、不写任何状态。
 */
export function atlasTravelPreview(world: World, input: AtlasTravelPreviewInput): AtlasTravelPreviewShape | null {
  const hint = buildTravelHint(world, {
    fromPointId: input.fromPointId,
    toPointId: input.toPointId,
    ...(input.speedTierId ? { speedTierId: input.speedTierId } : {}),
  });
  if (!hint.from.pointId || !hint.to.pointId) return null;
  return {
    destinationId: String(hint.to.pointId),
    distance: Math.max(0, hint.distance.cells),
    estimatedDuration: Math.max(0, Math.round(hint.suggestedPeriods)),
    factors: [hint.basis],
  };
}

export interface AtlasTravelPreviewShape {
  destinationId: string;
  distance: number;
  estimatedDuration: number;
  factors: string[];
}
