import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createAtlasServerCore} from '../src/atlas-production-server.ts';
import {createBrowserSqlHost} from '../src/atlas-browser-sql-host.ts';
import {createNodeSqlHost} from '../src/atlas-node-sql-host.ts';
import {createMemoryDocumentStore} from '../src/atlas-memory-store.ts';
import {loadAtlasSqlRuntime} from '../src/atlas-sql-session.ts';
import {queryBound,foreignKeyCheck} from '../src/atlas-db-runtime.ts';
import {buildStarterWorld} from '../src/atlas-starter-world.ts';
import {createSqlModelPort} from '../src/atlas-sql-model-port.ts';
import {buildSqlForegroundRequest} from '../src/atlas-sql-model-context.ts';
import {createTableReadPort} from '../src/atlas-db-readport.ts';
import {createDefaultSettingsV2} from '../src/atlas-settings.ts';
import {writeAtlasSession} from '../ui/atlas-host-context.mjs';

async function fixture(metadata={}){
 let saveOk=true,saves=0;
 const record={chatUid:'production',chatMetadata:metadata,saveMetadata:async()=>{saves++;return saveOk;}};
 const provider=createBrowserSqlHost({enabled:()=>true,context:()=>record,loadRuntime:loadAtlasSqlRuntime});
 const store=createMemoryDocumentStore(),core=createAtlasServerCore({store,sqlSessionProvider:provider});
 const session=await provider.session(record.chatUid);
 const send=(action,body={})=>core.handle('POST','/sql/chat/'+action,{chatId:record.chatUid,chatUid:record.chatUid,...body},{local:true});
 return {record,provider,store,core,session,send,saves:()=>saves,failSave:()=>{saveOk=false;},close:()=>provider.close()};
}
function world(){const w=buildStarterWorld({id:'imported',now:1,name:'用户',description:'验收'});
 w.points.push({id:1,name:'图书馆',x:3,y:4,regionId:null});return w;}
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=';

test('R production rejects every old write route and preserves old backup documents',async()=>{
 const f=await fixture();try{
  await f.store.write('world:old',{id:'old',name:'备份'});const before=JSON.stringify([...f.store.dump()]);
  for(const route of ['/turns/commit','/turns/retry','/turns/rollback','/worlds/import','/bindings','/worlds/geo/adopt']){
   const result=await f.core.handle('POST',route,{chatId:'production',world:world()},{local:true});assert.equal(result.body.ok,false,route);
  }
  assert.equal(JSON.stringify([...f.store.dump()]),before);assert.equal(f.saves(),0);
  const foreign=await f.send('binding');assert.equal(foreign.body.ok,true);
  const denied=await f.core.handle('POST','/sql/chat/binding',{chatUid:'production'},{local:false});assert.equal(denied.status,403);
 }finally{await f.close();}
});
test('Q/R explicit world import saves only SQL, preserves stable IDs, and fully rolls back',async()=>{
 const f=await fixture();try{
  const beforeCounts=queryBound(f.session.repo.db,'SELECT COUNT(*) n FROM locations',[])[0].n;
  const imported=await f.send('map/import',{world:world()});assert.equal(imported.status,200,JSON.stringify(imported.body));
  assert.equal(imported.body.data.coreSaved,true);assert.equal(f.saves(),1);assert.equal(f.store.dump().size,0);
  assert.equal(queryBound(f.session.repo.db,'SELECT name FROM locations WHERE id=?',['loc:1'])[0].name,'图书馆');
  assert.equal(foreignKeyCheck(f.session.repo.db).length,0);
  const undone=await f.core.handle('POST','/sql/rollback',{chatUid:'production',targetParentTurnId:imported.body.data.receipt.turnId,expectedRevision:f.session.repo.internal.currentRevision()},{local:true});
  assert.equal(undone.body.data.coreSaved,true,JSON.stringify(undone.body));assert.equal(queryBound(f.session.repo.db,'SELECT COUNT(*) n FROM locations',[])[0].n,beforeCounts);
  assert.equal(queryBound(f.session.repo.db,'SELECT COUNT(*) n FROM maps',[])[0].n,0);
 }finally{await f.close();}
});
test('Q import save failure keeps the entire official database and metadata unchanged',async()=>{
 const f=await fixture();try{const bytes=Buffer.from(f.session.repo.db.export()),metadata=JSON.stringify(f.record.chatMetadata);f.failSave();
  const result=await f.send('map/import',{world:world()});assert.equal(result.body.ok,false);assert.equal(result.body.error.code,'SESSION_WRITE_FAILED');assert.equal(f.saves(),1);
  assert.deepEqual(Buffer.from(f.session.repo.db.export()),bytes);assert.equal(JSON.stringify(f.record.chatMetadata),metadata);
 }finally{await f.close();}
});
test('Q per-map images survive reopen, replacement, deletion and rollback without leaking to a child map',async()=>{
 const f=await fixture();try{
  const w=world();w.mapImage=png;const imported=await f.send('map/import',{world:w});assert.equal(imported.status,200,JSON.stringify(imported.body));
  assert.equal((await f.send('map/image',{mapId:'world'})).body.data.dataUrl,png);
  const child=queryBound(f.session.repo.db,'SELECT id FROM maps WHERE container_location_id=?',['loc:1'])[0].id;
  assert.equal((await f.send('map/image',{mapId:child})).body.data.dataUrl,null);
  const cleared=await f.send('map/image/set',{mapId:'world',dataUrl:null});assert.equal(cleared.status,200,JSON.stringify(cleared.body));
  assert.equal((await f.send('map/image',{mapId:'world'})).body.data.dataUrl,null);
  const undone=await f.core.handle('POST','/sql/rollback',{chatUid:'production',targetParentTurnId:cleared.body.data.receipt.turnId,expectedRevision:f.session.repo.internal.currentRevision()},{local:true});
  assert.equal(undone.body.data.coreSaved,true,JSON.stringify(undone.body));assert.equal((await f.send('map/image',{mapId:'world'})).body.data.dataUrl,png);
  assert.equal(f.record.chatMetadata.atlas.database.assets.length,1);
  await f.close();const reopened=await f.provider.session('production');
  assert.equal(reopened.worldUid,f.session.worldUid);assert.equal(reopened.branchName,f.session.branchName);
  assert.equal((await f.send('map/image',{mapId:'world'})).body.data.dataUrl,png);
 }finally{await f.close();}
});
test('R a legacy response cannot erase a migrated snapshot or its original backup',async()=>{
 const old={schemaVersion:1,world:{id:'old'},database:{sha256:'saved'},authorNote:'笔记'},metadata={atlas:old};
 await assert.rejects(writeAtlasSession(()=>({chatId:'production',chatMetadata:metadata,saveMetadata:async()=>true}),{schemaVersion:1,world:null,rev:1}),/SQL_LEGACY_WRITE_RETIRED/);
 assert.equal(metadata.atlas,old);
});
test('S Node host persists and refreshes the same per-chat envelope through the published core',async()=>{
 const store=createMemoryDocumentStore(),runtime=await loadAtlasSqlRuntime();
 const provider=createNodeSqlHost({store,runtime,modelPort:{request:async()=>{throw Error('No model needed');}}});
 try{
  const core=createAtlasServerCore({store,sqlSessionProvider:provider});
  const request={chatUid:'node-chat',chatId:'node-chat',world:world()};
  const imported=await core.handle('POST','/sql/chat/map/import',request,{local:true});assert.equal(imported.status,200,JSON.stringify(imported.body));
  const metadata=await store.read('sql-chat:node-chat');assert.ok(metadata.atlas.database);assert.equal(await store.read('world:imported'),null);
  await provider.close();const reopened=await provider.session('node-chat');assert.equal(queryBound(reopened.repo.db,'SELECT name FROM locations WHERE id=?',['loc:1'])[0].name,'图书馆');
 }finally{await provider.close();}
});
test('Q preview and submission share exact assembly, including every original source and author role',async()=>{
 const f=await fixture();try{
  const settings=createDefaultSettingsV2();settings.apiPresets=[{id:'api',name:'test',endpoint:'https://model.invalid/v1',model:'test',apiKey:'test',timeoutMs:5000,maxTokens:2000,temperature:0.4,updatedAt:1}];settings.activeApiPresetId='api';
  let calls=0,sent;
  const model=createSqlModelPort({readSettings:async()=>settings,fetchFn:async(_url,init)=>{calls++;sent=JSON.parse(init.body);return new Response(JSON.stringify({choices:[{message:{content:'{"op":"location.upsert","ref":"new:library","data":{"name":"图书馆"}}'}}]}),{headers:{'Content-Type':'application/json'}});}});
  const input={anchor:{chatUid:'production',branchId:'main',hostMessageUid:'p',variantKey:'p',parentTurnId:null,baseRevision:0,baseStorageRevision:0,inputHash:'p'},userText:'原用户',assistantText:'原剧情',phaseBatches:['observe'],sourceSnapshot:[{key:'full',kind:'lorebook',text:'条目一原文\n条目二原文',hash:'full'}],manual:false};
  const request=buildSqlForegroundRequest(createTableReadPort(f.session.repo.db),'main',input,'observe','same');
  const preview=await model.preview(request);assert.equal(calls,0);
  await model.request(request);assert.equal(calls,1);assert.deepEqual(sent.messages,preview.messages.map(({chars,...message})=>message));
  assert.ok(sent.messages.some(message=>message.content.includes(JSON.stringify('条目一原文\n条目二原文').slice(1,-1))));
 }finally{await f.close();}
});
test('R actual published UI bundle excludes the old reverse-sync writers and scheduler',()=>{
 const published=readFileSync(new URL('../dist/atlas-ui-core.mjs',import.meta.url),'utf8');
 for(const name of ['function executeCommit(','function commitTableDeltaTurn(','function buildTableDeltaContext(','function settleNpcSchedules(','function planBackgroundMoves('])assert.equal(published.includes(name),false,name);
});

test('Q real SQL travel preview uses route metres and seconds without moving or saving',async()=>{
 const sql=await import('sql.js');const SQL=await sql.default();
 const {makeSeedWith,IDS}=await import('./fixtures/atlas-sql/seed.mjs');
 const {encodeSnapshot}=await import('../src/atlas-db-envelope.ts');
 const {runBound}=await import('../src/atlas-db-runtime.ts');
 const {db}=await makeSeedWith(SQL);
 runBound(db,'UPDATE branches SET pov_character_id=? WHERE id=?',[IDS.C2,IDS.branchMain]);
 const metadata={atlas:{database:await encodeSnapshot(db.export(),{chatUid:'production',worldUid:'world-A',storageRevision:0,activeBranchId:IDS.branchMain})}};db.close();
 const f=await fixture(metadata);try{
  const before=Buffer.from(f.session.repo.db.export());
  const result=await f.send('travel-preview',{destinationPointId:IDS.L2});
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.data.preview.distance,12000);
  assert.equal(result.body.data.preview.distanceUnit,'m');assert.equal(result.body.data.preview.durationUnit,'s');
  assert.equal(result.body.data.preview.estimatedDuration,7200);assert.equal(result.body.data.coreSaved,false);assert.equal(f.saves(),0);
  assert.deepEqual(Buffer.from(f.session.repo.db.export()),before);
 }finally{await f.close();}
});
