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
import { scenePositions } from './atlas-scene-layout.ts';
import { sqlVisibility } from './atlas-sql-visibility.ts';
import { resolveMapTopology } from './atlas-map-topology.ts';
import { ATLAS_RUNTIME_LIMITS } from './atlas-runtime-limits.ts';
import { publicMapFrame } from '../vendor/atlas-spatial/index.mjs';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { ConnectionQuality, TopologyLocation, TopologyMap } from './atlas-world-contract.ts';
import type { ViewQuery, ViewResult } from './atlas-ops-contract.ts';
import type { AtlasAssetRef, AtlasTableName } from './atlas-db-contract.ts';

/**
 * M4/Q02：把 `routes.geometry_json`（{kind,coordinates:[[x,y]]}）投影成可绘制的格坐标几何。
 *
 * - 只有 kind='line' 且至少两个有限坐标点才给 geometry；polygon 不是路线，null。
 * - 坏几何 / 缺几何一律 null + 一条逐路由的 issue，UI 显示「不可绘制」而不是画假线。
 */
export function projectRouteGeometry(
  route: Record<string, unknown>,
  mapId: string,
): { geometry: { mapId: string; units: 'cells'; points: Array<{ x: number; y: number }> } | null; issue?: { routeId: string; code: string; message: string } } {
  const routeId = String(route.id ?? '');
  const raw = route.geometry_json;
  if (raw === null || raw === undefined || raw === '') return { geometry: null };
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { geometry: null, issue: { routeId, code: 'GEOMETRY_JSON_INVALID', message: '路线几何不是合法 JSON，按无几何处理' } };
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { geometry: null, issue: { routeId, code: 'GEOMETRY_SHAPE_INVALID', message: '路线几何必须是对象，按无几何处理' } };
  }
  const doc = parsed as Record<string, unknown>;
  const kind = String(doc.kind ?? '');
  if (kind !== 'line') {
    return { geometry: null, issue: { routeId, code: 'GEOMETRY_KIND_NOT_LINE', message: `路线几何 kind=${kind || '空'} 不是 line，不画线` } };
  }
  const coords = doc.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) {
    return { geometry: null, issue: { routeId, code: 'GEOMETRY_TOO_FEW_POINTS', message: '路线几何至少需要两个点，按无几何处理' } };
  }
  const points: Array<{ x: number; y: number }> = [];
  for (const entry of coords) {
    const pair = Array.isArray(entry) ? entry : (entry !== null && typeof entry === 'object' ? [(entry as Record<string, unknown>).x, (entry as Record<string, unknown>).y] : null);
    if (!pair || pair.length < 2) {
      return { geometry: null, issue: { routeId, code: 'GEOMETRY_POINT_INVALID', message: '路线几何存在非法顶点，整条路线按无几何处理' } };
    }
    const x = Number(pair[0]);
    const y = Number(pair[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { geometry: null, issue: { routeId, code: 'GEOMETRY_POINT_INVALID', message: '路线几何存在非有限坐标，整条路线按无几何处理' } };
    }
    points.push({ x, y });
  }
  return { geometry: { mapId, units: 'cells', points } };
}

export type ViewContext = {
  db: SqlDatabase;
  branchId: string;
  revision: number;
  /** §7.1 第 6 条：随存档带来的底图资产清单；用于明确提示底图缺失（缺底图不丢实体）。 */
  assets?: AtlasAssetRef[];
  /** 视角过滤：pov 只返回主角已知内容；author 返回作者视图。 */
  viewMode?: 'pov' | 'author';
  povId?: string | null;
  /** M4/Q03：空间适配器作用域需要 chatId；读口无宿主会话时用分支兜底。 */
  chatId?: string;
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
  backgroundAssetKey?: string|null;
  kind: string;
  containerLocationId: string | null;
  containerLocationKind?: string | null;
  /**
   * M2-05（02 §3）：本次解析出的导航父图与连接质量。**不是**数据库里的永久列，
   * 也不由 `location.map_id` 推导；`contained` = 由容器地点的父链找到的祖先内图，
   * `anchored` = 载具按有效停靠点挂接，`root` = 自身即顶图，`unclassified` = 无可用祖先
   * （只挂可见根图），`invalid` = 结构性坏图（含父环/缺父/重复容器/自容器）。
   */
  parentMapId: string | null;
  connectionQuality: ConnectionQuality;
  /** 与本图相关的坏图诊断码（去重、稳定排序）。POV 下只含可公开部分，不借父图标题泄密。 */
  topologyIssueCodes: string[];
  metersPerCell: number | null;
  scaleQuality: string;
  scaleLocked: boolean;
  calibrationRev: number;
  defaultTerrain: string;
  points: Array<{
    entityId: string;
    kind: 'location' | 'character' | 'item';
    mobility?: string;
    locationKind?: string;
    name: string;
    mapId: string;
    x: number;
    y: number;
    precision: string;
    radius: number | null;
    /** 渲染提示：近似点要带范围或明确估计标识。 */
    markerQuality: 'exact' | 'approximate' | 'layout' | 'coarse';
    locationId?: string | null;
    isProtagonist?: boolean;
    hidden?: boolean;
    area?: unknown;
  }>;
  /** 只知粗粒度地点的人物，不进 points（避免和地点叠图标）。 */
  coarseList: Array<{ entityId: string; name: string; locationId: string; locationName: string | null; hidden?:boolean }>;
  routes: Array<{
    routeId: string;
    fromId: string;
    toId: string;
    kind: string;
    geometryQuality: string;
    distanceM: number | null;
    dashed: boolean;
    allowedModes: string[];
    /** M4/Q02：可绘制格坐标几何（{mapId,units:'cells',points}）；无几何 / 坏几何一律 null，不画假线。 */
    geometry: { mapId: string; units: 'cells'; points: Array<{ x: number; y: number }> } | null;
    /** M4/Q02：端点引用，供适配器判断路线在 POV 下是否可见。 */
    mapId: string;
    fromLocationId: string;
    toLocationId: string;
  }>;
  frames: { frame: Record<string, unknown>; scaleBar: ReturnType<typeof computeViewportScaleBar> | null };
};

/** G01 queryMapView：SQL + position resolver 构图；revision/pov 过滤。 */
export function queryMapView(ctx: ViewContext, query: ViewQuery): ViewResult {
  const stale = staleResult(ctx, query.revision);
  if (stale) return stale;

  const maps = rows(ctx, 'maps', '', [], 1001).filter((m) => String(m.status) === 'active');
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
  const visibility=sqlVisibility(ctx);

  // ── M2-05：从 SQL 构造统一 TopologyInput，只算一次导航父图（02 §3）──────────
  // POV 先按原 sqlVisibility 把地点筛成可见集合再算拓扑：隐藏祖先自然断链，
  // 于是只能回落到可见根图，既不会下发隐藏父图 ID，也不会泄露其标题。
  const rootRow = rows(ctx, 'branches', 'id = ?', [ctx.branchId], 2)[0];
  const rootMapId = rootRow && rootRow.root_map_id ? String(rootRow.root_map_id) : null;
  const visibleLocations =
    ctx.viewMode === 'pov' ? locations.filter((l) => visibility.visible('location', String(l.id))) : locations;
  const topology = resolveMapTopology({
    branchId: ctx.branchId,
    rootMapId,
    maxDepth: ATLAS_RUNTIME_LIMITS.locationDepth,
    maps: maps.map((m): TopologyMap => ({
      id: String(m.id),
      branchId: ctx.branchId,
      containerLocationId: m.container_location_id === null || m.container_location_id === undefined ? null : String(m.container_location_id),
      status: String(m.status ?? 'active'),
    })),
    locations: visibleLocations.map((l): TopologyLocation => ({
      id: String(l.id),
      branchId: ctx.branchId,
      kind: (l.kind === null || l.kind === undefined ? 'other' : String(l.kind)) as TopologyLocation['kind'],
      parentLocationId: l.parent_location_id === null || l.parent_location_id === undefined ? null : String(l.parent_location_id),
      anchorLocationId: l.anchor_location_id === null || l.anchor_location_id === undefined ? null : String(l.anchor_location_id),
      mobility: l.mobility === 'mobile' ? 'mobile' : 'fixed',
      mapId: l.map_id === null || l.map_id === undefined ? null : String(l.map_id),
      status: String(l.status ?? 'active'),
    })),
  });
  const topologyNodeById = new Map(topology.nodes.map((node) => [node.mapId, node]));
  /** 可见根图：author 用真实根图；POV 用「无容器顶图」里的第一张（顶图没有隐藏容器，公开安全）。 */
  const publicRootMapId =
    topology.nodes.find((node) => node.connectionQuality === 'root' && node.mapId === rootMapId)?.mapId ??
    topology.nodes.find((node) => node.connectionQuality === 'root')?.mapId ??
    null;
  const topologyCodesByMap = new Map<string, Set<string>>();
  for (const issue of topology.issues) {
    // POV 不下发任何可能与隐藏实体相关的诊断（拓扑已基于可见集合计算，这里再兜一道）。
    if (ctx.viewMode === 'pov') continue;
    const touched = new Set<string>([...(issue.mapId ? [issue.mapId] : []), ...(issue.relatedIds ?? [])]);
    if (issue.code === 'MAP_SELF_CONTAINED' && issue.mapId) touched.add(issue.mapId);
    // 地点级问题（父链环/缺父/自容器）归到「以该地点为容器的图」上，便于按图定位。
    if (issue.locationId) {
      for (const map of maps) {
        if (map.container_location_id !== null && map.container_location_id !== undefined && String(map.container_location_id) === issue.locationId) {
          touched.add(String(map.id));
        }
      }
    }
    // 未挂接/多根这类没有落到具体图的全局问题，归到根图那一行，避免整份响应只在 metadata 里可见。
    if (touched.size === 0 && publicRootMapId) touched.add(publicRootMapId);
    for (const mapId of touched) {
      const bucket = topologyCodesByMap.get(mapId) ?? new Set<string>();
      bucket.add(issue.code);
      topologyCodesByMap.set(mapId, bucket);
    }
  }
  const resolveNavigation = (mapId: string): { parentMapId: string | null; connectionQuality: ConnectionQuality } => {
    const node = topologyNodeById.get(mapId);
    if (!node) return { parentMapId: null, connectionQuality: 'invalid' };
    if (ctx.viewMode !== 'pov') {
      return { parentMapId: node.parentMapId, connectionQuality: node.connectionQuality };
    }
    // POV：坏图一律呈现为「挂可见根 + 未分类」，既不谎报结构也不泄露隐藏祖先。
    if (node.connectionQuality === 'invalid') {
      return { parentMapId: publicRootMapId === mapId ? null : publicRootMapId, connectionQuality: 'unclassified' };
    }
    return { parentMapId: node.parentMapId, connectionQuality: node.connectionQuality };
  };

  const routeIssues: Array<{ routeId: string; code: string; message: string }> = [];
  const items: MapViewItem[] = selected.map((map) => {
    const mapId = String(map.id);
    const points: MapViewItem['points'] = [];
    const coarseList: MapViewItem['coarseList'] = [];
    const container=map.container_location_id?locationById.get(String(map.container_location_id)):null;
    const leafScene=container && (container.kind==='room'||!locations.some(l=>l.parent_location_id===container.id))
      && !['region','city'].includes(String(container.kind));
    const frame=map.frame_json as {cols?:number;rows?:number} ?? {};
    const roomMembers=characters.filter(ch=>ch.location_id===container?.id && !['unknown','in_transit'].includes(resolveEffectivePosition(ctx,String(ch.id),undefined,positionCache).kind));
    const roomItems=itemRows.filter(item=>item.location_id===container?.id&&!item.holder_character_id&&!item.container_item_id);
    const layout=leafScene?scenePositions([...roomMembers.map(ch=>({id:String(ch.id),currentAction:String(ch.action_tendency??'')})),...roomItems.map(item=>({id:String(item.id),currentAction:String(item.description??'')}))],
      {cols:typeof frame.cols==='number'?frame.cols:100,rows:typeof frame.rows==='number'?frame.rows:100}):new Map();

    for (const loc of locations) {
      const locId = String(loc.id);
      if(loc.mobility==='mobile'){
        if(ctx.viewMode==='pov'&&loc.anchor_location_id&&!visibility.visible('location',String(loc.anchor_location_id)))continue;
        const position=resolveEffectivePosition(ctx,locId,undefined,positionCache);
        if(position.kind==='at_grid'&&position.mapId===mapId)points.push({entityId:locId,kind:'location',locationKind:String(loc.kind??''),mobility:'mobile',name:String(loc.name??''),mapId,x:position.x,y:position.y,precision:position.precision,radius:position.radius??null,markerQuality:position.precision});
        continue;
      }
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
        area:loc.area_geometry_json,
      });
    }

    for (const ch of characters) {
      const chId = String(ch.id);
      const position = resolveEffectivePosition({ db: ctx.db, branchId: ctx.branchId }, chId, undefined, positionCache);
      const locationId=position.kind==='at_location'?position.locationId:ch.location_id?String(ch.location_id):null;
      if (position.kind==='in_transit'||position.kind==='unknown') continue;
      const ownCoordinates=ch.map_id===mapId && ch.coord_precision!=='unknown' && typeof ch.grid_x==='number' && typeof ch.grid_y==='number';
      if (leafScene && locationId===container?.id && !ownCoordinates) {
        const pin=layout.get(chId)!;
        points.push({entityId:chId,kind:'character',name:String(ch.name),mapId,x:pin.x,y:pin.y,precision:'layout',radius:null,markerQuality:'layout',locationId,isProtagonist:ch.id===ctx.povId});
      } else if (ownCoordinates || position.kind === 'at_grid' && position.mapId === mapId) {
        const grid=ownCoordinates?{x:ch.grid_x as number,y:ch.grid_y as number,precision:String(ch.coord_precision)}:position.kind==='at_grid'?position:null;
        if(!grid)continue;
        points.push({
          entityId: chId,
          kind: 'character',
          name: String(ch.name ?? ''),
          mapId,
          x: grid.x,
          y: grid.y,
          precision: grid.precision,
          radius: typeof ch.uncertainty_radius_cells==='number'?ch.uncertainty_radius_cells:null,
          markerQuality: grid.precision as 'exact'|'approximate'|'layout',
          locationId,isProtagonist:ch.id===ctx.povId,
        });
      } else if (locationId) {
        // On broader maps aggregate at the nearest mapped ancestor, even when the
        // character has fine coordinates on an inner map. Never copy inner coordinates.
        const seen=new Set<string>();let loc=locationById.get(locationId);
        while(loc && !seen.has(String(loc.id))) {
          seen.add(String(loc.id));
          if(loc.map_id===mapId){coarseList.push({entityId:chId,name:String(ch.name),locationId:String(loc.id),locationName:String(loc.name)});break;}
          loc=loc.parent_location_id?locationById.get(String(loc.parent_location_id)):undefined;
        }
      }
    }

    for (const item of itemRows) {
      const itemId = String(item.id);
      if (item.holder_character_id || item.container_item_id) continue;
      const position = resolveEffectivePosition({ db: ctx.db, branchId: ctx.branchId }, itemId, undefined, positionCache);
      if(leafScene&&item.location_id===container?.id&&!(item.map_id===mapId&&item.coord_precision!=='unknown'&&item.grid_x!=null)){
        const pin=layout.get(itemId)!;
        points.push({entityId:itemId,kind:'item',name:String(item.name),mapId,x:pin.x,y:pin.y,precision:'layout',radius:null,markerQuality:'layout',locationId:String(container.id)});
        continue;
      }
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
          // M4/Q02：地面物品在网格上也要带归属地点，UI 才知道它属于哪个房间。
          locationId: item.location_id ? String(item.location_id) : null,
        });
      }
    }

    const mapRoutes = routes
      .filter((r) => (r.map_id ? String(r.map_id) === mapId : false))
      .map((r) => {
        const projected = projectRouteGeometry(r, mapId);
        if (projected.issue) routeIssues.push(projected.issue);
        return {
          routeId: String(r.id),
          fromId: String(r.from_location_id),
          toId: String(r.to_location_id),
          kind: String(r.kind),
          geometryQuality: String(r.geometry_quality ?? 'unknown'),
          distanceM: typeof r.distance_m === 'number' ? r.distance_m : null,
          dashed: String(r.geometry_quality) !== 'confirmed',
          allowedModes: Array.isArray(r.allowed_modes_json) ? (r.allowed_modes_json as string[]) : [],
          /** M4/Q02：可绘制几何（格坐标）或 null；unknown/坏几何一律 null，绝不画假线。 */
          geometry: projected.geometry,
          // M4/Q02：适配器按端点引用判断路线可见性（审查必修 2），不随 DTO 下发就只能在 POV 全砍。
          mapId,
          fromLocationId: String(r.from_location_id),
          toLocationId: String(r.to_location_id),
        };
      });

    const metersPerCell = typeof map.meters_per_cell === 'number' ? map.meters_per_cell : null;
    for(const point of points)point.hidden=!visibility.visible(point.kind,point.entityId);
    for(const entry of coarseList)entry.hidden=!visibility.visibleCharacters.has(entry.entityId);
    return {
      mapId,
      name: String(map.name ?? ''),
      kind: String(map.kind ?? 'world'),
      containerLocationId: map.container_location_id ? String(map.container_location_id) : null,
      containerLocationKind: container && (ctx.viewMode !== 'pov' || visibility.visible('location', String(container.id))) ? String(container.kind) : null,
      ...(function navigation() {
        const resolved = resolveNavigation(mapId);
        return {
          parentMapId: resolved.parentMapId,
          connectionQuality: resolved.connectionQuality,
          topologyIssueCodes: [...(topologyCodesByMap.get(mapId) ?? new Set<string>())].sort(),
        };
      })(),
      metersPerCell,
      scaleQuality: String(map.scale_quality ?? 'uncalibrated'),
      scaleLocked: Number(map.scale_locked ?? 0) === 1,
      calibrationRev: Number(map.calibration_rev ?? 1),
      backgroundAssetKey:map.background_asset_key?String(map.background_asset_key):null,
      defaultTerrain: String(map.default_terrain ?? 'unknown'),
      points:ctx.viewMode==='pov'?points.filter(point=>!point.hidden):points,
      coarseList:ctx.viewMode==='pov'?coarseList.filter(entry=>!entry.hidden):coarseList,
      routes: mapRoutes,
      frames: {
        // M4/Q02：POV/author 的普通地图响应都不含 atlasScene / atlasLayoutRequest。
        frame: publicMapFrame((map.frame_json ?? {}) as Record<string, unknown>),
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
      readLimits:Object.fromEntries([['maps',1001,maps.length],['locations',2000,locations.length],['characters',2000,characters.length],['items',2000,itemRows.length],['routes',1000,routes.length]].map(([table,limit,shown])=>{
        const total=Number(queryBound(ctx.db,`SELECT COUNT(*) n FROM ${table} WHERE branch_id=? AND status='active'`,[ctx.branchId])[0].n);
        return [table,{limit,total,shown,truncated:Math.max(0,total-Number(shown))}];
      })),
      pointCount: items.reduce((n, m) => n + (m as MapViewItem).points.length, 0),
      coarseCount: items.reduce((n, m) => n + (m as MapViewItem).coarseList.length, 0),
      viewMode: ctx.viewMode ?? 'author',
      /**
       * M2-05：作者视图给出完整坏图诊断（含未挂接地图清单），供 UI 在「未挂接地图」组里
       * 说明为什么某张图没挂上；POV 一律不下发，避免用父图标题/ID 泄密。
       */
      topologyIssues:
        ctx.viewMode === 'pov'
          ? []
          : topology.issues.map((issue) => ({
              code: issue.code,
              mapId: issue.mapId ?? null,
              locationId: issue.locationId ?? null,
              relatedIds: [...(issue.relatedIds ?? [])],
              severity: issue.severity,
              message: issue.message,
            })),
      unlinkedMapIds: ctx.viewMode === 'pov' ? [] : [...topology.unlinkedMapIds],
      publicRootMapId,
      /** M4/Q02：坏几何按路线逐条列出，方便定位是哪一条、为什么不能画。 */
      routeIssues,
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
  const entityId=query.entityId ?? ctx.povId;
  const cache=buildPositionCache(ctx);
  const target = entityId ? resolveEffectivePosition(ctx, entityId,undefined,cache) : { kind: 'unknown' as const };
  if (target.kind === 'unknown') {
    return { branchId: ctx.branchId, revision: ctx.revision, items: [], metadata: { reason: 'POSITION_UNKNOWN' } };
  }
  const here = target.kind === 'at_grid' ? target.mapId : target.kind === 'at_location' ? target.locationId : null;
  const characters = rows(ctx, 'characters', "status = 'active'", [], 1000);
  const directLocation=(id:string,p:ReturnType<typeof resolveEffectivePosition>):string|null=>{
    if(p.kind==='in_transit'||p.kind==='unknown')return null;
    if(p.kind==='at_location')return p.locationId;
    if(cache.locations?.has(id))return id;
    const character=cache.characters?.get(id);
    return character?.location_id?String(character.location_id):null;
  };
  const targetLocation=entityId?directLocation(entityId,target):null;
  const results: Array<Record<string, unknown>> = [];
  for (const ch of characters) {
    const id = String(ch.id);
    if (entityId && id === entityId) continue;
    const position = resolveEffectivePosition(ctx,id,undefined,cache);
    const locationId=directLocation(id,position);
    if(targetLocation && locationId===targetLocation) {
      results.push({entityId:id,name:String(ch.name??''),relevance:'same_location',positionQuality:position.kind==='at_grid'?position.precision:'coarse',
        locationId,locationName:String(cache.locations?.get(locationId)?.name??''),thought:ctx.viewMode==='author'?ch.thought:undefined,actionTendency:ctx.viewMode==='author'?ch.action_tendency:undefined});
    } else if (target.kind === 'at_grid' && position.kind === 'at_grid' && position.mapId === here && !targetLocation && !locationId) {
      const dx = position.x - target.x;
      const dy = position.y - target.y;
      // Sharing a continent/city map is not proof of proximity. Only uncontained
      // positions within this local grid radius qualify through coordinates.
      if(Math.hypot(dx,dy)>10)continue;
      results.push({
        entityId: id,
        name: String(ch.name ?? ''),
        relevance: 'same_map',
        positionQuality: position.precision,
        gridDistance: Math.sqrt(dx * dx + dy * dy),
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
  const visibility=ctx.viewMode==='pov'?sqlVisibility(ctx):null;

  if (kind === 'character') {
    const character = rows(ctx, 'characters', 'id = ?', [entityId], 1)[0];
    if (!character) return { branchId: ctx.branchId, revision: ctx.revision, items: [], metadata: { reason: 'ENTITY_UNKNOWN' } };
    if(visibility && entityId!==visibility.povId){
      if(!visibility.visibleCharacters.has(entityId)&&!visibility.knownCharacters.has(entityId))return {branchId:ctx.branchId,revision:ctx.revision,items:[],metadata:{reason:'POV_UNKNOWN'}};
      const seen=visibility.visibleCharacters.has(entityId);
      // M4/Q11：POV 看别人也只给「已知 + 当场可见」的字段；手持物品按可见集合过滤。
      const povHeld=rows(ctx,'items',"holder_character_id = ? AND status = 'active'",[entityId],200)
        .filter(entry=>visibility.visibleItems.has(String(entry.id)))
        .map(entry=>({id:entry.id,name:entry.name,kind:entry.kind}));
      return {branchId:ctx.branchId,revision:ctx.revision,items:[{kind,character:{id:entityId,name:character.name,...(seen?{location_id:character.location_id,physical_status:character.physical_status}:{})},
        relations:[],actions:[],journeys:[],heldItems:povHeld,knowledge:[],position:seen?resolveEffectivePosition(ctx,entityId):null,lastSeen:visibility.projection.lastSeen.filter(item=>item.entityId===entityId)}],metadata:{fieldLimited:true,currentPositionKnown:seen}};
    }
    const relations = rows(ctx, 'relations', 'subject_entity_id = ? OR object_entity_id = ?', [entityId, entityId], 200);
    const actions = rows(ctx, 'actions', 'actor_entity_id = ?', [entityId], 100);
    const journeys = rows(ctx, 'journeys', 'mover_entity_id = ?', [entityId], 20);
    // M4/Q11：人物库存（手持物品）单独列出——地面标点那边已经排除持有中的物品，两边不能互相冒充。
    const heldItems = rows(ctx, 'items', "holder_character_id = ? AND status = 'active'", [entityId], 200)
      .filter((entry) => !visibility || visibility.visibleItems.has(String(entry.id)))
      .map((entry) => (visibility ? { id: entry.id, name: entry.name, kind: entry.kind } : entry));
    const knowledge = rows(ctx, 'knowledge', 'knower_character_id = ?', [entityId], 200);
    const position = resolveEffectivePosition({ db: ctx.db, branchId: ctx.branchId }, entityId);
    return {
      branchId: ctx.branchId,
      revision: ctx.revision,
      items: [{ kind, character, relations, actions, journeys, heldItems, knowledge, position }],
      metadata: { counts: { relations: relations.length, actions: actions.length, journeys: journeys.length, heldItems: heldItems.length, knowledge: knowledge.length } },
    };
  }

  if (kind === 'location') {
    if(visibility&&!visibility.knownLocations.has(entityId))return {branchId:ctx.branchId,revision:ctx.revision,items:[],metadata:{reason:'POV_UNKNOWN'}};
    const location = rows(ctx, 'locations', 'id = ?', [entityId], 1)[0];
    if (!location) return { branchId: ctx.branchId, revision: ctx.revision, items: [], metadata: { reason: 'ENTITY_UNKNOWN' } };
    const children = rows(ctx, 'locations', 'parent_location_id = ?', [entityId], 200).filter(loc=>!visibility||visibility.knownLocations.has(String(loc.id)));
    const cache=buildPositionCache(ctx);
    const present = rows(ctx, 'characters', 'location_id = ? AND status = ?', [entityId, 'active'], 200)
      .filter(character=>!['in_transit','unknown'].includes(resolveEffectivePosition(ctx,String(character.id),undefined,cache).kind))
      .filter(character=>!visibility||visibility.visibleCharacters.has(String(character.id)))
      .map(character=>visibility?{id:character.id,name:character.name,location_id:character.location_id,physical_status:character.physical_status}:character);
    const events = rows(ctx, 'events', 'location_id = ?', [entityId], 200).filter(event=>!visibility||event.secrecy==='public'&&visibility.here===entityId&&event.status==='occurred');
    const fronts = visibility?[]:rows(ctx, 'rumor_fronts', 'location_id = ?', [entityId], 200);
    // M4/Q11：地面物品 = 直接落在本地点、且不在任何人/容器手里（手持与容器内不算地面）。
    const groundItems = rows(ctx, 'items', "location_id = ? AND status = 'active' AND holder_character_id IS NULL AND container_item_id IS NULL", [entityId], 200)
      .filter((entry) => !visibility || visibility.visibleItems.has(String(entry.id)))
      .map((entry) => (visibility ? { id: entry.id, name: entry.name, kind: entry.kind } : entry));
    // M4/Q11：子地图（同一地点可有多层楼层地图）与「在子地点里」的粗聚合在场名单。
    const childMaps = rows(ctx, 'maps', "container_location_id = ? AND status = 'active'", [entityId], 50)
      .map((map) => ({ mapId: String(map.id), name: String(map.name ?? ''), kind: String(map.kind ?? 'world') }));
    const childIds = new Set(children.map((child) => String(child.id)));
    const coarsePresent = rows(ctx, 'characters', "status = 'active'", [], 2000)
      .filter((character) => {
        const at = String(character.location_id ?? '');
        return at !== entityId && childIds.has(at);
      })
      .filter((character) => !['in_transit', 'unknown'].includes(resolveEffectivePosition(ctx, String(character.id), undefined, cache).kind))
      .filter((character) => !visibility || visibility.visibleCharacters.has(String(character.id)))
      .map((character) => ({ id: character.id, name: character.name, locationId: String(character.location_id) }));
    const position = resolveEffectivePosition({ db: ctx.db, branchId: ctx.branchId }, entityId);
    return {
      branchId: ctx.branchId,
      revision: ctx.revision,
      items: [{ kind, location:visibility?{id:location.id,name:location.name,kind:location.kind,parent_location_id:location.parent_location_id}:location,
        children:visibility?children.map(child=>({id:child.id,name:child.name,kind:child.kind})):children,
        present, coarsePresent, groundItems, childMaps,
        events:visibility?events.map(event=>({id:event.id,title:event.title,occurred_at_s:event.occurred_at_s})):events, fronts, position }],
      metadata: { counts: { children: children.length, present: present.length, coarsePresent: coarsePresent.length, groundItems: groundItems.length, childMaps: childMaps.length, events: events.length, fronts: fronts.length } },
    };
  }

  if (kind === 'item') {
    if(visibility&&!visibility.visibleItems.has(entityId))return {branchId:ctx.branchId,revision:ctx.revision,items:[],metadata:{reason:'POV_UNKNOWN'}};
    const item = rows(ctx, 'items', 'id = ?', [entityId], 1)[0];
    if (!item) return { branchId: ctx.branchId, revision: ctx.revision, items: [], metadata: { reason: 'ENTITY_UNKNOWN' } };
    const contained = rows(ctx, 'items', 'container_item_id = ?', [entityId], 200);
    const position = resolveEffectivePosition({ db: ctx.db, branchId: ctx.branchId }, entityId);
    return { branchId: ctx.branchId, revision: ctx.revision, items: [{ kind, item:visibility?{id:item.id,name:item.name,location_id:item.location_id,holder_character_id:item.holder_character_id}:item, contained:visibility?[]:contained, position }], metadata: {} };
  }

  if(visibility)return {branchId:ctx.branchId,revision:ctx.revision,items:[],metadata:{reason:'POV_UNKNOWN'}};
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
     WHERE t.branch_id = ? AND t.status IN ('committed','partial')
     ORDER BY t.clock_after_s DESC, t.created_wall_ms DESC, tc.sequence DESC LIMIT ?`,
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

const LOG_SECRET_KEY = /(api[_-]?key|authorization|token|secret|password|cookie|bearer|signature)/i;
const LOG_SECRET_VALUE = /(sk-[A-Za-z0-9]{6,}|Bearer\s+\S+|[A-Fa-f0-9]{32,})/;

/** M4/Q12：日志默认不带完整 response / 密钥类字段，脱敏后再落日志。 */
function redactForLog(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.map((entry) => redactForLog(entry, depth + 1));
  if (typeof value === 'string') return LOG_SECRET_VALUE.test(value) ? '[redacted]' : value.length > 2000 ? `${value.slice(0, 2000)}…[truncated]` : value;
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (LOG_SECRET_KEY.test(key) || key === 'response' || key === 'headers') {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = redactForLog(entry, depth + 1);
  }
  return out;
}

/** M4/Q12：把 partial/failed 回执里的组与问题摊平成日志条目（保留完整路径与依赖链）。 */
function receiptIssues(receipt: Record<string, unknown>, turnId: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const groups = Array.isArray(receipt.groups) ? (receipt.groups as Array<Record<string, unknown>>) : [];
  for (const group of groups) {
    const issues = Array.isArray(group.issues) ? (group.issues as Array<Record<string, unknown>>) : [];
    for (const issue of issues) {
      out.push({
        logId: `issue_${String(turnId)}_${out.length}`,
        kind: 'issue',
        turnId,
        groupId: String(group.groupId ?? ''),
        groupStatus: String(group.status ?? ''),
        operationId: String(group.operationId ?? issue.operationId ?? ''),
        code: String(issue.code ?? ''),
        path: String(issue.path ?? ''),
        message: String(issue.message ?? ''),
        entityId: issue.entityId === null || issue.entityId === undefined ? null : String(issue.entityId),
        severity: String(issue.severity ?? 'error'),
        retryable: issue.retryable === true,
        module: String(issue.module ?? group.module ?? ''),
        dependsOn: Array.isArray(group.dependsOn) ? group.dependsOn.map(String) : [],
      });
    }
  }
  return out;
}

/**
 * G11 queryDiagnostics：时间线筛选/分页/完整导出游标。
 * 分页 100 条不等于导出截断：导出全部匹配记录，超出留存范围明确给出 droppedCount。
 *
 * M4/Q12：
 * - 失败/部分回执**不再只取最新 50 轮**；用「稳定时间 + ID」游标一直翻到末页。
 * - 每轮把回执里的所有 groups/issues 摊平成独立日志条目（完整 path + 依赖链），一次三字段失败能看见三条路径。
 * - 变更记录与失败轮用两个独立游标命名空间，避免跨页重复导出同一条记录。
 */
export function queryDiagnostics(ctx: ViewContext, query: ViewQuery): ViewResult {
  const stale = staleResult(ctx, query.revision);
  if (stale) return stale;
  const limit = Math.max(1, Math.min(500, query.limit ?? 100));
  const rawCursor = typeof query.cursor === 'string' ? query.cursor : '';
  const changeCursor = rawCursor.startsWith('ch:') ? rawCursor.slice(3).split('|') : null;
  const failedCursor = rawCursor.startsWith('ft:') ? rawCursor.slice(3).split('|') : null;
  const legacyOffset = !changeCursor && !failedCursor && rawCursor && Number.isFinite(Number(rawCursor)) ? Number(rawCursor) : 0;
  const total = queryBound(
    ctx.db,
    `SELECT COUNT(*) AS n FROM turn_changes tc JOIN turns t ON t.id = tc.turn_id WHERE t.branch_id = ?`,
    [ctx.branchId],
  );
  const totalCount = Number(total[0]?.n ?? 0);
  const failedTotal = Number(
    queryBound(ctx.db, `SELECT COUNT(*) AS n FROM turns WHERE branch_id = ? AND status IN ('failed','partial')`, [ctx.branchId])[0]?.n ?? 0,
  );

  const changeParams: Array<string | number | null> = [ctx.branchId];
  let changeWhere = '';
  if (changeCursor) {
    changeWhere = ' AND (tc.turn_id > ? OR (tc.turn_id = ? AND tc.sequence > ?))';
    changeParams.push(changeCursor[0], changeCursor[0], Number(changeCursor[1] ?? 0));
  }
  const changes = failedCursor
    ? []
    : queryBound(
    ctx.db,
    `SELECT tc.id, tc.turn_id, tc.sequence, tc.group_id, tc.operation_id, tc.target_table, tc.target_row_id, tc.operation, tc.summary, tc.basis_json
     FROM turn_changes tc JOIN turns t ON t.id = tc.turn_id
     WHERE t.branch_id = ?${changeWhere} ORDER BY tc.turn_id, tc.sequence LIMIT ? OFFSET ?`,
    [...changeParams, limit, legacyOffset],
  );

  const failedParams: Array<string | number | null> = [ctx.branchId];
  let failedWhere = '';
  if (failedCursor) {
    failedWhere = ' AND (created_wall_ms < ? OR (created_wall_ms = ? AND id < ?))';
    failedParams.push(Number(failedCursor[0] ?? 0), Number(failedCursor[0] ?? 0), failedCursor[1] ?? '');
  }
  const failedTurns = changeCursor
    ? []
    : queryBound(
        ctx.db,
        `SELECT id, status, clock_after_s, created_wall_ms, receipt_json, attempts_json FROM turns WHERE branch_id = ? AND status IN ('failed','partial')${failedWhere}
         ORDER BY created_wall_ms DESC, id DESC LIMIT ?`,
        [...failedParams, limit],
      );

  const items: Array<Record<string, unknown>> = [];
  for (const c of changes) {
    items.push({
      logId: String(c.id),
      kind: 'change',
      turnId: String(c.turn_id),
      groupId: String(c.group_id),
      operationId: String(c.operation_id),
      table: String(c.target_table),
      rowId: String(c.target_row_id),
      operation: String(c.operation),
      summary: String(c.summary ?? ''),
      basis: redactForLog(safeJson(c.basis_json)),
    });
  }
  let issueCount = 0;
  for (const t of failedTurns) {
    const receipt = safeJson(t.receipt_json);
    const status = String(t.status ?? '');
    const issues = receiptIssues(receipt, String(t.id));
    issueCount += issues.length;
    items.push(
      {
        logId: `turn_${String(t.id)}`,
        kind: 'failed_turn',
        turnId: String(t.id),
        status,
        /** M4/Q12：coreCommitted 取真实回执，不由 HTTP 200 或页面状态推断。 */
        coreCommitted: receipt.coreCommitted === true || status === 'partial',
        receipt: redactForLog(receipt),
        attempts: redactForLog(safeJson(t.attempts_json)),
        issueCount: issues.length,
      },
      ...issues,
    );
  }

  const lastChange = changes[changes.length - 1];
  const lastFailed = failedTurns[failedTurns.length - 1];
  const changeReturned = legacyOffset + changes.length;
  const nextChangeCursor = lastChange && changes.length === limit ? `ch:${String(lastChange.turn_id)}|${String(lastChange.sequence)}` : undefined;
  const nextFailedCursor =
    lastFailed && failedTurns.length === limit ? `ft:${String(lastFailed.created_wall_ms)}|${String(lastFailed.id)}` : undefined;
  return {
    branchId: ctx.branchId,
    revision: ctx.revision,
    items,
    nextCursor: nextChangeCursor ?? nextFailedCursor,
    metadata: {
      totalCount,
      failedTurnTotal: failedTotal,
      returned: items.length,
      changeReturned: changes.length,
      failedReturned: failedTurns.length,
      issueCount,
      /** 「未取回」与「已丢失」是两件事：分页能翻到的只算 remaining，不算 dropped。 */
      remainingChanges: Math.max(0, totalCount - changeReturned),
      remainingFailedTurns: Math.max(0, failedTotal - (legacyOffset + failedTurns.length)),
      droppedCount: 0,
      pageSize: limit,
      retention: { changeTotal: totalCount, failedTurnTotal: failedTotal },
      /** 变更与失败轮两个游标分开导出，跨页不会重复同一条记录。 */
      nextChangeCursor,
      nextFailedCursor,
      /** 只有真的丢了记录才 false；分页没翻完依然是完整可导出。 */
      exportComplete: true,
      redacted: true,
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
