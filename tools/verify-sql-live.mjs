/** Read-only interaction acceptance on the existing 8000 Tavern. No model call or message mutation. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
const option=(key,fallback)=>{const i=process.argv.indexOf(key);return i<0?fallback:process.argv[i+1];};
const character=option('--character'),chat=option('--chat'),origin=option('--origin','http://127.0.0.1:8000');
if(!character?.startsWith('Atlas 自动化验收')||!chat)throw Error('Specify --character and --chat for an existing Atlas 自动化验收 dedicated chat.');
const output=option('--output','.tmp/sql-live-interactions.json');
const browser=await chromium.launch({headless:true,executablePath:option('--chrome','C:/Program Files/Google/Chrome/Application/chrome.exe')});
const page=await browser.newPage({viewport:{width:1280,height:820}});page.setDefaultTimeout(15000);
const report={origin,modelRequests:0,pageErrors:[],checks:[]};
page.on('pageerror',error=>report.pageErrors.push(error.message.slice(0,200)));
page.on('request',request=>{if(new URL(request.url()).pathname==='/api/backends/chat-completions/generate')report.modelRequests++;});
const mapState=()=>page.evaluate(()=>({transform:document.querySelector('.aw-stage')?.style.transform,zoom:document.querySelector('.aw-zoom__label')?.textContent,scale:document.querySelector('.aw-scale')?.textContent,grid:document.querySelector('.aw-grid-svg__minor')?.getAttribute('d')}));
try{
 await page.goto(origin,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>SillyTavern?.getContext?.()?.characters?.length>0);
 const initial=await page.evaluate(async({character,chat})=>{
  const st=await import('/script.js'),index=SillyTavern.getContext().characters.findIndex(row=>row.name===character);if(index<0)throw Error('Dedicated test character missing');
  await st.selectCharacterById(index);await st.openCharacterChat(chat);
  const ext=await import('/scripts/extensions/third-party/atlas-sillytavern-plugin/index.js'),mounted=await ext.connectAtlas(),ctx=SillyTavern.getContext();
  const bucket=ctx.extensionSettings.atlas_world_sim;window.atlasLive={ext,mounted,chatId:ctx.chatId,oldSql:bucket.sqlMode,hadSql:Object.hasOwn(bucket,'sqlMode'),messages:JSON.stringify(ctx.chat),legacy:JSON.stringify(Object.fromEntries(['world','tables','maps','scene','simulation','binding','turns'].map(key=>[key,ctx.chatMetadata.atlas?.[key]]))),hash:ctx.chatMetadata.atlas?.database?.sha256};
  bucket.sqlMode=true;await mounted.core.refresh();if(mounted.core.getState().lastError)throw Error(mounted.core.getState().lastError);
  mounted.core.setPanelOpen(true);mounted.core.setPage('map');mounted.rerender();
  return {chain:mounted.core.getState().stateData.tableMap.current.chain.map(row=>row.id.replace(/^loc:/,'')),messages:ctx.chat.length,revision:ctx.chatMetadata.atlas.database.storage_revision};
 },{character,chat});report.checks.push({name:'native-snapshot',...initial});assert.ok(initial.chain.length>=4);
 const tutorial=page.locator('.acu-tutorial-overlay button[title="关闭教程"]');if(await tutorial.isVisible())await tutorial.click();
 await page.locator('.aw-zoom__label').waitFor({state:'visible'});
 const start=await mapState();await page.getByRole('button',{name:'放大地图',exact:true}).click();const zoomed=await mapState();assert.notEqual(zoomed.zoom,start.zoom);assert.notEqual(zoomed.scale,start.scale);assert.notEqual(zoomed.grid,start.grid);
 const parents=[];
 for(const id of [...initial.chain].reverse()){
  parents.push(await mapState());await page.locator(`.aw-point[data-point-id="${id}"]`).click();
  await page.locator('.aw-mappanel button').filter({hasText:'进入内部地图'}).click();
 }
 const room=await page.evaluate(()=>({characters:document.querySelectorAll('.aw-object--npc').length,boundaries:document.querySelectorAll('.aw-room-boundary').length,rosterVisible:[...document.querySelectorAll('.aw-interior-roster')].some(node=>getComputedStyle(node).display!=='none')}));
 assert.ok(room.characters>0);assert.ok(room.boundaries>0);assert.equal(room.rosterVisible,false);report.checks.push({name:'four-level-room',...room});
 await page.locator('.aw-object--npc').first().click();await page.locator('.aw-mappanel').waitFor({state:'visible'});
 const popup=await page.evaluate(()=>{const p=document.querySelector('.aw-mappanel').getBoundingClientRect(),v=document.querySelector('.aw-viewport').getBoundingClientRect();return {inside:p.left>=v.left-1&&p.right<=v.right+1&&p.top>=v.top-1&&p.bottom<=v.bottom+1};});assert.equal(popup.inside,true);
 await page.getByRole('button',{name:'关闭人物信息',exact:true}).click();
 const beforePan=await mapState(),box=await page.locator('.aw-viewport').boundingBox();
 await page.mouse.move(box.x+box.width*0.25,box.y+box.height*0.75);await page.mouse.down();await page.mouse.move(box.x+box.width*0.25+60,box.y+box.height*0.75+20,{steps:6});await page.mouse.up();
 assert.notEqual((await mapState()).transform,beforePan.transform);
 await page.setViewportSize({width:540,height:820});await page.waitForTimeout(250);
 await page.locator('.aw-object--npc').first().click();await page.locator('.aw-mappanel').waitFor({state:'visible'});
 await page.screenshot({path:output.replace(/\.json$/,'.png')});
 const narrow=await page.evaluate(()=>{const p=document.querySelector('.aw-mappanel').getBoundingClientRect(),v=document.querySelector('.aw-viewport').getBoundingClientRect();return {width:v.width,inside:p.left>=v.left-1&&p.right<=v.right+1};});assert.equal(narrow.inside,true);report.checks.push({name:'narrow-popup',...narrow});
 await page.setViewportSize({width:1280,height:820});await page.waitForTimeout(250);
 await page.getByRole('button',{name:'返回上一层地图',exact:true}).click();assert.equal((await mapState()).transform,parents.at(-1).transform);
 report.checks.push({name:'pan-zoom-grid-scale-and-parent-camera',passed:true});
 const lifecycle=await page.evaluate(async()=>{
  const live=window.atlasLive;await live.ext.disconnectAtlas();live.mounted=await live.ext.connectAtlas();const ctx=SillyTavern.getContext();
  await live.mounted.core.refresh();live.mounted.core.setPanelOpen(true);live.mounted.core.setPage('map');live.mounted.rerender();
  return {messagesUnchanged:JSON.stringify(ctx.chat)===live.messages,legacyUnchanged:JSON.stringify(Object.fromEntries(['world','tables','maps','scene','simulation','binding','turns'].map(key=>[key,ctx.chatMetadata.atlas?.[key]])))===live.legacy,snapshotUnchanged:ctx.chatMetadata.atlas.database.sha256===live.hash,error:live.mounted.core.getState().lastError,roots:document.querySelectorAll('#atlas-extension-panel-root').length};
 });assert.equal(lifecycle.messagesUnchanged,true);assert.equal(lifecycle.legacyUnchanged,true);assert.equal(lifecycle.snapshotUnchanged,true);assert.equal(lifecycle.error,null);assert.equal(lifecycle.roots,1);report.checks.push({name:'reconnect-and-preservation',...lifecycle});
 assert.equal(report.modelRequests,0);assert.deepEqual(report.pageErrors,[]);report.passed=true;
}finally{
 await page.evaluate(()=>{const live=window.atlasLive;if(!live)return;const ctx=SillyTavern.getContext();if(ctx.chatId!==live.chatId)return;const bucket=ctx.extensionSettings.atlas_world_sim;if(live.hadSql)bucket.sqlMode=live.oldSql;else delete bucket.sqlMode;}).catch(()=>{});
 mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));await browser.close();
}
