// Pure geometry. No fixture, DOM, storage or model calls.


  const clone = value => JSON.parse(JSON.stringify(value));
  const finitePositive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
  const intersects = (a, b) => a.x < b.x + b.w - 1e-8 && a.x + a.w > b.x + 1e-8 && a.y < b.y + b.h - 1e-8 && a.y + a.h > b.y + 1e-8;
  const contains = (a, b) => b.x >= a.x - 1e-8 && b.y >= a.y - 1e-8 && b.x + b.w <= a.x + a.w + 1e-8 && b.y + b.h <= a.y + a.h + 1e-8;
  const pointInside = (r, p) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  const polygon = r => [[r.x,r.y],[r.x+r.w,r.y],[r.x+r.w,r.y+r.h],[r.x,r.y+r.h]];
  const issue = (id, code) => ({ id, code });
  const ordered = values => [...values].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  function validIds(values) { return Array.isArray(values) && values.every(v => v && typeof v.id === 'string' && v.id.length) && new Set(values.map(v=>v.id)).size === values.length; }
  function floor(spec, previous = null) {
    const problems = [];
    const bounds = { x:0, y:0, w:spec.width, h:spec.height };
    if (!finitePositive(spec.width) || !finitePositive(spec.height) || !finitePositive(spec.corridorWidth) || spec.corridorWidth >= spec.height || !validIds(spec.rooms) || spec.rooms.some(r => !finitePositive(r.w) || !finitePositive(r.h) || !['north','south'].includes(r.side))) {
      return {ok:false,issues:[issue(spec.id,'INPUT_INVALID')],kept:previous?clone(previous):null};
    }
    const corridor = { id:'corridor', x:0, y:(bounds.h-spec.corridorWidth)/2, w:bounds.w, h:spec.corridorWidth };
    const placed = [], old = new Map((previous?.rooms || []).map(r=>[r.id,r]));
    const candidate = r => ({...r, y:r.side==='north'?corridor.y-r.h:corridor.y+corridor.h});
    const admissible = r => contains({x:0.5,y:0.5,w:bounds.w-1,h:bounds.h-1},r) && !intersects(r,corridor) && !placed.some(p=>intersects(r,p)) && Math.abs((r.side==='north'?r.y+r.h:r.y)-(r.side==='north'?corridor.y:corridor.y+corridor.h)) < 1e-8;
    const save = (r, x, y, quality) => {
      const rect={id:r.id,name:r.name,side:r.side,x,y,w:r.w,h:r.h,quality};
      placed.push({...rect,mapId:spec.id,parentId:spec.parentId,polygon:polygon(rect)});
    };
    const specs=ordered(spec.rooms);
    if(spec.singleRoom&&specs.length===1){
      const r=specs[0],x=r.locked?.x??(bounds.w-r.w)/2,y=r.locked?.y??(bounds.h-r.h)/2;
      if(!contains({x:.5,y:.5,w:bounds.w-1,h:bounds.h-1},{x,y,w:r.w,h:r.h}))return {ok:false,issues:[issue(r.id,'ROOM_NO_SPACE')]};
      save(r,x,y,r.locked?'confirmed':'layout');corridor.x=0;corridor.y=y+r.h;corridor.w=0;corridor.h=0;
    }
    // Confirmed/manual geometry is reserved first. A contradiction is reported, never moved silently.
    for(const r of specs.filter(r=>r.locked&&!placed.some(p=>p.id===r.id))){
      const rect={...r,...r.locked};
      if(!Number.isFinite(rect.x)||!Number.isFinite(rect.y)||!admissible(rect)) problems.push(issue(r.id,'LOCK_CONFLICT'));
      else save(r,rect.x,rect.y,'confirmed');
    }
    if(problems.length) return {ok:false,issues:problems,kept:previous?clone(previous):null};
    // Preserve unchanged geometry from the saved layout before placing new rooms.
    for(const r of specs.filter(r=>!r.locked&&!placed.some(p=>p.id===r.id))){
      const p=old.get(r.id);
      if(p && p.side===r.side && p.w===r.w && p.h===r.h && admissible(p)) save(r,p.x,p.y,p.quality);
    }
    for(const r of specs.filter(r=>!placed.some(p=>p.id===r.id))){
      let found=null;
      for(let x=0.5;x+r.w<=bounds.w-0.5+1e-8;x+=0.5){const rect=candidate({...r,x});if(admissible(rect)){found=rect;break;}}
      if(found) save(r,found.x,found.y,'layout'); else problems.push(issue(r.id,'ROOM_NO_SPACE'));
    }
    if(problems.length) return {ok:false,issues:problems,kept:previous?clone(previous):null};
    const rooms=ordered(placed), doors=rooms.map(r=>({id:'door:'+r.id,roomId:r.id,x:r.x+r.w/2,y:r.side==='north'?r.y+r.h:r.y,width:Math.min(1.2,r.w-0.2)}));
    const furniture=[], pins=[];
    const oldFurniture=new Map((previous?.furniture||[]).map(f=>[f.id,f]));
    for(const r of rooms){
      // Keep a continuous 1.2m spine from the doorway through each room.
      const spine={x:r.x+r.w/2-0.6,y:r.y,w:1.2,h:r.h};
      const inner={x:r.x+0.35,y:r.y+0.35,w:r.w-0.7,h:r.h-0.7};
      const content=ordered(spec.furniture?.filter(f=>f.roomId===r.id)||[]);
      for(const f of content){
        if(!finitePositive(f.w)||!finitePositive(f.h)){problems.push(issue(f.id,'FURNITURE_INVALID'));continue;}
        const reservedActors=(spec.actors||[]).filter(a=>a.roomId===r.id&&a.position&&pointInside(r,a.position)).map(a=>({x:a.position.x-0.25,y:a.position.y-0.25,w:0.5,h:0.5}));
        const free=q=>contains(inner,q)&&!intersects(q,spine)&&!reservedActors.some(p=>intersects(q,p))&&!furniture.some(p=>p.roomId===r.id&&intersects(q,p));
        const prev=oldFurniture.get(f.id);
        let q=prev&&prev.roomId===r.id&&prev.w===f.w&&prev.h===f.h&&free(prev)?prev:null;
        for(let y=inner.y;!q&&y+f.h<=inner.y+inner.h+1e-8;y+=0.5){for(let x=inner.x;x+f.w<=inner.x+inner.w+1e-8;x+=0.5){const test={x,y,w:f.w,h:f.h};if(free(test)){q=test;break;}}}
        if(q) furniture.push({...q,id:f.id,roomId:r.id,name:f.name,type:f.type||'table',quality:'layout'});
        else problems.push(issue(f.id,'FURNITURE_NO_SPACE'));
      }
      for(const a of ordered(spec.actors?.filter(a=>a.roomId===r.id)||[])){
        if(a.position){
          if(!Number.isFinite(a.position.x)||!Number.isFinite(a.position.y)||!pointInside(r,a.position)) problems.push(issue(a.id,'ACTOR_POSITION_INVALID'));
          else pins.push({...a.position,id:a.id,name:a.name,roomId:r.id,mapId:spec.id,quality:'confirmed'});
          continue;
        }
        const oldPin=previous?.pins?.find(p=>p.id===a.id&&p.roomId===r.id);
        const free=p=>contains(inner,{x:p.x-0.25,y:p.y-0.25,w:0.5,h:0.5})&&!intersects({x:p.x-0.25,y:p.y-0.25,w:0.5,h:0.5},spine)&&!furniture.some(f=>f.roomId===r.id&&intersects(f,{x:p.x-0.25,y:p.y-0.25,w:0.5,h:0.5}))&&!pins.some(q=>Math.hypot(q.x-p.x,q.y-p.y)<0.7);
        let p=oldPin&&free(oldPin)?oldPin:null;
        for(let y=inner.y+0.25;!p&&y<=inner.y+inner.h-0.25+1e-8;y+=0.75){for(let x=inner.x+0.25;x<=inner.x+inner.w-0.25+1e-8;x+=0.75){if(free({x,y})){p={x,y};break;}}}
        if(p) pins.push({id:a.id,name:a.name,roomId:r.id,mapId:spec.id,x:p.x,y:p.y,quality:'layout'});
        else problems.push(issue(a.id,'ACTOR_LAYOUT_NO_SPACE'));
      }
    }
    for(const v of [...(spec.furniture||[]),...(spec.actors||[])]) if(!rooms.some(r=>r.id===v.roomId)) problems.push(issue(v.id,'ROOM_REF_UNKNOWN'));
    return {ok:true,id:spec.id,name:spec.name,kind:'floor',bounds,corridor,rooms,doors,furniture,pins,edges:doors.map(d=>({from:d.roomId,to:'corridor',via:d.id})),issues:problems};
  }
  function city(spec){
    const cells={nw:[0,0],north:[1,0],ne:[2,0],west:[0,1],center:[1,1],east:[2,1],sw:[0,2],south:[1,2],se:[2,2]};
    if(!finitePositive(spec.width)||!finitePositive(spec.height)||!validIds(spec.districts)||spec.districts.some(d=>!cells[d.direction])) return {ok:false,issues:[issue(spec.id,'INPUT_INVALID')]};
    const districts=[],issues=[],margin=Math.min(spec.width,spec.height)*0.04,gap=margin/2;
    const cw=(spec.width-2*margin-2*gap)/3,ch=(spec.height-2*margin-2*gap)/3;
    for(const [direction,slot] of Object.entries(cells)){
      const group=ordered(spec.districts.filter(d=>d.direction===direction));
      group.forEach((d,i)=>{
        const rect={x:margin+slot[0]*(cw+gap),y:margin+slot[1]*(ch+gap)+i*ch/group.length,w:cw,h:ch/group.length-gap/2};
        districts.push({...d,...rect,mapId:spec.id,parentId:spec.parentId,quality:'layout',polygon:polygon(rect),center:{x:rect.x+rect.w/2,y:rect.y+rect.h/2}});
      });
    }
    return {ok:true,id:spec.id,name:spec.name,kind:'city',bounds:{x:0,y:0,w:spec.width,h:spec.height},districts:ordered(districts),issues};
  }
  function camera(scene,width,height,zoom=1,offset={x:0,y:0}){
    const base=Math.max(1e-6,Math.min(Math.max(1,width-48)/scene.bounds.w,Math.max(1,height-48)/scene.bounds.h)),s=base*zoom;
    return {s,x:(width-scene.bounds.w*s)/2-scene.bounds.x*s+offset.x,y:(height-scene.bounds.h*s)/2-scene.bounds.y*s+offset.y};
  }
  const screen=(p,c)=>({x:p.x*c.s+c.x,y:p.y*c.s+c.y});
  const world=(p,c)=>({x:(p.x-c.x)/c.s,y:(p.y-c.y)/c.s});
  function hit(scene,p){return scene.kind==='floor'?scene.rooms.find(r=>pointInside(r,p))||null:scene.districts.find(r=>pointInside(r,p))||null;}

export {floor,city,contains,intersects,pointInside,polygon,camera,screen,world,hit,clone};
