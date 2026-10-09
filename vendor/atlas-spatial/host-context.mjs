import {normalizeScope,finite,plain,diagnostic,failure} from './contracts.mjs';
import {readSceneFrame} from './storage.mjs';

/**
 * M4-06：把当前分支、当前地图关联的真实行投影成布局上下文（只读纯函数）。
 * - routes 可选，默认 []；entities 增 route ID 与 routesById/locationsById 只读目录。
 * - 锁分三类：室内矩形/建筑矩形（floor）、确认点与确认多边形 + 确认路线几何（overview）。
 * - 布局空间 = 已标定则米、未标定（格制概览）则格；锁按该空间表达，生成器不再二次换算。
 * - 逻辑直接子地点落在另一张旧坐标图且无 transform 时标 placementKind=proxy，只有本图实坐标当锁。
 * - 只读入参、不写库；调用方必须传作者范围的行，禁止把已裁剪的 POV 数据喂进来。
 */
export function buildLayoutContext({scope,mapRow,locations=[],characters=[],items=[],routes=[]}={}){
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
    const own=ls.filter(l=>l.map_id===mapRow.id),ownRoutes=rs.filter(r=>r.map_id===mapRow.id);
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
    for(const l of ls){
      if(l.map_id===mapRow.id){placement[l.id]='local';continue;}
      if(containerId&&l.parent_location_id===containerId)placement[l.id]='proxy';
    }
    // 目录只含本图行 + 本图路线的双端点，不把整个 branch 的位置塞给模型。
    const directory=rows=>Object.fromEntries(rows.map(r=>[r.id,r]));
    const endpointIds=new Set();
    for(const r of ownRoutes){if(r.from_location_id)endpointIds.add(r.from_location_id);if(r.to_location_id)endpointIds.add(r.to_location_id);}
    const locationsById=directory([...own,...ls.filter(l=>!own.includes(l)&&endpointIds.has(l.id))]);
    const routesById=directory(ownRoutes);
    const saved=readSceneFrame(frame,{branchId:scope.branchId,mapId:mapRow.id});
    if(!saved.ok)return saved;
    return {ok:true,context:{scope,map:{id:mapRow.id,name:mapRow.name,containerLocationId:containerId,metersPerCell:calibrated?mpp:null,scaleQuality:mapRow.scale_quality,scaleLocked:Number(mapRow.scale_locked)===1,frame},entities:{locations:ls.map(l=>l.id),characters:cs.map(c=>c.id),items:its.map(i=>i.id),routes:rs.map(r=>r.id)},locationsById,routesById,placement,locks,previousScene:saved.scene,seed:mapRow.id},issues};
  }catch(e){return failure('CONTEXT_BUILD_FAILED','$','当前分支行或已保存场景不可读取',{detailCode:String(e.message)});}
}
