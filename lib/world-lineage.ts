// PLAY-02｜分支谱系解析（叶子模块，只依赖 world-schema）
//
// 为什么单独成文件：祖先过滤规则**必须只有一份**。
// 此前 `projectEntityState`（world-ledger）与 `resolveWorldProjection`（world-projection）
// 各写了一套祖先截断：前者只认「正史 + 本线」，漏掉父 IF；后者只按 fork anchor 截断，
// 不受查看时刻约束——于是 IF@311 会读到正史 312 的未来值（A24-F05）。
// 本模块被两边共同引用，杜绝再次分叉。
//
// 纯函数：无 React、无 DOM、0 fetch、0 Date.now。

import type { World } from "./world-schema.ts";
import { W0_LIMITS } from "./world-schema.ts";

/** 谱系的一段（按应用顺序：最早祖先在前，当前分支在最后）。 */
export interface LineageSegment {
  branchId: string | null;
  /** 本段事件的时间上界（含）；null = 未知（投影置 approx） */
  cutoffAt: number | null;
  /** 截断依据 */
  basis: "projection-end" | "fork-anchor" | "unknown";
}

export interface LineageResolution {
  segments: LineageSegment[];
  approx: boolean;
  reasons: string[];
}

/** 从故事上解析 fork 时刻：ifOrigin.anchorAt → 分歧事件 year → null（未知）。 */
export function resolveForkAt(world: World, branchId: string): { at: number | null; basis: "fork-anchor" | "unknown" } {
  const story = (world.stories ?? []).find((s) => s.id === branchId);
  if (!story) return { at: null, basis: "unknown" };
  if (story.ifOrigin?.anchorAt !== undefined && story.ifOrigin?.anchorAt !== null) {
    return { at: story.ifOrigin.anchorAt, basis: "fork-anchor" };
  }
  const divergenceId = (story as { divergenceEventId?: string }).divergenceEventId;
  if (divergenceId) {
    for (const list of Object.values(world.events ?? {})) {
      for (const event of list ?? []) {
        if (event.id === divergenceId) {
          const at = Number(event.year);
          if (Number.isFinite(at)) return { at, basis: "fork-anchor" };
        }
      }
    }
  }
  return { at: null, basis: "unknown" };
}

/**
 * 分支祖先链：从当前分支回溯到正史。
 *
 * 关键规则（A24-F05）：
 *  - **祖先段的截止 = min(子线 fork anchor, 查看时刻 at)**，两者都要生效。
 *    只取 forkAt → 分歧前查看会读到正史未来；只取 at → 分歧后查看会读到正史未来。
 *  - 当前分支段的截止就是 `at`（本线没有「被截断」的概念）。
 *  - 多级 IF：链上**每一层**都要重放（父 IF 的变化必须被子 IF 继承）。
 */
export function branchLineage(world: World, branchId: string | null, at: number): LineageResolution {
  const segments: LineageSegment[] = [];
  const reasons: string[] = [];
  let approx = false;

  const chain: Array<{ branchId: string; cutoffAt: number | null; basis: "fork-anchor" | "unknown" }> = [];
  let current = branchId;
  for (let depth = 0; current !== null && depth < W0_LIMITS.maxStoryRuntimes; depth += 1) {
    const story = (world.stories ?? []).find((s) => s.id === current);
    if (!story || story.mode === "canon") break;
    const fork = resolveForkAt(world, current);
    if (fork.at === null) {
      approx = true;
      reasons.push(`分支 ${current} 无法确定 fork 锚点：祖先账本只能按查看时刻截断（可能泄露分歧后的未来）`);
    }
    chain.push({ branchId: current, cutoffAt: fork.at, basis: fork.basis });
    const parent = (story as { parentStoryId?: string } | undefined)?.parentStoryId
      ?? story?.ifOrigin?.sourceStoryId
      ?? null;
    if (parent === current) break;
    current = parent;
  }
  if (branchId !== null && chain.length === 0) {
    approx = true;
    reasons.push(`分支 ${branchId} 不是已知的 IF 线（mode 非 if 或不存在）`);
  }

  /** 祖先段的截止：fork anchor 与查看时刻取小（F05 核心）。 */
  const ancestorCutoff = (forkAt: number | null, basis: "fork-anchor" | "unknown"): { cutoffAt: number; basis: LineageSegment["basis"] } => {
    if (forkAt === null) return { cutoffAt: at, basis: "unknown" };
    const bounded = Math.min(forkAt, at);
    return { cutoffAt: bounded, basis: basis === "unknown" ? "unknown" : bounded < at ? "fork-anchor" : "projection-end" };
  };

  // 正史段：截止 = 最靠近正史的那条 IF 的 fork anchor（同样受 at 约束）
  const nearestCanonFork = chain.length > 0 ? chain[chain.length - 1]! : null;
  if (nearestCanonFork) {
    const cut = ancestorCutoff(nearestCanonFork.cutoffAt, nearestCanonFork.basis);
    segments.push({ branchId: null, cutoffAt: cut.cutoffAt, basis: cut.basis });
  } else {
    segments.push({ branchId: null, cutoffAt: at, basis: "projection-end" });
  }

  // 祖先 IF 段（从最早到较深）：截止 = 其子线的 fork anchor（同样受 at 约束）
  for (let i = chain.length - 1; i >= 1; i -= 1) {
    const childFork = chain[i - 1]!;
    const cut = ancestorCutoff(childFork.cutoffAt, childFork.basis);
    segments.push({ branchId: chain[i]!.branchId, cutoffAt: cut.cutoffAt, basis: cut.basis });
  }

  // 当前分支段：截止 = 查看时刻
  if (chain.length > 0) {
    segments.push({ branchId: chain[0]!.branchId, cutoffAt: at, basis: "projection-end" });
  }
  return { segments, approx, reasons };
}

/**
 * 谱系上真正参与投影的分支（含正史 null）。
 * 供调用方判断「某分支是否为当前查看范围的祖先」。
 */
export function lineageBranchIds(world: World, branchId: string | null, at: number): Array<string | null> {
  return branchLineage(world, branchId, at).segments.map((s) => s.branchId);
}
