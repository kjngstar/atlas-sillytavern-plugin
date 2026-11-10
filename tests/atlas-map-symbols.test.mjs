import test from 'node:test';
import assert from 'node:assert/strict';
import {mapSymbolKind,bridgeMapSymbol} from '../ui/atlas-map-symbols.mjs';
import {projectExplorationMaps} from '../ui/atlas-exploration-map.mjs';
test('已知桥梁采用桥梁符号，桥名旅舍和移动实体不误判',()=>{
 for(const name of ['石桥','断桥','Old Stone Bridge'])assert.equal(mapSymbolKind({name,containerLocationKind:'other'}),'bridge');
 assert.equal(mapSymbolKind({name:'石桥',containerLocationKind:'building'}),null);
 assert.equal(mapSymbolKind({name:'桥头旅舍',containerLocationKind:'other'}),null);
 assert.equal(mapSymbolKind({name:'浮桥',containerLocationKind:'other'},{mobility:'mobile'}),null);
});
test('桥面符号垂直于现有水道，保留来源和未测量精度，没有水系依据时不造河',()=>{
 const geo={overviewFeatures:[{id:'stream',type:'watercourse',line:[[30,-180],[40,0],[50,180]],width:30}]},before=JSON.stringify(geo);
 const symbol=bridgeMapSymbol(geo,{thumbnail:true});assert.equal(symbol.river.sourceFeatureId,'stream');
 assert.equal(symbol.quality,'symbolic');assert.equal(symbol.displayOnly,true);assert.equal(symbol.deck.length,4);
 assert.ok(Math.abs(symbol.along[0]*symbol.across[0]+symbol.along[1]*symbol.across[1])<1e-10);
 assert.equal(JSON.stringify(geo),before);assert.equal(bridgeMapSymbol({}).river,null);
});
test('道路上的桥梁不再套大厅和前院轮廓，入口与路线仍使用原有身份',()=>{
 const road={id:'road',name:'旧路',containerLocationId:'road-place',containerLocationKind:'other',geo:{},marks:[],children:[]};
 const bridge={id:'bridge',name:'石桥',containerLocationId:'bridge-place',containerLocationKind:'other',parentMapId:'road',geo:{overviewFeatures:[{id:'river',type:'watercourse',line:[[0,-100],[0,0],[0,100]],width:24}]},children:[],marks:[]};
 const outside={id:'outside',name:'驿站',containerLocationId:'outside-place',geo:{},children:[],marks:[]};road.children=[bridge];
 const nodes=new Map([road,bridge,outside].map(n=>[n.id,n])),locations=[road,bridge,outside].map(n=>({id:n.containerLocationId,name:n.name,entityKind:'other'}));
 const routes=[{routeId:'exit',fromId:'road-place',toId:'outside-place',distanceM:3200}];
 projectExplorationMaps(nodes,locations,{maps:[{routes}],viewMode:'player'});const s=road.geo.exploration,a=s.areas.find(a=>a.nodeId==='bridge');
 assert.equal(a.symbol,'bridge');assert.equal(a.bridge.river.sourceFeatureId,'river');assert.equal(s.surface.forecourt,null);
 assert.equal(s.passages[0].distanceM,3200);assert.equal(bridge.geo.bridgeSymbol.river.sourceFeatureId,'river');
});
