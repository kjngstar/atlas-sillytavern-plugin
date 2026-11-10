import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {projectReferenceData} from '../ui/atlas-reference-data.mjs';
const view=items=>({items});
function fixture(){
 const id='square',ids=['salt','clock','station','weaver'];
 const map={mapId:id,name:'石钟广场',containerLocationId:'S',containerLocationKind:'district',scaleQuality:'estimated',points:[],routes:[]};
 const scene={units:'meters',layout:{kind:'city',structureKey:'city-template',bounds:{x:0,y:0,w:1000,h:1000},
  districts:[{id:'S',name:'石钟广场',quality:'layout',polygon:[[0,0],[1000,0],[1000,1000],[0,1000]],site:{x:475,y:500}}],
  buildings:ids.map((id,i)=>({id,name:id,districtId:'S',x:422+i*40,y:522,w:24,h:24,quality:'layout'})),
  roads:[{id:'avenue',a:{x:310,y:500},b:{x:770,y:500},width:12}]}};
 const catalog=ids.map(entityId=>({entityId,name:entityId,entityKind:'location',locationKind:'building',mapId:id,parentLocationId:'S'}));
 return {map,scene,catalog};
}
const project=f=>projectReferenceData({mapView:view([f.map]),sceneView:view([{mapId:f.map.mapId,scene:f.scene}]),catalogView:view(f.catalog),viewMode:'author'}).ROOT;
test('真实投影：广场的全幅自身分区和模板长条消失，外部地点仍保留可检查标记',()=>{
 const f=fixture(),before=JSON.stringify(f),n=project(f);
 assert.ok(n.geo.localSite);assert.equal(n.geo.exploration,undefined);
 assert.equal(n.geo.districts.length,0);assert.equal(n.geo.avenues.length,0);
 assert.equal(n.geo.cityBuildings.length,4);assert.equal(n.marks.length,4);
 assert.ok(n.marks.every(m=>m.placeId===m.id&&!m.node));
 for(let i=0;i<n.marks.length;i++)for(let j=0;j<i;j++)assert.ok(Math.hypot(n.marks[i].x-n.marks[j].x,n.marks[i].y-n.marks[j].y)>200);
 assert.equal(JSON.stringify(f),before,'略图不改存档，不新建内部地图');
 assert.match(n.geo.localSite.note,/示意/);
});
test('明确尺度、真实路线、确认轮廓及多分区城市不套用广场略图',()=>{
 for(const change of [f=>f.map.scaleQuality='confirmed',f=>f.map.routes.push({id:'real-road'}),f=>f.scene.layout.buildings[0].quality='confirmed',f=>f.scene.layout.districts.push({...f.scene.layout.districts[0],id:'D'}),f=>f.map.containerLocationKind='city']){
  const f=fixture();change(f);assert.equal(project(f).geo.localSite,undefined);
 }
});
test('上层单区域城市不画没有路线依据的模板长条，已登记或确认的路和多区域城市保留',()=>{
 const base=()=>{const f=fixture();f.map.containerLocationKind='city';f.map.containerLocationId='town';f.scene.layout.buildings=[];return f;};
 const f=base(),before=JSON.stringify(f),n=project(f);
 assert.equal(n.geo.avenues.length,0);assert.equal(n.geo.districts.length,1);assert.equal(JSON.stringify(f),before);
 for(const change of [f=>f.map.routes.push({id:'real'}),f=>f.scene.layout.roads[0].quality='confirmed',f=>f.scene.layout.roads[0].id='known-street',f=>f.scene.layout.districts.push({...f.scene.layout.districts[0],id:'D'})]){
  const keep=base();change(keep);assert.equal(project(keep).geo.avenues.length,1);
 }
});
test('有内部地图的图标继续指向同一子图；未知内部的地点只留标记',()=>{
 const f=fixture(),map={mapId:'child',name:'修表铺',parentMapId:'square',containerLocationId:'clock',containerLocationKind:'building',points:[]};
 const childScene={units:'meters',layout:{kind:'floor',bounds:{x:0,y:0,w:6,h:8},rooms:[{id:'W',name:'工作间',x:0,y:0,w:6,h:8}],corridor:{x:0,y:0,w:0,h:0}}};
 const n=projectReferenceData({mapView:view([f.map,map]),sceneView:view([{mapId:'square',scene:f.scene},{mapId:'child',scene:childScene}]),catalogView:view(f.catalog),viewMode:'author'}).ROOT;
 assert.equal(n.marks.find(m=>m.id==='clock').node.id,'child');
 assert.equal(n.marks.find(m=>m.id==='weaver').node,null);
 const room=n.geo.cityBuildings.find(b=>b.id==='clock').interior[0];assert.ok(Math.abs(room.w/room.h-6/8)<1e-8);
 assert.deepEqual(n.geo.cityBuildings.find(b=>b.id==='weaver').interior,[]);
});
test('室内画布不再添加父地点和自身的标题框，保留子房间名称',()=>{
 const source=readFileSync(new URL('../ui/atlas-reference/js/map.js',import.meta.url),'utf8');
 const start=source.indexOf('function floorMap('),end=source.indexOf('\n  /**',start),labels=[];
 const ctx=new Proxy({createLinearGradient:()=>({addColorStop(){}})},{get:(t,k)=>t[k]??(()=>{}),set:(t,k,v)=>(t[k]=v,true)});
 const st={node:{host:true,name:'巡河站',transform:{scale:1,bounds:{w:8}}},path:[{name:'石钟广场'}],cam:{s:1},mode:'normal',showLabels:true};
 const rt=vm.createContext({ctx,st,hash:()=>0,skinColor:(a,b,c)=>c,canvasStyle:null,C:{cyan:'#abc'},rrect(){},pushLabel:(...v)=>labels.push(v),furniture(){},drawFurniture(){},hexA:c=>c});
 vm.runInContext(source.slice(start,end),rt);
 rt.floorMap({rooms:[{x:1,y:1,w:2,h:2,name:'值班室'}],hostArea:{x:0,y:0,w:8,h:5,name:'巡河站'},doors:[],furn:[],windows:[],lamps:[]});
 assert.ok(!labels.some(l=>['石钟广场','巡河站'].includes(l[2])));
 assert.ok(labels.some(l=>l[2]==='值班室'));
});
