/** Real SQL DTOs projected into the supplied UI's data contract. Never writes a world. */
import { visibleWorkbenchMaps } from './atlas-workbench-data.mjs';

export const REFERENCE_LEVELS = [
  ['world','L0','世界'],['region','L1','地区'],['city','L2','城市'],['district','L3','街区'],
  ['building','L4','建筑'],['floor','L5','楼层'],['room','L6','房间'],['detail','L7','陈设'],
].map(([key,code,name])=>({key,code,name}));
const COLORS = ['#43e0ff','#9b6bff','#ffc247','#39e0a0','#7fd4ff','#ff5f92'];

/** M6-02：「未挂接」分组的稳定 ID。坏图不随便挂到某座城市下。 */
export const UNCLASSIFIED = '__unclassified__';
/** 旧适配器用 'world' 表示「挂在世界根」；只在没有同名地图时才按哨兵解释。 */
const ROOT_SENTINEL = 'world';

/**
 * M6-02③：地点种类 → 导航层级。
 *
 * 只有「容器地点」能决定一张图在导航里是什么层级：车厢/载具画成楼层样式的内景（floor），
 * 但一栋建筑必须是 building —— 画法（有没有 floor 布局）不等于结构。
 * 没有容器或容器不可见（POV 下被裁掉）时回落到几何推断的结果，不猜。
 */
const CONTAINER_NAV_KIND = {region:'region',city:'city',district:'district',building:'building',floor:'floor',room:'room',vehicle:'floor',natural:'region'};
function navigationKind(map, geometricKind) {
  const containerKind = text(map?.containerLocationKind);
  return (containerKind && CONTAINER_NAV_KIND[containerKind]) || geometricKind;
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
  return {meta:{worldName:'尚未建立世界',turn:0,revision:0,timeMinutes:0,viewMode:'pov',initialNodeId:'world',...meta},
    LEVELS:REFERENCE_LEVELS,ROOT:{id:'world',name:meta.worldName||'尚未建立世界',kind:'world',code:'L0',children:[],geo:{},marks:[],host:true},
    LOCATIONS:[],CAST:[],ITEMS:[],MESSAGES:[],TASKS:[],EVENTS:[],RECEIPTS:[],LORE:[],DIAGNOSTICS:[],FLOWS:{},JOURNEYS:{},PROMPTS:[]};
}

export function referenceDiagnostics(rows=[]){return rows.map((l,i)=>({...l,id:l.logId??l.id??`log-${i}`,t:text(l.at??l.createdAt??''),level:l.level??(l.kind==='issue'||l.kind==='failed_turn'?'error':'info'),code:l.code??(l.kind==='failed_turn'?'TURN_FAILED':l.kind??'WORLD_LOG'),message:l.message??l.summary??(l.kind==='failed_turn'?`推演${l.status==='partial'?'部分提交':'失败'} · ${l.receipt?.issues?.length??l.issues?.length??l.issueCount??0} 项问题`:l.code??''),details:l.details??l.issues??l.receipt?.issues??null}));}
export function referenceReceipts(state={},logs=[]){return (state.receipts??[]).filter(r=>!r.chatId||r.chatId===state.chatId).map((r,i)=>({id:r.receiptId??r.receipt?.receiptId??`receipt-${i}`,turn:(state.receipts?.length??0)-i,t:typeof r.recordedAt==='number'?new Date(r.recordedAt).toLocaleString('zh-CN',{hour12:false}):text(r.recordedAt??r.at??''),ok:r.status==='committed'||r.status==='duplicate'||r.receipt?.status==='committed'||r.ok===true,status:r.status??r.receipt?.status??'unknown',retryable:r.retryable===true&&i===0&&!!state.retryableCommit,
  m:text(r.summary??r.receipt?.summary??r.message??r.status??'推演回执'),issue:text(r.errorCode??r.receipt?.issues?.[0]?.code??''),detail:r.detail??null,logs:logs.filter(l=>l.turnId===r.receiptId)}));}

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
  const rawPins = layout ? [
    ...pins, ...(layout.actors??[]).map(p=>({...p,type:'person'})), ...(layout.items??[]).map(p=>({...p,type:'item'})),
    ...(layout.rooms??[]).map(r=>({...r,type:'location',silent:true,x:r.x+r.w/2,y:r.y+r.h/2})),
    ...(layout.districts??[]).filter(d=>d.polygon?.length>=3&&d.polygon.every(finite)).map(d=>({...d,type:'location',silent:true,x:d.polygon.reduce((n,p)=>n+point(p)[0],0)/d.polygon.length,y:d.polygon.reduce((n,p)=>n+point(p)[1],0)/d.polygon.length})),
    ...(layout.buildings??[]).filter(p=>!p.decorative).map(r=>({...r,type:'location',x:r.x+r.w/2,y:r.y+r.h/2})),
  ] : (map.points??[]).map(p=>({...p,id:p.entityId,type:p.kind==='character'?'person':p.kind}));
  const uniquePins=[...new Map(rawPins.filter(finite).map(p=>[`${p.type}:${p.entityId??p.id}`,p])).values()];
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
  let kind=REFERENCE_LEVELS.some(l=>l.key===containerKind)?containerKind:REFERENCE_LEVELS.some(l=>l.key===map.kind)?map.kind:({site:'building',interior:'room'}[map.kind]??'world'),geo={};
  if(layout?.kind==='city') {
    kind='city';
    const river=layout.river;
    geo={districts:(layout.districts??[]).filter(d=>d.polygon?.length>=3&&d.polygon.every(finite)).map((d,i)=>({id:d.id,name:d.name,c:COLORS[i%COLORS.length],pts:d.polygon.map(xy)})),
      river:river?Array.from({length:41},(_,i)=>{const y=(river.height??b.h)*i/40;return xy({x:river.cx+Math.sin((y/(river.height||b.h)*2-.35)*Math.PI)*river.amplitude,y});}):null,
      riverWidth:river?.width?river.width*scale:null,wallPoints:(layout.wall??[]).filter(finite).map(xy),
      avenues:(layout.roads??[]).filter(r=>finite(r.from??r.a)&&finite(r.to??r.b)).map(r=>({from:xy(r.from??r.a),to:xy(r.to??r.b)})),pois:[]};
  } else if(layout?.kind==='overview') {
    // A SQL overview already contains validated geometry. Keep its paths and
    // footprints instead of reducing the whole map to unconnected markers.
    const qualityById=new Map((map.points??[]).map(p=>[p.entityId,p.area?.quality]));
    const visible=new Set(visibleLocationIds), author=viewMode!=='pov';
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
      overviewFeatures:(layout.features??[]).flatMap(f=>{
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
    geo={corridor:{...corridor,y:corridor.y+corridor.h/2},
      rooms:(layout.rooms??[]).map((r,i)=>({...rect(r),id:r.id,name:r.name,kind:'room',
        status:text(r.status)||null,
        tint:['67,224,255','155,107,255','57,224,160','127,212,255'][i%4],live:false})),
      doors:(layout.doors??[]).map((d,i)=>{const [x,y]=xy(d);return {id:text(d.id)||`door:${text(d.roomId)||i}`,roomId:text(d.roomId)||null,x,y,w:d.width*scale};}),
      windows:(layout.windows??[]).map((w,i)=>{const [x,y]=xy(w);return {id:text(w.id)||`window:${i}`,roomId:text(w.roomId)||null,x,y,w:(Number.isFinite(w.width)?w.width:1.2)*scale};}),
      lamps:(layout.lamps??[]).map((l,i)=>{const [x,y]=xy(l);return {id:text(l.id)||`light:${i}`,roomId:text(l.roomId)||null,x,y,
        elevation:Number.isFinite(l.elevation)?l.elevation:null};}),
      furn:furnSource.map(({body,groupId,roomId},i)=>{
        const r=rect(body),type=text(body.type)||null;
        return {id:text(body.id)||`${text(groupId)||'furn'}:${type??'decor'}:${i}`,
          type,t:type?LEGACY_FURN_CLASS[type]??type:'decor',
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

export function projectReferenceData({state={},mapView,sceneView,catalogView,taskView,flowView,changesView,worldFeedView,logsView,details=[],diagnostics=[],viewMode='pov',scopeKey='',projectOverview,protagonistId=null}) {
  const d=state.stateData??{};
  const out=emptyReferenceData({worldName:text(d.worldName??d.world?.name??state.binding?.worldId??'尚未建立世界'),revision:mapView?.revision??d.revision??0,
    timeMinutes:Number(d.currentTime??d.clockS??0)/60,viewMode,scopeKey,canUndo:state.receipts?.some(r=>r.receipt?.status==='committed'||r.ok===true)??false});
  const maps=visibleWorkbenchMaps(items(mapView),viewMode),nodes=new Map(),scenes=new Map(items(sceneView).map(s=>[s.mapId,s.scene]));
  for(const m of maps){
    const saved=scenes.get(m.mapId);
    const overview=!saved&&projectOverview?projectOverview({view:mapView,mapId:m.mapId,scope:{chatId:state.chatId,branchId:mapView.branchId,revision:mapView.revision,viewMode}})?.scene:null;
    const g=referenceGeometry(m,saved??overview,{viewMode,visibleLocationIds:items(catalogView).filter(c=>c.entityKind==='location').map(c=>c.entityId)});
    // M6-02③：导航层级先用 SQL 的 containerKind（真实空间类别）。
    // 不能因为「这张图有 floor 布局」就把一栋建筑当成楼层 —— 画法不等于结构。
    const navKind=navigationKind(m,g.kind);
    const level=REFERENCE_LEVELS.find(l=>l.key===navKind)??REFERENCE_LEVELS.find(l=>l.key===g.kind)??REFERENCE_LEVELS[0];
    nodes.set(m.mapId,{id:m.mapId,mapId:m.mapId,name:m.name||m.mapId,code:level.code,tag:level.name,description:saved?'已保存的空间布局':'当前 SQL 地图概览；尚无已保存空间布局',
      children:[],...g,renderKind:g.kind,kind:navKind,host:true,containerLocationId:m.containerLocationId??null,
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
  if(unclassified.length)out.ROOT.children.push({id:UNCLASSIFIED,name:'未挂接的图',kind:'region',code:'L2',tag:'未挂接',
    description:'这些图找不到可信的父图（父环、缺父或结构损坏），先单独列出来，不随便挂到某座城市下。',
    children:unclassified,geo:{},marks:[],host:true,unclassified:true});
  const catalog=items(catalogView),detailIndex=new Map(details.map(x=>{const row=x.character??x.item??x.location;return [row?.id,x];}));
  const pointIndex=new Map(maps.flatMap(m=>(m.points??[]).map(p=>[p.entityId,p])));
  out.LOCATIONS=catalog.filter(c=>c.entityKind==='location').map(c=>({id:c.entityId,name:c.name,description:c.summary??'',kind:'location',tag:'地点',code:'地点',mapId:c.mapId,children:[],known:true,
    childMapIds:maps.filter(m=>m.containerLocationId===c.entityId).map(m=>m.mapId)}));
  const locationMap=new Map(out.LOCATIONS.map(l=>[l.id,l]));
  for(const n of nodes.values())for(const mark of n.marks){if(mark.type==='poi'){const target=nodes.get(locationMap.get(mark.id)?.childMapIds[0]);mark.node=target&&target!==n?{id:target.id,known:target.known!==false}:null;mark.placeId=mark.id;}}
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
  out.DIAGNOSTICS=referenceDiagnostics([...items(logsView),...diagnostics,...(state.lastError?[typeof state.lastError==='string'?{message:state.lastError,code:'WORLD_ACTION_FAILED',level:'error'}:{...state.lastError,level:'error'}]:[])]);
  for(const f of flows){const node=nodes.get(f.mapId);if(!node||!f.path?.points?.length)continue;const tr=node.transform,convert=f.path.units==='cells'&&tr.units==='meters';if(convert&&!(Number.isFinite(tr.metersPerCell)&&tr.metersPerCell>0))continue;const units=convert?tr.metersPerCell:1;
    const points=f.path.points.map(p=>[(p.x*units-(tr.bounds.x??0)-tr.bounds.w/2)*tr.scale,(p.y*units-(tr.bounds.y??0)-tr.bounds.h/2)*tr.scale]);
    const edge={id:f.flowId,entityId:f.moverEntityId,from:points[0],to:points.at(-1),via:points.length>2?points[Math.floor(points.length/2)]:null,points,progress:typeof f.progress==='number'?Math.min(1,Math.max(0,f.progress)):null,pct:typeof f.progress==='number'?f.progress*100:null,known:true,c:COLORS[3],name:f.label};
    const bucket=f.kind==='journey'?out.JOURNEYS:out.FLOWS;(bucket[f.mapId]??=[]).push(edge);
  }
  return out;
}
