import test from 'node:test';
import assert from 'node:assert/strict';
import initSql from 'sql.js';
import {createSqlRepository} from '../src/atlas-db-repository.ts';
import {queryBound} from '../src/atlas-db-runtime.ts';
import {makeSeedWith,IDS,insertRows} from './fixtures/atlas-sql/seed.mjs';
import {createRow} from '../src/atlas-db-defaults.ts';
import {planLayoutEvidence,parseLayoutEvidence,layoutEvidenceSegments} from '../src/atlas-layout-evidence.ts';
import {generateFloor} from '../vendor/atlas-spatial/generation.mjs';
import {baselineFloorRooms,buildSqlLayoutTask,unknownLayoutEntityRefs} from '../src/atlas-sql-layout-task.ts';
import {separateConstructionRouteRefs,dedupeWorldConstructionOps} from '../src/atlas-sql-world-dedupe.ts';
import {toLegacyTurnReceipt} from '../src/atlas-db-state-adapter.ts';
import {buildStagePrompt} from '../src/atlas-ops-prompts.ts';
const SQL=await initSql();
const anchor={chatUid:IDS.chatA,branchId:IDS.branchMain,parentTurnId:IDS.seedTurn,hostMessageUid:'two-stage-repair',variantKey:'v1',baseRevision:0,baseStorageRevision:0,inputHash:'repair'};
const input=extra=>({anchor,userText:'',assistantText:'',sourceSnapshot:[],manual:true,sceneOnly:true,phaseBatches:[],operations:[],sceneMaps:true,layoutMaps:[IDS.M1],...extra});
const validLayout=()=>JSON.stringify({op:'map.layout.request',ref:IDS.M1,data:{kind:'overview',spec:{surface:'mixed',zones:[{id:IDS.L1,name:'城市',role:'city',size:'medium'}]}}});
async function repoWith(fn){const seed=await makeSeedWith(SQL),bytes=seed.exportBytes();seed.close();const calls=[];const repo=createSqlRepository({chatUid:IDS.chatA,branchId:IDS.branchMain,modelPort:{async request(req){calls.push(req);return {batchId:req.batchId,httpStatus:200,...await fn(req,calls.length)};}}});await repo.open({bytes});return {repo,calls};}

for(const repair of [false,true])test(`layout length response is rejected even with complete JSON (repair=${repair})`,async()=>{
 const {repo,calls}=await repoWith((req,n)=>({text:repair&&n===1?'broken JSON':validLayout(),finishReason:repair&&n===1?'stop':'length'}));
 try{
  const before=JSON.parse(queryBound(repo.db,'SELECT frame_json FROM maps WHERE id=?',[IDS.M1])[0].frame_json).atlasScene;
  const result=await repo.prepareTurn(input());
  assert.equal(calls.length,repair?2:1);
  assert.ok(result.receipt.issues.some(i=>i.code==='LAYOUT_MODEL_FAILED'&&i.message.includes('截断')));
  const after=JSON.parse(queryBound(repo.getCandidate(result.token).db,'SELECT frame_json FROM maps WHERE id=?',[IDS.M1])[0].frame_json).atlasScene;
  assert.deepEqual(after,before);
  assert.notEqual(result.receipt.status,'committed');
 }finally{await repo.close();}
});

test('real quotes across chunk and batch boundaries remain verifiable; selected IDs restore original text',()=>{
 const quote='码头位于仓库东侧。',text='甲'.repeat(1795)+quote+'乙'.repeat(8995)+quote+'丙'.repeat(2000);
 const maps=[{id:'map',alias:'M1',name:'码头'}],batches=planLayoutEvidence([{key:'s',kind:'story',hash:'h',text}],maps,anchor,'test');
 assert.ok(batches.length>1);
 for(const offset of [1795,1795+quote.length+8995]){
  const batch=batches.find(b=>b.chunks[0].start<=offset&&b.chunks.at(-1).end>=offset+quote.length);
  assert.ok(batch);
  const fact=parseLayoutEvidence(JSON.stringify({facts:[{mapRef:'M1',quote}]}),batch.chunks,maps)[0];
  assert.equal(text.slice(fact.start,fact.end),quote);
 }
 const segments=layoutEvidenceSegments(batches[0].chunks),segment=segments.find(s=>s.text.includes('码头'));
 const fact=parseLayoutEvidence(JSON.stringify({facts:[{mapRef:'M1',segmentRef:segment.ref}]}),batches[0].chunks,maps)[0];
 assert.equal(fact.text,text.slice(fact.start,fact.end));
 assert.ok(batches.every(b=>b.chunks.reduce((n,c)=>n+c.text.length,0)<=12000));
});

test('one map with unverifiable evidence does not block another map',async()=>{
 const {repo,calls}=await repoWith(req=>{
  if(req.batchId.includes('_evidence_'))return {text:JSON.stringify({facts:[{mapRef:IDS.M1,quote:'原文不存在的方位'},{mapRef:IDS.M2,quote:'教室在学校内。'}]}),finishReason:'stop'};
  const scopes=JSON.parse(req.messages[1].content.split('\n').find(l=>l.startsWith('本图：')).slice(3));
  return {text:scopes.map(s=>JSON.stringify({op:'map.layout.request',ref:s.map,data:{kind:s.kind,spec:{rooms:s.baselineRooms}}})).join('\n'),finishReason:'stop'};
 });
 try{
  const result=await repo.prepareTurn(input({layoutMaps:[IDS.M1,IDS.M2],sourceSnapshot:[{key:'story',kind:'story',hash:'h',text:'教室在学校内。'}]}));
  assert.equal(calls.filter(r=>r.batchId.includes('_evidence_')).length,2);
  assert.equal(calls.filter(r=>!r.batchId.includes('_evidence_')).length,1);
  const db=repo.getCandidate(result.token).db;
  assert.ok(JSON.parse(queryBound(db,'SELECT frame_json FROM maps WHERE id=?',[IDS.M2])[0].frame_json).atlasScene);
  assert.ok(result.receipt.issues.some(i=>i.code==='LAYOUT_BATCH_PENDING'&&i.message.startsWith('1 张')));
 }finally{await repo.close();}
});

test('uncalibrated parent grows its frame without shrinking canonical children',()=>{
 const rooms=baselineFloorRooms(Array.from({length:5},(_,i)=>({id:`r${i}`,name:`房间${i}`})),{width:24,height:24},id=>id);
 const context={scope:{chatId:'chat',branchId:'main',revision:1,viewMode:'author'},map:{id:'parent',containerLocationId:'house',frame:{cols:100,rows:100},metersPerCell:null,scaleQuality:'uncalibrated',scaleLocked:false},entities:{locations:rooms.map(r=>r.id)},childSpaces:{r2:{widthM:12,heightM:8,quality:'estimated'}},autoPlan:true};
 const value={width:24,height:24,corridorWidth:2,rooms};
 const result=generateFloor(value,context);
 assert.equal(result.ok,true,JSON.stringify(result.issues));
 assert.ok(result.plannedSize.widthM>=28);
 assert.equal(result.scene.constraints.rooms.find(r=>r.id==='r2').w,12);
 assert.equal(result.scene.layout.rooms.length,5);
 const locked=generateFloor(value,{...context,map:{...context.map,scaleLocked:true}});
 assert.equal(locked.ok,false);
});

test('new parent and child task share the first physical estimate',async()=>{
 const seed=await makeSeedWith(SQL);
 try{
  // L2 is the school; L3 is its classroom. Add an uncalibrated parent map.
  const map=createRow('maps',{name:'学校',kind:'interior',container_location_id:IDS.L2,frame_json:{cols:100,rows:100},meters_per_cell:null,scale_quality:'uncalibrated'},{branchId:IDS.branchMain,id:'school-map',turnId:IDS.seedTurn,clockS:0,nowWallMs:1,rulesetVersion:'atlas-1'});
  insertRows(seed.db,'maps',[map]);
  seed.db.run('UPDATE locations SET map_id=? WHERE id=? AND branch_id=?',['school-map',IDS.L3,IDS.branchMain]);
  seed.db.run('UPDATE maps SET meters_per_cell=NULL,scale_quality=?,frame_json=? WHERE id=? AND branch_id=?',['uncalibrated',JSON.stringify({cols:100,rows:100}),IDS.M2,IDS.branchMain]);
  const task=buildSqlLayoutTask(seed.db,IDS.branchMain,input({layoutMaps:['school-map',IDS.M2]}),'test');
  const scopes=JSON.parse(task.request.messages[1].content.split('\n').find(l=>l.startsWith('本图：')).slice(3));
  const parent=scopes.find(s=>s.baselineRooms?.some(r=>scopes.some(other=>other.container?.ref===r.id))),child=scopes.find(s=>s.map!==parent?.map);
  assert.ok(parent&&child,JSON.stringify(scopes));
  const footprint=parent.baselineRooms.find(r=>r.id===child.container.ref);
  assert.equal(child.extent.width,footprint.w);assert.equal(child.extent.height,footprint.h);
 }finally{seed.close();}
});

test('location and route aliases are separated while endpoint identities stay unchanged',()=>{
 const ops=[{op:'location.upsert',ref:'new:river',data:{name:'河道',kind:'natural'}},{op:'route.propose',ref:'new:river',data:{from_ref:'L1',to_ref:'new:river'}}];
 const result=dedupeWorldConstructionOps({operations:ops});
 assert.equal(result.operations[0].ref,'new:river');
 assert.match(result.operations[1].ref,/^new:route:/);
 assert.equal(result.operations[1].data.to_ref,'new:river');
 assert.ok(result.issues.some(i=>i.code==='WORLD_ROUTE_REF_ASSIGNED'));
 const reused=separateConstructionRouteRefs([ops[1]],['new:river']);
 assert.match(reused.operations[0].ref,/^new:route:/);
});

test('partial spatial failures retain retryability through the UI adapter',()=>{
 const native={turnId:'turn',anchor,status:'partial',groups:[],issues:[{code:'LAYOUT_MODEL_FAILED',path:'$.layout',message:'摘录未完成',severity:'warning',retryable:true}],clockBeforeS:0,clockAfterS:0,simulatedUntilS:0,worldChanged:false,timeChanged:false};
 assert.equal(toLegacyTurnReceipt(native,{coreSaved:true}).retryable,true);
});

test('layout-only protocol does not offer noop as its example',()=>{
 const request=buildStagePrompt({phase:'geography',allowedOps:['map.layout.request','noop']});
 assert.ok(!request.messages[0].content.includes('格式示例：\n{"op":"noop"}'));
 assert.ok(!request.messages[1].content.includes('发生变化'));
 assert.ok(request.messages[1].content.includes('必须完成'));
  assert.ok(!request.messages[0].content.includes('{实际字段}'));
  assert.ok(!request.messages[0].content.includes('只写发生变化'));
});

test('invented entity IDs get one fresh repair before geometry while local furniture IDs remain valid',async()=>{
 const {repo,calls}=await repoWith((req,n)=>({text:n===1?JSON.stringify({op:'map.layout.request',ref:IDS.M1,data:{kind:'overview',spec:{zones:[{id:'B1',name:'虚构建筑',role:'city',size:'medium'}]}}}):validLayout(),finishReason:'stop'}));
 try{
  const result=await repo.prepareTurn(input());
  assert.equal(calls.length,2);
  assert.match(calls[1].messages[1].content,/未登记实体引用 B1/);
  assert.ok(!result.receipt.issues.some(issue=>issue.code==='ENTITY_REF_UNKNOWN'));
  assert.ok(JSON.parse(queryBound(repo.getCandidate(result.token).db,'SELECT frame_json FROM maps WHERE id=?',[IDS.M1])[0].frame_json).atlasScene);
  assert.deepEqual(unknownLayoutEntityRefs([{op:'map.layout.request',data:{spec:{rooms:[{id:'L1'}],contents:[{id:'local-bed',roomId:'L1'}],actors:[{id:'C1',roomId:'L1',near:'local-bed'}],items:[{id:'I1',on:'local-bed'}]}}}],[{id:'location',alias:'L1'},{id:'character',alias:'C1'},{id:'item',alias:'I1'}]),[]);
 }finally{await repo.close();}
});
