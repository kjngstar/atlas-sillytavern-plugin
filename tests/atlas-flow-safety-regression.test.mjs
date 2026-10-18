import test from 'node:test';
import assert from 'node:assert/strict';
import initSql from 'sql.js';
import {makeContactFlowSeed} from './fixtures/atlas-sql/contact-flows.mjs';
import {IDS} from './fixtures/atlas-sql/seed.mjs';
import {querySpatialFlows} from '../src/atlas-spatial-flow-views.ts';
import {queryCatalog} from '../src/atlas-catalog-views.ts';

const SQL=await initSql();
const read=(seed,viewMode='author')=>querySpatialFlows({...seed.ctx,viewMode},{kind:'flows',branchId:seed.branchId,mapId:IDS.M1});
const points=[{x:20,y:18},{x:40,y:12},{x:60,y:45},{x:82,y:52}];
function knowledge(seed,informationId,firstReceived=0){
  seed.add('knowledge',`K_${informationId}`,{knower_character_id:IDS.C1,information_id:informationId,first_received_at_s:firstReceived,belief:'heard',status:'active'});
}
function knowLocations(seed){
  for(const id of [IDS.L1,IDS.L2]){
    seed.add('information',`INFO_${id}`,{kind:'observation',title:id,content:id,subject_entity_id:id,created_at_s:0,status:'active',content_hash:id});
    knowledge(seed,`INFO_${id}`);
  }
}
function journey(seed,segments,extra={}){
  seed.add('actions','A_WALK',{actor_entity_id:IDS.C2,kind:'travel',title:'返程',status:'active'});
  seed.add('journeys','J_WALK',{mover_entity_id:IDS.C2,action_id:'A_WALK',origin_location_id:IDS.L2,destination_location_id:IDS.L1,status:'moving',segments_json:segments,segment_index:0,segment_time_done_s:25,...extra});
}
const segment=(extra={})=>({routeId:IDS.R_AB,fromLocationId:IDS.L2,toLocationId:IDS.L1,distanceNominalM:100,speedNominalMps:1,quality:'confirmed',...extra});

test('反向双向行程使用反向折线，进度光点从实际出发地开始',async()=>{
  const seed=await makeContactFlowSeed(SQL);
  try{journey(seed,[segment()]);const flow=read(seed).items.find(f=>f.flowId==='J_WALK');assert.deepEqual(flow.path.points,[...points].reverse());assert.equal(flow.progress,.25);}
  finally{seed.close();}
});
test('多段行程中有缺失几何时不连接成一条虚构捷径',async()=>{
  const seed=await makeContactFlowSeed(SQL);
  try{journey(seed,[segment(),segment({routeId:'MISSING',fromLocationId:IDS.L1,toLocationId:IDS.L2})]);const flow=read(seed).items.find(f=>f.flowId==='J_WALK');assert.equal(flow.path,null);assert.equal(flow.reason,'NO_ROUTE_GEOMETRY');}
  finally{seed.close();}
});
test('行程反向走单向路线不展示合法返程线',async()=>{
  const seed=await makeContactFlowSeed(SQL);
  try{seed.db.run('UPDATE routes SET bidirectional=0 WHERE branch_id=? AND id=?',[seed.branchId,IDS.R_AB]);journey(seed,[segment()]);assert.equal(read(seed).items.find(f=>f.flowId==='J_WALK').path,null);}
  finally{seed.close();}
});
test('不同速度路段上的人物光点按当前路段定位，不使用整段耗时百分比冒充距离',async()=>{
  const seed=await makeContactFlowSeed(SQL);
  try{
    journey(seed,[segment(),segment({fromLocationId:IDS.L1,toLocationId:IDS.L2,distanceNominalM:900})],{segment_index:1,segment_time_done_s:450});
    const flow=read(seed).items.find(f=>f.flowId==='J_WALK');
    assert.equal(flow.progress,.55);assert.ok(Math.abs(flow.pathProgress-.75)<1e-12);
  }finally{seed.close();}
});
test('跨图行程保留本图连续路线，但人物已离开本图时不显示虚假的本图位置',async()=>{
  const seed=await makeContactFlowSeed(SQL);
  try{
    seed.add('routes','R_OTHER',{from_location_id:IDS.L1,to_location_id:IDS.L2,map_id:IDS.M2,geometry_json:{kind:'line',coordinates:[[1,1],[4,4]]},geometry_quality:'confirmed',bidirectional:1,status:'open'});
    journey(seed,[segment(),segment({routeId:'R_OTHER',fromLocationId:IDS.L1,toLocationId:IDS.L2})],{segment_index:1,segment_time_done_s:25,destination_location_id:IDS.L2});
    const flow=read(seed).items.find(f=>f.flowId==='J_WALK');
    assert.deepEqual(flow.path.points,[...points].reverse());assert.equal(flow.crossMap,true);assert.equal(flow.pathProgress,null);
  }finally{seed.close();}
});
test('已到达风声在主角未获知时不会泄漏传播来源与路径',async()=>{
  const seed=await makeContactFlowSeed(SQL);
  try{
    knowLocations(seed);
    seed.add('rumor_fronts','RF_ARRIVED',{information_id:'INFO_CONTACT',location_id:IDS.L2,source_front_id:'RF_ORIGIN',source_action_id:'ACT_TRANSMIT',first_available_at_s:20,status:'active',audience_json:{access:'public',tags:[]}});
    assert.ok(read(seed).items.some(f=>f.flowId==='RF_ARRIVED'&&f.path));
    assert.equal(read(seed,'pov').items.some(f=>f.flowId==='RF_ARRIVED'),false);
    knowledge(seed,'INFO_CONTACT');
    assert.ok(read(seed,'pov').items.some(f=>f.flowId==='RF_ARRIVED'&&f.path));
  }finally{seed.close();}
});
test('主角消息目录只显示已经实际获知的风声，知道地点不等于知道当地所有消息',async()=>{
  const seed=await makeContactFlowSeed(SQL);
  try{
    knowLocations(seed);seed.db.run('UPDATE rumor_fronts SET audience_json=? WHERE id=?',[JSON.stringify({access:'public',tags:[]}),'RF_ORIGIN']);
    const catalog=()=>queryCatalog({...seed.ctx,viewMode:'pov'},{kind:'catalog',branchId:seed.branchId,entityKind:'rumor'}).items;
    assert.equal(catalog().some(r=>r.entityId==='RF_ORIGIN'),false);
    knowledge(seed,'INFO_CONTACT');assert.ok(catalog().some(r=>r.entityId==='RF_ORIGIN'));
  }finally{seed.close();}
});
test('未来才收到、未发布或已失效的消息不能提前解锁主角传播路径',async()=>{
  const seed=await makeContactFlowSeed(SQL);
  try{
    knowLocations(seed);knowledge(seed,'INFO_CONTACT',80);
    const visible=()=>read(seed,'pov').items.some(f=>f.flowId==='ACT_TRANSMIT');
    assert.equal(visible(),false);
    seed.db.run('UPDATE knowledge SET first_received_at_s=0 WHERE id=?',['K_INFO_CONTACT']);assert.equal(visible(),true);
    seed.db.run('UPDATE information SET created_at_s=80 WHERE id=?',['INFO_CONTACT']);assert.equal(visible(),false);
    seed.db.run('UPDATE information SET created_at_s=0,expires_at_s=20 WHERE id=?',['INFO_CONTACT']);assert.equal(visible(),false);
  }finally{seed.close();}
});
