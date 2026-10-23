/** Same UI fixture, camera, browser and software renderer; no external model requests. */
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {launchAtlasBrowser} from './atlas-browser.mjs';
const directory='.tmp/ui-skin-performance',baseline=resolve(process.env.ATLAS_PERF_BASELINE_DIR||'.tmp/ui-baseline/ui'),seconds=Number(process.env.ATLAS_PERF_SECONDS||60),port=4300;
if(!existsSync(join(baseline,'atlas-reference/js/app.js')))throw Error('Extract the rc.2 UI with: mkdir -p .tmp/ui-baseline && git archive 7494ed6 ui | tar -x -C .tmp/ui-baseline');
mkdirSync(directory,{recursive:true});
const report={baselineCommit:'7494ed6',seconds,samples:[],errors:[],startedAt:new Date().toISOString()},save=()=>writeFileSync(`${directory}/evidence.json`,JSON.stringify(report,null,2));save();
const server=spawn(process.execPath,['dev-preview/serve.mjs'],{env:{...process.env,ATLAS_PREVIEW_PORT:String(port),ATLAS_PREVIEW_NO_OPEN:'1'},stdio:'ignore'}),browser=await launchAtlasBrowser();report.browser=browser.version();
try{
 for(let i=0;i<40;i++){try{if((await fetch(`http://127.0.0.1:${port}/dev-preview/index.html`)).ok)break;}catch(_){}await delay(250);}
 const pictures=[];
 for(const kind of ['baseline','current']){
  const page=await browser.newPage({viewport:{width:1600,height:1000}}),reads=[];let bytes=0,zipLoaded=false;
  page.on('pageerror',error=>report.errors.push(kind+': '+error.message));
  page.on('response',response=>{if(response.url().includes('/ui/'))reads.push(response.body().then(body=>{bytes+=body.length;if(response.url().includes('/jszip/'))zipLoaded=true;}).catch(()=>{}));});
  if(kind==='baseline')await page.route('**/release/atlas-ui-extension/ui/**',async route=>{const path=new URL(route.request().url()).pathname.split('/release/atlas-ui-extension/ui/')[1];if(!path||path.includes('..'))return route.abort();const file=join(baseline,path);if(!existsSync(file))return route.abort();const type={'.mjs':'text/javascript','.js':'text/javascript','.html':'text/html','.css':'text/css','.woff':'font/woff'}[extname(file)]||'application/octet-stream';return route.fulfill({contentType:type,body:readFileSync(file)});});
  await page.route('**/dev-preview/index.html',async route=>{const response=await route.fetch();return route.fulfill({response,body:(await response.text()).replaceAll('../atlas-extension/','../release/atlas-ui-extension/')});});
  const start=performance.now();await page.goto(`http://127.0.0.1:${port}/dev-preview/index.html`);await page.waitForFunction(()=>!!document.querySelector('iframe')?.contentWindow?.AtlasPreview);
  const frame=page.frames().find(frame=>frame.url().includes('/atlas-reference/index.html'));await frame.evaluate(()=>AtlasPreview.appearanceReady);await frame.evaluate(()=>document.fonts.ready);await Promise.allSettled(reads);report[kind+'Load']={startupMs:performance.now()-start,bytes,zipLoaded};
  await frame.evaluate(()=>{AtlasPreview.state.motion=false;AtlasPreview.map.setFlag('showRadar',false);AtlasPreview.map.resize();AtlasPreview.map.fit(false);AtlasPreview.map.state.t=0;AtlasPreview.map.setPaused(true);});
  const image=await frame.evaluate(()=>document.getElementById('map').toDataURL('image/png'));pictures.push(image);writeFileSync(`${directory}/${kind}.png`,Buffer.from(image.split(',')[1],'base64'));
  const cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable');const before=await cdp.send('Performance.getMetrics');await frame.evaluate(()=>AtlasPreview.map.setPaused(false));
  const sample=await frame.evaluate(seconds=>new Promise(resolve=>{const intervals=[];let previous=null,start=null;function step(now){if(start===null)start=now;if(previous!==null)intervals.push(now-previous);previous=now;if(now-start>=seconds*1000){const sorted=[...intervals].sort((a,b)=>a-b);resolve({frames:intervals.length,elapsedMs:now-start,medianFrameMs:sorted[Math.floor(sorted.length/2)],p95FrameMs:sorted[Math.floor(sorted.length*.95)]});}else requestAnimationFrame(step);}requestAnimationFrame(step);}),seconds);
  const after=await cdp.send('Performance.getMetrics'),metric=(result,name)=>result.metrics.find(m=>m.name===name)?.value||0;await frame.evaluate(()=>AtlasPreview.map.setPaused(true));
  report.samples.push({kind,profile:'full',...sample,taskMsPerFrame:(metric(after,'TaskDuration')-metric(before,'TaskDuration'))*1000/sample.frames,heapBytes:metric(after,'JSHeapUsedSize')});save();await cdp.detach();await page.close();
 }
 report.defaultCanvasIdentical=pictures[0]===pictures[1];report.canvasSha256=createHash('sha256').update(Buffer.from(pictures[1].split(',')[1],'base64')).digest('hex');report.fullFrameMedianChangePercent=(report.samples[1].medianFrameMs/report.samples[0].medianFrameMs-1)*100;report.fullTaskTimeChangePercent=(report.samples[1].taskMsPerFrame/report.samples[0].taskMsPerFrame-1)*100;
 if(!report.defaultCanvasIdentical)throw Error('Default Canvas pixels changed');if(report.errors.length)throw Error('Browser errors occurred');
}catch(error){report.errors.push(error.message);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();save();await browser.close();server.kill();}
console.log(JSON.stringify(report,null,2));
