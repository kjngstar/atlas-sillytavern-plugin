
/** 0.9.42 会话承载：世界文档（world/maps/turns/geoAuto/binding/rev）挂在 chatMetadata.atlas。 */
export const ATLAS_SESSION_KEY = "atlas";

export const ATLAS_SESSION_SCHEMA_VERSION = 1;


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
export function readAtlasSession(context) {
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
  if (metadata[ATLAS_SESSION_KEY]?.database && session !== metadata[ATLAS_SESSION_KEY]) {
    throw new Error("SQL_LEGACY_WRITE_RETIRED：当前聊天已有数据库，旧会话响应不能覆盖 SQL 存档。");
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
export function atlasSessionWriteGuard(requestChatId, currentChatId, sessionChatId, responseSession) {
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
 * 只认计划 §2.1 点名的三块：world（兼容镜像）/ tables（迁移备份）/ simulation（第四块）。
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


/** H05：内容哈希（FNV-1a 32 位十六进制；纯函数、不依赖 crypto、同输入同输出）。 */
export function atlasContentHash(text) {
  const input = typeof text === "string" ? text : text === null || text === undefined ? "" : String(text);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}


/**
 * H05：楼层身份归一——稳定 `messageUID` / `variantKey` / `contentHash`。
 *
 * **绝不用数组下标冒充身份**（删楼 / 截断会让下标漂移）：
 * - `messageUID`：优先宿主给的稳定 id（messageUID / mesId / messageId）；
 *   其次 `chatId:role:send_date`（落盘时间戳，删楼不变）；
 *   再退到**内容寻址** `chatId:role:<variantKey>`，并显式标 `identityFallback: true`。
 *   内容寻址时用 `#f<下标>` 只做**同内容重复楼层的消歧后缀**，不是身份本体。
 * - `variantKey`：正文变体键——换 swipe（重新生成）必然换键，同一段正文永远同键。
 * - `contentHash`：正文内容哈希（改一个字就变）。
 */
export function atlasFloorIdentity(message, floorIndex = 0, { chatId = null } = {}) {
  const record = message && typeof message === "object" ? message : {};
  const text = typeof record.mes === "string" ? record.mes : "";
  const contentHash = atlasContentHash(text);
  const index = Number.isInteger(floorIndex) && floorIndex >= 0 ? floorIndex : 0;
  const role = record.is_user === true ? "u" : "a";
  const chatKey = chatId === null || chatId === undefined || String(chatId) === "" ? "chat" : String(chatId);
  const hostUid = [record.messageUID, record.mesId, record.messageId]
    .map((value) => {
      if (typeof value === "string" && value.trim() !== "") return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
      return null;
    })
    .find((value) => value !== null) ?? null;
  const parsedDate = Number(record.send_date);
  const sendDate = Number.isFinite(parsedDate) && parsedDate > 0 ? String(Math.trunc(parsedDate)) : null;
  const parsedSwipe = Number(record.swipe_id);
  const swipeId = Number.isInteger(parsedSwipe) && parsedSwipe >= 0 ? parsedSwipe : null;
  const swipes = Array.isArray(record.swipes) && record.swipes.length > 0 ? record.swipes : null;
  const swipeText = swipes && swipeId !== null && typeof swipes[swipeId] === "string" ? swipes[swipeId] : null;
  const variantKey = swipeId === null
    ? `v0-${contentHash}`
    : `v${swipeId}-${atlasContentHash(swipeText ?? text)}`;
  const contentAddressed = `${chatKey}:${role}:${variantKey}`;
  const messageUID = hostUid
    ?? (sendDate !== null ? `${chatKey}:${role}:${sendDate}` : `${contentAddressed}#f${index}`);
  return {
    messageUID,
    variantKey,
    contentHash,
    floorIndex: index,
    swipeId,
    /** 身份是内容寻址来的（既无宿主 id 也无 send_date）——调用方按「可能漂移」对待。 */
    identityFallback: hostUid === null && sendDate === null,
  };
}


/** 宿主上下文读取（每次都重新取，绝不缓存聊天对象；失败返回 null）。 */
export function atlasContextRecord(context) {
  try {
    const record = typeof context === "function" ? context() : context;
    return record && typeof record === "object" ? record : null;
  } catch {
    return null;
  }
}


/**
 * H05：本轮**助手楼层**的稳定身份（用户楼层 / 无楼层 → null，绝不猜）。
 * 下标只用于「定位这一楼层」，身份本身来自 `atlasFloorIdentity`（见上）。
 */
export function atlasAssistantFloorIdentity(context, payload, event = "") {
  const record = atlasContextRecord(context);
  const chat = Array.isArray(record?.chat) ? record.chat : null;
  if (!chat || chat.length === 0) return null;
  const name = String(event ?? "");
  const raw = Number(payload);
  let index = -1;
  if (["MESSAGE_RECEIVED", "MESSAGE_SWIPED", "MESSAGE_EDITED"].includes(name) && Number.isInteger(raw) && raw >= 0 && raw < chat.length) {
    index = raw;
  } else {
    for (let cursor = chat.length - 1; cursor >= 0; cursor -= 1) {
      const message = chat[cursor];
      if (message && message.is_user === false && typeof message.mes === "string" && message.mes.trim()) {
        index = cursor;
        break;
      }
    }
  }
  if (index < 0) return null;
  const message = chat[index];
  // 只有助手楼层能触发 SQL 候选（用户楼层编辑不产生世界回合）
  if (!message || message.is_user === true) return null;
  return {
    ...atlasFloorIdentity(message, index, { chatId: record?.chatId ?? null }),
    assistantText: typeof message.mes === "string" ? message.mes : "",
    userText: typeof chat[index - 1]?.mes === "string" ? chat[index - 1].mes : "",
  };
}


// ---------------------------------------------------------------------------
// B02b：会话路由请求包装（可测工厂）
// ---------------------------------------------------------------------------

/** 需要携带会话文档的引擎路由前缀（0.9.42 会话承载的既有清单，一字不改）。 */
export const SESSION_ROUTE_PREFIXES = [
  "/state",
  "/characters/timeline",
  "/map/image",
  "/map/travel-preview",
  "/turns/",
  "/bindings",
  "/worlds/import",
  "/worlds/ensure-starter",
  "/worlds/protagonist/sync",
  "/worlds/geo/adopt",
  "/worlds/geo/suggest",
  "/worlds/move-author",
  "/scene/",
  "/session/",
];


export function pathWantsSession(path) {
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
  // 酒馆生成结束时可能有一笔较早发起的 saveMetadata 迟到，短暂覆盖刚写回的 Atlas rev。
  // 仅在同一聊天、同一 metadata 对象内记住本 API 成功写回的修订；下一请求先恢复它。
  const latestByMetadata = new WeakMap();
  return {
    async request(method, path, body) {
      const requestContext = context();
      const requestChatId = requestContext.chatId ?? null;
      const requestMetadata = requestContext.chatMetadata ?? null;
      let payload = body;
      let requestSession = null;
      if(method === "POST" && path.startsWith("/sql/")) {
        payload = { ...(body ?? {}), chatUid: body?.chatUid ?? body?.chatId ?? requestChatId };
      }
      if (method === "POST" && pathWantsSession(path)) {
        requestSession = readAtlasSession(context);
        const latest = requestMetadata && latestByMetadata.get(requestMetadata);
        if (latest && latest.chatId === requestChatId && latest.session.rev > (requestSession?.rev ?? -1)) {
          await writeAtlasSession(context, latest.session, requestChatId, requestMetadata);
          requestSession = latest.session;
        }
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
          if (requestMetadata && requestChatId === currentChatId) {
            latestByMetadata.set(requestMetadata, { chatId: requestChatId, session: responseSession });
          }
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
