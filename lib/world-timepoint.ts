// N1｜历史时点快照投影（纯函数层）
//
// 为什么必须有这一层：
//   「从这里开始体验」此前直接**深拷贝来源线当前运行态**当作 IF 起点。那意味着
//   从一个很早的历史事件创建 IF 时，IF 的初始时间、位置、人物位置、世界标记和记忆
//   全部来自**正史的末尾**——锚点之后的正史未来被静默当成了 IF 的既定历史（F4）。
//
// 三条硬纪律：
//  1. **只保留能被证明发生在锚点之前的本分支行动**：`endedAt ?? at <= 锚点`。
//     缺少时间字段或引用失效的行动**不作为历史依据**，并显式记进 `reasons`。
//  2. **绝不静默读未来状态**：位置、世界标记、人物位置都由保留下来的行动重建；
//     无法重建时回落到可解释的近似起点，并置 `approx = true`——界面必须诚实显示
//     「按导入资料近似起点」，不得把近似值伪装成精确历史。
//  3. **纯函数、0 fetch、无 React、禁止 `Math.random()` / `Date.now()`**，
//     时间戳一律由 `opts.now` 注入；返回新对象，绝不修改入参。
//
// 本文件不依赖 DOM / 网络，便于 node:test 直接覆盖。

import type { World, WorldAction, StoryRuntime, CharacterState } from "./world-schema.ts";
import { W0_LIMITS } from "./world-schema.ts";

// ---------------------------------------------------------------------------
// 1. 行动时间轴：一条行动「属于哪个时刻」
// ---------------------------------------------------------------------------

/**
 * 一条行动的**结束时刻**（`endedAt ?? at`）。
 *
 * 注意：这只是时长归因字段，**不保证与 `at` 自洽**（历史数据里存在
 * `startedAt/endedAt` 自成一条链、与 `at` 完全不同步的世界）。因此裁剪历史时
 * 不能无条件优先用它，见 `actionSortTime`。
 */
export function actionEndTime(action: WorldAction): number | null {
  if (typeof action.endedAt === "number" && Number.isFinite(action.endedAt)) return action.endedAt;
  if (typeof action.at === "number" && Number.isFinite(action.at)) return action.at;
  return null;
}

const TIME_EPS = 1e-9;

/**
 * 整条分支的 `startedAt → at → endedAt` 链是否自洽。
 *
 * 自洽的判据（全部满足）：每条行动的 `startedAt <= at <= endedAt`，且链条不倒流。
 * 只有自洽时才敢用 `endedAt` 做裁剪——否则会出现「行动明明发生在 418.02，
 * 却因为归因字段写成 419.02 而被整段误判为未来」的静默数据丢失。
 */
export function branchTimeChainIsConsistent(actions: WorldAction[]): boolean {
  if (actions.length === 0) return false;
  let prevEnd = -Infinity;
  for (const a of actions) {
    if (typeof a.at !== "number" || !Number.isFinite(a.at)) return false;
    const start = typeof a.startedAt === "number" ? a.startedAt : a.at;
    const end = typeof a.endedAt === "number" ? a.endedAt : a.at;
    if (!(start <= a.at + TIME_EPS && a.at <= end + TIME_EPS)) return false;
    if (start < prevEnd - TIME_EPS) return false;
    prevEnd = end;
  }
  return true;
}

/**
 * 行动在时点投影中使用的**排序键**。
 *
 * - `endedAt` 可用且整条链自洽 → 用 `endedAt`（能正确处理「锚点落在行动进行中」）。
 * - 否则一律用 `at`——它是本代码库里唯一权威的世界时刻：记忆过滤、beat、
 *   第一人称可见性和 `runtime.currentTime` 全部以它为准。
 */
export function actionSortTime(action: WorldAction, useEndedAt: boolean): number | null {
  if (useEndedAt && typeof action.endedAt === "number" && Number.isFinite(action.endedAt)) {
    return action.endedAt;
  }
  if (typeof action.at === "number" && Number.isFinite(action.at)) return action.at;
  return actionEndTime(action);
}

/** 一次行动对位置的最终落点（没有终点时留在起点；等待 / 原地交互绝不产生新位置）。 */
function actionLanding(action: WorldAction): { regionId: string | null; pointId: string | null } {
  if (action.toPointId) return { regionId: action.toRegionId ?? null, pointId: action.toPointId };
  if (action.toRegionId) return { regionId: action.toRegionId, pointId: null };
  return { regionId: action.fromRegionId ?? null, pointId: action.fromPointId ?? null };
}

// ---------------------------------------------------------------------------
// 2. 时点投影结果
// ---------------------------------------------------------------------------

export type TimepointPositionSource = "action" | "event" | "baseline" | "legacy" | "unknown";

export interface TimepointCharacterPosition {
  characterId: string;
  regionId: string | null;
  pointId: string | null;
  /** 位置来源：本分支保留行动 / 事件锚点 / 正史基线 / 旧档案回退 / 无法重建 */
  source: TimepointPositionSource;
  /** 依据的行动 id（source === "action" 时有值） */
  actionId: string | null;
  /** 该人物的基线位置可能已被未来行动改写，因此只是近似 */
  approx: boolean;
}

export interface TimepointProjection {
  storyId: string;
  /** 投影锚点（世界时间） */
  anchorAt: number;
  /** 投影后的运行态（`storyId` 保持原值；改名由调用方负责） */
  runtime: StoryRuntime;
  /** 被证明发生在锚点之前的行动 id（保持原顺序） */
  keptActionIds: string[];
  /** 被裁掉的行动 id：锚点之后，或缺少可定位时间 */
  droppedActionIds: string[];
  /** 由**被裁掉**行动的结果产生、因此在该时点尚未发生的世界标记 */
  revokedFlags: string[];
  /** 各人物在该时点的位置 */
  characterPositions: TimepointCharacterPosition[];
  /** 分支整体位置的来源 */
  positionSource: TimepointPositionSource;
  /** 近似起点：无法精确重建时为 true，界面必须诚实显示 */
  approx: boolean;
  /** 人类可读的原因列表（近似 / 数据缺失时逐条说明） */
  reasons: string[];
}

export interface ProjectOptions {
  /** 事件锚点：分支在锚点前没有任何行动时，用事件地区作为可解释的起点 */
  anchorEventId?: string | null;
  /** 时间戳注入（禁止内部 Date.now） */
  now?: number;
}

const outcomeFlagRefs = (world: World, actionIds: string[]): string[] => {
  const ids = new Set(actionIds);
  const out: string[] = [];
  for (const o of world.outcomes ?? []) {
    if (!ids.has(o.actionId)) continue;
    for (const ref of o.changeRefs ?? []) {
      if (ref.startsWith("flag:") && ref.length > 5) out.push(ref.slice(5));
    }
  }
  return out;
};

/**
 * 把某条分支的运行态**投影到指定历史时刻**。
 *
 * 纯函数：返回新对象，绝不修改入参；分支不存在时返回 null。
 * 这是 N1 的核心，也是 R4-03「IF 初始态必须由锚点时刻投影而非复制父线末尾」的依据。
 */
export function projectRuntimeAt(
  world: World,
  storyId: string,
  at: number,
  opts: ProjectOptions = {},
): TimepointProjection | null {
  if (!storyId?.trim()) return null;
  const source = (world.storyRuntimes ?? []).find((r) => r.storyId === storyId);
  if (!source) return null;
  const anchorAt = typeof at === "number" && Number.isFinite(at) ? at : 0;
  const now = opts.now ?? 0;
  const reasons: string[] = [];
  let approx = false;

  const actionById = new Map<string, WorldAction>((world.actions ?? []).map((a) => [a.id, a]));
  const keptActionIds: string[] = [];
  const droppedActionIds: string[] = [];
  const undatedActionIds: string[] = [];

  // 只有整条分支的 startedAt / at / endedAt 链自洽时才敢用 endedAt 裁剪。
  const orderedActions = (source.actionLog ?? [])
    .map((id) => actionById.get(id))
    .filter((a): a is WorldAction => Boolean(a));
  const useEndedAt = branchTimeChainIsConsistent(orderedActions);

  for (const id of source.actionLog ?? []) {
    const action = actionById.get(id);
    if (!action) {
      // 引用失效：清引用，绝不伪造历史
      droppedActionIds.push(id);
      reasons.push(`行动 ${id} 的引用已失效，未作为历史依据。`);
      approx = true;
      continue;
    }
    const end = actionSortTime(action, useEndedAt);
    if (end === null) {
      droppedActionIds.push(id);
      undatedActionIds.push(id);
      continue;
    }
    if (end <= anchorAt) keptActionIds.push(id);
    else droppedActionIds.push(id);
  }

  if (undatedActionIds.length > 0) {
    approx = true;
    reasons.push(
      `${undatedActionIds.length} 条行动缺少可定位的时间字段，已按「不在锚点之前」处理；该时点为近似起点。`,
    );
  }

  // 1. 位置：由最后一条保留行动重建
  let positionSource: TimepointPositionSource = "unknown";
  let regionId: string | null = null;
  let pointId: string | null = null;
  const lastKept = keptActionIds.length
    ? actionById.get(keptActionIds[keptActionIds.length - 1]!)
    : undefined;
  if (lastKept) {
    const landing = actionLanding(lastKept);
    regionId = landing.regionId;
    pointId = landing.pointId;
    positionSource = "action";
  } else {
    // 2. 没有可定位的保留行动：退回事件锚点 → 世界当前地区 → 未知，并诚实标记近似
    // 事件按「地区 id → 事件数组」存储，事件自身不带 regionId：锚点地区就是它所在的键。
    const anchorEventId = opts.anchorEventId ?? null;
    let anchorRegionId: string | null = null;
    let anchorEventTitle: string | null = null;
    if (anchorEventId) {
      for (const [regionKey, list] of Object.entries(world.events ?? {})) {
        const hit = (list ?? []).find((e) => e.id === anchorEventId);
        if (hit) {
          anchorRegionId = regionKey;
          anchorEventTitle = hit.title;
          break;
        }
      }
    }
    if (anchorRegionId) {
      regionId = anchorRegionId;
      pointId = null;
      positionSource = "event";
      reasons.push(
        `该分支在锚点前没有可定位的行动，起点按事件「${anchorEventTitle ?? anchorEventId}」所在地区近似。`,
      );
    } else if (world.currentRegionId) {
      regionId = world.currentRegionId;
      pointId = null;
      positionSource = "event";
      reasons.push("该分支在锚点前没有可定位的行动，起点按世界当前地区近似。");
    } else {
      reasons.push("该分支在锚点前没有可定位的行动，且没有可用的地区锚点：起点未知。");
    }
    approx = true;
  }

  // 3. 世界标记：撤销由被裁掉行动的结果产生的标记（保留行动仍产生的标记不动）
  const droppedFlags = new Set(outcomeFlagRefs(world, droppedActionIds));
  const keptFlags = new Set(outcomeFlagRefs(world, keptActionIds));
  const revokedFlags = [...droppedFlags].filter((f) => !keptFlags.has(f));
  const worldFlags = (source.worldFlags ?? []).filter((f) => !revokedFlags.includes(f));
  if (revokedFlags.length > 0) {
    reasons.push(`已撤销 ${revokedFlags.length} 个由锚点之后行动产生的世界标记：${revokedFlags.join("、")}。`);
  }

  const runtime: StoryRuntime = {
    storyId,
    currentTime: anchorAt,
    currentRegionId: regionId,
    ...(source.currentPointId !== undefined || pointId !== null ? { currentPointId: pointId } : {}),
    ...(source.companions ? { companions: [...source.companions] } : {}),
    ...(source.worldFlags || worldFlags.length ? { worldFlags } : {}),
    actionLog: keptActionIds.slice(-W0_LIMITS.maxActions),
    snapshotFrom: source.snapshotFrom ?? null,
    updatedAt: now,
  };

  return {
    storyId,
    anchorAt,
    runtime,
    keptActionIds,
    droppedActionIds,
    revokedFlags,
    characterPositions: projectCharacterPositionsAt(world, {
      storyId,
      at: anchorAt,
      keptActionIds,
      droppedActionIds,
      actionById,
    }),
    positionSource,
    approx: approx || revokedFlags.length > 0,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// 3. 人物位置投影（N1 × N2：按分支读，绝不拿未来位置补全过去）
// ---------------------------------------------------------------------------

export interface CharacterProjectionContext {
  storyId: string;
  at: number;
  keptActionIds: string[];
  droppedActionIds: string[];
  actionById: Map<string, WorldAction>;
}

/**
 * 各人物在该时点的位置。
 *
 * 优先级：本分支保留行动（精确）→ 正史基线（若该人物在本分支有被裁掉的行动，
 * 说明基线可能已被未来行动改写，此时标 `approx`）→ 旧档案回退 → 未知。
 */
export function projectCharacterPositionsAt(
  world: World,
  ctx: CharacterProjectionContext,
): TimepointCharacterPosition[] {
  const droppedByActor = new Set<string>();
  for (const id of ctx.droppedActionIds) {
    const action = ctx.actionById.get(id);
    if (action?.actorId) droppedByActor.add(action.actorId);
  }
  const keptByActor = new Map<string, { actionId: string; regionId: string | null; pointId: string | null }>();
  for (const id of ctx.keptActionIds) {
    const action = ctx.actionById.get(id);
    if (!action?.actorId) continue;
    const landing = actionLanding(action);
    keptByActor.set(action.actorId, { actionId: action.id, regionId: landing.regionId, pointId: landing.pointId });
  }

  const out: TimepointCharacterPosition[] = [];
  for (const c of world.characters ?? []) {
    const kept = keptByActor.get(c.id);
    if (kept) {
      out.push({
        characterId: c.id,
        regionId: kept.regionId,
        pointId: kept.pointId,
        source: "action",
        actionId: kept.actionId,
        approx: false,
      });
      continue;
    }
    const state = (world.characterStates ?? []).find(
      (s) => s.characterId === c.id && !s.branchId,
    );
    if (state) {
      out.push({
        characterId: c.id,
        regionId: state.currentRegionId ?? null,
        pointId: state.currentPointId ?? null,
        source: "baseline",
        actionId: null,
        // 基线可能被本分支锚点之后的行动改写过 → 诚实标近似
        approx: droppedByActor.has(c.id),
      });
      continue;
    }
    if (c.currentRegionId) {
      out.push({
        characterId: c.id,
        regionId: c.currentRegionId,
        pointId: null,
        source: "legacy",
        actionId: null,
        approx: droppedByActor.has(c.id),
      });
      continue;
    }
    out.push({
      characterId: c.id,
      regionId: null,
      pointId: null,
      source: "unknown",
      actionId: null,
      approx: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. 为 IF 构造初始快照（R4-03 依赖：初始态 = 锚点投影，不是父线末尾拷贝）
// ---------------------------------------------------------------------------

export interface IFInitialSnapshot {
  /** 新 IF 的运行态（storyId 已是目标 id，currentTime = 锚点） */
  runtime: StoryRuntime;
  /**
   * 需要写入的**人物位置覆盖**（branchId = 目标 story id）。
   * 只包含「能由保留行动精确重建」的人物；其余人物继续读正史基线，避免无意义覆盖。
   */
  characterStates: CharacterState[];
  projection: TimepointProjection;
}

/**
 * 按锚点时刻为一条新 IF 构造初始运行态与人物位置覆盖。
 *
 * 与旧的「深拷贝父线当前运行态」的本质区别：
 * - 时间 = 锚点，而不是父线末尾；
 * - 行动日志 = 锚点之前的部分，锚点之后的正史**不在这个 IF 里**；
 * - 世界标记撤销了锚点之后行动产生的项；
 * - 人物位置由保留行动重建，重建不出来时标近似而不是抄未来。
 */
export function buildIFInitialSnapshot(
  world: World,
  sourceStoryId: string,
  targetStoryId: string,
  at: number,
  opts: ProjectOptions = {},
): IFInitialSnapshot | null {
  if (!targetStoryId?.trim()) return null;
  const projection = projectRuntimeAt(world, sourceStoryId, at, opts);
  if (!projection) return null;
  const now = opts.now ?? 0;
  const characterStates: CharacterState[] = projection.characterPositions
    .filter((p) => p.source === "action")
    .map((p) => ({
      characterId: p.characterId,
      currentRegionId: p.regionId,
      currentPointId: p.pointId,
      updatedAt: now,
      branchId: targetStoryId,
    }));
  return {
    runtime: { ...projection.runtime, storyId: targetStoryId, snapshotFrom: sourceStoryId, updatedAt: now },
    characterStates,
    projection,
  };
}
