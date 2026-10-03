/**
 * atlas-sql-browser-entry.ts — H14 sql.js 业务核心的浏览器打包入口。
 *
 * **独立产物**：`atlas-extension/dist/atlas-sql.mjs`。
 * 与 `atlas-ui-core.mjs` 分开的原因（§16.1）：sql.js + wasm 体积较大，
 * 只有真正启用 SQL 世界数据时才需要加载；UI 外壳与旧三表路径不受影响。
 *
 * 产物依赖三个**相对路径的本地资源**，全部随组件打包，不依赖任何 CDN：
 *   ./vendor/sql-wasm.js       （sql.js 1.14.1 的 JS 侧，固定版本）
 *   ./vendor/sql-wasm.wasm     （同版本 wasm）
 *   ./atlas-sql-worker.js      （本入口的 Worker 版本）
 */

import initSqlJs from 'sql.js';
import type { SqlJsStatic } from 'sql.js';

export {
  createSqlRepository,
  collectEntityRefs,
  collectKnownRefs,
  collectDescendants,
  restoreTurnChanges,
  assertTwentyTables,
  mergeRow,
  mergeChangedFields,
} from './atlas-db-repository.ts';

export {
  injectSqlModule,
  loadSqlModule,
  openDatabase,
  resetSqlModuleForTests,
  enableForeignKeys,
  queryBound,
  queryOne,
  runBound,
  foreignKeyCheck,
  userTableNames,
  AtlasDbError,
  type SqlDatabase,
  type SqlModule,
} from './atlas-db-runtime.ts';

export { installSchema, installSchemaSafe, ATLAS_SCHEMA_VERSION, USER_TABLE_COUNT, ATLAS_TABLE_COLUMNS } from './atlas-db-schema.ts';
export { encodeSnapshot, decodeSnapshot, envelopeSummary, sha256Hex } from './atlas-db-envelope.ts';
export { createWorkerClient, handleWorkerMessage, WORKER_METHODS, type WorkerMethod } from './atlas-db-worker.ts';
export { withChatCommitLock, commitLockMode } from './atlas-db-queue.ts';
export { createAtlasHostPort, describeHostCapabilities, readEnvelope, ATLAS_DATABASE_KEY } from './atlas-host-port.ts';
export { saveCandidate, createHostSaveAdapter, reconcileUnknownSave } from './atlas-host-save.ts';
export { ATLAS_RUNTIME_LIMITS, ATLAS_FIELD_LIMITS } from './atlas-runtime-limits.ts';
export { parseOperations, extractPayload, looksLikeSql } from './atlas-ops-parser.ts';
export { normalizeOperation, validateMinimum } from './atlas-ops-normalize.ts';
export { compileOperations } from './atlas-ops-compile.ts';
export { buildAtomicGroups, orderGroups } from './atlas-ops-groups.ts';
export { applyGroups } from './atlas-db-commit.ts';
export { validateCandidate } from './atlas-db-invariants.ts';
export { buildStagePrompt } from './atlas-ops-prompts.ts';
export { projectForPov, projectPortrayal, projectPromptView, renderSqlSceneContext } from './atlas-db-knowledge-view.ts';
export { resolveEffectivePosition } from './atlas-sim-position.ts';
export { enqueueProjectionSync, runNextSync, rebuildManagedLorebook } from './atlas-db-outbox.ts';
export { forkBranch } from './atlas-db-branches.ts';
export { retryFailedGroups } from './atlas-db-retry.ts';
/* E08 删楼回退：只读计划 + 调用方事务内应用（§7.4）。 */
export { planRollback, applyRollbackPlan, ROLLBACK_DEFAULT_MAX_TURNS, ROLLBACK_DEFAULT_MAX_STEPS, type RollbackPlan, type RollbackStep } from './atlas-db-rollback.ts';
/* E15 提及候选生命周期（§6.5）：返回 RowMutation，不直接写库。 */
export { updateMentionCandidates, promoteMention, MENTION_CANDIDATE_LIMIT, type MentionObservation } from './atlas-db-mentions.ts';
/* G10 §16.8 统一诊断对象与导出分页（日志页/推进页引用同一 log id）。 */
export {
  normalizeWorldIssue,
  normalizeWorldIssueList,
  diagnosticsExportPage,
  redactWorldSecrets,
  type AtlasWorldIssueInput,
} from './atlas-diagnostics.ts';
export { inspectLegacySession, migrateLegacyEntities, migrateLegacySimulation, finalizeMigration } from './atlas-db-migrate.ts';
export {
  ATLAS_SQL_VENDOR_FILES,
  sqlVendorLocator,
  resolveSqlAssetBase,
  verifySqlVendorAssets,
  type SqlVendorAsset,
} from './atlas-db-assets.ts';

/* —— H01–H04：SQL 世界数据会话桥与旧 UI DTO 适配器 —— */

export {
  ATLAS_SQL_MODE_KEY,
  isSqlModeEnabled,
  readSqlEnvelope,
  openSqlSession,
  persistSqlSession,
  runSqlTurn,
  runSqlRetry,
  runSqlMaintenance,
  runSqlRollback,
  migrateSessionToSql,
  closeSqlSession,
  // H13：Node 服务插件要用它把同一份运行时的**函数表**注入核心
  // （浏览器侧由 Worker 承载，不需要这个入口）。
  loadAtlasSqlRuntime,
  type SqlSession,
  type SqlSessionOptions,
  type OpenSqlSessionResult,
  type PersistSqlOptions,
  type PersistSqlResult,
  type SqlTurnResult,
  type SqlRollbackResult,
  type SqlMigrationResult,
  type AtlasSqlRuntime,
} from './atlas-sql-session.ts';

export {
  LEGACY_ENTITY_CAP,
  toLegacyStateDto,
  toLegacyTurnReceipt,
  toPovStateDto,
  type LegacyStateOptions,
  type LegacyReceiptOptions,
  type PovStateOptions,
} from './atlas-db-state-adapter.ts';

/** 便于宿主检查版本固定：sql.js 只从本地 vendor 目录加载。 */
export const ATLAS_SQL_VERSION = '1.14.1';
export type { SqlJsStatic };
export { initSqlJs };
