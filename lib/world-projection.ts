// R5-03｜时间 / 分支投影解析器与 IF 写时复制（纯函数层）
//
// 职责（来自 待办计划README.md R5-03 工作包）：
// - **唯一**投影入口 `resolveWorldProjection`：选择定义版本 → 沿分支祖先链读取
//   每个祖先**截至子线 fork anchor** 的账本事件 → 读取当前分支截至 `at` 的事件
//   → 叠加 checkpoint 尾部事件。地图 / 时间轴 / 阅读 / 角色 / Agent 全部消费同一入口，
//   不得各自拼条件。
// - IF 写时复制：祖先（正史）事件按 fork anchor 截断，**绝不泄露锚点后的正史或兄弟线**；
//   IF 自身只保存新增事件（账本即 COW）。
// - 性能：`createProjectionCheckpoint`（物化检查点）+ 尾部重放与全量重放结果 hash 一致。
// - 只读：投影绝不写世界；只有从 T 创建 IF / 接受变化时才追加账本事件。
//
// 纯函数：无 React、无 DOM、0 fetch、0 Date.now。

import type { StateEvent, World } from "./world-schema.ts";
import { applyEffectToState, compareStateEvents, isCanonLedgerBranch, stateProjectionHash, type NarrativeEntryState, type TemporalValue } from "./world-ledger.ts";
import { definitionRevisionFor } from "./world-definition.ts";
import { branchLineage, type LineageSegment, type LineageResolution } from "./world-lineage.ts";
import type { DefinitionSnapshot } from "./world-schema.ts";

// ---------------------------------------------------------------------------
// 1. 分支谱系（唯一实现在 lib/world-lineage.ts，此处只做转发）
//
// A24-F05：祖先过滤规则曾经在这里和 world-ledger 各写一份，导致工作台与投影
// 读到不同结果。现在两边共同引用 world-lineage，杜绝再次分叉。
// ---------------------------------------------------------------------------

export type { LineageSegment, LineageResolution };
export { branchLineage };

// ---------------------------------------------------------------------------
// 2. 检查点（物化投影；持久化与恢复策略属 R5-04）
// ---------------------------------------------------------------------------

export interface ProjectionCheckpoint {
  worldId: string;
  branchId: string | null;
  /** 检查点覆盖到的账本时刻（含） */
  at: number;
  definitionRevisionId: string | null;
  entityStates: Record<string, Record<string, TemporalValue>>;
  flags: Record<string, string | boolean>;
  memoryRefs: Record<string, string[]>;
  narrativeEntries: Record<string, Record<string, NarrativeEntryState>>;
  sourceChain: string[];
  stateHash: string;
}

export interface WorldProjection {
  worldId: string;
  branchId: string | null;
  at: number;
  definitionRevisionId: string | null;
  /** R5-RC-01：该时点权威定义的不可变快照（旧数据无修订时为 null 并置 approx） */
  definitionSnapshot: DefinitionSnapshot | null;
  /** 每个实体的时态状态投影（含基线 + 账本叠加） */
  entityStates: Record<string, Record<string, TemporalValue>>;
  /** 世界标记（setFlag effects 的汇总） */
  flags: Record<string, string | boolean>;
  /** 记忆引用（appendMemoryRef 的汇总，按实体） */
  memoryRefs: Record<string, string[]>;
  /** 叙事附着条目（attach / close 的汇总，按实体） */
  narrativeEntries: Record<string, Record<string, NarrativeEntryState>>;
  /** 应用的账本事件 id（来源链，按应用顺序） */
  sourceChain: string[];
  /** 无 checkpoint 全量重放与 checkpoint + 尾部重放结果一致的证明键 */
  hash: string;
  /** 无法精确解析时的诚实标注 */
  approx: boolean;
  reasons: string[];
}

function emptyAccumulator(): {
  entityStates: Record<string, Record<string, TemporalValue>>;
  flags: Record<string, string | boolean>;
  memoryRefs: Record<string, string[]>;
  narrativeEntries: Record<string, Record<string, NarrativeEntryState>>;
  sourceChain: string[];
} {
  return { entityStates: {}, flags: {}, memoryRefs: {}, narrativeEntries: {}, sourceChain: [] };
}

function applyEvent(acc: ReturnType<typeof emptyAccumulator>, event: StateEvent): void {
  acc.sourceChain.push(event.id);
  for (const effect of event.effects) {
    if (effect.kind === "setFlag") {
      acc.flags[effect.key] = effect.value ?? true;
      continue;
    }
    if (!("entityId" in effect)) continue;
    const entityId = effect.entityId;
    acc.entityStates[entityId] ??= {};
    applyEffectToState(acc.entityStates[entityId], effect);
    if (effect.kind === "appendMemoryRef") {
      const refs = acc.memoryRefs[entityId] ?? [];
      const ref = effect.memoryId ?? effect.text ?? "";
      if (ref && !refs.includes(ref)) acc.memoryRefs[entityId] = [...refs, ref];
    }
    if (effect.kind === "attachNarrativeEntry" || effect.kind === "closeNarrativeEntry") {
      const entries = acc.entityStates[entityId]["_narrativeEntries"];
      if (entries && typeof entries === "object" && !Array.isArray(entries)) {
        acc.narrativeEntries[entityId] = entries as Record<string, NarrativeEntryState>;
      }
    }
  }
}

/**
 * A24-F06：定义版本选择有两种**不同语义**，不能混用同一个隐含开关：
 *  - 未 pin（普通查看 / 加速投影）→ 按目标时刻选当刻有效的修订；
 *  - 显式 pin（检查点查看 / 恢复）→ 钉住检查点记录的修订，即使后来又有新修订。
 * 之前 hint.definitionRevisionId 被无条件用于全部未来请求，于是「加速算未来」
 * 被错误地钉成了旧版本（全量与加速路径结果不一致）。
 */
function resolveDefinition(
  world: World,
  branchId: string | null,
  at: number,
  pin?: { revisionId: string | null },
): { revision: ReturnType<typeof definitionRevisionFor>["revision"]; approx: boolean; reason?: string } {
  if (pin) {
    if (pin.revisionId === null) {
      return { revision: null, approx: true, reason: "检查点未记录定义版本，历史定义为近似" };
    }
    const found = (world.definitionRevisions ?? []).find((r) => r.id === pin.revisionId) ?? null;
    if (!found) {
      return { revision: null, approx: true, reason: `检查点钉住的定义版本 ${pin.revisionId} 已不存在，历史定义为近似` };
    }
    return { revision: found, approx: false };
  }
  const selection = definitionRevisionFor(world, at, branchId);
  return { revision: selection.revision, approx: selection.approx, reason: selection.reason ?? undefined };
}

function finalize(
  world: World,
  branchId: string | null,
  at: number,
  acc: ReturnType<typeof emptyAccumulator>,
  approx: boolean,
  reasons: string[],
  pin?: { revisionId: string | null },
): WorldProjection {
  // R5-RC-01 + A24-F06：按语义选择定义修订（pin = 检查点钉版，否则按目标时刻选版）
  const selection = resolveDefinition(world, branchId, at, pin);
  const revision = selection.revision;
  const allReasons = [...reasons, ...(selection.reason ? [selection.reason] : [])];
  return {
    worldId: world.id,
    branchId,
    at,
    definitionRevisionId: revision?.id ?? null,
    definitionSnapshot: revision?.snapshot ?? null,
    entityStates: acc.entityStates,
    flags: acc.flags,
    memoryRefs: acc.memoryRefs,
    narrativeEntries: acc.narrativeEntries,
    sourceChain: acc.sourceChain,
    hash: stateProjectionHash({ e: acc.entityStates, f: acc.flags, m: acc.memoryRefs, n: acc.narrativeEntries, s: acc.sourceChain }),
    approx: approx || selection.approx,
    reasons: allReasons,
  };
}

/**
 * 按「全量重放」口径列出该（分支 / 时刻）之内参与投影的事件：
 * 逐段（最早祖先 → 本线）拼接，段内按 `compareStateEvents` 排序，段截止受
 * `min(其子线 fork anchor, at)` 约束。
 *
 * 唯一实现：`replayFromLedger`（全量）与 `resolveWorldProjection` 的尾部重放
 * 必须用**同一份**事件顺序，否则「加速路径」与「全量重放」的 sourceChain 顺序
 * 会不一致（hash 因此不同）。
 */
function orderedEventsFor(world: World, branchId: string | null, at: number): StateEvent[] {
  const { segments } = branchLineage(world, branchId, at);
  const ordered: StateEvent[] = [];
  for (const segment of segments) {
    const cutoff = segment.cutoffAt ?? at;
    // R5-RC-02→PLAY-01：正史段兼容旧 storyId 形式的正史事件
    const canonSegment = segment.branchId === null;
    ordered.push(...(world.stateEvents ?? [])
      .filter((e) => (canonSegment
        ? isCanonLedgerBranch(world, e.branchId)
        : e.branchId === segment.branchId) && e.at <= cutoff)
      .sort(compareStateEvents));
  }
  return ordered;
}

/** 从账本切片构建投影（无 checkpoint 的全量重放路径）。 */
function replayFromLedger(
  world: World,
  branchId: string | null,
  at: number,
  pin?: { revisionId: string | null },
): WorldProjection {
  const { approx, reasons } = branchLineage(world, branchId, at);
  const acc = emptyAccumulator();
  for (const event of orderedEventsFor(world, branchId, at)) applyEvent(acc, event);
  return finalize(world, branchId, at, acc, approx, reasons, pin);
}

/**
 * R5-03 唯一投影入口。
 * - 无 `checkpointHint`：沿谱系全量重放；
 * - 有合法 hint（world / branch 匹配、hash 一致）：从 hint 状态起步，只重放尾部
 *   尚未应用的事件（"最近 checkpoint + 尾部重放"），结果必须与全量重放一致
 *   （世界事实 / 定义版本 / hash 三项都由单测覆盖）。
 *   尾部游标按语义分两种（A24-F06）：
 *   - 未 pin（普通查看 / 加速投影）→ **身份游标**（不在 hint.sourceChain 里的事件），
 *     含同刻后补登记的事件，确保与全量重放严格等价；
 *   - 显式 pin（检查点精确查看 / 恢复）→ **时间游标**（`at > hint.at`），同刻后补
 *     登记的事件不得混入，还原的是检查点记录当时的快照。
 * - 只读：绝不修改入参 world；投影 T 不是时间旅行。
 */
export function resolveWorldProjection(
  world: World,
  request: {
    worldId: string;
    branchId: string | null;
    at: number;
    checkpointHint?: ProjectionCheckpoint;
    /**
     * A24-F06：检查点查看 / 恢复专用——显式钉住检查点记录的修订 id。
     * 不传（默认）= 普通查看或加速投影，按目标时刻选当刻有效定义。
     */
    pinDefinitionRevisionId?: string | null;
  },
): WorldProjection {
  const { worldId, branchId, at } = request;
  // 只有显式传入（即使值是 null）才算 pin
  const pin = request.pinDefinitionRevisionId !== undefined
    ? { revisionId: request.pinDefinitionRevisionId }
    : undefined;
  if (worldId !== world.id) {
    return finalize(world, branchId, at, emptyAccumulator(), true, [`worldId 不匹配：请求 ${worldId}，世界 ${world.id}`], pin);
  }
  if (branchId !== null && !(world.stories ?? []).some((s) => s.id === branchId)) {
    return finalize(world, branchId, at, emptyAccumulator(), true, [`分支不存在：${branchId}`], pin);
  }
  const hint = request.checkpointHint;
  if (hint && hint.worldId === world.id && hint.branchId === branchId && hint.at <= at) {
    // 校验 hint 完整性（hash 一致才可作为恢复源；损坏检查点 → 回退全量重放）
    const expected = stateProjectionHash({ e: hint.entityStates, f: hint.flags, m: hint.memoryRefs, n: hint.narrativeEntries, s: hint.sourceChain });
    if (expected === hint.stateHash) {
      const acc = emptyAccumulator();
      acc.entityStates = Object.fromEntries(Object.entries(hint.entityStates).map(([k, v]) => [k, { ...v }]));
      acc.flags = { ...hint.flags };
      acc.memoryRefs = Object.fromEntries(Object.entries(hint.memoryRefs).map(([k, v]) => [k, [...v]]));
      acc.narrativeEntries = Object.fromEntries(Object.entries(hint.narrativeEntries).map(([k, v]) => [k, { ...v }]));
      acc.sourceChain = [...hint.sourceChain];
      const { approx, reasons } = branchLineage(world, branchId, at);
      // 尾部重放：用与全量重放**同一份**事件顺序切出尾部。
      //
      // A24-F06：尾部游标不能用 `e.at > hint.at` 这种**时间大小**比较——
      // 检查点物化之后，账本仍可能在同一时刻（或更早时刻）追加事件（作者追溯登记、
      // 或行动恰好起于该时刻）。时间游标会把它们全部漏掉，于是「加速路径」与
      // 「全量重放」在同一（分支 / 时刻）上给出不同的世界事实（实测：flag 丢失、
      // sourceChain 顺序不同、hash 不一致），违反本模块顶部声明的契约。
      //
      // 语义分两种，不能用同一个隐含开关混淆：
      //  - 未 pin（普通查看 / 加速投影）→ 缓存基座必须是**全局序的前缀**，尾部就是
      //    其后缀。基座失效（账本被追溯改写）→ 诚实放弃缓存，退回全量重放；
      //  - 显式 pin（检查点精确查看 / 恢复）→ 时间游标（`at > hint.at`）：检查点
      //    还原的是**记录当时**的快照，其后补登记的同刻事件不得混入。
      const pinned = pin !== undefined;
      const ordered = orderedEventsFor(world, branchId, at);
      const chain = hint.sourceChain;
      const baseIsPrefix = chain.length <= ordered.length && chain.every((id, i) => ordered[i]?.id === id);
      if (!pinned && !baseIsPrefix) {
        const fallback = replayFromLedger(world, branchId, at, pin);
        return {
          ...fallback,
          reasons: [...fallback.reasons, "检查点缓存基座已失效（其后有同刻 / 更早时刻的事件被追加），改用全量重放"],
        };
      }
      const tail = pinned ? ordered.filter((e) => e.at > hint.at) : ordered.slice(chain.length);
      for (const event of tail) applyEvent(acc, event);
      // A24-F06：hint 里的 definitionRevisionId 只是**缓存记录**（创建时用了哪一版），
      // 是否被采用取决于调用方有没有显式 pin。普通加速投影必须按目标时刻重新选版，
      // 才能与全量重放得到完全一致的 definition ID / 快照 / 世界事实。
      return finalize(world, branchId, at, acc, approx, reasons, pin);
    }
  }
  return replayFromLedger(world, branchId, at, pin);
}

/** 物化检查点：在 `at` 处构建可校验的投影缓存（R5-04 的持久化基础）。 */
export function createProjectionCheckpoint(
  world: World,
  branchId: string | null,
  at: number,
): ProjectionCheckpoint {
  const projection = replayFromLedger(world, branchId, at);
  return {
    worldId: world.id,
    branchId,
    at,
    definitionRevisionId: projection.definitionRevisionId,
    entityStates: projection.entityStates,
    flags: projection.flags,
    memoryRefs: projection.memoryRefs,
    narrativeEntries: projection.narrativeEntries,
    sourceChain: projection.sourceChain,
    stateHash: projection.hash,
  };
}
