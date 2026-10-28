/** Read-only map context. Display proxies never become SQL positions or travel progress. */
const finitePoint=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite);
const polygon=p=>Array.isArray(p)&&p.length>=3&&p.every(finitePoint);
const midpoint=pts=>[pts.reduce((s,p)=>s+p[0],0)/pts.length,pts.reduce((s,p)=>s+p[1],0)/pts.length];
const boundaryPoint=(node,mark,target)=>{
 const shape=outline(node,mark.id),start=[mark.x,mark.y];if(!shape)return start;
 const d=[target.x-mark.x,target.y-mark.y],cross=(a,b)=>a[0]*b[1]-a[1]*b[0],hits=[];
 for(let i=0;i<shape.pts.length;i++){const a=shape.pts[i],b=shape.pts[(i+1)%shape.pts.length],edge=[b[0]-a[0],b[1]-a[1]],q=[a[0]-start[0],a[1]-start[1]],den=cross(d,edge);if(Math.abs(den)<1e-9)continue;const t=cross(q,edge)/den,u=cross(q,d)/den;if(t>0&&t<1&&u>=0&&u<=1)hits.push(t);}
 const t=Math.min(...hits);return Number.isFinite(t)?[start[0]+d[0]*t,start[1]+d[1]*t]:start;
};
const outline=(node,id)=>{
 const g=node.geo??{};
 const shape=[...(g.overviewShapes??[]),...(g.districts??[])].find(s=>s.id===id&&polygon(s.pts));
 if(shape)return {id,name:shape.name,pts:shape.pts,quality:shape.quality??'layout',c:shape.c};
 const room=(g.rooms??[]).find(r=>r.id===id);
 if(room&&[room.x,room.y,room.w,room.h].every(Number.isFinite))return {id,name:room.name,quality:'layout',pts:[[room.x,room.y],[room.x+room.w,room.y],[room.x+room.w,room.y+room.h],[room.x,room.y+room.h]]};
 return null;
};
const namesOf=l=>[l.name,...(l.aliases??[]),String(l.name??'').replace(/^(?:帝都|王都|首都)\s*/, '')].filter(Boolean);

/** Compatibility for a legacy named corridor with two unambiguous known endpoints. */
export function corridorEndpoints(location,locations){
 if(location.mobility==='mobile'||!['natural','other','location'].includes(location.entityKind??location.kind))return null;
 const match=String(location.name??'').match(/^(.+?)(?:至|到|通往|\s+to\s+)(.+?)(?:道路|公路|官道|驿道|大道|小径|\s+road)$/i);
 if(!match)return null;
 const peers=locations.filter(l=>l.id!==location.id&&l.mobility!=='mobile'&&l.mapId===location.mapId&&l.parentLocationId===location.parentLocationId);
 const a=peers.filter(l=>namesOf(l).includes(match[1].trim())),b=peers.filter(l=>namesOf(l).includes(match[2].trim()));
 return a.length===1&&b.length===1&&a[0].id!==b[0].id?[a[0],b[0]]:null;
}

export function projectMapContext(nodes,locations,{inTransit=new Set()}={}){
 const byId=new Map(locations.map(l=>[l.id,l]));
 const corridor=new Map();
 for(const location of locations){
  const ends=corridorEndpoints(location,locations),node=nodes.get(location.mapId);
  if(!ends||!node)continue;
  const pins=ends.map(l=>node.marks.find(m=>m.id===l.id));
  if(pins.some(p=>!p||!Number.isFinite(p.x)||!Number.isFinite(p.y)))continue;
  // These are schematic endpoint positions, not a registered traversable route.
  const points=[boundaryPoint(node,pins[0],pins[1]),boundaryPoint(node,pins[1],pins[0])];corridor.set(location.id,{node,points,location});
  if(node.geo.overviewShapes)node.geo.overviewShapes=node.geo.overviewShapes.filter(s=>s.id!==location.id);
  if(node.geo.districts)node.geo.districts=node.geo.districts.filter(s=>s.id!==location.id);
  node.geo.overviewFeatures=(node.geo.overviewFeatures??[]).filter(f=>f.zoneId!==location.id);
  const routeKey=node.geo.overviewShapes||node.geo.overviewRoutes?'overviewRoutes':'corridorRoutes';
  node.geo[routeKey]=[...(node.geo[routeKey]??[]),{id:`corridor:${location.id}`,name:location.name,points,dashed:true,quality:'layout',locationId:location.id}];
  const mark=node.marks.find(m=>m.id===location.id),[x,y]=midpoint(points);
  if(mark)Object.assign(mark,{x,y,sub:'道路连接示意',quality:'proxy',proxy:true,silent:true});
 }
 for(const location of locations.filter(l=>l.mobility==='mobile'&&!inTransit.has(l.id))){
  // Old self-anchors are invalid. The independently recorded parent remains a
  // coarse containment fact; it never supplies a made-up journey percentage.
  const holder=location.anchorLocationId&&location.anchorLocationId!==location.id?location.anchorLocationId:location.parentLocationId;
  const road=corridor.get(holder),anchor=byId.get(holder),node=road?.node??nodes.get(anchor?.mapId);
  const pin=road?midpoint(road.points):node?.marks.find(m=>m.id===holder);
  if(!node||!pin||node.marks.some(m=>m.id===location.id))continue;
  const [x,y]=Array.isArray(pin)?pin:[pin.x,pin.y],target=location.childMapIds?.[0];
  if(!Number.isFinite(x)||!Number.isFinite(y))continue;
  node.marks.push({id:location.id,placeId:location.id,type:'vehicle',name:location.name,x,y,
   sub:`${road?'道路上':anchor.name+'附近'} · 具体位置未知`,quality:'proxy',proxy:true,c:'#ffc247',node:target?{id:target,known:true}:null});
 }
 // Parent/child links are navigation. Each map keeps its own coordinate frame:
 // a sibling's footprint belongs on the parent and must not enlarge this map.
}
