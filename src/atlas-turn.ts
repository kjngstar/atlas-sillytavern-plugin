/**
 * atlas-turn.ts — 当前回合的只读上下文准备及仍在使用的角色建档工具。
 * 提交与行增量校验分别由 atlas-server.ts / atlas-table-delta.ts 承担。
 */

import type { StateEffect, World, EntityRecord } from "../lib/world-schema.ts";
import { appendDefinitionRevision, upsertEntityRecord } from "../lib/world-definition.ts";
import { renderSceneContext } from "./atlas-scene-context.ts";
import { hashString } from "../lib/world-cards.ts";
import type { AtlasTravelPreview, AtlasTurnPrepareRequest, AtlasTurnPrepareResponse } from "./atlas-contract.ts";
import { ATLAS_ERROR_CODES, ATLAS_LIMITS, AtlasError } from "./atlas-contract.ts";
import { type AtlasRelevanceResult, atlasTravelPreview, computeAtlasRelevance } from "./atlas-relevance.ts";

export interface AtlasTurnPrepareInput {
  /** 已通过契约严格解析的 prepare 请求 */
  request: AtlasTurnPrepareRequest;
  /** 绑定分支运行态 */
  currentTime: number;
  currentPointId: string | null;
  currentRegionId: string | null;
  /** 已发生的世界标记（来自绑定分支运行态） */
  flags?: string[];
  radius?: number;
  actorId?: string | null;
  /** 玩家点选的目的地（只读预览用；不给则无 travelPreview） */
  destinationPointId?: string | null;
  /** 注入文本预算；缺省用契约上限 */
  budgetChars?: number;
}

export interface AtlasTurnPrepareOutput {
  response: AtlasTurnPrepareResponse;
  /** 供面板展示的 NPC 命中原因 */
  npcReasons: Record<string, string[]>;
  relevance: AtlasRelevanceResult;
}

function pointName(world: World, pointId: string | null): string | null {
  if (!pointId) return null;
  const point = (world.points ?? []).find((p) => String(p.id) === String(pointId));
  return point ? point.name : null;
}

/**
 * prepare：组装有界注入文本与候选清单。
 * 确定性：同世界状态 + 同请求 → 逐字节相同的 response（可回退重放）。
 * 本函数绝不发起任何网络请求。
 */
export function prepareAtlasTurn(world: World, input: AtlasTurnPrepareInput): AtlasTurnPrepareOutput {
  const request = input.request;
  const currentTime = input.currentTime;
  if (!Number.isFinite(currentTime) || currentTime < 0) {
    throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `currentTime 非法：${String(currentTime)}`);
  }

  const relevance = computeAtlasRelevance(world, {
    at: currentTime,
    branchId: request.branchId,
    chatId: request.chatId,
    messageId: request.messageId,
    currentPointId: input.currentPointId,
    currentRegionId: input.currentRegionId,
    flags: input.flags,
    radius: input.radius,
    actorId: input.actorId ?? null,
  });

  const budgetChars = Math.min(input.budgetChars ?? ATLAS_LIMITS.INJECTION_CHARS, ATLAS_LIMITS.INJECTION_CHARS);
  const scene: string[] = [];
  const locationName = pointName(world, input.currentPointId);
  if (locationName) {
    scene.push(`当前位置：${locationName.replace(/[<>]/g, '').replace(/\s+/g, ' ').slice(0, 64)}`);
    const chain: string[] = [];
    const seen = new Set<string>();
    let cursor = (world.points ?? []).find(point => String(point.id) === input.currentPointId);
    while (cursor && !seen.has(String(cursor.id)) && chain.length < 8) {
      seen.add(String(cursor.id));
      chain.unshift(String(cursor.name).replace(/[<>]/g, '').slice(0, 64));
      cursor = cursor.parentPointId == null ? undefined : (world.points ?? []).find(point => String(point.id) === String(cursor!.parentPointId));
    }
    if (chain.length > 1) scene.push(`位置链：${chain.join(' → ')}`);
  }
  const presentIds = new Set(Object.entries(relevance.npcReasons).filter(([, reasons]) => reasons.includes("samePoint")).map(([id]) => id));
  const presentNames = (world.characters ?? []).filter(row => presentIds.has(String(row.id))).slice(0, 12).map(row => String(row.name));
  if (presentNames.length) scene.push(`在场：${presentNames.join("、")}`);
  const injectionText = renderSceneContext(scene, [], budgetChars);
  const sourceRefs = [...relevance.triggerIds];

  let travelPreview: AtlasTravelPreview | undefined;
  if (input.destinationPointId) {
    const preview = atlasTravelPreview(world, {
      fromPointId: String(input.currentPointId ?? ""),
      toPointId: input.destinationPointId,
    });
    if (preview) travelPreview = preview;
  }

  const response: AtlasTurnPrepareResponse = {
    turnId: `turn-${hashString(`${request.chatId}|${request.messageId}`)}`,
    injectionText,
    sourceRefs: sourceRefs.slice(0, ATLAS_LIMITS.REF_ARRAY),
    relevantNpcIds: relevance.relevantNpcIds,
    triggerIds: relevance.triggerIds,
    currentTime,
    currentLocationId: input.currentPointId,
    ...(travelPreview ? { travelPreview } : {}),
  };
  return { response, npcReasons: relevance.npcReasons, relevance };
}

// 人物登记仍被服务端的当前回合流程用于兼容旧世界账本实体。

/** 从 effect 集合收集被引用的实体 id（setFlag 无实体引用，天然不在列）。 */
function referencedEntityIdsOf(effects: StateEffect[]): Set<string> {
  const ids = new Set<string>();
  for (const effect of effects) {
    const record = effect as unknown as Record<string, unknown>;
    for (const key of ["entityId", "targetEntityId"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) ids.add(value);
    }
  }
  return ids;
}

/** 由草稿值推断字段声明类型（推断不出返回 null → 交由账本给出明确报错）。 */
function inferValueType(value: unknown): "string" | "number" | "boolean" | "string[]" | null {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return "string[]";
  return null;
}

/**
 * 0.9.37 角色实体自动建档：账本 effect 校验只认 entityRecords（lib/world-ledger.ts
 * validateEffect），而角色（含自动建世的主角 char-main）住在 world.characters——
 * 0.9.34 裁定白名单（characters ∪ entityRecords）放行的引用，到了账本这里必被拒
 * （真实酒馆实测：setTemporalField / appendMemoryRef → 「实体不存在：char-main」整单拒收）。
 * 修法：commit 时把草稿引用到、且只存在于 characters 的角色确定性建档（只增不改），
 * 并为本轮 setTemporalField 用到的 key 自动声明 temporal 字段（值类型按草稿值推断）。
 * 建档经 appendDefinitionRevision 留审计；建档失败不打断（该实体相关 effect 交由
 * 账本给出明确报错），失败路径返回原世界，零部分写入语义不变。
 */
export function provisionReferencedCharacters(world: World, effects: StateEffect[], now: number): World {
  const referenced = referencedEntityIdsOf(effects);
  if (referenced.size === 0) return world;
  const knownRecords = new Set((world.entityRecords ?? []).map((e) => String(e.id)));
  const characters = new Map((world.characters ?? []).map((c) => [String(c.id), c]));
  const toProvision = [...referenced].filter((id) => !knownRecords.has(id) && characters.has(id));
  if (toProvision.length === 0) return world;

  let next = world;
  const provisionedNames: string[] = [];
  for (const id of toProvision) {
    const character = characters.get(id)!;
    const upsert = upsertEntityRecord(
      next,
      {
        id,
        worldId: next.id,
        type: "npc",
        name: (String(character.name ?? "").trim() || id).slice(0, 60),
        baseline: {},
        temporalSchema: [],
      },
      { now },
    );
    if (!upsert.ok) continue;
    next = upsert.value;
    provisionedNames.push(`${String(character.name ?? "").trim() || id}(${id})`);
  }
  if (provisionedNames.length === 0) return world;

  // 本轮 setTemporalField 用到的 key 自动声明（仅限本轮新建的实体；已有实体保持
  // 其声明契约不变——未声明字段的报错是上游定义纪律，不在此放宽）
  const provisionedIds = new Set(toProvision);
  for (const effect of effects) {
    if (effect.kind !== "setTemporalField") continue;
    if (!provisionedIds.has(effect.entityId)) continue;
    const record = (next.entityRecords ?? []).find((e) => e.id === effect.entityId);
    if (!record) continue;
    if (record.temporalSchema.some((f) => f.key === effect.key)) continue;
    const valueType = inferValueType(effect.value);
    if (!valueType) continue;
    const updated: EntityRecord = {
      ...record,
      temporalSchema: [...record.temporalSchema, { key: effect.key, kind: "temporal", valueType }],
    };
    const upsert = upsertEntityRecord(next, updated, { now });
    if (upsert.ok) next = upsert.value;
  }

  // 审计：定义修订留痕（修订失败不影响回合——建档本身已生效，账本校验已能通过）
  const revision = appendDefinitionRevision(next, {
    authorNote: `角色自动建档（回合推演）：${provisionedNames.join("、")}`,
    now,
    changedEntityIds: [...provisionedIds].filter((id) => (next.entityRecords ?? []).some((e) => e.id === id)),
  });
  if (revision.ok) next = revision.value;
  return next;
}
