/**
 * atlas-runtime-view.ts — R04 统一运行时视图（单一权威快照的派生投影）。
 *
 * D05 根因：NPC 移动 / 状态写进账本（stateEvents），但 NPC 目录与状态文字读的是
 * `CharacterState` / 旧角色字段——两个读取口径永不汇合，于是「人物移动成功，附近不变」。
 *
 * 本模块是唯一的读取口径：
 * 1. 基线：`resolveCharacterPosition`（CharacterState 兼容基线 / 旧角色字段回退）；
 * 2. 账本：`projectEntityState` 沿分支重放截至 `at` 的有效事件——最新已生效的
 *    moveEntity / setTemporalField(status) 覆盖相应旧值；
 * 3. 一致性：`_pointId` 已变而 `_regionId` 未变时，按地点归属重新解析地区，
 *    不延续不一致地区；
 * 4. 注册表：`world.characters` ∪ `entityRecords[type=npc]` 关联去重——
 *    建了实体却不在 characters 中也必须可见。
 *
 * 纯函数：零 fetch、零 DOM；同输入 + 同游标 → 同输出。
 */

import type { World } from "../lib/world-schema.ts";
import { projectEntityState } from "../lib/world-ledger.ts";
import { resolveCharacterPosition } from "../lib/world-npc.ts";

export interface RuntimeNpcView {
  id: string;
  name: string;
  pointId: string | null;
  regionId: string | null;
  x: number | null;
  y: number | null;
  status: string | null;
  /** 位置来源：ledger = 账本投影（最新事实）/ state = CharacterState 基线 / legacy = 旧角色字段 */
  source: "ledger" | "state" | "legacy" | "none";
  /** 状态来源：ledger = 账本时态字段 / state = CharacterState.status */
  statusSource: "ledger" | "state" | "none";
}

/** 人物基线状态文字（CharacterState 兼容口径；与旧 handleState 读取一致）。 */
function baselineStatus(world: World, characterId: string, branchId: string | null): string | null {
  return (world.characterStates ?? [])
    .filter((s) => String(s.characterId) === characterId && (!s.branchId || s.branchId === branchId))
    .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
    .map((s) => String(s.status ?? "").trim())
    .find((t) => t.length > 0) ?? null;
}

/**
 * 统一解析一组实体的有效位置与状态（分支 / 游标感知）。
 * `entityIds` 缺省 = 全部注册表成员（characters ∪ npc 实体，去重）。
 */
export function resolveAtlasRuntimeView(
  world: World,
  opts: { branchId: string | null; at: number; entityIds?: string[] },
): { npcs: RuntimeNpcView[] } {
  const pointById = new Map((world.points ?? []).map((p) => [String(p.id), p]));
  const regionById = new Map((world.regions ?? []).map((r) => [String(r.id), r]));

  // 注册表：characters ∪ entityRecords[type=npc]，同一 ID 只出现一次
  const registry = new Map<string, string>(); // id -> displayName
  for (const c of world.characters ?? []) {
    registry.set(String(c.id), String(c.name ?? c.id));
  }
  for (const e of world.entityRecords ?? []) {
    if (String(e.type).toLowerCase() !== "npc") continue;
    const id = String(e.id);
    if (!registry.has(id)) registry.set(id, String(e.name ?? id));
  }

  const wanted = Array.isArray(opts.entityIds)
    ? opts.entityIds.map(String).filter((id) => registry.has(id))
    : [...registry.keys()];

  const npcs: RuntimeNpcView[] = wanted.map((id) => {
    const displayName = registry.get(id) ?? id;
    const base = resolveCharacterPosition(world, id, { branchId: opts.branchId });
    let pointId = base.pointId;
    let regionId = base.regionId;
    let source: RuntimeNpcView["source"] = base.source === "none" ? "none" : base.source === "state" ? "state" : "legacy";
    let status = baselineStatus(world, id, opts.branchId);
    let statusSource: RuntimeNpcView["statusSource"] = status ? "state" : "none";

    // 账本投影：最新有效事件覆盖基线（计划 4.1 规则 2）
    const projected = projectEntityState(world, id, opts.branchId, opts.at);
    if (projected && (projected._pointId !== undefined || projected._regionId !== undefined)) {
      const projPoint = projected._pointId != null ? String(projected._pointId) : null;
      const projRegion = projected._regionId != null ? String(projected._regionId) : null;
      if (projPoint !== null) {
        pointId = projPoint;
        // 规则 3：pointId 有效时以地点归属重新解析地区，不延续不一致地区
        const point = pointById.get(String(pointId));
        regionId = point ? point.regionId ?? null : projRegion ?? regionId;
      } else if (projRegion !== null) {
        regionId = projRegion;
      }
      source = "ledger";
    }
    const projStatus = projected?.status;
    if (typeof projStatus === "string" && projStatus.trim()) {
      status = projStatus.trim();
      statusSource = "ledger";
    }

    const anchorPoint = pointId !== null ? pointById.get(String(pointId)) : undefined;
    const resolvedRegion =
      regionId !== null && regionById.has(String(regionId))
        ? regionId
        : anchorPoint
          ? anchorPoint.regionId ?? null
          : regionId;
    return {
      id,
      name: displayName,
      pointId,
      regionId: resolvedRegion,
      x: anchorPoint ? anchorPoint.x : null,
      y: anchorPoint ? anchorPoint.y : null,
      status,
      source,
      statusSource,
    };
  });

  return { npcs };
}
