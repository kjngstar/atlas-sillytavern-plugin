import test from 'node:test';
import assert from 'node:assert/strict';
import initSql from 'sql.js';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {makeContactFlowSeed} from './fixtures/atlas-sql/contact-flows.mjs';
import {IDS} from './fixtures/atlas-sql/seed.mjs';
import {querySpatialFlows} from '../src/atlas-spatial-flow-views.ts';
import {handleSqlChatRequest} from '../src/atlas-sql-chat.ts';
import {projectReferenceFlows} from '../ui/atlas-reference-flows.mjs';
const SQL=await initSql();
const read=(seed,extra={})=>querySpatialFlows(seed.ctx,{kind:'flows',branchId:IDS.branchMain,mapId:IDS.M1,...extra});

test('选中对象的联系线经过真实 SQL 只读入口，参数不会被路由剥掉',async()=>{
 const seed=await makeContactFlowSeed(SQL);
 try{
  const queries=[];
  const session={repo:{db:seed.db,queryView:q=>{queries.push(q);return querySpatialFlows(seed.ctx,q);}},branchId:IDS.branchMain,chatMetadata:{}};
  const result=await handleSqlChatRequest(session,'ui-read',{kind:'flows',viewMode:'author',mapId:IDS.M1,selectedEntityId:IDS.C1});
  assert.equal(queries[0].selectedEntityId,IDS.C1);
  const relation=result.items.find(f=>f.flowId==='REL_CONTACT');assert.ok(relation.path);assert.equal(relation.fromEntityId,IDS.C1);
  assert.equal(read(seed).items.some(f=>f.kind==='relation'),false);
 }finally{seed.close();}
});
test('传播路径来自已保存路线且进度稳定，读视图不写数据库',async()=>{
 const seed=await makeContactFlowSeed(SQL);
 try{
  const before=Buffer.from(seed.db.export());
  const flow=read(seed).items.find(f=>f.flowId==='ACT_TRANSMIT');
  assert.equal(flow.progress,.4);assert.equal(flow.messageId,'RF_ORIGIN');assert.deepEqual(flow.path.points,[{x:20,y:18},{x:40,y:12},{x:60,y:45},{x:82,y:52}]);
  assert.deepEqual(read(seed).items.find(f=>f.flowId===flow.flowId),flow);
  assert.deepEqual(Buffer.from(seed.db.export()),before);
 }finally{seed.close();}
});
test('反向传播只反转双向路线；缺路线、坏几何和其他地图不补假线',async()=>{
 const seed=await makeContactFlowSeed(SQL);
 try{
  const update=payload=>seed.db.run('UPDATE actions SET payload_json=? WHERE branch_id=? AND id=?',[JSON.stringify({program_kind:'rumor_delivery',front_id:'RF_ORIGIN',information_id:'INFO_CONTACT',from_location_id:IDS.L2,to_location_id:IDS.L1,route_id:IDS.R_AB,depart_at_s:0,arrive_at_s:100,...payload}),IDS.branchMain,'ACT_TRANSMIT']);
  update({});assert.deepEqual(read(seed).items.find(f=>f.flowId==='ACT_TRANSMIT').path.points[0],{x:82,y:52});
  update({route_id:null});assert.equal(read(seed).items.find(f=>f.flowId==='ACT_TRANSMIT').path,null);
  update({});seed.db.run('UPDATE routes SET geometry_json=? WHERE branch_id=? AND id=?',['{}',IDS.branchMain,IDS.R_AB]);assert.equal(read(seed).items.find(f=>f.flowId==='ACT_TRANSMIT').path,null);
  assert.equal(read(seed,{mapId:IDS.M2}).items.find(f=>f.flowId==='ACT_TRANSMIT').path,null);
 }finally{seed.close();}
});
test('到达风声追溯 source_front 和 source_action，不把风声 ID 当地点 ID',async()=>{
 const seed=await makeContactFlowSeed(SQL);
 try{
  seed.add('rumor_fronts','RF_ARRIVED',{information_id:'INFO_CONTACT',location_id:IDS.L2,source_front_id:'RF_ORIGIN',source_action_id:'ACT_TRANSMIT',first_available_at_s:20,status:'active',audience_json:'["public"]'});
  const flow=read(seed).items.find(f=>f.flowId==='RF_ARRIVED');assert.equal(flow.fromLocationId,IDS.L1);assert.equal(flow.progress,1);assert.ok(flow.path);
 }finally{seed.close();}
});
test('主角视角不泄露未知传播、秘密关系和后台路径',async()=>{
 const seed=await makeContactFlowSeed(SQL);
 try{
  const result=querySpatialFlows({...seed.ctx,viewMode:'pov'},{kind:'flows',branchId:IDS.branchMain,mapId:IDS.M1,selectedEntityId:IDS.C1});
  assert.equal(result.items.some(f=>f.flowId==='ACT_TRANSMIT'),false);
  seed.db.run("UPDATE relations SET secrecy='secret' WHERE id='REL_CONTACT'");
  assert.equal(querySpatialFlows({...seed.ctx,viewMode:'pov'},{kind:'flows',branchId:IDS.branchMain,mapId:IDS.M1,selectedEntityId:IDS.C1}).items.some(f=>f.flowId==='REL_CONTACT'),false);
 }finally{seed.close();}
});
test('投影按地图与米格尺度转换，缺几何记录保留为可读卡片',async()=>{
 const seed=await makeContactFlowSeed(SQL);
 try{
  const dto=read(seed,{selectedEntityId:IDS.C1}),node={id:IDS.M1,transform:{units:'meters',metersPerCell:2,scale:1,bounds:{x:0,y:0,w:200,h:120}}};
  const value=projectReferenceFlows(dto,node);assert.equal(value.relations.length,1);assert.equal(value.flows.length,1);assert.deepEqual(value.flows[0].from,[-60,-24]);assert.equal(value.cards.some(c=>c.id==='RF_ORIGIN'),true);
  assert.equal(projectReferenceFlows(dto,{...node,transform:{...node.transform,metersPerCell:null}}).flows.length,0);
  assert.equal(projectReferenceFlows({...dto,metadata:{stale:true}},node).flows.length,0);
 }finally{seed.close();}
});

test('界面切地图、选中对象或切聊天后，迟到的联系与传播查询不会覆盖当前图',async()=>{
 const source=readFileSync(new URL('../ui/atlas-reference/js/app.js',import.meta.url),'utf8');
 const pending=[],renders=[];
 const runtime=vm.createContext({D:{meta:{scopeKey:'A',revision:1}},state:{nodeId:'map-A',selected:{kind:'character',id:'C1'}},
  window:{AtlasHost:{readFlows:(mapId,selectedEntityId)=>new Promise(resolve=>pending.push({mapId,selectedEntityId,resolve}))}},renderPlace:()=>renders.push('place'),renderDock:()=>renders.push('dock'),toast:assert.fail});
 vm.runInContext(source.slice(source.indexOf('let flowReadSequence='),source.indexOf('let mapExportUrl=')),runtime);
 runtime.refreshFlows();assert.equal(pending[0].selectedEntityId,'C1');
 runtime.state.nodeId='map-B';runtime.state.selected={kind:'character',id:'C2'};runtime.refreshFlows();
 pending[1].resolve({scopeKey:'A',revision:1,mapId:'map-B',relations:[{id:'new'}]});await Promise.resolve();
 pending[0].resolve({scopeKey:'A',revision:1,mapId:'map-A',relations:[{id:'old'}]});await Promise.resolve();
 assert.equal(vm.runInContext('scopedFlows.relations[0].id',runtime),'new');assert.equal(renders.length,2);
 runtime.refreshFlows();runtime.D.meta.scopeKey='another-chat';pending[2].resolve({scopeKey:'A',revision:1,mapId:'map-B'});await Promise.resolve();assert.equal(vm.runInContext('scopedFlows',runtime),null);
});
