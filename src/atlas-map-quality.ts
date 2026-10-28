/**
 * atlas-map-quality.ts — 可解释的地图质量（P06 §12.7）。
 *
 * 质量不是一个分数，是**五个维度的结论**：覆盖、几何与锁、可通行性、尺度、合理性。
 * 每种结论只有四种取值，含义固定：
 *   pass    检查过且有依据通过
 *   review  检查过但存在问题，需要人看（不阻断发布）
 *   fail    检查过且属于硬失败（几何/锁/必要通路）——不发布坏图
 *   unknown **没检查**或预算耗尽 —— 绝不写成 pass / checked
 *
 * 玩家地图保持清爽：这里的细节只进工作台与诊断。「美观 93 分」不是质量，
 * 未标定的图也不输出精确米数。
 */

import type { PlanIssue } from './atlas-world-contract.ts';

export const MAP_QUALITY_DIMENSIONS = ['coverage', 'geometry-locks', 'navigability', 'scale', 'plausibility'] as const;
export type MapQualityDimension = (typeof MAP_QUALITY_DIMENSIONS)[number];

export const MAP_QUALITY_STATUSES = ['pass', 'review', 'fail', 'unknown'] as const;
export type MapQualityStatus = (typeof MAP_QUALITY_STATUSES)[number];

/** 硬失败维度：任何一项 fail 都不允许发布新图。 */
const HARD_DIMENSIONS = new Set<MapQualityDimension>(['geometry-locks', 'navigability']);

export const MAP_QUALITY_VERDICTS = ['pass', 'review', 'unknown', 'blocked'] as const;
export type MapQualityVerdict = (typeof MAP_QUALITY_VERDICTS)[number];

/** 尺度能对外说到什么精度。未标定 → unknown（不编米数）。 */
export const SCALE_PRECISIONS = ['exact-meters', 'approximate', 'unknown'] as const;
export type ScalePrecision = (typeof SCALE_PRECISIONS)[number];

export type MapQualityFinding = {
  dimension: MapQualityDimension;
  status: MapQualityStatus;
  code: string;
  message: string;
};

export type MapQualityV1 = {
  version: 1;
  mapId: string;
  /** 是否真的检查过（预算耗尽 / 未检查 → false）。 */
  inspected: boolean;
  dimensions: Record<MapQualityDimension, MapQualityStatus>;
  verdict: MapQualityVerdict;
  /** 对外表达精度：未标定图不给精确米数。 */
  scalePrecision: ScalePrecision;
  findings: readonly MapQualityFinding[];
  issues: readonly PlanIssue[];
};

export type MapQualityInput = {
  mapId: string;
  /** 只影响诊断文案与精度表达，不参与判定。 */
  layoutKind?: 'overview' | 'city' | 'floor' | string | null;
  /** meters_per_cell 可信且大于 0。 */
  calibrated: boolean;
  /** 尺度档位：confirmed 才允许说「精确米数」。 */
  scaleQuality?: 'confirmed' | 'estimated' | 'uncalibrated' | null;
  /** 检查预算耗尽：没检查的维度一律 unknown，不冒充 checked。 */
  budgetExhausted?: boolean;
  /** 本轮实际检查过的维度；缺省视为全检查（预算未耗尽时）。 */
  checked?: readonly MapQualityDimension[];
  coverage?: { requiredMembers?: number; presentMembers?: number; missingIds?: readonly string[] } | null;
  geometry?: { hardErrors?: number; lockViolations?: number } | null;
  navigability?: { requiredRoutes?: number; drawnRoutes?: number; undrawnRouteIds?: readonly string[] } | null;
  scale?: { aspectDrift?: number; implausible?: boolean } | null;
  plausibility?: { unsupportedStructures?: number; notes?: readonly string[] } | null;
};

function nonNegative(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.floor(num));
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 宽高比偏离超过这个倍数就算软比例异常，列 review 而不是 fail。 */
export const ASPECT_DRIFT_REVIEW_THRESHOLD = 0.5;

/**
 * §12.7：五维质量结论。
 *
 * 判定顺序：未检查 → unknown；硬维度 fail → blocked；其余问题 → review；
 * 全部 pass → pass。`verdict` 只由这些确定性规则产生，没有分数、没有加权。
 */
export function assessMapQuality(input: MapQualityInput): MapQualityV1 {
  const findings: MapQualityFinding[] = [];
  const issues: PlanIssue[] = [];
  const mapId = String(input?.mapId ?? '');
  const budgetExhausted = input?.budgetExhausted === true;
  const checked = new Set<MapQualityDimension>(
    budgetExhausted
      ? (input?.checked ?? [])
      : (input?.checked ?? [...MAP_QUALITY_DIMENSIONS]),
  );

  const dimensions = Object.fromEntries(MAP_QUALITY_DIMENSIONS.map((dimension) => [dimension, 'unknown'])) as Record<MapQualityDimension, MapQualityStatus>;
  const note = (dimension: MapQualityDimension, status: MapQualityStatus, code: string, message: string): void => {
    dimensions[dimension] = status;
    findings.push({ dimension, status, code, message });
  };

  /* 1 覆盖：成员缺项列 review（不是硬失败，但不完整）。 */
  if (!checked.has('coverage')) {
    note('coverage', 'unknown', 'MAP_QUALITY_NOT_CHECKED', '覆盖检查未做（预算耗尽或未安排）：不写成通过。');
  } else {
    const required = nonNegative(input.coverage?.requiredMembers);
    const present = Math.max(0, Math.min(required, nonNegative(input.coverage?.presentMembers)));
    const missing = Array.isArray(input.coverage?.missingIds) ? input.coverage.missingIds.map(String) : [];
    if (required > 0 && (present < required || missing.length > 0)) {
      note('coverage', 'review', 'MAP_COVERAGE_INCOMPLETE',
        `成员缺项：应含 ${required} 个，实到 ${present} 个${missing.length > 0 ? `（缺 ${missing.slice(0, 8).join('、')}）` : ''}。`);
    } else {
      note('coverage', 'pass', 'MAP_COVERAGE_OK', '必需成员齐全。');
    }
  }

  /* 2 几何与锁：硬错误 / 锁冲突一律 fail，不发布坏图。 */
  if (!checked.has('geometry-locks')) {
    note('geometry-locks', 'unknown', 'MAP_QUALITY_NOT_CHECKED', '几何与锁检查未做：不写成通过。');
  } else {
    const hardErrors = nonNegative(input.geometry?.hardErrors);
    const lockViolations = nonNegative(input.geometry?.lockViolations);
    if (hardErrors > 0 || lockViolations > 0) {
      note('geometry-locks', 'fail', 'MAP_GEOMETRY_HARD_FAIL',
        `硬几何失败 ${hardErrors} 处、锁冲突 ${lockViolations} 处：本轮不发布这张图，保留上一版完整结果。`);
    } else {
      note('geometry-locks', 'pass', 'MAP_GEOMETRY_OK', '几何与锁均无硬失败。');
    }
  }

  /* 3 可通行性：必要通路没画出来 = 硬失败（不能声称交通已完整）。 */
  if (!checked.has('navigability')) {
    note('navigability', 'unknown', 'MAP_QUALITY_NOT_CHECKED', '可通行性检查未做：不写成通过。');
  } else {
    const required = nonNegative(input.navigability?.requiredRoutes);
    const drawn = Math.max(0, Math.min(required, nonNegative(input.navigability?.drawnRoutes)));
    const undrawn = Array.isArray(input.navigability?.undrawnRouteIds) ? input.navigability.undrawnRouteIds.map(String) : [];
    if (required > 0 && (drawn < required || undrawn.length > 0)) {
      note('navigability', 'fail', 'MAP_NAVIGABILITY_HARD_FAIL',
        `必要通路 ${required} 条，实际可走 ${drawn} 条${undrawn.length > 0 ? `（未绘制 ${undrawn.slice(0, 8).join('、')}）` : ''}：真实拓扑保留，但本图不能声称交通完整。`);
    } else {
      note('navigability', 'pass', 'MAP_NAVIGABILITY_OK', `必要通路 ${required} 条均已可用${required === 0 ? '（本图无需路线）' : ''}。`);
    }
  }

  /* 4 尺度：未标定 → unknown；标定但比例失真 → review。 */
  if (!checked.has('scale')) {
    note('scale', 'unknown', 'MAP_QUALITY_NOT_CHECKED', '尺度检查未做：不写成通过。');
  } else if (input.calibrated !== true) {
    note('scale', 'unknown', 'MAP_SCALE_UNCALIBRATED', '本图未标定：不输出精确米数或里程，尺度结论保持 unknown。');
  } else {
    const drift = finiteNumber(input.scale?.aspectDrift);
    if (input.scale?.implausible === true || (drift !== null && Math.abs(drift) > ASPECT_DRIFT_REVIEW_THRESHOLD)) {
      note('scale', 'review', 'MAP_SCALE_IMPLAUSIBLE',
        `尺度比例可疑${drift !== null ? `（偏差 ${drift.toFixed(2)}）` : ''}：列 review，不改锁、不重排既有布局。`);
    } else {
      note('scale', 'pass', 'MAP_SCALE_OK', '尺度已标定且比例在合理范围内。');
    }
  }

  /* 5 合理性：不支持的结构列 review。 */
  if (!checked.has('plausibility')) {
    note('plausibility', 'unknown', 'MAP_QUALITY_NOT_CHECKED', '合理性检查未做：不写成通过。');
  } else {
    const unsupported = nonNegative(input.plausibility?.unsupportedStructures);
    if (unsupported > 0) {
      note('plausibility', 'review', 'MAP_PLAUSIBILITY_UNSUPPORTED',
        `有 ${unsupported} 处结构当前模板表达不了：如实列 review，不靠改 kind 或删路线让它「完整」。`);
    } else {
      note('plausibility', 'pass', 'MAP_PLAUSIBILITY_OK', '未发现表达不了的结构。');
    }
  }

  const hardFail = MAP_QUALITY_DIMENSIONS.some((dimension) => HARD_DIMENSIONS.has(dimension) && dimensions[dimension] === 'fail');
  const hasUnknown = MAP_QUALITY_DIMENSIONS.some((dimension) => dimensions[dimension] === 'unknown');
  const hasReview = MAP_QUALITY_DIMENSIONS.some((dimension) => dimensions[dimension] === 'review');
  const verdict: MapQualityVerdict = hardFail
    ? 'blocked'
    : hasUnknown
      ? 'unknown'
      : hasReview
        ? 'review'
        : 'pass';

  const inspected = MAP_QUALITY_DIMENSIONS.every((dimension) => dimensions[dimension] !== 'unknown');

  if (hardFail) {
    issues.push({
      code: 'MAP_QUALITY_BLOCKED',
      path: `$.maps.${mapId}.quality`,
      message: '硬几何 / 锁 / 必要通路失败：本图不发布，保留上一版完整结果并记录原因。',
      severity: 'error',
      retryable: true,
      mapId,
    });
  }

  const scaleQuality = input.scaleQuality ?? (input.calibrated ? 'estimated' : 'uncalibrated');
  const scalePrecision: ScalePrecision = scaleQuality === 'confirmed' && input.calibrated
    ? 'exact-meters'
    : input.calibrated || scaleQuality === 'estimated'
      ? 'approximate'
      : 'unknown';

  return {
    version: 1,
    mapId,
    inspected,
    dimensions,
    verdict,
    scalePrecision,
    findings,
    issues,
  };
}
