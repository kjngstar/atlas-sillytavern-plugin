/**
 * atlas-scene-facts.ts — P11 §17.2：actor 空间事实的**唯一**读取口。
 *
 * 为什么要有这一层：P10 把空间投影写进了正文注入（`renderSqlSceneContext`），
 * P11 又要求「每个 actor 的决策切片也带自己的 scene facts」。如果两处各写一遍
 * 「怎么读地点链、怎么读陈设、门是开是关怎么判」，就正好违反 §17.2
 * 「共享同一基础属性构建器，不再各自猜门是开是关」。
 *
 * 因此本模块只做一件事：**从 SQL 读出当前地点的真实空间，交给 P07/P10 的同一个
 * 属性判定器组装**；正文行（`lines`）与结构化切片（`context`）都从这一次读取来。
 *
 * 纪律：
 * - 只读当前地点，不拉整世界几何；不列别的人物的位置（那是别人的知识）。
 * - 空间账本自己的 issue **必须带出来**：静默跳过非法陈设，正文就会「少一件家具」而没人知道。
 * - 布局没保存只说「未就绪」，不编造家具与尺寸。
 * - 不写库、不调模型、不用 `Date.now()`。
 */

import { queryBound } from './atlas-db-runtime.ts';
import { readSpaceCanonical } from './atlas-space-canonical.ts';
import { readSpaceStateFacts } from './atlas-space-state.ts';
import type { SpaceObjectStateSeed } from './atlas-space-state.ts';
import { buildActorSceneContext, renderActorSceneContextLines } from './atlas-scene-entry.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { PlanIssue } from './atlas-world-contract.ts';
import type { ActorSceneContextV1 } from './atlas-scene-entry.ts';
import { collectSpatialFacts, projectSpatialFactsForActor, type SpatialGeometryV1 } from './atlas-spatial-facts.ts';
import { buildPerceptionCandidates } from './atlas-spatial-perception.ts';
import { constraintsForNextTurn } from './atlas-scene-contradictions.ts';
import { readSceneContradictions } from './atlas-scene-contradiction-read.ts';

export type SceneFactsWorld = { db: SqlDatabase; branchId: string };

export type SceneFactsPosition = { kind: string; precision?: string | null; mapId?: string; x?: number; y?: number } | null;

export type SceneFactsInput = {
  actorId: string;
  locationId: string | null;
  position: SceneFactsPosition;
  /**
   * 障碍上限：正文与决策切片共用同一个上限。
   * 按**真实占地降序**截断 —— 留下来的必须带占地，不能只留名字。
   */
  maxObstacles?: number;
  /** 上下文字符预算（沿用 P10 的 1800）。 */
  charLimit?: number;
};

export type SceneFactsResult = {
  /** 地点行是否真的存在；不存在时 context 为 null，调用方不能拿目录名字填空。 */
  found: boolean;
  context: ActorSceneContextV1 | null;
  lines: string[];
  diagnostics: PlanIssue[];
};

/** 地点链最多回溯层数：父子环是数据问题，不该让注入或决策卡死。 */
const MAX_ANCESTOR_DEPTH = 8;
/** 关键障碍默认上限：给当前房间的「挡路的那几件」，不是整张家具清单。 */
const DEFAULT_MAX_OBSTACLES = 6;

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only saved, unambiguous local IDs bind geometry; names and array positions never do. */
function sceneGeometry(frame: Record<string, unknown> | null, mapId: string | null, locationId: string, localId: string): { geometry: SpatialGeometryV1 | null; hidden: boolean } {
  const scene = frame?.['atlasScene'];
  if (!mapId || !object(scene) || scene['version'] !== 1 || scene['mapId'] !== mapId || !object(scene['layout'])) return { geometry: null, hidden: false };
  const layout = scene['layout'];
  const rows: Record<string, unknown>[] = [];
  for (const key of ['furniture', 'groups', 'doors', 'windows', 'walls']) {
    const list = layout[key];
    if (Array.isArray(list)) for (const entry of list) if (object(entry)) rows.push(entry);
  }
  const suffix = localId.slice(localId.lastIndexOf(':furn:') + 6);
  const matches = rows.filter(row => (row['id'] === localId || row['id'] === suffix && row['roomId'] === locationId));
  const row = matches.find(entry => entry['id'] === localId) ?? (matches.length === 1 ? matches[0] : null);
  if (!row) return { geometry: null, hidden: false };
  const hidden = row['hidden'] === true || row['secret'] === true;
  const x = num(row['x']), y = num(row['y']);
  const units = scene['units'];
  if (x === null || y === null || units !== 'meters' && units !== 'cells') return { geometry: null, hidden };
  return { geometry: { mapId, units, x, y, width: num(row['w']), height: num(row['h']), rotation: num(row['rotation']) ?? num(row['angle']) }, hidden };
}

/** 内部布局是否已保存：没保存就只说「未就绪」，不编造家具与尺寸。 */
function interiorReadiness(layoutSaved: boolean): { ready: boolean; note: string | null; interiorMapId: string | null } {
  return layoutSaved
    ? { ready: true, note: null, interiorMapId: null }
    : { ready: false, note: '内部布局未就绪：只给真实位置与结构状态，不编造家具或尺寸', interiorMapId: null };
}

/* ------------------------------------------------------------------ *
 * §18.4 门窗/陈设的当前状态（来自世界事实层，不是另开一份）
 * ------------------------------------------------------------------ */

/**
 * 读本空间陈设的当前状态（开关 / 物理锁 / 材质 / 在场）。
 *
 * **委托** `atlas-space-state.readSpaceStateFacts`：状态事实的覆盖次序只能有一个实现，
 * 否则正文、决策切片、通行判定会各自算出不同的门状态（§18.4）。
 */
export function readFurnishingStates(
  world: SceneFactsWorld,
  locationId: string,
): { states: Map<string, SpaceObjectStateSeed>; diagnostics: PlanIssue[] } {
  const id = str(locationId);
  if (id === '') return { states: new Map<string, SpaceObjectStateSeed>(), diagnostics: [] };
  return readSpaceStateFacts(world, `space:${id}:furn:`);
}


/**
 * 读一个 actor 在当前地点的空间事实。
 *
 * 返回 `found: false` 表示地点行不存在 —— 调用方必须按「没有空间信息」处理，
 * 绝不允许退回「猜它是某个房间」。
 */
export function readActorSceneFacts(world: SceneFactsWorld, input: SceneFactsInput): SceneFactsResult {
  const diagnostics: PlanIssue[] = [];
  const locationId = str(input?.locationId);
  if (locationId === '') return { found: false, context: null, lines: [], diagnostics };

  const location = queryBound(
    world.db,
    'SELECT id,name,kind,parent_location_id,map_id,coord_precision FROM locations WHERE branch_id=? AND id=?',
    [world.branchId, locationId],
  )[0];
  if (!location) return { found: false, context: null, lines: [], diagnostics };

  const chain: Array<{ locationId: string; name: string; kind: string }> = [];
  const seen = new Set<string>();
  let cursor = locationId;
  for (let depth = 0; cursor && depth < MAX_ANCESTOR_DEPTH && !seen.has(cursor); depth += 1) {
    seen.add(cursor);
    const row = queryBound(world.db, 'SELECT id,name,kind,parent_location_id FROM locations WHERE branch_id=? AND id=?', [world.branchId, cursor])[0];
    if (!row) break;
    chain.unshift({ locationId: str(row.id), name: str(row.name), kind: str(row.kind) || 'other' });
    cursor = str(row.parent_location_id);
  }

  const mapId = str(location.map_id) || null;
  const mapRow = mapId
    ? queryBound(world.db, 'SELECT frame_json, meters_per_cell FROM maps WHERE branch_id=? AND id=?', [world.branchId, mapId])[0]
    : null;
  const frame = mapRow ? parseObject(mapRow.frame_json) : null;
  const metersPerCell = mapRow ? num(mapRow.meters_per_cell) : null;

  const entrances: Array<{ objectId: string; name: string; kind: string; openingState: string; locked: boolean | null; geometry: SpatialGeometryV1 | null }> = [];
  const obstacles: Array<{ objectId: string; name: string; kind: string; material?: string; openingState?: string; locked?: boolean | null; footprintMeters: { widthM: number; heightM: number }; geometry: SpatialGeometryV1 | null }> = [];
  const hiddenIds: string[] = [];
  const stateConstraints: Array<{code:string;message:string}>=[];
  // §18.4：门的开关/上锁状态来自世界事实层；没有事实时如实是 unknown（不假设开着也不假设锁着）。
  const stateRead = readFurnishingStates(world, locationId);
  diagnostics.push(...stateRead.diagnostics);
  const settledStates = stateRead.states;
  const canonicalRead = frame ? readSpaceCanonical(frame, locationId) : null;
  // 空间账本自己的问题必须带出来：静默丢一件陈设，等于正文少一件家具却无人知晓。
  for (const readIssue of canonicalRead?.issues ?? []) diagnostics.push(readIssue);
  if (canonicalRead?.canonical) {
    for (const piece of canonicalRead.canonical.furnishing) {
      const type = str(piece.type).toLowerCase();
      const localId = str(piece.localId);
      // 已经提升成真实物品（itemId 非空）：它现在由 items 行定位，不再在源空间重复占地。
      if (str(piece.itemId) !== '') continue;
      const state = settledStates.get(localId) ?? null;
      if (state?.present === false) continue;
      if(state?.destroyed===true){stateConstraints.push({code:'DESTROYED_EXIT_USED',message:`${localId} 已损毁；保存几何仅作历史依据，不能把它当成有效入口或完好陈设。`});continue;}
      const savedGeometry = sceneGeometry(frame, mapId, locationId, localId);
      if (savedGeometry.hidden) hiddenIds.push(localId);
      if (type === 'door' || type === 'window') {
        // localId 已经是全空间唯一的 `space:<locationId>:furn:<id>`，不再拼前缀。
        entrances.push({
          objectId: localId,
          name: str(piece.name) || type,
          kind: type,
          openingState: str(state?.openingState) || 'unknown',
          locked: state?.locked ?? null,
          geometry: savedGeometry.geometry,
        });
        continue;
      }
      obstacles.push({
        objectId: localId,
        name: str(piece.name) || type || '陈设',
        kind: type === 'wall' ? 'wall' : type === 'glass' || type === 'partition' ? 'glass' : 'furniture',
        material: str(state?.material) || undefined,
        openingState: str(state?.openingState) || undefined,
        locked: state?.locked ?? null,
        footprintMeters: { widthM: Number(piece.widthM), heightM: Number(piece.heightM) },
        geometry: savedGeometry.geometry,
      });
    }
  } else if (frame === null && mapId) {
    diagnostics.push({
      code: 'SCENE_FRAME_UNREADABLE',
      path: '$.maps.frame_json',
      message: '地图帧不可读：本轮只给地点与位置，不给空间细节。',
      severity: 'warning',
      retryable: false,
    });
  }

  const limit = Math.max(1, Math.floor(Number.isFinite(Number(input?.maxObstacles)) ? Number(input.maxObstacles) : DEFAULT_MAX_OBSTACLES));
  // 只留占地面积最大的几件：留下来的必须带真实占地。
  obstacles.sort((left, right) => (right.footprintMeters.widthM * right.footprintMeters.heightM) - (left.footprintMeters.widthM * left.footprintMeters.heightM));

  const layoutSaved = frame !== null && Object.prototype.hasOwnProperty.call(frame, 'atlasScene');
  const facts = collectSpatialFacts({ mapId, metersPerCell, objects: [...entrances, ...obstacles] });
  const projection = projectSpatialFactsForActor({ facts, actorId: input.actorId, hiddenObjectIds: hiddenIds });
  const visible = new Set(projection.observed.map(entry => entry.objectId));
  const perception = buildPerceptionCandidates({ projection, subjects: projection.observed.map(entry => ({ subjectId: entry.objectId, atObjectId: entry.objectId })) });
  diagnostics.push(...projection.issues, ...perception.issues);
  const context = buildActorSceneContext({
    actorId: str(input.actorId),
    location: {
      locationId,
      name: str(location.name),
      kind: str(location.kind) || 'other',
      mapId,
      units: metersPerCell !== null ? 'meters' : 'cells',
      metersPerCell,
      precision: str(location.coord_precision) || 'unknown',
    },
    ancestors: chain,
    position: input.position,
    entrances: entrances.filter(entry => visible.has(entry.objectId)),
    obstacles: obstacles.filter(entry => visible.has(entry.objectId)).slice(0, limit),
    interior: interiorReadiness(layoutSaved),
    constraints: [...stateConstraints,...constraintsForNextTurn(readSceneContradictions(world.db, world.branchId).filter(entry => entry.actorId === input.actorId), projection.observed,
      { currentTurnId: str(queryBound(world.db, 'SELECT head_turn_id FROM branches WHERE id=?', [world.branchId])[0]?.['head_turn_id']) })],
    ...(Number.isFinite(Number(input?.charLimit)) ? { charLimit: Number(input.charLimit) } : {}),
  });
  diagnostics.push(...context.diagnostics);
  context.perceptionCandidates = perception.candidates;

  const lines = renderActorSceneContextLines(context);
  if (context.truncated) lines.push(`空间上下文：超出预算，已省略 ${context.capacity.dropped} 个可选条目（障碍未截断）。`);
  return { found: true, context, lines, diagnostics };
}

/* ------------------------------------------------------------------ *
 * 决策切片用的紧凑投影
 * ------------------------------------------------------------------ */

export type DecisionSceneEntranceV1 = {
  geometry?: SpatialGeometryV1 | null;
  objectId: string;
  name: string;
  kind: string;
  openingState: string;
  /** 物理门锁：未知就是 null；「没写」不等于「没锁」。 */
  locked: boolean | null;
  blocksMovement: boolean | null;
};

export type DecisionSceneBlockerV1 = {
  geometry?: SpatialGeometryV1 | null;
  footprintMeters?: { widthM: number; heightM: number } | null;
  objectId: string;
  name: string;
  kind: string;
  blocksMovement: boolean | null;
  blocksSight: boolean | null;
  footprintCells: number | null;
};

export type DecisionSceneV1 = {
  perceptionCandidates?: readonly import('./atlas-spatial-perception.ts').PerceptionCandidate[];
  version: 1;
  location: {
    locationId: string;
    name: string;
    chain: Array<{ locationId: string; name: string; kind: string }>;
    mapId: string | null;
    units: 'meters' | 'cells' | 'unknown';
    metersPerCell: number | null;
    precision: string;
  } | null;
  self: ActorSceneContextV1['self'];
  entrances: DecisionSceneEntranceV1[];
  blockers: DecisionSceneBlockerV1[];
  /** 仍未解除的空间约束（原始码，措辞由提示词层决定）。 */
  constraints: Array<{ code: string; message: string }>;
  truncated: boolean;
  /** 只给码，不给整串上下文：一是预算，二是诊断文本属于后台口径。 */
  diagnosticCodes: string[];
};

/**
 * 把 P10 的完整投影压成决策切片用得起的形状。
 *
 * 为什么不是直接塞 `ActorSceneContextV1`：那里面还有 capacity/diagnostics 明细，
 * 一个 NPC 一条就够，但十个 NPC 一批就是十倍噪音。压缩只删元数据，
 * **入口 / 障碍 / 约束的语义一律不改**。
 */
export function summarizeSceneFacts(context: ActorSceneContextV1 | null): DecisionSceneV1 | null {
  if (!context) return null;
  return {
    version: 1,
    location: context.location
      ? {
        locationId: context.location.locationId,
        name: context.location.name,
        chain: context.location.chain.map((node) => ({ locationId: node.locationId, name: node.name, kind: node.kind })),
        mapId: context.location.mapId,
        units: context.location.units,
        metersPerCell: context.location.metersPerCell,
        precision: context.location.precision,
      }
      : null,
    self: context.self ? { ...context.self } : null,
    ...(context.perceptionCandidates ? { perceptionCandidates: context.perceptionCandidates.map(candidate=>({...candidate})) } : {}),
    entrances: context.entrances.map((entrance) => ({
      objectId: entrance.objectId,
      name: entrance.name,
      kind: entrance.kind,
      openingState: entrance.openingState,
      locked: entrance.locked,
      blocksMovement: entrance.blocksMovement,
      ...(entrance.geometry ? { geometry: entrance.geometry } : {}),
    })),
    blockers: context.blockers.map((blocker) => ({
      objectId: blocker.objectId,
      name: blocker.name,
      kind: blocker.kind,
      blocksMovement: blocker.blocksMovement,
      blocksSight: blocker.blocksSight,
      footprintCells: blocker.footprintCells,
      footprintMeters: blocker.footprintMeters,
      ...(blocker.geometry ? { geometry: blocker.geometry } : {}),
    })),
    constraints: context.constraints.map((constraint) => ({ code: constraint.code, message: constraint.message })),
    truncated: context.truncated,
    diagnosticCodes: [...new Set(context.diagnostics.map((entry) => entry.code))].sort(),
  };
}

/**
 * §17.2：NPC 不能因为后台建了整张图就知道所有秘密位置。
 *
 * 决策切片里的地点必须来自**自己**已知/当前所在的那一支，而不是后台的完整目录。
 * 本函数只回答「这个地点能不能进他的切片」：
 * - 当前地点与祖先链：可以（他就在里面）；
 * - 明确登记为 hypothetical（只存在于推测）的地点：不可以；
 * - 其余：由调用方按 knowledge 判定，本函数不扩大范围。
 */
export function sceneLocationAllowedForActor(input: {
  locationId: string;
  actorLocationId: string | null;
  chainIds: readonly string[];
  existenceQuality?: unknown;
}): { allowed: boolean; reasonCode: 'CURRENT' | 'ANCESTOR' | 'NOT_CURRENT' | 'HYPOTHETICAL' } {
  const locationId = str(input?.locationId);
  const quality = str(input?.existenceQuality).toLowerCase();
  if (quality === 'hypothetical') return { allowed: false, reasonCode: 'HYPOTHETICAL' };
  if (locationId !== '' && locationId === str(input?.actorLocationId)) return { allowed: true, reasonCode: 'CURRENT' };
  if ((input?.chainIds ?? []).some((id) => str(id) === locationId)) return { allowed: true, reasonCode: 'ANCESTOR' };
  return { allowed: false, reasonCode: 'NOT_CURRENT' };
}
