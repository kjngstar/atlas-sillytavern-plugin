import test from 'node:test';
import assert from 'node:assert/strict';
import {mapDetailLevel,regionOverview} from '../ui/atlas-map-layers.mjs';
import {projectReferenceData} from '../ui/atlas-reference-data.mjs';
import {projectExplorationMaps} from '../ui/atlas-exploration-map.mjs';
const view=items=>({items});
const area=p=>Math.abs(p.reduce((s,a,i)=>{const b=p[(i+1)%p.length];return s+a[0]*b[1]-b[0]*a[1];},0))/2;
test('已保存城市的街道、街区和建筑不被上层色块总览替换',()=>{
 const city={id:'city',containerLocationKind:'city',transform:{scaleQuality:'estimated'},geo:{districts:[{id:'D',pts:[[0,0],[100,0],[100,100],[0,100]]}],avenues:[{from:[0,50],to:[100,50]}],cityBuildings:[{id:'B',x:5,y:5,w:10,h:10}]},children:[]};
 const child={id:'district',containerLocationId:'D',containerLocationKind:'district',parentMapId:'city',geo:{},children:[]};city.children=[child];
 const before=JSON.stringify(city.geo);projectExplorationMaps(new Map([['city',city],['district',child]]),[{id:'D'}],{viewMode:'author'});
 assert.equal(JSON.stringify(city.geo),before);assert.equal(city.geo.exploration,undefined);
});

test('绘图细节按空间语义选择，场所可连续嵌套，街区与房间仍用详细布局',()=>{
 for(const kind of ['world','region','city'])assert.equal(mapDetailLevel({containerLocationKind:kind}),'regions');
 for(const kind of ['district','building','floor','room','vehicle'])assert.equal(mapDetailLevel({containerLocationKind:kind}),'detail');
 assert.equal(mapDetailLevel({containerLocationKind:'other',renderKind:'region'}),'layout');
});

test('区域地点使用分开的方块轮廓，不取子房间轮廓，不改原落点，重排输入结果一致',()=>{
 const children=['west','middle','east'].map((id,i)=>({id,containerLocationId:id,name:id,geo:{rooms:[{x:0,y:0,w:8,h:8}],furn:[{type:'desk'}]},children:[]}));
 const n={geo:{},marks:children.map((c,i)=>({id:c.id,type:'poi',x:i*200,y:0}))};
 const before=JSON.stringify({n,children}),s=regionOverview(n,children);
 assert.equal(s.level,'regions');assert.equal(s.areas.length,3);assert.equal(new Set(s.areas.map(a=>a.c)).size,3);
 assert.ok(s.areas.every(a=>!a.details&&!a.bridge&&area(a.parts[0])>1000));
 assert.deepEqual(s.areas.map(a=>[a.x,a.y]),[[400,0],[200,0],[0,0]]);
 assert.deepEqual(regionOverview(n,[...children].reverse()),s);assert.equal(JSON.stringify({n,children}),before);
 assert.equal(s.surface.outlines.length,0);assert.equal(s.displayOnly,true);
 // Empty space remains between footprints; never partition the whole map into territories.
 const xs=s.areas.map(a=>a.parts[0].map(p=>p[0]+a.x));
 assert.ok(Math.min(...xs[0])>Math.max(...xs[1]));assert.ok(Math.min(...xs[1])>Math.max(...xs[2]));
 assert.ok(s.areas.every(a=>a.parts[0].length===4));
});

test('真实投影逐层从色块到轮廓再到陈设，所有显示变更均不写回场景',()=>{
 const spec=[['world',null,null,'world'],['region','world','R','region'],['site','region','S','other'],['building','site','B','building'],['room','building','H','room']];
 const maps=spec.map(([mapId,parentMapId,containerLocationId,containerLocationKind])=>({mapId,parentMapId,containerLocationId,containerLocationKind,name:mapId,kind:containerLocationKind??'world',points:[]}));
 const roomScene={units:'meters',layout:{kind:'floor',bounds:{x:0,y:0,w:8,h:8},corridor:{x:0,y:0,w:0,h:0},rooms:[{id:'H',name:'房间',x:0,y:0,w:8,h:8}],groups:[{id:'desk',roomId:'H',bodies:[{id:'d',type:'table',x:1,y:1,w:2,h:1}]}],doors:[]}};
 const catalog=spec.filter(s=>s[2]).map(([,parentMapId,entityId,locationKind])=>({entityKind:'location',entityId,locationKind,mapId:parentMapId,name:entityId}));
 const before=JSON.stringify({maps,roomScene});
 const d=projectReferenceData({mapView:view(maps),catalogView:view(catalog),sceneView:view([{mapId:'room',scene:roomScene}]),viewMode:'author'});
 const root=d.ROOT,region=root.children[0],site=region.children[0],building=site.children[0],room=building.children[0];
 assert.equal(root.geo.exploration.level,'regions');assert.equal(region.geo.exploration.level,'regions');
 assert.equal(site.geo.exploration.level,'layout');assert.deepEqual(site.geo.exploration.areas[0].details,[]);
 assert.equal(building.geo.exploration.level,'detail');assert.equal(building.geo.exploration.areas[0].details[0].type,'table');
 assert.equal(room.geo.exploration,undefined);assert.equal(room.geo.furn[0].type,'table');
 assert.equal(JSON.stringify({maps,roomScene}),before);
});

test('精确边界保留实际轮廓，移动载具不分地块，重合落点有界',()=>{
 const children=['a','b','boat'].map(id=>({id,name:id,containerLocationId:id,children:[]}));
 const pts=[[0,0],[20,0],[20,20],[0,20]];
 const s=regionOverview({geo:{overviewShapes:[{id:'a',pts,quality:'confirmed'}]},marks:children.map(c=>({id:c.id,x:10,y:10}))},children,{locations:[{id:'boat',mobility:'mobile'}]});
 const a=s.areas.find(a=>a.id==='a');assert.deepEqual(a.parts[0].map(([x,y])=>[x+a.x,y+a.y]),pts);
 assert.equal(s.areas.find(a=>a.id==='boat').mobile,true);assert.ok(s.bounds.every(Number.isFinite));
 assert.ok(s.areas.find(a=>a.id==='b').parts[0].length>=3);
});
