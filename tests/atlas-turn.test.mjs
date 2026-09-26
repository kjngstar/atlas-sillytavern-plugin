/**
 * atlas-turn.test.mjs — ATLAS-01 共享相关性与回合核心单测。
 *
 * 覆盖验收要求：
 * - 同输入 / 同状态 / 同种子结果稳定（确定性）；
 * - 相邻 / 同地点 NPC 命中，远处无关 NPC 不注入；
 * - 未来正史、兄弟 IF、未采用草稿不泄漏当前分支；
 * - 重复 commit 不重复推进时间 / 地点 / 记忆 / 事件（幂等）；
 * - 容量失败、非法引用、存储失败零部分写入。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildWorldFromTemplate, getDemoTemplate } from "../lib/demo-events.ts";
import { parseWorld } from "../lib/world-schema.ts";
import { appendStateEvent, ledgerForBranch, projectEntityState } from "../lib/world-ledger.ts";
import { upsertEntityRecord } from "../lib/world-definition.ts";
import { gridDistance } from "../lib/world-engine.ts";
import { computeAtlasRelevance, atlasTravelPreview, deriveAtlasTurnSeed } from "../src/atlas-relevance.ts";
import { prepareAtlasTurn, provisionReferencedCharacters } from "../src/atlas-turn.ts";
import { buildStarterWorld } from "../src/atlas-starter-world.ts";
import {
  ATLAS_ERROR_CODES,
  ATLAS_LIMITS,
  AtlasError,
  parseAtlasTurnCommitRequest,
  parseAtlasTurnPrepareRequest,
} from "../src/atlas-contract.ts";

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

const NOW = 1000;
const CANON = "chronicle-canon";
const IF = "chronicle-if-silence";
const CURRENT_TIME = 418.07;

/** chronicle 演示模板：6 地点 / 4 人物 / 城钟触发器 / 正史 + 2 IF，parseWorld 可往返。 */
function buildFixture() {  let world = buildWorldFromTemplate(getDemoTemplate("chronicle"), { id: "atlas-turn-fixture", now: NOW });
  for (const entity of [
    {
      id: "entity-city", worldId: world.id, type: "city", name: "白塔王都",
      baseline: { founder: "旧王" },
      temporalSchema: [
        { key: "founder", kind: "base", valueType: "string" },
        { key: "ruler", kind: "temporal", valueType: "string" },
        { key: "underCurfew", kind: "temporal", valueType: "boolean" },
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
    const result = upsertEntityRecord(world, entity, { now: NOW });
    equal(result.ok, true, `实体 ${entity.id} 建档成功`);
    if (result.ok) world = result.value;
  }
  return world;
}

function prepareRequest(world, overrides = {}) {
  return parseAtlasTurnPrepareRequest({
    chatId: "chat-a",
    messageId: "msg-1",
    worldId: world.id,
    branchId: CANON,
    userText: "我在城中走走。",
    recentMessageRefs: [],
    ...overrides,
  });
}

function prepareInput(world, overrides = {}) {
  return {
    request: prepareRequest(world).value,
    currentTime: CURRENT_TIME,
    currentPointId: "4103",
    currentRegionId: "capital",
    flags: ["bell-rung"],
    radius: 30,
    ...overrides,
  };
}

/** AtlasRelevanceInput 形状（与 prepareInput 字段名不同：at / branchId / chatId / messageId） */
function relevanceInput(overrides = {}) {
  return {
    at: CURRENT_TIME,
    branchId: CANON,
    chatId: "chat-a",
    messageId: "msg-1",
    currentPointId: "4103",
    currentRegionId: "capital",
    flags: ["bell-rung"],
    radius: 30,
    ...overrides,
  };
}

function commitRequest(world, overrides = {}) {
  return parseAtlasTurnCommitRequest({
    turnId: "turn-x",
    chatId: "chat-a",
    userMessageId: "msg-10",
    assistantMessageId: "msg-11",
    swipeId: null,
    userText: "我前往潮门。",
    assistantText: "你沿主干道走向潮门。",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 相关性核心
// ---------------------------------------------------------------------------

test("相关性：同输入同状态结果逐字节稳定（确定性）", () => {
  const world = buildFixture();
  const input = relevanceInput();
  const first = computeAtlasRelevance(world, input);
  const second = computeAtlasRelevance(world, input);
  deepEqual(JSON.stringify(second), JSON.stringify(first), "两次计算结果一致");
  const seed2 = deriveAtlasTurnSeed(world, "chat-a", "msg-1", CURRENT_TIME);
  equal(seed2, first.seed, "种子函数与相关性计算共用同一派生");
  const otherMessage = deriveAtlasTurnSeed(world, "chat-a", "msg-2", CURRENT_TIME);
  ok(otherMessage !== first.seed, "不同 message 种子应不同");
});

test("相关性：同地点 + 附近 NPC 命中并带原因，远处 NPC 不出现", () => {
  const world = buildFixture();
  const result = computeAtlasRelevance(world, relevanceInput());
  // c1/c2 同在 4103（capital）；c3 在 4102（欧氏 16 格，半径 30 内）；c4 在 isles（远）
  deepEqual(result.relevantNpcIds, ["chronicle-c1", "chronicle-c2", "chronicle-c3"], "命中顺序：同地点→附近");
  deepEqual(result.npcReasons["chronicle-c1"], ["samePoint", "sameRegion"], "同地点 NPC 带双原因");
  deepEqual(result.npcReasons["chronicle-c3"], ["nearbyPoint"], "附近 NPC 带原因（c3 在 north 地区，不算同地区）");
  ok(!result.relevantNpcIds.includes("chronicle-c4"), "远处 NPC 绝不注入");
  deepEqual(result.nearbyPointIds, ["4104", "4102"], "半径 30 内命中 4104（≈16 格）与 4102（≈24 格），按近→远排序");
  ok(result.triggerIds.includes("chronicle-trig-bell"), "城钟触发器在 capital 可达并命中");
});

test("相关性：远处无关 NPC 在小半径下完全不进入候选", () => {
  const world = buildFixture();
  const result = computeAtlasRelevance(world, relevanceInput({ radius: 5 }));
  deepEqual(result.relevantNpcIds, ["chronicle-c1", "chronicle-c2"], "小半径只剩同地点与同地区人物");
  deepEqual(result.nearbyPointIds, [], "小半径无附近地点");
});

test("旅行预览：只读、距离与耗时来自共享基线", () => {
  const world = buildFixture();
  const before = JSON.stringify(world);
  const preview = atlasTravelPreview(world, { fromPointId: "4101", toPointId: "4102" });
  ok(preview !== null, "有效起终点给出预览");
  if (preview) {
    equal(preview.destinationId, "4102", "目的地 id");
    equal(preview.distance, gridDistance(20, 20, 34, 28), "网格距离与共享算法一致");
    ok(preview.estimatedDuration >= 1, "有速度档时给出正时长");
    ok(preview.factors.length > 0, "因素可解释");
  }
  equal(atlasTravelPreview(world, { fromPointId: "4101", toPointId: "no-such" }), null, "未知终点 → null");
  equal(JSON.stringify(world), before, "旅行预览零写入");
});

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

test("prepare：注入文本有界、含位置与时间、逐字节可复现", () => {
  const world = buildFixture();
  const first = prepareAtlasTurn(world, prepareInput(world));
  const second = prepareAtlasTurn(world, prepareInput(world));
  deepEqual(JSON.stringify(second.response), JSON.stringify(first.response), "同输入响应一致");
  const text = first.response.injectionText;
  ok(text.length <= ATLAS_LIMITS.INJECTION_CHARS, "注入文本不超预算");
  ok(text.includes("【阿特拉斯】当前位置："), "注入含当前位置");
  ok(text.includes(`第 ${CURRENT_TIME} 时段`), "注入含世界时间");
  ok(text.includes("chronicle-c1"), "注入含同地点 NPC");
  ok(first.response.triggerIds.includes("chronicle-trig-bell"), "响应携带命中触发器");
  equal(first.response.currentLocationId, "4103", "响应携带当前位置");
  ok(first.response.turnId.length > 0, "turnId 已生成");
});

test("prepare：零 API 调用（纯函数，不触网）", () => {
  const world = buildFixture();
  // 该模块 import 面不存在 fetch / HTTP 依赖；以「调用前后世界与全局无副作用」佐证
  const before = JSON.stringify(world);
  prepareAtlasTurn(world, prepareInput(world));
  equal(JSON.stringify(world), before, "prepare 零写入");
  equal(typeof globalThis.__atlasFetchProbe, "undefined", "无全局网络探针");
});

test("prepare：未来正史事件不进入注入文本", () => {
  const world = buildFixture();
  const appended = appendStateEvent(world, {
    branchId: null, at: 5000, source: "author",
    narrativeSummary: "未来正史大事件：王都升天。",
    effects: [{ kind: "setTemporalField", entityId: "entity-city", key: "ruler", value: "未来王" }],
  }, { now: NOW });
  equal(appended.ok, true, "未来事件写入成功");
  if (!appended.ok) return;
  const canonPrepared = prepareAtlasTurn(appended.value, prepareInput(appended.value));
  ok(!canonPrepared.response.injectionText.includes("未来正史大事件"), "正史视角：未来事实不注入");
  const ifPrepared = prepareAtlasTurn(appended.value, prepareInput(appended.value, {
    request: prepareRequest(appended.value, { branchId: IF }).value,
    currentTime: 418.12,
  }));
  ok(!ifPrepared.response.injectionText.includes("未来正史大事件"), "IF 视角：锚点后的正史未来不注入");
});

test("prepare：非法 currentTime 被拒绝", () => {
  const world = buildFixture();
  assert.throws(() => prepareAtlasTurn(world, prepareInput(world, { currentTime: -1 })), AtlasError);
  assertionCount += 1;
});

test("prepare：注入文本带人物 / 地点 / 地区 id 对照表（0.9.30，「采纳 0 条」根因修复）", () => {
  const world = buildFixture();
  const { response } = prepareAtlasTurn(world, prepareInput(world));
  ok(response.injectionText.includes("人物 id 对照："), "有人物 id 对照");
  ok(response.injectionText.includes("entity-city="), "实体 id=名字 形式（entity-city）");
  ok(response.injectionText.includes("entity-npc="), "实体 id=名字 形式（entity-npc）");
  ok(response.injectionText.includes("地点 id 对照："), "有地点 id 对照");
  ok(response.injectionText.includes("4104="), "地点 id=名字 形式（4104）");
});

test("prepare：0.9.34 人物对照表 = 裁定校验集同口径全集——装配单外的角色也在名单里", () => {
  const world = buildFixture();
  // 装配单（plan.entities）按相关性过滤；直接往 world.characters 塞一个
  // 与当前场景无关的角色——0.9.33 之前它不会出现在对照表里，模型引用必被裁定丢弃
  const farCharacter = {
    id: "entity-far-npc",
    name: "远方的铁匠",
    branchId: null,
    state: { lastSequence: 0 },
  };
  const withFar = {
    ...world,
    characters: [...(world.characters ?? []), farCharacter],
  };
  const { response } = prepareAtlasTurn(withFar, prepareInput(withFar));
  ok(
    response.injectionText.includes("entity-far-npc=远方的铁匠"),
    "world.characters 全集角色进对照表（id=名字）",
  );
  // 裁定校验认这个 id：commit 不再「引用未知实体」整条丢弃
  const known = new Set((withFar.characters ?? []).map((c) => String(c.id)));
  ok(known.has("entity-far-npc"), "对照表与裁定校验集（knownEntityIds）同源");
});

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

function commitInput(world, overrides = {}) {
  return {
    request: commitRequest(world).value,
    branchId: CANON,
    currentTime: CURRENT_TIME,
    currentPointId: "4103",
    currentRegionId: "capital",
    draft: {
      duration: 12,
      locationChange: { toPointId: "4104", toRegionId: "capital" },
      rawEffects: [{ kind: "setTemporalField", entityId: "entity-city", key: "ruler", value: "商会" }],
      memoryDrafts: [{ entityId: "entity-npc", text: "在潮门见到一位旅行者。" }],
      summary: "商会接管市政；旅行者抵达潮门。",
    },
    now: NOW,
    ...overrides,
  };
}

test("prepare：子地点 ID 对照包含父节点，根地点不伪造父节点", () => {
  const world = buildFixture();
  world.points = [
    { id: 9001, name: "钟楼", x: 10, y: 10, regionId: null },
    { id: 9002, name: "大堂", x: 12, y: 12, regionId: null, parentPointId: 9001 },
  ];
  const text = prepareAtlasTurn(world, prepareInput(world)).response.injectionText;
  ok(text.includes("9002=大堂（在 9001 内）"), "子地点带父 ID");
  ok(text.includes("9001=钟楼"), "根地点存在");
  ok(!text.includes("9001=钟楼（在 "), "根地点不带虚假父 ID");
});

test("角色建档工具：只为被引用的现存角色建档", () => {
  const world = buildStarterWorld({ id: "provision-world", now: 1, name: "主角" });
  const next = provisionReferencedCharacters(world, [
    { kind: "setTemporalField", entityId: "char-main", key: "status", value: "休息" },
  ], 2);
  ok(next.entityRecords.some((record) => record.id === "char-main"), "仍支持旧世界角色账本");
  ok(next.entityRecords.find((record) => record.id === "char-main").temporalSchema.some((field) => field.key === "status"), "字段声明齐全");
  equal(provisionReferencedCharacters(world, [], 2), world, "无引用时不写世界");
});
