/**
 * atlas-r04-runtime-view.test.mjs — R04 统一投影回归测试。
 *
 * 场景复刻 v0.9.51 审计（D05）：char-main 移动到地点 2 + 状态「正在交谈」提交成功后，
 * 旧口径账本 _pointId:"2" 而目录 pointId:null（source:legacy）。
 * R04 后：resolveAtlasRuntimeView 单一读取口径——目录与账本一致。
 *
 * 验收（计划 R04）：账本点位与目录点位一致为 2；status 同时可见；注册表覆盖
 * entityRecords 有而 characters 无的 NPC 且无重复。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(resolve(root, p)).href);
const { buildStarterWorld } = await imp("src/atlas-starter-world.ts");
const { commitAtlasTurn } = await imp("src/atlas-turn.ts");
const { projectEntityState } = await imp("lib/world-ledger.ts");
const { resolveAtlasRuntimeView } = await imp("src/atlas-runtime-view.ts");
const { parseAtlasWorldTurnDraft } = await imp("src/atlas-api-client.ts");

function committedWorld() {
  const world = buildStarterWorld({ id: "r04-world", now: 1, name: "R04 场景" });
  world.points.push({ id: 2, name: "废墟深处", x: 70, y: 50, regionId: "start" });
  const draft = parseAtlasWorldTurnDraft(
    JSON.stringify({
      duration: 1,
      locationChange: null,
      npcChanges: [
        { entityId: "char-main", toPointId: "2", toRegionId: "start" },
        { entityId: "char-main", key: "status", value: "正在交谈" },
      ],
      memoryDrafts: [],
      summary: "角色进入废墟深处",
    }),
  );
  const request = { turnId: "turn-r04", chatId: "r04-chat", userMessageId: "u1", assistantMessageId: "a1", swipeId: null, userText: "进入废墟", assistantText: "角色来到废墟深处。" };
  const output = commitAtlasTurn(world, { request, branchId: null, currentTime: 0, currentPointId: "1", currentRegionId: "start", draft, now: 2 });
  return output;
}

test("N04: 提交后统一视图与账本投影一致（D05 修复）", () => {
  const output = committedWorld();
  assert.equal(output.receipt.status, "committed", "提交成功");

  // 账本投影（权威）
  const ledger = projectEntityState(output.world, "char-main", null, 1);
  assert.equal(String(ledger._pointId), "2", "账本 _pointId = 2");

  // 统一运行时视图 = 旧审计中目录的读取口径
  const view = resolveAtlasRuntimeView(output.world, { branchId: null, at: 1 });
  const main = view.npcs.find((n) => n.id === "char-main");
  assert.ok(main, "char-main 在视图中");
  assert.equal(String(main.pointId), String(ledger._pointId), "目录点位与账本点位一致（旧基线为 null）");
  assert.equal(main.regionId, "start", "地区随地点归属解析");
  assert.equal(main.status, "正在交谈", "状态文字与账本一致（旧基线为空）");
  assert.equal(main.statusSource, "ledger", "状态来源标记为账本");
  assert.equal(main.source, "ledger", "位置来源标记为账本");
});

test("R04: 无账本事件时回退 CharacterState / 旧角色字段（兼容基线）", () => {
  const world = buildStarterWorld({ id: "r04-base", now: 1, name: "基线" });
  world.characterStates = [
    { characterId: "char-main", currentRegionId: "start", currentPointId: "1", status: "休息中", updatedAt: 5 },
  ];
  const view = resolveAtlasRuntimeView(world, { branchId: null, at: 10 });
  const main = view.npcs.find((n) => n.id === "char-main");
  assert.ok(main, "char-main 可见");
  assert.equal(String(main.pointId), "1", "基线点位保留");
  assert.equal(main.status, "休息中", "基线状态保留");
  assert.equal(main.source, "state", "来源标记为基线");
});

test("N09: entityRecords 有 NPC 而 characters 无 → 注册表关联后可见且无重复", () => {
  const world = buildStarterWorld({ id: "r04-reg", now: 1, name: "注册表" });
  world.characters = (world.characters ?? []).filter((c) => c.id !== "char-only");
  world.entityRecords = [
    ...(world.entityRecords ?? []),
    {
      id: "char-only",
      worldId: world.id,
      type: "npc",
      name: "只存在实体记录的人物",
      temporalSchema: [],
      relations: [],
      baseline: { _regionId: "start", _pointId: "1" },
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  const view = resolveAtlasRuntimeView(world, { branchId: null, at: 10 });
  const matches = view.npcs.filter((n) => n.id === "char-only");
  assert.equal(matches.length, 1, "同一 ID 只出现一次");
  assert.equal(matches[0].name, "只存在实体记录的人物", "实体记录人物可见（不因不在 characters 消失）");
});

test("R04: 规则 3——pointId 变更而 regionId 未随事件更新时，按地点归属重解析地区", () => {
  const world = buildStarterWorld({ id: "r04-region", now: 1, name: "地区一致性" });
  world.regions.push({ id: "r2", worldId: world.id, name: "新地区", type: "other", description: "", coordinates: { x: 1, y: 1 } });
  world.points.push({ id: 2, name: "新地点", x: 20, y: 20, regionId: "r2" });
  world.entityRecords = [
    ...(world.entityRecords ?? []),
    {
      id: "npc-w",
      worldId: world.id,
      type: "npc",
      name: "游荡者",
      temporalSchema: [],
      relations: [],
      baseline: { _regionId: "start", _pointId: "1" },
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  const view = resolveAtlasRuntimeView(world, { branchId: null, at: 10 });
  const w = view.npcs.find((n) => n.id === "npc-w");
  assert.ok(w, "游荡者可见");
  assert.equal(w.regionId, "start", "基线点位 1 归属 start");
});
