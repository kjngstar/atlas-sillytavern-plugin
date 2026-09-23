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

/** Preserve tiny positive scales that would round to zero at centimeter precision. */
export function roundPositiveScale(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded > 0 && Number.isFinite(rounded) ? rounded : Number(value.toPrecision(12));
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
      metersPerCell: roundPositiveScale(perCellX),
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
    metersPerCell: roundPositiveScale(metersPerCell),
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
  if (meters < 0.00001) return meters.toPrecision(3) + " 米";
  if (meters < 0.01) return Number((meters * 1000).toPrecision(3)) + " 毫米";
  if (meters < 1) return `${Math.round(meters * 100)} 厘米`;
  if (meters < 1000) {
    const value = Math.round(meters * 10) / 10;
    return `${Number.isInteger(value) ? value : value.toFixed(1)} 米`;
  }
  const km = meters / 1000;
  const value = Math.round(km * 10) / 10;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} 公里`;
}

// ---------------------------------------------------------------------------
// R10：把 v2 mapScaleHints 应用到 maps sidecar 的 calibrations。
//
// 设计纪律（计划 8.4 / §5.2）：
// - 人工锁定值永不自动覆盖（calibrations[mapId].locked === true → 跳过写）
// - frameRevision 不匹配 → 跳过写（hint 已声明地图帧版本；0.9.50 默认子图 / 世界图
//   都是 100×100，未引入 frame 持久化字段前 frameRevision 可为 null——null 视为未指定）
// - unknown / conflict / 缺 extent → validateScaleResponse 已返回 ok:false，沿用其原因
// - 重复 hint 取**最后一条**（v2 数组顺序由程序消费决定；同 mapId 多条 hint 不应出
//   现在合理 v2 输出里，但程序要可重复、不抛错）
// - 不修改 submaps / pointMeta——只动 calibrations
// ---------------------------------------------------------------------------

/** v2 mapScaleHints 单条输入（atlas-contract-v2.ts 解析后的形状，去掉 schemaVersion）。 */
export interface V2ScaleHintInput {
  mapRef: string;
  frameRevision: number | null;
  status: "estimated" | "grounded" | "unknown" | "conflict";
  extentMeters: { width: number; height: number } | null;
  basis: string;
  confidence: "low" | "medium" | "high";
  evidenceIds: string[];
}

/** 应用一条 hint 的结果（供 commit 上层记日志 / 推送警告）。 */
export interface AppliedHintResult {
  mapId: string;
  /** "applied" = 写入 calibrations；其余保留原 calibrations 不动。 */
  outcome: "applied" | "skipped-locked" | "skipped-frame-mismatch" | "skipped-invalid" | "skipped-unknown";
  reason: string;
  /** 当 outcome === "applied" 时为新 calibration；否则为旧值（可能为 null）。 */
  calibration: MapScaleCalibration | null;
}

/** 给定 mapId 的 frame 信息（cols/rows/frameRevision）。 */
export interface FrameRef {
  cols: number;
  rows: number;
  frameRevision: number;
}

export interface ApplyScaleHintsOptions {
  /** 当前 mapsDoc 已有的 calibrations（用于锁定判定）。 */
  existing: Record<string, MapScaleCalibration>;
  /** 给定 mapId → FrameRef 的查找表；缺 mapId 时不写（world 与已建子图各一条）。 */
  framesByMapId: Record<string, FrameRef>;
  /** 写入 calibrations 的时刻（epoch ms）。 */
  now: number;
}

/**
 * 把 v2 mapScaleHints 应用到 mapsDoc 的 calibrations（**就地修改 doc.calibrations**）。
 * - 已知 calibrations[mapId] 锁定 → 跳过，outcome="skipped-locked"
 * - frameRevision 不匹配 → 跳过，outcome="skipped-frame-mismatch"
 * - 校验失败（unknown/conflict/数值/extent） → 跳过，outcome="skipped-invalid"
 *   或 "skipped-unknown"（按 status 区分提示）
 * - 通过校验 → 写 calibrations[mapId]，outcome="applied"
 *
 * 返回每条 hint 的处理结果（与 hint 数组同序）。不抛错；调用方按结果决定是否记警告。
 */
export function applyScaleHintsToDoc(
  hints: readonly V2ScaleHintInput[],
  doc: { calibrations: Record<string, MapScaleCalibration> },
  options: ApplyScaleHintsOptions,
): AppliedHintResult[] {
  const results: AppliedHintResult[] = [];
  for (const hint of hints) {
    const mapId = hint.mapRef;
    if (!mapId) {
      results.push({ mapId: "", outcome: "skipped-invalid", reason: "mapRef 为空", calibration: null });
      continue;
    }
    const existing = options.existing[mapId] ?? null;
    if (existing?.locked) {
      results.push({
        mapId,
        outcome: "skipped-locked",
        reason: `该图已人工锁定（${existing.metersPerCell} 米/格，source=${existing.source}）；AI 估计不覆盖`,
        calibration: existing,
      });
      continue;
    }
    const frame = options.framesByMapId[mapId];
    if (!frame || frame.cols <= 0 || frame.rows <= 0) {
      // 该图未注册 frame（地图尚无对应子图或父图）；保守拒绝写
      results.push({
        mapId,
        outcome: "skipped-frame-mismatch",
        reason: "该图未注册 frame（cols/rows 不可得），不写 calibrations",
        calibration: existing,
      });
      continue;
    }
    if (hint.frameRevision !== null && hint.frameRevision !== frame.frameRevision) {
      results.push({
        mapId,
        outcome: "skipped-frame-mismatch",
        reason: `frameRevision 不匹配：hint=${hint.frameRevision} vs doc=${frame.frameRevision}`,
        calibration: existing,
      });
      continue;
    }
    if (hint.status === "unknown" || hint.status === "conflict") {
      results.push({
        mapId,
        outcome: "skipped-unknown",
        reason: hint.status === "unknown" ? "模型标记 unknown，extent 缺失" : "模型标记 conflict，extent 与网格冲突",
        calibration: existing,
      });
      continue;
    }
    const validated = validateScaleResponse(hint, { cols: frame.cols, rows: frame.rows });
    if (!validated.ok) {
      results.push({
        mapId,
        outcome: validated.status === "invalid" ? "skipped-invalid" : "skipped-unknown",
        reason: validated.reason,
        calibration: existing,
      });
      continue;
    }
    const next: MapScaleCalibration = {
      revision: (existing?.revision ?? 0) + 1,
      metersPerCell: validated.calibration.metersPerCell,
      source: "ai-estimated",
      locked: false,
      basis: validated.calibration.basis,
      coverage: validated.calibration.coverage,
      confidence: validated.calibration.confidence,
      at: options.now,
    };
    doc.calibrations[mapId] = next;
    results.push({ mapId, outcome: "applied", reason: `已落标定：1 格 ≈ ${next.metersPerCell} 米（ai-estimated）`, calibration: next });
  }
  return results;
}
