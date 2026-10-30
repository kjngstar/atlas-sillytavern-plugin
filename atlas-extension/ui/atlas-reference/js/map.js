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
  const n = pts.length;
  const at = i => pts[closed ? (i+n)%n : clamp(i,0,n-1)];
  ctx.moveTo(pts[0][0],pts[0][1]);
  // 每段从当前点走到下一点；闭合段也用环绕邻点，避免漏点和直线接缝。
  for(let i=0;i<(closed?n:n-1);i++){
    const p0=at(i-1),p1=at(i),p2=at(i+1),p3=at(i+2);
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
const PAINTER_REGISTRY=Object.freeze(Object.fromEntries([
 ['road','#806443','#806443','#72b3dd','#72b3dd'],['water','#4e8290','#98bac0','#70c7e5','#193f55'],['buildingOutline','#806f55','#cfbd97','#93bbdb','#193249'],['floorWall','#776750','#d7c7a7','#a9d0eb','#20394b'],['furniture','#806f55','#bbaa8a','#b1cbe0','#29485b']
].map(([key,stroke,fill,technicalStroke,technicalFill])=>[key,Object.freeze({original:Object.freeze({stroke:null,fill:null,join:'round'}),ink:Object.freeze({stroke,fill,join:'round'}),technical:Object.freeze({stroke:technicalStroke,fill:technicalFill,join:'miter'})})])));
function layerPaint(style,layer){const pen=PAINTER_REGISTRY[layer]?.[style?.painters?.[layer]||'original'];return {stroke:style?.palette?.[layer+'.stroke']||pen?.stroke,fill:style?.palette?.[layer+'.fill']||pen?.fill,join:pen?.join||'round'};}
function paintSemantic(ctx,layer,shape,style){if(!style)return false;const pen=layerPaint(style,layer);if(!pen.stroke&&!pen.fill)return false;ctx.save();ctx.lineJoin=pen.join;ctx.lineCap=pen.join==='miter'?'butt':'round';ctx.shadowBlur=0;if(shape.fill){ctx.fillStyle=pen.fill||shape.fillColor;ctx.globalAlpha=shape.opacity??.18;ctx.fill();ctx.globalAlpha=1;}ctx.strokeStyle=pen.stroke||shape.stroke;ctx.lineWidth=(shape.width||1.4)/(shape.scale||1);ctx.setLineDash(shape.dashed?[5/(shape.scale||1),4/(shape.scale||1)]:[]);ctx.stroke();ctx.restore();return true;}
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
function paintGrid(ctx, {cam, vw, vh, dpr, step, maxLines, color}){
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
    ctx.strokeStyle=color?'rgba('+[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)).join(',')+','+(major?.20:.075)+')':major?'rgba(110,190,255,.20)':'rgba(110,190,255,.075)';
    const px=align(sx(x));
    ctx.beginPath(); ctx.moveTo(px,0); ctx.lineTo(px,vh); ctx.stroke();
  }
  for(let y=Math.floor(y0/step)*step; y<=y1 && count<limit; y+=step, count++){
    const major=Math.abs(Math.round(y/step))%5===0;
    ctx.strokeStyle=color?'rgba('+[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)).join(',')+','+(major?.20:.075)+')':major?'rgba(110,190,255,.20)':'rgba(110,190,255,.075)';
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
  /**
   * 六个方位必须是**两两不相交**的矩形，否则「换方位」等于白换：
   * 旧写法左右两档只离锚点 gap 像素，标签一宽就压在首选位上，
   * 六个候选实际只剩两个可用 —— 标签被过早收纳，看图的人少了一半地名。
   * 现在按「三列（左/中/右）× 两行（锚点下方/上方）」铺开，
   * 相邻标签盒之间恒定留 gap，六个方位在任何标签宽度下都互不遮挡。
   */
  const mid=ax-tw/2, right=ax+tw/2+gap, left=ax-tw/2-gap-tw;
  return [
    [mid, ay],                                  // 首选：正中 · 锚点正下方
    [right, ay],                                // 右
    [left, ay],                                 // 左
    [mid, ay-th-gap],                           // 上（正中）
    [right, ay-th-gap],                         // 右上
    [left, ay-th-gap],                          // 左上
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
  let frameId=0,canvasStyle=null,acceptedSkin=null,texturePattern=null;
  function setSkin(value){
    if(value!==null){
      const keys=['background','gridColor','labelColor','labelBackground','markerShape','markerColors','markerImages','painters','palette','texture','textureOpacity','backdrop','backdropOpacity'];
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw Error('MAP_SKIN_INVALID');
      for(const key of ['background','gridColor','labelColor','labelBackground'])if(value[key]!=null&&!/^#[0-9a-f]{6}$/i.test(value[key]))throw Error('MAP_SKIN_COLOR_INVALID');
      for(const color of [...Object.values(value.markerColors||{}),...Object.values(value.palette||{})])if(!/^#[0-9a-f]{6}$/i.test(color))throw Error('MAP_SKIN_COLOR_INVALID');
      if(!['classic','seal'].includes(value.markerShape||'classic')||Object.entries(value.painters||{}).some(([k,v])=>k==='markers'?!['classic','seal'].includes(v):!PAINTER_REGISTRY[k]?.[v]))throw Error('MAP_SKIN_PAINTER_INVALID');
      if(value.textureOpacity!==undefined&&(!Number.isFinite(value.textureOpacity)||value.textureOpacity<0||value.textureOpacity>.3))throw Error('MAP_SKIN_OPACITY_INVALID');
      if(value.backdropOpacity!==undefined&&(!Number.isFinite(value.backdropOpacity)||value.backdropOpacity<0||value.backdropOpacity>.5))throw Error('MAP_SKIN_OPACITY_INVALID');
      if(value.backdrop&&(!Number.isFinite(value.backdrop.width)||!Number.isFinite(value.backdrop.height)||value.backdrop.width<=0||value.backdrop.height<=0))throw Error('MAP_SKIN_IMAGE_INVALID');
    }
    const pattern=value?.texture?ctx.createPattern(value.texture,'repeat'):null;
    const original=!value||!value.background&&!value.gridColor&&!value.labelColor&&!value.labelBackground&&(value.markerShape||'classic')==='classic'&&!Object.keys(value.markerColors||{}).length&&!Object.keys(value.markerImages||{}).length&&!Object.keys(value.palette||{}).length&&!value.texture&&!value.backdrop&&Object.entries(value.painters||{}).every(([k,v])=>v===(k==='markers'?'classic':'original'));
    acceptedSkin=value;canvasStyle=original?null:{...value,markerColors:{...value.markerColors},markerImages:{...value.markerImages},painters:{...value.painters},palette:{...value.palette}};texturePattern=pattern;return true;
  }
  function skinColor(layer,part,fallback){
    if(!canvasStyle)return fallback;
    const color=layerPaint(canvasStyle,layer)[part];if(!color)return fallback;
    const alpha=typeof fallback==='string'?fallback.match(/rgba\([^)]*,\s*([\d.]+)\)$/)?.[1]:null;
    // Ink on light paper needs visible strokes; retain the ordering between
    // estimated and confirmed alpha, and leave their dash patterns untouched.
    if(alpha){const a=Number(alpha),ink=part==='stroke'&&canvasStyle.painters?.[layer]==='ink';return hexA(color,ink&&a>0?.35+.65*a:a);}
    return part==='fill'?hexA(color,.18):color;
  }

  const listeners=[];
  function listen(target,type,handler,opts){target.addEventListener(type,handler,opts);listeners.push(()=>target.removeEventListener(type,handler,opts));}

  /* ── 尺寸 ── */
  function resize(){
    const previousFit=st.node?fitScale():null;
    const oldWidth=st.vw,oldHeight=st.vh;
    const r = canvas.parentElement.getBoundingClientRect();
    if(r.width<=0||r.height<=0)return {ok:true,deferred:true};
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
  /**
   * P14/§21.3：**内容范围只用于取景**。
   *
   * 旧实现里非 floor 的图一律按整幅幅面取景 —— 一个只有一座庭院的 overview
   * 因此被画成整张图正中的一个小点（N01 报的「看起来只有一个点」）。
   * 这里改成：优先用**已经过 POV 过滤的** shapes / 路线 / 装饰 / 自身示意 / 标记
   * 的联合范围取景，并且：
   *  - 只有一个点（或极窄）时给**最小可读视窗**，不把镜头推到无限近；
   *  - 内容比整幅幅面还大时不缩小视野（世界幅面本身不动）；
   *  - 只动相机：extent、比例尺、SQL 坐标、实体坐标一律不变。
   * 楼层沿用房间几何，见 fitExtent 里的 floor 分支。
   */
  const CONTENT_MIN_SPAN = 140;
  function contentExtent(){
    const g=st.geo||{};
    if(st.kind==='floor')return null;
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    const put=(x,y)=>{if(!Number.isFinite(x)||!Number.isFinite(y))return;if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;};
    const pts=list=>{if(Array.isArray(list))for(const p of list)if(Array.isArray(p))put(p[0],p[1]);};
    const box=(x,y,w,h)=>{if([x,y,w,h].every(Number.isFinite)){put(x,y);put(x+w,y+h);}};
    for(const s of g.overviewShapes||[])pts(s&&s.pts);
    for(const r of g.overviewRoutes||[])pts(r&&(r.points||r.path));
    for(const r of g.corridorRoutes||[])pts(r.points);
    for(const f of g.overviewFeatures||[]){pts(f&&f.poly);pts(f&&f.line);}
    pts(g.bridgeSymbol?.deck);pts(g.bridgeSymbol?.river?.points);
    pts(g.selfArea&&g.selfArea.pts);
    for(const d of g.districts||[])pts(d&&d.pts);
    for(const L of g.lands||[])pts(L&&L.pts);
    for(const p of g.plots||[]){const r=p&&p.r;if(Array.isArray(r))put(r[0],r[1]),put(r[2],r[3]);}
    for(const b of g.buildings||[]){if(b&&Array.isArray(b.c))box(b.c[0]-b.w/2,b.c[1]-b.h/2,b.w,b.h);}
    for(const w of g.wings||[])box(w&&w.x-w.w/2,w&&w.y-w.h/2,w&&w.w,w&&w.h);
    for(const r of g.rooms||[])box(r&&r.x,r&&r.y,r&&r.w,r&&r.h);
    if(g.corridor)box(g.corridor.x,g.corridor.y,g.corridor.w,g.corridor.h);
    pts(g.river);
    if(st.showMarks!==false)for(const m of st.node?.marks||[])put(m&&m.x,m&&m.y);
    if(!Number.isFinite(x0)||!Number.isFinite(y0))return null;
    const [ex0,ex1,ey0,ey1]=extent();
    const cx=(x0+x1)/2,cy=(y0+y1)/2;
    if(!(x1-x0>0)){x0=cx-CONTENT_MIN_SPAN/2;x1=cx+CONTENT_MIN_SPAN/2;}
    if(!(y1-y0>0)){y0=cy-CONTENT_MIN_SPAN/2;y1=cy+CONTENT_MIN_SPAN/2;}
    if(x1-x0<CONTENT_MIN_SPAN){x0=cx-CONTENT_MIN_SPAN/2;x1=cx+CONTENT_MIN_SPAN/2;}
    if(y1-y0<CONTENT_MIN_SPAN){y0=cy-CONTENT_MIN_SPAN/2;y1=cy+CONTENT_MIN_SPAN/2;}
    if(x1-x0>ex1-ex0||y1-y0>ey1-ey0)return null;
    return [x0,x1,y0,y1];
  }
  function fitExtent(){
    if(st.geo.exploration)return st.geo.exploration.bounds;
    const host=st.geo.hostArea;
    if(host&&[host.x,host.y,host.w,host.h].every(Number.isFinite)&&host.w>0&&host.h>0)return [host.x,host.x+host.w,host.y,host.y+host.h];
    // Fit any standalone room to its actual geometry, without changing map units.
    const rooms=st.geo.rooms;
    if(st.kind==='floor'&&rooms?.length===1&&st.geo.corridor?.h===0){
      const r=rooms[0];
      if([r.x,r.y,r.w,r.h].every(Number.isFinite)&&r.w>0&&r.h>0)return [r.x,r.x+r.w,r.y,r.y+r.h];
    }
    if(st.kind==='floor'&&st.node?.host&&rooms?.length>1){
      const valid=rooms.filter(r=>[r.x,r.y,r.w,r.h].every(Number.isFinite)&&r.w>0&&r.h>0);
      if(valid.length){
        const candidate=st.geo.corridor,c=candidate&&[candidate.x,candidate.w,candidate.h].every(Number.isFinite)&&candidate.w>0&&candidate.h>0?candidate:null;
        const x0=Math.min(...valid.map(r=>r.x),c?.x??Infinity),x1=Math.max(...valid.map(r=>r.x+r.w),c?c.x+c.w:-Infinity);
        return [x0-24,x1+12,Math.min(...valid.map(r=>r.y))-72,Math.max(...valid.map(r=>r.y+r.h))+60];
      }
    }
    const content=contentExtent();
    if(content)return content;
    return extent();
  }
  function fitPad(){ return contentExtent()?1.12:1.16; }
  function compactOverviewScale(base){
    const g=st.geo||{};
    if(g.exploration)return base;
    if(!st.node?.host||!['world','region'].includes(st.kind)||g.parentContext||g.selfArea)return base;
    if(!contentExtent())return base; // Out-of-frame outliers must not redefine this map's view.
    // Detailed terrain needs its full geographic view, even with few POIs.
    if((g.overviewFeatures||[]).some(f=>f.type!=='road_texture'))return base;
    const places=[],seen=new Set();
    for(const m of st.node.marks||[]){
      if(m.type!=='poi'||m.silent||m.proxy||!Number.isFinite(m.x)||!Number.isFinite(m.y))continue;
      const key=m.id??`${m.x},${m.y}`;
      if(!seen.has(key)){seen.add(key);places.push(m);}
    }
    if(places.length<2||places.length>4)return base;
    const [x0,x1,y0,y1]=fitExtent(),area=(x1-x0)*(y1-y0);
    let occupied=0;
    for(const shape of g.overviewShapes||[]){
      const pts=(shape.pts||[]).filter(p=>Array.isArray(p)&&Number.isFinite(p[0])&&Number.isFinite(p[1]));
      if(pts.length)occupied+=(Math.max(...pts.map(p=>p[0]))-Math.min(...pts.map(p=>p[0])))*(Math.max(...pts.map(p=>p[1]))-Math.min(...pts.map(p=>p[1])));
    }
    if(!(area>0)||occupied/area>=.45)return base;
    let spread=0;
    for(let i=0;i<places.length;i++)for(let j=0;j<i;j++)spread=Math.max(spread,Math.hypot(places[i].x-places[j].x,places[i].y-places[j].y));
    const screenSpan=Math.min(220,Math.min(st.vw,st.vh)*.42);
    return spread>0&&screenSpan>0?Math.min(base,screenSpan/spread):base;
  }
  function fitScale(pad){
    const [x0,x1,y0,y1] = fitExtent();
    pad = pad==null?fitPad():pad;
    return compactOverviewScale(Math.min(st.vw/((x1-x0)*pad), st.vh/((y1-y0)*pad)));
  }
  function fit(anim){
    const s = fitScale();
    const [x0,x1,y0,y1]=fitExtent(),x=(x0+x1)/2,y=(y0+y1)/2;
    st.tgt.s = s; st.tgt.x = x; st.tgt.y = y;
    if(!anim){ st.cam.s=s; st.cam.x=x; st.cam.y=y; }
  }
  function W2S(x,y){ return [ (x-st.cam.x)*st.cam.s + st.vw/2, (y-st.cam.y)*st.cam.s + st.vh/2 ]; }
  function S2W(x,y){ return [ (x-st.vw/2)/st.cam.s + st.cam.x, (y-st.vh/2)/st.cam.s + st.cam.y ]; }

  /* ── 层级切换 ── */
  function setPath(node, path){
    st.node = node; st.path = path||[]; st.kind = node.renderKind || node.kind || 'world';
    st.geo = node.geo || {}; st.sel = null; st.hover = null;st.hits=[];st.edgeHits=[];st.entryHints=[];
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
    // Paper is a viewport layer, not a finite world rectangle. Cover physical
    // edge pixels too when fractional CSS sizes are rounded to the DPR bitmap.
    const screenBackdrop=!!(canvasStyle?.background||texturePattern||canvasStyle?.backdrop);
    const [bx,by,bw,bh]=screenBackdrop?[0,0,Math.ceil(w*st.dpr)/st.dpr,Math.ceil(h*st.dpr)/st.dpr]:[x0-200,y0-200,(x1-x0)+400,(y1-y0)+400];
    ctx.save();
    if(screenBackdrop){ctx.setTransform(st.dpr,0,0,st.dpr,0,0);ctx.globalAlpha=1;}
    ctx.fillStyle = canvasStyle?.background||bg; ctx.fillRect(bx,by,bw,bh);
    if(texturePattern){ctx.save();ctx.globalAlpha=canvasStyle.textureOpacity??.12;ctx.fillStyle=texturePattern;ctx.fillRect(bx,by,bw,bh);ctx.restore();}
    // Decorative paper art is pinned to the viewport, below all world geometry.
    // It never supplies terrain, locations, hit targets or knowledge.
    if(canvasStyle?.backdrop){
      const image=canvasStyle.backdrop,vw=bw,vh=bh,scale=Math.max(vw/image.width,vh/image.height);
      const sw=vw/scale,sh=vh/scale;
      ctx.save();ctx.globalAlpha=canvasStyle.backdropOpacity??.16;
      ctx.drawImage(image,(image.width-sw)/2,(image.height-sh)/2,sw,sh,bx,by,vw,vh);ctx.restore();
    }
    ctx.restore();

    ctx.save();
    if(g.exploration) explorationMap(g.exploration);
    else if(st.node.host&&st.node.sceneStatus!=='ready') overviewMap(g);
    else if(g.overviewShapes||g.overviewRoutes) overviewMap(g);
    else if(st.kind==='world') worldMap(g);
    else if(st.kind==='region')regionMap(g);
    else if(st.kind==='city')  cityMap(g);
    else if(st.kind==='district')districtMap(g);
    else if(st.kind==='building')buildingMap(g);
    else if(st.kind==='floor') floorMap(g);
    else                       roomMap(g);
    if(g.bridgeSymbol&&!g.exploration){drawBridgeSymbol(g.bridgeSymbol);pushLabel(...g.bridgeSymbol.center,'桥面示意',canvasStyle?.labelColor||'#a7c5d7','area',true);}
    for(const route of g.corridorRoutes??[]){ctx.beginPath();route.points.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.strokeStyle=skinColor('road','stroke','rgba(127,212,255,.5)');ctx.lineWidth=1.2/st.cam.s;ctx.setLineDash([6/st.cam.s,4/st.cam.s]);ctx.stroke();ctx.setLineDash([]);}
    ctx.restore();
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
  function drawBridgeSymbol(bridge){
    const cam=st.cam.s,ink=canvasStyle?.labelColor||'#a7c5d7';
    const trace=pts=>{ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));};
    ctx.save();ctx.lineJoin='round';ctx.lineCap='round';
    if(bridge.river){
      trace(bridge.river.points);ctx.strokeStyle=skinColor('water','stroke','rgba(75,151,183,.28)');ctx.lineWidth=bridge.river.width;ctx.stroke();
      ctx.lineWidth=1/cam;ctx.strokeStyle=skinColor('water','stroke','rgba(75,133,157,.7)');
      for(const bank of bridge.river.banks){trace(bank);ctx.stroke();}
    }
    trace(bridge.deck);ctx.closePath();ctx.fillStyle=canvasStyle?.background||'#0c1823';ctx.fill();
    ctx.strokeStyle=hexA(ink,.9);ctx.lineWidth=1.8/cam;ctx.stroke();
    const c=bridge.center,n=bridge.across,t=bridge.along;
    ctx.strokeStyle=hexA(ink,.3);ctx.lineWidth=.8/cam;
    for(let i=-bridge.half+14;i<bridge.half-8;i+=14){ctx.beginPath();ctx.moveTo(c[0]+n[0]*i-t[0]*bridge.halfWidth,c[1]+n[1]*i-t[1]*bridge.halfWidth);ctx.lineTo(c[0]+n[0]*i+t[0]*bridge.halfWidth,c[1]+n[1]*i+t[1]*bridge.halfWidth);ctx.stroke();}
    ctx.restore();
  }

  function explorationMap(sketch){
    const cam=st.cam.s,ink=canvasStyle?.labelColor||'#a7c5d7';
    const trace=pts=>{ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));};
    ctx.save();ctx.lineJoin='round';ctx.lineCap='round';
    // The context is an open map extent, never a joined hall/corridor outline.
    for(const outline of sketch.surface?.outlines??[]){
      trace(outline);ctx.closePath();ctx.fillStyle=hexA(ink,.045);ctx.fill();
      ctx.strokeStyle=hexA(ink,.18);ctx.lineWidth=1/cam;ctx.setLineDash([2/cam,7/cam]);ctx.stroke();ctx.setLineDash([]);
    }
    for(const e of sketch.passages){
      trace(e.points);ctx.strokeStyle=hexA(ink,.4);ctx.lineWidth=1/cam;ctx.setLineDash([4/cam,5/cam]);ctx.stroke();ctx.setLineDash([]);
      if(e.status==='blocked'||e.status==='closed'){const p=e.points[1];ctx.beginPath();ctx.moveTo(p[0]-5/cam,p[1]-5/cam);ctx.lineTo(p[0]+5/cam,p[1]+5/cam);ctx.moveTo(p[0]+5/cam,p[1]-5/cam);ctx.lineTo(p[0]-5/cam,p[1]+5/cam);ctx.stroke();}
    }
    for(const a of sketch.areas){
      const active=st.hover?.id===a.id||st.sel?.id===a.id;
      ctx.save();ctx.translate(a.x,a.y);
      if(sketch.level==='regions'&&!a.mobile){
        for(const poly of a.parts){
          trace(poly);ctx.closePath();ctx.fillStyle=hexA(a.c,active?.47:.29);ctx.fill();
          ctx.strokeStyle=hexA(a.c,active?1:.8);ctx.lineWidth=(active?2.3:1.5)/cam;
          ctx.setLineDash(a.exact?[]:[7/cam,3/cam]);ctx.stroke();ctx.setLineDash([]);
        }
      }
      else if(a.external){
        ctx.strokeStyle=hexA(ink,active?1:.75);ctx.lineWidth=2/cam;
        ctx.beginPath();ctx.moveTo(0,-13);ctx.lineTo(0,13);ctx.stroke();
        ctx.beginPath();ctx.moveTo(-7,-5);ctx.lineTo(-13,0);ctx.lineTo(-7,5);ctx.stroke();
      }
      else if(a.symbol==='bridge')drawBridgeSymbol(a.bridge);
      else if(a.mobile){
        ctx.strokeStyle=hexA(ink,.8);ctx.lineWidth=1.3/cam;ctx.beginPath();ctx.moveTo(-15,0);ctx.lineTo(-9,8);ctx.lineTo(9,8);ctx.lineTo(15,0);ctx.closePath();ctx.stroke();
        ctx.strokeRect(-8,-8,16,8);
      }
      else if(a.recorded){
        for(const poly of a.parts){
          trace(poly);ctx.closePath();ctx.fillStyle=hexA(a.c,.13);ctx.fill();
          ctx.strokeStyle=hexA(ink,active?1:.8);ctx.lineWidth=(active?2:1.4)/cam;ctx.stroke();
          ctx.save();ctx.clip();ctx.strokeStyle=hexA(ink,.17);ctx.lineWidth=7/cam;ctx.stroke();ctx.restore();
        }
        // The saved child map supplies the entrances, so the overview reads as
        // a building on the shared site instead of a sealed floating tile.
        for(const d of a.entrances??[]){
          const vertical=['east','west'].includes(d.wall),dx=vertical?0:d.w/2,dy=vertical?d.w/2:0;
          ctx.beginPath();ctx.moveTo(d.x-dx,d.y-dy);ctx.lineTo(d.x+dx,d.y+dy);ctx.strokeStyle=canvasStyle?.background||'#0c1823';ctx.lineWidth=7/cam;ctx.stroke();
          ctx.strokeStyle=hexA(ink,.55);ctx.lineWidth=1/cam;ctx.beginPath();ctx.moveTo(d.x-dx,d.y-dy);ctx.lineTo(d.x-dx+(vertical?8:0),d.y-dy+(vertical?0:8));ctx.moveTo(d.x+dx,d.y+dy);ctx.lineTo(d.x+dx+(vertical?8:0),d.y+dy+(vertical?0:8));ctx.stroke();
        }
        for(const f of a.details??[]){const [x,y,x1,y1]=f.r;drawFurn(f,x,y,x1-x,y1-y,'127,168,182');}
      } else {
        // Unknown geometry stays open to the same field. Do not fabricate the
        // old cross-shaped room or draw a separate parcel around the name.
        for(const poly of a.parts){trace(poly);ctx.closePath();ctx.fillStyle=hexA(a.c,.09);ctx.fill();}
        const p=a.parts.flat(),x0=Math.min(...p.map(p=>p[0])),x1=Math.max(...p.map(p=>p[0])),y0=Math.min(...p.map(p=>p[1]));
        ctx.strokeStyle=hexA(ink,active?.8:.35);ctx.lineWidth=1/cam;ctx.setLineDash([3/cam,5/cam]);
        ctx.beginPath();ctx.moveTo(x0,y0+16);ctx.lineTo(x0,y0);ctx.lineTo(x1,y0);ctx.lineTo(x1,y0+16);ctx.stroke();ctx.setLineDash([]);
      }
      ctx.restore();
      const maxY=Math.max(...a.parts.flat().map(p=>p[1]));
      const largest=a.parts.reduce((best,p)=>{const size=p=>Math.abs(p.reduce((sum,q,i)=>{const r=p[(i+1)%p.length];return sum+q[0]*r[1]-r[0]*q[1];},0));return size(p)>size(best)?p:best;},a.parts[0]);
      const center=a.label??[largest.reduce((s,p)=>s+p[0],0)/largest.length,largest.reduce((s,p)=>s+p[1],0)/largest.length];
      if(st.showLabels)pushLabel(a.x+(a.external?0:center[0]),a.y+(a.external||a.mobile||a.symbol==='bridge'?maxY+14/cam:center[1]-6/cam),(a.external?'往 ':'')+a.name,ink,'area',true,undefined,{nodeId:a.nodeId,name:a.name});
      if(st.showLabels&&sketch.level==='regions'&&a.childCount)pushLabel(a.x+center[0],a.y+center[1]+20/cam,a.childCount+' 处下属地点',ink,'sub',true);
    }
    ctx.restore();
  }

  function overviewMap(g){
    const r=worldViewRect(st.cam,st.vw,st.vh,1.12), cam=st.cam.s;
    // 建成区 role 是 schema 枚举；没声明 role 就不加质感，不猜这块地是不是城市。
    const BUILT_ROLES = {city:1,settlement:1,district:1,campus:1};
    ctx.save();
    // ⓪ P06/N01：容器自身范围示意（只在空场地出现）。
    // 它不是新地点、也不能被当成实测：confirmed 才画实线，layout 一律虚线并标「范围示意」。
    // 单位提示交给比例尺（未标定走格制），这里不把格制示意说成米制实测。
    if(g.selfArea&&Array.isArray(g.selfArea.pts)&&g.selfArea.pts.length>=3){
      const sa=g.selfArea, confirmed=sa.quality==='confirmed';
      ctx.beginPath();sa.pts.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.closePath();
      ctx.fillStyle=confirmed?'rgba(67,224,255,.07)':'rgba(127,212,255,.05)';ctx.fill();
      ctx.strokeStyle=confirmed?'rgba(67,224,255,.60)':'rgba(127,212,255,.42)';
      ctx.lineWidth=1.3/cam;ctx.setLineDash(confirmed?[]:[7/cam,5/cam]);ctx.stroke();ctx.setLineDash([]);
      // 当前场所的名字已在标题栏；边界内留给实际地形、子地点和通行关系。
    }
    // ② zone 填色
    for(const shape of g.overviewShapes||[]){
      if(!ptsVisible(shape.pts,r)) continue;
      ctx.beginPath();shape.pts.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.closePath();
      ctx.fillStyle=skinColor('buildingOutline','fill',hexA(shape.c,.10));ctx.fill();
      ctx.strokeStyle=skinColor('buildingOutline','stroke',hexA(shape.c,shape.proxy?.36:.48));ctx.lineWidth=1/cam;
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
      ctx.strokeStyle=skinColor('road','stroke',route.dashed?'rgba(127,212,255,.42)':'rgba(67,224,255,.7)');
      ctx.lineWidth=(route.dashed?1.1:1.5)/cam;
      ctx.setLineDash(route.dashed?[6/cam,4/cam]:[]);ctx.stroke();
      if(route.name&&st.showLabels){const a=route.points[0],b=route.points.at(-1);pushLabel((a[0]+b[0])/2,(a[1]+b[1])/2-12/cam,route.name+' · 连接示意','#a6b9cc','sub',true);}
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
        ctx.lineWidth=w*1.9;ctx.strokeStyle=skinColor('water','stroke','rgba(24,96,150,.30)');ctx.stroke();
        ctx.lineWidth=w;ctx.strokeStyle=skinColor('water','stroke','rgba(90,215,255,.55)');
        ctx.shadowColor='rgba(67,224,255,.55)';ctx.shadowBlur=canvasStyle?0:10/cam;ctx.stroke();
        break;
      }
      case 'shore':{
        path(line||poly);ctx.lineCap='round';
        ctx.lineWidth=Math.max(f.width||0,1.6/cam);
        ctx.setLineDash([9/cam,6/cam]);ctx.strokeStyle='rgba(255,214,150,.32)';ctx.stroke();
        break;
      }
      case 'road_texture':{
        // Old snapshots contain an arbitrary map-wide curve. Never render that
        // legacy path as geography; new textures are clipped to a known zone.
        if(!poly)break;
        path(poly);ctx.clip();const b=poly.reduce((b,p)=>[Math.min(b[0],p[0]),Math.max(b[1],p[0]),Math.min(b[2],p[1]),Math.max(b[3],p[1])],[Infinity,-Infinity,Infinity,-Infinity]);
        ctx.strokeStyle='rgba(200,220,240,.12)';ctx.lineWidth=.7/cam;
        for(let y=b[2];y<=b[3];y+=12/cam){ctx.beginPath();ctx.moveTo(b[0],y);ctx.lineTo(b[1],y);ctx.stroke();}
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
    ctx.strokeStyle=skinColor('road','stroke','rgba(155,107,255,.45)'); ctx.lineWidth=1.5/st.cam.s;
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
      ctx.fillStyle=skinColor('water','fill','rgba(30,130,180,.4)'); ctx.fill();
      ctx.strokeStyle=skinColor('water','stroke','rgba(90,225,255,.5)'); ctx.lineWidth=1.6/st.cam.s;
      ctx.shadowColor='rgba(67,224,255,.5)'; ctx.shadowBlur=12/st.cam.s; ctx.stroke();
      ctx.restore();
    }
    // 河流
    if(g.river){
      ctx.save();
      ctx.beginPath(); smooth(ctx,g.river,false);
      ctx.lineCap='round';
      ctx.lineWidth=9/st.cam.s; ctx.strokeStyle=skinColor('water','stroke','rgba(30,130,190,.30)'); ctx.stroke();
      ctx.lineWidth=3.4/st.cam.s; ctx.strokeStyle=skinColor('water','stroke','rgba(110,235,255,.75)');
      ctx.shadowColor='rgba(67,224,255,.7)'; ctx.shadowBlur=10/st.cam.s; ctx.stroke();
      ctx.restore();
    }
    // 道路
    ctx.save();
    ctx.setLineDash([7/st.cam.s,7/st.cam.s]);
    ctx.strokeStyle=skinColor('road','stroke','rgba(255,194,71,.42)'); ctx.lineWidth=1.7/st.cam.s;
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
      ctx.lineWidth=g.riverWidth||42/st.cam.s; ctx.strokeStyle=skinColor('water','stroke','rgba(20,90,140,.30)'); ctx.stroke();
      ctx.lineWidth=(g.riverWidth||42/st.cam.s)*26/42; ctx.strokeStyle=skinColor('water','stroke','rgba(32,140,200,.5)'); ctx.stroke();
      ctx.lineWidth=4/st.cam.s; ctx.strokeStyle=skinColor('water','stroke','rgba(120,240,255,.55)');
      ctx.shadowColor='rgba(67,224,255,.6)'; ctx.shadowBlur=14/st.cam.s; ctx.stroke();
      ctx.restore();
    }
    // 街区面
    (g.districts||[]).forEach(d=>{
      const on = st.filter.size===0 || st.filter.has(d.id);
      ctx.save(); ctx.globalAlpha = on?1:.16;
      ctx.beginPath();d.pts.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.closePath();
      ctx.fillStyle = hexA(d.c,.10); ctx.fill();
      ctx.lineWidth=1.6/st.cam.s; ctx.strokeStyle=hexA(d.c,.42); ctx.stroke();
      ctx.setLineDash([4/st.cam.s,5/st.cam.s]);
      ctx.lineWidth=4/st.cam.s; ctx.strokeStyle=hexA(d.c,.10); ctx.stroke();
      ctx.setLineDash([]);
      // The sample scene has decorative texture. Real SQL maps use only saved
      // geometry: hundreds of random blocks otherwise drown the few real places.
      if(!st.node.host){
      let bx0=1e9,bx1=-1e9,by0=1e9,by1=-1e9;
      d.pts.forEach(p=>{ bx0=Math.min(bx0,p[0]); bx1=Math.max(bx1,p[0]); by0=Math.min(by0,p[1]); by1=Math.max(by1,p[1]); });
      ctx.save();
      ctx.beginPath();d.pts.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.closePath();ctx.clip();
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
      }
      ctx.restore();
      let cx=0,cy=0; d.pts.forEach(p=>{ cx+=p[0]; cy+=p[1]; });
      cx/=d.pts.length; cy/=d.pts.length;
      pushLabel(cx, cy-7, d.name, d.c, 'name', true);
      pushLabel(cx, cy+11, '街区 · 范围示意', 'rgba(140,170,200,.72)', 'sub', true);
    });
    ctx.save();ctx.strokeStyle=skinColor('road','stroke','rgba(150,205,255,.26)');ctx.lineWidth=1.4/st.cam.s;ctx.setLineDash([6/st.cam.s,5/st.cam.s]);
    for(const road of g.avenues||[]){ctx.beginPath();ctx.moveTo(...road.from);ctx.lineTo(...road.to);ctx.stroke();}
    ctx.setLineDash([]);
    for(const b of g.cityBuildings||[]){ctx.beginPath();rrect(ctx,b.x,b.y,b.w,b.h,2);ctx.fillStyle=skinColor('floorWall','fill','rgba(127,212,255,.12)');ctx.fill();ctx.strokeStyle=skinColor('floorWall','stroke','rgba(127,212,255,.6)');ctx.stroke();}
    ctx.restore();
    // 环路 / 放射大道 / 环形城墙：
    // 这三段读的是 `g.rings` / `g.radials` / `g.walls` —— 仓库里**没有任何生产方**会产出它们
    // （referenceGeometry 的 city 分支只下发 districts/river/wallPoints/avenues）。
    // 留着它们等于留了一条"没数据也能画出一圈城墙"的伪造路径，与 G07「open city 不画默认城墙」冲突，
    // 所以整段删除。真实城墙只看 wallPoints（由 layout.wall 投影，空数组就是开放式城市）。
    // 中心
    if(!st.node.host){ctx.save();
    ctx.beginPath(); ctx.arc(0,0,7/st.cam.s,0,7); ctx.fillStyle='rgba(255,255,255,.25)'; ctx.fill();
    ctx.restore();}
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
      ctx.strokeStyle=skinColor('road','stroke',major?'rgba(150,205,255,.28)':'rgba(130,180,240,.14)');
      ctx.lineWidth = (major?2.4:1.2)/st.cam.s;
      ctx.beginPath(); ctx.moveTo(x,gy0-20); ctx.lineTo(x,gy1+20); ctx.stroke();
    }
    for(let y=gy0;y<=gy1;y+=gys){
      const major = Math.round((y-gy0)/gys)%3===0;
      ctx.strokeStyle=skinColor('road','stroke',major?'rgba(150,205,255,.28)':'rgba(130,180,240,.14)');
      ctx.lineWidth = (major?2.4:1.2)/st.cam.s;
      ctx.beginPath(); ctx.moveTo(gx0-20,y); ctx.lineTo(gx1+20,y); ctx.stroke();
    }
    // 对角大道
    ctx.strokeStyle=skinColor('road','stroke','rgba(255,194,71,.30)'); ctx.lineWidth=3.4/st.cam.s; ctx.lineCap='round';
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
      ctx.strokeStyle=skinColor('road','stroke','rgba(57,224,160,.4)'); ctx.lineWidth=1.4/st.cam.s; ctx.stroke();
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
        ctx.strokeStyle=skinColor('road','stroke',`rgba(155,107,255,${.10+k*.06})`); ctx.lineWidth=1.4/st.cam.s; ctx.stroke();
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
      ctx.strokeStyle=skinColor('road','stroke','rgba(150,205,255,.26)'); ctx.lineWidth=1.2/st.cam.s; ctx.stroke();
      // 屋顶细节
      ctx.strokeStyle=skinColor('road','stroke','rgba(180,225,255,.14)');
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
    ctx.fillStyle=skinColor('buildingOutline','fill',grd); ctx.fill();
    ctx.lineWidth=3/st.cam.s; ctx.strokeStyle=skinColor('buildingOutline','stroke','rgba(120,215,255,.6)');
    ctx.shadowColor='rgba(67,224,255,.6)'; ctx.shadowBlur=16/st.cam.s; ctx.stroke();
    ctx.restore();
    // 中庭
    ctx.save();
    ctx.beginPath(); rrect(ctx,g.atrium.x-g.atrium.w/2,g.atrium.y-g.atrium.h/2,g.atrium.w,g.atrium.h,10);
    ctx.fillStyle=skinColor('buildingOutline','fill','rgba(120,200,255,.10)'); ctx.fill();
    ctx.setLineDash([10/st.cam.s,7/st.cam.s]); ctx.strokeStyle=skinColor('buildingOutline','stroke','rgba(150,215,255,.45)');
    ctx.lineWidth=1.6/st.cam.s; ctx.stroke();
    ctx.restore();
    // 楼梯
    (g.stairs||[]).forEach(s=>{
      ctx.save();
      ctx.beginPath(); rrect(ctx,s.x,s.y-s.h/2,s.w,s.h,6);
      ctx.fillStyle=skinColor('buildingOutline','fill','rgba(155,107,255,.16)'); ctx.fill();
      ctx.strokeStyle=skinColor('buildingOutline','stroke','rgba(155,107,255,.5)'); ctx.lineWidth=1.4/st.cam.s; ctx.stroke();
      ctx.strokeStyle=skinColor('buildingOutline','stroke','rgba(200,175,255,.35)');
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
      ctx.fillStyle=skinColor('buildingOutline','fill',grd); ctx.fill();
      ctx.strokeStyle=skinColor('buildingOutline','stroke',wg.live?'rgba(67,224,255,.75)':'rgba(150,205,255,.3)');
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
    const rooms=g.rooms||[];
    const planTop=rooms.length?Math.min(...rooms.map(r=>r.y)):-280;
    if(g.hostArea){const r=g.hostArea;ctx.save();ctx.beginPath();rrect(ctx,r.x,r.y,r.w,r.h,6);ctx.fillStyle=skinColor('floorWall','fill','rgba(67,224,255,.06)');ctx.fill();ctx.strokeStyle=skinColor('floorWall','stroke','rgba(67,224,255,.4)');ctx.lineWidth=1.3/st.cam.s;ctx.stroke();ctx.restore();pushLabel(r.x+r.w/2,r.y+r.h-12/st.cam.s,r.name||st.node.name,'#7fd4ff','sub',true);}
    // 走廊
    const c = g.corridor;
    if(!g.hostArea&&c.w>0&&c.h>0){
    ctx.save();
    ctx.beginPath(); rrect(ctx,c.x,c.y-c.h/2,c.w,c.h,8);
    ctx.fillStyle=skinColor('corridor','fill','rgba(38,62,98,.55)'); ctx.fill();
    ctx.strokeStyle=skinColor('corridor','stroke','rgba(140,200,255,.28)'); ctx.lineWidth=1.4/st.cam.s; ctx.stroke();
    ctx.setLineDash([8/st.cam.s,8/st.cam.s]);
    ctx.strokeStyle=skinColor('corridor','stroke','rgba(67,224,255,.22)'); ctx.lineWidth=1.2/st.cam.s;
    ctx.beginPath(); ctx.moveTo(c.x+14,c.y); ctx.lineTo(c.x+c.w-14,c.y); ctx.stroke();
    ctx.setLineDash([]);
    // 走廊铺地
    ctx.strokeStyle=skinColor('corridor','stroke','rgba(150,205,255,.06)'); ctx.lineWidth=1/st.cam.s;
    for(let x=c.x+10;x<c.x+c.w-8;x+=48){ ctx.beginPath(); ctx.moveTo(x,c.y-c.h/2+4); ctx.lineTo(x,c.y+c.h/2-4); ctx.stroke(); }
    // 壁灯
    for(let x=c.x+56;x<c.x+c.w-30;x+=126){
      [-1,1].forEach(sgn=>{
        const ly=c.y+sgn*(c.h/2-9);
        const rg=ctx.createRadialGradient(x,ly,1,x,ly,46);
        rg.addColorStop(0,'rgba(255,214,140,.24)'); rg.addColorStop(1,'rgba(255,214,140,0)');
        ctx.beginPath(); ctx.arc(x,ly,46,0,7); ctx.fillStyle=rg; ctx.fill();
        ctx.beginPath(); ctx.arc(x,ly,3.2,0,7); ctx.fillStyle='rgba(255,232,180,.9)';
        ctx.shadowColor='rgba(255,220,150,.9)'; ctx.shadowBlur=12/st.cam.s; ctx.fill(); ctx.shadowBlur=0;
      });
    }
    // 长凳
    ctx.fillStyle='rgba(150,200,255,.13)';
    (st.node.host?[]:[-330,-40,250]).forEach(bx=>{
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
      ctx.save();if(canvasStyle)ctx.lineJoin=layerPaint(canvasStyle,'floorWall').join;
      ctx.beginPath(); rrect(ctx,x,y,w,h,6);
      const grd=ctx.createLinearGradient(x,y,x+w,y+h);
      grd.addColorStop(0,`rgba(${tint},${live?.22:.11})`);
      grd.addColorStop(1,`rgba(${tint},${live?.07:.03})`);
      ctx.fillStyle=skinColor('floorWall','fill',grd); ctx.fill();
      ctx.strokeStyle=skinColor('floorWall','stroke',`rgba(${tint},${live?.85:.35})`); ctx.lineWidth=(live?2.2:1.3)/st.cam.s;
      if(live){ ctx.shadowColor=`rgba(${tint},.8)`; ctx.shadowBlur=canvasStyle?0:16/st.cam.s; }
      ctx.stroke();
      if(r.role==='garden'||r.role==='outdoor'){
        // Surface material only. These strokes are not furniture or new world entities.
        ctx.save();ctx.beginPath();rrect(ctx,x+2,y+2,w-4,h-4,4);ctx.clip();
        ctx.strokeStyle=r.role==='garden'?'rgba(57,224,160,.10)':'rgba(255,194,71,.08)';ctx.lineWidth=1/st.cam.s;
        for(let yy=y+16;yy<y+h;yy+=20){ctx.beginPath();ctx.moveTo(x+3,yy);ctx.lineTo(x+w-3,yy);ctx.stroke();}
        if(r.role==='garden')for(let xx=x+16;xx<x+w;xx+=24){ctx.beginPath();ctx.moveTo(xx,y+3);ctx.lineTo(xx,y+h-3);ctx.stroke();}
        ctx.restore();
      }
      ctx.restore();
    });

    // M6-06②：灯光先于陈设与人物 —— 光晕压在人物**下方**，不许糊住 marker。
    (g.lamps||[]).forEach(l=>{
      const rad=Math.max(26,46);
      ctx.save();
      const rg=ctx.createRadialGradient(l.x,l.y,1,l.x,l.y,rad);
      rg.addColorStop(0,'rgba(255,214,140,.20)'); rg.addColorStop(1,'rgba(255,214,140,0)');
      ctx.beginPath(); ctx.arc(l.x,l.y,rad,0,7); ctx.fillStyle=rg; ctx.fill();
      // Ambient light is a soft background, not a second physical lamp marker.
      ctx.restore();
    });

    // 陈设（M6-06②：按**真实 roomId** 归属，不再靠几何包含猜；ID 稳定可直接命中）
    [...(g.rooms||[]),...(g.hostArea?[g.hostArea]:[])].forEach(r=>{
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
      if(r!==g.hostArea&&!r.isContainer){pushLabel(x+w/2, y+h/2 - 4, r.name, !!r.live?C.cyan:'#a8bdd6', !!r.live?'live':'name', true);
      pushLabel(x+w/2, y+h-13, r.status || (r.kind==='vehicle'?'车厢内部':r.role==='garden'?'园林 · 示意':r.role==='outdoor'?'室外 · 示意':r.kind==='exit'?'通道':'房间'), 'rgba(140,170,200,.75)','sub', true);}
    });

    // Saved window geometry was projected but never drawn. Keep the reference page's cyan glazing.
    ctx.save();
    (g.windows||[]).forEach(win=>{
      ctx.beginPath();ctx.moveTo(win.x-win.w/2,win.y);ctx.lineTo(win.x+win.w/2,win.y);
      ctx.strokeStyle='rgba(10,16,26,1)';ctx.lineWidth=6/st.cam.s;ctx.stroke();
      ctx.strokeStyle='rgba(127,212,255,.65)';ctx.lineWidth=2/st.cam.s;ctx.stroke();
      ctx.beginPath();ctx.moveTo(win.x-win.w/2,win.y-3/st.cam.s);ctx.lineTo(win.x+win.w/2,win.y-3/st.cam.s);
      ctx.strokeStyle='rgba(127,212,255,.25)';ctx.lineWidth=1/st.cam.s;ctx.stroke();
    });
    ctx.restore();

    // 门
    ctx.save();
    const renderedOpenings=new Set();
    (g.doors||[]).forEach(d=>{
      // Two room sides describe one physical opening, including POV data
      // whose private route IDs are intentionally removed.
      const key=`${d.x}:${d.y}:${d.w}:${d.wall==='east'||d.wall==='west'?'v':'h'}`;
      if(renderedOpenings.has(key))return;renderedOpenings.add(key);
      const vertical=d.wall==='east'||d.wall==='west';
      ctx.save();ctx.translate(d.x,d.y);if(vertical)ctx.rotate(Math.PI/2);
      ctx.beginPath();
      ctx.moveTo(-d.w/2, 0); ctx.lineTo(d.w/2, 0);
      ctx.strokeStyle='rgba(10,16,26,1)'; ctx.lineWidth=7/st.cam.s; ctx.stroke();
      ctx.strokeStyle='rgba(255,225,150,.85)'; ctx.lineWidth=2/st.cam.s; ctx.stroke();
      ctx.beginPath(); ctx.arc(d.w/2, 0, d.w*.42, Math.PI, Math.PI*1.5);
      ctx.setLineDash([3/st.cam.s,3/st.cam.s]);
      ctx.strokeStyle='rgba(255,225,150,.35)'; ctx.lineWidth=1/st.cam.s; ctx.stroke();
      ctx.restore();
    });
    ctx.restore();

    // 图签；幅面尺寸留在数据中，不在地图上绘制尺寸线或宽度读数。
    const mpp = st.node.host?(st.node.metric||1/st.node.transform.scale):(st.node.metric||0.085);
    const measureWidth=st.node.host?st.node.transform.bounds.w*st.node.transform.scale:940;
    const measureRight=measureWidth/2;
    // 图签
    const stampX=st.node.host?measureRight-228:296,stampY=st.node.host?planTop-62:-302;
    ctx.save();
    ctx.beginPath(); rrect(ctx,stampX,stampY,228,50,4);
    ctx.fillStyle=canvasStyle?.labelBackground||'rgba(8,14,24,.82)'; ctx.fill();
    ctx.strokeStyle=skinColor('floorWall','stroke','rgba(120,200,255,.35)'); ctx.lineWidth=1/st.cam.s; ctx.stroke();
    ctx.restore();
    pushLabel(stampX+114, stampY+5, (st.path[st.path.length-2]||{}).name || '建筑图', '#bcd6ee', 'name', true);
    pushLabel(stampX+114, stampY+18, st.node.host?`空间示意 · 单位 ${st.node.metric?'m':'格'}`:`比例 1:${Math.round(0.085/mpp*140)} · ATLAS 制图`, 'rgba(140,170,200,.85)', 'sub', true);
    pushLabel(stampX+114, stampY+31, st.node.host?st.node.name:`地点 ${st.node.id} · ${st.node.name}`, 'rgba(140,170,200,.85)', 'sub', true);
  }
  /**
   * M6-06②：通用室内陈设。
   *
   * - 真实类型优先：读 `f.type`（M6-03 从场景的真实 body.type 投影而来）。
   *   POV 场景的服务端白名单会剥掉 body.type，此时 `f.detail===false`、
   *   这里画一块中性块 —— **不猜**它是一张床还是一张桌。
   * - 灯光只作背景光晕，不画悬浮标签；旧门洞提示使用设施符号。
   * - 渲染靠 `f.r`（4 元组绝对坐标）；`x,y,w,h` 是所属房间，仅用于 fallback 着色。
   */
  function queueUtility(kind,x,y){
    (st.utilitySymbols??=[]).push({kind,x,y});
  }
  function drawUtilities(){
    const groups=[];
    for(const symbol of st.utilitySymbols??[]){
      if(symbol.kind!=='doorway')continue;
      const [x,y]=W2S(symbol.x,symbol.y);
      if(x<0||x>st.vw||y<0||y>st.vh)continue;
      const existing=groups.find(g=>g.kind===symbol.kind&&Math.hypot(g.x-x,g.y-y)<12);
      if(existing)existing.count++;else groups.push({...symbol,x,y,count:1});
    }
    const occupied=(st.marks??[]).map(m=>{const [x,y]=W2S(m.x,m.y);return {x:x-17,y:y-17,w:34,h:34};});
    st.utilityBoxes=[];
    ctx.save();ctx.shadowBlur=0;ctx.lineWidth=1.2;ctx.setLineDash([]);
    ctx.font='500 11px '+F.sans;ctx.textBaseline='middle';ctx.textAlign='left';
    for(const g of groups){
      const text='门洞'+(g.count>1?' ×'+g.count:'');
      const w=st.showLabels?ctx.measureText(text).width+31:22,h=24;
      const offsets=[[12,12],[-w-12,12],[12,-30],[-w-12,-30]];
      let box;
      for(const distance of [0,30,60,90]){
        box=offsets.map(([dx,dy])=>({x:g.x+dx,y:g.y+dy+(dy<0?-distance:distance),w,h})).find(b=>b.x>=6&&b.y>=6&&b.x+b.w<=st.vw-6&&b.y+b.h<=st.vh-6&&!occupied.some(o=>b.x<o.x+o.w+4&&b.x+b.w>o.x-4&&b.y<o.y+o.h+4&&b.y+b.h>o.y-4));
        if(box)break;
      }
      if(!box)continue;
      occupied.push(box);st.utilityBoxes.push(box);
      const color=skinColor('furniture','stroke','#9ed2db');
      ctx.beginPath();ctx.moveTo(g.x,g.y);ctx.lineTo(clamp(g.x,box.x,box.x+box.w),clamp(g.y,box.y,box.y+box.h));
      ctx.strokeStyle=hexA(color,.55);ctx.stroke();
      ctx.beginPath();rrect(ctx,box.x,box.y,w,h,6);
      ctx.fillStyle=canvasStyle?.labelBackground?hexA(canvasStyle.labelBackground,.96):'rgba(8,18,30,.96)';ctx.fill();ctx.strokeStyle=hexA(color,.65);ctx.stroke();
      const x=box.x+11,y=box.y+12;
      ctx.beginPath();
      {
        ctx.moveTo(x-5,y+6);ctx.lineTo(x-5,y-7);ctx.lineTo(x+5,y-7);ctx.lineTo(x+5,y+6);
        ctx.moveTo(x-3,y+6);ctx.lineTo(x-3,y-5);ctx.lineTo(x+3,y-3);ctx.lineTo(x+3,y+6);ctx.closePath();
      }
      ctx.strokeStyle=color;ctx.stroke();
      if(st.showLabels){ctx.fillStyle=canvasStyle?.labelColor||color;ctx.fillText(text,box.x+24,y);}
    }
    ctx.restore();
  }
  function drawFurn(f,x,y,w,h,tint){
    const r=f.r||[x,y,x+w,y+h];
    const [a,b,c2,d]=r;
    const bw=c2-a, bh=d-b;
    const known=!!f.type||!!f.detail;
    const kind=f.type||f.t||'decor';
    const solid=f.solid===true;
    const stroke=solid?'rgba(214,232,255,.5)':'rgba(200,220,240,.30)';
    const fill=solid?'rgba(200,225,255,.15)':'rgba(200,220,240,.07)';
    ctx.save();if(canvasStyle)ctx.lineJoin=layerPaint(canvasStyle,'furniture').join;
    if(!known||kind==='decor'){
      // 不知道是什么，只标"这里有一件东西"，不编形状。
      ctx.beginPath(); rrect(ctx,a,b,bw,bh,3);
      ctx.fillStyle=skinColor('furniture','fill','rgba(170,200,235,.07)'); ctx.fill();
      ctx.strokeStyle=skinColor('furniture','stroke','rgba(180,205,235,.22)'); ctx.lineWidth=1/st.cam.s;
      ctx.setLineDash([3/st.cam.s,3/st.cam.s]); ctx.stroke(); ctx.setLineDash([]);
      ctx.restore(); return;
    }
    switch(kind){
      case 'shelf':{
        ctx.beginPath(); rrect(ctx,a,b,bw,bh,3);
        ctx.fillStyle=skinColor('furniture','fill','rgba(255,194,71,.14)'); ctx.fill();
        ctx.strokeStyle=skinColor('furniture','stroke','rgba(255,194,71,.45)'); ctx.lineWidth=1.1/st.cam.s; ctx.stroke();
        // 隔板数量是**画法参数**（约每 1.1 世界单位一层），不是世界数据；
        // 旧代码读 `f.n`，而 `n` 从来没被任何数据源产出过 —— 那是个固定的假数字。
        const horiz=bw>bh;
        const n=Math.max(2,Math.min(8,Math.round((horiz?bw:bh)/1.1)));
        ctx.strokeStyle=skinColor('furniture','stroke','rgba(255,214,130,.35)');
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
        ctx.fillStyle=skinColor('furniture','fill','rgba(200,225,255,.16)'); ctx.fill();
        ctx.strokeStyle=skinColor('furniture','stroke','rgba(200,230,255,.5)'); ctx.lineWidth=1.4/st.cam.s; ctx.stroke();
        break;
      }
      case 'desk':{
        ctx.beginPath(); rrect(ctx,a,b,bw,bh,3);
        ctx.fillStyle=skinColor('furniture','fill','rgba(140,200,255,.12)'); ctx.fill();
        ctx.strokeStyle=skinColor('furniture','stroke','rgba(150,210,255,.4)'); ctx.lineWidth=1.1/st.cam.s; ctx.stroke();
        break;
      }
      case 'chair':{
        ctx.beginPath(); rrect(ctx,a,b,bw,bh,2);
        ctx.fillStyle=skinColor('furniture','fill','rgba(190,215,250,.14)'); ctx.fill();
        ctx.strokeStyle=skinColor('furniture','stroke','rgba(200,225,255,.42)'); ctx.lineWidth=1/st.cam.s; ctx.stroke();
        // 椅背：沿短边画一道，让人一眼看出朝向
        ctx.beginPath();
        if(bw>=bh){ ctx.moveTo(a+1,b+1); ctx.lineTo(c2-1,b+1); }
        else { ctx.moveTo(a+1,b+1); ctx.lineTo(a+1,d-1); }
        ctx.lineWidth=2/st.cam.s; ctx.strokeStyle=skinColor('furniture','stroke','rgba(200,225,255,.6)'); ctx.stroke();
        break;
      }
      case 'bed':{
        ctx.beginPath(); rrect(ctx,a,b,bw,bh,4);
        ctx.fillStyle=skinColor('furniture','fill','rgba(155,107,255,.14)'); ctx.fill();
        ctx.strokeStyle=skinColor('furniture','stroke','rgba(180,150,255,.45)'); ctx.lineWidth=1.2/st.cam.s; ctx.stroke();
        // 枕头（短边一侧）+ 被沿
        ctx.fillStyle=skinColor('furniture','fill','rgba(210,195,255,.22)');
        if(bh>=bw){ ctx.beginPath(); rrect(ctx,a+2,b+2,bw-4,Math.min(bh*.22,7),2); ctx.fill();
          ctx.beginPath(); ctx.moveTo(a+2,b+bh*.42); ctx.lineTo(c2-2,b+bh*.42); }
        else { ctx.beginPath(); rrect(ctx,a+2,b+2,Math.min(bw*.22,7),bh-4,2); ctx.fill();
          ctx.beginPath(); ctx.moveTo(a+bw*.42,b+2); ctx.lineTo(a+bw*.42,d-2); }
        ctx.strokeStyle=skinColor('furniture','stroke','rgba(210,195,255,.35)'); ctx.lineWidth=1/st.cam.s; ctx.stroke();
        break;
      }
      case 'pillow':{
        ctx.beginPath(); rrect(ctx,a,b,bw,bh,Math.min(bw,bh)/2);
        ctx.fillStyle=skinColor('furniture','fill','rgba(210,195,255,.20)'); ctx.fill(); ctx.strokeStyle=skinColor('furniture','stroke',stroke); ctx.lineWidth=1/st.cam.s; ctx.stroke();
        break;
      }
      case 'cabinet':{
        ctx.beginPath(); rrect(ctx,a,b,bw,bh,2);
        ctx.fillStyle=skinColor('furniture','fill','rgba(255,194,71,.10)'); ctx.fill();
        ctx.strokeStyle=skinColor('furniture','stroke','rgba(255,205,130,.40)'); ctx.lineWidth=1.2/st.cam.s; ctx.stroke();
        // 双开门 + 把手
        ctx.beginPath();
        if(bw>=bh){ const mx=a+bw/2; ctx.moveTo(mx,b+1); ctx.lineTo(mx,d-1); }
        else { const my=b+bh/2; ctx.moveTo(a+1,my); ctx.lineTo(c2-1,my); }
        ctx.strokeStyle=skinColor('furniture','stroke','rgba(255,205,130,.28)'); ctx.lineWidth=0.9/st.cam.s; ctx.stroke();
        ctx.beginPath(); ctx.arc(bw>=bh?a+bw*.42:a+bw*.45, bh>=bw?b+bh*.42:b+bh*.45, 0.9, 0, 7);
        ctx.fillStyle=skinColor('furniture','fill','rgba(255,215,150,.6)'); ctx.fill();
        break;
      }
      case 'rug':{
        ctx.beginPath(); rrect(ctx,a,b,bw,bh,14);
        ctx.fillStyle=skinColor('furniture','fill',`rgba(${tint},.10)`); ctx.fill();
        ctx.setLineDash([6/st.cam.s,6/st.cam.s]);
        ctx.strokeStyle=skinColor('furniture','stroke',`rgba(${tint},.4)`); ctx.lineWidth=1.2/st.cam.s; ctx.stroke(); ctx.setLineDash([]);
        break;
      }
      case 'light':{
        // Ambient lighting is drawn below furniture; no bulb badge or leader line.
        break;
      }
      case 'doorway':{
        // Only the saved structural doors draw wall openings. A furnishing
        // doorway has no wall orientation, so show a named symbol at its anchor.
        queueUtility('doorway',a+bw/2,b+bh/2);
        break;
      }
      case 'stairs':{
        ctx.beginPath(); rrect(ctx,a,b,bw,bh,2);
        ctx.fillStyle=skinColor('furniture','fill','rgba(160,175,205,.12)'); ctx.fill();
        ctx.strokeStyle=skinColor('furniture','stroke','rgba(170,190,225,.38)'); ctx.lineWidth=1/st.cam.s; ctx.stroke();
        ctx.strokeStyle=skinColor('furniture','stroke','rgba(170,190,225,.26)');
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
        ctx.fillStyle=skinColor('furniture','fill',fill); ctx.fill();
        ctx.strokeStyle=skinColor('furniture','stroke',stroke); ctx.lineWidth=1/st.cam.s;
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
    ctx.fillStyle=skinColor('floorWall','fill',grd); ctx.fill();
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
    });
    // 墙
    ctx.save();
    ctx.beginPath(); rrect(ctx,W.x,W.y,W.w,W.h,4);
    ctx.lineWidth=7/st.cam.s; ctx.strokeStyle=skinColor('floorWall','stroke','rgba(140,215,255,.75)');
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
    if(!st.showGrid||st.geo.exploration) return;
    const cam=st.cam;
    // NaN / 零缩放防护：算不出可信步长就不画网格，绝不进死循环。
    if(!Number.isFinite(cam.s)||cam.s<=0||!Number.isFinite(cam.x)||!Number.isFinite(cam.y)
      ||!Number.isFinite(st.vw)||!Number.isFinite(st.vh)) return;
    const step=gridStep(cam.s);
    if(!(step>0)) return;
    paintGrid(ctx,{cam,vw:st.vw,vh:st.vh,dpr:st.dpr,step,color:canvasStyle?.gridColor});
  }

  /** `rank` 越小越优先（0 = 选中/悬停）。不传就按标签种类给默认优先级。 */
  function pushLabel(x,y,text,color,kind,world,rank,entry){ if(st.showLabels) st.labels.push({x,y,text,color,kind,scr:!world,rank,entry}); }

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
    const col = canvasStyle?.markerColors[m.type] || m.c || ({char:C.cyan,item:C.amber,poi:C.violet,sig:C.green,evt:C.pink,exit:C.blue}[m.type]||C.cyan);
    const dim = m.dim ? .35 : 1;
    ctx.save();
    ctx.globalAlpha = dim;

    if(canvasStyle?.markerImages?.[m.type]||m.type==='vehicle'&&canvasStyle?.markerImages?.exit){
      ctx.drawImage(canvasStyle.markerImages[m.type]||canvasStyle.markerImages.exit,sx-12,sy-12,24,24);if(hover||sel||m.hero){ctx.beginPath();ctx.arc(sx,sy,15,0,7);ctx.strokeStyle=col;ctx.lineWidth=sel?2:1;ctx.stroke();}
    }else if(canvasStyle?.markerShape==='seal'&&['char','poi','item','exit'].includes(m.type)){
      ctx.save();ctx.translate(sx,sy);ctx.fillStyle=canvasStyle.labelBackground||'#f4e9d0';ctx.strokeStyle=col;ctx.lineWidth=1.6;ctx.beginPath();
      if(m.type==='char')ctx.arc(0,0,11,0,7);else if(m.type==='poi'){ctx.moveTo(0,-12);ctx.lineTo(11,0);ctx.lineTo(0,12);ctx.lineTo(-11,0);ctx.closePath();}else rrect(ctx,-9,-9,18,18,2);
      ctx.fill();ctx.stroke();ctx.beginPath();ctx.arc(0,0,3,0,7);ctx.fillStyle=col;ctx.fill();ctx.restore();
    }else if(m.type==='char'){
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
    } else if(m.type==='vehicle'){
      ctx.save();ctx.translate(sx,sy);ctx.strokeStyle=col;ctx.fillStyle=hexA(col,.25);ctx.lineWidth=1.6;
      ctx.beginPath();rrect(ctx,-8,-5,16,10,2);ctx.fill();ctx.stroke();
      for(const x of [-5,5]){ctx.beginPath();ctx.arc(x,7,2.2,0,7);ctx.fillStyle=col;ctx.fill();}
      ctx.beginPath();ctx.moveTo(10,-2);ctx.lineTo(15,0);ctx.lineTo(10,2);ctx.stroke();ctx.restore();
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
    if(l.kind==='name'||l.kind==='area')return 2;
    return 4;
  }
  function drawLabels(){
    ctx.save();
    ctx.textAlign='center'; ctx.textBaseline='top';
    const occupied=[...(st.utilityBoxes??[])];
    const items=st.labels.map((l,i)=>{
      const [sx,sy]= l.scr ? [l.x,l.y] : W2S(l.x,l.y);
      return {l,sx,sy,i,rank:labelRank(l)};
    }).filter(e=>e.sx>-40&&e.sx<=st.vw+40&&e.sy>-30&&e.sy<=st.vh+30)
      .sort((a,b)=>a.rank-b.rank||a.i-b.i);
    for(const {l,sx,sy} of items){
      ctx.font=(l.kind==='sub'?'400 11px ':l.kind==='live'?'600 12px ':l.kind==='area'?(st.geo.exploration?.level==='regions'?'600 14px ':'500 12px '):'500 11px ')+F.sans;
      const tw=ctx.measureText(l.text).width+12, th=l.entry?24:l.kind==='live'?20:17;
      const spot=placeLabel(occupied,sx,sy,tw+(l.entry?46:0),th);
      if(!spot)continue;   // 放不下就收纳：宁可少写一个字，也不挪 marker 或叠成一团
      // M6-10②：「让位」是要付代价的 —— 挪方位就得拉引线，读者得追着线才知道它属于谁。
      // 副标题是等级最低的标签，不配让别人付这个代价：首选位占不到就直接收纳，
      // 绝不为了一句「在场」把在场人物的名字挤到角落去。
      if(spot.leader&&labelRank(l)>=4)continue;
      occupied.push(spot.box);
      // 被挪开的标签用 leader 线指回自己的锚点（物理位置不变，只是文字让位）。
      if(spot.leader){
        ctx.beginPath(); ctx.moveTo(sx,sy); ctx.lineTo(spot.lx,spot.ly);
        ctx.strokeStyle=hexA((canvasStyle?.labelColor||l.color),.5); ctx.lineWidth=1; ctx.stroke();
      }
      const cx=spot.box.x+(l.entry?tw:spot.box.w)/2;
      if(l.entry)(st.entryHints??=[]).push({...l.entry,x:spot.box.x+tw+2,y:spot.box.y-2});
      if(l.kind==='area'){
        ctx.font=(st.geo.exploration?.level==='regions'?'600 14px ':'500 12px ')+F.sans;ctx.fillStyle=canvasStyle?.labelColor||l.color;ctx.fillText(l.text,cx,spot.box.y);
      } else if(l.kind==='live'){
        ctx.font='600 11.5px '+F.sans;
        const w=ctx.measureText(l.text).width;
        ctx.beginPath();
        rrect(ctx, cx-w/2-8, spot.box.y-2, w+16, 18, 9);
        ctx.fillStyle=canvasStyle?.labelBackground?hexA(canvasStyle.labelBackground,.94):'rgba(6,14,24,.82)'; ctx.fill();
        ctx.strokeStyle=hexA((canvasStyle?.labelColor||l.color),.45); ctx.lineWidth=1; ctx.stroke();
        ctx.fillStyle=(canvasStyle?.labelColor||l.color);
        ctx.shadowColor=(canvasStyle?.labelColor||l.color); ctx.shadowBlur=10;
        ctx.fillText(l.text, cx, spot.box.y+1);
        ctx.shadowBlur=0;
      } else if(l.kind==='name'){
        ctx.font='500 11px '+F.sans;
        const w=ctx.measureText(l.text).width;
        ctx.beginPath(); rrect(ctx, cx-w/2-6, spot.box.y-1, w+12, 15, 7);
        ctx.fillStyle=canvasStyle?.labelBackground?hexA(canvasStyle.labelBackground,.9):'rgba(5,11,20,.72)'; ctx.fill();
        ctx.fillStyle=(canvasStyle?.labelColor||l.color); ctx.fillText(l.text, cx, spot.box.y);
      } else {
        ctx.font='400 11px '+F.mono;
        const w=ctx.measureText(l.text).width;
        ctx.fillStyle=canvasStyle?.labelBackground?hexA(canvasStyle.labelBackground,.9):'rgba(6,12,20,.78)';
        ctx.fillRect(cx-w/2-3, spot.box.y-1, w+6, 12);
        ctx.fillStyle=(canvasStyle?.labelColor||l.color); ctx.fillText(l.text, cx, spot.box.y);
      }
    }
    ctx.restore();
  }

  /* ══════════ 雷达 / 覆盖层 ══════════ */
  function relationLayer(){
    for(const edge of hooks.getRelations?.(st.node.id)||[]){
      const points=edge.points?.map(p=>W2S(...p));if(!points||points.length<2)continue;
      ctx.save();ctx.beginPath();ctx.moveTo(...points[0]);points.slice(1).forEach(p=>ctx.lineTo(...p));
      ctx.setLineDash([6,5]);ctx.lineWidth=1.7;ctx.strokeStyle=edge.c||C.amber;ctx.globalAlpha=.8;ctx.stroke();ctx.setLineDash([]);
      if(st.showLabels){const a=points[0],b=points.at(-1);ctx.font='500 11px '+F.sans;ctx.textAlign='center';ctx.fillStyle=edge.c||C.amber;ctx.fillText(edge.name+(edge.schematic?'（示意）':''),(a[0]+b[0])/2,(a[1]+b[1])/2-9);}
      ctx.restore();
    }
  }
  function radar(t){
    // Interior plans need legible furniture and doors, not a map-wide spotlight.
    if(['building','floor','room'].includes(st.kind))return;
    const hero = st.marks.find(m=>m.hero);
    let cx=st.vw/2, cy=st.vh/2;
    if(hero){ const p=W2S(hero.x,hero.y); cx=p[0]; cy=p[1]; }
    ctx.save();
    // Thin, low-contrast range rings do not recolor the map beneath them.
    [90,170,260].forEach((r,i)=>{
      ctx.beginPath(); ctx.arc(cx,cy,r,0,7);
      ctx.strokeStyle=`rgba(67,224,255,${.055-i*.015})`; ctx.lineWidth=1; ctx.stroke();
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
    const activeKey=hooks.activeEdge?.(),active=activeKey===edge.id||!!edge.messageId&&activeKey===edge.messageId,col=edge.c||C.green;
    const route=edge.points?.length>1?edge.points.map(p=>W2S(...p)):null;
    const lengths=route?.slice(1).map((p,i)=>Math.hypot(p[0]-route[i][0],p[1]-route[i][1])),total=lengths?.reduce((n,x)=>n+x,0)||0;
    const at=k=>{if(!route)return [(1-k)*(1-k)*sx+2*(1-k)*k*mx+k*k*tx,(1-k)*(1-k)*sy+2*(1-k)*k*my+k*k*ty];let distance=Math.max(0,Math.min(1,k))*total;for(let i=0;i<lengths.length;i++){if(distance<=lengths[i]||i===lengths.length-1){const f=lengths[i]?distance/lengths[i]:0;return [route[i][0]+(route[i+1][0]-route[i][0])*f,route[i][1]+(route[i+1][1]-route[i][1])*f];}distance-=lengths[i];}return [sx,sy];};
    ctx.save();ctx.beginPath();ctx.moveTo(sx,sy);if(route)route.slice(1).forEach(p=>ctx.lineTo(...p));else ctx.quadraticCurveTo(mx,my,tx,ty);
    ctx.setLineDash(journey?[4,8]:[7,11]);ctx.lineDashOffset=-t*22;
    ctx.strokeStyle=hexA(col,active?.95:.55);ctx.lineWidth=active?2.8:1.7;
    ctx.shadowColor=col;ctx.shadowBlur=active?14:7;ctx.stroke();ctx.setLineDash([]);
    const committedProgress=journey||edge.kind==='propagation',progress=journey&&edge.pathProgress!==undefined?edge.pathProgress:edge.progress,positioned=!committedProgress||Number.isFinite(progress),k=committedProgress?(progress??0):(t*.2)%1,[x,y]=at(k);
    if(positioned){if(journey&&edge.entityKind==='vehicle')drawMark(ctx,{type:'vehicle',c:col,silent:true},x,y,t,false,false);else{ctx.beginPath();ctx.arc(x,y,journey?6:3.5,0,7);ctx.fillStyle=col;ctx.fill();}}
    const [hx,hy]=at(.5);
    st.edgeHits.push({x:hx,y:hy,r:16,m:{type:journey?'journey':'message',id:journey?edge.id:edge.messageId||edge.id,name:edge.name,sub:journey?'行程位置':'消息传播路径'}});
    if(active||journey||edge.kind==='propagation'){ctx.shadowBlur=0;ctx.font='500 11px '+F.sans;ctx.fillStyle='#dce9fb';ctx.textAlign='center';ctx.fillText(edge.name+(edge.kind==='propagation'&&Number.isFinite(edge.progress)?` · ${Math.round(edge.progress*100)}%`:''),hx,hy-13);}
    if(journey&&positioned)st.edgeHits.push({x,y,r:14,m:{type:edge.entityKind==='vehicle'?'vehicle':edge.entityKind==='location'?'poi':'char',...(edge.entityKind==='vehicle'||edge.entityKind==='location'?{placeId:edge.entityId}:{}),id:edge.entityId,name:edge.name}});
    ctx.restore();
  }

  function simLayer(t){
    ((hooks.getJourneys&&hooks.getJourneys(st.node.id))||[]).forEach(edge=>drawFlow(edge,t,true));
    flowLayer(t);
  }

  function edgeFade(){
    if(canvasStyle?.background)return;
    const g=ctx.createRadialGradient(st.vw/2,st.vh/2,Math.min(st.vw,st.vh)*.42,st.vw/2,st.vh/2,Math.max(st.vw,st.vh)*.78);
    g.addColorStop(0,'rgba(4,8,14,0)'); g.addColorStop(1,'rgba(4,8,14,.5)');
    ctx.fillStyle=g; ctx.fillRect(0,0,st.vw,st.vh);
  }

  /* ══════════ 小地图 ══════════ */
  function drawMini(){
    const w=mini.width/st.dpr, h=mini.height/st.dpr;
    mctx.setTransform(st.dpr,0,0,st.dpr,0,0);
    mctx.clearRect(0,0,w,h);
    mctx.fillStyle=canvasStyle?.background||'rgba(4,9,16,.9)'; mctx.fillRect(0,0,w,h);
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
      if(st.kind==='floor'){ const c=st.geo.hostArea??st.geo.corridor; const q=T(c.x,c.y-(st.geo.hostArea?0:c.h/2)); mctx.strokeRect(q[0],q[1],c.w*s,c.h*s);
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
    for(const poly of st.geo.exploration?.surface?.outlines??[]){mctx.beginPath();poly.forEach(([x,y],i)=>{const q=T(x,y);i?mctx.lineTo(...q):mctx.moveTo(...q);});mctx.closePath();mctx.fillStyle=hexA(canvasStyle?.labelColor||'#a7c5d7',.06);mctx.fill();mctx.strokeStyle=hexA(canvasStyle?.labelColor||'#a7c5d7',.5);mctx.stroke();}
    for(const a of st.geo.exploration?.areas??[])if(a.recorded||st.geo.exploration.level==='regions')for(const poly of a.parts){mctx.beginPath();poly.forEach(([x,y],i)=>{const q=T(x+a.x,y+a.y);i?mctx.lineTo(...q):mctx.moveTo(...q);});mctx.closePath();if(st.geo.exploration.level==='regions'){mctx.fillStyle=hexA(a.c,.35);mctx.fill();}mctx.strokeStyle=a.c||canvasStyle?.labelColor||'#a7c5d7';mctx.stroke();}
    for(const a of st.geo.exploration?.areas??[])if(a.bridge){const b=a.bridge;if(b.river){mctx.beginPath();b.river.points.forEach(([x,y],i)=>{const q=T(x+a.x,y+a.y);i?mctx.lineTo(...q):mctx.moveTo(...q);});mctx.strokeStyle='rgba(75,151,183,.6)';mctx.stroke();}mctx.beginPath();b.deck.forEach(([x,y],i)=>{const q=T(x+a.x,y+a.y);i?mctx.lineTo(...q):mctx.moveTo(...q);});mctx.closePath();mctx.strokeStyle=canvasStyle?.labelColor||'#a7c5d7';mctx.stroke();}
    if(st.geo.bridgeSymbol){mctx.beginPath();st.geo.bridgeSymbol.deck.forEach(([x,y],i)=>{const q=T(x,y);i?mctx.lineTo(...q):mctx.moveTo(...q);});mctx.closePath();mctx.stroke();}
    (st.geo.exploration?[]:st.marks).forEach(m=>{ const q=T(m.x,m.y); mctx.beginPath(); mctx.arc(q[0],q[1],2.2,0,7);
      mctx.fillStyle=canvasStyle?.markerColors[m.type]||m.c||({char:C.cyan,item:C.amber,poi:C.violet,sig:C.green,exit:C.blue}[m.type]||C.cyan); mctx.fill(); });
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
    st.labels=[];st.entryHints=[];st.edgeHits=[];st.hits=[];st.utilitySymbols=[];st.utilityBoxes=[];

    ctx.save();
    ctx.translate(st.vw/2, st.vh/2);
    ctx.scale(st.cam.s, st.cam.s);
    ctx.translate(-st.cam.x, -st.cam.y);
    terrainWorld(st.geo, st.vw, st.vh);
    ctx.restore();

    // M6-07①：网格走**屏幕空间** —— 线宽恒为 1 物理像素，既不受缩放影响，
    // 也不会像被 CSS 放大的位图那样糊掉。
    grid();
    drawUtilities();

    if(st.geo.exploration){
      drawLabels();edgeFade();ctx.save();ctx.font='400 11px '+F.sans;ctx.textAlign='left';ctx.textBaseline='bottom';ctx.fillStyle=canvasStyle?.labelColor||'#a7c5d7';ctx.globalAlpha=.75;
      ctx.fillText('点击「进入」展开地点地图；双击轮廓也可进入',18,st.vh-34);ctx.globalAlpha=.55;
      ctx.fillText(st.geo.exploration.note,18,st.vh-18);ctx.restore();
    }
    else if(st.showMarks){
      if(st.showLinks)relationLayer();
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

  /* ══════════ 交互 ══════════ */
  function hitTest(mx,my){
    let best=null, bd=1e9;
    // M6-10①：命中用**和绘制同一个** markScreenPos（含同样的视口裁剪），
    // 保证"画出来的点点得中、点得中的一定画着"。
    const markHits=st.showMarks&&!st.geo.exploration?visibleMarkHits():[];
    markHits.concat(st.edgeHits).forEach(h=>{
      const d=Math.hypot(h.x-mx,h.y-my);
      if(d<h.r+7 && d<bd){ bd=d; best=h.m; }
    });
    if(best)return best;
    const [wx,wy]=S2W(mx,my),g=st.geo;
    const inside=(pts)=>{let yes=false;for(let i=0,j=pts.length-1;i<pts.length;j=i++){const a=pts[i],b=pts[j];if((a[1]>wy)!==(b[1]>wy)&&wx<(b[0]-a[0])*(wy-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;};
    for(const a of g.exploration?.areas??[]){if(a.parts.some(poly=>inside(poly.map(([x,y])=>[x+a.x,y+a.y]))))return {type:'poi',id:a.id,placeId:a.nodeId,name:a.name,node:{id:a.nodeId,known:true},sub:a.recorded?'区域略图':'内部未探明'};}
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
    listen(canvas,'dblclick',e=>{const r=canvas.getBoundingClientRect(),m=hitTest(e.clientX-r.left,e.clientY-r.top);if(m?.node&&hooks.onEnter)hooks.onEnter(m);});
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
    state:st,setSkin,get skin(){return acceptedSkin;}, boot, resize, fit, setPath, zoomBy, locate, selectKey, focusKey, refreshMarks, setPaused, destroy,
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
      if(st.geo.exploration)return {schematic:true,calibrated:false,quality:'layout',estimated:true,cssPixelsPerUnit:null,metersPerUnit:null};
      const camS=st.cam.s, metric=st.node?.metric;
      const calibrated=Number.isFinite(metric)&&metric>0;
      const quality=st.node?.transform?.metricQuality??st.node?.transform?.scaleQuality??null;
      // 未标定 → 报「格」；已标定但质量不是 confirmed → 是"约"出来的数字。
      return {calibrated,quality,estimated:!calibrated||(quality!==null&&quality!=='confirmed'),
        // 格制场景：1 UI 单位 = 1/transform.scale 格，折算成格的相机尺度要再乘一次。
        cssPixelsPerUnit:Number.isFinite(camS)&&camS>0?camS*(calibrated?1:(st.node?.transform?.scale||1)):null,
        metersPerUnit:calibrated?metric:null};
    },
    fitScale, extent,
    /**
     * M6-07①：网格的两个纯函数入口（只吃数字与 ctx，不碰相机生命周期）。
     * 暴露出来是为了让「步长只取 1/2/5×10^n、屏距 12–40px、单帧 ≤2000 线」
     * 这三条契约能在 UI 层直接断言，而不是靠读源码正则猜。
     */
    gridStep, paintGrid
  };
}
return { create, C,PAINTER_REGISTRY,layerPaint,paintSemantic };
})();

