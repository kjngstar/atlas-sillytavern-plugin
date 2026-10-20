/** Mount the supplied UI intact in its own document; provide data and real backend ports. */
import { emptyReferenceData, projectReferenceData, referenceEntity,referenceReceipts,referenceDiagnostics } from './atlas-reference-data.mjs';
import { referencePresetDocument, referenceSettingsCommands } from './atlas-reference-presets.mjs';
import { buildMapAnalysisExport } from './atlas-map-export.mjs';
import { projectReferenceFlows } from './atlas-reference-flows.mjs';

/**
 * M6-01：事件流分页参数，镜像 `src/atlas-runtime-limits.ts` 的 feedPageMax。
 * 引擎侧最终仍会自己收敛（超出就夹回 100），这里只是别发出明显超限的请求。
 * 页数上限是 UI 侧的保护，防止服务端一直给 nextCursor 时死循环。
 */
const ATLAS_FEED_PAGE_MAX=100;
const ATLAS_FEED_MAX_PAGES=20;

export function mountReferenceUi({root,core,api,getContext,settingsPort,lorePort,diagnostics=()=>[],emit=()=>{},defaultPrompt='',pluginVersion=null,fetchFn=globalThis.fetch,loadSqlRuntime=()=>import(new URL('../dist/atlas-sql.mjs',import.meta.url).href)}) {
  root.replaceChildren();root.className='atlas-native-ui-host';root.id='atlas-extension-panel-root';
  root.setAttribute('role','application');root.setAttribute('aria-label','阿特拉斯世界工作台');
  // Tavern themes may transform a zero-height html element, making fixed inset
  // resolve against that element. Size the host from the viewport explicitly.
  Object.assign(root.style,{position:'fixed',inset:'0',width:'100vw',height:'100dvh',zIndex:'10000',padding:'0',margin:'0',background:'transparent'});
  const frame=root.ownerDocument.createElement('iframe');frame.title='ATLAS 世界工作台';
  frame.setAttribute('aria-label','原版 ATLAS 世界工作台');
  Object.assign(frame.style,{display:'block',width:'100%',height:'100%',border:'0',background:'transparent'});
  let disposed=false,ready=false,viewMode='author',epoch=0,lastKey='',scopeId='',lastReadFailure='',latest=emptyReferenceData(),sqlMod=null,loading=null;
  let settings={},prefs={},presetDoc=null,presetQueue=Promise.resolve(),actionBusy=false,actionError=null,actionScope='';
  let mapExportViews=null;
  const context=()=>{const c=getContext?.();return c?.chatMetadata?c:null;};
  function scope(){const s=core.getState(),c=context(),env=c?.chatMetadata?.atlas?.database,enabled=c?.extensionSettings?.atlas_world_sim?.sqlMode??s.stateData?.sqlModeEnabled??s.stateData?.sqlMode??true;return {state:s,context:c,metadata:c?.chatMetadata,enabled,key:JSON.stringify([s.chatId,c?.chatId??c?.chat_id,s.binding?.branchId??'main',env?.sha256,env?.storage_revision,s.stateData?.revision,viewMode,enabled]),data:env?.data};}
  function live(ticket){const now=scope();return !disposed&&ticket.epoch===epoch&&ticket.key===now.key&&ticket.data===now.data&&ticket.metadata===now.metadata;}
  // 写入完成后本聊天的 revision/hash 必然变化；此时只核对聊天和分支身份。
  // 读取仍使用 live() 的完整快照守卫，不能将旧读取应用到新的修订。
  function sameWorld(ticket){const now=scope();return !disposed&&ticket.state.chatId===now.state.chatId&&ticket.state.binding?.branchId===now.state.binding?.branchId&&ticket.metadata===now.metadata&&now.enabled;}
  function deliver(data,resetScope=false){const s=core.getState();data.meta.engine={hasChat:!!s.chatId,bound:!!s.binding,enabled:s.binding?.enabled===true,sqlEnabled:scope().enabled,serviceStatus:s.serviceStatus??'checking',phase:s.turnPhase??'idle',busy:actionBusy||!!s.pendingTurn||['queued','reading-context','committing'].includes(s.turnPhase),error:actionScope===data.meta.scopeKey&&actionError? actionError:typeof s.lastError==='string'?s.lastError:s.lastError?.message??null};
    data.RECEIPTS=referenceReceipts(s,data.DIAGNOSTICS);const ids=new Set(data.DIAGNOSTICS.map(d=>d.id));data.DIAGNOSTICS.push(...referenceDiagnostics(diagnostics()).filter(d=>!ids.has(d.id)));
    if(data.meta.engine.error&&!data.DIAGNOSTICS.some(d=>d.message===data.meta.engine.error))data.DIAGNOSTICS.unshift({id:'engine-last-error',t:'',level:'error',code:'ENGINE_ACTION_FAILED',message:data.meta.engine.error});
    latest=data;if(ready)frame.contentWindow?.AtlasPreview?.updateSnapshot(data,{resetScope});}
  // 错误要带上 code：调用方需要区分「游标过期，重读第一页就行」和「服务真的坏了」。
  async function request(method,path,body){const r=await api.request(method,path,body);if(r.status!==200||r.body?.ok===false){const error=Error(r.body?.error?.message??`请求失败（${r.status}）`);error.code=r.body?.error?.code??null;error.status=r.status;error.details=r.body?.error?.details??null;throw error;}return r.body?.data??r.body;}
  async function query(ticket,kind,extra={}){if(!live(ticket))return null;
    const result=await request('POST','/sql/chat/ui-read',{chatUid:ticket.state.chatId,branchId:ticket.state.binding?.branchId??'main',kind,viewMode,limit:200,...extra});
    if(!live(ticket))return null;return result;}
  /**
   * M6-01：读故事事件流。
   *
   * 分页必须绑住本次读取的身份（epoch/revision/viewMode/filter）。两条纪律：
   * - **游标过期不是错误**：作者切了视角 / 世界推进了 revision，旧游标必然作废 ——
   *   丢掉已收集的页、从第一页重读一次即可，绝不能把两个身份的页拼在一起。
   * - **半路换 revision 整份丢弃**：返回的 revision 和本批要求的不一致时直接放弃这一批，
   *   否则左栏会出现「上一轮世界的事件 + 这一轮世界的事件」混排。
   */
  async function readWorldFeed(ticket,revision,feedFilter){
    const seen=new Set();const items=[];let cursor;let metadata={};let restarted=false;
    for(let page=0;page<ATLAS_FEED_MAX_PAGES;page++){
      let dto;
      try{
        dto=await query(ticket,'world-feed',{revision,cursor,limit:ATLAS_FEED_PAGE_MAX,feedFilter});
      }catch(error){
        const stale=error?.code==='VIEW_CURSOR_STALE'||error?.code==='VIEW_CURSOR_INVALID';
        if(stale&&cursor&&!restarted){restarted=true;cursor=undefined;items.length=0;seen.clear();continue;}
        if(stale)return {items:[],metadata:{}};
        throw error;
      }
      if(!dto||!live(ticket))return null;
      if(Number(dto.revision)!==Number(revision))return null;
      metadata=dto.metadata??{};
      for(const item of dto.items??[]){if(item&&!seen.has(item.id)){seen.add(item.id);items.push(item);}}
      cursor=dto.nextCursor;
      if(!cursor)break;
    }
    return {items,metadata};
  }
  async function refresh(force=false){
    if(disposed)return;
    const captured=scope(),worldScope=JSON.stringify([captured.state.chatId,captured.state.binding?.branchId,viewMode]);
    const changed=scopeId!==worldScope;scopeId=worldScope;
    const key=captured.key+'|'+JSON.stringify([captured.state.receipts,captured.state.lastError,captured.state.binding?.enabled,captured.state.serviceStatus,captured.state.pendingTurn,captured.state.turnPhase,actionBusy,diagnostics().length]);
    if(!force&&key===lastKey)return loading;
    lastKey=key;const ticket={...captured,epoch:++epoch};
    if(changed)deliver(emptyReferenceData({viewMode,scopeKey:worldScope,worldName:captured.state.binding?'正在读取当前世界':'尚未建立世界'}),true);
    loading=(async()=>{
      if(!ticket.state.binding){deliver(emptyReferenceData({viewMode,scopeKey:worldScope}),changed);return;}
      if(!ticket.enabled){deliver(emptyReferenceData({viewMode,scopeKey:worldScope,worldName:'世界推演已暂停'}),true);return;}
      // A new SQL world has a live read-only base before its first successful
      // turn creates a saved envelope. Read the authoritative engine session.
      if(!sqlMod)sqlMod=await loadSqlRuntime();if(!live(ticket))return;
      const mapView=await query(ticket,'map');if(!mapView||!live(ticket))return;
      const revision=mapView.revision;
      // world-feed 是**故事**（读者看的），changes 只留给回执的技术明细，两者职责不混。
      const [sceneView,taskView,flowView,changesView,logsView]=await Promise.all(['scene','tasks','flows','changes','diagnostics'].map(kind=>query(ticket,kind,{revision})));
      const worldFeedView=await readWorldFeed(ticket,revision,null);if(!worldFeedView||!live(ticket))return;
      const catalogRows=[];let cursor;
      for(let page=0;page<100;page++){
        const dto=await query(ticket,'catalog',{revision,cursor});if(!dto||!live(ticket))return;
        catalogRows.push(...dto.items);if(!dto.nextCursor)break;if(dto.nextCursor===cursor)throw Error('目录游标未前进');if(page===99)throw Error('目录超过当前读取上限，请缩小目录范围');cursor=dto.nextCursor;
      }
      if(!live(ticket))return;
      const protagonistId=mapView.metadata?.protagonistId??null;
      const detailRows=[];
      // Load summaries in bounded batches; queries enforce the active POV field restrictions.
      const characters=catalogRows.filter(c=>c.entityKind==='character');
      for(let i=0;i<characters.length;i+=25){const batch=await Promise.all(characters.slice(i,i+25).map(c=>query(ticket,'entity',{revision,entityKind:'character',entityId:c.entityId})));if(!live(ticket))return;detailRows.push(...batch.flatMap(x=>x?.items??[]));}
      const data=projectReferenceData({state:ticket.state,mapView,sceneView,catalogView:{items:catalogRows},taskView,flowView,changesView,worldFeedView,logsView,details:detailRows,protagonistId,
        diagnostics:diagnostics(),viewMode,scopeKey:worldScope,projectOverview:sqlMod.projectMapView});
      if(!changed&&latest.meta.scopeKey===worldScope)data.LORE=latest.LORE;
      // Rollback identity comes from the real saved turn, never from a UI demo snapshot.
      data.meta.rollbackMessageId=mapView.metadata?.rollbackMessageId??null;data.meta.canUndo=mapView.metadata?.canUndo===true;data.meta.snapshotSaved=mapView.metadata?.snapshotSaved===true;
      if(live(ticket)){lastReadFailure='';mapExportViews={key:ticket.key,mapView,sceneView,catalogView:{items:catalogRows,revision,branchId:mapView.branchId??null,viewMode}};deliver(data,changed);}
    })().catch(error=>{if(!live(ticket))return;const failureKey=ticket.key+'|'+error.message;if(lastReadFailure!==failureKey){lastReadFailure=failureKey;emit({level:'error',source:'ui',code:'REFERENCE_UI_READ_FAILED',details:{message:error.message}});}
      const data=emptyReferenceData({viewMode,scopeKey:worldScope,worldName:'世界读取失败'});data.DIAGNOSTICS=[{id:'read-failed',t:'',level:'error',code:'REFERENCE_UI_READ_FAILED',message:error.message}];deliver(data,changed);});
    return loading;
  }
  async function boot(){
    settings=await request('GET','/settings');prefs=await settingsPort?.read?.('referenceUiPreferences')??{};
    presetDoc=referencePresetDocument(settings,prefs,defaultPrompt);
    await refresh(true);
    return {data:latest,presets:presetDoc,preferences:prefs.interaction??null,skin:prefs.skin??null,
      /**
       * P14/§21.5：提示词分层要让作者看见「当前用哪套策略、程序声明了哪些能力、实际发的是什么」。
       * 这里只搬运设置视图里的**真实值**：策略版本、已声明能力、活动预设与内置建议预设。
       * 没有任何能力/版本时给空值，不编一个默认能力。
       */
      engine:{
        policyVersion:typeof settings.promptPolicyVersion==='string'?settings.promptPolicyVersion:null,
        capabilities:Array.isArray(settings.spatialCapabilities)?[...settings.spatialCapabilities]:[],
        activePromptPresetId:settings.activePromptPresetId??null,
        suggested:typeof settings.promptPolicyVersion==='string'&&Array.isArray(settings.builtInSqlPrompt?.segments)
          ?{version:settings.promptPolicyVersion,name:settings.builtInSqlPrompt.name??'内置建议策略',
            segments:settings.builtInSqlPrompt.segments.map((s,index)=>({role:s.role,name:s.name??`第 ${index+1} 段`,content:s.content,enabled:true}))}:null,
      }};
  }
  /** 本轮正文来源：布局与建设必须用**同一份**正文，不能各拿一次（否则 sourceHash 对不上）。 */
  async function sourceText(captured){
    const c=captured.context,chat=c?.chat??[],last=chat.filter(m=>!m.is_user&&!m.is_system).at(-1),user=chat.filter(m=>m.is_user&&!m.is_system).at(-1);
    return {assistantText:last?.mes??'',userText:user?.mes??'',charDescription:c?.characters?.[c.characterId]?.description??'',
      loreSupplement:(await lorePort?.read?.()??[]).filter(e=>e.enabled!==false&&e.atlasReadable!==false).map(e=>e.content).join('\n')};
  }
  /**
   * 把一次地图类回执记进宿主（核心只有这一条外部回执通道）。
   *
   * P14/§21.3：回执要能分层显示「世界数据已保存 / 布局：… / 缺漏与语义：…」，
   * 所以这里记的是**真实结果字段**（操作名、保存状态、逐图场景汇总、队列与来源账本），
   * 让 UI 从真实数据派生，而不是凭内存计数或文案猜。
   */
  function recordMapReceipt(result,captured,operation,code,extra={}){
    const detail={operation,status:typeof result?.status==='string'?result.status:null,
      receipt:result?.receipt,issues:result?.receipt?.issues??result?.issues,coreSaved:result?.coreSaved===true,
      ...(result?.build?{build:result.build}:{}),...extra};
    core.recordExternalReceipt?.(sqlMod.toLegacyTurnReceipt(result.receipt,{coreSaved:result.coreSaved}),captured.state.chatId,detail);
    emit({level:result.receipt?.status==='partial'?'warn':'info',source:'map',code,operation,phase:'commit',outcome:result.receipt?.status==='partial'?'failed':'success'});
  }
  /** 「有失败就报全」：地图类任务的每一处 map/path 问题都要露出来，不许只留第一条。 */
  function mapIssues(result){
    return [...(result?.receipt?.issues??[]),...(result?.issues??[])].map(i=>`${i?.code??'ISSUE'}${i?.path?`@${i.path}`:''}: ${i?.message??''}`);
  }
  /**
   * M6-12②：message / action / journey 的**关联详情**。
   *
   * 这三种不是 SQL 三实体（人物/物品/地点），`inspect` 通道里没有它们的聚合详情 ——
   * 所以这里走各自**真实存在的只读视图**（目录 / 任务），拿到安全 DTO 再交给 UI；
   * 查不到就返回 null，**绝不伪造**成 inspect 的三实体结果糊过去。
   */
  async function inspectLinked(ticket,kind,id){
    if(kind==='message'){
      const dto=await query(ticket,'catalog',{});if(!dto||!live(ticket))return null;
      const row=(dto.items??[]).find(x=>String(x.entityId)===String(id)&&x.entityKind==='rumor');if(!row)return null;
      return {id:String(row.entityId),src:String(row.name??''),txt:String(row.summary??''),locationId:row.locationId??null,mapNodeId:row.mapId??null,status:'已记录',known:row.known!==false,kind:'rumor'};
    }
    if(kind==='action'||kind==='journey'){
      const dto=await query(ticket,'tasks',{});if(!dto||!live(ticket))return null;
      const row=(dto.items??[]).find(x=>String(x.taskId)===String(id));if(!row)return null;
      return {id:String(row.taskId),n:String(row.title??''),d:String(row.reasonCode??(row.planned?'计划中的行动':'已记录的行动')),
        stName:String(row.status??'running'),entityId:row.actorEntityId??null,known:row.known!==false};
    }
    return null;
  }
  async function inspect(kind,id){const ticket={...scope(),epoch};
    if(kind==='message'||kind==='action'||kind==='journey')return inspectLinked(ticket,kind,id);
    const entityKind=kind==='place'?'location':kind;if(!['character','item','location'].includes(entityKind))return null;
    const location=kind==='place'?latest.LOCATIONS.find(x=>x.id===id):null;
    const node=kind==='place'&&!location?findNode(latest.ROOT,id):null;
    const entityId=node?.containerLocationId??id;
    const dto=await query(ticket,'entity',{entityKind,entityId});
    if(!dto||!live(ticket))return null;
    return referenceEntity(dto.items?.[0]);
  }
  /**
   * M6-18：升级前原档的只读导出。
   *
   * 走 M1-06A 的 `/sql/upgrade-backup`：只读 chatMetadata，不 open session、不写库、
   * 不触发宿主保存，也**不清除**备份 —— 用户刷新或重开聊天后仍能导出同一份原档。
   * 没有备份/备份损坏/备份属于另一个聊天时，统一抛出明确错误（服务端不泄露他人备份是否存在）。
   */
  async function exportUpgradeBackup(){
    const captured=scope();if(!captured.state.chatId)throw Error('请先打开一个酒馆聊天');
    const result=await request('POST','/sql/upgrade-backup',{chatUid:captured.state.chatId,branchId:captured.state.binding?.branchId??'main'});
    const backup=result?.backup??null;
    if(!backup?.envelope)throw Error('当前聊天没有可导出的升级前原档备份');
    return {backup,envelope:backup.envelope};
  }
  function findNode(node,id){if(node.id===id)return node;for(const child of node.children??[]){const found=findNode(child,id);if(found)return found;}return null;}
  async function readLore(){const ticket={...scope(),epoch};const rows=viewMode==='author'?await lorePort?.read?.()??[]:[];if(!live(ticket))return;latest.LORE=rows.map(l=>({...l,target:[...latest.LOCATIONS,...latest.CAST].find(x=>l.keys.some(k=>k===x.name))?.id??null}));deliver(latest);}
  async function persistPresets(doc,action={kind:'selection'}){
    if(actionBusy)throw Error('当前推演正在执行，请结束后再保存预设');
    const task=async()=>{
      const current=await request('GET','/settings');
      const commands=referenceSettingsCommands(doc,current,action);
      if(commands.length)settings=await request('PUT','/settings',{action:'batch',commands});else settings=current;
      api.setRuntimeApiKeys?.(doc.connections);
      prefs={...prefs,active:doc.active,assignments:doc.assignments,drafts:{connections:doc.connections.filter(c=>!settings.apiPresets?.some(x=>x.id===c.id)).map(({apiKey,...c})=>c),promptPresets:doc.promptPresets.filter(p=>!settings.promptPresets?.some(x=>x.id===p.id))}};await settingsPort?.write?.('referenceUiPreferences',prefs);
      presetDoc=doc;return true;
    };
    const pending=presetQueue.then(task);presetQueue=pending.catch(()=>{});return pending;
  }
  async function withTask(task,run,checkCoreError=true){
    if(actionBusy||core.getState().pendingTurn||['queued','reading-context','committing'].includes(core.getState().turnPhase))throw Error('有回合正在处理，请稍后再试');
    if(!scope().enabled)throw Error('SQL 世界数据已关闭，请在酒馆扩展设置中开启');
    if(!core.getState().chatId)throw Error('请先打开一个酒馆聊天');
    actionError=null;actionScope=latest.meta.scopeKey;actionBusy=true;deliver(latest);
    try{await presetQueue;const original=await request('GET','/settings'),p=presetDoc?.assignments?.[task];
    const commands=[];
    if(p&&original.apiPresets?.some(c=>c.id===p.connectionId)&&p.connectionId!==original.activeApiPresetId)commands.push({action:'api.activate',id:p.connectionId});
    if(p&&original.promptPresets?.some(c=>c.id===p.promptPresetId)&&p.promptPresetId!==original.activePromptPresetId)commands.push({action:'prompt.activate',id:p.promptPresetId});
    if(commands.length)await request('PUT','/settings',{action:'batch',commands});
    try{const result=await run();const error=checkCoreError&&core.getState().lastError;if(error)throw Error(typeof error==='string'?error:error.message??error.code??'推演失败');return result;}finally{if(commands.length)await request('PUT','/settings',{action:'batch',commands:[{action:'api.activate',id:original.activeApiPresetId},{action:'prompt.activate',id:original.activePromptPresetId}]});await refresh(true);}
    }catch(error){actionError=error.message;throw error;}finally{actionBusy=false;deliver(latest);}
  }
  const bridge={boot,ready(){ready=true;deliver(latest);render();if(core.getState().panelOpen!==false)frame.contentWindow?.focus?.();},inspect,persistPresets,
    async readFlows(mapId,selectedEntityId=null){
      const ticket={...scope(),epoch},node=findNode(latest.ROOT,mapId),revision=latest.meta.revision;
      if(!node||!ticket.state.binding)return null;
      const dto=await query(ticket,'flows',{mapId:node.id,selectedEntityId,revision});
      if(!dto||!live(ticket)||dto.metadata?.stale||dto.revision!==revision)return null;
      return {scopeKey:latest.meta.scopeKey,revision,mapId:node.id,...projectReferenceFlows(dto,node)};
    },
    async onPage(page){
      if(page!=='lore')return;
      const ticket={...scope(),epoch};
      try{await readLore();}catch(error){
        if(!live(ticket))return;
        emit({level:'error',source:'ui',code:'REFERENCE_LORE_READ_FAILED',details:{message:error.message}});
        latest.LORE=[];
        latest.DIAGNOSTICS.unshift({id:'lore-read-failed',t:'',level:'error',code:'REFERENCE_LORE_READ_FAILED',message:error.message});
        deliver(latest);
      }
    },
    async toggleLore(id){
      if(viewMode!=='author')throw Error('请切换世界后台后修改世界书条目');
      if(!lorePort?.toggle)throw Error('世界书启停端口不可用');
      await lorePort.toggle(id);await readLore();
    },
    downloadMap(filename,text){
      // Own the Blob in the top document: embedded browsers cannot download
      // a frame-owned Blob. Invoke synchronously from the explicit link click.
      const doc=root.ownerDocument,win=doc.defaultView;
      const url=win.URL.createObjectURL(new win.Blob([text],{type:'application/json'}));
      const link=doc.createElement('a');link.href=url;link.download=filename;link.hidden=true;doc.body.append(link);
      link.click();link.remove();setTimeout(()=>win.URL.revokeObjectURL(url),60000);
    },
    async fetchModels(connection){
      if(connection?.provider==='sillytavern')throw Error('酒馆主连接的模型请在酒馆 API 设置中选择；自定义连接可在这里获取模型');
      let url;try{url=new URL(String(connection?.url??'').trim());}catch{throw Error('请先填写有效的 API 地址');}
      if(!['http:','https:'].includes(url.protocol))throw Error('API 地址必须使用 HTTP 或 HTTPS');
      url.pathname=url.pathname.replace(/\/(?:chat\/completions|messages)\/?$/,'').replace(/\/$/,'');
      const headers=context()?.getRequestHeaders?.();if(!headers)throw Error('酒馆请求端口不可用');
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
      try{
        const response=await fetchFn('/api/backends/chat-completions/status',{method:'POST',headers:{...headers,'Content-Type':'application/json'},signal:controller.signal,
          body:JSON.stringify({chat_completion_source:'custom',custom_url:url.href.replace(/\/$/,''),custom_include_headers:connection.apiKey?.trim()?`Authorization: Bearer ${connection.apiKey.trim()}`:''})});
        if(!response.ok)throw Error(`获取模型失败（HTTP ${response.status}）`);
        const data=await response.json();const models=[...new Set((Array.isArray(data.data)?data.data:[]).map(m=>m?.id).filter(id=>typeof id==='string'&&id.trim()))].sort();
        if(!models.length)throw Error('接口没有返回模型列表；可以继续手动填写模型名称');
        return models;
      }catch(error){if(error.name==='AbortError')throw Error('获取模型超过 30 秒，请检查接口');throw error;}finally{clearTimeout(timer);}
    },
    async exportMap(mapId){
      const captured=scope();
      await refresh(true);
      if(disposed||captured.key!==scope().key||captured.metadata!==context()?.chatMetadata||mapExportViews?.key!==scope().key)throw Error('世界或视角已变化，请重新导出地图');
      return buildMapAnalysisExport({data:latest,...mapExportViews,mapId,pluginVersion,layoutPolicyVersion:sqlMod?.LAYOUT_SIGNATURE_POLICY_VERSION??null});
    },
    async setViewMode(mode){viewMode=mode==='author'?'author':'pov';await refresh(true);if(frame.contentWindow?.AtlasPreview?.state.page==='lore')await bridge.onPage('lore');},
    async setLoreRead(id,enabled){if(viewMode!=='author')throw Error('请切换世界后台后修改 ATLAS 读取设置');if(!lorePort?.setAtlasRead)throw Error('ATLAS 读取设置不可用');await lorePort.setAtlasRead(id,enabled);await readLore();},
    close(){core.setPanelOpen(false);},
    async setEnabled(enabled){if(actionBusy||core.getState().pendingTurn)throw Error('有回合正在处理，请稍后再试');if(!core.getState().binding)throw Error('请先建立当前聊天的世界');await core.setEnabled(enabled);await refresh(true);const s=core.getState();if(s.binding?.enabled!==enabled)throw Error(s.lastError??'推演开关未保存');},
    async advance(){return withTask(core.getState().binding?'advance':'initialize',async()=>{if(core.getState().binding)return core.manualAdvance();const result=await core.initializeWorld();if(result!==true)throw Error(core.getState().lastError??'当前聊天的世界初始化未完成');return result;});},
    async retry(){return withTask('repair',()=>core.retryLastCommit());},
    async layout(mapId){return withTask('initialize',async()=>{
      const captured=scope();
      let result;
      try{result=await request('POST','/sql/chat/map/layout',{chatId:captured.state.chatId,mapId,requestId:crypto.randomUUID(),...await sourceText(captured)});}
      catch(error){const receipt=error.details?.receipt;if(receipt&&sqlMod&&core.getState().chatId===captured.state.chatId&&context()?.chatMetadata===captured.metadata){core.recordExternalReceipt?.(sqlMod.toLegacyTurnReceipt(receipt,{coreSaved:false}),captured.state.chatId,{...error.details,coreSaved:false,errorCode:error.code,httpStatus:error.status});}throw error;}
      if(!sameWorld(captured))return null;
      await core.refresh();await refresh(true);
      const node=findNode(latest.ROOT,mapId);
      // 布局回执的「布局：…」一行只能来自**真实证据**：候选保存确认 + 这张图真的有可画场景。
      // 官道这类没有 scene 的情况即便 coreSaved=true 也不许显示「生成完成」。
      recordMapReceipt(result,captured,'layout','LAYOUT_TASK_COMPLETE',
        {sceneSaved:result.coreSaved===true&&result.sceneSaved===true&&node?.hasLayout===true});
      if(result.coreSaved!==true)throw Error(mapIssues(result).join('；')||'本图布局未保存');
      if(!node?.hasLayout||result.sceneSaved!==true)throw Error(mapIssues(result).join('；')||'本轮没有保存新的可绘制布局，原布局已保留，请查看诊断');
      return result;
    },false);},
    /**
     * M6-12①：显式「建设本图」。
     *
     * 与 layout 的分工：layout 只画**已登记实体**的布局；build 才会让引擎补新地点/新连接。
     * 因此它必须是**用户明确点击**才发（不因打开地图自动调模型），且带真实的
     * chatUid/branch/revision/正文来源 —— revision 对不上由服务端回 STALE_BASE，
     * 由 UI 提示「世界已经推进，请重试」，而不是把旧候选当新结果画出来。
     */
    async build(mapId,{mode='local',focusLocationIds=null}={}){
      if(actionBusy||core.getState().pendingTurn)throw Error('有回合正在处理，请稍后再试');
      if(!scope().enabled)throw Error('SQL 世界数据已关闭，请在酒馆扩展设置中开启');
      if(!core.getState().chatId)throw Error('请先打开一个酒馆聊天');
      const captured=scope(),ticket={...captured,epoch:++epoch};
      actionError=null;actionScope=latest.meta.scopeKey;actionBusy=true;deliver(latest);
      try{
        await presetQueue;
        if(!sqlMod)sqlMod=await loadSqlRuntime();
        const view=await query(ticket,'map',{});
        if(!view||!live(ticket))return null;
        const row=(view.items??[]).find(m=>String(m.mapId??m.id)===String(mapId))??null;
        const focus=(Array.isArray(focusLocationIds)&&focusLocationIds.length?focusLocationIds.map(String):(row?.containerLocationId?[String(row.containerLocationId)]:[]));
        const requested=mode==='bootstrap'||!focus.length?'bootstrap':'local';
        const result=await request('POST','/sql/chat/map/build',{chatId:captured.state.chatId,branchId:captured.state.binding?.branchId??'main',
          requestId:crypto.randomUUID(),mode:requested,...(requested==='local'?{focusLocationIds:focus}:{}),
          baseRevision:view.revision,...await sourceText(captured)});
        if(!sameWorld(captured))return null;
        recordMapReceipt(result,captured,'build','WORLD_BUILD_TASK_COMPLETE');
        // 只有真保存了（coreSaved=true）才算「正式结果」；否则候选一律丢弃并报全部问题。
        if(result.coreSaved!==true)throw Error(mapIssues(result).join('；')||'本图建设未保存');
        await core.refresh();await refresh(true);
        return result;
      }catch(error){actionError=error.message;throw error;}finally{actionBusy=false;deliver(latest);}
    },
    exportUpgradeBackup,
    /**
     * §21.4：回退**执行前**的真实影响预览（只读）。
     * 返回服务端用同一个 `planRollback` 算出的计划摘要；没有可回退楼或读不到就返回 null，
     * 由 UI 决定是否还能执行 —— 不许用「数 UI 卡片」猜影响范围。
     */
    async rollbackPreview(){const captured=scope();const messageId=latest.meta.rollbackMessageId;
      if(messageId===null||messageId===undefined)return null;
      const result=await request('POST','/sql/chat/rollback-preview',{chatUid:captured.state.chatId,chatId:captured.state.chatId,
        assistantMessageId:String(messageId),viewMode});
      return result?.preview??null;},
    /**
     * P14/§21.5：请求预览（只读）。
     *
     * 与真实发送走**同一条组装链**：先按任务的**真实绑定**临时激活连接与提示词预设
     * （initialize/advance 用它们自己的绑定，repair 用 repair 的绑定），再请求服务端
     * `port.preview` —— 而 `port.preview` 与 `port.request` 共用 `prepare()` 与
     * `assemblePromptLayers()`。这里不拼第二份「给人看」的消息。
     *
     * 不发模型请求、不改存档：预览只读设置与目录，随后恢复原绑定。
     */
    async previewMessages(task='advance'){
      const phase=task==='repair'?'repair':'observe';
      return withTask(task,async()=>{
        const captured=scope();
        if(!captured.state.chatId)throw Error('请先打开一个酒馆聊天');
        const text=await sourceText(captured);
        const result=await request('POST','/sql/chat/preview',{chatUid:captured.state.chatId,chatId:captured.state.chatId,
          userText:text.userText,assistantText:text.assistantText,playerName:context()?.name1??'',phase});
        return {...result,task,phase,viewMode,
          policyVersion:typeof settings?.promptPolicyVersion==='string'?settings.promptPolicyVersion:null,
          capabilities:Array.isArray(settings?.spatialCapabilities)?[...settings.spatialCapabilities]:[]};
      },false);
    },
    async undo(){const messageId=latest.meta.rollbackMessageId;if(messageId===null||messageId===undefined)throw Error('没有可回退的已提交回合');
      const captured=scope();const result=await request('POST','/sql/chat/rollback',{chatUid:captured.state.chatId,chatId:captured.state.chatId,assistantMessageId:String(messageId)});
      if(result.coreSaved!==true)throw Error(result.issues?.map(x=>x.message).join('；')||'回退未保存');await core.refresh();await refresh(true);},
    async refresh(){await core.refresh();await refresh(true);},
    async savePreferences(value){prefs={...prefs,interaction:value};await settingsPort?.write?.('referenceUiPreferences',prefs);},
    async saveSkin(value){prefs={...prefs,skin:value};await settingsPort?.write?.('referenceUiPreferences',prefs);},
    diagnostic(entry){emit(entry);},
  };
  frame.__atlasHost=bridge;frame.src=new URL('./atlas-reference/index.html',import.meta.url).href;root.append(frame);
  let wasOpen=false;
  const render=()=>{const open=core.getState().panelOpen!==false;root.style.display=open?'':'none';if(ready){frame.contentWindow?.AtlasPreview?.setVisible?.(open);if(open&&!wasOpen)frame.contentWindow?.focus?.();}wasOpen=open;void refresh();};
  render.dispose=async()=>{disposed=true;epoch++;ready=false;frame.contentWindow?.AtlasPreview?.destroy?.();frame.__atlasHost=null;frame.remove();};
  core.__renderPage=render;render();return render;
}
