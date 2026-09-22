/**
 * atlas-r06-scene.test.mjs — R06 首次定位、开场识别与起点占位迁移回归测试。
 *
 * 对应《修复计划》R06 验收：
 * - 占位指纹：生成来源 + 结构指纹双确认才认定系统占位；用户真正创建名叫「起点」
 *   的地点（多编辑证据）原样保留；
 * - retired 迁移：定义修订审计 + sidecar 记录，重复运行幂等；
 * - 开场识别（mode=bootstrap，duration=0）：preview 不写世界；apply 一次 v2 提交、
 *   时间游标不动、占位自动退役、lastConfirmed 落档；
 * - v2 封套：$B 替换、协议设置切换、作者自定义预设不被覆盖；
 * - /state scene 块：未知与 lastConfirmed 分开。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(resolve(root, p)).href);
const { buildStarterWorld } = await imp("src/atlas-starter-world.ts");
const { detectStartPlaceholder, retireStartPlaceholder, sanitizeSceneDoc, emptySceneDoc, resolveSceneStatus, sceneDocKey } = await imp("src/atlas-scene.ts");
const { DEFAULT_PROMPT_SEGMENTS_V2, substitutePromptPlaceholders } = await imp("src/atlas-api-client.ts");
const { createAtlasServerCore, createMemoryDocumentStore } = await imp("src/atlas-server.ts");

const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// 占位指纹
// ---------------------------------------------------------------------------

test("R06 指纹：全新起始世界 → 系统占位成立", () => {
  const info = detectStartPlaceholder(buildStarterWorld({ id: "w1", now: 1, name: "测试卡" }));
  assert.equal(info.isPlaceholder, true);
  assert.equal(info.pointId, "1");
  assert.equal(info.regionId, "start");
  assert.deepEqual(info.reasons, []);
});

test("R06 指纹：用户创建且真正名叫「起点」的地点 → 不是占位（名字不是唯一依据）", () => {
  const world = buildStarterWorld({ id: "w2", now: 1, name: "测试卡" });
  world.points.push({ id: 2, name: "起点", x: 12, y: 34, regionId: "start" });
  const info = detectStartPlaceholder(world);
  assert.equal(info.isPlaceholder, false, "两个地点 → 指纹破裂");
  assert.ok(info.reasons.some((r) => r.includes("地点数")), "阻止原因必须列出");
});

test("R06 指纹：用户编辑过占位（坐标改动）→ 不是占位", () => {
  const world = buildStarterWorld({ id: "w3", now: 1, name: "测试卡" });
  world.points[0].x = 51;
  assert.equal(detectStartPlaceholder(world).isPlaceholder, false);
});

test("R06 指纹：推演发生（账本事件）或定义修订过 → 不是占位", () => {
  const played = buildStarterWorld({ id: "w4", now: 1, name: "测试卡" });
  played.stateEvents = [{ id: "e1", worldId: played.id, branchId: null, at: 1, sequence: 0, source: "author", narrativeSummary: "x", entityRefs: [], effects: [] }];
  assert.equal(detectStartPlaceholder(played).isPlaceholder, false, "有账本事件");
  const revised = buildStarterWorld({ id: "w5", now: 1, name: "测试卡" });
  revised.definitionRevisions = [{ id: "r1", worldId: revised.id, createdAt: 1, authorNote: "用户改过" }];
  assert.equal(detectStartPlaceholder(revised).isPlaceholder, false, "有定义修订");
});

test("R06 指纹：只改名字的世界（唯一地点仍叫起点但换了坐标等）→ 不是占位", () => {
  // 名字匹配单独不足：结构指纹其余项也必须吻合
  const world = buildStarterWorld({ id: "w6", now: 1, name: "测试卡" });
  world.characters.push({ id: "npc-1", worldId: world.id, name: "少女", role: "配角", description: "", currentRegionId: "start" });
  assert.equal(detectStartPlaceholder(world).isPlaceholder, false, "多了一个人物");
});

// ---------------------------------------------------------------------------
// retired 迁移
// ---------------------------------------------------------------------------

test("R06 retired：修订审计 + sidecar 记录；重复运行幂等", () => {
  const world = buildStarterWorld({ id: "w7", now: 1, name: "测试卡" });
  const doc = emptySceneDoc();
  const first = retireStartPlaceholder(world, doc, { now: 5 });
  assert.equal(first.changed, true);
  assert.deepEqual(first.doc.retiredPointIds, ["1"]);
  assert.equal((first.world.definitionRevisions ?? []).length, 1, "定义修订留痕");
  const second = retireStartPlaceholder(first.world, first.doc, { now: 6 });
  assert.equal(second.changed, false, "重复运行幂等");
  assert.equal((second.world.definitionRevisions ?? []).length, 1, "不重复加修订");
});

test("R06 retired：非占位世界调用 → 零改动", () => {
  const world = buildStarterWorld({ id: "w8", now: 1, name: "测试卡" });
  world.points.push({ id: 2, name: "客栈", x: 20, y: 20, regionId: "start" });
  const result = retireStartPlaceholder(world, emptySceneDoc(), { now: 5 });
  assert.equal(result.changed, false);
  assert.deepEqual(result.doc.retiredPointIds, []);
});

// ---------------------------------------------------------------------------
// 场景状态（未知 vs lastConfirmed 分开）
// ---------------------------------------------------------------------------

test("R06 场景状态：未知 ≠ 无上次确认；resolveSceneStatus 两者分开表达", () => {
  const world = buildStarterWorld({ id: "w9", now: 1, name: "测试卡" });
  world.points.push({ id: 2, name: "废墟深处", x: 70, y: 50, regionId: "start" });
  const doc = { ...emptySceneDoc(), lastConfirmed: { branchId: null, pointId: "2", at: 9 } };
  const status = resolveSceneStatus(world, doc, null);
  assert.equal(status.known, false, "当前游标未知");
  assert.equal(status.lastConfirmed?.pointId, "2", "上次确认仍可表达");
  assert.equal(status.lastConfirmed?.pointName, "废墟深处");
  const known = resolveSceneStatus(world, doc, "2");
  assert.equal(known.known, true);
});

// ---------------------------------------------------------------------------
// v2 封套与占位符
// ---------------------------------------------------------------------------

test("R06 v2 封套：schemaVersion/baseRevision 模板 + $B 替换为世界游标", () => {
  const contract = DEFAULT_PROMPT_SEGMENTS_V2[0].content;
  assert.ok(contract.includes('"schemaVersion":2'), "契约含 schemaVersion 2 模板");
  assert.ok(contract.includes("baseRevision"), "契约要求 baseRevision 回显");
  assert.ok(contract.includes("new:loc:"), "契约说明临时引用");
  const out = substitutePromptPlaceholders("baseRevision=$B，回显 $B 一次即可", { injectionText: "", userText: "", assistantText: "", baseRevision: 42 });
  assert.ok(out.includes("baseRevision=42"), `$B 应替换为 42：${out}`);
  assert.equal(DEFAULT_PROMPT_SEGMENTS_V2.length, 6, "v2 封套 6 段（契约 + 世界状态 + 背景 + 连续性 + 行动 + 核对）");
});

// ---------------------------------------------------------------------------
// 服务端开场识别（bootstrap preview / apply）
// ---------------------------------------------------------------------------

const GREETING = "你推开藤蔓，走进废墟深处。一个未具名少女站在阴影里，警戒地盯着你。";
const BOOTSTRAP_DRAFT = {
  schemaVersion: 2,
  baseRevision: 0,
  duration: 0,
  evidence: [{ id: "ev1", sourceId: "msg:a", quote: "废墟深处" }],
  discoveries: {
    locations: [{ ref: "new:loc:ruins", name: "废墟深处", aliases: [], regionRef: null, parentLocationRef: null, evidenceIds: ["ev1"] }],
    characters: [{ ref: "new:npc:girl", displayName: "未具名少女", aliases: [], description: "阴影里的少女", evidenceIds: ["ev1"] }],
  },
  scene: { resolution: "confirmed", locationRef: "new:loc:ruins", transition: "initial", evidenceIds: ["ev1"] },
  identityUpdates: [],
  npcUpdates: [{ entityRef: "new:npc:girl", location: { op: "set", locationRef: "new:loc:ruins" }, presence: "present", status: "警戒", evidenceIds: ["ev1"] }],
  relationUpdates: [],
  memories: [],
  worldFlags: [],
  events: [],
  mapScaleHints: [],
  summary: "开场：玩家抵达废墟深处，遭遇警戒的少女。",
};

function jsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

async function bootstrapSetup(responseDraft) {
  const store = createMemoryDocumentStore();
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return jsonResponse(200, { choices: [{ message: { content: JSON.stringify(responseDraft) } }] });
  };
  const rawCore = createAtlasServerCore({ store, fetchFn, now: () => NOW });
  // 0.9.42 会话承载：/worlds/import、/bindings、/state 走会话层，必须挂 carrier（与插件测试同款）
  const { createSessionCarrier, carrierAsCore } = await imp("tests/atlas-session-helper.mjs");
  const carrier = createSessionCarrier(rawCore);
  const core = carrierAsCore(carrier);
  const world = buildStarterWorld({ id: "w-boot", now: 1, name: "测试卡" });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", {
    action: "bind",
    binding: {
      schemaVersion: 1,
      enabled: true,
      chatId: "chat-boot",
      characterId: null,
      worldId: world.id,
      branchId: null,
      currentLocationId: "1",
      worldTimeCursor: 0,
      lastCommittedMessageId: null,
      lastCheckpointId: null,
    },
  });
  await core.handle("PUT", "/settings", {
    action: "api.save",
    preset: { name: "mock", endpoint: "https://mock.example.invalid/v1", model: "atlas-mock", maxTokens: 1024, temperature: 0.7, topP: 0.95, timeoutMs: 5000 },
    apiKeyMode: "replace",
    apiKey: "sk-test",
  }, { local: true });
  // api.activate 用生成 id；从视图找回真实 id 再激活
  const view = await core.handle("GET", "/settings", null, { local: true });
  const apiId = view.body?.data?.apiPresets?.[0]?.id;
  if (apiId) await core.handle("PUT", "/settings", { action: "api.activate", id: apiId }, { local: true });
  return { store, core, calls, world, carrier };
}

test("R06 bootstrap 预览：解析 v2 草稿返回预览，零写入世界", async () => {
  const { core, calls, carrier } = await bootstrapSetup(BOOTSTRAP_DRAFT);
  const pointsBefore = (carrier.session.world?.points ?? []).length;
  const result = await core.handle("POST", "/scene/bootstrap", { chatId: "chat-boot", apply: false, assistantText: GREETING }, { local: true });
  assert.equal(result.status, 200, `应成功：${JSON.stringify(result.body?.error ?? {})}`);
  assert.equal(result.body.data.status, "preview");
  assert.equal(result.body.data.callCount, 1, "明确调用次数 = 1");
  assert.equal(result.body.data.scene.locationRef, "new:loc:ruins");
  assert.equal(result.body.data.newLocations[0].name, "废墟深处");
  assert.equal(result.body.data.newCharacters[0].displayName, "未具名少女");
  assert.equal(calls.length, 1, "恰好 1 条推演请求");
  assert.equal((carrier.session.world?.points ?? []).length, pointsBefore, "预览不写世界");
  // 请求应使用 v2 封套（$B 替换 + bootstrap 任务段）
  const requestBody = calls[0].body;
  const messageText = JSON.stringify(requestBody);
  assert.ok(messageText.includes("mode=bootstrap"), "请求含开场识别任务段");
  assert.ok(messageText.includes("schemaVersion"), "请求使用 v2 契约段");
  assert.ok(!messageText.includes("$B"), "$B 应已替换（不再有裸占位符）");
});

test("R06 bootstrap 应用：duration=0 时间不动、场景锚定、占位退役、lastConfirmed 落档", async () => {
  const { core, store, calls, carrier } = await bootstrapSetup(BOOTSTRAP_DRAFT);
  const result = await core.handle("POST", "/scene/bootstrap", { chatId: "chat-boot", apply: true, assistantText: GREETING }, { local: true });
  assert.equal(result.status, 200, `应成功：${JSON.stringify(result.body?.error ?? {})}`);
  assert.equal(result.body.data.status, "committed", `receipt.status=${result.body.data?.receipt?.status}`);
  assert.equal(result.body.data.placeholderRetired, true, "起始占位自动退役");

  const world = carrier.session.world;
  const sceneDoc = sanitizeSceneDoc(await store.read(sceneDocKey("w-boot")));
  assert.deepEqual(sceneDoc.retiredPointIds, ["1"], "占位 retired 记录");
  assert.equal(sceneDoc.lastConfirmed?.pointId, result.body.data.receipt.currentLocationId, "lastConfirmed 落档");
  assert.equal(sceneDoc.bootstrap?.attempts, 1, "bootstrap 簿记 1 次");
  assert.equal(result.body.data.receipt.currentTime, 0, "duration=0：时间游标不动");

  assert.equal(carrier.session.binding.currentLocationId, result.body.data.receipt.currentLocationId, "绑定游标随场景锚定");

  // 新地点/人物已入库（同轮临时引用 → 持久 ID）
  assert.equal((world.points ?? []).length, 2, "废墟深处已建点");
  const girlRecord = (world.entityRecords ?? []).find((e) => e.name === "未具名少女");
  assert.ok(girlRecord, "少女已建档");
  // 重复 apply → duplicate（幂等键一致），不再建点
  const again = await core.handle("POST", "/scene/bootstrap", { chatId: "chat-boot", apply: true, assistantText: GREETING }, { local: true });
  assert.equal(again.body.data.status, "duplicate", "同键重试 = duplicate");
  assert.equal((carrier.session.world?.points ?? []).length, 2, "不重复建点");
  assert.equal(calls.length, 2, "每次调用各 1 条请求（预览/应用各算一次）");
});

test("R06 bootstrap：无有效证据时诚实未知（unknown 场景 → 零地点写入）", async () => {
  const unknownDraft = {
    ...JSON.parse(JSON.stringify(BOOTSTRAP_DRAFT)),
    scene: { resolution: "unknown", locationRef: null, transition: "unknown", evidenceIds: [] },
    evidence: [],
    discoveries: { locations: [], characters: [] },
    npcUpdates: [],
    summary: "开场只有氛围描写，无法确认具体地点。",
  };
  const { core, store, carrier } = await bootstrapSetup(unknownDraft);
  const result = await core.handle("POST", "/scene/bootstrap", { chatId: "chat-boot", apply: true, assistantText: "风声呜咽。（只有氛围，无地点）" }, { local: true });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.status, "committed");
  assert.equal((carrier.session.world?.points ?? []).length, 1, "无证据 → 不造地点");
  const sceneDoc = sanitizeSceneDoc(await store.read(sceneDocKey("w-boot")));
  assert.equal(sceneDoc.lastConfirmed, null, "无锚点不写 lastConfirmed");
  // 占位未退役（识别未成功定位）
  assert.deepEqual(sceneDoc.retiredPointIds, []);
});

test("R06 /state：scene 块分开表达未知 / lastConfirmed，retired 点从地图点列过滤", async () => {
  const { core, store } = await bootstrapSetup(BOOTSTRAP_DRAFT);
  await core.handle("POST", "/scene/bootstrap", { chatId: "chat-boot", apply: true, assistantText: GREETING }, { local: true });
  const state = await core.handle("POST", "/state", { chatId: "chat-boot" }, { local: true });
  assert.equal(state.status, 200);
  const scene = state.body.data.scene;
  assert.equal(scene.known, true, "场景已锚定");
  assert.equal(scene.placeholder.retired, true, "占位已退役");
  assert.ok(scene.lastConfirmed?.pointId, "lastConfirmed 存在");
  const mapPointIds = state.body.data.map.points.map((p) => p.id);
  assert.ok(!mapPointIds.includes("1"), "retired 占位点不再进地图点列");
  assert.equal(mapPointIds.length, 1, "只展示真实地点（废墟深处）");
});

test("R06 协议设置：v1 逃生门生效（runtime.update + 设置往返）", async () => {
  const { core } = await bootstrapSetup(BOOTSTRAP_DRAFT);
  const view = await core.handle("GET", "/settings", null, { local: true });
  assert.equal(view.body.data.worldTurnProtocol, "v2", "缺省 v2");
  assert.equal(view.body.data.builtInPrompt.segments.length, 6, "内置默认展示 v2 封套");
  const updated = await core.handle("PUT", "/settings", { action: "runtime.update", worldTurnProtocol: "v1" }, { local: true });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.worldTurnProtocol, "v1");
  const updated2 = await core.handle("GET", "/settings", null, { local: true });
  assert.equal(updated2.body.data.worldTurnProtocol, "v1");
  const bad = await core.handle("PUT", "/settings", { action: "runtime.update", worldTurnProtocol: "v9" }, { local: true });
  assert.equal(bad.status, 400, "非法协议拒绝");
});
