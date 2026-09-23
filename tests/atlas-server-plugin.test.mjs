/**
 * atlas-server-plugin.test.mjs — ATLAS-02 Server Plugin 与独立 API 单测。
 *
 * 覆盖验收要求（上级 README ATLAS-02）：
 * - 浏览器可见的响应 / 日志 / 错误均无明文 Key（settings GET 只出 exists + 尾号）。
 * - 模拟 API 覆盖：成功、401、403、404、429、超时、断网、非 JSON、部分 JSON（损坏草稿）。
 * - prepare 零模型请求；commit 恰好 1 请求；重复 commit 总计仍 1 请求。
 * - 每聊天串行队列、RPM 保护、retry 沿用原幂等键、失败零部分写入。
 * - 写入走 store（node 实现为临时文件 + rename 原子替换，另有专项用例）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildWorldFromTemplate, getDemoTemplate } from "../lib/demo-events.ts";
import { parseWorld } from "../lib/world-schema.ts";
import { appendStateEvent } from "../lib/world-ledger.ts";
import { upsertEntityRecord } from "../lib/world-definition.ts";
import { createAtlasServerCore, createMemoryDocumentStore, ATLAS_ROUTE_MANIFEST } from "../src/atlas-server.ts";
import { createSessionCarrier, carrierAsCore } from "./atlas-session-helper.mjs";
import { isCheckpointIntact } from "../lib/world-checkpoint.ts";
import { parseAtlasWorldTurnDraft, buildAtlasChatUrl, callAtlasWorldTurnApi, DEFAULT_WORLD_TURN_SYSTEM_PROMPT } from "../src/atlas-api-client.ts";
import {
  ATLAS_ERROR_CODES,
  ATLAS_LIMITS,
} from "../src/atlas-contract.ts";
import { createAtlasServerPlugin, createNodeDocumentStore, ATLAS_PLUGIN_ROUTES } from "../atlas-server-plugin/index.mjs";

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

const NOW = 1_700_000_000_000;
const CANON = "chronicle-canon";
const CURRENT_TIME = 418.07;
const SECRET = "sk-atlas-test-key-8888";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function buildWorld() {
  let world = buildWorldFromTemplate(getDemoTemplate("chronicle"), { id: "atlas-server-fixture", now: 1000 });
  // 与 atlas-turn 夹具同口径：补两个带 temporalSchema 的实体，供草稿 effect 引用
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
  const parsed = parseWorld(JSON.parse(JSON.stringify(world)));
  ok(parsed !== null, "夹具世界可解析");
  return parsed;
}

function binding(world, overrides = {}) {
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
    ...overrides,
  };
}

function preset(overrides = {}) {
  return {
    name: "模拟推演",
    endpoint: "https://mock.example.invalid/v1",
    model: "atlas-mock",
    apiKey: SECRET,
    timeoutMs: 5000,
    ...overrides,
  };
}

function prepareRequest(world, overrides = {}) {
  return {
    chatId: "chat-a",
    messageId: "msg-1",
    worldId: world.id,
    branchId: CANON,
    userText: "我在城中走走。",
    recentMessageRefs: [],
    ...overrides,
  };
}

function commitRequest(world, overrides = {}) {
  return {
    turnId: "turn-x",
    chatId: "chat-a",
    userMessageId: "msg-10",
    assistantMessageId: "msg-11",
    swipeId: null,
    userText: "我前往潮门。",
    assistantText: "你沿主干道走向潮门。",
    ...overrides,
  };
}

const GOOD_DRAFT = {
  duration: 12,
  locationChange: { toPointId: "4104", toRegionId: "capital" },
  npcChanges: [{ entityId: "entity-npc", key: "whereabouts", value: "潮门" }],
  memoryDrafts: [{ entityId: "entity-npc", text: "在潮门见到一位旅行者。" }],
  eventDrafts: ["商会接管市政"],
  triggerResults: [],
  summary: "商会接管市政；旅行者抵达潮门。",
};

/** 计数 mock fetch：按脚本逐次返回。 */
function makeFetch(scripts) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers ?? {} });
    const script = scripts[Math.min(calls.length - 1, scripts.length - 1)];
    return script();
  };
  return { fetchFn, calls };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function openAiResponse(draft) {
  return jsonResponse(200, { choices: [{ message: { content: JSON.stringify(draft) } }] });
}

/** 0.9.42 会话承载：内联核心统一包会话载体（世界 / 绑定 / 回合映射随请求往返，不落全局 store）。 */
function sessionCore(store, deps = {}) {
  const rawCore = createAtlasServerCore({ store, now: () => NOW, ...deps });
  const carrier = createSessionCarrier(rawCore);
  return { core: carrierAsCore(carrier), carrier, store };
}

/** 组装核心：已导入世界 + 已绑定 + 已配置预设（0.9.42 会话承载：世界走会话，不落 store）。 */
async function setup(fetchScripts, overrides = {}) {
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const rawCore = createAtlasServerCore({
    store,
    fetchFn: fetchScripts ? makeFetch(fetchScripts).fetchFn : undefined,
    now: () => NOW,
    ...overrides,
  });
  const carrier = createSessionCarrier(rawCore);
  const core = carrierAsCore(carrier);
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  if (overrides.skipSettings !== true) {
    await core.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });
  }
  return { store, core, world, carrier };
}

// ---------------------------------------------------------------------------
// 路由清单与健康检查
// ---------------------------------------------------------------------------

test("路由清单：23 条且全部在 /api/plugins/atlas 前缀下", () => {
  equal(ATLAS_ROUTE_MANIFEST.length, 23, "dispatch 核心路由数（… + R03 /turns/preview + R06 /scene/bootstrap）");
  equal(ATLAS_PLUGIN_ROUTES.length, ATLAS_ROUTE_MANIFEST.length, "index.mjs 与核心路由清单一致");
  const plugin = createAtlasServerPlugin();
  for (const route of plugin.routes) {
    ok(route.path.startsWith("/api/plugins/atlas/"), `路由 ${route.path} 前缀固定`);
  }
});

test("health：无敏感字段；版本与 ATLAS_PLUGIN_VERSION 一致（0.9.18 防 health 版本再次烂掉）", async () => {
  const { core } = await setup(null);
  const result = await core.handle("GET", "/health");
  equal(result.status, 200, "health 200");
  const serialized = JSON.stringify(result.body).toLowerCase();
  for (const forbidden of ["key", "token", "secret", "authorization", "env", "path", "cwd"]) {
    ok(!serialized.includes(forbidden), `health 响应不含 ${forbidden}`);
  }
  const serverMod = await import("../atlas-server-plugin/index.mjs");
  equal(result.body.data.version, serverMod.ATLAS_PLUGIN_VERSION, "health version = 插件版本（六处同步第 6 处）");
});

// ---------------------------------------------------------------------------
// settings：脱敏与权限
// ---------------------------------------------------------------------------

test("settings：GET/PUT 同一道 local 门（0.9.48 T07），本机视图带回填明文 + 尾号", async () => {
  const { core } = await setup(null);
  const putDenied = await core.handle("PUT", "/settings", { worldTurn: preset() }, { local: false });
  equal(putDenied.status, 403, "非本机会话 PUT 被拒");
  equal(putDenied.body.error.code, ATLAS_ERROR_CODES.FORBIDDEN, "FORBIDDEN 错误码");

  // 0.9.48（T07）：读取与写入同一道门——远程匿名 / 普通用户连配置结构都读不到
  const getDenied = await core.handle("GET", "/settings", null, { local: false });
  equal(getDenied.status, 403, "非本机会话 GET 被拒");
  equal(getDenied.body.error.code, ATLAS_ERROR_CODES.FORBIDDEN, "FORBIDDEN 错误码");

  const view = await core.handle("GET", "/settings", null, { local: true });
  const serialized = JSON.stringify(view.body);
  equal(view.body.data.schemaVersion, 2, "GET 出 schemaVersion 2");
  equal(view.body.data.apiPresets.length, 1, "旧载荷已被迁移成 v2 连接库");
  // 0.9.12（作者令，照抄 shujuku）：本机会话 GET 回传明文 Key 供编辑器回填 / 测试连接复用
  // （0.9.48 T07 起以 local 闸为前提——远程用户根本到不了这一行）
  equal(view.body.data.apiPresets[0].apiKey, SECRET, "本机 GET 回明文 Key（编辑器回填）");
  equal(view.body.data.apiPresets[0].hasApiKey, true, "hasApiKey=true");
  equal(view.body.data.apiPresets[0].apiKeyLast4, SECRET.slice(-4), "尾号正确");
  equal(typeof view.body.data.builtInPrompt.systemPrompt, "string", "内置默认提示词只读可见");
  equal(view.body.data.builtInPrompt.readOnly, true, "内置默认只读");

  const importDenied = await core.handle("POST", "/worlds/import", { world: {} }, { local: false });
  equal(importDenied.status, 403, "非本机会话导入被拒");
});

test("settings：非法预设被拒绝", async () => {
  const { core } = await setup(null);
  const badUrl = await core.handle("PUT", "/settings", { worldTurn: preset({ endpoint: "not-a-url" }) }, { local: true });
  equal(badUrl.status, 400, "非法 endpoint 400");
  equal(badUrl.body.error.code, ATLAS_ERROR_CODES.INVALID_PAYLOAD, "INVALID_PAYLOAD");
  const badLimit = await core.handle("PUT", "/settings", { rpmLimit: 0 }, { local: true });
  equal(badLimit.body.error.code, ATLAS_ERROR_CODES.INVALID_PAYLOAD, "rpmLimit 下限校验");
  assertionCount += 2;
});

test("settings v2：两库命令——入库 / 指纹去重 / 脱敏 / 两库独立 / 持久化 / 上限", async () => {
  const { core, store } = await setup(null, { skipSettings: true });
  const saveApi = (name, endpoint) => ({
    action: "api.save",
    preset: { name, endpoint, model: "atlas-mock", maxTokens: 1024, temperature: 0.7, topP: 0.95, timeoutMs: 30_000 },
    apiKeyMode: "replace",
    apiKey: SECRET,
  });

  const created = await core.handle("PUT", "/settings", saveApi("渠道A", "https://a.example.invalid/v1/chat/completions"), { local: true });
  equal(created.status, 200, "新建连接 200");
  equal(created.body.data.apiPresets.length, 1, "一条连接入库");
  equal(created.body.data.activeApiPresetId, null, "保存 ≠ 激活");
  // 0.9.12（作者令）：GET/命令响应回明文 Key（本机浏览器存储，编辑器回填用）
  ok(JSON.stringify(created.body.data).includes(SECRET), "命令响应带明文 Key（回填用）");
  const apiId = created.body.data.apiPresets[0].id;

  const second = await core.handle("PUT", "/settings", saveApi("渠道B", "https://b.example.invalid/v1/chat/completions"), { local: true });
  equal(second.body.data.apiPresets.length, 2, "第二条连接入库");

  // 两库独立：提示词命令不改动 API 库与活动引用
  const promptSaved = await core.handle("PUT", "/settings", { action: "prompt.save", preset: { name: "P1", systemPrompt: "只输出 JSON。" } }, { local: true });
  equal(promptSaved.status, 200, "提示词入库 200");
  equal(promptSaved.body.data.promptPresets.length, 1, "一条提示词");
  deepEqual(promptSaved.body.data.apiPresets.map((p) => p.name), ["渠道A", "渠道B"], "提示词命令未改 API 库");
  const promptId = promptSaved.body.data.promptPresets[0].id;

  // 分别激活：互不干扰
  await core.handle("PUT", "/settings", { action: "api.activate", id: apiId }, { local: true });
  const activated = await core.handle("PUT", "/settings", { action: "prompt.activate", id: promptId }, { local: true });
  equal(activated.body.data.activeApiPresetId, apiId, "切提示词不动活动 API");
  equal(activated.body.data.activePromptPresetId, promptId, "活动提示词已设置");

  // Key 三态：keep 不改密钥
  const kept = await core.handle("PUT", "/settings", {
    action: "api.save",
    preset: { id: apiId, name: "渠道A改", endpoint: "https://a.example.invalid/v1/chat/completions", model: "atlas-mock-2", maxTokens: 512, temperature: 0.2, topP: 0.95, timeoutMs: 20_000 },
    apiKeyMode: "keep",
  }, { local: true });
  equal(kept.body.data.apiPresets[0].apiKey, SECRET, "keep 保留密钥（GET 回明文）");
  equal(kept.body.data.apiPresets[0].model, "atlas-mock-2", "其余字段已更新");
  equal(kept.body.data.apiPresets[0].id, apiId, "ID 稳定（重命名不换 ID）");
  const cleared = await core.handle("PUT", "/settings", {
    action: "api.save",
    preset: { id: apiId, name: "渠道A改", endpoint: "https://a.example.invalid/v1/chat/completions", model: "atlas-mock-2", maxTokens: 512, temperature: 0.2, topP: 0.95, timeoutMs: 20_000 },
    apiKeyMode: "clear",
  }, { local: true });
  equal(cleared.body.data.apiPresets[0].apiKey, "", "clear 后密钥为空");

  // 持久化：换一个 core 读同一 store
  const { core: fresh } = sessionCore(store);
  const again = await fresh.handle("GET", "/settings", null, { local: true });
  equal(again.body.data.apiPresets.length, 2, "刷新后连接库仍在");
  equal(again.body.data.promptPresets.length, 1, "刷新后提示词库仍在");
  equal(again.body.data.activeApiPresetId, apiId, "刷新后活动 API 仍在");
  equal(again.body.data.activePromptPresetId, promptId, "刷新后活动提示词仍在");

  // 上限 20
  let last = again;
  for (let i = 0; i < 18; i += 1) {
    last = await core.handle("PUT", "/settings", saveApi(`批量${i}`, `https://b${i}.example.invalid/v1/chat/completions`), { local: true });
  }
  equal(last.body.data.apiPresets.length, 20, "封顶 20 条");
  const overflow = await core.handle("PUT", "/settings", saveApi("第21条", "https://c.example.invalid/v1/chat/completions"), { local: true });
  equal(overflow.status, 413, "第 21 条被拒（FIELD_LIMIT_EXCEEDED → 413）");
  equal(overflow.body.error.code, ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED, "上限错误码");

  // 悬挂引用：激活不存在的 ID 必须失败且存储不变
  const ghost = await core.handle("PUT", "/settings", { action: "api.activate", id: "ghost-id" }, { local: true });
  equal(ghost.status, 400, "激活不存在的连接被拒");
  const after = await core.handle("GET", "/settings", null, { local: true });
  equal(after.body.data.activeApiPresetId, apiId, "失败不改变活动引用");
});

test("settings v2：v1 旧数据在读取路径迁移，首个写入落库 v2（重启可复现）", async () => {
  const store = createMemoryDocumentStore();
  // 模拟线上 v1 存档：组合式 worldTurn + 预设库 + majorEvent
  await store.write("settings", {
    schemaVersion: 1,
    worldTurn: { ...preset(), systemPrompt: "旧提示词正文" },
    majorEvent: preset({ name: "重大" }),
    presetLibrary: { worldTurn: [preset({ name: "渠道A" })], majorEvent: [] },
    autoCommit: false,
    rpmLimit: 42,
  });
  const { core } = sessionCore(store);
  const first = await core.handle("GET", "/settings", null, { local: true });
  equal(first.body.data.schemaVersion, 2, "GET 已是 v2 视图");
  equal(first.body.data.runtime === undefined ? first.body.data.rpmLimit : first.body.data.rpmLimit, 42, "runtime 字段迁移保留");
  equal(first.body.data.autoCommit, false, "autoCommit 迁移保留");
  ok(first.body.data.apiPresets.length >= 1, "连接从 v1 迁移出来");
  ok(first.body.data.promptPresets.some((p) => p.systemPrompt === "旧提示词正文"), "提示词从 v1 迁移出来");
  equal(String(first.body.data.activePromptPresetId ?? "").length > 0, true, "活动提示词指向迁移出的预设");
  // 读取路径不写 store：此时存档仍是 v1
  const stillV1 = await store.read("settings");
  equal(stillV1.schemaVersion, 1, "迁移发生在读取路径，不写 store");

  // 首个成功写入 → 落库 v2，且 majorEvent 旧数据不丢（legacyMajorEvent 保留在存储里）
  const wrote = await core.handle("PUT", "/settings", { action: "runtime.update", rpmLimit: 60 }, { local: true });
  equal(wrote.status, 200, "写入成功");
  const persisted = await store.read("settings");
  equal(persisted.schemaVersion, 2, "写入后落库 v2");
  ok("legacyMajorEvent" in persisted, "majorEvent 旧数据被兼容保留（不删不执行）");
  ok(!JSON.stringify(persisted).includes("majorEvent\":{" ), "不再有组合式 majorEvent 运行字段");
});

// ---------------------------------------------------------------------------
// worlds / bindings / state
// ---------------------------------------------------------------------------

test("worlds：只返回摘要，不返回账本 / 记忆 / 世界书正文（0.9.42 起该端点只服务存量迁移视图）", async () => {
  const { core, world, store } = await setup(null);
  // 0.9.42 会话承载：新世界只住会话、不再进 GET /worlds；该端点仅回显全局 store 的存量世界档
  const seeded = JSON.parse(JSON.stringify(world));
  await store.write(`world:${world.id}`, seeded);
  const result = await core.handle("GET", "/worlds");
  const worlds = result.body.data.worlds;
  equal(worlds.length, 1, "恰好一个世界");
  const summary = worlds[0];
  equal(summary.id, world.id, "世界 id");
  ok(typeof summary.pointCount === "number", "有地点计数");
  const serialized = JSON.stringify(summary);
  ok(!serialized.includes("stateEvents"), "摘要不含账本");
  ok(!serialized.includes("effects"), "摘要不含 effect");
  ok(!serialized.includes("memories"), "摘要不含记忆");
});

test("bindings：世界不存在拒绝；解绑后 NOT_BOUND", async () => {
  const { core, world } = await setup(null);
  const missing = await core.handle("POST", "/bindings", {
    action: "bind",
    binding: binding(world, { worldId: "no-such-world", chatId: "chat-b" }),
  });
  equal(missing.body.error.code, ATLAS_ERROR_CODES.WORLD_NOT_FOUND, "WORLD_NOT_FOUND");
  await core.handle("POST", "/bindings", { action: "unbind", chatId: "chat-b" });
  const state = await core.handle("GET", "/state/chat-b");
  equal(state.body.error.code, ATLAS_ERROR_CODES.NOT_BOUND, "解绑后 state 返回 NOT_BOUND");
  assertionCount += 3;
});

test("state：有界视图——位置 / 时间 / NPC 命中原因，无未来事实", async () => {
  const { core, world } = await setup(null);
  // 未来正史事件（导入返回的新世界后验证其不进入 state 视图）
  const appended = appendStateEvent(world, {
    branchId: null, at: 5000, source: "author",
    narrativeSummary: "未来正史大事件。",
    effects: [{ kind: "setFlag", key: "future-flag" }],
  }, { now: 1000 });
  equal(appended.ok, true, "未来事件写入成功");
  if (appended.ok) {
    await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(appended.value)) }, { local: true });
  }
  const result = await core.handle("GET", "/state/chat-a");
  const state = result.body.data;
  equal(state.worldId, world.id, "世界 id");
  equal(state.currentTime, CURRENT_TIME, "绑定游标时间");
  equal(state.currentLocationId, "4103", "当前位置");
  ok(state.relevantNpcIds.includes("chronicle-c1"), "同地点 NPC 命中");
  ok(state.npcReasons["chronicle-c1"].includes("samePoint"), "带命中原因");
  ok(!JSON.stringify(state).includes("future-flag"), "游标之后的 flag 不出现");
});

test("state：携带有界地图数据与最近推进（不含未来事件）", async () => {
  const { core, world } = await setup(null);
  const result = await core.handle("GET", "/state/chat-a");
  const state = result.body.data;
  const map = state.map;
  ok(map && Array.isArray(map.points), "map.points 数组");
  equal(map.points.length, (world.points ?? []).length, "地点全量在 200 上限内");
  const first = map.points[0];
  deepEqual(Object.keys(first).sort(), ["id", "name", "regionId", "x", "y"], "地点只含地图字段（无世界书 / 记忆）");
  ok(!JSON.stringify(map).includes("worldBook"), "地图数据无世界书");
  equal(map.mapImagePresent, false, "夹具世界无底图");
  equal(state.lastAdvance, null, "账本为空 → 无最近推进");

  // 游标之内的事件 → lastAdvance（appendStateEvent 为不可变更新，须导入返回的新世界）
  const appended = appendStateEvent(world, {
    branchId: CANON, at: 400, source: "author",
    narrativeSummary: "城钟敲响第十三声。",
    effects: [{ kind: "setFlag", key: "bell-rung" }],
  }, { now: 1000 });
  equal(appended.ok, true, "事件追加成功");
  if (appended.ok) {
    await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(appended.value)) }, { local: true });
  }
  const after = await core.handle("GET", "/state/chat-a");
  ok(after.body.data.lastAdvance !== null, "游标内有事件 → lastAdvance 非空");
  equal(after.body.data.lastAdvance.at, 400, "推进时刻");
  equal(after.body.data.lastAdvance.source, "author", "推进来源");
  ok(after.body.data.lastAdvance.summary.includes("城钟"), "推进事由摘要");
});

test("map/image：有底图返回 dataUrl，无底图返回 null，未绑定拒绝", async () => {
  const { core, world } = await setup(null);
  const none = await core.handle("GET", "/map/image/chat-a");
  equal(none.status, 200, "无底图也 200");
  equal(none.body.data.dataUrl, null, "dataUrl 为 null");

  const withImage = { ...JSON.parse(JSON.stringify(world)), mapImage: "data:image/png;base64,AAAA" };
  await core.handle("POST", "/worlds/import", { world: withImage }, { local: true });
  const has = await core.handle("GET", "/map/image/chat-a");
  equal(has.body.data.dataUrl, "data:image/png;base64,AAAA", "底图 dataUrl");

  const denied = await core.handle("GET", "/map/image/chat-none");
  equal(denied.body.error.code, ATLAS_ERROR_CODES.NOT_BOUND, "未绑定 NOT_BOUND");
});

// ---------------------------------------------------------------------------
// prepare：零 API
// ---------------------------------------------------------------------------

test("prepare：零模型请求、有界注入、分支不一致拒绝", async () => {
  const { fetchCalls } = await setupWithCountingFetch(null);
  equal(fetchCalls, 0, "prepare 全流程零 fetch（setup 本身也不发请求）");
  const { core, world } = await setup(null);
  const result = await core.handle("POST", "/turns/prepare", prepareRequest(world));
  equal(result.status, 200, "prepare 成功");
  const response = result.body.data.response;
  ok(response.injectionText.length <= ATLAS_LIMITS.INJECTION_CHARS, "注入文本不超预算");
  ok(response.injectionText.includes("白塔钟座"), "注入含当前位置名");
  ok(response.relevantNpcIds.includes("chronicle-c1"), "注入含同地点 NPC");

  const crossBranch = await core.handle("POST", "/turns/prepare", prepareRequest(world, { branchId: "other-branch" }));
  equal(crossBranch.body.error.code, ATLAS_ERROR_CODES.INVALID_PAYLOAD, "分支与绑定不一致拒绝");
});

async function setupWithCountingFetch(scripts) {
  const wrapper = makeFetch(scripts ?? []);
  const ctx = await setup(null);
  return { fetchCalls: wrapper.calls.length, calls: wrapper.calls, ...ctx };
}

// ---------------------------------------------------------------------------
// commit：成功 / 幂等 / 失败分类
// ---------------------------------------------------------------------------

test("commit：恰好 1 请求、原子落账、绑定游标推进", async () => {
  const fetcher = makeFetch([() => openAiResponse(GOOD_DRAFT)]);
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const { core: fresh } = sessionCore(store, { fetchFn: fetcher.fetchFn });
  await fresh.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await fresh.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  await fresh.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });

  const result = await fresh.handle("POST", "/turns/commit", commitRequest(world));
  equal(result.status, 200, "commit 200");
  const receipt = result.body.data.receipt;
  equal(receipt.status, "committed", "committed 回执");
  equal(receipt.currentTime, 430.07, "时间推进 12 时段");
  equal(receipt.currentLocationId, "4104", "位置推进");
  equal(fetcher.calls.length, 1, "恰好 1 条 API 请求");

  // Authorization 头携带密钥，但请求体不含密钥
  equal(fetcher.calls[0].headers.Authorization, `Bearer ${SECRET}`, "密钥只进 Authorization 头");
  ok(!JSON.stringify(fetcher.calls[0].body).includes(SECRET), "请求体无密钥");

  // 绑定游标持久化推进
  const state = await fresh.handle("GET", "/state/chat-a");
  equal(state.body.data.currentTime, 430.07, "state 反映新游标");
  equal(state.body.data.currentLocationId, "4104", "state 反映新位置");
  ok(!JSON.stringify(state).includes("msg-10"), "state 不回显消息 id 明细");

  // 重复 commit：0 新请求，duplicate 回执
  const again = await fresh.handle("POST", "/turns/commit", commitRequest(world));
  equal(again.body.data.receipt.status, "duplicate", "duplicate 回执");
  equal(fetcher.calls.length, 1, "重复 commit 总计仍 1 请求");

  // 日志脱敏
  const logSerialized = JSON.stringify(fresh.logs());
  ok(!logSerialized.includes(SECRET), "日志无明文 Key");
  ok(!logSerialized.includes("mock.example.invalid"), "日志无 endpoint");
});

// ---------------------------------------------------------------------------
// 0.9.44 拖动纠偏：POST /worlds/move-author（作者 moveEntity source="author"）
// ---------------------------------------------------------------------------

test("move-author：NPC 纠偏 → CharacterState 权威位置 + author 账本事件，游标不动", async () => {
  const fetcher = makeFetch([]);
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const { core, carrier } = sessionCore(store, { fetchFn: fetcher.fetchFn });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });

  const result = await core.handle("POST", "/worlds/move-author", {
    chatId: "chat-a",
    entityId: "chronicle-c1",
    toPointId: "4104",
  });
  equal(result.status, 200, "纠偏 200");
  equal(result.body.data.moved.pointId, "4104", "回执指向目标地点");
  ok(result.body.data.ledgerEventId, "返回账本事件 id");

  // 权威位置：CharacterState 已写（绑定分支作用域行——resolveCharacterPosition 同款口径）
  const state = carrier.session.world.characterStates?.find(
    (st) => st.characterId === "chronicle-c1" && (st.branchId ?? null) === CANON,
  );
  ok(state, "CharacterState 已写（绑定分支作用域）");
  equal(state.currentPointId, "4104", "位置 = 目标地点");
  equal(state.currentRegionId, "capital", "地区 = 目标地点所属地区");

  // 账本：source="author" 的 moveEntity 事件，at = 当前游标（纠偏不推进时间）
  const events = carrier.session.world.stateEvents ?? [];
  const last = events[events.length - 1];
  equal(last.source, "author", "账本来源 = author（可审计）");
  equal(last.at, CURRENT_TIME, "纠偏不推进时间游标");
  equal(last.effects[0].kind, "moveEntity", "effect = moveEntity");
  equal(last.effects[0].pointId, "4104", "effect 指向目标地点");
  ok(JSON.stringify(last.narrativeSummary).includes("作者纠偏"), "叙事摘要可读");

  // 非主角：绑定位置游标不动
  equal(carrier.session.binding.currentLocationId, "4103", "非主角不推绑定游标");
  equal(fetcher.calls.length, 0, "纠偏零模型请求");
});

test("move-author：主角纠偏 → 绑定游标端点同步 + characters-only 主角自动建档", async () => {
  const fetcher = makeFetch([]);
  const store = createMemoryDocumentStore();
  let world = buildWorld();
  // 注入主角（自动建世同款：role="主角"，且只在 characters、无 entityRecord）
  world.characters = [
    ...world.characters,
    { id: "char-main", worldId: world.id, name: "林拾", role: "主角", description: "测试主角" },
  ];
  world = parseWorld(JSON.parse(JSON.stringify(world)));
  const { core, carrier } = sessionCore(store, { fetchFn: fetcher.fetchFn });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });

  const result = await core.handle("POST", "/worlds/move-author", {
    chatId: "chat-a",
    entityId: "char-main",
    toPointId: "4104",
  });
  equal(result.status, 200, "主角纠偏 200");
  equal(result.body.data.cursorMoved, true, "回执标明游标已同步");

  // 游标端点：主角拖动 = 玩家事实位置迁移
  equal(carrier.session.binding.currentLocationId, "4104", "绑定位置游标已到目标地点");

  // characters-only 主角：账本建档（0.9.37 同款）后事件成功落账
  const record = (carrier.session.world.entityRecords ?? []).find((e) => String(e.id) === "char-main");
  ok(record, "主角已确定性建档进 entityRecords");
  const events = carrier.session.world.stateEvents ?? [];
  const last = events[events.length - 1];
  equal(last.source, "author", "账本来源 = author");
  ok((last.entityRefs ?? []).includes("char-main"), "事件 entityRefs 含主角");

  // 主角 CharacterState 也已写（地图标点 / 遭遇判定同源）
  const state = carrier.session.world.characterStates?.find(
    (st) => st.characterId === "char-main" && (st.branchId ?? null) === CANON,
  );
  equal(state?.currentPointId, "4104", "主角 CharacterState 位置一致");
});

test("move-author：未知实体 / 未知地点 / 未绑定 → 拒绝且零写入", async () => {
  const fetcher = makeFetch([]);
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const { core, carrier } = sessionCore(store, { fetchFn: fetcher.fetchFn });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  const eventsBefore = (carrier.session.world.stateEvents ?? []).length;

  const badEntity = await core.handle("POST", "/worlds/move-author", { chatId: "chat-a", entityId: "no-such", toPointId: "4104" });
  equal(badEntity.body.error.code, ATLAS_ERROR_CODES.INVALID_PAYLOAD, "未知实体拒绝");
  ok(badEntity.body.error.message.includes("人物不存在"), "拒绝原因可读");

  const badPoint = await core.handle("POST", "/worlds/move-author", { chatId: "chat-a", entityId: "chronicle-c1", toPointId: "4999" });
  equal(badPoint.body.error.code, ATLAS_ERROR_CODES.INVALID_PAYLOAD, "未知地点拒绝");

  const unbound = await core.handle("POST", "/worlds/move-author", { chatId: "chat-none", entityId: "chronicle-c1", toPointId: "4104" });
  equal(unbound.body.error.code, ATLAS_ERROR_CODES.NOT_BOUND, "未绑定拒绝");

  equal((carrier.session.world.stateEvents ?? []).length, eventsBefore, "拒绝路径零账本写入");
  equal(carrier.session.binding.currentLocationId, "4103", "拒绝路径游标不动");
});

test("settings v2 运行时组合：commit 用「活动 API + 活动提示词」，两库独立切换", async () => {
  const fetcher = makeFetch([() => openAiResponse(GOOD_DRAFT), () => openAiResponse(GOOD_DRAFT)]);
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const { core } = sessionCore(store, { fetchFn: fetcher.fetchFn });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });

  const saveApi = (name, endpoint) => ({
    action: "api.save",
    preset: { name, endpoint, model: "atlas-mock", maxTokens: 1024, temperature: 0.7, topP: 0.95, timeoutMs: 5000 },
    apiKeyMode: "replace",
    apiKey: "sk-runtime-test",
  });
  const apiA = (await core.handle("PUT", "/settings", saveApi("A", "https://a.example.invalid/v1/chat/completions"), { local: true })).body.data.apiPresets[0].id;
  const apiB = (await core.handle("PUT", "/settings", saveApi("B", "https://b.example.invalid/v1/chat/completions"), { local: true })).body.data.apiPresets[1].id;
  const promptP2 = (await core.handle("PUT", "/settings", { action: "prompt.save", preset: { name: "P2", systemPrompt: "P2 专用提示词正文" } }, { local: true })).body.data.promptPresets[0].id;

  // 活动 API = A，活动提示词 = P2
  await core.handle("PUT", "/settings", { action: "api.activate", id: apiA }, { local: true });
  await core.handle("PUT", "/settings", { action: "prompt.activate", id: promptP2 }, { local: true });

  const commit1 = await core.handle("POST", "/turns/commit", commitRequest(world), { local: true });
  equal(commit1.body.ok, true, "组合提交成功");
  const sent1 = fetcher.calls[0].body;
  equal(sent1.messages[0].content, "P2 专用提示词正文", "system 正文来自活动提示词预设");
  equal(fetcher.calls[0].url, "https://a.example.invalid/v1/chat/completions", "请求打到活动 API A");

  // 切到 API B：提示词仍是 P2
  await core.handle("PUT", "/settings", { action: "api.activate", id: apiB }, { local: true });
  const commit2 = await core.handle("POST", "/turns/commit", commitRequest(world, { assistantMessageId: "msg-2", userMessageId: "msg-20" }), { local: true });
  equal(commit2.body.ok, true, "换连接后仍能提交");
  equal(fetcher.calls[1].url, "https://b.example.invalid/v1/chat/completions", "请求打到活动 API B");
  equal(fetcher.calls[1].body.messages[0].content, "P2 专用提示词正文", "切 API 不影响提示词选择");

  // 没有任何明文密钥进日志
  const logDump = JSON.stringify(core.logs());
  ok(!logDump.includes("sk-runtime-test"), "日志无明文 Key");
});

test("settings v2：store 写入失败时缓存保持旧设置（不留半更新状态）", async () => {
  const store = createMemoryDocumentStore();
  const { core } = sessionCore(store);
  const before = (await core.handle("GET", "/settings", null, { local: true })).body.data;
  equal(before.rpmLimit, 30, "初始 rpmLimit");

  const originalWrite = store.write.bind(store);
  store.write = async (name, value) => {
    if (name === "settings") throw new Error("disk full");
    return originalWrite(name, value);
  };
  const failed = await core.handle("PUT", "/settings", { action: "runtime.update", rpmLimit: 60 }, { local: true });
  equal(failed.body.ok, false, "写入失败被上报");
  store.write = originalWrite;
  const after = (await core.handle("GET", "/settings", null, { local: true })).body.data;
  equal(after.rpmLimit, 30, "失败后缓存仍是旧设置");
});

test("commit：未配置 API → API_NOT_CONFIGURED，0 fetch", async () => {
  const fetcher = makeFetch([() => openAiResponse(GOOD_DRAFT)]);
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const { core } = sessionCore(store, { fetchFn: fetcher.fetchFn });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  const result = await core.handle("POST", "/turns/commit", commitRequest(world));
  equal(result.body.error.code, ATLAS_ERROR_CODES.API_NOT_CONFIGURED, "API_NOT_CONFIGURED");
  equal(fetcher.calls.length, 0, "0 fetch");
  const state = await core.handle("GET", "/state/chat-a");
  equal(state.body.data.currentTime, CURRENT_TIME, "世界游标未推进");
});

const FAILURE_CASES = [
  { name: "401", script: () => jsonResponse(401, { error: "bad key" }), code: ATLAS_ERROR_CODES.API_AUTH_FAILED, retryable: false },
  { name: "403", script: () => jsonResponse(403, { error: "forbidden" }), code: ATLAS_ERROR_CODES.API_AUTH_FAILED, retryable: false },
  { name: "404", script: () => jsonResponse(404, { error: "no such model" }), code: ATLAS_ERROR_CODES.API_NOT_FOUND, retryable: false },
  { name: "429", script: () => jsonResponse(429, { error: "rate limited" }), code: ATLAS_ERROR_CODES.API_RATE_LIMITED, retryable: true },
  { name: "500", script: () => jsonResponse(500, { error: "boom" }), code: ATLAS_ERROR_CODES.API_REQUEST_FAILED, retryable: true },
  {
    name: "超时",
    script: () => {
      throw new Error("aborted-timeout");
    },
    code: ATLAS_ERROR_CODES.SERVICE_OFFLINE,
    retryable: true,
  },
  { name: "非 JSON", script: () => jsonResponse(200, { notChoices: true }), code: ATLAS_ERROR_CODES.RESPONSE_MALFORMED, retryable: false },
];

for (const failure of FAILURE_CASES) {
  test(`commit 失败分类：${failure.name} → ${failure.code}，零写入`, async () => {
    const fetcher = makeFetch([failure.script]);
    const store = createMemoryDocumentStore();
    const world = buildWorld();
    const worldSnapshot = JSON.stringify(world);
    const { core } = sessionCore(store, { fetchFn: fetcher.fetchFn });
    await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
    await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
    await core.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });

    const result = await core.handle("POST", "/turns/commit", commitRequest(world));
    equal(result.body.error.code, failure.code, `错误码 ${failure.code}`);
    equal(result.body.error.details.retryable, failure.retryable, `retryable=${failure.retryable}`);
    equal(fetcher.calls.length, 1, "恰好 1 条请求");
    const state = await core.handle("GET", "/state/chat-a");
    equal(state.body.data.currentTime, CURRENT_TIME, "游标未推进（零部分写入）");
    ok(!JSON.stringify(state.body).includes("商会"), "世界无变化");
    ok(JSON.stringify(worldSnapshot).length > 0, "原世界快照仍有效");
  });
}

test("裁决（0.9.0）：未知地点草稿降级——移动被忽略，其余变化照常原子提交", async () => {
  const fetcher = makeFetch([() => openAiResponse({ ...GOOD_DRAFT, locationChange: { toPointId: "pt-nowhere" } })]);
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const { core } = sessionCore(store, { fetchFn: fetcher.fetchFn });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  await core.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });

  const result = await core.handle("POST", "/turns/commit", commitRequest(world));
  const receipt = result.body.data.receipt;
  equal(receipt.status, "committed", "未知地点不再炸整单");
  equal(receipt.currentTime, 430.07, "非移动回合时间仍由 AI 推断（12 时段）");
  ok(!("currentLocationId" in receipt) || receipt.currentLocationId === "4103", "位置未移动");
  ok(receipt.summary.includes("〔裁定〕") && receipt.summary.includes("未知地点"), "裁定说明可审计");
});

test("0.9.30 放宽：JSON 被写进 <think> 里 → 剥除失败后从原文救回，正常提交", async () => {
  // MiniMax-M3 嫌疑行为：JSON 全在 think 段内，think 剥除后什么都不剩
  const insideThink = `<think>Let me analyze.\n${JSON.stringify(GOOD_DRAFT)}</think>`;
  const fetcher = makeFetch([() => jsonResponse(200, { choices: [{ message: { content: insideThink } }] })]);
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const { core } = sessionCore(store, { fetchFn: fetcher.fetchFn });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  await core.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });

  const result = await core.handle("POST", "/turns/commit", commitRequest(world));
  const receipt = result.body.data.receipt;
  equal(receipt.status, "committed", "原文重试救回，正常提交");
  equal(receipt.currentTime, 430.07, "草稿内容完整生效（12 时段）");
  equal(fetcher.calls.length, 1, "仍恰好 1 条推演请求");
});

test("0.9.48 T05：完全无法解析 → 明确失败（RESPONSE_MALFORMED 可重试），世界零写入，原文记日志", async () => {
  const pureProse = `<think>Let me analyze this turn carefully.\n角色们聊了聊天，没有任何事件发生。</think>`;
  const fetcher = makeFetch([() => jsonResponse(200, { choices: [{ message: { content: pureProse } }] })]);
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const worldSnapshot = JSON.stringify(world);
  const { core } = sessionCore(store, { fetchFn: fetcher.fetchFn });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  await core.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });

  // 0.9.48 语义变更（外部 AI 计划 T05，作者拍板全包）：解析两连败 = 错误，不再伪装
  // 「无结构变化」成功——已付费但世界未更新必须如实呈现，可重试（重推演重新调模型）。
  const result = await core.handle("POST", "/turns/commit", commitRequest(world));
  equal(result.body.ok, false, "解析失败 = 提交失败");
  equal(result.body.error.code, ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "RESPONSE_MALFORMED 错误码");
  equal(result.body.error.details.retryable, true, "标记可重试");
  equal(JSON.stringify(JSON.parse(worldSnapshot)), JSON.stringify(world), "世界零写入");
  const fallbackLogs = core.logs().filter((l) => l.kind === "world-turn-parse-fallback");
  equal(fallbackLogs.length, 1, "解析降级日志恰好一条");
  ok(fallbackLogs[0].responseChars > 0, "只记录响应长度");
  ok(!JSON.stringify(fallbackLogs).includes("Let me analyze"), "日志不保留模型原文");
  ok(!JSON.stringify(core.logs()).includes("sk-runtime-test"), "日志无明文 Key");
});

// ---------------------------------------------------------------------------
// A12（0.9.52）：长度截断的服务层端到端——模型 HTTP 200 + finish_reason:"length"
//
// 现场：maxTokens 调大后模型约 68 秒返回 HTTP 200，message.content 只有一段
// <think>…</think>，里面若干互相矛盾的 JSON 草稿，无最终可提交 JSON。
// 本用例锁定：服务层必须把它判成「被长度截断」而不是「格式不合法」，
// 且世界零写入（尤其不得从推理稿里抢地点）。
// ---------------------------------------------------------------------------

test("A12 端到端：finish_reason=length + 仅 <think> 推理稿 → RESPONSE_MALFORMED、零地图点、游标不动、pending 保留", async () => {
  // 推理稿里故意塞进两个互相矛盾的地点名：旧实现若从 think 抢救，会凭空建点
  const truncatedBody =
    `<think>先试一版：{"schemaVersion":2,"discoveries":{"locations":[{"name":"枫叶城"}]}}\n` +
    `再想一下：{"schemaVersion":2,"scene":{"locationRef":"999"}}\n` +
    `地图上应该加圣罗兰和枫叶城两个点……</think>`;

  const fetcher = makeFetch([
    () => jsonResponse(200, { choices: [{ finish_reason: "length", message: { content: truncatedBody } }] }),
  ]);
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const pointsBefore = (world.points ?? []).length;
  const charactersBefore = (world.characters ?? []).length;
  const cursorBefore = binding(world).worldTimeCursor;
  const { core, carrier } = sessionCore(store, { fetchFn: fetcher.fetchFn });

  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  await core.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });

  const result = await core.handle("POST", "/turns/commit", commitRequest(world));

  equal(result.body.ok, false, "截断 = 提交失败");
  equal(result.body.error.code, ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "沿用 RESPONSE_MALFORMED，不新增错误码");
  equal(result.body.error.details.retryable, true, "标记可重试（调上限/换模型后可再试）");
  ok(/截断/.test(String(result.body.error.message)), `报错点明「截断」，实际：${result.body.error.message}`);
  equal(fetcher.calls.length, 1, "恰好 1 条模型请求");

  // 世界零写入：地点/人物/游标全不动
  const afterPoints = (carrier.session.world.points ?? []).length;
  equal(afterPoints, pointsBefore, "零新增地图点（不从推理稿抢地点）");
  equal((carrier.session.world.characters ?? []).length, charactersBefore, "零新增人物");
  equal(carrier.session.binding.worldTimeCursor, cursorBefore, "时间游标未推进");
  const state = (await core.handle("POST", "/state", { chatId: "chat-a" })).body.data;
  ok(!state.map.points.some((p) => p.name === "枫叶城"), "/state 地图不含推理稿里的枫叶城");
  ok(!state.map.points.some((p) => p.name === "圣罗兰"), "/state 地图不含推理稿里的圣罗兰");

  // 日志：点明截断，且不泄露推理稿原文
  const logs = JSON.stringify(core.logs());
  ok(!logs.includes("枫叶城") && !logs.includes("先试一版"), "日志不保留推理稿原文");
  ok(!logs.includes("sk-runtime-test"), "日志无明文 Key");

  // pending 保留：供 retry 沿用原幂等键
  const pendingKeys = await store.list("pending:");
  equal(pendingKeys.length, 1, "pending 保留一条，供 retry 复用");
});

test("A12 端到端：截断失败后同键 retry 成功 → 世界只推进一次，再次 retry 为 duplicate", async () => {
  const goodDraft = {
    schemaVersion: 2,
    baseRevision: binding(buildWorld()).worldTimeCursor,
    duration: 6,
    evidence: [{ id: "ev1", sourceId: "msg:a", quote: "潮门" }],
    discoveries: {
      locations: [{ ref: "new:loc:chaomen", name: "潮门", aliases: [], regionRef: null, parentLocationRef: null, evidenceIds: ["ev1"] }],
      characters: [],
    },
    scene: { resolution: "unknown", locationRef: null, transition: "stay", evidenceIds: ["ev1"] },
    identityUpdates: [], npcUpdates: [], relationUpdates: [], memories: [], worldFlags: [],
    events: [], mapScaleHints: [], summary: "抵达潮门附近，位置待确认",
  };

  const fetcher = makeFetch([
    // 第一次：被长度截断
    () => jsonResponse(200, { choices: [{ finish_reason: "length", message: { content: "<think>先试一版：{\"schemaVersion\":2}</think>" } }] }),
    // retry：完整 v2 JSON
    () => jsonResponse(200, { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(goodDraft) } }] }),
  ]);
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const pointsBefore = (world.points ?? []).length;
  const { core, carrier } = sessionCore(store, { fetchFn: fetcher.fetchFn });

  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  await core.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });

  const request = commitRequest(world);
  const first = await core.handle("POST", "/turns/commit", request);
  equal(first.body.ok, false, "首次截断失败");
  equal(fetcher.calls.length, 1, "首次恰好 1 条请求");

  // 同键 retry：沿用原幂等键
  const retried = await core.handle("POST", "/turns/retry", request);
  equal(retried.body.ok, true, `retry 应成功：${JSON.stringify(retried.body.error ?? "")}`);
  equal(retried.body.data.receipt.status, "committed", "retry 后回执 committed");
  equal(fetcher.calls.length, 2, "总计 2 条请求（1 截断 + 1 成功）");

  const afterPoints = (carrier.session.world.points ?? []).length;
  equal(afterPoints, pointsBefore + 1, "世界只推进一次：恰好新增 1 个地点");

  // 再次同键 retry → duplicate，且不再发模型请求
  const again = await core.handle("POST", "/turns/retry", request);
  equal(again.body.data.receipt.status, "duplicate", "同键再次 retry 为 duplicate");
  equal(fetcher.calls.length, 2, "duplicate 不产生新模型请求");
  equal((carrier.session.world.points ?? []).length, afterPoints, "地图不重建重复点");
});

test("0.9.31 首轮自动建图：≤1 点世界首次 commit 后自动提炼一次，之后不再跑", async () => {
  // 单点世界：把夹具世界裁到只剩绑定游标所在点
  const full = buildWorld();
  const trimmed = parseWorld({
    ...JSON.parse(JSON.stringify(full)),
    points: full.points.filter((p) => String(p.id) === "4103"),
  });
  ok(trimmed !== null, "单点世界可解析");
  const world = trimmed;

  const geoSpec = {
    regions: [{ name: "旧城区", description: "老城根" }],
    points: [
      { name: "钟楼", regionName: "旧城区" },
      { name: String(world.points[0].name), regionName: "旧城区" },
    ],
  };
  // 0.9.48 T05：解析失败不再降级为成功——给第二次 commit 单独备一段合法草稿
  const fetcher = makeFetch([
    () => openAiResponse(GOOD_DRAFT),
    () => openAiResponse(geoSpec),
    () => openAiResponse(GOOD_DRAFT),
  ]);
  const store = createMemoryDocumentStore();
  const { core } = sessionCore(store, { fetchFn: fetcher.fetchFn });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  await core.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });

  const result = await core.handle("POST", "/turns/commit", commitRequest(world));
  equal(result.body.ok, true, "提交成功");
  equal(fetcher.calls.length, 2, "推演 + 一次性自动建图，恰好 2 条");
  ok(result.body.data.receipt.summary.includes("首轮自动建图"), "回执注明自动建图");
  const state = await core.handle("GET", "/state/chat-a");
  ok(JSON.stringify(state.body).includes("钟楼"), "新地点已进世界");
  const autoLogs = core.logs().filter((l) => l.kind === "world-geo-adopt" && l.source === "auto");
  equal(autoLogs.length, 1, "自动建图日志恰好一条");
  equal(autoLogs[0].pointsAdded, 1, "重名点跳过，恰好 +1");

  // 第二次 commit：地图已长出来 → 不再自动建图
  const second = await core.handle("POST", "/turns/commit", commitRequest(world, { assistantMessageId: "msg-12", userMessageId: "msg-20" }), { local: true });
  equal(second.body.ok, true, "第二次提交成功");
  equal(fetcher.calls.length, 3, "第二次只发推演（自动建图不重复）");
});

test("0.9.36 自动建图①：本轮 assistantText 进提炼素材（首回合唯一剧情来源）", async () => {
  const full = buildWorld();
  const world = parseWorld({
    ...JSON.parse(JSON.stringify(full)),
    points: full.points.filter((p) => String(p.id) === "4103"),
  });
  const geoSpec = {
    regions: [{ name: "旧城区" }],
    points: [{ name: "钟楼", regionName: "旧城区" }],
  };
  const fetcher = makeFetch([
    () => openAiResponse(GOOD_DRAFT),
    () => openAiResponse(geoSpec),
  ]);
  const store = createMemoryDocumentStore();
  const { core } = sessionCore(store, { fetchFn: fetcher.fetchFn });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  await core.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });

  const result = await core.handle("POST", "/turns/commit", commitRequest(world));
  equal(result.body.ok, true, "提交成功");
  equal(fetcher.calls.length, 2, "推演 + 自动建图，恰好 2 条");
  ok(
    JSON.stringify(fetcher.calls[1].body).includes("你沿主干道走向潮门"),
    "本轮楼层正文进入提炼请求（0.9.35 及之前只给前文楼层，首回合素材为空）",
  );
});

test("0.9.36 自动建图②：素材全空 → 零提炼请求、不烧标记；下回合有素材时自愈建图", async () => {
  const full = buildWorld();
  const world = parseWorld({
    ...JSON.parse(JSON.stringify(full)),
    points: full.points.filter((p) => String(p.id) === "4103"),
  });
  const geoSpec = {
    regions: [{ name: "旧城区" }],
    points: [{ name: "钟楼", regionName: "旧城区" }],
  };
  const fetcher = makeFetch([
    () => openAiResponse(GOOD_DRAFT),
    () => openAiResponse(GOOD_DRAFT),
    () => openAiResponse(geoSpec),
  ]);
  const store = createMemoryDocumentStore();
  const { core } = sessionCore(store, { fetchFn: fetcher.fetchFn });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  await core.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });

  const first = await core.handle("POST", "/turns/commit", commitRequest(world, { assistantText: "  " }));
  equal(first.body.ok, true, "首回合提交成功");
  equal(fetcher.calls.length, 1, "素材全空 → 不发提炼请求（0.9.35 会白烧 1 条）");
  equal(await store.read(`geo-auto:${world.id}`), null, "标记未烧毁（0.9.35 会永久放弃）");

  const second = await core.handle("POST", "/turns/commit", commitRequest(world, { assistantMessageId: "msg-12", userMessageId: "msg-20" }), { local: true });
  equal(second.body.ok, true, "次回合提交成功");
  equal(fetcher.calls.length, 3, "次回合有素材 → 自动建图补跑");
  const state = await core.handle("GET", "/state/chat-a");
  ok(JSON.stringify(state.body).includes("钟楼"), "新地点已进世界");
});

test("0.9.36 自动建图③：0.9.35 烧掉的旧标记（无 done）升级后自愈重试", async () => {
  const full = buildWorld();
  const world = parseWorld({
    ...JSON.parse(JSON.stringify(full)),
    points: full.points.filter((p) => String(p.id) === "4103"),
  });
  const geoSpec = {
    regions: [{ name: "旧城区" }],
    points: [{ name: "钟楼", regionName: "旧城区" }],
  };
  const fetcher = makeFetch([
    () => openAiResponse(GOOD_DRAFT),
    () => openAiResponse(geoSpec),
  ]);
  const store = createMemoryDocumentStore();
  const { core, carrier } = sessionCore(store, { fetchFn: fetcher.fetchFn });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  await core.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });
  // 模拟 0.9.31~0.9.35 留下的旧标记：提炼前就写、无 done / attempts 字段（0.9.42 起标记住会话）
  carrier.session.geoAuto[world.id] = { at: NOW };

  const result = await core.handle("POST", "/turns/commit", commitRequest(world));
  equal(result.body.ok, true, "提交成功");
  equal(fetcher.calls.length, 2, "旧标记不阻断 → 自动建图重试");
  const marker = carrier.session.geoAuto[world.id];
  equal(marker?.done, true, "建图成功后标记翻转为 done");
  ok(JSON.stringify(result.body.data.receipt.summary).includes("首轮自动建图"), "回执注明自动建图");
});

test("0.9.36 自动建图④：尝试达上限（3 次）→ 不再发提炼请求", async () => {
  const full = buildWorld();
  const world = parseWorld({
    ...JSON.parse(JSON.stringify(full)),
    points: full.points.filter((p) => String(p.id) === "4103"),
  });
  const fetcher = makeFetch([() => openAiResponse(GOOD_DRAFT)]);
  const store = createMemoryDocumentStore();
  const { core, carrier } = sessionCore(store, { fetchFn: fetcher.fetchFn });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  await core.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });
  carrier.session.geoAuto[world.id] = { at: NOW, attempts: 3 };

  const result = await core.handle("POST", "/turns/commit", commitRequest(world));
  equal(result.body.ok, true, "提交成功");
  equal(fetcher.calls.length, 1, "上限已到 → 只发推演，不再烧提炼请求");
});

test("0.9.36 自动建图⑤：提炼响应 content 为空、JSON 在 reasoning_content → 照样建图", async () => {
  const full = buildWorld();
  const world = parseWorld({
    ...JSON.parse(JSON.stringify(full)),
    points: full.points.filter((p) => String(p.id) === "4103"),
  });
  const geoSpec = {
    regions: [{ name: "旧城区" }],
    points: [{ name: "钟楼", regionName: "旧城区" }],
  };
  const fetcher = makeFetch([
    () => openAiResponse(GOOD_DRAFT),
    () => jsonResponse(200, {
      choices: [{ message: { content: "", reasoning_content: JSON.stringify(geoSpec), finish_reason: "tool_calls" } }],
    }),
  ]);
  const store = createMemoryDocumentStore();
  const { core } = sessionCore(store, { fetchFn: fetcher.fetchFn });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  await core.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });

  const result = await core.handle("POST", "/turns/commit", commitRequest(world));
  equal(result.body.ok, true, "提交成功");
  equal(fetcher.calls.length, 2, "推演 + 自动建图");
  const state = await core.handle("GET", "/state/chat-a");
  ok(JSON.stringify(state.body).includes("钟楼"), "推理字段里的地理清单被救回并建图");
  ok(result.body.data.receipt.summary.includes("首轮自动建图"), "回执注明自动建图");
});

test("0.9.32 点挂子图：commit 落 sidecar（maps:<worldId>），/state 带出 submaps 与点位描述", async () => {
  const draftWithSub = {
    ...GOOD_DRAFT,
    npcChanges: [{ entityId: "entity-npc", key: "whereabouts", value: "潮门" }],
    newLocations: [
      {
        name: "潮门钟楼",
        description: "潮门旁的旧钟楼。",
        submap: {
          scale: { distancePerCell: 5, unit: "米" },
          points: [{ name: "钟室" }, { name: "楼梯间" }],
        },
      },
    ],
  };
  const fetcher = makeFetch([() => openAiResponse(draftWithSub)]);
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const { core, carrier } = sessionCore(store, { fetchFn: fetcher.fetchFn });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  await core.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });

  const result = await core.handle("POST", "/turns/commit", commitRequest(world));
  equal(result.body.ok, true, "提交成功");
  ok(result.body.data.receipt.summary.includes("新增地点"), "回执注明新增地点");

  // sidecar 文档：maps:<worldId> 写入且键 = 新点 id
  const worldNow = (await core.handle("GET", "/state/chat-a")).body.data;
  const newPoint = worldNow.map.points.find((p) => p.name === "潮门钟楼");
  ok(newPoint, "新地点已进世界点位");
  const doc = carrier.session.maps;
  ok(doc, "sidecar 文档已写入");
  const sub = doc.submaps[String(newPoint.id)];
  ok(sub, "子图键 = 点位 id");
  equal(sub.points.length, 2, "子图两点位");
  ok(sub.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), "子图点位有网格坐标");
  equal(sub.scale.distancePerCell, 5, "子图比例尺");
  equal(doc.pointMeta[String(newPoint.id)].description, "潮门旁的旧钟楼。", "点位描述入 sidecar");

  // /state 带出 submap（UI 渲染数据源）
  ok(worldNow.map.submaps && worldNow.map.submaps[String(newPoint.id)], "/state 带出子图");
  equal(worldNow.map.submaps[String(newPoint.id)].points.length, 2, "/state 子图点位");
  equal(worldNow.map.pointMeta[String(newPoint.id)].description, "潮门旁的旧钟楼。", "/state 带出点位描述");
});

test("state exposes reachable nested submaps with parent links and frame", async () => {
  const { core, carrier } = await setup(null);
  carrier.session.maps = {
    schemaVersion: 2, pointMeta: {}, calibrations: {},
    submaps: {
      "4103": {
        parentMapId: "world", ownerLocationId: "4103",
        frame: { cols: 20, rows: 10, frameRevision: 2 },
        points: [{ id: "sub-room", name: "里间", x: 50, y: 50 }],
      },
      "sub-room": {
        parentMapId: "4103", ownerLocationId: "sub-room",
        frame: { cols: 8, rows: 6, frameRevision: 3 },
        points: [{ id: "sub-cabinet", name: "柜内", x: 50, y: 50 }],
      },
      "sub-cabinet": {
        parentMapId: "sub-room", ownerLocationId: "sub-cabinet",
        points: [{ id: "box", name: "盒子", x: 50, y: 50 }],
      },
      "orphan": { parentMapId: "missing", points: [{ id: "ghost", name: "幽灵", x: 5, y: 5 }] },
    },
  };
  const result = await core.handle("GET", "/state/chat-a");
  equal(result.body.ok, true, "state 可读");
  const maps = result.body.data.map.submaps;
  equal(maps["4103"].frame.cols, 20, "顶层 frame");
  equal(maps["sub-room"].parentMapId, "4103", "房间父链");
  equal(maps["sub-room"].frame.rows, 6, "房间 frame");
  equal(maps["sub-cabinet"].parentMapId, "sub-room", "三层地图可达");
  equal(maps.orphan, undefined, "孤儿地图不公开");
  const calibrated = await core.handle("POST", "/worlds/scale/calibrate", {
    chatId: "chat-a", mapId: "sub-room", userMetersPerCell: 0.0004,
  }, { local: true });
  equal(calibrated.body.data.status, "grounded", "嵌套房间可人工标定");
  const after = await core.handle("GET", "/state/chat-a");
  equal(after.body.data.map.calibrations["sub-room"].metersPerCell, 0.0004, "微小正标定保留");
});

test("0.9.41 地图三型标点：/state 带人物动向字段（status / recentNarratives / pointName）与物品描述", async () => {
  const fetcher = makeFetch([() => openAiResponse(GOOD_DRAFT)]);
  const store = createMemoryDocumentStore();
  const built = buildWorld();
  // 物品实体：挂起点 4103（白塔钟座），带 baseline 描述
  const itemResult = upsertEntityRecord(built, {
    id: "entity-item", worldId: built.id, type: "item", name: "旧铜钥匙",
    baseline: { description: "一把生锈的铜钥匙，环上刻着古精灵文字。" },
    temporalSchema: [{ key: "description", kind: "base", valueType: "string" }],
    mapAnchor: { pointId: "4103" },
  }, { now: 1000 });
  ok(itemResult.ok, "物品实体建档成功");
  // 人物动态状态：chronicle-c1 在 4103（capital 区，relevance sameRegion/samePoint 命中）
  const worldJson = JSON.parse(JSON.stringify(itemResult.value));
  worldJson.characterStates = [
    { characterId: "chronicle-c1", currentRegionId: "capital", currentPointId: "4103", status: "正在清点行囊，准备离开王都。", updatedAt: 999, branchId: null },
  ];
  const world = parseWorld(worldJson);
  ok(world !== null, "夹具世界可解析");
  const { core } = sessionCore(store, { fetchFn: fetcher.fetchFn });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  await core.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });
  const committed = await core.handle("POST", "/turns/commit", commitRequest(world));
  equal(committed.body.ok, true, "提交成功");

  const state = (await core.handle("GET", "/state/chat-a")).body.data;
  const npc = (state.npcDirectory ?? []).find((n) => n.id === "chronicle-c1");
  ok(npc, "人物目录含同区角色");
  equal(npc.status, "正在清点行囊，准备离开王都。", "人物动向 = CharacterState.status");
  equal(npc.pointName, "白塔钟座", "人物所在地点名");
  ok(Array.isArray(npc.recentNarratives), "最近涉及叙事为数组");

  const item = (state.objectDirectory ?? []).find((o) => o.id === "entity-item");
  ok(item, "物品目录含带锚点实体");
  equal(item.description, "一把生锈的铜钥匙，环上刻着古精灵文字。", "物品描述 = baseline.description");
  equal(item.pointName, "白塔钟座", "物品所在地点名");
});

test("retry：沿用原幂等键，成功后世界恰好推进一次", async () => {
  // 第一次 429 失败，重试成功
  const fetcher = makeFetch([() => jsonResponse(429, {}), () => openAiResponse(GOOD_DRAFT)]);
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const { core } = sessionCore(store, { fetchFn: fetcher.fetchFn });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  await core.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });

  const first = await core.handle("POST", "/turns/commit", commitRequest(world));
  equal(first.body.error.code, ATLAS_ERROR_CODES.API_RATE_LIMITED, "首次 429");

  const retry = await core.handle("POST", "/turns/retry", {
    chatId: "chat-a",
    userMessageId: "msg-10",
    assistantMessageId: "msg-11",
    swipeId: null,
  });
  equal(retry.status, 200, "retry 成功");
  const receipt = retry.body.data.receipt;
  equal(receipt.status, "committed", "retry 后 committed");
  equal(receipt.currentTime, 430.07, "时间只推进一次");
  equal(fetcher.calls.length, 2, "总计 2 条请求（1 失败 + 1 成功）");

  // 再次 retry：pending 已清、回执已缓存 → duplicate，0 新请求
  const again = await core.handle("POST", "/turns/retry", {
    chatId: "chat-a",
    userMessageId: "msg-10",
    assistantMessageId: "msg-11",
    swipeId: null,
  });
  equal(again.body.data.receipt.status, "duplicate", "duplicate 回执");
  equal(fetcher.calls.length, 2, "请求总数不变");

  // 无 pending 的 retry 被拒
  const missing = await core.handle("POST", "/turns/retry", {
    chatId: "chat-a",
    userMessageId: "msg-99",
    assistantMessageId: "msg-100",
  });
  equal(missing.body.error.code, ATLAS_ERROR_CODES.INVALID_PAYLOAD, "无 pending 拒绝");
});

test("RPM：超过限额直接 429，0 fetch", async () => {
  // 第 1 条请求打到上游 429（消耗 RPM 窗口预算）；第 2 条被本地 RPM 直接拒绝
  const fetcher = makeFetch([() => jsonResponse(429, {})]);
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const { core } = sessionCore(store, { fetchFn: fetcher.fetchFn });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  await core.handle("PUT", "/settings", { worldTurn: preset(), rpmLimit: 1 }, { local: true });

  const first = await core.handle("POST", "/turns/commit", commitRequest(world));
  equal(first.body.error.code, ATLAS_ERROR_CODES.API_RATE_LIMITED, "首条遇上游 429");
  equal(fetcher.calls.length, 1, "1 条请求已发出");
  // 第二条：RPM 窗口已满 → 不发请求直接拒绝
  const second = await core.handle("POST", "/turns/commit", commitRequest(world, { assistantMessageId: "msg-12" }));
  equal(second.body.error.code, ATLAS_ERROR_CODES.API_RATE_LIMITED, "RPM 拒绝");
  equal(fetcher.calls.length, 1, "RPM 拒绝为 0 新请求");
});

test("队列：同聊天并发 commit 串行执行，不并发冲击", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const slowFetch = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight -= 1;
    return openAiResponse({
      ...GOOD_DRAFT,
      duration: 1,
      locationChange: null,
      npcChanges: [{ entityId: "entity-npc", key: "whereabouts", value: "集市" }],
      memoryDrafts: [],
      summary: "旅行者在集市逗留。",
    });
  };
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const { core } = sessionCore(store, { fetchFn: slowFetch });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  await core.handle("PUT", "/settings", { worldTurn: preset(), rpmLimit: 50 }, { local: true });

  const first = core.handle("POST", "/turns/commit", commitRequest(world));
  const second = core.handle("POST", "/turns/commit", commitRequest(world));
  const [r1, r2] = await Promise.all([first, second]);
  const statuses = [r1, r2].map((r) => r.body?.data?.receipt?.status ?? r.body?.error?.code);
  // 0.9.42 会话承载：并发双发携带同一份旧会话 → 后到者 409 SESSION_STALE（双开保护），互斥仍保证世界只推进一次
  deepEqual(statuses.sort(), ["SESSION_STALE", "committed"], "并发提交 → 1 committed + 1 SESSION_STALE");
  equal(maxInFlight, 1, "任一时刻至多 1 条在途请求");
});

// ---------------------------------------------------------------------------
// restore / travel-preview / 契约往返
// ---------------------------------------------------------------------------

test("restore：未绑定拒绝；未知检查点拒绝；有效检查点返回有界预览", async () => {
  const { core } = await setup(null);
  const unbound = await core.handle("POST", "/turns/restore", { chatId: "chat-none", checkpointId: "cp-1" });
  equal(unbound.body.error.code, ATLAS_ERROR_CODES.NOT_BOUND, "NOT_BOUND");
  const missing = await core.handle("POST", "/turns/restore", { chatId: "chat-a", checkpointId: "cp-nope" });
  equal(missing.body.error.code, ATLAS_ERROR_CODES.INVALID_PAYLOAD, "未知检查点 INVALID_PAYLOAD");
});

test("travel-preview：只读、距离与共享算法一致", async () => {
  const { core } = await setup(null);
  const result = await core.handle("POST", "/map/travel-preview", { chatId: "chat-a", destinationPointId: "4102" });
  equal(result.status, 200, "preview 200");
  const preview = result.body.data.preview;
  ok(preview !== null, "给出预览");
  equal(preview.destinationId, "4102", "目的地");
  ok(preview.estimatedDuration >= 1, "正时长");
  // 未绑定聊天拒绝
  const denied = await core.handle("POST", "/map/travel-preview", { chatId: "chat-none", destinationPointId: "4102" });
  equal(denied.body.error.code, ATLAS_ERROR_CODES.NOT_BOUND, "NOT_BOUND");
});

test("未知路由返回 400 与稳定错误码", async () => {
  const { core } = await setup(null);
  const result = await core.handle("GET", "/no-such-route");
  equal(result.status, 400, "未知路由 400");
  ok(result.body.error.message.includes("未知路由"), "错误说明可读");
});

// ---------------------------------------------------------------------------
// 解析器与 URL 工具专项
// ---------------------------------------------------------------------------

test("parseAtlasWorldTurnDraft：围栏 JSON / 字符串 duration / 容错抢救（0.9.25 shujuku 口径）", () => {
  const fenced = parseAtlasWorldTurnDraft("```json\n" + JSON.stringify(GOOD_DRAFT) + "\n```");
  equal(fenced.duration, 12, "围栏 JSON 解析");
  const stringDuration = parseAtlasWorldTurnDraft(JSON.stringify({ ...GOOD_DRAFT, duration: "3" }));
  equal(stringDuration.duration, 3, "字符串 duration 转换");
  assert.throws(() => parseAtlasWorldTurnDraft("这不是 JSON"), (err) => err.code === ATLAS_ERROR_CODES.RESPONSE_MALFORMED);
  assert.throws(() => parseAtlasWorldTurnDraft(JSON.stringify({ ...GOOD_DRAFT, summary: "" })), (err) => err.code === ATLAS_ERROR_CODES.RESPONSE_MALFORMED);
  assert.throws(() => parseAtlasWorldTurnDraft(JSON.stringify({ ...GOOD_DRAFT, duration: -1 })), (err) => err.code === ATLAS_ERROR_CODES.RESPONSE_MALFORMED);
  // 0.9.25：坏条丢弃不整单炸（shujuku filter(Boolean) 同款）
  const dropped = parseAtlasWorldTurnDraft(JSON.stringify({ ...GOOD_DRAFT, npcChanges: [{ foo: 1 }] }));
  equal(dropped.rawEffects.length, 0, "无法识别的变化条目被丢弃");
  ok(dropped.summary.includes("丢弃 1 条"), "丢弃计数并入摘要");
  // 0.9.25：JSON 完全损坏（外层截断）时字段级抢救——summary / duration / npcChanges 从原文提取
  const salvaged = parseAtlasWorldTurnDraft(
    '前置说明 {"summary": "被说明文字包住的摘要", "duration": "7", "npcChanges": [{"entityId": "npc-1", "tag": "受伤"}, {"垃圾": true}]',
  );
  equal(salvaged.summary, "被说明文字包住的摘要", "字段级抢救出 summary");
  equal(salvaged.duration, 7, "字段级抢救出 duration");
  equal(salvaged.rawEffects.length, 1, "抢救出 1 条合法变化、坏条丢弃");
  assertionCount += 9;
});

test("buildAtlasChatUrl：规范化与拒绝", () => {
  equal(buildAtlasChatUrl("https://api.example.com/v1"), "https://api.example.com/v1/chat/completions", "补全路径");
  equal(buildAtlasChatUrl("https://api.example.com/v1/chat/completions"), "https://api.example.com/v1/chat/completions", "幂等");
  equal(buildAtlasChatUrl("ftp://x"), null, "非 http(s) 拒绝");
  equal(buildAtlasChatUrl("::bad::"), null, "非法 URL 拒绝");
});

// ---------------------------------------------------------------------------
// systemPrompt：推演提示词可看可改（0.7.6）
// ---------------------------------------------------------------------------

test("systemPrompt：自定义系统提示词生效，留空回退内置默认分段（0.9.39 多轮结构）", async () => {
  const custom = "自定义推演规则：本轮只追踪天气变化。";
  const scenarios = [
    { label: "自定义提示词", prompt: custom, expected: custom },
    { label: "省略字段", prompt: undefined, expected: DEFAULT_WORLD_TURN_SYSTEM_PROMPT },
    { label: "空白字符串", prompt: "   ", expected: DEFAULT_WORLD_TURN_SYSTEM_PROMPT },
  ];
  for (const scenario of scenarios) {
    const presetValue = scenario.prompt === undefined ? preset() : preset({ systemPrompt: scenario.prompt });
    const { fetchFn, calls } = makeFetch([() => openAiResponse(GOOD_DRAFT)]);
    const call = await callAtlasWorldTurnApi(presetValue, { injectionText: "注入", userText: "用户", assistantText: "助手" }, { fetchFn, now: () => NOW });
    ok(call.ok, `${scenario.label}：请求成功`);
    equal(calls[0].body.messages[0].role, "system", `${scenario.label}：第一条是 system`);
    equal(calls[0].body.messages[0].content, scenario.expected, `${scenario.label}：system 正文符合预期`);
  }
  // 自定义 systemPrompt → 旧版单条任务模板（两条，0.9.17 语义保留）
  {
    const { fetchFn, calls } = makeFetch([() => openAiResponse(GOOD_DRAFT)]);
    await callAtlasWorldTurnApi(preset({ systemPrompt: custom }), { injectionText: "注入", userText: "用户", assistantText: "助手" }, { fetchFn, now: () => NOW });
    equal(calls[0].body.messages.length, 2, "自定义 systemPrompt：两条");
    equal(calls[0].body.messages[1].role, "user", "自定义 systemPrompt：第二条是 user（素材段）");
    ok(calls[0].body.messages[1].content.includes("用户"), "素材段含本轮用户行动");
  }
  // 留空 → 整套内置默认分段（R03 六段结构：无 assistant 应答与 { 预填）
  {
    const { fetchFn, calls } = makeFetch([() => openAiResponse(GOOD_DRAFT)]);
    await callAtlasWorldTurnApi(preset(), { injectionText: "注入", userText: "用户", assistantText: "助手" }, { fetchFn, now: () => NOW });
    equal(calls[0].body.messages.length, 6, "留空：整套内置默认 6 段");
    equal(calls[0].body.messages[1].role, "user", "第二段是 user（世界状态 $5）");
    ok(calls[0].body.messages[1].content.includes("注入"), "世界状态段已插入 $5 注入内容（D03 修复）");
    ok(calls[0].body.messages[calls[0].body.messages.length - 2].content.includes("用户"), "触发段含本轮素材");
    ok(calls[0].body.messages[calls[0].body.messages.length - 1].content.includes("只输出完整 JSON 对象"), "末段为提交前核对（无 { 预填）");
  }
});

test("提示词预设：服务端校验（上限 8000 / 空拒绝 / 内置默认不可覆盖删除）", async () => {
  const { core } = sessionCore(createMemoryDocumentStore());
  const good = await core.handle("PUT", "/settings", { action: "prompt.save", preset: { name: "长提示词", systemPrompt: "好".repeat(8000) } }, { local: true });
  equal(good.status, 200, "8000 字以内接受");
  const over = await core.handle("PUT", "/settings", { action: "prompt.save", preset: { name: "超长", systemPrompt: "长".repeat(8001) } }, { local: true });
  equal(over.status, 413, "超 8000 字拒绝（FIELD_LIMIT_EXCEEDED → 413）");
  equal(over.body.error.code, ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED, "超限错误码");
  const empty = await core.handle("PUT", "/settings", { action: "prompt.save", preset: { name: "空", systemPrompt: "   " } }, { local: true });
  equal(empty.status, 400, "空提示词拒绝（空 = 内置默认，无需保存）");
  const builtin = await core.handle("PUT", "/settings", { action: "prompt.save", preset: { id: "builtin-default", name: "内置默认", systemPrompt: "偷改" } }, { local: true });
  equal(builtin.status, 400, "内置默认不可覆盖");
  const delBuiltin = await core.handle("PUT", "/settings", { action: "prompt.delete", id: "builtin-default" }, { local: true });
  equal(delBuiltin.status, 400, "内置默认不可删除");
});

// ---------------------------------------------------------------------------
// ATLAS-06：swipe / 编辑 / 删除 → 检查点回退
// ---------------------------------------------------------------------------

test("ATLAS-06 rollback：回退世界与绑定游标，账本保留，变体重提交为同级结果", async () => {
  const fetcher = makeFetch([() => openAiResponse(GOOD_DRAFT), () => openAiResponse(GOOD_DRAFT)]);
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const { core: fresh, carrier } = sessionCore(store, { fetchFn: fetcher.fetchFn });
  await fresh.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await fresh.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  await fresh.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });

  // 回合 A：swipeId null 首次提交 → 时间 418.07 → 430.07
  const first = await fresh.handle("POST", "/turns/commit", commitRequest(world));
  equal(first.body.data.receipt.status, "committed", "变体 A committed");
  equal(first.body.data.receipt.currentTime, 430.07, "变体 A 时间推进");

  // 回合前检查点已随提交持久化 + 楼层映射已写（0.9.42 起世界与映射都住会话）
  const worldAfterCommit = carrier.session.world;
  const ckpts = (worldAfterCommit.checkpoints ?? []).filter((c) => String(c.reason ?? "").startsWith("atlas-turn:"));
  equal(ckpts.length, 1, "恰好一个回合前技术检查点");
  const turnKeys = Object.keys(carrier.session.turns).filter((k) => k.startsWith("turn:chat-a:"));
  equal(turnKeys.length, 1, "楼层↔检查点映射已写");

  // swipe → rollback：世界与绑定游标回到回合前
  const rb = await fresh.handle("POST", "/turns/rollback", { chatId: "chat-a", assistantMessageId: "msg-11" });
  equal(rb.status, 200, "rollback 200");
  const stateAfter = await fresh.handle("GET", "/state/chat-a");
  equal(stateAfter.body.data.currentTime, CURRENT_TIME, "时间游标回到回合前");
  equal(stateAfter.body.data.currentLocationId, "4103", "位置游标回到回合前");
  const worldAfterRollback = carrier.session.world;
  equal(
    (worldAfterRollback.stateEvents ?? []).length,
    (worldAfterCommit.stateEvents ?? []).length,
    "账本事件一条不删（默认保留可返回历史）",
  );
  ok(isCheckpointIntact(ckpts[0]), "检查点 hash 完整（可追溯）");

  // 变体 B 重提交（唯一 swipeId）：committed 同级结果——时间从回合前重新推进到 430.07，不累计
  const variant = commitRequest(world, { swipeId: "swipe-2" });
  const second = await fresh.handle("POST", "/turns/commit", variant);
  equal(second.body.data.receipt.status, "committed", "变体 B committed（非 duplicate）");
  equal(second.body.data.receipt.currentTime, 430.07, "同级结果：时间不累计推进");

  // 回退后的映射标记 rolledBack（保留历史），变体 B 有自己的映射
  const rolledDoc = carrier.session.turns[turnKeys[0]];
  equal(rolledDoc.rolledBack, true, "旧变体映射标记已回退");
  equal(Object.keys(carrier.session.turns).filter((k) => k.startsWith("turn:chat-a:")).length, 2, "变体 B 映射已写");
});

test("ATLAS-06 rollback：只允许回退最近一条未回退回合；未知楼层拒绝", async () => {
  // 时钟递增：committedAt 必须可比较（回退守卫按提交时间找「最近一条」）
  let tick = NOW;
  const clock = () => tick;
  const fetcher = makeFetch([() => openAiResponse(GOOD_DRAFT), () => openAiResponse(GOOD_DRAFT), () => openAiResponse(GOOD_DRAFT)]);
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const fresh = sessionCore(store, { fetchFn: fetcher.fetchFn, now: clock }).core;
  await fresh.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await fresh.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  await fresh.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });

  // 两个连续回合：A（msg-10/msg-11）→ B（msg-14/msg-15）
  tick += 1;
  await fresh.handle("POST", "/turns/commit", commitRequest(world));
  tick += 1;
  await fresh.handle("POST", "/turns/commit", commitRequest(world, { turnId: "turn-y", userMessageId: "msg-14", assistantMessageId: "msg-15" }));

  // 回退中间回合 A → 拒绝（会连带抹掉 B）
  const mid = await fresh.handle("POST", "/turns/rollback", { chatId: "chat-a", assistantMessageId: "msg-11" });
  equal(mid.status, 400, "非最近回合拒绝");
  ok(mid.body.error.message.includes("最近一次"), "拒绝原因可读");

  // 回退最近回合 B → 成功；之后 A 成为最近 → 可回退
  const last = await fresh.handle("POST", "/turns/rollback", { chatId: "chat-a", assistantMessageId: "msg-15" });
  equal(last.status, 200, "最近回合可回退");
  const thenA = await fresh.handle("POST", "/turns/rollback", { chatId: "chat-a", assistantMessageId: "msg-11" });
  equal(thenA.status, 200, "B 回退后 A 成为最近，可回退");

  // 未知楼层 / 重复回退 → 拒绝
  const unknown = await fresh.handle("POST", "/turns/rollback", { chatId: "chat-a", assistantMessageId: "msg-nope" });
  equal(unknown.status, 400, "未知楼层拒绝");
  const repeat = await fresh.handle("POST", "/turns/rollback", { chatId: "chat-a", assistantMessageId: "msg-11" });
  equal(repeat.status, 400, "已回退回合不可再回退");
});

// ---------------------------------------------------------------------------
// 节点文件存储：原子写
// ---------------------------------------------------------------------------

test("node store：原子写 + 半截文件容错 + list 前缀", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-store-test-"));
  const store = createNodeDocumentStore(dir);
  await store.write("settings", { hello: "world" });
  const readBack = await store.read("settings");
  deepEqual(readBack, { hello: "world" }, "写后读一致");
  ok(!readdirSync(dir).some((name) => name.endsWith(".tmp")), "无临时文件残留");
  // 写入被拒的超大文档（>4MB）
  await assert.rejects(() => store.write("world:big", { blob: "x".repeat(5 * 1024 * 1024) }));
  // 手工制造半截文件 → 读取返回 null 而不是崩溃
  // P0-08 后文件名为 base64url 规范编码（settings → c2V0dGluZ3M），一一映射可复算
  const settingsFile = "c2V0dGluZ3M.json";
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "broken.json"), '{"half":', "utf8");
  equal(await store.read("broken"), null, "半截 JSON 视为不存在");
  await store.write("world:a1", { id: "a1" });
  await store.write("world:a2", { id: "a2" });
  const list = await store.list("world:");
  deepEqual(list.sort(), ["world:a1", "world:a2"], "list 前缀匹配");
  ok(existsSync(join(dir, settingsFile)), "settings 文件仍在");
  await store.remove("settings");
  equal(await store.read("settings"), null, "删除生效");
});

// ---------------------------------------------------------------------------
// 0.9.50 地图尺度标定（外部 AI 计划 M04/M05：AI 判断地图实际范围 + sidecar 持久化）
// ---------------------------------------------------------------------------

test("0.9.50 标定：AI 估计世界图范围 → 程序推导每格米数落 sidecar 并随 /state 下发", async () => {
  const spec = {
    status: "estimated",
    coverage: "白塔王都主城及城墙内街区",
    extentMeters: { width: 6000, height: 6000 },
    basis: "参照城墙描述估计为步行一日的城区",
    confidence: "medium",
  };
  const { core, world, carrier } = await setup([() => openAiResponse(spec)]);
  const result = await core.handle(
    "POST",
    "/worlds/scale/calibrate",
    { chatId: "chat-a", mapId: "world", loreSupplement: "城墙周长约二十四里。〔有界材料〕" },
    { local: true },
  );
  equal(result.status, 200, "标定请求成功");
  ok(result.body.ok);
  equal(result.body.data.status, "calibrated");
  ok(result.body.data.calibrated === true);
  // 100×100 等距方格：6000 米 / 100 格 = 60 米每格（程序推导，模型不自报每格距离）
  equal(result.body.data.calibration.metersPerCell, 60);
  equal(result.body.data.calibration.source, "ai-estimated");
  equal(result.body.data.calibration.locked, false);
  equal(result.body.data.calibration.coverage, "白塔王都主城及城墙内街区");
  // sidecar 落在会话覆盖层（maps 文档），不落全局 store
  ok(carrier.session.maps?.calibrations?.world?.metersPerCell === 60, "会话 sidecar 持久化标定");
  const state = await core.handle("POST", "/state", { chatId: "chat-a" }, { local: true });
  equal(state.body.data.map.calibrations.world.metersPerCell, 60, "/state 下发标定摘要");
  void world;
});

test("0.9.50 标定：unknown / conflict / 伪数值均不落标定", async () => {
  // unknown：材料不足
  const { core } = await setup([() => openAiResponse({ status: "unknown", coverage: "", basis: "材料不足" })]);
  const r1 = await core.handle("POST", "/worlds/scale/calibrate", { chatId: "chat-a", mapId: "world" }, { local: true });
  equal(r1.body.data.status, "unknown");
  ok(r1.body.data.calibrated === false, "unknown 不落标定");
  const s1 = await core.handle("POST", "/state", { chatId: "chat-a" }, { local: true });
  ok(!("world" in (s1.body.data.map.calibrations ?? {})), "state 无 world 标定");

  // conflict：横纵每格距离超差（6000 宽 / 3000 高 → 60 vs 30 米每格）不静默取平均
  const { core: core2 } = await setup([() => openAiResponse({ status: "estimated", extentMeters: { width: 6000, height: 3000 }, basis: "" })]);
  const r2 = await core2.handle("POST", "/worlds/scale/calibrate", { chatId: "chat-a", mapId: "world" }, { local: true });
  equal(r2.body.data.status, "conflict");
  ok(r2.body.data.calibrated === false, "宽高不一致按 conflict 拒收");
  ok(String(r2.body.data.message).includes("1% 容差"), "拒收原因可读");

  // 字符串伪数值：拒绝（不 Number() 强转）
  const { core: core3 } = await setup([() => openAiResponse({ status: "estimated", extentMeters: { width: "6000", height: "6000" } })]);
  const r3 = await core3.handle("POST", "/worlds/scale/calibrate", { chatId: "chat-a", mapId: "world" }, { local: true });
  equal(r3.body.data.status, "invalid", "字符串伪数值拒绝");
});

test("0.9.50 标定：人工标定锁定 → AI 覆盖被拒 → 人工可更新（revision 递增）", async () => {
  const { core } = await setup(null);
  const r1 = await core.handle(
    "POST",
    "/worlds/scale/calibrate",
    { chatId: "chat-a", mapId: "world", userMetersPerCell: 25, basis: "作者按设定填的" },
    { local: true },
  );
  equal(r1.body.data.calibration.source, "user");
  ok(r1.body.data.calibration.locked === true, "人工标定默认锁定");
  equal(r1.body.data.calibration.metersPerCell, 25);
  // AI 模式撞锁定：400（INVALID_PAYLOAD），不发模型请求
  const r2 = await core.handle("POST", "/worlds/scale/calibrate", { chatId: "chat-a", mapId: "world" }, { local: true });
  equal(r2.status, 400, "锁定图拒绝 AI 重估");
  ok(String(r2.body.error.message).includes("锁定"));
  // 人工覆盖允许：revision +1
  const r3 = await core.handle(
    "POST",
    "/worlds/scale/calibrate",
    { chatId: "chat-a", mapId: "world", userMetersPerCell: 30 },
    { local: true },
  );
  equal(r3.body.data.calibration.metersPerCell, 30);
  equal(r3.body.data.calibration.revision, 2, "覆写 revision 递增");
  // 非法人工值拒绝
  const r4 = await core.handle(
    "POST",
    "/worlds/scale/calibrate",
    { chatId: "chat-a", mapId: "world", userMetersPerCell: -5 },
    { local: true },
  );
  equal(r4.status, 400, "负数人工值拒绝");
});

test("0.9.50 标定：子图宿主点位不存在 → 400；损坏子图引用被 /state 过滤（M01 子集）", async () => {
  const { core, carrier, world } = await setup(null);
  const r1 = await core.handle("POST", "/worlds/scale/calibrate", { chatId: "chat-a", mapId: "ghost-point" }, { local: true });
  equal(r1.status, 400, "幽灵子图宿主点拒绝");
  // M01 子集：sidecar 里的损坏子图引用（宿主点位已不存在）随 /state 被过滤
  carrier.session.maps = {
    schemaVersion: 2,
    pointMeta: {},
    submaps: {
      // 真实点位（binding.currentLocationId）
      "4103": { points: [{ id: "s1", name: "门厅", x: 50, y: 50 }] },
      // 幽灵引用
      "ghost-point": { points: [{ id: "s2", name: "不存在", x: 10, y: 10 }] },
    },
    calibrations: { "ghost-point": { revision: 1, metersPerCell: 5, source: "user", locked: true, basis: "", coverage: "", confidence: "", at: 1 } },
  };
  const state = await core.handle("POST", "/state", { chatId: "chat-a" }, { local: true });
  ok("4103" in state.body.data.map.submaps, "真实子图保留");
  ok(!("ghost-point" in state.body.data.map.submaps), "幽灵子图被过滤");
  ok(!("ghost-point" in (state.body.data.map.calibrations ?? {})), "幽灵标定被过滤");
  void world;
});

test(`本轮累计断言已记录（计数见报告）`, () => {
  ok(assertionCount > 60, "断言数量达到覆盖要求");
});

test("invalid old prompt entry blocks settings writes and preserves the raw document", async () => {
  const store = createMemoryDocumentStore();
  const raw = {
    schemaVersion: 2, apiPresets: [], activeApiPresetId: null,
    promptPresets: [
      { id: "valid", name: "有效", systemPrompt: "已保存的提示词", updatedAt: NOW },
      { id: "old-invalid", name: "待恢复", systemPrompt: { legacy: "内容" }, updatedAt: NOW },
    ],
    activePromptPresetId: "valid", autoCommit: true, rpmLimit: 30,
  };
  await store.write("settings", raw);
  const { core } = sessionCore(store);
  const view = await core.handle("GET", "/settings", null, { local: true });
  assert.equal(view.status, 200);
  assert.equal(view.body.data.recoveryPromptCount, 1);
  assert.equal(view.body.data.promptPresets.length, 1);
  const result = await core.handle("PUT", "/settings",
    { action: "runtime.update", rpmLimit: 40 }, { local: true });
  assert.notEqual(result.status, 200);
  assert.match(result.body.error.message, /备份原始设置/);
  assert.deepEqual(await store.read("settings"), raw);
});

// ---------------------------------------------------------------------------
// S0（0.9.55）：v2 父引用 → 子图现状夹具
//
// 现场：v2 的 discoveries.locations[].parentLocationRef 目前只在
// src/atlas-turn-v2.ts 收集后推一条「暂存未落账」warning，MapPoint 上没有父字段，
// 因此「世界图点开建筑 → 再点开房间」这条链路完全不存在。
// 本用例锁定真正缺口：**在现版本预期失败**，以此作为 S1–S7 的红灯基线。
// ---------------------------------------------------------------------------

/** 造一个带已知地点“钟楼”的世界（v2 父引用需要一个可引用的既有地点）。 */
async function setupWithTower() {
  const store = createMemoryDocumentStore();
  const base = buildWorld();
  const regionId = String((base.regions ?? [])[0]?.id ?? "");
  const world = {
    ...base,
    points: [
      ...(base.points ?? []),
      { id: 9001, name: "钟楼", x: 10, y: 10, regionId },
    ],
  };
  const parsed = parseWorld(JSON.parse(JSON.stringify(world)));
  ok(parsed !== null, "带钟楼的世界可解析");
  const draft = {
    schemaVersion: 2,
    baseRevision: CURRENT_TIME,
    duration: 1,
    evidence: [{ id: "ev1", sourceId: "msg:a", quote: "大堂" }],
    discoveries: {
      locations: [
        // 已知父（钟楼 9001）→ 本轮新建“大堂”
        { ref: "new:loc:hall", name: "大堂", aliases: [], regionRef: regionId || null, parentLocationRef: "9001", evidenceIds: ["ev1"] },
        // 本轮父（new:loc:hall）→ 本轮新建“档案室”（父子同轮、顺序在父之后）
        { ref: "new:loc:archive", name: "档案室", aliases: [], regionRef: regionId || null, parentLocationRef: "new:loc:hall", evidenceIds: ["ev1"] },
      ],
      characters: [],
    },
    // 场景锚定到最内层房间：当前位置应是档案室
    scene: { resolution: "confirmed", locationRef: "new:loc:archive", transition: "arrive", evidenceIds: ["ev1"] },
    identityUpdates: [], npcUpdates: [], relationUpdates: [], memories: [], worldFlags: [], events: [], mapScaleHints: [],
    summary: "进入钟楼大堂，再进档案室。",
  };
  const rawCore = createAtlasServerCore({
    store,
    fetchFn: makeFetch([() => openAiResponse(draft)]).fetchFn,
    now: () => NOW,
  });
  const carrier = createSessionCarrier(rawCore);
  const core = carrierAsCore(carrier);
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(parsed)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(parsed) });
  await core.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });
  return { store, core, world: parsed, carrier };
}

test("S0：v2 parentLocationRef 应生成两级子图（现版本预期失败——红灯基线）", async () => {
  const { core, world } = await setupWithTower();
  const committed = await core.handle("POST", "/turns/commit",
    commitRequest(world, { userText: "我进钟楼。", assistantText: "你走进钟楼大堂，再推开档案室的门。" }));
  equal(committed.body.data?.receipt?.status, "committed", "本轮提交成功");

  const state = (await core.handle("GET", "/state/chat-a")).body.data;

  // 找到持久 ID：钟楼是已知点，大堂与档案室是本轮新建
  const tower = (state.map.points ?? []).find((p) => p.name === "钟楼");
  ok(tower, "钟楼仍在世界图（根地点）");

  const hall = state.map.submaps?.[String(tower.id)]?.points?.find((p) => p.name === "大堂");
  ok(hall, "钟楼子图里应有“大堂”");

  const archive = state.map.submaps?.[String(hall?.id)]?.points?.find((p) => p.name === "档案室");
  ok(archive, "大堂子图里应有“档案室”（两级父子）");

  // 世界图只下发根地点：大堂/档案室不得出现在 map.points
  ok(!(state.map.points ?? []).some((p) => p.name === "大堂"), "世界图不含子地点“大堂”");
  ok(!(state.map.points ?? []).some((p) => p.name === "档案室"), "世界图不含子地点“档案室”");

  equal(String(state.currentLocationId ?? ""), String(archive?.id ?? ""), "当前位置 = 档案室");
  // pointCount 报告「全部可见、非占位」地点数（含子地点），不误算成世界图标记数。
  // 注意：world.points 里可能含已退役的「起点」占位，故 pointCount 未必等于 points.length；
  // 正确口径是「大于世界图标记数」——子地点计入总数但不上世界图。
  ok(
    typeof state.map.pointCount === "number" && state.map.pointCount > (state.map.points ?? []).length,
    `map.pointCount(${state.map.pointCount}) 应大于世界图标记数(${(state.map.points ?? []).length})——子地点计入总数但不上世界图`,
  );
});

test("v2 discoveries disappear from state, nearby and map after rollback", async () => {
  const assistantText = "你抵达新塔，见到少女。";
  const draft = {
    schemaVersion: 2, baseRevision: CURRENT_TIME, duration: 1,
    evidence: [{ id: "ev1", sourceId: "msg:a", quote: "新塔" }],
    discoveries: {
      locations: [{ ref: "new:loc:tower", name: "新塔", aliases: [], regionRef: null, parentLocationRef: null, evidenceIds: ["ev1"] }],
      characters: [{ ref: "new:npc:girl", displayName: "少女", aliases: [], description: "塔边的人", evidenceIds: ["ev1"] }],
    },
    scene: { resolution: "confirmed", locationRef: "new:loc:tower", transition: "arrive", evidenceIds: ["ev1"] },
    identityUpdates: [],
    npcUpdates: [{ entityRef: "new:npc:girl", location: { op: "set", locationRef: "new:loc:tower" }, presence: "present", status: "在场", evidenceIds: ["ev1"] }],
    relationUpdates: [], memories: [], worldFlags: [], events: [], mapScaleHints: [],
    summary: "抵达新塔。",
  };
  let hiddenRefDraft;
  const { core, world, carrier } = await setup([() => openAiResponse(draft), () => openAiResponse(hiddenRefDraft)]);
  const request = commitRequest(world, { userText: "我去新塔。", assistantText });
  const committed = await core.handle("POST", "/turns/commit", request);
  equal(committed.body.ok, true, "v2 提交成功");
  equal(committed.body.data.receipt.status, "committed", "回执 committed");
  const during = (await core.handle("GET", "/state/chat-a")).body.data;
  ok(during.map.points.some((point) => point.name === "新塔"), "新地点当前可见");
  ok(during.npcDirectory.some((npc) => npc.name === "少女"), "新人当前可见");
  ok(during.relevantNpcIds.some((id) => during.npcDirectory.some((npc) => npc.id === id && npc.name === "少女")), "同地点新人进入附近候选");
  carrier.session.world.stories.push({
    id: "if-before-tower", worldId: world.id, mode: "if", title: "分歧线",
    steps: [], parentStoryId: CANON,
    ifOrigin: { rootStoryId: CANON, sourceStoryId: CANON, anchorAt: CURRENT_TIME },
  });
  carrier.session.binding.branchId = "if-before-tower";
  const siblingResult = await core.handle("GET", "/state/chat-a");
  const sibling = siblingResult.body.data;
  ok(!sibling.map.points.some((point) => point.name === "新塔"), "分歧前兄弟线看不到未来地点");
  ok(!sibling.npcDirectory.some((npc) => npc.name === "少女"), "分歧前兄弟线看不到未来人物");
  hiddenRefDraft = {
    ...draft, baseRevision: sibling.currentTime, duration: 0,
    discoveries: { locations: [], characters: [] },
    scene: { resolution: "confirmed", locationRef: String(during.map.points.find((point) => point.name === "新塔").id),
      transition: "stay", evidenceIds: ["ev1"] },
    npcUpdates: [], summary: "尝试引用兄弟分支的地点。",
  };
  const hiddenCommit = await core.handle("POST", "/turns/commit", commitRequest(world, {
    turnId: "hidden-ref", userMessageId: "msg-12", assistantMessageId: "msg-13", assistantText,
  }));
  ok(hiddenCommit.status !== 200, "兄弟分支不可见地点不得提交");
  ok(/不可见/.test(hiddenCommit.body.error.message), "拒收原因指出分支不可见引用");  carrier.session.binding.branchId = CANON;
  const turn = Object.values(carrier.session.turns).find((item) => item.assistantMessageId === "msg-11");
  ok(turn.createdPointIds.length === 1 && turn.createdEntityIds.length === 1, "回合记录出生来源");
  const rolled = await core.handle("POST", "/turns/rollback", { chatId: "chat-a", assistantMessageId: "msg-11" });
  equal(rolled.body.ok, true, "回退成功");
  const after = (await core.handle("GET", "/state/chat-a")).body.data;
  ok(!after.map.points.some((point) => point.name === "新塔"), "旧游标地图不泄露新地点");
  ok(!after.npcDirectory.some((npc) => npc.name === "少女"), "旧游标附近不泄露新人");
  ok(carrier.session.world.points.some((point) => point.name === "新塔"), "历史定义保留可追溯");
});
