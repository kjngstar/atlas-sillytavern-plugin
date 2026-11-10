import test from 'node:test';
import assert from 'node:assert/strict';
import * as Kit from '../vendor/atlas-spatial/index.mjs';
import {navigation} from '../vendor/atlas-spatial/layout-core.mjs';
import {referenceGeometry} from '../ui/atlas-reference-data.mjs';
const scope={chatId:'topology',branchId:'b',revision:1,viewMode:'author'};
const location=(id,parent='floor',map='floor-map')=>({id,branch_id:'b',status:'active',kind:'room',name:id,parent_location_id:parent,map_id:map});
const map=(id,container,w,h)=>({id,branch_id:'b',status:'active',container_location_id:container,name:id,row_rev:1,frame_json:{cols:w,rows:h},meters_per_cell:1,scale_quality:'estimated'});
const floor=map('floor-map','floor',24,24),kitchen=map('kitchen-map','kitchen',4,3);
const locations=[{...location('floor',null,null),kind:'floor'},location('hall'),location('kitchen')];
const routes=[{id:'hall-kitchen',branch_id:'b',status:'open',kind:'door',from_location_id:'hall',to_location_id:'kitchen',bidirectional:1}];
const spec={rooms:[{id:'hall',side:'north',w:12,h:8},{id:'kitchen',side:'south',w:4,h:3}],contents:[]};

for(const [name,w,h,sizes]of [['邮局',12,8,[[4,4],[6,5]]],['小艇',9,4,[[3,3],[5,3]]]])test(`${name}明确两间直连空间在真实外廓内保留尺寸，不强塞走廊`,()=>{
 const row=map('local-map','shell',w,h),ids=['a','b'];
 const rows=[{...location('shell',null,null),kind:'building'},...ids.map((id,i)=>({...location(id,'shell','local-map'),area_geometry_json:{kind:'dimensions',widthM:sizes[i][0],heightM:sizes[i][1],quality:'confirmed',source:'story'}}))];
 const built=Kit.buildLayoutContext({scope,mapRow:row,maps:[row],locations:rows,routes:[{id:'door',branch_id:'b',from_location_id:'a',to_location_id:'b',kind:'door',status:'open',bidirectional:1}]});
 assert.equal(built.ok,true,JSON.stringify(built.issues));
 const out=Kit.generateFloor({width:w,height:h,rooms:ids.map((id,i)=>({id,w:sizes[i][0],h:sizes[i][1],side:i?'south':'north'}))},{...built.context,currentScope:scope});
 assert.equal(out.ok,true,JSON.stringify(out.issues));
 assert.equal(out.scene.layout.rooms.length,2);
 for(const r of out.scene.layout.rooms){const size=sizes[ids.indexOf(r.id)];assert.equal(r.w,size[0]);assert.equal(r.h,size[1]);assert.ok(r.x>=0&&r.y>=0&&r.x+r.w<=w+1e-7&&r.y+r.h<=h+1e-7);}
 assert.equal(out.scene.layout.doors.filter(d=>d.routeId==='door').length,2);
});
function context(row=floor,extra={}){
 const built=Kit.buildLayoutContext({scope,mapRow:row,maps:[floor,kitchen],locations,routes,...extra});
 assert.equal(built.ok,true,JSON.stringify(built.issues));return {...built.context,currentScope:scope};
}
test('大厅与厨房直接连通：共墙、共门洞，不隔着走廊；行走路径通过真实门',()=>{
 const ctx=context();ctx.entities.characters=['a','b'];
 const out=Kit.generateFloor({...spec,actors:[{id:'a',roomId:'hall'},{id:'b',roomId:'kitchen'}]},ctx);
 assert.equal(out.ok,true,JSON.stringify(out.issues));assert.deepEqual(out.issues,[]);
 const {rooms,doors,path,bodies}=out.scene.layout,[hall,room]=rooms;
 assert.equal(hall.x+hall.w,room.x);assert.equal(doors.length,2);
 assert.deepEqual(doors.map(d=>[d.x,d.y,d.width]),[[room.x,room.y+room.h/2,1.2],[room.x,room.y+room.h/2,1.2]]);
 assert.deepEqual(doors.map(d=>d.wall),['east','west']);
 assert.ok(path.some(p=>p.x===room.x&&p.y===doors[0].y));
 assert.ok(path.every(p=>rooms.some(r=>p.x>=r.x&&p.x<=r.x+r.w&&p.y>=r.y&&p.y<=r.y+r.h)), '路径不能绕到假走廊');
 assert.ok(rooms.every(r=>navigation(r,doors.find(d=>d.roomId===r.id),bodies.filter(b=>b.roomId===r.id)).reachable({x:r.x+r.w/2,y:r.y+r.h/2})));
 const again=Kit.generateFloor({...spec,contents:[{id:'lamp',roomId:'hall',type:'light',w:.2,h:.2}]},{...ctx,previousScene:out.scene});
 assert.deepEqual(again.scene.layout.rooms,rooms,'只补灯不能移动房间');
 const geo=referenceGeometry(floor,out.scene);assert.equal(geo.geo.doors[0].wall,'east');
 const pov=Kit.filterSceneForView(out.scene,{scope:{...scope,viewMode:'pov'},visibleLocations:['hall']});
 assert.equal(pov.scene.layout.doors[0].wall,'east');assert.ok(!JSON.stringify(pov.scene).includes('hall-kitchen'));assert.ok(!JSON.stringify(pov.scene).includes('toRoomId'));
});
test('普通地点类型的室外入口仍与大厅真实连通，不被隔离成假走廊支路',()=>{
 const row=map('floor-map','floor',32,24),entry={...location('entry'),kind:'other'};
 const ctx=context(row,{maps:[row,kitchen],locations:[...locations,entry],routes:[...routes,{...routes[0],id:'entry-hall',from_location_id:'entry',to_location_id:'hall',kind:'estimated'}]});
 ctx.entities.characters=['a','b'];
 const out=Kit.generateFloor({...spec,rooms:[...spec.rooms,{id:'entry',side:'north',role:'outdoor',w:8,h:8}],actors:[{id:'a',roomId:'entry'},{id:'b',roomId:'kitchen'}]},ctx);
 assert.deepEqual(out.issues,[]);assert.equal(out.scene.layout.doors.filter(d=>d.routeId==='entry-hall').length,2);
 assert.ok(out.scene.layout.path.length>0);assert.ok(!out.scene.layout.windows.some(w=>w.roomId==='entry'));
 const interior=Kit.generateFloor(spec,ctx);assert.deepEqual(interior.issues,[]);
 const exit=interior.scene.layout.doors.find(d=>d.routeId==='entry-hall');
 assert.equal(exit.roomId,'hall');assert.equal(exit.toRoomId,'entry','室外入口不画入楼层时，也必须保留通往真实入口的门');
});
test('子图继承父图同一面墙上的入口，不另猜门的位置',()=>{
 const parent=Kit.generateFloor(spec,context()).scene;
 const parentRow={...floor,frame_json:{...floor.frame_json,atlasScene:parent}};
 const ctx=context(kitchen,{maps:[parentRow,kitchen]});
 const child=Kit.generateFloor({rooms:[{id:'kitchen',side:'north',w:4,h:3}]},ctx);
 assert.equal(child.ok,true,JSON.stringify(child.issues));assert.deepEqual(child.issues,[]);
 const d=child.scene.layout.doors[0];assert.equal(d.x,0);assert.equal(d.y,1.5);assert.equal(d.wall,'west');assert.equal(d.routeId,'hall-kitchen');
 const furnished=Kit.generateFloor({rooms:[{id:'kitchen',side:'north',w:4,h:3}],contents:[
  {id:'counter',roomId:'kitchen',type:'desk',w:1,h:2.5},{id:'shelf',roomId:'kitchen',type:'shelf',w:1.5,h:.6},
  {id:'cabinet',roomId:'kitchen',type:'cabinet',w:1,h:.4},{id:'lamp',roomId:'kitchen',type:'light',w:.2,h:.2}]},ctx);
 assert.deepEqual(furnished.issues,[]);assert.equal(furnished.scene.layout.groups.length,4);
 assert.equal(furnished.scene.layout.groups.find(g=>g.id==='counter').w*furnished.scene.layout.groups.find(g=>g.id==='counter').h,2.5,'共墙门不能靠缩小操作台来让路');
 assert.ok(furnished.scene.layout.groups.every(g=>g.interaction));
 const bad=Kit.generateFloor({}, {...ctx,previousScene:child.scene,entryDoors:[{...d,x:2}]});
 assert.equal(bad.ok,false);assert.ok(bad.issues.some(i=>i.code==='ENTRY_DOOR_INVALID'));assert.deepEqual(bad.kept,child.scene);
});
test('门洞提示保留 ID，但不能生成房间中央的门洞家具',()=>{
 const out=Kit.generateFloor({rooms:[{id:'kitchen',side:'north',w:4,h:3}],contents:[{id:'legacy-door',roomId:'kitchen',type:'doorway',w:.8,h:.15}]},context(kitchen));
 assert.equal(out.ok,true);assert.equal(out.scene.layout.groups.length,0);assert.equal(out.scene.layout.bodies.length,0);
 assert.deepEqual(out.scene.layout.doors[0].sourceContentIds,['legacy-door']);
});
test('3×1 工作台遇到共墙门时选择合法门位，父子图保持同一陈设坐标',()=>{
 const contents=[{id:'counter',roomId:'kitchen',type:'desk',w:3,h:1},{id:'shelf',roomId:'kitchen',type:'shelf',w:1,h:1}];
 const parent=Kit.generateFloor({...spec,contents},context());assert.deepEqual(parent.issues,[]);
 const row={...floor,frame_json:{...floor.frame_json,atlasScene:parent.scene}};
 const child=Kit.generateFloor({rooms:[{id:'kitchen',side:'north',w:4,h:3}],contents},context(kitchen,{maps:[row,kitchen]}));
 assert.deepEqual(child.issues,[]);
 const room=parent.scene.layout.rooms.find(r=>r.id==='kitchen');
 for(const g of parent.scene.layout.groups){const local=child.scene.layout.groups.find(c=>c.id===g.id);assert.ok([local.x-(g.x-room.x),local.y-(g.y-room.y),local.w-g.w,local.h-g.h].every(delta=>Math.abs(delta)<1e-7));}
 assert.equal(child.scene.layout.groups.find(g=>g.id==='counter').w,3);
 assert.ok(!child.scene.layout.bodies.some(b=>b.type==='chair'),'厨房工作台不能凭空附带一把椅子');
 const door=parent.scene.layout.doors.find(d=>d.roomId==='kitchen');assert.notEqual(door.y,room.y+room.h/2,'不固定用房间正中门位');
});
test('父图旋转后的长条操作台下钻时仍保留同一朝向和坐标',()=>{
 const contents=[{id:'counter',roomId:'kitchen',type:'desk',w:1,h:2.5},{id:'shelf',roomId:'kitchen',type:'shelf',w:1.5,h:.6}];
 const parent=Kit.generateFloor({...spec,contents:contents.map(f=>f.id==='counter'?{...f,w:2.5,h:1}:f)},context());assert.deepEqual(parent.issues,[]);
 const row={...floor,frame_json:{...floor.frame_json,atlasScene:parent.scene}};
 const child=Kit.generateFloor({rooms:[{id:'kitchen',side:'north',w:4,h:3}],contents},context(kitchen,{maps:[row,kitchen]}));
 assert.deepEqual(child.issues,[]);
 const room=parent.scene.layout.rooms.find(r=>r.id==='kitchen');
 for(const g of parent.scene.layout.groups){const local=child.scene.layout.groups.find(c=>c.id===g.id);assert.ok([local.x-(g.x-room.x),local.y-(g.y-room.y),local.w-g.w,local.h-g.h].every(delta=>Math.abs(delta)<1e-7),JSON.stringify({parent:g,child:local}));}
 const legacy=structuredClone(child.scene),signature=JSON.parse(legacy.inputSignature);signature.detailPolicy='explicit-furniture-v1';legacy.inputSignature=JSON.stringify(signature);
 Object.assign(legacy.layout.groups.find(g=>g.id==='counter'),{w:1,h:2.5});
 const repaired=Kit.generateFloor({rooms:[{id:'kitchen',side:'north',w:4,h:3}],contents},{...context(kitchen,{maps:[row,kitchen]}),previousScene:legacy});
 assert.equal(repaired.status,'generated','旧策略的成功缓存也必须重新求解');assert.deepEqual(repaired.scene.layout.groups,child.scene.layout.groups);
});
test('换到子图必须复用账本 ID，不能换一个 ID 再加同一盏灯；同名独立物品仍可明确新增',()=>{
 const ctx=context(kitchen);ctx.spaceCanonical={furnishing:[{localId:'space:kitchen:furn:lamp',type:'light',name:'照明',widthM:.2,heightM:.2,quality:'layout'}]};
 const rooms=[{id:'kitchen',side:'north',w:4,h:3}];
 const first=Kit.generateFloor({rooms,contents:[]},ctx);assert.equal(first.scene.layout.groups.length,1);
 const renamed=Kit.generateFloor({rooms,contents:[{id:'new-lamp',roomId:'kitchen',type:'light',name:'照明',w:.2,h:.2}]},{...ctx,previousScene:first.scene});
 assert.equal(renamed.ok,false);assert.ok(renamed.issues.some(i=>i.code==='FURNISHING_ID_UNREGISTERED'));assert.deepEqual(renamed.kept,first.scene);
 const rebuilt=Kit.generateFloor({rebuild:true,rooms,contents:[{id:'new-lamp',roomId:'kitchen',type:'light',name:'照明',w:.2,h:.2}]},ctx);assert.equal(rebuilt.ok,false,'重排几何不能绕过物理身份账本');
 const reused=Kit.generateFloor({rooms,contents:[{id:'space:kitchen:furn:lamp',roomId:'kitchen',type:'light',w:.2,h:.2}]},ctx);
 assert.equal(reused.scene.layout.groups.length,1);
 const added=Kit.generateFloor({rooms,contents:[{id:'new-lamp',roomId:'kitchen',type:'light',name:'照明',w:.2,h:.2,additional:true}]},ctx);
 assert.equal(added.scene.layout.groups.length,2,'明确新增仍可同名，不能按名字吞掉物品');
});
test('父图也必须复用子空间陈设 ID，不能从另一视角再加一套',()=>{
 const row={...kitchen,frame_json:{...kitchen.frame_json,atlasSpaceCanonical:{version:1,locationId:'kitchen',revision:1,size:null,furnishing:[{localId:'space:kitchen:furn:lamp',type:'light',name:'照明',widthM:.2,heightM:.2,quality:'layout'}]}}};
 const args={scope,currentScope:scope,mapRow:floor,maps:[floor,row],locations,routes,characters:[],items:[],turnId:'t',operationId:'op'};
 const out=Kit.compileSceneGroup({...args,request:{kind:'floor',spec:{...spec,contents:[{id:'another-lamp',roomId:'kitchen',type:'light',w:.2,h:.2}]}}});
 assert.equal(out.ok,false);assert.ok(out.issues.some(i=>i.code==='FURNISHING_ID_UNREGISTERED'));
});
test('不能满足直接连接时拒绝生成并保留原图，不用走廊冒充相通',()=>{
 const ctx=context(),previous=Kit.generateFloor(spec,ctx).scene;
 const out=Kit.generateFloor(spec,{...ctx,map:{...ctx.map,frame:{cols:11,rows:24}},previousScene:previous});
 assert.equal(out.ok,false);assert.ok(out.issues.some(i=>i.code==='ROOM_CONNECTION_NO_SPACE'));assert.deepEqual(out.kept,previous);
 const portal=context(floor,{routes:[{...routes[0],kind:'portal'}]});assert.deepEqual(portal.roomConnections,[],'传送门不能强制共墙');
});
test('建筑总览拒绝把整层作为平面房间，不能借楼层轮廓登记下级房间的另一套家具',()=>{
 const top=map('inn-map','inn',40,60),floorLocation={...location('floor','inn','inn-map'),kind:'floor'};
 const out=Kit.compileSceneGroup({scope,currentScope:scope,mapRow:top,maps:[top,floor,kitchen],locations:[location('inn',null,null),floorLocation,...locations.filter(l=>l.id!=='floor')],characters:[],items:[],routes:[],turnId:'t',operationId:'outline',autoPlan:true,request:{kind:'floor',spec:{rooms:[{id:'floor',side:'north',w:25,h:24}],contents:[{id:'guessed-counter',roomId:'floor',type:'desk',w:3,h:1}]}}});
 assert.equal(out.ok,false);assert.ok(out.issues.some(i=>i.code==='VERTICAL_SPACE_NAVIGATION_ONLY'));
 assert.equal(out.group??null,null,'非法平铺请求不能生成父图或子图的写入组');
});
