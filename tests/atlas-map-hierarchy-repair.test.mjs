import test from 'node:test';
import assert from 'node:assert/strict';
import initSql from 'sql.js';
import {overview} from '../vendor/atlas-spatial/overview-core.mjs';
import {projectMapContext,corridorEndpoints} from '../ui/atlas-map-context.mjs';
import {createSqlRepository} from '../src/atlas-db-repository.ts';
import {createRow} from '../src/atlas-db-defaults.ts';
import {buildSqlLayoutTask} from '../src/atlas-sql-layout-task.ts';
import {locationSpaceSize} from '../src/atlas-space-canonical.ts';
import {planLayoutEvidence,parseLayoutEvidence,layoutEvidenceSegments} from '../src/atlas-layout-evidence.ts';
import {generateOverview} from '../vendor/atlas-spatial/generation.mjs';
import {makeSeedWith,IDS,insertRows} from './fixtures/atlas-sql/seed.mjs';
const SQL=await initSql();
const area=pts=>Math.abs(pts.reduce((n,p,i)=>n+p.x*pts[(i+1)%pts.length].y-pts[(i+1)%pts.length].x*p.y,0))/2;

test('large/medium settlement footprints retain their relative area across placement seeds',()=>{
 for(let seed=0;seed<24;seed++){
  const result=overview({id:'world',mapId:'world',seed:String(seed),width:100,height:100,surface:'mixed',zones:[{id:'A',role:'city',size:'large',sector:'center'},{id:'B',role:'city',size:'medium',sector:'east'},{id:'C',role:'other',size:'medium'}],links:[],features:[]});
  const a=result.shapes.find(s=>s.id==='A'),b=result.shapes.find(s=>s.id==='B');
  assert.ok(a&&b,JSON.stringify(result.issues));assert.ok(area(a.polygon)>area(b.polygon),`seed ${seed}`);
 }
});

test('road textures need a local zone and never generate a map-wide path',()=>{
 const spec={id:'world',width:100,height:100,zones:[{id:'A',size:'medium'}],links:[],features:[{id:'local',type:'road_texture',zoneId:'A'},{id:'unbound',type:'road_texture'}]};
 const layout=overview(spec);const texture=layout.features.find(f=>f.id==='local');
 assert.deepEqual(texture.polygon,layout.shapes[0].polygon);assert.equal(texture.path,undefined);
 assert.equal(layout.features.some(f=>f.id==='unbound'),false);
});

const box=(id,x0,x1,y0=0,y1=30)=>({id,name:id,quality:'estimated',pts:[[x0,y0],[x1,y0],[x1,y1],[x0,y1]]});
function corridorFixture(){
 const locations=[{id:'A',name:'甲城',entityKind:'city',mapId:'world',parentLocationId:'country'},
  {id:'B',name:'乙城',entityKind:'city',mapId:'world',parentLocationId:'country'},
  {id:'road',name:'甲城至乙城道路',entityKind:'natural',mapId:'world',parentLocationId:'country'},
  {id:'cart',name:'马车',entityKind:'vehicle',mobility:'mobile',anchorLocationId:'cart',parentLocationId:'road',mapId:'road-map',childMapIds:['inside']}];
 const node={id:'world',geo:{overviewShapes:[box('A',0,20),box('B',80,100),box('road',35,45)],overviewFeatures:[{id:'bad-curve',zoneId:'road',type:'road_texture'}]},marks:[{id:'A',x:10,y:15},{id:'B',x:90,y:15},{id:'road',x:40,y:50}],children:[]};
 return {locations,node,nodes:new Map([['world',node]])};
}
test('a legacy between-city corridor is projected between boundary endpoints, not as a city-sized zone',()=>{
 const {locations,nodes,node}=corridorFixture();projectMapContext(nodes,locations);
 assert.equal(node.geo.overviewShapes.some(s=>s.id==='road'),false);
 assert.deepEqual(node.geo.overviewRoutes[0].points,[[20,15],[80,15]]);
 assert.equal(node.geo.overviewRoutes[0].quality,'layout');assert.equal(node.geo.overviewFeatures.length,0);
});
test('vehicle exterior remains visible with an interior link and unknown progress, including a legacy self-anchor',()=>{
 const {locations,nodes,node}=corridorFixture(),before=JSON.stringify(locations);projectMapContext(nodes,locations);
 const cart=node.marks.find(m=>m.id==='cart');assert.equal(cart.type,'vehicle');assert.equal(cart.node.id,'inside');
 assert.equal(cart.proxy,true);assert.match(cart.sub,/未知/);assert.equal(cart.progress,undefined);assert.equal(JSON.stringify(locations),before);
});
test('a real journey owns the moving vehicle marker instead of a second schematic exterior',()=>{
 const {locations,nodes,node}=corridorFixture();projectMapContext(nodes,locations,{inTransit:new Set(['cart'])});
 assert.equal(node.marks.some(m=>m.id==='cart'),false);
});
test('a vehicle anchored at an ordinary visible location also has an exterior entry',()=>{
 const {locations,nodes,node}=corridorFixture();locations[3].anchorLocationId='A';projectMapContext(nodes,locations);
 const cart=node.marks.find(m=>m.id==='cart');assert.equal(cart.type,'vehicle');assert.equal(cart.x,10);assert.equal(cart.proxy,true);assert.match(cart.sub,/未知/);
});
test('ambiguous or hidden corridor endpoints do not fabricate a connection',()=>{
 const {locations}=corridorFixture();assert.equal(corridorEndpoints(locations[2],locations.filter(l=>l.id!=='B')),null);
 assert.equal(corridorEndpoints(locations[2],[...locations,{...locations[0],id:'duplicate'}]),null);
 assert.equal(corridorEndpoints({...locations[2],name:'甲城至乙城车站'},locations),null);
});

function familyFixture(){
 const active={id:'outer',name:'外区',quality:'layout',pts:[[0,0],[80,0],[70,60],[0,55]]},sibling=box('inner',80,140);
 const parent={id:'city',geo:{districts:[active,sibling]},marks:[],children:[],extent:[-100,200,-100,100]};
 const make=(id,containerLocationId)=>({id,kind:'district',parentMapId:'city',containerLocationId,children:[],marks:[],geo:{districts:[box(containerLocationId,0,100,0,100)]},extent:[-100,100,-100,100],transform:{scale:1,bounds:{w:100,h:100}}});
 const outer=make('outer-map','outer'),inner=make('inner-map','inner');parent.children=[outer,inner];
 return {parent,outer,inner,nodes:new Map([['inner-map',inner],['outer-map',outer],['city',parent]]),locations:[{id:'outer',name:'外区'},{id:'inner',name:'内区'}]};
}
test('child maps inherit the parent polygon and preserve adjacent sibling direction and navigation',()=>{
 const {nodes,locations,outer}=familyFixture();projectMapContext(nodes,locations);
 const context=outer.geo.parentContext;assert.equal(context.parentMapId,'city');
 assert.deepEqual(context.active.pts,[[-50,-37.5],[50,-37.5],[37.5,37.5],[-50,31.25]]);
 assert.deepEqual(outer.geo.districts[0].pts,context.active.pts);
 const marker=outer.marks.find(m=>m.id==='inner');assert.ok(marker.x>50);assert.equal(marker.node.id,'inner-map');assert.equal(marker.context,true);
 assert.ok(outer.extent[1]>100);
});
test('only visible sibling maps enter the inherited context',()=>{
 const f=familyFixture();f.nodes.delete('inner-map');f.parent.children=[f.outer];f.parent.geo.districts=f.parent.geo.districts.filter(s=>s.id==='outer');projectMapContext(f.nodes,[f.locations[0]]);
 assert.deepEqual(f.outer.geo.parentContext.siblings,[]);assert.equal(f.outer.marks.some(m=>m.id==='inner'),false);
});

test('室内图按物理房间显示，不把室外同级地图纳入适应视野范围',()=>{
 const f=familyFixture();f.outer.kind='building';f.outer.renderKind='floor';
 const extent=[...f.outer.extent],geometry=structuredClone(f.outer.geo);
 projectMapContext(f.nodes,f.locations);
 assert.deepEqual(f.outer.extent,extent);
 assert.deepEqual(f.outer.geo,geometry);
 assert.equal(f.outer.marks.some(m=>m.context),false);
 assert.ok(f.inner.geo.parentContext,'地理分区仍保留父图上下文');
});

const input=extra=>({anchor:{chatUid:IDS.chatA,branchId:IDS.branchMain,parentTurnId:IDS.seedTurn,hostMessageUid:'hierarchy-fix',variantKey:'v1',baseRevision:0,baseStorageRevision:0,inputHash:'hierarchy-fix'},userText:'',assistantText:'查看地图。',sourceSnapshot:[],manual:true,sceneOnly:true,phaseBatches:[],operations:[],...extra});
test('spatial assembly cannot multiply the four-send turn allowance by its number of maps',async()=>{
 const seed=await makeSeedWith(SQL),ids=Array.from({length:8},(_,i)=>`budget-map-${i}`);
 for(const id of ids)insertRows(seed.db,'maps',[createRow('maps',{name:id,kind:'world',frame_json:{cols:100,rows:100}},{branchId:IDS.branchMain,id,turnId:IDS.seedTurn,clockS:0,nowWallMs:1,rulesetVersion:'atlas-1'})]);
 const bytes=seed.exportBytes();seed.close();const calls=[];
 const repo=createSqlRepository({chatUid:IDS.chatA,branchId:IDS.branchMain,modelPort:{async request(req){calls.push(req);const scopes=JSON.parse(req.messages[1].content.split('\n').find(l=>l.startsWith('本图：')).slice(3));return {batchId:req.batchId,finishReason:'stop',httpStatus:200,text:scopes.map(s=>JSON.stringify({op:'map.layout.request',ref:s.map,data:{kind:'overview',spec:{surface:'mixed',zones:[],features:[],links:[]}}})).join('\n')};}}});
 try{await repo.open({bytes});const result=await repo.prepareTurn(input({layoutMaps:ids,generationOptions:{maxTokens:8192,batching:{charactersPerBatch:0,mapsPerBatch:1,requestsPerOperation:4}}}));assert.equal(calls.length,4);assert.ok(result.receipt.issues.some(i=>i.code==='LAYOUT_BATCH_PENDING'));}finally{await repo.close();}
});
test('location compilation rejects a self-anchor instead of persisting a vehicle position cycle',async()=>{
 const seed=await makeSeedWith(SQL),bytes=seed.exportBytes();seed.close();const repo=createSqlRepository({chatUid:IDS.chatA,branchId:IDS.branchMain});
 try{await repo.open({bytes});await assert.rejects(repo.prepareTurn(input({operations:[{op:'location.upsert',ref:IDS.L2,data:{kind:'vehicle',anchor_ref:IDS.L2}}]})),error=>error.detail?.receipt?.issues.some(i=>i.code==='INVARIANT_LOCATION_ANCHOR_CYCLE'));}finally{await repo.close();}
});

test('automatic layouts follow occupied ancestors top down and leave remote interiors for explicit requests',async()=>{
 const seed=await makeSeedWith(SQL);
 try{
  seed.db.run('UPDATE characters SET location_id=?',[IDS.L3]);
  const loc='remote-room',map='remote-interior';insertRows(seed.db,'entity_keys',[{branch_id:IDS.branchMain,id:loc,kind:'location'}]);
  insertRows(seed.db,'locations',[createRow('locations',{name:'远方客房',kind:'room',parent_location_id:IDS.L1,map_id:IDS.M1},{branchId:IDS.branchMain,id:loc,turnId:IDS.seedTurn,clockS:0,nowWallMs:1,rulesetVersion:'atlas-1'})]);
  insertRows(seed.db,'maps',[createRow('maps',{name:'远方客房',kind:'interior',container_location_id:loc,frame_json:{cols:12,rows:8}},{branchId:IDS.branchMain,id:map,turnId:IDS.seedTurn,clockS:0,nowWallMs:1,rulesetVersion:'atlas-1'})]);
  const task=buildSqlLayoutTask(seed.db,IDS.branchMain,input({layoutMaps:'active'}),'active');
  assert.deepEqual([...task.mapIds,...task.remainingLocationIds],[IDS.M1,IDS.M2]);
  assert.deepEqual(buildSqlLayoutTask(seed.db,IDS.branchMain,input({layoutMaps:[map]}),'explicit').mapIds,[map]);
 }finally{seed.close();}
});

test('bounded evidence prioritizes map-relevant text while retaining exact original offsets',()=>{
 const text='无关背景。'.repeat(70000)+'测试城的内城区位于外城区北侧。',maps=[{id:'map',alias:'M1',name:'测试城地图'}];
 const batches=planLayoutEvidence([{key:'source',kind:'story',hash:'h',text}],maps,input().anchor,'bounded',{maxBatches:1});
 assert.equal(batches.length,1);assert.ok(batches[0].omittedBatches>24);
 const segment=layoutEvidenceSegments(batches[0].chunks).find(s=>s.text.includes('测试城'));assert.ok(segment);
 const [fact]=parseLayoutEvidence(JSON.stringify({facts:[{mapRef:'M1',segmentRef:segment.ref}]}),batches[0].chunks,maps);
 assert.equal(text.slice(fact.start,fact.end),fact.text);
});

test('long-source extraction leaves room in the actual repository budget for a completed map',async()=>{
 const seed=await makeSeedWith(SQL),bytes=seed.exportBytes();seed.close();const calls=[];
 const repo=createSqlRepository({chatUid:IDS.chatA,branchId:IDS.branchMain,modelPort:{async request(req){calls.push(req);return {batchId:req.batchId,httpStatus:200,finishReason:'stop',text:req.batchId.includes('_evidence_')?'{"facts":[]}':JSON.stringify({op:'map.layout.request',ref:IDS.M1,data:{kind:'overview',spec:{surface:'mixed',zones:[],features:[],links:[]}}})};}}});
 try{await repo.open({bytes});const result=await repo.prepareTurn(input({layoutMaps:[IDS.M1],sourceSnapshot:[{key:'long',kind:'story',hash:'h',text:'世界背景。'.repeat(10000)}]}));
  assert.equal(calls.length,2);assert.ok(result.receipt.issues.some(i=>i.code==='LAYOUT_EVIDENCE_SCOPED'));
  const db=repo.getCandidate(result.token).db;assert.ok(JSON.parse(db.exec(`SELECT frame_json FROM maps WHERE id='${IDS.M1}'`)[0].values[0][0]).atlasScene);
 }finally{await repo.close();}
});

for(const [units,mpp,expected] of [['meters',2,[80,60]],['cells',2,[160,120]],['cells',null,null]])test(`parent polygon dimensions are inherited with explicit ${units}/${mpp} conversion`,()=>{
 const map={id:'parent',meters_per_cell:mpp,frame_json:{atlasScene:{branchId:IDS.branchMain,mapId:'parent',units,layout:{districts:[{id:'district',polygon:[{x:10,y:10},{x:90,y:10},{x:80,y:70},{x:10,y:65}]}]}}}};
 const size=locationSpaceSize({maps:[map],locations:[{id:'district',map_id:'parent'}],locationId:'district',branchId:IDS.branchMain});
 if(expected){assert.equal(size.widthM,expected[0]);assert.equal(size.heightM,expected[1]);assert.equal(size.source,'parent-footprint');}else assert.equal(size,null);
});

test('old estimated overview cache is rebuilt once under the corrected footprint policy',()=>{
 const context={scope:{chatId:'c',branchId:'b',revision:1,viewMode:'author'},map:{id:'m',frame:{cols:100,rows:100},metersPerCell:null},entities:{locations:['A','B']}};
 const spec={surface:'mixed',zones:[{id:'A',role:'city',size:'large'},{id:'B',role:'city',size:'medium'}],links:[],features:[]};
 const first=generateOverview(spec,context);assert.equal(first.ok,true,JSON.stringify(first.issues));const previous=structuredClone(first.scene),signature=JSON.parse(previous.inputSignature);delete signature.geometryPolicyVersion;previous.inputSignature=JSON.stringify(signature);
 const shape=previous.layout.shapes.find(s=>s.id==='A');shape.polygon=shape.polygon.map(p=>({x:p.x*.01,y:p.y*.01}));delete shape.structureKey;
 const repaired=generateOverview(spec,{...context,previousScene:previous});assert.equal(repaired.ok,true);assert.notEqual(repaired.status,'reused');
 assert.ok(area(repaired.scene.layout.shapes.find(s=>s.id==='A').polygon)>area(repaired.scene.layout.shapes.find(s=>s.id==='B').polygon));
 assert.equal(generateOverview(spec,{...context,previousScene:repaired.scene}).status,'reused');
});
