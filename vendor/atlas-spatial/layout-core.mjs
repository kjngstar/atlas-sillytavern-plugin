import * as B from './foundation.mjs';


  const clone=B.clone, EPS=1e-7;
  const pt=(x,y)=>({x,y}), center=r=>pt(r.x+r.w/2,r.y+r.h/2);
  const inflate=(r,d)=>({x:r.x-d,y:r.y-d,w:r.w+2*d,h:r.h+2*d});
  const corners=r=>[pt(r.x,r.y),pt(r.x+r.w,r.y),pt(r.x+r.w,r.y+r.h),pt(r.x,r.y+r.h)];
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  const segmentDistance=(p,a,b)=>{const dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));return distance(p,pt(a.x+t*dx,a.y+t*dy));};
  function polygonContains(poly,p){
    if(poly.some((a,i)=>segmentDistance(p,a,poly[(i+1)%poly.length])<EPS))return true;
    let inside=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){
      const a=poly[i],b=poly[j];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
    }return inside;
  }
  function clip(poly,nx,ny,k){
    const out=[];for(let i=0;i<poly.length;i++){
      const a=poly[i],b=poly[(i+1)%poly.length],fa=a.x*nx+a.y*ny-k,fb=b.x*nx+b.y*ny-k;
      if(fa<=EPS)out.push(a);if((fa<0&&fb>0)||(fa>0&&fb<0)){const t=fa/(fa-fb);out.push(pt(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t));}
    }return out;
  }
  function hull(points){
    const sorted=[...points].sort((a,b)=>a.x-b.x||a.y-b.y),cross=(o,a,b)=>(a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x),lower=[],upper=[];
    for(const p of sorted){while(lower.length>=2&&cross(lower.at(-2),lower.at(-1),p)<=0)lower.pop();lower.push(p);}
    for(const p of [...sorted].reverse()){while(upper.length>=2&&cross(upper.at(-2),upper.at(-1),p)<=0)upper.pop();upper.push(p);}
    lower.pop();upper.pop();return lower.concat(upper);
  }
  const hash=s=>{let n=2166136261;for(const c of String(s)){n^=c.charCodeAt(0);n=Math.imul(n,16777619);}return n>>>0;};
  const rand=s=>{let n=hash(s);return()=>{n=(Math.imul(n,1664525)+1013904223)>>>0;return n/4294967296;};};
  const ordered=a=>[...a].sort((a,b)=>a.id.localeCompare(b.id,'en'));
  // 02 §6.4：solid 类型参与碰撞，light/decor/doorway/stairs 不挡路；marker 与家具渲染形状分开。
  const SOLID_TYPES=new Set(['shelf','desk','bench','reading','table','chair','bed','cabinet']);
  function makeGroup(f,r,x,y){
    const group={id:f.id,name:f.name,type:f.type,roomId:r.id,x,y,w:f.w,h:f.h,quality:'layout'},bodies=[];
    const add=(type,bx,by,bw,bh)=>bodies.push({id:f.id+':'+type+(bodies.length?':'+bodies.length:''),type,x:bx,y:by,w:bw,h:bh});
    if(f.type==='reading'){
      add('table',x+.55,y+.55,f.w-1.1,f.h-1.1);
      for(const [dx,dy]of [[.1,.72],[f.w-.45,.72],[.1,f.h-1.07],[f.w-.45,f.h-1.07]])add('chair',x+dx,y+dy,.35,.35);
    }else if(f.type==='table'){
      add('table',x,y,f.w,f.h);
      if(f.w>1.2&&f.h>1.2)for(const [dx,dy]of [[.12,.12],[f.w-.47,.12],[.12,f.h-.47],[f.w-.47,f.h-.47]])add('chair',x+dx,y+dy,.35,.35);
    }else if(f.type==='desk'){
      add('desk',x,y,f.w,f.h*.68);
      if(f.w>1.1&&f.h>.8)add('chair',x+f.w-.4,y+f.h-.38,.35,.35);
    }else if(f.type==='bed'){
      add('bed',x,y,f.w,f.h);
      if(f.w>.9&&f.h>.9)add('pillow',x+.1,y+.1,Math.max(.2,f.w-.2),.25);
    }else if(f.type==='cabinet'||f.type==='shelf'||f.type==='bench'||f.type==='chair'||f.type==='stairs'){
      add(f.type,x,y,f.w,f.h);
    }else if(f.type==='doorway'){
      // 门洞是通行结构不是障碍：绘制但永不参与碰撞。
      add('doorway',x,y,f.w,f.h);
    }else if(f.type==='light'){
      add('light',x,y,f.w,f.h);
    }else{
      add('decor',x,y,f.w,f.h);
    }
    return {...group,bodies:bodies.map(b=>({...b,groupId:f.id,roomId:r.id,solid:SOLID_TYPES.has(b.type)}))};
  }
  // Four-neighbour flood fill. A human-size disk is conservatively approximated by an inflated box.
  function navigation(room,door,bodies,step=.2,radius=.18){
    const nx=Math.ceil(room.w/step),ny=Math.ceil(room.h/step),blocked=bodies.filter(b=>b.solid!==false).map(b=>inflate(b,radius));
    const positions=[],free=[];
    for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
      const p=pt(room.x+(i+.5)*step,room.y+(j+.5)*step);positions.push(p);
      free.push(p.x<=room.x+room.w-radius&&p.x>=room.x+radius&&p.y<=room.y+room.h-radius&&p.y>=room.y+radius&&!blocked.some(b=>B.pointInside(b,p)));
    }
    const nearest=p=>{let best=-1,d=Infinity;for(let i=0;i<positions.length;i++)if(free[i]&&distance(p,positions[i])<d){best=i;d=distance(p,positions[i]);}return best;};
    const start=nearest(pt(door.x,door.y+(room.side==='north'?-.45:.45))),parent=Array(positions.length).fill(-2),queue=[];
    if(start>=0){parent[start]=-1;queue.push(start);}
    for(let q=0;q<queue.length;q++){const n=queue[q],x=n%nx,y=Math.floor(n/nx);for(const [dx,dy]of [[-1,0],[1,0],[0,-1],[0,1]]){
      const xx=x+dx,yy=y+dy,m=yy*nx+xx;if(xx>=0&&xx<nx&&yy>=0&&yy<ny&&free[m]&&parent[m]===-2){parent[m]=n;queue.push(m);}
    }}
    return {positions,free,parent,nearest,reachable:p=>{const n=nearest(p);return n>=0&&distance(positions[n],p)<step*1.5&&parent[n]!==-2;},path:p=>{let n=nearest(p);if(n<0||parent[n]===-2)return null;const line=[];while(n>=0){line.push(positions[n]);n=parent[n];}return line.reverse();}};
  }
  function floor(spec,previous=null){
    const collections=['contents','actors','items'];
    if(collections.some(k=>spec[k]!==undefined&&(!Array.isArray(spec[k])||spec[k].some(v=>!v||typeof v.id!=='string'||!v.id)||new Set(spec[k].map(v=>v.id)).size!==spec[k].length)))return {ok:false,issues:[{id:spec.id,code:'DETAIL_INPUT_INVALID'}],kept:previous?clone(previous):null};
    const bare=B.floor({...spec,furniture:[],actors:[]},previous);if(!bare.ok)return bare;
    const groups=[],bodies=[],actors=[],items=[],windows=[],lamps=[],issues=[],doorSwings=[];
    for(const r of bare.rooms){
      const door=bare.doors.find(d=>d.roomId===r.id),aisle=spec.singleRoom?.8:1.6,margin=spec.singleRoom?.2:.4;
      const spine={x:door.x-aisle/2,y:r.y,w:aisle,h:r.h},inner={x:r.x+margin,y:r.y+(spec.singleRoom?margin:1),w:r.w-margin*2,h:r.h-(spec.singleRoom?margin*2:1.4)};
      const swing={id:'swing:'+r.id,roomId:r.id,x:door.x-door.width/2,y:r.side==='north'?door.y-door.width:door.y,w:door.width,h:door.width};doorSwings.push(swing);
      const exact=(spec.actors||[]).filter(a=>a.roomId===r.id&&a.position).map(a=>({id:a.id,...a.position}));
      const priority=f=>f.locked?2:previous?.groups?.some(g=>g.id===f.id)?1:0;
      for(const f of ordered((spec.contents||[]).filter(f=>f.roomId===r.id)).sort((a,b)=>priority(b)-priority(a))){
        if(!Number.isFinite(f.w)||!Number.isFinite(f.h)||f.w<=0||f.h<=0||f.type==='reading'&&(f.w<2||f.h<2)){issues.push({id:f.id,code:'DETAIL_DIMENSION_INVALID'});continue;}
        // 陈设塞不进房间：明确到 ID，绝不能偷偷放大到穿墙。
        if(f.type!=='light'&&f.type!=='decor'&&(f.w>inner.w+EPS||f.h>inner.h+EPS)&&!f.locked){issues.push({id:f.id,code:'DETAIL_TOO_LARGE'});continue;}
        const free=q=>B.contains(inner,q)&&!B.intersects(q,spine)&&!B.intersects(q,swing)&&!groups.filter(g=>g.roomId===r.id).some(g=>B.intersects(inflate(g,.28),q))&&!exact.some(p=>B.intersects(q,{x:p.x-.25,y:p.y-.25,w:.5,h:.5}));
        let chosen=null;
        const old=previous?.groups?.find(g=>g.id===f.id&&g.roomId===r.id&&g.w===f.w&&g.h===f.h);
        if(old&&free(old))chosen=old;
        if(f.locked){const q={...f,...f.locked};if(free(q))chosen=q;else{issues.push({id:f.id,code:'DETAIL_LOCK_CONFLICT'});continue;}}
        const candidates=[];
        if(!chosen)for(let y=inner.y;y+f.h<=inner.y+inner.h+EPS;y+=.25)for(let x=inner.x;x+f.w<=inner.x+inner.w+EPS;x+=.25){
          const q={x,y,w:f.w,h:f.h};if(free(q)){
            // Shelves face the outer wall; tables prefer the door-facing half. These are preferences, not coordinates.
            const score=f.type==='shelf'?Math.abs(y-(r.side==='north'?inner.y:inner.y+inner.h-f.h)):distance(center(q),pt(r.x+r.w*.25,door.y+(r.side==='north'?-2.2:2.2)));
            candidates.push({q,score});
          }
        }
        if(!chosen)chosen=candidates.sort((a,b)=>a.score-b.score||a.q.y-b.q.y||a.q.x-b.q.x)[0]?.q;
        // In a narrow carriage a bench or cabinet can fit along the other axis.
        // Preserve the original orientation whenever it fits; locked furniture stays fixed.
        if(!chosen&&!f.locked&&f.w!==f.h){
          for(let y=inner.y;y+f.w<=inner.y+inner.h+EPS&&!chosen;y+=.25)for(let x=inner.x;x+f.h<=inner.x+inner.w+EPS;x+=.25){
            const q={x,y,w:f.h,h:f.w};if(free(q)){chosen=q;break;}
          }
        }
        if(!chosen){issues.push({id:f.id,code:'DETAIL_NO_SPACE'});continue;}
        const g=makeGroup({...f,w:chosen.w,h:chosen.h},r,chosen.x,chosen.y);if(f.locked)g.quality='confirmed';groups.push(g);bodies.push(...g.bodies);
      }
      const outerY=r.side==='north'?r.y:r.y+r.h;
      for(let i=0;i<Math.max(1,Math.floor(r.w/3));i++)windows.push({id:'window:'+r.id+':'+i,type:'window',roomId:r.id,x:r.x+(i+.5)*r.w/Math.max(1,Math.floor(r.w/3)),y:outerY,width:1.2,elevation:1.1});
      lamps.push({id:'light:'+r.id,type:'light',roomId:r.id,x:door.x,y:r.y+r.h*.45,elevation:2.8});
      const nav=navigation(r,door,bodies.filter(b=>b.roomId===r.id));
      for(const g of groups.filter(g=>g.roomId===r.id)){
        const edgePoints=[pt(g.x+g.w+.48,g.y+g.h/2),pt(g.x-.48,g.y+g.h/2),pt(g.x+g.w/2,g.y+g.h+.48),pt(g.x+g.w/2,g.y-.48)];
        g.interaction=edgePoints.find(p=>B.pointInside(inner,p)&&nav.reachable(p))||null;
        if(!g.interaction)issues.push({id:g.id,code:'DETAIL_NOT_REACHABLE'});
      }
      for(const a of ordered((spec.actors||[]).filter(a=>a.roomId===r.id))){
        const target=groups.find(g=>g.id===a.near),old=previous?.actors?.find(p=>p.id===a.id&&p.roomId===a.roomId&&p.near===a.near),p=a.position||old||(target?.interaction||null);
        const candidates=nav.positions.filter((p,i)=>nav.parent[i]!==-2&&(!target||distance(p,center(target))<4)).sort((p,q)=>distance(p,target?center(target):center(r))-distance(q,target?center(target):center(r)));
        const free=p=>p&&nav.reachable(p)&&!actors.some(q=>distance(p,q)<.7)&&!bodies.filter(b=>b.roomId===r.id&&b.solid).some(b=>B.intersects(b,{x:p.x-.18,y:p.y-.18,w:.36,h:.36}));
        const point=free(p)?p:!a.position?candidates.find(free):null;
        if(point)actors.push({...a,...point,mapId:spec.id,type:'person',quality:a.position?'confirmed':'layout'});else issues.push({id:a.id,code:a.position?'ACTOR_LOCK_CONFLICT':'ACTOR_NO_REACHABLE_POSITION'});
      }
    }
    for(const i of spec.items||[]){
      const g=groups.find(g=>g.id===i.on),b=g?.bodies.find(b=>['table','desk','shelf','cabinet'].includes(b.type));
      if(b)items.push({...i,...center(b),roomId:g.roomId,type:'item',containerId:g.id,elevation:.8,quality:'layout'});else issues.push({id:i.id,code:'ITEM_CONTAINER_NOT_FOUND'});
    }
    if(bare.corridor.h>0)for(let x=1.5;x<spec.width;x+=3)lamps.push({id:'hall-light:'+x,type:'light',roomId:'corridor',x,y:bare.corridor.y+.22,elevation:2.8});
    for(const v of [...(spec.contents||[]),...(spec.actors||[])])if(!bare.rooms.some(r=>r.id===v.roomId))issues.push({id:v.id,code:'ROOM_REF_UNKNOWN'});
    let path=[];if(actors.length>=2){
      const [a,b]=actors,[ra,rb]=[a,b].map(a=>bare.rooms.find(r=>r.id===a.roomId)),[da,db]=[ra,rb].map(r=>bare.doors.find(d=>d.roomId===r.id));
      const pa=navigation(ra,da,bodies.filter(x=>x.roomId===ra.id)).path(a),pb=navigation(rb,db,bodies.filter(x=>x.roomId===rb.id)).path(b),cy=bare.corridor.y+bare.corridor.h/2;
      if(pa&&pb)path=[...pa.reverse(),pt(da.x,da.y),pt(da.x,cy),pt(db.x,cy),pt(db.x,db.y),...pb];
    }
    return {...bare,groups,bodies,actors,items,windows,lamps,doorSwings,path,issues};
  }
  const riverX=(river,y)=>river.cx+river.amplitude*Math.sin((y/river.height*2-.35)*Math.PI);
  const water=(river,p)=>Math.abs(p.x-riverX(river,p.y))<river.width/2-EPS;
  function splitWater(a,b,river){
    const point=t=>pt(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t),cuts=[0,1];
    for(const sign of [-1,1]){
      const f=t=>{const p=point(t);return p.x-riverX(river,p.y)-sign*river.width/2;};
      for(let i=0;i<160;i++){let lo=i/160,hi=(i+1)/160,fl=f(lo),fh=f(hi);if(Math.abs(fl)<EPS)cuts.push(lo);if(fl*fh<0){for(let n=0;n<32;n++){const mid=(lo+hi)/2;if(f(lo)*f(mid)<=0)hi=mid;else lo=mid;}cuts.push((lo+hi)/2);}}
    }
    const sorted=cuts.sort((a,b)=>a-b).filter((t,i,a)=>i===0||t-a[i-1]>1e-6),out=[];
    for(let i=1;i<sorted.length;i++){const t0=sorted[i-1],t1=sorted[i];if(t1-t0>1e-6)out.push({a:point(t0),b:point(t1),kind:water(river,point((t0+t1)/2))?'bridge':'road'});}return out;
  }
  function city(spec,previous=null){
    if(!Number.isFinite(spec.width)||!Number.isFinite(spec.height)||spec.width<900||spec.height<700||!Number.isFinite(spec.riverWidth)||spec.riverWidth<0||spec.riverWidth>spec.width*.15||!Array.isArray(spec.districts)||!spec.districts.length||new Set(spec.districts.map(d=>d.id)).size!==spec.districts.length||spec.districts.some(d=>!['west','east'].includes(d.bank)||!Number.isFinite(d.order)))return {ok:false,issues:[{id:spec.id,code:'CITY_INPUT_INVALID'}]};
    const structure = v => JSON.stringify({width:v.width,height:v.height,riverWidth:v.riverWidth,seed:v.seed,districts:ordered(v.districts||[]).map(d=>[d.id,d.bank,d.order])});
    if(previous?.structureKey && previous.structureKey!==structure(spec))return {ok:false,issues:[{id:spec.id,code:'CITY_STRUCTURE_CHANGE_REQUIRES_REBUILD'}],kept:clone(previous)};
    const w=spec.width,h=spec.height,rng=rand(spec.seed||spec.id),origin=pt(w*.46,h*.5),raw=[];
    for(let i=0;i<14;i++){const a=i*Math.PI/7,rr=.95+rng()*.05;raw.push(pt(origin.x+Math.cos(a)*w*.405*rr,origin.y+Math.sin(a)*h*.405*rr));}
    // G07：open 城市不生成假城墙/城门/墙附属环路；旧档（无 enclosure）继续走 hull 老路径。
    const open=spec.enclosure==='open',hullOutline=hull(raw),land0=open?[pt(0,0),pt(w,0),pt(w,h),pt(0,h)]:hullOutline;
    const wall=open?[]:hullOutline,river={cx:w*.62,amplitude:w*.035,width:spec.riverWidth,height:h},bankGap=river.width/2+18;
    const wet=river.width>0;
    const left=wet?clip(land0,1,0,river.cx-river.amplitude-bankGap):clip(land0,1,0,w*.55),right=wet?clip(land0,-1,0,-(river.cx+river.amplitude+bankGap)):clip(land0,-1,0,-w*.55),districts=[];
    for(const bank of ['west','east']){
      const group=ordered(spec.districts.filter(d=>d.bank===bank)).sort((a,b)=>a.order-b.order),land=!wet&&group.length===spec.districts.length?land0:bank==='west'?left:right;
      const ys=land.map(p=>p.y),minY=Math.min(...ys),maxY=Math.max(...ys),xs=land.map(p=>p.x),cx=(Math.min(...xs)+Math.max(...xs))/2;
      const seeds=group.map((d,i)=>({...d,site:pt(cx+(i%2?1:-1)*w*.025,minY+(maxY-minY)*(i+.5)/group.length)}));
      for(const d of seeds){let poly=land;for(const other of seeds)if(other.id!==d.id){const a=d.site,b=other.site;poly=clip(poly,2*(b.x-a.x),2*(b.y-a.y),b.x*b.x+b.y*b.y-a.x*a.x-a.y*a.y);}
        if(poly.length<3||!polygonContains(poly,d.site))return {ok:false,issues:[{id:d.id,code:'DISTRICT_SEED_OUTSIDE'}]};
        districts.push({...d,mapId:spec.id,parentId:spec.parentId,polygon:poly,quality:'layout'});
      }
    }
    const centerY=h*.5;
    const horizontalIntersections=wall.map((a,i)=>{const b=wall[(i+1)%wall.length];if((a.y-centerY)*(b.y-centerY)<=0&&a.y!==b.y)return a.x+(b.x-a.x)*(centerY-a.y)/(b.y-a.y);return null;}).filter(x=>x!==null).sort((a,b)=>a-b);
    const gates=open?[]:[{id:'gate-west',name:'西城门',x:horizontalIntersections[0],y:centerY},{id:'gate-east',name:'东城门',x:horizontalIntersections.at(-1),y:centerY}];
    const hubs=[pt(w*.31,centerY),pt(w*.77,centerY)],roads=[],segments=[],buildings=[],issues=[];
    const addRoad=(id,a,b)=>{const road={id,a,b,width:12};roads.push(road);segments.push(...(wet?splitWater(a,b,river):[{a,b,kind:'road'}]).map((s,i)=>({...s,id:id+':'+i,roadId:id,width:12})));};
    // 主轴：有墙时连两座城门；开放城市不依赖不存在的 gate.x，直接连两个功能枢纽。
    addRoad('avenue',open?hubs[0]:pt(gates[0].x,centerY),open?hubs[1]:pt(gates[1].x,centerY));
    for(const d of districts)addRoad('road:'+d.id,hubs[d.bank==='west'?0:1],d.site);
    if(!open){
      // The inner ring is a connected road. Its river crossings become bridges by the same rule.
      const ring=wall.map(p=>pt(origin.x+(p.x-origin.x)*.86,origin.y+(p.y-origin.y)*.86));
      for(let i=0;i<ring.length;i++)addRoad('ring:'+i,ring[i],ring[(i+1)%ring.length]);
      addRoad('ring-access-west',hubs[0],ring.reduce((a,b)=>distance(a,hubs[0])<distance(b,hubs[0])?a:b));
      addRoad('ring-access-east',hubs[1],ring.reduce((a,b)=>distance(a,hubs[1])<distance(b,hubs[1])?a:b));
    }
    const roadClear=q=>!roads.some(r=>{const min=Math.min(...corners(q).map(p=>segmentDistance(p,r.a,r.b)),segmentDistance(center(q),r.a,r.b));return min<r.width/2+12||segmentIntersectsRect(r.a,r.b,inflate(q,12));});
    function placeBuilding(f,decorative=false){
      const d=districts.find(d=>d.id===f.districtId);if(!d||!Number.isFinite(f.w)||!Number.isFinite(f.h)||f.w<=0||f.h<=0)return null;
      const xs=d.polygon.map(p=>p.x),ys=d.polygon.map(p=>p.y),candidates=[],step=Math.max(decorative?22:10,Math.max(w,h)/240);
      for(let y=Math.min(...ys)+12;y+f.h<Math.max(...ys);y+=step)for(let x=Math.min(...xs)+12;x+f.w<Math.max(...xs);x+=step){const q={x,y,w:f.w,h:f.h};
        if(corners(inflate(q,6)).every(p=>polygonContains(d.polygon,p))&&roadClear(q)&&!buildings.some(b=>B.intersects(inflate(b,decorative?6:12),q))){
          const score=Math.min(...roads.map(r=>segmentDistance(center(q),r.a,r.b)))+distance(center(q),d.site)*.035+(decorative?rng()*30:0);candidates.push({q,score});
        }
      }
      const q=candidates.sort((a,b)=>a.score-b.score||a.q.y-b.q.y||a.q.x-b.q.x)[0]?.q;
      if(!q)return null;const b={...f,...q,type:decorative?'block':'building',decorative,quality:'layout',mapId:spec.id};buildings.push(b);return b;
    }
    const validBuilding=q=>{const d=districts.find(d=>d.id===q.districtId);return d&&corners(inflate(q,6)).every(p=>polygonContains(d.polygon,p))&&roadClear(q)&&!buildings.some(b=>B.intersects(inflate(b,12),q));};
    for(const f of ordered(spec.buildings||[]).filter(f=>f.locked)){
      const q={...f,...f.locked};if(validBuilding(q))buildings.push({...q,type:'building',decorative:false,quality:'confirmed',mapId:spec.id});else return {ok:false,issues:[{id:f.id,code:'BUILDING_LOCK_CONFLICT'}],kept:previous?clone(previous):null};
    }
    for(const f of ordered(spec.buildings||[]).filter(f=>!f.locked)){
      const old=previous?.buildings?.find(b=>!b.decorative&&b.id===f.id&&b.districtId===f.districtId&&b.w===f.w&&b.h===f.h);
      if(old&&validBuilding(old))buildings.push({...old,name:f.name});
      else if(old?.quality==='confirmed')return {ok:false,issues:[{id:f.id,code:'BUILDING_LOCK_CONFLICT'}],kept:clone(previous)};
    }
    for(const f of ordered(spec.buildings||[]).filter(f=>!buildings.some(b=>b.id===f.id)))if(!placeBuilding(f))issues.push({id:f.id,code:'BUILDING_NO_SPACE'});
    for(const d of districts)for(let i=0;i<(spec.blocksPerDistrict??8);i++)placeBuilding({id:'texture:'+d.id+':'+i,districtId:d.id,name:'街区轮廓',w:28+rng()*24,h:25+rng()*25},true);
    const rline=Array.from({length:81},(_,i)=>pt(riverX(river,h*i/80),h*i/80)),riverPolygon=rline.map(p=>pt(p.x-river.width/2,p.y)).concat([...rline].reverse().map(p=>pt(p.x+river.width/2,p.y)));
    const dock={id:'dock',name:'河岸码头',type:'dock',x:riverX(river,h*.68)-river.width/2,y:h*.68,bank:'west',width:river.width*.38};
    return {ok:true,structureKey:structure(spec),id:spec.id,name:spec.name,kind:'city',enclosure:open?'open':'wall',bounds:{x:0,y:0,w,h},wall,origin,river:wet?river:null,riverPolygon:wet?riverPolygon:[],districts,roads,segments,gates,buildings,dock:wet?dock:null,issues};
  }
  function segmentIntersectsRect(a,b,r){
    let lo=0,hi=1;const dx=b.x-a.x,dy=b.y-a.y;
    for(const [p,q]of [[-dx,a.x-r.x],[dx,r.x+r.w-a.x],[-dy,a.y-r.y],[dy,r.y+r.h-a.y]]){
      if(Math.abs(p)<EPS){if(q<0)return false;}else{const t=q/p;if(p<0)lo=Math.max(lo,t);else hi=Math.min(hi,t);if(lo>hi)return false;}
    }return true;
  }

const camera=B.camera,screen=B.screen,world=B.world,contains=B.contains,intersects=B.intersects;
export {floor,city,clone,center,corners,inflate,distance,segmentDistance,polygonContains,segmentIntersectsRect,navigation,riverX,water,splitWater,camera,screen,world,contains,intersects};
