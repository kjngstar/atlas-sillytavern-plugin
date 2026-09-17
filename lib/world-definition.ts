// R5-01｜世界定义版本、实体目录与「静态 / 可变」字段（纯函数层）
//
// 职责（来自 待办计划README.md R5-01 工作包）：
// - 定义修订：作者修订设定 → 追加 `DefinitionRevision`（追加式，旧修订绝不覆写；
//   检查点在 R5-04 记录创建时的 definitionRevisionId，跨历史 retcon 必须显式标记）。
// - 实体目录：城市 / 人物 / 组织 / 物品等稳定身份 + 基线字段 + 时态字段声明；
//   时态字段的**值**只能来自 R5-02 的事件账本，绝不写进基线。
// - 删除影响：删除基础实体前给出其被引用的影响面（地点 / 事件 / 故事线 / 锚点 /
//   人物状态 / 账本行动）。
//
// 纯函数：无 React、无 DOM、0 fetch、0 Date.now（时间由 opts.now 注入）；
// 返回新 World，不修改入参；非法输入返回可读错误，绝不抛出半截写入。

import type { DefinitionRevision, DefinitionSnapshot, EntityRecord, EntityTemporalField, World } from "./world-schema.ts";
import { W0_LIMITS } from "./world-schema.ts";
import { hashString } from "./world-cards.ts";

// ---------------------------------------------------------------------------
// 1. 结果类型
// ---------------------------------------------------------------------------

export type DefinitionResult<T> = { ok: true; value: T } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// 2. 定义修订
// ---------------------------------------------------------------------------

function latestRevision(world: World): DefinitionRevision | null {
  const list = world.definitionRevisions ?? [];
  return list.length > 0 ? list[list.length - 1] : null;
}

/** 取最新定义修订（没有则为 null）。 */
export function latestDefinitionRevision(world: World): DefinitionRevision | null {
  return latestRevision(world);
}

/** 按 id 取定义修订。 */
export function definitionRevisionById(world: World, id: string): DefinitionRevision | null {
  return (world.definitionRevisions ?? []).find((r) => r.id === id) ?? null;
}

/**
 * R5-RC-01：捕获定义内容的不可变快照（世界书全文 / 地区 / 地点 / 规则 / 实体基线与声明）。
 * 修订创建时一次性调用；此后同 ID 条目的后续编辑不会改变快照内容与 hash。
 */
export function captureDefinitionSnapshot(world: World): DefinitionSnapshot {
  const snapshot: DefinitionSnapshot = {
    worldBible: JSON.parse(JSON.stringify(world.worldBible ?? [])),
    regions: JSON.parse(JSON.stringify(world.regions ?? [])),
    points: JSON.parse(JSON.stringify(world.points ?? [])),
    globalPrompt: world.globalPrompt ?? null,
    triggers: JSON.parse(JSON.stringify(world.triggers ?? [])),
    entities: JSON.parse(JSON.stringify(world.entityRecords ?? [])),
    contentHash: "",
  };
  snapshot.contentHash = `defsnap-${hashString(JSON.stringify(snapshot))}`;
  return snapshot;
}

/**
 * R5-RC-01：按世界时刻与分支选择权威定义修订。
 * 规则：在 (effectiveAt ?? 0) ≤ at 且生效分支匹配的修订中，取 effectiveAt 最大者
 * （并列取 createdAt 更晚者）。没有任何修订生效时返回 null 并置 approx（投影 / 计划
 * 必须诚实标注，而不是静默读最新定义）。
 */
export function definitionRevisionFor(
  world: World,
  at: number,
  branchId: string | null = null,
): { revision: DefinitionRevision | null; approx: boolean; reason: string | null } {
  const candidates = (world.definitionRevisions ?? [])
    .filter((r) => (r.effectiveAt ?? 0) <= at)
    .filter((r) => !r.effectiveBranchId || r.effectiveBranchId === branchId);
  if (candidates.length === 0) {
    const anyRevision = (world.definitionRevisions ?? [])[0] ?? null;
    return {
      revision: anyRevision,
      approx: true,
      reason: anyRevision
        ? `世界时刻 ${at} 早于最早的定义生效点（最早 effectiveAt=${anyRevision.effectiveAt ?? 0}）；使用最早修订并标注近似`
        : "世界没有任何定义修订记录；实体基线以当前资料为准并标注近似",
    };
  }
  const selected = [...candidates].sort((a, b) => {
    const ea = a.effectiveAt ?? 0;
    const eb = b.effectiveAt ?? 0;
    if (ea !== eb) return ea - eb;
    return a.createdAt - b.createdAt;
  }).pop() ?? null;
  return { revision: selected, approx: false, reason: null };
}

function collectDefinitionRefs(world: World): {
  baseWorldbookRefs: string[];
  mapRefs: string[];
  ruleRefs: string[];
  entityBaselineRefs: string[];
} {
  return {
    baseWorldbookRefs: (world.worldBible ?? []).map((e) => e.id),
    mapRefs: [
      ...((world.mapImage ? ["map-image"] : []) as string[]),
      ...(world.travelSettings ? ["travel-settings"] : []),
      ...(world.regions ?? []).map((r) => r.id),
    ],
    ruleRefs: [
      ...(world.globalPrompt ? ["global-prompt"] : []),
      ...(world.triggers ?? []).map((t) => t.id),
    ],
    entityBaselineRefs: (world.entityRecords ?? []).map((e) => e.id),
  };
}

/**
 * 创建初始定义修订（为尚无修订史的世界建立基线；幂等不重复）。
 * 引用集来自当前世界的世界书 / 地图 / 规则 / 实体基线。
 */
export function createInitialDefinitionRevision(
  world: World,
  opts: { now: number; authorNote?: string },
): DefinitionResult<World> {
  if ((world.definitionRevisions ?? []).length > 0) {
    return { ok: true, value: world };
  }
  const refs = collectDefinitionRefs(world);
  const revision: DefinitionRevision = {
    id: `defrev-${hashString(`${world.id}|initial|${opts.now}`)}`,
    worldId: world.id,
    createdAt: opts.now,
    authorNote: opts.authorNote?.trim() || "初始定义基线",
    ...refs,
    effectiveAt: 0,
    snapshot: captureDefinitionSnapshot(world),
  };
  return { ok: true, value: { ...world, definitionRevisions: [revision] } };
}

/**
 * 追加一条定义修订（「编辑基础设定」命令的唯一写入口）。
 * - 追加式：旧修订保持字节不变；新修订 parentRevisionId 指向此前最新修订；
 * - `isRetcon` 必须由作者显式传入（跨历史改设定绝不静默）；
 * - `changedEntityIds`：本次修订涉及的实体基线（可选，供影响范围展示）；
 * - 修订数量超上限时拒绝，绝不静默丢弃历史。
 */
export function appendDefinitionRevision(
  world: World,
  opts: {
    authorNote: string;
    now: number;
    changedEntityIds?: string[];
    isRetcon?: boolean;
    /** R5-RC-01：世界内生效时间（缺省 0 = 自世界起点生效） */
    effectiveAt?: number;
    /** 生效分支（缺省 = 全部分支） */
    effectiveBranchId?: string | null;
  },
): DefinitionResult<World> {
  const note = opts.authorNote.trim();
  if (!note) return { ok: false, error: "修订说明不能为空" };
  if (note.length > W0_LIMITS.maxRevisionNote) {
    return { ok: false, error: `修订说明超过上限 ${W0_LIMITS.maxRevisionNote} 字` };
  }
  const list = world.definitionRevisions ?? [];
  if (list.length >= W0_LIMITS.maxDefinitionRevisions) {
    return { ok: false, error: `定义修订数量已达上限（${W0_LIMITS.maxDefinitionRevisions}）；请先归档或压缩历史` };
  }
  const knownEntityIds = new Set((world.entityRecords ?? []).map((e) => e.id));
  for (const entityId of opts.changedEntityIds ?? []) {
    if (!knownEntityIds.has(entityId)) {
      return { ok: false, error: `修订引用了不存在的实体：${entityId}` };
    }
  }
  if (opts.effectiveAt !== undefined && (!Number.isFinite(opts.effectiveAt) || opts.effectiveAt < 0)) {
    return { ok: false, error: "生效时间必须是非负的世界内时间" };
  }
  if (opts.effectiveBranchId && !(world.stories ?? []).some((st) => st.id === opts.effectiveBranchId)) {
    return { ok: false, error: `生效分支不存在：${opts.effectiveBranchId}` };
  }
  const parent = latestRevision(world);
  const revision: DefinitionRevision = {
    id: `defrev-${hashString(`${world.id}|${list.length}|${note}|${opts.now}`)}`,
    worldId: world.id,
    createdAt: opts.now,
    authorNote: note,
    ...(opts.changedEntityIds?.length ? { entityBaselineRefs: [...opts.changedEntityIds] } : {}),
    ...(parent ? { parentRevisionId: parent.id } : {}),
    ...(opts.isRetcon ? { isRetcon: true } : {}),
    effectiveAt: opts.effectiveAt ?? 0,
    ...(opts.effectiveBranchId ? { effectiveBranchId: opts.effectiveBranchId } : {}),
    snapshot: captureDefinitionSnapshot(world),
  };
  return { ok: true, value: { ...world, definitionRevisions: [...list, revision] } };
}

// ---------------------------------------------------------------------------
// 3. 实体目录
// ---------------------------------------------------------------------------

/** 取实体；不存在返回 null。 */
export function entityRecordById(world: World, entityId: string): EntityRecord | null {
  return (world.entityRecords ?? []).find((e) => e.id === entityId) ?? null;
}

/** 时态字段是否可进入 AI 上下文（private 缺省不可；显式声明优先）。 */
export function fieldEntersAI(field: EntityTemporalField): boolean {
  return field.entersAI ?? field.kind !== "private";
}

/** 时态字段是否可进入时间轴（temporal / computed 缺省可；base / private 缺省不可）。 */
export function fieldEntersTimeline(field: EntityTemporalField): boolean {
  return field.entersTimeline ?? (field.kind === "temporal" || field.kind === "computed");
}

function validateEntity(world: World, entity: EntityRecord): string | null {
  if (entity.worldId !== world.id) return "实体的 worldId 与当前世界不一致";
  if (!entity.type.trim()) return "实体类型不能为空";
  if (!entity.name.trim()) return "实体名称不能为空";
  const keys = new Set<string>();
  for (const field of entity.temporalSchema) {
    if (keys.has(field.key)) return `字段声明重复：${field.key}`;
    keys.add(field.key);
  }
  for (const key of Object.keys(entity.baseline)) {
    const declared = entity.temporalSchema.find((f) => f.key === key);
    if (!declared) return `基线字段 ${key} 未在字段声明中登记`;
    if (declared.kind === "temporal") {
      return `字段 ${key} 是时态字段：其值只能由「登记世界变化」产生（R5-02 账本），不能写进基线。如确属设定修订，请改为 base 字段或通过定义修订调整声明`;
    }
    const value = entity.baseline[key];
    if (declared.valueType === "string" && typeof value !== "string") return `字段 ${key} 应为字符串`;
    if (declared.valueType === "number" && typeof value !== "number") return `字段 ${key} 应为数字`;
    if (declared.valueType === "boolean" && typeof value !== "boolean") return `字段 ${key} 应为布尔值`;
    if (declared.valueType === "string[]" && !(Array.isArray(value) && value.every((v) => typeof v === "string"))) {
      return `字段 ${key} 应为字符串数组`;
    }
  }
  for (const temporal of entity.temporalSchema.filter((f) => f.kind === "temporal")) {
    if (temporal.key in entity.baseline) {
      return `时态字段 ${temporal.key} 不能有基线值`;
    }
  }
  if (entity.mapAnchor?.regionId && !(world.regions ?? []).some((r) => r.id === entity.mapAnchor?.regionId)) {
    return `地图锚点引用了不存在的地区：${entity.mapAnchor.regionId}`;
  }
  if (entity.mapAnchor?.pointId && !(world.points ?? []).some((p) => String(p.id) === String(entity.mapAnchor?.pointId))) {
    return `地图锚点引用了不存在的地点：${entity.mapAnchor.pointId}`;
  }
  return null;
}

/** 新建 / 更新实体（按 id 幂等 upsert；更新不改 id 与 createdAt）。 */
export function upsertEntityRecord(
  world: World,
  entity: EntityRecord,
  opts: { now: number } = { now: 0 },
): DefinitionResult<World> {
  const invalid = validateEntity(world, entity);
  if (invalid) return { ok: false, error: invalid };
  const list = world.entityRecords ?? [];
  if (!list.some((e) => e.id === entity.id) && list.length >= W0_LIMITS.maxEntityRecords) {
    return { ok: false, error: `实体数量已达上限（${W0_LIMITS.maxEntityRecords}）` };
  }
  const exists = list.some((e) => e.id === entity.id);
  // 更新不改 id 与 createdAt；新建时 createdAt = opts.now
  const existing = list.find((e) => e.id === entity.id);
  const stamped: EntityRecord = {
    ...entity,
    ...(existing ? { createdAt: existing.createdAt ?? opts.now } : { createdAt: opts.now }),
    updatedAt: opts.now,
  };
  const next = exists
    ? list.map((e) => (e.id === entity.id ? stamped : e))
    : [...list, stamped];
  return { ok: true, value: { ...world, entityRecords: next } };
}

/** 删除影响面：删除基础实体前必须展示（地点 / 事件 / 故事线 / 锚点 / 人物状态 / 账本行动）。 */
export function computeEntityRemovalImpact(world: World, entityId: string): {
  mapPoints: number;
  events: number;
  stories: number;
  entryAnchors: number;
  characterStates: number;
  ledgerActions: number;
} {
  const count = <T>(arr: T[] | undefined, pred: (item: T) => boolean) => (arr ?? []).filter(pred).length;
  return {
    mapPoints: count(world.points, (p) => String(p.id) === String(entityId)),
    events: Object.values(world.events ?? {}).reduce(
      (sum, list) => sum + (list ?? []).filter((e) => e.characterIds?.includes(entityId)).length,
      0,
    ),
    stories: count(world.stories, (s) => s.id === entityId),
    entryAnchors: count(world.entryAnchors, (a) => a.sourceCardId === entityId),
    characterStates: count(world.characterStates, (s) => s.characterId === entityId),
    ledgerActions: count(world.actions, (a) => a.actorId === entityId),
  };
}

/** 删除实体（作者确认后调用；有影响面时由 UI 先展示 impact 再决定）。 */
export function removeEntityRecord(world: World, entityId: string): DefinitionResult<World> {
  if (!entityRecordById(world, entityId)) {
    return { ok: false, error: `实体不存在：${entityId}` };
  }
  return { ok: true, value: { ...world, entityRecords: (world.entityRecords ?? []).filter((e) => e.id !== entityId) } };
}
