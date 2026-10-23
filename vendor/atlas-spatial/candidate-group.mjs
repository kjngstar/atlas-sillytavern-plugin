import {buildLayoutContext} from './host-context.mjs';
import {generateFloor,generateCity,generateOverview} from './generation.mjs';
import {buildSceneMutation,sceneLocationGeometry,canonicalForScene} from './storage.mjs';
import {projectChildFurnishing} from './space-projection.mjs';
import {clone,finite,plain,diagnostic,failure,stable,parseSpaceLocalId,FRAME_SPACE_CANONICAL_KEY,SPACE_CANONICAL_MAX_FURNISHING,bytes,LIMITS,readMetricDimensions} from './contracts.mjs';
const GENERATORS={floor:generateFloor,city:generateCity,overview:generateOverview};
/** Compile one layout request to the existing AtomicGroup shape. No database writes. */
export function compileSceneGroup({request,scope,currentScope,mapRow,locations,characters,items,routes=[],maps=[],turnId,operationId,spaceSize=null,childSpaces={},autoPlan=false,planningProjection=false}={}){
  try{
  const generate=GENERATORS[request?.kind];
  if(!generate)return failure('LAYOUT_KIND_UNSUPPORTED','$.request.kind','使用 floor/city/overview；其他空间沿用现有轮廓');
  const built=buildLayoutContext({scope,mapRow,maps,locations,characters,items,routes});if(!built.ok)return built;
  const dimensionFacts=Object.fromEntries((locations??[]).filter(l=>l.branch_id===scope.branchId&&l.status==='active'&&l.map_id===mapRow.id).flatMap(l=>{
    const area=typeof l.area_geometry_json==='string'?JSON.parse(l.area_geometry_json):l.area_geometry_json;
    const size=area?.quality==='confirmed'?readMetricDimensions(area):null;
    return size?[[l.id,{...size,quality:'confirmed',source:'author'}]]:[];
  }));
  const ctx={...built.context,currentScope,childSpaces:{...childSpaces,...dimensionFacts},autoPlan,planningProjection},spec=clone(request.spec),membershipIssues=[];
  // P12/R03 §19.2：宿主解析出的尺寸权威（按「作者确认 → canonical → 父图足迹 → 首次估计」的顺序）
  // 是**本轮生成的物理依据**。发生确认矛盾时宿主选的是作者事实，而 frame 里的 canonical 可能还是
  // 待裁决的旧事实 —— 生成器不能拿旧账本去画新图（那会画出另一个物理尺寸，等于发布半边变化）。
  if(spaceSize&&plain(spaceSize.resolution))ctx.spaceSize={widthM:spaceSize.resolution.widthM,heightM:spaceSize.resolution.heightM,source:spaceSize.resolution.source,quality:spaceSize.resolution.quality,locked:spaceSize.canonical?.size?.locked};
  if(request.kind==='floor'){
    ctx.childCanonical=Object.fromEntries(maps.filter(m=>m.branch_id===scope.branchId&&m.status==='active'&&locations.some(l=>l.id===m.container_location_id&&l.map_id===mapRow.id)).flatMap(m=>{const frame=typeof m.frame_json==='string'?JSON.parse(m.frame_json):m.frame_json,record=frame?.[FRAME_SPACE_CANONICAL_KEY];return record?.version===1&&record.locationId===m.container_location_id&&record.furnishing?.length<=SPACE_CANONICAL_MAX_FURNISHING?[[record.locationId,record]]:autoPlan?[[String(m.container_location_id),{furnishing:[]}]]:[];}));
    ctx.itemsById=Object.fromEntries((items??[]).filter(i=>i.branch_id===scope.branchId&&i.status==='active'&&!i.holder_character_id&&!i.container_item_id).map(i=>[i.id,i]));
    if(autoPlan){
      const delegated=new Set();
      spec.contents=(spec.contents??[]).filter(row=>{
        const owner=locations.find(l=>l.branch_id===scope.branchId&&l.id===row.roomId);
        const nested=locations.some(l=>l.branch_id===scope.branchId&&l.status==='active'&&l.parent_location_id===row.roomId&&(owner?.kind!=='room'||l.kind!=='other'));
        const known=(ctx.childCanonical[row.roomId]?.furnishing??[]).some(f=>(parseSpaceLocalId(f.localId)?.contentId??f.localId)===(parseSpaceLocalId(row.id)?.contentId??row.id))||(ctx.previousScene?.constraints?.contents??[]).some(f=>f.id===row.id&&f.roomId===row.roomId);
        const supported=(spec.items??[]).some(i=>i.on===row.id&&ctx.itemsById[i.id]?.location_id===row.roomId);
        if(!nested||known||supported||row.additional===true)return true;
        delegated.add(row.id);membershipIssues.push(diagnostic('FURNISHING_DETAIL_DELEGATED','$.contents','该容器包含下级空间；新估计陈设应在实际房间中生成，不另登记一套容器家具',{entityId:row.id,severity:'warning'}));return false;
      });
      spec.actors=(spec.actors??[]).map(a=>{if(!delegated.has(a.near))return a;const next={...a};delete next.near;return next;});
    }
    for(const [room,canonical] of Object.entries(ctx.childCanonical)){
      if(!canonical.furnishing.length)continue;
      const registered=new Set(canonical.furnishing.map(entry=>parseSpaceLocalId(entry.localId)?.contentId));
      // A valid constraint can precede its drawable placement. Retrying that
      // same saved identity must not be mistaken for creating another object.
      for(const row of ctx.previousScene?.constraints?.contents??[])if(row.roomId===room)registered.add(parseSpaceLocalId(row.id)?.contentId??row.id);
      const knownItems=new Set(canonical.furnishing.map(entry=>entry.itemId).filter(Boolean));
      const supported=new Set((spec.items??[]).filter(i=>ctx.itemsById[i.id]?.location_id===room&&!knownItems.has(i.id)).map(i=>i.on));
      const unknown=(spec.contents??[]).filter(row=>row.roomId===room&&!registered.has(parseSpaceLocalId(row.id)?.contentId??row.id)&&row.additional!==true&&!supported.has(row.id));
      if(unknown.length)return {...failure('FURNISHING_ID_UNREGISTERED','$.contents','父图必须复用子空间账本中的陈设 ID；只有明确新增才使用 additional=true',{kept:ctx.previousScene?clone(ctx.previousScene):null}),issues:unknown.map(row=>diagnostic('FURNISHING_ID_UNREGISTERED','$.contents','此子空间已有陈设，不能换 ID 重复添加',{entityId:row.id}))};
    }
    projectChildFurnishing(spec,ctx);
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
  const result=generate(spec,ctx);
  if(!result.ok)return result;
  result.issues.push(...membershipIssues);
  const prepared=buildSceneMutation({result,mapRow,scope,currentScope,turnId,operationId,expectedRowRev:mapRow.row_rev,spaceSize});if(!prepared.ok)return prepared;
  const mutations=prepared.mutation?[prepared.mutation]:[],readSet=[{table:'maps',rowId:mapRow.id,rowRev:mapRow.row_rev}],issues=[...result.issues],byId=new Map((locations??[]).filter(l=>l.branch_id===scope.branchId).map(l=>[l.id,l]));
  for(const geo of sceneLocationGeometry(result.scene)){
    // The container is drawn inside its own child map without moving its parent-map pin.
    if(geo.entityId===mapRow.container_location_id)continue;
    const before=byId.get(geo.entityId);if(!before)return failure('LOCATION_REF_UNKNOWN','$.locations','场景引用的地点未在候选数据库建档');
    // 合法代理入口（坐标留在另一张旧图、无 transform）已由 sceneLocationGeometry 过滤，只在场景里绘制；
    // 走到这里的跨图引用不是代理，属于真的错位，仍必须失败并保留原场景。
    if(before.map_id!==mapRow.id)return failure('LOCATION_MAP_MISMATCH','$.locations.map_id','不能通过摆放把地点迁移到另一地图',{entityId:before.id});
    if(before.coord_precision==='exact'&&finite(before.grid_x)&&finite(before.grid_y)&&(Math.abs(before.grid_x-geo.gridX)>1e-6||Math.abs(before.grid_y-geo.gridY)>1e-6))return failure('LOCATION_GEOMETRY_LOCK_CONFLICT','$.locations','当前模板无法满足已确认的地点坐标；保留原场景',{entityId:before.id});
    const area=typeof before.area_geometry_json==='string'?JSON.parse(before.area_geometry_json):before.area_geometry_json;
    const dimensions=area?.quality==='confirmed'?readMetricDimensions(area):null;
    if(area?.quality==='confirmed'&&!dimensions&&geo.area.quality!=='confirmed')return failure('CONFIRMED_AREA_LOCKED','$.locations.area_geometry_json','不能用示意轮廓覆盖作者确认的范围');
    // A confirmed size is independent of placement. Keep it verbatim; the scene
    // owns the estimated footprint, and the child canonical shares this size.
    const after={...clone(before),grid_x:geo.gridX,grid_y:geo.gridY,coord_precision:before.coord_precision==='exact'?'exact':geo.precision,area_geometry_json:dimensions?clone(area):geo.area};
    if(stable([before.grid_x,before.grid_y,before.coord_precision,area])===stable([after.grid_x,after.grid_y,after.coord_precision,after.area_geometry_json]))continue;
    after.row_rev=before.row_rev+1;after.updated_turn_id=turnId;
    mutations.push({table:'locations',rowId:before.id,before:clone(before),after,sourceOpIds:[operationId],basis:{kind:'layout',mapId:mapRow.id,quality:geo.precision}});readSet.push({table:'locations',rowId:before.id,rowRev:before.row_rev});
  }
  for(const room of [...(result.scene.layout.rooms??[]),...(result.scene.layout.corridor?.entityId?[{...result.scene.layout.corridor,id:result.scene.layout.corridor.entityId}]:[])]){
    if(room.placement==='proxy')continue;
    if(room.id===mapRow.container_location_id)continue;
    const holders=maps.filter(m=>m.branch_id===scope.branchId&&m.status==='active'&&m.container_location_id===room.id);
    if(holders.length!==1)continue;
    const before=holders[0],frame=typeof before.frame_json==='string'?JSON.parse(before.frame_json):clone(before.frame_json),previous=frame[FRAME_SPACE_CANONICAL_KEY];
    // The child establishes its initial authority through its own size resolver.
    // A first parent sketch must not replace that with an estimated outline.
    if((!plain(previous)||previous.version!==1||previous.locationId!==room.id)&&!autoPlan)continue;
    const projection={...result.scene,layout:{...result.scene.layout,bounds:{x:0,y:0,w:room.w,h:room.h}}};
    const next=canonicalForScene(projection,previous,room.id,null,result.deletedContents);
    if(next.furnishing.length>SPACE_CANONICAL_MAX_FURNISHING||next.droppedPrev>0)return failure('SPACE_FURNISHING_DEFERRED','$.childSpaces','子空间陈设超出预算，保留父子原记录');
    if(stable(next)===stable(previous??null))continue;
    frame[FRAME_SPACE_CANONICAL_KEY]=next;delete frame.atlasLayoutContext;
    if(bytes(frame)>LIMITS.sceneBytes+65536)return failure('FRAME_TOO_LARGE','$.childSpaces','子空间账本超出框架预算，保留父子原记录');
    mutations.push({table:'maps',rowId:before.id,before:clone(before),after:{...clone(before),frame_json:frame,row_rev:before.row_rev+1,updated_turn_id:turnId},sourceOpIds:[operationId],basis:{kind:'layout',mapId:mapRow.id,quality:'layout',spaceId:room.id}});
    readSet.push({table:'maps',rowId:before.id,rowRev:before.row_rev});
  }
  return {ok:true,status:mutations.length?'prepared':'duplicate',scene:result.scene,issues,group:mutations.length?{id:'layout:'+operationId,opIds:[operationId],dependsOn:[],readSet,mutations}:null};
  }catch(e){return failure('SCENE_COMPILE_FAILED','$','无法编译场景变更，原行未修改',{detailCode:String(e.message)});}
}
