/**
 * atlas-turn-v2.ts — R05 推进协议 v2 应用管线（纯函数；经 commitAtlasTurn 复用原子性）。
 *
 * 对应《修复计划》第 5 节：v2 草稿（已过 atlas-contract-v2 语法校验）→
 * 1. 引用解析：已知实体用原 ID；new:loc:* / new:npc:* 临时引用在本响应内
 *    确定性分配持久 ID（地点 = 现有数字 id 顺延；人物 = npc-<hash(turnId|ref)>）；
 *    未知名 / 未知地区 / 未知引用 → 明确报错，零写入。
 * 2. 候选世界：新地点（MapPoint，regionRef 为 null 则不归属）+ 新人物
 *    （Character + npc EntityRecord，temporalSchema 预声明 status:string）只增不改。
 * 3. 折叠为 v1 形草稿（scene→locationChange；npcUpdates set→moveEntity、
 *    status→setTemporalField；relationUpdates→adjustRelation；worldFlags→setFlag；
 *    memories→memoryDrafts；events→summary 行），交 commitAtlasTurn ——
 *    幂等 / 原子 / 零部分写入语义与 v1 完全同源，不另起直写路径。
 *
 * v2 不走 v1 裁定层（adjudicateAtlasDraft）：时长由模型按场景申报（0 合法），
 * 旅行耗时裁定只适用 v1 的 duration 重算；此差异在 IMPLEMENTATION_STATUS 记为残项。
 */

import type { Character, EntityRecord, MapPoint, World } from "../lib/world-schema.ts";
import { W0_LIMITS } from "../lib/world-schema.ts";
import { appendDefinitionRevision } from "../lib/world-definition.ts";
import { hashString } from "../lib/world-cards.ts";
import { commitAtlasTurn, type AtlasWorldChangeDraft } from "./atlas-turn.ts";
import { applyIdentityUpdates, resolveEntityByRef } from "./atlas-identity.ts";
import { ATLAS_ERROR_CODES, AtlasError, atlasCommitIdempotencyKey, type AtlasTurnCommitRequest, type AtlasTurnReceipt } from "./atlas-contract.ts";
import type { AtlasV2Draft } from "./atlas-contract-v2.ts";

export interface AtlasV2TurnInput {
  /** 已通过 parseAtlasWorldTurnDraftV2 的 v2 草稿 */
  draft: AtlasV2Draft;
  /** 原始 commit 请求（幂等键与草稿内容无关，来自传输层） */
  request: AtlasTurnCommitRequest;
  branchId: string | null;
  currentTime: number;
  currentPointId: string | null;
  currentRegionId: string | null;
  now?: number;
}

export interface AtlasV2RefResolution {
  locations: Array<{ ref: string; pointId: number; created: boolean }>;
  characters: Array<{ ref: string; entityId: string; created: boolean }>;
  /** presence / parentLocationRef / 已知实体身份更新等本轮未落账的项（R06/R07 接手） */
  warnings: string[];
}

export interface AtlasV2TurnOutput {
  receipt: AtlasTurnReceipt;
  /** 成功时为候选世界提交后的新世界；duplicate / failed 时零写入。 */
  world: World;
  refResolution: AtlasV2RefResolution;
  createdPointIds: number[];
  createdEntityIds: string[];
  /**
   * v2 mapScaleHints 转发（R10）：由 atlas-server 接到 maps sidecar 的 calibrations
   * （不在本模块内写 sidecar——避免再次引入全局 IO 路径，遵守 R12 的"事务原子性"约束）。
   * duplicate / failed 时也透传，便于 caller 记日志 / 警告。
   */
  scaleHints: Array<{
    mapRef: string;
    frameRevision: number | null;
    status: "estimated" | "grounded" | "unknown" | "conflict";
    extentMeters: { width: number; height: number } | null;
    basis: string;
    confidence: "low" | "medium" | "high";
    evidenceIds: string[];
  }>;
}

function fail(message: string): never {
  throw new AtlasError(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, message);
}

// ---------------------------------------------------------------------------
// 引用解析
// ---------------------------------------------------------------------------

interface RefTables {
  /** "12" / "new:loc:x" → 数字点 id */
  points: Map<string, number>;
  /** 已知实体 id → 自身；"new:npc:y" → 分配 id */
  entities: Map<string, string>;
}

/**
 * 构建 v2 引用表并产出候选世界增量（只增不改）：
 * - 已知点 id / 已知地区 id 立即校验（未知 → 报错，拒绝整个提交）；
 * - new:loc 分配顺延数字 id（黄金角螺旋散点，确定性）；
 * - new:npc 分配 npc-<hash8(turnId|ref)>，撞 id 追加序号；
 *   新人物同时进 characters 与 entityRecords（type:"npc"，预声明 status 时态字段）。
 */
function resolveRefsAndBuildCandidate(
  world: World,
  draft: AtlasV2Draft,
  turnId: string,
): { candidate: World; tables: RefTables; createdPointIds: number[]; createdEntityIds: string[]; warnings: string[]; parentRefs: Array<{ ref: string; parentLocationRef: string }> } {
  const warnings: string[] = [];
  const knownRegionIds = new Set((world.regions ?? []).map((r) => String(r.id)));
  const pointByStringId = new Map((world.points ?? []).map((p) => [String(p.id), p] as const));
  const knownEntityIds = new Set<string>([
    ...(world.characters ?? []).map((c) => String(c.id)),
    ...(world.entityRecords ?? []).map((e) => String(e.id)),
  ]);

  // --- 已知地区引用校验（discoveries.locations.regionRef）---
  for (const loc of draft.discoveries.locations) {
    if (loc.regionRef !== null && !knownRegionIds.has(loc.regionRef)) {
      fail(`discoveries.locations[${loc.ref}].regionRef 引用未知地区：${loc.regionRef}`);
    }
  }

  // --- 地点：已知 id 即校验；new:loc 分配 ---
  const points = new Map<string, number>();
  const newPoints: MapPoint[] = [];
  const basePointId = (world.points ?? []).reduce((max, p) => Math.max(max, Number(p.id) || 0), 0);
  const spreadIndex = (world.points ?? []).length;
  const parentRefs: Array<{ ref: string; parentLocationRef: string }> = [];
  for (const loc of draft.discoveries.locations) {
    if (loc.parentLocationRef !== null) parentRefs.push({ ref: loc.ref, parentLocationRef: loc.parentLocationRef });
    if (loc.ref.startsWith("new:")) {
      const index = newPoints.length;
      const angle = (spreadIndex + index) * 2.39996;
      const radius = 14 + 3.4 * Math.sqrt(index + 1);
      const pointId = basePointId + index + 1;
      points.set(loc.ref, pointId);
      newPoints.push({
        id: pointId,
        name: loc.name,
        x: Math.round(Math.min(96, Math.max(4, 50 + radius * Math.cos(angle)))),
        y: Math.round(Math.min(96, Math.max(4, 50 + radius * Math.sin(angle)))),
        // regionRef 为 null → 不归属（MapPoint.regionId 可空）；未知地区已被上面的校验拒绝
        ...(loc.regionRef !== null ? { regionId: loc.regionRef } : { regionId: null }),
      });
    } else if (pointByStringId.has(loc.ref)) {
      points.set(loc.ref, Number(loc.ref));
    } else {
      // discoveries 里重复登记已知地点没有必要，但也无害——只有完全未知的 id 才拒绝
      fail(`discoveries.locations.ref 引用未知地点：${loc.ref}`);
    }
  }
  // 场景 / 更新里的地点引用：已知 id 或 new:loc
  const allLocationRefs = [
    ...(draft.scene.locationRef !== null ? [draft.scene.locationRef] : []),
    ...draft.npcUpdates.map((u) => (u.location.locationRef !== null ? u.location.locationRef : "")).filter((s) => s.length > 0),
  ];
  for (const ref of allLocationRefs) {
    if (points.has(ref)) continue;
    if (pointByStringId.has(ref)) {
      points.set(ref, Number(ref));
      continue;
    }
    fail(`locationRef 引用未知地点（既非已知 id 也非本响应声明的 new:loc）：${ref}`);
  }

  // --- 人物：已知 id 即通过；new:npc 分配 ---
  const entities = new Map<string, string>();
  const newCharacters: Character[] = [];
  const newRecords: EntityRecord[] = [];
  const usedIds = new Set(knownEntityIds);
  const charNameSet = new Set((world.characters ?? []).map((c) => String(c.name ?? "").trim()));
  for (const char of draft.discoveries.characters) {
    if (char.ref.startsWith("new:")) {
      let entityId = `npc-${hashString(`${turnId}|${char.ref}`)}`;
      for (let n = 2; usedIds.has(entityId); n += 1) entityId = `npc-${hashString(`${turnId}|${char.ref}|${n}`)}`;
      usedIds.add(entityId);
      entities.set(char.ref, entityId);
      newCharacters.push({
        id: entityId,
        worldId: world.id,
        name: char.displayName,
        role: "配角",
        description: char.description,
        currentRegionId: null,
        ...(char.aliases.length > 0 ? { tags: [...char.aliases] } : {}),
      });
      newRecords.push({
        id: entityId,
        worldId: world.id,
        type: "npc",
        name: char.displayName,
        baseline: {},
        // 预声明 status + presence：npcUpdates 的 setTemporalField 必须有字段契约
        temporalSchema: [
          { key: "status", kind: "temporal", valueType: "string" },
          { key: "presence", kind: "temporal", valueType: "string" },
        ],
      });
      if (charNameSet.has(char.displayName)) {
        warnings.push(`新人物「${char.displayName}」(${entityId}) 与既有角色同名——身份消歧在 R07 处理，本轮按新实体建档。`);
      }
    }
  }
  // 全部 entityRef 汇总注册（含未在 discoveries 里重复声明的已知实体——
  // npcUpdates / relations / memories / events 直接用已知 id 引用是合法 v2 输出）：
  // 已知 → 恒等映射；未知且非 new: → 拒绝
  const allEntityRefs = [
    ...draft.discoveries.characters.filter((c) => !c.ref.startsWith("new:")).map((c) => c.ref),
    ...draft.npcUpdates.map((u) => u.entityRef),
    ...draft.relationUpdates.flatMap((r) => [r.fromRef, r.toRef]),
    ...draft.memories.map((m) => m.entityRef),
    ...draft.identityUpdates.map((i) => i.entityRef),
    ...draft.events.flatMap((e) => e.entityRefs),
  ];
  for (const ref of allEntityRefs) {
    if (entities.has(ref)) continue;
    if (knownEntityIds.has(ref)) {
      entities.set(ref, ref);
      continue;
    }
    // R07 身份消歧：非 ID 引用按 displayName / 别名**精确**名字解析；
    // 歧义（同场多个女性 / 同名）不强行合并——整单拒绝并给出候选
    const resolution = resolveEntityByRef(world, ref);
    if (resolution.ambiguous) {
      fail(`entityRef「${ref}」同时匹配多个实体（${resolution.candidates.join("、")}）——同名/别名歧义不强行合并，请改用明确 ID`);
    }
    if (resolution.id) {
      entities.set(ref, resolution.id);
      warnings.push(`entityRef「${ref}」按名字解析为 ${resolution.id}（临时称呼不是临时身份，仅精确匹配）`);
      continue;
    }
    fail(`entityRef 引用未知实体（既非已知 id、已知称呼，也非本响应声明的 new:npc）：${ref}`);
  }

  const candidate: World = {
    ...world,
    ...(newPoints.length > 0 ? { points: [...(world.points ?? []), ...newPoints] } : {}),
    ...(newCharacters.length > 0 ? { characters: [...(world.characters ?? []), ...newCharacters] } : {}),
    ...(newRecords.length > 0 ? { entityRecords: [...(world.entityRecords ?? []), ...newRecords] } : {}),
  };

  return { candidate, tables: { points, entities }, createdPointIds: newPoints.map((p) => p.id), createdEntityIds: newCharacters.map((c) => c.id), warnings, parentRefs };
}

// ---------------------------------------------------------------------------
// v2 → v1 形草稿折叠
// ---------------------------------------------------------------------------

function resolveLocation(tables: RefTables, ref: string): number {
  const pointId = tables.points.get(ref);
  if (pointId === undefined) fail(`locationRef 引用未知地点：${ref}`);
  return pointId;
}

function resolveEntity(tables: RefTables, ref: string): string {
  const entityId = tables.entities.get(ref);
  if (entityId === undefined) fail(`entityRef 引用未知实体：${ref}`);
  return entityId;
}

function pointRegionId(candidate: World, pointId: number): string | null {
  const point = (candidate.points ?? []).find((p) => p.id === pointId);
  return point?.regionId ?? null;
}

function foldToV1Draft(
  candidate: World,
  draft: AtlasV2Draft,
  tables: RefTables,
  warnings: string[],
): { v1: AtlasWorldChangeDraft; withIdentity: World; identityUpdatedIds: string[] } {
  const rawEffects: unknown[] = [];
  const memoryDrafts: Array<{ entityId: string; text: string }> = [];

  for (const update of draft.npcUpdates) {
    const entityId = resolveEntity(tables, update.entityRef);
    const record = (candidate.entityRecords ?? []).find((e) => e.id === entityId);
    const presenceDeclared = Boolean(record?.temporalSchema.some((f) => f.key === "presence"));
    if (update.location.op === "set" && update.location.locationRef !== null) {
      const pointId = resolveLocation(tables, update.location.locationRef);
      const regionId = pointRegionId(candidate, pointId);
      rawEffects.push({ kind: "moveEntity", entityId, ...(regionId !== null ? { regionId } : {}), pointId: String(pointId) });
    } else if (update.location.op === "clear") {
      // R07 离场语义：目的地未知可 clear——账本 effect 无「清位置」，落 presence=left
      // （有声明才写，未声明的已知实体不整单炸提案）
      if (presenceDeclared) {
        rawEffects.push({ kind: "setTemporalField", entityId, key: "presence", value: "left" });
      } else {
        warnings.push(`npcUpdates[${update.entityRef}].location.op=clear：实体未声明 presence 字段，离场暂未落账。`);
      }
    }
    if (update.status !== null) {
      rawEffects.push({ kind: "setTemporalField", entityId, key: "status", value: update.status });
    }
    // presence：没有提到 = 保持（unknown 不写）；present/left 只在字段声明过时落账
    if (update.presence !== "unknown" && !(update.location.op === "clear" && update.presence === "left")) {
      if (presenceDeclared) {
        rawEffects.push({ kind: "setTemporalField", entityId, key: "presence", value: update.presence });
      } else if (update.presence === "left") {
        warnings.push(`npcUpdates[${update.entityRef}].presence=left：实体未声明 presence 字段，未落账。`);
      }
    }
  }

  for (const rel of draft.relationUpdates) {
    const value = typeof rel.value === "string" || typeof rel.value === "number" ? rel.value : JSON.stringify(rel.value);
    rawEffects.push({
      kind: "adjustRelation",
      entityId: resolveEntity(tables, rel.fromRef),
      targetEntityId: resolveEntity(tables, rel.toRef),
      key: rel.key,
      value,
    });
  }

  for (const flag of draft.worldFlags) {
    rawEffects.push({
      kind: "setFlag",
      key: flag.key,
      ...(flag.value !== undefined && flag.value !== null ? { value: String(flag.value) } : {}),
    });
  }

  for (const memory of draft.memories) {
    memoryDrafts.push({ entityId: resolveEntity(tables, memory.entityRef), text: memory.text });
  }

  // 场景锚定 → 位置游标（v2 语义：模型直接给出确认位置；旅行耗时裁定不适用）
  const locationChange =
    draft.scene.locationRef !== null && (draft.scene.resolution === "confirmed" || draft.scene.resolution === "estimated")
      ? (() => {
          const pointId = resolveLocation(tables, draft.scene.locationRef!);
          const regionId = pointRegionId(candidate, pointId);
          return { toPointId: String(pointId), ...(regionId !== null ? { toRegionId: regionId } : { toRegionId: null }) };
        })()
      : null;

  // identityUpdates（R07）：不重建实体——已知 / 本轮新建实体统一走 applyIdentityUpdates
  // 更新 displayName 与别名；已知实体的名字修订在提交成功后追加定义修订审计
  const identityUpdatesResolved: Array<{ entityId: string; displayName: string; addAliases: string[] }> = [];
  for (const update of draft.identityUpdates) {
    const entityId = resolveEntity(tables, update.entityRef);
    identityUpdatesResolved.push({ entityId, displayName: update.displayName, addAliases: update.addAliases });
  }
  const identity = applyIdentityUpdates(candidate, identityUpdatesResolved);
  const withIdentity: World = identity.world;
  const identityUpdatedIds = identity.updatedIds;
  for (const update of draft.identityUpdates) {
    const entityId = resolveEntity(tables, update.entityRef);
    if (!identityUpdatedIds.includes(entityId)) {
      warnings.push(`identityUpdates[${update.entityRef}]：displayName 与别名均无实际变化，未写定义。`);
    }
  }

  // events → summary 附加行（W0 摘要上限内；放不下则只保留主摘要，事件明细不静默丢失——回执里仍可审计）
  let summary = draft.summary;
  if (draft.events.length > 0) {
    const joined = `${summary}；事件：${draft.events.map((e) => e.summary).join("；")}`;
    if (joined.length <= W0_LIMITS.maxStateEventSummary) summary = joined;
    else warnings.push(`事件明细超出摘要上限，仅保留主摘要（${draft.events.length} 条事件未并入 summary）。`);
  }

  return {
    v1: {
      duration: draft.duration,
      ...(locationChange ? { locationChange } : {}),
      rawEffects,
      memoryDrafts,
      summary: summary.slice(0, W0_LIMITS.maxStateEventSummary),
    },
    withIdentity,
    identityUpdatedIds,
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function applyAtlasV2Turn(world: World, input: AtlasV2TurnInput): AtlasV2TurnOutput {
  const turnId = atlasCommitIdempotencyKey(input.request);

  // 幂等预检：同键已提交 → 跳过候选世界构建（临时引用分配是有副作用的形状推导，
  // 在幂等命中后重复分配会把新点 / 新人挂进 duplicate 返回的世界，造成幽灵增量）。
  // 直接交 commitAtlasTurn 走原 duplicate 路径取回原回执，零写入。
  const turnMarker = `atlas::${turnId}`;
  if ((world.stateEvents ?? []).some((e) => e.sessionId === turnMarker)) {
    const dup = commitAtlasTurn(world, {
      request: input.request,
      branchId: input.branchId,
      currentTime: input.currentTime,
      currentPointId: input.currentPointId,
      currentRegionId: input.currentRegionId,
      draft: { duration: 0, summary: "(duplicate 预检占位)" },
      now: input.now,
    });
    return {
      receipt: dup.receipt,
      world: dup.world,
      refResolution: { locations: [], characters: [], warnings: [] },
      createdPointIds: [],
      createdEntityIds: [],
      scaleHints: input.draft.mapScaleHints,
    };
  }

  const { candidate, tables, createdPointIds, createdEntityIds, warnings, parentRefs } = resolveRefsAndBuildCandidate(world, input.draft, turnId);
  if (parentRefs.length > 0) {
    warnings.push(`${parentRefs.length} 条 parentLocationRef 暂存未落账（子图层级在 R09 接线）：${parentRefs.map((p) => `${p.ref}←${p.parentLocationRef}`).join("、")}`);
  }

  const { v1, withIdentity, identityUpdatedIds } = foldToV1Draft(candidate, input.draft, tables, warnings);

  const output = commitAtlasTurn(withIdentity, {
    request: input.request,
    branchId: input.branchId,
    currentTime: input.currentTime,
    currentPointId: input.currentPointId,
    currentRegionId: input.currentRegionId,
    draft: v1,
    now: input.now,
  });

  // 零写入契约（收口）：failed / duplicate 时返回原世界（commitAtlasTurn 的失败路径
  // 返回传入的候选世界，候选增量不能外泄）
  if (output.receipt.status !== "committed") {
    return {
      receipt: output.receipt,
      world,
      refResolution: {
        locations: input.draft.discoveries.locations.map((loc) => ({ ref: loc.ref, pointId: tables.points.get(loc.ref) ?? Number(loc.ref), created: loc.ref.startsWith("new:") })),
        characters: input.draft.discoveries.characters.map((char) => ({ ref: char.ref, entityId: tables.entities.get(char.ref) ?? char.ref, created: char.ref.startsWith("new:") })),
        warnings,
      },
      createdPointIds: [],
      createdEntityIds: [],
      scaleHints: input.draft.mapScaleHints,
    };
  }

  // R07 身份修订审计：已知实体（非本轮新建）的 displayName / 别名变更追加定义修订
  let finalWorld = output.world;
  const auditIds = identityUpdatedIds.filter((id) => !createdEntityIds.includes(id));
  if (auditIds.length > 0) {
    const names = auditIds
      .map((id) => (finalWorld.characters ?? []).find((c) => String(c.id) === id))
      .filter(Boolean)
      .map((c) => `${c!.name}(${c!.id})`);
    const revision = appendDefinitionRevision(finalWorld, {
      authorNote: `R07 身份更新（identityUpdates）：${names.join("、") || auditIds.join("、")}`,
      now: input.now ?? 0,
      changedEntityIds: auditIds,
    });
    if (revision.ok) finalWorld = revision.value;
  }

  return {
    receipt: output.receipt,
    world: finalWorld,
    refResolution: {
      locations: input.draft.discoveries.locations.map((loc) => ({
        ref: loc.ref,
        pointId: tables.points.get(loc.ref) ?? Number(loc.ref),
        created: loc.ref.startsWith("new:"),
      })),
      characters: input.draft.discoveries.characters.map((char) => ({
        ref: char.ref,
        entityId: tables.entities.get(char.ref) ?? char.ref,
        created: char.ref.startsWith("new:"),
      })),
      warnings,
    },
    createdPointIds,
    createdEntityIds,
    scaleHints: input.draft.mapScaleHints,
  };
}
