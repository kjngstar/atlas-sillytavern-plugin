/**
 * atlas-schedule.test.mjs — ATLAS-13 回合边界 NPC 日程结算。
 *
 * 口径：日程 = entityRecords 上 id 与 character.id 相同的记录的 base 字段 routine
 * （"start-end:pointId" 半开区间，天内时段取模）；一天 = periodsPerDay（type=world
 * 记录 base 字段，缺省 12）。NPC 移动走 moveCharacterTo（CharacterState，分支感知），
 * 每回合确定性重算，不进账本。三裁定：抢先提交先生效 / 玩家主权 / 同段同地判遭遇。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PERIODS_PER_DAY,
  periodsPerDayOf,
  parseRoutineSegments,
  routineFor,
  routinePointAt,
  settleNpcSchedules,
  mergeSettlementNotes,
} from "../src/atlas-schedule.ts";
import { buildStarterWorld } from "../src/atlas-starter-world.ts";
import { parseWorld, W0_LIMITS } from "../lib/world-schema.ts";

const NOW = 1_700_000_000_000;

/** 夹具：1 地区 + 3 地点（家=1 / 铺子=2 / 酒馆=3），NPC 有日程、NPC 驻留、主角无日程 */
function fixtureWorld({ periodsPerDay = 12, routine = ["6-12:2", "18-24:3"] } = {}) {
  const raw = buildStarterWorld({ id: `sched-${NOW}`, now: NOW });
  raw.regions = [
    { id: "r1", worldId: raw.id, name: "城", type: "city", description: "测试地区", coordinates: { x: 50, y: 50 } },
  ];
  raw.points = [
    { id: 1, name: "家", x: 1, y: 1, regionId: "r1" },
    { id: 2, name: "铺子", x: 3, y: 1, regionId: "r1" },
    { id: 3, name: "酒馆", x: 5, y: 1, regionId: "r1" },
  ];
  raw.characters = [
    { id: "npc-1", worldId: raw.id, name: "老板", role: "npc", description: "开店", currentRegionId: "r1" },
    { id: "npc-2", worldId: raw.id, name: "醉汉", role: "npc", description: "常驻酒馆", currentRegionId: "r1" },
    { id: "char-main", worldId: raw.id, name: "主角", role: "protagonist", description: "玩家", currentRegionId: "r1" },
  ];
  // NPC 初始位置：老板在家、醉汉常驻酒馆（CharacterState 由 settle 内 resolve 读取）
  raw.characterStates = [
    { characterId: "npc-1", currentRegionId: "r1", currentPointId: "1", updatedAt: NOW },
    { characterId: "npc-2", currentRegionId: "r1", currentPointId: "3", updatedAt: NOW },
  ];
  const records = [
    {
      id: "npc-1",
      worldId: raw.id,
      type: "npc",
      name: "老板",
      baseline: { routine },
      temporalSchema: [{ key: "routine", kind: "base", valueType: "string[]" }],
    },
  ];
  if (periodsPerDay !== null) {
    records.push({
      id: "cfg-world",
      worldId: raw.id,
      type: "world",
      name: "世界节奏",
      baseline: { periodsPerDay },
      temporalSchema: [{ key: "periodsPerDay", kind: "base", valueType: "number" }],
    });
  }
  raw.entityRecords = records;
  const parsed = parseWorld(JSON.parse(JSON.stringify(raw)));
  assert.ok(parsed, "夹具世界可解析");
  return parsed;
}

test("配置：一天 = N 时段（缺省 12；记录可覆盖；非法回缺省）", () => {
  assert.equal(periodsPerDayOf(fixtureWorld({ periodsPerDay: null })), DEFAULT_PERIODS_PER_DAY, "无配置记录 → 12");
  assert.equal(periodsPerDayOf(fixtureWorld({ periodsPerDay: 24 })), 24, "type=world 记录覆盖");
  const bad = fixtureWorld();
  bad.entityRecords = bad.entityRecords.map((r) =>
    r.type === "world" ? { ...r, baseline: { periodsPerDay: 0 } } : r,
  );
  assert.equal(periodsPerDayOf(bad), DEFAULT_PERIODS_PER_DAY, "0 非法 → 12");
});

test("解析：routine 段（非法丢弃 / 半开区间 / 上限 12 段）", () => {
  const segments = parseRoutineSegments(["0-6:1", "垃圾", "6-6:2", "-1-3:3", "8-18:2"]);
  assert.deepEqual(segments, [
    { start: 0, end: 6, pointId: "1" },
    { start: 8, end: 18, pointId: "2" },
  ]);
  const many = Array.from({ length: 20 }, (_, i) => `${i}-${i + 1}:pt-home`);
  assert.equal(parseRoutineSegments(many).length, 12, "最多 12 段");
  assert.equal(routinePointAt(segments, 5), "1", "[0,6) 命中");
  assert.equal(routinePointAt(segments, 6), null, "6 不在 [0,6)（半开）也不在 [8,18) → gap 驻留");
  assert.equal(routinePointAt(segments, 17), "2", "[8,18) 命中");
});

test("结算：日程移动一次落地 + 同段同地遭遇（玩家原地等 NPC 上门）", () => {
  const world = fixtureWorld({ routine: ["6-12:2"] });
  const result = settleNpcSchedules(world, {
    branchId: null,
    prevTime: 5,
    newTime: 7,
    playerFromPointId: "2",
    playerToPointId: null,
    now: NOW,
  });
  assert.equal(result.moves.length, 1, "时段 6 移动一次，时段 7 已在铺子不再移动");
  assert.equal(result.moves[0].characterId, "npc-1");
  assert.equal(result.moves[0].pointId, "2");
  assert.equal(result.moves[0].periodOfDay, 6);
  assert.equal(result.encounters.length, 1, "时段 6 玩家在铺子 = 老板到铺子 → 遭遇");
  assert.equal(result.encounters[0].characterId, "npc-1");
  assert.equal(result.encounters[0].at, 6);
  // 位置确实落了 CharacterState
  const state = world.characterStates?.find((s) => s.characterId === "npc-1");
  const settledState = result.world.characterStates?.find((s) => s.characterId === "npc-1");
  assert.equal(settledState.currentPointId, "2");
  assert.notEqual(settledState.currentPointId, state.currentPointId, "与结算前不同");
  assert.ok(result.notes.some((n) => n.startsWith("〔日程〕")), "有〔日程〕注记");
});

test("结算：玩家走到驻留 NPC 面前也算遭遇（在途时段不判，抵达才判）", () => {
  const world = fixtureWorld({ routine: [] });
  const result = settleNpcSchedules(world, {
    branchId: null,
    prevTime: 3,
    newTime: 6,
    playerFromPointId: "1",
    playerToPointId: "3",
    now: NOW,
  });
  assert.equal(result.moves.length, 0, "无日程 → 零移动");
  assert.equal(result.encounters.length, 1, "醉汉常驻酒馆；玩家时段 6 抵达 → 1 次遭遇");
  assert.equal(result.encounters[0].characterId, "npc-2");
  assert.equal(result.encounters[0].at, 6, "中间时段在途（不在起点也不在终点），不判遭遇");
});

test("结算：玩家主权——绝不改写玩家路径；行程 0（无时段）零结算", () => {
  const world = fixtureWorld({ routine: ["0-24:1"] });
  const result = settleNpcSchedules(world, {
    branchId: null,
    prevTime: 4,
    newTime: 8,
    playerFromPointId: "1",
    playerToPointId: null,
    now: NOW,
  });
  const mainState = result.world.characterStates?.find((s) => s.characterId === "char-main");
  assert.equal(mainState, undefined, "玩家不是日程对象，不写主角 CharacterState");
  assert.deepEqual(
    result.encounters.filter((e) => e.characterId === "char-main"),
    [],
    "主角不进遭遇",
  );
  const idle = settleNpcSchedules(world, {
    branchId: null,
    prevTime: 4,
    newTime: 4,
    playerFromPointId: "1",
    playerToPointId: null,
    now: NOW,
  });
  assert.equal(idle.moves.length, 0, "0 时段 → 无移动");
  assert.equal(idle.encounters.length, 0, "0 时段 → 无遭遇");
  assert.equal(idle.world, world, "无变化 → 返回原世界（引用相等）");
});

test("结算：确定性重算（同输入两次运行位置/移动/遭遇一致）", () => {
  const input = {
    branchId: null,
    prevTime: 5,
    newTime: 19,
    playerFromPointId: "3",
    playerToPointId: null,
    now: NOW,
  };
  const a = settleNpcSchedules(fixtureWorld(), input);
  const b = settleNpcSchedules(fixtureWorld(), input);
  assert.deepEqual(
    a.moves.map((m) => [m.characterId, m.pointId, m.periodOfDay]),
    b.moves.map((m) => [m.characterId, m.pointId, m.periodOfDay]),
    "移动序列一致",
  );
  assert.deepEqual(
    a.encounters.map((e) => [e.characterId, e.pointId, e.at]),
    b.encounters.map((e) => [e.characterId, e.pointId, e.at]),
    "遭遇序列一致",
  );
  assert.deepEqual(
    a.world.characterStates?.filter((s) => s.characterId === "npc-1"),
    b.world.characterStates?.filter((s) => s.characterId === "npc-1"),
    "NPC 终态位置一致（无未来存档，重算即修正）",
  );
  // 19-24 在酒馆 + 玩家一直待在酒馆 → 必有遭遇；6-12 在铺子
  assert.ok(a.moves.some((m) => m.pointId === "2"), "有去铺子的移动");
  assert.ok(a.encounters.some((e) => e.pointId === "3"), "有酒馆遭遇");
});

test("结算：日程里的未知地点被忽略并注记；已知地点照常（一天 24 时段口径）", () => {
  const world = fixtureWorld({ periodsPerDay: 24, routine: ["6-12:999", "12-18:2"] });
  const result = settleNpcSchedules(world, {
    branchId: null,
    prevTime: 5,
    newTime: 13,
    playerFromPointId: "1",
    playerToPointId: null,
    now: NOW,
  });
  assert.ok(result.notes.some((n) => n.includes("999")), "未知地点注记");
  assert.ok(result.moves.every((m) => m.pointId !== "999"), "绝不移向未知地点");
  assert.ok(result.moves.some((m) => m.pointId === "2"), "已知地点照常移动（时段 12 在 [12,18)）");
});

test("结算：跨日取模边界——11→12→13（12 时段/天，时段 12 = 日内 0）", () => {
  const world = fixtureWorld({ routine: ["0-1:2", "11-12:3"] });
  const result = settleNpcSchedules(world, {
    branchId: null,
    prevTime: 10,
    newTime: 13,
    playerFromPointId: "1",
    playerToPointId: null,
    now: NOW,
  });
  assert.deepEqual(
    result.moves.map((m) => [m.pointId, m.periodOfDay]),
    [["3", 11], ["2", 0]],
    "时段 11 → 酒馆（日内 11）；时段 12 取模 0 → 铺子（[0,1)）；时段 13 取模 1 → gap 驻留",
  );
  const settled = result.world.characterStates?.find((s) => s.characterId === "npc-1");
  assert.equal(settled?.currentPointId, "2", "终态在铺子");
});

test("结算：跨日取模边界——23→24→25（时段 24 = 次日 0）", () => {
  const world = fixtureWorld({ routine: ["11-12:3", "0-2:2"] });
  const result = settleNpcSchedules(world, {
    branchId: null,
    prevTime: 22,
    newTime: 25,
    playerFromPointId: "1",
    playerToPointId: null,
    now: NOW,
  });
  assert.deepEqual(
    result.moves.map((m) => [m.pointId, m.periodOfDay]),
    [["3", 11], ["2", 0]],
    "时段 23（日内 11）→ 酒馆；时段 24（次日 0）→ 铺子；时段 25（日内 1）已在铺子",
  );
});

test("结算：主角安全网——主角即使被给了 routine 也绝不被移动、不产生自我遭遇", () => {
  const world = fixtureWorld({ routine: [] });
  // 主角被（错误地）登记了日程，且与玩家同在铺子
  world.entityRecords = [
    ...world.entityRecords,
    {
      id: "char-main",
      worldId: world.id,
      type: "npc",
      name: "主角",
      baseline: { routine: ["0-24:2"] },
      temporalSchema: [{ key: "routine", kind: "base", valueType: "string[]" }],
    },
  ];
  world.characters = world.characters.map((c) =>
    c.id === "char-main" ? { ...c, role: "主角" } : c,
  );
  const result = settleNpcSchedules(world, {
    branchId: null,
    prevTime: 4,
    newTime: 8,
    playerFromPointId: "2",
    playerToPointId: null,
    now: NOW,
  });
  assert.equal(result.moves.filter((m) => m.characterId === "char-main").length, 0, "主角绝不被日程移动");
  assert.equal(result.encounters.filter((e) => e.characterId === "char-main").length, 0, "主角绝不进遭遇（无自我遭遇）");
  assert.equal(result.moves.length, 0, "老板无日程；唯一的 routine 记录属于主角但被安全网忽略");
});

test("结算：IF 分支——移动写本分支覆盖条目，正史基线一字不动", () => {
  const world = fixtureWorld({ routine: ["6-12:2"] });
  const before = JSON.stringify(world.characterStates?.filter((s) => !s.branchId) ?? []);
  const result = settleNpcSchedules(world, {
    branchId: "if-1",
    prevTime: 5,
    newTime: 7,
    playerFromPointId: "1",
    playerToPointId: null,
    now: NOW,
  });
  assert.equal(result.moves.length, 1, "分支内照常结算");
  const afterCanon = JSON.stringify(result.world.characterStates?.filter((s) => !s.branchId) ?? []);
  assert.equal(afterCanon, before, "正史基线不变");
  const branchState = result.world.characterStates?.find((s) => s.characterId === "npc-1" && s.branchId === "if-1");
  assert.equal(branchState?.currentPointId, "2", "覆盖条目落在 if-1");
});

test("注记合入 summary：有界截断；空注记原样返回", () => {
  assert.equal(mergeSettlementNotes("摘要。", []), "摘要。");
  const long = mergeSettlementNotes("摘要。", [`〔日程〕${"x".repeat(5000)}`]);
  assert.ok(long.length <= W0_LIMITS.maxStateEventSummary, "不超账本摘要上限");
  assert.ok(long.startsWith("摘要。"), "原文在前");
});
