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
  /** map.layout.request 的 spec 预算（与空间生成器 inputBytes 一致）。 */
  layoutSpecUtf8Bytes: 64 * 1024,
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
  locationDepth: 12,
  containerDepth: 4,
  actionPlanDepth: 2,
  detailedAttemptsPerTurn: 20,
  diagnosticPageSize: 100,
  /** M4：只读目录视图单页上限（完整导出走游标，不允许一次全量）。 */
  catalogViewMaxLimit: 200,
  /** M4：只读目录视图默认页大小。 */
  catalogViewDefaultLimit: 50,

  // ── M3/M4 世界建设与广域生成的统一预算（01 §4）─────────────────────────
  /** 一次显式「建设世界」的目标地点总量上限（分批完成，不是一次填满）。 */
  worldFillTargets: 64,
  /** 单个模型批次最多新增的交互地点数。 */
  newLocationsPerBatch: 12,
  /** 单个模型批次最多新增的合理路线数。 */
  newRoutesPerBatch: 16,
  /** 单个批次最多把本次目标再向下展开的父边数。 */
  additionalParentDepthPerBatch: 2,
  /** 同一批次最多处理的地图数（优先当前具体图 + 必要宏观图）。 */
  layoutMapsPerBatch: 2,
  /** 单张概览图的分区上限（G11 场景体积预算）。 */
  overviewZoneLimit: 64,
  /** 单张概览图的地物上限。 */
  overviewFeatureLimit: 128,
  /** 单张概览图的连接（路线/水系）上限。 */
  overviewLinkLimit: 128,
  /** 保存场景（maps.frame_json.atlasScene）的 UTF-8 字节上限，与 vendor 生成器一致。 */
  sceneSaveUtf8Bytes: 512 * 1024,
  /** 定向引用目录单次解析的最大条目数（超过则要求更窄的目标范围）。 */
  refCatalogMaxEntries: 512,
  /** 事件流读取：单次扫描的回合数上限。 */
  feedTurnsPerScan: 24,
  /** 事件流读取：单页最大条数。 */
  feedPageMax: 100,
  /** 事件流读取：异常回溯的最大块数。 */
  feedMaxScanBlocks: 8,
  /** 事件流读取：单回合 journal 明细的硬上限（超出给明确诊断，不返回半轮）。 */
  feedTurnJournalMax: 2000,
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
