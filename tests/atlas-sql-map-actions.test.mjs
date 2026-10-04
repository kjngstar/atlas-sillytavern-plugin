import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserSqlHost } from '../src/atlas-browser-sql-host.ts';
import { createAtlasServerCore } from './legacy/atlas-server-fixture.ts';
import { loadAtlasSqlRuntime } from '../src/atlas-sql-session.ts';
import { queryBound, foreignKeyCheck } from '../src/atlas-db-runtime.ts';

const initial=[
 {op:'location.upsert',ref:'new:city',data:{name:'城市',kind:'city'}},
 {op:'location.upsert',ref:'new:school',data:{name:'学校',kind:'building',parent_ref:'new:city'}},
 {op:'location.upsert',ref:'new:room',data:{name:'教室',kind:'room',parent_ref:'new:school'}},
 {op:'character.upsert',ref:'new:player',data:{name:'用户主角',role:'protagonist',importance:'core',location_ref:'new:room'}},
 {op:'character.upsert',ref:'new:friend',data:{name:'同学',identity:'同班学生',location_ref:'new:room'}},
 {op:'item.upsert',ref:'new:book',data:{name:'课本',location_ref:'new:room'}},
];
async function fixture(){
 let saves=0,calls=0,saveOk=true,response=initial.map(op=>JSON.stringify(op)).join('\n');
 const host={chatUid:'maps-real',branchId:'main',chatMetadata:{},saveMetadata:async()=>{saves++;return saveOk;}};
 const provider=createBrowserSqlHost({enabled:()=>true,context:()=>host,loadRuntime:loadAtlasSqlRuntime,
  modelPort:{request:async request=>{calls++;return {batchId:request.batchId,text:response,finishReason:'stop'};}}});
 const core=createAtlasServerCore({store:{read:async()=>null,write:async()=>{throw Error('No legacy writer');}},sqlSessionProvider:provider});
 const send=(action,body={})=>core.handle('POST','/sql/chat/'+action,{chatId:host.chatUid,chatUid:host.chatUid,...body},{local:true});
 const session=await provider.session(host.chatUid),seed=session.repo.internal.currentHeadTurnId();
 return {host,provider,core,session,seed,send,saves:()=>saves,calls:()=>calls,setSave:ok=>{saveOk=ok;},setResponse:r=>{response=r;},close:()=>provider.close()};
}
async function bootstrap(f){const request={assistantText:'你和同学在学校的教室里。',loreSupplement:'所有条目原文',openingMessageId:'opening'};
 const preview=await f.send('map/bootstrap',{...request,apply:false});assert.equal(preview.status,200,JSON.stringify(preview.body));
 const p=preview.body.data;
 const applied=await f.send('map/bootstrap',{...request,apply:true,previewId:p.previewId,baseRevision:p.baseRevision});
 assert.equal(applied.body.data.coreSaved,true,JSON.stringify(applied.body));return applied.body.data.receipt.turnId;
}
const row=(f,table,name)=>queryBound(f.session.repo.db,`SELECT * FROM ${table} WHERE name=?`,[name])[0];

test('Q07 bootstrap previews actual scene layout without saving; applying uses the same candidate and all maps undo with their floor',async()=>{
 const f=await fixture();try{
  const req={assistantText:'在学校教室。',openingMessageId:'opening'};
  const preview=await f.send('map/bootstrap',{...req,apply:false});assert.equal(preview.status,200,JSON.stringify(preview.body));
  assert.equal(preview.body.data.newLocations.length,3);assert.equal(f.saves(),0);assert.equal(f.calls(),1);
  assert.equal(queryBound(f.session.repo.db,'SELECT COUNT(*) n FROM locations',[])[0].n,0);
  const p=preview.body.data;
  const apply=await f.send('map/bootstrap',{...req,apply:true,previewId:p.previewId,baseRevision:p.baseRevision});assert.equal(apply.body.data.coreSaved,true,JSON.stringify(apply.body));
  assert.equal(f.calls(),1);assert.equal(f.saves(),1);
  const branch=queryBound(f.session.repo.db,'SELECT * FROM branches',[])[0];assert.equal(branch.clock_s,0);assert.ok(branch.pov_character_id);assert.ok(branch.root_map_id);
  assert.equal(queryBound(f.session.repo.db,'SELECT COUNT(*) n FROM maps',[])[0].n,4);
  const state=(await f.send('state')).body.data;
  const room=state.sqlViews.map.items.find(m=>m.containerLocationId===row(f,'locations','教室').id);
  assert.deepEqual([room.frames.frame.cols,room.frames.frame.rows],[12,8]);assert.equal(room.points.filter(p=>p.kind==='character').length,2);
  const undo=await f.core.handle('POST','/sql/rollback',{chatUid:f.host.chatUid,targetParentTurnId:f.seed},{local:true});assert.equal(undo.body.data.coreSaved,true,JSON.stringify(undo.body));
  assert.equal(queryBound(f.session.repo.db,'SELECT COUNT(*) n FROM maps',[])[0].n,0);assert.equal(queryBound(f.session.repo.db,'SELECT root_map_id FROM branches',[])[0].root_map_id,null);
  await bootstrap(f);assert.equal(queryBound(f.session.repo.db,'SELECT COUNT(*) n FROM maps',[])[0].n,4);
 }finally{await f.close();}
});

test('Q07 author scale, topology, area, movement and protagonist correction use one SQL writer and preserve old fields',async()=>{
 const f=await fixture();try{
  const turn=await bootstrap(f),room=row(f,'locations','教室'),school=row(f,'locations','学校'),city=row(f,'locations','城市'),player=row(f,'characters','用户主角');
  const roomMap=queryBound(f.session.repo.db,'SELECT id FROM maps WHERE container_location_id=?',[room.id])[0].id;
  const scale=await f.send('map/scale',{mapId:roomMap,userMetersPerCell:2});assert.equal(scale.body.data.coreSaved,true,JSON.stringify(scale.body));
  assert.equal(queryBound(f.session.repo.db,'SELECT meters_per_cell,scale_locked FROM maps WHERE id=?',[roomMap])[0].meters_per_cell,2);
  assert.equal((await f.send('map/scale',{mapId:roomMap})).body.error.code,'MAP_SCALE_LOCKED');
  const area=await f.send('map/areas',{mapId:school.id,locationId:room.id,cells:[{x:2,y:3}]});assert.equal(area.body.data.coreSaved,true,JSON.stringify(area.body));
  assert.deepEqual(JSON.parse(row(f,'locations','教室').area_geometry_json).cells,[{x:2,y:3}]);
  const parent=await f.send('map/topology',{operation:'set-parent',locationId:room.id,targetLocationId:city.id});assert.equal(parent.body.data.coreSaved,true,JSON.stringify(parent.body));
  const cityMap=queryBound(f.session.repo.db,'SELECT id FROM maps WHERE container_location_id=?',[city.id])[0].id;assert.equal(row(f,'locations','教室').map_id,cityMap);
  assert.equal((await f.send('map/move',{entityId:player.id,toPointId:school.id})).body.data.coreSaved,true);
  assert.equal(row(f,'characters','用户主角').location_id,school.id);assert.equal(row(f,'characters','用户主角').grid_x,null);
  assert.equal((await f.send('map/protagonist',{playerName:'新主角'})).body.data.coreSaved,true);
  assert.equal(queryBound(f.session.repo.db,'SELECT pov_character_id FROM branches',[])[0].pov_character_id,row(f,'characters','新主角').id);
  assert.equal(row(f,'characters','用户主角').role,'npc');assert.deepEqual(foreignKeyCheck(f.session.repo.db),[]);
  assert.deepEqual(Object.keys(f.host.chatMetadata.atlas),['database']);
  const undo=await f.core.handle('POST','/sql/rollback',{chatUid:f.host.chatUid,targetParentTurnId:turn},{local:true});assert.equal(undo.body.data.coreSaved,true);
  assert.equal(queryBound(f.session.repo.db,'SELECT COUNT(*) n FROM locations',[])[0].n,0);
 }finally{await f.close();}
});

test('Q07 failed map save and stale preview never publish candidate coordinates or maps',async()=>{
 const f=await fixture();try{
  await bootstrap(f);const before=Buffer.from(f.session.repo.db.export()),room=row(f,'locations','教室');f.setSave(false);
  const failed=await f.send('map/topology',{operation:'confirm-coordinate',locationId:room.id,mapId:'world',gridX:9,gridY:10});assert.equal(failed.body.error.code,'SESSION_WRITE_FAILED');
  assert.deepEqual(Buffer.from(f.session.repo.db.export()),before);
  f.setSave(true);
  f.setResponse('{"op":"noop"}');
  const req={assistantText:'教室',openingMessageId:'another'},preview=(await f.send('map/bootstrap',{...req,apply:false})).body.data;
  assert.equal((await f.send('map/scale',{mapId:'world',userMetersPerCell:10})).body.data.coreSaved,true);
  const stale=await f.send('map/bootstrap',{...req,apply:true,previewId:preview.previewId,baseRevision:preview.baseRevision});assert.equal(stale.status,409);assert.equal(stale.body.error.code,'STALE_BASE');
 }finally{await f.close();}
});

test('Q07 snapshot assets survive author writes, maintenance, reopening and rollback',async()=>{
 const f=await fixture();try{
  const turn=await bootstrap(f);await f.provider.close();
  const assets=[{key:'map-bg',mime:'image/png',sha256:'a'.repeat(64),storage_ref:'local:room-bg'}];f.host.chatMetadata.atlas.database.assets=assets;
  const active=await f.provider.session(f.host.chatUid);
  const scale=await f.send('map/scale',{mapId:'world',userMetersPerCell:7});assert.equal(scale.body.data.coreSaved,true);
  assert.deepEqual(f.host.chatMetadata.atlas.database.assets,assets);
  const {runSqlMaintenance}=await import('../src/atlas-sql-session.ts');
  const result=await runSqlMaintenance(active,{anchor:{chatUid:active.chatUid,branchId:active.branchId,parentTurnId:active.repo.internal.currentHeadTurnId(),baseRevision:active.repo.internal.currentRevision(),baseStorageRevision:active.repo.storageRevision,hostMessageUid:'maint',variantKey:'',inputHash:'maint'}});
  assert.equal(result.saved,true);f.provider.saved(active);assert.deepEqual(f.host.chatMetadata.atlas.database.assets,assets);
  const undo=await f.core.handle('POST','/sql/rollback',{chatUid:f.host.chatUid,targetParentTurnId:turn},{local:true});assert.equal(undo.body.data.coreSaved,true);assert.deepEqual(f.host.chatMetadata.atlas.database.assets,assets);
 }finally{await f.close();}
});
test('Q07 SQL area projection supports confirmed cells and estimated polygons in the actual map frame',async()=>{
 const {projectSqlMapAreas}=await import('../src/atlas-sql-map-areas.ts');
 const f=await fixture();try{
  await bootstrap(f);const room=row(f,'locations','教室'),school=row(f,'locations','学校');
  assert.equal((await f.send('map/areas',{mapId:school.id,locationId:room.id,cells:[{x:2,y:3}]})).body.data.coreSaved,true);
  const state=(await f.send('state')).body.data;
  const schoolMap=state.sqlViews.map.items.find(map=>map.containerLocationId===school.id);
  const marker=schoolMap.points.find(p=>p.entityId===room.id);
  assert.ok(marker.area);assert.equal(projectSqlMapAreas([{locationId:room.id,geometry:marker.area}],{cols:100,rows:100}).areas[0].quality,'confirmed');
  const projection=projectSqlMapAreas([{locationId:'polygon',geometry:{kind:'polygon',points:[{x:1,y:1},{x:10,y:1},{x:10,y:7}],quality:'estimated',source:'estimate'}},{locationId:'bad',geometry:{kind:'cells',cells:[{x:84,y:28}]}}],{cols:12,rows:8});
  assert.equal(projection.areas.length,1);assert.equal(projection.areas[0].quality,'estimated');assert.equal(projection.skipped[0].locationId,'bad');
 }finally{await f.close();}
});

