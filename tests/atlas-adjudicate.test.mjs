/**
 * atlas-adjudicate.test.mjs — 0.9.0 算法裁决层。
 * 覆盖：未知地点降级丢弃；网格旅行算法裁定移动耗时下限；AI 时段充足时不干预；
 * 非移动回合不推进；实体白名单（未知实体 effect / 记忆丢弃，setFlag 保留）；
 * 裁定说明合入 summary；同输入同输出（确定性）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { adjudicateAtlasDraft } from "../src/atlas-adjudicate.ts";
import { buildStarterWorld } from "../src/atlas-starter-world.ts";
import { buildTravelHint } from "../lib/world-engine.ts";
import { parseWorld } from "../lib/world-schema.ts";

const NOW = 1_700_000_000_000;

/** 夹具世界：starter world + 远处第二个地点 B(80,50)（起点 A 在 50,50）。 */
function fixtureWorld() {
  const world = buildStarterWorld({ id: `adj-${NOW}`, now: NOW, name: "裁决测试", description: "" });
  world.points.push({ id: 2, name: "远镇", x: 80, y: 50, regionId: "start" });
  const parsed = parseWorld(JSON.parse(JSON.stringify(world)));
  assert.ok(parsed, "夹具世界可解析");
  return parsed;
}

function draft(overrides = {}) {
  return {
    duration: 1,
    locationChange: null,
    rawEffects: [],
    memoryDrafts: [],
    summary: "测试回合。",
    ...overrides,
  };
}

test("裁决：AI 引用未知地点 → 移动被丢弃并记录，不再炸整单", () => {
  const world = fixtureWorld();
  const result = adjudicateAtlasDraft(world, {
    branchId: null,
    currentPointId: "1",
    draft: draft({ locationChange: { toPointId: "9999", toRegionId: null } }),
  });
  assert.equal(result.draft.locationChange, null, "未知地点移动被丢弃");
  assert.ok(result.notes.some((n) => n.includes("未知地点")), "有裁定说明");
  assert.ok(result.draft.summary.includes("〔裁定〕"), "说明合入 summary");
});

test("裁决：移动耗时由网格旅行算法裁定下限（AI 低估被顶起）", () => {
  const world = fixtureWorld();
  const hint = buildTravelHint(world, { fromPointId: "1", toPointId: "2" });
  const expected = Math.max(0, Math.round(hint.suggestedPeriods));
  const result = adjudicateAtlasDraft(world, {
    branchId: null,
    currentPointId: "1",
    draft: draft({ duration: 1, locationChange: { toPointId: "2", toRegionId: null } }),
  });
  assert.equal(result.draft.duration, expected, "duration = 算法裁定值");
  assert.ok(result.notes.some((n) => n.includes("格")), "说明含距离");
});

test("裁决：AI 给的时段充足时不干预", () => {
  const world = fixtureWorld();
  const result = adjudicateAtlasDraft(world, {
    branchId: null,
    currentPointId: "1",
    draft: draft({ duration: 999, locationChange: { toPointId: "2", toRegionId: null } }),
  });
  assert.equal(result.draft.duration, 999, "AI 时段保留");
  assert.deepEqual(result.notes, [], "无裁定说明");
});

test("裁决：非移动回合的时间完全由 AI 推断（事件性推进不受影响）", () => {
  const world = fixtureWorld();
  const result = adjudicateAtlasDraft(world, {
    branchId: null,
    currentPointId: "1",
    draft: draft({ duration: 5, locationChange: null }),
  });
  assert.equal(result.draft.duration, 5, "duration 不变");
  assert.deepEqual(result.notes, [], "零裁定");
});

test("裁决：实体白名单——未知实体的 effect / 记忆丢弃，setFlag 与已知实体保留", () => {
  const world = fixtureWorld();
  const result = adjudicateAtlasDraft(world, {
    branchId: null,
    currentPointId: "1",
    draft: draft({
      rawEffects: [
        { kind: "setTemporalField", entityId: "char-main", key: "mood", value: "警惕" },
        { kind: "setTemporalField", entityId: "ghost-404", key: "mood", value: "不存在" },
        { kind: "setFlag", key: "storm-passed", value: "yes" },
      ],
      memoryDrafts: [
        { entityId: "char-main", text: "记得远镇的钟声。" },
        { entityId: "ghost-404", text: "不存在者的记忆。" },
      ],
    }),
  });
  assert.equal(result.draft.rawEffects.length, 2, "保留已知实体 effect + setFlag");
  assert.ok(result.draft.rawEffects.some((e) => e.kind === "setFlag"), "setFlag 不受白名单影响");
  assert.equal(result.draft.memoryDrafts.length, 1, "未知实体记忆被丢弃");
  assert.ok(result.notes.some((n) => n.includes("未知实体")), "有裁定说明");
});

test("裁决：确定性——同输入两次裁决逐字节一致", () => {
  const world = fixtureWorld();
  const input = {
    branchId: null,
    currentPointId: "1",
    draft: draft({ duration: 1, locationChange: { toPointId: "2", toRegionId: null } }),
  };
  const a = adjudicateAtlasDraft(world, input);
  const b = adjudicateAtlasDraft(world, input);
  assert.deepEqual(a.draft, b.draft, "草稿一致");
  assert.deepEqual(a.notes, b.notes, "说明一致");
});
