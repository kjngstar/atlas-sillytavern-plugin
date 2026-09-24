/**
 * atlas-stability.test.mjs — 0.9.48 稳定性修复包（外部 AI 计划 T01/T04/T05/T07 落地）。
 *
 * - T01 会话写回守卫：atlasSessionWriteGuard 纯函数全分支（发 → 切 → 回的竞态不串档）。
 * - T04 去重与检查点解耦：检查点耗尽（200 上限）后 commit 仍写回合记录，幂等依然有效。
 * - T05 解析失败语义：最终解析失败 = 明确失败（RESPONSE_MALFORMED），游标不推进、
 *   回合记录不写、世界不变；重试走重新推演。
 * - T07 设置权限闸：GET /settings 与 PUT 同一道 local 门（远程匿名 403）；
 *   本机视图带 hasApiKey / apiKeyLast4（0.9.12 明文回填语义保留给本机会话）。
 *
 * 测试纪律（外部计划 §2/§15）：断言模型调用数、世界版本、游标与记录存在性，
 * 不用「HTTP 200」当行为证据；不通过源码字符串断言证明异步隔离。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

import { atlasSessionWriteGuard, createEmptyAtlasSession, isValidAtlasSession, writeAtlasSession } from "../index.js";
import { buildWorldFromTemplate, getDemoTemplate } from "../lib/demo-events.ts";
import { parseWorld } from "../lib/world-schema.ts";
import { upsertEntityRecord } from "../lib/world-definition.ts";
import { createCheckpoint } from "../lib/world-checkpoint.ts";
import { createAtlasServerCore, createMemoryDocumentStore } from "../src/atlas-server.ts";
import { ATLAS_ERROR_CODES } from "../src/atlas-contract.ts";
import { createSessionCarrier, carrierAsCore } from "./atlas-session-helper.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// 样板（与 atlas-server-plugin.test.mjs 同口径的最小夹具）
// ---------------------------------------------------------------------------

function jsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function makeFetch(scripts) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const script = scripts[Math.min(calls.length - 1, scripts.length - 1)];
    return script();
  };
  return { fetchFn, calls };
}

/**
 * E11（等效改写）：原夹具是 v1 世界草稿（`duration:0 / npcChanges:[] …`），
 * 现在唯一模型输出契约是 `table-delta-v1`：一个 `<atlasEdit>` 块，块内每行独立 JSON。
 * 本文件的用例只关心「提交成功 / 幂等 / 失败零写入 / 检查点」，与三表内容无关，
 * 因此用**显式无变化行** `{"kind":"noop"}` 表达同一语义：本轮没有实体改动，但回合照常提交。
 */
const GOOD_EDIT = [
  "<atlasEdit>",
  '{"kind":"noop"}',
  "</atlasEdit>",
].join("\n");

function openAiResponse(text) {
  return jsonResponse(200, { choices: [{ message: { content: text } }] });
}

function worldFixture(id = "world-stab-1") {
  let world = buildWorldFromTemplate(getDemoTemplate("chronicle"), { id, now: 1000 });
  // 补一个带 temporalSchema 的 NPC 供草稿引用（与 server-plugin 夹具同口径）
  const entity = {
    id: "entity-npc", worldId: world.id, type: "npc", name: "薇尔·星环",
    baseline: { origin: "北境" },
    temporalSchema: [
      { key: "origin", kind: "base", valueType: "string" },
      { key: "whereabouts", kind: "temporal", valueType: "string" },
    ],
  };
  const result = upsertEntityRecord(world, entity, { now: 1000 });
  assert.ok(result.ok, "实体建档成功");
  if (result.ok) world = result.value;
  const parsed = parseWorld(JSON.parse(JSON.stringify(world)));
  assert.ok(parsed !== null, "夹具世界可解析");
  return parsed;
}

function binding(world) {
  return {
    schemaVersion: 1,
    enabled: true,
    chatId: "chat-a",
    characterId: null,
    worldId: world.id,
    branchId: "chronicle-canon",
    currentLocationId: "4103",
    worldTimeCursor: 418.07,
    lastCommittedMessageId: null,
    lastCheckpointId: null,
  };
}

function commitRequest(world, overrides = {}) {
  return {
    turnId: "turn-x",
    chatId: "chat-a",
    userMessageId: "msg-10",
    assistantMessageId: "msg-11",
    swipeId: null,
    userText: "我看看四周。",
    assistantText: "四周很平静。",
    ...overrides,
  };
}

function presetFixture() {
  return {
    name: "模拟推演",
    endpoint: "https://mock.example.invalid/v1",
    model: "atlas-mock",
    apiKey: "sk-stability-test-key-9876",
    timeoutMs: 5000,
  };
}

async function setup(fetchScripts, overrides = {}) {
  const store = createMemoryDocumentStore();
  const world = worldFixture();
  const fetcher = makeFetch(fetchScripts ?? []);
  const rawCore = createAtlasServerCore({
    store,
    fetchFn: fetcher.fetchFn,
    now: () => NOW,
    ...overrides,
  });
  const carrier = createSessionCarrier(rawCore);
  const core = carrierAsCore(carrier);
  const importResult = await core.handle("POST", "/worlds/import", { world }, { local: true });
  assert.equal(importResult.status, 200, "世界导入成功");
  const bindResult = await core.handle("POST", "/bindings", { action: "bind", binding: binding(world) }, { local: true });
  assert.equal(bindResult.status, 200, "绑定成功");
  const settingsResult = await core.handle("PUT", "/settings", { worldTurn: presetFixture() }, { local: true });
  assert.equal(settingsResult.status, 200, "推演预设配置成功");
  /**
   * E01（0.9.59）：推进协议已收口——读取归一化与写入都只认 `table-delta-v1`，
   * 想切回 v1/v2 的写请求会被明确拒绝。因此这里**不再**声明旧协议：
   * 用例夹具本身已换成 `<atlasEdit>` 行增量块（见 GOOD_EDIT）。
   */
  return { store, core, world, fetcher, carrier };
}

// ---------------------------------------------------------------------------
// T01 会话写回守卫（纯函数全分支）
// ---------------------------------------------------------------------------

test("T01 守卫：发起 = 当前 + 会话归属一致 → 放行", () => {
  assert.equal(atlasSessionWriteGuard("chat-a", "chat-a", "chat-a"), true);
});

test("T01 守卫：发起 = 当前、会话归属未知（null）→ 放行（保守判定）", () => {
  assert.equal(atlasSessionWriteGuard("chat-a", "chat-a", null), true);
});

test("T01 守卫：发起 ≠ 当前（A 等待期间切到 B）→ 拒绝", () => {
  assert.equal(atlasSessionWriteGuard("chat-a", "chat-b", "chat-a"), false, "A 的响应不能写进 B");
});

test("T01 守卫：A→B→A 后旧响应到达（当前又变回 A 但归属是别的聊天）→ 拒绝", () => {
  // 会话归属 chat-b 的文档绝不能因为「当前恰好是 chat-a」而落进 chat-a
  assert.equal(atlasSessionWriteGuard("chat-b", "chat-a", "chat-b"), false);
});

test("T01 守卫：会话归属 ≠ 当前聊天 → 拒绝（防止跨聊天文档污染）", () => {
  assert.equal(atlasSessionWriteGuard("chat-a", "chat-a", "chat-b"), false);
});

test("T01 守卫：当前聊天身份缺失（切换瞬间 metadata 尚未就位）→ 拒绝", () => {
  assert.equal(atlasSessionWriteGuard("chat-a", null, "chat-a"), false);
  assert.equal(atlasSessionWriteGuard("chat-a", undefined, "chat-a"), false);
  assert.equal(atlasSessionWriteGuard("chat-a", "", "chat-a"), false);
});

// ---------------------------------------------------------------------------
// A07 会话写回：三表随同一份 chatMetadata 落盘 + 写失败明确报错
// ---------------------------------------------------------------------------

/** 假酒馆上下文：记录 saveMetadata 次数，可注入失败。 */
function fakeContext(options = {}) {
  const ctx = {
    chatMetadata: options.chatMetadata === undefined ? {} : options.chatMetadata,
    saveCalls: 0,
    async saveMetadata() {
      ctx.saveCalls += 1;
      if (options.saveFails) throw new Error("存档失败（磁盘满）");
    },
  };
  return { ctx, get: () => ctx };
}

test("A07 空会话含 tables 字段，且旧会话（无 tables）仍被判定合法", () => {
  const empty = createEmptyAtlasSession();
  assert.equal(empty.tables, null);
  assert.equal(empty.schemaVersion, 1);
  const legacy = { schemaVersion: 1, rev: 2, binding: null, world: { id: "w1" }, maps: null, scene: null, turns: {}, geoAuto: {} };
  assert.equal(isValidAtlasSession(legacy), true, "未迁移聊天必须继续可用");
});

test("A07 写回：三表与其余会话字段一次落盘，只调一次 saveMetadata", async () => {
  const { ctx, get } = fakeContext();
  const session = {
    ...createEmptyAtlasSession(),
    rev: 5,
    world: { id: "w1" },
    binding: { chatId: "c1", worldId: "w1" },
    tables: {
      schemaVersion: 1, worldId: "w1",
      branches: { canon: { locations: [{ id: "loc:1", name: "钟楼" }], characters: [], items: [] } },
    },
  };
  assert.equal(await writeAtlasSession(get, session), true);
  assert.equal(ctx.saveCalls, 1, "只触发一次存档");
  assert.equal(ctx.chatMetadata.atlas.tables.branches.canon.locations[0].name, "钟楼");
  assert.equal(ctx.chatMetadata.atlas.binding.chatId, "c1", "三表与绑定在同一份会话里");
});

test("A07 写回失败必须抛错，不静默假装成功", async () => {
  const noMetadata = fakeContext({ chatMetadata: null });
  await assert.rejects(() => writeAtlasSession(noMetadata.get, createEmptyAtlasSession()), /chatMetadata/);

  const saveFails = fakeContext({ saveFails: true });
  await assert.rejects(() => writeAtlasSession(saveFails.get, createEmptyAtlasSession()), /存档失败/);

  const badShape = fakeContext();
  await assert.rejects(() => writeAtlasSession(badShape.get, { schemaVersion: 99 }), /会话形状非法/);
  await assert.rejects(() => writeAtlasSession(badShape.get, null), /会话形状非法/);
  assert.equal(badShape.ctx.chatMetadata.atlas, undefined, "被拒的写入不得留下半截文档");
});

// ---------------------------------------------------------------------------
// T04 去重与检查点解耦
// ---------------------------------------------------------------------------

test("T04：检查点耗尽（200 上限）后 commit 成功、回合记录仍写入（checkpointId=null）", async () => {
  const { core, world, store, fetcher, carrier } = await setup([() => openAiResponse(GOOD_EDIT)]);
  // 用真实 createCheckpoint 塞满 200 个（parseWorld 校验通过）→ 下一次创建失败 → checkpointId = null
  let exhausted = JSON.parse(JSON.stringify(world));
  for (let i = 0; i < 200; i += 1) {
    const created = createCheckpoint(exhausted, { branchId: "chronicle-canon", at: 418.07, kind: "technical", reason: `filler-${i}`, now: NOW });
    assert.ok(created.ok, `检查点 ${i} 创建成功`);
    exhausted = created.value;
  }
  const reImport = await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(exhausted)) }, { local: true });
  assert.equal(reImport.status, 200, "耗尽世界重新导入");

  const result = await core.handle("POST", "/turns/commit", commitRequest(world));
  assert.equal(result.status, 200, "commit 成功");
  assert.equal(result.body.data.receipt.status, "committed", "committed 回执");
  assert.equal(fetcher.calls.length, 1, "恰好 1 条模型请求");

  // 回合记录必须存在（0.9.47 及之前：if (checkpointId) 才写 → 幂等在耗尽后失效）；
  // 0.9.42 会话承载：turn: 文档住在会话 doc.turns 里（跨请求 / 跨重启幂等）
  const turnKey = "turn:chat-a:chat-a::msg-10::msg-11::";
  const turnDoc = carrier.session.turns[turnKey];
  assert.ok(turnDoc, "无检查点也写了回合记录");
  assert.equal(turnDoc.checkpointId, null, "记录如实标记无回退点");
  assert.ok(turnDoc.receipt, "回执随记录持久化");
});

test("T04：检查点耗尽后重复 commit 仍幂等（0 新模型调用，duplicate 回执）", async () => {
  const { core, world, fetcher } = await setup([() => openAiResponse(GOOD_EDIT)]);
  let exhausted = JSON.parse(JSON.stringify(world));
  for (let i = 0; i < 200; i += 1) {
    const created = createCheckpoint(exhausted, { branchId: "chronicle-canon", at: 418.07, kind: "technical", reason: `filler-${i}`, now: NOW });
    assert.ok(created.ok, `检查点 ${i} 创建成功`);
    exhausted = created.value;
  }
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(exhausted)) }, { local: true });

  const first = await core.handle("POST", "/turns/commit", commitRequest(world));
  assert.equal(first.body.data.receipt.status, "committed");
  const again = await core.handle("POST", "/turns/commit", commitRequest(world));
  assert.equal(again.body.data.receipt.status, "duplicate", "重复事件 = duplicate");
  assert.equal(fetcher.calls.length, 1, "重复提交零新增模型调用（不重复计费）");
});

// ---------------------------------------------------------------------------
// T05 解析失败 = 明确失败
// ---------------------------------------------------------------------------

test("T05：纯 prose（无 JSON、无 think）→ RESPONSE_MALFORMED 失败，游标不推进、回合不落记录", async () => {
  const { core, world, store, fetcher, carrier } = await setup([
    () => jsonResponse(200, { choices: [{ message: { content: "这不是 JSON，只是普通叙述文本。" } }] }),
    () => openAiResponse(GOOD_EDIT),
  ]);
  const result = await core.handle("POST", "/turns/commit", commitRequest(world));
  assert.equal(result.status, 502, "解析失败 = 502 错误信封（RESPONSE_MALFORMED 语义）");
  assert.equal(result.body.ok, false, "提交失败");
  assert.equal(result.body.error.code, ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "解析失败错误码");
  assert.equal(result.body.error.details.retryable, true, "标记可重试（重推演）");

  // 世界与游标零变化：重复提交必须重新推演（幂等键未被占用）
  assert.equal(fetcher.calls.length, 1, "失败前恰好 1 条模型请求");
  const turnDoc = carrier.session.turns["turn:chat-a:chat-a::msg-10::msg-11::"];
  assert.equal(turnDoc, undefined, "失败回合不写记录（可重试）");
  const retryResult = await core.handle("POST", "/turns/commit", commitRequest(world));
  assert.equal(retryResult.body.data.receipt.status, "committed", "重试可成功");
  assert.equal(fetcher.calls.length, 2, "重试重新调用模型（同幂等键未锁定）");
});

test("T05：think 内合法行增量块仍然救回（0.9.30 有限格式修复保留）", async () => {
  const { core, world, fetcher } = await setup([
    () => jsonResponse(200, { choices: [{ message: { content: `<think>推理推理推理</think>${GOOD_EDIT}` } }] }),
  ]);
  const result = await core.handle("POST", "/turns/commit", commitRequest(world));
  assert.equal(result.body.data.receipt.status, "committed", "think 剥除后照常提交");
  assert.equal(fetcher.calls.length, 1);
});

// ---------------------------------------------------------------------------
// T07 设置权限闸与视图
// ---------------------------------------------------------------------------

test("T07：GET /settings 无 local 身份 → 403（远程匿名读不到配置与密钥）", async () => {
  const { core } = await setup(null);
  const result = await core.handle("GET", "/settings", null, {});
  assert.equal(result.status, 403, "匿名 403");
  assert.equal(result.body.error.code, ATLAS_ERROR_CODES.FORBIDDEN);
});

test("T07：GET /settings local=true → 200，视图带 hasApiKey / apiKeyLast4，明文仅本机会话可见", async () => {
  const { core } = await setup(null);
  const result = await core.handle("GET", "/settings", null, { local: true });
  assert.equal(result.status, 200);
  const view = result.body.data;
  const activePreset = view.apiPresets.find((p) => p.id === view.activeApiPresetId);
  assert.ok(activePreset, "视图含激活连接");
  assert.equal(activePreset.hasApiKey, true, "hasApiKey=true");
  assert.equal(activePreset.apiKeyLast4, "9876", "尾号正确");
  assert.equal(activePreset.apiKey, "sk-stability-test-key-9876", "本机会话明文回填（0.9.12 语义，local 闸保护）");
});

test("T07：清空密钥后 hasApiKey=false、尾号空串", async () => {
  const { core } = await setup(null);
  const before = (await core.handle("GET", "/settings", null, { local: true })).body.data;
  const preset = before.apiPresets.find((p) => p.id === before.activeApiPresetId);
  const save = await core.handle("PUT", "/settings", { action: "api.save", preset, apiKeyMode: "clear", apiKey: "" }, { local: true });
  assert.equal(save.status, 200, "清除成功");
  const after = save.body.data;
  const cleared = after.apiPresets.find((p) => p.id === preset.id);
  assert.equal(cleared.hasApiKey, false, "hasApiKey=false");
  assert.equal(cleared.apiKeyLast4, "", "尾号清空");
  assert.equal(cleared.apiKey, "", "明文清空");
});
