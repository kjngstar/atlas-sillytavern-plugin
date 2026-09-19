/**
 * atlas-release-journey.test.mjs — ATLAS-07 完整验收旅程（模拟 API；规格「完整验收场景」A/B + swipe + 多聊天）。
 *
 * 一个大旅程串起发布验收的关键路径（全部走 createAtlasServerCore 真实路由，不 mock 掩盖）：
 * - 场景 A（零 API 基线）：不配预设 → prepare / 地图 / 旅行预览可用，commit 明确拒绝不假装更新；
 * - 场景 B（正常回合）：预设 → prepare 注入 → commit 推进 → 刷新恢复（新建 core 同 store）→ duplicate 幂等；
 * - 失败 → retry 成功（原幂等键）；
 * - swipe → rollback → 变体同级重提交（时间不累计，ATLAS-06）；
 * - 多聊天隔离：chat-a 推进不移动 chat-b 游标。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createAtlasServerCore, createMemoryDocumentStore } from "../src/atlas-server.ts";
import { buildWorldFromTemplate, getDemoTemplate } from "../lib/demo-events.ts";
import { parseWorld } from "../lib/world-schema.ts";
import { upsertEntityRecord } from "../lib/world-definition.ts";

const NOW = 1_700_000_000_000;
const CANON = "chronicle-canon";
const CURRENT_TIME = 418.07;
const SECRET = "sk-atlas-journey-key-8888";

function buildWorld() {
  let world = buildWorldFromTemplate(getDemoTemplate("chronicle"), { id: "atlas-journey-fixture", now: 1000 });
  for (const entity of [
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
    assert.ok(result.ok, `实体 ${entity.id} 建档成功`);
    if (result.ok) world = result.value;
  }
  const parsed = parseWorld(JSON.parse(JSON.stringify(world)));
  assert.ok(parsed !== null, "夹具世界可解析");
  return parsed;
}

function binding(world, chatId, overrides = {}) {
  return {
    schemaVersion: 1,
    enabled: true,
    chatId,
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

function preset() {
  return {
    name: "旅程推演",
    endpoint: "https://mock.example.invalid/v1",
    model: "atlas-mock",
    apiKey: SECRET,
    timeoutMs: 5000,
  };
}

function commitRequest(world, chatId, overrides = {}) {
  return {
    turnId: `turn-${chatId}-${overrides.assistantMessageId ?? "msg-11"}`,
    chatId,
    userMessageId: "msg-10",
    assistantMessageId: "msg-11",
    swipeId: null,
    userText: "我前往玻璃温室。",
    assistantText: "你沿小径走向玻璃温室。",
    ...overrides,
  };
}

const GOOD_DRAFT = {
  duration: 12,
  locationChange: { toPointId: "4104", toRegionId: "capital" },
  npcChanges: [{ entityId: "entity-npc", key: "whereabouts", value: "玻璃温室" }],
  memoryDrafts: [{ entityId: "entity-npc", text: "在玻璃温室见到一位旅行者。" }],
  eventDrafts: ["温室花房夜开放"],
  triggerResults: [],
  summary: "温室花房夜开放；旅行者抵达玻璃温室。",
};

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

/** 组装核心：导入世界 + 绑定指定聊天。时钟严格递增（回退「最近一条」守卫依赖 committedAt 可比）。 */
async function setup(store, fetchFn, chatId = "chat-a") {
  let tick = NOW;
  const core = createAtlasServerCore({ store, fetchFn, now: () => (tick += 1) });
  const world = buildWorld();
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world, chatId) });
  return { core, world };
}

test("ATLAS-07 场景 A：零 API 基线——prepare / 地图 / 旅行预览可用，commit 明确拒绝", async () => {
  const fetcher = makeFetch([]);
  const { core, world } = await setup(createMemoryDocumentStore(), fetcher.fetchFn);
  // prepare 零模型请求且产出有界注入
  const prepared = await core.handle("POST", "/turns/prepare", {
    chatId: "chat-a",
    messageId: "msg-10",
    worldId: world.id,
    branchId: CANON,
    userText: "我在白塔钟座四处看看。",
    recentMessageRefs: [],
  });
  assert.equal(prepared.status, 200, "prepare 200");
  const response = prepared.body.data.response;
  assert.ok(response.injectionText.length > 0, "注入文本非空");
  assert.ok(response.injectionText.includes("白塔钟座"), "注入含当前位置");
  assert.ok(Array.isArray(response.relevantNpcIds), "候选 NPC 清单");
  assert.equal(fetcher.calls.length, 0, "prepare 零模型请求");
  // 地图 / 附近：state 有界数据
  const state = await core.handle("GET", "/state/chat-a");
  assert.equal(state.status, 200, "state 200");
  assert.equal(state.body.data.currentTime, CURRENT_TIME, "零 API 时游标不推进");
  // commit 无预设 → 明确拒绝，0 fetch
  const commit = await core.handle("POST", "/turns/commit", commitRequest(world, "chat-a"));
  assert.equal(commit.status, 409, "commit 被拒（HTTP 409 = API_NOT_CONFIGURED）");
  assert.equal(commit.body.error.code, "API_NOT_CONFIGURED", "错误码明确");
  assert.equal(fetcher.calls.length, 0, "0 fetch");
});

test("ATLAS-07 场景 B + swipe + 多聊天：完整旅程一条龙", async () => {
  const fetcher = makeFetch([
    () => openAiResponse(GOOD_DRAFT), // 1. 回合 A commit
    () => jsonResponse(401, { error: "bad key" }), // 2. 回合 B 首次 commit 失败
    () => openAiResponse(GOOD_DRAFT), // 3. 回合 B retry 成功
    () => openAiResponse(GOOD_DRAFT), // 4. 变体 B 重提交
  ]);
  const store = createMemoryDocumentStore();
  const { core, world } = await setup(store, fetcher.fetchFn);
  await core.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });
  // 多聊天隔离：chat-b 绑定同一世界，只做对照
  await core.handle("POST", "/bindings", { action: "bind", binding: binding(world, "chat-b") });

  // --- 场景 B：正常回合 ---
  const prepared = await core.handle("POST", "/turns/prepare", {
    chatId: "chat-a",
    messageId: "msg-10",
    worldId: world.id,
    branchId: CANON,
    userText: "我前往玻璃温室。",
    recentMessageRefs: [],
  });
  assert.equal(prepared.status, 200, "B: prepare 200");
  // 旅行预览（地图点击目的地 → 行动建议）
  const travel = await core.handle("POST", "/map/travel-preview", { chatId: "chat-a", destinationPointId: "4104" });
  assert.equal(travel.status, 200, "旅行预览 200");
  assert.equal(travel.body.data.preview?.destinationId, "4104", "预览目的地正确");
  assert.ok(Number(travel.body.data.preview?.distance) >= 0, "预览含距离");
  const commitA = await core.handle("POST", "/turns/commit", commitRequest(world, "chat-a"));
  assert.equal(commitA.body.data.receipt.status, "committed", "B: 回合 A committed");
  assert.equal(commitA.body.data.receipt.currentTime, 430.07, "B: 时间推进 12 时段");
  assert.equal(commitA.body.data.receipt.currentLocationId, "4104", "B: 位置推进到玻璃温室");
  assert.ok(fetcher.calls[0].headers.Authorization.includes(SECRET), "密钥只进 Authorization 头");
  assert.ok(!JSON.stringify(fetcher.calls[0].body).includes(SECRET), "请求体无密钥");

  // --- 刷新恢复：新建 core（同 store）状态一致 + 同请求 duplicate（账本标记防重） ---
  const refreshed = createAtlasServerCore({ store, fetchFn: makeFetch([() => openAiResponse(GOOD_DRAFT)]).fetchFn, now: () => NOW });
  const stateAfter = await refreshed.handle("GET", "/state/chat-a");
  assert.equal(stateAfter.body.data.currentTime, 430.07, "刷新恢复：游标一致");
  assert.equal(stateAfter.body.data.currentLocationId, "4104", "刷新恢复：位置一致");
  const duplicate = await refreshed.handle("POST", "/turns/commit", commitRequest(world, "chat-a"));
  assert.equal(duplicate.body.data.receipt.status, "duplicate", "刷新后同请求幂等 duplicate（账本标记）");
  const stateAfterDuplicate = await refreshed.handle("GET", "/state/chat-a");
  assert.equal(stateAfterDuplicate.body.data.currentTime, 430.07, "duplicate 零推进（时间不变）");

  // --- 失败 → retry 成功（原幂等键） ---
  const failing = commitRequest(world, "chat-a", { turnId: "turn-b", userMessageId: "msg-14", assistantMessageId: "msg-15", userText: "second", assistantText: "second" });
  const failed = await core.handle("POST", "/turns/commit", failing);
  assert.equal(failed.body.error.code, "API_AUTH_FAILED", "失败分类：401 → API_AUTH_FAILED");
  assert.ok(failed.body.error.retryable === true || failed.body.error.retryable === undefined, "401 不可重试也保留 pending 语义");
  const retry = await core.handle("POST", "/turns/retry", {
    chatId: "chat-a",
    userMessageId: "msg-14",
    assistantMessageId: "msg-15",
  });
  assert.equal(retry.status, 200, "retry 200");
  assert.equal(retry.body.data.receipt.status, "committed", "retry 成功 committed");
  assert.equal(retry.body.data.receipt.currentTime, 442.07, "retry 沿原游标推进");

  // --- swipe：回退 → 变体同级重提交（时间不累计） ---
  const rolled = await core.handle("POST", "/turns/rollback", { chatId: "chat-a", assistantMessageId: "msg-15" });
  assert.equal(rolled.status, 200, "swipe 回退 200");
  const stateAfterRollback = await core.handle("GET", "/state/chat-a");
  assert.equal(stateAfterRollback.body.data.currentTime, 430.07, "回退到回合 B 之前（430.07）");
  const variant = commitRequest(world, "chat-a", { turnId: "turn-b2", userMessageId: "msg-14", assistantMessageId: "msg-15", swipeId: "swipe-2", userText: "second", assistantText: "second" });
  const variantCommit = await core.handle("POST", "/turns/commit", variant);
  assert.equal(variantCommit.body.data.receipt.status, "committed", "变体 committed（非 duplicate）");
  assert.equal(variantCommit.body.data.receipt.currentTime, 442.07, "同级结果：时间不累计（442.07 而非 454.07）");

  // --- 多聊天隔离 ---
  const stateB = await core.handle("GET", "/state/chat-b");
  assert.equal(stateB.body.data.currentTime, CURRENT_TIME, "chat-b 游标不受 chat-a 推进影响");
  assert.equal(stateB.body.data.currentLocationId, "4103", "chat-b 位置独立");

  // --- 日志脱敏 ---
  const logSerialized = JSON.stringify(core.logs());
  assert.ok(!logSerialized.includes(SECRET), "日志无明文 Key");
  assert.ok(!logSerialized.includes("mock.example.invalid"), "日志无 endpoint");
});
