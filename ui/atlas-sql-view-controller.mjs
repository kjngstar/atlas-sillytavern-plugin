import {atlasContextRecord, ATLAS_SESSION_KEY} from './atlas-host-context.mjs';
/** Read-only snapshot lifecycle. It never returns legacy data when SQL is selected. */
export function createSqlViewController(deps) {
 const {state,data,getContext,sqlMode,getViewMode,emitAtlasDiagnostic,emitSqlBridgeMissing,renderPage,atlasSqlCoreStatus,ATLAS_SQL_VIEW_KEYS,ATLAS_SQL_MODE_SETTING}=deps;
  /** 视图 DTO 取值：`/state` 的 `sqlViews.<kind>` 与扁平键 `sql<Kind>` 两种下发形态都认。 */
  function sqlViewOf(kind, d) {
    const flat = d?.[ATLAS_SQL_VIEW_KEYS[kind] ?? ""];
    if (flat && typeof flat === "object") return flat;
    const nested = d?.sqlViews?.[kind];
    return nested && typeof nested === "object" ? nested : null;
  }

  /** H13 本地模式：SQL 快照信封是否就在本聊天里（`chatMetadata.atlas.<ATLAS_DATABASE_KEY>`）。 */
  function sqlEnvelopePresent() {
    try {
      const metadata = atlasContextRecord(getContext)?.chatMetadata;
      const atlas = metadata && typeof metadata === "object" ? metadata[ATLAS_SESSION_KEY] : null;
      if (!atlas || typeof atlas !== "object") return false;
      const key = String(sqlMode.module?.ATLAS_DATABASE_KEY ?? "database");
      return atlas[key] !== undefined && atlas[key] !== null;
    } catch {
      return false;
    }
  }

  /**
   * 打开（或复用）**只读**SQL 会话：`openSqlSession` 对既有信封只做 decode + open，不写库；
   * UI 只用它查视图，世界写入仍然只有 `/sql/turn` 一个入口（§16.4「同一时刻一个写者」）。
   * 聊天 / 分支变化即整体作废并关闭旧会话。
   */
  function sqlSnapshotScope(d) {
    const record = atlasContextRecord(getContext);
    const metadata = record?.chatMetadata ?? null;
    const envelope = metadata?.[ATLAS_SESSION_KEY]?.[String(sqlMode.module?.ATLAS_DATABASE_KEY ?? "database")];
    return {
      key: JSON.stringify([String(state().chatId ?? ""), String(record?.chatId ?? ""),
        String(d?.branchId ?? state().binding?.branchId ?? "main"),
        envelope?.storage_revision ?? null, envelope?.sha256 ?? null, d?.revision ?? null, JSON.stringify(envelope?.assets ?? [])]),
      // 比较实际快照内容，不能只信外部声明的 hash；不把正文/快照放进日志或缓存键。
      snapshotData: envelope?.data ?? null,
      metadata,
    };
  }

  function sqlSameSnapshot(a, b) {
    return a.key === b.key && a.snapshotData === b.snapshotData && a.metadata === b.metadata;
  }

  async function sqlOpenSession(d) {
    const mod = sqlMode.module;
    const captured = sqlSnapshotScope(d);
    if (sqlMode.session && sqlMode.sessionKey === captured.key
      && sqlMode.sessionData === captured.snapshotData && sqlMode.sessionMetadata === captured.metadata) return sqlMode.session;
    if (sqlMode.sessionPending && sqlSameSnapshot(sqlMode.sessionPending, captured)) return sqlMode.sessionPending.task;
    if (typeof mod?.openSqlSession !== "function") {
      emitSqlBridgeMissing(["openSqlSession"]);
      return null;
    }
    const pending = { ...captured, task: null };
    const task = (async () => {
      try {
        const ctx = getContext;
        const record = atlasContextRecord(ctx);
        const previous = sqlMode.session;
        sqlMode.session = null;
        sqlMode.sessionKey = "";
        if (previous && typeof mod.closeSqlSession === "function") {
          void Promise.resolve(mod.closeSqlSession(previous)).catch(() => {});
        }
        const session = await mod.openSqlSession({
          chatUid: String(record?.chatId ?? state().chatId ?? ""),
          branchId: d?.branchId ?? state().binding?.branchId ?? undefined,
          chatMetadata: captured.metadata,
          saveSession: async () => {
            throw new Error("SQL_READ_ONLY：视图快照不能保存世界数据");
          },
          // 唯一会话写回路径（与 chatMetadata.atlas 同源），但 UI 只读时根本不会走到写
          confirmSave: false,
        });
        if (!sqlMode.enabled || !sqlSameSnapshot(captured, sqlSnapshotScope(data()))) {
          if (typeof mod.closeSqlSession === "function") await mod.closeSqlSession(session);
          return null;
        }
        sqlMode.session = session;
        sqlMode.sessionKey = captured.key;
        sqlMode.sessionData = captured.snapshotData;
        sqlMode.sessionMetadata = captured.metadata;
        return session;
      } catch (error) {
        const code = String(error?.code ?? "SQL_SESSION_OPEN_FAILED");
        emitAtlasDiagnostic({
          level: "error", source: "storage", code: "SQL_SESSION_OPEN_FAILED",
          operation: "sql-session", phase: "open", outcome: "failed", errorCode: code,
          retryable: false,
          details: { message: error instanceof Error ? error.message : String(error) },
        });
        return null;
      } finally {
        if (sqlMode.sessionPending === pending) sqlMode.sessionPending = null;
      }
    })();
    pending.task = task;
    sqlMode.sessionPending = pending;
    return task;
  }

  /** 视图缓存键：聊天 / 分支 / 修订 / 视图模式 / 查询参数任一变化即重新查询（§10.1）。 */
  function sqlViewKey(kind, d, query) {
    return [
      kind,
      String(state().chatId ?? ""),
      String(d?.branchId ?? ""),
      String(d?.revision ?? d?.currentTime ?? ""),
      String(getViewMode()),
      JSON.stringify(query ?? {}),
    ].join("|");
  }

  /** 修订或聊天变化 → 旧视图整体失效（绝不让上一修订的卡片留在界面上）。 */
  function sqlSyncViewScope(d) {
    const snapshot = sqlSnapshotScope(d);
    const scopeKey = snapshot.key;
    if (sqlMode.viewScopeKey !== scopeKey || sqlMode.viewSnapshotData !== snapshot.snapshotData
      || sqlMode.viewSnapshotMetadata !== snapshot.metadata) {
      sqlMode.viewScopeKey = scopeKey;
      sqlMode.viewSnapshotData = snapshot.snapshotData;
      sqlMode.viewSnapshotMetadata = snapshot.metadata;
      sqlMode.viewEpoch++;
      sqlMode.views.clear();
      sqlMode.viewPending.clear();
      sqlMode.viewFailed.clear();
      sqlMode.viewRevision = null;
    }
  }

  /** 只读查询一个视图（本地 SQL 快照路径）。失败即具名诊断，绝不返回假视图。 */
  async function sqlQueryView(kind, query, d) {
    const captured = sqlSnapshotScope(d);
    const session = await sqlOpenSession(d);
    if (!sqlMode.enabled || !sqlSameSnapshot(captured, sqlSnapshotScope(data()))) return null;
    const queryView = session?.repo?.queryView;
    if (typeof queryView !== "function") {
      emitSqlBridgeMissing(["repo.queryView"]);
      return null;
    }
    try {
      return await queryView.call(session.repo, { kind, ...query });
    } catch (error) {
      emitAtlasDiagnostic({
        level: "error", source: "storage", code: "SQL_VIEW_QUERY_FAILED",
        operation: "sql-view", phase: "query", outcome: "failed", retryable: true,
        errorCode: String(error?.code ?? ""),
        details: { kind, message: error instanceof Error ? error.message : String(error) },
      });
      return null;
    }
  }

  /**
   * 触发一次异步取视图（结果落地后重渲染一次；同一键不重复发请求）。
   * 失败键记入 `viewFailed`：同一修订内不再重试（否则「渲染 → 查询失败 → 再渲染」会自激）。
   */
  function sqlKickView(kind, d, query) {
    const key = sqlViewKey(kind, d, query);
    const epoch = sqlMode.viewEpoch;
    const snapshot = sqlSnapshotScope(d);
    const isCurrent = () => sqlMode.enabled && epoch === sqlMode.viewEpoch && sqlSameSnapshot(snapshot, sqlSnapshotScope(data()));
    if (sqlMode.viewPending.has(key) || sqlMode.viewFailed.has(key)) return;
    sqlMode.viewPending.add(key);
    void sqlQueryView(kind, query, d)
      .then((view) => {
        if (!isCurrent()) return;
        sqlMode.viewPending.delete(key);
        if (!view || typeof view !== "object") {
          sqlMode.viewFailed.add(key);
          renderPage();
          return;
        }
        const revision = Number(view.revision);
        if (Number.isFinite(revision)) {
          if (sqlMode.viewRevision !== null && revision < sqlMode.viewRevision) {
            // 迟到的旧修订结果：丢弃，绝不覆盖当前修订的视图
            emitAtlasDiagnostic({
              level: "info", source: "storage", code: "SQL_VIEW_STALE_DROPPED",
              operation: "sql-view", phase: "response", outcome: "skipped",
              details: { kind, revision, currentRevision: sqlMode.viewRevision },
            });
            return;
          }
          sqlMode.viewRevision = revision;
        }
        sqlMode.views.set(key, view);
        renderPage();
      })
      .catch(() => {
        if (!isCurrent()) return;
        sqlMode.viewPending.delete(key);
        sqlMode.viewFailed.add(key);
      });
  }

  /** 供 H05 端口预热视图（不阻塞：结果落地会重渲染）。 */
  async function sqlWarmViews(d) {
    const wanted = [
      ["map", { mapId: undefined }],
      ["nearby", { entityId: String(d?.currentLocationId ?? "") || undefined }],
    ];
    for (const [kind, query] of wanted) {
      if (sqlMode.views.has(sqlViewKey(kind, d, query))) continue;
      const view = await sqlQueryView(kind, query, d);
      if (view) sqlMode.views.set(sqlViewKey(kind, d, query), view);
    }
  }

  /**
   * 面板级 SQL 视图决议（H06/H07/H08 共用）。
   *
   * 读权威顺序（§10.1「一个位置解析入口」）：
   * 1. `/state` 已带回该 kind 的 SQL 视图（服务端只读适配；远程模式走这条）；
   * 2. 浏览器手里有 SQL 快照信封 → 本地**只读**会话 `repo.queryView`（本地模式，H13）；
   * 3. 两者都没有 → 显示具名诊断与空的当前视图，不读旧世界。
   *
   * `active: true` 表示「本面板的读权威是 SQL」；否则返回具名 `code` + `note` 供调用方显示。
   */
  function sqlResolveView(kind, d = data(), query = null) {
    if (!sqlMode.enabled) return { active: false, reason: "off", view: null, code: null, note: null };
    if (sqlMode.core === "loading") {
      return {
        active: true, view: { items: [], metadata: {} }, reason: "loading", code: "SQL_CORE_LOADING",
        note: `SQL 世界数据模式已开启，正在加载 SQL 核心（${ATLAS_SQL_MODE_SETTING}）；加载完成后显示当前数据库视图。`,
      };
    }
    if (sqlMode.core !== "ready") {
      const message = sqlMode.message ?? atlasSqlCoreStatus().message ?? "";
      return {
        active: true, view: { items: [], metadata: {} }, reason: "unavailable", code: "SQL_CORE_UNAVAILABLE",
        note: `SQL 世界数据模式已开启，但 SQL 核心（dist/atlas-sql.mjs）不可用：${message || "未知原因"}。当前数据库视图暂不可用；请重新执行 npm run build 后刷新，或在设置里关闭该模式。`,
      };
    }
    sqlSyncViewScope(d);
    const embedded = sqlViewOf(kind, d);
    if (embedded) return sqlAcceptView(kind, d, embedded);
    if(kind==='map' && state().page!=='map')return {active:true,reason:'inactive',view:{items:[],metadata:{}},code:null,note:null};
    if (!sqlEnvelopePresent()) {
      return {
        active: true, view: { items: [], metadata: {} }, reason: "no-source", code: "SQL_VIEW_UNAVAILABLE",
        note: `SQL 世界数据模式已开启，但本聊天既没有 SQL 视图下发（/state），也没有浏览器侧 SQL 快照（chatMetadata.atlas.database）：当前视图暂不可用。`,
      };
    }
    const cached = sqlMode.views.get(sqlViewKey(kind, d, query)) ?? null;
    if (cached) return sqlAcceptView(kind, d, cached);
    if (sqlMode.viewFailed.has(sqlViewKey(kind, d, query))) {
      return {
        active: true, view: { items: [], metadata: {} }, reason: "query-failed", code: "SQL_VIEW_QUERY_FAILED",
        note: `SQL 世界数据模式：读取 ${kind} 视图失败（详见日志的 SQL_VIEW_QUERY_FAILED）；本修订内不再重试，当前视图暂不可用。`,
      };
    }
    sqlKickView(kind, d, query);
    return {
      active: true, view: { items: [], metadata: {} }, reason: "querying", code: "SQL_VIEW_LOADING",
      note: `SQL 世界数据模式：正在从 SQL 世界库读取 ${kind} 视图…（只读查询，不改任何数据）`,
    };
  }

  /** 视图可用性 + 修订校验（修订不符 → 空视图替换旧内容，绝不显示上一修订的卡片）。 */
  function sqlAcceptView(kind, d, view) {
    const currentRevision = Number(d?.revision ?? d?.sqlRevision);
    const viewRevision = Number(view?.revision);
    if (Number.isFinite(currentRevision) && Number.isFinite(viewRevision) && viewRevision !== currentRevision) {
      return {
        active: true, reason: "stale", code: "SQL_VIEW_STALE_REVISION",
        view: { ...view, items: [] },
        note: `SQL ${kind} 视图停在修订 ${String(viewRevision)}，当前修订 ${String(currentRevision)}：已按空视图替换旧内容。`,
      };
    }
    return { active: true, reason: "ok", view, code: null, note: null };
  }


 async function dispose(){
  sqlMode.enabled=false;sqlMode.viewEpoch++;
  const session=sqlMode.session;sqlMode.session=null;sqlMode.sessionKey="";
  sqlMode.views.clear();sqlMode.viewFailed.clear();
  if(session&&typeof sqlMode.module?.closeSqlSession==='function')await sqlMode.module.closeSqlSession(session);
 }
 return {dispose,sqlViewOf,sqlEnvelopePresent,sqlSnapshotScope,sqlSameSnapshot,sqlOpenSession,sqlViewKey,sqlSyncViewScope,sqlQueryView,sqlKickView,sqlWarmViews,sqlResolveView,sqlAcceptView};
}
