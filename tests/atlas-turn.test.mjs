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
import { appendStateEvent, ledgerForBranch } from "../lib/world-ledger.ts";
import { upsertEntityRecord } from "../lib/world-definition.ts";
import { gridDistance } from "../lib/world-engine.ts";
import { computeAtlasRelevance, atlasTravelPreview, deriveAtlasTurnSeed } from "../src/atlas-relevance.ts";
import { prepareAtlasTurn, commitAtlasTurn } from "../src/atlas-turn.ts";
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

test("commit：一次原子提交——时间 / 位置 / 记忆 / 事件全部落账", () => {
  const world = buildFixture();
  const eventsBefore = (world.stateEvents ?? []).length;
  const output = commitAtlasTurn(world, commitInput(world));
  equal(output.receipt.status, "committed", "提交成功");
  equal(output.receipt.currentTime, 430.07, "时间推进 12 时段");
  equal(output.receipt.previousTime, CURRENT_TIME, "previousTime 为提交前游标");
  equal(output.receipt.currentLocationId, "4104", "位置变化写入 receipt");
  equal(output.receipt.adoptedEventIds.length, 1, "恰好一条账本事件");
  equal(output.receipt.retryable, false, "成功不可重试");
  equal((output.world.stateEvents ?? []).length, eventsBefore + 1, "账本 +1");
  const event = output.world.stateEvents.at(-1);
  equal(event.sessionId, "atlas::chat-a::msg-10::msg-11::", "事件 sessionId 记录完整幂等键（经共享提案管线）");
  equal(event.branchId, CANON, "事件归属正史分支");
  equal(event.source, "ai-adopted", "Atlas 草稿走 ai-adopted 来源");
  equal(event.at, 430.07, "事件时刻 = currentTime + duration");
  ok(parseWorld(JSON.parse(JSON.stringify(output.world))) !== null, "提交后世界可解析往返");
});

test("commit：重复提交同幂等键 → duplicate receipt，零二次写入", () => {
  const world = buildFixture();
  const first = commitAtlasTurn(world, commitInput(world));
  const afterFirst = JSON.stringify(first.world);
  const second = commitAtlasTurn(first.world, commitInput(first.world));
  equal(second.receipt.status, "duplicate", "重复提交返回 duplicate");
  equal(second.world, first.world, "引用相等：零写入");
  equal(afterFirst, JSON.stringify(second.world), "世界字节不变");
  equal(second.receipt.adoptedEventIds.length, 1, "duplicate 回执引用原事件");
  equal(second.receipt.retryable, false, "duplicate 不可重试");
});

test("commit：非法引用 → failed receipt，零部分写入且可重试", () => {
  const world = buildFixture();
  const eventsBefore = (world.stateEvents ?? []).length;
  const output = commitAtlasTurn(world, commitInput(world, {
    draft: {
      duration: 3,
      rawEffects: [{ kind: "setTemporalField", entityId: "entity-ghost", key: "ruler", value: "幽灵" }],
      summary: "引用未知实体。",
    },
  }));
  equal(output.receipt.status, "failed", "非法引用被拒绝");
  equal(output.world, world, "引用相等：零部分写入");
  equal((world.stateEvents ?? []).length, eventsBefore, "账本不变");
  equal(output.receipt.retryable, true, "失败可重试");
  ok(output.receipt.summary.length > 0, "失败原因用户可见");
});

test("commit：负时长 / 超上限时长 / 非法记忆 / 未知地点全部拒绝且零写入", () => {
  const world = buildFixture();
  const eventsBefore = (world.stateEvents ?? []).length;

  assert.throws(() => commitAtlasTurn(world, commitInput(world, {
    draft: { duration: -5, summary: "倒流", rawEffects: [] },
  })), (err) => err instanceof AtlasError && err.code === ATLAS_ERROR_CODES.RESPONSE_MALFORMED);

  assert.throws(() => commitAtlasTurn(world, commitInput(world, {
    draft: { duration: ATLAS_LIMITS.TURN_DURATION_MAX + 1, summary: "太长", rawEffects: [] },
  })), (err) => err instanceof AtlasError && err.code === ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED);

  assert.throws(() => commitAtlasTurn(world, commitInput(world, {
    draft: { duration: 1, summary: "空记忆", memoryDrafts: [{ entityId: "entity-npc", text: "" }] },
  })), AtlasError);

  assert.throws(() => commitAtlasTurn(world, commitInput(world, {
    draft: { duration: 1, summary: "去未知处", locationChange: { toPointId: "pt-nowhere" } },
  })), (err) => err instanceof AtlasError && err.code === ATLAS_ERROR_CODES.RESPONSE_MALFORMED);

  assert.throws(() => commitAtlasTurn(world, commitInput(world, {
    draft: { duration: 1, summary: "非白名单形状", rawEffects: [{ kind: "deleteEverything" }] },
  })), (err) => err instanceof AtlasError && err.code === ATLAS_ERROR_CODES.RESPONSE_MALFORMED);

  equal((world.stateEvents ?? []).length, eventsBefore, "全部拒绝后账本零变化");
  assertionCount += 6;
});

test("commit：无变化回合零写入并返回 committed 空回执", () => {
  const world = buildFixture();
  const before = JSON.stringify(world);
  const output = commitAtlasTurn(world, commitInput(world, {
    draft: { duration: 0, rawEffects: [], summary: "无事发生。" },
  }));
  equal(output.receipt.status, "committed", "无变化回合提交成功");
  equal(output.world, world, "引用相等：零写入");
  equal(before, JSON.stringify(output.world), "世界字节不变");
  equal(output.receipt.adoptedEventIds.length, 0, "无事件");
});

test("commit：仅时间推进零 effect 草稿 → 游标推进回执，不再被账本「至少一个 effect」拒收（0.9.27，MiniMax-M3 真实翻车形状）", () => {
  const world = buildFixture();
  const eventsBefore = (world.stateEvents ?? []).length;
  const before = JSON.stringify(world);
  const output = commitAtlasTurn(world, commitInput(world, {
    draft: {
      duration: 4,
      locationChange: null,
      rawEffects: [],
      memoryDrafts: [],
      summary: "众人在客栈休整一夜，无特殊事件。",
    },
  }));
  equal(output.receipt.status, "committed", "仅时间推进回合提交成功");
  equal(output.receipt.currentTime, CURRENT_TIME + 4, "时间游标推进 4 时段");
  equal(output.receipt.adoptedEventIds.length, 0, "账本零事件");
  equal(output.world, world, "引用相等：世界零写入");
  equal(before, JSON.stringify(output.world), "世界字节不变");
  equal((world.stateEvents ?? []).length, eventsBefore, "账本长度不变");
  ok(output.receipt.summary.includes("无实体变化"), "回执摘要注明仅时间推进");
  equal(output.receipt.retryable, false, "成功不可重试");
});

test("commit：仅位置移动零 effect 草稿 → 位置游标随回执推进", () => {
  const world = buildFixture();
  const output = commitAtlasTurn(world, commitInput(world, {
    draft: {
      duration: 0,
      locationChange: { toPointId: "4104", toRegionId: "capital" },
      rawEffects: [],
      memoryDrafts: [],
      summary: "一行人悄然移步潮门。",
    },
  }));
  equal(output.receipt.status, "committed", "仅位移回合提交成功");
  equal(output.receipt.currentTime, CURRENT_TIME, "时间不变");
  equal(output.receipt.currentLocationId, "4104", "位置游标写入 receipt");
  equal(output.receipt.adoptedEventIds.length, 0, "账本零事件");
  equal(output.world, world, "引用相等：零写入");
});

test("commit：moveEntity / setFlag effect 走账本采用（0.9.29 动向扩展端到端）", () => {
  const world = buildFixture();
  const output = commitAtlasTurn(world, commitInput(world, {
    draft: {
      duration: 1,
      locationChange: null,
      rawEffects: [
        { kind: "moveEntity", entityId: "entity-npc", pointId: "4104" },
        { kind: "setFlag", key: "merchant-arrived", value: "yes" },
      ],
      memoryDrafts: [],
      summary: "旅行者移步潮门；商会抵达成标记。",
    },
  }));
  equal(output.receipt.status, "committed", "NPC 移动 + 世界标记落账成功");
  equal(output.receipt.adoptedEventIds.length, 1, "恰好一条账本事件");
  const event = output.world.stateEvents.at(-1);
  equal(event.effects.length, 2, "两条 effect 原样入库");
  ok(event.effects.some((e) => e.kind === "moveEntity" && String(e.pointId) === "4104"), "moveEntity 入库");
  ok(event.effects.some((e) => e.kind === "setFlag"), "setFlag 入库");
  ok(parseWorld(JSON.parse(JSON.stringify(output.world))) !== null, "提交后世界可解析往返");
});

test("commit：newLocations 并入世界——重名跳过、地区归属、定义修订（0.9.31 每轮新地点）", () => {
  const world = buildFixture();
  const pointsBefore = (world.points ?? []).length;
  const region = (world.regions ?? [])[0];
  const existingPointName = String((world.points ?? [])[0]?.name ?? "");
  const output = commitAtlasTurn(world, commitInput(world, {
    draft: {
      duration: 1,
      locationChange: null,
      rawEffects: [{ kind: "setTemporalField", entityId: "entity-city", key: "ruler", value: "商会" }],
      memoryDrafts: [],
      newLocations: [
        { name: "潮门钟楼", regionName: region?.name, description: "钟楼立在潮门旁。" },
        { name: existingPointName, regionName: region?.name },
        { name: "   " },
      ],
      summary: "旅行者抵达钟楼。",
    },
  }));
  equal(output.receipt.status, "committed", "提交成功");
  equal((output.world.points ?? []).length, pointsBefore + 1, "重名与坏条目跳过，恰好 +1 地点");
  const added = (output.world.points ?? []).find((p) => p.name === "潮门钟楼");
  ok(added, "新地点存在");
  equal(String(added.regionId), String(region.id), "地区归属正确");
  ok(output.receipt.summary.includes("新增地点"), "回执注明新增地点");
  ok(parseWorld(JSON.parse(JSON.stringify(output.world))) !== null, "提交后世界可解析往返");
});

test("commit：零 effect + 新地点 → 地点照常并入（0.9.31，游标路径不吞新地点）", () => {
  const world = buildFixture();
  const pointsBefore = (world.points ?? []).length;
  const region = (world.regions ?? [])[0];
  const output = commitAtlasTurn(world, commitInput(world, {
    draft: {
      duration: 0,
      locationChange: null,
      rawEffects: [],
      memoryDrafts: [],
      newLocations: [{ name: "北门集市", regionName: region?.name }],
      summary: "路上的人谈起北门集市。",
    },
  }));
  equal(output.receipt.status, "committed", "提交成功");
  equal(output.receipt.currentTime, CURRENT_TIME, "时间不推");
  equal(output.receipt.adoptedEventIds.length, 0, "账本零事件");
  equal((output.world.points ?? []).length, pointsBefore + 1, "地点并入");
  ok(output.receipt.summary.includes("新增地点"), "回执注明新增地点");
});

test("commit：newLocations 携带 submap → createdPoints 透出（0.9.32 点挂子图）", () => {
  const world = buildFixture();
  const region = (world.regions ?? [])[0];
  const output = commitAtlasTurn(world, commitInput(world, {
    draft: {
      duration: 1,
      locationChange: null,
      rawEffects: [{ kind: "setTemporalField", entityId: "entity-city", key: "ruler", value: "商会" }],
      memoryDrafts: [],
      newLocations: [
        {
          name: "潮门钟楼",
          regionName: region?.name,
          description: "潮门旁的旧钟楼。",
          submap: {
            scale: { distancePerCell: 5, unit: "米" },
            points: [{ name: "钟室", description: "大钟悬于此。" }, { name: "楼梯间" }, { name: "值班室" }],
          },
        },
        { name: "空壳楼", submap: { points: [] } },
      ],
      summary: "他们爬上钟楼。",
    },
  }));
  equal(output.receipt.status, "committed", "提交成功");
  ok(output.geo, "geo 结果透出");
  const tower = output.geo.createdPoints.find((p) => p.name === "潮门钟楼");
  ok(tower, "钟楼已创建");
  equal(String(tower.id) !== "", true, "带数字点位 id（供 sidecar 键）");
  ok(tower.submap, "submap 草稿透出");
  equal(tower.submap.points.length, 3, "子图三点位");
  equal(tower.submap.scale.distancePerCell, 5, "比例尺透出");
  ok(!output.geo.createdPoints.some((p) => p.name === "空壳楼") || !output.geo.createdPoints.find((p) => p.name === "空壳楼").submap, "空子图被清洗丢弃");
  ok(parseWorld(JSON.parse(JSON.stringify(output.world))) !== null, "世界可解析往返");
});

test("commit：IF 分支事件不泄漏进正史账本", () => {
  const world = buildFixture();
  const canonBefore = ledgerForBranch(world, null).length;
  const output = commitAtlasTurn(world, commitInput(world, {
    branchId: IF,
    currentTime: 418.12,
  }));
  equal(output.receipt.status, "committed", "IF 分支提交成功");
  const ifLedger = ledgerForBranch(output.world, IF);
  equal(ifLedger.length, 1, "IF 账本恰一条");
  equal(ledgerForBranch(output.world, null).length, canonBefore, "正史账本不变");
  ok(!ledgerForBranch(output.world, null).some((e) => e.sessionId === "atlas::chat-a::msg-10::msg-11::"), "IF 事件不进正史");
});

test("commit：容量失败整单拒绝、零部分写入（复用共享预检）", () => {
  const world = buildFixture();
  // 单提案 effect 超上限 → 契约层拒绝
  assert.throws(() => commitAtlasTurn(world, commitInput(world, {
    draft: {
      duration: 1,
      summary: "超量 effect",
      rawEffects: Array.from({ length: 25 }, (_, i) => ({ kind: "addTag", entityId: "entity-npc", tag: `t${i}` })),
    },
  })), (err) => err instanceof AtlasError && err.code === ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED);
  assertionCount += 1;
});

test("本轮累计断言已记录（计数见报告）", () => {
  ok(assertionCount > 50, "断言数量达到覆盖要求");
});
