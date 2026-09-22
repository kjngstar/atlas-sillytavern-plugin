/**
 * atlas-map-camera.ts — R08 地图相机纯数学（无 DOM，可完整测试）。
 *
 * 数学约定（修复计划 R08）：相机比例 k = CSS px / 世界单位，c = 视口中心对准的
 * 世界点，v = (viewW/2, viewH/2)：
 *   screen = v + (world - c) * k
 *   world  = c + (screen - v) / k
 *
 * 纪律：
 * - 全图适配（fitCamera）不设任何每格像素下限——旧实现 `Math.max(20, …)` 会把
 *   大世界撑出视口（20px 下限删除是 R08 验收项）。
 * - 回到 100% 不清空平移：缩放只改 k，重置视图是独立的 fitCamera 操作。
 * - 光标缩放（zoomCameraAtPoint）保持光标下的世界点在屏幕上不动。
 * - 筛选只改可见对象：frame 由调用方按全量点位固定，相机不因筛选重算。
 * - 设备像素比只影响 Canvas 清晰度，不进入世界距离（本模块无 Canvas）。
 */

export interface MapFrame {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  spanX: number;
  spanY: number;
}

export interface MapCamera {
  /** CSS px / 世界单位（屏幕比例）。 */
  k: number;
  /** 视口中心对准的世界点。 */
  cx: number;
  cy: number;
  /** 本视图 fitAll 的基准比例（缩放百分比与标记反缩放的基准）。 */
  fitK: number;
}

/** frame 外扩比例（沿旧 computeMapBounds 口径：8%，最少 4 单位）。 */
export const MAP_FRAME_PAD_RATIO = 0.08;
export const MAP_FRAME_PAD_MIN = 4;
/** jsdom / 未布局视口的回退尺寸（与旧 computeMapLayout 口径一致）。 */
export const MAP_VIEW_FALLBACK_W = 320;
export const MAP_VIEW_FALLBACK_H = 240;
/** 缩放范围：纯相对 fit 基准 0.2× ~ 8×——不设绝对夹取，fitAll 永远真实收全图
 *  （绝对下限会把 10 万格大世界的 fit 比例抬高，全图重新溢出视口）。 */
export const MAP_ZOOM_MIN_FACTOR = 0.2;
export const MAP_ZOOM_MAX_FACTOR = 8;

/** 空图回退 frame（0..100，与旧 computeMapBounds 口径一致）。 */
export function emptyMapFrame(): MapFrame {
  return { minX: 0, minY: 0, maxX: 100, maxY: 100, spanX: 100, spanY: 100 };
}

/**
 * 由全量点位计算固定 frame（外扩留白）。
 * 只吃有限数值坐标；空 / 全非法输入回退 0..100。
 */
export function computeMapFrame(points: ReadonlyArray<{ x?: unknown; y?: unknown }>): MapFrame {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of Array.isArray(points) ? points : []) {
    const x = Number(p?.x);
    const y = Number(p?.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      xs.push(x);
      ys.push(y);
    }
  }
  if (xs.length === 0) return emptyMapFrame();
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const padX = Math.max(MAP_FRAME_PAD_MIN, (maxX - minX) * MAP_FRAME_PAD_RATIO);
  const padY = Math.max(MAP_FRAME_PAD_MIN, (maxY - minY) * MAP_FRAME_PAD_RATIO);
  const fx = { minX: minX - padX, maxX: maxX + padX, minY: minY - padY, maxY: maxY + padY };
  return {
    minX: fx.minX,
    minY: fx.minY,
    maxX: fx.maxX,
    maxY: fx.maxY,
    spanX: Math.max(1e-9, fx.maxX - fx.minX),
    spanY: Math.max(1e-9, fx.maxY - fx.minY),
  };
}

function viewSize(viewW: number, viewH: number): { vw: number; vh: number } {
  return {
    vw: Number.isFinite(viewW) && viewW > 0 ? viewW : MAP_VIEW_FALLBACK_W,
    vh: Number.isFinite(viewH) && viewH > 0 ? viewH : MAP_VIEW_FALLBACK_H,
  };
}

function scaleRange(fitK: number): { min: number; max: number } {
  const base = Number.isFinite(fitK) && fitK > 0 ? fitK : 1;
  return {
    min: base * MAP_ZOOM_MIN_FACTOR,
    max: base * MAP_ZOOM_MAX_FACTOR,
  };
}

function clampK(k: number, fitK: number): number {
  const { min, max } = scaleRange(fitK);
  const value = Number.isFinite(k) ? k : min;
  return Math.min(max, Math.max(min, value));
}

/** 全图适配：k = min(vw/spanX, vh/spanY)，无像素下限；中心 = frame 中心。 */
export function fitCamera(frame: MapFrame, viewW: number, viewH: number): MapCamera {
  const { vw, vh } = viewSize(viewW, viewH);
  const f = frame && Number.isFinite(frame.spanX) && frame.spanX > 0 && Number.isFinite(frame.spanY) && frame.spanY > 0
    ? frame
    : emptyMapFrame();
  const fitK = Math.min(vw / f.spanX, vh / f.spanY);
  return {
    k: clampK(fitK, fitK),
    cx: f.minX + f.spanX / 2,
    cy: f.minY + f.spanY / 2,
    fitK: Number.isFinite(fitK) && fitK > 0 ? fitK : 1,
  };
}

/** 只改比例（夹取），绝不重置平移——回到 100% 不是重置视图。 */
export function setCameraZoom(cam: MapCamera, nextK: number): MapCamera {
  return { ...cam, k: clampK(nextK, cam.fitK) };
}

/**
 * 光标缩放：缩放前后光标下的世界点保持在同一屏幕位置。
 * world = c + (s - v)/k 不变 → c' = world - (s - v)/k'。
 */
export function zoomCameraAtPoint(
  cam: MapCamera,
  screenX: number,
  screenY: number,
  viewW: number,
  viewH: number,
  factor: number,
): MapCamera {
  const { vw, vh } = viewSize(viewW, viewH);
  const world = screenToWorld(cam, screenX, screenY, vw, vh);
  const next = setCameraZoom(cam, cam.k * (Number.isFinite(factor) && factor > 0 ? factor : 1));
  if (next.k === cam.k) return cam; // 已到缩放边界：相机不动（避免平移漂移）
  return {
    ...next,
    cx: world.x - (screenX - vw / 2) / next.k,
    cy: world.y - (screenY - vh / 2) / next.k,
  };
}

/** 平移：屏幕位移换算世界位移（c -= d/k）。 */
export function panCameraBy(cam: MapCamera, dxScreen: number, dyScreen: number): MapCamera {
  const k = Number.isFinite(cam.k) && cam.k > 0 ? cam.k : 1;
  const dx = Number.isFinite(dxScreen) ? dxScreen : 0;
  const dy = Number.isFinite(dyScreen) ? dyScreen : 0;
  return { ...cam, cx: cam.cx - dx / k, cy: cam.cy - dy / k };
}

/** 定位：保持比例，把视口中心对准目标世界点。 */
export function centerCameraOn(cam: MapCamera, worldX: number, worldY: number): MapCamera {
  return { ...cam, cx: Number(worldX), cy: Number(worldY) };
}

export function worldToScreen(
  cam: MapCamera,
  worldX: number,
  worldY: number,
  viewW: number,
  viewH: number,
): { x: number; y: number } {
  const { vw, vh } = viewSize(viewW, viewH);
  return {
    x: vw / 2 + (Number(worldX) - cam.cx) * cam.k,
    y: vh / 2 + (Number(worldY) - cam.cy) * cam.k,
  };
}

export function screenToWorld(
  cam: MapCamera,
  screenX: number,
  screenY: number,
  viewW: number,
  viewH: number,
): { x: number; y: number } {
  const { vw, vh } = viewSize(viewW, viewH);
  return {
    x: cam.cx + (Number(screenX) - vw / 2) / cam.k,
    y: cam.cy + (Number(screenY) - vh / 2) / cam.k,
  };
}

/**
 * CSS transform（stage 子元素按世界单位 px 定位，transform-origin: 0 0）：
 * screen = translate(t) + world * k，其中 t = v - c*k。
 */
export function cameraStageTransform(
  cam: MapCamera,
  viewW: number,
  viewH: number,
): { tx: number; ty: number; k: number } {
  const { vw, vh } = viewSize(viewW, viewH);
  return { tx: vw / 2 - cam.cx * cam.k, ty: vh / 2 - cam.cy * cam.k, k: cam.k };
}

/** 缩放百分比（100% = fitAll 基准）。 */
export function cameraZoomPercent(cam: MapCamera): number {
  return Number.isFinite(cam.fitK) && cam.fitK > 0 ? (cam.k / cam.fitK) * 100 : 100;
}

/**
 * 标记反缩放：stage 被 scale(k) 拉伸时，标记挂 `scale(var(--aw-marker-inv))`
 * 抵消，视觉尺寸 / 命中区域保持屏幕像素（与世界每格像素数分离）。
 */
export function markerInverseScale(cam: MapCamera): number {
  return Number.isFinite(cam.k) && cam.k > 0 && Number.isFinite(cam.fitK) && cam.fitK > 0
    ? cam.fitK / cam.k
    : 1;
}
