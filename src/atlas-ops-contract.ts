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

/**
 * P08/R05：程序侧声明的**必要引用**。
 *
 * 统一用 (kind,id) 表达，不再为「必要的路线」「必要的端点」「必要的人物」各加一种数组——
 * 每多一种操作就得再加一个数组的设计迟早会漏。调用方（作者手动动作、程序任务）
 * 用真实 ID 声明它们，目录构造必须无条件下发，也不能因为总量上限被截断。
 */
export type RequiredRef = { kind: RefKind; id: string };

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
  /**
   * P09A/§15.4.13：这个组**干什么用**。缺省 `business`。
   * 建设进度/调度这一类程序记账组显式声明 `bookkeeping`：
   * 它们可以写业务表（例如给容器图补一条进度记录），但不算世界发生业务变化。
   * 判据必须同时看「写了哪些表」和「这个组的用途」，不能只看 id 前缀。
   */
  purpose?: GroupPurpose;
};

/** P09A：组的用途分类。 */
export type GroupPurpose = 'business' | 'bookkeeping';

export type GroupResult = {
  groupId: string;
  opIds: string[];
  status: 'applied' | 'duplicate' | 'rejected' | 'blocked';
  issues: Issue[];
  changedRows: number;
  /** 与 `AtomicGroup.purpose` 一致：回执层据此区分业务变化与程序记账。 */
  purpose?: GroupPurpose;
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
  // P09A（schema3）：进度/调度行同样进变更日志，可校验、可逆序恢复。
  // 只允许**程序**生成这些变更；模型语义操作表不增加对它的表级写入。
  'construction_progress',
];

/**
 * P09A/§15.4.13：写这些表**不代表**世界发生业务变化。
 *
 * 它们是程序内部表（提交元数据、变更日志、同步队列、建设进度）。
 * 只写这些行的回合不得推进 revision、不得计入实体新增或业务成功组，
 * 也不得借它推进游戏时间。
 *
 * 注意：这个清单只决定**统计口径**。它不表示这些表变成「可任意 rebase 的元数据」——
 * 建设进度行带调度语义，仍写 journal、仍可逆序回退，也仍受 stale/base guard 约束。
 */
export const PROGRAM_INTERNAL_MUTATION_TABLES: readonly string[] = [
  'branches',
  'turns',
  'turn_changes',
  'sync_outbox',
  'construction_progress',
];

/** 该表的写入是否属于业务变化。 */
export function isBusinessMutationTable(table: string): boolean {
  return !PROGRAM_INTERNAL_MUTATION_TABLES.includes(table);
}

/**
 * P09A/§15.4 第 4 条：只允许**程序**写入的记账表。
 *
 * 模型语义操作列表里没有、也不会有这些表的写入口；编译器产的组默认是 `business`，
 * 因此在 `applyGroups` 里，非 `bookkeeping` 组一旦想写这些表直接整组 rejected。
 * 这样「进度只能由程序写」是结构约束，不是靠 review 记性。
 */
export const PROGRAM_ONLY_WRITE_TABLES: readonly string[] = ['construction_progress'];

/**
 * P09A/§15.4.13：一个组是否代表**业务**变化。
 * 判据是「写到了哪些表 + 这个组的用途」，不是组 id 前缀：
 * - 显式 `bookkeeping`（建设进度/调度记账）→ 不是业务变化；
 * - 其余情况里只要有一步写到业务表 → 是业务变化；
 * - 只写程序内部表的组 → 不是业务变化。
 */
export function groupChangesBusiness(group: { purpose?: GroupPurpose; mutations: readonly RowMutation[] }): boolean {
  if (group.purpose === 'bookkeeping') return false;
  return group.mutations.some((mutation) => isBusinessMutationTable(mutation.table));
}

/**
 * §8.4：15 个语义操作 + noop（0.9.76 起含 map.layout.request）。
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
  'map.layout.request',
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
  geography: ['location.upsert', 'map.estimate', 'route.propose', 'map.layout.request'],
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
  /** Auxiliary spatial excerpt stage uses the selected connection without SQL operation-format policy. */
  promptMode?: 'atlas-spatial-extract';
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
  /**
   * P08/R05：宿主/作者侧用**真实 ID** 声明的必要引用。编译期目录必须无条件收下它们，
   * 且与提交时用的是同一份冻结目录（提示词、解析、编译、repair、零请求预览共用）。
   */
  requiredRefs?: RequiredRef[];
  /** Display locator only; stable identity remains anchor.hostMessageUid. */
  hostMessageIndex?: string;
  operations?: ModelOperation[];
  /** Internal scene writer options, constructed by the host route, never from model text. */
  sceneMaps?: boolean;
  /** Host-owned spatial task; at most two current/explicit maps, after entity settlement. */
  layoutMaps?: 'active' | string[];
  mapCalibration?: import('./atlas-sql-scene-maps.ts').SqlMapCalibration;
  sceneOnly?: boolean;
  /** Explicit author selection; never accepted as a model operation. */
  historyRepair?: import('./atlas-history-repair.ts').HistoryRepairSelection;
  /** Trusted author import, never supplied by a model operation. */
  legacyImport?: unknown;
  mapBackground?: {mapId:string;asset:import("./atlas-db-contract.ts").AtlasAssetRef|null};
  /**
   * P13/R03 §20：作者显式选择/清除绘图档案（`mode:null` = 清除，回到程序推导）。
   * 宿主路由构造，绝不来自模型文本；只写 frame 里的档案，旧 scene 保留到下一轮布局成功。
   */
  mapProfile?: {mapId:string;mode:import("./atlas-spatial-profile.ts").SpatialProfileMode|null};
  povName?: string;
  /**
   * M3/W08：UI 显式重试布局。由宿主路由构造（ticket/opID 都在这里分配），
   * 只对指定地图上 status=failed 的请求重新武装，不重放事件、不推进时间。
   */
  layoutRetry?: { mapId: string; requestId: string; operationId: string };
  /**
   * M3：显式「建设世界」参数，由宿主路由构造；绝不来自模型文本，
   * UI 也不得借此透传任意字段或 SQL 标识符。省略时按普通回合处理。
   */
  worldCompletion?: import('./atlas-world-contract.ts').WorldCompletionInput;
  /**
   * M3-15：世界书分块抽取阶段只做事实登记（extract-only）。
   * 抽取全部结束后才发一次总体建设，禁止每个分块重复扩建。
   */
  constructionMode?: 'extract-only';
  /**
   * P09B/§16.4：「继续建设」程序模式。跳过 observe/正文重放，**不发前台请求**，
   * 只把持久队列里的下一个单元（和必要布局）跑完；narrativeKind=manual、sceneOnly、时间不推进。
   * 是否真的有待办由调用方在发回合前先用持久进度判定（无待办时零请求返回「暂无待处理」）。
   */
  constructionContinue?: boolean;
  /**
   * P10/R02：本回合的来源块缓存（键已含 chat/branch，跨聊天绝不共用）。
   * 只在本回合内复用，不持久；持久账本在 `construction_progress` 的 source/chunk 行里。
   */
  worldSourceCache?: Map<string, import('./atlas-sql-world-sources.ts').WorldSourceChunk[]>;
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

/** M4/Q01：只读视图种类。未知种类必须给出明确 reason，绝不静默按 map 处理。 */
export const VIEW_KINDS = [
  'map',
  'nearby',
  'entity',
  'changes',
  'diagnostics',
  'simulation',
  'prompt',
  'scene',
  'catalog',
  'flows',
  'tasks',
  // M5：真实故事事件流（只读派生视图）。分发在 M5-07 注册前会落到 default 的明确不支持结果。
  'world-feed',
] as const;

export type ViewKind = (typeof VIEW_KINDS)[number];

/** M4/Q04：目录视图的实体种类。 */
export const CATALOG_ENTITY_KINDS = ['location', 'character', 'item', 'event', 'rumor'] as const;
export type CatalogEntityKind = (typeof CATALOG_ENTITY_KINDS)[number];

export type ViewQuery = {
  kind: ViewKind;
  branchId: string;
  revision?: number;
  mapId?: string;
  entityId?: string;
  povId?: string;
  viewMode?: 'pov' | 'author';
  cursor?: string;
  limit?: number;
  /** catalog：按实体种类筛选；省略=全部。 */
  entityKind?: CatalogEntityKind;
  /** catalog：名称 / 摘要关键字（大小写不敏感的子串匹配）。 */
  q?: string;
  /** catalog：按状态筛选（如 active）；省略=全部。 */
  status?: string;
  /** flows：聚焦实体，relation 默认以它为对象。 */
  selectedEntityId?: string;
  /** flows / tasks：附加过滤（只能是白名单里的键，视图层逐键校验）。 */
  filter?: Record<string, unknown>;
  /**
   * M1-11 / M5：world-feed 的过滤条件。
   * 只接受契约白名单字段（category/mapId/entityId/currentTurnOnly），
   * 调用方不得借此透传任意字段或 SQL 标识符。
   */
  feedFilter?: import('./atlas-world-contract.ts').FeedFilter;
};

export type ViewResult = {
  branchId: string;
  revision: number;
  items: unknown[];
  nextCursor?: string;
  metadata: Record<string, unknown>;
};

/**
 * M4/Q01：把视图的 limit 收敛到「默认 50、上限 200」。
 *
 * 完整导出必须靠游标翻页，不允许一次把整张表拉出来；非数字 / 负数 / 超过上限都收敛而不是报错。
 */
export function normalizeViewLimit(
  value: unknown,
  options: { fallback?: number; max?: number } = {},
): number {
  const fallback = Number.isInteger(options.fallback) && (options.fallback as number) > 0
    ? (options.fallback as number)
    : ATLAS_RUNTIME_LIMITS.catalogViewDefaultLimit;
  const max = Number.isInteger(options.max) && (options.max as number) > 0
    ? (options.max as number)
    : ATLAS_RUNTIME_LIMITS.catalogViewMaxLimit;
  const raw = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(raw)));
}

/** M4/Q01：只读视图种类校验；未知种类返回 null，由调用方给出明确 reason。 */
export function asViewKind(value: unknown): ViewKind | null {
  return typeof value === 'string' && (VIEW_KINDS as readonly string[]).includes(value) ? (value as ViewKind) : null;
}

/**
 * §8.4：按阶段裁剪允许操作。
 * repair 阶段由调用者传入原失败组的允许集合。
 */
export function allowedOpsForPhase(phase: Phase, repairAllow?: readonly string[]): readonly string[] {
  if (phase === 'repair') return repairAllow ?? [];
  return PHASE_ALLOWED_OPS[phase] ?? [];
}

/** 便于测试与提示词模板断言：15 种业务操作 + noop。 */
export function operationVocabulary(): string[] {
  return [...ATLAS_SEMANTIC_OPS, ATLAS_NOOP];
}

export function limitsSnapshot(): typeof ATLAS_RUNTIME_LIMITS {
  return ATLAS_RUNTIME_LIMITS;
}
