import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import {makeSeedWith,insertRows,IDS} from './fixtures/atlas-sql/seed.mjs';
import {createRow} from '../src/atlas-db-defaults.ts';
import {encodeSnapshot} from '../src/atlas-db-envelope.ts';
import {queryBound} from '../src/atlas-db-runtime.ts';
import {openSqlSession,runSqlTurn,runSqlRollback} from '../src/atlas-sql-session.ts';
import {BUSINESS_TABLES} from '../src/atlas-db-contract.ts';
import {runSqlModelRetry} from '../src/atlas-sql-retry.ts';
import {querySqlCharacterTimeline} from '../src/atlas-sql-timeline.ts';

const SQL=await initSqlJs();
const event=(kind,hint,completed=true)=>JSON.stringify({op:'event.propose',data:{title:'正文行为',phase:'observed',activity:{kind,completed},...(hint?{time_hint:hint}:{})}});
async function fixture({response='{"op":"noop"}',seed,background}={}) {
  const {db}=await makeSeedWith(SQL); seed?.(db);
  const metadata={atlas:{database:await encodeSnapshot(db.export(),{chatUid:IDS.chatA,worldUid:'world-A',storageRevision:0,activeBranchId:IDS.branchMain})}};
  db.close(); let saved=true; const calls=[];
  const session=await openSqlSession({chatUid:IDS.chatA,branchId:IDS.branchMain,chatMetadata:metadata,saveSession:async()=>{if(!saved)throw new Error('host save failed');return {result:'saved',confirmed:true};},
    modelPort:{request:async req=>{
      calls.push(req); return {batchId:req.batchId,text:req.phase==='observe'?response:await background?.(req)??'{"op":"noop"}',httpStatus:200,durationMs:1};
    }}});
  const input=()=>({anchor:{chatUid:session.chatUid,branchId:session.branchId,parentTurnId:session.repo.internal.currentHeadTurnId(),hostMessageUid:'floor-time',variantKey:'v0',inputHash:'time',baseRevision:session.repo.internal.currentRevision(),baseStorageRevision:session.repo.storageRevision},
    userText:'继续',assistantText:'行为已经发生',sourceSnapshot:[],phaseBatches:['observe'],manual:false});
  return {session,metadata,calls,setSave:v=>saved=v,turn:()=>runSqlTurn(session,input()),
    undo:turnId=>runSqlRollback(session,{chatUid:session.chatUid,branchId:session.branchId,targetParentTurnId:turnId,expectedRevision:session.repo.internal.currentRevision()}),
    rows:(table)=>queryBound(session.repo.db,`SELECT * FROM ${table} WHERE branch_id=? ORDER BY id`,[session.branchId])};
}
const add=(db,table,data)=>{
  const kind={locations:'location',characters:'character',items:'item',factions:'faction'}[table];
  if(kind)insertRows(db,'entity_keys',[{branch_id:IDS.branchMain,id:data.id,kind}]);
  insertRows(db,table,[createRow(table,data,{branchId:IDS.branchMain,id:data.id,turnId:IDS.seedTurn,clockS:0,nowWallMs:0,rulesetVersion:'atlas-1'})]);
};
const action=(db,overrides={})=>add(db,'actions',{id:'work',actor_entity_id:IDS.C2,kind:'prepare',title:'整理货物',status:'active',started_at_s:0,evaluated_until_s:0,
  duration_json:{min_s:30,nominal_s:30,max_s:30,quality:'explicit',basis_refs:[]},...overrides});

test('SQL repair preserves the original aliases when successful inserts renumber the live catalogue',async()=>{
  let repairs=0;
  const f=await fixture({seed:db=>add(db,'locations',{id:'z-office',name:'原办公室',kind:'room'}),
    response:'{"op":"location.upsert","ref":"new:hall","data":{"name":"新增大厅","kind":"building"}}\n{"op":"location.upsert","ref":"L4","data":{"name":"原办公室更新","kind":"bad-kind"}}',
    background:req=>req.phase==='repair'?(++repairs===1?'{"ticket":"R1","op":"noop","why":"待补交"}':'{"ticket":"R1","op":"location.upsert","ref":"L4","data":{"name":"原办公室更新","kind":"room"}}'):'{"op":"noop"}'});
  try {
    const result=await f.turn();assert.equal(result.coreSaved,true);assert.equal(result.receipt.status,'partial');
    assert.equal(f.rows('locations').length,5);
    const repaired=await runSqlModelRetry(f.session,{turnId:result.receipt.turnId});assert.equal(repaired.coreSaved,true,JSON.stringify(repaired));
    assert.equal(f.rows('locations').find(r=>r.id==='z-office').name,'原办公室更新');
    assert.equal(f.rows('locations').filter(r=>r.name==='新增大厅').length,1);
    await f.undo(result.receipt.turnId);assert.equal(f.rows('locations').find(r=>r.id==='z-office').name,'原办公室');
    assert.equal(f.rows('locations').length,4);
  }finally{await f.session.repo.close();}
});

test('SQL background retry resumes its causal boundary without advancing time or changing head; save failure and undo remain atomic',async()=>{
  let available=false;
  const f=await fixture({response:event('rest',{elapsed_s:60}),seed:db=>action(db),background:req=>{
    if(req.phase==='outcome') {if(!available)throw Error('暂时不可用');return '{"op":"event.propose","data":{"title":"完成整理","phase":"simulated","action_ref":"A1","effects":[{"type":"action_result","action_ref":"A1","value":"completed"}]}}';}
    return '{"op":"noop"}';
  }});
  try{
    const before=Object.fromEntries(BUSINESS_TABLES.map(t=>[t,f.rows(t)]));
    const result=await f.turn();const revision=f.session.repo.internal.currentRevision(),head=f.session.repo.internal.currentHeadTurnId();
    available=true;f.setSave(false);const failed=await runSqlModelRetry(f.session,{turnId:head});assert.equal(failed.coreSaved,false);
    assert.equal(f.rows('actions')[0].status,'active');assert.equal(f.rows('events').filter(e=>e.title==='完成整理').length,0);
    f.setSave(true);const resumed=await runSqlModelRetry(f.session,{turnId:head});assert.equal(resumed.coreSaved,true,JSON.stringify(resumed));
    assert.equal(resumed.receipt.status,'committed');assert.equal(resumed.receipt.clockAfterS,60);
    assert.equal(resumed.receipt.simulatedUntilS,60);assert.equal(f.session.repo.internal.currentRevision(),revision);
    assert.equal(f.session.repo.internal.currentHeadTurnId(),head);assert.equal(f.rows('actions')[0].status,'completed');
    const calls=f.calls.length;await runSqlModelRetry(f.session,{turnId:head});assert.equal(f.calls.length,calls);
    await f.undo(result.receipt.turnId);for(const t of BUSINESS_TABLES)assert.deepEqual(f.rows(t),before[t],t);
  }finally{await f.session.repo.close();}
});

test('SQL background batches cover 50 actors and resume only pending actors under a shared model budget',async()=>{
  const visits=[];
  const f=await fixture({response:event('rest',{elapsed_s:60}),seed:db=>{
    for(let i=0;i<50;i++)add(db,'characters',{id:`student-${String(i).padStart(2,'0')}`,name:`学生${i}`,location_id:IDS.L3,status:'active',physical_status:'alive',role:'npc'});
  },background:req=>{
    if(req.phase==='decision') {const actors=JSON.parse(req.messages[1].content.match(/待判断角色及各自认知：(.*)/)[1]);visits.push(...actors.map(a=>a.entityId));}
    return '{"op":"noop"}';
  }});
  try{
    const result=await f.turn();assert.equal(result.coreSaved,true);assert.equal(result.receipt.status,'partial');assert.ok(f.calls.length<=4);
    const partialCount=visits.length;assert.ok(partialCount>0&&partialCount<50);
    const resumed=await runSqlModelRetry(f.session,{turnId:result.receipt.turnId});assert.equal(resumed.coreSaved,true,JSON.stringify(resumed));
    assert.equal(resumed.receipt.status,'committed');assert.equal(resumed.receipt.clockAfterS,60);
    assert.equal(new Set(visits).size,visits.length,'already judged actors must not be rerun');assert.ok(visits.length>=50);
    assert.equal(queryBound(f.session.repo.db,'SELECT simulation_status FROM branches WHERE id=?',[f.session.branchId])[0].simulation_status,'current');
    await f.undo(result.receipt.turnId);assert.equal(f.session.repo.internal.currentClock(),0);
  }finally{await f.session.repo.close();}
});

test('Q05 formal SQL: short dialogue and unfinished travel do not advance time or execute background work',async()=>{
  for(const response of ['{"op":"noop"}',event('travel',{elapsed_s:3600},false)]) {
    const f=await fixture({response,seed:db=>action(db)});
    try {
      const result=await f.turn(); assert.equal(result.coreSaved,true); assert.equal(result.receipt.clockAfterS,0);
      assert.equal(f.rows('actions')[0].progress_s,0); assert.equal(f.calls.length,1);
    } finally {await f.session.repo.close();}
  }
});

test('Q05 formal SQL: completed rest advances branch and turn clock, saves interval evidence, rolls back the same floor',async()=>{
  const f=await fixture({response:event('rest',{elapsed_s:120})});
  try {
    const result=await f.turn(); assert.equal(result.coreSaved,true); assert.equal(result.receipt.clockAfterS,120);
    assert.equal(result.receipt.timeChanged,true); assert.equal(f.session.repo.internal.currentClock(),120);
    const row=queryBound(f.session.repo.db,'SELECT clock_after_s,elapsed_json FROM turns WHERE id=?',[result.receipt.turnId])[0];
    assert.equal(row.clock_after_s,120); assert.equal(JSON.parse(row.elapsed_json).quality,'explicit');
    const undone=await f.undo(result.receipt.turnId); assert.equal(undone.coreSaved,true); assert.equal(f.session.repo.internal.currentClock(),0);
    assert.equal(f.rows('events').length,0);
  } finally {await f.session.repo.close();}
});

test('Q05 formal SQL: unknown completed travel stays unknown, not a successful zero-duration turn',async()=>{
  const f=await fixture({response:event('travel')});
  try {
    const result=await f.turn(); assert.equal(result.coreSaved,true); assert.equal(result.receipt.status,'partial');
    assert.ok(result.receipt.issues.some(i=>i.code==='TIME_UNRESOLVED')); assert.equal(f.session.repo.internal.currentClock(),0);
    assert.equal(queryBound(f.session.repo.db,'SELECT simulation_status FROM branches WHERE id=?',[f.session.branchId])[0].simulation_status,'blocked');
  } finally {await f.session.repo.close();}
});

test('SQL completed travel computes interval from a real route and actual mobility, not an intent',async()=>{
  const response=JSON.stringify({op:'event.propose',data:{title:'已经走到学校',phase:'observed',subject_ref:'C2',route_ref:'R1',activity:{kind:'travel',completed:true,mode:'walk'}}});
  const f=await fixture({response});
  try{
    const result=await f.turn();assert.equal(result.coreSaved,true,JSON.stringify(result));assert.equal(result.receipt.clockAfterS,7200,JSON.stringify({receipt:result.receipt,events:f.rows('events')}));
    const elapsed=JSON.parse(queryBound(f.session.repo.db,'SELECT elapsed_json FROM turns WHERE id=?',[result.receipt.turnId])[0].elapsed_json);
    assert.equal(elapsed.quality,'estimated');assert.equal(elapsed.minS,7200);assert.equal(elapsed.maxS,7200);
    await f.undo(result.receipt.turnId);assert.equal(f.session.repo.internal.currentClock(),0);
  }finally{await f.session.repo.close();}
});

test('SQL due scheduled event is resolved in place; rollback restores its scheduled state',async()=>{
  const f=await fixture({response:event('rest',{elapsed_s:60}),seed:db=>add(db,'events',{id:'scheduled-bell',title:'课铃',status:'scheduled',scheduled_start_s:30}),
    background:req=>{
      if(req.phase!=='outcome')return '{"op":"noop"}';
      const ref=req.messages[1].content.match(/(E\d+)=课铃/)[1];
      return JSON.stringify({op:'event.propose',data:{title:'课铃',phase:'simulated',event_ref:ref}});
    }});
  try{
    const result=await f.turn();assert.equal(result.coreSaved,true,JSON.stringify(result));
    assert.equal(f.rows('events').filter(r=>r.title==='课铃').length,1);assert.equal(f.rows('events').find(r=>r.id==='scheduled-bell').status,'occurred');
    await f.undo(result.receipt.turnId);assert.equal(f.rows('events').find(r=>r.id==='scheduled-bell').status,'scheduled');
  }finally{await f.session.repo.close();}
});

test('SQL background decision rejects location teleport and editing another actor, while retaining the original entity',async()=>{
  const f=await fixture({response:event('rest',{elapsed_s:60}),background:req=>req.phase==='decision'?'{"op":"character.upsert","ref":"C1","data":{"location_ref":"L1"}}':'{"op":"noop"}'});
  try{
    const before=f.rows('characters').find(r=>r.id===IDS.C1);const result=await f.turn();assert.equal(result.coreSaved,true);
    assert.equal(f.rows('characters').find(r=>r.id===IDS.C1).location_id,before.location_id);
    assert.ok(result.receipt.issues.some(i=>i.code==='ACTOR_SCOPE_VIOLATION'));
  }finally{await f.session.repo.close();}
});

test('Q05 formal SQL: actual outcome operations change the candidate, all background rows revert with the narrative floor',async()=>{
  const f=await fixture({response:event('rest',{elapsed_s:60}),seed:db=>action(db),background:req=>req.phase==='outcome'
    ? '{"op":"event.propose","data":{"title":"整理完成","phase":"simulated","action_ref":"A1","effects":[{"type":"action_result","action_ref":"A1","value":"completed"}]}}'
    : '{"op":"noop"}'});
  try {
    const before=Object.fromEntries(BUSINESS_TABLES.map(t=>[t,f.rows(t)]));
    const result=await f.turn(); assert.equal(result.coreSaved,true,JSON.stringify(result));
    assert.equal(f.rows('actions')[0].status,'completed'); assert.ok(f.rows('events').some(e=>e.title==='整理完成'));
    assert.ok(f.calls.some(r=>r.phase==='outcome')); assert.equal(result.receipt.clockAfterS,60);
    const timeline=querySqlCharacterTimeline({db:f.session.repo.db,branchId:f.session.branchId,revision:f.session.repo.internal.currentRevision(),viewMode:'author'}, {characterId:IDS.C2,limit:1});
    assert.equal(timeline.entries.length,1);assert.ok(timeline.total>=2);assert.equal(timeline.nextOffset,1);
    const later=querySqlCharacterTimeline({db:f.session.repo.db,branchId:f.session.branchId,revision:f.session.repo.internal.currentRevision(),viewMode:'author'}, {characterId:IDS.C2,offset:1,limit:100});
    assert.ok([...timeline.entries,...later.entries].some(entry=>entry.sourceTable==='events'&&entry.atS===30));
    const undone=await f.undo(result.receipt.turnId); assert.equal(undone.coreSaved,true,JSON.stringify(undone));
    for(const t of BUSINESS_TABLES) assert.deepEqual(f.rows(t),before[t],t);
    assert.equal(querySqlCharacterTimeline({db:f.session.repo.db,branchId:f.session.branchId,revision:f.session.repo.internal.currentRevision(),viewMode:'author'}, {characterId:IDS.C2}).total,0);
  } finally {await f.session.repo.close();}
});

test('Q05 formal SQL: a failed outcome stops at its causal boundary, keeps action pending and never announces success',async()=>{
  const f=await fixture({response:event('rest',{elapsed_s:60}),seed:db=>action(db),background:req=>{if(req.phase==='outcome')throw new Error('model unavailable'); return '{"op":"noop"}';}});
  try {
    const result=await f.turn(); assert.equal(result.coreSaved,true); assert.equal(result.receipt.status,'partial');
    const a=f.rows('actions')[0]; assert.equal(a.status,'active'); assert.equal(a.progress_s,30); assert.equal(a.reason_code,'OUTCOME_PENDING');
    assert.equal(f.rows('events').some(e=>e.cause_action_id==='work'),false);
    assert.equal(result.receipt.simulatedUntilS,30); assert.equal(result.receipt.clockAfterS,60);
    assert.equal(queryBound(f.session.repo.db,'SELECT simulation_status FROM branches WHERE id=?',[f.session.branchId])[0].simulation_status,'catching_up');
    await f.undo(result.receipt.turnId); assert.equal(f.rows('actions')[0].progress_s,0);
  } finally {await f.session.repo.close();}
});

test('Q05 formal SQL: partial journey segments advance without pretending to arrive, host save failure publishes nothing',async()=>{
  const f=await fixture({response:event('rest',{elapsed_s:300}),seed:db=>action(db,{kind:'travel',status:'ready',duration_json:null,target_location_id:IDS.L2,payload_json:{destination_ref:IDS.L2,stop_policy:'continue'}})});
  try {
    const before=JSON.stringify(f.metadata); f.setSave(false);
    const failed=await f.turn(); assert.equal(failed.coreSaved,false); assert.equal(f.rows('journeys').length,0); assert.equal(JSON.stringify(f.metadata),before);
    f.setSave(true); const result=await f.turn(); assert.equal(result.coreSaved,true,JSON.stringify(result));
    assert.equal(f.rows('journeys').length,1); const j=f.rows('journeys')[0]; assert.equal(j.status,'moving');
    assert.equal(j.last_advanced_at_s,300); assert.equal(j.segment_time_done_s,300); assert.equal(j.arrived_at_s,null);
    await f.undo(result.receipt.turnId); assert.equal(f.rows('journeys').length,0); assert.equal(f.rows('actions')[0].status,'ready');
  } finally {await f.session.repo.close();}
});

test('Q05 formal SQL: a real contact can create knowledge only for its receiver, author secrets stay out of actor inputs',async()=>{
  const secret='刺客隐藏计划唯一秘密';
  const f=await fixture({response:event('rest',{elapsed_s:120}),seed:db=>{
    action(db,{actor_entity_id:IDS.C1,kind:'wait',target_location_id:IDS.L2,payload_json:{until:{time_at_or_after:{at_s:9999}}},duration_json:null});
    add(db,'information',{id:'news',title:'钟声',content:'广场传来钟声',kind:'announcement',secrecy:'public'});
    add(db,'information',{id:'secret',title:'隐藏消息',content:secret,kind:'report',secrecy:'secret'});
    add(db,'rumor_fronts',{id:'front',information_id:'news',location_id:IDS.L2,first_available_at_s:0,next_spread_check_s:3600});
  },background:req=>{
    if(req.phase!=='decision')return '{"op":"noop"}';
    assert.equal(JSON.stringify(req).includes(secret),false);
    const contacts=JSON.parse(req.messages.at(-1).content.match(/程序给出的接触机会：(.*)/)[1]);
    const contact=contacts.find(o=>o.receiverEntityId==='C1'); assert.ok(contact); return JSON.stringify({op:'attention.propose',data:{opportunity_ref:contact.id,belief:'heard'}});
  }});
  try {
    const result=await f.turn(); assert.equal(result.coreSaved,true,JSON.stringify(result));
    const known=f.rows('knowledge'); assert.equal(known.length,1,JSON.stringify(result.receipt));
    assert.equal(known[0].information_id,'news'); assert.equal(known[0].knower_character_id,IDS.C1);
    await f.undo(result.receipt.turnId); assert.equal(f.rows('knowledge').length,0);
  } finally {await f.session.repo.close();}
});

test('Q05 formal SQL: propagation has a real arrival boundary, only establishes a local front and undoes its in-flight actions',async()=>{
  const f=await fixture({response:event('rest',{elapsed_s:12000}),seed:db=>{
    db.run('UPDATE routes SET distance_m=1400,distance_min_m=1400,distance_max_m=1400');
    add(db,'information',{id:'public-news',title:'集市停业',content:'集市今天停业',kind:'announcement',secrecy:'public'});
    add(db,'rumor_fronts',{id:'source-front',information_id:'public-news',location_id:IDS.L1,first_available_at_s:0,next_spread_check_s:3600});
  }});
  try {
    const result=await f.turn(); assert.equal(result.coreSaved,true,JSON.stringify(result));
    const destination=f.rows('rumor_fronts').find(row=>row.location_id===IDS.L2);
    assert.ok(destination,JSON.stringify(result.receipt.issues)); assert.equal(destination.first_available_at_s,4600);
    assert.ok(f.rows('actions').some(a=>a.kind==='transmit'&&a.status==='completed'&&a.finished_at_s===4600));
    assert.equal(f.rows('knowledge').length,0,'local contact opportunities are not automatic knowledge');
    const steps=JSON.parse(queryBound(f.session.repo.db,'SELECT decisions_json FROM turns WHERE id=?',[result.receipt.turnId])[0].decisions_json).simulation_steps;
    assert.ok(steps.some(s=>s.kind==='information_delivery'&&s.atS===4600));
    await f.undo(result.receipt.turnId); assert.equal(f.rows('rumor_fronts').length,1); assert.equal(f.rows('actions').length,0);
  } finally {await f.session.repo.close();}
});
