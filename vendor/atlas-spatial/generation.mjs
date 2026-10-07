import * as E from './layout-core.mjs';
import {KIT_VERSION,SCENE_KIND,SCENE_VERSION,LIMITS,clone,finite,plain,stable,bytes,normalizeScope,diagnostic,failure,parseWholeArguments,checkSceneDocument} from './contracts.mjs';

const label=v=>typeof v==='string'?v.slice(0,120):'';
const ids=v=>new Set(v instanceof Set?v:Array.isArray(v)?v:[]);
const sort=rows=>rows.sort((a,b)=>a.id.localeCompare(b.id,'en'));
function setup(value,context,kind){
  const scope=normalizeScope(context.scope),input=parseWholeArguments(value),map=context.map;
  if(!plain(map)||typeof map.id!=='string'||!map.id)throw new Error('MAP_CONTEXT_REQUIRED');
  if(input.mapId!==undefined&&input.mapId!==map.id)throw new Error('MAP_ID_MISMATCH');
  if(input.id!==undefined&&input.id!==map.id)throw new Error('MAP_ID_MISMATCH');
  if(context.currentScope&&!same(context.currentScope,scope))throw new Error('STALE_SCOPE');
  const known={locations:ids(context.entities?.locations),characters:ids(context.entities?.characters),items:ids(context.entities?.items)};
  let w=input.width,h=input.height,mpp=map.metersPerCell,metricProposal=null;
  const f=map.frame||{},cols=f.cols??f.reference_width_cells,rows=f.rows??f.reference_height_cells;
  if(finite(mpp)&&mpp>0&&finite(cols)&&cols>0&&finite(rows)&&rows>0){w=cols*mpp;h=rows*mpp;}
  if(!finite(w)||!finite(h)||w<=0||h<=0)throw new Error('EXTENT_REQUIRED');
  if(!finite(mpp)||mpp<=0){
    if(map.scaleLocked)throw new Error('SCALE_LOCKED_UNCALIBRATED');
    if(!finite(cols)||!finite(rows)||cols<=0||rows<=0)throw new Error('FRAME_REQUIRED_FOR_CALIBRATION');
    const a=w/cols,b=h/rows;if(Math.abs(a-b)/Math.max(a,b)>.01)throw new Error('SCALE_ASPECT_CONFLICT');
    mpp=a;metricProposal={metersPerCell:mpp,scaleQuality:'estimated',basis:{source:'layout-extent',widthM:w,heightM:h}};
  }
  if((kind==='floor'&&(w>LIMITS.floorSide||h>LIMITS.floorSide))||(kind==='city'&&(w>LIMITS.citySide||h>LIMITS.citySide)))throw new Error('EXTENT_TOO_LARGE');
  const issues=[],spec={id:map.id,parentId:map.containerLocationId??null,name:label(map.name)||label(input.name)||map.id,width:w,height:h};
  return {scope,input,map,known,spec,issues,mpp,metricProposal,previous:context.previousScene??null};
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
const MERGEABLE_KEYS=['rooms','contents','actors','items','districts','buildings'];
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
  const scene={kind:SCENE_KIND,version:SCENE_VERSION,generator:KIT_VERSION,mapId:s.map.id,branchId:s.scope.branchId,sourceRevision:s.scope.revision,units:'meters',metersPerCell:s.mpp,metricQuality:s.metricProposal?'estimated':s.map.scaleQuality??'estimated',inputSignature,layout};
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
    s.spec.rooms=collectAndMerge(s,'rooms',LIMITS.rooms,'locations',r=>{const d=ctx.locks?.rooms?.[r.id]?.w>0?dimensions(ctx.locks.rooms[r.id]):dimensions(r);if(d.w>LIMITS.roomSide||d.h>LIMITS.roomSide||!['north','south'].includes(r.side))throw new Error('ROOM_CONSTRAINT_UNSUPPORTED');const locked=trustedLock(ctx,'rooms',r.id);return {...d,side:r.side,...(locked?{locked}:{} )};});
    s.spec.singleRoom=s.spec.rooms.length===1&&s.spec.rooms[0].id===s.map.containerLocationId;
    if(!s.spec.rooms.length){const failed=failure('NO_VALID_ROOMS','$.rooms','没有可生成的有效房间',{kept:s.previous?clone(s.previous):null});failed.issues.push(...s.issues);return failed;}
    if(s.spec.rooms.reduce((n,r)=>n+Math.ceil(r.w/.2)*Math.ceil(r.h/.2),0)>LIMITS.navigationCells)throw new Error('NAVIGATION_BUDGET_EXCEEDED');
    const roomIds=new Set(s.spec.rooms.map(r=>r.id));
    s.spec.contents=collectAndMerge(s,'contents',LIMITS.contents,null,r=>{if(!roomIds.has(r.roomId))throw new Error('ROOM_REF_UNKNOWN');if(!['reading','shelf','desk','bench','stairs'].includes(r.type))throw new Error('FURNITURE_TYPE_UNSUPPORTED');const locked=trustedLock(ctx,'contents',r.id);return {...dimensions(r),roomId:r.roomId,type:r.type,...(locked?{locked}:{})};});
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
    s.constraintKeys=['riverWidth','seed','blocksPerDistrict','districts','buildings'];
    if(s.input.riverWidth!==undefined&&(!finite(s.input.riverWidth)||s.input.riverWidth<0))return failure('RIVER_CONSTRAINT_INVALID','$.riverWidth','河宽应为非负数，零表示无水系',{kept:s.previous?clone(s.previous):null});
    s.spec.riverWidth=s.input.riverWidth??0;
    s.spec.seed=label(context.seed)||s.map.id; // The program provides the seed; the AI cannot reshuffle a saved city.
    s.spec.blocksPerDistrict=Number.isInteger(s.input.blocksPerDistrict)?Math.max(0,Math.min(LIMITS.blocksPerDistrict,s.input.blocksPerDistrict)):8;
    s.spec.districts=collectAndMerge(s,'districts',LIMITS.districts,'locations',r=>{if(!['west','east'].includes(r.bank)||!finite(r.order))throw new Error('DISTRICT_CONSTRAINT_INVALID');return {bank:r.bank,order:r.order};});
    const districtIds=new Set(s.spec.districts.map(d=>d.id));
    s.spec.buildings=collectAndMerge(s,'buildings',LIMITS.buildings,'locations',r=>{if(!districtIds.has(r.districtId))throw new Error('DISTRICT_REF_UNKNOWN');const locked=trustedLock(ctx,'buildings',r.id);return {...(ctx.locks?.buildings?.[r.id]?.w>0?dimensions(ctx.locks.buildings[r.id]):dimensions(r)),districtId:r.districtId,...(locked?{locked}:{})};});
    return finish(s,ctx,E.city);
  }catch(e){return failure(String(e.message),'$','生成请求不可用；保留已保存布局',{kept:context?.previousScene?clone(context.previousScene):null});}
}
