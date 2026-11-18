/** Shared by node:test and the in-app browser's local SillyTavern check page. */
import * as Kit from '../../vendor/atlas-spatial/index.mjs';

const scope={chatId:'proximity-fixture',branchId:'proximity',revision:1,viewMode:'author'};
const expect=(condition,message)=>{if(!condition)throw new Error(message);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const pin=(result,id)=>result.scene.layout.pins.find(p=>p.id===id);
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
export function fixture(zones,{span=10000,previous=null,physical=true,metersPerCell=1,locks={}}={}){
  const locations=zones.map(z=>({branch_id:scope.branchId,id:z.id,name:z.id,kind:'building',status:'active',map_id:'proximity-map',parent_location_id:null,coord_precision:'unknown'}));
  const built=Kit.buildLayoutContext({scope,mapRow:{branch_id:scope.branchId,id:'proximity-map',name:'邻近排位验收',container_location_id:null,frame_json:{cols:span,rows:span},meters_per_cell:metersPerCell,scale_quality:metersPerCell?'estimated':'uncalibrated',scale_locked:0},locations,characters:[],items:[],routes:[]});
  expect(built.ok,'fixture context: '+JSON.stringify(built.issues));
  const result=Kit.generateOverview({surface:'urban',zones}, {...built.context,currentScope:scope,previousScene:previous,locks:{...built.context.locks,...locks},childSpaces:physical?Object.fromEntries(zones.map(z=>[z.id,{widthM:12,heightM:8}])):{}});
  expect(result.ok,'generation: '+JSON.stringify(result.issues));
  expect(result.scene.layout.pins.length===zones.length,'every registered zone must be represented');
  expect(Kit.checkSceneDocument(result.scene).length===0,'scene document must be valid');
  if(physical){
    const rectangles=result.scene.layout.shapes.map(s=>({id:s.id,x0:Math.min(...s.polygon.map(p=>p.x)),x1:Math.max(...s.polygon.map(p=>p.x)),y0:Math.min(...s.polygon.map(p=>p.y)),y1:Math.max(...s.polygon.map(p=>p.y))}));
    for(let i=0;i<rectangles.length;i++)for(let j=0;j<i;j++){const a=rectangles[i],b=rectangles[j];expect(a.x1<=b.x0||b.x1<=a.x0||a.y1<=b.y0||b.y1<=a.y0,'building footprints overlap: '+a.id+'/'+b.id);}
  }
  return result;
}
function nearby(result,a,b){
  const gap=distance(pin(result,a),pin(result,b));
  expect(gap<=20,`12×8 m footprints should be close; got ${gap.toFixed(3)} m`);
  return gap;
}
export const proximityCases=[
  {name:'near anchor sorts after its dependent',run(){const r=fixture([{id:'A-shop',near:'Z-house'},{id:'Z-house',sector:'east'}]);return {gapM:nearby(r,'A-shop','Z-house')};}},
  {name:'local footprint clearance on a large map',run(){const r=fixture([{id:'A-house',sector:'east'},{id:'Z-shop',near:'A-house'}]);return {gapM:nearby(r,'A-house','Z-shop')};}},
  {name:'near and sector combine without map-wide separation',run(){const r=fixture([{id:'A-shop',near:'Z-house',sector:'west'},{id:'Z-house',sector:'east'}]);expect(pin(r,'A-shop').x<pin(r,'Z-house').x,'shop should be west of the anchor');return {gapM:nearby(r,'A-shop','Z-house')};}},
  {name:'reverse-ID near chain',run(){const r=fixture([{id:'A',near:'B'},{id:'B',near:'Z'},{id:'Z',sector:'north'}]);nearby(r,'A','B');nearby(r,'B','Z');}},
  {name:'mutual near cycle is a valid cluster',run(){const r=fixture([{id:'A',near:'Z'},{id:'Z',near:'A'}]);return {gapM:nearby(r,'A','Z')};}},
  {name:'new early-ID member uses the saved anchor',run(){
    const original=fixture([{id:'M-house',sector:'east'},{id:'Z-store',sector:'south'}]);
    const r=fixture([{id:'A-shop',near:'M-house'},{id:'M-house',sector:'east'},{id:'Z-store',sector:'south'}],{previous:original.scene});
    for(const id of ['M-house','Z-store']){expect(same(pin(original,id),pin(r,id)),'saved pin moved: '+id);expect(same(original.scene.layout.shapes.find(s=>s.id===id),r.scene.layout.shapes.find(s=>s.id===id)),'saved footprint moved: '+id);}
    return {gapM:nearby(r,'A-shop','M-house')};
  }},
  {name:'confirmed point is an anchor even when sorted last',run(){const r=fixture([{id:'A',near:'Z'},{id:'Z'}],{locks:{points:{Z:{x:8000,y:7500}}}});expect(pin(r,'Z').x===8000&&pin(r,'Z').y===7500,'confirmed point moved');return {gapM:nearby(r,'A','Z')};}},
  {name:'confirmed polygon remains unchanged and anchors near',run(){
    const polygon=[{x:7994,y:7496},{x:8006,y:7496},{x:8006,y:7504},{x:7994,y:7504}];
    const r=fixture([{id:'A',near:'Z'},{id:'Z'}],{locks:{areas:{Z:{points:polygon}}}});
    expect(same(r.scene.layout.shapes.find(s=>s.id==='Z').polygon,polygon),'confirmed polygon moved');return {gapM:nearby(r,'A','Z')};
  }},
  {name:'near clearance does not grow with map extent',run(){for(const span of [1000,10000,20000])nearby(fixture([{id:'A',near:'Z'},{id:'Z'}],{span}),'A','Z');}},
  {name:'input order is deterministic and input is untouched',run(){const zones=[{id:'Z'},{id:'A',near:'Z'},{id:'B',near:'A'}],saved=JSON.stringify(zones);const a=fixture(zones),b=fixture([...zones].reverse());expect(same(a.scene,b.scene),'input order changed scene');expect(JSON.stringify(zones)===saved,'input mutated');}},
  {name:'cells-to-metres conversion retains relative geometry',run(){
    const zones=[{id:'A',near:'Z'},{id:'Z',sector:'north'}];
    const a=fixture(zones,{span:100,physical:false,metersPerCell:null});
    const b=fixture(zones,{span:100,physical:false,metersPerCell:100,previous:a.scene});
    expect(a.scene.units==='cells'&&b.scene.units==='meters','unit contract changed');
    for(const id of ['A','Z']){expect(Math.abs(pin(a,id).x*100-pin(b,id).x)<1e-6,'x drift: '+id);expect(Math.abs(pin(a,id).y*100-pin(b,id).y)<1e-6,'y drift: '+id);}
  }},
  {name:'layout proximity does not invent a route or exact location',run(){const r=fixture([{id:'A',near:'Z'},{id:'Z'}]);expect(r.scene.layout.routes.length===0,'unregistered route invented');expect(r.scene.layout.pins.every(p=>p.quality==='layout'),'estimated location promoted to exact');}},
  {name:'early-ID dependent of a near cycle stays in the cluster',run(){const r=fixture([{id:'A',near:'B'},{id:'B',near:'Z'},{id:'Z',near:'B'}]);nearby(r,'A','B');nearby(r,'B','Z');}},
];
export function runProximityChecks(){return proximityCases.map(c=>{try{return {name:c.name,pass:true,...c.run()};}catch(error){return {name:c.name,pass:false,error:error.message};}});}
export function example(){return fixture([{id:'A-shop',name:'商店',near:'Z-house',sector:'west'},{id:'Z-house',name:'住宅',sector:'east'}]).scene.layout;}
