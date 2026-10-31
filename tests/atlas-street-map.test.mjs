import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {streetRibbon,cityLocality} from '../ui/atlas-street-map.mjs';
import {mapSymbolKind} from '../ui/atlas-map-symbols.mjs';
import {projectExplorationMaps} from '../ui/atlas-exploration-map.mjs';
import {referenceGeometry} from '../ui/atlas-reference-data.mjs';
const area=p=>Math.abs(p.reduce((s,a,i)=>{const b=p[(i+1)%p.length];return s+a[0]*b[1]-a[1]*b[0];},0))/2;

test('街巷语义只识别道路，不把巷口建筑、移动实体或桥改成街道',()=>{
 for(const name of ['雨棚巷','柳街','车站路','Back Alley','Oak Street'])assert.equal(mapSymbolKind({name,containerLocationKind:'other'}),'street');
 for(const n of [{name:'巷口旅舍'},{name:'道路管理处'},{name:'天街',containerLocationKind:'building'}])assert.equal(mapSymbolKind(n),null);
 assert.equal(mapSymbolKind({name:'石桥'}),'bridge');
 assert.equal(mapSymbolKind({name:'长街'},{mobility:'mobile'}),null);
});

test('街道路面有真实二维面积，拐角有限，两端开放且不修改原路径',()=>{
 for(const path of [[[0,0],[100,0]],[[0,0],[100,0],[100,100]],[[0,0],[0,0],[100,0]],[[0,0],[100,0],[0,.001]]]){
  const before=JSON.stringify(path),r=streetRibbon(path,40);
  assert.ok(area(r.polygon)>100);assert.ok(r.polygon.flat().every(Number.isFinite));
  assert.equal(r.edges.length,2);assert.equal(r.quality,'symbolic');assert.equal(r.displayOnly,true);
  r.edges.forEach(edge=>edge.forEach((p,i)=>assert.ok(Math.hypot(p[0]-r.points[i][0],p[1]-r.points[i][1])<=40.001)));
  assert.equal(JSON.stringify(path),before);
 }
 assert.equal(streetRibbon([[0,0],[0,0]],40),null);
});

function alleyFixture(){
 const lane={id:'lane',containerLocationId:'L',name:'雨棚巷',containerLocationKind:'other',geo:{overviewShapes:[],overviewRoutes:[]},children:[],marks:[]};
 const others=['west','east'].map(id=>({id,containerLocationId:id,name:id,geo:{},children:[],marks:[]}));
 const nodes=new Map([lane,...others].map(n=>[n.id,n]));
 const locations=[lane,...others].map(n=>({id:n.containerLocationId,name:n.name}));
 const maps=[{routes:others.map(n=>({id:'to-'+n.id,fromLocationId:'L',toLocationId:n.containerLocationId,distanceM:300}))}];
 return {lane,nodes,locations,maps};
}
test('两出口小巷画成路面，保留路线身份距离和外部图标；没有连接也不伪造出口',()=>{
 const f=alleyFixture(),before=JSON.stringify(f.maps);projectExplorationMaps(f.nodes,f.locations,{maps:f.maps});
 const s=f.lane.geo.exploration;assert.equal(s.surface.street.ribbons.length,1);assert.equal(s.surface.street.name,'雨棚巷');
 assert.ok(s.surface.street.frontages.every(f=>f.decorative&&f.displayOnly&&!f.id));
 assert.equal(s.areas.filter(a=>a.external).length,2);assert.ok(s.passages.every(e=>e.distanceM===300));assert.equal(JSON.stringify(f.maps),before);
 const empty=alleyFixture();projectExplorationMaps(empty.nodes,empty.locations);
 assert.equal(empty.lane.geo.exploration.areas.length,0);assert.equal(empty.lane.geo.exploration.passages.length,0);
 assert.ok(area(empty.lane.geo.exploration.surface.street.ribbons[0].polygon)>1000);
 const hidden=alleyFixture();hidden.maps[0].routes.forEach(r=>r.hidden=true);projectExplorationMaps(hidden.nodes,hidden.locations,{maps:hidden.maps});
 assert.equal(hidden.lane.geo.exploration.areas.length,0);
 const confirmed=alleyFixture();confirmed.maps[0].routes.forEach(r=>r.geometryQuality='confirmed');projectExplorationMaps(confirmed.nodes,confirmed.locations,{maps:confirmed.maps});
 assert.ok(confirmed.lane.geo.exploration.surface.street.ribbons[0].points.every(p=>p[1]===0),'已有确认路径不加示意弯折');
});
test('确认边界和已有布局不被街道符号覆盖',()=>{
 for(const geo of [{selfArea:{pts:[[0,0],[200,0],[200,50],[0,50]],quality:'confirmed'}},{rooms:[{x:0,y:0,w:20,h:4}]}]){
  const f=alleyFixture();f.lane.geo=geo;const before=JSON.stringify(geo);projectExplorationMaps(f.nodes,f.locations,{maps:f.maps});assert.equal(JSON.stringify(f.lane.geo),before);
 }
});
const district={id:'d',name:'钟楼广场',quality:'layout',site:[250,250],pts:[[0,0],[550,0],[550,472.5],[0,527.5]]};
test('模板分区只作地点略图，保留锚点来源并留下街巷空隙；确认轮廓和建筑布局保持原样',()=>{
 const before=JSON.stringify(district),d=cityLocality(district,{template:true});
 assert.equal(d.role,'plaza');assert.equal(d.displayOnly,true);assert.deepEqual(d.site,district.site);assert.deepEqual(d.sourcePts,district.pts);
 assert.ok(area(d.pts)<area(district.pts)*.6);assert.ok(d.pts.length>4);assert.equal(JSON.stringify(district),before);
 for(const options of [{},{template:true,hasBuildings:true}])assert.equal(cityLocality(district,options),district);
 const exact={...district,quality:'confirmed'};assert.equal(cityLocality(exact,{template:true}),exact);
 const broken={...district,pts:[[0,0],[0,0],[10,10]]};assert.equal(cityLocality(broken,{template:true}),broken);
});
test('城市真实投影保留路宽及路线 ID，显示略图不写回存档，标定数据不变形',()=>{
 const map={containerLocationKind:'city',points:[]},scene={units:'meters',layout:{kind:'city',structureKey:'template',bounds:{x:0,y:0,w:1000,h:1000},districts:[{...district,polygon:district.pts,site:{x:250,y:250}}],roads:[{id:'road:d',a:{x:310,y:500},b:{x:250,y:250},width:12}]}};
 const before=JSON.stringify(scene),g=referenceGeometry(map,scene);assert.equal(g.geo.districts[0].displayOnly,true);
 assert.equal(g.geo.avenues[0].id,'road:d');assert.equal(g.geo.avenues[0].width,12*g.transform.scale);assert.equal(JSON.stringify(scene),before);
 const precise=referenceGeometry({...map,scaleQuality:'confirmed'},scene);assert.equal(precise.geo.districts[0].displayOnly,undefined);
 const building=referenceGeometry(map,{...scene,layout:{...scene.layout,buildings:[{id:'B',districtId:'d',x:30,y:30,w:10,h:10}]}});assert.equal(building.geo.districts[0].displayOnly,undefined);
 const known=referenceGeometry({...map,points:[{entityId:'d',area:{quality:'confirmed'}}]},scene);assert.equal(known.geo.districts[0].displayOnly,undefined);
});

test('小巷绘图确实填充路面和双边缘，不再绘制原来的虚线中心线',()=>{
 const f=alleyFixture();projectExplorationMaps(f.nodes,f.locations,{maps:f.maps});
 const source=fs.readFileSync(new URL('../ui/atlas-reference/js/map.js',import.meta.url),'utf8'),start=source.indexOf('function explorationMap('),end=source.indexOf('function overviewMap(',start);
 const fills=[],strokes=[],dashes=[],labels=[];
 const ctx={save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},closePath(){},translate(){},fill(){fills.push(this.fillStyle);},stroke(){strokes.push(this.lineWidth);},setLineDash(d){dashes.push(d);}};
 const rt=vm.createContext({ctx,st:{cam:{s:1},showLabels:true},canvasStyle:null,hexA:(c,a)=>c+'@'+a,pushLabel:(...v)=>labels.push(v)});
 vm.runInContext(source.slice(start,end),rt);rt.explorationMap(f.lane.geo.exploration);
 assert.equal(fills.length,7);assert.ok(strokes.includes(1.3));assert.ok(!dashes.some(d=>d.length));assert.ok(labels.some(l=>l[2]==='雨棚巷'));
});
