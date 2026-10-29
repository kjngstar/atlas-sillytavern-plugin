import test from 'node:test';
import assert from 'node:assert/strict';
import initSql from 'sql.js';
import {makeSeedWith,IDS,insertRows} from './fixtures/atlas-sql/seed.mjs';
import {createSqlRepository} from '../src/atlas-db-repository.ts';
import {createTableReadPort} from '../src/atlas-db-readport.ts';
import {queryBound} from '../src/atlas-db-runtime.ts';
import {createRow} from '../src/atlas-db-defaults.ts';
import {DEFAULT_WORK_BATCHING} from '../src/atlas-work-batching.ts';
import {materializeSpatialDrafts} from '../src/atlas-spatial-planning.ts';
const SQL=await initSql();

test('normal observation and combined geography/layout use two actual calls under a cap of two',async()=>{
  const seed=await makeSeedWith(SQL),bytes=seed.exportBytes();seed.close();
  const calls=[];
  const repo=createSqlRepository({chatUid:IDS.chatA,branchId:IDS.branchMain,modelPort:{request:async request=>{
    calls.push(request);
    const text=request.phase==='observe'?'{"op":"noop"}':[
      {op:'noop'},
      {op:'map.layout.request',ref:IDS.M2,data:{kind:'floor',spec:{rooms:[{id:IDS.L3,w:20,h:15,side:'north'}],contents:[]}}},
    ].map(op=>JSON.stringify(op)).join('\n');
    return {batchId:request.batchId,text,httpStatus:200,finishReason:'stop'};
  }}});
  try{
    await repo.open({bytes});
    const prepared=await repo.prepareTurn({anchor:{chatUid:IDS.chatA,branchId:IDS.branchMain,parentTurnId:IDS.seedTurn,hostMessageUid:'combined-two',variantKey:'v1',baseRevision:0,baseStorageRevision:0,inputHash:'combined-two'},
      userText:'看看教室',assistantText:'教室长20米宽15米。',sourceSnapshot:[{key:'story',hash:'h',kind:'story',text:'教室长20米宽15米。'}],
      phaseBatches:['observe'],manual:false,sceneOnly:true,layoutMaps:[IDS.M2],worldCompletion:{mode:'local',focusLocationIds:[IDS.L3]},
      generationOptions:{maxTokens:0,batching:{charactersPerBatch:0,mapsPerBatch:0,requestsPerOperation:2},workBatching:{...DEFAULT_WORK_BATCHING,extraRequests:0}}});
    assert.equal(calls.length,2,JSON.stringify(prepared.receipt));
    assert.ok(calls[1].allowedOps.includes('map.layout.request'));
    assert.ok(!calls.some(c=>c.promptMode==='atlas-spatial-extract'));
    assert.deepEqual(prepared.receipt.requestAudit.byWorkClass,{observe:1,construction:1});
    assert.equal(prepared.receipt.requestAudit.transports,2);
    const db=repo.getCandidate(prepared.token).db;
    const map=JSON.parse(queryBound(db,'SELECT frame_json FROM maps WHERE branch_id=? AND id=?',[IDS.branchMain,IDS.M2])[0].frame_json);
    assert.ok(map.atlasScene,JSON.stringify(prepared.receipt));
    assert.equal(map.atlasScene.layout.kind,'floor');
    const attempts=JSON.parse(queryBound(db,'SELECT attempts_json FROM turns WHERE id=?',[prepared.receipt.turnId])[0].attempts_json);
    assert.ok(!attempts.some(a=>a.kind==='layout'||a.kind==='layout_evidence'),'local application is not a fabricated network attempt');
  }finally{await repo.close();}
});

test('a same-response container layout resolves only accepted new IDs and keeps local furniture IDs',async()=>{
  const seed=await makeSeedWith(SQL),branchId=IDS.branchMain;
  try{
    insertRows(seed.db,'entity_keys',[{branch_id:branchId,id:'accepted-room',kind:'location'}]);
    const loc=createRow('locations',{name:'新房间',kind:'room',parent_location_id:IDS.L2,map_id:IDS.M2},{branchId,id:'accepted-room',turnId:IDS.seedTurn,clockS:0,nowWallMs:1,rulesetVersion:'atlas-1'});
    insertRows(seed.db,'locations',[loc]);
    insertRows(seed.db,'maps',[createRow('maps',{name:'新房间',kind:'interior',container_location_id:'accepted-room'},{branchId,id:'accepted-map',turnId:IDS.seedTurn,clockS:0,nowWallMs:1,rulesetVersion:'atlas-1'})]);
    const refs=[{alias:'new:room',id:'accepted-room',kind:'location',rowRev:1,declaredByOpId:'op-room'},
      {alias:'new:rejected',id:'absent-room',kind:'location',rowRev:null,declaredByOpId:'op-bad'}];
    const draft={op:'map.layout.request',data:{container_ref:'new:room',kind:'floor',spec:{rooms:[{id:'new:room',w:3,h:3}],contents:[{id:'desk-local',type:'desk',name:'new:room',roomId:'new:room',w:1,h:1}]}}};
    const input={refs,tables:createTableReadPort(seed.db),branchId,mapIds:['accepted-map']};
    const resolved=materializeSpatialDrafts({...input,drafts:[draft]});
    assert.deepEqual(resolved.issues,[]);assert.equal(resolved.operations.length,1);
    assert.equal(resolved.operations[0].ref,'accepted-map');
    assert.equal(resolved.operations[0].data.spec.contents[0].roomId,'accepted-room');
    assert.equal(resolved.operations[0].data.spec.contents[0].id,'desk-local');
    assert.equal(resolved.operations[0].data.spec.contents[0].name,'new:room','display text must not be rewritten as an ID');
    const rejected=materializeSpatialDrafts({...input,drafts:[{...draft,data:{...draft.data,container_ref:'new:rejected'}}]});
    assert.equal(rejected.operations.length,0);assert.ok(rejected.issues.some(i=>i.code==='LAYOUT_CONTAINER_REF_UNKNOWN'));
  }finally{seed.close();}
});

test('same-response new location is committed before its parent layout references it',async()=>{
  const seed=await makeSeedWith(SQL),bytes=seed.exportBytes();seed.close();const calls=[];
  const repo=createSqlRepository({chatUid:IDS.chatA,branchId:IDS.branchMain,modelPort:{request:async request=>{
    calls.push(request);
    const parent=request.messages[1].content.match(/focus=([^、\n]+)/)?.[1];
    const text=request.phase==='observe'?'{"op":"noop"}':[
      {op:'location.upsert',ref:'new:store',data:{name:'器材间',kind:'room',parent_ref:parent}},
      {op:'map.layout.request',ref:IDS.M2,data:{kind:'floor',spec:{rooms:[{id:'new:store',w:3,h:3,side:'north'}],contents:[]}}},
    ].map(op=>JSON.stringify(op)).join('\n');
    return {batchId:request.batchId,text,httpStatus:200,finishReason:'stop'};
  }}});
  try{
    await repo.open({bytes});
    const prepared=await repo.prepareTurn({anchor:{chatUid:IDS.chatA,branchId:IDS.branchMain,parentTurnId:IDS.seedTurn,hostMessageUid:'combined-new',variantKey:'v1',baseRevision:0,baseStorageRevision:0,inputHash:'combined-new'},
      userText:'教室旁有器材间',assistantText:'器材间在教室北侧。',sourceSnapshot:[{key:'story',kind:'story',text:'教室北侧有器材间。'}],
      phaseBatches:['observe'],sceneMaps:true,sceneOnly:true,layoutMaps:[IDS.M2],worldCompletion:{mode:'local',focusLocationIds:[IDS.L3]},
      generationOptions:{maxTokens:0,batching:{charactersPerBatch:0,mapsPerBatch:0,requestsPerOperation:2},workBatching:{...DEFAULT_WORK_BATCHING,extraRequests:0}}});
    assert.equal(calls.length,2,JSON.stringify(prepared.receipt));
    const db=repo.getCandidate(prepared.token).db;
    const room=queryBound(db,'SELECT id,parent_location_id,map_id FROM locations WHERE name=?',['器材间'])[0];
    assert.ok(room,JSON.stringify(prepared.receipt));assert.equal(room.parent_location_id,IDS.L3);assert.equal(room.map_id,IDS.M2);
    const frame=JSON.parse(queryBound(db,'SELECT frame_json FROM maps WHERE id=?',[IDS.M2])[0].frame_json);
    assert.ok(frame.atlasScene.layout.rooms.some(r=>r.id===room.id),JSON.stringify(prepared.receipt));
    assert.ok(!prepared.receipt.issues.some(i=>i.code==='REF_UNKNOWN'||i.code==='ROOM_REF_UNKNOWN'));
  }finally{await repo.close();}
});

test('later configured map batches remain normal calls after the first combined plan',async()=>{
  const seed=await makeSeedWith(SQL),ids=Array.from({length:6},(_,i)=>`combined-map-${i}`);
  for(const id of ids)insertRows(seed.db,'maps',[createRow('maps',{name:id,kind:'world',frame_json:{cols:100,rows:100}},{branchId:IDS.branchMain,id,turnId:IDS.seedTurn,clockS:0,nowWallMs:1,rulesetVersion:'atlas-1'})]);
  const bytes=seed.exportBytes();seed.close();const calls=[];
  const repo=createSqlRepository({chatUid:IDS.chatA,branchId:IDS.branchMain,modelPort:{request:async request=>{
    calls.push(request);
    const scopeLine=request.messages[1].content.split('\n').find(l=>l.startsWith('本图：'));
    const scopes=scopeLine?JSON.parse(scopeLine.slice(3)):[];
    return {batchId:request.batchId,httpStatus:200,finishReason:'stop',text:request.phase==='observe'?'{"op":"noop"}':scopes.map(s=>JSON.stringify({op:'map.layout.request',ref:s.map,data:{kind:'overview',spec:{surface:'mixed',zones:[],features:[],links:[]}}})).join('\n')};
  }}});
  try{
    await repo.open({bytes});
    const prepared=await repo.prepareTurn({anchor:{chatUid:IDS.chatA,branchId:IDS.branchMain,parentTurnId:IDS.seedTurn,hostMessageUid:'combined-many',variantKey:'v1',baseRevision:0,baseStorageRevision:0,inputHash:'combined-many'},
      userText:'',assistantText:'',sourceSnapshot:[],phaseBatches:[],manual:false,sceneOnly:true,layoutMaps:ids,worldCompletion:{mode:'local',focusLocationIds:[IDS.L3]},
      generationOptions:{maxTokens:0,batching:{charactersPerBatch:0,mapsPerBatch:0,requestsPerOperation:4},workBatching:{...DEFAULT_WORK_BATCHING,mapBatches:3,extraRequests:0}}});
    assert.equal(calls.length,4,JSON.stringify(prepared.receipt));
    assert.ok(calls.every(c=>!c.retryOf),'unsent later batches must not consume repair slots');
    for(const id of ids)assert.ok(JSON.parse(queryBound(repo.getCandidate(prepared.token).db,'SELECT frame_json FROM maps WHERE id=?',[id])[0].frame_json).atlasScene,id+' '+JSON.stringify(prepared.receipt));
    assert.deepEqual(prepared.receipt.requestAudit.byWorkClass,{observe:1,construction:1,maps:2});
  }finally{await repo.close();}
});
