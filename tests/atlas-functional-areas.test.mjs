import test from 'node:test';
import assert from 'node:assert/strict';
import * as Kit from '../vendor/atlas-spatial/index.mjs';
import {makeSeed,IDS} from './fixtures/atlas-sql/seed.mjs';
import {createTableReadPort,pageAllRows} from '../src/atlas-db-readport.ts';
import {runBound,queryBound} from '../src/atlas-db-runtime.ts';
import {applyGroups} from '../src/atlas-db-commit.ts';
import {planFunctionalAreaProjections} from '../src/atlas-functional-areas.ts';
import {computeMapLayoutSignature} from '../src/atlas-sql-layout-task.ts';
import {settleWorldBuildWindow,worldBuildMapReady,currentBuildJob} from '../src/atlas-world-build-execution.ts';
import {createSqlRepository} from '../src/atlas-db-repository.ts';
import {referenceGeometry} from '../ui/atlas-reference-data.mjs';
import {reconcileOccupantsSpec} from '../src/atlas-spatial-occupants.ts';

async function fixture(){
 const seed=await makeSeed(),{db,branchId}=seed;
 const port=createTableReadPort(db),map=port.selectOne('maps',branchId,IDS.M2),parent=port.selectOne('locations',branchId,IDS.L3);
 runBound(db,'INSERT INTO entity_keys (branch_id,id,kind) VALUES (?,?,?)',[branchId,'area','location']);
 const member={...parent,id:'area',name:'匿名功能区',kind:'other',map_id:IDS.M2,parent_location_id:IDS.L3,grid_x:null,grid_y:null,coord_precision:'unknown',area_geometry_json:null};
 runBound(db,`INSERT INTO locations (${Object.keys(member).join(',')}) VALUES (${Object.keys(member).map(()=>'?').join(',')})`,Object.values(member).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v));
 const scope={chatId:seed.chatUid,branchId,revision:0,viewMode:'author'};
 const built=Kit.buildLayoutContext({scope,mapRow:map,maps:pageAllRows(port,'maps',branchId),locations:pageAllRows(port,'locations',branchId),routes:[]});
 const result=Kit.generateFloor({rooms:[{id:IDS.L3,w:6,h:4,side:'north'}],contents:[{id:'stable-table',name:'匿名桌',type:'table',roomId:IDS.L3,w:1,h:.6}]},{...built.context,currentScope:scope});
 assert.equal(result.ok,true,JSON.stringify(result.issues));
 const frame={...map.frame_json,atlasScene:result.scene};
 runBound(db,'UPDATE maps SET frame_json=? WHERE branch_id=? AND id=?',[JSON.stringify(frame),branchId,IDS.M2]);
 frame.atlasLayoutContext={version:3,hash:computeMapLayoutSignature(createTableReadPort(db),branchId,IDS.M2),completedTurnId:seed.seedTurnId};
 runBound(db,'UPDATE maps SET frame_json=? WHERE branch_id=? AND id=?',[JSON.stringify(frame),branchId,IDS.M2]);
 const plan=(requireCurrentInputs=true)=>planFunctionalAreaProjections({tables:createTableReadPort(db),branchId,turnId:seed.seedTurnId,mapIds:[IDS.M2],requireCurrentInputs});
 const apply=groups=>applyGroups(db,groups,{branchId,turnId:seed.seedTurnId,attemptId:'functional-area-test',validate:true});
 return {...seed,frame,scope,plan,apply};
}

test('FA01 real SQL functional projection preserves physical geometry and exposes a selectable open region',async()=>{
 const f=await fixture();try{
  assert.equal(worldBuildMapReady(f.db,f.branchId,IDS.M2),false);
  const before=structuredClone(f.frame.atlasScene.layout),planned=f.plan();
  assert.deepEqual(planned.issues,[]);assert.equal(planned.groups.length,1);
  assert.equal(JSON.parse(queryBound(f.db,'SELECT frame_json FROM maps WHERE id=? AND branch_id=?',[IDS.M2,f.branchId])[0].frame_json).atlasScene.layout.areas,undefined);
  const applied=f.apply(planned.groups);assert.equal(applied.groups[0].status,'applied',JSON.stringify(applied));
  const map=createTableReadPort(f.db).selectOne('maps',f.branchId,IDS.M2),scene=map.frame_json.atlasScene,layout=scene.layout;
  for(const key of ['bounds','rooms','groups','bodies','doors','windows','actors','items'])assert.deepEqual(layout[key],before[key],key+' must remain unchanged');
  assert.equal(layout.areas.length,1);assert.equal(layout.areas[0].id,'area');assert.equal(layout.areas[0].quality,'estimated');
  assert.equal(worldBuildMapReady(f.db,f.branchId,IDS.M2),true);
  assert.equal(createTableReadPort(f.db).selectOne('locations',f.branchId,'area').kind,'other');
  assert.deepEqual(f.plan().groups,[],'a repeated projection performs no writes');
  const view=referenceGeometry({mapId:IDS.M2,kind:'interior',containerLocationKind:'room',containerLocationId:IDS.L3,name:'匿名房间',points:[],metersPerCell:1},scene);
  assert.equal(view.geo.hostArea.id,IDS.L3);assert.equal(view.geo.rooms.find(r=>r.id==='area').status,'功能分区 · 估计');
  assert.ok(view.marks.some(mark=>mark.id==='area'));
 }finally{f.close();}
});

test('FA02 hidden regions and their names never cross the POV boundary; invalid versions fail decoding',async()=>{
 const f=await fixture();try{
  f.apply(f.plan().groups);
  const scene=createTableReadPort(f.db).selectOne('maps',f.branchId,IDS.M2).frame_json.atlasScene;
  const filtered=Kit.filterSceneForView(scene,{scope:{...f.scope,viewMode:'pov'},visibleLocations:[IDS.L3],visibleCharacters:[],visibleItems:[]});
  assert.equal(filtered.ok,true);assert.deepEqual(filtered.scene.layout.areas,[]);
  assert.equal(JSON.stringify(filtered.scene).includes('匿名功能区'),false);
  const invalid=structuredClone(scene);invalid.layout.areas[0].version=2;
  assert.ok(Kit.checkSceneDocument(invalid).some(issue=>issue.path.startsWith('$.layout.areas')));
 }finally{f.close();}
});

test('FA03 confirmed physical size is never shrunk to force a functional region into its host',async()=>{
 const f=await fixture();try{
  runBound(f.db,'UPDATE locations SET area_geometry_json=? WHERE id=? AND branch_id=?',[JSON.stringify({kind:'dimensions',widthM:30,heightM:20,quality:'confirmed',source:'story'}),'area',f.branchId]);
  const plan=f.plan(false);assert.deepEqual(plan.groups,[]);assert.equal(plan.issues[0].code,'FUNCTIONAL_AREA_GEOMETRY_CONFLICT');
  assert.deepEqual(createTableReadPort(f.db).selectOne('maps',f.branchId,IDS.M2).frame_json,f.frame);
 }finally{f.close();}
});

test('FA08 a known region larger than an estimated strip keeps its real size when it fits the room',async()=>{
 const f=await fixture();try{
  const dimensions={kind:'dimensions',widthM:4,heightM:2,quality:'confirmed',source:'story'};
  runBound(f.db,'UPDATE locations SET area_geometry_json=? WHERE id=? AND branch_id=?',[JSON.stringify(dimensions),'area',f.branchId]);
  const plan=f.plan(false);assert.deepEqual(plan.issues,[]);f.apply(plan.groups);
  const area=createTableReadPort(f.db).selectOne('maps',f.branchId,IDS.M2).frame_json.atlasScene.layout.areas[0];
  const host=f.frame.atlasScene.layout.rooms[0];
  assert.deepEqual([area.x,area.y,area.w,area.h],[host.x+2,host.y,4,2]);assert.equal(area.quality,'estimated');
  assert.deepEqual(createTableReadPort(f.db).selectOne('locations',f.branchId,'area').area_geometry_json,dimensions);
 }finally{f.close();}
});

test('FA07 an authored outdoor profile takes precedence over an old functional region',async()=>{
 const f=await fixture();try{
  f.apply(f.plan().groups);
  const map={...createTableReadPort(f.db).selectOne('maps',f.branchId,IDS.M2),id:'area-map',container_location_id:'area',frame_json:JSON.stringify({cols:6,rows:4,atlasSpatialProfile:{version:1,mode:'outdoor',basis:'author'}})};
  runBound(f.db,`INSERT INTO maps (${Object.keys(map).join(',')}) VALUES (${Object.keys(map).map(()=>'?').join(',')})`,Object.values(map).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v));
  assert.equal(worldBuildMapReady(f.db,f.branchId,IDS.M2),false);
  assert.deepEqual(f.plan().groups,[],'an outdoor place is never reprojected as an interior functional region');
  assert.equal(createTableReadPort(f.db).selectOne('maps',f.branchId,'area-map').frame_json.atlasSpatialProfile.mode,'outdoor');
 }finally{f.close();}
});

test('FA04 occupants retain their SQL subarea identity while sharing the actual room floor',()=>{
 const result=reconcileOccupantsSpec({scene:null,container:{id:'room',kind:'room'},functionalAreas:[{id:'area',parent_location_id:'room'}],
  requestSpec:{rooms:[{id:'room'}],contents:[],actors:[{id:'person',roomId:'area'}]},characters:[{id:'person',status:'active',location_id:'area'}],
  items:[{id:'item',name:'匿名物品',status:'active',location_id:'area',holder_character_id:null,container_item_id:null}]});
 assert.deepEqual(result.spec.actors,[{id:'person',roomId:'room'}]);
 assert.equal(result.looseItemMarkers[0].roomId,'room');
 assert.equal(result.issues.some(issue=>issue.code==='ACTOR_LOCATION_MISMATCH'||issue.code==='ITEM_LOCATION_MISMATCH'),false);
});

test('FA05 real construction retry sends zero model requests, publishes only after ACK and rolls back its regions',async()=>{
 const f=await fixture();let calls=0;const requests=[];
 const job={version:1,id:'area-job',branchId:f.branchId,kind:'entry',status:'running',sourceManifestHash:'area-source',policyVersion:'world-build-v2',originFloorId:f.seedTurnId,runEpoch:0,nextWindowSequence:1,committedWindowSequence:0,cumulativeTransports:0,cumulativeWindows:0,stopReason:null};
 const target={version:1,id:'area-target',jobId:job.id,subjectId:IDS.M2,workKind:'map-layout',requirement:'source-required',depth:0,dependencyIds:[],inputSignature:'area-input',status:'pending',attempts:0,failureFingerprint:null,lastErrorCode:null,originFloorId:f.seedTurnId,eventId:null};
 const anchor={chatUid:f.chatUid,branchId:f.branchId,parentTurnId:f.seedTurnId,hostMessageUid:'area-retry',variantKey:'test',inputHash:'area-retry',baseRevision:0,baseStorageRevision:0};
 const input={anchor,userText:'',assistantText:'',sourceSnapshot:[],phaseBatches:[],manual:false,narrativeKind:'manual',sceneOnly:true,constructionContinue:true,worldBuild:{action:'next-window',jobId:job.id,expectedEpoch:0}};
 const seeded=settleWorldBuildWindow({db:f.db,input,turnId:f.seedTurnId,makeId:()=>{throw Error('no entity creation');}},
  {job,targets:[target],selected:[],input,groups:[],operations:[],records:[],issues:[],window:false,beforeProgress:'seed',pendingLocalTargets:new Set()},0,[]);
 f.apply(seeded.groups);
 const repo=createSqlRepository({chatUid:f.chatUid,branchId:f.branchId,modelPort:{request:async request=>{calls++;requests.push({phase:request.phase,batch:request.batchId});throw Error('functional repair must not call the model');}}});
 await repo.open({bytes:f.exportBytes()});f.close();
 try{
  const prepared=await repo.prepareTurn(input);
  assert.equal(calls,0,JSON.stringify({requests,issues:prepared.receipt.issues}));assert.equal(JSON.parse(queryBound(repo.db,'SELECT frame_json FROM maps WHERE branch_id=? AND id=?',[f.branchId,IDS.M2])[0].frame_json).atlasScene.layout.areas,undefined);
  await repo.confirmSaved({token:prepared.token,snapshotSha256:prepared.snapshotSha256,result:'saved'});
  assert.equal(currentBuildJob(repo.db,f.branchId).status,'completed');
  assert.equal(worldBuildMapReady(repo.db,f.branchId,IDS.M2),true);
  const rollback=await repo.prepareRollback({chatUid:f.chatUid,branchId:f.branchId,targetParentTurnId:f.seedTurnId,expectedRevision:repo.internal.currentRevision()});
  await repo.confirmSaved({token:rollback.token,snapshotSha256:rollback.snapshotSha256,result:'saved'});
  assert.equal(JSON.parse(queryBound(repo.db,'SELECT frame_json FROM maps WHERE branch_id=? AND id=?',[f.branchId,IDS.M2])[0].frame_json).atlasScene.layout.areas,undefined);
  assert.equal(createTableReadPort(repo.db).selectOne('locations',f.branchId,'area').coord_precision,'unknown');
 }finally{await repo.close();}
});

test('FA06 a newly generated floor receives functional regions through the same repository transaction',async()=>{
 const f=await fixture();
 runBound(f.db,'UPDATE maps SET frame_json=? WHERE branch_id=? AND id=?',[JSON.stringify({cols:6,rows:4}),f.branchId,IDS.M2]);
 const repo=createSqlRepository({chatUid:f.chatUid,branchId:f.branchId});await repo.open({bytes:f.exportBytes()});f.close();
 try{
  const prepared=await repo.prepareTurn({anchor:{chatUid:f.chatUid,branchId:f.branchId,parentTurnId:f.seedTurnId,hostMessageUid:'new-floor',variantKey:'test',inputHash:'new-floor',baseRevision:0,baseStorageRevision:0},
   userText:'',assistantText:'',manual:true,sceneOnly:true,sourceSnapshot:[],phaseBatches:[],operations:[{op:'map.layout.request',ref:IDS.M2,data:{kind:'floor',spec:{rooms:[{id:IDS.L3,w:6,h:4,side:'north'}],contents:[{id:'new-table',roomId:IDS.L3,type:'table',w:1,h:.6}]}}}]});
  assert.equal(prepared.receipt.issues.some(issue=>issue.severity==='error'),false,JSON.stringify(prepared.receipt.issues));
  await repo.confirmSaved({token:prepared.token,snapshotSha256:prepared.snapshotSha256,result:'saved'});
  const frame=createTableReadPort(repo.db).selectOne('maps',f.branchId,IDS.M2).frame_json;
  assert.equal(frame.atlasScene.layout.areas[0].id,'area');assert.equal(frame.atlasScene.layout.areas[0].roomId,IDS.L3);
  assert.equal(frame.atlasScene.layout.groups[0].id,`space:${IDS.L3}:furn:new-table`);assert.equal(worldBuildMapReady(repo.db,f.branchId,IDS.M2),true);
 }finally{await repo.close();}
});
