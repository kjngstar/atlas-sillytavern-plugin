import { workPlanLimits } from './atlas-work-batching.ts';
import {buildSqlForegroundRequest} from './atlas-sql-model-context.ts';
import {LAYOUT_CONTEXT_FRAME_KEY, buildSqlLayoutTask, computeMapLayoutSignature, unknownLayoutEntityRefs} from './atlas-sql-layout-task.ts';
import { planFunctionalAreaProjections } from './atlas-functional-areas.ts';
import { planLayoutEvidence, parseLayoutEvidence, attachLayoutEvidence, type LayoutExcerpt, type LayoutEvidenceRejection } from './atlas-layout-evidence.ts';
import {applySqlLegacyImport} from './atlas-sql-legacy-import.ts';
/**
 * atlas-db-repository.ts — 业务存储唯一入口（B05–B09 / B17–B19 / E06 / E09）。
 *
 * §16.1：业务存储只能写 SqlRepository；旧 world/tables/simulation 仅作一次迁移输入或只读兼容投影。
 * §7.3 提交顺序：捕获身份 → 候选态构建 → 校验/一次纠错 → 事务应用 → 导出并校验 → 再检查身份/head/revision
 *              → 宿主保存 → 成功才发布 UI 状态。
 * §16.4：不能一直持有 SQL 写事务等网络模型响应；先读基态、构造模型输入，响应回来再在候选库开事务。
 */

import { applyGroups } from './atlas-db-commit.ts';
import type { ApplyGroupsContext } from './atlas-db-commit.ts';
import type { RowMutation } from './atlas-ops-contract.ts';
// E08：回退计划的唯一权威（逆因果序、中间楼定位、显式上限拒绝）。
import { applyRollbackPlan, planRollback } from './atlas-db-rollback.ts';
import { applyHistoryRepair, resolveMergedId } from './atlas-history-repair.ts';
import { validateCandidate } from './atlas-db-invariants.ts';
import { ATLAS_SEMANTIC_OPS } from './atlas-ops-contract.ts';
import { buildAtomicGroups, orderGroups } from './atlas-ops-groups.ts';
import { compileOperations, defaultMakeId } from './atlas-ops-compile.ts';
import { extractPayload, looksLikeSql, parseOperations } from './atlas-ops-parser.ts';
import { buildRepairBatch, mergeRepair } from './atlas-ops-repair.ts';
import { buildStagePrompt } from './atlas-ops-prompts.ts';
import { enqueueProjectionSync, projectionHash } from './atlas-db-outbox.ts';
import { createTableReadPort, pageAllRows } from './atlas-db-readport.ts';
import { decodeRow } from './atlas-db-codec.ts';
import {
  AtlasDbError,
  beginTransaction,
  commitTransaction,
  enableForeignKeys,
  foreignKeyCheck,
  openDatabase,
  queryBound,
  rollbackTransaction,
  runBound,
  userTableNames,
} from './atlas-db-runtime.ts';
import { ATLAS_SCHEMA_VERSION, USER_TABLE_COUNT, currentSchemaVersion, expectedTableCount, installSchemaSafe } from './atlas-db-schema.ts';
import { upgradeSchema } from './atlas-db-upgrade.ts';
import { encodeSnapshot, sha256HexSync, sha256Hex } from './atlas-db-envelope.ts';
import { ATLAS_RUNTIME_LIMITS } from './atlas-runtime-limits.ts';
import { queryTurnAnalysis } from './atlas-turn-analysis-view.ts';
import { queryChanges, queryDiagnostics, queryEntityDetail, queryMapView, queryNearby, querySimulationView } from './atlas-db-views.ts';
// M4/Q07：四个新只读口。这里只传查询上下文，绝不把 writer / saveSession 交给读口。
import { queryCatalog } from './atlas-catalog-views.ts';
import { querySpatialFlows } from './atlas-spatial-flow-views.ts';
import { querySpatialScene } from './atlas-spatial-views.ts';
import { queryTasks } from './atlas-task-views.ts';
// M5-07：事件流只读口。走同一套 ctx（branch/revision/viewMode/pov），绝不引 writer。
import { queryWorldFeed } from './atlas-world-feed.ts';
import { scanKnownRefs, collectEntityRefs } from './atlas-sql-refs.ts';
export { collectKnownRefs, collectEntityRefs } from './atlas-sql-refs.ts';
import { settleSqlTurn } from './atlas-sql-simulation.ts';
import { logModelAttempts } from './atlas-model-attempts.ts';
import { compileSqlSceneMaps } from './atlas-sql-scene-maps.ts';
import { applyPendingSpatialRequests, armLayoutRetry } from './atlas-spatial-candidate.ts';
// M3-10/11/12：世界建设阶段接入 + 本回合局部模型预算 + 建设状态元数据。
import { createGenerationBudget, bindModelBudget } from './atlas-sql-generation-budget.ts';
import { WORLD_CONSTRUCTION_OPS, WORLD_FILL_FRAME_KEY, buildSqlWorldCompletionTask, normalizeCompletionPolicy, normalizeConstructionOps, orderCompletionTargets } from './atlas-sql-world-completion.ts';
import { completionMapIds, completionOwnershipIssues, resolveCompletionMaps } from './atlas-world-completion-ownership.ts';
import { dedupeWorldConstructionOps, separateConstructionRouteRefs } from './atlas-sql-world-dedupe.ts';
// P09B/R01：持久目标队列与公平重试。进度行只由程序以 bookkeeping 组写入，随同一候选 + ACK 落盘。
import {
  CONSTRUCTION_PAYLOAD_VERSION,
  MAX_UNIT_ATTEMPTS,
  acceptedSignature,
  discoverTargets,
  readProgressRows,
  readScanState,
  rowsInScope,
  scopeKeyFor,
  scopeRowMutation,
  targetRowMutation,
  targetSignature,
  unitId as constructionUnitId,
  unitRowMutation,
  type DiscoveryResult,
  type DiscoveryScanState,
  type ProgressRow,
  type ProgressStatus,
} from './atlas-construction-progress.ts';
import { planNextAllocation } from './atlas-construction-scheduler.ts';
// P10/R02：持久来源块账本。游标是「连续成功前缀」的派生值，不是内存计数器。
import {
  canConfirmUnit,
  chunkRowMutation,
  readSourceLedger,
  sourceRowMutation,
  sourceSubjectKey,
  summarizeSources,
  type SourceSummary,
} from './atlas-construction-sources.ts';
import { WORLD_SOURCE_CHUNKING_VERSION, selectWorldConstructionSources, type WorldSourceChunk, type WorldSourceSelection, type WorldSourceEntry } from './atlas-sql-world-sources.ts';
import { computeSourceCoverage, type SourceCoverageV1 } from './atlas-world-build-plan.ts';
import { prepareWorldBuildWindow, settleWorldBuildWindow, worldBuildMapReady, type WorldBuildWindow } from './atlas-world-build-execution.ts';
import { SPATIAL_REQUEST_KEY, SPATIAL_SCENE_KEY, normalizeFrame } from './atlas-spatial-frame.ts';
import { projectPromptView } from './atlas-db-knowledge-view.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type {
  AtlasAssetRef,
  AtlasEnvelope,
  AtlasModelPort,
} from './atlas-db-contract.ts';
import type {
  AtomicGroup,
  GroupResult,
  Issue,
  MaintenanceInput,
  ModelBatchRequest,
  ModelBatchResponse,
  ParsedOperation,
  Phase,
  PreparedCommit,
  PreparedMaintenance,
  RollbackInput,
  SaveAck,
  TurnAnchor,
  TurnInput,
  TurnReceipt,
  ViewQuery,
  ViewResult,
} from './atlas-ops-contract.ts';
import type { SourceSnapshotEntry } from './atlas-ops-contract.ts';
import { auditSavedSpatialMoves } from './atlas-scene-audit.ts';
import { contradictionsToDiagnostics } from './atlas-scene-contradictions.ts';
import { planLayoutRepair } from './atlas-layout-repair-context.ts';
// P09A：业务变化的判据（表 + 组用途），不靠 id 前缀。
import { groupChangesBusiness } from './atlas-ops-contract.ts';
import { normalizeGenerationOptions, isModelBatchSizeFailure } from './atlas-model-batching.ts';
import type { GenerationTask, PlanIssue, WorldFillStatus } from './atlas-world-contract.ts';

export type RepositoryOptions = {
  chatUid: string;
  worldUid?: string;
  branchId?: string;
  branchName?: string;
  rulesetVersion?: string;
  modelPort?: AtlasModelPort | null;
  now?: () => number;
  makeId?: (kind: string, opId: string, alias: string) => string;
  /** 允许测试注入：某些阶段不需要模型（程序自行结算）。 */
  phaseRunner?: (phase: Phase, send: (req: ModelBatchRequest) => Promise<ModelBatchResponse>) => Promise<ModelBatchResponse[]>;
};


export function mergeRow(target: Record<string, unknown> | null, patch: Record<string, unknown> | null): Record<string, unknown> | null {
  if (patch === null) return null;
  return { ...(target ?? {}), ...patch };
}

/**
 * M3-11：已到期的后台决策工作量（用于「后台优先 = 预算优先」的名额保留）。
 *
 * 只认活着的 action（planned/ready/active）且 `next_check_s <= 当前世界时钟`；
 * 分页检查分支行动，避免固定扫描前缀遗漏到期任务；不把 clock/npc 的细小动作当成需保留名额的工作。
 */
function countDueBackgroundActions(tables: ReturnType<typeof createTableReadPort>, branchId: string, clockS: number): number {
  const rows = pageAllRows(tables, 'actions', branchId);
  return rows.filter((row) => {
    const status = String(row.status ?? '');
    if (status !== 'planned' && status !== 'ready' && status !== 'active') return false;
    const nextCheck = row.next_check_s;
    return typeof nextCheck === 'number' && Number.isFinite(nextCheck) && nextCheck <= clockS;
  }).length;
}

/** 分支根图：建设状态没有焦点图时的落点（branches 以 id 为主键，无 branch_id 列）。 */
function branchRootMapId(tables: ReturnType<typeof createTableReadPort>, branchId: string): string {
  const branch = tables.selectOne('branches', branchId, branchId);
  return branch ? String(branch.root_map_id ?? '') : '';
}

/* ------------------------------------------------------------------ *
 * P09B/R01：持久目标队列（读 + 计划 + 变更表达）
 * ------------------------------------------------------------------ */

type ConstructionQueueUnit = {
  id: string;
  targetIds: string[];
  sourceChunkKeys: string[];
  inputSignature: string;
  attemptCount: number;
  /** 复用了已有单元（不新建行）；新建时需要写 unit 行。 */
  existing: boolean;
  /**
   * P10/R02 §17.3：本单元**已接受**的 `new:` 别名 → 当前分支真实 ID。
   *
   * 部分成功时先存这里；下一次重试先把 `new:` 换成真实引用再冻结目录/编译，
   * 因此不会重新创建同一地点或同一已绑定路线。
   */
  bindings: Record<string, string>;
};

type ConstructionQueuePlan = {
  scopeKey: string;
  /** 本批真正要建设的焦点（来自单元/新分配的目标）；空数组表示**没有待办**，不该发请求。 */
  focusIds: string[];
  unit: ConstructionQueueUnit | null;
  discovery: DiscoveryResult;
  scopeBefore: Record<string, unknown> | null;
  targetBefore: Map<string, Record<string, unknown> | null>;
  freshUnitCount: number;
  retryUnitCount: number;
  pendingTargetCount: number;
  /**
   * 本批**没被覆盖**、仍要等下一批的目标（保持 pending 行）。
   * 它同时是旧兼容字段 `remainingLocationIds` 的来源：目标数超过单批上限时，
   * 溢出的完整 ID 必须继续可见（不静默丢弃）。
   */
  remainingTargetIds: string[];
  /** 发现阶段就产生的变更：目标 pending/suspended 行 + scope 扫描推进。 */
  preMutations: RowMutation[];
  /**
   * 结构处理成功后：**本批真正被请求覆盖**的目标转 processed（签名取已接受业务状态），单元转 processed。
   * 没被本批覆盖的目标（例如必要目录装不下而留在 remainingLocationIds）保持 pending，不谎报已处理。
   */
  processedMutations: (coveredIds: readonly string[], bindings?: Readonly<Record<string, string>>) => RowMutation[];
  /** 结构处理失败：单元转 retry（attemptCount+1），目标退回 pending。 */
  failedMutations: (code: string, bindings?: Readonly<Record<string, string>>) => RowMutation[];
  /** P10/R02：本批的来源块账本计划（与目标队列同一表、同一 bookkeeping 组）。 */
  sourcePlan: ConstructionSourcePlan | null;
  /** 本批要发出去的来源选取结果（交给 buildSqlWorldCompletionTask，不再二次选取）。 */
  sourceSelection: WorldSourceSelection | null;
};

/**
 * P09B/R01：从 `construction_progress` 算出本批焦点与要落盘的变更。
 *
 * 发现（分页 + 签名比对）与调度（3 新 : 1 重试）都在这里；写入只表达成 RowMutation，
 * 由调用方随同一候选 + ACK 落盘 —— 候选没保存时正式进度一个字节都不动。
 */
function planConstructionQueue(args: {
  scopeKeyOverride?: string;
  sourceScan?: boolean;
  tables: ReturnType<typeof createTableReadPort>;
  branchId: string;
  chatUid: string;
  mode: 'bootstrap' | 'local';
  focusLocationIds: readonly string[];
  /** 归一化后的建设策略（目标发现与优先级排序共用同一份，不各自归一化）。 */
  policy: ReturnType<typeof normalizeCompletionPolicy>;
  turnId: string;
  /** P10/R02：来源快照与选取参数（与目标队列同一批算出，避免「账本一套、发出去一套」）。 */
  sourceSnapshot?: readonly WorldSourceEntry[];
  sourceFocusTerms?: readonly string[];
  sourceMaxChars?: number;
  sourceChunkChars?: number;
  worldSourceCache?: Map<string, WorldSourceChunk[]>;
}): ConstructionQueuePlan | null {
  const { tables, branchId, mode, turnId } = args;
  const rows = readProgressRows(tables, branchId);
  const scopeKey = args.scopeKeyOverride ?? scopeKeyFor(mode, args.focusLocationIds);
  const scopeRow = rowsInScope(rows, scopeKey, 'scope')[0] ?? null;
  const discovery = discoverTargets({
    tables,
    branchId,
    scopeKey,
    focusIds: args.focusLocationIds,
    rows,
    maxAdditionalDepth: args.policy.maxAdditionalDepth,
  });
  const unitRows = rowsInScope(rows, scopeKey, 'unit');
  const targetRows = rowsInScope(rows, scopeKey, 'target');
  const targetBefore = new Map<string, Record<string, unknown> | null>();
  for (const row of targetRows) targetBefore.set(row.subjectKey, row.raw);

  const scanBefore = readScanState(scopeRow);
  // 待分配目标 = 该 scope **全部** pending 行 + 本轮新入队。
  // 只看本轮 enqueueIds 会让上一轮扫描出来但没被选中的目标永远排不上队。
  //
  // 两级排序：
  // 1) `last_served_seq` 升序 —— **一次都没轮到的目标先上**。否则一个反复失败的单元
  //    会一直重发同一批高优先级目标，把后面的目标永远堵在外面（QUEUE02）；
  // 2) 组内沿用原 planCandidates 的优先级（无结构 → 未分类祖先 → 缺连通 → 展开子地点 → 其余），
  //    队列只决定「这一批处理其中的哪些」，不改变优先级本身。
  const priorityRank = new Map(
    orderCompletionTargets(tables, branchId, { mode, focusLocationIds: args.focusLocationIds }, args.policy)
      .map((id, index) => [id, index] as const),
  );
  const servedSeq = new Map(targetRows.map((row) => [row.subjectKey, row.lastServedSeq] as const));
  const pendingTargetIds = uniqueIds([
    ...targetRows.filter((row) => row.status === 'pending').map((row) => row.subjectKey),
    ...discovery.enqueueIds,
  ]).sort((left, right) => {
    const servedLeft = servedSeq.get(left) ?? 0;
    const servedRight = servedSeq.get(right) ?? 0;
    if (servedLeft !== servedRight) return servedLeft - servedRight;
    const rankLeft = priorityRank.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rankRight = priorityRank.get(right) ?? Number.MAX_SAFE_INTEGER;
    return rankLeft - rankRight || (left < right ? -1 : left > right ? 1 : 0);
  });
  const next = planNextAllocation(unitRows, pendingTargetIds, scanBefore.schedulerSeq);
  const allocation = next.allocation;

  let schedulerSeq = scanBefore.schedulerSeq;
  let allocationSeq = scanBefore.allocationSeq;
  let unit: ConstructionQueueUnit | null = null;
  let unitChunkKeys: string[] = [];
  const reusedUnit = next.chosen;
  if (reusedUnit) {
    schedulerSeq += 1;
    // 既有（重试）单元：**只消费它冻结的块**，不另起一套选取（§17.2 第 5/6 条）。
    unitChunkKeys = [...reusedUnit.sourceChunkKeys];
  }

  // Source consumption remains schedulable after structural targets complete.
  // Use real active foci; no empty-world or synthetic target is introduced.
  const sourceFocusIds = uniqueIds([
    ...args.focusLocationIds,
    ...targetRows.filter(row => row.status === 'processed').map(row => row.subjectKey),
  ]).filter(id => {
    const row = tables.selectOne('locations', branchId, id);
    return row && !['destroyed', 'merged', 'archived'].includes(String(row.status));
  }).slice(0, ATLAS_RUNTIME_LIMITS.worldFillTargets);
  const wantSources = args.sourceScan === true || Boolean(reusedUnit) || allocation.targetIds.length > 0 || sourceFocusIds.length > 0;
  const sourcePlan = wantSources
    ? planConstructionSources({
        tables,
        branchId,
        chatUid: args.chatUid,
        turnId,
        scopeKey,
        rows,
        sourceSnapshot: args.sourceSnapshot ?? [],
        focusTerms: args.sourceFocusTerms ?? [],
        maxChars: args.sourceMaxChars,
        chunkChars: args.sourceChunkChars,
        cache: args.worldSourceCache,
        frozenChunkKeys: unitChunkKeys,
        mode,
      })
    : null;
  if (sourcePlan) unitChunkKeys = [...sourcePlan.chunkKeys];

  if (!reusedUnit && allocation.targetIds.length === 0 && unitChunkKeys.length > 0) {
    allocation.targetIds = sourceFocusIds;
  }

  if (!reusedUnit && (allocation.targetIds.length > 0 || args.sourceScan && unitChunkKeys.length > 0)) {
    allocationSeq += 1;
    schedulerSeq += 1;
    const id = constructionUnitId(scopeKey, allocation.targetIds, unitChunkKeys, allocationSeq);
    unit = {
      id,
      targetIds: allocation.targetIds,
      sourceChunkKeys: unitChunkKeys,
      inputSignature: sha256HexSync(JSON.stringify([unitSignatureSource(allocation.targetIds), CONSTRUCTION_PAYLOAD_VERSION])),
      attemptCount: 0,
      existing: false,
      bindings: {},
    };
  } else if (reusedUnit) {
    unit = {
      id: reusedUnit.unitId,
      targetIds: reusedUnit.targetIds,
      sourceChunkKeys: unitChunkKeys,
      inputSignature: reusedUnit.inputSignature,
      attemptCount: reusedUnit.attemptCount,
      existing: true,
      bindings: { ...reusedUnit.bindings },
    };
  }

  const scan: DiscoveryScanState = {
    ...scanBefore,
    scanAfterId: discovery.scan.scanAfterId,
    scanCycle: discovery.scan.scanCycle,
    allocationSeq,
    schedulerSeq,
  };
  const ctx = { branchId, turnId, opId: `construction_progress_${turnId}` };
  const unitBeforeOf = (id: string): Record<string, unknown> | null => {
    const row = rowsInScope(readProgressRows(tables, branchId), scopeKey, 'unit').find((item) => item.subjectKey === id);
    return row?.raw ?? null;
  };
  const preMutations: RowMutation[] = [
    scopeRowMutation(ctx, scopeKey, scopeBeforeOf(scopeRow), scan, mode, args.focusLocationIds),
  ];
  for (const id of discovery.enqueueIds) {
    const row = tables.selectOne('locations', branchId, id);
    const signature = targetSignature(row ?? {});
    preMutations.push(targetRowMutation(ctx, scopeKey, targetBefore.get(id) ?? null, id, signature, 'pending', { version: CONSTRUCTION_PAYLOAD_VERSION }));
  }
  for (const id of discovery.suspendTargetIds) {
    const before = targetBefore.get(id) ?? null;
    if (!before) continue;
    preMutations.push(targetRowMutation(ctx, scopeKey, before, id, String(before.input_signature ?? ''), 'suspended', { version: CONSTRUCTION_PAYLOAD_VERSION }));
  }
  if (unit && !unit.existing) {
    preMutations.push(unitRowMutation(ctx, scopeKey, null, unit.id, {
      inputSignature: unit.inputSignature,
      status: 'pending',
      lastServedSeq: schedulerSeq,
      targetIds: unit.targetIds,
      sourceChunkKeys: unit.sourceChunkKeys,
      catalogueHash: '',
      attemptCount: 0,
      bindings: unit.bindings,
    }));
  }
  if (unit && unit.existing && sourcePlan) {
    // 重试单元的冻结块键可能在当前快照里已经不存在（hash 变更 / 来源关闭 / 切分版本变化）。
    // 把**真实存在的那部分**写回单元，后续结算只覆盖真正被消费的块，不假装消费了消失的块。
    const frozenBefore = new Set(reusedUnit?.sourceChunkKeys ?? []);
    const now = new Set(sourcePlan.chunkKeys);
    const changed = frozenBefore.size !== now.size || [...frozenBefore].some((key) => !now.has(key));
    if (changed) {
      preMutations.push(unitRowMutation(ctx, scopeKey, unitBeforeOf(unit.id), unit.id, {
        inputSignature: unit.inputSignature,
        status: reusedUnit?.status === 'retry' ? 'retry' : 'pending',
        lastServedSeq: reusedUnit?.lastServedSeq ?? schedulerSeq,
        targetIds: unit.targetIds,
        sourceChunkKeys: sourcePlan.chunkKeys,
        catalogueHash: reusedUnit?.catalogueHash ?? '',
        attemptCount: unit.attemptCount,
        bindings: unit.bindings,
      }));
    }
  }
  if (sourcePlan) preMutations.push(...sourcePlan.preMutations);

  return {
    scopeKey,
    focusIds: unit ? [...unit.targetIds] : [],
    unit,
    discovery,
    scopeBefore: scopeBeforeOf(scopeRow),
    targetBefore,
    freshUnitCount: next.freshCount,
    retryUnitCount: next.retryCount,
    pendingTargetCount: discovery.enqueueIds.length,
    remainingTargetIds: unit
      ? uniqueIds(pendingTargetIds).filter((id) => !unit!.targetIds.includes(id))
      : uniqueIds(pendingTargetIds),
    preMutations,
    sourcePlan,
    sourceSelection: sourcePlan ? sourcePlan.selection : null,
    processedMutations: (coveredIds: readonly string[], bindings?: Readonly<Record<string, string>>) => {
      if (!unit) return [];
      const out: RowMutation[] = [];
      const port = tables;
      const covered = new Set(coveredIds.map(String));
      for (const id of unit.targetIds) {
        if (!covered.has(id)) continue; // 本批没请求到的目标保持 pending，下一批继续。
        const before = port.selectOne('locations', branchId, id);
        // 签名记「已接受的业务状态」：本轮自己写的描述/结构不会立刻让签名失效。
        out.push(targetRowMutation(ctx, scopeKey, targetBefore.get(id) ?? null, id, acceptedSignature(before ?? {}), 'processed', { version: CONSTRUCTION_PAYLOAD_VERSION }));
      }
      out.push(unitRowMutation(ctx, scopeKey, unitBeforeOf(unit.id), unit.id, {
        inputSignature: unit.inputSignature,
        status: 'processed',
        lastServedSeq: schedulerSeq,
        targetIds: unit.targetIds,
        sourceChunkKeys: unit.sourceChunkKeys,
        catalogueHash: '',
        attemptCount: unit.attemptCount,
        bindings: bindings ?? unit.bindings,
      }));
      return out;
    },
    failedMutations: (code: string, bindings?: Readonly<Record<string, string>>) => {
      if (!unit) return [];
      const out: RowMutation[] = [];
      // 目标退回 pending，但**带上已服务序号**：下一批先照顾一次都没轮到的目标，
      // 反复失败的目标不会把整条队伍堵死（QUEUE02）。
      for (const id of unit.targetIds) {
        const before = targetBefore.get(id) ?? null;
        if (!before) continue;
        out.push(targetRowMutation(ctx, scopeKey, before, id, String(before.input_signature ?? ''), 'pending', { version: CONSTRUCTION_PAYLOAD_VERSION }, schedulerSeq));
      }
      const attempts = unit.attemptCount + 1;
      const exhausted = attempts >= MAX_UNIT_ATTEMPTS;
      out.push(unitRowMutation(ctx, scopeKey, unitBeforeOf(unit.id), unit.id, {
        inputSignature: unit.inputSignature,
        // §16.3：超过自动重试额度后不再自动入队，等后续显式续建/正常任务；目标已退回 pending，不丢。
        status: exhausted ? 'suspended' : 'retry',
        lastServedSeq: schedulerSeq,
        targetIds: unit.targetIds,
        sourceChunkKeys: unit.sourceChunkKeys,
        catalogueHash: '',
        attemptCount: attempts,
        failureCode: code,
        exhausted,
        bindings: bindings ?? unit.bindings,
      }));
      return out;
    },
  };
}

function scopeBeforeOf(row: ProgressRow | null): Record<string, unknown> | null {
  return row?.raw ?? null;
}

/**
 * P10/R02：本批的来源账本计划。
 *
 * 与目标队列同构：发现阶段只产生 pending 行，成功/失败在**同一 bookkeeping 组**里结算，
 * 因此候选没保存时来源账本一个字节都不动。
 */
type ConstructionSourcePlan = {
  scopeKey: string;
  /** 本批单元冻结的块键（= 真正进入请求的块）。 */
  chunkKeys: string[];
  selection: WorldSourceSelection;
  summary: SourceSummary;
  /** §9.1 覆盖账本：`sourceScanComplete` 只在这里判定，回执直接引用，不各自重算。 */
  coverage: SourceCoverageV1;
  preMutations: RowMutation[];
  /** 结构处理成功：本批**真正消费**的块转 processed（未覆盖的保持原状）。 */
  processedMutations: (consumedChunkKeys: readonly string[]) => RowMutation[];
  /**
   * 结构处理失败 / 部分成功：本批涉及的块转 retry（attempts+1），来源游标不前进。
   * `exhausted` = 单元自动重试额度已用尽 → 块同时停牌（suspended），
   * 这样它们能被**后续新单元**重新取到（否则失败单元的缺口永远补不上）。
   */
  retryMutations: (code: string, exhausted?: boolean) => RowMutation[];
};

/**
 * 从 `construction_progress` 的来源/块行算出本批要消费的块与要落盘的变更。
 *
 * `frozenChunkKeys` 非空 = 既有（重试）单元：**只消费它冻结的块**，不另起一套选取；
 * 这些键在当前快照里已不存在（原文 hash 变更 / 来源关闭 / 切分版本变化）时记入显式延期，
 * 不会被当成空块静默略过（§17.1）。
 */
function planConstructionSources(args: {
  tables: ReturnType<typeof createTableReadPort>;
  branchId: string;
  chatUid: string;
  turnId: string;
  scopeKey: string;
  rows: readonly ProgressRow[];
  sourceSnapshot: readonly WorldSourceEntry[];
  focusTerms?: readonly string[];
  maxChars?: number;
  chunkChars?: number;
  cache?: Map<string, WorldSourceChunk[]>;
  frozenChunkKeys: readonly string[];
  mode: 'bootstrap' | 'local';
}): ConstructionSourcePlan {
  const { branchId, turnId, scopeKey } = args;
  const ctx = { branchId, turnId, opId: `construction_source_${turnId}` };
  const ledger = readSourceLedger(args.rows, scopeKey);
  // consume 模式的跳过集合 = 本 scope 已 processed 的块。「优先尚未处理的块」靠它实现；
  // 已处理块不再重复装入「新来源」，但也**不删行**（已成功区间要留给 S8 跳过与回执）。
  // 「尚未处理的块优先」在持久账本上的精确含义：**已经有账本行的块不再分给新单元**。
  // - processed：已有效处理，绝不重复装入（§17.2 第 1 条）；
  // - pending / retry：已经归属某个在途或待重试的单元，按 P09B 的单元调度来处理（§17.2 第 3 条）；
  // - suspended：单元自动重试额度用尽而停牌 → **允许新单元重新拿到**（否则缺口永远补不上）。
  const skip = new Set<string>();
  for (const chunk of ledger.chunks.values()) {
    if (chunk.status === 'pending' || chunk.status === 'retry' || chunk.status === 'processed') skip.add(chunk.chunkKey);
  }

  const selection = selectWorldConstructionSources({
    snapshot: args.sourceSnapshot,
    focusTerms: args.focusTerms ?? [],
    chatId: args.chatUid,
    branchId,
    maxChars: args.maxChars,
    chunkChars: args.chunkChars,
    cache: args.cache,
    mode: 'consume',
    chunkingVersion: WORLD_SOURCE_CHUNKING_VERSION,
    skipChunkKeys: skip,
    onlyChunkKeys: args.frozenChunkKeys,
  });

  const preMutations: RowMutation[] = [];
  const touchedSources = new Set<string>();

  /**
   * 某个来源结算后的「连续成功前缀」。
   *
   * 必须把**本批新选的块**（账本里还没有行）和**本批刚处理成功的块**一起算进去：
   * 只看结算前的账本会把刚成功的块漏掉，游标就会永远停在 0。
   */
  const chunkView = (subjectKey: string): Array<{ chunkKey: string; start: number; end: number; status: ProgressStatus }> => {
    const map = new Map<string, { chunkKey: string; start: number; end: number; status: ProgressStatus }>();
    for (const chunk of ledger.chunksBySource.get(subjectKey) ?? []) {
      map.set(chunk.chunkKey, { chunkKey: chunk.chunkKey, start: chunk.start, end: chunk.end, status: chunk.status });
    }
    for (const chunk of selection.chunks) {
      if (sourceSubjectKey(chunk.sourceKey, chunk.contentHash) !== subjectKey) continue;
      if (!map.has(chunk.chunkKey)) map.set(chunk.chunkKey, { chunkKey: chunk.chunkKey, start: chunk.start, end: chunk.end, status: 'pending' });
    }
    return [...map.values()].sort((left, right) => left.start - right.start || (left.chunkKey < right.chunkKey ? -1 : 1));
  };
  const prefixAfter = (subjectKey: string, processedNow: ReadonlySet<string>): number => {
    let cursor = 0;
    for (const chunk of chunkView(subjectKey)) {
      if (chunk.start !== cursor) break; // 缺口：不越过
      const done = chunk.status === 'processed' || processedNow.has(chunk.chunkKey);
      if (!done) break;
      cursor = chunk.end;
    }
    return cursor;
  };
  const readPrefix = (subjectKey: string): number => prefixAfter(subjectKey, new Set<string>());

  // 来源行：新身份（含 hash 变更后的新 hash）建行；已存在且派生值变化的才更新。
  const writeSource = (sourceKey: string, contentHash: string, kind: string, chars: number, chunkCount: number, hostTruncated: boolean, enabled: boolean): void => {
    const subjectKey = sourceSubjectKey(sourceKey, contentHash);
    touchedSources.add(subjectKey);
    const existing = ledger.sources.get(subjectKey) ?? null;
    const prefix = readPrefix(subjectKey);
    const changed = !existing
      || existing.kind !== kind
      || existing.chars !== chars
      || existing.chunkCount !== chunkCount
      || existing.hostTruncated !== hostTruncated
      || existing.contiguousPrefixEnd !== prefix
      || existing.row.payload.enabled !== enabled;
    if (!changed) return;
    preMutations.push(sourceRowMutation(ctx, scopeKey, existing?.row.raw ?? null, {
      sourceKey, contentHash, kind, chars, chunkCount, contiguousPrefixEnd: prefix, hostTruncated, enabled,
    }));
  };

  for (const item of selection.known) {
    const entry = (args.sourceSnapshot ?? []).find((row) => String(row?.key ?? '').trim() === item.sourceKey);
    const enabled = entry ? entry.enabled !== false : false;
    writeSource(item.sourceKey, item.contentHash, item.kind, item.chars, item.chunkCount, item.hostTruncated, enabled);
  }
  // Historical hashes stay available for rollback, but are not current work.
  const currentSources = new Set(selection.known.map(item => sourceSubjectKey(item.sourceKey, item.contentHash)));
  for (const source of ledger.sources.values()) {
    if (!currentSources.has(source.subjectKey)) {
      writeSource(source.sourceKey, source.contentHash, source.kind, source.chars, source.chunkCount,
        source.hostTruncated, false);
    }
  }

  // 块行：只有「还不存在」的块才在发现阶段建 pending；已有行（processed/retry/suspended）
  // 由结算阶段改写，发现阶段绝不把已处理块降级回 pending。
  const chunkKeys: string[] = [];
  for (const chunk of selection.chunks) {
    chunkKeys.push(chunk.chunkKey);
    if (ledger.chunks.has(chunk.chunkKey)) continue;
    preMutations.push(chunkRowMutation(ctx, scopeKey, null, {
      chunkKey: chunk.chunkKey,
      sourceKey: chunk.sourceKey,
      contentHash: chunk.contentHash,
      chunkingVersion: chunk.chunkingVersion,
      index: chunk.index,
      total: chunk.total,
      start: chunk.start,
      end: chunk.end,
      hardSplit: chunk.hardSplit,
      status: 'pending',
      attempts: 0,
    }));
  }

  const consumedSet = (consumedChunkKeys: readonly string[]): Set<string> => new Set(consumedChunkKeys.map(String));
  /**
   * 结算后的来源行修正：游标前进才写。
   *
   * 来源行**可能只存在于本批的 preMutations 里**（第一次见到这个来源），
   * 所以拿不到账本行时要退回 selection.known —— 否则刚成功的来源游标永远停在 0。
   * 同一组内的「先建 pending 行、再改游标」由 mergeGroupMutations 合并成一条 insert。
   */
  const sourceFixups = (keys: Iterable<string>): RowMutation[] => {
    const out: RowMutation[] = [];
    const subjects = new Set<string>();
    for (const key of keys) {
      const chunk = ledger.chunks.get(key) ?? selection.chunks.find((item) => item.chunkKey === key);
      if (!chunk || !chunk.sourceKey || !chunk.contentHash) continue;
      subjects.add(sourceSubjectKey(chunk.sourceKey, chunk.contentHash));
    }
    const done = consumedSet([...keys]);
    for (const subjectKey of subjects) {
      const existing = ledger.sources.get(subjectKey) ?? null;
      const known = selection.known.find((item) => sourceSubjectKey(item.sourceKey, item.contentHash) === subjectKey) ?? null;
      if (!existing && !known) continue;
      const prefix = prefixAfter(subjectKey, done);
      if (prefix === readPrefix(subjectKey)) continue; // 游标没前进就不写（避免无意义的行版本膨胀）
      const entry = (args.sourceSnapshot ?? []).find((row) => String(row?.key ?? '').trim() === (existing?.sourceKey ?? known!.sourceKey));
      out.push(sourceRowMutation(ctx, scopeKey, existing?.row.raw ?? null, {
        sourceKey: existing?.sourceKey ?? known!.sourceKey,
        contentHash: existing?.contentHash ?? known!.contentHash,
        kind: existing?.kind ?? known!.kind,
        chars: existing?.chars ?? known!.chars,
        chunkCount: existing?.chunkCount ?? known!.chunkCount,
        contiguousPrefixEnd: prefix,
        hostTruncated: existing?.hostTruncated ?? known!.hostTruncated,
        enabled: existing ? existing.row.payload.enabled !== false : entry ? entry.enabled !== false : false,
      }));
    }
    return out;
  };

  const chunkAfterOf = (key: string): { before: Record<string, unknown> | null; chunk: WorldSourceChunk | null } => {
    const existing = ledger.chunks.get(key) ?? null;
    const fromSelection = selection.chunks.find((item) => item.chunkKey === key) ?? null;
    return { before: existing?.row.raw ?? null, chunk: fromSelection };
  };

  const summary = summarizeSources(args.rows, scopeKey);

  /**
   * §9.1 覆盖账本：`sourceScanComplete` 的唯一判定点。
   *
   * 统计范围限制在**账本当前存在的块**上（`knownChunkKeys`）：历史 hash 遗留的
   * processed 块不算覆盖，否则换了原文 hash 之后仍会被判成「早就读完」。
   * 本批新选中、还没结算的块是 pending → 计进 unchecked，所以发现阶段几乎不可能
   * 报 complete —— 这是对的：真正读完是在结算之后。
   */
  const ledgerChunkKeys = [...ledger.chunks.values()].map((chunk) => chunk.chunkKey);
  const coverage = computeSourceCoverage({
    known: selection.known,
    deferred: selection.deferred,
    processedChunkKeys: [...ledger.chunks.values()]
      .filter((chunk) => chunk.status === 'processed')
      .map((chunk) => chunk.chunkKey),
    knownChunkKeys: ledgerChunkKeys,
  });

  return {
    scopeKey,
    chunkKeys,
    selection,
    summary,
    coverage,
    preMutations,
    processedMutations: (consumedChunkKeys: readonly string[]) => {
      const consumed = consumedSet(consumedChunkKeys);
      const out: RowMutation[] = [];
      for (const key of chunkKeys) {
        if (!consumed.has(key)) continue; // 本批没真正请求到的块保持原状，下一批继续。
        const { before, chunk } = chunkAfterOf(key);
        if (!chunk) continue;
        out.push(chunkRowMutation(ctx, scopeKey, before, {
          chunkKey: chunk.chunkKey, sourceKey: chunk.sourceKey, contentHash: chunk.contentHash,
          chunkingVersion: chunk.chunkingVersion, index: chunk.index, total: chunk.total,
          start: chunk.start, end: chunk.end, hardSplit: chunk.hardSplit,
          status: 'processed', attempts: ledger.chunks.get(key)?.attempts ?? 0,
        }));
      }
      out.push(...sourceFixups(consumed));
      return out;
    },
    retryMutations: (code: string, exhausted = false) => {
      const out: RowMutation[] = [];
      for (const key of chunkKeys) {
        const { before, chunk } = chunkAfterOf(key);
        if (!chunk) continue;
        const attempts = (ledger.chunks.get(key)?.attempts ?? 0) + 1;
        out.push(chunkRowMutation(ctx, scopeKey, before, {
          chunkKey: chunk.chunkKey, sourceKey: chunk.sourceKey, contentHash: chunk.contentHash,
          chunkingVersion: chunk.chunkingVersion, index: chunk.index, total: chunk.total,
          start: chunk.start, end: chunk.end, hardSplit: chunk.hardSplit,
          status: exhausted ? 'suspended' : 'retry', attempts, failureCode: code,
        }));
      }
      return out;
    },
  };
}

/**
 * P09B/R01：把建设进度/调度的写入包成一个 **bookkeeping 组**。
 *
 * - `purpose: 'bookkeeping'`：允许写 `construction_progress`（`PROGRAM_ONLY_WRITE_TABLES`），
 *   同时**不算世界业务变化**（不计入 `worldChanged`、不计入业务成功组）。
 * - 同一批次里「先建 pending 行、成功后改 processed」由 `mergeGroupMutations` 合并成一条 insert，
 *   不会对同一行写两次，也不会留下半截状态。
 * - 与业务组同一 turnId、同一候选、同一 ACK：候选没保存时正式进度一个字节都不动。
 */
function constructionProgressGroup(
  mutations: readonly RowMutation[],
  dependsOn: readonly string[] = [],
): AtomicGroup | null {
  if (mutations.length === 0) return null;
  return {
    id: 'grp_construction_progress',
    opIds: [...new Set(mutations.flatMap((m) => m.sourceOpIds))],
    dependsOn: [...dependsOn],
    readSet: [],
    mutations: [...mutations],
    purpose: 'bookkeeping',
  };
}

/** 单元目标集合的稳定来源文本（只用于派生签名，不含时间/turnId）。 */
function unitSignatureSource(targetIds: readonly string[]): string[] {
  return [...new Set(targetIds)].sort();
}

/** 去重但**保持原顺序**（目标选择按优先级，不按 ID 重排）。 */
function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values)].filter((id) => id.length > 0);
}

/** 语义化位置合并：patch 里的 null 表示清空字段（与「保持」区分）。 */
export function mergeChangedFields(
  target: Record<string, unknown> | null,
  patch: Record<string, unknown>,
): { before: Record<string, unknown> | null; after: Record<string, unknown> | null } {
  if (target === null) return { before: null, after: { ...patch } };
  return { before: target, after: { ...target, ...patch } };
}

export type CandidateInfo = {
  token: string;
  kind: 'turn' | 'rollback' | 'maintenance';
  anchor: TurnAnchor;
  db: SqlDatabase;
  snapshot: Uint8Array;
  snapshotSha256: string;
  preparedWallMs: number;
  expiresWallMs: number;
  receipt: TurnReceipt | null;
  envelope: AtlasEnvelope;
};

export type OpenOptions = {
  bytes?: Uint8Array;
  envelope?: AtlasEnvelope | null;
  branchId?: string;
  branchName?: string;
  /** 新建库时是否建立 migration/seed turn 与 branch。 */
  seed?: boolean;
};

const CANONICAL_TABLES = new Set([
  'maps', 'locations', 'characters', 'items', 'factions', 'relations', 'routes', 'actions', 'journeys',
  'events', 'information', 'rumor_fronts', 'knowledge', 'channels', 'entity_keys', 'branches', 'turns',
  'turn_changes', 'mention_candidates', 'sync_outbox',
  // P09A（schema3）：程序内部的建设进度/调度表。
  'construction_progress',
]);

/**
 * 校验用户表集合：默认要求当前版本的全部表；给 `expectedCount` 时按该版本的表数判断
 * （旧档在升级前也必须先通过校验，不能因为本构建期待 21 张就先报坏库 —— MIG06）。
 */
export function assertCanonicalTables(db: SqlDatabase, options: { expectedCount?: number } = {}): string[] {
  const tables = userTableNames(db);
  const expectedCount = Number.isInteger(options.expectedCount) ? (options.expectedCount as number) : CANONICAL_TABLES.size;
  const unexpected = tables.filter((t) => !CANONICAL_TABLES.has(t));
  const missing = expectedCount >= CANONICAL_TABLES.size ? [...CANONICAL_TABLES].filter((t) => !tables.includes(t)) : [];
  const wrongCount = tables.length !== expectedCount;
  if (unexpected.length > 0 || missing.length > 0 || wrongCount) {
    throw new AtlasDbError(
      'DB_SCHEMA_INVALID',
      `用户表不是预期的 ${expectedCount} 张（实际 ${tables.length}；多 ${unexpected.length}，少 ${missing.length}）：多 ${unexpected.join(',')}；少 ${missing.join(',')}`,
      { unexpected, missing, expectedCount, actual: tables.length },
    );
  }
  return tables;
}

/**
 * 兼容导出（旧名）：等价于「按当前构建的表数校验」。
 * 不能只是把报错文字里的 20 改成 21 —— 版本感知的入口是 `assertCanonicalTables`。
 */
export function assertTwentyTables(db: SqlDatabase): string[] {
  return assertCanonicalTables(db, { expectedCount: USER_TABLE_COUNT });
}

type StoredCandidate = CandidateInfo & { db: SqlDatabase; assets?:AtlasAssetRef[] };

/**
 * 创建 Repository。返回对象同时满足 §16.4 的 AtlasSqlRepository 与查询/诊断辅助方法。
 */
/**
 * R06：把一次模型请求的失败归类，供 attempts 记账展示。
 *
 * 只区分「取消 / 超时 / 其他错误」三类；没有 HTTP 响应的失败绝不写成 http_status。
 */
function failureKindOf(error: unknown): string {
  const shape = error as { code?: unknown; name?: unknown } | null;
  const code = String(shape?.code ?? '').toUpperCase();
  const name = String(shape?.name ?? '');
  if (name === 'AbortError' || code === 'ABORT_ERR' || code === 'CANCELLED' || code === 'CANCELED' || code === 'TURN_CANCELLED') return 'cancelled';
  if (code === 'MODEL_TIMEOUT' || code === 'ETIMEDOUT' || name === 'TimeoutError') return 'timeout';
  return 'error';
}

export function createSqlRepository(options: RepositoryOptions) {
  const now = options.now ?? (() => Date.now());
  const chatUid = options.chatUid;
  const worldUid = options.worldUid ?? `world_${chatUid}`;
  const rulesetVersion = options.rulesetVersion ?? 'atlas-1';
  const branchId = options.branchId ?? 'main';
  const branchName = options.branchName ?? '主线';

  let db: SqlDatabase | null = null;
  let storageRevision = 0;
  /** §7.1 第 6 条：底图放附件区，数据库只存引用。这里记住随存档带来的资产清单，
   *  用于在视图元数据里**明确提示底图缺失**（缺底图不能丢实体，也不能假装有图）。 */
  let envelopeAssets: AtlasAssetRef[] = [];
  const candidates = new Map<string, StoredCandidate>();
  /** 同一分支上已有候选发布后，其余候选记为「基线已过期」，用于给出可定位的错误码（§18.4）。 */
  const staleCandidates = new Set<string>();
  let closed = false;

  const makeId =
    options.makeId ??
    ((kind: string, opId: string, alias: string) =>
      defaultMakeId({
        chatUid,
        branchId,
        parentTurnId: null,
        hostMessageUid: '',
        variantKey: '',
        baseRevision: 0,
        baseStorageRevision: 0,
        inputHash: '',
      })(kind, opId, alias));

  function requireDb(): SqlDatabase {
    if (!db || closed) throw new AtlasDbError('DB_NOT_OPEN', '数据库尚未打开', { chatUid });
    return db;
  }

  function branchRow(): Record<string, unknown> | null {
    const rows = queryBound(requireDb(), 'SELECT * FROM branches WHERE id = ? LIMIT 1', [branchId]);
    if (rows.length === 0) return null;
    const decoded = decodeRow('branches', rows[0], { allowExtra: true });
    return decoded.ok ? (decoded.row as Record<string, unknown>) : (rows[0] as Record<string, unknown>);
  }

  function currentRevision(): number {
    const row = branchRow();
    return row ? Number(row.revision ?? 0) : 0;
  }

  function currentHeadTurnId(): string | null {
    const row = branchRow();
    return row && row.head_turn_id ? String(row.head_turn_id) : null;
  }

  function currentClock(): number {
    const row = branchRow();
    return row ? Number(row.clock_s ?? 0) : 0;
  }

  /**
   * 新建库：schema + migration/seed turn + branch。**不建立「起点」地点。**
   * branch ↔ turn 互为外键，必须同一事务提交（DEFERRABLE INITIALLY DEFERRED 在 COMMIT 时校验）。
   */
  function seedNewDatabase(seedBranchId: string, seedBranchName: string): void {
    const target = requireDb();
    installSchemaSafe(target);
    const wall = now();
    const seedTurnId = `turn_migration_${chatUid}`;
    beginTransaction(target);
    try {
      runBound(
        target,
        `INSERT INTO turns (id, branch_id, parent_turn_id, host_message_uid, host_variant_key, kind, input_hash, story_hash, base_revision, committed_revision, clock_before_s, elapsed_json, clock_after_s, rng_seed, ruleset_version, decisions_json, receipt_json, attempts_json, status, created_wall_ms, prepared_wall_ms)
         VALUES (?, ?, NULL, NULL, NULL, 'migration', ?, NULL, 0, 0, 0, ?, 0, ?, ?, ?, NULL, ?, 'committed', ?, ?)`,
        [
          seedTurnId,
          seedBranchId,
          sha256HexSync(`atlas-seed:${chatUid}:${seedBranchId}`),
          JSON.stringify({ min_s: 0, nominal_s: 0, max_s: 0, quality: 'explicit', basis_refs: [] }),
          sha256HexSync(`atlas-seed-rng:${chatUid}`),
          rulesetVersion,
          JSON.stringify({ operations: [], attention_decisions: [], outcome_decisions: [], random_draws: [] }),
          JSON.stringify([]),
          wall,
          wall,
        ],
      );
      runBound(
        target,
        `INSERT INTO branches (id, parent_branch_id, fork_turn_id, head_turn_id, revision, name, pov_character_id, root_map_id, clock_s, clock_min_s, clock_max_s, calendar_label, simulation_cursor_s, simulation_status, ruleset_version, status, created_wall_ms)
         VALUES (?, NULL, NULL, ?, 0, ?, NULL, NULL, 0, 0, 0, NULL, 0, 'current', ?, 'active', ?)`,
        [seedBranchId, seedTurnId, seedBranchName, rulesetVersion, wall],
      );
      commitTransaction(target);
    } catch (err) {
      rollbackTransaction(target);
      throw err instanceof AtlasDbError ? err : new AtlasDbError('DB_SEED_FAILED', `建立初始分支/推演记录失败：${(err as Error).message}`, {});
    }
  }

  /** B06 createCandidate：从当前库快照建隔离候选；候选改动不出现在正式 query 中。 */
  async function createCandidateImpl(anchor: TurnAnchor, kind: CandidateInfo['kind'] = 'turn'): Promise<CandidateInfo> {
    const snapshot = requireDb().export();
    const candidateDb = await openDatabase(snapshot);
    enableForeignKeys(candidateDb);
    const token = `cand_${sha256HexSync(`${chatUid}\u0000${anchor.hostMessageUid}\u0000${anchor.variantKey}\u0000${now()}\u0000${candidates.size}`).slice(0, 24)}`;
    const info: StoredCandidate = {
      token,
      kind,
      anchor,
      db: candidateDb,
      snapshot,
      snapshotSha256: await sha256Hex(snapshot),
      preparedWallMs: now(),
      expiresWallMs: now() + ATLAS_RUNTIME_LIMITS.pendingCandidateTtlMs,
      receipt: null,
      envelope: null as unknown as AtlasEnvelope,
    };
    candidates.set(token, info);
    return info;
  }

  /** B07 exportCandidate：export + SHA256 → PreparedCommit。 */
  async function exportCandidateImpl(candidate: CandidateInfo, receipt: TurnReceipt): Promise<PreparedCommit> {
    const stored = candidates.get(candidate.token);
    if (!stored) throw new AtlasDbError('CANDIDATE_UNKNOWN', `候选不存在或已丢弃：${candidate.token}`, { token: candidate.token });
    const bytes = stored.db.export();
    const snapshotSha256 = await sha256Hex(bytes);
    const envelope = await encodeSnapshot(bytes, {
      chatUid,
      worldUid,
      storageRevision: storageRevision + 1,
      activeBranchId: candidate.anchor.branchId,
      schemaVersion: ATLAS_SCHEMA_VERSION,
      assets: stored.assets ?? envelopeAssets,
    });
    stored.snapshot = bytes;
    stored.snapshotSha256 = snapshotSha256;
    stored.envelope = envelope;
    stored.receipt = receipt;
    stored.expiresWallMs = now() + ATLAS_RUNTIME_LIMITS.pendingCandidateTtlMs; // TTL 从交给宿主保存时起算
    return {
      kind: 'turn',
      token: stored.token,
      anchor: candidate.anchor,
      snapshot: bytes,
      snapshotSha256,
      receipt,
      expiresWallMs: stored.expiresWallMs,
    };
  }

  /** B09 discardPrepared：保存失败前后正式库哈希一致。 */
  async function discardPreparedImpl(token: string): Promise<void> {
    const stored = candidates.get(token);
    if (!stored) return;
    stored.db.close();
    candidates.delete(token);
  }

  const repo = {
    get db(): SqlDatabase {
      return requireDb();
    },
    get branchId(): string {
      return branchId;
    },
    get chatUid(): string {
      return chatUid;
    },
    get worldUid(): string {
      return worldUid;
    },
    get storageRevision(): number {
      return storageRevision;
    },

    /**
     * B05 open：新建有 migration/seed turn 和 branch；根图可存在而无「起点」实体。
     *
     * §2 第 1/10 步：存档按版本分流。版本 1 的旧档在**已导入的独立副本**上升级，
     * 原 envelope 与 bytes 不被改写，也不在此处触发宿主保存；
     * 升级结果只作为本次会话的候选快照，随下一次业务提交或维护候选与 ACK 输出。
     */
    async open(openOptions: OpenOptions = {}): Promise<void> {
      if (openOptions.bytes && openOptions.bytes.length > 0) {
        db = await openDatabase(openOptions.bytes);
        enableForeignKeys(db);
        // 旧档：先在**副本**上显式逐段升级（1→2→3；内部会临时关闭并恢复 FK），再校验表集合。
        // 升级失败会抛 DB_UPGRADE_FAILED 并保留原 bytes，绝不以 seedNewDatabase 作为错误后备。
        const schemaBeforeUpgrade = currentSchemaVersion(db);
        if (schemaBeforeUpgrade < ATLAS_SCHEMA_VERSION) {
          if (schemaBeforeUpgrade > 0) assertCanonicalTables(db, { expectedCount: expectedTableCount(schemaBeforeUpgrade) });
          upgradeSchema(db);
          enableForeignKeys(db);
        }
        assertCanonicalTables(db, { expectedCount: expectedTableCount(currentSchemaVersion(db)) });
        const existingBranch = queryBound(db, 'SELECT id FROM branches WHERE id = ? LIMIT 1', [branchId]);
        if (existingBranch.length === 0) {
          const anyBranch = queryBound(db, 'SELECT id FROM branches ORDER BY created_wall_ms LIMIT 1', []);
          if (anyBranch.length === 0) {
            seedNewDatabase(branchId, branchName);
          } else {
            throw new AtlasDbError('DB_BRANCH_MISSING', `存档里没有分支 ${branchId}；不自动建一个新空世界`, {
              requested: branchId,
              available: anyBranch.map((r) => String(r.id)),
            });
          }
        }
        storageRevision = Number(openOptions.envelope?.storage_revision ?? 0);
        envelopeAssets = Array.isArray(openOptions.envelope?.assets) ? [...openOptions.envelope!.assets] : [];
        return;
      }
      if (openOptions.seed === false) {
        db = await openDatabase();
        return;
      }
      db = await openDatabase();
      seedNewDatabase(openOptions.branchId ?? branchId, openOptions.branchName ?? branchName);
      storageRevision = 0;
      envelopeAssets = [];
    },

    /** 只读查询入口：所有视图共用一个 branch/revision。 */
    async queryView(query: ViewQuery): Promise<ViewResult> {
      const target = requireDb();
      const ctx = {
        db: target,
        branchId: query.branchId || branchId,
        revision: currentRevision(),
        viewMode: query.viewMode,
        povId: query.povId ?? (branchRow()?.pov_character_id as string | null) ?? null,
        chatId: chatUid,
        // §7.1 第 6 条：把随存档带来的资产清单交给视图层，由它产出缺底图诊断。
        assets: envelopeAssets,
      };
      switch (query.kind) {
        case 'map':
          return queryMapView(ctx, query);
        case 'nearby':
          return queryNearby(ctx, query);
        case 'entity':
          if(query.entityId&&query.entityKind&&['location','character','item','faction'].includes(query.entityKind)){
            const table=({location:'locations',character:'characters',item:'items',faction:'factions'} as Record<string,string>)[query.entityKind];
            const resolved=resolveMergedId({db:target,branchId:ctx.branchId,table,id:query.entityId});
            return queryEntityDetail(ctx,{...query,entityId:resolved.resolvedId});
          }
          return queryEntityDetail(ctx, query);
        case 'changes':
          return queryChanges(ctx, query);
        case 'diagnostics':
          return queryDiagnostics(ctx, query);
        case 'turn-analysis':
          return queryTurnAnalysis(ctx, query);
        case 'simulation':
          return querySimulationView(ctx, query);
        case 'prompt':
          return {branchId:ctx.branchId,revision:ctx.revision,items:[projectPromptView(ctx,query)],metadata:{viewMode:ctx.viewMode??'pov'}};
        // M4/Q07：只读数据口。同一个 branch/revision/viewMode/povId，不写库、不落 journal。
        case 'scene':
          return querySpatialScene(ctx, query);
        case 'catalog':
          return queryCatalog(ctx, query);
        case 'flows':
          return querySpatialFlows(ctx, query);
        case 'tasks':
          return queryTasks(ctx, query);
        // M5-07：新故事事件流。changes 仍是「数据表变动/技术日志」，两者职责不混。
        case 'world-feed':
          return queryWorldFeed(ctx, query);
        default:
          return { branchId: ctx.branchId, revision: ctx.revision, items: [], metadata: { reason: 'VIEW_KIND_UNSUPPORTED', kind: query.kind } };
      }
    },

    async exportCurrent(): Promise<Uint8Array> {
      return requireDb().export();
    },

    /** 当前库的存档信封（供宿主保存使用）。 */
    async currentEnvelope(): Promise<AtlasEnvelope> {
      const bytes = requireDb().export();
      return encodeSnapshot(bytes, {
        chatUid,
        worldUid,
        storageRevision,
        activeBranchId: branchId,
        schemaVersion: ATLAS_SCHEMA_VERSION,
      assets: envelopeAssets,
      });
    },

    /** B06 createCandidate：从当前库快照建隔离候选；候选改动不出现在正式 query 中。 */
    async createCandidate(anchor: TurnAnchor, kind: CandidateInfo['kind'] = 'turn'): Promise<CandidateInfo> {
      const snapshot = requireDb().export();
      const candidateDb = await openDatabase(snapshot);
      enableForeignKeys(candidateDb);
      const token = `cand_${sha256HexSync(`${chatUid}\u0000${anchor.hostMessageUid}\u0000${anchor.variantKey}\u0000${now()}\u0000${candidates.size}`).slice(0, 24)}`;
      const info: StoredCandidate = {
        token,
        kind,
        anchor,
        db: candidateDb,
        snapshot,
        snapshotSha256: await sha256Hex(snapshot),
        preparedWallMs: now(),
        expiresWallMs: now() + ATLAS_RUNTIME_LIMITS.pendingCandidateTtlMs,
        receipt: null,
        envelope: null as unknown as AtlasEnvelope,
      };
      candidates.set(token, info);
      return info;
    },

    getCandidate(token: string): CandidateInfo | null {
      return candidates.get(token) ?? null;
    },

    /** B07 exportCandidate：export + SHA256 → PreparedCommit。 */
    async exportCandidate(candidate: CandidateInfo, receipt: TurnReceipt): Promise<PreparedCommit> {
      const stored = candidates.get(candidate.token);
      if (!stored) throw new AtlasDbError('CANDIDATE_UNKNOWN', `候选不存在或已丢弃：${candidate.token}`, { token: candidate.token });
      const bytes = stored.db.export();
      const snapshotSha256 = await sha256Hex(bytes);
      const envelope = await encodeSnapshot(bytes, {
        chatUid,
        worldUid,
        storageRevision: storageRevision + 1,
        activeBranchId: candidate.anchor.branchId,
        schemaVersion: ATLAS_SCHEMA_VERSION,
      assets: envelopeAssets,
      });
      stored.snapshot = bytes;
      stored.snapshotSha256 = snapshotSha256;
      stored.envelope = envelope;
      stored.receipt = receipt;
      stored.expiresWallMs = now() + ATLAS_RUNTIME_LIMITS.pendingCandidateTtlMs; // TTL 从交给宿主保存时起算
      return {
        kind: 'turn',
        token: stored.token,
        anchor: candidate.anchor,
        snapshot: bytes,
        snapshotSha256,
        receipt,
        expiresWallMs: stored.expiresWallMs,
      };
    },

    /** B08 confirmSaved：token+hash 一致且 saved 才切正式库；requested 保留待确认。 */
    async confirmSaved(ack: SaveAck): Promise<void> {
      const stored = candidates.get(ack.token);
      if (!stored) {
        if (staleCandidates.has(ack.token)) {
          throw new AtlasDbError(
            'STALE_BASE',
            '该候选基于的 revision 已被同一聊天的另一次提交占用（候选已作废，未发布任何内容）',
            { token: ack.token, current: currentRevision() },
          );
        }
        throw new AtlasDbError('CANDIDATE_UNKNOWN', `确认保存失败：候选不存在或已丢弃（token=${ack.token}）`, { token: ack.token });
      }
      if (stored.expiresWallMs < now() && ack.result !== 'saved') {
        throw new AtlasDbError('CANDIDATE_EXPIRED', `候选已过期（token=${ack.token}）`, { token: ack.token });
      }
      // §7.3 提交顺序的最后一步：发布前**再检查一次 revision**。
      // 只校验 token/hash 是不够的——两个并发 prepareTurn 会各自拿到同一基线的候选，
      // 两次 confirmSaved 都被接受就等于「一个基版本提交了两次」（§7.6）。
      // 元数据维护不改业务 revision，因此 rebaseCandidateIfMetadataOnly 的路径不受影响。
      if (ack.result === 'saved' && stored.anchor.baseRevision !== currentRevision()) {
        throw new AtlasDbError(
          'STALE_BASE',
          `发布前基线已变化：候选基于 revision ${stored.anchor.baseRevision}，当前 ${currentRevision()}（拒绝发布，不覆盖已有提交）`,
          { base: stored.anchor.baseRevision, current: currentRevision(), token: ack.token },
        );
      }
      if (stored.snapshotSha256 !== ack.snapshotSha256) {
        throw new AtlasDbError('CANDIDATE_HASH_MISMATCH', `确认保存的哈希与候选不一致：候选 ${stored.snapshotSha256}，确认 ${ack.snapshotSha256}`, {
          token: ack.token,
        });
      }
      if (ack.result === 'saved') {
        const old = db;
        db = stored.db;
        enableForeignKeys(db);
        storageRevision += 1;
        envelopeAssets=stored.envelope.assets.map(asset=>({...asset}));
        candidates.delete(ack.token);
        for (const [token, other] of candidates) {
          if (other.kind === 'turn' && other.anchor.chatUid === chatUid) {
            // 不是「候选不存在」，而是「同一基线的另一次提交已经占位」——登记下来，
            // 让后到的 confirmSaved 报可定位的 STALE_BASE 而不是 CANDIDATE_UNKNOWN（§18.4）。
            staleCandidates.add(token);
            other.db.close();
            candidates.delete(token);
          }
        }
        if (old && old !== db) old.close();
        return;
      }
      if (ack.result === 'requested') {
        // 保存结果未知/待确认：保留候选，不发布为正式状态。
        return;
      }
      // failed：丢弃候选，正式库保持不变。
      stored.db.close();
      candidates.delete(ack.token);
    },

    /** B09 discardPrepared：保存失败前后正式库哈希一致。 */
    async discardPrepared(token: string): Promise<void> {
      const stored = candidates.get(token);
      if (!stored) return;
      stored.db.close();
      candidates.delete(token);
    },

    /** B17 close：关闭正式库/候选库；重复打开关闭不累积句柄。 */
    async close(): Promise<void> {
      for (const stored of candidates.values()) stored.db.close();
      candidates.clear();
      if (db) db.close();
      db = null;
      closed = true;
    },

    /** E06 prepareTurn：读取 → 模型 → 编译 → 修复一次 → 应用 → 导出。 */
    async prepareTurn(input: TurnInput): Promise<PreparedCommit> {
      return prepareTurnInner(input);
    },

    async prepareWorldBuildBatch(input: TurnInput): Promise<PreparedCommit> {
      if (!input.worldBuild) throw new AtlasDbError('INVALID_PAYLOAD', '建设批次必须由建设控制器构造', {});
      return prepareTurnInner({ ...input, constructionContinue: true, sceneOnly: true, manual: false, narrativeKind: 'manual', phaseBatches: [] });
    },

    /** E09 prepareRollback：在候选库恢复数据/clock/knowledge，生成新同步意图。 */
    async prepareRollback(input: RollbackInput): Promise<PreparedCommit> {
      return prepareRollbackInner(input);
    },

    /** B18 prepareMaintenance：只改 outbox/失败尝试，走同一导出/保存确认。 */
    async prepareMaintenance(input: MaintenanceInput): Promise<PreparedMaintenance> {
      return prepareMaintenanceInner(input);
    },

    /** B19 rebaseCandidateIfMetadataOnly：仅内部维护变化时在最新快照重放已接受结果。 */
    async rebaseCandidateIfMetadataOnly(candidate: CandidateInfo, currentRevision_: number): Promise<{ rebased: boolean; reason: string }> {
      const stored = candidates.get(candidate.token);
      if (!stored) return { rebased: false, reason: 'CANDIDATE_UNKNOWN' };
      if (stored.anchor.baseRevision !== currentRevision_) {
        return { rebased: false, reason: 'STALE_BASE' };
      }
      // 只有维护更新（outbox/诊断）时：正式库快照最新内部任务状态，业务行未变，可以直接沿用候选。
      const latestStorage = storageRevision;
      if (latestStorage <= stored.anchor.baseStorageRevision) {
        return { rebased: false, reason: 'NO_METADATA_CHANGE' };
      }
      stored.anchor = { ...stored.anchor, baseStorageRevision: latestStorage };
      return { rebased: true, reason: 'METADATA_ONLY' };
    },

    /** 内部：给编译/提交用的一次性上下文（测试与维护脚本也用它）。 */
    internal: {
      makeId,
      branchId,
      chatUid,
      currentRevision,
      currentClock,
      currentHeadTurnId,
      branchRow,
      setMigrationAssets(assets:AtlasAssetRef[]){
        if(storageRevision!==0||candidates.size)throw new AtlasDbError('MIGRATION_ALREADY_APPLIED','只允许在未发布的迁移基点登记旧底图',{});
        envelopeAssets=assets.map(asset=>({...asset}));
      },
    },
  };

  return repo;

  // —— 内部实现 ——

  async function prepareTurnInner(input: TurnInput): Promise<PreparedCommit> {
    requireDb();
    const anchor = input.anchor;
    if (anchor.chatUid !== chatUid) {
      throw new AtlasDbError('CHAT_CHANGED', `提交锚点属于另一个聊天：${anchor.chatUid}`, { expected: chatUid, actual: anchor.chatUid });
    }
    const rev = currentRevision();
    if (anchor.baseRevision !== rev) {
      throw new AtlasDbError('STALE_BASE', `基版本已变化：锚点 ${anchor.baseRevision}，当前 ${rev}`, { base: anchor.baseRevision, current: rev });
    }
    const windowPort = options.modelPort?.freezeWindow ? await options.modelPort.freezeWindow() : options.modelPort;
    if(options.modelPort?.freezeWindow&&(currentRevision()!==rev||input.isCurrent&&!input.isCurrent()))throw new AtlasDbError('STALE_BASE','冻结窗口设置期间世界或聊天已变化',{});
    let generationOptions=normalizeGenerationOptions(input.generationOptions);
    if(input.generationOptions===undefined&&windowPort?.generationOptions){
      generationOptions=normalizeGenerationOptions(await windowPort.generationOptions());
      if(currentRevision()!==rev||input.isCurrent&&!input.isCurrent())throw new AtlasDbError('STALE_BASE','读取分批设置期间世界或聊天已变化',{});
    }
    input={...input,generationOptions,...(generationOptions.workBatching&&input.worldCompletion?{worldCompletion:{...input.worldCompletion,policy:{...input.worldCompletion.policy,budgetMode:'workload',maxNewLocations:ATLAS_RUNTIME_LIMITS.constructionOperationsPerBatch,maxNewRoutes:ATLAS_RUNTIME_LIMITS.constructionOperationsPerBatch,maxAdditionalDepth:ATLAS_RUNTIME_LIMITS.locationDepth}}}:{})};

    // 1) 隔离候选态
    const candidate = await createCandidateImpl(anchor, 'turn');
    const candidateDb = (candidates.get(candidate.token) as StoredCandidate).db;
    const tables = createTableReadPort(candidateDb);
    /**
     * P08/R05：本回合的**冻结引用目录**只算一次。
     *
     * 提示词要用的 entityRefs、编译要用的 knownRefs、纠错要用的 refs 全部取自这一份
     * （`compileOperations` 的 scope 由它 seed），因此三者 alias 必然一致。
     * 程序声明的必要引用（requiredRefs）在此无条件追加——第 51 张地图、第 206 个人
     * 都能拿到 alias，而不必抬高每表固定条数上限。
     */
    const frozenScan = scanKnownRefs(tables, branchId, { requiredRefs: input.requiredRefs });
    const foregroundKnownRefs = frozenScan.refs;
    /**
     * REF04：必要引用本身已超目录预算时**一次都不能发**（发送次数 0），
     * 明确报 REF_REQUIRED_BUDGET_EXCEEDED，由调用方拆请求；绝不删掉必要项后继续发送。
     */
    const requiredCatalogueBudget = ATLAS_RUNTIME_LIMITS.refCatalogMaxEntries;
    const requiredBudgetExceeded = frozenScan.requiredResolved > requiredCatalogueBudget;
    const clockBefore = currentClock();
    // A rolled-back floor may be regenerated with identical text; retain the old
    // audit turn and give its new commit generation a distinct identity.
    const turnId = `turn_${sha256HexSync(`${chatUid}\u0000${anchor.branchId}\u0000${anchor.hostMessageUid}\u0000${anchor.variantKey}\u0000${anchor.inputHash}\u0000${anchor.baseRevision}`).slice(0, 24)}`;

    const allIssues: Issue[] = [];
    const parsedOperations: ParsedOperation[] = [];
    const attempts: Array<Record<string, unknown>> = [];
    /**
     * R06：模型尝试的统一记账。
     *
     * - `started_wall_ms` 必须在**调用 request 之前**取；`finished_wall_ms` 在请求真正结束
     *   （成功 / 抛错 / 取消 / 超时）时取；`duration_ms = max(0, finished - started)`。
     * - 失败路径**绝不**写 `http_status`：没有 HTTP 响应就不能伪造 200。
     * - 一次请求只写一条：成功/失败共用同一个写入函数，不会 success + catch 重复记账。
     * - 复用、重复确认、未触发模型的路径根本不调用本函数，所以不会凭空多出「0 ms 的模型请求」。
     */
    const recordAttempt = (entry: Record<string, unknown>): void => {
      const finished = typeof entry.finished_wall_ms === 'number' ? entry.finished_wall_ms : now();
      const started = typeof entry.started_wall_ms === 'number' ? entry.started_wall_ms : finished;
      attempts.push({
        id: `att_${attempts.length}`, ...entry,
        started_wall_ms: started, finished_wall_ms: finished,
        duration_ms: Math.max(0, finished - started),
      });
    };
    const turnBudget = createGenerationBudget({diagnosticAnchor:input.anchor,limit:generationOptions.batching.requestsPerOperation??0,workBatching:generationOptions.workBatching});
    const modelPort = windowPort ? bindModelBudget(windowPort, turnBudget) : null;
    let explicitNoop = false;
    let responseIncomplete = false;
    let repairAttempted = false;
    let worldChanged = false;
    let timeChanged = false;
    let modelPhaseFailed = false;
    let foregroundBatches = 0;

    let sourceSnapshot: SourceSnapshotEntry[] = input.sourceSnapshot ?? [];
    let worldBuildWindow: WorldBuildWindow | null = null;

    if (input.manual) {
      const manualOps = input.operations ?? [];
      manualOps.forEach((value, index) => {
        const raw = JSON.stringify(value);
        parsedOperations.push({
          opId: `op_manual_${index}_${sha256HexSync(raw).slice(0, 8)}`,
          line: index + 1,
          rawHash: sha256HexSync(raw),
          value,
        });
      });
    } else {
      // P09B/§16.4：continue 模式**不发前台请求**：队列里的下一单元与必要布局才是一次 continue 的全部工作。
      const phases: Phase[] = input.constructionContinue ? [] : input.phaseBatches?.length ? input.phaseBatches : ['observe'];
      if (requiredBudgetExceeded) {
        // REF04：必要引用预算超限 → 本批发送次数 0（下面 phases 集合直接清空）。
        modelPhaseFailed = true;
        allIssues.push({
          code: 'REF_REQUIRED_BUDGET_EXCEEDED',
          path: '$.catalogue.requiredRefs',
          message: `程序声明的必要引用 ${frozenScan.requiredResolved} 条已超过目录上限 ${requiredCatalogueBudget}：本批发送次数 0，不得删掉必要项后继续发送；请把可独立的地图/目标拆成多批。`,
          severity: 'error',
          retryable: false,
        });
      }
      let phaseIndex = 0;
      for (const phase of requiredBudgetExceeded ? [] : phases) {
        if (turnBudget.limit>0&&phaseIndex >= turnBudget.limit) {
          allIssues.push({
            code: 'BUDGET_EXHAUSTED',
            path: '$.phaseBatches',
            message: `前台模型批次数已达用户设置的上限 ${turnBudget.limit}；剩余阶段保存在行动队列并标记 catching_up`,
            severity: 'warning',
            retryable: true,
          });
          break;
        }
        phaseIndex += 1;
        foregroundBatches += 1;
        if (!options.modelPort) {
          modelPhaseFailed = true;
          allIssues.push({
            code: 'MODEL_PORT_MISSING',
            path: '$.modelPort',
            message: '没有可用的模型端口：本轮不产生模型变更（不伪造 noop 成功）',
            severity: 'error',
            retryable: true,
          });
          break;
        }
        const request = buildSqlForegroundRequest(tables,branchId,input,phase,turnId,foregroundKnownRefs);
        const startedWall = now();
        let response: ModelBatchResponse;
        try {
          response = await modelPort!.request(request);
        } catch (err) {
          const modelError = err as { code?: string; retryable?: boolean; message?: string };
          modelPhaseFailed = true;
          allIssues.push({
            code: modelError.code ?? 'MODEL_TIMEOUT',
            path: '$.modelPort',
            message: `模型请求失败：${(err as Error).message}`,
            severity: 'error',
            retryable: modelError.retryable ?? true,
          });
          recordAttempt({ kind: 'initial', phase, started_wall_ms: startedWall, failure_kind: failureKindOf(err), error: (err as Error).message });
          break;
        }
        recordAttempt({
          kind: 'initial',
          phase,
          started_wall_ms: startedWall,
          finished_wall_ms: now(),
          http_status: response.httpStatus,
          response_chars: response.text?.length ?? 0,
          response_hash: sha256HexSync(response.text ?? ''),
          finish_reason: response.finishReason,
        });

        const extracted = extractPayload(response.text ?? '');
        if (extracted.incomplete) responseIncomplete = true;
        allIssues.push(...extracted.issues);
        if (looksLikeSql(extracted.payload)) {
          allIssues.push({
            code: 'UNSUPPORTED_RESPONSE_FORMAT',
            path: '$.response',
            message: '响应是 SQL 而不是语义操作：不直接 db.run，也不伪装 noop 成功',
            severity: 'error',
            retryable: true,
          });
          modelPhaseFailed = true;
          continue;
        }
        const parsed = parseOperations(extracted.payload, { phase });
        if (parsed.incomplete) responseIncomplete = true;
        allIssues.push(...parsed.issues);
        if (parsed.explicitNoop) explicitNoop = true;
        if (parsed.operations.length === 0 && !parsed.explicitNoop && !extracted.reasoningBlocked) {
          allIssues.push({
            code: 'EMPTY_RESPONSE',
            path: '$.response',
            message: '模型返回空内容（不是 noop）：保留可独立完成的程序变更，明确模型阶段失败',
            severity: 'error',
            retryable: true,
          });
          modelPhaseFailed = true;
          continue;
        }
        parsedOperations.push(...parsed.operations);
      }
    }

    // §7.3：模型 await 是一个长窗口，响应回来后必须**再复核一次基线**。
    // 期间别的楼层可能已经提交，此时这个候选已经建立在过期基态上，不能继续应用。
    const revAfterModel = currentRevision();
    try {
      if (input.isCurrent && !input.isCurrent()) throw new AtlasDbError('TURN_CANCELLED', '模型等待期间聊天或正文已变化，候选已丢弃', {});
    } catch (error) {
      await discardPreparedImpl(candidate.token);
      if (error instanceof AtlasDbError) error.detail.requestAudit=turnBudget.audit?.();
      throw error;
    }
    if (revAfterModel !== anchor.baseRevision) {
      await discardPreparedImpl(candidate.token);
      throw new AtlasDbError(
        'STALE_BASE',
        `模型响应期间基线已变化：候选基于 revision ${anchor.baseRevision}，当前 ${revAfterModel}（候选已丢弃）`,
        { base: anchor.baseRevision, current: revAfterModel, requestAudit:turnBudget.audit?.() },
      );
    }

    // 2) 编译（纯函数，不写正式库）
    /**
     * manual（作者手动编辑）与自动推演走的阶段不同：
     * 自动推演只从正文「观察」，而作者手动编辑是**统一写入层**，必须能提交
     * attention.propose / plan.propose 等非 observe 操作；把它们锁死在 observe
     * 会让 manual 编辑收不到 UNKNOWN_OPERATION 之外的任何结果。
     */
    const compilePhase: Phase = input.phaseBatches.length===1?input.phaseBatches[0]:'observe';
    const compiled = compileOperations({
      operations: parsedOperations,
      anchor,
      phase: compilePhase,
      clockS: clockBefore,
      revision: rev,
      tables,
      sources: { phase: compilePhase, snapshot: sourceSnapshot, clockS: clockBefore },
      makeId,
      knownRefs: foregroundKnownRefs,
      // 审计列（created_turn_id/updated_turn_id/first_turn_id/last_turn_id）记本次新建的楼。
      turnId,
      // manual = 统一写入层：按操作本身判定允许集合，不受 observe 限制。
      ...(input.manual || input.phaseBatches.length > 1 ? { allowedOps: ATLAS_SEMANTIC_OPS } : {}),
    });
    allIssues.push(...compiled.issues);

    const compileInputs = compiled.results.map((r) => ({
      opId: r.opId,
      issues: r.result.issues,
      mutations: r.result.mutations,
      readSet: r.result.readSet,
      dependencies: r.result.dependencies,
      entityKeyWrites: r.result.entityKeyWrites,
      operationKeys: r.result.operationKeys,
    }));
    const built = buildAtomicGroups(compileInputs);
    allIssues.push(...built.issues);
    const ordered = orderGroups(built.groups);
    allIssues.push(...ordered.issues);

    // 3) 事务应用（候选库）
    let groupResults: GroupResult[] = [];
    let sequencesUsed = 0;
    beginTransaction(candidateDb);
    let committed = false;
    let transactionOpen = true;
    let preparationStep='entity-apply';
    try {
      insertTurnRow(candidateDb, {
        turnId,
        anchor,
        kind: input.manual || input.narrativeKind === 'manual' ? 'manual' : 'narrative',
        clockBefore,
        clockAfter: clockBefore,
        storyHash: input.assistantText ? sha256HexSync(input.assistantText) : null,
        attempts,
      });

      if(input.historyRepair&&(!input.manual||!input.sceneOnly||parsedOperations.length))throw new AtlasDbError('HISTORY_SELECTION_INVALID','历史修复必须是独立手动候选，不能混入模型或其他操作',{});
      const selectedGroups=input.historyRepair?[applyHistoryRepair({db:candidateDb,branchId,revision:rev,headTurnId:anchor.parentTurnId,turnId,chatUid,...input.historyRepair})]:ordered.order;
      const applied = applyGroups(candidateDb, selectedGroups, {
        branchId,
        turnId,
        attemptId: input.manual ? 'manual' : 'model',
        validate: true,
      });
      groupResults = applied.groups;
      sequencesUsed = applied.sequencesUsed;
      for (const gi of applied.journalIssues) {
        allIssues.push({ code: 'JOURNAL_WRITE_FAILED', path: '$.turn_changes', message: gi, severity: 'error', retryable: false });
      }
      if(input.historyRepair&&(applied.journalIssues.length||groupResults.some(g=>g.status==='rejected'||g.status==='blocked')))throw new AtlasDbError('HISTORY_REPAIR_FAILED','历史修复未通过引用、外键或日志校验；候选未发布',{groups:groupResults});

      const rejected = groupResults.filter((g) => g.status === 'rejected');
      const rejectedSnapshot = [...rejected];
      // 4) 一次定向纠错（每个响应批次最多一次）
      if (rejected.length > 0 && !input.manual && options.modelPort) {
        // The candidate is isolated; release its transaction before waiting for
        // the repair model, then resume writing the same candidate afterward.
        preparationStep='before-repair';
        commitTransaction(candidateDb);
        transactionOpen = false;
        const repairOutcome = await runRepair({
          candidateDb,
          rejected,
          compiled,
          anchor,
          clockBefore,
          rev,
          sourceSnapshot,
          attempts,
          allIssues,
          modelPort: modelPort!,
          makeId,
          turnId,
        });
        beginTransaction(candidateDb);
        transactionOpen = true;
        repairAttempted = true;
        if (repairOutcome.applied.length > 0) {
          const second = applyGroups(candidateDb, repairOutcome.applied, {
            branchId,
            turnId,
            attemptId: 'repair',
            validate: true,
          });
          groupResults = reconcileRepairResults(groupResults, second.groups, rejectedSnapshot);
        }
      }

      if (input.worldBuild) {
        worldBuildWindow = prepareWorldBuildWindow({ db: candidateDb, input, turnId, makeId });
        input = worldBuildWindow.input;
        sourceSnapshot = input.sourceSnapshot;
        const stateApplied = applyGroups(candidateDb, worldBuildWindow.groups, { branchId, turnId, attemptId: 'world-build-plan', validate: true });
        groupResults.push(...stateApplied.groups);
        if (stateApplied.journalIssues.length || stateApplied.groups.some(group => group.status === 'rejected' || group.status === 'blocked'))
          throw new AtlasDbError('WORLD_BUILD_STATE_WRITE_FAILED', '建设计划未通过日志或一致性校验', { groups: stateApplied.groups });
        allIssues.push(...worldBuildWindow.issues);
        if (worldBuildWindow.operations.length || worldBuildWindow.records.length) {
          const refs = scanKnownRefs(tables, branchId, { requiredRefs: worldBuildWindow.operations.flatMap(op => {
            const ref = op.value.ref;
            const own = ref && !ref.startsWith('new:') ? [{ id: ref, kind: op.value.op.startsWith('character.') ? 'character' as const : op.value.op.startsWith('route.') ? 'route' as const : 'location' as const }] : [];
            const locations = ['parent_ref','from_ref','to_ref','location_ref'].flatMap(key=>{ const id=op.value.data?.[key]; return typeof id==='string'&&!id.startsWith('new:')?[{id,kind:'location' as const}]:[]; });
            const map = op.value.data?.['map_ref'];
            return [...own,...locations,...(typeof map==='string'?[{id:map,kind:'map' as const}]:[])];
          }) }).refs;
          const program = compileOperations({ operations: worldBuildWindow.operations, anchor, phase: 'geography', clockS: clockBefore, revision: rev,
            tables, sources: { phase: 'geography', snapshot: sourceSnapshot, clockS: clockBefore }, makeId, knownRefs: refs, turnId,
            allowedOps: ['location.upsert', 'route.propose', 'character.upsert'] });
          const builtProgram = buildAtomicGroups(program.results.map(entry => ({ opId: entry.opId, ...entry.result })));
          allIssues.push(...program.issues, ...builtProgram.issues);
          const programGroups = [...orderGroups(builtProgram.groups).order];
          if (worldBuildWindow.records.length) programGroups.push({ id: `world-build:${turnId}:records`, purpose: 'bookkeeping', opIds: [],
            dependsOn: programGroups.map(group => group.id), readSet: [], mutations: worldBuildWindow.records });
          const appliedProgram = applyGroups(candidateDb, programGroups, { branchId, turnId, attemptId: 'world-build-local', validate: true });
          groupResults.push(...appliedProgram.groups);
          parsedOperations.push(...worldBuildWindow.operations);
          for (const result of appliedProgram.groups) allIssues.push(...result.issues);
          if (appliedProgram.journalIssues.length) throw new AtlasDbError('JOURNAL_WRITE_FAILED', '本地建设结果日志未保存', {});
        }
      }

      /* ───────── M3-10/11：世界建设阶段（01 §4 优先级；在 settle 之前，
         让本轮后台决策能读到刚建好的结构）───────── */
      // 单一本回合局部预算：前景 + 纠错（attempts）为起点，建设与布局共用同一个 port，
      // 绝不使用全局 activeBudget —— 不同聊天 / 并发任务的预算互相隔离。
      // 「后台优先」是**预算优先**：观察/纠错后先给已到期的后台决策留一个名额，
      // 建设与布局不得吃掉它；没有到期工作不保留，未使用必须显式释放。
      const dueBackgroundWork = input.manual || input.sceneOnly ? 0 : countDueBackgroundActions(tables, branchId, clockBefore);
      const backgroundReserved = dueBackgroundWork > 0 ? turnBudget.reserveBackground(`bg_due_${turnId}`) : false;
      const construction = {
        attempted: false,
        deferred: false,
        status: null as WorldFillStatus | null,
        reasonCode: null as string | null,
        /** 完成状态所属图（P07/R04）：每条焦点各自解析，不再用单张图代表整批。 */
        completionMapIds: [] as string[],
        contextHash: '',
        task: null as GenerationTask<ModelBatchRequest> | null,
        createdLocationIds: [] as string[],
        createdRouteIds: [] as string[],
        remainingLocationIds: [] as string[],
        /** P09B/R01：持久目标队列的本批计划（null = 未启用或状态不可用）。 */
        queuePlan: null as ConstructionQueuePlan | null,
        queue: null as null | { scopeKey: string; selectedTargets: number; pendingTargets: number; freshUnits: number; retryUnits: number; noPending: boolean },
        /** 本批队列结算：processed（结构处理成功）/ retry（失败，等后续续建）/ none（未发出请求）。 */
        queueOutcome: 'none' as 'none' | 'processed' | 'retry',
        queueCovered: [] as string[],
        queueFailureCode: '',
        /** P10/R02：本批真正消费（进入请求）的来源块键。 */
        sourceCovered: [] as string[],
        /**
         * P03 §9.1 覆盖账本：来源到底读完了没有。
         *
         * 由 `planConstructionSources` 产出，**只在这里算一次** —— 回执、UI、完成率
         * 都引用同一个对象，不各自拿 chunk 计数再推一遍（推出来的数字迟早对不上）。
         */
        sourceCoverage: null as SourceCoverageV1 | null,
        /** P10/R02：本单元已接受的 new: 别名 → 真实 ID（部分成功时留给重试做转换）。 */
        bindings: {} as Record<string, string>,
      };
      if (!input.manual && !input.constructionMode && input.worldCompletion && options.modelPort) {
        // P08/R05：必要引用装不下时 builder 返回 null 并把明确错误交回来（本批发送次数 0）。
        const constructionReport: { issues: PlanIssue[] } = { issues: [] };
        // P09B/R01：先由持久队列决定本批焦点。队列空了就不再发建设请求（零请求即「暂无待处理」）。
        const queuePolicy = normalizeCompletionPolicy(input.worldCompletion.policy);
        construction.queuePlan = planConstructionQueue({
          scopeKeyOverride: worldBuildWindow ? `world-build-sources:${worldBuildWindow.job.id}` : undefined,
          sourceScan: Boolean(worldBuildWindow),
          tables,
          branchId,
          chatUid: anchor.chatUid,
          mode: input.worldCompletion.mode === 'bootstrap' ? 'bootstrap' : 'local',
          focusLocationIds: input.worldCompletion.focusLocationIds,
          policy: queuePolicy,
          turnId,
          // P10/R02：来源选取与目标队列在同一处算，两者共用同一份 chat/branch 缓存与预算。
          sourceSnapshot: worldBuildWindow ? sourceSnapshot.filter(source => source.kind === 'lorebook') : sourceSnapshot,
          sourceFocusTerms: input.worldCompletion.focusTerms,
          sourceMaxChars: input.worldCompletion.sourceMaxChars,
          sourceChunkChars: input.worldCompletion.sourceChunkChars,
          worldSourceCache: input.worldSourceCache,
        });
        const queuePlan = construction.queuePlan;
        if (queuePlan) {
          construction.sourceCoverage = queuePlan.sourcePlan?.coverage ?? null;
          construction.queue = {
            scopeKey: queuePlan.scopeKey,
            selectedTargets: queuePlan.focusIds.length,
            pendingTargets: queuePlan.discovery.enqueueIds.length,
            freshUnits: queuePlan.freshUnitCount,
            retryUnits: queuePlan.retryUnitCount,
            noPending: queuePlan.focusIds.length === 0 && !queuePlan.sourceSelection?.chunks.length,
          };
          if (queuePlan.discovery.truncated) {
            allIssues.push({
              code: 'WORLD_TARGETS_DISCOVERY_TRUNCATED',
              path: '$.worldCompletion',
              message: `本轮目标发现达到 ${queuePlan.discovery.scannedRows} 行上限；扫描游标已持久保存，下一批继续（不静默丢弃）。`,
              severity: 'warning',
              retryable: true,
            });
          }
          // P10/R02：装不下的块是**显式延期**，不是静默截断。有不存在的冻结块（hash 变更等）也要说清楚。
          const deferredChunks = queuePlan.sourceSelection?.deferred ?? [];
          if (deferredChunks.length > 0) {
            const missing = deferredChunks.filter((item) => item.index < 0).length;
            allIssues.push({
              code: 'WORLD_SOURCE_DEFERRED',
              path: '$.worldCompletion.sources',
              message: `来源块有 ${deferredChunks.length} 块本批未纳入（预算不足或原文已变化${missing > 0 ? `，其中 ${missing} 块在当前来源快照中已不存在` : ''}）；块键与偏移已持久保存，下一批继续。`,
              severity: 'warning',
              retryable: true,
            });
          }
        }
        const task = queuePlan && queuePlan.focusIds.length === 0 && !worldBuildWindow ? null : buildSqlWorldCompletionTask(tables, branchId, {
          sourceScan: Boolean(worldBuildWindow),
          mode: input.worldCompletion.mode,
          focusLocationIds: queuePlan ? queuePlan.focusIds : input.worldCompletion.focusLocationIds,
          policy: input.worldCompletion.policy,
          chatUid: anchor.chatUid,
          baseRevision: anchor.baseRevision,
          baseStorageRevision: anchor.baseStorageRevision,
          sourceSnapshot,
          requiredRefs: input.requiredRefs,
          // P10/R02：直接用队列算好的来源选取结果（同一份账本），不在这里二次选取。
          sourceSelection: queuePlan?.sourceSelection ?? undefined,
        }, turnId, turnBudget.stageRemaining('geography'), constructionReport);
        if (constructionReport.issues.length > 0) {
          allIssues.push(...constructionReport.issues.map((item) => ({
            code: item.code,
            path: item.path,
            message: item.message,
            severity: item.severity,
            retryable: item.retryable,
          })));
          construction.deferred = true;
          construction.reasonCode = construction.reasonCode ?? constructionReport.issues[0].code;
        }
        if (!task) {
          // 无缺项 / contextHash 未变 / 无目标 / 没预算：不是失败，但要如实记 deferred。
          construction.deferred = true;
          const queueEmpty = Boolean(construction.queue?.noPending);
          construction.reasonCode = construction.reasonCode ?? (queueEmpty
            ? 'WORLD_CONSTRUCTION_QUEUE_EMPTY'
            : turnBudget.stageRemaining('geography') === 0 ? 'MODEL_BUDGET_EXHAUSTED' : 'WORLD_CONSTRUCTION_NOT_NEEDED');
          if (construction.reasonCode === 'MODEL_BUDGET_EXHAUSTED') allIssues.push({ code: 'MODEL_BUDGET_EXHAUSTED', path: '$.worldCompletion', message: '本轮传输额度已用尽，空间建设待下一批继续。', severity: 'warning', retryable: true });
        } else {
          construction.contextHash = task.contextHash;
          // 旧口径 `remainingLocationIds` 继续成立：本任务自身的溢出 + **持久队列里没被本批覆盖**的目标。
          // 这两者都是「下一批继续」的真实待办，任何一个都不能静默消失。
          construction.remainingLocationIds = [...new Set([
            ...task.remainingLocationIds,
            ...(construction.queuePlan?.remainingTargetIds ?? []),
          ])];
          // 完成状态所属图在**场景地图步骤之后**再解析：容器图可能正是本轮 sceneMaps 才建出来的。
          // 此处不再用 firstFocus.map_id（外部图）预填，避免读内部图、写外部图的归属错位。
          const claim = turnBudget.stageRemaining('geography') > 0 ? { ok: true } : { ok: false, reason: '本轮传输预算已用尽' };
          if (!claim.ok) {
            construction.deferred = true;
            construction.reasonCode = 'MODEL_BUDGET_EXHAUSTED';
            allIssues.push({ code: 'MODEL_BUDGET_EXHAUSTED', path: '$.worldCompletion', message: `空间建设未执行：${claim.reason}。已登记的世界数据保留，下一轮继续。`, severity: 'warning', retryable: true });
          } else {
            construction.attempted = true;
            construction.task = task;
            preparationStep = 'before-construction';
            commitTransaction(candidateDb);
            transactionOpen = false;
            // R06：起止必须在真正发起请求的前后取，且一次请求只记一条 attempt。
            const constructionRequestStarted = now();
            let constructionAttemptWritten = false;
            const writeConstructionAttempt = (extra: Record<string, unknown>): void => {
              if (constructionAttemptWritten) return;
              constructionAttemptWritten = true;
              recordAttempt({ kind: 'construction', phase: 'geography', started_wall_ms: constructionRequestStarted, ...extra });
            };
            try {
              let response: ModelBatchResponse;
              try {
                response = await modelPort!.request(task.request);
              } catch (requestError) {
                // 失败 / 取消 / 超时同样要有真实起止与失败类型；没有响应就不写 http_status。
                writeConstructionAttempt({ failure_kind: failureKindOf(requestError), error: (requestError as Error).message });
                throw requestError;
              }
              writeConstructionAttempt({
                http_status: response.httpStatus,
                response_chars: response.text?.length ?? 0, response_hash: sha256HexSync(response.text ?? ''),
                finish_reason: response.finishReason,
              });
              if ((input.isCurrent && !input.isCurrent()) || currentRevision() !== anchor.baseRevision) {
                throw new AtlasDbError('STALE_BASE', '世界建设期间聊天或世界修订已变化，候选不发布', {});
              }
              beginTransaction(candidateDb);
              transactionOpen = true;
              // 解析必须使用**原始冻结目录**（task.catalogue）：不重新收集、不重新编号 alias。
              const extracted = extractPayload(response.text ?? '');
              const parsedConstruction = parseOperations(extracted.payload, { phase: 'geography' });
              allIssues.push(...extracted.issues, ...parsedConstruction.issues);
              const readPort = createTableReadPort(candidateDb);
              const aliases = new Map(task.catalogue.knownRefs.map(ref => [ref.alias, ref.id]));
              // P10/R02 §17.3 部分成功：上一次尝试**已接受**的 new: 别名 → 真实 ID。
              // 重试先把它们换回当前分支真实引用，再去重/编译 —— 因此不会重新创建同一地点
              // 或同一已绑定路线。转换只作用于注册的引用字段（ref / *_ref），不碰姓名、描述、
              // 装饰 ID 或家具局部 ID（那些键名不是 ref 后缀）。
              const reusedBindings: Record<string, string> = { ...(construction.queuePlan?.unit?.bindings ?? {}) };
              for (const [alias, id] of Object.entries(reusedBindings)) aliases.set(alias, id);
              const resolveRefs = (value: unknown): unknown => typeof value === 'string' ? aliases.get(value) ?? value : Array.isArray(value) ? value.map(resolveRefs) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === 'ref' || key.endsWith('_ref') || typeof child === 'object' ? resolveRefs(child) : child])) : value;
              // 去重覆盖同一候选分支的全部现有地点；冻结的模型目录可能只含当前场所，
              // 不能因此把观察阶段已建成的远处房间再次新建。这里只扩展程序索引，不重编号模型 alias。
              const existingLocations = queryBound(candidateDb, 'SELECT id FROM locations WHERE branch_id = ? AND status = ?', [branchId, 'active'])
                .map(row => readPort.selectOne('locations', branchId, String(row.id)))
                .filter((row): row is Record<string, unknown> => !!row);
              const deduped = dedupeWorldConstructionOps({
                operations: (()=>{
                  const separated=separateConstructionRouteRefs(parsedConstruction.operations.map(op=>op.value),Object.keys(reusedBindings).filter(alias=>readPort.selectOne('locations',branchId,reusedBindings[alias])));
                  allIssues.push(...separated.issues);
                  return separated.operations.map(op=>resolveRefs(op) as ParsedOperation['value']);
                })(),
                existingLocations,
              });
              const declaredNewRefs = parsedConstruction.operations
                .map((op) => String(op.value.ref ?? ''))
                .filter((ref) => ref.startsWith('new:'));
              const constructionRefs = [...task.catalogue.knownRefs];
              for (const reused of deduped.reusedIds) {
                if (!constructionRefs.some(ref => ref.id === reused.id)) {
                  const row = existingLocations.find(row => row.id === reused.id)!;
                  constructionRefs.push({ alias: reused.id, id: reused.id, kind: 'location', rowRev: Number(row.row_rev ?? 0) });
                }
              }
              // 已绑定过的真实 ID 必须进目录（否则会被当成 new 再建一次）。
              for (const id of Object.values(reusedBindings)) {
                if (constructionRefs.some(ref => ref.id === id)) continue;
                const row = existingLocations.find(item => item.id === id);
                if (row) constructionRefs.push({ alias: id, id, kind: 'location', rowRev: Number(row.row_rev ?? 0) });
              }
              const normalized = normalizeConstructionOps({
                operations: deduped.operations,
                knownIds: constructionRefs.map((ref) => ref.id),
                declaredNewRefs,
                protectedLocationFacts: Object.fromEntries(existingLocations.map(row => [String(row.id), {
                  ...(row.existence_quality === 'confirmed' && row.parent_location_id ? { parentRef: String(row.parent_location_id) } : {}),
                  position: row.coord_precision === 'exact', area: row.existence_quality === 'confirmed' && !!row.area_geometry_json,
                  areaValue: row.area_geometry_json,
                }])),
                policy: input.worldCompletion.policy,
              });
              allIssues.push(...deduped.issues, ...normalized.issues);
              const cleanNoop = !parsedConstruction.incomplete
                && !parsedConstruction.issues.some(issue=>issue.severity==='error')
                && normalized.protectedDrops.length===0
                && normalized.operations.every(op=>op.op==='noop')
                && (normalized.operations.length>0 || parsedConstruction.explicitNoop);
              const constructionParsed: ParsedOperation[] = normalized.operations.filter(op=>op.op!=='noop').map((value, index) => {
                const raw = JSON.stringify(value);
                return { opId: `cons_${index}_${sha256HexSync(raw).slice(0, 8)}`, line: index + 1, rawHash: sha256HexSync(raw), value };
              });
              if (constructionParsed.length === 0 && !cleanNoop) {
                construction.status = 'deferred';
                construction.reasonCode = construction.reasonCode ?? 'WORLD_CONSTRUCTION_EMPTY';
                // 模型没给出任何可应用的结构操作 → 这一单元没处理成功，进重试（不能静默丢弃目标）。
                construction.queueOutcome = 'retry';
                construction.queueFailureCode = 'WORLD_CONSTRUCTION_EMPTY';
              } else {
                const compiledConstruction = compileOperations({
                  operations: constructionParsed, anchor, phase: 'geography', clockS: clockBefore, revision: rev,
                  tables: readPort, sources: { phase: 'geography', snapshot: construction.queuePlan?.sourceSelection ? sourceSnapshot.filter(source => construction.queuePlan?.sourceSelection?.chunks.some(chunk => chunk.sourceKey === source.key)) : sourceSnapshot, clockS: clockBefore }, makeId,
                  knownRefs: constructionRefs, turnId, allowedOps: WORLD_CONSTRUCTION_OPS,
                });
                allIssues.push(...compiledConstruction.issues);
                const groupsConstruction = buildAtomicGroups(compiledConstruction.results.map((r) => ({
                  opId: r.opId, issues: r.result.issues, mutations: r.result.mutations, readSet: r.result.readSet,
                  dependencies: r.result.dependencies, entityKeyWrites: r.result.entityKeyWrites, operationKeys: r.result.operationKeys,
                })));
                const orderedConstruction = orderGroups(groupsConstruction.groups);
                allIssues.push(...groupsConstruction.issues, ...orderedConstruction.issues);
                // 与前景同一 journal / ACK：同一候选事务、同一 turnId、attemptId=construction。
                const appliedConstruction = applyGroups(candidateDb, orderedConstruction.order, { branchId, turnId, attemptId: 'construction', validate: true });
                groupResults.push(...appliedConstruction.groups);
                parsedOperations.push(...constructionParsed);
                for (const message of appliedConstruction.journalIssues) {
                  allIssues.push({ code: 'JOURNAL_WRITE_FAILED', path: '$.worldCompletion', message, severity: 'error', retryable: false });
                }
                const appliedGroupIds = new Set(appliedConstruction.groups.filter((g) => g.status === 'applied').map((g) => g.groupId));
                for (const group of orderedConstruction.order) {
                  if (!appliedGroupIds.has(group.id)) continue;
                  for (const mutation of group.mutations) {
                    if (mutation.before !== null) continue; // 只记本次新建
                    if (mutation.table === 'locations') construction.createdLocationIds.push(mutation.rowId);
                    if (mutation.table === 'routes') construction.createdRouteIds.push(mutation.rowId);
                  }
                }
                const rejected = appliedConstruction.groups.filter((g) => g.status === 'rejected' || g.status === 'blocked');
                const ok = appliedConstruction.groups.filter((g) => g.status === 'applied' || g.status === 'duplicate');
                // 独立合法地点可以保存；只有相关组失败时状态为 partial（W08）。
                const pending = normalized.protectedDrops.length > 0 || normalized.issues.some(issue => issue.retryable) || deduped.issues.some(issue => issue.retryable) || task.remainingLocationIds.length > 0 || (construction.queuePlan?.remainingTargetIds.length ?? 0) > 0;
                construction.status = rejected.length === 0 && !pending ? 'ready' : ok.length > 0 ? 'partial' : 'deferred';
                if (pending) {
                  construction.reasonCode = 'WORLD_CONSTRUCTION_DEFERRED';
                  construction.remainingLocationIds = [...new Set([...construction.remainingLocationIds, ...task.focusLocationIds])];
                }
                if (rejected.length > 0) construction.reasonCode = 'WORLD_CONSTRUCTION_PARTIAL';
                /* P10/R02 §17.3 保守整体确认：已接受的新实体登记绑定，供下一次重试先做转换。 */
                const opRefById = new Map(constructionParsed.map((op) => [op.opId, String((op.value as Record<string, unknown>)?.ref ?? '')]));
                for (const group of orderedConstruction.order) {
                  if (!appliedGroupIds.has(group.id)) continue;
                  const createdLocation = group.mutations.find((m) => m.table === 'locations' && m.before === null);
                  const createdRoute = group.mutations.find((m) => m.table === 'routes' && m.before === null);
                  if (!createdLocation && !createdRoute) continue;
                  for (const opId of group.opIds) {
                    const ref = opRefById.get(opId) ?? '';
                    if (!ref.startsWith('new:')) continue; // 显式 new: 才需要绑定
                    const target = createdLocation?.rowId ?? createdRoute?.rowId;
                    if (target) construction.bindings[ref] = target;
                  }
                }
                /* P09B/R01 + P10/R02：结构处理成功 → **本批真正请求到的目标**转 processed
                   （这是「一次有效结构处理」，不是「世界完整」）；失败/被拒/被剔除 → 单元转 retry，
                   等后续显式续建/正常任务再排。布局失败不在这里结算：它只进布局待办，
                   不把已处理的结构单元退回建世界阶段（QUEUE05）。 */
                const deferredOps = normalized.issues.some((issue) => issue.code === 'WORLD_CONSTRUCTION_DEFERRED');
                const confirmation = canConfirmUnit({
                  // 走到这里 = 请求已返回、未超时、未被判 stale（stale 会直接抛 STALE_BASE）。
                  requestCompleted: true,
                  payloadComplete: !parsedConstruction.incomplete,
                  normalizedClean: normalized.protectedDrops.length === 0,
                  appliedClean: rejected.length > 0 ? false : ok.length > 0 || cleanNoop,
                  identityResolved: !deferredOps
                    && !deduped.issues.some((issue) => issue.retryable)
                    && !compiledConstruction.issues.some((issue) => issue.severity === 'error')
                    && !groupsConstruction.issues.some((issue) => issue.severity === 'error'),
                  // 账本写入与业务写入在**同一候选事务**里：候选没拿到 saved ACK 时整份信封被丢弃，
                  // 账本一个字节都不会生效。所以这里为 true 是结构上成立的，不是「乐观假设」。
                  savedAck: true,
                });
                if (confirmation.ok) {
                  construction.queueOutcome = 'processed';
                  construction.queueCovered = [...task.focusLocationIds];
                  construction.sourceCovered = [...(construction.queuePlan?.sourcePlan?.chunkKeys ?? [])];
                } else {
                  construction.queueOutcome = 'retry';
                  construction.queueFailureCode = confirmation.reasons[0] || construction.reasonCode || 'WORLD_CONSTRUCTION_PARTIAL';
                  allIssues.push({
                    code: 'WORLD_CONSTRUCTION_UNIT_RETRY',
                    path: '$.worldCompletion.unit',
                    message: `本单元未满足「一次有效结构处理」的全部条件（${confirmation.reasons.join('、')}）：已接受的业务组已保存，单元与来源块留 retry，不推进来源游标。`,
                    severity: 'warning',
                    retryable: true,
                  });
                }
              }
            } catch (error) {
              if (!transactionOpen) { beginTransaction(candidateDb); transactionOpen = true; }
              if (error instanceof AtlasDbError && error.code === 'STALE_BASE') throw error;
              turnBudget.finishBatch(task.request.batchId, 'failed');
              construction.deferred = true;
              construction.status = 'deferred';
              construction.reasonCode = 'WORLD_CONSTRUCTION_FAILED';
              // P09B/R01：请求/解析失败 → 单元转 retry（attemptCount+1），目标退回 pending 等下批。
              construction.queueOutcome = 'retry';
              construction.queueFailureCode = 'WORLD_CONSTRUCTION_FAILED';
              construction.bindings = { ...(construction.queuePlan?.unit?.bindings ?? {}) };
              allIssues.push({ code: 'WORLD_CONSTRUCTION_FAILED', path: '$.worldCompletion', message: `世界建设未完成：${(error as Error).message}。本轮已登记的前景实体全部保留，可下一轮继续。`, severity: 'warning', retryable: true });
              // R06：若失败发生在请求之前（编译/解析等），这里补一条带真实起止的记录；
              // 若请求本身已记账，则不重复写第二条。
              writeConstructionAttempt({ failure_kind: failureKindOf(error), error: (error as Error).message });
            }
          }
        }
      }

      /* ───────── P09B/R01：把本批队列结算落盘（bookkeeping 组，随同一 ACK）─────────
         候选最终没保存时这里一个字节都不会生效 —— 正式调度次序不前进。
         结构处理成功的目标变 processed；失败/被拒的单元转 retry；其余发现的 pending 目标保持，
         下一批 3 新 : 1 重试的轮转继续把它们处理掉。 */
      if (construction.queuePlan) {
        const queuePlan = construction.queuePlan;
        const settled = construction.queueOutcome === 'processed'
          ? queuePlan.processedMutations(construction.queueCovered, construction.bindings)
          : construction.queueOutcome === 'retry'
            ? queuePlan.failedMutations(construction.queueFailureCode || 'WORLD_CONSTRUCTION_FAILED', construction.bindings)
            : [];
        /* P10/R02：来源账本结算与目标队列**同一个组、同一个 ACK**。
           成功 → 本批真正消费的块转 processed，来源游标按「连续成功前缀」推进；
           失败/部分成功 → 本批涉及的块转 retry，游标**不前进**（不越过缺口）。
           未发出请求（none）时一个块状态都不改。 */
        const sourceSettled = !queuePlan.sourcePlan ? [] : construction.queueOutcome === 'processed'
          ? queuePlan.sourcePlan.processedMutations(construction.sourceCovered)
          : construction.queueOutcome === 'retry'
            ? queuePlan.sourcePlan.retryMutations(
                construction.queueFailureCode || 'WORLD_CONSTRUCTION_FAILED',
                (queuePlan.unit?.attemptCount ?? 0) + 1 >= MAX_UNIT_ATTEMPTS,
              )
            : [];
        const progressGroup = constructionProgressGroup([...queuePlan.preMutations, ...settled, ...sourceSettled]);
        if (progressGroup) {
          if (!transactionOpen) { beginTransaction(candidateDb); transactionOpen = true; }
          const appliedProgress = applyGroups(candidateDb, [progressGroup], { branchId, turnId, attemptId: 'construction-progress', validate: true });
          groupResults.push(...appliedProgress.groups);
          for (const message of appliedProgress.journalIssues) {
            allIssues.push({ code: 'JOURNAL_WRITE_FAILED', path: '$.worldCompletion.progress', message, severity: 'error', retryable: false });
          }
          const failedProgress = appliedProgress.groups.filter((g) => g.status === 'rejected' || g.status === 'blocked');
          if (failedProgress.length > 0) {
            allIssues.push({
              code: 'WORLD_CONSTRUCTION_PROGRESS_NOT_WRITTEN',
              path: '$.worldCompletion.progress',
              message: `建设进度未记账：${failedProgress[0].issues.map((i) => i.message).join('；') || failedProgress[0].status}。本批结构结果仍按实际写入记账。`,
              severity: 'warning',
              retryable: true,
            });
          }
          /* 本批没覆盖完的目标仍要等下一批：它们已经落在持久 pending 行里，
             同时继续出现在兼容字段 remainingLocationIds 中，且本批不能报 ready。 */
          if (construction.queueOutcome === 'processed' && queuePlan.remainingTargetIds.length > 0 && construction.status === 'ready') {
            construction.status = 'partial';
            allIssues.push({
              code: 'WORLD_TARGETS_TRUNCATED',
              path: '$.worldCompletion',
              message: `本批候选目标超过单批上限：已处理 ${queuePlan.focusIds.length} 个，剩余 ${queuePlan.remainingTargetIds.length} 个完整 ID 已进持久队列，下一批继续（不静默丢弃）。`,
              severity: 'warning',
              retryable: false,
            });
          }
        }
      }

      if(input.legacyImport!==undefined){
        const imported=applySqlLegacyImport({db:candidateDb,branchId,turnId,clockS:clockBefore,nowWallMs:now(),rulesetVersion,makeId,legacy:input.legacyImport});
        groupResults.push(imported.result);allIssues.push(...imported.issues);
      }
      if(input.sceneMaps||input.mapCalibration||input.mapBackground||input.mapProfile){
        const mapGroup=compileSqlSceneMaps({db:candidateDb,branchId,turnId,clockS:clockBefore,makeId,ensureScenes:input.sceneMaps,calibration:input.mapCalibration,povName:input.povName,background:input.mapBackground,profile:input.mapProfile});
        if(mapGroup){
          const mapResult=applyGroups(candidateDb,[mapGroup],{branchId,turnId,attemptId:'scene-maps',validate:true});
          if(mapResult.journalIssues.length||mapResult.groups.some(group=>group.status==='rejected'||group.status==='blocked'))
            throw new AtlasDbError('SCENE_MAP_WRITE_FAILED','地图结构候选未通过校验',{groups:mapResult.groups,journal:mapResult.journalIssues});
          groupResults.push(...mapResult.groups);
        }
      }
      if(input.mapBackground?.asset){
        const asset=input.mapBackground.asset;
        (candidates.get(candidate.token) as StoredCandidate).assets=[...envelopeAssets.filter(old=>old.key!==asset.key),asset];
      }
      // All program/model settlement belongs to this same isolated floor. No SQL
      // transaction is held across its model requests; host publication remains later.
      preparationStep='before-simulation';
      commitTransaction(candidateDb);
      transactionOpen = false;
      const simulation = await settleSqlTurn({ db: candidateDb, branchId, anchor, turnId, clockBefore,
        sceneOnly:input.sceneOnly,
        generationOptions,
        operations: input.sceneOnly?[]:parsedOperations, modelPort: input.manual||input.sceneOnly || !windowPort ? null : logModelAttempts(bindModelBudget(windowPort, turnBudget, 'background'),now,recordAttempt),
        // M3-11：settle 用**同一本回合预算**的剩余额度，不另起计数；被保留给到期后台的名额
        // 在 stageRemaining 里已经扣掉，所以建设不会抢先吃掉它。
        modelBudget: Math.max(0, turnBudget.stageRemaining('background')),
        workBudget:turnBudget,
        makeId, isCurrent: input.isCurrent });
      beginTransaction(candidateDb);
      transactionOpen = true;
      // settle 的每次实际发送已经通过绑定 port 记入同一本账。
      // 后台名额的使命到此结束：未使用必须释放，否则会白占一个额度。
      if (backgroundReserved) turnBudget.releaseBackground();
      allIssues.push(...simulation.issues);
      groupResults.push(...simulation.groups);
      parsedOperations.push(...simulation.modelOperations);
      timeChanged = simulation.clockAfter !== clockBefore;

      // Entities/maps must exist before the model can reference them. Release the
      // isolated candidate transaction during the spatial model request as well.
      // P08/R05：布局目录的必要引用超预算时 builder 返回 null 并把明确错误交回来（本批发送次数 0）。
      const layoutReport: { issues: PlanIssue[] } = { issues: [] };
      const drainLayoutReport = (): void => {
        if (layoutReport.issues.length === 0) return;
        allIssues.push(...layoutReport.issues.map((item)=>({code:item.code,path:item.path,message:item.message,severity:item.severity,retryable:item.retryable})));
        layoutReport.issues.length = 0;
      };
      let mapBatchesRemaining=generationOptions.workBatching?.mapBatches??Number.MAX_SAFE_INTEGER;
      const applyFunctionalAreas=(mapIds:readonly string[],requireCurrentInputs:boolean):void=>{
        const plan=planFunctionalAreaProjections({tables:createTableReadPort(candidateDb),branchId,turnId,mapIds,requireCurrentInputs});
        allIssues.push(...plan.issues);
        if(plan.groups.length){
          const result=applyGroups(candidateDb,plan.groups,{branchId,turnId,attemptId:'functional-areas',validate:true});
          groupResults.push(...result.groups);
          if(result.journalIssues.length||result.groups.some(group=>group.status==='rejected'||group.status==='blocked'))throw new AtlasDbError('FUNCTIONAL_AREA_WRITE_FAILED','功能分区未通过候选日志校验',{groups:result.groups,issues:result.journalIssues});
        }
      };
      if(Array.isArray(input.layoutMaps)&&input.layoutMaps.length)applyFunctionalAreas(input.layoutMaps,true);
      const layoutInput=worldBuildWindow&&Array.isArray(input.layoutMaps)?{...input,layoutMaps:input.layoutMaps.filter(mapId=>!worldBuildMapReady(candidateDb,branchId,mapId))}:input;
      let layoutTask=layoutInput.layoutMaps?buildSqlLayoutTask(candidateDb,branchId,layoutInput,turnId,layoutReport):null;
      drainLayoutReport();
      // Freeze the target set, then combine compatible maps inside its capacity.
      const pendingLayoutIds=layoutTask?[...layoutTask.mapIds,...layoutTask.remainingLocationIds]:[];
      const layoutParents=layoutTask?.parentMapIds??{};
      const evidenceMapRefs=pendingLayoutIds.map((id,index)=>({id,alias:`M${index+1}`,name:String(createTableReadPort(candidateDb).selectOne('maps',branchId,id)?.name??id)}));
      let layoutEvidenceCache:LayoutExcerpt[]|null=null;
      const evidenceBlockedMaps=new Set<string>();
      const deferredLayoutIds=new Set<string>();
      const retriedLayoutIds=new Set<string>();
      const smallerLayoutBatches=new Map<string,number>();
      const layoutTasks:NonNullable<typeof layoutTask>[]=[];
      // All stages and retries share the optional request cap chosen by the user.
      const layoutBudget=turnBudget;
      const canSupplement=()=>!generationOptions.workBatching||(turnBudget.workUsage()?.extra??0)<generationOptions.workBatching.extraRequests;
      const layoutModelPort=windowPort?bindModelBudget(windowPort,layoutBudget,'geography'):null;
      const requestSpatialWithTransportRetry=async(request:ModelBatchRequest,kind:string):Promise<ModelBatchResponse>=>{
        const started=now();
        try{return await layoutModelPort!.request(request);}
        catch(error){
          if((error as {retryable?:unknown})?.retryable!==true||layoutBudget.remaining()<=0||!canSupplement())throw error;
          recordAttempt({kind:`${kind}_transport_failed`,phase:'geography',started_wall_ms:started,finished_wall_ms:now(),input_chars:request.messages.reduce((sum,message)=>sum+message.content.length,0),...(request.batchTargets?{target_kind:request.batchTargets.kind,target_count:request.batchTargets.count}:{}),failure_kind:failureKindOf(error),error:(error as Error).message});
          allIssues.push({code:'LAYOUT_TRANSPORT_RETRIED',path:'$.layout',message:'空间模型连接出现可重试错误；本轮在额度内重新发送一次同一请求。',severity:'warning',retryable:false});
          await new Promise<void>(resolve=>setTimeout(resolve,1000));
          if(input.isCurrent&&!input.isCurrent()||currentRevision()!==anchor.baseRevision)throw new AtlasDbError('STALE_BASE','空间模型重试前聊天或世界修订已变化，候选不发布',{});
          return layoutModelPort!.request({...request,batchId:`${request.batchId}_transport_retry`,retryOf:request.batchId,diagnosticCause:'transport_retry'});
        }
      };
      let layoutApplied=false;
      let layoutEvidenceBlocked=false;
      const completedSpatialMaps=new Set<string>();
      let spatialPass=0;
      // M3/W03：布局请求结算 —— 仍在同一个受控候选事务内，before 最终外键/不变量检查。
      // 生成器是同步纯函数：这里不 await、不开新事务、不提交、不保存聊天。
      const spatialGuard = input.isCurrent ?? (() => true);
      const spatialPorts = {
        applyGroups: (db: SqlDatabase, groups: unknown[], ctx: ApplyGroupsContext) => applyGroups(db, groups as AtomicGroup[], ctx),
        isCurrent: spatialGuard,
        branchId,
        turnId,
        attemptId: 'spatial',
      };
      // M3/W08：UI 显式重试 —— 先把 failed 请求重新武装成 pending（只改状态与 ID）。
      if (input.layoutRetry && typeof input.layoutRetry.mapId === 'string' && input.layoutRetry.mapId) {
        const armed = armLayoutRetry({
          db: candidateDb,
          branchId,
          mapId: input.layoutRetry.mapId,
          requestId: input.layoutRetry.requestId,
          operationId: input.layoutRetry.operationId,
          turnId,
          ports: spatialPorts,
        });
        groupResults.push(...armed.groups);
        allIssues.push(...armed.issues);
      }
      // A saved failed request must be rearmed when its construction target is
      // selected again. Use the same journal path as the explicit layout retry.
      for(const target of worldBuildWindow?.selected??[]){
        if(target.workKind!=='map-layout'||!target.subjectId)continue;
        const frame=normalizeFrame(createTableReadPort(candidateDb).selectOne('maps',branchId,target.subjectId)?.frame_json);
        if((frame[SPATIAL_REQUEST_KEY] as {status?:unknown}|undefined)?.status!=='failed')continue;
        const armed=armLayoutRetry({db:candidateDb,branchId,mapId:target.subjectId,
          requestId:`build_${worldBuildWindow!.job.id}_${worldBuildWindow!.job.runEpoch}_${worldBuildWindow!.job.nextWindowSequence}_${target.subjectId}`,
          operationId:`build_retry_${target.id}`,turnId,ports:spatialPorts});
        groupResults.push(...armed.groups);allIssues.push(...armed.issues);
      }

      const materializeLayouts=():void=>{
        spatialPass++;
        // M4-21 / M4-23：本轮真正发出布局请求的图 → requestId，用于结算后写「结构指纹」。
        // 只有本轮被队列消费掉的请求才记指纹：布局失败/空响应绝不能被记成「这张图已布局完成」。
        const pendingRequestByMap = new Map<string, string>();
        const taskByMap=new Map(layoutTasks.flatMap(task=>task.mapIds.map(mapId=>[mapId,task] as const)));
        if (layoutApplied && taskByMap.size) {
          const scanPort = createTableReadPort(candidateDb);
          for (const mapId of taskByMap.keys()) {
            const row = scanPort.selectOne('maps', branchId, mapId);
            if (!row) continue;
            const frame = normalizeFrame(row.frame_json);
            const request = frame[SPATIAL_REQUEST_KEY];
            if (!request || typeof request !== 'object' || Array.isArray(request)) continue;
            if (String((request as Record<string, unknown>).status ?? 'pending') !== 'pending') continue;
            const requestId = String((request as Record<string, unknown>).requestId ?? `req_${mapId}`);
            pendingRequestByMap.set(mapId, requestId);
          }
        }

        const spatial = applyPendingSpatialRequests({
          db: candidateDb,
          scope: { chatId: anchor.chatUid, branchId, revision: rev, viewMode: 'author' },
          isCurrent: spatialGuard,
          turnId,
          clockS: clockBefore,
          autoPlan:true,
          respectParentDependencies:Boolean(generationOptions.workBatching),
          plannedExtents:generationOptions.workBatching?Object.assign({},...layoutTasks.map(task=>task.extents)):undefined,
          sourceText:[input.userText,input.assistantText,...sourceSnapshot.map(s=>s.text)].filter(Boolean).join('\n'),
        maxJobs:Number.MAX_SAFE_INTEGER,
          ports: spatialPorts,
        });
        groupResults.push(...spatial.groups);
        allIssues.push(...spatial.issues);
        const processedNow=new Set(spatial.processed);
        for(const [id,requestId] of pendingRequestByMap)if(processedNow.has(requestId))completedSpatialMaps.add(id);
        for(const id of spatial.completedMapIds??[])completedSpatialMaps.add(id);

        // M4-21 / M4-23：结构指纹结算 —— 只有「场景真的落成、请求已被消费」的图才记指纹。
        // 记上之后，成员/来源不变时 buildSqlLayoutTask 不再为同一张图重复请求模型（W07）。
        if (completedSpatialMaps.size) {
          applyFunctionalAreas([...completedSpatialMaps],false);
          const processedRequests = new Set(spatial.processed);
          const ctxPort = createTableReadPort(candidateDb);
          const ctxMutations: RowMutation[] = [];
          const completedMaps=new Map<string,string|undefined>([...completedSpatialMaps].map(id=>[id,undefined]));
          for(const id of spatial.completedMapIds??[])if(!completedMaps.has(id))completedMaps.set(id,undefined);
          for (const [mapId, requestId] of completedMaps) {
            const mapLayoutTask=taskByMap.get(mapId);
            if (requestId&&!processedRequests.has(requestId)) continue;
            const row = ctxPort.selectOne('maps', branchId, mapId);
            if (!row) continue;
            const rawFrame = row.frame_json;
            const frame: Record<string, unknown> = rawFrame && typeof rawFrame === 'object' && !Array.isArray(rawFrame)
              ? { ...(rawFrame as Record<string, unknown>) }
              : {};
            // 场景没落成、或请求还挂着（pending/failed）→ 这轮没真正布局完，不许记指纹。
            if (!frame.atlasScene) continue;
            const request = frame[SPATIAL_REQUEST_KEY];
            const requestStatus = request && typeof request === 'object' && !Array.isArray(request)
              ? String((request as Record<string, unknown>).status ?? '')
              : '';
            if (requestStatus === 'pending' || requestStatus === 'failed') continue;
            const hash=computeMapLayoutSignature(ctxPort,branchId,mapId)??mapLayoutTask?.contextHashes?.[mapId]??mapLayoutTask?.contextHash;
            const priorContext=frame[LAYOUT_CONTEXT_FRAME_KEY] as {hash?:string;completedTurnId?:string}|undefined;
            if(priorContext?.hash===hash&&priorContext?.completedTurnId===turnId)continue;
            ctxMutations.push({
              table: 'maps',
              rowId: mapId,
              before: { ...row },
              after: {
                ...row,
                frame_json: { ...frame, [LAYOUT_CONTEXT_FRAME_KEY]: { version: 3, hash, completedTurnId: turnId } },
                row_rev: Number(row.row_rev ?? 1) + 1,
                updated_turn_id: turnId,
              },
              sourceOpIds: [`layout_ctx_${spatialPass}_${mapId}`],
              basis: { kind: 'simulation', sources: [], causes: [], reason: `记录地图 ${mapId} 本轮布局所依据的结构指纹`, verification: 'causal', certainty: 'confirmed' },
            });
          }
          if (ctxMutations.length > 0) {
            const ctxGroup: AtomicGroup = {
              id: `grp_layout_ctx_${turnId}_${spatialPass}`,
              opIds: ctxMutations.map((m) => String((m.sourceOpIds ?? [])[0] ?? 'layout_ctx')),
              dependsOn: [],
              readSet: ctxMutations.map((m) => ({ table: 'maps', rowId: m.rowId, rowRev: Number((m.before as Record<string, unknown>).row_rev ?? 0) })),
              mutations: ctxMutations,
            };
            const appliedCtx = applyGroups(candidateDb, [ctxGroup], { branchId, turnId, attemptId: 'layout-context', validate: true });
            groupResults.push(...appliedCtx.groups);
            for (const message of appliedCtx.journalIssues) {
              allIssues.push({ code: 'JOURNAL_WRITE_FAILED', path: '$.layout.context', message, severity: 'error', retryable: false });
            }
          }
        }

      };
      while(layoutTask&&layoutModelPort&&layoutBudget.remaining()>0&&(mapBatchesRemaining>0||layoutTask.mapIds.some(id=>retriedLayoutIds.has(id)))){
        let currentLayoutTask=layoutTask;
        const attemptedMapIds=[...layoutTask.mapIds];
        const returnedMapIds=new Set<string>();
        let retryableBatchReply=false,splitAfterFailure=false;
        layoutTasks.push(layoutTask);
        preparationStep='before-layout';
        commitTransaction(candidateDb);transactionOpen=false;
        // R06：布局请求同样在真正发起前后取起止，一次请求只记一条 attempt。
        let layoutStarted:number|null=null;
        let layoutAttemptWritten=false;
        const writeLayoutAttempt=(extra:Record<string,unknown>):void=>{
          if(layoutAttemptWritten||layoutStarted===null)return;
          layoutAttemptWritten=true;
          recordAttempt({kind:'layout',phase:'geography',started_wall_ms:layoutStarted,target_kind:'maps',target_count:currentLayoutTask.mapIds.length,estimated_output_tokens:currentLayoutTask.request.batchTargets?.estimatedOutputTokens,...extra});
        };
        try{
          if(layoutEvidenceCache===null){
            const evidenceBatches=planLayoutEvidence(sourceSnapshot,evidenceMapRefs,anchor,`layout_${turnId}`,generationOptions.workBatching?{batchCount:generationOptions.workBatching.evidenceBatches}:{maxBatches:1});
            if(evidenceBatches[0]?.omittedBatches)allIssues.push({code:'LAYOUT_EVIDENCE_SCOPED',path:'$.layout.evidence',message:'资料较长，本次优先读取与所选地图有关的资料片段；其余内容未作为已验证位置依据。',severity:'warning',retryable:false});
            const layoutFacts:LayoutExcerpt[]=[];
            for(const batch of evidenceBatches){
              const evidenceStarted=now();
              let evidenceResponse=await requestSpatialWithTransportRetry(batch.request,'layout_evidence');
              recordAttempt({kind:'layout_evidence',phase:'geography',started_wall_ms:evidenceStarted,finished_wall_ms:now(),input_chars:batch.request.messages.reduce((sum,message)=>sum+message.content.length,0),response_chars:evidenceResponse.text?.length??0,http_status:evidenceResponse.httpStatus,response_hash:sha256HexSync(evidenceResponse.text??''),finish_reason:evidenceResponse.finishReason});
              if(input.isCurrent&&!input.isCurrent()||currentRevision()!==anchor.baseRevision)throw new AtlasDbError('STALE_BASE','位置依据提取期间聊天或世界修订已变化，候选不发布',{});
              if(evidenceResponse.finishReason==='length')throw new Error('位置依据提取输出被截断；本图未送入排版');
              const rejected:LayoutEvidenceRejection[]=[];
              let firstError:unknown=null,verified:LayoutExcerpt[]=[];
              try { verified=parseLayoutEvidence(evidenceResponse.text??'',batch.chunks,evidenceMapRefs,rejected,{complete:Boolean(generationOptions.workBatching)}); }
              catch(error){firstError=error;}
              if((firstError||rejected.length)&&!canSupplement()){
                const affected=firstError||rejected.some(r=>r.mapId===null)?evidenceMapRefs.map(m=>m.id):rejected.map(r=>r.mapId!);
                for(const id of affected)evidenceBlockedMaps.add(id);
                allIssues.push({code:"LAYOUT_EVIDENCE_PENDING",path:"$.layout.evidence",message:"部分位置依据未通过校验，额外请求额度已用尽；通过的片段保留，失败地图待处理。",severity:"warning",retryable:true});
                layoutFacts.push(...verified);continue;
              }
              if(firstError||rejected.length){
                if(layoutBudget.remaining()<=0)throw firstError??new Error(rejected.map(r=>r.message).join('；'));
                const affected=rejected.some(r=>r.mapId===null)||firstError?evidenceMapRefs.map(m=>m.id):[...new Set(rejected.map(r=>r.mapId!))];
                const repairContent=batch.request.messages[1].content+'\n【格式纠错】准确问题：'+(firstError instanceof Error?firstError.message:JSON.stringify(rejected))+'. 请重新核对受影响地图 '+affected.join('、')+'，只返回完整 JSON {"facts":[{"mapRef":"目录引用","segmentRef":"本批 S 编号"}]}。只选择已提供片段编号，不抄写或改写原文。没有相关片段则 facts=[]。';
                const repairRequest={...batch.request,batchId:batch.request.batchId+'_repair',retryOf:batch.request.batchId,diagnosticCause:'evidence_repair' as const,messages:batch.request.messages.map((message,index)=>index===1?{...message,content:repairContent}:message),promptInput:{...batch.request.promptInput!,injectionText:repairContent}};
                const repairStarted=now();
                evidenceResponse=await requestSpatialWithTransportRetry(repairRequest,'layout_evidence_repair');
                recordAttempt({kind:'layout_evidence_repair',phase:'geography',started_wall_ms:repairStarted,finished_wall_ms:now(),input_chars:repairRequest.messages.reduce((sum,message)=>sum+message.content.length,0),response_chars:evidenceResponse.text?.length??0,http_status:evidenceResponse.httpStatus,response_hash:sha256HexSync(evidenceResponse.text??''),finish_reason:evidenceResponse.finishReason});
                if(input.isCurrent&&!input.isCurrent()||currentRevision()!==anchor.baseRevision)throw new AtlasDbError('STALE_BASE','位置依据纠错期间聊天或世界修订已变化，候选不发布',{});
                if(evidenceResponse.finishReason==='length')throw new Error('位置依据纠错输出被截断；本图未送入排版');
                const remaining:LayoutEvidenceRejection[]=[];
                try { verified.push(...parseLayoutEvidence(evidenceResponse.text??'',batch.chunks,evidenceMapRefs,remaining,{complete:Boolean(generationOptions.workBatching)})); }
                catch(error){
                  if(firstError)throw error;
                  remaining.push(...affected.map(mapId=>({code:'LAYOUT_EVIDENCE_JSON',message:(error as Error).message,mapId,index:0})));
                }
                for(const row of remaining){
                  for(const mapId of row.mapId?[row.mapId]:affected)evidenceBlockedMaps.add(mapId);
                  allIssues.push({code:row.code,path:'$.layout.evidence',message:row.message,severity:'warning',retryable:true});
                }
                allIssues.push({code:'LAYOUT_EVIDENCE_RETRIED',path:'$.layout',message:'位置依据已定向纠错一次；通过校验的事实保留，未通过的地图单独延期。',severity:'warning',retryable:false});
              }
              layoutFacts.push(...verified);
            }
            layoutEvidenceCache=layoutFacts;
          }
          const eligibleMaps=currentLayoutTask.mapIds.filter(id=>!evidenceBlockedMaps.has(id));
          if(eligibleMaps.length!==currentLayoutTask.mapIds.length){
            for(const id of currentLayoutTask.mapIds)if(evidenceBlockedMaps.has(id))deferredLayoutIds.add(id);
            const narrowed=eligibleMaps.length?buildSqlLayoutTask(candidateDb,branchId,{...input,layoutMaps:eligibleMaps},`${turnId}_eligible_${layoutTasks.length}`,layoutReport):null;
            if(!narrowed)throw new Error('本批位置依据未通过校验；其他地图继续，本批等待重试');
            currentLayoutTask=layoutTask=narrowed;layoutTasks[layoutTasks.length-1]=narrowed;
          }
          const layoutRequest=attachLayoutEvidence(currentLayoutTask.request,layoutEvidenceCache,currentLayoutTask.mapIds);
          const isSupplement=currentLayoutTask.mapIds.some(id=>retriedLayoutIds.has(id));
          if(isSupplement){layoutRequest.retryOf=layoutTasks[0].request.batchId;layoutRequest.diagnosticCause=currentLayoutTask.mapIds.some(id=>smallerLayoutBatches.has(id))?'batch_split':'missing_map_reply';}
          else mapBatchesRemaining--;
          // Every real transport still claims the finite spatial plan's allowance.
          layoutStarted=now();
          let response=await requestSpatialWithTransportRetry(layoutRequest,'layout');
          writeLayoutAttempt({input_chars:layoutRequest.messages.reduce((sum,message)=>sum+message.content.length,0),http_status:response.httpStatus,response_chars:response.text?.length??0,response_hash:sha256HexSync(response.text??''),finish_reason:response.finishReason});
          if(input.isCurrent&&!input.isCurrent()||currentRevision()!==anchor.baseRevision)throw new AtlasDbError('STALE_BASE','布局生成期间聊天或世界修订已变化，候选不发布',{});
          if(response.finishReason==='length')throw Object.assign(new Error('空间布局输出被截断；本次响应未用于排版，原场景保留'),{code:'LAYOUT_BATCH_TRUNCATED'});
          let extracted=extractPayload(response.text??''),parsed=parseOperations(extracted.payload,{phase:'geography'});
          const layoutRefs=currentLayoutTask.catalogue.knownRefs;
          const allowedRefs=new Set(layoutRefs.filter(r=>currentLayoutTask.mapIds.includes(r.id)).flatMap(r=>[r.id,r.alias]));
          const hasRequestedLayout=()=>parsed.operations.some(op=>op.value.op==='map.layout.request'&&allowedRefs.has(op.value.ref??''));
          // Ask for a fresh complete response once. Never patch broken JSON locally or reuse partial lines as a full layout.
          const retryEmptyLayout=input.manual&&Array.isArray(input.layoutMaps);
          const retryBrokenJson=!parsed.operations.length&&parsed.issues.some(i=>i.code==='JSON_SYNTAX');
          const unknownEntityRefs=unknownLayoutEntityRefs(parsed.operations.map(operation=>operation.value),layoutRefs);
          retryableBatchReply=hasRequestedLayout()||retryEmptyLayout||retryBrokenJson||unknownEntityRefs.length>0;
          if(currentLayoutTask.mapIds.length===1&&!retriedLayoutIds.has(currentLayoutTask.mapIds[0])&&(unknownEntityRefs.length>0||!hasRequestedLayout()&&(retryEmptyLayout||retryBrokenJson))&&!extracted.incomplete&&layoutBudget.remaining()>0&&canSupplement()){
            retriedLayoutIds.add(currentLayoutTask.mapIds[0]);
            const reason=unknownEntityRefs.length?`使用了未登记实体引用 ${unknownEntityRefs.join('、')}`:parsed.explicitNoop?'只返回了 noop':parsed.operations.length?'未返回本批地图引用的 map.layout.request':parsed.issues.some(i=>i.code==='JSON_SYNTAX')?'回复不是合法 JSON':'回复中没有布局操作';
            const repairText=layoutRequest.messages[1].content+'\n【布局回复纠错】上次'+reason+'。解析问题：'+(parsed.issues.map(i=>i.message).join('；')||'无语法错误，但没有本批布局')+'\n本批是用户明确请求生成或更新布局，不能以“正文无变化”判定 noop。重新生成以上地图的完整布局；缺少事实时保留估计/未知和锁，不编造实体。只返回 JSONL，每张图一个完整 JSON 对象，ref 必须使用本图目录引用：'+[...allowedRefs].join('、')+'。所有键及字符串用双引号，不要代码围栏、解释、逗号连接两个对象或在字段内省略括号。';
            const repairRequest={...layoutRequest,retryOf:layoutRequest.batchId,batchId:layoutRequest.batchId+'_format_retry',diagnosticCause:'format_repair' as const,messages:layoutRequest.messages.map((m,i)=>i===1?{...m,content:repairText}:m),promptInput:layoutRequest.promptInput?{...layoutRequest.promptInput,injectionText:repairText}:undefined};
            allIssues.push({code:'LAYOUT_RESPONSE_RETRIED',path:'$.layout',message:`首次布局${reason}，已在本轮预算内请求一次完整回复纠错；原回复未写入地图。`,severity:'warning',retryable:false});
            const retryStarted=now();
            response=await requestSpatialWithTransportRetry(repairRequest,'layout_repair');
            recordAttempt({kind:'layout_repair',phase:'geography',started_wall_ms:retryStarted,finished_wall_ms:now(),target_kind:'maps',target_count:currentLayoutTask.mapIds.length,estimated_output_tokens:repairRequest.batchTargets?.estimatedOutputTokens,input_chars:repairRequest.messages.reduce((sum,message)=>sum+message.content.length,0),http_status:response.httpStatus,response_chars:response.text?.length??0,response_hash:sha256HexSync(response.text??''),finish_reason:response.finishReason});
            if(input.isCurrent&&!input.isCurrent()||currentRevision()!==anchor.baseRevision)throw new AtlasDbError('STALE_BASE','布局纠错期间聊天或世界修订已变化，候选不发布',{});
            if(response.finishReason==='length')throw new Error('空间布局纠错输出被截断；本次响应未用于排版，原场景保留');
            extracted=extractPayload(response.text??'');parsed=parseOperations(extracted.payload,{phase:'geography'});
          }
          // Known geometry can be completed locally even when model detail output
          // is malformed. Never parse or salvage fragments from that response.
          if(input.manual&&Array.isArray(input.layoutMaps)){
            const read=createTableReadPort(candidateDb);
            for(const id of currentLayoutTask.mapIds){
              const refs=layoutRefs.find(r=>r.id===id),map=read.selectOne('maps',branchId,id);
              if(!refs||!map||parsed.operations.some(o=>o.value.op==='map.layout.request'&&(o.value.ref===id||o.value.ref===refs.alias)))continue;
              const frame=normalizeFrame(map.frame_json),scene=frame.atlasScene as Record<string,unknown>|undefined;
              const kind=currentLayoutTask.kinds[id];
              const registeredContainer=map.container_location_id?read.selectOne('locations',branchId,String(map.container_location_id)):null;
              const emptyOwn=Number(queryBound(candidateDb,"SELECT COUNT(*) n FROM locations WHERE branch_id=? AND map_id=? AND status='active'",[branchId,id])[0].n)===0;
              const localSpec=registeredContainer?(scene?.constraints??(kind==='overview'&&emptyOwn?{surface:'mixed',zones:[],links:[],features:[]}:null)):null;
              if(!localSpec)continue;
              const local=parseOperations(JSON.stringify({op:'map.layout.request',ref:id,data:{kind,spec:localSpec},why:'程序基于已登记结构完成布局；模型新增细节未完成'}),{phase:'geography'});
              parsed.operations.push(...local.operations);
              allIssues.push({code:'LAYOUT_DETAILS_DEFERRED',path:'$.layout',message:`地图 ${id} 由程序基于已登记结构生成；模型本轮新增细节未通过协议校验，仍未完成。`,severity:'warning',retryable:true});
            }
          }
          allIssues.push(...extracted.issues,...parsed.issues);
          // M4-23：解析必须用**原任务的冻结目录**，不能 await 回来再收一次 —— 候选期间新插入的
          // 行会让 alias 改指向，同一批回复就会被解到别的实体上。
          const ops=parsed.operations.filter(op=>op.value.op==='map.layout.request'&&allowedRefs.has(op.value.ref??'')&&(currentLayoutTask.mapIds.length===1||unknownLayoutEntityRefs([op.value],layoutRefs).length===0)).map(op=>{
            const id=layoutRefs.find(r=>r.id===op.value.ref||r.alias===op.value.ref)?.id;
            const extent=id?currentLayoutTask.extents[id]:undefined;
            const kind=id?currentLayoutTask.kinds[id]:undefined;
            const data=op.value.data,spec=data?.spec;
            if(!id||!extent||!kind||!spec||typeof spec!=='object'||Array.isArray(spec))return {...op,opId:`layout_${layoutTasks.length}_${op.opId}`};
            // 角色由真实容器决定：模型写错 kind 时以程序值为准（只记诊断，不按错误的 kind 生成）。
            if(data?.kind!==kind)allIssues.push({code:'LAYOUT_KIND_OVERRIDDEN',path:'$.layout.kind',message:`地图 ${id} 的角色由容器决定为 ${kind}，模型给出的 ${String(data?.kind ?? '(空)')} 已按 ${kind} 处理`,severity:'warning',retryable:false});
            // overview 的幅面由程序按地图框架给定（未标定时是格）：不把米制 width/height 塞回去冒充尺度。
            const canvas=extent.units==='meters'?{width:extent.width,height:extent.height}:{};
            const baseline=kind==='floor'?(currentLayoutTask.baselineRooms[id]??[]):[];
            const rooms='rooms' in spec?spec.rooms:undefined;
            const defaults=baseline.length&&(rooms===undefined||Array.isArray(rooms)&&rooms.length===0)?{rooms:baseline}:{};
            let normalizedSpec:Record<string,unknown>={...canvas,...spec,...defaults};
            const citySpec=spec as Record<string,unknown>;
            // A city without registered districts still needs one generator district.
            // Reuse its existing container identity only when all buildings point to it;
            // an unrelated district reference remains an error instead of being guessed.
            if(kind==='city'&&(!Array.isArray(citySpec.districts)||citySpec.districts.length===0)){
              const read=createTableReadPort(candidateDb),mapRow=read.selectOne('maps',branchId,id);
              const containerId=String(mapRow?.container_location_id??'');
              const containerRef=layoutRefs.find(entry=>entry.id===containerId)?.alias??containerId;
              const priorDistricts=(normalizeFrame(mapRow?.frame_json).atlasScene as Record<string,unknown>|undefined)?.constraints as Record<string,unknown>|undefined;
              const buildings:Array<unknown>=Array.isArray(citySpec.buildings)?citySpec.buildings:[];
              const compatible=buildings.every((building:unknown)=>building&&typeof building==='object'
                &&([containerRef,containerId].includes(String((building as Record<string,unknown>).districtId??''))));
              if(containerId&&compatible&&(!Array.isArray(priorDistricts?.districts)||priorDistricts.districts.length===0)){
                const cityName=String(read.selectOne('locations',branchId,containerId)?.name??mapRow?.name??containerId);
                normalizedSpec={...normalizedSpec,districts:[{id:containerRef,name:cityName,bank:'west',order:0}]};
              }
            }
            return {...op,opId:`layout_${layoutTasks.length}_${op.opId}`,value:{...op.value,data:{...data,kind,spec:normalizedSpec}}};
          });
          if(!ops.length)allIssues.push({code:'LAYOUT_NOT_GENERATED',path:'$.layout',message:'模型没有返回空间布局约束；地图与布局尚未完成，已登记地点保留，下一轮自动继续布局',severity:'warning',retryable:true});
          const layoutCompiled=compileOperations({operations:ops,anchor,phase:'geography',clockS:clockBefore,revision:rev,
            tables:createTableReadPort(candidateDb),sources:{phase:'geography',snapshot:sourceSnapshot,clockS:clockBefore},makeId,
            knownRefs:[...layoutRefs],turnId,allowedOps:['map.layout.request']});
          const groups=buildAtomicGroups(layoutCompiled.results.map(r=>({opId:r.opId,issues:r.result.issues,mutations:r.result.mutations,readSet:r.result.readSet,dependencies:r.result.dependencies,entityKeyWrites:r.result.entityKeyWrites,operationKeys:r.result.operationKeys})));
          allIssues.push(...layoutCompiled.issues,...groups.issues);
          beginTransaction(candidateDb);transactionOpen=true;
          const appliedLayout=applyGroups(candidateDb,orderGroups(groups.groups).order,{branchId,turnId,attemptId:'layout',validate:true});
          groupResults.push(...appliedLayout.groups);parsedOperations.push(...ops);
          const acceptedIds=new Set(appliedLayout.groups.filter(g=>g.status==='applied').flatMap(g=>g.opIds));
          for(const op of ops)if(acceptedIds.has(op.opId)){const id=layoutRefs.find(r=>r.id===op.value.ref||r.alias===op.value.ref)?.id;if(id)returnedMapIds.add(id);}
          // 只有真拿到布局操作才算本轮「发过布局」；空响应 / 全被拒不算，否则会把失败伪装成成功。
          layoutApplied=layoutApplied||ops.length>0;
          for(const message of appliedLayout.journalIssues)allIssues.push({code:'JOURNAL_WRITE_FAILED',path:'$.layout',message,severity:'error',retryable:false});
        }catch(error){
          if(!transactionOpen){beginTransaction(candidateDb);transactionOpen=true;}
          if(error instanceof AtlasDbError&&error.code==='STALE_BASE')throw error;
          if(layoutEvidenceCache===null)layoutEvidenceBlocked=true;
          splitAfterFailure=!generationOptions.workBatching&&isModelBatchSizeFailure(error)&&currentLayoutTask.mapIds.length>1&&!currentLayoutTask.mapIds.some(id=>retriedLayoutIds.has(id))&&layoutBudget.remaining()>0;
          retryableBatchReply=splitAfterFailure;
          allIssues.push(splitAfterFailure?{code:'LAYOUT_BATCH_SPLIT',path:'$.layout',message:'合批超出模型容量或回复被截断，原回复未写入；缩小批量补交一次。',severity:'warning',retryable:false}:{code:'LAYOUT_MODEL_FAILED',path:'$.layout',message:`空间布局未生成：${(error as Error).message} 已登记的世界数据保留，下一轮自动继续布局。`,severity:'warning',retryable:true});
          writeLayoutAttempt({failure_kind:failureKindOf(error),error:(error as Error).message});
        }
        if(layoutEvidenceBlocked)break;
        // Continue the next chunk inside this same isolated candidate. No intermediate
        // save exposes point-only maps and no second UI click is required.
        materializeLayouts();
        const retryIds:string[]=[];
        for(const id of currentLayoutTask.mapIds){
          if(completedSpatialMaps.has(id))continue;
          if(!returnedMapIds.has(id)&&retryableBatchReply&&!retriedLayoutIds.has(id)&&layoutBudget.remaining()>0&&canSupplement()&&!evidenceBlockedMaps.has(id)){
            retryIds.push(id);retriedLayoutIds.add(id);if(splitAfterFailure)smallerLayoutBatches.set(id,Math.max(1,Math.floor(currentLayoutTask.mapIds.length/2)));
          }else deferredLayoutIds.add(id);
        }
        if(retryIds.length&&!splitAfterFailure)allIssues.push({code:'LAYOUT_MAP_REPLY_RETRIED',path:'$.layout',message:`本批仅补交 ${retryIds.length} 张未完成地图，已完成地图不重做。`,severity:'warning',retryable:false});
        const consumed=new Set(attemptedMapIds);
        pendingLayoutIds.splice(0,pendingLayoutIds.length,...pendingLayoutIds.filter(id=>!consumed.has(id)&&!completedSpatialMaps.has(id)));
        pendingLayoutIds.unshift(...retryIds);
        const parentBlocked=pendingLayoutIds.filter(id=>{
          const seen=new Set<string>();let parent=layoutParents[id];
          while(parent&&!seen.has(parent)){seen.add(parent);if(deferredLayoutIds.has(parent)||evidenceBlockedMaps.has(parent))return true;parent=layoutParents[parent];}
          return false;
        });
        if(parentBlocked.length){
          for(const id of parentBlocked)deferredLayoutIds.add(id);
          const blocked=new Set(parentBlocked);pendingLayoutIds.splice(0,pendingLayoutIds.length,...pendingLayoutIds.filter(id=>!blocked.has(id)));
          allIssues.push({code:'LAYOUT_PARENT_PENDING',path:'$.layout',message:`${parentBlocked.length} 张子图等待父图完成；本轮不消耗请求生成缺少父图依据的细节。`,severity:'warning',retryable:true});
        }
        const supplements=generationOptions.workBatching?pendingLayoutIds.filter(id=>retriedLayoutIds.has(id)):[];
        const nextTargets=supplements.length?supplements:pendingLayoutIds;
        layoutTask=nextTargets.length&&(mapBatchesRemaining>0||supplements.length>0)?buildSqlLayoutTask(candidateDb,branchId,{...input,generationOptions:{...generationOptions,...(generationOptions.workBatching?{workBatching:{...generationOptions.workBatching,mapBatches:supplements.length?1:mapBatchesRemaining}}:{})},layoutMaps:nextTargets,layoutBatchMapLimit:smallerLayoutBatches.get(pendingLayoutIds[0])},`${turnId}_layout_${layoutTasks.length}`,layoutReport):null;
        if(layoutTask&&layoutTask.mapIds.some(id=>retriedLayoutIds.has(id))){
          const repair=planLayoutRepair({ maps:layoutTask.mapIds.map(mapId=>({mapId,batchId:currentLayoutTask.request.batchId,attempts:0})),
            failures:layoutTask.mapIds.map(mapId=>({mapId,kind:'validation-rejected',originBatchId:currentLayoutTask.request.batchId,
              issues:allIssues.filter(issue=>issue.path.startsWith('$.layout')||issue.path.startsWith('$.spec')||issue.code==='ENUM_INVALID').map(issue=>({code:issue.code,path:issue.path}))})),
            membersByMap:Object.fromEntries(layoutTask.mapIds.map(mapId=>[mapId,pageAllRows(tables,'locations',branchId).filter(row=>row.map_id===mapId&&row.status==='active').map(row=>String(row.id))])),
            batchPrefix:`${turnId}_layout_repair` });
          allIssues.push(...repair.issues);
          const suffix='\n【未完成项补交】只处理本图目录列出的地图；已完成地图已从本批移除，不要重新生成。保留原有作者锁。定向纠错依据：'+JSON.stringify(repair.batches.flatMap(batch=>batch.contexts));
          layoutTask.request.messages[1].content+=suffix;layoutTask.request.promptInput!.injectionText=layoutTask.request.messages[1].content;
        }
        drainLayoutReport();
      }
      if(pendingLayoutIds.length||evidenceBlockedMaps.size||deferredLayoutIds.size)allIssues.push({code:'LAYOUT_BATCH_PENDING',path:'$.layout',message:`${new Set([...pendingLayoutIds,...evidenceBlockedMaps,...deferredLayoutIds]).size} 张地图保留为待细化。${turnBudget.limit>0?`本次操作按用户设置最多发送 ${turnBudget.limit} 次模型请求；`:''}已登记地点和已完成布局保留，可选中需要的地图后继续生成。`,severity:'warning',retryable:true});

      materializeLayouts();

      // M3-12 / P07：建设状态元数据也必须进 journal —— 通过 RowMutation + applyGroups 保存，
      // 因此删楼回退时它跟业务数据一起被恢复，而不是散落在 frame 里改不回去。
      // 完成状态**逐地点**记在各自唯一的 active 容器图上；都没有容器图时只能 deferred，
      // 并在分支根图留一条批次级兼容记录（绝不写成 ready）。旧代码用 firstFocus.map_id
      // 把完成标记写到外部图、读时又用内部图，正是 R04。
      if (construction.attempted) {
        const fillPort = createTableReadPort(candidateDb);
        const focusIds = construction.task?.focusLocationIds ?? [];
        const owners = resolveCompletionMaps(fillPort, branchId, focusIds);
        const ownedMapIds = completionMapIds(owners);
        for (const planIssue of completionOwnershipIssues(owners)) {
          if (planIssue.severity === 'error') {
            allIssues.push({ code: planIssue.code, path: planIssue.path, message: planIssue.message, severity: planIssue.severity, retryable: planIssue.retryable });
          }
        }
        const needsContainer = owners.some((owner) => owner.needsContainerMap);
        const conflicted = owners.some((owner) => owner.issues.some((item) => item.code === 'COMPLETION_CONTAINER_MAP_CONFLICT'));
        if (needsContainer || conflicted) {
          construction.deferred = true;
          construction.reasonCode = construction.reasonCode ?? (conflicted ? 'WORLD_FILL_CONTAINER_MAP_CONFLICT' : 'WORLD_FILL_NEEDS_CONTAINER_MAP');
        }
        // 一张所属图都没有：只在根图写批次级兼容记录（status 不得为 ready），保住待办队列；
        // 有归属时绝不回头写外部图。
        const rootMapId = branchRootMapId(fillPort, branchId);
        const compatOnly = ownedMapIds.length === 0;
        const writeTargets = compatOnly ? (rootMapId ? [rootMapId] : []) : ownedMapIds;
        const mutations: RowMutation[] = [];
        let anyMapNotReady = false;
        for (const mapId of writeTargets) {
          const mapRow = fillPort.selectOne('maps', branchId, mapId);
          if (!mapRow) continue;
          const rawFrame = mapRow.frame_json;
          const frame: Record<string, unknown> = rawFrame && typeof rawFrame === 'object' && !Array.isArray(rawFrame)
            ? { ...(rawFrame as Record<string, unknown>) }
            : {};
          let status: WorldFillStatus = construction.status ?? 'deferred';
          let reasonCode = construction.reasonCode;
          if (status === 'ready') {
            if (compatOnly) {
              // 兼容记录不属于任何地点，绝不冒充 ready。
              status = 'partial';
              reasonCode = reasonCode ?? 'WORLD_FILL_NEEDS_CONTAINER_MAP';
            } else {
              if (!frame[SPATIAL_SCENE_KEY]) { status = 'partial'; reasonCode = 'WORLD_LAYOUT_PENDING'; }
              // ready 不能只看 HTTP 200：对应结构必须真的可绘制。
              // 所属图若仍有 pending / failed 的布局请求，本轮只能算 partial。
              const pending = frame[SPATIAL_REQUEST_KEY];
              const pendingStatus = pending && typeof pending === 'object' && !Array.isArray(pending)
                ? String((pending as Record<string, unknown>).status ?? '')
                : '';
              if (pendingStatus === 'pending' || pendingStatus === 'failed') {
                status = 'partial';
                reasonCode = 'WORLD_LAYOUT_PENDING';
              }
              const scene = frame[SPATIAL_SCENE_KEY] as { layout?: { issues?: unknown[] } } | undefined;
              if (Array.isArray(scene?.layout?.issues) && scene.layout.issues.length > 0) {
                status = 'partial';
                reasonCode = 'WORLD_LAYOUT_PARTIAL';
                construction.remainingLocationIds = [...new Set([...construction.remainingLocationIds, ...focusIds])];
              }
            }
          }
          frame[WORLD_FILL_FRAME_KEY] = {
            version: 1,
            policyVersion: 1,
            contextHash: construction.contextHash,
            status,
            completedTurnId: turnId,
            // 只保留本次有界结果：不复制全表、不复制全文 lore。
            createdLocationIds: construction.createdLocationIds.slice(0, ATLAS_RUNTIME_LIMITS.worldFillTargets),
            createdRouteIds: construction.createdRouteIds.slice(0, ATLAS_RUNTIME_LIMITS.worldFillTargets),
            remainingLocationIds: construction.remainingLocationIds,
            reasonCode,
            // 兼容记录显式标记：写它不代表该图拥有任何地点的完成状态。
            ...(compatOnly ? { scope: 'batch-fallback' } : {}),
          };
          construction.completionMapIds.push(mapId);
          if (status !== 'ready') anyMapNotReady = true;
          mutations.push({
            table: 'maps',
            rowId: mapId,
            before: { ...mapRow },
            after: { ...mapRow, frame_json: frame },
            sourceOpIds: [],
            basis: {
              kind: 'simulation',
              sources: [],
              causes: [],
              reason: compatOnly
                ? '本轮世界建设的批次级兼容记录（容器图待建，不代表完成状态归属）'
                : `地图 ${mapId} 所辖建设空间的完成状态（业务群组 + 布局可绘制性）`,
              verification: 'causal',
              certainty: 'inferred',
            },
          });
        }
        if (mutations.length === 0) {
          construction.deferred = true;
          construction.reasonCode = construction.reasonCode ?? 'WORLD_FILL_NO_TARGET_MAP';
        } else {
          // 批次 status 只是**汇总**：任何一张所属图没到 ready，整批就不能自称 ready。
          if (anyMapNotReady && construction.status === 'ready') construction.status = 'partial';
          const fillOpId = `world_fill_${turnId}`;
          const fillGroup: AtomicGroup = {
            id: `grp_world_fill_${turnId}`,
            opIds: [fillOpId],
            dependsOn: [],
            // P09A/§15.4.13：建设进度/调度是程序记账，不是世界业务变化。
            // 显式声明用途，回执与统计层据此分类，不再靠 id 前缀。
            purpose: 'bookkeeping',
            // 读集使用当前候选的真实 row_rev：一张图一条 readSet。
            readSet: mutations.map((mutation) => ({ table: 'maps', rowId: mutation.rowId, rowRev: Number((mutation.before as Record<string, unknown>)?.row_rev ?? 0) })),
            mutations: mutations.map((mutation) => ({ ...mutation, sourceOpIds: [fillOpId] })),
          };
          const appliedFill = applyGroups(candidateDb, [fillGroup], { branchId, turnId, attemptId: 'world-fill', validate: true });
          groupResults.push(...appliedFill.groups);
          for (const message of appliedFill.journalIssues) {
            allIssues.push({ code: 'JOURNAL_WRITE_FAILED', path: '$.worldFill', message, severity: 'error', retryable: false });
          }
        }
      }

      const sceneAudit = auditSavedSpatialMoves({ db: candidateDb, beforeDb: requireDb(), branchId, turnId });
      if (sceneAudit.groups.length) {
        const audited = applyGroups(candidateDb, sceneAudit.groups, { branchId, turnId, attemptId: 'scene-audit', validate: true });
        groupResults.push(...audited.groups);
        if (audited.journalIssues.length || audited.groups.some(group => group.status === 'rejected' || group.status === 'blocked'))
          throw new AtlasDbError('SCENE_AUDIT_WRITE_FAILED', '空间矛盾记录未通过日志校验', {});
      }
      allIssues.push(...contradictionsToDiagnostics(sceneAudit.contradictions));
      let worldBuildReceipt: import('./atlas-world-contract.ts').WorldBuildReceiptV1 | undefined;
      if (worldBuildWindow) {
        const settled = settleWorldBuildWindow({ db: candidateDb, input, turnId, makeId }, worldBuildWindow, turnBudget.audit?.().transports ?? attempts.length, allIssues);
        const savedProgress = applyGroups(candidateDb, settled.groups, { branchId, turnId, attemptId: 'world-build-settled', validate: true });
        groupResults.push(...savedProgress.groups);
        if (savedProgress.journalIssues.length || savedProgress.groups.some(group => group.status === 'rejected' || group.status === 'blocked'))
          throw new AtlasDbError('WORLD_BUILD_STATE_WRITE_FAILED', '建设结果进度未通过校验', { groups: savedProgress.groups });
        worldBuildReceipt = settled.receipt;
      }
      const fkViolations = foreignKeyCheck(candidateDb);
      const finalCheck = validateCandidate(candidateDb, { branchId });
      const ok = fkViolations.length === 0 && finalCheck.ok;
      if (!ok) {
        throw new AtlasDbError(
          'INVARIANT_FAILED',
          `候选核心一致性校验失败：${finalCheck.violations.slice(0, 5).map((v) => `${v.code}@${v.table}`).join('; ') || 'foreign_key_check'}`,
          { violations: finalCheck.violations, foreignKeys: fkViolations },
        );
      }

      const appliedGroups = groupResults.filter((g) => g.status === 'applied');
      // P09A/§15.4.13：按「写了哪些表 + 这个组的用途」判断世界是否真变化。
      // 只写程序内部表（含建设进度）或显式 bookkeeping 的组不算业务变化：
      // 不推进 revision、不计入业务成功组，也不借内部写入推进游戏时间。
      const groupById = new Map(ordered.order.map((g) => [g.id, g] as const));
      const businessChanged = appliedGroups.some((g) => {
        if (g.changedRows <= 0) return false;
        if (g.purpose === 'bookkeeping') return false;
        const group = groupById.get(g.groupId);
        // 组对象拿不到时保守计入（绝不静默吞掉真实业务变更）。
        return group ? groupChangesBusiness(group) : true;
      });
      worldChanged = simulation.worldChanged || businessChanged;
      const newRevision = rev + (worldChanged || timeChanged ? 1 : 0);

      const receipt = buildReceipt({
        turnId,
        anchor,
        groupResults,
        issues: allIssues,
        clockBefore,
        clockAfter: simulation.clockAfter,
        simulatedUntil: simulation.simulatedUntil,
        worldChanged,
        timeChanged,
        explicitNoop,
        modelPhaseFailed,
        incomplete: responseIncomplete,
        repairAttempted,
      });
      if ((simulation.catchingUp || simulation.elapsed.quality === 'unknown') && receipt.status !== 'failed') receipt.status = 'partial';
      if (construction.attempted && construction.status !== 'ready' && receipt.status !== 'failed') receipt.status = 'partial';
      receipt.requestAudit = input.worldBuild?.abortedWindow?.requestAudit ?? turnBudget.audit?.();
      if (worldBuildReceipt) receipt.worldBuild = worldBuildReceipt;
      if(generationOptions.workBatching)receipt.requestPlan={normalLimits:workPlanLimits(generationOptions.workBatching),extraLimit:generationOptions.workBatching.extraRequests,usage:turnBudget.workUsage()!};
      if (construction.reasonCode === 'MODEL_BUDGET_EXHAUSTED' && receipt.status !== 'failed') receipt.status = 'partial';
      if (input.layoutMaps && allIssues.some(issue => issue.severity === 'error')) {
        receipt.status = worldChanged || timeChanged ? 'partial' : 'failed';
      }
      if(input.layoutMaps && allIssues.some(issue=>issue.path.startsWith('$.layout')&&issue.retryable) && receipt.status!=='failed')receipt.status='partial';

      // 5) 记录回执、状态与同步任务（同一事务）
      runBound(candidateDb, `UPDATE turns SET status = ?, committed_revision = ?, receipt_json = ?, attempts_json = ?, decisions_json = ? WHERE id = ?`, [
        receipt.status === 'failed' ? 'failed' : receipt.status === 'partial' ? 'partial' : 'committed',
        receipt.status === 'failed' ? null : newRevision,
        JSON.stringify(receipt),
        JSON.stringify(attempts.slice(0, ATLAS_RUNTIME_LIMITS.detailedAttemptsPerTurn)),
        JSON.stringify({ world_build: worldBuildReceipt ? { version:1, jobId: worldBuildReceipt.jobId, action:input.worldBuild?.action,
          window: worldBuildWindow?.window===true, aborted:!!input.worldBuild?.abortedWindow,
          windowSequence:input.worldBuild?.abortedWindow?.windowSequence??(worldBuildWindow?.window?worldBuildWindow.job.nextWindowSequence:null),
          runEpoch:worldBuildWindow?.job.runEpoch,originFloorId:worldBuildWindow?.job.originFloorId } : undefined,
          scene_audit: { contradictions: sceneAudit.contradictions, unevaluated: sceneAudit.unevaluated },
          work_usage:turnBudget.workUsage(),work_batching:generationOptions.workBatching,operations: parsedOperations.map((p) => p.value),
          operation_meta: parsedOperations.map(({ opId, line, rawHash }) => ({ opId, line, rawHash })),
          known_refs: foregroundKnownRefs,
          scene_maps: input.sceneMaps === true,
          operation_context: simulation.operationContexts,
          host_message_index: input.hostMessageIndex,
          simulation_steps: simulation.steps,
          pending_actors: simulation.pendingActors,
          attention_decisions: simulation.modelOperations.filter(op=>op.value.op==='attention.propose').map(op=>op.value),
          outcome_decisions: simulation.modelOperations.filter(op=>op.value.op==='event.propose').map(op=>op.value), random_draws: simulation.randomDraws }),
        turnId,
      ]);
      runBound(candidateDb, 'UPDATE turns SET clock_after_s=?,elapsed_json=?,rng_seed=? WHERE id=?', [simulation.clockAfter, JSON.stringify(simulation.elapsed), simulation.seed, turnId]);
      runBound(
        candidateDb,
        `UPDATE branches SET head_turn_id = ?, revision = ?, clock_s = ?, clock_min_s = ?, clock_max_s = ?, simulation_cursor_s = ?, simulation_status = ? WHERE id = ?`,
        [
          receipt.status === 'failed' ? currentHeadTurnId() : turnId,
          newRevision,
          simulation.clockAfter,
          simulation.clockMin,
          simulation.clockMax,
          simulation.simulatedUntil,
          simulation.catchingUp ? 'catching_up' : simulation.elapsed.quality === 'unknown' ? 'blocked' : 'current',
          branchId,
        ],
      );

      if (worldChanged || timeChanged) {
        enqueueProjectionSync(candidateDb, {
          branchId,
          turnId,
          targetRevision: newRevision,
          projectionScope: 'pov',
          payloadHash: projectionHash({ turnId, revision: newRevision, operations: parsedOperations.length }),
          nowWallMs: now(),
          makeId: (key) => makeId('outbox', turnId, key),
        });
      }

      preparationStep='final-save';
      commitTransaction(candidateDb);
      transactionOpen = false;
      committed = true;

      if (receipt.status === 'failed') {
        // 模型阶段失败且无有效时间/程序变化：不发布候选。
        await discardPreparedImpl(candidate.token);
        throw new AtlasDbError('TURN_FAILED', '本轮没有任何有效变更（模型阶段失败且无程序结算）：候选已丢弃', {
          receipt,
          attempts: attempts.slice(0, ATLAS_RUNTIME_LIMITS.detailedAttemptsPerTurn),
        });
      }

      return await exportCandidateImpl(candidate, receipt);
    } catch (err) {
      const candidateAlive=candidates.has(candidate.token);
      const failedForeignKeys=committed||!candidateAlive?[]:foreignKeyCheck(candidateDb);
      if (!committed) {
        if (transactionOpen&&candidateAlive) rollbackTransaction(candidateDb);
        await discardPreparedImpl(candidate.token);
      } else if (err instanceof AtlasDbError && err.code === 'TURN_FAILED') {
        throw err;
      } else {
        await discardPreparedImpl(candidate.token);
      }
      if (err instanceof AtlasDbError) { err.detail.requestAudit = turnBudget.audit?.(); throw err; }
      throw new AtlasDbError('TURN_PREPARE_FAILED', `准备回合失败（${preparationStep}）：${(err as Error).message}${failedForeignKeys.length?'；未完成依赖：'+failedForeignKeys.map(v=>`${v.table}→${v.parent}`).join(', '):''}`, { sequencesUsed,preparationStep,foreignKeys:failedForeignKeys,groups:groupResults,requestAudit:turnBudget.audit?.() });
    }
  }

  async function runRepair(args: {
    candidateDb: SqlDatabase;
    rejected: GroupResult[];
    compiled: ReturnType<typeof compileOperations>;
    anchor: TurnAnchor;
    clockBefore: number;
    rev: number;
    sourceSnapshot: SourceSnapshotEntry[];
    attempts: Array<Record<string, unknown>>;
    allIssues: Issue[];
    modelPort: AtlasModelPort;
    makeId: (kind: string, opId: string, alias: string) => string;
    turnId: string;
  }): Promise<{ applied: AtomicGroup[] }> {
    const failedOps = args.rejected.flatMap((g) =>
      g.opIds.map((opId) => {
        const original = args.compiled.normalized.find((o) => o.opId === opId);
        return {
          op: original ?? { opId, line: 0, rawHash: '', value: { op: 'noop' } },
          issues: g.issues,
          readSet: args.compiled.results.find((r) => r.opId === opId)?.result.readSet ?? [],
        };
      }),
    );
    if (failedOps.length === 0) return { applied: [] };
    const allowedOps = new Set(failedOps.map((f) => f.op.value.op));
    const repair = buildRepairBatch(failedOps, { phase: 'repair', allowedOps: [...allowedOps] });
    args.allIssues.push(...repair.issues);
    const request = buildStagePrompt({
      phase: 'repair',
      allowedOps: [...allowedOps],
      repairTickets: repair.promptLines.join('\n'),
      repairRefs: collectEntityRefs(createTableReadPort(args.candidateDb), branchId, args.compiled.scope.all()).join('\n'),
      batchId: `${repair.batchId}`,
      repairOfBatchId: repair.batchId,
      sourceSnapshot: args.sourceSnapshot,
    });
    request.anchor = args.anchor;
    request.sourceSnapshot = args.sourceSnapshot;
    let response: ModelBatchResponse;
    const repairStartedWallMs = now();
    try {
      response = await args.modelPort.request(request);
    } catch (err) {
      args.allIssues.push({
        code: 'REPAIR_REQUEST_FAILED',
        path: '$.repair',
        message: `纠错请求失败：${(err as Error).message}`,
        severity: 'error',
        retryable: true,
      });
      // R06：纠错请求失败同样留真实起止与失败类型；没有响应不写 http_status。
      const repairFailedWallMs = now();
      args.attempts.push({
        id: `att_${args.attempts.length}`,
        kind: 'repair',
        started_wall_ms: repairStartedWallMs,
        finished_wall_ms: repairFailedWallMs,
        duration_ms: Math.max(0, repairFailedWallMs - repairStartedWallMs),
        failure_kind: failureKindOf(err),
        error: (err as Error).message,
        requested_operation_ids: failedOps.map((f) => f.op.opId),
      });
      return { applied: [] };
    }
    const repairFinishedWallMs = now();
    args.attempts.push({
      id: `att_${args.attempts.length}`,
      kind: 'repair',
      started_wall_ms: repairStartedWallMs,
      finished_wall_ms: repairFinishedWallMs,
      duration_ms: Math.max(0, repairFinishedWallMs - repairStartedWallMs),
      requested_operation_ids: failedOps.map((f) => f.op.opId),
      http_status: response.httpStatus,
      response_chars: response.text?.length ?? 0,
      response_hash: sha256HexSync(response.text ?? ''),
    });
    const extracted = extractPayload(response.text ?? '');
    args.allIssues.push(...extracted.issues);
    const parsed = parseOperations(extracted.payload, { phase: 'repair', allowedOps: [...allowedOps] });
    args.allIssues.push(...parsed.issues);
    const merged = mergeRepair(
      failedOps.map((f) => f.op),
      parsed.operations,
      repair.tickets,
      { phase: 'repair', attemptsUsed: 0 },
    );
    args.allIssues.push(...merged.issues);
    if (merged.operations.length === 0) return { applied: [] };

    const tables = createTableReadPort(args.candidateDb);
    // A failed second upsert can still target a new: alias whose first upsert
    // was already saved in this candidate. Repair must update that exact row,
    // rather than derive another ID from the failed operation's opId.
    const entityTables = { 'character.upsert': 'characters', 'location.upsert': 'locations', 'item.upsert': 'items', 'faction.upsert': 'factions' } as const;
    const repairOperations = merged.operations.map(op => {
      const table = entityTables[op.value.op as keyof typeof entityTables];
      const ref = op.value.ref;
      const entry = table && ref?.startsWith('new:') ? args.compiled.scope.get(ref) : null;
      if (!table || !entry || !tables.selectOne(table, branchId, entry.id)) return op;
      return { ...op, value: { ...op.value, ref: entry.id } };
    });
    const recompiled = compileOperations({
      operations: repairOperations,
      anchor: args.anchor,
      phase: 'repair',
      clockS: args.clockBefore,
      revision: args.rev,
      tables,
      sources: { phase: 'repair', snapshot: args.sourceSnapshot, clockS: args.clockBefore },
      makeId: args.makeId,
      turnId: args.turnId,
      allowedOps: [...allowedOps],
      seedRefs: args.compiled.scope.all(),
    });
    args.allIssues.push(...recompiled.issues);
    const built = buildAtomicGroups(
      recompiled.results.map((r) => ({
        opId: r.opId,
        issues: r.result.issues,
        mutations: r.result.mutations,
        readSet: r.result.readSet,
        dependencies: r.result.dependencies,
        entityKeyWrites: r.result.entityKeyWrites,
        operationKeys: r.result.operationKeys,
      })),
    );
    args.allIssues.push(...built.issues);
    const ordered = orderGroups(built.groups);
    args.allIssues.push(...ordered.issues);
    return { applied: ordered.order };
  }

  async function prepareRollbackInner(input: RollbackInput): Promise<PreparedCommit> {
    if (input.chatUid !== chatUid) {
      throw new AtlasDbError('CHAT_CHANGED', `回退请求属于另一个聊天：${input.chatUid}`, { expected: chatUid, actual: input.chatUid });
    }
    const rev = currentRevision();
    if (input.expectedRevision !== undefined && input.expectedRevision !== rev) {
      throw new AtlasDbError('STALE_BASE', `回退基版本不一致：请求 ${input.expectedRevision}，当前 ${rev}`, { expected: input.expectedRevision, current: rev });
    }
    const target = requireDb();
    const targetTurn = queryBound(target, 'SELECT id, branch_id, clock_before_s, parent_turn_id FROM turns WHERE id = ? LIMIT 1', [
      input.targetParentTurnId,
    ]);
    if (targetTurn.length === 0) {
      throw new AtlasDbError('REF_UNKNOWN', `找不到要回退到的 turn：${input.targetParentTurnId}`, { target: input.targetParentTurnId });
    }
    const anchor: TurnAnchor = {
      chatUid,
      branchId,
      parentTurnId: input.targetParentTurnId,
      hostMessageUid: input.targetParentTurnId,
      variantKey: 'rollback',
      baseRevision: rev,
      baseStorageRevision: storageRevision,
      inputHash: sha256HexSync(`rollback:${input.targetParentTurnId}`),
    };
    const candidate = await createCandidateImpl(anchor, 'rollback');
    const candidateDb = (candidates.get(candidate.token) as StoredCandidate).db;
    beginTransaction(candidateDb);
    let committed = false;
    const result_issues_of_rollback: Issue[] = [];
    try {
      // E08：先规划（只读，逆因果序 + 受影响后文定位），再在候选库事务内应用。
      const plan = planRollback({
        db: candidateDb,
        branchId,
        targetTurnId: input.targetParentTurnId,
        expectedRevision: input.expectedRevision,
      });
      const rollbackTurnId = `turn_rollback_${sha256HexSync(`${chatUid}:${input.targetParentTurnId}:${rev}`).slice(0, 20)}`;
      insertTurnRow(candidateDb, {
        turnId: rollbackTurnId,
        anchor,
        kind: 'fork',
        clockBefore: currentClock(),
        clockAfter: plan.clockTargetS,
        storyHash: null,
        attempts: [],
      });

      // E08 restores rows and branch state under one inclusive floor contract.
      // Actions and their result events reference each other. Validate after the
      // whole reverse transaction rather than rejecting its temporary midpoint.
      runBound(candidateDb, 'PRAGMA defer_foreign_keys = ON', []);
      const appliedPlan = await applyRollbackPlan(candidateDb, plan, { turnId: rollbackTurnId, attemptId: 'rollback' });
      for (const note of appliedPlan.issues) {
        result_issues_of_rollback.push(note);
      }

      // 受影响的后文楼层标记为已回退：它们的效果已经不再描述当前状态。
      for (const turnId of plan.turns) {
        runBound(candidateDb, `UPDATE turns SET status = 'rolled_back' WHERE id = ?`, [turnId]);
      }

      const clockAfter = plan.clockTargetS;

      const finalCheck = validateCandidate(candidateDb, { branchId });
      if (!finalCheck.ok) {
        throw new AtlasDbError('INVARIANT_FAILED', `回退后候选校验失败：${finalCheck.violations.slice(0, 5).map((v) => `${v.code}@${v.table}`).join('; ')}`, {
          violations: finalCheck.violations,
        });
      }
      const receipt: TurnReceipt = {
        turnId: rollbackTurnId,
        anchor,
        status: 'committed',
        groups: [],
        issues: result_issues_of_rollback,
        clockBeforeS: plan.clockBeforeS,
        clockAfterS: clockAfter,
        simulatedUntilS: clockAfter,
        worldChanged: true,
        timeChanged: true,
      };
      runBound(candidateDb, `UPDATE turns SET status = 'committed', committed_revision = ?, receipt_json = ? WHERE id = ?`, [
        rev + 1,
        JSON.stringify(receipt),
        rollbackTurnId,
      ]);
      enqueueProjectionSync(candidateDb, {
        branchId,
        turnId: rollbackTurnId,
        targetRevision: rev + 1,
        projectionScope: 'pov',
        payloadHash: projectionHash({ rollback: input.targetParentTurnId, revision: rev + 1 }),
        nowWallMs: now(),
        makeId: (key) => makeId('outbox', rollbackTurnId, key),
      });
      commitTransaction(candidateDb);
      committed = true;
      const prepared = await exportCandidateImpl(candidate, receipt);
      return { ...prepared, kind: 'rollback' };
    } catch (err) {
      if (!committed) rollbackTransaction(candidateDb);
      await discardPreparedImpl(candidate.token);
      if (err instanceof AtlasDbError) throw err;
      throw new AtlasDbError('ROLLBACK_FAILED', `回退失败：${(err as Error).message}`, {});
    }
  }

  async function prepareMaintenanceInner(input: MaintenanceInput): Promise<PreparedMaintenance> {
    const anchor = input.anchor;
    if (anchor.chatUid !== chatUid) {
      throw new AtlasDbError('CHAT_CHANGED', `维护请求属于另一个聊天：${anchor.chatUid}`, { expected: chatUid, actual: anchor.chatUid });
    }
    const candidate = await createCandidateImpl(anchor, 'maintenance');
    const candidateDb = (candidates.get(candidate.token) as StoredCandidate).db;
    beginTransaction(candidateDb);
    let committed = false;
    try {
      for (const update of input.outboxResults ?? []) {
        const rows = queryBound(candidateDb, 'SELECT status, attempt_count FROM sync_outbox WHERE id = ? LIMIT 1', [update.taskId]);
        if (rows.length === 0) {
          throw new AtlasDbError('REF_UNKNOWN', `维护更新指向不存在的同步任务：${update.taskId}`, { taskId: update.taskId });
        }
        if (String(rows[0].status) !== update.expectedStatus) {
          throw new AtlasDbError('SESSION_STALE', `同步任务状态已变化：期望 ${update.expectedStatus}，实际 ${String(rows[0].status)}`, {
            taskId: update.taskId,
          });
        }
        runBound(
          candidateDb,
          `UPDATE sync_outbox SET status = ?, attempt_count = ?, next_retry_wall_ms = ?, last_error_code = ?, last_error_message = ?, completed_wall_ms = ? WHERE id = ?`,
          [
            update.nextStatus,
            update.attemptCount,
            update.nextRetryWallMs ?? null,
            update.lastErrorCode ?? null,
            update.lastErrorMessage ?? null,
            update.completedWallMs ?? null,
            update.taskId,
          ],
        );
      }
      if (input.failedAttempt) {
        // 没有已保存 turn 的失败请求可以建 status=failed 的诊断 turn，不设为有效 head。
        const diagnosticTurnId = input.failedAttempt.turnId ?? `turn_failed_${sha256HexSync(`${chatUid}:${anchor.hostMessageUid}:${anchor.variantKey}`).slice(0, 20)}`;
        const existing = queryBound(candidateDb, 'SELECT id FROM turns WHERE id = ? LIMIT 1', [diagnosticTurnId]);
        if (existing.length === 0) {
          insertTurnRow(candidateDb, {
            turnId: diagnosticTurnId,
            anchor,
            kind: 'background',
            clockBefore: currentClock(),
            clockAfter: currentClock(),
            storyHash: null,
            attempts: [input.failedAttempt.attempt],
          });
          runBound(candidateDb, `UPDATE turns SET status = 'failed', committed_revision = NULL, receipt_json = ? WHERE id = ?`, [
            JSON.stringify({ groups: [], issues: input.failedAttempt.issues }),
            diagnosticTurnId,
          ]);
        } else {
          runBound(candidateDb, `UPDATE turns SET status = 'failed', receipt_json = ? WHERE id = ?`, [
            JSON.stringify({ groups: [], issues: input.failedAttempt.issues }),
            diagnosticTurnId,
          ]);
        }
      }
      // 维护不改变分支业务 revision/head/clock，也不再产生新的世界书同步任务。
      commitTransaction(candidateDb);
      committed = true;
      const bytes = candidateDb.export();
      const snapshotSha256 = await sha256Hex(bytes);
      const envelope = await encodeSnapshot(bytes, {
        chatUid,
        worldUid,
        storageRevision: storageRevision + 1,
        activeBranchId: branchId,
        schemaVersion: ATLAS_SCHEMA_VERSION,
      assets: envelopeAssets,
      });
      const stored = candidates.get(candidate.token) as StoredCandidate;
      stored.snapshot = bytes;
      stored.snapshotSha256 = snapshotSha256;
      stored.envelope = envelope;
      return {
        kind: 'maintenance',
        token: candidate.token,
        anchor,
        snapshot: bytes,
        snapshotSha256,
        expiresWallMs: stored.expiresWallMs,
        receipt: null,
      };
    } catch (err) {
      if (!committed) rollbackTransaction(candidateDb);
      await discardPreparedImpl(candidate.token);
      if (err instanceof AtlasDbError) throw err;
      throw new AtlasDbError('MAINTENANCE_FAILED', `维护更新失败：${(err as Error).message}`, {});
    }
  }

  function insertTurnRow(
    targetDb: SqlDatabase,
    args: {
      turnId: string;
      anchor: TurnAnchor;
      kind: 'narrative' | 'manual' | 'migration' | 'background' | 'fork';
      clockBefore: number;
      clockAfter: number;
      storyHash: string | null;
      attempts: Array<Record<string, unknown>>;
    },
  ): void {
    const wall = now();
    runBound(
      targetDb,
      `INSERT INTO turns (id, branch_id, parent_turn_id, host_message_uid, host_variant_key, kind, input_hash, story_hash, base_revision, committed_revision, clock_before_s, elapsed_json, clock_after_s, rng_seed, ruleset_version, decisions_json, receipt_json, attempts_json, status, created_wall_ms, prepared_wall_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, 'pending', ?, NULL)`,
      [
        args.turnId,
        branchId,
        args.anchor.parentTurnId,
        args.anchor.hostMessageUid,
        args.anchor.variantKey,
        args.kind,
        args.anchor.inputHash,
        args.storyHash,
        args.anchor.baseRevision,
        args.clockBefore,
        JSON.stringify({ min_s: 0, nominal_s: 0, max_s: 0, quality: 'unknown', basis_refs: [] }),
        args.clockAfter,
        sha256HexSync(`rng:${chatUid}:${args.anchor.branchId}:${args.anchor.hostMessageUid}:${args.anchor.variantKey}:${args.anchor.inputHash}`),
        rulesetVersion,
        JSON.stringify({ operations: [], attention_decisions: [], outcome_decisions: [], random_draws: [] }),
        JSON.stringify(args.attempts),
        wall,
      ],
    );
  }
}

export type AtlasSqlRepositoryWithHelpers = ReturnType<typeof createSqlRepository>;

/**
 * 纠错结果并回回执：
 * - 原失败组若因纠错出现同 id 的成功组，用成功组替换该条（世界确实被补上）；
 * - 纠错引入的新组追加；
 * - **原失败记录不会被抹掉**：纠错成功仍保留一条 status=applied 的同 id 组，
 *   因此"本轮发生过分组失败并纠错"这一事实由 receipt.status=partial 表达，
 *   组级明细仍可定位到 groupId/opIds（§8.5：局部失败不能被包装成全成功）。
 */
function reconcileRepairResults(first: GroupResult[], second: GroupResult[], rejected: GroupResult[]): GroupResult[] {
  const repaired=new Set(second.filter(g=>g.status==='applied'||g.status==='duplicate').flatMap(g=>g.opIds));
  const merged = first.filter(g=>!rejected.some(r=>r.groupId===g.groupId)||!g.opIds.length||!g.opIds.every(id=>repaired.has(id)));
  for (const g of second) {
    const idx = merged.findIndex((x) => x.groupId === g.groupId);
    if (idx >= 0) merged[idx] = g;
    else merged.push(g);
  }
  // Repair may regroup the same operation IDs after resolving their dependencies.
  return merged;
}

function buildReceipt(args: {
  turnId: string;
  anchor: TurnAnchor;
  groupResults: GroupResult[];
  issues: Issue[];
  clockBefore: number;
  clockAfter: number;
  simulatedUntil: number;
  worldChanged: boolean;
  timeChanged: boolean;
  explicitNoop: boolean;
  modelPhaseFailed: boolean;
  incomplete: boolean;
  repairAttempted: boolean;
}): TurnReceipt {
  const applied = args.groupResults.filter((g) => g.status === 'applied');
  const failed = args.groupResults.filter((g) => g.status === 'rejected' || g.status === 'blocked');
  let status: TurnReceipt['status'];
  if (applied.length === 0 && failed.length === 0) {
    status = args.modelPhaseFailed ? args.worldChanged || args.timeChanged ? 'partial' : 'failed' : args.worldChanged || args.timeChanged ? 'committed' : 'noop';
  } else if (failed.length > 0 && applied.length > 0) {
    status = 'partial';
  } else if (failed.length > 0 && applied.length === 0) {
    status = 'failed';
  } else {
    status = 'committed';
  }
  if (args.explicitNoop && applied.length === 0 && failed.length === 0 && !args.worldChanged && !args.timeChanged) status = 'noop';
  // 响应被截断/含坏行但仍有有效组：回执 partial（§8.3 P03、§16.2 finishReason=length）。
  if (args.incomplete && applied.length > 0) status = 'partial';
  // §8.5：局部失败不能被包装成「全成功」——发生过分组失败（即使随后被一次纠错补上）或
  // 有成功组同时有失败组，回执都是 partial。
  if (failed.length > 0 && applied.length > 0) status = 'partial';
  if (args.repairAttempted && applied.length > 0) status = 'partial';
  if (applied.length > 0 && args.issues.some(issue => issue.severity === 'error')) status = 'partial';
  return {
    turnId: args.turnId,
    anchor: args.anchor,
    status,
    groups: args.groupResults,
    issues: args.issues,
    clockBeforeS: args.clockBefore,
    clockAfterS: args.clockAfter,
    simulatedUntilS: args.simulatedUntil,
    worldChanged: args.worldChanged,
    timeChanged: args.timeChanged,
  };
}

/** 因果后继：包含该 turn 自身与其所有后代（沿 parent_turn_id）。 */
export function collectDescendants(db: SqlDatabase, branchId: string, turnId: string): string[] {
  const rows = queryBound(db, 'SELECT id, parent_turn_id, created_wall_ms FROM turns WHERE branch_id = ? ORDER BY created_wall_ms', [branchId]);
  const children = new Map<string, string[]>();
  for (const row of rows) {
    const parent = row.parent_turn_id === null || row.parent_turn_id === undefined ? null : String(row.parent_turn_id);
    if (!parent) continue;
    const list = children.get(parent) ?? [];
    list.push(String(row.id));
    children.set(parent, list);
  }
  const out: string[] = [];
  const stack = [turnId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    out.push(current);
    for (const child of children.get(current) ?? []) stack.push(child);
  }
  return out;
}

/** 按变更 sequence 逆序恢复 before（回退）。 */
export function restoreTurnChanges(db: SqlDatabase, turnId: string): number {
  const rows = queryBound(
    db,
    `SELECT id, sequence, target_table, target_row_id, operation, before_json, after_json, basis_json FROM turn_changes WHERE turn_id = ? ORDER BY sequence DESC`,
    [turnId],
  );
  let restored = 0;
  for (const row of rows) {
    const table = String(row.target_table);
    if (!CANONICAL_TABLES.has(table)) continue;
    const before = row.before_json === null ? null : (JSON.parse(String(row.before_json)) as Record<string, unknown> | null);
    const after = row.after_json === null ? null : (JSON.parse(String(row.after_json)) as Record<string, unknown> | null);
    const rowId = String(row.target_row_id);
    const isGlobal = table === 'branches' || table === 'turns' || table === 'turn_changes' || table === 'sync_outbox';
    if (before === null) {
      // 原为 insert → 回退即删除该行。
      runBound(
        db,
        `DELETE FROM ${table} WHERE ${isGlobal ? 'id = ?' : 'branch_id = ? AND id = ?'}`,
        isGlobal ? [rowId] : [String(after?.branch_id ?? ''), rowId],
      );
    } else if (after === null) {
      // 原为 delete → 回退即按 before 重建该行。
      const columns = Object.keys(before);
      const placeholders = columns.map(() => '?').join(', ');
      runBound(
        db,
        `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
        columns.map((c) => normalizeValue(before[c])),
      );
    } else {
      const columns = Object.keys(before);
      const assignments = columns.map((c) => `${c} = ?`).join(', ');
      const params = columns.map((c) => normalizeValue(before[c]));
      runBound(
        db,
        `UPDATE ${table} SET ${assignments} WHERE ${isGlobal ? 'id = ?' : 'branch_id = ? AND id = ?'}`,
        isGlobal ? [...params, rowId] : [...params, String(before.branch_id ?? ''), rowId],
      );
    }
    restored += 1;
  }
  return restored;
}

function normalizeValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return JSON.stringify(value);
  return value as string | number;
}
