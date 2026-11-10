import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLayoutSpec } from '../src/atlas-ops-normalize.ts';
import { compileSceneGroup, filterSceneForView } from '../vendor/atlas-spatial/index.mjs';
import { segmentIntersectsRect, water } from '../vendor/atlas-spatial/layout-core.mjs';
import { projectReferenceData } from '../ui/atlas-reference-data.mjs';

const scope = {chatId:'town-chat',branchId:'main',revision:0,viewMode:'author'};
const row = (id,kind,parent) => ({
  id, name:id, kind, parent_location_id:parent, map_id:parent?'map':null,
  branch_id:'main', status:'active', row_rev:1,
});
function fixture(){
  const mapRow = {id:'map',name:'Town',container_location_id:'town',frame_json:{cols:820,rows:460},
    meters_per_cell:1,scale_quality:'estimated',branch_id:'main',status:'active',row_rev:1};
  const locations = [row('town','city',null),row('west','district','town'),
    row('forest','natural','town'),row('woods','natural','town'),row('lake','natural','town'),
    row('inn','building','west'),row('shop','building','west'),row('clinic','building','west')];
  return {
    request:{kind:'city',spec:{streetPattern:'main-street',riverWidth:24,enclosure:'open',districts:[
      {id:'west',bank:'west',order:0},
      {id:'lake',bank:'west',order:1,role:'lake'},
      {id:'forest',bank:'east',order:0,role:'forest'},
      {id:'woods',bank:'east',order:1,role:'woods'},
    ],buildings:[{id:'inn',districtId:'west',w:42,h:32},{id:'shop',districtId:'west',w:37,h:29}]}},
    scope,currentScope:scope,mapRow,maps:[mapRow],locations,characters:[],items:[],routes:[],
    turnId:'first',operationId:'first',
  };
}
function compile(input){
  const normalized=normalizeLayoutSpec(input.request);
  assert.equal(normalized.ok,true,JSON.stringify(normalized.issues));
  const result=compileSceneGroup({...input,request:{...input.request,spec:normalized.spec}});
  assert.equal(result.ok,true,JSON.stringify(result.issues));
  assert.deepEqual(result.issues,[]);
  return result;
}

test('main-street layout compiles parcels around a continuous network with terrain and bridges',()=>{
  const input=fixture(),{scene}=compile(input);
  const {layout}=scene;
  const bridges=layout.segments.filter(s=>s.kind==='bridge');
  assert.equal(bridges.length,2);
  for(const b of bridges)assert.ok(water(layout.river,{x:(b.a.x+b.b.x)/2,y:(b.a.y+b.b.y)/2}));
  const paths=layout.roads.filter(r=>r.kind==='path');
  assert.ok(paths.length>=2);
  paths.slice(1).forEach((path,i)=>assert.deepEqual(path.a,paths[i].b));
  assert.ok(paths.every(path=>!water(layout.river,path.a)&&!water(layout.river,path.b)));
  assert.equal(layout.buildings.length,2);
  for(const b of layout.buildings){
    assert.ok(layout.roads.every(r=>!segmentIntersectsRect(r.a,r.b,
      {x:b.x-r.width/2,y:b.y-r.width/2,w:b.w+r.width,h:b.h+r.width})));
  }
  const visibleLocations=input.locations.map(l=>l.id);
  const pov={scope:{...scope,viewMode:'pov'},visibleLocations};
  const filtered=filterSceneForView(scene,pov);
  assert.ok(filtered.ok);
  const plan=projectReferenceData({mapView:{items:[{mapId:'map',name:'Town',containerLocationId:'town',
    containerLocationKind:'city',metersPerCell:1,points:[],routes:[]}]},sceneView:{items:[{mapId:'map',scene:filtered.scene}]},
    catalogView:{items:input.locations.map(l=>({entityId:l.id,entityKind:'location',name:l.name,mapId:'map'}))},viewMode:'pov'}).ROOT.geo.townPlan;
  assert.equal(plan.bridges.length,2);
  assert.equal(plan.streets.filter(r=>r.kind==='path').length,paths.length);
  assert.deepEqual(plan.terrain.map(t=>t.kind).sort(),['forest','water','water','woods']);
  const hidden=filterSceneForView(scene,{...pov,visibleLocations:visibleLocations.filter(id=>!['forest','woods'].includes(id))}).scene.layout;
  assert.ok(hidden.roads.every(r=>r.kind!=='path'));
  assert.ok(hidden.segments.every(r=>r.kind!=='bridge'));
});

test('incremental city requests retain the street pattern, river and existing footprints',()=>{
  const input=fixture(),first=compile(input);
  const updates=new Map(first.group.mutations.map(m=>[m.rowId,m.after]));
  const mapRow=updates.get(input.mapRow.id);
  const next=compile({...input,mapRow,maps:[mapRow],locations:input.locations.map(l=>updates.get(l.id)??l),
    request:{kind:'city',spec:{buildings:[{id:'clinic',districtId:'west',w:35,h:29}]}},turnId:'next',operationId:'next'});
  assert.deepEqual(next.scene.layout.roads,first.scene.layout.roads);
  assert.deepEqual(next.scene.layout.districts,first.scene.layout.districts);
  for(const b of first.scene.layout.buildings)assert.deepEqual(next.scene.layout.buildings.find(p=>p.id===b.id),b);
  assert.equal(next.scene.layout.buildings.length,3);
});

test('automatic town layouts keep legal parcels when a proximity hint cannot fit',()=>{
  const input=fixture();
  input.autoPlan=true;
  const buildings=input.request.spec.buildings;
  buildings[1]={...buildings[1],near:'inn',sector:'east',gapM:1000};
  const first=compileSceneGroup(input);
  assert.equal(first.ok,true,JSON.stringify(first.issues));
  assert.ok(first.issues.some(i=>i.code==='BUILDING_PROXIMITY_UNPLACED'&&i.severity==='warning'));
  assert.equal(first.scene.layout.buildings.length,2);
  assert.equal(first.scene.layout.segments.filter(s=>s.kind==='bridge').length,2);

  const updates=new Map(first.group.mutations.map(m=>[m.rowId,m.after]));
  const mapRow=updates.get(input.mapRow.id);
  const next=compileSceneGroup({...input,mapRow,maps:[mapRow],locations:input.locations.map(l=>updates.get(l.id)??l),
    request:{kind:'city',spec:{buildings:[{id:'clinic',districtId:'west',w:35,h:29,near:'inn'}]}},
    turnId:'next',operationId:'next'});
  assert.equal(next.ok,true,JSON.stringify(next.issues));
  assert.deepEqual(next.scene.layout.roads,first.scene.layout.roads);
  for(const b of first.scene.layout.buildings)assert.deepEqual(next.scene.layout.buildings.find(p=>p.id===b.id),b);
  assert.equal(next.scene.layout.buildings.length,3);
});

test('automatic town projects district buildings and road-connected bridges without changing ownership',()=>{
  const input=fixture();
  input.autoPlan=true;
  const westMap={...input.mapRow,id:'west-map',container_location_id:'west'};
  input.maps.push(westMap);
  input.locations=input.locations.filter(l=>!['forest','woods','clinic'].includes(l.id))
    .map(l=>l.kind==='building'?{...l,map_id:westMap.id}:l);
  input.locations.push({...row('north-bridge','other','town'),name:'铜铃桥'},{...row('south-bridge','other','town'),name:'船工桥'});
  input.routes=['north-bridge','south-bridge'].map(id=>({id:'route-'+id,branch_id:'main',map_id:'map',
    from_location_id:'west',to_location_id:id,kind:'road',status:'open',row_rev:1}));
  input.request.spec.districts=input.request.spec.districts.filter(d=>d.bank==='west');
  input.request.spec.buildings=[];
  const first=compile(input);
  assert.deepEqual(first.scene.layout.buildings.map(b=>[b.id,b.placement]),[['inn','proxy'],['shop','proxy']]);
  const {segments,bridgeLocations}=first.scene.layout;
  assert.equal(segments.filter(s=>s.kind==='bridge').length,2);
  assert.deepEqual(bridgeLocations.map(b=>b.id),['north-bridge','south-bridge']);
  assert.ok(first.group.mutations.some(m=>m.rowId==='north-bridge'&&m.after.coord_precision==='layout'));
  assert.ok(!first.group.mutations.some(m=>['inn','shop'].includes(m.rowId)));

  const updates=new Map(first.group.mutations.map(m=>[m.rowId,m.after]));
  const mapRow=updates.get(input.mapRow.id);
  const next=compile({...input,mapRow,maps:[mapRow,westMap],locations:[
    ...input.locations.map(l=>updates.get(l.id)??l),{...row('clinic','building','west'),map_id:westMap.id},
  ],routes:input.routes.map(r=>updates.get(r.id)??r),request:{kind:'city',spec:{}},turnId:'next',operationId:'next'});
  assert.deepEqual(next.scene.layout.roads,first.scene.layout.roads);
  assert.deepEqual(next.scene.layout.bridgeLocations,bridgeLocations);
  assert.equal(next.scene.layout.buildings.length,3);
  for(const b of first.scene.layout.buildings)assert.deepEqual(next.scene.layout.buildings.find(p=>p.id===b.id),b);
  const pov=filterSceneForView(next.scene,{scope:{...scope,viewMode:'pov'},visibleLocations:['west','inn','north-bridge']});
  assert.ok(pov.ok);
  assert.equal(pov.scene.layout.segments.filter(s=>s.kind==='bridge').length,1);
});
