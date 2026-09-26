/**
 * atlas-map-grid.ts — H12：地图网格 SVG 路径纯函数（无 DOM、零 IO、零副作用）。
 *
 * 依据：Atlas 0.9.58 → 下一版本实施计划 §2.6（建图即判断尺度、缩放动态标尺）
 * 与 H12 原文；验收见 §4 的 T22 与 H22（41% / 100% / 400% / 800% × 平移 / DPR / resize）。
 *
 * 变换约定（与 src/atlas-map-camera.ts 完全同一套，绝不另发明第二套）：
 *   camera.k = 1 个地图格在屏幕上的 CSS px；
 *   screen   = world * k + t，其中 t 就是 cameraStageTransform() 的 { tx, ty }
 *              （stage 子元素按世界单位定位，transform: translate(t) scale(k)）。
 * 本模块只吃 { k, tx, ty }；index.js 侧用 gridCameraFromMapCamera(camera, w, h)
 * 由既有相机模块派生，网格、图钉、路线因此永远同源对齐。
 *
 * 网格层次（§2.5 图层顺序里的「网格次线 / 主线」）：
 * - 次线 = 每 1 格；主线 = 每 majorStep 格，majorStep ∈ { 5, 25, 125 }；
 * - 次格屏幕间距 < 8 CSS px（k < 8）时隐藏次线，只保留主线；
 * - 主线永远精确落在格整数坐标（n % majorStep === 0）上，不落在半格；
 * - 只画 frame 内（整数格坐标 0..cols / 0..rows）与视口相交的线，
 *   超出 frame 或超出视口的部分都不画（线段两端按 frame ∩ 视口裁剪）；
 * - 每轴最多 200 根线（次线 + 主线合并计数），超限取视口中心附近的一段，
 *   并如实报 dropped —— 沿用仓库「超上限必须报 total / truncated」纪律，不静默裁剪；
 * - 线宽 1 CSS px；垂直方向坐标对齐设备像素栅格（半像素 / DPR 对齐），
 *   线段两端取整到设备像素，避免 1px 线被拉成 2px 灰线（旧 CSS 渐变网格的病根）。
 */

import { cameraStageTransform, type MapCamera } from "./atlas-map-camera.ts";

/** 次线最小屏幕间距（CSS px）：k 低于此值时隐藏次线，只留主线。 */
export const MAP_GRID_MINOR_MIN_PX = 8;
/** 主线允许的格步长（升序）；次线隐藏时取第一个满足最小间距的步长，都不满足取最大。 */
export const MAP_GRID_MAJOR_STEPS: readonly number[] = [5, 25, 125];
/** 每轴最多绘制的格线数（次线 + 主线合并计数）。 */
export const MAP_GRID_MAX_LINES_PER_AXIS = 200;
/** 线宽（CSS px；不随 DPR 变粗，DPR 只影响对齐）。 */
export const MAP_GRID_STROKE_PX = 1;
/** 设备像素比夹取上限（挡住脏输入造成的荒谬对齐栅格）。 */
const DPR_MAX = 16;
/** 浮点边界容差（格整数坐标判定用）。 */
const EPSILON = 1e-9;

/**
 * 网格相机：与 cameraStageTransform() 的返回结构一致。
 * tx / ty 是 stage 平移，不是「视口中心世界坐标」——同一套约定，避免两处换算漂移。
 */
export interface AtlasGridCamera {
  /** 1 个地图格在屏幕上的 CSS px。 */
  k: number;
  /** 屏幕 x = worldX * k + tx。 */
  tx: number;
  /** 屏幕 y = worldY * k + ty。 */
  ty: number;
}

/** 网格范围（格数；整数格线坐标 0..cols / 0..rows，含两端）。 */
export interface AtlasGridFrame {
  cols: number;
  rows: number;
}

/** 视口 CSS 尺寸。 */
export interface AtlasGridViewport {
  width: number;
  height: number;
}

export interface AtlasGridInput {
  viewport: AtlasGridViewport;
  camera: AtlasGridCamera;
  frame: AtlasGridFrame;
  /** 设备像素比；缺省 / 非法按 1 处理（只影响对齐，不进入世界距离）。 */
  devicePixelRatio?: number;
  /**
   * 绘制范围。缺省 `"frame"`（只画 frame 的屏幕矩形，0.9.58 行为）；
   * `"viewport"` 铺满整个视口——世界图默认缩放下 frame 只占屏幕一小块，
   * 且次格线因低于 `MAP_GRID_MINOR_MIN_PX` 全隐，会退化成「中央一小片稀疏大方格」。
   */
  extent?: "frame" | "viewport";
}

/** 某一轴上实际绘制的整数格线范围。 */
export interface AtlasGridAxisRange {
  /** 第一根线的格整数坐标。 */
  first: number;
  /** 最后一根线的格整数坐标。 */
  last: number;
  /**
   * 因 200 根/轴上限而未画的格线数（0 = 未触发上限）。
   * 次线隐藏时只数「本来会画的主线」——报的是真实少画的线，不是候选整数个数。
   */
  dropped: number;
}

export interface AtlasGridCounts {
  /** 竖线总数（次 + 主）。 */
  vertical: number;
  /** 横线总数（次 + 主）。 */
  horizontal: number;
  minorVertical: number;
  minorHorizontal: number;
  majorVertical: number;
  majorHorizontal: number;
}

export interface AtlasGridPaths {
  /** 次线（每 1 格）SVG path；次线隐藏或无可见线时为空字符串。 */
  minorPath: string;
  /** 主线（每 majorStep 格）SVG path；无可见线时为空字符串。 */
  majorPath: string;
  /** 本次使用的主线步长（5 / 25 / 125）；0 = 相机或 frame 非法，本帧无网格。 */
  majorStep: number;
  /** 次线是否因过密被隐藏。 */
  minorHidden: boolean;
  /** 线宽（CSS px）。 */
  strokeWidth: number;
  /** 本次实际采用的设备像素比（回执，便于调用方与测试核对）。 */
  devicePixelRatio: number;
  counts: AtlasGridCounts;
  /** 竖线（x 整数格坐标）范围；本轴无可见线时为 null。 */
  columns: AtlasGridAxisRange | null;
  /** 横线（y 整数格坐标）范围；本轴无可见线时为 null。 */
  rows: AtlasGridAxisRange | null;
}

/** 有限数字否则回退（纯函数不抛错：脏输入退化成「画不出线」而不是崩 UI）。 */
function finiteOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 设备像素比：有限正数才认，夹取到 DPR_MAX。 */
function normalizeDevicePixelRatio(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, DPR_MAX) : 1;
}

/** 视口边长：有限正数才认，否则 0（0 会让可见区间为空 → 不画线）。 */
function normalizeViewportSide(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** frame 边长：非负整数格数；非法返回 null。 */
function normalizeFrameSide(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function emptyCounts(): AtlasGridCounts {
  return {
    vertical: 0,
    horizontal: 0,
    minorVertical: 0,
    minorHorizontal: 0,
    majorVertical: 0,
    majorHorizontal: 0,
  };
}

function emptyPaths(majorStep: number, minorHidden: boolean, dpr: number): AtlasGridPaths {
  return {
    minorPath: "",
    majorPath: "",
    majorStep,
    minorHidden,
    strokeWidth: MAP_GRID_STROKE_PX,
    devicePixelRatio: dpr,
    counts: emptyCounts(),
    columns: null,
    rows: null,
  };
}

/**
 * 由既有相机模块派生网格相机：唯一入口，杜绝 index.js 再算一遍 tx / ty。
 * cameraStageTransform 就是 stage 的 `translate(tx, ty) scale(k)`。
 */
export function gridCameraFromMapCamera(cam: MapCamera, viewW: number, viewH: number): AtlasGridCamera {
  const t = cameraStageTransform(cam, viewW, viewH);
  return { k: t.k, tx: t.tx, ty: t.ty };
}

/**
 * 格坐标 → 屏幕坐标（H22 的对齐基准）。
 * 与 worldToScreen() 在 tx = vw/2 - cx*k、ty = vh/2 - cy*k 时逐点相等。
 */
export function gridScreenPosition(
  camera: AtlasGridCamera,
  worldX: number,
  worldY: number,
): { x: number; y: number } {
  return {
    x: Number(worldX) * Number(camera.k) + Number(camera.tx),
    y: Number(worldY) * Number(camera.k) + Number(camera.ty),
  };
}

/** 主线步长：次线可见（k ≥ 8）时为 5；否则取第一个屏幕间距 ≥ 8px 的 5/25/125。 */
export function gridMajorStepForScale(k: number): number {
  if (!Number.isFinite(k) || k <= 0) return 0;
  for (const step of MAP_GRID_MAJOR_STEPS) {
    if (k * step >= MAP_GRID_MINOR_MIN_PX) return step;
  }
  return MAP_GRID_MAJOR_STEPS[MAP_GRID_MAJOR_STEPS.length - 1];
}

/** 竖线中心对齐：线宽 1 CSS px 时，中心落在「设备像素整数 + dpr/2」上才是实线。 */
function snapLineCenter(value: number, dpr: number): number {
  const device = value * dpr;
  return (Math.round(device - dpr / 2) + dpr / 2) / dpr;
}

/** 线段端点对齐：取整设备像素并**向内**取，保证线段不越出 frame ∩ 视口。 */
function snapEdgeIn(value: number, dpr: number, direction: "up" | "down"): number {
  const device = value * dpr;
  return (direction === "up" ? Math.ceil(device - EPSILON) : Math.floor(device + EPSILON)) / dpr;
}

/** SVG 数字：最多 3 位小数（对齐栅格实际不会更细），去掉 -0。 */
function fmt(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/**
 * 可见整数范围 + 200 根/轴上限窗口。
 * 超限时取以视口中心为中心的一段（用户正在看的地方不会被裁掉），并报真实少画的线数：
 * 次线隐藏时上限只对主线计数（否则会虚报「丢了一堆本来就不画的整数线」）。
 */
function limitVisibleRange(
  first: number,
  last: number,
  center: number,
  majorStep: number,
  minorHidden: boolean,
): AtlasGridAxisRange | null {
  if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) return null;
  const total = last - first + 1;
  if (!minorHidden) {
    if (total <= MAP_GRID_MAX_LINES_PER_AXIS) return { first, last, dropped: 0 };
    const span = MAP_GRID_MAX_LINES_PER_AXIS - 1;
    const start = Math.min(Math.max(Math.round(center - span / 2), first), last - span);
    return { first: start, last: start + span, dropped: total - MAP_GRID_MAX_LINES_PER_AXIS };
  }
  const firstMajor = Math.ceil(first / majorStep) * majorStep;
  const lastMajor = Math.floor(last / majorStep) * majorStep;
  // 次线隐藏且这段里一根主线都没有 → 本轴确实无可见线（不是空 range）
  if (firstMajor > lastMajor) return null;
  const majors = Math.round((lastMajor - firstMajor) / majorStep) + 1;
  if (majors <= MAP_GRID_MAX_LINES_PER_AXIS) return { first, last, dropped: 0 };
  const spanMajors = (MAP_GRID_MAX_LINES_PER_AXIS - 1) * majorStep;
  const centerMajor = Math.round(center / majorStep) * majorStep;
  const start = Math.min(
    Math.max(Math.round((centerMajor - spanMajors / 2) / majorStep) * majorStep, firstMajor),
    lastMajor - spanMajors,
  );
  return { first: start, last: start + spanMajors, dropped: majors - MAP_GRID_MAX_LINES_PER_AXIS };
}

/**
 * 屏幕可见的整数格线 → 次线 / 主线两条 SVG path。
 * 纯函数：不改输入、不读全局、不抛错；脏输入退化为空 path。
 */
export function getVisibleGridPaths(input: AtlasGridInput): AtlasGridPaths {
  const dpr = normalizeDevicePixelRatio(input?.devicePixelRatio);
  const k = finiteOr(input?.camera?.k, 0);
  let majorStep = gridMajorStepForScale(k);
  let minorHidden = !(k >= MAP_GRID_MINOR_MIN_PX);
  if (majorStep <= 0) return emptyPaths(0, true, dpr);

  const cols = normalizeFrameSide(input?.frame?.cols);
  const rows = normalizeFrameSide(input?.frame?.rows);
  if (cols === null || rows === null) return emptyPaths(majorStep, minorHidden, dpr);

  const viewW = normalizeViewportSide(input?.viewport?.width);
  const viewH = normalizeViewportSide(input?.viewport?.height);
  const tx = finiteOr(input?.camera?.tx, 0);
  const ty = finiteOr(input?.camera?.ty, 0);

  /**
   * extent="viewport"：网格铺满**整个视口**，而不是只画在 frame 的屏幕矩形里。
   *
   * 为什么需要（实测的真实观感问题）：世界图的 frame 是 100×100，默认 zoom 约 69%
   * 时 1 格只有 0.69px，远低于 `MAP_GRID_MINOR_MIN_PX`，于是次格线全部隐藏；
   * 主格线又要挑到「看得见」的档位（5/25/125），最终只剩每 125 格一条——
   * 结果是画面中央一小块稀疏大方格、四周大片空白，既不像网格也不像地图。
   *
   * 铺满视口后：格线始终覆盖可见区域，观感均匀；同时**有界**——线数超上限时先隐次格，
   * 仍超就逐级 ×5 放大主格距，绝不为了好看把线数放飞（H22 的「线数有界」仍成立）。
   */
  const viewportGrid = input?.extent === "viewport";
  if (viewportGrid && Math.max(viewW, viewH) / k + 2 > MAP_GRID_MAX_LINES_PER_AXIS) minorHidden = true;
  if (viewportGrid && minorHidden) {
    while (Math.max(viewW, viewH) / (k * majorStep) + 2 > MAP_GRID_MAX_LINES_PER_AXIS) majorStep *= 5;
  }

  // 线段允许范围 = frame 屏幕矩形 ∩ 视口；viewport 模式直接取整个视口。
  // 任一方向为空则整帧无可见线。
  const clipLeft = viewportGrid ? 0 : Math.max(0, tx);
  const clipRight = viewportGrid ? viewW : Math.min(viewW, tx + cols * k);
  const clipTop = viewportGrid ? 0 : Math.max(0, ty);
  const clipBottom = viewportGrid ? viewH : Math.min(viewH, ty + rows * k);
  if (!(clipRight > clipLeft) || !(clipBottom > clipTop)) return emptyPaths(majorStep, minorHidden, dpr);

  // 整数格线：n 的屏幕坐标落在允许范围内才算可见；frame 模式再夹进 0..cols / 0..rows。
  const columns = limitVisibleRange(
    viewportGrid ? Math.ceil((clipLeft - tx) / k - EPSILON) : Math.max(0, Math.ceil((clipLeft - tx) / k - EPSILON)),
    viewportGrid ? Math.floor((clipRight - tx) / k + EPSILON) : Math.min(cols, Math.floor((clipRight - tx) / k + EPSILON)),
    (viewW / 2 - tx) / k,
    majorStep,
    minorHidden,
  );
  const rowsRange = limitVisibleRange(
    viewportGrid ? Math.ceil((clipTop - ty) / k - EPSILON) : Math.max(0, Math.ceil((clipTop - ty) / k - EPSILON)),
    viewportGrid ? Math.floor((clipBottom - ty) / k + EPSILON) : Math.min(rows, Math.floor((clipBottom - ty) / k + EPSILON)),
    (viewH / 2 - ty) / k,
    majorStep,
    minorHidden,
  );
  if (!columns && !rowsRange) return emptyPaths(majorStep, minorHidden, dpr);

  // 线段端点：沿线轴方向取整设备像素并向内收，绝不越出 frame / 视口。
  const segX0 = snapEdgeIn(clipLeft, dpr, "up");
  const segX1 = snapEdgeIn(clipRight, dpr, "down");
  const segY0 = snapEdgeIn(clipTop, dpr, "up");
  const segY1 = snapEdgeIn(clipBottom, dpr, "down");
  const drawVertical = Boolean(columns) && segY1 > segY0;
  const drawHorizontal = Boolean(rowsRange) && segX1 > segX0;

  const counts = emptyCounts();
  const minorParts: string[] = [];
  const majorParts: string[] = [];
  const lineY0 = fmt(segY0);
  const lineY1 = fmt(segY1);
  const lineX0 = fmt(segX0);
  const lineX1 = fmt(segX1);

  if (drawVertical && columns) {
    for (let n = columns.first; n <= columns.last; n += 1) {
      const isMajor = n % majorStep === 0;
      if (!isMajor && minorHidden) continue;
      const x = fmt(snapLineCenter(n * k + tx, dpr));
      (isMajor ? majorParts : minorParts).push(`M${x} ${lineY0}V${lineY1}`);
      counts.vertical += 1;
      if (isMajor) counts.majorVertical += 1;
      else counts.minorVertical += 1;
    }
  }

  if (drawHorizontal && rowsRange) {
    for (let n = rowsRange.first; n <= rowsRange.last; n += 1) {
      const isMajor = n % majorStep === 0;
      if (!isMajor && minorHidden) continue;
      const y = fmt(snapLineCenter(n * k + ty, dpr));
      (isMajor ? majorParts : minorParts).push(`M${lineX0} ${y}H${lineX1}`);
      counts.horizontal += 1;
      if (isMajor) counts.majorHorizontal += 1;
      else counts.minorHorizontal += 1;
    }
  }

  return {
    minorPath: minorParts.join(""),
    majorPath: majorParts.join(""),
    majorStep,
    minorHidden,
    strokeWidth: MAP_GRID_STROKE_PX,
    devicePixelRatio: dpr,
    counts,
    columns: drawVertical ? columns : null,
    rows: drawHorizontal ? rowsRange : null,
  };
}
