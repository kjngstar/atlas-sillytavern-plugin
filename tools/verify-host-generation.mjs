/** Real packaged extension + SQL + original UI, using SillyTavern's variadic event signatures. */
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
const dir=process.env.ATLAS_EVIDENCE_DIR||'.tmp/host-generation';mkdirSync(dir,{recursive:true});
const port=Number(process.env.ATLAS_VERIFY_PORT||4298),base=`http://127.0.0.1:${port}`;
const report={checks:{},errors:[],failed:[]};
function check(name,ok,detail){report.checks[name]={ok:!!ok,detail};if(!ok)report.failed.push(name);}
const server=spawn(process.execPath,['dev-preview/serve.mjs'],{env:{...process.env,ATLAS_PREVIEW_PORT:String(port),ATLAS_PREVIEW_NO_OPEN:'1'},stdio:'ignore'});
const browser=await chromium.launch({headless:true,executablePath:process.env.ATLAS_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
async function open({afterOnly=false,configure=true,rewriteContext=false,readDuringSave=false}={}){
 const p=await browser.newPage({viewport:{width:1600,height:1000}});p.on('pageerror',e=>report.errors.push(e.message));
 if(rewriteContext)await p.route('**/release/atlas-ui-extension/index.js',async route=>{const res=await route.fetch();const src=await res.text();const marker='getCommitContext: async (assistantText) => {';
  if(!src.includes(marker))throw Error('context hook boundary changed');
  await route.fulfill({response:res,body:src.replace(marker,marker+"if(!window.__contextRewritten){window.__contextRewritten=true;const c=context();c.chat.at(-1).mes+=' 宿主补写';c.chat.at(-2).mes+=' 宿主补写';}")});});
 await p.route('**/dev-preview/index.html',async route=>{const res=await route.fetch();let src=await res.text();
  src=src.replace('await sqlRuntime.closeSqlSession(migrated.session);','await sqlRuntime.closeSqlSession(migrated.session);contextValue.chatMetadata={};'+(afterOnly?'delete contextValue.event_types.MESSAGE_RECEIVED;':''))
   .replaceAll('../atlas-extension/','../release/atlas-ui-extension/');await route.fulfill({response:res,body:src});});
 await p.goto(`${base}/dev-preview/index.html`);await p.waitForFunction(()=>!!window.atlasPreviewConnection&&!!document.querySelector('iframe')?.contentWindow?.AtlasPreview);
 await p.evaluate(()=>atlasPreviewConnection.core.refresh());
 await p.evaluate(async ({configure,readDuringSave})=>{const c=SillyTavern.getContext();window.__calls=0;window.__saves=0;c.saveMetadata=async()=>{window.__saves++;
  if(readDuringSave)await atlasPreviewConnection.api.request('POST','/sql/chat/ui-read',{chatUid:c.chatId});};
  window.TavernHelper={generateRaw:async()=>{window.__calls++;if(window.__hold)await new Promise(resolve=>window.__release=resolve);
   return window.__calls===1?'{"op":"location.upsert","ref":"new:library","data":{"name":"图书馆","kind":"room"}}':'{"op":"noop"}';}};
  if(!configure)return;const api=atlasPreviewConnection.api;
  const r=await api.request('PUT','/settings',{action:'batch',commands:[{action:'api.save',create:true,preset:{id:'test-main',name:'测试连接',connectionMode:'main',endpoint:'',model:'',maxTokens:1024,temperature:0.7,topP:1,timeoutMs:30000},apiKeyMode:'clear'},{action:'api.activate',id:'test-main'}]});
  if(r.status!==200)throw Error(JSON.stringify(r));
 },{configure,readDuringSave});
 return {p,f:p.frames().find(f=>f.url().includes('/atlas-reference/index.html'))};
}
async function floor(p,{user='走进图书馆',assistant='你走进了图书馆。',type='normal',params={},dryRun=false,alias='all'}={}){
 await p.evaluate(async a=>{const c=SillyTavern.getContext(),e=c.event_types;
  await c.eventSource.emit(e.GENERATION_STARTED,a.type,a.params,a.dryRun);
  c.chat.push({mes:a.user,is_user:true});await c.eventSource.emit(e.MESSAGE_SENT,c.chat.length-1);
  await atlasPreviewConnection.core.waitPendingTurn();
  c.chat.push({mes:a.assistant,is_user:false});
  if(a.alias==='all'&&e.MESSAGE_RECEIVED)await c.eventSource.emit(e.MESSAGE_RECEIVED,c.chat.length-1,a.type);
  if(a.alias==='all'||a.alias==='ended')await c.eventSource.emit(e.GENERATION_ENDED,c.chat.length);
  if(a.alias==='all'||a.alias==='after')await c.eventSource.emit(e.GENERATION_ENDED_AFTER_COMMANDS,c.chat.length);
 },{user,assistant,type,params,dryRun,alias});
}
async function finish(p){await delay(550);await p.evaluate(()=>atlasPreviewConnection.core.handleEvent('FLUSH'));}
const state=p=>p.evaluate(()=>({calls:__calls,saves:__saves,receipts:atlasPreviewConnection.core.getState().receipts,error:atlasPreviewConnection.core.getState().lastError,phase:atlasPreviewConnection.core.getState().turnPhase,saved:!!SillyTavern.getContext().chatMetadata.atlas?.database}));
try{
 for(let i=0;i<40;i++){try{if((await fetch(`${base}/dev-preview/index.html`)).ok)break;}catch{}await delay(250);}
 const {p,f}=await open();
 await floor(p);await finish(p);let s=await state(p);
 check('normal-floor-real-model-and-save',s.calls===1&&s.saves===1&&s.saved&&s.receipts[0]?.status==='committed',s);
 await f.waitForFunction(()=>AtlasPreview.data.LOCATIONS.some(x=>x.name==='图书馆')&&AtlasPreview.data.RECEIPTS.length===1);
 check('normal-floor-renders-real-location-and-receipt',await f.evaluate(()=>AtlasPreview.data.LOCATIONS.some(x=>x.name==='图书馆')&&AtlasPreview.data.RECEIPTS[0].ok));
 await p.evaluate(async()=>{const c=SillyTavern.getContext();await c.eventSource.emit(c.event_types.GENERATION_ENDED,c.chat.length);await c.eventSource.emit(c.event_types.GENERATION_ENDED_AFTER_COMMANDS,c.chat.length);});await finish(p);s=await state(p);
 check('duplicate-completion-no-second-model-or-save',s.calls===1&&s.saves===1,s);
 await floor(p,{assistant:'你'.repeat(24001)});await finish(p);s=await state(p);check('long-assistant-not-silently-discarded',s.calls===2&&s.saves===2&&s.receipts.length===2&&!s.error,s);
 await floor(p,{user:'我'.repeat(12001),alias:'ended'});await finish(p);s=await state(p);check('long-user-and-raw-ended-alias',s.calls===3&&s.saves===3&&s.receipts.length===3&&!s.error,s);
 await f.locator('[data-tab="receipt"]').click();await f.waitForFunction(()=>AtlasPreview.data.RECEIPTS.length===3);await p.screenshot({path:`${dir}/automatic-receipts.png`});await p.close();
 for(const options of [{type:'quiet'},{dryRun:true},{params:{automatic_trigger:true}},{params:{quiet_prompt:'后台总结'}}]){
  const {p}=await open();await floor(p,options);await finish(p);s=await state(p);const name=options.type||Object.keys(options.params??options)[0];
  check(`gated:${name}`,s.calls===0&&s.saves===0&&s.receipts.length===0,s);
  await floor(p);await finish(p);s=await state(p);check(`gate-recovers:${name}`,s.calls===1&&s.saves===1,s);await p.close();
 }
 const only=await open({afterOnly:true});await floor(only.p,{alias:'after'});await finish(only.p);s=await state(only.p);check('after-commands-only-host',s.calls===1&&s.saves===1,s);await only.p.close();
 const first=await open();await first.p.evaluate(async()=>{const c=SillyTavern.getContext();c.chat.push({mes:'开场白',is_user:false});await c.eventSource.emit(c.event_types.MESSAGE_RECEIVED,0,'first_message');});await finish(first.p);s=await state(first.p);check('chat-opening-does-not-run-world',s.calls===0&&s.saves===0,s);await first.p.close();
 const nested=await open();await nested.p.evaluate(async()=>{const c=SillyTavern.getContext(),e=c.event_types;
  await c.eventSource.emit(e.GENERATION_STARTED,'normal',{},false);c.chat.push({mes:'进入图书馆',is_user:true});await c.eventSource.emit(e.MESSAGE_SENT,0);await atlasPreviewConnection.core.waitPendingTurn();
  await c.eventSource.emit(e.GENERATION_STARTED,'quiet',{quiet_prompt:'后台总结'},false);await c.eventSource.emit(e.GENERATION_ENDED,1);await c.eventSource.emit(e.GENERATION_ENDED_AFTER_COMMANDS,1);
  c.chat.push({mes:'你走进了图书馆。',is_user:false});await c.eventSource.emit(e.MESSAGE_RECEIVED,1,'normal');await c.eventSource.emit(e.GENERATION_ENDED,2);
 });await finish(nested.p);s=await state(nested.p);check('nested-quiet-completion-does-not-swallow-real-floor',s.calls===1&&s.saves===1&&s.receipts[0]?.status==='committed',s);await nested.p.close();
 for(const stop of [false,true]){
  const before=await open();await before.p.evaluate(async stop=>{const c=SillyTavern.getContext(),e=c.event_types;
   await c.eventSource.emit(e.GENERATION_STARTED,'normal',{},false);
   await c.eventSource.emit(e.GENERATION_STARTED,'quiet',{quiet_prompt:'内部预处理'},false);
   if(stop)await c.eventSource.emit(e.GENERATION_STOPPED);
   else {await c.eventSource.emit(e.GENERATION_ENDED,0);await c.eventSource.emit(e.GENERATION_ENDED_AFTER_COMMANDS,0);}
   c.chat.push({mes:'进入图书馆',is_user:true});await c.eventSource.emit(e.MESSAGE_SENT,0);await atlasPreviewConnection.core.waitPendingTurn();
   c.chat.push({mes:'你走进了图书馆。',is_user:false});await c.eventSource.emit(e.MESSAGE_RECEIVED,1,'normal');await c.eventSource.emit(e.GENERATION_ENDED,2);await c.eventSource.emit(e.GENERATION_ENDED_AFTER_COMMANDS,2);
  },stop);await finish(before.p);s=await state(before.p);
  check(`nested-pre-send-${stop?'stop':'completion'}-preserves-foreground`,s.calls===1&&s.saves===1&&s.receipts[0]?.status==='committed',s);await before.p.close();
 }
 const nestedStop=await open();await nestedStop.p.evaluate(async()=>{const c=SillyTavern.getContext(),e=c.event_types;
  await c.eventSource.emit(e.GENERATION_STARTED,'normal',{},false);c.chat.push({mes:'进入图书馆',is_user:true});await c.eventSource.emit(e.MESSAGE_SENT,0);await atlasPreviewConnection.core.waitPendingTurn();
  await c.eventSource.emit(e.GENERATION_STARTED,'quiet',{},false);await c.eventSource.emit(e.GENERATION_STOPPED);await c.eventSource.emit(e.GENERATION_ENDED,1);await c.eventSource.emit(e.GENERATION_ENDED_AFTER_COMMANDS,1);
  c.chat.push({mes:'你走进了图书馆。',is_user:false});await c.eventSource.emit(e.MESSAGE_RECEIVED,1,'normal');await c.eventSource.emit(e.GENERATION_ENDED,2);
 });await finish(nestedStop.p);s=await state(nestedStop.p);check('nested-stop-preserves-pending-turn',s.calls===1&&s.saves===1&&s.receipts[0]?.status==='committed',s);await nestedStop.p.close();
 const rewrite=await open({rewriteContext:true});await floor(rewrite.p);await finish(rewrite.p);s=await state(rewrite.p);
 check('context-postprocessing-rereads-current-user-and-assistant',s.calls===1&&s.saves===1&&s.receipts[0]?.status==='committed'&&!s.error,s);await rewrite.p.close();
 const saveRead=await open({readDuringSave:true});await floor(saveRead.p);await finish(saveRead.p);s=await state(saveRead.p);
 check('ui-read-during-save-preserves-candidate-until-confirmed',s.calls===1&&s.saves===1&&s.receipts[0]?.status==='committed'&&!s.error,s);await saveRead.p.close();
 for(const target of ['assistant','user']){
  const {p,f}=await open();await p.evaluate(()=>window.__hold=true);await floor(p,{user:'我'.repeat(12001),assistant:'你'.repeat(24001)});
  await p.waitForFunction(()=>typeof window.__release==='function');await f.waitForFunction(()=>AtlasPreview.data.meta.engine.phase==='committing');
  check(`progress-visible:${target}`,(await f.locator('#syncText').innerText()).includes('正在推演'));
  await p.evaluate(target=>{const c=SillyTavern.getContext();c.chat[target==='assistant'?c.chat.length-1:c.chat.length-2].mes+='修改超预算部分';window.__release();},target);
  await finish(p);s=await state(p);check(`late-suffix-edit-rejected:${target}`,s.calls===1&&s.saves===0&&!s.saved&&s.receipts[0]?.status==='failed'&&!!s.error,s);await p.close();
 }
 const failure=await open({configure:false});await floor(failure.p);await finish(failure.p);s=await state(failure.p);
 check('automatic-model-error-has-real-receipt',s.receipts[0]?.status==='failed'&&!!s.error&&!s.saved,s);await failure.f.waitForFunction(()=>AtlasPreview.data.RECEIPTS[0]?.status==='failed');check('automatic-error-reaches-original-ui',await failure.f.evaluate(()=>!!AtlasPreview.data.meta.engine.error));await failure.p.close();
 const retry=await open();await retry.p.evaluate(async()=>{const c=SillyTavern.getContext(),e=c.event_types;
  c.chat.push({mes:'进入图书馆',is_user:true},{mes:'之前没有提交的正文',is_user:false});
  await c.eventSource.emit(e.GENERATION_STARTED,'regenerate',{},false);
  c.chat.pop();await c.eventSource.emit('message_deleted',1);await atlasPreviewConnection.core.waitPendingTurn();
  c.chat.push({mes:'你走进了图书馆。',is_user:false});await c.eventSource.emit(e.MESSAGE_RECEIVED,1,'regenerate');await c.eventSource.emit(e.GENERATION_ENDED,2);
 });await finish(retry.p);s=await state(retry.p);check('regenerate-uncommitted-floor-without-message-sent',s.calls===1&&s.saves===1&&s.receipts[0]?.status==='committed',s);
 for(let i=0;i<2;i++){
  await retry.p.evaluate(async i=>{const c=SillyTavern.getContext(),e=c.event_types;
   await c.eventSource.emit(e.GENERATION_STARTED,'regenerate',{},false);c.chat.pop();await c.eventSource.emit(e.MESSAGE_DELETED,1);
   c.chat.push({mes:'重新生成的图书馆正文'+i,is_user:false});await c.eventSource.emit(e.MESSAGE_RECEIVED,1,'regenerate');await c.eventSource.emit(e.GENERATION_ENDED,2);
  },i);await finish(retry.p);s=await state(retry.p);check(`regenerate-committed-floor-rollback-before-prepare:${i}`,s.calls===i+2&&s.receipts[0]?.status==='committed'&&!s.error,s);
 }await retry.p.close();
}catch(error){report.errors.push(error.stack);process.exitCode=1;}finally{
 await browser.close();server.kill();writeFileSync(`${dir}/evidence.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(report.failed.length||report.errors.length)process.exitCode=1;
}
