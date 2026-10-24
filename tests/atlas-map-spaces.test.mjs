import test from 'node:test';
import assert from 'node:assert/strict';
import {generateFloor,generateOverview,generateCity,filterSceneForView,checkSceneDocument} from '../vendor/atlas-spatial/index.mjs';
import {referenceGeometry,projectReferenceData} from '../ui/atlas-reference-data.mjs';
import {baselineFloorRooms} from '../src/atlas-sql-layout-task.ts';
import {reconcileOccupantsSpec} from '../src/atlas-spatial-occupants.ts';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const scope={chatId:'spaces',branchId:'main',revision:1,viewMode:'author'};
const context=()=>({scope,map:{id:'kitchen-map',name:'厨房',containerLocationId:'kitchen',containerKind:'room',containerName:'厨房',frame:{cols:12,rows:19},metersPerCell:1},entities:{locations:['kitchen','store','upper'],characters:['cook'],items:['key']},locationsById:{kitchen:{id:'kitchen',kind:'room'},store:{id:'store',kind:'room'},upper:{id:'upper',kind:'floor'}},locks:{}});
const spec=()=>({rooms:[{id:'store',name:'储物间',w:8,h:8,side:'north'}],contents:[{id:'counter',roomId:'kitchen',type:'cabinet',name:'操作台',w:3,h:1}],actors:[{id:'cook',roomId:'kitchen'}],items:[{id:'key',on:'counter'}]});
const intersects=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;

test('带子房间的厨房保留主空间、操作台、人物和真实物品，均不挤进储物间',()=>{
 const ctx=context(),before=JSON.stringify(ctx),out=generateFloor(spec(),ctx);
 assert.equal(out.ok,true,JSON.stringify(out.issues));assert.deepEqual(out.scene.layout.issues,[]);
 const l=out.scene.layout;assert.deepEqual([l.hostArea.w,l.hostArea.h],[12,19]);
 assert.deepEqual(l.rooms.map(r=>r.id),['store']);assert.equal(l.groups[0].roomId,'kitchen');
 assert.equal(l.actors[0].roomId,'kitchen');assert.equal(l.items[0].roomId,'kitchen');
 assert.equal(intersects(l.rooms[0],l.groups[0]),false);assert.equal(intersects(l.rooms[0],{...l.actors[0],w:.2,h:.2}),false);
 assert.ok(l.groups[0].interaction);assert.equal(l.windows.some(w=>w.roomId==='store'),false);
 assert.deepEqual(checkSceneDocument(out.scene),[]);assert.equal(JSON.stringify(ctx),before);
});
test('厨房主空间保持空间账本身份，刷新时不会把操作台再造一件',()=>{
 const ctx=context();ctx.spaceCanonical={furnishing:[{localId:'space:kitchen:furn:counter',type:'cabinet',name:'操作台',widthM:3,heightM:1,quality:'layout',itemId:'key'}]};
 const input=spec();input.contents=[];input.items=[];const out=generateFloor(input,ctx);
 assert.equal(out.ok,true,JSON.stringify(out.issues));assert.deepEqual(out.scene.layout.groups.map(g=>g.id),['counter']);assert.equal(out.scene.layout.items[0].id,'key');
});
test('已确认的主空间入口被子房间挡住时报告冲突，保留旧场景',()=>{
 const ctx=context();ctx.entryDoors=[{id:'fixed',x:4,y:0,wall:'north',width:1.2,quality:'confirmed'}];
 const out=generateFloor(spec(),ctx);assert.equal(out.ok,false);assert.ok(out.issues.some(i=>i.code==='HOST_ENTRY_BLOCKED'));
});
test('POV 只保留可见主空间及其人物，不透出被隐藏的厨房或陈设',()=>{
 const scene=generateFloor(spec(),context()).scene;
 const visible=filterSceneForView(scene,{scope:{...scope,viewMode:'pov'},visibleLocations:['kitchen','store'],visibleCharacters:['cook'],visibleItems:['key']});
 assert.equal(visible.scene.layout.hostArea.id,'kitchen');assert.equal(visible.scene.layout.actors[0].id,'cook');
 const hidden=filterSceneForView(scene,{scope:{...scope,viewMode:'pov'},visibleLocations:['store'],visibleCharacters:[],visibleItems:[]});
 const json=JSON.stringify(hidden.scene.layout);assert.equal(hidden.scene.layout.hostArea,undefined);assert.equal(hidden.scene.layout.groups.length,0);assert.equal(hidden.scene.layout.actors.length,0);assert.ok(!json.includes('操作台'));
});
test('占用者对账承认容器房间自身，主空间人物及地面物品不会因存在子房间而被清掉',()=>{
 const out=reconcileOccupantsSpec({scene:null,requestSpec:spec(),container:{id:'kitchen',kind:'room'},characters:[{id:'cook',status:'active',location_id:'kitchen'}],items:[{id:'key',status:'active',location_id:'kitchen'}]});
 assert.equal(out.spec.actors[0].roomId,'kitchen');assert.equal(out.spec.items[0].id,'key');assert.deepEqual(out.deleted.actors,[]);
});
test('布局缺少人物物品时补绘 SQL 点位且只换算一次单位；已有场景锚点优先',()=>{
 const scene=generateFloor(spec(),context()).scene;scene.layout.actors=[];scene.layout.items=[];
 const map={mapId:'kitchen-map',containerLocationId:'kitchen',containerLocationKind:'room',metersPerCell:.25,points:[{entityId:'cook',kind:'character',name:'厨师',x:12,y:48,hidden:true},{entityId:'key',kind:'item',name:'钥匙',x:16,y:48}]};
 const g=referenceGeometry(map,scene,{viewMode:'author'}),s=g.transform.scale;
 assert.equal(g.marks.find(m=>m.id==='cook').x,(3-6)*s);assert.equal(g.marks.find(m=>m.id==='key').y,(12-9.5)*s);
 assert.equal(referenceGeometry(map,scene,{viewMode:'pov'}).marks.some(m=>m.id==='cook'),false);
 scene.layout.actors=[{id:'cook',roomId:'kitchen',x:5,y:11}];
 const drawn=referenceGeometry(map,scene).marks.filter(m=>m.id==='cook');assert.equal(drawn.length,1);assert.equal(drawn[0].x,(5-6)*s);
 assert.equal(referenceGeometry({...map,metersPerCell:null},scene).marks.some(m=>m.id==='key'),false);
});
test('楼层不再被生成器排成隔壁房间或庭院区域，但自己的室内图仍能生成',()=>{
 const ctx=context(),input=spec();input.rooms.push({id:'upper',w:24,h:24,side:'south'});
 const out=generateFloor(input,ctx);assert.equal(out.ok,true);assert.equal(out.scene.layout.rooms.some(r=>r.id==='upper'),false);assert.ok(out.issues.some(i=>i.code==='VERTICAL_SPACE_NAVIGATION_ONLY'));
 const overview=generateOverview({surface:'mixed',zones:[{id:'upper',size:'medium'}]},ctx);
 assert.equal(overview.ok,true);assert.equal(overview.scene.layout.shapes.length,0);
 ctx.map={...ctx.map,id:'upper-map',containerLocationId:'upper',containerKind:'floor',frame:{cols:24,rows:24}};
 const own=generateFloor({rooms:[{id:'upper',w:24,h:24,side:'north'}]},ctx);assert.equal(own.ok,true);assert.equal(own.scene.layout.rooms[0].id,'upper');
 assert.deepEqual(baselineFloorRooms([{id:'upper',kind:'floor'},{id:'store',kind:'room'}],{width:24,height:24},x=>x).map(r=>r.id),['store']);
});

function navigationFixture(){
 const maps=[{mapId:'world',name:'世界',kind:'world',points:[]},
  {mapId:'house',name:'住所',kind:'site',containerLocationId:'house-id',containerLocationKind:'building',parentMapId:'world',points:[]},
  ...[['upper','二楼','floor'],['kitchen','厨房','room'],['yard','庭院','other']].map(([id,name,kind])=>({mapId:id+'-map',name,kind:'interior',containerLocationId:id,containerLocationKind:kind,parentMapId:'house',points:[]}))];
 const locs=[{entityId:'house-id',entityKind:'location',locationKind:'building',name:'住所',mapId:'world'},...maps.slice(2).map(m=>({entityId:m.containerLocationId,entityKind:'location',locationKind:m.containerLocationKind,name:m.name,mapId:'house'}))];
 const poly=[{x:0,y:0},{x:8,y:0},{x:8,y:8},{x:0,y:8}];
 const scene={units:'meters',layout:{kind:'overview',bounds:{x:0,y:0,w:100,h:100},pins:[{id:'upper',name:'二楼',x:4,y:4}],shapes:[{id:'upper',name:'二楼',polygon:poly}],features:[]}};
 return {maps,locs,scene,data:projectReferenceData({mapView:{items:maps},sceneView:{items:[{mapId:'house',scene}]},catalogView:{items:locs},viewMode:'author'})};
}
test('建筑按楼层、归属未明的房间、室外分组；漏画空间保留可点击入口和待完善状态',()=>{
 const {data}=navigationFixture(),house=data.ROOT.children[0];
 assert.deepEqual(house.spaceGroups.map(g=>g.label),['楼层','房间 · 楼层未标明','室外与其他场所']);
 assert.deepEqual(house.spaceGroups.flatMap(g=>g.entries).map(e=>e.id),['upper-map','kitchen-map','yard-map']);
 assert.deepEqual(house.spaceCoverage,{total:3,unplaced:2,pending:3});assert.equal(house.geo.overviewShapes.length,0);
 assert.equal(house.marks.some(m=>m.id==='upper'),false);assert.equal(house.children[0].floorChoices[1].id,'upper-map');
});
test('新城市不默认填满装饰建筑，也不把无街区归属的建筑硬塞到首个街区',()=>{
 const ctx=context();ctx.map={...ctx.map,id:'city-map',containerLocationId:'city',containerKind:'city',frame:{cols:100,rows:100},metersPerCell:10};
 ctx.entities.locations=['city','district','house'];ctx.locationsById={city:{kind:'city'},district:{kind:'district',parent_location_id:'city'},house:{kind:'building',parent_location_id:'city'}};
 const input={districts:[{id:'district',bank:'west',order:0}],buildings:[{id:'house',districtId:'district',w:24,h:24}],riverWidth:0};
 const out=generateCity(input,ctx);assert.equal(out.ok,true,JSON.stringify(out.issues));assert.equal(out.scene.layout.buildings.filter(b=>b.decorative).length,0);assert.equal(out.scene.constraints.buildings[0].districtId,'city');assert.ok(out.issues.some(i=>i.code==='BUILDING_DISTRICT_RECONCILED'));
});
test('真实城市画布只画保存的建筑轮廓和示意道路，不额外生成每区 190 个假街块',()=>{
 const code=readFileSync(new URL('../ui/atlas-reference/js/map.js',import.meta.url),'utf8');
 const chunk=code.slice(code.indexOf('function cityMap(g)'),code.indexOf('/* ── L3 街区'));
 const blocks=[],lines=[],ctx=new Proxy({moveTo:(...p)=>lines.push(p),lineTo:(...p)=>lines.push(p)},{get:(o,k)=>o[k]??(()=>{}),set:(o,k,v)=>(o[k]=v,true)});
 const runtime=vm.createContext({ctx,st:{node:{host:true},cam:{s:1},filter:new Set()},skinColor:(_l,_p,f)=>f,hexA:c=>c,pushLabel:()=>{},rrect:(_c,...p)=>blocks.push(p)});
 vm.runInContext(chunk+';cityMap',runtime)({districts:[{id:'district',name:'街区',c:'#abc',pts:[[0,0],[50,0],[50,50],[0,50]]}],avenues:[{from:[10,10],to:[40,40]}],cityBuildings:[{x:20,y:20,w:8,h:6}]});
 assert.equal(blocks.length,1);assert.deepEqual(blocks[0].slice(0,4),[20,20,8,6]);assert.ok(lines.some(p=>p[0]===40&&p[1]===40));
});
