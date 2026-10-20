import test from 'node:test';
import assert from 'node:assert/strict';
import {compileSceneGroup,buildLayoutContext} from '../vendor/atlas-spatial/index.mjs';
import {confirmedAreaSize,resolveMapSpaceSize} from '../src/atlas-space-canonical.ts';
import {normalizeConstructionOps} from '../src/atlas-sql-world-completion.ts';

const scope={chatId:'dimensions-test',branchId:'b',revision:1,viewMode:'author'};
const size=(widthM,heightM)=>({kind:'dimensions',widthM,heightM,quality:'confirmed',source:'story'});
const map={branch_id:'b',id:'inn-map',name:'旅舍',container_location_id:'inn',status:'active',row_rev:1,frame_json:{cols:24,rows:24},meters_per_cell:1,scale_quality:'estimated',scale_locked:0};
const locations=[
  {id:'inn',kind:'building',map_id:'world',parent_location_id:null},
  {id:'hall',kind:'room',map_id:map.id,parent_location_id:'inn',area_geometry_json:size(12,8)},
  {id:'kitchen',kind:'room',map_id:map.id,parent_location_id:'inn',area_geometry_json:size(4,3)},
].map(row=>({branch_id:'b',status:'active',name:row.id,coord_precision:'layout',grid_x:null,grid_y:null,row_rev:1,...row}));
const request={kind:'floor',spec:{rooms:[{id:'hall',w:7.5,h:8,side:'north'},{id:'kitchen',w:7.5,h:8,side:'south'}]}};

test('确认长宽无需父图比例尺，生成时保持尺寸且不成为坐标锁',()=>{
  const uncalibrated={...map,meters_per_cell:null};
  assert.deepEqual(confirmedAreaSize(locations[1],uncalibrated),{widthM:12,heightM:8});
  const ctx=buildLayoutContext({scope,mapRow:map,locations});
  assert.deepEqual(ctx.context.locks.rooms,{});
  const input={request,scope,currentScope:scope,mapRow:map,locations,characters:[],items:[],maps:[map],turnId:'turn',operationId:'layout'};
  const before=structuredClone(input);
  const out=compileSceneGroup(input);
  assert.equal(out.ok,true,JSON.stringify(out.issues));
  assert.deepEqual(out.issues,[]);
  const rooms=out.scene.layout.rooms;
  assert.deepEqual(rooms.map(r=>[r.id,r.w,r.h]),[['hall',12,8],['kitchen',4,3]]);
  assert.ok(rooms.every(r=>r.quality==='layout'));
  for(const m of out.group.mutations.filter(m=>m.table==='locations')){
    assert.deepEqual(m.after.area_geometry_json,locations.find(l=>l.id===m.rowId).area_geometry_json);
    assert.equal(m.after.coord_precision,'layout');
  }
  assert.deepEqual(input,before,'只生成候选，不改变原行');
  const resolved=resolveMapSpaceSize({maps:[uncalibrated],locations,mapRow:{id:'hall-map',container_location_id:'hall'},branchId:'b',firstEstimate:{widthM:7.5,heightM:8}});
  assert.deepEqual([resolved.resolution.widthM,resolved.resolution.heightM,resolved.resolution.source],[12,8,'author']);
});

test('真正的确认多边形仍禁止示意布局覆盖',()=>{
  const polygon={kind:'polygon',quality:'confirmed',source:'manual',points:[{x:0,y:0},{x:4,y:0},{x:4,y:3},{x:0,y:3}]};
  const rows=locations.map(l=>l.id==='hall'?{...l,area_geometry_json:polygon}:l);
  // 无比例尺不能把格坐标锁解释成米；更不能据此放行示意轮廓覆盖。
  const out=compileSceneGroup({request:{...request,spec:{...request.spec,width:24,height:24}},scope,currentScope:scope,mapRow:{...map,meters_per_cell:null},locations:rows,characters:[],items:[],maps:[],turnId:'turn',operationId:'layout'});
  assert.equal(out.ok,false);
  assert.ok(out.issues.some(i=>i.code==='CONFIRMED_AREA_LOCKED'),JSON.stringify(out.issues));
});

test('剔除保护字段后不提交空更新，仍保留重试依据及合法字段',()=>{
  const original=[{op:'location.upsert',ref:'hall',data:{area:size(1,1)}},{op:'location.upsert',ref:'kitchen',data:{area:size(1,1),description:'补充说明'}}];
  const out=normalizeConstructionOps({operations:original,knownIds:['hall','kitchen'],protectedLocationFacts:{hall:{area:true},kitchen:{area:true}}});
  assert.deepEqual(out.operations,[{op:'location.upsert',ref:'kitchen',data:{description:'补充说明'}}]);
  assert.deepEqual(out.protectedDrops,['hall','kitchen']);
  assert.equal(out.issues.filter(i=>i.code==='WORLD_CONSTRUCTION_PROTECTED_FACT').length,2);
  assert.ok(original[0].data.area);
});

test('重复报告同一确认尺寸是无变化，真正冲突仍保护并留下重试',()=>{
  const fact=size(12,8);
  const run=area=>normalizeConstructionOps({operations:[{op:'location.upsert',ref:'hall',data:{area}}],knownIds:['hall'],protectedLocationFacts:{hall:{area:true,areaValue:JSON.stringify(fact)}}});
  const same=run({source:'story',quality:'confirmed',heightM:8,widthM:12,kind:'dimensions'});
  assert.deepEqual(same.protectedDrops,[]);
  assert.deepEqual(same.issues,[]);
  assert.equal(same.operations[0].op,'noop');
  const conflict=run(size(10,8));
  assert.deepEqual(conflict.operations,[]);
  assert.deepEqual(conflict.protectedDrops,['hall']);
});
