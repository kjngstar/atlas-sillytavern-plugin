/** Original supplied UI, real packaged extension and SQL, in Chrome. */
import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {generateFloor,generateCity,generateOverview} from '../vendor/atlas-spatial/index.mjs';
const dir=process.env.ATLAS_EVIDENCE_DIR||'.tmp/reference-browser';mkdirSync(dir,{recursive:true});
const port=Number(process.env.ATLAS_VERIFY_PORT||4296),base=process.env.ATLAS_REVIEW_BASE||`http://127.0.0.1:${port}`;
const report={checks:{},errors:[],failed:[],startedAt:new Date().toISOString()};
const check=(name,ok,detail)=>{report.checks[name]={ok:!!ok,detail};if(!ok)report.failed.push(name);};
const server=process.env.ATLAS_REVIEW_BASE?null:spawn(process.execPath,['dev-preview/serve.mjs'],{env:{...process.env,ATLAS_PREVIEW_PORT:String(port),ATLAS_PREVIEW_NO_OPEN:'1'},stdio:'ignore'});
const browser=await chromium.launch({headless:true,executablePath:process.env.ATLAS_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
// Host fixture follows SillyTavern public/scripts/extensions.js: html receives
// the item click and closes the wand menu, maintaining its visibility flag.
const wandFixture=`<button id="extensionsMenuButton">扩展菜单</button><div id="extensionsMenu" style="display:none;position:fixed;left:20px;top:20px;z-index:100001;background:#333"></div><script>
window.__wandVisible=false;document.getElementById('extensionsMenuButton').onclick=()=>{window.__wandVisible=!window.__wandVisible;document.getElementById('extensionsMenu').style.display=window.__wandVisible?'block':'none';};
document.documentElement.addEventListener('click',e=>{if(window.__wandVisible&&!e.target.closest('#extensionsMenuButton')){window.__wandVisible=false;document.getElementById('extensionsMenu').style.display='none';}});</script>`;
async function open(options={}){const p=await browser.newPage({viewport:{width:1600,height:1000}});p.on('pageerror',e=>report.errors.push(e.message));p.on('response',r=>{if(r.status()>=400)report.errors.push(`${r.status()} ${r.url()}`);});if(options.scene)await p.addInitScript(scene=>window.__reviewScene=scene,options.scene);await p.route('**/dev-preview/index.html',async route=>{const res=await route.fetch(),src=await res.text(),marker='await sqlRuntime.closeSqlSession(migrated.session);';if(!src.includes(marker))throw Error('fixture boundary changed');await route.fulfill({response:res,body:(options.scene?src.replace(marker,`const db=migrated.session.repo.db;
const frame=JSON.parse(db.exec("SELECT frame_json FROM maps WHERE id='world' AND branch_id='main'")[0].values[0][0]);
frame.atlasScene=window.__reviewScene;db.run("UPDATE maps SET frame_json=? WHERE id='world' AND branch_id='main'",[JSON.stringify(frame)]);
const saved=await sqlRuntime.persistSqlSession(migrated.session);if(!saved.saved)throw Error(JSON.stringify(saved.issues));${marker}`):options.fresh?src.replace(marker,marker+'contextValue.chatMetadata={};'):src).replaceAll('../atlas-extension/','../release/atlas-ui-extension/').replace('<body>','<body>'+wandFixture)});});
 await p.goto(`${base}/dev-preview/index.html`);await p.waitForFunction(()=>!!document.querySelector('iframe')?.contentWindow?.AtlasPreview&&!!window.atlasPreviewConnection,{timeout:20000});const f=p.frames().find(f=>f.url().includes('/atlas-reference/index.html'));return {p,f};}
try{
 for(let i=0;i<40;i++){try{if((await fetch(`${base}/dev-preview/index.html`)).ok)break;}catch{}await delay(250);}
 /**
  * M7-02：原样式基线不再靠硬编码 hash。
  *
  * 旧门禁把三个哈希写死在代码里，其中 css/preview.css 用的是**供给原版**的哈希；
  * 之后 a87640f 为了修「HUD 里的进入按钮点不动」合法加了 1 行，门禁就永久红了 ——
  * 而当时的处理方式只能是「盲改 hash」或「删掉门禁」，两条都不可接受。
  *
  * 现在改读可审计台账 docs/reference-ui/provenance.json：
  *  - assets = 供给原版哈希（只读，来自 atlas-ui-source.zip）；
  *  - auditedDeltas = 供给之后每一次改动的逐字记录（提交、原因、加/删了哪几行）。
  * 校验三件事：现行文件哈希 == 台账期望值；每条 delta 声明的增删行真的在/不在文件里；
  * 以及供给原版能否从仓库历史里原样复原（有 git 时）——「可审计」而不是「改了就算」。
  */
 const provenance=JSON.parse(readFileSync('docs/reference-ui/provenance.json','utf8'));
 // 二进制资源（woff）必须按 Buffer 哈希；按 utf8 读会把无效字节替换成 U+FFFD，哈希必然对不上。
 const sha256Bytes=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
 const deltasByFile=new Map();
 for(const d of provenance.auditedDeltas??[]){const list=deltasByFile.get(d.file)??[];list.push(d);deltasByFile.set(d.file,list);}
 check('original-baseline-ledger',Object.keys(provenance.assets??{}).length===3&&/^[0-9a-f]{7,40}$/.test(String(provenance.suppliedCommit))&&Array.isArray(provenance.auditedDeltas)&&!!provenance.suppliedRepoPath,{suppliedCommit:provenance.suppliedCommit,deltas:(provenance.auditedDeltas??[]).length});
 let gitAvailable=true;try{execFileSync('git',['rev-parse','--git-dir'],{stdio:'ignore'});}catch(_){gitAvailable=false;}
 for(const [file,suppliedHash] of Object.entries(provenance.assets)){
   const rel=`release/atlas-ui-extension/ui/atlas-reference/${file}`;
   const actual=sha256Bytes(rel);
   const deltas=deltasByFile.get(file)??[],expected=deltas.length?(deltas.at(-1).currentSha256??suppliedHash):suppliedHash;
   check(`original:${file}`,actual===expected,{actual,expected,supplied:suppliedHash,deltas:deltas.length});
   // 台账不许「声明了改动却没登记」：哈希变了就必须有 delta，没变就不许有 delta。
   check(`original-ledger-matches:${file}`,(actual!==suppliedHash)===(deltas.length>0),{changed:actual!==suppliedHash,deltas:deltas.length});
   if(!deltas.length)continue;
   const text=readFileSync(rel,'utf8');
   for(const d of deltas){
     const added=(d.linesAdded??[]).filter(Boolean),removed=(d.linesRemoved??[]).filter(Boolean);
     check(`delta-content:${file}@${d.commit}`,!!d.reason&&added.every(line=>text.includes(line))&&removed.every(line=>!text.includes(line)),{added:added.length,removed:removed.length});
     let recovered=null;
     try{recovered=execFileSync('git',['show',`${provenance.suppliedCommit}:${provenance.suppliedRepoPath}/${file}`],{encoding:'buffer',maxBuffer:1<<26});}catch(_){recovered=null;}
     check(`delta-provenance:${file}@${d.commit}`,!gitAvailable||(recovered&&createHash('sha256').update(recovered).digest('hex')===suppliedHash),{git:gitAvailable,recovered:!!recovered});
   }
 }
 const {p,f}=await open();
 const {p:fresh,f:freshUi}=await open({fresh:true});await freshUi.waitForFunction(()=>AtlasPreview.data.meta.snapshotSaved===false);check('new-chat-no-snapshot-readable',await freshUi.evaluate(()=>!AtlasPreview.data.DIAGNOSTICS.some(d=>d.message?.includes('SQL_SNAPSHOT_UNAVAILABLE'))));check('new-chat-reading-does-not-save',await fresh.evaluate(()=>!SillyTavern.getContext().chatMetadata.atlas?.database));
 await freshUi.locator('#nextDemo').click();await freshUi.waitForFunction(()=>AtlasPreview.data.RECEIPTS.length>0);await freshUi.locator('[data-tab="receipt"]').click();check('real-model-failure-in-receipts',(await freshUi.locator('#dockBody').innerText()).includes('尚未配置活动 API'));await freshUi.locator('#dockBody details').first().locator('summary').click();check('real-model-failure-detail',(await freshUi.locator('#dockBody pre').first().innerText()).includes('API_NOT_CONFIGURED'));check('failed-first-turn-no-fake-snapshot',await fresh.evaluate(()=>!SillyTavern.getContext().chatMetadata.atlas?.database));await fresh.screenshot({path:`${dir}/native-first-turn-failure.png`});await fresh.close();
 check('packaged-version',await p.evaluate(async()=> (await import('/release/atlas-ui-extension/index.js')).ATLAS_EXTENSION_VERSION===(await (await fetch('/package.json')).json()).version));
 check('native-only',await p.evaluate(()=>document.querySelector('.atlas-native-ui-host')?.children.length===1&&!document.querySelector('.atlas-starmap,.aw-center,.awb-workspace')));
 check('real-catalog',await f.evaluate(()=>AtlasPreview.data.CAST.length===4&&!JSON.stringify(AtlasPreview.data).includes('karan')));
 check('original-structure',await f.evaluate(()=>['panelLeft','panelRight','dock','viewModes','map','minimap','paletteWrap','scaleLabel'].every(id=>document.getElementById(id))));
 await f.evaluate(()=>AtlasHost.close());await p.locator('#extensionsMenuButton').click();await p.locator('#atlas-menu-open').click();check('wand-menu-closes-on-open',await p.evaluate(()=>!window.__wandVisible&&document.getElementById('extensionsMenu').style.display==='none'&&document.querySelector('.atlas-native-ui-host').style.display!=='none'));
 await f.evaluate(()=>AtlasHost.close());await p.locator('#extensionsMenuButton').click();await p.locator('#atlas-menu-open').focus();await p.locator('#atlas-menu-open').press('Enter');check('wand-keyboard-closes-on-open',await p.evaluate(()=>!window.__wandVisible&&document.querySelector('.atlas-native-ui-host').style.display!=='none'));
 await p.keyboard.press('Control+k');check('keyboard-palette',await f.locator('#paletteWrap').evaluate(el=>el.classList.contains('on')));await f.locator('#palInput').press('Escape');
 const painted=await f.evaluate(()=>{const c=document.getElementById('map'),a=c.getContext('2d').getImageData(0,0,c.width,c.height).data,s=new Set();for(let i=0;i<a.length;i+=64)s.add(`${a[i]},${a[i+1]},${a[i+2]}`);return {colors:s.size,width:c.width,height:c.height};});check('canvas-paints',painted.colors>30,painted);
 const snapshot=()=>p.evaluate(()=>JSON.stringify(SillyTavern.getContext().chatMetadata.atlas.database));const before=await snapshot();
 await p.evaluate(()=>atlasPreviewConnection.core.setEnabled(false));await f.locator('[data-view="sim"]').click();await f.waitForFunction(()=>AtlasPreview.data.meta.engine.enabled===false);check('paused-chat-control',await f.locator('[data-engine-enable="true"]').isVisible()&&await f.locator('#nextDemo').isDisabled());await f.locator('[data-engine-enable="true"]').click();await f.waitForFunction(()=>AtlasPreview.data.meta.engine.enabled===true);check('enable-chat-real-host',await p.evaluate(()=>atlasPreviewConnection.core.getState().binding.enabled===true));
 await f.locator('[data-open-backend="connection"]').click();check('backend-connection-entry',await f.locator('#connectionProvider').isVisible());await f.locator('[data-view="sim"]').click();
 await p.evaluate(()=>{window.__originalManual=atlasPreviewConnection.core.manualAdvance;atlasPreviewConnection.core.manualAdvance=async()=>{throw Error('验收故障：API_NOT_CONFIGURED');};});await f.locator('[data-demo-next]').click();await f.waitForFunction(()=>!!document.querySelector('[data-engine-error]'));check('advance-error-stays-visible',(await f.locator('[data-engine-error]').innerText()).includes('API_NOT_CONFIGURED'));await f.locator('[data-page="diag"]').first().click();check('advance-error-in-diagnostics',(await f.locator('#diagnosticRows').innerText()).includes('API_NOT_CONFIGURED'));await p.evaluate(()=>{atlasPreviewConnection.core.manualAdvance=window.__originalManual;});await f.locator('[data-view="map"]').click();
 const zoom=()=>f.evaluate(()=>AtlasPreview.map.state.tgt.s);
 const z=await zoom();await f.locator('#zIn').click();await delay(250);check('zoom-in',(await zoom())>z);await f.locator('#zOut').click();await delay(250);check('zoom-out',Math.abs((await zoom())-z)<0.001);
 const width=await f.locator('.sc-line i').evaluate(el=>el.dataset.width);check('original-scale-74px',width==='74',width);
 const grid=await f.evaluate(()=>AtlasPreview.map.state.showGrid);await f.locator('#zGrid').click();check('grid-toggle',await f.evaluate(v=>AtlasPreview.map.state.showGrid!==v,grid));
 const cam=await f.evaluate(()=>AtlasPreview.map.state.tgt.x);const bounds=await f.locator('#map').boundingBox();await p.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await p.mouse.down();await p.mouse.move(bounds.x+bounds.width/2+90,bounds.y+bounds.height/2+30,{steps:8});await p.mouse.up();check('drag-pan',await f.evaluate(v=>Math.abs(AtlasPreview.map.state.tgt.x-v)>10,cam));
 await f.locator('#zFit').click();await f.locator('#leftCollapse').click();check('left-collapse',await f.evaluate(()=>AtlasPreview.state.leftClosed));await f.locator('#reopenLeft').click();
 await f.locator('#legendToggle').click();check('legend-toggle',await f.locator('#legendToggle').getAttribute('aria-expanded')==='false');
 await f.locator('#dockToggle').click();check('dock-collapse',await f.locator('#dock').evaluate(el=>el.classList.contains('collapsed')));await f.locator('#dockToggle').click();
 const mini=await f.locator('#minimap').boundingBox(),miniBefore=await f.evaluate(()=>AtlasPreview.map.state.tgt.x);await p.mouse.click(mini.x+mini.width*.3,mini.y+mini.height*.5);check('minimap-recenters',await f.evaluate(x=>Math.abs(AtlasPreview.map.state.tgt.x-x)>5,miniBefore));await f.locator('#zFit').click();
 await f.locator('#btnPalette').click();const char=await f.evaluate(()=>AtlasPreview.data.CAST[0]);await f.locator('#palInput').fill(char.name);check('palette-real-search',(await f.locator('#paletteWrap').innerText()).includes(char.name));await f.locator('#palInput').press('Escape');
 await f.evaluate(()=>AtlasPreview.go(AtlasPreview.data.ROOT.id));await delay(350);
 const place=await f.evaluate(()=>{const s=AtlasPreview.map.state,r=document.getElementById('map').getBoundingClientRect();return s.marks.filter(m=>m.placeId&&m.node).map(m=>({id:m.placeId,child:m.node.id,x:r.left+s.vw/2+(m.x-s.cam.x)*s.cam.s,y:r.top+s.vh/2+(m.y-s.cam.y)*s.cam.s})).find(p=>p.x>r.left+245&&p.x<r.right-90&&p.y>r.top+200&&p.y<r.bottom-180);});
 if(!place)throw Error('No visible real child-map marker in fixture');await p.mouse.click(place.x,place.y);check('single-click-inspects',await f.evaluate(id=>AtlasPreview.state.selected?.id===id,place.id));await f.locator(`#inspector [data-go="${place.child}"]`).click();check('original-enter-button',await f.evaluate(id=>AtlasPreview.state.nodeId===id,place.child));await f.locator('#crumbs [data-go]').first().click();check('breadcrumb-return',await f.evaluate(()=>AtlasPreview.state.nodeId===AtlasPreview.data.ROOT.id));
 await f.evaluate(id=>AtlasPreview.showEntity('character',id,true),char.id);await f.waitForFunction(()=>document.getElementById('insTitle').textContent==='对象详情');check('entity-detail',(await f.locator('#inspector').innerText()).includes(char.name));
 for(const tab of ['cast','items','msgs','sim','time','lore','diag','prefs']){await f.locator(`[data-view="${tab}"]`).click();check(`page:${tab}`,await f.locator('#workspacePage').isVisible());}
 // ── M7-02：U01–U06 的真实浏览器验收（像素、手势、命中这类 jsdom 断言不了的部分） ──
 await f.locator('[data-view="map"]').click();
 /** HUD 里的 `.hud-place` 带 pointer-events:none（供给版如此），子元素必须自己把点击拿回来。
  *  台账里那条 preview.css delta 修的就是这个 —— 这里做真实 hit-test，改了就算回归。 */
 const hitTest=async(locator,ownerSelector)=>{const box=await locator.boundingBox();if(!box)return null;
   return f.evaluate(([x,y,sel])=>{const el=document.elementFromPoint(x,y);const owner=el?.closest(sel)??null;
     return {tag:el?.tagName??null,owner:owner?owner.tagName:null,text:owner?owner.textContent:null};},[box.x+box.width/2,box.y+box.height/2,ownerSelector]);};
 const childMapId=await f.evaluate(()=>AtlasPreview.data.ROOT.children.find(n=>n.host&&n.containerLocationId)?.id??null);
 if(childMapId){await f.evaluate(id=>AtlasPreview.go(id),childMapId);await delay(300);
   const hud=await hitTest(f.locator('#placeCard [data-layout]'),'[data-layout]');
   check('U01-hud-layout-button-clickable',!!hud&&hud.owner==='BUTTON',hud);
   // U02：74px 线长固定 —— 折叠图例、折叠左栏、缩放都只改读数，不改线长。
   const scaleNow=async()=>f.locator('.sc-line i').evaluate(el=>({width:el.dataset.width,distance:el.dataset.distance,label:document.getElementById('scaleLabel').textContent}));
   const s0=await scaleNow();
   await f.locator('#legendToggle').click();const s1=await scaleNow();await f.locator('#legendToggle').click();
   await f.locator('#leftCollapse').click();const s2=await scaleNow();await f.locator('#reopenLeft').click();
   await f.locator('#zIn').click();await delay(250);const s3=await scaleNow();
   check('U02-scale-width-fixed-74',[s0,s1,s2,s3].every(x=>x.width==='74'),[s0.width,s1.width,s2.width,s3.width]);
   // 读数只由「每 UI 单位多少 CSS 像素 × 每 UI 单位多少米」决定；缩放加倍，读数必须减半（用真实相机与真实标定算）。
   const scaleRelation=await f.evaluate(()=>{const m=AtlasUIModel,s=AtlasPreview.map.state.cam.s,metric=AtlasPreview.map.state.node?.metric;
     const a=m.fixedScale(s,metric),b=m.fixedScale(s*2,metric);
     return {wa:a.width,wb:b.width,da:a.distance,db:b.distance,la:a.label,lb:b.label,unit:a.unit};});
   check('U02-scale-readout-inverse-proportional',scaleRelation.wa===74&&scaleRelation.wb===74&&Number.isFinite(scaleRelation.da)&&Math.abs(scaleRelation.da-2*scaleRelation.db)<1e-9&&scaleRelation.la!==scaleRelation.lb,scaleRelation);
   await f.locator('#zFit').click();await delay(250);
   // U03：网格步长 1/2/5×10^n、屏距 12–40 CSS px、单帧线数封顶 —— 直接问渲染器的纯函数。
   const gridContract=await f.evaluate(list=>{const m=AtlasPreview.map,out=[];
     for(const s of list){const step=m.gridStep(s);out.push({s,step,px:step*s});}return out;},[0.02,0.1,0.5,1,3.7,12,60,300]);
   check('U03-grid-step-contract',gridContract.every(x=>x.step>0&&[1,2,5].some(m=>Math.abs(Number(x.step.toExponential().split('e')[0])-m)<1e-9)&&x.px>=12&&x.px<=40.0001),gridContract.map(x=>`${x.s}:${x.step}`).join(' '));
   const gridLines=await f.evaluate(()=>AtlasPreview.map.paintGrid(document.createElement('canvas').getContext('2d'),{cam:{x:0,y:0,s:1e-6},vw:4000,vh:4000,dpr:1,step:1e-9}));
   check('U03-grid-line-cap',gridLines<=2000,gridLines);
   // 停帧后逐像素比对：同一相机、同一 t，唯一变量就是网格有没有画。
   // 先量一次「同一状态重画的噪声」，再要求开/关网格造成的差异远大于噪声 —— 不用裸哈希相等冒充确定性。
   await f.evaluate(()=>{const c=document.getElementById('map');
     window.__atlasGrab=()=>{window.__px=c.getContext('2d').getImageData(0,0,c.width,c.height).data.slice();};
     window.__atlasDiff=()=>{const a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;
       for(let i=0;i<a.length;i+=4)if(Math.abs(a[i]-window.__px[i])+Math.abs(a[i+1]-window.__px[i+1])+Math.abs(a[i+2]-window.__px[i+2])>12)n++;return n;};});
   await f.evaluate(()=>{AtlasPreview.map.setPaused(true);AtlasPreview.map.resize();window.__atlasGrab();});
   await f.evaluate(()=>AtlasPreview.map.resize());
   const gridNoise=await f.evaluate(()=>window.__atlasDiff());
   await f.evaluate(()=>window.__atlasGrab());
   await f.locator('#zGrid').click();await f.evaluate(()=>AtlasPreview.map.resize());
   const gridDiff=await f.evaluate(()=>window.__atlasDiff());
   await f.locator('#zGrid').click();await f.evaluate(()=>AtlasPreview.map.resize());
   const gridNoiseAgain=await f.evaluate(()=>window.__atlasDiff());
   await f.evaluate(()=>AtlasPreview.map.setPaused(false));
   check('U03-grid-actually-painted',gridDiff>Math.max(gridNoise*20,2000)&&gridNoiseAgain<=gridNoise,{gridDiff,gridNoise,gridNoiseAgain});
   // U04：真实 hover 不改锚点 —— 鼠标压上去，可命中点与世界坐标一动不动。
   // 先回世界图（子图上可能一个标记都没有，拿不到可悬停目标）。
   await f.evaluate(()=>AtlasPreview.go(AtlasPreview.data.ROOT.id));await f.locator('#zFit').click();await delay(350);
   const marks=async()=>f.evaluate(()=>AtlasPreview.map.state.hits.map(h=>[h.m.id,Math.round(h.x),Math.round(h.y)]));
   const rect=await f.locator('#map').boundingBox();
   const hoverPoint=await f.evaluate(()=>{const h=AtlasPreview.map.state.hits[0];if(!h)return null;const r=document.getElementById('map').getBoundingClientRect();return {x:r.left+h.x,y:r.top+h.y,id:h.m.id};});
   const beforeHover=await marks();
   if(hoverPoint){await p.mouse.move(hoverPoint.x,hoverPoint.y);await delay(250);}
   const afterHover=await marks();
   check('U04-hover-keeps-anchors',!!hoverPoint&&JSON.stringify(beforeHover)===JSON.stringify(afterHover),{id:hoverPoint?.id,moved:beforeHover.filter((h,i)=>JSON.stringify(h)!==JSON.stringify(afterHover[i]))});
   check('U04-hover-hits-same-mark',!!hoverPoint&&await f.evaluate(id=>AtlasPreview.map.state.hover?.id===id,hoverPoint.id));
   await p.mouse.move(rect.x+4,rect.y+4);await delay(150);
   // U05：本轮动向与历史记录是一份数据的**不重叠划分**；本轮为空必须明说。
   const feed=await f.evaluate(()=>({latestTurnId:AtlasPreview.data.meta.latestTurnId,turn:AtlasPreview.data.meta.turn,
     known:AtlasPreview.data.EVENTS.filter(e=>e.known).length,turnN:AtlasPreview.turnEvents().length,histN:AtlasPreview.historyEvents().length,
     overlap:AtlasPreview.turnEvents().filter(e=>AtlasPreview.historyEvents().some(h=>h.id===e.id)).length,
     turnIds:[...new Set(AtlasPreview.turnEvents().map(e=>e.turnId))]}));
   check('U05-turn-and-history-partition',feed.overlap===0&&feed.turnN+feed.histN===feed.known&&(feed.latestTurnId==null||feed.turnIds.every(id=>id===feed.latestTurnId)),feed);
   await f.locator('[data-view="sim"]').click();await delay(150);
   const simText=await f.locator('#workspacePage').innerText();
   check('U05-empty-turn-is-explained',feed.turnN>0||simText.includes('本轮暂无新的世界动向'),{turnN:feed.turnN});
   await f.locator('[data-view="map"]').click();
   // U06：POV 不得把作者可见的实体从任何界面区域漏回来。
   const authorNames=await f.evaluate(()=>AtlasPreview.data.CAST.map(c=>c.name).concat(AtlasPreview.data.LOCATIONS.map(l=>l.name)));
   await f.evaluate(()=>AtlasPreview.switchView('pov'));await f.waitForFunction(()=>AtlasPreview.data.meta.viewMode==='pov');
   const povLeak=await f.evaluate(names=>{const zones=['#inspector','#railList','#dockBody','#placeCard','#crumbs','#workspacePage'];
     const text=zones.map(z=>document.querySelector(z)?.innerText??'').join('\n');
     return {leaked:names.filter(n=>n&&text.includes(n)),povCast:AtlasPreview.data.CAST.length,povLoc:AtlasPreview.data.LOCATIONS.length};},authorNames);
   check('U06-pov-does-not-leak-hidden-entities',povLeak.leaked.length===0,povLeak);
   check('U06-pov-narrows-entities',povLeak.povCast<authorNames.length/2||povLeak.povLoc===0,povLeak);
   await f.evaluate(()=>AtlasPreview.switchView('author'));await f.waitForFunction(()=>AtlasPreview.data.meta.viewMode==='author');
   await f.evaluate(()=>AtlasPreview.go(AtlasPreview.data.ROOT.id));await delay(250);
 }else{check('U01-hud-layout-button-clickable',false,'夹具里没有带容器的子图，无法验证内存 HUD 按钮中的布局按钮');}
 // 下面几步要用设置页的分类标签，收尾必须回到「预设与外观」，别把后续检查踩空。
 await f.locator('[data-view="prefs"]').click();await delay(150);
 await f.locator('[data-settings-tab="connection"]').click();await f.locator('#connectionName').fill('原版接入验收连接');await f.locator('#connectionProvider').selectOption('sillytavern');await f.locator('[data-save-connection]').click();await delay(300);check('connection-save-status',await f.evaluate(()=>!AtlasPreview.presets.status.error),await f.evaluate(()=>AtlasPreview.presets.status));
 let settings=await p.evaluate(async()=> (await atlasPreviewConnection.api.request('GET','/settings')).body.data);
 check('connection-real-save',settings.apiPresets.some(c=>c.name==='原版接入验收连接'&&c.connectionMode==='main'),{count:settings.apiPresets.length});
 await f.locator('[data-settings-tab="prompts"]').click();await f.locator('[data-preset-new="prompt"]').click();await f.locator('#promptPresetName').fill('原版接入验收提示词');await f.locator('[data-prompt-content]').first().fill('保持真实实体标识，按当前 SQL 协议回复。');await f.locator('[data-save-prompts]').click();await delay(200);
 settings=await p.evaluate(async()=> (await atlasPreviewConnection.api.request('GET','/settings')).body.data);check('prompt-real-save',settings.promptPresets.some(c=>c.name==='原版接入验收提示词'&&c.segments[0].content.includes('真实实体')));
 // Failed save must retain the editable draft and original saved settings.
 const savedPrompt=JSON.stringify(settings.promptPresets);await f.locator('[data-prompt-content]').first().fill('x'.repeat(8001));await f.locator('[data-save-prompts]').click();check('failed-save-keeps-draft',(await f.locator('[data-prompt-content]').first().inputValue()).length===8001);
 settings=await p.evaluate(async()=> (await atlasPreviewConnection.api.request('GET','/settings')).body.data);check('failed-save-keeps-settings',JSON.stringify(settings.promptPresets)===savedPrompt);
 // Real host book API, within the isolated preview fixture.
 await p.evaluate(()=>{const c=SillyTavern.getContext();c.chatMetadata.world_info='原版验收世界书';c.extensionSettings.atlas_world_sim.lorebooks??={};c.extensionSettings.atlas_world_sim.lorebooks['原版验收世界书']={entries:{1:{uid:1,comment:'真实世界书条目',key:['真实世界书条目'],content:'真实宿主资料',disable:false,order:90}}};});
 await f.locator('[data-view="lore"]').click();await f.waitForFunction(()=>AtlasPreview.data.LORE.some(x=>x.title==='真实世界书条目'));
 check('real-lore-read',(await f.locator('#workspacePage').innerText()).includes('真实宿主资料'));
 await f.locator('[data-lore-toggle]').click();await delay(100);check('real-lore-toggle',await p.evaluate(()=>SillyTavern.getContext().extensionSettings.atlas_world_sim.lorebooks['原版验收世界书'].entries[1].disable===true));
 await f.locator('[data-view="prefs"]').click();await f.locator('[data-settings-tab="interaction"]').click();await f.locator('[data-single-click-enter]').check();check('interaction-setting',await f.evaluate(()=>AtlasPreview.state.singleClickEnter));
 await f.locator('[data-settings-tab="appearance"]').click();await f.locator('#skinAccent').fill('#43e0ff');await f.locator('#skinAccent').dispatchEvent('input');await f.locator('[data-view="map"]').click();
 check('viewing-does-not-write-world',(await snapshot())===before);
 const authorCount=await f.evaluate(()=>AtlasPreview.data.CAST.length);await f.locator('.rail-ava').click();await f.waitForFunction(()=>AtlasPreview.data.meta.viewMode==='pov');check('pov-requeries',await f.evaluate(n=>AtlasPreview.data.CAST.length<=n&&AtlasPreview.state.selected===null,authorCount));await f.locator('.rail-ava').click();await f.waitForFunction(()=>AtlasPreview.data.meta.viewMode==='author');
 await p.screenshot({path:`${dir}/native-desktop.png`});await p.setViewportSize({width:390,height:844});await delay(400);check('mobile-no-overflow',await f.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await p.screenshot({path:`${dir}/native-mobile.png`});await p.setViewportSize({width:1600,height:1000});
 const locations=await p.evaluate(async()=>{const sql=await import('/release/atlas-ui-extension/dist/atlas-sql.mjs'),ctx=SillyTavern.getContext(),s=await sql.openSqlSession({chatUid:ctx.chatId,chatMetadata:ctx.chatMetadata,saveSession:async()=>{throw Error('read only');}});try{return (await s.repo.queryView({kind:'catalog',entityKind:'location',viewMode:'author'})).items.filter(x=>x.mapId==='world').slice(0,6).map(x=>({id:x.entityId,name:x.name}));}finally{await sql.closeSqlSession(s);}});
 const scope={chatId:'review',branchId:'main',revision:0,viewMode:'author'},context={scope,map:{id:'world',name:'空间验收',metersPerCell:2,frame:{cols:15,rows:12}},entities:{locations:locations.map(x=>x.id),characters:[],items:[]}};
 /** 概览层：真实路线端点（走 locks.points）+ 分区 + 水系/林地装饰，全部从生成器的正式入口走。 */
 const overviewContext={...context,entities:{...context.entities,routes:['review-route']},
   routesById:{'review-route':{from_location_id:locations[0].id,to_location_id:locations[1].id}},
   locks:{points:{[locations[0].id]:{x:120,y:90},[locations[1].id]:{x:900,y:620}}}};
 const generated={
   floor:generateFloor({id:'world',width:42,height:34,corridorWidth:3,rooms:locations.map((x,i)=>({...x,side:i<3?'north':'south',w:12,h:12})),contents:[{id:'review-shelf',name:'书架',roomId:locations[0].id,type:'shelf',w:3,h:1}],actors:[],items:[]},{...context,map:{...context.map,frame:{cols:21,rows:17}}}),
   city:generateCity({id:'world',width:1200,height:900,riverWidth:36,blocksPerDistrict:3,districts:locations.slice(0,4).map((x,i)=>({...x,bank:i%2?'east':'west',order:Math.floor(i/2)})),buildings:[]},{...context,map:{...context.map,metersPerCell:30,frame:{cols:40,rows:30}}}),
   overview:generateOverview({id:'world',surface:'forest',
     zones:locations.slice(0,4).map((x,i)=>({...x,role:i===0?'settlement':'forest',size:'medium'})),
     links:[{id:'review-route',name:'验收路线'}],
     features:[{id:'review-water',name:'验收河',type:'watercourse',zoneId:locations[0].id,fromSector:'north',toSector:'south',widthClass:'medium'},
       {id:'review-ridge',name:'验收山脊',type:'ridge',density:'low'},
       {id:'review-woods',name:'验收林地',type:'forest_texture',zoneId:locations[1].id,density:'high'}]},
     {...overviewContext,map:{...overviewContext.map,metersPerCell:30,frame:{cols:50,rows:30}}})};
 // 每个层级断言的是「界面真的读到了这类图元」，不是「生成器自己说 ok」。
 // 概览的封锁型装饰（林地）可能因为避让真实内容被整条丢弃 —— 那是 G05/G06 要的行为，
 // 所以这里只要求「水系 + 无 zone 的山脊」都在，并记录实际拿到了哪些类型。
 const expectTier={
   floor:actual=>actual.rooms===locations.length&&actual.furniture>0&&actual.marks>0,
   city:actual=>actual.districts===4&&actual.river>20&&actual.marks>0,
   overview:actual=>actual.shapes===4&&actual.routes>=1&&actual.features>=2
     &&actual.featureTypes.includes('watercourse')&&actual.featureTypes.includes('ridge')&&actual.surface==='forest'};
 for(const [kind,g] of Object.entries(generated)){
   if(!g.ok)throw Error(`${kind}: ${JSON.stringify(g.issues)}`);
   const {p:proof,f:ff}=await open({scene:g.scene});
   await ff.waitForFunction(k=>{const s=AtlasPreview.map.state;
     return k==='overview'?(s.geo.overviewShapes?.length??0)>0:s.kind===k;},kind);
   const actual=await ff.evaluate(()=>({kind:AtlasPreview.map.state.kind,rooms:AtlasPreview.map.state.geo.rooms?.length,river:AtlasPreview.map.state.geo.river?.length,
     districts:AtlasPreview.map.state.geo.districts?.length,furniture:AtlasPreview.map.state.geo.furn?.length,marks:AtlasPreview.map.state.marks.length,
     shapes:AtlasPreview.map.state.geo.overviewShapes?.length,features:AtlasPreview.map.state.geo.overviewFeatures?.length,routes:AtlasPreview.map.state.geo.overviewRoutes?.length,
     featureTypes:(AtlasPreview.map.state.geo.overviewFeatures??[]).map(x=>x.type),surface:AtlasPreview.map.state.geo.surface??null}));
   check(`saved-${kind}`,expectTier[kind](actual),actual);
   check(`saved-${kind}-painted`,(await ff.evaluate(()=>{const c=document.getElementById('map'),a=c.getContext('2d').getImageData(0,0,c.width,c.height).data,s=new Set();for(let i=0;i<a.length;i+=64)s.add(`${a[i]},${a[i+1]},${a[i+2]}`);return s.size;}))>18);
   await proof.screenshot({path:`${dir}/native-${kind}.png`});await proof.close();
 }
 await f.evaluate(()=>AtlasHost.close());check('host-close',await p.locator('.atlas-native-ui-host').evaluate(el=>el.style.display==='none'));await p.evaluate(()=>atlasPreviewConnection.core.setPanelOpen(true));check('host-reopen',await p.locator('.atlas-native-ui-host').evaluate(el=>el.style.display!=='none'));
 check('no-browser-errors',report.errors.length===0,report.errors);await p.close();
}catch(e){report.failed.push(e.stack);}finally{report.finishedAt=new Date().toISOString();writeFileSync(`${dir}/evidence.json`,JSON.stringify(report,null,2));await browser.close();server?.kill();}
console.log(JSON.stringify({checks:Object.keys(report.checks).length,failed:report.failed,errors:report.errors,evidence:dir},null,2));if(report.failed.length)process.exitCode=1;
