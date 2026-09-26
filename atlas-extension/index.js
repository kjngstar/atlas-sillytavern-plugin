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

export const ATLAS_EXTENSION_VERSION = "0.9.59";
export const ATLAS_DISPLAY_NAME = "阿特拉斯 / Atlas";
export const ATLAS_PROTOCOL_VERSION = 1;
export const ATLAS_EXTENSION_ID = "atlas-world-sim";
export const ATLAS_BINDING_KEY = "atlas_binding";
/** 0.9.42 会话承载：世界文档（world/maps/turns/geoAuto/binding/rev）挂在 chatMetadata.atlas。 */
export const ATLAS_SESSION_KEY = "atlas";
export const ATLAS_SESSION_SCHEMA_VERSION = 1;
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
/** 官方 generate_interceptor 在 globalThis 上的函数名（与 manifest.json 一致）。 */
export const ATLAS_INTERCEPTOR_GLOBAL = "atlasGenerateInterceptor";
/** 同源 Server Plugin 前缀（ST 自动挂载 /api/plugins/atlas）。 */
export const ATLAS_API_BASE = "/api/plugins/atlas";
/** 最低兼容 SillyTavern 客户端版本（manifest hooks / generate_interceptor / setExtensionPrompt / getRequestHeaders）。 */
export const ATLAS_MINIMUM_CLIENT_VERSION = "1.12.0";

// ---------------------------------------------------------------------------
// 0.9.42 会话承载：世界数据随聊天走（chatMetadata.atlas 单文档，空间换安全）
// ---------------------------------------------------------------------------

/** 判定 chatMetadata 上的会话文档是否为当前 schema（宽容：损坏一律按不存在处理）。 */
export function isValidAtlasSession(value) {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) && value.schemaVersion === ATLAS_SESSION_SCHEMA_VERSION,
  );
}

/**
 * 新建空会话文档。
 *
 * C07a（0.9.59）：必须显式带 `simulation: null`——推演模块属于会话级数据，
 * 与 `world` / `maps` / `scene` 同级。旧聊天缺该字段仍按「合法空模块」读，
 * 但**新写的会话一律写明**，避免客户端与服务端对空会话的定义分叉。
 */
export function createEmptyAtlasSession() {
  return {
    schemaVersion: ATLAS_SESSION_SCHEMA_VERSION,
    rev: 0, binding: null, world: null, maps: null, scene: null,
    turns: {}, geoAuto: {}, tables: null,
    simulation: null,
  };
}

/** 读取当前聊天会话文档（无则 null；绝不创建半截对象）。 */
function readAtlasSession(context) {
  const metadata = context().chatMetadata;
  if (!metadata || typeof metadata !== "object") return null;
  return isValidAtlasSession(metadata[ATLAS_SESSION_KEY]) ? metadata[ATLAS_SESSION_KEY] : null;
}

/**
 * 写回会话文档并触发酒馆存档（世界数据的唯一落盘路径）。
 *
 * A07：三表随同 `chatMetadata.atlas` **一次写回**（不另开存储、不额外 saveMetadata）；
 * 旧会话没有 `tables` 字段照样合法（未迁移聊天兼容）；写失败必须明确抛错，
 * 由调用方按 `SESSION_WRITE_FAILED` 记账——绝不静默返回假装写成功。
 * 导出供测试（与 `atlasSessionWriteGuard` 同口径）。
 *
 * C07b（0.9.59）：新增**可选** `expectedChatId`。
 * - 异步请求（commit / bootstrap / retry / geo 提炼）**必须**把「发起时捕获的 chatId」
 *   传进来：写回前先核对当前聊天是否还是它，切过聊天就拒绝写——这是 B02b 的落点，
 *   防止 A 的迟到响应把 B 的会话盖掉。
 * - 同时校验 `session.world.id` 与 `session.binding.worldId` 是否自洽（同一份会话里
 *   世界 id 不能自相矛盾），避免半截会话落盘。
 * - **不传** `expectedChatId` 的现有人工导入调用保持原契约：只写「被显式选择的当前聊天」。
 *   旧调用点语义一字不变。
 */
export async function writeAtlasSession(context, session, expectedChatId = null, expectedMetadata = null) {
  if (!isValidAtlasSession(session)) {
    throw new Error("Atlas 会话写回被拒绝：会话形状非法（schemaVersion 不匹配）。");
  }
  const ctx = context();
  const metadata = ctx?.chatMetadata;
  if (!metadata || typeof metadata !== "object") {
    throw new Error("Atlas 会话写回失败：当前聊天没有可写的 chatMetadata。");
  }
  if (expectedMetadata && metadata !== expectedMetadata) {
    throw new Error("Atlas 会话写回被拒绝：聊天会话对象在请求期间已变更。");
  }
  if (expectedChatId !== null && expectedChatId !== undefined && String(expectedChatId) !== "") {
    const currentChatId = ctx?.chatId ?? null;
    if (String(currentChatId ?? "") !== String(expectedChatId)) {
      // 切聊天之后的迟到写入：宁可不写，也不把 A 的结果盖到 B 上
      throw new Error(
        `Atlas 会话写回被拒绝：请求发起于聊天 ${String(expectedChatId)}，当前聊天已是 ${String(currentChatId ?? "(无)")}。`,
      );
    }
  }
  // C07b：会话自洽性——世界 id 不能自相矛盾（半截会话不许落盘）
  const sessionWorldId = session?.world && typeof session.world === "object" ? String(session.world.id ?? "") : "";
  const bindingWorldId = session?.binding && typeof session.binding === "object" ? String(session.binding.worldId ?? "") : "";
  if (sessionWorldId && bindingWorldId && sessionWorldId !== bindingWorldId) {
    throw new Error(
      `Atlas 会话写回被拒绝：会话内世界 id 不一致（world.id=${sessionWorldId}，binding.worldId=${bindingWorldId}）。`,
    );
  }
  metadata[ATLAS_SESSION_KEY] = session;
  if (typeof ctx.saveMetadata === "function") await ctx.saveMetadata();
  return true;
}

/**
 * 0.9.48（T01）+ B02a（0.9.59 聊天隔离）会话写回守卫（纯函数，可测）。
 *
 * 判定「这份响应会话能不能写回当前聊天」，三方身份必须**同时**成立：
 * 1. 发起请求时的聊天身份（requestChatId）必须仍是当前聊天（currentChatId）；
 * 2. 会话归属（sessionChatId，来自 responseSession.binding.chatId）必须与当前聊天一致；
 * 3. 归属**缺席**（无 binding / binding 无 chatId）而响应里带着持久数据
 *    （world / tables / simulation，见 §2.1 的三块业务数据）→ 拒绝写回：
 *    宁可不写，也不把一份「无主会话」盖到当前聊天上。
 *
 * 只有既无绑定、又无持久数据的响应会话按非持久响应放行——这正是 B02b 的
 * 「允许设置类响应不含会话 / 空会话」。缺会话本身永远不算错误。
 *
 * 兼容：不传第 4 参数时沿用 0.9.58 的三方判定（归属未知放行）；旧调用点
 * （atlas-stability T01 用例等）语义一字不变，4 参形态是 sessionApi 的生产路径。
 */
function atlasSessionWriteGuard(requestChatId, currentChatId, sessionChatId, responseSession) {
  if (currentChatId === null || currentChatId === undefined || currentChatId === "") return false;
  if (requestChatId !== currentChatId) return false;
  const claimed = sessionChatId === null || sessionChatId === undefined ? "" : String(sessionChatId);
  if (claimed !== "") return claimed === currentChatId;
  if (responseSession === undefined) return true; // 旧三方形态：归属未知 → 保守放行
  if (responseSession === null || typeof responseSession !== "object") return true;
  const binding = responseSession.binding;
  const bindingChatId = binding && typeof binding === "object" && typeof binding.chatId === "string"
    ? binding.chatId.trim() : "";
  if (bindingChatId !== "") return bindingChatId === currentChatId;
  // 缺绑定 / 缺归属：带持久数据的会话拒绝写回（B02a）；空会话（设置类响应）放行
  return !atlasSessionHasPersistentPayload(responseSession);
}

/**
 * B02a 纯函数：响应会话是否带着**持久业务数据**。
 * 只认计划 §2.1 点名的三块：world（兼容镜像）/ tables（三表权威）/ simulation（第四块）。
 * maps / scene / turns 不在拒绝清单里——它们单独出现时不足以判定归属，宁可少拦不误拦。
 */
export function atlasSessionHasPersistentPayload(session) {
  if (!session || typeof session !== "object") return false;
  if (session.world) return true;
  if (session.tables) return true;
  if (session.simulation) return true;
  return false;
}

/**
 * First-world bootstrap is the one intentional unbound write. Its response
 * cannot carry a binding yet, so the general unbound-session guard must stay
 * strict for every other route. Tie this exception to the request, chat
 * metadata identity, starter ID and the returned world before saving it.
 */
export function atlasStarterWorldWriteGuard(requestChatId, currentChatId, requestMetadata, currentMetadata, requestWorld, responseSession, requestSession) {
  if (!requestChatId || requestChatId !== currentChatId) return false;
  if (!requestMetadata || requestMetadata !== currentMetadata) return false;
  const worldId = typeof requestWorld?.id === "string" ? requestWorld.id : "";
  if (!/^world-auto-[0-9a-f]{16}$/.test(worldId)) return false;
  if (requestSession?.binding || (requestSession?.world && requestSession.world.id !== worldId)) return false;
  if (!responseSession || responseSession.binding !== null || responseSession.tables || responseSession.simulation) return false;
  return responseSession.world?.id === worldId;
}

/**
 * B01：捕获「这一次异步工作属于哪个聊天」的身份快照。
 *
 * 两个字段都要抓，缺一不可：
 * - `chatId`：聊天标识（人类可读的定位依据）；
 * - `metadata`：`chatMetadata` 的**对象身份**——切聊天后酒馆会换成另一个对象，
 *   只比 chatId 会在「同名 / 空 chatId / 关聊天」时误判，比对象身份才是硬证据。
 */
export function atlasChatIdentitySnapshot(context) {
  let ctx = null;
  try {
    ctx = typeof context === "function" ? context() : context;
  } catch { ctx = null; }
  const record = ctx && typeof ctx === "object" ? ctx : {};
  return {
    chatId: record.chatId === null || record.chatId === undefined ? "" : String(record.chatId),
    metadata: record.chatMetadata && typeof record.chatMetadata === "object" ? record.chatMetadata : null,
  };
}

/**
 * B01 纯函数：`captured` 是否仍是「当前上下文的同一身份」。
 * 空身份一律判不符——身份不可核验时绝不写盘（这是 B01 的安全底线）。
 */
export function atlasSameChatIdentity(captured, current) {
  if (!captured || !current) return false;
  const left = captured.chatId === null || captured.chatId === undefined ? "" : String(captured.chatId);
  const right = current.chatId === null || current.chatId === undefined ? "" : String(current.chatId);
  if (!left || !right) return false;
  if (left !== right) return false;
  if (!captured.metadata || !current.metadata) return false;
  return captured.metadata === current.metadata;
}

/**
 * B02b 纯函数：写回被守卫拒绝时的诊断码 + 用户提示（只回文案，绝不带任何正文）。
 *
 * 引擎侧可能已经提交（committed / duplicate）——此时必须让用户知道「回执被丢了」，
 * 而不是静默消失：回到原聊天核对动向，数据在那边，没有丢。
 */
export function atlasStaleWriteNotice(receiptStatus) {
  if (receiptStatus !== "committed" && receiptStatus !== "duplicate") {
    return { code: "STALE_CHAT_RESPONSE_DROPPED", reasonCode: "SESSION_IDENTITY_MISMATCH", notice: null };
  }
  return {
    code: receiptStatus === "committed" ? "STALE_COMMIT_RESPONSE_DROPPED" : "STALE_CHAT_RESPONSE_DROPPED",
    reasonCode: "SESSION_IDENTITY_MISMATCH",
    notice: "切聊天弃回执：引擎侧这一轮可能已提交，但回执没有写回本窗口。请回到原聊天核对动向——数据仍在原聊天，没有丢。",
  };
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
      message: "尚未确定当前位置，无法计算附近。先在推演里确认主角所在地点，或在地图上点选所在地。",
    };
  }
  if (!currentLocationId) {
    return {
      case: "current-location-unknown",
      persons: 0,
      message: "尚未确定当前位置，无法计算附近。先在推演里确认主角所在地点，或在地图上点选所在地。",
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
// B02b：会话路由请求包装（可测工厂）
// ---------------------------------------------------------------------------

/** 需要携带会话文档的引擎路由前缀（0.9.42 会话承载的既有清单，一字不改）。 */
const SESSION_ROUTE_PREFIXES = [
  "/state",
  "/map/image",
  "/map/travel-preview",
  "/turns/",
  "/bindings",
  "/worlds/import",
  "/worlds/ensure-starter",
  "/worlds/geo/adopt",
  "/worlds/move-author",
  "/session/",
];

function pathWantsSession(path) {
  return SESSION_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

/**
 * B02b（聊天隔离）会话路由请求包装。
 *
 * - 请求发起时固定 `requestChatId`，并把**当前聊天**的会话文档随体带上（唯一往返路径）；
 * - 响应带回会话时只经 `atlasSessionWriteGuard` 四方核对后才写回（B02a）；
 * - 响应**不含会话**（设置类 / 只读类路由）是正常情况：不写回、不报错；
 * - 发起聊天 ≠ 当前聊天（A 等待期间切到 B，A 的迟到 commit / bootstrap / retry 响应）
 *   → 丢弃写回，记 `STALE_*_DROPPED`；若引擎侧已提交，额外给用户一条
 *   「切聊天弃回执，回原聊天核对」的可见提示（绝不静默吞掉回执）。
 *
 * 抽成工厂是为了让 harness 能真跑这条路径（connectOnce 里的接线一字不改地调用它）。
 */
export function createAtlasSessionApi(deps) {
  const context = deps.context;
  const innerApi = deps.innerApi;
  const emit = typeof deps.emit === "function" ? deps.emit : () => {};
  const notify = typeof deps.notify === "function" ? deps.notify : () => {};
  const logCall = typeof deps.logCall === "function" ? deps.logCall : (method, path, run) => run();
  if (!context || !innerApi) throw new Error("createAtlasSessionApi 需要 context 与 innerApi。");
  return {
    async request(method, path, body) {
      const requestContext = context();
      const requestChatId = requestContext.chatId ?? null;
      const requestMetadata = requestContext.chatMetadata ?? null;
      let payload = body;
      let requestSession = null;
      if (method === "POST" && pathWantsSession(path)) {
        requestSession = readAtlasSession(context);
        if (requestSession) payload = { ...(body ?? {}), session: requestSession };
      }
      const result = await logCall(method, path, () => innerApi.request(method, path, payload));
      const firstWorld = method === "POST" && path === "/worlds/ensure-starter" &&
        !result?.body?.session?.binding;
      try {
        const responseSession = result?.body?.session;
        // 设置类响应不带会话：正常路径，直接返回（B02b：不因为没会话就报错）
        if (!isValidAtlasSession(responseSession)) return result;
        const currentChatId = context().chatId ?? null;
        const sessionChatId =
          responseSession?.binding && typeof responseSession.binding.chatId === "string"
            ? responseSession.binding.chatId
            : null;
        const starterAllowed = firstWorld && atlasStarterWorldWriteGuard(
          requestChatId, currentChatId, requestMetadata, context().chatMetadata ?? null,
          payload?.world, responseSession, requestSession,
        );
        if (atlasSessionWriteGuard(requestChatId, currentChatId, sessionChatId, responseSession) || starterAllowed) {
          // C07b：把 B02b 捕获的 chatId 交给写回再做一次身份核对（守卫已过，这里是第二道锁，
          // 覆盖「守卫通过之后、await 落盘之前又切了聊天」的极窄窗口）。
          await writeAtlasSession(context, responseSession, requestChatId, starterAllowed ? requestMetadata : null);
          return result;
        }
        // 发起聊天 ≠ 当前聊天（切卡 / 换聊天 / 会话归属不一致）：丢弃写回。
        // 引擎侧已提交；回到原聊天时该会话由 chatMetadata 持久层自然恢复。
        const receiptStatus = result?.body?.data?.receipt?.status ?? null;
        const decision = atlasStaleWriteNotice(receiptStatus);
        emit({
          level: "info", source: "storage", code: decision.code,
          operation: "session", phase: "write", outcome: "skipped",
          errorCode: decision.reasonCode,
          details: { reasonCode: decision.reasonCode, coreCommitted: receiptStatus === "committed" },
        });
        if (decision.notice) notify(decision.notice);
        // A successful ensure response without a saved world must not be
        // followed by /bindings: that would turn this write rejection into an
        // opaque WORLD_NOT_FOUND error.
        if (firstWorld && requestChatId === currentChatId) {
          return { status: 409, body: { ok: false, error: {
            code: "SESSION_IDENTITY_MISMATCH",
            message: "自动建世结果未写入当前聊天：会话身份或世界 ID 不符，请在概览页重试初始化。",
          } } };
        }
      } catch (error) {
        // 写回失败（聊天正被切换等）：引擎侧已提交，本侧会话等下次响应覆盖；记日志排查
        emit({
          level: "error", source: "storage", code: "SESSION_WRITE_FAILED",
          operation: "session", phase: "write", outcome: "failed", retryable: true,
          details: { coreCommitted: result?.body?.data?.receipt?.status === "committed" },
        });
        if (firstWorld && requestChatId === (context().chatId ?? null)) {
          return { status: 409, body: { ok: false, error: {
            code: "SESSION_WRITE_FAILED",
            message: "自动建世已返回，但写入当前聊天失败；请在概览页重试初始化。",
          } } };
        }
      }
      return result;
    },
  };
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
      const result = await deps.writer.syncTurn(plans);
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
  /** Atlas UI 事件 → SillyTavern event_types；候选按序回退，全部缺失则跳过注册。 */
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
  const nameFor = (event) => {
    const candidates = EVENT_MAP[event];
    if (!candidates) throw new Error(`未映射的 Atlas UI 事件：${event}`);
    for (const name of candidates) {
      if (event_types[name]) return event_types[name];
    }
    throw new Error(`SillyTavern 未提供事件 ${event}，Atlas 跳过注册。`);
  };
  const handlers = [];
  return {
    on(event, handler) {
      let mapped = null;
      try {
        mapped = nameFor(event);
      } catch (error) {
        emitAtlasDiagnostic({
          level: "warn", source: "host", code: "HOST_EVENT_UNAVAILABLE",
          operation: "events", phase: "register", outcome: "skipped",
          details: { event },
        });
        console.warn("[atlas]", error instanceof Error ? error.message : String(error));
        return;
      }
      eventSource.on(mapped, handler);
      handlers.push([mapped, handler]);
    },
    off(event, handler) {
      // 按处理函数身份查找（on 时可能已因事件缺失而未注册）
      const index = handlers.findIndex(([, fn]) => fn === handler);
      if (index < 0) return;
      const [mapped, fn] = handlers[index];
      if (typeof eventSource.removeListener === "function") eventSource.removeListener(mapped, fn);
      else if (typeof eventSource.off === "function") eventSource.off(mapped, fn);
      handlers.splice(index, 1);
    },
  };
}

/** 清除生成拦截器注入（临时上下文；不写入可见聊天历史）。 */
function clearInjection() {
  defaultSetExtensionPrompt(ATLAS_INJECTION_KEY, "", 2, 4);
}

/**
 * 酒馆事件载荷适配器（deps.adaptEvent）。
 * ST 各事件数据形状不统一：形状未知 / 载荷不可用返回 null，绝不猜测。
 */
function createEventAdapter(context) {
  return function adaptEvent(event, payload) {
    if (event === "MESSAGE_SENT") {
      const chat = context().chat;
      const index = Number(payload);
      if (!Array.isArray(chat) || !Number.isInteger(index) || index < 0 || index >= chat.length) return null;
      return { kind: "message-sent", messageId: String(index), userText: String(chat[index]?.mes ?? "") };
    }
    if (event === "MESSAGE_RECEIVED") {
      const chat = context().chat;
      if (!Array.isArray(chat) || chat.length === 0) return null;
      const raw = Number(payload);
      const index = Number.isInteger(raw) && raw >= 0 && raw < chat.length ? raw : chat.length - 1;
      clearInjection();
      return { kind: "generation-ended", assistantMessageId: String(index), assistantText: String(chat[index]?.mes ?? "") };
    }
    if (event === "GENERATION_ENDED" || event === "GENERATION_ENDED_AFTER_COMMANDS") {
      const chat = context().chat;
      if (!Array.isArray(chat) || chat.length === 0) return null;
      const index = chat.length - 1;
      clearInjection();
      return { kind: "generation-ended", assistantMessageId: String(index), assistantText: String(chat[index]?.mes ?? "") };
    }
    if (event === "GENERATION_STOPPED") {
      clearInjection();
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
      return { kind: "generation-started", gated };
    }
    if (event === "MESSAGE_SWIPED") {
      const chat = context().chat;
      const index = Number(payload);
      if (!Array.isArray(chat) || !Number.isInteger(index) || index < 0 || index >= chat.length) return null;
      const mes = chat[index];
      // regenerating 判定：只有「滑到最右侧新变体（正在生成）」才回退世界；
      // 切换查看旧变体不动世界。swipes 形状读不到 → null（UI 侧宁可漏回退，不可误回退）。
      let regenerating = null;
      if (mes && Array.isArray(mes.swipes) && mes.swipes.length > 0) {
        regenerating = Number(mes.swipe_id ?? 0) === mes.swipes.length - 1;
      }
      return {
        kind: "message-swiped",
        messageId: String(index),
        userMessageId: String(Math.max(0, index - 1)),
        userText: String(chat[index - 1]?.mes ?? ""),
        regenerating,
      };
    }
    if (event === "MESSAGE_EDITED" || event === "MESSAGE_DELETED") {
      const index = Number(payload);
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
  { id: "paper", label: "纸面（默认）" },
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
export const ATLAS_PROMPT_PACK_BYTES_MAX = 64 * 1024;
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
  if (text.length > ATLAS_PROMPT_PACK_BYTES_MAX) {
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
  const base = String(name ?? "").trim().slice(0, ATLAS_PROMPT_PACK_NAME_MAX) || "导入的预设";
  const taken = new Set(
    (Array.isArray(existingNames) ? existingNames : []).map((item) => String(item ?? "").trim()),
  );
  if (!taken.has(base)) return base;
  let candidate = `${base}（导入）`;
  let index = 2;
  while (taken.has(candidate)) {
    candidate = `${base}（导入 ${String(index)}）`;
    index += 1;
  }
  return candidate.slice(0, ATLAS_PROMPT_PACK_NAME_MAX);
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
  simulation: "程序推演",
  manual: "作者手动",
  routine: "日程",
  unknown: "来源未知",
};

/**
 * D05：`tableMap.nearby` 的人物索引（键 = 去掉 `npc:` 前缀的实体 id）。
 *
 * `nearby` 是**全量人物表**（含远方，按"是否在身边"排序），所以除了建索引还要标出
 * `__isNear`：位置 = 当前地点，或当前地点的**子地点**（与 `projectTablesToMapView` 同一口径；
 * 根地点之间不算相邻——两座城相距几十格）。`__` 前缀字段只在 UI 内部用，不落任何数据。
 */
function buildTableMapNpcIndex(d) {
  const index = new Map();
  const tableMap = d?.tableMap;
  const entries = tableMap?.nearby?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return index;
  const currentRowId = String(tableMap?.current?.locationId ?? d?.currentLocationId ?? "");
  const chainIds = new Set((tableMap?.current?.chain ?? []).map((row) => String(row.id ?? "")));
  const nearRowIds = new Set();
  for (const row of chainIds) nearRowIds.add(row);
  for (const row of entries) {
    const locationId = String(row.locationId ?? "");
    if (!locationId) continue;
    if (locationId === currentRowId || chainIds.has(locationId)) nearRowIds.add(locationId);
  }
  for (const row of entries) {
    const id = String(row.id ?? "").replace(/^npc:/, "");
    if (!id) continue;
    const locationId = row.locationId === null || row.locationId === undefined ? null : String(row.locationId);
    const pointId = locationId === null ? null : locationId.replace(/^loc:/, "");
    index.set(id, {
      id,
      name: String(row.name ?? ""),
      pointId,
      pointName: row.locationName ?? null,
      presence: row.presence,
      thought: row.thought ?? "",
      actionTendency: row.actionTendency ?? "",
      currentAction: row.currentAction ?? "",
      positionSource: row.positionSource ?? null,
      isProtagonist: row.isProtagonist === true,
      fromTables: true,
      __isNear: locationId !== null && nearRowIds.has(locationId),
    });
  }
  return index;
}

/** D05：目录人物 + 三表人物合并（三表字段最后展开 —— 位置 / 在场 / 想法以三表为准）。 */
function mergeNearbyNpc(npc, table) {
  if (!table) return npc;
  return {
    ...npc,
    ...table,
    reason: npc.reason,
    recentNarratives: npc.recentNarratives,
    isProtagonist: npc.isProtagonist === true || table.isProtagonist === true,
  };
}

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


function renderPanel(core, root, api, store, mod, skinPort = null) {
  root.className = "atlas-workbench";
  root.id = "atlas-extension-panel-root";
  root.setAttribute("role", "application");
  root.setAttribute("aria-label", "阿特拉斯世界工作台");
  root.innerHTML = "";
  // R08 地图相机：screen = v + (world - c) * k（src/atlas-map-camera.ts 纯数学）。
  // 相机按视图（世界图 / 各层子图）持久化——筛选 / 重渲染不重算，返回父层恢复原相机。
  const {
    computeMapFrame,
    fitCamera,
    setCameraZoom,
    zoomCameraAtPoint,
    panCameraBy,
    centerCameraOn,
    worldToScreen,
    screenToWorld,
    cameraStageTransform,
    cameraZoomPercent,
    markerInverseScale,
    createPanGesture,
    // S9（0.9.55）：人物纠偏改为「长按头像拖动」——起拖状态机与等待时长同源于纯逻辑模块。
    // （旧的位移阈值拖拽 createDragGesture 不再被本文件使用：地图上已无人物标点。
    //   该原语仍由浏览器入口导出并有 R08 用例，是否退役留给清理批次评估。）
    createHoldDragGesture,
    MAP_LONGPRESS_HOLD_MS,
    createPinchTracker,
    // H13（0.9.59）：网格改画在**视口对齐**的 SVG overlay 上，格线由这一个纯函数
    // 按与相机同一套 world→screen 变换算出（不再用会被 stage scale 拉伸的 CSS 渐变）。
    getVisibleGridPaths,
    // H16：已证实范围的填色投影（只染有证据的格；没有 areas 就一格不染）
    projectColorAreas,
  /**
   * H08：缺坐标地点的示意布局（纯函数）。**只有这里调它**——显示用位置绝不回写三表。
   */
  layoutUnplacedMarkers,
    // C5（0.9.54）：比例尺 / 距离格式化唯一权威实现在 src/atlas-scale.ts，
    // 经 atlas-browser-entry 导出后从这里解构；index.js 不再自带副本。
    computeScaleBar,
    // H19a（0.9.59）：左下角**常驻**比例尺用固定长度版本——线条钉死在视口坐标系的
    // 96 CSS px，读数随 camera.k 变化（放大 2 倍读数减半）。旧的 computeScaleBar
    // 挑「1/2/5 × 10^n」候选，相邻缩放步可能保留同一个数字，不再用于这条尺。
    computeViewportScaleBar,
    formatDistanceMeters,
    formatTravelDistance,
    // C6（0.9.54）：导航页清单唯一权威（src/atlas-ui-core.ts 的 ATLAS_UI_PAGES）
    ATLAS_UI_PAGES,
  } = mod;
  const cameraApiMissing =
    typeof computeMapFrame !== "function" ||
    typeof fitCamera !== "function" ||
    typeof createPanGesture !== "function";
  const scaleApiMissing =
    typeof computeScaleBar !== "function" ||
    typeof formatDistanceMeters !== "function" ||
    typeof formatTravelDistance !== "function";
  // C6：核心模块未导出清单时退化为空列表（导航为空好过挂载即抛错）。
  // 真实发布形态 dist 必导出它；缺失只可能出现在测试注入的假 mod 上。
  const uiPages = Array.isArray(ATLAS_UI_PAGES) ? ATLAS_UI_PAGES : [];
  const pagesApiMissing = uiPages.length === 0;
  let camera = null; // 当前视图相机（MapCamera）
  let cameraViewKey = "";
  let cameraFrame = null;
  let cameraViewport = { w: 0, h: 0 };

  /**
   * H15b（0.9.59）：地图「编辑范围」绘制模式。
   *
   * 纪律（计划 §3-H15b 原文）：
   * - **只有用户显式进入绘制模式**才捕获网格点击/拖动；平时地图照常平移与点选；
   * - 屏幕坐标经**逆相机变换**换算到整数格 `(x,y)`——所以缩放 41% 与 400% 涂同一格，
   *   落到同一个真实格坐标（这是本条最关键的验收点）；
   * - 未提交的选区可**撤销**（整批清空），退出编辑立即恢复平移与点位点击；
   * - 只有点「保存」才调用 H15a `/maps/areas/upsert`；**取消不产生任何数据**；
   * - 标尺 / 尺度 / 人物位置**不由上色改写**（本模式只写 cells，不碰其它字段）。
   */
  const areaDraw = {
    active: false,
    locationId: null,
    locationName: "",
    mapId: "world",
    cells: new Set(),
  };
  /** buildMap 建的 DOM 引用（绘制函数定义在 renderPanel 作用域，靠这里拿到元素）。 */
  const areaDrawRefs = { viewport: null, layer: null, bar: null, count: null };

  /** 屏幕坐标 → 整数格坐标（逆相机变换；缩放多少都不影响落格结果）。 */
  function areaDrawCellAt(clientX, clientY) {
    const vp = areaDrawRefs.viewport;
    if (!vp || !camera || typeof cameraStageTransform !== "function") return null;
    const k = Number(camera.k);
    if (!Number.isFinite(k) || k <= 0) return null;
    const rect = vp.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    const t = cameraStageTransform(camera, vp.clientWidth || 0, vp.clientHeight || 0);
    const wx = (Number(clientX) - rect.left - t.tx) / k;
    const wy = (Number(clientY) - rect.top - t.ty) / k;
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return null;
    return { x: Math.floor(wx), y: Math.floor(wy) };
  }

  /** 把未提交的选区画成预览层（蓝色描边方格），并刷新计数。 */
  function renderAreaDraw() {
    const layer = areaDrawRefs.layer;
    if (!layer) return;
    const existing = layer.querySelector?.(".aw-areas__draft");
    if (existing) existing.remove();
    if (!areaDraw.active || areaDraw.cells.size === 0) {
      if (areaDrawRefs.count) areaDrawRefs.count.textContent = "0 格";
      return;
    }
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "aw-areas__svg aw-areas__draft");
    // 用格坐标当 viewBox：与世界坐标同尺度，所以 1 格 = 1 单位，缩放由 stage 负责
    const xs = [...areaDraw.cells].map((key) => Number(key.split(",")[0]));
    const ys = [...areaDraw.cells].map((key) => Number(key.split(",")[1]));
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const maxX = Math.max(...xs), maxY = Math.max(...ys);
    svg.setAttribute("viewBox", `${minX} ${minY} ${Math.max(1, maxX - minX + 1)} ${Math.max(1, maxY - minY + 1)}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.style.left = `${minX}px`;
    svg.style.top = `${minY}px`;
    svg.style.width = `${Math.max(1, maxX - minX + 1)}px`;
    svg.style.height = `${Math.max(1, maxY - minY + 1)}px`;
    for (const key of areaDraw.cells) {
      const [cx, cy] = key.split(",").map(Number);
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", String(cx));
      rect.setAttribute("y", String(cy));
      rect.setAttribute("width", "1");
      rect.setAttribute("height", "1");
      rect.setAttribute("class", "aw-areas__draft-cell");
      svg.append(rect);
    }
    layer.append(svg);
    if (areaDrawRefs.count) areaDrawRefs.count.textContent = `${areaDraw.cells.size} 格`;
  }

  function beginAreaDraw(locationId, locationName, mapId) {
    areaDraw.active = true;
    areaDraw.locationId = String(locationId);
    areaDraw.locationName = String(locationName ?? "");
    areaDraw.mapId = String(mapId ?? "world");
    areaDraw.cells.clear();
    if (areaDrawRefs.bar) {
      areaDrawRefs.bar.style.display = "";
      areaDrawRefs.bar.dataset.location = areaDraw.locationName;
    }
    renderAreaDraw();
  }

  /** 退出绘制模式：清掉未提交选区，恢复平移与点位点击（不产生任何数据）。 */
  function endAreaDraw() {
    areaDraw.active = false;
    areaDraw.cells.clear();
    areaDraw.locationId = null;
    if (areaDrawRefs.bar) areaDrawRefs.bar.style.display = "none";
    renderAreaDraw();
  }

  /** 保存：只有这一步会写数据，且只写 cells（不碰尺度/坐标/人物）。 */
  async function saveAreaDraw() {
    if (!areaDraw.active || !areaDraw.locationId) return;
    const chatId = String(state().chatId ?? "");
    if (!chatId) { setStatus("当前没有活动聊天。", "error"); return; }
    const cells = [...areaDraw.cells].map((key) => {
      const [x, y] = key.split(",").map(Number);
      return { x, y };
    });
    if (cells.length === 0) { setStatus("没有选中任何格。", "error"); return; }
    areaDrawRefs.bar?.querySelectorAll?.("button").forEach((b) => { b.disabled = true; });
    try {
      const response = await api.request("POST", "/maps/areas/upsert", {
        chatId, mapId: areaDraw.mapId, locationId: areaDraw.locationId, cells,
      });
      if (response.status !== 200 || !response.body?.ok) {
        // 失败要写字面原因与字段路径，绝不假装保存成功
        const detail = response.body?.error?.details?.schemaPath
          ? `（${String(response.body.error.details.schemaPath)}）` : "";
        setStatus(`${response.body?.error?.message ?? "范围保存失败"}${detail}`, "error");
        return;
      }
      setStatus(`已保存 ${cells.length} 格范围。`, "ok");
      endAreaDraw();
      await core.refresh();
    } finally {
      areaDrawRefs.bar?.querySelectorAll?.("button").forEach((b) => { b.disabled = false; });
    }
  }

  const mapCameras = new Map();
  let regionFilter = "";
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let modelOptions = [];
  let settingsLoadedOnce = false;

  // 0.9.46 皮肤：挂载即恢复上次保存的主题 / 自定义 CSS（键在 extensionSettings.atlas 下）
  const skinState = {
    theme: normalizeAtlasSkinTheme(skinPort?.read?.("skinTheme") ?? "paper"),
    customCss: typeof skinPort?.read?.("skinCustomCss") === "string" ? skinPort.read("skinCustomCss") : "",
  };
  applyAtlasSkin(root, skinState);
  // 0.9.51（M08）地图皮肤：挂载恢复上次应用的皮肤；损坏 / 缺失回退跟随工作台
  let mapSkin = null;
  let mapSkinPrev = null; // 「撤销上次应用」= 应用前的上一份
  try {
    const savedSkin = skinPort?.read?.("atlasMapSkin");
    if (savedSkin) {
      const parsed = parseAtlasMapSkin(savedSkin);
      if (parsed.ok) mapSkin = parsed.skin;
    }
  } catch { /* 损坏回退 */ }
  applyAtlasMapSkin(root, mapSkin);

  const state = () => core.getState();
  const data = () => state().stateData ?? {};

  // ---------------------------------------------------------------------------
  // 骨架：左导航栏 / 中央页面区（随栏位切换） / 右侧世界变化
  // ---------------------------------------------------------------------------

  const rail = el("aside", "aw-rail");
  const brand = el("div", "aw-brand");
  const brandMark = el("span", "aw-brand__mark", "A");
  const brandText = el("span", "aw-brand__text", "ATLAS");
  brand.append(brandMark, brandText);

  const PAGE_ICONS = { overview: "◈", map: "▣", nearby: "◉", changes: "≋", progression: "➤", api: "✳", skin: "◐", logs: "⚑" };
  const nav = el("nav", "aw-nav");
  nav.setAttribute("aria-label", "工作台分区导航");
  nav.append(el("span", "aw-rail__label", "导航"));
  const navButtons = new Map();
  for (const page of uiPages) {
    const btn = el("button", "aw-nav__btn");
    btn.type = "button";
    btn.dataset.page = page.id;
    btn.setAttribute("aria-label", `切换到${page.label}`);
    btn.append(el("span", "aw-nav__icon", PAGE_ICONS[page.id] ?? "•"), el("span", "aw-nav__label", page.label));
    btn.addEventListener("click", () => core.setPage(page.id));
    nav.append(btn);
    navButtons.set(page.id, btn);
  }

  const moves = el("div", "aw-moves");
  moves.append(el("span", "aw-eyebrow", "世界动向 · 写入世界书"));
  const movesList = el("div", "aw-moves__list");
  moves.append(movesList);

  const foot = el("div", "aw-foot");
  const engineDot = el("span", "aw-foot__dot");
  const engineText = el("span", "aw-foot__text", "本地引擎");
  const exitBtn = el("button", "aw-foot__exit", "退出");
  exitBtn.type = "button";
  exitBtn.setAttribute("aria-label", "退出工作台，返回酒馆聊天");
  exitBtn.addEventListener("click", () => core.setPanelOpen(false));
  foot.append(engineDot, engineText, exitBtn);

  rail.append(brand, nav, moves, foot);

  const main = el("main", "aw-main");
  const topbar = el("div", "aw-topbar");
  const topbarLeft = el("div", "aw-topbar__left");
  const topbarRight = el("div", "aw-topbar__right");
  // 右上角常驻关闭钮（作者 2026-09-19 反馈）：随 renderTopbar 追加在状态 chips 之后
  const topbarClose = el("button", "aw-topbar__close", "×");
  topbarClose.type = "button";
  topbarClose.title = "关闭工作台";
  topbarClose.setAttribute("aria-label", "关闭工作台，返回酒馆聊天");
  topbarClose.addEventListener("click", () => core.setPanelOpen(false));
  topbar.append(topbarLeft, topbarRight);

  const center = el("div", "aw-center");
  main.append(topbar, center);

  const side = el("aside", "aw-side");
  side.append(el("span", "aw-eyebrow", "世界变化 · 简览"));
  const sideChanges = el("div", "aw-side__changes");
  const devSlot = el("div", "aw-dev");
  const sideFoot = el("div", "aw-side__foot");
  sideFoot.append(sideChanges, devSlot);
  // 修复：sideFoot 此前从未挂进 side（v0.7.0 起的孤儿节点）——右栏永远只剩标题。
  side.append(sideFoot);

  root.append(rail, main, side);

  // 0.9.47 mapview 同款：ESC 关闭地图信息面板
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && mapPanel && mapPanel.style.display !== "none") closeMapPanel();
  });

  // 浮动窗拖拽（顶栏按住拖动；不记忆位置，避免跨主题/分辨率错位）
  const applyOffset = () => {
    root.style.translate = `${dragOffsetX}px ${dragOffsetY}px`;
  };
  topbar.addEventListener("mousedown", (event) => {
    if (event.target.closest("button, select, input, textarea")) return;
    const startX = event.clientX - dragOffsetX;
    const startY = event.clientY - dragOffsetY;
    const onMove = (moveEvent) => {
      dragOffsetX = moveEvent.clientX - startX;
      dragOffsetY = moveEvent.clientY - startY;
      applyOffset();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      activeDragCleanup = null;
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    activeDragCleanup = onUp;
  });
  topbar.classList.add("is-draggable");

  // ---------------------------------------------------------------------------
  // 公共渲染
  // ---------------------------------------------------------------------------

  function renderNav() {
    const current = state().page;
    for (const [pageId, btn] of navButtons) btn.classList.toggle("is-active", pageId === current);
  }

  function renderEngineStatus() {
    const s = state();
    const ok = s.serviceStatus === "online" && s.mode !== "offline";
    engineDot.classList.toggle("is-ok", ok);
    engineDot.classList.toggle("is-bad", !ok && s.serviceStatus !== "checking");
    engineText.textContent = s.serviceStatus === "checking" ? "引擎检测中" : ok ? "本地引擎" : "引擎未就绪";
  }

  function renderTopbar(d) {
    topbarLeft.innerHTML = "";
    topbarRight.innerHTML = "";
    const worldName = d.worldName ?? "未绑定世界";
    topbarLeft.append(el("span", "aw-topbar__world", worldName));
    topbarLeft.append(el("span", "aw-topbar__branch", d.branchId ? `分支 ${String(d.branchId)}` : "正史"));
    const pointer = el("span", "aw-topbar__hint", "按住空白处可拖动窗口");
    topbarLeft.append(pointer);
    if (state().pendingTurn) topbarRight.append(el("span", "aw-chip aw-chip--busy", "世界推演中"));
    if (d.currentTime !== undefined) topbarRight.append(el("span", "aw-chip aw-chip--gold", `第 ${String(d.currentTime)} 时段`));
    if (d.currentLocationId) {
      const pointName = (d.map?.points ?? []).find((p) => String(p.id) === String(d.currentLocationId))?.name;
      topbarRight.append(el("span", "aw-chip aw-chip--teal", `位置：${pointName ?? String(d.currentLocationId)}`));
    }
    topbarRight.append(topbarClose);
  }

  /**
   * D07：左栏「幕后动向」——直接读 `/state` 的结构化 `simulationView`。
   *
   * F1/F3 的根因就是这里过去只显示 `receipt.summary` 的截断版：有「应用 5 行」的数字，
   * 却看不到「谁想做什么、实际做了什么、为什么尚未移动」。现在按状态分成
   * 想法 / 在路上 / 已抵达 / 消息已送达 / 暂不能行动，并显示来源地 → 目标与阻塞原因。
   *
   * 老聊天（0.9.58 以前的 /state 不带 simulationView）整段跳过，退回下面的旧回执列表——
   * 旧行为一字不变。返回 true 表示确实渲染了内容（调用方据此决定是否显示空态）。
   */
  function renderSimulationMoves(s) {
    const simulation = s.simulationView;
    if (!simulation) return false;
    const counts = simulation.counts;
    const hasContent = simulation.recentEvents.length > 0 || counts.tasks > 0 || counts.signals > 0;
    if (!hasContent) return false;

    const LABELS = {
      "intent-recorded": "想法", "started": "出发", "progressed": "在路上",
      "arrived": "已抵达", "resolved": "已完成", "blocked": "暂不能行动",
      "published": "新消息", "delivered": "已送达",
    };
    movesList.append(el("div", "aw-move__meta", "幕后动向（按已知范围显示）"));
    // 最新在前，最多 8 条（服务端已经各自有界）
    /**
     * D07（0.9.59）：动向卡显示**姓名**而不是原始 ID，并且可点击跳到变化页
     * 看这条消息的完整送达路线（计划原文：「点卡到变化页看消息路线」）。
     */
    const nameById = new Map();
    const stateData = s.stateData ?? {};
    for (const npc of Array.isArray(stateData.npcDirectory) ? stateData.npcDirectory : []) {
      if (npc?.id) nameById.set(String(npc.id), String(npc.name ?? ""));
    }
    for (const entry of stateData.tableMap?.locationOccupants?.entries ?? []) {
      const label = String(entry?.locationName ?? "");
      if (!label) continue;
      if (entry?.locationId) nameById.set(String(entry.locationId), label);
      if (entry?.locationPointId) {
        nameById.set(String(entry.locationPointId), label);
        nameById.set(`loc:${String(entry.locationPointId)}`, label);
      }
    }
    const displayName = (id) => {
      const raw = String(id ?? "");
      if (!raw) return "";
      return nameById.get(raw) ?? raw;
    };
    for (const event of [...simulation.recentEvents].reverse().slice(0, 8)) {
      const card = el("div", "aw-move");
      if (event.status === "blocked") card.classList.add("is-failed");
      const label = LABELS[event.status] ?? "动向";
      card.append(el("div", "aw-move__title", `${label}：${String(event.summary ?? "").slice(0, 40)}`));
      const name = displayName(event.actorCharacterId);
      const where = [event.fromLocationId, event.toLocationId].filter(Boolean).map(displayName).join(" → ");
      card.append(el("div", "aw-move__meta", [
        `第 ${String(event.period)} 时段`,
        name ? `人物：${name}` : "",
        where,
        event.reasonCode ? `原因：${String(event.reasonCode)}` : "",
      ].filter(Boolean).join(" · ")));
      // 点卡看路线：动向右栏与变化页同源，跳过去能看到完整送达对象与信度
      card.setAttribute("role", "button");
      card.tabIndex = 0;
      card.setAttribute("aria-label", `查看这条动向的完整路线：${String(event.summary ?? "").slice(0, 30)}`);
      const goToChanges = () => { core.setPage("changes"); renderPage(); };
      card.addEventListener("click", goToChanges);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goToChanges(); }
      });
      movesList.append(card);
    }
    if (simulation.recentEvents.length === 0) {
      // 第 0 段有任务但没有旅行：明确写「等待时间推进」，而不是只说「应用 N 行」
      movesList.append(el("div", "aw-move__empty",
        "已记录行动意图；时间未推进，人物不会移动、消息也不会传到远方。"));
    }
    movesList.append(el("div", "aw-move__meta",
      `进行中 ${counts.activeTasks} · 受阻 ${counts.blockedTasks} · 消息 ${counts.signals} 条 · 送达 ${counts.deliveries} 处`));
    if (simulation.truncated.events > 0) {
      movesList.append(el("div", "aw-move__meta", `另有 ${simulation.truncated.events} 条更早的动向未显示`));
    }
    if (simulation.corrupt) {
      movesList.append(el("div", "aw-move__meta",
        "推演模块校验未通过：已保留原始数据，未做任何覆盖；请到变化页导出核对。"));
    }
    return true;
  }

  /**
   * D08：变化页的「幕后推演」四分类。
   *
   * 与左栏「幕后动向」**同源**（都读 `/state` 的 `simulationView`），所以同一条信号
   * 在左栏 / 变化页 / 人物知识状态上的含义一致——不会左栏说「未获知」而这里说「已送达」。
   *
   * 可见范围由作者开关控制：默认「仅已知」，显式切「全部」才会带上 hidden 与未送达内容，
   * 并明确标注它包含角色秘密（它只是作者视图，不改变任何人的知识）。
   */
  function buildSimulationTimeline(s) {
    const box = el("section", "aw-card");
    const head = el("div", "aw-timeline__head");
    head.append(el("h2", "aw-card__title", "幕后推演"));
    head.append(el("span", "aw-tag", s.simulationVisibility === "all" ? "全部（含未被主角得知）" : "仅已知"));
    box.append(head);

    const toggle = el("button", "aw-btn aw-btn--ghost",
      s.simulationVisibility === "all" ? "只看已知" : "查看全部幕后推演");
    toggle.type = "button";
    toggle.setAttribute("aria-label", "切换幕后推演可见范围");
    toggle.addEventListener("click", () => {
      void core.setSimulationVisibility(s.simulationVisibility === "all" ? "known" : "all");
    });
    box.append(toggle);
    box.append(el("p", "aw-card__meta",
      "「仅已知」只显示主角可知的；「全部」会包含角色秘密与尚未送达的消息——它只是作者视图，不改动任何数据，也不改变谁真的知道什么。"));

    const simulation = s.simulationView;
    if (!simulation) {
      box.append(el("p", "aw-card__text", "这个聊天还没有推演数据（旧会话不显示该区块）。"));
      return box;
    }

    const events = [...simulation.recentEvents].reverse();
    const entityRows = (s.receipts ?? []).slice(0, 4);
    const background = events.filter((event) => ["intent", "travel", "reaction"].includes(String(event.kind)));
    const messages = events.filter((event) => event.kind === "signal" || event.kind === "delivery");
    // 送达信度：按 simulationId 关联 deliveries（delivery 事件的 simulationId 就是送达 id）
    const confidenceById = new Map(
      (Array.isArray(simulation.deliveries) ? simulation.deliveries : []).map((row) => [String(row.id), String(row.confidence ?? "")]),
    );

    const eventRow = (event, extra) => {
      const item = el("article", `aw-timeline__item${event.status === "blocked" ? " is-failed" : ""}`);
      item.append(el("span", "aw-timeline__time", `第 ${String(event.period)} 时段`));
      const body = el("div", "aw-timeline__body");
      body.append(el("p", "aw-card__text", String(event.summary ?? "")));
      body.append(el("p", "aw-card__meta", [
        event.actorCharacterId ? `人物：${String(event.actorCharacterId)}` : "",
        event.fromLocationId ? `来源：${String(event.fromLocationId)}` : "",
        event.toLocationId ? `目标：${String(event.toLocationId)}` : "",
        event.reasonCode ? `原因：${String(event.reasonCode)}` : "",
        extra ?? "",
      ].filter(Boolean).join(" · ")));
      /**
       * D08（0.9.59）：**点击定位**——把这条动向涉及的地点带到地图页去看。
       * 计划原文要求「点击定位人物/地点」；这里给出可达的最短路径：
       * 切到地图页，作者即可在地图上按同一份 geoTopology / 三表口径查看该地点。
       */
      const locateId = String(event.toLocationId ?? event.fromLocationId ?? "");
      if (locateId) {
        const locateBtn = el("button", "aw-btn aw-btn--ghost aw-timeline__locate", `在地图上查看 ${locateId}`);
        locateBtn.type = "button";
        locateBtn.setAttribute("aria-label", `在地图上查看地点 ${locateId}`);
        locateBtn.addEventListener("click", () => { core.setPage("map"); renderPage(); });
        body.append(locateBtn);
      }
      item.append(body);
      return item;
    };

    const section = (title, count, build) => {
      box.append(el("h3", "aw-card__title", `${title}（${count}）`));
      if (count === 0) { box.append(el("p", "aw-card__meta", "无")); return; }
      build();
    };

    // ① 实体改动（三表行增量的人类摘要；具体行号在失败时由下面「失败行」给）
    section("实体改动", entityRows.length, () => {
      const list = el("div", "aw-timeline");
      for (const receipt of entityRows) {
        const item = el("article", `aw-timeline__item is-${String(receipt.status ?? "")}`);
        item.append(el("span", "aw-timeline__time", `第 ${String(receipt.currentTime)} 时段`));
        const body = el("div", "aw-timeline__body");
        body.append(el("p", "aw-card__text", String(receipt.summary ?? "")));
        list.append(item);
      }
      box.append(list);
    });

    // ② 后台行动
    section("后台行动", background.length, () => {
      const list = el("div", "aw-timeline");
      for (const event of background) list.append(eventRow(event));
      box.append(list);
    });

    // ③ 消息传播（带公开 / 传递 / 传言 / 争议信度）
    section("消息传播", messages.length, () => {
      const list = el("div", "aw-timeline");
      for (const event of messages) {
        const confidence = confidenceById.get(String(event.simulationId)) ?? "";
        const label = confidence === "confirmed" ? "已核实"
          : confidence === "rumor" ? "传言"
            : confidence === "disputed" ? "有争议" : "已公开";
        list.append(eventRow(event, `信度：${label}`));
      }
      box.append(list);
    });

    // ④ 失败行：行号与字段路径在失败回执的正文里（引擎按「第 N 行 CODE @ path」如实回报）
    const failed = (s.receipts ?? []).filter((receipt) => receipt.status === "failed");
    section("失败行", failed.length, () => {
      for (const receipt of failed) box.append(el("p", "aw-card__text", String(receipt.summary ?? "推演失败")));
      if (s.lastError) box.append(el("p", "aw-note aw-note--error", String(s.lastError)));
    });
    if (failed.length === 0 && s.lastError) box.append(el("p", "aw-note aw-note--error", String(s.lastError)));

    if (simulation.truncated && Number(simulation.truncated.events) > 0) {
      box.append(el("p", "aw-card__meta", `另有 ${Number(simulation.truncated.events)} 条更早的动向未显示（服务端有界截断，不是没有）。`));
    }
    if (simulation.corrupt) {
      box.append(el("p", "aw-note aw-note--error", "推演模块校验未通过：已保留原始数据，未做任何覆盖；请先导出核对。"));
    }
    return box;
  }

  function renderMoves() {
    movesList.innerHTML = "";
    const s = state();
    const receipts = [...s.receipts].reverse();
    if (s.pendingTurn) {
      const live = el("div", "aw-move is-live");
      live.append(el("div", "aw-move__title", "本轮推演进行中…"));
      live.append(el("div", "aw-move__meta", "回复完成后写入世界书"));
      movesList.append(live);
    }
    // D07：幕后动向优先于旧回执摘要（老聊天没有 simulationView 时自动跳过）
    const renderedSimulation = renderSimulationMoves(s);
    if (receipts.length === 0 && !s.pendingTurn && !renderedSimulation) {
      movesList.append(el("div", "aw-move__empty", "绑定世界并对话后，每轮的 NPC 动向与可触发事件会出现在这里。"));
      return;
    }
    for (const receipt of receipts.slice(0, 10)) {
      const card = el("div", "aw-move");
      // 0.9.20：失败回执标红（原因在 summary 第二句，之前截断后根本看不见）
      if (receipt.status === "failed") card.classList.add("is-failed");
      const title = receipt.summary
        ? receipt.summary.split(/[。！?\n]/)[0].slice(0, 22)
        : `世界推进 · 第 ${String(receipt.previousTime)} → ${String(receipt.currentTime)} 时段`;
      card.append(el("div", "aw-move__title", title));
      if (receipt.summary && receipt.summary.length > title.length) {
        // 失败回执全文展示——「失败原因：…」跟在第二句，截 70 字正好把它剪掉
        card.append(el("div", "aw-move__text", receipt.summary.slice(0, receipt.status === "failed" ? 300 : 70)));
      }
      card.append(el("div", "aw-move__meta", `第 ${String(receipt.previousTime)} → ${String(receipt.currentTime)} 时段`));
      movesList.append(card);
    }
  }

  /** 右侧：世界变化简览（首页预览用；变化页是完整版）。 */
  function renderSide() {
    const s = state();
    sideChanges.innerHTML = "";
    const compact = el("div", "aw-changes");
    const receipts = [...s.receipts].reverse().slice(0, 4);
    if (s.pendingTurn) {
      const row = el("div", "aw-changes__row is-live");
      row.append(el("span", "aw-changes__dot"), el("span", "aw-changes__text", "本轮推演中：回复后写入世界"));
      compact.append(row);
    }
    if (receipts.length === 0 && !s.pendingTurn) {
      compact.append(el("div", "aw-changes__empty", "还没有世界变化。绑定世界并正常对话后，这里会列出每轮推进。"));
    }
    for (const receipt of receipts) {
      const row = el("div", "aw-changes__row");
      row.append(el("span", `aw-changes__dot is-${receipt.status}`));
      const text = el("span", "aw-changes__text");
      text.append(el("strong", "aw-changes__span", `第 ${String(receipt.previousTime)} → ${String(receipt.currentTime)} 时段`));
      const summary = receipt.summary ? receipt.summary.slice(0, 46) : `${String(receipt.adoptedEventCount)} 条变化被采纳`;
      text.append(el("span", "aw-changes__summary", summary));
      row.append(text);
      compact.append(row);
    }
    sideChanges.append(compact);
    const more = el("button", "aw-btn aw-btn--ghost", "查看全部变化");
    more.type = "button";
    more.setAttribute("aria-label", "切换到变化页查看全部世界变化");
    more.addEventListener("click", () => core.setPage("changes"));
    sideChanges.append(more);

    // 开发预览槽：宿主要求时才注入（生产环境不出现）
    devSlot.innerHTML = "";
    if (typeof window !== "undefined" && typeof window.__atlasDevSlot === "function") {
      const box = el("div", "aw-dev__box");
      box.append(el("span", "aw-eyebrow", "预览控制"));
      try {
        window.__atlasDevSlot(box);
      } catch (error) {
        box.append(el("div", "aw-note aw-note--error", `预览控制注入失败：${error instanceof Error ? error.message : String(error)}`));
      }
      devSlot.append(box);
      devSlot.classList.add("is-visible");
    } else {
      devSlot.classList.remove("is-visible");
    }
  }

  // ---------------------------------------------------------------------------
  // 中心页：官网式概览 / 地图 / 附近 / 变化 / 设置
  // ---------------------------------------------------------------------------

  function pageHeader(title, description) {
    const head = el("div", "aw-page-head");
    head.append(el("h1", "aw-page-title", title));
    if (description) head.append(el("p", "aw-page-desc", description));
    return head;
  }

  function emptyBox(text) {
    const box = el("div", "aw-emptybox");
    const mark = el("span", "aw-emptybox__mark");
    mark.append(el("span", "aw-diamond"));
    box.append(mark, el("p", "aw-emptybox__text", text));
    return box;
  }

  // ---------------------------------------------------------------------------
  // 世界书条目面板（ATLAS-09）：读扩展端写入的 lorebook 快照
  // ---------------------------------------------------------------------------

  let lorebookSnapshot = null;

  async function refreshLorebookSnapshot() {
    try {
      const raw = await store.read("lorebook");
      if (raw !== lorebookSnapshot) {
        lorebookSnapshot = raw;
        if (state().page === "changes") renderCenter();
      }
    } catch {
      // 快照读取失败只影响展示，不影响面板其余部分
    }
  }

  function buildLorebookPanel() {
    const panel = el("section", "aw-panel aw-lorebook-panel");
    panel.append(el("span", "aw-eyebrow", "世界书条目"));
    const snap = lorebookSnapshot;
    if (!snap || typeof snap !== "object" || !Array.isArray(snap.entries)) {
      panel.append(el(
        "p",
        "aw-panel__text",
        "本区显示的是 Atlas **写入**世界书的条目（每轮世界推进后自动写「NPC 动向 / 近期可触发」，采纳 0 条的回合也会写一条动向摘要）。注意与「推演时注入卡书资料」是两回事：注入是只读的，每轮推演都会把当前角色绑定的全部世界书（primary + additional）带给推演模型，不会在这里列条目。",
      ));
      return panel;
    }
    const meta = el("div", "aw-rows");
    const bookRow = el("div", "aw-row");
    bookRow.append(el("span", "aw-row__label", "目标世界书"));
    bookRow.append(el("span", "aw-row__value", String(snap.bookName ?? "")));
    meta.append(bookRow);
    panel.append(meta);
    if (snap.binding === "conflict") {
      panel.append(el(
        "div",
        "aw-note aw-note--error",
        `本聊天已绑定《${String(snap.existingBookName ?? "")}》，Atlas 没有改动它。条目要生效需在酒馆世界书设置里切换或同时激活《${String(snap.bookName ?? "")}》。`,
      ));
    } else if (snap.binding === "char-primary") {
      panel.append(el(
        "div",
        "aw-note",
        `写入当前角色卡的世界书《${String(snap.bookName ?? "")}》——随角色卡激活，不占用聊天绑定槽。`,
      ));
    } else {
      panel.append(el(
        "div",
        "aw-note",
        snap.binding === "bound-by-atlas" ? "已由 Atlas 绑定到本聊天（聊天原本未绑定世界书）。" : "沿用本聊天已绑定的 Atlas 世界书。",
      ));
    }
    const list = el("div", "aw-lorebook__list");
    for (const entry of snap.entries.slice(0, 24)) {
      const card = el("article", "aw-card");
      card.append(el("h2", "aw-card__title", String(entry.comment ?? "")));
      const keys = Array.isArray(entry.keys) ? entry.keys.filter(Boolean) : [];
      if (keys.length > 0) card.append(el("span", "aw-tag", `触发词：${keys.join("、")}`));
      const text = el("p", "aw-card__text", String(entry.content ?? "").slice(0, 200));
      card.append(text);
      list.append(card);
    }
    panel.append(list);
    return panel;
  }

  /** Diagnostics displayed and exported from the same sanitized snapshot. */
  let logFilter = "all";
  let logQuery = "";
  let logAllChats = false;
  let logCurrentTrace = false;
  const diagnosticAdvice = {
    TURN_SKIPPED_NO_PENDING: "本次没有可提交回合；请检查准备阶段，必要时重新生成。",
    PREPARE_FAILED: "本次未准备好上下文；可检查引擎状态后重新生成。",
    MODEL_HTTP_FAILED: "模型请求失败；请在 API 页检查连接后重试。",
    MODEL_NETWORK_FAILED: "模型网络请求失败；检查连接后重试。",
    TURN_CONTRACT_REJECTED: "模型输出未通过协议校验，世界未变；检查提示词和请求预览。",
    SESSION_WRITE_FAILED: "检查当前聊天是否已切换；已提交的回合不要直接重跑模型。",
    LOREBOOK_SYNC_FAILED: "核心回合已提交；请检查世界书写入或稍后单独同步。",
    WORLD_ENSURE_FAILED: "本次未自动建世；可在概览页重试初始化。",
    INJECTION_UNAVAILABLE: "酒馆缺少扩展提示词接口；请检查版本及扩展加载状态。",
    HOST_EVENT_UNAVAILABLE: "酒馆缺少所需事件；请检查版本及扩展加载状态。",
    STATE_REFRESH_FAILED: "世界状态读取失败；刷新工作台后重试。",
    // 0.9.54 A16：HTTP 200 只说明模型接口处理成功，不代表世界已更新。这三种代码
    // 都表示「模型接口通了但世界没动」，必须引导去看失败回执并重试。
    WORLD_TURN_V2_REJECTED: "模型输出未通过 v2 协议校验（格式/证据/关系字段），世界未更新；到变化页查看失败回执与具体字段路径后重试。",
    WORLD_TURN_DELTA_REJECTED: "行增量未提交；下面列出每条被拒行的错误码、行号和字段路径。",
    WORLD_TURN_DELTA_ROW_REJECTED: "该行未应用；核对错误码和字段路径后重试推演。",
    WORLD_TURN_COMMIT_FAILED: "模型输出可解析但账本拒绝；检查同一时间段的引擎诊断。",
    COMMIT_FAILED: "回合提交失败，世界未更新；检查同一时间段的引擎诊断。",
  };

  function diagnosticEntries() {
    return atlasDiagnostics?.getSnapshot() ?? pendingDiagnostics;
  }

  function atlasLogAsText(entries) {
    return "Atlas " + ATLAS_EXTENSION_VERSION + " · 安全诊断（含行号和字段路径）\n" +
      entries.map((entry) => JSON.stringify(entry)).join("\n");
  }

  function buildLogPage() {
    const wrap = el("div", "aw-panel");
    const all = diagnosticEntries();
    const chatRef = currentChatRef();
    const scoped = all.filter((entry) => logAllChats || (chatRef ? entry.chatRef === chatRef : !entry.chatRef));
    // 引擎没有宿主 traceId；按本轮起始时刻纳入其后台诊断，避免「仅本轮」隐藏实际拒绝原因。
    const latestStart = [...scoped].reverse().find((entry) => entry.code === "TURN_STARTED");
    const turnStartAt = latestStart ? Date.parse(latestStart.at) : null;
    const visible = logCurrentTrace && turnStartAt !== null
      ? scoped.filter((entry) => Date.parse(entry.at) >= turnStartAt) : scoped;
    const errorCount = visible.filter((entry) => entry.level === "error").length;
    const latest = visible.at(-1);
    wrap.append(el("p", "aw-panel__meta",
      "Atlas " + ATLAS_EXTENSION_VERSION + " · 浏览器模式 · 当前聊天 " + (chatRef ?? "未知") +
      " · 安全元信息 " + visible.length + " 条 · 报错 " + errorCount +
      (latest ? " · 最近 " + latest.code : "")));

    const controls = el("div", "aw-actions");
    const filterSelect = document.createElement("select");
    filterSelect.className = "aw-input";
    filterSelect.setAttribute("aria-label", "筛选诊断");
    for (const [value, label] of [
      ["all", "全部"], ["error", "报错"], ["warn", "警告"],
      ["host", "宿主"], ["ui", "界面"], ["engine", "引擎"],
      ["model", "模型"], ["storage", "存储"], ["lorebook", "世界书"], ["map", "地图"],
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      filterSelect.append(option);
    }
    filterSelect.value = logFilter;
    filterSelect.addEventListener("change", () => { logFilter = filterSelect.value; renderCenter(); });
    controls.append(filterSelect);

    const search = document.createElement("input");
    search.type = "search";
    search.className = "aw-input";
    search.placeholder = "搜索错误码 / 行号 / 字段路径 / trace";
    search.value = logQuery;
    search.setAttribute("aria-label", "搜索诊断");
    search.addEventListener("change", () => { logQuery = search.value.trim().toLowerCase().slice(0, 80); renderCenter(); });
    controls.append(search);

    const allChats = el("button", "aw-btn aw-btn--ghost", logAllChats ? "全部聊天" : "当前聊天");
    allChats.type = "button";
    allChats.addEventListener("click", () => { logAllChats = !logAllChats; renderCenter(); });
    controls.append(allChats);

    const currentTurn = el("button", "aw-btn aw-btn--ghost", logCurrentTrace ? "本轮起的事件" : "全部回合");
    currentTurn.type = "button";
    currentTurn.addEventListener("click", () => { logCurrentTrace = !logCurrentTrace; renderCenter(); });
    controls.append(currentTurn);

    const archive = el("button", "aw-btn aw-btn--ghost",
      atlasDiagnostics?.getArchiveEnabled() ? "关闭持久归档" : "开启持久归档");
    archive.type = "button";
    archive.setAttribute("aria-pressed", String(atlasDiagnostics?.getArchiveEnabled() === true));
    archive.title = "仅保存脱敏后的警告和错误，最多 200 条，保留 7 天。关闭时清除归档。";
    archive.addEventListener("click", () => {
      const enabled = !atlasDiagnostics?.getArchiveEnabled();
      atlasDiagnostics?.setArchiveEnabled(enabled);
      try {
        if (enabled) globalThis.localStorage?.setItem("atlas:safe-diagnostics-archive-enabled:v1", "true");
        else globalThis.localStorage?.removeItem("atlas:safe-diagnostics-archive-enabled:v1");
      } catch {
        emitAtlasDiagnostic({ level: "warn", source: "storage",
          code: "DIAGNOSTICS_STORAGE_UNAVAILABLE", operation: "diagnostics",
          phase: "archive-preference", outcome: "failed" });
      }
      renderCenter();
    });
    controls.append(archive);

    const copy = el("button", "aw-btn aw-btn--ghost", "复制诊断摘要");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      const value = atlasLogAsText(visible) || "（诊断为空）";
      try {
        await navigator.clipboard.writeText(value);
        setStatus("安全诊断摘要已复制。");
        renderCenter();
      } catch {
        const manual = el("pre", "aw-log__detail", value);
        manual.setAttribute("aria-label", "手动复制诊断摘要");
        wrap.append(manual);
      }
    });
    controls.append(copy);

    const exportButton = el("button", "aw-btn aw-btn--ghost", "导出安全 JSONL");
    exportButton.type = "button";
    exportButton.addEventListener("click", () => {
      const payload = visible.map((entry) => JSON.stringify(entry)).join("\n");
      const url = URL.createObjectURL(new Blob([payload], { type: "application/x-ndjson;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "atlas-diagnostics.jsonl";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    controls.append(exportButton);

    const clear = el("button", "aw-btn aw-btn--danger", "清空本地诊断");
    clear.type = "button";
    clear.addEventListener("click", () => {
      atlasDiagnostics?.clear();
      pendingDiagnostics.length = 0;
      renderCenter();
    });
    controls.append(clear);
    wrap.append(controls);

    const filtered = visible.filter((entry) => {
      if (logFilter === "error" || logFilter === "warn") {
        if (entry.level !== logFilter) return false;
      } else if (logFilter !== "all" && entry.source !== logFilter) return false;
      const haystack = [entry.code, entry.phase, entry.traceId, entry.errorCode,
        entry.details ? JSON.stringify(entry.details) : ""].join(" ").toLowerCase();
      return !logQuery || haystack.includes(logQuery);
    });
    if (filtered.length === 0) {
      wrap.append(el("p", "aw-panel__text", "当前范围没有诊断事件。"));
      return wrap;
    }
    const list = el("div", "aw-log");
    // 一条时间线同时显示宿主、模型和引擎；错误的结构化细节直接展开。
    for (const entry of [...filtered].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
        const row = el("div", "aw-log__row" + (entry.level === "error" ? " is-error" : ""));
        row.append(
          el("span", "aw-log__time", entry.at),
          el("span", "aw-log__tag", entry.level + " · " + entry.source),
          el("span", "aw-log__text", entry.code + " · " + entry.phase + " · " + entry.outcome),
        );
        if (entry.traceId || entry.errorCode || entry.httpStatus || entry.details || entry.count) {
          row.append(el("pre", "aw-log__detail", JSON.stringify({
            ...(entry.traceId ? { traceId: entry.traceId } : {}),
            ...(entry.attemptId ? { attemptId: entry.attemptId } : {}),
            ...(entry.httpStatus ? { httpStatus: entry.httpStatus } : {}),
            ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
            ...(entry.durationMs != null ? { durationMs: entry.durationMs } : {}),
            ...(entry.count ? { count: entry.count } : {}),
            ...(entry.details ? { details: entry.details } : {}),
          })));
        }
        if (diagnosticAdvice[entry.code]) {
          row.append(el("span", "aw-log__detail", diagnosticAdvice[entry.code]));
        }
      list.append(row);
    }
    wrap.append(list);
    return wrap;
  }

  function renderCenter(d = data()) {
    center.innerHTML = "";
    const s = state();
    const ready = Boolean(d.worldId);

    if (s.page === "overview") {
      center.append(pageHeader(String(d.worldName ?? "世界概览"), ready ? "世界状态一览；左栏是写入世界书的动向，右侧是最近变化。" : undefined));
      if (!ready) {
        if (s.modeHint) center.append(el("div", "aw-note", s.modeHint));
        if (s.lastError) center.append(el("div", "aw-note aw-note--error", s.lastError));
        center.append(buildWorldCard(s));
        center.append(buildAdvancedWorldSection(s));
        return;
      }
      if (s.lastError) center.append(el("div", "aw-note aw-note--error", s.lastError));
      center.append(buildWorldCard(s));
      center.append(buildAdvancedWorldSection(s));
      if (s.worldNotice) center.append(el("div", "aw-note", s.worldNotice));
      const stats = el("div", "aw-stats");
      const statsSpec = [
        ["世界时间", `第 ${String(d.currentTime ?? 0)} 时段`],
        ["所在位置", String(d.map?.points?.find?.((p) => String(p.id) === String(d.currentLocationId))?.name ?? "未知")],
        ["地点总数", String(d.map?.pointCount ?? 0)],
        ["相关 NPC", String(Array.isArray(d.npcDirectory) ? d.npcDirectory.length : 0)],
      ];
      for (const [label, value] of statsSpec) {
        const card = el("div", "aw-stat");
        card.append(el("span", "aw-stat__label", label), el("span", "aw-stat__value", value));
        stats.append(card);
      }
      center.append(stats);
      if (d.lastAdvance?.summary) {
        const card = el("section", "aw-panel");
        card.append(el("span", "aw-eyebrow", "最近一次世界推进"));
        card.append(el("p", "aw-panel__text", String(d.lastAdvance.summary)));
        if (d.lastAdvance.at !== undefined) {
          card.append(el("span", "aw-panel__meta", `世界时间：第 ${String(d.lastAdvance.at)} 时段`));
        }
        center.append(card);
      }
      const guide = el("section", "aw-panel");
      guide.append(el("span", "aw-eyebrow", "怎么玩"));
      const list = el("ol", "aw-guide");
      for (const item of [
        "正常和角色对话——你的行动会推演世界，结果写入世界书。",
        "「地图」页可预览前往某地点的路线，确认后只填入输入框，不会自动发送。",
        "「变化」页查看每轮世界推进的回执；失败可重试。",
      ]) {
        list.append(el("li", "aw-guide__item", item));
      }
      guide.append(list);
      center.append(guide);
      return;
    }

    if (s.page === "map") {
      center.append(pageHeader("世界地图", "点击地点预览路线；左上可切换地区，右下可缩放。地图随剧情生长：重名地点自动跳过，绝不删改已有地理。"));
      if (!ready) {
        center.append(emptyBox("绑定世界后可查看地图。"));
        return;
      }
      center.append(buildMap());
      // R01：地图动作（提炼 / 标定 / 纠偏）的成败反馈直接显示在地图页，
      // 不再只写 settingsStatus 让用户切到设置页才能看到结果
      if (statusLine()) center.append(statusLine());
      return;
    }

    if (s.page === "nearby") {
      center.append(pageHeader("附近人物", "引擎按同地点 / 附近地点 / 同地区给出相关人物。"));
      if (!ready) {
        center.append(emptyBox("绑定世界后可查看附近人物。"));
        return;
      }
      const npcs = Array.isArray(d.npcDirectory) ? d.npcDirectory : [];
      // S11（0.9.55）：附近页只展示**引擎判定的相关人物**，按 relevantNpcIds 的命中顺序，
      // 不再把整张 npcDirectory 当「附近」——旧实现把远在别处的目录成员也列成附近人物。
      // 目录本身不变：非相关成员仍在地点菜单（「当前在这里」）里可查、可纠偏。
      // 主角（服务端 isProtagonist，口径同 move-author）不在附近卡片里冒充 NPC；
      // 已离场者保留展示（卡片如实标「已离场」，不伪装在场）。
      const npcById = new Map(npcs.map((n) => [String(n.id ?? ""), n]));
      /**
       * D05：有 `tableMap` 时，**人物字段以三表为准**（想法 / 行动倾向 / 在场性 / 位置来源），
       * 目录只补它独有的最近叙事与关联原因。三表里有、目录里还没有的人物也要出现
       * （本轮刚被行增量记下的人不能因为目录投影滞后而消失）；已离场者不进"附近"。
       */
      const nearbyTableEntries = buildTableMapNpcIndex(d);
      const relevant = (Array.isArray(d.relevantNpcIds) ? d.relevantNpcIds : [])
        .map((id) => npcById.get(String(id)))
        .filter((npc) => Boolean(npc))
        .map((npc) => mergeNearbyNpc(npc, nearbyTableEntries.get(String(npc.id ?? ""))))
        .filter((npc) => npc.isProtagonist !== true && npc.presence !== "left");
      // 三表里有、但既不在相关名单、也不在当前地点的人：不冒充"附近"，留给地点菜单全量查询
      for (const [id, view] of nearbyTableEntries) {
        if (npcById.has(id)) continue;
        if (view.presence === "left" || view.isProtagonist) continue;
        if (!view.__isNear) continue;
        relevant.push(view);
      }
      if (relevant.length === 0) {
        // A03 / F8 + §2.4：空关联**不等于**"没人"，更不等于串档。三种情形分开口径：
        // 当前位置未知（还没算过附近）/ 当前地点确实有人（引擎没给相关性）/ 真的没确认的人。
        // 诊断夹具（tests/atlas-extension-harness.test.mjs 的 A03）按同一纯函数断言这三档。
        const triage = atlasDiagnoseEmptyNearby({
          currentLocationId: d.currentLocationId ?? null,
          // F05：优先用服务端的具名原因（权威），启发式只在旧 /state 上兜底
          nearReasonCode: d.tableMap?.nearReasonCode ?? null,
          tableNearbyEntries: d.tableMap?.nearby?.entries ?? null,
          relevantNpcIds: d.relevantNpcIds ?? [],
        });
        center.append(emptyBox(triage.message));
      } else {
        const grid = el("div", "aw-cards");
        for (const npc of relevant) {
          const card = el("article", "aw-card aw-card--npc");
          card.append(el("h2", "aw-card__title", String(npc.name)));
          const reason = npc.reason ? (NPC_REASON_LABELS[String(npc.reason)] ?? String(npc.reason)) : "相关人物";
          card.append(el("span", "aw-tag", reason));
          const pointId = npc.pointId ?? npc.regionId;
          if (pointId) card.append(el("p", "aw-card__text", `位置：${npc.pointName ? String(npc.pointName) : String(pointId)}（${String(npc.positionSource) === "ledger" ? "账本确认" : String(npc.positionSource) === "state" ? "基线记录" : "旧档案"}）`));
          // R07：点击展开统一人物详情——位置来源 / presence / 最后确认时刻 / 真实已知动向
          const detail = el("div", "aw-npc-detail");
          detail.hidden = true;
          const presenceLabel = npc.presence === "present" ? "在场" : npc.presence === "left" ? "已离场" : "未记录（不猜离场）";
          detail.append(el("p", "aw-card__text", `在场状态：${presenceLabel}`));
          detail.append(el("p", "aw-card__text", `状态：${npc.status ? String(npc.status) : "未记录"}`));
          detail.append(el("p", "aw-card__text", `最后确认时刻：${npc.lastConfirmedAt != null ? `第 ${String(npc.lastConfirmedAt)} 时段` : "尚无账本记录"}`));
          const moves = Array.isArray(npc.recentNarratives) ? npc.recentNarratives.filter((t) => String(t).trim()) : [];
          if (moves.length > 0) {
            const list = el("ul", "aw-npc-detail__list");
            for (const text of moves) list.append(el("li", "aw-card__text", String(text)));
            detail.append(el("p", "aw-card__text", "最近涉及叙事（账本摘要，非实时心声）："));
            detail.append(list);
          } else {
            detail.append(el("p", "aw-card__text", "动向：未记录"));
          }
          // D05：三表口径的想法 / 行动倾向 / 位置来源（有 tableMap 时才有；它们是"下一轮会怎么动"的依据）
          const tableThought = String(npc.thought ?? "").trim();
          const tableTendency = String(npc.actionTendency ?? "").trim();
          if (tableThought) detail.append(el("p", "aw-card__text", `想法：${tableThought}`));
          if (tableTendency) detail.append(el("p", "aw-card__text", `行动倾向：${tableTendency}`));
          if (npc.positionSource && POSITION_SOURCE_LABELS[String(npc.positionSource)]) {
            detail.append(el("p", "aw-card__text", `位置来源：${POSITION_SOURCE_LABELS[String(npc.positionSource)]}`));
          }
          card.append(detail);
          card.style.cursor = "pointer";
          card.setAttribute("role", "button");
          card.setAttribute("aria-label", `查看 ${String(npc.name)} 的详情（位置来源、状态与已知动向）`);
          card.tabIndex = 0;
          const toggleDetail = () => { detail.hidden = !detail.hidden; };
          card.addEventListener("click", toggleDetail);
          card.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleDetail(); }
          });
          grid.append(card);
        }
        center.append(grid);
      }
      const nearbyPoints = Array.isArray(d.nearbyPointIds) ? d.nearbyPointIds : [];
      if (nearbyPoints.length > 0) {
        const panel = el("section", "aw-panel");
        panel.append(el("span", "aw-eyebrow", "附近地点"));
        panel.append(el("p", "aw-panel__text", nearbyPoints.join("、")));
        center.append(panel);
      }
      return;
    }

    if (s.page === "changes") {
      center.append(pageHeader("世界变化", "每轮回复后自动提交的世界推进；失败可重试，重复通知不会二次推进。"));
      if (s.retryableCommit) {
        const retry = el("button", "aw-btn aw-btn--danger", "重试上次世界推演");
        retry.type = "button";
        retry.setAttribute("aria-label", "重试上次失败的世界推演");
        retry.addEventListener("click", () => void core.retryLastCommit());
        center.append(retry);
      }
      if (s.receipts.length === 0 && !s.pendingTurn && !s.retryableCommit) {
        center.append(emptyBox("尚无世界变化记录——绑定世界并正常对话后，这里会显示每轮的世界变化。"));
      }
      const timeline = el("div", "aw-timeline");
      if (s.pendingTurn) {
        const item = el("article", "aw-timeline__item is-live");
        item.append(el("span", "aw-timeline__time", "本轮"));
        const body = el("div", "aw-timeline__body");
        body.append(el("h2", "aw-card__title", "世界推演进行中"));
        body.append(el("p", "aw-card__text", "本轮回复完成后将自动提交。"));
        const sources = Array.isArray(s.pendingTurn.sourceRefs) ? s.pendingTurn.sourceRefs : [];
        if (sources.length > 0) {
          body.append(el("p", "aw-card__text", `注入来源：${sources.join("、")}（${String(s.pendingTurn.injectionText?.length ?? 0)} 字符）`));
        }
        item.append(body);
        timeline.append(item);
      }
      for (const receipt of [...s.receipts].reverse()) {
        const item = el("article", `aw-timeline__item is-${receipt.status}`);
        item.append(el("span", "aw-timeline__time", `第 ${String(receipt.currentTime)} 时段`));
        const body = el("div", "aw-timeline__body");
        const head = el("div", "aw-timeline__head");
        head.append(el("h2", "aw-card__title", STATUS_LABELS[receipt.status] ?? String(receipt.status)));
        head.append(el("span", "aw-tag", `采纳 ${String(receipt.adoptedEventCount)} 条`));
        body.append(head);
        if (receipt.summary) body.append(el("p", "aw-card__text", receipt.summary));
        body.append(el("p", "aw-card__meta", `世界时间：第 ${String(receipt.previousTime)} → 第 ${String(receipt.currentTime)} 时段${receipt.currentLocationId ? ` · 位置：${String(receipt.currentLocationId)}` : ""}`));
        item.append(body);
        timeline.append(item);
      }
      center.append(timeline);
      // D08：按回合分组之外的「幕后推演」四分类（实体改动 / 后台行动 / 消息传播 / 失败行）
      center.append(buildSimulationTimeline(s));
      // ATLAS-09 世界书注入层：条目面板（快照来自扩展端写入后的 store 文档）
      if (s.lorebookHint) center.append(el("div", "aw-note aw-note--error", s.lorebookHint));
      if (s.worldNotice) center.append(el("div", "aw-note", s.worldNotice));
      center.append(buildLorebookPanel());
      return;
    }

    if (s.page === "progression") {
      center.append(pageHeader("世界推进", "控制每轮回复后如何更新世界。这里只管理推进行为和提示词，不配置 API 地址。"));
      if (s.lastError) center.append(el("div", "aw-note aw-note--error", s.lastError));
      ensureSettingsLoaded();
      center.append(buildProgressionPanel());
      return;
    }

    if (s.page === "api") {
      center.append(pageHeader("API 连接", "保存并切换世界推演使用的独立模型连接。提示词请在左侧「推进」中管理。"));
      if (s.lastError) center.append(el("div", "aw-note aw-note--error", s.lastError));
      ensureSettingsLoaded();
      center.append(buildApiPanel());
      return;
    }

    if (s.page === "replace") {
      center.append(pageHeader("内容替换", "推演返回正文在解析前按规则删除成对词段（照抄 shujuku 内容替换）。预制规则可开关 / 删除 / 修改，与手动新增的规则同库平等。"));
      if (s.lastError) center.append(el("div", "aw-note aw-note--error", s.lastError));
      ensureSettingsLoaded();
      center.append(buildReplacePanel());
      return;
    }

    if (s.page === "skin") {
      center.append(pageHeader("皮肤", "主题切换即时生效；自定义 CSS 覆盖 --aw-* 皮肤令牌，改外观不用改源码。"));
      center.append(buildSkinPanel());
      return;
    }

    if (s.page === "logs") {
      center.append(pageHeader("运行日志", "宿主、模型和引擎按时间排列；推进失败行在这里显示错误码、行号与字段路径。"));
      center.append(buildLogPage());
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // 地图
  // ---------------------------------------------------------------------------

  const viewport = el("div", "aw-viewport");
  const interiorRoster = el("div", "aw-interior-roster");
  interiorRoster.setAttribute("aria-label", "建筑内位置未细分的人物与物品");
  // R01 图层拆分：底图（aw-image）/ 网格（aw-grid）/ 标点路线（aw-layer）各占一个
  // 独立元素——底图与网格不再抢同一个 backgroundImage 属性（旧实现两者复用 mapLayer，
  // 后赋值覆盖前者，有底图时网格必然消失）。zoom/pan 变换作用在 aw-stage 包装层，
  // 三层同步缩放平移，格线与标点永远对齐。
  const stage = el("div", "aw-stage");
  const imageLayer = el("div", "aw-image");
  /**
   * H16（§2.5 图层序）：底图 → **有证据的区域格染色** → 网格 → 路线 → 地点/载具 → 徽标 → 控件。
   * 所以面积层夹在底图与网格之间；没有 areas 时它一个格都不染。
   */
  const areaLayer = el("div", "aw-areas");
  const gridLayer = el("div", "aw-grid");
  /**
   * H13（§2.6 / F12）：网格改为**视口对齐的 SVG overlay**。
   *
   * 旧实现把 CSS `repeating-linear-gradient` 画在会被 `scale(k)` 拉伸的 stage 上：
   * 41% 时看似密格，放大后渐变被拉成少量粗大模糊断线（F12 的现场症状）。
   * 现在 SVG 用与相机**同一套** world→screen 变换算出格线，再对自己施加反变换
   * （translate + scale(1/k)），使它的局部坐标 1:1 等于屏幕 CSS 像素——
   * 线宽恒为 1 CSS px、主格线精确落在整数格坐标上，与图钉始终对齐。
   * 它仍然放在 aw-grid 里，所以既有图层显隐（叠加/纯网格/纯底图）语义不变。
   */
  const SVG_NS = "http://www.w3.org/2000/svg";
  const gridSvg = document.createElementNS(SVG_NS, "svg");
  gridSvg.setAttribute("class", "aw-grid-svg");
  gridSvg.setAttribute("aria-hidden", "true");
  const gridMinorPath = document.createElementNS(SVG_NS, "path");
  gridMinorPath.setAttribute("class", "aw-grid-svg__minor");
  const gridMajorPath = document.createElementNS(SVG_NS, "path");
  gridMajorPath.setAttribute("class", "aw-grid-svg__major");
  gridSvg.append(gridMinorPath, gridMajorPath);
  gridLayer.append(gridSvg);
  const mapLayer = el("div", "aw-layer");
  const mapHint = el("div", "aw-maparea__hint");
  const zoomBox = el("div", "aw-zoom");
  const zoomLabel = el("span", "aw-zoom__label", "100%");
  const regionSelect = document.createElement("select");
  const mapTools = el("div", "aw-maptools");
  const travelBar = el("div", "aw-travel");
  const mapCanvas = el("div", "aw-maparea");
  // R01（M02 快捷视图）：叠加（默认）/ 纯网格 / 纯底图；只影响可见性
  let mapViewMode = "overlay";
  let mapBuilt = false;
  let mapScaleEl = null;
  let gridToggleEl = null;
  /** H16：在途 / 位置未确认的载具说明行（不画点，但必须让作者看得见）。 */
  let vehicleNoteEl = null;
  /** H16：着色图层是否可见（纯显示开关，绝不改数据）。 */
  let areaLayerVisible = true;
  // 0.9.50 标尺条：条 / 标签 / 详情元素与展开态（重建 renderMap 时保持展开）
  let scaleBarEl = null;
  let scaleLabelEl = null;
  let scaleDetailEl = null;
  let scaleDetailOpen = false;
  let scaleCalibrating = false;
  // 当前标尺条上下文（renderMap 时更新；setZoom 联动只重算条长，不动 detail）
  let scaleCtx = null;
  // 0.9.35 子图视图栈：空 = 世界图；每层 = {pointId, name}（点挂子图，递归）
  let mapStack = [];
  let mapStackKey = "";
  let mapCrumb = null;
  let mapPanel = null;
  /** R15 补（R08 残留）：当前面板锚点身份 {kind:"point"|"entity", id, el}——相机变更 /
   *  重新渲染后按身份找回新标记续锚；对象真消失则关闭面板。 */
  let mapPanelAnchor = null;
  let lastMapData = null;

  /** R08 网格盒原点（stage 空间；renderMap 按固定 frame 外扩设置）。 */
  let gridBoxOrigin = { x: 0, y: 0 };

  /** R08 相机施加：stage 变换 + 缩放百分比 + 标记反缩放 + 网格线宽 + 标尺条。 */
  const applyCamera = () => {
    if (!camera) return;
    const t = cameraStageTransform(camera, cameraViewport.w, cameraViewport.h);
    stage.style.transform = `translate(${t.tx}px, ${t.ty}px) scale(${t.k})`;
    zoomLabel.textContent = `${Math.round(cameraZoomPercent(camera))}%`;
    // 标记视觉尺寸 / 命中区域用屏幕像素控制（CSS scale(var(--aw-marker-inv)) 抵消
    // stage 缩放），与世界每格像素数分离——放大不再撑大按钮。
    mapLayer.style.setProperty("--aw-marker-inv", String(markerInverseScale(camera)));
    updateGridVisual();
    updateScaleBarVisual();
    // R15 补（R08 残留「弹窗随 pan / zoom / resize 重新定位」）：面板开着就跟着锚点走。
    // - 锚点元素仍在 DOM（同一次渲染内 pan / zoom）：直接重算贴边位置；
    // - 元素已被重新渲染替换：按身份（data-point-id / data-entity-id）找回新标记续锚；
    // - 身份也找不到（对象真的消失，如提交后账本里没了）：关闭面板，不留孤儿浮层。
    if (mapPanel && mapPanelAnchor && mapPanel.style.display !== "none") {
      const live = mapPanelAnchor.el?.isConnected
        ? mapPanelAnchor.el
        : (mapLayer?.querySelector(anchorSelector(mapPanelAnchor)) ?? null);
      if (live) {
        mapPanelAnchor.el = live;
        anchorPanelToMarker(live);
      } else {
        closeMapPanel();
      }
    }
  };

  /** 锚点身份 → 选择器（属性值里的引号 / 反斜杠转义掉，避免选择器注入）。 */
  function anchorSelector(anchor) {
    const safe = String(anchor.id).replace(/["\\]/g, "\\$&");
    return anchor.kind === "point" ? `[data-point-id="${safe}"]` : `[data-entity-id="${safe}"]`;
  }

  /** 相机变更统一出口：写回视图相机表（返回父层 / 重渲染可恢复），再施加 DOM。 */
  const commitCamera = (next) => {
    if (!next) return;
    camera = next;
    if (cameraViewKey) mapCameras.set(cameraViewKey, camera);
    applyCamera();
  };

  /**
   * H13（§2.6 / F12）：重绘**视口对齐**的 SVG 网格。
   *
   * 变换同源：`screen = world * k + t`，与 stage 的 translate+scale、与 `worldToScreen`
   * 完全一致；格线只由 H12 纯函数算出（次线 / 主线分开，次线在屏幕间距 <8px 时隐藏），
   * 所以放大后不会出现「几道粗大模糊线」。
   */
  function updateGridVisual() {
    if (!gridLayer || !camera || !gridSvg) return;
    const k = camera.k;
    if (!Number.isFinite(k) || k <= 0) return;
    const viewW = cameraViewport.w;
    const viewH = cameraViewport.h;
    if (!(viewW > 0) || !(viewH > 0) || !cameraFrame || !gridBoxOrigin) return;
    gridLayer.style.display = "";
    const stageTransform = typeof cameraStageTransform === "function"
      ? cameraStageTransform(camera, viewW, viewH)
      : { tx: viewW / 2 - camera.cx * k, ty: viewH / 2 - camera.cy * k, k };
    // 反变换：把 SVG 从 stage 的 scale(k) 里解出来，使它的局部坐标 1:1 等于屏幕 CSS 像素
    gridSvg.style.width = `${viewW}px`;
    gridSvg.style.height = `${viewH}px`;
    gridSvg.style.transform =
      `translate(${-gridBoxOrigin.x - stageTransform.tx / k}px, ${-gridBoxOrigin.y - stageTransform.ty / k}px) scale(${1 / k})`;

    const paths = typeof getVisibleGridPaths === "function"
      ? getVisibleGridPaths({
          viewport: { width: viewW, height: viewH },
          // 格线纯函数按「帧内整数格 0..cols」编号，所以把帧原点折算进平移量
          camera: {
            k: stageTransform.k,
            tx: stageTransform.tx + cameraFrame.minX * k,
            ty: stageTransform.ty + cameraFrame.minY * k,
          },
          frame: { cols: cameraFrame.spanX, rows: cameraFrame.spanY },
          extent: "viewport",
          devicePixelRatio: (typeof window !== "undefined" && window.devicePixelRatio) || 1,
        })
      : null;
    gridMinorPath.setAttribute("d", paths && typeof paths.minorPath === "string" ? paths.minorPath : "");
    gridMajorPath.setAttribute("d", paths && typeof paths.majorPath === "string" ? paths.majorPath : "");
    const stride = paths && Number.isFinite(paths.majorStep) && paths.majorStep > 0 ? paths.majorStep : 1;
    gridLayer.dataset.gridStride = String(stride);
    gridLayer.dataset.gridMinorHidden = paths && paths.minorHidden === true ? "1" : "0";
    /**
     * H19b（§2.6）：网格步长不再占用左下角常驻控件——它属于网格切换按钮的
     * tooltip / 可访问名称（「网格：1 格/线」/「主网格：5 格/线」）。
     * 左下角只留比例尺这一条常驻控件。
     */
    if (gridToggleEl) {
      const strideText = stride === 1 ? "网格：1 格/线" : "主网格：" + stride + " 格/线";
      gridToggleEl.title = strideText;
      gridToggleEl.setAttribute("aria-label", `网格显示切换（${strideText}）`);
    }
  }

  /** 0.9.50 标尺条视觉更新：标定图按候选距离画真实条长；未标定/旧式单位画桩线 + 文字。 */
  function updateScaleBarVisual() {
    if (!scaleBarEl || !scaleLabelEl || !scaleCtx) return;
    const { calibration } = scaleCtx;
    /**
     * H19a（§2.6）：固定长度动态标尺。
     *
     * - 线条长度只由视口宽度决定（96 CSS px，窄屏降到 64），**不随地图 stage 的 CSS
     *   transform 一起放大**，所以 camera.k 放大 2 倍，读数必然减半；
     * - `metersPerCell` 必须是正有限值才给米数；未标定就只报格数并写「未标定」，
     *   绝不静默填 1 米/格，也绝不把旧式未换算单位冒充成米（T25 / T29）；
     * - 只改 UI 读数，不写 metersPerCell，不碰任何已保存的格坐标。
     */
    const bar = typeof computeViewportScaleBar === "function"
      ? computeViewportScaleBar({
          cameraK: camera?.k ?? 0,
          metersPerCell: calibration ? calibration.metersPerCell : null,
          viewportWidth: viewport?.clientWidth ?? null,
        })
      : null;
    if (!bar) {
      // k ≤ 0 / 相机未就绪：不显示假刻度
      scaleBarEl.classList.add("is-stub");
      scaleBarEl.style.width = "";
      scaleLabelEl.textContent = "";
      return;
    }
    scaleBarEl.classList.toggle("is-stub", bar.unitMode === "cells");
    scaleBarEl.style.width = `${Math.round(bar.barWidthPx * 10) / 10}px`;
    scaleLabelEl.textContent = bar.label;
    // 可访问文案说清「屏幕 N 像素约等于 X」，不误说成「X 米/格」
    scaleLabelEl.setAttribute("aria-label", bar.ariaLabel);
  }

  /** 0.9.50 标定请求（AI 模式 / 人工模式共用一条路由；成功后 refresh 走 renderMap 重建详情）。 */
  async function runScaleCalibrate(payload, label) {
    if (scaleCalibrating) return;
    scaleCalibrating = true;
    try {
      const result = await api.request("POST", "/worlds/scale/calibrate", payload);
      const body = result.body ?? {};
      if (result.status === 200 && body.ok) {
        const status = String(body.data?.status ?? "");
        emitAtlasDiagnostic({ level: "info", source: "map", code: "SCALE_CALIBRATE_COMPLETE",
          operation: "scale", phase: "response", outcome: "success",
          httpStatus: result.status, details: { route: "/worlds/scale/calibrate" } });
        setStatus(String(body.data?.message ?? `${label}完成`), status === "calibrated" || status === "grounded" ? "ok" : "warn");
        await core.refresh();
      } else {
        emitAtlasDiagnostic({ level: "error", source: "map", code: "SCALE_CALIBRATE_FAILED",
          operation: "scale", phase: "response", outcome: "failed",
          httpStatus: result.status, errorCode: body.error?.code,
          details: { route: "/worlds/scale/calibrate" } });
        setStatus(body.error?.message ?? `${label}失败（HTTP ${result.status}）`, "error");
      }
    } catch {
      emitAtlasDiagnostic({ level: "error", source: "map", code: "SCALE_CALIBRATE_FAILED",
        operation: "scale", phase: "request", outcome: "failed",
        retryable: true, details: { route: "/worlds/scale/calibrate" } });
      setStatus("地图标定请求失败；请检查连接后重试。", "error");
    } finally {
      scaleCalibrating = false;
    }
  }

  /**
   * 0.9.50（M04）：标尺详情面板——每格距离 / 来源 / 依据 + AI 判断按钮 +
   * 人工标定输入（人工值默认锁定）。renderMap 时重建；缩放不重建（输入焦点安全）。
   */
  function rebuildScaleDetail(d, mapId, calibration, legacyScale) {
    if (!scaleDetailEl) return;
    scaleDetailEl.innerHTML = "";
    const chatId = String(state().chatId ?? "");
    const sourceLabel = calibration
      ? calibration.source === "user"
        ? "人工标定 · 已锁定"
        : calibration.source === "legacy"
          ? "旧式标定"
          : "AI 估计"
      : "";
    const headRow = el("div", "aw-scale__row aw-scale__row--head");
    if (calibration) {
      headRow.append(el("span", "aw-scale__cell", `每格 ≈ ${formatDistanceMeters(calibration.metersPerCell)}`));
      headRow.append(el("span", "aw-scale__src", sourceLabel));
      scaleDetailEl.append(headRow);
      if (calibration.coverage) scaleDetailEl.append(el("div", "aw-scale__row", `覆盖范围：${calibration.coverage}`));
      if (calibration.basis) scaleDetailEl.append(el("div", "aw-scale__row", `依据：${calibration.basis}`));
      if (calibration.source === "user" && calibration.locked) {
        scaleDetailEl.append(el("div", "aw-scale__row aw-scale__row--muted", "已锁定：AI 估计不会覆盖人工标定；重新填写并保存即可更新。"));
      }
    } else {
      // D06：未标定时如实说明「按格计算」——距离标签与标尺都不假装有米制含义
      headRow.append(el("span", "aw-scale__cell", legacyScale ? "未标定（按格计算）· 旧式比例尺" : "未标定（按格计算）"));
      scaleDetailEl.append(headRow);
      scaleDetailEl.append(el("div", "aw-scale__row aw-scale__row--muted", legacyScale
        ? `旧值「1 格 ≈ ${legacyScale.distancePerCell}${legacyScale.unit ? ` ${legacyScale.unit}` : ""}」没有标准单位换算，不能画成米制标尺；此前的距离一律按格数计算。可让 AI 按世界书与剧情重新判断，或直接填入每格米数。`
        : "当前距离一律按格数计算（不假装知道一米有多远）。可让 AI 按世界书与剧情判断这张图的实际范围，或直接填入每格米数（人工标定后锁定）。"));
    }
    // AI 按钮：人工锁定值不可被 AI 覆盖（服务端同样拒绝，双保险）
    const aiBtn = el("button", "aw-btn aw-btn--ghost aw-scale__action", calibration?.locked ? "AI 重新判断（已锁定）" : calibration ? "AI 重新判断地图大小" : "AI 判断地图大小");
    aiBtn.type = "button";
    aiBtn.disabled = Boolean(calibration?.locked);
    aiBtn.setAttribute("aria-label", "用 1 次推演请求让 AI 判断当前地图的实际范围并换算每格米数");
    aiBtn.addEventListener("click", async () => {
      if (scaleCalibrating || !chatId) return;
      aiBtn.disabled = true;
      try {
        const lore = await readCardLoreSupplement();
        await runScaleCalibrate({ chatId, mapId, ...(lore ? { loreSupplement: lore } : {}) }, "AI 尺度标定");
      } finally {
        aiBtn.disabled = false;
      }
    });
    // 人工标定：每格米数（程序同步派生整图宽高，不存在第二份独立宽高）
    const manualInput = document.createElement("input");
    manualInput.type = "number";
    manualInput.min = "0";
    manualInput.step = "any";
    manualInput.placeholder = "每格米数";
    manualInput.className = "aw-scale__input";
    manualInput.setAttribute("aria-label", "每格实际距离（米）");
    if (calibration) manualInput.value = String(calibration.metersPerCell);
    const manualBtn = el("button", "aw-btn aw-btn--ghost aw-scale__action", "人工标定（锁定）");
    manualBtn.type = "button";
    manualBtn.addEventListener("click", async () => {
      if (scaleCalibrating || !chatId) return;
      const meters = Number(manualInput.value);
      if (!Number.isFinite(meters) || meters <= 0) {
        setStatus("人工标定需要正的每格米数。", "error");
        return;
      }
      manualBtn.disabled = true;
      try {
        await runScaleCalibrate({ chatId, mapId, userMetersPerCell: meters, basis: "人工标定" }, "人工尺度标定");
      } finally {
        manualBtn.disabled = false;
      }
    });
    const manualRow = el("div", "aw-scale__row aw-scale__row--actions");
    manualRow.append(manualInput, manualBtn);
    scaleDetailEl.append(aiBtn, manualRow);
  }

  function buildMap() {
    if (mapBuilt) return mapCanvas;
    mapBuilt = true;
    stage.append(imageLayer, areaLayer, gridLayer, mapLayer);
    viewport.append(stage);
    // 0.9.49（M03）：视口尺寸变化 → 等比布局重算（cellPx / 留白 / 格网同步刷新）
    if (typeof ResizeObserver === "function") {
      let resizeTimer = null;
      let lastW = 0;
      let lastH = 0;
      const observer = new ResizeObserver((entries) => {
        const rect = entries[0]?.contentRect;
        if (!rect) return;
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);
        if (w === lastW && h === lastH) return;
        lastW = w;
        lastH = h;
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (state().page === "map" && lastMapData) {
            // R08：视口尺寸变化 → 各视图相机按新视口重新 fitAll（等比布局重算）
            mapCameras.clear();
            renderMap(data());
          }
        }, 120);
      });
      observer.observe(viewport);
    }
    for (const corner of ["tl", "tr", "bl", "br"]) viewport.append(el("span", `aw-corner aw-corner--${corner}`));
    const compass = el("div", "aw-compass");
    compass.append(el("span", "aw-compass__n", "N"), el("i", "aw-compass__needle"));
    // 0.9.50（M05）：比例尺元素升级为动态标尺条 + 可展开详情。
    // 条长 = 真实标尺距离 ÷ metersPerPixel（按候选 1-2-5×10^n 选取），随 zoom / resize 重算；
    // 详情 = 每格距离 / 来源 / 依据 + AI 判断按钮 + 人工标定（锁定）。
    mapScaleEl = el("div", "aw-scale");
    scaleBarEl = el("span", "aw-scale__bar");
    scaleLabelEl = el("span", "aw-scale__label", "");
    const scaleToggle = el("button", "aw-scale__toggle");
    scaleToggle.type = "button";
    scaleToggle.setAttribute("aria-label", "标尺详情：点击展开每格距离、来源与标定操作");
    scaleToggle.append(scaleBarEl, scaleLabelEl);
    scaleDetailEl = el("div", "aw-scale__detail");
    scaleToggle.addEventListener("click", () => {
      scaleDetailOpen = !scaleDetailOpen;
      mapScaleEl.classList.toggle("is-detail-open", scaleDetailOpen);
    });
    mapScaleEl.append(scaleToggle, scaleDetailEl);
    // H19b（§2.6）：左下角**只有**比例尺这一条常驻控件。
    // 旧的 `aw-grid-stride`（「网格：1 格/线」/「未标定」叠加框）已删除——
    // 网格步长改挂到右上角网格按钮的 tooltip / 可访问名称。
    viewport.append(compass, mapScaleEl);
    // R08：＋/－ 以视口中心为锚缩放；⌂ = fitAll 全图适配（重置是单独操作，
    // 回到 100% 不再连带清空平移——旧 setZoom(1) 清 pan 的行为删除）；
    // ⌖ = 定位当前位置（保持比例，视口中心对准玩家）。
    const zoomByFactor = (factor) => {
      if (!camera) return;
      commitCamera(setCameraZoom(camera, camera.k * factor));
    };
    for (const [label, aria, action] of [
      ["＋", "放大地图", () => zoomByFactor(1.25)],
      ["－", "缩小地图", () => zoomByFactor(0.8)],
      ["⌂", "全图适配（重置缩放与平移）", () => {
        if (cameraFrame) commitCamera(fitCamera(cameraFrame, cameraViewport.w, cameraViewport.h));
      }],
      ["⌖", "定位当前位置", () => locatePlayerCamera()],
    ]) {
      const btn = el("button", "aw-zoom__btn", label);
      btn.type = "button";
      btn.setAttribute("aria-label", aria);
      btn.addEventListener("click", action);
      zoomBox.append(btn);
    }
    zoomBox.append(zoomLabel);
    regionSelect.className = "aw-region";
    regionSelect.setAttribute("aria-label", "按地区筛选地图点位");
    regionSelect.addEventListener("change", () => {
      regionFilter = regionSelect.value;
      // 必须走整页重渲染：地图点位 / NPC 标记都要按新筛选重算，
      // 只调 renderCenter 会留下未筛选的旧标记。
      renderPage();
    });
    mapTools.append(regionSelect);
    // R01（M02）：网格 / 底图 / 叠加 快捷视图切换——只改图层可见性，不碰坐标与标定
    const viewSwitch = el("div", "aw-mapview");
    viewSwitch.setAttribute("role", "group");
    viewSwitch.setAttribute("aria-label", "地图图层视图：叠加、纯网格或纯底图");
    for (const [mode, label, aria] of [
      ["overlay", "叠加", "叠加显示底图与网格"],
      ["grid", "网格", "只显示网格"],
      ["image", "底图", "只显示底图"],
    ]) {
      const viewBtn = el("button", "aw-mapview__btn", label);
      viewBtn.type = "button";
      viewBtn.dataset.mode = mode;
      viewBtn.setAttribute("aria-label", aria);
      viewBtn.setAttribute("aria-pressed", String(mapViewMode === mode));
      viewBtn.addEventListener("click", () => {
        mapViewMode = mode;
        viewSwitch.querySelectorAll(".aw-mapview__btn").forEach((n) => n.setAttribute("aria-pressed", String(n.dataset.mode === mode)));
        if (lastMapData) renderMap(data());
      });
      // H19b：网格步长信息挂在网格按钮上（tooltip / 可访问名称），不再占左下角
      if (mode === "grid") gridToggleEl = viewBtn;
      viewSwitch.append(viewBtn);
    }
    mapTools.append(viewSwitch, zoomBox);
    /**
     * H20（0.9.59）：图例搬进右上**可折叠**工具条。
     *
     * 常驻图例一直占着地图左下角，在小屏上压住标点、还挡拖拽；改成默认收起的「图例」
     * 按钮（aria-expanded 如实反映状态），需要时再展开。网格步长已经挂在网格按钮的
     * tooltip / 可访问名称上（H19b），所以这里只管图例，不再单列一行。
     */
    const legendToggle = el("button", "aw-btn aw-btn--ghost aw-maptools__toggle", "图例");
    legendToggle.type = "button";
    legendToggle.setAttribute("aria-expanded", "false");
    legendToggle.setAttribute("aria-label", "展开或收起地图图例");
    const legendPanel = el("div", "aw-maptools__more");
    legendPanel.style.display = "none";
    legendToggle.addEventListener("click", () => {
      const open = legendToggle.getAttribute("aria-expanded") === "true";
      legendToggle.setAttribute("aria-expanded", String(!open));
      legendPanel.style.display = open ? "none" : "";
    });
    mapTools.append(legendToggle, legendPanel);
    /**
     * H16（0.9.59）：**已验证的着色图层**开关，放进右上角可收起区。
     *
     * 只管「有没有证据的格染不染色」这一件事：
     * - 关掉只是不显示，**不动任何数据**（areas 仍在会话里，重开即回）；
     * - 与视图切换（叠加/网格/底图）正交——那两个管底图与网格，这个管着色；
     * - `aria-pressed` 如实反映状态，窄屏折叠后不占地图。
     */
    const areaToggle = el("button", "aw-btn aw-btn--ghost aw-maptools__toggle", "着色图层");
    areaToggle.type = "button";
    areaToggle.setAttribute("aria-pressed", "true");
    areaToggle.setAttribute("aria-label", "显示或隐藏有证据的范围着色");
    areaToggle.addEventListener("click", () => {
      areaLayerVisible = !areaLayerVisible;
      areaToggle.setAttribute("aria-pressed", String(areaLayerVisible));
      areaLayer.style.display = areaLayerVisible ? "" : "none";
    });
    legendPanel.append(areaToggle);
    // 0.9.24 世界书提炼地理；0.9.26 地图抢救：geoBar 常显 + 新增「从近期剧情提炼新地点」
    // （复用同一条 adopt 管线：重名自动跳过，产出只增不改——地图跟着剧情长）
    const geoBar = el("div", "aw-geobar");
    const geoBtn = el("button", "aw-btn aw-btn--primary", "从世界书提炼地理");
    geoBtn.type = "button";
    geoBtn.setAttribute("aria-label", "用一次推演请求从角色卡世界书提炼地区与地点并加入地图");
    let geoBusy = false;
    /** 0.9.26 剧情提炼素材：最近 AI 楼层（服务端按地名去重，重复提及无妨）。 */
    const readRecentFloors = () => {
      try {
        const ctx = SillyTavern.getContext();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
        const texts = [];
        for (let i = chat.length - 1; i >= 0 && texts.length < 10; i--) {
          const message = chat[i];
          if (message && message.is_user === false && typeof message.mes === "string" && message.mes.trim()) {
            texts.unshift(message.mes.slice(0, 2000));
          }
        }
        return texts;
      } catch { return []; }
    };
    const runGeoAdopt = async (payload, label) => {
      const result = await api.request("POST", "/worlds/geo/adopt", payload);
      const data = result.body?.data ?? {};
      if (result.status === 200 && result.body?.ok) {
        emitAtlasDiagnostic({ level: "info", source: "map", code: "GEO_ADOPT_COMPLETE",
          operation: "geo", phase: "response", outcome: "success",
          httpStatus: result.status, details: { route: "/worlds/geo/adopt",
            count: Number(data.pointsAdded ?? 0) } });
        setStatus(`提炼完成：新增 ${data.regionsAdded ?? 0} 地区 / ${data.pointsAdded ?? 0} 地点${data.skipped ? `（重名跳过 ${data.skipped}）` : ""}。`, "ok");
        await core.refresh();
      } else {
        emitAtlasDiagnostic({ level: "error", source: "map", code: "GEO_ADOPT_FAILED",
          operation: "geo", phase: "response", outcome: "failed",
          httpStatus: result.status, errorCode: result.body?.error?.code,
          details: { route: "/worlds/geo/adopt" } });
        setStatus(result.body?.error?.message ?? `提炼失败（HTTP ${result.status}）`, "error");
      }
    };
    geoBtn.addEventListener("click", async () => {
      if (geoBusy) return;
      const confirmed = typeof window === "undefined" || typeof window.confirm !== "function"
        ? true
        : window.confirm("用 1 次推演请求从角色卡世界书提炼地区 / 地点并加入地图（重名自动跳过），继续？");
      if (!confirmed) return;
      geoBusy = true;
      try {
        const lore = await readCardLoreSupplement();
        if (!lore) {
          setStatus("没有可用的世界书资料——检查卡书是否有启用条目，或先在「推进」页开启「世界书资料」。", "error");
          return;
        }
        const chatId = String(state().chatId ?? "");
        if (!chatId) { setStatus("当前没有活动聊天。", "error"); return; }
        await runGeoAdopt({ chatId, loreSupplement: lore }, "世界书提炼");
      } catch (error) {
        setStatus(`提炼失败：${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        geoBusy = false;
      }
    });
    const storyGeoBtn = el("button", "aw-btn", "从近期剧情提炼新地点");
    storyGeoBtn.type = "button";
    storyGeoBtn.setAttribute("aria-label", "用一次推演请求从近期剧情提炼新出现的地点并加入地图（已有地点自动跳过）");
    storyGeoBtn.addEventListener("click", async () => {
      if (geoBusy) return;
      const recentTexts = readRecentFloors();
      if (recentTexts.length === 0) {
        setStatus("最近没有可用的 AI 楼层——先和角色对话几轮，再从剧情提炼。", "error");
        return;
      }
      const confirmed = typeof window === "undefined" || typeof window.confirm !== "function"
        ? true
        : window.confirm(`用 1 次推演请求从最近 ${recentTexts.length} 条 AI 楼层提炼新地点并加入地图（重名自动跳过），继续？`);
      if (!confirmed) return;
      geoBusy = true;
      try {
        const chatId = String(state().chatId ?? "");
        if (!chatId) { setStatus("当前没有活动聊天。", "error"); return; }
        let lore = "";
        try { lore = (await readCardLoreSupplement()) ?? ""; } catch { lore = ""; }
        await runGeoAdopt({ chatId, recentTexts, ...(lore ? { loreSupplement: lore } : {}) }, "剧情提炼");
      } catch (error) {
        setStatus(`提炼失败：${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        geoBusy = false;
      }
    });
    geoBar.append(geoBtn, storyGeoBtn);
    // 0.9.43 底部堆叠修复（0.9.46 补提交）：长提示挪页头，工具条只留按钮
    // 0.9.35 子图面包屑 + 标记点信息面板
    mapCrumb = el("div", "aw-mapcrumb");
    mapCrumb.style.display = "none";
    mapPanel = el("div", "aw-mappanel");
    mapPanel.style.display = "none";
    // R08 地图手势（状态机在 src/atlas-map-interactions.ts，可完整测试）：
    // - 空白 pointerdown 超过阈值才 pan；按钮 / 输入框 / 弹层起手不启动拖拽。
    // - 双指 = pinch 缩放（中点锚定）；单指回落重启平移基线。
    // - pointercancel / capture 释放；pan 结束的合成 click 被吞，不当空白点击。
    const panGesture = createPanGesture();
    const pinch = createPinchTracker();
    const activePointers = new Map();
    const GESTURE_BLOCK_SELECTOR =
      "button, input, select, textarea, label, .aw-mappanel, .aw-maptools, .aw-scale, .aw-mapcrumb, .aw-maplegend, .aw-travel, .aw-zoom";
    viewport.addEventListener("pointerdown", (e) => {
      if (!camera) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const interactive = Boolean(e.target?.closest?.(GESTURE_BLOCK_SELECTOR));
      /**
       * H15b：绘制模式**独占**网格点击——不启动平移，把这一下当成「选中/取消一个格」。
       * 工具栏 / 弹层等交互元素仍然照常可点（interactive 优先）。
       */
      if (areaDraw.active && !interactive) {
        const cell = areaDrawCellAt(e.clientX, e.clientY);
        if (cell) {
          const key = `${cell.x},${cell.y}`;
          if (areaDraw.cells.has(key)) areaDraw.cells.delete(key); else areaDraw.cells.add(key);
          renderAreaDraw();
        }
        return;
      }
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activePointers.size >= 2) {
        panGesture.cancel(); // 进入双指：终止单指平移
        pinch.down(e.pointerId, e.clientX, e.clientY);
        viewport.setPointerCapture?.(e.pointerId);
        return;
      }
      if (interactive) return; // 按钮 / 输入框 / 弹层起手：不启动手势，也不抢 pointer capture（capture 会把合成 click 重定向给 viewport，按钮点击就废了）
      panGesture.down(e.clientX, e.clientY);
      viewport.setPointerCapture?.(e.pointerId);
    });
    viewport.addEventListener("pointermove", (e) => {
      if (!camera) return;
      if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch.active) {
        const update = pinch.move(e.pointerId, e.clientX, e.clientY);
        if (update) {
          const rect = viewport.getBoundingClientRect();
          commitCamera(zoomCameraAtPoint(camera, update.x - rect.left, update.y - rect.top, viewport.clientWidth || 0, viewport.clientHeight || 0, update.factor));
        }
        return;
      }
      const step = panGesture.move(e.clientX, e.clientY);
      if (step?.panning) commitCamera(panCameraBy(camera, step.dx, step.dy));
    });
    const endMapPointer = (e, cancelled) => {
      if (activePointers.has(e.pointerId)) {
        activePointers.delete(e.pointerId);
        if (cancelled) pinch.cancel();
        else pinch.up(e.pointerId);
      }
      if (pinch.active) return;
      if (activePointers.size === 1) {
        // 双指回落到单指：以剩余指位重启平移基线
        const [only] = [...activePointers.values()];
        panGesture.cancel();
        panGesture.down(only.x, only.y);
        return;
      }
      if (cancelled) panGesture.cancel();
      else panGesture.up(); // suppress 标记保留给 click 消费（不在 pointerup 提前清除）
    };
    viewport.addEventListener("pointerup", (e) => endMapPointer(e, false));
    viewport.addEventListener("pointercancel", (e) => endMapPointer(e, true));
    // 光标缩放：光标下世界点不漂移（zoomCameraAtPoint）；ctrl+滚轮 = 触控板捏合细步
    viewport.addEventListener("wheel", (e) => {
      if (!camera) return;
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const factor = e.ctrlKey
        ? Math.min(2, Math.max(0.5, Math.exp(-e.deltaY * 0.01)))
        : e.deltaY < 0 ? 1.2 : 1 / 1.2;
      commitCamera(zoomCameraAtPoint(camera, e.clientX - rect.left, e.clientY - rect.top, viewport.clientWidth || 0, viewport.clientHeight || 0, factor));
    }, { passive: false });
    // 0.9.47 mapview 同款交互：点地图空白处 / 按 ESC 关面板；面板内点击不冒泡
    viewport.addEventListener("click", () => {
      if (panGesture.consumeClick()) return; // pan 结束的合成 click 不当空白点击
      closeMapPanel();
    });
    mapPanel.addEventListener("click", (e) => e.stopPropagation());
    viewport.append(interiorRoster, mapPanel);
    // 0.9.41 图例：地点 / 人物 / 物品三型标点（原型 mapview 同款信息架构）
    // 0.9.43 真修（0.9.46 补提交）：el() 第三参只吃文本——DOM 节点会被 textContent
    // 强转成 "[object HTMLElement]"，标签文字（第 4 参）则被静默丢弃。
    // S9（0.9.55）：地图上不再有人物标点，人物改由地点面板名单承载——图例必须说实话，
    // 否则用户按图例找金色圆点会一无所获。金色小圆仍与名单里的头像同色，图例继续对应得上。
    const legendItem = (dotClass, label) => {
      const item = el("span", "aw-maplegend__item");
      item.append(el("i", dotClass), document.createTextNode(label));
      return item;
    };
    const legend = el("div", "aw-maplegend");
    legend.append(
      legendItem("aw-maplegend__dot aw-maplegend__dot--loc", "地点"),
      legendItem("aw-maplegend__dot aw-maplegend__dot--npc", "人物：进内部地图后按房间显示"),
      legendItem("aw-maplegend__dot aw-maplegend__dot--obj", "物品"),
    );
    legendPanel.append(legend);
    /**
     * H15b：绘制模式工具栏（默认隐藏）。出现时机只有一个——用户在地点详情里
     * 显式点了「编辑范围」。它自己**不改任何数据**：保存才走 H15a，撤销只清未提交选区。
     */
    const areaDrawBar = el("div", "aw-areadraw");
    areaDrawBar.style.display = "none";
    areaDrawBar.setAttribute("role", "group");
    areaDrawBar.setAttribute("aria-label", "范围绘制：保存、撤销或退出");
    const areaDrawLabel = el("span", "aw-areadraw__label", "绘制范围");
    const areaDrawCount = el("span", "aw-areadraw__count", "0 格");
    const areaDrawSave = el("button", "aw-btn aw-btn--primary", "保存范围");
    areaDrawSave.type = "button";
    areaDrawSave.addEventListener("click", () => void saveAreaDraw());
    const areaDrawUndo = el("button", "aw-btn aw-btn--ghost", "撤销选区");
    areaDrawUndo.type = "button";
    areaDrawUndo.setAttribute("aria-label", "清空本次未提交的选区");
    areaDrawUndo.addEventListener("click", () => { areaDraw.cells.clear(); renderAreaDraw(); });
    const areaDrawExit = el("button", "aw-btn aw-btn--ghost", "退出编辑");
    areaDrawExit.type = "button";
    areaDrawExit.setAttribute("aria-label", "退出范围绘制并恢复地图平移");
    areaDrawExit.addEventListener("click", () => endAreaDraw());
    areaDrawBar.append(areaDrawLabel, areaDrawCount, areaDrawSave, areaDrawUndo, areaDrawExit);
    viewport.append(areaDrawBar);
    areaDrawRefs.viewport = viewport;
    areaDrawRefs.layer = areaLayer;
    areaDrawRefs.bar = areaDrawBar;
    areaDrawRefs.count = areaDrawCount;
    /**
     * H16：在途 / 锚点未知的载具**不画点**（没有确认坐标，画出来就是伪造），
     * 但也不能就此消失——由这一行如实列出「它们还没停稳」。
     */
    vehicleNoteEl = el("div", "aw-note aw-mapvehicle-note");
    vehicleNoteEl.style.display = "none";
    viewport.append(vehicleNoteEl);
    mapCanvas.append(mapCrumb, mapTools, viewport, mapHint, geoBar, travelBar);
    return mapCanvas;
  }

  /**
   * R08 定位当前位置：保持比例，视口中心对准玩家所在地点。
   * S8（0.9.55）：玩家在子地点（建筑内的房间）时，世界图看不到该点——
   * 此时沿 pointParents 上溯到**最近的根祖先**并在世界图标出，同时提示「在某建筑内」。
   * 仍只允许世界图使用（子图视图下不定位，避免跨图混淆）。
   */
  function locatePlayerCamera() {
    if (!camera || !cameraFrame) return;
    if (mapStack.length > 0) {
      setStatus("定位当前位置只在世界图可用。", "warn");
      return;
    }
    const d = lastMapData;
    const worldPoints = Array.isArray(d?.map?.points) ? d.map.points : [];
    const currentId = String(d?.currentLocationId ?? "");
    const direct = worldPoints.find((p) => String(p.id) === currentId);
    if (direct) {
      commitCamera(centerCameraOn(camera, Number(direct.x), Number(direct.y)));
      return;
    }
    // 当前是子地点：沿父链上溯到最近的根地点（世界图上存在的那个）
    const parents = d?.map?.pointParents && typeof d.map.pointParents === "object" ? d.map.pointParents : {};
    const seen = new Set([currentId]);
    let cursor = currentId;
    let hops = 0;
    while (hops < MAP_SUBMAP_DEPTH_MAX + 1) {
      const parentId = String(parents[cursor] ?? "");
      if (!parentId || seen.has(parentId)) break;
      seen.add(parentId);
      hops += 1;
      const ancestor = worldPoints.find((p) => String(p.id) === parentId);
      if (ancestor) {
        commitCamera(centerCameraOn(camera, Number(ancestor.x), Number(ancestor.y)));
        setStatus(`当前位置在「${String(ancestor.name)}」内（子地点未显示在世界图）——进入该地点可查看内层地图。`, "info");
        return;
      }
      cursor = parentId;
    }
    setStatus("当前位置不在地图上。", "warn");
  }

  /** 0.9.35 返回上一层子图（世界图 = 栈空）。R08：相机按视图持久化，返回恢复原相机。 */
  function popMapStack() {
    mapStack.pop();
    closeMapPanel();
    renderMap(data());
  }

  function closeMapPanel() {
    if (mapPanel) {
      mapPanel.style.display = "none";
      mapPanel.innerHTML = "";
    }
    mapPanelAnchor = null;
    mapLayer?.querySelectorAll(".is-active-marker").forEach((n) => n.classList.remove("is-active-marker"));
  }

  /** 0.9.35 面包屑：子图层级 + 返回按钮。 */
  function renderMapCrumb(d, view, currentSub) {
    if (!mapCrumb) return;
    mapCrumb.innerHTML = "";
    if (!view || !currentSub) {
      mapCrumb.style.display = "none";
      return;
    }
    mapCrumb.style.display = "";
    const back = el("button", "aw-mapcrumb__back", `← 返回${mapStack.length > 1 ? "上一层" : "世界图"}`);
    back.type = "button";
    back.setAttribute("aria-label", "返回上一层地图");
    back.addEventListener("click", () => popMapStack());
    // 0.9.49（M02 面包屑修正）：祖先链全部可点击（截断视图栈跳回该层）；
    // 当前层显示子图真名（旧实现拼栈内点名还标成「内部」，层级语义是糊的）
    const trail = el("span", "aw-mapcrumb__trail");
    const rootLink = el("button", "aw-mapcrumb__link", "世界图");
    rootLink.type = "button";
    rootLink.setAttribute("aria-label", "返回世界图");
    rootLink.addEventListener("click", () => {
      mapStack = [];
      renderMap(data());
    });
    trail.append(rootLink);
    mapStack.forEach((item, i) => {
      trail.append(el("span", "aw-mapcrumb__sep", "›"));
      const isCurrent = i === mapStack.length - 1;
      const label = isCurrent ? String(currentSub.name || item.name) : String(item.name);
      const link = el("button", `aw-mapcrumb__link${isCurrent ? " is-current" : ""}`, label);
      link.type = "button";
      if (isCurrent) {
        link.disabled = true;
        link.setAttribute("aria-current", "page");
      } else {
        link.setAttribute("aria-label", `跳回 ${label}`);
        link.addEventListener("click", () => {
          mapStack = mapStack.slice(0, i + 1);
          renderMap(data());
        });
      }
      trail.append(link);
    });
    mapCrumb.append(back, trail);
  }

  /** 0.9.35 标记点简略信息面板：名称 / 地区 / 描述 / 路线预览 / 进入子图。 */
  /** 0.9.47 锚定弹出（mapview 同款交互）：面板贴着标点弹，越界翻边，标点高亮。 */
  function anchorPanelToMarker(anchorEl) {
    if (!mapPanel) return;
    mapLayer?.querySelectorAll(".is-active-marker").forEach((n) => n.classList.remove("is-active-marker"));
    if (!anchorEl) {
      mapPanelAnchor = null;
      mapPanel.style.left = "";
      mapPanel.style.top = "";
      return;
    }
    // R15：记录锚点身份，供相机变更 / 重新渲染后续锚（身份取不到则退回「不续锚」的老行为）
    const rawId = anchorEl.dataset?.pointId ?? anchorEl.dataset?.entityId ?? null;
    mapPanelAnchor = rawId === null
      ? null
      : { kind: anchorEl.dataset?.pointId !== undefined ? "point" : "entity", id: String(rawId), el: anchorEl };
    anchorEl.classList.add("is-active-marker");
    const vr = viewport.getBoundingClientRect();
    const mr = anchorEl.getBoundingClientRect();
    const panelW = mapPanel.offsetWidth || 280;
    const panelH = mapPanel.offsetHeight || 240;
    let left = mr.right - vr.left + 10;
    if (left + panelW > vr.width - 10) left = mr.left - vr.left - panelW - 10;
    if (left < 10) left = Math.max(10, (vr.width - panelW) / 2);
    let top = mr.top - vr.top;
    top = Math.min(Math.max(8, top), Math.max(8, vr.height - panelH - 10));
    mapPanel.style.left = `${Math.round(left)}px`;
    mapPanel.style.top = `${Math.round(top)}px`;
    mapPanel.style.right = "auto";
  }

  /**
   * S9（0.9.55）人物纠偏：拖拽入口从地图上的 NPC 头像搬到**人物头像本身**
   * （地点面板「当前在这里」名单 / 人物卡片头部）。手势状态机同源
   * （src/atlas-map-interactions.ts createHoldDragGesture），差别只在起拖门槛 = 长按：
   * - 短按（未达 MAP_LONGPRESS_HOLD_MS）= 点击 → 打开人物详情；长按未成立前的移动
   *   视为列表滚动 / 选择文字，本次按下作废，绝不误起拖；
   * - 长按成立后头像进入 is-armed 态，位移即起拖，影子跟随光标；
   * - 起拖期间地图面板让出命中（is-drag-source：pointer-events:none），
   *   否则面板压在地图上，落点标点永远命不中；
   * - 松手命中 .aw-point → confirm → move-author（账本 source=author）；非标点处松手不写世界；
   * - 命中检测只认 .aw-point，天然排除影子（pointer-events:none）；
   * - suppressClick（长按成立过 / 拖拽过）不在 pointerup 提前清除，由 click 事件
   *   consumeClick() 吞掉合成 click——否则长按松手会顺手把详情面板打开。
   */
  /**
   * S9（0.9.55）：这个标点是不是**真实世界地点**——世界图根地点（/state map.points），
   * 或 v2 子地点（S8 的 map.pointParents 里有父链，说明它带 parentPointId 落进了 world.points）。
   * 旧版 v1 子图的 sub-* 只在布局 sidecar 里，账本无此地点。
   */
  function isRealWorldPoint(pointId) {
    const d = lastMapData;
    if (!d) return false;
    const id = String(pointId);
    const roots = Array.isArray(d.map?.points) ? d.map.points : [];
    if (roots.some((p) => String(p.id) === id)) return true;
    const parents = d.map?.pointParents;
    return Boolean(parents && typeof parents === "object" && Object.prototype.hasOwnProperty.call(parents, id));
  }

  function attachPersonDrag(handleEl, npc, onClick = null) {
    if (typeof createHoldDragGesture !== "function") return; // 旧 dist 兜底：保留点击，不假装能拖
    // 常量缺失（旧 dist）时给安全回退：绝不能退化成 0ms —— 那会让轻轻一按就起拖、点击全被吞。
    const holdMs = Number.isFinite(MAP_LONGPRESS_HOLD_MS) && MAP_LONGPRESS_HOLD_MS > 0 ? MAP_LONGPRESS_HOLD_MS : 350;
    const gesture = createHoldDragGesture();
    let ghost = null;
    let holdTimer = null;
    const clearHoldTimer = () => {
      if (holdTimer !== null) {
        globalThis.clearTimeout(holdTimer);
        holdTimer = null;
      }
    };
    const removeGhost = () => {
      if (ghost) {
        ghost.remove();
        ghost = null;
      }
    };
    const endVisual = () => {
      clearHoldTimer();
      handleEl.classList.remove("is-armed", "is-dragging");
      mapPanel?.classList.remove("is-drag-source");
      removeGhost();
    };
    handleEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      gesture.down(e.clientX, e.clientY);
      handleEl.setPointerCapture?.(e.pointerId);
      clearHoldTimer();
      holdTimer = globalThis.setTimeout(() => {
        holdTimer = null;
        if (!gesture.hold()) return; // 期间移动过 / 已松手：本次按下作废
        handleEl.classList.add("is-armed");
        mapPanel?.classList.add("is-drag-source");
        setStatus(`长按已就绪：把「${String(npc.name)}」拖到地图上的地点标点后松手。`, "info");
      }, holdMs);
    });
    handleEl.addEventListener("pointermove", (e) => {
      const step = gesture.move(e.clientX, e.clientY);
      if (!step) return;
      if (step.dragging && !ghost) {
        handleEl.classList.add("is-dragging");
        ghost = el("div", "aw-dragghost", String(npc.name ?? "?").slice(0, 1));
        ghost.setAttribute("aria-hidden", "true");
        viewport.append(ghost);
      }
      if (ghost) {
        const rect = viewport.getBoundingClientRect();
        ghost.style.left = `${e.clientX - rect.left}px`;
        ghost.style.top = `${e.clientY - rect.top}px`;
      }
    });
    const finishDrag = (e, cancelled) => {
      const wasDragging = gesture.isDragging;
      if (cancelled) gesture.cancel();
      else gesture.up();
      endVisual();
      if (cancelled || !wasDragging) return; // 原地松手 = 点击（长按成立过的 click 由 consumeClick 吞掉）
      const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".aw-point");
      const toPointId = hit?.dataset?.pointId ?? null;
      if (!toPointId) {
        setStatus("拖动取消：请把人物拖到目标地点标点上。", "error");
        return;
      }
      // S9：落点必须是**真实世界地点**——世界图根地点，或 v2 的子地点（S8 的 pointParents
      // 里有父链）。旧版 v1 子图的 sub-* 是布局虚拟点，账本里不存在该地点，move-author
      // 必然拒绝；与其让用户吃一次服务端错误，不如在落点处就说清楚。
      if (!isRealWorldPoint(toPointId)) {
        setStatus(`「${String(hit.textContent ?? "该点").trim()}」不是世界地点（旧版子图的虚拟内层点），不能作为纠偏落点。`, "error");
        return;
      }
      const chatId = String(state().chatId ?? "");
      const entityId = String(npc.id ?? "");
      if (!chatId || !entityId) return;
      const label = String(hit.textContent ?? "目标地点").trim();
      const ok = globalThis.confirm?.(`把「${String(npc.name)}」拖到「${label}」？作者纠偏会写入世界（账本留痕）。`) ?? false;
      if (!ok) return;
      void api
        .request("POST", "/worlds/move-author", { chatId, entityId, toPointId })
        .then((result_) => {
          if (result_.status === 200 && result_.body?.ok) {
            setStatus(`已把「${String(npc.name)}」拖到「${label}」。`, "ok");
            void core.refresh();
          } else {
            setStatus(result_.body?.error?.message ?? `纠偏失败（HTTP ${result_.status}）`, "error");
          }
          renderCenter();
        })
        .catch((error) => {
          setStatus(`纠偏失败：${error instanceof Error ? error.message : String(error)}`, "error");
          renderCenter();
        });
    };
    handleEl.addEventListener("pointerup", (e) => finishDrag(e, false));
    handleEl.addEventListener("pointercancel", (e) => finishDrag(e, true));
    // 点击（未被长按 / 拖拽吞掉时）
    handleEl.addEventListener("click", (e) => {
      e.stopPropagation();
      if (gesture.consumeClick()) return; // 长按或拖拽结束的合成 click：吞掉，不打开详情
      onClick?.(handleEl);
    });
  }

  /** 0.9.49（M02 跨层定位）：回到世界图并打开目标地点的信息面板（在场名单 / 进子图入口都在那里）。 */
  function locateToPointPanel(pointId) {
    closeMapPanel();
    const d = lastMapData;
    if (!d) return;
    const target = (Array.isArray(d.map?.points) ? d.map.points : []).find((p) => String(p.id) === String(pointId));
    if (!target) return;
    if (mapStack.length > 0) {
      mapStack = [];
      renderMap(data());
    }
    const marker = mapLayer?.querySelector(`[data-point-id="${String(pointId)}"]`) ?? null;
    openMapPanel(target, { inSub: false, currentSub: null }, marker);
  }

  /**
   * S8（0.9.55）：能否进入某个子图。
   * 深度上限与后端一致——SUBMAP_DEPTH_MAX = 4 表示**最多四张连续子图**
   * （世界图不算）：世界 → 第1 → 第2 → 第3 → 第4。mapStack.length 即已进入的层数，
   * 故「已进 4 层」时不再下钻（第 5 张被拒绝）。旧实现写死 `>= 3`，与后端不一致，
   * 导致第 4 张子图在 UI 侧永远进不去。
   * 同时按 parentMapId 校验父链，避免跨图误挂。
   */
  const MAP_SUBMAP_DEPTH_MAX = 4;
  function hasChildSubmap(submaps, pointId) {
    const id = String(pointId);
    const child = submaps[id];
    if (!child || mapStack.length >= MAP_SUBMAP_DEPTH_MAX || mapStack.some((item) => item.pointId === id)) return false;
    const parentId = mapStack.length ? String(mapStack[mapStack.length - 1].pointId) : "world";
    return String(child.parentMapId ?? "world") === parentId;
  }

  /**
   * D04：三表行的取用口径（只在 `/state` 带 `tableMap` 时可用）。
   *
   * 为什么不能直接信 `npcDirectory.pointId`：行增量回合只改三表；目录字段有自己的投影路径，
   * 两者口径不一致时面板会显示"人还在这儿"或"这儿没人"。位置以三表为准，目录只补它的独有字段
   * （最近叙事 / reason / status），这样面板既不空、也不会撒谎。
   */
  function tableRowIdOf(entityId) {
    const raw = String(entityId ?? "").trim();
    if (!raw) return "";
    return raw.startsWith("npc:") ? raw : `npc:${raw}`;
  }

  function tableMapNpcById(tableMap) {
    const map = new Map();
    for (const entry of tableMap?.nearby?.entries ?? []) {
      const id = String(entry.id ?? "").replace(/^npc:/, "");
      if (id) map.set(id, entry);
    }
    return map;
  }

  function tableMapObjectById(tableMap) {
    const map = new Map();
    for (const entry of tableMap?.objects?.entries ?? []) {
      if (entry?.id) map.set(String(entry.id), entry);
    }
    return map;
  }

  /** 该地点在三表口径下的在场人物（`tableMap.nearby` 是全量人物表，含远方；这里按位置过滤）。 */
  function tableNpcsAtLocation(tableMap, pointId) {
    const rowId = String(pointId ?? "");
    if (!rowId) return [];
    return (tableMap?.nearby?.entries ?? []).filter(
      (entry) => entry.presence !== "left" && String(entry.locationId ?? "").replace(/^loc:/, "") === rowId,
    );
  }

  function tableObjectsAtLocation(tableMap, pointId) {
    const rowId = String(pointId ?? "");
    if (!rowId) return [];
    return (tableMap?.objects?.entries ?? []).filter(
      (entry) => String(entry.locationId ?? "").replace(/^loc:/, "") === rowId,
    );
  }

  /** 三表行 → 面板读的目录形状（保留三表独有的想法 / 行动倾向 / 位置来源）。 */
  function npcViewFromTableRow(entry, { pointName = null } = {}) {
    return {
      id: String(entry.id ?? "").replace(/^npc:/, ""),
      name: String(entry.name ?? ""),
      pointId: entry.locationId === null || entry.locationId === undefined
        ? null
        : String(entry.locationId).replace(/^loc:/, ""),
      pointName: entry.locationName ?? pointName,
      presence: entry.presence,
      // D04：三表的三个文本字段各归各位，不再挤进 status 一个槽位
      thought: entry.thought ?? "",
      actionTendency: entry.actionTendency ?? "",
      currentAction: entry.currentAction ?? "",
      positionSource: entry.positionSource ?? null,
      /** 目录独有字段（最近叙事 / reason / status）由调用方合并进来。 */
      fromTables: true,
    };
  }

  function objectViewFromTableRow(entry, { pointName = null } = {}) {
    return {
      id: String(entry.id ?? ""),
      name: String(entry.name ?? ""),
      type: "物品",
      description: entry.description ?? "",
      status: entry.status ?? "",
      pointId: entry.locationId === null || entry.locationId === undefined
        ? null
        : String(entry.locationId).replace(/^loc:/, ""),
      pointName: entry.locationName ?? pointName,
      holderName: entry.holderName ?? null,
      fromTables: true,
    };
  }

  function openMapPanel(point, { inSub, currentSub }, anchorEl = null) {
    const d = lastMapData;
    if (!mapPanel || !d) return;
    mapPanel.innerHTML = "";
    const submaps = (d.map?.submaps ?? {});
    const pointMeta = (d.map?.pointMeta ?? {});
    const hasSub = hasChildSubmap(submaps, point.id);
    const regions = Array.isArray(d.regions) ? d.regions : [];
    const region = regions.find((r) => String(r.id) === String(point.regionId ?? ""));
    const description = inSub
      ? String(point.description ?? "").trim()
      : String(pointMeta[String(point.id)]?.description ?? "").trim();

    const head = el("div", "aw-mappanel__head");
    head.append(el("strong", "aw-mappanel__name", String(point.name)));
    const close = el("button", "aw-mappanel__close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "关闭地点信息");
    close.addEventListener("click", closeMapPanel);
    head.append(close);
    mapPanel.append(head);

    const metaLines = [];
    if (inSub) metaLines.push(`属于：${mapStack[mapStack.length - 1]?.name ?? ""} 内部`);
    else if (region) metaLines.push(`地区：${String(region.name)}`);
    const scale = inSub ? currentSub?.scale ?? null : null;
    if (scale) metaLines.push(`比例尺：1 格 ≈ ${scale.distancePerCell}${scale.unit ? ` ${scale.unit}` : ""}`);
    if (metaLines.length > 0) mapPanel.append(el("div", "aw-mappanel__meta", metaLines.join(" · ")));
    if (description) mapPanel.append(el("div", "aw-mappanel__desc", description));

    const actions = el("div", "aw-mappanel__actions");
    // 0.9.41 在场名单：当前地点上的人物 / 物品（npcDirectory / objectDirectory 按 pointId 分组）
    const d0 = lastMapData;
    // D04：有 `tableMap` 时，**位置与在场性以三表为准**（行增量回合只改三表）；
    // 目录只补它独有的字段（最近叙事 / reason / status），避免"面板说人在、三表说人走"。
    const panelTableMap = d0?.tableMap ?? null;
    const tableNpcsHere = panelTableMap ? tableNpcsAtLocation(panelTableMap, point.id) : [];
    const directoryNpcs = Array.isArray(d0?.npcDirectory) ? d0.npcDirectory : [];
    const directoryById = new Map(directoryNpcs.map((n) => [String(n.id ?? ""), n]));
    const hereNpcs = panelTableMap
      ? tableNpcsHere.map((entry) => {
          const view = npcViewFromTableRow(entry);
          const rich = directoryById.get(view.id);
          // 合并顺序很重要：三表字段**最后展开**（位置 / 在场性 / 想法以三表为准），
          // 只从目录里取它独有的最近叙事与关联原因。
          return rich ? { ...rich, ...view, recentNarratives: rich.recentNarratives, reason: rich.reason } : view;
        })
      : directoryNpcs.filter((n) => String(n.pointId ?? "") === String(point.id) && n.presence !== "left");
    const tableObjectsHere = panelTableMap ? tableObjectsAtLocation(panelTableMap, point.id) : [];
    const directoryObjects = Array.isArray(d0?.objectDirectory) ? d0.objectDirectory : [];
    const objectById = new Map(directoryObjects.map((o) => [String(o.id ?? ""), o]));
    const hereObjects = panelTableMap
      ? tableObjectsHere.map((entry) => {
          const view = objectViewFromTableRow(entry);
          const rich = objectById.get(view.id);
          return rich ? { ...rich, ...view } : view;
        })
      : directoryObjects.filter((o) => String(o.pointId ?? "") === String(point.id));
    const here = el("div", "aw-mappanel__here");
    /**
     * F05（§2.4）：地点弹窗是「你点开的那个地点**实际在场**的人」，不是「附近」。
     * 即使玩家离得很远也能作为作者信息查看，所以标题据实区分，并明确说明这不是附近名单。
     */
    const atCurrentLocation = String(point.id) === String(d0?.currentLocationId ?? "");
    const hereLabel = el("div", "aw-mappanel__here-label",
      `${atCurrentLocation ? "当前在这里" : "该地点在场"}（${hereNpcs.length + hereObjects.length}）`);
    here.append(hereLabel);
    if (!atCurrentLocation) {
      here.append(el("div", "aw-mappanel__here-hint",
        "你当前不在此地：这里列出的是该地点的实际在场者（作者信息），不是「附近」。"));
    }
    if (hereNpcs.length > 0) {
      // S9（0.9.55）：纠偏入口搬进名单后必须说明怎么用——否则「拖拽」这个能力对用户不可见。
      here.append(el("div", "aw-mappanel__here-hint", "按住人物头像拖到地图上的地点标点，可纠偏其位置"));
    }
    if (hereNpcs.length === 0 && hereObjects.length === 0) {
      here.append(el("div", "aw-mappanel__here-empty", "无人"));
    }
    for (const npc of hereNpcs) {
      const row = el("button", "aw-mappanel__person aw-mappanel__person--npc");
      row.type = "button";
      const avatar = el("span", "aw-mappanel__person-avatar aw-person-drag", String(npc.name ?? "?").slice(0, 1));
      // S9（0.9.55）：头像本身是纠偏拖拽手柄——长按拖到地点标点上松手 = move-author。
      // 短按头像 / 点整行仍是打开详情，故 0.9.44 的纠偏能力不因移除地图标点而丢失。
      avatar.title = "长按拖到目标地点可纠偏位置";
      avatar.setAttribute("aria-label", `长按拖动「${String(npc.name)}」可纠偏其位置`);
      row.append(avatar);
      row.append(el("span", "aw-mappanel__person-name", String(npc.name)));
      // 人物面板锚到**地点标点**（不是已消失的人物标点）：面板原地替换、标点保持高亮，
      // R15 的续锚身份继续有效；R15 之后人物面板也不再依赖 data-entity-id 标点。
      const openDetail = () => openNpcPanel(npc, mapPanelAnchor?.el ?? null);
      row.addEventListener("click", openDetail);
      attachPersonDrag(avatar, npc, openDetail);
      here.append(row);
    }
    for (const obj of hereObjects) {
      const row = el("button", "aw-mappanel__person aw-mappanel__person--obj");
      row.type = "button";
      row.append(el("span", "aw-mappanel__person-avatar", "◆"));
      row.append(el("span", "aw-mappanel__person-name", String(obj.name)));
      row.addEventListener("click", () => {
        const anchorDot = mapLayer?.querySelector(`[data-obj-id="${String(obj.id ?? "")}"]`) ?? null;
        openObjectPanel(obj, anchorDot);
      });
      here.append(row);
    }
    mapPanel.append(here);

    /**
     * H16a（0.9.59）：作者确认控件——归属 / 邻接 / 载具 / 坐标。
     *
     * 纪律（计划 §3-H16a 原文）：
     * - **只对作者开放**：入口收在「作者确认」折叠区里，默认收起，不干扰普通浏览；
     * - 未确定的 parent / 邻接**列为待确认**，**绝不预选同名城市**——同名就自动认亲
     *   是 H04 明令禁止的（「圣罗兰外城区」不能因为含城名就变成城市的子地点）；
     * - 保存走 H07a `POST /maps/topology/confirm`，失败**显示字段路径**并带上当前
     *   会话 / 分支标识，作者能对上号；
     * - **标定锁不由此控件解开**（这里只写拓扑关系，不碰 metersPerCell / locked）。
     */
    {
      const hereRowId = typeof point.rowId === "string" && point.rowId.length > 0
        ? point.rowId
        : `loc:${String(point.id)}`;
      const confirmBox = el("details", "aw-confirm");
      confirmBox.append(el("summary", "aw-confirm__summary", "作者确认（归属 / 邻接 / 载具 / 坐标）"));
      confirmBox.append(el("p", "aw-confirm__ident",
        `聊天 ${String(d0?.chatId ?? "(无)")} · 分支 ${String(panelTableMap?.branchKey ?? "canon")} · 地点行 ${hereRowId}`));
      confirmBox.append(el("p", "aw-confirm__hint",
        "关系只由证据或人工确认写入；未确认的留空，不会因为名字相近就自动认亲。"));

      const candidateEntries = (Array.isArray(panelTableMap?.locationOccupants?.entries)
        ? panelTableMap.locationOccupants.entries : [])
        .filter((entry) => String(entry?.locationId ?? "") !== hereRowId);
      const targetSelect = el("select", "aw-input aw-input--select");
      targetSelect.setAttribute("aria-label", "选择要确认关联的地点");
      const noneOption = el("option", "", "— 未确认（请显式选择目标地点）—");
      noneOption.value = "";
      noneOption.selected = true; // 不预选任何地点，包括同名城市
      targetSelect.append(noneOption);
      for (const entry of candidateEntries) {
        const option = el("option", "", String(entry.locationName ?? entry.locationId ?? ""));
        option.value = String(entry.locationId ?? "");
        targetSelect.append(option);
      }
      confirmBox.append(targetSelect);

      const confirmStatus = el("p", "aw-confirm__status");
      const sendConfirm = async (operation, extra = {}) => {
        const chatId = String(state().chatId ?? "");
        if (!chatId) { confirmStatus.textContent = "当前没有活动聊天。"; confirmStatus.className = "aw-confirm__status is-error"; return; }
        const targetLocationId = targetSelect.value ? String(targetSelect.value) : null;
        const response = await api.request("POST", "/maps/topology/confirm", {
          chatId,
          operation,
          locationId: hereRowId,
          ...(operation === "set-parent" || operation === "set-adjacent" ? { targetLocationId } : {}),
          ...extra,
        });
        if (response.status !== 200 || !response.body?.ok) {
          const path = response.body?.error?.details?.schemaPath;
          confirmStatus.textContent =
            `${response.body?.error?.message ?? "确认失败"}${path ? `（字段：${String(path)}）` : ""}`;
          confirmStatus.className = "aw-confirm__status is-error";
          return;
        }
        confirmStatus.textContent = "已保存到当前分支。";
        confirmStatus.className = "aw-confirm__status is-ok";
        await core.refresh();
      };

      const confirmActions = el("div", "aw-confirm__actions");
      const parentBtn = el("button", "aw-btn", "设为所选地点的子地点");
      parentBtn.type = "button";
      parentBtn.addEventListener("click", () => void sendConfirm("set-parent"));
      const detachBtn = el("button", "aw-btn aw-btn--ghost", "解除包含");
      detachBtn.type = "button";
      detachBtn.setAttribute("aria-label", "解除与上级地点的包含关系");
      detachBtn.addEventListener("click", () => void sendConfirm("set-parent", { targetLocationId: null }));
      const adjacentBtn = el("button", "aw-btn aw-btn--ghost", "设为邻接（不改变归属）");
      adjacentBtn.type = "button";
      adjacentBtn.addEventListener("click", () => void sendConfirm("set-adjacent"));
      confirmActions.append(parentBtn, detachBtn, adjacentBtn);
      confirmBox.append(confirmActions);
      confirmBox.append(confirmStatus);
      mapPanel.append(confirmBox);
    }

    if (!inSub && String(point.id) !== String(d.currentLocationId ?? "")) {
      const routeBtn = el("button", "aw-btn aw-btn--primary", "预览前往路线");
      routeBtn.type = "button";
      routeBtn.setAttribute("aria-label", `预览前往 ${point.name} 的路线`);
      routeBtn.addEventListener("click", () => {
        closeMapPanel();
        void core.selectDestination(String(point.id));
      });
      actions.append(routeBtn);
    }
    if (hasSub) {
      const enterBtn = el("button", "aw-btn", "进入内部地图");
      enterBtn.type = "button";
      enterBtn.setAttribute("aria-label", `进入 ${point.name} 的内部地图`);
      enterBtn.addEventListener("click", () => {
        mapStack.push({ pointId: String(point.id), name: String(point.name) });
        closeMapPanel();
        renderMap(data());
      });
      actions.append(enterBtn);
    }
    if (inSub) {
      actions.append(el("span", "aw-hint", "内部点位暂不接入旅行推算。"));
    }
    /**
     * H15b：进入「编辑范围」绘制模式。
     *
     * 入口只在这里——地图平时照常平移/点选，不进入绘制就绝不会捕获网格点击。
     * locationId 用三表行 id（`loc:*`），不是地图点 id：H15a 按三表行写 areas。
     */
    if (!inSub) {
      const rowId = typeof point.rowId === "string" && point.rowId.length > 0
        ? point.rowId
        : `loc:${String(point.id)}`;
      const areaBtn = el("button", "aw-btn", "编辑范围");
      areaBtn.type = "button";
      areaBtn.setAttribute("aria-label", `在网格上绘制 ${String(point.name)} 的已证实范围`);
      areaBtn.addEventListener("click", () => {
        beginAreaDraw(rowId, String(point.name), "world");
        closeMapPanel();
      });
      actions.append(areaBtn);
    }
    if (actions.childElementCount > 0) mapPanel.append(actions);
    mapPanel.style.display = "";
    anchorPanelToMarker(anchorEl);
  }

  /** 0.9.41 人物面板：想法（最近涉及叙事）+ 动向（状态摘要 / 在场原因）。 */
  function openNpcPanel(npc, anchorEl = null) {
    if (!mapPanel) return;
    mapPanel.innerHTML = "";
    const head = el("div", "aw-mappanel__head");
    const headRow = el("div", "aw-mappanel__headrow");
    const headAvatar = el("span", "aw-mappanel__avatar aw-mappanel__avatar--npc aw-person-drag", String(npc.name ?? "?").slice(0, 1));
    // S9（0.9.55）：人物卡片头部的头像同样可长按拖动纠偏——从名单点进来后不必退回上一层。
    headAvatar.title = "长按拖到目标地点可纠偏位置";
    headAvatar.setAttribute("aria-label", `长按拖动「${String(npc.name)}」可纠偏其位置`);
    headRow.append(headAvatar);
    attachPersonDrag(headAvatar, npc);
    headRow.append(el("strong", "aw-mappanel__name", String(npc.name)));
    head.append(headRow);
    const close = el("button", "aw-mappanel__close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "关闭人物信息");
    close.addEventListener("click", closeMapPanel);
    head.append(close);
    mapPanel.append(head);

    const metaLines = [];
    if (npc.pointName) metaLines.push(`所在：${npc.pointName}`);
    if (npc.reason) metaLines.push(NPC_REASON_LABELS[String(npc.reason)] ?? String(npc.reason));
    // D04：位置来源必须让人看见——作者纠偏 / 日程移动 / 正文观察，可信度不一样
    if (npc.positionSource) {
      metaLines.push(`位置来源：${POSITION_SOURCE_LABELS[String(npc.positionSource)] ?? String(npc.positionSource)}`);
    }
    if (npc.presence === "left") metaLines.push("已离场");
    if (npc.presence === "unknown") metaLines.push("在场情况未知");
    if (metaLines.length > 0) mapPanel.append(el("div", "aw-mappanel__meta", metaLines.join(" · ")));

    // 0.9.49（M02 跨层定位）：人物在别的地图层时（无锚点标点），一键跳回世界图并打开所在地点
    if (npc.pointId && !anchorEl) {
      const locate = el("div", "aw-mappanel__actions");
      const locateBtn = el("button", "aw-btn", "打开所在地图");
      locateBtn.type = "button";
      locateBtn.setAttribute("aria-label", `跳到 ${npc.pointName ?? "所在地点"} 的地图位置`);
      locateBtn.addEventListener("click", () => {
        locateToPointPanel(npc.pointId);
      });
      locate.append(locateBtn);
      mapPanel.append(locate);
    }

    // 动向：三表的 currentAction（模型观察到的即时动作）优先，退回 CharacterState 状态摘要
    const actionText = String(npc.currentAction ?? "").trim();
    if (actionText || npc.status) {
      const status = el("div", "aw-mappanel__section");
      status.append(el("div", "aw-mappanel__section-label", "动向"));
      status.append(el("div", "aw-mappanel__section-text", actionText || String(npc.status)));
      mapPanel.append(status);
    }
    // D04：想法与行动倾向是三表的独立字段（旧实现把它们挤进 status 一个槽位）；
    // 它们正是「下一轮这个人会怎么动」的依据，必须能单独读到。
    const thoughtText = String(npc.thought ?? "").trim();
    const tendencyText = String(npc.actionTendency ?? "").trim();
    if (thoughtText || tendencyText) {
      const inner = el("div", "aw-mappanel__section");
      inner.append(el("div", "aw-mappanel__section-label", "心思"));
      if (thoughtText) inner.append(el("div", "aw-mappanel__section-text", `想法：${thoughtText}`));
      if (tendencyText) inner.append(el("div", "aw-mappanel__section-text", `行动倾向：${tendencyText}`));
      mapPanel.append(inner);
    }
    // 想法：最近涉及该 NPC 的账本叙事
    const narratives = Array.isArray(npc.recentNarratives) ? npc.recentNarratives.filter(Boolean) : [];
    if (narratives.length > 0) {
      const thoughts = el("div", "aw-mappanel__section");
      thoughts.append(el("div", "aw-mappanel__section-label", "最近动向"));
      for (const text of narratives) {
        thoughts.append(el("div", "aw-mappanel__section-text", `· ${text}`));
      }
      mapPanel.append(thoughts);
    }
    if (!actionText && !npc.status && !thoughtText && !tendencyText && narratives.length === 0) {
      mapPanel.append(el("div", "aw-mappanel__here-empty", "暂无动向记录——推演推进后这里会出现该角色的想法与动向。"));
    }
    mapPanel.style.display = "";
    anchorPanelToMarker(anchorEl);
  }

  /** 0.9.41 物品面板：描述 + 所在。 */
  function openObjectPanel(object, anchorEl = null) {
    if (!mapPanel) return;
    mapPanel.innerHTML = "";
    const head = el("div", "aw-mappanel__head");
    const headRow = el("div", "aw-mappanel__headrow");
    headRow.append(el("span", "aw-mappanel__avatar aw-mappanel__avatar--obj", "◆"));
    headRow.append(el("strong", "aw-mappanel__name", String(object.name)));
    head.append(headRow);
    const close = el("button", "aw-mappanel__close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "关闭物品信息");
    close.addEventListener("click", closeMapPanel);
    head.append(close);
    mapPanel.append(head);

    const metaLines = [];
    metaLines.push(`类型：${String(object.type)}`);
    if (object.pointName) metaLines.push(`所在：${object.pointName}`);
    // D04：持有关系只存在于三表（D-02）——随身物品必须显示持有人，否则看起来像"凭空消失"
    if (object.holderName) metaLines.push(`持有人：${String(object.holderName)}`);
    if (object.status) metaLines.push(`状态：${String(object.status)}`);
    mapPanel.append(el("div", "aw-mappanel__meta", metaLines.join(" · ")));

    // 0.9.49（M02 跨层定位）：物品在别的地图层时（无锚点标点），一键跳回世界图并打开所在地点
    if (object.pointId && !anchorEl) {
      const locate = el("div", "aw-mappanel__actions");
      const locateBtn = el("button", "aw-btn", "打开所在地图");
      locateBtn.type = "button";
      locateBtn.setAttribute("aria-label", `跳到 ${object.pointName ?? "所在地点"} 的地图位置`);
      locateBtn.addEventListener("click", () => {
        locateToPointPanel(object.pointId);
      });
      locate.append(locateBtn);
      mapPanel.append(locate);
    }
    if (object.description) {
      const desc = el("div", "aw-mappanel__section");
      desc.append(el("div", "aw-mappanel__section-label", "描述"));
      desc.append(el("div", "aw-mappanel__section-text", String(object.description)));
      mapPanel.append(desc);
    }
    mapPanel.style.display = "";
    anchorPanelToMarker(anchorEl);
  }

  function renderMap(d) {
    if (!d.worldId) return;
    // 0.9.35 换聊天 / 换世界 → 子图视图栈立即作废（数据隔离，绝不让旧子图带进新卡）
    // B03（0.9.59）：作用域键补齐**分支**——同一聊天同一世界的正史 / IF 是两张图，
    // 视图栈、相机与底图缓存都必须按 `chatId|worldId|branchKey` 分开，
    // 否则切分支会沿用上一分支的子图层级与视角（计划 §3-B03）。
    const mapIdentity = atlasMapIdentityOf(d, state().chatId);
    const viewKey = atlasMapScopeKey(mapIdentity);
    if (mapStackKey !== viewKey) {
      // D05：切聊天清理不只作废子图栈——地点弹窗、建筑内名单、锚点与上一条 /state 也必须一起清，
      // 否则新聊天的地图渲染出来之前，旧聊天的弹窗与名单还挂在界面上（跨聊天串档最直观的一种）。
      // B03 补：相机缓存（`mapCameras` 按 camKey = 作用域键 + 视图）与前一份 /state 派生数据
      // （lastMapData）一并作废——新作用域从 fitCamera 重新起算，绝不沿用旧分支 / 旧聊天的视角。
      mapStack = [];
      mapStackKey = viewKey;
      lastMapData = null;
      mapPanelAnchor = null;
      closeMapPanel();
      if (interiorRoster) {
        interiorRoster.innerHTML = "";
        interiorRoster.style.display = "none";
      }
      mapCameras.clear();
    }
    lastMapData = d;
    mapLayer.innerHTML = "";
    const mapData = d.map ?? {};
    // D03：已经懒迁移过的分支，`/state` 会带 `tableMap`（三表投影）。
    // 世界图与子图都优先用它——世界图只含根地点、子图按父地点键挂载，与 A03/A04/D-20 的口径一致。
    // 没有 `tableMap` 的旧会话（或 projection 为空）**完全走原来的逻辑**，行为一字不变。
    const tableMap = d.tableMap && typeof d.tableMap === "object" ? d.tableMap : null;
    const tableSubmaps = tableMap && tableMap.submaps && typeof tableMap.submaps === "object" ? tableMap.submaps : null;
    const submapSource = tableSubmaps ?? (mapData.submaps && typeof mapData.submaps === "object" ? mapData.submaps : {});
    const submaps = submapSource;
    const pointMeta = mapData.pointMeta && typeof mapData.pointMeta === "object" ? mapData.pointMeta : {};
    while (mapStack.length > 0) {
      const top = mapStack[mapStack.length - 1];
      const expectedParent = mapStack.length > 1 ? mapStack[mapStack.length - 2].pointId : "world";
      const submap = submaps[String(top.pointId)];
      if (submap && String(submap.parentMapId ?? "world") === String(expectedParent)) break;
      mapStack.pop();
      closeMapPanel();
    }
    // 0.9.35 子图视图：栈顶决定当前渲染哪张图（世界图或任意点挂子图，递归）
    const view = mapStack[mapStack.length - 1] ?? null;
    const currentSub = view ? submaps[String(view.pointId)] ?? null : null;
    const inSub = Boolean(currentSub);
    renderMapCrumb(d, view, currentSub);

    const legacyPointsAll = Array.isArray(mapData.points) ? mapData.points : [];
    const tableWorldPoints = tableMap && Array.isArray(tableMap.world?.points)
      ? tableMap.world.points
        .filter((point) => !point.kind || point.kind === "location")
        .map((point) => ({ id: point.id, name: point.name, x: point.x, y: point.y, regionId: point.regionId ?? null }))
      : null;
    const pointsAll = tableWorldPoints ?? legacyPointsAll;
    const subPoints = inSub && Array.isArray(currentSub.points)
      ? (tableMap ? currentSub.points.filter((point) => !point.kind || point.kind === "location") : currentSub.points)
      : null;
    const points = inSub
      ? subPoints
      : regionFilter
        ? pointsAll.filter((p) => String(p.regionId ?? "") === regionFilter)
        : pointsAll;
    // S9（0.9.55）人物不再画地图标点：世界图上的人物头像与地点同坐标（同一点叠两枚标记，
    // 命中与人读都在打架），而且「人在这个地点里」只到地点级，标点等于伪造更细的坐标。
    // 人物一律由地点承载——地点面板「当前在这里」名单（含长按纠偏）、子图
    // 「建筑内 · 具体房间未知」名单。故这里只保留子图名单所需的人物集合。
    const npcsAll = Array.isArray(d.npcDirectory) ? d.npcDirectory : [];
    const objectsAll = Array.isArray(d.objectDirectory) ? d.objectDirectory : [];
    let rosterNpcs = [];
    let objects;
    if (inSub) {
      const ownerId = String(view.pointId);
      // 账本 presence=left 的人已经离场，不能出现在「建筑内」名单里冒充在场
      rosterNpcs = npcsAll.filter((n) => String(n.pointId ?? "") === ownerId && n.presence !== "left");
      objects = objectsAll.filter((o) => String(o.pointId ?? "") === ownerId);
      if (tableMap) {
        /**
         * D03 / D-34：子图名单同样以三表为准，并且**口径与地图一致**——
         * 当前层可见的房间 = 宿主 + `submaps` 里以宿主为父的那些房间（含再下一层），
         * 名单里列的是"归属于这些房间、但**没有房间内细坐标**"的人 / 物品。
         * 有细坐标的人已经在地图上画成图钉了，不该在名单里再出现一次。
         *
         * 旧实现按宿主 id 精确匹配位置，于是"位置=某个房间"的人一个都进不来——
         * 名单与地图会同时为空，而人其实就在这层楼里。
         */
        /**
         * 口径与地图上的图钉**完全一致**：可见房间 = 当前图层渲染出来的地点标点
         * （子图里 = 宿主 + 同层房间）。名单只列"归属于这些房间、但没有房间内细坐标"的人 / 物品；
         * 有细坐标的已经在地图上画成图钉，不在名单里重复出现。
         */
        const visibleRoomIds = new Set(points.map((point) => `loc:${String(point.id)}`));
        const hasFinePosition = (row) => typeof row.gridX === "number" && typeof row.gridY === "number";
        const knownNpcKeys = new Set();
        for (const npc of rosterNpcs) {
          knownNpcKeys.add(tableRowIdOf(npc.id));
          knownNpcKeys.add(String(npc.id ?? ""));
        }
        const knownObjectIds = new Set(objects.map((o) => String(o.id ?? "")));
        for (const entry of tableMap.nearby?.entries ?? []) {
          const locationId = String(entry.locationId ?? "");
          if (!visibleRoomIds.has(locationId)) continue;
          if (entry.presence === "left") continue;
          if (entry.isProtagonist === true) continue;
          if (hasFinePosition(entry)) continue;
          const rowId = String(entry.id ?? "").startsWith("npc:") ? String(entry.id) : `npc:${String(entry.id ?? "")}`;
          if (knownNpcKeys.has(rowId)) continue;
          rosterNpcs = [...rosterNpcs, npcViewFromTableRow(entry)];
        }
        for (const entry of tableMap.objects?.entries ?? []) {
          const locationId = String(entry.locationId ?? "");
          if (!visibleRoomIds.has(locationId)) continue;
          if (entry.holderCharacterId !== null) continue;
          if (hasFinePosition(entry)) continue;
          if (knownObjectIds.has(String(entry.id ?? ""))) continue;
          objects = [...objects, objectViewFromTableRow(entry)];
        }
      }
    } else {
      objects = regionFilter ? objectsAll.filter((o) => String(o.regionId ?? "") === regionFilter) : objectsAll;
    }
    if (regionSelect) regionSelect.style.display = inSub ? "none" : "";
    if (travelBar) travelBar.style.display = inSub ? "none" : "";
    interiorRoster.innerHTML = "";
    interiorRoster.style.display = inSub && (rosterNpcs.length > 0 || objects.length > 0) ? "" : "none";
    if (inSub && (rosterNpcs.length > 0 || objects.length > 0)) {
      interiorRoster.append(el("div", "aw-interior-roster__title", "建筑内 · 具体房间未知"));
      for (const npc of rosterNpcs) {
        const button = el("button", "aw-interior-roster__item", String(npc.name ?? "未具名人物"));
        button.type = "button";
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          openNpcPanel(npc);
        });
        interiorRoster.append(button);
      }
      for (const object of objects) {
        const button = el("button", "aw-interior-roster__item", String(object.name ?? "物品"));
        button.type = "button";
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          openObjectPanel(object);
        });
        interiorRoster.append(button);
      }
    }

    const regions = Array.isArray(d.regions) ? d.regions : [];
    // 0.9.20 空地理诚实提示；0.9.26 地图抢救后文案更新——单点地图不是渲染坏了，
    // 是世界里真的只有一个地点；提炼按钮（世界书 / 近期剧情）现在常显可随时生长地图
    if (mapHint) {
      const hasRealGeo = pointsAll.length > 0 || regions.length > 0;
      mapHint.textContent = hasRealGeo
        ? ""
        : "这个世界还没有地理数据：新世界不再预置「起点」占位地点。点下方「从世界书提炼地理」导入卡书里的地点；推演有场景后，可用「从近期剧情提炼新地点」让地图继续生长。";
      // R01：空提示不渲染占位覆盖层（旧实现空文字仍是 inset:0 的 absolute 层，挡住点击）
      mapHint.style.display = mapHint.textContent ? "" : "none";
    }
    // R01：地图工具条显式显示（旧实现依赖 .is-visible 但从未有人加，工具永远 display:none）；
    // 按钮各自的禁用逻辑独立于可见性
    mapTools.classList.add("is-visible");
    regionSelect.innerHTML = "";
    const allOption = document.createElement("option");
    allOption.value = "";
    allOption.textContent = "全部地区";
    regionSelect.append(allOption);
    for (const region of regions) {
      const option = document.createElement("option");
      option.value = String(region.id);
      option.textContent = String(region.name);
      if (String(region.id) === regionFilter) option.selected = true;
      regionSelect.append(option);
    }

    // R08 相机接线：frame 按当前图的**全量**点位固定（筛选只改可见对象，
    // 不重算 frame / 相机）；相机按视图持久化（世界图 / 各层子图各自记忆），
    // fitAll 无每格像素下限——大世界完整收入视口（旧 20px 下限删除）。
    if (cameraApiMissing) {
      if (mapHint) {
        mapHint.textContent = "UI 核心模块过旧（缺少地图相机 API）：请重新执行 npm run build 更新 dist/ 后刷新。";
        mapHint.style.display = "";
      }
      return;
    }
    const camKey = `${mapStackKey}|${inSub ? String(view.pointId) : "world"}`;
    const framePoints = inSub ? (Array.isArray(currentSub.points) ? currentSub.points : []) : pointsAll;
    cameraFrame = computeMapFrame(framePoints);
    cameraViewKey = camKey;
    cameraViewport = { w: viewport.clientWidth || 0, h: viewport.clientHeight || 0 };
    let cam = mapCameras.get(camKey) ?? null;
    if (!cam) {
      cam = fitCamera(cameraFrame, cameraViewport.w, cameraViewport.h);
      mapCameras.set(camKey, cam);
    }
    camera = cam;
    // R08 图层盒：stage 子元素直接用世界单位 px 定位（负坐标合法），变换由相机统一给出。
    // 网格盒 = frame 外扩余量（平移出图仍见格线）；底图盒 = frame 精确框。
    const gridMargin = Math.ceil(Math.max(400, Math.max(cameraFrame.spanX, cameraFrame.spanY)));
    gridBoxOrigin = { x: cameraFrame.minX - gridMargin, y: cameraFrame.minY - gridMargin };
    gridLayer.style.left = `${gridBoxOrigin.x}px`;
    gridLayer.style.top = `${gridBoxOrigin.y}px`;
    gridLayer.style.width = `${cameraFrame.spanX + gridMargin * 2}px`;
    gridLayer.style.height = `${cameraFrame.spanY + gridMargin * 2}px`;
    imageLayer.style.left = `${cameraFrame.minX}px`;
    imageLayer.style.top = `${cameraFrame.minY}px`;
    imageLayer.style.width = `${cameraFrame.spanX}px`;
    imageLayer.style.height = `${cameraFrame.spanY}px`;
    // 0.9.50（M04/M05）动态标尺条：标定（calibrations[mapId]）优先画米制条；
    // 旧式自由单位比例尺只做文字说明（换算未知，不画伪物理条）；世界图沿用
    // 「多于一个地点或地区才显示」的显隐口径。缩放 / resize 经 updateScaleBarVisual 重算。
    if (mapScaleEl) {
      const showScale = !inSub ? pointsAll.length > 0 || regions.length > 0 : true;
      mapScaleEl.style.display = showScale ? "" : "none";
      if (showScale) {
        const calibrations = mapData.calibrations && typeof mapData.calibrations === "object" ? mapData.calibrations : {};
        const mapId = inSub ? String(view.pointId) : "world";
        const calibration = calibrations[mapId] ?? null;
        const legacyScale = inSub ? currentSub?.scale ?? null : null;
        scaleCtx = { calibration, legacyScale, mapId };
        rebuildScaleDetail(d, mapId, calibration, legacyScale);
      } else {
        scaleCtx = null;
      }
    }
    // R01 图层接线：viewport 静态装饰纹理保持关闭（固定背景格不能冒充可测量网格）；
    // 网格视觉（线宽 / 对齐 / 显隐）由 applyCamera → updateGridVisual 按相机实时绘制；
    // 底图画在独立 imageLayer。视图切换（叠加/网格/底图）只改可见性，不改坐标与数据。
    viewport.style.backgroundImage = "none";
    stage.dataset.view = mapViewMode;

    /**
     * F03：地点标点上的「在场人数」徽标。
     *
     * 数据源是 `tableMap.locationOccupants` —— 服务端按**完整三表**分组的真实计数
     * （不是先截 48 再分组），所以第 49 个人物也在数字里，不会「人从地图上消失」。
     * 与地点同坐标的人物同样计入本人数：他们只是不额外画一枚图钉，
     * 但**必须**仍然可被看见（F04 的「不准变成地图不可见」）。
     * 老会话没有 locationOccupants 时整段跳过，行为不变。
     */
    const occupantByPointId = new Map();
    const pointIdByLocationId = new Map();
    for (const entry of tableMap?.locationOccupants?.entries ?? []) {
      const pointId = entry.locationPointId === null || entry.locationPointId === undefined
        ? null : String(entry.locationPointId);
      if (pointId === null) continue;
      occupantByPointId.set(pointId, entry);
      if (typeof entry.locationId === "string") pointIdByLocationId.set(entry.locationId, pointId);
    }

    /**
     * H16（§2.5）：载具**按真实停靠或路线**显示，绝不凭排版位置画点。
     *
     * - `stopped` 且锚点落在本图某个已知地点上 → 在该地点标点挂载具徽标（它真的停在那儿）；
     * - `en-route` / `unknown` → **一个点都不画**（在途位置没有确认坐标，画出来就是伪造），
     *   改由下面的「在途载具」说明行如实列出，作者知道它还没停稳。
     * 数据源是 `/state` 的 `map.geoTopology.vehicleAnchors`（当前分支、服务端已限流）。
     */
    const vehicleByPointId = new Map();
    const vehiclesWithoutPosition = [];
    /**
     * F06（§2.5）：相邻外城——由 geoTopology 里 `kind === "adjacent"` 的已证实边决定，
     * **不靠坐标远近猜**（外城可以和城市挨着，但只有证据说相邻才算相邻）。
     */
    const adjacentPointIds = new Set();
    for (const edge of tableMap?.geoTopology?.edges ?? d.map?.geoTopology?.edges ?? []) {
      if (!edge || typeof edge !== "object" || edge.kind !== "adjacent") continue;
      for (const endpoint of [edge.fromLocationId, edge.toLocationId]) {
        const id = String(endpoint ?? "");
        if (id.length === 0) continue;
        adjacentPointIds.add(id.startsWith("loc:") ? id.slice(4) : id);
        adjacentPointIds.add(id);
      }
    }
    for (const anchor of tableMap?.geoTopology?.vehicleAnchors ?? d.map?.geoTopology?.vehicleAnchors ?? []) {
      if (!anchor || typeof anchor !== "object") continue;
      const anchorLocationId = String(anchor.atLocationId ?? "");
      const stopped = anchor.status === "stopped";
      if (!stopped || anchorLocationId.length === 0) {
        vehiclesWithoutPosition.push(anchor);
        continue;
      }
      // 停靠点 → 地图点：优先按三表地点 id 解析（loc:2 → 点 2），解析不到就退回裸点 id
      const row = pointIdByLocationId.get(anchorLocationId)
        ?? (anchorLocationId.startsWith("loc:") ? anchorLocationId.slice(4) : anchorLocationId);
      const existing = vehicleByPointId.get(String(row)) ?? [];
      existing.push(anchor);
      vehicleByPointId.set(String(row), existing);
    }
    // 在途 / 锚点未知：只说事实，不给坐标
    if (vehicleNoteEl) {
      if (vehiclesWithoutPosition.length > 0) {
        const enRoute = vehiclesWithoutPosition.filter((anchor) => anchor.status === "en-route").length;
        const unknown = vehiclesWithoutPosition.length - enRoute;
        vehicleNoteEl.textContent = [
          enRoute > 0 ? `${enRoute} 辆载具在途（尚未停靠，地图上不标点）` : "",
          unknown > 0 ? `${unknown} 辆载具锚点未确认` : "",
        ].filter(Boolean).join(" · ");
        vehicleNoteEl.style.display = "";
      } else {
        vehicleNoteEl.textContent = "";
        vehicleNoteEl.style.display = "none";
      }
    }

    for (const point of points) {
      const marker = el("button", "aw-point");
      marker.type = "button";
      const hasSub = hasChildSubmap(submaps, point.id);
      marker.textContent = String(point.name);
      marker.title = String(point.name);
      const occupants = occupantByPointId.get(String(point.id));
      if (occupants && Number(occupants.characterCount) > 0) {
        const badge = el("span", "aw-point__badge", String(occupants.characterCount));
        badge.title = `${Number(occupants.characterCount)} 人在此`;
        badge.setAttribute("aria-label", `${Number(occupants.characterCount)} 人在此`);
        marker.append(badge);
        marker.classList.add("has-occupants");
      }
      // H16：真的停靠在这里的载具——挂在**真实停靠点**上，而不是另算一个坐标
      const parked = vehicleByPointId.get(String(point.id));
      if (Array.isArray(parked) && parked.length > 0) {
        const vehicleBadge = el("span", "aw-point__vehicle", "车");
        vehicleBadge.title = `${parked.length} 辆载具停靠于此`;
        vehicleBadge.setAttribute("aria-label", `${parked.length} 辆载具停靠于此`);
        marker.append(vehicleBadge);
        marker.classList.add("has-vehicle");
      }
      // R08：标记直接按世界单位定位（screen = v + (world - c) * k 由相机统一给出）
      marker.style.left = `${Number(point.x)}px`;
      marker.style.top = `${Number(point.y)}px`;
      if (hasSub) marker.classList.add("aw-point--sub");
      /**
       * F06：四种视图角色必须一眼可分（城市入口 / 城市内部 / 相邻外城 / 普通地点）。
       * 只加 class，不改坐标——样式绝不参与几何。
       */
      if (hasSub) marker.classList.add("aw-point--entrance");
      if (inSub) marker.classList.add("aw-point--interior");
      if (adjacentPointIds.has(String(point.id)) || adjacentPointIds.has(`loc:${String(point.id)}`)) {
        marker.classList.add("aw-point--adjacent");
      }
      // 0.9.35 点击 = 简略信息面板（路线 / 进入子图都在面板里），不再一键直接拉路线
      if (String(point.id) === String(d.currentLocationId ?? "")) {
        marker.classList.add("is-current");
        marker.setAttribute("aria-label", `当前位置 ${point.name}，点击查看详情`);
      } else {
        marker.setAttribute("aria-label", `地点 ${point.name}，点击查看详情`);
      }
      marker.dataset.pointId = String(point.id); // 0.9.47 拖拽命中测试用（0.9.44 UI 半边被 pack 回滚，本版补回）
      marker.addEventListener("click", (e) => {
        e.stopPropagation();
        openMapPanel(point, { inSub, currentSub }, marker);
      });
      mapLayer.append(marker);
    }

    /**
     * H08（0.9.59）：**缺坐标地点**的示意标点。
     *
     * 之前 `layoutUnplacedMarkers` 有实现、有单测，却**没有任何生产调用点**——
     * 于是「未定位 / 旧来源不明」的地点在真实地图上完全不显示（F01 只在数据层
     * 把它们挑进 `unplacedLocations`）。这里把它接上：
     * - 位置由纯函数按 frame 环形排布算出，**只用于渲染**，绝不回写三表 / world；
     * - 与真实坐标点视觉上明确可分（虚线 + 「待定位」角标），
     *   作者不会把示意位置误当成已确认坐标；
     * - 绝不落在 (0,0)：排布函数保证落在 frame 内的空位。
     */
    if (typeof layoutUnplacedMarkers === "function" && Array.isArray(tableMap?.unplacedLocations?.entries)) {
      const unplacedEntries = tableMap.unplacedLocations.entries;
      if (unplacedEntries.length > 0) {
        const layout = layoutUnplacedMarkers({
          branchKey: String(tableMap?.branchKey ?? "canon"),
          mapId: inSub ? String(view.pointId) : "world",
          frame: { cols: cameraFrame.spanX, rows: cameraFrame.spanY },
          confirmed: points.map((point) => ({ id: String(point.id), x: Number(point.x), y: Number(point.y) })),
          unplaced: unplacedEntries.map((entry) => ({
            id: String(entry.id ?? entry.locationId ?? ""),
            name: String(entry.name ?? ""),
          })),
          ...(Array.isArray(tableMap?.geoTopology?.vehicleAnchors) ? { vehicles: tableMap.geoTopology.vehicleAnchors } : {}),
        });
        for (const marker of layout?.displayOnly ?? []) {
          const node = el("button", "aw-point aw-point--displayonly");
          node.type = "button";
          node.textContent = String(marker.name ?? marker.id ?? "");
          node.title = `${String(marker.name ?? "")}（位置未确认，仅为示意）`;
          node.setAttribute("aria-label", `地点 ${String(marker.name ?? "")}，位置未确认，仅为示意，点击查看详情`);
          node.dataset.displayOnly = "true";
          node.append(el("span", "aw-point__pending", "待定位"));
          node.style.left = `${Number(marker.x)}px`;
          node.style.top = `${Number(marker.y)}px`;
          mapLayer.append(node);
        }
        mapLayer.dataset.pendingCount = String((layout?.pending ?? []).length);
      }
    }

    // S9（0.9.55）人物标点已删除（见上方 npcsAll 处说明）——此处只剩物品标点。
    // D03：有 `tableMap` 时物品标点按三表口径画（世界图 + 子图都能画，持有物不地面化），
    // 没有时完全走原来的目录路径（旧会话行为一字不变）。
    // 注意 `已销毁` 与服务端 ATLAS_ITEM_DESTROYED_STATUS（src/atlas-tables.ts）是同一个字面量：
    // 软删除的物品不该有地图图钉，但**必须**在物品面板里能看到它的状态。
    if (tableMap && Array.isArray(tableMap.objects?.entries)) {
      const viewMapId = inSub ? String(view.pointId) : "world";
      const tableObjects = tableMap.objects.entries
        // 三表口径：持有物（随身）与已销毁物不落地；没有精细格坐标的只进名单不画钉
        .filter((entry) => entry.holderCharacterId === null)
        .filter((entry) => !entry.status || entry.status !== "已销毁")
        .filter((entry) => String(entry.mapId ?? "") === viewMapId)
        .filter((entry) => typeof entry.gridX === "number" && typeof entry.gridY === "number");
      for (const entry of tableObjects) {
        const object = objectViewFromTableRow(entry);
        const dot = el("button", "aw-object");
        dot.type = "button";
        dot.dataset.objId = String(object.id ?? "");
        dot.style.left = `${Number(entry.gridX)}px`;
        dot.style.top = `${Number(entry.gridY)}px`;
        dot.title = `${String(object.name)}（${String(object.type)}）`;
        dot.setAttribute("aria-label", `物品 ${object.name}，点击查看详情`);
        dot.append(el("span", "aw-object__gem"));
        dot.append(el("span", "aw-object__name", String(object.name)));
        dot.addEventListener("click", (e) => {
          e.stopPropagation();
          openObjectPanel(object, dot);
        });
        mapLayer.append(dot);
      }
    }
    for (const object of tableMap ? [] : objects) {
      if (inSub || object.x === null || object.y === null) continue;
      // 0.9.41 物品标点 = 紫色小方块：点击出物品 popover
      const dot = el("button", "aw-object");
      dot.type = "button";
      dot.dataset.objId = String(object.id ?? "");
      const worldPos = { x: object.x, y: object.y };
      dot.style.left = `${Number(worldPos.x)}px`;
      dot.style.top = `${Number(worldPos.y)}px`;
      dot.title = `${String(object.name)}（${String(object.type)}）`;
      dot.setAttribute("aria-label", `物品 ${object.name}，点击查看详情`);
      dot.append(el("span", "aw-object__gem"));
      dot.append(el("span", "aw-object__name", String(object.name)));
      dot.addEventListener("click", (e) => {
        e.stopPropagation();
        openObjectPanel(object, dot);
      });
      mapLayer.append(dot);
    }

    /**
     * D-34（0.9.58）：**子图里的**人物图钉。
     *
     * 世界图仍然不画人物（S9 的理由成立：人物坐标 = 地点坐标，两枚标记叠在一起，
     * 而且"在某座城里"只到地点级）。但进到具体房间后，「谁在这个房间」正是地图该回答的问题，
     * 所以子图里按三表格坐标画人物图钉。
     * 只在坐标**不等于**所在子图的地点标点时才画：相等就说明只知道"在这个建筑里"，
     * 那种情况只进「建筑内 · 位置未知」名单（不伪造房间坐标）。
     */
    if (tableMap && inSub && Array.isArray(tableMap.nearby?.entries)) {
      /**
       * 当前子图画的是「宿主地点内部」，图上可见的房间 = `points`（宿主 + 同层房间）。
       * 所以能在图上落点的人 = 位置正好是这些房间之一的人。
       *
       * 反过来说：只知道"在这栋楼里"（位置 = 宿主地点本身）的人**不画点**——
       * 那正是地点级信息，画出来等于伪造房间坐标；他们由「建筑内 · 位置未知」名单承载。
       */
      const ownerId = String(view.pointId);
      const visibleRoomIds = new Set(points.map((point) => `loc:${String(point.id)}`));
      /**
       * 图上所有地点标点的坐标。人物坐标与之重合 = 那只是"地点级"信息
       * （例如子地点继承父坐标），画出来会与地点标点叠成两枚标记 —— 不画。
       * 用「全部可见标点」而不是只比宿主：子图里可见的是宿主 + 同层房间。
       */
      const pinCoords = new Set(points.map((point) => `${Number(point.x)}|${Number(point.y)}`));
      for (const entry of tableMap.nearby.entries) {
        const locationId = String(entry.locationId ?? "");
        if (!visibleRoomIds.has(locationId)) continue;
        if (entry.presence === "left") continue;
        if (entry.isProtagonist === true) continue; // 主角由 topbar / 地点名单呈现，不在地图上冒充 NPC
        // 只知道"在这栋楼里"（位置 = 宿主地点本身，没有房间级位置）→ 不画点：
        // 那正是地点级信息，画出来等于伪造房间坐标。他们由「建筑内 · 位置未知」名单承载。
        if (locationId === `loc:${ownerId}`) continue;
        if (typeof entry.gridX !== "number" || typeof entry.gridY !== "number") continue;
        if (pinCoords.has(`${Number(entry.gridX)}|${Number(entry.gridY)}`)) continue;
        const npc = npcViewFromTableRow(entry, { pointName: entry.locationName ?? null });
        const pin = el("button", "aw-object aw-object--npc");
        pin.type = "button";
        pin.dataset.npcId = npc.id;
        pin.style.left = `${Number(entry.gridX)}px`;
        pin.style.top = `${Number(entry.gridY)}px`;
        pin.title = String(npc.name);
        pin.setAttribute("aria-label", `人物 ${String(npc.name)}，点击查看详情`);
        pin.append(el("span", "aw-object__gem", String(npc.name ?? "?").slice(0, 1)));
        pin.append(el("span", "aw-object__name", String(npc.name)));
        pin.addEventListener("click", (event) => {
          event.stopPropagation();
          openNpcPanel(npc, pin);
        });
        mapLayer.append(pin);
      }
    }

    // H16 / H15（§2.5）：把**已证实**的范围格染成填区。
    // 数据源 = geoTopology.areas（只认 worldbook / story / manual 三种证据）；
    // 没有 areas 时一个格都不染，只有中心点的退化为 displayOnly 弱光圈（boundary 恒为 null）。
    // 图层顺序由 DOM 决定：底图 → 面积 → 网格 → 路线 → 地点/载具 → 徽标，与 §2.5 一致。
    areaLayer.innerHTML = "";
    if (typeof projectColorAreas === "function") {
      const topology = tableMap?.geoTopology ?? d.map?.geoTopology ?? null;
      const areaMapId = inSub ? String(view.pointId) : "world";
      const projection = topology
        ? projectColorAreas({
            mapId: areaMapId,
            frame: { cols: cameraFrame.spanX, rows: cameraFrame.spanY },
            topology,
            ...(tableMap?.branchKey ? { branchKey: String(tableMap.branchKey) } : {}),
            layers: { area: true },
          })
        : null;
      if (projection && projection.areas.length > 0) {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "aw-areas__svg");
        // viewBox 直接用世界（格）坐标：路径的格子坐标本来就与世界坐标同尺度
        svg.setAttribute("viewBox",
          `${cameraFrame.minX} ${cameraFrame.minY} ${cameraFrame.spanX} ${cameraFrame.spanY}`);
        svg.setAttribute("preserveAspectRatio", "none");
        svg.style.left = `${cameraFrame.minX}px`;
        svg.style.top = `${cameraFrame.minY}px`;
        svg.style.width = `${cameraFrame.spanX}px`;
        svg.style.height = `${cameraFrame.spanY}px`;
        for (const area of projection.areas) {
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("d", String(area.path ?? ""));
          path.setAttribute("class", `aw-areas__area is-${String(area.evidence ?? "manual")}`);
          path.style.opacity = String(area.opacity ?? 0.18);
          path.dataset.areaId = String(area.areaId ?? "");
          path.dataset.evidence = String(area.evidence ?? "");
          svg.append(path);
        }
        areaLayer.append(svg);
        areaLayer.dataset.paintedCells = String(projection.counts?.paintedCells ?? 0);
      } else {
        areaLayer.dataset.paintedCells = "0";
      }

      /**
       * H15（0.9.59）：`displayOnly` 弱光圈。
       *
       * 这些地点**没有已证实的格**，只有一个中心点，所以：
       * - 画成圆形光圈，半径用 `radiusCells`（示意半径，不是测出来的边界）；
       * - `boundary` 恒为 null，界面据此说明「范围未证实」，绝不假装成已勘定的区域；
       * - `evidence` 为 null 时不编造来源，样式走默认「示意」。
       * 与填区（areas）在同一个 SVG 里，但 class 分开，作者一眼能分辨「证实」与「示意」。
       */
      const halos = Array.isArray(projection?.halos) ? projection.halos : [];
      if (halos.length > 0) {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "aw-areas__svg aw-areas__svg--halos");
        svg.setAttribute("viewBox",
          `${cameraFrame.minX} ${cameraFrame.minY} ${cameraFrame.spanX} ${cameraFrame.spanY}`);
        svg.setAttribute("preserveAspectRatio", "none");
        svg.style.left = `${cameraFrame.minX}px`;
        svg.style.top = `${cameraFrame.minY}px`;
        svg.style.width = `${cameraFrame.spanX}px`;
        svg.style.height = `${cameraFrame.spanY}px`;
        for (const halo of halos) {
          const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          circle.setAttribute("cx", String(Number(halo.x) || 0));
          circle.setAttribute("cy", String(Number(halo.y) || 0));
          circle.setAttribute("r", String(Math.max(0, Number(halo.radiusCells) || 0)));
          circle.setAttribute("class",
            `aw-areas__halo is-${String(halo.layer ?? "area")}${halo.evidence ? "" : " is-unconfirmed"}`);
          circle.style.opacity = String(halo.opacity ?? 0.12);
          circle.dataset.displayOnly = "true";
          if (halo.areaId) circle.dataset.areaId = String(halo.areaId);
          if (halo.locationId) circle.dataset.locationId = String(halo.locationId);
          svg.append(circle);
        }
        areaLayer.append(svg);
        areaLayer.dataset.halos = String(halos.length);
      } else {
        areaLayer.dataset.halos = "0";
      }
    }

    const preview = state().destinationPreview;
    // 0.9.35 子图视图跳过路线预览：子图点位非世界点位，画不出有意义路线
    if (preview && !inSub) {
      const from = pointsAll.find((p) => String(p.id) === String(d.currentLocationId ?? ""));
      const to = pointsAll.find((p) => String(p.id) === String(preview.destinationId));
      if (from && to) {
        // R08：SVG 盒 = frame 精确框（stage 空间），viewBox = frame 局部坐标——
        // 路线、标记、网格、底图共用同一相机变换
        const a = { x: Number(from.x) - cameraFrame.minX, y: Number(from.y) - cameraFrame.minY };
        const b = { x: Number(to.x) - cameraFrame.minX, y: Number(to.y) - cameraFrame.minY };
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "aw-route");
        svg.setAttribute("viewBox", `0 0 ${cameraFrame.spanX} ${cameraFrame.spanY}`);
        svg.setAttribute("preserveAspectRatio", "none");
        svg.style.left = `${cameraFrame.minX}px`;
        svg.style.top = `${cameraFrame.minY}px`;
        svg.style.width = `${cameraFrame.spanX}px`;
        svg.style.height = `${cameraFrame.spanY}px`;
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", `M ${a.x} ${a.y} Q ${(a.x + b.x) / 2} ${(a.y + b.y) / 2 - Math.min(24, cameraFrame.spanY * 0.05)} ${b.x} ${b.y}`);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "#c4a363");
        path.setAttribute("stroke-width", "1.5");
        path.setAttribute("stroke-dasharray", "5 4");
        path.setAttribute("vector-effect", "non-scaling-stroke");
        svg.append(path);
        mapLayer.append(svg);
      }
    }

    if (mapData.mapImagePresent) {
      // R01 缓存键含底图版本（world.updatedAt）：换图 / 删图 / 世界更新都会换键，
      // 旧缓存不会残留在新图上；拉取失败删键允许下次重试，不永久记住失败。
      // B03：键再补上**作用域身份**（chatId|worldId|branchKey）——0.9.58 只有
      // `worldId|revision`，同世界的两个聊天 / 正史与 IF 会互相复用同一张底图。
      const imageRevision = String(mapData.mapImageRevision ?? d.currentTime ?? 0);
      const cacheKey = atlasMapImageCacheKey(mapIdentity, imageRevision);
      if (!mapImageCache.has(cacheKey)) {
        mapImageCache.set(cacheKey, null);
        // B03：回调里要复核的是「加载发起时的身份」，故先冻结一份不可变快照。
        const capturedIdentity = { ...mapIdentity };
        void api.request("POST", "/map/image", { chatId: String(state().chatId ?? "") }).then((result) => {
          const payload = result.body?.data?.dataUrl;
          if (result.status !== 200 || !result.body?.ok || typeof payload !== "string") {
            emitAtlasDiagnostic({ level: "warn", source: "map",
              code: "MAP_IMAGE_LOAD_FAILED", operation: "map-image",
              phase: "response", outcome: "failed", httpStatus: result.status,
              details: { route: "/map/image" } });
            mapImageCache.delete(cacheKey);
            return;
          }
          mapImageCache.set(cacheKey, payload);
          // B03：**先复核身份再重绘**。晚到的旧底图（切聊天 / 切分支 / 换世界之后才回来）
          // 只留在它自己那把缓存键下，绝不在新作用域触发一次重绘。
          const current = atlasMapIdentityOf(data(), state().chatId);
          if (!atlasSameMapIdentity(capturedIdentity, current) || atlasMapScopeKey(current) !== mapStackKey) {
            emitAtlasDiagnostic({ level: "info", source: "map",
              code: "STALE_MAP_IMAGE_DROPPED", operation: "map-image",
              phase: "response", outcome: "skipped",
              details: { reasonCode: "SESSION_IDENTITY_MISMATCH", route: "/map/image" } });
            return;
          }
          if (state().page === "map") renderMap(data());
        }).catch(() => {
          emitAtlasDiagnostic({ level: "warn", source: "map",
            code: "MAP_IMAGE_LOAD_FAILED", operation: "map-image",
            phase: "request", outcome: "failed", details: { route: "/map/image" } });
          mapImageCache.delete(cacheKey);
        });
      }
      const imageUrl = mapImageCache.get(cacheKey);
      if (imageUrl) {
        imageLayer.classList.add("has-image");
        imageLayer.style.backgroundImage = `url("${imageUrl}")`;
        imageLayer.style.backgroundSize = "100% 100%";
        imageLayer.style.backgroundRepeat = "no-repeat";
      }
    } else {
      // 无底图 / 删图 / 加载失败：清空底图层与旧缓存键，回到干净网格
      imageLayer.classList.remove("has-image");
      imageLayer.style.backgroundImage = "";
    }

    applyCamera();

    travelBar.innerHTML = "";
    if (preview) {
      travelBar.append(el("span", "aw-travel__title", `前往：${preview.destinationName}`));
      // 0.9.51（M06）：有标定时格程旁附物理距离（估计口径）；耗时语义一行不动——
      // 比例尺用于空间参考，旅行耗时沿用当前世界规则（lib/ 快照零改动，不重算已提交时间线）
      const metersPerCell = scaleCtx?.calibration?.metersPerCell ?? null;
      const distanceLabel = scaleApiMissing ? "" : formatTravelDistance(preview.distance, metersPerCell);
      travelBar.append(el("span", "aw-travel__meta", distanceLabel
        ? `距离 ${preview.distance} 格（${distanceLabel}，按标定估计） · 预计 ${preview.estimatedDuration} 时段（旅行耗时沿用世界规则）`
        : `距离 ${preview.distance} 格 · 预计 ${preview.estimatedDuration} 时段`));
      const actions = el("span", "aw-travel__actions");
      const confirm = el("button", "aw-btn aw-btn--primary", "填入行动");
      confirm.type = "button";
      confirm.setAttribute("aria-label", "把建议行动填入酒馆输入框（不自动发送）");
      confirm.addEventListener("click", () => core.confirmTravel());
      const cancel = el("button", "aw-btn", "取消");
      cancel.type = "button";
      cancel.setAttribute("aria-label", "取消旅行预览");
      cancel.addEventListener("click", () => core.cancelTravel());
      actions.append(confirm, cancel);
      travelBar.append(actions);
    }
  }

  // ---------------------------------------------------------------------------
  // 设置页：世界绑定 + 推演 API 管理（范式参照 shujuku：预设槽 / 加载模型 / 参数）
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // ATLAS-18 概览：当前世界卡（初始化状态 / 启停 / 高级迁移折叠）
  // ---------------------------------------------------------------------------

  function buildWorldCard(s, d = data()) {
    const panel = el("section", "aw-panel aw-world-card");
    panel.append(el("span", "aw-eyebrow", "当前世界"));

    if (s.binding) {
      // 世界 ID（world-auto-<hash>）是按聊天派生的确定性 ID（防重复建世），对用户无意义——展示世界名
      panel.append(el("p", "aw-panel__text", `已绑定：${String(d.worldName ?? s.binding.worldId)}`));
      panel.append(el("p", "aw-panel__meta", "每条回复完成后自动推演世界；结果写入世界书。"));
      const actions = el("div", "aw-actions");
      const toggle = el("button", "aw-btn", s.binding.enabled ? "停用本聊天推演" : "启用本聊天推演");
      toggle.type = "button";
      toggle.setAttribute("aria-label", "启用或停用本聊天的 Atlas 推演");
      toggle.addEventListener("click", () => void core.setEnabled(!s.binding?.enabled));
      actions.append(toggle);
      panel.append(actions);
      return panel;
    }

    // 未绑定：主路径 = 发送第一条消息自动建世（无需导入任何 JSON）
    panel.append(el("p", "aw-panel__text", "无需导入。发送第一条消息后，Atlas 会根据当前角色卡自动初始化世界。"));
    const status = s.worldInitialization ?? "idle";
    if (status === "initializing") {
      panel.append(el("p", "aw-panel__meta", "正在初始化世界…（本回合先生成回复，世界稍后就绪）"));
    } else if (status === "failed") {
      panel.append(el("div", "aw-note aw-note--error", String(s.worldInitializationError ?? "世界初始化未完成。")));
      const retry = el("button", "aw-btn aw-btn--primary", "重试初始化");
      retry.type = "button";
      retry.setAttribute("aria-label", "重试自动初始化世界");
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        try {
          await core.initializeWorld();
        } finally {
          retry.disabled = false;
          core.__renderPage?.();
        }
      });
      const actions = el("div", "aw-actions");
      actions.append(retry);
      panel.append(actions);
    } else {
      panel.append(el("p", "aw-panel__meta", "也可以直接在下方「高级」里绑定已有世界或导入 JSON。"));
    }
    return panel;
  }

  /** 概览底部：默认折叠的高级世界管理（迁移 / 恢复 / 诊断）。 */
  function buildAdvancedWorldSection(s) {
    const details = document.createElement("details");
    details.className = "aw-details";
    const summary = document.createElement("summary");
    summary.className = "aw-details__summary";
    summary.textContent = "高级：迁移或恢复已有世界";
    details.append(summary);

    const body = el("div", "aw-details__body");
    const actions = el("div", "aw-actions");

    const demo = el("button", "aw-btn aw-btn--ghost", "一键创建演示世界并绑定");
    demo.type = "button";
    demo.setAttribute("aria-label", "创建演示世界并绑定到当前聊天");
    demo.addEventListener("click", async () => {
      demo.disabled = true;
      try {
        const world = mod.buildWorldFromTemplate(mod.DEMO_TEMPLATES[0], {
          id: `world-demo-${Date.now()}`,
          now: Date.now(),
        });
        const result = await api.request("POST", "/worlds/import", { world });
        if (result.status !== 200 || !result.body?.ok) {
          settingsStatus = `演示世界创建被拒绝：${result.body?.error?.message ?? `HTTP ${result.status}`}`;
          settingsStatusKind = "error";
          core.__renderPage?.();
          return;
        }
        await core.bindToWorld(String(world.id));
        core.setPage("overview");
        core.__renderPage?.();
      } catch (error) {
        settingsStatus = `演示世界创建失败：${error instanceof Error ? error.message : String(error)}`;
        settingsStatusKind = "error";
        core.__renderPage?.();
      } finally {
        demo.disabled = false;
      }
    });
    actions.append(demo);

    const list = el("button", "aw-btn aw-btn--ghost", "读取可绑定世界列表");
    list.type = "button";
    list.setAttribute("aria-label", "读取 Atlas 世界列表");
    list.addEventListener("click", async () => {
      const worlds = await core.requestWorlds();
      renderWorldList(worlds);
    });
    actions.append(list);

    const importLabel = el("label", "aw-btn aw-btn--ghost", "导入世界 JSON");
    const file = document.createElement("input");
    file.type = "file";
    file.accept = ".json,application/json";
    file.setAttribute("aria-label", "选择 Atlas 世界 JSON 文件导入");
    file.style.display = "none";
    file.addEventListener("change", async () => {
      const selected = file.files && file.files[0];
      if (!selected) return;
      try {
        const parsed = JSON.parse(await selected.text());
        const result = await api.request("POST", "/worlds/import", { world: parsed });
        if (result.status !== 200 || !result.body?.ok) {
          settingsStatus = `世界导入被拒绝：${result.body?.error?.message ?? `HTTP ${result.status}`}`;
          settingsStatusKind = "error";
          renderCenter();
          return;
        }
        // 0.9.42 会话承载：导入的世界已进当前聊天会话——直接绑定（旧「可绑定列表」只列未迁移的存量世界）
        await core.bindToWorld(String(parsed.id));
        settingsStatus = `已导入并绑定「${String(result.body.data?.name ?? result.body.data?.id ?? "")}」。`;
        settingsStatusKind = "ok";
        renderCenter();
      } catch (error) {
        settingsStatus = `世界导入失败：${error instanceof Error ? error.message : String(error)}`;
        settingsStatusKind = "error";
        renderCenter();
      }
    });
    importLabel.append(file);
    actions.append(importLabel);

    if (s.binding) {
      const unbind = el("button", "aw-btn aw-btn--danger", "解绑本聊天世界");
      unbind.type = "button";
      unbind.setAttribute("aria-label", "解绑当前聊天的 Atlas 世界");
      unbind.addEventListener("click", async () => {
        const confirmed = typeof window === "undefined" || typeof window.confirm !== "function"
          ? true
          : window.confirm("解绑后，下一条消息会按当前角色卡自动重建世界；只想暂停推演请用「停用」。继续解绑？");
        if (!confirmed) return;
        await core.unbind();
      });
      actions.append(unbind);
    }

    body.append(actions);
    if (settingsStatus) {
      body.append(el("p", `aw-status${settingsStatusKind === "error" ? " aw-status--error" : ""}`, settingsStatus));
    }
    details.append(body);
    return details;
  }

  function renderWorldList(worlds) {
    const panel = center.querySelector(".aw-world-list-panel");
    if (panel) panel.remove();
    const wrap = el("section", "aw-panel aw-world-list-panel");
    wrap.append(el("span", "aw-eyebrow", "可绑定世界"));
    if (worlds.length === 0) {
      wrap.append(el("p", "aw-panel__text", "本地暂无世界——用上面的「导入世界 JSON」导入一个。"));
    } else {
      const list = el("div", "aw-list");
      for (const world of worlds) {
        const item = el("button", "aw-list__item", `${String(world.name ?? world.id)}（${String(world.pointCount ?? 0)} 地点）`);
        item.type = "button";
        item.setAttribute("aria-label", `绑定世界 ${String(world.name ?? world.id)}`);
        item.addEventListener("click", async () => {
          await core.bindToWorld(String(world.id));
          if (core.getState().binding) {
            core.setPage("overview");
            core.__renderPage?.();
          }
        });
        list.append(item);
      }
      wrap.append(list);
    }
    center.append(wrap);
  }

  // ---------------------------------------------------------------------------
  // ATLAS-18 设置 v2：两库（API 连接 / 提示词）草稿 + 命令
  // ---------------------------------------------------------------------------

  let settingsV2 = null;
  let apiLibrary = [];
  let apiDraft = null;
  let apiDraftDirty = false;
  let apiKeyInput = ""; // 0.9.12（shujuku 语义）：编辑器持有的密钥——载入预设时回填，保存 / 测试连接直接用它
  let promptLibrary = [];
  let promptDraft = null;
  let promptDraftDirty = false;
  let settingsLoadState = "loading";
  let settingsStatus = "";
  let settingsStatusKind = "";

  const BUILTIN_PROMPT_ID = "builtin-default";

  function statusLine() {
    if (!settingsStatus) return null;
    return el("p", `aw-status${settingsStatusKind === "error" ? " aw-status--error" : ""}`, settingsStatus);
  }

  /**
   * S8 补刀（S10 实测暴露）：状态提示只写变量时，点击后要等**下一次重渲染**才可见——
   * 「定位当前位置」的子地点提示、地图页提炼失败提示都因此看起来像没反应；
   * 子图视图下点击还会先看到上一条旧提示。
   * 这里就地更新已挂载的状态行；首次提示尚无节点时补挂一条（位置与各页渲染时一致，
   * 都是 center 末尾）。只动状态行，不整页重渲染——不打扰相机 / 草稿 / 输入焦点。
   */
  function refreshStatusLine() {
    const existing = center.querySelector(".aw-status");
    if (existing) {
      existing.textContent = settingsStatus;
      existing.className = `aw-status${settingsStatusKind === "error" ? " aw-status--error" : ""}`;
      return;
    }
    const line = statusLine();
    if (line) center.append(line);
  }

  function setStatus(text, kind = "ok") {
    settingsStatus = text;
    settingsStatusKind = kind;
    refreshStatusLine();
  }

  async function loadSettingsV2(force = false) {
    if (settingsV2 && !force) return settingsV2;
    settingsLoadState = "loading";
    try {
      const result = await api.request("GET", "/settings");
      if (result.status !== 200 || !result.body?.ok || !result.body.data) {
        setStatus("读取设置失败：" + (result.body?.error?.message ?? ("HTTP " + result.status)), "error");
        settingsLoadState = "error";
        return settingsV2;
      }
      settingsV2 = result.body.data;
      apiLibrary = Array.isArray(settingsV2.apiPresets) ? settingsV2.apiPresets : [];
      promptLibrary = Array.isArray(settingsV2.promptPresets) ? settingsV2.promptPresets : [];
      if (Number(settingsV2.recoveryPromptCount) > 0) {
        setStatus("发现 " + Number(settingsV2.recoveryPromptCount) + " 条旧提示词预设无法读取。原始设置已保护为只读，请先备份和恢复。", "error");
      }
      // Initialize only after a successful first load. A refresh preserves edits.
      if (promptDraft === null) {
        const activeId = settingsV2.activePromptPresetId;
        const active = promptLibrary.find((preset) => preset.id === activeId);
        if (activeId == null) promptDraft = builtinPromptDraft();
        else if (active) promptDraft = savedPromptDraft(active);
        else setStatus("当前提示词预设 " + String(activeId) + " 未找到；请先检查或恢复预设数据。", "error");
      }
      settingsLoadState = "loaded";
      return settingsV2;
    } catch (error) {
      setStatus("读取设置失败：" + (error instanceof Error ? error.message : String(error)), "error");
      settingsLoadState = "error";
      return settingsV2;
    }
  }

  async function sendSettingsCommand(command) {
    let result;
    try {
      result = await api.request("PUT", "/settings", command);
    } catch {
      emitAtlasDiagnostic({ level: "error", source: "ui", code: "SETTINGS_SAVE_FAILED",
        operation: "settings", phase: "request", outcome: "failed",
        retryable: true, details: { route: "/settings" } });
      setStatus("设置未保存：连接失败。草稿仍保留，可重试。", "error");
      return false;
    }
    if (result.status !== 200 || !result.body?.ok) {
      emitAtlasDiagnostic({ level: "error", source: "ui", code: "SETTINGS_SAVE_FAILED",
        operation: "settings", phase: "response", outcome: "failed",
        httpStatus: result.status, errorCode: result.body?.error?.code,
        details: { route: "/settings" } });
      setStatus(`设置未保存：${result.body?.error?.message ?? `HTTP ${result.status}`}`, "error");
      return false;
    }
    settingsV2 = result.body.data;
    apiLibrary = Array.isArray(settingsV2.apiPresets) ? settingsV2.apiPresets : [];
    promptLibrary = Array.isArray(settingsV2.promptPresets) ? settingsV2.promptPresets : [];
    emitAtlasDiagnostic({ level: "info", source: "ui", code: "SETTINGS_SAVE_COMPLETE",
      operation: "settings", phase: "response", outcome: "success",
      httpStatus: result.status, details: { route: "/settings" } });
    return true;
  }

  /** 统一未保存确认文案（规格 0.7.4）。 */
  function confirmDiscard(what) {
    if (typeof window === "undefined" || typeof window.confirm !== "function") return true;
    return window.confirm(`当前有未保存的更改。继续将丢弃这些更改。（${what}）`);
  }

  function newApiDraft() {
    return {
      id: null,
      name: "",
      connectionMode: "custom",
      endpoint: "",
      model: "",
      maxTokens: 1024,
      temperature: 0.7,
      topP: 0.95,
      timeoutMs: 30_000,
      apiFormat: "openai",
      profileId: "",
      bodyParams: "",
      excludeBodyParams: "",
      requestHeaders: "",
      promptPostProcessing: "strict",
      systemPrompt: "",
    };
  }

  /** 视图条目 → 草稿（0.9.13 全字段）。 */
  function apiDraftFromView(preset) {
    return preset
      ? {
          id: preset.id,
          name: preset.name,
          connectionMode: preset.connectionMode ?? "custom",
          endpoint: preset.endpoint ?? "",
          model: preset.model ?? "",
          maxTokens: preset.maxTokens,
          temperature: preset.temperature,
          topP: typeof preset.topP === "number" ? preset.topP : 0.95,
          timeoutMs: preset.timeoutMs,
          apiFormat: preset.apiFormat ?? "openai",
          profileId: preset.profileId ?? "",
          bodyParams: preset.bodyParams ?? "",
          excludeBodyParams: preset.excludeBodyParams ?? "",
          requestHeaders: preset.requestHeaders ?? "",
          promptPostProcessing: preset.promptPostProcessing ?? "",
          systemPrompt: preset.systemPrompt ?? "",
        }
      : newApiDraft();
  }

  /** 草稿 → api.save 预设载荷（0.9.13 全字段）。 */
  function apiPayloadFromDraft(preset) {
    return {
      ...(preset.id ? { id: preset.id } : {}),
      name: preset.name,
      connectionMode: preset.connectionMode === "main" || preset.connectionMode === "profile" ? preset.connectionMode : "custom",
      endpoint: String(preset.endpoint ?? ""),
      model: String(preset.model ?? ""),
      maxTokens: Number(preset.maxTokens) || 1024,
      temperature: Number.isFinite(Number(preset.temperature)) ? Number(preset.temperature) : 0.7,
      topP: Number.isFinite(Number(preset.topP)) ? Number(preset.topP) : 0.95,
      timeoutMs: Number(preset.timeoutMs) || 30_000,
      apiFormat: preset.apiFormat ?? "openai",
      profileId: String(preset.profileId ?? ""),
      bodyParams: String(preset.bodyParams ?? ""),
      excludeBodyParams: String(preset.excludeBodyParams ?? ""),
      requestHeaders: String(preset.requestHeaders ?? ""),
      promptPostProcessing: String(preset.promptPostProcessing ?? ""),
      systemPrompt: String(preset.systemPrompt ?? ""),
    };
  }

  /**
   * R02 草稿状态模型：kind 显式区分「内置只读展示 / 未保存新草稿 / 已保存预设的工作副本」，
   * 不再用 `!id => 内置只读` 推断（旧推断把新建草稿错当内置，名称只读、无插入按钮——D07 根因）。
   */
  function newPromptDraft() {
    return { id: null, kind: "new", name: "", systemPrompt: "", segments: [], contextTurnCount: 3 };
  }

  /** 内置默认在编辑器中的只读展示形态（原件保护在存储层，UI 只读展示）。 */
  function builtinPromptDraft() {
    return { id: null, kind: "builtin", name: "内置默认", systemPrompt: "", segments: [], contextTurnCount: 3 };
  }

  /** 把已保存预设载入为工作副本（kind=saved；可编辑，保存语义 = 覆盖回该 id）。 */
  function savedPromptDraft(preset) {
    return {
      id: preset.id,
      kind: "saved",
      name: preset.name,
      systemPrompt: preset.systemPrompt,
      segments: cloneSegments(preset.segments),
      contextTurnCount: Number.isFinite(preset.contextTurnCount) ? preset.contextTurnCount : 3,
    };
  }

  /** 0.9.25 shujuku 栏位段克隆：保留名称 / 主槽位（丢字段 = 编辑一轮就退化）。 */
  function cloneSegments(segments) {
    return Array.isArray(segments)
      ? segments.map((s) => ({
          role: s.role,
          content: s.content,
          ...(typeof s.name === "string" && s.name ? { name: s.name } : {}),
          ...(s.mainSlot === "A" || s.mainSlot === "B" || s.mainSlot === "" ? { mainSlot: s.mainSlot } : {}),
        }))
      : [];
  }

  /** 分段角色白名单（0.9.18，与 src/atlas-settings.ts PROMPT_SEGMENT_ROLES 同口径）。 */
  const PROMPT_SEGMENT_ROLES = ["system", "user", "assistant"];

  function activePromptText() {
    if (!settingsV2) return "";
    const active = promptLibrary.find((p) => p.id === settingsV2.activePromptPresetId);
    // 0.9.18 分段模式：预览逐段 [role] 正文（占位符保持原样，发送时才替换）
    if (active && Array.isArray(active.segments) && active.segments.length > 0) {
      return active.segments.map((s) => `[${s.role}] ${String(s.content ?? "")}`).join("\n\n");
    }
    if (active) return String(active.systemPrompt ?? "");
    // 0.9.40 内置默认以分段形态预览（与发送时多轮组装一致）
    const builtinSegs = Array.isArray(settingsV2.builtInPrompt?.segments) ? settingsV2.builtInPrompt.segments : [];
    if (builtinSegs.length > 0) {
      return builtinSegs.map((s) => `[${String(s?.role ?? "system")}] ${String(s?.content ?? "")}`).join("\n\n");
    }
    return String(settingsV2.builtInPrompt?.systemPrompt ?? "");
  }

  function activeApiLabel() {
    const active = apiLibrary.find((p) => p.id === settingsV2?.activeApiPresetId);
    return active ? `${active.name}（${active.model}）` : "未配置";
  }

  // ---------------------------------------------------------------------------
  // ATLAS-18 「推进」页：只管理推进行为与提示词（不出现 endpoint / Key / 模型输入）
  // ---------------------------------------------------------------------------

  function buildProgressionPanel() {
    const panel = el("section", "aw-panel");
    panel.append(el("span", "aw-eyebrow", "推进状态"));
    const s = state();
    if (!settingsV2) {
      panel.append(el("p", settingsLoadState === "error" ? "aw-note aw-note--error" : "aw-panel__meta",
        settingsLoadState === "error" ? settingsStatus : "正在读取提示词与设置…"));
      if (settingsLoadState === "error") {
        const retry = el("button", "aw-btn", "重试读取设置");
        retry.type = "button";
        retry.addEventListener("click", async () => { await loadSettingsV2(true); renderCenter(); });
        panel.append(retry);
      }
      return panel;
    }
    if (Number(settingsV2.recoveryPromptCount) > 0) {
      panel.append(el("p", "aw-note aw-note--error",
        "发现 " + Number(settingsV2.recoveryPromptCount) + " 条旧提示词预设无法读取。为防止覆盖原始内容，设置写入已暂停；请先备份原始设置并恢复预设。"));
    }
    if (!promptDraft && settingsV2.activePromptPresetId != null) {
      panel.append(el("p", "aw-note aw-note--error", settingsStatus || "当前提示词预设未找到。"));
      const useBuiltin = el("button", "aw-btn", "明确改用内置默认");
      useBuiltin.type = "button";
      useBuiltin.addEventListener("click", async () => {
        if (await sendSettingsCommand({ action: "prompt.activate", id: null })) {
          promptDraft = builtinPromptDraft();
          promptDraftDirty = false;
          setStatus("已改用内置默认。");
        }
        renderCenter();
      });
      panel.append(useBuiltin);
      return panel;
    }

    // 状态行内联（shujuku 式：label + 值一行一条），不再用统计卡阵
    const rows = el("div", "aw-rows");
    const statusRows = [
      ["本聊天推演", s.binding ? (s.binding.enabled ? "已启用" : "已停用") : "未绑定"],
      ["自动提交", settingsV2?.autoCommit === false ? "关闭（回复后不自动推进）" : "开启（每条回复后自动推进）"],
      ["当前提示词", promptLibrary.find((p) => p.id === settingsV2?.activePromptPresetId)?.name ?? "内置默认"],
      ["当前 API", activeApiLabel()],
    ];
    for (const [label, value] of statusRows) {
      const row = el("div", "aw-row");
      row.append(el("span", "aw-row__label", label));
      row.append(el("span", "aw-row__value", String(value)));
      rows.append(row);
    }
    panel.append(rows);

    // R02（D16）：连接级 systemPrompt 覆盖推进预设时必须显式提示——这是「改了预设没生效」
    // 的直接原因；提供一键恢复（清空连接级提示词，回到推进预设生效）
    const overrideApi = apiLibrary.find((p) => p.id === settingsV2?.activeApiPresetId);
    if (overrideApi && String(overrideApi.systemPrompt ?? "").trim()) {
      const overrideNote = el("div", "aw-note aw-note--error");
      overrideNote.append(el("span", {}, "当前 API 连接「" + String(overrideApi.name) + "」带有连接级系统提示词——发送时它会覆盖这里的推进预设。"));
      const clearOverride = el("button", "aw-btn aw-btn--ghost", "清空连接级提示词（恢复推进预设生效）");
      clearOverride.type = "button";
      clearOverride.setAttribute("aria-label", "清空当前 API 连接的系统提示词，让推进预设重新生效");
      clearOverride.addEventListener("click", async () => {
        clearOverride.disabled = true;
        try {
          const ok = await sendSettingsCommand({ action: "api.save", preset: { ...apiPayloadFromDraft(overrideApi), systemPrompt: "" } });
          setStatus(ok ? "连接级提示词已清空，推进预设恢复生效。" : "清空失败。", ok ? "ok" : "error");
          renderCenter();
        } finally {
          clearOverride.disabled = false;
        }
      });
      overrideNote.append(clearOverride);
      panel.append(overrideNote);
    }

    const runtimeActions = el("div", "aw-actions");
    const toggle = el("button", "aw-btn", s.binding?.enabled ? "停用本聊天推演" : "启用本聊天推演");
    toggle.type = "button";
    toggle.setAttribute("aria-label", "启用或停用本聊天的 Atlas 推演");
    toggle.addEventListener("click", () => { void core.setEnabled(!state().binding?.enabled); });
    const autoCommit = el("button", "aw-btn aw-btn--ghost", settingsV2?.autoCommit === false ? "开启自动提交" : "关闭自动提交");
    autoCommit.type = "button";
    autoCommit.setAttribute("aria-label", "切换每条回复后自动提交");
    autoCommit.addEventListener("click", async () => {
      const ok = await sendSettingsCommand({ action: "runtime.update", autoCommit: settingsV2?.autoCommit === false });
      setStatus(ok ? "推进设置已更新。" : settingsStatus, ok ? "ok" : "error");
      renderCenter();
    });
    const gotoApi = el("button", "aw-btn aw-btn--ghost", "前往 API");
    gotoApi.type = "button";
    gotoApi.setAttribute("aria-label", "前往 API 连接页");
    gotoApi.addEventListener("click", () => core.setPage("api"));
    // 0.9.22 立即推演：不发言也让世界流动（合成一回合，消耗一次推演请求）
    const manualBtn = el("button", "aw-btn", "立即推演");
    manualBtn.type = "button";
    manualBtn.setAttribute("aria-label", "立即推演一次（不新增剧情，消耗一次推演请求）");
    manualBtn.addEventListener("click", () => {
      const confirmed = typeof window === "undefined" || typeof window.confirm !== "function"
        ? true
        : window.confirm("立即推演会消耗一次推演请求（不新增剧情，仅让世界流动），继续？");
      if (!confirmed) return;
      void core.manualAdvance();
    });
    // 0.9.22 世界书资料开关：被供应商审核拦截时的逃生门（关掉 = 推演回到 0.9.20 前的上下文）
    const loreToggle = el("button", "aw-btn aw-btn--ghost", settingsV2?.loreSupplementEnabled === false ? "开启世界书资料" : "关闭世界书资料");
    loreToggle.type = "button";
    loreToggle.setAttribute("aria-label", "切换推演是否附带世界书资料（被审核拦截时关闭）");
    loreToggle.addEventListener("click", async () => {
      const ok = await sendSettingsCommand({ action: "runtime.update", loreSupplementEnabled: settingsV2?.loreSupplementEnabled === false });
      setStatus(ok ? "推进设置已更新。" : settingsStatus, ok ? "ok" : "error");
      renderCenter();
    });
    runtimeActions.append(toggle, autoCommit, manualBtn, loreToggle, gotoApi);
    panel.append(runtimeActions);
    if (statusLine()) panel.append(statusLine());

    // R06：场景定位——当前场景未知与「上次确认」分开表达；开场识别（mode=bootstrap，
    // duration=0，只定位不推进时间）；起始占位迁移状态显式化
    const sceneState = state().scene ?? null;
    const sceneSection = el("div", "aw-rows");
    const sceneKnown = sceneState ? Boolean(sceneState.known) : null;
    const sceneStatusRows = [
      ["当前场景", sceneKnown === null ? "—" : sceneKnown ? "已锚定" : "未知（尚无可信证据）"],
      [
        "上次确认",
        sceneState?.lastConfirmed
          ? `${sceneState.lastConfirmed.pointName ?? sceneState.lastConfirmed.pointId}${sceneState.lastConfirmed.at != null ? `（时刻 ${sceneState.lastConfirmed.at}）` : ""}`
          : "无",
      ],
      [
        "推进协议",
        // C07：当前值要写清是哪一个（表格增量不能显示成 "vtable-delta-v1"）
        // 0.9.58：新装默认已是 table-delta-v1，缺省显示也必须跟它一致
        String(settingsV2?.worldTurnProtocol ?? "table-delta-v1") === "table-delta-v1"
          ? "表格增量（table-delta-v1）"
          : `v${String(settingsV2?.worldTurnProtocol ?? "table-delta-v1").replace(/^v/, "")}`,
      ],
    ];
    for (const [label, value] of sceneStatusRows) {
      const row = el("div", "aw-row");
      row.append(el("span", "aw-row__label", label));
      row.append(el("span", "aw-row__value", String(value)));
      sceneSection.append(row);
    }
    if (sceneState?.placeholder?.isPlaceholder && !sceneState.placeholder.retired) {
      sceneSection.append(el("span", "aw-hint", "当前世界的「起点」为系统占位（结构指纹吻合、无编辑证据）。识别当前场景成功后会自动退役（保留历史引用，不再按真实地点展示）。"));
    } else if (sceneState?.placeholder?.retired) {
      sceneSection.append(el("span", "aw-hint", "系统占位「起点」已退役：历史引用保留，地图与地点列表不再展示。"));
    }
    const sceneActions = el("div", "aw-actions");
    const sceneBtn = el("button", "aw-btn", "识别当前场景");
    sceneBtn.type = "button";
    sceneBtn.setAttribute("aria-label", "从开场白识别当前场景与在场人物（消耗 1 次推演请求，先预览不写入）");
    let scenePreview = null;
    const scenePreviewBox = el("div", "aw-request-preview");
    sceneBtn.addEventListener("click", async () => {
      const chatId = String(state().chatId ?? "");
      if (!chatId) { setStatus("当前没有活动聊天。", "error"); return; }
      const confirmed = typeof window === "undefined" || typeof window.confirm !== "function"
        ? true
        : window.confirm("识别当前场景会消耗 1 次推演请求（mode=bootstrap，只定位不推进时间）。先生成预览，确认后才写入世界。继续？");
      if (!confirmed) return;
      sceneBtn.disabled = true;
      try {
        const ctx = typeof context === "function" ? context() : null;
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
        const assistantText = [...chat].reverse().map((m) => String(m?.mes ?? "")).find((t) => t.trim().length > 0) ?? "";
        const userText = [...chat].reverse().map((m) => (!m?.is_user ? "" : String(m?.mes ?? ""))).find((t) => t.trim().length > 0) ?? "";
        const recentAssistantTexts = chat.filter((m) => !m?.is_user).slice(-3).map((m) => String(m?.mes ?? ""));
        const result = await api.request("POST", "/scene/bootstrap", { chatId, apply: false, userText, assistantText, recentAssistantTexts });
        scenePreviewBox.innerHTML = "";
        if (result.status !== 200 || !result.body?.ok) {
          scenePreviewBox.append(el("p", "aw-note aw-note--error", result.body?.error?.message ?? `识别失败（HTTP ${result.status}）`));
          return;
        }
        scenePreview = result.body.data ?? null;
        const data = scenePreview;
        const sceneText = data.scene
          ? `${data.scene.resolution}${data.scene.locationRef ? ` · ${data.scene.locationRef}` : ""}${data.scene.transition ? ` · ${data.scene.transition}` : ""}`
          : "—";
        scenePreviewBox.append(el("p", "aw-panel__meta", `识别结果（预览，未写入）：场景 ${sceneText}`));
        if (Array.isArray(data.newLocations) && data.newLocations.length > 0) {
          scenePreviewBox.append(el("p", "aw-panel__meta", `新地点：${data.newLocations.map((l) => l.name).join("、")}`));
        }
        if (Array.isArray(data.newCharacters) && data.newCharacters.length > 0) {
          scenePreviewBox.append(el("p", "aw-panel__meta", `新人物：${data.newCharacters.map((c) => c.displayName).join("、")}`));
        }
        if (Array.isArray(data.npcUpdates) && data.npcUpdates.length > 0) {
          scenePreviewBox.append(el("p", "aw-panel__meta", `人物更新：${data.npcUpdates.map((u) => `${u.entityRef}${u.locationRef ? `→${u.locationRef}` : ""}${u.status ? `（${u.status}）` : ""}`).join("；")}`));
        }
        scenePreviewBox.append(el("p", "aw-panel__meta", data.summary ? `摘要：${data.summary}` : "（无摘要）"));
        const applyBtn = el("button", "aw-btn aw-btn--primary", "应用（一次提交，不推进时间）");
        applyBtn.type = "button";
        applyBtn.setAttribute("aria-label", "按预览结果提交场景锚定（duration=0，不推进时间）");
        applyBtn.addEventListener("click", async () => {
          applyBtn.disabled = true;
          try {
            const applyResult = await api.request("POST", "/scene/bootstrap", { chatId, apply: true, userText, assistantText, recentAssistantTexts });
            if (applyResult.status !== 200 || !applyResult.body?.ok) {
              setStatus(applyResult.body?.error?.message ?? `应用失败（HTTP ${applyResult.status}）`, "error");
              return;
            }
            const applied = applyResult.body.data ?? {};
            setStatus(applied.status === "committed" ? "场景已锚定，世界已更新。" : `应用完成：${applied.status ?? "未知状态"}。`, applied.status === "committed" ? "ok" : "error");
            scenePreview = null;
            scenePreviewBox.innerHTML = "";
            renderCenter();
          } finally {
            applyBtn.disabled = false;
          }
        });
        scenePreviewBox.append(applyBtn);
      } catch (error) {
        setStatus(`识别失败：${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        sceneBtn.disabled = false;
      }
    });
    /**
     * E08（0.9.59）：协议控件收口——**删掉三选一**，改为固定的「表格增量」说明。
     *
     * E01 之后 `runtime.update` 只接受 `table-delta-v1`，再摆一个能选 v1/v2 的下拉
     * 等于让作者点一个必然失败的按钮。这里改成只读说明；如果存档里原本是 v1/v2，
     * 明确写出「历史设置已升级为表格增量」（设置读取视图的 `worldTurnProtocolLegacy`
     * 给的就是这个信号），**不擅自改写**用户存档里的原值。
     */
    const legacyProtocolNotice = settingsV2?.legacyWorldTurnProtocol ?? null;
    const protocolNote = el("div", "aw-note");
    protocolNote.append(el("strong", "", "推进输出协议：表格增量（table-delta-v1）"));
    protocolNote.append(document.createTextNode(
      "模型回复只要求一块 <atlasEdit>，块内每行一个独立 JSON（地点 / 人物 / 物品 / 提案新消息）。"
      + "旧的 v1 世界草稿与 v2 整份封套已停用；若模型仍按旧格式输出，本轮会被判为协议不符并拒绝提交。",
    ));
    if (legacyProtocolNotice && typeof legacyProtocolNotice === "object") {
      // 原文一字不改，只如实告诉作者「存档里还是旧值、运行时已按增量解读」
      protocolNote.append(el("p", "aw-note aw-note--warn",
        String(legacyProtocolNotice.message
          ?? `历史设置已升级为表格增量（存档里的原值是 ${String(legacyProtocolNotice.storedValue ?? "")}，未改动）。`)));
    }
    sceneActions.append(sceneBtn, protocolNote);

    const checkWorldBtn = el("button", "aw-btn aw-btn--ghost", "检查当前世界");
    checkWorldBtn.type = "button";
    checkWorldBtn.setAttribute("aria-label", "只读检查旧起点、账本位置、人物与孤立子图");
    const repairBox = el("div", "aw-request-preview");
    checkWorldBtn.addEventListener("click", async () => {
      const chatId = String(state().chatId ?? "");
      if (!chatId) { setStatus("当前没有活动聊天。", "error"); return; }
      checkWorldBtn.disabled = true;
      try {
        const response = await api.request("POST", "/scene/repair-start", { chatId, apply: false });
        repairBox.innerHTML = "";
        if (response.status !== 200 || !response.body?.ok) {
          repairBox.append(el("p", "aw-note aw-note--error", response.body?.error?.message ?? "检查失败"));
          return;
        }
        const report = response.body.data?.report;
        if (!report) return;
        repairBox.append(el("p", "aw-panel__meta", "只读检查：系统起点结构 " +
          (report.structuralFingerprint ? "吻合" : "不吻合") + "；完整占位指纹 " +
          (report.fullFingerprint ? "吻合" : "不吻合") + "；" + report.reason));
        repairBox.append(el("p", "aw-panel__meta", "绑定位置 " + (report.bindingPointId ?? "未知") +
          " · 账本位置 " + (report.ledgerPointId ?? "未知") +
          " · 上次确认 " + (report.confirmedPointId ?? "无") +
          " · 本分支账本事件 " + report.eventCount));
        repairBox.append(el("p", "aw-panel__meta", "人物位置 " + report.characterPositions.length +
          " 条 · 孤立地点 " + report.orphanPointIds.length +
          " 条 · 孤立子图 " + report.orphanSubmapIds.length + " 条"));
        if (report.fingerprintReasons?.length) {
          repairBox.append(el("p", "aw-panel__meta", "指纹差异：" + report.fingerprintReasons.join("；")));
        }
        if (report.orphanPointIds?.length || report.orphanSubmapIds?.length) {
          repairBox.append(el("p", "aw-panel__meta",
            "孤立 ID：" + [...report.orphanPointIds, ...report.orphanSubmapIds].join("、")));
        }
        if (!report.canApply) return;
        const applyRepair = el("button", "aw-btn aw-btn--primary", "下载备份并退役旧起点");
        applyRepair.type = "button";
        applyRepair.addEventListener("click", async () => {
          applyRepair.disabled = true;
          try {
            const snapshot = readAtlasSession(context);
            if (!snapshot || snapshot.binding?.chatId !== chatId ||
                snapshot.world?.id !== state().worldId) {
              throw new Error("当前聊天的 Atlas 会话备份不可读取，修复已取消。");
            }
            const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = "atlas-before-start-repair.json";
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            const confirmed = typeof window === "undefined" || typeof window.confirm !== "function"
              ? true : window.confirm("已下载当前 Atlas 会话备份。将保留历史地点与地图资料，只把系统占位「起点」标为退役，并按检查报告修正当前位置。继续？");
            if (!confirmed) return;
            const applied = await api.request("POST", "/scene/repair-start", {
              chatId, apply: true, reportToken: report.reportToken,
            });
            if (applied.status !== 200 || !applied.body?.ok) {
              throw new Error(applied.body?.error?.message ?? "修复失败");
            }
            setStatus(applied.body.data?.status === "repaired" ? "旧起点已退役，备份已下载。" : "旧起点已处理，无需重复修复。", "ok");
            await core.refresh();
            renderCenter();
          } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error), "error");
          } finally {
            applyRepair.disabled = false;
          }
        });
        repairBox.append(applyRepair);
      } catch (error) {
        repairBox.append(el("p", "aw-note aw-note--error", error instanceof Error ? error.message : String(error)));
      } finally {
        checkWorldBtn.disabled = false;
      }
    });
    sceneActions.append(checkWorldBtn);
    const restoreBackupInput = document.createElement("input");
    restoreBackupInput.type = "file";
    restoreBackupInput.accept = ".json,application/json";
    restoreBackupInput.hidden = true;
    const restoreBackupBtn = el("button", "aw-btn aw-btn--ghost", "恢复 Atlas 会话备份");
    restoreBackupBtn.type = "button";
    restoreBackupBtn.addEventListener("click", () => restoreBackupInput.click());
    restoreBackupInput.addEventListener("change", async () => {
      const file = restoreBackupInput.files?.[0];
      if (!file) return;
      try {
        if (file.size > 50 * 1024 * 1024) throw new Error("备份文件过大，拒绝导入。");
        const parsed = JSON.parse(await file.text());
        const current = readAtlasSession(context);
        const chatId = String(state().chatId ?? "");
        if (!current || !isValidAtlasSession(parsed) ||
            parsed.binding?.chatId !== chatId ||
            parsed.world?.id !== current.world?.id ||
            parsed.binding?.worldId !== parsed.world?.id) {
          throw new Error("备份与当前聊天或世界不匹配，未恢复。");
        }
        const confirmed = typeof window === "undefined" || typeof window.confirm !== "function"
          ? true : window.confirm("恢复备份会把当前聊天的 Atlas 世界、地图、场景与回合记录恢复到备份时刻。继续？");
        if (!confirmed) return;
        const restored = { ...parsed, rev: Math.max(Number(parsed.rev) || 0, Number(current.rev) || 0) + 1 };
        // C07b：恢复也是异步写回——身份必须仍是刚才核对过的那个聊天
        await writeAtlasSession(context, restored, chatId);
        await core.refresh();
        setStatus("Atlas 会话备份已恢复。", "ok");
        renderCenter();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), "error");
      } finally {
        restoreBackupInput.value = "";
      }
    });
    sceneActions.append(restoreBackupBtn, restoreBackupInput);
    panel.append(sceneSection);
    panel.append(sceneActions);
    panel.append(scenePreviewBox);
    panel.append(repairBox);
    panel.append(el("p", "aw-panel__meta", "「推进」只管推进行为与提示词；API 地址、密钥与模型请在「API」页配置。"));
    panel.append(el("div", "aw-divider"));

    // shujuku 式提示词区：顶部「当前预设」选择行（选中即激活）＋ 新建 / 删除，编辑器 + dirty 操作条
    const promptPanel = el("section", "aw-panel");
    promptPanel.append(el("span", "aw-eyebrow", "推演提示词预设"));

    const selectField = el("div", "aw-field");
    selectField.append(el("span", "aw-field__label", "当前提示词预设"));
    const selectRow = el("div", "aw-select-row");
    const promptSelect = document.createElement("select");
    promptSelect.className = "aw-input";
    promptSelect.setAttribute("aria-label", "选择提示词预设（选中即设为当前使用）");
    const builtinOption = document.createElement("option");
    builtinOption.value = BUILTIN_PROMPT_ID;
    builtinOption.textContent = "内置默认（只读）";
    promptSelect.append(builtinOption);
    for (const preset of promptLibrary) {
      const option = document.createElement("option");
      option.value = preset.id;
      // 0.9.18：分段预设标注段数，一眼区分
      option.textContent = Array.isArray(preset.segments) && preset.segments.length > 0
        ? `${preset.name}（分段 ${preset.segments.length}）`
        : preset.name;
      promptSelect.append(option);
    }
    promptSelect.value = promptDraft?.id ?? (settingsV2?.activePromptPresetId ?? BUILTIN_PROMPT_ID);
    promptSelect.addEventListener("change", async () => {
      if (promptDraftDirty && !confirmDiscard("提示词")) {
        promptSelect.value = promptDraft?.id ?? (settingsV2?.activePromptPresetId ?? BUILTIN_PROMPT_ID);
        return;
      }
      const preset = promptLibrary.find((p) => p.id === promptSelect.value);
      promptSelect.disabled = true;
      // Keep the current draft until activation succeeds.
      if (await sendSettingsCommand({ action: "prompt.activate", id: preset ? preset.id : null })) {
        promptDraft = preset ? savedPromptDraft(preset) : builtinPromptDraft();
        promptDraftDirty = false;
        setStatus("", "ok");
      }
      renderCenter();
    });
    selectRow.append(promptSelect);
    const promptNewBtn = el("button", "aw-btn aw-btn--icon", "新建");
    promptNewBtn.type = "button";
    promptNewBtn.setAttribute("aria-label", "新建提示词预设");
    promptNewBtn.addEventListener("click", () => {
      if (promptDraftDirty && !confirmDiscard("提示词")) return;
      promptDraft = newPromptDraft();
      promptDraftDirty = false;
      setStatus("", "ok");
      renderCenter();
    });
    selectRow.append(promptNewBtn);
    const promptDeleteBtn = el("button", "aw-btn aw-btn--danger aw-btn--icon", "删除");
    promptDeleteBtn.type = "button";
    promptDeleteBtn.setAttribute("aria-label", "删除当前选中的提示词预设");
    promptDeleteBtn.disabled = !promptDraft?.id;
    promptDeleteBtn.addEventListener("click", async () => {
      if (!promptDraft?.id) {
        setStatus("当前草稿尚未保存，无需删除。", "error");
        renderCenter();
        return;
      }
      const confirmed = typeof window === "undefined" || typeof window.confirm !== "function"
        ? true
        : window.confirm(`删除提示词预设「${promptDraft.name}」？`);
      if (!confirmed) return;
      const ok = await sendSettingsCommand({ action: "prompt.delete", id: promptDraft.id });
      if (ok) {
        promptDraft = newPromptDraft();
        promptDraftDirty = false;
        setStatus("提示词预设已删除。");
      }
      renderCenter();
    });
    selectRow.append(promptDeleteBtn);

    // R15：预设导入导出（R02 残留的 JSON 包交付）。导入 = 新建预设（重名消解，绝不覆盖既有），
    // 不自动启用（避免导入即改生效行为）；导出只含预设语义字段，白名单构造无密钥面。
    const packInput = document.createElement("input");
    packInput.type = "file";
    packInput.accept = ".json,application/json";
    packInput.style.display = "none";
    packInput.addEventListener("change", () => {
      const file = packInput.files?.[0];
      packInput.value = "";
      if (!file) return;
      if (promptDraftDirty && !confirmDiscard("提示词")) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = parseAtlasPromptPack(String(reader.result ?? ""));
        if (!result.ok) {
          setStatus(`提示词包校验失败：${result.error}`, "error");
          renderCenter();
          return;
        }
        void (async () => {
          const name = uniquePromptPresetName(result.preset.name, promptLibrary.map((preset) => preset.name));
          const ok = await sendSettingsCommand({
            action: "prompt.save",
            preset: {
              name,
              systemPrompt: "",
              segments: result.preset.segments,
              ...(result.preset.contextTurnCount === undefined ? {} : { contextTurnCount: result.preset.contextTurnCount }),
            },
          });
          if (ok) {
            const saved = promptLibrary.find((preset) => preset.name === name);
            promptDraft = saved ? savedPromptDraft(saved) : newPromptDraft();
            promptDraftDirty = false;
            setStatus(`已导入提示词预设「${name}」（未启用；需要时在下拉里选中即启用）。`);
          }
          renderCenter();
        })();
      };
      reader.onerror = () => {
        setStatus("提示词包读取失败。", "error");
        renderCenter();
      };
      reader.readAsText(file);
    });
    selectRow.append(packInput);

    const promptImportBtn = el("button", "aw-btn aw-btn--icon", "导入");
    promptImportBtn.type = "button";
    promptImportBtn.setAttribute("aria-label", "从 JSON 包导入提示词预设");
    promptImportBtn.addEventListener("click", () => {
      if (promptDraftDirty && !confirmDiscard("提示词")) return;
      packInput.click();
    });
    selectRow.append(promptImportBtn);

    const promptExportBtn = el("button", "aw-btn aw-btn--icon", "导出");
    promptExportBtn.type = "button";
    promptExportBtn.setAttribute("aria-label", "导出当前提示词预设为 JSON 包");
    promptExportBtn.disabled = !promptDraft?.id;
    promptExportBtn.addEventListener("click", () => {
      const preset = promptLibrary.find((item) => item.id === promptDraft?.id);
      if (!preset) {
        setStatus("当前草稿尚未保存，先保存再导出。", "error");
        renderCenter();
        return;
      }
      try {
        const pack = buildAtlasPromptPack(preset);
        if (!pack) {
          setStatus("该预设没有可导出的内容（分段与单条正文均为空）。", "error");
          renderCenter();
          return;
        }
        const blob = new Blob([pack], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${String(preset.name || "atlas-prompt").replace(/[\\/:*?"<>|]/g, "_")}.atlas-prompt-pack.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setStatus("提示词预设已导出（只含预设语义字段，不含任何 API 配置或密钥）。");
        renderCenter();
      } catch {
        setStatus("提示词包导出失败。", "error");
        renderCenter();
      }
    });
    selectRow.append(promptExportBtn);
    selectField.append(selectRow);
    selectField.append(el("span", "aw-hint", "选中预设会立即设为当前使用并载入下方编辑器；「新建」开新草稿，「删除」删当前选中的预设，「导出 / 导入」走 JSON 包只交换预设内容（不含 API 配置与密钥）。"));
    promptPanel.append(selectField);

    // R02：内置只读 = kind 显式标记，不再是「没有 id 就当内置」的推断
    const isBuiltinDraft = promptDraft?.kind === "builtin";
    let promptSaveButton = null;

    const nameField = el("div", "aw-field");
    nameField.append(el("span", "aw-field__label", "提示词名称"));
    const nameInput = document.createElement("input");
    nameInput.className = "aw-input";
    nameInput.type = "text";
    nameInput.maxLength = 64;
    nameInput.value = promptDraft?.name ?? "";
    nameInput.readOnly = Boolean(isBuiltinDraft);
    nameInput.placeholder = isBuiltinDraft ? "内置默认不可改名" : "例如：严厉推演";
    nameInput.setAttribute("aria-label", "提示词名称");
    nameInput.addEventListener("input", () => {
      if (!promptDraft) promptDraft = newPromptDraft();
      promptDraft.name = nameInput.value;
      promptDraftDirty = true;
      // 覆盖式保存必须始终明示目标（防「随便改改点保存」静默覆盖原预设）
      if (promptSaveButton && promptDraft.id) {
        promptSaveButton.textContent = promptDraft.name.trim() ? `保存修改到「${promptDraft.name.trim()}」` : "保存修改";
      }
      if (syncPromptDirty) syncPromptDirty();
    });
    nameField.append(nameInput);
    // R02：草稿状态显式化——编辑器里现在是什么、保存语义是什么，不再靠猜
    nameField.append(el("span", "aw-hint", isBuiltinDraft
      ? "内置默认（只读展示）——点「复制内置默认为新预设」或「另存为」获得可编辑副本。"
      : promptDraft?.kind === "new"
        ? "未保存的新预设：可命名、可写正文、可插入栏目；点「保存新预设」落盘。"
        : "正在编辑已保存预设：保存 = 覆盖回该预设；「另存为」可存成副本。"));
    promptPanel.append(nameField);

    const bodyField = el("div", "aw-field");
    bodyField.append(el("span", "aw-field__label", "系统提示词"));
    const bodyInput = document.createElement("textarea");
    bodyInput.className = "aw-input aw-input--area";
    bodyInput.rows = 6;
    bodyInput.maxLength = 8000;
    bodyInput.readOnly = Boolean(isBuiltinDraft);
    bodyInput.value = isBuiltinDraft ? String(settingsV2?.builtInPrompt?.systemPrompt ?? "") : (promptDraft?.systemPrompt ?? "");
    bodyInput.placeholder = "留空 = 使用内置默认。";
    bodyInput.setAttribute("aria-label", "系统提示词正文");
    bodyInput.addEventListener("input", () => {
      if (!promptDraft) promptDraft = newPromptDraft();
      promptDraft.systemPrompt = bodyInput.value;
      promptDraftDirty = true;
      if (syncPromptDirty) syncPromptDirty();
    });
    bodyField.append(bodyInput);
    bodyField.append(el("span", "aw-hint", isBuiltinDraft
      ? "内置默认为只读——点「复制内置默认为新预设」或「另存为」后即可修改。"
      : "留空 = 使用内置默认；用户行动、助手回复与世界上下文由系统自动组装，不在这里编辑。启用下方分段模式后本正文不发送。"));
    // 0.9.40 内置默认不再展示单条正文编辑器（作者反馈「怎么还是长这样」）：
    // 改在下方分段区以只读形态展示 8 段多轮结构
    if (!isBuiltinDraft) promptPanel.append(bodyField);

    // 0.9.19 分段模式（shujuku AcuPromptSegments 同款长段多角色预设）：≥1 段时取代上方单条正文
    const segSection = el("section", "aw-seg-section");
    const segHead = el("div", "aw-seg-head");
    segHead.append(el("span", "aw-seg-head__title", "分段模式（长段多角色预设）"));
    const segStatus = el("span", "aw-seg-head__status");
    segHead.append(segStatus);
    segSection.append(segHead);
    const segRows = el("div", "aw-seg-rows");
    const syncSegStatus = () => {
      const count = Array.isArray(promptDraft?.segments) ? promptDraft.segments.filter((s) => String(s.content ?? "").trim()).length : 0;
      segStatus.textContent = count > 0 ? `已启用 ${count} 段 · 发送时忽略上方正文` : "未启用";
    };
    const addSegment = (atTop) => {
      if (!promptDraft) promptDraft = newPromptDraft();
      if (!Array.isArray(promptDraft.segments)) promptDraft.segments = [];
      if (promptDraft.segments.length >= 16) {
        setStatus("分段最多 16 段。", "error");
        return;
      }
      // 0.9.25 shujuku promptGroup 栏位段：段带名称与主槽位（A=主系统提示词位 / B=任务指令位）
      const segment = { role: "system", name: "", mainSlot: "", content: "" };
      if (atTop) promptDraft.segments.unshift(segment);
      else promptDraft.segments.push(segment);
      promptDraftDirty = true;
      renderSegRows();
      if (syncPromptDirty) syncPromptDirty();
    };
    const moveSegment = (index, delta) => {
      if (!promptDraft || !Array.isArray(promptDraft.segments)) return;
      const target = index + delta;
      if (target < 0 || target >= promptDraft.segments.length) return;
      const [moved] = promptDraft.segments.splice(index, 1);
      promptDraft.segments.splice(target, 0, moved);
      promptDraftDirty = true;
      renderSegRows();
      if (syncPromptDirty) syncPromptDirty();
    };
    const renderSegRows = () => {
      segRows.innerHTML = "";
      const segments = Array.isArray(promptDraft?.segments) ? promptDraft.segments : [];
      segments.forEach((segment, index) => {
        const item = el("div", "aw-seg-item");
        const head = el("div", "aw-seg-item__head");
        head.append(el("span", "aw-seg-item__index", `#${index + 1}`));
        const roleSelect = document.createElement("select");
        roleSelect.className = "aw-input aw-seg-item__role";
        roleSelect.setAttribute("aria-label", `第 ${index + 1} 段角色`);
        for (const role of PROMPT_SEGMENT_ROLES) {
          const opt = document.createElement("option");
          opt.value = role;
          opt.textContent = role;
          roleSelect.append(opt);
        }
        roleSelect.value = PROMPT_SEGMENT_ROLES.includes(segment.role) ? segment.role : "system";
        roleSelect.addEventListener("change", () => {
          segment.role = roleSelect.value;
          promptDraftDirty = true;
          if (syncPromptDirty) syncPromptDirty();
        });
        head.append(roleSelect);
        // 0.9.25 shujuku 栏位段：主槽位 A / B / 无（仅标注语义，发送顺序仍按段序）
        const slotSelect = document.createElement("select");
        slotSelect.className = "aw-input aw-seg-item__slot";
        slotSelect.setAttribute("aria-label", `第 ${index + 1} 段主槽位`);
        for (const [slotValue, slotLabel] of [["", "槽位：无"], ["A", "槽位 A（主提示词）"], ["B", "槽位 B（任务指令）"]]) {
          const opt = document.createElement("option");
          opt.value = slotValue;
          opt.textContent = slotLabel;
          slotSelect.append(opt);
        }
        slotSelect.value = segment.mainSlot === "A" || segment.mainSlot === "B" ? segment.mainSlot : "";
        slotSelect.addEventListener("change", () => {
          segment.mainSlot = slotSelect.value;
          promptDraftDirty = true;
          if (syncPromptDirty) syncPromptDirty();
        });
        head.append(slotSelect);
        const nameInput = document.createElement("input");
        nameInput.className = "aw-input aw-seg-item__name";
        nameInput.type = "text";
        nameInput.maxLength = 64;
        nameInput.placeholder = "栏位名称";
        nameInput.value = String(segment.name ?? "");
        nameInput.setAttribute("aria-label", `第 ${index + 1} 段栏位名称`);
        nameInput.addEventListener("input", () => {
          segment.name = nameInput.value;
          promptDraftDirty = true;
          if (syncPromptDirty) syncPromptDirty();
        });
        head.append(nameInput);
        const upBtn = el("button", "aw-btn aw-btn--icon", "↑");
        upBtn.type = "button";
        upBtn.setAttribute("aria-label", `上移第 ${index + 1} 段`);
        upBtn.disabled = index === 0;
        upBtn.addEventListener("click", () => moveSegment(index, -1));
        const downBtn = el("button", "aw-btn aw-btn--icon", "↓");
        downBtn.type = "button";
        downBtn.setAttribute("aria-label", `下移第 ${index + 1} 段`);
        downBtn.disabled = index === segments.length - 1;
        downBtn.addEventListener("click", () => moveSegment(index, 1));
        const delBtn = el("button", "aw-btn aw-btn--icon aw-btn--danger", "✕");
        delBtn.type = "button";
        delBtn.setAttribute("aria-label", `删除第 ${index + 1} 段`);
        delBtn.addEventListener("click", () => {
          if (!promptDraft || !Array.isArray(promptDraft.segments)) return;
          promptDraft.segments = promptDraft.segments.filter((_, i) => i !== index);
          promptDraftDirty = true;
          renderSegRows();
          if (syncPromptDirty) syncPromptDirty();
        });
        head.append(upBtn, downBtn, delBtn);
        const area = document.createElement("textarea");
        area.className = "aw-input aw-input--area aw-seg-item__area";
        area.rows = 5;
        area.maxLength = 8000;
        area.value = String(segment.content ?? "");
        area.placeholder = "栏位正文，支持 $5 世界状态 / $1 世界书资料 / $6 上轮推演 / $7 前文 / $8 用户行动 / $U 用户设定 / $C 角色描述";
        area.setAttribute("aria-label", `第 ${index + 1} 段正文`);
        area.addEventListener("input", () => {
          segment.content = area.value;
          promptDraftDirty = true;
          syncSegStatus();
          if (syncPromptDirty) syncPromptDirty();
        });
        item.append(head, area);
        segRows.append(item);
      });
      if (segments.length === 0) {
        segRows.append(el("p", "aw-seg-empty", "还没有栏位——点下方「插入一段」启用。空段保存时自动剔除。"));
      }
      syncSegStatus();
    };
    if (isBuiltinDraft) {
      // 0.9.40 内置默认以只读分段展示（作者反馈「怎么还是长这样」）：
      // 0.9.39 起发送侧已是 8 段多轮结构，推进页必须直接可见、可对照
      const builtinSegs = Array.isArray(settingsV2?.builtInPrompt?.segments) ? settingsV2.builtInPrompt.segments : [];
      segStatus.textContent = builtinSegs.length > 0 ? `内置默认 ${builtinSegs.length} 段（只读）` : "未启用";
      if (builtinSegs.length > 0) {
        const readOnlyRows = el("div", "aw-seg-rows aw-seg-rows--readonly");
        builtinSegs.forEach((segment, index) => {
          const item = el("div", "aw-seg-item aw-seg-item--readonly");
          const head = el("div", "aw-seg-item__head");
          head.append(el("span", "aw-seg-item__index", `#${index + 1}`));
          const slotLabel = segment?.mainSlot === "A" ? " · 槽位 A（主提示词）" : segment?.mainSlot === "B" ? " · 槽位 B（任务指令）" : "";
          const nameLabel = typeof segment?.name === "string" && segment.name.trim() ? ` · ${segment.name.trim()}` : "";
          head.append(el("span", "aw-seg-item__roletag", `${String(segment?.role ?? "system")}${nameLabel}${slotLabel}`));
          item.append(head);
          const area = document.createElement("textarea");
          area.className = "aw-input aw-input--area aw-seg-item__area";
          area.rows = 5;
          area.readOnly = true;
          area.value = String(segment?.content ?? "");
          area.setAttribute("aria-label", `内置默认第 ${index + 1} 段正文（只读）`);
          item.append(area);
          readOnlyRows.append(item);
        });
        segSection.append(readOnlyRows);
        segSection.append(el("span", "aw-hint", "内置默认（0.9.39 多轮结构，只读）：system 身份契约 → assistant 确认 → user 背景设定 → user 任务指令 → user 本轮素材 → assistant 输出引导，发送时按段序组装并替换占位符。点「复制内置默认为新预设」即可复制成可编辑预设。"));
      } else {
        segSection.append(el("p", "aw-seg-empty", "内置默认不支持分段——先复制为新预设。"));
      }
    } else {
      const insertTopBtn = el("button", "aw-btn aw-btn--ghost aw-seg-insert", "在最上方插入一段");
      insertTopBtn.type = "button";
      insertTopBtn.setAttribute("aria-label", "在最上方插入一个提示词分段");
      insertTopBtn.addEventListener("click", () => addSegment(true));
      const insertBottomBtn = el("button", "aw-btn aw-btn--ghost aw-seg-insert", "在最下方插入一段");
      insertBottomBtn.type = "button";
      insertBottomBtn.setAttribute("aria-label", "在最下方插入一个提示词分段");
      insertBottomBtn.addEventListener("click", () => addSegment(false));
      segSection.append(insertTopBtn, segRows, insertBottomBtn);
      segSection.append(el("span", "aw-hint", "0.9.25 shujuku 栏位段：占位符在发送时替换——$5=世界状态上下文，$1=世界书资料（worldbook_context 包裹），$6=上轮推演结果，$7=前文 AI 楼层（条数见下方设置），$8=本轮用户行动，$U=用户设定，$C=角色描述，$9=保留位（恒空）。旧 {{worldState}} / {{userAction}} / {{assistantReply}} / {{worldLore}} 写法继续兼容。主槽位 A / B 仅作栏位标注（shujuku mainSlot 同款），发送顺序按段序；输出契约不变——模型仍须只输出一个 JSON 对象。"));
      renderSegRows();
    }
    promptPanel.append(segSection);

    // 0.9.25 shujuku contextTurnCount：$7 前文上下文条数（随预设保存，引擎侧发送时切片）
    const turnField = el("div", "aw-field");
    turnField.append(el("span", "aw-field__label", "前文上下文条数（$7）"));
    const turnRow = el("div", "aw-select-row");
    const turnSelect = document.createElement("select");
    turnSelect.className = "aw-input";
    turnSelect.setAttribute("aria-label", "前文上下文条数");
    for (let n = 1; n <= 10; n++) {
      const opt = document.createElement("option");
      opt.value = String(n);
      opt.textContent = `最近 ${n} 条 AI 楼层`;
      turnSelect.append(opt);
    }
    turnSelect.value = String(Math.min(Math.max(Number.parseInt(String(promptDraft?.contextTurnCount ?? 3), 10) || 3, 1), 10));
    turnSelect.addEventListener("change", () => {
      if (!promptDraft) promptDraft = newPromptDraft();
      promptDraft.contextTurnCount = Number.parseInt(turnSelect.value, 10) || 3;
      promptDraftDirty = true;
      if (syncPromptDirty) syncPromptDirty();
    });
    turnRow.append(turnSelect);
    turnField.append(turnRow);
    turnField.append(el("span", "aw-hint", "推演请求会把最近 N 条 AI 楼层作为 $7 前文上下文注入（shujuku plotSettings.contextTurnCount 同款）。随当前预设一起保存。"));
    promptPanel.append(turnField);

    // 当前生效提示词（默认折叠，只读）
    const details = document.createElement("details");
    details.className = "aw-details";
    const summary = document.createElement("summary");
    summary.className = "aw-details__summary";
    summary.textContent = "当前生效提示词（只读）";
    const visible = el("pre", "aw-pre", activePromptText());
    details.append(summary, visible);
    promptPanel.append(details);

    // R03（A10）：最终请求预览——走服务端与真实提交完全相同的装配路径，
    // 展示模型实际收到的每段消息、生效来源与缺失块哨兵
    const previewDetails = document.createElement("details");
    previewDetails.className = "aw-details";
    const previewSummary = document.createElement("summary");
    previewSummary.className = "aw-details__summary";
    previewSummary.textContent = "最终请求预览（与实际发送逐字一致）";
    const previewBody = el("div", "aw-request-preview");
    previewBody.append(el("p", "aw-panel__meta", "展开后点击下方按钮，按当前世界状态装配一次真实请求（不调用模型、不计费）。"));
    const previewBtn = el("button", "aw-btn", "生成最终请求预览");
    previewBtn.type = "button";
    previewBtn.setAttribute("aria-label", "用当前世界状态生成一次推演请求预览（不调用模型）");
    previewBtn.addEventListener("click", async () => {
      const chatId = String(state().chatId ?? "");
      if (!chatId) { setStatus("当前没有活动聊天。", "error"); renderCenter(); return; }
      previewBtn.disabled = true;
      try {
        const result = await api.request("POST", "/turns/preview", { chatId });
        previewBody.innerHTML = "";
        if (result.status !== 200 || !result.body?.ok) {
          previewBody.append(el("p", "aw-note aw-note--error", result.body?.error?.message ?? `预览失败（HTTP ${result.status}）`));
          return;
        }
        const data = result.body.data ?? {};
        const sourceLabel = { preset: "推进预设分段", connection: "连接级系统提示词（覆盖推进预设）", builtin: "内置默认分段" }[String(data.promptSource)] ?? String(data.promptSource);
        previewBody.append(el("p", "aw-panel__meta", `生效来源：${sourceLabel} · 共 ${String(data.messages?.length ?? 0)} 段`));
        if (String(data.promptSource) === "connection") {
          previewBody.append(el("p", "aw-note aw-note--error", "连接级系统提示词正在覆盖推进预设——可在上方点击「清空连接级提示词」恢复。"));
        }
        const missing = data.missing ?? {};
        const missingLines = [];
        if (!missing.worldState) missingLines.push("世界状态（$5）为空——未绑定世界或世界无内容");
        if (!missing.lastTurn) missingLines.push("上轮结果（$6）为空——尚无已提交推演");
        if (!missing.recentContext) missingLines.push("前文剧情（$7）为空——本轮提交时将按上下文条数注入");
        if (missingLines.length > 0) previewBody.append(el("p", "aw-panel__meta", `缺失块：${missingLines.join("；")}`));
        for (const message of Array.isArray(data.messages) ? data.messages : []) {
          const item = el("div", "aw-seg-item");
          const head = el("div", "aw-seg-item__head");
          head.append(el("span", "aw-seg-item__index", `${String(message.role)} · ${String(message.chars)} 字`));
          item.append(head);
          const area = document.createElement("textarea");
          area.className = "aw-input aw-input--area aw-seg-item__area";
          area.rows = 4;
          area.readOnly = true;
          area.value = String(message.content ?? "");
          area.setAttribute("aria-label", `预览消息 ${message.role}`);
          item.append(area);
          previewBody.append(item);
        }
      } catch (error) {
        previewBody.append(el("p", "aw-note aw-note--error", `预览失败：${error instanceof Error ? error.message : String(error)}`));
      } finally {
        previewBtn.disabled = false;
      }
    });
    previewBody.append(previewBtn);
    previewDetails.append(previewSummary, previewBody);
    promptPanel.append(previewDetails);

    // dirty 操作条（shujuku 式：未修改时「放弃修改 / 保存」禁用）
    const promptActions = el("div", "aw-actions");
    const discardButton = el("button", "aw-btn aw-btn--ghost", "放弃修改");
    discardButton.type = "button";
    discardButton.setAttribute("aria-label", "放弃未保存的提示词修改");
    discardButton.addEventListener("click", () => {
      const preset = promptLibrary.find((p) => p.id === promptDraft?.id);
      // R02：放弃修改回到来源——saved 载回原预设；new/builtin 回到各自初始形态
      promptDraft = preset
        ? savedPromptDraft(preset)
        : (promptDraft?.kind === "new" ? newPromptDraft() : builtinPromptDraft());
      promptDraftDirty = false;
      setStatus("", "ok");
      renderCenter();
    });
    promptActions.append(discardButton);
    if (isBuiltinDraft) {
      promptSaveButton = el("button", "aw-btn aw-btn--primary", "复制内置默认为新预设");
      promptSaveButton.type = "button";
      promptSaveButton.setAttribute("aria-label", "把内置默认提示词复制成可编辑预设");
      promptSaveButton.addEventListener("click", async () => {
        // 0.9.40 复制内置默认 = 连 8 段多轮结构一起复制（不再是单条正文）
        const builtinSegs = Array.isArray(settingsV2?.builtInPrompt?.segments) ? settingsV2.builtInPrompt.segments : [];
        const copiedSegments = builtinSegs
          .map((s) => ({
            role: PROMPT_SEGMENT_ROLES.includes(s?.role) ? s.role : "system",
            ...(typeof s?.name === "string" && s.name.trim() ? { name: s.name.trim().slice(0, 64) } : {}),
            ...(s?.mainSlot === "A" || s?.mainSlot === "B" ? { mainSlot: s.mainSlot } : {}),
            content: String(s?.content ?? "").trim(),
          }))
          .filter((s) => s.content.length > 0)
          .slice(0, 16);
        const idsBeforeCopy = new Set(promptLibrary.map((p) => p.id));
        const ok = await sendSettingsCommand({
          action: "prompt.save",
          preset: {
            name: "自定义提示词",
            systemPrompt: copiedSegments.length > 0 ? "" : String(settingsV2?.builtInPrompt?.systemPrompt ?? ""),
            ...(copiedSegments.length > 0 ? { segments: copiedSegments } : {}),
          },
        });
        if (ok) {
          // R02：createdId 用差集定位，不再假设「预设列表最后一项」是刚创建的
          const created = promptLibrary.find((p) => !idsBeforeCopy.has(p.id));
          promptDraft = created ? savedPromptDraft(created) : newPromptDraft();
          promptDraftDirty = false;
          setStatus("已复制为新预设，可继续编辑。");
        }
        renderCenter();
      });
    } else {
      promptSaveButton = el("button", "aw-btn aw-btn--primary", promptDraft?.id ? `保存修改到「${promptDraft.name}」` : "保存新预设");
      promptSaveButton.type = "button";
      promptSaveButton.setAttribute("aria-label", "保存当前提示词预设");
      promptSaveButton.addEventListener("click", async () => {
        if (!promptDraft?.name.trim()) {
          setStatus("提示词名称不能为空。", "error");
          renderCenter();
          return;
        }
        // 0.9.18 分段模式：有非空分段 → 保存 segments（正文忽略，存空串）；否则走单条正文
        // 0.9.25 栏位段：保存时保留名称 / 主槽位（shujuku promptGroup 字段）
        const draftSegments = (Array.isArray(promptDraft.segments) ? promptDraft.segments : [])
          .map((s) => ({
            role: PROMPT_SEGMENT_ROLES.includes(s?.role) ? s.role : "system",
            ...(typeof s?.name === "string" && s.name.trim() ? { name: s.name.trim().slice(0, 64) } : {}),
            ...(s?.mainSlot === "A" || s?.mainSlot === "B" ? { mainSlot: s.mainSlot } : {}),
            content: String(s?.content ?? "").trim(),
          }))
          .filter((s) => s.content.length > 0)
          .slice(0, 16);
        const useSegments = draftSegments.length > 0;
        if (!useSegments && !promptDraft.systemPrompt.trim()) {
          setStatus("提示词正文不能为空（或启用分段模式并至少写 1 段）。", "error");
          renderCenter();
          return;
        }
        const turnCount = Math.min(Math.max(Number.parseInt(String(promptDraft.contextTurnCount ?? 3), 10) || 3, 1), 10);
        // R02：保存前记录已有 id，保存后用差集定位新建预设（不再「猜列表最后一项」）
        const idsBefore = new Set(promptLibrary.map((p) => p.id));
        const ok = await sendSettingsCommand({
          action: "prompt.save",
          preset: {
            ...(promptDraft.id ? { id: promptDraft.id } : {}),
            name: promptDraft.name,
            systemPrompt: useSegments ? "" : promptDraft.systemPrompt,
            ...(useSegments ? { segments: draftSegments } : {}),
            contextTurnCount: turnCount,
          },
        });
        if (ok) {
          promptDraftDirty = false;
          // 新建保存 → 绑定 createdId，后续编辑走覆盖语义而不是重复新建
          if (!promptDraft.id) {
            const created = promptLibrary.find((p) => !idsBefore.has(p.id));
            if (created) {
              promptDraft.id = created.id;
              promptDraft.kind = "saved";
              promptDraft.name = created.name;
            }
          }
          setStatus(useSegments ? `栏位提示词已保存（${draftSegments.length} 段）。` : "提示词已保存。");
        }
        renderCenter();
      });
    }
    promptActions.append(promptSaveButton);
    const promptSaveAsButton = el("button", "aw-btn aw-btn--ghost", "另存为");
    promptSaveAsButton.type = "button";
    promptSaveAsButton.setAttribute("aria-label", "以新名称保存提示词副本");
    promptSaveAsButton.addEventListener("click", async () => {
      const name = typeof window !== "undefined" && typeof window.prompt === "function"
        ? window.prompt("新提示词预设名称", promptDraft?.name ? `${promptDraft.name} 副本` : "新提示词")
        : null;
      if (!name || !name.trim()) return;
      // R02（D15 修复）：另存为完整保留 role/name/mainSlot/content 与 contextTurnCount，
      // 不再只拷 role/content 导致副本降级；内置默认另存为也复制全套分段
      const sourceSegments = Array.isArray(promptDraft?.segments) && promptDraft.segments.length > 0
        ? promptDraft.segments
        : (isBuiltinDraft ? (settingsV2?.builtInPrompt?.segments ?? []) : []);
      const draftSegmentsForCopy = sourceSegments
        .map((s) => ({
          role: PROMPT_SEGMENT_ROLES.includes(s?.role) ? s.role : "system",
          ...(typeof s?.name === "string" && s.name.trim() ? { name: s.name.trim().slice(0, 64) } : {}),
          ...(s?.mainSlot === "A" || s?.mainSlot === "B" ? { mainSlot: s.mainSlot } : {}),
          content: String(s?.content ?? "").trim(),
        }))
        .filter((s) => s.content.length > 0)
        .slice(0, 16);
      const useSegmentsForCopy = draftSegmentsForCopy.length > 0;
      const idsBeforeAs = new Set(promptLibrary.map((p) => p.id));
      const ok = await sendSettingsCommand({
        action: "prompt.save",
        preset: {
          name: name.trim(),
          systemPrompt: useSegmentsForCopy
            ? ""
            : (promptDraft?.systemPrompt || (isBuiltinDraft ? String(settingsV2?.builtInPrompt?.systemPrompt ?? "") : "")),
          ...(useSegmentsForCopy ? { segments: draftSegmentsForCopy } : {}),
          ...(promptDraft?.contextTurnCount != null
            ? { contextTurnCount: Math.min(Math.max(Number.parseInt(String(promptDraft.contextTurnCount), 10) || 3, 1), 10) }
            : {}),
        },
      });
      if (ok) {
        promptDraftDirty = false;
        // R02：另存为后直接载入新预设为工作副本（createdId 用差集定位）
        const created = promptLibrary.find((p) => !idsBeforeAs.has(p.id));
        promptDraft = created ? savedPromptDraft(created) : newPromptDraft();
        setStatus("已另存为新的提示词预设，可直接继续编辑。");
      }
      renderCenter();
    });
    promptActions.append(promptSaveAsButton);
    panel.append(promptPanel);
    panel.append(promptActions);

    let syncPromptDirty = () => {};
    syncPromptDirty = () => {
      discardButton.disabled = !promptDraftDirty;
      if (!isBuiltinDraft && promptSaveButton) promptSaveButton.disabled = !promptDraftDirty;
    };
    syncPromptDirty();
    panel.append(el("p", "aw-panel__meta", "修改后不会自动保存——改动只有点了保存按钮才会落盘。"));
    return panel;
  }

  // ---------------------------------------------------------------------------
  // ATLAS-18 「API」页：只管理连接资料（不出现提示词编辑）
  // ---------------------------------------------------------------------------

  function buildApiPanel() {
    const panel = el("section", "aw-panel");
    panel.append(el("span", "aw-eyebrow", "API 连接"));
    panel.append(el("p", "aw-panel__text", "管理 Atlas 推演用的 API 连接：连接方式、协议、密钥与模型都在这里；提示词请到「推进」页。"));
    const active = apiLibrary.find((p) => p.id === settingsV2?.activeApiPresetId);
    panel.append(el("p", "aw-panel__meta", `当前使用：${activeApiLabel()}${active ? ` · 模型 ${active.model || "（跟随酒馆）"}` : ""}`));
    const gotoRow = el("div", "aw-actions");
    const gotoProgression = el("button", "aw-btn aw-btn--ghost", "前往推进");
    gotoProgression.type = "button";
    gotoProgression.setAttribute("aria-label", "前往推进页管理提示词");
    gotoProgression.addEventListener("click", () => core.setPage("progression"));
    gotoRow.append(gotoProgression);
    panel.append(gotoRow);
    if (statusLine()) panel.append(statusLine());

    // 顶部预设选择行（shujuku 式：下拉选中即激活 + 新建 / 删除）
    const presetField = el("div", "aw-field");
    presetField.append(el("span", "aw-field__label", "当前 API 预设"));
    const presetRow = el("div", "aw-select-row");
    const libSelect = document.createElement("select");
    libSelect.className = "aw-input";
    libSelect.setAttribute("aria-label", "选择 API 预设（选中即设为当前使用）");
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = apiLibrary.length === 0 ? "暂无已保存连接——填好下方编辑器后点「保存」" : "选择已保存的连接";
    libSelect.append(placeholder);
    for (const preset of apiLibrary) {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = `${preset.name}（${preset.model || (preset.connectionMode === "main" ? "酒馆主API" : preset.connectionMode === "profile" ? "酒馆预设" : "自定义")}）`;
      libSelect.append(option);
    }
    libSelect.value = apiDraft?.id ?? "";
    libSelect.addEventListener("change", () => {
      if (apiDraftDirty && !confirmDiscard("API 连接")) {
        libSelect.value = apiDraft?.id ?? "";
        return;
      }
      const preset = apiLibrary.find((p) => p.id === libSelect.value);
      apiDraft = apiDraftFromView(preset);
      apiDraftDirty = false;
      apiKeyInput = preset ? String(preset.apiKey ?? "") : "";
      modelOptions = [];
      setStatus("", "ok");
      if (preset) void sendSettingsCommand({ action: "api.activate", id: preset.id });
      renderCenter();
    });
    presetRow.append(libSelect);
    const apiNewBtn = el("button", "aw-btn aw-btn--icon", "新建");
    apiNewBtn.type = "button";
    apiNewBtn.setAttribute("aria-label", "新建 API 预设");
    apiNewBtn.addEventListener("click", () => {
      if (apiDraftDirty && !confirmDiscard("API 连接")) return;
      apiDraft = newApiDraft();
      apiDraftDirty = false;
      apiKeyInput = "";
      modelOptions = [];
      setStatus("", "ok");
      renderCenter();
    });
    presetRow.append(apiNewBtn);
    const apiDeleteBtn = el("button", "aw-btn aw-btn--danger aw-btn--icon", "删除");
    apiDeleteBtn.type = "button";
    apiDeleteBtn.setAttribute("aria-label", "删除当前选中的 API 预设");
    apiDeleteBtn.disabled = !apiDraft?.id;
    apiDeleteBtn.addEventListener("click", async () => {
      if (!apiDraft?.id) {
        setStatus("当前草稿尚未保存，无需删除。", "error");
        renderCenter();
        return;
      }
      const confirmed = typeof window === "undefined" || typeof window.confirm !== "function"
        ? true
        : window.confirm(`删除连接「${apiDraft.name}」？`);
      if (!confirmed) return;
      const ok = await sendSettingsCommand({ action: "api.delete", id: apiDraft.id });
      if (ok) {
        apiDraft = newApiDraft();
        apiDraftDirty = false;
        setStatus("连接已删除。");
      }
      renderCenter();
    });
    presetRow.append(apiDeleteBtn);
    presetField.append(presetRow);
    presetField.append(el("span", "aw-hint", "选中预设会立即设为当前使用并载入下方编辑器；新建的连接在点「保存」之前不会出现在这里。"));
    panel.append(presetField);

    // ---- 编辑器（shujuku 式：名称 → 连接方式 → 按模式显隐 → dirty 操作条） ----
    const draft = apiDraft ?? newApiDraft();
    const modeOf = (d) => (d?.connectionMode === "main" || d?.connectionMode === "profile" ? d.connectionMode : "custom");
    const currentMode = modeOf(draft);
    const inputs = {};
    let apiSaveButton = null;

    // 名称（各模式通用）
    const nameField = el("div", "aw-field");
    nameField.append(el("span", "aw-field__label", "连接名称"));
    const nameInput = document.createElement("input");
    nameInput.className = "aw-input";
    nameInput.type = "text";
    nameInput.maxLength = 64;
    nameInput.value = String(draft.name ?? "");
    nameInput.placeholder = "例如：MiniMax 订阅 / 酒馆主 API";
    nameInput.setAttribute("aria-label", "连接名称");
    nameInput.addEventListener("input", () => {
      draft.name = nameInput.value;
      apiDraft = draft;
      apiDraftDirty = true;
      if (apiSaveButton) {
        apiSaveButton.textContent = draft.id
          ? (draft.name.trim() ? `保存修改到「${draft.name.trim()}」` : "保存修改")
          : "保存新连接";
      }
      if (syncApiDirty) syncApiDirty();
    });
    nameField.append(nameInput);
    panel.append(nameField);

    // 连接方式（shujuku 分段控件：自定义 / 酒馆主 API / 酒馆连接预设）
    const modeField = el("div", "aw-field");
    modeField.append(el("span", "aw-field__label", "连接方式"));
    const modeRow = el("div", "aw-select-row");
    const modeButtons = [];
    for (const [value, label] of [["custom", "自定义"], ["main", "酒馆主 API"], ["profile", "酒馆连接预设"]]) {
      const btn = el("button", `aw-btn aw-btn--icon aw-mode-btn${currentMode === value ? " is-active" : ""}`, label);
      btn.type = "button";
      btn.setAttribute("aria-label", `连接方式：${label}${currentMode === value ? "（当前）" : ""}`);
      btn.addEventListener("click", () => {
        if (modeOf(draft) === value) return;
        draft.connectionMode = value;
        apiDraft = draft;
        apiDraftDirty = true;
        renderCenter();
      });
      modeButtons.push(btn);
      modeRow.append(btn);
    }
    modeField.append(modeRow);
    modeField.append(el("span", "aw-hint", modeOf(draft) === "main"
      ? "使用酒馆当前主 API 发起推演（TavernHelper.generateRaw）——需要安装酒馆助手（JS-Slash-Runner）；密钥与模型跟随酒馆主 API 设置。"
      : modeOf(draft) === "profile"
        ? "使用酒馆连接管理器的某个连接预设发起推演；发送前临时切换到目标预设，完成后恢复原预设。"
        : "自定义端点 + 密钥 + 模型，经酒馆后端代理转发。"));
    panel.append(modeField);

    const appendField = (field, hint) => {
      const wrap = el("div", "aw-field");
      wrap.append(el("span", "aw-field__label", field.label));
      const input = document.createElement("input");
      input.className = "aw-input";
      input.type = field.type;
      input.setAttribute("aria-label", field.aria);
      if (field.maxLength) input.maxLength = field.maxLength;
      if (field.min !== undefined) input.min = String(field.min);
      if (field.max !== undefined) input.max = String(field.max);
      if (field.step !== undefined) input.step = String(field.step);
      input.placeholder = field.placeholder ?? "";
      if (field.key === "apiKey") {
        input.value = apiKeyInput;
        input.addEventListener("input", () => {
          apiKeyInput = input.value;
          apiDraft = draft;
          apiDraftDirty = true;
          if (syncApiDirty) syncApiDirty();
        });
      } else {
        input.value = String(draft[field.key] ?? "");
        input.addEventListener("input", () => {
          const numeric = field.type === "number";
          draft[field.key] = numeric ? Number(input.value) : input.value;
          apiDraft = draft;
          apiDraftDirty = true;
          if (field.key === "name" && apiSaveButton) {
            apiSaveButton.textContent = draft.id
              ? (draft.name.trim() ? `保存修改到「${draft.name.trim()}」` : "保存修改")
              : "保存新连接";
          }
          if (syncApiDirty) syncApiDirty();
        });
      }
      wrap.append(input);
      if (hint) wrap.append(el("span", "aw-hint", hint));
      inputs[field.key] = input;
      return wrap;
    };
    const textField = (key, label, type, maxLength, placeholder, aria) => ({ key, label, type, maxLength, placeholder, aria });
    const numberField = (key, label, min, max, step, aria) => ({ key, label, type: "number", min, max, step, aria });

    if (currentMode === "custom") {
      // 接口协议（shujuku 四值；openai_responses 在原版酒馆等同 openai）
      const formatField = el("div", "aw-field");
      formatField.append(el("span", "aw-field__label", "接口协议"));
      const formatSelect = document.createElement("select");
      formatSelect.className = "aw-input";
      formatSelect.setAttribute("aria-label", "选择接口协议");
      const formatOptions = [
        { value: "openai", label: "兼容 OpenAI（/chat/completions，默认）" },
        { value: "openai_responses", label: "兼容 OpenAI Responses（原版酒馆下等同 OpenAI）" },
        { value: "claude", label: "兼容 Claude Messages（MiniMax 订阅、Claude 代理）" },
        { value: "gemini", label: "兼容 Gemini（映射酒馆 makersuite 源）" },
      ];
      for (const opt of formatOptions) {
        const option = document.createElement("option");
        option.value = opt.value;
        option.textContent = opt.label;
        formatSelect.append(option);
      }
      formatSelect.value = draft.apiFormat === "claude" || draft.apiFormat === "gemini" ? draft.apiFormat : "openai";
      formatSelect.addEventListener("change", () => {
        draft.apiFormat = formatSelect.value;
        apiDraft = draft;
        apiDraftDirty = true;
        if (syncApiDirty) syncApiDirty();
      });
      formatField.append(formatSelect);
      formatField.append(el("span", "aw-hint", "决定酒馆后端按哪个协议变形：Claude / Gemini 填协议根即可（如 https://api.minimaxi.com/anthropic），Atlas 自动补版本段。"));
      panel.append(formatField);

      panel.append(appendField(textField("endpoint", "端点（http(s) 绝对地址）", "text", 2048, "http://localhost:8317/v1", "API 端点"), "Claude / Gemini 协议填协议根，OpenAI 协议填到 /v1。"));
      panel.append(appendField(textField("apiKey", "API 密钥", "password", 4096, active?.apiKey ? `已保存（尾号 ${String(active.apiKey).slice(-4)}），可直接修改` : "sk-…", "API 密钥"), "密钥保存在本机酒馆设置里，载入预设时自动回填——加载模型与推演直接用它，不用每次重输。0.9.48 起读取设置需要本机会话：酒馆服务器的远程匿名 / 普通用户读不到这份配置（含密钥）。"));

      const loadModelsRow = el("div", "aw-actions");
      const loadModelsBtn = el("button", "aw-btn", "加载模型列表");
      loadModelsBtn.type = "button";
      loadModelsBtn.setAttribute("aria-label", "通过酒馆后端代理加载模型列表并检查鉴权");
      loadModelsBtn.addEventListener("click", async () => {
        await testConnection(apiDraft ?? newApiDraft());
      });
      loadModelsRow.append(loadModelsBtn, el("span", "aw-panel__meta", "同时检查端点与鉴权；失败会给出可读错误，详见「日志」页。"));
      panel.append(loadModelsRow);

      panel.append(appendField(textField("model", "模型名（手动输入）", "text", 128, "例如：gpt-4o-mini", "模型名")));
      if (modelOptions.length > 0) {
        const modelRow = el("div", "aw-field");
        modelRow.append(el("span", "aw-field__label", "或从列表选择"));
        const modelSelect = document.createElement("select");
        modelSelect.className = "aw-input";
        modelSelect.setAttribute("aria-label", "选择端点返回的模型名");
        const blank = document.createElement("option");
        blank.value = "";
        blank.textContent = `-- 共 ${modelOptions.length} 个，点选填入 --`;
        modelSelect.append(blank);
        for (const name of modelOptions) {
          const option = document.createElement("option");
          option.value = name;
          option.textContent = name;
          modelSelect.append(option);
        }
        modelSelect.addEventListener("change", () => {
          if (!modelSelect.value) return;
          draft.model = modelSelect.value;
          apiDraft = draft;
          apiDraftDirty = true;
          inputs.model.value = modelSelect.value;
          if (syncApiDirty) syncApiDirty();
        });
        modelRow.append(modelSelect);
        panel.append(modelRow);
      }

      const grid = el("div", "aw-grid-2");
      grid.append(appendField(numberField("maxTokens", "最大回复长度", 1, 65536, 1, "最大回复长度")));
      grid.append(appendField(numberField("temperature", "温度", 0, 2, 0.1, "温度")));
      grid.append(appendField(numberField("topP", "top_p", 0, 1, 0.05, "top_p")));
      panel.append(grid);
      panel.append(appendField(numberField("timeoutMs", "超时毫秒", 1000, 120000, 1000, "超时毫秒")));

      // 高级参数（shujuku：附加请求体 / 排除字段 / 附加标头 / 提示词后处理）
      const advDetails = document.createElement("details");
      advDetails.className = "aw-details";
      const advSummary = el("summary", "aw-details__summary", "高级参数（请求体注入 / 排除字段 / 附加标头 / 提示词后处理）");
      const advBody = el("div", "aw-details__body");
      const textareaField = (key, label, hint, placeholder, rows) => {
        const wrap = el("div", "aw-field");
        wrap.append(el("span", "aw-field__label", label));
        const area = document.createElement("textarea");
        area.className = "aw-input aw-input--area";
        area.rows = rows;
        area.maxLength = key === "bodyParams" ? 4000 : 2000;
        area.value = String(draft[key] ?? "");
        area.placeholder = placeholder;
        area.setAttribute("aria-label", label);
        area.addEventListener("input", () => {
          draft[key] = area.value;
          apiDraft = draft;
          apiDraftDirty = true;
          if (syncApiDirty) syncApiDirty();
        });
        wrap.append(area);
        wrap.append(el("span", "aw-hint", hint));
        return wrap;
      };
      advBody.append(textareaField("bodyParams", "附加请求体参数", "合并进最终模型请求体（custom_include_body）；JSON / YAML object 均可。", "response_format:\n  type: json_object", 3));
      advBody.append(textareaField("excludeBodyParams", "排除请求体字段", "从最终模型请求体删除指定字段（custom_exclude_body）；逗号或换行分隔。", "top_p, reasoning_effort", 2));
      advBody.append(textareaField("requestHeaders", "附加请求标头", "每行一个 Header: Value，追加在 Authorization 之后。", "X-Custom-Header: value", 2));
      const postField = el("div", "aw-field");
      postField.append(el("span", "aw-field__label", "提示词后处理"));
      const postSelect = document.createElement("select");
      postSelect.className = "aw-input";
      postSelect.setAttribute("aria-label", "选择提示词后处理");
      for (const [value, label] of [
        ["", "未选择（原样透传消息，保留 system 段角色）"],
        ["strict", "严格（强制对话角色交替、用户最先）"],
        ["semi", "半严格（强制对话角色交替）"],
        ["merge", "合并相同角色连续的发言"],
        ["strict_tools", "严格（含工具）"],
        ["semi_tools", "半严格（含工具）"],
        ["merge_tools", "合并相同角色连续的发言（含工具）"],
        ["single", "单一用户消息（无工具）"],
      ]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        postSelect.append(option);
      }
      postSelect.value = String(draft.promptPostProcessing ?? "");
      postSelect.addEventListener("change", () => {
        draft.promptPostProcessing = postSelect.value;
        apiDraft = draft;
        apiDraftDirty = true;
        if (syncApiDirty) syncApiDirty();
      });
      postField.append(postSelect);
      postField.append(el("span", "aw-hint", "SillyTavern custom_prompt_post_processing；shujuku 同款默认「严格」（强制对话角色交替、用户最先）；选「未选择」= 不携带该字段，消息原样透传。"));
      advBody.append(postField);
      advDetails.append(advSummary, advBody);
      panel.append(advDetails);
    } else if (currentMode === "profile") {
      // 酒馆连接预设：profile 下拉 + 刷新
      let profileOptions = [];
      try {
        profileOptions = getConnectionManagerProfiles(SillyTavern.getContext());
      } catch { profileOptions = []; }
      const profileField = el("div", "aw-field");
      profileField.append(el("span", "aw-field__label", "酒馆连接预设"));
      const profileRow = el("div", "aw-select-row");
      const profileSelect = document.createElement("select");
      profileSelect.className = "aw-input";
      profileSelect.setAttribute("aria-label", "选择酒馆连接管理器预设");
      const blankProfile = document.createElement("option");
      blankProfile.value = "";
      blankProfile.textContent = profileOptions.length === 0 ? "未读到连接管理器预设（先在酒馆里建好）" : "请选择连接预设";
      profileSelect.append(blankProfile);
      for (const profile of profileOptions) {
        const option = document.createElement("option");
        option.value = profile.id;
        option.textContent = profile.name;
        if (String(profile.id) === String(draft.profileId ?? "")) option.selected = true;
        profileSelect.append(option);
      }
      profileSelect.addEventListener("change", () => {
        draft.profileId = profileSelect.value;
        apiDraft = draft;
        apiDraftDirty = true;
        if (syncApiDirty) syncApiDirty();
      });
      profileRow.append(profileSelect);
      const refreshBtn = el("button", "aw-btn aw-btn--icon", "刷新");
      refreshBtn.type = "button";
      refreshBtn.setAttribute("aria-label", "刷新酒馆连接预设列表");
      refreshBtn.addEventListener("click", () => renderCenter());
      profileRow.append(refreshBtn);
      profileField.append(profileRow);
      profileField.append(el("span", "aw-hint", "推演时经酒馆连接管理器用该预设发送；发送前临时切换活动预设，完成后恢复。可在下方点「测试连接」检查可用性。"));
      panel.append(profileField);
    } else {
      panel.append(el("div", "aw-note", "酒馆主 API 模式：推演经酒馆助手（TavernHelper.generateRaw）走酒馆当前主 API，密钥与模型跟随酒馆设置，无需在 Atlas 里填端点。下方「测试连接」会检查酒馆助手是否可用。"));
    }

    // System Prompt（可选，chatbox 同款）：各连接方式通用；留空 = 跟随「推进」页活动提示词预设 / 内置默认
    const sysPromptField = el("div", "aw-field");
    sysPromptField.append(el("span", "aw-field__label", "System Prompt（可选）"));
    const sysPromptArea = document.createElement("textarea");
    sysPromptArea.className = "aw-input aw-input--area";
    sysPromptArea.rows = 3;
    sysPromptArea.maxLength = 8000;
    sysPromptArea.placeholder = "可选";
    sysPromptArea.setAttribute("aria-label", "System Prompt（可选）");
    sysPromptArea.value = String(draft.systemPrompt ?? "");
    sysPromptArea.addEventListener("input", () => {
      draft.systemPrompt = sysPromptArea.value;
      apiDraft = draft;
      apiDraftDirty = true;
      if (syncApiDirty) syncApiDirty();
    });
    sysPromptField.append(sysPromptArea);
    sysPromptField.append(el("span", "aw-hint", "本连接专用的系统提示词，三种连接方式都生效；留空 = 跟随「推进」页的活动提示词预设（无则内置默认）。填写后优先于「推进」页预设。"));
    panel.append(sysPromptField);

    // dirty 操作条（shujuku 式：未修改时「放弃修改 / 保存」禁用；保存后自动设为当前使用）
    const actions = el("div", "aw-actions");
    const apiDiscardButton = el("button", "aw-btn aw-btn--ghost", "放弃修改");
    apiDiscardButton.type = "button";
    apiDiscardButton.setAttribute("aria-label", "放弃未保存的 API 连接修改");
    apiDiscardButton.addEventListener("click", () => {
      const preset = apiLibrary.find((p) => p.id === apiDraft?.id);
      apiDraft = apiDraftFromView(preset);
      apiDraftDirty = false;
      apiKeyInput = preset ? String(preset.apiKey ?? "") : "";
      modelOptions = [];
      setStatus("", "ok");
      renderCenter();
    });
    actions.append(apiDiscardButton);
    apiSaveButton = el("button", "aw-btn aw-btn--primary", draft.id ? `保存修改到「${draft.name}」` : "保存新连接");
    apiSaveButton.type = "button";
    apiSaveButton.setAttribute("aria-label", "保存当前 API 连接");
    apiSaveButton.addEventListener("click", async () => {
      const preset = apiDraft ?? newApiDraft();
      if (!preset.name.trim()) {
        setStatus("连接名称不能为空。", "error");
        renderCenter();
        return;
      }
      const modeValue = preset.connectionMode === "main" || preset.connectionMode === "profile" ? preset.connectionMode : "custom";
      if (modeValue === "custom" && (!String(preset.endpoint ?? "").trim() || !String(preset.model ?? "").trim())) {
        setStatus("自定义连接的端点与模型名都不能为空。", "error");
        renderCenter();
        return;
      }
      if (modeValue === "profile" && !String(preset.profileId ?? "").trim()) {
        setStatus("酒馆连接预设模式需要先选择连接预设。", "error");
        renderCenter();
        return;
      }
      const ok = await sendSettingsCommand({
        action: "api.save",
        preset: apiPayloadFromDraft(preset),
        apiKeyMode: "replace",
        apiKey: apiKeyInput,
      });
      if (ok) {
        const saved = apiLibrary.find((p) => p.name === preset.name.trim()) ?? apiLibrary[apiLibrary.length - 1];
        apiDraft = apiDraftFromView(saved);
        apiDraftDirty = false;
        apiKeyInput = saved ? String(saved.apiKey ?? "") : "";
        // shujuku 语义：保存（新建）后自动设为当前使用
        if (saved) void sendSettingsCommand({ action: "api.activate", id: saved.id });
        setStatus("API 连接已保存并设为当前使用。");
      }
      renderCenter();
    });
    actions.append(apiSaveButton);
    const apiSaveAsButton = el("button", "aw-btn aw-btn--ghost", "另存为");
    apiSaveAsButton.type = "button";
    apiSaveAsButton.setAttribute("aria-label", "以新名称保存连接副本");
    apiSaveAsButton.addEventListener("click", async () => {
      const name = typeof window !== "undefined" && typeof window.prompt === "function"
        ? window.prompt("新连接名称", apiDraft?.name ? `${apiDraft.name} 副本` : "新连接")
        : null;
      if (!name || !name.trim()) return;
      const preset = apiDraft ?? newApiDraft();
      const payload = apiPayloadFromDraft(preset);
      delete payload.id;
      payload.name = name.trim();
      const ok = await sendSettingsCommand({
        action: "api.save",
        preset: payload,
        apiKeyMode: "replace",
        apiKey: apiKeyInput,
      });
      if (ok) {
        apiDraftDirty = false;
        setStatus("已另存为新的连接。");
      }
      renderCenter();
    });
    actions.append(apiSaveAsButton);
    panel.append(actions);

    let syncApiDirty = () => {};
    syncApiDirty = () => {
      apiDiscardButton.disabled = !apiDraftDirty;
      if (apiSaveButton) apiSaveButton.disabled = !apiDraftDirty;
    };
    syncApiDirty();
    panel.append(el("p", "aw-panel__meta", "修改后不会自动保存——改动只有点了保存按钮才会落盘。"));
    return panel;
  }

  /** 测试连接：按连接方式分流——main 查酒馆助手、profile 查连接管理器、custom 走模型列表 / 最小鉴权检查。 */
  async function testConnection(preset) {
    const mode = preset.connectionMode === "main" || preset.connectionMode === "profile" ? preset.connectionMode : "custom";
    if (mode === "main") {
      if (isTavernMainAvailable(getTavernHelper)) {
        setStatus("酒馆助手（TavernHelper.generateRaw）可用，主 API 推演就绪。", "ok");
      } else {
        setStatus("未检测到酒馆助手（TavernHelper.generateRaw）——请安装 JS-Slash-Runner，或改用自定义连接。", "error");
      }
      renderCenter();
      return;
    }
    if (mode === "profile") {
      let ctx = null;
      try { ctx = SillyTavern.getContext(); } catch { ctx = null; }
      if (!isConnectionManagerAvailable(ctx)) {
        setStatus("ConnectionManagerRequestService 不可用——请检查酒馆版本或连接管理器配置。", "error");
        renderCenter();
        return;
      }
      const profiles = getConnectionManagerProfiles(ctx);
      if (!String(preset.profileId ?? "").trim()) {
        setStatus("请先选择酒馆连接预设再测试。", "error");
        renderCenter();
        return;
      }
      const target = profiles.find((p) => String(p.id) === String(preset.profileId));
      setStatus(target ? `连接管理器可用，目标预设：「${target.name}」。` : "连接管理器可用，但所选预设不在当前列表里（点「刷新」重读）。", target ? "ok" : "error");
      renderCenter();
      return;
    }
    const endpoint = String(preset.endpoint || "").trim();
    if (!endpoint) {
      setStatus("请先填写端点，再加载模型。", "error");
      renderCenter();
      return;
    }
    // 0.9.14：claude / gemini 协议不走 /status 拉模型列表——MiniMax 等网关对 /models 放行
    // 但对 completions 拒绝（订阅密钥），「测试全绿、推演就炸」的假阳性就是这么来的。
    // 改发一条 max_tokens=1 的真实小请求走同一协议映射，端点 / 密钥 / 协议 / 模型四件套一起验。
    const apiFormatValue0 = String(preset.apiFormat ?? "openai");
    if (apiFormatValue0 === "claude" || apiFormatValue0 === "gemini") {
      if (!String(preset.model ?? "").trim()) {
        setStatus("协议为 Claude / Gemini 时请先手填模型名（如 MiniMax-M3），再测试连接。", "error");
        renderCenter();
        return;
      }
      setStatus(apiFormatValue0 === "claude" ? "正在按 Claude（Anthropic）协议发送真实探测请求…" : "正在按 Gemini 协议发送真实探测请求…", "ok");
      renderCenter();
      const startedProbeAt = Date.now();
      try {
        const { atlasCustomIncludeHeaders, normalizeAtlasClaudeBase, normalizeAtlasGeminiBase } = await loadUiCore();
        const ctx = SillyTavern.getContext();
        const headers = { "Content-Type": "application/json" };
        if (typeof ctx.getRequestHeaders === "function") Object.assign(headers, ctx.getRequestHeaders());
        const probeBase = apiFormatValue0 === "claude" ? normalizeAtlasClaudeBase(endpoint) : normalizeAtlasGeminiBase(endpoint);
        const probeResponse = await fetch("/api/backends/chat-completions/generate", {
          method: "POST",
          headers,
          body: JSON.stringify({
            chat_completion_source: apiFormatValue0 === "claude" ? "claude" : "makersuite",
            reverse_proxy: probeBase,
            proxy_password: apiKeyInput || "",
            custom_url: endpoint,
            model: String(preset.model).trim(),
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
            stream: false,
            custom_include_headers: atlasCustomIncludeHeaders(apiKeyInput ? `Bearer ${apiKeyInput}` : ""),
          }),
        });
        emitAtlasDiagnostic({
          level: probeResponse.ok ? "info" : "error", source: "model",
          code: probeResponse.ok ? "MODEL_PROBE_COMPLETE" : "MODEL_PROBE_FAILED",
          operation: "probe", phase: "response",
          outcome: probeResponse.ok ? "success" : "failed",
          httpStatus: probeResponse.status, durationMs: Date.now() - startedProbeAt,
          details: { route: "model-proxy", mode: apiFormatValue0 },
        });
        const probePayload = await probeResponse.json().catch(() => null);
        const probeError = probePayload && typeof probePayload === "object" ? probePayload.error : null;
        const probeErrorText = typeof probeError === "string" ? probeError : probeError && typeof probeError === "object" ? String(probeError.message ?? "") : "";
        if (!probeResponse.ok || probeErrorText) {
          setStatus(`协议探测失败：${probeErrorText || `HTTP ${probeResponse.status}`}——端点 / 密钥 / 协议 / 模型至少一项不通，请对照日志核对。`, "error");
        } else {
          setStatus("协议探测成功：端点、密钥、协议、模型全部可用，可以推演。", "ok");
        }
      } catch (error) {
        setStatus(`协议探测失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
      renderCenter();
      return;
    }
    setStatus("正在通过酒馆后端代理读取模型列表…", "ok");
    renderCenter();
    const startedStatusAt = Date.now();
    try {
      const ctx = SillyTavern.getContext();
      const headers = { "Content-Type": "application/json" };
      if (typeof ctx.getRequestHeaders === "function") Object.assign(headers, ctx.getRequestHeaders());
      // ATLAS-FIX-02：custom_include_headers 必须是原始头字符串（与生成路径共用同一序列化口径）
      // 0.9.10/0.9.13：claude → claude 源（reverse_proxy 补 /v1）；gemini → makersuite 源（剥版本段）
      const { atlasCustomIncludeHeaders, normalizeAtlasClaudeBase, normalizeAtlasGeminiBase } = await loadUiCore();
      const keyValue = apiKeyInput ? `Bearer ${apiKeyInput}` : "";
      const apiFormatValue = String(preset.apiFormat ?? "openai");
      const claudeBase = apiFormatValue === "claude" ? normalizeAtlasClaudeBase(endpoint) : null;
      const geminiBase = apiFormatValue === "gemini" ? normalizeAtlasGeminiBase(endpoint) : null;
      const nativeSource = claudeBase ? "claude" : geminiBase ? "makersuite" : "custom";
      const response = await fetch("/api/backends/chat-completions/status", {
        method: "POST",
        headers,
        body: JSON.stringify({
          chat_completion_source: nativeSource,
          ...(claudeBase ? { reverse_proxy: claudeBase, proxy_password: apiKeyInput || "" } : {}),
          ...(geminiBase ? { reverse_proxy: geminiBase, proxy_password: apiKeyInput || "" } : {}),
          ...(nativeSource === "custom" ? { reverse_proxy: endpoint, proxy_password: "" } : {}),
          custom_url: endpoint,
          custom_include_headers: atlasCustomIncludeHeaders(keyValue),
        }),
      });
      emitAtlasDiagnostic({
        level: response.ok ? "info" : "error", source: "model",
        code: response.ok ? "MODEL_LIST_COMPLETE" : "MODEL_LIST_FAILED",
        operation: "model-list", phase: "response",
        outcome: response.ok ? "success" : "failed",
        httpStatus: response.status, durationMs: Date.now() - startedStatusAt,
        details: { route: "model-status", mode: apiFormatValue },
      });
      if (!response.ok) {
        setStatus("加载模型失败（HTTP " + response.status + "）。请检查 API 连接；详情见日志页。", "error");
        renderCenter();
        return;
      }
      const payload = await response.json().catch(() => ({}));
      // shujuku 同款三重回退解析：{models} / {data} / 裸数组
      const raw = Array.isArray(payload?.models)
        ? payload.models
        : Array.isArray(payload?.data)
          ? payload.data
          : Array.isArray(payload)
            ? payload
            : [];
      modelOptions = raw
        .map((item) => (typeof item === "string" ? item : item && typeof item === "object" ? item.id : null))
        .filter((item) => typeof item === "string" && item.length > 0)
        .slice(0, 500);
      if (modelOptions.length === 0) {
        setStatus("端点可达，但没读到模型列表（可直接手填模型名）。", "ok");
      } else {
        setStatus(`连接成功，读到 ${String(modelOptions.length)} 个模型。`, "ok");
      }
    } catch (error) {
      setStatus(`加载模型失败：${error instanceof Error ? error.message : String(error)}`, "error");
    }
    renderCenter();
  }

  // ---------------------------------------------------------------------------
  // 0.9.16 「替换」页：内容替换规则库（照抄 shujuku 内容替换 + 开关/删改增强）
  // ---------------------------------------------------------------------------

  /** 单行规则编辑器：名称 / 开始词 / 结束词 / 启用开关 / 保存 / 删除（预制与手动同库平等）。 */
  function buildReplacePanel() {
    const panel = el("div", "aw-panel");
    panel.append(el("span", "aw-eyebrow", "替换规则"));
    panel.append(el("span", "aw-hint", "推演返回的正文在解析前按启用的规则删除「开始词…结束词」之间的全部内容（大小写不敏感，支持嵌套）。预制规则与手动规则完全平等：都可以修改、关闭或删除。"));

    const listWrap = el("div", "aw-list");

    const rebuild = () => {
      listWrap.replaceChildren();
      const rules = Array.isArray(settingsV2?.contentReplaceRules) ? settingsV2.contentReplaceRules : [];
      if (rules.length === 0) {
        listWrap.append(el("p", "aw-panel__meta", "没有规则。可点下方「恢复预制规则」还原默认库。"));
      }
      for (const rule of rules) {
        const row = el("div", "aw-select-row aw-replace-row");

        const nameInput = document.createElement("input");
        nameInput.className = "aw-input";
        nameInput.value = String(rule.name ?? "");
        nameInput.setAttribute("aria-label", "规则名称");
        nameInput.placeholder = "名称";

        const startInput = document.createElement("input");
        startInput.className = "aw-input";
        startInput.value = String(rule.start ?? "");
        startInput.setAttribute("aria-label", "开始词");
        startInput.placeholder = "开始词（如 <think）";

        const endInput = document.createElement("input");
        endInput.className = "aw-input";
        endInput.value = String(rule.end ?? "");
        endInput.setAttribute("aria-label", "结束词");
        endInput.placeholder = "结束词（如 </think>）";

        const enabledCheck = document.createElement("input");
        enabledCheck.type = "checkbox";
        enabledCheck.checked = rule.enabled !== false;
        enabledCheck.setAttribute("aria-label", `启用规则：${rule.name}`);
        enabledCheck.title = "启用 / 停用该规则";
        enabledCheck.addEventListener("change", async () => {
          const ok = await sendSettingsCommand({
            action: "replace.save",
            preset: { id: rule.id, name: nameInput.value, start: startInput.value, end: endInput.value, enabled: enabledCheck.checked },
          });
          if (ok) { setStatus(`规则「${nameInput.value}」已${enabledCheck.checked ? "启用" : "停用"}。`, "ok"); rebuild(); }
          renderCenter();
        });

        const saveBtn = el("button", "aw-btn aw-btn--icon", "保存");
        saveBtn.setAttribute("aria-label", `保存规则：${rule.name}`);
        saveBtn.addEventListener("click", async () => {
          const ok = await sendSettingsCommand({
            action: "replace.save",
            preset: { id: rule.id, name: nameInput.value, start: startInput.value, end: endInput.value, enabled: enabledCheck.checked },
          });
          if (ok) { setStatus("规则已保存。", "ok"); rebuild(); }
          renderCenter();
        });

        const deleteBtn = el("button", "aw-btn aw-btn--danger aw-btn--icon", "删除");
        deleteBtn.setAttribute("aria-label", `删除规则：${rule.name}`);
        deleteBtn.addEventListener("click", async () => {
          if (!confirmDiscard(`删除规则「${rule.name}」`)) return;
          const ok = await sendSettingsCommand({ action: "replace.delete", id: rule.id });
          if (ok) { setStatus(`规则「${rule.name}」已删除。`, "ok"); rebuild(); }
          renderCenter();
        });

        row.append(nameInput, startInput, endInput, enabledCheck, saveBtn, deleteBtn);
        listWrap.append(row);
      }
    };
    rebuild();

    // 新增规则行（与编辑行同款字段，提交不带 id = 新建）
    const addRow = el("div", "aw-select-row aw-replace-row");
    const newName = document.createElement("input");
    newName.className = "aw-input";
    newName.placeholder = "名称（如：思考段）";
    newName.setAttribute("aria-label", "新规则名称");
    const newStart = document.createElement("input");
    newStart.className = "aw-input";
    newStart.placeholder = "开始词（如 <think）";
    newStart.setAttribute("aria-label", "新规则开始词");
    const newEnd = document.createElement("input");
    newEnd.className = "aw-input";
    newEnd.placeholder = "结束词（如 </think>）";
    newEnd.setAttribute("aria-label", "新规则结束词");
    const addBtn = el("button", "aw-btn aw-btn--primary aw-btn--icon", "添加规则");
    addBtn.setAttribute("aria-label", "添加替换规则");
    addBtn.addEventListener("click", async () => {
      const ok = await sendSettingsCommand({
        action: "replace.save",
        preset: { name: newName.value, start: newStart.value, end: newEnd.value, enabled: true },
      });
      if (ok) {
        setStatus("规则已添加。");
        newName.value = ""; newStart.value = ""; newEnd.value = "";
        rebuild();
      }
      renderCenter();
    });
    addRow.append(newName, newStart, newEnd, addBtn);

    const resetBtn = el("button", "aw-btn aw-btn--ghost", "恢复预制规则");
    resetBtn.setAttribute("aria-label", "恢复预制替换规则");
    resetBtn.addEventListener("click", async () => {
      if (!confirmDiscard("恢复预制规则（将覆盖当前全部规则）")) return;
      const ok = await sendSettingsCommand({ action: "replace.reset" });
      if (ok) { setStatus("已恢复预制规则库。", "ok"); rebuild(); }
      renderCenter();
    });

    const actions = el("div", "aw-actions");
    actions.append(addBtn, resetBtn);

    panel.append(listWrap);
    panel.append(el("span", "aw-field__label", "新增规则"));
    panel.append(addRow);
    panel.append(actions);
    return panel;
  }

  /** 0.9.46 皮肤页：主题下拉（即时生效）+ 自定义 CSS（保存生效）+ 令牌清单。 */
  function buildSkinPanel() {
    const panel = el("section", "aw-panel");

    panel.append(el("span", "aw-field__label", "主题"));
    const themeSelect = document.createElement("select");
    themeSelect.className = "aw-input";
    themeSelect.setAttribute("aria-label", "工作台主题");
    for (const theme of ATLAS_SKIN_THEMES) {
      const option = document.createElement("option");
      option.value = theme.id;
      option.textContent = theme.label;
      if (theme.id === skinState.theme) option.selected = true;
      themeSelect.append(option);
    }
    themeSelect.addEventListener("change", () => {
      skinState.theme = normalizeAtlasSkinTheme(themeSelect.value);
      applyAtlasSkin(root, skinState);
      skinPort?.write?.("skinTheme", skinState.theme);
      setStatus("主题已切换并保存。", "ok");
      renderCenter();
    });
    panel.append(themeSelect);

    panel.append(el("span", "aw-field__label", "自定义 CSS（覆盖皮肤令牌）"));
    const cssBox = document.createElement("textarea");
    cssBox.className = "aw-input";
    cssBox.rows = 8;
    cssBox.spellcheck = false;
    cssBox.setAttribute("aria-label", "自定义皮肤 CSS");
    cssBox.placeholder = ".atlas-workbench {\n  --aw-paper: #f2efe7;\n  --aw-gold: #c4a363;\n}";
    cssBox.value = skinState.customCss;
    panel.append(cssBox);

    const saveBtn = el("button", "aw-btn", "保存皮肤");
    saveBtn.type = "button";
    saveBtn.addEventListener("click", () => {
      if (cssBox.value.length > ATLAS_CUSTOM_SKIN_LIMIT) {
        setStatus(`自定义 CSS 过长（${String(cssBox.value.length)} > ${String(ATLAS_CUSTOM_SKIN_LIMIT)} 字符），未保存。`, "error");
        return;
      }
      skinState.customCss = cssBox.value;
      applyAtlasSkin(root, skinState);
      skinPort?.write?.("skinCustomCss", skinState.customCss);
      setStatus("皮肤已保存。", "ok");
      renderCenter();
    });
    const actions = el("div", "aw-actions");
    actions.append(saveBtn);
    panel.append(actions);
    if (statusLine()) panel.append(statusLine());

    // 状态行（setStatus → statusLine，与推进 / API 页同款反馈）
    const vars = el("details", "aw-skin__vars");
    vars.append(el("summary", "aw-field__label", `可用皮肤令牌（${String(ATLAS_SKIN_VARIABLES.length)} 个）`));
    vars.append(el("p", "aw-panel__text", ATLAS_SKIN_VARIABLES.join("、")));
    panel.append(vars);

    panel.append(buildMapSkinPanel());
    return panel;
  }

  /**
   * 0.9.51（M08）地图皮肤管理：导入 .atlas-map-skin.json → 校验 → 预览（立即生效可取消）
   * → 应用（持久化）；导出当前 / 撤销上次应用 / 恢复跟随工作台；两个内置样例一键预览。
   * 预览只影响当前界面（applyAtlasMapSkin 内存注入），点「应用」才写 extensionSettings。
   */
  function buildMapSkinPanel() {
    const panel = el("section", "aw-panel");
    panel.append(el("span", "aw-eyebrow", "地图皮肤"));
    panel.append(el("p", "aw-panel__meta", `导入 .atlas-map-skin.json 换地图外观（≤${String(Math.round(ATLAS_MAP_SKIN_BYTES_MAX / 1024))} KiB 纯令牌文件）。皮肤只改颜色 / 尺寸 / 形状——坐标、距离、标定与操作完全不变。`));

    const statusText = mapSkin
      ? `当前：${mapSkin.name}${mapSkin.unknownKeys ? `（${String(mapSkin.unknownKeys)} 个未知令牌被忽略）` : ""}`
      : "当前：跟随工作台主题";
    panel.append(el("p", "aw-panel__text", statusText));

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".json,application/json";
    fileInput.className = "aw-input";
    fileInput.setAttribute("aria-label", "选择地图皮肤 JSON 文件");
    const previewNote = el("p", "aw-panel__meta", "");
    const btnRow = el("div", "aw-actions");

    /** 预览：内存注入 + 刷新地图页可见效果；不持久化。 */
    const previewSkin = (skin) => {
      applyAtlasMapSkin(root, skin);
      previewNote.textContent = `预览中：${skin.name}（${String(Object.keys(skin.tokens).length)} 个令牌${skin.unknownKeys ? `，${String(skin.unknownKeys)} 个未知令牌已忽略` : ""}）。满意就「应用」，不满意「取消」恢复原状。`;
      applyBtn.disabled = false;
      cancelBtn.disabled = false;
    };
    const persist = async (skin) => {
      try {
        skinPort?.write?.("atlasMapSkin", skin);
      } catch {
        // 保存失败不显示成功：回滚内存态并如实报错
        applyAtlasMapSkin(root, mapSkinPrev);
        setStatus("皮肤保存失败——已恢复上一份皮肤。", "error");
        return;
      }
      mapSkin = skin;
      applyAtlasMapSkin(root, mapSkin);
      previewNote.textContent = "";
      applyBtn.disabled = true;
      cancelBtn.disabled = true;
      setStatus(`地图皮肤已应用：${skin.name}。`, "ok");
      renderCenter();
    };
    const applyBtn = el("button", "aw-btn aw-btn--primary", "应用");
    applyBtn.type = "button";
    applyBtn.disabled = true;
    // 闭包持有当前预览的 skin（预览 = 内存注入；应用 = 持久化到 extensionSettings）
    let pendingSkin = null;
    const realPreview = (skin) => {
      pendingSkin = skin;
      previewSkin(skin);
    };
    applyBtn.addEventListener("click", () => {
      if (pendingSkin) void persist(pendingSkin);
    });
    const cancelBtn = el("button", "aw-btn", "取消");
    cancelBtn.type = "button";
    cancelBtn.disabled = true;
    cancelBtn.addEventListener("click", () => {
      pendingSkin = null;
      applyAtlasMapSkin(root, mapSkin); // 回滚到已应用的皮肤（可能为 null = 跟随工作台）
      previewNote.textContent = "";
      applyBtn.disabled = true;
      cancelBtn.disabled = true;
    });
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (!file) return;
      if (file.size > ATLAS_MAP_SKIN_BYTES_MAX) {
        setStatus(`皮肤文件超过 ${String(Math.round(ATLAS_MAP_SKIN_BYTES_MAX / 1024))} KiB 上限，已拒绝。`, "error");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const result = parseAtlasMapSkin(String(reader.result ?? ""));
        if (!result.ok) {
          setStatus(`皮肤校验失败：${result.error}`, "error");
          return;
        }
        realPreview(result.skin);
      };
      reader.onerror = () => setStatus("皮肤文件读取失败。", "error");
      reader.readAsText(file);
    });

    const exportBtn = el("button", "aw-btn", "导出当前皮肤");
    exportBtn.type = "button";
    exportBtn.addEventListener("click", () => {
      if (!mapSkin) {
        setStatus("当前跟随工作台主题，没有可导出的地图皮肤——先导入或选一个样例。", "error");
        return;
      }
      try {
        const blob = new Blob([exportAtlasMapSkin(mapSkin)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${String(mapSkin.id || "atlas-map-skin").replace(/[^a-zA-Z0-9._-]/g, "_")}.atlas-map-skin.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setStatus("皮肤已导出（只含主题元数据与令牌）。", "ok");
      } catch {
        setStatus("皮肤导出失败。", "error");
      }
    });
    const undoBtn = el("button", "aw-btn", "撤销上次应用");
    undoBtn.type = "button";
    undoBtn.addEventListener("click", () => {
      pendingSkin = null;
      const restore = mapSkinPrev;
      mapSkinPrev = mapSkin;
      mapSkin = restore;
      applyAtlasMapSkin(root, mapSkin);
      try { skinPort?.write?.("atlasMapSkin", mapSkin); } catch { setStatus("撤销已生效但保存失败——刷新后可能回到撤销前状态。", "warn"); }
      previewNote.textContent = "";
      applyBtn.disabled = true;
      cancelBtn.disabled = true;
      renderCenter();
    });
    const resetBtn2 = el("button", "aw-btn", "恢复跟随工作台");
    resetBtn2.type = "button";
    resetBtn2.addEventListener("click", () => {
      pendingSkin = null;
      mapSkinPrev = mapSkin;
      mapSkin = null;
      applyAtlasMapSkin(root, null);
      try { skinPort?.write?.("atlasMapSkin", null); } catch { setStatus("恢复已生效但保存失败——刷新后可能回到之前状态。", "warn"); }
      previewNote.textContent = "";
      applyBtn.disabled = true;
      cancelBtn.disabled = true;
      setStatus("已恢复跟随工作台主题。", "ok");
      renderCenter();
    });

    // 内置样例（M08：至少两个真实可导入样例）
    const presetRow = el("div", "aw-actions");
    for (const preset of ATLAS_MAP_SKIN_PRESETS) {
      const presetBtn = el("button", "aw-btn", `样例：${preset.name}`);
      presetBtn.type = "button";
      presetBtn.addEventListener("click", () => {
        const result = parseAtlasMapSkin(preset);
        if (!result.ok) {
          setStatus(`内置样例校验失败（不应发生）：${result.error}`, "error");
          return;
        }
        realPreview(result.skin);
      });
      presetRow.append(presetBtn);
    }

    btnRow.append(applyBtn, cancelBtn);
    panel.append(fileInput, previewNote, btnRow, presetRow);
    const manageRow = el("div", "aw-actions");
    manageRow.append(exportBtn, undoBtn, resetBtn2);
    panel.append(manageRow);
    return panel;
  }

  /** 首次进入需要设置的页面时拉取一次 v2 设置（失败不重复轰炸）。 */
  function ensureSettingsLoaded() {
    if (settingsLoadedOnce) return;
    settingsLoadedOnce = true;
    void loadSettingsV2().then(() => renderCenter());
  }

  function renderPage() {
    const d = data();
    // 关闭可见性（作者 2026-09-19 反馈：× 与退出都关不掉）——setPanelOpen 只改状态，
    // 这里负责消费：panelOpen=false 时隐藏根节点（面板 DOM 保留，重开零重建）。
    root.style.display = state().panelOpen === false ? "none" : "";
    renderNav();
    renderEngineStatus();
    renderTopbar(d);
    renderCenter(d);
    if (state().page === "map") renderMap(d);
    renderMoves();
    renderSide();
  }

  // ATLAS-18 回归修复：此处原为 `void loadPresetIntoForm().then(...)` —— 该函数在
  // 六栏重写（设置页拆成 推进/API 两页）时已被删除，调用点漏删 → 挂载即 ReferenceError，
  // 被 connectOnce 的 catch 吞掉 → 面板只剩静态骨架、零功能（0.9.2 全量必现）。
  // 设置的懒加载已由 ensureSettingsLoaded（进入 推进/API 页时拉取一次）接管。

  core.__renderPage = renderPage;
  renderPage();
  void refreshLorebookSnapshot();
  return renderPage;
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
      const { mod, api, core } = atlasRuntime;
      if (!mod || !api) return false;
      const world = mod.buildStarterWorld({
        id: mod.starterWorldIdForChat(chatId),
        now: Date.now(),
        name: cardName,
        description,
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
  /** 缓存 TTL（ms）：同一本书 1 分钟内复用，避免每回合都打 ST 内部接口 */
  CACHE_TTL_MS: 60_000,
};

let loreSupplementCache = { bookName: null, at: 0, text: "" };

/**
 * 读当前角色世界书 → 有界资料文本（失败 / 无书 / 空书 → 空串，绝不抛错）。
 * 0.9.35 多书合并（照抄 shujuku getCurrentCharacterWorldbookBinding 口径）：
 * TavernHelper.getCharWorldbookNames('current')（角色绑定 primary + additional 全部）
 * → 卡主世界书（data.extensions.world）→ 聊天绑定书，全部并入去重逐本读取。
 * 此前只读「卡主书 or 聊天书」一本——世界书挂载在 additional 槽的卡（本次验收的真实卡）
 * 完全读不到，静默空串。Atlas 自写条目（动向 / 事件）排除——回喂推演纯属复读。
 */
async function readCardLoreSupplement() {
  try {
    if (typeof SillyTavern === "undefined") return "";
    const ctx = SillyTavern.getContext();
    const character = ctx?.characters?.[ctx?.characterId] ?? null;

    // 1) 收集候选书名（有序去重）
    const bookNames = [];
    const pushBook = (value) => {
      const name = typeof value === "string" ? value.trim() : "";
      if (name && !bookNames.includes(name)) bookNames.push(name);
    };
    try {
      // TavernHelper.getCharWorldbookNames 返回结构随版本有差异：数组 / {primary, additional} / 字符串，全部防御兼容
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
    } catch { /* 酒馆助手不可用 → 原生路径兜底 */ }
    pushBook(character?.data?.extensions?.world);
    pushBook(ctx?.chatMetadata?.world_info);
    if (bookNames.length === 0) return "";

    // 2) 缓存键 = 全部书名（任一书变化即失效）
    const cacheKey = bookNames.join("|");
    const cached = loreSupplementCache;
    if (cached.bookName === cacheKey && Date.now() - cached.at < LORE_SUPPLEMENT_LIMITS.CACHE_TTL_MS) {
      return cached.text;
    }

    // 3) 逐本读取合并（单本失败跳过，不影响其余书）
    const worldInfo = await loadStWorldInfo();
    const prefixList = atlasRuntime.mod?.ATLAS_LOREBOOK_PREFIX;
    const atlasPrefixes = prefixList && typeof prefixList === "object" ? Object.values(prefixList) : ["Atlas 动向 ·", "Atlas 事件 ·"];
    const lines = [];
    let total = 0;
    let failedBooks = 0;
    for (const bookName of bookNames) {
      let rawEntries = [];
      try {
        const data = await worldInfo.loadWorldInfo(bookName);
        rawEntries = data && typeof data === "object" && data.entries && typeof data.entries === "object"
          ? Object.values(data.entries)
          : [];
      } catch {
        failedBooks += 1;
        continue; // 单本书不存在 / 读取失败 → 跳过该本
      }
      for (const entry of rawEntries) {
        if (lines.length >= LORE_SUPPLEMENT_LIMITS.ENTRIES_MAX) break;
        if (!entry || typeof entry !== "object" || entry.disable === true) continue;
        const content = typeof entry.content === "string" ? entry.content.trim() : "";
        if (!content) continue;
        const comment = typeof entry.comment === "string" ? entry.comment.trim() : "";
        if (atlasPrefixes.some((prefix) => comment.startsWith(prefix))) continue; // Atlas 自写条目不回喂
        const keys = Array.isArray(entry.key) ? entry.key.filter((k) => typeof k === "string" && k.trim()) : [];
        const title = comment || (keys.length > 0 ? keys.slice(0, 4).join(" / ") : "条目");
        const clipped = content.length > LORE_SUPPLEMENT_LIMITS.ENTRY_CONTENT_CHARS
          ? `${content.slice(0, LORE_SUPPLEMENT_LIMITS.ENTRY_CONTENT_CHARS)}…`
          : content;
        const line = `- [${bookName}] ${title}：${clipped.replace(/\s+/g, " ")}`;
        if (total + line.length > LORE_SUPPLEMENT_LIMITS.TOTAL_CHARS) break;
        lines.push(line);
        total += line.length;
      }
      if (lines.length >= LORE_SUPPLEMENT_LIMITS.ENTRIES_MAX) break;
    }
    if (failedBooks > 0) {
      emitAtlasDiagnostic({ level: "warn", source: "lorebook",
        code: "LORE_CONTEXT_UNAVAILABLE", operation: "lore-context",
        phase: "read", outcome: "failed", details: { count: failedBooks } });
    }
    const text = lines.join("\n");
    loreSupplementCache = { bookName: cacheKey, at: Date.now(), text };
    return text;
  } catch {
    emitAtlasDiagnostic({ level: "warn", source: "lorebook",
      code: "LORE_CONTEXT_UNAVAILABLE", operation: "lore-context",
      phase: "read", outcome: "failed" });
    return ""; // 读取失败不阻断推演
  }
}

async function connectOnce() {
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
    const engine = mod.createAtlasServerCore({
      store: engineStore,
      fetchFn: hostDispatchFetch,
      onDiagnostic: emitAtlasDiagnostic,
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
      onDiagnostic: emitAtlasDiagnostic,
      host: (hostRef ??= createHost(context)),
      emitter: createEmitter(context),
      adaptEvent,
      resolveAssistantFloor: createAssistantFloorResolver(context),
      ensureWorld: () => ensureStarterWorld(),
      // 0.9.21 世界书资料块：commit 前读当前卡书启用条目（有界），喂给推演 AI；
      // 0.9.22 开关：被供应商审核拦截时可在推进页关闭（settingsV2.loreSupplementEnabled）
      getLoreSupplement: () => (settingsV2?.loreSupplementEnabled === false ? Promise.resolve("") : readCardLoreSupplement()),
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
              const result = await lorebookWriter.syncTurn(plans);
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
    atlasDiagnostics.subscribe(() => {
      if (core.getState().page !== "logs" || diagnosticRenderTimer) return;
      diagnosticRenderTimer = setTimeout(() => {
        diagnosticRenderTimer = null;
        if (core.getState().page === "logs") rerender();
      }, 150);
    });
    installMenuButton(core);
    core.init();
    connected = { core, rerender };
    return connected;
  } catch (error) {
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
    item.setAttribute("tabindex", "0");
    item.title = "打开阿特拉斯世界工作台";
    const icon = el("div", "fa-fw fa-solid fa-globe extensionsMenuExtensionButton");
    const label = el("span", null, "阿特拉斯 / Atlas");
    item.append(icon, label);
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      core.setPanelOpen(true);
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
