/** One immutable SQL read context supplies every panel, including legacy-shaped UI fields. */
import { queryBound } from './atlas-db-runtime.ts';
import { createTableReadPort, pageWhereRows } from './atlas-db-readport.ts';
import { queryMapView, queryNearby, queryChanges, queryDiagnostics, querySimulationView } from './atlas-db-views.ts';
// M4/Q08：只读口按明确键进 state.sqlViews；目录按需查询，不在 /state 预取整张目录。
import { querySpatialFlows } from './atlas-spatial-flow-views.ts';
import { parseFrame, querySpatialScene } from './atlas-spatial-views.ts';
import { queryTasks } from './atlas-task-views.ts';
// P14 §20.1：工作台建图状态（只读派生，不新增面板、不插聊天）。
import { readProgressRows } from './atlas-construction-progress.ts';
import { isLegacyConstructionRow, readWorldBuildTargets } from './atlas-world-build-state.ts';
import { buildWorkbenchStatus } from './atlas-workbench-status.ts';
import { resolveEffectivePosition, buildPositionCache } from './atlas-sim-position.ts';
import { toLegacyStateDto } from './atlas-db-state-adapter.ts';
import { resolveViewScope, seesInternalMonologue } from './atlas-player-view-scope.ts';
import type { ViewContext } from './atlas-db-views.ts';
import type { ViewQuery } from './atlas-ops-contract.ts';
import { readSceneContradictions } from './atlas-scene-contradiction-read.ts';
import { currentBuildJob } from './atlas-world-build-execution.ts';
import { readBuildAuditSummary } from './atlas-world-build-ledger.ts';

export function querySqlSceneState(ctx: ViewContext, query: {chatUid:string;worldUid:string;worldName:string;worldBuildRunning?:boolean;worldBuildBusy?:boolean}) {
  const table=createTableReadPort(ctx.db), branch=queryBound(ctx.db,'SELECT * FROM branches WHERE id=?',[ctx.branchId])[0];
  const locations=pageWhereRows(table,'locations',ctx.branchId,{status:'active'});
  const characters=pageWhereRows(table,'characters',ctx.branchId,{status:'active'});
  const items=pageWhereRows(table,'items',ctx.branchId,{status:'active'});
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
  // M4/Q08：scene 需要带 atlasScene 的原始 frame（map 视图已按 Q02 剥离），因此这里独立查一次；
  // flows 需要一个焦点地图，取主角所在图，否则退回第一张图。
  const playerPosition=player?position(String(player.id)):null;
  const focusMapId=playerPosition?.kind==='at_grid'?playerPosition.mapId:String((map.items as Array<{mapId:string}>)[0]?.mapId??'');
  const scene=querySpatialScene(viewContext,{...base,kind:'scene',mapId:focusMapId||undefined});
  const flows=querySpatialFlows(viewContext,{...base,kind:'flows',mapId:focusMapId||undefined});
  const tasks=queryTasks(viewContext,{...base,kind:'tasks'});
  /**
   * P14 §20.1：工作台建图状态。
   *
   * 三件事都在这里做完，界面只负责显示：
   * 1. 任务/目标从 `construction_progress` 的真实行解码，坏 payload 不会被当成 0；
   * 2. 「真实地图布局数量」按 `frame_json.atlasScene` 判定，与场景视图同一口径；
   * 3. 停止与集中重试只给计划（`actions`），入口仍由既有 runner 控制请求承担。
   * 失败/矛盾只进这里与诊断，**不插酒馆聊天**（`chatInjection` 恒 false）。
   */
  const buildStatus=(() => {
    try {
      const rows=readProgressRows(table,ctx.branchId);
      // 同一分支可能有多个历史 job：取最近一个仍在推进的，否则取最后一个（已完成/已暂停）。
      const job=currentBuildJob(ctx.db,ctx.branchId);
      const targets=job?readWorldBuildTargets(rows,job.id).values:[];
      const mapRows=queryBound(ctx.db,"SELECT frame_json FROM maps WHERE branch_id=? AND status='active'",[ctx.branchId]);
      const laidOut=mapRows.filter(raw=>{
        const frame=parseFrame(raw.frame_json);
        return !!frame&&frame['atlasScene']!==null&&typeof frame['atlasScene']==='object';
      }).length;
      const status=buildWorkbenchStatus({
        job,targets,
        draining:query.worldBuildBusy===true&&query.worldBuildRunning!==true,
        windowActive:query.worldBuildBusy===true,
        auditSummary:job?readBuildAuditSummary(ctx.db,ctx.branchId,job.id):null,
        maps:{registered:mapRows.length,laidOut},
        sourceScanComplete:job?targets.filter(t=>t.workKind==='source-scan').every(t=>t.status==='done'):false,
        settlementPlansExpanded:job?targets.filter(t=>t.workKind==='settlement-plan').every(t=>t.status==='done'):false,
        legacyRowCount:rows.filter(isLegacyConstructionRow).length,
        contradictions:readSceneContradictions(ctx.db,ctx.branchId).map(entry=>({issueId:entry.issueId,objectId:entry.objectId,code:entry.code,message:entry.message,floorRef:entry.turnId,occurrences:1})),
      });
      if(query.worldBuildRunning&&status.job?.status==='running'){status.job.label='建设运行中';status.job.waitingForTrigger=false;}
      return status;
    } catch {
      // 读不到建设行不是致命错误：工作台显示「无建图状态」，世界照常可读。
      return null;
    }
  })();
  /** 目录不预取：UI 自己带 cursor/entityKind/q 调 queryView，避免一次拉整张表。 */
  const catalogBase:ViewQuery={...base,kind:'catalog'};
  const compatible=toLegacyStateDto(map,mapQuery);
  const nearbyIds=new Set(nearby.items.map(raw=>String((raw as {entityId:string}).entityId)));
  const npcs=characters.map(row=>{
    const id=String(row.id), locationId=resolvedLocation(row),p=position(id);
    // P08 §14.6/§14.7：NPC 当前位置与已记录行动对玩家可见；后台想法只有作者可见。
    const monologue=seesInternalMonologue(ctx.viewMode);
    return {id,name:String(row.name),isProtagonist:id===povId,presence:'present',locationId,pointId:locationId,
      locationName:locationId?String(locationById.get(locationId)?.name??''):null,pointName:locationId?String(locationById.get(locationId)?.name??''):null,
      thought:monologue?String(row.thought??''):'',actionTendency:String(row.action_tendency??''),currentAction:String(row.action_tendency??''),
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
    // P08 §14.9：作用域随状态一起下发，UI 与缓存都不许自己猜「这是玩家还是作者」。
    viewScope:resolveViewScope(ctx.viewMode),
    currentTime:Number(branch?.clock_s??0),currentLocationId,npcDirectory:npcs,objectDirectory:objects,relevantNpcIds:[...nearbyIds],
    map:{...mapState,pointParents:Object.fromEntries(locations.map(row=>[String(row.id),row.parent_location_id]))},
    tableMap:{...tableMap,nearby:{entries:npcs,total:counts.characters,truncated:counts.characters-npcs.length},objects:{entries:objects,total:counts.items,truncated:counts.items-objects.length},
      locations:{entries:locationsDto,total:counts.locations,truncated:counts.locations-locations.length},unplacedLocations:{entries:unplaced,total:unplaced.length,truncated:counts.locations-locations.length},
      locationOccupants:{entries:occupants,total:occupants.length,truncated:0},current:{locationId:currentLocationId,chain,position:player?position(String(player.id)):null}},
    sqlViews:{map,nearby,changes,diagnostics,simulation,scene,flows,tasks},catalogBase,changes:changes.items,simulationView:simulation.items[0]??null,
    /** P14 §20.1：工作台建图状态。null = 读不到，界面显示「无」而不是伪造 0/0。 */
    buildStatus,
    sqlMode:true,coreSaved:false,readLimits:{limit:null,pageSize:500,complete:true,counts,truncated:Object.fromEntries(Object.keys(counts).map(key=>[key,0]))}};
}
