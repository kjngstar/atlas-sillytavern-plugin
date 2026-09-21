/**
 * atlas-turn.ts — Atlas 世界回合事务（纯函数；prepare 零 API，commit 走账本）。
 *
 * 纪律（上级 README 第 4 / 7 / 8 节）：
 * - prepare：本地确定性筛选 + 有界注入文本，**零模型请求**；
 *   失败由调用方兜底，本模块不抛网络、不写状态。
 * - commit：把不可信草稿折叠为白名单 effect，经共享 `adoptPendingProposals`
 *   **原子采用**——不新建任何绕过账本的直写路径；任何失败零部分写入。
 * - 幂等：actionId = chatId::userMessageId::assistantMessageId::swipeId，
 *   同键重复提交返回 duplicate receipt，不二次推进时间 / 地点 / 记忆 / 事件。
 * - 分支隔离：注入与提交都带 branchId，经共享投影 / 谱系过滤；
 *   未来正史、兄弟 IF、未采用草稿不进入当前分支。
 */

import type { StateEffect, World } from "../lib/world-schema.ts";
import { W0_LIMITS, parseStateEffect } from "../lib/world-schema.ts";
import { latestDefinitionRevision } from "../lib/world-definition.ts";
import { adoptPendingProposals, type PendingChangeProposal } from "../lib/world-ledger.ts";
import { buildContextPlan, renderContextPlan } from "../lib/context-plan.ts";
import { hashString } from "../lib/world-cards.ts";
import { applyNewLocations, sanitizeNewLocations, type NewLocationDraft } from "./atlas-geo-apply.ts";
import type {
  AtlasTravelPreview,
  AtlasTurnCommitRequest,
  AtlasTurnPrepareRequest,
  AtlasTurnPrepareResponse,
  AtlasTurnReceipt,
} from "./atlas-contract.ts";
import {
  ATLAS_ERROR_CODES,
  ATLAS_LIMITS,
  AtlasError,
  atlasCommitIdempotencyKey,
} from "./atlas-contract.ts";
import {
  type AtlasRelevanceResult,
  type AtlasTravelPreviewShape,
  atlasTravelPreview,
  computeAtlasRelevance,
} from "./atlas-relevance.ts";
import { renderAtlasTimeHint } from "./atlas-time-intent.ts";

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

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

  // 有界上下文：走共享装配单（分支 / 时间 / 私有字段 / 未来事实过滤都在共享核心内完成）
  const budgetChars = Math.min(input.budgetChars ?? ATLAS_LIMITS.INJECTION_CHARS, ATLAS_LIMITS.INJECTION_CHARS);
  const plan = buildContextPlan(world, {
    purpose: "atlas-turn",
    branchId: request.branchId,
    at: currentTime,
    budgetChars,
  });
  const planText = renderContextPlan(plan);

  const headerLines: string[] = [];
  const locationName = pointName(world, input.currentPointId);
  headerLines.push(`【阿特拉斯】当前位置：${locationName ?? "未知地点"}${input.currentRegionId ? `（地区 ${input.currentRegionId}）` : ""}`);
  headerLines.push(`世界时间：第 ${currentTime} 时段`);
  if (relevance.relevantNpcIds.length > 0) {
    headerLines.push(`附近人物：${relevance.relevantNpcIds.join("、")}`);
  }
  // 0.9.30 id 对照表：npcChanges / locationChange 只认 id，而共享装配单（lib/ 快照）渲染实体只给名字
  // ——模型拿不到 id 只能编，「采纳 0 条（丢弃引用未知实体）」的根因。
  // 0.9.34 修复：人物对照表改为与裁定校验集（adjudicate knownEntityIds）同口径的全集封顶 60——
  // 此前沿用装配单过滤子集，名单比校验集窄：模型引用装配单外的真实角色（卡书认知到的）
  // 必被裁定丢弃，MiniMax 实测 4 条变化 / 记忆全灭。id 只是引用键，账本 effect 仍受
  // parseStateEffect 白名单与裁定实体校验双重把关，此处放宽不构成注入面。
  const entityRoster = [
    ...(world.characters ?? []).map((c) => ({ id: String(c.id), name: String(c.name ?? c.id) })),
    ...(world.entityRecords ?? []).map((e) => ({ id: String(e.id), name: String(e.name ?? e.id) })),
  ]
    .slice(0, 60)
    .map((item) => `${item.id}=${item.name}`)
    .join("；");
  if (entityRoster) headerLines.push(`人物 id 对照：${entityRoster}`);
  const pointRoster = (world.points ?? [])
    .slice(0, 60)
    .map((p) => `${String(p.id)}=${p.name}`)
    .join("；");
  if (pointRoster) headerLines.push(`地点 id 对照：${pointRoster}`);
  const regionRoster = (world.regions ?? [])
    .slice(0, 60)
    .map((r) => `${r.id}=${r.name}`)
    .join("；");
  if (regionRoster) headerLines.push(`地区 id 对照：${regionRoster}`);
  // 0.9.1 时间意图：用户行动含连贯动作 / 显式时间词时给 AI 软引导（硬下限在裁决层）
  const timeHint = renderAtlasTimeHint(request.userText);
  if (timeHint) headerLines.push(timeHint);
  const full = `${headerLines.join("\n")}\n${planText}`;
  const injectionText = full.length <= budgetChars
    ? full
    : `${full.slice(0, budgetChars)}\n【已截断：超出 ${budgetChars} 字符预算】`;

  const sourceRefs: string[] = [];
  for (const id of [...plan.sources.map((s) => s.id), ...relevance.triggerIds]) {
    if (!sourceRefs.includes(id)) sourceRefs.push(id);
  }

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

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

export interface AtlasTurnCommitInput {
  /** 已通过契约严格解析的 commit 请求 */
  request: AtlasTurnCommitRequest;
  /** 绑定分支运行态 */
  branchId: string | null;
  currentTime: number;
  currentPointId: string | null;
  currentRegionId: string | null;
  /** 独立推演 API 产出的不可信草稿（形状见上级 README 7.3） */
  draft: AtlasWorldChangeDraft;
  /** 时间戳注入（禁止内部 Date.now） */
  now?: number;
}

export interface AtlasWorldChangeDraft {
  /** 本轮消耗的时段数；缺省 0。有限非负，≤ TURN_DURATION_MAX。 */
  duration?: number;
  /** 位置变化（只更新 Atlas 绑定游标，不直写世界实体） */
  locationChange?: { toPointId?: string | null; toRegionId?: string | null } | null;
  /** 不可信候选 effect（AI 原始形态；逐条 parseStateEffect 白名单校验） */
  rawEffects?: unknown[];
  /** 记忆草稿 → appendMemoryRef effect（entityId 必须是已知实体） */
  memoryDrafts?: Array<{ entityId: string; text: string }>;
  /** 0.9.31/32 本轮剧情新出现的地点（名称制；commit 时 sanitizeNewLocations 确定性清洗并入，不走账本 effect）。
   *  0.9.32：submap 在解析层只保证是对象，形状清洗在 commit 侧 sanitizeSubMap——故草稿类型放宽为 unknown。 */
  newLocations?: Array<{ name: string; regionName?: string; description?: string; submap?: unknown }>;
  summary: string;
}

export interface AtlasTurnCommitOutput {
  receipt: AtlasTurnReceipt;
  /** 成功时为新世界；duplicate / failed 时与入参引用相等（零写入）。 */
  world: World;
  /** 0.9.31/32 新地点并入结果（仅 Atlas 侧消费：sidecar 子图落库用；不在回执契约内）。 */
  geo?: {
    regionsAdded: number;
    pointsAdded: number;
    createdPoints: Array<{ id: number; name: string; description?: string; submap?: import("./atlas-geo-apply.ts").SubMapDraft }>;
  };
}

function fail(code: (typeof ATLAS_ERROR_CODES)[keyof typeof ATLAS_ERROR_CODES], message: string): never {
  throw new AtlasError(code, message);
}

function requireKnownPoint(world: World, pointId: string | null | undefined, label: string): string | null {
  if (pointId === undefined || pointId === null) return null;
  const found = (world.points ?? []).some((p) => String(p.id) === String(pointId));
  if (!found) fail(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, `${label} 引用未知地点：${String(pointId)}`);
  return String(pointId);
}

function requireKnownRegion(world: World, regionId: string | null | undefined, label: string): string | null {
  if (regionId === undefined || regionId === null) return null;
  const found = (world.regions ?? []).some((r) => r.id === regionId);
  if (!found) fail(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, `${label} 引用未知地区：${String(regionId)}`);
  return String(regionId);
}

/** 把不可信草稿折叠为白名单 effect 列表；任何非法引用直接拒绝（零写入）。 */
function draftToEffects(world: World, draft: AtlasWorldChangeDraft): { effects: StateEffect[]; at: number } {
  const duration = draft.duration ?? 0;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
    fail(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, `草稿 duration 非法：${String(duration)}`);
  }
  if (duration > ATLAS_LIMITS.TURN_DURATION_MAX) {
    fail(ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED, `草稿 duration 超过上限 ${ATLAS_LIMITS.TURN_DURATION_MAX}`);
  }

  const summary = draft.summary.trim();
  if (!summary) fail(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "草稿缺少摘要");
  if (summary.length > W0_LIMITS.maxStateEventSummary) {
    fail(ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED, `草稿摘要超过上限 ${W0_LIMITS.maxStateEventSummary} 字`);
  }

  const rawEffects = Array.isArray(draft.rawEffects) ? draft.rawEffects : [];
  const memoryDrafts = Array.isArray(draft.memoryDrafts) ? draft.memoryDrafts : [];
  if (rawEffects.length + memoryDrafts.length > W0_LIMITS.maxStateEventEffects) {
    fail(ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED, `草稿 effect 总数超过上限 ${W0_LIMITS.maxStateEventEffects}`);
  }

  const effects: StateEffect[] = [];
  rawEffects.forEach((raw, index) => {
    const parsed = parseStateEffect(raw);
    if (!parsed) fail(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, `草稿第 ${index} 条 effect 无法解析（非白名单形状）`);
    effects.push(parsed);
  });  for (const memory of memoryDrafts) {
    const entityId = typeof memory?.entityId === "string" ? memory.entityId : "";
    const text = typeof memory?.text === "string" ? memory.text.trim() : "";
    if (!entityId || !text) fail(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "memoryDrafts 每条都需要 entityId 与非空 text");
    if (text.length > W0_LIMITS.maxMemoryContent) {
      fail(ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED, `memoryDrafts.text 超过上限 ${W0_LIMITS.maxMemoryContent} 字`);
    }
    effects.push({ kind: "appendMemoryRef", entityId, text });
  }
  return { effects, at: Math.floor(duration) };
}

/**
 * commit：草稿 → 单条提案 → 共享 `adoptPendingProposals` 原子采用。
 * - duplicate：同幂等键已在账本 → 原样返回 receipt，零写入；
 * - failed：预检 / 容量 / 校验失败 → 零部分写入（adoptPendingProposals 保证）；
 * - committed：唯一一次写入，事件 actionId 记录幂等键供审计与重放。
 */
export function commitAtlasTurn(world: World, input: AtlasTurnCommitInput): AtlasTurnCommitOutput {
  const request = input.request;
  const idempotencyKey = atlasCommitIdempotencyKey(request);
  // 幂等标记：提案 id 会作为账本事件的 sessionId（见共享 applyChangeProposal），
  // 因此同键重复提交——哪怕草稿内容变了——都能从这里找回原事件。
  // 直接存完整幂等键（parseOptionalId 无长度上限）：32-bit hash 在数千回合的
  // 长线世界里存在真实碰撞风险，会把不同回合误判为 duplicate。
  const turnMarker = `atlas::${idempotencyKey}`;
  const branchId = input.branchId;
  if (branchId !== null && !(world.stories ?? []).some((s) => s.id === branchId)) {
    fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `分支不存在：${branchId}`);
  }
  if (!Number.isFinite(input.currentTime) || input.currentTime < 0) {
    fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `currentTime 非法：${String(input.currentTime)}`);
  }

  // 1. 幂等：本回合已提交过 → 返回原 receipt
  const existing = (world.stateEvents ?? []).find((e) => e.sessionId === turnMarker);
  if (existing) {
    return {
      world,
      receipt: {
        receiptId: `rcpt-${existing.id}`,
        status: "duplicate",
        branchId: existing.branchId,
        previousTime: input.currentTime,
        currentTime: existing.at,
        triggeredNpcIds: [],
        adoptedEventIds: [existing.id],
        summary: existing.narrativeSummary,
        retryable: false,
      },
    };
  }

  // 2. 草稿校验（不可信数据）：全部通过才开始写
  const { effects, at: duration } = draftToEffects(world, input.draft);
  const at = input.currentTime + duration;
  const locationChange = input.draft.locationChange ?? null;
  const toPointId = locationChange
    ? requireKnownPoint(world, locationChange.toPointId, "locationChange")
    : null;
  const toRegionId = locationChange
    ? requireKnownRegion(world, locationChange.toRegionId, "locationChange")
    : null;
  // 0.9.31 每轮新地点：名称制草稿 → 清洗（坏条目丢弃）；commit 时确定性并入（不走账本 effect）
  const newLocations = sanitizeNewLocations(input.draft.newLocations);

  // 3. 零 effect 回合：零账本写入，直接给 committed 回执。
  //    0.9.27 修复：账本铁律「提案至少要包含一个 effect」（lib/world-ledger.ts），
  //    而「仅时间推进 / 仅位置移动、无实体变化」是模型可合法产出的草稿——
  //    此前这类草稿会走提案路径被账本整单拒收。现改为游标推进回执：
  //    时间与位置由回执驱动绑定游标（同成功路径），账本零写入、零部分写入。
  //    0.9.31：newLocations 在此路径同样并入（造点不依赖账本）。
  const summary = input.draft.summary.trim();
  if (effects.length === 0) {
    const cursorAdvanced = duration > 0 || toPointId !== null || toRegionId !== null;
    let zeroWorld = world;
    let geoNote = "";
    let zeroGeo: AtlasTurnCommitOutput["geo"] | undefined;
    if (newLocations.length > 0) {
      const geo = applyNewLocations(world, newLocations, { now: input.now ?? 0 });
      zeroWorld = geo.world;
      if (geo.pointsAdded + geo.regionsAdded > 0) {
        geoNote = `；新增地点 ${geo.pointNames.join("、")}${geo.regionNames.length > 0 ? `（地区 ${geo.regionNames.join("、")}）` : ""}`;
        zeroGeo = {
          regionsAdded: geo.regionsAdded,
          pointsAdded: geo.pointsAdded,
          createdPoints: geo.createdPoints.map((p) => ({ id: p.id, name: p.name, ...(p.description ? { description: p.description } : {}), ...(p.submap ? { submap: p.submap } : {}) })),
        };
      }
    }
    return {
      world: zeroWorld,
      ...(zeroGeo ? { geo: zeroGeo } : {}),
      receipt: {
        receiptId: `rcpt-${hashString(idempotencyKey)}`,
        status: "committed",
        branchId,
        previousTime: input.currentTime,
        currentTime: at,
        previousLocationId: input.currentPointId,
        ...(toPointId !== null ? { currentLocationId: toPointId } : {}),
        triggeredNpcIds: [],
        adoptedEventIds: [],
        summary: cursorAdvanced
          ? `${summary}（本轮无实体变化：仅时间 / 位置推进，未写入账本）${geoNote}`
          : geoNote ? `${summary}${geoNote}` : "本轮无世界变化。",
        retryable: false,
      },
    };
  }

  // 4. 单条提案原子采用（共享账本管线；失败零部分写入）
  const pending: PendingChangeProposal = {
    id: turnMarker,
    summary,
    at,
    branchId,
    effects,
    origin: {
      worldId: world.id,
      branchId,
      definitionRevisionId: latestDefinitionRevision(world)?.id ?? null,
      requestId: idempotencyKey,
      ...(input.now !== undefined ? { createdAt: input.now } : {}),
    },
    selected: true,
  };
  const result = adoptPendingProposals(world, [pending], { now: input.now ?? 0, source: "ai-adopted" });
  if (!result.ok) {
    // 0.9.17 诊断透出：通用消息「整单未提交：N 条校验失败」不带原因，用户无法修。
    // rejected 里首条非「整单连坐」的 error 就是真实校验原因（如未知地点引用 / 版本过期）。
    const firstReason = result.rejected.find(
      (item) => item.ok === false && item.error && item.error !== "同批存在被拒绝的提案，整单未提交",
    )?.error;
    const detail = firstReason ? ` 失败原因：${firstReason.slice(0, 300)}` : "";
    return {
      world,
      receipt: {
        receiptId: `rcpt-${hashString(idempotencyKey)}`,
        status: "failed",
        branchId,
        previousTime: input.currentTime,
        currentTime: input.currentTime,
        previousLocationId: input.currentPointId,
        currentLocationId: input.currentPointId,
        triggeredNpcIds: [],
        adoptedEventIds: [],
        summary: `${result.error ?? "写入失败"}${detail}`,
        retryable: true,
      },
    };
  }

  // 4.5 0.9.31 每轮新地点：账本 effect 不能造点（lib 白名单无 addPoint），
  //     在提案采用成功后把本轮 newLocations 并入世界（geo 同款确定性口径）。
  let finalWorld = result.world;
  let geoNote = "";
  let successGeo: AtlasTurnCommitOutput["geo"] | undefined;
  if (newLocations.length > 0) {
    const geo = applyNewLocations(result.world, newLocations, { now: input.now ?? 0 });
    finalWorld = geo.world;
    if (geo.pointsAdded + geo.regionsAdded > 0) {
      geoNote = `；新增地点 ${geo.pointNames.join("、")}${geo.regionNames.length > 0 ? `（地区 ${geo.regionNames.join("、")}）` : ""}`;
      successGeo = {
        regionsAdded: geo.regionsAdded,
        pointsAdded: geo.pointsAdded,
        createdPoints: geo.createdPoints.map((p) => ({ id: p.id, name: p.name, ...(p.description ? { description: p.description } : {}), ...(p.submap ? { submap: p.submap } : {}) })),
      };
    }
  }

  return {
    world: finalWorld,
    ...(successGeo ? { geo: successGeo } : {}),
    receipt: {
      receiptId: `rcpt-${result.adopted[0]?.eventId ?? hashString(idempotencyKey)}`,
      status: "committed",
      branchId,
      previousTime: input.currentTime,
      currentTime: at,
      previousLocationId: input.currentPointId,
      ...(toPointId !== null || toRegionId !== null
        ? { currentLocationId: toPointId ?? input.currentPointId }
        : {}),
      triggeredNpcIds: [],
      adoptedEventIds: result.adopted.map((item) => item.eventId ?? "").filter((id) => id.length > 0),
      summary: `${summary}${geoNote}`,
      retryable: false,
    },
  };
}

export type { AtlasTravelPreviewShape };
