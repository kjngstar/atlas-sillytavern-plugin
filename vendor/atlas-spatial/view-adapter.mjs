import {SCENE_KIND,SCENE_VERSION,clone,finite,plain,normalizeScope,diagnostic,failure,checkSceneDocument} from './contracts.mjs';
/** Use one entry shape deliberately; callers must not guess a legacy response wrapper. */
export function unwrapViewResult(value,mode='direct'){
  const result=mode==='direct'?value:mode==='state-map'?value?.state?.sqlViews?.map:null;
  if(!result||!Array.isArray(result.items)||typeof result.branchId!=='string'||!Number.isInteger(result.revision))return failure('VIEW_SHAPE_INVALID','$','请明确直接 ViewResult 或 state-map 响应入口');
  return {ok:true,view:result};
}
export function projectMapView({view,mapId,scope}={}){
  try{scope=normalizeScope(scope);}catch{return failure('SCOPE_INVALID','$.scope','缺少当前 UI 作用域');}
  if(view?.branchId!==scope.branchId||view?.revision!==scope.revision||view?.metadata?.stale)return failure('VIEW_STALE','$.revision','旧视图不能更新当前地图');
  const raw=view.items?.find(m=>m.mapId===mapId);if(!raw)return {ok:true,status:'empty',scene:null,coarseList:[],issues:[]};
  const mpp=finite(raw.metersPerCell)&&raw.metersPerCell>0?raw.metersPerCell:null,k=mpp??1,frame=raw.frames?.frame??{},issues=[];
  const frameWidth=frame.cols??frame.reference_width_cells,frameHeight=frame.rows??frame.reference_height_cells;
  const pins=[];
  const geometry=(value,path)=>{if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{issues.push(diagnostic('GEOMETRY_JSON_INVALID',path,'此项轮廓不可读，保留其他标点',{severity:'warning'}));return null;}};
  for(const p of raw.points??[]){
    if(scope.viewMode==='pov'&&p.hidden===true)continue;
    if(!finite(p.x)||!finite(p.y)){issues.push(diagnostic('POINT_UNLOCATED','$.points','坐标未知，保留目录，不制造零点',{entityId:p.entityId,severity:'warning'}));continue;}
    if(!['location','character','item'].includes(p.kind))continue;
    let polygon=null;const area=geometry(p.area,'$.points.area');
    if(area?.kind==='polygon'&&Array.isArray(area.points)&&area.points.length>=3&&area.points.every(q=>finite(q.x)&&finite(q.y)))polygon=area.points.map(q=>({x:q.x*k,y:q.y*k}));
    pins.push({id:p.entityId,entityId:p.entityId,name:String(p.name??''),type:p.kind==='character'?'person':p.kind,mapId,x:p.x*k,y:p.y*k,quality:p.markerQuality??p.precision??'approximate',locationId:p.locationId??null,radius:finite(p.radius)?p.radius*k:null,polygon});
  }
  const xs=pins.map(p=>p.x),ys=pins.map(p=>p.y);
  const bounds=finite(frameWidth)&&frameWidth>0&&finite(frameHeight)&&frameHeight>0?{x:finite(frame.origin_x)?frame.origin_x*k:0,y:finite(frame.origin_y)?frame.origin_y*k:0,w:frameWidth*k,h:frameHeight*k}:{x:Math.min(0,...xs)-k,y:Math.min(0,...ys)-k,w:Math.max(k,(Math.max(0,...xs)-Math.min(0,...xs))+2*k),h:Math.max(k,(Math.max(0,...ys)-Math.min(0,...ys))+2*k)};
  const routes=[];
  for(const r of raw.routes??[]){
    const geom=geometry(r.geometry,'$.routes.geometry');
    if(!plain(geom))continue;
    // 审查必修4：插件 compileRoutePropose 保存 {kind,coordinates:[[x,y],...]}；本适配器原只认 {mapId,points:[{x,y}]}。
    // 明确转换：仅 line 几何可作为行走路线，多边形边界不当作路线；坐标必须有限；坏路径单项诊断。
    let pts=null,mapRef=null;
    if(Array.isArray(geom.coordinates)){
      if(geom.kind!=='line'){issues.push(diagnostic('ROUTE_GEOMETRY_KIND','$.routes.geometry',`仅 line 几何可作为行走路线，收到 kind=${String(geom.kind)}`,{severity:'warning',entityId:r.routeId}));continue;}
      pts=geom.coordinates;mapRef=typeof r.mapId==='string'?r.mapId:mapId;
    }else if(Array.isArray(geom.points)){
      pts=geom.points;mapRef=typeof geom.mapId==='string'?geom.mapId:typeof r.mapId==='string'?r.mapId:mapId;
    }else{issues.push(diagnostic('ROUTE_GEOMETRY_SHAPE','$.routes.geometry','路线几何既无 coordinates 也无 points',{severity:'warning',entityId:r.routeId}));continue;}
    if(mapRef!==mapId)continue;
    const coord=v=>typeof v==='number'&&finite(v);
    if(pts.length<2||!pts.every(q=>Array.isArray(q)?q.length>=2&&coord(q[0])&&coord(q[1]):plain(q)&&coord(q.x)&&coord(q.y))){issues.push(diagnostic('ROUTE_COORDS_INVALID','$.routes.geometry','路线坐标不足或含非有限值，跳过该路线',{severity:'warning',entityId:r.routeId}));continue;}
    routes.push({id:r.routeId,kind:'route',mapId,path:pts.map(q=>({x:(Array.isArray(q)?Number(q[0]):q.x)*k,y:(Array.isArray(q)?Number(q[1]):q.y)*k})),quality:r.geometryQuality==='confirmed'?'confirmed':'estimated',dashed:r.geometryQuality!=='confirmed',progress:null,
      // 审查必修2：路线可见性依据——端点引用必须随 DTO 下发，POV 过滤据此执行。
      ...(typeof r.fromLocationId==='string'?{fromLocationId:r.fromLocationId}:{}),...(typeof r.toLocationId==='string'?{toLocationId:r.toLocationId}:{}),...(r.hidden===true?{hidden:true}:{})});
  }
  const scene={kind:SCENE_KIND,version:SCENE_VERSION,generator:'sql-view-adapter/1',mapId,branchId:scope.branchId,sourceRevision:scope.revision,units:mpp?'meters':'cells',metersPerCell:mpp,metricQuality:raw.scaleQuality??'uncalibrated',layout:{id:mapId,name:raw.name,kind:'overview',bounds,surface:typeof raw.surface==='string'?raw.surface:'mixed',pins,shapes:pins.filter(p=>p.polygon).map(p=>({id:p.id,polygon:p.polygon,name:p.name})),routes,features:[]}};
  return {ok:true,status:'ready',scene,coarseList:(raw.coarseList??[]).filter(p=>scope.viewMode==='author'||p.hidden!==true).map(clone),issues};
}
/** Display-only filter. The host must also filter SQL responses before crossing a UI boundary. */
export function filterSceneForView(scene,{scope,visibleLocations=[],visibleCharacters=[],visibleItems=[],names={}}={}){
  if(checkSceneDocument(scene).length)return failure('SCENE_INVALID','$','不能展示损坏的几何文档');
  if(scene.branchId!==scope?.branchId)return failure('SCENE_SCOPE_MISMATCH','$.branchId','场景分支不一致');
  let d=clone(scene);const L=new Set(visibleLocations),C=new Set(visibleCharacters),I=new Set(visibleItems),author=scope.viewMode==='author';
  if(!author){
    // Never pass internal diagnostics, input constraints or unknown extension fields to POV.
    const top=['kind','version','generator','mapId','branchId','sourceRevision','units','metersPerCell','metricQuality'];
    const keys={floor:['id','name','kind','bounds','corridor','rooms','groups','bodies','doors','windows','lamps','doorSwings','actors','items','path'],city:['id','name','kind','bounds','wall','origin','river','riverPolygon','districts','roads','segments','gates','buildings','dock'],overview:['id','name','kind','bounds','surface','pins','shapes','routes','features']};
    const saved=d.layout;d=Object.fromEntries(top.filter(k=>d[k]!==undefined).map(k=>[k,d[k]]));d.layout=Object.fromEntries((keys[saved.kind]??[]).filter(k=>saved[k]!==undefined).map(k=>[k,saved[k]]));
  }
  const s=d.layout;
  const allowed=(id,type)=>author||(type==='person'?C:type==='item'?I:L).has(id);
  const name=p=>({...p,name:names[p.id]??p.name??''});
  if(s.kind==='floor'){
    s.rooms=s.rooms.filter(r=>allowed(r.id,'location')).map(name);const rooms=new Set(s.rooms.map(r=>r.id));
    for(const key of ['groups','bodies','doors','windows','lamps','doorSwings'])s[key]=(s[key]??[]).filter(p=>rooms.has(p.roomId));
    s.actors=(s.actors??[]).filter(p=>rooms.has(p.roomId)&&allowed(p.id,'person')).map(name);s.items=(s.items??[]).filter(p=>rooms.has(p.roomId)&&allowed(p.id,'item')).map(name);s.path=[];
  }else if(s.kind==='city'){
    s.districts=s.districts.filter(d=>allowed(d.id,'location')).map(name);const districts=new Set(s.districts.map(d=>d.id));
    s.buildings=s.buildings.filter(b=>districts.has(b.districtId)&&(b.decorative||allowed(b.id,'location'))).map(name);
    if(!author){s.roads=s.roads.filter(r=>r.id==='avenue'||[...districts].some(id=>r.id==='road:'+id));const roads=new Set(s.roads.map(r=>r.id));s.segments=s.segments.filter(r=>roads.has(r.roadId));}
  }else{
    s.pins=s.pins.filter(p=>allowed(p.id,p.type)).map(name);s.shapes=(s.shapes??[]).filter(p=>allowed(p.id,'location')).map(name);
    // 审查必修2：overview 路线过滤——隐藏路线不下发 POV；路线必须具备端点引用作可见性依据，
    // 且全部端点都必须在当前可见集合内（任一端点隐藏即视为隐藏路线，不得泄露其 ID 与路径）。
    s.routes=(s.routes??[]).filter(r=>{
      if(author)return true;
      if(r.hidden===true)return false;
      const endpoints=[r.fromLocationId,r.toLocationId].filter(v=>typeof v==='string'&&v);
      if(!endpoints.length)return false;
      return endpoints.every(id=>L.has(id));
    });
    // M4-19：挂在不透明 zone 上的装饰连同其 ID/几何一起剔除；全图公开材质（无 zoneId）可以保留。
    const visibleZones=new Set(s.shapes.map(x=>x.id));
    s.features=(s.features??[]).filter(f=>author||!f.zoneId||visibleZones.has(f.zoneId));
  }
  if(!author)d.layout=stripLayoutForPov(s);
  return {ok:true,scene:d,issues:[]};
}
/** 审查必修2：POV 输出按嵌套字段白名单逐层重建，任何未登记字段（如 privateExtension）在服务端被剥掉。 */
const pickPoint=q=>plain(q)?{x:q.x,y:q.y}:null;
const pickPoints=v=>Array.isArray(v)?v.map(pickPoint).filter(Boolean):[];
const pick=(p,...fields)=>{if(!plain(p))return null;const out={};for(const f of fields)if(p[f]!==undefined)out[f]=p[f];return out;};
function stripLayoutForPov(s){
  const sanitize={
    floor:{
      corridor:p=>pick(p,'x','y','w','h'),
      rooms:p=>pick(p,'id','name','x','y','w','h','side','role'),
      groups:p=>({...pick(p,'id','name','roomId','x','y','w','h'),...(Array.isArray(p.bodies)?{bodies:p.bodies.map(b=>pick(b,'x','y','w','h')).filter(Boolean)}:{})}),
      bodies:p=>pick(p,'x','y','w','h','roomId'),
      doors:p=>pick(p,'x','y','width','roomId'),
      windows:p=>pick(p,'x','y','roomId'),
      lamps:p=>pick(p,'x','y','roomId'),
      doorSwings:p=>pick(p,'x','y','w','h','roomId'),
      actors:p=>pick(p,'id','name','roomId','x','y','quality'),
      items:p=>pick(p,'id','name','roomId','x','y','quality'),
      path:pickPoints,
    },
    city:{
      wall:pickPoints,riverPolygon:pickPoints,
      origin:p=>pick(p,'x','y'),
      river:p=>pick(p,'cx','amplitude','width','height'),
      dock:p=>pick(p,'x','y','width'),
      districts:p=>({...pick(p,'id','name'),...(Array.isArray(p.polygon)?{polygon:pickPoints(p.polygon)}:{}),...(plain(p.site)?{site:pickPoint(p.site)}:{})}),
      roads:p=>({...pick(p,'id','name','roadId','width'),...(plain(p.a)?{a:pickPoint(p.a)}:{}),...(plain(p.b)?{b:pickPoint(p.b)}:{})}),
      segments:p=>({...pick(p,'id','roadId','width'),...(plain(p.a)?{a:pickPoint(p.a)}:{}),...(plain(p.b)?{b:pickPoint(p.b)}:{})}),
      gates:p=>pick(p,'id','name','x','y'),
      buildings:p=>pick(p,'id','name','districtId','x','y','w','h','decorative'),
    },
    overview:{
      surface:p=>p,
      pins:p=>({...pick(p,'id','entityId','name','type','mapId','x','y','quality','locationId','radius'),...(Array.isArray(p.polygon)?{polygon:pickPoints(p.polygon)}:{})}),
      shapes:p=>({...pick(p,'id','name'),...(Array.isArray(p.polygon)?{polygon:pickPoints(p.polygon)}:{})}),
      routes:p=>({...pick(p,'id','kind','mapId','quality','dashed','progress','fromLocationId','toLocationId'),...(Array.isArray(p.path)?{path:pickPoints(p.path)}:{})}),
      // 装饰只有视觉字段；type/zoneId/density 之外的一切（structureKey/placement/内部标记）一律不下发。
      features:p=>({...pick(p,'id','type','zoneId','density','decorative','quality','width','widthClass','fromSector','toSector'),...(Array.isArray(p.path)?{path:pickPoints(p.path)}:{}),...(Array.isArray(p.polygon)?{polygon:pickPoints(p.polygon)}:{})}),
    },
  }[s.kind]??{};
  const out={};
  for(const [key,value] of Object.entries(s)){
    if(key==='id'||key==='name'||key==='kind'){out[key]=value;continue;}
    if(key==='bounds'){out[key]=pick(value,'x','y','w','h');continue;}
    const rule=sanitize[key];
    if(!rule)continue;
    if(Array.isArray(value))out[key]=value.map(rule).filter(Boolean);
    else if(plain(value))out[key]=rule(value);
    else if(typeof value==='string'||typeof value==='number'||typeof value==='boolean')out[key]=value;
  }
  return out;
}
export function buildMapTree(mapItems,locationRows){
  const locations=new Map((locationRows??[]).map(l=>[l.id,l])),nodes=(mapItems??[]).map(m=>({mapId:m.mapId,containerLocationId:m.containerLocationId??null,name:m.name,kind:m.kind,parentMapId:null}));
  const byContainer=new Map();for(const n of nodes){if(n.containerLocationId&&!byContainer.has(n.containerLocationId))byContainer.set(n.containerLocationId,[]);byContainer.get(n.containerLocationId)?.push(n.mapId);}
  for(const n of nodes){const loc=locations.get(n.containerLocationId);if(loc?.map_id&&loc.map_id!==n.mapId)n.parentMapId=loc.map_id;}
  const issues=[];for(const n of nodes){const seen=new Set([n.mapId]);let next=n.parentMapId;while(next){if(seen.has(next)){issues.push(diagnostic('MAP_PARENT_CYCLE','$.nodes','地图父链形成循环',{entityId:n.mapId}));n.parentMapId=null;break;}seen.add(next);next=nodes.find(v=>v.mapId===next)?.parentMapId??null;}}
  return {nodes,childMapsByLocation:Object.fromEntries(byContainer),issues};
}
/** 送往 UI/iframe 前只保留可公开的 frame：场景、待生成 spec、世界填充进度都是内部字段。 */
export function publicMapFrame(frame){const out=clone(frame??{});delete out.atlasScene;delete out.atlasLayoutRequest;delete out.atlasWorldFill;return out;}
/** Reconcile saved visual anchors with the same-revision SQL position projection. */
export function hydrateScene(scene,projection){
  if(!projection?.ok||!projection.scene||scene.mapId!==projection.scene.mapId||scene.branchId!==projection.scene.branchId)return failure('PROJECTION_SCOPE_MISMATCH','$','几何文档与 SQL 现状不属于同一地图');
  if(scene.units!==projection.scene.units||scene.metersPerCell!==projection.scene.metersPerCell)return failure('PROJECTION_METRIC_MISMATCH','$','已保存布局需要重新按当前尺度验证');
  const d=clone(scene),s=d.layout;if(s.kind!=='floor')return {ok:true,scene:d,issues:[]};
  const pins=projection.scene.layout.pins??[],coarse=projection.coarseList??[],P=new Map(pins.map(p=>[p.id,p])),C=new Map(coarse.map(p=>[p.entityId,p]));
  s.actors=s.actors.filter(a=>{const p=P.get(a.id),c=C.get(a.id);return p?.locationId===a.roomId||c?.locationId===a.roomId;}).map(a=>{const p=P.get(a.id);return p&&p.quality!=='layout'?{...a,x:p.x,y:p.y,quality:p.quality,name:p.name}:a;});
  s.items=s.items.filter(a=>{const p=P.get(a.id);return p?.locationId===a.roomId;}).map(a=>{const p=P.get(a.id);return p&&p.quality!=='layout'?{...a,x:p.x,y:p.y,quality:p.quality,name:p.name}:a;});
  s.path=[];return {ok:true,scene:d,issues:[]};
}
