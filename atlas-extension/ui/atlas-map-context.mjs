/** Read-only map context. Display proxies never become SQL positions or travel progress. */
const finitePoint=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite);
const polygon=p=>Array.isArray(p)&&p.length>=3&&p.every(finitePoint);
const bounds=pts=>({x0:Math.min(...pts.map(p=>p[0])),x1:Math.max(...pts.map(p=>p[0])),y0:Math.min(...pts.map(p=>p[1])),y1:Math.max(...pts.map(p=>p[1]))});
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
 const depth=node=>{let current=node,n=0;const seen=new Set();while(current&&!seen.has(current.id)){seen.add(current.id);n++;current=nodes.get(current.parentMapId);}return n;};
 for(const node of [...nodes.values()].sort((a,b)=>depth(a)-depth(b))){
  if(!node.parentMapId||!node.containerLocationId||byId.get(node.containerLocationId)?.mobility==='mobile')continue;
  const parent=nodes.get(node.parentMapId),active=parent&&outline(parent,node.containerLocationId);
  if(!active)continue;
  const b=bounds(active.pts),w=b.x1-b.x0,h=b.y1-b.y0,t=node.transform;
  if(!(w>0&&h>0&&t?.bounds&&t.scale>0))continue;
  const scale=Math.min(t.bounds.w*t.scale/w,t.bounds.h*t.scale/h),cx=(b.x0+b.x1)/2,cy=(b.y0+b.y1)/2;
  const project=p=>[(p[0]-cx)*scale,(p[1]-cy)*scale];
  const siblings=(parent.children??[]).filter(s=>s.id!==node.id&&!s.unclassified&&byId.get(s.containerLocationId)?.mobility!=='mobile').flatMap(s=>{
   const shape=outline(parent,s.containerLocationId);return shape?[{...shape,nodeId:s.id,name:s.name,pts:shape.pts.map(project)}]:[];
  });
  node.geo.parentContext={parentMapId:parent.id,active:{...active,pts:active.pts.map(project)},siblings};
  // A district is a zoom into its parent footprint, not another generic city
  // outline. Keep the parent's exact polygon topology in the child projection.
  if(node.kind==='district'&&node.geo.districts?.length===1&&node.geo.districts[0].id===node.containerLocationId)node.geo.districts[0].pts=active.pts.map(project);
  for(const s of siblings){const [x,y]=midpoint(s.pts);node.marks.push({id:s.id,placeId:s.id,type:'poi',name:s.name,x,y,sub:'同级区域',context:true,quality:s.quality,c:s.c??'#7f94b3',node:{id:s.nodeId,known:true}});}
  const all=[...active.pts.map(project),...siblings.flatMap(s=>s.pts)],e=bounds(all);
  node.extent=[Math.min(node.extent[0],e.x0-30),Math.max(node.extent[1],e.x1+30),Math.min(node.extent[2],e.y0-30),Math.max(node.extent[3],e.y1+30)];
 }
}
