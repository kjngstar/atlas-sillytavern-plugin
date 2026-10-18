/** Replay a local analysis export through the packaged UI; never imports or saves a chat. */
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {setTimeout as pause} from 'node:timers/promises';
import {chromium} from 'playwright';
import {projectReferenceData} from '../release/atlas-ui-extension/ui/atlas-reference-data.mjs';
import {referencePresetDocument} from '../release/atlas-ui-extension/ui/atlas-reference-presets.mjs';
import {overview} from '../vendor/atlas-spatial/overview-core.mjs';

const file=process.argv[2];if(!file)throw Error('Usage: node tools/verify-map-hierarchy-browser.mjs <local map-analysis.json> [--rebuild-overview]');
const source=JSON.parse(readFileSync(file,'utf8'));
if(source.kind!=='atlas-map-analysis'||!Array.isArray(source.maps))throw Error('Expected atlas-map-analysis export');
const maps=structuredClone(source.maps),report={checks:{},failed:[],errors:[],mode:'read-only analysis export replay'};
const dir=process.env.ATLAS_EVIDENCE_DIR||'.tmp/map-hierarchy-browser';mkdirSync(dir,{recursive:true});
const check=(name,ok)=>{report.checks[name]=!!ok;if(!ok)report.failed.push(name);};
if(process.argv.includes('--rebuild-overview'))for(const map of maps){
 if(map.scene?.layout?.kind!=='overview')continue;
 const previous=map.scene.layout,spec={...map.scene.constraints,id:map.mapId,mapId:map.mapId,name:map.name,seed:map.mapId,width:previous.bounds.w,height:previous.bounds.h};
 map.scene.layout=overview(spec,previous);
}
const catalog=source.locations.map(l=>({entityId:l.id,entityKind:'location',locationKind:l.kind,name:l.name,mapId:l.mapId,parentLocationId:l.parentLocationId,mobility:l.mobility,anchorLocationId:l.anchorLocationId,summary:l.summary,status:'active'}));
const data=projectReferenceData({state:{chatId:'replay',stateData:{worldName:'地图导出回放'}},viewMode:source.scope.viewMode,scopeKey:'local-replay',
 mapView:{revision:source.scope.revision,items:maps},sceneView:{items:maps.map(m=>({mapId:m.mapId,scene:m.scene}))},catalogView:{items:catalog}});
const initial={data,presets:referencePresetDocument({}),preferences:{version:1,singleClickEnter:false,legendCollapsed:false}};
const port=Number(process.env.ATLAS_VERIFY_PORT||4299),base=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['dev-preview/serve.mjs'],{env:{...process.env,ATLAS_PREVIEW_PORT:String(port),ATLAS_PREVIEW_NO_OPEN:'1'},stdio:'ignore'});
let browser;
try{
 for(let i=0;i<100;i++){try{if((await fetch(base+'/manifest.json')).ok)break;}catch{}await pause(100);}
 browser=await chromium.launch({headless:true,executablePath:process.env.ATLAS_CHROME_PATH});
 const page=await browser.newPage({viewport:{width:1600,height:1000}});
 page.on('pageerror',error=>report.errors.push(error.message));
 await page.route('**/hierarchy-data',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(initial)}));
 await page.route('**/hierarchy-replay.html',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><body style="margin:0"><script type="module">
 const initial=await(await fetch('/hierarchy-data')).json();const frame=document.createElement('iframe');
 frame.style='position:fixed;inset:0;width:100%;height:100%;border:0';
 frame.__atlasHost={initial,boot:async()=>initial,ready(){},savePreferences:async()=>{},diagnostic(){},
 persistPresets:async()=>{},onPage:async()=>{},readFlows:async mapId=>({scopeKey:initial.data.meta.scopeKey,revision:initial.data.meta.revision,mapId,flows:[],relations:[],journeys:[]}),close(){}};
 frame.src='/release/atlas-ui-extension/ui/atlas-reference/index.html';document.body.append(frame);
 </script></body></html>`}));
 await page.goto(base+'/hierarchy-replay.html');
 await page.waitForFunction(()=>!!document.querySelector('iframe')?.contentWindow?.AtlasPreview);
 const frame=page.frames().find(f=>f.url().includes('/atlas-reference/index.html'));
 const walk=(n,out=[])=>{out.push(n);for(const c of n.children??[])walk(c,out);return out;};
 const nodes=walk(data.ROOT),road=nodes.find(n=>n.geo.overviewRoutes?.some(r=>r.id.startsWith('corridor:'))),district=nodes.find(n=>n.kind==='district'&&n.geo.parentContext?.siblings.length);
 check('export-map-count-retained',nodes.filter(n=>n.mapId).length===maps.length);
 if(road){
  await frame.evaluate(id=>{AtlasPreview.go(id);AtlasPreview.map.setFlag('showRadar',false);AtlasPreview.map.fit(false);AtlasPreview.map.setPaused(true);AtlasPreview.map.resize();},road.id);
  check('corridor-has-no-area-blob',road.geo.overviewRoutes.filter(r=>r.locationId).every(r=>!road.geo.overviewShapes.some(s=>s.id===r.locationId)));
  check('no-arbitrary-road-texture-path',!road.geo.overviewFeatures.some(f=>f.type==='road_texture'&&f.line));
  check('exterior-vehicle-visible',await frame.evaluate(()=>AtlasPreview.map.state.marks.some(m=>m.type==='vehicle'&&m.proxy)));
  await page.screenshot({path:`${dir}/roads-and-vehicle.png`});
 }
 if(district){
  await frame.evaluate(id=>{AtlasPreview.go(id);AtlasPreview.map.fit(false);AtlasPreview.map.resize();},district.id);
  check('inherited-parent-outline',await frame.evaluate(()=>AtlasPreview.map.state.geo.parentContext.active.pts.length>=3));
  check('sibling-entry-visible',await frame.evaluate(()=>AtlasPreview.map.state.marks.some(m=>m.context&&m.node?.id)));
  await page.screenshot({path:`${dir}/inherited-district.png`});
  const sibling=district.geo.parentContext.siblings[0];await frame.evaluate(id=>AtlasPreview.go(id),sibling.nodeId);
  check('sibling-navigation-works',await frame.evaluate(id=>AtlasPreview.state.nodeId===id,sibling.nodeId));
 }
 await page.setViewportSize({width:390,height:844});await frame.evaluate(()=>AtlasPreview.map.resize());
 check('narrow-screen-without-horizontal-overflow',await frame.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 check('no-browser-errors',report.errors.length===0);
}catch(error){report.failed.push(error.stack);}finally{
 await browser?.close();server.kill();writeFileSync(`${dir}/evidence.json`,JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report));if(report.failed.length)process.exitCode=1;
