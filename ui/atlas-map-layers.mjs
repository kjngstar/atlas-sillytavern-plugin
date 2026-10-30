/** Semantic map detail, independent of tree depth. All inferred regions are display only. */
export function mapDetailLevel(node){
 const kind=node.containerLocationKind??node.renderKind??node.kind;
 return ['world','region','city'].includes(kind)?'regions':
  ['district','building','floor','room','vehicle','detail'].includes(kind)?'detail':'layout';
}
const palette=['#6799b1','#a58ab5','#92a879','#bd9b6b','#789fb0','#b88289'];
const polygon=p=>Array.isArray(p)&&p.length>=3&&p.every(q=>Array.isArray(q)&&q.length===2&&q.every(Number.isFinite));
const center=pts=>[pts.reduce((s,p)=>s+p[0],0)/pts.length,pts.reduce((s,p)=>s+p[1],0)/pts.length];
function clip(poly,a,b){
 const dx=b[0]-a[0],dy=b[1]-a[1],limit=(b[0]*b[0]+b[1]*b[1]-a[0]*a[0]-a[1]*a[1])/2;
 const side=p=>p[0]*dx+p[1]*dy-limit,out=[];
 for(let i=0;i<poly.length;i++){
  const p=poly[i],q=poly[(i+1)%poly.length],u=side(p),v=side(q);
  if(u<=1e-8)out.push(p);
  if((u<0&&v>0)||(u>0&&v<0)){const t=u/(u-v);out.push([p[0]+(q[0]-p[0])*t,p[1]+(q[1]-p[1])*t]);}
 }
 return out;
}
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
 const xs=land.map(a=>a.x),ys=land.map(a=>a.y),span=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys),240);
 const cx=(Math.min(...xs)+Math.max(...xs))/2,cy=(Math.min(...ys)+Math.max(...ys))/2;
 const w=Math.max(span*.8,(Math.max(...xs)-Math.min(...xs))/2+span*.3),h=Math.max(span*.5,(Math.max(...ys)-Math.min(...ys))/2+span*.3);
 const outline=[[-.94,-.68],[-.55,-1],[.15,-.94],[.74,-.83],[1,-.3],[.94,.52],[.53,.96],[-.15,1],[-.76,.8],[-1,.18]].map(([x,y])=>[cx+x*w,cy+y*h]);
 // Coincident anchors remain untouched; only the cartographic partition seeds separate.
 const seeds=land.map((a,i)=>land.some((b,j)=>j<i&&Math.hypot(a.x-b.x,a.y-b.y)<1e-6)?[a.x+Math.cos(i*2.4)*span*.12,a.y+Math.sin(i*2.4)*span*.12]:[a.x,a.y]);
 for(const a of areas){
  if(a.mobile){a.parts=[[[-18,-12],[18,-12],[18,12],[-18,12]]];continue;}
  let pts;
  if(a.exact)pts=a.sourceParts[0];
  else {const i=land.indexOf(a);pts=outline;for(let j=0;j<seeds.length;j++)if(j!==i)pts=clip(pts,seeds[i],seeds[j]);}
  if(!polygon(pts))pts=a.sourceParts?.[0]??outline;
  a.parts=[pts.map(([x,y])=>[x-a.x,y-a.y])];
  const p=center(pts);a.label=[p[0]-a.x,p[1]-a.y];delete a.sourceParts;
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
  note:'区域分区 · 色块区分下属地点，示意边界非实测',displayOnly:true};
}

/** Context extent has no wall/room semantics and supplies no traversable paths. */
export function siteContext(areas){
 const pts=areas.filter(a=>!a.external&&!a.mobile).flatMap(a=>a.parts.flat().map(([x,y])=>[x+a.x,y+a.y]));
 if(!pts.length)return {outlines:[],forecourt:null,displayOnly:true};
 const x0=Math.min(...pts.map(p=>p[0]))-55,x1=Math.max(...pts.map(p=>p[0]))+55,y0=Math.min(...pts.map(p=>p[1]))-55,y1=Math.max(...pts.map(p=>p[1]))+75;
 const w=x1-x0,h=y1-y0;
 return {outlines:[[[x0,y0+h*.28],[x0+w*.12,y0],[x0+w*.7,y0-h*.04],[x1,y0+h*.2],[x1+w*.03,y0+h*.72],[x0+w*.8,y1],[x0+w*.24,y1+h*.03],[x0-w*.04,y0+h*.7]]],forecourt:null,displayOnly:true};
}
