import * as E from './layout-core.mjs';
import * as O from './overview-core.mjs';
import {KIT_VERSION,SCENE_KIND,SCENE_VERSION,LIMITS,clone,finite,plain,stable,bytes,normalizeScope,diagnostic,failure,parseWholeArguments,checkSceneDocument,OVERVIEW_FEATURE_TYPES,OVERVIEW_SURFACES,OVERVIEW_ZONE_ROLES,OVERVIEW_ZONE_SIZES,OVERVIEW_DENSITIES,OVERVIEW_SECTORS,OVERVIEW_WIDTH_CLASSES,CITY_ENCLOSURES} from './contracts.mjs';

const label=v=>typeof v==='string'?v.slice(0,120):'';
const ids=v=>new Set(v instanceof Set?v:Array.isArray(v)?v:[]);
const sort=rows=>rows.sort((a,b)=>a.id.localeCompare(b.id,'en'));
function setup(value,context,kind){
  const scope=normalizeScope(context.scope),input=parseWholeArguments(value),map=context.map;
  if(!plain(map)||typeof map.id!=='string'||!map.id)throw new Error('MAP_CONTEXT_REQUIRED');
  if(input.mapId!==undefined&&input.mapId!==map.id)throw new Error('MAP_ID_MISMATCH');
  if(input.id!==undefined&&input.id!==map.id)throw new Error('MAP_ID_MISMATCH');
  if(context.currentScope&&!same(context.currentScope,scope))throw new Error('STALE_SCOPE');
  const known={locations:ids(context.entities?.locations),characters:ids(context.entities?.characters),items:ids(context.entities?.items),routes:ids(context.entities?.routes)};
  let w=input.width,h=input.height,mpp=map.metersPerCell,metricProposal=null,units='meters';
  const f=map.frame||{},cols=f.cols??f.reference_width_cells,rows=f.rows??f.reference_height_cells;
  const hasFrame=finite(cols)&&cols>0&&finite(rows)&&rows>0,calibrated=finite(mpp)&&mpp>0;
  if(!calibrated&&map.scaleLocked)throw new Error('SCALE_LOCKED_UNCALIBRATED');
  if(kind==='overview'){
    // 02 §6.2：概览幅面由程序按地图框架给定。已标定 → 米；完全未标定 → 格，绝不假设 1 格 = 1 米。
    if(!hasFrame)throw new Error('FRAME_REQUIRED_FOR_OVERVIEW');
    if(calibrated){w=cols*mpp;h=rows*mpp;units='meters';}
    else{w=cols;h=rows;units='cells';metricProposal=null;}
  }else{
    if(calibrated&&hasFrame){w=cols*mpp;h=rows*mpp;}
    if(!finite(w)||!finite(h)||w<=0||h<=0)throw new Error('EXTENT_REQUIRED');
    if(!calibrated){
      if(!hasFrame)throw new Error('FRAME_REQUIRED_FOR_CALIBRATION');
      const a=w/cols,b=h/rows;if(Math.abs(a-b)/Math.max(a,b)>.01)throw new Error('SCALE_ASPECT_CONFLICT');
      mpp=a;metricProposal={metersPerCell:mpp,scaleQuality:'estimated',basis:{source:'layout-extent',widthM:w,heightM:h}};
    }
  }
  if((kind==='floor'&&(w>LIMITS.floorSide||h>LIMITS.floorSide))||(kind==='city'&&(w>LIMITS.citySide||h>LIMITS.citySide)))throw new Error('EXTENT_TOO_LARGE');
  const issues=[],spec={id:map.id,parentId:map.containerLocationId??null,name:label(map.name)||label(input.name)||map.id,width:w,height:h};
  return {scope,input,map,known,spec,issues,mpp,units,metricProposal,previous:context.previousScene??null};
}
const same=(a,b)=>stable(normalizeScope(a))===stable(normalizeScope(b));
function collection(s,key,limit,kind,normalize){
  const values=s.input[key]??[];
  if(!Array.isArray(values)||values.length>limit)throw new Error('COLLECTION_LIMIT:'+key);
  const seen=new Set(),out=[];
  for(let n=0;n<values.length;n++){
    const raw=values[n],path='$.'+key+'['+n+']';
    if(!plain(raw)||typeof raw.id!=='string'||!raw.id||raw.id.length>160||seen.has(raw.id)){s.issues.push(diagnostic('ENTITY_ID_INVALID',path,'缺少标识或标识重复'));continue;}
    seen.add(raw.id);
    if(kind&&!s.known[kind].has(raw.id)){s.issues.push(diagnostic('ENTITY_REF_UNKNOWN',path+'.id','实体不在程序提供的当前分支引用表中',{entityId:raw.id}));continue;}
    try{const row=normalize(raw);out.push({...row,id:raw.id,name:label(raw.name)||raw.id});}catch(e){s.issues.push(diagnostic(String(e.message),path,'本项约束不可用，其他独立项继续处理',{entityId:raw.id}));}
  }
  return sort(out);
}
/** 审查必修1：小改动请求先按 ID 合并已保存约束再生成。省略=保持；删除必须经 deletes 显式表达；rebuild=true 才整图重建。 */
const MERGEABLE_KEYS=['rooms','contents','actors','items','districts','buildings','zones','links','features'];
function deletionSet(s,key){
  const raw=s.input.deletes;
  if(raw===undefined||raw===null)return new Set();
  if(!plain(raw)){s.issues.push(diagnostic('DELETE_SHAPE_INVALID','$.deletes','deletes 必须是集合名到字符串 ID 数组的对象',{severity:'warning'}));return new Set();}
  const out=new Set();
  for(const [k,v] of Object.entries(raw)){
    if(!MERGEABLE_KEYS.includes(k)){s.issues.push(diagnostic('DELETE_TARGET_UNKNOWN','$.deletes.'+k,'未知删除目标集合',{severity:'warning'}));continue;}
    if(k!==key)continue;
    if(!Array.isArray(v)||!v.every(id=>typeof id==='string'&&id)){s.issues.push(diagnostic('DELETE_SHAPE_INVALID','$.deletes.'+k,'删除列表必须是字符串 ID 数组',{severity:'warning'}));continue;}
    for(const id of v)out.add(id);
  }
  return out;
}
function collectAndMerge(s,key,limit,kind,normalize){
  const requestRows=collection(s,key,limit,kind,normalize);
  if(s.input.rebuild===true)return requestRows;
  const saved=s.previous?.constraints;
  if(!plain(saved)||!Array.isArray(saved[key]))return requestRows;
  const del=deletionSet(s,key),out=new Map(requestRows.map(r=>[r.id,r]));
  for(const raw of saved[key]){
    if(!plain(raw)||typeof raw.id!=='string'||!raw.id||del.has(raw.id)||out.has(raw.id))continue;
    if(kind&&!s.known[kind].has(raw.id)){s.issues.push(diagnostic('ENTITY_REF_UNKNOWN','$.previousScene.constraints.'+key+'.id','已保存约束引用的实体不在当前分支引用表中',{entityId:raw.id}));continue;}
    try{const row=normalize(raw);out.set(raw.id,{...row,id:raw.id,name:label(raw.name)||raw.id});}catch(e){s.issues.push(diagnostic(String(e.message),'$.previousScene.constraints.'+key,'已保存约束条目不可用，其他独立项继续处理',{entityId:raw.id}));}
  }
  if(out.size>limit){s.issues.push(diagnostic('COLLECTION_LIMIT:'+key,'$.'+key,'合并已保存约束后超出预算，仅保留本次请求条目'));return requestRows;}
  return sort([...out.values()]);
}
function dimensions(raw){if(!finite(raw.w)||!finite(raw.h)||raw.w<=0||raw.h<=0)throw new Error('DIMENSION_INVALID');return {w:raw.w,h:raw.h};}
/** 02 §6.4：程序陈设类型。solid 类型参与碰撞；light/decor/doorway/stairs 不挡路。 */
const FLOOR_FURNITURE_TYPES=['shelf','desk','bench','reading','stairs','table','chair','bed','cabinet','doorway','light','decor'];
function trustedLock(ctx,type,id){const v=ctx.locks?.[type]?.[id];return v&&finite(v.x)&&finite(v.y)?{x:v.x,y:v.y}:null;}
function finish(s,ctx,layoutFn){
  const previous=s.previous;
  if(previous&&(previous.mapId!==s.map.id||previous.branchId!==s.scope.branchId))return failure('SCENE_SCOPE_MISMATCH','$.previousScene','旧场景属于另一地图或分支');
  if(previous&&s.input.rebuild!==true&&!plain(previous.constraints))s.issues.push(diagnostic('CONSTRAINTS_LEGACY','$.previousScene','旧场景缺少受控约束字段，本次按整图重建语义处理',{severity:'warning'}));
  const inputSignature=stable(s.spec);
  if(previous?.inputSignature===inputSignature&&!(previous.layout?.issues?.length)&&checkSceneDocument(previous).length===0){return {ok:true,status:s.issues.length?'partial':'reused',scene:clone(previous),issues:s.issues,guard:{scope:s.scope,mapId:s.map.id,inputSignature},metricProposal:s.metricProposal};}
  const layout=layoutFn(s.spec,previous?.layout??null);
  for(const issue of layout.issues??[])s.issues.push(diagnostic(issue.code,'$.layout','空间约束未满足',{entityId:issue.id??null}));
  if(!layout.ok)return {ok:false,status:'failed',scene:null,kept:previous?clone(previous):null,issues:s.issues,guard:{scope:s.scope,mapId:s.map.id,inputSignature}};
  // Saved physical coordinates and schematic positions remain different concepts.
  for(const a of layout.actors??[])if(!ctx.locks?.actors?.[a.id])a.quality='layout';
  const scene={kind:SCENE_KIND,version:SCENE_VERSION,generator:KIT_VERSION,mapId:s.map.id,branchId:s.scope.branchId,sourceRevision:s.scope.revision,units:s.units??'meters',metersPerCell:(s.units??'meters')==='cells'?null:s.mpp,metricQuality:(s.units??'meters')==='cells'?'uncalibrated':(s.metricProposal?'estimated':s.map.scaleQuality??'estimated'),inputSignature,layout};
  // 审查必修1：受控约束字段随场景落盘，供下轮增量合并；POV 视图过滤会剥离该字段。
  if(Array.isArray(s.constraintKeys)&&s.constraintKeys.length)scene.constraints=Object.fromEntries(s.constraintKeys.filter(k=>s.spec[k]!==undefined).map(k=>[k,clone(s.spec[k])]));
  const checks=checkSceneDocument(scene);if(checks.length)return {ok:false,status:'failed',scene:null,kept:previous?clone(previous):null,issues:[...s.issues,...checks]};
  return {ok:true,status:s.issues.length?'partial':'generated',scene,issues:s.issues,guard:{scope:s.scope,mapId:s.map.id,inputSignature},metricProposal:s.metricProposal};
}
export function generateFloor(value,context){
  let s=null;
  try{
    s=setup(value,context,'floor');const ctx=context;
    s.constraintKeys=['corridorWidth','rooms','contents','actors','items'];
    s.spec.corridorWidth=finite(s.input.corridorWidth)?s.input.corridorWidth:2;
    s.spec.rooms=collectAndMerge(s,'rooms',LIMITS.rooms,'locations',r=>{const d=ctx.locks?.rooms?.[r.id]?.w>0?dimensions(ctx.locks.rooms[r.id]):dimensions(r);if(d.w>LIMITS.roomSide||d.h>LIMITS.roomSide||!['north','south'].includes(r.side)||r.role!==undefined&&!['indoor','outdoor','garden'].includes(r.role))throw new Error('ROOM_CONSTRAINT_UNSUPPORTED');const locked=trustedLock(ctx,'rooms',r.id);return {...d,side:r.side,...(r.role?{role:r.role}:{}),...(locked?{locked}:{} )};});
    s.spec.singleRoom=s.spec.rooms.length===1&&s.spec.rooms[0].id===s.map.containerLocationId;
    if(!s.spec.rooms.length){const failed=failure('NO_VALID_ROOMS','$.rooms','没有可生成的有效房间',{kept:s.previous?clone(s.previous):null});failed.issues.push(...s.issues);return failed;}
    if(s.spec.rooms.reduce((n,r)=>n+Math.ceil(r.w/.2)*Math.ceil(r.h/.2),0)>LIMITS.navigationCells)throw new Error('NAVIGATION_BUDGET_EXCEEDED');
    const roomIds=new Set(s.spec.rooms.map(r=>r.id));
    s.spec.contents=collectAndMerge(s,'contents',LIMITS.contents,null,r=>{if(!roomIds.has(r.roomId))throw new Error('ROOM_REF_UNKNOWN');if(!FLOOR_FURNITURE_TYPES.includes(r.type))throw new Error('FURNITURE_TYPE_UNSUPPORTED');const locked=trustedLock(ctx,'contents',r.id);return {...dimensions(r),roomId:r.roomId,type:r.type,...(locked?{locked}:{})};});
    const groups=new Set(s.spec.contents.map(g=>g.id));
    s.spec.actors=collectAndMerge(s,'actors',LIMITS.actors,'characters',r=>{if(!roomIds.has(r.roomId))throw new Error('ROOM_REF_UNKNOWN');if(r.near&&!groups.has(r.near))throw new Error('NEAR_REF_UNKNOWN');const position=trustedLock(ctx,'actors',r.id);return {roomId:r.roomId,...(r.near?{near:r.near}:{}),...(position?{position}:{})};});
    s.spec.items=collectAndMerge(s,'items',LIMITS.items,'items',r=>{if(!groups.has(r.on))throw new Error('ITEM_SUPPORT_UNKNOWN');return {on:r.on};});
    return finish(s,ctx,E.floor);
  }catch(e){return failure(String(e.message),'$','生成请求不可用；保留已保存布局',{kept:context?.previousScene?clone(context.previousScene):null});}
}
export function generateCity(value,context){
  let s=null;
  try{
    s=setup(value,context,'city');const ctx=context;
    s.constraintKeys=['riverWidth','seed','blocksPerDistrict','districts','buildings','enclosure'];
    if(s.input.riverWidth!==undefined&&(!finite(s.input.riverWidth)||s.input.riverWidth<0))return failure('RIVER_CONSTRAINT_INVALID','$.riverWidth','河宽应为非负数，零表示无水系',{kept:s.previous?clone(s.previous):null});
    s.spec.riverWidth=s.input.riverWidth??0;
    s.spec.seed=label(context.seed)||s.map.id; // The program provides the seed; the AI cannot reshuffle a saved city.
    s.spec.blocksPerDistrict=Number.isInteger(s.input.blocksPerDistrict)?Math.max(0,Math.min(LIMITS.blocksPerDistrict,s.input.blocksPerDistrict)):8;
    // G07：新城市默认开放边界；旧档（无 enclosure 且有旧场景）保持原有城墙输出，升级不拆旧墙。
    if(s.input.enclosure!==undefined&&!CITY_ENCLOSURES.includes(s.input.enclosure))s.issues.push(diagnostic('ENCLOSURE_INVALID','$.enclosure','城市边界策略只能是 open 或 wall；已按既有/默认策略处理',{severity:'warning'}));
    s.spec.enclosure=CITY_ENCLOSURES.includes(s.input.enclosure)?s.input.enclosure:(s.previous?(s.previous.constraints?.enclosure??'wall'):'open');
    s.spec.districts=collectAndMerge(s,'districts',LIMITS.districts,'locations',r=>{if(!['west','east'].includes(r.bank)||!finite(r.order))throw new Error('DISTRICT_CONSTRAINT_INVALID');return {bank:r.bank,order:r.order};});
    const districtIds=new Set(s.spec.districts.map(d=>d.id));
    s.spec.buildings=collectAndMerge(s,'buildings',LIMITS.buildings,'locations',r=>{if(!districtIds.has(r.districtId))throw new Error('DISTRICT_REF_UNKNOWN');const locked=trustedLock(ctx,'buildings',r.id);return {...(ctx.locks?.buildings?.[r.id]?.w>0?dimensions(ctx.locks.buildings[r.id]):dimensions(r)),districtId:r.districtId,...(locked?{locked}:{})};});
    return finish(s,ctx,E.city);
  }catch(e){return failure(String(e.message),'$','生成请求不可用；保留已保存布局',{kept:context?.previousScene?clone(context.previousScene):null});}
}

/**
 * M4-10：概览生成。
 * - 幅面/seed 由程序给定；zones/links/features 走同一套"省略=保持、显式 deletes、rebuild 才全重建"语义。
 * - links 只认已登记 route，端点坐标从真实 rows / 确认点锁解析；装饰永远不会变成道路。
 * - 单项无法放置只记 issue（带 id），绝不整图失败。
 */
export function generateOverview(value,context){
  let s=null;
  try{
    s=setup(value,context,'overview');const ctx=context;
    s.constraintKeys=['surface','zones','links','features'];
    s.spec.mapId=s.map.id;
    s.spec.seed=label(context.seed)||s.map.id;
    // G03：seed 由程序按地图给定；模型试图「换个 seed 重排」一律忽略并留下诊断，绝不因一次请求挪动已保存几何。
    if(s.input.seed!==undefined&&s.input.seed!==s.spec.seed)s.issues.push(diagnostic('SEED_OVERRIDDEN','$.seed','seed 由程序按地图给定，模型提供的值已忽略；已保存几何不会因此重排',{severity:'warning'}));
    s.spec.units=s.units; // 单位进入签名：拿到尺度后必须换成米制并重算，不能沿用格制场景。
    // 02 §6.2：单位从格变米（或反向）时，把已保存的格几何整体缩放一次再复用；
    // 形状、实体 ID、相对位置与 seed 都不变，只是坐标系换了。
    {
      const prevScene=context?.previousScene;
      const flips=prevScene&&prevScene.units!==s.units;
      s.spec.unitScale=!flips?1:(s.units==='meters'?(finite(s.mpp)&&s.mpp>0?s.mpp:1):(finite(s.mpp)&&s.mpp>0?1/s.mpp:1));
    }
    if(!OVERVIEW_SURFACES.includes(s.input.surface)){if(s.input.surface!==undefined)s.issues.push(diagnostic('SURFACE_INVALID','$.surface','概览表面类型非法；已按 mixed 处理',{severity:'warning'}));s.spec.surface='mixed';}
    else s.spec.surface=s.input.surface;
    if(s.input.width!==undefined||s.input.height!==undefined)s.issues.push(diagnostic('EXTENT_OVERRIDDEN','$.width','概览幅面由程序按地图框架给定，模型提供的 width/height 已忽略',{severity:'warning'}));
    const pointOf=id=>{const p=ctx.locks?.points?.[id];return p&&finite(p.x)&&finite(p.y)?{x:p.x,y:p.y}:null;};
    s.spec.zones=collectAndMerge(s,'zones',LIMITS.zones,'locations',r=>{
      const out={};
      // G05：单项非法只记 path/id 并跳过该项，绝不整图失败、也不静默当成合法枚举。
      if(r.role!==undefined){if(!OVERVIEW_ZONE_ROLES.includes(r.role))throw new Error('ZONE_ROLE_UNSUPPORTED');out.role=r.role;}
      if(r.size!==undefined){if(!OVERVIEW_ZONE_SIZES.includes(r.size))throw new Error('ZONE_SIZE_UNSUPPORTED');out.size=r.size;}
      if(r.sector!==undefined){if(![...OVERVIEW_SECTORS,'center'].includes(r.sector))throw new Error('ZONE_SECTOR_UNSUPPORTED');out.sector=r.sector;}
      if(typeof r.near==='string'&&r.near)out.near=r.near;
      const locked=pointOf(r.id);if(locked)out.locked=locked;
      const area=ctx.locks?.areas?.[r.id];
      if(area?.points?.length>=3)out.lockedPolygon=area.points.map(p=>({x:p.x,y:p.y}));
      // 07 §3：坐标留在另一张旧图且无 transform 的逻辑直接子地点 → 只做场景代理，不回写位置/范围。
      if(ctx.placement?.[r.id]==='proxy')out.placement='proxy';
      return out;
    });
    const zoneIds=new Set(s.spec.zones.map(z=>z.id));
    for(const z of s.spec.zones)if(z.near&&!zoneIds.has(z.near)&&!s.known.locations.has(z.near))s.issues.push(diagnostic('ZONE_NEAR_UNKNOWN','$.zones','near 指向的地点不在本分支引用表中，已忽略该提示',{severity:'warning',entityId:z.id}));
    s.spec.links=collectAndMerge(s,'links',LIMITS.links,'routes',r=>{
      const row=ctx.routesById?.[r.id],locked=ctx.locks?.routes?.[r.id],out={};
      const from=row?.from_location_id??null,to=row?.to_location_id??null;
      if(from)out.fromLocationId=from;if(to)out.toLocationId=to;
      const fp=from?pointOf(from):null,tp=to?pointOf(to):null;
      if(fp)out.fromSite=fp;if(tp)out.toSite=tp;
      if(locked?.path?.length>=2)out.locked={quality:locked.quality==='confirmed'?'confirmed':'estimated',path:locked.path,fromLocationId:locked.fromLocationId??from,toLocationId:locked.toLocationId??to};
      return out;
    });
    s.spec.features=collectAndMerge(s,'features',LIMITS.features,null,r=>{
      // G05：type 非法 → 抛出带 path/id 的单项目诊断，由 collection 捕获后跳过该项；其余图元照常生成。
      if(!OVERVIEW_FEATURE_TYPES.includes(r.type))throw new Error('FEATURE_TYPE_UNSUPPORTED');
      const out={type:r.type};
      if(typeof r.zoneId==='string'&&r.zoneId)out.zoneId=r.zoneId;
      if(r.density!==undefined){if(!OVERVIEW_DENSITIES.includes(r.density))throw new Error('FEATURE_DENSITY_UNSUPPORTED');out.density=r.density;}
      if(r.type==='watercourse'){
        // 02 §10：水系只给方向与宽度类别，路径由程序生成；缺方向就没有可绘制的河，按单项错误处理。
        if(!OVERVIEW_SECTORS.includes(r.fromSector)||!OVERVIEW_SECTORS.includes(r.toSector)||r.fromSector===r.toSector)throw new Error('WATERCOURSE_SECTOR_REQUIRED');
        out.fromSector=r.fromSector;out.toSector=r.toSector;
        if(r.widthClass!==undefined){if(!OVERVIEW_WIDTH_CLASSES.includes(r.widthClass))throw new Error('WATERCOURSE_WIDTH_UNSUPPORTED');out.widthClass=r.widthClass;}
      }else{
        if(r.fromSector!==undefined||r.toSector!==undefined)throw new Error('FEATURE_SECTOR_UNSUPPORTED');
        if(OVERVIEW_WIDTH_CLASSES.includes(r.widthClass))out.widthClass=r.widthClass;
      }
      return out;
    });
    s.spec.features=s.spec.features.filter(f=>{
      if(!f.zoneId||zoneIds.has(f.zoneId))return true;
      s.issues.push(diagnostic('FEATURE_ZONE_UNKNOWN','$.features','feature 指向的 zone 不在本图约束中，已跳过该装饰',{severity:'warning',entityId:f.id}));
      return false;
    });
    return finish(s,ctx,O.overview);
  }catch(e){return failure(String(e.message),'$','生成请求不可用；保留已保存布局',{kept:context?.previousScene?clone(context.previousScene):null});}
}
