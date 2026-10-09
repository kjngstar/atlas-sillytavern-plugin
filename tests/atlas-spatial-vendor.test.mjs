// 审查补充（ATLAS-UI-Spatial-审查补充-20261006.md）必修项的 vendor 层验收测试。
// 必修1：增量约束合并（generation.mjs）
// 必修2：嵌套可见性清洗 + 隐藏路线过滤（view-adapter.mjs）
// 必修4：路线 DTO 几何转换（projectMapView）
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Kit from '../vendor/atlas-spatial/index.mjs';

const scope={chatId:'chat-1',branchId:'b1',revision:3,viewMode:'author'};
const POV={...scope,viewMode:'pov'};
const baseRooms=()=>Array.from({length:6},(_,i)=>({id:'room-'+i,name:'房间'+i,side:i%2?'north':'south',w:6,h:5}));
const baseCtx=(locations)=>({scope,currentScope:scope,map:{id:'map-1',name:'fixture',metersPerCell:2,frame:{cols:15,rows:12}},entities:{locations,characters:['npc-1'],items:['item-1']}});

test('四米车厢可容纳一米深的相对座椅和暗柜；旧部分布局不能直接复用为空图',()=>{
 const ctx={...baseCtx(['carriage']),map:{id:'map-1',name:'车厢',containerLocationId:'carriage',metersPerCell:.24,frame:{cols:100,rows:100}}};
 const spec={rooms:[{id:'carriage',name:'车厢',w:4,h:6,side:'north'}],contents:[
  {id:'cabinet',type:'shelf',roomId:'carriage',w:1,h:1},
  {id:'seat-a',type:'bench',roomId:'carriage',w:3,h:1},
  {id:'seat-b',type:'bench',roomId:'carriage',w:3,h:1}],actors:[{id:'npc-1',roomId:'carriage',near:'seat-a'}]};
 const first=Kit.generateFloor(spec,ctx);
 assert.equal(first.ok,true,JSON.stringify(first.issues));
 assert.equal(first.scene.layout.groups.length,3,JSON.stringify(first.issues));
 assert.equal(first.scene.layout.actors.length,1);
 const broken=Kit.clone(first.scene);broken.layout.groups=[];broken.layout.bodies=[];broken.layout.issues=[{id:'seat-a',code:'DETAIL_NO_SPACE'}];
 const repaired=Kit.generateFloor(spec,{...ctx,previousScene:broken});
 assert.notEqual(repaired.status,'reused');assert.equal(repaired.scene.layout.groups.length,3);
 assert.ok(!repaired.issues.some(i=>i.code==='DETAIL_NO_SPACE'),JSON.stringify(repaired.issues));
});
test('没有河流资料的城市仍生成可读多边形、道路和建筑，水域为空',()=>{
 const ctx={...baseCtx(['district','building']),map:{id:'map-1',name:'无河城市',metersPerCell:10,frame:{cols:120,rows:100}}};
 const result=Kit.generateCity({riverWidth:0,districts:[{id:'district',name:'城区',bank:'west',order:0}],buildings:[{id:'building',districtId:'district',name:'市场',w:40,h:30}]},ctx);
 assert.equal(result.ok,true,JSON.stringify(result.issues));assert.equal(result.scene.layout.river,null);
 assert.equal(result.scene.layout.dock,null);assert.ok(result.scene.layout.districts[0].polygon.length>=3);
 assert.ok(result.scene.layout.buildings.some(b=>b.id==='building'));assert.ok(result.scene.layout.roads.length);
 assert.deepEqual(Kit.checkSceneDocument(result.scene),[]);
});

// ---------- 必修1：增量约束合并 ----------

test('审查1：六房间基础上只请求一个新增房间，结果为七房间且旧房间位置保留',()=>{
  const rooms=baseRooms();
  const first=Kit.generateFloor({mapId:'map-1',rooms},baseCtx(rooms.map(r=>r.id)));
  assert.equal(first.ok,true);
  assert.equal(first.scene.layout.rooms.length,6);
  assert.equal(first.scene.constraints.rooms.length,6);
  const sevenRooms=[...rooms,{id:'room-6',name:'新房间',side:'north',w:5,h:4}];
  const second=Kit.generateFloor({mapId:'map-1',rooms:[{id:'room-6',name:'新房间',side:'north',w:5,h:4}]},
    {...baseCtx(sevenRooms.map(r=>r.id)),previousScene:first.scene});
  assert.equal(second.ok,true);
  assert.equal(second.scene.layout.rooms.length,7);
  for(const old of first.scene.layout.rooms){
    const kept=second.scene.layout.rooms.find(r=>r.id===old.id);
    assert.ok(kept,'旧房间不得消失：'+old.id);
    assert.deepEqual([kept.x,kept.y,kept.w,kept.h],[old.x,old.y,old.w,old.h],'未变房间几何不得重排：'+old.id);
  }
});

test('审查1：省略的家具与人物约束自动保留，不因模型省略而丢失',()=>{
  const rooms=baseRooms();
  const full={mapId:'map-1',rooms,contents:[{id:'shelf-1',roomId:'room-0',type:'shelf',w:2,h:1}],actors:[{id:'npc-1',roomId:'room-1'}],items:[{id:'item-1',on:'shelf-1'}]};
  const first=Kit.generateFloor(full,baseCtx(rooms.map(r=>r.id)));
  assert.equal(first.ok,true);
  const second=Kit.generateFloor({mapId:'map-1',rooms:[{id:'room-6',side:'north',w:5,h:4}]},
    {...baseCtx([...rooms.map(r=>r.id),'room-6']),previousScene:first.scene});
  assert.equal(second.ok,true);
  assert.ok(second.scene.constraints.contents.some(c=>c.id==='shelf-1'),'省略的家具约束被保留');
  assert.ok(second.scene.constraints.actors.some(a=>a.id==='npc-1'),'省略的人物约束被保留');
  assert.ok(second.scene.constraints.items.some(i=>i.id==='item-1'),'省略的物品约束被保留');
});

test('审查1：删除必须显式表达（deletes），未删除项不受影响',()=>{
  const rooms=baseRooms();
  const first=Kit.generateFloor({mapId:'map-1',rooms},baseCtx(rooms.map(r=>r.id)));
  const second=Kit.generateFloor({mapId:'map-1',rooms:[],deletes:{rooms:['room-0']}},
    {...baseCtx(rooms.filter(r=>r.id!=='room-0').map(r=>r.id)),previousScene:first.scene});
  assert.equal(second.ok,true);
  assert.equal(second.scene.layout.rooms.length,5);
  assert.equal(second.scene.layout.rooms.some(r=>r.id==='room-0'),false);
  assert.ok(second.scene.constraints.rooms.some(r=>r.id==='room-1'),'未删除的房间保留');
});

test('审查1：未知删除目标集合给出警告且不影响有效删除',()=>{
  const rooms=baseRooms();
  const first=Kit.generateFloor({mapId:'map-1',rooms},baseCtx(rooms.map(r=>r.id)));
  const second=Kit.generateFloor({mapId:'map-1',rooms:[],deletes:{rooms:['room-0'],bogus:['x']}},
    {...baseCtx(rooms.filter(r=>r.id!=='room-0').map(r=>r.id)),previousScene:first.scene});
  assert.equal(second.ok,true);
  assert.equal(second.scene.layout.rooms.length,5);
  assert.ok(second.issues.some(i=>i.code==='DELETE_TARGET_UNKNOWN'));
});

test('审查1：rebuild=true 才是整图重建语义',()=>{
  const rooms=baseRooms();
  const first=Kit.generateFloor({mapId:'map-1',rooms},baseCtx(rooms.map(r=>r.id)));
  const second=Kit.generateFloor({mapId:'map-1',rooms:[{id:'room-6',side:'north',w:5,h:4}],rebuild:true},
    {...baseCtx([...rooms.map(r=>r.id),'room-6']),previousScene:first.scene});
  assert.equal(second.ok,true);
  assert.equal(second.scene.layout.rooms.length,1,'rebuild 后只含本次请求的房间');
  assert.ok(!second.issues.some(i=>i.code==='CONSTRAINTS_LEGACY'),'显式 rebuild 不产生旧场景警告');
});

test('审查1：旧格式场景（无受控约束字段）按整图重建处理并给出明确警告',()=>{
  const rooms=baseRooms();
  const first=Kit.generateFloor({mapId:'map-1',rooms},baseCtx(rooms.map(r=>r.id)));
  const legacy=Kit.clone(first.scene);delete legacy.constraints;
  const second=Kit.generateFloor({mapId:'map-1',rooms:[{id:'room-6',side:'north',w:5,h:4}]},
    {...baseCtx([...rooms.map(r=>r.id),'room-6']),previousScene:legacy});
  assert.equal(second.ok,true);
  assert.equal(second.scene.layout.rooms.length,1);
  assert.ok(second.issues.some(i=>i.code==='CONSTRAINTS_LEGACY'&&i.severity==='warning'));
});

test('审查1：生成失败时旧场景经 kept 完整保留（含约束）',()=>{
  const rooms=baseRooms();
  const first=Kit.generateFloor({mapId:'map-1',rooms},baseCtx(rooms.map(r=>r.id)));
  const bad=Kit.generateFloor({mapId:'other',rooms:[{id:'room-6',side:'north',w:5,h:4}]},
    {...baseCtx([...rooms.map(r=>r.id),'room-6']),previousScene:first.scene});
  assert.equal(bad.ok,false);
  assert.equal(bad.issues[0].code,'MAP_ID_MISMATCH');
  assert.deepEqual(bad.kept,first.scene,'失败必须保留旧图（含受控约束）');
});

test('审查1：无变化的重复请求命中 reused 快速路径',()=>{
  const rooms=baseRooms();
  const first=Kit.generateFloor({mapId:'map-1',rooms},baseCtx(rooms.map(r=>r.id)));
  const second=Kit.generateFloor({mapId:'map-1',rooms},baseCtx(rooms.map(r=>r.id),));
  const third=Kit.generateFloor({mapId:'map-1',rooms},{...baseCtx(rooms.map(r=>r.id)),previousScene:second.scene});
  assert.equal(third.status,'reused');
  assert.deepEqual(third.scene,second.scene);
});

// ---------- 必修2：嵌套可见性清洗 + 隐藏路线过滤 ----------

test('审查2：房间上的 privateExtension 在 POV 服务端输出中被剥离',()=>{
  const rooms=baseRooms();
  const first=Kit.generateFloor({mapId:'map-1',rooms},baseCtx(rooms.map(r=>r.id)));
  const doc=Kit.clone(first.scene);
  doc.layout.rooms[0].privateExtension={hiddenEntityId:'secret-room',secret:'top-secret'};
  const r=Kit.filterSceneForView(doc,{scope:POV,visibleLocations:rooms.map(x=>x.id),visibleCharacters:['npc-1'],visibleItems:['item-1']});
  assert.equal(r.ok,true);
  const json=JSON.stringify(r.scene);
  assert.ok(!json.includes('privateExtension'),'POV JSON 不得出现 privateExtension');
  assert.ok(!json.includes('secret-room'),'POV JSON 不得出现隐藏实体 ID');
  assert.ok(!json.includes('top-secret'),'POV JSON 不得出现私密内容');
  assert.ok(!('constraints' in r.scene),'POV JSON 不得携带受控约束');
  assert.ok(!('inputSignature' in r.scene),'POV JSON 不得携带 inputSignature');
});

test('审查2：author 视角保留完整场景（含私密扩展），清洗只作用于 POV',()=>{
  const rooms=baseRooms();
  const first=Kit.generateFloor({mapId:'map-1',rooms},baseCtx(rooms.map(r=>r.id)));
  const doc=Kit.clone(first.scene);
  doc.layout.rooms[0].privateExtension={hiddenEntityId:'secret-room',secret:'top-secret'};
  const r=Kit.filterSceneForView(doc,{scope,visibleLocations:rooms.map(x=>x.id)});
  assert.equal(r.ok,true);
  assert.ok(JSON.stringify(r.scene).includes('privateExtension'));
});

const overviewScene=(routes)=>({kind:'atlas-scene',version:1,generator:'test/1',mapId:'map-1',branchId:'b1',sourceRevision:3,units:'cells',metersPerCell:null,metricQuality:'uncalibrated',inputSignature:'sig-should-not-leak',layout:{id:'map-1',name:'overview',kind:'overview',bounds:{x:0,y:0,w:30,h:24},pins:[],shapes:[],routes,features:[]}});

test('审查2：overview 路线按端点可见性过滤——隐藏路线、无依据路线均不下发 POV',()=>{
  const scene=overviewScene([
    {id:'route-ok',kind:'route',mapId:'map-1',path:[{x:0,y:0},{x:5,y:5}],quality:'estimated',dashed:true,progress:null,fromLocationId:'loc-a',toLocationId:'loc-b'},
    {id:'route-hidden-end',kind:'route',mapId:'map-1',path:[{x:1,y:1},{x:6,y:6}],quality:'estimated',dashed:true,progress:null,fromLocationId:'loc-a',toLocationId:'loc-secret'},
    {id:'route-no-basis',kind:'route',mapId:'map-1',path:[{x:2,y:2},{x:7,y:7}],quality:'estimated',dashed:true,progress:null},
    {id:'route-flagged',kind:'route',mapId:'map-1',path:[{x:3,y:3},{x:8,y:8}],quality:'estimated',dashed:true,progress:null,fromLocationId:'loc-a',toLocationId:'loc-b',hidden:true},
  ]);
  const r=Kit.filterSceneForView(scene,{scope:POV,visibleLocations:['loc-a','loc-b']});
  assert.equal(r.ok,true);
  assert.deepEqual(r.scene.layout.routes.map(x=>x.id),['route-ok'],'只有全部端点可见的路线可以下发 POV');
  const json=JSON.stringify(r.scene);
  assert.ok(!json.includes('loc-secret'),'隐藏端点 ID 不得出现');
  assert.ok(!json.includes('route-hidden-end'),'隐藏路线 ID 与路径不得出现');
  assert.ok(!json.includes('inputSignature'),'inputSignature 不得出现');
});

test('审查2：author 视角看到全部路线（含隐藏标记）',()=>{
  const scene=overviewScene([
    {id:'route-ok',kind:'route',mapId:'map-1',path:[{x:0,y:0},{x:5,y:5}],quality:'estimated',dashed:true,progress:null,fromLocationId:'loc-a',toLocationId:'loc-b'},
    {id:'route-hidden-end',kind:'route',mapId:'map-1',path:[{x:1,y:1},{x:6,y:6}],quality:'estimated',dashed:true,progress:null,fromLocationId:'loc-a',toLocationId:'loc-secret'},
  ]);
  const r=Kit.filterSceneForView(scene,{scope,visibleLocations:['loc-a','loc-b','loc-secret']});
  assert.equal(r.scene.layout.routes.length,2);
});

test('审查2：publicMapFrame 同时剥离 atlasScene 与 atlasLayoutRequest',()=>{
  const frame=Kit.publicMapFrame({cols:15,rows:12,origin_x:1,atlasScene:{kind:'atlas-scene'},atlasLayoutRequest:{kind:'floor'}});
  assert.deepEqual(frame,{cols:15,rows:12,origin_x:1});
});

// ---------- 必修4：路线 DTO 几何转换 ----------

const routeView=(routes)=>({branchId:'b1',revision:3,items:[{mapId:'map-1',name:'fixture',metersPerCell:2,frames:{frame:{cols:15,rows:12}},points:[],routes,coarseList:[]}]});

test('审查4：插件存储格式 {kind:"line",coordinates:[[x,y]]} 被转换为可绘路线并携带端点依据',()=>{
  const r=Kit.projectMapView({view:routeView([
    {routeId:'rt-1',mapId:'map-1',geometryQuality:'confirmed',geometry:JSON.stringify({kind:'line',coordinates:[[1,2],[3,4],[5,6]]}),fromLocationId:'loc-a',toLocationId:'loc-b'},
  ]),mapId:'map-1',scope});
  assert.equal(r.ok,true);
  assert.equal(r.scene.layout.routes.length,1);
  const route=r.scene.layout.routes[0];
  assert.deepEqual(route.path,[{x:2,y:4},{x:6,y:8},{x:10,y:12}],'cells 坐标按 metersPerCell=2 转换');
  assert.equal(route.quality,'confirmed');
  assert.equal(route.fromLocationId,'loc-a');
  assert.equal(route.toLocationId,'loc-b');
});

test('审查4：多边形边界不当作行走路线，给出单项诊断',()=>{
  const r=Kit.projectMapView({view:routeView([
    {routeId:'rt-poly',mapId:'map-1',geometryQuality:'estimated',geometry:JSON.stringify({kind:'polygon',coordinates:[[0,0],[4,0],[4,4],[0,4]]})},
  ]),mapId:'map-1',scope});
  assert.equal(r.ok,true);
  assert.equal(r.scene.layout.routes.length,0);
  assert.ok(r.issues.some(i=>i.code==='ROUTE_GEOMETRY_KIND'&&i.entityId==='rt-poly'));
});

test('审查4：旧 points 形状向后兼容',()=>{
  const r=Kit.projectMapView({view:routeView([
    {routeId:'rt-legacy',mapId:'map-1',geometryQuality:'estimated',geometry:JSON.stringify({mapId:'map-1',points:[{x:1,y:1},{x:2,y:2}]})},
  ]),mapId:'map-1',scope});
  assert.equal(r.ok,true);
  assert.deepEqual(r.scene.layout.routes[0].path,[{x:2,y:2},{x:4,y:4}]);
});

test('审查4：非有限坐标（含 JSON null 化的 NaN）的路线单项诊断并跳过，不影响其他路线',()=>{
  const r=Kit.projectMapView({view:routeView([
    {routeId:'rt-bad',mapId:'map-1',geometryQuality:'estimated',geometry:JSON.stringify({kind:'line',coordinates:[[1,1],[NaN,2]]})},
    {routeId:'rt-null',mapId:'map-1',geometryQuality:'estimated',geometry:JSON.stringify({kind:'line',coordinates:[[1,1],[null,2]]})},
    {routeId:'rt-good',mapId:'map-1',geometryQuality:'estimated',geometry:JSON.stringify({kind:'line',coordinates:[[0,0],[1,1]]})},
  ]),mapId:'map-1',scope});
  assert.equal(r.ok,true);
  assert.equal(r.scene.layout.routes.length,1);
  assert.equal(r.scene.layout.routes[0].id,'rt-good');
  assert.ok(r.issues.some(i=>i.code==='ROUTE_COORDS_INVALID'&&i.entityId==='rt-bad'));
  assert.ok(r.issues.some(i=>i.code==='ROUTE_COORDS_INVALID'&&i.entityId==='rt-null'));
});

test('审查4：属于其他地图的路线不投影到当前地图',()=>{
  const r=Kit.projectMapView({view:routeView([
    {routeId:'rt-other',mapId:'map-2',geometryQuality:'estimated',geometry:JSON.stringify({kind:'line',coordinates:[[0,0],[1,1]]})},
  ]),mapId:'map-1',scope});
  assert.equal(r.ok,true);
  assert.equal(r.scene.layout.routes.length,0);
});
