// Deterministic, bounded rectangle placement for direct room connections.
// Sizes and confirmed positions are constraints; search exhaustion is not proof of no space.
const EPS=1e-7, OVERLAP=.8;
const overlaps=(a,b)=>a.x<b.x+b.w-EPS&&a.x+a.w>b.x+EPS&&a.y<b.y+b.h-EPS&&a.y+a.h>b.y+EPS;
const inside=(r,b)=>r.x>=b.x-EPS&&r.y>=b.y-EPS&&r.x+r.w<=b.x+b.w+EPS&&r.y+r.h<=b.y+b.h+EPS;
const extent=rs=>({x:Math.min(...rs.map(r=>r.x)),y:Math.min(...rs.map(r=>r.y)),right:Math.max(...rs.map(r=>r.x+r.w)),bottom:Math.max(...rs.map(r=>r.y+r.h))});

export function sharedRoomWall(a,b){
 if(!a||!b)return null;
 const lowY=Math.max(a.y,b.y),highY=Math.min(a.y+a.h,b.y+b.h);
 if(highY-lowY>=OVERLAP-EPS){
  if(Math.abs(a.x+a.w-b.x)<EPS)return {axis:'x',coordinate:b.x,low:lowY,high:highY,wallA:'east',wallB:'west'};
  if(Math.abs(b.x+b.w-a.x)<EPS)return {axis:'x',coordinate:a.x,low:lowY,high:highY,wallA:'west',wallB:'east'};
 }
 const lowX=Math.max(a.x,b.x),highX=Math.min(a.x+a.w,b.x+b.w);
 if(highX-lowX>=OVERLAP-EPS){
  if(Math.abs(a.y+a.h-b.y)<EPS)return {axis:'y',coordinate:b.y,low:lowX,high:highX,wallA:'south',wallB:'north'};
  if(Math.abs(b.y+b.h-a.y)<EPS)return {axis:'y',coordinate:a.y,low:lowX,high:highX,wallA:'north',wallB:'south'};
 }
 return null;
}

export function placeConnectedRooms({rooms,edges,bounds,obstacles=[],previous=[],contacts=new Map(),maxSteps=30000}){
 const ordered=[...rooms].sort((a,b)=>a.id.localeCompare(b.id,'en'));
 const old=new Map(previous.map(r=>[r.id,r])),placed=new Map(),adj=new Map(ordered.map(r=>[r.id,new Set()]));
 for(const e of edges){adj.get(e.from)?.add(e.to);adj.get(e.to)?.add(e.from);}
 const fixed=ordered.filter(r=>r.locked||old.get(r.id)?.quality==='confirmed');
 for(const r of fixed){
  const p=r.locked?{...r,...r.locked}:old.get(r.id);
  if(p.w!==r.w||p.h!==r.h||!inside(p,bounds)||contacts.has(r.id)&&!sharedRoomWall(p,contacts.get(r.id))||obstacles.some(o=>overlaps(o,p))||[...placed.values()].some(o=>overlaps(o,p)))return {ok:false,code:'LOCK_CONFLICT'};
  placed.set(r.id,{...r,x:p.x,y:p.y,quality:'confirmed'});
 }
 const relative=!fixed.length&&!obstacles.length;
 let steps=0,exhausted=false;
 const valid=p=>{
  if(++steps>maxSteps){exhausted=true;return false;}
  if(contacts.has(p.id)&&!sharedRoomWall(p,contacts.get(p.id)))return false;
  if(!relative&&!inside(p,bounds)||obstacles.some(o=>overlaps(p,o)))return false;
  for(const q of placed.values())if(overlaps(p,q)||adj.get(p.id).has(q.id)&&!sharedRoomWall(p,q))return false;
  if(relative){const e=extent([...placed.values(),p]);if(e.right-e.x>bounds.w+EPS||e.bottom-e.y>bounds.h+EPS)return false;}
  return true;
 };
 for(const p of placed.values())for(const id of adj.get(p.id))if(placed.has(id)&&!sharedRoomWall(p,placed.get(id)))return {ok:false,code:'LOCK_CONFLICT'};
 if(ordered.some(r=>r.w>bounds.w+EPS||r.h>bounds.h+EPS)||ordered.reduce((n,r)=>n+r.w*r.h,0)>bounds.w*bounds.h+EPS)return {ok:false,code:'ROOM_CONNECTION_NO_SPACE'};
 const values=(low,high,seeds)=>{
  const out=[...seeds,low,high,(low+high)/2];
  // Exact alignments cover narrow residual gaps; quarter-metre samples add alternatives.
  for(let v=Math.ceil(low*4)/4;v<=high+EPS&&out.length<160;v+=.25)out.push(v);
  return [...new Set(out.filter(v=>v>=low-EPS&&v<=high+EPS).map(v=>Math.round(v*1e7)/1e7))];
 };
 function candidates(r){
  const neighbors=[...adj.get(r.id)].map(id=>placed.get(id)).filter(Boolean),out=[];
  if(!neighbors.length){
   if(relative)return [{...r,x:0,y:0}];
   const xs=[bounds.x,bounds.x+bounds.w-r.w,(bounds.w-r.w)/2+bounds.x],ys=[bounds.y,bounds.y+bounds.h-r.h,(bounds.h-r.h)/2+bounds.y];
   const p=old.get(r.id);if(p){xs.unshift(p.x);ys.unshift(p.y);}
   for(const o of obstacles){xs.push(o.x-r.w,o.x+o.w);ys.push(o.y-r.h,o.y+o.h);}
   for(const y of ys)for(const x of xs)out.push({...r,x,y});
  }else{
   const ys=[...placed.values()].flatMap(p=>[p.y,p.y+p.h-r.h]),xs=[...placed.values()].flatMap(p=>[p.x,p.x+p.w-r.w]);
   for(const p of neighbors){
    for(const y of values(p.y+OVERLAP-r.h,p.y+p.h-OVERLAP,[p.y,p.y+p.h-r.h,...ys]))for(const x of [p.x+p.w,p.x-r.w])out.push({...r,x,y});
    for(const x of values(p.x+OVERLAP-r.w,p.x+p.w-OVERLAP,[p.x,p.x+p.w-r.w,...xs]))for(const y of [p.y+p.h,p.y-r.h])out.push({...r,x,y});
   }
  }
  const seen=new Set();
  return out.filter(p=>{const key=p.x+':'+p.y;if(seen.has(key))return false;seen.add(key);return valid(p);}).sort((a,b)=>{
   const score=p=>{const e=extent([...placed.values(),p]);return (e.right-e.x)*(e.bottom-e.y);};
   return score(a)-score(b)||a.y-b.y||a.x-b.x;
  });
 }
 function search(){
  if(placed.size===ordered.length)return true;
  if(++steps>maxSteps){exhausted=true;return false;}
  const pending=ordered.filter(r=>!placed.has(r.id)).sort((a,b)=>{
   const n=r=>[...adj.get(r.id)].filter(id=>placed.has(id)).length;
   return n(b)-n(a)||adj.get(b.id).size-adj.get(a.id).size||b.w*b.h-a.w*a.h||a.id.localeCompare(b.id,'en');
  });
  const r=pending[0];
  for(const p of candidates(r)){
   placed.set(r.id,p);if(search())return true;placed.delete(r.id);if(exhausted)return false;
  }
  return false;
 }
 if(!search())return {ok:false,code:exhausted?'ROOM_TOPOLOGY_SEARCH_LIMIT':'ROOM_CONNECTION_NO_SPACE'};
 let result=ordered.map(r=>placed.get(r.id));
 if(relative){const e=extent(result),p=old.get(result[0].id),dx=Math.max(bounds.x-e.x,Math.min(bounds.x+bounds.w-e.right,p?p.x-result[0].x:bounds.x-e.x)),dy=Math.max(bounds.y-e.y,Math.min(bounds.y+bounds.h-e.bottom,p?p.y-result[0].y:bounds.y-e.y));result=result.map(r=>({...r,x:r.x+dx,y:r.y+dy}));}
 return {ok:true,rooms:result};
}
