export const KIT_VERSION = 'atlas-spatial-kit/1';
export const SCENE_KIND = 'atlas-scene';
export const SCENE_VERSION = 1;
export const FRAME_SCENE_KEY = 'atlasScene';
export const LIMITS = Object.freeze({inputBytes:65536, sceneBytes:524288, rooms:24, contents:128, actors:128, items:256, districts:16, buildings:64, blocksPerDistrict:24, floorSide:100, roomSide:40, citySide:20000, navigationCells:180000, markers:512, overlays:256, pathPoints:2048});
export const clone = value => JSON.parse(JSON.stringify(value));
export const finite = value => typeof value==='number' && Number.isFinite(value);
export const plain = value => value!==null && typeof value==='object' && !Array.isArray(value);
export const bytes = value => new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value)).length;
export function stable(value){
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  if(plain(value))return '{'+Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
export function diagnostic(code,path,message,{severity='error',entityId=null,retryable=false}={}){
  return {code,path,message,severity,entityId,retryable,module:'atlas-spatial-kit'};
}
export function failure(code,path,message,extra={}){return {ok:false,status:'failed',scene:null,issues:[diagnostic(code,path,message)],...extra};}
export function normalizeScope(value){
  if(!plain(value)||typeof value.chatId!=='string'||!value.chatId||typeof value.branchId!=='string'||!value.branchId||!Number.isInteger(value.revision)||value.revision<0||!['pov','author'].includes(value.viewMode))throw new Error('SCOPE_INVALID');
  return {chatId:value.chatId,branchId:value.branchId,revision:value.revision,viewMode:value.viewMode};
}
export function scopeKey(value){return stable(normalizeScope(value));}
export function sameScope(a,b){try{return scopeKey(a)===scopeKey(b);}catch{return false;}}
export function createScopeGate(){
  let key=null,epoch=0;
  return {setScope(scope){const next=scopeKey(scope);if(next!==key){key=next;epoch++;}return {key,epoch};},capture(){return {key,epoch};},accept(ticket){return key!==null&&ticket?.key===key&&ticket.epoch===epoch;},invalidate(){key=null;epoch++;}};
}
export function parseWholeArguments(value){
  if(plain(value)){if(bytes(value)>LIMITS.inputBytes)throw new Error('INPUT_TOO_LARGE');return clone(value);}
  if(typeof value!=='string'||bytes(value)>LIMITS.inputBytes)throw new Error('INPUT_INVALID');
  const parsed=JSON.parse(value);if(!plain(parsed))throw new Error('INPUT_INVALID');return parsed;
}
export function checkSceneDocument(doc){
  const issues=[];
  if(!plain(doc)||doc.kind!==SCENE_KIND||doc.version!==SCENE_VERSION)return [diagnostic('SCENE_VERSION_UNSUPPORTED','$','不支持的场景文档版本')];
  if(typeof doc.mapId!=='string'||!doc.mapId||typeof doc.branchId!=='string'||!doc.branchId)issues.push(diagnostic('SCENE_ID_INVALID','$.mapId','需要地图与分支标识'));
  if(!['meters','cells'].includes(doc.units)||!plain(doc.layout)||!['floor','city','overview'].includes(doc.layout.kind))issues.push(diagnostic('SCENE_LAYOUT_INVALID','$.layout','需要已生成的布局与明确单位'));
  const b=doc.layout?.bounds;if(!b||![b.x,b.y,b.w,b.h].every(finite)||b.w<=0||b.h<=0)issues.push(diagnostic('SCENE_BOUNDS_INVALID','$.layout.bounds','地图范围必须为有限正尺寸'));
  const shape=doc.layout;
  if(shape?.kind==='floor'&&(!plain(shape.corridor)||!['rooms','groups','bodies','doors','windows','lamps','actors','items'].every(k=>Array.isArray(shape[k]))))issues.push(diagnostic('SCENE_LAYOUT_INCOMPLETE','$.layout','室内场景缺少绘制所需的数组'));
  if(shape?.kind==='city'&&(!plain(shape.river)||!plain(shape.dock)||!['wall','riverPolygon','districts','roads','segments','gates','buildings'].every(k=>Array.isArray(shape[k]))))issues.push(diagnostic('SCENE_LAYOUT_INCOMPLETE','$.layout','城市场景缺少绘制所需的数组'));
  if(shape?.kind==='overview'&&!Array.isArray(shape.pins))issues.push(diagnostic('SCENE_LAYOUT_INCOMPLETE','$.layout.pins','概览场景缺少标点数组'));
  const rect=p=>plain(p)&&[p.x,p.y,p.w,p.h].every(finite)&&p.w>0&&p.h>0;
  const point=p=>plain(p)&&finite(p.x)&&finite(p.y);
  const polygon=p=>Array.isArray(p)&&p.length>=3&&p.every(point);
  const bad=(value,validate,path)=>{if(!validate(value))issues.push(diagnostic('SCENE_GEOMETRY_INVALID',path,'保存的几何字段不可绘制，使用 SQL 概览'));};
  const collection=(key,validate,max=4096)=>{
    if(!Array.isArray(shape?.[key]))return;
    if(shape[key].length>max){issues.push(diagnostic('SCENE_COLLECTION_LIMIT','$.layout.'+key,'保存的几何集合超出预算'));return;}
    for(let i=0;i<shape[key].length;i++)bad(shape[key][i],validate,'$.layout.'+key+'['+i+']');
  };
  if(shape?.kind==='floor'){
    bad(shape.corridor,rect,'$.layout.corridor');collection('rooms',p=>rect(p)&&['north','south'].includes(p.side),LIMITS.rooms);
    collection('groups',p=>rect(p)&&Array.isArray(p.bodies)&&p.bodies.every(rect),LIMITS.contents);collection('bodies',rect);
    collection('actors',point,LIMITS.actors);collection('items',point,LIMITS.items);collection('doors',p=>point(p)&&finite(p.width)&&p.width>0);collection('windows',point);collection('lamps',point);
  }else if(shape?.kind==='city'){
    bad(shape.wall,polygon,'$.layout.wall');bad(shape.riverPolygon,polygon,'$.layout.riverPolygon');bad(shape.dock,p=>point(p)&&finite(p.width)&&p.width>0,'$.layout.dock');
    bad(shape.river,p=>plain(p)&&[p.cx,p.amplitude,p.width,p.height].every(finite)&&p.width>0&&p.height>0,'$.layout.river');
    collection('districts',p=>plain(p)&&polygon(p.polygon)&&point(p.site),LIMITS.districts);collection('buildings',rect);collection('gates',point);
    for(const key of ['roads','segments'])collection(key,p=>plain(p)&&point(p.a)&&point(p.b)&&finite(p.width)&&p.width>0);
  }else if(shape?.kind==='overview'){
    collection('pins',point);collection('shapes',p=>plain(p)&&polygon(p.polygon));collection('routes',p=>plain(p)&&Array.isArray(p.path)&&p.path.length>=2&&p.path.length<=LIMITS.pathPoints&&p.path.every(point));
  }
  if(doc.units==='meters'&&(!finite(doc.metersPerCell)||doc.metersPerCell<=0))issues.push(diagnostic('SCENE_METRIC_INVALID','$.metersPerCell','米制场景需要每格米数'));
  const visited=new Set();let invalidNumber=null,invalidCycle=false;
  function scan(value,path,depth=0){
    if(typeof value==='number'&&!finite(value))invalidNumber??=path;
    if(value&&typeof value==='object'){
      if(visited.has(value)||depth>40){invalidCycle=true;return;}
      visited.add(value);for(const [key,child] of Object.entries(value))scan(child,path+'.'+key,depth+1);visited.delete(value);
    }
  }
  scan(doc,'$');
  if(invalidNumber)issues.push(diagnostic('SCENE_NUMBER_INVALID',invalidNumber,'场景坐标和尺寸必须是有限数值'));
  if(invalidCycle)issues.push(diagnostic('SCENE_STRUCTURE_INVALID','$','场景不得含循环或过深结构'));
  try{if(bytes(doc)>LIMITS.sceneBytes)issues.push(diagnostic('SCENE_TOO_LARGE','$','场景超过 512 KiB，保留原场景'));}catch{issues.push(diagnostic('SCENE_SERIALIZATION_FAILED','$','场景无法序列化'));}
  return issues;
}
