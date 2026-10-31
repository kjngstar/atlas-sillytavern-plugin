/** Read-only local squares, replacing only the uncalibrated city-row template. */
export function projectLocalSiteMaps(nodes,locations,{maps=[]}={}){
 const places=new Map(locations.map(l=>[l.id,l]));
 const saved=new Map(maps.map(m=>[m.mapId,m]));
 const exact=q=>['confirmed','exact'].includes(q);
 for(const n of nodes.values()){
  const g=n.geo??{},map=saved.get(n.id);
  if(!g.templateCity||!['district','other'].includes(n.containerLocationKind)||!/(?:广场|\bplaza|\bsquare)$/iu.test(n.name))continue;
  if(g.districts?.length!==1||g.districts[0].id!==n.containerLocationId||g.districts[0].quality!=='layout')continue;
  if(g.river?.length||g.wallPoints?.length||map?.routes?.length||exact(n.transform?.metricQuality)||exact(n.transform?.scaleQuality))continue;
  const marks=(n.marks??[]).filter(m=>m.type==='poi'&&places.has(m.id)&&!m.proxy);
  if(!marks.length||marks.some(m=>exact(m.quality))||(map?.points??[]).some(p=>exact(p.area?.quality)||exact(p.markerQuality)))continue;
  const buildings=g.cityBuildings??[];
  if(!buildings.length||buildings.some(b=>b.quality!=='layout'||Math.abs(b.y-buildings[0].y)>1e-6))continue;
  if((g.avenues??[]).some(r=>r.id!=='avenue'&&r.id!==`road:${n.containerLocationId}`))continue;
  // The packer's estimated row is not geographic evidence. Display the known
  // places around an open square, with no invented roads or child maps.
  const colors=['#8aa7b3','#b6a27b','#9995b5','#8fa48e'];
  const placements=new Map(),out=[];
  marks.slice().sort((a,b)=>a.x-b.x||a.y-b.y||a.id.localeCompare(b.id)).forEach((m,i)=>{
   const side=i%4,rank=Math.floor(i/4),count=Math.ceil((marks.length-side)/4);
   const along=(rank-(count-1)/2)*190;
   const [cx,cy]=side===0?[-267,along+20]:side===1?[along-28,-196]:side===2?[267,along-12]:[along+30,204];
   const source=buildings.find(b=>b.id===m.id),ratio=Math.max(.65,Math.min(1.6,(source?.w??1)/(source?.h??1)));
   const w=side%2?136:94,h=w/ratio;
   placements.set(m.id,{x:cx,y:cy});
   const child=(n.children??[]).find(c=>c.containerLocationId===m.id);
   const rooms=(child?.geo?.rooms??[]).filter(r=>[r.x,r.y,r.w,r.h].every(Number.isFinite)&&r.w>0&&r.h>0);
   if(!rooms.length&&child?.geo?.hostArea)rooms.push(child.geo.hostArea);
   const interior=[];
   if(rooms.length){
    const x0=Math.min(...rooms.map(r=>r.x)),y0=Math.min(...rooms.map(r=>r.y));
    const rw=Math.max(...rooms.map(r=>r.x+r.w))-x0,rh=Math.max(...rooms.map(r=>r.y+r.h))-y0;
    const s=Math.min((w-24)/rw,(h-24)/rh);
    if(Number.isFinite(s)&&s>0)for(const r of rooms)interior.push({x:cx+(r.x-x0-rw/2)*s,y:cy+(r.y-y0-rh/2)*s,w:r.w*s,h:r.h*s});
   }
   out.push({id:m.id,name:m.name,x:cx-w/2,y:cy-h/2,w,h,interior,c:colors[i%colors.length],quality:'symbolic',displayOnly:true});
  });
  n.marks=(n.marks??[]).map(m=>{
   const p=placements.get(m.id)??placements.get(m.locationId);
   return p?{...m,...p,quality:'symbolic',sub:'位置示意'}:{...m};
  });
  const xs=out.flatMap(b=>[b.x,b.x+b.w]),ys=out.flatMap(b=>[b.y,b.y+b.h]);
  n.geo={...g,districts:[],avenues:[],cityBuildings:out,localSite:{
   polygon:[[-208,-98],[-118,-136],[149,-136],[220,-91],[220,96],[110,136],[-175,122],[-220,76]],
   bounds:[Math.min(-330,...xs)-35,Math.max(330,...xs)+35,Math.min(-260,...ys)-35,Math.max(260,...ys)+55],
   note:'广场略图 · 建筑外形与相对分布为示意',displayOnly:true}};
 }
}
