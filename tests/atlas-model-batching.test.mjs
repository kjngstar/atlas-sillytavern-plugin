import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import initSql from 'sql.js';
import {createSqlRepository} from '../src/atlas-db-repository.ts';
import {createRow} from '../src/atlas-db-defaults.ts';
import {queryBound} from '../src/atlas-db-runtime.ts';
import {createDefaultSettingsV2,applySettingsCommand,sanitizeSettingsV2,settingsViewV2} from '../src/atlas-settings.ts';
import {characterBatchLimit,planningOutputTokens} from '../src/atlas-model-batching.ts';
import {createSqlModelPort} from '../src/atlas-sql-model-port.ts';
import {buildStagePrompt} from '../src/atlas-ops-prompts.ts';
import {buildSqlLayoutTask} from '../src/atlas-sql-layout-task.ts';
import {encodeSnapshot} from '../src/atlas-db-envelope.ts';
import {openSqlSession,runSqlTurn} from '../src/atlas-sql-session.ts';
import {runSqlModelRetry} from '../src/atlas-sql-retry.ts';
import {referencePresetDocument,referenceSettingsCommands} from '../ui/atlas-reference-presets.mjs';
import {makeSeedWith,IDS,insertRows} from './fixtures/atlas-sql/seed.mjs';
const SQL=await initSql();
const input=extra=>({anchor:{chatUid:IDS.chatA,branchId:IDS.branchMain,parentTurnId:IDS.seedTurn,hostMessageUid:'batching',variantKey:'v1',baseRevision:0,baseStorageRevision:0,inputHash:'batching'},userText:'',assistantText:'查看地图。',sourceSnapshot:[],manual:true,sceneOnly:true,phaseBatches:[],operations:[],...extra});
const row=(table,id,data)=>createRow(table,data,{branchId:IDS.branchMain,id,turnId:IDS.seedTurn,clockS:0,nowWallMs:1,rulesetVersion:'atlas-1'});
const scopes=req=>JSON.parse(req.messages[1].content.split('\n').find(l=>l.startsWith('本图：')).slice(3));
const layout=scope=>({op:'map.layout.request',ref:scope.map,data:{kind:scope.kind,spec:scope.kind==='floor'?{rooms:scope.baselineRooms}:scope.kind==='city'?{districts:[{id:scope.container.ref,bank:'west',order:0}],buildings:[],enclosure:'open',riverWidth:0}:{surface:'mixed',zones:scope.locations.map(l=>({id:l.ref,name:l.name,role:l.kind==='city'?'city':'other',size:'medium'})),features:[],links:[]}}});
const reply=req=>scopes(req).map(s=>JSON.stringify(layout(s))).join('\n');
const scene=(db,id)=>JSON.parse(queryBound(db,'SELECT frame_json FROM maps WHERE id=?',[id])[0].frame_json).atlasScene;
async function mapFixture(count,options={}){
 const seed=await makeSeedWith(SQL),ids=Array.from({length:count},(_,i)=>`batch-map-${String(i).padStart(2,'0')}`);
 for(const id of ids)insertRows(seed.db,'maps',[row('maps',id,{name:id,kind:'world',frame_json:{cols:100,rows:100}})]);
 options.seed?.(seed.db);const bytes=seed.exportBytes();seed.close();const calls=[];
 const repo=createSqlRepository({chatUid:IDS.chatA,branchId:IDS.branchMain,modelPort:{generationOptions:async()=>options.generation??{maxTokens:8192,batching:{charactersPerBatch:0,mapsPerBatch:0}},request:async req=>{
  calls.push(req);return {batchId:req.batchId,httpStatus:200,finishReason:'stop',...await options.respond?.(req,calls.length)??{text:req.batchId.includes('_evidence_')?'{"facts":[]}':reply(req)}};
 }}});await repo.open({bytes});return {repo,calls,ids};
}

test('batch settings default to unrestricted and accept user counts above the former maxima',()=>{
 const defaults=createDefaultSettingsV2();delete defaults.modelBatching;
 assert.deepEqual(sanitizeSettingsV2(defaults).settings.modelBatching,{charactersPerBatch:0,mapsPerBatch:0,requestsPerOperation:0});
 const saved=applySettingsCommand(defaults,{action:'runtime.update',modelBatching:{charactersPerBatch:200,mapsPerBatch:120,requestsPerOperation:50}});
 assert.equal(saved.ok,true);assert.deepEqual(settingsViewV2(sanitizeSettingsV2(saved.settings).settings).modelBatching,{charactersPerBatch:200,mapsPerBatch:120,requestsPerOperation:50});
 assert.equal(Object.hasOwn(settingsViewV2(saved.settings),'modelBatchingLimits'),false);
 const old=applySettingsCommand(saved.settings,{action:'runtime.update',modelBatching:{charactersPerBatch:0,mapsPerBatch:0}});assert.deepEqual(old.settings.modelBatching,{charactersPerBatch:0,mapsPerBatch:0,requestsPerOperation:50});
 for(const bad of [null,[],{charactersPerBatch:1},{charactersPerBatch:-1,mapsPerBatch:0},{charactersPerBatch:2,mapsPerBatch:Number.MAX_SAFE_INTEGER+1},{charactersPerBatch:1.5,mapsPerBatch:1},{charactersPerBatch:'2',mapsPerBatch:1},{charactersPerBatch:0,mapsPerBatch:0,requestsPerOperation:-1}]){
  const rejected=applySettingsCommand(saved.settings,{action:'runtime.update',modelBatching:bad});assert.equal(rejected.ok,false);assert.deepEqual(rejected.settings.modelBatching,saved.settings.modelBatching);
 }
});

test('batch editor saves through runtime settings, exports no key and retains drafts on a failed save',async()=>{
 let settings=createDefaultSettingsV2(),reject=false;
 let uid=0;const w={crypto:{randomUUID:()=> `batch-test-${++uid}`},TextEncoder},context=vm.createContext({window:w,TextEncoder,URL});
 vm.runInContext(readFileSync(new URL('../ui/atlas-reference/js/presets.js',import.meta.url),'utf8'),context);
 const store=w.AtlasPresetStore.create([],{storage:null,initialDocument:referencePresetDocument(settings),onPersist:async(doc,action)=>{
  if(reject)throw Error('save unavailable');for(const command of referenceSettingsCommands(doc,settings,action)){const result=applySettingsCommand(settings,command);assert.equal(result.ok,true);settings=result.settings;}
 }});
 Object.assign(store.batchDraft(),{charactersPerBatch:18,mapsPerBatch:4,requestsPerOperation:0});await store.saveBatching();
 assert.deepEqual(settings.modelBatching,{charactersPerBatch:18,mapsPerBatch:4,requestsPerOperation:0});assert.equal(store.batchingDirty(),false);
 const backup=JSON.parse(JSON.stringify(store.exportValue()));assert.deepEqual(backup.modelBatching,settings.modelBatching);assert.ok(!JSON.stringify(backup).includes('apiKey'));
 reject=true;store.batchDraft().mapsPerBatch=2;await assert.rejects(store.saveBatching(),/save unavailable/);
 assert.equal(store.document.modelBatching.mapsPerBatch,4);assert.equal(store.batchDraft().mapsPerBatch,2);assert.equal(store.batchingDirty(),true);
 reject=false;delete backup.modelBatching;await store.importValue(store.parseImport(backup));assert.deepEqual(settings.modelBatching,{charactersPerBatch:18,mapsPerBatch:4,requestsPerOperation:0},'old backup keeps current batch settings through the UI confirmation step');
 backup.modelBatching={charactersPerBatch:10,mapsPerBatch:2,requestsPerOperation:0};await store.importValue(store.parseImport(backup));assert.deepEqual(settings.modelBatching,backup.modelBatching);
 store.batchDraft().requestsPerOperation=7;await store.saveBatching();
 const oldBatchBackup=JSON.parse(JSON.stringify(store.exportValue()));delete oldBatchBackup.modelBatching.requestsPerOperation;
 await store.importValue(store.parseImport(oldBatchBackup));assert.equal(settings.modelBatching.requestsPerOperation,7,'an old backup cannot silently clear a saved request cap');
});

test('connection planning is read only and batching does not override actual API max_tokens',async()=>{
 const settings={...createDefaultSettingsV2(),modelBatching:{charactersPerBatch:20,mapsPerBatch:6,requestsPerOperation:0},activeApiPresetId:'api',apiPresets:[{id:'api',name:'test',endpoint:'https://example.test/v1',model:'mock',apiKey:'fixture-secret',maxTokens:12000,temperature:0.5,timeoutMs:30000,updatedAt:1}]};
 const bodies=[],port=createSqlModelPort({readSettings:async()=>settings,fetchFn:async(url,init)=>{bodies.push(JSON.parse(init.body));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"op":"noop"}'}}]}),{status:200});}});
 assert.deepEqual(await port.generationOptions(),{maxTokens:12000,batching:settings.modelBatching});assert.equal(bodies.length,0);
 const req=buildStagePrompt({phase:'decision',actorSlices:'[]'});req.anchor=input().anchor;req.batchTargets={kind:'characters',count:20,estimatedOutputTokens:5632};
 await port.request(req);assert.equal(bodies[0].max_tokens,12000);assert.equal(JSON.stringify(bodies[0]).includes('batchTargets'),false);
 settings.apiPresets[0].maxTokens=0;await port.request({...req,batchId:req.batchId+'_unrestricted'});assert.equal(Object.hasOwn(bodies[1],'max_tokens'),false,'zero leaves the provider output parameter unspecified');
 assert.equal(characterBatchLimit({maxTokens:8192}),30);assert.equal(characterBatchLimit({maxTokens:4096}),14);assert.equal(characterBatchLimit({maxTokens:1024}),2);assert.equal(characterBatchLimit({maxTokens:8192,batching:{charactersPerBatch:5,mapsPerBatch:0}}),5);
});

for(const count of [8,12])test(`${count} compatible maps share capacity-bounded layout batches and one evidence pass`,async()=>{
 const f=await mapFixture(count);try{
  const result=await f.repo.prepareTurn(input({layoutMaps:f.ids,sourceSnapshot:[{key:'s',kind:'story',hash:'synthetic',text:'这些地图属于同一个合成测试世界。'}]}));
  const layouts=f.calls.filter(req=>req.batchTargets?.kind==='maps');assert.deepEqual(layouts.map(req=>req.batchTargets.count),[count]);
  assert.equal(f.calls.filter(req=>req.batchId.includes('_evidence_')).length,1);assert.equal(f.calls.length,2);
  for(const id of f.ids)assert.ok(scene(f.repo.getCandidate(result.token).db,id),id);
  assert.equal(result.receipt.issues.some(i=>i.code==='LAYOUT_BATCH_PENDING'),false,JSON.stringify(result.receipt.issues));
 }finally{await f.repo.close();}
});

test('configured map cap splits requests while preserving the shared four-send allowance',async()=>{
 const f=await mapFixture(12,{generation:{maxTokens:8192,batching:{charactersPerBatch:0,mapsPerBatch:2,requestsPerOperation:4}}});try{
  const result=await f.repo.prepareTurn(input({layoutMaps:f.ids}));assert.deepEqual(f.calls.map(req=>req.batchTargets.count),[2,2,2,2]);
  assert.ok(result.receipt.issues.some(i=>i.code==='LAYOUT_BATCH_PENDING'));assert.equal(f.ids.filter(id=>scene(f.repo.getCandidate(result.token).db,id)).length,8);
 }finally{await f.repo.close();}
});

test('partial batch retries only missing maps and keeps the completed map geometry',async()=>{
 const f=await mapFixture(4,{respond:(req,n)=>({text:n===1?scopes(req).slice(0,3).map(s=>JSON.stringify(layout(s))).join('\n'):reply(req)})});try{
  const result=await f.repo.prepareTurn(input({layoutMaps:f.ids}));assert.deepEqual(f.calls.map(req=>req.batchTargets.count),[4,1]);
  assert.match(f.calls[1].messages[1].content,/未完成项补交/);assert.ok(result.receipt.issues.some(i=>i.code==='LAYOUT_MAP_REPLY_RETRIED'));
  const db=f.repo.getCandidate(result.token).db;for(const id of f.ids)assert.ok(scene(db,id));
  for(const id of f.ids.slice(0,3))assert.equal(f.calls.flatMap(scopes).filter(s=>s.name===id).length,1,'successful maps must not be requested again');
 }finally{await f.repo.close();}
});

test('truncated multi-map reply is discarded and split once within the same budget',async()=>{
 const f=await mapFixture(4,{respond:(req,n)=>({text:reply(req),finishReason:n===1?'length':'stop'})});try{
  const result=await f.repo.prepareTurn(input({layoutMaps:f.ids}));assert.deepEqual(f.calls.map(req=>req.batchTargets.count),[4,2,2]);
  assert.ok(result.receipt.issues.some(i=>i.code==='LAYOUT_BATCH_SPLIT'));assert.equal(result.receipt.issues.some(i=>i.code==='LAYOUT_BATCH_PENDING'),false);
  const db=f.repo.getCandidate(result.token).db;for(const id of f.ids)assert.ok(scene(db,id));
  const attempts=JSON.parse(queryBound(db,'SELECT attempts_json FROM turns WHERE id=?',[result.receipt.turnId])[0].attempts_json);assert.deepEqual(attempts.filter(a=>a.kind==='layout').map(a=>a.target_count),[4,2,2]);
 }finally{await f.repo.close();}
});

test('invalid entity references in one map do not discard the other maps in that batch',async()=>{
 const f=await mapFixture(2,{respond:(req,n)=>{const values=scopes(req).map(layout);if(n===1)values[1].data.spec.zones=[{id:'unregistered-zone',role:'other',size:'medium'}];return {text:values.map(JSON.stringify).join('\n')};}});try{
  const result=await f.repo.prepareTurn(input({layoutMaps:f.ids}));assert.deepEqual(f.calls.map(req=>req.batchTargets.count),[2,1]);for(const id of f.ids)assert.ok(scene(f.repo.getCandidate(result.token).db,id));
 }finally{await f.repo.close();}
});

test('parent layout materializes inherited geometry and avoids a redundant child model call',async()=>{
 const f=await mapFixture(0,{seed:db=>{
  insertRows(db,'maps',[row('maps','school-parent',{name:'学校父图',kind:'interior',container_location_id:IDS.L2,frame_json:{cols:100,rows:100}})]);
  db.run("UPDATE locations SET map_id=?,grid_x=NULL,grid_y=NULL,coord_precision='unknown' WHERE id=? AND branch_id=?",['school-parent',IDS.L3,IDS.branchMain]);db.run('UPDATE maps SET meters_per_cell=NULL,scale_min_meters_per_cell=NULL,scale_max_meters_per_cell=NULL,scale_quality=?,frame_json=? WHERE id=? AND branch_id=?',['uncalibrated',JSON.stringify({cols:100,rows:100}),IDS.M2,IDS.branchMain]);
 }});try{
  const first=buildSqlLayoutTask(f.repo.db,IDS.branchMain,input({layoutMaps:[IDS.M2,'school-parent']}),'order');assert.deepEqual(first.mapIds,['school-parent']);assert.deepEqual(first.remainingLocationIds,[IDS.M2]);
  const result=await f.repo.prepareTurn(input({layoutMaps:[IDS.M2,'school-parent']}));
  assert.equal(f.calls.length,1,'the locally inherited child does not need another model request');
  const db=f.repo.getCandidate(result.token).db,parent=scene(db,'school-parent'),child=scene(db,IDS.M2);assert.ok(parent&&child);
  const footprint=parent.layout.rooms.find(r=>r.id===IDS.L3);assert.equal(child.layout.bounds.w,footprint.w);assert.equal(child.layout.bounds.h,footprint.h);
  const childScope=scopes(buildSqlLayoutTask(db,IDS.branchMain,input({layoutMaps:[IDS.M2]}),'child-preview').request)[0];assert.equal(childScope.parentContext.name,'学校父图');assert.equal(childScope.parentContext.footprint.w,footprint.w);
 }finally{await f.repo.close();}
});

async function actorFixture(total,charactersPerBatch=0,configure,{maxTokens=8192,requestsPerOperation=0,respond}={}){
 const seed=await makeSeedWith(SQL);for(let i=4;i<total;i++){
  const id=`student-${String(i).padStart(4,'0')}`;insertRows(seed.db,'entity_keys',[{branch_id:IDS.branchMain,id,kind:'character'}]);insertRows(seed.db,'characters',[row('characters',id,{name:`学生${i}`,role:'npc',importance:'supporting',location_id:IDS.L3,status:'active',physical_status:'alive'})]);
 }
 configure?.(seed.db);
 const metadata={atlas:{database:await encodeSnapshot(seed.exportBytes(),{chatUid:IDS.chatA,worldUid:'batch-world',storageRevision:0,activeBranchId:IDS.branchMain})}};seed.close();const calls=[];
 const session=await openSqlSession({chatUid:IDS.chatA,branchId:IDS.branchMain,chatMetadata:metadata,saveSession:async()=>({result:'saved',confirmed:true}),modelPort:{generationOptions:async()=>({maxTokens,batching:{charactersPerBatch,mapsPerBatch:0,requestsPerOperation}}),request:async req=>{calls.push(req);const override=await respond?.(req,calls.length);return {batchId:req.batchId,httpStatus:200,finishReason:'stop',...override,text:override?.text??(req.phase==='observe'?JSON.stringify({op:'event.propose',data:{title:'休息结束',phase:'observed',activity:{kind:'rest',completed:true},time_hint:{elapsed_s:60}}}):'{"op":"noop"}')};}}});
 return {session,calls,turn:()=>runSqlTurn(session,input({manual:false,sceneOnly:false,phaseBatches:['observe'],assistantText:'休息了一分钟。'}))};
}
test('20 actors use one decision request at the configured connection capacity and are recorded in logs',async()=>{
 const f=await actorFixture(20);try{
  const result=await f.turn();assert.equal(result.coreSaved,true,JSON.stringify(result));const decisions=f.calls.filter(req=>req.phase==='decision');assert.equal(decisions.length,1);assert.equal(decisions[0].batchTargets.count,20);assert.equal(f.calls.length,2);
  const attempts=JSON.parse(queryBound(f.session.repo.db,'SELECT attempts_json FROM turns WHERE id=?',[result.receipt.turnId])[0].attempts_json);assert.equal(attempts.find(a=>a.kind==='decision').target_count,20);
 }finally{await f.session.repo.close();}
});
test('configured actor batches resume only pending actors and retain the same setting on continuation',async()=>{
 const f=await actorFixture(20,5,undefined,{requestsPerOperation:4});try{
  const result=await f.turn();assert.equal(result.coreSaved,true);assert.equal(result.receipt.status,'partial');assert.deepEqual(f.calls.filter(req=>req.phase==='decision').map(req=>req.batchTargets.count),[5,5,5]);
  const resumed=await runSqlModelRetry(f.session,{turnId:result.receipt.turnId});assert.equal(resumed.coreSaved,true);assert.equal(resumed.receipt.status,'committed');assert.deepEqual(f.calls.filter(req=>req.phase==='decision').map(req=>req.batchTargets.count),[5,5,5,5]);
  const actors=f.calls.filter(req=>req.phase==='decision').flatMap(req=>JSON.parse(req.messages[1].content.match(/待判断角色及各自认知：(.*)/)[1]).map(a=>a.entityId));assert.equal(new Set(actors).size,20);
  const attempts=JSON.parse(queryBound(f.session.repo.db,'SELECT attempts_json FROM turns WHERE id=?',[result.receipt.turnId])[0].attempts_json);assert.deepEqual(attempts.filter(a=>a.kind==='decision').map(a=>a.target_count),[5,5,5,5]);
 }finally{await f.session.repo.close();}
});

test('a node decision is not repeated for the same actor at the same time and unchanged semantic context',async()=>{
 const f=await actorFixture(4,0,db=>{
  db.run('UPDATE routes SET distance_m=100,distance_min_m=100,distance_max_m=100 WHERE branch_id=? AND id=?',[IDS.branchMain,IDS.R_AB]);
  insertRows(db,'routes',[row('routes','next-node',{from_location_id:IDS.L2,to_location_id:IDS.L3,distance_m:100,distance_min_m:100,distance_max_m:100,distance_basis:'narrative',kind:'road',allowed_modes_json:['walk']})]);
  insertRows(db,'actions',[row('actions','node-travel',{actor_entity_id:IDS.C2,kind:'travel',title:'经过学校',status:'ready',target_location_id:IDS.L3,payload_json:{destination_ref:IDS.L3,stop_policy:'stop'}})]);
 });try{
  const result=await f.turn();assert.equal(result.coreSaved,true,JSON.stringify(result));
  const decisions=f.calls.filter(req=>req.phase==='decision'),visits=decisions.flatMap(req=>JSON.parse(req.messages[1].content.match(/待判断角色及各自认知：(.*)/)[1]).map(a=>a.entityId));
  assert.deepEqual(decisions.map(req=>req.batchTargets.count),[1,3]);assert.equal(visits.filter(id=>id===IDS.C2).length,1);
 }finally{await f.session.repo.close();}
});

test('a failed parent defers its descendant without spending a child layout request',async()=>{
 const f=await mapFixture(0,{seed:db=>{
  insertRows(db,'maps',[row('maps','school-parent',{name:'父图',kind:'interior',container_location_id:IDS.L2,frame_json:{cols:100,rows:100}})]);
  // Retain an authored exact point which the requested parent template cannot move.
  db.run('UPDATE locations SET map_id=? WHERE id=? AND branch_id=?',['school-parent',IDS.L3,IDS.branchMain]);
 }});try{
  const result=await f.repo.prepareTurn(input({layoutMaps:[IDS.M2,'school-parent']}));assert.equal(f.calls.length,1);
  assert.ok(result.receipt.issues.some(i=>i.code==='LAYOUT_PARENT_PENDING'));assert.equal(scene(f.repo.getCandidate(result.token).db,IDS.M2),undefined);
 }finally{await f.repo.close();}
});

test('one rejected evidence map is deferred while valid maps in its batch still complete',async()=>{
 const f=await mapFixture(2,{respond:req=>({text:req.batchId.includes('_evidence_')?JSON.stringify({facts:[{mapRef:'M2',segmentRef:'S99999'}]}):reply(req)})});try{
  const result=await f.repo.prepareTurn(input({layoutMaps:f.ids,sourceSnapshot:[{key:'s',kind:'story',hash:'h',text:'合成世界地图的位置资料。'}]}));
  const layouts=f.calls.filter(req=>req.batchTargets?.kind==='maps');assert.equal(f.calls.length,3);assert.equal(layouts.length,1);assert.equal(layouts[0].batchTargets.count,1);
  const db=f.repo.getCandidate(result.token).db;assert.ok(scene(db,f.ids[0]));assert.equal(scene(db,f.ids[1]),undefined);assert.ok(result.receipt.issues.some(i=>i.code==='LAYOUT_BATCH_PENDING'));
 }finally{await f.repo.close();}
});

test('evidence rejection logs only the requests that were actually attempted',async()=>{
 const f=await mapFixture(1,{respond:()=>({text:JSON.stringify({facts:[{mapRef:'M1',segmentRef:'S99999'}]})})});try{
  const result=await f.repo.prepareTurn(input({layoutMaps:f.ids,sourceSnapshot:[{key:'s',kind:'story',hash:'h',text:'合成位置资料。'}]}));
  const attempts=JSON.parse(queryBound(f.repo.getCandidate(result.token).db,'SELECT attempts_json FROM turns WHERE id=?',[result.receipt.turnId])[0].attempts_json);
  assert.equal(f.calls.length,2);assert.equal(attempts.length,2);assert.deepEqual(attempts.map(a=>a.kind),['layout_evidence','layout_evidence_repair']);
 }finally{await f.repo.close();}
});

test('map batches also shrink to the configured connection output capacity',async()=>{
 const f=await mapFixture(8,{generation:{maxTokens:768,batching:{charactersPerBatch:0,mapsPerBatch:0}}});try{
  const result=await f.repo.prepareTurn(input({layoutMaps:f.ids}));assert.deepEqual(f.calls.map(req=>req.batchTargets.count),[2,2,2,2]);
  for(const id of f.ids)assert.ok(scene(f.repo.getCandidate(result.token).db,id));assert.equal(result.receipt.issues.some(i=>i.code==='LAYOUT_BATCH_PENDING'),false);
 }finally{await f.repo.close();}
});

test('a host change during settings retrieval aborts before a model call or candidate write',async()=>{
 const seed=await makeSeedWith(SQL),bytes=seed.exportBytes();seed.close();let current=true,calls=0;
 const repo=createSqlRepository({chatUid:IDS.chatA,branchId:IDS.branchMain,modelPort:{generationOptions:async()=>{current=false;return {maxTokens:8192,batching:{charactersPerBatch:0,mapsPerBatch:0}};},request:async()=>{calls++;throw Error('must not send');}}});
 try{await repo.open({bytes});const before=await repo.exportCurrent();await assert.rejects(repo.prepareTurn(input({layoutMaps:[IDS.M1],isCurrent:()=>current})),{code:'STALE_BASE'});assert.equal(calls,0);assert.deepEqual(await repo.exportCurrent(),before);}finally{await repo.close();}
});

test('zero batch and output limits do not invent a 4096-token or 24-person quota',async()=>{
 assert.equal(planningOutputTokens({maxTokens:0}),Infinity);assert.equal(characterBatchLimit({maxTokens:0}),Infinity);
 const f=await actorFixture(50,0,undefined,{maxTokens:0});try{
  const result=await f.turn();assert.equal(result.coreSaved,true);assert.equal(result.receipt.status,'committed');
  assert.deepEqual(f.calls.filter(req=>req.phase==='decision').map(req=>req.batchTargets.count),[50]);
 }finally{await f.session.repo.close();}
});

test('a configured large output allowance expands batches beyond 24 actors',async()=>{
 const f=await actorFixture(50,0,undefined,{maxTokens:16384});try{
  const result=await f.turn();assert.equal(result.coreSaved,true);assert.deepEqual(f.calls.filter(req=>req.phase==='decision').map(req=>req.batchTargets.count),[50]);
 }finally{await f.session.repo.close();}
});

test('default request count permits all configured actor batches beyond the former four calls',async()=>{
 const f=await actorFixture(20,3);try{
  const result=await f.turn();assert.equal(result.coreSaved,true);assert.equal(result.receipt.status,'committed');assert.equal(f.calls.length,8);
  assert.deepEqual(f.calls.filter(req=>req.phase==='decision').map(req=>req.batchTargets.count),[3,3,3,3,3,3,2]);
 }finally{await f.session.repo.close();}
});

test('default request count completes all map batches beyond the former four calls',async()=>{
 const f=await mapFixture(12,{generation:{maxTokens:0,batching:{charactersPerBatch:0,mapsPerBatch:2}}});try{
  const result=await f.repo.prepareTurn(input({layoutMaps:f.ids}));assert.deepEqual(f.calls.map(req=>req.batchTargets.count),[2,2,2,2,2,2]);
  assert.equal(result.receipt.issues.some(i=>i.code==='LAYOUT_BATCH_PENDING'),false);for(const id of f.ids)assert.ok(scene(f.repo.getCandidate(result.token).db,id));
 }finally{await f.repo.close();}
});

test('user map limits above eight persist and are used by actual requests',async()=>{
 const f=await mapFixture(20,{generation:{maxTokens:0,batching:{charactersPerBatch:0,mapsPerBatch:20}}});try{
  const result=await f.repo.prepareTurn(input({layoutMaps:f.ids}));assert.deepEqual(f.calls.map(req=>req.batchTargets.count),[20]);for(const id of f.ids)assert.ok(scene(f.repo.getCandidate(result.token).db,id));
 }finally{await f.repo.close();}
});

test('truncated character replies are discarded and only then split once',async()=>{
 const f=await actorFixture(50,0,undefined,{maxTokens:0,respond:(req,n)=>req.phase==='decision'?{finishReason:n===2?'length':'stop',text:n===2?JSON.stringify({op:'character.upsert',ref:'C2',data:{thought:'被截断的回复不得写入'}}):'{"op":"noop"}'}:undefined});try{
  const result=await f.turn();assert.equal(result.coreSaved,true);assert.equal(result.receipt.status,'committed');
  assert.deepEqual(f.calls.filter(req=>req.phase==='decision').map(req=>req.batchTargets.count),[50,25,25]);assert.ok(result.receipt.issues.some(i=>i.code==='CHARACTER_BATCH_SPLIT'));
  assert.equal(queryBound(f.session.repo.db,'SELECT thought FROM characters WHERE branch_id=? AND id=?',[IDS.branchMain,IDS.C2])[0].thought,'');
 }finally{await f.session.repo.close();}
});

test('context overflow shrinks a map batch while keeping transport retries bounded',async()=>{
 const f=await mapFixture(12,{generation:{maxTokens:0,batching:{charactersPerBatch:0,mapsPerBatch:0}},respond:(req,n)=>{if(n===1)throw Error('context_length_exceeded');return {text:reply(req)};}});try{
  const result=await f.repo.prepareTurn(input({layoutMaps:f.ids}));assert.deepEqual(f.calls.map(req=>req.batchTargets.count),[12,6,6]);assert.ok(result.receipt.issues.some(i=>i.code==='LAYOUT_BATCH_SPLIT'));for(const id of f.ids)assert.ok(scene(f.repo.getCandidate(result.token).db,id));
 }finally{await f.repo.close();}
});

test('unlimited request count cannot cause an endless retry of a permanently failing actor batch',async()=>{
 const f=await actorFixture(50,0,undefined,{maxTokens:0,respond:req=>{if(req.phase==='decision')throw Error('context_length_exceeded');}});try{
  const result=await f.turn();assert.equal(result.coreSaved,true);assert.equal(result.receipt.status,'partial');assert.deepEqual(f.calls.filter(req=>req.phase==='decision').map(req=>req.batchTargets.count),[50,25]);
  assert.ok(result.receipt.issues.some(i=>i.code==='MODEL_REQUEST_FAILED'));
 }finally{await f.session.repo.close();}
});

test('a large unrestricted actor batch includes references beyond the old 200-row catalogue prefix',async()=>{
 const f=await actorFixture(250,0,undefined,{maxTokens:0,respond:req=>{
  if(req.phase!=='decision')return;
  const actors=JSON.parse(req.messages[1].content.match(/待判断角色及各自认知：(.*)/)[1]);return {text:JSON.stringify({op:'character.upsert',ref:actors.at(-1).entityId,data:{thought:'末尾人物已决策'}})};
 }});try{
  const result=await f.turn();assert.equal(result.coreSaved,true,JSON.stringify(result));assert.equal(result.receipt.status,'committed');assert.deepEqual(f.calls.filter(req=>req.phase==='decision').map(req=>req.batchTargets.count),[250]);
  assert.equal(queryBound(f.session.repo.db,'SELECT thought FROM characters WHERE branch_id=? AND id=?',[IDS.branchMain,'student-0249'])[0].thought,'末尾人物已决策');
 }finally{await f.session.repo.close();}
});

test('unrestricted actors split at actual reference protocol capacity without exhausting a retry',async()=>{
 const f=await actorFixture(600,0,undefined,{maxTokens:0});try{
  const result=await f.turn();assert.equal(result.coreSaved,true);assert.equal(result.receipt.status,'committed');
  assert.deepEqual(f.calls.filter(req=>req.phase==='decision').map(req=>req.batchTargets.count),[512,88]);
  assert.equal(result.receipt.issues.some(i=>i.code==='CHARACTER_BATCH_SPLIT'),false);
 }finally{await f.session.repo.close();}
});
