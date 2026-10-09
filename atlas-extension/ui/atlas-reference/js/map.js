/* ══════════════════════════════════════════════════════════════
   ATLAS · 地图渲染引擎
   世界坐标 → 屏幕坐标；地形走世界空间，标记/文字走屏幕空间
   ══════════════════════════════════════════════════════════════ */
window.AtlasMap = (function () {
'use strict';

const C = {
  cyan:'#43e0ff', violet:'#9b6bff', amber:'#ffc247', green:'#39e0a0',
  pink:'#ff5f92', blue:'#7fd4ff', dim:'#5d738c'
};

const EXTENT = {
  world:   [-660,660,-400,400],
  region:  [-620,620,-350,350],
  city:    [-580,580,-450,450],
  district:[-410,410,-360,360],
  building:[-520,520,-350,380],
  floor:   [-540,540,-320,360],
  room:    [-400,400,-270,270],
  detail:  [-400,400,-270,270]
};

const WORLD_AT = {
  frostridge:[-352,-186], moonmarch:[36,-34], redsand:[298,214], westisles:[-498,138]
};

/* canvas 不支持 CSS 变量，字体栈必须写实 */
const F = {
  sans:'"Atlas Preview Sans", "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  mono:'"Cascadia Mono", Consolas, "Atlas Preview Sans", monospace'
};

/* ───────── 工具 ───────── */
function hash(s){ let h=2166136261; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619);} return h>>>0; }
function rng(seed){ let s=(seed>>>0)||1; return ()=>{ s=(Math.imul(s,1664525)+1013904223)>>>0; return s/4294967296; }; }
function lerp(a,b,t){ return a+(b-a)*t; }
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }

function smooth(ctx, pts, closed){
  if(!pts || pts.length<2) return;
  const p = closed ? pts.concat([pts[0],pts[1]]) : pts;
  ctx.moveTo(p[0][0],p[0][1]);
  for(let i=0;i<p.length-2;i++){
    const p0=p[i],p1=p[i+1],p2=p[i+2],p3=p[i+3]||p2;
    ctx.bezierCurveTo(
      p1[0]+(p2[0]-p0[0])/6, p1[1]+(p2[1]-p0[1])/6,
      p2[0]-(p3[0]-p1[0])/6, p2[1]-(p3[1]-p1[1])/6,
      p2[0], p2[1]);
  }
  if(closed) ctx.closePath();
}
function wobbly(cx,cy,r,seg,wob,seed){
  const rnd = rng(seed||7), out=[];
  for(let i=0;i<seg;i++){
    const a = i/seg*Math.PI*2;
    const rr = r*(1 + (rnd()-.5)*2*wob);
    out.push([cx+Math.cos(a)*rr, cy+Math.sin(a)*rr]);
  }
  return out;
}
function rrect(ctx,x,y,w,h,r){
  r = Math.min(r, Math.abs(w)/2, Math.abs(h)/2);
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
}
function glow(ctx,color,blur,fn){ ctx.save(); ctx.shadowColor=color; ctx.shadowBlur=blur; fn(); ctx.restore(); }

/* ───────── M6-05 概览背景 ───────── */

/* 面形材质：现有皮肤令牌的延伸，不引入新色系。未知世界一律不是实心背景。 */
const SURFACE_PAINT = {
  mixed:  ['#070e1a','#0a1524'],
  urban:  ['#080b16','#0d1220'],
  forest: ['#061310','#0a1c16'],
  mountain:['#0a0e14','#121822'],
  water:  ['#04121e','#062034'],
  indoor: ['#0a0d14','#111722'],
  void:   ['#03060c','#03060c']
};

/**
 * M6-05②：装饰几何**记忆化**。
 *
 * 旧代码每帧用 `rng()` 现场撒一遍树点/碎石：同一张图每帧点位都不同，缩放时整片
 * 林地会"抖"，而且这种逐帧随机在山地/森林图上直接变成噪点。这里按
 * `地图:图元:尺寸` 做键缓存，点位一次算清、之后只画不算。
 */
const decorCache = new Map();
function decor(seedKey, build){
  let value = decorCache.get(seedKey);
  if(value === undefined){
    value = build();
    // 缓存只服务于"别每帧重算"，不需要无限增长；超量就整体丢弃重来。
    if(decorCache.size >= 512) decorCache.clear();
    decorCache.set(seedKey, value);
  }
  return value;
}
/** 点是否落在多边形内（射线法）；pts 为 [x,y] 串。 */
function insidePoly(pts,x,y){
  let hit = false;
  for(let i=0,j=pts.length-1;i<pts.length;j=i++){
    const [xi,yi]=pts[i], [xj,yj]=pts[j];
    if((yi>y)!==(yj>y) && x < (xj-xi)*(y-yi)/(yj-yi)+xi) hit = !hit;
  }
  return hit;
}
/** 装饰点的数量只由 density 决定；没有 density 就不撒点，不编一个默认密度。 */
const DECOR_DOTS = {low:10, medium:22, high:38};
function decorDots(id, pts, density){
  const count = DECOR_DOTS[density];
  if(!count || !Array.isArray(pts) || pts.length < 3) return [];
  return decor('dots:'+id+':'+density,()=>{
    const rnd = rng(hash(id) || 11);
    let ax=Infinity,ay=Infinity,bx=-Infinity,by=-Infinity;
    for(const [x,y] of pts){ ax=Math.min(ax,x); ay=Math.min(ay,y); bx=Math.max(bx,x); by=Math.max(by,y); }
    const out=[], span=Math.max(1e-6,bx-ax), spanY=Math.max(1e-6,by-ay);
    for(let i=0;i<count*4 && out.length<count;i++){
      const x=ax+rnd()*span, y=ay+rnd()*spanY;
      if(insidePoly(pts,x,y)) out.push([x,y]);
    }
    return out;
  });
}
/**
 * 视口在世界坐标下的矩形（含 pad）。纯函数，方便单测与复用。
 * NaN / 零缩放防护：拿不到可信相机就退回"全画"，绝不因 NaN 静默丢掉整张图。
 */
function worldViewRect(cam,vw,vh,pad){
  const s=cam&&cam.s;
  if(!Number.isFinite(s)||s<=0||!Number.isFinite(cam.x)||!Number.isFinite(cam.y)||!Number.isFinite(vw)||!Number.isFinite(vh))
    return {x0:-Infinity,x1:Infinity,y0:-Infinity,y1:Infinity};
  const k=(pad==null?1.12:pad)/s;
  return {x0:cam.x-vw/2*k, x1:cam.x+vw/2*k, y0:cam.y-vh/2*k, y1:cam.y+vh/2*k};
}
/** 一串世界坐标点只要包围盒与裁剪框相交就值得画。 */
function ptsVisible(pts, r){
  if(!pts || !pts.length) return false;
  let ax=Infinity,ay=Infinity,bx=-Infinity,by=-Infinity;
  for(const p of pts){ const x=p[0],y=p[1]; if(x<ax)ax=x; if(x>bx)bx=x; if(y<ay)ay=y; if(y>by)by=y; }
  return !(bx<r.x0 || ax>r.x1 || by<r.y0 || ay>r.y1);
}

/* ══════════════════════════════════════════════════════════════ */
/* ══════════ 网格（M6-07：步长与视口裁剪） ══════════ */
/**
 * M6-07①：步长只取 1/2/5×10^n，并且屏幕间距必须落在 12–40 CSS px。
 *
 * 旧实现把步长取自写死的 `[1,2,5,10,20,25,50,100,200,250,500,1000]`：
 * 既混进了 25/250 这种非 1-2-5 档，又会在极端缩放下**饱和在 1000** ——
 * 缩到很小时循环步长再也跟不上，只能刷出上万条线。现在按当前缩放现算，永不饱和。
 */
function gridStep(camS, minPx, maxPx){
  const lo=minPx==null?12:minPx, hi=maxPx==null?40:maxPx;
  if(!Number.isFinite(camS)||camS<=0)return null;
  const base=Math.pow(10,Math.ceil(Math.log10(lo/camS)));
  for(const m of [1,2,5]){
    const s=base/m, px=s*camS;
    if(Number.isFinite(s)&&s>0&&px>=lo&&px<=hi)return s;
  }
  // 浮点边界兜底：在 1/2/5 档里取屏距最接近下限的那一档。
  const ladder=[base,base/2,base/5].filter(s=>Number.isFinite(s)&&s>0);
  if(!ladder.length)return null;
  return ladder.reduce((best,s)=>Math.abs(s*camS-lo)<Math.abs(best*camS-lo)?s:best,ladder[0]);
}

/**
 * M6-07①：按 1/2/5 档与可见视口画网格。
 *
 * 纯函数式入口（只吃 ctx + 几何参数），所以可以直接单测线数、坐标范围与线宽，
 * 不必去构造整个 canvas 生命周期。
 */
function paintGrid(ctx, {cam, vw, vh, dpr, step, maxLines}){
  const limit=maxLines==null?2000:maxLines;
  if(!ctx||!cam||!Number.isFinite(cam.s)||cam.s<=0)return 0;
  if(!Number.isFinite(cam.x)||!Number.isFinite(cam.y)||!Number.isFinite(vw)||!Number.isFinite(vh))return 0;
  if(!Number.isFinite(step)||step<=0||vw<=0||vh<=0)return 0;
  const scale=Number.isFinite(dpr)&&dpr>0?dpr:1;
  const x0=(0-vw/2)/cam.s+cam.x, x1=(vw-vw/2)/cam.s+cam.x;
  const y0=(0-vh/2)/cam.s+cam.y, y1=(vh-vh/2)/cam.s+cam.y;
  const sx=x=>(x-cam.x)*cam.s+vw/2, sy=y=>(y-cam.y)*cam.s+vh/2;
  // 对齐到设备像素中心：1 物理像素的线才能画实，而不是糊成两格灰。
  const align=v=>Math.round(v*scale)/scale+0.5/scale;
  ctx.save();
  ctx.lineWidth=1/scale;
  let count=0;
  for(let x=Math.floor(x0/step)*step; x<=x1 && count<limit; x+=step, count++){
    const major=Math.abs(Math.round(x/step))%5===0;
    ctx.strokeStyle=major?'rgba(110,190,255,.20)':'rgba(110,190,255,.075)';
    const px=align(sx(x));
    ctx.beginPath(); ctx.moveTo(px,0); ctx.lineTo(px,vh); ctx.stroke();
  }
  for(let y=Math.floor(y0/step)*step; y<=y1 && count<limit; y+=step, count++){
    const major=Math.abs(Math.round(y/step))%5===0;
    ctx.strokeStyle=major?'rgba(110,190,255,.20)':'rgba(110,190,255,.075)';
    const py=align(sy(y));
    ctx.beginPath(); ctx.moveTo(0,py); ctx.lineTo(vw,py); ctx.stroke();
  }
  ctx.restore();
  return count;
}

/**
 * M6-10②：标签避让。
 *
 * 规则只有一条不能破：**marker 的物理坐标不为排字而移动**。
 * 首选位保持原观感（正中、锚点正下方）；挤不下就依次试右、左、上方，
 * 六个方位全挤不下就整条收纳不画 —— 绝不叠成一团，也绝不挪 marker。
 * 被挪开的标签拉一条 leader 线指回锚点，读者仍知道它属于谁。
 */
function labelSpots(ax,ay,tw,th){
  const gap=7;
  return [
    [ax-tw/2, ay],                              // 首选：正中 · 锚点正下方
    [ax+gap, ay],                               // 右
    [ax-gap-tw, ay],                            // 左
    [ax-tw/2, ay-th-gap],                       // 上
    [ax+gap, ay-th-gap],                        // 右上
    [ax-gap-tw, ay-th-gap],                     // 左上
  ];
}
function placeLabel(occupied, ax, ay, tw, th){
  const spots=labelSpots(ax,ay,tw,th);
  for(let i=0;i<spots.length;i++){
    const box={x:spots[i][0], y:spots[i][1], w:tw, h:th};
    const clash=occupied.some(b=>box.x<b.x+b.w+4 && box.x+box.w>b.x-4 && box.y<b.y+b.h+4 && box.y+box.h>b.y-4);
    if(clash)continue;
    return {box, leader:i>0, lx:clamp(ax, box.x+3, box.x+box.w-3), ly: box.y>=ay?box.y:box.y+box.h};
  }
  return null;
}

function create(canvas, mini, hooks){
  const ctx = canvas.getContext('2d');
  const mctx = mini.getContext('2d');
  const st = {
    node:null, path:[], kind:'world', geo:{}, mode:'map',
    cam:{x:0,y:0,s:1}, tgt:{x:0,y:0,s:1},
    vw:1, vh:1, dpr:1, t:0, last:performance.now(),
    showGrid:true, showMarks:true, showLinks:true, showLabels:true, showRadar:true,
    filter:new Set(), hover:null, sel:null, dragging:false,
    hits:[], edgeHits:[], labels:[], ghost:[], marks:[], paused:false, destroyed:false
  };
  hooks = hooks||{};
  let frameId=0;
  const listeners=[];
  function listen(target,type,handler,opts){target.addEventListener(type,handler,opts);listeners.push(()=>target.removeEventListener(type,handler,opts));}

  /* ── 尺寸 ── */
  function resize(){
    const previousFit=st.node?fitScale():null;
    const oldWidth=st.vw,oldHeight=st.vh;
    const r = canvas.parentElement.getBoundingClientRect();
    st.dpr = Math.min(window.devicePixelRatio||1, 2);
    st.vw = Math.max(1, r.width); st.vh = Math.max(1, r.height);
    // Setting a canvas dimension clears its bitmap, even if the value is unchanged.
    // Repeated observer notifications must not erase a paused but visible map.
    const width=Math.max(1,Math.round(st.vw*st.dpr)),height=Math.max(1,Math.round(st.vh*st.dpr));
    if(canvas.width!==width)canvas.width=width;if(canvas.height!==height)canvas.height=height;
    canvas.style.width = st.vw+'px'; canvas.style.height = st.vh+'px';
    const mr=mini.getBoundingClientRect();
    const miniWidth=Math.max(1,Math.round((mr.width||212)*st.dpr)),miniHeight=Math.max(1,Math.round((mr.height||132)*st.dpr));
    if(mini.width!==miniWidth)mini.width=miniWidth;if(mini.height!==miniHeight)mini.height=miniHeight;
    if(previousFit&&(oldWidth!==st.vw||oldHeight!==st.vh)){
      const ratio=fitScale()/previousFit;st.cam.s*=ratio;st.tgt.s*=ratio;
    }
    if(st.node&&st.paused)frame(performance.now(),true);
  }

  function extent(){ return st.node?.extent || EXTENT[st.kind] || EXTENT.world; }
  function fitScale(pad){
    const [x0,x1,y0,y1] = extent();
    pad = pad==null?1.16:pad;
    return Math.min(st.vw/((x1-x0)*pad), st.vh/((y1-y0)*pad));
  }
  function fit(anim){
    const s = fitScale();
    st.tgt.s = s; st.tgt.x = 0; st.tgt.y = 0;
    if(!anim){ st.cam.s=s; st.cam.x=0; st.cam.y=0; }
  }
  function W2S(x,y){ return [ (x-st.cam.x)*st.cam.s + st.vw/2, (y-st.cam.y)*st.cam.s + st.vh/2 ]; }
  function S2W(x,y){ return [ (x-st.vw/2)/st.cam.s + st.cam.x, (y-st.vh/2)/st.cam.s + st.cam.y ]; }

  /* ── 层级切换 ── */
  function setPath(node, path){
    st.node = node; st.path = path||[]; st.kind = node.kind || 'world';
    st.geo = node.geo || {}; st.sel = null; st.hover = null;st.hits=[];st.edgeHits=[];
    refreshMarks();
    fit(false);
    st.cam.s = st.tgt.s * 1.55;      // 入场“下坠”感
    st.tgt.s = fitScale();
  }

  /* ══════════ 地形渲染（世界空间） ══════════ */

  function terrainWorld(g,w,h){
    const [x0,x1,y0,y1] = extent();
    // 底色
    // M6-05③：概览声明的 surface 覆盖层级默认底色；void（未知世界）就是纯材质，
    // 不许拿别的世界的地形纹理来补。未声明 surface 时保持原层级配色，观感不变。
    const paint = SURFACE_PAINT[g.surface];
    const bg = ctx.createLinearGradient(0,y0,0,y1);
    if(paint){ bg.addColorStop(0,paint[0]); bg.addColorStop(1,paint[1]); }
    else if(st.kind==='world'){ bg.addColorStop(0,'#040a14'); bg.addColorStop(1,'#05121e'); }
    else if(st.kind==='region'){ bg.addColorStop(0,'#07130f'); bg.addColorStop(1,'#0a1a14'); }
    else if(st.kind==='city'){ bg.addColorStop(0,'#080b16'); bg.addColorStop(1,'#0b1020'); }
    else { bg.addColorStop(0,'#070b14'); bg.addColorStop(1,'#0a1120'); }
    ctx.fillStyle = bg; ctx.fillRect(x0-200,y0-200,(x1-x0)+400,(y1-y0)+400);

    if(st.node.host&&st.node.sceneStatus!=='ready') { overviewMap(g); return; }
    if(g.overviewShapes||g.overviewRoutes) { overviewMap(g); return; }
    if(st.kind==='world')      worldMap(g);
    else if(st.kind==='region')regionMap(g);
    else if(st.kind==='city')  cityMap(g);
    else if(st.kind==='district')districtMap(g);
    else if(st.kind==='building')buildingMap(g);
    else if(st.kind==='floor') floorMap(g);
    else                       roomMap(g);
  }

  // SQL overview geometry is usable before a decorative floor/city layout
  // exists. All points stay in this map's transform; absent paths stay absent.
  /**
   * M6-05①：概览的绘制顺序是固定的 ——
   *   ①面形底色（terrainWorld 已铺）→ ②zone 填色 → ③背景林地/山地/水岸 →
   *   ④道路 → ⑤建筑群质感 →（屏幕空间）marker/label → flow。
   *
   * M6-05③：装饰只有材质。这里**不产生**任何可点击/可查询的实体 ——
   * 无名装饰不是地点，缺 shape 时也绝不补一个新地点出来。
   */
  function overviewMap(g){
    const r=worldViewRect(st.cam,st.vw,st.vh,1.12), cam=st.cam.s;
    // 建成区 role 是 schema 枚举；没声明 role 就不加质感，不猜这块地是不是城市。
    const BUILT_ROLES = {city:1,settlement:1,district:1,campus:1};
    ctx.save();
    // ② zone 填色
    for(const shape of g.overviewShapes||[]){
      if(!ptsVisible(shape.pts,r)) continue;
      ctx.beginPath();shape.pts.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.closePath();
      ctx.fillStyle=hexA(shape.c,.10);ctx.fill();
      ctx.strokeStyle=hexA(shape.c,shape.proxy?.36:.48);ctx.lineWidth=1/cam;
      ctx.setLineDash(shape.quality==='exact'||shape.quality==='confirmed'?[]:[5/cam,4/cam]);ctx.stroke();
      // proxy：轮廓在别的图上，这里是"入口示意" —— 叠一圈点线把它和实测轮廓分开。
      if(shape.proxy){ctx.setLineDash([1.5/cam,3/cam]);ctx.strokeStyle='rgba(255,194,71,.5)';ctx.stroke();}
    }
    ctx.setLineDash([]);
    // ③ 背景林地 / 山地 / 水岸
    for(const f of g.overviewFeatures||[]) drawFeature(f,r,cam);
    // ④ 已登记道路
    for(const route of g.overviewRoutes||[]){
      if(!ptsVisible(route.points,r)) continue;
      ctx.beginPath();route.points.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));
      ctx.strokeStyle=route.dashed?'rgba(127,212,255,.42)':'rgba(67,224,255,.7)';
      ctx.lineWidth=(route.dashed?1.1:1.5)/cam;
      ctx.setLineDash(route.dashed?[6/cam,4/cam]:[]);ctx.stroke();
    }
    ctx.setLineDash([]);
    // ⑤ 建筑群质感（只在 zone 自己声明了建成区 role 时加）
    for(const shape of g.overviewShapes||[]){
      if(!BUILT_ROLES[shape.role]||!ptsVisible(shape.pts,r)) continue;
      ctx.beginPath();shape.pts.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.closePath();
      ctx.fillStyle=hexA(shape.c,.13);ctx.fill();
      ctx.save();ctx.clip();
      ctx.strokeStyle='rgba(200,230,255,.10)';ctx.lineWidth=.8/cam;
      for(const [dx,dy] of decorDots(shape.id+':slab',shape.pts,'medium')){
        ctx.beginPath();ctx.moveTo(dx-2.4,dy);ctx.lineTo(dx+2.4,dy);ctx.moveTo(dx,dy-2.4);ctx.lineTo(dx,dy+2.4);ctx.stroke();
      }
      ctx.restore();
      ctx.strokeStyle=hexA(shape.c,.55);ctx.lineWidth=1.2/cam;ctx.setLineDash([]);ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * 单条装饰材质。类型是 schema 枚举；未知类型只铺一层极淡材质，
   * 既不猜它是什么，也不给它建实体。
   */
  function drawFeature(f,r,cam){
    const line=f.line,poly=f.poly;
    if(line&&!ptsVisible(line,r))return;
    if(poly&&!ptsVisible(poly,r))return;
    const path=pts=>{ctx.beginPath();smooth(ctx,pts,!!poly);};
    ctx.save();
    switch(f.type){
      case 'watercourse':{
        // G01：水系必须是"有宽度的线"，不能退化成一个蓝点；宽度是真实正数且随缩放走。
        const w=Math.max(f.width||0,2.2/cam);
        path(line);ctx.lineCap='round';
        ctx.lineWidth=w*1.9;ctx.strokeStyle='rgba(24,96,150,.30)';ctx.stroke();
        ctx.lineWidth=w;ctx.strokeStyle='rgba(90,215,255,.55)';
        ctx.shadowColor='rgba(67,224,255,.55)';ctx.shadowBlur=10/cam;ctx.stroke();
        break;
      }
      case 'shore':{
        path(line||poly);ctx.lineCap='round';
        ctx.lineWidth=Math.max(f.width||0,1.6/cam);
        ctx.setLineDash([9/cam,6/cam]);ctx.strokeStyle='rgba(255,214,150,.32)';ctx.stroke();
        break;
      }
      case 'road_texture':{
        // 路纹只是纹理：不进旅程/路径表，也不生成可点击实体。
        path(line||poly);ctx.lineCap='round';
        ctx.lineWidth=Math.max(f.width||0,1.2/cam);
        ctx.setLineDash([5/cam,5/cam]);ctx.strokeStyle='rgba(200,220,240,.20)';ctx.stroke();
        break;
      }
      case 'forest_texture':{
        path(line||poly);
        ctx.fillStyle='rgba(52,150,110,.15)';if(poly)ctx.fill();
        ctx.lineWidth=Math.max(f.width||0,1/cam);ctx.strokeStyle='rgba(90,220,160,.28)';ctx.stroke();
        // 树点是按 (图元:密度) 记忆化的固定点位 —— 不每帧重撒，缩放时不抖。
        if(poly){
          ctx.fillStyle='rgba(120,235,175,.28)';
          for(const [dx,dy] of decorDots(f.id,poly,f.density)){ctx.beginPath();ctx.arc(dx,dy,Math.max(1.0,.9),0,7);ctx.fill();}
        }
        break;
      }
      case 'ridge':{
        path(line||poly);
        ctx.fillStyle='rgba(120,140,175,.16)';if(poly)ctx.fill();
        ctx.lineWidth=Math.max(f.width||0,2/cam);ctx.strokeStyle='rgba(170,195,235,.30)';ctx.stroke();
        break;
      }
      case 'building_cluster':{
        path(line||poly);
        ctx.fillStyle='rgba(170,205,255,.10)';if(poly)ctx.fill();
        ctx.lineWidth=Math.max(f.width||0,1/cam);ctx.strokeStyle='rgba(180,215,255,.24)';ctx.stroke();
        if(poly){ctx.fillStyle='rgba(200,225,255,.20)';
          for(const [dx,dy] of decorDots(f.id,poly,f.density)){ctx.fillRect(dx-1.1,dy-1.1,2.2,2.2);}}
        break;
      }
      case 'ruins_scatter':{
        path(line||poly);
        ctx.fillStyle='rgba(255,194,71,.07)';if(poly)ctx.fill();
        ctx.lineWidth=Math.max(f.width||0,1/cam);ctx.strokeStyle='rgba(255,194,71,.22)';ctx.stroke();
        if(poly){ctx.fillStyle='rgba(255,205,140,.24)';
          for(const [dx,dy] of decorDots(f.id,poly,f.density)){ctx.fillRect(dx-1.3,dy-0.7,2.6,1.4);}}
        break;
      }
      default:{
        path(line||poly);
        ctx.fillStyle='rgba(120,180,255,.06)';if(poly)ctx.fill();
        ctx.lineWidth=Math.max(f.width||0,1/cam);ctx.strokeStyle='rgba(120,180,255,.18)';ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* ── L0 世界 ── */
  function worldMap(g){
    // 经纬网
    if(g.graticule){
      ctx.save(); ctx.strokeStyle='rgba(90,160,230,.10)'; ctx.lineWidth=1/st.cam.s;
      for(let i=-4;i<=4;i++){
        const y=i*105;
        ctx.beginPath(); ctx.moveTo(-700,y);
        ctx.bezierCurveTo(-240,y-42,240,y-42,700,y); ctx.stroke();
      }
      for(let i=-4;i<=4;i++){
        const x=i*170;
        ctx.beginPath(); ctx.moveTo(x,-440);
        ctx.bezierCurveTo(x+38,-150,x+38,150,x,440); ctx.stroke();
      }
      ctx.restore();
    }
    // 陆地
    g.lands.forEach((L,i)=>{
      const r = rng(hash(L.name)+i);
      let lx0=1e9,lx1=-1e9,ly0=1e9,ly1=-1e9;
      L.pts.forEach(p=>{ lx0=Math.min(lx0,p[0]); lx1=Math.max(lx1,p[0]); ly0=Math.min(ly0,p[1]); ly1=Math.max(ly1,p[1]); });
      ctx.save();
      ctx.beginPath(); smooth(ctx,L.pts,true);
      const grd = ctx.createLinearGradient(lx0,ly0,lx1,ly1);
      grd.addColorStop(0,'rgba(24,80,92,.96)');
      grd.addColorStop(.5,'rgba(18,64,78,.96)');
      grd.addColorStop(1,'rgba(13,48,62,.97)');
      ctx.fillStyle=grd; ctx.fill();
      // 大陆架光带
      ctx.lineWidth=13/st.cam.s; ctx.strokeStyle='rgba(67,224,255,.035)'; ctx.stroke();
      ctx.lineWidth=4/st.cam.s;  ctx.strokeStyle='rgba(80,225,255,.075)'; ctx.stroke();
      // 海岸线
      ctx.lineWidth=1.6/st.cam.s; ctx.strokeStyle='rgba(118,232,255,.6)';
      ctx.shadowColor='rgba(67,224,255,.55)'; ctx.shadowBlur=7/st.cam.s; ctx.stroke();
      ctx.shadowBlur=0;
      // 内部地形肌理
      ctx.save(); ctx.clip();
      ctx.strokeStyle='rgba(140,240,255,.10)'; ctx.lineWidth=.9/st.cam.s;
      for(let k=0;k<70;k++){
        const px=lx0+r()*(lx1-lx0), py=ly0+r()*(ly1-ly0), a=r()*Math.PI;
        ctx.beginPath(); ctx.moveTo(px,py);
        ctx.lineTo(px+Math.cos(a)*18, py+Math.sin(a)*18); ctx.stroke();
      }
      ctx.fillStyle='rgba(140,240,255,.09)';
      for(let k=0;k<120;k++){
        const px=lx0+r()*(lx1-lx0), py=ly0+r()*(ly1-ly0);
        ctx.beginPath(); ctx.arc(px,py,1.1+r()*1.4,0,7); ctx.fill();
      }
      ctx.restore();
      ctx.restore();
    });
    // 小岛
    (g.seas||[]).forEach(s=>{
      ctx.save();
      ctx.beginPath(); smooth(ctx,wobbly(s.c[0],s.c[1],s.r,9,.28,hash('isle'+s.c[0])),true);
      ctx.fillStyle='rgba(18,74,96,.9)'; ctx.fill();
      ctx.lineWidth=1.6/st.cam.s; ctx.strokeStyle='rgba(80,225,255,.45)'; ctx.stroke();
      ctx.restore();
    });
    // 山脉
    ctx.save(); ctx.strokeStyle='rgba(150,235,255,.5)'; ctx.lineWidth=1.8/st.cam.s;
    (g.ridges||[]).forEach(([ax,ay,bx,by])=>{
      const n=Math.max(3,Math.round(Math.hypot(bx-ax,by-ay)/26));
      for(let i=0;i<=n;i++){
        const x=lerp(ax,bx,i/n), y=lerp(ay,by,i/n), s=9+(i%3)*3;
        ctx.beginPath(); ctx.moveTo(x-s,y+s*.7); ctx.lineTo(x,y-s); ctx.lineTo(x+s,y+s*.7); ctx.stroke();
      }
    });
    ctx.restore();
    // 航路
    ctx.save();
    ctx.setLineDash([9/st.cam.s, 9/st.cam.s]);
    ctx.strokeStyle='rgba(155,107,255,.45)'; ctx.lineWidth=1.5/st.cam.s;
    (g.routes||[]).forEach(([a,b])=>{ ctx.beginPath(); ctx.moveTo(a[0],a[1]); ctx.lineTo(b[0],b[1]); ctx.stroke(); });
    ctx.restore();
    // 海域注记
    (g.seaLabels||[]).forEach(([txt,x,y])=>{
      ctx.save();
      ctx.font='300 15px '+F.sans;
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillStyle='rgba(110,190,230,.30)';
      ctx.shadowColor='rgba(0,20,40,.9)'; ctx.shadowBlur=6/st.cam.s;
      ctx.fillText(txt, x, y);
      ctx.restore();
    });
  }

  /* ── L1 地区 ── */
  function regionMap(g){
    const seed = hash(st.node.id);
    // 等高线
    if(g.contours){
      ctx.save(); ctx.strokeStyle='rgba(80,180,150,.13)'; ctx.lineWidth=1/st.cam.s;
      (g.hills||[]).forEach((hb,i)=>{
        for(let k=1;k<=5;k++){
          ctx.beginPath();
          smooth(ctx, wobbly(hb[0],hb[1],hb[2]*k/5,26,.16,seed+i*31+k),true);
          ctx.stroke();
        }
      });
      ctx.restore();
      // 山体
      (g.hills||[]).forEach((hb,i)=>{
        ctx.save();
        ctx.beginPath(); smooth(ctx,wobbly(hb[0],hb[1],hb[2]*.55,20,.2,seed+i*17),true);
        const grd=ctx.createRadialGradient(hb[0],hb[1],4,hb[0],hb[1],hb[2]);
        grd.addColorStop(0,'rgba(46,120,104,.55)'); grd.addColorStop(1,'rgba(20,64,58,.05)');
        ctx.fillStyle=grd; ctx.fill();
        ctx.restore();
      });
    }
    // 山峰
    (g.peaks||[]).forEach((p,i)=>{
      const s=10+(i%3)*4;
      ctx.save(); ctx.beginPath();
      ctx.moveTo(p[0]-s,p[1]+s*.75); ctx.lineTo(p[0],p[1]-s); ctx.lineTo(p[0]+s,p[1]+s*.75);
      ctx.closePath();
      ctx.fillStyle='rgba(150,235,255,.16)'; ctx.fill();
      ctx.strokeStyle='rgba(150,235,255,.5)'; ctx.lineWidth=1.4/st.cam.s; ctx.stroke();
      ctx.restore();
    });
    // 湖泊
    if(g.lake){
      ctx.save();
      ctx.beginPath(); smooth(ctx,wobbly(g.lake.c[0],g.lake.c[1],1,20,0,seed),true);
      ctx.beginPath(); ctx.ellipse(g.lake.c[0],g.lake.c[1],g.lake.rx,g.lake.ry,0,0,Math.PI*2);
      ctx.fillStyle='rgba(30,130,180,.4)'; ctx.fill();
      ctx.strokeStyle='rgba(90,225,255,.5)'; ctx.lineWidth=1.6/st.cam.s;
      ctx.shadowColor='rgba(67,224,255,.5)'; ctx.shadowBlur=12/st.cam.s; ctx.stroke();
      ctx.restore();
    }
    // 河流
    if(g.river){
      ctx.save();
      ctx.beginPath(); smooth(ctx,g.river,false);
      ctx.lineCap='round';
      ctx.lineWidth=9/st.cam.s; ctx.strokeStyle='rgba(30,130,190,.30)'; ctx.stroke();
      ctx.lineWidth=3.4/st.cam.s; ctx.strokeStyle='rgba(110,235,255,.75)';
      ctx.shadowColor='rgba(67,224,255,.7)'; ctx.shadowBlur=10/st.cam.s; ctx.stroke();
      ctx.restore();
    }
    // 道路
    ctx.save();
    ctx.setLineDash([7/st.cam.s,7/st.cam.s]);
    ctx.strokeStyle='rgba(255,194,71,.42)'; ctx.lineWidth=1.7/st.cam.s;
    (g.roads||[]).forEach(([a,b])=>{ ctx.beginPath(); ctx.moveTo(a[0],a[1]); ctx.lineTo(b[0],b[1]); ctx.stroke(); });
    ctx.restore();
  }

  /* ── L2 城市 ── */
  function cityMap(g){
    if(g.wallPoints?.length){ctx.save();ctx.beginPath();smooth(ctx,g.wallPoints,true);ctx.strokeStyle='rgba(120,190,255,.13)';ctx.lineWidth=6/st.cam.s;ctx.stroke();ctx.strokeStyle='rgba(170,225,255,.5)';ctx.lineWidth=1.8/st.cam.s;ctx.setLineDash([12/st.cam.s,5/st.cam.s]);ctx.stroke();ctx.restore();}
    // 河流
    if(g.river){
      ctx.save(); ctx.lineCap='round';
      ctx.beginPath(); smooth(ctx,g.river,false);
      ctx.lineWidth=g.riverWidth||42/st.cam.s; ctx.strokeStyle='rgba(20,90,140,.30)'; ctx.stroke();
      ctx.lineWidth=(g.riverWidth||42/st.cam.s)*26/42; ctx.strokeStyle='rgba(32,140,200,.5)'; ctx.stroke();
      ctx.lineWidth=4/st.cam.s; ctx.strokeStyle='rgba(120,240,255,.55)';
      ctx.shadowColor='rgba(67,224,255,.6)'; ctx.shadowBlur=14/st.cam.s; ctx.stroke();
      ctx.restore();
    }
    // 街区面
    (g.districts||[]).forEach(d=>{
      const on = st.filter.size===0 || st.filter.has(d.id);
      ctx.save(); ctx.globalAlpha = on?1:.16;
      ctx.beginPath(); smooth(ctx,d.pts,true);
      ctx.fillStyle = hexA(d.c,.10); ctx.fill();
      ctx.lineWidth=1.6/st.cam.s; ctx.strokeStyle=hexA(d.c,.42); ctx.stroke();
      ctx.setLineDash([4/st.cam.s,5/st.cam.s]);
      ctx.lineWidth=4/st.cam.s; ctx.strokeStyle=hexA(d.c,.10); ctx.stroke();
      ctx.setLineDash([]);
      // 内部街巷肌理
      let bx0=1e9,bx1=-1e9,by0=1e9,by1=-1e9;
      d.pts.forEach(p=>{ bx0=Math.min(bx0,p[0]); bx1=Math.max(bx1,p[0]); by0=Math.min(by0,p[1]); by1=Math.max(by1,p[1]); });
      ctx.save();
      ctx.beginPath(); smooth(ctx,d.pts,true); ctx.clip();
      const rr = rng(hash(d.id));
      ctx.strokeStyle=hexA(d.c,.11); ctx.lineWidth=1/st.cam.s;
      for(let x=bx0;x<bx1;x+=36){ ctx.beginPath(); ctx.moveTo(x,by0); ctx.lineTo(x,by1); ctx.stroke(); }
      for(let y=by0;y<by1;y+=36){ ctx.beginPath(); ctx.moveTo(bx0,y); ctx.lineTo(bx1,y); ctx.stroke(); }
      for(let k=0;k<190;k++){
        const px=bx0+rr()*(bx1-bx0), py=by0+rr()*(by1-by0);
        ctx.beginPath(); rrect(ctx,px,py,9+rr()*24,8+rr()*22,2);
        ctx.fillStyle=hexA(d.c, .05+rr()*.12); ctx.fill();
      }
      ctx.restore();
      ctx.restore();
      let cx=0,cy=0; d.pts.forEach(p=>{ cx+=p[0]; cy+=p[1]; });
      cx/=d.pts.length; cy/=d.pts.length;
      pushLabel(cx, cy-7, d.name, d.c, 'name', true);
      pushLabel(cx, cy+11, d.id.slice(0,4).toUpperCase()+' · 街区', 'rgba(140,170,200,.72)', 'sub', true);
    });
    // 环路 / 放射大道 / 环形城墙：
    // 这三段读的是 `g.rings` / `g.radials` / `g.walls` —— 仓库里**没有任何生产方**会产出它们
    // （referenceGeometry 的 city 分支只下发 districts/river/wallPoints/avenues）。
    // 留着它们等于留了一条"没数据也能画出一圈城墙"的伪造路径，与 G07「open city 不画默认城墙」冲突，
    // 所以整段删除。真实城墙只看 wallPoints（由 layout.wall 投影，空数组就是开放式城市）。
    // 中心
    ctx.save();
    ctx.beginPath(); ctx.arc(0,0,7/st.cam.s,0,7); ctx.fillStyle='rgba(255,255,255,.25)'; ctx.fill();
    ctx.restore();
  }

  /* ── L3 街区 ── */
  function districtMap(g){
    const seed = hash(st.node.id);
    const rnd = rng(seed);
    // 街道
    ctx.save();
    const [gx0,gx1,gxs] = g.grid.x, [gy0,gy1,gys] = g.grid.y;
    for(let x=gx0;x<=gx1;x+=gxs){
      const major = Math.round((x-gx0)/gxs)%3===0;
      ctx.strokeStyle = major?'rgba(150,205,255,.28)':'rgba(130,180,240,.14)';
      ctx.lineWidth = (major?2.4:1.2)/st.cam.s;
      ctx.beginPath(); ctx.moveTo(x,gy0-20); ctx.lineTo(x,gy1+20); ctx.stroke();
    }
    for(let y=gy0;y<=gy1;y+=gys){
      const major = Math.round((y-gy0)/gys)%3===0;
      ctx.strokeStyle = major?'rgba(150,205,255,.28)':'rgba(130,180,240,.14)';
      ctx.lineWidth = (major?2.4:1.2)/st.cam.s;
      ctx.beginPath(); ctx.moveTo(gx0-20,y); ctx.lineTo(gx1+20,y); ctx.stroke();
    }
    // 对角大道
    ctx.strokeStyle='rgba(255,194,71,.30)'; ctx.lineWidth=3.4/st.cam.s; ctx.lineCap='round';
    (g.avenues||[]).forEach(a=>{
      ctx.beginPath(); ctx.moveTo(a.from[0],a.from[1]); ctx.lineTo(a.to[0],a.to[1]); ctx.stroke();
    });
    ctx.restore();
    // 公园
    if(g.park){
      ctx.save();
      ctx.beginPath();
      smooth(ctx,wobbly(g.park.c[0],g.park.c[1],g.park.rx,20,.1,seed+3),true);
      ctx.fillStyle='rgba(40,190,140,.13)'; ctx.fill();
      ctx.strokeStyle='rgba(57,224,160,.4)'; ctx.lineWidth=1.4/st.cam.s; ctx.stroke();
      ctx.fillStyle='rgba(57,224,160,.30)';
      for(let i=0;i<44;i++){
        const a=rnd()*Math.PI*2, rr=Math.sqrt(rnd())*g.park.rx;
        ctx.beginPath(); ctx.arc(g.park.c[0]+Math.cos(a)*rr, g.park.c[1]+Math.sin(a)*rr*.7, 2.6,0,7); ctx.fill();
      }
      ctx.restore();
    }
    // 广场
    if(g.plaza){
      ctx.save();
      for(let k=3;k>=1;k--){
        ctx.beginPath(); ctx.arc(g.plaza.c[0],g.plaza.c[1],g.plaza.r*k/3,0,7);
        ctx.strokeStyle=`rgba(155,107,255,${.10+k*.06})`; ctx.lineWidth=1.4/st.cam.s; ctx.stroke();
      }
      ctx.restore();
    }
    // 建筑地块
    ctx.save();
    (g.plots||[]).forEach((p,i)=>{
      const [x0,y0,x1,y1] = p.r, r = rng(seed+i*7);
      const pad = 9;
      ctx.beginPath(); rrect(ctx,x0+pad,y0+pad,(x1-x0)-pad*2,(y1-y0)-pad*2,5);
      const grd = ctx.createLinearGradient(x0,y0,x0,y1);
      grd.addColorStop(0,'rgba(52,86,128,.62)'); grd.addColorStop(1,'rgba(26,46,74,.62)');
      ctx.fillStyle=grd; ctx.fill();
      ctx.strokeStyle='rgba(150,205,255,.26)'; ctx.lineWidth=1.2/st.cam.s; ctx.stroke();
      // 屋顶细节
      ctx.strokeStyle='rgba(180,225,255,.14)';
      for(let k=0;k<4;k++){
        const yy=y0+pad+8+k*((y1-y0-pad*2-16)/4);
        ctx.beginPath(); ctx.moveTo(x0+pad+6,yy); ctx.lineTo(x1-pad-6,yy); ctx.stroke();
      }
      // 阴影侧
      ctx.beginPath(); rrect(ctx,x0+pad,y0+pad,(x1-x0)-pad*2,6,3);
      ctx.fillStyle='rgba(190,235,255,.16)'; ctx.fill();
    });
    ctx.restore();
  }

  /* ── L4 建筑 ── */
  function buildingMap(g){
    const seed = hash(st.node.id);
    // 外轮廓（建筑footprint：直边 + 圆角）
    ctx.save();
    ctx.beginPath();
    g.outline.forEach((p,i)=>{ i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]); });
    ctx.closePath();
    const grd = ctx.createLinearGradient(0,-320,0,340);
    grd.addColorStop(0,'rgba(30,56,92,.62)'); grd.addColorStop(1,'rgba(16,32,56,.62)');
    ctx.fillStyle=grd; ctx.fill();
    ctx.lineWidth=3/st.cam.s; ctx.strokeStyle='rgba(120,215,255,.6)';
    ctx.shadowColor='rgba(67,224,255,.6)'; ctx.shadowBlur=16/st.cam.s; ctx.stroke();
    ctx.restore();
    // 中庭
    ctx.save();
    ctx.beginPath(); rrect(ctx,g.atrium.x-g.atrium.w/2,g.atrium.y-g.atrium.h/2,g.atrium.w,g.atrium.h,10);
    ctx.fillStyle='rgba(120,200,255,.10)'; ctx.fill();
    ctx.setLineDash([10/st.cam.s,7/st.cam.s]); ctx.strokeStyle='rgba(150,215,255,.45)';
    ctx.lineWidth=1.6/st.cam.s; ctx.stroke();
    ctx.restore();
    // 楼梯
    (g.stairs||[]).forEach(s=>{
      ctx.save();
      ctx.beginPath(); rrect(ctx,s.x,s.y-s.h/2,s.w,s.h,6);
      ctx.fillStyle='rgba(155,107,255,.16)'; ctx.fill();
      ctx.strokeStyle='rgba(155,107,255,.5)'; ctx.lineWidth=1.4/st.cam.s; ctx.stroke();
      ctx.strokeStyle='rgba(200,175,255,.35)';
      for(let i=1;i<6;i++){
        const x=s.x+s.w*i/6;
        ctx.beginPath(); ctx.moveTo(x,s.y-s.h/2+5); ctx.lineTo(x,s.y+s.h/2-5); ctx.stroke();
      }
      ctx.restore();
    });
    // 分区
    (g.wings||[]).forEach((wg,i)=>{
      const x=wg.x-wg.w/2, y=wg.y-wg.h/2;
      ctx.save();
      ctx.beginPath(); rrect(ctx,x,y,wg.w,wg.h,9);
      const grd=ctx.createLinearGradient(x,y,x,y+wg.h);
      if(wg.live){ grd.addColorStop(0,'rgba(30,110,150,.55)'); grd.addColorStop(1,'rgba(14,56,84,.55)'); }
      else { grd.addColorStop(0,'rgba(38,66,104,.5)'); grd.addColorStop(1,'rgba(20,38,62,.5)'); }
      ctx.fillStyle=grd; ctx.fill();
      ctx.strokeStyle = wg.live?'rgba(67,224,255,.75)':'rgba(150,205,255,.3)';
      ctx.lineWidth=(wg.live?2.2:1.4)/st.cam.s;
      if(wg.live){ ctx.shadowColor='rgba(67,224,255,.7)'; ctx.shadowBlur=14/st.cam.s; }
      ctx.stroke();
      ctx.restore();
      pushLabel(wg.x, wg.y+wg.h/2+16, wg.name, wg.live?C.cyan:'#93a9c4', wg.live?'live':'sub', true);
    });
  }

  /* ── L5 楼层 ── */
  function floorMap(g){
    const seed = hash(st.node.id);
    // 走廊
    const c = g.corridor;
    if(c.w>0&&c.h>0){
    ctx.save();
    ctx.beginPath(); rrect(ctx,c.x,c.y-c.h/2,c.w,c.h,8);
    ctx.fillStyle='rgba(38,62,98,.55)'; ctx.fill();
    ctx.strokeStyle='rgba(140,200,255,.28)'; ctx.lineWidth=1.4/st.cam.s; ctx.stroke();
    ctx.setLineDash([8/st.cam.s,8/st.cam.s]);
    ctx.strokeStyle='rgba(67,224,255,.22)'; ctx.lineWidth=1.2/st.cam.s;
    ctx.beginPath(); ctx.moveTo(c.x+14,0); ctx.lineTo(c.x+c.w-14,0); ctx.stroke();
    ctx.setLineDash([]);
    // 走廊铺地
    ctx.strokeStyle='rgba(150,205,255,.06)'; ctx.lineWidth=1/st.cam.s;
    for(let x=c.x+10;x<c.x+c.w-8;x+=48){ ctx.beginPath(); ctx.moveTo(x,c.y-c.h/2+4); ctx.lineTo(x,c.y+c.h/2-4); ctx.stroke(); }
    // 壁灯
    for(let x=c.x+56;x<c.x+c.w-30;x+=126){
      [-1,1].forEach(sgn=>{
        const ly=sgn*(c.h/2-9);
        const rg=ctx.createRadialGradient(x,ly,1,x,ly,46);
        rg.addColorStop(0,'rgba(255,214,140,.24)'); rg.addColorStop(1,'rgba(255,214,140,0)');
        ctx.beginPath(); ctx.arc(x,ly,46,0,7); ctx.fillStyle=rg; ctx.fill();
        ctx.beginPath(); ctx.arc(x,ly,3.2,0,7); ctx.fillStyle='rgba(255,232,180,.9)';
        ctx.shadowColor='rgba(255,220,150,.9)'; ctx.shadowBlur=12/st.cam.s; ctx.fill(); ctx.shadowBlur=0;
      });
    }
    // 长凳
    ctx.fillStyle='rgba(150,200,255,.13)';
    [-330,-40,250].forEach(bx=>{
      ctx.beginPath(); rrect(ctx,bx,-16,74,10,3); ctx.fill();
      ctx.beginPath(); rrect(ctx,bx,6,74,10,3); ctx.fill();
    });
    ctx.restore();
    }

    // 房间
    (g.rooms||[]).forEach((r,i)=>{
      const x=r.x, y=r.y, w=r.w, h=r.h;
      const live = !!r.live;
      const tint = r.tint || { vault:'67,224,255', hall:'155,107,255', desk:'57,224,160', small:'127,212,255', stair:'150,160,190', exit:'255,194,71' }[r.kind]||'120,180,255';
      ctx.save();
      ctx.beginPath(); rrect(ctx,x,y,w,h,6);
      const grd=ctx.createLinearGradient(x,y,x+w,y+h);
      grd.addColorStop(0,`rgba(${tint},${live?.22:.11})`);
      grd.addColorStop(1,`rgba(${tint},${live?.07:.03})`);
      ctx.fillStyle=grd; ctx.fill();
      ctx.strokeStyle=`rgba(${tint},${live?.85:.35})`; ctx.lineWidth=(live?2.2:1.3)/st.cam.s;
      if(live){ ctx.shadowColor=`rgba(${tint},.8)`; ctx.shadowBlur=16/st.cam.s; }
      ctx.stroke();
      ctx.restore();
    });

    // M6-06②：灯光先于陈设与人物 —— 光晕压在人物**下方**，不许糊住 marker。
    (g.lamps||[]).forEach(l=>{
      const rad=Math.max(26,46);
      ctx.save();
      const rg=ctx.createRadialGradient(l.x,l.y,1,l.x,l.y,rad);
      rg.addColorStop(0,'rgba(255,214,140,.20)'); rg.addColorStop(1,'rgba(255,214,140,0)');
      ctx.beginPath(); ctx.arc(l.x,l.y,rad,0,7); ctx.fillStyle=rg; ctx.fill();
      ctx.beginPath(); ctx.arc(l.x,l.y,2.6,0,7); ctx.fillStyle='rgba(255,232,180,.85)';
      ctx.shadowColor='rgba(255,220,150,.9)'; ctx.shadowBlur=10/st.cam.s; ctx.fill();
      ctx.restore();
    });

    // 陈设（M6-06②：按**真实 roomId** 归属，不再靠几何包含猜；ID 稳定可直接命中）
    (g.rooms||[]).forEach(r=>{
      const x=r.x, y=r.y, w=r.w, h=r.h;
      const tint = r.tint || '120,180,255';
      (g.furn||[]).forEach(f=>{
        if(f.r3){ if(!(f.r3[0]===x&&f.r3[1]===y)) return; }
        else if(f.roomId){ if(f.roomId!==r.id) return; }
        else if(!(f.r && f.r[0]>=x-1 && f.r[2]<=x+w+1 && f.r[1]>=y-1 && f.r[3]<=y+h+1)) return;
        drawFurn(f, x, y, w, h, tint);
      });
      // 房间标签
      // M6-06③：副标题只写**真实字段**。旧代码在这里硬写「禁书区 · 上锁」——
      // 那是示例世界的文案，会被原样印到任何世界的图上。现在有 status 用 status，
      // 没有就写中性描述，绝不为哪个房间编一个剧情状态。
      pushLabel(x+w/2, y+h/2 - 4, r.name, !!r.live?C.cyan:'#a8bdd6', !!r.live?'live':'name', true);
      pushLabel(x+w/2, y+h-13, r.status || (r.kind==='exit'?'通道':'房间'), 'rgba(140,170,200,.75)','sub', true);
    });

    // 门
    ctx.save();
    (g.doors||[]).forEach(d=>{
      ctx.beginPath();
      ctx.moveTo(d.x-d.w/2, d.y); ctx.lineTo(d.x+d.w/2, d.y);
      ctx.strokeStyle='rgba(10,16,26,1)'; ctx.lineWidth=7/st.cam.s; ctx.stroke();
      ctx.strokeStyle='rgba(255,225,150,.85)'; ctx.lineWidth=2/st.cam.s; ctx.stroke();
      ctx.beginPath(); ctx.arc(d.x+d.w/2, d.y, d.w*.42, Math.PI, Math.PI*1.5);
      ctx.setLineDash([3/st.cam.s,3/st.cam.s]);
      ctx.strokeStyle='rgba(255,225,150,.35)'; ctx.lineWidth=1/st.cam.s; ctx.stroke();
    });
    ctx.restore();

    // ── 制图标注（尺寸线 + 图签）──
    const mpp = st.node.host?(st.node.metric||1/st.node.transform.scale):(st.node.metric||0.085);
    const measureWidth=st.node.host?st.node.transform.bounds.w*st.node.transform.scale:940;
    const measureLeft=-measureWidth/2,measureRight=measureWidth/2;
    ctx.save();
    ctx.strokeStyle='rgba(140,200,255,.30)'; ctx.lineWidth=1/st.cam.s;
    const dy=328;
    ctx.beginPath(); ctx.moveTo(measureLeft,dy); ctx.lineTo(measureRight,dy); ctx.stroke();
    for(let x=measureLeft;x<=measureRight;x+=measureWidth/8){ ctx.beginPath(); ctx.moveTo(x,dy-7); ctx.lineTo(x,dy+7); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(-470,-70); ctx.lineTo(-470,dy); ctx.stroke();
    ctx.restore();
    pushLabel(0, dy+11, st.node.host?`宽度 ${(measureWidth*mpp).toFixed(1)} ${st.node.metric?'m':'格'}`:`940 u · 约 ${(940*mpp).toFixed(1)} m`, 'rgba(150,200,240,.8)', 'sub', true);
    // 图签
    ctx.save();
    ctx.beginPath(); rrect(ctx,296,-302,228,50,4);
    ctx.fillStyle='rgba(8,14,24,.82)'; ctx.fill();
    ctx.strokeStyle='rgba(120,200,255,.35)'; ctx.lineWidth=1/st.cam.s; ctx.stroke();
    ctx.restore();
    pushLabel(410, -297, (st.path[st.path.length-2]||{}).name || '建筑图', '#bcd6ee', 'name', true);
    pushLabel(410, -284, st.node.host?`空间示意 · 单位 ${st.node.metric?'m':'格'}`:`比例 1:${Math.round(0.085/mpp*140)} · ATLAS 制图`, 'rgba(140,170,200,.85)', 'sub', true);
    pushLabel(410, -271, `地点 ${st.node.id} · ${st.node.name}`, 'rgba(140,170,200,.85)', 'sub', true);
  }
  /**
   * M6-06②：通用室内陈设。
   *
   * - 真实类型优先：读 `f.type`（M6-03 从场景的真实 body.type 投影而来）。
   *   POV 场景的服务端白名单会剥掉 body.type，此时 `f.detail===false`、
   *   这里画一块中性块 —— **不猜**它是一张床还是一张桌。
   * - `f.solid===false`（灯、门洞、摆件）走虚线淡描：G08 要求实体障碍与装饰一眼可分。
   * - 渲染靠 `f.r`（4 元组绝对坐标）；`x,y,w,h` 是所属房间，仅用于 fallback 着色。
   */
  function drawFurn(f,x,y,w,h,tint){
    const r=f.r||[x,y,x+w,y+h];
    const [a,b,c2,d]=r;
    const bw=c2-a, bh=d-b;
    const known=!!f.type||!!f.detail;
    const kind=f.type||f.t||'decor';
    const solid=f.solid===true;
    const stroke=solid?'rgba(214,232,255,.5)':'rgba(200,220,240,.30)';
    const fill=solid?'rgba(200,225,255,.15)':'rgba(200,220,240,.07)';
    ctx.save();
    if(!known||kind==='decor'){
      // 不知道是什么，只标"这里有一件东西"，不编形状。
      ctx.beginPath(); rrect(ctx,a,b,bw,bh,3);
      ctx.fillStyle='rgba(170,200,235,.07)'; ctx.fill();
      ctx.strokeStyle='rgba(180,205,235,.22)'; ctx.lineWidth=1/st.cam.s;
      ctx.setLineDash([3/st.cam.s,3/st.cam.s]); ctx.stroke(); ctx.setLineDash([]);
      ctx.restore(); return;
    }
    switch(kind){
      case 'shelf':{
        ctx.beginPath(); rrect(ctx,a,b,bw,bh,3);
        ctx.fillStyle='rgba(255,194,71,.14)'; ctx.fill();
        ctx.strokeStyle='rgba(255,194,71,.45)'; ctx.lineWidth=1.1/st.cam.s; ctx.stroke();
        // 隔板数量是**画法参数**（约每 1.1 世界单位一层），不是世界数据；
        // 旧代码读 `f.n`，而 `n` 从来没被任何数据源产出过 —— 那是个固定的假数字。
        const horiz=bw>bh;
        const n=Math.max(2,Math.min(8,Math.round((horiz?bw:bh)/1.1)));
        ctx.strokeStyle='rgba(255,214,130,.35)';
        for(let i=1;i<n;i++){
          ctx.beginPath();
          if(horiz){ const xx=a+bw*i/n; ctx.moveTo(xx,b+3); ctx.lineTo(xx,d-3); }
          else { const yy=b+bh*i/n; ctx.moveTo(a+3,yy); ctx.lineTo(c2-3,yy); }
          ctx.stroke();
        }
        break;
      }
      case 'table':{
        ctx.beginPath(); rrect(ctx,a,b,bw,bh,8);
        ctx.fillStyle='rgba(200,225,255,.16)'; ctx.fill();
        ctx.strokeStyle='rgba(200,230,255,.5)'; ctx.lineWidth=1.4/st.cam.s; ctx.stroke();
        break;
      }
      case 'desk':{
        ctx.beginPath(); rrect(ctx,a,b,bw,bh,3);
        ctx.fillStyle='rgba(140,200,255,.12)'; ctx.fill();
        ctx.strokeStyle='rgba(150,210,255,.4)'; ctx.lineWidth=1.1/st.cam.s; ctx.stroke();
        break;
      }
      case 'chair':{
        ctx.beginPath(); rrect(ctx,a,b,bw,bh,2);
        ctx.fillStyle='rgba(190,215,250,.14)'; ctx.fill();
        ctx.strokeStyle='rgba(200,225,255,.42)'; ctx.lineWidth=1/st.cam.s; ctx.stroke();
        // 椅背：沿短边画一道，让人一眼看出朝向
        ctx.beginPath();
        if(bw>=bh){ ctx.moveTo(a+1,b+1); ctx.lineTo(c2-1,b+1); }
        else { ctx.moveTo(a+1,b+1); ctx.lineTo(a+1,d-1); }
        ctx.lineWidth=2/st.cam.s; ctx.strokeStyle='rgba(200,225,255,.6)'; ctx.stroke();
        break;
      }
      case 'bed':{
        ctx.beginPath(); rrect(ctx,a,b,bw,bh,4);
        ctx.fillStyle='rgba(155,107,255,.14)'; ctx.fill();
        ctx.strokeStyle='rgba(180,150,255,.45)'; ctx.lineWidth=1.2/st.cam.s; ctx.stroke();
        // 枕头（短边一侧）+ 被沿
        ctx.fillStyle='rgba(210,195,255,.22)';
        if(bh>=bw){ ctx.beginPath(); rrect(ctx,a+2,b+2,bw-4,Math.min(bh*.22,7),2); ctx.fill();
          ctx.beginPath(); ctx.moveTo(a+2,b+bh*.42); ctx.lineTo(c2-2,b+bh*.42); }
        else { ctx.beginPath(); rrect(ctx,a+2,b+2,Math.min(bw*.22,7),bh-4,2); ctx.fill();
          ctx.beginPath(); ctx.moveTo(a+bw*.42,b+2); ctx.lineTo(a+bw*.42,d-2); }
        ctx.strokeStyle='rgba(210,195,255,.35)'; ctx.lineWidth=1/st.cam.s; ctx.stroke();
        break;
      }
      case 'pillow':{
        ctx.beginPath(); rrect(ctx,a,b,bw,bh,Math.min(bw,bh)/2);
        ctx.fillStyle='rgba(210,195,255,.20)'; ctx.fill(); ctx.strokeStyle=stroke; ctx.lineWidth=1/st.cam.s; ctx.stroke();
        break;
      }
      case 'cabinet':{
        ctx.beginPath(); rrect(ctx,a,b,bw,bh,2);
        ctx.fillStyle='rgba(255,194,71,.10)'; ctx.fill();
        ctx.strokeStyle='rgba(255,205,130,.40)'; ctx.lineWidth=1.2/st.cam.s; ctx.stroke();
        // 双开门 + 把手
        ctx.beginPath();
        if(bw>=bh){ const mx=a+bw/2; ctx.moveTo(mx,b+1); ctx.lineTo(mx,d-1); }
        else { const my=b+bh/2; ctx.moveTo(a+1,my); ctx.lineTo(c2-1,my); }
        ctx.strokeStyle='rgba(255,205,130,.28)'; ctx.lineWidth=0.9/st.cam.s; ctx.stroke();
        ctx.beginPath(); ctx.arc(bw>=bh?a+bw*.42:a+bw*.45, bh>=bw?b+bh*.42:b+bh*.45, 0.9, 0, 7);
        ctx.fillStyle='rgba(255,215,150,.6)'; ctx.fill();
        break;
      }
      case 'rug':{
        ctx.beginPath(); rrect(ctx,a,b,bw,bh,14);
        ctx.fillStyle=`rgba(${tint},.10)`; ctx.fill();
        ctx.setLineDash([6/st.cam.s,6/st.cam.s]);
        ctx.strokeStyle=`rgba(${tint},.4)`; ctx.lineWidth=1.2/st.cam.s; ctx.stroke(); ctx.setLineDash([]);
        break;
      }
      case 'light':{
        // 灯不是障碍：只画一小圈光，且永远在人物下方（本函数在 marker 之前调用）。
        ctx.beginPath(); ctx.arc(a+bw/2,b+bh/2,Math.max(2,Math.min(bw,bh)/2),0,7);
        ctx.fillStyle='rgba(255,228,170,.28)'; ctx.fill();
        ctx.strokeStyle='rgba(255,232,180,.5)'; ctx.lineWidth=0.9/st.cam.s;
        ctx.setLineDash([2/st.cam.s,2/st.cam.s]); ctx.stroke(); ctx.setLineDash([]);
        break;
      }
      case 'doorway':{
        // 门洞是通行结构：画门槛，不画实体填充，也不参与碰撞。
        ctx.beginPath(); ctx.moveTo(a,b); ctx.lineTo(c2,d);
        ctx.strokeStyle='rgba(255,225,150,.45)'; ctx.lineWidth=1.4/st.cam.s;
        ctx.setLineDash([4/st.cam.s,3/st.cam.s]); ctx.stroke(); ctx.setLineDash([]);
        break;
      }
      case 'stairs':{
        ctx.beginPath(); rrect(ctx,a,b,bw,bh,2);
        ctx.fillStyle='rgba(160,175,205,.12)'; ctx.fill();
        ctx.strokeStyle='rgba(170,190,225,.38)'; ctx.lineWidth=1/st.cam.s; ctx.stroke();
        ctx.strokeStyle='rgba(170,190,225,.26)';
        const steps=Math.max(2,Math.round((bw>=bh?bw:bh)/1.2));
        for(let i=1;i<steps;i++){
          ctx.beginPath();
          if(bw>=bh){ const xx=a+bw*i/steps; ctx.moveTo(xx,b+1); ctx.lineTo(xx,d-1); }
          else { const yy=b+bh*i/steps; ctx.moveTo(a+1,yy); ctx.lineTo(c2-1,yy); }
          ctx.stroke();
        }
        break;
      }
      default:{
        ctx.beginPath(); rrect(ctx,a,b,bw,bh,3);
        ctx.fillStyle=fill; ctx.fill();
        ctx.strokeStyle=stroke; ctx.lineWidth=1/st.cam.s;
        if(!solid)ctx.setLineDash([3/st.cam.s,3/st.cam.s]);
        ctx.stroke(); ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }

  /* ── L6 房间 ── */
  function roomMap(g){
    const seed = hash(st.node.id), rnd = rng(seed);
    const W = g.walls;
    // M6-06 边界：有已保存场景、但几何不是已知 kind 时会走到这里。
    // 旧代码直接读 W.x 抛异常，整张图白屏；现在退化成空地面 + 明确说明。
    if(!W || !Number.isFinite(W.x) || !Number.isFinite(W.y) || !Number.isFinite(W.w) || !Number.isFinite(W.h)){
      pushLabel(0,0,'尚未建立内部空间','rgba(150,180,215,.85)','sub',true);
      return;
    }
    // 地面
    ctx.save();
    ctx.beginPath(); rrect(ctx,W.x,W.y,W.w,W.h,4);
    const grd=ctx.createRadialGradient(0,0,20,0,0,Math.max(W.w,W.h)*.62);
    grd.addColorStop(0,'rgba(28,50,80,.72)'); grd.addColorStop(1,'rgba(12,22,38,.85)');
    ctx.fillStyle=grd; ctx.fill();
    // 地板砖
    ctx.save(); ctx.clip();
    ctx.strokeStyle='rgba(150,205,255,.055)'; ctx.lineWidth=.8/st.cam.s;
    for(let x=W.x;x<=W.x+W.w;x+=34){ ctx.beginPath(); ctx.moveTo(x,W.y); ctx.lineTo(x,W.y+W.h); ctx.stroke(); }
    for(let y=W.y;y<=W.y+W.h;y+=34){ ctx.beginPath(); ctx.moveTo(W.x,y); ctx.lineTo(W.x+W.w,y); ctx.stroke(); }
    ctx.restore();
    ctx.restore();
    // 窗光
    if(g.window){
      ctx.save();
      const x=g.window.x, y=g.window.y, h=g.window.h;
      ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x,y+h);
      ctx.lineWidth=7/st.cam.s; ctx.strokeStyle='rgba(150,225,255,.85)';
      ctx.shadowColor='rgba(120,220,255,.9)'; ctx.shadowBlur=22/st.cam.s; ctx.stroke();
      const cg=ctx.createLinearGradient(x,0,x+330,0);
      cg.addColorStop(0,'rgba(140,220,255,.10)'); cg.addColorStop(1,'rgba(140,220,255,0)');
      ctx.beginPath(); ctx.moveTo(x,y-10); ctx.lineTo(x+330,y-150); ctx.lineTo(x+330,y+h+150); ctx.lineTo(x,y+h+10);
      ctx.closePath(); ctx.fillStyle=cg; ctx.fill();
      ctx.restore();
    }
    // 地毯
    if(g.rug){
      const[a,b,c2,d]=g.rug.r;
      ctx.save(); ctx.beginPath(); rrect(ctx,a,b,c2-a,d-b,16);
      ctx.fillStyle='rgba(155,107,255,.10)';
      ctx.strokeStyle='rgba(155,107,255,.4)'; ctx.lineWidth=1.6/st.cam.s;
      ctx.setLineDash([9/st.cam.s,7/st.cam.s]); ctx.stroke(); ctx.fill(); ctx.restore();
    }
    // 书架
    (g.shelves||[]).forEach(s=>{
      const[a,b,c2,d]=s.r, n=s.n||8, horiz=(c2-a)>(d-b);
      const rr = rng(hash('shelf'+a+b));
      ctx.save();
      ctx.beginPath(); rrect(ctx,a,b,c2-a,d-b,4);
      ctx.fillStyle='rgba(10,16,26,.75)'; ctx.fill();
      // 书脊：按格排满，底对齐
      ctx.save(); ctx.beginPath(); rrect(ctx,a+2,b+2,c2-a-4,d-b-4,3); ctx.clip();
      if(horiz){
        const colW=(c2-a)/n;
        for(let i=0;i<n;i++){
          const x0=a+colW*i+2, wAvail=colW-4, k=2+Math.floor(rr()*3), sw=wAvail/k;
          for(let j=0;j<k;j++){
            const bh=(d-b-8)*(0.68+rr()*0.28);
            ctx.beginPath();
            rrect(ctx, x0+j*sw+0.6, d-4-bh, sw-1.2, bh, 1);
            ctx.fillStyle=`hsla(${196+rr()*70},${20+rr()*16}%,${24+rr()*20}%,.95)`;
            ctx.fill();
          }
        }
      } else {
        const rowH=(d-b)/n;
        for(let i=0;i<n;i++){
          const y0=b+rowH*i+2, hAvail=rowH-4, k=2+Math.floor(rr()*3), sh=hAvail/k;
          for(let j=0;j<k;j++){
            const bw=(c2-a-8)*(0.68+rr()*0.28);
            ctx.beginPath();
            rrect(ctx, a+4, y0+j*sh+0.6, bw, sh-1.2, 1);
            ctx.fillStyle=`hsla(${196+rr()*70},${20+rr()*16}%,${24+rr()*20}%,.95)`;
            ctx.fill();
          }
        }
      }
      ctx.restore();
      ctx.beginPath(); rrect(ctx,a,b,c2-a,d-b,4);
      ctx.strokeStyle='rgba(255,194,71,.55)'; ctx.lineWidth=1.6/st.cam.s; ctx.stroke();
      ctx.beginPath(); rrect(ctx,a,b,c2-a,d-b,4);
      ctx.fillStyle='rgba(255,194,71,.05)'; ctx.fill();
      ctx.restore();
    });
    // 长桌
    if(g.table){
      const[a,b,c2,d]=g.table.r;
      ctx.save();
      ctx.beginPath(); rrect(ctx,a+6,b+6,c2-a,d-b,10);
      ctx.fillStyle='rgba(0,0,0,.4)'; ctx.fill();
      ctx.beginPath(); rrect(ctx,a,b,c2-a,d-b,10);
      const tg=ctx.createLinearGradient(a,b,a,d);
      tg.addColorStop(0,'rgba(150,190,240,.30)'); tg.addColorStop(1,'rgba(70,110,160,.30)');
      ctx.fillStyle=tg; ctx.fill();
      ctx.strokeStyle='rgba(190,230,255,.6)'; ctx.lineWidth=1.6/st.cam.s; ctx.stroke();
      // 摊开的书
      ctx.beginPath(); rrect(ctx,10,-16,74,34,3);
      ctx.fillStyle='rgba(240,235,210,.85)'; ctx.fill();
      ctx.strokeStyle='rgba(160,130,80,.9)'; ctx.lineWidth=1.2/st.cam.s; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(47,-16); ctx.lineTo(47,18); ctx.stroke();
      ctx.save(); ctx.shadowColor='rgba(120,230,255,.9)'; ctx.shadowBlur=16/st.cam.s;
      ctx.fillStyle='rgba(160,240,255,.5)'; ctx.fill(); ctx.restore();
      ctx.restore();
    }
    // 灯
    (g.lamps||[]).forEach(l=>{
      const rg=ctx.createRadialGradient(l[0],l[1],2,l[0],l[1],96);
      rg.addColorStop(0,'rgba(255,214,140,.20)'); rg.addColorStop(1,'rgba(255,214,140,0)');
      ctx.beginPath(); ctx.arc(l[0],l[1],96,0,7); ctx.fillStyle=rg; ctx.fill();
      ctx.beginPath(); ctx.arc(l[0],l[1],4.5,0,7); ctx.fillStyle='rgba(255,230,170,.9)';
      ctx.shadowColor='rgba(255,220,150,.9)'; ctx.shadowBlur=14/st.cam.s; ctx.fill();
    });
    // 墙
    ctx.save();
    ctx.beginPath(); rrect(ctx,W.x,W.y,W.w,W.h,4);
    ctx.lineWidth=7/st.cam.s; ctx.strokeStyle='rgba(140,215,255,.75)';
    ctx.shadowColor='rgba(67,224,255,.65)'; ctx.shadowBlur=16/st.cam.s; ctx.stroke();
    ctx.lineWidth=2/st.cam.s; ctx.strokeStyle='rgba(220,245,255,.5)'; ctx.stroke();
    // 门洞
    if(g.door){
      ctx.beginPath();
      ctx.moveTo(g.door.x-g.door.w/2,g.door.y); ctx.lineTo(g.door.x+g.door.w/2,g.door.y);
      ctx.strokeStyle='rgba(6,10,18,1)'; ctx.lineWidth=10/st.cam.s; ctx.stroke();
      ctx.strokeStyle='rgba(255,225,150,.9)'; ctx.lineWidth=2.4/st.cam.s; ctx.stroke();
    }
    ctx.restore();
  }

  function hexA(hex,a){
    const h=hex.replace('#','');
    const r=parseInt(h.substr(0,2),16),g=parseInt(h.substr(2,2),16),b=parseInt(h.substr(4,2),16);
    return `rgba(${r},${g},${b},${a})`;
  }

  /* ══════════ 网格 ══════════ */
  /**
   * M6-07①：网格画在**屏幕空间**，范围由可见视口决定。
   *
   * 旧实现在世界空间里画、靠 `1/st.cam.s` 反算线宽：看着也是 1px，但线位置没有对齐
   * 设备像素，缩放时细线会忽明忽暗甚至消失半像素；而且范围取自固定的逻辑 extent，
   * 缩放到外面就只剩一片空白。现在：可见视口算范围、线宽恒为 1 物理像素、
   * 坐标对齐设备像素网格，单帧线数硬上限 2000。
   */
  function grid(){
    if(!st.showGrid) return;
    const cam=st.cam;
    // NaN / 零缩放防护：算不出可信步长就不画网格，绝不进死循环。
    if(!Number.isFinite(cam.s)||cam.s<=0||!Number.isFinite(cam.x)||!Number.isFinite(cam.y)
      ||!Number.isFinite(st.vw)||!Number.isFinite(st.vh)) return;
    const step=gridStep(cam.s);
    if(!(step>0)) return;
    paintGrid(ctx,{cam,vw:st.vw,vh:st.vh,dpr:st.dpr,step});
  }

  /** `rank` 越小越优先（0 = 选中/悬停）。不传就按标签种类给默认优先级。 */
  function pushLabel(x,y,text,color,kind,world,rank){ if(st.showLabels) st.labels.push({x,y,text,color,kind,scr:!world,rank}); }

  /* ══════════ 标记（屏幕空间） ══════════ */
  function collectMarks(){
    const out=[];
    const g=st.geo, k=st.kind;
    if(!st.node) return out;
    if(st.node.host)return (st.node.marks||[]).map(m=>({...m}));
    if(k==='world'){
      (st.node.children||[]).forEach(ch=>{
        const p=WORLD_AT[ch.id]; if(!p) return;
        out.push({ type:'poi', x:p[0], y:p[1], name:ch.name, sub:ch.count, node:ch, big:true, live:!!ch.live });
      });
    } else if(k==='region'){
      (g.nodes||[]).forEach(n=>{
        const type = n.type==='city'?'poi':n.type==='port'?'exit':n.type==='wild'?'poi':n.type==='poi'?'poi':'poi';
        out.push({ type, x:n.c[0], y:n.c[1], name:n.name, sub:n.tag, big:n.r>18, live:!!n.live, node:findChild(n.id) });
      });
    } else if(k==='city'){
      (g.pois||[]).forEach(p=>{
        out.push({ type:p.type||'poi', id:p.id, x:p.c[0], y:p.c[1], name:p.name, sub:p.tag, live:!!p.live, node:findChild(p.childId||p.id) });
      });
    } else if(k==='district'){
      (g.buildings||[]).forEach(b=>{
        out.push({ type:b.type||'poi', id:b.id, x:b.c[0], y:b.c[1], name:b.name, sub:b.tag, live:!!b.live, node:findChild(b.id), rect:[b.w,b.h] });
      });
      (g.marks||[]).forEach(m=>out.push(Object.assign({},m)));
    } else if(k==='building'){
      (g.wings||[]).forEach(w=>{const node=findChild(w.id);if(node)out.push({type:'poi',id:w.id,x:w.x,y:w.y,name:w.name,node,silent:true});});
      (g.marks||[]).forEach(m=>out.push(Object.assign({},m)));
    } else if(k==='floor'){
      (st.node.children||[]).forEach(ch=>{
        const r=(g.rooms||[]).find(x=>x.id===ch.id); if(!r) return;
        out.push({ type:'poi', x:r.x+r.w/2, y:r.y+18, name:ch.name, sub:'点击进入', live:!!r.live, node:ch, tiny:true, silent:true });
      });
      (g.marks||[]).forEach(m=>out.push(Object.assign({},m)));
    } else {
      (st.node.marks||[]).forEach(m=>out.push(Object.assign({},m)));
      (g.marks||[]).forEach(m=>out.push(Object.assign({},m)));
    }
    out.forEach(m=>{if(m.childId)m.node=findChild(m.childId);});
    return hooks.getMarks?hooks.getMarks(st.node,out):out;
  }

  function findChild(id){
    const c=(st.node.children||[]).find(x=>x.id===id);
    if(c) return c;
    const p=st.path[st.path.length-2];
    return (p&&(p.children||[]).find(x=>x.id===id))||null;
  }

  /**
   * M6-10①：标记的屏幕坐标只在这里算一次。
   *
   * 命中测试与绘制必须用**完全相同**的固定坐标 —— 旧代码在 drawMarks 里算一遍、
   * 在 hitTest 里用 W2S 再算一遍，任何一侧加个偏移就会出现"看得到点不中"。
   * 这里同时做视口裁剪，保证"画出来的就能点、点不到的就不画"。
   */
  function markScreenPos(m){
    const [x,y]=W2S(m.x,m.y);
    if(x<-90||x>st.vw+90||y<-90||y>st.vh+90) return null;
    return {m,x,y,r:16};
  }
  function visibleMarkHits(){
    const out=[];
    for(const m of st.marks){ const hit=markScreenPos(m); if(hit) out.push(hit); }
    return out;
  }

  function drawMarks(t){
    st.hits=[];
    ctx.save();
    for(const hit of visibleMarkHits()){
      // 悬停/选中只改颜色与光晕，**绝不**改坐标 —— 锚点一挪，点击目标就跟着飘。
      st.hits.push(hit);
      drawMark(ctx, hit.m, hit.x, hit.y, t, st.hover && st.hover.key===hit.m.key, st.sel && st.sel.key===hit.m.key);
    }
    ctx.restore();
  }

  function drawMark(ctx,m,sx,sy,t,hover,sel){
    const col = m.c || ({char:C.cyan,item:C.amber,poi:C.violet,sig:C.green,evt:C.pink,exit:C.blue}[m.type]||C.cyan);
    const dim = m.dim ? .35 : 1;
    ctx.save();
    ctx.globalAlpha = dim;

    if(m.type==='char'){
      if(m.hero){
        ctx.save();
        ctx.translate(sx,sy); ctx.rotate(t*0.35);
        ctx.setLineDash([5,7]); ctx.strokeStyle=hexA(col,.75); ctx.lineWidth=1.4;
        ctx.beginPath(); ctx.arc(0,0,21,0,7); ctx.stroke();
        ctx.setLineDash([]);
        for(let i=0;i<4;i++){
          const a=i/4*Math.PI*2;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a)*24,Math.sin(a)*24); ctx.lineTo(Math.cos(a)*30,Math.sin(a)*30);
          ctx.strokeStyle=hexA(col,.9); ctx.lineWidth=1.6; ctx.stroke();
        }
        ctx.restore();
        // 视野锥
        if(m.facing!=null){
          ctx.save(); ctx.translate(sx,sy); ctx.rotate(m.facing);
          const cg=ctx.createLinearGradient(0,0,52,0);
          cg.addColorStop(0,hexA(col,.30)); cg.addColorStop(1,hexA(col,0));
          ctx.beginPath(); ctx.moveTo(0,0); ctx.arc(0,0,52,-.42,.42); ctx.closePath();
          ctx.fillStyle=cg; ctx.fill(); ctx.restore();
        }
      }
      const pr = 12 + Math.sin(t*2.2 + (m.x||0)*.01)*4;
      ctx.beginPath(); ctx.arc(sx,sy,pr,0,7);
      ctx.strokeStyle=hexA(col,.30); ctx.lineWidth=1.2; ctx.stroke();
      ctx.beginPath(); ctx.arc(sx,sy,9,0,7);
      const g1=ctx.createRadialGradient(sx-3,sy-3,1,sx,sy,10);
      g1.addColorStop(0,'#ffffff'); g1.addColorStop(.35,col); g1.addColorStop(1,hexA(col,.75));
      ctx.fillStyle=g1;
      ctx.shadowColor=col; ctx.shadowBlur=16; ctx.fill();
      ctx.shadowBlur=0; ctx.strokeStyle='rgba(4,10,18,.9)'; ctx.lineWidth=1.5; ctx.stroke();
      ctx.fillStyle='#04121c'; ctx.font='700 9px '+F.sans;
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(m.initial||(m.name||'?')[0], sx, sy+.5);
    } else if(m.type==='item'){
      ctx.save(); ctx.translate(sx,sy); ctx.rotate(Math.PI/4);
      ctx.beginPath(); rrect(ctx,-5.5,-5.5,11,11,2);
      ctx.fillStyle=hexA(col,.9); ctx.shadowColor=col; ctx.shadowBlur=14; ctx.fill();
      ctx.shadowBlur=0; ctx.strokeStyle='rgba(4,10,18,.9)'; ctx.lineWidth=1.3; ctx.stroke();
      ctx.restore();
      if(!m.silent){
        ctx.beginPath(); ctx.arc(sx,sy,13,0,7); ctx.strokeStyle=hexA(col,.25); ctx.lineWidth=1; ctx.stroke();
      }
    } else if(m.type==='exit'){
      ctx.save(); ctx.translate(sx,sy);
      ctx.beginPath(); ctx.moveTo(0,-8); ctx.lineTo(7,4); ctx.lineTo(0,1); ctx.lineTo(-7,4); ctx.closePath();
      ctx.fillStyle=hexA(col,.85); ctx.shadowColor=col; ctx.shadowBlur=14; ctx.fill();
      ctx.shadowBlur=0; ctx.strokeStyle='rgba(4,10,18,.9)'; ctx.lineWidth=1.3; ctx.stroke();
      ctx.restore();
    } else if(m.type==='sig'){
      ctx.save(); ctx.translate(sx,sy);
      ctx.beginPath(); ctx.arc(0,0,3.4,0,7); ctx.fillStyle=col;
      ctx.shadowColor=col; ctx.shadowBlur=14; ctx.fill(); ctx.shadowBlur=0;
      for(let i=1;i<=3;i++){
        const a=.6+Math.sin(t*2-i*.6)*.25;
        ctx.beginPath(); ctx.arc(0,0,i*5.4,-Math.PI*.42,Math.PI*.42);
        ctx.strokeStyle=hexA(col,.22+a*.5); ctx.lineWidth=1.5; ctx.stroke();
      }
      ctx.restore();
    } else {
      // poi
      const s = m.big?9:(m.tiny?6:7.5);
      ctx.save(); ctx.translate(sx,sy);
      ctx.beginPath(); rrect(ctx,-s,-s,s*2,s*2,3);
      const g2=ctx.createLinearGradient(0,-s,0,s);
      g2.addColorStop(0,hexA(col,.95)); g2.addColorStop(1,hexA(col,.55));
      ctx.fillStyle=g2; ctx.shadowColor=col; ctx.shadowBlur=m.live?20:12; ctx.fill();
      ctx.shadowBlur=0; ctx.strokeStyle='rgba(4,10,18,.9)'; ctx.lineWidth=1.3; ctx.stroke();
      ctx.beginPath(); ctx.arc(0,0,s*.34,0,7); ctx.fillStyle='rgba(5,12,20,.85)'; ctx.fill();
      if(m.live){
        const pr=16+Math.sin(t*2)*3.5;
        ctx.beginPath(); ctx.arc(0,0,pr,0,7);
        ctx.strokeStyle=hexA(col,.4); ctx.lineWidth=1.4; ctx.stroke();
      }
      ctx.restore();
    }

    if(sel||hover){
      ctx.save();
      ctx.beginPath(); ctx.arc(sx,sy, hover&&!sel?19:22, 0, 7);
      ctx.strokeStyle=hexA(col, sel?.9:.5); ctx.lineWidth=1.4;
      if(sel){ ctx.setLineDash([6,5]); ctx.lineDashOffset=-t*14; }
      ctx.stroke(); ctx.restore();
    }
    ctx.restore();

    if(!m.silent && m.name){
      // 选中/悬停的标签拿最高优先级，拥挤时优先保住它。
      const rank=(sel||hover)?0:undefined;
      pushLabel(sx, sy + (m.type==='char'?24:18), m.name, m.live?C.cyan:'#c3d6ea', m.live?'live':'name', false, rank);
      if(m.sub && (sel||hover||st.cam.s>1.5)) pushLabel(sx, sy + (m.type==='char'?39:32), m.sub, 'rgba(160,185,210,.9)','sub', false, rank);
    }
  }

  /**
   * M6-10②③：标签按优先级绘制 + 屏幕矩形碰撞避让。
   *
   * 旧实现按 push 顺序先到先得 —— 一条没有名的副标题能顶掉在场人物的名字。
   * 现在先按优先级排序（选中/悬停 > 在场 > 名称 > 副标题），挤不下就换方位、
   * 再挤不下就收纳不画；任何情况下都不移动 marker 本身。
   */
  function labelRank(l){
    if(Number.isFinite(l.rank))return l.rank;
    if(l.kind==='live')return 1;
    if(l.kind==='name')return 2;
    return 4;
  }
  function drawLabels(){
    ctx.save();
    ctx.textAlign='center'; ctx.textBaseline='top';
    const occupied=[];
    const items=st.labels.map((l,i)=>{
      const [sx,sy]= l.scr ? [l.x,l.y] : W2S(l.x,l.y);
      return {l,sx,sy,i,rank:labelRank(l)};
    }).filter(e=>e.sx>-40&&e.sx<=st.vw+40&&e.sy>-30&&e.sy<=st.vh+30)
      .sort((a,b)=>a.rank-b.rank||a.i-b.i);
    for(const {l,sx,sy} of items){
      ctx.font=(l.kind==='sub'?'400 11px ':l.kind==='live'?'600 12px ':'500 11px ')+F.sans;
      const tw=ctx.measureText(l.text).width+12, th=l.kind==='live'?20:17;
      const spot=placeLabel(occupied,sx,sy,tw,th);
      if(!spot)continue;   // 放不下就收纳：宁可少写一个字，也不挪 marker 或叠成一团
      occupied.push(spot.box);
      // 被挪开的标签用 leader 线指回自己的锚点（物理位置不变，只是文字让位）。
      if(spot.leader){
        ctx.beginPath(); ctx.moveTo(sx,sy); ctx.lineTo(spot.lx,spot.ly);
        ctx.strokeStyle=hexA(l.color,.5); ctx.lineWidth=1; ctx.stroke();
      }
      const cx=spot.box.x+spot.box.w/2;
      if(l.kind==='live'){
        ctx.font='600 11.5px '+F.sans;
        const w=ctx.measureText(l.text).width;
        ctx.beginPath();
        rrect(ctx, cx-w/2-8, spot.box.y-2, w+16, 18, 9);
        ctx.fillStyle='rgba(6,14,24,.82)'; ctx.fill();
        ctx.strokeStyle=hexA(l.color,.45); ctx.lineWidth=1; ctx.stroke();
        ctx.fillStyle=l.color;
        ctx.shadowColor=l.color; ctx.shadowBlur=10;
        ctx.fillText(l.text, cx, spot.box.y+1);
        ctx.shadowBlur=0;
      } else if(l.kind==='name'){
        ctx.font='500 11px '+F.sans;
        const w=ctx.measureText(l.text).width;
        ctx.beginPath(); rrect(ctx, cx-w/2-6, spot.box.y-1, w+12, 15, 7);
        ctx.fillStyle='rgba(5,11,20,.72)'; ctx.fill();
        ctx.fillStyle=l.color; ctx.fillText(l.text, cx, spot.box.y);
      } else {
        ctx.font='400 11px '+F.mono;
        const w=ctx.measureText(l.text).width;
        ctx.fillStyle='rgba(6,12,20,.78)';
        ctx.fillRect(cx-w/2-3, spot.box.y-1, w+6, 12);
        ctx.fillStyle=l.color; ctx.fillText(l.text, cx, spot.box.y);
      }
    }
    ctx.restore();
  }

  /* ══════════ 雷达 / 覆盖层 ══════════ */
  function radar(t){
    const hero = st.marks.find(m=>m.hero);
    let cx=st.vw/2, cy=st.vh/2;
    if(hero){ const p=W2S(hero.x,hero.y); cx=p[0]; cy=p[1]; }
    const R = Math.hypot(st.vw,st.vh)*.62;
    const a = (t*0.5)%(Math.PI*2);
    ctx.save();
    ctx.globalCompositeOperation='lighter';
    let g;
    try{
      g = ctx.createConicGradient(a, cx, cy);
      g.addColorStop(0,'rgba(67,224,255,.14)');
      g.addColorStop(.06,'rgba(67,224,255,.05)');
      g.addColorStop(.14,'rgba(67,224,255,0)');
      g.addColorStop(1,'rgba(67,224,255,0)');
    }catch(e){
      g = ctx.createRadialGradient(cx,cy,0,cx,cy,R);
      g.addColorStop(0,'rgba(67,224,255,.08)'); g.addColorStop(1,'rgba(67,224,255,0)');
    }
    ctx.beginPath();
    ctx.moveTo(cx,cy); ctx.arc(cx,cy,R,a,a+Math.PI*.5); ctx.closePath();
    ctx.fillStyle=g; ctx.fill();
    // 距离环
    ctx.globalCompositeOperation='source-over';
    [90,170,260].forEach((r,i)=>{
      ctx.beginPath(); ctx.arc(cx,cy,r,0,7);
      ctx.strokeStyle=`rgba(67,224,255,${.10-i*.025})`; ctx.lineWidth=1; ctx.stroke();
    });
    ctx.restore();
  }

  function heatLayer(){
    const pts = st.marks.filter(m=>m.type==='char'||m.type==='sig'||m.type==='evt');
    ctx.save(); ctx.globalCompositeOperation='lighter';
    pts.forEach(m=>{
      const [sx,sy]=W2S(m.x,m.y);
      const col = m.c || ({char:C.cyan,sig:C.green,evt:C.pink}[m.type]);
      const g=ctx.createRadialGradient(sx,sy,0,sx,sy,190);
      g.addColorStop(0,hexA(col,.30)); g.addColorStop(.45,hexA(col,.10)); g.addColorStop(1,hexA(col,0));
      ctx.beginPath(); ctx.arc(sx,sy,190,0,7); ctx.fillStyle=g; ctx.fill();
    });
    ctx.restore();
  }

  function flowLayer(t){
    const edges=(hooks.getFlows&&hooks.getFlows(st.node.id))||[];
    edges.forEach(edge=>drawFlow(edge,t,false));
  }

  function drawFlow(edge,t,journey){
    const [sx,sy]=W2S(...edge.from),[tx,ty]=W2S(...edge.to);
    const [mx,my]=edge.via?W2S(...edge.via):[(sx+tx)/2+(ty-sy)*.18,(sy+ty)/2-(tx-sx)*.18];
    const active=hooks.activeEdge&&hooks.activeEdge()===edge.id,col=edge.c||C.green;
    const route=edge.points?.length>1?edge.points.map(p=>W2S(...p)):null;
    const lengths=route?.slice(1).map((p,i)=>Math.hypot(p[0]-route[i][0],p[1]-route[i][1])),total=lengths?.reduce((n,x)=>n+x,0)||0;
    const at=k=>{if(!route)return [(1-k)*(1-k)*sx+2*(1-k)*k*mx+k*k*tx,(1-k)*(1-k)*sy+2*(1-k)*k*my+k*k*ty];let distance=Math.max(0,Math.min(1,k))*total;for(let i=0;i<lengths.length;i++){if(distance<=lengths[i]||i===lengths.length-1){const f=lengths[i]?distance/lengths[i]:0;return [route[i][0]+(route[i+1][0]-route[i][0])*f,route[i][1]+(route[i+1][1]-route[i][1])*f];}distance-=lengths[i];}return [sx,sy];};
    ctx.save();ctx.beginPath();ctx.moveTo(sx,sy);if(route)route.slice(1).forEach(p=>ctx.lineTo(...p));else ctx.quadraticCurveTo(mx,my,tx,ty);
    ctx.setLineDash(journey?[4,8]:[7,11]);ctx.lineDashOffset=-t*22;
    ctx.strokeStyle=hexA(col,active?.95:.55);ctx.lineWidth=active?2.8:1.7;
    ctx.shadowColor=col;ctx.shadowBlur=active?14:7;ctx.stroke();ctx.setLineDash([]);
    const positioned=!journey||Number.isFinite(edge.progress),k=journey?edge.progress:(t*.2)%1,[x,y]=at(k);
    if(positioned){ctx.beginPath();ctx.arc(x,y,journey?6:3.5,0,7);ctx.fillStyle=col;ctx.fill();}
    const [hx,hy]=at(.5);
    st.edgeHits.push({x:hx,y:hy,r:16,m:{type:journey?'journey':'message',id:edge.id,name:edge.name,sub:journey?'行程位置':'消息传播路径'}});
    if(active||journey){ctx.shadowBlur=0;ctx.font='500 11px '+F.sans;ctx.fillStyle='#dce9fb';ctx.textAlign='center';ctx.fillText(edge.name,hx,hy-13);}
    if(journey&&positioned)st.edgeHits.push({x,y,r:14,m:{type:'char',id:edge.entityId,name:edge.name}});
    ctx.restore();
  }

  function simLayer(t){
    ((hooks.getJourneys&&hooks.getJourneys(st.node.id))||[]).forEach(edge=>drawFlow(edge,t,true));
    flowLayer(t);
  }

  function edgeFade(){
    const g=ctx.createRadialGradient(st.vw/2,st.vh/2,Math.min(st.vw,st.vh)*.42,st.vw/2,st.vh/2,Math.max(st.vw,st.vh)*.78);
    g.addColorStop(0,'rgba(4,8,14,0)'); g.addColorStop(1,'rgba(4,8,14,.5)');
    ctx.fillStyle=g; ctx.fillRect(0,0,st.vw,st.vh);
  }

  /* ══════════ 小地图 ══════════ */
  function drawMini(){
    const w=mini.width/st.dpr, h=mini.height/st.dpr;
    mctx.setTransform(st.dpr,0,0,st.dpr,0,0);
    mctx.clearRect(0,0,w,h);
    mctx.fillStyle='rgba(4,9,16,.9)'; mctx.fillRect(0,0,w,h);
    const [x0,x1,y0,y1]=extent();
    const s = Math.min(w/((x1-x0)*1.06), h/((y1-y0)*1.06));
    const cx=w/2, cy=h/2;
    const T=(x,y)=>[ (x)*s+cx, (y)*s+cy ];
    mctx.save();
    // 地形轮廓
    mctx.strokeStyle='rgba(67,224,255,.35)'; mctx.lineWidth=1;
    if(st.node.host&&st.node.sceneStatus==='missing'){ /* overview has no authored terrain */ }
    else if(st.kind==='world'){ (st.geo.lands||[]).forEach(L=>{ mctx.beginPath(); L.pts.forEach((p,i)=>{const q=T(p[0],p[1]); i?mctx.lineTo(q[0],q[1]):mctx.moveTo(q[0],q[1]);}); mctx.closePath(); mctx.fillStyle='rgba(30,90,120,.35)'; mctx.fill(); mctx.stroke(); }); }
    else if(st.kind==='region'){ mctx.beginPath(); (st.geo.river||[]).forEach((p,i)=>{const q=T(p[0],p[1]); i?mctx.lineTo(q[0],q[1]):mctx.moveTo(q[0],q[1]);}); mctx.strokeStyle='rgba(67,224,255,.4)'; mctx.stroke(); }
    else if(st.kind==='city'){ (st.geo.districts||[]).forEach(d=>{ mctx.beginPath(); d.pts.forEach((p,i)=>{const q=T(p[0],p[1]); i?mctx.lineTo(q[0],q[1]):mctx.moveTo(q[0],q[1]);}); mctx.closePath(); mctx.strokeStyle=hexA(d.c,.5); mctx.stroke(); mctx.fillStyle=hexA(d.c,.10); mctx.fill(); }); }
    else if(st.kind==='district'){ (st.geo.plots||[]).forEach(p=>{ const q=T(p.r[0],p.r[1]); mctx.fillStyle='rgba(120,180,255,.22)'; mctx.fillRect(q[0],q[1],(p.r[2]-p.r[0])*s,(p.r[3]-p.r[1])*s); }); }
    else if(st.kind==='building'||st.kind==='floor'||st.kind==='room'||st.kind==='detail'){
      mctx.strokeStyle='rgba(67,224,255,.5)';
      if(st.kind==='floor'){ const c=st.geo.corridor; const q=T(c.x,c.y-c.h/2); mctx.strokeRect(q[0],q[1],c.w*s,c.h*s);
        (st.geo.rooms||[]).forEach(r=>{ const p=T(r.x,r.y); mctx.strokeRect(p[0],p[1],r.w*s,r.h*s); }); }
      else if(st.kind==='building'){ (st.geo.wings||[]).forEach(g2=>{ const p=T(g2.x-g2.w/2,g2.y-g2.h/2); mctx.strokeRect(p[0],p[1],g2.w*s,g2.h*s); }); }
      else { const W=st.geo.walls; const p=T(W.x,W.y); mctx.strokeRect(p[0],p[1],W.w*s,W.h*s);
        (st.geo.shelves||[]).forEach(sh=>{ const q=T(sh.r[0],sh.r[1]); mctx.fillStyle='rgba(255,194,71,.3)'; mctx.fillRect(q[0],q[1],(sh.r[2]-sh.r[0])*s,(sh.r[3]-sh.r[1])*s); }); }
    }
    // Overview routes and footprints use the same transform on the minimap.
    for(const shape of st.geo.overviewShapes||[]){
      mctx.beginPath();shape.pts.forEach((p,i)=>{const q=T(p[0],p[1]);i?mctx.lineTo(q[0],q[1]):mctx.moveTo(q[0],q[1]);});mctx.closePath();
      mctx.fillStyle=hexA(shape.c,.12);mctx.fill();mctx.strokeStyle=hexA(shape.c,.45);mctx.stroke();
    }
    // M6-05②：mini 用**同一份**装饰几何，只是抽掉细节（不撒点、不画阴影）。
    for(const f of st.geo.overviewFeatures||[]){
      const pts=f.line||f.poly;if(!pts||pts.length<2)continue;
      mctx.beginPath();pts.forEach((p,i)=>{const q=T(p[0],p[1]);i?mctx.lineTo(q[0],q[1]):mctx.moveTo(q[0],q[1]);});
      if(f.poly)mctx.closePath();
      if(f.type==='watercourse'){mctx.strokeStyle='rgba(90,215,255,.55)';mctx.lineWidth=1;}
      else if(f.type==='forest_texture'){mctx.fillStyle='rgba(52,150,110,.30)';mctx.fill();mctx.strokeStyle='rgba(90,220,160,.35)';mctx.lineWidth=.8;}
      else {mctx.fillStyle='rgba(120,160,210,.16)';if(f.poly)mctx.fill();mctx.strokeStyle='rgba(120,160,210,.28)';mctx.lineWidth=.8;}
      mctx.stroke();
    }
    for(const route of st.geo.overviewRoutes||[]){
      mctx.beginPath();route.points.forEach((p,i)=>{const q=T(p[0],p[1]);i?mctx.lineTo(q[0],q[1]):mctx.moveTo(q[0],q[1]);});
      mctx.strokeStyle='rgba(67,224,255,.6)';mctx.setLineDash(route.dashed?[3,2]:[]);mctx.stroke();
    }
    mctx.setLineDash([]);
    // 标记
    st.marks.forEach(m=>{ const q=T(m.x,m.y); mctx.beginPath(); mctx.arc(q[0],q[1],2.2,0,7);
      mctx.fillStyle=m.c||({char:C.cyan,item:C.amber,poi:C.violet,sig:C.green,exit:C.blue}[m.type]||C.cyan); mctx.fill(); });
    // 视口框
    const [ax,ay]=S2W(0,0), [bx,by]=S2W(st.vw,st.vh);
    const p1=T(ax,ay), p2=T(bx,by);
    mctx.strokeStyle='rgba(255,255,255,.55)'; mctx.lineWidth=1;
    mctx.setLineDash([3,3]);
    mctx.strokeRect(p1[0],p1[1],p2[0]-p1[0],p2[1]-p1[1]);
    mctx.restore();
  }

  /* ══════════ 主循环 ══════════ */
  function frame(now,once=false){
    if(st.destroyed||st.paused&&!once)return;
    const dt = once?0:Math.min(.05,(now-st.last)/1000);if(!once)st.last=now;
    if(!hooks.getMotion||hooks.getMotion())st.t += dt;
    if(!st.node){if(!once)frameId=requestAnimationFrame(frame);return;}
    // 相机缓动
    const e = 1-Math.pow(.0016, dt);
    st.cam.x = lerp(st.cam.x, st.tgt.x, e);
    st.cam.y = lerp(st.cam.y, st.tgt.y, e);
    st.cam.s = lerp(st.cam.s, st.tgt.s, e);

    ctx.setTransform(st.dpr,0,0,st.dpr,0,0);
    ctx.clearRect(0,0,st.vw,st.vh);
    st.labels=[];st.edgeHits=[];st.hits=[];

    ctx.save();
    ctx.translate(st.vw/2, st.vh/2);
    ctx.scale(st.cam.s, st.cam.s);
    ctx.translate(-st.cam.x, -st.cam.y);
    terrainWorld(st.geo, st.vw, st.vh);
    ctx.restore();

    // M6-07①：网格走**屏幕空间** —— 线宽恒为 1 物理像素，既不受缩放影响，
    // 也不会像被 CSS 放大的位图那样糊掉。
    grid();

    if(st.showMarks){
      if(st.mode==='heat') heatLayer();
      if(st.mode==='flow') flowLayer(st.t);
      if(st.mode==='sim')  simLayer(st.t);
      drawMarks(st.t);
      drawLabels();
      if(st.showRadar) radar(st.t);
      edgeFade();
    } else edgeFade();

    drawMini();
    if(hooks.onFrame) hooks.onFrame(st);
    if(!once)frameId=requestAnimationFrame(frame);
  }

  function drawGhosts(){
    const cast = (hooks.remoteCast&&hooks.remoteCast())||[];
    cast.slice(0,3).forEach((c2,i)=>{
      const x=st.vw-158, y=110+i*76;
      ctx.save();
      ctx.globalAlpha=.95;
      ctx.beginPath(); rrect(ctx,x-8,y-14,150,44,10);
      ctx.fillStyle='rgba(10,18,30,.9)'; ctx.fill();
      ctx.strokeStyle=hexA(c2.c,.55); ctx.lineWidth=1; ctx.stroke();
      ctx.beginPath(); ctx.arc(x+8,y+8,7,0,7); ctx.fillStyle=hexA(c2.c,.9); ctx.fill();
      ctx.fillStyle='#04121c'; ctx.font='700 8px '+F.sans; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(c2.initial, x+8, y+8.5);
      ctx.textAlign='left'; ctx.textBaseline='alphabetic';
      ctx.fillStyle='#dce9fb';
      ctx.font='600 11px '+F.sans;
      ctx.fillText(c2.name, x+22, y+4);
      ctx.fillStyle='rgba(140,170,200,.85)'; ctx.font='9px '+F.mono;
      ctx.fillText(c2.dist+' · '+c2.tag, x+22, y+17);
      ctx.restore();
    });
  }

  /* ══════════ 交互 ══════════ */
  function hitTest(mx,my){
    let best=null, bd=1e9;
    // M6-10①：命中用**和绘制同一个** markScreenPos（含同样的视口裁剪），
    // 保证"画出来的点点得中、点得中的一定画着"。
    const markHits=st.showMarks?visibleMarkHits():[];
    markHits.concat(st.edgeHits).forEach(h=>{
      const d=Math.hypot(h.x-mx,h.y-my);
      if(d<h.r+7 && d<bd){ bd=d; best=h.m; }
    });
    if(best)return best;
    const [wx,wy]=S2W(mx,my),g=st.geo;
    const inside=(pts)=>{let yes=false;for(let i=0,j=pts.length-1;i<pts.length;j=i++){const a=pts[i],b=pts[j];if((a[1]>wy)!==(b[1]>wy)&&wx<(b[0]-a[0])*(wy-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;};
    let target=null;
    if(st.kind==='city')target=(g.districts||[]).find(d=>inside(d.pts));
    else if(st.kind==='floor')target=(g.rooms||[]).find(r=>wx>=r.x&&wx<=r.x+r.w&&wy>=r.y&&wy<=r.y+r.h);
    else if(st.kind==='building')target=(g.wings||[]).find(r=>wx>=r.x-r.w/2&&wx<=r.x+r.w/2&&wy>=r.y-r.h/2&&wy<=r.y+r.h/2);
    else if(st.kind==='district')target=(g.buildings||[]).find(r=>wx>=r.c[0]-r.w/2&&wx<=r.c[0]+r.w/2&&wy>=r.c[1]-r.h/2&&wy<=r.c[1]+r.h/2);
    if(target){const node=findChild(target.childId||target.id);return {type:'poi',id:target.id,name:target.name,node};}
    return null;
  }
  function bind(){
    let px=0,py=0,down=false,moved=0,pinchDistance=0;
    const pointers=new Map();
    listen(canvas,'pointerdown',e=>{
      if(e.pointerType==='mouse'&&e.button!==0)return;
      pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(pointers.size===1){down=true;moved=0;px=e.clientX;py=e.clientY;}
      else {const p=[...pointers.values()];pinchDistance=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);down=false;moved=10;}
      canvas.setPointerCapture?.(e.pointerId);canvas.classList.add('grabbing');
    });
    const up=e=>{pointers.delete(e.pointerId);if(pointers.size===1){const p=[...pointers.values()][0];px=p.x;py=p.y;down=true;}else if(!pointers.size){down=false;pinchDistance=0;canvas.classList.remove('grabbing');}};
    listen(window,'pointerup',up);listen(canvas,'pointercancel',up);
    listen(canvas,'pointermove',e=>{
      const r=canvas.getBoundingClientRect();
      const mx=e.clientX-r.left, my=e.clientY-r.top;
      if(pointers.has(e.pointerId))pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(pointers.size>=2){
        const p=[...pointers.values()],dist=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);
        const cx=(p[0].x+p[1].x)/2-r.left,cy=(p[0].y+p[1].y)/2-r.top,[wx,wy]=S2W(cx,cy);
        if(pinchDistance>0){st.tgt.s=clamp(st.cam.s*dist/pinchDistance,fitScale()*.28,fitScale()*9);st.tgt.x=wx-(cx-st.vw/2)/st.tgt.s;st.tgt.y=wy-(cy-st.vh/2)/st.tgt.s;st.cam={...st.tgt};}
        pinchDistance=dist;return;
      }
      if(down){
        const dx=e.clientX-px, dy=e.clientY-py; moved+=Math.abs(dx)+Math.abs(dy);
        st.tgt.x -= dx/st.cam.s; st.tgt.y -= dy/st.cam.s;
        st.cam.x -= dx/st.cam.s; st.cam.y -= dy/st.cam.s;
        px=e.clientX; py=e.clientY; return;
      }
      const m=hitTest(mx,my);
      st.hover = m;
      canvas.style.cursor = m ? 'pointer' : 'grab';
      if(hooks.onHover) hooks.onHover(m, e.clientX, e.clientY);
      if(hooks.onFrame) hooks.onFrame(st);
    });
    listen(canvas,'pointerleave',()=>{ st.hover=null; if(hooks.onHover) hooks.onHover(null); });
    listen(canvas,'click',e=>{
      if(moved>5) return;
      const r=canvas.getBoundingClientRect();
      const m=hitTest(e.clientX-r.left, e.clientY-r.top);
      st.sel = m;
      if(hooks.onSelect) hooks.onSelect(m);
    });
    listen(canvas,'wheel',e=>{
      e.preventDefault();
      const r=canvas.getBoundingClientRect();
      const mx=e.clientX-r.left, my=e.clientY-r.top;
      const [wx,wy]=S2W(mx,my);
      const f = Math.exp(-e.deltaY*0.0012);
      st.tgt.s = clamp(st.tgt.s*f, fitScale()*0.28, fitScale()*9);
      const ns = st.tgt.s;
      st.tgt.x = wx - (mx-st.vw/2)/ns;
      st.tgt.y = wy - (my-st.vh/2)/ns;
    },{passive:false});
    // 小地图点击
    listen(mini,'click',e=>{
      const r=mini.getBoundingClientRect();
      const w=mini.width,h=mini.height;
      const [x0,x1,y0,y1]=extent();
      const s=Math.min(w/((x1-x0)*1.06), h/((y1-y0)*1.06));
      const wx=((e.clientX-r.left)/r.width*w - w/2)/s;
      const wy=((e.clientY-r.top)/r.height*h - h/2)/s;
      st.tgt.x=wx; st.tgt.y=wy;
    });
  }

  let onEnter=null;
  function setEnterHandler(fn){ onEnter=fn; }

  /* ══════════ 公开 API ══════════ */
  function zoomBy(f){
    st.tgt.s = clamp(st.tgt.s*f, fitScale()*0.28, fitScale()*9);
  }
  function locate(){
    const hero=st.marks.find(m=>m.hero);
    if(!hero) return;
    st.tgt.x=hero.x; st.tgt.y=hero.y; st.tgt.s=fitScale()*2.2;
  }
  function selectKey(key){
    st.sel = st.marks.find(m=>m.key===key)||null;
    return !!st.sel;
  }
  function focusKey(key){
    if(!selectKey(key))return false;
    st.tgt.x=st.sel.x;st.tgt.y=st.sel.y;
    st.tgt.s=Math.max(st.tgt.s,fitScale()*1.5);return true;
  }
  function setPaused(paused){
    st.paused=!!paused;cancelAnimationFrame(frameId);
    if(st.paused&&st.node&&!st.destroyed)frame(performance.now(),true);
    if(!st.paused&&!st.destroyed){st.last=performance.now();frameId=requestAnimationFrame(frame);}
  }
  function destroy(){
    st.destroyed=true;cancelAnimationFrame(frameId);listeners.splice(0).forEach(fn=>fn());
  }
  function refreshMarks(){
    st.marks = collectMarks().map((m,i)=>Object.assign(m,{ key: m.id || (m.name||'')+'_'+i }));
  }

  function boot(){
    resize();
    bind();
    refreshMarks();
    frameId=requestAnimationFrame(t=>{st.last=t;frameId=requestAnimationFrame(frame);});
  }

  return {
    state:st, boot, resize, fit, setPath, zoomBy, locate, selectKey, focusKey, refreshMarks, setPaused, destroy,
    setEnterHandler,
    get marks(){ return st.marks; },
    setMode(m){ st.mode=m; },
    setFlag(k,v){ st[k]=v; },
    setFilter(set){ st.filter=set; },
    heroScreen(){ const h=st.marks.find(m=>m.hero); return h?W2S(h.x,h.y):[st.vw/2,st.vh/2]; },
    /**
     * M6-07②：比例尺的**屏幕依据**只在这里回答"这一屏 1 UI 单位有多少 CSS 像素、
     * 以及这个尺度可不可信"。
     *
     * 为什么公式不写在这里：`SCALE_WIDTH_PX=74` 与
     * `distance = 74 / cssPixelsPerUnit × metersPerUnit` 是 ui-model.js 的唯一权威
     * （纯函数、可单测）。在 map.js 再抄一遍 74 等于埋第二份会走样的常量。
     * 这里只提供它算不出来的部分：相机尺度与尺度质量。
     */
    scaleQuality(){
      const camS=st.cam.s, metric=st.node?.metric;
      const calibrated=Number.isFinite(metric)&&metric>0;
      const quality=st.node?.transform?.metricQuality??st.node?.transform?.scaleQuality??null;
      // 未标定 → 报「格」；已标定但质量不是 confirmed → 是"约"出来的数字。
      return {calibrated,quality,estimated:!calibrated||(quality!==null&&quality!=='confirmed'),
        // 格制场景：1 UI 单位 = 1/transform.scale 格，折算成格的相机尺度要再乘一次。
        cssPixelsPerUnit:Number.isFinite(camS)&&camS>0?camS*(calibrated?1:(st.node?.transform?.scale||1)):null,
        metersPerUnit:calibrated?metric:null};
    },
    fitScale, extent
  };
}
return { create, C };
})();
