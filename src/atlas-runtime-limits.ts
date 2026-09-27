/**
 * atlas-runtime-limits.ts — §16.2 固定限制与默认规则（A04）。
 *
 * 单一来源：其它文件只能 import 本模块，不允许再写第二份同名硬编码限制。
 * 这些是待实施的工程默认值，不是模型实测最优值；已存在的用户 API 超时设置优先。
 */

export const ATLAS_RUNTIME_LIMITS = {
  responseUtf8Bytes: 256 * 1024,
  operationsPerResponse: 64,
  operationUtf8Bytes: 8 * 1024,
  responseJsonDepth: 16,
  conditionDepth: 4,
  repairAttemptsPerBatch: 1,
  actorsPerDecisionBatch: 24,
  foregroundModelBatchesPerTurn: 4,
  pendingCandidateTtlMs: 10 * 60 * 1000,
  normalResponseTokens: 4096,
  repairResponseTokens: 2048,
  modelTimeoutMs: 120000,
  mentionCandidates: 256,
  locationDepth: 4,
  containerDepth: 4,
  actionPlanDepth: 2,
  detailedAttemptsPerTurn: 20,
  diagnosticPageSize: 100,
} as const;

/**
 * §2.4 / §3～6 字段表里的结构性上限。
 * 与 ATLAS_RUNTIME_LIMITS 同属「集中到本文件，其他文件只能 import」的约定。
 */
export const ATLAS_FIELD_LIMITS = {
  aliasLimit: 8,
  capabilityLimit: 16,
  mobilityProfileLimit: 8,
  itemPropertyLimit: 16,
  participantsLimit: 16,
  geometryVertexLimit: 256,
  mentionRecentLimit: 8,
  journeySegmentLimit: 32,
  actionDependsLimit: 8,
  actionPayloadRefLimit: 8,
} as const;

export type AtlasRuntimeLimits = typeof ATLAS_RUNTIME_LIMITS;

/**
 * §16.2：首版按 `min(24, max(1, floor((maxTokens-512)/256)))` 得出人数预算。
 * 4096 输出预算 → 14 人；24 是上限，不是每次强塞 24 人。
 */
export function decisionActorBudget(maxTokens: number): number {
  const raw = Math.floor((Number(maxTokens) - 512) / 256);
  const bounded = Math.min(ATLAS_RUNTIME_LIMITS.actorsPerDecisionBatch, Math.max(1, raw));
  return Number.isFinite(bounded) ? bounded : 1;
}

/** §4.3：每个 ActionPayload 最多 8 个显式实体引用。 */
export const ACTION_PAYLOAD_REF_LIMIT = 8;
/** §4.3：depends_on_json 最多 8 项。 */
export const ACTION_DEPENDS_LIMIT = 8;
/** §4.4：JourneySegment 默认至多 32 段。 */
export const JOURNEY_SEGMENT_LIMIT = 32;
/** §3.3：人物能力列表默认至多 16 项。 */
export const CAPABILITY_LIMIT = 16;
/** §2.4：每实体默认至多 8 种当前移动方式。 */
export const MOBILITY_PROFILE_LIMIT = 8;
/** §3.2：aliases 最多 8 个。 */
export const ALIAS_LIMIT = 8;
/** §5.1：participants_json 至多 16 个。 */
export const PARTICIPANTS_LIMIT = 16;
/** §2.4 / §11.3：每 Geometry 对象默认上限 256 顶点。 */
export const GEOMETRY_VERTEX_LIMIT = 256;
/** §6.5：recent_turn_ids_json 最近至多 8 次提及。 */
export const MENTION_RECENT_LIMIT = 8;
/** §6.5：lorebook_source_keys_json 至多 8 个引用。 */
export const MENTION_LOREBOOK_LIMIT = 8;
/** §6.5：context_summary 至多 200 字。 */
export const MENTION_CONTEXT_SUMMARY_CHARS = 200;
/** §8.3：why 最多 200 字。 */
export const WHY_MAX_CHARS = 200;
/** §3.4：properties_json 至多 16 项。 */
export const ITEM_PROPERTY_LIMIT = 16;
