import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {projectReferenceData,referenceGeometry} from '../ui/atlas-reference-data.mjs';
import {projectMapView} from '../vendor/atlas-spatial/view-adapter.mjs';

const view=items=>({branchId:'main',revision:0,items});
// 契约（src/atlas-db-views.ts 的 MapViewItem）里 parentMapId/connectionQuality 是**必填**的：
// 导航父子关系只认 parentMapId，不再由 containerLocationId 反推包含。夹具必须照真实 DTO 写全。
const world={mapId:'world',name:'测试世界',kind:'world',containerLocationId:null,parentMapId:null,connectionQuality:'root',points:[{entityId:'place',kind:'location',name:'测试建筑',mapId:'world',x:10,y:10}]};
const inside={mapId:'inside',name:'测试建筑内部',kind:'interior',containerLocationId:'place',containerLocationKind:'room',parentMapId:'world',connectionQuality:'contained',points:[
 {entityId:'actor',kind:'character',name:'测试人物',mapId:'inside',x:5,y:5,locationId:'place'},
 {entityId:'item',kind:'item',name:'测试物品',mapId:'inside',x:6,y:5,locationId:'place'},
]};
const catalog=[{entityId:'place',entityKind:'location',name:'测试建筑',mapId:'world'},
 {entityId:'actor',entityKind:'character',name:'测试人物',locationId:'place'},
 {entityId:'item',entityKind:'item',name:'测试物品',locationId:'place',mapId:'world'}];
const app=readFileSync(new URL('../ui/atlas-reference/js/app.js',import.meta.url),'utf8');
function markerHarness(D){
 const ctx=vm.createContext({D,state:{nodeId:'inside',viewMode:'author'},window:{AtlasMap:{create:(_a,_b,c)=>{ctx.options=c;return {};}}},$:()=>null,frameChrome:()=>{}});
 vm.runInContext(app.slice(app.indexOf('function nodes('),app.indexOf('function message(')),ctx);
 vm.runInContext(app.slice(app.indexOf('const map=window.AtlasMap.create('),app.indexOf('const presetUI=')),ctx);
 return ctx;
}
test('实际子地图里的在场人物与地面物品通过标记筛选；计数和画布一致',()=>{
 const d=projectReferenceData({mapView:view([world,inside]),catalogView:view(catalog),viewMode:'author'}),ctx=markerHarness(d),node=d.ROOT.children[0];
 assert.equal(d.ITEMS[0].mapNodeId,'inside');
 assert.equal(ctx.sceneCast().length,1);assert.equal(ctx.sceneItems().length,1);
 assert.deepEqual(Array.from(ctx.options.getMarks(node,node.marks).map(m=>m.id)),['actor','item']);
});
test('人物在途或位置未知时不能因为保留旧视觉点而重新出现',()=>{
 const d=projectReferenceData({mapView:view([world,inside]),catalogView:view(catalog),viewMode:'author'}),ctx=markerHarness(d),node=d.ROOT.children[0];
 for(const state of ['away','unknown','off']){d.CAST[0].state=state;assert.equal(ctx.options.getMarks(node,node.marks).filter(m=>m.type==='char').length,0);}
});
function overviewFixture(){
 const map={...world,metersPerCell:2,points:[{...world.points[0],markerQuality:'exact',area:{kind:'polygon',points:[{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}]}},
 {entityId:'other',kind:'location',name:'测试终点',mapId:'world',x:20,y:20}],routes:[
 {routeId:'route',fromLocationId:'place',toLocationId:'other',geometryQuality:'confirmed',geometry:{mapId:'world',units:'cells',points:[{x:10,y:10},{x:20,y:20}]}},
 {routeId:'estimated',fromLocationId:'place',toLocationId:'other',geometryQuality:'estimated',geometry:{mapId:'world',units:'cells',points:[{x:10,y:10},{x:15,y:15}]}},
 ]};
 const result=projectMapView({view:view([map]),mapId:'world',scope:{chatId:'test',branchId:'main',revision:0,viewMode:'author'}});
 return {map,scene:result.scene};
}
test('SQL 概览的范围与路线保留到原 UI；沿用同一坐标变换和估计标记',()=>{
 const {map,scene}=overviewFixture(),geometry=referenceGeometry(map,scene);
 assert.equal(geometry.geo.overviewShapes.length,1);assert.equal(geometry.geo.overviewShapes[0].pts.length,4);
 assert.equal(geometry.geo.overviewRoutes.length,2);assert.equal(geometry.geo.overviewRoutes[0].dashed,false);assert.equal(geometry.geo.overviewRoutes[1].dashed,true);
 assert.deepEqual(geometry.geo.overviewRoutes[0].points[0],[geometry.marks[0].x,geometry.marks[0].y]);
 assert.equal(geometry.metric,1/geometry.transform.scale);
});
test('主角视图不画隐藏端点、无端点依据或明确隐藏的概览路线',()=>{
 const {map,scene}=overviewFixture();
 assert.equal(referenceGeometry(map,scene,{viewMode:'pov',visibleLocationIds:['place']}).geo.overviewRoutes.length,0);
 assert.equal(referenceGeometry(map,scene,{viewMode:'pov',visibleLocationIds:['place','other']}).geo.overviewRoutes.length,2);
 scene.layout.routes[0].hidden=true;delete scene.layout.routes[1].toLocationId;
 assert.equal(referenceGeometry(map,scene,{viewMode:'pov',visibleLocationIds:['place','other']}).geo.overviewRoutes.length,0);
});
test('损坏的单条路径或范围被忽略，不影响其余合法几何',()=>{
 const {map,scene}=overviewFixture();
 scene.layout.routes.push({id:'bad',path:[{x:NaN,y:2},{x:3,y:4}]});scene.layout.shapes.push({id:'bad',polygon:[{x:Infinity,y:2},{x:3,y:4},{x:5,y:6}]});
 const g=referenceGeometry(map,scene);assert.equal(g.geo.overviewRoutes.length,2);assert.equal(g.geo.overviewShapes.length,1);
});
test('没有陈设布局时，原渲染器仍实际描绘 SQL 概览路线与范围',()=>{
 const calls=[],ctx={createLinearGradient:()=>({addColorStop(){}}),fillRect(){},save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},closePath(){},fill(){calls.push('fill');},stroke(){calls.push('stroke');},setLineDash(value){calls.push(Array.from(value));}};
 const source=readFileSync(new URL('../ui/atlas-reference/js/map.js',import.meta.url),'utf8');
 const runtime=vm.createContext({ctx,st:{node:{host:true,sceneStatus:'missing'},cam:{s:1},kind:'world'},extent:()=>[-50,50,-50,50],hexA:()=> 'test'});
 // 概览渲染依赖模块级的面形材质/装饰缓存工具，夹具必须把这段上下文一起注入。
 vm.runInContext(source.slice(source.indexOf('/* ───────── M6-05 概览背景'),source.indexOf('function create(canvas'))
   +source.slice(source.indexOf('function terrainWorld('),source.indexOf('function worldMap(')),runtime);
 runtime.terrainWorld({overviewShapes:[{pts:[[0,0],[10,0],[10,10]],quality:'estimated',c:'#43e0ff'}],overviewRoutes:[{points:[[0,0],[10,10]],dashed:true}]},100,100);
 assert.equal(calls.filter(c=>c==='stroke').length,2);assert.equal(calls.filter(c=>c==='fill').length,1);assert.ok(calls.some(c=>Array.isArray(c)&&c.length===2));
});

/* ── M6-03：概览背景 / 室内细节投影 ── */

test('M6-03：装饰保真实类型与范围，并与实体共用同一个 xy 变换（只变换一次）',()=>{
 const {map,scene}=overviewFixture();
 scene.layout.features=[
  // 水系：线 + 正宽 + 方向类别 —— G01 要求至少 25 点、宽度正有限、标 decorative/estimated。
  {id:'ft-river',type:'watercourse',quality:'estimated',decorative:true,width:4,widthClass:'medium',fromSector:'west',toSector:'east',
   path:Array.from({length:26},(_,i)=>({x:i,y:5+Math.sin(i/3)}))},
  // 林地：面 + 密度。首点刻意取与 route 起点相同的世界坐标（20,20），用来验「同一变换」。
  {id:'ft-wood',type:'woodland',density:'dense',polygon:[{x:20,y:20},{x:24,y:20},{x:24,y:26}]},
 ];
 const g=referenceGeometry(map,scene);
 assert.equal(g.geo.overviewShapes.length,1);
 const [river,wood]=g.geo.overviewFeatures;
 assert.equal(g.geo.overviewFeatures.length,2);
 assert.equal(river.type,'watercourse');assert.equal(river.decorative,true);
 assert.equal(river.line.length,26,'水系 26 点必须全部保留，不能退化成蓝点');
 assert.ok(river.width>0&&Number.isFinite(river.width),'水系宽度必须是变换后的正有限值');
 assert.equal(river.widthClass,'medium');
 assert.equal(wood.type,'woodland');assert.equal(wood.poly.length,3);assert.equal(wood.line,null);
 // 装饰与实体/路线共用**同一个** xy：同世界坐标 → 同屏幕坐标，且没有被套两层变换。
 assert.deepEqual(wood.poly[0],g.geo.overviewRoutes[0].points[0]);
 assert.deepEqual(g.geo.overviewRoutes[0].points[0],[g.marks[0].x,g.marks[0].y]);
 assert.equal(g.marks.length,2,'装饰不得凭空多出实体标点');
});

test('M6-03：坏装饰几何整条丢弃，不补新地点、不污染其它图元',()=>{
 const {map,scene}=overviewFixture();
 scene.layout.features=[
  {id:'ft-ok',type:'woodland',polygon:[{x:1,y:1},{x:4,y:1},{x:4,y:4}]},
  {id:'ft-nan',type:'watercourse',path:[{x:NaN,y:1},{x:2,y:2}]},
  {id:'ft-2pt',type:'road_texture',path:[{x:1,y:1}]},
 ];
 const g=referenceGeometry(map,scene);
 assert.deepEqual(g.geo.overviewFeatures.map(f=>f.id),['ft-ok']);
 assert.equal(g.marks.length,2);
});

test('M6-03：主角视角丢掉无着落的 zone 装饰，全图公开材质与隐藏端点路线都不放行',()=>{
 const {map,scene}=overviewFixture();
 scene.layout.shapes.push({id:'hidden-zone',name:'未公开地带',polygon:[{x:30,y:0},{x:40,y:0},{x:40,y:10}]});
 scene.layout.routes.push({id:'reveal',fromLocationId:'place',toLocationId:'hidden-zone',path:[{x:10,y:10},{x:30,y:5}]});
 scene.layout.features=[
  {id:'ft-on-hidden',type:'woodland',zoneId:'hidden-zone',polygon:[{x:31,y:1},{x:33,y:1},{x:33,y:3}]},
  {id:'ft-global',type:'terrain',polygon:[{x:2,y:2},{x:4,y:2},{x:4,y:4}]},
 ];
 const author=referenceGeometry(map,scene,{viewMode:'author'});
 assert.deepEqual(author.geo.overviewFeatures.map(f=>f.id),['ft-on-hidden','ft-global']);
 assert.equal(author.geo.overviewRoutes.length,3);
 // POV 下这条 scene 已经过服务端白名单过滤：不可见 zone 的轮廓**不在** shapes 里。
 const povScene=structuredClone(scene);povScene.layout.shapes=povScene.layout.shapes.filter(s=>s.id!=='hidden-zone');
 const pov=referenceGeometry(map,povScene,{viewMode:'pov',visibleLocationIds:['place','other']});
 assert.deepEqual(pov.geo.overviewFeatures.map(f=>f.id),['ft-global'],'zone 无着落时其装饰连同几何一起丢掉');
 assert.ok(!JSON.stringify(pov.geo).includes('hidden-zone'),'POV 不得泄露隐藏 zone 的 ID');
 for(const route of pov.geo.overviewRoutes)assert.ok(!JSON.stringify(route).includes('hidden-zone'),'POV 不得泄露隐藏端点路线');
});

test('M6-03：proxy 只作入口示意——保留真实地点 id，但精度显式降级、不冒充实测',()=>{
 const {map,scene}=overviewFixture();
 scene.layout.shapes.push({id:'far-place',name:'远图地点',placement:'proxy',quality:'confirmed',polygon:[{x:30,y:0},{x:40,y:0},{x:40,y:10}]});
 // 保存场景里的 proxy 标点：坐标在别的图上，这里只是可点。
 scene.layout.pins.push({id:'far-npc',type:'location',name:'远图人物',placement:'proxy',x:32,y:6});
 scene.layout.pins.push({id:'plain-npc',type:'location',name:'无精度人物',x:3,y:3});
 const g=referenceGeometry(map,scene,{viewMode:'author'});
 const shape=g.geo.overviewShapes.find(s=>s.id==='far-place');
 assert.equal(shape.proxy,true);
 assert.equal(shape.quality,'proxy','proxy 轮廓绝不能被标成 confirmed/exact');
 assert.equal(shape.placement,'proxy');
 const far=g.marks.find(m=>m.id==='far-npc'),plain=g.marks.find(m=>m.id==='plain-npc');
 assert.equal(far.proxy,true);assert.equal(far.quality,'proxy');assert.equal(far.sub,'proxy');
 assert.equal(plain.proxy,false);assert.equal(plain.quality,'','缺精度就是空，不许被升格成 exact');
 assert.ok(Number.isFinite(far.x)&&Number.isFinite(far.y),'示意图标仍要有可点坐标');
});

test('M6-03：室内家具保真实 local id / type / roomId，真实类型不被渲染类别吃掉',()=>{
 const map={mapId:'car',name:'车厢',kind:'interior',containerLocationId:'car',containerLocationKind:'vehicle',parentMapId:'world',connectionQuality:'contained',points:[]};
 const scene={units:'meters',layout:{kind:'floor',bounds:{x:0,y:0,w:10,h:8},corridor:{x:0,y:3,w:10,h:1},
  rooms:[{id:'R1',name:'一号厢',x:0,y:0,w:5,h:3,status:'private'},{id:'R2',name:'二号厢',x:5,y:0,w:5,h:3}],
  doors:[{id:'door:R1',roomId:'R1',x:2.5,y:3,width:1}],
  windows:[{id:'window:R1:0',roomId:'R1',x:1.2,y:0,width:1.2}],
  lamps:[{id:'light:R1',roomId:'R1',x:2.5,y:1.4,elevation:2.8}],
  groups:[
   {id:'f-bed',roomId:'R1',x:.5,y:.5,w:1,h:2,bodies:[
    {id:'f-bed:bed',type:'bed',groupId:'f-bed',roomId:'R1',solid:true,x:.5,y:.5,w:1,h:2},
    {id:'f-bed:pillow',type:'pillow',groupId:'f-bed',roomId:'R1',solid:false,x:.6,y:.6,w:.8,h:.25}]},
   {id:'f-bench',roomId:'R2',x:6,y:1,w:1.5,h:.4,bodies:[
    {id:'f-bench:bench',type:'bench',groupId:'f-bench',roomId:'R2',solid:true,x:6,y:1,w:1.5,h:.4},
    {id:'f-bench:chair',type:'chair',groupId:'f-bench',roomId:'R2',solid:true,x:7,y:1,w:.35,h:.35},
    {type:'cabinet',placement:'proxy',x:8,y:1,w:.6,h:.6}]},
  ],actors:[{id:'C1',name:'乘客',roomId:'R1',x:4.5,y:2.5,quality:'layout'}],items:[]}};
 const g=referenceGeometry(map,scene,{viewMode:'author'});
 assert.equal(g.kind,'floor');
 const furn=g.geo.furn,byId=new Map(furn.map(f=>[f.id,f]));
 assert.equal(new Set(furn.map(f=>f.id)).size,furn.length,'同一组里每件家具必须有各自稳定 ID，不能再共用组 ID');
 assert.deepEqual(Array.from(byId.keys()),['f-bed:bed','f-bed:pillow','f-bench:bench','f-bench:chair','f-bench:cabinet:4']);
 assert.equal(byId.get('f-bed:bed').type,'bed');assert.equal(byId.get('f-bed:bed').t,'bed');
 assert.equal(byId.get('f-bed:bed').roomId,'R1');assert.equal(byId.get('f-bed:bed').solid,true);assert.equal(byId.get('f-bed:bed').detail,true);
 assert.equal(byId.get('f-bed:pillow').solid,false);
 assert.equal(byId.get('f-bench:bench').type,'bench');assert.equal(byId.get('f-bench:bench').t,'table','旧画法类别仍保留 table');
 assert.equal(byId.get('f-bench:chair').type,'chair','chair 的真实类型不得被 table 覆盖');
 assert.equal(byId.get('f-bench:cabinet:4').proxy,true,'proxy 陈设只作示意，不当实测坐标');
 for(const f of furn)assert.ok(!('n' in f),'渲染密度不该由投影层编造一个固定数字');
 assert.equal(g.geo.rooms[0].status,'private','房间状态取真实字段，不用固定文案');
 assert.equal(g.geo.doors[0].id,'door:R1');assert.equal(g.geo.windows[0].id,'window:R1:0');assert.equal(g.geo.lamps[0].id,'light:R1');
 assert.equal(g.geo.lamps[0].elevation,2.8);
 const actor=g.marks.find(m=>m.id==='C1');
 assert.equal(actor.quality,'layout','示意坐标不得被升格成 exact');
});

/* ── M6-05：概览背景绘制顺序、跨帧稳定与视口裁剪 ── */

/** 记录式 canvas 替身：只记 ops 与当时的样式，不做像素断言（像素交给 M7 真浏览器）。 */
function recordCtx(){
 const log=[];
 const c={fillStyle:'',strokeStyle:'',lineWidth:0,lineCap:'',lineJoin:'',font:'',textAlign:'',textBaseline:'',
  globalAlpha:1,shadowBlur:0,shadowColor:'',dash:[],
  save(){log.push({op:'save'});},restore(){log.push({op:'restore'});},
  beginPath(){},closePath(){},moveTo(){},lineTo(){},bezierCurveTo(){},quadraticCurveTo(){},rect(){},ellipse(){},
  fill(){log.push({op:'fill',fill:typeof c.fillStyle==='string'?c.fillStyle:'gradient'});},
  stroke(){log.push({op:'stroke',stroke:typeof c.strokeStyle==='string'?c.strokeStyle:'gradient',dash:[...c.dash]});},
  fillRect(){log.push({op:'fillRect',fill:typeof c.fillStyle==='string'?c.fillStyle:'gradient'});},
  clearRect(){},clip(){log.push({op:'clip'});},
  arc(x,y,r){log.push({op:'arc',x,y,r});},
  fillText(){},measureText:()=>({width:10}),drawImage(){},translate(){},scale(){},rotate(){},setTransform(){},
  setLineDash(v){c.dash=Array.from(v||[]);},
  createLinearGradient:()=>({addColorStop(){}}),createRadialGradient:()=>({addColorStop(){}}),createPattern:()=>null};
 return {ctx:c,log};
}
function overviewRuntime(ctx,st){
 const source=readFileSync(new URL('../ui/atlas-reference/js/map.js',import.meta.url),'utf8');
 const runtime=vm.createContext({ctx,st,extent:()=>[-50,50,-50,50],hexA:(c,a)=>c+'@'+a});
 // 工具区（hash/rng/smooth/rrect/glow + M6-05 概览背景）与世界空间渲染段必须一起注入，
 // 否则 terrainWorld 里的装饰绘制找不到 smooth/hexA 这些模块级依赖。
 vm.runInContext(source.slice(source.indexOf('function hash(s)'),source.indexOf('function create(canvas'))
  +source.slice(source.indexOf('function terrainWorld('),source.indexOf('function worldMap(')),runtime);
 return runtime;
}
const OVERVIEW_GEO={
 surface:'forest',
 overviewShapes:[{id:'z1',c:'#43e0ff',quality:'estimated',role:'city',pts:[[0,0],[10,0],[10,10]]}],
 overviewFeatures:[
  {id:'river',type:'watercourse',decorative:true,width:3,line:[[-20,0],[-10,2],[0,0]]},
  {id:'wood',type:'forest_texture',density:'medium',poly:[[2,2],[8,2],[8,8]]},
 ],
 overviewRoutes:[{id:'r',dashed:true,points:[[0,0],[10,10]]}],
};

test('M6-05：概览严格按 surface→zone→装饰→道路→建筑群 铺层',()=>{
 const {ctx,log}=recordCtx();
 const runtime=overviewRuntime(ctx,{node:{host:true,sceneStatus:'missing'},cam:{s:1,x:0,y:0},vw:400,vh:400,kind:'world'});
 runtime.terrainWorld(OVERVIEW_GEO,400,400);
 const at=pred=>log.findIndex(pred);
 const surface=at(e=>e.op==='fillRect');
 const zone=at(e=>e.op==='fill'&&e.fill==='#43e0ff@0.1');
 const river=at(e=>e.op==='stroke'&&e.stroke==='rgba(90,215,255,.55)');
 const road=at(e=>e.op==='stroke'&&e.stroke==='rgba(127,212,255,.42)');
 const slab=at(e=>e.op==='stroke'&&e.stroke==='#43e0ff@0.55');
 assert.ok(surface>=0,'必须先铺 surface 底色');
 assert.ok(zone>surface,'zone 填色在底色之后');
 assert.ok(river>zone,'林地/水岸装饰在 zone 之后');
 assert.ok(road>river,'道路在装饰之后');
 assert.ok(slab>road,'建筑群质感在道路之后');
});

test('M6-05：装饰点位跨帧稳定，不每帧重撒也不抖动',()=>{
 const {ctx,log}=recordCtx();
 const runtime=overviewRuntime(ctx,{node:{host:true,sceneStatus:'missing'},cam:{s:1,x:0,y:0},vw:400,vh:400,kind:'world'});
 runtime.terrainWorld(OVERVIEW_GEO,400,400);
 const first=log.filter(e=>e.op==='arc').map(e=>[e.x,e.y]);
 assert.ok(first.length>0,'林地必须真的撒出树点');
 log.length=0;
 runtime.terrainWorld(OVERVIEW_GEO,400,400);
 const second=log.filter(e=>e.op==='arc').map(e=>[e.x,e.y]);
 assert.deepEqual(second,first,'同一图元同一密度必须得到完全相同的点位');
});

test('M6-05：视口外的装饰被裁剪；相机不可信时退回全画而不是丢图',()=>{
 const near={id:'near',type:'forest_texture',density:'low',poly:[[-10,-10],[10,-10],[10,10]]};
 const far={id:'far',type:'forest_texture',density:'low',poly:[[5000,5000],[5010,5000],[5010,5010]]};
 const geo={...OVERVIEW_GEO,overviewShapes:[],overviewRoutes:[],overviewFeatures:[near,far]};
 const run=cam=>{const {ctx,log}=recordCtx();const runtime=overviewRuntime(ctx,{node:{host:true,sceneStatus:'missing'},cam,vw:120,vh:120,kind:'world'});runtime.terrainWorld(geo,120,120);return log.filter(e=>e.op==='stroke'&&e.stroke==='rgba(90,220,160,.28)').length;};
 assert.equal(run({s:1,x:0,y:0}),1,'视口外 5000 单位的装饰不该被绘制');
 assert.equal(run({s:NaN,x:0,y:0}),2,'相机不可信时退回全画，绝不静默丢掉整张图');
});
