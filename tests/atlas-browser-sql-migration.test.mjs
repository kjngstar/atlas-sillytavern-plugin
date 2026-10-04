import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserSqlHost } from '../src/atlas-browser-sql-host.ts';
import { loadAtlasSqlRuntime } from '../src/atlas-sql-session.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';

function fixture(){
 let saves=0,save=async()=>true;
 const legacy={schemaVersion:1,worldId:'world-old',branches:{canon:{
  locations:[{id:'loc:city',name:'旧城市',kind:'city',mapId:'world',gridX:4,gridY:8},
   {id:'loc:room',name:'旧教室',kind:'room',parentLocationId:'loc:city',mapId:'loc:city',gridX:2,gridY:3}],
  characters:[{id:'npc:user',name:'用户',role:'protagonist',locationId:'loc:room',presence:'present'},
   {id:'npc:left',name:'已离场',locationId:'loc:room',presence:'left',gridX:4,gridY:4,mapId:'loc:city'}],
  items:[{id:'item:pen',name:'笔',holderCharacterId:'npc:user'}],
 }}};
 const record={chatUid:'legacy-host',chatMetadata:{atlas:{tables:legacy,maps:{schemaVersion:2,submaps:{},calibrations:{},pointMeta:{}},authorNote:'保留作者笔记'}},saveMetadata:async()=>{saves++;return save();}};
 let live=record;
 const provider=createBrowserSqlHost({enabled:()=>true,context:()=>live,loadRuntime:loadAtlasSqlRuntime});
 return {record,provider,saves:()=>saves,setSave:fn=>{save=fn;},setHost:value=>{live=value;}};
}
test('Q08 browser opening migrates once, preserving IDs, parent and holder relationships and absence',async()=>{
 const f=fixture(),old=JSON.stringify(f.record.chatMetadata.atlas.tables);
 try{
  const s=await f.provider.session(f.record.chatUid);assert.equal(s.source,'migrated');assert.equal(f.saves(),1);
  assert.equal(queryBound(s.repo.db,'SELECT COUNT(*) n FROM locations',[])[0].n,2);
  assert.equal(queryBound(s.repo.db,'SELECT parent_location_id FROM locations WHERE id=?',['loc:room'])[0].parent_location_id,'loc:city');
  assert.equal(queryBound(s.repo.db,'SELECT holder_character_id FROM items WHERE id=?',['item:pen'])[0].holder_character_id,'npc:user');
  assert.equal(queryBound(s.repo.db,'SELECT status FROM characters WHERE id=?',['npc:left'])[0].status,'archived');
  assert.equal(JSON.stringify(f.record.chatMetadata.atlas.tables),old);assert.equal(f.record.chatMetadata.atlas.authorNote,'保留作者笔记');
  assert.equal(await f.provider.session(f.record.chatUid),s);assert.equal(f.saves(),1);
  await f.provider.close();const reopened=await f.provider.session(f.record.chatUid);assert.equal(reopened.source,'existing');assert.equal(f.saves(),1);
  assert.equal(queryBound(reopened.repo.db,'SELECT COUNT(*) n FROM characters',[])[0].n,2);
  assert.equal(queryBound(reopened.repo.db,"SELECT COUNT(*) n FROM turns WHERE decisions_json LIKE '%legacy_backup%'",[])[0].n,0);
 }finally{await f.provider.close();}
});
test('Q08 rejected migration save retains the entire legacy payload and permits a clean retry',async()=>{
 const f=fixture(),before=JSON.stringify(f.record.chatMetadata);f.setSave(async()=>false);
 try{
  await assert.rejects(f.provider.session(f.record.chatUid),error=>error.code==='SESSION_WRITE_FAILED');assert.equal(JSON.stringify(f.record.chatMetadata),before);
  f.setSave(async()=>true);const s=await f.provider.session(f.record.chatUid);assert.equal(f.saves(),2);assert.equal(queryBound(s.repo.db,'SELECT COUNT(*) n FROM locations',[])[0].n,2);
 }finally{await f.provider.close();}
});
test('Q08 host switch during migration save does not publish the old candidate into the new chat',async()=>{
 const f=fixture(),other={chatUid:'other',chatMetadata:{},saveMetadata:async()=>true};
 f.setSave(async()=>{f.setHost(other);return true;});
 try{
  await assert.rejects(f.provider.session(f.record.chatUid),error=>['CHAT_CHANGED','SESSION_WRITE_FAILED'].includes(error.code));
  assert.deepEqual(other.chatMetadata,{});assert.equal(f.record.chatMetadata.atlas.database,undefined);assert.ok(f.record.chatMetadata.atlas.tables);
 }finally{await f.provider.close();}
});
test('Q08 a damaged SQL envelope or a copied chat cannot trigger another legacy import',async()=>{
 const f=fixture();try{
  await f.provider.session(f.record.chatUid);await f.provider.close();const good=structuredClone(f.record.chatMetadata.atlas.database);
  f.record.chatMetadata.atlas.database.sha256='f'.repeat(64);const before=JSON.stringify(f.record.chatMetadata);
  await assert.rejects(f.provider.session(f.record.chatUid),error=>error.code.startsWith('ENVELOPE_'));assert.equal(JSON.stringify(f.record.chatMetadata),before);assert.equal(f.saves(),1);
  f.record.chatMetadata.atlas.database=good;
  const copied={...f.record,chatUid:'copied',chatMetadata:structuredClone(f.record.chatMetadata)};f.setHost(copied);
  await assert.rejects(f.provider.session('copied'),error=>error.code==='CHAT_CHANGED');assert.equal(f.saves(),1);
 }finally{await f.provider.close();}
});

test('Q08 forward parent links, archive protagonist identity and valid legacy map coordinates survive one-way migration',async()=>{
 const f=fixture(),a=f.record.chatMetadata.atlas;
 a.tables.branches.canon.locations.reverse();
 a.tables.branches.canon.characters[0].role=undefined;
 a.world={id:'old-world-stable',name:'旧世界名称',characters:[{id:'user',name:'用户',role:'主角'}],characterStates:[{characterId:'user',currentPointId:'room'}],points:[]};
 a.maps.calibrations={'loc:city':{metersPerCell:3,locked:true,source:'user',revision:4}};
 const before=JSON.stringify(a);
 try{
  const s=await f.provider.session(f.record.chatUid);
  assert.equal(s.worldUid,'old-world-stable');assert.equal(queryBound(s.repo.db,'SELECT name FROM branches',[])[0].name,'旧世界名称');
  const room=queryBound(s.repo.db,"SELECT parent_location_id,map_id,grid_x,grid_y FROM locations WHERE id='loc:room'",[])[0];
  assert.equal(room.parent_location_id,'loc:city');assert.deepEqual([room.grid_x,room.grid_y],[2,3]);
  const map=queryBound(s.repo.db,'SELECT * FROM maps WHERE id=?',[room.map_id])[0];
  assert.equal(map.container_location_id,'loc:city');assert.equal(map.meters_per_cell,3);assert.equal(map.scale_locked,1);assert.equal(map.calibration_rev,4);
  assert.equal(queryBound(s.repo.db,'SELECT pov_character_id FROM branches',[])[0].pov_character_id,'npc:user');
  const {database,...retained}=a;assert.ok(database);assert.equal(JSON.stringify(retained),before);
 }finally{await f.provider.close();}
});
test('Q08 cyclic legacy hierarchy fails without saving a partial world',async()=>{
 const f=fixture(),a=f.record.chatMetadata.atlas;a.tables.branches.canon.locations[0].parentLocationId='loc:room';
 const before=JSON.stringify(a);
 try{await assert.rejects(f.provider.session(f.record.chatUid),error=>error.code==='MIGRATION_FAILED');assert.equal(f.saves(),0);assert.equal(JSON.stringify(a),before);}
 finally{await f.provider.close();}
});
test('Q08 editing the legacy payload during save discards the candidate but retains the author edit',async()=>{
 const f=fixture();f.setSave(async()=>{f.record.chatMetadata.atlas.tables.branches.canon.locations[0].name='作者新名称';return true;});
 try{
  await assert.rejects(f.provider.session(f.record.chatUid),error=>['SESSION_STALE','SESSION_WRITE_FAILED'].includes(error.code));
  assert.equal(f.record.chatMetadata.atlas.database,undefined);assert.equal(f.record.chatMetadata.atlas.tables.branches.canon.locations[0].name,'作者新名称');
  f.setSave(async()=>true);const s=await f.provider.session(f.record.chatUid);assert.equal(queryBound(s.repo.db,"SELECT name FROM locations WHERE id='loc:city'",[])[0].name,'作者新名称');
 }finally{await f.provider.close();}
});

test('Q08 retired placeholder locations remain archived after migration and reopen',async()=>{
 const f=fixture(),a=f.record.chatMetadata.atlas;
 a.tables.branches.canon.locations.push({id:'loc:start',name:'旧起点',kind:'room'});
 a.scene={schemaVersion:1,retiredPointIds:['start']};const before=JSON.stringify(a);
 try{
  let session=await f.provider.session(f.record.chatUid);
  assert.equal(queryBound(session.repo.db,"SELECT status FROM locations WHERE id='loc:start'",[])[0].status,'archived');
  assert.equal(queryBound(session.repo.db,"SELECT COUNT(*) n FROM maps WHERE container_location_id='loc:start'",[])[0].n,0);
  assert.equal(JSON.stringify({...a,database:undefined}),before);
  await f.provider.close();session=await f.provider.session(f.record.chatUid);
  assert.equal(queryBound(session.repo.db,"SELECT status FROM locations WHERE id='loc:start'",[])[0].status,'archived');
 }finally{await f.provider.close();}
});
