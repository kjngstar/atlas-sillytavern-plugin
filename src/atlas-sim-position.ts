/**
 * atlas-sim-position.ts — §10.1 唯一位置解析入口 resolveEffectivePosition。
 *
 * 解析次序：物品的持有者/容器 → 移动载具/独立行程 → 停靠位置 → 有效固定坐标 → 粗粒度地点 → unknown。
 * 包含/持有链检查循环；旅客在车厢内、车厢在马车内、马车在路上时，人物仍属于车厢地点，
 * 同时可沿载具解析到世界位置；**不把车厢坐标与世界坐标直接相加**。
 */

import { queryBound } from './atlas-db-runtime.ts';
import { decodeRow } from './atlas-db-codec.ts';
import { ATLAS_RUNTIME_LIMITS } from './atlas-runtime-limits.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';

export type ResolvedPosition =
  | { kind: 'at_grid'; mapId: string; x: number; y: number; precision: 'exact' | 'approximate' | 'layout'; radius?: number | null }
  | { kind: 'at_location'; locationId: string; precision: 'coarse' }
  | { kind: 'in_transit'; journeyId: string; fromId: string | null; toId: string | null; routePosition?: number | null; quality: string }
  | { kind: 'unknown' };

export type PositionWorld = {
  db: SqlDatabase;
  branchId: string;
};

function row(db: SqlDatabase, table: string, branchId: string, id: string): Record<string, unknown> | null {
  const rows = queryBound(db, `SELECT * FROM ${table} WHERE branch_id = ? AND id = ? LIMIT 1`, [branchId, id]);
  if (rows.length === 0) return null;
  const decoded = decodeRow(table as never, rows[0], { allowExtra: true });
  return decoded.ok ? (decoded.row as Record<string, unknown>) : null;
}

function openJourneyOf(world: PositionWorld, entityId: string): Record<string, unknown> | null {
  const rows = queryBound(
    world.db,
    `SELECT * FROM journeys WHERE branch_id = ? AND mover_entity_id = ? AND status IN ('moving','paused','blocked') LIMIT 1`,
    [world.branchId, entityId],
  );
  if (rows.length === 0) return null;
  const decoded = decodeRow('journeys', rows[0], { allowExtra: true });
  return decoded.ok ? (decoded.row as Record<string, unknown>) : null;
}

function isKnownEntity(world: PositionWorld, entityId: string): boolean {
  const rows = queryBound(world.db, 'SELECT kind FROM entity_keys WHERE branch_id = ? AND id = ? LIMIT 1', [world.branchId, entityId]);
  return rows.length > 0;
}

const MAX_CHAIN = ATLAS_RUNTIME_LIMITS.containerDepth;

/**
 * 统一位置解析。完成定义：乘客随车；未知房间不出现假精确点。
 */
export function resolveEffectivePosition(
  world: PositionWorld,
  entityId: string,
  _atTime?: number,
  cache?: PositionCache,
): ResolvedPosition {
  const visited = new Set<string>();
  let cursor = entityId;
  let depth = 0;

  while (cursor && depth <= MAX_CHAIN) {
    if (visited.has(cursor)) return { kind: 'unknown' }; // 包含/持有链循环
    visited.add(cursor);
    depth += 1;

    const item = pickRow(world, cache, 'items', cursor);
    if (item) {
      const holder = item.holder_character_id ? String(item.holder_character_id) : null;
      const container = item.container_item_id ? String(item.container_item_id) : null;
      if (holder) {
        cursor = holder;
        continue;
      }
      if (container) {
        cursor = container;
        continue;
      }
    }

    const character = pickRow(world, cache, 'characters', cursor);
    if (character) {
      const journey = pickOpenJourney(world, cache, cursor);
      if (journey && String(journey.status) === 'moving') {
        return {
          kind: 'in_transit',
          journeyId: String(journey.id),
          fromId: journey.last_reached_location_id ? String(journey.last_reached_location_id) : String(journey.origin_location_id),
          toId: String(journey.destination_location_id),
          routePosition: typeof journey.segment_distance_done_m === 'number' ? journey.segment_distance_done_m : null,
          quality: String(journey.position_quality ?? 'unlocated'),
        };
      }
      if (journey && ['paused', 'blocked'].includes(String(journey.status)) && journey.stop_location_id) {
        return { kind: 'at_location', locationId: String(journey.stop_location_id), precision: 'coarse' };
      }
      const location = character.location_id ? String(character.location_id) : null;
      if (location) {
        // 先在粗粒度地点上停；如果该地点本身是移动载具且有行程，则沿载具解析世界位置。
        // visited 只记录「已作为包含者展开过」的身份；车厢/载具是这条链的下一跳，
        // 不能拿已展开的父地点预先占位，否则乘客永远解析不到载具行程。
        // 当前身份本身是这条链的起点，不算「已展开的载具」；把 entityId 一并清掉。
        const vehicleVisited = new Set(visited);
        vehicleVisited.delete(cursor);
        vehicleVisited.delete(entityId);
        const nested = resolveVehicleChain(world, location, vehicleVisited, cache);
        if (nested) return nested;
        // A fixed location is not a reason to discard the character's own valid
        // fine position. Moving vehicle/journey resolution above remains prior.
        const ownGrid=gridOf(character);
        if(ownGrid)return ownGrid;
        return { kind: 'at_location', locationId: location, precision: 'coarse' };
      }
      const grid = gridOf(character);
      if (grid) return grid;
      return { kind: 'unknown' };
    }

    const location = pickRow(world, cache, 'locations', cursor);
    if (location) {
      const journey = pickOpenJourney(world, cache, cursor);
      if (journey && String(journey.status) === 'moving') {
        return {
          kind: 'in_transit',
          journeyId: String(journey.id),
          fromId: journey.last_reached_location_id ? String(journey.last_reached_location_id) : String(journey.origin_location_id),
          toId: String(journey.destination_location_id),
          routePosition: typeof journey.segment_distance_done_m === 'number' ? journey.segment_distance_done_m : null,
          quality: String(journey.position_quality ?? 'unlocated'),
        };
      }
      // 停靠位置优先于固定坐标之外的解析
      if(location.mobility==='mobile'&&location.anchor_location_id){
        const anchored=pickRow(world,cache,'locations',String(location.anchor_location_id));
        if(anchored)return gridOf(anchored)??{kind:'at_location',locationId:String(anchored.id),precision:'coarse'};
      }
      const grid = gridOf(location);
      if (grid) return grid;
      const anchor = location.anchor_location_id ? String(location.anchor_location_id) : null;
      if (anchor) {
        const anchorRow = row(world.db, 'locations', world.branchId, anchor);
        if (anchorRow) {
          const anchorGrid = gridOf(anchorRow);
          if (anchorGrid) return anchorGrid;
          return { kind: 'at_location', locationId: anchor, precision: 'coarse' };
        }
      }
      const parent = location.parent_location_id ? String(location.parent_location_id) : null;
      if (parent) {
        // 子地点没有自身坐标时，沿父链找到最近有坐标的祖先；仍标 coarse。
        const inherited = resolveStaticLocationPosition(world, parent, new Set([cursor]), cache);
        if (inherited) return inherited;
      }
      return { kind: 'at_location', locationId: cursor, precision: 'coarse' };
    }

    if (!isKnownEntityCached(world, cache, cursor)) return { kind: 'unknown' };
    return { kind: 'unknown' };
  }
  return { kind: 'unknown' };
}

function resolveVehicleChain(
  world: PositionWorld,
  locationId: string,
  visited: Set<string>,
  cache?: PositionCache,
): ResolvedPosition | null {
  if (visited.has(locationId)) return null;
  visited.add(locationId);
  const location = pickRow(world, cache, 'locations', locationId);
  const journey = pickOpenJourney(world, cache, locationId);
  if (!journey) {
    // 车厢/客室本身没有行程：沿父链找到真正在途的载具（旅客随车，不给车厢复制世界坐标）。
    const parent = location?.parent_location_id ? String(location.parent_location_id) : null;
    if (!parent) return null;
    return resolveVehicleChain(world, parent, visited, cache);
  }
  if (String(journey.status) === 'moving') {
    return {
      kind: 'in_transit',
      journeyId: String(journey.id),
      fromId: journey.last_reached_location_id ? String(journey.last_reached_location_id) : String(journey.origin_location_id),
      toId: String(journey.destination_location_id),
      routePosition: typeof journey.segment_distance_done_m === 'number' ? journey.segment_distance_done_m : null,
      quality: String(journey.position_quality ?? 'unlocated'),
    };
  }
  return null;
}

function resolveStaticLocationPosition(
  world: PositionWorld,
  locationId: string,
  seen: Set<string>,
  cache?: PositionCache,
): ResolvedPosition | null {
  if (seen.has(locationId)) return null;
  seen.add(locationId);
  const location = pickRow(world, cache, 'locations', locationId);
  if (!location) return null;
  const grid = gridOf(location);
  if (grid) return grid;
  const parent = location.parent_location_id ? String(location.parent_location_id) : null;
  if (parent) return resolveStaticLocationPosition(world, parent, seen, cache);
  return null;
}

function gridOf(entity: Record<string, unknown>): ResolvedPosition | null {
  const mapId = entity.map_id ? String(entity.map_id) : null;
  const x = typeof entity.grid_x === 'number' ? entity.grid_x : null;
  const y = typeof entity.grid_y === 'number' ? entity.grid_y : null;
  if (!mapId || x === null || y === null) return null;
  const precision = String(entity.coord_precision ?? 'unknown');
  if (precision === 'unknown') return null;
  return {
    kind: 'at_grid',
    mapId,
    x,
    y,
    precision: precision as 'exact' | 'approximate' | 'layout',
    radius: typeof entity.uncertainty_radius_cells === 'number' ? entity.uncertainty_radius_cells : null,
  };
}

/** §10.2：地点面板需要「粗定位名单」时用这个判断。 */
export function isCoarselyLocated(position: ResolvedPosition): boolean {
  return position.kind === 'at_location';
}

/**
 * 批量预取的可选缓存：视图层一次读入全部相关行，避免逐实体 N+1 查询
 * （§11.1 的查询复杂度要求：大世界的作者视图不能退化成每实体一次 SQL）。
 * 传入后 `resolveEffectivePosition` 只读缓存；判定逻辑与逐行读取完全一致。
 */
export type PositionCache = {
  items?: Map<string, Record<string, unknown>>;
  characters?: Map<string, Record<string, unknown>>;
  locations?: Map<string, Record<string, unknown>>;
  journeyByMover?: Map<string, Record<string, unknown>>;
};

function pickRow(
  world: PositionWorld,
  cache: PositionCache | undefined,
  table: 'items' | 'characters' | 'locations',
  id: string,
): Record<string, unknown> | null {
  const bucket = cache?.[table];
  if (bucket) return bucket.get(id) ?? null;
  return row(world.db, table, world.branchId, id);
}

function pickOpenJourney(world: PositionWorld, cache: PositionCache | undefined, entityId: string): Record<string, unknown> | null {
  if (cache?.journeyByMover) return cache.journeyByMover.get(entityId) ?? null;
  return openJourneyOf(world, entityId);
}

function isKnownEntityCached(world: PositionWorld, cache: PositionCache | undefined, entityId: string): boolean {
  if (cache && (cache.items || cache.characters || cache.locations)) {
    return Boolean(cache.items?.has(entityId) || cache.characters?.has(entityId) || cache.locations?.has(entityId));
  }
  return isKnownEntity(world, entityId);
}

/** 批量构建位置缓存：一次查询读入全部相关行。 */
export function buildPositionCache(world: PositionWorld): PositionCache {
  const toMap = (table: 'items' | 'characters' | 'locations'): Map<string, Record<string, unknown>> => {
    const out = new Map<string, Record<string, unknown>>();
    for (const raw of queryBound(world.db, `SELECT * FROM ${table} WHERE branch_id = ?`, [world.branchId])) {
      const decoded = decodeRow(table as never, raw, { allowExtra: true });
      const rowValue = decoded.ok ? (decoded.row as Record<string, unknown>) : (raw as Record<string, unknown>);
      out.set(String(rowValue.id), rowValue);
    }
    return out;
  };
  const journeyByMover = new Map<string, Record<string, unknown>>();
  for (const raw of queryBound(
    world.db,
    `SELECT * FROM journeys WHERE branch_id = ? AND status IN ('moving','paused','blocked')`,
    [world.branchId],
  )) {
    const decoded = decodeRow('journeys', raw, { allowExtra: true });
    const rowValue = decoded.ok ? (decoded.row as Record<string, unknown>) : (raw as Record<string, unknown>);
    const mover = String(rowValue.mover_entity_id ?? '');
    if (mover && !journeyByMover.has(mover)) journeyByMover.set(mover, rowValue);
  }
  return { items: toMap('items'), characters: toMap('characters'), locations: toMap('locations'), journeyByMover };
}

/** 诊断用：把位置解析结果变成一段人读说明（不含精点）。 */
export function describePosition(position: ResolvedPosition, labels: { mapName?: string; locationName?: string } = {}): string {
  switch (position.kind) {
    case 'at_grid':
      return `${labels.mapName ?? position.mapId} 格 (${position.x}, ${position.y})，精度 ${position.precision}`;
    case 'at_location':
      return `在 ${labels.locationName ?? position.locationId}，具体位置未知`;
    case 'in_transit':
      return `在途（${position.fromId ?? '?'} → ${position.toId ?? '?'}，${position.quality}）`;
    default:
      return '位置未知';
  }
}
