import test from 'node:test';
import assert from 'node:assert/strict';
import * as Kit from '../vendor/atlas-spatial/index.mjs';
import { baselineFloorRooms } from '../src/atlas-sql-layout-task.ts';
import {canonicalForScene} from '../vendor/atlas-spatial/storage.mjs';
const scope={chatId:'size-regression',branchId:'b',revision:1,viewMode:'author'};
test('已确认陈设保持尺寸，完整空间 ID 不生成第二件家具',()=>{
 const ctx=context();ctx.spaceCanonical={furnishing:[{localId:'space:r:furn:desk',type:'desk',name:'桌子',widthM:2,heightM:1,quality:'confirmed'}]};
 const out=Kit.generateFloor({rooms:[{id:'r',w:12,h:8,side:'north'}],contents:[{id:'space:r:furn:desk',roomId:'r',type:'desk',w:.2,h:.2}]},ctx);
 assert.equal(out.scene.layout.groups.length,1);assert.equal(out.scene.layout.groups[0].id,'desk');
 assert.equal(out.scene.layout.groups[0].w*out.scene.layout.groups[0].h,2);
});
test('生成时自动扩展估计空间，家具尺寸保持且确认空间不扩展',()=>{
 const spec={rooms:[{id:'r',w:1.5,h:2.5,side:'north'}],contents:[{id:'bed',roomId:'r',type:'bed',name:'床',w:.9,h:2},{id:'bed2',roomId:'r',type:'bed',name:'床',w:.9,h:2}]};
 const ctx={...context({width:1.5,height:2.5}),autoPlan:true,spaceSize:{widthM:1.5,heightM:2.5,quality:'estimated'}};
 const out=Kit.generateFloor(spec,ctx);assert.equal(out.ok,true,JSON.stringify(out.issues));
 assert.equal(out.scene.layout.groups.length,2,JSON.stringify(out.issues));
 assert.ok(out.scene.layout.groups.every(g=>g.w*g.h===1.8));
 assert.ok(out.plannedSize.widthM>1.5);assert.deepEqual(out.scene.layout.issues,[]);
 const fixed=Kit.generateFloor(spec,{...ctx,spaceSize:{...ctx.spaceSize,quality:'confirmed'}});
 assert.equal(fixed.plannedSize,undefined);assert.ok(fixed.scene.layout.issues.length);
});
test('显式删除陈设同时移除账本，不在下次生成中复活',()=>{
 const ctx=context();
 const first=Kit.generateFloor({rooms:[{id:'r',w:12,h:8,side:'north'}],contents:[{id:'desk',roomId:'r',name:'桌子',type:'desk',w:2,h:1}]},ctx);
 assert.equal(first.ok,true);
 const canonical=canonicalForScene(first.scene,null,'r',null);
 assert.equal(canonical.furnishing.length,1);
 const removed=Kit.generateFloor({deletes:{contents:['desk']}},{...ctx,previousScene:first.scene,spaceCanonical:canonical});
 assert.equal(removed.ok,true,JSON.stringify(removed.issues));
 assert.deepEqual(removed.scene.constraints.contents,[]);
 const next=canonicalForScene(removed.scene,canonical,'r',null,removed.deletedContents);
 assert.deepEqual(next.furnishing,[]);
 const again=Kit.generateFloor({},{...ctx,previousScene:removed.scene,spaceCanonical:next});
 assert.equal(again.scene.layout.groups.length,0);
});
function context({width=12,height=8,container='r',rooms=['r']}={}){
 const mapRow={id:'m',branch_id:'b',container_location_id:container,name:'图',row_rev:1,frame_json:{cols:width,rows:height},meters_per_cell:1,scale_quality:'estimated',scale_locked:0};
 const locations=rooms.map(id=>({id,branch_id:'b',name:id,kind:'room',status:'active',map_id:'m'}));
 const built=Kit.buildLayoutContext({scope,mapRow,locations,characters:[],items:[],routes:[]});
 assert.equal(built.ok,true);return {...built.context,currentScope:scope};
}
test('已知子空间超过基线容量时不压缩或舍入权威尺寸',()=>{
 const rows=baselineFloorRooms([{id:'r',name:'房间'}],{width:8,height:8},id=>id,()=>({widthM:9.37,heightM:6.83}));
 assert.deepEqual([rows[0].w,rows[0].h],[9.37,6.83]);
});
test('单间房生成器用完整空间权威覆盖旧 75% 约束',()=>{
 const ctx=context();ctx.spaceSize={widthM:12,heightM:8,source:'canonical'};
 const out=Kit.generateFloor({rooms:[{id:'r',w:9,h:6,side:'north'}]},ctx);
 assert.equal(out.ok,true,JSON.stringify(out.issues));
 assert.deepEqual(out.scene.layout.rooms.map(r=>[r.w,r.h]),[[12,8]]);
});
test('父图用子空间权威覆盖模型尺寸，容量不足时保留旧场景',()=>{
 const ctx=context({width:24,height:24,container:'building',rooms:['a','b']});
 ctx.childSpaces={a:{widthM:9.37,heightM:6.83}};
 const request={rooms:[{id:'a',w:3,h:3,side:'north'},{id:'b',w:4,h:3,side:'south'}]};
 const out=Kit.generateFloor(request,ctx);assert.equal(out.ok,true,JSON.stringify(out.issues));
 assert.deepEqual([out.scene.layout.rooms[0].w,out.scene.layout.rooms[0].h],[9.37,6.83]);
 const fail=Kit.generateFloor(request,{...ctx,previousScene:out.scene,childSpaces:{a:{widthM:30,heightM:6.83}}});
 assert.equal(fail.ok,false);assert.deepEqual(fail.kept,out.scene);
});
test('窄房间先尝试旋转陈设，门口与交互仍可达',()=>{
 const out=Kit.generateFloor({rooms:[{id:'r',w:4,h:3,side:'north'}],contents:[{id:'bench',type:'bench',roomId:'r',w:.5,h:3,name:'长凳'}]},context({width:4,height:3}));
 assert.equal(out.ok,true,JSON.stringify(out.issues));
 assert.equal(out.scene.layout.groups.length,1,JSON.stringify(out.issues));
 assert.deepEqual([out.scene.layout.groups[0].w,out.scene.layout.groups[0].h],[3,.5]);
 assert.ok(out.scene.layout.groups[0].interaction);
 assert.deepEqual(out.issues,[]);
});
test('窄房间允许绕行，不能因固定直线净空带丢弃可达操作台',()=>{
 const out=Kit.generateFloor({rooms:[{id:'r',w:4,h:3,side:'north'}],contents:[{id:'counter',type:'table',roomId:'r',w:2,h:1,name:'操作台'}]},context({width:4,height:3}));
 assert.equal(out.ok,true);assert.equal(out.scene.layout.groups.length,1,JSON.stringify(out.issues));
 assert.ok(out.scene.layout.groups[0].interaction);assert.deepEqual(out.issues,[]);
});
test('实际过大的家具仍明确缺项，不靠缩小家具通过',()=>{
 const out=Kit.generateFloor({rooms:[{id:'r',w:4,h:3,side:'north'}],contents:[{id:'huge',type:'bed',roomId:'r',w:5,h:4}]},context({width:4,height:3}));
 assert.equal(out.ok,true);assert.equal(out.scene.layout.groups.length,0);
 assert.ok(out.issues.some(i=>i.code==='DETAIL_TOO_LARGE'));
});
