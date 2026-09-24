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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// C5：权威实现只有这一处（src/atlas-scale.ts）。旧用例另外从 ../index.js 导入副本
// 做「双实现一致」断言，等于把重复实现固化成契约；副本已删除。
import {
  validateScaleResponse,
  computeScaleBar,
  computeViewportScaleBar,
  formatDistanceMeters,
  formatFixedScaleDistance,
  readScaleCalibration,
  scaleCalibrationKey,
  formatTravelDistance,
  sanitizeCalibration,
  SCALE_BAR_FIXED_PX,
} from "../src/atlas-scale.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

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

test("C5：比例尺只有一份权威实现，浏览器入口确实接线到它", async () => {
  // 旧用例维护「index.js 副本 === atlas-scale.ts」的双实现对比，等于把重复实现
  // 固化成契约；C5 已删除 index.js 的副本，这里改为验证接线：
  // 浏览器入口暴露的就是权威实现本身（引用相等），且产物不含第二套算法。
  const entry = await import("../src/atlas-browser-entry.ts");
  assert.equal(typeof entry.computeScaleBar, "function", "入口导出 computeScaleBar");
  assert.equal(typeof entry.formatDistanceMeters, "function", "入口导出 formatDistanceMeters");
  assert.equal(typeof entry.formatTravelDistance, "function", "入口导出 formatTravelDistance");
  assert.equal(entry.computeScaleBar, computeScaleBar, "入口导出的是同一函数引用（无第二套实现）");
  assert.equal(entry.formatDistanceMeters, formatDistanceMeters, "同一函数引用");
  assert.equal(entry.formatTravelDistance, formatTravelDistance, "同一函数引用");

  // index.js 不再自带副本：源码内不应再出现函数定义
  const indexSource = readFileSync(join(root, "index.js"), "utf8");
  for (const fn of ["function computeScaleBar", "function formatDistanceMeters", "function formatTravelDistance"]) {
    assert.ok(!indexSource.includes(fn), `index.js 不得再定义 ${fn}`);
  }
  assert.ok(indexSource.includes("computeScaleBar,"), "index.js 从 mod 解构 computeScaleBar");
  assert.ok(!/export \{ computeScaleBar/.test(indexSource), "index.js 不再转出该算法");
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
});

/* ------------------------------------------------------------------ *
 * H23：unknown / conflict / 缺依据 —— 明确拒绝，绝不猜米数
 *
 * 计划 H23：「模型给 unknown / conflict、以及完全没有 API 时，地图仍然能建出来
 * 并按未标定显示」。纯函数这一半的硬要求是：被拒的标定**不能**留下任何
 * metersPerCell —— 连一个可以误用的候选值都不许有（T25 停机线：
 * 「模型标定把 unknown 当米制」）。端到端那一半见 tests/atlas-scale-pending.test.mjs。
 * ------------------------------------------------------------------ */

/** 被拒的标定结果里不得存在任何米数（连候选都不能留）。 */
function assertNoMeters(result, label) {
  assert.equal(result.ok, false, `${label}：必须明确拒绝`);
  assert.equal(result.calibration, undefined,
    `${label}：拒绝的结果不得带 calibration（不能猜一个米数）`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "calibration"), false,
    `${label}：连 calibration 键都不该出现`);
  assert.ok(!/"metersPerCell"/.test(JSON.stringify(result)),
    `${label}：序列化结果里不得出现 metersPerCell`);
}

test("H23：status=unknown / conflict → 明确拒绝且无任何米数（calibration 为空）", () => {
  for (const status of ["unknown", "conflict"]) {
    const result = validateScaleResponse(
      { status, coverage: "只有名字，没有尺度依据", basis: "材料不足", confidence: "low", extentMeters: null },
      FRAME,
    );
    assertNoMeters(result, `status=${status}`);
    assert.equal(result.status, status, "拒绝原因如实回报模型给的状态");
    assert.equal(result.coverage, "只有名字，没有尺度依据", "拒绝也带回可读的解释字段");
    assert.ok(result.reason.length > 0, "必须给出可读的拒绝原因");

    // 即使模型在 unknown / conflict 时**仍然**塞了 extent，也不许换算成米
    const withExtent = validateScaleResponse(
      { status, extentMeters: { width: 6000, height: 6000 } },
      FRAME,
    );
    assertNoMeters(withExtent, `status=${status} + 附带 extent`);
  }

  // 边界：status=conflict 也必须与「estimated 但宽高互斥」走同一条拒绝路径
  const inconsistent = validateScaleResponse(
    { status: "estimated", extentMeters: { width: 6000, height: 5800 } },
    FRAME,
  );
  assertNoMeters(inconsistent, "estimated 但超 1% 容差");
  assert.equal(inconsistent.status, "conflict", "不一致归 conflict");

  // 对照：同一 frame 下 estimated 合法值照常通过（拒绝不是因为 frame 有问题）
  const good = validateScaleResponse({ status: "estimated", extentMeters: { width: 6000, height: 6000 } }, FRAME);
  assert.equal(good.ok, true);
  assert.equal(good.calibration.metersPerCell, 60);
});

test("H23：完全没有可用标定依据时，调用方只应得到「未标定 · 按格」而不是 1 米/格", () => {
  // 串联三段：拒绝 → 未落标定（sidecar 里没有记录）→ 固定尺只报格数
  const rejected = validateScaleResponse({ status: "unknown", extentMeters: null }, FRAME);
  assertNoMeters(rejected, "unknown");

  const calibrations = {};
  const read = readScaleCalibration(calibrations, "canon", "world");
  assert.equal(read.status, "missing", "没落标定就是 missing，不伪造记录");
  assert.equal(read.calibration, null);

  const bar = computeViewportScaleBar({ cameraK: 10, metersPerCell: read.calibration?.metersPerCell ?? null, viewportWidth: 1200 });
  assert.equal(bar.distanceMeters, null, "未标定不得给米数");
  assert.equal(bar.unitMode, "cells");
  assert.match(bar.label, /未标定/);
  assert.equal(bar.barWidthPx, SCALE_BAR_FIXED_PX, "尺长仍然固定，读数退化但控件不消失");
});

/* ------------------------------------------------------------------ *
 * H17 / H23：左下角固定长度动态标尺
 * ------------------------------------------------------------------ */

test("H17：固定条 96px，100 米/格 —— k=10→960米、k=20→480米、k=5→1.92千米", () => {
  const at = (k) => computeViewportScaleBar({ cameraK: k, metersPerCell: 100, viewportWidth: 1200 });

  const k10 = at(10);
  assert.equal(k10.barWidthPx, SCALE_BAR_FIXED_PX, "线条长度固定 96 CSS px");
  assert.equal(k10.distanceMeters, 960);
  assert.equal(k10.unitMode, "meters");
  assert.match(k10.label, /960\s*米/);

  const k20 = at(20);
  assert.equal(k20.barWidthPx, SCALE_BAR_FIXED_PX, "放大后线长不变");
  assert.equal(k20.distanceMeters, 480, "放大 2 倍 → 读数减半");
  assert.match(k20.label, /480\s*米/);

  const k5 = at(5);
  assert.equal(k5.distanceMeters, 1920);
  assert.match(k5.label, /1\.92\s*千米/, "3 位有效数字，不写成 1.9 千米");

  // 缩放只改读数：k 翻倍 → 距离精确减半
  assert.equal(at(10).distanceMeters / at(20).distanceMeters, 2);
});

test("H17：未标定只报格数（9.6 → 4.8 格），绝不显示假米数", () => {
  const uncalibrated = (k, metersPerCell = null) =>
    computeViewportScaleBar({ cameraK: k, metersPerCell, viewportWidth: 1200 });

  const k10 = uncalibrated(10);
  assert.equal(k10.barWidthPx, SCALE_BAR_FIXED_PX);
  assert.equal(k10.distanceMeters, null, "未标定不得给米数");
  assert.equal(k10.unitMode, "cells");
  assert.equal(Number(k10.distanceCells.toFixed(2)), 9.6);
  assert.match(k10.label, /9\.6\s*格/);
  assert.match(k10.label, /未标定/);

  const k20 = uncalibrated(20);
  assert.equal(Number(k20.distanceCells.toFixed(2)), 4.8, "放大 2 倍 → 格数减半");
  assert.equal(k20.barWidthPx, SCALE_BAR_FIXED_PX, "长度始终 96px");

  // 非法 metersPerCell 一律按未标定处理，不填 1 米/格
  for (const bad of [null, undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const bar = uncalibrated(10, bad);
    assert.equal(bar.distanceMeters, null, `metersPerCell=${String(bad)} 不得产出米数`);
    assert.equal(bar.unitMode, "cells");
  }
});

test("H17：k ≤ 0 / NaN 返回 null；窄视口降到 64px 但不消失", () => {
  assert.equal(computeViewportScaleBar({ cameraK: 0, metersPerCell: 100 }), null);
  assert.equal(computeViewportScaleBar({ cameraK: -3, metersPerCell: 100 }), null);
  assert.equal(computeViewportScaleBar({ cameraK: Number.NaN, metersPerCell: 100 }), null);
  assert.equal(computeViewportScaleBar({ cameraK: Number.POSITIVE_INFINITY, metersPerCell: 100 }), null);

  // 320px 宽：min(96, 320-48=272) → 96
  assert.equal(computeViewportScaleBar({ cameraK: 10, metersPerCell: 100, viewportWidth: 320 }).barWidthPx, 96);
  // 100px 宽：min(96, 52) → 52，但下限 64 兜住
  assert.equal(computeViewportScaleBar({ cameraK: 10, metersPerCell: 100, viewportWidth: 100 }).barWidthPx, 64);
  // 完全没有视口信息时按标准 96 处理
  assert.equal(computeViewportScaleBar({ cameraK: 10, metersPerCell: 100 }).barWidthPx, 96);
});

test("H17：可访问文案说的是「屏幕 N 像素约等于 X」，不是「X 米/格」", () => {
  const bar = computeViewportScaleBar({ cameraK: 10, metersPerCell: 100, viewportWidth: 1200 });
  assert.match(bar.ariaLabel, /屏幕 96 像素约等于/);
  assert.match(bar.ariaLabel, /960\s*米/);
  assert.ok(!bar.ariaLabel.includes("米/格"), "不得把固定尺读成每格米数");

  const cells = computeViewportScaleBar({ cameraK: 10, metersPerCell: null, viewportWidth: 1200 });
  assert.match(cells.ariaLabel, /未标定/);
});

test("H17：同一 k 的读数与标定无关地确定性复现；换算只影响读数不改比例", () => {
  // 世界图 100 米/格 与教室图 5 米/格：同一 k 下读数按标定等比缩放，长度都是 96px
  const world = computeViewportScaleBar({ cameraK: 10, metersPerCell: 100, viewportWidth: 1200 });
  const room = computeViewportScaleBar({ cameraK: 10, metersPerCell: 5, viewportWidth: 1200 });
  assert.equal(world.barWidthPx, room.barWidthPx);
  assert.equal(world.distanceMeters / room.distanceMeters, 20, "两张图各用自己的标定，互不继承");
  assert.equal(world.distanceCells, room.distanceCells, "格数只由 k 决定");
});

test("H17：formatFixedScaleDistance 用 3 位有效数字并自动换单位", () => {
  assert.equal(formatFixedScaleDistance(960), "960 米");
  assert.equal(formatFixedScaleDistance(1920), "1.92 千米");
  assert.equal(formatFixedScaleDistance(0.96), "96 厘米");
  assert.equal(formatFixedScaleDistance(0.0005), "0.5 毫米");
  assert.equal(formatFixedScaleDistance(0), "");
  assert.equal(formatFixedScaleDistance(-1), "");
  assert.equal(formatFixedScaleDistance(Number.NaN), "");
});

/* ------------------------------------------------------------------ *
 * H18e / H09：标定的分支作用域键
 * ------------------------------------------------------------------ */

test("H18e 作用域键：正史沿用旧的 mapId 键（0.9.58 存档照读），IF 用 branchKey|mapId", () => {
  assert.equal(scaleCalibrationKey("canon", "world"), "world", "正史沿用旧键，旧标定不丢（T29）");
  assert.equal(scaleCalibrationKey("canon", "9001"), "9001", "子图同理");
  assert.equal(scaleCalibrationKey("", "world"), "world", "没有分支信息也按旧键读");
  assert.equal(scaleCalibrationKey("story-if", "world"), "story-if|world", "IF 分支独立成键");
  assert.equal(scaleCalibrationKey("story-if", "9001"), "story-if|9001");
  // 两张图各自标一次：教室的键与城市不同，互不覆盖（T27）
  assert.notEqual(scaleCalibrationKey("canon", "9001"), scaleCalibrationKey("canon", "world"));
});

test("H18e 读取：IF 重标不覆盖正史；旧真标定照读；损坏与缺失分开报", () => {
  const calibrations = {
    // 0.9.58 存档形状：canon 的键就是 mapId
    world: { revision: 3, metersPerCell: 100, source: "user", locked: true, at: 1, coverage: "全图", basis: "人工" },
    "story-if|world": { revision: 1, metersPerCell: 5, source: "user", locked: true, at: 2, coverage: "IF", basis: "人工" },
    // canon 的键就是裸 mapId，所以子图 9001 的坏记录也挂在 "9001" 上
    "9001": { revision: 1, metersPerCell: "坏值", source: "user", locked: true, at: 3, coverage: "x", basis: "y" },
  };

  const canonWorld = readScaleCalibration(calibrations, "canon", "world");
  assert.equal(canonWorld.status, "ok");
  assert.equal(canonWorld.key, "world", "读的是旧键");
  assert.equal(canonWorld.calibration.metersPerCell, 100, "旧真标定照读");

  const ifWorld = readScaleCalibration(calibrations, "story-if", "world");
  assert.equal(ifWorld.calibration.metersPerCell, 5, "IF 读自己的键");
  assert.notEqual(ifWorld.calibration.metersPerCell, canonWorld.calibration.metersPerCell,
    "两个分支同一张图的标定互不影响（T12）");

  // 缺失与损坏必须分开：损坏要能保留原文并明确报错，而不是静默当「未标定」
  const missing = readScaleCalibration(calibrations, "story-if", "9001");
  assert.equal(missing.status, "missing");
  assert.equal(missing.calibration, null);

  const corrupt = readScaleCalibration(calibrations, "canon", "9001");
  assert.equal(corrupt.status, "corrupt", "键在但记录非法 = corrupt（不是 missing）");
  assert.equal(corrupt.calibration, null, "非法记录绝不进运行时");

  // 完全没有 calibrations 的旧世界 / 空分支键
  assert.equal(readScaleCalibration(null, "canon", "world").status, "missing");
  assert.equal(readScaleCalibration({}, "canon", "").status, "missing", "空 mapId 不产生键");
});
