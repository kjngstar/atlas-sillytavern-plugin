import test from 'node:test';
import assert from 'node:assert/strict';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { makeSeedWith, IDS, insertRows } from './fixtures/atlas-sql/seed.mjs';
import { createRow } from '../src/atlas-db-defaults.ts';
import { createSqlModelPort } from '../src/atlas-sql-model-port.ts';
import { createDefaultSettingsV2 } from '../src/atlas-settings.ts';
import { createBrowserSqlHost } from '../src/atlas-browser-sql-host.ts';
import { loadAtlasSqlRuntime } from '../src/atlas-sql-session.ts';
import { handleSqlMapAction } from '../src/atlas-sql-map-actions.ts';
import { handleSqlChatRequest } from '../src/atlas-sql-chat.ts';
import { normalizeConstructionOps } from '../src/atlas-sql-world-completion.ts';
import { floor } from '../vendor/atlas-spatial/foundation.mjs';
import { dedupeWorldConstructionOps } from '../src/atlas-sql-world-dedupe.ts';
import { buildSqlLayoutTask } from '../src/atlas-sql-layout-task.ts';
import { overview } from '../vendor/atlas-spatial/overview-core.mjs';
const SQL = await (await import('sql.js')).default();
const noop = '{"op":"noop"}';
const model = fn => ({calls:[], async request(req){this.calls.push(req);return {batchId:req.batchId,text:fn(req,this.calls.length),httpStatus:200,durationMs:1};}});
const anchor = {chatUid:IDS.chatA,branchId:IDS.branchMain,parentTurnId:IDS.seedTurn,hostMessageUid:'accept-fix',variantKey:'v1',baseRevision:0,baseStorageRevision:0,inputHash:'accept-fix'};
async function seeded(port, setup){const seed=await makeSeedWith(SQL);setup?.(seed.db);const bytes=seed.exportBytes();seed.close();const repo=createSqlRepository({chatUid:IDS.chatA,branchId:IDS.branchMain,modelPort:port});await repo.open({bytes});return repo;}
const input = extra => ({anchor,userText:'合成验收',assistantText:'合成验收',sourceSnapshot:[],phaseBatches:['observe'],manual:false,sceneOnly:true,worldCompletion:{mode:'local',focusLocationIds:[IDS.L3]},...extra});

test('successive layouts retain the container room and furniture while removing an actor who left',async()=>{
 const repo=await seeded(model(()=>noop),db=>{db.run('UPDATE characters SET location_id=?,map_id=?,grid_x=NULL,grid_y=NULL WHERE id IN (?,?)',[IDS.L3,IDS.M1,IDS.C1,IDS.C2]);db.run('UPDATE locations SET map_id=? WHERE id=?',[IDS.M1,IDS.L3]);});
 const layout=spec=>({op:'map.layout.request',ref:IDS.M2,data:{kind:'floor',spec}});
 const scene=()=>JSON.parse(queryBound(repo.db,'SELECT frame_json FROM maps WHERE id=?',[IDS.M2])[0].frame_json).atlasScene;
 const save=async(extra)=>{const p=await repo.prepareTurn(input({manual:true,worldCompletion:undefined,phaseBatches:[],...extra}));assert.ok(!p.receipt.issues.some(i=>i.severity==='error'),JSON.stringify(p.receipt.issues));await repo.confirmSaved({token:p.token,snapshotSha256:p.snapshotSha256,result:'saved'});return p;};
 try{
  const first=await save({operations:[layout({width:12,height:8,singleRoom:true,rooms:[{id:IDS.L3,w:12,h:8,side:'north'}],contents:[{id:'old-bench',type:'bench',roomId:IDS.L3,w:2,h:1}],actors:[{id:IDS.C1,roomId:IDS.L3},{id:IDS.C2,roomId:IDS.L3}]})]});
  assert.ok(scene().constraints.contents.some(c=>c.id==='old-bench'));
  const second=await save({anchor:{...anchor,parentTurnId:first.receipt.turnId,hostMessageUid:'accept-second',inputHash:'accept-second',baseRevision:1,baseStorageRevision:1},operations:[{op:'character.upsert',ref:IDS.C2,data:{location_ref:IDS.L1}},layout({contents:[{id:'new-desk',type:'table',roomId:IDS.L3,w:2,h:1}]})]});
  assert.ok(scene().constraints.rooms.some(r=>r.id===IDS.L3));
  assert.deepEqual(scene().constraints.contents.map(c=>c.id).sort(),['new-desk','old-bench']);
  assert.ok(scene().constraints.actors.some(c=>c.id===IDS.C1));assert.ok(!scene().constraints.actors.some(c=>c.id===IDS.C2));
  assert.ok(!second.receipt.issues.some(i=>i.code==='SCENE_STALE_MEMBER_PRUNED'&&i.message.includes('rooms:')));
  assert.deepEqual(queryBound(repo.db,'PRAGMA foreign_key_check',[]),[]);
 }finally{await repo.close();}
});

test('a single room may fill its entire measured canvas while keeping furniture inside',()=>{
 const spec={id:'library',width:12,height:8,corridorWidth:2,singleRoom:true,rooms:[{id:'room',w:12,h:8,side:'north'}],furniture:[{id:'shelf',roomId:'room',w:4,h:1}],actors:[]};
 const result=floor(spec);assert.equal(result.ok,true);assert.deepEqual(result.issues,[]);assert.equal(result.rooms[0].x,0);assert.equal(result.rooms[0].y,0);assert.equal(result.furniture.length,1);assert.equal(result.corridor.w,0);
 const outside=floor({...spec,rooms:[{...spec.rooms[0],locked:{x:1,y:0}}]});assert.equal(outside.ok,false);assert.equal(outside.issues[0].code,'ROOM_NO_SPACE');
});

test('overview sectors actually place areas in their requested directions and preserve confirmed points',()=>{
 const spec={id:'valley',width:100,height:100,zones:['north','south','east','west'].map(sector=>({id:sector,sector,size:'medium'})),features:[]};
 const result=overview(spec);const pins=new Map(result.pins.map(p=>[p.id,p]));assert.ok(pins.get('north').y<50);assert.ok(pins.get('south').y>50);assert.ok(pins.get('east').x>50);assert.ok(pins.get('west').x<50);assert.deepEqual(overview(spec,result).shapes,result.shapes);
 const locked=overview({...spec,zones:[{id:'east',sector:'east',locked:{x:20,y:20}}]});assert.equal(locked.pins[0].x,20);assert.equal(locked.pins[0].y,20);
});

test('non-contract parent fields cannot silently create orphan root locations',()=>{
 const result=normalizeConstructionOps({operations:[{op:'location.upsert',ref:'new:shelf',data:{name:'书架区',parent:'L1',type:'zone'}}],knownIds:['L1']});
 assert.deepEqual(result.operations,[]);assert.ok(result.issues.some(i=>i.code==='WORLD_CONSTRUCTION_SCHEMA_INVALID'&&i.retryable));
});

test('a missing parent cannot duplicate a registered corridor as an unrelated root',()=>{
 const result=dedupeWorldConstructionOps({existingLocations:[{id:'corridor',name:'二楼走廊',kind:'room',parent_location_id:'school'}],operations:[{op:'location.upsert',ref:'new:corridor',data:{name:'二楼走廊',kind:'room'}},{op:'route.propose',data:{from_ref:'library',to_ref:'new:corridor'}}]});
 assert.equal(result.operations.length,0);assert.ok(result.issues.some(i=>i.code==='LOCATION_PARENT_REQUIRED'));assert.ok(result.issues.some(i=>i.code==='WORLD_DEPENDENCY_GROUP_REJECTED'));
});

test('an occupied room does not permanently starve its missing world overview',async()=>{
 const repo=await seeded(model(()=>noop),db=>db.run('UPDATE characters SET location_id=? WHERE id=?',[IDS.L3,IDS.C1]));try{const task=buildSqlLayoutTask(repo.db,IDS.branchMain,input({layoutMaps:'active'}),'layout-accept');assert.ok(task.mapIds.includes(IDS.M2));assert.ok(task.mapIds.includes(IDS.M1));assert.equal(task.kinds[IDS.M1],'overview');assert.equal(task.mapIds.length,2);}finally{await repo.close();}
});

test('a coarse outdoor position can still request its missing world overview',async()=>{
 const repo=await seeded(model(()=>noop));try{const task=buildSqlLayoutTask(repo.db,IDS.branchMain,input({layoutMaps:'active'}),'outdoor-accept');assert.ok(task.mapIds.includes(IDS.M1));assert.equal(task.kinds[IDS.M1],'overview');}finally{await repo.close();}
});

test('empty bootstrap observes first, constructs its newly registered place, and restores native receipts without a global bucket', async()=>{
 const port=model((req,n)=>n===1?'{"op":"location.upsert","ref":"new:lodge","data":{"name":"新旅店","kind":"building"}}\n{"op":"character.upsert","ref":"new:pov","data":{"name":"测试主角","identity":"旅行者","role":"protagonist","location_ref":"new:lodge"}}':JSON.stringify({op:'location.upsert',ref:'new:kitchen',data:{name:'厨房',kind:'room',parent_ref:req.messages[1].content.match(/focus=([^、\n]+)/)[1]}}));
 const hostRecord={chatUid:'accept-bootstrap',branchId:'main',chatMetadata:{},saveMetadata:async()=>true};
 const provider=createBrowserSqlHost({enabled:()=>true,context:()=>hostRecord,loadRuntime:loadAtlasSqlRuntime,modelPort:port});
 try {const session=await provider.session(hostRecord.chatUid);await handleSqlMapAction(session,'map/bootstrap',{chatId:hostRecord.chatUid,requestId:'initial',assistantText:'主角进入有厨房的旅店。'});
  assert.equal(port.calls.length,2);assert.ok(port.calls[1].batchId.startsWith('construction_'));
  assert.match(port.calls[1].messages[0].content,/parent_ref/);assert.match(port.calls[1].messages[0].content,/from_ref/);
  assert.match(port.calls[1].messages[1].content,/新旅店/);
  const places=queryBound(session.repo.db,'SELECT id,name,parent_location_id FROM locations',[]);assert.equal(places.find(p=>p.name==='厨房').parent_location_id,places.find(p=>p.name==='新旅店').id);
  const state=await handleSqlChatRequest(session,'state',{});assert.equal(state.receipts.length,1);assert.equal(state.receipts[0].detail.coreSaved,true);assert.ok(state.receipts[0].detail.receipt.groups.length);assert.equal(state.receipts[0].detail.attempts.length,2);
  assert.ok(queryBound(session.repo.db,'SELECT frame_json FROM maps',[]).some(row=>JSON.parse(row.frame_json).atlasWorldFill));
 }finally{await provider.close();}
});

test('construction protects saved parent and coordinates and defers excess locations, leaving the native receipt partial',async()=>{
 const port=model((_req,n)=>n===1?noop:[...Array.from({length:13},(_,i)=>({op:'location.upsert',ref:`new:r${i}`,data:{name:`房间${i}`,kind:'room',parent_ref:IDS.L2}})),{op:'location.upsert',ref:IDS.L3,data:{name:'教室',parent_ref:IDS.L1,position:{map_ref:IDS.M1,x:99,y:99,precision:'exact'}}}].map(JSON.stringify).join('\n'));
 const repo=await seeded(port);try{const p=await repo.prepareTurn(input());const db=repo.getCandidate(p.token).db;const room=queryBound(db,'SELECT parent_location_id,grid_x,grid_y FROM locations WHERE id=?',[IDS.L3])[0];assert.deepEqual(room,{parent_location_id:IDS.L2,grid_x:5,grid_y:6});assert.equal(queryBound(db,'SELECT COUNT(*) n FROM locations WHERE created_turn_id=?',[p.receipt.turnId])[0].n,12);assert.equal(p.receipt.status,'partial');assert.ok(p.receipt.issues.some(i=>i.code==='WORLD_CONSTRUCTION_DEFERRED'));assert.ok(p.receipt.issues.some(i=>i.code==='WORLD_CONSTRUCTION_PROTECTED_FACT'));}finally{await repo.close();}
});

test('an item can be declared and transferred in the same observed batch',async()=>{
 const port=model((_req,n)=>n===1?JSON.stringify({op:'item.upsert',ref:'new:compass',data:{name:'铜罗盘'}})+'\n'+JSON.stringify({op:'item.transfer',ref:'new:compass',data:{to:{holder_ref:IDS.C1}}}):noop);
 const repo=await seeded(port);try{const p=await repo.prepareTurn(input());assert.ok(!p.receipt.issues.some(i=>i.severity==='error'),JSON.stringify(p.receipt.issues));const rows=queryBound(repo.getCandidate(p.token).db,'SELECT holder_character_id FROM items WHERE name=?',['铜罗盘']);assert.equal(rows.length,1);assert.equal(rows[0].holder_character_id,IDS.C1);assert.ok(!port.calls.some(r=>r.phase==='repair'));}finally{await repo.close();}
});

test('a new character and new held item commit together without using a repair slot',async()=>{
 const port=model((_req,n)=>n===1?[
  {op:'location.upsert',ref:'new:plaza',data:{name:'新广场',kind:'other'}},
  {op:'character.upsert',ref:'new:visitor',data:{name:'来客',identity:'旅人',location_ref:'new:plaza'}},
  {op:'item.upsert',ref:'new:key',data:{name:'新铜钥匙'}},
  {op:'item.transfer',ref:'new:key',data:{to:{holder_ref:'new:visitor'}}}
 ].map(JSON.stringify).join('\n'):noop);
 const repo=await seeded(port);try{const p=await repo.prepareTurn(input());const db=repo.getCandidate(p.token).db;const c=queryBound(db,'SELECT id FROM characters WHERE name=?',['来客'])[0];assert.equal(queryBound(db,'SELECT holder_character_id FROM items WHERE name=?',['新铜钥匙'])[0].holder_character_id,c.id);assert.ok(!p.receipt.issues.some(i=>i.severity==='error'));assert.ok(!port.calls.some(r=>r.phase==='repair'));assert.deepEqual(queryBound(db,'PRAGMA foreign_key_check',[]),[]);}finally{await repo.close();}
});

test('a malformed layout reply cannot be reported as a committed successful layout',async()=>{
 const repo=await seeded(model(()=>'{"op":"map.layout.request"}garbage'));
 try{let p;try{p=await repo.prepareTurn(input({manual:true,phaseBatches:[],operations:[],worldCompletion:undefined,sceneMaps:true,layoutMaps:[IDS.M1]}));}catch(error){assert.equal(error.code,'TURN_FAILED');assert.ok(error.detail.receipt.issues.some(i=>i.code==='JSON_SYNTAX'));return;}assert.equal(p.receipt.status,'partial');assert.ok(p.receipt.issues.some(i=>i.code==='JSON_SYNTAX'));}finally{await repo.close();}
});

test('a unique current persona binds the first protagonist even if the model omitted its role',async()=>{
 const repo=await seeded(model(()=>noop),db=>{db.run("UPDATE characters SET role='npc' WHERE branch_id=?",[IDS.branchMain]);db.run('UPDATE branches SET pov_character_id=NULL WHERE id=?',[IDS.branchMain]);});
 try{const p=await repo.prepareTurn(input({sceneMaps:true,povName:'艾琳'}));const db=repo.getCandidate(p.token).db;assert.equal(queryBound(db,'SELECT pov_character_id FROM branches WHERE id=?',[IDS.branchMain])[0].pov_character_id,IDS.C1);assert.equal(queryBound(db,'SELECT role FROM characters WHERE id=?',[IDS.C1])[0].role,'protagonist');const log=queryBound(db,"SELECT basis_json FROM turn_changes WHERE turn_id=? AND target_table='characters' AND target_row_id=?",[p.receipt.turnId,IDS.C1]);assert.equal(JSON.parse(log[0].basis_json).kind,'user');}finally{await repo.close();}
});

test('persona matching never replaces an established POV or guesses between equal names',async()=>{
 const existing=await seeded(model(()=>noop));try{const p=await existing.prepareTurn(input({sceneMaps:true,povName:'信使'}));assert.equal(queryBound(existing.getCandidate(p.token).db,'SELECT pov_character_id FROM branches WHERE id=?',[IDS.branchMain])[0].pov_character_id,IDS.C1);}finally{await existing.close();}
 const repo=await seeded(model(()=>noop),db=>{db.run("UPDATE characters SET role='npc' WHERE branch_id=?",[IDS.branchMain]);db.run('UPDATE branches SET pov_character_id=NULL WHERE id=?',[IDS.branchMain]);db.run('UPDATE characters SET name=? WHERE branch_id=? AND id=?',['艾琳',IDS.branchMain,IDS.C2]);});try{const p=await repo.prepareTurn(input({sceneMaps:true,povName:'艾琳'}));assert.equal(queryBound(repo.getCandidate(p.token).db,'SELECT pov_character_id FROM branches WHERE id=?',[IDS.branchMain])[0].pov_character_id,null);}finally{await repo.close();}
});

test('depth and route limits defer dependencies rather than saving dangling children',()=>{
 const ops=[1,2,3].map(i=>({op:'location.upsert',ref:`new:d${i}`,data:{name:`深度${i}`,parent_ref:i===1?'L1':`new:d${i-1}`}}));ops.push(...Array.from({length:17},(_,i)=>({op:'route.propose',ref:`new:route${i}`,data:{from_ref:'L1',to_ref:'new:d1'}})),{op:'route.propose',ref:'new:badroute',data:{from_ref:'L1',to_ref:'new:d3'}});
 const result=normalizeConstructionOps({operations:ops,knownIds:['L1'],declaredNewRefs:['new:d1','new:d2','new:d3']});assert.equal(result.operations.filter(o=>o.op==='location.upsert').length,2);assert.equal(result.operations.filter(o=>o.op==='route.propose').length,16);assert.ok(!result.operations.some(o=>o.ref==='new:d3'||o.ref==='new:badroute'));assert.ok(result.issues.filter(i=>i.code==='WORLD_CONSTRUCTION_DEFERRED').length>=3);
});

test('all deferred target IDs survive SQL persistence beyond the next batch limit',async()=>{
 const ids=Array.from({length:130},(_,i)=>`queued_${String(i).padStart(3,'0')}`);
 const repo=await seeded(model(()=>noop),db=>{
  insertRows(db,'entity_keys',ids.map(id=>({branch_id:IDS.branchMain,id,kind:'location'})));
  insertRows(db,'locations',ids.map(id=>createRow('locations',{name:id,kind:'room',parent_location_id:IDS.L2,map_id:IDS.M1},{branchId:IDS.branchMain,id,turnId:IDS.seedTurn,clockS:0,nowWallMs:0,rulesetVersion:'atlas-1'})));
 });
 try{const p=await repo.prepareTurn(input({worldCompletion:{mode:'local',focusLocationIds:ids}}));
  const row=queryBound(repo.getCandidate(p.token).db,'SELECT frame_json FROM maps WHERE id=?',[IDS.M1])[0];const pending=JSON.parse(row.frame_json).atlasWorldFill.remainingLocationIds;
  assert.ok(ids.slice(64).every(id=>pending.includes(id)));assert.equal(p.receipt.status,'partial');assert.ok(!pending.includes(IDS.L2),'classified ancestors are catalogue context, not unfinished targets');
 }finally{await repo.close();}
});

test('production repository shares four actual sends including MiniMax compatibility rescue with construction',async()=>{
 const calls=[];const settings={...createDefaultSettingsV2(),activeApiPresetId:'connection',apiPresets:[{id:'connection',name:'合成MiniMax',endpoint:'https://api.minimaxi.com/v1',apiKey:'sk-cp-synthetic',model:'MiniMax-M3',maxTokens:9000,temperature:.4,timeoutMs:30000,updatedAt:1}]};
 const port=createSqlModelPort({readSettings:async()=>settings,fetchFn:async url=>{calls.push(String(url));const rescue=String(url).includes('/anthropic');return new Response(JSON.stringify(rescue?{choices:[{message:{content:noop}}]}:{error:{message:'Not Found'}}),{status:rescue?200:404});}});
 const repo=await seeded(port);try{const p=await repo.prepareTurn(input({phaseBatches:['observe','geography']}));assert.equal(calls.length,4);assert.equal(calls.filter(url=>url.includes('/anthropic')).length,2);assert.ok(p.receipt.issues.some(i=>i.code==='MODEL_BUDGET_EXHAUSTED'));assert.equal(p.receipt.status,'partial');}finally{await repo.close();}
});

test('a due background outcome uses the reserved fourth slot before optional layout',async()=>{
 const port=model((_req,n)=>n===1?'{"op":"event.propose","data":{"title":"休息一分","phase":"observed","activity":{"kind":"rest","completed":true},"time_hint":{"elapsed_s":60}}}':noop);
 const repo=await seeded(port,db=>insertRows(db,'actions',[createRow('actions',{id:'work',actor_entity_id:IDS.C2,kind:'prepare',title:'到期任务',status:'active',started_at_s:0,evaluated_until_s:0,next_check_s:0,duration_json:{min_s:30,nominal_s:30,max_s:30,quality:'explicit',basis_refs:[]}},{branchId:IDS.branchMain,id:'work',turnId:IDS.seedTurn,clockS:0,nowWallMs:0,rulesetVersion:'atlas-1'})]));
 try{await repo.prepareTurn(input({sceneOnly:false,phaseBatches:['observe','geography'],sceneMaps:true,layoutMaps:'active'}));assert.equal(port.calls.length,4);assert.equal(port.calls[3].phase,'outcome');assert.ok(!port.calls.some(req=>req.batchId.startsWith('layout_')));}finally{await repo.close();}
});
