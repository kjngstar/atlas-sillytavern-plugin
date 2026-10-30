/** Cartographic symbols identify a known place; they are never physical geometry. */
const finite=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite);
export function mapSymbolKind(node,location){
 const kind=location?.entityKind??node.containerLocationKind;
 if(location?.mobility==='mobile'||['building','floor','room','vehicle','city','district','region','world'].includes(kind))return null;
 const name=String(location?.name??node.name??'').trim();
 return /(?:桥|\bbridge)$/iu.test(name)?'bridge':null;
}

export function bridgeMapSymbol(geo,{thumbnail=false}={}){
 const source=(geo.overviewFeatures??[]).find(f=>f.type==='watercourse'&&f.line?.length>=2&&f.line.every(finite));
 const raw=source?.line??null,mid=raw?Math.floor(raw.length/2):0;
 const center=thumbnail||!raw?[0,0]:[...raw[mid]];
 let points=raw?.map(p=>[p[0],p[1]])??null,scale=1;
 if(raw&&thumbnail){
  const span=Math.max(...raw.map(p=>Math.hypot(p[0]-raw[mid][0],p[1]-raw[mid][1])),1);
  scale=88/span;points=raw.map(p=>[(p[0]-raw[mid][0])*scale,(p[1]-raw[mid][1])*scale]);
 }
 const a=points?.[Math.max(0,mid-1)]??[0,-1],b=points?.[Math.min(points.length-1,mid+1)]??[0,1];
 const length=Math.hypot(b[0]-a[0],b[1]-a[1])||1;
 const along=[(b[0]-a[0])/length,(b[1]-a[1])/length],across=[along[1],-along[0]];
 const riverWidth=source?Math.max(20,Math.min(thumbnail?38:70,(source.width??32)*scale)):0;
 const half=Math.max(58,riverWidth*1.4),halfWidth=thumbnail?12:14;
 const deck=[[-half,-halfWidth],[half,-halfWidth],[half,halfWidth],[-half,halfWidth]].map(([x,y])=>[center[0]+across[0]*x+along[0]*y,center[1]+across[1]*x+along[1]*y]);
 const banks=points?[-1,1].map(sign=>points.map((p,i)=>{const a=points[Math.max(0,i-1)],b=points[Math.min(points.length-1,i+1)],l=Math.hypot(b[0]-a[0],b[1]-a[1])||1;return [p[0]+sign*(b[1]-a[1])/l*riverWidth/2,p[1]-sign*(b[0]-a[0])/l*riverWidth/2];})):[];
 return {kind:'bridge',center,deck,along,across,half,halfWidth,
  river:points?{points,width:riverWidth,banks,sourceFeatureId:source.id??null}:null,
  quality:'symbolic',displayOnly:true};
}
