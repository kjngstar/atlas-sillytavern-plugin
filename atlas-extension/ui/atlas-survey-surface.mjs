/** A cartographic backdrop, not a physical boundary or a traversable route. */
export function surveySurface(areas,passages,{sharedSite=false,hub=null}={}){
 const step=10,cells=new Set(),limit=30000;
 const put=(x,y,w,h)=>{
  if(![x,y,w,h].every(Number.isFinite)||w<0||h<0)return;
  const x0=Math.floor(x/step),x1=Math.ceil((x+w)/step),y0=Math.floor(y/step),y1=Math.ceil((y+h)/step);
  if((x1-x0)*(y1-y0)>limit)return;
  for(let j=y0;j<y1;j++)for(let i=x0;i<x1;i++){if(cells.size>=limit)return;cells.add(i+','+j);}
 };
 const ribbon=(points,width)=>{for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i];put(Math.min(a[0],b[0])-width/2,Math.min(a[1],b[1])-width/2,Math.abs(a[0]-b[0])+width,Math.abs(a[1]-b[1])+width);}};
 const fixed=areas.filter(a=>!a.external&&!a.mobile).map(a=>{
  const pts=a.parts.flat();return {a,x0:a.x+Math.min(...pts.map(p=>p[0])),x1:a.x+Math.max(...pts.map(p=>p[0])),y0:a.y+Math.min(...pts.map(p=>p[1])),y1:a.y+Math.max(...pts.map(p=>p[1]))};
 });
 for(const p of fixed)put(p.x0-20,p.y0-20,p.x1-p.x0+40,p.y1-p.y0+40);
 let forecourt=null;
 if(sharedSite&&fixed.length){
  const x0=Math.min(...fixed.map(p=>p.x0))-20,x1=Math.max(...fixed.map(p=>p.x1))+20;
  const y=Math.max(...fixed.map(p=>p.y1))+28;
  // Known children share their parent's drawing surface. This open forecourt
  // does not add graph edges, door claims, named roads, or routing geometry.
  if(x1-x0<=2400){
   put(x0,y-23,x1-x0,46);forecourt={x0,x1,y};
   for(const p of fixed)put(p.a.x-25,p.y1,50,Math.max(0,y-p.y1));
   if(hub)ribbon([[hub[0],y],hub],46);
  }
 }
 for(const p of passages)ribbon(p.points,26);
 // Trace the union once. Internal cell/rectangle edges never become seams.
 const edges=new Map();
 const edge=(a,b)=>{const key=a+'>'+b,reverse=b+'>'+a;if(edges.has(reverse))edges.delete(reverse);else edges.set(key,[a,b]);};
 for(const c of cells){const [x,y]=c.split(',').map(Number);edge([x,y].join(','),[x+1,y].join(','));edge([x+1,y].join(','),[x+1,y+1].join(','));edge([x+1,y+1].join(','),[x,y+1].join(','));edge([x,y+1].join(','),[x,y].join(','));}
 const next=new Map();for(const [key,[a,b]]of edges){if(!next.has(a))next.set(a,[]);next.get(a).push({key,b});}
 const outlines=[];
 while(edges.size){
  const [key,[start,end]]=edges.entries().next().value;edges.delete(key);
  const points=[start,end];let at=end;
  while(at!==start&&points.length<=limit*4){const e=next.get(at)?.find(e=>edges.has(e.key));if(!e)break;edges.delete(e.key);at=e.b;points.push(at);}
  if(at!==start)continue;points.pop();
  const raw=points.map(p=>p.split(',').map(v=>Number(v)*step));
  const corners=raw.filter((p,i)=>{const a=raw[(i+raw.length-1)%raw.length],b=raw[(i+1)%raw.length];return (p[0]-a[0])*(b[1]-p[1])!==(p[1]-a[1])*(b[0]-p[0]);});
  if(corners.length>=3)outlines.push(corners);
 }
 return {outlines,forecourt,quality:'schematic',displayOnly:true};
}
