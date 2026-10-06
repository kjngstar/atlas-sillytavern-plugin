/** Real SQL DTOs projected into the supplied UI's data contract. Never writes a world. */
import { visibleWorkbenchMaps } from './atlas-workbench-data.mjs';

export const REFERENCE_LEVELS = [
  ['world','L0','世界'],['region','L1','地区'],['city','L2','城市'],['district','L3','街区'],
  ['building','L4','建筑'],['floor','L5','楼层'],['room','L6','房间'],['detail','L7','陈设'],
].map(([key,code,name])=>({key,code,name}));
const COLORS = ['#43e0ff','#9b6bff','#ffc247','#39e0a0','#7fd4ff','#ff5f92'];
const items = dto => Array.isArray(dto?.items) ? dto.items : [];
const text = value => String(value ?? '');
const point = p => Array.isArray(p) ? p : [p?.x,p?.y];
const finite = p => point(p).every(Number.isFinite);

export function emptyReferenceData(meta = {}) {
  return {meta:{worldName:'尚未建立世界',turn:0,revision:0,timeMinutes:0,viewMode:'pov',initialNodeId:'world',...meta},
    LEVELS:REFERENCE_LEVELS,ROOT:{id:'world',name:meta.worldName||'尚未建立世界',kind:'world',code:'L0',children:[],geo:{},marks:[],host:true},
    LOCATIONS:[],CAST:[],ITEMS:[],MESSAGES:[],TASKS:[],EVENTS:[],RECEIPTS:[],LORE:[],DIAGNOSTICS:[],FLOWS:{},JOURNEYS:{},PROMPTS:[]};
}

export function referenceDiagnostics(rows=[]){return rows.map((l,i)=>({...l,id:l.logId??l.id??`log-${i}`,t:text(l.at??l.createdAt??''),level:l.level??(l.kind==='issue'||l.kind==='failed_turn'?'error':'info'),code:l.code??(l.kind==='failed_turn'?'TURN_FAILED':l.kind??'WORLD_LOG'),message:l.message??l.summary??(l.kind==='failed_turn'?`推演${l.status==='partial'?'部分提交':'失败'} · ${l.issueCount??0} 项问题`:l.code??''),details:l.details??l.issues??null}));}
export function referenceReceipts(state={},logs=[]){return (state.receipts??[]).filter(r=>!r.chatId||r.chatId===state.chatId).map((r,i)=>({id:r.receiptId??r.receipt?.receiptId??`receipt-${i}`,turn:(state.receipts?.length??0)-i,t:typeof r.recordedAt==='number'?new Date(r.recordedAt).toLocaleString('zh-CN',{hour12:false}):text(r.recordedAt??r.at??''),ok:r.status==='committed'||r.status==='duplicate'||r.receipt?.status==='committed'||r.ok===true,status:r.status??r.receipt?.status??'unknown',retryable:r.retryable===true&&i===0&&!!state.retryableCommit,
  m:text(r.summary??r.receipt?.summary??r.message??r.status??'推演回执'),issue:text(r.errorCode??r.receipt?.issues?.[0]?.code??''),detail:r.detail??null,logs:logs.filter(l=>l.turnId===r.receiptId)}));}

/** Convert geometry once; the original renderer keeps its original colors, materials and gestures. */
export function referenceGeometry(map, document) {
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
  const marks = uniquePins.map((p,i)=>{const [x,y]=xy(p);return {id:text(p.entityId??p.id),type:p.type==='person'?'char':p.type==='item'?'item':'poi',
    x,y,name:text(p.name),sub:text(p.quality??p.markerQuality??p.precision),hero:p.isProtagonist===true,silent:p.silent===true,c:COLORS[i%COLORS.length],locationId:p.locationId??p.roomId??null};});
  const containerKind=map.containerLocationKind;
  let kind=REFERENCE_LEVELS.some(l=>l.key===containerKind)?containerKind:REFERENCE_LEVELS.some(l=>l.key===map.kind)?map.kind:({site:'building',interior:'room'}[map.kind]??'world'),geo={};
  if(layout?.kind==='city') {
    kind='city';
    const river=layout.river;
    geo={districts:(layout.districts??[]).filter(d=>d.polygon?.length>=3&&d.polygon.every(finite)).map((d,i)=>({id:d.id,name:d.name,c:COLORS[i%COLORS.length],pts:d.polygon.map(xy)})),
      river:river?Array.from({length:41},(_,i)=>{const y=(river.height??b.h)*i/40;return xy({x:river.cx+Math.sin(y/(river.height||b.h)*Math.PI*2)*river.amplitude,y});}):null,
      riverWidth:river?.width?river.width*scale:null,wallPoints:(layout.wall??[]).filter(finite).map(xy),
      avenues:(layout.roads??[]).filter(r=>finite(r.from)&&finite(r.to)).map(r=>({from:xy(r.from),to:xy(r.to)})),pois:[]};
  } else if(layout?.kind==='floor') {
    kind='floor';const corridor=rect(layout.corridor);
    geo={corridor:{...corridor,y:corridor.y+corridor.h/2},rooms:(layout.rooms??[]).map((r,i)=>({...rect(r),id:r.id,name:r.name,kind:'room',tint:['67,224,255','155,107,255','57,224,160','127,212,255'][i%4],live:false})),
      doors:(layout.doors??[]).map(d=>{const [x,y]=xy(d);return {x,y,w:d.width*scale};}),
      furn:(layout.groups??[]).flatMap(g=>(g.bodies??[]).map(body=>{const r=rect(body);return {id:g.id,r:[r.x,r.y,r.x+r.w,r.y+r.h],t:body.type==='chair'?'table':body.type,n:7};}))};
  }
  return {kind,geo,marks,metric,transform:{scale,bounds:b,units:document?.units??'cells',metersPerCell:map.metersPerCell??null},extent:[-540,540,-340,360]};
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

export function projectReferenceData({state={},mapView,sceneView,catalogView,taskView,flowView,changesView,logsView,details=[],diagnostics=[],viewMode='pov',scopeKey='',projectOverview,protagonistId=null}) {
  const d=state.stateData??{};
  const out=emptyReferenceData({worldName:text(d.worldName??d.world?.name??state.binding?.worldId??'尚未建立世界'),revision:mapView?.revision??d.revision??0,
    timeMinutes:Number(d.currentTime??d.clockS??0)/60,viewMode,scopeKey,canUndo:state.receipts?.some(r=>r.receipt?.status==='committed'||r.ok===true)??false});
  const maps=visibleWorkbenchMaps(items(mapView),viewMode),nodes=new Map(),owners=new Map(),scenes=new Map(items(sceneView).map(s=>[s.mapId,s.scene]));
  for(const c of items(catalogView))if(c.entityKind==='location'&&c.mapId)owners.set(c.entityId,c.mapId);
  for(const m of maps)for(const p of m.points??[])if(p.kind==='location')owners.set(p.entityId,m.mapId);
  for(const m of maps){
    const saved=scenes.get(m.mapId);
    const overview=!saved&&projectOverview?projectOverview({view:mapView,mapId:m.mapId,scope:{chatId:state.chatId,branchId:mapView.branchId,revision:mapView.revision,viewMode}})?.scene:null;
    const g=referenceGeometry(m,saved??overview),level=REFERENCE_LEVELS.find(l=>l.key===g.kind)??REFERENCE_LEVELS[0];
    nodes.set(m.mapId,{id:m.mapId,mapId:m.mapId,name:m.name||m.mapId,kind:g.kind,code:level.code,tag:level.name,description:saved?'已保存的空间布局':'当前 SQL 地图概览；尚无已保存空间布局',
      children:[],...g,host:true,containerLocationId:m.containerLocationId??null,sceneStatus:saved?'ready':'missing'});
  }
  const roots=[];
  for(const m of maps){const n=nodes.get(m.mapId),parent=nodes.get(owners.get(m.containerLocationId));if(parent&&parent!==n)parent.children.push(n);else if(!m.containerLocationId)roots.push(n);}
  out.ROOT=roots.length===1?roots[0]:{...out.ROOT,name:out.meta.worldName,children:roots};
  const catalog=items(catalogView),detailIndex=new Map(details.map(x=>{const row=x.character??x.item??x.location;return [row?.id,x];}));
  const pointIndex=new Map(maps.flatMap(m=>(m.points??[]).map(p=>[p.entityId,p])));
  out.LOCATIONS=catalog.filter(c=>c.entityKind==='location').map(c=>({id:c.entityId,name:c.name,description:c.summary??'',kind:'location',tag:'地点',code:'地点',mapId:c.mapId,children:[],known:true,
    childMapIds:maps.filter(m=>m.containerLocationId===c.entityId).map(m=>m.mapId)}));
  const locationMap=new Map(out.LOCATIONS.map(l=>[l.id,l]));
  for(const n of nodes.values())for(const mark of n.marks){if(mark.type==='poi'){mark.node=nodes.get(locationMap.get(mark.id)?.childMapIds[0])??null;mark.placeId=mark.id;}}
  const mapAt=id=>locationMap.get(id)?.childMapIds[0]??locationMap.get(id)?.mapId??null;
  out.CAST=catalog.filter(c=>c.entityKind==='character').map((c,i)=>{const p=pointIndex.get(c.entityId);return {id:c.entityId,name:c.name,initial:Array.from(c.name??'人').at(-1)||'人',role:p?.isProtagonist?'主角':'人物',c:COLORS[i%COLORS.length],
    state:c.locationId?'present':'unknown',tag:'已记录',locationId:c.locationId,mapNodeId:c.mapId??mapAt(c.locationId),description:c.summary??'',doing:'尚无行动记录',mind:'尚无后台想法记录',carry:[],known:true,
    ...referenceEntity(detailIndex.get(c.entityId),c),...(detailIndex.has(c.entityId)&&!detailIndex.get(c.entityId).position?{mapNodeId:null}:{})};});
  const held=new Map(details.filter(d=>d.kind==='character').flatMap(d=>(d.heldItems??[]).map(i=>[i.id,d.character.id])));
  out.ITEMS=catalog.filter(c=>c.entityKind==='item').map(c=>({id:c.entityId,name:c.name,description:c.summary??'',sub:c.summary??'',locationId:c.locationId,mapNodeId:c.mapId??mapAt(c.locationId),holder:held.get(c.entityId)??null,st:'已记录',known:true,...referenceEntity(detailIndex.get(c.entityId),c)}));
  out.MESSAGES=catalog.filter(c=>c.entityKind==='rumor').map(c=>({id:c.entityId,src:c.name,txt:c.summary??'',locationId:c.locationId,mapNodeId:c.mapId??mapAt(c.locationId),kind:'rumor',status:'已记录',hops:[],pct:null,known:true}));
  const flows=items(flowView),taskStatus=s=>['done','completed','occurred'].includes(s)?'done':['blocked','failed'].includes(s)?'blocked':'running';
  out.TASKS=items(taskView).map(t=>{const f=flows.find(f=>f.flowId===t.taskId||f.moverEntityId===t.actorEntityId);return {id:t.taskId,n:t.title,d:t.reasonCode??(t.planned?'计划中的行动':'已记录的行动'),st:taskStatus(t.status),stName:t.status,
    entityId:t.actorEntityId,mapId:f?.mapId??mapAt(t.targetLocationId),p:typeof f?.progress==='number'?Math.round(f.progress*100):null,c:COLORS[1],known:true};});
  out.EVENTS=items(changesView).map((e,i)=>({id:e.changeId??`change-${i}`,turn:e.turnId??0,t:'已提交',mapId:pointIndex.get(e.rowId)?.mapId??null,target:e.rowId,targetKind:e.table==='characters'?'character':e.table==='items'?'item':'place',kind:e.table==='characters'?'cast':e.table==='items'?'item':'geo',title:e.summary??'',detail:e.summary??'',known:true}));
  out.meta.turn=out.EVENTS[0]?.turn??state.receipts?.length??0;
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
