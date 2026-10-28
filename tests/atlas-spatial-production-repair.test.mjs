import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { makeSeedWith, IDS } from './fixtures/atlas-sql/seed.mjs';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { readSceneContradictions } from '../src/atlas-scene-contradiction-read.ts';
import { readActorSceneFacts } from '../src/atlas-scene-facts.ts';
import { readConfirmedSceneEntries } from '../src/atlas-scene-entry-sql.ts';
import { createTableReadPort } from '../src/atlas-db-readport.ts';
import { compileOperations } from '../src/atlas-ops-compile.ts';
import { parseOperations } from '../src/atlas-ops-parser.ts';
import { buildAtomicGroups, orderGroups } from '../src/atlas-ops-groups.ts';
import { applyGroups } from '../src/atlas-db-commit.ts';

const SQL=await initSqlJs();
const canonical={version:1,locationId:IDS.L3,revision:1,size:{widthM:10,heightM:10},furnishing:[
  {localId:`space:${IDS.L3}:furn:G1`,type:'glass',name:'匿名玻璃隔断',itemId:null,widthM:1,heightM:4,quality:'confirmed'},
  {localId:`space:${IDS.L3}:furn:F1`,type:'chair',name:'匿名座椅',itemId:null,widthM:1,heightM:1,quality:'confirmed'},
]};
async function seedFixture(){
  const seed=await makeSeedWith(SQL);
  const frame={atlasSpaceCanonical:canonical,atlasScene:{kind:'atlas-scene',version:1,mapId:IDS.M2,units:'meters',layout:{kind:'floor',furniture:[
    {id:`space:${IDS.L3}:furn:G1`,roomId:IDS.L3,x:3,y:0,w:1,h:4},
  ]}}};
  seed.db.run('UPDATE maps SET frame_json=? WHERE branch_id=? AND id=?',[JSON.stringify(frame),IDS.branchMain,IDS.M2]);
  seed.db.run("UPDATE characters SET location_id=?,map_id=?,grid_x=1,grid_y=2,coord_precision='exact' WHERE branch_id=? AND id=?",[IDS.L3,IDS.M2,IDS.branchMain,IDS.C1]);
  return seed;
}
function turnInput(repo,operations,id){return{anchor:{chatUid:IDS.chatA,branchId:IDS.branchMain,parentTurnId:repo.internal.currentHeadTurnId(),hostMessageUid:id,variantKey:'repair-test',inputHash:id,
  baseRevision:repo.internal.currentRevision(),baseStorageRevision:repo.storageRevision},userText:'',assistantText:'',manual:true,sceneOnly:true,sourceSnapshot:[],phaseBatches:[],operations};}
const save=(repo,prepared)=>repo.confirmSaved({token:prepared.token,snapshotSha256:prepared.snapshotSha256,result:'saved'});

test('T-S20 real candidate movement through saved glass journals a contradiction, exposes a constraint and rolls back with its floor',async()=>{
  const seed=await seedFixture(),repo=createSqlRepository({chatUid:IDS.chatA,branchId:IDS.branchMain});
  await repo.open({bytes:seed.exportBytes()});seed.close();
  try{
    const prepared=await repo.prepareTurn(turnInput(repo,[{op:'character.upsert',ref:IDS.C1,data:{map_ref:IDS.M2,position:{x:5,y:2,precision:'exact'}}}],'glass-cross'));
    assert.equal(readSceneContradictions(repo.db,IDS.branchMain).length,0,'candidate findings are unpublished before ACK');
    await save(repo,prepared);
    const findings=readSceneContradictions(repo.db,IDS.branchMain);
    assert.equal(findings.length,1);assert.equal(findings[0].code,'GLASS_WALKED_THROUGH');
    const context=readActorSceneFacts({db:repo.db,branchId:IDS.branchMain},{actorId:IDS.C1,locationId:IDS.L3,position:null}).context;
    assert.ok(context.constraints.some(entry=>entry.code==='GLASS_WALKED_THROUGH'));
    const rolled=await repo.prepareRollback({chatUid:IDS.chatA,branchId:IDS.branchMain,targetParentTurnId:IDS.seedTurn,expectedRevision:repo.internal.currentRevision()});
    await save(repo,rolled);
    assert.equal(readSceneContradictions(repo.db,IDS.branchMain).length,0);
    assert.equal(queryBound(repo.db,'SELECT grid_x FROM characters WHERE branch_id=? AND id=?',[IDS.branchMain,IDS.C1])[0].grid_x,1);
  }finally{await repo.close();}
});

test('T-S01 only a committed location change plus an occurred arrival activates a real interior',async()=>{
  const seed=await seedFixture(),repo=createSqlRepository({chatUid:IDS.chatA,branchId:IDS.branchMain});
  seed.db.run('UPDATE characters SET location_id=?,map_id=NULL,grid_x=NULL,grid_y=NULL WHERE branch_id=? AND id=?',[IDS.L2,IDS.branchMain,IDS.C1]);
  await repo.open({bytes:seed.exportBytes()});seed.close();
  try{
    const operations=[{op:'character.upsert',ref:IDS.C1,data:{location_ref:IDS.L3}},
      {op:'event.propose',data:{title:'匿名抵达',kind:'arrival',phase:'observed',actor_ref:IDS.C1,location_ref:IDS.L3,time_hint:{elapsed_s:0}}}];
    const prepared=await repo.prepareTurn(turnInput(repo,operations,'entry-confirmed'));
    assert.equal(readConfirmedSceneEntries(repo.db,IDS.branchMain).length,0);
    await save(repo,prepared);
    const entries=readConfirmedSceneEntries(repo.db,IDS.branchMain);
    assert.equal(entries.length,1);assert.equal(entries[0].toLocationId,IDS.L3);assert.equal(entries[0].interiorMapId,IDS.M2);
    const same=await repo.prepareTurn(turnInput(repo,[{op:'character.upsert',ref:IDS.C1,data:{map_ref:IDS.M2,position:{x:2,y:2,precision:'exact'}}}],'precision-only'));
    await save(repo,same);assert.equal(readConfirmedSceneEntries(repo.db,IDS.branchMain).length,1);
  }finally{await repo.close();}
});

function compile(seed,phase='observed'){
  const value={op:'event.propose',data:{title:'匿名搬动',phase,actor_ref:IDS.C1,location_ref:IDS.L3,time_hint:{elapsed_s:0},effects:[
    {type:'furnishing_move',location_ref:IDS.L3,furnishing_ref:'F1',to:{holder_ref:IDS.C1}},
  ]}};
  const parsed=parseOperations(JSON.stringify(value),{phase:'observe'});
  return compileOperations({operations:parsed.operations,anchor:{chatUid:IDS.chatA,branchId:IDS.branchMain,parentTurnId:IDS.seedTurn,hostMessageUid:'promotion',variantKey:'test',inputHash:'test',baseRevision:0,baseStorageRevision:0},
    phase:'observe',clockS:0,revision:0,tables:createTableReadPort(seed.db),sources:{phase:'observe',snapshot:[],clockS:0},knownRefs:seed.refs,turnId:IDS.seedTurn});
}
test('T-O04 accepted furnishing move compiles, binds and transfers the same item atomically; repetition reuses its identity',async()=>{
  const seed=await seedFixture();
  try{
    const first=compile(seed),errors=first.issues.filter(issue=>issue.severity==='error');
    assert.deepEqual(errors,[]);
    const groups=buildAtomicGroups(first.results.map(entry=>({opId:entry.opId,...entry.result})));
    const applied=applyGroups(seed.db,orderGroups(groups.groups).order,{branchId:IDS.branchMain,turnId:IDS.seedTurn,attemptId:'furnishing-effect',validate:true});
    assert.equal(applied.groups.some(group=>group.status==='rejected'||group.status==='blocked'),false,JSON.stringify(applied));
    const items=queryBound(seed.db,"SELECT * FROM items WHERE branch_id=? AND holder_character_id=? AND properties_json LIKE '%fromFurnishing%'",[IDS.branchMain,IDS.C1]);
    assert.equal(items.length,1);
    const frame=JSON.parse(queryBound(seed.db,'SELECT frame_json FROM maps WHERE branch_id=? AND id=?',[IDS.branchMain,IDS.M2])[0].frame_json);
    assert.equal(frame.atlasSpaceCanonical.furnishing.find(piece=>piece.localId.endsWith(':F1')).itemId,items[0].id);
    const repeated=compile(seed);
    assert.deepEqual(repeated.issues.filter(issue=>issue.severity==='error'),[]);
    assert.equal(repeated.results.flatMap(entry=>entry.result.mutations).find(mutation=>mutation.table==='items').rowId,items[0].id);
  }finally{seed.close();}
});
test('T-O04 scheduled furnishing intentions never apply current item effects',async()=>{
  const seed=await seedFixture();try{
    const output=compile(seed,'scheduled');
    assert.ok(output.issues.some(issue=>issue.code==='SCHEDULED_EFFECTS_NOT_EFFECTIVE'&&issue.severity==='error'));
    assert.equal(output.results.flatMap(entry=>entry.result.mutations).some(mutation=>mutation.table==='items'),false);
  }finally{seed.close();}
});
