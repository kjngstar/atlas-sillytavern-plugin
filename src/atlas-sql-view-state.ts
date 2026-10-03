/** One immutable SQL read context supplies every panel, including legacy-shaped UI fields. */
import { queryBound } from './atlas-db-runtime.ts';
import { createTableReadPort } from './atlas-db-readport.ts';
import { queryMapView, queryNearby, queryChanges, queryDiagnostics, querySimulationView } from './atlas-db-views.ts';
import { resolveEffectivePosition, buildPositionCache } from './atlas-sim-position.ts';
import { toLegacyStateDto } from './atlas-db-state-adapter.ts';
import type { ViewContext } from './atlas-db-views.ts';
import type { ViewQuery } from './atlas-ops-contract.ts';

export function querySqlSceneState(ctx: ViewContext, query: {chatUid:string;worldUid:string;worldName:string}) {
  const table=createTableReadPort(ctx.db), branch=queryBound(ctx.db,'SELECT * FROM branches WHERE id=?',[ctx.branchId])[0];
  const locations=table.selectWhere('locations',{branch_id:ctx.branchId,status:'active'},1000);
  const characters=table.selectWhere('characters',{branch_id:ctx.branchId,status:'active'},1000);
  const items=table.selectWhere('items',{branch_id:ctx.branchId,status:'active'},1000);
  const counts=Object.fromEntries(['locations','characters','items'].map(name=>[name,Number(queryBound(ctx.db,`SELECT COUNT(*) AS n FROM ${name} WHERE branch_id=? AND status='active'`,[ctx.branchId])[0].n)]));
  const uniquePov=characters.filter(c=>c.role==='protagonist');
  const povId=ctx.povId ?? (branch?.pov_character_id?String(branch.pov_character_id):uniquePov.length===1?String(uniquePov[0].id):undefined);
  const cache=buildPositionCache(ctx), locationById=new Map(locations.map(l=>[String(l.id),l]));
  const position=(id:string)=>resolveEffectivePosition(ctx,id,undefined,cache);
  const resolvedLocation=(row:Record<string,unknown>):string|null=>{
    const p=position(String(row.id));
    if(p.kind==='unknown'||p.kind==='in_transit')return null;
    if(p.kind==='at_location')return p.locationId;
    return row.location_id?String(row.location_id):null;
  };
  const player=characters.find(c=>c.id===povId), currentLocationId=player?resolvedLocation(player):null;
  const chain:Array<{id:string;name:string}>=[],visited=new Set<string>();
  for(let id=currentLocationId;id&&!visited.has(id);){
    visited.add(id);const row=locationById.get(id);if(!row)break;
    chain.push({id,name:String(row.name)});id=row.parent_location_id?String(row.parent_location_id):null;
  }
  const viewContext={...ctx,povId}, base={branchId:ctx.branchId,revision:ctx.revision,povId,viewMode:ctx.viewMode??'author'} as const;
  const mapQuery:ViewQuery={...base,kind:'map'}, map=queryMapView(viewContext,mapQuery);
  const nearby=queryNearby(viewContext,{...base,kind:'nearby',entityId:povId,limit:500});
  const changes=queryChanges(viewContext,{...base,kind:'changes'}),diagnostics=queryDiagnostics(viewContext,{...base,kind:'diagnostics'}),simulation=querySimulationView(viewContext,{...base,kind:'simulation'});
  const compatible=toLegacyStateDto(map,mapQuery);
  const nearbyIds=new Set(nearby.items.map(raw=>String((raw as {entityId:string}).entityId)));
  const npcs=characters.map(row=>{
    const id=String(row.id), locationId=resolvedLocation(row),p=position(id);
    return {id,name:String(row.name),isProtagonist:id===povId,presence:'present',locationId,pointId:locationId,
      locationName:locationId?String(locationById.get(locationId)?.name??''):null,pointName:locationId?String(locationById.get(locationId)?.name??''):null,
      thought:String(row.thought??''),actionTendency:String(row.action_tendency??''),currentAction:String(row.action_tendency??''),
      identity:String(row.identity??''),description:String(row.description??''),importance:row.importance,physicalStatus:row.physical_status,
      mapId:p.kind==='at_grid'?p.mapId:null,x:p.kind==='at_grid'?p.x:null,y:p.kind==='at_grid'?p.y:null,
      positionQuality:p.kind==='at_grid'?p.precision:p.kind==='at_location'?'coarse':p.kind==='in_transit'?p.quality:'unknown',
      positionSource:'sql',position:p,isNear:nearbyIds.has(id),reason:nearbyIds.has(id)?'sameLocation':'knownElsewhere',recentNarratives:[]};
  });
  const objects=items.map(row=>{const id=String(row.id),locationId=resolvedLocation(row),p=position(id);return {
    id,name:String(row.name),type:'item',description:String(row.description??''),locationId,pointId:locationId,
    pointName:locationId?String(locationById.get(locationId)?.name??''):null,holderCharacterId:row.holder_character_id,containerItemId:row.container_item_id,
    x:p.kind==='at_grid'?p.x:null,y:p.kind==='at_grid'?p.y:null,positionQuality:p.kind==='at_grid'?p.precision:p.kind==='at_location'?'coarse':'unknown',positionSource:'sql'};});
  const occupants=locations.map(row=>({locationId:String(row.id),locationName:String(row.name),
    characterIds:npcs.filter(c=>c.locationId===row.id).map(c=>c.id),objectIds:objects.filter(i=>i.locationId===row.id&&!i.holderCharacterId&&!i.containerItemId).map(i=>i.id)}))
    .map(row=>({...row,characterCount:row.characterIds.length,objectCount:row.objectIds.length}));
  const tableMap=compatible.tableMap as Record<string,unknown>,mapState=compatible.map as Record<string,unknown>;
  const unplaced=locations.filter(row=>row.grid_x===null||row.grid_y===null||row.coord_precision==='unknown').map(row=>({id:String(row.id),name:String(row.name),parentLocationId:row.parent_location_id}));
  const locationsDto=locations.map(row=>({id:String(row.id),name:String(row.name),parentLocationId:row.parent_location_id,kind:row.kind,description:row.description,mapId:row.map_id}));
  return {...compatible,...query,chatId:query.chatUid,worldId:query.worldUid,revision:ctx.revision,branchId:ctx.branchId,
    currentTime:Number(branch?.clock_s??0),currentLocationId,npcDirectory:npcs,objectDirectory:objects,relevantNpcIds:[...nearbyIds],
    map:{...mapState,pointParents:Object.fromEntries(locations.map(row=>[String(row.id),row.parent_location_id]))},
    tableMap:{...tableMap,nearby:{entries:npcs,total:counts.characters,truncated:counts.characters-npcs.length},objects:{entries:objects,total:counts.items,truncated:counts.items-objects.length},
      locations:{entries:locationsDto,total:counts.locations,truncated:counts.locations-locations.length},unplacedLocations:{entries:unplaced,total:unplaced.length,truncated:counts.locations-locations.length},
      locationOccupants:{entries:occupants,total:occupants.length,truncated:0},current:{locationId:currentLocationId,chain,position:player?position(String(player.id)):null}},
    sqlViews:{map,nearby,changes,diagnostics,simulation},changes:changes.items,simulationView:simulation.items[0]??null,
    sqlMode:true,coreSaved:false,readLimits:{limit:1000,counts,truncated:Object.fromEntries(Object.entries(counts).map(([key,total])=>[key,Math.max(0,total-1000)]))}};
}
