import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {projectReferenceData,referenceGeometry} from '../ui/atlas-reference-data.mjs';
import {projectMapView} from '../vendor/atlas-spatial/view-adapter.mjs';

const view=items=>({branchId:'main',revision:0,items});
const world={mapId:'world',name:'测试世界',kind:'world',containerLocationId:null,points:[{entityId:'place',kind:'location',name:'测试建筑',mapId:'world',x:10,y:10}]};
const inside={mapId:'inside',name:'测试建筑内部',kind:'interior',containerLocationId:'place',containerLocationKind:'room',points:[
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
 vm.runInContext(source.slice(source.indexOf('function terrainWorld('),source.indexOf('function worldMap(')),runtime);
 runtime.terrainWorld({overviewShapes:[{pts:[[0,0],[10,0],[10,10]],quality:'estimated',c:'#43e0ff'}],overviewRoutes:[{points:[[0,0],[10,10]],dashed:true}]},100,100);
 assert.equal(calls.filter(c=>c==='stroke').length,2);assert.equal(calls.filter(c=>c==='fill').length,1);assert.ok(calls.some(c=>Array.isArray(c)&&c.length===2));
});
