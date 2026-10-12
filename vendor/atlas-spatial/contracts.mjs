export const KIT_VERSION = 'atlas-spatial-kit/1';
export const SCENE_KIND = 'atlas-scene';
export const SCENE_VERSION = 1;
export const FRAME_SCENE_KEY = 'atlasScene';
/**
 * P12/R03 §19.1：空间权威（`SpaceCanonicalV1`）在 frame 里的命名空间。
 * 只此一处字面量：宿主 TS 侧从本模块导入，不另写第二份字符串。
 */
export const FRAME_SPACE_CANONICAL_KEY = 'atlasSpaceCanonical';
/** 首版陈设条目上限：超限明确 deferred，不静默裁剪、不放宽预算。 */
export const SPACE_CANONICAL_MAX_FURNISHING = 128;
/**
 * P12/R03 §19.4：布局陈设的稳定空间 localId = `space:<地点ID>:furn:<局部ID>`。
 *
 * 它是**布局**标识，不是 SQL entityId —— 真实实体 ID 永不被误认：`parseSpaceLocalId` 对
 * 任何不匹配的字符串一律返回 null（包括 `I_DESK` 这类真实物品 ID）。三个使用点
 * （host-context / generation / storage）都从这里取，不各写一份字面量。
 */
export function spaceLocalId(locationId, contentId) {
  if (typeof locationId !== 'string' || !locationId) return null;
  if (typeof contentId !== 'string' || !contentId) return null;
  return 'space:' + locationId + ':furn:' + contentId;
}
export function parseSpaceLocalId(value) {
  if (typeof value !== 'string' || !value.startsWith('space:')) return null;
  const rest = value.slice(6), at = rest.indexOf(':furn:');
  if (at <= 0) return null;
  const locationId = rest.slice(0, at), contentId = rest.slice(at + 6);
  return locationId && contentId ? { locationId, contentId } : null;
}
export const LIMITS = Object.freeze({inputBytes:65536, sceneBytes:524288, rooms:24, contents:128, actors:128, items:256, districts:16, buildings:64, blocksPerDistrict:24, floorSide:100, roomSide:40, citySide:20000, navigationCells:180000, markers:512, overlays:256, pathPoints:2048, zones:64, features:128, links:128, watercourseSegments:24});
/** 02 §10：概览地物类型（含水系 watercourse）。与 src/atlas-ops-normalize.ts 的归一化口径逐字一致。 */
export const OVERVIEW_FEATURE_TYPES = Object.freeze(['forest_texture','ridge','shore','building_cluster','road_texture','ruins_scatter','watercourse']);
/** 概览表面类型。 */
export const OVERVIEW_SURFACES = Object.freeze(['mixed','urban','forest','mountain','water','indoor','void']);
/** 概览分区角色。 */
export const OVERVIEW_ZONE_ROLES = Object.freeze(['city','settlement','forest','water','mountain','ruins','district','campus','land','other']);
/** 概览分区尺寸分档（初始半径由生成器按最短边换算）。 */
export const OVERVIEW_ZONE_SIZES = Object.freeze(['small','medium','large']);
export const OVERVIEW_DENSITIES = Object.freeze(['low','medium','high']);
/** 02 §10：watercourse 的 8 方向（center 对首尾无意义）。 */
export const OVERVIEW_SECTORS = Object.freeze(['north','northeast','east','southeast','south','southwest','west','northwest']);
export const OVERVIEW_WIDTH_CLASSES = Object.freeze(['narrow','medium','wide']);
/** G07：城市边界策略。旧档无该字段时不得改写既有城墙输出。 */
export const CITY_ENCLOSURES = Object.freeze(['open','wall']);
/** 场景内几何质量标记：估计与已确认。 */
export const SCENE_QUALITIES = Object.freeze(['estimated','confirmed']);
/**
 * P06/N01：概览「自身示意」的范围质量与来源。
 * - quality=layout：程序按有效 frame 生成的矩形示意（未标定/未确认轮廓）；
 * - quality=confirmed：只有作者确认过的轮廓（areas 锁）才能标 confirmed —— 确认宽高不等于确认轮廓。
 * - source=frame|canonical 分别表示来自 frame 幅面还是已确认目录。
 */
export const SELF_AREA_QUALITIES = Object.freeze(['layout','confirmed']);
export const SELF_AREA_SOURCES = Object.freeze(['frame','canonical']);
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
  // 字符串同样受 64 KiB 输入预算约束：超限给明确的 INPUT_TOO_LARGE，不静默截断、不误报成格式错误。
  if(typeof value!=='string')throw new Error('INPUT_INVALID');
  if(bytes(value)>LIMITS.inputBytes)throw new Error('INPUT_TOO_LARGE');
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
  if(shape?.kind==='city'&&(!(plain(shape.river)||shape.river===null)||!(plain(shape.dock)||shape.dock===null)||!['wall','riverPolygon','districts','roads','segments','gates','buildings'].every(k=>Array.isArray(shape[k]))))issues.push(diagnostic('SCENE_LAYOUT_INCOMPLETE','$.layout','城市场景缺少绘制所需的数组'));
  if(shape?.kind==='overview'&&!['pins','shapes','routes','features'].every(k=>Array.isArray(shape[k])))issues.push(diagnostic('SCENE_LAYOUT_INCOMPLETE','$.layout','概览场景缺少绘制所需的数组'));
  const rect=p=>plain(p)&&[p.x,p.y,p.w,p.h].every(finite)&&p.w>0&&p.h>0;
  const point=p=>plain(p)&&finite(p.x)&&finite(p.y);
  const polygon=p=>Array.isArray(p)&&p.length>=3&&p.every(point);
  // 概览几何必须落在声明范围内；容差按尺寸缩放，避免浮点抖动误伤合法场景。
  const eps=(b&&finite(b.w)&&finite(b.h))?1e-6*Math.max(1,Math.abs(b.w),Math.abs(b.h)):1e-6;
  const inside=p=>point(p)&&p.x>=b.x-eps&&p.x<=b.x+b.w+eps&&p.y>=b.y-eps&&p.y<=b.y+b.h+eps;
  const bad=(value,validate,path)=>{if(!validate(value))issues.push(diagnostic('SCENE_GEOMETRY_INVALID',path,'保存的几何字段不可绘制，使用 SQL 概览'));};
  const collection=(key,validate,max=4096)=>{
    if(!Array.isArray(shape?.[key]))return;
    if(shape[key].length>max){issues.push(diagnostic('SCENE_COLLECTION_LIMIT','$.layout.'+key,'保存的几何集合超出预算'));return;}
    for(let i=0;i<shape[key].length;i++)bad(shape[key][i],validate,'$.layout.'+key+'['+i+']');
  };
  if(shape?.kind==='floor'){
    bad(shape.corridor,p=>rect(p)||(plain(p)&&[p.x,p.y,p.w,p.h].every(finite)&&p.w===0&&p.h===0&&shape.rooms?.length===1),'$.layout.corridor');
    // P11/R03 §18.1：命名走廊绑定。程序几何 ID 永远是 'corridor'，实体身份可选；
    // 绑定的地点**不得**同时出现在普通 rooms 里（同一实体只表达一次）。
    const c=shape.corridor;
    if(plain(c)&&c.entityId!==undefined&&c.entityId!==null){
      if(typeof c.entityId!=='string'||!c.entityId)issues.push(diagnostic('SCENE_CORRIDOR_INVALID','$.layout.corridor.entityId','命名走廊绑定需要真实地点引用'));
      else if(Array.isArray(shape.rooms)&&shape.rooms.some(r=>r&&r.id===c.entityId))issues.push(diagnostic('SCENE_CORRIDOR_DUPLICATED','$.layout.corridor.entityId','绑定的走廊地点不得同时出现在普通房间列表中'));
    }
    if(plain(c)&&c.name!==undefined&&c.name!==null&&typeof c.name!=='string')issues.push(diagnostic('SCENE_CORRIDOR_INVALID','$.layout.corridor.name','命名走廊的名称必须是字符串'));
    collection('rooms',p=>rect(p)&&['north','south'].includes(p.side),LIMITS.rooms);
    collection('groups',p=>rect(p)&&Array.isArray(p.bodies)&&p.bodies.every(rect),LIMITS.contents);collection('bodies',rect);
    collection('actors',point,LIMITS.actors);collection('items',point,LIMITS.items);collection('doors',p=>point(p)&&finite(p.width)&&p.width>0);collection('windows',point);collection('lamps',point);
  }else if(shape?.kind==='city'){
    const enclosure=shape.enclosure;
    if(enclosure!==undefined&&!CITY_ENCLOSURES.includes(enclosure))issues.push(diagnostic('SCENE_ENUM_INVALID','$.layout.enclosure','城市边界策略非法'));
    // G07：open 城市不允许留假城墙/城门；enclosure=wall 与旧档（无该字段）保留原多边形校验。
    if(enclosure==='open'){
      if(!(Array.isArray(shape.wall)&&shape.wall.length===0))issues.push(diagnostic('SCENE_GEOMETRY_INVALID','$.layout.wall','开放城市不得保留城墙多边形，使用 SQL 概览'));
      if(!(Array.isArray(shape.gates)&&shape.gates.length===0))issues.push(diagnostic('SCENE_GEOMETRY_INVALID','$.layout.gates','开放城市不得保留城门，使用 SQL 概览'));
    }else{
      bad(shape.wall,polygon,'$.layout.wall');
    }
    if(shape.river!==null){bad(shape.riverPolygon,polygon,'$.layout.riverPolygon');bad(shape.dock,p=>point(p)&&finite(p.width)&&p.width>0,'$.layout.dock');
      bad(shape.river,p=>plain(p)&&[p.cx,p.amplitude,p.width,p.height].every(finite)&&p.width>0&&p.height>0,'$.layout.river');}
    else if(shape.riverPolygon?.length||shape.dock!==null)issues.push(diagnostic('SCENE_GEOMETRY_INVALID','$.layout.river','无河流的城市不能保留水域或码头'));
    collection('districts',p=>plain(p)&&polygon(p.polygon)&&point(p.site),LIMITS.districts);collection('buildings',rect);collection('gates',point);
    for(const key of ['roads','segments'])collection(key,p=>plain(p)&&point(p.a)&&point(p.b)&&finite(p.width)&&p.width>0);
  }else if(shape?.kind==='overview'){
    if(shape.surface!==undefined&&!OVERVIEW_SURFACES.includes(shape.surface))issues.push(diagnostic('SCENE_ENUM_INVALID','$.layout.surface','概览表面类型非法'));
    const feature=p=>{
      if(!plain(p)||typeof p.id!=='string'||!p.id||!OVERVIEW_FEATURE_TYPES.includes(p.type))return false;
      // 可选字段显式 null 视为"未提供"：概览装饰允许 zoneId:null（全图材质）。
      if(p.density!==undefined&&p.density!==null&&!OVERVIEW_DENSITIES.includes(p.density))return false;
      if(p.zoneId!==undefined&&p.zoneId!==null&&(typeof p.zoneId!=='string'||!p.zoneId))return false;
      if(p.decorative!==undefined&&typeof p.decorative!=='boolean')return false;
      if(p.quality!==undefined&&p.quality!==null&&!SCENE_QUALITIES.includes(p.quality))return false;
      if(p.fromSector!==undefined&&p.fromSector!==null&&!OVERVIEW_SECTORS.includes(p.fromSector))return false;
      if(p.toSector!==undefined&&p.toSector!==null&&!OVERVIEW_SECTORS.includes(p.toSector))return false;
      if(p.widthClass!==undefined&&p.widthClass!==null&&!OVERVIEW_WIDTH_CLASSES.includes(p.widthClass))return false;
      // 02 §10：水系必须带可绘制的 Bezier 离散路径与正宽度，不能退化成蓝色圆点。
      if(p.type==='watercourse'){
        if(!Array.isArray(p.path)||p.path.length<LIMITS.watercourseSegments+1||!p.path.every(inside))return false;
        if(!(finite(p.width)&&p.width>0))return false;
        if(p.decorative===true&&p.quality!==undefined&&p.quality!=='estimated')return false;
      }
      return true;
    };
    const shapeRef=p=>plain(p)&&polygon(p.polygon)&&p.polygon.every(inside);
    const routeRef=p=>plain(p)&&Array.isArray(p.path)&&p.path.length>=2&&p.path.every(inside);
    collection('pins',inside,LIMITS.markers);
    collection('shapes',shapeRef,LIMITS.zones);
    collection('routes',routeRef,LIMITS.links);
    collection('features',feature,LIMITS.features);
    // P06/N01：自身示意是**当前地图容器**的范围示意，不是新地点，也不是普通 shape。
    // 它不属于 shapes/features 的实体回写列表，因此这里单独校验（可选字段：旧档没有也合法）。
    if(shape.selfArea!==undefined&&shape.selfArea!==null){
      const sa=shape.selfArea,ok=plain(sa)&&typeof sa.locationId==='string'&&!!sa.locationId
        &&Array.isArray(sa.polygon)&&sa.polygon.length>=3&&sa.polygon.every(inside)
        &&SELF_AREA_QUALITIES.includes(sa.quality)&&SELF_AREA_SOURCES.includes(sa.source);
      if(!ok)issues.push(diagnostic('SCENE_SELF_AREA_INVALID','$.layout.selfArea','自身示意需要合法的容器引用、范围多边形、质量与来源'));
    }
    for(let i=0;i<(Array.isArray(shape.routes)?shape.routes.length:0);i++){
      const path=shape.routes[i]?.path;
      if(Array.isArray(path)&&path.length>LIMITS.pathPoints)issues.push(diagnostic('SCENE_COLLECTION_LIMIT','$.layout.routes['+i+'].path','路径点数超出预算'));
    }
    for(let i=0;i<(Array.isArray(shape.features)?shape.features.length:0);i++){
      const path=shape.features[i]?.path;
      if(Array.isArray(path)&&path.length>LIMITS.pathPoints)issues.push(diagnostic('SCENE_COLLECTION_LIMIT','$.layout.features['+i+'].path','水系路径点数超出预算'));
    }
    // 局部 ID 唯一：图元（shape/route/feature）共享同一局部命名空间；pins 携带实体 ID，不参与。
    const seen=new Map();
    for(const key of ['shapes','routes','features']){
      const list=shape[key];if(!Array.isArray(list))continue;
      for(let i=0;i<list.length;i++){const id=list[i]?.id;if(typeof id!=='string'||!id)continue;const path='$.layout.'+key+'['+i+'].id';
        if(seen.has(id))issues.push(diagnostic('SCENE_ID_DUPLICATE',path,'概览局部 ID 必须唯一：'+id+' 已在 '+seen.get(id)+' 使用'));else seen.set(id,path);}
    }
  }
  if(doc.units==='meters'&&(!finite(doc.metersPerCell)||doc.metersPerCell<=0))issues.push(diagnostic('SCENE_METRIC_INVALID','$.metersPerCell','米制场景需要每格米数'));
  // 02 §6.2：允许完全未标定的 cells + null mpp；格制若带换算则必须是有限正数（防 NaN 混入）。
  if(doc.units==='cells'&&doc.metersPerCell!==null&&doc.metersPerCell!==undefined&&(!finite(doc.metersPerCell)||doc.metersPerCell<=0))issues.push(diagnostic('SCENE_METRIC_INVALID','$.metersPerCell','格制场景的米制换算必须是有限正数或未标定空值'));
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
