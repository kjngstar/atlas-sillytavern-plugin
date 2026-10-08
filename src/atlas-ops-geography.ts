/**
 * atlas-ops-geography.ts — D13/D14/D16 地图标定、路线与子地图（§3.1 / §4.2 / §16.9）。
 *
 * 关键规则：
 * - 幅面尺寸 → 米/格区间，尊重 scale_locked；缩放参数不成为米/格输入。
 * - 同图几何与跨图连接分开校验；不用 layout 坐标推导真实距离。
 * - ensureContainerMap：同分支、同 container_location_id、active 的地图至多一张；
 *   已有地图直接复用，未存在则以稳定 ID 创建；查询不会写库。
 */

import type { Issue, ParsedOperation, RowMutation } from './atlas-ops-contract.ts';
import type { CompileContext, CompileResult } from './atlas-ops-compile-types.ts';
import { emptyCompileResult } from './atlas-ops-compile-types.ts';
import { createRow } from './atlas-db-defaults.ts';
import { resolveRef } from './atlas-ops-refs.ts';
import { fieldIgnoredWarning, asString, applyPatch } from './atlas-ops-entities.ts';
import { GEOMETRY_VERTEX_LIMIT } from './atlas-runtime-limits.ts';
import { ATLAS_SCHEMA_VERSION } from './atlas-db-schema.ts';
import { isAtlasLocationKind } from './atlas-location-kinds.ts';
import type { AtlasLocationKind } from './atlas-location-kinds.ts';

const ROUTE_KINDS = ['adjacent', 'road', 'path', 'door', 'stairs', 'air', 'water', 'portal', 'estimated'];
const GEOMETRY_QUALITY = ['confirmed', 'estimated', 'unknown'];
const DISTANCE_BASIS = ['measured', 'calibrated', 'narrative', 'estimated', 'unknown'];
const SCALE_QUALITY = ['uncalibrated', 'estimated', 'confirmed'];
const MOBILITY_MODES = ['walk', 'ride', 'ground_vehicle', 'water', 'flight', 'teleport', 'custom'];

function issue(code: string, path: string, message: string, op: ParsedOperation, extra: Partial<Issue> = {}): Issue {
  return { code, path, message, severity: 'error', retryable: true, opId: op.opId, line: op.line, ...extra };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mutation(
  table: string,
  rowId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  op: ParsedOperation,
  basis: Record<string, unknown>,
): RowMutation {
  return { table, rowId, before, after, sourceOpIds: [op.opId], basis };
}

function basisOf(ctx: CompileContext, op: ParsedOperation): Record<string, unknown> {
  if (ctx.basisFor) return ctx.basisFor(op, { certainty: 'inferred' }) as unknown as Record<string, unknown>;
  return {
    kind: ctx.phase === 'geography' ? 'estimate' : ctx.phase === 'observe' ? 'story' : 'simulation',
    sources: [],
    causes: [],
    reason: op.value.why ?? '地理语义操作',
    verification: ctx.phase === 'observe' ? 'source_bound' : 'causal',
    certainty: 'inferred',
  };
}

/** D13 compileMapEstimate：幅面尺寸 → 米/格区间，尊重 locked。 */
export function compileMapEstimate(op: ParsedOperation, ctx: CompileContext): CompileResult {
  const result = emptyCompileResult();
  const data = (op.value.data ?? {}) as Record<string, unknown>;
  const known = new Set(['width_m', 'height_m', 'meters_per_cell_min', 'meters_per_cell_max', 'basis', 'frame', 'scale_quality']);
  const unknown = Object.keys(data).filter((k) => !known.has(k));
  if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));

  const ref = op.value.ref?.trim();
  if (!ref) {
    result.issues.push(issue('MINIMUM_FIELD_MISSING', '$.ref', 'map.estimate 需要 ref', op));
    return result;
  }
  const resolved = resolveRef(ref, 'map', ctx.scope, { opId: op.opId, line: op.line, field: 'ref' });
  if (!resolved.entry) {
    result.issues.push(...resolved.issues);
    return result;
  }
  const mapId = resolved.entry.id;
  const before = ctx.tables.selectOne('maps', ctx.branchId, mapId);
  if (!before) {
    result.issues.push(issue('REF_UNKNOWN', '$.ref', `地图行不存在：${mapId}`, op));
    return result;
  }

  if (Number(before.scale_locked) === 1) {
    result.issues.push(issue('MAP_SCALE_LOCKED', '$.ref', '用户已锁定该图标定，map.estimate 不修改', op, { retryable: false }));
    return result;
  }

  const widthM = typeof data.width_m === 'number' && Number.isFinite(data.width_m) ? data.width_m : null;
  const heightM = typeof data.height_m === 'number' && Number.isFinite(data.height_m) ? data.height_m : null;
  const minCell = typeof data.meters_per_cell_min === 'number' && Number.isFinite(data.meters_per_cell_min) ? data.meters_per_cell_min : null;
  const maxCell = typeof data.meters_per_cell_max === 'number' && Number.isFinite(data.meters_per_cell_max) ? data.meters_per_cell_max : null;
  const basis = asString(data.basis);

  if (widthM === null && heightM === null && minCell === null && maxCell === null) {
    result.issues.push(
      issue('MINIMUM_FIELD_MISSING', '$.data', 'map.estimate 需要尺寸（width_m/height_m）或比例尺依据（meters_per_cell_min/max）；不能声称精确测量', op),
    );
    return result;
  }
  for (const [name, value] of [['width_m', widthM], ['height_m', heightM], ['meters_per_cell_min', minCell], ['meters_per_cell_max', maxCell]] as const) {
    if (value !== null && value <= 0) {
      result.issues.push(issue('MAP_SCALE_NOT_POSITIVE', `$.data.${name}`, `${name} 必须为正数`, op));
      return result;
    }
  }
  if (minCell !== null && maxCell !== null && minCell > maxCell) {
    result.issues.push(issue('MAP_SCALE_ORDER_INVALID', '$.data', 'meters_per_cell_min 不能大于 meters_per_cell_max', op));
    return result;
  }

  let frame = isPlainObject(before.frame_json) ? (before.frame_json as Record<string, unknown>) : {};
  if(data.frame!==undefined){
    const f=isPlainObject(data.frame)?data.frame:null;
    if(!f||!Number.isInteger(f.cols)||!Number.isInteger(f.rows)||Number(f.cols)<1||Number(f.rows)<1||Number(f.cols)>10000||Number(f.rows)>10000){
      result.issues.push(issue('FRAME_INVALID','$.data.frame','frame.cols/rows 必须是 1～10000 的整数',op));return result;
    }
    frame={...frame,cols:f.cols,rows:f.rows,reference_width_cells:f.cols,reference_height_cells:f.rows};
  }
  const refWidth = typeof frame.reference_width_cells === 'number' && frame.reference_width_cells > 0 ? frame.reference_width_cells : null;
  const refHeight = typeof frame.reference_height_cells === 'number' && frame.reference_height_cells > 0 ? frame.reference_height_cells : null;

  // 主流程优先按宽高范围估计，由程序算名义比例尺（§8.4 map.estimate）。
  let nominal: number | null = null;
  let lower = minCell;
  let upper = maxCell;
  if (widthM !== null && refWidth) {
    nominal = widthM / refWidth;
    if (lower === null || lower > nominal) lower = nominal;
  }
  if (heightM !== null && refHeight) {
    const fromHeight = heightM / refHeight;
    nominal = nominal === null ? fromHeight : (nominal + fromHeight) / 2;
    if (lower === null || lower > fromHeight) lower = Math.min(lower ?? fromHeight, fromHeight);
    if (upper === null || upper < fromHeight) upper = fromHeight;
  }
  if (nominal === null && lower !== null && upper !== null) nominal = (lower + upper) / 2;
  if (nominal === null) nominal = lower ?? upper;

  if (nominal !== null && lower !== null && nominal < lower) lower = nominal;
  if (nominal !== null && upper !== null && nominal > upper) {
    // 上界低于名义值时以上界为准，保持 0<min≤nominal≤max。
    nominal = upper;
  }

  const quality = data.scale_quality !== undefined && SCALE_QUALITY.includes(String(data.scale_quality))
    ? String(data.scale_quality)
    : 'estimated';

  const turnId = ctx.turnId ?? ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;
  const after = applyPatch(before, {
    meters_per_cell: nominal,
    frame_json:frame,
    scale_min_meters_per_cell: lower,
    scale_max_meters_per_cell: upper,
    scale_quality: quality,
    scale_basis_json: { refs: [], note: basis ?? '地图幅面估计', basis: 'AI 尺寸判断' },
    calibration_rev: Number(before.calibration_rev ?? 1) + 1,
    row_rev: Number(before.row_rev ?? 1) + 1,
    updated_turn_id: turnId,
  });
  result.mutations.push(mutation('maps', mapId, before, after, op, basisOf(ctx, op)));
  result.readSet.push({ table: 'maps', rowId: mapId, rowRev: Number(before.row_rev ?? 1) });
  return result;
}

function validateGeometry(
  geometry: unknown,
  op: ParsedOperation,
  issues: Issue[],
  path: string,
): Record<string, unknown> | null {
  if (geometry === undefined || geometry === null) return null;
  if (!isPlainObject(geometry)) {
    issues.push(issue('GEOMETRY_INVALID', path, 'geometry 必须是 {kind,coordinates}', op));
    return null;
  }
  const kind = String(geometry.kind ?? '');
  if (!['point', 'line', 'polygon'].includes(kind)) {
    issues.push(issue('GEOMETRY_INVALID', path, `geometry.kind 非法：${kind}`, op));
    return null;
  }
  if (!Array.isArray(geometry.coordinates)) {
    issues.push(issue('GEOMETRY_INVALID', path, 'geometry.coordinates 必须是数组', op));
    return null;
  }
  if (geometry.coordinates.length > GEOMETRY_VERTEX_LIMIT) {
    issues.push(issue('GEOMETRY_TOO_MANY_VERTICES', path, `geometry 顶点上限 ${GEOMETRY_VERTEX_LIMIT}，收到 ${geometry.coordinates.length}`, op));
    return null;
  }
  const coords: Array<[number, number]> = [];
  for (const point of geometry.coordinates) {
    const pair = Array.isArray(point) ? point : isPlainObject(point) ? [point.x, point.y] : null;
    if (!pair || pair.length < 2) {
      issues.push(issue('GEOMETRY_INVALID', path, 'geometry.coordinates 每项必须是 [x,y]', op));
      return null;
    }
    const x = Number(pair[0]);
    const y = Number(pair[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      issues.push(issue('GEOMETRY_INVALID', path, 'geometry 坐标必须是有限数字（NaN/Infinity 非法）', op));
      return null;
    }
    coords.push([x, y]);
  }
  return { kind, coordinates: coords };
}

/** D14 compileRoutePropose：同图几何/跨图连接分开，保留 estimated。 */
export function compileRoutePropose(op: ParsedOperation, ctx: CompileContext): CompileResult {
  const result = emptyCompileResult();
  const data = (op.value.data ?? {}) as Record<string, unknown>;
  const known = new Set([
    'from_ref', 'to_ref', 'kind', 'bidirectional', 'map_ref', 'geometry', 'quality', 'distance_m',
    'distance_min_m', 'distance_max_m', 'terrain', 'modes', 'access', 'duration',
  ]);
  const unknown = Object.keys(data).filter((k) => !known.has(k));
  if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));

  const ref = op.value.ref?.trim();
  const existingRow = ref && !ref.startsWith('new:') ? resolveRef(ref, 'route', ctx.scope, { opId: op.opId, line: op.line, field: 'ref' }) : null;
  if (ref && !ref.startsWith('new:') && !existingRow?.entry) {
    result.issues.push(...(existingRow?.issues ?? [issue('REF_UNKNOWN', '$.ref', `找不到路线引用：${ref}`, op)]));
    return result;
  }

  const fromRef = data.from_ref ?? null;
  const toRef = data.to_ref ?? null;
  let fromId: string | null = null;
  let toId: string | null = null;
  if (fromRef !== null) {
    const r = resolveRef(String(fromRef), 'location', ctx.scope, { opId: op.opId, field: 'from_ref' });
    if (!r.entry) result.issues.push(...r.issues);
    else fromId = r.entry.id;
  }
  if (toRef !== null) {
    const r = resolveRef(String(toRef), 'location', ctx.scope, { opId: op.opId, field: 'to_ref' });
    if (!r.entry) result.issues.push(...r.issues);
    else toId = r.entry.id;
  }

  const rowId = existingRow?.entry ? existingRow.entry.id : ctx.makeId('route', op.opId, ref && ref.startsWith('new:') ? ref : `route:${fromId}:${toId}`);
  const before = existingRow?.entry ? ctx.tables.selectOne('routes', ctx.branchId, rowId) : null;
  if (existingRow?.entry && !before) {
    result.issues.push(issue('REF_UNKNOWN', '$.ref', `路线行不存在：${rowId}`, op));
    return result;
  }
  if (!fromId) fromId = before ? String(before.from_location_id) : null;
  if (!toId) toId = before ? String(before.to_location_id) : null;
  if (!fromId || !toId) {
    result.issues.push(issue('MINIMUM_FIELD_MISSING', '$.data', 'route.propose 需要 from_ref 与 to_ref', op));
    return result;
  }
  if (fromId === toId) {
    result.issues.push(issue('ROUTE_SELF_LOOP', '$.data', '路线两端不能是同一地点', op));
    return result;
  }

  const geometry = validateGeometry(data.geometry, op, result.issues, '$.data.geometry');
  const mapIdRaw = data.map_ref;
  let mapId: string | null = before ? (before.map_id as string | null) : null;
  if (mapIdRaw !== undefined) {
    if (mapIdRaw === null) mapId = null;
    else {
      const r = resolveRef(String(mapIdRaw), 'map', ctx.scope, { opId: op.opId, field: 'map_ref' });
      if (!r.entry) result.issues.push(...r.issues);
      else mapId = r.entry.id;
    }
  }

  const fromRow = ctx.tables.selectOne('locations', ctx.branchId, fromId);
  const toRow = ctx.tables.selectOne('locations', ctx.branchId, toId);
  const fromMap = fromRow?.map_id ? String(fromRow.map_id) : null;
  const toMap = toRow?.map_id ? String(toRow.map_id) : null;

  // 同图几何 vs 跨图连接（门/楼梯/传送）分开：跨图不用不同坐标系直接相减。
  if (geometry && mapId && fromMap && toMap && fromMap !== toMap) {
    result.issues.push(
      issue('ROUTE_GEOMETRY_CROSS_MAP', '$.data.geometry', '两端地点属于不同地图：跨图连接不要给几何（用两端地点与耗时表达）', op),
    );
    return result;
  }

  let kind = before ? String(before.kind) : 'estimated';
  if (data.kind !== undefined) {
    const k = String(data.kind);
    if (!ROUTE_KINDS.includes(k)) {
      result.issues.push(issue('ENUM_INVALID', '$.data.kind', `路线类型非法：${k}`, op));
      return result;
    }
    kind = k;
  }
  let quality = geometry ? 'confirmed' : before ? String(before.geometry_quality) : 'unknown';
  if (data.quality !== undefined) {
    const q = String(data.quality);
    if (!GEOMETRY_QUALITY.includes(q)) {
      result.issues.push(issue('ENUM_INVALID', '$.data.quality', `geometry quality 非法：${q}`, op));
      return result;
    }
    quality = q;
  }

  const distanceM = typeof data.distance_m === 'number' && Number.isFinite(data.distance_m) ? data.distance_m : null;
  const distanceMin = typeof data.distance_min_m === 'number' && Number.isFinite(data.distance_min_m) ? data.distance_min_m : null;
  const distanceMax = typeof data.distance_max_m === 'number' && Number.isFinite(data.distance_max_m) ? data.distance_max_m : null;
  for (const [name, value] of [['distance_m', distanceM], ['distance_min_m', distanceMin], ['distance_max_m', distanceMax]] as const) {
    if (value !== null && value < 0) {
      result.issues.push(issue('DISTANCE_NEGATIVE', `$.data.${name}`, `${name} 不能为负`, op));
      return result;
    }
  }
  if (distanceMin !== null && distanceM !== null && distanceMin > distanceM) {
    result.issues.push(issue('DISTANCE_ORDER_INVALID', '$.data', 'distance_min_m 不能大于 distance_m', op));
    return result;
  }
  if (distanceMax !== null && distanceM !== null && distanceM > distanceMax) {
    result.issues.push(issue('DISTANCE_ORDER_INVALID', '$.data', 'distance_m 不能大于 distance_max_m', op));
    return result;
  }
  if (distanceMin !== null && distanceMax !== null && distanceMin > distanceMax) {
    result.issues.push(issue('DISTANCE_ORDER_INVALID', '$.data', 'distance_min_m 不能大于 distance_max_m', op));
    return result;
  }

  const modes: string[] = [];
  if (Array.isArray(data.modes)) {
    for (const m of data.modes) {
      const mode = String(m);
      if (!MOBILITY_MODES.includes(mode)) {
        result.issues.push(issue('ENUM_INVALID', '$.data.modes', `移动方式非法：${mode}`, op));
        return result;
      }
      modes.push(mode);
    }
  }

  if (data.access !== undefined && data.access !== null && !isPlainObject(data.access)) {
    result.issues.push(issue('FIELD_TYPE_INVALID', '$.data.access', 'access 必须是条件对象', op));
    return result;
  }
  if (data.duration !== undefined && data.duration !== null && !isPlainObject(data.duration)) {
    result.issues.push(issue('FIELD_TYPE_INVALID', '$.data.duration', 'duration 必须是 TimeEstimate 对象', op));
    return result;
  }

  const distanceBasis = before ? String(before.distance_basis) : 'unknown';
  const resolvedBasis = distanceM !== null || distanceMin !== null || distanceMax !== null
    ? (data.quality === 'confirmed' ? 'calibrated' : 'estimated')
    : distanceBasis;
  if (!DISTANCE_BASIS.includes(resolvedBasis)) {
    result.issues.push(issue('ENUM_INVALID', '$.data', 'distance_basis 无法确定', op));
    return result;
  }

  if (result.issues.some((i) => i.severity === 'error')) return result;

  const turnId = ctx.turnId ?? ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;
  if (before) {
    const after = applyPatch(before, {
      from_location_id: fromId,
      to_location_id: toId,
      kind,
      bidirectional: data.bidirectional === undefined ? before.bidirectional : (data.bidirectional ? 1 : 0),
      map_id: mapId,
      geometry_json: geometry ?? (data.geometry === undefined ? before.geometry_json : null),
      geometry_quality: quality,
      geometry_rev: geometry ? Number(before.geometry_rev ?? 1) + 1 : Number(before.geometry_rev ?? 1),
      distance_m: distanceM ?? before.distance_m,
      distance_min_m: distanceMin ?? before.distance_min_m,
      distance_max_m: distanceMax ?? before.distance_max_m,
      distance_basis: resolvedBasis,
      terrain: data.terrain === undefined ? before.terrain : (asString(data.terrain) ?? 'unknown'),
      allowed_modes_json: data.modes === undefined ? before.allowed_modes_json : modes,
      access_rules_json: data.access === undefined ? before.access_rules_json : data.access,
      travel_time_override_json: data.duration === undefined ? before.travel_time_override_json : data.duration,
      row_rev: Number(before.row_rev ?? 1) + 1,
      updated_turn_id: turnId,
    });
    result.mutations.push(mutation('routes', rowId, before, after, op, basisOf(ctx, op)));
    result.readSet.push({ table: 'routes', rowId, rowRev: Number(before.row_rev ?? 1) });
  } else {
    const row = createRow(
      'routes',
      {
        from_location_id: fromId,
        to_location_id: toId,
        kind,
        bidirectional: data.bidirectional === undefined ? 1 : (data.bidirectional ? 1 : 0),
        map_id: mapId,
        geometry_json: geometry,
        geometry_quality: quality,
        distance_m: distanceM,
        distance_min_m: distanceMin,
        distance_max_m: distanceMax,
        distance_basis: resolvedBasis,
        terrain: asString(data.terrain) ?? 'unknown',
        allowed_modes_json: modes,
        access_rules_json: data.access ?? null,
        travel_time_override_json: data.duration ?? null,
      },
      { branchId: ctx.branchId, id: rowId, turnId, clockS: ctx.clockS, nowWallMs: Date.now(), rulesetVersion: 'atlas-1' },
    );
    result.mutations.push(mutation('routes', rowId, null, row, op, basisOf(ctx, op)));
  }
  result.declaredRefs = ref?.startsWith('new:')
    ? [{ alias: ref, id: rowId, kind: 'route', rowRev: null, declaredByOpId: op.opId }]
    : [];
  return result;
}

/**
 * §16.9 / M4-04：子图 kind 按容器判定。
 *
 * 表按 `AtlasLocationKind` 写全，新增地点类型时这里会编译不过——避免悄悄落进兜底分支：
 * - floor / room / vehicle → interior：楼层与载具内部是真正的室内场景；
 * - region / natural → region：自然区域与地区同级，不能降成 site；
 * - city / district / building / other → site：作为「场所」图纸承载其内部成员。
 *
 * 载具停在哪里不改变它自己的内部图 kind（停车城市不覆盖 vehicle 内图）。
 */
const CONTAINER_MAP_KIND_BY_LOCATION: Record<AtlasLocationKind, 'region' | 'site' | 'interior'> = {
  region: 'region',
  natural: 'region',
  city: 'site',
  district: 'site',
  building: 'site',
  other: 'site',
  floor: 'interior',
  room: 'interior',
  vehicle: 'interior',
};

export function containerMapKind(containerKind: string): 'region' | 'site' | 'interior' {
  return isAtlasLocationKind(containerKind) ? CONTAINER_MAP_KIND_BY_LOCATION[containerKind] : 'interior';
}

/**
 * D16 ensureContainerMap：同一教室重复打开只有一图；查询不会写库。
 * 返回 RowMutation 由调用方放进与触发它的实体/手动操作同组。
 */
export function ensureContainerMap(
  locationId: string,
  ctx: CompileContext,
  triggerOp?: ParsedOperation,
): { mutations: RowMutation[]; mapId: string; created: boolean; issues: Issue[] } {
  const issues: Issue[] = [];
  const location = ctx.tables.selectOne('locations', ctx.branchId, locationId);
  if (!location) {
    issues.push({
      code: 'REF_UNKNOWN',
      path: '$.locationId',
      message: `ensureContainerMap 找不到地点：${locationId}`,
      severity: 'error',
      retryable: false,
      opId: triggerOp?.opId,
    });
    return { mutations: [], mapId: '', created: false, issues };
  }
  const existingMaps = ctx.tables.selectWhere('maps', { branch_id: ctx.branchId, container_location_id: locationId, status: 'active' }, 4);
  if (existingMaps.length > 0) {
    return { mutations: [], mapId: String(existingMaps[0].id), created: false, issues };
  }
  const mapId = ctx.makeId('map', triggerOp?.opId ?? 'ensure', `container:${locationId}`);
  const turnId = ctx.turnId ?? ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;
  const row = createRow(
    'maps',
    {
      name: `${String(location.name ?? '地点')} · 内部`,
      kind: containerMapKind(String(location.kind ?? 'other')),
      container_location_id: locationId,
      description: '',
      frame_json: { origin_x: 0, origin_y: 0, reference_width_cells: 1, reference_height_cells: 1 },
      // 各图独立标定：不继承根图米/格。
      scale_quality: 'uncalibrated',
      default_terrain: String(location.terrain ?? 'unknown'),
      status: 'active',
    },
    { branchId: ctx.branchId, id: mapId, turnId, clockS: ctx.clockS, nowWallMs: Date.now(), rulesetVersion: 'atlas-1' },
  );
  const op: ParsedOperation = triggerOp ?? {
    opId: `ensure_map_${locationId}`,
    line: 0,
    rawHash: '',
    value: { op: 'location.upsert', why: '程序创建内部子图' },
  };
  return {
    mutations: [mutation('maps', mapId, null, row, op, basisOf(ctx, op))],
    mapId,
    created: true,
    issues,
  };
}

export const ATLAS_SCHEMA_VERSION_REF = ATLAS_SCHEMA_VERSION;
