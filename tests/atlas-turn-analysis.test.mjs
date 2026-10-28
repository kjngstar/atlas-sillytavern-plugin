import test from 'node:test';
import assert from 'node:assert/strict';
import initSql from 'sql.js';
import {createGenerationBudget} from '../src/atlas-sql-generation-budget.ts';
import {createSqlModelPort} from '../src/atlas-sql-model-port.ts';
import {createDefaultSettingsV2} from '../src/atlas-settings.ts';
import {buildStagePrompt} from '../src/atlas-ops-prompts.ts';
import {atlasDiagnosticContext} from '../src/atlas-request-diagnostics.ts';
import {atlasRefFingerprint,sanitizeDiagnostic,createAtlasDiagnosticsSink} from '../src/atlas-diagnostics.ts';
import {sanitizeModelCallAudit} from '../src/atlas-model-call-audit.ts';
import {queryTurnAnalysis} from '../src/atlas-turn-analysis-view.ts';
import {buildTurnAnalysisExport} from '../ui/atlas-turn-analysis-export.mjs';
import {queryBound,runBound} from '../src/atlas-db-runtime.ts';
import {makeSeedWith,IDS} from './fixtures/atlas-sql/seed.mjs';

const anchor={chatUid:'private-chat',branchId:'private-branch',hostMessageUid:'private-floor',variantKey:'original',baseRevision:0,baseStorageRevision:0};
const response=()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"op":"noop"}'}}]}));
const settings=()=>({...createDefaultSettingsV2(),activeApiPresetId:'fixture',apiPresets:[{id:'fixture',name:'fixture',endpoint:'https://example.invalid/v1',apiKey:'private-key',model:'fixture-model',temperature:0.4,timeoutMs:30000,maxTokens:9000,updatedAt:1}]});
function request(batchId='fixture') { const req=buildStagePrompt({phase:'geography',batchId});return {...req,anchor,workClass:'maps',diagnosticTargets:['private-map'],batchTargets:{kind:'maps',count:1,estimatedOutputTokens:0}}; }

test('real model port journals successful sends, exact repair origin and safe map references',async()=>{
  const budget=createGenerationBudget({diagnosticAnchor:anchor}),events=[],bodies=[];
  const port=createSqlModelPort({readSettings:async()=>settings(),budget,onDiagnostic:event=>events.push(sanitizeDiagnostic(event)),fetchFn:async(_url,init)=>{bodies.push(init.body);return response();}});
  await port.request(request('first'));
  await port.request({...request('repair'),retryOf:'first',diagnosticCause:'format_repair'});
  const audit=budget.audit();
  assert.equal(audit.transports,2);assert.deepEqual(audit.byWorkClass,{maps:2});assert.equal(audit.calls[1].reason,'format_repair');
  assert.equal(audit.calls[1].retryOfBatchRef,atlasRefFingerprint('first'));assert.deepEqual(audit.calls[0].targetRefs,[atlasRefFingerprint('private-map')]);
  assert.equal(audit.calls[0].status,'completed');assert.equal(audit.calls[0].httpStatus,200);assert.equal(audit.calls[0].finishReason,'stop');
  assert.equal(audit.calls[0].requestRef,events.find(e=>e.code==='MODEL_REQUEST_STARTED').requestRef);
  for(const text of ['private-chat','private-branch','private-floor','private-map','private-key','example.invalid','{"op":"noop"}'])assert.equal(JSON.stringify(audit).includes(text),false,text);
  for(const text of ['diagnosticCause','diagnosticTargets','retryOfBatchRef'])assert.equal(bodies.some(body=>body.includes(text)),false,'provenance never leaks into provider parameters');
});

test('compatibility resend produces two durable transport rows, not one logical attempt',async()=>{
  const config=settings();Object.assign(config.apiPresets[0],{endpoint:'https://api.minimaxi.com/v1',apiKey:'sk-cp-private-fixture'});
  const budget=createGenerationBudget({diagnosticAnchor:anchor});let sends=0;
  const port=createSqlModelPort({budget,readSettings:async()=>config,fetchFn:async()=>++sends===1?new Response(JSON.stringify({error:{message:'Not Found'}})):response()});
  await port.request(request());const audit=budget.audit();
  assert.equal(audit.transports,sends);assert.equal(sends,2);assert.deepEqual(audit.calls.map(c=>c.transportAttempt),[1,2]);
  assert.deepEqual(audit.calls.map(c=>c.status),['compatibility_retry','completed']);assert.equal(audit.calls[0].requestRef,audit.calls[1].requestRef);
});

test('preparation, duplicate and denied-budget failures never invent a model send',async()=>{
  const budget=createGenerationBudget({limit:1});let sends=0;
  const port=createSqlModelPort({budget,readSettings:async()=>settings(),fetchFn:async()=>{sends++;return response();}});
  await port.request(request('first'));
  await assert.rejects(port.request(request('first')),{code:'MODEL_BATCH_DUPLICATE'});
  await assert.rejects(port.request(request('second')),{code:'MODEL_BUDGET_EXHAUSTED'});
  const empty=createGenerationBudget();await assert.rejects(createSqlModelPort({budget:empty,readSettings:async()=>createDefaultSettingsV2()}).request(request()),{code:'API_NOT_CONFIGURED'});
  assert.equal(empty.audit().transports,0);assert.equal(budget.audit().transports,1);assert.equal(sends,1);
});

test('bounded call detail retains the true total; continuation preserves the earlier journal',()=>{
  const budget=createGenerationBudget();for(let i=0;i<260;i++){budget.claimBatch('geography',String(i),{kind:'maps'});budget.claimTransport('geography',String(i));budget.finishBatch(String(i),'completed');}
  const audit=budget.audit();assert.equal(audit.transports,260);assert.equal(audit.calls.length,256);assert.equal(audit.droppedCalls,4);assert.equal(audit.byWorkClass.maps,260);
  const resumed=createGenerationBudget({requestAudit:audit});resumed.claimBatch('decision','resume',{kind:'characters'});resumed.claimTransport('decision','resume');
  assert.equal(resumed.audit().transports,261);assert.equal(resumed.audit().calls.at(-1).sequence,261);assert.equal(resumed.audit().droppedCalls,5);
  const dirty=structuredClone(audit);dirty.apiKey='do-not-export';dirty.calls[0].response='do-not-export';dirty.calls[0].targetRefs=['not-a-ref'];
  assert.equal(JSON.stringify(sanitizeModelCallAudit(dirty)).includes('do-not-export'),false);
});

const SQL=await initSql();
function insertTurn(db,id,{status='committed',receipt={},attempts=[],time=1700000000100,branch=IDS.branchMain,message=id}={}){
  const template=queryBound(db,'SELECT * FROM turns WHERE id=?',[IDS.seedTurn])[0];
  const row={...template,id,branch_id:branch,host_message_uid:message,host_variant_key:'original',kind:'narrative',status:status==='noop'?'committed':status,created_wall_ms:time,
    receipt_json:JSON.stringify({status,...receipt}),attempts_json:JSON.stringify(attempts)};
  const columns=Object.keys(row);runBound(db,`INSERT INTO turns (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`,columns.map(key=>row[key]));
}
test('every stored status is exported with stable branch-scoped pagination, without raw content',async()=>{
  const seed=await makeSeedWith(SQL);try{
    const audit=createGenerationBudget();audit.claimBatch('geography','one',{kind:'maps'});audit.claimTransport('geography','one');
    for(const status of ['committed','failed','noop','rolled_back'])insertTurn(seed.db,'private-'+status,{status,receipt:{status:status==='rolled_back'?'committed':status,requestAudit:audit.audit(),issues:[{code:'DETAIL_NO_SPACE',path:'$.maps.secretmap.frame_json',message:'private story sk-live-secret'}]},attempts:[{kind:'layout',error:'private story',response:'private output'}]});
    insertTurn(seed.db,'other-branch',{branch:IDS.branchB});
    const ctx={db:seed.db,branchId:IDS.branchMain,chatId:IDS.chatA,viewMode:'author',revision:0},before=seed.db.export();
    const all=[];let cursor;do{const page=queryTurnAnalysis(ctx,{kind:'turn-analysis',branchId:IDS.branchMain,limit:1,cursor});all.push(...page.items);cursor=page.nextCursor;}while(cursor);
    assert.equal(all.length,5);assert.equal(new Set(all.map(t=>t.id)).size,5);assert.ok(all.some(t=>t.status==='rolled_back'));assert.ok(all.some(t=>t.status==='noop'));assert.ok(all.some(t=>t.status==='failed'));
    assert.equal(all[0].recordedModelTransports,1);assert.equal(all[0].attempts.length,1);
    for(const text of ['private-map','secretmap','private story','private output','private-committed','other-branch'])assert.equal(JSON.stringify(all).includes(text),false,text);
    assert.deepEqual(seed.db.export(),before,'export query is read-only');
    assert.throws(()=>queryTurnAnalysis({...ctx,viewMode:'pov'},{kind:'turn-analysis',branchId:IDS.branchMain}),{code:'VIEW_AUTHOR_REQUIRED'});
    const page=queryTurnAnalysis(ctx,{kind:'turn-analysis',branchId:IDS.branchMain,limit:1});
    assert.throws(()=>queryTurnAnalysis({...ctx,revision:1},{kind:'turn-analysis',branchId:IDS.branchMain,cursor:page.nextCursor}),{code:'VIEW_CURSOR_STALE'});
    assert.throws(()=>queryTurnAnalysis(ctx,{kind:'turn-analysis',branchId:IDS.branchMain,cursor:'ta1:broken'}),{code:'VIEW_CURSOR_INVALID'});
  }finally{seed.db.close();}
});
test('old attempt records are not passed off as exact API counts',async()=>{
  const seed=await makeSeedWith(SQL);try{
    insertTurn(seed.db,'legacy',{attempts:[{kind:'layout'},{kind:'layout_evidence'}]});
    const page=queryTurnAnalysis({db:seed.db,chatId:IDS.chatA,branchId:IDS.branchMain,revision:0,viewMode:'author'},{kind:'turn-analysis',branchId:IDS.branchMain});
    assert.equal(page.items[0].recordedModelTransports,null);assert.equal(page.items[0].countSource,'unknown');assert.equal(page.items[0].attempts.length,2);
  }finally{seed.db.close();}
});

const identity=atlasDiagnosticContext(anchor),scope={chatFingerprint:identity.chatFingerprint,branchRef:identity.details.branchRef};
const event=(code,attempt=1,overrides={})=>sanitizeDiagnostic({...identity,requestRef:atlasRefFingerprint('request'),level:'info',source:'model',code,operation:'generation',phase:'request',outcome:'started',...overrides,details:{...identity.details,transportAttempt:attempt,workClass:'maps',callReason:'scheduled',...overrides.details}});
test('export joins durable and runtime rows once; headers and local API polls are not model calls',()=>{
  const requestRef=atlasRefFingerprint('request'),turnRef=identity.details.turnRef;
  const turns=[{turnRef,recordedModelTransports:1,requestAudit:{calls:[{requestRef,transportAttempt:1,reason:'scheduled'}],droppedCalls:0},attempts:[{}]}];
  const diagnostics=[event('MODEL_REQUEST_STARTED'),event('MODEL_RESPONSE_HEADERS'),event('MODEL_REQUEST_COMPLETED'),event('API_CALL_COMPLETE'),event('MODEL_REQUEST_STARTED',1,{chatFingerprint:atlasRefFingerprint('different-chat')})];
  const file=buildTurnAnalysisExport({turns,diagnostics,scope});const round=file.rounds[0];
  assert.equal(round.calls.length,1);assert.equal(round.counts.combinedModelTransports,1);assert.equal(round.counts.observedRuntimeStarts,1);assert.equal(round.counts.localApiEvents,1);
  assert.equal(file.coverage.excludedOtherOrUnscopedEvents,1);
});
test('legacy and evicted journals cannot double-count overlapping runtime starts',()=>{
  for(const requestAudit of [null,{calls:[],droppedCalls:4}]){
    const file=buildTurnAnalysisExport({turns:[{turnRef:identity.details.turnRef,recordedModelTransports:4,requestAudit}],diagnostics:[event('MODEL_REQUEST_STARTED')],scope});
    assert.equal(file.rounds[0].counts.combinedModelTransports,null);assert.equal(file.rounds[0].counts.observedLowerBound,4);
  }
});
test('runtime-only failed turns retain two compatibility starts and remain explicitly incomplete',()=>{
  const file=buildTurnAnalysisExport({diagnostics:[event('MODEL_REQUEST_STARTED'),event('MODEL_REQUEST_STARTED',2,{details:{retryKind:'compatibility'}}),event('MODEL_REQUEST_FAILED',2,{errorCode:'API_TIMEOUT'})],scope});
  const round=file.rounds[0];assert.equal(round.calls.length,2);assert.equal(round.counts.observedRuntimeStarts,2);assert.equal(round.counts.combinedModelTransports,null);assert.equal(round.counts.countComplete,false);
  assert.ok(round.findings.some(f=>f.code==='TRANSPORT_RETRY_OBSERVED'));
});

test('session export retains normal sends and failed-turn context after refresh, independently of the UI ring',()=>{
  const data=new Map(),persist={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};
  const sink=createAtlasDiagnosticsSink({persist,capacity:100});
  sink.emit(event('MODEL_REQUEST_STARTED'));sink.emit(event('MODEL_REQUEST_COMPLETED'));
  for(let i=0;i<110;i++)sink.emit({level:'info',source:'ui',code:'UI_READ',operation:'query',phase:'request',outcome:'success'});
  assert.equal(sink.getSnapshot().some(row=>row.code==='MODEL_REQUEST_STARTED'),false);
  assert.equal(sink.getExportSnapshot().events.filter(row=>row.code==='MODEL_REQUEST_STARTED').length,1);
  const restored=createAtlasDiagnosticsSink({persist});
  assert.equal(restored.getExportSnapshot().events.filter(row=>row.code==='MODEL_REQUEST_STARTED').length,1);
  assert.equal(restored.getExportSnapshot().coverage.sessionPersistenceAvailable,true);
  restored.clear();assert.equal(restored.getExportSnapshot().events.length,0);assert.equal(data.size,0);
});
test('session journal eviction is explicit; a storage failure cannot retry a model request',()=>{
  const sink=createAtlasDiagnosticsSink({persist:{getItem:()=>null,setItem:()=>{throw Error('quota');},removeItem(){}}});
  for(let i=0;i<1003;i++)sink.emit({...event('MODEL_REQUEST_STARTED'),id:`audit-${i}`});
  const exported=sink.getExportSnapshot();assert.equal(exported.coverage.retainedCallEvents,1000);assert.equal(exported.coverage.droppedCallEvents,3);
  assert.equal(exported.coverage.sessionPersistenceAvailable,false);
});
