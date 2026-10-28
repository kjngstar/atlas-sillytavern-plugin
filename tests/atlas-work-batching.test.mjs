import test from 'node:test';
import assert from 'node:assert/strict';
import initSql from 'sql.js';
import {createSqlRepository} from '../src/atlas-db-repository.ts';
import {createRow} from '../src/atlas-db-defaults.ts';
import {queryBound} from '../src/atlas-db-runtime.ts';
import {createDefaultSettingsV2,applySettingsCommand,sanitizeSettingsV2} from '../src/atlas-settings.ts';
import {DEFAULT_WORK_BATCHING} from '../src/atlas-work-batching.ts';
import {createGenerationBudget,budgetedModelPort} from '../src/atlas-sql-generation-budget.ts';
import {planLayoutEvidence,parseLayoutEvidence} from '../src/atlas-layout-evidence.ts';
import {makeSeedWith,IDS,insertRows} from './fixtures/atlas-sql/seed.mjs';
import {encodeSnapshot} from '../src/atlas-db-envelope.ts';
import {openSqlSession,runSqlTurn} from '../src/atlas-sql-session.ts';
import {runSqlModelRetry} from '../src/atlas-sql-retry.ts';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {referencePresetDocument,referenceSettingsCommands} from '../ui/atlas-reference-presets.mjs';
import {toLegacyTurnReceipt} from '../src/atlas-db-state-adapter.ts';
import {normalizeCompletionPolicy} from '../src/atlas-sql-world-completion.ts';
const SQL=await initSql();
const row=(table,id,data)=>createRow(table,data,{branchId:IDS.branchMain,id,turnId:IDS.seedTurn,clockS:0,nowWallMs:1,rulesetVersion:'atlas-1'});
const input=extra=>({anchor:{chatUid:IDS.chatA,branchId:IDS.branchMain,parentTurnId:IDS.seedTurn,hostMessageUid:'work-batch',variantKey:'v1',baseRevision:0,baseStorageRevision:0,inputHash:'work-batch'},userText:'',assistantText:'',sourceSnapshot:[],manual:true,sceneOnly:true,phaseBatches:[],operations:[],...extra});
const scopes=req=>JSON.parse(req.messages[1].content.split('\n').find(l=>l.startsWith('本图：')).slice(3));
const layout=s=>({op:'map.layout.request',ref:s.map,data:{kind:s.kind,spec:s.kind==='floor'?{rooms:s.baselineRooms}:s.kind==='city'?{districts:[{id:s.container.ref,name:s.container.name,bank:'west',order:0}],buildings:s.locations.filter(l=>l.kind==='building').map(l=>({id:l.ref,name:l.name,districtId:s.container.ref,w:s.childSpaces.find(c=>c.ref===l.ref)?.w??100,h:s.childSpaces.find(c=>c.ref===l.ref)?.h??100})),enclosure:'open',riverWidth:0}:{surface:'mixed',zones:s.locations.map(l=>({id:l.ref,name:l.name,role:l.kind==='city'?'city':'other',size:'medium'})),features:[],links:[]}}});
const reply=req=>scopes(req).map(s=>JSON.stringify(layout(s))).join('\n');
const scene=(db,id)=>JSON.parse(queryBound(db,'SELECT frame_json FROM maps WHERE id=?',[id])[0].frame_json).atlasScene;
async function fixture(count,{seed:configure,work={},maxTokens=0,respond}={}){
 const seed=await makeSeedWith(SQL),ids=Array.from({length:count},(_,i)=>`work-map-${i}`);
 for(const id of ids)insertRows(seed.db,'maps',[row('maps',id,{name:id,kind:'world',frame_json:{cols:100,rows:100}})]);
 configure?.(seed.db);const bytes=seed.exportBytes();seed.close();const calls=[];
 const repo=createSqlRepository({chatUid:IDS.chatA,branchId:IDS.branchMain,modelPort:{generationOptions:async()=>({maxTokens,batching:{charactersPerBatch:0,mapsPerBatch:0,requestsPerOperation:0},workBatching:{...DEFAULT_WORK_BATCHING,...work}}),request:async req=>{calls.push(req);return {batchId:req.batchId,httpStatus:200,finishReason:'stop',...await respond?.(req,calls.length)??{text:req.promptMode==='atlas-spatial-extract'?'{"facts":[]}':reply(req)}};}}});
 await repo.open({bytes});return {repo,calls,ids};
}
test('workload batch counts are independent from legacy per-entity quantities and preserve on older updates',()=>{
 const settings=sanitizeSettingsV2({...createDefaultSettingsV2(),workBatching:undefined,modelBatching:{charactersPerBatch:24,mapsPerBatch:8}}).settings;
 assert.deepEqual(settings.workBatching,DEFAULT_WORK_BATCHING);assert.equal(settings.modelBatching.charactersPerBatch,24);
 const saved=applySettingsCommand(settings,{action:'runtime.update',workBatching:{...DEFAULT_WORK_BATCHING,mapBatches:3,extraRequests:0}});assert.equal(saved.ok,true);
 const older=applySettingsCommand(saved.settings,{action:'runtime.update',modelBatching:{charactersPerBatch:2,mapsPerBatch:2}});assert.equal(older.settings.workBatching.mapBatches,3);
 for(const n of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1])assert.equal(applySettingsCommand(settings,{action:'runtime.update',workBatching:{...DEFAULT_WORK_BATCHING,mapBatches:n}}).ok,false);
});
test('12 maps use one shared evidence request and one planning request',async()=>{
 const f=await fixture(12);try{
  const result=await f.repo.prepareTurn(input({layoutMaps:f.ids,sourceSnapshot:[{key:'story',kind:'story',text:'地图中的道路相互连通。'}]}));
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].promptMode,'atlas-spatial-extract');assert.equal(f.calls[1].batchTargets.count,12);
  const db=f.repo.getCandidate(result.token).db;for(const id of f.ids)assert.ok(scene(db,id));
  const usage=JSON.parse(queryBound(db,'SELECT decisions_json FROM turns WHERE id=?',[result.receipt.turnId])[0].decisions_json).work_usage;
  assert.deepEqual(usage,{normal:{evidence:1,maps:1},extra:0,transports:2});
  assert.equal(result.receipt.requestAudit.transports,f.calls.length);assert.deepEqual(result.receipt.requestAudit.byWorkClass,{evidence:1,maps:1});
  const stored=JSON.parse(queryBound(db,'SELECT receipt_json FROM turns WHERE id=?',[result.receipt.turnId])[0].receipt_json);assert.deepEqual(stored.requestAudit,result.receipt.requestAudit);
 }finally{await f.repo.close();}
});
test('three user-selected batches process 12 maps as 4 / 4 / 4 with no repeated evidence',async()=>{
 const f=await fixture(12,{work:{mapBatches:3}});try{
  const result=await f.repo.prepareTurn(input({layoutMaps:f.ids,sourceSnapshot:[{key:'story',kind:'story',text:'地图中的道路相互连通。'}]}));
  assert.deepEqual(f.calls.filter(r=>r.batchTargets).map(r=>r.batchTargets.count),[4,4,4]);assert.equal(f.calls.length,4);
  for(const id of f.ids)assert.ok(scene(f.repo.getCandidate(result.token).db,id));
 }finally{await f.repo.close();}
});
test('mixed map kinds and four hierarchy levels share one planning request with parent-first materialization',async()=>{
 const f=await fixture(0,{seed:db=>{
  insertRows(db,'maps',[row('maps','city-map',{name:'城市图',kind:'site',container_location_id:IDS.L1,meters_per_cell:10,scale_quality:'confirmed',frame_json:{cols:100,rows:100}}),row('maps','school-map',{name:'学校图',kind:'interior',container_location_id:IDS.L2,meters_per_cell:1,scale_quality:'confirmed',frame_json:{cols:100,rows:100}})]);
  db.run("UPDATE locations SET grid_x=NULL,grid_y=NULL,coord_precision='unknown' WHERE id=? AND branch_id=?",[IDS.L1,IDS.branchMain]);
  db.run('UPDATE locations SET map_id=?,grid_x=NULL,grid_y=NULL,coord_precision=\'unknown\' WHERE id=? AND branch_id=?',['city-map',IDS.L2,IDS.branchMain]);
  db.run('UPDATE locations SET map_id=?,grid_x=NULL,grid_y=NULL,coord_precision=\'unknown\' WHERE id=? AND branch_id=?',['school-map',IDS.L3,IDS.branchMain]);
 }});try{
  const result=await f.repo.prepareTurn(input({layoutMaps:[IDS.M2,'school-map','city-map',IDS.M1]}));
  assert.equal(f.calls.length,1);assert.deepEqual(new Set(scopes(f.calls[0]).map(s=>s.kind)),new Set(['overview','city','floor']));
  const db=f.repo.getCandidate(result.token).db;for(const id of [IDS.M1,'city-map','school-map',IDS.M2])assert.ok(scene(db,id),JSON.stringify(result.receipt.issues));
  const footprint=scene(db,'school-map').layout.rooms.find(r=>r.id===IDS.L3),child=scene(db,IDS.M2);
  assert.equal(child.layout.bounds.w,footprint.w);assert.equal(child.layout.bounds.h,footprint.h);
 }finally{await f.repo.close();}
});
test('known output capacity never silently increases the configured map batch count',async()=>{
 const f=await fixture(12,{maxTokens:768});try{
  const result=await f.repo.prepareTurn(input({layoutMaps:f.ids}));assert.equal(f.calls.length,0);assert.ok(result.receipt.issues.some(i=>i.code==='LAYOUT_BATCH_CAPACITY'));assert.equal(result.receipt.status,'partial');
  const publicReceipt=toLegacyTurnReceipt(result.receipt);assert.equal(publicReceipt.retryable,true);assert.deepEqual(publicReceipt.receipt.requestPlan,result.receipt.requestPlan);
 }finally{await f.repo.close();}
});
test('actual context overflow does not silently split one planned map request into many',async()=>{
 const f=await fixture(12,{respond:()=>{throw Error('context_length_exceeded');}});try{
  const result=await f.repo.prepareTurn(input({layoutMaps:f.ids}));assert.equal(f.calls.length,1);assert.ok(result.receipt.issues.some(i=>i.code==='LAYOUT_BATCH_PENDING'));
 }finally{await f.repo.close();}
});
test('all repair layers share one extra request slot and compatibility sends use the same ledger',async()=>{
 const budget=createGenerationBudget({workBatching:{...DEFAULT_WORK_BATCHING}}),calls=[];
 const port=budgetedModelPort({request:async req=>{calls.push(req);return {batchId:req.batchId,text:'{"op":"noop"}'};}},budget,'geography');
 const req=(id,kind,retryOf)=>({...input({}).anchor,batchId:id,phase:'geography',messages:[],allowedOps:['noop'],maxTokens:0,timeoutMs:1,workClass:kind,retryOf});
 await port.request(req('maps','maps'));await port.request(req('evidence','evidence'));await port.request(req('map-repair','maps','maps'));
 await assert.rejects(port.request(req('evidence-repair','evidence','evidence')),/额外请求额度/);assert.equal(calls.length,3);
 assert.equal(budget.claimTransport('geography','maps').ok,false);assert.equal(budget.used(),3);
 assert.deepEqual(budget.workUsage(),{normal:{maps:1,evidence:1},extra:1,transports:3});
});
test('workload evidence batching covers all source spans rather than selecting one best chunk',()=>{
 const text='城市东侧有道路。'.repeat(5000),snapshot=[{key:'long-story',kind:'story',text}],maps=[{id:'map',alias:'M1',name:'城市'}];
 for(const batchCount of [1,3]){
  const batches=planLayoutEvidence(snapshot,maps,input({}).anchor,'evidence',{batchCount});assert.equal(batches.length,batchCount);
  const chunks=batches.flatMap(b=>b.chunks);assert.equal(chunks[0].start,0);assert.equal(chunks.at(-1).end,text.length);assert.ok(batches.every(b=>b.omittedBatches===0));
  for(let i=1;i<chunks.length;i++)assert.ok(chunks[i].start<=chunks[i-1].end);
 }
 const many=Array.from({length:30},(_,i)=>({id:`map${i}`,alias:`M${i}`,name:`地点${i}`}));
 const batch=planLayoutEvidence([{key:'s',kind:'story',text:'道路位于城市东侧。'}],many,input({}).anchor,'facts',{batchCount:1})[0];
 assert.equal(parseLayoutEvidence(JSON.stringify({facts:many.map(m=>({mapRef:m.id,segmentRef:'S1'}))}),batch.chunks,many,[],{complete:true}).length,30);
});

test('missing maps use one supplemental request without replaying successful maps',async()=>{
 const f=await fixture(4,{respond:(req,n)=>({text:(n===1?scopes(req).slice(0,3):scopes(req)).map(s=>JSON.stringify(layout(s))).join('\n')})});try{
  const result=await f.repo.prepareTurn(input({layoutMaps:f.ids}));assert.deepEqual(f.calls.map(r=>r.batchTargets.count),[4,1]);
  const db=f.repo.getCandidate(result.token).db;for(const id of f.ids)assert.ok(scene(db,id));assert.equal(result.receipt.status,'committed');
 }finally{await f.repo.close();}
});
test('a transport retry and bad JSON cannot trigger another independent format retry',async()=>{
 const f=await fixture(2,{respond:(req,n)=>{if(n===1)throw Object.assign(Error('temporary transport failure'),{retryable:true});return {text:'{"op":'};}});try{
  await assert.rejects(f.repo.prepareTurn(input({layoutMaps:f.ids})),{code:'TURN_FAILED'});assert.equal(f.calls.length,2);
 }finally{await f.repo.close();}
});
test('zero extra quota preserves valid evidence maps and defers rejected maps without a repair request',async()=>{
 const f=await fixture(2,{work:{extraRequests:0},respond:req=>({text:req.promptMode==='atlas-spatial-extract'?JSON.stringify({facts:[{mapRef:'M2',segmentRef:'missing'}]}):reply(req)})});try{
  const result=await f.repo.prepareTurn(input({layoutMaps:f.ids,sourceSnapshot:[{key:'s',kind:'story',text:'城市东侧是道路。'}]}));
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].batchTargets.count,1);assert.equal(result.receipt.status,'partial');
  const db=f.repo.getCandidate(result.token).db;assert.ok(scene(db,f.ids[0]));assert.equal(scene(db,f.ids[1]),undefined);
 }finally{await f.repo.close();}
});

async function actorSession(total,{work={},respond,seed:configure}={}){
 const seed=await makeSeedWith(SQL);for(let i=4;i<total;i++){
  const id=`work-person-${i}`;insertRows(seed.db,'entity_keys',[{branch_id:IDS.branchMain,id,kind:'character'}]);insertRows(seed.db,'characters',[row('characters',id,{name:`人物${i}`,role:'npc',importance:'supporting',location_id:IDS.L3,status:'active',physical_status:'alive'})]);
 }
 configure?.(seed.db);const metadata={atlas:{database:await encodeSnapshot(seed.exportBytes(),{chatUid:IDS.chatA,worldUid:'work-world',storageRevision:0,activeBranchId:IDS.branchMain})}};seed.close();const calls=[],config={...DEFAULT_WORK_BATCHING,...work};
 const session=await openSqlSession({chatUid:IDS.chatA,branchId:IDS.branchMain,chatMetadata:metadata,saveSession:async()=>({result:'saved',confirmed:true}),modelPort:{generationOptions:async()=>({maxTokens:0,batching:{charactersPerBatch:0,mapsPerBatch:0,requestsPerOperation:0},workBatching:config}),request:async req=>{calls.push(req);const text=await respond?.(req,calls.length)??(req.phase==='observe'?JSON.stringify({op:'event.propose',data:{title:'休息结束',phase:'observed',activity:{kind:'rest',completed:true},time_hint:{elapsed_s:60}}}):'{"op":"noop"}');return {batchId:req.batchId,text,httpStatus:200,finishReason:'stop'};}}});
 return {session,calls,config,turn:()=>runSqlTurn(session,input({manual:false,sceneOnly:false,phaseBatches:['observe'],assistantText:'休息了一分钟。'}))};
}
test('20 people configured as three workload batches are processed 7 / 7 / 6',async()=>{
 const f=await actorSession(20,{work:{characterBatches:3}});try{
  const result=await f.turn();assert.equal(result.coreSaved,true);assert.equal(result.receipt.status,'committed');assert.deepEqual(f.calls.filter(r=>r.phase==='decision').map(r=>r.batchTargets.count),[7,7,6]);assert.equal(f.calls.length,4);
 }finally{await f.session.repo.close();}
});
test('continuation retains used batch quotas until the user adds a batch, without repeating observation',async()=>{
 let fail=true;const f=await actorSession(20,{respond:req=>{if(req.phase==='decision'&&fail)throw Error('model temporarily unavailable');}});try{
  const first=await f.turn();assert.equal(first.receipt.status,'partial');assert.equal(f.calls.length,2);fail=false;
  const blocked=await runSqlModelRetry(f.session,{turnId:first.receipt.turnId});assert.equal(blocked.receipt.status,'partial');assert.equal(f.calls.length,2);
  f.config.characterBatches=2;const resumed=await runSqlModelRetry(f.session,{turnId:first.receipt.turnId});assert.equal(resumed.receipt.status,'committed');assert.equal(f.calls.length,3);assert.equal(f.calls.filter(r=>r.phase==='observe').length,1);assert.equal(resumed.receipt.requestAudit.transports,f.calls.length);assert.equal(resumed.receipt.requestAudit.calls.at(-1).reason,'background_resume');
  const usage=JSON.parse(queryBound(f.session.repo.db,'SELECT decisions_json FROM turns WHERE id=?',[first.receipt.turnId])[0].decisions_json).work_usage;assert.equal(usage.normal.characters,2);assert.equal(usage.transports,3);
 }finally{await f.session.repo.close();}
});
const dueWork=db=>{for(const [id,actor] of [['work-a',IDS.C2],['work-b',IDS.C3]])insertRows(db,'actions',[row('actions',id,{actor_entity_id:actor,kind:'prepare',title:'整理物品',status:'active',started_at_s:0,evaluated_until_s:0,duration_json:{min_s:30,nominal_s:30,max_s:30,quality:'explicit',basis_refs:[]}})]);};
const dueActions=req=>JSON.parse(req.messages[1].content.split('\n').find(l=>l.startsWith('行动：')).slice(3));
const completed=action=>JSON.stringify({op:'event.propose',data:{title:`完成${action.id}`,phase:'simulated',action_ref:action.id,effects:[{type:'action_result',action_ref:action.id,value:'completed'}]}});
test('independent due actions at the same causal time share one outcome request',async()=>{
 const f=await actorSession(4,{seed:dueWork,respond:req=>req.phase==='outcome'?dueActions(req).map(completed).join('\n'):undefined});try{
  const result=await f.turn();assert.equal(result.receipt.status,'committed',JSON.stringify(result.receipt.issues));assert.equal(f.calls.filter(r=>r.phase==='outcome').length,1);assert.equal(dueActions(f.calls.find(r=>r.phase==='outcome')).length,2);
  assert.deepEqual(queryBound(f.session.repo.db,"SELECT status FROM actions WHERE id IN ('work-a','work-b') ORDER BY id").map(r=>r.status),['completed','completed']);
 }finally{await f.session.repo.close();}
});
test('an incomplete outcome batch keeps the unresolved action pending and never reruns a completed action',async()=>{
 const f=await actorSession(4,{seed:dueWork,respond:req=>req.phase==='outcome'?completed(dueActions(req)[0]):undefined});try{
  const first=await f.turn();assert.equal(first.receipt.status,'partial');assert.equal(f.calls.filter(r=>r.phase==='outcome').length,1);
  f.config.outcomeBatches=2;const resumed=await runSqlModelRetry(f.session,{turnId:first.receipt.turnId});assert.equal(resumed.receipt.status,'committed',JSON.stringify(resumed.receipt.issues));
  const batches=f.calls.filter(r=>r.phase==='outcome').map(dueActions);assert.deepEqual(batches.map(a=>a.length),[2,1]);assert.notEqual(batches[0][0].id,batches[1][0].id);
 }finally{await f.session.repo.close();}
});
test('workload editor saves batch counts, clears legacy object caps and preserves new settings on old backup import',async()=>{
 let settings={...createDefaultSettingsV2(),modelBatching:{charactersPerBatch:24,mapsPerBatch:8,requestsPerOperation:0}};let id=0;
 const w={crypto:{randomUUID:()=>`work-editor-${++id}`},TextEncoder};vm.runInContext(readFileSync(new URL('../ui/atlas-reference/js/presets.js',import.meta.url),'utf8'),vm.createContext({window:w,TextEncoder,URL}));
 const store=w.AtlasPresetStore.create([],{storage:null,initialDocument:referencePresetDocument(settings),onPersist:async(doc,action)=>{for(const command of referenceSettingsCommands(doc,settings,action)){const saved=applySettingsCommand(settings,command);assert.equal(saved.ok,true);settings=saved.settings;}}});
 await store.saveWorkBatching();assert.equal(settings.modelBatching.mapsPerBatch,0,'saving unchanged default batch counts still replaces legacy object caps');
 store.workDraft().mapBatches=3;await store.saveWorkBatching();assert.equal(settings.workBatching.mapBatches,3);assert.equal(settings.modelBatching.mapsPerBatch,0);assert.equal(settings.modelBatching.charactersPerBatch,0);assert.equal(store.workDirty(),false);
 const old=JSON.parse(JSON.stringify(store.exportValue()));delete old.workBatching;await store.importValue(old);assert.equal(settings.workBatching.mapBatches,3);
 store.workDraft().mapBatches=0;await assert.rejects(store.saveWorkBatching(),/正整数/);assert.equal(store.workDraft().mapBatches,0);assert.equal(settings.workBatching.mapBatches,3);
});

test('workload construction uses the response protocol capacity instead of the former 12-location / 2-level split',async()=>{
 const policy=normalizeCompletionPolicy({budgetMode:'workload',maxNewLocations:64,maxNewRoutes:64,maxAdditionalDepth:12});assert.equal(policy.maxNewLocations,64);assert.equal(policy.maxAdditionalDepth,12);
 const f=await fixture(0,{respond:req=>({text:req.phase==='observe'?'{"op":"noop"}':Array.from({length:13},(_,i)=>JSON.stringify({op:'location.upsert',ref:`new:planned-building-${i}`,data:{name:`批量地点${i}`,kind:'building',parent_ref:'L1'}})).join('\n')})});try{
  const result=await f.repo.prepareTurn(input({manual:false,phaseBatches:['observe'],worldCompletion:{mode:'bootstrap',focusLocationIds:[],policy:{version:1,density:'balanced',maxNewLocations:12,maxNewRoutes:16,maxAdditionalDepth:2}},sourceSnapshot:[{key:'s',kind:'story',text:'这座城市中有许多建筑。'}]}));
  const db=f.repo.getCandidate(result.token).db;assert.equal(queryBound(db,"SELECT count(*) AS n FROM locations WHERE name LIKE '批量地点%'")[0].n,13,JSON.stringify(result.receipt.issues));assert.equal(f.calls.length,2);
 }finally{await f.repo.close();}
});
