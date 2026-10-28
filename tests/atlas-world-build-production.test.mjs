import test from 'node:test';
import assert from 'node:assert/strict';
import { openSqlSession, closeSqlSession, loadAtlasSqlRuntime } from '../src/atlas-sql-session.ts';
import { createAtlasSqlRouteGroup } from '../src/atlas-sql-routes.ts';
import { currentBuildJob } from '../src/atlas-world-build-execution.ts';
import { readProgressRows } from '../src/atlas-construction-progress.ts';
import { readWorldBuildTargets } from '../src/atlas-world-build-state.ts';
import { createTableReadPort } from '../src/atlas-db-readport.ts';
import { waitWorldBuildIdle } from '../src/atlas-sql-world-build.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { readWorldBuildJobs } from '../src/atlas-world-build-state.ts';
import { queryTurnAnalysis } from '../src/atlas-turn-analysis-view.ts';
import { readBuildAuditSummary } from '../src/atlas-world-build-ledger.ts';

const sourceSnapshot = [{ key: 'lore:anonymous', kind: 'lorebook', hash: 'anonymous-source-v1', text: '一个有限的匿名世界，只有一处旧旅馆。' }];

async function fixture({ save = async () => true, request, readWorldBuildSources, metadata = {} } = {}) {
  const calls = [];
  const session = await openSqlSession({ chatUid: 'world-build-production', chatMetadata: metadata, saveSession: save, readWorldBuildSources,
    modelPort: { async generationOptions() { return { batching: { requestsPerOperation: 1, mapsPerBatch: 1, charactersPerBatch: 1 } }; },
      async request(input) { calls.push(input); return { batchId: input.batchId, text: request ? await request(input) : '{"op":"noop"}', finishReason: 'stop', httpStatus: 200, durationMs: 1 }; } } });
  const runtime = await loadAtlasSqlRuntime();
  const routes = createAtlasSqlRouteGroup({ repository: session.repo, sessionProvider: { enabled: () => true, runtime: async () => runtime,
    session: async () => session, saved() {}, close: async () => closeSqlSession(session) } });
  const invoke = (route, body = {}) => routes.handle('POST', `/sql/world-build/${route}`, { chatUid: session.chatUid, branchId: session.branchId, autoContinue: false, ...body });
  return { session, calls, routes, invoke };
}

test('T-X03/T-R07 start persists a real job through the host ACK and performs no model send', async () => {
  let saves = 0;
  const f = await fixture({ save: async () => { saves++; return true; } });
  try {
    const response = await f.invoke('start', { sourceSnapshot });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(saves, 1);
    assert.equal(f.calls.length, 0);
    const job = currentBuildJob(f.session.repo.db, f.session.branchId);
    assert.equal(job.status, 'running');
    assert.equal(job.cumulativeWindows, 0);
    assert.equal(readWorldBuildTargets(readProgressRows(createTableReadPort(f.session.repo.db), f.session.branchId), job.id).values.length, 1);
    assert.ok(f.session.chatMetadata.atlas.database);
  } finally { await f.routes.close(); }
});

test('T-R07 failed host save never publishes the new job or its target rows', async () => {
  const f = await fixture({ save: async () => { throw Error('synthetic save failure'); } });
  try {
    const before = Buffer.from(await f.session.repo.exportCurrent());
    const response = await f.invoke('start', { sourceSnapshot });
    assert.equal(response.body.data?.coreSaved ?? response.body.coreSaved, false, JSON.stringify(response.body));
    assert.equal(currentBuildJob(f.session.repo.db, f.session.branchId), null);
    assert.deepEqual(Buffer.from(await f.session.repo.exportCurrent()), before);
    assert.equal(f.calls.length, 0);
  } finally { await f.routes.close(); }
});

test('T-J03 stop is a saved control operation and duplicate stop is idempotent', async () => {
  let saves = 0;
  const f = await fixture({ save: async () => { saves++; return true; } });
  try {
    await f.invoke('start', { sourceSnapshot });
    const job = currentBuildJob(f.session.repo.db, f.session.branchId);
    const stopped = await f.invoke('control', { action: 'stop', jobId: job.id });
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    const once = currentBuildJob(f.session.repo.db, f.session.branchId);
    assert.equal(once.status, 'paused');
    assert.equal(once.runEpoch, job.runEpoch + 1);
    assert.equal(saves, 2);
    await f.invoke('control', { action: 'stop', jobId: job.id });
    assert.deepEqual(currentBuildJob(f.session.repo.db, f.session.branchId), once);
    assert.equal(saves, 2);
    assert.equal(f.calls.length, 0);
  } finally { await f.routes.close(); }
});

test('T-J01/T-J15 a real construction batch journals its sequence and skips foreground/background inference', async () => {
  const f = await fixture();
  try {
    await f.invoke('start', { sourceSnapshot });
    const response = await f.invoke('batch');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.coreSaved, true, JSON.stringify(response.body));
    const job = currentBuildJob(f.session.repo.db, f.session.branchId);
    assert.equal(job.cumulativeWindows, 1);
    assert.equal(job.committedWindowSequence, 1);
    assert.equal(job.nextWindowSequence, 2);
    assert.equal(f.calls.length, 1, 'the selected source scan must reach the real model port once');
    assert.equal(f.calls.some(call => call.phase === 'observe' || call.phase === 'decision' || call.phase === 'outcome'), false);
    assert.equal(job.cumulativeTransports, f.calls.length);
    assert.equal(f.session.repo.internal.currentClock(), 0);
    const analysis=queryTurnAnalysis({db:f.session.repo.db,branchId:f.session.branchId,chatId:f.session.chatUid,revision:f.session.repo.internal.currentRevision(),viewMode:'author'},{kind:'turn-analysis',branchId:f.session.branchId});
    assert.equal(analysis.summary.groups.byWindow.length,1,'persisted decisions link the actual window');
    assert.equal(analysis.summary.groups.byWindow[0].windowSequence,1);
    assert.ok(analysis.items.some(item=>item.buildLinkage?.role==='build-window'));
    assert.equal(readBuildAuditSummary(f.session.repo.db,f.session.branchId,job.id).ledgerAvailable,true);
  } finally { await f.routes.close(); }
});

test('T-J02/T-J05 real automatic windows continue after one missing layout and retain successful entities', async () => {
  const f = await fixture({ request: async request => request.batchId.startsWith('construction_') ? [
    { op: 'location.upsert', ref: 'new:town', data: { name: '验收城镇', kind: 'city' }, source: 'lore:anonymous' },
    { op: 'location.upsert', ref: 'new:inn', data: { name: '已有旅馆', kind: 'building', parent_ref: 'new:town' }, source: 'lore:anonymous' },
  ].map(JSON.stringify).join('\n') : '{"op":"noop"}' });
  try {
    const response = await f.invoke('start', { sourceSnapshot, autoContinue: true, wait: true });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.error, undefined, JSON.stringify(response.body));
    const job = currentBuildJob(f.session.repo.db, f.session.branchId);
    assert.equal(job.status, 'completed-with-issues');
    assert.ok(job.cumulativeWindows > 1);
    assert.equal(job.cumulativeTransports, f.calls.length);
    assert.ok(queryBound(f.session.repo.db, 'SELECT id FROM locations WHERE name=?', ['验收城镇']).length === 1);
    assert.ok(queryBound(f.session.repo.db, "SELECT id FROM locations WHERE kind='building'").length >= 2, 'bounded facilities are real locations');
    const targets = readWorldBuildTargets(readProgressRows(createTableReadPort(f.session.repo.db), f.session.branchId), job.id).values;
    assert.ok(targets.some(target => target.workKind === 'map-layout' && target.status === 'failed'));
    assert.ok(targets.some(target => target.workKind === 'npc-initial-placement' && target.status === 'done'), 'failed map does not prevent independent local work');
    const facilities=queryBound(f.session.repo.db,"SELECT id FROM locations WHERE kind='building' ORDER BY id");
    const plans=readProgressRows(createTableReadPort(f.session.repo.db),f.session.branchId).filter(row=>row.payload.payloadKind==='settlement-plan/v1').map(row=>row.payload);
    assert.ok(plans.length>0,'the finite facility plan is actually saved');
    await f.invoke('control',{action:'retry-failed',jobId:job.id,sourceSnapshot,autoContinue:true,wait:true});
    assert.deepEqual(queryBound(f.session.repo.db,"SELECT id FROM locations WHERE kind='building' ORDER BY id"),facilities);
    assert.deepEqual(readProgressRows(createTableReadPort(f.session.repo.db),f.session.branchId).filter(row=>row.payload.payloadKind==='settlement-plan/v1').map(row=>row.payload),plans);
    assert.equal(f.session.repo.internal.currentClock(), 0);
  } finally { await f.routes.close(); }
});

test('T-J03/T-R04 stop during a real pending model call rejects the late candidate and starts no next window', async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ request: async () => { entered(); await gate; return '{"op":"location.upsert","ref":"new:late","data":{"name":"不得发布的迟到地点","kind":"room"}}'; } });
  try {
    await f.invoke('start', { sourceSnapshot, autoContinue: true });
    await started;
    const job = currentBuildJob(f.session.repo.db, f.session.branchId);
    const live=await f.routes.handle('POST','/sql/chat/state',{chatUid:f.session.chatUid});
    assert.equal(live.body.data.buildStatus.job.label,'建设运行中');
    assert.equal(live.body.data.buildStatus.job.waitingForTrigger,false);
    assert.equal(live.body.data.buildStatus.windows.current,1);
    const stopped = await f.invoke('control', { action: 'stop', jobId: job.id });
    assert.equal(stopped.body.data.coreSaved, true, JSON.stringify(stopped.body));
    const draining=await f.routes.handle('POST','/sql/chat/state',{chatUid:f.session.chatUid});
    assert.equal(draining.body.data.buildStatus.job.label,'停止中，等待在途请求结束');
    assert.equal(draining.body.data.buildStatus.actions.canRetryFailed,false);
    assert.match(draining.body.data.buildStatus.actions.retryBlockedReason,/在途请求/);
    release();
    await waitWorldBuildIdle(f.session);
    assert.equal(currentBuildJob(f.session.repo.db, f.session.branchId).status, 'paused');
    assert.equal(queryBound(f.session.repo.db, 'SELECT id FROM locations WHERE name=?', ['不得发布的迟到地点']).length, 0);
    assert.equal(f.calls.length, 1);
    assert.equal(currentBuildJob(f.session.repo.db, f.session.branchId).cumulativeTransports, 1, 'cancelled transmissions are real consumption');
    const settled=await f.routes.handle('POST','/sql/chat/state',{chatUid:f.session.chatUid});
    assert.equal(settled.body.data.buildStatus.actions.retryBlockedReason,null);
    const savedAudit=queryBound(f.session.repo.db,'SELECT receipt_json FROM turns WHERE branch_id=? AND decisions_json LIKE ?',[f.session.branchId,'%"aborted":true%']).map(row=>JSON.parse(row.receipt_json).requestAudit);
    assert.equal(savedAudit.length,1);
    assert.equal(savedAudit[0].transports,1,'late sends retain the real transport journal');
  } finally { release(); await f.routes.close(); }
});

test('T-L01 new source hashes create a separate incremental job and leave the initial target history intact', async () => {
  const f = await fixture();
  try {
    await f.invoke('start', { sourceSnapshot, autoContinue:true, wait:true });
    const initial = currentBuildJob(f.session.repo.db, f.session.branchId);
    const oldTargets = readWorldBuildTargets(readProgressRows(createTableReadPort(f.session.repo.db), f.session.branchId), initial.id).values;
    const before = f.calls.length;
    const changed = [{...sourceSnapshot[0],hash:'changed-anonymous-v2',text:'匿名世界中新加入的一条资料。'}];
    const response = await f.invoke('start', { sourceSnapshot:changed, autoContinue:true, wait:true });
    assert.equal(response.body.data.error, undefined, JSON.stringify(response.body));
    const next = currentBuildJob(f.session.repo.db, f.session.branchId);
    assert.notEqual(next.id, initial.id);
    assert.equal(next.kind, 'lore-incremental');
    assert.equal(next.status, 'completed');
    assert.ok(f.calls.length > before);
    assert.deepEqual(readWorldBuildTargets(readProgressRows(createTableReadPort(f.session.repo.db), f.session.branchId), initial.id).values, oldTargets);
    const count = f.calls.length;
    const duplicate = await f.invoke('start', { sourceSnapshot:changed, autoContinue:true, wait:true });
    assert.equal(duplicate.body.data.duplicate, true);
    assert.equal(f.calls.length, count);
  } finally { await f.routes.close(); }
});

test('T-L02 a source replaced before scanning is blocked under its old hash and scanned under a new incremental job', async () => {
  const f = await fixture();
  try {
    await f.invoke('start', {sourceSnapshot});
    const initial = currentBuildJob(f.session.repo.db,f.session.branchId);
    const nextSources=[{...sourceSnapshot[0],hash:'changed-before-read',text:'被替换后的匿名资料。'}];
    const response=await f.invoke('start',{sourceSnapshot:nextSources,autoContinue:true,wait:true});
    assert.equal(response.body.data.error,undefined,JSON.stringify(response.body));
    const rows=readProgressRows(createTableReadPort(f.session.repo.db),f.session.branchId);
    const old=readWorldBuildTargets(rows,initial.id).values.find(target=>target.workKind==='source-scan');
    assert.equal(old.status,'blocked');
    assert.equal(old.inputSignature,sourceSnapshot[0].hash);
    assert.equal(old.lastErrorCode,'LORE_STALE_HASH_SUPERSEDED');
    assert.equal(readWorldBuildJobs(rows).values.length,2);
    assert.equal(currentBuildJob(f.session.repo.db,f.session.branchId).kind,'lore-incremental');
  } finally {await f.routes.close();}
});

test('T-J06 all source identities survive more than one discovery page without an endless runner', async()=>{
  const f=await fixture();
  try{
    const many=Array.from({length:65},(_,index)=>({key:`lore:page:${index}`,hash:`hash:${index}`,kind:'lorebook',text:`匿名条目 ${index}。`}));
    const response=await f.invoke('start',{sourceSnapshot:many,autoContinue:true,wait:true});
    assert.equal(response.body.data.error,undefined,JSON.stringify(response.body));
    const job=currentBuildJob(f.session.repo.db,f.session.branchId);
    const targets=readWorldBuildTargets(readProgressRows(createTableReadPort(f.session.repo.db),f.session.branchId),job.id).values.filter(target=>target.workKind==='source-scan');
    assert.equal(targets.length,65);
    assert.equal(targets.filter(target=>target.status==='done').length,65);
    assert.equal(job.status,'completed');
    assert.equal(job.cumulativeTransports,f.calls.length);
    assert.ok(job.cumulativeWindows<70);
  }finally{await f.routes.close();}
});

test('T-L03 revoking live host sources during a pending call discards the candidate and retains the real transport charge',async()=>{
  let readable=true,entered,release;
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture({readWorldBuildSources:async()=>readable?sourceSnapshot:[],request:async()=>{entered();await gate;return '{"op":"location.upsert","ref":"new:revoked","data":{"name":"撤权后不得发布的匿名地点","kind":"room"},"source":"lore:anonymous"}';}});
  try{
    await f.invoke('start',{sourceSnapshot,autoContinue:true});await started;
    readable=false;release();await waitWorldBuildIdle(f.session);
    assert.equal(queryBound(f.session.repo.db,'SELECT id FROM locations WHERE name=?',['撤权后不得发布的匿名地点']).length,0);
    const job=currentBuildJob(f.session.repo.db,f.session.branchId);
    assert.equal(job.status,'paused');assert.equal(job.stopReason,'LORE_RUN_TICKET_INVALIDATED');
    assert.equal(job.cumulativeTransports,1);assert.equal(f.calls.length,1);
  }finally{release();await f.routes.close();}
});

test('T-J04 reloading a saved running job performs zero sends and zero saves until a fresh explicit trigger',async()=>{
  const f=await fixture();await f.invoke('start',{sourceSnapshot});
  const metadata=f.session.chatMetadata,job=currentBuildJob(f.session.repo.db,f.session.branchId);
  await f.routes.close();let saves=0;
  const restored=await fixture({metadata,save:async()=>{saves++;return true;}});
  try{
    assert.equal(currentBuildJob(restored.session.repo.db,restored.session.branchId).id,job.id);
    const state=await restored.routes.handle('POST','/sql/chat/state',{chatUid:restored.session.chatUid});
    assert.equal(state.status,200,JSON.stringify(state.body));
    assert.equal(state.body.data.buildStatus.job.id,job.id);assert.equal(state.body.data.buildStatus.job.autoFetch,false);
    assert.equal(saves,0);assert.equal(restored.calls.length,0);
    await restored.invoke('start',{sourceSnapshot,autoContinue:true,wait:true});
    assert.ok(restored.calls.length>0);assert.equal(currentBuildJob(restored.session.repo.db,restored.session.branchId).id,job.id);
  }finally{await restored.routes.close();}
});
