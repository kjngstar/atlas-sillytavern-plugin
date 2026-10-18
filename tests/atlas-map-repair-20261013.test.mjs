import test from 'node:test';
import assert from 'node:assert/strict';
import {createRow} from '../src/atlas-db-defaults.ts';
import {createTableReadPort,pageAllRows} from '../src/atlas-db-readport.ts';
import {queryBound} from '../src/atlas-db-runtime.ts';
import {collectTaskRefs} from '../src/atlas-sql-task-refs.ts';
import {buildSqlLayoutTask} from '../src/atlas-sql-layout-task.ts';
import {canonicalRouteGeometry} from '../src/atlas-layout-signature.ts';
import {queryMapView} from '../src/atlas-db-views.ts';
import {DEFAULT_POLICY_CONTENT} from '../src/atlas-prompt-layers.ts';
import {querySqlSceneState} from '../src/atlas-sql-view-state.ts';
import {queryEntityDetail} from '../src/atlas-db-views.ts';
import {LIMITS,filterSceneForView} from '../vendor/atlas-spatial/index.mjs';
import {compileSceneGroup} from '../vendor/atlas-spatial/candidate-group.mjs';
import {collectSceneMemberIds,pruneInvalidSceneMembers} from '../src/atlas-spatial-candidate.ts';
import {reconcileOccupantsSpec} from '../src/atlas-spatial-occupants.ts';
import {makeSeedWith,insertRows,IDS} from './fixtures/atlas-sql/seed.mjs';

const SQL=await (await import('sql.js')).default();
const branchId=IDS.branchMain;
const turnId=IDS.seedTurn;
const context=id=>({branchId,id,turnId,clockS:0,nowWallMs:1700000000000,rulesetVersion:'atlas-1'});
const row=(table,id,fields)=>createRow(table,fields,context(id));
function addLocations(db,entries){
  insertRows(db,'entity_keys',entries.map(([id])=>({branch_id:branchId,id,kind:'location'})));
  insertRows(db,'locations',entries.map(([id,fields])=>row('locations',id,{name:id,kind:'other',...fields})));
}
function addMap(db,id,container=null,fields={}){
  insertRows(db,'maps',[row('maps',id,{name:id,kind:'site',container_location_id:container,
    frame_json:JSON.stringify({cols:40,rows:30,reference_width_cells:40,reference_height_cells:30}),...fields})]);
}
function input(extra={}){return {anchor:{chatUid:IDS.chatA,branchId,parentTurnId:turnId,
  hostMessageUid:'repair_test',variantKey:'v1',baseRevision:0,baseStorageRevision:0,inputHash:'repair-test'},
  userText:'Inspect the registered map.',assistantText:'The scene has not changed.',sourceSnapshot:[],phaseBatches:[],manual:false,
  layoutMaps:'active',...extra};}
function scopes(task){
  const text=task.request.messages[1].content,start=text.indexOf('[{"map":');
  assert.ok(start>=0,'the real model request must contain the scope catalogue');
  let depth=0,quoted=false,escaped=false;
  for(let i=start;i<text.length;i++){
    const c=text[i];
    if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"'){quoted=true;continue;}
    if(c==='['||c==='{')depth++;
    if(c===']'||c==='}')depth--;
    if(depth===0)return JSON.parse(text.slice(start,i+1));
  }
  throw Error('scope catalogue is incomplete');
}

for(const status of ['open','blocked','closed'])test(`PATCH-REF01 ${status} route keeps its remote endpoint in the frozen catalogue`,async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    seed.db.run('UPDATE routes SET status=? WHERE branch_id=? AND id=?',[status,branchId,IDS.R_AB]);
    const cat=collectTaskRefs(createTableReadPort(seed.db),{branchId,focusLocationIds:[IDS.L1],
      focusMapIds:[],includeAncestors:true,includeDirectChildren:false,includeRoutes:true,includeOccupants:false,maxEntries:512});
    assert.ok(cat.knownRefs.some(r=>r.id===IDS.R_AB));
    assert.ok(cat.knownRefs.some(r=>r.id===IDS.L2),'a declared route must not lose its second endpoint');
  }finally{seed.close();}
});

for(const [kind,id] of [['location',IDS.L3],['map',IDS.M2]])test(`PATCH-REF02 explicitly required ${kind} works without an incidental focus`,async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    const cat=collectTaskRefs(createTableReadPort(seed.db),{branchId,focusLocationIds:[],focusMapIds:[],
      includeAncestors:true,includeDirectChildren:false,includeRoutes:false,includeOccupants:false,maxEntries:512,requiredRefs:[{kind,id}]});
    assert.ok(cat.knownRefs.some(r=>r.id===id&&r.kind===kind));
  }finally{seed.close();}
});

test('PATCH-REF03 necessary route endpoints count as necessary budget, rather than being silently dropped',async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    const cat=collectTaskRefs(createTableReadPort(seed.db),{branchId,focusLocationIds:[],focusMapIds:[],
      includeAncestors:true,includeDirectChildren:false,includeRoutes:false,includeOccupants:false,maxEntries:2,
      requiredRefs:[{kind:'route',id:IDS.R_AB}]});
    for(const id of [IDS.R_AB,IDS.L1,IDS.L2])assert.ok(cat.knownRefs.some(r=>r.id===id),id);
    assert.equal(cat.requiredBudgetExceeded,true);
    assert.ok(cat.issues.some(i=>i.code==='REF_REQUIRED_BUDGET_EXCEEDED'));
  }finally{seed.close();}
});

test('PATCH-PAGE01 more than 1000 direct children are either supplied or explicitly deferred',async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    const ids=Array.from({length:1005},(_,n)=>`Z_CHILD_${String(n).padStart(4,'0')}`);
    addLocations(seed.db,ids.map(id=>[id,{parent_location_id:IDS.L1}]));
    const cat=collectTaskRefs(createTableReadPort(seed.db),{branchId,focusLocationIds:[IDS.L1],focusMapIds:[],
      includeAncestors:true,includeDirectChildren:true,includeRoutes:false,includeOccupants:false,maxEntries:32});
    const accounted=new Set([...cat.knownRefs.map(r=>r.id),...cat.remainingIds]);
    for(const id of ids)assert.ok(accounted.has(id),`silently lost ${id}`);
  }finally{seed.close();}
});

test('PATCH-PAGE02 pageAllRows normalizes a requested page larger than the port maximum',async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    addLocations(seed.db,Array.from({length:1005},(_,n)=>[`Z_PAGE_${String(n).padStart(4,'0')}`,{}]));
    const read=createTableReadPort(seed.db),expected=Number(queryBound(seed.db,'SELECT COUNT(*) n FROM locations WHERE branch_id=?',[branchId])[0].n);
    assert.equal(pageAllRows(read,'locations',branchId,1000).length,expected);
  }finally{seed.close();}
});

test('PATCH-PAGE03 explicit map beyond the first 1000 maps still produces a layout task',async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    const ids=Array.from({length:1005},(_,n)=>`Z_MAP_${String(n).padStart(4,'0')}`);
    insertRows(seed.db,'maps',ids.map(id=>row('maps',id,{name:id,kind:'site',frame_json:JSON.stringify({cols:40,rows:30})})));
    const task=buildSqlLayoutTask(seed.db,branchId,input({layoutMaps:[ids.at(-1)]}),turnId);
    assert.ok(task,'the requested map must not disappear in a selectWhere limit');
    assert.deepEqual(task.mapIds,[ids.at(-1)]);
  }finally{seed.close();}
});

test('PATCH-PAGE04 an explicit map whose container is after location 1000 remains usable',async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    const ids=Array.from({length:1005},(_,n)=>`Z_SITE_${String(n).padStart(4,'0')}`);
    addLocations(seed.db,ids.map(id=>[id,{}]));
    addMap(seed.db,'MAP_LATE_CONTAINER',ids.at(-1));
    const task=buildSqlLayoutTask(seed.db,branchId,input({layoutMaps:['MAP_LATE_CONTAINER']}),turnId);
    assert.ok(task,'a real container outside the read prefix must not be classified as absent');
  }finally{seed.close();}
});

test('PATCH-REF04 crowded map prompt never emits actor objects whose reference was omitted by budget',async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    const ids=Array.from({length:600},(_,n)=>`Z_ACTOR_${String(n).padStart(4,'0')}`);
    insertRows(seed.db,'entity_keys',ids.map(id=>({branch_id:branchId,id,kind:'character'})));
    insertRows(seed.db,'characters',ids.map(id=>row('characters',id,{name:id,location_id:IDS.L3,map_id:IDS.M2})));
    const task=buildSqlLayoutTask(seed.db,branchId,input({layoutMaps:[IDS.M2]}),turnId);
    assert.ok(task);
    assert.ok(task.catalogue.remainingIds.length>0,'the fixture must exercise an actual budget limit');
    for(const actor of scopes(task)[0].actors){assert.ok(actor.ref,'missing actor reference');assert.ok(actor.roomId);}
    assert.ok(scopes(task)[0].actors.length<=LIMITS.actors,'the model must not be asked to exceed its own actors collection limit');
    assert.equal(task.request.promptInput.injectionText,task.request.messages[1].content);
  }finally{seed.close();}
});

test('PATCH-PAGE05 the public map DTO also finds an explicitly selected map after map 1000',async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    const ids=Array.from({length:1005},(_,n)=>`Z_DTO_MAP_${String(n).padStart(4,'0')}`);
    insertRows(seed.db,'maps',ids.map(id=>row('maps',id,{name:id,kind:'site',frame_json:JSON.stringify({cols:40,rows:30})})));
    const view=queryMapView({db:seed.db,branchId,revision:0,viewMode:'author'},{kind:'map',mapId:ids.at(-1)});
    assert.equal(view.items.length,1);
    assert.equal(view.items[0].mapId,ids.at(-1));
  }finally{seed.close();}
});

test('PATCH-PAGE06 a visible location after location 2000 is not silently absent from the selected map',async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    const ids=Array.from({length:2005},(_,n)=>`Z_DTO_LOCATION_${String(n).padStart(4,'0')}`);
    addLocations(seed.db,ids.map(id=>[id,{map_id:IDS.M1,grid_x:40,grid_y:30,coord_precision:'layout'}]));
    const view=queryMapView({db:seed.db,branchId,revision:0,viewMode:'author'},{kind:'map',mapId:IDS.M1});
    assert.ok(view.items[0].points.some(p=>p.entityId===ids.at(-1)));
  }finally{seed.close();}
});

test('PATCH-HIER01 old root coordinates do not flatten a city-building-room hierarchy into the world map',async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    addLocations(seed.db,[['HIER_CITY',{kind:'city',map_id:IDS.M1,grid_x:40,grid_y:30,coord_precision:'exact'}],
      ['HIER_BUILDING',{kind:'building',parent_location_id:'HIER_CITY',map_id:IDS.M1,grid_x:42,grid_y:32,coord_precision:'exact'}],
      ['HIER_ROOM',{kind:'room',parent_location_id:'HIER_BUILDING',map_id:IDS.M1,grid_x:43,grid_y:33,coord_precision:'exact'}]]);
    addMap(seed.db,'HIER_CITY_MAP','HIER_CITY',{meters_per_cell:40,scale_quality:'estimated'});
    addMap(seed.db,'HIER_BUILDING_MAP','HIER_BUILDING',{meters_per_cell:1,scale_quality:'estimated'});
    const root=queryMapView({db:seed.db,branchId,revision:0,viewMode:'author'},{kind:'map',mapId:IDS.M1}).items[0];
    assert.ok(root.points.some(p=>p.entityId==='HIER_CITY'));
    assert.ok(!root.points.some(p=>p.entityId==='HIER_BUILDING'||p.entityId==='HIER_ROOM'));
    const cityTask=buildSqlLayoutTask(seed.db,branchId,input({layoutMaps:['HIER_CITY_MAP']}),turnId);
    const ref=id=>cityTask.catalogue.knownRefs.find(r=>r.id===id)?.alias;
    assert.ok(scopes(cityTask)[0].locations.some(l=>l.ref===ref('HIER_BUILDING')&&l.placement==='proxy'));
    assert.ok(!scopes(cityTask)[0].locations.some(l=>l.ref===ref('HIER_ROOM')));
    assert.equal(queryBound(seed.db,'SELECT map_id FROM locations WHERE branch_id=? AND id=?',[branchId,'HIER_ROOM'])[0].map_id,IDS.M1);
  }finally{seed.close();}
});

test('PATCH-HIER02 a character in a nested location is aggregated at the outer location instead of its old root coordinate',async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    addLocations(seed.db,[['HIER_CITY',{kind:'city',map_id:IDS.M1,grid_x:40,grid_y:30,coord_precision:'exact'}],
      ['HIER_ROOM',{kind:'room',parent_location_id:'HIER_CITY',map_id:IDS.M1,grid_x:43,grid_y:33,coord_precision:'exact'}]]);
    addMap(seed.db,'HIER_CITY_MAP','HIER_CITY',{meters_per_cell:40,scale_quality:'estimated'});
    seed.db.run('UPDATE characters SET location_id=?,map_id=?,grid_x=43,grid_y=33,coord_precision=? WHERE branch_id=? AND id=?',
      ['HIER_ROOM',IDS.M1,'exact',branchId,IDS.C1]);
    const root=queryMapView({db:seed.db,branchId,revision:0,viewMode:'author',povId:IDS.C1},{kind:'map',mapId:IDS.M1}).items[0];
    assert.ok(!root.points.some(p=>p.entityId===IDS.C1));
    assert.ok(root.coarseList.some(p=>p.entityId===IDS.C1&&p.locationId==='HIER_CITY'));
    assert.equal(queryBound(seed.db,'SELECT grid_x FROM characters WHERE branch_id=? AND id=?',[branchId,IDS.C1])[0].grid_x,43);
  }finally{seed.close();}
});

test('PATCH-POLICY01 construction permits plausible inferred places without inventing confirmed history',()=>{
  assert.match(DEFAULT_POLICY_CONTENT,/建设阶段/);
  assert.match(DEFAULT_POLICY_CONTENT,/inferred/);
  assert.match(DEFAULT_POLICY_CONTENT,/布局阶段/);
  assert.match(DEFAULT_POLICY_CONTENT,/重大历史|重大事件/);
});

test('PATCH-SAFETY01 a hidden proxy remains absent from the protagonist scene',async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    addLocations(seed.db,[['PROXY_PARENT',{kind:'building',map_id:IDS.M1,grid_x:40,grid_y:30,coord_precision:'exact'}],
      ['SECRET_PROXY_ROOM',{kind:'room',parent_location_id:'PROXY_PARENT',map_id:IDS.M1,grid_x:43,grid_y:33,coord_precision:'exact'}]]);
    addMap(seed.db,'PROXY_MAP','PROXY_PARENT',{meters_per_cell:1,scale_quality:'estimated'});
    const tables=createTableReadPort(seed.db),maps=pageAllRows(tables,'maps',branchId),locations=pageAllRows(tables,'locations',branchId);
    const scope={chatId:IDS.chatA,branchId,revision:0,viewMode:'author'};
    const result=compileSceneGroup({request:{kind:'floor',spec:{rooms:[{id:'SECRET_PROXY_ROOM',w:6,h:5,side:'north'}],contents:[]}},
      scope,currentScope:scope,mapRow:maps.find(m=>m.id==='PROXY_MAP'),maps,locations,characters:[],items:[],routes:[],turnId,operationId:'secret_proxy'});
    assert.equal(result.ok,true,JSON.stringify(result.issues));
    const filtered=filterSceneForView(result.scene,{scope:{...scope,viewMode:'pov'},visibleLocations:['PROXY_PARENT'],visibleCharacters:[],visibleItems:[]});
    assert.equal(filtered.ok,true);
    assert.ok(!JSON.stringify(filtered.scene).includes('SECRET_PROXY_ROOM'));
  }finally{seed.close();}
});

test('PATCH-CROWD01 SQL occupant reconciliation keeps a crowded floor within the actor budget and keeps the protagonist',async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    const ids=Array.from({length:150},(_,n)=>`A_CROWD_${String(n).padStart(4,'0')}`);
    insertRows(seed.db,'entity_keys',ids.map(id=>({branch_id:branchId,id,kind:'character'})));
    insertRows(seed.db,'characters',ids.map(id=>row('characters',id,{name:id,location_id:IDS.L3,map_id:IDS.M2})));
    seed.db.run("UPDATE characters SET location_id=?,role='protagonist' WHERE branch_id=? AND id=?",[IDS.L3,branchId,IDS.C1]);
    const tables=createTableReadPort(seed.db),characters=pageAllRows(tables,'characters',branchId);
    const result=reconcileOccupantsSpec({scene:null,requestSpec:{rooms:[{id:IDS.L3,w:20,h:15,side:'north'}],contents:[]},
      characters,locations:pageAllRows(tables,'locations',branchId),items:[]});
    assert.equal(result.spec.actors.length,LIMITS.actors);
    assert.ok(result.spec.actors.some(a=>a.id===IDS.C1));
    assert.ok(result.issues.some(i=>i.code==='ACTOR_MARKER_BUDGET_DEFERRED'));
    assert.equal(pageAllRows(tables,'characters',branchId).length,characters.length,'no SQL entity is removed by a render budget');
  }finally{seed.close();}
});

test('PATCH-STATE01 protagonist after character 1000 still supplies the current location and full state roster',async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    const ids=[...Array.from({length:1005},(_,n)=>`A_STATE_${String(n).padStart(4,'0')}`),'Z_STATE_PLAYER'];
    insertRows(seed.db,'entity_keys',ids.map(id=>({branch_id:branchId,id,kind:'character'})));
    insertRows(seed.db,'characters',ids.map(id=>row('characters',id,{name:id,location_id:IDS.L3,role:id==='Z_STATE_PLAYER'?'protagonist':'npc'})));
    seed.db.run('UPDATE branches SET pov_character_id=? WHERE id=?',['Z_STATE_PLAYER',branchId]);
    const state=querySqlSceneState({db:seed.db,branchId,revision:0,viewMode:'author'},
      {chatUid:IDS.chatA,worldUid:'neutral-test-world',worldName:'Neutral test'});
    assert.equal(state.currentLocationId,IDS.L3);
    assert.ok(state.npcDirectory.some(r=>r.id==='Z_STATE_PLAYER'&&r.isProtagonist));
    assert.equal(state.readLimits.complete,true);
    assert.equal(state.tableMap.nearby.truncated,0);
  }finally{seed.close();}
});

test('PATCH-CROWD02 a location panel retains its full roster when only a subset can have scene markers',async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    const ids=Array.from({length:210},(_,n)=>`A_PANEL_${String(n).padStart(4,'0')}`);
    insertRows(seed.db,'entity_keys',ids.map(id=>({branch_id:branchId,id,kind:'character'})));
    insertRows(seed.db,'characters',ids.map(id=>row('characters',id,{name:id,location_id:IDS.L3})));
    const detail=queryEntityDetail({db:seed.db,branchId,revision:0,viewMode:'author'},
      {kind:'entity',entityId:IDS.L3,entityKind:'location'});
    const present=new Set(detail.items[0].present.map(r=>r.id));
    for(const id of ids)assert.ok(present.has(id),id);
  }finally{seed.close();}
});

test('PATCH-READ01 filtered keyset reads bind IDs and accept boolean filters without changing branch scope',async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    const read=createTableReadPort(seed.db);
    assert.deepEqual(read.selectWherePage('locations',{branch_id:branchId,id:"' OR 1=1 --"},null,500),[]);
    const bidirectional=read.selectWherePage('routes',{branch_id:branchId,bidirectional:[true]},null,500);
    assert.ok(bidirectional.length>0);
    assert.ok(bidirectional.every(r=>r.branch_id===branchId&&r.bidirectional===true));
  }finally{seed.close();}
});

test('PATCH-READ02 a nonadvancing port fails explicitly instead of returning a partial success',()=>{
  const duplicate={id:'same',branch_id:branchId};
  const port={selectOne(){return null;},selectWhere(){return [];},selectPage(){return [duplicate,duplicate];}};
  assert.throws(()=>pageAllRows(port,'locations',branchId,2),e=>e.code==='READ_CURSOR_INVALID');
});

for(const mpp of [.24,100])test(`PATCH-PROMPT01 unlocked calibrated ${mpp} m/cell is described consistently`,async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    seed.db.run('UPDATE maps SET meters_per_cell=?,scale_min_meters_per_cell=?,scale_max_meters_per_cell=?,scale_locked=0 WHERE branch_id=? AND id=?',[mpp,mpp,mpp,branchId,IDS.M1]);
    const task=buildSqlLayoutTask(seed.db,branchId,input({layoutMaps:[IDS.M1]}),turnId);
    assert.ok(task);
    assert.ok(task.request.messages[1].content.includes(`1 格 = ${mpp} 米`));
    assert.doesNotMatch(task.request.messages[1].content,/比例尺未锁定，按 1 格 = 1 单位处理/);
  }finally{seed.close();}
});

test('PATCH-PROMPT02 the model receives registered route endpoints and watercourse required fields',async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    const task=buildSqlLayoutTask(seed.db,branchId,input({layoutMaps:[IDS.M1]}),turnId),s=scopes(task)[0];
    const routeAlias=task.catalogue.knownRefs.find(r=>r.id===IDS.R_AB)?.alias;
    const route=s.routes?.find(r=>r.ref===routeAlias);
    assert.ok(route,'a route alias alone does not tell the model which endpoints it connects');
    assert.ok(route.from&&route.to);
    assert.equal(route.status,'open');
    for(const field of ['fromSector','toSector','widthClass'])assert.ok(task.request.messages[1].content.includes(field),field);
  }finally{seed.close();}
});

test('PATCH-HASH01 points and coordinates route encodings share a semantic signature, and point edits invalidate it',()=>{
  const a={kind:'polyline',points:[{x:1,y:2},{x:3,y:4}]};
  const b={kind:'polyline',coordinates:[[1,2],[3,4]]};
  assert.equal(canonicalRouteGeometry(a),canonicalRouteGeometry(b));
  assert.notEqual(canonicalRouteGeometry(a),canonicalRouteGeometry({...a,points:[{x:1,y:2},{x:4,y:4}]}));
});

test('PATCH-CACHE01 archived overview locations and closed links are pruned from old saved constraints',async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    const maps=pageAllRows(createTableReadPort(seed.db),'maps',branchId);
    const locations=pageAllRows(createTableReadPort(seed.db),'locations',branchId).map(l=>l.id===IDS.L2?{...l,status:'archived'}:l);
    const routes=pageAllRows(createTableReadPort(seed.db),'routes',branchId).map(r=>r.id===IDS.R_AB?{...r,status:'closed'}:r);
    const memberIds=collectSceneMemberIds({mapId:IDS.M1,maps,locations,characters:[],items:[],routes});
    const result=pruneInvalidSceneMembers({mapId:IDS.M1,scene:{constraints:{zones:[{id:IDS.L1},{id:IDS.L2}],links:[{id:IDS.R_AB}]}},memberIds});
    assert.ok(result.deletes.zones?.includes(IDS.L2));
    assert.ok(result.deletes.links?.includes(IDS.R_AB));
    assert.ok(!result.deletes.zones.includes(IDS.L1));
  }finally{seed.close();}
});

for(const kind of ['floor','city'])test(`PATCH-PROXY01 ${kind} entry proxy preserves the old exact physical coordinate`,async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    addLocations(seed.db,[['PROXY_PARENT',{kind:kind==='floor'?'building':'city',map_id:IDS.M1,grid_x:50,grid_y:50,coord_precision:'exact'}],
      ['PROXY_CHILD',{kind:kind==='floor'?'room':'building',parent_location_id:'PROXY_PARENT',map_id:IDS.M1,grid_x:55,grid_y:52,coord_precision:'exact'}]]);
    addMap(seed.db,'PROXY_MAP','PROXY_PARENT',{meters_per_cell:kind==='floor'?1:40,scale_quality:'estimated'});
    const maps=pageAllRows(createTableReadPort(seed.db),'maps',branchId),locations=pageAllRows(createTableReadPort(seed.db),'locations',branchId);
    const mapRow=maps.find(m=>m.id==='PROXY_MAP');
    const spec=kind==='floor'?{rooms:[{id:'PROXY_CHILD',name:'Registered room',w:6,h:5,side:'north'}],contents:[]}:
      {districts:[{id:'PROXY_PARENT',name:'Registered city',bank:'west',order:0}],buildings:[{id:'PROXY_CHILD',name:'Registered building',districtId:'PROXY_PARENT',w:30,h:25}],riverWidth:0,enclosure:'open'};
    const scope={chatId:IDS.chatA,branchId,revision:0,viewMode:'author'};
    const result=compileSceneGroup({request:{kind,spec},scope,currentScope:scope,mapRow,maps,locations,characters:[],items:[],routes:[],turnId,operationId:`proxy_${kind}`});
    assert.equal(result.ok,true,JSON.stringify(result.issues));
    const shape=(kind==='floor'?result.scene.layout.rooms:result.scene.layout.buildings).find(r=>r.id==='PROXY_CHILD');
    assert.equal(shape?.placement,'proxy');
    assert.ok(!result.group.mutations.some(m=>m.table==='locations'&&m.rowId==='PROXY_CHILD'));
    const actual=queryBound(seed.db,'SELECT map_id,grid_x,grid_y,coord_precision FROM locations WHERE branch_id=? AND id=?',[branchId,'PROXY_CHILD'])[0];
    assert.deepEqual(actual,{map_id:IDS.M1,grid_x:55,grid_y:52,coord_precision:'exact'});
    const task=buildSqlLayoutTask(seed.db,branchId,input({layoutMaps:['PROXY_MAP']}),turnId);
    const alias=task.catalogue.knownRefs.find(r=>r.id==='PROXY_CHILD')?.alias;
    assert.ok(scopes(task)[0].locations.some(l=>l.ref===alias),'logical child must also be sent to the model');
  }finally{seed.close();}
});
