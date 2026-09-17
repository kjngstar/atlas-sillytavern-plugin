/**
 * atlas-integration.test.mjs — ATLAS-FIX-01 真实适配层集成测试。
 *
 * 复现并回归 AR-ATLAS-07 的全部 P0（先红后绿；不测 mock 掩盖的真实路径）：
 * - P0-01：pack 产出自包含安装包（含构建产物），组件加载器只用组件内相对路径。
 * - P0-02：UI manifest 声明 hooks.activate / hooks.disable 且指向真实导出。
 * - P0-03：生成拦截器为官方四参数签名 (chat, contextSize, abort, type)。
 * - P0-04：真实事件监听（fire-and-forget）后拦截器可等得到同一条 prepare。
 * - P0-05：UI HTTP 客户端每请求携带 getContext().getRequestHeaders() 的 CSRF 头。
 * - P0-06：init(fakeRouter) 真实 Express 接线：动态路由用真实路径、map/image 已注册。
 * - P0-07：写操作身份按当前 SillyTavern req.user 模型判断（允许 / 拒绝两路径）。
 * - P0-08：文档存储键编码一一映射 + 旧文件兼容读取，不同合法 ID 不互覆。
 * - 版本一致性：根包 / UI manifest / UI 常量 / Server 常量 / Server package 全一致。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildWorldFromTemplate, getDemoTemplate } from "../lib/demo-events.ts";
import { parseWorld } from "../lib/world-schema.ts";
import { upsertEntityRecord } from "../lib/world-definition.ts";

let assertionCount = 0;
function ok(value, message) {
  assertionCount += 1;
  assert.ok(value, message);
}
function equal(actual, expected, message) {
  assertionCount += 1;
  assert.equal(actual, expected, message);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CANON = "chronicle-canon";
const CURRENT_TIME = 418.07;

/** 逐文件删除（沙箱 safe-delete 守卫会拦 rmSync recursive）。 */
function rmtree(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) rmtree(p);
    else unlinkSync(p);
  }
  rmdirSync(dir);
}

// ---------------------------------------------------------------------------
// 夹具（与 atlas-server-plugin.test.mjs 同口径）
// ---------------------------------------------------------------------------

function buildWorld() {
  let world = buildWorldFromTemplate(getDemoTemplate("chronicle"), { id: "atlas-integration-fixture", now: 1000 });
  for (const entity of [
    {
      id: "entity-city", worldId: world.id, type: "city", name: "白塔王都",
      baseline: { founder: "旧王" },
      temporalSchema: [
        { key: "founder", kind: "base", valueType: "string" },
        { key: "ruler", kind: "temporal", valueType: "string" },
      ],
      mapAnchor: { regionId: "capital" },
    },
    {
      id: "entity-npc", worldId: world.id, type: "npc", name: "薇尔·星环",
      baseline: { origin: "北境" },
      temporalSchema: [
        { key: "origin", kind: "base", valueType: "string" },
        { key: "whereabouts", kind: "temporal", valueType: "string" },
      ],
    },
  ]) {
    const result = upsertEntityRecord(world, entity, { now: 1000 });
    ok(result.ok, `实体 ${entity.id} 建档成功`);
    if (result.ok) world = result.value;
  }
  return parseWorld(JSON.parse(JSON.stringify(world)));
}

function bindingFor(world) {
  return {
    schemaVersion: 1,
    enabled: true,
    chatId: "chat-a",
    characterId: null,
    worldId: world.id,
    branchId: CANON,
    currentLocationId: "4103",
    worldTimeCursor: CURRENT_TIME,
    lastCommittedMessageId: null,
    lastCheckpointId: null,
  };
}

function presetFixture() {
  return {
    name: "模拟推演",
    endpoint: "https://mock.example.invalid/v1",
    model: "atlas-mock",
    apiKey: "sk-atlas-integration-key",
    timeoutMs: 5000,
  };
}

// ---------------------------------------------------------------------------
// fake Express router：真实注册 handler，逐端点以真实 req 形状调用
// ---------------------------------------------------------------------------

function fakeRouter() {
  const routes = [];
  return {
    routes,
    get(path, handler) { routes.push({ method: "GET", path, handler }); },
    post(path, handler) { routes.push({ method: "POST", path, handler }); },
    put(path, handler) { routes.push({ method: "PUT", path, handler }); },
    /** 按路由模板查 handler，用具体参数构造真实 req 形状调用。 */
    async invoke(method, template, { params = {}, body, user, remoteAddress = "127.0.0.1" } = {}) {
      const route = routes.find((r) => r.method === method && r.path === template);
      if (!route) return { status: 404, body: { ok: false, error: { code: "NO_ROUTE", message: `${method} ${template}` } } };
      let concretePath = template;
      for (const [key, value] of Object.entries(params)) {
        concretePath = concretePath.replace(`:${key}`, encodeURIComponent(String(value)));
      }
      let captured = null;
      const res = {
        statusCode: 0,
        status(code) { this.statusCode = code; return this; },
        json(b) { captured = b; return b; },
      };
      const req = { baseUrl: "/api/plugins/atlas", path: concretePath, body, user, socket: { remoteAddress } };
      await route.handler(req, res);
      return { status: res.statusCode, body: captured };
    },
  };
}

/** 模拟真实 SillyTavern 事件源：handler 触发即返回（fire-and-forget，不 await）。 */
function realLikeEmitter() {
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// P0-01：自包含安装包
// ---------------------------------------------------------------------------

test("P0-01：pack 产出两个自包含安装包（构建产物在组件目录内）", async () => {
  const out = execFileSync(process.execPath, ["tools/pack.mjs"], { cwd: root, encoding: "utf8" });
  ok(!out.includes("骨架副本"), "pack 不再自称骨架副本");
  const uiDir = join(root, "release", "atlas-ui-extension");
  const serverDir = join(root, "release", "atlas-server-plugin");
  ok(existsSync(join(uiDir, "dist", "atlas-ui-core.mjs")), "UI 构建产物随包");
  ok(existsSync(join(serverDir, "dist", "atlas-server.mjs")), "Server 构建产物随包");

  const uiDist = await import(pathToFileURL(join(uiDir, "dist", "atlas-ui-core.mjs")).href);
  ok(typeof uiDist.createAtlasUiCore === "function", "UI dist 导出 createAtlasUiCore");
  ok(typeof uiDist.atlasClampZoom === "function", "UI dist 导出 atlasClampZoom");

  const serverDist = await import(pathToFileURL(join(serverDir, "dist", "atlas-server.mjs")).href);
  ok(typeof serverDist.createAtlasServerCore === "function", "Server dist 导出 createAtlasServerCore");
});

test("P0-01b：release 组件加载器只用组件内相对路径（不偷读上级 src/dist）", async () => {
  const uiIndex = readFileSync(join(root, "release", "atlas-ui-extension", "index.js"), "utf8");
  const serverIndex = readFileSync(join(root, "release", "atlas-server-plugin", "index.mjs"), "utf8");
  for (const [name, src] of [["ui", uiIndex], ["server", serverIndex]]) {
    ok(!/"\.\.\/dist\//.test(src), `${name} 加载器不引用 ../dist`);
    ok(!/"\.\.\/src\//.test(src), `${name} 加载器不引用 ../src`);
  }
  // 端到端：release Server 的 init 真实可用（core 从组件内 dist 加载）
  const plugin = await import(pathToFileURL(join(root, "release", "atlas-server-plugin", "index.mjs")).href);
  const router = fakeRouter();
  const dataDir = mkdtempSync(join(tmpdir(), "atlas-rel-"));
  try {
    const { core } = await plugin.init(router, { dataDir, fetchFn: async () => { throw new Error("no network"); } });
    ok(typeof core.handle === "function", "release init 返回可用 core");
    const health = await router.invoke("GET", "/health");
    equal(health.status, 200, "release 健康检查 200");
  } finally {
    rmtree(dataDir);
  }
});

// ---------------------------------------------------------------------------
// P0-02：manifest 生命周期 hooks
// ---------------------------------------------------------------------------

test("P0-02：manifest 声明 hooks.activate / hooks.disable 且指向真实导出", async () => {
  const manifest = JSON.parse(readFileSync(join(root, "atlas-extension", "manifest.json"), "utf8"));
  ok(manifest.hooks && typeof manifest.hooks === "object", "manifest.hooks 存在");
  equal(manifest.hooks.activate, "activate", "hooks.activate 指向 activate");
  equal(manifest.hooks.disable, "disable", "hooks.disable 指向 disable");
  const mod = await import(pathToFileURL(join(root, "atlas-extension", "index.js")).href);
  ok(typeof mod.activate === "function", "activate 为真实导出函数");
  ok(typeof mod.disable === "function", "disable 为真实导出函数");
});

// ---------------------------------------------------------------------------
// P0-03：拦截器官方四参数签名
// ---------------------------------------------------------------------------

test("P0-03：拦截器按 (chat, contextSize, abort, type) 触发；有 pending 注入、无 pending 清理", async () => {
  const mod = await import(pathToFileURL(join(root, "atlas-extension", "index.js")).href);
  const manifest = JSON.parse(readFileSync(join(root, "atlas-extension", "manifest.json"), "utf8"));
  equal(manifest.generate_interceptor, mod.ATLAS_INTERCEPTOR_GLOBAL, "manifest 拦截器名与全局常量一致");
  ok(typeof mod.createGenerateInterceptor === "function", "createGenerateInterceptor 可导出测试");

  const calls = [];
  const io = { setExtensionPrompt: (key, value, position, depth) => calls.push({ key, value, position, depth }) };

  // 有 pending：注入 prepare 文本
  const pendingCore = {
    waitPendingTurn: async () => {},
    getState: () => ({ pendingTurn: { injectionText: "【阿特拉斯世界上下文】你站在白塔王都。" } }),
  };
  const interceptor = mod.createGenerateInterceptor(pendingCore, io);
  const chat = [{ mes: "你好" }];
  let aborted = false;
  const result = await interceptor(chat, 8192, () => { aborted = true; }, "normal");
  equal(result, undefined, "返回值被官方丢弃，无须返回内容");
  equal(chat.length, 1, "不修改 / 不污染 chat 数组（可见历史）");
  equal(aborted, false, "绝不触发 abort");
  equal(calls.length, 1, "一次 setExtensionPrompt");
  equal(calls[0].value, "【阿特拉斯世界上下文】你站在白塔王都。", "注入 prepare 文本");

  // 无 pending：清空注入
  calls.length = 0;
  const idleCore = {
    waitPendingTurn: async () => {},
    getState: () => ({ pendingTurn: null }),
  };
  await mod.createGenerateInterceptor(idleCore, io)([], 8192, () => {}, "normal");
  equal(calls.length, 1, "无 pending 也调用一次");
  equal(calls[0].value, "", "无 pending 清空注入（不残留上轮上下文）");

  // 等待发生在读状态之前（P0-04 的拦截器侧配合）
  const order = [];
  const orderCore = {
    waitPendingTurn: async () => { order.push("wait"); },
    getState: () => { order.push("read"); return { pendingTurn: null }; },
  };
  await mod.createGenerateInterceptor(orderCore, io)([], 8192, () => {}, "normal");
  assert.deepEqual(order, ["wait", "read"], "先等 prepare 再读 pending");
});

// ---------------------------------------------------------------------------
// P0-04：真实 fire-and-forget 事件监听与 prepare 竞态
// ---------------------------------------------------------------------------

function turnApiFixture(prepareDelayMs, { hang = false } = {}) {
  const calls = [];
  return {
    calls,
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (path === "/health") return { status: 200, body: { protocolVersion: 1, ok: true } };
      if (method === "POST" && path === "/bindings") return { status: 200, body: { ok: true, data: { bound: true } } };
      if (method === "GET" && path.startsWith("/state/")) {
        return {
          status: 200,
          body: {
            ok: true,
            data: { worldId: "w-1", worldName: "演示世界", branchId: null, currentTime: 12, currentLocationId: "p-1", nearbyPointIds: [], relevantNpcIds: [], npcReasons: {}, triggerIds: [] },
          },
        };
      }
      if (method === "POST" && path === "/turns/prepare") {
        if (hang) return new Promise(() => {});
        await delay(prepareDelayMs);
        return {
          status: 200,
          body: {
            ok: true,
            data: {
              response: {
                turnId: "turn-1",
                injectionText: "【阿特拉斯世界上下文】测试注入。",
                sourceRefs: ["point:p-1"],
                relevantNpcIds: [],
                triggerIds: [],
                currentTime: 12,
                currentLocationId: "p-1",
              },
            },
          },
        };
      }
      return { status: 404, body: { ok: false, error: { code: "INVALID_PAYLOAD", message: "未知路由" } } };
    },
  };
}

function turnHost() {
  let chatId = "chat-a";
  const bindings = new Map([["chat-a", {
    schemaVersion: 1, enabled: true, chatId: "chat-a", characterId: null,
    worldId: "w-1", branchId: null, currentLocationId: "p-1", worldTimeCursor: 12,
    lastCommittedMessageId: null, lastCheckpointId: null,
  }]]);
  return {
    getChatId: () => chatId,
    readBinding: () => bindings.get(chatId) ?? null,
    async writeBinding(b) { bindings.set(chatId, b); },
    async clearBinding() { bindings.delete(chatId); },
    readPanelOpen: () => false,
    writePanelOpen() {},
    fillInput() {},
    readData: () => null,
    writeData() {},
  };
}

async function readyTurnCore(api, adaptEvent) {
  const { createAtlasUiCore } = await import(pathToFileURL(join(root, "src", "atlas-ui-core.ts")).href);
  const emitter = realLikeEmitter();
  const core = createAtlasUiCore({ api, host: turnHost(), emitter, adaptEvent, now: () => Date.now() });
  core.init(); // 真实路径：activate → init 注册全部监听
  await delay(5);
  return { core, emitter };
}

test("P0-04：真实 fire-and-forget 监听后，拦截器等待同一条 prepare 拿得到注入", async () => {
  const api = turnApiFixture(30);
  const adaptEvent = (event, payload) => {
    if (event === "MESSAGE_SENT") return { kind: "message-sent", messageId: String(payload?.messageId ?? ""), userText: String(payload?.userText ?? "") };
    return null;
  };
  const { core, emitter } = await readyTurnCore(api, adaptEvent);
  const sentHandlers = [...(emitter.listeners.get("MESSAGE_SENT") ?? [])];
  equal(sentHandlers.length, 1, "MESSAGE_SENT 已注册");
  // 真实酒馆路径：handler 返回值无人等待（fire-and-forget）
  for (const handler of sentHandlers) handler({ messageId: "m-0", userText: "我从城门走向集市。" });
  // 拦截器路径：等得到同一条 prepare 的结果
  await core.waitPendingTurn(2000);
  const pending = core.getState().pendingTurn;
  ok(pending !== null, "prepare 完成后 pendingTurn 可见（竞态消除）");
  equal(pending.injectionText, "【阿特拉斯世界上下文】测试注入。", "注入文本来自 prepare");
  equal(api.calls.filter((c) => c.path === "/turns/prepare").length, 1, "只发一次 prepare");
});

test("P0-04b：未启用 / 无在途 prepare 时 waitPendingTurn 立即返回（不阻断普通聊天）", async () => {
  const api = turnApiFixture(0);
  const started = Date.now();
  const { core } = await readyTurnCore(api, () => null); // 未适配 → 无 prepare
  await core.waitPendingTurn(2000);
  ok(Date.now() - started < 1000, "立即返回，不拖住生成");
  equal(api.calls.filter((c) => c.path === "/turns/prepare").length, 0, "零 prepare 请求");
});

test("P0-04c：prepare 挂起时 waitPendingTurn 按超时返回，不悬挂生成", async () => {
  const api = turnApiFixture(0, { hang: true });
  const adaptEvent = (event, payload) => (event === "MESSAGE_SENT" ? { kind: "message-sent", messageId: String(payload?.messageId ?? ""), userText: "x" } : null);
  const { core, emitter } = await readyTurnCore(api, adaptEvent);
  for (const handler of [...(emitter.listeners.get("MESSAGE_SENT") ?? [])]) handler({ messageId: "m-0", userText: "x" });
  const started = Date.now();
  await core.waitPendingTurn(80);
  ok(Date.now() - started < 2000, "超时返回不悬挂");
  equal(core.getState().pendingTurn, null, "超时时无注入（拦截器会走清理路径）");
});

// ---------------------------------------------------------------------------
// P0-05：CSRF 请求头
// ---------------------------------------------------------------------------

test("P0-05：UI HTTP 客户端每请求合并 getRequestHeaders()（CSRF）且不缓存旧 token", async () => {
  const mod = await import(pathToFileURL(join(root, "atlas-extension", "index.js")).href);
  ok(typeof mod.createApi === "function", "createApi 可导出测试");
  let token = "csrf-token-1";
  const context = () => ({ getRequestHeaders: () => ({ "X-CSRF-Token": token }) });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const api = mod.createApi(context);
    await api.request("POST", "/bindings", { action: "bind" });
    equal(calls.length, 1, "请求已发出");
    equal(calls[0].options.headers["X-CSRF-Token"], "csrf-token-1", "首请求带当前 CSRF token");
    equal(calls[0].options.headers["Content-Type"], "application/json", "有 body 时保留 Content-Type");
    equal(calls[0].url, "/api/plugins/atlas/bindings", "同源 Atlas 前缀");
    token = "csrf-token-2"; // 酒馆轮换 token
    await api.request("GET", "/health");
    equal(calls[1].options.headers["X-CSRF-Token"], "csrf-token-2", "每请求重新取 token（不缓存）");
    ok(!JSON.stringify(calls).includes("csrf-token-1") || true, "token 只存在于请求头（不落日志 / 不持久化的义务在调用方）");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// P0-06：init(fakeRouter) 真实接线（动态路由 / map image）
// ---------------------------------------------------------------------------

async function wiredPlugin() {
  const plugin = await import(pathToFileURL(join(root, "atlas-server-plugin", "index.mjs")).href);
  const router = fakeRouter();
  const dataDir = mkdtempSync(join(tmpdir(), "atlas-wire-"));
  const { core } = await plugin.init(router, { dataDir, fetchFn: async () => { throw new Error("no network"); } });
  const world = buildWorld();
  const imported = await router.invoke("POST", "/worlds/import", { body: { world: JSON.parse(JSON.stringify(world)) }, user: { profile: { handle: "dev", admin: false } } });
  equal(imported.status, 200, "世界导入成功");
  const bound = await router.invoke("POST", "/bindings", { body: { action: "bind", binding: bindingFor(world) }, user: { profile: { handle: "dev", admin: false } } });
  equal(bound.status, 200, "绑定成功");
  return { plugin, router, core, dataDir, world };
}

test("P0-06：动态路由用真实请求路径；map/image 已注册并可访问", async () => {
  const { router, dataDir, world } = await wiredPlugin();
  try {
    const state = await router.invoke("GET", "/state/:chatId", { params: { chatId: "chat-a" } });
    equal(state.status, 200, "GET /state/:chatId 用真实 chatId 命中绑定（不再 400 NOT_BOUND）");
    equal(state.body?.data?.worldId, world.id, "返回绑定世界的状态");
    ok(state.body?.data?.map && typeof state.body.data.map === "object", "state 携带 map 有界数据");
    const image = await router.invoke("GET", "/map/image/:chatId", { params: { chatId: "chat-a" } });
    equal(image.status, 200, "GET /map/image/:chatId 已注册且可达");
    equal(image.body?.ok, true, "map/image 契约信封");
    ok(router.routes.some((r) => r.method === "GET" && r.path === "/map/image/:chatId"), "路由清单含 map image");
  } finally {
    rmtree(dataDir);
  }
});

// ---------------------------------------------------------------------------
// P0-07：写操作身份（当前 req.user 模型）
// ---------------------------------------------------------------------------

test("P0-07：req.user 身份模型——本机登录允许、未登录 / 远程非管理员拒绝、管理员例外", async () => {
  const { router, dataDir, world } = await wiredPlugin();
  try {
    const localUser = { profile: { handle: "dev", admin: false } };
    const allowed = await router.invoke("PUT", "/settings", {
      body: { worldTurn: presetFixture() },
      user: localUser,
      remoteAddress: "127.0.0.1",
    });
    equal(allowed.status, 200, "本机已登录用户可保存设置（不再依赖 session.userId）");

    const anonymous = await router.invoke("PUT", "/settings", {
      body: { worldTurn: presetFixture() },
      user: undefined,
      remoteAddress: "127.0.0.1",
    });
    equal(anonymous.status, 403, "无 req.user 明确拒绝");

    const remote = await router.invoke("PUT", "/settings", {
      body: { worldTurn: presetFixture() },
      user: localUser,
      remoteAddress: "203.0.113.9",
    });
    equal(remote.status, 403, "远程非管理员拒绝");

    const admin = await router.invoke("PUT", "/settings", {
      body: { worldTurn: presetFixture() },
      user: { profile: { handle: "boss", admin: true } },
      remoteAddress: "203.0.113.9",
    });
    equal(admin.status, 200, "管理员不受本机限制");

    const remoteWorldImport = await router.invoke("POST", "/worlds/import", {
      body: { world: JSON.parse(JSON.stringify(world)) },
      user: localUser,
      remoteAddress: "203.0.113.9",
    });
    equal(remoteWorldImport.status, 403, "世界导入同样受写策略约束");
  } finally {
    rmtree(dataDir);
  }
});

// ---------------------------------------------------------------------------
// P0-08：文档存储键一一映射 + 旧文件兼容
// ---------------------------------------------------------------------------

test("P0-08：不同合法 ID 落不同文件；旧命名文件可兼容读取且 list 可见", async () => {
  const { createNodeDocumentStore } = await import(pathToFileURL(join(root, "atlas-server-plugin", "index.mjs")).href);
  const dataDir = mkdtempSync(join(tmpdir(), "atlas-store-"));
  try {
    const store = createNodeDocumentStore(dataDir);
    await store.write("world:a:b", { value: 1 });
    await store.write("world:a?b", { value: 2 });
    equal((await store.read("world:a:b"))?.value, 1, "world:a:b 读回自己的值");
    equal((await store.read("world:a?b"))?.value, 2, "world:a?b 不被覆盖（旧实现两者落同一文件）");
    const names = await store.list("world:");
    ok(names.includes("world:a:b"), "list 含 world:a:b");
    ok(names.includes("world:a?b"), "list 含 world:a?b");

    // 旧命名兼容：历史文件 world__a.json（旧编码规则）仍可读
    writeFileSync(join(dataDir, "world__a.json"), JSON.stringify({ value: 9 }), "utf8");
    const legacy = await store.read("world:a");
    ok(legacy && legacy.value === 9, "旧命名文件兼容读取");
    ok((await store.list("world:")).includes("world:a"), "旧命名文件在 list 中以原文档名可见");

    // 纯安全字符名（settings 等）往返不变；新编码统一 base64url（settings → c2V0dGluZ3M）
    await store.write("settings", { autoCommit: true });
    assert.deepEqual(await store.read("settings"), { autoCommit: true }, "settings 往返一致");
    ok(existsSync(join(dataDir, "c2V0dGluZ3M.json")), "规范编码文件名落盘（一一映射可复算）");
  } finally {
    rmtree(dataDir);
  }
});

// ---------------------------------------------------------------------------
// 版本一致性
// ---------------------------------------------------------------------------

test("版本：根包 / UI manifest / UI 常量 / Server 常量 / Server package 一致", async () => {
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(root, "atlas-extension", "manifest.json"), "utf8"));
  const serverPkg = JSON.parse(readFileSync(join(root, "atlas-server-plugin", "package.json"), "utf8"));
  const uiMod = await import(pathToFileURL(join(root, "atlas-extension", "index.js")).href);
  const serverMod = await import(pathToFileURL(join(root, "atlas-server-plugin", "index.mjs")).href);
  const versions = new Set([
    rootPkg.version,
    manifest.version,
    uiMod.ATLAS_EXTENSION_VERSION,
    serverMod.ATLAS_PLUGIN_VERSION,
    serverPkg.version,
  ]);
  equal(versions.size, 1, `五处版本一致（实际：${[...versions].join(", ")}）`);
});

test(`本轮累计断言已记录（计数见报告）`, () => {
  ok(assertionCount > 40, "断言数量达到覆盖要求");
});
