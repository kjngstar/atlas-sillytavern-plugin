import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqlRepository} from '../src/atlas-db-repository.ts';
import {createRow} from '../src/atlas-db-defaults.ts';
import {queryBound, foreignKeyCheck} from '../src/atlas-db-runtime.ts';
import {createTableReadPort} from '../src/atlas-db-readport.ts';
import {computeMapLayoutSignature} from '../src/atlas-sql-layout-task.ts';
import {querySpatialScene} from '../src/atlas-spatial-views.ts';
import {readProgressRows, scopeKeyFor} from '../src/atlas-construction-progress.ts';
import {summarizeSources} from '../src/atlas-construction-sources.ts';
import {openSqlSession, closeSqlSession} from '../src/atlas-sql-session.ts';
import {handleSqlMapAction} from '../src/atlas-sql-map-actions.ts';
import {makeSeedWith, IDS, insertRows} from './fixtures/atlas-sql/seed.mjs';
import * as Kit from '../vendor/atlas-spatial/index.mjs';

const SQL=await (await import('sql.js')).default();
const BRANCH=IDS.branchMain;
let sequence=0;
const noop='{"op":"noop"}';
function model(reply){return {calls:[],async request(req){this.calls.push(req);return {batchId:req.batchId,text:reply(req),httpStatus:200,durationMs:1};}};}
const construction=port=>port.calls.filter(req=>req.batchId.startsWith('construction_'));
function patch(req){
  const focus=(req.messages[1].content.match(/focus=([^\n]*?)、maxNewLocations=/)?.[1]??'').split('、').filter(Boolean);
  return focus.slice(0,4).map(ref=>JSON.stringify({op:'location.upsert',ref,data:{description:'补丁回归核对'}})).join('\n')||noop;
}
async function fixture(port=null, setup){
  const seed=await makeSeedWith(SQL);setup?.(seed.db);
  const bytes=seed.exportBytes();seed.close();
  const repo=createSqlRepository({chatUid:IDS.chatA,branchId:BRANCH,modelPort:port});await repo.open({bytes});return repo;
}
function input(repo, extra={}){
  const id=`hotfix-${++sequence}`;
  return {anchor:{chatUid:IDS.chatA,branchId:BRANCH,parentTurnId:repo.internal.currentHeadTurnId(),hostMessageUid:id,
    variantKey:'author',inputHash:id,baseRevision:repo.internal.currentRevision(),baseStorageRevision:repo.storageRevision},
    userText:'',assistantText:'',sourceSnapshot:[],manual:false,sceneOnly:true,phaseBatches:[],constructionContinue:true,
    worldCompletion:{mode:'local',focusLocationIds:[IDS.L2]},...extra};
}
const save=(repo,p)=>repo.confirmSaved({token:p.token,snapshotSha256:p.snapshotSha256,result:'saved'});
const progress=repo=>queryBound(repo.db,'SELECT * FROM construction_progress WHERE branch_id=? ORDER BY id',[BRANCH]);
const source=(text,hash)=>[{key:'hotfix-lore',kind:'lorebook',text,hash}];

test('HF01 two completed targets still consume 28k tail and save the tail fact',async()=>{
  const marker='TAIL_HOTFIX_FACT';const text='甲'.repeat(28000)+marker;
  const port=model(req=>{
    if(!req.batchId.startsWith('construction_'))return noop;
    return patch(req)+(req.messages[1].content.includes(marker)?'\n'+JSON.stringify({op:'location.upsert',ref:'new:tail_room',data:{name:'尾部大厅',kind:'room',parent_ref:IDS.L2}}):'');
  });
  const repo=await fixture(port);try{
    const extra={sourceSnapshot:source(text,'tail-v1')};
    const first=await repo.prepareTurn(input(repo,extra));await save(repo,first);
    let summary=summarizeSources(readProgressRows(createTableReadPort(repo.db),BRANCH),scopeKeyFor('local',[IDS.L2]));
    assert.equal(summary.totalChars,text.length);assert.equal(summary.processedChars,24000);
    assert.equal(progress(repo).filter(r=>r.kind==='target'&&r.status==='pending').length,0);
    const second=await repo.prepareTurn(input(repo,extra));await save(repo,second);
    assert.equal(construction(port).length,2);
    assert.ok(construction(port)[1].messages[1].content.includes(marker));
    const room=queryBound(repo.db,'SELECT * FROM locations WHERE name=?',['尾部大厅'])[0];
    assert.ok(room);assert.equal(room.parent_location_id,IDS.L2);
    summary=summarizeSources(readProgressRows(createTableReadPort(repo.db),BRANCH),scopeKeyFor('local',[IDS.L2]));
    assert.equal(summary.processedChars,text.length);
    assert.deepEqual(foreignKeyCheck(repo.db),[]);
    // The newly created room legitimately needs one structural pass of its own.
    await save(repo,await repo.prepareTurn(input(repo,extra)));
    const calls=construction(port).length;await save(repo,await repo.prepareTurn(input(repo,extra)));
    assert.equal(construction(port).length,calls,'after processing the new room, consumed sources do not cause repeated requests');
  }finally{await repo.close();}
});

test('HF02 source-only failed ACK leaves the tail for a later retry',async()=>{
  const port=model(req=>req.batchId.startsWith('construction_')?patch(req):noop);
  const repo=await fixture(port);try{
    const extra={sourceSnapshot:source('乙'.repeat(28100),'ack-v1')};
    await save(repo,await repo.prepareTurn(input(repo,extra)));
    const before=progress(repo);
    const p=await repo.prepareTurn(input(repo,extra));
    await repo.confirmSaved({token:p.token,snapshotSha256:p.snapshotSha256,result:'failed'});
    assert.deepEqual(progress(repo),before);
    await save(repo,await repo.prepareTurn(input(repo,extra)));
    const summary=summarizeSources(readProgressRows(createTableReadPort(repo.db),BRANCH),scopeKeyFor('local',[IDS.L2]));
    assert.equal(summary.processedChars,28100);
  }finally{await repo.close();}
});

test('HF03 new source hash is consumed after targets are processed; old hash stays in history',async()=>{
  const port=model(req=>req.batchId.startsWith('construction_')?patch(req):noop);
  const repo=await fixture(port);try{
    await save(repo,await repo.prepareTurn(input(repo,{sourceSnapshot:source('旧资料','old-hash')})));
    const before=construction(port).length;
    await save(repo,await repo.prepareTurn(input(repo,{sourceSnapshot:source('新资料','new-hash')})));
    assert.equal(construction(port).length,before+1);
    const rows=progress(repo).filter(r=>r.kind==='source');assert.equal(rows.length,2);
    const old=rows.find(r=>JSON.parse(r.payload_json).contentHash==='old-hash');
    assert.equal(JSON.parse(old.payload_json).enabled,false);
    const summary=summarizeSources(readProgressRows(createTableReadPort(repo.db),BRANCH),scopeKeyFor('local',[IDS.L2]));
    assert.equal(summary.enabledSources,1);assert.equal(summary.totalChars,3);assert.equal(summary.processedChars,3);
  }finally{await repo.close();}
});

test('HF04 actual map/build continue sends unsent source tail and skips observe',async()=>{
  const port=model(req=>req.batchId.startsWith('construction_')?patch(req):noop);
  const repo=await fixture(port);let session;try{
    session=await openSqlSession({chatUid:IDS.chatA,branchId:BRANCH,repository:repo,chatMetadata:{},saveSession:async()=>true,modelPort:port});
    const body={chatId:IDS.chatA,mode:'local',focusLocationIds:[IDS.L2],continue:true,loreSupplement:'丁'.repeat(28100)};
    await handleSqlMapAction(session,'map/build',{...body,requestId:'source-action-1'});
    const before=construction(port).length;assert.equal(before,1);
    const observe=port.calls.filter(req=>req.batchId.startsWith('observe_')).length;
    const result=await handleSqlMapAction(session,'map/build',{...body,requestId:'source-action-2'});
    assert.equal(result.coreSaved,true,JSON.stringify(result));
    assert.equal(construction(port).length,before+1);
    assert.equal(port.calls.filter(req=>req.batchId.startsWith('observe_')).length,observe);
    const idle=await handleSqlMapAction(session,'map/build',{...body,requestId:'source-action-3'});
    assert.equal(idle.status,'idle');
  }finally{if(session)await closeSqlSession(session);else await repo.close();}
});

const endpoints=()=>[
  {op:'location.upsert',ref:'new:point_a',data:{name:'补丁端点A',kind:'other',map_ref:'M1',position:{x:10,y:10,precision:'exact'}}},
  {op:'location.upsert',ref:'new:point_b',data:{name:'补丁端点B',kind:'other',map_ref:'M1',position:{x:20,y:20,precision:'exact'}}},
];
for(const order of ['first','last'])test(`HF05 ${order}: new endpoints and explicit geometric route survive actual groups and saved ACK`,async()=>{
  const repo=await fixture();try{
    const route={op:'route.propose',ref:'new:hotfix_route',data:{from_ref:'new:point_a',to_ref:'new:point_b',map_ref:'M1',geometry:{kind:'line',coordinates:[[10,10],[20,20]]}}};
    const ops=order==='first'?[route,...endpoints()]:[...endpoints(),route];
    const p=await repo.prepareTurn(input(repo,{manual:true,constructionContinue:false,worldCompletion:undefined,operations:ops}));
    await save(repo,p);
    const row=queryBound(repo.db,"SELECT * FROM routes WHERE geometry_json IS NOT NULL AND id NOT IN (?,?)",[IDS.R_AB,IDS.R_BC])[0];
    assert.ok(row,JSON.stringify(p.receipt));assert.equal(row.map_id,IDS.M1);
    assert.deepEqual(foreignKeyCheck(repo.db),[]);
  }finally{await repo.close();}
});

test('HF06 invalid newly declared endpoint blocks its dependent route without dangling writes',async()=>{
  const repo=await fixture();try{
    const ops=[{op:'route.propose',ref:'new:bad_dep_route',data:{from_ref:'new:point_a',to_ref:'new:point_b'}},...endpoints()];
    ops[2].data.kind='invalid-kind';
    await assert.rejects(repo.prepareTurn(input(repo,{manual:true,constructionContinue:false,worldCompletion:undefined,operations:ops})),error=>{
      assert.equal(error.code,'TURN_FAILED');
      assert.ok(error.detail.receipt.issues.some(i=>i.code==='DEPENDENCY_FAILED'),JSON.stringify(error.detail.receipt));
      return true;
    });
    assert.equal(queryBound(repo.db,"SELECT COUNT(*) n FROM routes WHERE id NOT IN (?,?)",[IDS.R_AB,IDS.R_BC])[0].n,0);
    assert.deepEqual(foreignKeyCheck(repo.db),[]);
  }finally{await repo.close();}
});

test('HF07 explicit topology-only route stays null through scene construction and rollback',async()=>{
  const repo=await fixture(null,db=>{
    const ids=['topology_a','topology_b'];insertRows(db,'entity_keys',ids.map(id=>({branch_id:BRANCH,id,kind:'location'})));
    insertRows(db,'locations',ids.map(id=>createRow('locations',{name:id,kind:'other',map_id:IDS.M1,grid_x:5,grid_y:6,coord_precision:'exact'},{branchId:BRANCH,id,turnId:IDS.seedTurn,clockS:0,nowWallMs:1,rulesetVersion:'atlas-1'})));
  });try{
    const p=await repo.prepareTurn(input(repo,{manual:true,constructionContinue:false,worldCompletion:undefined,sceneMaps:true,
      operations:[{op:'route.propose',ref:'new:topology_only',data:{from_ref:'topology_a',to_ref:'topology_b',map_ref:null}}]}));
    await save(repo,p);
    const row=queryBound(repo.db,'SELECT * FROM routes WHERE from_location_id=?',['topology_a'])[0];
    assert.ok(row);assert.equal(row.map_id,null);
    const copy=await repo.exportCurrent();const reopened=createSqlRepository({chatUid:IDS.chatA,branchId:BRANCH});
    await reopened.open({bytes:copy});assert.equal(queryBound(reopened.db,'SELECT map_id FROM routes WHERE id=?',[row.id])[0].map_id,null);await reopened.close();
    const rollback=await repo.prepareRollback({chatUid:IDS.chatA,branchId:BRANCH,targetParentTurnId:IDS.seedTurn,requestId:'hotfix-topology-rollback'});
    await save(repo,rollback);assert.equal(queryBound(repo.db,'SELECT COUNT(*) n FROM routes WHERE id=?',[row.id])[0].n,0);
  }finally{await repo.close();}
});

function assessmentSeed(db){
  const mapRow=createTableReadPort(db).selectOne('maps',BRANCH,IDS.M1);
  const locations=createTableReadPort(db).selectWhere('locations',{branch_id:BRANCH});
  const built=Kit.buildLayoutContext({scope:{chatId:IDS.chatA,branchId:BRANCH,revision:0,viewMode:'author'},mapRow,locations,characters:[],items:[],routes:[]});
  const generated=Kit.generateOverview({surface:'mixed',zones:[{id:IDS.L1,name:'城市',role:'land',size:'medium',sector:'center'},{id:IDS.L2,name:'学校',role:'land',size:'medium',sector:'east'}]},built.context);
  assert.equal(generated.ok,true,JSON.stringify(generated.issues));
  const frame={...mapRow.frame_json,atlasScene:generated.scene};
  db.run('UPDATE maps SET frame_json=? WHERE branch_id=? AND id=?',[JSON.stringify(frame),BRANCH,IDS.M1]);
  frame.atlasLayoutContext={version:3,hash:computeMapLayoutSignature(createTableReadPort(db),BRANCH,IDS.M1)};
  db.run('UPDATE maps SET frame_json=? WHERE branch_id=? AND id=?',[JSON.stringify(frame),BRANCH,IDS.M1]);
}
test('HF08 real scene DTO compares current structural hash and does not treat old unsigned scenes as aligned',async()=>{
  const seed=await makeSeedWith(SQL);try{
    assessmentSeed(seed.db);
    const ctx={db:seed.db,branchId:BRANCH,revision:0,viewMode:'author',povId:IDS.C1,chatId:IDS.chatA};
    const read=()=>querySpatialScene(ctx,{kind:'scene'}).items.find(i=>i.mapId===IDS.M1).assessment;
    assert.equal(read().matchesCurrentInputs,true);
    seed.db.run('UPDATE locations SET description=? WHERE branch_id=? AND id=?',['新增布局信息',BRANCH,IDS.L2]);
    assert.equal(read().matchesCurrentInputs,false);assert.ok(read().semanticIssues.some(i=>i.code==='MAP_INPUTS_CHANGED'));
    const frame=JSON.parse(queryBound(seed.db,'SELECT frame_json FROM maps WHERE id=?',[IDS.M1])[0].frame_json);
    delete frame.atlasLayoutContext;seed.db.run('UPDATE maps SET frame_json=? WHERE id=?',[JSON.stringify(frame),IDS.M1]);
    assert.equal(read().matchesCurrentInputs,false);assert.equal(read().semanticState,'unknown');
  }finally{seed.close();}
});

test('HF09 POV alignment remains unverified and does not expose secret hash changes',async()=>{
  const seed=await makeSeedWith(SQL);try{
    assessmentSeed(seed.db);
    const ctx={db:seed.db,branchId:BRANCH,revision:0,viewMode:'pov',povId:IDS.C1,chatId:IDS.chatA};
    const read=()=>querySpatialScene(ctx,{kind:'scene'}).items.find(i=>i.mapId===IDS.M1).assessment;
    const before=read();assert.equal(before.matchesCurrentInputs,false);
    seed.db.run('UPDATE locations SET description=? WHERE branch_id=? AND id=?',['秘密房间修改',BRANCH,IDS.L3]);
    assert.deepEqual(read(),before);
    assert.ok(!JSON.stringify(read()).includes('秘密房间修改'));
  }finally{seed.close();}
});
