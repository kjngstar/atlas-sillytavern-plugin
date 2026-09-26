/** 现行建图标定校验与标尺格式化回归测试。 */
import test from "node:test";
import assert from "node:assert/strict";
import { validateScaleResponse, computeScaleBar, formatDistanceMeters } from "../src/atlas-scale.ts";

// ---- T9：validateScaleResponse 拒绝负值 / 零 / 字符串伪数值 ----
test("R10-T9: validateScaleResponse rejects bad numerics", () => {
  // 直接调函数做契约测试
  const bad1 = validateScaleResponse({ status: "estimated", extentMeters: { width: 0, height: 100 }, coverage: "", basis: "" }, { cols: 100, rows: 100 });
  assert.equal(bad1.ok, false);
  assert.equal(bad1.status, "invalid");

  const bad2 = validateScaleResponse({ status: "estimated", extentMeters: { width: -10, height: 100 }, coverage: "", basis: "" }, { cols: 100, rows: 100 });
  assert.equal(bad2.ok, false);

  const bad3 = validateScaleResponse({ status: "estimated", extentMeters: { width: "100", height: 100 }, coverage: "", basis: "" }, { cols: 100, rows: 100 });
  assert.equal(bad3.ok, false);
  assert.ok(bad3.reason.includes("正的有限数字"));
});

// ---- T10：computeScaleBar 选标尺距离 ----
test("R10-T10: computeScaleBar picks distance in 80-160px window", () => {
  // 1 格 = 50 米，cellPx = 20px → 50/20 = 2.5 米/像素
  // 想让 100 米 → 100/2.5 = 40 px（窗外偏小），50 米 → 20 px（窗外）
  // 250 米 → 100 px（窗内首选附近）
  const result = computeScaleBar({ metersPerCell: 50, cellPx: 20, zoom: 1 });
  assert.ok(result !== null);
  assert.ok(result.barWidthPx >= 80 && result.barWidthPx <= 160, `标尺应在 80-160 px，actual=${result.barWidthPx}`);
});

// ---- T11：formatDistanceMeters 自动单位 ----
test("R10-T11: formatDistanceMeters auto unit", () => {
  assert.equal(formatDistanceMeters(0.5), "50 厘米");
  assert.equal(formatDistanceMeters(50), "50 米");
  assert.equal(formatDistanceMeters(1500), "1.5 公里");
  assert.equal(formatDistanceMeters(0), "");
  assert.equal(formatDistanceMeters(-1), "");
});