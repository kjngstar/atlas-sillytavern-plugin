import test from 'node:test';
import assert from 'node:assert/strict';
import * as Kit from '../vendor/atlas-spatial/index.mjs';
import {floor,intersects,contains} from '../vendor/atlas-spatial/foundation.mjs';
import {sharedRoomWall,placeConnectedRooms} from '../vendor/atlas-spatial/room-topology.mjs';
import {navigation} from '../vendor/atlas-spatial/layout-core.mjs';
const rooms=[{id:'hall',side:'north',w:8,h:8},...['kitchen','store','guest'].map(id=>({id,side:'north',w:4,h:4}))];
const edges=rooms.slice(1).map(r=>({id:'door-'+r.id,from:'hall',to:r.id}));
const scope={chatId:'repair-topology',branchId:'b',revision:1,viewMode:'author'};
function generate(input=rooms,extra={},frame={cols:40,rows:24}){
 const map={id:'m',branch_id:'b',container_location_id:'f',name:'楼层',status:'active',row_rev:1,frame_json:frame,meters_per_cell:1,scale_quality:'confirmed'};
 const locations=[{id:'f',kind:'floor',parent_location_id:null},...input.map(r=>({id:r.id,kind:'room',parent_location_id:'f',map_id:'m'}))].map(r=>({...r,branch_id:'b',name:r.id,status:'active'}));
 const routes=edges.filter(e=>input.some(r=>r.id===e.from)&&input.some(r=>r.id===e.to)).map(e=>({id:e.id,branch_id:'b',status:'open',kind:'door',from_location_id:e.from,to_location_id:e.to,bidirectional:1}));
 const built=Kit.buildLayoutContext({scope,mapRow:map,maps:[map],locations,routes});assert.equal(built.ok,true);
 return Kit.generateFloor({rooms:input,contents:[]},{...built.context,currentScope:scope,...extra});
}
function valid(layout){
 for(const r of layout.rooms){assert.ok(contains(layout.bounds,r));assert.deepEqual([r.w,r.h],[rooms.find(x=>x.id===r.id).w,rooms.find(x=>x.id===r.id).h]);}
 for(let i=0;i<layout.rooms.length;i++)for(const b of layout.rooms.slice(i+1))assert.ok(!intersects(layout.rooms[i],b));
 for(const e of edges){const [a,b]=[e.from,e.to].map(id=>layout.rooms.find(r=>r.id===id));assert.ok(sharedRoomWall(a,b));const doors=layout.doors.filter(d=>d.routeId===e.id);assert.equal(doors.length,2);assert.deepEqual(doors.map(d=>[d.x,d.y,d.width]),Array(2).fill([doors[0].x,doors[0].y,doors[0].width]));}
 for(const r of layout.rooms){const doors=layout.doors.filter(d=>d.roomId===r.id),nav=navigation(r,doors[0],[]);for(const d of doors){const p={x:d.x+(d.wall==='east'?-.45:d.wall==='west'?.45:0),y:d.y+(d.wall==='south'?-.45:d.wall==='north'?.45:0)};assert.ok(nav.reachable(p));}}
}
test('大厅连接三间房：四向共墙、成对门洞、完整尺寸，无虚构走廊',()=>{
 const r=generate();assert.equal(r.ok,true,JSON.stringify(r.issues));assert.deepEqual(r.issues,[]);valid(r.scene.layout);assert.equal(r.scene.layout.corridor.w,0);assert.deepEqual(Kit.checkSceneDocument(r.scene),[]);
 const again=generate([...rooms].reverse(),{previousScene:Kit.clone(r.scene)});assert.deepEqual(again.scene.layout,r.scene.layout);
});
test('固定上下共墙和增量分叉保留已确认位置，冲突明确失败并保留原图',()=>{
 const previous=generate().scene;for(const r of previous.layout.rooms)r.quality='confirmed';
 const result=generate(rooms,{previousScene:previous});assert.equal(result.ok,true,JSON.stringify(result.issues));assert.deepEqual(result.scene.layout.rooms,previous.layout.rooms);
 const spec={id:'floor',width:20,height:20,corridorWidth:2,rooms:[{id:'a',side:'north',w:8,h:8,locked:{x:2,y:2}},{id:'b',side:'north',w:4,h:4,locked:{x:4,y:10}}],roomConnections:[{id:'ab',from:'a',to:'b'}]};
 const out=floor(spec);assert.equal(out.ok,true);assert.deepEqual(out.doors.map(d=>d.wall),['south','north']);assert.deepEqual(out.rooms.map(r=>[r.x,r.y]),[[2,2],[4,10]]);
 const bad=floor({...spec,rooms:[spec.rooms[0],{...spec.rooms[1],locked:{x:3,y:3}}]},out);assert.equal(bad.ok,false);assert.ok(bad.issues.some(i=>i.code==='LOCK_CONFLICT'));assert.deepEqual(bad.kept,Kit.clone(out));
});
test('有高度可用时改用上下连接；真正尺寸无解和搜索耗尽分别报告',()=>{
 const base={id:'f',width:13,height:24,corridorWidth:2,rooms:[{id:'a',side:'north',w:12,h:8},{id:'b',side:'south',w:4,h:3}],roomConnections:[{id:'ab',from:'a',to:'b'}]};
 const r=floor(base);assert.equal(r.ok,true,JSON.stringify(r.issues));assert.ok(['north','south'].includes(r.doors[0].wall));
 const bad=floor({...base,width:11},r);assert.equal(bad.ok,false);assert.equal(bad.issues[0].code,'ROOM_CONNECTION_NO_SPACE');assert.deepEqual(bad.kept,Kit.clone(r));
 const limited=placeConnectedRooms({rooms,edges,bounds:{x:0,y:0,w:40,h:24},maxSteps:0});assert.equal(limited.code,'ROOM_TOPOLOGY_SEARCH_LIMIT');
});
test('普通书桌 body 与 group 相等，旋转不缩小物理占地',()=>{
 const scope={chatId:'desk',branchId:'b',revision:1,viewMode:'author'},ctx={scope,currentScope:scope,map:{id:'m',name:'书房',containerLocationId:'r',containerKind:'room',metersPerCell:1,frame:{cols:8,rows:6}},entities:{locations:['r'],characters:[],items:[]}};
 const r=Kit.generateFloor({rooms:[{id:'r',side:'north',w:8,h:6}],contents:[{id:'desk',type:'desk',roomId:'r',w:2,h:1}]},ctx);assert.equal(r.ok,true);assert.deepEqual(r.issues,[]);
 const g=r.scene.layout.groups[0],body=r.scene.layout.bodies.find(b=>b.groupId===g.id);assert.deepEqual([body.w,body.h],[g.w,g.h]);assert.equal(body.w*body.h,2);assert.equal(r.scene.layout.bodies.filter(b=>b.type==='chair').length,0);
 const legacy=Kit.clone(r.scene),signature=JSON.parse(legacy.inputSignature);signature.detailPolicy='explicit-furniture-v2';legacy.inputSignature=JSON.stringify(signature);
 for(const b of [...legacy.layout.bodies,...legacy.layout.groups.flatMap(g=>g.bodies)])if(b.type==='desk')b.h*=.68;
 const repaired=Kit.generateFloor({contents:[]},{...ctx,previousScene:legacy});assert.equal(repaired.status,'generated');assert.deepEqual(repaired.issues,[]);assert.equal(repaired.scene.layout.bodies.find(b=>b.type==='desk').h,1);
});

test('上下门洞下钻继承父图的同一墙面和相对位置',()=>{
 const parent=generate(rooms.slice(0,2),{},{cols:8,rows:16});assert.equal(parent.ok,true);const entry=parent.scene.layout.doors.find(d=>d.roomId!=='hall'&&['north','south'].includes(d.wall));assert.ok(entry);
 const scope={chatId:'repair-topology',branchId:'b',revision:1,viewMode:'author'},room=parent.scene.layout.rooms.find(r=>r.id===entry.roomId);
 const parentRow={id:'m',branch_id:'b',container_location_id:'f',status:'active',row_rev:1,frame_json:{cols:40,rows:24,atlasScene:parent.scene},meters_per_cell:1,scale_quality:'confirmed'},childRow={...parentRow,id:'child',container_location_id:room.id,frame_json:{cols:room.w,rows:room.h}};
 const locations=[{id:'f',kind:'floor',parent_location_id:null},...rooms.map(r=>({id:r.id,kind:'room',parent_location_id:'f',map_id:'m'}))].map(r=>({...r,branch_id:'b',status:'active',name:r.id}));
 const routes=edges.map(e=>({id:e.id,branch_id:'b',status:'open',kind:'door',from_location_id:e.from,to_location_id:e.to,bidirectional:1}));
 const c=Kit.buildLayoutContext({scope,mapRow:childRow,maps:[parentRow,childRow],locations,routes});assert.equal(c.ok,true);
 const child=Kit.generateFloor({rooms:[{id:room.id,side:'north',w:room.w,h:room.h}]},{...c.context,currentScope:scope});assert.equal(child.ok,true,JSON.stringify(child.issues));assert.deepEqual(child.issues,[]);
 const d=child.scene.layout.doors.find(d=>d.routeId===entry.routeId);assert.equal(d.wall,entry.wall);assert.ok(Math.abs(d.x-(entry.x-room.x))<1e-7);assert.ok(Math.abs(d.y-(entry.y-room.y))<1e-7);
});
