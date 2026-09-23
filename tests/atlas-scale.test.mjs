/**
 * atlas-scale.test.mjs — 0.9.50（外部 AI 计划 M04/M05：地图尺度标定 + 动态比例尺条）。
 *
 * - validateScaleResponse：程序从 frame（100×100 等距方格）推导规范 metersPerCell，
 *   模型不自报第二份每格距离；1% 相对容差吸收取整；拒绝负值 / 零 / 非有限数 /
 *   字符串伪数值；unknown / conflict 不落标定。
 * - computeScaleBar：候选 D = 1、2、5 × 10^n，80-160px 窗口，条长按真实值绘制
 *   （计划 9.1 的已知例子：S=50 米、P=40 像素 → 100 米宽 80 像素；放大两倍 160 像素）。
 * - formatDistanceMeters：米 / 公里自动（极小图到厘米）。
 * - sanitizeCalibration：sidecar 形状不可信，坏值丢弃。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { validateScaleResponse, computeScaleBar, formatDistanceMeters, sanitizeCalibration } from "../src/atlas-scale.ts";
import { computeScaleBar as uiComputeScaleBar, formatDistanceMeters as uiFormatDistanceMeters } from "../index.js";

const FRAME = { cols: 100, rows: 100 };

test("标定校验：estimated + 等距宽高 → 程序推导 metersPerCell", () => {
  const result = validateScaleResponse(
    { status: "estimated", coverage: "镇中心", extentMeters: { width: 6000, height: 6000 }, basis: "城墙描述", confidence: "medium" },
    FRAME,
  );
  assert.ok(result.ok);
  assert.equal(result.calibration.metersPerCell, 60);
  assert.equal(result.calibration.source, "ai-estimated");
  assert.equal(result.calibration.locked, false);
  assert.equal(result.calibration.coverage, "镇中心");
});

test("标定校验：1% 相对容差内取整误差通过（6000 vs 5990 → 0.17%）", () => {
  const result = validateScaleResponse({ status: "estimated", extentMeters: { width: 6000, height: 5990 } }, FRAME);
  assert.ok(result.ok);
  assert.equal(result.calibration.metersPerCell, 60);
});

test("标定校验：超 1% 容差 → conflict 不落标定（不静默取平均）", () => {
  const result = validateScaleResponse({ status: "estimated", extentMeters: { width: 6000, height: 5800 } }, FRAME);
  assert.ok(!result.ok);
  assert.equal(result.status, "conflict");
  assert.ok(result.reason.includes("1% 容差"));
});

test("标定校验：unknown / conflict 状态直接不落", () => {
  for (const status of ["unknown", "conflict"]) {
    const result = validateScaleResponse({ status, coverage: "c", basis: "b" }, FRAME);
    assert.ok(!result.ok);
    assert.equal(result.status, status);
  }
});

test("标定校验：拒绝 0 / 负数 / 非有限数 / 字符串伪数值 / 缺 extent", () => {
  const bads = [
    { extentMeters: { width: 0, height: 6000 } },
    { extentMeters: { width: -6000, height: 6000 } },
    { extentMeters: { width: Number.POSITIVE_INFINITY, height: 6000 } },
    { extentMeters: { width: "6000", height: 6000 } },
    { extentMeters: { width: NaN, height: 6000 } },
    {},
    { extentMeters: null },
  ];
  for (const spec of bads) {
    const result = validateScaleResponse(spec, FRAME);
    assert.ok(!result.ok, `应拒绝 ${JSON.stringify(spec)}`);
    assert.equal(result.status, "invalid");
  }
});

test("标定校验：非对象响应 / 非法 frame 拒绝", () => {
  assert.ok(!validateScaleResponse("not json", FRAME).ok);
  assert.ok(!validateScaleResponse(null, FRAME).ok);
  assert.ok(!validateScaleResponse({ extentMeters: { width: 6000, height: 6000 } }, { cols: 0, rows: 100 }).ok);
});

test("标尺条：计划 9.1 已知例子 S=50 米 P=40px → 100 米条 80px；放大两倍 → 160px", () => {
  const base = computeScaleBar({ metersPerCell: 50, cellPx: 40, zoom: 1 });
  // metersPerPixel = 1.25；候选里 100 米 = 80px（窗口内），50 米 = 40px（窗外小），200 米 = 160px（窗口边缘）
  assert.ok(base.distanceMeters >= 80 * 1.25 && base.distanceMeters <= 160 * 1.25, "选中候选条长在窗口内");
  assert.ok(Math.abs(base.barWidthPx - base.distanceMeters / 1.25) < 1e-9, "条长 = 距离 / metersPerPixel（真实值）");
  const zoomed = computeScaleBar({ metersPerCell: 50, cellPx: 40, zoom: 2 });
  // 放大两倍 metersPerPixel=0.625：50 米→80px 与 100 米→160px 同为窗口合法候选
  //（gap 平手取先到者）——计划允许「选另一个更合适的 D，但标签和长度必须对应」
  assert.ok(zoomed.barWidthPx >= 80 && zoomed.barWidthPx <= 160, "放大后条长仍在窗口内");
  assert.ok(Math.abs(zoomed.barWidthPx - zoomed.distanceMeters / 0.625) < 1e-9, "标签与条长对应");
});

test("标尺条：候选只用 1-2-5 × 10^n", () => {
  const bar = computeScaleBar({ metersPerCell: 30, cellPx: 50, zoom: 1 });
  const exponent = Math.log10(bar.distanceMeters);
  const mantissa = Math.round(10 ** (exponent - Math.floor(exponent)) * 10) / 10;
  assert.ok([1, 2, 5].includes(Math.round(mantissa)), `候选 ${bar.distanceMeters} 米必须是 1/2/5×10^n（mantissa=${mantissa}）`);
});

test("标尺条：极端尺度（房间毫米级 / 大陆千公里级）仍有可用候选", () => {
  const room = computeScaleBar({ metersPerCell: 0.05, cellPx: 60, zoom: 1 });
  assert.ok(room && room.barWidthPx > 0, "极小图有候选");
  const continent = computeScaleBar({ metersPerCell: 3000000, cellPx: 25, zoom: 0.5 });
  assert.ok(continent && continent.barWidthPx > 0, "极大陆有候选");
});

test("标尺条：非法输入返回 null（未标定时不画伪物理条）", () => {
  for (const input of [
    { metersPerCell: 0, cellPx: 40, zoom: 1 },
    { metersPerCell: 50, cellPx: 0, zoom: 1 },
    { metersPerCell: 50, cellPx: 40, zoom: 0 },
    { metersPerCell: "50", cellPx: 40, zoom: 1 },
    { metersPerCell: Number.NaN, cellPx: 40, zoom: 1 },
  ]) {
    assert.equal(computeScaleBar(input), null, JSON.stringify(input));
  }
});

test("距离显示：厘米 / 米 / 公里自动", () => {
  assert.equal(formatDistanceMeters(0.5), "50 厘米");
  assert.equal(formatDistanceMeters(50), "50 米");
  assert.equal(formatDistanceMeters(62.5), "62.5 米");
  assert.equal(formatDistanceMeters(1500), "1.5 公里");
  assert.equal(formatDistanceMeters(3000000), "3000 公里");
  assert.equal(formatDistanceMeters(0), "");
  assert.equal(formatDistanceMeters(Number.NaN), "");
});

test("sidecar 标定清洗：坏形状拒绝、非法来源降 legacy、revision/at 兜底", () => {
  assert.equal(sanitizeCalibration(null), null);
  assert.equal(sanitizeCalibration({ metersPerCell: "60" }), null);
  const cleaned = sanitizeCalibration({ revision: -3, metersPerCell: 60.123, source: "bogus", locked: "yes", at: "x" });
  assert.ok(cleaned);
  assert.equal(cleaned.source, "legacy");
  assert.equal(cleaned.locked, false, "locked 只认 true");
  assert.equal(cleaned.revision, 0, "非法 revision 兜底 0");
  assert.equal(cleaned.at, 0, "非法 at 兜底 0");
  assert.equal(cleaned.metersPerCell, 60.12);
});

test("UI 与 server 两侧标尺算法零漂移（同名纯函数断言一致）", () => {
  for (const input of [
    { metersPerCell: 50, cellPx: 40, zoom: 1 },
    { metersPerCell: 60, cellPx: 33, zoom: 1.5 },
    { metersPerCell: 0.05, cellPx: 60, zoom: 2 },
    { metersPerCell: 3000000, cellPx: 25, zoom: 0.5 },
  ]) {
    assert.deepEqual(uiComputeScaleBar(input), computeScaleBar(input), JSON.stringify(input));
  }
  assert.equal(uiFormatDistanceMeters(62.5), formatDistanceMeters(62.5));
  assert.equal(uiFormatDistanceMeters(3000000), formatDistanceMeters(3000000));
});


test("tiny positive calibration values remain positive and render without zero centimeters", () => {
  const result = validateScaleResponse(
    { status: "estimated", coverage: "微型图", extentMeters: { width: 0.1, height: 0.1 }, basis: "明确长度", confidence: "low" },
    FRAME,
  );
  assert.ok(result.ok);
  assert.equal(result.calibration.metersPerCell, 0.001);
  assert.equal(sanitizeCalibration({ metersPerCell: 0.001 }).metersPerCell, 0.001);
  assert.match(formatDistanceMeters(0.001), /毫米/);
  assert.match(uiFormatDistanceMeters(0.001), /毫米/);
});
