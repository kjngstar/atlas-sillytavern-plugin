/**
 * atlas-sim-motion.ts — F02–F04：移动方式选择、行程建立与精确推进（§9.3 / §16.7 / §4.4 / §12）。
 *
 * 固定行为：
 * - `selectMobility` 只使用人物**实际具有**的 MobilityProfile（`enabled !== false`）；AI 说“飞行”不会
 *   自动给只会走路的人飞机速度（§16.7）。速度先应用**一次**路段地形修正；飞行/传送不套地面乘数。
 *   传送没有速度值，由条件、范围与准备/施法耗时控制，绝不除以零。
 * - `startJourney` 只在行动 `status='ready'` 且条件成立时建立行程：「我想去 C」只有计划，没有轨迹（§4.4）。
 *   路段计算参数（路线版本、几何版本、标定版本、速度、距离区间）在出发时**快照**进 `segments_json`，
 *   以后改比例尺不能改写历史路程（§4.4）。
 * - `advanceJourney` 精确扣每一段时间，按**时序**产出节点边界；本轮余额将穿过节点时停在节点上，
 *   剩余时间由 `remainingS` 返回。`stop_policy='review'` 先从余额里扣默认 120 秒节点观察（§16.7），
 *   并且在节点停下等调用方决定，绝不一边在 B 停留一边继续增加去 C 的距离（§12 数值核对例）。
 *   `Δt = 0` 不增加距离、不扣停留。estimated 路线保持 `position_quality:'route_estimated'`。
 * - 未标定且距离无依据时保留在途状态与 ETA 未知，不为了让 UI 有进度捏造精确坐标（§9.3）。
 *
 * 本层是纯程序计算：不调用模型、不使用 `Math.random`/`Date.now()`；时间由调用方传入。
 * 读取用 `queryBound` 参数绑定，写库只在 `settleWindow`/`haltActorWork` 等明确入口发生——
 * `startJourney`/`advanceJourney`/`estimatedArrival` 只**返回**该写入的行，不自行提交。
 */

import { queryBound } from './atlas-db-runtime.ts';
import { decodeRow } from './atlas-db-codec.ts';
import { ATLAS_FIELD_LIMITS } from './atlas-runtime-limits.ts';
import { resolveEffectivePosition } from './atlas-sim-position.ts';
import { evaluateCondition } from './atlas-sim-actions.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { Issue } from './atlas-ops-contract.ts';

export type MobilityMode = 'walk' | 'ride' | 'ground_vehicle' | 'water' | 'flight' | 'flight_narrative_aircraft' | 'teleport' | 'custom';

export type SpeedPreset = { min_mps: number; nominal_mps: number; max_mps: number };

/** §16.7 移动默认速度 `{min,nominal,max}` m/s。传送**没有**速度值。 */
export const MOVEMENT_SPEED_PRESETS: Readonly<Record<string, SpeedPreset | null>> = {
  walk: { min_mps: 0.8, nominal_mps: 1.4, max_mps: 1.8 },
  ride: { min_mps: 2, nominal_mps: 4, max_mps: 8 },
  ground_vehicle: { min_mps: 1.5, nominal_mps: 3, max_mps: 5 },
  water: { min_mps: 1, nominal_mps: 3, max_mps: 8 },
  flight: { min_mps: 5, nominal_mps: 12, max_mps: 30 },
  flight_narrative_aircraft: { min_mps: 60, nominal_mps: 150, max_mps: 250 },
  teleport: null,
  custom: null,
};

/** §16.7 同一速度先应用一种路段地形修正（只应用一次）。 */
export const TERRAIN_MULTIPLIERS = { road: 1, flat: 1, plain: 1, forest: 0.6, mountain: 0.45, mud: 0.5 } as const;

const TERRAIN_TABLE: Readonly<Record<string, number>> = TERRAIN_MULTIPLIERS;

/**
 * §16.7 节点经过默认不驻留，只有 stop_policy=review 才产生节点观察用时。
 * 说明：§16.2 要求默认值集中在 atlas-runtime-limits.ts；本任务不允许改动既有文件，
 * 因此该常量先定义在本模块并集中导出，待 atlas-runtime-limits.ts 扩展后迁移。
 */
export const NODE_REVIEW_DWELL_S = 120;

const WATER_TERRAINS = new Set(['water', 'river', 'sea', 'lake', 'ocean', 'swamp_water']);
const GROUND_MODES = new Set(['walk', 'ride', 'ground_vehicle', 'custom']);
const SPEED_BASES = new Set(['preset', 'narrative', 'worldbook', 'estimate']);
const JOURNEY_SEGMENT_LIMIT = ATLAS_FIELD_LIMITS.journeySegmentLimit;
const GEOMETRY_VERTEX_LIMIT = ATLAS_FIELD_LIMITS.geometryVertexLimit;

type Bound = { min: number; nominal: number; max: number };

export type JourneySegmentPlan = {
  routeId: string;
  routeRowRev: number;
  geometryRev: number;
  fromLocationId: string;
  toLocationId: string;
  mobilityKey: string;
  speedMinMps: number;
  speedNominalMps: number;
  speedMaxMps: number;
  distanceMinM: number;
  distanceNominalM: number;
  distanceMaxM: number;
  durationOverride: unknown | null;
  calibrationRev: number | null;
  quality: 'confirmed' | 'estimated' | 'unknown';
};

export type AdvanceEvent = { kind: 'node_reached' | 'review_dwell' | 'arrived' | 'blocked'; locationId?: string; atS: number; secondsUsed: number };

export type AdvanceResult = {
  journey: Record<string, unknown>;
  events: AdvanceEvent[];
  remainingS: number;
  issues: Issue[];
};

function issue(code: string, path: string, message: string, severity: 'warning' | 'error' = 'error'): Issue {
  return { code, path, message, severity, retryable: false };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (isPlainObject(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positive(value: unknown): number | null {
  const n = num(value);
  return n !== null && n > 0 ? n : null;
}

function normalizeTerrain(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text === '' ? 'unknown' : text;
}

function parseProfiles(raw: unknown): Array<Record<string, unknown>> {
  return asArray(raw).filter(isPlainObject);
}

function decodeOrNull(table: string, row: Record<string, unknown>): Record<string, unknown> | null {
  const decoded = decodeRow(table as never, row, { allowExtra: true });
  return decoded.ok ? (decoded.row as Record<string, unknown>) : null;
}

function loadRow(world: { db: SqlDatabase; branchId: string }, table: string, id: string): Record<string, unknown> | null {
  const rows = queryBound(world.db, `SELECT * FROM ${table} WHERE branch_id = ? AND id = ? LIMIT 1`, [world.branchId, id]);
  return rows.length > 0 ? decodeOrNull(table, rows[0]) : null;
}

/* —— F02 selectMobility —— */

export type MobilitySelection = {
  mode: string;
  minMps: number;
  nominalMps: number;
  maxMps: number;
  speedBasis: string;
  terrainMultiplier: number;
  issues: Issue[];
};

type Candidate = {
  mode: string;
  key: string;
  profile: Record<string, unknown>;
  issues: Issue[];
  preferred: boolean;
  nominal: number;
};

/**
 * F02：从**实际能力**里选模式，返回区间与地形修正。
 * - 没有任何可用 MobilityProfile → null（人物没有自动获得所有移动方式）。
 * - `evidence.mode` 指定了人物不具备的模式 → 记 MOBILITY_MODE_UNAVAILABLE，绝不返回该模式的飞机/预设速度。
 * - 不可行的候选（水域步行、地形禁止、路线不允许）带 error 级 issue 返回，由 startJourney 拒绝建行程。
 */
export function selectMobility(
  actor: { mobility_profiles_json?: unknown },
  route: { terrain?: string | null; allowed_modes_json?: unknown } | null,
  evidence?: { mode?: string; speed_basis?: string },
): MobilitySelection | null {
  const profiles = parseProfiles(actor?.mobility_profiles_json).filter((p) => p.enabled !== false);
  if (profiles.length === 0) return null;

  const terrain = normalizeTerrain(route?.terrain);
  const terrainMultiplier = TERRAIN_TABLE[terrain] ?? 1;
  const allowedModes = asArray(route?.allowed_modes_json).filter((m): m is string => typeof m === 'string');
  const evidenceMode = typeof evidence?.mode === 'string' && evidence.mode.trim() !== '' ? evidence.mode.trim() : null;

  const candidates: Candidate[] = profiles.map((profile) => {
    const mode = str(profile.mode) ?? 'custom';
    const key = str(profile.key) ?? mode;
    const issues: Issue[] = [];
    const preferred = evidenceMode !== null && (key === evidenceMode || mode === evidenceMode);

    if (evidenceMode !== null && !preferred && profiles.length === 1) {
      issues.push(
        issue(
          'MOBILITY_MODE_UNAVAILABLE',
          'mobility_profiles_json',
          `人物不具备移动方式 ${evidenceMode}；现有方式只有 ${key}（不自动授予其它模式的预设速度）`,
          'warning',
        ),
      );
    }
    if (allowedModes.length > 0 && !allowedModes.includes(mode)) {
      issues.push(issue('MOBILITY_MODE_NOT_ALLOWED_ON_ROUTE', 'routes.allowed_modes_json', `该路段不允许移动方式 ${mode}`, 'error'));
    }
    const constraints = asObject(profile.constraints) ?? {};
    const deny = asArray(constraints.terrain_deny).filter((t): t is string => typeof t === 'string');
    const allow = asArray(constraints.terrain_allow).filter((t): t is string => typeof t === 'string');
    if (deny.includes(terrain)) {
      issues.push(issue('MOBILITY_TERRAIN_DENIED', 'mobility_profile.constraints.terrain_deny', `该方式禁止地形 ${terrain}`, 'error'));
    }
    if (allow.length > 0 && !allow.includes(terrain)) {
      issues.push(issue('MOBILITY_TERRAIN_NOT_ALLOWED', 'mobility_profile.constraints.terrain_allow', `该方式只允许地形 ${allow.join('/')}`, 'error'));
    }
    if (WATER_TERRAINS.has(terrain) && GROUND_MODES.has(mode)) {
      issues.push(issue('WATER_CROSSING_INFEASIBLE', 'routes.terrain', `步行/地面方式不能越过水域（${terrain}）`, 'error'));
    }

    const preset = MOVEMENT_SPEED_PRESETS[mode] ?? null;
    const profileMin = positive(profile.speed_min_mps);
    const profileNominal = positive(profile.speed_nominal_mps);
    const profileMax = positive(profile.speed_max_mps);
    const nominal = profileNominal ?? preset?.nominal_mps ?? profileMin ?? profileMax ?? 0;
    if (mode !== 'teleport' && nominal === 0) {
      issues.push(issue('MOBILITY_SPEED_UNKNOWN', 'mobility_profiles_json', `移动方式 ${key} 没有速度依据，不能凭未知填一个默认速度`, 'error'));
    }
    return { mode, key, profile, issues, preferred, nominal };
  });

  const usable = candidates.filter((c) => (evidenceMode === null && c.mode !== 'custom') || c.preferred || candidates.length === 1);
  const pool = usable.length > 0 ? usable : candidates;
  pool.sort((a, b) => {
    const errorsA = a.issues.filter((i) => i.severity === 'error').length;
    const errorsB = b.issues.filter((i) => i.severity === 'error').length;
    if (errorsA !== errorsB) return errorsA - errorsB;
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
    if (a.nominal !== b.nominal) return b.nominal - a.nominal;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const chosen = pool[0];
  const issues = [...chosen.issues];

  const preset = MOVEMENT_SPEED_PRESETS[chosen.mode] ?? null;
  const declaredBasis = str(chosen.profile.speed_basis);
  const speedBasis = SPEED_BASES.has(String(evidence?.speed_basis))
    ? String(evidence?.speed_basis)
    : SPEED_BASES.has(String(declaredBasis))
      ? String(declaredBasis)
      : 'preset';

  if (chosen.mode === 'teleport') {
    issues.push(
      issue(
        'TELEPORT_NO_SPEED',
        'mobility_profiles_json',
        '传送没有速度值：由条件、范围限制与准备/施法耗时控制，调用方必须用 duration_override/准备时间，不得除以零',
        'warning',
      ),
    );
    return { mode: chosen.mode, minMps: 0, nominalMps: 0, maxMps: 0, speedBasis, terrainMultiplier: 1, issues };
  }

  const ignoreTerrain = chosen.mode === 'flight' || chosen.mode === 'flight_narrative_aircraft';
  const factor = ignoreTerrain ? 1 : terrainMultiplier;
  const rawMin = positive(chosen.profile.speed_min_mps) ?? preset?.min_mps ?? 0;
  const rawNominal = positive(chosen.profile.speed_nominal_mps) ?? preset?.nominal_mps ?? 0;
  const rawMax = positive(chosen.profile.speed_max_mps) ?? preset?.max_mps ?? 0;
  return {
    mode: chosen.mode,
    minMps: rawMin * factor,
    nominalMps: rawNominal * factor,
    maxMps: rawMax * factor,
    speedBasis,
    terrainMultiplier: factor,
    issues,
  };
}

/* —— 路线读取与几何距离 —— */

function routesFrom(world: { db: SqlDatabase; branchId: string }, locationId: string): Array<Record<string, unknown>> {
  const rows = queryBound(
    world.db,
    `SELECT * FROM routes WHERE branch_id = ? AND status = 'open' AND (from_location_id = ? OR (bidirectional = 1 AND to_location_id = ?))`,
    [world.branchId, locationId, locationId],
  );
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const decoded = decodeOrNull('routes', row);
    if (decoded) out.push(decoded);
  }
  return out;
}

function mapCalibration(world: { db: SqlDatabase; branchId: string }, mapId: string | null): { metersPerCell: number | null; min: number | null; max: number | null; rev: number | null; quality: string } {
  if (!mapId) return { metersPerCell: null, min: null, max: null, rev: null, quality: 'uncalibrated' };
  const map = loadRow(world, 'maps', mapId);
  if (!map) return { metersPerCell: null, min: null, max: null, rev: null, quality: 'uncalibrated' };
  return {
    metersPerCell: positive(map.meters_per_cell),
    min: positive(map.scale_min_meters_per_cell),
    max: positive(map.scale_max_meters_per_cell),
    rev: num(map.calibration_rev),
    quality: String(map.scale_quality ?? 'uncalibrated'),
  };
}

/** §9.3：已标定同一坐标系内 `距离 = 路线格长度 × 米/格`；layout 坐标不参与距离计算。 */
function geometryDistance(world: { db: SqlDatabase; branchId: string }, route: Record<string, unknown>): { minM: number; nominalM: number; maxM: number } | null {
  const geometry = asObject(route.geometry_json);
  if (!geometry || String(geometry.kind ?? '') !== 'line') return null;
  const coords = asArray(geometry.coordinates).slice(0, GEOMETRY_VERTEX_LIMIT);
  if (coords.length < 2) return null;
  let cells = 0;
  for (let i = 1; i < coords.length; i += 1) {
    const a = coords[i - 1];
    const b = coords[i];
    if (!Array.isArray(a) || !Array.isArray(b)) return null;
    const ax = num(a[0]);
    const ay = num(a[1]);
    const bx = num(b[0]);
    const by = num(b[1]);
    if (ax === null || ay === null || bx === null || by === null) return null;
    cells += Math.hypot(bx - ax, by - ay);
  }
  const calibration = mapCalibration(world, str(route.map_id));
  if (calibration.metersPerCell === null || calibration.quality === 'uncalibrated') return null;
  const perCell = calibration.metersPerCell;
  const lo = calibration.min ?? perCell;
  const hi = calibration.max ?? perCell;
  return { minM: cells * Math.min(lo, perCell), nominalM: cells * perCell, maxM: cells * Math.max(hi, perCell) };
}

function segmentDistance(
  world: { db: SqlDatabase; branchId: string },
  route: Record<string, unknown>,
): { minM: number; nominalM: number; maxM: number; quality: 'confirmed' | 'estimated' | 'unknown'; basis: string } {
  const nominal = num(route.distance_m);
  const basis = String(route.distance_basis ?? 'unknown');
  if (nominal !== null && nominal >= 0) {
    const min = num(route.distance_min_m) ?? nominal;
    const max = num(route.distance_max_m) ?? nominal;
    const single = min === nominal && nominal === max;
    const quality = single && (basis === 'measured' || basis === 'calibrated' || basis === 'narrative') ? 'confirmed' : 'estimated';
    return { minM: Math.min(min, nominal), nominalM: nominal, maxM: Math.max(max, nominal), quality, basis };
  }
  const fromGeometry = geometryDistance(world, route);
  if (fromGeometry) {
    const single = fromGeometry.minM === fromGeometry.nominalM && fromGeometry.nominalM === fromGeometry.maxM;
    return { ...fromGeometry, quality: single ? 'confirmed' : 'estimated', basis: 'geometry_calibrated' };
  }
  return { minM: 0, nominalM: 0, maxM: 0, quality: 'unknown', basis };
}

/** Completed narrative travel may reuse a known route and actual mobility; no write. */
export function computeTravelInterval(world: {db:SqlDatabase;branchId:string}, actor: Record<string,unknown>, route: Record<string,unknown>, mode?:string) {
  const selection=selectMobility(actor,route,{mode});
  if (!selection || selection.issues.some(i=>i.severity==='error') || route.status!=='open') return null;
  const distance=segmentDistance(world,route);
  const segment={distanceMinM:distance.minM,distanceNominalM:distance.nominalM,distanceMaxM:distance.maxM,
    speedMinMps:selection.minMps,speedNominalMps:selection.nominalMps,speedMaxMps:selection.maxMps,
    durationOverride:asObject(route.travel_time_override_json),quality:distance.quality};
  if(distance.quality==='unknown'&&!segment.durationOverride) return null;
  const bounds=segmentBounds(segment);
  return bounds?{min_s:bounds.min,nominal_s:bounds.nominal,max_s:bounds.max}:null;
}

function segmentQuality(geometryQuality: string, distanceQuality: 'confirmed' | 'estimated' | 'unknown'): 'confirmed' | 'estimated' | 'unknown' {
  if (geometryQuality === 'unknown' && distanceQuality === 'unknown') return 'unknown';
  if (geometryQuality === 'confirmed' && distanceQuality === 'confirmed') return 'confirmed';
  return 'estimated';
}

/* —— F03 startJourney —— */

export type JourneyWorld = {
  db: SqlDatabase;
  branchId: string;
  clockS: number;
  makeId: (kind: string, opId: string, alias: string) => string;
  turnId: string;
};

type PathLeg = { route: Record<string, unknown>; fromId: string; toId: string };

function routeUsable(world: { db: SqlDatabase; branchId: string }, route: Record<string, unknown>, actorId: string, clockS: number): boolean {
  const rules = route.access_rules_json;
  const condition = asObject(rules);
  if (!condition) return true;
  return evaluateCondition(world, condition, { clockS, actorId }).ok;
}

function bfsLeg(
  world: { db: SqlDatabase; branchId: string },
  startId: string,
  goalId: string,
  actorId: string,
  clockS: number,
  maxLegs: number,
): PathLeg[] | null {
  if (startId === goalId) return [];
  const queue: Array<{ id: string; path: PathLeg[] }> = [{ id: startId, path: [] }];
  const visited = new Set<string>([startId]);
  while (queue.length > 0) {
    const current = queue.shift() as { id: string; path: PathLeg[] };
    if (current.path.length >= maxLegs) continue;
    for (const route of routesFrom(world, current.id)) {
      if (!routeUsable(world, route, actorId, clockS)) continue;
      const fromId = String(route.from_location_id);
      const toId = String(route.to_location_id);
      const nextId = fromId === current.id ? toId : fromId;
      if (nextId === current.id) continue;
      const path = [...current.path, { route, fromId: current.id, toId: nextId }];
      if (nextId === goalId) return path;
      if (visited.has(nextId)) continue;
      visited.add(nextId);
      queue.push({ id: nextId, path });
    }
  }
  return null;
}

function mobilitySource(world: { db: SqlDatabase; branchId: string }, actorId: string): { mobility_profiles_json?: unknown } | null {
  const character = loadRow(world, 'characters', actorId);
  if (character) return { mobility_profiles_json: character.mobility_profiles_json };
  const location = loadRow(world, 'locations', actorId);
  if (location) {
    const vehicle = asObject(location.vehicle_profile_json);
    return { mobility_profiles_json: vehicle ? vehicle.mobility_profiles : [] };
  }
  return null;
}

function originLocationOf(world: { db: SqlDatabase; branchId: string }, actorId: string): string | null {
  const position = resolveEffectivePosition({ db: world.db, branchId: world.branchId }, actorId);
  if (position.kind === 'at_location') return position.locationId;
  const openJourney = queryBound(
    world.db,
    `SELECT stop_location_id, last_reached_location_id FROM journeys WHERE branch_id = ? AND mover_entity_id = ? AND status IN ('moving','paused','blocked') LIMIT 1`,
    [world.branchId, actorId],
  );
  if (openJourney.length > 0) {
    const row = openJourney[0];
    return str(row.stop_location_id) ?? str(row.last_reached_location_id);
  }
  const character = loadRow(world, 'characters', actorId);
  if (character) return str(character.location_id);
  const location = loadRow(world, 'locations', actorId);
  if (location) return str(location.anchor_location_id) ?? String(location.id);
  return null;
}

/**
 * F03：只有 `ready` 且条件成立才建立行程；锁本段计算参数。
 * 返回 DB 就绪的 journey 行（segments_json 为 TEXT），由调用方写入；本函数不提交事务。
 */
export function startJourney(
  action: Record<string, unknown>,
  world: JourneyWorld,
): { journey: Record<string, unknown> | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const actionId = str(action?.id);
  const status = String(action?.status ?? 'planned');
  if (status !== 'ready') {
    issues.push(
      issue('JOURNEY_NOT_READY', 'actions.status', `行动状态为 ${status}；只有 ready 且条件成立的行动才建立行程（「我想去 C」只是计划）`, 'warning'),
    );
    return { journey: null, issues };
  }
  const kind = String(action?.kind ?? '');
  if (kind !== 'travel') {
    issues.push(issue('JOURNEY_NOT_TRAVEL', 'actions.kind', `行动类型 ${kind} 不是 travel，不建立行程`, 'warning'));
    return { journey: null, issues };
  }
  const actorId = str(action?.actor_entity_id);
  if (!actorId || !actionId) {
    issues.push(issue('JOURNEY_NO_ACTOR', 'actions.actor_entity_id', 'travel 行动缺少 actor_entity_id 或 id'));
    return { journey: null, issues };
  }

  const payload = asObject(action?.payload_json) ?? {};
  const destination = str(action?.target_location_id) ?? str(payload.destination_ref);
  if (!destination) {
    issues.push(issue('JOURNEY_NO_DESTINATION', 'actions.target_location_id', 'travel 行动没有目的地，不能建立行程'));
    return { journey: null, issues };
  }

  const trigger = asObject(action?.trigger_json);
  if (trigger) {
    const evaluated = evaluateCondition(world, trigger, { clockS: world.clockS, actorId });
    if (!evaluated.ok) {
      issues.push(
        issue('JOURNEY_CONDITION_UNMET', 'actions.trigger_json', `行动条件未成立，不开始行程：${evaluated.reasons.join('; ') || '条件为假'}`, 'warning'),
      );
      return { journey: null, issues };
    }
  }

  const existing = queryBound(
    world.db,
    `SELECT id FROM journeys WHERE branch_id = ? AND mover_entity_id = ? AND status IN ('moving','paused','blocked') LIMIT 1`,
    [world.branchId, actorId],
  );
  if (existing.length > 0) {
    issues.push(issue('JOURNEY_ALREADY_OPEN', 'journeys.mover_entity_id', `同一 mover 已有未结束行程 ${String(existing[0].id)}`, 'warning'));
    return { journey: null, issues };
  }

  const origin = originLocationOf(world, actorId);
  if (!origin) {
    issues.push(issue('JOURNEY_ORIGIN_UNKNOWN', 'characters.location_id', '出发地未知；保持未知而不是伪造一个起点', 'warning'));
    return { journey: null, issues };
  }
  if (origin === destination) {
    issues.push(issue('JOURNEY_ALREADY_THERE', 'actions.target_location_id', '出发地与目的地相同，不建立行程', 'warning'));
    return { journey: null, issues };
  }

  const viaRefs = asArray(payload.via_refs).filter((v): v is string => typeof v === 'string');
  const waypoints = [origin, ...viaRefs.filter((v) => v !== origin && v !== destination), destination];
  const maxLegs = JOURNEY_SEGMENT_LIMIT;
  const legs: PathLeg[] = [];
  for (let i = 1; i < waypoints.length; i += 1) {
    const leg = bfsLeg(world, waypoints[i - 1] as string, waypoints[i] as string, actorId, world.clockS, maxLegs - legs.length);
    if (!leg) {
      issues.push(
        issue('JOURNEY_NO_ROUTE', 'routes', `找不到从 ${waypoints[i - 1]} 到 ${waypoints[i]} 的可通行路线（不伪造道路）`, 'warning'),
      );
      return { journey: null, issues };
    }
    legs.push(...leg);
  }
  if (legs.length === 0) {
    issues.push(issue('JOURNEY_NO_ROUTE', 'routes', '没有可用路段'));
    return { journey: null, issues };
  }
  if (legs.length > JOURNEY_SEGMENT_LIMIT) {
    issues.push(issue('JOURNEY_TOO_MANY_SEGMENTS', 'journeys.segments_json', `路段数超过上限 ${JOURNEY_SEGMENT_LIMIT}`, 'warning'));
    return { journey: null, issues };
  }

  const source = mobilitySource(world, actorId);
  if (!source) {
    issues.push(issue('JOURNEY_ACTOR_UNKNOWN', 'entity_keys', `找不到 mover ${actorId} 的能力配置`));
    return { journey: null, issues };
  }

  const segments: JourneySegmentPlan[] = [];
  const requestedMode = str(payload.mobility_key);
  for (const leg of legs) {
    const route = leg.route;
    const selection = selectMobility(source, { terrain: String(route.terrain ?? 'unknown'), allowed_modes_json: route.allowed_modes_json }, {
      mode: requestedMode ?? undefined,
    });
    if (!selection) {
      issues.push(issue('JOURNEY_MOBILITY_MISSING', 'mobility_profiles_json', `${actorId} 没有任何可用移动方式，不能开始行程`, 'warning'));
      return { journey: null, issues };
    }
    const errors = selection.issues.filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      issues.push(...errors);
      return { journey: null, issues };
    }
    issues.push(...selection.issues);
    const distance = segmentDistance(world, route);
    const calibration = mapCalibration(world, str(route.map_id));
    if (distance.quality === 'unknown' && !asObject(route.travel_time_override_json)) {
      issues.push(
        issue('JOURNEY_ETA_UNKNOWN', 'routes.distance_m', `路段 ${String(route.id)} 无距离依据且无通行耗时覆盖：保留在途状态，ETA 未知`, 'warning'),
      );
    }
    segments.push({
      routeId: String(route.id),
      routeRowRev: num(route.row_rev) ?? 1,
      geometryRev: num(route.geometry_rev) ?? 1,
      fromLocationId: leg.fromId,
      toLocationId: leg.toId,
      mobilityKey: requestedMode ?? selection.mode,
      speedMinMps: selection.minMps,
      speedNominalMps: selection.nominalMps,
      speedMaxMps: selection.maxMps,
      distanceMinM: distance.minM,
      distanceNominalM: distance.nominalM,
      distanceMaxM: distance.maxM,
      durationOverride: asObject(route.travel_time_override_json),
      calibrationRev: calibration.rev,
      quality: segmentQuality(String(route.geometry_quality ?? 'unknown'), distance.quality),
    });
  }

  const journey: Record<string, unknown> = {
    branch_id: world.branchId,
    id: world.makeId('journey', actionId, 'journey'),
    row_rev: 1,
    created_turn_id: world.turnId,
    updated_turn_id: world.turnId,
    action_id: actionId,
    mover_entity_id: actorId,
    origin_location_id: origin,
    destination_location_id: destination,
    segments_json: JSON.stringify(segments),
    segment_index: 0,
    segment_distance_done_m: 0,
    segment_time_done_s: 0,
    last_reached_location_id: origin,
    stop_location_id: null,
    started_at_s: world.clockS,
    last_advanced_at_s: world.clockS,
    estimated_arrival_min_s: null,
    estimated_arrival_max_s: null,
    arrived_at_s: null,
    position_quality: positionQualityOf(segments, 0),
    status: 'moving',
    stop_reason: null,
  };
  const eta = estimatedArrival(journey, world.clockS);
  journey.estimated_arrival_min_s = eta.minS;
  journey.estimated_arrival_max_s = eta.maxS;
  return { journey, issues };
}

function positionQualityOf(segments: JourneySegmentPlan[], index: number): 'route_confirmed' | 'route_estimated' | 'unlocated' {
  const current = segments[Math.min(index, Math.max(0, segments.length - 1))];
  if (!current) return 'unlocated';
  if (current.quality === 'confirmed') return 'route_confirmed';
  if (current.quality === 'estimated') return 'route_estimated';
  return 'unlocated';
}

/* —— F04 advanceJourney —— */

/**
 * JourneySegmentPlan 的字段名以 §17F 固定的 camelCase（`distance_nominal_m` 等 snake_case
 * 只作兼容读取），避免把两端写成两套互相看不见的名字。
 */
function segField(segment: Record<string, unknown>, camel: string, snake: string): unknown {
  return segment[camel] !== undefined ? segment[camel] : segment[snake];
}

function segmentBounds(segment: Record<string, unknown>): Bound | null {
  const override = asObject(segField(segment, 'durationOverride', 'duration_override'));
  if (override) {
    const minS = num(override.min_s);
    const nominalS = num(override.nominal_s);
    const maxS = num(override.max_s);
    if (minS !== null || nominalS !== null || maxS !== null) {
      const min = minS ?? nominalS ?? maxS ?? 0;
      const max = maxS ?? nominalS ?? minS ?? 0;
      const nominal = nominalS ?? (min + max) / 2;
      if (max > 0) return { min: Math.max(0, Math.min(min, nominal)), nominal: Math.max(0, nominal), max: Math.max(nominal, max) };
    }
  }
  const quality = String(segField(segment, 'quality', 'quality') ?? 'unknown');
  const distanceNominal = num(segField(segment, 'distanceNominalM', 'distance_nominal_m')) ?? 0;
  const distanceMin = num(segField(segment, 'distanceMinM', 'distance_min_m')) ?? distanceNominal;
  const distanceMax = num(segField(segment, 'distanceMaxM', 'distance_max_m')) ?? distanceNominal;
  const speedNominal = positive(segField(segment, 'speedNominalMps', 'speed_nominal_mps'));
  if (quality === 'unknown' || speedNominal === null) return null;
  const speedMin = positive(segField(segment, 'speedMinMps', 'speed_min_mps')) ?? speedNominal;
  const speedMax = positive(segField(segment, 'speedMaxMps', 'speed_max_mps')) ?? speedNominal;
  return {
    min: distanceMin / speedMax,
    nominal: distanceNominal / speedNominal,
    max: distanceMax / speedMin,
  };
}

function stopPolicyOf(world: { db: SqlDatabase; branchId: string }, journey: Record<string, unknown>): 'continue' | 'review' | 'stop' {
  const actionId = str(journey.action_id);
  if (!actionId) return 'review';
  const action = loadRow(world, 'actions', actionId);
  const payload = action ? asObject(action.payload_json) : null;
  const policy = payload ? String(payload.stop_policy ?? '') : '';
  return policy === 'continue' || policy === 'review' || policy === 'stop' ? policy : 'review';
}

function routeIsOpen(world: { db: SqlDatabase; branchId: string }, routeId: string | null): boolean {
  if (!routeId) return true;
  const row = loadRow(world, 'routes', routeId);
  if (!row) return true;
  return String(row.status ?? 'open') === 'open';
}

/**
 * F04：按世界时刻精确推进，产出时序节点边界。
 * 返回更新后的 journey 行（由调用方持久化）；`remainingS` 是留给其它事务的余额。
 */
export function advanceJourney(journey: Record<string, unknown>, untilS: number, world: { db: SqlDatabase; branchId: string }): AdvanceResult {
  const issues: Issue[] = [];
  const events: AdvanceEvent[] = [];
  const row: Record<string, unknown> = { ...journey };
  const rawSegments = journey.segments_json;
  const segmentsRaw = asArray(rawSegments).filter(isPlainObject);
  if (typeof rawSegments === 'string' && rawSegments.trim() !== '' && segmentsRaw.length === 0) {
    issues.push(issue('JOURNEY_SEGMENTS_INVALID', 'journeys.segments_json', 'segments_json 损坏，保持原状不推进'));
    return { journey: row, events, remainingS: Math.max(0, untilS - (num(journey.last_advanced_at_s) ?? 0)), issues };
  }
  const segments = segmentsRaw as Array<Record<string, unknown>>;
  const status = String(journey.status ?? 'moving');
  const lastAdvanced = num(journey.last_advanced_at_s) ?? num(journey.started_at_s) ?? 0;

  if (status !== 'moving') {
    // 暂停/到达/受阻/取消的行程不前进（§12 第 5 步：停在 B 就不能继续累加去 C 的距离）。
    return { journey: row, events, remainingS: Math.max(0, untilS - lastAdvanced), issues };
  }
  if (!Number.isFinite(untilS) || untilS <= lastAdvanced) {
    // Δt = 0：不增加距离，也不产生停留。
    return { journey: row, events, remainingS: 0, issues };
  }

  const policy = stopPolicyOf(world, journey);
  let cursor = lastAdvanced;
  let index = Math.max(0, Math.trunc(num(journey.segment_index) ?? 0));
  let timeDone = num(journey.segment_time_done_s) ?? 0;
  let distanceDone = num(journey.segment_distance_done_m);
  let lastReached = str(journey.last_reached_location_id) ?? str(journey.origin_location_id);
  let nextStatus: 'moving' | 'paused' | 'arrived' | 'blocked' = 'moving';
  let stopLocation: string | null = null;
  let stopReason: string | null = null;
  let arrivedAt: number | null = null;

  while (index < segments.length && cursor < untilS) {
    const segment = segments[index] as Record<string, unknown>;
    const routeId = str(segField(segment, 'routeId', 'route_id'));
    if (!routeIsOpen(world, routeId)) {
      nextStatus = 'blocked';
      stopReason = 'route_blocked';
      events.push({ kind: 'blocked', locationId: lastReached ?? undefined, atS: cursor, secondsUsed: 0 });
      break;
    }
    const bounds = segmentBounds(segment);
    if (!bounds || bounds.nominal <= 0) {
      // 无距离/标定/耗时依据：保留在途与时间，不伪造距离与节点（§9.3）。
      issues.push(
        issue('JOURNEY_PROGRESS_UNKNOWN', 'journeys.segments_json', `路段 ${routeId ?? index} 没有可用距离/速度依据：只累计时间，不伪造精确进度与到达`, 'warning'),
      );
      timeDone += untilS - cursor;
      cursor = untilS;
      break;
    }
    const leftInSegment = Math.max(0, bounds.nominal - timeDone);
    const arriveAt = cursor + leftInSegment;
    if (arriveAt > untilS) {
      const used = untilS - cursor;
      const speedNominal = positive(segField(segment, 'speedNominalMps', 'speed_nominal_mps')) ?? 0;
      const distanceNominal = num(segField(segment, 'distanceNominalM', 'distance_nominal_m'));
      if (distanceDone !== null || distanceNominal !== null) {
        const advance = speedNominal * used;
        distanceDone = Math.min(distanceNominal ?? 0, (distanceDone ?? 0) + advance);
      }
      timeDone += used;
      cursor = untilS;
      break;
    }

    // 到达节点：先结算本段真实消耗，再处理节点（禁止越过节点事件）。
    const secondsUsed = leftInSegment;
    cursor = arriveAt;
    timeDone = 0;
    distanceDone = null;
    const toId = str(segField(segment, 'toLocationId', 'to_location_id')) ?? lastReached ?? 'unknown';
    lastReached = toId;
    index += 1;
    const isDestination = index >= segments.length;
    if (isDestination) {
      nextStatus = 'arrived';
      arrivedAt = cursor;
      stopLocation = toId;
      events.push({ kind: 'arrived', locationId: toId, atS: cursor, secondsUsed });
    } else {
      events.push({ kind: 'node_reached', locationId: toId, atS: cursor, secondsUsed });
    }

    if (policy === 'review') {
      const budget = Math.max(0, untilS - cursor);
      const dwell = Math.min(NODE_REVIEW_DWELL_S, budget);
      events.push({ kind: 'review_dwell', locationId: toId, atS: cursor, secondsUsed: dwell });
      cursor += dwell;
      if (dwell < NODE_REVIEW_DWELL_S) {
        issues.push(
          issue('DWELL_TRUNCATED', 'journeys.last_advanced_at_s', `本轮余额不足以完成 ${NODE_REVIEW_DWELL_S} 秒节点观察，只扣了 ${dwell} 秒`, 'warning'),
        );
      }
      if (!isDestination) {
        nextStatus = 'paused';
        stopLocation = toId;
        stopReason = 'review';
        break;
      }
    } else if (policy === 'stop' && !isDestination) {
      nextStatus = 'paused';
      stopLocation = toId;
      stopReason = 'stop_policy';
      break;
    }
  }

  row.segment_index = index;
  row.segment_time_done_s = timeDone;
  row.segment_distance_done_m = distanceDone;
  row.last_reached_location_id = lastReached;
  row.last_advanced_at_s = cursor;
  row.status = nextStatus;
  row.stop_location_id = nextStatus === 'moving' ? null : stopLocation;
  row.stop_reason = nextStatus === 'moving' ? null : stopReason;
  if (arrivedAt !== null) row.arrived_at_s = arrivedAt;
  row.position_quality = positionQualityOf(segments as unknown as JourneySegmentPlan[], index);
  const eta = estimatedArrival(row, cursor);
  row.estimated_arrival_min_s = eta.minS;
  row.estimated_arrival_max_s = eta.maxS;

  return { journey: row, events, remainingS: Math.max(0, untilS - cursor), issues };
}

/**
 * F04/F06/F11 共用：下一个节点边界（到达下一节点/终点的世界时刻）。
 * 未知距离/标定时返回 null —— 保留在途状态、ETA 未知，不捏造到达时刻。
 */
export function nextNodeBoundary(
  journey: Record<string, unknown>,
): { atS: number; toLocationId: string; routeId: string | null } | null {
  if (String(journey.status ?? '') !== 'moving') return null;
  const segments = asArray(journey.segments_json).filter(isPlainObject) as Array<Record<string, unknown>>;
  const index = Math.max(0, Math.trunc(num(journey.segment_index) ?? 0));
  if (index >= segments.length) return null;
  const segment = segments[index] as Record<string, unknown>;
  const bounds = segmentBounds(segment);
  if (!bounds) return null;
  const timeDone = num(journey.segment_time_done_s) ?? 0;
  const atS = (num(journey.last_advanced_at_s) ?? num(journey.started_at_s) ?? 0) + Math.max(0, bounds.nominal - timeDone);
  return { atS, toLocationId: str(segField(segment, 'toLocationId', 'to_location_id')) ?? '', routeId: str(segField(segment, 'routeId', 'route_id')) };
}

export function estimatedArrival(journey: Record<string, unknown>, clockS: number): { minS: number | null; maxS: number | null; quality: string } {
  const segments = asArray(journey.segments_json).filter(isPlainObject) as Array<Record<string, unknown>>;
  const status = String(journey.status ?? 'moving');
  if (status === 'arrived') {
    const arrived = num(journey.arrived_at_s);
    return { minS: arrived, maxS: arrived, quality: 'confirmed' };
  }
  if (status === 'cancelled' || status === 'blocked') return { minS: null, maxS: null, quality: 'unknown' };
  const lastAdvanced = num(journey.last_advanced_at_s) ?? num(journey.started_at_s) ?? clockS;
  const startAt = Math.max(clockS, lastAdvanced);
  const index = Math.max(0, Math.trunc(num(journey.segment_index) ?? 0));
  const timeDone = num(journey.segment_time_done_s) ?? 0;
  if (index >= segments.length) return { minS: null, maxS: null, quality: 'unknown' };

  let min = 0;
  let max = 0;
  let quality = 'confirmed';
  for (let i = index; i < segments.length; i += 1) {
    const segment = segments[i] as Record<string, unknown>;
    const bounds = segmentBounds(segment);
    if (!bounds) return { minS: null, maxS: null, quality: 'unknown' };
    const already = i === index ? Math.min(timeDone, bounds.min) : 0;
    min += Math.max(0, bounds.min - already);
    max += Math.max(0, bounds.max - already);
    const segmentQuality = String(segField(segment, 'quality', 'quality') ?? 'unknown');
    if (segmentQuality !== 'confirmed') quality = segmentQuality === 'unknown' ? 'unknown' : 'estimated';
    if (bounds.min !== bounds.max && quality === 'confirmed') quality = 'estimated';
  }
  if (quality === 'unknown') return { minS: null, maxS: null, quality: 'unknown' };
  return { minS: startAt + min, maxS: startAt + max, quality };
}
