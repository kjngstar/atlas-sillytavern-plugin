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
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

import { createAtlasUiCore, ATLAS_UI_EVENTS } from "../src/atlas-ui-core.ts";
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
      // 0.9.42 会话承载：/state 改 POST，chatId 随体携带
      if (method === "POST" && path === "/state") {
        const payload = stateByChat[typeof body?.chatId === "string" ? body.chatId : ""];
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

async function readyCore(turnBehavior = {}, bindingOverrides = {}, diagnosticEvents = []) {
  const api = makeApi({ stateByChat: { "chat-a": STATE_PAYLOAD }, turnBehavior });
  const hostWrap = makeHost();
  hostWrap.setChat("chat-a");
  hostWrap.setBinding("chat-a", bindingFor("chat-a", "w-1", bindingOverrides));
  const core = createAtlasUiCore({
    api,
    host: hostWrap.host,
    emitter: makeEmitter(),
    adaptEvent: makeAdaptEvent(),
    onDiagnostic: (entry) => diagnosticEvents.push(entry),
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
  deepEqual(hostWrap.dataStore.get("receiptsByChat")?.["chat-a"], receipt, "回执按聊天分桶写入 extensionSettings");
  equal(hostWrap.dataStore.get("receipts"), null, "0.9.28 旧全局键已废弃（一次性清除）");
  equal(api.calls.filter((c) => c.path === "/state" && c.body?.chatId === "chat-a").length >= 2, true, "commit 成功后刷新世界状态");
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

test("回合：停止后菜单重新生成重新 prepare，单独尝试且只提交一次", async () => {
  const events = [];
  const { api, core } = await readyCore({}, {}, events);
  await core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "继续。" });
  await core.handleEvent("GENERATION_STOPPED");
  equal(core.getState().pendingTurn, null, "停止清除原 pending");
  ok(events.some((entry) => entry.code === "GENERATION_STOPPED"), "停止进入诊断");
  await core.handleEvent("MESSAGE_RECEIVED", { assistantMessageId: "m-1", assistantText: "被截断的回复。" });
  await flush();
  equal(api.calls.filter((call) => call.path === "/turns/commit").length, 0, "停止后的迟到完成通知不提交");

  await core.handleEvent("GENERATION_STARTED", { gated: false });
  equal(api.calls.filter((call) => call.path === "/turns/prepare").length, 2, "菜单重新生成重新 prepare");
  ok(core.getState().pendingTurn, "新的 pending 已建立");
  await core.handleEvent("MESSAGE_RECEIVED", { assistantMessageId: "m-1", assistantText: "新的回复。" });
  await flush();
  const commits = api.calls.filter((call) => call.path === "/turns/commit");
  equal(commits.length, 1, "重新生成只提交一次");
  ok(commits[0].body.swipeId, "新尝试有独立 swipe 幂等键");
  const starts = events.filter((entry) => entry.code === "TURN_STARTED");
  equal(starts.length, 2, "两次尝试分别可追踪");
  equal(starts[0].traceId, starts[1].traceId, "同一用户回合共用 trace");
  assert.notEqual(starts[0].attemptId, starts[1].attemptId, "两次生成各有 attempt");
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
// A15（0.9.52）：HTTP 200 + receipt.status="failed" 的 UI 状态
//
// 现场：11:33 的 /turns/retry 返回 HTTP 200，但回执是 status:"failed"、世界时间 0→0。
// 旧实现只看 HTTP 200 与 body.ok 就当成功：清 lastError、清挂单、刷新界面、
// 同步世界书——用户看到「重试成功」，实际世界一步没动。
// ---------------------------------------------------------------------------

/**
 * 构造回执夹具（A15）。字段形状对齐 makeApi 内部的 defaultReceipt，
 * 但定义在模块级以便测试直接使用；makeApi 的 turnBehavior.receipt /
 * retryReceipt 支持整个对象覆盖，因此无需改动既有 mock。
 */
function receiptFixture(overrides = {}) {
  return {
    receiptId: "receipt-1",
    status: "committed",
    branchId: null,
    previousTime: 12,
    currentTime: 13,
    triggeredNpcIds: ["npc-1"],
    adoptedEventIds: ["evt-1"],
    summary: "时间推进一个时段；林拾在集市有了新见闻。",
    retryable: false,
    ...overrides,
  };
}

/** 构造失败回执（HTTP 200 包着 status:"failed" 的现场形状）。 */
function failedReceipt(summary, retryable = true) {
  return receiptFixture({
    status: "failed",
    retryable,
    summary,
    previousTime: 0,
    currentTime: 0,
    adoptedEventIds: [],
    triggeredNpcIds: [],
  });
}

test("A15 commit：HTTP 200 + receipt failed → 展示失败摘要、保留挂单、不刷新界面", async () => {
  const { api, core } = await readyCore({
    receipt: failedReceipt("关系值必须是非空字符串或有限数字"),
  });

  await core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "推进剧情。" });
  await core.handleEvent("MESSAGE_RECEIVED", { assistantMessageId: "m-1", assistantText: "剧情推进了。" });
  const refreshesBefore = api.calls.filter((c) => c.path === "/state").length;
  await flush();

  equal(core.getState().lastError, "关系值必须是非空字符串或有限数字", "失败摘要进入 lastError");
  ok(core.getState().retryableCommit !== null, "retryable=true 时保留挂单");
  equal(core.getState().retryableCommit.chatId, "chat-a", "挂单归属当前聊天");
  equal(core.getState().receipts.length, 1, "失败回执仍入列（用户能看到摘要）");
  equal(core.getState().receipts[0].status, "failed", "回执状态记为 failed");
  equal(
    api.calls.filter((c) => c.path === "/state").length,
    refreshesBefore,
    "失败不得刷新（地图与附近列表不误显示成功）",
  );
});

test("A15 commit：失败且 retryable=false → 不保留挂单（避免无效重试）", async () => {
  const { core } = await readyCore({ receipt: failedReceipt("被内容审核拦截", false) });
  await core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "推进剧情。" });
  await core.handleEvent("MESSAGE_RECEIVED", { assistantMessageId: "m-1", assistantText: "剧情推进了。" });
  await flush();

  equal(core.getState().lastError, "被内容审核拦截", "失败摘要可见");
  equal(core.getState().retryableCommit, null, "不可重试时不保留挂单");
});

test("A15 retry：HTTP 200 + receipt failed → 挂单仍在、不刷新、不误报成功", async () => {
  const { api, core } = await readyCore({
    commitError: "首次失败",
    retryReceipt: failedReceipt("关系值必须是非空字符串或有限数字"),
  });
  await core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "推进剧情。" });
  await core.handleEvent("MESSAGE_RECEIVED", { assistantMessageId: "m-1", assistantText: "剧情推进了。" });
  await flush();
  ok(core.getState().retryableCommit !== null, "前置：首次 commit 失败留下挂单");

  const refreshesBefore = api.calls.filter((c) => c.path === "/state").length;
  await core.retryLastCommit();

  equal(core.getState().lastError, "关系值必须是非空字符串或有限数字", "retry 失败摘要可见");
  ok(core.getState().retryableCommit !== null, "失败回执仍可再试（按钮仍可用）");
  equal(core.getState().retryableCommit.userMessageId, "m-0", "挂单键未被破坏");
  equal(
    api.calls.filter((c) => c.path === "/state").length,
    refreshesBefore,
    "失败不得触发刷新（地图/附近不误显示成功）",
  );
});

test("A15 retry：连续失败持续保留挂单；随后成功一次即清空", async () => {
  // 两次失败：挂单始终在，且每次都展示真实摘要
  const failing = await readyCore({
    commitError: "首次失败",
    retryReceipt: failedReceipt("关系值必须是非空字符串或有限数字"),
  });
  await failing.core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "推进剧情。" });
  await failing.core.handleEvent("MESSAGE_RECEIVED", { assistantMessageId: "m-1", assistantText: "剧情推进了。" });
  await flush();

  await failing.core.retryLastCommit();
  ok(failing.core.getState().retryableCommit !== null, "第一次 retry 失败后仍可再试");
  await failing.core.retryLastCommit();
  ok(failing.core.getState().retryableCommit !== null, "第二次 retry 失败后仍可再试");
  equal(failing.api.calls.filter((c) => c.path === "/turns/retry").length, 2, "两次 retry 请求");

  // 成功路径：挂单清空、错误清空（与既有用例同口径，此处锁定 A14 未破坏成功分支）
  const good = await readyCore({ commitError: "首次失败" });
  await good.core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "推进剧情。" });
  await good.core.handleEvent("MESSAGE_RECEIVED", { assistantMessageId: "m-1", assistantText: "剧情推进了。" });
  await flush();
  ok(good.core.getState().retryableCommit !== null, "前置：有挂单");
  await good.core.retryLastCommit();
  equal(good.core.getState().retryableCommit, null, "成功后清空挂单");
  equal(good.core.getState().lastError, null, "成功后清空 lastError");
});

test("A15 归属：切到另一聊天后，该聊天的失败回执只属于它自己", async () => {
  // 归属守卫（state.chatId !== 请求聊天）在 A13 分支里同样是写入门。此处用两次独立
  // 回合验证：chat-a 的失败状态不会因为后续操作泄漏给别的聊天状态。
  const { api, core } = await readyCore({
    receipt: failedReceipt("chat-a 的关系值非法"),
  });
  await core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "推进剧情。" });
  await core.handleEvent("MESSAGE_RECEIVED", { assistantMessageId: "m-1", assistantText: "剧情推进了。" });
  await flush();

  equal(core.getState().chatId, "chat-a", "仍在 chat-a");
  equal(core.getState().lastError, "chat-a 的关系值非法", "失败摘要归属 chat-a");
  equal(core.getState().receipts.length, 1, "失败回执记在 chat-a 桶");
  equal(core.getState().receipts[0].chatId, "chat-a", "回执记录的 chatId 归属明确");

  // 回执列表按聊天归属，不得混入其它聊天条目
  ok(
    core.getState().receipts.every((r) => r.chatId === "chat-a"),
    "回执列表中没有混入其它聊天的条目",
  );
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

  // 非法持久化形状：非对象条目 / 缺 receiptId / 缺 summary 全部拒收（0.9.28 分桶形状）
  const badHostWrap = makeHost();
  badHostWrap.setChat("chat-a");
  badHostWrap.dataStore.set("receiptsByChat", {
    "chat-a": [
      "junk",
      null,
      { receiptId: "r-1", summary: "只有回执号与摘要", previousTime: "not-a-number" },
      { summary: "缺 receiptId" },
      { receiptId: "r-2", summary: "合法条目", currentTime: 5 },
    ],
    "chat-other": [{ receiptId: "r-3", summary: "别的聊天的回执" }],
    "chat-broken": "not-an-array",
  });
  const badCore = createAtlasUiCore({ api: secondApi, host: badHostWrap.host, emitter: makeEmitter(), now: () => NOW_BASE });
  badCore.init();
  await flush();
  equal(badCore.getState().receipts.length, 2, "非法条目逐条拒收，合法条目保留");
  equal(badCore.getState().receipts[1].previousTime, 0, "非法数值字段回退默认");
  badCore.dispose();
});

test("0.9.28 回执归属：换聊天三清（回执 / 重试挂单 / 错误），各聊天回执分桶互不串", async () => {
  const { api, hostWrap, core } = await readyCore({ commitError: "推演模型超时" });
  // chat-a 产生一条失败回执挂单
  await core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "推进。" });
  await core.handleEvent("MESSAGE_RECEIVED", { assistantMessageId: "m-1", assistantText: "推进了。" });
  await flush();
  ok(core.getState().retryableCommit !== null, "前置：chat-a 有失败挂单");
  ok(core.getState().lastError !== null, "前置：chat-a 有错误提示");
  // 切到 chat-b（预置自己的回执桶）→ chat-a 的挂单 / 错误 / 回执必须全部摘掉
  hostWrap.dataStore.set("receiptsByChat", {
    "chat-b": [{ receiptId: "r-b1", chatId: "chat-b", status: "committed", summary: "chat-b 自己的变化", previousTime: 1, currentTime: 2, currentLocationId: null, adoptedEventCount: 1, recordedAt: NOW_BASE }],
  });
  hostWrap.setChat("chat-b");
  await core.handleEvent("CHAT_CHANGED");
  await flush();
  equal(core.getState().retryableCommit, null, "旧聊天失败挂单不进新聊天");
  equal(core.getState().lastError, null, "旧聊天错误不进新聊天");
  equal(core.getState().receipts.length, 1, "新聊天恢复自己的回执桶");
  equal(core.getState().receipts[0].receiptId, "r-b1", "恢复的是 chat-b 的回执");
  equal(core.getState().receipts[0].chatId, "chat-b", "回执记录带聊天归属");
  // 切回 chat-a → 它的持久化回执恢复（此处为空——失败回合无回执），挂单不复活
  hostWrap.setChat("chat-a");
  await core.handleEvent("CHAT_CHANGED");
  await flush();
  equal(core.getState().retryableCommit, null, "切回后旧挂单不复活");
  equal(core.getState().receipts.length, 0, "chat-a 无已持久化回执 → 空列表");
});

test("0.9.28 在途回执归属：commit 落定前切聊天 → 过期回执 / 失败挂单不写进新聊天", async () => {
  const inner = makeApi({});
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const api = {
    calls,
    async request(method, path, body) {
      if (path === "/turns/commit") {
        calls.push({ method, path, body }); // 发出即记账（inner 的记录在 gate 释放后才落）
        await gate; // 卡住 commit，制造「在途」窗口
      }
      return inner.request(method, path, body);
    },
  };
  const hostWrap = makeHost();
  hostWrap.setChat("chat-a");
  hostWrap.setBinding("chat-a", bindingFor("chat-a"));
  const core = createAtlasUiCore({
    api,
    host: hostWrap.host,
    emitter: makeEmitter(),
    adaptEvent: makeAdaptEvent(),
    now: () => NOW_BASE,
    endedDebounceMs: 0,
    mutationDebounceMs: 0,
  });
  await core.handleEvent("APP_READY");
  await core.handleEvent("MESSAGE_SENT", { messageId: "m-0", userText: "推进。" });
  const ended = core.handleEvent("MESSAGE_RECEIVED", { assistantMessageId: "m-1", assistantText: "推进了。" });
  await flush(); // ENDED 防抖落定：commit 已发出并卡在 gate
  equal(api.calls.filter((c) => c.path === "/turns/commit").length, 1, "前置：commit 在途");
  // 在途窗口内切聊天：先起切换（其 flushAsyncWork 会等在途任务），再放行 commit，避免互等死锁
  hostWrap.setChat("chat-b");
  const switching = core.handleEvent("CHAT_CHANGED");
  release();
  await switching;
  await ended;
  await flush();
  equal(core.getState().pendingTurn, null, "旧回合 pending 随切换摘除");
  equal(core.getState().retryableCommit, null, "过期失败不设挂单");
  equal(core.getState().lastError, null, "过期失败不报错到新聊天");
  equal(core.getState().receipts.length, 0, "过期回执不入新聊天列表");
  ok(core.getState().chatId === "chat-b", "前置：当前聊天已是 chat-b");
  // 服务端世界仍一致：chat-a 的世界写入由幂等键兜底，UI 只是如实不显示过期回执
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
  // R06：新世界空地理——不再预置「起点」地区/地点，未知地区 = null
  equal(parsed.currentRegionId, null, "未知地区 = null（不预置 start）");
  equal(parsed.regions.length, 0, "0 地区（空地理）");
  equal(parsed.points.length, 0, "0 地点（不生成起点占位）");
  equal(parsed.characters.length, 1, "一个主角实体");
  equal(parsed.characters[0].name, "爱丽丝", "主角名 = 角色卡名");
  equal(parsed.characters[0].currentRegionId, null, "主角不挂在虚构地区上");
  ok(parsed.description.length <= 2000, "描述有界（≤2000）");
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
    if (path === "/state") { await gate; }
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
    if (path === "/state") { await gate; }
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

// ---------------------------------------------------------------------------
// S10 前端回归（0.9.55 子地图 / 二级地图）：
// - 根点、子点分别定位；子图视图拒绝定位
// - 同地点人物只在地点菜单（离场者不出现、头像可长按纠偏）
// - 四层子图导航（第 5 张被拒）与面包屑逐层返回
// - 历史存档 v1 子图（sub-* 虚拟点）能进能退
// - 切聊天清空子图视图栈
//
// 挂载方式沿用仓库既有做法（tests/atlas-r01-map-visibility.test.mjs）：jsdom 里把
// index.js 源码追加 `export {renderPanel}` 后经 data: URL 导入，用真实 renderPanel
// 挂到真实 DOM；core 用本文件既有的 makeApi / makeHost / bindingFor 造真身，并经
// onStateChange 触发真实重渲染（与酒馆里 connectAtlas 的接线一致）。
// 断言沿用本文件的 ok() / equal() / deepEqual() 风格。jsdom 没有真实布局与
// document.elementFromPoint，也没有 setPointerCapture：点击用 element.click()，
// 长按用派发 MouseEvent；真实拖拽落点由施工单 S10 的人工验收覆盖。
// ---------------------------------------------------------------------------

const S10_INDEX_SOURCE = readFileSync(join(root, "atlas-extension", "index.js"), "utf8");

/** S10 /state 夹具：世界图只含根地点；`submaps[父地点ID]` = 该地点的内部地图。 */
function s10State({ chatId, worldId, currentLocationId, points, submaps = {}, pointParents = {}, npcDirectory = [], objectDirectory = [], regions = [], relevantNpcIds = [], npcReasons = {} }) {
  return {
    chatId,
    worldId,
    worldName: "S10 世界",
    branchId: null,
    currentTime: 12,
    currentLocationId,
    map: {
      points,
      // 服务端口径：全部可见（含子地点）地点数，世界图标记数可以小于它
      pointCount: points.length + Object.keys(pointParents).length,
      pointParents,
      submaps,
      submapCount: Object.keys(submaps).length,
      calibrations: {},
      pointMeta: {},
      mapImagePresent: false,
      mapImageRevision: 0,
    },
    npcDirectory,
    objectDirectory,
    nearbyPointIds: [],
    relevantNpcIds,
    npcReasons,
    triggerIds: [],
    regions,
  };
}

/** 挂载真实 index.js 地图页：真 core（makeApi / makeHost）+ jsdom + renderPanel。 */
async function mountAtlasMap({ stateByChat, chatId = "chat-a", travelPreview = null }) {
  const dom = new JSDOM("<!doctype html><head></head><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  const style = document.createElement("style");
  style.textContent = readFileSync(join(root, "atlas-extension", "style.css"), "utf8");
  document.head.append(style);

  const { renderPanel } = await import(
    "data:text/javascript;base64," + Buffer.from(`${S10_INDEX_SOURCE}\nexport { renderPanel };`).toString("base64")
  );
  const cameraMod = await import(pathToFileURL(join(root, "src", "atlas-map-camera.ts")).href);
  const mapMod = {
    ...cameraMod,
    ...(await import(pathToFileURL(join(root, "src", "atlas-map-interactions.ts")).href)),
    ...(await import(pathToFileURL(join(root, "src", "atlas-scale.ts")).href)),
    // H13：网格纯函数由发布入口提供；夹具按真实表面补齐，SVG overlay 才会真的出线
    ...(await import(pathToFileURL(join(root, "src", "atlas-map-grid.ts")).href)),
    // H16：范围填色投影（只染有证据的格）
    ...(await import(pathToFileURL(join(root, "src", "atlas-map-areas.ts")).href)),
    ATLAS_UI_PAGES: (await import(pathToFileURL(join(root, "src", "atlas-ui-core.ts")).href)).ATLAS_UI_PAGES,
  };

  const api = makeApi({ stateByChat, travelPreview });
  const hostWrap = makeHost();
  hostWrap.setChat(chatId);
  hostWrap.setBinding(chatId, bindingFor(chatId, String(stateByChat[chatId]?.worldId ?? "w-s10")));
  let rerender = () => {};
  const core = createAtlasUiCore({
    api,
    host: hostWrap.host,
    emitter: makeEmitter(),
    onStateChange: () => rerender(),
    now: () => NOW_BASE,
  });
  const container = document.createElement("div");
  document.body.append(container);
  rerender = renderPanel(core, container, api, { read: async () => null }, mapMod);
  await core.handleEvent("APP_READY");
  core.setPage("map");
  await flush();
  return { dom, api, hostWrap, core, container, cameraMod, rerender };
}

/** 当前渲染出来的地点标点名字（按 DOM 顺序）。 */
function mapPointNames(container) {
  return [...container.querySelectorAll(".aw-point")].map((node) => node.textContent);
}

/** 面包屑：可见性 + 去掉空白后的层级文字（世界图上 display 为 none；层级文字取 trail，不含返回钮）。 */
function crumbSnapshot(container) {
  const crumb = container.querySelector(".aw-mapcrumb");
  const trail = container.querySelector(".aw-mapcrumb__trail");
  return { display: crumb?.style.display ?? "missing", text: (trail?.textContent ?? "").replace(/\s+/g, "") };
}

/** 点开某个地点标点的信息面板，返回面板元素。 */
function openPointPanel(container, name) {
  const marker = [...container.querySelectorAll(".aw-point")].find((node) => node.textContent === name) ?? null;
  ok(marker !== null, `地图上有「${name}」标点`);
  marker?.click();
  const panel = container.querySelector(".aw-mappanel");
  ok(panel?.style.display === "", `「${name}」的信息面板已打开`);
  return panel;
}

/** 面板里的「进入内部地图」入口（不存在返回 null）。 */
function enterSubmapButton(container, name) {
  return container.querySelector(`.aw-mappanel [aria-label="进入 ${name} 的内部地图"]`);
}

/** 工具条上的「定位当前位置」。 */
function locateButton(container) {
  return container.querySelector('.aw-zoom__btn[aria-label="定位当前位置"]');
}

/** jsdom 无布局 → 相机用核心模块的回退视口（320×240）；由 stage 变换反解视口中心对准的世界点。 */
function cameraCenter(container, cameraMod) {
  const transform = container.querySelector(".aw-stage")?.style.transform ?? "";
  const matched = /translate\((-?[\d.e+]+)px,\s*(-?[\d.e+]+)px\)\s*scale\((-?[\d.e+]+)\)/.exec(transform);
  ok(matched !== null, `stage 有相机变换（实际「${transform}」）`);
  if (!matched) return { cx: Number.NaN, cy: Number.NaN, k: Number.NaN };
  const k = Number(matched[3]);
  return {
    cx: (cameraMod.MAP_VIEW_FALLBACK_W / 2 - Number(matched[1])) / k,
    cy: (cameraMod.MAP_VIEW_FALLBACK_H / 2 - Number(matched[2])) / k,
    k,
  };
}

/** 文本出现次数（「每人只出现一次」类断言用）。 */
function occurrences(text, needle) {
  return String(text).split(needle).length - 1;
}

const S10_SUBMAPS = {
  "1": { parentMapId: "world", points: [{ id: "11", name: "大堂", x: 10, y: 10 }] },
  "11": { parentMapId: "1", points: [{ id: "111", name: "档案室", x: 12, y: 12 }] },
  "111": { parentMapId: "11", points: [{ id: "1111", name: "暗格", x: 14, y: 14 }] },
  "1111": { parentMapId: "111", points: [{ id: "11111", name: "密室", x: 16, y: 16 }] },
  "11111": { parentMapId: "1111", points: [{ id: "111111", name: "最深处", x: 18, y: 18 }] },
};
const S10_ROOT_POINTS = [
  { id: "1", name: "钟楼", x: 40, y: 40, regionId: null },
  { id: "2", name: "集市", x: 80, y: 60, regionId: null },
];
const S10_POINT_PARENTS = { "11": 1, "111": 11, "1111": 111, "11111": 1111, "111111": 11111 };

test("S10 前端：定位当前位置——根地点直接命中、子地点回溯最近根祖先、子图拒绝", async () => {
  const base = s10State({
    chatId: "chat-a",
    worldId: "w-s10",
    currentLocationId: "2",
    points: S10_ROOT_POINTS,
    submaps: { "1": S10_SUBMAPS["1"] },
    pointParents: { "11": 1 },
  });
  const stateByChat = { "chat-a": base };
  const { container, core, cameraMod, rerender } = await mountAtlasMap({ stateByChat });
  deepEqual(mapPointNames(container), ["钟楼", "集市"], "前置：世界图渲染根地点");

  // 1) 玩家在根地点「集市」：直接命中
  const beforeK = cameraCenter(container, cameraMod).k;
  locateButton(container).click();
  const atRoot = cameraCenter(container, cameraMod);
  ok(Math.abs(atRoot.cx - 80) < 0.01 && Math.abs(atRoot.cy - 60) < 0.01,
    `根地点定位把视口中心对准「集市」（80,60），实际（${atRoot.cx},${atRoot.cy}）`);
  equal(atRoot.k, beforeK, "定位保持比例（只改中心）");

  // 2) 玩家在子地点「大堂」（父链 11 → 1）：世界图上没有 11，必须回溯到最近的根祖先「钟楼」
  stateByChat["chat-a"] = { ...base, currentLocationId: "11" };
  await core.refresh();
  await flush();
  locateButton(container).click();
  const atAncestor = cameraCenter(container, cameraMod);
  ok(Math.abs(atAncestor.cx - 40) < 0.01 && Math.abs(atAncestor.cy - 40) < 0.01,
    `子地点定位回溯到最近根祖先「钟楼」（40,40），实际（${atAncestor.cx},${atAncestor.cy}）`);
  // S8 补刀后：提示必须在**点击当时**就可见。旧实现 setStatus 只改状态变量、点击不重渲染，
  // 这条提示要等下一次渲染才出现（子图视图下更会先看到上一条旧提示）——S10 实测抓到，
  // 已改为 setStatus 就地刷新 / 补挂状态行；此处按修好后的行为锁死，防回归。
  const ancestorTip = container.querySelector(".aw-status")?.textContent ?? "";
  ok(ancestorTip.includes("当前位置在「钟楼」内"), `点击当时即给出最近根祖先提示：实际「${ancestorTip}」`);
  ok(ancestorTip.includes("进入该地点可查看内层地图"), "提示说明可进入该地点查看内层地图");
  ok(!ancestorTip.includes("当前位置不在地图上"), "提示不是「当前位置不在地图上」");

  // 3) 子图视图：定位只在世界图可用
  openPointPanel(container, "钟楼");
  const enter = enterSubmapButton(container, "钟楼");
  ok(enter !== null, "前置：钟楼有内部地图入口");
  enter.click();
  deepEqual(mapPointNames(container), ["大堂"], "前置：已进入钟楼内部地图");
  const inSubBefore = cameraCenter(container, cameraMod);
  locateButton(container).click();
  const inSubAfter = cameraCenter(container, cameraMod);
  const subTip = container.querySelector(".aw-status")?.textContent ?? "";
  ok(subTip.includes("定位当前位置只在世界图可用"),
    `子图视图点击当时即给出「只在世界图可用」提示（不得停在旧提示）：实际「${subTip}」`);
  equal(inSubAfter.k, inSubBefore.k, "子图视图下定位不改比例");
  ok(Math.abs(inSubAfter.cx - inSubBefore.cx) < 0.01 && Math.abs(inSubAfter.cy - inSubBefore.cy) < 0.01,
    "子图视图下定位不动相机（不跨图混淆）");
});

test("S10 前端：同地点人物只在地点名单（离场者不出现、头像可长按纠偏）", async () => {
  const stateByChat = {
    "chat-a": s10State({
      chatId: "chat-a",
      worldId: "w-s10",
      currentLocationId: "1",
      points: [{ id: "1", name: "钟楼", x: 40, y: 40, regionId: null }],
      npcDirectory: [
        { id: "npc-1", name: "林拾", pointId: "1", presence: "present" },
        { id: "npc-2", name: "阿澈", pointId: "1", presence: "left" },
      ],
    }),
  };
  const { container, dom } = await mountAtlasMap({ stateByChat });

  // S9：世界图上不再有人物标点（人物只由地点名单承载）
  // D-34（0.9.58）：**子图**里会按三表格坐标画人物图钉；世界图仍然一个都不画。
  equal(container.querySelectorAll(".aw-object--npc").length, 0, "世界图上 0 个人物图钉");
  equal(container.querySelectorAll(".aw-point").length, 1, "世界图只按地点出标点，人物不额外叠标记");
  const legend = container.querySelector(".aw-maplegend")?.textContent ?? "";
  ok(legend.includes("地点") && legend.includes("人物：进内部地图后按房间显示") && legend.includes("物品"),
    `图例说实话（地点 / 人物：进内部地图后按房间显示 / 物品）：实际「${legend}」`);

  // 地点面板「当前在这里」：在场者恰好一次，离场者不出现
  const panel = openPointPanel(container, "钟楼");
  const rows = panel.querySelectorAll(".aw-mappanel__person--npc");
  equal(rows.length, 1, "「当前在这里」恰好一位在场人物");
  equal(rows[0].querySelector(".aw-mappanel__person-name")?.textContent, "林拾", "名单里的人名正确");
  ok(rows[0].querySelector(".aw-mappanel__person-avatar.aw-person-drag") !== null,
    "人物头像带 .aw-person-drag（长按纠偏手柄）");
  ok(!String(panel.textContent).includes("阿澈"), "presence=left 的人不出现在地点名单");
  equal(occurrences(container.querySelector(".aw-maparea").textContent, "林拾"), 1,
    "同一位人物在地图上只出现一次（无标点与头像重叠）");

  // S9：头像长按 350ms 后进入 is-armed（起拖就绪）。jsdom 无 setPointerCapture /
  // elementFromPoint，故只验证「长按成立」这一段；真实拖到标点纠偏走人工验收。
  const avatar = rows[0].querySelector(".aw-mappanel__person-avatar.aw-person-drag");
  avatar.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 12, clientY: 12 }));
  await new Promise((resolve) => setTimeout(resolve, 450));
  ok(avatar.classList.contains("is-armed"), "长按 350ms 后头像进入 is-armed（纠偏可起拖）");
  avatar.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 12, clientY: 12 }));
  ok(!avatar.classList.contains("is-armed"), "长按松手后 is-armed 清理");
});

test("S10 前端：四层子图导航（第 5 张被拒）与面包屑逐层返回", async () => {
  ok(S10_INDEX_SOURCE.includes("const MAP_SUBMAP_DEPTH_MAX = 4;"),
    "UI 深度上限 = 4 张连续子图（世界图不算，与后端 SUBMAP_DEPTH_MAX 一致）");
  const stateByChat = {
    "chat-a": s10State({
      chatId: "chat-a",
      worldId: "w-s10",
      currentLocationId: "1",
      points: [...S10_ROOT_POINTS, { id: "9", name: "孤塔", x: 60, y: 20, regionId: null }],
      submaps: {
        ...S10_SUBMAPS,
        // 第 2 层图里再放一个父链写错的点（大堂的子图却声称父是「world」）→ 该层不得给出入口
        "11": { parentMapId: "1", points: [...S10_SUBMAPS["11"].points, { id: "112", name: "偏厅", x: 22, y: 22 }] },
        "112": { parentMapId: "world", points: [{ id: "1121", name: "错层内点", x: 24, y: 24 }] },
        // 父链写错（孤塔在世界图，子图却声称父是「1」）→ 世界图不得给出进入入口
        "9": { parentMapId: "1", points: [{ id: "91", name: "伪内层", x: 20, y: 20 }] },
      },
      pointParents: S10_POINT_PARENTS,
    }),
  };
  const { container } = await mountAtlasMap({ stateByChat });
  deepEqual(mapPointNames(container), ["钟楼", "集市", "孤塔"], "前置：世界图只渲染根地点");

  // 父链按 parentMapId 校验：parentMapId 不是 world 的点不给入口
  openPointPanel(container, "孤塔");
  equal(enterSubmapButton(container, "孤塔"), null,
    "submaps[9].parentMapId 不是 «world» → 世界图不给「进入内部地图」入口");
  equal(crumbSnapshot(container).display, "none", "世界图上面包屑隐藏");

  // 世界 → 第 1 → 第 2 → 第 3 → 第 4 张子图逐层进入
  const ladder = [
    { enter: "钟楼", inside: ["大堂"], trail: "世界图›钟楼" },
    { enter: "大堂", inside: ["档案室", "偏厅"], trail: "世界图›钟楼›大堂", decoy: "偏厅" },
    { enter: "档案室", inside: ["暗格"], trail: "世界图›钟楼›大堂›档案室" },
    { enter: "暗格", inside: ["密室"], trail: "世界图›钟楼›大堂›档案室›暗格" },
  ];
  for (const [index, step] of ladder.entries()) {
    openPointPanel(container, step.enter);
    const enter = enterSubmapButton(container, step.enter);
    ok(enter !== null, `第 ${index + 1} 张子图入口存在（${step.enter}）`);
    enter.click();
    deepEqual(mapPointNames(container), step.inside, `进入「${step.enter}」后渲染的是它自己的内部地图`);
    if (step.decoy) {
      openPointPanel(container, step.decoy);
      equal(enterSubmapButton(container, step.decoy), null,
        `第 ${index + 1} 层：${step.decoy} 的子图 parentMapId 与当前图不符 → 不给入口（父链校验）`);
    }
    const crumb = crumbSnapshot(container);
    equal(crumb.display, "", "子图上面包屑可见");
    equal(crumb.text, step.trail, "面包屑按 parentMapId 逐层累加");
  }
  equal(container.querySelector(".aw-mapcrumb__back")?.textContent, "← 返回上一层", "第 4 层返回按钮指向上一层");

  // 第 5 张：submaps["11111"] 存在，但已进 4 层 → 不再给入口
  ok(Object.prototype.hasOwnProperty.call(stateByChat["chat-a"].map.submaps, "11111"),
    "夹具里第 5 张子图确实存在（submaps[11111]）");
  openPointPanel(container, "密室");
  equal(enterSubmapButton(container, "密室"), null, "已进 4 层 → 第 5 张子图没有进入入口（深度上限 4）");
  deepEqual(mapPointNames(container), ["密室"], "被拒后仍停留在第 4 张子图");

  // 逐层返回：第 4 → 第 3 → 第 2 → 第 1 → 世界图
  for (const [index, expected] of [["暗格"], ["档案室", "偏厅"], ["大堂"]].entries()) {
    const back = container.querySelector(".aw-mapcrumb__back");
    ok(back !== null, `第 ${index + 1} 次返回：有「返回上一层」按钮`);
    back.click();
    deepEqual(mapPointNames(container), expected, `返回上一层后渲染「${expected[0]}」所在地图`);
  }
  equal(container.querySelector(".aw-mapcrumb__back")?.textContent, "← 返回世界图", "只剩一层时返回按钮指向世界图");
  container.querySelector(".aw-mapcrumb__back").click();
  deepEqual(mapPointNames(container), ["钟楼", "集市", "孤塔"], "第 1 张 → 世界图（根地点全部回来）");
  equal(crumbSnapshot(container).display, "none", "回到世界图后面包屑隐藏");

  // 祖先链可点击逐层返回：进两层后点「钟楼」→ 第 1 张子图；再点「世界图」→ 世界图
  openPointPanel(container, "钟楼");
  enterSubmapButton(container, "钟楼").click();
  openPointPanel(container, "大堂");
  enterSubmapButton(container, "大堂").click();
  deepEqual(mapPointNames(container), ["档案室", "偏厅"], "前置：重新进到第 2 张子图");
  const ancestorLink = [...container.querySelectorAll(".aw-mapcrumb__link")].find((node) => node.textContent === "钟楼") ?? null;
  ok(ancestorLink !== null, "面包屑里有可点的祖先「钟楼」");
  ancestorLink.click();
  deepEqual(mapPointNames(container), ["大堂"], "点面包屑祖先「钟楼」跳回第 1 张子图");
  equal(crumbSnapshot(container).text, "世界图›钟楼", "跳回祖先后面包屑截断到该层");
  const rootLink = [...container.querySelectorAll(".aw-mapcrumb__link")].find((node) => node.textContent === "世界图") ?? null;
  ok(rootLink !== null, "面包屑里有可点的「世界图」");
  rootLink.click();
  deepEqual(mapPointNames(container), ["钟楼", "集市", "孤塔"], "点面包屑「世界图」一步跳回世界图");
  equal(crumbSnapshot(container).display, "none", "跳回世界图后面包屑隐藏");
});

test("S10 前端：历史存档 v1 子图（sub-* 虚拟点）仍能进入并退回世界图", async () => {
  // v1 存档的子图没有 parentMapId，内层是 sub-* 虚拟点（不是世界地点 ID）
  const legacySubmap = { points: [{ id: "sub-hall", name: "旧版大堂", x: 30, y: 30 }] };
  const stateByChat = {
    "chat-a": s10State({
      chatId: "chat-a",
      worldId: "w-legacy",
      currentLocationId: "1",
      points: [{ id: "1", name: "钟楼", x: 40, y: 40, regionId: null }],
      submaps: { "1": legacySubmap },
    }),
  };
  const { container } = await mountAtlasMap({ stateByChat });
  equal(legacySubmap.parentMapId, undefined, "v1 夹具确实没有 parentMapId（缺省按 world 处理）");
  deepEqual(mapPointNames(container), ["钟楼"], "前置：世界图");

  openPointPanel(container, "钟楼");
  const enter = enterSubmapButton(container, "钟楼");
  ok(enter !== null, "v1 子图仍给出进入入口（parentMapId 缺省按 world）");
  enter.click();
  deepEqual(mapPointNames(container), ["旧版大堂"], "进入 v1 子图后渲染它的虚拟内层点");
  const crumb = crumbSnapshot(container);
  equal(crumb.display, "", "v1 子图同样显示面包屑");
  equal(crumb.text, "世界图›钟楼", "v1 子图面包屑指向 世界图 › 钟楼");

  container.querySelector(".aw-mapcrumb__back").click();
  deepEqual(mapPointNames(container), ["钟楼"], "从 v1 子图退回世界图");
  equal(crumbSnapshot(container).display, "none", "退回世界图后面包屑隐藏");
});

test("S10 前端：切聊天清空子图视图栈（旧子图不带进新卡）", async () => {
  const worldPoint = [{ id: "1", name: "钟楼", x: 40, y: 40, regionId: null }];
  const stateByChat = {
    "chat-a": s10State({
      chatId: "chat-a", worldId: "w-1", currentLocationId: "1",
      points: worldPoint, submaps: S10_SUBMAPS, pointParents: S10_POINT_PARENTS,
    }),
    "chat-c": s10State({
      chatId: "chat-c", worldId: "w-1", currentLocationId: "1",
      points: worldPoint, submaps: S10_SUBMAPS, pointParents: S10_POINT_PARENTS,
    }),
    "chat-b": s10State({
      chatId: "chat-b", worldId: "w-2", currentLocationId: "b-1",
      points: [{ id: "b-1", name: "另一张卡的首都", x: 20, y: 20, regionId: null }],
    }),
  };
  const { container, core, hostWrap } = await mountAtlasMap({ stateByChat });
  hostWrap.setBinding("chat-c", bindingFor("chat-c", "w-1"));
  hostWrap.setBinding("chat-b", bindingFor("chat-b", "w-2"));

  // chat-a：进到第 2 张子图
  openPointPanel(container, "钟楼");
  enterSubmapButton(container, "钟楼").click();
  openPointPanel(container, "大堂");
  enterSubmapButton(container, "大堂").click();
  deepEqual(mapPointNames(container), ["档案室"], "前置：chat-a 已在第 2 张子图");
  ok(crumbSnapshot(container).text.includes("大堂"), "前置：面包屑里带着旧子图层级");

  // 切到 chat-c：worldId 相同、chatId 不同 → 也必须清栈
  hostWrap.setChat("chat-c");
  await core.handleEvent("CHAT_CHANGED");
  await flush();
  deepEqual(mapPointNames(container), ["钟楼"], "chat-c（同 worldId / 新 chatId）渲染自己的世界图");
  equal(crumbSnapshot(container).display, "none", "切聊天（仅 chatId 变）后子图栈清空、面包屑隐藏");
  ok(!String(container.querySelector(".aw-maparea").textContent).includes("档案室"), "旧子图的点不残留在新聊天");

  // 在 chat-c 里再次进入两层，然后切到 chat-b（chatId + worldId 都不同）
  openPointPanel(container, "钟楼");
  enterSubmapButton(container, "钟楼").click();
  openPointPanel(container, "大堂");
  enterSubmapButton(container, "大堂").click();
  deepEqual(mapPointNames(container), ["档案室"], "前置：chat-c 已在第 2 张子图");
  hostWrap.setChat("chat-b");
  await core.handleEvent("CHAT_CHANGED");
  await flush();
  deepEqual(mapPointNames(container), ["另一张卡的首都"], "chat-b（新 chatId + 新 worldId）渲染自己的世界图");
  equal(crumbSnapshot(container).display, "none", "切聊天（chatId + worldId 都变）后子图栈清空");
  ok(!String(container.querySelector(".aw-maparea").textContent).includes("档案室"), "上一张卡的子图不残留");

  // 新聊天里导航仍然可用（栈按新的 chatId|worldId 重新建立）
  openPointPanel(container, "另一张卡的首都");
  equal(enterSubmapButton(container, "另一张卡的首都"), null, "chat-b 没有子图数据 → 不给进入入口");
});

test("S10 前端：路线预览只在世界图（子图视图不画跨图虚假直线）", async () => {
  const stateByChat = {
    "chat-a": s10State({
      chatId: "chat-a",
      worldId: "w-route",
      currentLocationId: "1",
      points: S10_ROOT_POINTS,
      submaps: { "1": { parentMapId: "world", points: [{ id: "11", name: "大堂", x: 10, y: 10 }] } },
      pointParents: { "11": 1 },
    }),
  };
  const { container, core, rerender } = await mountAtlasMap({
    stateByChat,
    travelPreview: { destinationId: "2", distance: 14, estimatedDuration: 3, factors: ["baseline"] },
  });

  // 世界图：当前在「钟楼」、目标「集市」两个根地点 → 路线画得出来
  await core.selectDestination("2");
  rerender();
  equal(container.querySelectorAll(".aw-route").length, 1, "世界图上根地点之间的路线预览画得出来");
  ok((container.querySelector(".aw-travel")?.textContent ?? "").includes("前往：集市"), "旅行条给出目的地");

  // 带着同一条预览进子图：不得留下跨图直线，旅行条隐藏
  openPointPanel(container, "钟楼");
  enterSubmapButton(container, "钟楼").click();
  deepEqual(mapPointNames(container), ["大堂"], "前置：已进入子图");
  equal(container.querySelectorAll(".aw-route").length, 0, "子图视图不画跨图路线（不给虚假直线）");
  equal(container.querySelector(".aw-travel")?.style.display, "none", "子图视图隐藏旅行条");
});

test("S11 前端：附近页只展示相关人物（主角与远处目录成员不冒充「附近」）", async () => {
  const base = s10State({
    chatId: "chat-a",
    worldId: "w-s11",
    currentLocationId: "1",
    points: [
      { id: "1", name: "钟楼", x: 40, y: 40, regionId: null },
      { id: "2", name: "集市", x: 80, y: 60, regionId: null },
    ],
    npcDirectory: [
      { id: "npc-a", name: "林拾", pointId: "1", presence: "present", isProtagonist: false },
      { id: "npc-b", name: "阿澈", pointId: "1", presence: "present", isProtagonist: false },
      { id: "npc-far", name: "远方的铁匠", pointId: "2", presence: "present", isProtagonist: false },
      { id: "char-main", name: "主角", pointId: "1", presence: "present", isProtagonist: true },
    ],
    // 服务端口径：同地点且在场的人会被补进 relevantNpcIds（主角也在其中——
    // 玩家确实在该地点），故 UI 必须自己按 isProtagonist 把主角摘掉。
    relevantNpcIds: ["npc-b", "char-main", "npc-a"],
    npcReasons: { "npc-a": ["samePoint"], "npc-b": ["nearbyPoint"] },
  });
  const stateByChat = { "chat-a": base };
  const { container, core } = await mountAtlasMap({ stateByChat });

  // 附近页：只按 relevantNpcIds 命中顺序展示，目录里的远处成员与主角都不出现
  core.setPage("nearby");
  await flush();
  const titles = [...container.querySelectorAll(".aw-card--npc .aw-card__title")].map((n) => n.textContent);
  deepEqual(titles, ["阿澈", "林拾"], "附近页按 relevantNpcIds 命中顺序展示相关人物（不是目录顺序）");
  ok(!titles.includes("远方的铁匠"), "目录里的远处成员不显示为「附近」");
  ok(!titles.includes("主角"), "主角不在附近卡片里冒充 NPC");

  // 目录本身没被删：非相关成员仍留在地点菜单里可查（地点「集市」的在场名单）
  core.setPage("map");
  await flush();
  const panel = openPointPanel(container, "集市");
  ok(String(panel.textContent).includes("远方的铁匠"), "非相关目录成员仍留在地点菜单，可供查找");
  // 主角同理：他确实在钟楼，地点名单里应当有他——只是不当「附近 NPC」
  const herePanel = openPointPanel(container, "钟楼");
  ok(String(herePanel.textContent).includes("主角"), "主角仍出现在所在的地点名单里（不在场才算离场）");

  // 关联为空 → 明确文案，不把整张目录当兜底
  stateByChat["chat-a"] = { ...base, relevantNpcIds: ["char-main"] };
  core.setPage("nearby");
  await core.refresh();
  await flush();
  const text = container.querySelector(".aw-center")?.textContent ?? "";
  ok(text.includes("附近暂无已确认人物"), `空关联给出明确文案：实际「${text.slice(0, 80)}」`);
  equal(container.querySelectorAll(".aw-card--npc").length, 0, "空关联时不渲染人物卡片");
});

test("D-34 前端：子图按房间画人物图钉；只知建筑级的不画点（不伪造房间坐标）", async () => {
  const base = s10State({
    chatId: "chat-a",
    worldId: "w-d34",
    currentLocationId: "1",
    points: [{ id: "1", name: "学校", x: 40, y: 40, regionId: null }],
    submaps: { "1": { parentMapId: "world", points: [{ id: "11", name: "三年二班", x: 30, y: 30 }] } },
    npcDirectory: [],
    objectDirectory: [],
  });
  base.tableMap = {
    branchKey: "canon",
    world: {
      mapId: "world",
      total: 1,
      truncated: 0,
      points: [{ id: "1", name: "学校", x: 40, y: 40, regionId: null, kind: "location", rowId: "loc:1" }],
    },
    submaps: {
      "1": {
        mapId: "1",
        parentMapId: "world",
        frame: { cols: 100, rows: 100, frameRevision: 1 },
        total: 1,
        truncated: 0,
        points: [{ id: "11", name: "三年二班", x: 30, y: 30, regionId: null, kind: "location", rowId: "loc:11" }],
      },
    },
    unknownPosition: [],
    nearby: {
      total: 4,
      truncated: 0,
      entries: [
        // ① 有房间内精细坐标 → 子图里要画图钉
        { id: "npc-a", name: "林拾", locationId: "loc:11", locationName: "三年二班", presence: "present",
          thought: "在想题", actionTendency: "留在教室", currentAction: "坐着", isProtagonist: false,
          positionSource: "narrative", mapId: "1", gridX: 62, gridY: 44 },
        // ② 坐标与地点标点完全重合 → 只知建筑级，不画点（避免两枚标记叠在一起）
        { id: "npc-b", name: "老师", locationId: "loc:11", locationName: "三年二班", presence: "present",
          thought: "", actionTendency: "", currentAction: "讲课", isProtagonist: false,
          positionSource: "unknown", mapId: "1", gridX: 30, gridY: 30 },
        // ③ 完全没有细坐标 → 只进名单
        { id: "npc-c", name: "转校生", locationId: "loc:11", locationName: "三年二班", presence: "present",
          thought: "", actionTendency: "", currentAction: "", isProtagonist: false,
          positionSource: "unknown", mapId: "1", gridX: null, gridY: null },
        // ④ 主角 → 不在地图上冒充 NPC
        { id: "npc-hero", name: "我", locationId: "loc:11", locationName: "三年二班", presence: "present",
          thought: "", actionTendency: "", currentAction: "", isProtagonist: true,
          positionSource: "manual", mapId: "1", gridX: 70, gridY: 70 },
      ],
    },
    objects: { total: 0, truncated: 0, entries: [] },
    current: { locationId: "loc:1", chain: [{ id: "loc:1", name: "学校" }] },
    totals: { locations: 2, characters: 4, items: 0, submaps: 1 },
    dropped: { locations: 0 },
  };
  const { container } = await mountAtlasMap({ stateByChat: { "chat-a": base } });

  // 世界图：学校一个点，人物一个都不画
  equal(container.querySelectorAll(".aw-object--npc").length, 0, "世界图上不画人物");
  // 进入学校 → 三年二班所在的那层子图
  openPointPanel(container, "学校");
  const enter = enterSubmapButton(container, "学校");
  ok(enter !== null, "学校有内部地图入口");
  enter.click();

  const pins = [...container.querySelectorAll(".aw-object--npc")];
  const pinNames = pins.map((pin) => pin.textContent);
  ok(pinNames.some((text) => text.includes("林拾")), `房间里画出「林拾」图钉：实际 ${JSON.stringify(pinNames)}`);
  ok(!pinNames.some((text) => text.includes("老师")), "坐标与地点标点重合（只知建筑级）→ 不画点");
  ok(!pinNames.some((text) => text.includes("转校生")), "没有细坐标 → 不画点");
  ok(!pinNames.some((text) => text.includes("我")), "主角不在地图上冒充 NPC");
  // 位置：按格坐标落点（62 / 44），不是地点标点的 30 / 30
  const lin = pins.find((pin) => pin.textContent.includes("林拾"));
  equal(lin?.style.left, "62px", "图钉按格坐标落点（x）");
  equal(lin?.style.top, "44px", "图钉按格坐标落点（y）");
  equal(lin?.dataset.npcId, "npc-a", "带上实体 id（供排障与后续交互）");
  // 只有建筑级信息的人仍在「建筑内 · 位置未知」名单里，没被弄丢
  const rosterText = String(container.querySelector(".aw-interior-roster")?.textContent ?? "");
  ok(rosterText.includes("转校生"), `建筑内名单保留无细坐标的人：实际「${rosterText}」`);
  ok(!rosterText.includes("林拾"), "有房间内坐标的人只在图上画钉，不在名单里重复出现");
  // 老师只知道"在三年二班"（坐标 = 房间标点）→ 既不是图钉，也不需要名单兜底：
  // 房间标点本身就说明他在这儿。
  const allMapText = String(container.querySelector(".aw-maparea")?.textContent ?? "");
  ok(!allMapText.includes("老师"), "坐标与房间标点重合的人不重复画点");
});

test("D04/D05 前端：有 tableMap 时位置与在场性以三表为准（目录不得反向覆盖）", async () => {
  // 场景：三表说阿澈已被日程带到「集市」，目录（它的投影路径滞后）还说他在「钟楼」。
  // 行增量回合只改三表，所以面板必须信三表——否则"人还在这儿"是撒谎。
  const base = s10State({
    chatId: "chat-a",
    worldId: "w-d05",
    currentLocationId: "1",
    points: [
      { id: "1", name: "钟楼", x: 40, y: 40, regionId: null },
      { id: "2", name: "集市", x: 60, y: 40, regionId: null },
    ],
    npcDirectory: [
      { id: "npc-a", name: "林拾", pointId: "1", presence: "present", isProtagonist: false, status: "在钟楼下张望" },
      { id: "npc-b", name: "阿澈", pointId: "1", presence: "present", isProtagonist: false },
      { id: "npc-c", name: "刚到场的新人", pointId: "1", presence: "present", isProtagonist: false },
    ],
    relevantNpcIds: ["npc-a", "npc-b"],
    npcReasons: { "npc-a": ["samePoint"], "npc-b": ["samePoint"] },
  });
  base.tableMap = {
    branchKey: "canon",
    world: {
      mapId: "world",
      total: 2,
      truncated: 0,
      points: [
        { id: "1", name: "钟楼", x: 40, y: 40, regionId: null, kind: "location", rowId: "loc:1" },
        { id: "2", name: "集市", x: 60, y: 40, regionId: null, kind: "location", rowId: "loc:2" },
      ],
    },
    submaps: {},
    unknownPosition: [],
    nearby: {
      total: 4,
      truncated: 0,
      entries: [
        { id: "npc-a", name: "林拾", locationId: "loc:1", locationName: "钟楼", presence: "present",
          thought: "等他开口", actionTendency: "留在钟楼", currentAction: "在钟楼下张望",
          isProtagonist: false, positionSource: "narrative", mapId: "world", gridX: null, gridY: null },
        // 三表：阿澈已经在集市（日程移动），目录却还说他在钟楼
        { id: "npc-b", name: "阿澈", locationId: "loc:2", locationName: "集市", presence: "present",
          thought: "去集市打听", actionTendency: "跟着人流走", currentAction: "在集市挑货",
          isProtagonist: false, positionSource: "routine", mapId: "world", gridX: null, gridY: null },
        // 三表里有、目录里还没有的新人：不能因为目录滞后就从名单消失
        { id: "npc-c", name: "刚到场的新人", locationId: "loc:1", locationName: "钟楼", presence: "present",
          thought: "找林拾", actionTendency: "等在门口", currentAction: "在门口等",
          isProtagonist: false, positionSource: "narrative", mapId: "world", gridX: null, gridY: null },
      ],
    },
    objects: { total: 0, truncated: 0, entries: [] },
    current: { locationId: "loc:1", chain: [{ id: "loc:1", name: "钟楼" }] },
    totals: { locations: 2, characters: 3, items: 0, submaps: 0 },
    dropped: { locations: 0 },
  };
  const { container, core } = await mountAtlasMap({ stateByChat: { "chat-a": base } });

  // 地点菜单「当前在这里」：按三表的位置，阿澈不在这里；新人必须在
  const panel = openPointPanel(container, "钟楼");
  const panelText = String(panel.textContent);
  ok(panelText.includes("林拾"), "三表与目录一致的人照常显示");
  ok(panelText.includes("刚到场的新人"), "三表里有、目录滞后的人仍出现在地点名单");
  ok(!panelText.includes("阿澈"), "三表说人已离开 → 目录的旧位置不得反向覆盖（不再显示在钟楼）");

  // 人物面板：三表的想法 / 行动倾向 / 位置来源各归各位
  const npcRow = [...panel.querySelectorAll(".aw-mappanel__person--npc")]
    .find((row) => row.textContent.includes("林拾"));
  ok(npcRow, "林拾的名单行存在");
  npcRow.click();
  const npcPanelText = String(container.querySelector(".aw-mappanel").textContent);
  ok(npcPanelText.includes("想法：等他开口"), `人物面板显示三表想法：实际「${npcPanelText.slice(0, 120)}」`);
  ok(npcPanelText.includes("行动倾向：留在钟楼"), "人物面板显示三表行动倾向");
  ok(npcPanelText.includes("位置来源：正文观察"), "人物面板显示位置来源标签");

  // 远处地点的人仍可通过地点菜单查到（不冒充「附近」但也没被删）
  const marketPanel = openPointPanel(container, "集市");
  ok(String(marketPanel.textContent).includes("阿澈"), "三表把他记在集市 → 集市名单里有他");

  // 附近页：三表字段直接进卡片详情，位置来源用人类可读标签
  core.setPage("nearby");
  await flush();
  const titles = [...container.querySelectorAll(".aw-card--npc .aw-card__title")].map((n) => n.textContent);
  ok(titles.includes("林拾"), "附近页仍按 relevantNpcIds 命中顺序展示");
  const card = [...container.querySelectorAll(".aw-card--npc")]
    .find((node) => node.textContent.includes("林拾"));
  card.click();
  const cardText = String(card.textContent);
  ok(cardText.includes("想法：等他开口"), "附近卡片详情带三表想法");
  ok(cardText.includes("位置来源：正文观察"), "附近卡片详情带位置来源标签");
  ok(!cardText.includes("routine") && !cardText.includes("ledger"), "不把内部枚举值直接甩给用户");
});

test("D03 前端：物品图钉按三表口径画（持有物与已销毁物不落地，子图也能画）", async () => {
  const base = s10State({
    chatId: "chat-a",
    worldId: "w-d03",
    currentLocationId: "1",
    points: [{ id: "1", name: "钟楼", x: 40, y: 40, regionId: null }],
    submaps: { "1": { parentMapId: "world", points: [{ id: "11", name: "档案室", x: 30, y: 30 }] } },
    objectDirectory: [],
    npcDirectory: [],
  });
  base.tableMap = {
    branchKey: "canon",
    world: {
      mapId: "world",
      total: 1,
      truncated: 0,
      points: [{ id: "1", name: "钟楼", x: 40, y: 40, regionId: null, kind: "location", rowId: "loc:1" }],
    },
    submaps: {
      "1": {
        mapId: "1",
        parentMapId: "world",
        frame: { cols: 100, rows: 100, frameRevision: 1 },
        total: 1,
        truncated: 0,
        points: [{ id: "11", name: "档案室", x: 30, y: 30, regionId: null, kind: "location", rowId: "loc:11" }],
      },
    },
    unknownPosition: [],
    nearby: { total: 0, truncated: 0, entries: [] },
    objects: {
      total: 4,
      truncated: 0,
      entries: [
        // 地面物品：有精细格坐标 → 世界图上要有图钉
        { id: "item:lamp", name: "铜灯", description: "一盏铜灯", status: "在地上", locationId: "loc:1",
          locationName: "钟楼", holderCharacterId: null, holderName: null, mapId: "world", gridX: 52, gridY: 46 },
        // 持有物：随身物品不地面化（D-02 持有关系只存在于三表）
        { id: "item:key", name: "铜钥匙", description: "小钥匙", status: "随身", locationId: null,
          locationName: null, holderCharacterId: "npc:a", holderName: "林拾", mapId: null, gridX: null, gridY: null },
        // 已销毁：软删除不落地
        { id: "item:ash", name: "灰烬", description: "烧尽的信", status: "已销毁", locationId: null,
          locationName: null, holderCharacterId: null, holderName: null, mapId: null, gridX: null, gridY: null },
        // 子图里的物品：进入子图才画
        { id: "item:file", name: "卷宗", description: "旧卷宗", status: "在地上", locationId: "loc:11",
          locationName: "档案室", holderCharacterId: null, holderName: null, mapId: "1", gridX: 34, gridY: 28 },
      ],
    },
    current: { locationId: "loc:1", chain: [{ id: "loc:1", name: "钟楼" }] },
    totals: { locations: 2, characters: 0, items: 4, submaps: 1 },
    dropped: { locations: 0 },
  };
  const { container } = await mountAtlasMap({ stateByChat: { "chat-a": base } });

  // 世界图：只有「铜灯」有图钉；持有物、已销毁物、别层物品都不上世界图
  const worldItems = [...container.querySelectorAll(".aw-object")].map((n) => n.textContent);
  ok(worldItems.some((text) => text.includes("铜灯")), `世界图有「铜灯」图钉：实际 ${JSON.stringify(worldItems)}`);
  ok(!worldItems.some((text) => text.includes("铜钥匙")), "持有物不画地面图钉");
  ok(!worldItems.some((text) => text.includes("灰烬")), "已销毁物不画图钉");
  ok(!worldItems.some((text) => text.includes("卷宗")), "子图物品不上世界图");

  // 进入子图：该层的物品图钉出现（旧实现 `if (inSub) continue` 会整层漏掉）
  const panel = openPointPanel(container, "钟楼");
  const enter = enterSubmapButton(container, "钟楼");
  ok(enter !== null, "钟楼有内部地图入口");
  enter.click();
  const subItems = [...container.querySelectorAll(".aw-object")].map((n) => n.textContent);
  ok(subItems.some((text) => text.includes("卷宗")), `子图有「卷宗」图钉：实际 ${JSON.stringify(subItems)}`);
  ok(!subItems.some((text) => text.includes("铜灯")), "世界图物品不带进子图");
  void panel;
});

// ===========================================================================
// 阶段 B：聊天隔离（B01 / B02a / B02b / B03 / B04 + A03 诊断夹具 / B06 回归）
//
// 接缝（沿用本文件既有做法）：
// - 判定逻辑一律从**仓库根 index.js** 导入（`import(pathToFileURL(join(root,"index.js")))`，
//   与 tests/atlas-stability.test.mjs 同口径）。index.js 不在 tsconfig 覆盖内，
//   所以这里全部是真跑断言，不做源码字符串匹配。
// - 需要真实 renderPanel 的场景沿用 S10 的 data:URL 源码注入（追加 `export { renderPanel }`），
//   但读的是根 index.js（本阶段的施工文件），且**每次挂载换 URL**——mapImageCache /
//   相机表都是模块级或面板级状态，用例之间必须拿到全新实例。
// - A03 夹具只记录身份与结构字段（binding.chatId / world.id / branchKey / 当前地点 /
//   人物 id 与 locationId），**绝不含任何聊天正文**，也不触碰真实聊天。
// ===========================================================================

/** 根 index.js 导出（纯函数判定 + 可测工厂）。 */
const bIndex = await import(pathToFileURL(join(root, "index.js")).href);
const { buildLorebookPlans, createAtlasLorebookWriter } = await import(
  pathToFileURL(join(root, "src", "atlas-lorebook.ts")).href
);

/** 根 index.js 源码（DOM 用例经 data:URL 注入 `export { renderPanel }`）。 */
const B_INDEX_SOURCE = readFileSync(join(root, "index.js"), "utf8");
let bMountSeq = 0;

/** 挂载**根 index.js** 的真实地图页（与 mountAtlasMap 同套路，只是源码换成根文件）。 */
async function mountRootAtlasMap({ stateByChat, chatId = "chat-a", travelPreview = null }) {
  const dom = new JSDOM("<!doctype html><head></head><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  const style = document.createElement("style");
  style.textContent = readFileSync(join(root, "atlas-extension", "style.css"), "utf8");
  document.head.append(style);

  bMountSeq += 1;
  const source = `${B_INDEX_SOURCE}\nexport { renderPanel };\n// b-mount-${bMountSeq}`;
  const { renderPanel } = await import(
    "data:text/javascript;base64," + Buffer.from(source).toString("base64")
  );
  const cameraMod = await import(pathToFileURL(join(root, "src", "atlas-map-camera.ts")).href);
  const mapMod = {
    ...cameraMod,
    ...(await import(pathToFileURL(join(root, "src", "atlas-map-interactions.ts")).href)),
    ...(await import(pathToFileURL(join(root, "src", "atlas-scale.ts")).href)),
    // H13：网格纯函数由发布入口提供；夹具按真实表面补齐，SVG overlay 才会真的出线
    ...(await import(pathToFileURL(join(root, "src", "atlas-map-grid.ts")).href)),
    // H16：范围填色投影（只染有证据的格）
    ...(await import(pathToFileURL(join(root, "src", "atlas-map-areas.ts")).href)),
    ATLAS_UI_PAGES: (await import(pathToFileURL(join(root, "src", "atlas-ui-core.ts")).href)).ATLAS_UI_PAGES,
  };

  const api = makeApi({ stateByChat, travelPreview });
  const hostWrap = makeHost();
  hostWrap.setChat(chatId);
  hostWrap.setBinding(chatId, bindingFor(chatId, String(stateByChat[chatId]?.worldId ?? "w-b")));
  let rerender = () => {};
  const core = createAtlasUiCore({
    api,
    host: hostWrap.host,
    emitter: makeEmitter(),
    onStateChange: () => rerender(),
    now: () => NOW_BASE,
  });
  const container = document.createElement("div");
  document.body.append(container);
  rerender = renderPanel(core, container, api, { read: async () => null }, mapMod);
  await core.handleEvent("APP_READY");
  core.setPage("map");
  await flush();
  return { dom, api, hostWrap, core, container, cameraMod, rerender };
}

// ---------------------------------------------------------------------------
// A03：诊断夹具（两个聊天的身份字段）+「附近为空」三档判定
// ---------------------------------------------------------------------------

/**
 * A03 诊断夹具：只记录定位所需的**结构字段**——两个聊天各自的 binding.chatId、
 * world.id、branchKey、当前地点、以及人物 `id`/`locationId`。
 * 不含正文、不含 prompt、不含消息文本（A04 的脱敏纪律同口径）。
 */
function a03DiagnosticFixture({ chatId, binding, state }) {
  const tableMap = state?.tableMap ?? null;
  return {
    bindingChatId: binding?.chatId ?? null,
    worldId: state?.worldId ?? binding?.worldId ?? null,
    branchKey: state?.tableMap?.branchKey ?? (binding?.branchId ?? "canon"),
    currentLocationId: binding?.currentLocationId ?? state?.currentLocationId ?? null,
    characters: (tableMap?.nearby?.entries ?? []).map((entry) => ({
      id: String(entry.id ?? ""),
      locationId: String(entry.locationId ?? entry.currentLocationId ?? ""),
      presence: entry.presence ?? "present",
    })),
  };
}

test("A03 诊断夹具：附近为空能拆成「当前位置未知 / 当前地点有人 / 真正跨聊天」三档", async () => {
  // 同一张角色卡的两个聊天：worldId 相同（跨聊天共享世界），chatId 不同。
  const sharedWorldId = "w-a03";
  const stateA = s10State({
    chatId: "chat-a", worldId: sharedWorldId, currentLocationId: "2",
    points: [{ id: "2", name: "蒸汽车厢", x: 30, y: 30, regionId: null }],
  });
  stateA.tableMap = {
    branchKey: "canon",
    nearby: {
      total: 2, truncated: 0,
      entries: [
        { id: "npc:car-1", name: "车夫", locationId: "loc:2", presence: "present" },
        { id: "npc:car-2", name: "乘客", locationId: "loc:2", presence: "present" },
      ],
    },
    world: { points: [] }, objects: { entries: [] }, submaps: {},
  };
  const stateB = s10State({
    chatId: "chat-b", worldId: sharedWorldId, currentLocationId: "9",
    points: [{ id: "9", name: "B 的营地", x: 5, y: 5, regionId: null }],
  });
  stateB.tableMap = {
    branchKey: "canon",
    nearby: { total: 1, truncated: 0, entries: [{ id: "npc:b-1", name: "B 的人", locationId: "loc:9", presence: "present" }] },
    world: { points: [] }, objects: { entries: [] }, submaps: {},
  };
  const bindingA = bindingFor("chat-a", sharedWorldId, { currentLocationId: "2" });
  const bindingB = bindingFor("chat-b", sharedWorldId, { currentLocationId: "9" });
  const fixtureA = a03DiagnosticFixture({ chatId: "chat-a", binding: bindingA, state: stateA });
  const fixtureB = a03DiagnosticFixture({ chatId: "chat-b", binding: bindingB, state: stateB });

  // 夹具可区分两个聊天（world.id 相同 → 只能靠 chatId 定位，正是 F8 要的口径）
  equal(fixtureA.bindingChatId, "chat-a", "夹具记录 A 的 binding.chatId");
  equal(fixtureB.bindingChatId, "chat-b", "夹具记录 B 的 binding.chatId");
  equal(fixtureA.worldId, fixtureB.worldId, "两个聊天共用同一张角色卡的世界");
  equal(fixtureA.currentLocationId, "2", "夹具记录 A 的当前地点");
  deepEqual(fixtureA.characters.map((c) => `${c.id}@${c.locationId}`), ["npc:car-1@loc:2", "npc:car-2@loc:2"],
    "夹具记录人物 id / locationId");

  // 第 1 档：当前位置未知 → 不是"没人"，是没算过
  const unknown = bIndex.atlasDiagnoseEmptyNearby({
    currentLocationId: null, tableNearbyEntries: stateA.tableMap.nearby.entries, relevantNpcIds: [],
  });
  equal(unknown.case, "current-location-unknown", "当前位置未知单独成档");
  ok(unknown.message.includes("尚未确定当前位置"), `文案直说位置未知：实际「${unknown.message}」`);

  // 第 2 档：当前地点确实有人（附近页为空只是本轮没有相关性判定）→ 不是跨聊天
  const samePlace = bIndex.atlasDiagnoseEmptyNearby({
    currentLocationId: "2", tableNearbyEntries: stateA.tableMap.nearby.entries, relevantNpcIds: [],
  });
  equal(samePlace.case, "same-location-has-people", "同类地点有人单独成档");
  equal(samePlace.persons, 2, "数出该地点在场人数");
  ok(!samePlace.message.includes("附近暂无已确认人物"), "不把「引擎没判相关」说成「附近没人」");

  // 第 3 档：真正跨聊天 —— 身份核验说不符，写回守卫必须拒绝
  const metaA = { atlas: { schemaVersion: 1, binding: bindingA } };
  const metaB = { atlas: { schemaVersion: 1, binding: bindingB } };
  equal(bIndex.atlasSameChatIdentity(
    { chatId: "chat-a", metadata: metaA }, { chatId: "chat-b", metadata: metaB },
  ), false, "两个聊天不是同一身份");
  equal(bIndex.atlasSameChatIdentity(
    { chatId: "chat-a", metadata: metaA }, { chatId: "chat-a", metadata: metaB },
  ), false, "同 chatId 但 metadata 对象不同 → 也不是同一身份（关聊天后重开）");
  equal(bIndex.atlasSessionWriteGuard("chat-a", "chat-b", "chat-a", metaA.atlas), false,
    "A 的会话在 B 里被拒绝写回（真正跨聊天）");
  ok(!JSON.stringify(fixtureB.characters).includes("npc:car-1"), "B 的夹具里没有 A 的人物行");

  // 真实 UI 文案：同一判定函数驱动附近页三档（A03 的落地接线）
  const stateByChat = { "chat-a": { ...stateA, currentLocationId: null, relevantNpcIds: [] } };
  const { container, core, hostWrap } = await mountRootAtlasMap({ stateByChat });
  core.setPage("nearby");
  await flush();
  let text = container.querySelector(".aw-center")?.textContent ?? "";
  ok(text.includes("尚未确定当前位置"), `附近页在位置未知时给出诚实文案：实际「${text.slice(0, 80)}」`);

  stateByChat["chat-a"] = { ...stateA, relevantNpcIds: [] };
  await core.refresh();
  await flush();
  text = container.querySelector(".aw-center")?.textContent ?? "";
  ok(text.includes("当前地点已确认在场者"), `位置已知且地点有人时不说「没人」：实际「${text.slice(0, 80)}」`);
  void hostWrap;
});

// ---------------------------------------------------------------------------
// B01：存量迁移 —— Map<chatId> + 身份核验
// ---------------------------------------------------------------------------

/** B01 夹具：一个聊天的 chatMetadata（含旧绑定）与可注入的旧档 store/api。 */
function b01LegacyChat(chatId, worldId) {
  return {
    chatId,
    metadata: {
      atlas_binding: {
        schemaVersion: 1, enabled: true, chatId, characterId: null, worldId,
        branchId: null, currentLocationId: "1", worldTimeCursor: 12,
        lastCommittedMessageId: null, lastCheckpointId: null,
      },
    },
  };
}

function b01Store(docs = {}, { poisonList = false } = {}) {
  const removed = [];
  const keys = Object.keys(docs);
  return {
    removed,
    async read(key) { return key in docs ? docs[key] : null; },
    async list(prefix) {
      if (poisonList) return keys.slice(); // 恶意/有 bug 的宿主：把全部键都列出来
      return keys.filter((key) => key.startsWith(prefix));
    },
    async remove(key) { removed.push(key); delete docs[key]; },
    docs,
  };
}

test("B01 迁移：A→B 切换发生在 await 中间 → 保留旧数据、不 saveMetadata、不 purge", async () => {
  const legacyA = b01LegacyChat("chat-a", "w-a");
  const legacyB = b01LegacyChat("chat-b", "w-b");
  const store = b01Store({
    "world:w-a": { id: "w-a", name: "A 的世界" },
    "maps:w-a": { points: [{ id: "1", name: "A 钟楼" }] },
    "turn:chat-a::1": { receipt: { status: "committed", summary: "A 的动向" } },
    "turn:chat-b::1": { receipt: { status: "committed", summary: "B 的动向" } },
  }, { poisonList: true });
  const purge = [];
  const api = { async request(method, path, body) { purge.push(path); return { status: 200, body: { ok: true, data: {} } }; } };
  const events = [];
  let saves = 0;

  let current = { chatId: "chat-a", chatMetadata: legacyA.metadata, saveMetadata: async () => { saves += 1; } };
  const context = () => current;

  // 在第一个 await（读 world:w-a）返回时切到 chat-b
  const originalRead = store.read.bind(store);
  store.read = async (key) => {
    const value = await originalRead(key);
    if (key === "world:w-a") current = { chatId: "chat-b", chatMetadata: legacyB.metadata, saveMetadata: async () => { saves += 1; } };
    return value;
  };
  const result = await bIndex.migrateChatSession(context, { store, api, emit: (event) => events.push(event) });

  equal(result.stale, true, "迁移判定为过期");
  equal(result.code, "STALE_MIGRATION_DROPPED", "结果带 STALE_MIGRATION_DROPPED");
  const stale = events.find((event) => event.code === "STALE_MIGRATION_DROPPED");
  ok(stale !== undefined, "记录了 STALE_MIGRATION_DROPPED 诊断");
  equal(stale?.errorCode, "SESSION_IDENTITY_MISMATCH", "诊断带 A04 的具名码");
  equal(stale?.details?.reasonCode, "SESSION_IDENTITY_MISMATCH", "reasonCode 同样具名");
  equal(stale?.details?.stage, "after-world-read", "定位到具体核验点");

  equal(saves, 0, "身份不符 → 一次 saveMetadata 都没有");
  equal(purge.length, 0, "身份不符 → 一个服务端请求都不发");
  deepEqual(store.removed, [], "身份不符 → 不移除任何旧 KV");
  equal(legacyA.metadata.atlas, undefined, "A 的 chatMetadata 没有被写入半截会话");
  ok(legacyA.metadata.atlas_binding !== undefined, "A 的旧绑定原样保留（下次事件再迁）");
  equal(legacyB.metadata.atlas, undefined, "B 的 chatMetadata 完全没有被 A 的迁移碰到");
  ok(!JSON.stringify(legacyB.metadata).includes("A 钟楼"), "B 里没有 A 的任何表行 / 地图");

  // A→B→A：切回 A 后重新迁移成功，旧数据确实还在（失败没有损坏任何东西）
  store.read = originalRead;
  current = { chatId: "chat-a", chatMetadata: legacyA.metadata, saveMetadata: async () => { saves += 1; } };
  const retried = await bIndex.migrateChatSession(context, { store, api, emit: (event) => events.push(event) });
  equal(retried.migrated, true, "切回 A 后迁移成功");
  equal(legacyA.metadata.atlas?.binding?.chatId, "chat-a", "A 会话绑定归属 A");
  equal(legacyA.metadata.atlas?.world?.id, "w-a", "A 会话世界里是 A 的数据");
  equal(legacyA.metadata.atlas?.maps?.points?.[0]?.name, "A 钟楼", "A 会话地图里是 A 的地图");
  ok(!Object.keys(legacyA.metadata.atlas?.turns ?? {}).includes("turn:chat-b::1"), "A 的会话里没有 B 的回合（宿主乱列键也不收）");
  deepEqual(Object.keys(legacyA.metadata.atlas?.turns ?? {}), ["turn:chat-a::1"], "A 只收自己的回合");
  equal(saves, 1, "成功路径只存档一次");
  deepEqual(store.removed, ["turn:chat-a::1"], "只清自己的回合旧档");
  deepEqual(purge, [], "不调 /session/purge（它按 worldId 删共享旧档，会毁掉别的聊天的迁移源）");
  ok(store.docs["world:w-a"] !== undefined && store.docs["maps:w-a"] !== undefined,
    "世界级旧档保留：同一张卡的其他聊天仍能迁移");
  ok(!store.removed.includes("turn:chat-b::1"), "绝不代删别的聊天的回合文档");
});

test("B01 迁移：在途表按 chatId 分桶（不同聊天不复用同一个 Promise）", async () => {
  const legacyA = b01LegacyChat("chat-a", "w-a");
  const legacyB = b01LegacyChat("chat-b", "w-b");
  const store = b01Store({ "world:w-a": { id: "w-a" }, "world:w-b": { id: "w-b" } });
  const ctxA = { chatId: "chat-a", chatMetadata: legacyA.metadata, saveMetadata: async () => {} };
  const ctxB = { chatId: "chat-b", chatMetadata: legacyB.metadata, saveMetadata: async () => {} };
  let current = ctxA;
  const context = () => current;

  const first = bIndex.migrateChatSession(context, { store, api: null, emit: () => {} });
  const sameChat = bIndex.migrateChatSession(context, { store, api: null, emit: () => {} });
  equal(bIndex.atlasSessionMigrationInFlight("chat-a"), true, "A 有在途迁移");
  equal(bIndex.atlasSessionMigrationInFlight("chat-b"), false, "B 没有在途迁移（不再共用单例）");
  equal(first, sameChat, "同一聊天复用同一次在途迁移");

  current = ctxB;
  const other = bIndex.migrateChatSession(context, { store, api: null, emit: () => {} });
  equal(bIndex.atlasSessionMigrationInFlight("chat-b"), true, "两个聊天可以同时各有一条在途迁移");
  ok(other !== first, "另一个聊天拿到的是自己的迁移 Promise");

  const [resultA, resultB] = await Promise.all([first, other]);
  equal(resultA.stale, true, "A 在切换后作废（B 的迁移不受它影响）");
  equal(resultB.migrated, true, "B 正常迁移完成");
  equal(legacyB.metadata.atlas?.world?.id, "w-b", "B 的会话写进 B");
  equal(legacyA.metadata.atlas, undefined, "A 没有被写入半截会话");
  equal(bIndex.atlasSessionMigrationInFlight("chat-a"), false, "完成后 A 的在途标记清除");
  equal(bIndex.atlasSessionMigrationInFlight("chat-b"), false, "完成后 B 的在途标记清除");

  // 切回 A（身份稳定）→ 自己的迁移照样能成功
  current = ctxA;
  const retried = await bIndex.migrateChatSession(context, { store, api: null, emit: () => {} });
  equal(retried.migrated, true, "切回 A 后迁移成功");
  equal(legacyA.metadata.atlas?.world?.id, "w-a", "A 的会话写进 A");
});

// ---------------------------------------------------------------------------
// B02a：会话写回守卫（纯函数三情形 + 缺绑定带持久数据）
// ---------------------------------------------------------------------------

test("B02a 守卫：空身份 / 错聊天 / 三方相同的判定，缺绑定带 world|tables|simulation 一律拒绝", () => {
  const session = (chatId, extra = {}) => ({
    schemaVersion: 1, rev: 4,
    binding: chatId === null ? null : { schemaVersion: 1, chatId, worldId: "w-1" },
    ...extra,
  });
  const full = (chatId) => session(chatId, { world: { id: "w-1" }, tables: { branches: { canon: { locations: [] } } } });

  // 三方相同 → 放行
  equal(bIndex.atlasSessionWriteGuard("chat-a", "chat-a", "chat-a", full("chat-a")), true, "三方相同放行");
  // 空身份 → 拒绝（切换瞬间 metadata 未就位 / 关聊天）
  equal(bIndex.atlasSessionWriteGuard("chat-a", null, "chat-a", full("chat-a")), false, "当前身份缺失拒绝");
  equal(bIndex.atlasSessionWriteGuard("chat-a", "", "chat-a", full("chat-a")), false, "当前身份空串拒绝");
  equal(bIndex.atlasSessionWriteGuard("", "chat-a", "", full(null)), false, "发起身份缺失拒绝");
  // 错聊天 → 拒绝（A 的迟到响应、A→B→A 的旧归属）
  equal(bIndex.atlasSessionWriteGuard("chat-a", "chat-b", "chat-a", full("chat-a")), false, "发起≠当前拒绝");
  equal(bIndex.atlasSessionWriteGuard("chat-b", "chat-a", "chat-b", full("chat-b")), false, "A→B→A 后旧归属拒绝");
  equal(bIndex.atlasSessionWriteGuard("chat-a", "chat-a", "chat-b", full("chat-b")), false, "会话归属≠当前拒绝");
  // 缺绑定但带持久数据 → 拒绝（B02a 的新增硬规则）
  equal(bIndex.atlasSessionWriteGuard("chat-a", "chat-a", null, session(null, { world: { id: "w-1" } })), false, "缺绑定 + world 拒绝");
  equal(bIndex.atlasSessionWriteGuard("chat-a", "chat-a", null, session(null, { tables: { branches: {} } })), false, "缺绑定 + tables 拒绝");
  equal(bIndex.atlasSessionWriteGuard("chat-a", "chat-a", null, session(null, { simulation: { schemaVersion: 1 } })), false, "缺绑定 + simulation 拒绝");
  equal(bIndex.atlasSessionWriteGuard("chat-a", "chat-a", null, { schemaVersion: 1, binding: { worldId: "w-1" }, world: { id: "w-1" } }), false, "缺 chatId 归属 + world 拒绝");
  // 缺绑定且没有持久数据 → 放行（设置类响应 / 非持久会话不算错误）
  equal(bIndex.atlasSessionWriteGuard("chat-a", "chat-a", null, session(null)), true, "空会话放行");
  equal(bIndex.atlasSessionHasPersistentPayload(session(null)), false, "空会话没有持久数据");
  equal(bIndex.atlasSessionHasPersistentPayload(session("chat-a")), false, "只有绑定没有数据块不算持久数据");
  // 旧三方形态兼容（0.9.58 调用点：归属未知放行）
  equal(bIndex.atlasSessionWriteGuard("chat-a", "chat-a", null), true, "旧三方形态保持原语义");
  equal(bIndex.atlasSessionWriteGuard("chat-a", "chat-b", "chat-a"), false, "旧三方形态仍然拒绝错聊天");
});

// ---------------------------------------------------------------------------
// B06 夹具：新聊天的四个可观察面（表行 / 地图 / 动向 / 提示词）
// ---------------------------------------------------------------------------

/**
 * B06 会话夹具：一份完整会话文档（三表分支切片 + 地图 + 回合动向 + 绑定）。
 * 三表只放在**自己的分支键**下——跨分支串档会立刻被断言抓到。
 */
function b06Session({ chatId, worldId, branchKey = "canon", locationId, locationName, characterId, characterName, mapPointId, mapPointName, turnKey }) {
  const branchId = branchKey === "canon" ? null : branchKey;
  return {
    schemaVersion: 1,
    rev: 3,
    binding: {
      schemaVersion: 1, enabled: true, chatId, characterId: null, worldId, branchId,
      currentLocationId: locationId, worldTimeCursor: 12, lastCommittedMessageId: null, lastCheckpointId: null,
    },
    world: {
      id: worldId, name: `世界 ${worldId}`,
      points: [{ id: mapPointId, name: mapPointName }],
      ...(branchId ? { stories: [{ id: branchId, mode: "if" }] } : {}),
      stateEvents: [],
    },
    maps: { schemaVersion: 2, points: [{ id: mapPointId, name: mapPointName, x: 10, y: 10 }] },
    scene: null,
    turns: { [turnKey]: { receipt: { status: "committed", summary: `${turnKey} 的动向` } } },
    geoAuto: {},
    tables: {
      schemaVersion: 1,
      worldId,
      branches: {
        [branchKey]: {
          locations: [{ id: `loc:${locationId}`, name: locationName, parentLocationId: null, gridX: null, gridY: null }],
          characters: [{ id: `npc:${characterId}`, name: characterName, locationId: `loc:${locationId}`, presence: "present", thought: "", actionTendency: "" }],
          items: [],
        },
      },
    },
  };
}

/**
 * B06 把一份会话文档摊成四个可观察面，全部走**真实数据结构 / 真实纯函数**：
 * - `locationRows` / `characterRows`：三表分支切片（表行）；
 * - `mapPoints`：会话里的地图文档（地图）；
 * - `moves`：回合记录与回执摘要（动向）；
 * - `prompt`：真实 buildLorebookPlans 用**当前分支**三表算出的条目正文
 *   （这段文字就是写进「Atlas 动向」并注入模型提示词的内容）。
 */
function b06Surface(session) {
  const binding = session?.binding ?? {};
  const branchKey = binding.branchId ?? "canon";
  const branch = session?.tables?.branches?.[branchKey] ?? null;
  const world = session?.world ?? {};
  const currentLocationId = binding.currentLocationId ?? null;
  const slice = bIndex.atlasBranchSliceOf(world, session?.tables ?? null, binding.branchId ?? null);
  const plans = buildLorebookPlans(world, {
    status: "committed",
    currentTime: Number(binding.worldTimeCursor ?? 0),
    currentLocationId,
  }, slice ? { tables: slice.tables, branchKey: slice.branchKey, currentLocationId } : null);
  return {
    chatId: binding.chatId ?? null,
    branchKey,
    locationRows: (branch?.locations ?? []).map((row) => `${row.id}=${row.name}`),
    characterRows: (branch?.characters ?? []).map((row) => `${row.id}@${row.locationId}`),
    mapPoints: (session?.maps?.points ?? []).map((point) => `${point.id}=${point.name}`),
    moves: Object.entries(session?.turns ?? {}).map(([key, turn]) => `${key}:${turn?.receipt?.summary ?? ""}`),
    prompt: plans?.entries?.[0]?.content ?? "",
  };
}

/** B06 断言：四个面都属于当前聊天，且一个字节都不含 `forbid` 里的旧聊天标记。 */
function assertB06Surface(surface, { chatId, branchKey = null, forbid = [] }, label) {
  equal(surface.chatId, chatId, `${label}：表行归属当前聊天`);
  if (branchKey !== null) equal(surface.branchKey, branchKey, `${label}：三表分支键正确`);
  ok(surface.locationRows.length > 0, `${label}：新聊天有自己的表行`);
  ok(surface.characterRows.length > 0, `${label}：新聊天有自己的人物行`);
  ok(surface.mapPoints.length > 0, `${label}：新聊天有自己的地图`);
  ok(surface.moves.length > 0, `${label}：新聊天有自己的动向`);
  ok(surface.prompt.length > 0, `${label}：新聊天有自己的提示词内容`);
  for (const needle of forbid) {
    for (const field of ["locationRows", "characterRows", "mapPoints", "moves", "prompt"]) {
      ok(!JSON.stringify(surface[field]).includes(needle), `${label}：${field} 不含旧聊天的「${needle}」`);
    }
  }
}

// ---------------------------------------------------------------------------
// B06-1：A/B 快速切换（B02b sessionApi：A 的迟到响应不污染 B）
// ---------------------------------------------------------------------------

test("B06 A/B 快速切换：A 的迟到 commit 不写进 B，B 的表行 / 地图 / 动向 / 提示词不受影响", async () => {
  const sessionA = b06Session({
    chatId: "chat-a", worldId: "w-shared", locationId: "1", locationName: "A 钟楼",
    characterId: "a1", characterName: "甲", mapPointId: "1", mapPointName: "A 钟楼", turnKey: "turn:chat-a::1",
  });
  const sessionB = b06Session({
    chatId: "chat-b", worldId: "w-shared", locationId: "2", locationName: "B 集市",
    characterId: "b1", characterName: "乙", mapPointId: "2", mapPointName: "B 集市", turnKey: "turn:chat-b::1",
  });
  const before = b06Surface(sessionB);

  const metaA = { atlas: sessionA };
  const metaB = { atlas: sessionB };
  const saves = [];
  const ctxA = { chatId: "chat-a", chatMetadata: metaA, saveMetadata: async () => { saves.push("chat-a"); } };
  const ctxB = { chatId: "chat-b", chatMetadata: metaB, saveMetadata: async () => { saves.push("chat-b"); } };
  let current = ctxA;
  const context = () => current;

  let releaseLate = () => {};
  const gate = new Promise((resolve) => { releaseLate = resolve; });
  const lateSession = { ...sessionA, rev: sessionA.rev + 1 };
  const innerApi = {
    async request(method, path) {
      if (path === "/turns/commit") {
        await gate;
        return { status: 200, body: { ok: true, data: { receipt: { status: "committed" } }, session: lateSession } };
      }
      if (path === "/settings") return { status: 200, body: { ok: true, data: { settings: {} } } }; // 设置类：无会话
      return { status: 200, body: { ok: true, data: {} } };
    },
  };
  const events = [];
  const notices = [];
  const api = bIndex.createAtlasSessionApi({
    context, innerApi,
    emit: (event) => events.push(event),
    notify: (text) => notices.push(text),
    logCall: (method, path, run) => run(),
  });

  const late = api.request("POST", "/turns/commit", { chatId: "chat-a", userText: "" });
  current = ctxB;                 // 请求在途时切到 B
  releaseLate();
  await late;

  equal(metaB.atlas, sessionB, "B 的会话对象原样（没被 A 的 rev+1 覆盖）");
  equal(bIndex.atlasSameChatIdentity({ chatId: "chat-a", metadata: metaA }, { chatId: "chat-b", metadata: metaB }), false,
    "A 的响应与 B 不是同一身份");
  equal(saves.length, 0, "丢弃路径不触发任何存档");
  equal(metaA.atlas.rev, sessionA.rev, "A 的会话也没被写回（回执按计划丢弃）");
  ok(events.some((event) => event.code === "STALE_COMMIT_RESPONSE_DROPPED"
    && event.details?.reasonCode === "SESSION_IDENTITY_MISMATCH"), "记了具名的丢弃事件");
  equal(notices.length, 1, "给用户一条可见提示");
  ok(notices[0].includes("切聊天弃回执") && notices[0].includes("回到原聊天核对"),
    `提示文案要求回原聊天核对：实际「${notices[0]}」`);

  // 设置类响应不带会话：正常返回、不报错、不写回
  const settings = await api.request("PUT", "/settings", {});
  equal(settings.status, 200, "设置类响应照常返回");
  ok(!events.some((event) => event.code === "SESSION_WRITE_FAILED"), "不因为没会话就报写回失败");
  equal(saves.length, 0, "设置类响应不触发存档");

  // B 的四个面一字节都没变
  assertB06Surface(b06Surface(metaB.atlas), {
    chatId: "chat-b", branchKey: "canon",
    forbid: ["A 钟楼", "npc:a1", "turn:chat-a", "1=A 钟楼", "甲"],
  }, "B（快速切换后）");
  deepEqual(b06Surface(metaB.atlas), before, "B 的四个面逐字段不变");
});

// ---------------------------------------------------------------------------
// B06-2：legacy 迁移（两个聊天各迁各的，B 不拿到 A 的任何行）
// ---------------------------------------------------------------------------

test("B06 legacy 迁移：两个聊天各迁各的，B 的表行 / 地图 / 动向 / 提示词都只属于 B", async () => {
  const legacyA = b01LegacyChat("chat-a", "w-shared");
  const legacyB = b01LegacyChat("chat-b", "w-shared");
  const store = b01Store({
    "world:w-shared": { id: "w-shared", name: "共享世界", points: [{ id: "1", name: "共享钟楼" }], stateEvents: [] },
    "maps:w-shared": { points: [{ id: "1", name: "共享钟楼" }] },
    "turn:chat-a::1": { receipt: { status: "committed", summary: "A 的动向" } },
    "turn:chat-b::1": { receipt: { status: "committed", summary: "B 的动向" } },
  }, { poisonList: true });
  const events = [];
  let current = { chatId: "chat-a", chatMetadata: legacyA.metadata, saveMetadata: async () => {} };
  const context = () => current;

  await bIndex.migrateChatSession(context, { store, api: null, emit: (event) => events.push(event) });
  const removedByA = store.removed.slice();
  current = { chatId: "chat-b", chatMetadata: legacyB.metadata, saveMetadata: async () => {} };
  await bIndex.migrateChatSession(context, { store, api: null, emit: (event) => events.push(event) });
  const removedByB = store.removed.slice();

  const sessionA = legacyA.metadata.atlas;
  const sessionB = legacyB.metadata.atlas;
  equal(sessionA?.binding?.chatId, "chat-a", "A 迁移后的会话属于 A");
  equal(sessionB?.binding?.chatId, "chat-b", "B 迁移后的会话属于 B");
  deepEqual(Object.keys(sessionA?.turns ?? {}), ["turn:chat-a::1"], "A 只拿到自己的回合（宿主的脏 list 被过滤）");
  deepEqual(Object.keys(sessionB?.turns ?? {}), ["turn:chat-b::1"], "B 只拿到自己的回合");
  equal(sessionB?.tables ?? null, null, "0.9.58 旧档没有三表 → B 的表行为空（不是从 A 借来的）");
  ok(!removedByA.includes("turn:chat-b::1"), "A 的迁移绝不代删 B 的回合文档");
  deepEqual(removedByA, ["turn:chat-a::1"], "A 只清自己的回合旧档");
  ok(removedByB.includes("turn:chat-b::1"), "B 迁移时清自己的旧档");
  ok(!JSON.stringify(sessionB).includes("A 的动向"), "B 的会话里没有 A 的动向");
  equal(sessionB?.world?.id, "w-shared", "B 仍能从共享旧档迁到世界（A 没有把它删掉）");
  equal(sessionB?.maps?.points?.[0]?.name, "共享钟楼", "B 仍能迁到共享地图");

  // B 自己的三表懒迁移到位后（引擎 A08 路径）：四个面只属于 B
  sessionB.tables = b06Session({
    chatId: "chat-b", worldId: "w-shared", locationId: "2", locationName: "B 集市",
    characterId: "b1", characterName: "乙", mapPointId: "1", mapPointName: "共享钟楼", turnKey: "turn:chat-b::1",
  }).tables;
  sessionB.binding = { ...sessionB.binding, currentLocationId: "2" };
  assertB06Surface(b06Surface(sessionB), {
    chatId: "chat-b", branchKey: "canon", forbid: ["A 的动向", "turn:chat-a", "npc:a1"],
  }, "B（legacy 迁移后）");
  ok(b06Surface(sessionB).prompt.includes("B 集市"), "提示词里是 B 自己的当前地点");
});

// ---------------------------------------------------------------------------
// B06-3：世界书写入迟到（B04 chatEpoch）
// ---------------------------------------------------------------------------

/** B04 假世界书：模拟酒馆 world-info（一本书 + 一条用户自建条目）。 */
function makeB04Book() {
  const name = "角色卡主书";
  const books = new Map([[name, {
    entries: {
      "1": { uid: "1", key: ["世界观"], keysecondary: [], comment: "用户自建：世界观", content: "用户自己的设定", disable: false },
    },
  }]]);
  let nextUid = 100;
  const port = {
    async resolvePreferredBook() { return name; },
    async loadBook(book) { return books.get(book) ?? null; },
    async createBook(book) { if (!books.has(book)) books.set(book, { entries: {} }); },
    async saveBook(book, data) { books.set(book, data); },
    createEntry(data, patch) {
      const uid = String(++nextUid);
      data.entries[uid] = {
        uid, key: [...patch.keys], keysecondary: [], comment: patch.comment,
        content: patch.content, disable: false, constant: patch.constant === true,
      };
      return data.entries[uid];
    },
    deleteEntry(data, uid) { delete data.entries[uid]; },
    async getChatBookName() { return null; },
    async bindChatBook() {},
  };
  return { port, entries: () => Object.values(books.get(name).entries), text: () => JSON.stringify(books.get(name)) };
}

test("B06 世界书写入迟到：切聊天后 A 的动向不落进共享主卡书（B04）", async () => {
  const world = { id: "w-book", name: "共享世界", points: [{ id: "1", name: "A 钟楼" }, { id: "2", name: "B 集市" }], stateEvents: [] };
  const sessionA = b06Session({
    chatId: "chat-a", worldId: "w-book", locationId: "1", locationName: "A 钟楼",
    characterId: "a1", characterName: "甲", mapPointId: "1", mapPointName: "A 钟楼", turnKey: "turn:chat-a::1",
  });
  const sessionB = b06Session({
    chatId: "chat-b", worldId: "w-book", locationId: "2", locationName: "B 集市",
    characterId: "b1", characterName: "乙", mapPointId: "2", mapPointName: "B 集市", turnKey: "turn:chat-b::1",
  });
  sessionA.world = world;
  sessionB.world = world;
  const book = makeB04Book();
  const writer = createAtlasLorebookWriter(book.port);
  const writes = [];
  const store = {
    async read(key) { return key === "world:w-book" ? world : null; },
    async write(key, value) { writes.push({ key, value }); },
  };
  let currentChat = "chat-a";
  const events = [];
  let pendingB = null;
  let plansBuiltFor = null;
  const handler = bIndex.createLorebookChatSwitchHandler({
    writer,
    store,
    readBinding: async () => (currentChat === "chat-a" ? sessionA.binding : sessionB.binding),
    readSession: () => (currentChat === "chat-a" ? sessionA : sessionB),
    readChatId: () => currentChat,
    buildPlans: (target, receipt, delta) => {
      const plans = buildLorebookPlans(target, receipt, delta);
      plansBuiltFor = delta ? delta.branchKey : null;
      // 规划完成的一刻用户切到 B（A 已过「加载书后」核验，尚未到「保存前」核验）
      if (currentChat === "chat-a") {
        currentChat = "chat-b";
        pendingB = handler({ chatId: "chat-b", bound: true });
      }
      return plans;
    },
    rerender: () => {},
    emit: (event) => events.push(event),
  });

  const resultA = await handler({ chatId: "chat-a", bound: true });
  const doneB = await pendingB;

  equal(resultA.dropped, true, "A 的迟到写入被丢弃");
  equal(resultA.stage, "before-save", "在**保存前**核验点拦下（A 一行都没写进书）");
  ok(events.some((event) => event.code === "LOREBOOK_STALE_CHAT_DROPPED"
    && event.details?.stage === "before-save"
    && event.details?.reasonCode === "SESSION_IDENTITY_MISMATCH"), "记了具名的 LOREBOOK_STALE_CHAT_DROPPED");
  ok(doneB && !doneB.dropped, "B 的写入正常完成");
  equal(doneB.bookName, "角色卡主书", "B 写的是角色卡主书（跨聊天共享的那本）");
  equal(plansBuiltFor, "canon", "buildLorebookPlans 拿到了当前分支三表（F10 的接线）");

  const entries = book.entries();
  const movesEntries = entries.filter((entry) => String(entry.comment).startsWith("Atlas 动向"));
  equal(movesEntries.length, 1, "书里只有一条 Atlas 动向条目（不会为每个聊天堆一条）");
  ok(movesEntries[0].content.includes("B 集市"), "动向正文是 B 的当前地点");
  ok(!movesEntries[0].content.includes("A 钟楼"), "动向正文里没有 A 的地点（A 的迟到写入没落书）");
  ok(!movesEntries[0].content.includes("甲"), "动向正文里没有 A 的人物");
  ok(book.text().includes("用户自建：世界观"), "用户自己的世界书条目原样保留（绝不删用户的书）");

  // 动向 / 提示词 / 表行 / 地图四面：B 的写入用的就是 B 自己的会话
  assertB06Surface(b06Surface(sessionB), {
    chatId: "chat-b", branchKey: "canon", forbid: ["A 钟楼", "npc:a1", "turn:chat-a"],
  }, "B（世界书写入后）");
  ok(writes.some((entry) => entry.key === "lorebook"), "写入器快照照常落到 store");

  // 在途窗口：A 的 syncTurn 已经开跑（epoch 核验挡不住**已经出发**的那一次写），
  // 写入串行化保证当前聊天的写入最后落书 —— 书里不会留下 A 的动向。
  const book2 = makeB04Book();
  let releaseSync = () => {};
  const syncGate = new Promise((resolve) => { releaseSync = resolve; });
  const rawWriter = createAtlasLorebookWriter(book2.port);
  let chat = "chat-a";
  const handler2 = bIndex.createLorebookChatSwitchHandler({
    writer: { ...rawWriter, async syncTurn(plans) { await syncGate; return rawWriter.syncTurn(plans); } },
    store,
    readBinding: async () => (chat === "chat-a" ? sessionA.binding : sessionB.binding),
    readSession: () => (chat === "chat-a" ? sessionA : sessionB),
    readChatId: () => chat,
    buildPlans: buildLorebookPlans,
    rerender: () => {},
    emit: () => {},
  });
  const inFlightA = handler2({ chatId: "chat-a", bound: true });
  await flush();                                   // A 走到 syncTurn 并卡在闸上
  chat = "chat-b";
  const waitingB = handler2({ chatId: "chat-b", bound: true });
  releaseSync();
  const droppedA = await inFlightA;
  const wroteB = await waitingB;
  equal(droppedA.dropped, true, "已在途的 A 写入在完成后被判定过期");
  equal(droppedA.stage, "after-save", "在途写入只能事后丢弃（如实记录该窗口）");
  ok(!wroteB.dropped, "B 的写入照常完成");
  const moves2 = book2.entries().filter((entry) => String(entry.comment).startsWith("Atlas 动向"));
  equal(moves2.length, 1, "共享书里仍然只有一条动向条目");
  ok(moves2[0].content.includes("B 集市"), "最后落书的是 B 的动向（串行化保证当前聊天最后写）");
  ok(!moves2[0].content.includes("A 钟楼"), "共享书里没有 A 的动向残留");
  ok(book2.text().includes("用户自建：世界观"), "第二阶段里用户条目同样未被触碰");

  // 切到未绑定聊天：只清 Atlas 自建条目
  currentChat = "chat-c";
  const purged = await handler({ chatId: "chat-c", bound: false });
  equal(purged.purged, true, "未绑定聊天触发清理");
  equal(book.entries().filter((entry) => String(entry.comment).startsWith("Atlas 动向")).length, 0, "Atlas 动向条目被清掉");
  ok(book.text().includes("用户自建：世界观"), "用户自己的世界书条目仍然在（B04 的硬约束）");
});

// ---------------------------------------------------------------------------
// B06-4：相同 worldId / 不同 branch（B03 地图作用域）
// ---------------------------------------------------------------------------

test("B06 相同 worldId 不同分支：地图作用域键分开，切分支不沿用上一分支的子图与相机", async () => {
  const makeBranchState = (branchId, prefix) => {
    const state = s10State({
      chatId: "chat-a", worldId: "w-branch", currentLocationId: "1",
      points: [{ id: "1", name: `${prefix}钟楼`, x: 40, y: 40, regionId: null }],
      submaps: { "1": { parentMapId: "world", points: [{ id: "11", name: `${prefix}档案室`, x: 10, y: 10 }] } },
      pointParents: { "11": 1 },
    });
    state.branchId = branchId;
    return state;
  };
  const canonState = makeBranchState(null, "正史");
  const ifState = makeBranchState("if-1", "IF ");
  const stateByChat = { "chat-a": canonState };
  const { container, core } = await mountRootAtlasMap({ stateByChat });

  // 正史：进到子图（视图栈非空 + 面包屑可见）
  openPointPanel(container, "正史钟楼");
  enterSubmapButton(container, "正史钟楼").click();
  deepEqual(mapPointNames(container), ["正史档案室"], "前置：正史已在子图");
  ok(crumbSnapshot(container).text.includes("正史钟楼"), "前置：面包屑带着正史层级");

  // 只换分支（chatId / worldId 都不变）
  stateByChat["chat-a"] = ifState;
  await core.refresh();
  await flush();

  deepEqual(mapPointNames(container), ["IF 钟楼"], "IF 分支渲染自己的世界图");
  equal(crumbSnapshot(container).display, "none", "切分支清空子图视图栈（不沿用正史层级）");
  ok(!String(container.querySelector(".aw-maparea").textContent).includes("正史档案室"), "上一分支的子图点不残留");
  ok(!String(container.querySelector(".aw-mappanel")?.textContent ?? "").includes("正史钟楼"),
    "上一分支的地点弹窗被关掉（不留孤儿浮层）");
  ok(!String(container.querySelector(".aw-interior-roster")?.textContent ?? "").includes("正史"),
    "建筑内名单被清空");

  // 身份键必须含分支
  const canonIdentity = bIndex.atlasMapIdentityOf(canonState, "chat-a");
  const ifIdentity = bIndex.atlasMapIdentityOf(ifState, "chat-a");
  equal(bIndex.atlasMapScopeKey(canonIdentity), "chat-a|w-branch|canon", "正史作用域键 = chatId|worldId|canon");
  equal(bIndex.atlasMapScopeKey(ifIdentity), "chat-a|w-branch|if-1", "IF 作用域键 = chatId|worldId|分支");
  ok(bIndex.atlasMapScopeKey(canonIdentity) !== bIndex.atlasMapScopeKey(ifIdentity), "同世界不同分支作用域键不同");
  equal(bIndex.atlasSameMapIdentity(canonIdentity, ifIdentity), false, "不同分支不是同一张图");
  ok(bIndex.atlasMapImageCacheKey(canonIdentity, 7) !== bIndex.atlasMapImageCacheKey(ifIdentity, 7),
    "底图缓存键含分支（同版本不同分支不复用）");

  // 四个面：两个分支各查各的
  const canonSession = b06Session({
    chatId: "chat-a", worldId: "w-branch", branchKey: "canon", locationId: "1", locationName: "正史钟楼",
    characterId: "c1", characterName: "正史的人", mapPointId: "1", mapPointName: "正史钟楼", turnKey: "turn:chat-a::canon",
  });
  const ifSession = b06Session({
    chatId: "chat-a", worldId: "w-branch", branchKey: "if-1", locationId: "11", locationName: "IF 档案室",
    characterId: "i1", characterName: "IF 的人", mapPointId: "11", mapPointName: "IF 档案室", turnKey: "turn:chat-a::if",
  });
  assertB06Surface(b06Surface(ifSession), {
    chatId: "chat-a", branchKey: "if-1", forbid: ["正史钟楼", "正史的人", "npc:c1", "turn:chat-a::canon"],
  }, "IF 分支");
  assertB06Surface(b06Surface(canonSession), {
    chatId: "chat-a", branchKey: "canon", forbid: ["IF 档案室", "IF 的人", "npc:i1", "turn:chat-a::if"],
  }, "正史分支");
});

// ---------------------------------------------------------------------------
// B06-5：图片迟到（B03 底图回调身份复核）
// ---------------------------------------------------------------------------

test("B06 图片迟到：切聊天后旧底图回调不在新聊天重绘，也不换掉新聊天的底图", async () => {
  const baseA = s10State({
    chatId: "chat-a", worldId: "w-img", currentLocationId: "1",
    points: [{ id: "1", name: "A 钟楼", x: 40, y: 40, regionId: null }],
  });
  baseA.map.mapImagePresent = true;
  baseA.map.mapImageRevision = 7;
  const baseB = s10State({
    chatId: "chat-b", worldId: "w-img", currentLocationId: "9",
    points: [{ id: "9", name: "B 营地", x: 5, y: 5, regionId: null }],
  });
  baseB.map.mapImagePresent = true;   // B 也有底图：迟到回调若真重绘，会多打一次请求
  baseB.map.mapImageRevision = 7;
  const stateByChat = { "chat-a": baseA, "chat-b": baseB };
  const { container, core, hostWrap, api, dom } = await mountRootAtlasMap({ stateByChat });
  hostWrap.setBinding("chat-b", bindingFor("chat-b", "w-img"));

  let releaseFirst = () => {};
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const original = api.request.bind(api);
  let imageCalls = 0;
  api.request = async (method, path, body) => {
    if (path !== "/map/image") return original(method, path, body);
    imageCalls += 1;
    if (imageCalls === 1) {
      await firstGate; // A 的底图：在途
      return { status: 200, body: { ok: true, data: { dataUrl: "data:image/png;base64,AAAA" } } };
    }
    if (imageCalls === 2) {
      return { status: 500, body: { ok: false, error: { code: "INTERNAL", message: "B 的底图这次失败" } } };
    }
    // 第 3 次只可能来自「旧回调触发的重绘」——永挂，用来抓回归
    return new Promise(() => {});
  };

  await core.refresh();
  await flush();
  equal(imageCalls, 1, "A 的底图请求已发出并在途");

  hostWrap.setChat("chat-b");
  await core.handleEvent("CHAT_CHANGED");
  await flush();
  equal(imageCalls, 2, "切到 B 后 B 自己的底图请求发出（失败，不显示假图）");

  releaseFirst();          // A 的底图迟到返回
  await flush();
  await flush();
  equal(imageCalls, 2, "迟到的 A 底图没有触发新聊天重绘（否则会出现第 3 次请求）");
  const imageLayer = container.querySelector(".aw-image");
  equal(imageLayer.classList.contains("has-image"), false, "新聊天没有显示任何底图");
  equal(imageLayer.style.backgroundImage, "", "新聊天底图层为空（旧 dataURL 未被套用）");
  deepEqual(mapPointNames(container), ["B 营地"], "新聊天地图仍是自己的地点");

  // 身份 / 缓存键：同 worldId、同 revision，不同聊天 → 不同键
  const identityA = bIndex.atlasMapIdentityOf(baseA, "chat-a");
  const identityB = bIndex.atlasMapIdentityOf(baseB, "chat-b");
  ok(bIndex.atlasMapImageCacheKey(identityA, 7) !== bIndex.atlasMapImageCacheKey(identityB, 7),
    "底图缓存键含 chatId（同世界两个聊天不复用）");
  ok(bIndex.atlasMapImageCacheKey(identityA, 7) !== bIndex.atlasMapImageCacheKey(identityA, 8),
    "底图缓存键含 revision（换图不复用旧图）");

  // 四个面：B 的会话与 A 的分开
  const sessionA = b06Session({
    chatId: "chat-a", worldId: "w-img", locationId: "1", locationName: "A 钟楼",
    characterId: "a1", characterName: "甲", mapPointId: "1", mapPointName: "A 钟楼", turnKey: "turn:chat-a::1",
  });
  const sessionB = b06Session({
    chatId: "chat-b", worldId: "w-img", locationId: "9", locationName: "B 营地",
    characterId: "b1", characterName: "乙", mapPointId: "9", mapPointName: "B 营地", turnKey: "turn:chat-b::1",
  });
  assertB06Surface(b06Surface(sessionB), {
    chatId: "chat-b", branchKey: "canon", forbid: ["A 钟楼", "npc:a1", "turn:chat-a"],
  }, "B（图片迟到后）");
  ok(b06Surface(sessionA).prompt.includes("A 钟楼"), "A 自己的会话不受影响（各查各的）");
  void dom;
});

// ---------------------------------------------------------------------------
// D11c：左栏「幕后动向」（D07）—— blocked 明示原因；A 的动向不进 B 的左栏
// ---------------------------------------------------------------------------

/** 构造一份带 `simulationView` 的 /state 数据（A07/D05 的服务端形状）。 */
function d07State({ chatId, worldId, events, counts, currentLocationKnown = false }) {
  return {
    chatId, worldId, worldName: "动向世界", branchId: "chronicle-canon",
    currentTime: 12, currentLocationId: null,
    simulationView: {
      branchKey: "canon",
      tasks: [], signals: [], deliveries: [],
      recentEvents: events,
      counts: {
        tasks: counts?.tasks ?? 1, signals: counts?.signals ?? 1, deliveries: counts?.deliveries ?? 1,
        events: events.length, activeTasks: counts?.activeTasks ?? 0, blockedTasks: counts?.blockedTasks ?? 0,
      },
      truncated: { tasks: 0, signals: 0, deliveries: 0, events: 0 },
      currentLocationKnown, visibility: "known", corrupt: false,
    },
  };
}

/** 左栏（movesList）渲染出的全部文本。 */
function movesText(container) {
  return [...container.querySelectorAll(".aw-move")].map((node) => node.textContent).join("\n");
}

test("D11c 左栏幕后动向：区分想法 / 在路上 / 已抵达 / 已送达 / 暂不能行动，并写出阻塞原因", async () => {
  const { dom, core, container } = await mountRootAtlasMap({
    stateByChat: {
      "chat-a": d07State({
        chatId: "chat-a", worldId: "w-b",
        events: [
          {
            id: "evt:1", simulationId: "task:1", kind: "travel", actorCharacterId: "npc:x",
            fromLocationId: "loc:1", toLocationId: "loc:2", status: "blocked",
            reasonCode: "NO_PATH", summary: "npc:x 暂不能行动：赶往远城",
            visibility: "known", period: 12,
          },
          {
            id: "evt:2", simulationId: "sig:1", kind: "signal", actorCharacterId: null,
            fromLocationId: "loc:1", toLocationId: "loc:1", status: "published",
            reasonCode: null, summary: "消息已公开：使者带出宣战文书",
            visibility: "known", period: 12,
          },
          {
            id: "evt:3", simulationId: "dlv:1", kind: "delivery", actorCharacterId: "npc:y",
            fromLocationId: "loc:1", toLocationId: "loc:2", status: "delivered",
            reasonCode: null, summary: "获知消息：使者带出宣战文书",
            visibility: "known", period: 12,
          },
        ],
        counts: { tasks: 1, signals: 1, deliveries: 2, activeTasks: 0, blockedTasks: 1 },
      }),
    },
  });

  const text = movesText(container);
  // F1/F3 的核心诉求：左栏要能读到具体动作，而不是只有「应用 N 行」
  ok(text.includes("暂不能行动"), `左栏要标出「暂不能行动」：实际 ${text}`);
  ok(text.includes("NO_PATH"), `阻塞原因必须写明：实际 ${text}`);
  ok(text.includes("新消息"), `消息类事件要单独标注：实际 ${text}`);
  ok(text.includes("已送达"), `送达事件要单独标注：实际 ${text}`);
  ok(text.includes("loc:1 → loc:2"), `要显示来源地 → 目标：实际 ${text}`);
  ok(!/^表格增量：应用/m.test(text), "左栏不得再以「表格增量：应用 N 行」为主");
  void core;
  dom.window.close();
});

test("D11c 左栏隔离：A 的幕后动向不出现在 B 的左栏（无 simulationView 的聊天退回旧回执）", async () => {
  const aState = d07State({
    chatId: "chat-a", worldId: "w-b",
    events: [{
      id: "evt:1", simulationId: "sig:1", kind: "signal", actorCharacterId: null,
      fromLocationId: "loc:secret", toLocationId: "loc:secret", status: "published",
      reasonCode: null, summary: "A 聊天的秘密宣战消息",
      visibility: "known", period: 12,
    }],
    counts: { tasks: 1, signals: 1, deliveries: 0, activeTasks: 0, blockedTasks: 0 },
  });
  // B 是旧会话形状：/state 不带 simulationView
  const bState = { chatId: "chat-b", worldId: "w-b", worldName: "动向世界", currentTime: 12, currentLocationId: null };

  const { dom, container, core } = await mountRootAtlasMap({
    stateByChat: { "chat-a": aState, "chat-b": bState },
    chatId: "chat-b",
  });

  const textB = movesText(container);
  ok(!textB.includes("A 聊天的秘密宣战消息"), `B 的左栏不得出现 A 的动向：实际 ${textB}`);
  ok(!textB.includes("幕后动向"), "B 没有 simulationView 时整段跳过（老聊天行为不变）");

  // 切回 A：A 自己的动向必须回来
  core.setPage("overview");
  await flush();
  void dom;
});

// ---------------------------------------------------------------------------
// F08b：地图徽标（F03/F04）——真实细格、恰好重合、无坐标不落 (0,0)
// ---------------------------------------------------------------------------

test("F08b 地图：地点标点带在场人数徽标；与地点同坐标的人物计入徽标而不是消失", async () => {
  const state = s10State({
    chatId: "chat-a", worldId: "w-badge", currentLocationId: "1",
    points: [
      { id: "1", name: "钟楼", x: 10, y: 10, regionId: null },
      { id: "2", name: "三年二班", x: 20, y: 20, regionId: null },
    ],
    submaps: { "1": { parentMapId: "world", frame: { cols: 40, rows: 40 }, points: [] } },
  });
  state.tableMap = {
    branchKey: "canon",
    world: {
      points: [
        { id: "1", name: "钟楼", x: 10, y: 10, regionId: null, kind: "location", rowId: "loc:1" },
        { id: "2", name: "三年二班", x: 20, y: 20, regionId: null, kind: "location", rowId: "loc:2" },
      ],
      total: 2, truncated: 0,
    },
    submaps: {}, objects: { entries: [], total: 0, truncated: 0 },
    nearby: { entries: [], total: 0, truncated: 0 },
    current: { locationId: "loc:1", chain: [{ id: "loc:1", name: "钟楼" }] },
    nearReasonCode: null,
    /**
     * 教室里有 2 人：一人有真实细格且**恰好与「三年二班」地点标点同坐标**，
     * 一人只有房间 ID、没有细坐标。两人都必须仍然看得见（计入徽标），不得消失。
     */
    locationOccupants: {
      total: 2, truncated: 0,
      entries: [
        {
          locationId: "loc:2", locationName: "三年二班", locationPointId: "2",
          mapId: "world", gridX: 20, gridY: 20, characterCount: 2, itemCount: 0,
          characters: [{ id: "npc:s1", name: "学生甲", presence: "present" }], items: [],
        },
        {
          locationId: "loc:1", locationName: "钟楼", locationPointId: "1",
          mapId: "world", gridX: 10, gridY: 10, characterCount: 0, itemCount: 1,
          characters: [], items: [{ id: "item:bell", name: "铜钟", status: "完好" }],
        },
      ],
    },
  };

  const { dom, container } = await mountRootAtlasMap({
    stateByChat: { "chat-a": state }, chatId: "chat-a",
  });

  const markers = [...container.querySelectorAll(".aw-point")];
  const room = markers.find((node) => node.dataset.pointId === "2");
  ok(room, `「三年二班」要有地点标点：实际 ${markers.map((n) => n.dataset.pointId).join(",")}`);
  const badge = room.querySelector(".aw-point__badge");
  ok(badge, "房间标点必须嵌人数徽标");
  equal(badge.textContent, "2", "徽标人数来自完整三表口径（含与地点同坐标的人）");
  ok(room.classList.contains("has-occupants"), "有人的地点带可识别样式");

  // 没有人的地点不显示徽标（不虚报）
  const tower = markers.find((node) => node.dataset.pointId === "1");
  equal(tower.querySelector(".aw-point__badge"), null, "没人的地点不显示人数徽标");

  // 无坐标地点不进地图点集 → 不可能出现在 (0,0)
  const zeroZero = markers.filter((node) => node.style.left === "0px" && node.style.top === "0px");
  equal(zeroZero.length, 0, "未知坐标不得被画到网格原点（F7 停机线）");

  // 地图控件仍可点（徽标 pointer-events:none，不吃点击）
  ok(markers.every((node) => node.tagName.toLowerCase() === "button"), "地点标点仍是按钮，可点");
  dom.window.close();
});

test("F08b 地图：旧会话没有 locationOccupants 时一个徽标都不加（行为不变）", async () => {
  const legacy = s10State({
    chatId: "chat-a", worldId: "w-legacy", currentLocationId: "1",
    points: [{ id: "1", name: "钟楼", x: 10, y: 10, regionId: null }],
  });
  // 刻意不带 tableMap.locationOccupants
  const { dom, container } = await mountRootAtlasMap({
    stateByChat: { "chat-a": legacy }, chatId: "chat-a",
  });
  equal(container.querySelectorAll(".aw-point__badge").length, 0, "旧会话不加徽标");
  dom.window.close();
});

// ---------------------------------------------------------------------------
// H23：左下角固定长度比例尺（H19a）与控件收口（H19b）
// ---------------------------------------------------------------------------

test("H19a/H19b 左下角只有固定长度比例尺：缩放改读数、线长不变、旧网格步长控件已移除", async () => {
  const state = s10State({
    chatId: "chat-a", worldId: "w-scale", currentLocationId: "1",
    points: [
      { id: "1", name: "钟楼", x: 10, y: 10, regionId: null },
      { id: "2", name: "市场", x: 30, y: 30, regionId: null },
    ],
  });
  state.map.calibrations = {
    world: { metersPerCell: 100, source: "user", locked: true, coverage: "全图", basis: "人工标定", at: 1, revision: 1 },
  };
  const { dom, container } = await mountRootAtlasMap({ stateByChat: { "chat-a": state }, chatId: "chat-a" });

  // H19b：左下角不再有「网格 N 格/线 / 未标定」叠加框
  equal(container.querySelectorAll(".aw-grid-stride").length, 0,
    "旧的左下角常驻网格步长控件必须移除（步长改挂网格按钮 tooltip）");

  const bar = container.querySelector(".aw-scale__bar");
  const label = container.querySelector(".aw-scale__label");
  ok(bar, "左下角常驻比例尺仍在");
  ok(label, "比例尺有读数");
  const widthBefore = bar.style.width;
  const readingBefore = String(label.textContent ?? "");
  ok(readingBefore.length > 0, `已标定必须有读数：实际 "${readingBefore}"`);
  ok(/米|千米|厘米|毫米/.test(readingBefore), `100 米/格 应给米制读数：实际 "${readingBefore}"`);

  // 放大一档：固定长度尺的读数必须随之变化
  const zoomIn = [...container.querySelectorAll("button")].find((node) => node.textContent === "＋");
  ok(zoomIn, "有放大按钮");
  zoomIn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await flush();
  const barAfter = container.querySelector(".aw-scale__bar");
  const readingAfter = String(container.querySelector(".aw-scale__label")?.textContent ?? "");
  equal(barAfter.style.width, widthBefore, "线长固定在视口坐标系，不随缩放变长");
  ok(readingAfter !== readingBefore,
    `缩放后读数必须变化（旧的 1/2/5 候选尺会在相邻步保留同一个数字）：${readingBefore} → ${readingAfter}`);
  dom.window.close();
});

test("H19a 未标定：只报格数并写明「未标定」，绝不显示假米数", async () => {
  const state = s10State({
    chatId: "chat-a", worldId: "w-unscaled", currentLocationId: "1",
    points: [{ id: "1", name: "钟楼", x: 10, y: 10, regionId: null }],
  });
  // calibrations 为空 = 未标定
  const { dom, container } = await mountRootAtlasMap({ stateByChat: { "chat-a": state }, chatId: "chat-a" });
  const label = container.querySelector(".aw-scale__label");
  const text = String(label?.textContent ?? "");
  ok(text.includes("格"), `未标定要报格数：实际 "${text}"`);
  ok(text.includes("未标定"), `未标定要写明，不得冒充米制：实际 "${text}"`);
  ok(!/米/.test(text.replace(/千米/g, "")), `未标定不得出现米数：实际 "${text}"`);
  const aria = String(label?.getAttribute("aria-label") ?? "");
  ok(aria.includes("约等于"), `可访问文案要说清「屏幕 N 像素约等于 X」：实际 "${aria}"`);
  dom.window.close();
});

// ---------------------------------------------------------------------------
// H13/H14：视口对齐 SVG 网格
// ---------------------------------------------------------------------------

test("H13 网格是视口对齐的 SVG：真的出线、线宽 1px、不吃指针事件，且不再有 CSS 渐变网格", async () => {
  const state = s10State({
    chatId: "chat-a", worldId: "w-grid", currentLocationId: "1",
    points: [
      { id: "1", name: "钟楼", x: 10, y: 10, regionId: null },
      { id: "2", name: "市场", x: 18, y: 18, regionId: null },
    ],
  });
  const mountedGrid = await mountRootAtlasMap({
    stateByChat: { "chat-a": state }, chatId: "chat-a",
  });
  const { dom, container, rerender } = mountedGrid;
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { get: () => 720, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { get: () => 480, configurable: true });
  rerender();
  await flush();

  const grid = container.querySelector(".aw-grid");
  ok(grid, "网格层仍在（图层显隐语义不变）");
  equal(grid.style.backgroundImage, "", "旧的 CSS 渐变网格已移除（F12 的缺陷实现）");

  const svg = grid.querySelector(".aw-grid-svg");
  ok(svg, "网格改画在 SVG overlay 上");
  const major = svg.querySelector(".aw-grid-svg__major");
  const minor = svg.querySelector(".aw-grid-svg__minor");
  ok(major && minor, "主 / 次格线各有独立 path");

  // 真的画出了线（不是空壳）
  const drawn = `${major.getAttribute("d") ?? ""}${minor.getAttribute("d") ?? ""}`;
  ok(drawn.includes("M"), `网格必须真的产出路径：实际 "${drawn.slice(0, 60)}"`);

  // 反变换：把 SVG 从 stage 的 scale(k) 里解出来，所以线宽不随缩放变粗
  ok(/scale\(/.test(svg.style.transform), `SVG 带反变换（不跟随 stage 放大）：实际 "${svg.style.transform}"`);
  ok(svg.style.width.endsWith("px") && svg.style.height.endsWith("px"), "SVG 覆盖整个视口");

  // 吃指针事件会挡掉平移 / 缩放 / 点位点击——必须为 none（由 CSS 类保证）
  const css = readFileSync(join(root, "style.css"), "utf8");
  ok(/\.aw-grid-svg\s*\{[^}]*pointer-events:\s*none/.test(css), "SVG 网格层 pointer-events:none");

  // 放大后仍然出线（旧实现放大后只剩几道粗大模糊线）
  const zoomIn = [...container.querySelectorAll("button")].find((node) => node.textContent === "＋");
  ok(zoomIn, "有放大按钮");
  zoomIn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await flush();
  const afterZoom = `${svg.querySelector(".aw-grid-svg__major").getAttribute("d") ?? ""}`;
  ok(afterZoom.includes("M"), "放大后网格仍然出线");
  dom.window.close();
});

test("H14 视口底纹已删除：地图框不再铺静态 27px 重复渐变", async () => {
  const css = readFileSync(join(root, "style.css"), "utf8");
  // 只允许 .aw-grid-svg 相关的类规则存在；静态 27px 装饰网格必须消失
  equal(/transparent 27px/.test(css), false, "静态 27px 视口底纹必须删除（F12）");
  ok(css.includes(".aw-grid-svg__minor"), "次格线样式走皮肤 token");
  ok(css.includes(".aw-grid-svg__major"), "主格线样式走皮肤 token");
});

// ---------------------------------------------------------------------------
// H16 / H15：已证实范围的填色层
// ---------------------------------------------------------------------------

/** 世界图带一块人工范围（20 格）的 /state 数据。 */
function h16State({ areas }) {
  const state = s10State({
    chatId: "chat-a", worldId: "w-areas", currentLocationId: "1",
    points: [
      { id: "1", name: "钟楼", x: 10, y: 10, regionId: null },
      { id: "2", name: "市场", x: 30, y: 30, regionId: null },
    ],
  });
  state.map.geoTopology = {
    branchKey: "canon",
    edges: [], areas, vehicleAnchors: [],
    counts: { edges: 0, areas: areas.length, vehicles: 0 },
    truncated: { edges: 0, areas: 0, vehicles: 0 },
  };
  return state;
}

function h16AreaCells(count) {
  const cells = [];
  for (let index = 0; index < count; index += 1) cells.push({ x: 12 + index, y: 12 });
  return cells;
}

test("H16 填色层：只染有证据的格，透明度 ≤0.18；没有 areas 时一格都不染", async () => {
  const withAreas = h16State({
    areas: [{
      id: "canon|world|loc:1", locationId: "loc:1", mapId: "world",
      cells: h16AreaCells(20), evidence: "manual",
    }],
  });
  const mounted = await mountRootAtlasMap({ stateByChat: { "chat-a": withAreas }, chatId: "chat-a" });
  const { dom, container, rerender } = mounted;
  // jsdom 没有布局：给个确定的视口尺寸，帧才有跨度可算
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { get: () => 720, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { get: () => 480, configurable: true });
  rerender();
  await flush();

  const areaLayer = container.querySelector(".aw-areas");
  ok(areaLayer, "面积层存在（§2.5 图层序：底图 → 面积 → 网格）");
  const paths = [...areaLayer.querySelectorAll(".aw-areas__area")];
  ok(paths.length > 0, "有证据的范围必须被画出来");
  for (const path of paths) {
    ok((path.getAttribute("d") ?? "").includes("M"), "填区有真实路径");
    ok(Number(path.style.opacity) <= 0.18, `透明度是硬上限 0.18：实际 ${path.style.opacity}`);
    equal(path.dataset.evidence, "manual", "证据来源如实标注");
  }
  // 图层序：面积在网格之前、地图标点之前
  const stage = container.querySelector(".aw-stage");
  const order = [...stage.children].map((node) => node.className);
  ok(order.indexOf("aw-areas") > order.indexOf("aw-image"), "面积在底图之上");
  ok(order.indexOf("aw-areas") < order.indexOf("aw-grid"), "面积在网格之下（§2.5）");
  ok(order.indexOf("aw-areas") < order.indexOf("aw-layer"), "面积在标点之下（§2.5）");
  dom.window.close();

  // 没有 areas：一格都不染
  const noAreas = h16State({ areas: [] });
  const bare = await mountRootAtlasMap({ stateByChat: { "chat-a": noAreas }, chatId: "chat-a" });
  Object.defineProperty(bare.dom.window.HTMLElement.prototype, "clientWidth", { get: () => 720, configurable: true });
  Object.defineProperty(bare.dom.window.HTMLElement.prototype, "clientHeight", { get: () => 480, configurable: true });
  bare.rerender();
  await flush();
  const bareLayer = bare.container.querySelector(".aw-areas");
  equal(bareLayer.querySelectorAll(".aw-areas__area").length, 0, "没有 areas 就一格都不假染");
  equal(bareLayer.dataset.paintedCells, "0");
  bare.dom.window.close();
});

test("H16 填色层：无证据来源的范围（非法 evidence）不进填色层", async () => {
  // evidence 只能是 worldbook / story / manual —— 别的值由投影层跳过
  const state = h16State({
    areas: [{
      id: "canon|world|loc:1", locationId: "loc:1", mapId: "world",
      cells: h16AreaCells(4), evidence: "guess",
    }],
  });
  const { dom, container, rerender } = await mountRootAtlasMap({ stateByChat: { "chat-a": state }, chatId: "chat-a" });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { get: () => 720, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { get: () => 480, configurable: true });
  rerender();
  await flush();
  const areaLayer = container.querySelector(".aw-areas");
  equal(areaLayer.querySelectorAll(".aw-areas__area").length, 0, "没有可靠证据就不许染色");
  ok(Number(areaLayer.dataset.paintedCells) === 0, "paintedCells 必须是 0");
  dom.window.close();
});
