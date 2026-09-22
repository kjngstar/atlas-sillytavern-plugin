/**
 * atlas-scale.ts — 0.9.50 地图尺度标定与动态比例尺条（纯函数）。
 *
 * 外部 AI 计划 M04/M05（Atlas_地图交互比例尺与皮肤修改计划.md）核心：
 * - M04：AI 判断地图实际范围。模型只给「整张图的实际宽高」，每格距离由程序
 *   从 frame（cols×rows）推导并存储规范值——模型不再自报第二份可能冲突的
 *   每格距离。校验纪律：拒绝负值 / 零 / 非有限数 / 字符串伪数值；宽/cols 与
 *   高/rows 在 1% 相对容差内必须一致（吸收模型取整），超差按 conflict 拒收，
 *   不静默取平均、不把不一致宽高分别用于 x/y 拉伸。
 * - M05：「1 格 = N 米」是地图数据；左下角标尺条是随相机变化的显示。两者
 *   关联但不互相修改。候选标尺距离 D 取 1、2、5 × 10^n 米，优先落 80-160px
 *   显示窗口；选定后按真实值绘制，不把条长硬截到像素值而保留原标签。
 *
 * mapId 规范：世界图 = "world"；子图 = 宿主点位 id（String(pointId)）。
 * 单位内部统一为米；世界自定义单位（里 / 步）没有转换关系就不换算。
 */

/** 标定来源：ai-estimated = AI 语义估计；user = 人工标定（默认锁定）；legacy = 旧子图 scale 迁移。 */
export type MapScaleSource = "ai-estimated" | "user" | "legacy";

/** 地图尺度标定（持久化在 sidecar 文档 calibrations[mapId]）。 */
export interface MapScaleCalibration {
  /** 标定记录版本（每次覆写 +1，便于回退审计）。 */
  revision: number;
  /** 每格实际距离（米；规范值，由程序推导或人工给出）。 */
  metersPerCell: number;
  source: MapScaleSource;
  /** 人工标定默认锁定；锁定值不接受 AI 覆盖。 */
  locked: boolean;
  /** 依据说明（AI 的 basis / 人工备注）。 */
  basis: string;
  /** 模型给出的覆盖范围描述（AI 模式）。 */
  coverage: string;
  /** low / medium / high —— 仅作解释信息，不参与校验。 */
  confidence: string;
  /** 标定时间（epoch ms）。 */
  at: number;
}

/** AI 标定请求的解析结果：ok = 落标定；否则 status 说明为何不落。 */
export type ScaleValidation =
  | { ok: true; calibration: Omit<MapScaleCalibration, "revision" | "at"> }
  | { ok: false; status: "unknown" | "conflict" | "invalid"; reason: string; coverage: string; basis: string };

/** 1% 相对容差（吸收模型取整；建议策略，写进配置与测试）。 */
export const SCALE_EXTENT_TOLERANCE = 0.01;
/** 侧显示窗口（CSS px；可调整显示策略，不是地图物理数据）。 */
export const SCALE_BAR_MIN_PX = 80;
export const SCALE_BAR_MAX_PX = 160;
/** 窗口内的首选条长（取候选最接近者）。 */
export const SCALE_BAR_PREFERRED_PX = 120;

const clampText = (value: unknown, max: number): string => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);

/** 严格数值：拒绝字符串伪数值 / 零 / 负 / 非有限（计划 8.5 校验纪律）。 */
function finitePositiveNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * 校验 AI 标定响应（不可信输入）并推导规范 metersPerCell。
 * - unknown / conflict / 缺 extent → 不落标定，返回可解释状态；
 * - extent.width 对应 cols 格、extent.height 对应 rows 格；
 *   两方向每格距离相对差 ≤ 1% 才通过，规范值取宽方向（cols 与 rows 一致时无差）。
 */
export function validateScaleResponse(
  raw: unknown,
  frame: { cols: number; rows: number },
): ScaleValidation {
  const coverage = clampText((raw as Record<string, unknown> | null)?.coverage, 120);
  const basis = clampText((raw as Record<string, unknown> | null)?.basis, 300);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, status: "invalid", reason: "响应不是 JSON 对象", coverage, basis };
  }
  const record = raw as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status : "estimated";
  if (status === "unknown" || status === "conflict") {
    return {
      ok: false,
      status,
      reason: status === "unknown" ? "模型表示材料不足以估计范围" : "模型报告布局与材料冲突",
      coverage,
      basis,
    };
  }
  const extent = record.extentMeters;
  if (!extent || typeof extent !== "object" || Array.isArray(extent)) {
    return { ok: false, status: "invalid", reason: "缺少 extentMeters 宽高", coverage, basis };
  }
  const width = finitePositiveNumber((extent as Record<string, unknown>).width);
  const height = finitePositiveNumber((extent as Record<string, unknown>).height);
  if (width === null || height === null) {
    return { ok: false, status: "invalid", reason: "extentMeters 宽 / 高必须是正的有限数字（拒绝 0、负值与字符串）", coverage, basis };
  }
  if (!(frame.cols > 0) || !(frame.rows > 0) || !Number.isFinite(frame.cols) || !Number.isFinite(frame.rows)) {
    return { ok: false, status: "invalid", reason: "地图网格 frame 非法", coverage, basis };
  }
  const perCellX = width / frame.cols;
  const perCellY = height / frame.rows;
  if (Math.abs(perCellX - perCellY) / perCellX > SCALE_EXTENT_TOLERANCE) {
    return {
      ok: false,
      status: "conflict",
      reason: `横纵每格距离不一致（${perCellX.toFixed(2)} vs ${perCellY.toFixed(2)} 米/格，超出 1% 容差）——该图网格横纵等距，需要重估`,
      coverage,
      basis,
    };
  }
  const confidence = ["low", "medium", "high"].includes(String(record.confidence)) ? String(record.confidence) : "";
  return {
    ok: true,
    calibration: {
      metersPerCell: Math.round(perCellX * 100) / 100,
      source: "ai-estimated",
      locked: false,
      basis,
      coverage,
      confidence,
    },
  };
}

/** sidecar 里存的标定形状不可信（旧 / 手改）：宽容清洗，坏值丢弃返回 null。 */
export function sanitizeCalibration(raw: unknown): MapScaleCalibration | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const metersPerCell = finitePositiveNumber(record.metersPerCell);
  if (metersPerCell === null) return null;
  const source = ["ai-estimated", "user", "legacy"].includes(String(record.source))
    ? (String(record.source) as MapScaleSource)
    : "legacy";
  const revisionRaw = Number(record.revision);
  const atRaw = Number(record.at);
  return {
    revision: Number.isFinite(revisionRaw) && revisionRaw >= 0 ? Math.floor(revisionRaw) : 0,
    metersPerCell: Math.round(metersPerCell * 100) / 100,
    source,
    locked: record.locked === true,
    basis: clampText(record.basis, 300),
    coverage: clampText(record.coverage, 120),
    confidence: ["low", "medium", "high"].includes(String(record.confidence)) ? String(record.confidence) : "",
    at: Number.isFinite(atRaw) && atRaw > 0 ? Math.floor(atRaw) : 0,
  };
}

/**
 * M05 动态比例尺条：已知每格米数与屏幕每格像素，选一条 80-160px 的标尺。
 * 候选 D = 1、2、5 × 10^n 米（指数 -2..7：覆盖房间厘米级到大陆千公里级）；
 * 窗口内取最接近首选 120px 的候选；全部候选都在窗外时取与窗口最近的
 * （小于窗口取最大候选、大于窗口取最小候选），条长按真实值绘制不截断。
 */
export function computeScaleBar(input: {
  metersPerCell: number;
  /** 屏幕上每格 CSS 像素（layout.cellPx × zoom）。 */
  cellPx: number;
  zoom: number;
}): { distanceMeters: number; barWidthPx: number } | null {
  const metersPerCell = finitePositiveNumber(input.metersPerCell);
  const cellPx = finitePositiveNumber(input.cellPx);
  const zoom = finitePositiveNumber(input.zoom);
  if (metersPerCell === null || cellPx === null || zoom === null) return null;
  const metersPerPixel = metersPerCell / (cellPx * zoom);
  if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) return null;
  let best: { distanceMeters: number; barWidthPx: number } | null = null;
  let bestInWindow: { distanceMeters: number; barWidthPx: number; gap: number } | null = null;
  let bestBelow: { distanceMeters: number; barWidthPx: number } | null = null;
  let bestAbove: { distanceMeters: number; barWidthPx: number } | null = null;
  for (let exp = -2; exp <= 7; exp++) {
    for (const mult of [1, 2, 5]) {
      const distance = mult * 10 ** exp;
      const barWidthPx = distance / metersPerPixel;
      if (!Number.isFinite(barWidthPx) || barWidthPx <= 0) continue;
      const candidate = { distanceMeters: distance, barWidthPx };
      if (barWidthPx >= SCALE_BAR_MIN_PX && barWidthPx <= SCALE_BAR_MAX_PX) {
        const gap = Math.abs(barWidthPx - SCALE_BAR_PREFERRED_PX);
        if (!bestInWindow || gap < bestInWindow.gap) bestInWindow = { ...candidate, gap };
      } else if (barWidthPx < SCALE_BAR_MIN_PX) {
        if (!bestBelow || barWidthPx > bestBelow.barWidthPx) bestBelow = candidate;
      } else if (!bestAbove || barWidthPx < bestAbove.barWidthPx) {
        bestAbove = candidate;
      }
      best = best ?? candidate;
    }
  }
  if (bestInWindow) return { distanceMeters: bestInWindow.distanceMeters, barWidthPx: bestInWindow.barWidthPx };
  // 全在窗外：优先贴窗口边缘最接近的候选（below 取最大已取、above 取最小已取）
  if (bestBelow && bestAbove) {
    const belowGap = SCALE_BAR_MIN_PX - bestBelow.barWidthPx;
    const aboveGap = bestAbove.barWidthPx - SCALE_BAR_MAX_PX;
    return belowGap <= aboveGap ? bestBelow : bestAbove;
  }
  return bestBelow ?? bestAbove ?? best;
}

/** 距离显示：内部统一米，显示米 / 公里自动（极小图到厘米）。 */
export function formatDistanceMeters(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return "";
  if (meters < 1) return `${Math.round(meters * 100)} 厘米`;
  if (meters < 1000) {
    const value = Math.round(meters * 10) / 10;
    return `${Number.isInteger(value) ? value : value.toFixed(1)} 米`;
  }
  const km = meters / 1000;
  const value = Math.round(km * 10) / 10;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} 公里`;
}
