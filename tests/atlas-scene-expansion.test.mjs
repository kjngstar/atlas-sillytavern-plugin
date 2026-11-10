import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSqlModule,queryBound} from '../src/atlas-db-runtime.ts';
import {createRow} from '../src/atlas-db-defaults.ts';
import {createTableReadPort} from '../src/atlas-db-readport.ts';
import {applyGroups} from '../src/atlas-db-commit.ts';
import {compileSqlSceneMaps} from '../src/atlas-sql-scene-maps.ts';
import {sceneExpansionLocationIds} from '../src/atlas-scene-expansion.ts';
import {plannedSceneLocationIds} from '../src/atlas-spatial-planning.ts';
import {buildSqlLayoutTask} from '../src/atlas-sql-layout-task.ts';
import {IDS,makeSeedWith,insertRows} from './fixtures/atlas-sql/seed.mjs';
const SQL=await loadSqlModule();
const context={branchId:IDS.branchMain,turnId:IDS.seedTurn,clockS:0,nowWallMs:1,rulesetVersion:'atlas-1'};
const layoutInput={anchor:{chatUid:IDS.chatA,branchId:IDS.branchMain,baseRevision:0,baseStorageRevision:0},layoutMaps:'active',sourceSnapshot:[],userText:'',assistantText:''};
function location(db,id,kind,parent=null){
 insertRows(db,'entity_keys',[{branch_id:IDS.branchMain,id,kind:'location'}]);
 insertRows(db,'locations',[createRow('locations',{name:id,kind,parent_location_id:parent}, {...context,id})]);
}
function compile(db,plannedLocationIds=[]){return compileSqlSceneMaps({db,branchId:IDS.branchMain,turnId:IDS.seedTurn,clockS:0,ensureScenes:true,plannedLocationIds,makeId:(kind,op,alias)=>kind+'-'+alias});}
function apply(db,group){if(!group)return;const r=applyGroups(db,[group],{branchId:IDS.branchMain,turnId:IDS.seedTurn,attemptId:'expansion',validate:true});assert.ok(!r.groups.some(g=>g.status==='rejected'||g.status==='blocked'),JSON.stringify(r));}
const childMap=(db,id)=>queryBound(db,"SELECT * FROM maps WHERE branch_id=? AND container_location_id=? AND status='active'",[IDS.branchMain,id]);

test('外观和只有名字的房间留标记；NPC落点、明确子空间及祖先展开，不按地点名字猜',()=>{
 const locations=[{id:'town',kind:'city'},{id:'shop',kind:'building',parent_location_id:'town'},{id:'remote',kind:'room',parent_location_id:'town'},{id:'npc-house',kind:'building',parent_location_id:'town'},{id:'post',kind:'building',parent_location_id:'town'},{id:'hall',kind:'room',parent_location_id:'post'}];
 const ids=sceneExpansionLocationIds({locations,characters:[{location_id:'npc-house',status:'active'},{location_id:'shop',status:'archived'}]});
 assert.deepEqual([...ids].sort(),['npc-house','post','town']);
 assert.ok(!ids.has('shop')&&!ids.has('remote')&&!ids.has('hall'));
 assert.ok(sceneExpansionLocationIds({locations,plannedLocationIds:['hall']}).has('hall'));
});

test('真实SQL：外部地点没有空子图，父图有标记；NPC的内部地图不因主角未到访而延期',async()=>{
 const seed=await makeSeedWith(SQL),db=seed.db;
 try{
  location(db,'town','city');location(db,'exterior','building','town');location(db,'npc-house','building','town');
  insertRows(db,'entity_keys',[{branch_id:IDS.branchMain,id:'remote-npc',kind:'character'}]);
  insertRows(db,'characters',[createRow('characters',{name:'远处NPC',role:'npc',location_id:'npc-house'}, {...context,id:'remote-npc'})]);
  apply(db,compile(db));
  assert.equal(childMap(db,'exterior').length,0);assert.equal(childMap(db,'npc-house').length,1);assert.equal(childMap(db,'town').length,1);
  const marker=createTableReadPort(db).selectOne('locations',IDS.branchMain,'exterior');assert.equal(marker.map_id,childMap(db,'town')[0].id);assert.ok(Number.isFinite(marker.grid_x)&&Number.isFinite(marker.grid_y));
  const task=buildSqlLayoutTask(db,IDS.branchMain,layoutInput,IDS.seedTurn);
  assert.ok([...task.mapIds,...task.remainingLocationIds].includes(childMap(db,'npc-house')[0].id));
  const before=childMap(db,'npc-house')[0].id;db.run("UPDATE characters SET location_id=NULL WHERE id='remote-npc'");apply(db,compile(db));assert.equal(childMap(db,'npc-house')[0].id,before,'离开不删除已有地图');
  db.run("UPDATE characters SET location_id='exterior' WHERE id='remote-npc'");apply(db,compile(db));assert.equal(childMap(db,'exterior').length,1,'后来实际进入时，原标记增量展开，不重建地点');
 }finally{seed.close();}
});

test('同批明确的内部约束能展开无人房间；空布局不能把外部标记升级为子图',async()=>{
 const seed=await makeSeedWith(SQL),db=seed.db;
 try{
  location(db,'town','city');location(db,'room','room','town');location(db,'outside','building','town');
  const refs=['room','outside'].map(id=>({id,alias:'new:'+id,kind:'location',rowRev:1,declaredByOpId:'op-'+id}));
  const drafts=[{op:'map.layout.request',data:{container_ref:'new:room',kind:'floor',spec:{rooms:[{id:'new:room',w:8,h:6}],contents:[{id:'table',type:'table',w:2,h:1}]}}},{op:'map.layout.request',data:{container_ref:'new:outside',kind:'overview',spec:{zones:[],features:[],links:[]}}}];
  const planned=plannedSceneLocationIds(drafts,refs);assert.deepEqual(planned,['room']);
  assert.deepEqual(plannedSceneLocationIds([{op:'map.layout.request',data:{container_ref:'new:outside',kind:'floor',spec:{rooms:[{id:'unknown-room',w:8,h:6}]}}}],refs),[]);
  apply(db,compile(db,planned));
  assert.equal(childMap(db,'outside').length,0);assert.equal(childMap(db,'room').length,1);
  const task=buildSqlLayoutTask(db,IDS.branchMain,layoutInput,IDS.seedTurn,undefined,{eagerLocationIds:planned});
  assert.ok([...task.mapIds,...task.remainingLocationIds].includes(childMap(db,'room')[0].id),'明确内部不等主角进入');
 }finally{seed.close();}
});
