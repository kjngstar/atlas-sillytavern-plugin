/** Host contracts shared by the published SQL dispatcher and migration readers. */
import type {AtlasDiagnostic} from './atlas-diagnostics.ts';
import type {AtlasTablesStoreV1} from './atlas-tables.ts';
import type {AtlasSimulationStore} from './atlas-simulation.ts';
import type {AtlasSqlSessionProvider,AtlasSqlHostBinding} from './atlas-sql-routes.ts';
import type {AtlasSqlRuntime} from './atlas-sql-session.ts';
import type {AtlasSqlRepositoryWithHelpers} from './atlas-db-repository.ts';
import type {AtlasModelPort} from './atlas-db-contract.ts';
import type {LorebookPort,ManagedLorebookEntry} from './atlas-db-outbox.ts';
export interface AtlasDocumentStore {
  read(name: string): Promise<unknown | null>;
  write(name: string, value: unknown): Promise<void>;
  remove(name: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface AtlasSessionDoc {
  schemaVersion: number;
  rev: number;
  binding: unknown | null;
  world: unknown | null;
  maps: unknown | null;
  scene: unknown | null;
  turns: Record<string, unknown>;
  geoAuto: Record<string, unknown>;
  /**
   * A05：三表快照（按分支，见 `src/atlas-tables.ts`）。
   * null = 旧会话（尚未迁移）或 tables 校验未通过——两种情况的处理完全不同，
   * 因此解析结果另带 `tablesError`，调用方不得用 `tables === null` 推断「需要迁移」。
   */
  tables: AtlasTablesStoreV1 | null;
  /**
   * C04：会话级「后台推演模块」（见 `src/atlas-simulation.ts`）。
   * null = 旧会话（本字段不存在）或 simulation 校验未通过；两者处理完全不同，
   * 因此解析结果另带 `simulationError`，调用方**不得**用 `simulation === null` 推断「需要迁移」。
   */
  simulation: AtlasSimulationStore | null;
}

export interface AtlasServerCoreDeps {
  store: AtlasDocumentStore;
  fetchFn?: typeof fetch;
  /** 毫秒时钟（默认 Date.now；测试注入固定时钟） */
  now?: () => number;
  /** Safe metadata events; subscriber failures never change route results. */
  onDiagnostic?: (event: AtlasDiagnostic) => void;
  /**
   * H13：SQL 世界数据模式注入的 Repository（与浏览器/本地模式**同一个**业务核心）。
   * 缺省 = 未启用 SQL：`/sql/*` 一律返回 `SQL_MODE_DISABLED`，没有旧写入兜底。
   */
  sqlRepository?: AtlasSqlRepositoryWithHelpers | null;
  /** Browser host owns a lazy repository per captured chat/branch instead of a global singleton. */
  sqlSessionProvider?: AtlasSqlSessionProvider | null;
  /** SQL 模式的前台模型端口（阶段批量）。 */
  sqlModelPort?: AtlasModelPort | null;
  /** SQL 模式的宿主落点（chatMetadata + 保存函数）；可按 chatUid 决定。 */
  sqlHost?: AtlasSqlHostBinding | ((chatUid: string) => AtlasSqlHostBinding | null) | null;
  /** SQL 模式的世界书端口（可选；同步失败只报 WORLD_SYNC_FAILED，不丢核心回合）。 */
  sqlLorebookPort?: LorebookPort | null;
  sqlBuildProjection?: (scope: "pov" | "scene_portrayal", revision: number) => ManagedLorebookEntry[];
  /**
   * H13：SQL 运行时（`loadAtlasSqlRuntime()` 的结果）。
   *
   * 本地/浏览器模式应从 **`atlas-sql.mjs`** 取它注入这里；Node 模式注入自己那份。
   * 不注入时会退回运行期解析（Node 直接跑 src 时可用）；两者都拿不到就返回
   * `SQL_RUNTIME_UNAVAILABLE`。这样 `atlas-ui-core.mjs` 不会因为本文件而被打进 sql.js。
   */
  sqlRuntime?: AtlasSqlRuntime | null;
}

export interface AtlasRequestContext {
  /** 是否本机已登录会话（Express 侧由 SillyTavern 会话中间件判定） */
  local?: boolean;
}
