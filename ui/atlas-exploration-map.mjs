/** Coarse, read-only map drawing. A sketch never supplies SQL positions or distances. */
const point=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite);
const polygon=p=>Array.isArray(p)&&p.length>=3&&p.every(point);
const rect=r=>[[r.x,r.y],[r.x+r.w,r.y],[r.x+r.w,r.y+r.h],[r.x,r.y+r.h]];
const validRect=r=>r&&[r.x,r.y,r.w,r.h].every(Number.isFinite)&&r.w>0&&r.h>0;
const sort=(a,b)=>a.id.localeCompare(b.id);
const palette=['#639aaf','#8d91bb','#88a38c','#b49a74'];

// Use the child's recorded outline, with its proportions intact. Furniture is
// deliberately omitted at this level; entering the child exposes its full map.
function footprint(node,depth=0){
 const g=node.geo??{};
 const parts=[...(g.overviewShapes??[]),...(g.districts??[])].filter(s=>polygon(s.pts)).map(s=>s.pts);
 if(!parts.length)parts.push(...(g.rooms??[]).filter(validRect).map(rect));
 if(!parts.length&&polygon(g.selfArea?.pts))parts.push(g.selfArea.pts);
 if(!parts.length&&validRect(g.hostArea))parts.push(rect(g.hostArea));
 if(!parts.length&&depth<2){
  const children=(node.children??[]).filter(n=>n.known!==false&&!n.unclassified&&n.containerLocationKind!=='floor').sort(sort);
  children.forEach((n,i)=>{const f=footprint(n,depth+1);if(f.recorded)parts.push(...f.parts.map(poly=>poly.map(([x,y])=>[x+(i%3)*250,y+Math.floor(i/3)*180])));});
 }
 if(!parts.length)return {recorded:false,parts:[[[-92,-48],[-24,-48],[-24,-65],[55,-65],[55,-42],[93,-42],[93,28],[62,28],[62,58],[-48,58],[-48,39],[-92,39]]],features:[]};
 const pts=parts.flat(),xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);
 const x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
 const s=Math.min(196/Math.max(1,x1-x0),132/Math.max(1,y1-y0));
 const xy=([x,y])=>[(x-(x0+x1)/2)*s,(y-(y0+y1)/2)*s];
 return {recorded:true,parts:parts.map(poly=>poly.map(xy)),features:(g.overviewFeatures??[]).map(f=>({...f,poly:f.poly?.map(xy),line:f.line?.map(xy),width:(f.width??1)*s}))};
}

export function projectExplorationMaps(nodes,locations,{maps=[],viewMode='player'}={}){
 const byPlace=new Map([...nodes.values()].filter(n=>n.containerLocationId).map(n=>[n.containerLocationId,n]));
 const visible=new Set(locations.map(l=>l.id));
 const routes=[...new Map(maps.flatMap(m=>m.routes??[]).filter(r=>r.hidden!==true||viewMode==='author').map(r=>[r.routeId??r.id,r])).values()];
 const source=new Map([...nodes].map(([id,n])=>[id,{...n,geo:structuredClone(n.geo)}]));
 for(const n of nodes.values()){
  const g=n.geo??{};
  // Existing local geometry remains authoritative. Never re-layout a real floor,
  // terrain map, measured footprint, or locations that already have positions.
  const outlines=[...(g.overviewShapes??[]),...(g.districts??[])];
  if(n.metric>0&&!['layout','estimated','uncalibrated'].includes(n.transform?.metricQuality??n.transform?.scaleQuality))continue;
  if(n.unclassified||n.renderKind==='floor'||g.hostArea||g.rooms?.length||outlines.some(s=>n.hasLayout!==false||['confirmed','exact'].includes(s.quality))||g.overviewFeatures?.length||g.selfArea||g.river?.length)continue;
  const children=(n.children??[]).filter(c=>c.known!==false&&!c.unclassified&&c.containerLocationKind!=='floor').sort(sort);
  const local=new Map(children.map(c=>[c.id,c]));
  const owner=id=>{
   let at=byPlace.get(id);const seen=new Set();
   if(!at)return null;
   if(at===n)return n;
   while(at&&!seen.has(at.id)){seen.add(at.id);if(at.parentMapId===n.id)return at;at=nodes.get(at.parentMapId);}
   return null;
  };
  const edges=[];
  for(const r of routes){
   const from=r.fromLocationId??r.fromId,to=r.toLocationId??r.toId;
   if(viewMode!=='author'&&(!visible.has(from)||!visible.has(to)))continue;
   let a=owner(from),b=owner(to);
   if(!a&&!b||a&&b&&a.id===b.id)continue;
   // Adjacent destinations come only from a recorded route with visible ends.
   if(!a)a=byPlace.get(from);if(!b)b=byPlace.get(to);
   if(!a||!b||a.known===false||b.known===false)continue;
   if(a!==n)local.set(a.id,a);if(b!==n)local.set(b.id,b);
   edges.push({id:r.routeId??r.id,from:a.id,to:b.id,kind:r.kind,status:r.status,distanceM:r.distanceM??null,quality:r.geometryQuality??r.quality??'estimated'});
  }
  if(!local.size)continue;
  const areas=[...local.values()].sort(sort).map((c,i)=>({id:c.containerLocationId,nodeId:c.id,name:c.name,
   external:!children.includes(c),mobile:locations.find(l=>l.id===c.containerLocationId)?.mobility==='mobile',
   c:palette[i%palette.length],...footprint(source.get(c.id)??c)}));
  // A neighbouring map is an exit at the edge of this view, not another giant
  // territory pasted into the current interior.
  for(const a of areas)if(a.external){a.parts=[[[-16,-20],[16,-20],[16,20],[-16,20]]];a.recorded=false;}
  // Connected components occupy compact rows. Route length does not determine
  // screen length: this view explicitly has no metric scale or north arrow.
  const ordered=[],remaining=new Set(areas.map(a=>a.nodeId));
  while(remaining.size){const queue=[remaining.values().next().value];remaining.delete(queue[0]);
   for(let i=0;i<queue.length;i++){const id=queue[i];ordered.push(id);for(const e of edges){const next=e.from===id?e.to:e.to===id?e.from:null;if(remaining.has(next)){remaining.delete(next);queue.push(next);}}}
  }
  const cols=Math.min(3,Math.max(1,Math.ceil(Math.sqrt(areas.length)))),rows=Math.ceil(areas.length/cols);
  for(const a of areas){const i=ordered.indexOf(a.nodeId);a.x=(i%cols-(cols-1)/2)*290;a.y=(Math.floor(i/cols)-(rows-1)/2)*215;}
  const selfEdges=edges.filter(e=>e.from===n.id||e.to===n.id);
  const hub=[0,0];
  if(selfEdges.length){
   const exits=areas.filter(a=>selfEdges.some(e=>e.from===a.nodeId||e.to===a.nodeId));
   exits.forEach((a,i)=>{a.x=exits.length===1?280:(i%2?310:-310);a.y=Math.floor(i/2)*200;});
   const within=areas.filter(a=>!exits.includes(a));
   within.forEach((a,i)=>{a.x=(i-(within.length-1)/2)*260;a.y=-165;});
  }
  const anchors=new Map((n.marks??[]).filter(m=>['poi','vehicle'].includes(m.type)&&!m.proxy&&Number.isFinite(m.x)&&Number.isFinite(m.y)).map(m=>[m.id,m]));
  // Preserve every recorded anchor, even when its geometry is still missing.
  // Only the drawn thumbnail size adapts to prevent adjacent outlines colliding.
  const anchored=areas.filter(a=>anchors.has(a.id));
  let spacing=Infinity;
  for(let i=0;i<anchored.length;i++)for(let j=0;j<i;j++){const a=anchors.get(anchored[i].id),b=anchors.get(anchored[j].id);spacing=Math.min(spacing,Math.hypot(a.x-b.x,a.y-b.y));}
  const thumbnailScale=Math.min(1,Math.max(.2,spacing/290));
  for(const a of anchored){const p=anchors.get(a.id);a.x=p.x;a.y=p.y;a.parts=a.parts.map(poly=>poly.map(([x,y])=>[x*thumbnailScale,y*thumbnailScale]));}
  const inside=areas.filter(a=>!a.external);
  if(inside.length){
   const xs=inside.map(a=>a.x),ys=inside.map(a=>a.y),cx=(Math.min(...xs)+Math.max(...xs))/2,cy=(Math.min(...ys)+Math.max(...ys))/2;
   hub[0]=cx;hub[1]=selfEdges.length?cy+95:cy;
   areas.filter(a=>a.external).forEach((a,i)=>{a.x=i%2?Math.max(...xs)+180:Math.min(...xs)-180;a.y=cy+95+Math.floor(i/2)*120;});
  }
  const positions=new Map(areas.map(a=>[a.nodeId,[a.x,a.y]]));
  positions.set(n.id,hub);
  const atBoundary=(id,toward)=>{const p=positions.get(id),area=areas.find(a=>a.nodeId===id);if(!area)return p;
   const pts=area.parts.flat(),hx=Math.max(...pts.map(q=>Math.abs(q[0]))),hy=Math.max(...pts.map(q=>Math.abs(q[1]))),dx=toward[0]-p[0],dy=toward[1]-p[1];
   const k=Math.min(dx?hx/Math.abs(dx):Infinity,dy?hy/Math.abs(dy):Infinity);return Number.isFinite(k)?[p[0]+dx*k,p[1]+dy*k]:p;};
  const passages=edges.map(e=>{const a=atBoundary(e.from,positions.get(e.to)),b=atBoundary(e.to,positions.get(e.from));return {...e,points:[a,[(a[0]+b[0])/2,a[1]],[(a[0]+b[0])/2,b[1]],b]};});
  const all=[...areas.flatMap(a=>a.parts.flat().map(([x,y])=>[x+a.x,y+a.y])),...passages.flatMap(e=>e.points)];
  const xs=all.map(p=>p[0]),ys=all.map(p=>p[1]);
  n.geo={...g,exploration:{areas,passages,hub:selfEdges.length?hub:null,
   bounds:[Math.min(...xs)-65,Math.max(...xs)+65,Math.min(...ys)-55,Math.max(...ys)+90],
   note:'区域略图 · 方位与比例待定',displayOnly:true}};
 }
}
