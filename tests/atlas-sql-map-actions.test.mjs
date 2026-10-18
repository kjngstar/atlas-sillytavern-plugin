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
 let saves=0,calls=0,saveOk=true,layoutOverride=null,layoutFailure=false,response=initial.map(op=>JSON.stringify(op)).join('\n');
 const host={chatUid:'maps-real',branchId:'main',chatMetadata:{},saveMetadata:async()=>{saves++;return saveOk;}};
 const provider=createBrowserSqlHost({enabled:()=>true,context:()=>host,loadRuntime:loadAtlasSqlRuntime,
  modelPort:{request:async request=>{calls++;
   if(layoutFailure&&request.allowedOps?.includes('map.layout.request'))throw new Error('fixture layout connection unavailable');
   if(request.batchId.includes('_evidence_'))return {batchId:request.batchId,text:'{"facts":[]}',finishReason:'stop'};
   const line=request.messages?.[1]?.content.split('\n').find(line=>line.startsWith('本图：'));
   const layout=line?JSON.parse(line.slice(3)).map(scope=>JSON.stringify({op:'map.layout.request',ref:scope.map,data:{kind:scope.kind,spec:scope.kind==='floor'?{rooms:scope.baselineRooms}:scope.kind==='city'?{riverWidth:0,districts:[{id:scope.container.ref,name:scope.name,bank:'west',order:0}]}:{surface:'mixed'}}})).join('\n'):null;
   return {batchId:request.batchId,text:request.batchId.startsWith('construction_')?'{"op":"noop"}':layout?(layoutOverride??layout):response,finishReason:'stop'};}}});
 const core=createAtlasServerCore({store:{read:async()=>null,write:async()=>{throw Error('No legacy writer');}},sqlSessionProvider:provider});
 const send=(action,body={})=>core.handle('POST','/sql/chat/'+action,{chatId:host.chatUid,chatUid:host.chatUid,...body},{local:true});
 const session=await provider.session(host.chatUid),seed=session.repo.internal.currentHeadTurnId();
 return {host,provider,core,session,seed,send,saves:()=>saves,calls:()=>calls,setSave:ok=>{saveOk=ok;},setResponse:r=>{response=r;},setLayoutResponse:r=>{layoutOverride=r;},setLayoutFailure:value=>{layoutFailure=value;},close:()=>provider.close()};
}
async function bootstrap(f){const request={assistantText:'你和同学在学校的教室里。',loreSupplement:'所有条目原文',openingMessageId:'opening'};
 const preview=await f.send('map/bootstrap',{...request,apply:false});assert.equal(preview.status,200,JSON.stringify(preview.body));
 const p=preview.body.data;
 const applied=await f.send('map/bootstrap',{...request,apply:true,previewId:p.previewId,baseRevision:p.baseRevision});
 assert.equal(applied.body.data.coreSaved,true,JSON.stringify(applied.body));return applied.body.data.receipt.turnId;
}
const row=(f,table,name)=>queryBound(f.session.repo.db,`SELECT * FROM ${table} WHERE name=?`,[name])[0];
for(const prefixed of [false,true])test(`UI location reference resolves scene-save evidence to the real map (prefixed=${prefixed})`,async()=>{
 const f=await fixture();try{
  await bootstrap(f);
  const school=row(f,'locations','学校');
  const target=queryBound(f.session.repo.db,'SELECT id FROM maps WHERE container_location_id=?',[school.id])[0];
  const result=await f.send('map/layout',{mapId:(prefixed?'loc:':'')+school.id,requestId:'ui-location-scene-'+prefixed});
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.data.coreSaved,true);
  assert.equal(result.body.data.sceneSaved,true,'UI 地点入口和实际地图 ID 必须使用同一张图的本轮保存证据');
  assert.ok(result.body.data.receipt.groups.some(group=>group.groupId.endsWith(':scene')&&group.status==='applied'));
  assert.ok(queryBound(f.session.repo.db,"SELECT 1 FROM turn_changes WHERE turn_id=? AND target_table='maps' AND target_row_id=?",[result.body.data.receipt.turnId,target.id]).length);
 }finally{await f.close();}
});
test('failed layout transport cannot count a retained old scene as a scene saved this turn',async()=>{
 const f=await fixture();try{
  await bootstrap(f);
  const school=row(f,'locations','学校');
  const target=queryBound(f.session.repo.db,'SELECT id,frame_json FROM maps WHERE container_location_id=?',[school.id])[0];
  const before=JSON.parse(target.frame_json).atlasScene;
  assert.ok(before);
  f.setLayoutFailure(true);
  const result=await f.send('map/layout',{mapId:school.id,requestId:'ui-retain-old-scene'});
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.data.sceneSaved,false);
  assert.ok(result.body.data.receipt.issues.some(issue=>issue.code==='LAYOUT_MODEL_FAILED'));
  assert.deepEqual(JSON.parse(queryBound(f.session.repo.db,'SELECT frame_json FROM maps WHERE id=?',[target.id])[0].frame_json).atlasScene,before);
 }finally{await f.close();}
});
test('生成时坏 JSON 不阻止已登记独立场地的基础形状，模型细节仍如实延期',async()=>{
 const f=await fixture();try{
  f.setResponse([...initial,{op:'location.upsert',ref:'new:yard',data:{name:'验收庭院',kind:'other',parent_ref:'new:school'}}].map(o=>JSON.stringify(o)).join('\n'));
  await bootstrap(f);
  const yard=row(f,'locations','验收庭院'),map=queryBound(f.session.repo.db,'SELECT * FROM maps WHERE container_location_id=?',[yard.id])[0];
  const frame=JSON.parse(map.frame_json);delete frame.atlasScene;delete frame.atlasLayoutContext;
  f.session.repo.db.run('UPDATE maps SET frame_json=? WHERE id=?',[JSON.stringify(frame),map.id]);
  f.setLayoutResponse('{broken JSON');
  const calls=f.calls(),result=await f.send('map/layout',{mapId:map.id,requestId:'bad-yard-json'});
  assert.equal(result.body.data.coreSaved,true,JSON.stringify(result.body));assert.equal(result.body.data.sceneSaved,true);
  assert.equal(f.calls()-calls,2,'格式纠错最多一次，基础布局不另调 API');
  const after=JSON.parse(queryBound(f.session.repo.db,'SELECT frame_json FROM maps WHERE id=?',[map.id])[0].frame_json);
  assert.ok(after.atlasScene.layout.selfArea);assert.deepEqual(after.atlasScene.layout.features,[]);
  assert.ok(result.body.data.receipt.issues.some(i=>i.code==='LAYOUT_DETAILS_DEFERRED'));
  assert.equal(result.body.data.receipt.clockBeforeS,result.body.data.receipt.clockAfterS);
 }finally{await f.close();}
});

test('城市模型漏写街区时，只为已登记城市容器补齐自身街区',async()=>{
 const f=await fixture();try{
  await bootstrap(f);
  const city=row(f,'locations','城市'),school=row(f,'locations','学校');
  const map=queryBound(f.session.repo.db,'SELECT * FROM maps WHERE container_location_id=?',[city.id])[0];
  const frame=JSON.parse(map.frame_json);delete frame.atlasScene;delete frame.atlasLayoutContext;
  f.session.repo.db.run('UPDATE maps SET frame_json=? WHERE id=?',[JSON.stringify(frame),map.id]);
  f.setLayoutResponse(JSON.stringify({op:'map.layout.request',ref:map.id,data:{kind:'city',spec:{riverWidth:0,buildings:[{id:school.id,name:'学校',districtId:city.id,w:30,h:20}]}}}));
  const result=await f.send('map/layout',{mapId:map.id,requestId:'city-missing-district'});
  assert.equal(result.body.data.coreSaved,true,JSON.stringify(result.body));
  assert.equal(result.body.data.sceneSaved,true,JSON.stringify(result.body));
  const after=JSON.parse(queryBound(f.session.repo.db,'SELECT frame_json FROM maps WHERE id=?',[map.id])[0].frame_json);
  assert.equal(after.atlasScene.constraints.districts[0].id,city.id);
  assert.ok(after.atlasScene.layout.buildings.some(building=>building.id===school.id));
  assert.ok(!result.body.data.receipt.issues.some(issue=>issue.code==='DISTRICT_REF_UNKNOWN'));
 }finally{await f.close();}
});

test('Q07 bootstrap previews actual scene layout without saving; applying uses the same candidate and all maps undo with their floor',async()=>{
 const f=await fixture();try{
  const req={assistantText:'在学校教室。',openingMessageId:'opening'};
  const preview=await f.send('map/bootstrap',{...req,apply:false});assert.equal(preview.status,200,JSON.stringify(preview.body));
  assert.equal(preview.body.data.newLocations.length,3);assert.equal(f.saves(),0);assert.equal(f.calls(),7);
  assert.equal(queryBound(f.session.repo.db,'SELECT COUNT(*) n FROM locations',[])[0].n,0);
  const p=preview.body.data;
  const apply=await f.send('map/bootstrap',{...req,apply:true,previewId:p.previewId,baseRevision:p.baseRevision});assert.equal(apply.body.data.coreSaved,true,JSON.stringify(apply.body));
  assert.equal(f.calls(),7);assert.equal(f.saves(),1);
  const builtMaps=queryBound(f.session.repo.db,'SELECT frame_json FROM maps',[]);
  assert.equal(builtMaps.filter(map=>JSON.parse(map.frame_json).atlasScene).length,4,JSON.stringify({message:'所有四张地图与两批布局必须在一次确认中一起保存',maps:builtMaps.map(map=>JSON.parse(map.frame_json)),receipt:apply.body.data.receipt}));
  assert.ok(builtMaps.every(map=>JSON.parse(map.frame_json).atlasLayoutContext),'两批布局都必须记录结构指纹，避免下轮重复生成');
  const branch=queryBound(f.session.repo.db,'SELECT * FROM branches',[])[0];assert.equal(branch.clock_s,0);assert.ok(branch.pov_character_id);assert.ok(branch.root_map_id);
  assert.equal(queryBound(f.session.repo.db,'SELECT COUNT(*) n FROM maps',[])[0].n,4);
  const state=(await f.send('state')).body.data;
  const room=state.sqlViews.map.items.find(m=>m.containerLocationId===row(f,'locations','教室').id);
  const parentMap=queryBound(f.session.repo.db,'SELECT frame_json FROM maps WHERE container_location_id=?',[row(f,'locations','学校').id])[0];
  const childOutline=JSON.parse(parentMap.frame_json).atlasScene.layout.rooms.find(r=>r.id===row(f,'locations','教室').id);
  assert.ok(Math.abs(room.frames.frame.cols*room.metersPerCell-childOutline.w)<1e-6);
  assert.ok(Math.abs(room.frames.frame.rows*room.metersPerCell-childOutline.h)<1e-6);
  assert.equal(room.points.filter(p=>p.kind==='character').length,2);
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

test('P13 map/profile 走真实命令链：作者切档案落盘、非法模式拒绝、回退还原',async()=>{
 const f=await fixture();try{
  const turn=await bootstrap(f);
  const school=row(f,'locations','学校');
  const mapId=queryBound(f.session.repo.db,`SELECT id FROM maps WHERE container_location_id = ?`,[school.id])[0].id;
  const frameBefore=queryBound(f.session.repo.db,`SELECT frame_json FROM maps WHERE id = ?`,[mapId])[0].frame_json;
  const sceneBefore=JSON.parse(frameBefore).atlasScene;
  assert.ok(sceneBefore,'bootstrap 之后学校图必须已有真实场景，否则本用例没在验"保留旧 scene"');

  // ① 非法模式：命令层直接拒绝，不动存档（不能按名字猜、也不能发未支持的 role）。
  const bad=await f.send('map/profile',{mapId,mode:'parking'});
  assert.equal(bad.body.error.code,'ENUM_INVALID',JSON.stringify(bad.body));
  assert.equal(queryBound(f.session.repo.db,`SELECT frame_json FROM maps WHERE id = ?`,[mapId])[0].frame_json,frameBefore);

  // ② 合法切换：只写绘图档案命名空间，已保存场景逐字节保留，且不新增任何实体。
  const counts=()=>['locations','maps','routes','characters','items'].map(table=>queryBound(f.session.repo.db,`SELECT COUNT(*) n FROM ${table}`,[ ])[0].n).join('/');
  const countsBefore=counts();
  const ok=await f.send('map/profile',{mapId,mode:'compound'});
  assert.equal(ok.body.data.coreSaved,true,JSON.stringify(ok.body));
  const after=JSON.parse(queryBound(f.session.repo.db,`SELECT frame_json FROM maps WHERE id = ?`,[mapId])[0].frame_json);
  assert.equal(after.atlasSpatialProfile.mode,'compound');
  assert.equal(after.atlasSpatialProfile.basis,'author');
  assert.deepEqual(after.atlasScene,sceneBefore,'切档案不得顺手改写已保存场景');
  assert.equal(counts(),countsBefore,'切档案绝不新造 SQL 地点/地图/路线/人物/物品');
  assert.deepEqual(foreignKeyCheck(f.session.repo.db),[],'写档案不得破坏外键');

  // ③ 作者预览立刻可见；档案只能落在既有三种布局 kind。
  const state=(await f.send('state')).body.data;
  const view=state.sqlViews.map.items.find(map=>map.mapId===mapId);
  assert.equal(view.profile.mode,'compound');
  assert.ok(['overview','city','floor'].includes(view.profile.layoutKind),'档案只能落在既有三种布局 kind');
  assert.equal(view.profile.layoutKind,'overview');

  // ④ 回退**档案那一轮**（回退语义是「目标 turn 自身 + 全部后继」，回退到 bootstrap 轮会把
  // bootstrap 一起撤掉）：档案撤销，场景仍与切换前一致。
  const profileTurn=ok.body.data.receipt.turnId;
  const undo=await f.core.handle('POST','/sql/rollback',{chatUid:f.host.chatUid,targetParentTurnId:profileTurn},{local:true});
  assert.equal(undo.body.data.coreSaved,true,JSON.stringify(undo.body));
  const reverted=JSON.parse(queryBound(f.session.repo.db,`SELECT frame_json FROM maps WHERE id = ?`,[mapId])[0].frame_json);
  assert.equal('atlasSpatialProfile' in reverted,false,'回退后档案命名空间必须消失');
  assert.deepEqual(reverted.atlasScene,sceneBefore,'回退后场景仍与切换前一致');
  assert.equal(counts(),countsBefore,'回退不新增任何实体');
  void turn;
 }finally{await f.close();}
});
