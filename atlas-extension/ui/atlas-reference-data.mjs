/** Real SQL DTOs projected into the supplied UI's data contract. Never writes a world. */
import { visibleWorkbenchMaps } from './atlas-workbench-data.mjs';
import { projectReferenceFlows } from './atlas-reference-flows.mjs';
import { projectMapContext } from './atlas-map-context.mjs';
import { projectSpaceNavigation } from './atlas-space-navigation.mjs';
import { projectExplorationMaps } from './atlas-exploration-map.mjs';

/** Descriptive categories, independent of the actual parent/child map tree. */
const MAP_CATEGORY_NAMES = {
  world:'世界',region:'地区',city:'城市',district:'街区',building:'建筑',floor:'楼层',
  room:'房间',detail:'陈设',other:'场所',vehicle:'载具',natural:'自然区域',
};
const COLORS = ['#43e0ff','#9b6bff','#ffc247','#39e0a0','#7fd4ff','#ff5f92'];

/** M6-02：「未挂接」分组的稳定 ID。坏图不随便挂到某座城市下。 */
export const UNCLASSIFIED = '__unclassified__';
/** 旧适配器用 'world' 表示「挂在世界根」；只在没有同名地图时才按哨兵解释。 */
const ROOT_SENTINEL = 'world';

/** Real place types describe a map; renderKind separately chooses its drawing template. */
const NEUTRAL_CATEGORY_LABELS = {other:'场所',vehicle:'载具',natural:'自然区域'};
function navigationCategoryLabel(map) {
  return NEUTRAL_CATEGORY_LABELS[text(map?.containerLocationKind)] ?? null;
}
function navigationKind(map, geometricKind) {
  const containerKind = text(map?.containerLocationKind);
  return containerKind || geometricKind;
}
const items = dto => Array.isArray(dto?.items) ? dto.items : [];
const text = value => String(value ?? '');
const point = p => Array.isArray(p) ? p : [p?.x,p?.y];
const finite = p => point(p).every(Number.isFinite);

/**
 * M6-03④：`placement==='proxy'`（生成器）/ `placementKind==='proxy'`（世界契约）都表示同一件事——
 * 这东西的**坐标在别的图上**，本图只画一个「入口示意」。
 *
 * 纪律：示意图标保留可点击的真实实体 id（点进去看真地点），但绝不允许
 * 它的坐标被当作实测坐标冒充实测精度 —— 所以下面凡是 proxy，quality 一律降为 'proxy'。
 */
const placementOf = value => {
  const raw = text(value?.placement ?? value?.placementKind);
  return raw === 'proxy' ? 'proxy' : null;
};
/** 渲染类别：旧画法只认这几个「类」，真实 type 另存在 `type` 字段，别在这里丢信息。 */
const LEGACY_FURN_CLASS = {bench:'table', chair:'table', stairs:'desk'};

export function emptyReferenceData(meta = {}) {
  return {meta:{worldName:'尚未建立世界',turn:0,revision:0,timeMinutes:0,viewMode:'player',initialNodeId:'world',...meta},
    ROOT:{id:'world',name:meta.worldName||'尚未建立世界',kind:'world',tag:'世界',children:[],geo:{},marks:[],host:true},
    LOCATIONS:[],CAST:[],ITEMS:[],MESSAGES:[],TASKS:[],EVENTS:[],RECEIPTS:[],LORE:[],DIAGNOSTICS:[],FLOWS:{},JOURNEYS:{},PROMPTS:[]};
}

/** Last-error strings and database DTOs also pass this boundary before display/export. */
function safeLogRecord(raw){
  try{return JSON.parse(JSON.stringify(raw, (key,value)=>{
    if(/^(?:apiKey|api_key|authorization|headers|requestHeaders|request|prompt|rawResponse|responseText|endpoint)$/i.test(key))return undefined;
    return typeof value==='string'?value.replace(/sk-[A-Za-z0-9_-]{4,}/g,'[redacted]')
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{4,}/gi,'Bearer [redacted]')
      .replace(/((?:api[_-]?key|authorization|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,'$1[redacted]')
      .replace(/https?:\/\/[^\s"'<>]+/gi,'[endpoint]'):value;
  }));}catch{return {code:'DIAGNOSTIC_UNREADABLE',level:'warn',message:'日志条目无法序列化'};}
}
export function referenceDiagnostics(rows=[]){return rows.map((raw,i)=>{
  const l=safeLogRecord(raw)??{};
  const partial=l.kind==='failed_turn'&&l.status==='partial';
  const original=l.at??l.createdAt??l.t;
  const valid=(typeof original==='number'||typeof original==='string')&&Number.isFinite(new Date(original).getTime());
  const at=valid?new Date(original).toISOString():l.observedAt??new Date().toISOString();
  return {...l,id:l.logId??l.id??`log-${i}`,at,t:at,...(!valid?{observedAt:at,timestampSource:'observed'}:{}),
    level:l.level??(partial?'warn':l.kind==='issue'||l.kind==='failed_turn'?'error':'info'),
    code:l.code??(partial?'TURN_PARTIAL':l.kind==='failed_turn'?'TURN_FAILED':l.kind??'WORLD_LOG'),
    message:l.message??l.summary??(l.kind==='failed_turn'?`推演${partial?'部分提交':'失败'} · ${l.receipt?.issues?.length??l.issues?.length??l.issueCount??0} 项问题`:l.code??''),
    details:l.details??l.issues??l.receipt?.issues??null};
});}
export function referenceReceipts(state={},logs=[]){return (state.receipts??[]).filter(r=>!r.chatId||r.chatId===state.chatId).map((r,i)=>({id:r.receiptId??r.receipt?.receiptId??`receipt-${i}`,turn:(state.receipts?.length??0)-i,t:typeof r.recordedAt==='number'?new Date(r.recordedAt).toLocaleString('zh-CN',{hour12:false}):text(r.recordedAt??r.at??''),ok:r.status==='committed'||r.status==='duplicate'||r.receipt?.status==='committed'||r.ok===true,status:r.status??r.receipt?.status??'unknown',retryable:r.retryable===true&&i===0&&!!state.retryableCommit,
  m:text(r.summary??r.receipt?.summary??r.message??r.status??'推演回执'),issue:text(r.errorCode??r.receipt?.issues?.[0]?.code??''),detail:r.detail??null,report:referenceReceiptReport(r.detail),logs:logs.filter(l=>l.turnId===r.receiptId)}));}

/**
 * P14/§21.3：地图类回执的三层报告（纯派生，UI 只负责画）。
 *
 * 三条纪律：
 *  1. 「世界数据已保存」只由最终 ACK（coreSaved）决定 —— 「请求已发出」不算保存。
 *  2. 「布局：…」只能来自真实证据：本次动作真的产出了场景（sceneSaved）或逐图场景汇总
 *     （build.sceneSummary）。coreSaved=true 但**没有场景**（例如官道这类 other 容器）
 *     一律算「更新失败」，绝不显示「生成完成」。
 *  3. 「缺漏与语义」只报**计数与分类**，不把实体 ID、隐藏成员或源文塞进文案。
 *
 * 非地图回执（没有 operation）返回 null：普通推演回执不该被扣一顶「布局失败」的帽子。
 */
export function referenceReceiptReport(detail){
  const d=detail&&typeof detail==='object'?detail:null;
  if(!d||typeof d.operation!=='string'||!d.operation)return null;
  const issues=[];
  // 同一个问题可能同时出现在 detail.issues 和 receipt.issues（两条真实通道）；
  // 按同一具体问题去重；同一路径上的不同陈设失败仍须分别计数。
  const seenIssues=new Set();
  for(const list of [d.issues,d.receipt?.issues])for(const item of Array.isArray(list)?list:[]){
    const key=typeof item?.code==='string'?JSON.stringify([item.code,item.path??'',item.message??'']):null;
    if(key){if(seenIssues.has(key))continue;seenIssues.add(key);}
    issues.push(item);
  }
  const codes=issues.map(i=>text(i?.code)).filter(Boolean);
  const coreSaved=d.coreSaved===true;
  const scene=d.build&&typeof d.build==='object'&&d.build.sceneSummary&&typeof d.build.sceneSummary==='object'
    ?{ready:Number(d.build.sceneSummary.ready)||0,partial:Number(d.build.sceneSummary.partial)||0,missing:Number(d.build.sceneSummary.missing)||0}
    :null;
  const unsupported=codes.some(code=>/UNSUPPORTED/.test(code));
  const layout=!coreSaved?'failed'
    :scene?(scene.ready>0&&scene.partial===0&&scene.missing===0?'ready':scene.ready>0?'partial':unsupported?'unsupported':'failed')
    :d.sceneSaved===true?(issues.some(i=>i?.severity==='error'||i?.code==='DETAIL_NO_SPACE'||i?.code==='LAYOUT_DETAILS_DEFERRED')?'partial':'ready')
    :unsupported?'unsupported'
    :'failed';
  const queue=d.build&&typeof d.build==='object'&&d.build.queue&&typeof d.build.queue==='object'?d.build.queue:null;
  const pendingTargets=queue&&Number.isFinite(queue.pendingTargets)?queue.pendingTargets:null;
  const count=(scene?.missing??0)+issues.length;
  const flags=[];
  if(codes.some(code=>/SCALE|CALIBRAT|METERS_PER_CELL/.test(code)))flags.push('未标定');
  if(codes.some(code=>/SOURCE|CHUNK/.test(code)))flags.push('来源不足');
  if((pendingTargets??0)>0)flags.push(`待处理 ${pendingTargets} 项`);
  return {
    operation:d.operation,
    core:{state:coreSaved?'saved':'unsaved',label:coreSaved?'世界数据已保存':'世界数据未保存（候选已丢弃）'},
    layout:{state:layout,label:`布局：${{ready:'生成完成',partial:'部分完成',unsupported:'暂不支持',failed:'更新失败'}[layout]}`},
    gaps:{count,pendingTargets,flags,label:(count>0||flags.length)
      ?`缺漏与语义：可见缺项 ${count} 个${flags.length?` · ${flags.join(' · ')}`:''}`
      :'缺漏与语义：暂无可见缺项'},
  };
}

/**
 * N03：坐标单位只转换一次。
 *
 * 值全部来自 DTO：不修改 SQL、不修改已保存 scene，也不修改传入对象。
 * - 同单位：原值。
 * - cells → meters：`x * mpp, y * mpp`。
 * - meters → cells：`x / mpp, y / mpp`。
 * - 跨单位但 `mpp` 不是**有限正数**时返回 `null`（失败），绝不默认 `k = 1`：
 *   默认 1 等于把「没有尺度」伪装成「1 米 = 1 格」的实测值 —— 这正是 N03 的原始错误形态。
 */
export function toScenePoint(value, sourceUnits, sceneUnits, metersPerCell) {
  const [x, y] = point(value);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const from = sourceUnits === 'meters' ? 'meters' : 'cells';
  const to = sceneUnits === 'meters' ? 'meters' : 'cells';
  if (from === to) return { x, y };
  const mpp = Number.isFinite(metersPerCell) && metersPerCell > 0 ? metersPerCell : null;
  if (mpp === null) return null;
  return from === 'cells' ? { x: x * mpp, y: y * mpp } : { x: x / mpp, y: y / mpp };
}

/** Convert geometry once; the original renderer keeps its original colors, materials and gestures. */
export function referenceGeometry(map, document, {viewMode='author',visibleLocationIds=[]} = {}) {
  const layout = document?.layout;
  const bounds = layout?.bounds;
  const pins = layout?.pins ?? [];
  const xs = (map.points ?? []).map(p=>p.x).filter(Number.isFinite), ys=(map.points??[]).map(p=>p.y).filter(Number.isFinite);
  const b = bounds ?? {x:Math.min(0,...xs),y:Math.min(0,...ys),w:Math.max(1,Math.max(1,...xs)-Math.min(0,...xs)),h:Math.max(1,Math.max(1,...ys)-Math.min(0,...ys))};
  const scale = Math.min(940/Math.max(1,b.w),560/Math.max(1,b.h));
  const xy = p => {const [x,y]=point(p);return [(x-(b.x??0)-b.w/2)*scale,(y-(b.y??0)-b.h/2)*scale];};
  const rect = r => {const [x,y]=xy(r);return {x,y,w:r.w*scale,h:r.h*scale};};
  const metric = document?.units==='meters' ? 1/scale : typeof map.metersPerCell==='number'&&map.metersPerCell>0 ? map.metersPerCell/scale : null;
  const protagonistIds=new Set((map.points??[]).filter(p=>p.isProtagonist===true).map(p=>p.entityId));
  const rawPins = layout ? [
    ...pins, ...(layout.actors??[]).map(p=>({...p,isProtagonist:p.isProtagonist===true||protagonistIds.has(p.id),type:'person'})), ...(layout.items??[]).map(p=>({...p,type:'item'})),
    ...(layout.rooms??[]).map(r=>({...r,type:'location',silent:true,x:r.x+r.w/2,y:r.y+r.h/2})),
    ...(layout.areas??[]).map(r=>({...r,type:'location',silent:true,x:r.x+r.w/2,y:r.y+r.h/2})),
    /**
     * P11/R03 §18.2 第 9 条：绑定的命名走廊与房间共用同一个地点 ID ——
     * 它是可点击的（点进去就是该地点已有的子图），但和房间一样 `silent`，不额外画一个 POI 图标。
     * 匿名辅助通道没有实体身份，这里什么都不加（它只是一个形状）。
     */
    ...(layout.corridor?.entityId&&layout.corridor.w>0&&layout.corridor.h>0
      ?[{...layout.corridor,id:layout.corridor.entityId,type:'location',silent:true,
        x:layout.corridor.x+layout.corridor.w/2,y:layout.corridor.y+layout.corridor.h/2}]
      :[]),
    ...(layout.districts??[]).filter(d=>d.polygon?.length>=3&&d.polygon.every(finite)).map(d=>({...d,type:'location',silent:true,x:d.polygon.reduce((n,p)=>n+point(p)[0],0)/d.polygon.length,y:d.polygon.reduce((n,p)=>n+point(p)[1],0)/d.polygon.length})),
    ...(layout.buildings??[]).filter(p=>!p.decorative).map(r=>({...r,type:'location',x:r.x+r.w/2,y:r.y+r.h/2})),
  ] : (map.points??[]).map(p=>({...p,id:p.entityId,type:p.kind==='character'?'person':p.kind}));
  const unitDiagnostics=[];
  if(layout){
    /**
     * N03：`map.points` 永远是 **SQL 的格坐标**，而布局里的 pins/actors/items/rooms 已经是
     * `document.units` 场景单位。旧代码把载具的格坐标直接丢进 `rawPins` 再套 `xy()`，
     * 于是 mpp=0.24 的米制场景里 (59.375, 29.1666667) 被画成了 59.375 米而不是 14.25 米。
     * 现在：**先换算一次单位**，再交给同一个 `xy()`；绝不在 `xy()` 之后补换算。
     */
    const sceneUnits=document?.units==='meters'?'meters':'cells';
    const metersPerCell=Number.isFinite(map.metersPerCell)&&map.metersPerCell>0?map.metersPerCell:null;
    const represented=new Set(rawPins.map(p=>text(p.entityId??p.id)));
    for(const p of (map.points??[]).filter(p=>p.mobility==='mobile'||p.kind==='character'||p.kind==='item')){
      // POV 下隐藏载具既不进画面，也不产生诊断（诊断同样可能泄露实体身份）。
      if((viewMode==='pov'||p.mobility==='mobile')&&p.hidden===true||represented.has(text(p.entityId)))continue;
      const converted=toScenePoint(p,'cells',sceneUnits,metersPerCell);
      if(!converted){
        unitDiagnostics.push({code:'POINT_UNIT_UNCONVERTIBLE',entityId:text(p.entityId),mapId:p.mapId??null,
          message:'点位坐标是格制，但当前场景是米制且没有有效的米/格尺度：保留目录身份，不把错误坐标塞进画面或范围。'});
        continue;
      }
      rawPins.push({...p,x:converted.x,y:converted.y,id:p.entityId,type:p.kind==='character'?'person':p.kind==='item'?'item':'location'});
      represented.add(text(p.entityId));
    }
  }
  // 当前容器由标题与已有墙体/边界说明，不再把自己当成图内的子地点。
  const uniquePins=[...new Map(rawPins.filter(p=>finite(p)&&text(p.entityId??p.id)!==text(map.containerLocationId)).map(p=>[`${p.type}:${p.entityId??p.id}`,p])).values()];
  /**
   * M6-03③：示意坐标不许被「升格」成精确。
   *
   * 旧代码 `p.quality??p.markerQuality??p.precision` 只在缺值时留空，本身没升级；
   * 但 proxy 点必须显式降级：它在图上只是为了让人**点得到**，不代表这个人真站在这儿。
   */
  const marks = uniquePins.map((p,i)=>{const [x,y]=xy(p);const proxy=placementOf(p);const quality=proxy?'proxy':text(p.quality??p.markerQuality??p.precision);
    return {id:text(p.entityId??p.id),type:p.type==='person'?'char':p.type==='item'?'item':'poi',
    x,y,name:text(p.name),sub:quality,quality,proxy:proxy==='proxy',
    hero:p.isProtagonist===true,silent:p.silent===true,c:COLORS[i%COLORS.length],locationId:p.locationId??p.roomId??null};});
  const containerKind=map.containerLocationKind;
  const renderKinds=['world','region','city','district','building','floor','room','detail'];
  let kind=renderKinds.includes(containerKind)?containerKind:renderKinds.includes(map.kind)?map.kind:({site:'building',interior:'room'}[map.kind]??'world'),geo={};
  if(layout?.kind==='city') {
    kind='city';
    const river=layout.river;
    geo={districts:(layout.districts??[]).filter(d=>d.polygon?.length>=3&&d.polygon.every(finite)).map((d,i)=>({id:d.id,name:d.name,c:COLORS[i%COLORS.length],pts:d.polygon.map(xy)})),
      river:river?Array.from({length:41},(_,i)=>{const y=(river.height??b.h)*i/40;return xy({x:river.cx+Math.sin((y/(river.height||b.h)*2-.35)*Math.PI)*river.amplitude,y});}):null,
      riverWidth:river?.width?river.width*scale:null,wallPoints:(layout.wall??[]).filter(finite).map(xy),
      cityBuildings:(layout.buildings??[]).filter(p=>!p.decorative).map(r=>({...rect(r),id:r.id,name:r.name})),
      avenues:(layout.roads??[]).filter(r=>finite(r.from??r.a)&&finite(r.to??r.b)).map(r=>({from:xy(r.from??r.a),to:xy(r.to??r.b)})),pois:[]};
  } else if(layout?.kind==='overview') {
    // A SQL overview already contains validated geometry. Keep its paths and
    // footprints instead of reducing the whole map to unconnected markers.
    const qualityById=new Map((map.points??[]).map(p=>[p.entityId,p.area?.quality]));
    const visible=new Set(visibleLocationIds), author=viewMode!=='pov';
    // P06/N01：other 容器的画法是范围概览，不是建筑内景 —— 渲染类别也用中性的 region，
    // 免得渲染器按「建筑」去找楼层/房间几何。
    if(containerKind==='other')kind='region';
    /**
     * M6-03①：轮廓 / 路线端点与路径 / 装饰类型与范围 —— 三样全部走**同一个** `xy`，
     * 保证「只变换一次」；任何一处都不许再套一层变换。
     *
     * 视角过滤在这里**复核一遍**：场景可能来自已保存帧（未经服务器 POV 过滤的下游路径），
     * 也可能来自实时 DTO。复核不改变已有行为，只是不把可见性托付给上游。
     */
    const drawnShapes=(layout.shapes??[]).filter(s=>s?.polygon?.length>=3&&s.polygon.every(finite));
    const drawnZoneIds=new Set(drawnShapes.map(s=>text(s.id)));
    geo={surface:text(layout.surface)||'mixed',
      overviewShapes:drawnShapes.map((s,i)=>{
        // M6-03④：proxy 的坐标在别的图上，这里只是「入口示意」。
        // 保留真实 id 让点击能开到真地点，但精度显式降级，绝不冒充实测。
        const proxy=placementOf(s)==='proxy';
        return {id:text(s.id),name:text(s.name),c:COLORS[i%COLORS.length],
          role:text(s.role)||null,
          quality:proxy?'proxy':text(s.quality||s.area?.quality)||qualityById.get(s.id)||'estimated',
          proxy,placement:proxy?'proxy':null,
          locked:s.locked&&finite(s.locked)?xy(s.locked):null,
          pts:s.polygon.map(xy)};
      }),
      overviewRoutes:(layout.routes??[]).filter(r=>r.path?.length>=2&&r.path.every(finite)
        &&(author||r.hidden!==true&&r.fromLocationId&&r.toLocationId&&visible.has(r.fromLocationId)&&visible.has(r.toLocationId))).map(r=>({
        id:r.id,quality:r.quality,dashed:r.dashed!==false||r.quality!=='confirmed',points:r.path.map(xy),
        from:r.fromLocationId??null,to:r.toLocationId??null,
      })),
      /**
       * M6-03①：装饰保真实 type 与范围（waterside/林地/山脉/路纹…），并标 `decorative`。
       * 装饰**永远不是**实体：这里只产出绘制几何，不产出可点击的假地点，
       * 也绝不因为缺 shape 而补一个新地点出来。
       */
      /**
       * P06/N01：容器自身范围示意。它不是地点、不可点击、也不参与路线端点判断。
       * OTH05：POV 下容器不可见时，连范围、名称与 id 一起不下发（不暗示"这里有个看不见的东西"）。
       */
      selfArea:(()=>{
        const sa=layout.selfArea;
        if(!sa||typeof sa!=='object'||!Array.isArray(sa.polygon)||sa.polygon.length<3||!sa.polygon.every(finite))return null;
        // frame 是计算画布，不是场地轮廓；旧存档的兜底矩形也不能当边界显示。
        if(sa.source!=='canonical'&&sa.quality!=='confirmed')return null;
        const owner=text(sa.locationId);
        if(!author&&!(owner&&visible.has(owner)))return null;
        return {locationId:owner||null,name:text(sa.name)||null,
          quality:text(sa.quality)||'layout',source:text(sa.source)||'frame',
          pts:sa.polygon.map(xy)};
      })(),
      overviewFeatures:(layout.features??[]).filter(f=>f.type!=='road_texture'||f.polygon?.length>=3).flatMap(f=>{
        if(!f||typeof f!=='object')return [];
        const zoneId=text(f.zoneId);
        if(!author&&zoneId&&!drawnZoneIds.has(zoneId))return [];
        const line=Array.isArray(f.path)&&f.path.length>=2&&f.path.every(finite);
        const area=Array.isArray(f.polygon)&&f.polygon.length>=3&&f.polygon.every(finite);
        if(!line&&!area)return [];
        return [{id:text(f.id),type:text(f.type)||'decor',zoneId:zoneId||null,
          quality:text(f.quality)||'estimated',decorative:f.decorative!==false,
          width:Number.isFinite(f.width)&&f.width>0?f.width*scale:null,
          widthClass:text(f.widthClass)||null,density:text(f.density)||null,
          line:line?f.path.map(xy):null,poly:area?f.polygon.map(xy):null}];
      })};
  } else if(layout?.kind==='floor') {
    kind='floor';const corridor=rect(layout.corridor);
    const functionalAreas=layout.areas??[];
    const hostArea=layout.hostArea??(functionalAreas.length?(layout.rooms??[]).find(r=>r.id===map.containerLocationId):null)??(map.containerLocationKind==='room'&&!(layout.rooms??[]).some(r=>r.id===map.containerLocationId)?{...b,id:map.containerLocationId,name:map.name}:null);
    /**
     * M6-03②：家具保留**真实 local id / type / roomId**。
     *
     * 旧代码 `id:g.id` 让同一组里每件家具共用一个 ID，选中与命中全撞车；
     * 现在用家具自己的 local id（生成器给的 `fid:type[:i]`），没有才退回 `组ID:类型`。
     * `t` 只作**渲染类别**（旧画法认 table/desk/shelf/rug），真实类型放 `type`——
     * bed/cabinet/light/doorway/decor/chair 的信息不能在这里被吃掉。
     * `solid` 只反映场景给了什么，不替场景编造。
     */
    const furnSource=(layout.groups??[]).filter(Boolean).length
      ? (layout.groups??[]).filter(Boolean).flatMap(g=>(g.bodies??[]).filter(Boolean).map(b=>({body:b,groupId:b.groupId??g.id,roomId:b.roomId??g.roomId})))
      : (layout.bodies??[]).filter(Boolean).map(b=>({body:b,groupId:b.groupId??null,roomId:b.roomId??null}));
    const activeRooms=new Set((layout.actors??[]).filter(a=>a.isProtagonist===true||protagonistIds.has(a.id)).map(a=>a.roomId));
    geo={corridor:{...corridor,
      // P11/R03：几何 ID 永远是 'corridor'（不破坏旧路径拓扑）；绑定真实走廊时带上实体身份与名称，
      // 绘制/点击/导航共用同一个 ID。不可见的走廊在 POV 过滤时已被剥掉 entityId/name。
      entityId:layout.corridor?.entityId??null,name:text(layout.corridor?.name)||null,
      y:corridor.y+corridor.h/2},
      hostArea:hostArea?{...rect(hostArea),id:hostArea.id,name:hostArea.name}:null,
      rooms:[...functionalAreas.map(r=>({...rect(r),id:r.id,name:r.name,kind:'other',status:r.quality==='confirmed'?'功能分区':'功能分区 · 估计',tint:'57,224,160',live:false})),...(layout.rooms??[]).filter(r=>r.id!==hostArea?.id).map((r,i)=>({...rect(r),id:r.id,name:r.name,isContainer:r.id===map.containerLocationId,kind:r.id===map.containerLocationId&&map.containerLocationKind==='vehicle'?'vehicle':'room',
        role:r.role??'indoor',
        status:text(r.status)||null,
        tint:r.role==='garden'?'57,224,160':r.role==='outdoor'?'255,194,71':['67,224,255','155,107,255','57,224,160','127,212,255'][i%4],live:activeRooms.has(r.id)}))],
      doors:(layout.doors??[]).map((d,i)=>{const [x,y]=xy(d);return {id:text(d.id)||`door:${text(d.roomId)||i}`,roomId:text(d.roomId)||null,x,y,w:d.width*scale,wall:d.wall??null,routeId:d.routeId??null};}),
      windows:(layout.windows??[]).map((w,i)=>{const [x,y]=xy(w);return {id:text(w.id)||`window:${i}`,roomId:text(w.roomId)||null,x,y,w:(Number.isFinite(w.width)?w.width:1.2)*scale};}),
      lamps:(layout.lamps??[]).map((l,i)=>{const [x,y]=xy(l);return {id:text(l.id)||`light:${i}`,roomId:text(l.roomId)||null,x,y,
        elevation:Number.isFinite(l.elevation)?l.elevation:null};}),
      furn:furnSource.map(({body,groupId,roomId},i)=>{
        const r=rect(body),type=text(body.type)||null;
        return {id:text(body.id)||`${text(groupId)||'furn'}:${type??'decor'}:${i}`,
          name:text(body.name),type,t:type?LEGACY_FURN_CLASS[type]??type:'decor',
          gid:text(groupId)||null,roomId:text(roomId)||null,
          // POV 清洗会把 body.type 剥掉：此时不猜它是什么，明确标 detail=false，
          // 让渲染层画中性块而不是编一个「桌子」出来。
          detail:!!type,
          solid:body.solid===true,
          proxy:placementOf(body)==='proxy',
          r:[r.x,r.y,r.x+r.w,r.y+r.h]};
      })};
  }
  return {kind,geo,marks,metric,
    // N03：跨单位又缺尺度时不下发坏坐标，但保留可定位的提示（POV 下隐藏对象连提示都不产生）。
    diagnostics:unitDiagnostics,
    // M6-07②：比例尺必须知道这个尺度是不是"估计的" —— 没标定的数字要带"约"，
    // 不能把模型推出来的 mpp 当成实测值印在图上。
    transform:{scale,bounds:b,units:document?.units??'cells',metersPerCell:map.metersPerCell??null,
      metricQuality:document?.metricQuality??null,scaleQuality:map.scaleQuality??null},
    extent:[-540,540,-340,360]};
}

export function referenceEntity(detail, catalog = {}) {
  if(!detail)return null;
  const row=detail.character??detail.item??detail.location;
  if(!row?.id)return null;
  if(detail.kind==='character')return {id:text(row.id),name:text(row.name),role:text(row.role??row.kind??'人物'),description:text(row.description??catalog.summary),
    locationId:detail.position?row.location_id??catalog.locationId??null:null,doing:text(row.action_tendency||row.current_action||'尚无行动记录'),mind:text(row.thought||row.private_thought||row.mind||'尚无后台想法记录'),
    state:detail.position?.kind==='in_transit'?'away':!detail.position||detail.position.kind==='unknown'?'unknown':'present',carry:(detail.heldItems??detail.inventory??detail.items??[]).map(x=>text(x.name))};
  if(detail.kind==='item')return {id:text(row.id),name:text(row.name),description:text(row.description??catalog.summary),holder:row.holder_character_id??null,locationId:row.location_id??catalog.locationId??null,st:text(row.condition??row.status??'已记录')};
  return {id:text(row.id),name:text(row.name),description:text(row.description??catalog.summary),childMapIds:(detail.childMaps??[]).map(x=>x.mapId),children:detail.children??[]};
}

export function projectReferenceData({state={},mapView,sceneView,catalogView,taskView,flowView,changesView,worldFeedView,logsView,details=[],diagnostics=[],viewMode='player',scopeKey='',projectOverview,protagonistId=null}) {
  const d=state.stateData??{};
  const out=emptyReferenceData({worldName:text(d.worldName??d.world?.name??state.binding?.worldId??'尚未建立世界'),revision:mapView?.revision??d.revision??0,
    timeMinutes:Number(d.currentTime??d.clockS??0)/60,viewMode,scopeKey,canUndo:state.receipts?.some(r=>r.receipt?.status==='committed'||r.ok===true)??false});
  const maps=visibleWorkbenchMaps(items(mapView),viewMode),nodes=new Map(),scenes=new Map(items(sceneView).map(s=>[s.mapId,s.scene]));
  for(const m of maps){
    const saved=scenes.get(m.mapId);
    const overview=!saved&&projectOverview?projectOverview({view:mapView,mapId:m.mapId,scope:{chatId:state.chatId,branchId:mapView.branchId,revision:mapView.revision,viewMode}})?.scene:null;
    const g=referenceGeometry(m,saved??overview,{viewMode,visibleLocationIds:items(catalogView).filter(c=>c.entityKind==='location').map(c=>c.entityId)});
    // Category and drawing template do not impose a sequence on parentMapId.
    const navKind=navigationKind(m,g.kind);
    const categoryLabel=navigationCategoryLabel(m);
    nodes.set(m.mapId,{id:m.mapId,mapId:m.mapId,name:m.name||m.mapId,tag:categoryLabel??MAP_CATEGORY_NAMES[navKind]??'地图',categoryLabel,description:saved?'已保存的空间布局':'当前 SQL 地图概览；尚无已保存空间布局',
      children:[],...g,renderKind:g.kind,kind:navKind,host:true,containerLocationId:m.containerLocationId??null,containerLocationKind:m.containerLocationKind??null,
      parentMapId:m.parentMapId??null,connectionQuality:m.connectionQuality??null,
      topologyIssueCodes:Array.isArray(m.topologyIssueCodes)?[...m.topologyIssueCodes]:[],
      hasLayout:!!saved,sceneStatus:saved?'ready':'missing'});
  }
  /**
   * M6-02①②：父子关系以服务端解析出的 `parentMapId` 为唯一权威。
   *
   * 旧做法 `owners.get(containerLocationId)` 是把「这个地点画在哪张图上」当成「哪张图包含哪张图」——
   * 同一栋楼的几层都画在同一张城市图上，于是楼层会被错挂成城市的兄弟。
   * 现在：坏图/无可用祖先统一进「未挂接」组；父链先走一遍防环；
   * 循环结束再扫一遍，保证**每一张图**要么唯一可达、要么被明确诊断（不许静默丢图）。
   */
  const roots=[],unclassified=[];
  /**
   * parentMapId 是**地图 id**（`resolveMapTopology` 的输出），null = 自己就是顶图。
   *
   * 坑：世界图的 mapId 很可能**就叫 `world`**（旧适配器 atlas-db-state-adapter 也用 'world'
   * 当「挂在世界根」的哨兵）。所以绝不能在比较时直接特判字符串 —— 先按真实 mapId 找，
   * 找不到再考虑哨兵，否则父图会被自己顶掉、整个树被摊平成两层。
   *
   * 坑二（M7-02 浏览器门禁抓到的真回归）：`connectionQuality==='unclassified'` 的语义是
   * **「服务端找不到可用祖先，已把它挂到世界根图」**（见 02-固定接口与算法说明：
   * "不存在可用祖先但根图有效时，挂到世界根图并标 connectionQuality=unclassified"），
   * 不是「这张图坏了」。把 unclassified 当坏图会把所有「容器地点种类不认识」的内部图
   * 整批丢进「未挂接」，同时把真正的世界图挤成合成根的子节点 —— 树是活的，图却全没了。
   * 只有 `invalid`（服务端连拓扑节点都定位不到 / 没有可用根图）才进「未挂接」组。
   */
  const parentLinkOf=m=>{
    const quality=text(m.connectionQuality);
    if(quality==='invalid')return UNCLASSIFIED;
    const declared=text(m.parentMapId);
    if(!declared)return null;
    if(nodes.has(declared))return declared;
    // 没有这张图：只有旧哨兵 'world' 才当作「挂在世界根」，其它未知父一律不猜。
    return declared===ROOT_SENTINEL?null:UNCLASSIFIED;
  };
  for(const m of maps){
    const n=nodes.get(m.mapId);if(!n)continue;
    const link=parentLinkOf(m);
    if(link===UNCLASSIFIED){unclassified.push(n);continue;}
    if(!link){roots.push(n);continue;}
    const parent=nodes.get(link);
    if(!parent||parent===n){unclassified.push(n);continue;}
    // 防环：从候选父节点往上走，能走回自己就说明挂上去会成环。
    let cursor=parent,cyclic=false;const walked=new Set();
    while(cursor){if(cursor===n){cyclic=true;break;}if(walked.has(cursor.id))break;walked.add(cursor.id);cursor=nodes.get(text(cursor.parentMapId))??null;}
    if(cyclic){unclassified.push(n);continue;}
    parent.children.push(n);
  }
  /**
   * 世界根：只要服务端给出了**唯一**根图，就拿那张真图当世界根 —— 它带着自己的 geo/marks/points，
   * 是唯一能画、能进、能被 `initialNodeId` 选中的东西。
   *
   * 坏图（invalid / 父环 / 缺父）只配多出「未挂接的图」这一个分组，
   * **没有资格把真世界图挤成合成容器的一个子节点**（那是 M7-02 门禁抓到的同一类回归的残党）：
   * 一旦降级，世界图就不在根位置，`fit` / 标记 / 米制标定全落到空壳上。
   * 只有「压根没有唯一根图」（0 张或 >1 张）才用合成容器兜底。
   */
  out.ROOT=roots.length===1?roots[0]:{...out.ROOT,name:out.meta.worldName,children:roots};
  if(unclassified.length)out.ROOT.children.push({id:UNCLASSIFIED,name:'未挂接的图',kind:'other',tag:'未挂接',
    description:'这些图找不到可信的父图（父环、缺父或结构损坏），先单独列出来，不随便挂到某座城市下。',
    children:unclassified,geo:{},marks:[],host:true,unclassified:true});
  const catalog=items(catalogView),detailIndex=new Map(details.map(x=>{const row=x.character??x.item??x.location;return [row?.id,x];}));
  const pointIndex=new Map(maps.flatMap(m=>(m.points??[]).map(p=>[p.entityId,p])));
  out.LOCATIONS=catalog.filter(c=>c.entityKind==='location').map(c=>({id:c.entityId,name:c.name,description:c.summary??'',kind:'location',entityKind:c.locationKind,mobility:c.mobility,anchorLocationId:c.anchorLocationId,tag:c.mobility==='mobile'?'移动载具':'地点',code:c.mobility==='mobile'?'载具':'地点',mapId:c.mapId,children:[],known:true,
    childMapIds:maps.filter(m=>m.containerLocationId===c.entityId).map(m=>m.mapId)}));
  const locationMap=new Map(out.LOCATIONS.map(l=>[l.id,l]));
  for(const location of out.LOCATIONS){const row=catalog.find(c=>c.entityId===location.id);location.parentLocationId=row?.parentLocationId??null;location.aliases=row?.aliases??[];}
  const mobileIds=new Set(out.LOCATIONS.filter(l=>l.mobility==='mobile').map(l=>l.id));
  const inTransit=new Set(items(flowView).filter(f=>f.kind==='journey'&&['moving','paused','blocked'].includes(f.status)).map(f=>f.moverEntityId));
  for(const n of nodes.values()){
    // A vehicle has an interior map, but no permanent geographic footprint.
    if(n.geo?.overviewShapes)n.geo.overviewShapes=n.geo.overviewShapes.filter(s=>!mobileIds.has(s.id));
    if(n.geo?.districts)n.geo.districts=n.geo.districts.filter(s=>!mobileIds.has(s.id));
    n.marks=n.marks.filter(mark=>!mobileIds.has(mark.id)||!inTransit.has(mark.id)&&pointIndex.has(mark.id));
    for(const mark of n.marks){if(mark.type==='poi'){const location=locationMap.get(mark.id),target=nodes.get(location?.childMapIds[0]);mark.node=target&&target!==n?{id:target.id,known:target.known!==false}:null;mark.placeId=mark.id;if(mobileIds.has(mark.id)){mark.type='vehicle';mark.sub=location.anchorLocationId?'停靠载具':'载具位置';}}}
  }
  projectMapContext(nodes,out.LOCATIONS,{inTransit});
  projectSpaceNavigation(nodes,out.LOCATIONS,{scenes});
  projectExplorationMaps(nodes,out.LOCATIONS,{maps,viewMode});
  const mapAt=id=>locationMap.get(id)?.childMapIds[0]??locationMap.get(id)?.mapId??null;
  out.CAST=catalog.filter(c=>c.entityKind==='character').map((c,i)=>{const p=pointIndex.get(c.entityId);return {id:c.entityId,name:c.name,initial:Array.from(c.name??'人').at(-1)||'人',role:p?.isProtagonist?'主角':'人物',c:COLORS[i%COLORS.length],
    state:c.locationId?'present':'unknown',tag:'已记录',locationId:c.locationId,mapNodeId:p?.mapId??mapAt(c.locationId)??c.mapId,description:c.summary??'',doing:'尚无行动记录',mind:'尚无后台想法记录',carry:[],known:true,
    ...referenceEntity(detailIndex.get(c.entityId),c),...(detailIndex.has(c.entityId)&&!detailIndex.get(c.entityId).position?{mapNodeId:null}:{})};});
  const held=new Map(details.filter(d=>d.kind==='character').flatMap(d=>(d.heldItems??[]).map(i=>[i.id,d.character.id])));
  out.ITEMS=catalog.filter(c=>c.entityKind==='item').map(c=>({id:c.entityId,name:c.name,description:c.summary??'',sub:c.summary??'',locationId:c.locationId,mapNodeId:pointIndex.get(c.entityId)?.mapId??c.mapId??mapAt(c.locationId),holder:held.get(c.entityId)??null,st:'已记录',known:true,...referenceEntity(detailIndex.get(c.entityId),c)}));
  out.MESSAGES=catalog.filter(c=>c.entityKind==='rumor').map(c=>({id:c.entityId,src:c.name,txt:c.summary??'',locationId:c.locationId,mapNodeId:c.mapId??mapAt(c.locationId),kind:'rumor',status:'已记录',hops:[],pct:null,known:true}));
  const flows=items(flowView),taskStatus=s=>['done','completed','occurred'].includes(s)?'done':['blocked','failed'].includes(s)?'blocked':'running';
  out.TASKS=items(taskView).map(t=>{const f=flows.find(f=>f.flowId===t.taskId||f.moverEntityId===t.actorEntityId);return {id:t.taskId,n:t.title,d:t.reasonCode??(t.planned?'计划中的行动':'已记录的行动'),st:taskStatus(t.status),stName:t.status,
    entityId:t.actorEntityId,mapId:f?.mapId??mapAt(t.targetLocationId),p:typeof f?.progress==='number'?Math.round(f.progress*100):null,c:COLORS[1],known:true};});
  /**
   * M6-04：EVENTS 只投影**故事事件 DTO**（world-feed），不再拿 changes 的技术明细冒充。
   *
   * 三条纪律：
   * - 标题/摘要是读者内容，来自服务端已过滤好的卡片；这里不读 changes.summary（那是技术审计）。
   * - `known` 必须来自服务端 visibility，**不能固定 true**：未知实体不该在左栏冒出可点链接。
   * - 空 feed 就是空数组 —— 旧卡自然被整份快照替换掉，不会残留上一轮/上一聊天的事件。
   */
  out.EVENTS=items(worldFeedView).map((e,i)=>{const targetId=e.target?.id??null;return {
    id:e.id??`feed-${i}`,
    turn:Number.isFinite(e.turnOrdinal)?e.turnOrdinal:0,
    turnId:e.turnId??null,
    t:text(e.timeLabel)||'时间未知',
    mapId:e.mapId??pointIndex.get(targetId)?.mapId??null,
    target:targetId,targetKind:e.target?.kind??null,
    kind:e.category??'event',category:e.category??'event',
    title:text(e.title),detail:text(e.summary),
    links:Array.isArray(e.links)?e.links.map(l=>({id:l.id,kind:l.kind,label:text(l.label)})):[],
    known:e.visibility==='known',
    sourceKind:e.sourceKind??'story',factQuality:e.factQuality??'confirmed'};});
  // 时间基准来自真实 narrative 回合（不受数组长度/manual 标定影响）。
  const feedMeta=worldFeedView?.metadata??{};
  out.meta.latestTurnId=feedMeta.latestNarrativeTurnId??null;
  out.meta.turn=Number.isFinite(feedMeta.latestNarrativeOrdinal)?feedMeta.latestNarrativeOrdinal:0;
  out.meta.hasMoreEvents=feedMeta.hasMoreVisible===true;
  out.meta.feedCount=out.EVENTS.length;
  out.meta.protagonistId=protagonistId??maps.flatMap(m=>m.points??[]).find(p=>p.isProtagonist)?.entityId??out.CAST.find(c=>c.role==='主角'||c.role==='protagonist')?.id??null;
  out.meta.initialNodeId=out.CAST.find(c=>c.id===out.meta.protagonistId)?.mapNodeId??out.ROOT.id;
  for(const node of nodes.values())for(const mark of node.marks)if(mark.type==='char'){const c=out.CAST.find(c=>c.id===mark.id);if(c){mark.c=c.c;mark.initial=c.initial;mark.hero=mark.id===out.meta.protagonistId;}}
  out.RECEIPTS=referenceReceipts(state,items(logsView));
  /**
   * P14 §20.1：建图状态直接取服务端 `buildStatus`（已由 SQL 只读派生）。
   * 这里**不做二次汇总**：五桶、地图布局数与窗口账都是唯一来源的搬运，
   * 缺就保持 null —— 界面据此显示「未知」而不是 0。
   */
  out.buildStatus=d?.buildStatus&&typeof d.buildStatus==='object'?d.buildStatus:null;
  out.DIAGNOSTICS=referenceDiagnostics([...items(logsView),...diagnostics,...(state.lastError?[typeof state.lastError==='string'?{message:state.lastError,code:'WORLD_ACTION_FAILED',level:'error',source:'ui'}:{...state.lastError,level:'error'}]:[])]);
  for(const node of nodes.values()){
    const projected=projectReferenceFlows(flowView,node);
    if(projected.flows.length)out.FLOWS[node.id]=projected.flows;
    if(projected.journeys.length)out.JOURNEYS[node.id]=projected.journeys.map(edge=>{
      const mover=locationMap.get(edge.entityId),vehicle=mobileIds.has(edge.entityId);
      return {...edge,entityKind:vehicle?'vehicle':mover?'location':edge.entityKind,pct:edge.progress===null?null:edge.progress*100,
        name:mover?`${mover.name} · 在途`:edge.name};
    });
  }
  return out;
}
