/** Exercise a real artwork ZIP against the packaged UI and local host fixture. */
import {spawn} from 'node:child_process';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {launchAtlasBrowser} from './atlas-browser.mjs';
import {instrumentSkins} from './verify-ui-skins.mjs';
import {readSkinPack} from '../ui/atlas-skin-pack.mjs';

const root=process.cwd();
const path=resolve(process.argv[2]||'skins/qingkong-xinjian/Atlas-QingkongXinjian-1.0.0.zip');
const local=relative(root,path);
if(local.startsWith('..')||local===path)throw Error('Skin ZIP must be inside the project');
const pack=await readSkinPack(await readFile(path));
const count=pack.files.length;
const port=process.env.ATLAS_VERIFY_PORT||'4401';
const base='http://127.0.0.1:'+port;
const dir=resolve(process.env.ATLAS_EVIDENCE_DIR||'.tmp/artwork-skin');
const report={skin:pack.id,checks:[],errors:[]};
await mkdir(dir,{recursive:true});
const save=()=>writeFile(dir+'/report.json',JSON.stringify(report,null,2));
const check=(name,ok,detail)=>report.checks.push({name,ok:!!ok,detail});
const server=spawn(process.execPath,['dev-preview/serve.mjs'],{
  env:{...process.env,ATLAS_PREVIEW_PORT:port,ATLAS_PREVIEW_NO_OPEN:'1'},stdio:'ignore'
});
let browser;
try {
  let ready=false;
  for(let i=0;i<40;i++) {
    try {if((await fetch(base+'/dev-preview/index.html')).ok){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(!ready)throw Error('Preview server did not start');
  browser=await launchAtlasBrowser();
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.addInitScript(instrumentSkins);
  page.on('pageerror',error=>report.errors.push(error.message));
  await page.route('**/dev-preview/index.html',async route=>{
    const response=await route.fetch();
    let html=await response.text();
    html=html.replace('const extensionSettings = { atlas_world_sim: { panelOpen: true, docs: null } };',
      `const extensionSettings = JSON.parse(localStorage.getItem('atlas-artwork-settings')||'null') || { atlas_world_sim: { panelOpen: true, docs: null } };`);
    html=html.replace('saveSettingsDebounced: () => {},',
      `saveSettingsDebounced: () => {localStorage.setItem('atlas-artwork-settings',JSON.stringify(extensionSettings));},`);
    html=html.replace('writeAll: (docs) => { extensionSettings.atlas_world_sim.docs = docs; },',
      `writeAll: (docs) => { extensionSettings.atlas_world_sim.docs = docs;localStorage.setItem('atlas-artwork-settings',JSON.stringify(extensionSettings)); },`);
    await route.fulfill({response,body:html.replaceAll('../atlas-extension/','../release/atlas-ui-extension/')});
  });
  async function open() {
    await page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.AtlasPreview&&window.atlasPreviewConnection);
    const frame=page.frames().find(f=>f.url().includes('/atlas-reference/index.html'));
    await frame.evaluate(()=>AtlasPreview.appearanceReady);
    return frame;
  }
  await page.goto(base+'/dev-preview/index.html');
  let frame=await open();
  const database=await page.evaluate(()=>JSON.stringify(SillyTavern.getContext().chatMetadata.atlas.database));
  // Use the actual file input and its change handler, then inspect the installed state.
  await frame.evaluate(()=>AtlasPreview.page('prefs'));
  await frame.locator('[data-settings-tab="appearance"]').click();
  await frame.locator('#skinImport').setInputFiles(path);
  await frame.waitForFunction(id=>AtlasPreview.getSkin().id===id,pack.id);
  const installed=await frame.evaluate(async id=>({
    saved:!!await AtlasHost.getSkinPack(id),catalog:await AtlasPreview.listSkins(),metrics:__skinMetricsSnapshot()
  }),pack.id);
  check('file-input-installs-and-saves',installed.saved&&installed.catalog.some(row=>row.id===pack.id&&!row.previewOnly),installed);
  check('images-decode-once',installed.metrics.urls===count&&installed.metrics.bitmaps===count,installed.metrics);
  const roles=await frame.evaluate(()=>{
    const style=getComputedStyle(document.getElementById('atlasDemo'));
    return Object.fromEntries(Object.values(AtlasSkinRuntime.CSS_ASSET_ROLES).map(role=>[role,style.getPropertyValue(role)]));
  });
  check('all-css-artwork-roles-loaded',Object.values(roles).every(value=>value.includes('blob:')),Object.keys(roles));
  const controls=await frame.evaluate(()=>{
    const input=document.querySelector('[data-skin-select]');
    const button=document.querySelector('[data-skin-reset]');
    input.focus();
    const focused=getComputedStyle(input);
    button.disabled=true;
    const disabled=getComputedStyle(button).opacity;
    button.disabled=false;
    return {inputFrame:focused.borderImageSource,caret:focused.caretColor,focusWidth:focused.outlineWidth,disabled};
  });
  check('input-focus-and-disabled-feedback',controls.inputFrame.includes('blob:')&&parseFloat(controls.focusWidth)>=2&&parseFloat(controls.disabled)<.6,controls);
  await page.screenshot({path:dir+'/controls.png'});
  await frame.evaluate(()=>AtlasPreview.page('map'));
  await page.screenshot({path:dir+'/desktop.png'});
  for(const width of [360,720,1440]) {
    await page.setViewportSize({width,height:1000});
    for(const profile of ['full','mapFocus','mapOnly']) {
      await frame.evaluate(id=>AtlasPreview.setUIProfile(id),profile);
      const layout=await frame.evaluate(()=>({
        profile:AtlasPreview.state.profileId,overflow:document.documentElement.scrollWidth>innerWidth,
        controls:document.getElementById('profileSwitcher').getBoundingClientRect().width>0,
        canvas:document.getElementById('map').width>0
      }));
      check('layout-'+width+'-'+profile,layout.profile===profile&&!layout.overflow&&layout.controls&&layout.canvas,layout);
      if(width===360&&profile==='full')await page.screenshot({path:dir+'/mobile.png'});
    }
  }
  const hit=await frame.evaluate(()=>{
    const character=AtlasPreview.data.CAST.find(c=>!['away','off','unknown'].includes(c.state));
    if(!character)return null;
    AtlasPreview.showEntity('character',character.id,true);
    AtlasPreview.map.state.cam={...AtlasPreview.map.state.tgt};
    AtlasPreview.map.setPaused(true);
    const state=AtlasPreview.map.state;
    const marker=state.marks.find(m=>m.type==='char'&&m.id===character.id);
    return marker?{id:marker.id,x:(marker.x-state.cam.x)*state.cam.s+state.vw/2,y:(marker.y-state.cam.y)*state.cam.s+state.vh/2}:null;
  });
  if(hit)await frame.locator('#map').click({position:{x:hit.x,y:hit.y}});
  check('artwork-marker-keeps-hit-anchor',!!hit&&await frame.evaluate(id=>AtlasPreview.state.selected?.id===id&&!document.getElementById('mapSelection').hidden,hit?.id));
  await page.screenshot({path:dir+'/map-only.png'});
  const exported=await frame.evaluate(async()=>{
    const {readSkinPack}=await import('../atlas-skin-pack.mjs');
    const result=await readSkinPack(await AtlasPreview.exportSkinPack());
    return {id:result.id,files:result.files.length,roles:Object.keys(result.theme.assets).length};
  });
  check('portable-export-roundtrip',exported.id===pack.id&&exported.files===count&&exported.roles===Object.keys(pack.theme.assets).length,exported);
  const cycles=await frame.evaluate(async id=>{
    const snapshots=[];
    for(let i=0;i<10;i++){
      await AtlasPreview.setTheme('builtin.starmap');snapshots.push(__skinMetricsSnapshot());
      await AtlasPreview.setTheme(id);snapshots.push(__skinMetricsSnapshot());
    }
    return snapshots;
  },pack.id);
  check('ten-switches-reclaim-images',cycles.every((m,i)=>m.urls===(i%2?count:0)&&m.bitmaps===(i%2?count:0)),cycles.map(m=>({urls:m.urls,bitmaps:m.bitmaps})));
  check('world-unchanged',database===await page.evaluate(()=>JSON.stringify(SillyTavern.getContext().chatMetadata.atlas.database)));
  await page.reload();frame=await open();
  const restored=await frame.evaluate(()=>({id:AtlasPreview.getSkin().id,metrics:__skinMetricsSnapshot()}));
  check('reload-restores-artwork',restored.id===pack.id&&restored.metrics.bitmaps===count,restored);
  const removed=await frame.evaluate(id=>AtlasPreview.removeSkin(id),pack.id);
  const released=await frame.evaluate(()=>({id:AtlasPreview.getSkin().id,metrics:__skinMetricsSnapshot()}));
  check('remove-reclaims-artwork',removed.ok&&released.id==='builtin.starmap'&&released.metrics.urls===0&&released.metrics.bitmaps===0,released);
  check('no-browser-errors',report.errors.length===0,report.errors);
} catch(error) {
  report.errors.push(error.stack);
} finally {
  await browser?.close();server.kill();await save();
  console.log(JSON.stringify({skin:pack.id,checks:report.checks.length,failed:report.checks.filter(row=>!row.ok),errors:report.errors},null,2));
  if(report.errors.length||report.checks.some(row=>!row.ok))process.exitCode=1;
}
