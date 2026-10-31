/** Read-only cartography. These symbols never become SQL footprints or routes. */
const finite=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite);
const lerp=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);

/** Offset an open polyline with bounded miters; the ends stay open street mouths. */
export function streetRibbon(path,width){
 const points=path.filter(finite).filter((p,i,a)=>!i||Math.hypot(p[0]-a[i-1][0],p[1]-a[i-1][1])>1e-6);
 if(points.length<2||!Number.isFinite(width)||width<=0)return null;
 const normals=points.slice(1).map((p,i)=>{const a=points[i],l=Math.hypot(p[0]-a[0],p[1]-a[1]);return [-(p[1]-a[1])/l,(p[0]-a[0])/l];});
 const sides=[-1,1].map(sign=>points.map((p,i)=>{
  const a=normals[Math.max(0,i-1)],b=normals[Math.min(i,normals.length-1)],n=[a[0]+b[0],a[1]+b[1]],l=Math.hypot(...n);
  const unit=l>1e-6?n.map(v=>v/l):b,m=width/2/Math.max(.5,unit[0]*b[0]+unit[1]*b[1]);
  return [p[0]+sign*unit[0]*m,p[1]+sign*unit[1]*m];
 }));
 return {points:points.map(p=>[...p]),width,edges:sides,polygon:[...sides[0],...sides[1].toReversed()],quality:'symbolic',displayOnly:true};
}

export function streetSurface(passages,{name,alley=false,hub=[0,0]}={}){
 const width=alley?58:84;
 // Only registered connections get street mouths. A disconnected named street
 // still has a road surface, without inventing any destination or route.
 const paths=passages.length?passages.map(p=>p.points):[[[hub[0]-240,hub[1]],[hub[0]+240,hub[1]]]];
 const ribbons=paths.map(p=>streetRibbon(p,width)).filter(Boolean);
 return {name,alley,ribbons,label:[...hub],quality:'symbolic',displayOnly:true};
}

/** A template's city-wide Voronoi cell is not the outline of a named plaza.
 * Draw an inset locality symbol instead, keeping its anchor and source intact.
 * Confirmed contours and cells containing saved buildings are never reshaped.
 */
export function cityLocality(d,{hasBuildings=false,template=false}={}){
 if(!template||d.quality!=='layout'||hasBuildings||!d.pts?.every(finite)||d.pts.length<3)return d;
 const p=d.pts,c=finite(d.site)?d.site:[p.reduce((s,p)=>s+p[0],0)/p.length,p.reduce((s,p)=>s+p[1],0)/p.length];
 const name=String(d.name??''),role=/(?:广场|plaza|square)$/iu.test(name)?'plaza':/(?:码头|埠|quay|dock)$/iu.test(name)?'quay':/(?:集市|市场|market)$/iu.test(name)?'market':'district';
 // The long rectangular template for a market is a territory, not its extent.
 // Bound the symbol's aspect ratio, then bevel street corners rather than
 // sharing a frame edge with the next district. No random coastline or parcels.
 const xs=p.map(p=>p[0]),ys=p.map(p=>p[1]),w=Math.max(...xs)-Math.min(...xs),h=Math.max(...ys)-Math.min(...ys);
 if(!(w>0&&h>0)||p.some((v,i)=>Math.hypot(v[0]-p[(i+1)%p.length][0],v[1]-p[(i+1)%p.length][1])<1e-6))return d;
 const sx=.74*Math.min(1,(role==='quay'?2.2:1.55)*h/w),sy=.70*Math.min(1,(role==='quay'?.65:1.45)*w/h);
 const inset=p.map(([x,y])=>[c[0]+(x-c[0])*sx,c[1]+(y-c[1])*sy]);
 const pts=inset.flatMap((v,i)=>{
  const prev=inset[(i+inset.length-1)%inset.length],next=inset[(i+1)%inset.length];
  const a=Math.hypot(v[0]-prev[0],v[1]-prev[1]),b=Math.hypot(v[0]-next[0],v[1]-next[1]);
  const cut=Math.min(a,b)*(role==='plaza'?.18:role==='market'?.12:.08);
  return [lerp(v,prev,cut/a),lerp(v,next,cut/b)];
 });
 return {...d,pts,sourcePts:p.map(p=>[...p]),site:[...c],role,displayOnly:true,quality:'symbolic'};
}
