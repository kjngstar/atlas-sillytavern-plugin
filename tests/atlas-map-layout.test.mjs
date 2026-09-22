/**
 * atlas-map-layout.test.mjs — 0.9.49（外部 AI 计划 M03 等比坐标变换 + M02 子图投影）。
 *
 * - computeMapLayout：单一 cellPx 等比 contain 拟合（旧 toPercent 横纵分别拉满
 *   会把正方形世界拉成长方形——几何真 bug）；坐标往返、距离比保持。
 * - MAP13 / MAP14 / MAP15 的数学子集：窗口变形不改角度与距离比例；
 *   筛选与新增地点不改变既有点间实际距离。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { computeMapLayout } from "../index.js";

test("布局：单一 cellPx 等比 contain（正方形世界在宽视口不变形）", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 10 },
  ];
  const layout = computeMapLayout(points, 800, 400);
  assert.equal(layout.spanX, layout.spanY, "正方形世界 span 相等");
  // contain：受限轴是高度 400 → cellPx = 400 / spanY
  assert.equal(layout.cellPx, 400 / layout.spanY, "cellPx 由受限轴决定");
  assert.equal(layout.widthPx, layout.heightPx, "正方形世界显示为正方形（旧实现会被拉成长方形）");
  // 横向留白居中
  assert.ok(layout.offsetX > 0, "宽视口横向留白居中");
  assert.equal(layout.offsetY, 0, "受限轴无留白");
});

test("布局：MAP13 坐标往返——toPixel 相对距离保持世界距离比例", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 0, y: 5 },
  ];
  const layout = computeMapLayout(points, 800, 420);
  const a = layout.toPixel(2, 1);
  const b = layout.toPixel(6, 1);
  const c = layout.toPixel(2, 3);
  const distAB = Math.abs(b.left - a.left);
  const distAC = Math.abs(c.top - a.top);
  // 世界距离：A→B = 4 格；A→C = 2 格 → 屏幕距离比必须 2:1（旧实现两轴分别拉伸会破坏该比例）
  assert.ok(Math.abs(distAB / distAC - 2) < 1e-9, `屏幕距离比 = 世界距离比（实际 ${distAB / distAC}）`);
  assert.ok(Math.abs((distAB / 4) - layout.cellPx) < 1e-9, "每格像素数 = cellPx");
});

test("布局：MAP14 非等比窗口 resize——点间比例不变（只改 cellPx）", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 8, y: 6 },
  ];
  const wide = computeMapLayout(points, 1000, 400);
  const tall = computeMapLayout(points, 400, 900);
  // 同一世界的两点屏幕距离比恒为 10:8:6 的勾股比，无论窗口形状
  const ratio = (layout) => {
    const a = layout.toPixel(0, 0);
    const b = layout.toPixel(8, 6);
    return Math.hypot(b.left - a.left, b.top - a.top) / layout.cellPx;
  };
  assert.ok(Math.abs(ratio(wide) - 10) < 1e-9, "宽视口下世界距离 = 10 格");
  assert.ok(Math.abs(ratio(tall) - 10) < 1e-9, "窄视口下世界距离仍 = 10 格");
});

test("布局：MAP15 筛选（子集渲染）不改变剩余点的实际距离", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
  ];
  const full = computeMapLayout(points, 800, 600);
  const filtered = computeMapLayout([points[0], points[2]], 800, 600);
  // 筛选后 bounds 变化 → cellPx 变化是 fit 的正常行为；但同两点间的格程恒为 4√2
  const gridDist = (layout, a, b) => {
    const p1 = layout.toPixel(a.x, a.y);
    const p2 = layout.toPixel(b.x, b.y);
    return Math.hypot(p2.left - p1.left, p2.top - p1.top) / layout.cellPx;
  };
  const d1 = gridDist(full, points[0], points[2]);
  const d2 = gridDist(filtered, points[0], points[2]);
  assert.ok(Math.abs(d1 - 4 * Math.SQRT2) < 1e-9, "全量视图：格程 4√2");
  assert.ok(Math.abs(d2 - 4 * Math.SQRT2) < 1e-9, "筛选视图：格程仍 4√2（显示缩放不改世界距离）");
});

test("布局：极端大 span 有 cellPx 下限（不塌缩到不可点）", () => {
  const points = [{ x: 0, y: 0 }, { x: 100000, y: 0 }];
  const layout = computeMapLayout(points, 800, 400);
  assert.equal(layout.cellPx, 20, "下限 20px/格");
});

test("布局：jsdom 零尺寸视口回退默认值（320×240 起步）", () => {
  const points = [{ x: 0, y: 0 }, { x: 5, y: 5 }];
  const layout = computeMapLayout(points, 0, 0);
  assert.equal(layout.viewW, 320, "回退宽 320");
  assert.equal(layout.viewH, 240, "回退高 240");
  assert.ok(layout.cellPx > 0, "cellPx 仍有效");
});
