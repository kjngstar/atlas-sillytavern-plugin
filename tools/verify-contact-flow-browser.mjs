/** Packaged UI + real SQL fixture. No external model or real chat is accessed. */
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {setTimeout as pause} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const dir=process.env.ATLAS_EVIDENCE_DIR||'.tmp/contact-flow-browser';
const port=Number(process.env.ATLAS_VERIFY_PORT||8791);
const url=`http://127.0.0.1:${port}/ui/contact-flow-native.html`;
mkdirSync(dir,{recursive:true});
const report={checks:{},errors:[],failed:[],fixture:'isolated SQL / production release UI'};
function check(name,ok,detail){report.checks[name]={ok:!!ok,detail};assert.ok(ok,name);}
const server=spawn(process.execPath,['--experimental-strip-types','tools/prepare-contact-flow-acceptance.mjs','--serve',`--port=${port}`],{stdio:'ignore'});
let browser;
try{
  for(let i=0;i<100;i++){try{if((await fetch(url)).ok)break;}catch{}await pause(100);}
  browser=await chromium.launch({headless:true,...(process.env.ATLAS_CHROME_PATH?{executablePath:process.env.ATLAS_CHROME_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1600,height:1000}});
  page.on('pageerror',error=>report.errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(()=>!!document.querySelector('iframe')?.contentWindow?.AtlasPreview);
  const frame=page.frames().find(f=>f.url().includes('/atlas-reference/index.html'));
  await frame.locator('[data-select-kind="character"][data-select="C1"]').first().click();
  await frame.waitForFunction(()=>document.getElementById('placeCard').textContent.includes('联系 1'));
  const dto=()=>frame.evaluate(()=>AtlasHost.readFlows(AtlasPreview.state.nodeId,'C1'));
  let value=await dto();
  check('C1-selected-relation',value.relations.some(r=>r.id==='REL_CONTACT'&&r.name==='验收联系：互相认识'));
  await frame.evaluate(()=>{AtlasPreview.map.setPaused(true);AtlasPreview.map.setFlag('showRadar',false);AtlasPreview.map.resize();});
  const pixels=()=>frame.evaluate(()=>Array.from(document.getElementById('map').getContext('2d').getImageData(0,0,document.getElementById('map').width,document.getElementById('map').height).data));
  const on=await pixels();
  await frame.locator('[data-flag="showLinks"]').click();
  await frame.evaluate(()=>AtlasPreview.map.resize());
  const off=await pixels();
  check('C2-toggle-changes-real-canvas',on.some((v,i)=>Math.abs(v-off[i])>8));
  check('C2-toggle-state-off',await frame.locator('[data-flag="showLinks"]').getAttribute('aria-pressed')==='false');
  await frame.locator('[data-flag="showLinks"]').click();
  check('C2-toggle-restores',await frame.locator('[data-flag="showLinks"]').getAttribute('aria-pressed')==='true');
  await frame.locator('#viewModes [data-mode="flow"]').click();
  value=await dto();
  const flow=value.flows.find(f=>f.id==='ACT_TRANSMIT');
  check('P1-registered-polyline',flow?.points.length===4&&flow.progress===.4,flow);
  await pause(700);
  check('P2-waiting-does-not-advance',(await dto()).flows.find(f=>f.id==='ACT_TRANSMIT')?.progress===.4);
  await frame.locator('#dockTabs [data-tab="prop"]').click();
  await frame.locator('[data-show-flow="RF_ORIGIN"]').first().click();
  check('P3-message-opens-flow',await frame.evaluate(()=>AtlasPreview.state.mapMode==='flow'&&AtlasPreview.state.selected.id==='RF_ORIGIN'));
  await frame.locator('.rail-ava').click();
  await frame.waitForFunction(()=>AtlasPreview.data.meta.viewMode==='pov');
  value=await dto();
  check('V1-unknown-propagation-hidden',!value?.flows.length);
  check('V1-unknown-relation-hidden',!value?.relations.length);
  check('V1-unknown-message-hidden',await frame.evaluate(()=>!AtlasPreview.data.MESSAGES.some(m=>m.id==='RF_ORIGIN')));
  await page.setViewportSize({width:390,height:844});
  await pause(150);
  check('narrow-screen-no-horizontal-overflow',await frame.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  check('no-browser-errors',report.errors.length===0,report.errors);
}catch(error){report.failed.push(error.stack);}finally{
  await browser?.close();server.kill();
  writeFileSync(`${dir}/evidence.json`,JSON.stringify(report,null,2));
}
console.log(JSON.stringify({checks:Object.keys(report.checks).length,failed:report.failed,errors:report.errors}));
if(report.failed.length)process.exitCode=1;
