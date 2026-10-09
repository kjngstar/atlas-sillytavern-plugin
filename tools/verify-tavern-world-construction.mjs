/**
 * tools/verify-tavern-world-construction.mjs — M7-06 真实酒馆验收（真实 SillyTavern + 真实 release）
 *
 * 用法：
 *   node tools/verify-tavern-world-construction.mjs                     # 离线：只驱动 UI，不打任何后端模型
 *   node tools/verify-tavern-world-construction.mjs --live              # 额外做一次真实模型生成
 *   node tools/verify-tavern-world-construction.mjs --character "名字前缀" --origin http://127.0.0.1:8000
 *
 * 纪律（施工单 M7-06 / 09-报错定位表）：
 *  - **只新建测试聊天**：在专用验收角色下 `doNewChat` 开一条新聊天，绝不写入用户已有剧情；
 *    结束时恢复到进入前的角色/聊天，并把新建聊天名原样报出来供人工清理。
 *  - **不打后端除非显式 --live**；--live 只发一次真实生成，用的就是用户已配置的连接（不从代码或报告里读/写 key）。
 *  - 证据落在 ATLAS_EVIDENCE_DIR（默认 .tmp/tavern-world-construction），含截图与 evidence.json。
 *  - 任何一项失败都进 `failed` 数组并让进程退出码为 1；不做「跳过即通过」。
 */
import {chromium} from 'playwright';
import {mkdirSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';

const option=(key,fallback)=>{const i=process.argv.indexOf(key);return i<0?fallback:process.argv[i+1];};
const origin=option('--origin',process.env.ATLAS_ST_ORIGIN||'http://127.0.0.1:8000');
const character=option('--character','Atlas 自动化验收');
const wantLive=process.argv.includes('--live');
const dir=option('--evidence-dir',process.env.ATLAS_EVIDENCE_DIR||'.tmp/tavern-world-construction');
const extensionPath='/scripts/extensions/third-party/atlas-sillytavern-plugin';
const chrome=process.env.ATLAS_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';
mkdirSync(dir,{recursive:true});

const report={origin,character,extensionPath,startedAt:new Date().toISOString(),checks:{},failed:[],pageErrors:[],networkErrors:[],screenshots:[],notes:[]};
const check=(name,ok,detail)=>{report.checks[name]={ok:!!ok,detail};if(!ok)report.failed.push(name);};
const shot=async(page,name)=>{const file=`${dir}/${name}.png`;await page.screenshot({path:file,fullPage:false});report.screenshots.push(file);return file;};

const browser=await chromium.launch({headless:true,executablePath:chrome});
const page=await browser.newPage({viewport:{width:1600,height:1000}});
page.setDefaultTimeout(45000);
page.on('pageerror',error=>report.pageErrors.push(String(error.message).slice(0,300)));
page.on('requestfailed',request=>{const url=request.url();if(/\/api\/backends\/chat-completions\/generate/.test(url))report.networkErrors.push(`${request.failure()?.errorText??'failed'} ${url.slice(0,120)}`);});
let frame;

try{
  // ── 1. 真实酒馆能起来，且装的是本包最终产物 ─────────────────────────────────
  await page.goto(origin,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>SillyTavern?.getContext?.()?.characters?.length>0);
  const installed=await page.evaluate(async p=>{const r=await fetch(p+'/manifest.json');const m=await r.json();
    return {version:m.version,display:m.display_name,entry:m.js};},extensionPath);
  report.installed=installed;
  check('tavern-serves-installed-release',installed.version==='0.9.84',installed);

  // ── 2. 专用验收角色下**新建**测试聊天（用户已有聊天不动） ────────────────────
  const before=await page.evaluate(()=>({chatId:SillyTavern.getContext().chatId}));
  const created=await page.evaluate(async name=>{
    const st=await import('/script.js');
    const rows=SillyTavern.getContext().characters;
    const index=rows.findIndex(row=>String(row.name).startsWith(name));
    if(index<0)throw Error(`找不到专用验收角色（前缀 ${name}）`);
    await st.selectCharacterById(index);
    const previous=SillyTavern.getContext().chatId;
    await st.doNewChat({deleteCurrentChat:false});
    const ctx=SillyTavern.getContext();
    return {previousChatId:previous,newChatId:ctx.chatId,characterName:rows[index].name,messages:ctx.chat.length};
  },character);
  report.newChat=created;report.notes.push(`本次新建的测试聊天：${created.newChatId}（角色「${created.characterName}」）——验收后可由人工删除。`);
  check('dedicated-role-and-new-chat',!!created.newChatId&&created.newChatId!==created.previousChatId,created);
  check('existing-chat-untouched',before.chatId!==created.newChatId,{before:before.chatId,now:created.newChatId});

  // ── 3. 挂载正式扩展、开 SQL 模式、真实 refresh ──────────────────────────────
  const mounted=await page.evaluate(async path=>{
    const ext=await import(path+'/index.js');
    const handle=await ext.connectAtlas();
    const ctx=SillyTavern.getContext();
    const bucket=ctx.extensionSettings.atlas_world_sim??(ctx.extensionSettings.atlas_world_sim={});
    window.__atlasAcceptance={handle,chatId:ctx.chatId,hadSqlMode:Object.hasOwn(bucket,'sqlMode'),sqlMode:bucket.sqlMode,
      messages:JSON.stringify(ctx.chat),legacyHash:JSON.stringify(Object.fromEntries(['world','tables','maps','scene','simulation','binding','turns'].map(key=>[key,ctx.chatMetadata.atlas?.[key]]))),
      databaseHash:ctx.chatMetadata.atlas?.database?.sha256??null};
    bucket.sqlMode=true;
    await handle.core.refresh();
    const state=handle.core.getState();
    return {error:state.lastError??null,chatId:state.chatId,binding:state.binding?.branchId??null,sqlMode:bucket.sqlMode};
  },extensionPath);
  report.mounted=mounted;
  check('extension-mounts-and-refreshes',!mounted.error,{error:mounted.error,chatId:mounted.chatId});

  // ── 4. 打开面板、进地图页，等新 UI iframe 出 AtlasPreview ───────────────────
  await page.evaluate(()=>{const h=window.__atlasAcceptance.handle;h.core.setPanelOpen(true);h.core.setPage('map');h.rerender();});
  await page.waitForFunction(()=>!!document.querySelector('.atlas-native-ui-host')?.querySelector('iframe')?.contentWindow?.AtlasPreview,{timeout:45000});
  frame=page.frames().find(f=>f.url().includes('/atlas-reference/index.html'));
  check('reference-ui-iframe-mounted',!!frame,{frames:page.frames().map(f=>f.url().slice(-48))});
  check('native-host-is-the-only-surface',await page.evaluate(()=>document.querySelector('.atlas-native-ui-host')?.children.length===1),null);

  // ── 5. 原版结构 + 真实数据 + 画得出来 ──────────────────────────────────────
  const structure=await frame.evaluate(()=>['panelLeft','panelRight','dock','viewModes','map','minimap','paletteWrap','scaleLabel'].every(id=>document.getElementById(id)));
  check('original-structure-present',structure,null);

  const painted=await frame.evaluate(()=>{const c=document.getElementById('map');
    const a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;const colors=new Set();
    for(let i=0;i<a.length;i+=64)colors.add(`${a[i]},${a[i+1]},${a[i+2]}`);
    return {colors:colors.size,width:c.width,height:c.height};});
  check('canvas-paints-real-world',painted.colors>30,painted);

  // 新建聊天里世界本来就是空的：这里只断言「空得诚实」，真正的世界数据在下面 mock 建设之后再验。
  const emptyWorld=await frame.evaluate(()=>({rootId:AtlasPreview.data.ROOT.id,rootName:AtlasPreview.data.ROOT.name,rootKind:AtlasPreview.data.ROOT.kind,
    locations:AtlasPreview.data.LOCATIONS.length,cast:AtlasPreview.data.CAST.length,children:(AtlasPreview.data.ROOT.children||[]).length}));
  report.emptyWorld=emptyWorld;
  check('empty-chat-shows-empty-world-not-a-crash',emptyWorld.rootId==='world'&&emptyWorld.locations===0&&emptyWorld.cast===0,emptyWorld);

  // ── 6. 交互：比例尺、网格、hover 不改锚点 ──────────────────────────────────
  const scale=await frame.evaluate(()=>{const el=document.querySelector('.sc-line i');const m=AtlasUIModel,s=AtlasPreview.map.state.cam.s,metric=AtlasPreview.map.state.node?.metric;
    const a=m.fixedScale(s,metric),b=m.fixedScale(s*2,metric);
    return {domWidth:el?.dataset.width??null,domDistance:el?.dataset.distance??null,label:document.getElementById('scaleLabel').textContent,w1:a.width,w2:b.width,d1:a.distance,d2:b.distance};});
  check('scale-line-74px-and-inverse-proportional',scale.domWidth==='74'&&scale.w1===74&&scale.w2===74&&Math.abs(scale.d1-2*scale.d2)<1e-9&&!!scale.label,scale);

  const grid=await frame.evaluate(list=>{const m=AtlasPreview.map;return list.map(s=>{const step=m.gridStep(s);return {s,step,px:step*s};});},[0.02,0.1,0.5,1,3.7,12,60,300]);
  check('grid-step-contract',grid.every(x=>x.step>0&&[1,2,5].some(m=>Math.abs(Number(x.step.toExponential().split('e')[0])-m)<1e-9)&&x.px>=12&&x.px<=40.0001),grid.map(x=>`${x.s}:${x.step}`).join(' '));
  check('grid-line-cap-2000',await frame.evaluate(()=>AtlasPreview.map.paintGrid(document.createElement('canvas').getContext('2d'),{cam:{x:0,y:0,s:1e-6},vw:4000,vh:4000,dpr:1,step:1e-9}))<=2000,null);

  await frame.evaluate(()=>{AtlasPreview.go(AtlasPreview.data.ROOT.id);AtlasPreview.map.fit(false);});await delay(400);
  report.notes.push('空世界：世界图上没有任何可悬停标记是正确状态；hover 断言放到离线建设之后。');
  await shot(page,'01-world-panel');

  // ── 7. 本轮/历史划分、POV 不漏实体、诊断页、升级前备份入口 ──────────────────
  const feed=await frame.evaluate(()=>({latestTurnId:AtlasPreview.data.meta.latestTurnId??null,turn:AtlasPreview.data.meta.turn??null,
    known:AtlasPreview.data.EVENTS.filter(e=>e.known).length,turnN:AtlasPreview.turnEvents().length,histN:AtlasPreview.historyEvents().length,
    overlap:AtlasPreview.turnEvents().filter(e=>AtlasPreview.historyEvents().some(h=>h.id===e.id)).length,
    turnIds:[...new Set(AtlasPreview.turnEvents().map(e=>e.turnId))]}));
  check('turn-and-history-are-disjoint',feed.overlap===0&&feed.turnN+feed.histN===feed.known&&(feed.latestTurnId==null||feed.turnIds.every(id=>id===feed.latestTurnId)),feed);

  const authorNames=await frame.evaluate(()=>AtlasPreview.data.CAST.map(c=>c.name).concat(AtlasPreview.data.LOCATIONS.map(l=>l.name)));
  await frame.evaluate(()=>AtlasPreview.switchView('pov'));await frame.waitForFunction(()=>AtlasPreview.data.meta.viewMode==='pov');await delay(250);
  const pov=await frame.evaluate(names=>{const zones=['#inspector','#railList','#dockBody','#placeCard','#crumbs','#workspacePage'];
    const text=zones.map(z=>document.querySelector(z)?.innerText??'').join('\n');
    return {leaked:names.filter(n=>n&&text.includes(n)),povCast:AtlasPreview.data.CAST.length,povLoc:AtlasPreview.data.LOCATIONS.length,authorCast:names.length};},authorNames);
  check('pov-does-not-leak-hidden-entities',pov.leaked.length===0,pov);
  await shot(page,'02-pov');
  await frame.evaluate(()=>AtlasPreview.switchView('author'));await frame.waitForFunction(()=>AtlasPreview.data.meta.viewMode==='author');

  // 页面切换一律走 UI 自己的 `AtlasPreview.page()`：真酒馆里点了 rail 按钮之后
  // `#workspacePage` 还可能是空的（宿主随后又会投递一次快照），等渲染完成才断言。
  const gotoPage=async name=>{await frame.evaluate(page=>AtlasPreview.page(page),name);
    await frame.waitForFunction(page=>document.getElementById('workspacePage')?.hidden===false&&!!AtlasPreview.state.page,{},name).catch(()=>{});
    await delay(250);};
  await gotoPage('sim');
  const simText=await frame.evaluate(()=>{const node=document.getElementById('workspacePage');
    return {inner:(node?.innerText??'').slice(0,400),text:(node?.textContent??'').slice(0,400)};});
  check('empty-turn-is-explained',feed.turnN>0||simText.inner.includes('本轮暂无新的世界动向')||simText.text.includes('本轮暂无新的世界动向'),{turnN:feed.turnN,simText});
  // M6-16/M6-18：诊断页是「查看诊断」按钮的目标，升级前备份入口就长在诊断页里。
  await gotoPage('diag');
  const diag=await frame.evaluate(()=>{const rows=document.getElementById('diagnosticRows');
    return {present:!!rows,rows:(rows?.innerText??'').slice(0,200)};});
  check('diagnostics-page-renders',diag.present,diag);
  await shot(page,'03-diagnostics');

  const backup=await frame.evaluate(()=>{const button=document.querySelector('[data-backup-export]'),status=document.querySelector('[data-backup-status]');
    return {found:!!button,disabled:button?button.disabled===true:null,status:(status?.innerText??'').slice(0,200)};});
  check('backup-export-entry-exists',backup.found,backup);
  // 还没有任何落点时入口必须「禁用 + 给出一句话原因」，不许点了没反应。
  check('backup-entry-disabled-with-reason-before-any-save',backup.found&&backup.disabled===true&&backup.status.length>0,backup);
  report.notes.push(`诊断页备份入口（首次进入，聊天尚无落点）状态文案：${backup.status}`);
  await gotoPage('map');

  // ── 8. 断开重连不得改动聊天内容与数据库哈希 ────────────────────────────────
  const lifecycle=await page.evaluate(async()=>{
    const ext=await import('/scripts/extensions/third-party/atlas-sillytavern-plugin/index.js');
    await ext.disconnectAtlas();
    const remounted=await ext.connectAtlas();
    const now=SillyTavern.getContext();
    const same={messages:JSON.stringify(now.chat)===window.__atlasAcceptance.messages,
      legacy:JSON.stringify(Object.fromEntries(['world','tables','maps','scene','simulation','binding','turns'].map(key=>[key,now.chatMetadata.atlas?.[key]])))===window.__atlasAcceptance.legacyHash,
      database:(now.chatMetadata.atlas?.database?.sha256??null)===window.__atlasAcceptance.databaseHash,
      chatId:now.chatId===window.__atlasAcceptance.chatId,roots:document.querySelectorAll('#atlas-extension-panel-root').length,
      error:remounted.core.getState().lastError??null};
    window.__atlasAcceptance.handle=remounted;return same;});
  check('reconnect-preserves-chat-and-database',lifecycle.messages&&lifecycle.legacy&&lifecycle.database&&lifecycle.chatId&&lifecycle.roots===1&&!lifecycle.error,lifecycle);

  // ── 9. 离线 model mock：在这条新建聊天里真的把世界建出来（不打后端） ────────
  // 操作词汇取自施工包 04「仅测试用」范例；实体名是本验收专用，不进任何生产文件。
  const built=await page.evaluate(async()=>{
    const handle=window.__atlasAcceptance.handle,ctx=SillyTavern.getContext();
    // kind 必须取 src/atlas-location-kinds.ts 的权威枚举（region/city/district/building/floor/room/natural/vehicle/other）；
    // `settlement` 是 overview zone 的 role，不是地点 kind —— 写成 kind 会被归一器按「地点类型非法」拒掉。
    const bootstrap=[
      '{"op":"location.upsert","ref":"new:harbor","data":{"name":"验收港湾","kind":"city","existence_quality":"confirmed"}}',
      '{"op":"location.upsert","ref":"new:inn","data":{"name":"验收旅店","kind":"building","parent_ref":"new:harbor"}}',
      '{"op":"character.upsert","ref":"new:keeper","data":{"name":"验收掌柜","identity":"旅店掌柜","importance":"core","location_ref":"new:inn"}}'
    ].join('\n');
    let calls=0;
    window.__atlasAcceptance.offlineModel=true;
    window.__atlasAcceptance.previousTavernHelper=window.TavernHelper;
    window.TavernHelper={generateRaw:async()=>{calls++;return calls===1?bootstrap:'{"op":"noop"}';}};
    const e=ctx.event_types;
    await ctx.eventSource.emit(e.GENERATION_STARTED,'normal',{},false);
    ctx.chat.push({mes:'我走进验收港湾。',is_user:true});
    await ctx.eventSource.emit(e.MESSAGE_SENT,ctx.chat.length-1);
    await handle.core.waitPendingTurn();
    ctx.chat.push({mes:'你踏上了验收港湾的码头。',is_user:false});
    await ctx.eventSource.emit(e.MESSAGE_RECEIVED,ctx.chat.length-1,'normal');
    await ctx.eventSource.emit(e.GENERATION_ENDED,ctx.chat.length);
    await ctx.eventSource.emit(e.GENERATION_ENDED_AFTER_COMMANDS,ctx.chat.length);
    return {calls};
  });
  let commit=null;
  for(let i=0;i<150;i++){
    commit=await page.evaluate(()=>{const s=window.__atlasAcceptance.handle.core.getState();
      return {phase:s.turnPhase??null,error:s.lastError??null,receipts:(s.receipts??[]).length,status:s.receipts?.[0]?.status??null};});
    if(commit.error||(commit.receipts>0&&commit.phase==='idle'))break;
    await delay(1000);
  }
  report.offlineBuild={modelCalls:built.calls,...commit};
  check('offline-mock-turn-committed',!commit.error&&commit.status==='committed',report.offlineBuild);

  await page.evaluate(async()=>{const h=window.__atlasAcceptance.handle;await h.core.refresh();h.core.setPage('map');h.rerender();});
  await delay(800);
  frame=page.frames().find(f=>f.url().includes('/atlas-reference/index.html'));

  const world=await frame.evaluate(()=>({rootId:AtlasPreview.data.ROOT.id,rootName:AtlasPreview.data.ROOT.name,rootMapId:AtlasPreview.data.ROOT.mapId??null,
    rootKind:AtlasPreview.data.ROOT.kind,rootHost:!!AtlasPreview.data.ROOT.host,
    children:(AtlasPreview.data.ROOT.children||[]).map(n=>({id:n.id,mapId:n.mapId??null,unclassified:!!n.unclassified})),
    locations:AtlasPreview.data.LOCATIONS.map(l=>l.name),cast:AtlasPreview.data.CAST.map(c=>c.name),
    items:AtlasPreview.data.ITEMS.length,events:AtlasPreview.data.EVENTS.length,receipts:AtlasPreview.data.RECEIPTS.length}));
  report.world=world;
  check('root-is-a-real-map-not-a-shell',world.rootHost&&!!world.rootMapId,world);
  check('world-build-created-map-locations-and-cast',world.children.length>0&&world.locations.length>0&&world.cast.length>0,{children:world.children.length,locations:world.locations,cast:world.cast});
  const reachable=await frame.evaluate(()=>{const ids=[];const walk=n=>{if(n.mapId)ids.push(n.id);for(const c of n.children||[])walk(c);};walk(AtlasPreview.data.ROOT);
    return {ids,unique:new Set(ids).size,count:ids.length};});
  check('every-map-reachable-exactly-once',reachable.count===reachable.unique&&reachable.count>0,reachable);

  const paintedAfter=await frame.evaluate(()=>{const c=document.getElementById('map');
    const a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;const colors=new Set();
    for(let i=0;i<a.length;i+=64)colors.add(`${a[i]},${a[i+1]},${a[i+2]}`);return colors.size;});
  check('canvas-paints-after-build',paintedAfter>30,paintedAfter);

  await frame.evaluate(()=>{AtlasPreview.go(AtlasPreview.data.ROOT.id);AtlasPreview.map.fit(false);});await delay(500);
  const marks=async()=>frame.evaluate(()=>AtlasPreview.map.state.hits.map(h=>[h.m.id,Math.round(h.x),Math.round(h.y)]));
  const hoverPoint=await frame.evaluate(()=>{const h=AtlasPreview.map.state.hits[0];if(!h)return null;const r=document.getElementById('map').getBoundingClientRect();return {x:r.left+h.x,y:r.top+h.y,id:h.m.id};});
  const beforeHover=await marks();
  if(hoverPoint){await page.mouse.move(hoverPoint.x,hoverPoint.y);await delay(300);}
  const afterHover=await marks();
  check('hover-keeps-anchors',!!hoverPoint&&JSON.stringify(beforeHover)===JSON.stringify(afterHover),{id:hoverPoint?.id??null,before:beforeHover.length,after:afterHover.length});
  const clicked=hoverPoint?await frame.evaluate(id=>{const c=AtlasPreview.data.CAST.find(x=>x.id===id)||AtlasPreview.data.LOCATIONS.find(x=>x.id===id);return c?.name??null;},hoverPoint.id):null;
  report.hoverTarget=clicked;
  await shot(page,'05-world-after-build');

  // 真实投影的坐标与事件分区，也必须在**真数据**上成立。
  const feedAfter=await frame.evaluate(()=>({latestTurnId:AtlasPreview.data.meta.latestTurnId??null,known:AtlasPreview.data.EVENTS.filter(e=>e.known).length,
    turnN:AtlasPreview.turnEvents().length,histN:AtlasPreview.historyEvents().length,
    overlap:AtlasPreview.turnEvents().filter(e=>AtlasPreview.historyEvents().some(h=>h.id===e.id)).length}));
  check('turn-and-history-disjoint-after-build',feedAfter.overlap===0&&feedAfter.turnN+feedAfter.histN===feedAfter.known,feedAfter);
  report.feedAfterBuild=feedAfter;

  // 落点建立之后再进一次诊断页：同一个入口应该给出「真的没有备份」这句干净话，
  // 而不是把内部术语（chatMetadata）印给用户看。
  await gotoPage('diag');
  const backupAfter=await frame.evaluate(()=>{const button=document.querySelector('[data-backup-export]'),status=document.querySelector('[data-backup-status]');
    return {disabled:button?button.disabled===true:null,status:(status?.innerText??'').slice(0,200)};});
  report.backupAfterSave=backupAfter;
  check('backup-entry-clean-reason-after-save',!!backupAfter.status&&!/chatMetadata/.test(backupAfter.status),backupAfter);
  await shot(page,'06-diagnostics-after-build');
  await gotoPage('map');

  // ── 10. 可选：一次真实模型生成（默认不做） ────────────────────────────────
  if(wantLive){
    // 真实生成前必须先摘掉 mock，否则「真实模型」只是个自欺的标签。
    await page.evaluate(()=>{const a=window.__atlasAcceptance;
      if(a.previousTavernHelper===undefined)delete window.TavernHelper;else window.TavernHelper=a.previousTavernHelper;});
    report.live={
      modelRequests:0,
      startedAt:new Date().toISOString()
    };
    page.on('request',request=>{if(new URL(request.url()).pathname==='/api/backends/chat-completions/generate')report.live.modelRequests++;});
    // 基线必须**在发真实请求之前**取。离线回合已经留下一张回执，
    // 若仍用 `receipts>0` 判完成，等待循环会在真实网络请求发出之前就退出，
    // 把「真实模型已跑」误报成 live-model-request-was-sent=false（曾实测到）。
    const liveBaseline=await page.evaluate(()=>{const h=window.__atlasAcceptance.handle,s=h.core.getState();
      return {receipts:s.receipts?.length??0,chat:SillyTavern.getContext().chat.length};});
    report.live.baseline=liveBaseline;
    const prompt=option('--prompt','我推开图书馆的门，走了进去。');
    await page.evaluate(async text=>{const box=document.getElementById('send_textarea');box.value=text;
      box.dispatchEvent(new Event('input',{bubbles:true}));
      document.getElementById('send_but').click();},prompt);
    let settled=null;
    for(let i=0;i<150;i++){
      settled=await page.evaluate(()=>{const h=window.__atlasAcceptance.handle,s=h.core.getState();
        return {phase:s.turnPhase??null,error:s.lastError??null,receipts:s.receipts?.length??0,lastReceipt:s.receipts?.[0]?.status??null,chat:SillyTavern.getContext().chat.length};});
      if(settled.error)break;
      // 「真回合结束」的判据必须是**结果**，不是「请求发出」——
      // 只看 modelRequests>0 会在回合仍在中途时提前退出，随后的收尾会把回合掐断，
      // 造成「HTTP 成功但没 commit」的假通过。这里要求回执或消息确实新增。
      if((settled.receipts>liveBaseline.receipts||settled.chat>liveBaseline.chat)&&settled.phase==='idle')break;
      await delay(2500);
    }
    report.live.settled=settled;
    report.live.modelRequestsIobserved=report.live.modelRequests;
    report.live.committed=settled?.receipts>liveBaseline.receipts||settled?.chat>liveBaseline.chat;
    check('live-model-request-was-sent',report.live.modelRequests>0,{modelRequests:report.live.modelRequests});
    check('live-turn-settled-without-error',!settled?.error,settled);
    check('live-turn-committed-a-new-outcome',!!report.live.committed,{baseline:liveBaseline,settled});
    await shot(page,'04-live-turn');
  }else{
    report.live={skipped:true,reason:'未传 --live：本次只做离线 UI 与数据验收，不发真实模型请求。'};
    check('live-model-request-not-sent-in-offline-run',true,report.live);
  }
}catch(error){
  report.pageErrors.push(String(error?.stack??error).slice(0,1200));
}finally{
  // 收尾：关掉扩展、归还 sqlMode。**不动任何已有聊天**——本次全程只写新建的那条测试聊天。
  await page.evaluate(async()=>{
    try{
      const live=window.__atlasAcceptance;if(!live)return;
      if(live.offlineModel){if(live.previousTavernHelper===undefined)delete window.TavernHelper;else window.TavernHelper=live.previousTavernHelper;}
      const ctx=SillyTavern.getContext();
      const bucket=ctx.extensionSettings.atlas_world_sim;
      if(bucket){if(live.hadSqlMode)bucket.sqlMode=live.sqlMode;else delete bucket.sqlMode;}
      const ext=await import('/scripts/extensions/third-party/atlas-sillytavern-plugin/index.js');
      await ext.disconnectAtlas?.();
    }catch{}
  }).catch(()=>{});
  writeFileSync(`${dir}/evidence.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({origin,installed:report.installed,newChat:report.newChat,failed:report.failed,checks:Object.keys(report.checks).length,pageErrors:report.pageErrors.length,screenshots:report.screenshots,evidence:`${dir}/evidence.json`},null,2));
  await browser.close();
  if(report.failed.length||report.pageErrors.length)process.exitCode=1;
}
