/**
 * atlas-time-intent.test.mjs — 0.9.1 时间意图抽取 + 裁决层时间下限。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { extractAtlasTimeIntent, renderAtlasTimeHint } from "../src/atlas-time-intent.ts";
import { adjudicateAtlasDraft } from "../src/atlas-adjudicate.ts";
import { buildStarterWorld } from "../src/atlas-starter-world.ts";
import { parseWorld } from "../lib/world-schema.ts";

const NOW = 1_700_000_000_000;

function fixtureWorld() {
  const parsed = parseWorld(JSON.parse(JSON.stringify(buildStarterWorld({ id: `ti-${NOW}`, now: NOW }))));
  assert.ok(parsed, "夹具世界可解析");
  return parsed;
}

function draft(overrides = {}) {
  return { duration: 1, locationChange: null, rawEffects: [], memoryDrafts: [], summary: "测试回合。", ...overrides };
}

test("抽取：显式时间词 → 时段下限（取最大）", () => {
  const intent = extractAtlasTimeIntent("我花了半天整理仓库，之后又待了一会儿。");
  assert.ok(intent.timeWords.includes("半天"), "命中 半天");
  assert.ok(intent.timeWords.includes("一会儿"), "命中 一会儿");
  assert.equal(intent.suggestedPeriods, 3, "取最大（半天=3）");
});

test("抽取：动作连接词计数（软参考）", () => {
  const intent = extractAtlasTimeIntent("起身穿衣，然后洗漱，接着出门，最后锁门。");
  assert.equal(intent.actionMarkers.length, 3, "然后/接着/最后");
  assert.equal(intent.estimatedActions, 4, "动作数 = 连接词 + 1");
});

test("抽取：无时间线索 → 零结果；模糊词不参与", () => {
  const none = extractAtlasTimeIntent("我看看窗外。");
  assert.equal(none.suggestedPeriods, null, "无时间词");
  assert.equal(none.actionMarkers.length, 0, "无连接词");
  const vague = extractAtlasTimeIntent("过了很久很久，一段时间之后。");
  assert.equal(vague.suggestedPeriods, null, "「很久」「一段时间」是模糊词，不入硬表");
});

test("提示行：有线索才渲染，无线索为 null", () => {
  const hint = renderAtlasTimeHint("坐下来喝了一会儿茶，然后翻账本。");
  assert.ok(hint && hint.startsWith("〔时间估计〕"), "提示行格式");
  assert.ok(hint.includes("一会儿"), "含命中的时间词");
  assert.equal(renderAtlasTimeHint("我看看窗外。"), null, "无线索 → null");
});

test("裁决：显式时间词顶起 AI 低估的 duration", () => {
  const world = fixtureWorld();
  const result = adjudicateAtlasDraft(world, {
    branchId: null,
    currentPointId: "1",
    userText: "我花了半天清点货物。",
    draft: draft({ duration: 1, rawEffects: [{ kind: "setTemporalField", entityId: "char-main", key: "mood", value: "疲惫" }] }),
  });
  assert.equal(result.draft.duration, 3, "半天 → 至少 3 时段");
  assert.ok(result.notes.some((n) => n.includes("半天")), "裁定说明");
});

test("裁决：AI 给的时段已充足时不加注", () => {
  const world = fixtureWorld();
  const result = adjudicateAtlasDraft(world, {
    branchId: null,
    currentPointId: "1",
    userText: "我花了半天清点货物。",
    draft: draft({ duration: 5 }),
  });
  assert.equal(result.draft.duration, 5, "AI 时段保留");
  assert.deepEqual(result.notes, [], "无裁定");
});

test("裁决：有世界变化但 AI 给 0 → 保底 1 时段；纯无变化回合不受影响", () => {
  const world = fixtureWorld();
  const bumped = adjudicateAtlasDraft(world, {
    branchId: null,
    currentPointId: "1",
    draft: draft({ duration: 0, rawEffects: [{ kind: "setTemporalField", entityId: "char-main", key: "mood", value: "平静" }] }),
  });
  assert.equal(bumped.draft.duration, 1, "变化必有时间流动");
  assert.ok(bumped.notes.some((n) => n.includes("保底")), "裁定说明");
  const untouched = adjudicateAtlasDraft(world, {
    branchId: null,
    currentPointId: "1",
    draft: draft({ duration: 0 }),
  });
  assert.equal(untouched.draft.duration, 0, "无变化回合保持 0（无事发生）");
  assert.deepEqual(untouched.notes, [], "不裁定");
});
