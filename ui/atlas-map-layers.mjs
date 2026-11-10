/** Semantic map detail, independent of tree depth. All inferred regions are display only. */
export function mapDetailLevel(node){
 const kind=node.containerLocationKind??node.renderKind??node.kind;
 return ['world','region','city'].includes(kind)?'regions':
  ['district','building','floor','room','vehicle','detail'].includes(kind)?'detail':'layout';
}
const palette=['#6799b1','#a58ab5','#92a879','#bd9b6b','#789fb0','#b88289'];
const polygon=p=>Array.isArray(p)&&p.length>=3&&p.every(q=>Array.isArray(q)&&q.length===2&&q.every(Number.isFinite));
const center=pts=>[pts.reduce((s,p)=>s+p[0],0)/pts.length,pts.reduce((s,p)=>s+p[1],0)/pts.length];
export function regionOverview(node,children,{locations=[],nodes=new Map(),routes=[]}={}){
 const shapes=node.geo?.overviewShapes??node.geo?.districts??[],marks=node.marks??[];
 const places=new Map(locations.map(l=>[l.id,l]));
 const ordered=[...children].sort((a,b)=>a.id.localeCompare(b.id));
 const areas=ordered.map((child,i)=>{
  const shape=shapes.find(s=>s.id===child.containerLocationId&&polygon(s.pts));
  const anchor=marks.find(m=>m.id===child.containerLocationId&&!m.proxy&&Number.isFinite(m.x)&&Number.isFinite(m.y));
  const p=shape?center(shape.pts):anchor?[anchor.x,anchor.y]:[(i%3)*300,Math.floor(i/3)*240];
  return {id:child.containerLocationId??child.id,nodeId:child.id,name:child.name,c:palette[i%palette.length],x:p[0],y:p[1],
   mobile:places.get(child.containerLocationId)?.mobility==='mobile',recorded:!!shape,
   exact:!!shape&&['confirmed','exact'].includes(shape.quality),sourceParts:shape?[shape.pts]:null,
   childCount:(child.children??[]).filter(c=>c.known!==false&&!c.unclassified).length};
 });
 const land=areas.filter(a=>!a.mobile);
 if(!land.length)return null;
 for(const a of areas){
  if(a.mobile){a.parts=[[[-18,-12],[18,-12],[18,12],[-18,12]]];continue;}
  // A place is a footprint on the map, not ownership of every surrounding pixel.
  const spacing=Math.min(...land.filter(b=>b!==a).map(b=>Math.hypot(a.x-b.x,a.y-b.y)).filter(d=>d>1e-6));
  const w=Math.max(45,Math.min(100,spacing*.34)),h=w*.65;
  a.parts=a.exact?[a.sourceParts[0].map(([x,y])=>[x-a.x,y-a.y])]:[[[-w,-h],[w,-h],[w,h],[-w,h]]];
  a.label=a.exact?center(a.parts[0]):[0,0];delete a.sourceParts;
 }
 const all=areas.flatMap(a=>a.parts.flat().map(([x,y])=>[x+a.x,y+a.y]));
 const owner=id=>{
  let at=[...nodes.values()].find(n=>n.containerLocationId===id);const seen=new Set();
  while(at&&!seen.has(at.id)){seen.add(at.id);const a=areas.find(a=>a.nodeId===at.id);if(a)return a;at=nodes.get(at.parentMapId);}
  return null;
 };
 const passages=routes.flatMap(r=>{
  const a=owner(r.fromLocationId??r.fromId),b=owner(r.toLocationId??r.toId);
  if(!a||!b||a===b)return [];
  return [{id:r.routeId??r.id,from:a.nodeId,to:b.nodeId,status:r.status,kind:r.kind,distanceM:r.distanceM??null,
   points:[[a.x,a.y],[b.x,b.y]],quality:r.geometryQuality??r.quality??'estimated'}];
 });
 return {level:'regions',areas,passages,surface:{outlines:[],forecourt:null},
  bounds:[Math.min(...all.map(p=>p[0]))-35,Math.max(...all.map(p=>p[0]))+35,Math.min(...all.map(p=>p[1]))-35,Math.max(...all.map(p=>p[1]))+65],
  note:'区域略图 · 地点轮廓与位置为示意，连线来自已登记路线',displayOnly:true};
}

/** Context extent has no wall/room semantics and supplies no traversable paths. */
export function siteContext(areas){
 return {outlines:[],forecourt:null,displayOnly:true};
}
