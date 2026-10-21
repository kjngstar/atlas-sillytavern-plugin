/** Runs inside the real packaged reference browser gate; isolated host fixtures only. */
import {writeFileSync} from 'node:fs';
export function instrumentSkins(){
 const metrics=window.__skinMetrics={listeners:0,observers:0,urls:0,bitmaps:0},registrations=new WeakMap(),frames=new Set(),urls=new Set();
 const add=EventTarget.prototype.addEventListener,remove=EventTarget.prototype.removeEventListener;
 function bucket(target,type,options){let map=registrations.get(target);if(!map)registrations.set(target,map=new Map());const key=type+':'+(typeof options==='boolean'?options:!!options?.capture);if(!map.has(key))map.set(key,new Set());return map.get(key);}
 EventTarget.prototype.addEventListener=function(type,fn,options){const set=bucket(this,type,options);if(fn&&!set.has(fn)){set.add(fn);metrics.listeners++;}return add.call(this,type,fn,options);};
 EventTarget.prototype.removeEventListener=function(type,fn,options){if(bucket(this,type,options).delete(fn))metrics.listeners--;return remove.call(this,type,fn,options);};
 const raf=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);
 window.requestAnimationFrame=fn=>{const id=raf(t=>{frames.delete(id);fn(t);});frames.add(id);return id;};window.cancelAnimationFrame=id=>{frames.delete(id);return cancel(id);};
 const Observer=window.ResizeObserver;window.ResizeObserver=class extends Observer{constructor(fn){super(fn);this.closed=false;metrics.observers++;}disconnect(){if(!this.closed){this.closed=true;metrics.observers--;}return super.disconnect();}};
 const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=blob=>{const url=create(blob);urls.add(url);metrics.urls=urls.size;return url;};URL.revokeObjectURL=url=>{urls.delete(url);metrics.urls=urls.size;return revoke(url);};
 const decode=window.createImageBitmap.bind(window);window.createImageBitmap=async(...args)=>{const bitmap=await decode(...args),close=bitmap.close.bind(bitmap);let closed=false;metrics.bitmaps++;bitmap.close=()=>{if(!closed){closed=true;metrics.bitmaps--;}close();};return bitmap;};
 window.__skinMetricsSnapshot=()=>({...metrics,rafs:frames.size,canvases:document.querySelectorAll('canvas').length});
}
export async function verifySkins({open,check,dir}){
 const {p,f:initialFrame}=await open({persist:true,instrument:true});let f=initialFrame;
 const sample=()=>f.evaluate(()=>({data:JSON.stringify(AtlasPreview.data),id:AtlasPreview.state.nodeId,canvas:document.getElementById('map'),x:AtlasPreview.map.state.cam.x,y:AtlasPreview.map.state.cam.y,zoom:AtlasPreview.map.state.cam.s/AtlasPreview.map.fitScale()}));
 try{
  await f.evaluate(()=>AtlasPreview.appearanceReady);const databaseBefore=await p.evaluate(()=>JSON.stringify(SillyTavern.getContext().chatMetadata.atlas.database));
  await f.evaluate(()=>{window.__originalCanvas=document.getElementById('map');window.__businessCalls=[];for(const key of ['advance','layout','build','undo']){const original=AtlasHost[key];AtlasHost[key]=(...args)=>{window.__businessCalls.push(key);return original?.(...args);};}});
  const before=await sample();
  for(const theme of ['builtin.starmap','builtin.parchment'])for(const profile of ['full','mapFocus','mapOnly']){
   const result=await f.evaluate(async({theme,profile})=>{await AtlasPreview.setTheme(theme);await AtlasPreview.setUIProfile(profile);return {skin:AtlasPreview.getSkin().id,profile:AtlasPreview.state.profileId,node:AtlasPreview.state.nodeId,sameCanvas:document.getElementById('map')===window.__originalCanvas,center:[AtlasPreview.map.state.cam.x,AtlasPreview.map.state.cam.y]};},{theme,profile});
   check(`skins:combo:${theme}:${profile}`,result.skin===theme&&result.profile===profile&&result.node===before.id&&result.sameCanvas&&Math.abs(result.center[0]-before.x)<1e-6&&Math.abs(result.center[1]-before.y)<1e-6,result);
   await p.screenshot({path:`${dir}/${theme.split('.')[1]}-${profile}.png`});
  }
  await f.evaluate(()=>AtlasPreview.setUIProfile('full'));
  const legibility=await f.evaluate(()=>{const luminance=rgb=>rgb.map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((n,x,i)=>n+x*[.2126,.7152,.0722][i],0),background=luminance([243,233,211]),ratios=['.brand-name','.pl-name','.cc-name'].map(selector=>{const color=getComputedStyle(document.querySelector(selector)).color.match(/[\d.]+/g).slice(0,3).map(Number),foreground=luminance(color);return (Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05);});return {font:getComputedStyle(document.getElementById('atlasDemo')).fontFamily,ratios};});check('skins:paper-text-and-Chinese-fallback',legibility.font.includes('Atlas Preview Sans')&&legibility.ratios.every(n=>n>=4.5),legibility);
  const emulation=await p.context().newCDPSession(p);
  for(const dpr of [1,2])for(const width of [360,540,720,1280,1920]){
   await p.setViewportSize({width,height:1000});await emulation.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:dpr,mobile:false});
   for(const profile of ['full','mapFocus','mapOnly']){
    await f.evaluate(id=>AtlasPreview.setUIProfile(id),profile);const layout=await f.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,controls:!!document.getElementById('profileSwitcher').getBoundingClientRect().width,canvas:document.getElementById('map').width>0,dpr:Math.min(devicePixelRatio,2),scale:document.querySelector('.sc-line i').getBoundingClientRect().width}));
    check(`skins:layout:${width}:${dpr}:${profile}`,!layout.overflow&&layout.controls&&layout.canvas&&layout.dpr===dpr&&layout.scale===74,layout);
   }
  }
  await p.setViewportSize({width:1600,height:1000});await emulation.send('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});await emulation.detach();
  await f.evaluate(()=>AtlasPreview.setUIProfile('full'));const baseline=await f.evaluate(()=>__skinMetricsSnapshot());
  const switches=await f.evaluate(async()=>{for(let i=0;i<100;i++){await AtlasPreview.setUIProfile(['full','mapFocus','mapOnly'][i%3]);await AtlasPreview.setTheme(i%2?'builtin.starmap':'builtin.parchment');}await AtlasPreview.setUIProfile('full');return __skinMetricsSnapshot();});
  check('skins:100-switches-no-growth',switches.listeners===baseline.listeners&&switches.observers===baseline.observers&&switches.canvases===baseline.canvases&&switches.rafs<=1&&switches.urls===0&&switches.bitmaps===0,{baseline,switches});
  check('skins:no-world-writes',await p.evaluate(()=>JSON.stringify(SillyTavern.getContext().chatMetadata.atlas.database))===databaseBefore);
  check('skins:no-business-calls',await f.evaluate(()=>window.__businessCalls.length===0));
  await f.evaluate(()=>AtlasPreview.page('prefs'));await f.locator('[data-settings-tab="appearance"]').click();
  await f.locator('[data-skin-component="frame"]').selectOption('minimal');check('skins:frame-control',await f.evaluate(()=>AtlasPreview.getSkin().components.frame==='minimal'&&document.getElementById('atlasDemo').dataset.skinFrame==='minimal'));
  await f.locator('[data-skin-map-style="road"]').selectOption('technical');check('skins:map-painter-control',await f.evaluate(()=>AtlasPreview.getSkin().mapStyles.road==='technical'&&AtlasPreview.map.skin.painters.road==='technical'));
  await f.locator('[data-skin-token="ui.font.family"]').selectOption('serif');check('skins:font-control',await f.evaluate(()=>getComputedStyle(document.getElementById('atlasDemo')).fontFamily.includes('Georgia')));
  await f.locator('[data-skin-reset]').click();await f.evaluate(()=>AtlasPreview.page('map'));
  const install=await f.evaluate(async()=>{
   const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const ctx=canvas.getContext('2d');ctx.fillStyle='#825128';ctx.fillRect(0,0,64,64);ctx.strokeStyle='#efd9a0';ctx.lineWidth=8;ctx.strokeRect(4,4,56,56);const bytes=new Uint8Array(await(await new Promise(resolve=>canvas.toBlob(resolve,'image/png'))).arrayBuffer());
   const {writeSkinPack}=await import('../atlas-skin-pack.mjs'),theme={...AtlasSkinRuntime.builtin('builtin.parchment'),id:'user.browser-acceptance',assets:{windowFrame:'frame',panelTexture:'frame',mapTexture:'frame',characterMarker:'frame'}};
   const data=await writeSkinPack({id:theme.id,name:'图片链路验收素材',theme,files:[{id:'frame',path:'assets/frame.png',mime:'image/png',width:64,height:64,bytes}]});return AtlasPreview.importSkinFile(new File([data],'acceptance.zip',{type:'application/zip'}));
  });
  const images=await f.evaluate(()=>({metrics:__skinMetricsSnapshot(),frame:getComputedStyle(document.getElementById('appWindow')).borderImageSource,skin:AtlasPreview.getSkin()}));
  check('skins:real-image-install-deduplication',install.ok&&install.saved&&images.metrics.urls===1&&images.metrics.bitmaps===1&&images.frame.includes('blob:'),images);
  await p.screenshot({path:`${dir}/asset-theme-full.png`});
  await f.evaluate(()=>AtlasPreview.setUIProfile('mapOnly'));
  const hit=await f.evaluate(()=>{const character=AtlasPreview.data.CAST.find(c=>!['away','off','unknown'].includes(c.state));if(!character)return null;AtlasPreview.showEntity('character',character.id,true);AtlasPreview.map.state.cam={...AtlasPreview.map.state.tgt};AtlasPreview.map.setPaused(true);const state=AtlasPreview.map.state,m=state.marks.find(m=>m.type==='char'&&m.id===character.id);return m?{id:m.id,x:(m.x-state.cam.x)*state.cam.s+state.vw/2,y:(m.y-state.cam.y)*state.cam.s+state.vh/2}:null;});
  if(hit){await f.locator('#map').click({position:{x:hit.x,y:hit.y}});check('skins:image-marker-hit-anchor',await f.evaluate(id=>AtlasPreview.state.selected?.id===id&&!document.getElementById('mapSelection').hidden,hit.id));}else check('skins:image-marker-hit-anchor',false,'No visible fixture character');
  const exported=await f.evaluate(async()=>{const bytes=await AtlasPreview.exportSkinPack(),{readSkinPack}=await import('../atlas-skin-pack.mjs');const pack=await readSkinPack(bytes);return {id:pack.id,files:pack.files.length,roles:Object.keys(pack.theme.assets).length};});
  check('skins:portable-ZIP-export',exported.id==='user.browser-acceptance'&&exported.files===1&&exported.roles===4,exported);
  await p.reload();await p.waitForFunction(()=>!!document.querySelector('iframe')?.contentWindow?.AtlasPreview);f=p.frames().find(frame=>frame.url().includes('/atlas-reference/index.html'));await f.evaluate(()=>AtlasPreview.appearanceReady);
  check('skins:reload-restores-images',await f.evaluate(()=>AtlasPreview.getSkin().id==='user.browser-acceptance'&&__skinMetricsSnapshot().bitmaps===1));
  const removed=await f.evaluate(()=>AtlasPreview.removeSkin('user.browser-acceptance'));const released=await f.evaluate(()=>({skin:AtlasPreview.getSkin().id,metrics:__skinMetricsSnapshot()}));
  check('skins:remove-fallback-releases-resources',removed.ok&&released.skin==='builtin.starmap'&&released.metrics.urls===0&&released.metrics.bitmaps===0,released);
  await f.evaluate(()=>{AtlasHost.close();AtlasPreview.updateSnapshot(AtlasPreview.data);AtlasPreview.go(AtlasPreview.state.nodeId);});
  check('skins:closed-host-remains-paused',await f.evaluate(()=>AtlasPreview.map.state.paused&&__skinMetricsSnapshot().rafs===0));
  writeFileSync(`${dir}/skin-snapshot.json`,JSON.stringify(await f.evaluate(()=>AtlasPreview.data)));
 }finally{await p.close();}
}
