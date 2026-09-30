import test from "node:test";
import assert from "node:assert/strict";
import { buildCharacterTimeline } from "../src/atlas-character-timeline.ts";

const place = (id, name) => ({ id, name, parentLocationId: null, mapId: "world", gridX: null, gridY: null, description: "", rumors: [], factions: [] });
const person = (locationId, currentAction, gridX = null) => ({
  id: "npc:hero", name: "主角", locationId, mapId: locationId, gridX,
  gridY: gridX, thought: "私密想法", actionTendency: "", currentAction,
  targetLocationId: null, presence: "present", positionSource: "narrative",
});

test("人物时间线只记已提交的位置、动作与事件变化，不把私密想法当经历", () => {
  const locations = [place("loc:city", "城里"), place("loc:room", "教室")];
  const before = { locations, characters: [person("loc:city", "上学")], items: [] };
  const after = { locations, characters: [person("loc:room", "上课", 3)], items: [] };
  const events = [{ id: "e1", simulationId: "s1", kind: "travel", actorCharacterId: "npc:hero",
    fromLocationId: "loc:city", toLocationId: "loc:room", status: "arrived", reasonCode: null,
    summary: "走进教室", visibility: "hidden", period: 7 }];
  const result = buildCharacterTimeline(before, after, events, 7);
  assert.equal(result.length, 2);
  assert.equal(result[0].locationName, "教室");
  assert.equal(result[0].fromLocationId, "loc:city");
  assert.equal(result[1].experience, "走进教室");
  assert.equal(result.every((row) => row.visibility === "author"), true);
  assert.equal(JSON.stringify(result).includes("私密想法"), false);
  assert.deepEqual(buildCharacterTimeline(after, after, [], 8), []);
});
