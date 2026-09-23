// R5-02｜类型化状态附着、事件账本与结构化变化提案（纯函数层）
//
// 职责（来自 待办计划README.md R5-02 工作包）：
// - 追加式 `StateEvent` 账本：每条变化可定位到时间、分支、来源与叙事摘要；
//   一经采用不得原地覆写；更正以新事件 / 撤销事件（reversesEventId）表达。
// - `effects` 白名单 schema（在 schema parser 已做形状校验；本层做**语义校验**：
//   实体存在、字段已声明为 temporal、值类型匹配、标签冲突等）。
// - `ChangeProposal`：AI / 世界 Agent 只能返回提案；
//   `proposal → preview → 作者接受 → 原子追加 StateEvent` 是唯一写入路径；
//   作者可拆分采用（只接受部分 effect）或全部拒绝（零写入）。
// - 同一实体 / 字段 / 时刻的确定性规则：按 `at`、`sequence`、来源优先级排序。
//
// 纯函数：无 React、无 DOM、0 fetch、0 Date.now；返回新 World，不修改入参。

import type { ChangeProposal, StateEffect, StateEvent, World } from "./world-schema.ts";
import { STATE_EFFECT_KINDS, W0_LIMITS, parseStateEvent, parseStateEffect } from "./world-schema.ts";
import { hashString } from "./world-cards.ts";
import { entityRecordById, latestDefinitionRevision, type DefinitionResult } from "./world-definition.ts";
import { branchLineage } from "./world-lineage.ts";

/** 同一时刻多个事件的来源优先级（小者先应用；作者登记最高）。 */
const SOURCE_PRIORITY: Record<StateEvent["source"], number> = {
  author: 0,
  action: 1,
  "ai-adopted": 2,
};

function stateEventsOf(world: World): StateEvent[] {
  return world.stateEvents ?? [];
}

/**
 * R5-RC-02→PLAY-01：正史事件的兼容判定。
 * 权威形式是 branchId === null；旧数据可能以正史故事 id 记账——两者都视为正史段。
 */
export function isCanonLedgerBranch(world: World, branchId: string | null): boolean {
  if (branchId === null) return true;
  const story = (world.stories ?? []).find((st) => st.id === branchId);
  return story?.mode === "canon";
}

/** 下一个稳定 sequence：同一 (branchId, at) 内取最大 sequence + 1，否则 0。 */
export function nextSequence(world: World, branchId: string | null, at: number): number {
  const sameMoment = stateEventsOf(world)
    .filter((e) => e.branchId === branchId && e.at === at)
    .map((e) => e.sequence);
  return sameMoment.length > 0 ? Math.max(...sameMoment) + 1 : 0;
}

/** 账本确定序：at → sequence → 来源优先级 → id（完全可复现）。 */
export function compareStateEvents(a: StateEvent, b: StateEvent): number {
  if (a.at !== b.at) return a.at - b.at;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  const pa = SOURCE_PRIORITY[a.source] ?? 3;
  const pb = SOURCE_PRIORITY[b.source] ?? 3;
  if (pa !== pb) return pa - pb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 分支的账本切片（正史 = branchId null；IF 只取本分支事件；祖先链重放属 R5-03）。 */
export function ledgerForBranch(world: World, branchId: string | null): StateEvent[] {
  const canon = isCanonLedgerBranch(world, branchId) && branchId !== null
    ? null // 旧 storyId 形式的正史事件按正史段读取
    : branchId;
  return stateEventsOf(world)
    .filter((e) => (canon === null ? isCanonLedgerBranch(world, e.branchId) : e.branchId === canon))
    .sort(compareStateEvents);
}

/** 单个 effect 的语义校验（实体存在、字段声明、值类型、moveEntity 目标存在）。 */
function validateEffect(world: World, effect: StateEffect, entityIds: Set<string>): string | null {
  const entityOf = (id: string) => entityRecordById(world, id);
  const requireEntity = (id: string): string | null => {
    if (!entityIds.has(id)) return `实体不存在：${id}`;
    return null;
  };
  switch (effect.kind) {
    case "setTemporalField": {
      const issue = requireEntity(effect.entityId);
      if (issue) return issue;
      const entity = entityOf(effect.entityId);
      const declared = entity?.temporalSchema.find((f) => f.key === effect.key);
      if (!declared) return `实体 ${effect.entityId} 未声明字段 ${effect.key}`;
      if (declared.kind !== "temporal" && declared.kind !== "private") {
        return `字段 ${effect.key} 不可由账本改写（${declared.kind}；仅 temporal / private 可变）`;
      }
      const value = effect.value;
      const typeOk =
        (declared.valueType === "string" && typeof value === "string") ||
        (declared.valueType === "number" && typeof value === "number") ||
        (declared.valueType === "boolean" && typeof value === "boolean") ||
        (declared.valueType === "string[]" && Array.isArray(value) && value.every((v) => typeof v === "string"));
      if (!typeOk) return `字段 ${effect.key} 的值类型应为 ${declared.valueType}`;
      return null;
    }
    case "moveEntity": {
      const issue = requireEntity(effect.entityId);
      if (issue) return issue;
      if (effect.regionId && !(world.regions ?? []).some((r) => r.id === effect.regionId)) {
        return `移动目标地区不存在：${effect.regionId}`;
      }
      if (effect.pointId && !(world.points ?? []).some((p) => String(p.id) === String(effect.pointId))) {
        return `移动目标地点不存在：${effect.pointId}`;
      }
      return null;
    }
    case "adjustRelation": {
      const issue = requireEntity(effect.entityId);
      if (issue) return issue;
      const issue2 = requireEntity(effect.targetEntityId);
      if (issue2) return issue2;
      // 关系值语义（0.9.54 A2）：非空字符串或有限数字，原样落账。
      // 旧实现 `!isFinite(Number(effect.value))` 有两个方向都错的后果：
      // - `Number("依赖")` = NaN → 合法文字关系被整单拒绝，而错误文字却自称接受字符串；
      // - `Number("")` / `Number("   ")` = 0（有限）→ 空关系值反被放过。
      // applyEffectToState 本来就按原值写 state[relation:...]，此处只做形状判定。
      const value = effect.value;
      const valid = typeof value === "number"
        ? Number.isFinite(value)
        : typeof value === "string" && value.trim().length > 0;
      if (!valid) return `关系值必须是非空字符串或有限数字`;
      return null;
    }
    case "addTag": {
      const issue = requireEntity(effect.entityId);
      if (issue) return issue;
      const entity = entityOf(effect.entityId);
      const declared = entity?.temporalSchema.find((f) => f.key === "tags");
      if (!declared) return `实体 ${effect.entityId} 未声明 tags 字段`;
      return null;
    }
    case "removeTag": {
      const issue = requireEntity(effect.entityId);
      if (issue) return issue;
      return null;
    }
    case "appendMemoryRef": {
      const issue = requireEntity(effect.entityId);
      if (issue) return issue;
      if (!effect.memoryId && !effect.text) return "记忆引用必须带 memoryId 或 text";
      return null;
    }
    case "attachNarrativeEntry": {
      const issue = requireEntity(effect.entityId);
      if (issue) return issue;
      return null;
    }
    case "closeNarrativeEntry": {
      const issue = requireEntity(effect.entityId);
      if (issue) return issue;
      return null;
    }
    case "setFlag": {
      return null;
    }
  }
}

/** 事件级语义校验：引用实体存在 + 每个 effect 合法 + 撤销目标存在。 */
export function validateStateEvent(world: World, event: StateEvent): string[] {
  const errors: string[] = [];
  const entityIds = new Set((world.entityRecords ?? []).map((e) => e.id));
  const knownEventIds = new Set(stateEventsOf(world).map((e) => e.id));
  for (const ref of event.entityRefs) {
    if (!entityIds.has(ref)) errors.push(`受影响实体不存在：${ref}`);
  }
  for (const effect of event.effects) {
    const issue = validateEffect(world, effect, entityIds);
    if (issue) errors.push(`${effect.kind}：${issue}`);
  }
  if (event.reversesEventId && !knownEventIds.has(event.reversesEventId)) {
    errors.push(`撤销目标事件不存在：${event.reversesEventId}`);
  }
  if (event.branchId && !(world.stories ?? []).some((s) => s.id === event.branchId)) {
    errors.push(`分支不存在：${event.branchId}`);
  }
  return errors;
}

/**
 * 账本事件的内容级确定性 id。
 * 同一（世界 / 分支 / 时刻 / 来源 / 摘要 / effects）永远得到同一个 id——
 * 幂等的唯一依据；采用方可以据此判断「这条变化已经入过账」，从而让双击
 * 与重复提交不产生第二次写入，也不把它们误报成失败。
 */
export function stateEventContentId(
  world: World,
  input: { branchId: string | null; at: number; source: StateEvent["source"]; narrativeSummary: string; effects: StateEffect[] },
): string {
  return `stsev-${hashString(`${world.id}|${input.branchId ?? "-"}|${input.at}|${input.source}|${input.narrativeSummary}|${JSON.stringify(input.effects)}`)}`;
}

/**
 * 原子追加一条状态事件（「登记世界变化」/「采用提案」的唯一写入口）。
 * - 校验失败 → 原样返回 + 可读错误（零写入）；
 * - 成功 → 追加到 `world.stateEvents`，sequence 由 `nextSequence` 分配；
 * - 事件对象由本函数完整构造（id / sequence / createdAt 注入），调用方不得预置。
 */
export function appendStateEvent(
  world: World,
  input: {
    branchId: string | null;
    at: number;
    source: StateEvent["source"];
    narrativeSummary: string;
    effects: StateEffect[];
    entityRefs?: string[];
    actionId?: string | null;
    sessionId?: string | null;
    reversesEventId?: string | null;
  },
  opts: { now?: number } = { now: 0 },
): DefinitionResult<World> {
  const summary = input.narrativeSummary.trim();
  if (!summary) return { ok: false, error: "叙事摘要不能为空" };
  if (summary.length > W0_LIMITS.maxStateEventSummary) {
    return { ok: false, error: `叙事摘要超过上限 ${W0_LIMITS.maxStateEventSummary} 字` };
  }
  if (input.effects.length === 0) return { ok: false, error: "事件至少要包含一个 effect" };
  if (input.effects.length > W0_LIMITS.maxStateEventEffects) {
    return { ok: false, error: `单条事件最多 ${W0_LIMITS.maxStateEventEffects} 个 effect` };
  }
  const list = stateEventsOf(world);
  if (list.length >= W0_LIMITS.maxStateEvents) {
    return { ok: false, error: `账本事件数量已达上限（${W0_LIMITS.maxStateEvents}）` };
  }
  // R5-07：内容级确定性 id 幂等——同一（分支 / 时刻 / 来源 / 摘要 / effects）的变化
  // 只会被写入一次；双击或并发采用的第二次追加被拒绝。
  const contentId = stateEventContentId(world, {
    branchId: input.branchId ?? null,
    at: input.at,
    source: input.source,
    narrativeSummary: summary,
    effects: input.effects,
  });
  if (list.some((e) => e.id === contentId)) {
    return { ok: false, error: `状态事件已存在（${contentId}）；同一变化只会写入一次` };
  }
  const touched = new Set<string>();
  for (const effect of input.effects) {
    if ("entityId" in effect) touched.add(effect.entityId);
  }
  for (const ref of input.entityRefs ?? []) touched.add(ref);
  const event: StateEvent = {
    id: contentId,
    worldId: world.id,
    branchId: input.branchId ?? null,
    at: input.at,
    sequence: nextSequence(world, input.branchId ?? null, input.at),
    source: input.source,
    ...(input.actionId ? { actionId: input.actionId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    narrativeSummary: summary,
    entityRefs: [...touched],
    effects: input.effects,
    ...(input.reversesEventId ? { reversesEventId: input.reversesEventId } : {}),
    createdAt: opts.now ?? 0,
  };
  const errors = validateStateEvent(world, event);
  if (errors.length > 0) {
    return { ok: false, error: `状态事件校验失败：${errors.join("；")}` };
  }
  // PLAY-01：可解析往返预检——语义合法但形状不可解析的 effect（如 setFlag 布尔值）
  // 会在保存 / 重载时破坏世界，必须在写入前拒绝。
  if (parseStateEvent(JSON.parse(JSON.stringify(event))) === null) {
    return { ok: false, error: `状态事件形状不可解析（重载后会破坏存档）：${JSON.stringify(event.effects)}` };
  }
  return { ok: true, value: { ...world, stateEvents: [...list, event] } };
}

// ---------------------------------------------------------------------------
// 投影（单实体、单分支；完整世界投影解析器属 R5-03）
// ---------------------------------------------------------------------------

/** 叙事附着条目（attachNarrativeEntry 的投影形态） */
export interface NarrativeEntryState { text: string; closed: boolean }

/** 单个时态字段的投影值形态 */
export type TemporalValue = string | number | boolean | string[] | NarrativeEntryState[] | Record<string, NarrativeEntryState> | undefined;

/** 应用一个 effect 到实体时态状态（返回新状态对象；不修改入参）。 */
export function applyEffectToState(
  state: Record<string, TemporalValue>,
  effect: StateEffect,
): void {
  switch (effect.kind) {
    case "setTemporalField":
      state[effect.key] = effect.value;
      break;
    case "moveEntity":
      if (effect.regionId !== undefined) state["_regionId"] = effect.regionId;
      if (effect.pointId !== undefined) state["_pointId"] = effect.pointId;
      break;
    case "adjustRelation":
      state[`relation:${effect.targetEntityId}:${effect.key}`] = effect.value;
      break;
    case "addTag": {
      const tags = new Set(Array.isArray(state["tags"]) ? (state["tags"] as string[]) : []);
      tags.add(effect.tag);
      state["tags"] = [...tags];
      break;
    }
    case "removeTag": {
      const tags = new Set(Array.isArray(state["tags"]) ? (state["tags"] as string[]) : []);
      tags.delete(effect.tag);
      state["tags"] = [...tags];
      break;
    }
    case "appendMemoryRef": {
      const refs = Array.isArray(state["_memoryRefs"]) ? (state["_memoryRefs"] as string[]) : [];
      state["_memoryRefs"] = [...refs, effect.memoryId ?? effect.text ?? ""].filter(Boolean);
      break;
    }
    case "attachNarrativeEntry": {
      const entries = typeof state["_narrativeEntries"] === "object" && state["_narrativeEntries"] !== null && !Array.isArray(state["_narrativeEntries"])
        ? (state["_narrativeEntries"] as Record<string, { text: string; closed: boolean }>)
        : {};
      const entryKey = `entry-${Object.keys(entries).length}`;
      state["_narrativeEntries"] = { ...entries, [entryKey]: { text: effect.text, closed: false } };
      break;
    }
    case "closeNarrativeEntry": {
      const entries = typeof state["_narrativeEntries"] === "object" && state["_narrativeEntries"] !== null && !Array.isArray(state["_narrativeEntries"])
        ? (state["_narrativeEntries"] as Record<string, { text: string; closed: boolean }>)
        : {};
      if (entries[effect.entryId]) state["_narrativeEntries"] = { ...entries, [effect.entryId]: { ...entries[effect.entryId], closed: true } };
      break;
    }
    case "setFlag":
      state[`flag:${effect.key}`] = effect.value ?? true;
      break;
  }
}

/**
 * 单实体时态状态投影：基线（base 字段）+ 沿分支重放截至 `at` 的账本事件。
 * - 正史（branchId null）只重放正史事件；
 * - IF 分支：先重放正史事件（祖先账本截至 fork 的完整化在 R5-03，这里先给正史全量 + 本分支覆盖），
 *   再按 `at`、`sequence`、来源优先级确定性排序叠加本分支事件；
 * - 纯函数、可重放：同输入必然同结果。
 */
export function projectEntityState(
  world: World,
  entityId: string,
  branchId: string | null,
  at: number,
): Record<string, TemporalValue> {
  const entity = entityRecordById(world, entityId);
  if (!entity) return {};
  const state: Record<string, TemporalValue> = {};
  // 1. 基线：base 字段直接可见
  for (const key of Object.keys(entity.baseline)) {
    state[key] = entity.baseline[key] as TemporalValue;
  }
  // 2. 按**唯一谱系**重放（A24-F05）：
  //    - 祖先（含正史与每一层父 IF）都按 min(fork anchor, 查看时刻) 截断；
  //    - 之前这里只拼「正史 + 本线」，子 IF 会漏掉父 IF 的变化，且分歧前查看会读到正史未来。
  const { segments } = branchLineage(world, branchId, at);
  const replay: StateEvent[] = [];
  for (const segment of segments) {
    const cutoff = segment.cutoffAt ?? at;
    const canonSegment = segment.branchId === null;
    const events = stateEventsOf(world)
      .filter((e) => (canonSegment
        ? isCanonLedgerBranch(world, e.branchId)
        : e.branchId === segment.branchId) && e.at <= cutoff)
      .sort(compareStateEvents);
    replay.push(...events);
  }
  // 3. 依次应用（祖先先于本分支；同类内已按确定性排序）
  for (const event of replay) {
    if (!event.entityRefs.includes(entityId)) continue;
    for (const effect of event.effects) {
      if ("entityId" in effect && effect.entityId === entityId) {
        applyEffectToState(state, effect);
      }
    }
  }
  return state;
}

/** effect 的人类可读描述（变更卡 / 审阅用）。 */
export function stateEffectToDescription(world: World, effect: StateEffect): string {
  const nameOf = (id: string) => entityRecordById(world, id)?.name ?? id;
  switch (effect.kind) {
    case "setTemporalField": {
      const entity = entityRecordById(world, effect.entityId);
      const declared = entity?.temporalSchema.find((f) => f.key === effect.key);
      return `${nameOf(effect.entityId)} 的「${declared ? declared.key : effect.key}」变为 ${JSON.stringify(effect.value)}`;
    }
    case "moveEntity": {
      const to = [effect.regionId, effect.pointId].filter(Boolean).join(" / ");
      return `${nameOf(effect.entityId)} 移动到 ${to || "（未指定目的地）"}`;
    }
    case "adjustRelation":
      return `${nameOf(effect.entityId)} 与 ${nameOf(effect.targetEntityId)} 的「${effect.key}」调整为 ${JSON.stringify(effect.value)}`;
    case "addTag":
      return `${nameOf(effect.entityId)} 添加标签「${effect.tag}」`;
    case "removeTag":
      return `${nameOf(effect.entityId)} 移除标签「${effect.tag}」`;
    case "appendMemoryRef":
      return `${nameOf(effect.entityId)} 新增记忆${effect.text ? `：${effect.text}` : `（引用 ${effect.memoryId}）`}`;
    case "attachNarrativeEntry":
      return `${nameOf(effect.entityId)} 附着叙事说明`;
    case "closeNarrativeEntry":
      return `${nameOf(effect.entityId)} 关闭叙事说明 ${effect.entryId}`;
    case "setFlag":
      return `世界标记「${effect.key}」置为 ${JSON.stringify(effect.value ?? true)}`;
  }
}

// ---------------------------------------------------------------------------
// ChangeProposal：AI / 世界 Agent 的唯一输出形态
// ---------------------------------------------------------------------------

/**
 * A24-F02：effect 的**形状**校验（预览与写入共用）。
 * `StateEffect` 是联合类型，来自 AI 的 effects 实际是 `unknown[]`——
 * 之前的预览只做语义校验，形状非法的 effect（如 `setFlag.value = true` 布尔值）
 * 在预览阶段被放过，到 `appendStateEvent` 才被 parse 拒掉，于是出现「假成功」。
 * 这里用与写入完全相同的 `parseStateEffect` 规则挡住。
 */
function shapeErrorOf(effect: unknown, index: number): string | null {
  if (!effect || typeof effect !== "object") return `第 ${index + 1} 个 effect 不是对象`;
  const kind = (effect as { kind?: unknown }).kind;
  if (typeof kind !== "string") return `第 ${index + 1} 个 effect 缺少 kind`;
  if (!STATE_EFFECT_KINDS.includes(kind as StateEffect["kind"])) {
    return `第 ${index + 1} 个 effect 的 kind 未知：${kind}`;
  }
  if (parseStateEffect(effect) === null) {
    return `第 ${index + 1} 个 effect 形状非法（${kind}：${JSON.stringify(effect)}），写入后会破坏存档`;
  }
  return null;
}

/** 校验提案（采用前的 preview 步骤）；返回全部可读错误（空数组 = 可采用）。 */
export function validateChangeProposal(world: World, proposal: ChangeProposal): string[] {
  const errors: string[] = [];
  // R5-07：提案归属校验——跨世界提案拒绝；基于过期定义版本的提案要求重新生成
  if (proposal.worldId !== undefined && proposal.worldId !== world.id) {
    errors.push(`提案来自其它世界（${proposal.worldId}），不能在本世界采用`);
  }
  const latestRevision = latestDefinitionRevision(world);
  if (proposal.definitionRevisionId !== undefined && proposal.definitionRevisionId !== null) {
    if (!latestRevision || proposal.definitionRevisionId !== latestRevision.id) {
      errors.push(`提案基于过期定义版本（${proposal.definitionRevisionId}）；当前为 ${latestRevision?.id ?? "未建立"}，请重新生成`);
    }
  }
  if (!proposal.summary.trim()) errors.push("提案缺少摘要");
  if (proposal.summary.trim().length > W0_LIMITS.maxStateEventSummary) {
    errors.push(`摘要超过上限 ${W0_LIMITS.maxStateEventSummary} 字`);
  }
  if (!Number.isFinite(proposal.at)) errors.push("提案缺少合法时间（at）");
  if (proposal.branchId && !(world.stories ?? []).some((s) => s.id === proposal.branchId)) {
    errors.push(`提案分支不存在：${proposal.branchId}`);
  }
  if (proposal.effects.length === 0) errors.push("提案至少要包含一个 effect");
  if (proposal.effects.length > W0_LIMITS.maxStateEventEffects) {
    errors.push(`单条提案最多 ${W0_LIMITS.maxStateEventEffects} 个 effect`);
  }
  // A24-F02：先过形状，再过语义——形状非法的 effect 不进语义校验（避免访问不存在的属性）
  const parsed: StateEffect[] = [];
  proposal.effects.forEach((effect, index) => {
    const shapeError = shapeErrorOf(effect, index);
    if (shapeError) {
      errors.push(shapeError);
      return;
    }
    const parsedEffect = parseStateEffect(effect);
    if (parsedEffect) parsed.push(parsedEffect);
  });
  if (errors.length > 0) return errors;
  for (const effect of parsed) {
    const entityIds = new Set((world.entityRecords ?? []).map((e) => e.id));
    const issue = validateEffect(world, effect, entityIds);
    if (issue) errors.push(`${effect.kind}：${issue}`);
  }
  return errors;
}

/**
 * 采用提案：`preview（validate）→ 原子追加 StateEvent`。
 * `acceptedEffectIndexes` 支持拆分采用（只接受部分 effect）；
 * 校验失败 / 无可接受项 → 引用相等原样返回（零写入）。
 */
export function applyChangeProposal(
  world: World,
  proposal: ChangeProposal,
  opts: { acceptedEffectIndexes?: number[]; now?: number; source?: StateEvent["source"] } = {},
): DefinitionResult<World> & { appliedEventId?: string } {
  const acceptedIndexes = (opts.acceptedEffectIndexes ?? proposal.effects.map((_, i) => i))
    .filter((i, idx, arr) => arr.indexOf(i) === idx)
    .filter((i) => i >= 0 && i < proposal.effects.length);
  if (acceptedIndexes.length === 0) {
    return { ok: true, value: world };
  }
  const partial: ChangeProposal = { ...proposal, effects: acceptedIndexes.map((i) => proposal.effects[i]) };
  const errors = validateChangeProposal(world, partial);
  if (errors.length > 0) {
    return { ok: false, error: `提案校验失败：${errors.join("；")}` };
  }
  // A24-F02：写入的是**解析后**的规范形状，而不是 AI 原始对象——
  // 额外字段 / 类型抖动不会进入存档，也保证 parse 往返预检必定通过。
  const effects: StateEffect[] = [];
  for (const raw of partial.effects) {
    const parsed = parseStateEffect(raw);
    if (!parsed) return { ok: false, error: `提案校验失败：effect 形状非法（${JSON.stringify(raw)}）` };
    effects.push(parsed);
  }
  const touched = new Set<string>();
  for (const effect of effects) {
    if ("entityId" in effect) touched.add(effect.entityId);
  }
  const appended = appendStateEvent(world, {
    branchId: partial.branchId,
    at: partial.at,
    source: opts.source ?? "ai-adopted",
    narrativeSummary: partial.summary,
    effects,
    entityRefs: [...touched],
    sessionId: partial.id,
  }, { now: opts.now ?? 0 });
  if (!appended.ok) return appended;
  const event = appended.value.stateEvents?.[appended.value.stateEvents.length - 1];
  return { ok: true, value: appended.value, appliedEventId: event?.id };
}

// ---------------------------------------------------------------------------
// A24-F01 / A24-F02：提案来源绑定 + 批量原子采用
//
// 纪律（PLAY-01）：
//  - 请求创建时就固定来源（世界 / 世界线 / 定义版本 / 请求 ID），采用时**核对**，
//    绝不许在响应到达或采用时用「当前世界 / 最新版本」补写归属；
//  - 预览与采用共用同一份校验（形状 + 语义 + 来源），不存在「预览可选、采用失败」；
//  - 一次批量采用是一个明确提交单元：整单成功才发布新世界，否则零写入并给出逐项原因。
// ---------------------------------------------------------------------------

/** 提案生成时钉住的来源；采用时逐项核对。 */
export interface ChangeProposalOrigin {
  worldId: string;
  worldName?: string;
  /** 生成时所在世界线（正史 null / IF storyId）；仅记录来源，不覆盖提案自身 branchId */
  branchId: string | null;
  definitionRevisionId: string | null;
  requestId: string;
  createdAt?: number;
}

/** 待审提案（effects 保留 AI 原始形态，校验在预览 / 采用时统一执行）。 */
export interface PendingChangeProposal {
  id: string;
  summary: string;
  at: number;
  branchId: string | null;
  effects: unknown[];
  origin: ChangeProposalOrigin;
  selected: boolean;
}

export interface ProposalAdoptionItem {
  proposalId: string;
  summary: string;
  ok: boolean;
  error?: string;
  eventId?: string;
}

export interface ProposalAdoptionResult {
  /** 整单成功才是新世界；任何一项失败 → 引用相等返回入参（零写入）。 */
  world: World;
  ok: boolean;
  adopted: ProposalAdoptionItem[];
  rejected: ProposalAdoptionItem[];
  error?: string;
}

/** 待审提案 → ChangeProposal：归属取自 origin，绝不取「当前世界」。 */
export function toChangeProposal(pending: PendingChangeProposal): ChangeProposal {
  return {
    id: pending.id,
    summary: pending.summary,
    at: pending.at,
    branchId: pending.branchId,
    effects: pending.effects as StateEffect[],
    worldId: pending.origin.worldId,
    definitionRevisionId: pending.origin.definitionRevisionId,
  };
}

/**
 * 提案将写入的账本事件 id（内容级确定性）。
 * 该 id 已存在于账本 ⇒ 这条变化已经入过账：双击 / 重复提交不再写第二次，
 * 也不把它算作失败（返回已存在的事件 id）。
 */
export function proposalEventId(
  world: World,
  pending: PendingChangeProposal,
  source: StateEvent["source"] = "ai-adopted",
): string | null {
  const effects: StateEffect[] = [];
  for (const raw of pending.effects ?? []) {
    const parsed = parseStateEffect(raw);
    if (!parsed) return null;
    effects.push(parsed);
  }
  const summary = (pending.summary ?? "").trim();
  if (!summary || effects.length === 0) return null;
  return stateEventContentId(world, {
    branchId: pending.branchId ?? null,
    at: pending.at,
    source,
    narrativeSummary: summary,
    effects,
  });
}

/** 来源核对：世界 / 定义版本不符 → 可见拒绝，绝不静默改归属。 */
export function validateProposalOrigin(world: World, pending: PendingChangeProposal): string[] {
  const errors: string[] = [];
  const origin = pending.origin;
  if (!origin || typeof origin.worldId !== "string" || origin.worldId.length === 0) {
    errors.push("提案缺少来源世界信息，不能采用（请重新生成提案）");
  } else if (origin.worldId !== world.id) {
    errors.push(`提案来自其它世界（${origin.worldName ?? origin.worldId}），不能写入当前世界`);
  }
  const latest = latestDefinitionRevision(world);
  const pinned = origin ? origin.definitionRevisionId : null;
  if (pinned === null || pinned === undefined) {
    if (latest) errors.push(`提案未记录定义版本；当前为 ${latest.id}，请重新生成`);
  } else if (!latest || pinned !== latest.id) {
    errors.push(`提案基于过期定义版本（${pinned}）；当前为 ${latest?.id ?? "未建立"}，请重新生成`);
  }
  return errors;
}

/** 预览校验 = 来源核对 + 完整结构 / 语义校验（与采用完全一致）。 */
export function validatePendingProposal(world: World, pending: PendingChangeProposal): string[] {
  const originErrors = validateProposalOrigin(world, pending);
  if (originErrors.length > 0) return originErrors;
  return validateChangeProposal(world, toChangeProposal(pending));
}

function notSubmitted(item: ProposalAdoptionItem, reason: string): ProposalAdoptionItem {
  return { ...item, ok: false, error: reason };
}

/**
 * 批量原子采用所选提案。
 * - 先整单预检：任何一项不合法 → 全部不写（不发布部分成功的权威世界状态）；
 * - 再顺序追加：任一追加失败（账本容量 / 持久化预检）→ 丢弃候选，零写入；
 * - 返回逐项结果，调用方据此决定哪些草稿可以移出待审区。
 */
export function adoptPendingProposals(
  world: World,
  pendings: PendingChangeProposal[],
  opts: { now?: number; source?: StateEvent["source"] } = {},
): ProposalAdoptionResult {
  if (pendings.length === 0) return { world, ok: true, adopted: [], rejected: [] };

  const rejected: ProposalAdoptionItem[] = [];
  const prepared: Array<{ pending: PendingChangeProposal; proposal: ChangeProposal }> = [];
  for (const pending of pendings) {
    const errors = validatePendingProposal(world, pending);
    if (errors.length > 0) {
      rejected.push({ proposalId: pending.id, summary: pending.summary, ok: false, error: errors.join("；") });
      continue;
    }
    prepared.push({ pending, proposal: toChangeProposal(pending) });
  }
  if (rejected.length > 0) {
    const reason = "同批存在被拒绝的提案，整单未提交";
    return {
      world,
      ok: false,
      adopted: [],
      rejected: [
        ...rejected,
        ...prepared.map((entry) => ({
          proposalId: entry.pending.id,
          summary: entry.pending.summary,
          ok: false,
          error: reason,
        })),
      ],
      error: `整单未提交：${rejected.length} 条校验失败（草稿保留，可修改后重试）。`,
    };
  }

  const source: StateEvent["source"] = opts.source ?? "ai-adopted";
  let candidate = world;
  const adopted: ProposalAdoptionItem[] = [];
  for (const entry of prepared) {
    // 幂等：这条变化已经入过账（双击 / 重复提交）→ 不再写第二次，也不算失败
    const existingId = proposalEventId(candidate, entry.pending, source);
    if (existingId && (candidate.stateEvents ?? []).some((e) => e.id === existingId)) {
      adopted.push({ proposalId: entry.pending.id, summary: entry.pending.summary, ok: true, eventId: existingId });
      continue;
    }
    const result = applyChangeProposal(candidate, entry.proposal, {
      now: opts.now ?? 0,
      source,
    });
    if (!result.ok) {
      const failure = result.error ?? "写入失败";
      const reason = `同批存在失败项，整单未提交（${failure}）`;
      return {
        world,
        ok: false,
        adopted: [],
        rejected: [
          ...adopted.map((item) => notSubmitted(item, reason)),
          { proposalId: entry.pending.id, summary: entry.pending.summary, ok: false, error: failure },
          ...prepared.slice(adopted.length + 1).map((rest) => ({
            proposalId: rest.pending.id,
            summary: rest.pending.summary,
            ok: false,
            error: reason,
          })),
        ],
        error: `整单未提交：${failure}`,
      };
    }
    candidate = result.value;
    adopted.push({
      proposalId: entry.pending.id,
      summary: entry.pending.summary,
      ok: true,
      eventId: result.appliedEventId,
    });
  }
  return { world: candidate, ok: true, adopted, rejected: [] };
}

/** 审阅明细：把 AI 原始 effects 变成可核对的「目标 / 字段 / 值」描述。 */
export function describeEffectCandidates(world: World, effects: unknown[]): string[] {
  return (effects ?? []).map((raw, index) => {
    const parsed = parseStateEffect(raw);
    if (!parsed) {
      const kind = raw && typeof raw === "object" ? String((raw as { kind?: unknown }).kind) : typeof raw;
      return `第 ${index + 1} 项：无法识别的修改（${kind}）：${JSON.stringify(raw)}`;
    }
    return `第 ${index + 1} 项：${stateEffectToDescription(world, parsed)}`;
  });
}

/** 账本重放可复现性：同一输入的投影 hash（R5-03 全量投影复用）。 */
export function stateProjectionHash(value: unknown): string {
  return `proj-${hashString(JSON.stringify(value))}`;
}
