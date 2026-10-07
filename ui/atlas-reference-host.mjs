/** Mount the supplied UI intact in its own document; provide data and real backend ports. */
import { emptyReferenceData, projectReferenceData, referenceEntity,referenceReceipts,referenceDiagnostics } from './atlas-reference-data.mjs';
import { referencePresetDocument, referenceSettingsCommands } from './atlas-reference-presets.mjs';

export function mountReferenceUi({root,core,api,getContext,settingsPort,lorePort,diagnostics=()=>[],emit=()=>{},defaultPrompt='',loadSqlRuntime=()=>import(new URL('../dist/atlas-sql.mjs',import.meta.url).href)}) {
  root.replaceChildren();root.className='atlas-native-ui-host';root.id='atlas-extension-panel-root';
  root.setAttribute('role','application');root.setAttribute('aria-label','阿特拉斯世界工作台');
  Object.assign(root.style,{position:'fixed',inset:'0',zIndex:'10000',padding:'0',margin:'0',background:'transparent'});
  const frame=root.ownerDocument.createElement('iframe');frame.title='ATLAS 世界工作台';
  frame.setAttribute('aria-label','原版 ATLAS 世界工作台');
  Object.assign(frame.style,{display:'block',width:'100%',height:'100%',border:'0',background:'transparent'});
  let disposed=false,ready=false,viewMode='author',epoch=0,lastKey='',scopeId='',lastReadFailure='',latest=emptyReferenceData(),sqlMod=null,loading=null;
  let settings={},prefs={},presetDoc=null,presetQueue=Promise.resolve(),actionBusy=false,actionError=null,actionScope='';
  const context=()=>{const c=getContext?.();return c?.chatMetadata?c:null;};
  function scope(){const s=core.getState(),c=context(),env=c?.chatMetadata?.atlas?.database,enabled=c?.extensionSettings?.atlas_world_sim?.sqlMode??s.stateData?.sqlModeEnabled??s.stateData?.sqlMode??true;return {state:s,context:c,metadata:c?.chatMetadata,enabled,key:JSON.stringify([s.chatId,c?.chatId??c?.chat_id,s.binding?.branchId??'main',env?.sha256,env?.storage_revision,s.stateData?.revision,viewMode,enabled]),data:env?.data};}
  function live(ticket){const now=scope();return !disposed&&ticket.epoch===epoch&&ticket.key===now.key&&ticket.data===now.data&&ticket.metadata===now.metadata;}
  function deliver(data,resetScope=false){const s=core.getState();data.meta.engine={hasChat:!!s.chatId,bound:!!s.binding,enabled:s.binding?.enabled===true,sqlEnabled:scope().enabled,serviceStatus:s.serviceStatus??'checking',phase:s.turnPhase??'idle',busy:actionBusy||!!s.pendingTurn||['queued','reading-context','committing'].includes(s.turnPhase),error:actionScope===data.meta.scopeKey&&actionError? actionError:typeof s.lastError==='string'?s.lastError:s.lastError?.message??null};
    data.RECEIPTS=referenceReceipts(s,data.DIAGNOSTICS);const ids=new Set(data.DIAGNOSTICS.map(d=>d.id));data.DIAGNOSTICS.push(...referenceDiagnostics(diagnostics()).filter(d=>!ids.has(d.id)));
    if(data.meta.engine.error&&!data.DIAGNOSTICS.some(d=>d.message===data.meta.engine.error))data.DIAGNOSTICS.unshift({id:'engine-last-error',t:'',level:'error',code:'ENGINE_ACTION_FAILED',message:data.meta.engine.error});
    latest=data;if(ready)frame.contentWindow?.AtlasPreview?.updateSnapshot(data,{resetScope});}
  async function request(method,path,body){const r=await api.request(method,path,body);if(r.status!==200||r.body?.ok===false)throw Error(r.body?.error?.message??`请求失败（${r.status}）`);return r.body?.data??r.body;}
  async function query(ticket,kind,extra={}){if(!live(ticket))return null;
    const result=await request('POST','/sql/chat/ui-read',{chatUid:ticket.state.chatId,branchId:ticket.state.binding?.branchId??'main',kind,viewMode,limit:200,...extra});
    if(!live(ticket))return null;return result;}
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
      const [sceneView,taskView,flowView,changesView,logsView]=await Promise.all(['scene','tasks','flows','changes','diagnostics'].map(kind=>query(ticket,kind,{revision})));
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
      const data=projectReferenceData({state:ticket.state,mapView,sceneView,catalogView:{items:catalogRows},taskView,flowView,changesView,logsView,details:detailRows,protagonistId,
        diagnostics:diagnostics(),viewMode,scopeKey:worldScope,projectOverview:sqlMod.projectMapView});
      if(!changed&&latest.meta.scopeKey===worldScope)data.LORE=latest.LORE;
      // Rollback identity comes from the real saved turn, never from a UI demo snapshot.
      data.meta.rollbackMessageId=mapView.metadata?.rollbackMessageId??null;data.meta.canUndo=mapView.metadata?.canUndo===true;data.meta.snapshotSaved=mapView.metadata?.snapshotSaved===true;
      if(live(ticket)){lastReadFailure='';deliver(data,changed);}
    })().catch(error=>{if(!live(ticket))return;const failureKey=ticket.key+'|'+error.message;if(lastReadFailure!==failureKey){lastReadFailure=failureKey;emit({level:'error',source:'ui',code:'REFERENCE_UI_READ_FAILED',details:{message:error.message}});}
      const data=emptyReferenceData({viewMode,scopeKey:worldScope,worldName:'世界读取失败'});data.DIAGNOSTICS=[{id:'read-failed',t:'',level:'error',code:'REFERENCE_UI_READ_FAILED',message:error.message}];deliver(data,changed);});
    return loading;
  }
  async function boot(){
    settings=await request('GET','/settings');prefs=await settingsPort?.read?.('referenceUiPreferences')??{};
    presetDoc=referencePresetDocument(settings,prefs,defaultPrompt);
    await refresh(true);
    return {data:latest,presets:presetDoc,preferences:prefs.interaction??null,skin:prefs.skin??null};
  }
  async function inspect(kind,id){const ticket={...scope(),epoch};const entityKind=kind==='place'?'location':kind;if(!['character','item','location'].includes(entityKind))return null;
    const location=kind==='place'?latest.LOCATIONS.find(x=>x.id===id):null;
    const node=kind==='place'&&!location?findNode(latest.ROOT,id):null;
    const entityId=node?.containerLocationId??id;
    const dto=await query(ticket,'entity',{entityKind,entityId});
    if(!dto||!live(ticket))return null;
    return referenceEntity(dto.items?.[0]);
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
    async setViewMode(mode){viewMode=mode==='author'?'author':'pov';await refresh(true);},
    onPage(page){core.setPage({cast:'characters',items:'items',msgs:'events',sim:'advance',time:'events',lore:'world',diag:'logs',prefs:'prompts'}[page]??'map');if(page==='lore')void Promise.resolve(refresh()).then(readLore).catch(error=>emit({level:'error',source:'ui',code:'LORE_READ_FAILED',details:{message:error.message}}));},
    async toggleLore(id){if(viewMode!=='author')throw Error('请切换世界后台后修改世界书');await lorePort?.toggle?.(id);await readLore();},
    close(){core.setPanelOpen(false);},
    async setEnabled(enabled){if(actionBusy||core.getState().pendingTurn)throw Error('有回合正在处理，请稍后再试');if(!core.getState().binding)throw Error('请先建立当前聊天的世界');await core.setEnabled(enabled);await refresh(true);const s=core.getState();if(s.binding?.enabled!==enabled)throw Error(s.lastError??'推演开关未保存');},
    async advance(){return withTask(core.getState().binding?'advance':'initialize',async()=>{if(core.getState().binding)return core.manualAdvance();const result=await core.initializeWorld();if(result!==true)throw Error(core.getState().lastError??'当前聊天的世界初始化未完成');return result;});},
    async retry(){return withTask('repair',()=>core.retryLastCommit());},
    async layout(mapId){return withTask('initialize',async()=>{
      const captured=scope(),c=captured.context,chat=c?.chat??[],last=chat.filter(m=>!m.is_user&&!m.is_system).at(-1),user=chat.filter(m=>m.is_user&&!m.is_system).at(-1);
      const result=await request('POST','/sql/chat/map/layout',{chatId:captured.state.chatId,mapId,
        assistantText:last?.mes??'',userText:user?.mes??'',charDescription:c?.characters?.[c.characterId]?.description??'',
        loreSupplement:(await lorePort?.read?.()??[]).filter(e=>e.enabled!==false).map(e=>e.content).join('\n')});
      emit({level:result.receipt?.status==='partial'?'warn':'info',source:'layout',code:'LAYOUT_TASK_COMPLETE',details:{mapId,receipt:result.receipt,coreSaved:result.coreSaved}});
      await core.refresh();await refresh(true);
      const node=findNode(latest.ROOT,mapId);
      if(!node?.hasLayout)throw Error([...(result.receipt?.issues??[]),...(result.issues??[])].map(i=>`${i.code}: ${i.message}`).join('；')||'没有生成可绘制的布局，请查看诊断');
      return result;
    },false);},
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
