/**
 * atlas-nearby-semantics.test.mjs — F05 定向验收（「附近」口径）。
 *
 * 对照计划 §2.4：
 *  - 「尚未确定当前位置」与「附近确实没人」是**两件事**，必须分开表达（T09）；
 *  - 地点弹窗是「你点开的那个地点实际在场的人」，即使玩家离得很远也能作为作者信息查看，
 *    **不冒充「附近」**；
 *  - 存在 place 但无当前位置时，不得把地点弹窗内容误判成跨聊天缓存。
 *
 * `atlasDiagnoseEmptyNearby` 是 index.js 的具名导出（纯函数），这里直接对它断言。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// index.js 是浏览器壳，导入前需要最小 DOM 环境（与 atlas-mount-smoke 同做法）
const dom = new JSDOM("<!doctype html><head></head><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;

// index.js 本身已经 `export function atlasDiagnoseEmptyNearby`，直接导入即可（不要再 export 一次）
const source = readFileSync(join(root, "index.js"), "utf8");
const { atlasDiagnoseEmptyNearby } = await import(
  "data:text/javascript;base64," + Buffer.from(source).toString("base64")
);

test("F05 服务端具名原因优先：CURRENT_LOCATION_UNKNOWN 就是「不知道自己在哪」", () => {
  // 即使 /state 里 currentLocationId 有值，只要 F02 的权威原因说未知，就必须按未知表达
  const unknown = atlasDiagnoseEmptyNearby({
    currentLocationId: "4103",
    nearReasonCode: "CURRENT_LOCATION_UNKNOWN",
    tableNearbyEntries: [],
  });
  assert.equal(unknown.case, "current-location-unknown");
  assert.match(unknown.message, /尚未确定当前位置/, "必须明说当前位置未定");
  assert.ok(!/暂无/.test(unknown.message), "不得下「附近没人」的结论");
});

test("F05 当前位置为空（旧 /state 无 nearReasonCode）也按未知表达", () => {
  const legacy = atlasDiagnoseEmptyNearby({ currentLocationId: null, tableNearbyEntries: [] });
  assert.equal(legacy.case, "current-location-unknown");
  assert.match(legacy.message, /尚未确定当前位置/);
});

test("F05 当前地点确实有人 → 说「可在地点弹窗查看」，而不是「附近没人」", () => {
  const samePlace = atlasDiagnoseEmptyNearby({
    currentLocationId: "4103",
    nearReasonCode: null,
    tableNearbyEntries: [
      { id: "npc:1", locationId: "loc:4103", presence: "present" },
      { id: "npc:2", locationId: "loc:4103", presence: "left" },
    ],
  });
  assert.equal(samePlace.case, "same-location-has-people");
  assert.equal(samePlace.persons, 1, "离场者不计入在场");
  assert.match(samePlace.message, /地点/, "指引到地点弹窗");
});

test("F05 当前位置已知且该地点真没人 → 才说「附近暂无已确认人物」", () => {
  const empty = atlasDiagnoseEmptyNearby({
    currentLocationId: "4103",
    nearReasonCode: null,
    tableNearbyEntries: [{ id: "npc:far", locationId: "loc:9999", presence: "present" }],
  });
  assert.equal(empty.case, "no-confirmed-people");
  assert.match(empty.message, /暂无已确认人物/);
});

test("F05 主角不冒充附近 NPC", () => {
  const withProtagonist = atlasDiagnoseEmptyNearby({
    currentLocationId: "4103",
    tableNearbyEntries: [{ id: "npc:main", locationId: "loc:4103", presence: "present", isProtagonist: true }],
  });
  assert.equal(withProtagonist.case, "no-confirmed-people", "主角不算「附近的人」");
});
