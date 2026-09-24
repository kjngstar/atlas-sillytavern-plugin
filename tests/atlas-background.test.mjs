/**
 * atlas-background.test.mjs — E06：远方 NPC 后台自主行动（计划 §3-E06）。
 *
 * 口径来源：`src/atlas-background.ts` 的 `planBackgroundMoves`（纯函数，零 IO）。
 * 本文件只测**纯函数契约**；接入回合提交（E07）由 `atlas-table-delta.test.mjs` 覆盖。
 *
 * 纪律（每条都有对应用例）：
 * - 时间没推进（短对话 0 段）→ 谁都不动；
 * - 位置未知 / 目标不在同一张图 / 目标行不存在 → 只更新行动记录，不瞬移；
 * - 太远（超阈值）→ 只更新行动记录（远方宣战不一轮传遍全图）；
 * - 时间够走 → 分批移动，绝不一次跳到位；
 * - 主角（protectedCharacterIds）不动；
 * - 每回合人数上限 20，超出部分如实计数；
 * - 纯函数：不改入参三表。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ATLAS_BACKGROUND_MOVE_MAX,
  hasBackgroundIntent,
  planBackgroundMoves,
} from "../src/atlas-background.ts";
import { validateAtlasTables } from "../src/atlas-tables.ts";

/** 一张 100×100 世界图上的地点行。 */
function location(id, name, x, y, parentLocationId = null, mapId = "world") {
  return { id, name, parentLocationId, description: "", rumors: [], factions: [], mapId, gridX: x, gridY: y };
}

function character(id, name, locationId, extra = {}) {
  return {
    id,
    name,
    locationId,
    thought: "",
    actionTendency: "",
    currentAction: "",
    targetLocationId: null,
    presence: "present",
    positionSource: "narrative",
    mapId: "world",
    gridX: null,
    gridY: null,
    ...extra,
  };
}

function tables({ locations, characters, items = [] }) {
  return { locations, characters, items };
}

/** 基准：钟楼 (10,10) 与远塔 (20,10) 同在世界图；两行人物都在钟楼。 */
function baseTables() {
  return tables({
    locations: [
      location("loc:1", "钟楼", 10, 10),
      location("loc:2", "远塔", 20, 10),
      // 钟楼的子图点位：归属于钟楼（mapId 必须等于父 id，A01 的约束）
      location("loc:3", "钟楼夹层", 5, 5, "loc:1", "loc:1"),
    ],
    characters: [
      character("npc:a", "阿澈", "loc:1", { targetLocationId: "loc:2" }),
      character("npc:b", "林拾", "loc:1", { targetLocationId: "loc:1" }),
      character("npc:c", "无目标的人", "loc:1"),
    ],
  });
}

test("E06：时间没推进（0 段）→ 谁都不动，行动记录也不改", () => {
  const before = baseTables();
  const plan = planBackgroundMoves({ tables: before, prevTime: 10, newTime: 10 });
  assert.deepEqual(plan.moves, [], "零时段没有任何移动");
  assert.equal(plan.tables.characters.find((row) => row.id === "npc:a").targetLocationId, "loc:2", "目标仍在，不丢");
  assert.equal(plan.tables.characters.find((row) => row.id === "npc:a").locationId, "loc:1", "位置不动");
});

test("E06：只有「有目标且在场」的人才被考虑；已在目标地的人自动收尾", () => {
  const before = baseTables();
  const plan = planBackgroundMoves({ tables: before, prevTime: 0, newTime: 4 });
  const moved = plan.moves.map((move) => move.characterId);
  assert.ok(!moved.includes("npc:c"), "没有目标地点的人不进计划");
  // npc:b 的目标就是自己所在地 → 直接清掉目标，不算移动
  assert.equal(plan.tables.characters.find((row) => row.id === "npc:b").targetLocationId, null, "已在目标地 → 目标清空");
  assert.ok(!moved.includes("npc:b"), "已在目标地不算一次移动");
});

test("E06：位置未知 / 不同图 / 目标行不存在 → 只更新行动记录（blocked），绝不瞬移", () => {
  const before = tables({
    locations: [
      location("loc:1", "钟楼", 10, 10),
      location("loc:2", "远塔", 20, 10),
      // 挂在钟楼子图的点：与钟楼不在同一图层，走不过去
      location("loc:9", "钟楼夹层", 50, 50, "loc:1", "loc:1"),
    ],
    characters: [
      // 位置未知（locationId=null）但有目标
      character("npc:x", "位置未知的人", null, { targetLocationId: "loc:2" }),
      // 目标在另一张图
      character("npc:y", "跨图的人", "loc:1", { targetLocationId: "loc:9" }),
      // 目标行不存在
      character("npc:z", "目标悬空的人", "loc:1", { targetLocationId: "loc:404" }),
    ],
  });
  const plan = planBackgroundMoves({ tables: before, prevTime: 0, newTime: 4 });
  assert.equal(plan.moves.length, 2, "两个有可解析目标但走不了的人（悬空目标直接不进候选）");
  for (const move of plan.moves) {
    assert.equal(move.status, "blocked", `${move.characterId} 只更新行动`);
    assert.equal(move.travelledCells, 0, "零格移动");
    assert.equal(move.toLocationId, null, "没有到达地点");
  }
  assert.deepEqual(plan.moves.map((m) => m.reasonCode).sort(), ["NO_PATH", "NO_ROUTE"]);
  assert.equal(plan.tables.characters.find((row) => row.id === "npc:x").locationId, null, "位置未知的人仍未知");
});

test("E06：太远（超阈值）→ 只更新行动记录，不移动", () => {
  const before = tables({
    locations: [location("loc:1", "钟楼", 0, 0), location("loc:far", "极远城", 200, 0)],
    characters: [character("npc:a", "阿澈", "loc:1", { targetLocationId: "loc:far" })],
  });  const plan = planBackgroundMoves({ tables: before, prevTime: 0, newTime: 2, farCells: 60 });
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].status, "blocked");
  assert.equal(plan.moves[0].reasonCode, "TOO_FAR");
  assert.equal(plan.moves[0].remainingCells, 200, "如实报出剩余距离");
  const row = plan.tables.characters[0];
  assert.equal(row.locationId, "loc:1", "人还在原地");
  assert.equal(row.targetLocationId, "loc:far", "目标保留（下一回合继续试）");
  assert.ok(row.actionTendency.includes("极远城"), "行动记录如实写成「赶往某地」");
});

test("E06：时间够走 → 分批前进（在途），下一回合继续走，最后到位", () => {
  const before = tables({
    // 距离 30 格；每时段 6 格 → 10 时段预算正好走完
    locations: [location("loc:1", "钟楼", 0, 0), location("loc:2", "远塔", 30, 0)],
    characters: [character("npc:a", "阿澈", "loc:1", { targetLocationId: "loc:2" })],
  });
  // 第一回合只推进 2 时段（12 格预算）→ 在路上
  const first = planBackgroundMoves({ tables: before, prevTime: 0, newTime: 2, cellsPerPeriod: 6 });
  assert.equal(first.moves[0].status, "enroute", "第一步在路上");
  assert.equal(first.moves[0].travelledCells, 12, "走了 12 格");
  assert.equal(first.moves[0].remainingCells, 18, "剩 18 格");
  const mid = first.tables.characters[0];
  assert.equal(mid.locationId, null, "在途时位置未知（不假装还在出发地）");
  assert.equal(mid.mapId, "world", "仍在同一张图上（地图上看得见他在路上）");
  assert.equal(mid.gridX, 12, "格坐标朝目标推进");
  assert.equal(mid.gridY, 0);
  assert.equal(mid.currentAction, "正在赶往远塔");
  assert.equal(mid.positionSource, "simulation", "位置来源 = 程序推演");

  // 第二回合继续走（**从当前所在格继续**，不是被拉回出发点重新起步）→ 预算 24 > 剩余 18 → 到位
  const second = planBackgroundMoves({ tables: first.tables, prevTime: 2, newTime: 6, cellsPerPeriod: 6 });
  assert.equal(second.moves[0].status, "moved", "第二回合到位");
  const arrived = second.tables.characters[0];
  assert.equal(arrived.locationId, "loc:2", "落点 = 目标地点");
  assert.equal(arrived.targetLocationId, null, "到位后清空目标");
  assert.equal(arrived.presence, "present", "到位即在場");
  assert.ok(arrived.currentAction.includes("抵达"), "行动记录如实更新");
});

test("E06：在途的人下一回合继续走（不被拉回出发点重新起步）", () => {
  const before = tables({
    // 距离 100 格：单回合走不完，必须分多回合
    locations: [location("loc:1", "钟楼", 0, 0), location("loc:2", "远塔", 100, 0)],
    characters: [character("npc:a", "阿澈", "loc:1", { targetLocationId: "loc:2" })],
  });
  const first = planBackgroundMoves({ tables: before, prevTime: 0, newTime: 1, cellsPerPeriod: 10, farCells: 200 });
  assert.equal(first.moves[0].travelledCells, 10, "第一回合走 10 格");
  assert.equal(first.tables.characters[0].gridX, 10, "位置在 10 格处");
  const second = planBackgroundMoves({ tables: first.tables, prevTime: 1, newTime: 2, cellsPerPeriod: 10, farCells: 200 });
  assert.equal(second.tables.characters[0].gridX, 20, "第二回合从 10 格继续走到 20 格（不是回到 0 再走 10）");
  assert.equal(second.moves[0].remainingCells, 80, "剩余距离按当前位置递减");
});

test("E06：主角被保护名单挡住；离场 / 在场未知的人不动", () => {
  const before = tables({
    locations: [location("loc:1", "钟楼", 0, 0), location("loc:2", "远塔", 10, 0)],
    characters: [
      character("npc:hero", "主角", "loc:1", { targetLocationId: "loc:2" }),
      character("npc:left", "离场的人", "loc:1", { targetLocationId: "loc:2", presence: "left" }),
      character("npc:unknown", "在场未知的人", "loc:1", { targetLocationId: "loc:2", presence: "unknown" }),
    ],
  });
  const plan = planBackgroundMoves({
    tables: before, prevTime: 0, newTime: 4,
    protectedCharacterIds: new Set(["npc:hero"]),
  });
  assert.deepEqual(plan.moves, [], "三种人都不进计划");
  assert.equal(plan.tables.characters[0].locationId, "loc:1", "主角位置不动");
});

test("E06：每回合人数上限 20，超出部分如实计数（不静默丢）", () => {
  const locations = [location("loc:1", "钟楼", 0, 0), location("loc:2", "远塔", 10, 0)];
  const characters = [];
  for (let i = 0; i < 25; i += 1) {
    characters.push(character(`npc:${String(i).padStart(2, "0")}`, `路人${i}`, "loc:1", { targetLocationId: "loc:2" }));
  }
  const plan = planBackgroundMoves({ tables: tables({ locations, characters }), prevTime: 0, newTime: 4 });
  assert.equal(ATLAS_BACKGROUND_MOVE_MAX, 20, "上限常量 = 20（计划 §3-E06）");
  assert.equal(plan.moves.length, 20, "最多处理 20 人");
  assert.equal(plan.skipped, 5, "未处理的 5 人如实计数");
  assert.ok(plan.notes.some((note) => note.includes("20 人上限")), `注记说明上限：实际 ${JSON.stringify(plan.notes)}`);
  // 确定性：同一份输入两次结果一致（可重放 / 回退对得上）
  const again = planBackgroundMoves({ tables: tables({ locations, characters }), prevTime: 0, newTime: 4 });
  assert.deepEqual(again.moves, plan.moves, "同一输入 → 同一计划");
});

test("E06：纯函数 —— 不改入参三表，返回的表通过 A01 校验", () => {
  const before = baseTables();
  const snapshot = JSON.stringify(before);
  const plan = planBackgroundMoves({ tables: before, prevTime: 0, newTime: 4 });
  assert.equal(JSON.stringify(before), snapshot, "入参未被修改");
  assert.notEqual(plan.tables, before, "返回的是副本");
  const validation = validateAtlasTables(plan.tables);
  assert.equal(validation.ok, true, `后台行动后的表必须仍然合法：${JSON.stringify(validation.errors ?? [])}`);
  assert.equal(hasBackgroundIntent(plan.tables.characters.find((row) => row.id === "npc:a")), false, "到位后不再有意图");
});

/* ------------------------------------------------------------------ *
 * D11a：超距逐段接近 / 0 时段不动（D01）
 * ------------------------------------------------------------------ */

/** 一条链：loc:0 → loc:1 → loc:2 → loc:3，全部是**已确认**的相邻边。 */
function confirmedChain(ids) {
  const edges = [];
  for (let index = 0; index < ids.length - 1; index += 1) {
    edges.push({
      id: `edge:${ids[index]}->${ids[index + 1]}`,
      fromLocationId: ids[index], toLocationId: ids[index + 1],
      kind: "adjacent", evidence: "story", channel: "walk",
    });
  }
  return { edges, areas: [], vehicles: [] };
}

function walkerTables() {
  return {
    locations: [
      { id: "loc:0", name: "起点", parentLocationId: null, description: "", rumors: [], factions: [], mapId: "world", gridX: 0, gridY: 0 },
      { id: "loc:1", name: "驿站", parentLocationId: null, description: "", rumors: [], factions: [], mapId: "world", gridX: 10, gridY: 0 },
      { id: "loc:2", name: "关隘", parentLocationId: null, description: "", rumors: [], factions: [], mapId: "world", gridX: 20, gridY: 0 },
      { id: "loc:3", name: "远城", parentLocationId: null, description: "", rumors: [], factions: [], mapId: "world", gridX: 30, gridY: 0 },
    ],
    characters: [{
      id: "npc:walker", name: "信使", locationId: "loc:0", thought: "", actionTendency: "赶往远城",
      currentAction: "", targetLocationId: "loc:3", presence: "present", positionSource: "narrative",
      mapId: "world", gridX: 0, gridY: 0,
    }],
    items: [],
  };
}

test("D01 超距目标沿已确认边逐段接近，不被标记已到，也不再永久 TOO_FAR", () => {
  const topology = confirmedChain(["loc:0", "loc:1", "loc:2", "loc:3"]);

  // 1 时段：只走一个路段，且**没有**到达终点
  const first = planBackgroundMoves({ tables: walkerTables(), prevTime: 0, newTime: 1, farCells: 5, topology });
  const move = first.moves.find((item) => item.characterId === "npc:walker");
  assert.ok(move, "超距目标必须被处理，而不是静默跳过");
  assert.equal(move.status, "enroute", "只走一个路段");
  assert.equal(move.toLocationId, null, "没到终点就不能写 toLocationId");
  assert.deepEqual(move.viaPath, ["loc:0", "loc:1", "loc:2", "loc:3"], "路径来自已确认边");
  const moved = first.tables.characters.find((row) => row.id === "npc:walker");
  assert.equal(moved.locationId, "loc:1", "前进一个路段");
  assert.notEqual(moved.locationId, "loc:3", "绝不瞬移到终点");
  assert.equal(moved.targetLocationId, "loc:3", "目标保留，下一轮继续接近");

  // 继续推进：逐段接近，最终才到达并清空目标
  const second = planBackgroundMoves({ tables: first.tables, prevTime: 1, newTime: 2, farCells: 5, topology });
  assert.equal(second.tables.characters[0].locationId, "loc:2");
  const third = planBackgroundMoves({ tables: second.tables, prevTime: 2, newTime: 3, farCells: 5, topology });
  assert.equal(third.tables.characters[0].locationId, "loc:3", "第三段才到达");
  assert.equal(third.tables.characters[0].targetLocationId, null, "到位后清空目标");
  assert.equal(third.moves.find((item) => item.characterId === "npc:walker").status, "moved");
});

test("D01 没有已确认路线时仍旧 blocked，绝不猜路径", () => {
  const noEdges = { edges: [], areas: [], vehicles: [] };

  // ① 同图内已知距离但超过阈值 → TOO_FAR（原因如实，不是「没路」）
  const tooFar = planBackgroundMoves({
    tables: walkerTables(), prevTime: 0, newTime: 5, farCells: 5, topology: noEdges,
  });
  const farMove = tooFar.moves.find((item) => item.characterId === "npc:walker");
  assert.equal(farMove.status, "blocked");
  assert.equal(farMove.reasonCode, "TOO_FAR", "同图已知距离超阈值 = TOO_FAR");
  assert.equal(tooFar.tables.characters[0].locationId, "loc:0", "一步都不走");

  // ② 跨图 / 距离未知 → NO_ROUTE（连距离都算不出来，不许猜）
  const crossMap = walkerTables();
  crossMap.locations = crossMap.locations.map((row) =>
    row.id === "loc:3" ? { ...row, mapId: "world-other" } : row);
  const unknown = planBackgroundMoves({
    tables: crossMap, prevTime: 0, newTime: 5, farCells: 5, topology: noEdges,
  });
  const unknownMove = unknown.moves.find((item) => item.characterId === "npc:walker");
  assert.equal(unknownMove.status, "blocked");
  assert.equal(unknownMove.reasonCode, "NO_ROUTE", "距离未知 = NO_ROUTE");
  assert.equal(unknown.tables.characters[0].locationId, "loc:0", "跨图不得瞬移");
});

test("D01 0 时段：无论有没有已确认路线，谁都不动", () => {
  const plan = planBackgroundMoves({
    tables: walkerTables(), prevTime: 7, newTime: 7, topology: confirmedChain(["loc:0", "loc:1"]),
  });
  assert.equal(plan.moves.length, 0, "时间未推进连计划都不该产出");
  assert.equal(plan.tables.characters[0].locationId, "loc:0");
});
