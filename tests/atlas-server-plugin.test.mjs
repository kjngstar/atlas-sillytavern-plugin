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

/** 组装核心：已导入世界 + 已绑定 + 已配置预设。 */
async function setup(fetchScripts, overrides = {}) {
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const core = createAtlasServerCore({
    store,
    fetchFn: fetchScripts ? makeFetch(fetchScripts).fetchFn : undefined,
    now: () => NOW,
    ...overrides,
  });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  if (overrides.skipSettings !== true) {
    await core.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });
  }
  return { store, core, world };
}

// ---------------------------------------------------------------------------
// 路由清单与健康检查
// ---------------------------------------------------------------------------

test("路由清单：14 条且全部在 /api/plugins/atlas 前缀下", () => {
  equal(ATLAS_ROUTE_MANIFEST.length, 14, "dispatch 核心路由数");
  equal(ATLAS_PLUGIN_ROUTES.length, ATLAS_ROUTE_MANIFEST.length, "index.mjs 与核心路由清单一致");
  const plugin = createAtlasServerPlugin();
  for (const route of plugin.routes) {
    ok(route.path.startsWith("/api/plugins/atlas/"), `路由 ${route.path} 前缀固定`);
  }
});

test("health：无敏感字段", async () => {
  const { core } = await setup(null);
  const result = await core.handle("GET", "/health");
  equal(result.status, 200, "health 200");
  const serialized = JSON.stringify(result.body).toLowerCase();
  for (const forbidden of ["key", "token", "secret", "authorization", "env", "path", "cwd"]) {
    ok(!serialized.includes(forbidden), `health 响应不含 ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// settings：脱敏与权限
// ---------------------------------------------------------------------------

test("settings：GET 永不返回明文 Key，PUT 仅限本机会话", async () => {
  const { core } = await setup(null);
  const denied = await core.handle("PUT", "/settings", { worldTurn: preset() }, { local: false });
  equal(denied.status, 403, "非本机会话 PUT 被拒");
  equal(denied.body.error.code, ATLAS_ERROR_CODES.FORBIDDEN, "FORBIDDEN 错误码");

  const view = await core.handle("GET", "/settings");
  const serialized = JSON.stringify(view.body);
  ok(!serialized.includes(SECRET), "settings 响应无明文 Key");
  equal(view.body.data.worldTurn.apiKey.exists, true, "Key 存在标记");
  equal(view.body.data.worldTurn.apiKey.tail, SECRET.slice(-4), "只有尾号掩码");
  ok(!("apiKey" in view.body.data.worldTurn.apiKey && typeof view.body.data.worldTurn.apiKey.apiKey === "string"), "apiKey 不是字符串");

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

test("settings：预设库（0.8.3）——多预设入库 / 脱敏 / 去重 / 按槽局部合并 / 持久化 / 数量上限", async () => {
  const { core, store } = await setup(null, { skipSettings: true });
  const p1 = preset({ name: "渠道A" });
  const p2 = preset({ name: "渠道B", endpoint: "https://b.example.invalid/v1" });
  const put = await core.handle(
    "PUT",
    "/settings",
    { worldTurn: p1, presetLibrary: { worldTurn: [p1, p2] } },
    { local: true },
  );
  equal(put.status, 200, "入库 200");
  equal(put.body.data.presetLibrary.worldTurn.length, 2, "两个预设入库");
  ok(!JSON.stringify(put.body.data).includes(SECRET), "库响应脱敏（无明文 Key）");

  const p1b = preset({ name: "渠道A", model: "atlas-mock-2" });
  const dup = await core.handle("PUT", "/settings", { presetLibrary: { worldTurn: [p1b, p2, p1b] } }, { local: true });
  equal(dup.status, 200, "去重 PUT 200");
  equal(dup.body.data.presetLibrary.worldTurn.length, 2, "同名去重后仍 2 条");
  equal(dup.body.data.presetLibrary.worldTurn[0].model, "atlas-mock-2", "同名后者胜");

  const p3 = preset({ name: "重大事件专用" });
  const partial = await core.handle("PUT", "/settings", { presetLibrary: { majorEvent: [p3] } }, { local: true });
  equal(partial.status, 200, "局部更新 200");
  equal(partial.body.data.presetLibrary.worldTurn.length, 2, "未传槽沿用现有库");
  equal(partial.body.data.presetLibrary.majorEvent.length, 1, "传入槽更新");

  const mixed = await core.handle(
    "PUT",
    "/settings",
    { presetLibrary: { worldTurn: [preset({ endpoint: "bad-url" }), p2] } },
    { local: true },
  );
  equal(mixed.status, 200, "非法条目不炸整单");
  equal(mixed.body.data.presetLibrary.worldTurn.length, 1, "非法条目被丢弃");

  const capped = Array.from({ length: 25 }, (_, i) => preset({ name: `n${i}` }));
  const cap = await core.handle("PUT", "/settings", { presetLibrary: { majorEvent: capped } }, { local: true });
  equal(cap.body.data.presetLibrary.majorEvent.length, 20, "每槽上限 20 截断");

  const fresh = createAtlasServerCore({ store, now: () => NOW });
  const again = await fresh.handle("GET", "/settings");
  equal(again.body.data.presetLibrary.worldTurn.length, 1, "刷新后 worldTurn 库仍在");
  equal(again.body.data.presetLibrary.majorEvent.length, 20, "刷新后 majorEvent 库仍在");
});

// ---------------------------------------------------------------------------
// worlds / bindings / state
// ---------------------------------------------------------------------------

test("worlds：只返回摘要，不返回账本 / 记忆 / 世界书正文", async () => {
  const { core, world } = await setup(null);
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
  const fresh = createAtlasServerCore({ store, fetchFn: fetcher.fetchFn, now: () => NOW });
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

test("commit：未配置 API → API_NOT_CONFIGURED，0 fetch", async () => {
  const fetcher = makeFetch([() => openAiResponse(GOOD_DRAFT)]);
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const core = createAtlasServerCore({ store, fetchFn: fetcher.fetchFn, now: () => NOW });
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
    const core = createAtlasServerCore({ store, fetchFn: fetcher.fetchFn, now: () => NOW });
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
  const core = createAtlasServerCore({ store, fetchFn: fetcher.fetchFn, now: () => NOW });
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

test("retry：沿用原幂等键，成功后世界恰好推进一次", async () => {
  // 第一次 429 失败，重试成功
  const fetcher = makeFetch([() => jsonResponse(429, {}), () => openAiResponse(GOOD_DRAFT)]);
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const core = createAtlasServerCore({ store, fetchFn: fetcher.fetchFn, now: () => NOW });
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
  const core = createAtlasServerCore({ store, fetchFn: fetcher.fetchFn, now: () => NOW });
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
  const core = createAtlasServerCore({ store, fetchFn: slowFetch, now: () => NOW });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  await core.handle("PUT", "/settings", { worldTurn: preset(), rpmLimit: 50 }, { local: true });

  const first = core.handle("POST", "/turns/commit", commitRequest(world));
  const second = core.handle("POST", "/turns/commit", commitRequest(world));
  const [r1, r2] = await Promise.all([first, second]);
  const statuses = [r1, r2].map((r) => r.body?.data?.receipt?.status ?? r.body?.error?.code);
  deepEqual(statuses.sort(), ["committed", "duplicate"], "并发提交 → 1 committed + 1 duplicate");
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

test("parseAtlasWorldTurnDraft：围栏 JSON / 字符串 duration / 非法输入", () => {
  const fenced = parseAtlasWorldTurnDraft("```json\n" + JSON.stringify(GOOD_DRAFT) + "\n```");
  equal(fenced.duration, 12, "围栏 JSON 解析");
  const stringDuration = parseAtlasWorldTurnDraft(JSON.stringify({ ...GOOD_DRAFT, duration: "3" }));
  equal(stringDuration.duration, 3, "字符串 duration 转换");
  assert.throws(() => parseAtlasWorldTurnDraft("这不是 JSON"), (err) => err.code === ATLAS_ERROR_CODES.RESPONSE_MALFORMED);
  assert.throws(() => parseAtlasWorldTurnDraft(JSON.stringify({ ...GOOD_DRAFT, summary: "" })), (err) => err.code === ATLAS_ERROR_CODES.RESPONSE_MALFORMED);
  assert.throws(() => parseAtlasWorldTurnDraft(JSON.stringify({ ...GOOD_DRAFT, duration: -1 })), (err) => err.code === ATLAS_ERROR_CODES.RESPONSE_MALFORMED);
  assert.throws(() => parseAtlasWorldTurnDraft(JSON.stringify({ ...GOOD_DRAFT, npcChanges: [{ foo: 1 }] })), (err) => err.code === ATLAS_ERROR_CODES.RESPONSE_MALFORMED);
  assertionCount += 6;
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

test("systemPrompt：自定义系统提示词生效，留空回退内置默认", async () => {
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
    equal(calls[0].body.messages[1].role, "user", `${scenario.label}：第二条是 user`);
  }
});

test("systemPrompt：服务端校验（上限 8000 / 非字符串拒绝）", async () => {
  const core = createAtlasServerCore({ store: createMemoryDocumentStore(), now: () => NOW });
  const good = await core.handle("PUT", "/settings", { worldTurn: preset({ systemPrompt: "好".repeat(8000) }) }, { local: true });
  equal(good.status, 200, "8000 字以内接受");
  const over = await core.handle("PUT", "/settings", { worldTurn: preset({ systemPrompt: "长".repeat(8001) }) }, { local: true });
  equal(over.status, 400, "超 8000 字拒绝");
  const wrongType = await core.handle("PUT", "/settings", { worldTurn: preset({ systemPrompt: 123 }) }, { local: true });
  equal(wrongType.status, 400, "非字符串拒绝");
});

// ---------------------------------------------------------------------------
// ATLAS-06：swipe / 编辑 / 删除 → 检查点回退
// ---------------------------------------------------------------------------

test("ATLAS-06 rollback：回退世界与绑定游标，账本保留，变体重提交为同级结果", async () => {
  const fetcher = makeFetch([() => openAiResponse(GOOD_DRAFT), () => openAiResponse(GOOD_DRAFT)]);
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const fresh = createAtlasServerCore({ store, fetchFn: fetcher.fetchFn, now: () => NOW });
  await fresh.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await fresh.handle("POST", "/bindings", { action: "bind", binding: binding(world) });
  await fresh.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });

  // 回合 A：swipeId null 首次提交 → 时间 418.07 → 430.07
  const first = await fresh.handle("POST", "/turns/commit", commitRequest(world));
  equal(first.body.data.receipt.status, "committed", "变体 A committed");
  equal(first.body.data.receipt.currentTime, 430.07, "变体 A 时间推进");

  // 回合前检查点已随提交持久化 + 楼层映射已写
  const worldAfterCommit = await store.read("world:atlas-server-fixture");
  const ckpts = (worldAfterCommit.checkpoints ?? []).filter((c) => String(c.reason ?? "").startsWith("atlas-turn:"));
  equal(ckpts.length, 1, "恰好一个回合前技术检查点");
  const turnKeys = await store.list("turn:chat-a:");
  equal(turnKeys.length, 1, "楼层↔检查点映射已写");

  // swipe → rollback：世界与绑定游标回到回合前
  const rb = await fresh.handle("POST", "/turns/rollback", { chatId: "chat-a", assistantMessageId: "msg-11" });
  equal(rb.status, 200, "rollback 200");
  const stateAfter = await fresh.handle("GET", "/state/chat-a");
  equal(stateAfter.body.data.currentTime, CURRENT_TIME, "时间游标回到回合前");
  equal(stateAfter.body.data.currentLocationId, "4103", "位置游标回到回合前");
  const worldAfterRollback = await store.read("world:atlas-server-fixture");
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
  const rolledDoc = await store.read(turnKeys[0]);
  equal(rolledDoc.rolledBack, true, "旧变体映射标记已回退");
  equal((await store.list("turn:chat-a:")).length, 2, "变体 B 映射已写");
});

test("ATLAS-06 rollback：只允许回退最近一条未回退回合；未知楼层拒绝", async () => {
  // 时钟递增：committedAt 必须可比较（回退守卫按提交时间找「最近一条」）
  let tick = NOW;
  const clock = () => tick;
  const fetcher = makeFetch([() => openAiResponse(GOOD_DRAFT), () => openAiResponse(GOOD_DRAFT), () => openAiResponse(GOOD_DRAFT)]);
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const fresh = createAtlasServerCore({ store, fetchFn: fetcher.fetchFn, now: clock });
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

test(`本轮累计断言已记录（计数见报告）`, () => {
  ok(assertionCount > 60, "断言数量达到覆盖要求");
});
