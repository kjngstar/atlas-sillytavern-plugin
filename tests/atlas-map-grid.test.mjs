/**
 * atlas-map-grid.test.mjs — H22 定向验收（H12 地图网格 SVG 路径）。
 *
 * 计划 §2.6 / H12 硬约束，本文件逐条断言：
 * - 变换同源：网格用的 {k,tx,ty} 就是 cameraStageTransform() 那一套，格整数线
 *   的屏幕位置与 worldToScreen() 逐点一致（H22 的核心断言）；
 * - 41% / 100% / 400% / 800% × 平移 × DPR(1,2) × resize 下，路径不跑出 frame ∩ 视口；
 * - 每轴线数有界（≤200），超限如实报 dropped，不静默裁剪；
 * - 次格屏幕间距 < 8px 时隐藏次线、只留主线；主线精确落在格整数坐标（步长 5/25/125）；
 * - 线宽 1 CSS px，线心按设备像素栅格对齐（半像素 / DPR 对齐）；
 * - 纯函数：不改输入、同输入同输出、脏输入退化为空路径而不抛错。
 *
 * 运行：node --test --no-warnings=ExperimentalWarning --experimental-strip-types tests/atlas-map-grid.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  MAP_GRID_MAJOR_STEPS,
  MAP_GRID_MAX_LINES_PER_AXIS,
  MAP_GRID_MINOR_MIN_PX,
  MAP_GRID_STROKE_PX,
  getVisibleGridPaths,
  gridCameraFromMapCamera,
  gridMajorStepForScale,
  gridScreenPosition,
} from "../src/atlas-map-grid.ts";
import {
  cameraStageTransform,
  centerCameraOn,
  fitCamera,
  panCameraBy,
  setCameraZoom,
  worldToScreen,
} from "../src/atlas-map-camera.ts";

/** T22 夹具：框 100×100 的地图（frame 与相机 frame 同源，都是 0..100）。 */
const FRAME = { cols: 100, rows: 100 };
const FRAME_BOX = { minX: 0, minY: 0, maxX: 100, maxY: 100, spanX: 100, spanY: 100 };

const ZOOM_LEVELS = [41, 100, 400, 800];
const ALIGN_VIEWPORTS = [[640, 480], [1200, 800]];
const DPRS = [1, 2];

/** 缩放百分比 → 相机（百分比基准 = fitAll 比例，与 index.js 的 zoom 口径一致）。 */
function cameraAtZoom(viewW, viewH, zoomPercent) {
  const fit = fitCamera(FRAME_BOX, viewW, viewH);
  return setCameraZoom(fit, (fit.fitK * zoomPercent) / 100);
}

/** 经既有相机模块派生的网格相机 → 网格路径（index.js H13 的同一条调用链）。 */
function gridFor(camera, viewW, viewH, options = {}) {
  const { frame = FRAME, dpr } = options;
  return getVisibleGridPaths({
    viewport: { width: viewW, height: viewH },
    camera: gridCameraFromMapCamera(camera, viewW, viewH),
    frame,
    devicePixelRatio: dpr,
  });
}

const VERTICAL_RE = /M(-?[\d.]+) (-?[\d.]+)V(-?[\d.]+)/g;
const HORIZONTAL_RE = /M(-?[\d.]+) (-?[\d.]+)H(-?[\d.]+)/g;

/** 竖线：{ x, y0, y1 }。 */
function verticalLines(path) {
  return [...path.matchAll(VERTICAL_RE)].map((m) => ({ x: Number(m[1]), y0: Number(m[2]), y1: Number(m[3]) }));
}

/** 横线：{ x0, x1, y }（路径格式 M{x0} {y}H{x1}）。 */
function horizontalLines(path) {
  return [...path.matchAll(HORIZONTAL_RE)].map((m) => ({ x0: Number(m[1]), y: Number(m[2]), x1: Number(m[3]) }));
}

function allVertical(result) {
  return [...verticalLines(result.minorPath), ...verticalLines(result.majorPath)];
}

function allHorizontal(result) {
  return [...horizontalLines(result.minorPath), ...horizontalLines(result.majorPath)];
}

/**
 * 路径不得跑出 frame ∩ 视口（半像素对齐允许 ≤1 CSS px 的取整位移）。
 * 端点方向是向内取整的，所以端点本身不允许外扩。
 */
function assertWithinFrameAndViewport(result, camera, viewW, viewH, frame, tolerance = 1) {
  const { tx, ty, k } = cameraStageTransform(camera, viewW, viewH);
  const xLo = Math.max(0, tx) - tolerance;
  const xHi = Math.min(viewW, tx + frame.cols * k) + tolerance;
  const yLo = Math.max(0, ty) - tolerance;
  const yHi = Math.min(viewH, ty + frame.rows * k) + tolerance;
  const paths = [["次线", result.minorPath], ["主线", result.majorPath]];
  for (const [label, path] of paths) {
    for (const line of verticalLines(path)) {
      assert.ok(line.x >= xLo && line.x <= xHi, `${label}竖线 x=${line.x} 越出 frame∩视口 [${xLo}, ${xHi}]`);
      assert.ok(line.y0 >= yLo && line.y0 <= yHi && line.y1 >= yLo && line.y1 <= yHi,
        `${label}竖线端点 ${line.y0}..${line.y1} 越出 [${yLo}, ${yHi}]`);
      assert.ok(line.y1 > line.y0, `${label}竖线长度必须为正`);
    }
    for (const line of horizontalLines(path)) {
      assert.ok(line.y >= yLo && line.y <= yHi, `${label}横线 y=${line.y} 越出 frame∩视口 [${yLo}, ${yHi}]`);
      assert.ok(line.x0 >= xLo && line.x0 <= xHi && line.x1 >= xLo && line.x1 <= xHi,
        `${label}横线端点 ${line.x0}..${line.x1} 越出 [${xLo}, ${xHi}]`);
      assert.ok(line.x1 > line.x0, `${label}横线长度必须为正`);
    }
  }
}

/**
 * 每根线都必须对应 frame 内的整数格坐标，且位置与相机变换一致（误差 ≤ 半个设备像素）。
 * 返回每轴抽出的整数格坐标，供「不重复 / 主线在倍数上」继续断言。
 */
function lanesFor(result, camera, viewW, viewH, frame, dpr, slack = 0) {
  const { tx, ty, k } = cameraStageTransform(camera, viewW, viewH);
  const tolerance = 0.5 / dpr + 1e-6;
  // 半像素对齐可能让 0 号线的推算值落在 -0.0001 → round 成 -0；统一成 0 再比较
  const cellIndex = (value, origin) => {
    const n = Math.round((value - origin) / k);
    return Object.is(n, -0) ? 0 : n;
  };
  const readVertical = (path) => verticalLines(path).map((line) => {
    const n = cellIndex(line.x, tx);
    assert.ok(n >= -slack && n <= frame.cols + slack, `竖线 x=${line.x} 不对应 frame 内整数格坐标（推出 ${n}）`);
    assert.ok(Math.abs(n * k + tx - line.x) <= tolerance, `竖线 x=${line.x} 偏离相机变换位置 ${n * k + tx}`);
    return n;
  });
  const readHorizontal = (path) => horizontalLines(path).map((line) => {
    const n = cellIndex(line.y, ty);
    assert.ok(n >= -slack && n <= frame.rows + slack, `横线 y=${line.y} 不对应 frame 内整数格坐标（推出 ${n}）`);
    assert.ok(Math.abs(n * k + ty - line.y) <= tolerance, `横线 y=${line.y} 偏离相机变换位置 ${n * k + ty}`);
    return n;
  });
  return {
    minorVertical: readVertical(result.minorPath),
    majorVertical: readVertical(result.majorPath),
    minorHorizontal: readHorizontal(result.minorPath),
    majorHorizontal: readHorizontal(result.majorPath),
  };
}

/**
 * 路径 / 计数 / 上限 / 去重 / 主线倍数 的公共硬约束。
 * strictLanes：一个格子在屏幕上窄于 1 个设备像素时（k×dpr ≤ 1），半像素对齐会让
 * 「由位置反推整数格号」这一步本身带 ±1 歧义，此时只做位置（≤半设备像素）与边界断言，
 * 不做「格号去重 / 主线在倍数上」这两条需要精确格号的断言。
 */
function assertGridInvariants(result, camera, viewW, viewH, frame, dpr, options = {}) {
  const { strictLanes = true } = options;
  assert.equal(result.devicePixelRatio, dpr, "回执必须带上本次实际 DPR");
  assert.equal(result.strokeWidth, MAP_GRID_STROKE_PX, "线宽恒为 1 CSS px");
  assert.ok(MAP_GRID_MAJOR_STEPS.includes(result.majorStep), `主线步长必须是 5/25/125，实为 ${result.majorStep}`);
  assert.match(result.minorPath + result.majorPath, /^(M-?[\d.]+ -?[\d.]+[VH]-?[\d.]+)*$/, "只能输出 M/V/H 路径");
  assert.ok(result.counts.vertical <= MAP_GRID_MAX_LINES_PER_AXIS, `竖线 ${result.counts.vertical} 根超过每轴上限`);
  assert.ok(result.counts.horizontal <= MAP_GRID_MAX_LINES_PER_AXIS, `横线 ${result.counts.horizontal} 根超过每轴上限`);
  assert.equal(result.counts.vertical, verticalLines(result.minorPath).length + verticalLines(result.majorPath).length);
  assert.equal(result.counts.horizontal, horizontalLines(result.minorPath).length + horizontalLines(result.majorPath).length);
  assert.equal(result.counts.minorVertical + result.counts.majorVertical, result.counts.vertical);
  assert.equal(result.counts.minorHorizontal + result.counts.majorHorizontal, result.counts.horizontal);
  if (result.minorHidden) {
    assert.equal(result.minorPath, "", "次线隐藏时不得留残余次线 path");
    assert.equal(result.counts.minorVertical + result.counts.minorHorizontal, 0);
  }

  const lanes = lanesFor(result, camera, viewW, viewH, frame, dpr, strictLanes ? 0 : 1);
  const verticalCells = [...lanes.minorVertical, ...lanes.majorVertical];
  const horizontalCells = [...lanes.minorHorizontal, ...lanes.majorHorizontal];
  if (strictLanes) {
    assert.equal(new Set(verticalCells).size, verticalCells.length, "同一格整数只能画一根竖线");
    assert.equal(new Set(horizontalCells).size, horizontalCells.length, "同一格整数只能画一根横线");
    for (const n of lanes.majorVertical) assert.equal(n % result.majorStep, 0, `主线 x=${n} 必须落在 ${result.majorStep} 格整数坐标上`);
    for (const n of lanes.majorHorizontal) assert.equal(n % result.majorStep, 0, `主线 y=${n} 必须落在 ${result.majorStep} 格整数坐标上`);
  }
  assertWithinFrameAndViewport(result, camera, viewW, viewH, frame);
  return lanes;
}

test("H22 41%/100%/400%/800% × DPR1/2：次/主格线都落在相机变换给出的整数格坐标上且不跑出 frame", () => {
  for (const [viewW, viewH] of ALIGN_VIEWPORTS) {
    for (const zoom of ZOOM_LEVELS) {
      for (const dpr of DPRS) {
        const camera = cameraAtZoom(viewW, viewH, zoom);
        const { k } = cameraStageTransform(camera, viewW, viewH);
        const result = gridFor(camera, viewW, viewH, { dpr });
        const label = `${viewW}×${viewH} @ ${zoom}% dpr${dpr}（k=${k.toFixed(2)}）`;

        assert.equal(result.minorHidden, k < MAP_GRID_MINOR_MIN_PX, `${label}：次线显隐只看次格屏幕间距`);
        assertGridInvariants(result, camera, viewW, viewH, FRAME, dpr);
        assert.ok(result.columns && result.rows, `${label}：100×100 的图在视口内必须有可见格线`);

        // 主线的屏幕位置 = worldToScreen(格整数坐标)，误差 ≤ 半个设备像素（半像素对齐）。
        // 图钉取「视口中心最近的 majorStep 倍数格」，保证它在任何缩放下都可见。
        const pinCellX = Math.round(camera.cx / result.majorStep) * result.majorStep;
        const pinCellY = Math.round(camera.cy / result.majorStep) * result.majorStep;
        const pin = worldToScreen(camera, pinCellX, pinCellY, viewW, viewH);
        const tolerance = 0.5 / dpr + 1e-6;
        assert.ok(allVertical(result).some((line) => Math.abs(line.x - pin.x) <= tolerance),
          `${label}：x=${pinCellX} 格整数线必须与图钉同一条竖线`);
        assert.ok(allHorizontal(result).some((line) => Math.abs(line.y - pin.y) <= tolerance),
          `${label}：y=${pinCellY} 格整数线必须与图钉同一条横线`);

        if (result.minorHidden) {
          assert.ok(result.majorPath.length > 0, `${label}：次线隐藏后主线仍必须在`);
        } else {
          assert.ok(result.counts.minorVertical + result.counts.minorHorizontal > 0,
            `${label}：次线可见时必须真的画出次线`);
        }
      }
    }
  }
});

test("H22 平移：pan 后仍与相机变换一致，frame 外 / 视口外的线都不画", () => {
  const [viewW, viewH] = [640, 480];
  const base = cameraAtZoom(viewW, viewH, 200);
  const panning = [panCameraBy(base, 137, -91), panCameraBy(base, -260, -240), panCameraBy(base, 23.5, 17.25)];
  for (const camera of panning) {
    const result = gridFor(camera, viewW, viewH, { dpr: 1 });
    assertGridInvariants(result, camera, viewW, viewH, FRAME, 1);
    assert.ok(result.counts.vertical + result.counts.horizontal > 0, "平移后网格仍在");
  }

  // 固定相机：k=4、视口中心对准 (50,50) → frame 屏幕矩形 x∈[120,520]、y∈[40,440]，整块都在视口内
  const corner = { k: 4, cx: 50, cy: 50, fitK: 4 };
  const cornerGrid = gridFor(corner, viewW, viewH, { dpr: 1 });
  assert.equal(cornerGrid.minorHidden, true, "k=4 < 8：只留主线");
  assert.equal(cornerGrid.counts.majorVertical, 21, "0..100 的 5 格主线共 21 根");
  assert.equal(cornerGrid.counts.majorHorizontal, 21);
  assert.deepEqual(cornerGrid.columns, { first: 0, last: 100, dropped: 0 });
  // 半像素对齐允许线心偏移 ≤1 CSS px（格坐标本身仍严格在 frame 内，已由 lanesFor 断言）
  for (const line of allVertical(cornerGrid)) {
    assert.equal(line.x >= 119 && line.x <= 521, true, "竖线必须落在 frame 的屏幕矩形内（±1px 对齐位移）");
    assert.equal(line.y0, 40, "竖线从 frame 上边界开始，不画 frame 外的部分");
    assert.equal(line.y1, 440, "竖线画到 frame 下边界，不越出 frame");
  }
  for (const line of allHorizontal(cornerGrid)) {
    assert.equal(line.y >= 39 && line.y <= 441, true, "横线必须落在 frame 的屏幕矩形内（±1px 对齐位移）");
    assert.equal(line.x0, 120, "横线从 frame 左边界开始，不画 frame 外的部分");
    assert.equal(line.x1, 520, "横线画到 frame 右边界，不越出 frame");
  }

  // 视口只露出 frame 的左上角：最右/最下的线正好停在视口边缘（frame 外的部分不画）
  const clippedGrid = gridFor({ k: 4, cx: 0, cy: 0, fitK: 4 }, viewW, viewH, { dpr: 1 });
  assertGridInvariants(clippedGrid, { k: 4, cx: 0, cy: 0, fitK: 4 }, viewW, viewH, FRAME, 1);
  const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 1,
    `${label}：期望 ${expected}（半像素对齐 ±1px），实为 ${actual}`);
  near(Math.max(...allVertical(clippedGrid).map((line) => line.x)), 640, "竖线止于视口右沿 x=640（frame 还在更右边）");
  near(Math.min(...allVertical(clippedGrid).map((line) => line.x)), 320, "竖线从 frame 左边界 x=320 开始");
  near(Math.max(...allHorizontal(clippedGrid).map((line) => line.y)), 480, "横线止于视口下沿 y=480");
  near(Math.min(...allHorizontal(clippedGrid).map((line) => line.y)), 240, "横线从 frame 上边界 y=240 开始");
});

test("H22 平移：frame 完全移出视口时两条 path 都为空", () => {
  const camera = { k: 4, cx: -500, cy: 700, fitK: 4 };
  const result = gridFor(camera, 600, 400, { dpr: 1 });
  assert.equal(result.minorPath, "");
  assert.equal(result.majorPath, "");
  assert.deepEqual(result.counts, {
    vertical: 0, horizontal: 0, minorVertical: 0, minorHorizontal: 0, majorVertical: 0, majorHorizontal: 0,
  });
  assert.equal(result.columns, null);
  assert.equal(result.rows, null);
  assert.equal(result.majorStep, 5, "无可见线也要给出当前缩放对应的主线步长（供 UI 文案）");
});

test("视口背景网格跨过 frame 边界连续延伸，平移后仍铺满视口且不改变格线对齐", () => {
  const viewport = { width: 640, height: 480 };
  const frame = { cols: 20, rows: 20 };
  const camera = { k: 20, tx: 120, ty: 40 };
  const draw = (cam) => getVisibleGridPaths({ viewport, frame, camera: cam, extent: "viewport", devicePixelRatio: 1 });
  const first = draw(camera);
  assert.ok(first.columns.first < 0 && first.columns.last > frame.cols, "两侧的背景格线超出地图范围");
  assert.ok(first.rows.first < 0 && first.rows.last > frame.rows, "上下的背景格线超出地图范围");
  assert.ok(allVertical(first).every((line) => line.y0 === 0 && line.y1 === viewport.height));
  assert.ok(allHorizontal(first).every((line) => line.x0 === 0 && line.x1 === viewport.width));
  const moved = draw({ k: 20, tx: -2000, ty: 900 });
  assert.ok(moved.counts.vertical > 0 && moved.counts.horizontal > 0, "图框离开视口也有视觉网格");
  assert.ok(moved.counts.vertical <= MAP_GRID_MAX_LINES_PER_AXIS);
  assert.ok(moved.counts.horizontal <= MAP_GRID_MAX_LINES_PER_AXIS);
  const x = allVertical(first).find((line) => Math.abs(line.x - 120.5) < 0.01)?.x;
  assert.equal(x, 120.5, "零号格线仍按相机变换和 DPR 像素对齐");

  const wide = getVisibleGridPaths({
    viewport: { width: 3840, height: 2160 }, frame, camera: { k: 8, tx: 0, ty: 0 }, extent: "viewport",
  });
  assert.equal(wide.minorHidden, true, "超宽视口隐藏次线，避免两侧露出空白带");
  assert.equal(wide.columns?.dropped, 0);
  assert.equal(wide.rows?.dropped, 0);
  assert.ok(Math.max(...allVertical(wide).map((line) => line.x)) > 3800, "主线仍延伸到视口右侧");
});

test("H22 resize / DPR：320→3840 宽都不越界且线数有界；非法视口返回空路径不抛错", () => {
  const sizes = [[320, 240], [720, 480], [1200, 800], [1920, 1080], [3840, 2160]];
  for (const [viewW, viewH] of sizes) {
    for (const zoom of [41, 100, 400, 800]) {
      for (const dpr of DPRS) {
        const camera = cameraAtZoom(viewW, viewH, zoom);
        const { k } = cameraStageTransform(camera, viewW, viewH);
        const result = gridFor(camera, viewW, viewH, { dpr });
        // 320×240 @41% 时一个格子只有 0.98 CSS px（窄于一整个设备像素），
        // 此时半像素对齐让「格号」本身带 ±1 歧义，只做位置与边界断言。
        assertGridInvariants(result, camera, viewW, viewH, FRAME, dpr, { strictLanes: k * dpr > 1.05 });
        assert.ok(result.majorPath.length > 0, `${viewW}×${viewH} @${zoom}% 主线不能为空`);
        // DPR 对齐：1 CSS px 线宽 → 线心 = 设备像素整数 + dpr/2
        for (const line of allVertical(result)) {
          const deviceCenter = line.x * dpr - dpr / 2;
          assert.ok(Math.abs(deviceCenter - Math.round(deviceCenter)) < 1e-3, `线心未对齐设备像素栅格：${line.x}`);
        }
        for (const line of allHorizontal(result)) {
          const deviceCenter = line.y * dpr - dpr / 2;
          assert.ok(Math.abs(deviceCenter - Math.round(deviceCenter)) < 1e-3, `线心未对齐设备像素栅格：${line.y}`);
        }
      }
    }
  }

  const invalid = [
    { viewport: { width: 0, height: 0 }, camera: { k: 4, tx: 0, ty: 0 }, frame: FRAME },
    { viewport: { width: -10, height: 100 }, camera: { k: 4, tx: 0, ty: 0 }, frame: FRAME },
    { viewport: { width: Number.NaN, height: 100 }, camera: { k: 4, tx: 0, ty: 0 }, frame: FRAME },
    { viewport: { width: 600, height: 400 }, camera: { k: 0, tx: 0, ty: 0 }, frame: FRAME },
    { viewport: { width: 600, height: 400 }, camera: { k: Number.NaN, tx: 0, ty: 0 }, frame: FRAME },
    { viewport: { width: 600, height: 400 }, camera: { k: -3, tx: 0, ty: 0 }, frame: FRAME },
    { viewport: { width: 600, height: 400 }, camera: { k: 4, tx: 0, ty: 0 }, frame: { cols: 0, rows: 100 } },
    { viewport: { width: 600, height: 400 }, camera: { k: 4, tx: 0, ty: 0 }, frame: { cols: 100, rows: -1 } },
  ];
  for (const input of invalid) {
    const result = getVisibleGridPaths({ ...input, devicePixelRatio: 1 });
    assert.equal(result.minorPath, "", `脏输入 ${JSON.stringify(input)} 必须退化为空路径`);
    assert.equal(result.majorPath, "");
    assert.equal(result.counts.vertical + result.counts.horizontal, 0);
    assert.equal(result.columns, null);
    assert.equal(result.rows, null);
  }
  // 非有限平移不抛错：退化为 0 平移后照常给出有界网格
  assert.doesNotThrow(() => getVisibleGridPaths({
    viewport: { width: 600, height: 400 }, camera: { k: 4, tx: Number.NaN, ty: Number.POSITIVE_INFINITY },
    frame: FRAME, devicePixelRatio: 1,
  }));
});

test("H12 次格间距 <8px 隐藏次线、主线仍在；主线步长 5/25/125 且精确落在格整数坐标", () => {
  // k=8 恰好可见次线：640×480 视口 → x 10..90、y 20..80
  const dense = getVisibleGridPaths({
    viewport: { width: 640, height: 480 }, camera: { k: 8, tx: -80, ty: -160 }, frame: FRAME, devicePixelRatio: 1,
  });
  assert.equal(dense.minorHidden, false);
  assert.equal(dense.majorStep, 5);
  assert.equal(dense.counts.majorVertical, 17, "x 10..90 里 5 的倍数共 17 根");
  assert.equal(dense.counts.minorVertical, 64);
  assert.equal(dense.counts.majorHorizontal, 13, "y 20..80 里 5 的倍数共 13 根");
  assert.equal(dense.counts.minorHorizontal, 48);

  // k=7.9：同视口下 7.9×5 = 39.5px，但次格只有 7.9px < 8 → 隐藏次线，主线不动
  const sparse = getVisibleGridPaths({
    viewport: { width: 640, height: 480 }, camera: { k: 7.9, tx: -75, ty: -155 }, frame: FRAME, devicePixelRatio: 1,
  });
  assert.equal(sparse.minorHidden, true);
  assert.equal(sparse.majorStep, 5);
  assert.equal(sparse.minorPath, "");
  assert.ok(sparse.majorPath.length > 0, "隐藏次线不等于隐藏网格：主线必须还在");
  assert.equal(sparse.counts.majorVertical, 17);
  assert.equal(sparse.counts.majorHorizontal, 13);
  assert.deepEqual(sparse.columns, { first: 10, last: 90, dropped: 0 });

  // 步长表：次线隐藏时取第一个屏幕间距 ≥ 8px 的 5/25/125
  assert.equal(gridMajorStepForScale(100), 5);
  assert.equal(gridMajorStepForScale(8), 5);
  assert.equal(gridMajorStepForScale(2), 5);
  assert.equal(gridMajorStepForScale(1.5), 25, "1.5×5=7.5 < 8 → 升到 25");
  assert.equal(gridMajorStepForScale(1), 25);
  assert.equal(gridMajorStepForScale(0.4), 25, "0.4×25=10 ≥ 8");
  assert.equal(gridMajorStepForScale(0.3), 125, "0.3×25=7.5 < 8 → 升到 125");
  assert.equal(gridMajorStepForScale(0), 0);
  assert.equal(gridMajorStepForScale(Number.NaN), 0);
  assert.equal(gridMajorStepForScale(-1), 0);
});

test("H22 格整数线与图钉吻合：缩放到 800% 也不漂移；主线是 5/25 的倍数", () => {
  for (const [viewW, viewH] of ALIGN_VIEWPORTS) {
    for (const zoom of ZOOM_LEVELS) {
      for (const dpr of DPRS) {
        // 把 (25,50) 格坐标摆在视口正中：它既是 5 的倍数也是 25 的倍数 → 任何步长下都是主线
        const camera = centerCameraOn(cameraAtZoom(viewW, viewH, zoom), 25, 50);
        const result = gridFor(camera, viewW, viewH, { dpr });
        const pin = worldToScreen(camera, 25, 50, viewW, viewH);
        const tolerance = 0.5 / dpr + 1e-6;
        const label = `${viewW}×${viewH} @${zoom}% dpr${dpr}`;

        const pinVertical = verticalLines(result.majorPath).filter((line) => Math.abs(line.x - pin.x) <= tolerance);
        const pinHorizontal = horizontalLines(result.majorPath).filter((line) => Math.abs(line.y - pin.y) <= tolerance);
        assert.equal(pinVertical.length, 1, `${label}：x=25 的主线必须唯一且压在图钉上`);
        assert.equal(pinHorizontal.length, 1, `${label}：y=50 的主线必须唯一且压在图钉上`);
        // 线段端点取整到设备像素（避免 1px 线被端点拉糊）
        for (const edge of [pinVertical[0].y0, pinVertical[0].y1]) {
          assert.ok(Math.abs(edge * dpr - Math.round(edge * dpr)) < 1e-3, `${label}：竖线端点未对齐设备像素 ${edge}`);
        }
        for (const edge of [pinHorizontal[0].x0, pinHorizontal[0].x1]) {
          assert.ok(Math.abs(edge * dpr - Math.round(edge * dpr)) < 1e-3, `${label}：横线端点未对齐设备像素 ${edge}`);
        }
        assertGridInvariants(result, camera, viewW, viewH, FRAME, dpr);
      }
    }
  }
});

test("H12 每轴 ≤200 根：超限取视口中心窗口，并如实报 dropped（不静默裁剪）", () => {
  // 次线可见：2000px 宽 / k=8 → 251 根可见竖线，超上限
  const dense = getVisibleGridPaths({
    viewport: { width: 2000, height: 1600 }, camera: { k: 8, tx: 0, ty: 0 },
    frame: { cols: 4000, rows: 4000 }, devicePixelRatio: 1,
  });
  assert.equal(dense.minorHidden, false);
  assert.equal(dense.counts.vertical, MAP_GRID_MAX_LINES_PER_AXIS);
  assert.equal(dense.counts.horizontal, MAP_GRID_MAX_LINES_PER_AXIS);
  assert.equal(dense.columns.dropped, 51, "251 - 200 = 51 根如实报出来");
  assert.equal(dense.rows.dropped, 1, "201 - 200 = 1");
  assert.equal(dense.columns.last - dense.columns.first + 1, MAP_GRID_MAX_LINES_PER_AXIS);
  assert.equal(dense.columns.first, 26, "窗口以视口中心的格坐标（125）为中心");

  // 次线隐藏：上限只数「本来会画的主线」，不虚报被隐藏的整数线
  const sparse = getVisibleGridPaths({
    viewport: { width: 4000, height: 800 }, camera: { k: 0.5, tx: 0, ty: 0 },
    frame: { cols: 10000, rows: 10000 }, devicePixelRatio: 1,
  });
  assert.equal(sparse.minorHidden, true);
  assert.equal(sparse.majorStep, 25);
  assert.equal(sparse.counts.vertical, MAP_GRID_MAX_LINES_PER_AXIS);
  assert.equal(sparse.columns.dropped, 121, "321 根主线 - 200 = 121");
  assert.equal(sparse.columns.first % 25, 0, "窗口端点仍是格整数倍数");
  assert.equal(sparse.columns.last % 25, 0);
  assert.equal(sparse.rows.dropped, 0, "只有 65 根横线，不该触发上限");
  assert.equal(sparse.counts.horizontal, 65);
});

test("H12 纯函数：不改输入、同输入同输出、脏输入不抛错", () => {
  const deepFreeze = (value) => {
    if (value && typeof value === "object") for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
  };
  const input = deepFreeze({
    viewport: { width: 640, height: 480 },
    camera: { k: 4.8, tx: -80.5, ty: -160.25 },
    frame: { cols: 100, rows: 100 },
    devicePixelRatio: 2,
  });
  const snapshot = JSON.stringify(input);
  const first = getVisibleGridPaths(input);
  const second = getVisibleGridPaths(input);
  assert.deepEqual(second, first, "同输入必须同输出");
  assert.equal(JSON.stringify(input), snapshot, "输入对象不得被修改");

  assert.doesNotThrow(() => getVisibleGridPaths({}));
  assert.doesNotThrow(() => getVisibleGridPaths({ viewport: null, camera: null, frame: null }));
  assert.doesNotThrow(() => getVisibleGridPaths(null));
  assert.equal(getVisibleGridPaths({}).majorPath, "");
  assert.equal(getVisibleGridPaths({}).majorStep, 0, "相机缺失 → 本帧无网格");
});

test("H22 与既有相机模块同源：gridCameraFromMapCamera = cameraStageTransform，gridScreenPosition = worldToScreen", () => {
  const cases = [];
  for (const [viewW, viewH] of ALIGN_VIEWPORTS) {
    for (const zoom of ZOOM_LEVELS) {
      const base = cameraAtZoom(viewW, viewH, zoom);
      cases.push(
        { camera: base, viewW, viewH },
        { camera: panCameraBy(base, 37, -21), viewW, viewH },
        { camera: centerCameraOn(base, 12.5, 88.25), viewW, viewH },
      );
    }
  }
  const probes = [[0, 0], [25, 50], [100, 100], [37.5, 62.25], [-3, 7]];
  for (const { camera, viewW, viewH } of cases) {
    const stage = cameraStageTransform(camera, viewW, viewH);
    const gridCamera = gridCameraFromMapCamera(camera, viewW, viewH);
    assert.deepEqual(gridCamera, stage, "网格相机必须就是 stage 的 translate/scale");
    for (const [x, y] of probes) {
      const viaGrid = gridScreenPosition(gridCamera, x, y);
      const viaCamera = worldToScreen(camera, x, y, viewW, viewH);
      assert.ok(Math.abs(viaGrid.x - viaCamera.x) < 1e-9 && Math.abs(viaGrid.y - viaCamera.y) < 1e-9,
        `(${x},${y}) 两套换算必须一致：${JSON.stringify(viaGrid)} vs ${JSON.stringify(viaCamera)}`);
    }
  }
});

/**
 * extent="viewport"：网格铺满视口，修「中央一小片稀疏大方格」的真实观感问题。
 *
 * 世界图 frame 是 100×100，默认 zoom 约 69%（k≈0.69）时 1 格只有 0.69px，
 * 远低于 MAP_GRID_MINOR_MIN_PX，于是次格线全隐、主格线只能挑到很大档位——
 * 旧行为（frame 模式）在 720×480 视口里只画出 10 条主线：画面中央一小块、四周空白。
 */
test("H13/H22：extent=viewport 铺满视口，且线数仍然有界", () => {
  const base = {
    viewport: { width: 720, height: 480 },
    camera: { k: 0.69, tx: 100, ty: 60 },
    frame: { cols: 100, rows: 100 },
    devicePixelRatio: 1,
  };
  const countMoves = (path) => (String(path ?? "").match(/M/g) ?? []).length;

  const frameMode = getVisibleGridPaths({ ...base });
  const viewportMode = getVisibleGridPaths({ ...base, extent: "viewport" });
  assert.ok(countMoves(viewportMode.majorPath) > countMoves(frameMode.majorPath),
    "铺满视口必须比只画 frame 矩形给出更多格线："
    + `${countMoves(frameMode.majorPath)} → ${countMoves(viewportMode.majorPath)}`);

  // 有界：viewport 模式靠「超限先隐次格、再逐级 ×5 放大主格距」兜底，任何缩放下都不放飞
  for (const camera of [
    { k: 0.02, tx: 0, ty: 0 },
    { k: 0.05, tx: -5000, ty: -5000 },
    { k: 0.69, tx: 100, ty: 60 },
    { k: 10, tx: 0, ty: 0 },
  ]) {
    const paths = getVisibleGridPaths({ ...base, camera, extent: "viewport" });
    assert.ok(countMoves(paths.majorPath) <= MAP_GRID_MAX_LINES_PER_AXIS * 2 + 8,
      `k=${camera.k} 主线数必须有界：${countMoves(paths.majorPath)}`);
    assert.ok(countMoves(paths.minorPath) <= MAP_GRID_MAX_LINES_PER_AXIS * 2 + 8,
      `k=${camera.k} 次线数必须有界：${countMoves(paths.minorPath)}`);
  }
});
