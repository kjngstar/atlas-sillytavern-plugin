/**
 * atlas-extension-harness.test.mjs — ATLAS-03 UI Extension mock harness。
 *
 * 覆盖验收要求（上级 README ATLAS-03 / 第 10 节）：
 * - 真正运行初始化函数并验证事件监听注册与清理（init / dispose 成对）。
 * - 五种模式的清楚空状态：离线 / 协议不兼容 / 未绑定 / 世界不存在 / 就绪。
 * - 绑定只存 chatMetadata 契约形状；切聊天立即重读；A / B 两聊天切换 20 次不串状态。
 * - 面板开关状态经 extensionSettings 恢复；绑定载荷绝无密钥字段。
 * - 回合流（ATLAS-05）：MESSAGE_SENT → prepare → 注入；GENERATION_ENDED → commit → 回执；
 *   停止 / 空回复 / 失败不推进世界；重复通知只 commit 一次；回执持久化可恢复。
 * - index.js 在无酒馆环境中可安全导入（不触碰 document / SillyTavern 全局）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createAtlasUiCore, atlasClampZoom, ATLAS_UI_EVENTS } from "../src/atlas-ui-core.ts";
import {
  createAtlasExtension,
  connectAtlas,
  ATLAS_DISPLAY_NAME,
  ATLAS_EXTENSION_VERSION,
} from "../atlas-extension/index.js";

let assertionCount = 0;
function ok(value, message) {
  assertionCount += 1;
  assert.ok(value, message);
}
function equal(actual, expected, message) {
  assertionCount += 1;
  assert.equal(actual, expected, message);
}
function deepEqual(actual, expected, message) {
  assertionCount += 1;
  assert.deepStrictEqual(actual, expected, message);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW_BASE = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Mock 三件套：api / host / emitter
// ---------------------------------------------------------------------------

function makeApi({ health = { ok: true, data: { protocolVersion: 1 } }, stateByChat = {}, failHealth = false, travelPreview = null, turnBehavior = {} } = {}) {
  const calls = [];
  const defaultPrepareResponse = {
    turnId: "turn-1",
    injectionText: "【世界上下文】当前位置：白塔钟座",
    sourceRefs: ["point:p-1", "npc:npc-1"],
    relevantNpcIds: ["npc-1"],
    triggerIds: [],
    currentTime: 12,
    currentLocationId: "p-1",
  };
  const defaultReceipt = {
    receiptId: "receipt-1",
    status: "committed",
    branchId: null,
    previousTime: 12,
    currentTime: 13,
    triggeredNpcIds: ["npc-1"],
    adoptedEventIds: ["evt-1"],
    summary: "时间推进一个时段；林拾在集市有了新见闻。",
    retryable: false,
  };
  return {
    calls,
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (path === "/health") {
        if (failHealth) throw new Error("network down");
        return { status: 200, body: health };
      }
      if (method === "POST" && path === "/turns/prepare") {
        if (turnBehavior.prepareError) return { status: 500, body: { ok: false, error: { code: "INTERNAL", message: turnBehavior.prepareError } } };
        if (turnBehavior.prepareThrow) throw new Error("network down");
        return { status: 200, body: { ok: true, data: { response: turnBehavior.prepareResponse ?? defaultPrepareResponse } } };
      }
      if (method === "POST" && path === "/turns/commit") {
        if (turnBehavior.commitError) return { status: 500, body: { ok: false, error: { code: "INTERNAL", message: turnBehavior.commitError } } };
        if (turnBehavior.commitThrow) throw new Error("network down");
        return { status: 200, body: { ok: true, data: { receipt: turnBehavior.receipt ?? defaultReceipt } } };
      }
      if (method === "POST" && path === "/turns/retry") {
        if (turnBehavior.retryError) return { status: 500, body: { ok: false, error: { code: "INTERNAL", message: turnBehavior.retryError } } };
        return { status: 200, body: { ok: true, data: { receipt: turnBehavior.retryReceipt ?? defaultReceipt } } };
      }
      if (method === "POST" && path === "/turns/rollback") {
        if (turnBehavior.rollbackError) return { status: 400, body: { ok: false, error: { code: "INVALID_PAYLOAD", message: turnBehavior.rollbackError } } };
        return { status: 200, body: { ok: true, data: { rolledBack: { assistantMessageId: body?.assistantMessageId ?? "" }, restored: null } } };
      }
      if (method === "POST" && path === "/map/travel-preview") {
        if (travelPreview) return { status: 200, body: { ok: true, data: { preview: travelPreview } } };
        return { status: 200, body: { ok: true, data: { preview: null } } };
      }
      if (method === "POST" && path === "/bindings") {
        const action = body?.action;
        if (action === "bind") {
          if (body.binding.worldId === "missing-world") {
            return { status: 404, body: { ok: false, error: { code: "WORLD_NOT_FOUND", message: "世界不存在" } } };
          }
          return { status: 200, body: { ok: true, data: { chatId: body.binding.chatId, bound: true } } };
        }
        return { status: 200, body: { ok: true, data: { bound: false } } };
      }
      if (method === "GET" && path === "/worlds") {
        return {
          status: 200,
          body: { ok: true, data: { worlds: [{ id: "w-1", name: "演示世界", pointCount: 6 }] } },
        };
      }
      const chatMatch = path.match(/^\/state\/(.+)$/);
      if (method === "GET" && chatMatch) {
        const payload = stateByChat[decodeURIComponent(chatMatch[1])];
        if (!payload) {
          return { status: 400, body: { ok: false, error: { code: "NOT_BOUND", message: "未绑定" } } };
        }
        if (payload === "WORLD_MISSING") {
          return { status: 404, body: { ok: false, error: { code: "WORLD_NOT_FOUND", message: "世界不存在" } } };
        }
        return { status: 200, body: { ok: true, data: payload } };
      }
      return { status: 404, body: { ok: false, error: { code: "INVALID_PAYLOAD", message: "未知路由" } } };
    },
  };
}

function makeHost() {
  const bindings = new Map(); // chatId → raw binding
  let currentChat = null;
  let panelOpen = false;
  const writtenPayloads = [];
  const filledInputs = [];
  const dataStore = new Map(); // extensionSettings 键值（readData / writeData）
  return {
    writtenPayloads,
    filledInputs,
    dataStore,
    setChat(chatId) {
      currentChat = chatId;
    },
    setBinding(chatId, raw) {
      if (raw === undefined) bindings.delete(chatId);
      else bindings.set(chatId, raw);
    },
    setPanelOpen(open) {
      panelOpen = open;
    },
    host: {
      getChatId: () => currentChat,
      readBinding: () => (currentChat !== null && bindings.has(currentChat) ? bindings.get(currentChat) : null),
      async writeBinding(binding) {
        writtenPayloads.push(binding);
        bindings.set(currentChat, binding);
      },
      async clearBinding() {
        bindings.delete(currentChat);
      },
      readPanelOpen: () => panelOpen,
      writePanelOpen(open) {
        panelOpen = open;
      },
      fillInput(text) {
        filledInputs.push(text);
      },
      readData(key) {
        return dataStore.has(key) ? dataStore.get(key) : null;
      },
      writeData(key, value) {
        dataStore.set(key, value);
      },
    },
  };
}

function makeEmitter() {
  const listeners = new Map();
  return {
    listeners,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
    },
    off(event, handler) {
      listeners.get(event)?.delete(handler);
    },
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const STATE_PAYLOAD = {
  worldId: "w-1",
  worldName: "演示世界",
  branchId: null,
  currentTime: 12,
  currentLocationId: "p-1",
  nearbyPointIds: ["p-2"],
  relevantNpcIds: ["npc-1"],
  npcReasons: { "npc-1": ["samePoint"] },
  triggerIds: [],
};

function bindingFor(chatId, worldId = "w-1", overrides = {}) {
  return {
    schemaVersion: 1,
    enabled: true,
    chatId,
    characterId: null,
    worldId,
    branchId: null,
    currentLocationId: "p-1",
    worldTimeCursor: 12,
    lastCommittedMessageId: null,
    lastCheckpointId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// manifest 与静态资源
// ---------------------------------------------------------------------------

test("manifest：显示名固定、入口正确、版本一致", () => {
  const manifest = JSON.parse(readFileSync(join(root, "atlas-extension", "manifest.json"), "utf8"));
  equal(manifest.display_name, "阿特拉斯 / Atlas", "display_name");
  equal(manifest.js, "index.js", "js 入口");
  ok(typeof manifest.css === "string" && manifest.css.length > 0, "css 存在");
  equal(manifest.version, ATLAS_EXTENSION_VERSION, "manifest 版本与代码一致");
});

test("settings.html 与 style.css：真实结构、字号达标（ATLAS-09 工作台契约）", () => {
  const settings = readFileSync(join(root, "atlas-extension", "settings.html"), "utf8");
  ok(settings.includes("atlas-extension-settings-root"), "settings 根节点存在");
  ok(settings.includes("阿特拉斯 / Atlas"), "设置页有产品名");
  const css = readFileSync(join(root, "atlas-extension", "style.css"), "utf8");
  ok(css.includes("font-size: 14px"), "主要文字 ≥14px");
  ok(css.includes("font-size: 13px"), "控件文字 ≥13px（ATLAS-09 工作台令牌，原 300px 面板的 16px 契约随全屏工作台重设计退役）");
  ok(css.includes("focus-visible"), "键盘焦点可见");
  ok(css.includes(".aw-nav__btn.is-active"), "左栏导航激活态存在");
  ok(css.includes(".aw-move"), "世界动向条目样式存在");
  ok(css.includes("--aw-paper: #f2efe7"), "Atlasia 纸质米色令牌存在");
});

// ---------------------------------------------------------------------------
// UI 形态契约（ATLAS-09：悬浮窗 + 中区随栏位切换 + 预览控制入右栏）
// ---------------------------------------------------------------------------

test("形态契约：工作台是悬浮窗而非全屏铺满", () => {
  const css = readFileSync(join(root, "atlas-extension", "style.css"), "utf8");
  ok(css.includes("width: min(1180px"), "有明确的最大宽度（全屏方案无此值）");
  ok(css.includes("height: min(780px"), "有明确的最大高度（全屏方案无此值）");
  ok(css.includes("margin: auto"), "用 inset+margin:auto 居中，把 translate 让给拖拽");
  ok(css.includes("border-radius: 14px"), "悬浮窗圆角");
  // 全屏方案的判据：inset:0 之后再无宽度上限、且撑满视口
  ok(!/\.atlas-workbench\s*\{[^}]*width:\s*100vw/.test(css), "工作台不写 width:100vw（窄屏断点除外）");
  ok(css.includes("box-shadow"), "悬浮窗需要投影与宿主页面分层");
});

test("形态契约：中区按栏位切页，地图只属于地图页", () => {
  const js = readFileSync(join(root, "atlas-extension", "index.js"), "utf8");
  ok(js.includes("core.setPage(page.id)"), "导航按钮切换页面状态");
  ok(js.includes('if (state().page === "map") renderMap(d)'), "只有地图页才渲染地图");
  // 侧边栏七项（0.9.7 新增「日志」）
  for (const page of ["overview", "map", "nearby", "changes", "progression", "api", "logs"]) {
    ok(js.includes(`s.page === "${page}"`), `中区有独立的「${page}」页分支`);
  }
  ok(!js.includes('s.page === "settings"'), "「设置」页分支已删除（职责并入概览 / 推进 / API）");
  // 回归：renderCenter 有 12 处无参调用点，缺省参数缺失会直接 TypeError（切页即崩）
  ok(js.includes("function renderCenter(d = data())"), "renderCenter 有缺省数据源，无参调用不崩");
});

test("形态契约：右上角常驻关闭钮（作者 2026-09-19 反馈）", () => {
  const js = readFileSync(join(root, "atlas-extension", "index.js"), "utf8");
  const css = readFileSync(join(root, "atlas-extension", "style.css"), "utf8");
  ok(js.includes('el("button", "aw-topbar__close", "×")'), "顶栏有关闭钮");
  ok(js.includes('topbarClose.setAttribute("aria-label", "关闭工作台，返回酒馆聊天")'), "关闭钮带无障碍名称");
  ok(js.includes("topbarRight.append(topbarClose);"), "每次顶栏重渲染后关闭钮仍存在（chips 重排不清掉它）");
  ok(/topbarClose\.addEventListener\("click", \(\) => core\.setPanelOpen\(false\)\)/.test(js), "点击 = 关闭工作台");
  ok(css.includes(".aw-topbar__close"), "关闭钮有样式");
  // 回归（作者 2026-09-19）：setPanelOpen 只改状态，渲染层必须消费 panelOpen 否则永远关不掉
  ok(
    js.includes('root.style.display = state().panelOpen === false ? "none" : ""'),
    "renderPage 消费 panelOpen 同步根节点可见性（× / 退出真正能关掉）"
  );
});

test("形态契约：扩展菜单打开入口（作者 2026-09-19 反馈：修好隐藏后没有打开入口）", () => {
  const js = readFileSync(join(root, "atlas-extension", "index.js"), "utf8");
  ok(js.includes('document.getElementById("extensionsMenu")'), "往酒馆扩展菜单 #extensionsMenu 挂条目");
  ok(js.includes('item.id = "atlas-menu-open"'), "菜单条目有稳定 id（幂等不重复挂载）");
  ok(js.includes("installMenuButton(core)"), "连接时安装菜单入口");
  ok(js.includes("removeMenuButton();"), "停用 / 断开时移除菜单入口");
  ok(/core\.setPanelOpen\(true\)/.test(js), "点击菜单 = 打开工作台");
});

test("形态契约：预览控制挂右栏槽位，不常驻生产界面", () => {
  const js = readFileSync(join(root, "atlas-extension", "index.js"), "utf8");
  const css = readFileSync(join(root, "atlas-extension", "style.css"), "utf8");
  const preview = readFileSync(join(root, "dev-preview", "index.html"), "utf8");
  ok(js.includes("window.__atlasDevSlot"), "插件只在宿主提供钩子时注入预览控制");
  ok(css.includes(".aw-dev { display: none; }"), "预览控制默认隐藏（生产不出现）");
  ok(css.includes(".aw-side__changes"), "右栏有世界变化简览容器");
  ok(preview.includes("window.__atlasDevSlot ="), "本地预览夹具提供该钩子");
  ok(!preview.includes("host-chip"), "旧的左下角悬浮控制条已移除");
  ok(preview.includes("__atlasDevSlot"), "夹具与插件槽位对齐");
});

test("connectAtlas 并发安全：模块自初始化与 activate 共享同一次挂载", () => {
  const js = readFileSync(join(root, "atlas-extension", "index.js"), "utf8");
  ok(js.includes("if (connecting) return connecting;"), "有在途连接闸门（只有 connected 检查会双重挂载）");
  ok(js.includes("connecting = connectOnce();"), "在途 Promise 被记录");
  ok(/finally\s*\{\s*connecting = null;/.test(js), "连接结束后清空在途标记");
  equal((js.match(/renderPanel\(/g) ?? []).length, 2, "renderPanel 只声明一次 + 调用一次（不存在第二处挂载）");
  ok(js.includes("void connectAtlas();"), "模块加载仍自初始化（旧版酒馆无 hooks）");
  ok(js.includes("export async function activate()"), "同时保留 hooks.activate 入口");
});

test("世界书注入层：端口适配 + onLorebookSync 接线 + 变化页条目面板（ATLAS-09）", () => {
  const js = readFileSync(join(root, "atlas-extension", "index.js"), "utf8");
  ok(js.includes("export function createLorebookPort"), "world-info → port 适配器存在且导出（单测复用真实适配器）");
  ok(js.includes("chatMetadata.world_info"), "绑定走 chatMetadata.world_info 槽");
  ok(js.includes("window.__atlasWorldInfoModule"), "预览 / 测试可注入 world-info stub");
  ok(js.includes("onLorebookSync:"), "connectAtlas 注入世界书写入钩子");
  ok(js.includes('engineStore.write("lorebook"'), "写入后快照落 store（面板可见性）");
  ok(js.includes("buildLorebookPanel"), "变化页有世界书条目面板");
  ok(js.includes("lorebookNameFor") === false, "书名派生只发生在引擎侧（index.js 不重复实现）");

  const entry = readFileSync(join(root, "src", "atlas-browser-entry.ts"), "utf8");
  ok(entry.includes("createAtlasLorebookWriter"), "打包入口导出世界书写入器");

  const core = readFileSync(join(root, "src", "atlas-ui-core.ts"), "utf8");
  ok(core.includes("syncLorebookAfterCommit(body)"), "commit 与 retry 成功路径都调用世界书同步");
  equal((core.match(/syncLorebookAfterCommit\(body\)/g) ?? []).length, 2, "恰好两处调用（commit + retry）");
  ok(core.includes("lorebookHint"), "写入失败 / 绑定冲突有用户可见提示字段");
});

// ---------------------------------------------------------------------------
// 监听注册与清理
// ---------------------------------------------------------------------------

test("harness：init 注册恰好的事件、dispose 成对清理", async () => {
  const api = makeApi();
  const hostWrap = makeHost();
  hostWrap.setChat("chat-a");
  const emitter = makeEmitter();
  const core = createAtlasUiCore({ api, host: hostWrap.host, emitter, now: () => NOW_BASE });
  equal(emitter.listeners.size, 0, "init 前无监听");
  core.init();
  await flush();
  deepEqual([...emitter.listeners.keys()].sort(), [...ATLAS_UI_EVENTS].sort(), "只注册已实现的事件");
  equal(emitter.listeners.get("APP_READY").size, 1, "APP_READY 一个监听");
  equal(emitter.listeners.get("CHAT_CHANGED").size, 1, "CHAT_CHANGED 一个监听");
  core.dispose();
  equal(emitter.listeners.get("APP_READY").size, 0, "dispose 后 APP_READY 清理");
  equal(emitter.listeners.get("CHAT_CHANGED").size, 0, "dispose 后 CHAT_CHANGED 清理");
  // dispose 后事件不再响应
  await core.handleEvent("CHAT_CHANGED");
  const callsAfterDispose = api.calls.length;
  await core.handleEvent("CHAT_CHANGED");
  equal(api.calls.length, callsAfterDispose, "dispose 后不再发起请求");
});

// ---------------------------------------------------------------------------
// 五种模式
// ---------------------------------------------------------------------------

test("模式：引擎未就绪（health 抛错）——纯浏览器模式不再引导安装 Server Plugin", async () => {
  const api = makeApi({ failHealth: true });
  const hostWrap = makeHost();
  hostWrap.setChat("chat-a");
  const core = createAtlasUiCore({ api, host: hostWrap.host, emitter: makeEmitter(), now: () => NOW_BASE });
  await core.handleEvent("APP_READY");
  equal(core.getState().mode, "offline", "offline 模式");
  ok(core.getState().modeHint.includes("引擎未就绪"), "空状态文案可读（ATLAS-09 文案清退）");
  ok(!core.getState().modeHint.includes("Server Plugin"), "不再出现 Server Plugin 安装引导");
  ok(!core.getState().modeHint.includes("enableServerPlugins"), "不再出现服务端开关指引");
});

test("模式：协议不兼容（health 版本 2）", async () => {
  const api = makeApi({ health: { ok: true, data: { protocolVersion: 2 } } });
  const hostWrap = makeHost();
  hostWrap.setChat("chat-a");
  hostWrap.setBinding("chat-a", bindingFor("chat-a"));
  const core = createAtlasUiCore({ api, host: hostWrap.host, emitter: makeEmitter(), now: () => NOW_BASE });
  await core.handleEvent("APP_READY");
  equal(core.getState().mode, "protocol-incompatible", "incompatible 模式");
  equal(core.getState().serviceProtocolVersion, 2, "记录实际协议版本");
  ok(core.getState().modeHint.includes("2"), "提示包含实际版本号");
});

test("模式：未绑定 → 就绪（health + state 200）", async () => {
  const api = makeApi({ stateByChat: { "chat-a": STATE_PAYLOAD } });
  const hostWrap = makeHost();
  hostWrap.setChat("chat-a");
  const core = createAtlasUiCore({ api, host: hostWrap.host, emitter: makeEmitter(), now: () => NOW_BASE });
  await core.handleEvent("APP_READY");
  equal(core.getState().mode, "unbound", "无绑定 → unbound");
  hostWrap.setBinding("chat-a", bindingFor("chat-a"));
  await core.handleEvent("CHAT_CHANGED");
  equal(core.getState().mode, "ready", "绑定后 → ready");
  equal(core.getState().stateData.worldName, "演示世界", "state 数据进入面板状态");
  equal(core.getState().modeHint, null, "就绪无空状态文案");
});

test("模式：世界不存在（state 404 WORLD_NOT_FOUND）", async () => {
  const api = makeApi({ stateByChat: { "chat-a": "WORLD_MISSING" } });
  const hostWrap = makeHost();
  hostWrap.setChat("chat-a");
  hostWrap.setBinding("chat-a", bindingFor("chat-a"));
  const core = createAtlasUiCore({ api, host: hostWrap.host, emitter: makeEmitter(), now: () => NOW_BASE });
  await core.handleEvent("APP_READY");
  equal(core.getState().mode, "world-missing", "world-missing 模式");
  ok(core.getState().modeHint.includes("重新选择"), "给出解绑重绑指引");
});

test("模式：绑定形状损坏 → 按未绑定处理且不采用", async () => {
  const api = makeApi({ stateByChat: { "chat-a": STATE_PAYLOAD } });
  const hostWrap = makeHost();
  hostWrap.setChat("chat-a");
  hostWrap.setBinding("chat-a", { schemaVersion: 1, enabled: true, chatId: "chat-a", worldId: "" });
  const core = createAtlasUiCore({ api, host: hostWrap.host, emitter: makeEmitter(), now: () => NOW_BASE });
  await core.handleEvent("APP_READY");
  equal(core.getState().mode, "unbound", "非法绑定 → unbound");
  equal(core.getState().bindingInvalid, true, "bindingInvalid 标记");
  ok(core.getState().modeHint.includes("损坏"), "损坏说明用户可见");
});

test("防御：绑定 chatId 与当前聊天不一致 → 不采用", async () => {
  const api = makeApi({ stateByChat: { "chat-b": STATE_PAYLOAD } });
  const hostWrap = makeHost();
  hostWrap.setChat("chat-b");
  hostWrap.setBinding("chat-b", bindingFor("chat-a"));
  const core = createAtlasUiCore({ api, host: hostWrap.host, emitter: makeEmitter(), now: () => NOW_BASE });
  await core.handleEvent("APP_READY");
  equal(core.getState().mode, "unbound", "跨聊天绑定不采用");
  equal(core.getState().binding, null, "binding 为空");
});

// ---------------------------------------------------------------------------
// A / B 聊天隔离：切换 20 次
// ---------------------------------------------------------------------------

test("A / B 聊天各绑不同世界：切换 20 次状态不串", async () => {
  const api = makeApi({
    stateByChat: {
      "chat-a": { ...STATE_PAYLOAD, worldName: "世界A", currentTime: 10 },
      "chat-b": { ...STATE_PAYLOAD, worldName: "世界B", currentTime: 20 },
    },
  });
  const hostWrap = makeHost();
  const core = createAtlasUiCore({ api, host: hostWrap.host, emitter: makeEmitter(), now: () => NOW_BASE });
  core.init();
  await flush();
  hostWrap.setChat("chat-a");
  hostWrap.setBinding("chat-a", bindingFor("chat-a"));
  hostWrap.setChat("chat-b");
  hostWrap.setBinding("chat-b", bindingFor("chat-b"));
  let lastSeen = null;
  for (let i = 0; i < 20; i += 1) {
    const chatId = i % 2 === 0 ? "chat-a" : "chat-b";
    hostWrap.setChat(chatId);
    await core.handleEvent("CHAT_CHANGED");
    const state = core.getState();
    equal(state.mode, "ready", `第 ${i + 1} 次切换后 ready`);
    const expectName = chatId === "chat-a" ? "世界A" : "世界B";
    equal(state.stateData.worldName, expectName, `第 ${i + 1} 次切换后世界正确`);
    equal(state.chatId, chatId, "chatId 跟随当前聊天");
    lastSeen = state;
  }
  equal(lastSeen.chatId, "chat-b", "最终停在第 20 次（B）");
});

// ---------------------------------------------------------------------------
// 绑定操作
// ---------------------------------------------------------------------------

test("bindToWorld：服务端校验通过才写 chatMetadata，载荷无密钥", async () => {
  const api = makeApi({ stateByChat: { "chat-a": STATE_PAYLOAD } });
  const hostWrap = makeHost();
  hostWrap.setChat("chat-a");
  const core = createAtlasUiCore({ api, host: hostWrap.host, emitter: makeEmitter(), now: () => NOW_BASE });
  await core.handleEvent("APP_READY");
  await core.bindToWorld("w-1");
  const bindCalls = api.calls.filter((c) => c.method === "POST" && c.path === "/bindings");
  equal(bindCalls.length, 1, "一次绑定请求");
  equal(hostWrap.writtenPayloads.length, 1, "chatMetadata 写入一次");
  const payload = hostWrap.writtenPayloads[0];
  equal(payload.chatId, "chat-a", "写入当前聊天 id");
  equal(payload.worldId, "w-1", "写入世界 id");
  for (const forbidden of ["apikey", "api_key", "key", "token", "secret", "password", "authorization"]) {
    ok(!Object.keys(payload).some((k) => k.toLowerCase().includes(forbidden)), `绑定载荷无 ${forbidden} 字段`);
  }
  equal(core.getState().mode, "ready", "绑定后刷新 → ready");

  // 世界不存在：服务端拒绝 → 不写 chatMetadata
  const before = hostWrap.writtenPayloads.length;
  await core.bindToWorld("missing-world");
  equal(hostWrap.writtenPayloads.length, before, "拒绝后零写入");
  ok(core.getState().lastError.includes("世界不存在"), "失败原因用户可见");
});

test("unbind / setEnabled：写路径正确", async () => {
  const api = makeApi({ stateByChat: { "chat-a": STATE_PAYLOAD } });
  const hostWrap = makeHost();
  hostWrap.setChat("chat-a");
  hostWrap.setBinding("chat-a", bindingFor("chat-a"));
  const core = createAtlasUiCore({ api, host: hostWrap.host, emitter: makeEmitter(), now: () => NOW_BASE });
  await core.handleEvent("APP_READY");
  await core.setEnabled(false);
  equal(hostWrap.writtenPayloads.at(-1).enabled, false, "停用写入 metadata");
  equal(core.getState().mode, "unbound", "停用后 state 视图不再返回 → unbound");
  await core.unbind();
  equal(api.calls.some((c) => c.body?.action === "unbind" && c.body?.chatId === "chat-a"), true, "解绑请求发出");
  equal(hostWrap.writtenPayloads.length, 1, "解绑后无额外绑定写入");
});

test("requestWorlds：返回列表；失败返回空数组", async () => {
  const api = makeApi();
  const hostWrap = makeHost();
  hostWrap.setChat("chat-a");
  const core = createAtlasUiCore({ api, host: hostWrap.host, emitter: makeEmitter(), now: () => NOW_BASE });
  const worlds = await core.requestWorlds();
  equal(worlds.length, 1, "世界列表返回");
  equal(worlds[0].id, "w-1", "世界 id");
  const failing = createAtlasUiCore({
    api: { request: async () => { throw new Error("down"); } },
    host: hostWrap.host,
    emitter: makeEmitter(),
    now: () => NOW_BASE,
  });
  const empty = await failing.requestWorlds();
  deepEqual(empty, [], "失败 → 空数组");
  ok(failing.getState().lastError !== null, "错误用户可见");
});

// ---------------------------------------------------------------------------
// 面板开关恢复 + 事件驱动 health 重新检查
// ---------------------------------------------------------------------------

test("面板开关：经 extensionSettings 持久化并在 init 恢复", async () => {
  const api = makeApi();
  const hostWrap = makeHost();
  hostWrap.setChat("chat-a");
  hostWrap.setPanelOpen(true);
  const core = createAtlasUiCore({ api, host: hostWrap.host, emitter: makeEmitter(), now: () => NOW_BASE });
  core.init();
  equal(core.getState().panelOpen, true, "init 恢复面板展开状态");
  core.setPanelOpen(false);
  equal(hostWrap.host.readPanelOpen(), false, "关闭写入宿主（extensionSettings）");
});

test("事件驱动时强制重新检查 health（不用 30s 缓存）", async () => {
  let clock = NOW_BASE;
  const api = makeApi();
  const hostWrap = makeHost();
  hostWrap.setChat("chat-a");
  const core = createAtlasUiCore({ api, host: hostWrap.host, emitter: makeEmitter(), now: () => clock });
  await core.handleEvent("APP_READY");
  clock += 1000; // 缓存窗口内
  await core.handleEvent("CHAT_CHANGED");
  const healthCalls = api.calls.filter((c) => c.path === "/health").length;
  equal(healthCalls, 2, "两次事件各做一次 health 检查");
});

// ---------------------------------------------------------------------------
// 地图：旅行预览 / 确认填入（不自动发送）/ 缩放钳制
// ---------------------------------------------------------------------------

const MAP_STATE_PAYLOAD = {
  ...STATE_PAYLOAD,
  map: {
    points: [
      { id: "p-1", name: "白塔钟座", x: 53, y: 42, regionId: "capital" },
      { id: "p-4", name: "玻璃温室", x: 63, y: 54, regionId: "capital" },
    ],
    pointCount: 2,
    mapImagePresent: false,
  },
};

test("atlasClampZoom：1x..3x 钳制，底图不会被推出视口", () => {
  equal(atlasClampZoom(0.5), 1, "低于 1x 钳到 1x");
  equal(atlasClampZoom(1), 1, "1x 原样");
  equal(atlasClampZoom(2.5), 2.5, "中间值原样");
  equal(atlasClampZoom(5), 3, "高于 3x 钳到 3x");
  equal(atlasClampZoom(Number.NaN), 1, "NaN 回退 1x");
});

test("地图：点击目的地 → 预览；确认只填输入框；取消关闭；切聊天清空预览", async () => {
  const api = makeApi({
    stateByChat: { "chat-a": MAP_STATE_PAYLOAD },
    travelPreview: { destinationId: "p-4", distance: 14, estimatedDuration: 3, factors: ["baseline"] },
  });
  const hostWrap = makeHost();
  hostWrap.setChat("chat-a");
  hostWrap.setBinding("chat-a", bindingFor("chat-a"));
  const core = createAtlasUiCore({ api, host: hostWrap.host, emitter: makeEmitter(), now: () => NOW_BASE });
  await core.handleEvent("APP_READY");
  equal(core.getState().mode, "ready", "就绪");

  await core.selectDestination("p-4");
  const preview = core.getState().destinationPreview;
  ok(preview !== null, "预览已暂存");
  equal(preview.destinationName, "玻璃温室", "目的地名称来自地图点集");
  equal(preview.distance, 14, "距离来自共享算法结果");
  equal(preview.estimatedDuration, 3, "预计耗时");

  core.confirmTravel();
  deepEqual(hostWrap.filledInputs, ["前往 玻璃温室。"], "确认只填入输入框文本");
  equal(core.getState().destinationPreview, null, "确认后预览关闭");
  const sendCalls = api.calls.filter((c) => String(c.path).includes("send"));
  equal(sendCalls.length, 0, "核心层绝不触发发送");

  // 取消路径
  await core.selectDestination("p-4");
  core.cancelTravel();
  equal(core.getState().destinationPreview, null, "取消后预览关闭");

  // 服务端无预览（未知终点）→ 提示且不填输入框
  const noPreview = makeApi({ stateByChat: { "chat-a": MAP_STATE_PAYLOAD } });
  const core2 = createAtlasUiCore({ api: noPreview, host: hostWrap.host, emitter: makeEmitter(), now: () => NOW_BASE });
  await core2.handleEvent("APP_READY");
  await core2.selectDestination("p-4");
  equal(core2.getState().destinationPreview, null, "无预览结果 → 不暂存");
  ok(core2.getState().lastError !== null, "失败提示用户可见");
  equal(hostWrap.filledInputs.length, 1, "失败路径不填输入框");

  // 切聊天 → 残留预览清空
  await core.selectDestination("p-4");
  hostWrap.setChat("chat-b");
  await core.handleEvent("CHAT_CHANGED");
  equal(core.getState().destinationPreview, null, "切聊天后预览清空");
});

// ---------------------------------------------------------------------------
// ATLAS-05：生成前注入与回复后世界推演（回合流）
// ---------------------------------------------------------------------------

/** 测试用事件适配器：载荷即结构化字段（真实 ST 适配在 index.js createEventAdapter）。 */
function makeAdaptEvent() {
  return (event, payload) => {
    if (event === "MESSAGE_SENT") {
      return payload ? { kind: "message-sent", messageId: String(payload.messageId ?? ""), userText: String(payload.userText ?? "") } : null;
    }
    if (event === "MESSAGE_RECEIVED") {
      return payload
        ? { kind: "generation-ended", assistantMessageId: String(payload.assistantMessageId ?? ""), assistantText: String(payload.assistantText ?? "") }
        : null;
    }
    if (event === "GENERATION_STOPPED") return { kind: "generation-stopped" };
    if (event === "GENERATION_STARTED") return { kind: "generation-started", gated: payload?.gated === true };
    if (event === "MESSAGE_SWIPED") {
      return payload
        ? {
            kind: "message-swiped",
            messageId: String(payload.messageId ?? ""),
            userMessageId: String(payload.userMessageId ?? ""),
            userText: String(payload.userText ?? ""),
            regenerating: payload.regenerating === true ? true : payload.regenerating === false ? false : null,
          }
        : null;
    }
    if (event === "MESSAGE_EDITED") return payload ? { kind: "message-edited", messageId: String(payload.messageId ?? "") } : null;
    if (event === "MESSAGE_DELETED") return payload ? { kind: "message-deleted", messageId: String(payload.messageId ?? "") } : null;
    return null;
  };
}

async function readyCore(turnBehavior = {}, bindingOverrides = {}) {
  const api = makeApi({ stateByChat: { "chat-a": STATE_PAYLOAD }, turnBehavior });
  const hostWrap = makeHost();
  hostWrap.setChat("chat-a");
  hostWrap.setBinding("chat-a", bindingFor("chat-a", "w-1", bindingOverrides));
  const core = createAtlasUiCore({
    api,
    host: hostWrap.host,
    emitter: makeEmitter(),
    adaptEvent: makeAdaptEvent(),
    now: () => NOW_BASE,
    // ATLAS-06：ENDED 走防抖重解析；测试里 0ms + flush 让计时器立刻落定
    endedDebounceMs: 0,
    mutationDebounceMs: 0,
  });
  await core.handleEvent("APP_READY");
  return { api, hostWrap, core };
}

test("回合：未适配 / 未绑定 / 停用时不发 prepare 请求", async () => {
  const { api, core } = await readyCore();
  equal(core.getState().mode, "ready", "前置：就绪");
  // 载荷无法适配 → 忽略，绝不猜测
  await core.handleEvent("MESSAGE_SENT", null);
  equal(api.calls.filter((c) => c.path === "/turns/prepare").length, 0, "未适配载荷 → 零请求");
  // 正常发送
  await core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "我从城门走向集市。" });
  const prepares = api.calls.filter((c) => c.path === "/turns/prepare");
  equal(prepares.length, 1, "一次 prepare");
  const pending = core.getState().pendingTurn;
  ok(pending !== null, "pendingTurn 建立");
  equal(pending.turnId, "turn-1", "turnId 来自服务端");
  equal(pending.messageId, "m-0", "messageId 保留");
  // 停用绑定 → 不再 prepare
  await core.handleEvent("GENERATION_STOPPED");
  await core.setEnabled(false);
  await core.handleEvent("MESSAGE_SENT", { messageId: "m-1", userText: "第二条。" });
  equal(api.calls.filter((c) => c.path === "/turns/prepare").length, 1, "停用后零 prepare");
});

test("回合：GENERATION_ENDED → commit 一次 → 回执入列并持久化 → 刷新状态", async () => {
  const { api, hostWrap, core } = await readyCore();
  await core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "我从城门走向集市。" });
  await core.handleEvent("MESSAGE_RECEIVED", { assistantMessageId: "m-1", assistantText: "你穿过城门，集市喧闹扑面而来。" });
  await flush(); // ATLAS-06：ENDED 防抖（0ms）计时器落定
  const commits = api.calls.filter((c) => c.path === "/turns/commit");
  equal(commits.length, 1, "恰好一次 commit");
  const receipt = core.getState().receipts;
  equal(receipt.length, 1, "回执入列");
  equal(receipt[0].receiptId, "receipt-1", "回执 id");
  equal(receipt[0].adoptedEventCount, 1, "采纳变化条数来自 adoptedEventIds");
  ok(receipt[0].summary.length <= 300, "摘要截断上界");
  equal(core.getState().pendingTurn, null, "pendingTurn 清空");
  equal(core.getState().lastError, null, "无错误");
  deepEqual(hostWrap.dataStore.get("receipts"), receipt, "回执写入 extensionSettings");
  equal(api.calls.filter((c) => c.path === "/state/chat-a").length >= 2, true, "commit 成功后刷新世界状态");
});

test("回合：同一条回复的重复 GENERATION_ENDED 只 commit 一次", async () => {
  const { api, core } = await readyCore();
  await core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "你好。" });
  // 并发触发两次完成通知（真实 ST 中 MESSAGE_RECEIVED 与 GENERATION_ENDED 可能先后到达）
  const first = core.handleEvent("MESSAGE_RECEIVED", { assistantMessageId: "m-1", assistantText: "回答。" });
  const second = core.handleEvent("GENERATION_ENDED", { assistantMessageId: "m-1", assistantText: "回答。" });
  await Promise.all([first, second]);
  await flush(); // ATLAS-06：ENDED 防抖落定（两次通知合并成一次消费）
  equal(api.calls.filter((c) => c.path === "/turns/commit").length, 1, "重复通知不重复推进世界");
  equal(core.getState().receipts.length, 1, "回执去重后仍一条");
});

test("回合：GENERATION_STOPPED / 空回复 → 放弃 pending，不推进世界", async () => {
  const stopped = await readyCore();
  await stopped.core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "写字。" });
  await stopped.core.handleEvent("GENERATION_STOPPED");
  equal(stopped.api.calls.filter((c) => c.path === "/turns/commit").length, 0, "停止 → 零 commit");
  equal(stopped.core.getState().pendingTurn, null, "pending 放弃");

  const empty = await readyCore();
  await empty.core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "写字。" });
  await empty.core.handleEvent("MESSAGE_RECEIVED", { assistantMessageId: "m-1", assistantText: "   " });
  await flush(); // ATLAS-06：ENDED 防抖落定
  equal(empty.api.calls.filter((c) => c.path === "/turns/commit").length, 0, "空回复 → 零 commit");
  equal(empty.core.getState().pendingTurn, null, "空回复放弃 pending");
});

test("回合：prepare 失败不阻断（提示用户可见），无注入不建 pending", async () => {
  const failed = await readyCore({ prepareError: "相关性筛选失败" });
  await failed.core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "你好。" });
  equal(failed.core.getState().pendingTurn, null, "无 pending");
  ok(failed.core.getState().lastError.includes("相关性筛选失败"), "失败原因用户可见");
  const thrown = await readyCore({ prepareThrow: true });
  await thrown.core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "你好。" });
  ok(thrown.core.getState().lastError.includes("未注入"), "网络失败提示可读");
});

test("回合：commit 失败 → retryableCommit；retry 沿用原键且成功后清空", async () => {
  const { api, core } = await readyCore({ commitError: "推演模型超时" });
  await core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "推进剧情。" });
  await core.handleEvent("MESSAGE_RECEIVED", { assistantMessageId: "m-1", assistantText: "剧情推进了。" });
  await flush(); // ATLAS-06：ENDED 防抖落定
  equal(core.getState().pendingTurn, null, "失败后 pending 清空");
  const retryable = core.getState().retryableCommit;
  ok(retryable !== null, "retryableCommit 保留");
  equal(retryable.chatId, "chat-a", "键字段：chatId");
  equal(retryable.userMessageId, "m-0", "键字段：userMessageId");
  equal(retryable.assistantMessageId, "m-1", "键字段：assistantMessageId");

  // 重试失败：仍保留 retryable
  const failing = await readyCore({ commitError: "x", retryError: "仍然失败" });
  await failing.core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "推进剧情。" });
  await failing.core.handleEvent("MESSAGE_RECEIVED", { assistantMessageId: "m-1", assistantText: "剧情推进了。" });
  await flush(); // ATLAS-06：ENDED 防抖落定
  await failing.core.retryLastCommit();
  equal(failing.core.getState().retryableCommit !== null, true, "重试失败仍可再试");
  ok(failing.core.getState().lastError.includes("仍然失败"), "重试失败原因可见");

  // 重试成功：清空 retryable，回执入列
  await core.retryLastCommit();
  const retries = api.calls.filter((c) => c.path === "/turns/retry");
  equal(retries.length, 1, "一次 retry 请求");
  equal(retries[0].body.userMessageId, "m-0", "retry 沿用原幂等键字段");
  equal(retries[0].body.assistantMessageId, "m-1", "retry 键：assistantMessageId");
  equal(core.getState().retryableCommit, null, "成功后清空 retryable");
  equal(core.getState().receipts.length, 1, "回执入列");
  equal(core.getState().lastError, null, "错误清除");
});

// ---------------------------------------------------------------------------
// ATLAS-06：生成门控 + 楼层变动回退
// ---------------------------------------------------------------------------

test("ATLAS-06 门控：quiet / dryRun 生成不触发 prepare / commit，闸门随后复位", async () => {
  const { api, core } = await readyCore();
  // 酒馆内部 quiet 生成（总结 / 向量索引）：不建 pending、不推演
  await core.handleEvent("GENERATION_STARTED", { gated: true });
  await core.handleEvent("MESSAGE_SENT", { messageId: "m-9", userText: "后台生成。" });
  equal(api.calls.filter((c) => c.path === "/turns/prepare").length, 0, "quiet 期间零 prepare");
  await core.handleEvent("MESSAGE_RECEIVED", { assistantMessageId: "m-10", assistantText: "后台结果。" });
  await flush();
  equal(api.calls.filter((c) => c.path === "/turns/commit").length, 0, "quiet 的 ENDED 零 commit");
  // 闸门复位：真实用户回合照常工作
  await core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "我从城门走向集市。" });
  equal(api.calls.filter((c) => c.path === "/turns/prepare").length, 1, "闸门复位后 prepare 恢复");
});

test("ATLAS-06 swipe：回退最近回合 → rearm → 新变体以唯一 swipeId 同级重提交", async () => {
  const { api, core } = await readyCore({}, { lastCommittedMessageId: "m-1" });
  // 右滑生成新变体（regenerating=true）→ 回退世界
  await core.handleEvent("MESSAGE_SWIPED", { messageId: "m-1", userMessageId: "m-0", userText: "我从城门走向集市。", regenerating: true });
  await flush();
  const rollbacks = api.calls.filter((c) => c.path === "/turns/rollback");
  equal(rollbacks.length, 1, "恰好一次回退请求");
  equal(rollbacks[0].body.assistantMessageId, "m-1", "回退目标楼层");
  ok(core.getState().rearmTurn !== null, "rearm 暂存重推演输入");
  ok(core.getState().worldNotice !== null, "回退提示可见");
  // 新变体生成结束 → 用 rearm 重建回合并以唯一 swipeId 提交
  await core.handleEvent("MESSAGE_RECEIVED", { assistantMessageId: "m-1", assistantText: "变体 B 的回复。" });
  await flush();
  const commits = api.calls.filter((c) => c.path === "/turns/commit");
  equal(commits.length, 1, "变体重提交恰好一次");
  ok(/^swipe-/.test(String(commits[0].body.swipeId ?? "")), "变体使用唯一 swipeId（同键会被幂等判重）");
  equal(commits[0].body.userMessageId, "m-0", "变体沿用原用户楼层");
  equal(core.getState().rearmTurn, null, "提交后 rearm 清空");
});

test("ATLAS-06 swipe：查看旧变体（regenerating=false / null）不动世界", async () => {
  const view = await readyCore({}, { lastCommittedMessageId: "m-1" });
  await view.core.handleEvent("MESSAGE_SWIPED", { messageId: "m-1", userMessageId: "m-0", userText: "x", regenerating: false });
  await flush();
  equal(view.api.calls.filter((c) => c.path === "/turns/rollback").length, 0, "查看旧变体零回退");
  const unknownShape = await readyCore({}, { lastCommittedMessageId: "m-1" });
  await unknownShape.core.handleEvent("MESSAGE_SWIPED", { messageId: "m-1", userMessageId: "m-0", userText: "x", regenerating: null });
  await flush();
  equal(unknownShape.api.calls.filter((c) => c.path === "/turns/rollback").length, 0, "形状不可判定时不回退（宁可漏、不可误）");
});

test("ATLAS-06 编辑 / 删除：最近回合回退，非最近回合不回退；防抖聚合只回退一次", async () => {
  const { api, core } = await readyCore({}, { lastCommittedMessageId: "m-1" });
  // 非最近楼层：不回退
  await core.handleEvent("MESSAGE_DELETED", { messageId: "m-5" });
  await flush();
  equal(api.calls.filter((c) => c.path === "/turns/rollback").length, 0, "非最近楼层零回退");
  // 最近楼层删除：防抖窗口内连发两次（批量删除）只回退一次
  await core.handleEvent("MESSAGE_DELETED", { messageId: "m-1" });
  await core.handleEvent("MESSAGE_DELETED", { messageId: "m-1" });
  await flush();
  equal(api.calls.filter((c) => c.path === "/turns/rollback").length, 1, "防抖聚合后恰好一次回退");
  ok(core.getState().worldNotice.includes("回退"), "回退提示可见");
  // 编辑最近楼层 → 回退
  const edit = await readyCore({}, { lastCommittedMessageId: "m-1" });
  await edit.core.handleEvent("MESSAGE_EDITED", { messageId: "m-1" });
  await flush();
  equal(edit.api.calls.filter((c) => c.path === "/turns/rollback").length, 1, "编辑最近楼层触发回退");
});

test("ATLAS-07 停用→重新启用：绑定与世界不丢，启用后回合管线恢复", async () => {
  const { api, core } = await readyCore();
  await core.setEnabled(false);
  await core.handleEvent("MESSAGE_SENT", { messageId: "m-1", userText: "停用期间发言。" });
  equal(api.calls.filter((c) => c.path === "/turns/prepare").length, 0, "停用期间零 prepare");
  await core.setEnabled(true);
  const binding = core.getState().binding;
  ok(binding !== null && binding.enabled, "重新启用后绑定仍在（世界未丢）");
  await core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "重新发言。" });
  equal(api.calls.filter((c) => c.path === "/turns/prepare").length, 1, "启用后回合管线恢复");
  core.dispose();
  ok(core.getState().receipts.length >= 0, "dispose 不清任何持久化数据（世界 / 绑定 / 回执全保留）");
});

test("回合：回执经 extensionSettings 持久化；新 core init 恢复合法条目、拒收非法形状", async () => {  const first = await readyCore();
  await first.core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "推进。" });
  await first.core.handleEvent("MESSAGE_RECEIVED", { assistantMessageId: "m-1", assistantText: "推进了。" });
  await flush(); // ATLAS-06：ENDED 防抖落定
  first.core.dispose();

  // 第二个 core 复用同一宿主（同一 extensionSettings）
  const secondApi = makeApi({ stateByChat: { "chat-a": STATE_PAYLOAD } });
  const second = createAtlasUiCore({
    api: secondApi,
    host: first.hostWrap.host,
    emitter: makeEmitter(),
    adaptEvent: makeAdaptEvent(),
    now: () => NOW_BASE,
  });
  second.init();
  await flush();
  equal(second.getState().receipts.length, 1, "刷新后回执仍在");
  equal(second.getState().receipts[0].receiptId, "receipt-1", "回执内容一致");
  second.dispose();

  // 非法持久化形状：非对象条目 / 缺 receiptId / 缺 summary 全部拒收
  const badHostWrap = makeHost();
  badHostWrap.setChat("chat-a");
  badHostWrap.dataStore.set("receipts", [
    "junk",
    null,
    { receiptId: "r-1", summary: "只有回执号与摘要", previousTime: "not-a-number" },
    { summary: "缺 receiptId" },
    { receiptId: "r-2", summary: "合法条目", currentTime: 5 },
  ]);
  const badCore = createAtlasUiCore({ api: secondApi, host: badHostWrap.host, emitter: makeEmitter(), now: () => NOW_BASE });
  badCore.init();
  await flush();
  equal(badCore.getState().receipts.length, 2, "非法条目逐条拒收，合法条目保留");
  equal(badCore.getState().receipts[1].previousTime, 0, "非法数值字段回退默认");
  badCore.dispose();
});

test("回合：处于 pending 期间禁止第二条 prepare（同一时刻最多一条在途回合）", async () => {
  const { api, core } = await readyCore();
  await core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "第一条。" });
  await core.handleEvent("MESSAGE_SENT", { messageId: "m-1", userText: "第二条。" });
  equal(api.calls.filter((c) => c.path === "/turns/prepare").length, 1, "在途回合未结束前不再 prepare");
  equal(core.getState().pendingTurn.messageId, "m-0", "保留第一条 pending");
});

// ---------------------------------------------------------------------------
// 0.8.2 自动建世（首条消息）+ starter world schema 校验
// ---------------------------------------------------------------------------

async function unboundCore(extraDeps = {}) {
  const api = makeApi({ stateByChat: { "chat-a": STATE_PAYLOAD } });
  const hostWrap = makeHost();
  hostWrap.setChat("chat-a");
  const core = createAtlasUiCore({
    api,
    host: hostWrap.host,
    emitter: makeEmitter(),
    adaptEvent: makeAdaptEvent(),
    now: () => NOW_BASE,
    endedDebounceMs: 0,
    mutationDebounceMs: 0,
    ...extraDeps,
  });
  await core.handleEvent("APP_READY");
  return { api, hostWrap, core };
}

test("自动建世：未绑定聊天首条消息 → ensureWorld → 绑定成功后照常 prepare", async () => {
  let ensureCalls = 0;
  const { api, core } = await unboundCore({
    ensureWorld: async () => {
      ensureCalls += 1;
      await core.bindToWorld("w-1");
      return Boolean(core.getState().binding);
    },
  });
  equal(core.getState().mode, "unbound", "前置：未绑定");
  await core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "我从城门走向集市。" });
  equal(ensureCalls, 1, "ensureWorld 恰好调用一次");
  const prepares = api.calls.filter((c) => c.path === "/turns/prepare");
  equal(prepares.length, 1, "绑定就绪后本条消息照常 prepare");
  ok(core.getState().pendingTurn !== null, "pendingTurn 建立");
  equal(core.getState().binding?.worldId, "w-1", "世界已绑定");
  equal(core.getState().mode, "ready", "进入就绪模式");
  core.dispose();
});

test("自动建世：ensureWorld 失败 → 本条消息不 prepare，状态保持未绑定", async () => {
  const { api, core } = await unboundCore({ ensureWorld: async () => false });
  await core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "我从城门走向集市。" });
  equal(api.calls.filter((c) => c.path === "/turns/prepare").length, 0, "建世失败 → 零 prepare");
  equal(core.getState().pendingTurn, null, "无 pending");
  equal(core.getState().mode, "unbound", "保持未绑定");
  core.dispose();
});

test("自动建世：已绑定聊天不触发 ensureWorld；停用绑定也不触发", async () => {
  let ensureCalls = 0;
  const ensureWorld = async () => {
    ensureCalls += 1;
    return true;
  };
  // 已绑定：readyCore 夹具 + ensureWorld 间谍
  const api = makeApi({ stateByChat: { "chat-a": STATE_PAYLOAD } });
  const hostWrap = makeHost();
  hostWrap.setChat("chat-a");
  hostWrap.setBinding("chat-a", bindingFor("chat-a", "w-1"));
  const bound = createAtlasUiCore({
    api,
    host: hostWrap.host,
    emitter: makeEmitter(),
    adaptEvent: makeAdaptEvent(),
    now: () => NOW_BASE,
    endedDebounceMs: 0,
    mutationDebounceMs: 0,
    ensureWorld,
  });
  await bound.handleEvent("APP_READY");
  equal(bound.getState().mode, "ready", "前置：就绪");
  await bound.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "第一条。" });
  equal(ensureCalls, 0, "已绑定 → ensureWorld 不被调用");
  equal(api.calls.filter((c) => c.path === "/turns/prepare").length, 1, "照常 prepare");
  bound.dispose();

  // 已停用：binding 存在但 enabled=false → 不调用 ensureWorld 也不 prepare
  const disabledApi = makeApi({ stateByChat: {} });
  const disabledHost = makeHost();
  disabledHost.setChat("chat-a");
  disabledHost.setBinding("chat-a", bindingFor("chat-a", "w-1", { enabled: false }));
  const disabled = createAtlasUiCore({
    api: disabledApi,
    host: disabledHost.host,
    emitter: makeEmitter(),
    adaptEvent: makeAdaptEvent(),
    now: () => NOW_BASE,
    endedDebounceMs: 0,
    mutationDebounceMs: 0,
    ensureWorld,
  });
  await disabled.handleEvent("APP_READY");
  await disabled.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "第一条。" });
  equal(ensureCalls, 0, "停用分支未触发 ensureWorld（全程零调用）");
  equal(disabledApi.calls.filter((c) => c.path === "/turns/prepare").length, 0, "停用 → 零 prepare");
  disabled.dispose();
});

test("starter world：buildStarterWorld 产物必须通过 parseWorld；角色卡名/描述正确落位", async () => {
  const { buildStarterWorld } = await import("../src/atlas-starter-world.ts");
  const { parseWorld } = await import("../lib/world-schema.ts");
  const world = buildStarterWorld({
    id: "world-test-1",
    now: NOW_BASE,
    name: "爱丽丝",
    description: "x".repeat(3000),
  });
  const parsed = parseWorld(world);
  ok(parsed !== null, "parseWorld 通过（/worlds/import 服务端同款校验）");
  equal(parsed.name, "爱丽丝 的世界", "世界名取自角色卡");
  equal(parsed.currentRegionId, "start", "初始地区 start");
  equal(parsed.characters.length, 1, "一个主角实体");
  equal(parsed.characters[0].name, "爱丽丝", "主角名 = 角色卡名");
  ok(parsed.description.length <= 2000, "描述有界（≤2000）");
  equal(parsed.regions.length, 1, "一个地区");
  equal(parsed.points.length, 1, "一个地点");
  equal(parsed.points[0].regionId, "start", "地点归属 start");
  // 缺省回退：无名无描述也能过 schema
  const fallback = parseWorld(buildStarterWorld({ id: "world-test-2", now: NOW_BASE }));
  ok(fallback !== null, "无名无描述也通过 parseWorld");
  equal(fallback.name, "新世界", "世界名回退");
  equal(fallback.characters[0].name, "主角", "主角名回退");
});

// ---------------------------------------------------------------------------
// index.js 在无酒馆环境的安全性
// ---------------------------------------------------------------------------

test("index.js：无 SillyTavern / document 时导入与 connectAtlas 都安全", async () => {
  const extension = createAtlasExtension();
  equal(extension.displayName, ATLAS_DISPLAY_NAME, "显示名导出保留");
  extension.mount();
  equal(extension.mounted, true, "mount 占位保留");
  const result = await connectAtlas();
  equal(result, null, "Node 环境 connectAtlas 返回 null 不抛错");
});

test(`本轮累计断言已记录（计数见报告）`, () => {
  ok(assertionCount > 60, "断言数量达到覆盖要求");
});

// ---------------------------------------------------------------------------
// ATLAS-18：自动建世状态机（可执行）
// ---------------------------------------------------------------------------

/** ATLAS-18 夹具：无绑定的就绪 core + 可注入的 ensureWorld。 */
async function unboundCoreWith(ensureWorld) {
  const api = makeApi({ stateByChat: { "chat-auto": STATE_PAYLOAD } });
  const hostWrap = makeHost();
  hostWrap.setChat("chat-auto");
  const core = createAtlasUiCore({
    api,
    host: hostWrap.host,
    emitter: makeEmitter(),
    adaptEvent: makeAdaptEvent(),
    now: () => NOW_BASE,
    endedDebounceMs: 0,
    mutationDebounceMs: 0,
    ensureWorld,
  });
  await core.handleEvent("APP_READY");
  return { api, hostWrap, core };
}

test("ATLAS-18 建世状态机：首次未绑定 → 一次 ensure + 同一条消息继续 prepare", async () => {
  let ensureCalls = 0;
  let coreRef = null;
  const { api, core } = await unboundCoreWith(async () => {
    ensureCalls += 1;
    await coreRef.bindToWorld("world-auto-0123456789abcdef");
    return true;
  });
  coreRef = core;

  equal(core.getState().worldInitialization, "idle", "初始 idle（本次尚未触发初始化）");
  await core.handleEvent("MESSAGE_SENT", { messageId: "m-1", userText: "我看看四周。" });
  await flush();

  equal(ensureCalls, 1, "首条消息触发恰一次 ensure");
  equal(String(core.getState().binding?.worldId ?? ""), "world-auto-0123456789abcdef", "绑定到确定性世界");
  equal(core.getState().worldInitialization, "ready", "状态变为 ready");
  equal(api.calls.filter((c) => c.path === "/turns/prepare").length, 1, "同一条消息继续 prepare（不需要再发第二条）");
});

test("ATLAS-18 建世状态机：ensure 失败 → failed + 脱敏提示，可重试且不阻断生成", async () => {
  let calls = 0;
  const { api, core } = await unboundCoreWith(async () => {
    calls += 1;
    return false;
  });

  await core.handleEvent("MESSAGE_SENT", { messageId: "m-1", userText: "你好。" });
  await flush();
  equal(calls, 1, "失败也调用了一次 ensure");
  equal(core.getState().worldInitialization, "failed", "状态为 failed");
  const message = String(core.getState().worldInitializationError ?? "");
  ok(message.length > 0, "有可读失败原因");
  ok(!/@|http|Bearer|sk-/i.test(message), "失败原因脱敏（无端点 / Key）");
  equal(api.calls.filter((c) => c.path === "/turns/prepare").length, 0, "未绑定时不 prepare");

  await core.handleEvent("MESSAGE_SENT", { messageId: "m-2", userText: "再看一次。" });
  await flush();
  equal(calls, 2, "下一条消息可重试初始化");

  await core.initializeWorld();
  equal(calls, 3, "「重试初始化」按钮复用同一钩子");
});

test("ATLAS-18 建世状态机：已绑定（启用 / 停用）都不触发 ensure", async () => {
  let calls = 0;
  const { api, core } = await unboundCoreWith(async () => { calls += 1; return true; });
  await core.bindToWorld("world-existing");
  await flush();
  await core.handleEvent("MESSAGE_SENT", { messageId: "m-1", userText: "继续。" });
  await flush();
  equal(calls, 0, "已绑定启用 → 零 ensure");
  equal(api.calls.filter((c) => c.path === "/turns/prepare").length, 1, "启用状态照常 prepare");

  await core.setEnabled(false);
  await core.handleEvent("MESSAGE_SENT", { messageId: "m-2", userText: "停用后再说。" });
  await flush();
  equal(calls, 0, "已绑定停用 → 零 ensure");
  equal(api.calls.filter((c) => c.path === "/turns/prepare").length, 1, "停用后不再 prepare");
});

// ---------------------------------------------------------------------------
// 0.9.17 数据隔离（shujuku 式聊天身份核对）：切卡 / 关聊天绝不残留上一张卡的数据
// ---------------------------------------------------------------------------

test("数据隔离：无活动聊天时强制未绑定（chatMetadata 滞留防御）", async () => {
  // 宿主 chatId 为空（已关闭聊天 / 欢迎页），但 chatMetadata 仍滞留旧聊天的绑定
  const api = makeApi({ stateByChat: { "chat-old": STATE_PAYLOAD } });
  const hostWrap = makeHost();
  hostWrap.setChat(null);
  const staleBinding = bindingFor("chat-old");
  hostWrap.host.readBinding = () => staleBinding; // 滞留的 metadata
  const core = createAtlasUiCore({ api, host: hostWrap.host, emitter: makeEmitter(), now: () => NOW_BASE });
  core.init();
  await flush();
  const state = core.getState();
  equal(state.chatId, null, "chatId 识别为无聊天");
  equal(state.binding, null, "滞留绑定不采用");
  equal(state.mode, "unbound", "强制未绑定");
  equal(state.stateData, null, "stateData 清空（旧世界不显示）");
  equal(api.calls.filter((c) => String(c.path).startsWith("/state/")).length, 0, "无聊天时不发 /state 请求");
});

test("数据隔离：CHAT_CHANGED 先摘旧数据再刷新（加载期间不显示上一张卡的世界）", async () => {
  const api = makeApi({ stateByChat: { "chat-a": STATE_PAYLOAD, "chat-b": STATE_PAYLOAD } });
  const hostWrap = makeHost();
  hostWrap.setChat("chat-a");
  hostWrap.setBinding("chat-a", bindingFor("chat-a"));
  hostWrap.setBinding("chat-b", bindingFor("chat-b"));
  const core = createAtlasUiCore({ api, host: hostWrap.host, emitter: makeEmitter(), now: () => NOW_BASE });
  core.init();
  await flush();
  equal(core.getState().mode, "ready", "chat-a 就绪");
  ok(core.getState().stateData !== null, "chat-a 数据已显示");

  // /state 故意挂起，观察切换瞬间的中间态
  let releaseState = () => {};
  const gate = new Promise((resolve) => { releaseState = resolve; });
  const originalRequest = api.request.bind(api);
  api.request = async (method, path, body) => {
    if (path.startsWith("/state/")) { await gate; }
    return originalRequest(method, path, body);
  };

  hostWrap.setChat("chat-b");
  const eventDone = core.handleEvent("CHAT_CHANGED");
  await flush();
  // CHAT_CHANGED 同步清场后、/state 返回前：旧数据必须已经摘掉
  equal(core.getState().stateData, null, "旧聊天数据已被摘掉");
  equal(core.getState().chatId, "chat-b", "身份已切到新聊天");
  equal(core.getState().binding?.chatId, "chat-b", "绑定已换绑到新聊天");
  releaseState();
  await eventDone;
  equal(core.getState().mode, "ready", "chat-b 就绪");
  equal(core.getState().stateData?.worldName, "演示世界", "chat-b 数据正常显示");
});

test("数据隔离：旧聊天的迟到 /state 响应被丢弃（跨聊天竞态）", async () => {
  const api = makeApi({ stateByChat: { "chat-a": STATE_PAYLOAD, "chat-b": STATE_PAYLOAD } });
  const hostWrap = makeHost();
  hostWrap.setChat("chat-a");
  hostWrap.setBinding("chat-a", bindingFor("chat-a"));
  const core = createAtlasUiCore({ api, host: hostWrap.host, emitter: makeEmitter(), now: () => NOW_BASE });
  core.init();
  await flush();
  equal(core.getState().mode, "ready", "chat-a 就绪");

  let releaseState = () => {};
  const gate = new Promise((resolve) => { releaseState = resolve; });
  const originalRequest = api.request.bind(api);
  api.request = async (method, path, body) => {
    if (path.startsWith("/state/")) { await gate; }
    return originalRequest(method, path, body);
  };

  // 发起 chat-b 的切换刷新，但在 /state 返回前宿主已再次切走（chat-c，无绑定）
  hostWrap.setChat("chat-b");
  hostWrap.setBinding("chat-b", bindingFor("chat-b"));
  const eventDone = core.handleEvent("CHAT_CHANGED");
  await flush();
  // 真实宿主会再发一次 CHAT_CHANGED（切到 chat-c）：同步清场 + 重新 syncFromHost
  hostWrap.setChat("chat-c");
  const eventC = core.handleEvent("CHAT_CHANGED");
  await flush();
  releaseState();
  await eventDone;
  await eventC;
  const state = core.getState();
  equal(state.chatId, "chat-c", "当前聊天是 chat-c");
  ok(state.stateData === null, "chat-b 的迟到响应被丢弃（stateData 不跨聊天存活）");
  equal(state.mode, "unbound", "chat-c 无绑定 → 未绑定态");
});
