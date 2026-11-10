import test from 'node:test';
import assert from 'node:assert/strict';
import * as Kit from '../vendor/atlas-spatial/index.mjs';
import {makeSeed, IDS} from './fixtures/atlas-sql/seed.mjs';
import {queryBound,runBound} from '../src/atlas-db-runtime.ts';
import {createTableReadPort,pageAllRows} from '../src/atlas-db-readport.ts';
import {applyGroups} from '../src/atlas-db-commit.ts';
import {computeMapLayoutSignature,deriveLayoutSites} from '../src/atlas-sql-layout-task.ts';
import {groupTurnTransportTotals} from '../src/atlas-turn-analysis-groups.ts';
import {readWorldBuildTurnLink} from '../src/atlas-world-build-ledger.ts';
import {buildTurnAnalysisExport} from '../ui/atlas-turn-analysis-export.mjs';
import {settleWorldBuildWindow,worldBuildMapReady,worldBuildMapQuality} from '../src/atlas-world-build-execution.ts';
import {readProgressRows} from '../src/atlas-construction-progress.ts';
import {readWorldBuildTargets} from '../src/atlas-world-build-state.ts';
import {createRow} from '../src/atlas-db-defaults.ts';

async function fixture() {
 const seed=await makeSeed(),{db,branchId}=seed,port=createTableReadPort(db);
 const map=port.selectOne('maps',branchId,IDS.M2),scope={chatId:seed.chatUid,branchId,revision:1,viewMode:'author'};
 const built=Kit.buildLayoutContext({scope,mapRow:map,maps:pageAllRows(port,'maps',branchId),locations:pageAllRows(port,'locations',branchId),routes:[]});
 assert.equal(built.ok,true,JSON.stringify(built.issues));
 const scene=Kit.generateFloor({rooms:[{id:map.container_location_id,w:6,h:4,side:'north'}],contents:[]},{...built.context,currentScope:scope});
 assert.equal(scene.ok,true,JSON.stringify(scene.issues));
 const frame={...map.frame_json,atlasScene:scene.scene};
 runBound(db,'UPDATE maps SET frame_json=? WHERE branch_id=? AND id=?',[JSON.stringify(frame),branchId,IDS.M2]);
 frame.atlasLayoutContext={version:3,hash:computeMapLayoutSignature(createTableReadPort(db),branchId,IDS.M2),completedTurnId:seed.seedTurnId};
 runBound(db,'UPDATE maps SET frame_json=? WHERE branch_id=? AND id=?',[JSON.stringify(frame),branchId,IDS.M2]);
 const job={version:1,id:'formal-repair-job',branchId,kind:'entry',status:'running',sourceManifestHash:'fixture',policyVersion:'world-build-v2',originFloorId:seed.seedTurnId,runEpoch:0,nextWindowSequence:1,committedWindowSequence:0,cumulativeTransports:0,cumulativeWindows:0,stopReason:null};
 const target=(id,status='pending')=>({version:1,id:'layout:'+id,jobId:job.id,subjectId:id,workKind:'map-layout',requirement:'source-required',depth:0,dependencyIds:[],inputSignature:'fixture:'+id,status,attempts:status==='failed'?1:0,failureFingerprint:null,lastErrorCode:null,originFloorId:seed.seedTurnId,eventId:null});
 const input={anchor:{chatUid:seed.chatUid,branchId,parentTurnId:seed.seedTurnId,hostMessageUid:'formal',variantKey:'v',baseRevision:1,baseStorageRevision:1,inputHash:'formal'},worldBuild:{action:'next-window',jobId:job.id},userText:'',assistantText:'',sourceSnapshot:[],phaseBatches:[]};
 const settle=(targets,selected,issues=[])=>{
  const result=settleWorldBuildWindow({db,input,turnId:seed.seedTurnId,makeId:()=>{throw Error('no business IDs expected');}},{job,targets,selected,input,groups:[],operations:[],records:[],issues:[],window:true,beforeProgress:'fixture',pendingLocalTargets:new Set()},0,issues);
  const applied=applyGroups(db,result.groups,{branchId,turnId:seed.seedTurnId,attemptId:'formal-settle',validate:true});
  assert.equal(applied.groups.every(g=>g.status==='applied'),true,JSON.stringify(applied));
  return readWorldBuildTargets(readProgressRows(createTableReadPort(db),branchId),job.id).values;
 };
 return {...seed,frame,target,settle};
}

test('C15/T-J05 a failed map cannot fail a separately saved, current valid map',async()=>{
 const f=await fixture();try{
  assert.equal(worldBuildMapReady(f.db,f.branchId,IDS.M2),true,JSON.stringify({quality:worldBuildMapQuality(f.db,f.branchId,IDS.M2),saved:f.frame.atlasLayoutContext.hash,current:computeMapLayoutSignature(createTableReadPort(f.db),f.branchId,IDS.M2)}));
  const good=f.target(IDS.M2),bad=f.target(IDS.M1);
  const targets=f.settle([good,bad],[good,bad],[{code:'ROOM_CONNECTION_NO_SPACE',path:'$.maps.'+IDS.M1,message:'invalid fixture map',severity:'error',retryable:true}]);
  assert.equal(targets.find(t=>t.subjectId===IDS.M2).status,'done');
  assert.equal(targets.find(t=>t.subjectId===IDS.M1).status,'failed');
  assert.equal(targets.find(t=>t.subjectId===IDS.M1).lastErrorCode,'ROOM_CONNECTION_NO_SPACE');
 }finally{f.close();}
});

test('C15 completed geometry is reconciled even when a later window selected another target',async()=>{
 const f=await fixture();try{
  const good=f.target(IDS.M2,'failed'),bad=f.target(IDS.M1);
  const targets=f.settle([good,bad],[bad]);
  assert.equal(targets.find(t=>t.subjectId===IDS.M2).status,'done');
 }finally{f.close();}
});

test('城市完成判定使用实际开放场所标点及已存路线，不要求停靠船成为固定建筑',async()=>{
 const f=await fixture();try{
  const context=id=>({branchId:f.branchId,id,turnId:f.seedTurnId,clockS:0,nowWallMs:1,rulesetVersion:'atlas-1'});
  const insert=(table,id,kind,data)=>{
   if(['location','character','item','faction'].includes(kind))runBound(f.db,'INSERT INTO entity_keys (branch_id,id,kind) VALUES (?,?,?)',[f.branchId,id,kind]);
   const row=createRow(table,data,context(id));
   runBound(f.db,`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`,Object.values(row).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v));return row;
  };
  const id='quality-port',scope={chatId:f.chatUid,branchId:f.branchId,revision:1,viewMode:'author'};
  const generated=Kit.generateCity({riverWidth:0,enclosure:'open',districts:[{id:'port',bank:'west',order:0}],buildings:[{id:'office',districtId:'port',w:12,h:8}]},{scope,map:{id,metersPerCell:1,frame:{cols:500,rows:300}},entities:{locations:['port','office','pier'],routes:[],characters:[],items:[]}});
  assert.equal(generated.ok,true,JSON.stringify(generated.issues));
  const building=generated.scene.layout.buildings[0],point=[building.x+building.w/2,building.y+building.h/2];
  insert('locations','port','location',{name:'测试港区',kind:'district'});
  insert('maps',id,'map',{name:'测试港区',kind:'site',container_location_id:'port',meters_per_cell:1,scale_quality:'estimated',frame_json:{cols:500,rows:300,atlasScene:generated.scene}});
  insert('locations','office','location',{name:'邮局',kind:'building',parent_location_id:'port',map_id:id,grid_x:point[0],grid_y:point[1],coord_precision:'layout'});
  insert('locations','pier','location',{name:'开放码头',kind:'other',parent_location_id:'port',map_id:id,grid_x:20,grid_y:10,coord_precision:'layout'});
  insert('locations','boat','location',{name:'停靠小艇',kind:'vehicle',mobility:'mobile',anchor_location_id:'pier',parent_location_id:'port',map_id:id});
  insert('routes','port-route','route',{from_location_id:'office',to_location_id:'pier',map_id:id,geometry_quality:'estimated',geometry_json:{kind:'line',coordinates:[point,[20,10]]}});
  const q=()=>worldBuildMapQuality(f.db,f.branchId,id);
  assert.equal(q().dimensions.coverage,'pass',JSON.stringify(q()));
  assert.equal(q().dimensions.navigability,'pass',JSON.stringify(q()));
  assert.equal(q().dimensions.plausibility,'pass',JSON.stringify(q()));
  runBound(f.db,'UPDATE routes SET geometry_json=? WHERE branch_id=? AND id=?',[JSON.stringify({kind:'line',coordinates:[[null,0]]}),f.branchId,'port-route']);
  assert.equal(q().dimensions.navigability,'fail','坏路线不能靠有码头标点通过');
  runBound(f.db,"UPDATE locations SET coord_precision='unknown' WHERE branch_id=? AND id=?",[f.branchId,'pier']);
  assert.notEqual(q().dimensions.coverage,'pass','没有真实落位时仍不能判为完整');
 }finally{f.close();}
});

test('C15 an authored outdoor member remains unsupported by an interior template',async()=>{
 const f=await fixture();try{
  const row={...createTableReadPort(f.db).selectOne('locations',f.branchId,IDS.L3),id:'functional-area',kind:'other',parent_location_id:IDS.L3,map_id:IDS.M2,area_geometry_json:null};
  runBound(f.db,'INSERT INTO entity_keys (branch_id,id,kind) VALUES (?,?,?)',[f.branchId,row.id,'location']);
  runBound(f.db,`INSERT INTO locations (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`,Object.values(row).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v));
  const map={...createTableReadPort(f.db).selectOne('maps',f.branchId,IDS.M2),id:'outdoor-area-map',container_location_id:row.id,frame_json:JSON.stringify({cols:10,rows:10,atlasSpatialProfile:{version:1,mode:'outdoor',basis:'author'}})};
  runBound(f.db,`INSERT INTO maps (${Object.keys(map).join(',')}) VALUES (${Object.keys(map).map(()=>'?').join(',')})`,Object.values(map).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v));
  const target=f.target(IDS.M2),saved=f.settle([target],[target]);
  assert.equal(saved[0].status,'failed');assert.equal(saved[0].lastErrorCode,'SPATIAL_PROFILE_MEMBER_UNSUPPORTED');
  assert.equal(createTableReadPort(f.db).selectOne('locations',f.branchId,row.id).kind,'other');
 }finally{f.close();}
});

test('C15 an old picture never clears a changed structure or a failed pending request',async()=>{
 const f=await fixture();try{
  f.frame.atlasLayoutContext.hash='stale';
  runBound(f.db,'UPDATE maps SET frame_json=? WHERE branch_id=? AND id=?',[JSON.stringify(f.frame),f.branchId,IDS.M2]);
  assert.equal(worldBuildMapReady(f.db,f.branchId,IDS.M2),false);
  f.frame.atlasLayoutContext.hash=computeMapLayoutSignature(createTableReadPort(f.db),f.branchId,IDS.M2);
  f.frame.atlasLayoutRequest={status:'failed'};
  runBound(f.db,'UPDATE maps SET frame_json=? WHERE branch_id=? AND id=?',[JSON.stringify(f.frame),f.branchId,IDS.M2]);
  assert.equal(worldBuildMapReady(f.db,f.branchId,IDS.M2),false);
 }finally{f.close();}
});

test('C15 window sequence is scoped to its job and legacy identity is read without guessing',()=>{
 const row={countSource:'transport-journal',calls:[{requestRef:'request',transportAttempt:1}],recordedModelTransports:1,floorRef:'floor',windowSequence:1};
 const grouped=groupTurnTransportTotals([{...row,jobRef:'job-a'},{...row,jobRef:'job-b'}]);
 assert.equal(grouped.byWindow.length,2);assert.equal(grouped.overall.transports,1);
 assert.equal(readWorldBuildTurnLink({world_build:{jobId:'a',window:true,windowSequence:4}}).windowSequence,4);
 assert.equal(readWorldBuildTurnLink({world_build:{version:9,jobId:'a',window:true,windowSequence:4}}),null);
 assert.equal(readWorldBuildTurnLink({world_build:{jobId:'a',window:false,windowSequence:4}}).windowSequence,null);
});

test('C15 paginated export recomputes shared transport keys and retains separate job windows',()=>{
 const row=(id,jobRef)=>({id,turnRef:id,floorRef:'floor',countSource:'transport-journal',recordedModelTransports:1,
  requestAudit:{version:1,transports:1,droppedCalls:0,calls:[{requestRef:'shared',transportAttempt:1}]},buildLinkage:{jobRef,windowSequence:1}});
 const page={transport:{transports:1,transportsLowerBound:1,turnsWithoutCompleteLedger:0},jobWindows:[{jobRef:'job-a'},{jobRef:'job-b'}]};
 const file=buildTurnAnalysisExport({turns:[row('turn-a','job-a'),row('turn-b','job-b')],projection:[page,page]});
 assert.equal(file.projection.transports,1);assert.equal(file.projection.byFloor.length,1);
 assert.equal(file.projection.byWindow.length,2);assert.equal(file.projection.jobWindows.length,2);
});

test('C15 an estimated unsaved floor grows for connected confirmed rooms, while a locked floor stays fixed',async()=>{
 const f=await makeSeed();try{
  const port=createTableReadPort(f.db),template=port.selectOne('locations',f.branchId,IDS.L3);
  const insert=(table,row)=>runBound(f.db,`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`,Object.values(row).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v));
  runBound(f.db,"UPDATE locations SET kind='building' WHERE branch_id=? AND id=?",[f.branchId,IDS.L3]);
  runBound(f.db,"UPDATE maps SET meters_per_cell=1,scale_quality='estimated',frame_json=? WHERE branch_id=? AND id=?",[JSON.stringify({cols:24,rows:41,atlasLayoutRequest:{status:'failed'}}),f.branchId,IDS.M2]);
  for(const [id,w,h] of [['hall',12,8],['guest',12,19],['kitchen',4,3]]){
   insert('entity_keys',{branch_id:f.branchId,id,kind:'location'});
   insert('locations',{...template,id,parent_location_id:IDS.L3,map_id:IDS.M2,grid_x:null,grid_y:null,coord_precision:'unknown',area_geometry_json:JSON.stringify({kind:'dimensions',widthM:w,heightM:h,quality:'confirmed',source:'story'})});
  }
  const route=port.selectOne('routes',f.branchId,IDS.R_AB);
  for(const [id,to] of [['hall-guest','guest'],['hall-kitchen','kitchen']])insert('routes',{...route,id,from_location_id:'hall',to_location_id:to,map_id:IDS.M2,kind:'door',geometry_json:null});
  const entry=deriveLayoutSites(createTableReadPort(f.db),f.branchId).entries.find(e=>e.mapId===IDS.M2);
  assert.equal(entry.extent.width,29);assert.equal(entry.extent.height,41);
  const built=Kit.buildLayoutContext({scope:{chatId:f.chatUid,branchId:f.branchId,revision:1,viewMode:'author'},mapRow:port.selectOne('maps',f.branchId,IDS.M2),maps:pageAllRows(port,'maps',f.branchId),locations:pageAllRows(port,'locations',f.branchId),routes:[]});
  const generated=Kit.generateFloor({width:entry.extent.width,height:entry.extent.height,rooms:[{id:'guest',w:12,h:19,side:'north'},{id:'hall',w:12,h:8,side:'south'},{id:'kitchen',w:4,h:3,side:'north'}],roomConnections:[{from:'hall',to:'guest'},{from:'hall',to:'kitchen'}]}, {...built.context,extent:entry.extent,currentScope:built.context.scope});
  assert.equal(generated.ok,true,JSON.stringify(generated.issues));
  assert.deepEqual(generated.scene.layout.rooms.map(r=>[r.id,r.w,r.h]).sort(),[['guest',12,19],['hall',12,8],['kitchen',4,3]]);
  runBound(f.db,'UPDATE maps SET scale_locked=1 WHERE branch_id=? AND id=?',[f.branchId,IDS.M2]);
  assert.equal(deriveLayoutSites(createTableReadPort(f.db),f.branchId).entries.find(e=>e.mapId===IDS.M2).extent.width,24);
 }finally{f.close();}
});
