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

export const ATLAS_EXTENSION_VERSION = "0.9.11";
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
      const value = context().chatId;
      return value === undefined || value === null ? null : String(value);
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
      const title = receipt.summary
        ? receipt.summary.split(/[。！?\n]/)[0].slice(0, 22)
        : `世界推进 · 第 ${String(receipt.previousTime)} → ${String(receipt.currentTime)} 时段`;
      card.append(el("div", "aw-move__title", title));
      if (receipt.summary && receipt.summary.length > title.length) {
        card.append(el("div", "aw-move__text", receipt.summary.slice(0, 70)));
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
        "还没有世界书条目——每轮世界推进后，「NPC 动向」与「近期可触发」会自动写入当前角色卡的世界书（角色卡没有世界书时写入 Atlas 专属世界书），主模型经酒馆正常激活管线就能看到。",
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
    viewport.append(compass, el("div", "aw-scale", "1 格 ≈ 一日路程"));
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
    mapCanvas.append(mapTools, viewport, mapHint, travelBar);
    return mapCanvas;
  }

  /** 由 renderPage 在 renderCenter 之后调用（renderCenter 负责把 mapCanvas 挂回中区）。 */
  function renderMap(d) {
    if (!d.worldId) return;
    mapLayer.innerHTML = "";
    const mapData = d.map ?? {};
    const pointsAll = Array.isArray(mapData.points) ? mapData.points : [];
    const points = regionFilter ? pointsAll.filter((p) => String(p.regionId ?? "") === regionFilter) : pointsAll;
    const npcsAll = Array.isArray(d.npcDirectory) ? d.npcDirectory : [];
    const npcs = regionFilter ? npcsAll.filter((n) => String(n.regionId ?? "") === regionFilter) : npcsAll;
    const objectsAll = Array.isArray(d.objectDirectory) ? d.objectDirectory : [];
    const objects = regionFilter ? objectsAll.filter((o) => String(o.regionId ?? "") === regionFilter) : objectsAll;

    const regions = Array.isArray(d.regions) ? d.regions : [];
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
      marker.textContent = String(point.name);
      marker.title = String(point.name);
      const pos = toPercent(Number(point.x), Number(point.y));
      marker.style.left = pos.left;
      marker.style.top = pos.top;
      if (String(point.id) === String(d.currentLocationId ?? "")) {
        marker.classList.add("is-current");
        marker.setAttribute("aria-label", `当前位置 ${point.name}`);
      } else {
        marker.setAttribute("aria-label", `地点 ${point.name}，点击预览前往路线`);
        marker.addEventListener("click", () => void core.selectDestination(String(point.id)));
      }
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
    if (preview) {
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
  let apiKeyInput = "";
  let apiKeyClear = false;
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
      endpoint: "",
      model: "",
      maxTokens: 1024,
      temperature: 0.7,
      timeoutMs: 30_000,
      apiFormat: "openai",
    };
  }

  function newPromptDraft() {
    return { id: null, name: "", systemPrompt: "" };
  }

  function activePromptText() {
    if (!settingsV2) return "";
    const active = promptLibrary.find((p) => p.id === settingsV2.activePromptPresetId);
    if (active) return String(active.systemPrompt ?? "");
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
    runtimeActions.append(toggle, autoCommit, gotoApi);
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
      option.textContent = preset.name;
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
        ? { id: preset.id, name: preset.name, systemPrompt: preset.systemPrompt }
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
      : "留空 = 使用内置默认；用户行动、助手回复与世界上下文由系统自动组装，不在这里编辑。"));
    promptPanel.append(bodyField);

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
        ? { id: preset.id, name: preset.name, systemPrompt: preset.systemPrompt }
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
        const ok = await sendSettingsCommand({
          action: "prompt.save",
          preset: { name: "自定义提示词", systemPrompt: String(settingsV2?.builtInPrompt?.systemPrompt ?? "") },
        });
        if (ok) {
          const created = promptLibrary[promptLibrary.length - 1];
          promptDraft = created
            ? { id: created.id, name: created.name, systemPrompt: created.systemPrompt }
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
        if (!promptDraft?.name.trim() || !promptDraft.systemPrompt.trim()) {
          setStatus("提示词名称与正文都不能为空。", "error");
          renderCenter();
          return;
        }
        const ok = await sendSettingsCommand({
          action: "prompt.save",
          preset: { id: promptDraft.id, name: promptDraft.name, systemPrompt: promptDraft.systemPrompt },
        });
        if (ok) { promptDraftDirty = false; setStatus("提示词已保存。"); }
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
      const ok = await sendSettingsCommand({
        action: "prompt.save",
        preset: { name: name.trim(), systemPrompt: promptDraft?.systemPrompt || settingsV2?.builtInPrompt?.systemPrompt || "" },
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
    panel.append(el("p", "aw-panel__text", "管理 Atlas 推演用的 API 连接：协议、密钥与模型都在这里；提示词请到「推进」页。"));
    const active = apiLibrary.find((p) => p.id === settingsV2?.activeApiPresetId);
    panel.append(el("p", "aw-panel__meta", `当前使用：${activeApiLabel()}${active ? ` · 模型 ${active.model} · 密钥${active.apiKey?.exists ? `已保存（尾号 ${active.apiKey.tail ?? "----"}）` : "未设置"}` : ""}`));
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
      option.textContent = `${preset.name}（${preset.model}）`;
      libSelect.append(option);
    }
    libSelect.value = apiDraft?.id ?? "";
    libSelect.addEventListener("change", () => {
      if (apiDraftDirty && !confirmDiscard("API 连接")) {
        libSelect.value = apiDraft?.id ?? "";
        return;
      }
      const preset = apiLibrary.find((p) => p.id === libSelect.value);
      apiDraft = preset
        ? { id: preset.id, name: preset.name, endpoint: preset.endpoint, model: preset.model, maxTokens: preset.maxTokens, temperature: preset.temperature, timeoutMs: preset.timeoutMs, apiFormat: preset.apiFormat === "claude" ? "claude" : "openai" }
        : newApiDraft();
      apiDraftDirty = false;
      apiKeyInput = "";
      apiKeyClear = false;
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
      apiKeyClear = false;
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

    // ---- 编辑器（shujuku 式：名称 → 协议 → 端点/密钥 → 模型 → 参数 → dirty 操作条） ----
    const draft = apiDraft ?? newApiDraft();
    const textField = (key, label, type, maxLength, placeholder, aria) => ({ key, label, type, maxLength, placeholder, aria });
    const numberField = (key, label, min, max, step, aria) => ({ key, label, type: "number", min, max, step, aria });
    const inputs = {};
    let apiSaveButton = null;
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
        // 密钥框始终为空：已保存的密钥不回填 DOM（规格 0.7.2）
        input.value = apiKeyInput;
        input.addEventListener("input", () => {
          apiKeyInput = input.value;
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
          // 覆盖式保存必须始终明示目标（防改完名点保存静默覆盖别的连接）
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

    panel.append(appendField(textField("name", "连接名称", "text", 64, "例如：MiniMax 订阅", "连接名称")));

    // 接口协议（0.9.11，shujuku 同款字段）
    const formatField = el("div", "aw-field");
    formatField.append(el("span", "aw-field__label", "接口协议"));
    const formatSelect = document.createElement("select");
    formatSelect.className = "aw-input";
    formatSelect.setAttribute("aria-label", "选择接口协议");
    const formatOptions = [
      { value: "openai", label: "OpenAI 兼容（/chat/completions，默认）" },
      { value: "claude", label: "Claude / Anthropic Messages（MiniMax 订阅、Claude 代理）" },
    ];
    for (const opt of formatOptions) {
      const option = document.createElement("option");
      option.value = opt.value;
      option.textContent = opt.label;
      formatSelect.append(option);
    }
    formatSelect.value = draft.apiFormat === "claude" ? "claude" : "openai";
    formatSelect.addEventListener("change", () => {
      draft.apiFormat = formatSelect.value === "claude" ? "claude" : "openai";
      apiDraft = draft;
      apiDraftDirty = true;
      if (syncApiDirty) syncApiDirty();
    });
    formatField.append(formatSelect);
    formatField.append(el("span", "aw-hint", "OpenAI 兼容 = 标准 /chat/completions（绝大多数中转站）；Claude（Anthropic Messages）= MiniMax Token Plan 订阅密钥（sk-cp-）、Claude 官方与中转代理——端点填协议根（如 https://api.minimaxi.com/anthropic），Atlas 自动补 /v1。"));
    panel.append(formatField);

    panel.append(appendField(textField("endpoint", "端点（http(s) 绝对地址）", "text", 2048, "http://localhost:8317/v1", "API 端点"), "Claude 协议填协议根即可，OpenAI 协议填到 /v1（Atlas 会自动补 /chat/completions）。"));
    panel.append(appendField(textField("apiKey", "API 密钥（留空保持已保存的密钥）", "password", 4096, active?.apiKey?.exists ? `已保存（尾号 ${active.apiKey.tail ?? "----"}），留空保持不变` : "未设置", "API 密钥"), "密钥只保存在浏览器侧，经酒馆后端代理转发，服务端不预存；GET 只返回是否存在与尾号。"));

    // shujuku 式：独立的「加载模型列表」按钮紧跟密钥；模型下拉仅在加载到时出现
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
    grid.append(appendField(numberField("maxTokens", "最大回复长度", 1, 8192, 1, "最大回复长度")));
    grid.append(appendField(numberField("temperature", "温度", 0, 2, 0.1, "温度")));
    panel.append(grid);
    panel.append(appendField(numberField("timeoutMs", "超时毫秒", 1000, 120000, 1000, "超时毫秒")));

    const clearKeyRow = el("label", "aw-check");
    const clearKey = document.createElement("input");
    clearKey.type = "checkbox";
    clearKey.checked = apiKeyClear;
    clearKey.setAttribute("aria-label", "保存时清除已保存的密钥");
    clearKey.addEventListener("change", () => {
      apiKeyClear = clearKey.checked;
      apiDraftDirty = true;
      if (syncApiDirty) syncApiDirty();
    });
    clearKeyRow.append(clearKey, el("span", null, "保存时清除已保存的密钥"));
    panel.append(clearKeyRow);

    // dirty 操作条（shujuku 式：未修改时「放弃修改 / 保存」禁用；保存后自动设为当前使用）
    const actions = el("div", "aw-actions");
    const apiDiscardButton = el("button", "aw-btn aw-btn--ghost", "放弃修改");
    apiDiscardButton.type = "button";
    apiDiscardButton.setAttribute("aria-label", "放弃未保存的 API 连接修改");
    apiDiscardButton.addEventListener("click", () => {
      const preset = apiLibrary.find((p) => p.id === apiDraft?.id);
      apiDraft = preset
        ? { id: preset.id, name: preset.name, endpoint: preset.endpoint, model: preset.model, maxTokens: preset.maxTokens, temperature: preset.temperature, timeoutMs: preset.timeoutMs, apiFormat: preset.apiFormat === "claude" ? "claude" : "openai" }
        : newApiDraft();
      apiDraftDirty = false;
      apiKeyInput = "";
      apiKeyClear = false;
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
      if (!preset.name.trim() || !preset.endpoint.trim() || !preset.model.trim()) {
        setStatus("连接名称、端点与模型名都不能为空。", "error");
        renderCenter();
        return;
      }
      const apiKeyMode = apiKeyClear ? "clear" : (apiKeyInput ? "replace" : (preset.id ? "keep" : "replace"));
      const ok = await sendSettingsCommand({
        action: "api.save",
        preset: {
          ...(preset.id ? { id: preset.id } : {}),
          name: preset.name,
          endpoint: preset.endpoint,
          model: preset.model,
          maxTokens: Number(preset.maxTokens) || 1024,
          temperature: Number.isFinite(Number(preset.temperature)) ? Number(preset.temperature) : 0.7,
          timeoutMs: Number(preset.timeoutMs) || 30_000,
          apiFormat: preset.apiFormat === "claude" ? "claude" : "openai",
        },
        apiKeyMode,
        ...(apiKeyMode === "replace" ? { apiKey: apiKeyInput } : {}),
      });
      if (ok) {
        const saved = apiLibrary.find((p) => p.name === preset.name.trim()) ?? apiLibrary[apiLibrary.length - 1];
        apiDraft = saved
          ? { id: saved.id, name: saved.name, endpoint: saved.endpoint, model: saved.model, maxTokens: saved.maxTokens, temperature: saved.temperature, timeoutMs: saved.timeoutMs, apiFormat: saved.apiFormat === "claude" ? "claude" : "openai" }
          : apiDraft;
        apiDraftDirty = false;
        apiKeyInput = "";
        apiKeyClear = false;
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
      const ok = await sendSettingsCommand({
        action: "api.save",
        preset: {
          name: name.trim(),
          endpoint: preset.endpoint,
          model: preset.model,
          maxTokens: Number(preset.maxTokens) || 1024,
          temperature: Number.isFinite(Number(preset.temperature)) ? Number(preset.temperature) : 0.7,
          timeoutMs: Number(preset.timeoutMs) || 30_000,
          apiFormat: preset.apiFormat === "claude" ? "claude" : "openai",
        },
        apiKeyMode: "replace",
        apiKey: apiKeyInput,
      });
      if (ok) {
        apiDraftDirty = false;
        apiKeyInput = "";
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

  /** 测试连接：只走模型列表 / 最小鉴权检查，不 commit、不写世界、不写聊天。 */
  async function testConnection(preset) {
    const endpoint = String(preset.endpoint || "").trim();
    if (!endpoint) {
      setStatus("请先填写端点，再加载模型。", "error");
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
      // 0.9.11：claude 协议 → chat_completion_source:"claude" + reverse_proxy（基址补 /v1）+ proxy_password
      const { atlasCustomIncludeHeaders, normalizeAtlasClaudeBase } = await loadUiCore();
      const keyValue = apiKeyInput ? `Bearer ${apiKeyInput}` : "";
      const isClaude = (apiDraft?.apiFormat ?? preset.apiFormat) === "claude" || preset.apiFormat === "claude";
      const claudeBase = isClaude ? normalizeAtlasClaudeBase(endpoint) : null;
      const response = await fetch("/api/backends/chat-completions/status", {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...(claudeBase
            ? { chat_completion_source: "claude", reverse_proxy: claudeBase, proxy_password: apiKeyInput || "" }
            : { chat_completion_source: "custom", reverse_proxy: endpoint, proxy_password: "" }),
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
      entry.constant = false;
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
    const engine = mod.createAtlasServerCore({
      store: engineStore,
      fetchFn: mod.createStProxyFetch({ getContext: context, fetchFn: loggingModelFetch }),
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
