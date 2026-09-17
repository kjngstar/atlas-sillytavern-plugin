// W0-03：NPC 状态、位置与时间化记忆
//
// 职责（来自 待办计划 README 的 W0-03 详细交接要求）：
//  - 人物位置（地区 / 可选地点）、状态、近期记忆与轨迹；
//  - 每条记忆关联发生时间 / 行动 / 事件；
//  - 行动确认后更新相关人物；AI 建议的记忆必须可**单条接受 / 拒绝**；
//  - **读历史节点时只显示当时已有的记忆，绝不用未来记忆补全过去**；
//  - 旧世界没有 `CharacterState` 时，从 `Character.currentRegionId` 正确回退。
//
// 纯函数：无 React、无 DOM、0 fetch。返回新的 World，不修改入参。

import type {
  World,
  CharacterState,
  CharacterMemory,
  WorldAction,
  WorldOutcome,
} from "./world-schema.ts";
import { W0_LIMITS, characterStateFor } from "./world-schema.ts";
import { hashString } from "./world-cards.ts";

// ---------------------------------------------------------------------------
// 1. 位置解析与旧数据回退
// ---------------------------------------------------------------------------

export type CharacterPosition = {
  characterId: string;
  regionId: string | null;
  pointId: string | null;
  /** 位置来源：动态状态 / 旧档案回退 / 无位置 */
  source: "state" | "legacy" | "none";
  // --- N2：分支化 NPC 动态位置 ---
  /** 命中的是哪一档：本 IF 覆盖 / 正史基线 / 旧档案 / 无 */
  scope: "branch" | "canon" | "legacy" | "none";
  /** 实际命中的 CharacterState 的 branchId（null = 正史基线） */
  branchId: string | null;
};

// N2：分支作用域原语（正史基线 + IF 覆盖）的**权威实现在 `world-schema.ts`**（叶子模块），
// 这样 world-engine 等下游也能复用，不会产生反向依赖。这里集中再导出，调用方无需区分。
export {
  branchScopeForStory,
  characterStateFor,
  branchCharacterStates,
} from "./world-schema.ts";

/**
 * 解析人物当前位置。
 * 优先 `CharacterState`（权威动态位置）；旧世界没有状态时，从 `Character.currentRegionId`
 * 回退，保证升级后「人物卡显示的地区」不会凭空消失。
 *
 * N2：传入 `branchId`（IF 的 story id）时优先用该 IF 的覆盖，绝不改写正史基线。
 */
export function resolveCharacterPosition(
  world: World,
  characterId: string,
  opts: { branchId?: string | null } = {},
): CharacterPosition {
  const state = characterStateFor(world, characterId, opts.branchId ?? null);
  if (state) {
    return {
      characterId,
      regionId: state.currentRegionId ?? null,
      pointId: state.currentPointId ?? null,
      source: "state",
      scope: state.branchId ? "branch" : "canon",
      branchId: state.branchId ?? null,
    };
  }
  const legacy = (world.characters ?? []).find((c) => c.id === characterId);
  if (legacy) {
    return {
      characterId,
      regionId: legacy.currentRegionId ?? null,
      pointId: null,
      source: "legacy",
      scope: "legacy",
      branchId: null,
    };
  }
  return { characterId, regionId: null, pointId: null, source: "none", scope: "none", branchId: null };
}

/**
 * 从旧 `Character.currentRegionId` 初始化缺失的 `CharacterState`。
 * 只补**没有状态**的人物，绝不覆盖已有的动态位置。
 */
export function syncLegacyPositions(world: World, now = 0): World {
  const existing = new Set((world.characterStates ?? []).map((s) => s.characterId));
  const added: CharacterState[] = [];
  for (const c of world.characters ?? []) {
    if (existing.has(c.id)) continue;
    if (!c.currentRegionId) continue;
    added.push({
      characterId: c.id,
      currentRegionId: c.currentRegionId,
      currentPointId: null,
      updatedAt: now,
    });
  }
  if (added.length === 0) return world;
  return { ...world, characterStates: [...(world.characterStates ?? []), ...added] };
}

function pointBelongsToRegion(world: World, pointId: string, regionId: string | null): boolean {
  const p = (world.points ?? []).find((x) => String(x.id) === String(pointId));
  if (!p) return false;
  return (p.regionId ?? null) === (regionId ?? null);
}

export type MoveResult = {
  world: World;
  ok: boolean;
  /** 人类可读原因（失败时说明为什么不移动） */
  reason: string;
};

/**
 * 把人物移动到指定地区 / 地点。
 * **地点归属地区不一致时拒绝移动**，绝不写入「人物卡在 A 区、世界工作台在 B 区」的坏数据。
 */
export function moveCharacterTo(
  world: World,
  characterId: string,
  regionId: string | null,
  pointId: string | null,
  now = 0,
  opts: { branchId?: string | null } = {},
): MoveResult {
  if (!(world.characters ?? []).some((c) => c.id === characterId)) {
    return { world, ok: false, reason: `人物 ${characterId} 不存在，未移动。` };
  }
  if (regionId && !(world.regions ?? []).some((r) => r.id === regionId)) {
    return { world, ok: false, reason: `地区 ${regionId} 不存在，未移动（避免写入悬空引用）。` };
  }
  if (pointId) {
    if (!(world.points ?? []).some((p) => String(p.id) === String(pointId))) {
      return { world, ok: false, reason: `地点 ${pointId} 不存在，未移动。` };
    }
    if (!pointBelongsToRegion(world, pointId, regionId)) {
      return {
        world,
        ok: false,
        reason: `地点 ${pointId} 不属于地区 ${regionId ?? "未指定"}，未移动（地点与地区必须一致）。`,
      };
    }
  }

  // N2：branchId 为空 = 写正史基线；否则写 / 更新该 IF 的覆盖条目。
  const branchId = opts.branchId ?? null;
  const states = [...(world.characterStates ?? [])];
  const idx = states.findIndex(
    (s) => s.characterId === characterId && (branchId ? s.branchId === branchId : !s.branchId),
  );
  const patch: CharacterState = {
    characterId,
    currentRegionId: regionId ?? null,
    currentPointId: pointId ?? null,
    updatedAt: now,
    ...(branchId ? { branchId } : {}),
  };
  if (idx >= 0) {
    const prev = states[idx]!;
    states[idx] = { ...prev, ...patch, ...(prev.status !== undefined ? { status: prev.status } : {}) };
  } else {
    states.push(patch);
  }
  return { world: { ...world, characterStates: states }, ok: true, reason: "已移动。" };
}

/** 在某地点的人物 id（N2：可按分支读取；同时认动态状态与旧档案回退）。 */
export function charactersAtPoint(
  world: World,
  pointId: string,
  opts: { branchId?: string | null } = {},
): string[] {
  const target = String(pointId);
  return (world.characters ?? [])
    .map((c) => c.id)
    .filter((id) => {
      const pos = resolveCharacterPosition(world, id, opts);
      return pos.pointId !== null && String(pos.pointId) === target;
    });
}

/** 在某地区的人物 id（N2：可按分支读取）。 */
export function charactersInRegion(
  world: World,
  regionId: string,
  opts: { branchId?: string | null } = {},
): string[] {
  return (world.characters ?? [])
    .map((c) => c.id)
    .filter((id) => resolveCharacterPosition(world, id, opts).regionId === regionId);
}

/**
 * N2：删除某 IF 的**全部人物位置覆盖**（删 IF 时用）。
 * 只删该 branchId 的条目，正史基线与兄弟 IF 一个字节都不动。
 */
export function clearBranchCharacterStates(world: World, branchId: string | null | undefined): World {
  if (!branchId) return world;
  const before = world.characterStates ?? [];
  const after = before.filter((s) => s.branchId !== branchId);
  if (after.length === before.length) return world;
  return { ...world, characterStates: after };
}

// ---------------------------------------------------------------------------
// 2. 时间化记忆
// ---------------------------------------------------------------------------

export type MemoryQueryOptions = {
  /** 分支过滤：不传 = 不过滤；null = 正史视图；具体 id = 该 IF 视图 */
  branchId?: string | null;
};

/**
 * 取某人物**在指定时点已有的**记忆。
 *
 * 硬性纪律：读历史节点时按该时点筛选有效事实，
 * **绝不能用「未来记忆」补全过去**——只能取 `at <= 给定时刻` 的条目。
 */
export function memoriesAt(
  world: World,
  characterId: string,
  at: number,
  opts: MemoryQueryOptions = {},
): CharacterMemory[] {
  const branch = opts.branchId;
  return (world.characterMemories ?? [])
    .filter((m) => m.characterId === characterId)
    .filter((m) => m.at <= at)
    .filter((m) => {
      if (branch === undefined) return true;
      if (branch === null) return !m.branchId; // 正史视图：只取没有分支标记的记忆
      return m.branchId === branch || !m.branchId; // 某 IF：该 IF 的记忆 + 继承的公共记忆
    })
    .sort((a, b) => a.at - b.at);
}

/** 最近 N 条记忆（截至某时点，按发生时间倒序）。 */
export function recentMemories(
  world: World,
  characterId: string,
  at: number,
  limit = 5,
  opts: MemoryQueryOptions = {},
): CharacterMemory[] {
  const all = memoriesAt(world, characterId, at, opts);
  return all.slice(Math.max(0, all.length - Math.max(0, limit))).reverse();
}

/** 某分支（正史 / 某条 IF）的全部记忆视图；IF 记忆绝不回流污染正史。 */
export function memoriesForBranch(world: World, branchId: string | null): CharacterMemory[] {
  return (world.characterMemories ?? []).filter((m) => {
    if (branchId === null) return !m.branchId;
    return m.branchId === branchId || !m.branchId;
  });
}

/** 人物轨迹：按开始时间排序的、该人物参与过的行动。 */
export function characterTrail(world: World, characterId: string): WorldAction[] {
  return (world.actions ?? [])
    .filter((a) => a.actorId === characterId)
    .sort((a, b) => a.at - b.at);
}

/** 追加一条记忆（校验人物存在与正文非空；返回新 world）。 */
export function appendMemory(world: World, memory: CharacterMemory): World {
  if (!(world.characters ?? []).some((c) => c.id === memory.characterId)) return world;
  if (!memory.content || !memory.content.trim()) return world;
  if (memory.content.length > W0_LIMITS.maxMemoryContent) return world;
  return { ...world, characterMemories: [...(world.characterMemories ?? []), memory] };
}

// ---------------------------------------------------------------------------
// 3. 记忆草稿（AI / 行动建议）：单条接受 / 拒绝
// ---------------------------------------------------------------------------

/**
 * AI 或行动结果**建议**写入的记忆。
 * 与 `CharacterMemory` 严格分离：未经作者接受，绝不进入人物数据。
 */
export type MemoryDraft = {
  id: string;
  characterId: string;
  /** 发生时间（世界时间） */
  at: number;
  content: string;
  regionId?: string | null;
  pointId?: string | null;
  eventId?: string | null;
  actionId?: string | null;
  branchId?: string | null;
  important?: boolean;
  /** 来源：AI 建议 / 行动结果 */
  origin?: "ai" | "action";
};

export type AcceptResult = {
  world: World;
  /** 实际写入的记忆 */
  added: CharacterMemory[];
  /** 未被写入的草稿 id（被拒绝或校验失败） */
  rejected: string[];
};

/**
 * 只写入**被接受**的草稿条目。
 * 取消（`acceptedIds` 为空）或全部拒绝时**零写入**——绝不留半条 AI 猜测在人物数据里。
 */
export function acceptMemoryDrafts(
  world: World,
  drafts: MemoryDraft[],
  acceptedIds: string[],
  now = 0,
): AcceptResult {
  const accepted = new Set(acceptedIds);
  const validCharacters = new Set((world.characters ?? []).map((c) => c.id));
  const added: CharacterMemory[] = [];
  const rejected: string[] = [];

  for (const d of drafts) {
    if (!accepted.has(d.id)) {
      rejected.push(d.id);
      continue;
    }
    const content = (d.content ?? "").trim();
    if (!validCharacters.has(d.characterId) || !content || content.length > W0_LIMITS.maxMemoryContent) {
      rejected.push(d.id);
      continue;
    }
    added.push({
      id: `mem-${hashString(`${world.id}|${d.characterId}|${d.at}|${d.id}`)}`,
      characterId: d.characterId,
      at: d.at,
      content,
      ...(d.regionId !== undefined ? { regionId: d.regionId } : {}),
      ...(d.pointId !== undefined ? { pointId: d.pointId } : {}),
      ...(d.eventId !== undefined ? { eventId: d.eventId } : {}),
      ...(typeof d.important === "boolean" ? { important: d.important } : {}),
      createdAt: now,
      ...(d.actionId !== undefined ? { actionId: d.actionId } : {}),
      ...(d.branchId !== undefined ? { branchId: d.branchId } : {}),
    });
  }

  if (added.length === 0) return { world, added, rejected };
  return {
    world: { ...world, characterMemories: [...(world.characterMemories ?? []), ...added] },
    added,
    rejected,
  };
}

/**
 * 从一次已确认的行动 / 结果生成记忆草稿（**只生成建议，不写入**）。
 * 作者可对每条单独接受或拒绝。
 */
export function buildActionMemoryDrafts(
  world: World,
  action: WorldAction,
  outcome: WorldOutcome,
  opts: { branchId?: string | null; participantIds?: string[] } = {},
): MemoryDraft[] {
  const participants = new Set<string>([...(opts.participantIds ?? [])]);
  if (action.actorId) participants.add(action.actorId);

  const base = {
    at: action.endedAt ?? action.at,
    regionId: action.toRegionId ?? action.fromRegionId ?? null,
    pointId: action.toPointId ?? action.fromPointId ?? null,
    actionId: action.id,
    ...(opts.branchId !== undefined ? { branchId: opts.branchId } : {}),
    origin: "action" as const,
  };

  const drafts: MemoryDraft[] = [];
  for (const characterId of participants) {
    if (!(world.characters ?? []).some((c) => c.id === characterId)) continue;

    if (outcome.kind === "trigger" && outcome.result) {
      drafts.push({
        id: `${action.id}:${characterId}:trigger`,
        characterId,
        content: outcome.result,
        important: true,
        ...base,
      });
    } else if (outcome.kind === "nothing") {
      const where = action.toPointId ? `抵达地点 ${action.toPointId}` : "原地行动";
      drafts.push({
        id: `${action.id}:${characterId}:travel`,
        characterId,
        content: `${where}，沿途无事发生。`,
        ...base,
      });
    }
  }
  return drafts;
}
