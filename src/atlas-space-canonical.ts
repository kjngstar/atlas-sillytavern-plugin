/**
 * atlas-space-canonical.ts — P12/R03 §19：每个具体空间的小型权威（SpaceCanonicalV1）。
 *
 * 它回答两个问题，别的都不管：
 * 1. **这个空间到底多大**（米），这个数字是谁给的（作者锁 / 已确认 / 父图足迹 / 首次估计）；
 * 2. **这个空间里有哪些布局陈设**，每一条的稳定空间 localId 是什么，哪一条挂在真实 SQL item 上。
 *
 * 纪律（逐条对应 §19.1）：
 * - 身份是 `locationId`，持有者是「该地点的**唯一** active 容器图」的 frame；
 *   不拿短引用或地图标题当身份。多持有者 → `SPACE_CONTAINER_AMBIGUOUS`，宁缺勿乱。
 * - 存放在 frame 的独立命名空间 `atlasSpaceCanonical`，**不**下发到公开 frame；
 *   它**不是**世界进度仓库，也不与 scene 抢位置（scene 是画面，canonical 是账本）。
 * - 陈设首版至多 128 条；超限**明确 deferred 并保留原记录**，绝不静默裁剪、也绝不放宽
 *   `LIMITS.sceneBytes` 去装新家具。
 * - 尺寸选择顺序：作者锁/可追踪确认尺寸 → 已有 canonical → 可追踪父图足迹 → 首次估计。
 *   双方都确认/锁定且矛盾 → `SPACE_SIZE_CONFLICT`，双方原事实都保留；绝不按"最新时间"覆盖。
 *
 * 本模块是纯函数集合：不写库、不开事务、不发请求。
 */

import { normalizeFrame } from './atlas-spatial-frame.ts';
import {
  FRAME_SPACE_CANONICAL_KEY,
  SPACE_CANONICAL_MAX_FURNISHING as KIT_MAX_FURNISHING,
  spaceLocalId,
  parseSpaceLocalId,
  readMetricDimensions,
} from '../vendor/atlas-spatial/index.mjs';
import type { PlanIssue } from './atlas-world-contract.ts';

/** frame 里保存空间权威的命名空间（字面量唯一权威在 vendor/contracts.mjs）。 */
export const SPACE_CANONICAL_FRAME_KEY = FRAME_SPACE_CANONICAL_KEY;
export const SPACE_CANONICAL_VERSION = 1;
/** 首版陈设条目上限（与提示词、测试共用一个权威）。 */
export const SPACE_CANONICAL_MAX_FURNISHING = KIT_MAX_FURNISHING;
/** 空间尺寸允许的相对误差（0.5%）：幅面与物理尺寸一致的判定口径。 */
export const SPACE_SIZE_REL_TOLERANCE = 0.005;
/** 空间尺寸的绝对下限（米）：小于它就不叫"空间尺寸"，叫噪声。 */
export const SPACE_MIN_SIDE_M = 0.2;
/** 空间尺寸的绝对上限（米）：与 LIMITS.citySide 同量级，超过就是不可能是真实空间。 */
export const SPACE_MAX_SIDE_M = 20000;

export type SpaceSizeQuality = 'estimated' | 'confirmed';
export type SpaceSizeBasisKind = 'author' | 'source' | 'parent-footprint' | 'first-estimate';

export type SpaceSizeBasis = {
  kind: SpaceSizeBasisKind;
  referenceId: string | null;
  note: string;
};

export type SpaceCanonicalSize = {
  widthM: number;
  heightM: number;
  quality: SpaceSizeQuality;
  locked: boolean;
  basis: SpaceSizeBasis;
};

export type SpaceCanonicalFurnishing = {
  localId: string;
  type: string;
  name: string;
  itemId: string | null;
  widthM: number;
  heightM: number;
  quality: 'layout' | 'confirmed';
};

export type SpaceCanonicalV1 = {
  version: 1;
  locationId: string;
  revision: number;
  size: SpaceCanonicalSize | null;
  furnishing: SpaceCanonicalFurnishing[];
};

/** SQL 行在纯函数里的统一形状（本模块不依赖任何 DB 接口）。 */
type Row = Record<string, unknown>;
const plain = (value: unknown): value is Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const asId = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const asText = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** 单轴合法性：有限、正、在 0.2–20000 米之间。 */
function validSide(value: unknown): value is number {
  return finite(value) && value >= SPACE_MIN_SIDE_M && value <= SPACE_MAX_SIDE_M;
}

/** 两轴差异是否超出 0.5%（任选一个轴当分母，两边都要过）。 */
export function sizesAgree(
  left: { widthM: number; heightM: number },
  right: { widthM: number; heightM: number },
  tolerance = SPACE_SIZE_REL_TOLERANCE,
): boolean {
  const near = (a: number, b: number): boolean => {
    const base = Math.max(Math.abs(a), Math.abs(b), 1e-9);
    return Math.abs(a - b) / base <= tolerance;
  };
  return near(left.widthM, right.widthM) && near(left.heightM, right.heightM);
}

// ───────────────────────── 陈设 localId ─────────────────────────

/**
 * 局部 ID 格式的**唯一**实现在 `vendor/atlas-spatial/contracts.mjs`
 * （kit 内 host-context / generation / storage 三个使用点共用同一份字面量），
 * 这里只转发，不写第二份格式。
 */
export { spaceLocalId, parseSpaceLocalId };

export function isSpaceLocalId(value: unknown): boolean {
  return parseSpaceLocalId(value) !== null;
}

// ───────────────────────── 读写 ─────────────────────────

export type SpaceCanonicalRead = {
  ok: boolean;
  canonical: SpaceCanonicalV1 | null;
  /** 陈设条目超上限：记录仍在，但调用方**不得**继续追加；也绝不当成已裁剪。 */
  deferred: boolean;
  issues: PlanIssue[];
};

function issue(code: string, path: string, message: string, severity: 'warning' | 'error' = 'error'): PlanIssue {
  return { code, path, message, severity, retryable: false };
}

/** 校验一条陈设条目；不合法返回 null（由调用方决定是整体失败还是跳过）。 */
function readFurnishing(raw: unknown, locationId: string): SpaceCanonicalFurnishing | null {
  if (!plain(raw)) return null;
  const localId = asId(raw.localId);
  const type = asId(raw.type);
  if (!localId || !type) return null;
  const parsed = parseSpaceLocalId(localId);
  if (!parsed || parsed.locationId !== locationId) return null;
  // 陈设可小于房间的最小边长，例如薄门洞与小灯具。
  if (!finite(raw.widthM) || raw.widthM <= 0 || raw.widthM > SPACE_MAX_SIDE_M
    || !finite(raw.heightM) || raw.heightM <= 0 || raw.heightM > SPACE_MAX_SIDE_M) return null;
  const itemId = asId(raw.itemId);
  return {
    localId,
    type,
    name: asText(raw.name) ?? type,
    itemId,
    widthM: raw.widthM,
    heightM: raw.heightM,
    quality: raw.quality === 'confirmed' ? 'confirmed' : 'layout',
  };
}

function readSize(raw: unknown): SpaceCanonicalSize | null {
  if (raw === null || raw === undefined) return null;
  if (!plain(raw)) return null;
  if (!validSide(raw.widthM) || !validSide(raw.heightM)) return null;
  const basisRaw = plain(raw.basis) ? raw.basis : {};
  const kind = asStringBasis(basisRaw.kind);
  return {
    widthM: raw.widthM,
    heightM: raw.heightM,
    quality: raw.quality === 'confirmed' ? 'confirmed' : 'estimated',
    locked: raw.locked === true,
    basis: {
      kind,
      referenceId: asId(basisRaw.referenceId),
      note: typeof basisRaw.note === 'string' ? basisRaw.note : '',
    },
  };
}

function asStringBasis(value: unknown): SpaceSizeBasisKind {
  return value === 'author' || value === 'source' || value === 'parent-footprint' || value === 'first-estimate'
    ? value
    : 'first-estimate';
}

/**
 * 读出本图持有的空间权威。
 *
 * - 没有该命名空间 → `ok:true, canonical:null`（老图一律走「未登记空间尺寸」，不报错）。
 * - 结构损坏 / 版本未知 / 身份与期望不符 → `ok:false, canonical:null`（**不采用**坏记录）。
 * - 陈设超上限 → `deferred:true` + warning，记录**原样**返回（未裁剪）。
 */
export function readSpaceCanonical(frame: unknown, expectedLocationId?: string | null): SpaceCanonicalRead {
  const source = normalizeFrame(frame);
  const raw = source[SPACE_CANONICAL_FRAME_KEY];
  if (raw === undefined || raw === null) return { ok: true, canonical: null, deferred: false, issues: [] };
  const path = `$.frame_json.${SPACE_CANONICAL_FRAME_KEY}`;
  if (!plain(raw)) {
    return { ok: false, canonical: null, deferred: false, issues: [issue('SPACE_CANONICAL_INVALID', path, '空间权威记录不是对象，本轮按未登记处理（不采用坏记录）')] };
  }
  if (raw.version !== SPACE_CANONICAL_VERSION) {
    return {
      ok: false, canonical: null, deferred: false,
      issues: [issue('SPACE_CANONICAL_VERSION_UNSUPPORTED', path, `空间权威版本 ${JSON.stringify(raw.version)} 不是 ${SPACE_CANONICAL_VERSION}，本轮不采用`)],
    };
  }
  const locationId = asId(raw.locationId);
  if (!locationId) {
    return { ok: false, canonical: null, deferred: false, issues: [issue('SPACE_CANONICAL_INVALID', path, '空间权威缺少 locationId：空间身份必须以真实地点 ID 表达')] };
  }
  if (expectedLocationId && locationId !== expectedLocationId) {
    return {
      ok: false, canonical: null, deferred: false,
      issues: [issue('SPACE_CANONICAL_IDENTITY_MISMATCH', path, `本图持有的是 ${locationId} 的空间权威，与期望的 ${expectedLocationId} 不符；不混用、不迁移`)],
    };
  }
  const revision = finite(raw.revision) && Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  const rawList = Array.isArray(raw.furnishing) ? raw.furnishing : [];
  const furnishing: SpaceCanonicalFurnishing[] = [];
  const issues: PlanIssue[] = [];
  for (let index = 0; index < rawList.length; index += 1) {
    const entry = readFurnishing(rawList[index], locationId);
    if (!entry) {
      issues.push(issue('SPACE_FURNISHING_INVALID', `${path}.furnishing[${index}]`, '陈设账本条目不可用：localId 必须是本空间的 space:<locationId>:furn:<id>，且尺寸为正数；该项跳过，其他项继续', 'warning'));
      continue;
    }
    furnishing.push(entry);
  }
  const deferred = furnishing.length > SPACE_CANONICAL_MAX_FURNISHING;
  if (deferred) {
    issues.push(issue(
      'SPACE_FURNISHING_DEFERRED',
      `${path}.furnishing`,
      `空间陈设账本已有 ${furnishing.length} 条，超过首版上限 ${SPACE_CANONICAL_MAX_FURNISHING}：本轮明确 deferred（不追加、不静默裁剪），原记录完整保留`,
      'warning',
    ));
  }
  return { ok: true, canonical: { version: 1, locationId, revision, size: readSize(raw.size), furnishing }, deferred, issues };
}


// ───────────────────────── 尺寸选择顺序 ─────────────────────────

export type SpaceSizeSource = SpaceSizeBasisKind | 'canonical';

export type SpaceSizeCandidate = {
  source: SpaceSizeSource;
  widthM: number;
  heightM: number;
  quality: SpaceSizeQuality;
  referenceId: string | null;
};

export type SpaceSizeResolution = {
  widthM: number;
  heightM: number;
  quality: SpaceSizeQuality;
  /** 本轮真正采用的来源（author / canonical / parent-footprint / first-estimate）。 */
  source: SpaceSizeSource;
  basis: SpaceSizeBasis;
  /** 双方都确认/锁定且矛盾（保留作者事实，权威记录不改写）。 */
  conflict: boolean;
  sources: SpaceSizeCandidate[];
  issues: PlanIssue[];
};

/** 从 locations 行的确认多边形读轴对齐宽高；非轴对齐（斜置/非矩形）返回 null。 */
export function confirmedAreaSize(row: Row | null, parentMap: Row | null): { widthM: number; heightM: number } | null {
  if (!row) return null;
  const raw = row.area_geometry_json;
  const area = typeof raw === 'string'
    ? (() => { try { return JSON.parse(raw) as unknown; } catch { return null; } })()
    : raw;
  if (!plain(area) || area.quality !== 'confirmed') return null;
  const dimensions=readMetricDimensions(area);
  if (dimensions) return dimensions;
  // Positioned SQL polygons use cells of the owning map. A metric size does not.
  const metersPerCell = parentMap?.meters_per_cell;
  if (!parentMap || asId(parentMap.id) !== asId(row.map_id)
    || !finite(metersPerCell) || metersPerCell <= 0
    || area.kind !== 'polygon' || !Array.isArray(area.points)) return null;
  const points = area.points.filter(plain).filter((p) => finite(p.x) && finite(p.y));
  if (points.length < 4) return null;
  const xs = points.map((p) => p.x as number);
  const ys = points.map((p) => p.y as number);
  const x = Math.min(...xs), y = Math.min(...ys);
  const w = Math.max(...xs) - x, h = Math.max(...ys) - y;
  const widthM = w * metersPerCell, heightM = h * metersPerCell;
  if (!validSide(widthM) || !validSide(heightM)) return null;
  const axisAligned = points.every(
    (p) => (Math.abs((p.x as number) - x) < 1e-6 || Math.abs((p.x as number) - x - w) < 1e-6)
      && (Math.abs((p.y as number) - y) < 1e-6 || Math.abs((p.y as number) - y - h) < 1e-6),
  );
  if (!axisAligned) return null;
  return { widthM, heightM };
}

/**
 * 尺寸选择顺序（§19.2）：作者锁/确认 → canonical → 父图足迹 → 首次估计。
 *
 * 「双方都确认或锁定且矛盾」→ `SPACE_SIZE_CONFLICT`：**返回作者事实**（作者锁不被生成器覆盖），
 * 同时把 canonical 事实留在 `sources` 里供报告与修复流程使用；绝不按时间覆盖。
 */
export function resolveSpaceSize(input: {
  locationId: string;
  author?: { widthM: number; heightM: number; referenceId: string | null; note: string } | null;
  canonical?: SpaceCanonicalV1 | null;
  parentFootprint?: { widthM: number; heightM: number; mapId: string } | null;
  firstEstimate?: { widthM: number; heightM: number } | null;
}): SpaceSizeResolution | null {
  const sources: SpaceSizeCandidate[] = [];
  const issues: PlanIssue[] = [];
  const path = `$.spaces.${input.locationId}.size`;
  const author = input.author && validSide(input.author.widthM) && validSide(input.author.heightM) ? input.author : null;
  const canonicalSize = input.canonical?.size && validSide(input.canonical.size.widthM) && validSide(input.canonical.size.heightM)
    ? input.canonical.size : null;
  const parent = input.parentFootprint && validSide(input.parentFootprint.widthM) && validSide(input.parentFootprint.heightM)
    ? input.parentFootprint : null;
  const estimate = input.firstEstimate && validSide(input.firstEstimate.widthM) && validSide(input.firstEstimate.heightM)
    ? input.firstEstimate : null;
  if (author) sources.push({ source: 'author', widthM: author.widthM, heightM: author.heightM, quality: 'confirmed', referenceId: author.referenceId });
  if (canonicalSize) sources.push({ source: 'canonical', widthM: canonicalSize.widthM, heightM: canonicalSize.heightM, quality: canonicalSize.quality, referenceId: input.canonical?.locationId ?? null });
  if (parent) sources.push({ source: 'parent-footprint', widthM: parent.widthM, heightM: parent.heightM, quality: 'estimated', referenceId: parent.mapId });
  if (estimate) sources.push({ source: 'first-estimate', widthM: estimate.widthM, heightM: estimate.heightM, quality: 'estimated', referenceId: null });

  const authorLocked = !!author;
  const canonicalLocked = !!canonicalSize && (canonicalSize.quality === 'confirmed' || canonicalSize.locked);
  const conflict = authorLocked && canonicalLocked && !sizesAgree(author, canonicalSize);
  if (conflict) {
    issues.push({
      code: 'SPACE_SIZE_CONFLICT',
      path,
      message: `空间 ${input.locationId} 的确认尺寸矛盾：作者/来源 ${author && author.widthM}×${author && author.heightM} m（${author?.referenceId ?? 'author'}）与已保存权威 ${canonicalSize?.widthM}×${canonicalSize?.heightM} m（${canonicalSize?.basis.referenceId ?? canonicalSize?.basis.kind}）不一致；双方原事实都保留，本轮列出来源与受影响图，不按最新时间覆盖`,
      severity: 'warning',
      retryable: false,
      locationId: input.locationId,
    });
  }

  if (author) {
    return {
      widthM: author.widthM, heightM: author.heightM, quality: 'confirmed', source: 'author', conflict,
      basis: { kind: 'author', referenceId: author.referenceId, note: author.note },
      sources, issues,
    };
  }
  if (canonicalSize) {
    return {
      widthM: canonicalSize.widthM, heightM: canonicalSize.heightM, quality: canonicalSize.quality, source: 'canonical', conflict,
      basis: { ...canonicalSize.basis },
      sources, issues,
    };
  }
  if (parent) {
    return {
      widthM: parent.widthM, heightM: parent.heightM, quality: 'estimated', source: 'parent-footprint', conflict,
      basis: { kind: 'parent-footprint', referenceId: parent.mapId, note: '由父图空间轮廓投影得到' },
      sources, issues,
    };
  }
  if (estimate) {
    return {
      widthM: estimate.widthM, heightM: estimate.heightM, quality: 'estimated', source: 'first-estimate', conflict,
      basis: { kind: 'first-estimate', referenceId: null, note: '首次估计' },
      sources, issues,
    };
  }
  return null;
}

// ───────────────────────── 定位持有者 ─────────────────────────

/** 地图行是否 active。 */
const isActive = (row: Row): boolean => String(row.status ?? 'active') === 'active';

/**
 * 找出某地点的**唯一** active 容器图（canonical 的持有者）。
 * 0 个 → `holder:null`（先走统一候选路径建立/诊断，不在两个父图各存一份权威）；
 * 多个 → 记 `SPACE_CONTAINER_AMBIGUOUS` 并返回 null（宁可不采用，也不随机挑一张）。
 */
export function spaceCanonicalHolder(
  maps: readonly Row[],
  locationId: string,
): { holder: Row | null; issues: PlanIssue[] } {
  const candidates = maps.filter((map) => asId(map.container_location_id) === locationId && isActive(map));
  if (candidates.length === 0) return { holder: null, issues: [] };
  if (candidates.length > 1) {
    const ids = candidates.map((map) => String(map.id)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return {
      holder: null,
      issues: [{
        code: 'SPACE_CONTAINER_AMBIGUOUS',
        path: `$.spaces.${locationId}`,
        message: `地点 ${locationId} 有 ${ids.length} 张 active 容器图（${ids.join('、')}）：空间权威必须有唯一持有者，本轮不采用任何一份，先让作者合并/停用多余图`,
        severity: 'warning',
        retryable: false,
        locationId,
        relatedIds: ids,
      }],
    };
  }
  return { holder: candidates[0] ?? null, issues: [] };
}

/** 从某张图已保存的场景里找该地点在同一物理空间里的轮廓（父图足迹）。 */
function footprintInScene(scene: Row | null, locationId: string, map: Row): { widthM: number; heightM: number } | null {
  if (!scene) return null;
  const layout = plain(scene.layout) ? scene.layout : null;
  if (!layout) return null;
  const factor=scene.units==='meters'?1:scene.units==='cells'&&finite(map.meters_per_cell)&&map.meters_per_cell>0?map.meters_per_cell:null;
  if(factor===null)return null;
  const pools: unknown[] = [layout.rooms, layout.buildings, layout.districts, layout.shapes, layout.corridor ? [layout.corridor] : []];
  for (const pool of pools) {
    if (!Array.isArray(pool)) continue;
    for (const entry of pool) {
      if (!plain(entry)) continue;
      if (asId(entry.id) !== locationId) continue;
      let w=entry.w,h=entry.h;
      if(Array.isArray(entry.polygon)&&entry.polygon.length>=3){
        const points=entry.polygon.map(p=>Array.isArray(p)?p:plain(p)?[p.x,p.y]:[]);
        if(points.every(p=>p.length===2&&finite(p[0])&&finite(p[1]))){w=Math.max(...points.map(p=>p[0] as number))-Math.min(...points.map(p=>p[0] as number));h=Math.max(...points.map(p=>p[1] as number))-Math.min(...points.map(p=>p[1] as number));}
      }
      if (finite(w)&&finite(h)&&validSide(w*factor)&&validSide(h*factor)) return { widthM: w*factor, heightM: h*factor };
    }
  }
  return null;
}

function sceneOf(frame: unknown, branchId: string | null, mapId: string): Row | null {
  const normalized = normalizeFrame(frame);
  const scene = normalized.atlasScene;
  if (!plain(scene)) return null;
  if (branchId && asId(scene.branchId) !== branchId) return null;
  if (asId(scene.mapId) !== mapId) return null;
  return scene;
}

export type LocationSpaceSize = {
  widthM: number;
  heightM: number;
  quality: SpaceSizeQuality;
  source: SpaceSizeSource;
  referenceId: string | null;
};

export type LocationSpaceSizeInput = {
  maps: readonly Row[];
  locations: readonly Row[];
  locationId: string;
  branchId?: string | null;
};

/**
 * 某个**地点**当前已知的空间尺寸（不含「首次估计」）。
 *
 * 顺序：作者确认轮廓 → 该地点唯一容器图里的 canonical → 该地点所属父图场景里的轮廓。
 * 三处都没有 → null（调用方自己决定要不要按 frame 估一个）。这既是具体图自己的尺寸来源，
 * 也是**父图检查子空间能不能装下**时用的同一口径（不另写第二套）。
 */
export function locationSpaceSize(input: LocationSpaceSizeInput): LocationSpaceSize | null {
  const locationRow = input.locations.find((row) => asId(row.id) === input.locationId) ?? null;
  const confirmed = confirmedAreaSize(locationRow, input.maps.find((row) => asId(row.id) === asId(locationRow?.map_id)) ?? null);
  if (confirmed) {
    return { widthM: confirmed.widthM, heightM: confirmed.heightM, quality: 'confirmed', source: 'author', referenceId: input.locationId };
  }
  const { holder } = spaceCanonicalHolder(input.maps, input.locationId);
  if (holder) {
    const read = readSpaceCanonical(holder.frame_json, input.locationId);
    if (read.canonical?.size && validSide(read.canonical.size.widthM) && validSide(read.canonical.size.heightM)) {
      return {
        widthM: read.canonical.size.widthM,
        heightM: read.canonical.size.heightM,
        quality: read.canonical.size.quality,
        source: 'canonical',
        referenceId: asId(holder.id),
      };
    }
  }
  const parentMapId = asId(locationRow?.map_id);
  if (parentMapId) {
    const parentMap = input.maps.find((row) => asId(row.id) === parentMapId) ?? null;
    if (parentMap) {
      const footprint = footprintInScene(sceneOf(parentMap.frame_json, input.branchId ?? null, parentMapId), input.locationId, parentMap);
      if (footprint) return { ...footprint, quality: 'estimated', source: 'parent-footprint', referenceId: parentMapId };
    }
  }
  return null;
}

export type MapSpaceSizeInput = {
  maps: readonly Row[];
  locations: readonly Row[];
  mapRow: Row;
  branchId?: string | null;
  /** 兜底"首次估计"（例如按 frame 标定算出的 extent）。 */
  firstEstimate?: { widthM: number; heightM: number } | null;
};

export type MapSpaceSizeResult = {
  locationId: string;
  holder: Row | null;
  canonical: SpaceCanonicalV1 | null;
  resolution: SpaceSizeResolution;
  issues: PlanIssue[];
};

/**
 * 某张具体图所覆盖空间（= 它的 container 地点）的尺寸权威。
 *
 * 顺序与 `resolveSpaceSize` 完全一致：作者确认轮廓 → 该地点唯一容器图里的 canonical →
 * 该地点所属**父图**场景里的轮廓 → 本图自己按 frame 的估计。
 * 非具体图（没有 container）→ null（概览/城市不参与空间尺寸权威）。
 */
export function resolveMapSpaceSize(input: MapSpaceSizeInput): MapSpaceSizeResult | null {
  const containerId = asId(input.mapRow.container_location_id);
  if (!containerId) return null;
  const locationRow = input.locations.find((row) => asId(row.id) === containerId) ?? null;
  const issues: PlanIssue[] = [];

  const confirmed = confirmedAreaSize(locationRow, input.maps.find((row) => asId(row.id) === asId(locationRow?.map_id)) ?? null);
  const author = confirmed
    ? { widthM: confirmed.widthM, heightM: confirmed.heightM, referenceId: containerId, note: '作者确认的多边形轮廓（轴对齐）' }
    : null;

  const holder = spaceCanonicalHolder(input.maps, containerId);
  issues.push(...holder.issues);
  let canonical: SpaceCanonicalV1 | null = null;
  if (holder.holder) {
    const read = readSpaceCanonical(holder.holder.frame_json, containerId);
    issues.push(...read.issues.map((item) => ({ ...item, locationId: containerId })));
    canonical = read.canonical;
  }

  // 父图足迹：该地点自己"住"在哪张图（locations.map_id），从那张图的场景里找它的轮廓。
  let parentFootprint: { widthM: number; heightM: number; mapId: string } | null = null;
  const parentMapId = asId(locationRow?.map_id);
  if (parentMapId && parentMapId !== asId(input.mapRow.id)) {
    const parentMap = input.maps.find((row) => asId(row.id) === parentMapId) ?? null;
    if (parentMap) {
      const footprint = footprintInScene(sceneOf(parentMap.frame_json, input.branchId ?? null, parentMapId), containerId, parentMap);
      if (footprint) parentFootprint = { ...footprint, mapId: parentMapId };
    }
  }

  const resolution = resolveSpaceSize({
    locationId: containerId,
    author,
    canonical,
    parentFootprint,
    firstEstimate: input.firstEstimate ?? null,
  });
  if (!resolution) return null;
  return { locationId: containerId, holder: holder.holder, canonical, resolution, issues };
}
