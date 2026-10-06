import {buildLayoutContext} from './host-context.mjs';
import {generateFloor,generateCity} from './generation.mjs';
import {buildSceneMutation,sceneLocationGeometry} from './storage.mjs';
import {clone,finite,diagnostic,failure,stable} from './contracts.mjs';
/** Compile one layout request to the existing AtomicGroup shape. No database writes. */
export function compileSceneGroup({request,scope,currentScope,mapRow,locations,characters,items,turnId,operationId}={}){
  try{
  if(!['floor','city'].includes(request?.kind))return failure('LAYOUT_KIND_UNSUPPORTED','$.request.kind','使用 floor/city；其他空间沿用现有轮廓');
  const built=buildLayoutContext({scope,mapRow,locations,characters,items});if(!built.ok)return built;
  const ctx={...built.context,currentScope},spec=clone(request.spec),membershipIssues=[];
  if(request.kind==='floor'){
    const chars=new Map((characters??[]).filter(c=>c.branch_id===scope.branchId&&c.status==='active').map(c=>[c.id,c]));
    const groundItems=new Map((items??[]).filter(i=>i.branch_id===scope.branchId&&i.status==='active'&&!i.holder_character_id&&!i.container_item_id).map(i=>[i.id,i]));
    const groups=new Map((spec.contents??[]).map(g=>[g.id,g]));
    spec.actors=(spec.actors??[]).filter(a=>{
      const allowed=chars.get(a.id)?.location_id===a.roomId;
      if(!allowed)membershipIssues.push(diagnostic('ACTOR_LOCATION_MISMATCH','$.actors.roomId','当前 SQL 位置不在此房间，保留名单与真实位置',{entityId:a.id,severity:'warning'}));return allowed;
    });
    spec.items=(spec.items??[]).filter(i=>{
      const actual=groundItems.get(i.id),group=groups.get(i.on),allowed=!!actual&&!!group&&actual.location_id===group.roomId;
      if(!allowed)membershipIssues.push(diagnostic('ITEM_LOCATION_MISMATCH','$.items.on','物品不在该房间或已被持有，不能画作地面物品',{entityId:i.id,severity:'warning'}));return allowed;
    });
  }
  const result=request.kind==='floor'?generateFloor(spec,ctx):generateCity(spec,ctx);
  if(!result.ok)return result;
  result.issues.push(...membershipIssues);
  const prepared=buildSceneMutation({result,mapRow,scope,currentScope,turnId,operationId,expectedRowRev:mapRow.row_rev});if(!prepared.ok)return prepared;
  const mutations=prepared.mutation?[prepared.mutation]:[],readSet=[{table:'maps',rowId:mapRow.id,rowRev:mapRow.row_rev}],issues=[...result.issues],byId=new Map((locations??[]).filter(l=>l.branch_id===scope.branchId).map(l=>[l.id,l]));
  for(const geo of sceneLocationGeometry(result.scene)){
    const before=byId.get(geo.entityId);if(!before)return failure('LOCATION_REF_UNKNOWN','$.locations','场景引用的地点未在候选数据库建档');
    if(before.map_id!==mapRow.id)return failure('LOCATION_MAP_MISMATCH','$.locations.map_id','不能通过摆放把地点迁移到另一地图');
    if(before.coord_precision==='exact'&&finite(before.grid_x)&&finite(before.grid_y)&&(Math.abs(before.grid_x-geo.gridX)>1e-6||Math.abs(before.grid_y-geo.gridY)>1e-6))return failure('LOCATION_GEOMETRY_LOCK_CONFLICT','$.locations','当前模板无法满足已确认的地点坐标；保留原场景',{entityId:before.id});
    const area=typeof before.area_geometry_json==='string'?JSON.parse(before.area_geometry_json):before.area_geometry_json;
    if(area?.quality==='confirmed'&&geo.area.quality!=='confirmed')return failure('CONFIRMED_AREA_LOCKED','$.locations.area_geometry_json','不能用示意轮廓覆盖作者确认的范围');
    const after={...clone(before),grid_x:geo.gridX,grid_y:geo.gridY,coord_precision:before.coord_precision==='exact'?'exact':geo.precision,area_geometry_json:geo.area};
    if(stable([before.grid_x,before.grid_y,before.coord_precision,area])===stable([after.grid_x,after.grid_y,after.coord_precision,after.area_geometry_json]))continue;
    after.row_rev=before.row_rev+1;after.updated_turn_id=turnId;
    mutations.push({table:'locations',rowId:before.id,before:clone(before),after,sourceOpIds:[operationId],basis:{kind:'layout',mapId:mapRow.id,quality:geo.precision}});readSet.push({table:'locations',rowId:before.id,rowRev:before.row_rev});
  }
  return {ok:true,status:mutations.length?'prepared':'duplicate',scene:result.scene,issues,group:mutations.length?{id:'layout:'+operationId,opIds:[operationId],dependsOn:[],readSet,mutations}:null};
  }catch(e){return failure('SCENE_COMPILE_FAILED','$','无法编译场景变更，原行未修改',{detailCode:String(e.message)});}
}
