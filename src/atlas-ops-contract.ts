/**
 * atlas-ops-contract.ts — §16.3 模块之间的固定数据类型（A05）。
 *
 * 这里只定义类型与常量：解析器、编译器、分组器、事务层共用同一套 Operation / Issue 形状。
 * 字段名固定，不允许每个文件自创一套 snake/camel 映射（SQL 行 ↔ DTO 的转换只在 codec）。
 */

import { ATLAS_RUNTIME_LIMITS } from './atlas-runtime-limits.ts';

export type Phase = 'observe' | 'geography' | 'decision' | 'outcome' | 'repair';

export const ATLAS_PHASES: readonly Phase[] = ['observe', 'geography', 'decision', 'outcome', 'repair'];

export type Issue = {
  code: string;
  path: string;
  message: string;
  severity: 'warning' | 'error';
  line?: number;
  opId?: string;
  groupId?: string;
  dependencyId?: string;
  retryable: boolean;
};

export type ModelOperation = {
  op: string;
  ref?: string;
  data?: Record<string, unknown>;
  source?: string | string[];
  why?: string;
  /** 仅 repair 阶段使用程序提供的票据。 */
  ticket?: string;
};

export type ParsedOperation = {
  opId: string;
  line: number;
  rawHash: string;
  value: ModelOperation;
};

export type ParseResult = {
  operations: ParsedOperation[];
  issues: Issue[];
  explicitNoop: boolean;
  incomplete: boolean;
};

export type TurnAnchor = {
  chatUid: string;
  branchId: string;
  parentTurnId: string | null;
  hostMessageUid: string;
  variantKey: string;
  baseRevision: number;
  baseStorageRevision: number;
  inputHash: string;
};

export type RefKind =
  | 'location'
  | 'character'
  | 'item'
  | 'faction'
  | 'map'
  | 'route'
  | 'action'
  | 'journey'
  | 'event'
  | 'information'
  | 'knowledge'
  | 'channel'
  | 'relation'
  | 'rumor_front'
  | 'opportunity'
  | 'mention';

export type RefEntry = {
  alias: string;
  id: string;
  kind: RefKind;
  rowRev: number | null;
  declaredByOpId: string | null;
};

export type RowMutation = {
  table: string;
  rowId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  sourceOpIds: string[];
  basis: Record<string, unknown>;
};

export type AtomicGroup = {
  id: string;
  opIds: string[];
  dependsOn: string[];
  readSet: Array<{ table: string; rowId: string; rowRev: number }>;
  mutations: RowMutation[];
  /** 成员 op 的编译期问题：零变更组若有 error 必须是 rejected，不能记成 applied。 */
  opIssues?: Issue[];
};

export type GroupResult = {
  groupId: string;
  opIds: string[];
  status: 'applied' | 'duplicate' | 'rejected' | 'blocked';
  issues: Issue[];
  changedRows: number;
};

export type TurnReceipt = {
  turnId: string;
  anchor: TurnAnchor;
  status: 'committed' | 'partial' | 'noop' | 'failed';
  groups: GroupResult[];
  issues: Issue[];
  clockBeforeS: number;
  clockAfterS: number;
  simulatedUntilS: number;
  worldChanged: boolean;
  timeChanged: boolean;
};

export type PreparedCommit = {
  kind: 'turn' | 'rollback';
  token: string;
  anchor: TurnAnchor;
  snapshot: Uint8Array;
  snapshotSha256: string;
  receipt: TurnReceipt;
  expiresWallMs: number;
};

export type PreparedMaintenance = Omit<PreparedCommit, 'kind' | 'receipt'> & {
  kind: 'maintenance';
  receipt: null;
};

export type SaveAck = {
  token: string;
  snapshotSha256: string;
  result: 'saved' | 'requested' | 'failed';
  confirmedWallMs?: number;
  error?: Issue;
};

/** §6.4：turn_changes.target_table 的固定白名单。 */
export const TURN_CHANGE_TABLES: readonly string[] = [
  'maps',
  'locations',
  'characters',
  'items',
  'factions',
  'relations',
  'routes',
  'actions',
  'journeys',
  'events',
  'information',
  'rumor_fronts',
  'knowledge',
  'channels',
  'entity_keys',
  'mention_candidates',
  'branches',
];

/**
 * §8.4：14 个语义操作 + noop。
 * 顺序即 §8.4 表格顺序，测试与提示词模板都按此顺序生成。
 */
export const ATLAS_SEMANTIC_OPS = [
  'location.upsert',
  'character.upsert',
  'item.upsert',
  'item.transfer',
  'faction.upsert',
  'relation.upsert',
  'plan.propose',
  'plan.revise',
  'event.propose',
  'information.propose',
  'attention.propose',
  'channel.upsert',
  'map.estimate',
  'route.propose',
] as const;

export type AtlasSemanticOp = (typeof ATLAS_SEMANTIC_OPS)[number];

export const ATLAS_NOOP = 'noop';

export function isSemanticOp(op: string): op is AtlasSemanticOp {
  return (ATLAS_SEMANTIC_OPS as readonly string[]).includes(op);
}

/** §8.2：各阶段允许的操作集合。 */
export const PHASE_ALLOWED_OPS: Record<Phase, readonly string[]> = {
  observe: [
    'location.upsert',
    'character.upsert',
    'item.upsert',
    'item.transfer',
    'faction.upsert',
    'relation.upsert',
    'event.propose',
    'information.propose',
  ],
  geography: ['location.upsert', 'map.estimate', 'route.propose'],
  decision: [
    'character.upsert',
    'relation.upsert',
    'plan.propose',
    'plan.revise',
    'attention.propose',
    'channel.upsert',
  ],
  outcome: ['event.propose', 'information.propose'],
  repair: [], // 由 allowedOpsForPhase 用原失败组的允许集合填充
};

/**
 * §16.2 / §8.3：模型不得冒充程序维护的字段。
 * 出现时忽略并记 SYSTEM_FIELD_IGNORED 警告。
 */
export const SYSTEM_OWNED_FIELDS: readonly string[] = [
  'id',
  'branch_id',
  'branchId',
  'row_rev',
  'rowRev',
  'created_turn_id',
  'createdTurnId',
  'updated_turn_id',
  'updatedTurnId',
  'created_at_s',
  'createdAtS',
  'updated_at_s',
  'updatedAtS',
  'revision',
  'schema_version',
  'schemaVersion',
  'group_id',
  'groupId',
  'operation_id',
  'operationId',
  'basis_json',
  'basis',
  'target_table',
  'turn_id',
  'turnId',
  'chat_uid',
  'chatUid',
  'world_uid',
  'core_saved',
  'coreSaved',
  'row_id',
  'rowId',
  'rng_seed',
  'rngSeed',
  'clock_s',
  'clockS',
  'storage_revision',
  'storageRevision',
];

/** §8.5：可确定性修复的别名字典（超出此表的别名不强行转换）。 */
export const OP_FIELD_ALIASES: Record<string, string> = {
  locationRef: 'location_ref',
  parentRef: 'parent_ref',
  holderRef: 'holder_ref',
  targetLocationRef: 'target_location_ref',
  actionTendency: 'action_tendency',
  gridX: 'position.x',
  gridY: 'position.y',
};

export type ModelBatchRequest = {
  batchId: string;
  phase: Phase;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  allowedOps: readonly string[];
  anchor: TurnAnchor;
  maxTokens: number;
  timeoutMs: number;
  repairOfBatchId?: string;
  /** Read-only material for editable prompt segments; never treat it as instructions. */
  sourceSnapshot?: SourceSnapshotEntry[];
  promptInput?: import('./atlas-api-client.ts').AtlasWorldTurnPromptInput;
};

export type ModelUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type ModelBatchResponse = {
  batchId: string;
  text: string;
  finishReason: string | null;
  httpStatus: number | null;
  durationMs: number;
  usage?: ModelUsage;
  error?: Issue;
};

export type SourceSnapshotEntry = {
  key: string;
  text: string;
  hash: string;
  kind: 'story' | 'lorebook' | 'user' | 'simulation' | 'estimate' | 'migration';
};

export type TurnInput = {
  anchor: TurnAnchor;
  /** Local host guard; never serialized into the database or model prompt. */
  isCurrent?: () => boolean;
  userText: string;
  assistantText: string;
  sourceSnapshot: SourceSnapshotEntry[];
  phaseBatches: Phase[];
  manual: boolean;
  narrativeKind?: 'narrative' | 'manual';
  /** Display locator only; stable identity remains anchor.hostMessageUid. */
  hostMessageIndex?: string;
  operations?: ModelOperation[];
  /** Internal scene writer options, constructed by the host route, never from model text. */
  sceneMaps?: boolean;
  mapCalibration?: import('./atlas-sql-scene-maps.ts').SqlMapCalibration;
  sceneOnly?: boolean;
  /** Trusted author import, never supplied by a model operation. */
  legacyImport?: unknown;
  mapBackground?: {mapId:string;asset:import("./atlas-db-contract.ts").AtlasAssetRef|null};
  povName?: string;
};

export type RollbackInput = {
  chatUid: string;
  branchId: string;
  targetParentTurnId: string;
  expectedRevision: number;
};

export type MaintenanceInput = {
  anchor: TurnAnchor;
  outboxResults?: Array<{
    taskId: string;
    expectedStatus: string;
    nextStatus: string;
    attemptCount: number;
    nextRetryWallMs?: number;
    lastErrorCode?: string;
    lastErrorMessage?: string;
    completedWallMs?: number;
  }>;
  failedAttempt?: {
    turnId?: string;
    attempt: Record<string, unknown>;
    issues: Issue[];
  };
};

export type ViewQuery = {
  kind: 'map' | 'nearby' | 'entity' | 'changes' | 'diagnostics' | 'simulation' | 'prompt';
  branchId: string;
  revision?: number;
  mapId?: string;
  entityId?: string;
  povId?: string;
  viewMode?: 'pov' | 'author';
  cursor?: string;
  limit?: number;
};

export type ViewResult = {
  branchId: string;
  revision: number;
  items: unknown[];
  nextCursor?: string;
  metadata: Record<string, unknown>;
};

/**
 * §8.4：按阶段裁剪允许操作。
 * repair 阶段由调用者传入原失败组的允许集合。
 */
export function allowedOpsForPhase(phase: Phase, repairAllow?: readonly string[]): readonly string[] {
  if (phase === 'repair') return repairAllow ?? [];
  return PHASE_ALLOWED_OPS[phase] ?? [];
}

/** 便于测试与提示词模板断言：14 种业务操作 + noop。 */
export function operationVocabulary(): string[] {
  return [...ATLAS_SEMANTIC_OPS, ATLAS_NOOP];
}

export function limitsSnapshot(): typeof ATLAS_RUNTIME_LIMITS {
  return ATLAS_RUNTIME_LIMITS;
}
