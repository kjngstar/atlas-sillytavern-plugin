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
 let paths=passages.length?passages.map(p=>p.points):[[[hub[0]-240,hub[1]],[hub[0]+240,hub[1]]]];
 const atHub=p=>Math.hypot(p[0]-hub[0],p[1]-hub[1])<1e-6;
 if(paths.length===2&&paths.every(p=>atHub(p[0])||atHub(p.at(-1)))){
  const arms=paths.map(p=>atHub(p[0])?p:[...p].reverse());
  paths=[arms[0].toReversed().concat(arms[1].slice(1))];
  const a=paths[0][0],b=paths[0].at(-1),dx=b[0]-a[0],dy=b[1]-a[1],l=Math.hypot(dx,dy);
  // When we only know the two mouths, give the alley a shallow change in
  // alignment. This is a symbol, never a replacement for a recorded path.
  if(alley&&l>100&&passages.every(p=>!['confirmed','exact'].includes(p.quality))&&paths[0].every(p=>Math.abs((p[0]-a[0])*dy-(p[1]-a[1])*dx)<1e-5)){
   const n=[-dy/l,dx/l],bend=Math.min(24,l*.04);
   paths=[[a,lerp(a,b,.32).map((v,i)=>v+n[i]*bend),lerp(a,b,.66).map((v,i)=>v-n[i]*bend*.4),b]];
  }
 }
 const ribbons=paths.map(p=>streetRibbon(p,width)).filter(Boolean);
 const frontages=[],paving=[];
 for(const r of ribbons){
  const spans=r.points.slice(1).map((p,i)=>Math.hypot(p[0]-r.points[i][0],p[1]-r.points[i][1])),length=spans.reduce((s,v)=>s+v,0);
  const at=d=>{let i=0;while(i<spans.length-1&&d>spans[i])d-=spans[i++];const a=r.points[i],b=r.points[i+1],p=lerp(a,b,d/spans[i]);return {p,n:[-(b[1]-a[1])/spans[i],(b[0]-a[0])/spans[i]]};};
  const offset=(d,side,depth)=>{const {p,n}=at(d);return p.map((v,i)=>v+n[i]*side*depth);};
  for(const side of [-1,1])for(const [i,pair] of [[.04,.26],[.30,.59],[.65,.95]].entries()){
   const a=length*(pair[0]+(side>0?.012:0)),b=length*(pair[1]-(side>0?.025:0)),near=width/2+12,deep=near+38+(i===1?26:side>0?12:0);
   frontages.push({pts:[offset(a,side,near),offset(b,side,near),offset(b,side,deep-8),offset((a+b)/2,side,deep),offset(a,side,deep)],decorative:true,displayOnly:true});
  }
  for(let d=24;d<length-16;d+=30)paving.push([offset(d,-1,width/2-5),offset(d,1,width/2-5)]);
 }
 return {name,alley,ribbons,frontages,paving,label:[...hub],quality:'symbolic',displayOnly:true};
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
 const px=pts.map(p=>p[0]),py=pts.map(p=>p[1]),x0=Math.min(...px),y0=Math.min(...py),bw=Math.max(...px)-x0,bh=Math.max(...py)-y0;
 // Small, unlabeled frontage masses are a locality symbol, not registered
 // houses. A plaza leaves its middle open; a market has two groups of awnings;
 // a quay leaves a broad apron at the stair edge. No random city wallpaper.
 const patterns=role==='market'?
  [[[.12,.12],[.40,.12],[.40,.31],[.12,.31]],[[.58,.16],[.88,.16],[.88,.34],[.58,.34]],[[.15,.41],[.40,.41],[.40,.58],[.15,.58]],[[.58,.44],[.85,.44],[.85,.62],[.58,.62]],[[.10,.70],[.40,.70],[.40,.87],[.10,.87]],[[.58,.73],[.90,.73],[.90,.90],[.58,.90]]]:role==='quay'?
  [[[.08,.12],[.39,.12],[.39,.37],[.25,.37],[.25,.45],[.08,.45]],[[.47,.10],[.90,.10],[.90,.36],[.68,.36],[.68,.42],[.47,.42]]]:
  [[[.06,.10],[.40,.10],[.40,.24],[.22,.24],[.22,.34],[.06,.34]],[[.54,.07],[.90,.07],[.90,.30],[.77,.30],[.77,.22],[.54,.22]],[[.05,.43],[.20,.43],[.20,.67],[.27,.67],[.27,.87],[.08,.87]],[[.75,.42],[.93,.42],[.93,.88],[.63,.88],[.63,.73],[.75,.73]],[[.34,.78],[.51,.78],[.51,.94],[.34,.94]]];
 const fabric=patterns.map(poly=>({pts:poly.map(([x,y])=>[x0+x*bw,y0+y*bh]),decorative:true,displayOnly:true}));
 return {...d,pts,sourcePts:p.map(p=>[...p]),site:[...c],role,fabric,displayOnly:true,quality:'symbolic'};
}
