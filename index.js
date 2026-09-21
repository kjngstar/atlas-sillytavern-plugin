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

export const ATLAS_EXTENSION_VERSION = "0.9.40";
export const ATLAS_DISPLAY_NAME = "阿特拉斯 / Atlas";
export const ATLAS_PROTOCOL_VERSION = 1;
export const ATLAS_EXTENSION_ID = "atlas-world-sim";
export const ATLAS_BINDING_KEY = "atlas_binding";
export const ATLAS_SETTINGS_KEY = "atlas_world_sim";
/** 生成拦截器注入键（setExtensionPrompt 用；临时上下文，不写入可见聊天历史）。 */
export const ATLAS_INJECTION_KEY = "atlas_world_context";
/** 官方 generate_interceptor 在 globalThis 上的函数名（与 manifest.json 一致）。 */
export const ATLAS_INTERCEPTOR_GLOBAL = "atlasGenerateInterceptor";
/** 同源 Server Plugin 前缀（ST 自动挂载 /api/plugins/atlas）。 */
export const ATLAS_API_BASE = "/api/plugins/atlas";
/** 最低兼容 SillyTavern 客户端版本（manifest hooks / generate_interceptor / setExtensionPrompt / getRequestHeaders）。 */
export const ATLAS_MINIMUM_CLIENT_VERSION = "1.12.0";

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
// 运行日志（诊断用，作者 2026-09-20 反馈「增加一个日志区」）：
// 环形缓冲只留最近 ATLAS_LOG_LIMIT 条，仅内存不落盘；**任何明细先过 redactSecrets，
// 密钥绝不入日志**（纪律同 AR-ATLAS-07 / 规格 0.7.2）。
// ---------------------------------------------------------------------------
const ATLAS_LOG_LIMIT = 80;
const atlasLogEntries = [];

function redactSecrets(text) {
  return String(text)
    .replace(/Bearer\s+[^\s"',}】]+/gi, "Bearer [REDACTED]")
    .replace(/("apiKey"\s*:\s*)"[^"]*"/g, '$1"[REDACTED]"');
}

function atlasLog(tag, text, detail = null) {
  const clean = redactSecrets(text);
  atlasLogEntries.push({
    at: new Date(),
    tag: String(tag),
    text: clean,
    // 报错分级：失败 / 错误 / 异常 / 4xx·5xx 一律标 error，日志页高亮 + 可筛选
    level: /失败|错误|异常|HTTP [45]\d\d|网络失败/.test(clean) ? "error" : "info",
    ...(detail ? { detail: redactSecrets(detail).replace(/\s+/g, " ").slice(0, 400) } : {}),
  });
  if (atlasLogEntries.length > ATLAS_LOG_LIMIT) atlasLogEntries.shift();
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
    readBinding() {
      const metadata = context().chatMetadata;
      return metadata ? metadata[ATLAS_BINDING_KEY] ?? null : null;
    },
    async writeBinding(binding) {
      const metadata = context().chatMetadata;
      if (!metadata) return;
      metadata[ATLAS_BINDING_KEY] = binding;
      await context().saveMetadata();
    },
    async clearBinding() {
      const metadata = context().chatMetadata;
      if (!metadata) return;
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
        setPrompt(ATLAS_INJECTION_KEY, "", 2, 4);
        return;
      }
      setPrompt(ATLAS_INJECTION_KEY, String(pending.injectionText ?? ""), 2, 4);
    } catch (error) {
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

// 注意：必须与 ui-core 的 ATLAS_UI_PAGES 逐一对应（导出守卫测试把关双源漂移）
const PAGES = [
  { id: "overview", label: "概览" },
  { id: "map", label: "地图" },
  { id: "nearby", label: "附近" },
  { id: "changes", label: "变化" },
  { id: "progression", label: "推进" },
  { id: "api", label: "API" },
  { id: "replace", label: "替换" },
  { id: "logs", label: "日志" },
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

function computeMapBounds(points) {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const padX = Math.max(4, (Math.max(...xs) - Math.min(...xs)) * 0.08);
  const padY = Math.max(4, (Math.max(...ys) - Math.min(...ys)) * 0.08);
  return {
    minX: Math.min(...xs) - padX,
    maxX: Math.max(...xs) + padX,
    minY: Math.min(...ys) - padY,
    maxY: Math.max(...ys) + padY,
  };
}

function renderPanel(core, root, clampZoom, api, store, mod) {
  root.className = "atlas-workbench";
  root.id = "atlas-extension-panel-root";
  root.setAttribute("role", "application");
  root.setAttribute("aria-label", "阿特拉斯世界工作台");
  root.innerHTML = "";
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let regionFilter = "";
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let modelOptions = [];
  let settingsLoadedOnce = false;

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

  const PAGE_ICONS = { overview: "◈", map: "▣", nearby: "◉", changes: "≋", progression: "➤", api: "✳", logs: "⚑" };
  const nav = el("nav", "aw-nav");
  nav.setAttribute("aria-label", "工作台分区导航");
  nav.append(el("span", "aw-rail__label", "导航"));
  const navButtons = new Map();
  for (const page of PAGES) {
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
    if (receipts.length === 0 && !s.pendingTurn) {
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

  /** 日志页筛选器状态（仅页面内使用；0 = 全部）。 */
  let logFilter = "all";

  function atlasLogAsText() {
    return atlasLogEntries
      .map((entry) => `${entry.at.toLocaleTimeString()} [${entry.level === "error" ? "报错" : entry.tag}] ${entry.text}${entry.detail ? `\n  ${entry.detail}` : ""}`)
      .join("\n");
  }

  /** 日志页（侧边栏「日志」）：报错高亮 + 筛选 + 复制 / 清空。 */
  function buildLogPage() {
    const wrap = el("div", "aw-panel");

    const controls = el("div", "aw-actions");
    const filterSelect = document.createElement("select");
    filterSelect.className = "aw-input";
    filterSelect.setAttribute("aria-label", "筛选日志");
    const options = [
      ["all", `全部（${atlasLogEntries.length} 条）`],
      ["error", `仅报错（${atlasLogEntries.filter((entry) => entry.level === "error").length} 条）`],
      ["推演", "仅推演请求"],
      ["引擎", "仅引擎操作"],
      ["设置", "仅设置命令"],
    ];
    for (const [value, label] of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      filterSelect.append(option);
    }
    filterSelect.value = logFilter;
    filterSelect.addEventListener("change", () => {
      logFilter = filterSelect.value;
      renderCenter();
    });
    controls.append(filterSelect);

    const copy = el("button", "aw-btn aw-btn--ghost", "复制全部日志");
    copy.type = "button";
    copy.setAttribute("aria-label", "复制运行日志到剪贴板");
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(atlasLogAsText() || "（日志为空）");
        setStatus("日志已复制到剪贴板。", "ok");
      } catch {
        setStatus("复制被浏览器拦截，请手动选择文本复制。", "error");
      }
      renderCenter();
    });
    controls.append(copy);

    const clear = el("button", "aw-btn aw-btn--danger", "清空日志");
    clear.type = "button";
    clear.setAttribute("aria-label", "清空运行日志");
    clear.addEventListener("click", () => {
      atlasLogEntries.length = 0;
      logFilter = "all";
      renderCenter();
    });
    controls.append(clear);
    wrap.append(controls);

    const filtered = atlasLogEntries.filter((entry) => {
      if (logFilter === "all") return true;
      if (logFilter === "error") return entry.level === "error";
      return entry.tag === logFilter;
    });

    if (filtered.length === 0) {
      wrap.append(el("p", "aw-panel__text", atlasLogEntries.length === 0
        ? "暂无日志。跑一轮对话或点「加载模型列表」后，这里会记录每条推演请求的状态、耗时与响应开头（密钥已脱敏）。"
        : "当前筛选下没有日志条目。"));
      return wrap;
    }

    const list = el("div", "aw-log");
    for (const entry of [...filtered].reverse()) {
      const row = el("div", `aw-log__row${entry.level === "error" ? " is-error" : ""}`);
      row.append(
        el("span", "aw-log__time", entry.at.toLocaleTimeString()),
        el("span", "aw-log__tag", entry.tag),
        el("span", "aw-log__text", entry.text),
      );
      if (entry.detail) row.append(el("pre", "aw-log__detail", entry.detail));
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
      center.append(pageHeader("世界地图", "点击地点预览路线；左上可切换地区，右下可缩放。"));
      if (!ready) {
        center.append(emptyBox("绑定世界后可查看地图。"));
        return;
      }
      center.append(buildMap());
      return;
    }

    if (s.page === "nearby") {
      center.append(pageHeader("附近人物", "引擎按同地点 / 附近地点 / 同地区给出相关人物。"));
      if (!ready) {
        center.append(emptyBox("绑定世界后可查看附近人物。"));
        return;
      }
      const npcs = Array.isArray(d.npcDirectory) ? d.npcDirectory : [];
      if (npcs.length === 0) {
        center.append(emptyBox("附近没有相关人物。"));
      } else {
        const grid = el("div", "aw-cards");
        for (const npc of npcs) {
          const card = el("article", "aw-card aw-card--npc");
          card.append(el("h2", "aw-card__title", String(npc.name)));
          const reason = npc.reason ? (NPC_REASON_LABELS[String(npc.reason)] ?? String(npc.reason)) : "相关人物";
          card.append(el("span", "aw-tag", reason));
          const pointId = npc.pointId ?? npc.regionId;
          if (pointId) card.append(el("p", "aw-card__text", `位置：${String(pointId)}`));
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

    if (s.page === "logs") {
      center.append(pageHeader("运行日志", "最近 " + String(ATLAS_LOG_LIMIT) + " 条引擎与推演记录；报错红色高亮，可复制给作者排障。密钥自动脱敏。"));
      center.append(buildLogPage());
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // 地图
  // ---------------------------------------------------------------------------

  const viewport = el("div", "aw-viewport");
  const mapLayer = el("div", "aw-layer");
  const mapHint = el("div", "aw-maparea__hint");
  const zoomBox = el("div", "aw-zoom");
  const zoomLabel = el("span", "aw-zoom__label", "100%");
  const regionSelect = document.createElement("select");
  const mapTools = el("div", "aw-maptools");
  const travelBar = el("div", "aw-travel");
  const mapCanvas = el("div", "aw-maparea");
  let mapBuilt = false;
  let mapScaleEl = null;
  // 0.9.35 子图视图栈：空 = 世界图；每层 = {pointId, name}（点挂子图，递归）
  let mapStack = [];
  let mapStackKey = "";
  let mapCrumb = null;
  let mapPanel = null;
  let lastMapData = null;

  const applyTransform = () => {
    mapLayer.style.transform = `scale(${zoom}) translate(${panX}px, ${panY}px)`;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  };
  const setZoom = (next) => {
    zoom = clampZoom(next);
    if (zoom === 1) {
      panX = 0;
      panY = 0;
    }
    applyTransform();
  };

  function buildMap() {
    if (mapBuilt) return mapCanvas;
    mapBuilt = true;
    viewport.append(mapLayer);
    for (const corner of ["tl", "tr", "bl", "br"]) viewport.append(el("span", `aw-corner aw-corner--${corner}`));
    const compass = el("div", "aw-compass");
    compass.append(el("span", "aw-compass__n", "N"), el("i", "aw-compass__needle"));
    mapScaleEl = el("div", "aw-scale", "1 格 ≈ 一日路程");
    viewport.append(compass, mapScaleEl);
    for (const [label, delta, aria] of [["＋", 0.25, "放大地图"], ["－", -0.25, "缩小地图"], ["⌂", 0, "重置地图缩放"]]) {
      const btn = el("button", "aw-zoom__btn", label);
      btn.type = "button";
      btn.setAttribute("aria-label", aria);
      btn.addEventListener("click", () => setZoom(delta === 0 ? 1 : zoom + delta));
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
    mapTools.append(regionSelect, zoomBox);
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
        atlasLog("地图", `${label}完成：+${data.regionsAdded ?? 0} 地区 +${data.pointsAdded ?? 0} 地点（跳过 ${data.skipped ?? 0}）`);
        setStatus(`提炼完成：新增 ${data.regionsAdded ?? 0} 地区 / ${data.pointsAdded ?? 0} 地点${data.skipped ? `（重名跳过 ${data.skipped}）` : ""}。`, "ok");
        await core.refresh();
      } else {
        atlasLog("地图", `${label}失败 → ${result.body?.error?.message ?? `HTTP ${result.status}`}`);
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
    geoBar.append(el("span", "aw-hint", "地图随剧情生长：重名地点自动跳过，绝不删改已有地理。"));
    // 0.9.35 子图面包屑 + 标记点信息面板
    mapCrumb = el("div", "aw-mapcrumb");
    mapCrumb.style.display = "none";
    mapPanel = el("div", "aw-mappanel");
    mapPanel.style.display = "none";
    viewport.append(mapPanel);
    mapCanvas.append(mapCrumb, mapTools, viewport, mapHint, geoBar, travelBar);
    return mapCanvas;
  }

  /** 由 renderPage 在 renderCenter 之后调用（renderCenter 负责把 mapCanvas 挂回中区）。 */
  /** 0.9.35 返回上一层子图（世界图 = 栈空）。 */
  function popMapStack() {
    mapStack.pop();
    closeMapPanel();
    setZoom(1);
    renderMap(data());
  }

  function closeMapPanel() {
    if (mapPanel) {
      mapPanel.style.display = "none";
      mapPanel.innerHTML = "";
    }
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
    const trail = mapStack.map((item) => item.name).join(" › ");
    mapCrumb.append(back, el("span", "aw-mapcrumb__title", `当前：${trail} 内部`));
  }

  /** 0.9.35 标记点简略信息面板：名称 / 地区 / 描述 / 路线预览 / 进入子图。 */
  function openMapPanel(point, { inSub, currentSub }) {
    const d = lastMapData;
    if (!mapPanel || !d) return;
    mapPanel.innerHTML = "";
    const submaps = (d.map?.submaps ?? {});
    const pointMeta = (d.map?.pointMeta ?? {});
    const hasSub = !inSub && Boolean(submaps[String(point.id)]);
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
        setZoom(1);
        renderMap(data());
      });
      actions.append(enterBtn);
    }
    if (inSub) {
      actions.append(el("span", "aw-hint", "内部点位暂不接入旅行推算。"));
    }
    if (actions.childElementCount > 0) mapPanel.append(actions);
    mapPanel.style.display = "";
  }

  function renderMap(d) {
    if (!d.worldId) return;
    // 0.9.35 换聊天 / 换世界 → 子图视图栈立即作废（数据隔离，绝不让旧子图带进新卡）
    const viewKey = `${String(d.chatId ?? "")}|${String(d.worldId ?? "")}`;
    if (mapStackKey !== viewKey) {
      mapStack = [];
      mapStackKey = viewKey;
      closeMapPanel();
    }
    lastMapData = d;
    mapLayer.innerHTML = "";
    const mapData = d.map ?? {};
    const submaps = mapData.submaps && typeof mapData.submaps === "object" ? mapData.submaps : {};
    const pointMeta = mapData.pointMeta && typeof mapData.pointMeta === "object" ? mapData.pointMeta : {};
    // 0.9.35 子图视图：栈顶决定当前渲染哪张图（世界图或任意点挂子图，递归）
    const view = mapStack[mapStack.length - 1] ?? null;
    const currentSub = view ? submaps[String(view.pointId)] ?? null : null;
    const inSub = Boolean(currentSub);
    renderMapCrumb(d, view, currentSub);

    const pointsAll = Array.isArray(mapData.points) ? mapData.points : [];
    const points = inSub
      ? currentSub.points
      : regionFilter
        ? pointsAll.filter((p) => String(p.regionId ?? "") === regionFilter)
        : pointsAll;
    const npcsAll = inSub ? [] : Array.isArray(d.npcDirectory) ? d.npcDirectory : [];
    const npcs = inSub ? [] : regionFilter ? npcsAll.filter((n) => String(n.regionId ?? "") === regionFilter) : npcsAll;
    const objectsAll = inSub ? [] : Array.isArray(d.objectDirectory) ? d.objectDirectory : [];
    const objects = inSub ? [] : regionFilter ? objectsAll.filter((o) => String(o.regionId ?? "") === regionFilter) : objectsAll;
    if (regionSelect) regionSelect.style.display = inSub ? "none" : "";
    if (travelBar) travelBar.style.display = inSub ? "none" : "";

    const regions = Array.isArray(d.regions) ? d.regions : [];
    // 刻度尺：子图优先用自身比例尺；世界图沿用原口径（多于一个地点或地区才显示）
    if (mapScaleEl) {
      if (inSub) {
        const scale = currentSub.scale ?? null;
        mapScaleEl.textContent = scale
          ? `1 格 ≈ ${scale.distancePerCell}${scale.unit ? ` ${scale.unit}` : ""}`
          : "未标定（按格程计算）";
        mapScaleEl.style.display = "";
      } else {
        mapScaleEl.textContent = "1 格 ≈ 一日路程";
        mapScaleEl.style.display = pointsAll.length > 1 || regions.length > 1 ? "" : "none";
      }
    }
    // 0.9.20 空地理诚实提示；0.9.26 地图抢救后文案更新——单点地图不是渲染坏了，
    // 是世界里真的只有一个地点；提炼按钮（世界书 / 近期剧情）现在常显可随时生长地图
    if (mapHint) {
      const hasRealGeo = pointsAll.length > 1 || regions.length > 1;
      mapHint.textContent = hasRealGeo
        ? ""
        : "这个世界还没有地理数据：自动建世只创建「起点」。点下方「从世界书提炼地理」导入卡书里的地点；之后随着剧情推进，可用「从近期剧情提炼新地点」让地图继续生长。";
    }
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

    const bounds = computeMapBounds(points);
    const spanX = Math.max(1, bounds.maxX - bounds.minX);
    const spanY = Math.max(1, bounds.maxY - bounds.minY);
    const toPercent = (x, y) => ({
      left: `${((x - bounds.minX) / spanX) * 100}%`,
      top: `${((y - bounds.minY) / spanY) * 100}%`,
    });

    for (const point of points) {
      const marker = el("button", "aw-point");
      marker.type = "button";
      const hasSub = Boolean(inSub ? false : submaps[String(point.id)]);
      marker.textContent = String(point.name);
      marker.title = String(point.name);
      const pos = toPercent(Number(point.x), Number(point.y));
      marker.style.left = pos.left;
      marker.style.top = pos.top;
      if (hasSub) marker.classList.add("aw-point--sub");
      // 0.9.35 点击 = 简略信息面板（路线 / 进入子图都在面板里），不再一键直接拉路线
      if (String(point.id) === String(d.currentLocationId ?? "")) {
        marker.classList.add("is-current");
        marker.setAttribute("aria-label", `当前位置 ${point.name}，点击查看详情`);
      } else {
        marker.setAttribute("aria-label", `地点 ${point.name}，点击查看详情`);
      }
      marker.addEventListener("click", () => openMapPanel(point, { inSub, currentSub }));
      mapLayer.append(marker);
    }

    for (const npc of npcs) {
      if (npc.x === null || npc.y === null) continue;
      const dot = el("span", "aw-npc");
      const pos = toPercent(Number(npc.x), Number(npc.y));
      dot.style.left = pos.left;
      dot.style.top = pos.top;
      const reasonLabel = npc.reason ? (NPC_REASON_LABELS[String(npc.reason)] ?? String(npc.reason)) : "";
      dot.title = `${String(npc.name)}${reasonLabel ? `（${reasonLabel}）` : ""}`;
      dot.append(el("span", "aw-npc__name", String(npc.name)));
      mapLayer.append(dot);
    }

    for (const object of objects) {
      if (object.x === null || object.y === null) continue;
      const dot = el("span", "aw-object");
      const pos = toPercent(Number(object.x), Number(object.y));
      dot.style.left = pos.left;
      dot.style.top = pos.top;
      dot.title = `${String(object.name)}（${String(object.type)}）`;
      mapLayer.append(dot);
    }

    const preview = state().destinationPreview;
    // 0.9.35 子图视图跳过路线预览：世界图坐标塞进子图 bounds 的 toPercent 会画出错乱折线
    if (preview && !inSub) {
      const from = pointsAll.find((p) => String(p.id) === String(d.currentLocationId ?? ""));
      const to = pointsAll.find((p) => String(p.id) === String(preview.destinationId));
      if (from && to) {
        const a = toPercent(Number(from.x), Number(from.y));
        const b = toPercent(Number(to.x), Number(to.y));
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "aw-route");
        svg.setAttribute("viewBox", "0 0 100 100");
        svg.setAttribute("preserveAspectRatio", "none");
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        const x1 = parseFloat(a.left);
        const y1 = parseFloat(a.top);
        const x2 = parseFloat(b.left);
        const y2 = parseFloat(b.top);
        path.setAttribute("d", `M ${x1} ${y1} Q ${(x1 + x2) / 2} ${(y1 + y2) / 2 - 6} ${x2} ${y2}`);
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
      const worldId = String(d.worldId ?? "");
      if (!mapImageCache.has(worldId)) {
        mapImageCache.set(worldId, null);
        void api.request("GET", `/map/image/${encodeURIComponent(String(state().chatId))}`).then((result) => {
          const payload = result.body?.data?.dataUrl;
          mapImageCache.set(worldId, typeof payload === "string" ? payload : null);
          if (state().page === "map") renderMap(data());
        }).catch(() => mapImageCache.set(worldId, null));
      }
      const imageUrl = mapImageCache.get(worldId);
      if (imageUrl) {
        mapLayer.classList.add("has-image");
        mapLayer.style.backgroundImage = `url("${imageUrl}")`;
      }
    }

    applyTransform();

    travelBar.innerHTML = "";
    if (preview) {
      travelBar.append(el("span", "aw-travel__title", `前往：${preview.destinationName}`));
      travelBar.append(el("span", "aw-travel__meta", `距离 ${preview.distance} 格 · 预计 ${preview.estimatedDuration} 时段`));
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
        const worlds = await core.requestWorlds();
        settingsStatus = `已导入「${String(result.body.data?.name ?? result.body.data?.id ?? "")}」。`;
        settingsStatusKind = "ok";
        renderCenter();
        renderWorldList(worlds);
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
  let settingsStatus = "";
  let settingsStatusKind = "";

  const BUILTIN_PROMPT_ID = "builtin-default";

  function statusLine() {
    if (!settingsStatus) return null;
    return el("p", `aw-status${settingsStatusKind === "error" ? " aw-status--error" : ""}`, settingsStatus);
  }

  function setStatus(text, kind = "ok") {
    settingsStatus = text;
    settingsStatusKind = kind;
  }

  async function loadSettingsV2(force = false) {
    if (settingsV2 && !force) return settingsV2;
    const result = await api.request("GET", "/settings");
    if (result.status !== 200 || !result.body?.ok) {
      setStatus(`读取设置失败：${result.body?.error?.message ?? `HTTP ${result.status}`}`, "error");
      return settingsV2;
    }
    settingsV2 = result.body.data;
    apiLibrary = Array.isArray(settingsV2.apiPresets) ? settingsV2.apiPresets : [];
    promptLibrary = Array.isArray(settingsV2.promptPresets) ? settingsV2.promptPresets : [];
    return settingsV2;
  }

  async function sendSettingsCommand(command) {
    const result = await api.request("PUT", "/settings", command);
    if (result.status !== 200 || !result.body?.ok) {
      setStatus(`设置未保存：${result.body?.error?.message ?? `HTTP ${result.status}`}`, "error");
      return false;
    }
    settingsV2 = result.body.data;
    apiLibrary = Array.isArray(settingsV2.apiPresets) ? settingsV2.apiPresets : [];
    promptLibrary = Array.isArray(settingsV2.promptPresets) ? settingsV2.promptPresets : [];
    atlasLog("设置", `命令 ${command.action} → 成功（连接 ${apiLibrary.length} 条 / 提示词 ${promptLibrary.length} 条）`);
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

  function newPromptDraft() {
    return { id: null, name: "", systemPrompt: "", segments: [], contextTurnCount: 3 };
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
    promptSelect.addEventListener("change", () => {
      if (promptDraftDirty && !confirmDiscard("提示词")) {
        promptSelect.value = promptDraft?.id ?? (settingsV2?.activePromptPresetId ?? BUILTIN_PROMPT_ID);
        return;
      }
      const preset = promptLibrary.find((p) => p.id === promptSelect.value);
      promptDraft = preset
        ? {
            id: preset.id,
            name: preset.name,
            systemPrompt: preset.systemPrompt,
            segments: cloneSegments(preset.segments),
            contextTurnCount: Number.isFinite(preset.contextTurnCount) ? preset.contextTurnCount : 3,
          }
        : newPromptDraft();
      promptDraftDirty = false;
      setStatus("", "ok");
      // shujuku 语义：选中即设为当前使用（内置默认 = activate null）
      void sendSettingsCommand({ action: "prompt.activate", id: preset ? preset.id : null });
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
    selectField.append(selectRow);
    selectField.append(el("span", "aw-hint", "选中预设会立即设为当前使用并载入下方编辑器；「新建」开新草稿，「删除」删当前选中的预设。"));
    promptPanel.append(selectField);

    const isBuiltinDraft = !promptDraft?.id;
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

    // dirty 操作条（shujuku 式：未修改时「放弃修改 / 保存」禁用）
    const promptActions = el("div", "aw-actions");
    const discardButton = el("button", "aw-btn aw-btn--ghost", "放弃修改");
    discardButton.type = "button";
    discardButton.setAttribute("aria-label", "放弃未保存的提示词修改");
    discardButton.addEventListener("click", () => {
      const preset = promptLibrary.find((p) => p.id === promptDraft?.id);
      promptDraft = preset
        ? {
            id: preset.id,
            name: preset.name,
            systemPrompt: preset.systemPrompt,
            segments: cloneSegments(preset.segments),
            contextTurnCount: Number.isFinite(preset.contextTurnCount) ? preset.contextTurnCount : 3,
          }
        : newPromptDraft();
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
        const ok = await sendSettingsCommand({
          action: "prompt.save",
          preset: {
            name: "自定义提示词",
            systemPrompt: copiedSegments.length > 0 ? "" : String(settingsV2?.builtInPrompt?.systemPrompt ?? ""),
            ...(copiedSegments.length > 0 ? { segments: copiedSegments } : {}),
          },
        });
        if (ok) {
          const created = promptLibrary[promptLibrary.length - 1];
          promptDraft = created
            ? {
                id: created.id,
                name: created.name,
                systemPrompt: created.systemPrompt,
                segments: cloneSegments(created.segments),
              }
            : newPromptDraft();
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
        if (ok) { promptDraftDirty = false; setStatus(useSegments ? `栏位提示词已保存（${draftSegments.length} 段）。` : "提示词已保存。"); }
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
      const draftSegmentsForCopy = (Array.isArray(promptDraft?.segments) ? promptDraft.segments : [])
        .map((s) => ({ role: PROMPT_SEGMENT_ROLES.includes(s?.role) ? s.role : "system", content: String(s?.content ?? "").trim() }))
        .filter((s) => s.content.length > 0)
        .slice(0, 16);
      const useSegmentsForCopy = draftSegmentsForCopy.length > 0;
      const ok = await sendSettingsCommand({
        action: "prompt.save",
        preset: {
          name: name.trim(),
          systemPrompt: useSegmentsForCopy ? "" : (promptDraft?.systemPrompt || settingsV2?.builtInPrompt?.systemPrompt || ""),
          ...(useSegmentsForCopy ? { segments: draftSegmentsForCopy } : {}),
        },
      });
      if (ok) { promptDraftDirty = false; setStatus("已另存为新的提示词预设。"); }
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
      panel.append(appendField(textField("apiKey", "API 密钥", "password", 4096, active?.apiKey ? `已保存（尾号 ${String(active.apiKey).slice(-4)}），可直接修改` : "sk-…", "API 密钥"), "密钥保存在本浏览器的扩展设置里，载入预设时自动回填——加载模型与推演直接用它，不用每次重输。"));

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
        let probeSnippet = "";
        try {
          probeSnippet = redactSecrets(await probeResponse.clone().text()).replace(/\s+/g, " ").slice(0, 300);
        } catch { /* 片段读不到不影响判定 */ }
        atlasLog("推演", `POST /api/backends/chat-completions/generate（${apiFormatValue0} 真实探测） → ${endpoint} · 模型=${String(preset.model).trim()} → HTTP ${probeResponse.status}，${Date.now() - startedProbeAt}ms`, probeSnippet);
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
      let statusSnippet = "";
      try {
        statusSnippet = redactSecrets(await response.clone().text()).replace(/\s+/g, " ").slice(0, 300);
      } catch { /* 片段读不到不影响判定 */ }
      atlasLog("推演", `POST /api/backends/chat-completions/status → ${endpoint} · 模型列表 → HTTP ${response.status}，${Date.now() - startedStatusAt}ms`, statusSnippet);
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        let detail = errorText.slice(0, 200);
        try {
          const errorJson = JSON.parse(errorText);
          detail = String(errorJson.error ?? errorJson.message ?? detail);
        } catch { /* 保留原文 */ }
        setStatus(`加载模型失败（HTTP ${response.status}）：${detail || "无详情"}`, "error");
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
export function createLorebookPort(context, worldInfo) {
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
const atlasRuntime = { mod: null, api: null, core: null };

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
    for (const bookName of bookNames) {
      let rawEntries = [];
      try {
        const data = await worldInfo.loadWorldInfo(bookName);
        rawEntries = data && typeof data === "object" && data.entries && typeof data.entries === "object"
          ? Object.values(data.entries)
          : [];
      } catch {
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
    const text = lines.join("\n");
    loreSupplementCache = { bookName: cacheKey, at: Date.now(), text };
    return text;
  } catch {
    return ""; // 任何失败（书不存在 / API 不可用）都静默降级：无资料照常推演
  }
}

async function connectOnce() {
  try {
    const mod = await loadUiCore();

    /** 模型请求日志包装：记录每条推演 HTTP 的状态 / 耗时 / 响应片段（脱敏）。 */
    const loggingModelFetch = async (input, init) => {
      const startedAt = Date.now();
      const path = typeof input === "string" ? input : (input && typeof input.url === "string" ? input.url : String(input));
      // 从代理请求体提取「真实上游地址 + 模型名」（绝不含密钥字段）
      let target = "";
      try {
        const parsed = JSON.parse(init && typeof init.body === "string" ? init.body : "{}");
        if (parsed && typeof parsed === "object" && parsed.custom_url) {
          target = `${String(parsed.custom_url)} · 模型=${String(parsed.model ?? "?")}`;
        }
      } catch { /* 非代理载荷按原样记路径 */ }
      const label = target ? `${path} → ${target}` : path;
      try {
        const response = await globalThis.fetch(input, init);
        let snippet = "";
        try {
          snippet = redactSecrets(await response.clone().text());
        } catch { /* 片段读不到不影响请求本身 */ }
        atlasLog("推演", `POST ${label} → HTTP ${response.status}，${Date.now() - startedAt}ms`, snippet);
        return response;
      } catch (error) {
        atlasLog("推演", `POST ${label} → 网络失败，${Date.now() - startedAt}ms`, error instanceof Error ? error.message : String(error));
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
        let snippet = "";
        try {
          snippet = redactSecrets(await response.clone().text()).replace(/\s+/g, " ").slice(0, 200);
        } catch { /* 片段读不到不影响请求本身 */ }
        atlasLog("推演", `POST atlas://host（${mode === "main" ? "酒馆主API" : "酒馆连接预设"}） → HTTP ${response.status}，${Date.now() - startedAt}ms`, snippet);
        return response;
      } catch (error) {
        atlasLog("推演", `POST atlas://host（${mode === "main" ? "酒馆主API" : "酒馆连接预设"}） → 异常，${Date.now() - startedAt}ms`, error instanceof Error ? error.message : String(error));
        throw error;
      }
    };
    const engine = mod.createAtlasServerCore({
      store: engineStore,
      fetchFn: hostDispatchFetch,
    });
    // 引擎请求包装：每个 dispatch 记一条日志（方法 + 路径 + 结果码，绝不记请求体）
    const logApiCall = async (method, path, call) => {
      const startedAt = Date.now();
      try {
        const result = await call();
        const ok = result && typeof result === "object" && "ok" in result ? result.ok : undefined;
        const status = result && typeof result === "object" && "status" in result ? result.status : "";
        const errCode = result && typeof result === "object" && result.body?.ok === false ? result.body?.error?.code : null;
        atlasLog("引擎", `${method} ${path} → ${ok === false ? `失败（${errCode ?? "ERR"}）` : String(status) || "完成"}，${Date.now() - startedAt}ms`);
        // 0.9.20：200 信封里也可能装着失败回执——「校验失败」必须进日志页，
        // 否则作者只能看到一行 200，具体原因永远查无可查（2026-09-20 反馈）
        const receipt = result && typeof result === "object" ? result.body?.data?.receipt : null;
        if (receipt && receipt.status === "failed") {
          atlasLog("推演", `回合提交失败 → ${String(receipt.summary ?? "未知原因").slice(0, 300)}`);
        }
        return result;
      } catch (error) {
        atlasLog("引擎", `${method} ${path} → 异常，${Date.now() - startedAt}ms`, error instanceof Error ? error.message : String(error));
        throw error;
      }
    };
    const innerApi = mod.createLocalAtlasApi(engine);
    const api = {
      request: (method, path, body) => logApiCall(method, path, () => innerApi.request(method, path, body)),
    };
    atlasRuntime.mod = mod;
    atlasRuntime.api = api;

    // ATLAS-09 世界书注入层：条目规划由引擎在 commit 成功时给出，这里经酒馆
    // world-info 公开 API 落成 Atlas 专属世界书；模块不可用（旧版酒馆 / 预览无 stub）
    // → 跳过写入，只影响世界书，不影响推演与账本。
    let lorebookWriter = null;
    try {
      const worldInfo = await loadStWorldInfo();
      lorebookWriter = mod.createAtlasLorebookWriter(createLorebookPort(context, worldInfo));
    } catch (error) {
      console.warn("[atlas] 世界书模块不可用，推演结果不写世界书：", error instanceof Error ? error.message : String(error));
    }

    let rerender = () => {};
    const adaptEvent = createEventAdapter(context);
    /** 0.8.2 首条消息自动建世；core 由下方 const 赋值后回填（调用只发生在初始化完成之后）。 */
    let coreRef = null;
    const core = mod.createAtlasUiCore({
      api,
      host: createHost(context),
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
    rerender = renderPanel(core, root, mod.atlasClampZoom, api, engineStore, mod);
    installMenuButton(core);
    core.init();
    connected = { core, rerender };
    return connected;
  } catch (error) {
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
