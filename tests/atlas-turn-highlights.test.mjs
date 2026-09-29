import test from "node:test";
import assert from "node:assert/strict";
import { summarizeAtlasTurnChanges } from "../src/atlas-turn-highlights.ts";

test("本轮简报从实际表变化生成，不回显机器回执或人物隐藏想法", () => {
  const location = { id: "loc:1", name: "枫叶城", parentLocationId: null,
    description: "", rumors: [], factions: [], mapId: "world", gridX: null, gridY: null };
  const previous = { locations: [], characters: [], items: [] };
  const after = { locations: [location], characters: [{ id: "npc:1", name: "丝薇娜",
    locationId: "loc:1", thought: "隐藏心思", actionTendency: "秘密计划", currentAction: "",
    targetLocationId: null, presence: "present", positionSource: "narrative", mapId: "world", gridX: null, gridY: null }], items: [] };
  assert.deepEqual(summarizeAtlasTurnChanges(previous, after, ["loc:1", "npc:1", "npc:1"]), [
    { text: "发现地点：枫叶城（位置待确认）", visibility: "hidden", sourceRef: "loc:1" },
    { text: "丝薇娜出现在枫叶城", visibility: "hidden", sourceRef: "npc:1" },
  ]);
  assert.deepEqual(summarizeAtlasTurnChanges(after, after, ["npc:1"]), [], "无变化不能编造动向");
});
