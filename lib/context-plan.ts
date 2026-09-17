// R5-06｜ContextPlan：请求前由本地确定性逻辑生成的上下文装配单（纯函数层）
//
// 职责（来自 待办计划README.md R5-06 工作包）：
// - 在发送前列出：世界 / 定义版本、分支与时间、世界书条目、地区 / 地点、实体
//   （时态字段按声明过滤 private）、记忆、账本摘要、角色视角、字符预算与被截断来源；
// - 核心分支 / 时间过滤（绝不泄露锚点后正史、兄弟线、正史未来）在计划内固定，
//   不得被 UI 绕过；作者只能排除**可选**资料（世界书条目 / 实体 / 记忆）；
// - 未采用扮演草稿**永不**进入计划；
// - 确定性：同输入同计划（hash 可复现）；预算只做截断并标注，不偷偷丢弃。
//
// 纯函数：无 React、无 DOM、0 fetch、0 Date.now。

import type { World } from "./world-schema.ts";
import { W0_LIMITS } from "./world-schema.ts";
import { hashString } from "./world-cards.ts";
import { resolveWorldProjection } from "./world-projection.ts";
import { definitionRevisionFor } from "./world-definition.ts";
import { ledgerForBranch } from "./world-ledger.ts";
import { branchLineage } from "./world-lineage.ts";

export interface ContextPlanInput {
  purpose: string;
  branchId: string | null;
  at: number;
  /** 临时排除的可选来源 id（世界书条目 / 实体 / 记忆）；核心分支 / 时间过滤不受影响 */
  excludeSourceIds?: string[];
  /** 字符预算（缺省用网关默认预算） */
  budgetChars?: number;
}

export interface ContextPlanSource {
  id: string;
  title: string;
  kind: "worldBook" | "entity" | "memory" | "region" | "point";
}

export interface ContextPlan {
  purpose: string;
  worldId: string;
  branchId: string | null;
  at: number;
  definitionRevisionId: string | null;
  /** 可选来源清单（作者可临时排除） */
  sources: ContextPlanSource[];
  excludedSourceIds: string[];
  /** 实体时态字段的可见值（private 已按声明过滤） */
  entities: Array<{ id: string; name: string; temporal: Record<string, string | number | boolean | string[]> }>;
  /** 记忆引用（按分支与时间过滤） */
  memories: Array<{ id: string; characterId: string; at: number }>;
  /** 账本摘要（最近 N 条，含来源链） */
  ledger: Array<{ id: string; at: number; source: string; summary: string }>;
  /** 世界标记 */
  flags: Record<string, string | boolean>;
  viewpoint: string | null;
  budgetChars: number;
  truncatedSources: string[];
  /** 计划 hash（同输入必同） */
  hash: string;
}

const LEDGER_SUMMARY_COUNT = 10;

export interface MemoryScope {
  branchId: string | null;
  cutoffAt: number;
}

/**
 * R5-RC-03：记忆可见作用域——沿分支祖先链（fork anchor 截断）推导每个分支段的
 * (branchId, cutoffAt)。锚点后的正史记忆、兄弟 IF 记忆天然被排除。
 */
export function memoryScopesFor(world: World, branchId: string | null, at: number): MemoryScope[] {
  // A24-F07：这里曾经内联了一份谱系回溯（与 branchLineage 重复，且有同样的
  // 「祖先截止不受查看时刻约束」缺陷——分歧前查看会放进正史未来的记忆）。
  // 现在直接复用唯一谱系：祖先截止 = min(fork anchor, at)。
  return branchLineage(world, branchId, at).segments.map((segment) => ({
    branchId: segment.branchId,
    cutoffAt: segment.cutoffAt ?? at,
  }));
}

/**
 * 构建上下文装配单。确定性：同一 world / 输入永远得到同一计划。
 * 分支 / 时间过滤基于 `resolveWorldProjection`（祖先账本按 fork anchor 截断），
 * 私有字段按 `temporalSchema.kind === "private"` 且未显式授权时排除。
 */
export function buildContextPlan(world: World, input: ContextPlanInput): ContextPlan {
  const excluded = new Set(input.excludeSourceIds ?? []);
  const budgetChars = input.budgetChars ?? 12000;
  const projection = resolveWorldProjection(world, {
    worldId: world.id,
    branchId: input.branchId,
    at: input.at,
  });
  // R5-RC-01：使用该时点的权威定义修订（旧数据无快照 → 回退实时实体并置 approx）
  const definitionSelection = definitionRevisionFor(world, input.at, input.branchId ?? null);
  const snapshotEntities = definitionSelection.revision?.snapshot?.entities ?? null;

  // 1. 可选来源：世界书（启用条目）
  const sources: ContextPlanSource[] = [];
  for (const entry of world.worldBible ?? []) {
    if (entry.enabled === false || excluded.has(entry.id)) continue;
    sources.push({ id: entry.id, title: entry.title, kind: "worldBook" });
  }
  // 2. 地区 / 地点（当前投影锚点所在地区；信息性来源，不可排除）
  const regionId = world.currentRegionId ?? null;
  const region = (world.regions ?? []).find((r) => r.id === regionId);
  if (region) sources.push({ id: region.id, title: region.name, kind: "region" });
  const points = (world.points ?? []).filter((p) => !regionId || p.regionId === regionId).slice(0, 12);
  for (const point of points) sources.push({ id: String(point.id), title: point.name, kind: "point" });

  // 3. 实体：时态字段按声明过滤（private 不进 AI），值来自投影
  const entities: ContextPlan["entities"] = [];
  const entitySource = snapshotEntities ?? world.entityRecords ?? [];
  for (const entity of entitySource) {
    if (excluded.has(entity.id)) continue;
    const state = projection.entityStates[entity.id] ?? {};
    const temporal: Record<string, string | number | boolean | string[]> = {};
    for (const field of entity.temporalSchema) {
      if (field.kind === "private" && field.entersAI !== true) continue;
      if (field.kind === "base") continue;
      const value = state[field.key];
      if (value === undefined) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        temporal[field.key] = value;
      } else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
        temporal[field.key] = value as string[];
      }
    }
    entities.push({ id: entity.id, name: entity.name, temporal });
    sources.push({ id: entity.id, title: entity.name, kind: "entity" });
  }

  // 4. 记忆（R5-RC-03：按完整祖先链 + fork anchor + branchId + at 过滤——
  // 锚点后的正史记忆、兄弟 IF 记忆、子线未来记忆一律不得进入）
  const allowed = memoryScopesFor(world, input.branchId, input.at);
  const memories = (world.characterMemories ?? [])
    .filter((m) => {
      const mBranch = m.branchId ?? null;
      if (excluded.has(m.id)) return false;
      if (m.at > input.at) return false;
      return allowed.some((scope) => scope.branchId === mBranch && m.at <= scope.cutoffAt);
    })
    .slice(0, W0_LIMITS.maxRoleplayContextTitles)
    .map((m) => ({ id: m.id, characterId: m.characterId, at: m.at }));
  for (const m of memories) sources.push({ id: m.id, title: `记忆@${m.at}`, kind: "memory" });

  // 5. 账本摘要（本分支最近 N 条；正史祖先链已在 projection.sourceChain）
  const ledger = ledgerForBranch(world, input.branchId ?? null)
    .filter((e) => e.at <= input.at)
    .slice(-LEDGER_SUMMARY_COUNT)
    .map((e) => ({ id: e.id, at: e.at, source: e.source, summary: e.narrativeSummary }));

  // 6. 视角
  const session = (world.agentSessions ?? []).find((s) => s.storyId === (input.branchId ?? ""));
  const viewpoint = session?.viewpointCharacterId
    ? (world.characters ?? []).find((c) => c.id === session.viewpointCharacterId)?.name ?? null
    : null;

  const plan: ContextPlan = {
    purpose: input.purpose,
    worldId: world.id,
    branchId: input.branchId,
    at: input.at,
    definitionRevisionId: definitionSelection.revision?.id ?? null,
    sources,
    excludedSourceIds: [...excluded],
    entities,
    memories,
    ledger,
    flags: projection.flags,
    viewpoint,
    budgetChars,
    truncatedSources: [],
    hash: "",
  };
  plan.hash = `plan-${hashString(JSON.stringify({ ...plan, hash: undefined }))}`;
  return plan;
}

// ---------------------------------------------------------------------------
// A24-F07：请求上下文的唯一编译入口
//
// 之前每个请求入口各自拼 `contextText`，再另外构造一个 ContextPlan 的 hash
// ——hash 与真正发出的内容无关（「旧内容配新 hash」）。现在预览、实际发送文本
// 与非秘密校验值都由同一份计划一次算出。
// ---------------------------------------------------------------------------

export interface RequestContextInput extends ContextPlanInput {
  /** 用途正文（叙事上下文 / 提示正文 / 用户问题）；与装配单拼成最终发送文本 */
  narrativeText?: string;
  /** 装配单之外的来源 id（如扮演锚点事件） */
  extraSourceIds?: string[];
}

export interface RequestContext {
  plan: ContextPlan;
  /** 预览与发送**同一份**文本（先装配单，再用途正文） */
  text: string;
  sourceIds: string[];
  /** 覆盖「计划 + 最终文本」的非秘密校验值；只断言它存在不算验收 */
  hash: string;
}

/**
 * 编译一次请求要发出去的上下文。
 * 确定性：同一 (world, input) 永远得到同一份 plan / text / hash。
 * 纯函数：0 fetch、0 Date.now。
 */
export function compileRequestContext(world: World, input: RequestContextInput): RequestContext {
  const plan = buildContextPlan(world, input);
  const narrative = (input.narrativeText ?? "").trim();
  const text = narrative ? `${renderContextPlan(plan)}\n\n${narrative}` : renderContextPlan(plan);
  const sourceIds = [...new Set([
    ...plan.sources.map((s) => s.id),
    ...(input.extraSourceIds ?? []),
  ])].slice(0, 40);
  // 校验值必须覆盖**真正发出的文本**：改了 text 就一定换 hash（杜绝旧内容配新 hash）
  return { plan, text, sourceIds, hash: `plan-${hashString(`${plan.hash}|${text}`)}` };
}

/** 模块请求（故事续写 / 检索 / 分析）的「当前世界时刻」：账本里最新事件的时间，无事件则世界纪年。 */
export function moduleRequestAt(world: World): number {
  const events = world.stateEvents ?? [];
  const latest = events.length ? Math.max(...events.map((e) => e.at)) : (world.currentYear ?? 0);
  return Math.max(0, latest);
}

export interface ModuleContextSpec {
  purpose: "story" | "search" | "analysis";
  /** 模块面板显式选中的故事线（仅 story 用途生效） */
  moduleStoryId?: string | null;
  /** 当前打开的故事线（未显式选中时的兜底） */
  openStoryId?: string | null;
}

/**
 * 模块请求上下文输入的唯一来源。
 *
 * 预览面板与实际发送必须都走这里：之前两边各自拼 `at` / `branchId`，且预览的
 * 「临时排除资料」根本没传给发送路径 —— 预览里排除了，发出去的还是完整内容。
 */
export function moduleRequestInput(
  world: World,
  spec: ModuleContextSpec,
  options: { narrativeText?: string; extraSourceIds?: string[]; excludeSourceIds?: string[]; branchId?: string | null; at?: number } = {},
): RequestContextInput {
  // PLAY-02/03：调用方给了查看范围（分支 / 时刻）就照用——装配单的「分支・时刻」必须与
  // 地图 / 时间轴 / 阅读器看到的是同一份，不能各自去猜「最新账本事件」这种跨分支的全局值。
  const branchId = options.branchId !== undefined
    ? options.branchId
    : (spec.purpose === "story" && spec.moduleStoryId ? spec.moduleStoryId : (spec.openStoryId ?? null));
  const at = options.at !== undefined && Number.isFinite(options.at) ? options.at : moduleRequestAt(world);
  return {
    purpose: spec.purpose,
    branchId,
    at,
    ...(options.narrativeText ? { narrativeText: options.narrativeText } : {}),
    ...(options.extraSourceIds && options.extraSourceIds.length ? { extraSourceIds: options.extraSourceIds } : {}),
    ...(options.excludeSourceIds && options.excludeSourceIds.length ? { excludeSourceIds: options.excludeSourceIds } : {}),
  };
}

/** 渲染为有界文本（发给网关的 contextText 或 UI 预览）。超预算只截断并标注。 */
export function renderContextPlan(plan: ContextPlan): string {
  const lines: string[] = [];
  lines.push(`【上下文装配单 · ${plan.purpose}】`);
  lines.push(`世界 ${plan.worldId} · 分支 ${plan.branchId ?? "正史"} · 时刻 ${plan.at} · 定义版本 ${plan.definitionRevisionId ?? "未建立"}`);
  if (plan.viewpoint) lines.push(`视角人物：${plan.viewpoint}`);
  const included = plan.sources.filter((s) => !plan.excludedSourceIds.includes(s.id));
  for (const source of included) {
    if (source.kind === "entity") {
      const entity = plan.entities.find((e) => e.id === source.id);
      if (entity && Object.keys(entity.temporal).length > 0) {
        lines.push(`实体 ${entity.name}：${Object.entries(entity.temporal).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("，")}`);
      }
    } else if (source.kind === "worldBook") {
      lines.push(`世界书：${source.title}`);
    }
  }
  if (plan.memories.length > 0) {
    lines.push(`记忆引用 ${plan.memories.length} 条（按分支与时间过滤）。`);
  }
  if (plan.ledger.length > 0) {
    lines.push("最近账本：");
    for (const entry of plan.ledger) {
      lines.push(`- ${entry.at}（${entry.source}）：${entry.summary}`);
    }
  }
  const flags = Object.entries(plan.flags);
  if (flags.length > 0) lines.push(`世界标记：${flags.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("，")}`);
  lines.push("未采用草稿与密钥永不进入本计划。");
  const text = lines.join("\n");
  if (text.length <= plan.budgetChars) return text;
  return `${text.slice(0, plan.budgetChars)}\n【已截断：超出 ${plan.budgetChars} 字符预算】`;
}
