import test from 'node:test';
import assert from 'node:assert/strict';
import {projectExplorationMaps} from '../ui/atlas-exploration-map.mjs';

function fixture(){
 const parent={id:'station',containerLocationId:'station-place',renderKind:'building',geo:{},marks:[],children:[]};
 const room=(id,w,h)=>({id,containerLocationId:id+'-place',parentMapId:'station',name:id,renderKind:'floor',geo:{rooms:[{id:id+'-place',x:0,y:0,w,h}]},marks:[],children:[]});
 const hall=room('hall',8,8),tool=room('tool',4,8);parent.children=[tool,hall];
 return {parent,hall,tool,nodes:new Map([parent,hall,tool].map(n=>[n.id,n])),locations:[parent,hall,tool].map(n=>({id:n.containerLocationId})),maps:[{routes:[{routeId:'door',fromLocationId:'hall-place',toLocationId:'tool-place',kind:'door',geometryQuality:'confirmed'}]}]};
}
test('总览使用子房间真实轮廓比例和已登记门连接；不改坐标、布局或距离',()=>{
 const f=fixture(),before=JSON.stringify({maps:f.maps,hall:f.hall,tool:f.tool});
 projectExplorationMaps(f.nodes,f.locations,{maps:f.maps});
 const s=f.parent.geo.exploration;assert.equal(s.displayOnly,true);assert.equal(s.passages.length,1);assert.equal(s.passages[0].id,'door');
 const tool=s.areas.find(a=>a.nodeId==='tool'),p=tool.parts[0];
 assert.equal((p[1][0]-p[0][0])/(p[2][1]-p[1][1]),.5);
 assert.equal(JSON.stringify({maps:f.maps,hall:f.hall,tool:f.tool}),before);
 assert.ok(s.bounds.every(Number.isFinite));assert.equal(s.passages[0].distanceM,null);
});
test('同场所共享连续场地示意，归属不新增通行路线，也不补十字形房间',()=>{
 const f=fixture();f.tool.geo={};projectExplorationMaps(f.nodes,f.locations);
 const s=f.parent.geo.exploration;assert.deepEqual(s.passages,[]);assert.equal(s.areas.find(a=>a.nodeId==='tool').recorded,false);
 assert.equal(s.areas.find(a=>a.nodeId==='tool').parts[0].length,4);
 assert.equal(s.surface.displayOnly,true);assert.equal(s.surface.outlines.length,1);
});
test('已有落点保持原位，略图只调整预览大小；实测地图继续使用米制地图',()=>{
 const f=fixture();f.parent.marks=[{id:'hall-place',type:'poi',x:180,y:260},{id:'tool-place',type:'poi',x:320,y:260}];
 projectExplorationMaps(f.nodes,f.locations,{maps:f.maps});
 assert.deepEqual(f.parent.geo.exploration.areas.map(a=>[a.x,a.y]),[[180,260],[320,260]]);
 const g=fixture();g.parent.metric=2;g.parent.transform={scaleQuality:'confirmed'};projectExplorationMaps(g.nodes,g.locations,{maps:g.maps});assert.equal(g.parent.geo.exploration,undefined);
});
test('可见性过滤不泄露隐藏路线或邻图；输入顺序变化不改变略图',()=>{
 const a=fixture(),b=fixture();b.parent.children.reverse();b.nodes=new Map([...b.nodes].reverse());
 projectExplorationMaps(a.nodes,a.locations,{maps:a.maps});projectExplorationMaps(b.nodes,b.locations,{maps:b.maps});
 assert.deepEqual(a.parent.geo.exploration,b.parent.geo.exploration);
 const f=fixture();f.maps[0].routes[0].hidden=true;projectExplorationMaps(f.nodes,f.locations,{maps:f.maps});assert.deepEqual(f.parent.geo.exploration.passages,[]);
 const g=fixture();projectExplorationMaps(g.nodes,g.locations.filter(l=>l.id!=='tool-place'),{maps:g.maps});assert.deepEqual(g.parent.geo.exploration.passages,[]);
});
test('已有地理几何、米制房间和确认边界保持原样，不被略图重新排布',()=>{
 for(const geo of [{overviewShapes:[{id:'x',pts:[[0,0],[1,0],[0,1]]}]},{selfArea:{pts:[[0,0],[1,0],[0,1]]}},{overviewFeatures:[{type:'watercourse'}]},{rooms:[{x:0,y:0,w:4,h:8}]}]){
  const f=fixture();f.parent.geo=geo;const before=JSON.stringify(f.parent);projectExplorationMaps(f.nodes,f.locations,{maps:f.maps});assert.equal(JSON.stringify(f.parent),before);
 }
});
test('父地点和已知邻区以实际路线生成出口，隐藏或不存在的端点不生成',()=>{
 const f=fixture(),outside={id:'road',containerLocationId:'road-place',name:'旧路',geo:{},marks:[],children:[]};f.nodes.set('road',outside);f.locations.push({id:'road-place'});
 f.maps[0].routes.push({routeId:'exit',fromLocationId:'station-place',toLocationId:'road-place',distanceM:3200});
 projectExplorationMaps(f.nodes,f.locations,{maps:f.maps});const s=f.parent.geo.exploration;
 assert.equal(s.areas.find(a=>a.nodeId==='road').external,true);assert.equal(s.passages.find(e=>e.id==='exit').distanceM,3200);assert.ok(s.surface.forecourt);assert.equal(s.hub,undefined);
});
test('缺少父图的场所沿用子图实际出入口，移动载具不生成固定地块',()=>{
 const f=fixture();f.hall.geo.doors=[{x:4,y:8,w:1.2,wall:'south'}];
 f.locations.find(l=>l.id==='tool-place').mobility='mobile';
 projectExplorationMaps(f.nodes,f.locations,{maps:f.maps});const s=f.parent.geo.exploration;
 assert.equal(s.areas.find(a=>a.nodeId==='hall').entrances[0].wall,'south');
 assert.equal(s.areas.find(a=>a.nodeId==='tool').mobile,true);
 assert.ok(s.areas.find(a=>a.nodeId==='tool').parts.flat().every(([x,y])=>Math.abs(x)<=18&&Math.abs(y)<=12));
});
