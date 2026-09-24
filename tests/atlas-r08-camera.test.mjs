/**
 * atlas-r08-camera.test.mjs — R08 地图相机与手势回归测试。
 *
 * - 相机数学（src/atlas-map-camera.ts）：fitAll 无 20px 每格下限；宽图 / 长图 /
 *   负坐标 / 单点 / 空图均可看全；worldToScreen ↔ screenToWorld 往返误差 < 1e-9；
 *   光标缩放保持光标下世界点不动；回 100% 不清平移；标记反缩放。
 * - 手势状态机（src/atlas-map-interactions.ts）：阈值起拖；interactive 起手不拖图；
 *   suppressClick 不在 pointerup 提前清除，由 consumeClick 消费（旧 bug 回归门禁）；
 *   双指缩放因子与中点。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  computeMapFrame,
  emptyMapFrame,
  fitCamera,
  setCameraZoom,
  zoomCameraAtPoint,
  panCameraBy,
  centerCameraOn,
  worldToScreen,
  screenToWorld,
  cameraStageTransform,
  cameraZoomPercent,
  markerInverseScale,
} from "../src/atlas-map-camera.ts";
import {
  createPanGesture,
  createDragGesture,
  createPinchTracker,
} from "../src/atlas-map-interactions.ts";

const EPS = 1e-9;

test("相机：fitAll 无每格 20px 下限（大世界完整收入视口）", () => {
  // 旧实现 Math.max(20, …) → 20px/格下限把 10 万格世界撑出视口 200 万 px
  const frame = computeMapFrame([{ x: 0, y: 0 }, { x: 100000, y: 0 }]);
  const cam = fitCamera(frame, 800, 400);
  assert.ok(cam.k < 0.01, `大世界 fit 比例应远小于 20px/格（实际 ${cam.k}）`);
  const p1 = worldToScreen(cam, 0, 0, 800, 400);
  const p2 = worldToScreen(cam, 100000, 0, 800, 400);
  assert.ok(p1.x >= -EPS && p2.x <= 800 + EPS, "fitAll 后全图横向落在视口内");
});

test("相机：宽图 / 长图 / 负坐标 / 单点 / 空图 fitAll 均可看全", () => {
  const cases = [
    { points: [{ x: -500, y: -20 }, { x: 500, y: 20 }], vw: 1000, vh: 300 },
    { points: [{ x: -10, y: -300 }, { x: 10, y: 300 }], vw: 400, vh: 900 },
    { points: [{ x: -42, y: -17 }], vw: 800, vh: 600 },
    { points: [], vw: 800, vh: 600 },
  ];
  for (const c of cases) {
    const frame = computeMapFrame(c.points);
    const cam = fitCamera(frame, c.vw, c.vh);
    assert.ok(cam.k > 0, `比例 > 0（${JSON.stringify(c.points)}）`);
    for (const p of c.points.length > 0 ? c.points : [{ x: 0, y: 0 }]) {
      const s = worldToScreen(cam, p.x, p.y, c.vw, c.vh);
      assert.ok(s.x >= -1e-6 && s.x <= c.vw + 1e-6, `x 在视口内（${p.x} → ${s.x}）`);
      assert.ok(s.y >= -1e-6 && s.y <= c.vh + 1e-6, `y 在视口内（${p.y} → ${s.y}）`);
    }
    // frame 中心对准视口中心
    const center = worldToScreen(cam, cam.cx, cam.cy, c.vw, c.vh);
    assert.ok(Math.abs(center.x - c.vw / 2) < EPS && Math.abs(center.y - c.vh / 2) < EPS);
  }
});

test("相机：坐标往返误差在约定范围（world → screen → world < 1e-9）", () => {
  const frame = computeMapFrame([{ x: -30, y: -8 }, { x: 70, y: 55 }]);
  const cam = fitCamera(frame, 1024, 768);
  for (const [wx, wy] of [[0, 0], [-30, -8], [70, 55], [12.345, -67.89]]) {
    const s = worldToScreen(cam, wx, wy, 1024, 768);
    const back = screenToWorld(cam, s.x, s.y, 1024, 768);
    assert.ok(Math.abs(back.x - wx) < 1e-9 && Math.abs(back.y - wy) < 1e-9, `(${wx},${wy}) 往返一致`);
  }
});

test("相机：光标缩放保持光标下世界点不漂移", () => {
  const frame = computeMapFrame([{ x: 0, y: 0 }, { x: 100, y: 100 }]);
  let cam = fitCamera(frame, 800, 600);
  const sx = 213;
  const sy = 377;
  const worldBefore = screenToWorld(cam, sx, sy, 800, 600);
  cam = zoomCameraAtPoint(cam, sx, sy, 800, 600, 1.7);
  const worldAfter = screenToWorld(cam, sx, sy, 800, 600);
  assert.ok(Math.abs(worldAfter.x - worldBefore.x) < 1e-9, "光标下世界 x 不动");
  assert.ok(Math.abs(worldAfter.y - worldBefore.y) < 1e-9, "光标下世界 y 不动");
  // 已到边界再缩：比例夹到边界，不再越界（缩放范围 = 0.2× ~ 8× fit）
  const tiny = fitCamera(computeMapFrame([{ x: 0, y: 0 }, { x: 1, y: 1 }]), 800, 600);
  const maxed = zoomCameraAtPoint(tiny, 400, 300, 800, 600, 1e6);
  assert.ok(Math.abs(maxed.k - tiny.fitK * 8) < EPS, "超过上限夹到 8× fit");
  const minned = zoomCameraAtPoint(tiny, 400, 300, 800, 600, 1e-6);
  assert.ok(Math.abs(minned.k - tiny.fitK * 0.2) < EPS, "低于下限夹到 0.2× fit");
});

test("相机：setCameraZoom 只改比例，绝不清平移（旧 setZoom(1) 清 pan 的 bug 回归门禁）", () => {
  const frame = computeMapFrame([{ x: 0, y: 0 }, { x: 100, y: 100 }]);
  let cam = fitCamera(frame, 800, 600);
  cam = panCameraBy(cam, 120, -60);
  const shifted = cam;
  cam = setCameraZoom(cam, cam.fitK); // 回到 100%
  assert.equal(cam.cx, shifted.cx, "平移不被重置");
  assert.equal(cam.cy, shifted.cy, "平移不被重置");
  assert.equal(cam.k, shifted.fitK, "比例回到 100%");
  // 平移：屏幕位移按 k 换算世界位移
  const panned = panCameraBy(cam, 80, 0);
  assert.ok(Math.abs(panned.cx - (cam.cx - 80 / cam.k)) < EPS);
  // 定位：保持比例
  const centered = centerCameraOn(panned, 42, 21);
  assert.equal(centered.k, panned.k);
  assert.equal(centered.cx, 42);
});

test("相机：缩放百分比与标记反缩放（100% = fit 基准）", () => {
  const frame = computeMapFrame([{ x: 0, y: 0 }, { x: 100, y: 100 }]);
  let cam = fitCamera(frame, 800, 600);
  assert.ok(Math.abs(cameraZoomPercent(cam) - 100) < EPS, "fitAll = 100%");
  cam = setCameraZoom(cam, cam.fitK * 2);
  assert.ok(Math.abs(cameraZoomPercent(cam) - 200) < EPS);
  // R08 修正：反缩放 = 1/k → 标记视觉尺寸恒定（k × inv = 1，任何缩放档都如此）
  assert.ok(Math.abs(cam.k * markerInverseScale(cam) - 1) < EPS, "2× 时标记视觉恒定");
  const fitted = fitCamera(frame, 800, 600);
  assert.ok(Math.abs(fitted.k * markerInverseScale(fitted) - 1) < EPS, "fit 档标记视觉恒定（巨大化 bug 回归门禁）");
  // stage transform：screen = t + world*k
  const t = cameraStageTransform(cam, 800, 600);
  const w = { x: 37, y: 91 };
  const s = worldToScreen(cam, w.x, w.y, 800, 600);
  assert.ok(Math.abs(t.tx + w.x * t.k - s.x) < EPS && Math.abs(t.ty + w.y * t.k - s.y) < EPS);
});

test("手势：pan 超过阈值才启动；interactive 起手不拖图", () => {
  const g = createPanGesture({ threshold: 6 });
  assert.equal(g.down(10, 10, { interactive: true }), false, "按钮 / 输入框起手不启动");
  assert.equal(g.move(400, 400), null, "未启动时 move 无效");
  assert.equal(g.down(10, 10), true, "空白起手启动");
  assert.equal(g.move(13, 12), null, "阈值内不算 pan");
  const step = g.move(20, 14);
  assert.ok(step?.panning, "超过阈值进入 pan");
  const end = g.up();
  assert.equal(end.panned, true, "up 报告发生过 pan");
  assert.equal(g.consumeClick(), true, "pan 结束吞掉一次合成 click");
  assert.equal(g.consumeClick(), false, "只吞一次");
});

test("手势：suppressClick 不在 pointerup 提前清除（旧 bug 回归门禁）", () => {
  const g = createDragGesture();
  g.down(0, 0);
  g.move(20, 0); // 超阈值
  const end = g.up();
  assert.equal(end.dragged, true);
  // 旧实现：pointerup 清掉 suppressClick → 拖完松手 click 仍触发 onClick。
  // 新纪律：up 之后再 move/click 前的时间窗里 suppress 仍成立，由 consumeClick 消费。
  assert.equal(g.isDragging, false, "拖拽已结束");
  assert.equal(g.consumeClick(), true, "click 序：拖拽后合成 click 被吞");
  assert.equal(g.consumeClick(), false, "只吞一次");
  // 原地松手 = 点击：不吞
  const g2 = createDragGesture();
  g2.down(5, 5);
  assert.equal(g2.move(7, 6), null, "阈值内不算拖拽");
  assert.equal(g2.up().dragged, false);
  assert.equal(g2.consumeClick(), false, "普通点击放行");
});

test("手势：pointercancel 复位 suppress（cancel 后 click 不被误吞）", () => {
  const g = createPanGesture();
  g.down(0, 0);
  g.move(50, 50);
  g.cancel();
  assert.equal(g.consumeClick(), false, "cancel 清空 pan 标记（pointercancel 后无合成 click）");
  const d = createDragGesture();
  d.down(0, 0);
  d.move(30, 30);
  d.cancel();
  assert.equal(d.consumeClick(), false);
});

test("手势：双指缩放因子 = 距离比，中点为锚", () => {
  const pinch = createPinchTracker();
  assert.equal(pinch.down(1, 100, 200), null, "单指不产生缩放");
  const first = pinch.down(2, 200, 200);
  assert.ok(first === null || first.factor === 1, "第二指落下时因子为 1 或尚无输出");
  const spread = pinch.move(2, 300, 200); // 两指从 100px 拉开到 200px
  assert.ok(spread, "双指移动输出缩放");
  assert.ok(Math.abs(spread.factor - 2) < 1e-9, `因子 = 距离比（实际 ${spread.factor}）`);
  assert.ok(Math.abs(spread.x - 200) < 1e-9 && Math.abs(spread.y - 200) < 1e-9, "中点锚定（(100+300)/2 = 200）");
  pinch.up(2);
  assert.equal(pinch.active, false, "抬一指退出双指态");
  const after = pinch.move(1, 400, 400);
  assert.equal(after, null, "退出双指后不再输出缩放");
});

test("dist/atlas-ui-core.mjs 必须导出 R08 相机 / 手势 API（index.js 从 mod 解构）", async () => {
  const dist = await import("../atlas-extension/dist/atlas-ui-core.mjs");
  for (const name of [
    "computeMapFrame",
    "fitCamera",
    "setCameraZoom",
    "zoomCameraAtPoint",
    "panCameraBy",
    "centerCameraOn",
    "worldToScreen",
    "screenToWorld",
    "cameraStageTransform",
    "cameraZoomPercent",
    "markerInverseScale",
    "createPanGesture",
    "createDragGesture",
    "createPinchTracker",
  ]) {
    assert.equal(typeof dist[name], "function", `dist 必须导出 "${name}"`);
  }
});

// ---------------------------------------------------------------------------
// F07：地图框只按**真实坐标** fit，示意点不算已知几何
// ---------------------------------------------------------------------------

test("F07 全图只有示意点时按整张 frame fit，不把示意点当已知几何", () => {
  /**
   * 契约（§2.4 / F07）：`displayOnly`（示意 / 待定位）点不是已知几何。
   * 调用方必须**先过滤**再喂给 `computeMapFrame`；一个真实点都没有时用 `emptyMapFrame()`，
   * 于是相机围着整张 frame 而不是围着排版出来的位置转。
   *
   * 这里钉住的就是这条纯函数契约：空输入 → 整张默认 frame，而不是 0 跨度 /
   * 被某个示意坐标拉偏的框。
   */
  const frame = computeMapFrame([]);
  assert.deepEqual(frame, emptyMapFrame(), "没有真实坐标 → 整张默认 frame");
  assert.equal(frame.spanX, 100);
  assert.equal(frame.spanY, 100);

  const cam = fitCamera(frame, 800, 600);
  assert.ok(cam.k > 0, "整张 frame 也能 fit 出可用相机");
  // 示意点若被当成真实点，会得到一个被拉偏的框——这正是要避免的
  const polluted = computeMapFrame([{ x: 9999, y: -9999 }]);
  assert.notDeepEqual(polluted, frame, "真实点确实会改变 frame（所以过滤必须发生在调用侧）");
  assert.ok(polluted.maxX > 9999 - 1, "真实点参与计算");
});

test("F07 标记反缩放只是视觉系数：不改帧、不改比例尺几何", () => {
  const frame = computeMapFrame([{ x: 0, y: 0 }, { x: 100, y: 100 }]);
  const cam = fitCamera(frame, 800, 600);
  const inv = markerInverseScale(cam);
  // k × inv = 1：标记保持原始 CSS 像素尺寸，与世界每格像素数分离
  assert.ok(Math.abs(cam.k * inv - 1) < 1e-9, "k × markerInverseScale = 1");
  // 相机本身一个字段都没被它改过
  const again = fitCamera(frame, 800, 600);
  assert.deepEqual(cam, again, "反缩放是纯函数，不影响相机与格距");
  assert.deepEqual(computeMapFrame([{ x: 0, y: 0 }, { x: 100, y: 100 }]), frame, "帧也不受影响");
});
