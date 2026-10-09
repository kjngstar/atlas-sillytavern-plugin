/**
 * overview-core.mjs — M4-08：确定性宏观地图核心（02 §6.3 七步 / §10 水系）。
 *
 * 纯函数：不读 DB、不发 HTTP、不创建任何 SQL 实体。
 * 输入 = generateOverview 已解析好的 ID + 几何锁（spec）；输出 = 可直接绘制的 OverviewLayout。
 * 禁止 Math.random / Date.now：同一输入必须给出同一点集（G03 锁定不动 / G04 增量稳定）。
 */
import {LIMITS,clone,finite,plain,stable} from './contracts.mjs';

const PAD=0.06;
/** 确认锁额外往内收：锁点落在 0.90 幅面处，估计形状仍有缩放余量且不会与旧几何互相抬价。 */
const LOCK_PAD=0.10;
const EPS=1e-6;
const GOLDEN_ANGLE=2.399963229728653;
const MAX_CANDIDATES=512;
const GAP_FACTORS=[1,0.75,0.5];
/** 初始半径 = 最短边 × 下列系数（02 §6.3 步 2）。 */
const SIZE_RATIO={small:0.035,medium:0.065,large:0.10};
const MIN_SIZE_RATIO=0.008;
/** 水系宽度 = 最短边 × 下列系数（02 §10）。 */
const WIDTH_RATIO={narrow:0.008,medium:0.015,wide:0.025};
const DENSITY_INFLATE={low:1.12,medium:1.28,high:1.5};
const SURFACE_SET=new Set(['mixed','urban','forest','mountain','water','indoor','void']);
const SIZE_SET=new Set(['small','medium','large']);
const DENSITY_SET=new Set(['low','medium','high']);
const WIDTH_CLASS_SET=new Set(['narrow','medium','wide']);
const URBAN_ROLES=new Set(['city','settlement','district','campus']);
const BLOCKING_ROLES=new Set(['mountain','water']);
const SECTOR_ANGLE={north:-Math.PI/2,northeast:-Math.PI/4,east:0,southeast:Math.PI/4,south:Math.PI/2,southwest:3*Math.PI/4,west:Math.PI,northwest:-3*Math.PI/4};
const OPPOSITE={north:'south',northeast:'southwest',east:'west',southeast:'northwest',south:'north',southwest:'northeast',west:'east',northwest:'southeast'};
const FEATURE_TYPES=new Set(['forest_texture','ridge','shore','building_cluster','road_texture','ruins_scatter','watercourse']);

const pt=(x,y)=>({x,y});
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const byId=(a,b)=>String(a?.id).localeCompare(String(b?.id),'en');
const ordered=list=>[...list].sort(byId);
function hashOf(text){let n=2166136261;const s=String(text);for(let i=0;i<s.length;i++){n^=s.charCodeAt(i);n=Math.imul(n,16777619);}return n>>>0;}
function randOf(seed){let n=hashOf(seed);return()=>{n=(Math.imul(n,1664525)+1013904223)>>>0;return n/4294967296;};}
function pointInPolygon(poly,p){
  if(!Array.isArray(poly)||poly.length<3)return false;
  let inside=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const a=poly[i],b=poly[j];
    if(a.y>p.y!==b.y>p.y&&p.x<(b.x-a.x)*(p.y-a.y)/((b.y-a.y)||EPS)+a.x)inside=!inside;
  }
  return inside;
}
function centroid(poly){
  let x=0,y=0;for(const p of poly){x+=p.x;y+=p.y;}return pt(x/poly.length,y/poly.length);
}
/** 围绕质心等比缩放；用于把装饰多边形压回留白边界内，绝不裁剪成非凸形状。 */
function scalePolygon(poly,f,c=centroid(poly)){
  return poly.map(p=>pt(c.x+(p.x-c.x)*f,c.y+(p.y-c.y)*f));
}
/** 保证多边形完全落在 box 内：按需向质心收缩（最多 6 档），返回 null 表示无法压入。 */
function fitPolygon(poly,box){
  for(let attempt=0;attempt<6;attempt++){
    let f=1,c=centroid(poly);
    for(const p of poly){
      const dx=p.x-c.x,dy=p.y-c.y;
      if(dx>EPS&&c.x+dx>box.x1)f=Math.min(f,(box.x1-c.x)/dx);
      if(dx<-EPS&&c.x+dx<box.x0)f=Math.min(f,(box.x0-c.x)/dx);
      if(dy>EPS&&c.y+dy>box.y1)f=Math.min(f,(box.y1-c.y)/dy);
      if(dy<-EPS&&c.y+dy<box.y0)f=Math.min(f,(box.y0-c.y)/dy);
    }
    if(!(f<1)||!(f>0))return poly;
    poly=scalePolygon(poly,f,c);
  }
  return null;
}
function inflatePolygon(poly,factor){
  const c=centroid(poly);
  return poly.map(p=>pt(c.x+(p.x-c.x)*factor,c.y+(p.y-c.y)*factor));
}
function insideBox(poly,box){
  return poly.every(p=>p.x>=box.x0-EPS&&p.x<=box.x1+EPS&&p.y>=box.y0-EPS&&p.y<=box.y1+EPS);
}
/** 三次 Bezier 离散；控制点全部落在凸矩形内 → 整条曲线必在幅面内。 */
function bezierPath(p0,p1,p2,p3,segments){
  const out=[];
  for(let i=0;i<=segments;i++){
    const t=i/segments,u=1-t;
    const a=u*u*u,b=3*u*u*t,c=3*u*t*t,d=t*t*t;
    out.push(pt(a*p0.x+b*p1.x+c*p2.x+d*p3.x,a*p0.y+b*p1.y+c*p2.y+d*p3.y));
  }
  return out;
}
/** 8 方位 → 留白矩形边缘的落点（02 §10 的"首尾"由方向决定，模型不输出逐点河道）。 */
function edgePoint(sector,box){
  const dx=Math.cos(SECTOR_ANGLE[sector]??0),dy=Math.sin(SECTOR_ANGLE[sector]??0);
  const cx=(box.x0+box.x1)/2,cy=(box.y0+box.y1)/2,hw=(box.x1-box.x0)/2,hh=(box.y1-box.y0)/2;
  const t=Math.min(hw/Math.max(Math.abs(dx),EPS),hh/Math.max(Math.abs(dy),EPS));
  return pt(cx+dx*t,cy+dy*t);
}
function featuresOf(layout,type){
  return (Array.isArray(layout?.features)?layout.features:[]).filter(f=>f?.type===type);
}
/** 前一轮几何（含估计/示意）全部固定保留：不能只锁 confirmed 而让旧 layout 点抖动。 */
function previousSpots(previous){
  const out=[];
  for(const s of previous?.shapes??[])out.push(...(s.polygon??[]));
  for(const r of previous?.routes??[])out.push(...(r.path??[]));
  for(const f of previous?.features??[])out.push(...(f.path??[]),...(f.polygon??[]));
  return out.filter(p=>finite(p?.x)&&finite(p?.y));
}
/** 已确认锁：点在评估幅面时按 LOCK_PAD 内收，保证确认几何既不移动也不出界。 */
function confirmedSpots(zones,links){
  const out=[];
  for(const z of zones){
    if(finite(z?.locked?.x)&&finite(z.locked.y))out.push(z.locked);
    for(const p of z?.lockedPolygon??[])if(finite(p?.x)&&finite(p?.y))out.push(p);
  }
  for(const l of links)for(const p of l?.locked?.path??[])if(finite(p?.x)&&finite(p?.y))out.push(p);
  return out;
}

/**
 * 02 §6.2：格制概览在拿到估计尺度后转米 —— 已保存的格几何乘该尺度，形状/实体 ID/相对位置/seed 不变。
 * 只在本轮单位与上一轮不同时整体缩放一次，之后所有复用/排位逻辑都在同一坐标系里跑。
 */
function scaleLayout(layout,k){
  const sp=p=>plain(p)?{...p,x:p.x*k,y:p.y*k}:p;
  const sps=v=>Array.isArray(v)?v.map(sp):v;
  const out={...layout};
  if(plain(out.bounds))out.bounds={...out.bounds,x:out.bounds.x*k,y:out.bounds.y*k,w:out.bounds.w*k,h:out.bounds.h*k};
  out.pins=(layout.pins??[]).map(p=>({...p,...sp(p),...(Array.isArray(p.polygon)?{polygon:sps(p.polygon)}:{})}));
  out.shapes=(layout.shapes??[]).map(s=>({...s,...(Array.isArray(s.polygon)?{polygon:sps(s.polygon)}:{})}));
  out.routes=(layout.routes??[]).map(r=>({...r,...(Array.isArray(r.path)?{path:sps(r.path)}:{})}));
  out.features=(layout.features??[]).map(f=>({...f,...(Array.isArray(f.path)?{path:sps(f.path)}:{}),...(Array.isArray(f.polygon)?{polygon:sps(f.polygon)}:{}),...(finite(f.width)?{width:f.width*k}:{})}));
  return out;
}

/**
 * 02 §6.3：extent 内留 6% 缓冲 → 稳定排位 site → 稳定 polygon → route 复用/估计 → feature。
 * `spec` 由程序构建（含已解析引用与锁），本函数不解释任何剧情文字。
 */
export function overview(spec,previous=null){
  // kept 始终交回**原样**的上一轮布局（失败时调用方据此保留旧场景，不能交回缩放过的副本）。
  const kept=previous?clone(previous):null;
  const unitScale=finite(spec?.unitScale)&&spec.unitScale>0?spec.unitScale:1;
  if(unitScale!==1&&previous)previous=scaleLayout(previous,unitScale);
  const issues=[];
  if(!plain(spec)||typeof spec.id!=='string'||!spec.id)return {ok:false,issues:[{id:null,code:'OVERVIEW_INPUT_INVALID'}],kept};
  const zonesIn=ordered(Array.isArray(spec.zones)?spec.zones:[]).slice(0,LIMITS.zones);
  const linksIn=ordered(Array.isArray(spec.links)?spec.links:[]).slice(0,LIMITS.links);
  const featuresIn=ordered(Array.isArray(spec.features)?spec.features:[]).slice(0,LIMITS.features);
  if((spec.zones??[]).length>LIMITS.zones)issues.push({id:null,code:'OVERVIEW_ZONE_LIMIT'});
  if((spec.links??[]).length>LIMITS.links)issues.push({id:null,code:'OVERVIEW_LINK_LIMIT'});
  if((spec.features??[]).length>LIMITS.features)issues.push({id:null,code:'OVERVIEW_FEATURE_LIMIT'});
  let w=spec.width,h=spec.height;
  if(!finite(w)||!finite(h)||w<=0||h<=0)return {ok:false,issues:[...issues,{id:spec.id,code:'OVERVIEW_EXTENT_INVALID'}],kept};
  // ── 步 1：幅面与锁。锁可以把幅面撑大，但只增不减，因此不会每轮抖动。
  const locked=confirmedSpots(zonesIn,linksIn);
  for(const p of locked){w=Math.max(w,p.x/(1-LOCK_PAD));h=Math.max(h,p.y/(1-LOCK_PAD));}
  for(const p of previousSpots(previous)){w=Math.max(w,p.x/(1-PAD));h=Math.max(h,p.y/(1-PAD));}
  const W=w,H=h,S=Math.min(W,H);
  const box={x0:W*PAD,y0:H*PAD,x1:W*(1-PAD),y1:H*(1-PAD)};
  const surface=SURFACE_SET.has(spec.surface)?spec.surface:'mixed';
  if(spec.surface!==undefined&&!SURFACE_SET.has(spec.surface))issues.push({id:spec.id,code:'OVERVIEW_SURFACE_INVALID'});
  const seed=`${spec.mapId??spec.id}/${spec.seed??spec.id}`;
  const prevShapes=new Map((previous?.shapes??[]).filter(s=>s&&typeof s.id==='string').map(s=>[s.id,s]));
  const prevPins=new Map((previous?.pins??[]).filter(p=>p&&typeof p.id==='string').map(p=>[p.id,p]));
  const prevRoutes=new Map((previous?.routes??[]).filter(r=>r&&typeof r.id==='string').map(r=>[r.id,r]));
  const prevFeatures=new Map((previous?.features??[]).filter(f=>f&&typeof f.id==='string').map(f=>[f.id,f]));

  // ── 步 2：初始半径 + 稳定排位 site。锁定 site 原样保留，绝不重排老点。
  const baseRadius=new Map();
  for(const z of zonesIn){
    const ratio=SIZE_RATIO[SIZE_SET.has(z.size)?z.size:'medium'];
    baseRadius.set(z.id,S*ratio);
  }
  const occupied=[];
  for(const z of zonesIn)if(finite(z.locked?.x)&&finite(z.locked.y))occupied.push({id:z.id,point:pt(z.locked.x,z.locked.y)});
  const obstacles=[];
  for(const z of zonesIn)if(z.lockedPolygon?.length>=3)obstacles.push({id:z.id,polygon:z.lockedPolygon});
  // 注意：上一轮的估计多边形不进 obstacles——它是本程序自己的输出，且已通过 occupied 占位；
  // 把它当障碍会让"新增一个 zone"把老 zone 重新排位（G04 不允许）。
  const sites=new Map(),reasons=new Map();
  const minGap=S/12;
  for(const z of zonesIn){
    if(finite(z.locked?.x)&&finite(z.locked.y)){sites.set(z.id,pt(z.locked.x,z.locked.y));reasons.set(z.id,'locked');continue;}
    const r=baseRadius.get(z.id);
    const near=z.near&&sites.get(z.near)?sites.get(z.near):null;
    const angle=SECTOR_ANGLE[z.sector];
    const target=angle!==undefined?pt(W*(.5+.24*Math.cos(angle)),H*(.5+.24*Math.sin(angle))):near?pt(clamp(near.x,box.x0,box.x1),clamp(near.y,box.y0,box.y1)):pt((box.x0+box.x1)/2,(box.y0+box.y1)/2);
    const startIndex=hashOf(`${seed}\u0000${z.id}`)%MAX_CANDIDATES;
    let chosen=null;
    for(const factor of GAP_FACTORS){
      const gap=minGap*factor;
      for(let step=0;step<MAX_CANDIDATES;step++){
        const index=startIndex+step,radius=gap*Math.sqrt(step+1),angle=index*GOLDEN_ANGLE;
        const c=pt(target.x+radius*Math.cos(angle),target.y+radius*Math.sin(angle));
        if(c.x<box.x0+r||c.x>box.x1-r||c.y<box.y0+r||c.y>box.y1-r)continue;
        if(!occupied.every(o=>distance(c,o.point)>=gap))continue;
        if(!obstacles.every(o=>!pointInPolygon(o.polygon,c)))continue;
        chosen=c;break;
      }
      if(chosen)break;
    }
    if(!chosen){issues.push({id:z.id,code:'OVERVIEW_ZONE_NO_SPACE'});continue;}
    sites.set(z.id,chosen);reasons.set(z.id,near?'layout:near':'layout:center');
    occupied.push({id:z.id,point:chosen});
  }

  // ── 步 3：几何。旧图元按结构签名原样复用；只有结构约束真的变了才局部更新。
  const shapes=[],pins=[];
  const shapePolygon=new Map();
  for(const z of zonesIn){
    const site=sites.get(z.id);
    if(!site)continue;
    const structureKey=stable({role:z.role??null,size:z.size??null,sector:z.sector??null,near:z.near??null,locked:z.locked??null,lockedPolygon:z.lockedPolygon??null,...(SECTOR_ANGLE[z.sector]!==undefined?{placementPolicy:2}:{})});
    const placement=z.placement==='proxy'?'proxy':undefined;
    const prevShape=prevShapes.get(z.id);
    if(prevShape&&prevShape.structureKey===structureKey&&prevShape.polygon?.length>=3){
      const reused=clone(prevShape);
      if(placement)reused.placement=placement;else delete reused.placement;
      shapes.push(reused);shapePolygon.set(z.id,prevShape.polygon);
      const prevPin=prevPins.get(z.id);
      pins.push(prevPin?clone(prevPin):{id:z.id,name:z.name??null,type:'location',x:site.x,y:site.y,quality:'layout'});
      continue;
    }
    // 确认多边形逐点保留，绝不覆盖（G03）。
    let polygon=z.lockedPolygon?.length>=3?z.lockedPolygon.map(p=>pt(p.x,p.y)):null;
    if(!polygon){
      let r=baseRadius.get(z.id);
      const nearest=occupied.filter(o=>o.id!==z.id).reduce((d,o)=>Math.min(d,distance(site,o.point)),Infinity);
      if(finite(nearest))r=Math.max(S*MIN_SIZE_RATIO,Math.min(r,nearest*0.35));
      polygon=zonePolygon(z,site.x,site.y,r,seed);
    }
    const fitted=polygon.every(p=>finite(p.x)&&finite(p.y))?fitPolygon(polygon,box):null;
    if(!fitted||fitted.length<3){
      issues.push({id:z.id,code:'OVERVIEW_ZONE_OUT_OF_BOUNDS'});
      continue;
    }
    const lockedPoint=finite(z.locked?.x)&&finite(z.locked.y)?pt(z.locked.x,z.locked.y):null;
    shapes.push({
      id:z.id,name:z.name??null,quality:z.lockedPolygon?.length>=3?'confirmed':'estimated',
      polygon:fitted,structureKey,
      ...(lockedPoint?{locked:lockedPoint}:{}),
      ...(placement?{placement}:{}),
      ...(SIZE_SET.has(z.size)?{size:z.size}:{}),
      ...(typeof z.role==='string'?{role:z.role}:{}),
    });
    shapePolygon.set(z.id,fitted);
    pins.push({id:z.id,name:z.name??null,type:'location',x:lockedPoint?lockedPoint.x:site.x,y:lockedPoint?lockedPoint.y:site.y,quality:lockedPoint?'exact':'layout'});
  }
  // 额外标点（已确认的人物/物品点）：只接受落在幅面内的有限坐标。
  for(const pin of Array.isArray(spec.pins)?spec.pins.slice(0,LIMITS.markers):[]){
    if(!plain(pin)||typeof pin.id!=='string'||!pin.id)continue;
    if(!(finite(pin.x)&&finite(pin.y))||pin.x<0||pin.x>W||pin.y<0||pin.y>H){issues.push({id:pin.id,code:'OVERVIEW_PIN_OUT_OF_RANGE'});continue;}
    pins.push({id:pin.id,name:pin.name??null,type:typeof pin.type==='string'?pin.type:typeof pin.kind==='string'?pin.kind:'location',x:pin.x,y:pin.y,quality:pin.quality==='exact'?'exact':'layout'});
  }

  // ── 步 4：route。确认几何逐点原样；估计几何优先复用；缺几何才估折线（示意，不改真实距离）。
  const blockingPolygons=[];
  for(const [id,polygon] of shapePolygon){
    const zone=zonesIn.find(z=>z.id===id);
    if(zone&&BLOCKING_ROLES.has(String(zone.role)))blockingPolygons.push({id,polygon});
  }
  const routes=[];
  for(const link of linksIn){
    const prev=prevRoutes.get(link.id);
    if(link.locked?.path?.length>=2){
      const confirmed=link.locked.quality==='confirmed';
      routes.push({id:link.id,kind:'route',mapId:spec.mapId??null,path:link.locked.path.map(p=>pt(p.x,p.y)),quality:confirmed?'confirmed':'estimated',dashed:!confirmed,progress:null,fromLocationId:link.locked.fromLocationId??link.fromLocationId??null,toLocationId:link.locked.toLocationId??link.toLocationId??null});
      continue;
    }
    const a=link.fromSite&&finite(link.fromSite.x)&&finite(link.fromSite.y)?pt(link.fromSite.x,link.fromSite.y):sites.get(link.fromLocationId);
    const b=link.toSite&&finite(link.toSite.x)&&finite(link.toSite.y)?pt(link.toSite.x,link.toSite.y):sites.get(link.toLocationId);
    const structureKey=stable({a:a??null,b:b??null});
    if(prev&&prev.structureKey===structureKey&&prev.path?.length>=2){routes.push(clone(prev));continue;}
    if(!a||!b||distance(a,b)<=EPS){issues.push({id:link.id,code:'OVERVIEW_ROUTE_ENDPOINT_UNKNOWN'});continue;}
    const mid=pt((a.x+b.x)/2,(a.y+b.y)/2);
    const R=randOf(`${seed}/route/${link.id}`);
    const bend=(R()-0.5)*0.08*S;
    const nx=-(b.y-a.y),ny=b.x-a.x,len=Math.hypot(nx,ny)||1;
    mid.x=clamp(mid.x+nx/len*bend,0,W);mid.y=clamp(mid.y+ny/len*bend,0,H);
    // 水域/山体等障碍只画示意连接并标不确定：不自动生成桥、不改真实 distance_m。
    const crosses=blockingPolygons.some(o=>pointInPolygon(o.polygon,mid)||pointInPolygon(o.polygon,a)||pointInPolygon(o.polygon,b));
    routes.push({id:link.id,kind:'route',mapId:spec.mapId??null,path:[a,mid,b],quality:'estimated',dashed:true,progress:null,uncertain:crosses,fromLocationId:link.fromLocationId??null,toLocationId:link.toLocationId??null,structureKey});
  }

  // ── 步 5/6：feature 由确定 seed 生成局部装饰，真实建筑/道路/门/角色点附近留白。
  const clearZones=[];
  for(const [id,polygon] of shapePolygon){
    const zone=zonesIn.find(z=>z.id===id);
    if(!zone||!URBAN_ROLES.has(String(zone.role)))continue;
    clearZones.push({id,polygon});
  }
  const clearPoints=[...locked];
  const clearRoutes=routes.map(r=>r.path);
  const features=[];
  const pushFeature=feature=>{features.push(feature);};
  for(const f of featuresIn){
    if(!FEATURE_TYPES.has(f.type)){issues.push({id:f.id,code:'OVERVIEW_FEATURE_TYPE_INVALID'});continue;}
    const density=DENSITY_SET.has(f.density)?f.density:'medium';
    const structureKey=stable({type:f.type,zoneId:f.zoneId??null,density,fromSector:f.fromSector??null,toSector:f.toSector??null,widthClass:f.widthClass??null});
    const prev=prevFeatures.get(f.id);
    if(prev&&prev.structureKey===structureKey){pushFeature(clone(prev));continue;}
    // 装饰没有 SQL 身份：一律 decorative=true / quality=estimated，模型不能自称 confirmed。
    const base={id:f.id,type:f.type,density,decorative:true,quality:'estimated',structureKey};
    if(typeof f.zoneId==='string'&&f.zoneId)base.zoneId=f.zoneId;
    const zonePolygon=f.zoneId?shapePolygon.get(f.zoneId):null;
    if(f.zoneId&&!zonePolygon){issues.push({id:f.id,code:'OVERVIEW_FEATURE_ZONE_UNKNOWN'});continue;}
    if(f.type==='watercourse'){
      const fromSector=SECTOR_ANGLE[f.fromSector]!==undefined?f.fromSector:'west';
      const toSector=SECTOR_ANGLE[f.toSector]!==undefined?f.toSector:OPPOSITE[fromSector];
      const widthClass=WIDTH_CLASS_SET.has(f.widthClass)?f.widthClass:'medium';
      const width=S*WIDTH_RATIO[widthClass];
      const p0=edgePoint(fromSector,box),p3=edgePoint(toSector,box);
      const R=randOf(`${seed}/water/${f.id}`);
      const nx=-(p3.y-p0.y),ny=p3.x-p0.x,len=Math.hypot(nx,ny)||1;
      const off1=(R()-0.5)*0.22*S,off2=(R()-0.5)*0.22*S;
      const mid1=pt(p0.x+(p3.x-p0.x)/3+nx/len*off1,p0.y+(p3.y-p0.y)/3+ny/len*off1);
      const mid2=pt(p0.x+(p3.x-p0.x)*2/3+nx/len*off2,p0.y+(p3.y-p0.y)*2/3+ny/len*off2);
      const p1=pt(clamp(mid1.x,box.x0,box.x1),clamp(mid1.y,box.y0,box.y1));
      const p2=pt(clamp(mid2.x,box.x0,box.x1),clamp(mid2.y,box.y0,box.y1));
      const path=bezierPath(p0,p1,p2,p3,LIMITS.watercourseSegments);
      if(path.length<LIMITS.watercourseSegments+1||!path.every(p=>finite(p.x)&&finite(p.y)&&p.x>=0&&p.x<=W&&p.y>=0&&p.y<=H)){issues.push({id:f.id,code:'OVERVIEW_FEATURE_GEOMETRY_INVALID'});continue;}
      pushFeature({...base,fromSector,toSector,widthClass,width,path});
      continue;
    }
    if(f.type==='shore'){
      const water=features.find(x=>x.type==='watercourse')??featuresOf(previous,'watercourse')[0];
      const waterZone=zonesIn.find(z=>z.role==='water'&&shapePolygon.has(z.id));
      if(water?.path?.length>=2){
        const R=randOf(`${seed}/shore/${f.id}`);
        const shift=(0.4+R()*0.3)*(water.width??S*WIDTH_RATIO.medium);
        const nx=-(water.path[1].y-water.path[0].y),ny=water.path[1].x-water.path[0].x,len=Math.hypot(nx,ny)||1;
        const path=water.path.map(p=>pt(clamp(p.x+nx/len*shift,0,W),clamp(p.y+ny/len*shift,0,H)));
        pushFeature({...base,path,width:water.width??S*WIDTH_RATIO.medium});
        continue;
      }
      if(waterZone){
        const path=shapePolygon.get(waterZone.id).map(p=>pt(p.x,p.y));
        pushFeature({...base,path,zoneId:waterZone.id});
        continue;
      }
      issues.push({id:f.id,code:'OVERVIEW_FEATURE_NO_BASIS'});
      continue;
    }
    if(f.type==='ridge'){
      const R=randOf(`${seed}/ridge/${f.id}`);
      const horizontal=R()<0.5;
      const path=[];
      for(let i=0;i<=4;i++){
        const t=i/4;
        path.push(horizontal
          ?pt(box.x0+(box.x1-box.x0)*t,box.y0+(box.y1-box.y0)*(0.22+R()*0.12))
          :pt(box.x0+(box.x1-box.x0)*(0.22+R()*0.12),box.y0+(box.y1-box.y0)*t));
      }
      pushFeature({...base,path,density});
      continue;
    }
    if(f.type==='road_texture'){
      // 纹理不是道路：只画视觉带，绝不进 routes、绝不生成可通行边（G06）。
      const R=randOf(`${seed}/texture/${f.id}`);
      const path=[];
      for(let i=0;i<=3;i++)path.push(pt(box.x0+(box.x1-box.x0)*(i/3),box.y0+(box.y1-box.y0)*(0.3+R()*0.4)));
      pushFeature({...base,path,width:S*0.004,density});
      continue;
    }
    // forest_texture / building_cluster / ruins_scatter：多边形型装饰。
    const source=zonePolygon??[pt(box.x0,box.y0),pt(box.x1,box.y0),pt(box.x1,box.y1),pt(box.x0,box.y1)];
    let polygon=f.type==='forest_texture'||f.type==='ruins_scatter'?inflatePolygon(source,DENSITY_INFLATE[density]):scalePolygon(source,0.85);
    if(f.type==='building_cluster'&&!zonePolygon){issues.push({id:f.id,code:'OVERVIEW_FEATURE_NO_BASIS'});continue;}
    let fitted=fitPolygon(polygon,box),blocked=false;
    // 只有"挂在某个 zone 上"的局部装饰才需要在真实建筑/道路/标点附近留白；
    // 省略 zoneId 的全图公开材质按 02 §6.1 允许铺满（G10 亦允许无名称的公开水纹/林带）。
    // 注意：连接本 zone 的路线端点就落在本 zone 轮廓内，那不是"要避让的真实内容"，
    // 否则任何有对外道路的区域都画不出林带/废墟（假冲突）。
    const avoidRoutes=zonePolygon
      ?clearRoutes.filter(path=>!pointInPolygon(zonePolygon,path[0])&&!pointInPolygon(zonePolygon,path[path.length-1]))
      :clearRoutes;
    if(f.zoneId)for(let attempt=0;attempt<3&&fitted;attempt++){
      const touches=clearZones.some(z=>z.id!==f.zoneId&&pointsTouch(fitted,z.polygon))
        ||clearPoints.some(p=>pointInPolygon(fitted,p))
        ||avoidRoutes.some(path=>path.some((p,i)=>i>0&&segmentTouchesPolygon(path[i-1],p,fitted)));
      if(!touches)break;
      blocked=attempt===2;
      fitted=fitPolygon(scalePolygon(fitted,0.7),box);
    }
    if(!fitted||fitted.length<3){issues.push({id:f.id,code:'OVERVIEW_FEATURE_GEOMETRY_INVALID'});continue;}
    if(blocked){issues.push({id:f.id,code:'OVERVIEW_FEATURE_BLOCKED'});continue;}
    pushFeature({...base,polygon:fitted});
  }

  return {
    ok:true,kind:'overview',id:spec.id,name:spec.name??spec.id,bounds:{x:0,y:0,w:W,h:H},surface,
    pins:ordered(pins),shapes:ordered(shapes),routes:ordered(routes),features:ordered(features),issues,
  };
}

/** 稳定抖动轮廓：8–12 顶点；城市/聚落近矩形圆角，自然区域可不规则（02 §6.3 步 3）。 */
function zonePolygon(zone,cx,cy,r,seed){
  const R=randOf(`${seed}/zone/${zone.id}`);
  const count=8+Math.floor(R()*5);
  const rounded=URBAN_ROLES.has(String(zone.role));
  const points=[];
  for(let i=0;i<count;i++){
    const angle=(i/count)*Math.PI*2+(rounded?Math.PI/count:0);
    const jitter=rounded?1+(R()-0.5)*0.16:1+(R()-0.5)*0.44;
    points.push(pt(cx+Math.cos(angle)*r*jitter,cy+Math.sin(angle)*r*jitter));
  }
  return points;
}
function pointsTouch(a,b){
  return a.some(p=>pointInPolygon(b,p))||b.some(p=>pointInPolygon(a,p));
}
function segmentTouchesPolygon(a,b,poly){
  if(pointInPolygon(poly,a)||pointInPolygon(poly,b))return true;
  const cross=(o,p,q)=>(p.x-o.x)*(q.y-o.y)-(p.y-o.y)*(q.x-o.x);
  for(let i=0;i<poly.length;i++){
    const c=poly[i],d=poly[(i+1)%poly.length];
    if(cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0)return true;
  }
  return false;
}
