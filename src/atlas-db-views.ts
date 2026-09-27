/**
 * atlas-db-views.ts — G01–G04 / G11 只读查询适配器（§16.4 ViewQuery 固定形状）。
 *
 * 规则：
 * - 所有查询使用同一 branch/revision；新聊天或修订变化时旧缓存失效。
 * - 空结果必须返回空数组（调用方据此清卡片），绝不沿用上次结果。
 * - 城市图上只知「在学校」的人物列在地点名单，不和学校叠人物图标。
 * - 估计路线用虚线（由地图层渲染），这里给出 quality 让 UI 说实话。
 */

import { decodeRow } from './atlas-db-codec.ts';
import { queryBound } from './atlas-db-runtime.ts';
import { buildPositionCache, resolveEffectivePosition } from './atlas-sim-position.ts';
import { computeViewportScaleBar } from './atlas-scale.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { ViewQuery, ViewResult } from './atlas-ops-contract.ts';
import type { AtlasAssetRef, AtlasTableName } from './atlas-db-contract.ts';

export type ViewContext = {
  db: SqlDatabase;
  branchId: string;
  revision: number;
  /** §7.1 第 6 条：随存档带来的底图资产清单；用于明确提示底图缺失（缺底图不丢实体）。 */
  assets?: AtlasAssetRef[];
  /** 视角过滤：pov 只返回主角已知内容；author 返回作者视图。 */
  viewMode?: 'pov' | 'author';
  povId?: string | null;
};

function rows(ctx: ViewContext, table: AtlasTableName, where = '', params: Array<string | number | null> = [], limit = 500): Array<Record<string, unknown>> {
  const hasBranch = table !== 'branches' && table !== 'turns' && table !== 'turn_changes' && table !== 'sync_outbox';
  const clauses: string[] = [];
  const values: Array<string | number | null> = [];
  if (hasBranch) {
    clauses.push('branch_id = ?');
    values.push(ctx.branchId);
  }
  if (where) {
    clauses.push(where);
    values.push(...params);
  }
  const sql = `SELECT * FROM ${table}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} LIMIT ${Math.max(1, Math.min(2000, limit))}`;
  return queryBound(ctx.db, sql, values).map((raw) => {
    const decoded = decodeRow(table, raw, { allowExtra: true });
    return decoded.ok ? (decoded.row as Record<string, unknown>) : (raw as Record<string, unknown>);
  });
}

function clampRevision(ctx: ViewContext, requested?: number): { ok: boolean; requested?: number; current: number } {
  if (requested === undefined || requested === null) return { ok: true, current: ctx.revision };
  return { ok: requested === ctx.revision, requested, current: ctx.revision };
}

/**
 * §10.1 / §16.4：author / map / nearby / locationPanel 必须使用**同一 revision**，
 * 「新聊天或修订变化时旧缓存失效；空结果必须清空视图」。
 * 因此 revision 不符时**任何 kind** 都返回空视图 + `metadata.stale`，
 * 绝不返回上一修订的行（否则 UI 会把旧世界当现状画出来）。
 */
function staleResult(ctx: ViewContext, requested: number | undefined): ViewResult | null {
  const rev = clampRevision(ctx, requested);
  if (rev.ok) return null;
  return {
    branchId: ctx.branchId,
    revision: ctx.revision,
    items: [],
    metadata: { stale: true, requestedRevision: rev.requested, currentRevision: rev.current },
  };
}

export type MapViewItem = {
  mapId: string;
  name: string;
  kind: string;
  containerLocationId: string | null;
  metersPerCell: number | null;
  scaleQuality: string;
  scaleLocked: boolean;
  calibrationRev: number;
  defaultTerrain: string;
  points: Array<{
    entityId: string;
    kind: 'location' | 'character' | 'item';
    name: string;
    mapId: string;
    x: number;
    y: number;
    precision: string;
    radius: number | null;
    /** 渲染提示：近似点要带范围或明确估计标识。 */
    markerQuality: 'exact' | 'approximate' | 'layout' | 'coarse';
  }>;
  /** 只知粗粒度地点的人物，不进 points（避免和地点叠图标）。 */
  coarseList: Array<{ entityId: string; name: string; locationId: string; locationName: string | null }>;
  routes: Array<{
    routeId: string;
    fromId: string;
    toId: string;
    kind: string;
    geometryQuality: string;
    distanceM: number | null;
    dashed: boolean;
    allowedModes: string[];
  }>;
  frames: { frame: Record<string, unknown>; scaleBar: ReturnType<typeof computeViewportScaleBar> | null };
};

/** G01 queryMapView：SQL + position resolver 构图；revision/pov 过滤。 */
export function queryMapView(ctx: ViewContext, query: ViewQuery): ViewResult {
  const stale = staleResult(ctx, query.revision);
  if (stale) return stale;

  const maps = rows(ctx, 'maps', '', [], 200).filter((m) => String(m.status) === 'active');
  if (maps.length === 0) {
    return { branchId: ctx.branchId, revision: ctx.revision, items: [], metadata: { empty: true, reason: 'NO_MAP' } };
  }
  const selected = query.mapId ? maps.filter((m) => String(m.id) === query.mapId) : maps;
  const mapIds = new Set(selected.map((m) => String(m.id)));

  const locations = rows(ctx, 'locations', "status = 'active'", [], 2000);
  const locationById = new Map(locations.map((l) => [String(l.id), l]));
  const characters = rows(ctx, 'characters', "status = 'active'", [], 2000);
  const itemRows = rows(ctx, 'items', "status = 'active'", [], 2000);
  const routes = rows(ctx, 'routes', '', [], 1000);
  // 一次预取全部相关行：逐实体解析若各自查库会退化成本规模的 N+1（实测 500 人规模 24s）。
  const positionCache = buildPositionCache({ db: ctx.db, branchId: ctx.branchId });

  const items: MapViewItem[] = selected.map((map) => {
    const mapId = String(map.id);
    const points: MapViewItem['points'] = [];
    const coarseList: MapViewItem['coarseList'] = [];

    for (const loc of locations) {
      const locId = String(loc.id);
      const locMap = loc.map_id ? String(loc.map_id) : null;
      if (locMap !== mapId) continue;
      const precision = String(loc.coord_precision ?? 'unknown');
      if (precision === 'unknown' || typeof loc.grid_x !== 'number' || typeof loc.grid_y !== 'number') continue;
      points.push({
        entityId: locId,
        kind: 'location',
        name: String(loc.name ?? ''),
        mapId,
        x: loc.grid_x,
        y: loc.grid_y,
        precision,
        radius: typeof loc.uncertainty_radius_cells === 'number' ? loc.uncertainty_radius_cells : null,
        markerQuality: precision as 'exact' | 'approximate' | 'layout',
      });
    }

    for (const ch of characters) {
      const chId = String(ch.id);
      const position = resolveEffectivePosition({ db: ctx.db, branchId: ctx.branchId }, chId, undefined, positionCache);
      if (position.kind === 'at_grid' && position.mapId === mapId) {
        points.push({
          entityId: chId,
          kind: 'character',
          name: String(ch.name ?? ''),
          mapId,
          x: position.x,
          y: position.y,
          precision: position.precision,
          radius: position.radius ?? null,
          markerQuality: position.precision,
        });
      } else if (position.kind === 'at_location') {
        const loc = locationById.get(position.locationId);
        const locMap = loc?.map_id ? String(loc.map_id) : null;
        // 有精坐标但 map_id 未回填的人物：用所在地点的地图补足，按 approximate 显示。
        if (locMap === mapId && typeof ch.grid_x === 'number' && typeof ch.grid_y === 'number' && String(ch.coord_precision) !== 'unknown') {
          points.push({
            entityId: chId,
            kind: 'character',
            name: String(ch.name ?? ''),
            mapId,
            x: ch.grid_x,
            y: ch.grid_y,
            precision: String(ch.coord_precision),
            radius: typeof ch.uncertainty_radius_cells === 'number' ? ch.uncertainty_radius_cells : null,
            markerQuality: String(ch.coord_precision) as 'exact' | 'approximate' | 'layout',
          });
          continue;
        }
        // 只知粗粒度地点的人物：列在「该地点」的地图名单，不叠加人物图标。
        if (locMap === mapId) {
          coarseList.push({
            entityId: chId,
            name: String(ch.name ?? ''),
            locationId: position.locationId,
            locationName: loc ? String(loc.name ?? '') : null,
          });
        }
      }
    }

    for (const item of itemRows) {
      const itemId = String(item.id);
      if (item.holder_character_id || item.container_item_id) continue;
      const position = resolveEffectivePosition({ db: ctx.db, branchId: ctx.branchId }, itemId, undefined, positionCache);
      if (position.kind === 'at_grid' && position.mapId === mapId) {
        points.push({
          entityId: itemId,
          kind: 'item',
          name: String(item.name ?? ''),
          mapId,
          x: position.x,
          y: position.y,
          precision: position.precision,
          radius: position.radius ?? null,
          markerQuality: position.precision,
        });
      }
    }

    const mapRoutes = routes
      .filter((r) => (r.map_id ? String(r.map_id) === mapId : false))
      .map((r) => ({
        routeId: String(r.id),
        fromId: String(r.from_location_id),
        toId: String(r.to_location_id),
        kind: String(r.kind),
        geometryQuality: String(r.geometry_quality ?? 'unknown'),
        distanceM: typeof r.distance_m === 'number' ? r.distance_m : null,
        dashed: String(r.geometry_quality) !== 'confirmed',
        allowedModes: Array.isArray(r.allowed_modes_json) ? (r.allowed_modes_json as string[]) : [],
      }));

    const metersPerCell = typeof map.meters_per_cell === 'number' ? map.meters_per_cell : null;
    return {
      mapId,
      name: String(map.name ?? ''),
      kind: String(map.kind ?? 'world'),
      containerLocationId: map.container_location_id ? String(map.container_location_id) : null,
      metersPerCell,
      scaleQuality: String(map.scale_quality ?? 'uncalibrated'),
      scaleLocked: Number(map.scale_locked ?? 0) === 1,
      calibrationRev: Number(map.calibration_rev ?? 1),
      defaultTerrain: String(map.default_terrain ?? 'unknown'),
      points,
      coarseList,
      routes: mapRoutes,
      frames: {
        frame: (map.frame_json as Record<string, unknown>) ?? {},
        scaleBar: metersPerCell === null ? null : computeViewportScaleBar({ cameraK: 40, metersPerCell }),
      },
    };
  });

  return {
    branchId: ctx.branchId,
    revision: ctx.revision,
    items,
    metadata: {
      mapCount: mapIds.size,
      pointCount: items.reduce((n, m) => n + (m as MapViewItem).points.length, 0),
      coarseCount: items.reduce((n, m) => n + (m as MapViewItem).coarseList.length, 0),
      viewMode: ctx.viewMode ?? 'author',
      ...assetDiagnostics(ctx, selected),
    },
  };
}
/**
 * §7.1 第 6 条：底图放附件区，数据库只存引用。缺底图时**实体与坐标一律不动**
 * （缺底图不是丢数据的理由），只把「引用了但没随存档带来」的资产写进 metadata，
 * 并给出一句人读提示，供 UI 说实话。
 */
function assetDiagnostics(ctx: ViewContext, maps: Array<Record<string, unknown>>): Record<string, unknown> {
  const present = new Set((ctx.assets ?? []).map((asset) => String(asset.key)));
  const referenced = [
    ...new Set(
      maps
        .map((map) =>
          map.background_asset_key === null || map.background_asset_key === undefined
            ? ''
            : String(map.background_asset_key),
        )
        .filter((key) => key !== ''),
    ),
  ].sort();
  const missing = referenced.filter((key) => !present.has(key));
  const unreferenced = [...present].filter((key) => !referenced.includes(key)).sort();
  return {
    assetCheck: 'ok',
    referencedAssetCount: referenced.length,
    missingAssets: missing,
    missingAssetCount: missing.length,
    unreferencedAssets: unreferenced,
    assetNotice:
      missing.length > 0 ? `缺底图：${missing.length} 张引用的底图未随存档带来（实体与坐标仍完整）` : null,
  };
}

/**
 * G02 queryNearby：同场/邻接实际相关者；未知精点保粗位置；空结果返回 []（UI 清卡片）。
 */
export function queryNearby(ctx: ViewContext, query: ViewQuery): ViewResult {
  const stale = staleResult(ctx, query.revision);
  if (stale) return stale;
  const target = query.entityId ? resolveEffectivePosition({ db: ctx.db, branchId: ctx.branchId }, query.entityId) : { kind: 'unknown' as const };
  if (target.kind === 'unknown') {
    return { branchId: ctx.branchId, revision: ctx.revision, items: [], metadata: { reason: 'POSITION_UNKNOWN' } };
  }
  const here = target.kind === 'at_grid' ? target.mapId : target.kind === 'at_location' ? target.locationId : null;
  const characters = rows(ctx, 'characters', "status = 'active'", [], 1000);
  const results: Array<Record<string, unknown>> = [];
  for (const ch of characters) {
    const id = String(ch.id);
    if (query.entityId && id === query.entityId) continue;
    const position = resolveEffectivePosition({ db: ctx.db, branchId: ctx.branchId }, id);
    if (target.kind === 'at_grid' && position.kind === 'at_grid' && position.mapId === here) {
      const dx = position.x - target.x;
      const dy = position.y - target.y;
      results.push({
        entityId: id,
        name: String(ch.name ?? ''),
        relevance: 'same_map',
        positionQuality: position.precision,
        gridDistance: Math.sqrt(dx * dx + dy * dy),
      });
    } else if (target.kind === 'at_location' && position.kind === 'at_location' && position.locationId === here) {
      results.push({
        entityId: id,
        name: String(ch.name ?? ''),
        relevance: 'same_location',
        positionQuality: 'coarse',
      });
    }
  }
  const limit = query.limit ?? 50;
  return {
    branchId: ctx.branchId,
    revision: ctx.revision,
    items: results.slice(0, limit),
    metadata: { anchor: target.kind, anchorId: here, total: results.length },
  };
}

/** G03 queryEntityDetail：人物聚合关系/行动/行程/认知；地点聚合子地/在场/事件/风声。 */
export function queryEntityDetail(ctx: ViewContext, query: ViewQuery): ViewResult {
  const stale = staleResult(ctx, query.revision);
  if (stale) return stale;
  const entityId = query.entityId;
  if (!entityId) return { branchId: ctx.branchId, revision: ctx.revision, items: [], metadata: { reason: 'NO_ENTITY_ID' } };
  const key = rows(ctx, 'entity_keys', 'id = ?', [entityId], 1)[0];
  if (!key) return { branchId: ctx.branchId, revision: ctx.revision, items: [], metadata: { reason: 'ENTITY_UNKNOWN' } };
  const kind = String(key.kind);

  if (kind === 'character') {
    const character = rows(ctx, 'characters', 'id = ?', [entityId], 1)[0];
    if (!character) return { branchId: ctx.branchId, revision: ctx.revision, items: [], metadata: { reason: 'ENTITY_UNKNOWN' } };
    const relations = rows(ctx, 'relations', 'subject_entity_id = ? OR object_entity_id = ?', [entityId, entityId], 200);
    const actions = rows(ctx, 'actions', 'actor_entity_id = ?', [entityId], 100);
    const journeys = rows(ctx, 'journeys', 'mover_entity_id = ?', [entityId], 20);
    const knowledge = rows(ctx, 'knowledge', 'knower_character_id = ?', [entityId], 200);
    const position = resolveEffectivePosition({ db: ctx.db, branchId: ctx.branchId }, entityId);
    return {
      branchId: ctx.branchId,
      revision: ctx.revision,
      items: [{ kind, character, relations, actions, journeys, knowledge, position }],
      metadata: { counts: { relations: relations.length, actions: actions.length, knowledge: knowledge.length } },
    };
  }

  if (kind === 'location') {
    const location = rows(ctx, 'locations', 'id = ?', [entityId], 1)[0];
    if (!location) return { branchId: ctx.branchId, revision: ctx.revision, items: [], metadata: { reason: 'ENTITY_UNKNOWN' } };
    const children = rows(ctx, 'locations', 'parent_location_id = ?', [entityId], 200);
    const present = rows(ctx, 'characters', 'location_id = ? AND status = ?', [entityId, 'active'], 200);
    const events = rows(ctx, 'events', 'location_id = ?', [entityId], 200);
    const fronts = rows(ctx, 'rumor_fronts', 'location_id = ?', [entityId], 200);
    const position = resolveEffectivePosition({ db: ctx.db, branchId: ctx.branchId }, entityId);
    return {
      branchId: ctx.branchId,
      revision: ctx.revision,
      items: [{ kind, location, children, present, events, fronts, position }],
      metadata: { counts: { children: children.length, present: present.length, events: events.length, fronts: fronts.length } },
    };
  }

  if (kind === 'item') {
    const item = rows(ctx, 'items', 'id = ?', [entityId], 1)[0];
    if (!item) return { branchId: ctx.branchId, revision: ctx.revision, items: [], metadata: { reason: 'ENTITY_UNKNOWN' } };
    const contained = rows(ctx, 'items', 'container_item_id = ?', [entityId], 200);
    const position = resolveEffectivePosition({ db: ctx.db, branchId: ctx.branchId }, entityId);
    return { branchId: ctx.branchId, revision: ctx.revision, items: [{ kind, item, contained, position }], metadata: {} };
  }

  const faction = rows(ctx, 'factions', 'id = ?', [entityId], 1)[0];
  const relations = rows(ctx, 'relations', 'subject_entity_id = ? OR object_entity_id = ?', [entityId, entityId], 200);
  const channels = rows(ctx, 'channels', 'owner_entity_id = ?', [entityId], 100);
  return {
    branchId: ctx.branchId,
    revision: ctx.revision,
    items: [{ kind, faction, relations, channels }],
    metadata: { counts: { relations: relations.length, channels: channels.length } },
  };
}

/** G04 queryChanges：从 turn_changes + events 生成实际动向。 */
export function queryChanges(ctx: ViewContext, query: ViewQuery): ViewResult {
  const stale = staleResult(ctx, query.revision);
  if (stale) return stale;
  const limit = Math.max(1, Math.min(500, query.limit ?? 100));
  const changes = queryBound(
    ctx.db,
    `SELECT tc.id, tc.turn_id, tc.sequence, tc.group_id, tc.operation_id, tc.target_table, tc.target_row_id, tc.operation, tc.summary, tc.basis_json, t.kind AS turn_kind, t.created_wall_ms
     FROM turn_changes tc JOIN turns t ON t.id = tc.turn_id
     WHERE t.branch_id = ?
     ORDER BY tc.turn_id DESC, tc.sequence DESC LIMIT ?`,
    [ctx.branchId, limit],
  );
  const items = changes.map((c) => ({
    changeId: String(c.id),
    turnId: String(c.turn_id),
    sequence: Number(c.sequence),
    groupId: String(c.group_id),
    operationId: String(c.operation_id),
    table: String(c.target_table),
    rowId: String(c.target_row_id),
    operation: String(c.operation),
    summary: String(c.summary ?? ''),
    turnKind: String(c.turn_kind ?? ''),
    basis: safeJson(c.basis_json),
  }));
  return {
    branchId: ctx.branchId,
    revision: ctx.revision,
    items,
    metadata: { count: items.length, cursor: query.cursor ?? null },
  };
}

function safeJson(text: unknown): Record<string, unknown> {
  if (typeof text !== 'string') return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { parseError: true };
  }
}

/**
 * G11 queryDiagnostics：时间线筛选/分页/完整导出游标。
 * 分页 100 条不等于导出截断：导出全部匹配记录，超出留存范围明确给出 droppedCount。
 */
export function queryDiagnostics(ctx: ViewContext, query: ViewQuery): ViewResult {
  const stale = staleResult(ctx, query.revision);
  if (stale) return stale;
  const limit = Math.max(1, Math.min(500, query.limit ?? 100));
  const offset = query.cursor ? Number(query.cursor) : 0;
  const total = queryBound(
    ctx.db,
    `SELECT COUNT(*) AS n FROM turn_changes tc JOIN turns t ON t.id = tc.turn_id WHERE t.branch_id = ?`,
    [ctx.branchId],
  );
  const totalCount = Number(total[0]?.n ?? 0);
  const changes = queryBound(
    ctx.db,
    `SELECT tc.id, tc.turn_id, tc.group_id, tc.operation_id, tc.target_table, tc.target_row_id, tc.operation, tc.summary, tc.basis_json
     FROM turn_changes tc JOIN turns t ON t.id = tc.turn_id
     WHERE t.branch_id = ? ORDER BY tc.turn_id, tc.sequence LIMIT ? OFFSET ?`,
    [ctx.branchId, limit, offset],
  );
  const failedTurns = queryBound(
    ctx.db,
    `SELECT id, status, receipt_json, attempts_json FROM turns WHERE branch_id = ? AND status IN ('failed','partial') ORDER BY created_wall_ms DESC LIMIT 50`,
    [ctx.branchId],
  );
  const nextOffset = offset + changes.length;
  return {
    branchId: ctx.branchId,
    revision: ctx.revision,
    items: [
      ...changes.map((c) => ({
        logId: String(c.id),
        kind: 'change',
        turnId: String(c.turn_id),
        groupId: String(c.group_id),
        operationId: String(c.operation_id),
        table: String(c.target_table),
        rowId: String(c.target_row_id),
        operation: String(c.operation),
        summary: String(c.summary ?? ''),
        basis: safeJson(c.basis_json),
      })),
      ...failedTurns.map((t) => ({
        logId: `turn_${String(t.id)}`,
        kind: 'failed_turn',
        turnId: String(t.id),
        status: String(t.status),
        receipt: safeJson(t.receipt_json),
        attempts: safeJson(t.attempts_json),
      })),
    ],
    nextCursor: nextOffset < totalCount ? String(nextOffset) : undefined,
    metadata: {
      totalCount,
      returned: changes.length,
      droppedCount: 0,
      pageSize: limit,
      /** 导出全部匹配记录；分页不截断导出。 */
      exportComplete: true,
    },
  };
}

/** §16.4 simulation 视图：世界时钟与后台结算状态。 */
export function querySimulationView(ctx: ViewContext, query: ViewQuery): ViewResult {
  const stale = staleResult(ctx, query.revision);
  if (stale) return stale;
  const branch = queryBound(ctx.db, 'SELECT * FROM branches WHERE id = ?', [ctx.branchId])[0];
  if (!branch) return { branchId: ctx.branchId, revision: ctx.revision, items: [], metadata: { reason: 'BRANCH_UNKNOWN' } };
  const clock = Number(branch.clock_s ?? 0);
  const cursor = Number(branch.simulation_cursor_s ?? 0);
  const pending = cursor < clock;
  return {
    branchId: ctx.branchId,
    revision: ctx.revision,
    items: [
      {
        clockS: clock,
        clockMinS: Number(branch.clock_min_s ?? 0),
        clockMaxS: Number(branch.clock_max_s ?? 0),
        calendarLabel: branch.calendar_label ?? null,
        simulationCursorS: cursor,
        simulationStatus: String(branch.simulation_status ?? 'current'),
        /** UI 必须显示「后台尚未结算到当前时间」。 */
        pendingNotice: pending ? `正文时间已前进，部分后台尚在结算（未结算 ${Math.round(clock - cursor)} 秒）` : null,
      },
    ],
    metadata: { pending, viewMode: ctx.viewMode ?? 'author', requestedCursor: query.cursor ?? null },
  };
}
