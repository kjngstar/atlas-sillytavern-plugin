import {normalizeScope,finite,plain,diagnostic,failure,parseSpaceLocalId,FRAME_SPACE_CANONICAL_KEY,SPACE_CANONICAL_MAX_FURNISHING} from './contracts.mjs';
import {readSceneFrame} from './storage.mjs';
import {collectMapLocations} from './map-membership.mjs';

/**
 * P12/R03 §19.1：读取本图持有的空间权威（`SpaceCanonicalV1`）。
 *
 * 身份必须是**本图的容器地点**：`locationId !== mapRow.container_location_id` 时一律不采用
 * （宁缺勿乱 —— 短引用、地图标题、别图的空间都不当身份）。结构损坏同样不采用。
 */
function readSpaceCanonical(raw,locationId){
  if(!locationId||!plain(raw)||raw.version!==1||raw.locationId!==locationId)return null;
  const size=plain(raw.size)&&finite(raw.size.widthM)&&finite(raw.size.heightM)&&raw.size.widthM>0&&raw.size.heightM>0
    ?{widthM:raw.size.widthM,heightM:raw.size.heightM,quality:raw.size.quality==='confirmed'?'confirmed':'estimated',locked:raw.size.locked===true,basis:plain(raw.size.basis)?raw.size.basis:null}
    :null;
  const list=Array.isArray(raw.furnishing)?raw.furnishing:[];
  const furnishing=[];
  for(const entry of list){
    if(!plain(entry)||typeof entry.localId!=='string'||!entry.localId||typeof entry.type!=='string'||!entry.type)continue;
    if(!finite(entry.widthM)||!finite(entry.heightM)||entry.widthM<=0||entry.heightM<=0)continue;
    furnishing.push({localId:entry.localId,type:entry.type,name:typeof entry.name==='string'&&entry.name?entry.name:entry.type,itemId:typeof entry.itemId==='string'&&entry.itemId?entry.itemId:null,widthM:entry.widthM,heightM:entry.heightM,quality:entry.quality==='confirmed'?'confirmed':'layout'});
  }
  const revision=Number.isInteger(raw.revision)&&raw.revision>=0?raw.revision:0;
  // 超限不下发裁剪结果：调用方必须看到 deferred 并自己决定（§19.1 不静默裁剪）。
  return {version:1,locationId,revision,size,furnishing,deferred:furnishing.length>SPACE_CANONICAL_MAX_FURNISHING};
}

/**
 * M4-06：把当前分支、当前地图关联的真实行投影成布局上下文（只读纯函数）。
 * - routes 可选，默认 []；entities 增 route ID 与 routesById/locationsById 只读目录。
 * - 锁分三类：室内矩形/建筑矩形（floor）、确认点与确认多边形 + 确认路线几何（overview）。
 * - 布局空间 = 已标定则米、未标定（格制概览）则格；锁按该空间表达，生成器不再二次换算。
 * - 逻辑直接子地点落在另一张旧坐标图且无 transform 时标 placementKind=proxy，只有本图实坐标当锁。
 * - 只读入参、不写库；调用方必须传作者范围的行，禁止把已裁剪的 POV 数据喂进来。
 */
export function buildLayoutContext({scope,mapRow,maps=[],locations=[],characters=[],items=[],routes=[]}={}){
  try{
    scope=normalizeScope(scope);if(mapRow?.branch_id!==scope.branchId)return failure('MAP_BRANCH_MISMATCH','$.mapRow','地图与当前分支不匹配');
    const frame=typeof mapRow.frame_json==='string'?JSON.parse(mapRow.frame_json):mapRow.frame_json,mpp=mapRow.meters_per_cell;
    if(!plain(frame))return failure('FRAME_INVALID','$.mapRow.frame_json','需要完整地图框架');
    const active=rows=>rows.filter(r=>r.branch_id===scope.branchId&&r.status==='active');
    const ls=active(locations),cs=active(characters);
    // routes.status ∈ (open, blocked, closed)：几何锁只关心路线是否还存在，因此只排除 closed；
    // 被封锁的路线依旧要保留真实几何，不能让布局重新画一条更"顺"的假路。
    const rs=routes.filter(r=>r.branch_id===scope.branchId&&r.status!=='closed');
    const its=active(items).filter(i=>!i.holder_character_id&&!i.container_item_id);
    const calibrated=finite(mpp)&&mpp>0;
    const scale=calibrated?mpp:1;
    const members=collectMapLocations({mapRow,maps,locations:ls});
    const own=members.filter(l=>l.map_id===mapRow.id),ownRoutes=rs.filter(r=>r.map_id===mapRow.id);
    const issues=[];
    const locks={rooms:{},buildings:{},actors:{},points:{},areas:{},routes:{}};
    const json=raw=>{if(raw===null||raw===undefined||raw==='')return null;if(typeof raw!=='string')return raw;try{return JSON.parse(raw);}catch{return undefined;}};
    for(const l of own){
      const area=json(l.area_geometry_json);
      if(area===undefined){issues.push(diagnostic('LOCK_GEOMETRY_UNREADABLE','$.entities.locations.'+l.id,'确认几何无法解析，已按无锁处理',{severity:'warning',entityId:l.id}));}
      else if(plain(area)&&area.quality==='confirmed'&&area.kind==='polygon'&&Array.isArray(area.points)){
        const raw=area.points;
        if(raw.length>=3&&raw.every(p=>plain(p)&&finite(p.x)&&finite(p.y))){
          const points=raw.map(p=>({x:p.x*scale,y:p.y*scale}));
          // 任意顶点的确认多边形都进 areas 锁；生成器不得用估计覆盖它。
          locks.areas[l.id]={kind:'polygon',quality:'confirmed',name:l.name??null,points};
          if(calibrated&&raw.length===4){
            const xs=raw.map(p=>p.x),ys=raw.map(p=>p.y),x=Math.min(...xs),y=Math.min(...ys),w=Math.max(...xs)-x,h=Math.max(...ys)-y;
            const axisAligned=w>0&&h>0&&raw.every(p=>(Math.abs(p.x-x)<1e-6||Math.abs(p.x-x-w)<1e-6)&&(Math.abs(p.y-y)<1e-6||Math.abs(p.y-y-h)<1e-6));
            // 仅轴对齐矩形才与本仓的室内/城市求解器兼容；斜置矩形仍作为 areas 锁保留。
            if(axisAligned)locks[l.kind==='room'?'rooms':'buildings'][l.id]={x:x*scale,y:y*scale,w:w*scale,h:h*scale};
          }
        }else issues.push(diagnostic('LOCK_GEOMETRY_INVALID','$.entities.locations.'+l.id+'.area_geometry_json','确认多边形顶点不足或含非有限数值，已按无锁处理',{severity:'warning',entityId:l.id}));
      }
      if(l.coord_precision==='exact'&&finite(l.grid_x)&&finite(l.grid_y))locks.points[l.id]={x:l.grid_x*scale,y:l.grid_y*scale};
    }
    for(const c of cs)if(c.map_id===mapRow.id&&c.coord_precision==='exact'&&finite(c.grid_x)&&finite(c.grid_y)){
      locks.points[c.id]={x:c.grid_x*scale,y:c.grid_y*scale};
      if(calibrated)locks.actors[c.id]={x:c.grid_x*mpp,y:c.grid_y*mpp};
    }
    for(const r of ownRoutes){
      const geo=json(r.geometry_json);
      if(geo===undefined)issues.push(diagnostic('LOCK_GEOMETRY_UNREADABLE','$.entities.routes.'+r.id,'路线几何无法解析，按缺几何处理',{severity:'warning',entityId:r.id}));
      const coords=plain(geo)?(Array.isArray(geo.points)?geo.points:Array.isArray(geo.coordinates)?geo.coordinates:null):null;
      const path=coords&&coords.length>=2?coords.map(p=>Array.isArray(p)?{x:p[0],y:p[1]}:plain(p)?{x:p.x,y:p.y}:null):null;
      if(!path||path.some(p=>!p||!finite(p.x)||!finite(p.y)))continue;
      const confirmed=r.geometry_quality==='confirmed';
      locks.routes[r.id]={quality:confirmed?'confirmed':'estimated',dashed:!confirmed,path:path.map(p=>({x:p.x*scale,y:p.y*scale})),fromLocationId:r.from_location_id??null,toLocationId:r.to_location_id??null};
    }
    // 代理入口：本图容器的逻辑直接子地点，坐标仍留在另一张旧图且没有 transform。
    const containerId=mapRow.container_location_id??null,placement={};
    // P06/N01：容器的真实类别与名称由程序提供（不按名字猜用途，也不把「画法 overview」当成「世界」）。
    const containerRow=containerId?ls.find(l=>l.id===containerId)??null:null;
    const containerKind=containerRow?String(containerRow.kind):null;
    const containerName=containerRow?String(containerRow.name??''):null;
    for(const l of members){
      if(l.map_id===mapRow.id){placement[l.id]='local';continue;}
      placement[l.id]='proxy';
    }
    // 目录只含本图行 + 本图路线的双端点，不把整个 branch 的位置塞给模型。
    const directory=rows=>Object.fromEntries(rows.map(r=>[r.id,r]));
    const roomIds=new Set(members.filter(l=>l.kind==='room').map(l=>l.id));
    const memberIds=new Set(members.filter(l=>['room','other'].includes(l.kind)).map(l=>l.id));
    const roomConnections=rs.filter(r=>memberIds.has(r.from_location_id)&&memberIds.has(r.to_location_id)&&(roomIds.has(r.from_location_id)||roomIds.has(r.to_location_id))&&r.from_location_id!==r.to_location_id&&['adjacent','door','estimated'].includes(r.kind)&&r.status==='open')
      .map(r=>({id:r.id,from:r.from_location_id,to:r.to_location_id}));
    const externalRoomIds=rs.filter(r=>r.status==='open'&&(r.from_location_id===containerId||r.to_location_id===containerId))
      .flatMap(r=>[r.from_location_id,r.to_location_id]).filter(id=>memberIds.has(id));
    let entryDoors=[],parentGroups=[];
    const parent=maps.find(m=>m.branch_id===scope.branchId&&m.id!==mapRow.id&&m.id===ls.find(l=>l.id===containerId)?.map_id);
    if(parent){
      const parentFrame=json(parent.frame_json),layout=parentFrame?.atlasScene?.layout;
      const room=layout?.rooms?.find(r=>r.id===containerId);
      if(room&&parentFrame.atlasScene.units==='meters'){
        entryDoors=(layout.doors??[]).filter(d=>d.roomId===containerId).map(d=>({...d,x:d.x-room.x,y:d.y-room.y,sourceRoomSize:{w:room.w,h:room.h}}));
        parentGroups=(layout.groups??[]).filter(g=>g.roomId===containerId).map(g=>({...g,id:parseSpaceLocalId(g.id)?.contentId??g.id,x:g.x-room.x,y:g.y-room.y,sourceRoomSize:{w:room.w,h:room.h}}));
      }
    }
    const endpointIds=new Set();
    for(const r of ownRoutes){if(r.from_location_id)endpointIds.add(r.from_location_id);if(r.to_location_id)endpointIds.add(r.to_location_id);}
    const locationsById=directory([...members,...ls.filter(l=>!members.includes(l)&&(l.id===containerId||endpointIds.has(l.id)))]);
    const routesById=directory(ownRoutes);
    const saved=readSceneFrame(frame,{branchId:scope.branchId,mapId:mapRow.id});
    if(!saved.ok)return saved;
    // P12/R03 §19.1：本图覆盖空间（container）的权威尺寸与陈设账本；身份不符/损坏 → null。
    const spaceCanonical=readSpaceCanonical(plain(frame)?frame[FRAME_SPACE_CANONICAL_KEY]:null,containerId);
    return {ok:true,context:{scope,map:{id:mapRow.id,name:mapRow.name,containerLocationId:containerId,containerKind,containerName,metersPerCell:calibrated?mpp:null,scaleQuality:mapRow.scale_quality,scaleLocked:Number(mapRow.scale_locked)===1,frame},entities:{locations:ls.map(l=>l.id),characters:cs.map(c=>c.id),items:its.map(i=>i.id),routes:rs.map(r=>r.id)},locationsById,routesById,roomConnections,externalRoomIds,entryDoors,parentGroups,placement,locks,previousScene:saved.scene,spaceCanonical,seed:mapRow.id},issues};
  }catch(e){return failure('CONTEXT_BUILD_FAILED','$','当前分支行或已保存场景不可读取',{detailCode:String(e.message)});}
}
