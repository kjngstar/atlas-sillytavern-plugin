import {atlasClockLabel,atlasLegacyNearby,buildTableMapNpcIndex,atlasMapSource,atlasMapLayerInput,atlasMapOccupants} from './ui/atlas-scene-ui-adapter.mjs';
// U15：新工作台外壳（U02）——同一宿主只挂一个实例，重复 mount 先销毁旧实例。
import { mountReferenceUi } from './ui/atlas-reference-host.mjs';
import { createReferenceLorePort } from './ui/atlas-reference-lore.mjs';
import { isValidAtlasSession, createEmptyAtlasSession, readAtlasSession, writeAtlasSession, atlasSessionWriteGuard, atlasSessionHasPersistentPayload, atlasStarterWorldWriteGuard, atlasChatIdentitySnapshot, atlasSameChatIdentity, atlasStaleWriteNotice, atlasContentHash, atlasFloorIdentity, atlasContextRecord, atlasAssistantFloorIdentity, pathWantsSession, createAtlasSessionApi, ATLAS_SESSION_KEY, ATLAS_SESSION_SCHEMA_VERSION, SESSION_ROUTE_PREFIXES } from './ui/atlas-host-context.mjs';
export { ATLAS_SESSION_KEY, ATLAS_SESSION_SCHEMA_VERSION, isValidAtlasSession, createEmptyAtlasSession, writeAtlasSession, atlasSessionHasPersistentPayload, atlasStarterWorldWriteGuard, atlasChatIdentitySnapshot, atlasSameChatIdentity, atlasStaleWriteNotice, atlasContentHash, atlasFloorIdentity, atlasAssistantFloorIdentity, createAtlasSessionApi };
import { atlasPointRefOf, atlasKnownCoordinate, atlasPositionQuality, atlasSqlMapModel, atlasSqlSubmaps, atlasSqlMapItemFor, atlasSqlFilterByViewMode, atlasSqlNearbyCards, buildSqlPromptScope } from './ui/atlas-scene-ui-adapter.mjs';
export { atlasPointRefOf, atlasKnownCoordinate, atlasPositionQuality, atlasSqlMapModel, atlasSqlSubmaps, atlasSqlMapItemFor, atlasSqlFilterByViewMode, atlasSqlNearbyCards, buildSqlPromptScope };
/* global SillyTavern */
/**
 * 阿特拉斯 / Atlas — SillyTavern UI Extension（ATLAS-04）。
 *
 * 结构纪律（上级 README 第 3.1 / 6 节）：
 * - 本文件是薄适配：SillyTavern.getContext() / eventSource / chatMetadata / extensionSettings
 *   的真实接线 + 面板 DOM；全部状态机逻辑在 ../src/atlas-ui-core.ts（harness 可完整测试）。
 * - 绑定只存当前聊天 chatMetadata 的 atlas_binding 键（契约 AtlasChatBinding 形状，无任何密钥）。
 * - 每次事件都重新调用 getContext()，绝不缓存聊天对象引用。
 * - 地图只实现查看、定位、目的地预览；确认后只填入酒馆输入框，绝不自动发送。
 * - 核心模块加载顺序：先试构建产物 ../dist/atlas-ui-core.mjs（ATLAS-07 提供 esbuild 打包），
 *   再试 ../src/atlas-ui-core.ts（浏览器不原生支持 TS——正式部署必须先构建）。
 * - 任何失败都不破坏 SillyTavern 原聊天：静默降级为控制台警告。
 */

export const ATLAS_EXTENSION_VERSION = "0.9.86";
export const ATLAS_DISPLAY_NAME = "阿特拉斯 / Atlas";
export const ATLAS_PROTOCOL_VERSION = 1;
export const ATLAS_EXTENSION_ID = "atlas-world-sim";
export const ATLAS_BINDING_KEY = "atlas_binding";
/** 0.9.48（T01）：会话写回守卫纯函数（导出供测试；sessionApi 写回前调用）。 */
export { atlasSessionWriteGuard };
/** R08：地图相机纯数学已迁至 src/atlas-map-camera.ts（dist 经 atlas-browser-entry 导出，
 *  renderPanel 从 mod 解构使用；旧 computeMapLayout 的 20px fit 下限一并删除）。 */
/**
 * C5（0.9.54）：动态比例尺条与距离格式化已统一到 src/atlas-scale.ts 唯一实现。
 * index.js 不再保留副本，renderPanel 从 mod 解构（见下方 const { computeScaleBar, … }）。
 */
export const ATLAS_SETTINGS_KEY = "atlas_world_sim";
/** 生成拦截器注入键（setExtensionPrompt 用；临时上下文，不写入可见聊天历史）。 */
export const ATLAS_INJECTION_KEY = "atlas_world_context";
const atlasSceneInjectionKeys = new Set();
/** 官方 generate_interceptor 在 globalThis 上的函数名（与 manifest.json 一致）。 */
export const ATLAS_INTERCEPTOR_GLOBAL = "atlasGenerateInterceptor";
/** 同源 Server Plugin 前缀（ST 自动挂载 /api/plugins/atlas）。 */
export const ATLAS_API_BASE = "/api/plugins/atlas";
/** 最低兼容 SillyTavern 客户端版本（manifest hooks / generate_interceptor / setExtensionPrompt / getRequestHeaders）。 */
export const ATLAS_MINIMUM_CLIENT_VERSION = "1.12.0";

// ---------------------------------------------------------------------------
// H05–H08 / H12（0.9.61）：SQL 世界数据 UI 接线的纯函数底座
//
// 纪律（计划 §10.1–§10.4 / §16.3 / §17H）：
// - **新安装默认启用；明确关闭则暂停**。开关键 = `extensionSettings.atlas_world_sim.sqlMode`
//   （= `ATLAS_SETTINGS_KEY` 下的 `ATLAS_SQL_MODE_SETTING`，与兄弟模块
//   `src/atlas-sql-session.ts` 的 `ATLAS_SQL_MODE_KEY` 同名同义；settings.html 有可见开关）。
//   关闭时本节函数一个都不跑，也绝不加载 sql.js/wasm——不再进入旧写入链。
// - **同一时刻只有一个读权威**：开启后地图 / 附近 / 日志只读 SQL 视图 DTO；视图缺失时
//   给具名诊断并清空当前视图，保留原存档。
// - **坐标诚实**（H12）：未知坐标（null / NaN / ±Infinity）一律丢弃，**绝不用 0 补位**。
// ---------------------------------------------------------------------------

/** SQL 世界数据开关键：写在 extensionSettings[ATLAS_SETTINGS_KEY] 下的布尔（缺省 false）。
 * 与 `src/atlas-sql-session.ts::ATLAS_SQL_MODE_KEY`（'sqlMode'）同名同义——
 * 一个开关只有一把钥匙，避免 UI 与引擎各认一个键。 */
export const ATLAS_SQL_MODE_SETTING = "sqlMode";

/** 视图 kind → `/state` 扁平载荷键（H04 服务端只读适配的下发口径；也接受 `sqlViews.<kind>`）。 */
export const ATLAS_SQL_VIEW_KEYS = {
  map: "sqlMap",
  nearby: "sqlNearby",
  changes: "sqlChanges",
  diagnostics: "sqlDiagnostics",
};

/** H08：日志分页之外的**完整导出**路径（分页只影响列表，绝不截断导出）。 */
export const ATLAS_SQL_DIAGNOSTICS_EXPORT_ROUTE = "/sql/diagnostics/export";

/**
 * SQL 核心产物候选路径（与 loadUiCore 同形）：发布形态只有组件内 `./dist/atlas-sql.mjs`；
 * 工程内开发形态允许回退 `../src/atlas-sql-browser-entry.ts`。
 * tools/pack.mjs 的 stripDevFallback 会把两元素形态收敛成发布形态（只留 ./dist/）。
 */
export const ATLAS_SQL_CORE_CANDIDATES = ["./dist/atlas-sql.mjs", "../src/atlas-sql-browser-entry.ts"];

/** H05：候选 token（messageUID + variantKey + contentHash 派生；同变体必然同 token）。 */
export function atlasSqlPrepareToken(identity) {
  const uid = String(identity?.messageUID ?? "");
  const variant = String(identity?.variantKey ?? "");
  const hash = String(identity?.contentHash ?? "");
  return `sql:${uid}#${variant}@${hash}`;
}

/**
 * H05：SQL 候选回合的 pending 状态机（纯函数，可测）。
 *
 * - `prepare`：登记候选。同一变体重复 prepare = 复用在途候选（`reused`）；
 *   换变体（重新生成 / 换楼层 / 改正文）→ 旧候选立即 `superseded`（由调用方丢弃快照），
 *   新候选用**新 token** 起步——绝不把上一轮的 pending 状态留给下一轮。
 * - `stop`：用户停止生成 → 丢弃候选（`cancelled`）；本来没有候选就是 `noop`
 *   （不报错、不留半截状态——这是「截断 → 重新生成能恢复」的关键）。
 * - `settle`：候选出结果（成功 / 失败都算）。只有 token 仍是当前候选才采纳（`settled`）；
 *   迟到的旧 token 一律 `stale-dropped`，状态机**不会因为过期 token 永久卡住**。
 */
export function atlasSqlPrepareStep(state, action) {
  const current = state && typeof state === "object" ? state : {};
  const pending = current.pending ?? null;
  const cancelled = Array.isArray(current.cancelled) ? current.cancelled : [];
  const settled = Array.isArray(current.settled) ? current.settled : [];
  const type = String(action?.type ?? "");
  if (type === "prepare") {
    const identity = action?.identity && typeof action.identity === "object" ? action.identity : {};
    const token = atlasSqlPrepareToken(identity);
    if (pending && pending.token === token) {
      return { pending, cancelled, settled, status: "reused", token, supersededToken: null };
    }
    return {
      pending: { token, identity, startedAt: atlasKnownCoordinate(action?.at) },
      cancelled: pending ? [...cancelled, pending.token].slice(-16) : cancelled,
      settled,
      status: pending ? "superseded" : "prepared",
      token,
      supersededToken: pending ? pending.token : null,
    };
  }
  if (type === "stop") {
    if (!pending) return { pending: null, cancelled, settled, status: "noop", token: null, supersededToken: null };
    return {
      pending: null,
      cancelled: [...cancelled, pending.token].slice(-16),
      settled,
      status: "cancelled",
      token: pending.token,
      supersededToken: null,
    };
  }
  if (type === "settle") {
    const token = String(action?.token ?? "");
    if (!pending || pending.token !== token) {
      return { pending, cancelled, settled, status: "stale-dropped", token, supersededToken: null };
    }
    return {
      pending: null,
      cancelled,
      settled: [...settled, token].slice(-16),
      status: "settled",
      token,
      supersededToken: null,
    };
  }
  return { pending, cancelled, settled, status: "ignored", token: null, supersededToken: null };
}

/**
 * H05：pending 控制器（emitter 与 SQL 端口共用）。
 *
 * **SQL 模式关闭时没有端口 → 所有动作都是空操作**（不读聊天、不写诊断、零副作用）。
 * `discardPrepared` 走会话桥（`src/atlas-sql-session.ts`）丢弃候选快照；桥缺席时只记一条
 * 具名诊断，绝不假装丢弃成功、也绝不自己实现第二套桥。
 */
export function createSqlPrepareQueue(io = {}) {
  const emit = typeof io.onDiagnostic === "function" ? io.onDiagnostic : () => {};
  let state = { pending: null, cancelled: [], settled: [] };
  let port = null;
  const adopt = (result) => {
    state = { pending: result.pending ?? null, cancelled: result.cancelled ?? [], settled: result.settled ?? [] };
    return result;
  };
  const discard = async (token, reasonCode) => {
    if (!token || !port || typeof port.discardPrepared !== "function") return false;
    try {
      await port.discardPrepared(token, reasonCode);
      return true;
    } catch (error) {
      emit({
        level: "warn", source: "storage", code: "SQL_PREPARE_DISCARD_FAILED",
        operation: "sql-prepare", phase: "discard", outcome: "failed",
        errorCode: String(reasonCode ?? ""),
        details: { message: error instanceof Error ? error.message : String(error) },
      });
      return false;
    }
  };
  return {
    /** 注册 / 注销 SQL 端口（模式关闭时必须注销，绝不能留下悬挂端口）。 */
    setPort(next) { port = next ?? null; },
    hasPort() { return Boolean(port); },
    snapshot() {
      return {
        pending: state.pending
          ? { token: state.pending.token, identity: { ...state.pending.identity }, startedAt: state.pending.startedAt ?? null }
          : null,
        cancelled: [...state.cancelled],
        settled: [...state.settled],
      };
    },
    async prepare(identity) {
      if (!port) return { status: "no-port", token: null };
      const step = adopt(atlasSqlPrepareStep(state, { type: "prepare", identity, at: Date.now() }));
      if (step.supersededToken) await discard(step.supersededToken, "SQL_PREPARE_SUPERSEDED");
      if (step.status === "reused") return { status: "reused", token: step.token };
      emit({
        level: "info", source: "storage", code: "SQL_PREPARE_STARTED",
        operation: "sql-prepare", phase: "prepare", outcome: "started",
        details: { variantKey: String(identity?.variantKey ?? ""), messageUID: String(identity?.messageUID ?? "") },
      });
      const token = step.token;
      let outcome = null;
      try {
        outcome = await port.prepareTurn(identity, token);
      } catch (error) {
        outcome = { error: error instanceof Error ? error.message : String(error) };
      }
      const settled = adopt(atlasSqlPrepareStep(state, { type: "settle", token }));
      if (settled.status === "stale-dropped") {
        await discard(token, "SQL_PREPARE_STALE");
        emit({
          level: "info", source: "storage", code: "SQL_PREPARE_STALE_DROPPED",
          operation: "sql-prepare", phase: "settle", outcome: "skipped",
          details: { token },
        });
        return { status: "stale-dropped", token };
      }
      return { status: "settled", token, outcome };
    },
    /** 停止生成 / 删楼 / 重新生成：取消当前候选（本来没有候选 = noop，绝不报错、绝不粘住）。 */
    async cancel(reasonCode) {
      if (!port) return { status: "no-port" };
      const step = adopt(atlasSqlPrepareStep(state, { type: "stop" }));
      if (step.status !== "cancelled") return { status: step.status, token: step.token };
      await discard(step.token, reasonCode ?? "SQL_PREPARE_CANCELLED");
      emit({
        level: "info", source: "storage", code: "SQL_PREPARE_CANCELLED",
        operation: "sql-prepare", phase: "cancel", outcome: "cancelled",
        details: { reasonCode: String(reasonCode ?? "SQL_PREPARE_CANCELLED") },
      });
      return { status: "cancelled", token: step.token };
    },
  };
}

let atlasSqlPrepareQueueSingleton = null;

/** 模块级唯一 pending 控制器（emitter 早于 renderPanel 创建，故不能挂在面板作用域）。 */
export function atlasSqlPrepareQueue() {
  if (!atlasSqlPrepareQueueSingleton) {
    atlasSqlPrepareQueueSingleton = createSqlPrepareQueue({ onDiagnostic: emitAtlasDiagnostic });
  }
  return atlasSqlPrepareQueueSingleton;
}

/**
 * H05：宿主事件 → SQL 候选生命周期（事件归一入口；与 `createEventAdapter` 同源）。
 *
 * - `GENERATION_STOPPED`（用户停止生成）/ `MESSAGE_DELETED`（删楼截断）→ 取消候选；
 * - `MESSAGE_SWIPED` / `MESSAGE_EDITED` → 旧变体作废 + 按**新 variantKey** 起新候选；
 * - `MESSAGE_RECEIVED` / `GENERATION_ENDED*` → 按当前楼层起候选（同变体自动复用）。
 *
 * 端口未注册（= SQL 模式关闭）时立刻返回：连聊天都不读，零成本。
 */
export function atlasSqlNoteHostEvent(event, payload, context) {
  const queue = atlasSqlPrepareQueue();
  if (!queue.hasPort()) return { status: "no-port" };
  const name = String(event ?? "");
  if (name === "GENERATION_STOPPED" || name === "MESSAGE_DELETED") {
    void queue.cancel(name);
    return { status: "cancelled", reasonCode: name };
  }
  if (["MESSAGE_RECEIVED", "GENERATION_ENDED", "GENERATION_ENDED_AFTER_COMMANDS", "MESSAGE_SWIPED", "MESSAGE_EDITED"].includes(name)) {
    const identity = atlasAssistantFloorIdentity(context, payload, name);
    if (!identity) return { status: "no-floor" };
    const regenerated = name === "MESSAGE_SWIPED" || name === "MESSAGE_EDITED";
    if (regenerated) void queue.cancel(name);
    void queue.prepare(identity);
    return { status: regenerated ? "reprepare" : "prepare", variantKey: identity.variantKey };
  }
  return { status: "ignored" };
}

// ---------------------------------------------------------------------------
// B01：存量迁移（一次性）——按 chatId 分桶的在途表 + 身份核验
// ---------------------------------------------------------------------------

/**
 * 旧版把世界文档散在 extensionSettings 浏览器 KV（或 server data/）且绑定挂在
 * `chatMetadata.atlas_binding` —— 全部折叠进 `chatMetadata.atlas` 单文档。
 * 迁移成功后只清理**本聊天自己的**旧回合文档；世界级旧档按 worldId 共享，
 * 一律保留给其他聊天继续迁移（详见迁移体末尾的说明）。
 *
 * B01（0.9.59 聊天隔离）修的是**跨聊天单例**：0.9.58 用一个模块级
 * `sessionMigrationInFlight` 记住在途迁移，A 聊天迁移到一半切到 B 时，
 * A 的异步续体会把 A 的世界写进 B 的 chatMetadata，还会顺手删掉 A 的旧 KV 与
 * 服务端旧档。现在：
 * - 在途表改成 `Map<chatId, Promise>` —— 每个聊天各自一条，互不阻塞、互不复用；
 * - 开工时抓 `{ chatId, metadata }` 身份快照（`atlasChatIdentitySnapshot`）；
 * - **每个 await 返回后 / `writeAtlasSession` 前 / 移除旧 KV 前**都用
 *   `atlasSameChatIdentity` 核验「此刻的上下文仍是同一身份」；
 * - 身份不符 → 立即收手：**保留旧数据**、记 `STALE_MIGRATION_DROPPED`
 *   （errorCode / reasonCode = A04 的 `SESSION_IDENTITY_MISMATCH`），
 *   绝不调用 `saveMetadata`，绝不删任何旧档 —— 切回来的 A 下次事件再迁。
 * 任何失败都静默降级：旧数据原样保留，下次再试。
 */
const sessionMigrationsInFlight = new Map();

/** B01：某聊天是否有在途迁移（诊断 / 测试用；不暴露 Promise 内容）。 */
export function atlasSessionMigrationInFlight(chatId) {
  return sessionMigrationsInFlight.has(chatId === null || chatId === undefined ? "" : String(chatId));
}

/**
 * @param {() => object} context 酒馆上下文读取器（每次都重新取，绝不缓存聊天对象）
 * @param {{ store?: object|null, api?: object|null, emit?: (event: object) => void }} [deps]
 *   测试注入的旧档来源与诊断出口；缺省用 `atlasRuntime.engineStore` / `atlasRuntime.api`
 *   与模块自身的 `emitAtlasDiagnostic`（与生产一致）
 */
export function migrateChatSession(context, deps = {}) {
  const capture = atlasChatIdentitySnapshot(context);
  const metadata = capture.metadata;
  if (!metadata) return Promise.resolve();
  if (isValidAtlasSession(metadata[ATLAS_SESSION_KEY])) return Promise.resolve();
  const legacyBinding = metadata[ATLAS_BINDING_KEY];
  if (!legacyBinding) return Promise.resolve(); // 没有旧绑定 = 新聊天，会话由首次写入创建
  if (!capture.chatId) return Promise.resolve(); // 身份不可核验 → 绝不盲写（B01）
  const key = capture.chatId;
  const inFlight = sessionMigrationsInFlight.get(key);
  if (inFlight) return inFlight;
  const emit = typeof deps.emit === "function" ? deps.emit : emitAtlasDiagnostic;

  const staleNow = (stage) => {
    emit({
      level: "warn", source: "storage", code: "STALE_MIGRATION_DROPPED",
      operation: "session", phase: "migrate", outcome: "skipped",
      errorCode: "SESSION_IDENTITY_MISMATCH",
      details: { stage, reasonCode: "SESSION_IDENTITY_MISMATCH" },
    });
    return { migrated: false, stale: true, code: "STALE_MIGRATION_DROPPED", stage, chatId: key };
  };

  // 门闸：保证「先登记在途 Promise，再跑迁移体」——否则同步跑完的迁移体会在
  // finally 里删掉尚未登记的键，把一条已完成的 Promise 永久留在表里。
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const task = (async () => {
    await gate;
    try {
      const worldId = String(legacyBinding?.worldId ?? "");
      const legacyChatId = String(legacyBinding?.chatId ?? key ?? "");
      const store = deps.store ?? atlasRuntime.engineStore ?? null;
      const api = deps.api ?? atlasRuntime.api ?? null;
      const session = createEmptyAtlasSession();
      session.binding = legacyBinding;
      const stillCurrent = () => atlasSameChatIdentity(capture, atlasChatIdentitySnapshot(context));

      if (store && worldId) {
        for (const [field, docKey] of [["world", `world:${worldId}`], ["maps", `maps:${worldId}`], ["scene", `scene:${worldId}`]]) {
          const value = (await store.read(docKey)) ?? null;
          if (!stillCurrent()) return staleNow(`after-${field}-read`);
          session[field] = value;
        }
        const geo = await store.read(`geo-auto:${worldId}`);
        if (!stillCurrent()) return staleNow("after-geo-read");
        if (geo) session.geoAuto[worldId] = geo;
      }
      if (store && legacyChatId) {
        const turnPrefix = `turn:${legacyChatId}:`;
        const turnKeys = await store.list(turnPrefix);
        if (!stillCurrent()) return staleNow("after-turn-list");
        for (const turnKey of turnKeys ?? []) {
          // 归属核验：宿主若把别的聊天的键也列进来，本聊天一条都不收（B01 的"B 无 A 表行"）
          if (!String(turnKey).startsWith(turnPrefix)) continue;
          const turn = (await store.read(turnKey)) ?? null;
          if (!stillCurrent()) return staleNow("after-turn-read");
          session.turns[turnKey] = turn;
        }
      }
      // 服务端（HTTP 模式）兜底：浏览器 KV 里没有就问 server 要
      if (!session.world && api && worldId) {
        try {
          const result = await api.request("POST", "/session/export", { chatId: legacyChatId, worldId });
          if (!stillCurrent()) return staleNow("after-server-export");
          const exported = result?.body?.data?.session;
          if (exported && exported.schemaVersion === ATLAS_SESSION_SCHEMA_VERSION) {
            session.world = exported.world ?? null;
            session.maps = exported.maps ?? null;
            session.scene = exported.scene ?? null;
            session.turns = exported.turns ?? {};
            session.geoAuto = exported.geoAuto ?? {};
          }
        } catch { /* server 也没有 → 按空世界迁，绑定保住让 UI 引导重建 */ }
      }
      // B01：落盘前两道核验 —— writeAtlasSession 之前，以及存档（await）返回之后
      if (!stillCurrent()) return staleNow("before-write");
      delete metadata[ATLAS_BINDING_KEY];
      // C07b：迁移是异步路径，落盘时身份必须仍是这次迁移的聊天
      await writeAtlasSession(context, session, legacyChatId);
      if (!stillCurrent()) return staleNow("after-save");
      // 迁移成功 → 清理旧档。B01：**每一步之前都核验身份**。
      //
      // 只清**聊天自己的**回合文档（键含 chatId，归属无歧义）。世界级旧档
      // （`world:` / `maps:` / `scene:` / `geo-auto:` 的键是 **worldId 作用域**，
      // 同一张角色卡的多个聊天共用同一份）**一律保留**：A 聊天迁移完就把它们删掉，
      // 等于让还没迁移的 B 永久失去自己的旧世界 —— 这是"用删用户数据冒充隔离"，
      // 正是本阶段明令禁止的做法。旧档留着，其他聊天各自迁移时仍是它们的来源。
      // 同理不调用 `/session/purge`（服务端按 worldId 删 world/maps/scene/geo 与绑定，
      // 会连带清掉别的聊天还没迁的数据）。
      if (store && legacyChatId) {
        try {
          const turnPrefix = `turn:${legacyChatId}:`;
          if (!stillCurrent()) return staleNow("before-turn-remove");
          const turnKeys = await store.list(turnPrefix);
          if (!stillCurrent()) return staleNow("before-turn-remove");
          for (const turnKey of turnKeys ?? []) {
            // 只删本聊天自己的回合文档：别的聊天的键绝不代删（隔离不等于清空用户存档）
            if (!String(turnKey).startsWith(turnPrefix)) continue;
            await store.remove(turnKey);
            if (!stillCurrent()) return staleNow("after-turn-remove");
          }
        } catch { /* 清理失败不影响会话 */ }
      }
      return { migrated: true, chatId: key, worldId };
    } catch {
      return { migrated: false, failed: true, chatId: key };
    } finally {
      if (sessionMigrationsInFlight.get(key) === task) sessionMigrationsInFlight.delete(key);
    }
  })();
  sessionMigrationsInFlight.set(key, task);
  releaseGate();
  return task;
}

// ---------------------------------------------------------------------------
// B03：地图作用域身份（纯函数）——聊天 / 世界 / 分支三者共同构成一张图的作用域
// ---------------------------------------------------------------------------

/**
 * B03 纯函数：当前地图作用域身份 `{ chatId, worldId, branchKey }`。
 *
 * 0.9.58 的地图视图键只有 `chatId|worldId`：同一聊天的**不同分支**（IF 与正史）
 * 共用一套子图视图栈、相机与底图缓存 —— 切分支看到的是上一分支的视角与底图。
 * 分支键优先取服务端 `/state` 下发的 `tableMap.branchKey`（三表真实分支键）；
 * 旧响应没有 tableMap 时退回 `branchId`（IF 分支 id 本身也是有效判别式），
 * 都没有才按 `canon`。绝不猜一个不存在的分支。
 */
export function atlasMapIdentityOf(stateData, chatIdOverride) {
  const d = stateData && typeof stateData === "object" ? stateData : {};
  const tableMap = d.tableMap && typeof d.tableMap === "object" ? d.tableMap : null;
  const rawBranch = tableMap?.branchKey ?? d.branchKey ?? d.branchId ?? null;
  const branchText = rawBranch === null || rawBranch === undefined ? "" : String(rawBranch).trim();
  const rawChat = chatIdOverride === undefined || chatIdOverride === null ? d.chatId : chatIdOverride;
  return {
    chatId: rawChat === null || rawChat === undefined ? "" : String(rawChat),
    worldId: d.worldId === null || d.worldId === undefined ? "" : String(d.worldId),
    branchKey: branchText || "canon",
  };
}

/** B03：作用域键 `chatId|worldId|branchKey`（地图视图栈 / 相机缓存 / 底图缓存的唯一键前缀）。 */
export function atlasMapScopeKey(identity) {
  const value = identity && typeof identity === "object" ? identity : {};
  const branch = String(value.branchKey ?? "").trim() || "canon";
  return `${String(value.chatId ?? "")}|${String(value.worldId ?? "")}|${branch}`;
}

/** B03：底图缓存键 `chatId|worldId|branchKey|mapImageRevision`（版本变了也不复用旧图）。 */
export function atlasMapImageCacheKey(identity, imageRevision) {
  return `${atlasMapScopeKey(identity)}|${String(imageRevision ?? 0)}`;
}

/** B03 纯函数：两次地图身份是否完全相同（底图回调重绘前必须先过这一关）。 */
export function atlasSameMapIdentity(captured, current) {
  if (!captured || !current) return false;
  return atlasMapScopeKey(captured) === atlasMapScopeKey(current);
}

// ---------------------------------------------------------------------------
// A03 / F8：诊断夹具的判定逻辑（纯函数）——「附近为空」不等于「跨聊天串档」
// ---------------------------------------------------------------------------

/**
 * A03（F8）纯函数：把「附近页为空，但某个地点里有人」拆成三种互斥情形。
 *
 * F8 的教训：截图里「附近为空、蒸汽车厢有两人」**单独不足以**证明串档——
 * 必须能区分下面三种，再决定是不是要动数据（绝不因为一次空页面就删用户存档）：
 * - `current-location-unknown`：绑定里没有当前位置 → 根本没算过附近，不是"没人"；
 * - `same-location-has-people`：当前位置已知且**该地点确实有人**，只是本轮
 *   `relevantNpcIds` 为空（引擎相关性判定没给）→ 数据一致，不是跨聊天；
 * - `no-confirmed-people`：当前位置已知、该地点也没人 → 如实"暂无已确认人物"。
 *
 * 输入只读 /state 与三表投影的**结构字段**（地点 id、在场人物 id/位置），不含任何正文。
 */
export function atlasDiagnoseEmptyNearby(input) {
  const record = input && typeof input === "object" ? input : {};
  const currentLocationId = record.currentLocationId === null || record.currentLocationId === undefined
    ? "" : String(record.currentLocationId).trim();
  /**
   * F05（0.9.59）：优先信服务端给出的**具名原因**（F02 的 `nearReasonCode`）。
   *
   * 它是权威口径：`CURRENT_LOCATION_UNKNOWN` 表示「还不知道自己在哪」，
   * 与「周围确实没人」是两件事（§2.4 / T09）。下面的启发式只在旧版 /state
   * 不带该字段时兜底，行为与 0.9.58 一致。
   */
  const nearReasonCode = typeof record.nearReasonCode === "string" ? record.nearReasonCode : "";
  if (nearReasonCode === "CURRENT_LOCATION_UNKNOWN") {
    return {
      case: "current-location-unknown",
      persons: 0,
      message: "尚未确定当前位置：当前回合未推断出主角所在地点，无法计算附近。可查看下方的已记录人物；若推演位置有误，可在地点详情中手动纠偏。",
    };
  }
  if (!currentLocationId) {
    return {
      case: "current-location-unknown",
      persons: 0,
      message: "尚未确定当前位置：当前回合未推断出主角所在地点，无法计算附近。可查看下方的已记录人物；若推演位置有误，可在地点详情中手动纠偏。",
    };
  }
  const wanted = currentLocationId.startsWith("loc:") ? currentLocationId : `loc:${currentLocationId}`;
  const entries = Array.isArray(record.tableNearbyEntries) ? record.tableNearbyEntries : [];
  const persons = entries.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const locationId = String(entry.locationId ?? "");
    if (locationId !== wanted) return false;
    if (entry.presence === "left") return false;
    if (entry.isProtagonist === true) return false;
    return true;
  });
  if (persons.length > 0) {
    return {
      case: "same-location-has-people",
      persons: persons.length,
      message: "本轮没有判定的附近人物；当前地点已确认在场者，可在「地点」弹窗或地图名单里查看。",
    };
  }
  return { case: "no-confirmed-people", persons: 0, message: "附近暂无已确认人物。" };
}

// ---------------------------------------------------------------------------
// B04：世界书聊天世代号（chatEpoch）+ 切聊天写入器
// ---------------------------------------------------------------------------

/** B04 纯逻辑：递增聊天世代号。每次开始新的异步写入都 `begin`，写回前用 `isCurrent` 复核。 */
export function createChatEpochTracker() {
  let epoch = 0;
  let chatId = "";
  return {
    begin(nextChatId) {
      epoch += 1;
      chatId = nextChatId === null || nextChatId === undefined ? "" : String(nextChatId);
      return { epoch, chatId };
    },
    isCurrent(token) {
      return Boolean(token) && token.epoch === epoch && token.chatId === chatId;
    },
    snapshot() {
      return { epoch, chatId };
    },
  };
}

/**
 * B04 / F10 纯函数：按 lib/world-schema 的 `branchScopeForStory` 同口径取分支键
 * （IF 分支 = 该 IF 故事 id；正史 = null）。找不到故事按正史处理，绝不猜。
 */
export function atlasBranchScopeForStory(world, storyId) {
  const raw = storyId === null || storyId === undefined ? "" : String(storyId).trim();
  if (!raw) return null;
  const stories = Array.isArray(world?.stories) ? world.stories : [];
  const story = stories.find((item) => String(item?.id ?? "") === raw);
  if (!story) return null;
  return String(story.mode ?? "") === "if" ? raw : null;
}

/**
 * B04 / F10 纯函数：从会话三表文档里取**当前分支**的切片。
 * 只读已存在的分支键（当前分支 → canon → 唯一键兜底），绝不新建、绝不跨分支借数据。
 */
export function atlasBranchSliceOf(world, tablesDoc, branchId) {
  const doc = tablesDoc && typeof tablesDoc === "object" ? tablesDoc : null;
  const branches = doc && doc.branches && typeof doc.branches === "object" ? doc.branches : null;
  if (!branches) return null;
  const scope = atlasBranchScopeForStory(world, branchId);
  const candidates = scope ? [scope, "canon"] : ["canon"];
  for (const key of candidates) {
    const slice = branches[key];
    if (slice && typeof slice === "object") return { branchKey: key, tables: slice };
  }
  const keys = Object.keys(branches);
  if (keys.length === 1) {
    const slice = branches[keys[0]];
    if (slice && typeof slice === "object") return { branchKey: keys[0], tables: slice };
  }
  return null;
}

/**
 * B04（聊天隔离）世界书聊天切换处理器。
 *
 * 0.9.58 的实现在切聊天时**无条件**继续跑旧聊天的异步写入：读绑定 / 读世界 / 写书
 * 三步之间用户切走，旧三表上下文（F10：`buildLorebookPlans` 没拿到当前分支三表）
 * 就会写进随卡激活的共享主卡书。现在：
 * 1. 进入时 `begin(chatId)` 生成**递增 chatEpoch**，并捕获当时的聊天身份；
 * 2. 三个核验点：**开始**（拿到 chatId 后）、**加载书后**（绑定 + 世界读完）、
 *    **保存前**（`syncTurn` 真正落书之前）——任一处 epoch/身份不符即收手，
 *    记 `LOREBOOK_STALE_CHAT_DROPPED`，绝不把别的聊天的动向写进书；
 * 3. **写入串行化**：一次切换的落书可能已经在途（`syncTurn` 已开始），epoch 核验挡不住它。
 *    因此世代号在**调用当时**就递增（旧写入立即作废），而实际读/写排成一条串行链——
 *    迟到的旧写入排在前面，当前聊天的写入永远最后落书，书里不会留下旧聊天的动向；
 * 4. 切到未绑定聊天只调 `purgeAll()`：它**只删 comment 带 Atlas 前缀的自建条目**，
 *    用户自己的世界书条目（书名 / 内容 / 启停）一概不动；
 * 5. 任何失败都只记事件并返回结构化结果，**绝不抛出**（不影响回合）。
 */
export function createLorebookChatSwitchHandler(deps) {
  const tracker = deps.tracker ?? createChatEpochTracker();
  const emit = typeof deps.emit === "function" ? deps.emit : () => {};
  const readSession = typeof deps.readSession === "function" ? deps.readSession : () => null;
  const buildPlans = typeof deps.buildPlans === "function" ? deps.buildPlans : null;
  /** 串行链：上一次切换的读/写全部落定后，下一次才开始（保证最后落书的是当前聊天）。 */
  let writeChain = Promise.resolve();
  const runOnce = async function onLorebookChatSwitch(info, token) {
    const dropped = (stage) => {
      emit({
        level: "warn", source: "lorebook", code: "LOREBOOK_STALE_CHAT_DROPPED",
        operation: "lorebook", phase: "chat-switch", outcome: "skipped",
        errorCode: "SESSION_IDENTITY_MISMATCH",
        details: { stage, reasonCode: "SESSION_IDENTITY_MISMATCH" },
      });
      return { dropped: true, code: "LOREBOOK_STALE_CHAT_DROPPED", stage, chatId: token.chatId };
    };
    try {
      if (!info.bound) {
        // 未绑定聊天：只清 Atlas 自建条目（purgeAll 的语义在 src/atlas-lorebook.ts 里，
        // 按 comment 前缀删除；用户自己的世界书条目恒不匹配，永不被删）
        const purged = await deps.writer.purgeAll();
        if (!tracker.isCurrent(token)) return dropped("after-purge");
        await deps.store.write("lorebook", null);
        if (typeof deps.rerender === "function") deps.rerender();
        return { purged: true, bookName: purged?.bookName ?? null, pruned: purged?.pruned ?? 0 };
      }
      // 核验点 1：开始（拿到绑定之前先确认还是同一次切换）
      if (!tracker.isCurrent(token)) return dropped("before-binding");
      const binding = await deps.readBinding();
      const worldId = String(binding?.worldId ?? "");
      if (!worldId) return { skipped: true };
      const world = await deps.store.read(`world:${worldId}`);
      // 核验点 2：加载书（绑定 + 世界）之后
      if (!tracker.isCurrent(token)) return dropped("after-load");
      if (!world) return { skipped: true };
      if (!buildPlans) return { skipped: true };
      const session = readSession() ?? null;
      const branchId = binding?.branchId ?? null;
      const slice = atlasBranchSliceOf(world, session?.tables ?? null, branchId);
      /**
       * D10（0.9.59）：重建时把**当前分支的推演上下文**一起交给 buildLorebookPlans。
       *
       * 为什么必须传：三表人物位置与想法会变，而旧 `world.stateEvents` 在行增量回合里
       * 根本不新增——只传三表的话，书里的「近期动向」会长期停在旧事件上，
       * 甚至把**别的分支**的幕后内容读进来（A→B→A 串档）。
       *
       * 事件来源与 `/state` 完全同源：**本会话、本分支**的回合记录里的 `simulationEvents`；
       * `rolledBack === true` 的回合按 C10 不再可见（文档保留可审计，但不进注入）。
       * `authorOmniscient` 恒为 false——作者界面能看秘密，不代表主聊天注入可以带秘密。
       */
      const simulationDelta = (() => {
        if (!slice) return null;
        const turns = session?.turns && typeof session.turns === "object" ? Object.values(session.turns) : [];
        const events = [];
        for (const turn of turns) {
          if (!turn || typeof turn !== "object") continue;
          if (turn.branchId !== branchId) continue;
          if (turn.rolledBack === true) continue;
          for (const item of Array.isArray(turn.simulationEvents) ? turn.simulationEvents : []) {
            if (item && typeof item === "object") events.push(item);
          }
        }
        const branchRows = session?.simulation?.branches?.[slice.branchKey] ?? null;
        return {
          branchKey: slice.branchKey,
          events,
          deliveries: Array.isArray(branchRows?.deliveries) ? branchRows.deliveries : [],
          signals: Array.isArray(branchRows?.signals) ? branchRows.signals : [],
          protagonistCharacterId: binding?.characterId ? `npc:${String(binding.characterId).replace(/^npc:/, "")}` : null,
          protagonistLocationIds: binding?.currentLocationId ? [String(binding.currentLocationId)] : [],
          authorOmniscient: false,
        };
      })();
      // F10：把**当前分支**的三表一起交给 buildLorebookPlans（缺表时保持旧行为）
      const plans = buildPlans(world, {
        status: "committed",
        currentTime: Number(binding?.worldTimeCursor ?? 0),
        currentLocationId: binding?.currentLocationId ?? null,
      }, slice ? { tables: slice.tables, branchKey: slice.branchKey, currentLocationId: binding?.currentLocationId ?? null } : null,
        simulationDelta);
      if (!plans) return { skipped: true };
      // 核验点 3：保存前
      if (!tracker.isCurrent(token)) return dropped("before-save");
      const result = await deps.writer.syncTurn(plans, { chatId: token.chatId, worldId });
      if (!tracker.isCurrent(token)) return dropped("after-save");
      await deps.store.write("lorebook", deps.writer.snapshot(plans, result));
      if (typeof deps.rerender === "function") deps.rerender();
      return result;
    } catch (error) {
      // 失败不影响回合，只记录事件（绝不抛出）
      emit({
        level: "warn", source: "lorebook", code: "LOREBOOK_SWITCH_SYNC_FAILED",
        operation: "lorebook", phase: "chat-switch", outcome: "failed", retryable: true,
      });
      return { failed: true, chatId: token.chatId, message: error instanceof Error ? error.message : String(error) };
    }
  };
  return function onLorebookChatSwitch(info = {}) {
    const chatId = info.chatId === null || info.chatId === undefined
      ? (typeof deps.readChatId === "function" ? deps.readChatId() : null)
      : info.chatId;
    // 世代号在**调用当时**递增：切走的那一刻，旧写入立即作废（不必等在途写入排到队首）
    const token = tracker.begin(chatId);
    const queued = writeChain.then(() => runOnce(info, token), () => runOnce(info, token));
    writeChain = queued.then(() => {}, () => {});
    return queued;
  };
}

/**
 * B02b 用户提示：切聊天丢弃回执时的可见一次性提示。
 * 内联样式（index.js 不新增 style.css 规则）；任何失败都静默，绝不影响回合。
 */
function showAtlasNotice(text) {
  try {
    if (typeof document === "undefined" || !document.body || typeof text !== "string" || !text) return;
    const node = document.createElement("div");
    node.className = "atlas-notice";
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    node.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483000;max-width:340px;"
      + "padding:10px 12px;border-radius:8px;background:rgba(24,28,36,.94);color:#f2f0ea;"
      + "font-size:13px;line-height:1.5;box-shadow:0 6px 20px rgba(0,0,0,.35)";
    node.textContent = text;
    document.body.append(node);
    setTimeout(() => node.remove(), 9000);
  } catch { /* 提示失败绝不影响回合 */ }
}

/** 创建扩展身份实例（保持 ATLAS-00 兼容：harness 校验身份与生命周期占位）。 */
export function createAtlasExtension() {
  return {
    version: ATLAS_EXTENSION_VERSION,
    displayName: ATLAS_DISPLAY_NAME,
    protocolVersion: ATLAS_PROTOCOL_VERSION,
    mounted: false,
    mount() {
      this.mounted = true;
    },
    unmount() {
      this.mounted = false;
    },
  };
}

// ---------------------------------------------------------------------------
// 真实 SillyTavern 接线（只在浏览器中执行；Node harness 导入本文件不会触发）
// ---------------------------------------------------------------------------

let connected = null;
/** 在途连接 Promise：模块自初始化与 hooks.activate 并发触发时共享同一次挂载。 */
let connecting = null;

// ---------------------------------------------------------------------------
// 安全诊断：仅白名单元信息进入本页、复制和导出。
const pendingDiagnostics = [];
let atlasDiagnostics = null;
const chatRefs = new Map();

function currentChatRef() {
  try {
    const chatId = SillyTavern.getContext()?.chatId;
    if (typeof chatId !== "string" || !chatId) return undefined;
    if (!chatRefs.has(chatId)) chatRefs.set(chatId, "chat-" + Math.random().toString(36).slice(2, 10));
    return chatRefs.get(chatId);
  } catch { return undefined; }
}

function emitAtlasDiagnostic(event) {
  const entry = { ...event, ...(event.chatRef ? {} : { chatRef: currentChatRef() }) };
  if (atlasDiagnostics) return atlasDiagnostics.emit(entry);
  pendingDiagnostics.push(entry);
  if (pendingDiagnostics.length > 100) pendingDiagnostics.shift();
  return null;
}

/** 供宿主验收读取已脱敏的运行诊断；不返回聊天正文或世界书内容。 */
export function getAtlasSafeDiagnosticsSnapshot() {
  return atlasDiagnostics?.getSnapshot() ?? [...pendingDiagnostics];
}

/** 世界书开关以引擎当前设置为准；读取失败时沿用可选资料的默认开启语义。 */
export async function isAtlasLoreSupplementEnabled(api) {
  try {
    const result = await api.request("GET", "/settings");
    return !(result?.status === 200 && result?.body?.ok === true
      && result?.body?.data?.loreSupplementEnabled === false);
  } catch { return true; }
}

async function loadUiCore() {
  // 先组件内构建产物（发布形态），再上级 src（开发形态，工程内运行才可用）
  const attempts = ["./dist/atlas-ui-core.mjs"];
  let lastError = null;
  for (const specifier of attempts) {
    try {
      const mod = await import(new URL(specifier, import.meta.url).href);
      if (typeof mod.createAtlasUiCore !== "function") throw new Error("缺少 createAtlasUiCore 导出");
      return mod;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Atlas UI 核心模块加载失败：${lastError?.message ?? "未知原因"}。安装包应自带 dist/atlas-ui-core.mjs；开发环境请先执行 npm run build。`);
}

/** SQL 核心加载状态（`idle` = 从未尝试 → 模式关闭时永远是 idle）。 */
let sqlCoreState = { status: "idle", code: null, message: null };
/** settings.html 里的可见开关 id（与 ATLAS_SQL_MODE_SETTING 一一对应）。 */
export const ATLAS_SQL_MODE_TOGGLE_ID = "atlas-sql-mode-toggle";

/**
 * H05/§17H：settings.html 的「SQL 世界数据」开关（新安装默认启用）。
 *
 * 写入唯一设置键 `extensionSettings[ATLAS_SETTINGS_KEY][ATLAS_SQL_MODE_SETTING]`
 * （与 settings.html 上的说明一致），切换后立刻重渲染工作台——地图 / 附近 / 日志的
 * 读权威随之切换，不做「一半界面新一半界面旧」的中间态。
 * 宿主没渲染出这个抽屉（旧版酒馆 / 抽屉未展开）时静默返回 null，绝不阻塞挂载。
 */
export function bindSqlModeToggle(context, onChanged = null) {
  if (typeof document === "undefined") return null;
  const toggle = document.getElementById(ATLAS_SQL_MODE_TOGGLE_ID);
  if (!toggle) return null;
  const read = () => {
    try {
      return context()?.extensionSettings?.[ATLAS_SETTINGS_KEY]?.[ATLAS_SQL_MODE_SETTING] === true;
    } catch {
      return false;
    }
  };
  toggle.checked = read();
  if(toggle.__atlasChangeHandler)toggle.removeEventListener("change",toggle.__atlasChangeHandler);
  toggle.dataset.atlasBound = "true";
  const handler=() => {
    const ctx = context();
    ctx.extensionSettings[ATLAS_SETTINGS_KEY] = {
      ...(ctx.extensionSettings[ATLAS_SETTINGS_KEY] ?? {}),
      [ATLAS_SQL_MODE_SETTING]: toggle.checked === true,
    };
    if (typeof ctx.saveSettingsDebounced === "function") ctx.saveSettingsDebounced();
    emitAtlasDiagnostic({
      level: "info", source: "storage", code: "SQL_MODE_TOGGLED",
      operation: "settings", phase: "toggle", outcome: toggle.checked === true ? "enabled" : "disabled",
      details: { setting: ATLAS_SQL_MODE_SETTING },
    });
    if (typeof onChanged === "function") onChanged(toggle.checked === true);
  };
  toggle.__atlasChangeHandler=handler;
  toggle.addEventListener("change",handler);
  return toggle;
}

/** 记忆化的加载 Promise（成功 / 失败都只算一次；不重复打网络与 wasm 成本）。 */
let sqlCorePromise = null;

/** 只读加载状态（面板提示与诊断共用；不会触发加载）。 */
export function atlasSqlCoreStatus() {
  return { ...sqlCoreState };
}

/**
 * H05/§17H-H14：懒加载 SQL 世界数据核心（`dist/atlas-sql.mjs`）。
 *
 * 与 `loadUiCore` 同形（先组件内 dist 产物，再工程内 src 开发回退），但**只在
 * SQL 世界数据模式开启时**才被调用：sql.js + wasm 体积大，保持旧模式的用户一分钱都不付。
 * 记忆化 = 一次结果只算一次；任何候选都失败时：
 * 1. 给出**具名诊断** `SQL_CORE_UNAVAILABLE`（面板也会显示该代码，不静默）；
 * 2. 返回 null，调用方报告核心不可用并保持当前视图为空；
 * 3. 绝不假装 SQL 模式已生效。
 */
function loadSqlCore() {
  if (sqlCorePromise) return sqlCorePromise;
  sqlCoreState = { status: "loading", code: null, message: null };
  sqlCorePromise = (async () => {
    const candidates = Array.isArray(ATLAS_SQL_CORE_CANDIDATES) ? [...ATLAS_SQL_CORE_CANDIDATES] : [];
    let lastError = null;
    for (const specifier of candidates) {
      try {
        // 绝对 URL（data: / file: / 自定义部署）直接用；相对路径按模块位置解析
        const url = /^[a-z][a-z0-9+.-]*:/i.test(String(specifier))
          ? String(specifier)
          : new URL(String(specifier), import.meta.url).href;
        const mod = await import(url);
        if (typeof mod?.createSqlRepository !== "function") throw new Error("缺少 createSqlRepository 导出");
        sqlCoreState = { status: "ready", code: null, message: null };
        emitAtlasDiagnostic({
          level: "info", source: "storage", code: "SQL_CORE_LOADED",
          operation: "sql-core", phase: "load", outcome: "success",
          details: { candidate: String(specifier) },
        });
        return mod;
      } catch (error) {
        lastError = error;
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError ?? "未知原因");
    sqlCoreState = { status: "unavailable", code: "SQL_CORE_UNAVAILABLE", message };
    emitAtlasDiagnostic({
      level: "error", source: "storage", code: "SQL_CORE_UNAVAILABLE",
      operation: "sql-core", phase: "load", outcome: "failed", retryable: false,
      details: { message, candidateCount: candidates.length, mode: ATLAS_SQL_MODE_SETTING },
    });
    return null;
  })();
  return sqlCorePromise;
}

/**
 * 同源 Server Plugin 请求封装：统一解开 {ok, data|error} 信封。
 * CSRF：每个请求从 SillyTavern.getContext().getRequestHeaders() 重新取当前请求头
 * （官方扩展同款用法）；不缓存 token、不写入日志或持久化（AR-ATLAS-07 P0-05）。
 */
export function createApi(context) {
  return {
    async request(method, path, body) {
      const options = { method, headers: {} };
      const ctx = context();
      if (ctx && typeof ctx.getRequestHeaders === "function") {
        Object.assign(options.headers, ctx.getRequestHeaders());
      }
      if (body !== undefined) {
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(body);
      }
      const response = await fetch(`${ATLAS_API_BASE}${path}`, options);
      const json = await response.json().catch(() => ({}));
      return { status: response.status, body: json };
    },
  };
}

function createHost(context) {
  return {
    getChatId() {
      // shujuku getActiveChatId_ACU 口径（0.9.17 数据隔离）：优先 getCurrentChatId()，
      // 兜底 chatId 变量；空串 / "null" / undefined 一律视为「当前没有聊天」。
      // 直接信 context().chatId 会在关聊天 / 切卡瞬间拿到滞留值 → 面板残留旧卡数据。
      const ctx = context();
      let value;
      try {
        value = typeof ctx.getCurrentChatId === "function" ? ctx.getCurrentChatId() : ctx.chatId;
      } catch {
        value = ctx.chatId;
      }
      const normalized = value === undefined || value === null ? "" : String(value).trim();
      if (!normalized || normalized === "null" || normalized === "undefined") return null;
      return normalized;
    },
    /** 0.9.42：异步——先做一次性存量迁移（旧世界文档 → chatMetadata.atlas），再读绑定。 */
    async readBinding() {
      const metadata = context().chatMetadata;
      if (!metadata || typeof metadata !== "object") return null;
      if (context().extensionSettings?.[ATLAS_SETTINGS_KEY]?.[ATLAS_SQL_MODE_SETTING] === true) {
        return metadata.atlas?.binding ?? null;
      }
      await migrateChatSession(context);
      const session = readAtlasSession(context);
      if (session) return session.binding ?? null;
      // 兜底：迁移被跳过（如引擎未就绪）时仍能读到旧键
      return metadata[ATLAS_BINDING_KEY] ?? null;
    },
    /** 0.9.42：绑定写进会话文档（chatMetadata.atlas.binding）。 */
    async writeBinding(binding) {
      const metadata = context().chatMetadata;
      if (!metadata || typeof metadata !== "object") return;
      if (context().extensionSettings?.[ATLAS_SETTINGS_KEY]?.[ATLAS_SQL_MODE_SETTING] === true) {
        const atlas = metadata.atlas ??= {};
        const previous = atlas.sqlChatEnabled;
        atlas.sqlChatEnabled = binding.enabled;
        try {
          if (await context().saveMetadata() === false) throw new Error('SQL_CHAT_SETTINGS_SAVE_FAILED');
        } catch (error) {
          if (previous === undefined) delete atlas.sqlChatEnabled;
          else atlas.sqlChatEnabled = previous;
          throw error;
        }
        return;
      }
      const session = isValidAtlasSession(metadata[ATLAS_SESSION_KEY])
        ? metadata[ATLAS_SESSION_KEY]
        : createEmptyAtlasSession();
      session.binding = binding;
      metadata[ATLAS_SESSION_KEY] = session;
      delete metadata[ATLAS_BINDING_KEY];
      await context().saveMetadata();
    },
    /** 0.9.42：解绑只清会话里的绑定（世界数据保留，方便重新绑定）。 */
    async clearBinding() {
      const metadata = context().chatMetadata;
      if (!metadata || typeof metadata !== "object") return;
      if (context().extensionSettings?.[ATLAS_SETTINGS_KEY]?.[ATLAS_SQL_MODE_SETTING] === true) {
        await this.writeBinding({ enabled: false });
        return;
      }
      const session = isValidAtlasSession(metadata[ATLAS_SESSION_KEY])
        ? metadata[ATLAS_SESSION_KEY]
        : createEmptyAtlasSession();
      session.binding = null;
      metadata[ATLAS_SESSION_KEY] = session;
      delete metadata[ATLAS_BINDING_KEY];
      await context().saveMetadata();
    },
    readPanelOpen() {
      const settings = context().extensionSettings;
      return Boolean(settings?.[ATLAS_SETTINGS_KEY]?.panelOpen);
    },
    writePanelOpen(open) {
      const ctx = context();
      ctx.extensionSettings[ATLAS_SETTINGS_KEY] = { ...(ctx.extensionSettings[ATLAS_SETTINGS_KEY] ?? {}), panelOpen: open };
      ctx.saveSettingsDebounced();
    },
    /** 建议行动填入酒馆输入框；绝不自动发送。 */
    fillInput(text) {
      const textarea = document.querySelector("#send_textarea");
      if (!textarea) {
        console.warn("[atlas] 未找到酒馆输入框 #send_textarea，建议行动未填入。");
        return;
      }
      textarea.value = text;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.focus();
    },
    /** extensionSettings 下的键值读（回执持久化；core 侧保证有界与形状校验）。 */
    readData(key) {
      const settings = context().extensionSettings;
      const bucket = settings?.[ATLAS_SETTINGS_KEY];
      return bucket ? bucket[key] ?? null : null;
    },
    /** extensionSettings 下的键值写（防抖保存；core 侧保证有界）。 */
    writeData(key, value) {
      const ctx = context();
      ctx.extensionSettings[ATLAS_SETTINGS_KEY] = { ...(ctx.extensionSettings[ATLAS_SETTINGS_KEY] ?? {}), [key]: value };
      ctx.saveSettingsDebounced();
    },
  };
}

function createEmitter(context) {
  const { eventSource, event_types } = context();
  /** Register all available completion aliases; core debounces duplicate notifications. */
  const EVENT_MAP = {
    APP_READY: ["APP_READY"],
    CHAT_CHANGED: ["CHAT_CHANGED"],
    MESSAGE_SENT: ["MESSAGE_SENT"],
    MESSAGE_RECEIVED: ["MESSAGE_RECEIVED"],
    GENERATION_STARTED: ["GENERATION_STARTED"],
    GENERATION_ENDED: ["GENERATION_ENDED_AFTER_COMMANDS", "GENERATION_ENDED"],
    GENERATION_STOPPED: ["GENERATION_STOPPED"],
    MESSAGE_SWIPED: ["MESSAGE_SWIPED"],
    MESSAGE_EDITED: ["MESSAGE_EDITED"],
    MESSAGE_DELETED: ["MESSAGE_DELETED"],
  };
  const namesFor = (event) => {
    const candidates = EVENT_MAP[event];
    if (!candidates) throw new Error(`未映射的 Atlas UI 事件：${event}`);
    const names = [...new Set(candidates.map(name => event_types[name]).filter(Boolean))];
    if (names.length) return names;
    throw new Error(`SillyTavern 未提供事件 ${event}，Atlas 跳过注册。`);
  };
  const handlers = [];
  return {
    on(event, handler) {
      let mapped = [];
      try {
        mapped = namesFor(event);
      } catch (error) {
        emitAtlasDiagnostic({
          level: "warn", source: "host", code: "HOST_EVENT_UNAVAILABLE",
          operation: "events", phase: "register", outcome: "skipped",
          details: { event },
        });
        console.warn("[atlas]", error instanceof Error ? error.message : String(error));
        return;
      }
      /**
       * H05：事件归一入口。
       *
       * 每个宿主事件先经过 `atlasSqlNoteHostEvent` 做一次身份归一与 SQL 候选生命周期
       * （stop 取消候选 / regen 换新 variantKey 起新候选 / 删楼丢弃候选），再交给
       * 原处理函数——归一与业务处理是同一次事件，绝不各自缓存一份「上次的楼层」。
       * SQL 模式关闭时该函数立刻返回（端口未注册），对旧路径零影响。
       */
      for (const name of mapped) {
        const wrapped = (...args) => {
          const payload = args[0];
          if (event === "CHAT_CHANGED") clearInjection();
          atlasSqlNoteHostEvent(event, payload, context);
          const value = args.length > 1 ? args : payload;
          return handler(event === "GENERATION_ENDED"
            ? { atlasCompletionSignal: name === event_types.GENERATION_ENDED ? "ended" : "after-commands", payload: value }
            : value);
        };
        eventSource.on(name, wrapped);
        // 每个别名保留原始 handler 身份，dispose 逐个注销。
        handlers.push([[name], wrapped, handler]);
      }
    },
    off(event, handler) {
      // 按处理函数身份查找（on 时可能已因事件缺失而未注册；可能是原始引用，也可能是包装函数）
      for (let index = handlers.length - 1; index >= 0; index--) {
        const [mapped, fn, original] = handlers[index];
        if (fn !== handler && original !== handler) continue;
        for (const name of mapped) {
          if (typeof eventSource.removeListener === "function") eventSource.removeListener(name, fn);
          else if (typeof eventSource.off === "function") eventSource.off(name, fn);
        }
        handlers.splice(index, 1);
      }
    },
  };
}

/** 清除生成拦截器注入（临时上下文；不写入可见聊天历史）。 */
function clearInjection() {
  defaultSetExtensionPrompt(ATLAS_INJECTION_KEY, "", 2, 4);
  for (const key of atlasSceneInjectionKeys) defaultSetExtensionPrompt(key, "", 2, 4);
  atlasSceneInjectionKeys.clear();
}

/**
 * 酒馆事件载荷适配器（deps.adaptEvent）。
 * ST 各事件数据形状不统一：形状未知 / 载荷不可用返回 null，绝不猜测。
 *
 * H05（0.9.61）：助手楼层事件额外带上**稳定身份**（`messageUID` / `variantKey` /
 * `contentHash`）——它们是 SQL 候选回合的锚点，不是数组下标：
 * 删楼 / 截断会让下标漂移，身份不会（见 `atlasFloorIdentity`）。
 */
/** 酒馆右滑新生成时先把 swipe_id 设为 swipes.length，正文生成后才追加数组。 */
export function atlasSwipeRegenerating(message) {
  if (!message || !Array.isArray(message.swipes) || message.swipes.length === 0) return null;
  const selected = Number(message.swipe_id ?? 0);
  if (!Number.isInteger(selected) || selected < 0 || selected > message.swipes.length) return null;
  if (selected === message.swipes.length) return true;
  const candidate = message.swipes[selected];
  if (typeof candidate !== "string") return null;
  return candidate.length === 0;
}

function createEventAdapter(context) {
  return function adaptEvent(event, payload) {
    /**
     * H05：给「带助手楼层」的事件补一份身份。
     * 身份取不到（无楼层 / 形状未知）时**不补字段**：宁可让下游按「无身份」处理，
     * 也绝不塞一个下标冒充 messageUID。
     */
    const withIdentity = (eventName, index, base) => {
      const chat = context().chat;
      const message = Array.isArray(chat) ? chat[index] : null;
      if (!message || message.is_user === true) return base;
      const identity = atlasFloorIdentity(message, index, { chatId: atlasContextRecord(context)?.chatId ?? null });
      return { ...base, ...identity };
    };
    if (event === "MESSAGE_SENT") {
      const chat = context().chat;
      const index = Number(Array.isArray(payload) ? payload[0] : payload);
      if (!Array.isArray(chat) || !Number.isInteger(index) || index < 0 || index >= chat.length) return null;
      return { kind: "message-sent", messageId: String(index), userText: String(chat[index]?.mes ?? "") };
    }
    if (event === "MESSAGE_RECEIVED") {
      const args = Array.isArray(payload) ? payload : [payload];
      if (['first_message', 'quiet', 'impersonate'].includes(args[1])) return null;
      const chat = context().chat;
      if (!Array.isArray(chat) || chat.length === 0) return null;
      const raw = Number(args[0]);
      const index = Number.isInteger(raw) && raw >= 0 && raw < chat.length ? raw : chat.length - 1;
      return withIdentity(event, index, { kind: "generation-ended", completionSignal: "received", foreground: args.length > 1, assistantMessageId: String(index), assistantText: String(chat[index]?.mes ?? "") });
    }
    if (event === "GENERATION_ENDED" || event === "GENERATION_ENDED_AFTER_COMMANDS") {
      const chat = context().chat;
      // Background requests can finish before the first visible floor exists.
      const index = Array.isArray(chat) ? chat.length - 1 : -1;
      const completionSignal = payload?.atlasCompletionSignal ?? (event === "GENERATION_ENDED_AFTER_COMMANDS" ? "after-commands" : "ended");
      return withIdentity(event, index, { kind: "generation-ended", completionSignal, assistantMessageId: String(index), assistantText: String(chat?.[index]?.mes ?? "") });
    }
    if (event === "GENERATION_STOPPED") {
      // H05：停止生成 = 这一轮的 SQL 候选作废（生命周期由 emitter 归一入口统一收口）
      return { kind: "generation-stopped" };
    }
    if (event === "GENERATION_STARTED") {
      // shujuku 门控：酒馆内部 quiet 生成（type=quiet / params.quiet_prompt / dryRun /
      // automatic_trigger）不触发 prepare / 注入 / 推演。ST 载荷 = (type, params, dryRun)。
      const raw = Array.isArray(payload) ? payload : [payload];
      const type = typeof raw[0] === "string" ? raw[0] : "";
      const params = raw[1] && typeof raw[1] === "object" ? raw[1] : {};
      const dryRun = raw[2] === true || params.dryRun === true;
      const gated =
        type === "quiet" ||
        dryRun ||
        (typeof params.quiet_prompt === "string" && params.quiet_prompt.length > 0) ||
        params.automatic_trigger === true;
      const chat = context().chat;
      const userIndex = Array.isArray(chat) ? chat.findLastIndex(m => m?.is_user === true && typeof m.mes === 'string') : -1;
      const retryTurn = !gated && ['regenerate', 'swipe'].includes(type) && userIndex >= 0
        ? { userMessageId: String(userIndex), userText: chat[userIndex].mes, assistantMessageId: String(chat.length - 1) }
        : undefined;
      const generationType = ['normal', 'quiet', 'regenerate', 'swipe', 'continue', 'impersonate'].includes(type) ? type : 'unknown';
      return { kind: "generation-started", gated, metadata: { generationType, dryRun,
        automaticTrigger: params.automatic_trigger === true,
        quietPromptPresent: typeof params.quiet_prompt === 'string' && params.quiet_prompt.length > 0 },
        ...(retryTurn ? { retryTurn } : {}) };
    }
    if (event === "MESSAGE_SWIPED") {
      const chat = context().chat;
      const index = Number(Array.isArray(payload) ? payload[0] : payload);
      if (!Array.isArray(chat) || !Number.isInteger(index) || index < 0 || index >= chat.length) return null;
      const mes = chat[index];
      // 新生成可为数组外的待填槽，也可为末尾空占位；已有非空变体不回退。
      const regenerating = atlasSwipeRegenerating(mes);
      // H05：换 swipe = 换 variantKey（新变体必须是一次**新** prepare，绝不复用旧 token）
      return withIdentity(event, index, {
        kind: "message-swiped",
        messageId: String(index),
        userMessageId: String(Math.max(0, index - 1)),
        userText: String(chat[index - 1]?.mes ?? ""),
        regenerating,
      });
    }
    if (event === "MESSAGE_EDITED" || event === "MESSAGE_DELETED") {
      const index = Number(Array.isArray(payload) ? payload[0] : payload);
      if (!Number.isInteger(index) || index < 0) return null;
      return { kind: event === "MESSAGE_EDITED" ? "message-edited" : "message-deleted", messageId: String(index) };
    }
    return null;
  };
}

/** ATLAS-06 楼层重解析：防抖窗口结束后重读真实末条 AI 楼层（ENDED 锚点可能早于楼层落盘）。 */
function createAssistantFloorResolver(context) {
  return function resolveAssistantFloor() {
    const chat = context().chat;
    if (!Array.isArray(chat)) return null;
    for (let index = chat.length - 1; index >= 0; index -= 1) {
      const mes = chat[index];
      if (mes && mes.is_user === false && typeof mes.mes === "string" && mes.mes.trim()) {
        return { assistantMessageId: String(index), assistantText: mes.mes };
      }
    }
    return null;
  };
}

/** 默认注入通道：SillyTavern setExtensionPrompt（IN_CHAT 深度 4；临时上下文）。 */
function defaultSetExtensionPrompt(key, value, position, depth) {
  if (typeof SillyTavern === "undefined") return;
  const ctx = SillyTavern.getContext();
  if (typeof ctx?.setExtensionPrompt !== "function") {
    emitAtlasDiagnostic({ level: "warn", source: "host", code: "INJECTION_UNAVAILABLE",
      operation: "injection", phase: "capability", outcome: "failed",
      details: { capability: "setExtensionPrompt" } });
    console.warn("[atlas] 酒馆未提供 setExtensionPrompt，本轮无法注入阿特拉斯上下文。");
    return;
  }
  ctx.setExtensionPrompt(key, value, position, depth);
}

/**
 * 生成拦截器工厂（ATLAS-FIX-01 P0-03）：
 * 官方签名 (chat, contextSize, abort, type)——第三参是 abort 回调而不是 dryRun；
 * 返回值被官方丢弃，注入通过 setExtensionPrompt 临时上下文完成，绝不改 chat 数组。
 * 注入前先等同一条 prepare 落定（core.waitPendingTurn，P0-04）；无 pending 清空不残留。
 * @param {object} core AtlasUiCore
 * @param {{ setExtensionPrompt?: Function, waitMs?: number }} [io] 测试注入
 */
export function createGenerateInterceptor(core, io = {}) {
  const setPrompt =
    typeof io.setExtensionPrompt === "function"
      ? io.setExtensionPrompt
      : (key, value) => defaultSetExtensionPrompt(key, value, 2, 4);
  const waitMs = typeof io.waitMs === "number" ? io.waitMs : 10_000;
  return async function atlasGenerateInterceptor(chat, contextSize, abort, type) {
    // 官方四参数契约：chat（不改动）、contextSize（不使用）、abort（绝不调用）。
    // ATLAS-06 门控：酒馆内部 quiet 生成（总结 / 向量索引等）不注入阿特拉斯上下文。
    void chat;
    void contextSize;
    void abort;
    for (const key of atlasSceneInjectionKeys) setPrompt(key, "", 2, 4);
    atlasSceneInjectionKeys.clear();
    if (type === "quiet") {
      setPrompt(ATLAS_INJECTION_KEY, "", 2, 4);
      return;
    }
    try {
      await core.waitPendingTurn(waitMs);
      const pending = core.getState().pendingTurn;
      if (!pending) {
        emitAtlasDiagnostic({ level: "info", source: "host", code: "PROMPT_INJECTION_SKIPPED",
          operation: "injection", phase: "pending", outcome: "skipped",
          details: { reasonCode: "NO_PENDING" } });
        setPrompt(ATLAS_INJECTION_KEY, "", 2, 4);
        return;
      }
      setPrompt(ATLAS_INJECTION_KEY, String(pending.injectionText ?? ""), 2, 4);
      emitAtlasDiagnostic({ level: "info", source: "host", code: "PROMPT_INJECTION_COMPLETE",
        operation: "injection", phase: "applied", outcome: "success" });
    } catch (error) {
      emitAtlasDiagnostic({ level: "error", source: "host", code: "INJECTION_FAILED",
        operation: "injection", phase: "applied", outcome: "failed", retryable: true });
      setPrompt(ATLAS_INJECTION_KEY, "", 2, 4);
      console.warn("[atlas] 注入失败（酒馆生成不受影响）：", error instanceof Error ? error.message : String(error));
    }
  };
}

/** 安装到 globalThis（manifest generate_interceptor 按名字查找）。重复安装 = 覆盖为最新闭包。
 *  io 仅测试注入（setExtensionPrompt / waitMs）；生产走默认酒馆通道。 */
export function installGenerateInterceptor(core, io = {}) {
  window[ATLAS_INTERCEPTOR_GLOBAL] = createGenerateInterceptor(core, io);
}

/** 拖拽进行中的清理回调（disable 时可能正拖着窗口；防止 document 级监听泄漏）。 */
let activeDragCleanup = null;

/**
 * ATLAS-FIX-02：卸载本插件安装的**全部全局痕迹**。
 * 宿主按名字查找 `window[ATLAS_INTERCEPTOR_GLOBAL]`——停用后如果残留旧闭包，
 * 普通生成仍会被旧闭包接管（pending 已 dispose，注入空串，但闭包引用已死核心）。
 * 必须删除，让宿主查不到 → 零注入；再次 activate 时 install 覆盖为最新实例。
 */
export function atlasUninstallGlobals() {
  if (typeof window !== "undefined" && window[ATLAS_INTERCEPTOR_GLOBAL] !== undefined) {
    try {
      delete window[ATLAS_INTERCEPTOR_GLOBAL];
    } catch {
      window[ATLAS_INTERCEPTOR_GLOBAL] = undefined;
    }
  }
  if (typeof activeDragCleanup === "function") {
    activeDragCleanup();
    activeDragCleanup = null;
  }
}

// ---------------------------------------------------------------------------
// 面板 DOM（五页；地图 = 查看 / 定位 / 目的地预览）
// ---------------------------------------------------------------------------

// C6（0.9.54）：导航页清单唯一权威在 src/atlas-ui-core.ts 的 ATLAS_UI_PAGES，
// 经 atlas-browser-entry 导出后由 renderPanel 从 mod 解构（见下方 const { ATLAS_UI_PAGES }）。
// 此前此处另有一份 PAGES 副本，两处漂移（副本有 9 页含 skin，权威清单只有 8 页），
// 而旧一致性测试只检查「权威清单是本副本的子集」，故 skin 缺失从未被发现。

// ---------------------------------------------------------------------------
// 0.9.46 皮肤系统
// 机制 = style.css 的 .atlas-workbench 全部走 --aw-* 令牌；主题 = data-atlas-theme
// 属性切换令牌覆盖块；自定义皮肤 = 用户 CSS 覆盖任意令牌子集（注入 <style>）。
// 完整性由 tests/atlas-skin.test.mjs 门禁：style.css 定义的每个 --aw-* 必须在册。
// ---------------------------------------------------------------------------

/** 皮肤令牌注册清单（与 style.css .atlas-workbench 基座一一对应）。 */
export const ATLAS_SKIN_VARIABLES = [
  // 基座（0.9.46 之前既有）
  "--aw-paper",
  "--aw-panel",
  "--aw-ink",
  "--aw-teal",
  "--aw-teal-deep",
  "--aw-gold",
  "--aw-gold-soft",
  "--aw-gold-deep",
  "--aw-muted",
  "--aw-line",
  "--aw-rail-bg",
  "--aw-rail-text",
  "--aw-rail-dim",
  // 0.9.46 收敛新增（历史硬编码色 → 令牌）
  "--aw-ink-strong",
  "--aw-ink-soft",
  "--aw-danger",
  "--aw-danger-deep",
  "--aw-gold-busy",
  "--aw-teal-wash",
  "--aw-teal-wash-strong",
  "--aw-teal-line",
  "--aw-gold-wash",
  "--aw-gold-wash-strong",
  "--aw-gold-line",
  "--aw-gold-hairline",
  "--aw-veil",
  "--aw-veil-strong",
  "--aw-veil-soft",
  "--aw-veil-line",
  "--aw-input-bg",
  "--aw-input-dim",
  "--aw-input-disabled-bg",
  // 字体
  "--aw-serif",
  "--aw-sans",
];

/** 内置主题（id ↔ style.css 的 data-atlas-theme 值；"paper" 为缺省 = 无属性）。 */
export const ATLAS_SKIN_THEMES = [
  { id: "starmap", label: "星幕（默认）" },
  { id: "paper", label: "纸面" },
  { id: "dark", label: "深色战术" },
];

const ATLAS_CUSTOM_SKIN_LIMIT = 20000;

/** 规范化主题 id：未知值一律回退 "paper"。 */
export function normalizeAtlasSkinTheme(value) {
  return ATLAS_SKIN_THEMES.some((theme) => theme.id === value) ? value : "paper";
}

/**
 * 应用皮肤：主题属性挂根节点 + 自定义 CSS 注入 <style data-atlas-custom-skin>。
 * 幂等——重复调用只更新内容，不重复建节点。customCss 有界（≤20000 字符，超出截断）。
 */
export function applyAtlasSkin(root, { theme, customCss } = {}) {
  const normalized = normalizeAtlasSkinTheme(theme);
  if (root) {
    if (normalized === "paper") delete root.dataset.atlasTheme;
    else root.dataset.atlasTheme = normalized;
  }
  const css = typeof customCss === "string" ? customCss.slice(0, ATLAS_CUSTOM_SKIN_LIMIT) : "";
  if (typeof document === "undefined") return { theme: normalized, customCss: css };
  let styleTag = document.querySelector("style[data-atlas-custom-skin]");
  if (!styleTag) {
    styleTag = document.createElement("style");
    styleTag.setAttribute("data-atlas-custom-skin", "");
    (document.head ?? document.body ?? root)?.append(styleTag);
  }
  styleTag.textContent = css;
  return { theme: normalized, customCss: css };
}

// ---------------------------------------------------------------------------
// 0.9.51（M07/M08）地图皮肤：--am-* 令牌注册表 + .atlas-map-skin.json 导入。
// 注册表是唯一权威（验证 / 默认 / 样例导出 / CSS 合约测试都从它派生，防多份清单漂移）。
// 继承优先级：工作台主题映射（--aw-*，含 paper/dark）→ 用户地图皮肤（--am-* 注入覆盖）
//   → 用户自定义 CSS（0.9.45 既有 <style data-atlas-custom-skin>，天然最后）。
// 皮肤只换外观：绝不触碰 metersPerCell / frame / 实体坐标 / 操作回调 / 标尺长度。
// ---------------------------------------------------------------------------

/** 地图皮肤令牌大小上限（纯令牌文件；计划 12.3 建议 64 KiB）。 */
export const ATLAS_MAP_SKIN_BYTES_MAX = 64 * 1024;
/** 令牌条数上限（注册表 31 键 + 余量；超限明确拒绝，不静默截断）。 */
export const ATLAS_MAP_SKIN_TOKENS_MAX = 64;

/** 颜色只接受 #hex（3/4/6/8 位）——不解释 rgb()/hsl()/named/任意 CSS 表达式。 */
const ATLAS_MAP_SKIN_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** 地图皮肤令牌注册表：语义键 → {type, css, min/max 或 enum}。缺省令牌不注入（跟随工作台）。 */
export const ATLAS_MAP_SKIN_TOKENS = {
  "colors.canvas": { type: "color", css: "--am-canvas" },
  "colors.gridMinor": { type: "color", css: "--am-grid-minor" },
  "colors.text": { type: "color", css: "--am-text" },
  "colors.textMuted": { type: "color", css: "--am-text-muted" },
  "colors.border": { type: "color", css: "--am-border" },
  "colors.focusRing": { type: "color", css: "--am-focus-ring" },
  "colors.location": { type: "color", css: "--am-location" },
  "colors.person": { type: "color", css: "--am-person" },
  "colors.item": { type: "color", css: "--am-item" },
  "colors.popoverBg": { type: "color", css: "--am-popover-bg" },
  "colors.popoverHeaderBg": { type: "color", css: "--am-popover-header-bg" },
  "colors.rowHover": { type: "color", css: "--am-row-hover" },
  "colors.buttonBg": { type: "color", css: "--am-button-bg" },
  "colors.buttonText": { type: "color", css: "--am-button-text" },
  "colors.buttonHover": { type: "color", css: "--am-button-hover" },
  "colors.scaleText": { type: "color", css: "--am-scale-text" },
  "colors.scaleBg": { type: "color", css: "--am-scale-bg" },
  "colors.error": { type: "color", css: "--am-error" },
  "colors.estimated": { type: "color", css: "--am-estimated" },
  "metrics.popoverWidthPx": { type: "number", css: "--am-popover-width-px", min: 220, max: 480 },
  "metrics.popoverRadiusPx": { type: "number", css: "--am-popover-radius-px", min: 0, max: 24 },
  "metrics.controlRadiusPx": { type: "number", css: "--am-control-radius-px", min: 0, max: 16 },
  "metrics.controlHeightPx": { type: "number", css: "--am-control-height-px", min: 24, max: 56 },
  "metrics.bodyFontSizePx": { type: "number", css: "--am-body-font-size-px", min: 10, max: 20 },
  "metrics.titleFontSizePx": { type: "number", css: "--am-title-font-size-px", min: 11, max: 24 },
  "metrics.spacingPx": { type: "number", css: "--am-spacing-px", min: 2, max: 24 },
  "effects.shadow": { type: "enum", css: "--am-shadow", enum: ["none", "soft", "medium", "strong"] },
  "effects.motion": { type: "enum", css: "--am-motion", enum: ["none", "subtle", "normal"] },
  "fonts.family": { type: "enum", css: "--am-font-family", enum: ["system", "serif", "sans"] },
  "markers.locationShape": { type: "enum", css: "--am-marker-radius-location", enum: ["circle", "rounded-square", "square", "diamond"] },
  "markers.personShape": { type: "enum", css: "--am-marker-radius-person", enum: ["circle", "rounded-square", "square", "diamond"] },
  "markers.itemShape": { type: "enum", css: "--am-marker-radius-item", enum: ["circle", "rounded-square", "square", "diamond"] },
};

/** effects/shapes/fonts 的语义枚举 → 具体 CSS 值（转换层供值，用户字符串绝不直接拼接进 CSS）。 */
const ATLAS_MAP_SKIN_CSS_VALUES = {
  "--am-shadow": { none: "none", soft: "0 2px 8px rgba(31,42,51,0.14)", medium: "0 4px 14px rgba(31,42,51,0.18)", strong: "0 8px 24px rgba(31,42,51,0.28)" },
  "--am-motion": { none: "0s", subtle: "0.12s", normal: "0.25s" },
  "--am-font-family": { system: "var(--aw-sans)", serif: "var(--aw-serif)", sans: "var(--aw-sans)" },
  "--am-marker-radius-location": { circle: "50%", "rounded-square": "6px", square: "1px", diamond: "50% 0 50% 0" },
  "--am-marker-radius-person": { circle: "50%", "rounded-square": "6px", square: "1px", diamond: "50% 0 50% 0" },
  "--am-marker-radius-item": { circle: "50%", "rounded-square": "4px", square: "1px", diamond: "50% 0 50% 0" },
};

/**
 * 解析并校验 .atlas-map-skin.json（不可信输入；纯函数，可测）。
 * 返回 {ok:true, skin:{meta + tokens + unknownKeys}} 或 {ok:false, error, warnings}。
 * 纪律：未知版本明确拒绝；未知令牌不执行只提示；超范围数字 clamp 到边界；
 * 白名单逐键显式构造新对象——__proto__/constructor 等危险键天然进不了结果。
 */
export function parseAtlasMapSkin(raw) {
  if (typeof raw === "string") {
    if (raw.length > ATLAS_MAP_SKIN_BYTES_MAX) {
      return { ok: false, error: `皮肤文件超过 ${Math.round(ATLAS_MAP_SKIN_BYTES_MAX / 1024)} KiB 上限（纯令牌文件不该这么大）。`, warnings: [] };
    }
  }
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, error: "皮肤文件不是合法 JSON。", warnings: [] };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "皮肤文件必须是 JSON 对象。", warnings: [] };
  }
  const record = value;
  if (record.kind !== "atlas-map-skin") {
    return { ok: false, error: "kind 必须是 \"atlas-map-skin\"（这不是阿特拉斯地图皮肤文件）。", warnings: [] };
  }
  if (record.schemaVersion !== 1 || record.skinApiVersion !== 1) {
    return { ok: false, error: `不支持的皮肤协议版本（schemaVersion=${JSON.stringify(record.schemaVersion)}，skinApiVersion=${JSON.stringify(record.skinApiVersion)}）——本插件支持版本 1。`, warnings: [] };
  }
  const meta = {
    id: String(record.id ?? "user.custom").trim().slice(0, 64) || "user.custom",
    name: String(record.name ?? "未命名地图皮肤").trim().slice(0, 40) || "未命名地图皮肤",
    version: String(record.version ?? "1.0.0").trim().slice(0, 16),
    author: String(record.author ?? "").trim().slice(0, 40),
    baseTheme: record.baseTheme === "dark" ? "dark" : record.baseTheme === "paper" ? "paper" : "",
  };
  const warnings = [];
  const rawTokens = record.tokens && typeof record.tokens === "object" && !Array.isArray(record.tokens) ? record.tokens : {};
  const tokenKeys = Object.keys(rawTokens);
  if (tokenKeys.length > ATLAS_MAP_SKIN_TOKENS_MAX) {
    return { ok: false, error: `令牌条数超过上限（${tokenKeys.length} > ${ATLAS_MAP_SKIN_TOKENS_MAX}）。`, warnings: [] };
  }
  const tokens = {};
  for (const key of tokenKeys) {
    // 原型危险键：白名单查找查不到 → 落入 unknownKeys 提示，绝不进结果对象
    const spec = Object.prototype.hasOwnProperty.call(ATLAS_MAP_SKIN_TOKENS, key) ? ATLAS_MAP_SKIN_TOKENS[key] : null;
    if (!spec) {
      warnings.push(`未知令牌「${String(key).slice(0, 40)}」已忽略。`);
      continue;
    }
    const rawValue = rawTokens[key];
    if (spec.type === "color") {
      if (typeof rawValue !== "string" || !ATLAS_MAP_SKIN_COLOR_RE.test(rawValue.trim())) {
        warnings.push(`令牌「${key}」颜色值非法（只支持 #hex），已忽略。`);
        continue;
      }
      tokens[key] = rawValue.trim().toLowerCase();
    } else if (spec.type === "number") {
      const num = typeof rawValue === "number" ? rawValue : Number(rawValue);
      if (typeof rawValue !== "number" || !Number.isFinite(num)) {
        warnings.push(`令牌「${key}」必须是有限数字，已忽略。`);
        continue;
      }
      tokens[key] = Math.min(spec.max, Math.max(spec.min, num));
    } else {
      if (!spec.enum.includes(rawValue)) {
        warnings.push(`令牌「${key}」必须是 ${spec.enum.map((v) => `"${v}"`).join(" / ")} 之一，已忽略。`);
        continue;
      }
      tokens[key] = rawValue;
    }
  }
  return { ok: true, skin: { ...meta, tokens, unknownKeys: warnings.length, warnings } };
}

/** 已校验皮肤 → --am-* CSS 变量声明文本（枚举经转换层供值；未提供令牌不注入 = 跟随工作台）。 */
export function atlasMapSkinToCssVars(skin) {
  if (!skin || typeof skin !== "object") return "";
  const tokens = skin.tokens && typeof skin.tokens === "object" ? skin.tokens : {};
  const lines = [];
  for (const [key, value] of Object.entries(tokens)) {
    const spec = Object.prototype.hasOwnProperty.call(ATLAS_MAP_SKIN_TOKENS, key) ? ATLAS_MAP_SKIN_TOKENS[key] : null;
    if (!spec) continue;
    const cssValue = spec.type === "enum" ? ATLAS_MAP_SKIN_CSS_VALUES[spec.css]?.[value] : value;
    if (cssValue === undefined || cssValue === null || cssValue === "") continue;
    lines.push(`${spec.css}: ${cssValue};`);
  }
  return lines.join("\n    ");
}

/**
 * 应用地图皮肤：--am-* 变量注入 <style data-atlas-map-skin>（作用域 .atlas-workbench）。
 * skin = null → 移除注入（恢复跟随工作台主题）。幂等；系统减少动画时强制 0s。
 */
export function applyAtlasMapSkin(root, skin) {
  if (typeof document === "undefined") return skin ?? null;
  let styleTag = document.querySelector("style[data-atlas-map-skin]");
  const vars = atlasMapSkinToCssVars(skin);
  if (!vars) {
    styleTag?.remove();
    if (root) delete root.dataset.atlasMapSkin;
    return null;
  }
  if (!styleTag) {
    styleTag = document.createElement("style");
    styleTag.setAttribute("data-atlas-map-skin", "");
    (document.head ?? document.body ?? root)?.append(styleTag);
  }
  styleTag.textContent =
    `.atlas-workbench {\n    ${vars}\n  }\n` +
    `@media (prefers-reduced-motion: reduce) {\n    .atlas-workbench { --am-motion: 0s !important; }\n  }`;
  if (root) root.dataset.atlasMapSkin = String(skin.id ?? "custom");
  return skin;
}

/** 导出皮肤：只含主题元数据与允许的令牌（绝不包含聊天 / API 配置 / 密钥）。 */
export function exportAtlasMapSkin(skin) {
  const tokens = skin?.tokens && typeof skin.tokens === "object" ? skin.tokens : {};
  return JSON.stringify(
    {
      kind: "atlas-map-skin",
      schemaVersion: 1,
      skinApiVersion: 1,
      id: String(skin?.id ?? "user.custom"),
      name: String(skin?.name ?? "未命名地图皮肤"),
      version: String(skin?.version ?? "1.0.0"),
      author: String(skin?.author ?? ""),
      baseTheme: skin?.baseTheme === "dark" ? "dark" : skin?.baseTheme === "paper" ? "paper" : undefined,
      tokens,
    },
    null,
    2,
  );
}

/**
 * R15：推演提示词预设导入导出（R02 残留「JSON 包」交付）。
 * - 只含预设语义字段（name / segments / contextTurnCount），**绝不含 API 连接与密钥**
 *   （promptPresets 本来就不持有密钥；此处显式白名单构造，杜绝将来误加字段）。
 * - 导入是预校验：通过后仍由服务端 prompt.save 的 normalizePromptSegments 权威归一。
 */
export const ATLAS_PROMPT_PACK_PROTOCOL = "atlas-prompt-pack@1";
export const ATLAS_PROMPT_PACK_BYTES_MAX = 512 * 1024;
const ATLAS_PROMPT_PACK_NAME_MAX = 80;
const ATLAS_PROMPT_PACK_SEGMENT_CHARS_MAX = 8000;
const ATLAS_PROMPT_PACK_SEGMENTS_MAX = 16;

/** 与 src/atlas-settings.ts normalizePromptSegments 同规则（角色白名单 / trim / 丢空段 / 上限）。 */
function normalizePromptPackSegments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw.slice(0, ATLAS_PROMPT_PACK_SEGMENTS_MAX * 2)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const role = typeof entry.role === "string" ? entry.role.trim().toLowerCase() : "";
    if (!["system", "user", "assistant"].includes(role)) continue;
    const content = typeof entry.content === "string" ? entry.content.trim() : "";
    if (!content) continue;
    if (out.length >= ATLAS_PROMPT_PACK_SEGMENTS_MAX) break;
    const segment = { role, content: content.slice(0, ATLAS_PROMPT_PACK_SEGMENT_CHARS_MAX) };
    if (typeof entry.name === "string" && entry.name.trim()) segment.name = entry.name.trim().slice(0, 64);
    if (entry.mainSlot === "A" || entry.mainSlot === "B" || entry.mainSlot === "") segment.mainSlot = entry.mainSlot;
    if (entry.deletable === false) segment.deletable = false;
    if (entry.enabled === false) segment.enabled = false;
    out.push(segment);
  }
  return out;
}

/** 导出预设为 JSON 包字符串（单提示词预设自动包成一段 system 段）。 */
export function buildAtlasPromptPack(preset, now = Date.now()) {
  const name = String(preset?.name ?? "").trim().slice(0, ATLAS_PROMPT_PACK_NAME_MAX) || "未命名预设";
  const segments = normalizePromptPackSegments(preset?.segments);
  if (segments.length === 0) {
    const single = typeof preset?.systemPrompt === "string" ? preset.systemPrompt.trim() : "";
    if (!single) return null; // 空预设无导出价值：不产出空包（调用方如实报错）
    segments.push({ role: "system", content: single.slice(0, ATLAS_PROMPT_PACK_SEGMENT_CHARS_MAX) });
  }
  // 同样只收真数字（字符串伪数值不导出，避免把本地脏数据带进包）
  const count = preset?.contextTurnCount;
  const contextTurnCount =
    typeof count === "number" && Number.isInteger(count) && count >= 1 && count <= 10 ? count : undefined;
  return JSON.stringify(
    {
      protocol: ATLAS_PROMPT_PACK_PROTOCOL,
      exportedAt: new Date(now).toISOString(),
      preset: {
        name,
        segments,
        ...(contextTurnCount === undefined ? {} : { contextTurnCount }),
      },
    },
    null,
    2,
  );
}

/** 解析导入包：严格预校验，任何不合规都返回可读原因（绝不半信半疑地落库）。 */
export function parseAtlasPromptPack(raw) {
  const text = typeof raw === "string" ? raw : "";
  if (!text.trim()) return { ok: false, error: "文件为空。" };
  if (new TextEncoder().encode(text).byteLength > ATLAS_PROMPT_PACK_BYTES_MAX) {
    return { ok: false, error: `文件超过 ${String(Math.round(ATLAS_PROMPT_PACK_BYTES_MAX / 1024))} KiB 上限。` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "不是合法 JSON。" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "包根节点必须是对象。" };
  }
  if (parsed.protocol !== ATLAS_PROMPT_PACK_PROTOCOL) {
    return { ok: false, error: `协议不匹配（需要 ${ATLAS_PROMPT_PACK_PROTOCOL}）。` };
  }
  const preset = parsed.preset;
  if (!preset || typeof preset !== "object" || Array.isArray(preset)) {
    return { ok: false, error: "缺少 preset 字段。" };
  }
  const name = typeof preset.name === "string" ? preset.name.trim() : "";
  if (!name) return { ok: false, error: "预设名缺失。" };
  if (name.length > ATLAS_PROMPT_PACK_NAME_MAX) {
    return { ok: false, error: `预设名超过 ${ATLAS_PROMPT_PACK_NAME_MAX} 字上限。` };
  }
  const segments = normalizePromptPackSegments(preset.segments);
  if (segments.length === 0) {
    return { ok: false, error: "没有有效分段（role 必须是 system/user/assistant，且正文不得为空）。" };
  }
  let contextTurnCount;
  if (preset.contextTurnCount !== undefined && preset.contextTurnCount !== null) {
    // 只收真数字：字符串伪数值（"3"）与布尔一律拒绝，口径同标定校验（绝不静默强转）
    const count = preset.contextTurnCount;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 10) {
      return { ok: false, error: "contextTurnCount 必须是 1–10 的整数。" };
    }
    contextTurnCount = count;
  }
  return { ok: true, preset: { name, segments, ...(contextTurnCount === undefined ? {} : { contextTurnCount }) } };
}

/** 导入重名消解：不动既有预设，追加「（导入）」序号。纯函数便于测试。 */
export function uniquePromptPresetName(name, existingNames) {
  const base = String(name ?? "").trim().slice(0, 64) || "导入的预设";
  const taken = new Set(
    (Array.isArray(existingNames) ? existingNames : []).map((item) => String(item ?? "").trim()),
  );
  if (!taken.has(base)) return base;
  const withSuffix = (suffix) => `${base.slice(0, 64 - suffix.length)}${suffix}`;
  let candidate = withSuffix("（导入）");
  let index = 2;
  while (taken.has(candidate)) {
    candidate = withSuffix(`（导入 ${String(index)}）`);
    index += 1;
  }
  return candidate;
}

/** Atlas 原生包或 shujuku 导出的预设数组。外部格式只取可编辑提示词字段。 */
export function parseAtlasPromptImport(raw) {
  const text = typeof raw === "string" ? raw : "";
  if (!text.trim()) return { ok: false, error: "文件为空。" };
  if (new TextEncoder().encode(text).byteLength > ATLAS_PROMPT_PACK_BYTES_MAX) {
    return { ok: false, error: "文件超过 512 KiB 上限。" };
  }
  let source;
  try { source = JSON.parse(text); }
  catch { return { ok: false, error: "不是合法 JSON。" }; }
  if (source?.protocol !== undefined) {
    const native = parseAtlasPromptPack(text);
    if (native.ok && (!Array.isArray(source.preset?.segments) || source.preset.segments.length > 16 || source.preset.segments.some((entry) =>
      !["system", "user", "assistant"].includes(String(entry?.role ?? "").trim().toLowerCase()) ||
      typeof entry?.content !== "string" || !entry.content.trim() || entry.content.length > 8000))) {
      return { ok: false, error: "Atlas 包含无效或超限条目，请修正后导入；每份最多 16 个条目，每条最多 8000 字。" };
    }
    return native.ok ? { ok: true, format: "Atlas", presets: [native.preset], warnings: [] } : native;
  }
  const candidates = Array.isArray(source) ? source : [source];
  if (candidates.length === 0 || candidates.length > 30) return { ok: false, error: "请选择包含 1–30 个预设的 JSON。" };
  const presets = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || typeof candidate.name !== "string" || !candidate.name.trim()) {
      return { ok: false, error: "外部预设需要 name 和 promptGroup 字段。" };
    }
    // 新版任务可有各自 promptGroup；不拼接不同任务，不执行任务链。
    const groups = Array.isArray(candidate.promptGroup) && candidate.promptGroup.length > 0
      ? [{ ...candidate, atlasImportName: candidate.name }]
      : Array.isArray(candidate.plotTasks)
        ? candidate.plotTasks.map((task) => ({ ...candidate, ...task, atlasImportName: `${candidate.name} / ${task?.name || "任务"}` }))
        : [];
    if (groups.length === 0) return { ok: false, error: `「${candidate.name}」没有 promptGroup 分段。` };
    for (const group of groups) {
      if (!Array.isArray(group.promptGroup) || !group.promptGroup.length || group.promptGroup.length > 16) {
        return { ok: false, error: "每份预设需要 1–16 个分段；请拆分过多的条目后导入。" };
      }
      const mapped = [];
      for (const entry of group.promptGroup) {
        const role = typeof entry?.role === "string" ? entry.role.trim().toLowerCase() : "";
        if (!["system", "user", "assistant"].includes(role) || typeof entry?.content !== "string" || !entry.content.trim()) {
          return { ok: false, error: `「${group.atlasImportName}」含无效分段：角色应为 system/user/assistant，正文不能为空。` };
        }
        if (entry.content.length > 8000) return { ok: false, error: "单个条目超过 8000 字，请拆分后导入。" };
        mapped.push({ ...entry, mainSlot: entry.mainSlot ?? (entry.isMain ? "A" : entry.isMain2 ? "B" : "") });
      }
      const count = group.contextTurnCount;
      if (count != null && (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 10)) {
        return { ok: false, error: "contextTurnCount 必须是 1–10 的整数。" };
      }
      presets.push({ name: group.atlasImportName.trim().slice(0, 64), segments: normalizePromptPackSegments(mapped),
        ...(count == null ? {} : { contextTurnCount: count }) });
      if (presets.length > 30) return { ok: false, error: "文件包含过多任务，请分别导入。" };
    }
  }
  return { ok: true, format: "shujuku", presets, warnings: [
    "仅导入分段角色、名称、正文、开关及上下文条数；任务链、召回规则、世界书选择与 API 设置不会迁入。",
    "外部提示词需改为 Atlas 的 <atlasEdit> 行增量输出。$5 在 Atlas 中表示世界状态；其他专用占位符请自行改写。保存并启用后可用最终请求预览核对装配。",
  ] };
}

/** 内置样例（M08 要求至少两个真实可导入样例）：深色战术风 / 浅色纸面风。 */
export const ATLAS_MAP_SKIN_PRESETS = [
  {
    kind: "atlas-map-skin",
    schemaVersion: 1,
    skinApiVersion: 1,
    id: "builtin.midnight-map",
    name: "夜色地图",
    version: "1.0.0",
    author: "Atlas 内置",
    baseTheme: "dark",
    tokens: {
      "colors.canvas": "#0d1017",
      "colors.gridMinor": "#202634",
      "colors.text": "#e6e8ee",
      "colors.textMuted": "#a5aec0",
      "colors.border": "#39445a",
      "colors.focusRing": "#92b5ff",
      "colors.location": "#5b8def",
      "colors.person": "#e8a757",
      "colors.item": "#b482c8",
      "colors.popoverBg": "#161a24",
      "colors.popoverHeaderBg": "#1d2230",
      "colors.rowHover": "#293248",
      "colors.buttonBg": "#1d2230",
      "colors.buttonText": "#e6e8ee",
      "colors.buttonHover": "#34415c",
      "colors.scaleText": "#e6e8ee",
      "colors.scaleBg": "#161a24",
      "colors.error": "#f08c8c",
      "colors.estimated": "#e8c27a",
      "metrics.popoverRadiusPx": 10,
      "metrics.controlRadiusPx": 6,
      "effects.shadow": "medium",
      "effects.motion": "subtle",
      "markers.locationShape": "rounded-square",
      "markers.itemShape": "diamond",
    },
  },
  {
    kind: "atlas-map-skin",
    schemaVersion: 1,
    skinApiVersion: 1,
    id: "builtin.parchment-map",
    name: "羊皮纸地图",
    version: "1.0.0",
    author: "Atlas 内置",
    baseTheme: "paper",
    tokens: {
      "colors.canvas": "#f6f0e0",
      "colors.gridMinor": "#e0d4b4",
      "colors.text": "#4a3d24",
      "colors.textMuted": "#8a7a55",
      "colors.border": "#c9b98a",
      "colors.focusRing": "#b8860b",
      "colors.location": "#fdfaf2",
      "colors.person": "#c9962a",
      "colors.item": "#8a5fa8",
      "colors.popoverBg": "#fffdf6",
      "colors.popoverHeaderBg": "#f3ecd8",
      "colors.rowHover": "#f0e8d0",
      "colors.scaleBg": "#fffdf6",
      "colors.scaleText": "#6b5a32",
      "colors.error": "#a83c3c",
      "colors.estimated": "#a8842c",
      "metrics.popoverRadiusPx": 4,
      "effects.shadow": "soft",
      "effects.motion": "subtle",
      "fonts.family": "serif",
      "markers.locationShape": "rounded-square",
      "markers.personShape": "circle",
    },
  },
];

const NPC_REASON_LABELS = {
  samePoint: "同地点",
  nearbyPoint: "附近地点",
  sameRegion: "同地区",
  route: "路线",
  schedule: "日程",
  relation: "关系",
  keyword: "关键词",
  random: "随机事件",
};

/**
 * D04：位置来源 → 用户可读标签（口径 = `AtlasCharacterRow.positionSource`）。
 * 「这条位置是怎么来的」是作者纠偏时最需要知道的一件事：正文观察 / 日程 / 程序模拟 / 你手动拖的。
 */
const POSITION_SOURCE_LABELS = {
  narrative: "正文观察",
  inferred: "剧情推测",
  simulation: "程序推演",
  manual: "作者手动",
  routine: "日程",
  unknown: "来源未知",
  /** H06：位置来自 SQL 世界库（`resolveEffectivePosition` 的解析结果）。 */
  sql: "SQL 世界库解析",
};

/**
 * H06/H07（§10.2）：位置质量 → 用户可读标签。
 *
 * 界面必须让作者一眼看出「这个点是量出来的还是估出来的」：
 * `exact` = 已确认；`approximate` = 合理近似（带范围）；`layout` = 排版示意（不是物理距离）；
 * `coarse` = 只知道在这个地点（不画点，进名单）。
 */
const SQL_POSITION_QUALITY_LABELS = {
  exact: "位置已确认",
  approximate: "位置为估计",
  layout: "仅为示意布局",
  coarse: "仅知所在地点",
  unknown: "位置未知",
};

/** H07：`queryNearby` 的 relevance → 用户可读标签（与 G02 的取值一一对应）。 */
const SQL_NEARBY_REASON_LABELS = {
  same_map: "同图相关者",
  same_location: "同地点",
  same_region: "同地区",
};

/**
 * D05：`tableMap.nearby` 的人物索引（键 = 去掉 `npc:` 前缀的实体 id）。
 *
 * `nearby` 是**全量人物表**（含远方，按"是否在身边"排序），所以除了建索引还要标出
 * `__isNear`：位置 = 当前地点，或当前地点的**子地点**（与 `projectTablesToMapView` 同一口径；
 * 根地点之间不算相邻——两座城相距几十格）。`__` 前缀字段只在 UI 内部用，不落任何数据。
 */
/** 回执状态 → 用户可读标签（与 core 的 AtlasTurnReceiptStatus 对齐）。 */
const STATUS_LABELS = {
  committed: "已提交",
  duplicate: "重复通知",
  "pending-review": "待审阅",
  failed: "失败",
};

/** 底图 dataURL 缓存（worldId → dataUrl | null），避免每次重绘重新拉取。 */
const mapImageCache = new Map();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 0.9.50（M05 动态比例尺条，纯函数，可测）：
 * 「1 格 = N 米」是地图数据（标定）；左下角标尺条是随相机变化的显示——
 * 两者关联但不互相修改。S = metersPerCell，P = 当前每格 CSS 像素（cellPx × zoom），
 * metersPerPixel = S / P；候选标尺距离 D 取 1、2、5 × 10^n 米，
 * 优先选使标尺条约 80-160 CSS 像素宽的 D（窗口内取最接近 120px 的候选；
 * 全部候选都在窗外时取与窗口最近的一条）；选定后按真实值绘制，
 * 不把条长硬截到像素值而保留原标签。
 */


/**
 * U03 返工：新工作台样式的生产加载入口——<link> 相对本模块 URL 注入一次。
 * data: URL（测试注入）等非层级地址解析失败时跳过：测试环境用源码/产物断言兜底，
 * 真实浏览器（http 服务形态）则必须实际加载（验收点：document.styleSheets 包含它）。
 */
function ensureWorkbenchStylesheet() {
  if (typeof document === "undefined" || document.getElementById("atlas-workbench-css")) return;
  let href = null;
  try {
    href = new URL("./ui/atlas-workbench.css", import.meta.url).href;
  } catch {
    return; // data: 等非层级模块地址：跳过，不抛错
  }
  if (!/^https?:|^file:|^\/|[a-zA-Z]:[\\/]/.test(String(href))) return;
  const link = document.createElement("link");
  link.id = "atlas-workbench-css";
  link.rel = "stylesheet";
  link.href = String(href);
  document.head.append(link);
}

function renderPanel(core, root, api, store, mod, skinPort = null) {
  return mountReferenceUi({root,core,api,getContext:()=>globalThis.SillyTavern?.getContext?.(),settingsPort:skinPort,lorePort:createReferenceLorePort(()=>globalThis.SillyTavern?.getContext?.(),loadStWorldInfo),
    diagnostics:()=>atlasDiagnostics?.getSnapshot?.()??pendingDiagnostics,emit:emitAtlasDiagnostic,defaultPrompt:mod.DEFAULT_WORLD_TURN_SYSTEM_PROMPT??''});
}

// ---------------------------------------------------------------------------
// 世界书写入端口（ATLAS-09）：酒馆 world-info 公开 API 适配。
// 契约（官方 release 源码逐行核实，行号见待办计划）：
//   loadWorldInfo(name) 深拷贝；createNewWorldInfo(name) 建书；
//   createWorldInfoEntry(_name, data) 同步、从模板取 uid 写回 data.entries；
//   saveWorldInfo(name, data, immediately) 内部自带 CSRF，缓存不深拷贝 →
//   保存后不得再改对象；deleteWorldInfoEntry(data, uid)。
// 聊天绑定槽 = chatMetadata.world_info（全世界只有一个）：只在为空时绑定，
// 绝不静默覆盖用户已绑定的世界书。
// ---------------------------------------------------------------------------

/**
 * 兼容性（参照 shujuku/SP·数据库 的 host-compat 层做法，2026-09-18）：
 * 世界书操作优先走 SillyTavern.getContext() 的**原生公开接口**
 * （1.13.x st-context.js 起暴露 loadWorldInfo / saveWorldInfo），
 * 完全不依赖酒馆源码的目录层级；只有原生接口缺失（旧版酒馆）才退回
 * 相对路径动态 import world-info.js。
 *
 * 原生模式下的缺位能力这样补（同样来自 shujuku 实测可用的做法）：
 * - createNewWorldInfo：context 不暴露 → 直接 POST /api/worldinfo/create
 *   （createNewWorldInfo 模块函数内部就是这一条，端点与载荷稳定）；
 * - createWorldInfoEntry：context 不暴露 → 按 world-info 条目模板自建
 *   （字段集与 ST 1.13 条目默认值对齐，缺失的新字段酒馆加载时会回填默认值）；
 * - deleteWorldInfoEntry：直接 delete data.entries[uid]。
 */

/** 判定 context 是否带原生世界书接口（loadWorldInfo + saveWorldInfo）。 */
export function hasNativeWorldInfoApi(context) {
  return Boolean(
    context &&
      typeof context.loadWorldInfo === "function" &&
      typeof context.saveWorldInfo === "function"
  );
}

/** world-info 条目默认模板（与 SillyTavern 1.13 条目默认值对齐）。 */
export function nativeWorldInfoEntryDefaults() {
  return {
    key: [],
    keysecondary: [],
    comment: "",
    content: "",
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: true,
    order: 100,
    position: 0,
    disable: false,
    excludeRecursion: false,
    preventRecursion: false,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    delayUntilRecursion: 0,
    probability: 100,
    useProbability: true,
    depth: 4,
    group: "",
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: "",
    role: 0,
    sticky: null,
    cooldown: null,
    delay: null,
  };
}

/**
 * 用 getContext() 的原生接口拼出与 world-info.js 模块同形的世界书模块。
 * 每个方法内部都重新 getContext()，不缓存任何聊天 / 设置快照。
 * @param {() => object} getContext
 */
export function createNativeWorldInfoModule(getContext) {
  const ctx = () => {
    try {
      return getContext() ?? null;
    } catch {
      return null;
    }
  };
  return {
    native: true,
    async loadWorldInfo(name) {
      const c = ctx();
      if (!c || typeof c.loadWorldInfo !== "function") {
        throw new Error("SillyTavern loadWorldInfo 接口不可用");
      }
      return c.loadWorldInfo(name);
    },
    async saveWorldInfo(name, data, immediately) {
      const c = ctx();
      if (!c || typeof c.saveWorldInfo !== "function") {
        throw new Error("SillyTavern saveWorldInfo 接口不可用");
      }
      return c.saveWorldInfo(name, data, immediately !== false);
    },
    async createNewWorldInfo(name) {
      const c = ctx();
      const headers =
        c && typeof c.getRequestHeaders === "function"
          ? c.getRequestHeaders()
          : {};
      const response = await fetch("/api/worldinfo/create", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        throw new Error(`世界书创建失败（HTTP ${response.status}）`);
      }
    },
    createWorldInfoEntry(_name, data) {
      if (!data || typeof data !== "object" || !data.entries) return null;
      let maxUid = -1;
      for (const key of Object.keys(data.entries)) {
        const uid = Number(key);
        if (Number.isInteger(uid) && uid > maxUid) maxUid = uid;
      }
      const uid = maxUid + 1;
      const entry = { ...nativeWorldInfoEntryDefaults(), uid };
      data.entries[String(uid)] = entry;
      return entry;
    },
    deleteWorldInfoEntry(data, uid) {
      if (data && data.entries && Object.prototype.hasOwnProperty.call(data.entries, String(uid))) {
        delete data.entries[String(uid)];
      }
    },
  };
}

async function loadStWorldInfo() {
  // 预览夹具 / 测试可注入 window.__atlasWorldInfoModule（最高优先）。
  if (typeof window !== "undefined" && window.__atlasWorldInfoModule) {
    return window.__atlasWorldInfoModule;
  }
  // 首选：getContext() 原生公开接口（1.13+），与酒馆目录结构完全解耦。
  if (typeof SillyTavern !== "undefined") {
    try {
      const context = SillyTavern.getContext();
      if (hasNativeWorldInfoApi(context)) {
        return createNativeWorldInfoModule(() => SillyTavern.getContext());
      }
    } catch {
      /* getContext 还没就绪 → 落到 import 回退 */
    }
  }
  // 回退：相对路径动态 import（旧版酒馆；路径随安装挂载点，两条深度都试）。
  let lastError = null;
  for (const path of ["../../../world-info.js", "../../world-info.js"]) {
    try {
      return await import(/* @vite-ignore */ path);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("world-info module unavailable");
}

/** 把酒馆 world-info 公开 API 适配成 AtlasLorebookPort（导出供测试与预览复用）。 */
export function createLorebookPort(context, worldInfo, readScopeBinding = null) {
  return {
    async loadBook(name) {
      try {
        const data = await worldInfo.loadWorldInfo(name);
        return data ?? null;
      } catch {
        return null; // 不存在 / 加载失败 → 视为缺失（writer 会再走 createBook）
      }
    },
    async createBook(name) {
      await worldInfo.createNewWorldInfo(name);
    },
    async saveBook(name, data) {
      await worldInfo.saveWorldInfo(name, data, true);
    },
    /**
     * B05 适配点①：按**当前聊天**推导世界书作用域（chatId + worldId）。
     *
     * 这一段是模块文档里写明的适配语义，照抄不改口径：
     * - `chatId` 取 `context().chatId`；为空 → null；
     * - `worldId` 取**当前聊天绑定的世界**（`readScopeBinding` 迟读，避免与初始化顺序耦合）；
     * - 两个都拿不到 → null，writer 回退 0.9.58 旧行为——**绝不拿半个身份硬凑作用域**，
     *   因为凑错作用域比不隔离更糟（会把 A 聊天的动向写进 B 聊天专属书）。
     *
     * 接上之后：同一张角色卡的每个聊天各写各的专属世界书；共享主卡书只读只清。
     */
    /**
     * B05 适配点①：按**当前聊天**推导世界书作用域（chatId + worldId）。
     *
     * 这一段是模块文档里写明的适配语义，照抄不改口径：
     * - `chatId` 取 `context().chatId`；为空 → null；
     * - `worldId` 取**当前聊天绑定的世界**（`readScopeBinding` 迟读，避免与初始化顺序耦合）；
     * - 两个都拿不到 → null，writer 回退 0.9.58 旧行为——**绝不拿半个身份硬凑作用域**，
     *   因为凑错作用域比不隔离更糟（会把 A 聊天的动向写进 B 聊天专属书）。
     *
     * 接上之后：同一张角色卡的每个聊天各写各的专属世界书；共享主卡书只读只清。
     */
    async resolveChatScope() {
      try {
        const ctx = context();
        const chatId = typeof ctx?.chatId === "string" ? ctx.chatId.trim() : "";
        if (!chatId) return null;
        const binding = readScopeBinding ? await readScopeBinding() : null;
        const worldId = String(binding?.worldId ?? "").trim();
        if (!worldId) return null;
        return { chatId, worldId };
      } catch {
        return null;
      }
    },
    /**
     * B05 适配点②（**首选通道**）：把动态会话内容注入**当前聊天**的一轮上下文。
     *
     * 为什么这是首选：`setExtensionPrompt` 是「这一轮的临时上下文」，只对当前聊天生效，
     * 天然不跨聊天，也不占用世界书绑定槽。专属世界书是它的**回退**（注入不可用时）。
     *
     * 纪律：
     * - 酒馆没提供 `setExtensionPrompt` → **必须 throw**（不能静默 return），
     *   否则 writer 会以为注入成功而既不写专属书也不报错，动态内容等于凭空消失；
     * - 档位与 `installGenerateInterceptor` 一致（IN_CHAT、深度 4），避免同一段内容
     *   在两个注入点出现不同的可见性；
     * - 清空传空串（酒馆语义即清除该 key 的注入）。
     */
    async injectTurn(key, value) {
      const ctx = context();
      if (typeof ctx?.setExtensionPrompt !== "function") {
        throw new Error("setExtensionPrompt unavailable");
      }
      ctx.setExtensionPrompt(String(key), String(value ?? ""), 2, 4);
      if (value) atlasSceneInjectionKeys.add(String(key)); else atlasSceneInjectionKeys.delete(String(key));
    },
    createEntry(data, patch) {
      const entry = worldInfo.createWorldInfoEntry("Atlas", data);
      if (!entry) return null;
      entry.key = [...patch.keys];
      entry.keysecondary = [];
      entry.comment = patch.comment;
      entry.content = patch.content;
      entry.disable = false;
      // 0.9.35 常驻聚合条目字段（照 shujuku TavernDB-ACU-ReadableDataTable）：
      // constant 蓝灯 + 高 order + 角色定义前（position 0）+ 防递归；滚动条目走缺省（false）
      entry.constant = patch.constant === true;
      if (typeof patch.order === "number") entry.order = patch.order;
      if (typeof patch.position === "number") entry.position = patch.position;
      entry.prevent_recursion = patch.preventRecursion === true;
      entry.selective = true;
      return entry;
    },
    deleteEntry(data, uid) {
      worldInfo.deleteWorldInfoEntry(data, uid);
    },
    // 作者 2026-09-18 拍板（参照 shujuku 角色卡世界书方式）：条目优先写入
    // 当前角色卡的主世界书（data.extensions.world 指向的具名书，随角色激活，
    // 不占聊天绑定槽）；解析不到（无卡书 / 角色不可用）→ null 回退专属书。
    async resolvePreferredBook() {
      try {
        const ctx = context();
        const character = ctx?.characters?.[ctx?.characterId] ?? null;
        const name = character?.data?.extensions?.world;
        return typeof name === "string" && name.trim().length > 0 ? name : null;
      } catch {
        return null;
      }
    },
    async getChatBookName() {
      const metadata = context().chatMetadata;
      const name = metadata?.world_info;
      return typeof name === "string" && name.trim().length > 0 ? name : null;
    },
    async bindChatBook(name) {
      const ctx = context();
      if (!ctx.chatMetadata) return;
      ctx.chatMetadata.world_info = name;
      if (typeof ctx.saveMetadata === "function") await ctx.saveMetadata();
    },
  };
}

/**
 * 连接真实 SillyTavern（由 activate 钩子调用）。
 *
 * 幂等且并发安全：模块自初始化（`void connectAtlas()`）与 manifest 的 hooks.activate
 * 会在同一时刻各触发一次，若不共享在途 Promise，两次调用都会看到 connected 为空，
 * 于是重复挂载面板、重复注册监听。用 connecting 记住在途 Promise，两边拿到同一实例。
 * @returns {Promise<{ core: object, rerender: () => void } | null>}
 */
export async function connectAtlas() {
  if (connected) return connected;
  if (connecting) return connecting;
  if (typeof SillyTavern === "undefined" || typeof document === "undefined") return null;
  connecting = connectOnce();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

/**
 * ATLAS-18 首条消息自动建世（唯一流程）：
 * - **确定性 world ID**：starterWorldIdForChat(chatId)（同聊天永远同 ID，替换旧的 `world-${Date.now()}`）；
 * - **并发闸门**：同聊天重复 MESSAGE_SENT 复用同一在途 Promise（不靠按钮 disabled）；
 * - **幂等写入**：POST /worlds/ensure-starter——已存在则 created:false 且绝不覆盖；
 * - **切聊天保护**：ensure 完成后若用户已切走，不把旧聊天世界绑到新聊天；
 * - 失败只记控制台，绝不阻断酒馆生成。
 */
const ensureWorldInFlight = new Map();

/**
 * 模块级运行期引用：ensureStarterWorld 是模块级函数，不能闭包 connectOnce 的局部变量
 * （否则 ReferenceError 被 catch 吞掉 → 自动建世永远静默失败）。disconnect 时清空。
 */
const atlasRuntime = { mod: null, api: null, core: null, engineStore: null };

function resolveCharacterCard(context) {
  const ctx = context();
  const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
  const rawId = ctx.characterId;

  // 来源 1：characters[characterId]（数值索引，或可转为有效索引的字符串）
  if (typeof rawId === "number" && Number.isInteger(rawId) && characters[rawId]) {
    return characters[rawId];
  }
  if (typeof rawId === "string" && /^\d+$/.test(rawId)) {
    const index = Number(rawId);
    if (Number.isInteger(index) && characters[index]) return characters[index];
  }
  // 来源 2：按 avatar / id 匹配字符串 characterId
  if (typeof rawId === "string" && rawId) {
    const byAvatar = characters.find((c) => c && (c.avatar === rawId || c.id === rawId));
    if (byAvatar) return byAvatar;
  }
  // 来源 3：name2 / 聊天内可读名 作为名称回退
  const readable = typeof ctx.name2 === "string" && ctx.name2.trim()
    ? ctx.name2.trim()
    : typeof ctx.characterName === "string" && ctx.characterName.trim()
      ? ctx.characterName.trim()
      : null;
  if (readable) {
    const byName = characters.find((c) => c && (c.name === readable || c.name2 === readable));
    if (byName) return byName;
  }
  // 来源 4：无角色卡 / 群聊 → null（调用方回退「新世界」）
  return null;
}

async function ensureStarterWorld() {
  if (typeof SillyTavern === "undefined") return false;
  const context = () => SillyTavern.getContext();
  const chatId = typeof context().chatId === "string" && context().chatId ? context().chatId : "";
  if (!chatId) return false;
  const existing = ensureWorldInFlight.get(chatId);
  if (existing) return existing;

  const task = (async () => {
    try {
      const ctx = context();
      const card = resolveCharacterCard(context);
      const cardName = (typeof card?.name === "string" && card.name.trim())
        || (typeof ctx.name2 === "string" && ctx.name2.trim())
        || (typeof ctx.characterName === "string" && ctx.characterName.trim())
        || null;
      const description = typeof card?.description === "string" ? card.description : "";
      const playerName = typeof ctx.name1 === "string" ? ctx.name1.trim() : "";
      const playerDescription = String(ctx?.powerUserSettings?.persona_description || ctx?.persona_description || "");
      const { mod, api, core } = atlasRuntime;
      if (!mod || !api) return false;
      const world = mod.buildStarterWorld({
        id: mod.starterWorldIdForChat(chatId),
        now: Date.now(),
        name: cardName,
        description,
        playerName,
        playerDescription,
      });
      const result = await api.request("POST", "/worlds/ensure-starter", { world });
      if (result.status !== 200 || !result.body?.ok) {
        emitAtlasDiagnostic({ level: "error", source: "engine", code: "WORLD_ENSURE_FAILED",
          operation: "world", phase: "response", outcome: "failed",
          httpStatus: result.status, errorCode: result.body?.error?.code, retryable: true });
        console.warn("[atlas] 自动建世被拒绝：", result.body?.error?.message ?? `HTTP ${result.status}`);
        return false;
      }
      // 切聊天保护：ensure 期间用户已经切走 → 不绑定新聊天（回到原聊天时同 ID 复用已建世界）
      const nowChatId = typeof context().chatId === "string" ? context().chatId : "";
      if (nowChatId !== chatId) return false;
      if (!core) return false;
      await core.bindToWorld(String(world.id));
      // 仅新建世界自动导入卡书地理；旧世界可在地图页手动补导。
      if (result.body?.data?.created === true && core.getState().binding) {
        void importWorldbookGeography(chatId, String(world.id)).catch((error) => {
          emitAtlasDiagnostic({ level: "warn", source: "map", code: "GEO_ADOPT_FAILED",
            operation: "geo", phase: "request", outcome: "failed",
            details: { reasonCode: error instanceof Error ? error.name : "UNKNOWN" } });
        });
      }
      return Boolean(core.getState().binding);
    } catch (error) {
      emitAtlasDiagnostic({ level: "error", source: "engine", code: "WORLD_ENSURE_FAILED",
        operation: "world", phase: "request", outcome: "failed", retryable: true });
      console.warn("[atlas] 自动建世失败（聊天不受影响）：", error instanceof Error ? error.message : String(error));
      return false;
    }
  })();
  ensureWorldInFlight.set(chatId, task);
  try {
    return await task;
  } finally {
    ensureWorldInFlight.delete(chatId);
  }
}

// ---------------------------------------------------------------------------
// 0.9.21 世界书资料块（抄 shujuku 读卡书思路，走 ST 原生 world-info API）：
// 自动建世只读卡名+描述，推演 AI 长期「瞎着」推世界——本块把当前角色卡世界书
// 的启用条目变成有界文本，随 commit 请求喂给推演模型（只进推演，不进主聊天注入）。
// ---------------------------------------------------------------------------

const LORE_SUPPLEMENT_LIMITS = {
  /** 单条目正文截断 */
  ENTRY_CONTENT_CHARS: 400,
  /** 条目数上限（按书内顺序取前 N 条启用的） */
  ENTRIES_MAX: 60,
  /** 总字符上限（与引擎 ATLAS_LIMITS.LORE_SUPPLEMENT_CHARS 同口径，双保险） */
  TOTAL_CHARS: 6000,
};

/** 宿主在本轮生成时公布的绿灯 ID；仅保留身份，不缓存条目正文。 */
let hostLoreActivation = null;
let hostLoreActivationApiAvailable = false;

export function recordAtlasHostLoreActivation(entries, ctx) {
  const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
  let userIndex = -1;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i]?.is_user === true) { userIndex = i; break; }
  }
  if (userIndex < 0 || !ctx?.chatId || !Array.isArray(entries)) return;
  const ids = new Set();
  for (const entry of entries) {
    if (typeof entry?.world !== "string") continue;
    if (typeof entry?.uid !== "string" && typeof entry?.uid !== "number") continue;
    ids.add(`${entry.world}:${entry.uid}`);
  }
  hostLoreActivation = {
    chatId: String(ctx.chatId), characterId: ctx.characterId ?? null,
    userMessageId: String(userIndex), userMessageRef: chat[userIndex],
    ids, consumed: false,
  };
  emitAtlasDiagnostic({ level: "info", source: "lorebook",
    code: "LORE_HOST_ACTIVATION_CAPTURED", operation: "lore-context",
    phase: "select", outcome: "success", details: { count: ids.size } });
}

/** 地理建图读取完整启用条目，不受普通回合的激活/6000 字注入预算限制。 */
export function buildAtlasGeoLoreChunks(entries, maxChars = 5500, maxChunks = 32) {
  const geographic = /地图|地理|地点|地区|区域|领域|城镇|城市|关隘|道路|街道|聚落|场所|大陆|国家|地形|风土|学校|建筑|房间|遗迹|森林|村|镇/;
  const rows = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && entry.enabled !== false && typeof entry.content === "string" && entry.content.trim())
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => Number(geographic.test(String(b.title ?? ""))) - Number(geographic.test(String(a.title ?? ""))) || a.index - b.index);
  const chunks = [];
  let chunk = "";
  for (const row of rows) {
    const prefix = `- [${String(row.bookName ?? "世界书")}] ${String(row.title ?? "条目")}：`;
    const partChars = maxChars - prefix.length;
    if (partChars <= 0) { chunks.truncated = true; continue; }
    for (let offset = 0; offset < row.content.length; offset += partChars) {
      const line = prefix + row.content.slice(offset, offset + partChars);
      if (chunk && chunk.length + line.length + 1 > maxChars) {
        chunks.push(chunk);
        if (chunks.length >= maxChunks) {
          chunks.truncated = true;
          return chunks;
        }
        chunk = "";
      }
      chunk += `${chunk ? "\n" : ""}${line}`;
    }
  }
  if (chunk && chunks.length < maxChunks) chunks.push(chunk);
  chunks.truncated ??= false;
  return chunks;
}

async function readCardGeoLoreChunks(chatId) {
  const ctx = SillyTavern.getContext();
  if (String(ctx?.chatId ?? "") !== chatId) return [];
  const character = ctx?.characters?.[ctx?.characterId] ?? null;
  const characterId = ctx?.characterId ?? null;
  const bookNames = [];
  const addBook = (raw) => {
    const name = typeof raw === "string" ? raw.trim() : typeof raw?.name === "string" ? raw.name.trim() : "";
    if (name && !bookNames.includes(name)) bookNames.push(name);
  };
  try {
    const th = globalThis.TavernHelper ?? globalThis.getTavernHelper?.() ?? null;
    const bound = await th?.getCharWorldbookNames?.("current");
    if (Array.isArray(bound)) bound.forEach(addBook);
    else if (bound && typeof bound === "object") {
      addBook(bound.primary);
      if (Array.isArray(bound.additional)) bound.additional.forEach(addBook);
    } else addBook(bound);
  } catch { /* 宿主助手不可用时仍读卡书与聊天书 */ }
  addBook(character?.data?.extensions?.world);
  addBook(ctx?.chatMetadata?.world_info);
  const worldInfo = await loadStWorldInfo();
  const prefixes = Object.values(atlasRuntime.mod?.ATLAS_LOREBOOK_PREFIX ?? { a: "Atlas 动向 ·", b: "Atlas 事件 ·" });
  const entries = [];
  for (const bookName of bookNames) {
    let book;
    try { book = await worldInfo.loadWorldInfo(bookName); } catch { continue; }
    for (const entry of Object.values(book?.entries ?? {})) {
      if (!entry || typeof entry !== "object" || entry.disable === true || !String(entry.content ?? "").trim()) continue;
      const title = String(entry.comment ?? entry.key?.[0] ?? "条目");
      if (prefixes.some((prefix) => title.startsWith(String(prefix)))) continue;
      entries.push({ bookName, title, content: entry.content, enabled: true });
    }
  }
  const live = SillyTavern.getContext();
  if (String(live?.chatId ?? "") !== chatId || (live?.characterId ?? null) !== characterId
    || live?.chatMetadata !== ctx?.chatMetadata) return [];
  return buildAtlasGeoLoreChunks(entries);
}

const geoImportInFlight = new Map();
async function importWorldbookGeography(chatId, worldId, onProgress = null, providedChunks = null) {
  if (geoImportInFlight.has(chatId)) return geoImportInFlight.get(chatId);
  const task = (async () => {
    const chunks = providedChunks ?? await readCardGeoLoreChunks(chatId);
    const sqlMode = () => SillyTavern.getContext()?.extensionSettings?.[ATLAS_SETTINGS_KEY]?.[ATLAS_SQL_MODE_SETTING] === true;
    // 真实宿主身份：每个 await 之后都要复核（新聊天切换必须取消剩余任务）。
    const characterId = SillyTavern.getContext()?.characterId ?? null;
    const identityHeld = () => {
      const live = SillyTavern.getContext();
      return String(live?.chatId ?? "") === chatId
        && (live?.characterId ?? null) === characterId
        && String(atlasRuntime.core?.getState()?.binding?.worldId ?? "") === worldId;
    };
    let regionsAdded = 0;
    let pointsAdded = 0;
    let completed = 0;
    let capacityReached = false;
    let failure = "";
    let buildStatus = "skipped";
    let chunkCursor = 0;
    for (const loreSupplement of chunks) {
      if (!identityHeld()) break;
      const requestId = `geo_${chatId}_${chunkCursor}`;
      chunkCursor += 1;
      const result = await atlasRuntime.api.request("POST", (sqlMode() ? "/sql/chat/map/build" : "/worlds/geo/adopt"), (sqlMode()
        // M3-15：SQL 路径每个分块都是 extract-only —— 只登记事实，不发总体空间请求。
        ? { chatId, requestId, mode: "bootstrap", constructionMode: "extract-only", focusLocationIds: [], loreSupplement }
        : { chatId, loreSupplement }));
      if (result.status !== 200 || result.body?.ok !== true) {
        failure = String(result.body?.error?.message ?? `HTTP ${result.status}`).slice(0, 160);
        emitAtlasDiagnostic({ level: "warn", source: "map", code: "GEO_ADOPT_FAILED",
          operation: "geo", phase: "response", outcome: "failed", httpStatus: result.status });
        break;
      }
      completed += 1;
      regionsAdded += Number(result.body.data?.regionsAdded ?? 0);
      pointsAdded += Number(result.body.data?.pointsAdded ?? 0);
      onProgress?.({ completed, total: chunks.length, regionsAdded, pointsAdded });
      if (identityHeld()) await atlasRuntime.core?.refresh();
      if (result.body.data?.capacityReached === true) {
        capacityReached = true;
        break;
      }
    }
    // 抽取全部结束之后只发**一次** map/build（bootstrap + 完整相关来源快照）；
    // 绝不每个 chunk 都重复扩建。抽取失败时明确 skipped，不假装已建。
    if (sqlMode() && !failure && !capacityReached && completed > 0 && completed === chunks.length && identityHeld()) {
      const build = await atlasRuntime.api.request("POST", "/sql/chat/map/build", {
        chatId, requestId: `build_${chatId}`, mode: "bootstrap", focusLocationIds: [],
        loreSupplement: chunks.map((chunk) => String(chunk ?? "")).join("\n\n"),
      });
      if (build.status === 200 && build.body?.ok === true) {
        buildStatus = String(build.body.data?.build?.status ?? "committed");
      } else {
        buildStatus = "failed";
        emitAtlasDiagnostic({ level: "warn", source: "map", code: "WORLD_BUILD_FAILED",
          operation: "build", phase: "response", outcome: "failed", httpStatus: build.status });
      }
      if (identityHeld()) await atlasRuntime.core?.refresh();
    }
    return { completed, total: chunks.length, regionsAdded, pointsAdded,
      truncated: chunks.truncated === true, capacityReached, failure, buildStatus };
  })();
  geoImportInFlight.set(chatId, task);
  try { return await task; } finally { geoImportInFlight.delete(chatId); }
}

/** 从当前绑定书中按本次请求的正文选取资料；宿主未提供可靠激活清单时只报告 context-fallback。 */
export async function readCardLoreSupplementViaSelector(selectionContext, selectorOverride = null, emit = emitAtlasDiagnostic) {
  try {
    if (typeof SillyTavern === "undefined") return "";
    const ctx = SillyTavern.getContext();
    const character = ctx?.characters?.[ctx?.characterId] ?? null;
    const chatId = String(ctx?.chatId ?? "");
    const characterId = ctx?.characterId ?? null;
    if (chatId !== selectionContext?.chatId) return "";
    if (selectionContext.characterId !== null && selectionContext.characterId !== characterId) return "";
    const characterBook = character?.data?.extensions?.world ?? null;
    const chatBook = ctx?.chatMetadata?.world_info ?? null;
    const branchId = ctx?.chatMetadata?.atlas?.binding?.branchId ?? null;
    const isCurrent = () => {
      const live = SillyTavern.getContext();
      return String(live?.chatId ?? "") === chatId && (live?.characterId ?? null) === characterId
        && live?.chatMetadata === ctx?.chatMetadata
        && (live?.characters?.[live?.characterId]?.data?.extensions?.world ?? null) === characterBook
        && (live?.chatMetadata?.world_info ?? null) === chatBook
        && (live?.chatMetadata?.atlas?.binding?.branchId ?? null) === branchId;
    };
    const dropStale = () => {
      emit({ level: "info", source: "lorebook", code: "LORE_STALE_CONTEXT_DROPPED",
        operation: "lore-context", phase: "read", outcome: "skipped" });
      return "";
    };

    // 1) 收集候选书名
    const bookNames = [];
    const pushBook = (value) => {
      const name = typeof value === "string" ? value.trim() : "";
      if (name && !bookNames.includes(name)) bookNames.push(name);
    };
    try {
      const th = globalThis.TavernHelper ?? globalThis.getTavernHelper?.() ?? null;
      if (th && typeof th.getCharWorldbookNames === "function") {
        const bound = await th.getCharWorldbookNames("current");
        if (Array.isArray(bound)) {
          for (const item of bound) pushBook(typeof item === "string" ? item : item?.name);
        } else if (bound && typeof bound === "object") {
          pushBook(bound.primary);
          if (Array.isArray(bound.additional)) {
            for (const item of bound.additional) pushBook(typeof item === "string" ? item : item?.name);
          }
        } else {
          pushBook(bound);
        }
      }
    } catch { /* 兜底 */ }
    if (!isCurrent()) return dropStale();
    pushBook(character?.data?.extensions?.world);
    pushBook(ctx?.chatMetadata?.world_info);
    if (bookNames.length === 0) return "";

    // A07：本请求内对同一本书的重复读取共用 Promise(下文 inFlightByBook)
    const inFlightByBook = new Map();

    // 3) 读入所有书的所有条目
    const worldInfo = await loadStWorldInfo();
    const prefixList = atlasRuntime.mod?.ATLAS_LOREBOOK_PREFIX;
    const atlasPrefixes = prefixList && typeof prefixList === "object"
      ? Object.values(prefixList)
      : ["Atlas 动向 ·", "Atlas 事件 ·"];
    const allEntries = [];
    let failedBooks = 0;
    for (const bookName of bookNames) {
      let rawEntries = [];
      try {
        // A07：同一本书的 in-flight Promise 复用(本请求内)
        let dataPromise = inFlightByBook.get(bookName);
        if (!dataPromise) {
          dataPromise = (async () => worldInfo.loadWorldInfo(bookName))();
          inFlightByBook.set(bookName, dataPromise);
        }
        const data = await dataPromise;
        rawEntries = data && typeof data === "object" && data.entries && typeof data.entries === "object"
          ? Object.values(data.entries)
          : [];
      } catch {
        failedBooks += 1;
        continue;
      }
      for (const entry of rawEntries) {
        if (!entry || typeof entry !== "object") continue;
        const content = typeof entry.content === "string" ? entry.content : "";
        if (!content.trim()) continue;
        const comment = typeof entry.comment === "string" ? entry.comment.trim() : "";
        if (atlasPrefixes.some((prefix) => comment.startsWith(prefix))) continue;
        const keys = Array.isArray(entry.key) ? entry.key.filter((k) => typeof k === "string" && k.trim()) : [];
        const title = comment || (keys.length > 0 ? keys.slice(0, 4).join(" / ") : "条目");
        allEntries.push({
          uid: typeof entry.uid === "string" || typeof entry.uid === "number" ? String(entry.uid)
            : (typeof entry.id === "string" || typeof entry.id === "number" ? String(entry.id) : ""),
          title,
          bookName,
          content,
          enabled: entry.disable !== true,
          keys,
        });
      }
    }
    if (!isCurrent()) return dropStale();

    // 4) 调用 P2-01 纯函数排序 + 截断
    const sel = selectorOverride ?? atlasRuntime.mod?.selectAtlasLoreSupplement;
    if (typeof sel !== "function") {
      // 模块未加载或旧版本不支持,明确发 LORE_SELECTOR_UNAVAILABLE(A04)
      emit({ level: "warn", source: "lorebook",
        code: "LORE_SELECTOR_UNAVAILABLE", operation: "lore-context",
        phase: "select", outcome: "skipped",
        details: { reason: "selector_undefined" } });
      return "";
    }
    const sceneKeywords = extractSceneKeywords(selectionContext, allEntries);
    const lastUserIndex = Array.isArray(ctx?.chat) ? ctx.chat.findLastIndex((message) => message?.is_user === true) : -1;
    const activationMismatch = !hostLoreActivation ? "NO_HOST_RECORD"
      : hostLoreActivation.consumed ? "ALREADY_CONSUMED"
      : hostLoreActivation.chatId !== chatId ? "CHAT_MISMATCH"
      : hostLoreActivation.characterId !== characterId ? "CHARACTER_MISMATCH"
      : hostLoreActivation.userMessageId !== String(lastUserIndex) ? "USER_INDEX_MISMATCH"
      : hostLoreActivation.userMessageRef !== ctx?.chat?.[lastUserIndex] ? "USER_FLOOR_REPLACED"
      : "NONE";
    const activation = selectionContext.mode === "turn" && hostLoreActivation
      && !hostLoreActivation.consumed
      && hostLoreActivation.chatId === chatId
      && hostLoreActivation.characterId === characterId
      && hostLoreActivation.userMessageId === String(lastUserIndex)
      // ST may transform the same floor's text between activation and commit.
      // Object identity ties the activation to this host floor without using mutable text.
      && hostLoreActivation.userMessageRef === ctx?.chat?.[lastUserIndex]
      ? hostLoreActivation : null;
    const activationMode = "all-enabled";
    if (activation) activation.consumed = true;
    else emit({ level: "info", source: "lorebook",
      code: hostLoreActivationApiAvailable ? "LORE_ACTIVATION_FALLBACK" : "LORE_ACTIVATION_UNAVAILABLE",
      operation: "lore-context", phase: "select", outcome: "success",
      details: { reason: hostLoreActivationApiAvailable ? "no_matching_turn_event" : "host_api_unavailable",
        reasonCode: activationMismatch, mode: selectionContext.mode } });
    const result = sel({
      entries: allEntries,
      ...(activation ? { activatedUids: activation.ids } : {}),
      chatKeywords: sceneKeywords,
      sceneKeywords: sceneKeywords,
      mode: selectionContext.mode,
      includeAllEnabled: true,
      prioritizeGeography: true,
      maxChars: LORE_SUPPLEMENT_LIMITS.TOTAL_CHARS,
    });
    if (failedBooks > 0) {
      emit({ level: "warn", source: "lorebook",
        code: "LORE_CONTEXT_UNAVAILABLE", operation: "lore-context",
        phase: "read", outcome: "failed", details: { count: failedBooks, sourceMode: result.sourceMode } });
    }
    emit({ level: "info", source: "lorebook",
      code: "LORE_SELECTION_COMPLETE", operation: "lore-context",
      phase: "select", outcome: "success", details: {
        candidateCount: result.candidateCount,
        selectedCount: result.selectedUids.length,
        truncatedCount: result.truncatedCount,
        outputChars: result.selectedOutputChars,
        sourceMode: result.sourceMode,
        mode: selectionContext.mode,
        activationMode,
      } });
    return result.text;
  } catch {
    emit({ level: "warn", source: "lorebook",
      code: "LORE_CONTEXT_UNAVAILABLE", operation: "lore-context",
      phase: "read", outcome: "failed" });
    return "";
  }
}

/** 只从本次有效正文命中候选条目的明示词，不拿旧聊天尾部猜当前场景。 */
function extractSceneKeywords(selectionContext, entries) {
  const out = new Set();
  const text = [selectionContext.userText, selectionContext.assistantText,
    ...(selectionContext.recentAssistantTexts ?? [])].filter((part) => typeof part === "string").join("\n");
  for (const entry of entries) {
    for (const word of [...(entry.keys ?? []), entry.title]) {
      if (typeof word === "string" && word.length >= 2 && word.length <= 40 && text.includes(word)) out.add(word);
    }
  }
  return out;
}

function currentLoreSelectionContext(mode, assistantText = "") {
  const ctx = SillyTavern.getContext();
  const recentAssistantTexts = (Array.isArray(ctx?.chat) ? ctx.chat : [])
    .filter((message) => message?.is_user === false && typeof message?.mes === "string" && message.mes.trim())
    .slice(-10).map((message) => message.mes);
  return { chatId: String(ctx?.chatId ?? ""), characterId: ctx?.characterId ?? null,
    mode, userText: "", assistantText, recentAssistantTexts };
}

async function connectOnce() {
  const hostCleanups=[];
  try {
    const mod = await loadUiCore();
    let diagnosticStorage = null;
    let diagnosticArchive = null;
    let archiveEnabled = false;
    try { diagnosticStorage = globalThis.sessionStorage; } catch { /* private mode */ }
    try {
      diagnosticArchive = globalThis.localStorage;
      archiveEnabled = diagnosticArchive?.getItem("atlas:safe-diagnostics-archive-enabled:v1") === "true";
    } catch { /* private mode */ }
    atlasDiagnostics = mod.createAtlasDiagnosticsSink({
      persist: diagnosticStorage, archive: diagnosticArchive, archiveEnabled,
    });
    for (const event of pendingDiagnostics) atlasDiagnostics.emit(event);
    pendingDiagnostics.length = 0;

    /** 模型请求日志包装：记录每条推演 HTTP 的状态 / 耗时 / 响应片段（脱敏）。 */
    const loggingModelFetch = async (input, init) => {
      const startedAt = Date.now();
      try {
        const response = await globalThis.fetch(input, init);
        emitAtlasDiagnostic({
          level: response.ok ? "info" : "error", source: "model",
          code: response.ok ? "MODEL_HTTP_COMPLETE" : "MODEL_HTTP_FAILED",
          operation: "generation", phase: "response",
          outcome: response.ok ? "success" : "failed",
          httpStatus: response.status, durationMs: Date.now() - startedAt,
          details: { route: "model-proxy", mode: "custom" },
        });
        return response;
      } catch (error) {
        emitAtlasDiagnostic({
          level: "error", source: "model", code: "MODEL_NETWORK_FAILED",
          operation: "generation", phase: "request", outcome: "failed",
          durationMs: Date.now() - startedAt, retryable: true,
          details: { route: "model-proxy", mode: "custom" },
        });
        throw error;
      }
    };

    const context = () => SillyTavern.getContext();
    const initialSettings = context()?.extensionSettings;
    if (initialSettings) {
      initialSettings[ATLAS_SETTINGS_KEY] ??= {};
      if (typeof initialSettings[ATLAS_SETTINGS_KEY][ATLAS_SQL_MODE_SETTING] !== "boolean") initialSettings[ATLAS_SETTINGS_KEY][ATLAS_SQL_MODE_SETTING] = true;
    }
    const loreHost = context();
    const onHost=(type,handler)=>{
      loreHost.eventSource.on(type,handler);
      hostCleanups.push(()=>{if(typeof loreHost.eventSource.removeListener==="function")loreHost.eventSource.removeListener(type,handler);else loreHost.eventSource.off?.(type,handler);});
    };
    if (loreHost?.eventSource && loreHost?.event_types?.WORLD_INFO_ACTIVATED) {
      hostLoreActivationApiAvailable = true;
      onHost(loreHost.event_types.WORLD_INFO_ACTIVATED,(entries)=>recordAtlasHostLoreActivation(entries,context()));
      for(const name of ["GENERATION_STARTED","CHAT_CHANGED","MESSAGE_EDITED","MESSAGE_DELETED"]){
        const type=loreHost.event_types[name];if(type)onHost(type,()=>{hostLoreActivation=null;});
      }
    }
    // ATLAS-09 纯浏览器接线：引擎核心整体打进本扩展，进程内 dispatch，零网络。
    // 文档落 extensionSettings（酒馆设置持久化）；推演模型经酒馆后端代理转发。
    const engineStore = mod.createBrowserDocumentStore({
      readAll() {
        const settings = context().extensionSettings;
        return settings?.[ATLAS_SETTINGS_KEY]?.docs ?? null;
      },
      writeAll(docs) {
        const ctx = context();
        ctx.extensionSettings[ATLAS_SETTINGS_KEY] = {
          ...(ctx.extensionSettings[ATLAS_SETTINGS_KEY] ?? {}),
          docs,
        };
        if (typeof ctx.saveSettingsDebounced === "function") ctx.saveSettingsDebounced();
      },
    });
    // 0.9.13 连接方式分发（shujuku 同款三通道）：引擎请求体带 xAtlasConnectionMode 时
    // 路由到 酒馆主 API（TavernHelper.generateRaw）/ 酒馆连接预设（ConnectionManager），
    // 其余走酒馆后端代理（custom 源 / claude / makersuite 协议映射）。
    const getTavernHelper = () => globalThis.TavernHelper ?? globalThis.getTavernHelper?.() ?? null;
    const hostDispatchFetch = async (input, init) => {
      let mode = null;
      try {
        const parsed = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        mode = parsed && typeof parsed === "object" ? parsed.xAtlasConnectionMode ?? null : null;
      } catch { mode = null; }
      if (mode !== "main" && mode !== "profile") {
        return mod.createStProxyFetch({ getContext: context, fetchFn: loggingModelFetch })(input, init);
      }
      const adapter = mode === "main"
        ? mod.createTavernMainFetch({ getTavernHelper })
        : mod.createTavernProfileFetch({ getContext: context, getTavernHelper });
      const startedAt = Date.now();
      try {
        const response = await adapter(input, init);
        emitAtlasDiagnostic({
          level: response.ok ? "info" : "error", source: "model",
          code: response.ok ? "MODEL_HTTP_COMPLETE" : "MODEL_HTTP_FAILED",
          operation: "generation", phase: "response",
          outcome: response.ok ? "success" : "failed",
          httpStatus: response.status, durationMs: Date.now() - startedAt,
          details: { route: "host-model", mode },
        });
        return response;
      } catch (error) {
        emitAtlasDiagnostic({
          level: "error", source: "model", code: "MODEL_HOST_FAILED",
          operation: "generation", phase: "request", outcome: "failed",
          durationMs: Date.now() - startedAt, retryable: true,
          details: { route: "host-model", mode },
        });
        throw error;
      }
    };
    const runtimeApiKeys = new Map();
    const sqlSessionProvider = mod.createBrowserSqlHost({
      modelPort: mod.createSqlModelPort({ readSettings: async () => {
        const saved = await engineStore.read("settings");
        if (!saved?.apiPresets) return saved;
        return { ...saved, apiPresets: saved.apiPresets.map(p => runtimeApiKeys.has(p.id) ? { ...p, apiKey: runtimeApiKeys.get(p.id) } : p) };
      }, fetchFn: hostDispatchFetch }),
      enabled: () => context()?.extensionSettings?.[ATLAS_SETTINGS_KEY]?.[ATLAS_SQL_MODE_SETTING] === true,
      context: () => {
        const record = atlasContextRecord(context);
        const live = context();
        if (!record?.chatId || !record.chatMetadata || typeof live?.saveMetadata !== "function") return null;
        return {
          chatUid: String(record.chatId),
          branchId: readAtlasSession(context)?.binding?.branchId ?? null,
          chatMetadata: record.chatMetadata,
          saveMetadata: () => live.saveMetadata(),
        };
      },
      loadRuntime: async () => {
        const sql = await loadSqlCore();
        if (typeof sql?.loadAtlasSqlRuntime !== "function") {
          throw Object.assign(new Error("SQL 运行时未加载，无法打开宿主数据库"), { code: "SQL_RUNTIME_UNAVAILABLE" });
        }
        return sql.loadAtlasSqlRuntime();
      },
    });
    const engine = mod.createAtlasServerCore({
      store: engineStore,
      fetchFn: hostDispatchFetch,
      onDiagnostic: emitAtlasDiagnostic,
      onGenerationComplete: clearInjection,
      sqlSessionProvider,
    });
    // R15 集成：启动时清扫 orphan pending（R12 收口的最后一块——reconcilePending
    // 此前只有实现与单测，没有任何调用方）。带当前聊天会话调用：turn: 文档在
    // 会话覆盖层（0.9.42 起），不带 session 读裸 store 永远查不到已提交回合。
    // fire-and-forget：绝不阻塞启动；.catch 防止异步失败逃出 connectOnce 被外层
    // catch 吞掉成静默失效（0.9.2 教训）。其他聊天的孤儿留待各自聊天启动时清。
    try {
      const startupSession = readAtlasSession(context);
      void engine
        .reconcilePending(startupSession)
        .then((report) => {
          if (report.cleaned > 0 || report.malformed > 0 || report.errors.length > 0) {
            emitAtlasDiagnostic({
              level: report.errors.length > 0 ? "warn" : "info", source: "engine",
              code: report.errors.length > 0 ? "PENDING_RECONCILE_FAILED" : "PENDING_RECONCILE_COMPLETE",
              operation: "reconcile", phase: "startup",
              outcome: report.errors.length > 0 ? "failed" : "success",
              details: { scanned: report.scanned, cleaned: report.cleaned,
                kept: report.kept, malformed: report.malformed, count: report.errors.length },
            });
          }
        })
        .catch(() => {
          emitAtlasDiagnostic({ level: "warn", source: "engine", code: "PENDING_RECONCILE_FAILED",
            operation: "reconcile", phase: "startup", outcome: "failed" });
        });
    } catch {
      emitAtlasDiagnostic({ level: "warn", source: "storage", code: "PENDING_RECONCILE_FAILED",
        operation: "reconcile", phase: "session-read", outcome: "failed" });
    }
    // 引擎请求包装：每个 dispatch 记一条日志（方法 + 路径 + 结果码，绝不记请求体）
    const logApiCall = async (method, path, call) => {
      const startedAt = Date.now();
      try {
        const result = await call();
        const status = typeof result?.status === "number" ? result.status : undefined;
        const receipt = result?.body?.data?.receipt;
        const failed = result?.body?.ok === false || receipt?.status === "failed" ||
          (status !== undefined && status >= 400);
        const duplicate = receipt?.status === "duplicate";
        emitAtlasDiagnostic({
          level: failed ? "error" : "info", source: "engine",
          code: failed ? "API_CALL_FAILED" : duplicate ? "TURN_DUPLICATE" : "API_CALL_COMPLETE",
          operation: "api", phase: "response",
          outcome: failed ? "failed" : duplicate ? "skipped" : "success",
          httpStatus: status,
          errorCode: result?.body?.error?.code ?? receipt?.errorCode,
          durationMs: Date.now() - startedAt,
          details: { route: path },
        });
        return result;
      } catch (error) {
        emitAtlasDiagnostic({
          level: "error", source: "engine", code: "API_DISPATCH_EXCEPTION",
          operation: "api", phase: "request", outcome: "failed",
          durationMs: Date.now() - startedAt, details: { route: path },
        });
        throw error;
      }
    };
    const innerApi = mod.createLocalAtlasApi(engine);
    // 0.9.42 会话承载：会话路由请求自动带上 chatMetadata.atlas（世界文档），
    // 响应带回新会话（rev+1）自动写回聊天并触发存档——世界数据的往返只在此一处。
    // B02b（0.9.59 聊天隔离）：这段逻辑已抽成可测工厂 `createAtlasSessionApi`
    // （纯函数守卫 atlasSessionWriteGuard + atlasStaleWriteNotice），
    // harness 直接构造工厂验证「A 的迟到响应不写进 B」，接线一字不变。
    const sessionApi = createAtlasSessionApi({
      context,
      innerApi,
      emit: emitAtlasDiagnostic,
      notify: showAtlasNotice,
      logCall: logApiCall,
    });
    const api = sessionApi;
    api.setRuntimeApiKeys = connections => {
      runtimeApiKeys.clear();
      for (const c of connections) if (!c.rememberKey && c.apiKey) runtimeApiKeys.set(c.id, c.apiKey);
    };
    atlasRuntime.mod = mod;
    atlasRuntime.api = api;
    atlasRuntime.engineStore = engineStore;

    // ATLAS-09 世界书注入层：条目规划由引擎在 commit 成功时给出，这里经酒馆
    // world-info 公开 API 落成 Atlas 专属世界书；模块不可用（旧版酒馆 / 预览无 stub）
    // → 跳过写入，只影响世界书，不影响推演与账本。
    let lorebookWriter = null;
    try {
      const worldInfo = await loadStWorldInfo();
      // B05：把「当前聊天的绑定世界」交给世界书端口，让每个聊天写各自的专属世界书。
      // 迟读（`hostRef` 在 createAtlasUiCore 之后才赋值）：这个闭包只在真正写入时才被调用。
      lorebookWriter = mod.createAtlasLorebookWriter(createLorebookPort(
        context,
        worldInfo,
        async () => hostRef?.readBinding?.() ?? null,
      ));
    } catch (error) {
      emitAtlasDiagnostic({ level: "warn", source: "lorebook",
        code: "LOREBOOK_SYNC_UNAVAILABLE", operation: "lorebook",
        phase: "initialize", outcome: "skipped" });
      console.warn("[atlas] 世界书模块不可用，推演结果不写世界书：", error instanceof Error ? error.message : String(error));
    }

    let rerender = () => {};
    const adaptEvent = createEventAdapter(context);
    /** 0.8.2 首条消息自动建世；core 由下方 const 赋值后回填（调用只发生在初始化完成之后）。 */
    let coreRef = null;
    /** 0.9.46 皮肤持久化端口：host 建一次，core 与皮肤页共用（readData/writeData）。 */
    let hostRef = null;
    const core = mod.createAtlasUiCore({
      api,
      sqlEnabled: () => context().extensionSettings?.[ATLAS_SETTINGS_KEY]?.[ATLAS_SQL_MODE_SETTING] === true,
      getPlayerName: () => String(context()?.name1 ?? ""),
      getCommitIdentity: (request) => {
        if (request.turnId.startsWith('turn-manual-')) return null;
        const chat = context()?.chat;
        const index = Number(request.assistantMessageId);
        const message = Array.isArray(chat) ? chat[index] : null;
        if (!message) return null;
        const identity = atlasFloorIdentity(message, index, { chatId: request.chatId });
        return { messageUID: identity.messageUID, variantKey: identity.variantKey };
      },
      createCommitGuard: (request) => {
        if (request.turnId.startsWith('turn-manual-')) return () => true;
        const chat = context()?.chat;
        const message = Array.isArray(chat) ? chat[Number(request.assistantMessageId)] : null;
        const user = Array.isArray(chat) ? chat[Number(request.userMessageId)] : null;
        // Request budgets limit model input; freshness checks retain full host text.
        // Also compare the complete suffix while the model runs, including text beyond the budget.
        const assistantText = message?.mes, userText = user?.mes;
        const matches = message?.is_user === false && typeof assistantText === 'string'
          && assistantText.slice(0, mod.ATLAS_LIMITS.ASSISTANT_TEXT_CHARS) === request.assistantText
          && user?.is_user === true && typeof userText === 'string'
          && userText.slice(0, mod.ATLAS_LIMITS.USER_TEXT_CHARS) === request.userText;
        if (!matches) emitAtlasDiagnostic({ level: 'warn', source: 'host', code: 'HOST_COMMIT_TEXT_MISMATCH',
          operation: 'commit', phase: 'capture', outcome: 'skipped', details: {
            reasonCode: message?.is_user !== false ? 'ASSISTANT_FLOOR_INVALID' : user?.is_user !== true ? 'USER_FLOOR_INVALID'
              : typeof assistantText !== 'string' || assistantText.slice(0, mod.ATLAS_LIMITS.ASSISTANT_TEXT_CHARS) !== request.assistantText ? 'ASSISTANT_TEXT_CHANGED' : 'USER_TEXT_CHANGED' } });
        return () => {
          const live = context()?.chat;
          const assistant = live?.[Number(request.assistantMessageId)], player = live?.[Number(request.userMessageId)];
          return matches && assistant?.is_user === false && assistant.mes === assistantText
            && player?.is_user === true && player.mes === userText;
        };
      },
      resolveCommitFloor: (userMessageId, assistantMessageId) => {
        const chat = context()?.chat;
        const user = chat?.[Number(userMessageId)], assistant = chat?.[Number(assistantMessageId)];
        return user?.is_user === true && assistant?.is_user === false && typeof user.mes === 'string' && typeof assistant.mes === 'string'
          ? { userText: user.mes, assistantText: assistant.mes } : null;
      },
      resolveRetryFloor: (assistantMessageId) => {
        const chat = context()?.chat;
        if (!Array.isArray(chat) || !/^\d+$/.test(assistantMessageId)) return null;
        const index = Number(assistantMessageId), assistant = chat[index];
        if (assistant?.is_user !== false || typeof assistant.mes !== 'string' || chat.slice(index + 1).some(message => !message?.is_system)) return null;
        for (let userIndex = index - 1; userIndex >= 0; userIndex--) {
          const user = chat[userIndex];
          if (user?.is_user === true && typeof user.mes === 'string') return { userMessageId: String(userIndex), userText: user.mes, assistantText: assistant.mes };
        }
        return null;
      },
      onDiagnostic: emitAtlasDiagnostic,
      host: (hostRef ??= createHost(context)),
      emitter: createEmitter(context),
      adaptEvent,
      resolveAssistantFloor: createAssistantFloorResolver(context),
      getNarrativeContext: async () => {
        const captured = context();
        if (captured?.extensionSettings?.[ATLAS_SETTINGS_KEY]?.[ATLAS_SQL_MODE_SETTING] !== true) return null;
        // Read an existing snapshot only. This projection never creates/migrates/saves a world.
        if (!captured?.chatMetadata?.atlas?.database) return "";
        const branchId = captured.chatMetadata.atlas.database.active_branch_id ?? "main";
        const sql = await loadSqlCore();
        if (!sql?.renderSqlSceneContext) return "";
        let session = null;
        try {
          session = await sql.openSqlSession({ chatUid: String(captured.chatId), chatMetadata: captured.chatMetadata,
            branchId, persist: false, saveSession: async () => { throw new Error("Narrative projection is read-only"); } });
          const live = context();
          if (String(live?.chatId) !== String(captured.chatId) || live?.chatMetadata !== captured.chatMetadata) return "";
          if ((live.chatMetadata.atlas.database?.active_branch_id ?? "main") !== branchId) return "";
          return sql.renderSqlSceneContext({ db: session.repo.db, branchId: session.branchId });
        } finally { if (session) await sql.closeSqlSession(session); }
      },
      ensureWorld: () => ensureStarterWorld(),
      syncProtagonistIdentity: async (chatId, worldId) => {
        const ctx = context();
        if (String(ctx?.chatId ?? "") !== chatId || !worldId.startsWith("world-auto-")) return false;
        const card = resolveCharacterCard(context);
        const cardName = String(card?.name || ctx?.name2 || "").trim();
        const playerName = String(ctx?.name1 || "").trim();
        if (!cardName || !playerName || cardName === playerName) return true;
        const result = await api.request("POST", (context()?.extensionSettings?.[ATLAS_SETTINGS_KEY]?.[ATLAS_SQL_MODE_SETTING] === true ? "/sql/chat/map/protagonist" : "/worlds/protagonist/sync"), {
          chatId, worldId, cardName, playerName,
          playerDescription: String(ctx?.powerUserSettings?.persona_description || ctx?.persona_description || ""),
          cardDescription: String(card?.description || ""),
        });
        return result.status === 200 && result.body?.ok === true;
      },
      getOpeningMessage: async () => {
        try {
          const captured = SillyTavern.getContext();
          const chatId = String(captured?.chatId ?? "");
          const characterId = captured?.characterId ?? null;
          const branchId = captured?.chatMetadata?.atlas?.binding?.branchId ?? null;
          const chat = Array.isArray(captured?.chat) ? captured.chat : [];
          const lastUserIndex = chat.findLastIndex((message) => message?.is_user === true);
          if (!chatId || lastUserIndex < 1) return null;
          const firstIndex = chat.findIndex((message, index) => index < lastUserIndex
            && message?.is_user === false && message?.is_system !== true
            && typeof message?.mes === "string" && message.mes.trim());
          if (firstIndex < 0) return null;
          const opening = chat[firstIndex];
          const live = SillyTavern.getContext();
          if (String(live?.chatId ?? "") !== chatId || (live?.characterId ?? null) !== characterId
            || (live?.chatMetadata?.atlas?.binding?.branchId ?? null) !== branchId) return null;
          return { messageId: String(opening.id ?? opening.mesid ?? opening.send_date ?? firstIndex),
            text: opening.mes };
        } catch { return null; }
      },
      // 0.9.21 世界书资料块：commit 前读当前卡书启用条目（有界），喂给推演 AI；
      // 0.9.22 开关：被供应商审核拦截时可在推进页关闭（settingsV2.loreSupplementEnabled）
      // A09：关闭时发 LORE_SUPPLEMENT_DISABLED(reason=settings_disabled)，
      // 不要伪装成激活接口故障；只有宿主真的没提供激活条目列表时才发 LORE_ACTIVATION_UNAVAILABLE。
      getLoreSupplement: async (selectionContext) => {
        emitAtlasDiagnostic({ level: "info", source: "lorebook",
          code: "LORE_READ_STARTED", operation: "lore-context", phase: "read", outcome: "started",
          details: { mode: selectionContext.mode,
            chatMatch: String(SillyTavern.getContext()?.chatId ?? "") === selectionContext.chatId } });
        if (!(await isAtlasLoreSupplementEnabled(api))) {
          emitAtlasDiagnostic({ level: "info", source: "lorebook",
            code: "LORE_SUPPLEMENT_DISABLED", operation: "lore-context",
            phase: "read", outcome: "skipped",
            details: { reason: "settings_disabled" } });
          return "";
        }
        try {
          const result = await readCardLoreSupplementViaSelector({ ...selectionContext,
            characterId: SillyTavern.getContext()?.characterId ?? null });
          emitAtlasDiagnostic({ level: "info", source: "lorebook",
            code: "LORE_READ_COMPLETE", operation: "lore-context", phase: "read", outcome: "success",
            details: { mode: selectionContext.mode, outputChars: result.length } });
          return result;
        } catch (error) {
          const reasonCode = error && typeof error === "object" && typeof error.name === "string"
            ? error.name.toUpperCase() : "UNKNOWN";
          emitAtlasDiagnostic({ level: "warn", source: "lorebook",
            code: "LORE_READ_FAILED", operation: "lore-context", phase: "read", outcome: "failed",
            details: { reasonCode } });
          return "";
        }
      },
      // 0.9.22 立即推演：读最近一条助手楼层正文作为推演素材（无楼层 → null，用占位）
      getLastAssistantText: async () => {
        try {
          const ctx = SillyTavern.getContext();
          const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
          for (let i = chat.length - 1; i >= 0; i--) {
            const message = chat[i];
            if (message && message.is_user === false && typeof message.mes === "string" && message.mes.trim()) {
              return message.mes;
            }
          }
        } catch { /* 无聊天 / 宿主不可用 → null */ }
        return null;
      },

      // 0.9.25 shujuku 占位符体系：$7 前文 AI 楼层（排除当前楼层）/ $U 用户设定 / $C 角色描述。
      // 访问器照抄 shujuku host-state-gateway fallback 链；任何失败 → null（字段缺省，照常推演）。
      getCommitContext: async (assistantText) => {
        try {
          const ctx = SillyTavern.getContext();
          const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
          const texts = [];
          for (let i = chat.length - 1; i >= 0 && texts.length < 11; i--) {
            const message = chat[i];
            if (message && message.is_user === false && typeof message.mes === "string" && message.mes.trim()) {
              texts.unshift(message.mes);
            }
          }
          const recentAssistantTexts = texts
            .filter((text) => text !== assistantText)
            .slice(-10);
          const personaDescription = String(
            ctx?.powerUserSettings?.persona_description || ctx?.persona_description || "",
          );
          const character = Array.isArray(ctx?.characters) && Number.isInteger(ctx?.characterId)
            ? ctx.characters[ctx.characterId]
            : null;
          const charDescription = String(
            character?.description || character?.data?.description || ctx?.name2_description || "",
          );
          return {
            ...(recentAssistantTexts.length > 0 ? { recentAssistantTexts } : {}),
            ...(personaDescription.trim() ? { personaDescription } : {}),
            ...(charDescription.trim() ? { charDescription } : {}),
          };
        } catch { return null; }
      },

      onStateChange: () => rerender(),
      ...(lorebookWriter
        ? {
            onLorebookSync: async (plans) => {
              const captured = context();
              const worldId = coreRef?.getState()?.binding?.worldId;
              if (!worldId) return { contentTarget: "none" };
              const result = await lorebookWriter.syncTurn(plans, { chatId: captured.chatId, worldId });
              if (context()?.chatMetadata !== captured.chatMetadata || context()?.chatId !== captured.chatId) return result;
              await engineStore.write("lorebook", lorebookWriter.snapshot(plans, result));
              rerender();
              return result;
            },
            // 0.9.47 世界书聊天级生命周期（学 shujuku：新对话清理 + 按聊天隔离）：
            // 切到未绑定聊天 → 清掉书里上一聊天的 Atlas 条目（开场白阶段不写不建）；
            // 切回已绑定聊天 → 用该聊天会话里的世界状态立即重建「Atlas 动向」，
            // 不等下一轮推演。数据本体在 chatMetadata.atlas 会话里，零丢失。
            // B04（0.9.59）：异步写入改为带**递增 chatEpoch** 的处理器
            // （createLorebookChatSwitchHandler：开始 / 加载书后 / 保存前三处核验；
            //  只删 Atlas 自建条目；失败只记事件不影响回合）。
            onLorebookChatSwitch: createLorebookChatSwitchHandler({
              writer: lorebookWriter,
              store: engineStore,
              readBinding: () => hostRef.readBinding(),
              readSession: () => readAtlasSession(context),
              readChatId: () => context().chatId ?? null,
              buildPlans: mod.buildLorebookPlans,
              rerender: () => rerender(),
              emit: emitAtlasDiagnostic,
            }),
          }
        : {}),
    });
    coreRef = core;
    atlasRuntime.core = core;
    installGenerateInterceptor(core);

    // 根节点：挂在 body 下；样式只遵循公开扩展机制
    let root = document.getElementById("atlas-extension-panel-root");
    if (!root) {
      root = el("div", "atlas-workbench");
      root.id = "atlas-extension-panel-root";
      document.body.append(root);
    }
    rerender = renderPanel(core, root, api, engineStore, mod, {
      read: (key) => hostRef.readData(key),
      write: (key, value) => hostRef.writeData(key, value),
    });
    let diagnosticRenderTimer = null;
    const unsubscribeDiagnostics = atlasDiagnostics.subscribe(() => {
      if (core.getState().panelOpen === false || diagnosticRenderTimer) return;
      diagnosticRenderTimer = setTimeout(() => {
        diagnosticRenderTimer = null;
        if (core.getState().panelOpen !== false) rerender();
      }, 150);
    });
    installMenuButton(core);
    core.init();
    // H05/§17H：把 settings.html 的「SQL 世界数据」开关接上（新安装默认启用；抽屉不在则跳过）
    const sqlToggle=bindSqlModeToggle(context, () => rerender());
    const toggleHandler=sqlToggle?.__atlasChangeHandler;
    hostCleanups.push(()=>{
      if(sqlToggle && toggleHandler && sqlToggle.__atlasChangeHandler===toggleHandler){sqlToggle.removeEventListener("change",toggleHandler);delete sqlToggle.__atlasChangeHandler;delete sqlToggle.dataset.atlasBound;}
    });
    connected = { core, rerender, api, dispose: async () => {
      for(const cleanup of hostCleanups.splice(0).reverse())cleanup();
      hostLoreActivation=null;hostLoreActivationApiAvailable=false;
      unsubscribeDiagnostics?.();
      if(diagnosticRenderTimer)clearTimeout(diagnosticRenderTimer);
      await rerender.dispose?.();await engine.closeSqlSessions();
    } };
    return connected;
  } catch (error) {
    for(const cleanup of hostCleanups.splice(0).reverse())cleanup();
    emitAtlasDiagnostic({ level: "error", source: "ui", code: "UI_CORE_LOAD_FAILED",
      operation: "initialize", phase: "startup", outcome: "failed" });
    console.warn("[atlas] UI 扩展初始化失败（酒馆聊天不受影响）：", error instanceof Error ? error.message : String(error));
    return null;
  }
}

// 扩展菜单入口（作者 2026-09-19 反馈：0.7.3 修好隐藏后没有任何打开入口）。
// 做法 = shujuku 同款：往 #extensionsMenu 追加条目，容器未就绪则 2s 间隔重试。
let menuButtonTimer = null;

function installMenuButton(core) {
  if (typeof document === "undefined") return;
  ensureAtlasMenuItem(core);
  let tries = 1;
  menuButtonTimer = setInterval(() => {
    tries += 1;
    const done = ensureAtlasMenuItem(core);
    if (done || tries >= 10) {
      if (menuButtonTimer) clearInterval(menuButtonTimer);
      menuButtonTimer = null;
    }
  }, 2000);
}

function ensureAtlasMenuItem(core) {
  const menu = document.getElementById("extensionsMenu");
  if (!menu) return false;
  let item = document.getElementById("atlas-menu-open");
  if (!item) {
    item = el("div", "list-group-item flex-container flexGap5 interactable");
    item.id = "atlas-menu-open";
    item.setAttribute("role", "button");
    item.setAttribute("tabindex", "0");
    item.title = "打开阿特拉斯世界工作台";
    const icon = el("div", "fa-fw fa-solid fa-globe extensionsMenuExtensionButton");
    const label = el("span", null, "阿特拉斯 / Atlas");
    item.append(icon, label);
    item.addEventListener("click", () => {
      // SillyTavern closes its wand menu in the bubbling html click handler.
      // Keep this event bubbling so its visibility flag and Popper stay in sync.
      core.setPanelOpen(true);
    });
    item.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      item.click();
    });
    menu.append(item);
  }
  return true;
}

function removeMenuButton() {
  if (menuButtonTimer) {
    clearInterval(menuButtonTimer);
    menuButtonTimer = null;
  }
  const item = document.getElementById("atlas-menu-open");
  if (item) item.remove();
}

export async function disconnectAtlas() {
  if (!connected) return;
  connected.core.dispose();
  await connected.dispose?.();
  removeMenuButton();
  const root = document.getElementById("atlas-extension-panel-root");
  if (root) root.remove();
  // ATLAS-FIX-02：全局痕迹一并清除（interceptor + 拖拽中监听），否则宿主仍会调用已死闭包
  atlasUninstallGlobals();
  atlasRuntime.mod = null;
  atlasRuntime.api = null;
  atlasRuntime.core = null;
  atlasRuntime.engineStore = null;
  connected = null;
}

// SillyTavern 生命周期钩子（manifest.json hooks.activate / hooks.disable）
export async function activate() {
  await connectAtlas();
}

export async function disable() {
  await disconnectAtlas();
}

// 旧版酒馆没有 manifest hooks 支持：模块加载即幂等自初始化；
// 新版走 hooks.activate 时 connectAtlas 返回已有实例，不产生重复监听。
if (typeof SillyTavern !== "undefined" && typeof document !== "undefined") {
  void connectAtlas();
}
