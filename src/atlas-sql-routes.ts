/** SQL request dispatch. Repository and save ownership stay with the host. */
import { AtlasError, ATLAS_ERROR_CODES } from './atlas-contract.ts';
import { toLegacyStateDto, toLegacyTurnReceipt, toPovStateDto } from './atlas-db-state-adapter.ts';
import { okResult, errorResult } from './atlas-route-result.ts';
import type {AtlasRequestContext} from './atlas-server-contract.ts';
import type {AtlasRouteResult} from './atlas-route-result.ts';
import type { AtlasSqlRuntime, SqlSession } from './atlas-sql-session.ts';
import { readUpgradeBackup } from './atlas-sql-session.ts';
import type { AtlasSqlRepositoryWithHelpers } from './atlas-db-repository.ts';
import type { AtlasModelPort } from './atlas-db-contract.ts';
import type { LorebookPort, ManagedLorebookEntry } from './atlas-db-outbox.ts';
import type { AtomicGroup, Issue, MaintenanceInput, TurnAnchor, TurnInput, ViewQuery } from './atlas-ops-contract.ts';
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** SQL 模式在宿主侧的落点：envelope 写进这份 chatMetadata，保存走宿主的保存函数。 */
export type AtlasSqlHostBinding = {
  chatMetadata: Record<string, unknown>;
  saveSession?: (() => Promise<unknown>) | null;
  writeSession?:
    | ((
        context: () => unknown,
        session: unknown,
        expectedChatId?: string | null,
        expectedMetadata?: unknown,
      ) => Promise<unknown>)
    | null;
  confirmSave?: boolean;
};

export type AtlasSqlSessionProvider = {
  enabled(): boolean;
  runtime(): Promise<AtlasSqlRuntime>;
  session(chatUid: string, branchId?: string): Promise<SqlSession>;
  saved(session: SqlSession): void;
  close(): Promise<void>;
  /**
   * M1-06A：只读拿当前聊天的落点（chatMetadata），**不打开 session、不迁移、不保存**。
   *
   * 存在的理由：浏览器扩展只注入 `sessionProvider`，从来不注入 `host`。
   * 而「升级前原档导出」必须能在没有 session 的情况下读备份，否则入口在、功能不可达。
   * 可选实现：不提供就退回 `host.chatMetadata`（Node 宿主的走法）。
   */
  metadata?(chatUid: string): Record<string, unknown> | null;
};

export type AtlasSqlRouteGroupDeps = {
  repository: AtlasSqlRepositoryWithHelpers | null;
  sessionProvider?: AtlasSqlSessionProvider | null;
  modelPort?: AtlasModelPort | null;
  host?: AtlasSqlHostBinding | ((chatUid: string) => AtlasSqlHostBinding | null) | null;
  lorebookPort?: LorebookPort | null;
  buildProjection?: (scope: "pov" | "scene_portrayal", revision: number) => ManagedLorebookEntry[];
  now?: () => number;
  /** H13：SQL 运行时（会话/补交/投影函数）。见下方 loadSqlRuntime 的说明。 */
  runtime?: AtlasSqlRuntime | null;
};

/**
 * H13：解析 SQL 运行时。
 *
 * **不能**在这里写静态或字面量动态 import：`atlas-server.ts` 被 `atlas-browser-entry.ts` 打包进
 * `atlas-ui-core.mjs`，一旦静态可达，esbuild 会把整个 sql.js/wasm 运行时代码塞进 UI 核心包
 * （H14 明确要求 SQL 核心是独立产物，且发布包扫描会因此报本地绝对路径）。
 * 因此：优先用宿主注入的 `sqlRuntime`；否则用**运行期拼出的模块名**加载
 * （esbuild 不会跟踪非字面量 import，Node 下按导入方 URL 正常解析）。
 */
async function loadSqlRuntime(): Promise<AtlasSqlRuntime | null> {
  const specifier = "./atlas-sql-session.ts";
  try {
    const mod = (await import(specifier)) as typeof import("./atlas-sql-session.ts");
    if (typeof mod.loadAtlasSqlRuntime !== "function") return null;
    return await mod.loadAtlasSqlRuntime();
  } catch {
    return null;
  }
}

/** §16.8：统一诊断形状（与既有 pushLog 的具名 code 口径一致）。 */
function sqlIssue(code: string, message: string, severity: Issue["severity"] = "error", retryable = false): Issue {
  return { code, path: "$", message, severity, retryable };
}

function sqlInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;
}

function sqlText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * M5-08A：错误按「冲突 / 参数 / 服务」三类各归各位。
 *
 * - 冲突 409：客户端拿着旧身份或过期游标，重读一次即可 —— 不是服务坏了，别误报 500。
 * - 参数 400：形状或取值不对，重试无用。
 * - 其余 500：服务端真故障。DB_UPGRADE_FAILED / DB_SCHEMA_UNSUPPORTED 保持 500 且**不清空库**
 *   （库本身没坏，只是这个构建读不了；清空等于把用户世界删了）。
 */
const CONFLICT_CODES = new Set([
  'STALE_BASE', 'CHAT_CHANGED', 'SESSION_STALE', 'CANDIDATE_UNKNOWN',
  'VIEW_CURSOR_STALE', 'SQL_PREVIEW_EXPIRED',
]);
const BAD_REQUEST_CODES = new Set(['INVALID_PAYLOAD', 'VIEW_CURSOR_INVALID', 'FEED_POV_ID_REQUIRED']);

function sqlErrorResult(thrown: unknown): AtlasRouteResult {
  const candidate = thrown as { code?: unknown; message?: unknown; detail?: unknown };
  if (candidate && typeof candidate.code === "string" && candidate.code.length > 0) {
    const code = candidate.code;
    const failedReceipt = isPlainRecord(candidate.detail) && isPlainRecord(candidate.detail.receipt) ? candidate.detail.receipt : null;
    const receiptIssues = failedReceipt && Array.isArray(failedReceipt.issues) ? failedReceipt.issues.filter(isPlainRecord) : [];
    const retryable = code === 'TURN_FAILED' && receiptIssues.some(i => i.retryable === true);
    const status = CONFLICT_CODES.has(code) ? 409 : BAD_REQUEST_CODES.has(code) ? 400 : 500;
    return {
      status,
      body: {
        ok: false,
        error: {
          code,
          message: receiptIssues.length ? receiptIssues.map(i => String(i.message ?? i.code)).join('；') : String(candidate.message ?? code),
          details: isPlainRecord(candidate.detail) ? candidate.detail : {},
          retryable,
        },
      },
    };
  }
  return errorResult(thrown);
}

export function createAtlasSqlRouteGroup(deps: AtlasSqlRouteGroupDeps) {
  const sessions = new Map<string, SqlSession>();
  const now = deps.now ?? (() => Date.now());
  let runtimePromise: Promise<AtlasSqlRuntime | null> | null = null;

  function enabled(): boolean {
    if (deps.sessionProvider) return deps.sessionProvider.enabled();
    return deps.repository !== null && deps.repository !== undefined;
  }

  function sqlRuntime(): Promise<AtlasSqlRuntime | null> {
    if (deps.sessionProvider) return deps.sessionProvider.runtime();
    if (deps.runtime) return Promise.resolve(deps.runtime);
    if (!runtimePromise) runtimePromise = loadSqlRuntime();
    return runtimePromise;
  }

  function hostFor(chatUid: string): AtlasSqlHostBinding | null {
    if (!deps.host) return null;
    return typeof deps.host === "function" ? deps.host(chatUid) : deps.host;
  }

  /**
   * 聊天落点的解析顺序：**先问会话提供者，再退回 host 绑定**。
   *
   * 为什么顺序是这样：浏览器扩展的 `createAtlasServerCore` 只传 `sqlSessionProvider`，
   * 不传 `host`；旧实现让 `/sql/upgrade-backup` 只认 `hostFor`，于是真扩展里
   * 「导出升级前原档」永远返回 `SQL 模式缺少聊天落点（chatMetadata）` ——
   * 入口画得出来，链路却是断的（M7-06 真酒馆验收抓到的 M1-06A 缺口）。
   * 这里只读落点，不打开 session、不迁移、不写库，导出仍然是纯只读操作。
   */
  function chatMetadataFor(chatUid: string): Record<string, unknown> | null {
    const fromProvider = deps.sessionProvider?.metadata?.(chatUid);
    if (isPlainRecord(fromProvider)) return fromProvider;
    const host = hostFor(chatUid);
    return host && isPlainRecord(host.chatMetadata) ? host.chatMetadata : null;
  }

  function requireChatUid(body: Record<string, unknown>): string {
    const chatUid = sqlText(body.chatUid);
    if (chatUid.length === 0) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "SQL 路由需要宿主聊天身份 chatUid");
    }
    return chatUid;
  }

  function disabled(route: string): AtlasRouteResult {
    return okResult({
      sqlMode: false,
      code: "SQL_MODE_DISABLED",
      route,
      receipt: null,
      coreSaved: false,
      revision: null,
      groups: [],
      state: null,
      issues: [
        sqlIssue(
          "SQL_MODE_DISABLED",
          `SQL 世界数据未启用（未注入 Repository）：${route} 不做任何写入，也不创建空世界`,
          "error",
          false,
        ),
      ],
    });
  }

  function unavailable(route: string): AtlasRouteResult {
    return okResult({
      sqlMode: true,
      code: "SQL_RUNTIME_UNAVAILABLE",
      route,
      receipt: null,
      coreSaved: false,
      revision: null,
      groups: [],
      state: null,
      issues: [
        sqlIssue(
          "SQL_RUNTIME_UNAVAILABLE",
          `SQL 模式已注入 Repository，但取不到 SQL 运行时（注入 sqlRuntime，或让加载器能解析 ${route} 需要的模块）：本路由不做任何写入`,
          "error",
          true,
        ),
      ],
    });
  }

  async function sessionFor(chatUid: string, branchId: string | undefined, runtime: AtlasSqlRuntime): Promise<SqlSession> {
    if (deps.sessionProvider) return deps.sessionProvider.session(chatUid, branchId);
    const key = `${chatUid}|${branchId ?? 'main'}`;
    const existing = sessions.get(key);
    if (existing && !existing.closed) return existing;
    const host = hostFor(chatUid);
    if (!host || !isPlainRecord(host.chatMetadata)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `SQL 模式缺少聊天落点（chatMetadata）：${chatUid}`);
    }
    const opened = await runtime.openSqlSession({
      chatUid,
      branchId,
      chatMetadata: host.chatMetadata,
      // 宿主没有保存函数时不能伪造成功：宿主端口会返回失败并保持 coreSaved=false。
      saveSession:
        typeof host.saveSession === "function"
          ? host.saveSession
          : async () => {
              throw new Error("HOST_SAVE_UNAVAILABLE：宿主没有提供保存函数（sqlHost.saveSession）");
            },
      writeSession: host.writeSession ?? undefined,
      modelPort: deps.modelPort ?? null,
      now,
      confirmSave: host.confirmSave,
      repository: deps.repository,
      lorebookPort: deps.lorebookPort ?? null,
      buildProjection: deps.buildProjection,
    });
    sessions.set(key, opened);
    return opened;
  }

  function headOf(session: SqlSession): string | null {
    try {
      return session.repo.internal.currentHeadTurnId();
    } catch {
      return null;
    }
  }

  function revisionOf(session: SqlSession): number {
    try {
      return session.repo.internal.currentRevision();
    } catch {
      return 0;
    }
  }

  function anchorFromBody(body: Record<string, unknown>, session: SqlSession, tag: string): TurnAnchor {
    return {
      chatUid: session.chatUid,
      branchId: session.branchId,
      parentTurnId: headOf(session),
      hostMessageUid: sqlText(body.hostMessageUid) || `${tag}:${session.chatUid}`,
      variantKey: sqlText(body.variantKey) || tag,
      baseRevision: sqlInt(body.baseRevision) ?? revisionOf(session),
      baseStorageRevision: session.repo.storageRevision,
      inputHash: sqlText(body.inputHash) || tag,
    };
  }

  async function handle(
    method: string,
    route: string,
    body: unknown,
    _ctx: AtlasRequestContext = {},
  ): Promise<AtlasRouteResult> {
    if (!enabled()) return disabled(route);
    if (method !== "POST") {
      return { status: 400, body: { ok: false, error: { code: "INVALID_PAYLOAD", message: `SQL 路由只接受 POST：${method} ${route}`, details: {}, retryable: false } } };
    }
    try {
      const record = isPlainRecord(body) ? body : {};
      const chatUid = requireChatUid(record);
      const branchId = sqlText(record.branchId) || undefined;
      const runtime = await sqlRuntime();
      if (!runtime) return unavailable(route);

      // M1-06A：升级前原档的只读导出。
      // 只读 chatMetadata，不 open session、不写库、不触发宿主保存，也不清除备份。
      if (route === "/sql/upgrade-backup") {
        const metadata = chatMetadataFor(chatUid);
        if (!metadata) {
          throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `SQL 模式缺少聊天落点（chatMetadata）：${chatUid}`);
        }
        const backup = readUpgradeBackup(metadata, chatUid);
        if (!backup) {
          // 无备份 / 备份损坏 / 备份属于另一个聊天：统一给同一个明确错误，不泄露他人备份是否存在。
          return errorResult(
            new AtlasError('BACKUP_NOT_AVAILABLE', '当前聊天没有可导出的升级前原档备份（或备份不属于本聊天）'),
          );
        }
        return okResult({
          route,
          code: 'BACKUP_AVAILABLE',
          backup: {
            version: backup.version,
            chatId: backup.chatId,
            branchId: backup.branchId,
            createdAtMs: backup.createdAtMs,
            sourceRevision: backup.sourceRevision,
            envelopeSha256: backup.envelopeSha256,
            envelopeSchemaVersion: backup.envelopeSchemaVersion,
            pendingUpgrade: backup.pendingUpgrade,
            envelope: backup.envelope,
          },
        });
      }

      if (route.startsWith('/sql/chat/')) {
        const session = await sessionFor(chatUid, branchId, runtime);
        const data = await runtime.handleSqlChatRequest(session, route.slice('/sql/chat/'.length), record);
        if (data.coreSaved === true) deps.sessionProvider?.saved(session);
        return okResult(data);
      }

      if (route === "/sql/turn") {
        const session = await sessionFor(chatUid, branchId, runtime);
        const input: TurnInput = {
          anchor: {
            chatUid,
            branchId: session.branchId,
            parentTurnId: headOf(session),
            hostMessageUid: sqlText(record.hostMessageUid),
            variantKey: sqlText(record.variantKey),
            baseRevision: sqlInt(record.baseRevision) ?? revisionOf(session),
            baseStorageRevision: session.repo.storageRevision,
            inputHash: sqlText(record.inputHash),
          },
          userText: sqlText(record.userText),
          assistantText: sqlText(record.assistantText),
          sourceSnapshot: (Array.isArray(record.sourceSnapshot) ? record.sourceSnapshot : []) as TurnInput["sourceSnapshot"],
          phaseBatches: (Array.isArray(record.phaseBatches) && record.phaseBatches.length > 0
            ? record.phaseBatches
            : ["observe"]) as TurnInput["phaseBatches"],
          manual: record.manual === true,
          sceneMaps:true,
          operations: Array.isArray(record.operations) ? (record.operations as TurnInput["operations"]) : undefined,
        };
        const result = await runtime.runSqlTurn(session, input);
        if (result.coreSaved) deps.sessionProvider?.saved(session);
        return okResult({
          receipt: result.receipt,
          coreSaved: result.coreSaved,
          duplicate: result.duplicate === true,
          revision: revisionOf(session),
          groups: result.receipt.groups,
          issues: result.issues,
          // §6.3：旧接口字段只在读取适配器里转换（partial → committed + rejectedGroups）。
          legacyReceipt: toLegacyTurnReceipt(result.receipt, { coreSaved: result.coreSaved }),
        });
      }

      if (route === "/sql/retry") {
        const session = await sessionFor(chatUid, branchId, runtime);
        const turnId = sqlText(record.turnId);
        const groups = (Array.isArray(record.groups) ? record.groups : []) as AtomicGroup[];
        const result = await runtime.runSqlRetry(session, {
          branchId: session.branchId,
          chatUid,
          turnId,
          currentHeadTurnId:
            record.currentHeadTurnId === undefined
              ? headOf(session)
              : record.currentHeadTurnId === null
                ? null
                : sqlText(record.currentHeadTurnId),
          attemptId: sqlText(record.attemptId) || `retry_${turnId}`,
          groups,
          appliedKeys: new Set((Array.isArray(record.appliedKeys) ? record.appliedKeys : []).map(String)),
          clockS: sqlInt(record.clockS) ?? 0,
        });
        const issues = [...result.issues];
        const coreSaved = result.coreSaved;
        if (coreSaved) deps.sessionProvider?.saved(session);
        return okResult({
          status: result.status,
          coreSaved,
          revision: revisionOf(session),
          groups: result.groups,
          issues,
        });
      }

      if (route === "/sql/rollback") {
        const session = await sessionFor(chatUid, branchId, runtime);
        const result = await runtime.runSqlRollback(session, {
          chatUid,
          branchId: session.branchId,
          targetParentTurnId: sqlText(record.targetParentTurnId),
          expectedRevision: sqlInt(record.expectedRevision) ?? revisionOf(session),
        });
        if (result.coreSaved) deps.sessionProvider?.saved(session);
        return okResult({
          receipt: result.receipt,
          coreSaved: result.coreSaved,
          revision: revisionOf(session),
          groups: result.receipt.groups,
          issues: result.issues,
          legacyReceipt: toLegacyTurnReceipt(result.receipt, { coreSaved: result.coreSaved }),
        });
      }

      if (route === "/sql/state") {
        const session = await sessionFor(chatUid, branchId, runtime);
        const kind = sqlText(record.kind) || "map";
        const viewMode = record.viewMode === "author" ? "author" : record.viewMode === "pov" ? "pov" : undefined;
        const povId = sqlText(record.povId) || undefined;
        const revision = sqlInt(record.revision) ?? undefined;
        const entityLimit = sqlInt(record.entityLimit) ?? undefined;
        if (kind === "prompt") {
          // §10.4：作者开关只改 UI 过滤，不改注入范围。
          const projection = runtime.projectPromptView(
            { db: session.repo.db, branchId: session.branchId },
            {
              povId: povId ?? null,
              sceneLocationId: sqlText(record.sceneLocationId) || null,
              actorIds: (Array.isArray(record.actorIds) ? record.actorIds : []).map(String),
              viewMode,
            },
          );
          return okResult({
            kind,
            branchId: session.branchId,
            revision: revisionOf(session),
            state: toPovStateDto(projection.pov, { viewMode }),
            promptScope: projection.promptScope,
            portrayal: projection.portrayal,
            nextCursor: null,
            metadata: { kind, viewMode: viewMode ?? "pov", injectionUnchangedByViewMode: true },
            issues: [],
          });
        }
        const query: ViewQuery = {
          kind: kind as ViewQuery["kind"],
          branchId: session.branchId,
          revision,
          mapId: sqlText(record.mapId) || undefined,
          entityId: sqlText(record.entityId) || undefined,
          povId,
          viewMode,
          cursor: sqlText(record.cursor) || undefined,
          limit: sqlInt(record.limit) ?? undefined,
        };
        const view = await session.repo.queryView(query);
        const state = toLegacyStateDto(view, query, entityLimit === undefined ? {} : { entityLimit });
        return okResult({
          kind,
          branchId: view.branchId,
          revision: view.revision,
          state,
          metadata: state.metadata ?? {},
          nextCursor: view.nextCursor ?? null,
          issues: [],
        });
      }

      if (route === "/sql/maintenance") {
        const session = await sessionFor(chatUid, branchId, runtime);
        const anchor = anchorFromBody(record, session, "maintenance");
        const input: MaintenanceInput = {
          anchor,
          outboxResults: Array.isArray(record.outboxResults)
            ? (record.outboxResults as MaintenanceInput["outboxResults"])
            : undefined,
          failedAttempt: isPlainRecord(record.failedAttempt)
            ? (record.failedAttempt as MaintenanceInput["failedAttempt"])
            : undefined,
        };
        const persisted = await runtime.runSqlMaintenance(session, input);
        if (persisted.saved) deps.sessionProvider?.saved(session);
        return okResult({
          coreSaved: persisted.saved,
          revision: revisionOf(session),
          storageRevision: session.repo.storageRevision,
          envelope: persisted.envelope
            ? { sha256: persisted.envelope.sha256, byte_length: persisted.envelope.byte_length, storage_revision: persisted.envelope.storage_revision }
            : null,
          issues: persisted.issues,
        });
      }

      if (route === "/sql/migrate") {
        const host = hostFor(chatUid);
        if (!host || !isPlainRecord(host.chatMetadata)) {
          throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `SQL 迁移缺少聊天落点（chatMetadata）：${chatUid}`);
        }
        const result = await runtime.migrateSessionToSql({
          chatUid,
          branchId,
          chatMetadata: host.chatMetadata,
          saveSession:
            typeof host.saveSession === "function"
              ? host.saveSession
              : async () => {
                  throw new Error("HOST_SAVE_UNAVAILABLE：宿主没有提供保存函数（sqlHost.saveSession）");
                },
          writeSession: host.writeSession ?? undefined,
          modelPort: deps.modelPort ?? null,
          now,
          confirmSave: host.confirmSave,
          repository: deps.repository,
          legacy: record.legacy ?? record.session ?? record,
        });
        return okResult({
          inspection: result.inspection,
          mapped: result.mapped,
          backup: result.backup,
          counts: result.counts,
          saved: result.saved,
          coreSaved: result.saved,
          issues: result.issues,
        });
      }

      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `未知 SQL 路由：${method} ${route}`);
    } catch (thrown) {
      return sqlErrorResult(thrown);
    }
  }

  return {
    handle,
    enabled,
    sessionCount(): number {
      return sessions.size;
    },
    async close(): Promise<void> {
      if (deps.sessionProvider) { await deps.sessionProvider.close(); return; }
      if (sessions.size === 0) return;
      const runtime = await sqlRuntime();
      if (!runtime) {
        sessions.clear();
        return;
      }
      for (const session of sessions.values()) {
        try {
          await runtime.closeSqlSession(session);
        } catch {
          /* 关闭失败不覆盖已有诊断 */
        }
      }
      sessions.clear();
    },
  };
}

export type AtlasSqlRouteGroup = ReturnType<typeof createAtlasSqlRouteGroup>;
