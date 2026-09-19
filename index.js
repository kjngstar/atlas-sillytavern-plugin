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

export const ATLAS_EXTENSION_VERSION = "0.7.5";
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
    GENERATION_ENDED: ["GENERATION_ENDED_AFTER_COMMANDS", "GENERATION_ENDED"],
    GENERATION_STOPPED: ["GENERATION_STOPPED"],
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
    // 官方四参数契约：chat（不改动）、contextSize / type（不使用）、abort（绝不调用）。
    // 注入通道是 setExtensionPrompt 临时上下文，而非修改 chat 数组（不污染可见历史）。
    void chat;
    void contextSize;
    void abort;
    void type;
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

/** 安装到 globalThis（manifest generate_interceptor 按名字查找）。 */
function installGenerateInterceptor(core) {
  window[ATLAS_INTERCEPTOR_GLOBAL] = createGenerateInterceptor(core);
}

// ---------------------------------------------------------------------------
// 面板 DOM（五页；地图 = 查看 / 定位 / 目的地预览）
// ---------------------------------------------------------------------------

const PAGES = [
  { id: "overview", label: "概览" },
  { id: "map", label: "地图" },
  { id: "nearby", label: "附近" },
  { id: "changes", label: "变化" },
  { id: "api", label: "API" },
  { id: "settings", label: "设置" },
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
  let settingsSlot = "worldTurn";
  let modelOptions = [];
  let apiFormStatus = "";
  let apiFormStatusKind = "";

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

  const PAGE_ICONS = { overview: "◈", map: "▣", nearby: "◉", changes: "≋", settings: "✳" };
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
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
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

  function renderCenter(d = data()) {
    center.innerHTML = "";
    const s = state();
    const ready = Boolean(d.worldId);

    if (s.page === "overview") {
      center.append(pageHeader(String(d.worldName ?? "世界概览"), ready ? "世界状态一览；左栏是写入世界书的动向，右侧是最近变化。" : undefined));
      if (!ready) {
        center.append(emptyBox(s.modeHint ?? "尚未绑定世界——前往「设置」页选择或导入世界。"));
        return;
      }
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
      center.append(buildLorebookPanel());
      return;
    }

    if (s.page === "api") {
      center.append(pageHeader("API", "推演 API 预设管理（shujuku 式）：在这里配置好，其余页面直接使用。密钥只保存在浏览器侧，经酒馆后端代理转发。"));
      if (s.lastError) center.append(el("div", "aw-note aw-note--error", s.lastError));
      center.append(buildApiPanel());
      return;
    }

    if (s.page === "settings") {
      center.append(pageHeader("设置", "世界绑定与导入。每个聊天各自记住自己的世界，切聊天自动跟随。"));
      if (s.modeHint && !ready) center.append(el("div", "aw-note", s.modeHint));
      if (s.lastError) center.append(el("div", "aw-note aw-note--error", s.lastError));
      center.append(buildBindingPanel(s));
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

  function buildBindingPanel(s) {
    const panel = el("section", "aw-panel");
    panel.append(el("span", "aw-eyebrow", "世界绑定"));
    const actions = el("div", "aw-actions");
    if (s.mode === "ready" || s.mode === "world-missing") {
      const disable = el("button", "aw-btn", s.binding?.enabled ? "停用本聊天推演" : "启用本聊天推演");
      disable.type = "button";
      disable.setAttribute("aria-label", "启用或停用本聊天的 Atlas 推演");
      disable.addEventListener("click", () => void core.setEnabled(!s.binding?.enabled));
      const unbind = el("button", "aw-btn aw-btn--danger", "解绑世界");
      unbind.type = "button";
      unbind.setAttribute("aria-label", "解绑当前聊天的 Atlas 世界");
      unbind.addEventListener("click", () => void core.unbind());
      actions.append(disable, unbind);
    } else {
      const demo = el("button", "aw-btn aw-btn--primary", "一键创建演示世界并绑定");
      demo.type = "button";
      demo.setAttribute("aria-label", "创建演示世界并绑定到当前聊天");
      demo.addEventListener("click", async () => {
        demo.disabled = true;
        try {
          const world = mod.buildWorldFromTemplate(mod.DEMO_TEMPLATES[0], {
            id: `world-${Date.now()}`,
            now: Date.now(),
          });
          const result = await api.request("POST", "/worlds/import", { world });
          if (result.status !== 200 || !result.body?.ok) {
            apiFormStatus = `演示世界创建被拒绝：${result.body?.error?.message ?? `HTTP ${result.status}`}`;
            apiFormStatusKind = "error";
            core.__renderPage?.();
            return;
          }
          await core.bindToWorld(String(world.id));
          core.setPage("overview");
          core.__renderPage?.();
        } catch (error) {
          apiFormStatus = `演示世界创建失败：${error instanceof Error ? error.message : String(error)}`;
          apiFormStatusKind = "error";
          core.__renderPage?.();
        } finally {
          demo.disabled = false;
        }
      });
      actions.append(demo);
      const list = el("button", "aw-btn", "读取可绑定世界列表");
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
            apiFormStatus = `世界导入被拒绝：${result.body?.error?.message ?? `HTTP ${result.status}`}`;
            apiFormStatusKind = "error";
            renderCenter();
            return;
          }
          const worlds = await core.requestWorlds();
          apiFormStatus = `已导入「${String(result.body.data?.name ?? result.body.data?.id ?? "")}」。`;
          apiFormStatusKind = "ok";
          renderCenter();
          renderWorldList(worlds);
        } catch (error) {
          apiFormStatus = `世界导入失败：${error instanceof Error ? error.message : String(error)}`;
          apiFormStatusKind = "error";
          renderCenter();
        }
      });
      importLabel.append(file);
      actions.append(importLabel);
    }
    panel.append(actions);
    return panel;
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

  function buildApiPanel() {
    const panel = el("section", "aw-panel");
    panel.append(el("span", "aw-eyebrow", "推演 API · 预设"));
    panel.append(el(
      "p",
      "aw-panel__meta",
      "密钥只存在浏览器侧（extensionSettings），请求经酒馆后端代理转发，服务端不预存。预设分「世界推演」与「重大事件」两个槽。",
    ));

    const slots = el("div", "aw-actions");
    for (const [slotId, label] of [["worldTurn", "世界推演"], ["majorEvent", "重大事件"]]) {
      const btn = el("button", `aw-btn aw-btn--ghost${settingsSlot === slotId ? " is-active" : ""}`, label);
      btn.type = "button";
      btn.setAttribute("aria-label", `编辑${label}预设`);
      btn.addEventListener("click", async () => {
        settingsSlot = slotId;
        modelOptions = [];
        apiFormStatus = "";
        await loadPresetIntoForm();
        renderCenter();
      });
      slots.append(btn);
    }
    panel.append(slots);

    const form = el("form", "aw-form");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void savePreset();
    });

    const field = (label, node, hint) => {
      const row = el("label", "aw-field");
      row.append(el("span", "aw-field__label", label));
      row.append(node);
      if (hint) row.append(el("span", "aw-field__hint", hint));
      return row;
    };

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "aw-input";
    nameInput.value = formState.name ?? "";
    nameInput.placeholder = "例如：主力推演";
    nameInput.addEventListener("input", () => { formState.name = nameInput.value; });

    const endpointInput = document.createElement("input");
    endpointInput.type = "text";
    endpointInput.className = "aw-input";
    endpointInput.value = formState.endpoint ?? "";
    endpointInput.placeholder = "https://example.com/v1/chat/completions";
    endpointInput.addEventListener("input", () => { formState.endpoint = endpointInput.value; });

    const keyInput = document.createElement("input");
    keyInput.type = "password";
    keyInput.className = "aw-input";
    keyInput.value = formState.apiKey ?? "";
    keyInput.autocomplete = "off";
    keyInput.placeholder = formState.keyTail ? `已保存（尾号 ${formState.keyTail}），留空则不变` : "sk-...";
    keyInput.addEventListener("input", () => { formState.apiKey = keyInput.value; });

    const modelInput = document.createElement("input");
    modelInput.type = "text";
    modelInput.className = "aw-input";
    modelInput.value = formState.model ?? "";
    modelInput.placeholder = "模型名";
    modelInput.addEventListener("input", () => { formState.model = modelInput.value; });

    const maxTokensInput = document.createElement("input");
    maxTokensInput.type = "number";
    maxTokensInput.min = "1";
    maxTokensInput.max = "8192";
    maxTokensInput.className = "aw-input";
    maxTokensInput.value = String(formState.maxTokens ?? 512);
    maxTokensInput.addEventListener("input", () => { formState.maxTokens = Number(maxTokensInput.value); });

    const temperatureInput = document.createElement("input");
    temperatureInput.type = "number";
    temperatureInput.min = "0";
    temperatureInput.max = "2";
    temperatureInput.step = "0.05";
    temperatureInput.className = "aw-input";
    temperatureInput.value = String(formState.temperature ?? 0.7);
    temperatureInput.addEventListener("input", () => { formState.temperature = Number(temperatureInput.value); });

    form.append(field("预设名称", nameInput));
    form.append(field("端点（chat/completions 地址）", endpointInput));
    form.append(field("API 密钥", keyInput));
    form.append(field("模型名", modelInput));

    const modelRow = el("div", "aw-field");
    modelRow.append(el("span", "aw-field__label", "模型列表"));
    const modelSelect = document.createElement("select");
    modelSelect.className = "aw-input";
    modelSelect.setAttribute("aria-label", "从已加载的模型列表中选择");
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = modelOptions.length === 0 ? "未加载——点击「加载模型」" : "请选择";
    modelSelect.append(placeholder);
    for (const option of modelOptions) {
      const opt = document.createElement("option");
      opt.value = option;
      opt.textContent = option;
      if (option === formState.model) opt.selected = true;
      modelSelect.append(opt);
    }
    modelSelect.addEventListener("change", () => {
      formState.model = modelSelect.value;
      modelInput.value = modelSelect.value;
    });
    modelRow.append(modelSelect);

    const loadBtn = el("button", "aw-btn aw-btn--ghost", "加载模型");
    loadBtn.type = "button";
    loadBtn.setAttribute("aria-label", "通过酒馆后端代理加载该端点的模型列表");
    loadBtn.addEventListener("click", () => void loadModels());
    modelRow.append(loadBtn);
    form.append(modelRow);

    const paramRow = el("div", "aw-form__row");
    paramRow.append(field("最大回复长度", maxTokensInput), field("温度", temperatureInput));
    form.append(paramRow);

    const actions = el("div", "aw-actions");
    const save = el("button", "aw-btn aw-btn--primary", "保存预设");
    save.type = "submit";
    save.setAttribute("aria-label", "保存当前预设");
    const clear = el("button", "aw-btn aw-btn--danger", "清空该槽");
    clear.type = "button";
    clear.setAttribute("aria-label", "清空当前预设槽");
    clear.addEventListener("click", () => void savePreset({ clear: true }));
    actions.append(save, clear);
    form.append(actions);

    if (apiFormStatus) {
      form.append(el("p", `aw-form__status is-${apiFormStatusKind || "ok"}`, apiFormStatus));
    }

    panel.append(form);
    return panel;
  }

  // 表单态：从浏览器存储的 settings 文档读取真实值（含密钥），仅内存持有
  const formState = { name: "", endpoint: "", apiKey: "", model: "", maxTokens: 512, temperature: 0.7, keyTail: null };

  async function loadPresetIntoForm() {
    formState.name = "";
    formState.endpoint = "";
    formState.apiKey = "";
    formState.model = "";
    formState.keyTail = null;
    if (!store) return;
    const raw = await store.read("settings");
    const preset = raw && typeof raw === "object" ? raw[settingsSlot] : null;
    if (preset && typeof preset === "object") {
      formState.name = String(preset.name ?? "");
      formState.endpoint = String(preset.endpoint ?? "");
      formState.model = String(preset.model ?? "");
      formState.maxTokens = typeof preset.maxTokens === "number" ? preset.maxTokens : 512;
      formState.temperature = typeof preset.temperature === "number" ? preset.temperature : 0.7;
      const key = typeof preset.apiKey === "string" ? preset.apiKey.trim() : "";
      formState.apiKey = key;
      formState.keyTail = key.length >= 4 ? key.slice(-4) : null;
    }
  }

  async function savePreset(options = {}) {
    if (options.clear) {
      const result = await api.request("PUT", "/settings", { [settingsSlot]: null });
      apiFormStatus = result.status === 200 ? "已清空该槽。" : `清空被拒绝：${result.body?.error?.message ?? `HTTP ${result.status}`}`;
      apiFormStatusKind = result.status === 200 ? "ok" : "error";
      await loadPresetIntoForm();
      renderCenter();
      return;
    }
    const preset = {
      name: (formState.name || settingsSlot).trim().slice(0, 64),
      endpoint: (formState.endpoint || "").trim(),
      model: (formState.model || "").trim(),
      apiKey: (formState.apiKey || "").trim(),
      maxTokens: Number.isFinite(formState.maxTokens) ? formState.maxTokens : 512,
      temperature: Number.isFinite(formState.temperature) ? formState.temperature : 0.7,
    };
    const result = await api.request("PUT", "/settings", { [settingsSlot]: preset });
    if (result.status === 200) {
      apiFormStatus = "预设已保存。密钥只存在浏览器侧，不会出现在日志里。";
      apiFormStatusKind = "ok";
      await loadPresetIntoForm();
    } else {
      apiFormStatus = `保存被拒绝：${result.body?.error?.message ?? `HTTP ${result.status}`}`;
      apiFormStatusKind = "error";
    }
    renderCenter();
  }

  /** 通过酒馆后端代理拉取模型列表（custom source；与推演请求同一转发通道）。 */
  async function loadModels() {
    const endpoint = (formState.endpoint || "").trim();
    if (!endpoint) {
      apiFormStatus = "请先填写端点，再加载模型。";
      apiFormStatusKind = "error";
      renderCenter();
      return;
    }
    apiFormStatus = "正在通过酒馆后端代理加载模型列表…";
    apiFormStatusKind = "";
    renderCenter();
    try {
      const ctx = SillyTavern.getContext();
      const headers = { "Content-Type": "application/json" };
      if (typeof ctx.getRequestHeaders === "function") Object.assign(headers, ctx.getRequestHeaders());
      const response = await fetch("/api/backends/chat-completions/status", {
        method: "POST",
        headers,
        body: JSON.stringify({
          chat_completion_source: "custom",
          custom_url: endpoint,
          ...(formState.apiKey ? { custom_include_headers: { Authorization: `Bearer ${formState.apiKey}` } } : {}),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      const raw = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
      modelOptions = raw
        .map((item) => (typeof item === "string" ? item : item && typeof item === "object" ? item.id : null))
        .filter((item) => typeof item === "string" && item.length > 0)
        .slice(0, 500);
      if (modelOptions.length === 0) {
        apiFormStatus = "未取到模型列表（端点可能不支持 /models，可直接手填模型名）。";
        apiFormStatusKind = "error";
      } else {
        apiFormStatus = `已加载 ${String(modelOptions.length)} 个模型。`;
        apiFormStatusKind = "ok";
      }
    } catch (error) {
      apiFormStatus = `加载模型失败：${error instanceof Error ? error.message : String(error)}`;
      apiFormStatusKind = "error";
    }
    renderCenter();
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

  void loadPresetIntoForm().then(() => {
    if (state().page === "settings") renderCenter();
  });

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

async function connectOnce() {
  try {
    const mod = await loadUiCore();
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
      fetchFn: mod.createStProxyFetch({ getContext: context }),
    });
    const api = mod.createLocalAtlasApi(engine);

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
    const core = mod.createAtlasUiCore({
      api,
      host: createHost(context),
      emitter: createEmitter(context),
      adaptEvent,
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
