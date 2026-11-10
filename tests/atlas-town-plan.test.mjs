import test from 'node:test';
import assert from 'node:assert/strict';
import { projectReferenceData } from '../ui/atlas-reference-data.mjs';
import { filterSceneForView } from '../vendor/atlas-spatial/view-adapter.mjs';

const point = (x, y) => ({ x, y });
const polygon = (x, y, w, h) => [point(x,y), point(x+w,y), point(x+w,y+h), point(x,y+h)];

test('town plan combines saved crossings, parcels and visible terrain in one map frame', () => {
  const map = {
    mapId:'town', name:'镇', containerLocationId:'T', containerLocationKind:'city', metersPerCell:2,
    points:[
      {kind:'location',entityId:'lake',name:'湖',terrain:'lake',x:20,y:100,area:{kind:'polygon',points:polygon(10,90,50,35)}},
      {kind:'location',entityId:'hidden',name:'隐林',terrain:'forest',x:20,y:20,hidden:true,area:{kind:'polygon',points:polygon(10,10,40,20)}},
    ],
    routes:[
      {kind:'path',routeId:'path',fromLocationId:'inn',toLocationId:'lake',geometry:{mapId:'town',units:'cells',points:[point(5,20),point(15,20),point(15,70)]}},
      {kind:'road',routeId:'hidden',fromLocationId:'inn',toLocationId:'hidden',geometry:{mapId:'town',units:'cells',points:[point(5,20),point(5,70)]}},
      {kind:'road',routeId:'no-shape',fromLocationId:'inn',toLocationId:'lake',geometry:null},
    ],
  };
  const layout = {
    id:'town',name:'镇',kind:'city',enclosure:'open',bounds:{x:0,y:0,w:400,h:280},
    districts:[{id:'T',name:'镇',site:point(100,140),polygon:polygon(0,0,400,280)}],
    buildings:[{id:'inn',name:'酒馆',districtId:'T',x:30,y:30,w:40,h:30}],
    roads:[{id:'avenue',a:point(40,100),b:point(350,100),width:14}],
    segments:[{id:'deck',roadId:'avenue',kind:'bridge',a:point(190,100),b:point(210,100),width:14}],
    river:{cx:200,amplitude:0,width:20,height:280},riverPolygon:polygon(190,0,20,280),wall:[],gates:[],dock:{x:190,y:150,width:7},
  };
  const scene = {kind:'atlas-scene',version:1,generator:'fixture',mapId:'town',branchId:'main',sourceRevision:1,units:'meters',metersPerCell:2,layout};
  const scope = {branchId:'main',viewMode:'pov'};
  const visibleLocations = ['T','inn','lake'];
  const filtered = filterSceneForView(scene,{scope,visibleLocations});
  assert.ok(filtered.ok,JSON.stringify(filtered.issues));
  const data = {
    mapView:{items:[map,{mapId:'inn-map',name:'酒馆',containerLocationId:'inn',containerLocationKind:'building',parentMapId:'town'}]},
    catalogView:{items:visibleLocations.map(entityId=>({entityId,entityKind:'location',mapId:'town'}))},
    sceneView:{items:[{mapId:'town',scene:filtered.scene}]},
    viewMode:'pov',
  };
  const before = JSON.stringify(data);
  const node = projectReferenceData(data).ROOT;
  const plan = node.geo.townPlan;
  assert.deepEqual(plan.streets.map(s=>[s.id,s.kind]),[['path','path'],['avenue','road']]);
  assert.deepEqual(plan.streets[0].points,[[-380,-200],[-340,-200],[-340,0]]);
  assert.deepEqual(plan.bridges[0].points,[[-20,-80],[20,-80]]);
  assert.deepEqual(plan.terrain.map(t=>t.id),['lake',undefined]);
  assert.equal(plan.parcels[0].id,'inn');
  assert.equal(node.marks.find(m=>m.id==='inn').node.id,'inn-map');
  assert.equal(node.geo.exploration,undefined);
  assert.equal(JSON.stringify(data),before);
});
