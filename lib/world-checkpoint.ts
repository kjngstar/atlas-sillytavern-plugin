// R5-04｜检查点、恢复、撤销与备份（纯函数层）
//
// 职责（来自 待办计划README.md R5-04 工作包）：
// - 技术检查点（IF 锚点 / 采用重大变化前 / 迁移前，自动）与作者命名检查点；
// - 检查点 = 账本游标 + 物化投影 + hash；损坏 hash 拒绝作为恢复源（可从账本重建）；
// - 恢复三动作：仅查看 / 设为当前游玩头 / 从此另建 IF；默认不提供「覆盖并删除未来」；
// - 「撤销刚采用的一个变化」= 确认后的反向事件；绝不偷偷修改旧事件。
//
// 纯函数：无 React、无 DOM、0 fetch、0 Date.now；返回新 World，不修改入参。

import type { CheckpointRuntime, PlayheadState, StateEffect, World, WorldAction, WorldCheckpoint } from "./world-schema.ts";
import { W0_LIMITS } from "./world-schema.ts";
import { hashString } from "./world-cards.ts";
import { createProjectionCheckpoint, resolveWorldProjection } from "./world-projection.ts";
import { actionSortTime, branchTimeChainIsConsistent, projectRuntimeAt } from "./world-timepoint.ts";
import { appendStateEvent } from "./world-ledger.ts";
import { type DefinitionResult } from "./world-definition.ts";

/** 重建检查点快照 hash（与 R5-03 stateProjectionHash 同一规范化）。 */
export function checkpointSnapshotHash(snapshot: WorldCheckpoint["snapshot"]): string {
  return `proj-${hashString(JSON.stringify({ e: snapshot.entityStates, f: snapshot.flags, m: snapshot.memoryRefs, n: snapshot.narrativeEntries, s: snapshot.sourceChain }))}`;
}

/** 检查点 hash 是否与内容一致（损坏 = 不一致）。 */
export function isCheckpointIntact(checkpoint: WorldCheckpoint): boolean {
  return checkpointSnapshotHash(checkpoint.snapshot) === checkpoint.snapshot.stateHash;
}

/** 列出健康检查点（损坏者被隔离，不参与恢复）。 */
export function listHealthyCheckpoints(world: World, branchId?: string | null): WorldCheckpoint[] {
  return (world.checkpoints ?? []).filter((c) => isCheckpointIntact(c) && (branchId === undefined || c.branchId === branchId));
}

/**
 * 创建检查点。
 * - `kind: "technical"` 的 reason 约定：`if-fork`（IF 创建锚点）/ `before-major-change`
 *   （采用重大变化前）/ `before-migration`（迁移前）；作者命名用 `kind: "author"`；
 * - 物化投影由 `createProjectionCheckpoint` 生成并带 hash；
 * - 数量达上限时拒绝，绝不静默丢弃历史。
 */
export function createCheckpoint(
  world: World,
  opts: {
    branchId: string | null;
    at: number;
    kind: WorldCheckpoint["kind"];
    reason: string;
    name?: string;
    now?: number;
  },
): DefinitionResult<World> {
  const reason = opts.reason.trim();
  if (!reason) return { ok: false, error: "检查点必须说明创建原因" };
  if (reason.length > W0_LIMITS.maxCheckpointReason) {
    return { ok: false, error: `创建原因超过上限 ${W0_LIMITS.maxCheckpointReason} 字` };
  }
  if (opts.name !== undefined && opts.name.length > W0_LIMITS.maxCheckpointName) {
    return { ok: false, error: `检查点名称超过上限 ${W0_LIMITS.maxCheckpointName} 字` };
  }
  const list = world.checkpoints ?? [];
  if (list.length >= W0_LIMITS.maxCheckpoints) {
    return { ok: false, error: `检查点数量已达上限（${W0_LIMITS.maxCheckpoints}）；永久压缩需先生成完整备份并二次确认` };
  }
  if (opts.branchId && !(world.stories ?? []).some((s) => s.id === opts.branchId)) {
    return { ok: false, error: `分支不存在：${opts.branchId}` };
  }
  const materialized = createProjectionCheckpoint(world, opts.branchId, opts.at);
  // A24-F04：连同「游玩位置」一起物化——只有投影状态不足以让恢复后的下一次行动
  // 从检查点出发（引擎读的是 storyRuntimes 的 currentTime / 位置）。
  const runtimeSnapshot = captureRuntime(world, opts.branchId, opts.at, { now: opts.now ?? 0 });
  const checkpoint: WorldCheckpoint = {
    id: `ckpt-${hashString(`${world.id}|${opts.branchId ?? "-"}|${opts.at}|${list.length}|${reason}`)}`,
    worldId: world.id,
    kind: opts.kind,
    reason,
    ...(opts.name ? { name: opts.name } : {}),
    branchId: opts.branchId ?? null,
    at: opts.at,
    ledgerHead: materialized.sourceChain.length > 0 ? materialized.sourceChain[materialized.sourceChain.length - 1] : null,
    ledgerCount: materialized.sourceChain.length,
    ...(runtimeSnapshot ? { runtime: runtimeSnapshot } : {}),
    // R5-RC-01：按检查点时刻选择权威定义修订（而不是最新修订）
    definitionRevisionId: materialized.definitionRevisionId ?? null,
    parentCheckpointId: list.length > 0 ? list[list.length - 1].id : null,
    snapshot: {
      entityStates: materialized.entityStates,
      flags: materialized.flags,
      memoryRefs: materialized.memoryRefs,
      narrativeEntries: materialized.narrativeEntries,
      sourceChain: materialized.sourceChain,
      stateHash: materialized.stateHash,
    },
    createdAt: opts.now ?? 0,
  };
  return { ok: true, value: { ...world, checkpoints: [...list, checkpoint] } };
}

/** 检查点所属分支的运行时 storyId（正史 → 正史故事 id）。 */
function runtimeStoryId(world: World, branchId: string | null): string | null {
  if (branchId) return branchId;
  const canon = (world.stories ?? []).find((s) => s.mode === "canon");
  return canon?.id ?? null;
}

/**
 * A24-F04：捕获该分支**在检查点时刻**的游玩位置。
 *
 * 不能直接用「当前 runtime」——检查点可能记的是更早的时点（如 if-fork 锚点），
 * 那时的时间 / 位置 / 标记都和现在不同。这里复用 N1 的 `projectRuntimeAt`
 * 把运行态投影回 `at`：时间取锚点，位置取最后一条保留行动，标记撤销掉由
 * 被裁行动产生的那部分。缺资料时它自己会置 approx。
 */
export function captureRuntime(world: World, branchId: string | null, at: number, opts: { now?: number } = { now: 0 }): CheckpointRuntime | null {
  const storyId = runtimeStoryId(world, branchId);
  if (!storyId) return null;
  const projection = projectRuntimeAt(world, storyId, at, { now: opts.now ?? 0 });
  if (!projection) return null;
  const rt = projection.runtime;
  return {
    currentTime: rt.currentTime,
    currentRegionId: rt.currentRegionId ?? null,
    currentPointId: rt.currentPointId ?? null,
    worldFlags: [...(rt.worldFlags ?? [])],
    approx: projection.approx,
    // PLAY-05：连同当时的已播放行动指针一起物化，回退时直接照它还原
    actionLog: [...(rt.actionLog ?? [])],
  };
}

/** 按 id 取检查点（存在且完整才返回）。 */
export function checkpointById(world: World, checkpointId: string): WorldCheckpoint | null {
  const hit = (world.checkpoints ?? []).find((c) => c.id === checkpointId);
  return hit && isCheckpointIntact(hit) ? hit : null;
}

// ---------------------------------------------------------------------------
// 恢复三动作
// ---------------------------------------------------------------------------

export interface RestorePreview {
  checkpointId: string;
  branchId: string | null;
  at: number;
  name?: string;
  reason: string;
  ledgerHead: string | null;
  ledgerCount: number;
  /** 该检查点之后（同分支）的账本事件数——「旧未来仍保留」的可见证明 */
  futureEventCount: number;
  definitionRevisionId: string | null;
  /** R5-RC-01：检查点没有可用的历史定义快照（旧数据）→ 历史定义为近似 */
  definitionApprox?: boolean;
}

/** 恢复预览：先展示「将回到何时、何线、账本游标、旧未来仍保留」。 */
export function previewRestore(world: World, checkpointId: string): DefinitionResult<RestorePreview> {
  const checkpoint = checkpointById(world, checkpointId);
  if (!checkpoint) {
    const known = (world.checkpoints ?? []).some((c) => c.id === checkpointId);
    return { ok: false, error: known ? "检查点数据已损坏（hash 不一致），拒绝作为恢复源；可从上一检查点 + 账本重建" : "检查点不存在" };
  }
  const futureEventCount = (world.stateEvents ?? []).filter(
    (e) => e.branchId === checkpoint.branchId && e.at > checkpoint.at,
  ).length;
  return {
    ok: true,
    value: {
      checkpointId: checkpoint.id,
      branchId: checkpoint.branchId,
      at: checkpoint.at,
      ...(checkpoint.name ? { name: checkpoint.name } : {}),
      reason: checkpoint.reason,
      ledgerHead: checkpoint.ledgerHead,
      ledgerCount: checkpoint.ledgerCount,
      futureEventCount,
      definitionRevisionId: checkpoint.definitionRevisionId ?? null,
      // R5-RC-01：检查点引用的定义修订没有不可变快照（旧数据）→ 诚实标注近似
      ...((() => {
        const revision = checkpoint.definitionRevisionId
          ? (world.definitionRevisions ?? []).find((r) => r.id === checkpoint.definitionRevisionId)
          : null;
        return revision && !revision.snapshot ? { definitionApprox: true } : {};
      })()),
    },
  };
}

/** 动作一：仅查看此检查点——无写入语义，返回该时点的只读投影。 */
export function inspectCheckpoint(world: World, checkpointId: string): DefinitionResult<ReturnType<typeof resolveWorldProjection>> {
  const checkpoint = checkpointById(world, checkpointId);
  if (!checkpoint) return { ok: false, error: "检查点不存在或已损坏，拒绝作为查看源" };
  const projection = resolveWorldProjection(world, {
    worldId: world.id,
    branchId: checkpoint.branchId,
    at: checkpoint.at,
    checkpointHint: {
      worldId: checkpoint.worldId,
      branchId: checkpoint.branchId,
      at: checkpoint.at,
      definitionRevisionId: checkpoint.definitionRevisionId ?? null,
      entityStates: checkpoint.snapshot.entityStates as never,
      flags: checkpoint.snapshot.flags,
      memoryRefs: checkpoint.snapshot.memoryRefs,
      narrativeEntries: checkpoint.snapshot.narrativeEntries,
      sourceChain: checkpoint.snapshot.sourceChain,
      stateHash: checkpoint.snapshot.stateHash,
    },
    // A24-F06：检查点查看是「还原当时的定义」→ 显式钉版；
    // 普通加速投影不 pin，按目标时刻选版。
    pinDefinitionRevisionId: checkpoint.definitionRevisionId ?? null,
  });
  return { ok: true, value: projection };
}

/** A24-F04：恢复实际生效的内容（供界面显示「回到了哪里」）。 */
export interface RestoredPlayhead {
  branchId: string | null;
  at: number;
  /** 分支运行时是否一并还原（旧检查点没有 runtime 快照 → false） */
  runtimeRestored: boolean;
  /** 只还原了时间，位置 / 标记无法还原（旧数据）→ 可见的近似标注 */
  approx: boolean;
  /** 该分支被回退掉的「已播放行动」条数（世界级 actions / 账本一条都不删） */
  replayedActionsDropped: number;
}

/**
 * 动作二：将此检查点设为当前游玩头（该分支）。回到过去**不删除**其后的账本未来。
 *
 * A24-F04：光写 playheads 只是移动了展示指针，引擎仍从旧 `storyRuntimes` 取
 * 行动起点（AR-24 实测：游玩头 312、下一次行动仍从 320 开始）。现在一并还原
 * 该分支的**时间 / 地区 / 地点 / 标记**，并把该分支的「已播放行动」指针回退到
 * 检查点时刻；世界级 `actions` / `outcomes` / 账本事件一条都不删。
 */
export function restoreAsPlayhead(
  world: World,
  checkpointId: string,
  opts: { now?: number } = { now: 0 },
): DefinitionResult<World> & { restored?: RestoredPlayhead } {
  const checkpoint = checkpointById(world, checkpointId);
  if (!checkpoint) return { ok: false, error: "检查点不存在或已损坏，拒绝作为恢复源" };
  const playhead: PlayheadState = {
    branchId: checkpoint.branchId,
    at: checkpoint.at,
    checkpointId: checkpoint.id,
    updatedAt: opts.now ?? 0,
  };
  const others = (world.playheads ?? []).filter((p) => p.branchId !== checkpoint.branchId);
  let next: World = { ...world, playheads: [...others, playhead] };

  const storyId = runtimeStoryId(world, checkpoint.branchId);
  const runtimes = [...(world.storyRuntimes ?? [])];
  const idx = storyId ? runtimes.findIndex((r) => r.storyId === storyId) : -1;
  const saved = checkpoint.runtime ?? null;
  let replayedActionsDropped = 0;
  if (idx >= 0) {
    const rt = runtimes[idx]!;
    // 已播放行动指针：只保留检查点时刻及之前**已完成**的（世界级 actions 历史不动）。
    // 裁剪规则与 world-timepoint 的投影完全一致：分支时间链自洽时用 endedAt，否则退回 at。
    // 否则「行动起点 == 检查点时刻」的未来行动会被误判成已播放——回退后旧未来仍算看过。
    // 首选：照检查点当时物化的指针精确还原（新检查点）
    const savedLog = saved && Array.isArray(saved.actionLog) ? new Set(saved.actionLog) : null;
    const orderedActions = (rt.actionLog ?? [])
      .map((id) => (world.actions ?? []).find((a) => a.id === id))
      .filter((a): a is WorldAction => Boolean(a));
    const useEndedAt = branchTimeChainIsConsistent(orderedActions);
    const kept = (rt.actionLog ?? []).filter((id) => {
      const action = (world.actions ?? []).find((a) => a.id === id);
      if (!action) return true;
      if (savedLog) return savedLog.has(id);
      // 旧检查点没有指针快照 → 退回时间比较（与投影同一排序键）
      const end = actionSortTime(action, useEndedAt);
      if (end === null) return true;
      return end <= checkpoint.at;
    });
    replayedActionsDropped = (rt.actionLog ?? []).length - kept.length;
    runtimes[idx] = {
      ...rt,
      // 有 runtime 快照 → 完整还原；没有（旧检查点）→ 至少把时间对齐到检查点
      currentTime: saved ? saved.currentTime : checkpoint.at,
      ...(saved ? { currentRegionId: saved.currentRegionId } : {}),
      ...(saved && saved.currentPointId !== null ? { currentPointId: saved.currentPointId } : {}),
      ...(saved ? { worldFlags: [...saved.worldFlags] } : {}),
      actionLog: kept,
      updatedAt: opts.now ?? 0,
    };
    next = { ...next, storyRuntimes: runtimes };
  }
  return {
    ok: true,
    value: next,
    restored: {
      branchId: checkpoint.branchId,
      at: checkpoint.at,
      runtimeRestored: Boolean(saved) && idx >= 0,
      approx: !saved || saved.approx,
      replayedActionsDropped,
    },
  };
}

/** 动作三：从此检查点另建 IF——新分支从检查点的（分支、时刻）分叉，账本写时复制。 */
export function createIfFromCheckpoint(
  world: World,
  checkpointId: string,
  opts: { title: string; now: number },
): DefinitionResult<World> {
  const checkpoint = checkpointById(world, checkpointId);
  if (!checkpoint) return { ok: false, error: "检查点不存在或已损坏，拒绝作为分叉源" };
  const title = opts.title.trim();
  if (!title) return { ok: false, error: "IF 标题不能为空" };
  if ((world.stories ?? []).some((s) => s.title === title)) {
    return { ok: false, error: `已存在同名故事线：${title}` };
  }
  // 父线 = 检查点所在分支（正史检查点分叉回正史；IF 检查点分叉回该 IF）
  const parentBranchId = checkpoint.branchId;
  const parentStory = parentBranchId
    ? (world.stories ?? []).find((s) => s.id === parentBranchId)
    : (world.stories ?? []).find((s) => s.mode === "canon");
  if (!parentStory) return { ok: false, error: "找不到可分叉的父故事线" };
  const storyId = `if-${hashString(`${world.id}|${checkpoint.id}|${title}|${opts.now}`)}`;
  const newStory = {
    id: storyId,
    worldId: world.id,
    mode: "if" as const,
    title,
    parentStoryId: parentStory.id,
    divergenceEventId: null,
    steps: [],
    chapters: [],
    ifOrigin: {
      rootStoryId: parentStory.ifOrigin?.rootStoryId ?? parentStory.id,
      sourceStoryId: parentStory.id,
      anchorEventId: null,
      anchorStep: null,
      anchorAt: checkpoint.at,
      viewpointCharacterId: null,
      variant: 1,
      label: title,
      approx: false,
    },
  };
  // 从检查点分叉前自动落一个技术检查点（IF 创建锚点），记录父子关系
  const forkCheckpoint = createCheckpoint(world, {
    branchId: checkpoint.branchId,
    at: checkpoint.at,
    kind: "technical",
    reason: "if-fork",
    name: `分叉自 ${checkpoint.name ?? checkpoint.id}`,
    now: opts.now,
  });
  if (!forkCheckpoint.ok) return forkCheckpoint;
  const withForkMark = forkCheckpoint.value;
  return {
    ok: true,
    value: {
      ...withForkMark,
      stories: [...(withForkMark.stories ?? []), newStory],
    },
  };
}

/** 撤销刚采用的一个变化：**追加确认后的反向事件**（绝不修改旧事件）。 */
/** 撤销的完整形式：作者确认的反向 effects + reversesEventId，原子追加（绝不修改旧事件）。 */
export function reverseStateEventWithEffects(
  world: World,
  eventId: string,
  reverseEffects: StateEffect[],
  opts: { now?: number } = { now: 0 },
): DefinitionResult<World> {
  const original = (world.stateEvents ?? []).find((e) => e.id === eventId);
  if (!original) return { ok: false, error: `要撤销的事件不存在：${eventId}` };
  if ((world.stateEvents ?? []).some((e) => e.reversesEventId === eventId)) {
    return { ok: false, error: `事件 ${eventId} 已被撤销过` };
  }
  return appendStateEvent(world, {
    branchId: original.branchId,
    at: original.at,
    source: "author",
    narrativeSummary: `撤销：${original.narrativeSummary}`,
    effects: reverseEffects,
    entityRefs: [...original.entityRefs],
    reversesEventId: original.id,
  }, { now: opts.now ?? 0 });
}
