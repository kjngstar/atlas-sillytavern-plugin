/**
 * atlas-space-estimate.ts — 物理尺度估计（P06 §12.2）。
 *
 * 这一层回答一个问题：**这张图该有多大，依据是什么**。
 * 它不画图、不改幅面，只给出「多少米 × 多少米」和这条估计的来源等级；
 * 幅面对齐交给 `alignSqlFrameToPhysicalSize`，布局交给 `measure`。
 *
 * 优先级（与 §12.2 一致，本模块只负责最后一档）：
 *   作者确认 / 已确认事实 → 既有 canonical → 可信父图足迹 → 类型默认估计 → 待估计
 *
 * 纪律：
 * - 类型默认值只是**解释性估计**，永远标 `estimated`，不冒充实测标准。
 * - 只有 vehicle 标签、说不出是哪类载具 → 保留待估计（返回 null），不猜。
 * - 平方米与格不混算；`fitFrameToPhysicalSize` 是唯一把米换算成 grid 的地方。
 * - 不主动改旧档的既有尺度：本模块只服务新数据与明确新事实。
 */

import type { PlanIssue } from './atlas-world-contract.ts';

/** 一格对应的米数默认值：新图首次出图时的统一换算基准。 */
export const DEFAULT_METERS_PER_CELL = 0.5;

/**
 * 载具类型兜底尺寸（局部米制）。
 *
 * 这些是**产品兜底**，不是跨世界硬标准：有作者尺寸、canonical 或世界书事实时一律优先。
 * 顺序即匹配优先级 —— 「小船」必须先于「船」判断，否则舢板会被估成 40 米。
 */
export const VEHICLE_TYPE_DEFAULTS = [
  { type: 'carriage', widthM: 6, heightM: 3, keywords: ['马车', '车厢', 'carriage', 'wagon', 'cart'] },
  { type: 'boat', widthM: 8, heightM: 3, keywords: ['小船', '舢板', '木舟', 'rowboat', 'dinghy', 'boat'] },
  { type: 'train', widthM: 120, heightM: 3.2, keywords: ['列车', '火车', 'train', 'locomotive'] },
  { type: 'airship', widthM: 60, heightM: 15, keywords: ['飞艇', 'airship', 'zeppelin'] },
  { type: 'ship', widthM: 40, heightM: 12, keywords: ['船', '舰', 'ship', 'vessel', 'galleon'] },
] as const;

export type VehicleType = (typeof VEHICLE_TYPE_DEFAULTS)[number]['type'];

export type SpaceEstimateSource =
  /** 只有兜底尺寸可用：明确标 estimated。 */
  | 'type-default'
  /** 说不出是哪类载具，也拿不到尺寸。 */
  | 'none';

export type SpaceEstimateV1 = {
  widthM: number;
  heightM: number;
  /** 一定是 estimated —— 这一档不允许产生 confirmed / calibrated。 */
  quality: 'estimated';
  source: SpaceEstimateSource;
  /** 命中的载具类型；`none` 时为 null。 */
  vehicleType: VehicleType | null;
  /** 依据说明，进诊断与回执，不贴在玩家地图上。 */
  assumption: string;
  issues: readonly PlanIssue[];
};

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function validSide(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function issue(code: string, path: string, message: string, retryable: boolean): PlanIssue {
  return { code, path, message, severity: 'warning', retryable };
}

/** 从载具档案里读显式类型（`vehicle_profile_json` 可能已被解析成对象，也可能是原始 JSON 串）。 */
function explicitVehicleType(profile: unknown): VehicleType | null {
  if (!profile) return null;
  let raw: unknown = profile;
  if (typeof profile === 'string') {
    try {
      raw = JSON.parse(profile);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const declared = text(record.type ?? record.kind ?? record.vehicleType ?? record.class).toLowerCase();
  if (declared.length === 0) return null;
  const hit = VEHICLE_TYPE_DEFAULTS.find((entry) => entry.type === declared);
  return hit ? hit.type : null;
}

/** 只在「明确的载具类型线索」上命中；不拿宽泛词硬猜。 */
function keywordVehicleType(haystack: string): VehicleType | null {
  const textValue = haystack.toLowerCase();
  if (textValue.length === 0) return null;
  for (const entry of VEHICLE_TYPE_DEFAULTS) {
    if (entry.keywords.some((keyword) => textValue.includes(keyword.toLowerCase()))) return entry.type;
  }
  return null;
}

/**
 * §12.2 的类型默认估计。
 *
 * 只处理 containerKind === 'vehicle'：
 * - 有显式类型（vehicle_profile.type）→ 用它的兜底尺寸；
 * - 没有显式类型但名称/描述里有明确类型词 → 用命中的兜底尺寸；
 * - 只有「载具」这个标签 → 返回 null 并报 `SPACE_ESTIMATE_TYPE_UNKNOWN`，保留待估计。
 *
 * 其它 containerKind 返回 null：房间/建筑/城市的估计仍由既有 ROOM/CITY 基准负责，
 * 本模块不改变它们的既有行为。
 */
export function estimateSpaceFromType(input: {
  containerKind: unknown;
  locationId?: string | null;
  name?: unknown;
  description?: unknown;
  vehicleProfile?: unknown;
}): SpaceEstimateV1 | null {
  const containerKind = text(input?.containerKind).toLowerCase();
  if (containerKind !== 'vehicle') return null;

  const locationId = text(input?.locationId ?? '');
  const path = locationId.length > 0 ? `$.spaces.${locationId}.size` : '$.spaces.size';

  const explicit = explicitVehicleType(input?.vehicleProfile);
  const guessed = explicit ?? keywordVehicleType(`${text(input?.name)}\n${text(input?.description)}`);
  if (guessed === null) {
    return {
      widthM: 0,
      heightM: 0,
      quality: 'estimated',
      source: 'none',
      vehicleType: null,
      assumption: '只有「载具」标签，没有类型或尺寸依据',
      issues: [issue(
        'SPACE_ESTIMATE_TYPE_UNKNOWN',
        path,
        '该空间是载具，但档案里既没有类型也没有尺寸：保留待估计，不按马车兜底、也不硬塞一个方形幅面。',
        false,
      )],
    };
  }

  const preset = VEHICLE_TYPE_DEFAULTS.find((entry) => entry.type === guessed);
  if (!preset) return null;

  return {
    widthM: preset.widthM,
    heightM: preset.heightM,
    quality: 'estimated',
    source: 'type-default',
    vehicleType: preset.type,
    assumption: explicit
      ? `载具档案声明类型 ${preset.type}，局部兜底 ${preset.widthM}×${preset.heightM} m（estimated，不是实测标准）`
      : `名称/描述命中载具类型 ${preset.type}，局部兜底 ${preset.widthM}×${preset.heightM} m（estimated，不是实测标准）`,
    issues: [issue(
      'SPACE_SIZE_ESTIMATED_FROM_TYPE',
      path,
      `没有作者尺寸 / canonical / 父图足迹，按类型 ${preset.type} 估计 ${preset.widthM}×${preset.heightM} m；该估计可被后续明确资料纠正。`,
      false,
    )],
  };
}

export type FittedFrame = {
  cols: number;
  rows: number;
  metersPerCell: number;
  widthM: number;
  heightM: number;
};

/**
 * 把物理尺寸换算成 grid 幅面（§12.2：初始 100×100 格不能强制变成正方形物理空间）。
 *
 * 做法是反过来算：先定统一 `metersPerCell`，再由宽高推出 cols/rows，
 * 于是格子是正方形、宽高比与物理尺寸一致，而不是把 100×100 硬压成一个方框。
 * 返回值里的 widthM/heightM 是「格子表达得出来的实际尺寸」——向上取整后会略大于目标，
 * 这是有意的：宁可多留一点边，也不把载具画短。
 */
export function fitFrameToPhysicalSize(input: {
  widthM: unknown;
  heightM: unknown;
  targetMetersPerCell?: unknown;
}): FittedFrame | null {
  if (!validSide(input?.widthM) || !validSide(input?.heightM)) return null;
  const target = validSide(input?.targetMetersPerCell)
    ? Math.min(10, Math.max(0.05, Number(input.targetMetersPerCell)))
    : DEFAULT_METERS_PER_CELL;
  const widthM = Number(input.widthM);
  const heightM = Number(input.heightM);
  const cols = Math.max(1, Math.ceil(widthM / target));
  const rows = Math.max(1, Math.ceil(heightM / target));
  return {
    cols,
    rows,
    metersPerCell: target,
    widthM: cols * target,
    heightM: rows * target,
  };
}
