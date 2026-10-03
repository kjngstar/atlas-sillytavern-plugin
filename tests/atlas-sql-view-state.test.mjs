import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import {makeSeedWith,insertRows,IDS} from './fixtures/atlas-sql/seed.mjs';
import {createRow} from '../src/atlas-db-defaults.ts';
import {querySqlSceneState} from '../src/atlas-sql-view-state.ts';
import {queryMapView,queryNearby,queryEntityDetail} from '../src/atlas-db-views.ts';
import {projectPortrayal} from '../src/atlas-db-knowledge-view.ts';
const SQL=await initSqlJs();
async function fixture(){const {db}=await makeSeedWith(SQL);return {db,ctx:{db,branchId:IDS.branchMain,revision:0,viewMode:'author',povId:IDS.C1}};}
const state=f=>querySqlSceneState(f.ctx,{chatUid:IDS.chatA,worldUid:'world-A',worldName:'合成世界'});
const move=(db,id,location,map=null,x=null,y=null)=>db.run('UPDATE characters SET location_id=?,map_id=?,grid_x=?,grid_y=?,coord_precision=? WHERE branch_id=? AND id=?',
  [location,map,x,y,map?'exact':'unknown',IDS.branchMain,id]);

test('Q06 one SQL revision supplies current location, map, nearby, sidebar directories and occupants without writes',async()=>{
  const f=await fixture();try{
    move(f.db,IDS.C1,IDS.L3,IDS.M2,2,3);move(f.db,IDS.C2,IDS.L3);
    const before=Buffer.from(f.db.export()),s=state(f);
    assert.deepEqual(Buffer.from(f.db.export()),before);
    assert.equal(s.currentLocationId,IDS.L3);assert.equal(s.npcDirectory.find(ch=>ch.id===IDS.C1).locationId,IDS.L3);
    assert.deepEqual(s.tableMap.current.chain.map(loc=>loc.id),[IDS.L3,IDS.L2,IDS.L1]);
    assert.ok(s.sqlViews.nearby.items.some(ch=>ch.entityId===IDS.C2));
    assert.deepEqual(s.tableMap.locationOccupants.entries.find(loc=>loc.locationId===IDS.L3).characterIds,[IDS.C1,IDS.C2]);
    for(const view of Object.values(s.sqlViews)){assert.equal(view.revision,s.revision);assert.equal(view.branchId,s.branchId);}
    const point=s.sqlViews.map.items.find(m=>m.mapId===IDS.M2).points.find(p=>p.entityId===IDS.C1);
    assert.equal(point.locationId,IDS.L3);assert.equal(point.isProtagonist,true);
  }finally{f.db.close();}
});

test('Q06 archiving a character clears maps, nearby, location detail and state directories in the same snapshot',async()=>{
  const f=await fixture();try{
    move(f.db,IDS.C1,IDS.L3);move(f.db,IDS.C2,IDS.L3,IDS.M2,3,4);
    f.db.run("UPDATE characters SET status='archived' WHERE branch_id=? AND id=?",[IDS.branchMain,IDS.C2]);
    const s=state(f);assert.equal(s.npcDirectory.some(ch=>ch.id===IDS.C2),false);
    assert.equal(s.sqlViews.nearby.items.some(ch=>ch.entityId===IDS.C2),false);
    assert.equal(s.sqlViews.map.items.some(m=>m.points.some(p=>p.entityId===IDS.C2)||m.coarseList.some(p=>p.entityId===IDS.C2)),false);
    assert.equal(queryEntityDetail(f.ctx,{kind:'entity',branchId:IDS.branchMain,entityId:IDS.L3}).items[0].present.some(ch=>ch.id===IDS.C2),false);
  }finally{f.db.close();}
});

test('Q06 a 12 by 8 room displays 50 unknown fine positions inside its frame; city map aggregates them at the school',async()=>{
  const f=await fixture();try{
    f.db.run('UPDATE maps SET frame_json=? WHERE branch_id=? AND id=?',[JSON.stringify({cols:12,rows:8}),IDS.branchMain,IDS.M2]);
    for(let i=0;i<50;i++){
      const id=`student-${String(i).padStart(2,'0')}`;
      insertRows(f.db,'entity_keys',[{branch_id:IDS.branchMain,id,kind:'character'}]);
      insertRows(f.db,'characters',[createRow('characters',{name:`学生${i}`,location_id:IDS.L3},{branchId:IDS.branchMain,id,turnId:IDS.seedTurn,clockS:0,nowWallMs:0,rulesetVersion:'atlas-1'})]);
    }
    const before=Buffer.from(f.db.export()),s=state(f);
    const room=s.sqlViews.map.items.find(m=>m.mapId===IDS.M2),pins=room.points.filter(p=>p.kind==='character');
    assert.equal(pins.length,50);assert.equal(new Set(pins.map(p=>`${p.x},${p.y}`)).size,50);
    for(const p of pins){assert.ok(p.x>0&&p.x<12&&p.y>0&&p.y<8);assert.equal(p.markerQuality,'layout');}
    const city=s.sqlViews.map.items.find(m=>m.mapId===IDS.M1);
    assert.equal(city.points.some(p=>p.entityId.startsWith('student-')),false);
    assert.equal(city.coarseList.filter(p=>p.entityId.startsWith('student-')&&p.locationId===IDS.L2).length,50);
    assert.deepEqual(Buffer.from(f.db.export()),before,'layout coordinates are display-only');
  }finally{f.db.close();}
});

test('Q06 sharing a large map is not proximity; exact room coordinates and coarse same-room presence still agree',async()=>{
  const f=await fixture();try{
    move(f.db,IDS.C1,IDS.L3,IDS.M2,2,3);move(f.db,IDS.C2,IDS.L3);
    const nearby=queryNearby(f.ctx,{kind:'nearby',branchId:IDS.branchMain,entityId:IDS.C1});
    assert.ok(nearby.items.some(ch=>ch.entityId===IDS.C2));assert.equal(nearby.items.some(ch=>ch.entityId===IDS.C3),false);
    move(f.db,IDS.C1,IDS.L2,IDS.M1,11,12);move(f.db,IDS.C2,IDS.L1,IDS.M1,12,12);
    assert.equal(queryNearby(f.ctx,{kind:'nearby',branchId:IDS.branchMain,entityId:IDS.C1}).items.some(ch=>ch.entityId===IDS.C2),false);
  }finally{f.db.close();}
});

test('Q06 a departed traveler is absent from its old room, nearby, location detail and narrator portrayal',async()=>{
  const f=await fixture();try{
    move(f.db,IDS.C1,IDS.L3);move(f.db,IDS.C2,IDS.L3,IDS.M2,3,4);
    insertRows(f.db,'actions',[createRow('actions',{actor_entity_id:IDS.C2,kind:'travel',status:'active'},{branchId:IDS.branchMain,id:'travel',turnId:IDS.seedTurn,clockS:0,nowWallMs:0,rulesetVersion:'atlas-1'})]);
    insertRows(f.db,'journeys',[createRow('journeys',{action_id:'travel',mover_entity_id:IDS.C2,origin_location_id:IDS.L3,destination_location_id:IDS.L1,status:'moving'},{branchId:IDS.branchMain,id:'journey',turnId:IDS.seedTurn,clockS:0,nowWallMs:0,rulesetVersion:'atlas-1'})]);
    const s=state(f);assert.equal(s.npcDirectory.find(ch=>ch.id===IDS.C2).locationId,null);
    assert.equal(s.sqlViews.nearby.items.some(ch=>ch.entityId===IDS.C2),false);
    assert.equal(s.sqlViews.map.items.find(m=>m.mapId===IDS.M2).points.some(p=>p.entityId===IDS.C2),false);
    assert.equal(queryEntityDetail(f.ctx,{kind:'entity',branchId:IDS.branchMain,entityId:IDS.L3}).items[0].present.some(ch=>ch.id===IDS.C2),false);
    assert.equal(projectPortrayal(f.ctx,{locationId:IDS.L3}).entries.some(ch=>ch.entityId===IDS.C2),false);
  }finally{f.db.close();}
});

test('Q06 POV map and detail hide remote current positions and thoughts; author UI retains them without changing knowledge',async()=>{
  const f=await fixture();try{
    f.db.run("UPDATE characters SET thought='远方密谋',location_id=? WHERE branch_id=? AND id=?",[IDS.L1,IDS.branchMain,IDS.C3]);
    const q={kind:'map',branchId:IDS.branchMain},author=queryMapView(f.ctx,q),pov=queryMapView({...f.ctx,viewMode:'pov'},q);
    assert.ok(author.items.some(m=>m.points.some(p=>p.entityId===IDS.C3)||m.coarseList.some(p=>p.entityId===IDS.C3)));
    assert.equal(pov.items.some(m=>m.points.some(p=>p.entityId===IDS.C3)||m.coarseList.some(p=>p.entityId===IDS.C3)),false);
    const detail=queryEntityDetail({...f.ctx,viewMode:'pov'},{kind:'entity',branchId:IDS.branchMain,entityId:IDS.C1});
    assert.equal(detail.items[0].character.id,IDS.C1);
    assert.deepEqual(queryEntityDetail({...f.ctx,viewMode:'pov'},{kind:'entity',branchId:IDS.branchMain,entityId:IDS.C3}).items,[]);
    assert.equal(f.db.exec('SELECT COUNT(*) FROM knowledge')[0].values[0][0],0);
  }finally{f.db.close();}
});
