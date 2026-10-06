import * as E from './layout-core.mjs';
import {LIMITS,finite,clone,diagnostic,failure} from './contracts.mjs';
export function pointOnPath(points,progress){
  if(!Array.isArray(points)||points.length<2||points.length>LIMITS.pathPoints||!points.every(p=>finite(p.x)&&finite(p.y))||!finite(progress))return null;
  const lengths=points.slice(1).map((p,i)=>E.distance(points[i],p)),total=lengths.reduce((a,b)=>a+b,0);
  if(total===0)return {...points[0],distance:0,total:0};
  let remaining=Math.max(0,Math.min(1,progress))*total;
  for(let i=0;i<lengths.length;i++){const len=lengths[i];if(remaining<=len&&len>0){const t=remaining/len;return {x:points[i].x+(points[i+1].x-points[i].x)*t,y:points[i].y+(points[i+1].y-points[i].y)*t,distance:total*Math.max(0,Math.min(1,progress)),total};}remaining-=len;}
  return {...points.at(-1),distance:total,total};
}
export function placeMarkers({region,markers,obstacles=[],previous=[],step=.25,clearance=.25}={}){
  if(!Array.isArray(region)||region.length<3||!region.every(p=>finite(p.x)&&finite(p.y))||!Array.isArray(markers)||markers.length>LIMITS.markers||!finite(step)||step<=0||!finite(clearance)||clearance<=0)return failure('PLACEMENT_INPUT_INVALID','$','需要有效多边形、标点列表、步长和间距');
  const xs=region.map(p=>p.x),ys=region.map(p=>p.y),minX=Math.min(...xs),minY=Math.min(...ys),maxX=Math.max(...xs),maxY=Math.max(...ys);
  // Hard budget prevents a huge city polygon from triggering an indoor-scale scan.
  if(Math.ceil((maxX-minX)/step)*Math.ceil((maxY-minY)/step)>200000)return failure('PLACEMENT_BUDGET_EXCEEDED','$.step','提高扫描步长或缩小本次摆放区域');
  const out=[],issues=[],seen=new Set(),valid=[];
  for(const m of markers){if(!m||typeof m.id!=='string'||seen.has(m.id)){issues.push(diagnostic('MARKER_ID_INVALID','$.markers','标识缺失或重复'));continue;}seen.add(m.id);valid.push(m);}
  const free=(p,r=clearance)=>finite(p.x)&&finite(p.y)&&E.polygonContains(region,p)&&[{x:p.x+r,y:p.y},{x:p.x-r,y:p.y},{x:p.x,y:p.y+r},{x:p.x,y:p.y-r}].every(q=>E.polygonContains(region,q))&&!obstacles.some(o=>p.x>=o.x-r&&p.x<=o.x+o.w+r&&p.y>=o.y-r&&p.y<=o.y+o.h+r)&&!out.some(o=>E.distance(o,p)<(o.radius??clearance)+r);
  const ordered=[...valid].sort((a,b)=>Number(!!b.locked)-Number(!!a.locked)||a.id.localeCompare(b.id,'en'));
  // Reserve valid saved anchors before placing newly added markers, regardless of ID sort order.
  const pending=[];
  for(const m of ordered){const old=previous.find(p=>p.id===m.id&&p.locationId===m.locationId),p=m.locked||old;
    if(p&&free(p,m.radius??clearance))out.push({...m,x:p.x,y:p.y,quality:m.locked?'exact':'layout'});
    else if(m.locked)issues.push(diagnostic('MARKER_LOCK_CONFLICT','$.markers','确认点不能放在区域外或障碍内',{entityId:m.id}));
    else pending.push(m);
  }
  for(const m of pending){const target=m.near&&finite(m.near.x)&&finite(m.near.y)?m.near:{x:(minX+maxX)/2,y:(minY+maxY)/2};let best=null,score=Infinity;
    for(let y=minY+clearance;y<maxY;y+=step)for(let x=minX+clearance;x<maxX;x+=step){const q={x,y};if(free(q,m.radius??clearance)){const d=E.distance(q,target);if(d<score){score=d;best=q;}}}
    if(best)out.push({...m,...best,quality:'layout'});else issues.push(diagnostic('MARKER_NO_SPACE','$.markers','没有可摆放空间，保留名单',{entityId:m.id}));
  }
  return {ok:true,status:issues.length?'partial':'generated',markers:out,issues};
}
export function buildOverlays({mapId,rows,positions,selectedEntityId=null,showAllRelations=false}={}){
  if(typeof mapId!=='string'||!Array.isArray(rows)||rows.length>LIMITS.overlays)return failure('OVERLAY_INPUT_INVALID','$','需要地图标识与有上限的已过滤图层数据');
  const byId=new Map((positions??[]).filter(p=>p.mapId===mapId&&finite(p.x)&&finite(p.y)).map(p=>[p.id??p.entityId,p]));
  const overlays=[],cards=[],issues=[];
  for(const row of rows){
    if(!row||!['relation','journey','information','route'].includes(row.kind)){issues.push(diagnostic('OVERLAY_KIND_INVALID','$.rows','不支持的图层类型'));continue;}
    if(row.mapId!==mapId)continue;
    if(row.kind==='relation'&&!showAllRelations&&row.fromId!==selectedEntityId&&row.toId!==selectedEntityId)continue;
    let path=Array.isArray(row.path)?clone(row.path):null;
    if(!path&&row.kind==='relation'){const a=byId.get(row.fromId),b=byId.get(row.toId);if(a&&b)path=[{x:a.x,y:a.y},{x:b.x,y:b.y}];}
    if(!path||path.length<2||path.length>LIMITS.pathPoints||!path.every(p=>finite(p.x)&&finite(p.y))){cards.push({...row,reason:'NO_ROUTE_GEOMETRY'});continue;}
    const progress=finite(row.progress)?Math.max(0,Math.min(1,row.progress)):null;
    overlays.push({id:row.id,kind:row.kind,mapId,name:String(row.name??''),fromId:row.fromId??null,toId:row.toId??null,path,quality:row.quality==='confirmed'?'confirmed':'estimated',progress,marker:progress===null?null:pointOnPath(path,progress),dashed:row.kind==='relation'||row.quality!=='confirmed'});
  }
  return {ok:true,status:issues.length?'partial':'generated',overlays,cards,issues};
}
