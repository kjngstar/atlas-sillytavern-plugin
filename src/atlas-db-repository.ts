import {buildSqlForegroundRequest} from './atlas-sql-model-context.ts';
import {buildSqlLayoutTask} from './atlas-sql-layout-task.ts';
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
// E08：回退计划的唯一权威（逆因果序、中间楼定位、显式上限拒绝）。
import { applyRollbackPlan, planRollback } from './atlas-db-rollback.ts';
import { validateCandidate } from './atlas-db-invariants.ts';
import { ATLAS_SEMANTIC_OPS } from './atlas-ops-contract.ts';
import { buildAtomicGroups, orderGroups } from './atlas-ops-groups.ts';
import { compileOperations, defaultMakeId } from './atlas-ops-compile.ts';
import { extractPayload, looksLikeSql, parseOperations } from './atlas-ops-parser.ts';
import { buildRepairBatch, mergeRepair } from './atlas-ops-repair.ts';
import { buildStagePrompt } from './atlas-ops-prompts.ts';
import { enqueueProjectionSync, projectionHash } from './atlas-db-outbox.ts';
import { createTableReadPort } from './atlas-db-readport.ts';
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
import { ATLAS_SCHEMA_VERSION, installSchemaSafe } from './atlas-db-schema.ts';
import { encodeSnapshot, sha256HexSync, sha256Hex } from './atlas-db-envelope.ts';
import { ATLAS_RUNTIME_LIMITS } from './atlas-runtime-limits.ts';
import { queryChanges, queryDiagnostics, queryEntityDetail, queryMapView, queryNearby, querySimulationView } from './atlas-db-views.ts';
// M4/Q07：四个新只读口。这里只传查询上下文，绝不把 writer / saveSession 交给读口。
import { queryCatalog } from './atlas-catalog-views.ts';
import { querySpatialFlows } from './atlas-spatial-flow-views.ts';
import { querySpatialScene } from './atlas-spatial-views.ts';
import { queryTasks } from './atlas-task-views.ts';
import { collectKnownRefs, collectEntityRefs } from './atlas-sql-refs.ts';
export { collectKnownRefs, collectEntityRefs } from './atlas-sql-refs.ts';
import { settleSqlTurn } from './atlas-sql-simulation.ts';
import { compileSqlSceneMaps } from './atlas-sql-scene-maps.ts';
import { applyPendingSpatialRequests, armLayoutRetry } from './atlas-spatial-candidate.ts';
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
]);

/** 校验「用户表恰 20 张」——不是 20 张就明确报 schema 异常，不清库重建。 */
export function assertTwentyTables(db: SqlDatabase): string[] {
  const tables = userTableNames(db);
  const unexpected = tables.filter((t) => !CANONICAL_TABLES.has(t));
  const missing = [...CANONICAL_TABLES].filter((t) => !tables.includes(t));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new AtlasDbError(
      'DB_SCHEMA_INVALID',
      `用户表不是预期的 20 张（多 ${unexpected.length}，少 ${missing.length}）：多 ${unexpected.join(',')}；少 ${missing.join(',')}`,
      { unexpected, missing },
    );
  }
  return tables;
}

type StoredCandidate = CandidateInfo & { db: SqlDatabase; assets?:AtlasAssetRef[] };

/**
 * 创建 Repository。返回对象同时满足 §16.4 的 AtlasSqlRepository 与查询/诊断辅助方法。
 */
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

    /** B05 open：新建有 migration/seed turn 和 branch；根图可存在而无「起点」实体。 */
    async open(openOptions: OpenOptions = {}): Promise<void> {
      if (openOptions.bytes && openOptions.bytes.length > 0) {
        db = await openDatabase(openOptions.bytes);
        enableForeignKeys(db);
        assertTwentyTables(db);
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
          return queryEntityDetail(ctx, query);
        case 'changes':
          return queryChanges(ctx, query);
        case 'diagnostics':
          return queryDiagnostics(ctx, query);
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

    // 1) 隔离候选态
    const candidate = await createCandidateImpl(anchor, 'turn');
    const candidateDb = (candidates.get(candidate.token) as StoredCandidate).db;
    const tables = createTableReadPort(candidateDb);
    const foregroundKnownRefs = collectKnownRefs(tables, branchId);
    const clockBefore = currentClock();
    // A rolled-back floor may be regenerated with identical text; retain the old
    // audit turn and give its new commit generation a distinct identity.
    const turnId = `turn_${sha256HexSync(`${chatUid}\u0000${anchor.branchId}\u0000${anchor.hostMessageUid}\u0000${anchor.variantKey}\u0000${anchor.inputHash}\u0000${anchor.baseRevision}`).slice(0, 24)}`;

    const allIssues: Issue[] = [];
    const parsedOperations: ParsedOperation[] = [];
    const attempts: Array<Record<string, unknown>> = [];
    let explicitNoop = false;
    let responseIncomplete = false;
    let repairAttempted = false;
    let worldChanged = false;
    let timeChanged = false;
    let modelPhaseFailed = false;
    let foregroundBatches = 0;

    const sourceSnapshot: SourceSnapshotEntry[] = input.sourceSnapshot ?? [];

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
      const phases: Phase[] = input.phaseBatches?.length ? input.phaseBatches : ['observe'];
      let phaseIndex = 0;
      for (const phase of phases) {
        if (phaseIndex >= ATLAS_RUNTIME_LIMITS.foregroundModelBatchesPerTurn) {
          allIssues.push({
            code: 'BUDGET_EXHAUSTED',
            path: '$.phaseBatches',
            message: `前台模型批次数已达上限 ${ATLAS_RUNTIME_LIMITS.foregroundModelBatchesPerTurn}；剩余阶段保存在行动队列并标记 catching_up`,
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
        const request = buildSqlForegroundRequest(tables,branchId,input,phase,turnId);
        const startedWall = now();
        let response: ModelBatchResponse;
        try {
          response = await options.modelPort.request(request);
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
          attempts.push({ id: `att_${attempts.length}`, kind: 'initial', phase, error: (err as Error).message });
          break;
        }
        attempts.push({
          id: `att_${attempts.length}`,
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
    if (revAfterModel !== anchor.baseRevision) {
      await discardPreparedImpl(candidate.token);
      throw new AtlasDbError(
        'STALE_BASE',
        `模型响应期间基线已变化：候选基于 revision ${anchor.baseRevision}，当前 ${revAfterModel}（候选已丢弃）`,
        { base: anchor.baseRevision, current: revAfterModel },
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

      const applied = applyGroups(candidateDb, ordered.order, {
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
          modelPort: options.modelPort,
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

      // All program/model settlement belongs to this same isolated floor. No SQL
      if(input.legacyImport!==undefined){
        const imported=applySqlLegacyImport({db:candidateDb,branchId,turnId,clockS:clockBefore,nowWallMs:now(),rulesetVersion,makeId,legacy:input.legacyImport});
        groupResults.push(imported.result);allIssues.push(...imported.issues);
      }
      if(input.sceneMaps||input.mapCalibration||input.mapBackground){
        const mapGroup=compileSqlSceneMaps({db:candidateDb,branchId,turnId,clockS:clockBefore,makeId,ensureScenes:input.sceneMaps,calibration:input.mapCalibration,povName:input.povName,background:input.mapBackground});
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
        operations: input.sceneOnly?[]:parsedOperations, modelPort: input.manual||input.sceneOnly ? null : options.modelPort,
        modelBudget: Math.max(0, ATLAS_RUNTIME_LIMITS.foregroundModelBatchesPerTurn - foregroundBatches - (repairAttempted ? 1 : 0)),
        makeId, isCurrent: input.isCurrent });
      beginTransaction(candidateDb);
      transactionOpen = true;
      allIssues.push(...simulation.issues);
      groupResults.push(...simulation.groups);
      parsedOperations.push(...simulation.modelOperations);
      timeChanged = simulation.clockAfter !== clockBefore;

      // Entities/maps must exist before the model can reference them. Release the
      // isolated candidate transaction during the spatial model request as well.
      const layoutTask=input.layoutMaps?buildSqlLayoutTask(candidateDb,branchId,input,turnId):null;
      if(layoutTask&&options.modelPort&&foregroundBatches+(repairAttempted?1:0)+(simulation.modelBatches??0)<ATLAS_RUNTIME_LIMITS.foregroundModelBatchesPerTurn){
        preparationStep='before-layout';
        commitTransaction(candidateDb);transactionOpen=false;
        try{
          const response=await options.modelPort.request(layoutTask.request);
          attempts.push({id:`att_${attempts.length}`,kind:'layout',phase:'geography',http_status:response.httpStatus,response_chars:response.text?.length??0,response_hash:sha256HexSync(response.text??'')});
          if(input.isCurrent&&!input.isCurrent()||currentRevision()!==anchor.baseRevision)throw new AtlasDbError('STALE_BASE','布局生成期间聊天或世界修订已变化，候选不发布',{});
          const extracted=extractPayload(response.text??''),parsed=parseOperations(extracted.payload,{phase:'geography'});
          allIssues.push(...extracted.issues,...parsed.issues);
          const layoutRefs=collectKnownRefs(createTableReadPort(candidateDb),branchId);
          const allowedRefs=new Set(layoutRefs.filter(r=>layoutTask.mapIds.includes(r.id)).flatMap(r=>[r.id,r.alias]));
          const ops=parsed.operations.filter(op=>op.value.op==='map.layout.request'&&allowedRefs.has(op.value.ref??'')).map(op=>{
            const id=layoutRefs.find(r=>r.id===op.value.ref||r.alias===op.value.ref)?.id;
            const extent=id?layoutTask.extents[id]:undefined;
            const data=op.value.data,spec=data?.spec;
            // The program supplies the schematic canvas. Omitted canvas dimensions
            // must not discard otherwise valid AI room and furniture constraints.
            if(extent&&Number.isFinite(extent.width)&&Number.isFinite(extent.height)&&extent.width>0&&extent.height>0&&spec&&typeof spec==='object'&&!Array.isArray(spec)){
              return {...op,opId:`layout_${op.opId}`,value:{...op.value,data:{...data,spec:{width:extent.width,height:extent.height,...spec}}}};
            }
            return {...op,opId:`layout_${op.opId}`};
          });
          if(!ops.length)allIssues.push({code:'LAYOUT_NOT_GENERATED',path:'$.layout',message:'模型没有返回空间布局约束；已登记地点仍保留，可在当前地图点击生成布局重试',severity:'warning',retryable:true});
          const layoutCompiled=compileOperations({operations:ops,anchor,phase:'geography',clockS:clockBefore,revision:rev,
            tables:createTableReadPort(candidateDb),sources:{phase:'geography',snapshot:sourceSnapshot,clockS:clockBefore},makeId,
            knownRefs:collectKnownRefs(createTableReadPort(candidateDb),branchId),turnId,allowedOps:['map.layout.request']});
          const groups=buildAtomicGroups(layoutCompiled.results.map(r=>({opId:r.opId,issues:r.result.issues,mutations:r.result.mutations,readSet:r.result.readSet,dependencies:r.result.dependencies,entityKeyWrites:r.result.entityKeyWrites,operationKeys:r.result.operationKeys})));
          allIssues.push(...layoutCompiled.issues,...groups.issues);
          beginTransaction(candidateDb);transactionOpen=true;
          const appliedLayout=applyGroups(candidateDb,orderGroups(groups.groups).order,{branchId,turnId,attemptId:'layout',validate:true});
          groupResults.push(...appliedLayout.groups);parsedOperations.push(...ops);
          for(const message of appliedLayout.journalIssues)allIssues.push({code:'JOURNAL_WRITE_FAILED',path:'$.layout',message,severity:'error',retryable:false});
        }catch(error){
          if(!transactionOpen){beginTransaction(candidateDb);transactionOpen=true;}
          if(error instanceof AtlasDbError&&error.code==='STALE_BASE')throw error;
          allIssues.push({code:'LAYOUT_MODEL_FAILED',path:'$.layout',message:`空间布局未生成：${(error as Error).message}。已登记的世界数据保留，可单独重试布局。`,severity:'warning',retryable:true});
          attempts.push({id:`att_${attempts.length}`,kind:'layout',phase:'geography',error:(error as Error).message});
        }
      }

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

      const spatial = applyPendingSpatialRequests({
        db: candidateDb,
        scope: { chatId: anchor.chatUid, branchId, revision: rev, viewMode: 'author' },
        isCurrent: spatialGuard,
        turnId,
        clockS: clockBefore,
        ports: spatialPorts,
      });
      groupResults.push(...spatial.groups);
      allIssues.push(...spatial.issues);

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
      worldChanged = simulation.worldChanged || appliedGroups.some((g) => g.changedRows > 0);
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

      // 5) 记录回执、状态与同步任务（同一事务）
      runBound(candidateDb, `UPDATE turns SET status = ?, committed_revision = ?, receipt_json = ?, attempts_json = ?, decisions_json = ? WHERE id = ?`, [
        receipt.status === 'failed' ? 'failed' : receipt.status === 'partial' ? 'partial' : 'committed',
        receipt.status === 'failed' ? null : newRevision,
        JSON.stringify(receipt),
        JSON.stringify(attempts.slice(0, ATLAS_RUNTIME_LIMITS.detailedAttemptsPerTurn)),
        JSON.stringify({ operations: parsedOperations.map((p) => p.value),
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
        });
      }

      return await exportCandidateImpl(candidate, receipt);
    } catch (err) {
      const failedForeignKeys=committed?[]:foreignKeyCheck(candidateDb);
      if (!committed) {
        if (transactionOpen) rollbackTransaction(candidateDb);
        await discardPreparedImpl(candidate.token);
      } else if (err instanceof AtlasDbError && err.code === 'TURN_FAILED') {
        throw err;
      } else {
        await discardPreparedImpl(candidate.token);
      }
      if (err instanceof AtlasDbError) throw err;
      throw new AtlasDbError('TURN_PREPARE_FAILED', `准备回合失败（${preparationStep}）：${(err as Error).message}${failedForeignKeys.length?'；未完成依赖：'+failedForeignKeys.map(v=>`${v.table}→${v.parent}`).join(', '):''}`, { sequencesUsed,preparationStep,foreignKeys:failedForeignKeys,groups:groupResults });
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
      return { applied: [] };
    }
    args.attempts.push({
      id: `att_${args.attempts.length}`,
      kind: 'repair',
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
    const recompiled = compileOperations({
      operations: merged.operations,
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
        clockBeforeS: Number(targetTurn[0].clock_before_s ?? 0),
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
