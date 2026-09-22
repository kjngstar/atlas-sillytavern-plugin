/**
 * atlas-r05-turn-v2.test.mjs — R05 推进协议 v2 契约 + 同轮临时引用回归测试。
 *
 * 对应《修复计划》验收矩阵：
 * - L07 / §5.3 首场戏示例：新地点 + 新 NPC + 场景锚定 + NPC 更新**单次提交**全落地（D04 修复）；
 * - T07：v1 草稿喂给 v2 解析器 → 明确版本错误（服务端分流在 v1 解析之前）；
 * - baseRevision 过期回显拒绝；证据引文包含校验；重复临时引用；
 * - 未知引用拒绝（零写入）；T01 同键重试幂等（duplicate receipt，不重复建点）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(resolve(root, p)).href);
const { buildStarterWorld } = await imp("src/atlas-starter-world.ts");
const { parseAtlasWorldTurnDraftV2 } = await imp("src/atlas-contract-v2.ts");
const { applyAtlasV2Turn } = await imp("src/atlas-turn-v2.ts");
const { parseAtlasWorldTurnDraft } = await imp("src/atlas-api-client.ts");
const { AtlasError } = await imp("src/atlas-contract.ts");
const { resolveAtlasRuntimeView } = await imp("src/atlas-runtime-view.ts");

const ASSISTANT_TEXT = "你推开藤蔓，走进废墟深处。一个未具名少女站在阴影里，警戒地盯着你。";
const SOURCES = { "msg:u": "我走进废墟。", "msg:a": ASSISTANT_TEXT };

/** 计划 §5.3 首场戏示例：new:loc:ruins + new:npc:girl + scene + npcUpdate 单次提交 */
function firstSceneDraft(overrides = {}) {
  return {
    schemaVersion: 2,
    baseRevision: 0,
    duration: 1,
    evidence: [{ id: "ev1", sourceId: "msg:a", quote: "废墟深处" }],
    discoveries: {
      locations: [{ ref: "new:loc:ruins", name: "废墟深处", aliases: [], regionRef: null, parentLocationRef: null, evidenceIds: ["ev1"] }],
      characters: [{ ref: "new:npc:girl", displayName: "未具名少女", aliases: [], description: "阴影里的少女", evidenceIds: ["ev1"] }],
    },
    scene: { resolution: "confirmed", locationRef: "new:loc:ruins", transition: "arrive", evidenceIds: ["ev1"] },
    identityUpdates: [],
    npcUpdates: [
      { entityRef: "new:npc:girl", location: { op: "set", locationRef: "new:loc:ruins" }, presence: "present", status: "警戒", evidenceIds: ["ev1"] },
    ],
    relationUpdates: [],
    memories: [{ entityRef: "new:npc:girl", text: "少女第一次见到旅人", evidenceIds: ["ev1"] }],
    worldFlags: [{ key: "met_mysterious_girl", value: "true", evidenceIds: ["ev1"] }],
    events: [{ summary: "旅人抵达废墟深处", entityRefs: ["new:npc:girl"], evidenceIds: ["ev1"] }],
    mapScaleHints: [],
    summary: "首场戏：抵达废墟，遭遇少女",
    ...overrides,
  };
}

function makeRequest(overrides = {}) {
  return {
    turnId: "turn-r05",
    chatId: "r05-chat",
    userMessageId: "u1",
    assistantMessageId: "a1",
    swipeId: null,
    userText: "我走进废墟。",
    assistantText: ASSISTANT_TEXT,
    ...overrides,
  };
}

function baseWorld() {
  return buildStarterWorld({ id: "r05-world", now: 1, name: "R05 场景" });
}

// ---------------------------------------------------------------------------
// 解析器（语法校验）
// ---------------------------------------------------------------------------

test("R05 解析器：首场戏示例全字段合法（baseRevision 回显 / 证据包含通过）", () => {
  const result = parseAtlasWorldTurnDraftV2(JSON.stringify(firstSceneDraft()), { baseRevision: 0, sources: SOURCES });
  assert.equal(result.ok, true, `应解析通过：${JSON.stringify(result.ok ? {} : result.errors)}`);
  assert.equal(result.ok && result.draft.scene.locationRef, "new:loc:ruins");
  assert.equal(result.ok && result.draft.npcUpdates[0].status, "警戒");
});

test("R05 解析器：baseRevision 过期回显拒绝（T07 家族）", () => {
  const result = parseAtlasWorldTurnDraftV2(JSON.stringify(firstSceneDraft()), { baseRevision: 7, sources: SOURCES });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.baseRevision"), "错误必须指向 $.baseRevision");
});

test("R05 解析器：证据引文不是来源原文片段 → 包含校验失败", () => {
  const draft = firstSceneDraft({ evidence: [{ id: "ev1", sourceId: "msg:a", quote: "这句原文里根本没有" }] });
  const result = parseAtlasWorldTurnDraftV2(JSON.stringify(draft), { baseRevision: 0, sources: SOURCES });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.evidence[0].quote" && e.message.includes("包含校验失败")));
});

test("R05 解析器：sourceId 不存在 → 明确报错", () => {
  const draft = firstSceneDraft({ evidence: [{ id: "ev1", sourceId: "msg:ghost", quote: "x" }] });
  const result = parseAtlasWorldTurnDraftV2(JSON.stringify(draft), { baseRevision: 0, sources: SOURCES });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.message.includes("来源不存在")));
});

test("R05 解析器：临时引用重复 → 拒绝", () => {
  const draft = firstSceneDraft();
  draft.discoveries.locations.push({ ref: "new:loc:ruins", name: "重复废墟", aliases: [], regionRef: null, parentLocationRef: null, evidenceIds: ["ev1"] });
  const result = parseAtlasWorldTurnDraftV2(JSON.stringify(draft), { baseRevision: 0, sources: SOURCES });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.message.includes("临时引用重复")));
});

test("R05 解析器：顶层字段缺省 = 错误，不是缺省（npcUpdates 缺失）", () => {
  const draft = firstSceneDraft();
  delete draft.npcUpdates;
  const result = parseAtlasWorldTurnDraftV2(JSON.stringify(draft), { baseRevision: 0, sources: SOURCES });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.npcUpdates"));
});

test("R05 解析器：npcUpdates op=set 无 locationRef / op=keep 带 locationRef → 拒绝", () => {
  const bad1 = firstSceneDraft();
  bad1.npcUpdates[0].location = { op: "set", locationRef: null };
  const bad2 = firstSceneDraft();
  bad2.npcUpdates[0].location = { op: "keep", locationRef: "1" };
  for (const draft of [bad1, bad2]) {
    const result = parseAtlasWorldTurnDraftV2(JSON.stringify(draft), { baseRevision: 0, sources: SOURCES });
    assert.equal(result.ok, false, `op=${draft.npcUpdates[0].location.op} 应被拒绝`);
    assert.ok(result.errors.some((e) => e.path.startsWith("$.npcUpdates[0].location")));
  }
});

test("T07：v1 草稿喂给 v2 解析器 → 明确版本错误（分流在服务端 v1 解析之前）", () => {
  const v1 = { duration: 1, npcChanges: [], memoryDrafts: [], summary: "v1 输出" };
  const result = parseAtlasWorldTurnDraftV2(JSON.stringify(v1), { baseRevision: 0, sources: SOURCES });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.schemaVersion" && e.message.includes("缺少 schemaVersion")));
});

// ---------------------------------------------------------------------------
// 应用管线（引用解析 + 候选世界 + commitAtlasTurn 复用）
// ---------------------------------------------------------------------------

test("L07 / D04：新地点 + 新 NPC + 场景锚定 + NPC 更新单次提交全落地", () => {
  const world = baseWorld();
  const request = makeRequest();
  const parsed = parseAtlasWorldTurnDraftV2(JSON.stringify(firstSceneDraft()), { baseRevision: 0, sources: SOURCES });
  assert.equal(parsed.ok, true);
  const output = applyAtlasV2Turn(world, {
    draft: parsed.draft,
    request,
    branchId: null,
    currentTime: 0,
    currentPointId: "1",
    currentRegionId: "start",
    now: 2,
  });

  assert.equal(output.receipt.status, "committed", `应提交成功：${output.receipt.summary}`);
  assert.equal(output.createdPointIds.length, 1, "新建 1 个地点");
  assert.equal(output.createdEntityIds.length, 1, "新建 1 个人物");

  // 临时引用 → 持久 ID 分配
  const pointId = output.refResolution.locations.find((l) => l.ref === "new:loc:ruins").pointId;
  const girlId = output.refResolution.characters.find((c) => c.ref === "new:npc:girl").entityId;
  assert.ok(output.refResolution.locations[0].created, "ruins 标记为新建");
  assert.match(girlId, /^npc-[0-9a-f]{8}$/, "人物 id 为 npc-<hash8> 形态");

  // 地点真实入库（顺延数字 id，regionRef null → 不归属）
  const point = (output.world.points ?? []).find((p) => p.id === pointId);
  assert.ok(point, "新地点在 world.points");
  assert.equal(point.name, "废墟深处");
  assert.equal(point.regionId ?? null, null);

  // 人物同时进 characters 与 entityRecords（npc，预声明 status 时态字段）
  const character = (output.world.characters ?? []).find((c) => c.id === girlId);
  assert.ok(character, "新人物在 world.characters");
  assert.equal(character.name, "未具名少女");
  const record = (output.world.entityRecords ?? []).find((e) => e.id === girlId);
  assert.ok(record, "新人物在 world.entityRecords");
  assert.equal(record.type, "npc");
  assert.ok(record.temporalSchema.some((f) => f.key === "status" && f.valueType === "string"), "status 字段已声明");

  // D04 核心断言：场景与 NPC 移动引用同轮新建地点 → 提交后位置为该点
  assert.equal(output.receipt.currentLocationId, String(pointId), "场景锚定游标指向新地点");
  const view = resolveAtlasRuntimeView(output.world, { branchId: null, at: output.receipt.currentTime });
  const girl = view.npcs.find((n) => n.id === girlId);
  assert.ok(girl, "少女在统一视图中可见");
  assert.equal(String(girl.pointId), String(pointId), "少女位置 = 同轮新建的废墟深处（旧基线：引用被裁定丢弃）");
  assert.equal(girl.status, "警戒", "状态已写入");

  // 记忆 / 旗标 / 事件摘要
  const memory = (output.world.stateEvents ?? []).flatMap((e) => e.effects).find((f) => f.kind === "appendMemoryRef" && f.entityId === girlId);
  assert.ok(memory, "记忆已入账本");
  assert.equal(memory.text, "少女第一次见到旅人");
  const flag = (output.world.stateEvents ?? []).flatMap((e) => e.effects).find((f) => f.kind === "setFlag");
  assert.ok(flag && flag.key === "met_mysterious_girl", "旗标已入账本");
  assert.ok(output.receipt.summary.includes("旅人抵达废墟深处"), "事件明细并入回执摘要");
});

test("R05：未知地点引用（非已知 id 且未声明 new:loc）→ 报错零写入", () => {
  const world = baseWorld();
  const draft = firstSceneDraft();
  draft.scene.locationRef = "999";
  const parsed = parseAtlasWorldTurnDraftV2(JSON.stringify(draft), { baseRevision: 0, sources: SOURCES });
  assert.equal(parsed.ok, true, "语法层放行（语义校验在应用层）");
  assert.throws(
    () => applyAtlasV2Turn(world, { draft: parsed.draft, request: makeRequest(), branchId: null, currentTime: 0, currentPointId: "1", currentRegionId: "start", now: 2 }),
    (err) => err instanceof AtlasError && err.message.includes("引用未知地点"),
    "应用层必须拒绝未知地点引用",
  );
  assert.equal((world.points ?? []).length, (baseWorld().points ?? []).length, "原世界零写入");
});

test("R05：未知地区 regionRef → 拒绝", () => {
  const draft = firstSceneDraft();
  draft.discoveries.locations[0].regionRef = "region-ghost";
  const parsed = parseAtlasWorldTurnDraftV2(JSON.stringify(draft), { baseRevision: 0, sources: SOURCES });
  assert.equal(parsed.ok, true);
  assert.throws(
    () => applyAtlasV2Turn(baseWorld(), { draft: parsed.draft, request: makeRequest(), branchId: null, currentTime: 0, currentPointId: "1", currentRegionId: "start", now: 2 }),
    (err) => err.message.includes("引用未知地区"),
  );
});

test("T01：同键重试幂等——duplicate receipt，不重复建点建人", () => {
  const world = baseWorld();
  const request = makeRequest();
  const parsed = parseAtlasWorldTurnDraftV2(JSON.stringify(firstSceneDraft()), { baseRevision: 0, sources: SOURCES });
  assert.equal(parsed.ok, true);
  const first = applyAtlasV2Turn(world, { draft: parsed.draft, request, branchId: null, currentTime: 0, currentPointId: "1", currentRegionId: "start", now: 2 });
  assert.equal(first.receipt.status, "committed");

  const second = applyAtlasV2Turn(first.world, { draft: parsed.draft, request, branchId: null, currentTime: first.receipt.currentTime, currentPointId: first.receipt.currentLocationId ?? "1", currentRegionId: "start", now: 3 });
  assert.equal(second.receipt.status, "duplicate", "同键重试返回 duplicate");
  assert.equal((second.world.points ?? []).length, (first.world.points ?? []).length, "不重复建点");
  assert.equal((second.world.characters ?? []).length, (first.world.characters ?? []).length, "不重复建人");
});

test("R05：duration=0 合法（初始 / 对账回合），时间游标不推进", () => {
  const draft = firstSceneDraft({ duration: 0 });
  const parsed = parseAtlasWorldTurnDraftV2(JSON.stringify(draft), { baseRevision: 0, sources: SOURCES });
  assert.equal(parsed.ok, true);
  const output = applyAtlasV2Turn(baseWorld(), { draft: parsed.draft, request: makeRequest(), branchId: null, currentTime: 5, currentPointId: "1", currentRegionId: "start", now: 2 });
  assert.equal(output.receipt.status, "committed");
  assert.equal(output.receipt.currentTime, 5, "零时长回合不推进时间");
});

test("R05：已知实体按原 ID 引用（char-main 移动 + 状态）同管线可用", () => {
  const draft = firstSceneDraft();
  draft.discoveries.locations = [];
  draft.discoveries.characters = [];
  draft.scene.locationRef = "1";
  draft.npcUpdates = [
    { entityRef: "char-main", location: { op: "keep", locationRef: null }, presence: "present", status: "休整中", evidenceIds: ["ev1"] },
  ];
  draft.memories = [];
  draft.events = [];
  const parsed = parseAtlasWorldTurnDraftV2(JSON.stringify(draft), { baseRevision: 0, sources: SOURCES });
  assert.equal(parsed.ok, true);
  const output = applyAtlasV2Turn(baseWorld(), { draft: parsed.draft, request: makeRequest(), branchId: null, currentTime: 0, currentPointId: "1", currentRegionId: "start", now: 2 });
  assert.equal(output.receipt.status, "committed");
  const view = resolveAtlasRuntimeView(output.world, { branchId: null, at: output.receipt.currentTime });
  const main = view.npcs.find((n) => n.id === "char-main");
  assert.equal(main.status, "休整中", "已知实体状态更新走同一管线");
  assert.equal(output.refResolution.warnings.length, 0, "无身份消歧警告（未涉及 identityUpdates）");
});
