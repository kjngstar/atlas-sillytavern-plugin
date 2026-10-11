import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMapAnalysisExport} from '../ui/atlas-map-export.mjs';
import {projectReferenceData} from '../ui/atlas-reference-data.mjs';
const view=items=>({branchId:'main',revision:3,items});
function fixture(viewMode='author'){
 const mapView=view([
  {mapId:'world',name:'世界',kind:'world',parentMapId:null,points:[{entityId:'L1',name:'旅店',kind:'location',x:1,y:1}]},
  {mapId:'house',name:'测试/旅店',kind:'site',containerLocationId:'L1',containerLocationKind:'building',parentMapId:'world',points:[{entityId:'L2',name:'客房',kind:'location',x:3,y:2}]},
  {mapId:'room',name:'客房',kind:'interior',containerLocationId:'L2',containerLocationKind:'room',parentMapId:'house',points:[]},
  {mapId:'other',name:'另一场所',kind:'site',parentMapId:'world',points:[]},
 ]);
 const sceneView=view([{mapId:'house',sceneStatus:'ready',scene:{units:'meters',constraints:{rooms:[{id:'L2',w:8,h:5}]},layout:{kind:'floor',bounds:{x:0,y:0,w:12,h:8},corridor:{x:0,y:0,w:0,h:0},rooms:[{id:'L2',name:'客房',x:1,y:1,w:8,h:5}],doors:[],actors:[],groups:[]}}}]);
 const catalogView=view([{entityKind:'location',entityId:'L1',name:'旅店',mapId:'world'}, {entityKind:'location',entityId:'L2',name:'客房',parentLocationId:'L1',mapId:'house'}]);
 const data=projectReferenceData({mapView,sceneView,catalogView,viewMode});
 data.PROMPTS=[{apiKey:'must-not-export',prompt:'private source'}];data.LORE=[{content:'private source'}];
 return {mapView,sceneView,catalogView,data,mapId:'house',exportedAt:'2026-10-11T00:00:00Z'};
}
test('exports current map and descendants with source constraints and matching rendered geometry',()=>{
 const f=fixture(),result=buildMapAnalysisExport(f);
 assert.equal(result.file.kind,'atlas-map-analysis');assert.equal(result.file.scope.mapCount,2);
 assert.deepEqual(result.file.maps.map(m=>m.mapId),['house','room']);
 assert.deepEqual(result.file.maps[0].scene,f.sceneView.items[0].scene);
 assert.equal(result.file.maps[1].scene,null);assert.equal(result.file.maps[1].sceneStatus,'missing');
 assert.equal(result.file.maps[0].rendered.geometry.rooms[0].id,'L2');
 assert.equal(result.file.locations.find(l=>l.id==='L2').parentLocationId,'L1');
 assert.equal(result.filename,'atlas-map-测试_旅店-r3.json');
 assert.doesNotMatch(JSON.stringify(result.file),/must-not-export|private source/);
 result.file.maps[0].scene.layout.rooms[0].x=99;assert.equal(f.sceneView.items[0].scene.layout.rooms[0].x,1);
});
test('POV export only uses filtered DTO maps and preserves the mode',()=>{
 const f=fixture('pov');f.mapView.items=f.mapView.items.filter(m=>m.mapId!=='other');
 const result=buildMapAnalysisExport(f);assert.equal(result.file.scope.viewMode,'pov');
 assert.ok(result.file.maps.every(m=>m.mapId!=='other'));
});
test('repeated navigation projections export each map only once',()=>{
 const f=fixture(),house=f.data.ROOT.children.find(n=>n.id==='house');
 house.children.push({...house.children.find(n=>n.id==='room'),children:[]});
 const result=buildMapAnalysisExport(f);
 assert.equal(result.file.scope.mapCount,2);
 assert.equal(new Set(result.file.maps.map(m=>m.mapId)).size,2);
});
test('rejects unavailable maps, mismatched revisions, incomplete source pages',()=>{
 assert.throws(()=>buildMapAnalysisExport({...fixture(),mapId:'absent'}),/请选择/);
 const stale=fixture();stale.sceneView.revision=4;assert.throws(()=>buildMapAnalysisExport(stale),/修订/);
 const incomplete=fixture();incomplete.mapView.nextCursor='more';assert.throws(()=>buildMapAnalysisExport(incomplete),/截断/);
 const incompleteCatalog=fixture();incompleteCatalog.catalogView.nextCursor='more';assert.throws(()=>buildMapAnalysisExport(incompleteCatalog),/截断/);
 const missing=fixture();missing.mapView.items=missing.mapView.items.filter(m=>m.mapId!=='room');assert.throws(()=>buildMapAnalysisExport(missing),/来源不完整/);
});
