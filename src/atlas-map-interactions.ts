/**
 * atlas-map-interactions.ts — R08 地图手势状态机（纯逻辑，无 DOM，可完整测试）。
 *
 * 修复计划 R08 的手势纪律：
 * - 空白 pointerdown 超过阈值才 pan；按钮 / 输入框 / 弹窗起手不启动拖拽（interactive）。
 * - 拖拽（pan / NPC 纠偏）与普通点击有明确手势状态；拖拽结束后吞掉一次合成
 *   click——suppressClick 不在 pointerup 提前清除，由 click 事件 consumeClick() 消费
 *   （旧实现 pointerup 清掉 suppressClick，拖完松手还会触发 onClick 打开面板）。
 * - 双指缩放：记录两指距离，每次移动输出相对上一帧的缩放因子与中点。
 *
 * 状态机只算账，不碰 DOM：index.js 负责把 dx/dy / factor 施加到相机。
 */

export const MAP_GESTURE_THRESHOLD_PX = 6;

export interface PanMoveResult {
  /** 是否已进入 pan（超过阈值）。 */
  panning: boolean;
  /** 自上一次 move 以来的屏幕位移（仅 panning 时累计）。 */
  dx: number;
  dy: number;
}

export interface PanGesture {
  down(screenX: number, screenY: number, opts?: { interactive?: boolean }): boolean;
  move(screenX: number, screenY: number): PanMoveResult | null;
  up(): { panned: boolean };
  cancel(): void;
  readonly isPanning: boolean;
  /** click 事件序：拖拽发生过则吞掉本次合成 click（消费后复位）。 */
  consumeClick(): boolean;
}

export function createPanGesture(opts: { threshold?: number } = {}): PanGesture {
  const threshold = Number.isFinite(opts.threshold) && (opts.threshold as number) > 0
    ? (opts.threshold as number)
    : MAP_GESTURE_THRESHOLD_PX;
  let active = false;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let panning = false;
  let panned = false;
  return {
    down(screenX, screenY, downOpts = {}) {
      // 按钮 / 输入框 / 弹窗起手：不启动地图拖拽
      if (downOpts.interactive) {
        return false;
      }
      active = true;
      startX = Number(screenX) || 0;
      startY = Number(screenY) || 0;
      lastX = startX;
      lastY = startY;
      panning = false;
      panned = false;
      return true;
    },
    move(screenX, screenY) {
      if (!active) return null;
      const x = Number(screenX) || 0;
      const y = Number(screenY) || 0;
      if (!panning) {
        if (Math.hypot(x - startX, y - startY) > threshold) {
          panning = true;
          panned = true;
        } else {
          return null;
        }
      }
      const dx = x - lastX;
      const dy = y - lastY;
      lastX = x;
      lastY = y;
      return { panning: true, dx, dy };
    },
    up() {
      const result = { panned };
      // 纪律：这里不清 suppress 标记——由 consumeClick() 在 click 事件里消费
      active = false;
      panning = false;
      return result;
    },
    cancel() {
      active = false;
      panning = false;
      panned = false;
    },
    get isPanning() {
      return panning;
    },
    consumeClick() {
      const swallow = panned;
      panned = false;
      return swallow;
    },
  };
}

export interface DragMoveResult {
  /** 是否已进入拖拽（超过阈值）。 */
  dragging: boolean;
  /** 自上一次 move 以来的屏幕位移。 */
  dx: number;
  dy: number;
  /** 自 down 以来的累计位移（拖拽视觉反馈 / 影子定位用）。 */
  totalDx: number;
  totalDy: number;
}

export interface DragGesture {
  down(screenX: number, screenY: number): boolean;
  move(screenX: number, screenY: number): DragMoveResult | null;
  up(): { dragged: boolean };
  cancel(): void;
  readonly isDragging: boolean;
  /** 拖拽发生过 → 吞掉一次合成 click（消费后复位；pointerup 不复位）。 */
  consumeClick(): boolean;
}

/** NPC 拖拽纠偏手势：阈值起拖 + click 吞咽语义与 pan 相同。 */
export function createDragGesture(opts: { threshold?: number } = {}): DragGesture {
  const threshold = Number.isFinite(opts.threshold) && (opts.threshold as number) > 0
    ? (opts.threshold as number)
    : MAP_GESTURE_THRESHOLD_PX;
  let active = false;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let dragging = false;
  let dragged = false;
  return {
    down(screenX, screenY) {
      active = true;
      startX = Number(screenX) || 0;
      startY = Number(screenY) || 0;
      lastX = startX;
      lastY = startY;
      dragging = false;
      dragged = false;
      return true;
    },
    move(screenX, screenY) {
      if (!active) return null;
      const x = Number(screenX) || 0;
      const y = Number(screenY) || 0;
      if (!dragging) {
        if (Math.hypot(x - startX, y - startY) > threshold) {
          dragging = true;
          dragged = true;
        } else {
          return null;
        }
      }
      const result = {
        dragging: true,
        dx: x - lastX,
        dy: y - lastY,
        totalDx: x - startX,
        totalDy: y - startY,
      };
      lastX = x;
      lastY = y;
      return result;
    },
    up() {
      const result = { dragged };
      // suppress（dragged）保留给 consumeClick——pointerup 提前清除是旧 bug
      active = false;
      dragging = false;
      return result;
    },
    cancel() {
      active = false;
      dragging = false;
      dragged = false;
    },
    get isDragging() {
      return dragging;
    },
    consumeClick() {
      const swallow = dragged;
      dragged = false;
      return swallow;
    },
  };
}

export interface PinchUpdate {
  /** 相对上一帧的缩放因子（当前距离 / 上一帧距离）。 */
  factor: number;
  /** 两指中点（屏幕坐标，光标锚定缩放用）。 */
  x: number;
  y: number;
}

export interface PinchTracker {
  down(pointerId: number, screenX: number, screenY: number): PinchUpdate | null;
  move(pointerId: number, screenX: number, screenY: number): PinchUpdate | null;
  up(pointerId: number): void;
  cancel(): void;
  readonly active: boolean;
  readonly count: number;
}

/** 双指缩放跟踪：两点距离比 = 缩放因子；中点 = 缩放锚点。 */
export function createPinchTracker(): PinchTracker {
  const pointers = new Map<number, { x: number; y: number }>();
  let lastDistance = 0;
  const distance = (): number => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(b.x - a.x, b.y - a.y);
  };
  const midpoint = (): { x: number; y: number } => {
    const [a, b] = [...pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  const settle = (): void => {
    lastDistance = pointers.size >= 2 ? distance() : 0;
  };
  const emit = (): PinchUpdate | null => {
    if (pointers.size < 2 || lastDistance <= 0) return null;
    const dist = distance();
    if (!Number.isFinite(dist) || dist <= 0) return null;
    const mid = midpoint();
    const factor = dist / lastDistance;
    lastDistance = dist;
    return { factor: Number.isFinite(factor) && factor > 0 ? factor : 1, x: mid.x, y: mid.y };
  };
  return {
    down(pointerId, screenX, screenY) {
      pointers.set(Number(pointerId), { x: Number(screenX) || 0, y: Number(screenY) || 0 });
      settle();
      return emit();
    },
    move(pointerId, screenX, screenY) {
      const p = pointers.get(Number(pointerId));
      if (!p) return null;
      p.x = Number(screenX) || 0;
      p.y = Number(screenY) || 0;
      return emit();
    },
    up(pointerId) {
      pointers.delete(Number(pointerId));
      settle();
    },
    cancel() {
      pointers.clear();
      lastDistance = 0;
    },
    get active() {
      return pointers.size >= 2;
    },
    get count() {
      return pointers.size;
    },
  };
}
