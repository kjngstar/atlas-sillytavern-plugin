import * as E from './layout-core.mjs';
import {createPainter} from './renderer-drawing.mjs';
import {checkSceneDocument,clone,finite,LIMITS,diagnostic} from './contracts.mjs';
export const DEFAULT_THEME=Object.freeze({bg:'#060a12',grid:'#4977a125',wall:'#b2d4ef',mint:'#39e0a0',gold:'#ffc247',blue:'#7fd4ff',text:'#dce9fb',muted:'#91a9c3',floor:'#101d2f',cyan:'#43e0ff',violet:'#9b6bff'});
/** The component only draws passed state. It has no storage, model port or world clock. */
export function createSpatialRenderer({canvas,onSelect=()=>{},onHover=()=>{},onViewport=()=>{},onIssue=()=>{},theme={},scaleBarWidth=96,ownsGestures=true,painterFactory=createPainter,animate=false}={}){
  if(!canvas?.getContext)throw new Error('CANVAS_REQUIRED');
  const ctx=canvas.getContext('2d'),C={...DEFAULT_THEME,...theme};
  const state={kind:null,scene:null,document:null,zoom:1,offset:{x:0,y:0},cam:null,selected:null,hover:null,gridStep:null,overlays:[],labels:[],paused:false,destroyed:false,externalCamera:null};
  const width=()=>Math.max(1,canvas.clientWidth||canvas.width||1),height=()=>Math.max(1,canvas.clientHeight||canvas.height||1);
  const painter=painterFactory(canvas,state,C,width,height),cleanup=[];let frameId=0,drag=null,pinch=null,rafAnimation=0,background=null;
  function listen(target,type,fn,opts){target.addEventListener(type,fn,opts);cleanup.push(()=>target.removeEventListener(type,fn,opts));}
  function entities(){
    const s=state.scene;if(!s)return [];
    if(s.kind==='overview')return s.pins??[];
    if(s.kind==='floor')return [...s.actors,...s.items,...s.groups,...s.doors.map(d=>({...d,type:'door',name:'门'})),...s.windows,...s.lamps,...s.rooms.map(r=>({...r,type:'room'}))];
    return [...s.buildings.filter(b=>!b.decorative),...s.segments.filter(r=>r.kind==='bridge').map(r=>({...r,type:'bridge',name:'桥梁',x:(r.a.x+r.b.x)/2,y:(r.a.y+r.b.y)/2})),...s.gates.map(g=>({...g,type:'gate'})),s.dock,...s.districts.map(d=>({...d,type:'district',x:d.site.x,y:d.site.y}))].filter(Boolean);
  }
  function hit(q){
    const list=entities(),s=state.cam?.s??1,pointTypes=['person','item','door','window','light','gate','dock','bridge','location'];let nearest=null,d=Infinity;
    for(const e of list.filter(e=>pointTypes.includes(e.type))){const distance=E.distance(q,e)*s;if(distance<11&&distance<d){nearest=e;d=distance;}}
    if(nearest)return nearest;
    const body=list.find(e=>finite(e.w)&&finite(e.h)&&E.contains(e,{x:q.x,y:q.y,w:0,h:0}));if(body)return body;
    const poly=list.find(e=>e.polygon&&E.polygonContains(e.polygon.map(p=>Array.isArray(p)?{x:p[0],y:p[1]}:p),q));if(poly)return poly;
    for(const flow of state.overlays)for(let i=1;i<flow.path.length;i++)if(E.segmentDistance(q,flow.path[i-1],flow.path[i])*s<7)return {...flow,type:'overlay'};
    return null;
  }
  function select(entity){state.selected=entity;onSelect(entity?clone(entity):null);schedule();return entity;}
  function overview(){
    for(const shape of state.scene.shapes??[])painter.poly(shape.polygon,'#43e0ff0c','#43e0ff66',.9);
    for(const pin of state.scene.pins??[]){const tint=pin.type==='person'?C.mint:pin.type==='item'?C.gold:C.cyan;if(pin.type==='item')painter.diamond(pin,tint);else painter.dot(pin,tint,pin.name);if(state.cam.s>1||pin.type==='location')painter.mapLabel(pin.name,{x:pin.x,y:pin.y+14/state.cam.s},tint,11);}
  }
  function draw(timestamp=0){
    if(state.destroyed||state.paused)return;
    const w=width(),h=height(),dpr=Math.min(globalThis.devicePixelRatio||1,3),bw=Math.round(w*dpr),bh=Math.round(h*dpr);
    if(canvas.width!==bw)canvas.width=bw;if(canvas.height!==bh)canvas.height=bh;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
    const bg=ctx.createRadialGradient(w*.48,h*.45,0,w*.48,h*.45,Math.max(w,h)*.65);bg.addColorStop(0,'#0d1728');bg.addColorStop(1,C.bg);ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);
    if(!state.scene)return;
    state.cam=state.externalCamera?{...state.externalCamera}:E.camera(state.scene,w,h,state.zoom,state.offset);painter.resetLabels();
    if(background){const a=E.screen(background.bounds,state.cam);ctx.save();ctx.globalAlpha=background.opacity;ctx.drawImage(background.image,a.x,a.y,background.bounds.w*state.cam.s,background.bounds.h*state.cam.s);ctx.restore();}
    painter.grid();if(state.kind==='floor')painter.floor();else if(state.kind==='city')painter.city();else overview();
    for(const flow of [...(state.scene.routes??[]),...state.overlays]){
      const color=flow.kind==='information'?C.violet:flow.kind==='journey'?C.mint:flow.kind==='relation'?C.gold:C.blue;
      ctx.save();if(animate&&!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches)ctx.lineDashOffset=-(timestamp/75)%20;
      painter.line(flow.path,color,1.2,flow.dashed?[4,6]:[]);ctx.restore();
      if(flow.marker)painter.dot({...flow.marker,id:flow.id},color);
    }
    state.labels=painter.labels();const distance=scaleBarWidth/state.cam.s,unit=state.document.units==='cells'?'cells':distance>=1000?'km':'m';
    const value=unit==='km'?distance/1000:distance;
    onViewport({camera:{...state.cam},zoom:state.zoom,scale:{widthPx:scaleBarWidth,distance:value,unit,label:value.toFixed(value>=10?0:value>=1?1:2)+' '+(unit==='cells'?'格':unit),quality:state.document.metricQuality},gridStep:state.gridStep});
  }
  function schedule(){if(state.destroyed||state.paused)return;cancelAnimationFrame(frameId);frameId=requestAnimationFrame(t=>{frameId=0;draw(t);});}
  function animationTick(t){if(state.destroyed||state.paused||!animate)return;draw(t);rafAnimation=requestAnimationFrame(animationTick);}
  function setScene(document,{preserveCamera=false}={}){
    const checks=document?checkSceneDocument(document):[];if(checks.length){checks.forEach(onIssue);return false;}
    const same=state.document?.mapId===document?.mapId&&state.document?.branchId===document?.branchId;
    state.document=document?clone(document):null;state.scene=state.document?.layout??null;state.kind=state.scene?.kind??null;state.selected=null;state.hover=null;state.overlays=[];background=null;
    if(!(same&&preserveCamera)){state.zoom=1;state.offset={x:0,y:0};state.externalCamera=null;}
    onSelect(null);schedule();return true;
  }
  function zoomBy(mult,anchor={x:width()/2,y:height()/2}){
    if(!state.scene||!finite(mult)||mult<=0)return;
    if(!state.cam)draw();const before=E.world(anchor,state.cam);state.externalCamera=null;state.zoom=Math.min(12,Math.max(.3,state.zoom*mult));
    const c=E.camera(state.scene,width(),height(),state.zoom,{x:0,y:0});state.offset={x:anchor.x-before.x*c.s-c.x,y:anchor.y-before.y*c.s-c.y};schedule();
  }
  const pointers=new Map(),point=e=>{const r=canvas.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};};
  if(ownsGestures){
    listen(canvas,'pointerdown',e=>{if(e.pointerType==='mouse'&&e.button!==0)return;const q=point(e);pointers.set(e.pointerId,q);canvas.setPointerCapture?.(e.pointerId);if(pointers.size===2){const [a,b]=[...pointers.values()];pinch={distance:E.distance(a,b)};drag=null;}else if(pointers.size===1)drag={...q,offset:{...state.offset},moved:false};});
    listen(canvas,'pointermove',e=>{const q=point(e);if(pointers.has(e.pointerId))pointers.set(e.pointerId,q);
      if(pointers.size>=2){const [a,b]=[...pointers.values()],distance=E.distance(a,b);if(pinch?.distance>0&&distance>0)zoomBy(distance/pinch.distance,{x:(a.x+b.x)/2,y:(a.y+b.y)/2});pinch={distance};return;}
      if(drag){const dx=q.x-drag.x,dy=q.y-drag.y;if(Math.hypot(dx,dy)>4)drag.moved=true;if(drag.moved){state.externalCamera=null;state.offset={x:drag.offset.x+dx,y:drag.offset.y+dy};schedule();}}
      else if(state.cam){state.hover=hit(E.world(q,state.cam));onHover(state.hover?clone(state.hover):null,q);schedule();}
    });
    const finish=(e,cancelled)=>{const q=point(e),wasPinch=!!pinch;pointers.delete(e.pointerId);if(wasPinch){if(pointers.size===1){const a=[...pointers.values()][0];drag={...a,offset:{...state.offset},moved:true};}else drag=null;pinch=null;}
      else if(drag){if(!cancelled&&!drag.moved&&state.cam)select(hit(E.world(q,state.cam)));drag=null;}};
    listen(canvas,'pointerup',e=>finish(e,false));listen(canvas,'pointercancel',e=>finish(e,true));
    listen(canvas,'pointerleave',()=>{if(!drag){state.hover=null;onHover(null,null);schedule();}});
    listen(canvas,'wheel',e=>{e.preventDefault();zoomBy(e.deltaY>0?1/1.13:1.13,point(e));},{passive:false});
  }
  if(typeof ResizeObserver==='function'){const ro=new ResizeObserver(schedule);ro.observe(canvas);cleanup.push(()=>ro.disconnect());}
  if(globalThis.document)listen(document,'visibilitychange',()=>setPaused(document.hidden));
  function setPaused(value){state.paused=!!value;cancelAnimationFrame(frameId);cancelAnimationFrame(rafAnimation);if(!state.paused){schedule();if(animate)rafAnimation=requestAnimationFrame(animationTick);}}
  return {state,setScene,draw,schedule,zoomBy,fit(){state.zoom=1;state.offset={x:0,y:0};state.externalCamera=null;schedule();},resize:schedule,
    setCamera(c){if(!c||!finite(c.s)||c.s<=0||!finite(c.x)||!finite(c.y))return false;state.externalCamera={s:c.s,x:c.x,y:c.y};if(finite(c.zoom)&&c.zoom>0)state.zoom=c.zoom;if(finite(c.offset?.x)&&finite(c.offset?.y))state.offset={...c.offset};schedule();return true;},
    setOverlays(rows){
      if(!Array.isArray(rows)||rows.length>LIMITS.overlays){onIssue(diagnostic('OVERLAY_INPUT_INVALID','$.overlays','需要有上限的图层数组'));return false;}
      const valid=[];
      for(const row of rows){
        if(row?.mapId!==state.document?.mapId)continue;
        if(!Array.isArray(row.path)||row.path.length<2||row.path.length>LIMITS.pathPoints||!row.path.every(p=>finite(p?.x)&&finite(p?.y))||row.marker&&(!finite(row.marker.x)||!finite(row.marker.y))){onIssue(diagnostic('OVERLAY_PATH_INVALID','$.overlays.path','此项路径不可绘制，其他图层继续显示'));continue;}
        valid.push(row);
      }
      state.overlays=clone(valid);schedule();return true;
    },
    setBackgroundImage(image,bounds,opacity=.6){if(image&&(!bounds||![bounds.x,bounds.y,bounds.w,bounds.h].every(finite)||bounds.w<=0||bounds.h<=0||!finite(opacity))){onIssue(diagnostic('BACKGROUND_BOUNDS_INVALID','$.background','底图需要有限正范围'));return false;}background=image?{image,bounds,opacity:Math.max(0,Math.min(1,opacity))}:null;schedule();return true;},
    selectById(id){return select(entities().find(e=>e.id===id)||null);},focus(id){const e=entities().find(e=>e.id===id);if(!e)return false;select(e);const p=finite(e.x)?(e.w?E.center(e):e):null;if(p){state.externalCamera=null;const c=E.camera(state.scene,width(),height(),state.zoom,{x:0,y:0});state.offset={x:width()/2-p.x*c.s-c.x,y:height()/2-p.y*c.s-c.y};schedule();}return true;},
    entities,hit,setPaused,destroy(){state.destroyed=true;cancelAnimationFrame(frameId);cancelAnimationFrame(rafAnimation);cleanup.splice(0).forEach(fn=>fn());pointers.clear();state.scene=null;state.document=null;}};
}
