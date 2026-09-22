/**
 * atlas-r07-identity.test.mjs — R07 人物持续跟踪与身份消歧回归测试。
 *
 * 对应《修复计划》R07 验收：
 * - 临时称呼按精确名字 / 别名解析（唯一才合并，歧义拒绝）；临时称呼不是临时身份；
 * - identityUpdates 更新已知实体 displayName / aliases（不重建实体）+ 定义修订审计；
 * - 「离开了房间」→ presence=left 落账（目的地未知可 clear）；「没有提到」保持上次状态；
 * - 同行关系与同地点分开：玩家移动不让熟人自动跟随；
 * - 同名不同人物不误合并（ambiguous → 整单拒绝零写入）；
 * - failed / duplicate 返回原世界（零写入收口）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(resolve(root, p)).href);
// R06 起新世界是空地理；这些用例需要一个已存在的地理基线（旧存档形状）
const { legacyStartWorld } = await imp("tests/atlas-legacy-start-world.mjs");
const { parseAtlasWorldTurnDraftV2 } = await imp("src/atlas-contract-v2.ts");
const { applyAtlasV2Turn } = await imp("src/atlas-turn-v2.ts");
const { resolveEntityByRef, applyIdentityUpdates, mergeAliases } = await imp("src/atlas-identity.ts");
const { resolveAtlasRuntimeView } = await imp("src/atlas-runtime-view.ts");
const { AtlasError } = await imp("src/atlas-contract.ts");

const SOURCES = { "msg:u": "我继续行动。", "msg:a": "少女仍在这里。" };

function makeRequest(overrides = {}) {
  return {
    turnId: "turn-r07",
    chatId: "r07-chat",
    userMessageId: "u1",
    assistantMessageId: "a1",
    swipeId: null,
    userText: "我继续行动。",
    assistantText: "少女仍在这里。",
    ...overrides,
  };
}

function worldWithGirl() {
  // 首轮：少女建档于地点 1
  const world = legacyStartWorld({ id: "r07-world", now: 1, name: "R07" });
  world.points.push({ id: 2, name: "废墟深处", x: 70, y: 50, regionId: "start" });
  return world;
}

async function commitFirstTurn(world) {
  const draft = {
    schemaVersion: 2,
    baseRevision: 0,
    duration: 1,
    evidence: [{ id: "ev1", sourceId: "msg:a", quote: "少女" }],
    discoveries: {
      locations: [{ ref: "new:loc:ruins", name: "废墟深处", aliases: [], regionRef: "start", parentLocationRef: null, evidenceIds: ["ev1"] }],
      characters: [{ ref: "new:npc:girl", displayName: "未具名少女", aliases: ["少女"], description: "阴影里的少女", evidenceIds: ["ev1"] }],
    },
    scene: { resolution: "confirmed", locationRef: "new:loc:ruins", transition: "arrive", evidenceIds: ["ev1"] },
    identityUpdates: [],
    npcUpdates: [{ entityRef: "new:npc:girl", location: { op: "set", locationRef: "new:loc:ruins" }, presence: "present", status: "警戒", evidenceIds: ["ev1"] }],
    relationUpdates: [],
    memories: [],
    worldFlags: [],
    events: [],
    mapScaleHints: [],
    summary: "首场戏。",
  };
  const parsed = parseAtlasWorldTurnDraftV2(JSON.stringify(draft), { baseRevision: 0, sources: SOURCES });
  assert.equal(parsed.ok, true);
  return applyAtlasV2Turn(world, { draft: parsed.draft, request: makeRequest(), branchId: null, currentTime: 0, currentPointId: "1", currentRegionId: "start", now: 2 });
}

// ---------------------------------------------------------------------------
// 名字 / 别名解析
// ---------------------------------------------------------------------------

test("R07 引用解析：精确 id / 唯一名 / 别名可解析", () => {
  const world = legacyStartWorld({ id: "r07-a", now: 1, name: "T" });
  world.characters.push({ id: "npc-g", worldId: world.id, name: "未具名少女", role: "配角", description: "", currentRegionId: "start", tags: ["少女"] });
  assert.equal(resolveEntityByRef(world, "npc-g").id, "npc-g", "精确 id");
  assert.equal(resolveEntityByRef(world, "未具名少女").id, "npc-g", "唯一 displayName");
  assert.equal(resolveEntityByRef(world, "少女").id, "npc-g", "别名");
  assert.equal(resolveEntityByRef(world, "路人甲").id, null, "未知称呼");
});

test("R07 同名不误合并：两个同名实体 → ambiguous，调用方拒绝", () => {
  const world = legacyStartWorld({ id: "r07-b", now: 1, name: "T" });
  world.characters.push(
    { id: "npc-g1", worldId: world.id, name: "少女", role: "配角", description: "", currentRegionId: "start" },
    { id: "npc-g2", worldId: world.id, name: "少女", role: "配角", description: "", currentRegionId: "start" },
  );
  const resolution = resolveEntityByRef(world, "少女");
  assert.equal(resolution.ambiguous, true, "歧义标记");
  assert.deepEqual([...resolution.candidates].sort(), ["npc-g1", "npc-g2"], "列出候选");
});

test("R07 应用层：歧义称呼 → 整单拒绝（零写入），唯一称呼 → 按名字解析 + 警告", async () => {
  // 首轮建立少女
  const base = await commitFirstTurn(worldWithGirl());
  assert.equal(base.receipt.status, "committed");
  const world = base.world;
  const girlId = base.createdEntityIds[0];

  // 下一轮用别名「少女」引用（非 ID）
  const draft2 = {
    schemaVersion: 2,
    baseRevision: 1,
    duration: 1,
    evidence: [{ id: "ev1", sourceId: "msg:a", quote: "少女" }],
    discoveries: { locations: [], characters: [] },
    scene: { resolution: "confirmed", locationRef: String(base.refResolution.locations[0].pointId), transition: "stay", evidenceIds: ["ev1"] },
    identityUpdates: [],
    npcUpdates: [{ entityRef: "少女", location: { op: "keep", locationRef: null }, presence: "unknown", status: "放松", evidenceIds: ["ev1"] }],
    relationUpdates: [],
    memories: [],
    worldFlags: [],
    events: [],
    mapScaleHints: [],
    summary: "少女放松下来。",
  };
  const parsed = parseAtlasWorldTurnDraftV2(JSON.stringify(draft2), { baseRevision: 1, sources: SOURCES });
  assert.equal(parsed.ok, true);
  const out = applyAtlasV2Turn(world, { draft: parsed.draft, request: makeRequest({ userMessageId: "u2", assistantMessageId: "a2", turnId: "turn-r07-2" }), branchId: null, currentTime: 1, currentPointId: String(base.refResolution.locations[0].pointId), currentRegionId: "start", now: 3 });
  assert.equal(out.receipt.status, "committed");
  assert.ok(out.refResolution.warnings.some((w) => w.includes("按名字解析")), "名字解析应有警告留痕");
  const view = resolveAtlasRuntimeView(out.world, { branchId: null, at: 2 });
  const girl = view.npcs.find((n) => n.id === girlId);
  assert.equal(girl.status, "放松", "别名引用的状态更新命中同一实体");

  // 同名歧义场景：再造一个「少女」别名实体 → 下一轮引用「少女」拒绝
  const world2 = base.world;
  world2.characters.push({ id: "npc-g2", worldId: world2.id, name: "另一位少女", role: "配角", description: "", currentRegionId: "start", tags: ["少女"] });
  const draft3 = JSON.parse(JSON.stringify(draft2));
  draft3.baseRevision = 2;
  draft3.npcUpdates[0].status = "警戒";
  const parsed3 = parseAtlasWorldTurnDraftV2(JSON.stringify(draft3), { baseRevision: 2, sources: SOURCES });
  assert.equal(parsed3.ok, true);
  assert.throws(
    () => applyAtlasV2Turn(world2, { draft: parsed3.draft, request: makeRequest({ userMessageId: "u3", assistantMessageId: "a3", turnId: "turn-r07-3" }), branchId: null, currentTime: 2, currentPointId: "1", currentRegionId: "start", now: 4 }),
    (err) => err instanceof AtlasError && err.message.includes("不强行合并"),
    "歧义称呼必须整单拒绝",
  );
});

// ---------------------------------------------------------------------------
// identityUpdates：已知实体改名 / 别名（不重建实体）
// ---------------------------------------------------------------------------

test("R07 identityUpdates：已知实体获得真名 → 名字更新 + 别名保留 + 定义修订审计", async () => {
  const base = await commitFirstTurn(worldWithGirl());
  const world = base.world;
  const girlId = base.createdEntityIds[0];
  const pointId = base.refResolution.locations[0].pointId;

  const draft2 = {
    schemaVersion: 2,
    baseRevision: 1,
    duration: 1,
    evidence: [{ id: "ev1", sourceId: "msg:a", quote: "少女" }],
    discoveries: { locations: [], characters: [] },
    scene: { resolution: "confirmed", locationRef: String(pointId), transition: "stay", evidenceIds: ["ev1"] },
    identityUpdates: [{ entityRef: girlId, displayName: "莉娅", addAliases: ["莉娅", "少女"], evidenceIds: ["ev1"] }],
    npcUpdates: [],
    relationUpdates: [],
    memories: [],
    worldFlags: [],
    events: [],
    mapScaleHints: [],
    summary: "少女报上真名：莉娅。",
  };
  const parsed = parseAtlasWorldTurnDraftV2(JSON.stringify(draft2), { baseRevision: 1, sources: SOURCES });
  assert.equal(parsed.ok, true);
  const out = applyAtlasV2Turn(world, { draft: parsed.draft, request: makeRequest({ userMessageId: "u2", assistantMessageId: "a2", turnId: "turn-r07-name" }), branchId: null, currentTime: 1, currentPointId: String(pointId), currentRegionId: "start", now: 3 });
  assert.equal(out.receipt.status, "committed");

  const character = (out.world.characters ?? []).find((c) => c.id === girlId);
  assert.equal(character.name, "莉娅", "displayName 已更新（不重建实体，id 不变）");
  assert.deepEqual(character.tags, ["少女", "莉娅"], "旧别名保留 + 新别名并入（有界去重）");
  const revisions = (out.world.definitionRevisions ?? []).filter((r) => (r.authorNote ?? "").includes("R07 身份更新"));
  assert.equal(revisions.length, 1, "定义修订审计留痕");

  // 下一轮用新名字引用仍命中同一实体
  assert.equal(resolveEntityByRef(out.world, "莉娅").id, girlId, "真名解析");
  assert.equal(resolveEntityByRef(out.world, "少女").id, girlId, "旧别名仍在");
});

test("R07 identityUpdates：无变化 → 不写修订也不炸", async () => {
  const world = legacyStartWorld({ id: "r07-c", now: 1, name: "T" });
  const result = applyIdentityUpdates(world, [{ entityId: "char-main", displayName: "", addAliases: [] }]);
  assert.equal(result.updatedIds.length, 0);
  assert.equal(result.world, world, "零变化返回原世界");
});

test("R07 mergeAliases：去重 + 封顶 16", () => {
  assert.deepEqual(mergeAliases(["a"], ["a", "b"]), ["a", "b"], "幂等去重");
  const many = Array.from({ length: 20 }, (_, i) => `名${i}`);
  assert.equal(mergeAliases([], many).length, 16, "封顶 16");
});

// ---------------------------------------------------------------------------
// presence 与「没有提到 = 保持」
// ---------------------------------------------------------------------------

test("R07 presence：clear（目的地未知）→ presence=left 落账；运行时视图可见", async () => {
  const base = await commitFirstTurn(worldWithGirl());
  const world = base.world;
  const girlId = base.createdEntityIds[0];
  const pointId = base.refResolution.locations[0].pointId;

  const draft2 = {
    schemaVersion: 2,
    baseRevision: 1,
    duration: 1,
    evidence: [{ id: "ev1", sourceId: "msg:a", quote: "少女" }],
    discoveries: { locations: [], characters: [] },
    scene: { resolution: "confirmed", locationRef: String(pointId), transition: "stay", evidenceIds: ["ev1"] },
    identityUpdates: [],
    npcUpdates: [{ entityRef: girlId, location: { op: "clear", locationRef: null }, presence: "left", status: null, evidenceIds: ["ev1"] }],
    relationUpdates: [],
    memories: [],
    worldFlags: [],
    events: [],
    mapScaleHints: [],
    summary: "少女离开了房间，去向不明。",
  };
  const parsed = parseAtlasWorldTurnDraftV2(JSON.stringify(draft2), { baseRevision: 1, sources: SOURCES });
  assert.equal(parsed.ok, true);
  const out = applyAtlasV2Turn(world, { draft: parsed.draft, request: makeRequest({ userMessageId: "u2", assistantMessageId: "a2", turnId: "turn-r07-left" }), branchId: null, currentTime: 1, currentPointId: String(pointId), currentRegionId: "start", now: 3 });
  assert.equal(out.receipt.status, "committed");

  const effects = (out.world.stateEvents ?? []).flatMap((e) => e.effects);
  const presenceEffect = effects.find((f) => f.kind === "setTemporalField" && f.key === "presence" && f.value === "left");
  assert.ok(presenceEffect, "presence=left 已落账");
  assert.equal(presenceEffect.value, "left");

  const view = resolveAtlasRuntimeView(out.world, { branchId: null, at: 2 });
  const girl = view.npcs.find((n) => n.id === girlId);
  assert.equal(girl.presence, "left", "运行时视图 presence=left");
  // clear 不写位置（账本无清位 effect）：位置保持旧值但 presence 明确离场
  assert.equal(String(girl.pointId), String(pointId), "位置不伪造（presence 表达离场）");
});

test("R07 没有提到 = 保持：下一轮不提少女，状态与位置原样；玩家移动她不跟随", async () => {
  const base = await commitFirstTurn(worldWithGirl());
  const world = base.world;
  const girlId = base.createdEntityIds[0];
  const ruinsId = base.refResolution.locations[0].pointId;

  // 玩家独自离开去新地点，完全不提少女
  const draft2 = {
    schemaVersion: 2,
    baseRevision: 1,
    duration: 1,
    evidence: [{ id: "ev1", sourceId: "msg:a", quote: "少女" }],
    discoveries: { locations: [{ ref: "new:loc:hall", name: "大厅", aliases: [], regionRef: "start", parentLocationRef: null, evidenceIds: ["ev1"] }], characters: [] },
    scene: { resolution: "confirmed", locationRef: "new:loc:hall", transition: "arrive", evidenceIds: ["ev1"] },
    identityUpdates: [],
    npcUpdates: [],
    relationUpdates: [],
    memories: [],
    worldFlags: [],
    events: [],
    mapScaleHints: [],
    summary: "玩家走进大厅。",
  };
  const parsed = parseAtlasWorldTurnDraftV2(JSON.stringify(draft2), { baseRevision: 1, sources: SOURCES });
  assert.equal(parsed.ok, true);
  const out = applyAtlasV2Turn(world, { draft: parsed.draft, request: makeRequest({ userMessageId: "u2", assistantMessageId: "a2", turnId: "turn-r07-stay" }), branchId: null, currentTime: 1, currentPointId: String(ruinsId), currentRegionId: "start", now: 3 });
  assert.equal(out.receipt.status, "committed");

  // 玩家游标 = 大厅
  assert.notEqual(out.receipt.currentLocationId, String(ruinsId), "玩家已到大厅");
  // 少女状态位置原样（不自动判离场、不跟随传送）
  const view = resolveAtlasRuntimeView(out.world, { branchId: null, at: 2 });
  const girl = view.npcs.find((n) => n.id === girlId);
  assert.equal(String(girl.pointId), String(ruinsId), "少女仍留在废墟深处（不随玩家传送）");
  assert.equal(girl.status, "警戒", "状态保持");
  assert.equal(girl.presence, "present", "presence 保持 present（未提到 ≠ 离场）");
});

// ---------------------------------------------------------------------------
// 零写入收口
// ---------------------------------------------------------------------------

test("R07 零写入收口：failed 回执返回原世界（候选增量不外泄）", async () => {
  const world = worldWithGirl();
  // 已知 npc 实体记录但 temporalSchema 未声明 status → 账本校验拒绝（整单 failed）
  world.characters = [
    ...(world.characters ?? []),
    { id: "npc-rigid", worldId: world.id, name: "石头人", role: "配角", description: "", currentRegionId: "start" },
  ];
  world.entityRecords = [
    ...(world.entityRecords ?? []),
    { id: "npc-rigid", worldId: world.id, type: "npc", name: "石头人", baseline: {}, temporalSchema: [] },
  ];
  const draft2 = {
    schemaVersion: 2,
    baseRevision: 0,
    duration: 1,
    evidence: [{ id: "ev1", sourceId: "msg:a", quote: "少女" }],
    discoveries: { locations: [], characters: [] },
    scene: { resolution: "unknown", locationRef: null, transition: "stay", evidenceIds: [] },
    identityUpdates: [],
    npcUpdates: [{ entityRef: "npc-rigid", location: { op: "keep", locationRef: null }, presence: "unknown", status: "任意状态", evidenceIds: ["ev1"] }],
    relationUpdates: [],
    memories: [],
    worldFlags: [],
    events: [],
    mapScaleHints: [],
    summary: "石头人状态更新（未声明 status 字段 → 账本拒绝）。",
  };
  const parsed = parseAtlasWorldTurnDraftV2(JSON.stringify(draft2), { baseRevision: 0, sources: SOURCES });
  assert.equal(parsed.ok, true);
  const pointsBefore = (world.points ?? []).length;
  const out = applyAtlasV2Turn(world, { draft: parsed.draft, request: makeRequest({ userMessageId: "u9", assistantMessageId: "a9", turnId: "turn-r07-fail" }), branchId: null, currentTime: 0, currentPointId: "1", currentRegionId: "start", now: 3 });
  assert.equal(out.receipt.status, "failed", `账本应拒绝未声明字段：${out.receipt.summary}`);
  assert.equal((out.world.points ?? []).length, pointsBefore, "failed 返回原世界（候选增量不外泄）");
});

test("R07 提示词：同行关系与内心纪律写入 v2 封套", async () => {
  const { DEFAULT_PROMPT_SEGMENTS_V2 } = await imp("src/atlas-api-client.ts");
  const contract = DEFAULT_PROMPT_SEGMENTS_V2.map((s) => s.content).join("\n");
  assert.ok(contract.includes("同行关系与同地点分开"), "同行 ≠ 传送");
  assert.ok(contract.includes("推断人物内心"), "不发明内心");
  assert.ok(contract.includes("「离开了房间」才写 left"), "离场语义");
});
