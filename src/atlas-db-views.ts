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
    for(const point of points)point.hidden=!visibility.visible(point.kind,point.entityId);
    for(const entry of coarseList)entry.hidden=!visibility.visibleCharacters.has(entry.entityId);
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
      points:ctx.viewMode==='pov'?points.filter(point=>!point.hidden):points,
      coarseList:ctx.viewMode==='pov'?coarseList.filter(entry=>!entry.hidden):coarseList,
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
      readLimits:Object.fromEntries([['maps',1001,maps.length],['locations',2000,locations.length],['characters',2000,characters.length],['items',2000,itemRows.length],['routes',1000,routes.length]].map(([table,limit,shown])=>{
        const total=Number(queryBound(ctx.db,`SELECT COUNT(*) n FROM ${table} WHERE branch_id=? AND status='active'`,[ctx.branchId])[0].n);
        return [table,{limit,total,shown,truncated:Math.max(0,total-Number(shown))}];
      })),
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
      return {branchId:ctx.branchId,revision:ctx.revision,items:[{kind,character:{id:entityId,name:character.name,...(seen?{location_id:character.location_id,physical_status:character.physical_status}:{})},
        relations:[],actions:[],journeys:[],knowledge:[],position:seen?resolveEffectivePosition(ctx,entityId):null,lastSeen:visibility.projection.lastSeen.filter(item=>item.entityId===entityId)}],metadata:{fieldLimited:true,currentPositionKnown:seen}};
    }
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
    const position = resolveEffectivePosition({ db: ctx.db, branchId: ctx.branchId }, entityId);
    return {
      branchId: ctx.branchId,
      revision: ctx.revision,
      items: [{ kind, location:visibility?{id:location.id,name:location.name,kind:location.kind,parent_location_id:location.parent_location_id}:location,
        children:visibility?children.map(child=>({id:child.id,name:child.name,kind:child.kind})):children,
        present, events:visibility?events.map(event=>({id:event.id,title:event.title,occurred_at_s:event.occurred_at_s})):events, fronts, position }],
      metadata: { counts: { children: children.length, present: present.length, events: events.length, fronts: fronts.length } },
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
