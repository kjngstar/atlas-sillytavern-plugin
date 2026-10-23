/** Real pointer/keyboard, persistence and geometry checks on the shipped UI. */
export async function verifyMapWidgets({open,check,dir}){
 const {p,f:initial}=await open({persist:true,instrument:true});let f=initial;
 await f.evaluate(()=>AtlasPreview.appearanceReady);
 const database=()=>p.evaluate(()=>JSON.stringify(SillyTavern.getContext().chatMetadata.atlas.database));
 const beforeDB=await database();
 check('widgets:default-clean-map',await f.locator('#mapHudWidgets').isHidden()&&await f.locator('#mapWidgetsToggle').isVisible());
 await p.screenshot({path:`${dir}/map-tools-collapsed.png`});
 await f.locator('#mapWidgetsToggle').focus();await f.locator('#mapWidgetsToggle').press('Enter');
 check('widgets:keyboard-opens',await f.locator('#mapHudWidgets').isVisible()&&await f.locator('#mapWidgetsToggle').getAttribute('aria-expanded')==='true');
 await f.locator('#mapModeSwitcher').selectOption('heat');
 await f.locator('#legendToggle').click();
 await f.evaluate(()=>{window.__widgetCanvas=document.getElementById('map');const m=AtlasPreview.map,s=m.state;s.cam={x:71,y:-93,s:m.fitScale()*1.6};s.tgt={...s.cam};m.setPaused(true);});
 const sample=()=>f.evaluate(()=>{const s=AtlasPreview.map.state,r=document.getElementById('map').getBoundingClientRect();return JSON.stringify({cam:s.cam,tgt:s.tgt,node:AtlasPreview.state.nodeId,selected:AtlasPreview.state.selected,mode:s.mode,box:[r.x,r.y,r.width,r.height]});});
 const before=await sample();
 await f.locator('#mapWidgetsToggle').press('Space');
 check('widgets:collapse-keeps-camera-and-canvas',await sample()===before&&await f.evaluate(()=>document.getElementById('map')===__widgetCanvas));
 const focus=await f.evaluate(()=>{document.getElementById('mapWidgetsToggle').focus();document.getElementById('mapModeSwitcher').focus();return {id:document.activeElement.id,visibleControls:[...document.querySelectorAll('#mapHudWidgets button,#mapHudWidgets select')].filter(el=>el.getClientRects().length).length};});
 check('widgets:hidden-controls-not-focusable',focus.id==='mapWidgetsToggle'&&focus.visibleControls===0,focus);
 await f.locator('#mapWidgetsToggle').click();
 check('widgets:restore-preserves-mode-and-legend',await f.locator('#mapModeSwitcher').inputValue()==='heat'&&await f.locator('#legendToggle').getAttribute('aria-expanded')==='false');
 await p.screenshot({path:`${dir}/map-tools-expanded.png`});
 // Check actual hit targets across skin/profile/small viewport combinations.
 const viewports=[
  ...[360,540,720,1280,1440].map(width=>({width,height:1000})),
  ...[1009,1100,1280,1440].map(width=>({width,height:720})),
 ];
 for(const {width,height} of viewports){
  await p.setViewportSize({width,height});
  for(const skin of ['builtin.starmap','builtin.parchment'])for(const profile of ['full','mapFocus','mapOnly']){
   await f.evaluate(async({skin,profile})=>{await AtlasPreview.setTheme(skin);await AtlasPreview.setUIProfile(profile);},{skin,profile});
   const geometry=await f.evaluate(()=>{const toggle=document.getElementById('mapWidgetsToggle'),box=toggle.getBoundingClientRect(),viewport=document.getElementById('viewport').getBoundingClientRect();return {hit:document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)?.closest('button')===toggle,inside:box.x>=viewport.x&&box.right<=viewport.right,overflow:document.documentElement.scrollWidth>innerWidth};});
   check(`widgets:restore-accessible:${width}x${height}:${skin}:${profile}`,geometry.hit&&geometry.inside&&!geometry.overflow,geometry);
   // A one-frame center sample races HUD/profile transitions. Trial clicks
   // verify each real target is visible, stable and unobstructed without zooming.
   const hits=[];
   for(const selector of ['#mapModeSwitcher','#zIn','#zOut','#zFit','#zGrid','[data-export="map"]']){
    const target=f.locator(selector);if(selector==='#mapModeSwitcher'&&profile==='mapOnly')continue;
    const box=await target.boundingBox();
    await target.click({trial:true,position:{x:box.width/2,y:box.height/2}});hits.push(selector);
   }
   check(`widgets:expanded-hit-targets:${width}x${height}:${skin}:${profile}`,true,hits);
   if(height===720&&profile==='full'){
    const clear=await f.evaluate(()=>{
     const mini=document.querySelector('.hud-mini'),a=mini.getBoundingClientRect();
     return !mini.getClientRects().length||['.hud-nav','.hud-readout'].every(selector=>{const b=document.querySelector(selector).getBoundingClientRect();return a.right<=b.left||a.left>=b.right||a.bottom<=b.top||a.top>=b.bottom;});
    });
    check(`widgets:short-map-no-hud-overlap:${width}:${skin}`,clear);
    const grid=f.locator('#zGrid'),wasOn=await grid.evaluate(el=>el.classList.contains('on'));
    await grid.click({position:{x:17,y:17}});
    check(`widgets:short-map-grid-click:${width}:${skin}`,await grid.evaluate(el=>el.classList.contains('on'))!==wasOn);
    await grid.click({position:{x:17,y:17}});
    await f.locator('[data-export="map"]').click({position:{x:17,y:17}});
    await f.locator('#demoModal').waitFor({state:'visible'});
    check(`widgets:short-map-export-click:${width}:${skin}`,(await f.locator('#modalBody').innerText()).includes('下载地图 JSON'));
    await f.locator('#modalClose').click();
    await p.screenshot({path:`${dir}/map-tools-short-${width}-${skin.split('.').pop()}.png`});
   }
   await f.locator('#mapWidgetsToggle').click();check(`widgets:hide:${width}x${height}:${skin}:${profile}`,await f.locator('#mapHudWidgets').isHidden());
   await f.locator('#mapWidgetsToggle').click();
   if(width===360&&profile==='full'&&skin==='builtin.parchment')await p.screenshot({path:`${dir}/map-tools-mobile.png`});
  }
 }
 await f.evaluate(()=>AtlasPreview.setUIProfile('full'));
 await f.locator('#mapModeSwitcher').selectOption('map');
 // Collapsing while focus is in the region returns focus to its disclosure.
 const restored=await f.evaluate(()=>{document.getElementById('zIn').focus();document.getElementById('mapWidgetsToggle').click();return document.activeElement.id;});
 check('widgets:focus-returns-before-hide',restored==='mapWidgetsToggle');
 check('widgets:no-world-writes',await database()===beforeDB);
 const metrics=await f.evaluate(()=>{const before=__skinMetricsSnapshot();for(let i=0;i<100;i++)document.getElementById('mapWidgetsToggle').click();return {before,after:__skinMetricsSnapshot()};});
 check('widgets:100-toggles-no-resource-growth',['listeners','observers','canvases','urls','bitmaps'].every(key=>metrics.before[key]===metrics.after[key]),metrics);
 await p.reload();await p.waitForFunction(()=>!!document.querySelector('iframe')?.contentWindow?.AtlasPreview);f=p.frames().find(frame=>frame.url().includes('/atlas-reference/index.html'));
 check('widgets:reload-remembers-collapsed',await f.locator('#mapHudWidgets').isHidden());
 await f.locator('#mapWidgetsToggle').click();
 await p.reload();await p.waitForFunction(()=>!!document.querySelector('iframe')?.contentWindow?.AtlasPreview);f=p.frames().find(frame=>frame.url().includes('/atlas-reference/index.html'));
 check('widgets:reload-remembers-expanded',await f.locator('#mapHudWidgets').isVisible());
 await f.evaluate(()=>AtlasPreview.page('prefs'));
 check('widgets:workspace-hides-overlay',await f.locator('#mapWidgetsToggle').isHidden()&&await f.locator('#mapHudWidgets').isHidden());
 await p.close();
}
