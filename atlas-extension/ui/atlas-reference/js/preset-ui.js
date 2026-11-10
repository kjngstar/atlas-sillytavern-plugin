/* Preset editor, scoped to the ATLAS prototype root. */
(function(global){
'use strict';
function create({root,store,esc,toast,diagnostic,modal,renderPage,download,fetchModels,engine={},previewMessages}){
 const $=selector=>root.querySelector(selector);
 const taskNames={initialize:'地图初始化',advance:'每轮世界推演',repair:'失败组纠错'};
 let pendingImport=null,legacyBatchOpen=false;
 /**
  * §21.5 三段分层的**现状条**：固定协议（程序）→ 用户策略（本节这一堆段）→ 程序任务上下文。
  * 策略版本与能力版本照实显示 —— 能力来自程序真实声明，不是文案承诺。
  */
 function engineStrip(){
  const caps=Array.isArray(engine.capabilities)?engine.capabilities:[];
  const suggested=engine.suggested,notice=engine.compatibilityNotice;
  return `<div class="engine-strip"><span class="engine-cell">分层：固定协议 → 用户策略 → 程序任务上下文</span><span class="engine-cell">策略版本：${esc(engine.policyVersion||'未知（宿主未上报）')}</span><span class="engine-cell">程序能力：${caps.length?caps.map(esc).join('、'):'（本版本未声明空间能力）'}</span>${notice?.needsAttention?`<span class="scope-note" data-preset-compatibility>${esc(notice.message)} · 当前预设保持原样。</span>`:''}${suggested?`<button class="text-btn" data-adopt-suggested>另存内置建议策略（${esc(suggested.version)}）</button>`:''}</div>`;
 }
 function options(type,selected){const list=type==='connection'?store.document.connections:store.document.promptPresets;return list.map(p=>`<option value="${esc(p.id)}" ${p.id===selected?'selected':''}>${esc(p.name)}</option>`).join('');}
 function status(type){
  if(type&&store.dirty(type))return '有未保存的修改 · 切换时保留草稿';
  const s=store.status;return s.error||s.loadError||(s.mode==='local'?'已保存 · 刷新后保留':'本次页面保留 · 可导出备份');
 }
 function refreshStatus(type){const el=$('#presetSaveState');if(el){el.textContent=status(type);el.classList.toggle('unsaved',!!type&&store.dirty(type));}const discard=$('[data-preset-discard]');if(discard)discard.disabled=!store.dirty(discard.dataset.presetDiscard);const err=$('#presetError');if(err){err.textContent='';err.hidden=true;}}
 function error(message){const el=$('#presetError');if(el){el.textContent=message;el.hidden=false;}if(!$('#demoModal').hidden){let warning=$('#modalBody .preset-error');if(!warning){warning=document.createElement('p');warning.className='preset-error';warning.setAttribute('role','alert');$('#modalBody').append(warning);}warning.textContent=message;}toast(message,'warn');diagnostic('warn','PRESET_VALIDATION_FAILED',message);}
 function controls(type){const d=store.draft(type),doc=store.document,list=type==='connection'?doc.connections:doc.promptPresets,label=type==='connection'?'API 连接预设':'提示词预设';return `<div class="preset-selector-row"><label class="preset-selector">当前${label}<select data-preset-select="${type}" aria-label="当前${label}">${options(type,d.id)}</select></label><span class="preset-total">${list.length} 套</span></div><div class="preset-actions"><button class="action-btn" data-preset-new="${type}" ${list.length>=50?'disabled':''}>新建</button><button class="action-btn" data-preset-copy="${type}" ${list.length>=50?'disabled':''}>复制为新预设</button><button class="action-btn" data-preset-rename="${type}">重命名</button><button class="action-btn danger" data-preset-delete="${type}" ${list.length<=1?'disabled':''}>删除</button><button class="action-btn" data-export-presets="${type}">导出这一套</button><label class="action-btn preset-import">导入预设<input type="file" data-import-presets accept=".json,application/json"></label></div><div class="preset-status-row"><span id="presetSaveState" class="${store.dirty(type)?'unsaved':''}" aria-live="polite">${esc(status(type))}</span><button class="text-btn" data-preset-discard="${type}" ${store.dirty(type)?'':'disabled'}>恢复已保存</button></div><p id="presetError" class="preset-error" role="alert" hidden></p>`;}
 function promptHTML(){const p=store.draft('prompt');return engineStrip()+controls('prompt')+`<label class="preset-name-field">预设名称<input id="promptPresetName" value="${esc(p.name)}"></label><div class="preset-header"><div><h3>多角色提示词</h3><span>每段独立设置角色与内容，按显示顺序发送</span></div><button class="action-btn" data-prompt-preview>请求预览</button><button class="action-btn primary" data-save-prompts>保存预设</button></div><button class="insert-prompt" data-insert-prompt="0" >＋ 在最上方插入一段</button><div class="prompt-stack">${p.segments.map((s,i)=>`<article class="prompt-segment" data-prompt-id="${esc(s.id)}"><header><span class="segment-index">${String(i+1).padStart(2,'0')}</span><input value="${esc(s.name)}" data-prompt-name="${esc(s.id)}" aria-label="提示词名称"><select data-prompt-role="${esc(s.id)}" aria-label="提示词角色">${['system','user','assistant'].map(r=>`<option ${r===s.role?'selected':''}>${r}</option>`).join('')}</select><label class="segment-enabled"><input type="checkbox" data-prompt-enabled="${esc(s.id)}" ${s.enabled?'checked':''}>启用</label></header><textarea data-prompt-content="${esc(s.id)}" aria-label="${esc(s.name)}内容">${esc(s.content)}</textarea><footer><button class="text-btn" data-prompt-up="${esc(s.id)}" ${i===0?'disabled':''}>上移</button><button class="text-btn" data-prompt-down="${esc(s.id)}" ${i===p.segments.length-1?'disabled':''}>下移</button><button class="text-btn" data-prompt-copy="${esc(s.id)}" >复制</button><button class="text-btn danger" data-prompt-delete="${esc(s.id)}">删除</button></footer></article><button class="insert-prompt" data-insert-prompt="${i+1}" >＋ 在这里插入一段</button>`).join('')}</div><div class="settings-foot"><span>草稿独立保留；点击保存后可在下次打开时使用。</span></div>`;}
 function connectionHTML(){const c=store.draft('connection');return controls('connection')+`<div class="connection-form"><label>连接名称<input id="connectionName" value="${esc(c.name)}"></label><label>连接方式<select id="connectionProvider"><option value="openai-compatible" ${c.provider==='openai-compatible'?'selected':''}>自定义 / OpenAI 兼容接口</option><option value="sillytavern" ${c.provider==='sillytavern'?'selected':''}>使用酒馆当前连接</option></select></label><label>API 地址<input id="connectionUrl" placeholder="https://api.example.com/v1" value="${esc(c.url)}" ${c.provider==='sillytavern'?'disabled':''}></label><label>模型<input id="connectionModel" placeholder="输入模型名称" value="${esc(c.model)}" ${c.provider==='sillytavern'?'disabled':''}></label><label>API Key<span class="key-field"><input id="connectionKey" type="password" autocomplete="off" value="${esc(c.apiKey)}" placeholder="留空可先保存连接草稿" ${c.provider==='sillytavern'?'disabled':''}><button type="button" class="text-btn" data-key-toggle aria-label="显示 API Key">显示</button></span></label><label class="remember-key"><input id="connectionRememberKey" type="checkbox" ${c.rememberKey?'checked':''}><span>在此浏览器记住 Key</span></label><p class="scope-note">默认仅在本次页面保留 Key；勾选后保存在当前浏览器。导出文件始终不含 Key。</p><div class="connection-fields"><label>温度<input id="connectionTemperature" type="number" min="0" max="2" step="0.1" value="${esc(c.temperature)}"></label><label>输出上限<input id="connectionTokens" type="number" min="0" step="1" aria-describedby="connectionTokensNote" value="${esc(c.maxTokens)}"></label><label>请求超时（毫秒）<input id="connectionTimeout" type="number" min="1000" max="1200000" step="1000" value="${esc(c.timeoutMs??300000)}"></label></div><p id="connectionTokensNote" class="scope-note">输出上限填 0 表示不指定；正数按填写值发送。酒馆连接沿用宿主设置，服务商仍有模型自身的限制。</p><button class="action-btn" data-fetch-models>获取模型</button><label class="preset-check"><input id="connectionToolCalling" type="checkbox" ${c.toolCalling?'checked':''}><span>通过函数调用返回推演结果（自定义 OpenAI 兼容接口）</span></label><button class="action-btn primary" data-save-connection>保存 API 预设</button><p class="scope-note">保存后由插件使用此连接进行世界推演。</p><details class="connection-summary"><summary>查看已保存的连接配置</summary><pre id="connectionPreview">${esc(JSON.stringify(Object.fromEntries(Object.entries(store.document.connections.find(p=>p.id===c.id)).filter(([key])=>key!=='rememberKey'&&key!=='apiKey')),null,2))}</pre></details></div>`;}
 function workBatchingHTML(){const b=store.workDraft();const fields=[['workMaps','mapBatches','地图规划与布局'],['workCharacters','characterBatches','人物判断'],['workEvidence','evidenceBatches','空间资料提取'],['workOutcomes','outcomeBatches','事件结果判断'],['workExtra','extraRequests','整轮额外请求额度']];return `<section class="assignment-row"><div class="assignment-title"><h3>按同类工作分批</h3><button class="action-btn primary" data-save-work-batching>保存工作分批</button></div><p class="scope-note">默认每类 1 批，同批可同时填写多张表、多张地图。填写 3 表示把这类工作分成最多 3 批，每批尽量一次请求；父子地图由程序依次摆放。</p>${fields.map(([id,key,label])=>`<label>${label}${key==='extraRequests'?'（可为 0）':'（批）'}<input id="${id}" type="number" min="${key==='extraRequests'?0:1}" step="1" value="${esc(b[key])}"></label>`).join('')}<p class="scope-note" id="workPlanEstimate">仅地图排版：有资料且需要布局时，正常请求最多 ${b.evidenceBatches+b.mapBatches} 次；建设、人物和事件判断按需另计。</p><span id="workBatchingState" aria-live="polite">${store.workDirty()?'有未保存的分批修改':'使用已保存的工作分批设置'}</span><p class="scope-note">传输重试、格式纠错和补交共用整轮额外额度。容量不足会保留待办并提示增加批数，不连续拆出额外请求。保存后改用批数；旧数量上限不再叠加。</p></section>`;}
 function batchingHTML(){const b=store.batchDraft();return `<section class="assignment-row"><div class="assignment-title"><h3>API 分批设置</h3><button class="action-btn primary" data-save-batching>保存分批设置</button></div><p class="scope-note">旧设置中的数量上限继续保留。总请求上限为 0 时按上方工作计划控制，正整数可进一步限制实际发送次数。</p><label>每批人物上限（0 不限制）<input id="batchCharacters" type="number" min="0" step="1" value="${esc(b.charactersPerBatch)}"></label><label>每批地图上限（0 不限制）<input id="batchMaps" type="number" min="0" step="1" value="${esc(b.mapsPerBatch)}"></label><label>总发送保险上限（0 按工作计划控制）<input id="batchRequests" type="number" min="0" step="1" value="${esc(b.requestsPerOperation)}"></label><span id="batchingSaveState" aria-live="polite">${store.batchingDirty()?'有未保存的分批修改':'使用已保存的分批设置'}</span><p class="scope-note">连接输出容量与数据协议仍有效。新流程按上方工作分批控制请求；此处保留旧配置的数量上限。</p></section>`;}
 function assignmentsHTML(){const doc=store.document;return `<div class="preset-header"><div><h3>按任务组合预设</h3><span>使用已保存的连接和提示词；各项互不影响</span></div></div>${engineStrip()}<div class="assignment-list">${Object.entries(taskNames).map(([id,name])=>{const a=doc.assignments[id];return `<section class="assignment-row"><div class="assignment-title"><h3>${name}</h3><button class="action-btn" data-task-preview="${id}">请求预览</button></div><label>API 连接<select data-binding-task="${id}" data-binding-type="connection" aria-label="${name} API 连接">${options('connection',a.connectionId)}</select></label><label>提示词预设<select data-binding-task="${id}" data-binding-type="prompt" aria-label="${name}提示词预设">${options('prompt',a.promptPresetId)}</select></label></section>`;}).join('')}</div><div class="preset-status-row"><span id="presetSaveState" aria-live="polite">${esc(status())}</span></div><p id="presetError" class="preset-error" role="alert" hidden></p><div class="preset-backup"><h3>全部预设备份</h3><p>包含所有已保存的连接参数、提示词和任务绑定。导入会追加预设，不覆盖现有内容。</p><div class="preset-actions"><button class="action-btn" data-export-presets="all">导出全部预设</button><label class="action-btn preset-import">导入预设<input type="file" data-import-presets accept=".json,application/json"></label></div></div>`;}
 function render(tab){const legacy=$('[data-batch-legacy]');if(legacy)legacyBatchOpen=legacy.open;return tab==='prompts'?promptHTML():tab==='connection'?connectionHTML():assignmentsHTML()+workBatchingHTML()+`<details data-batch-legacy ${legacyBatchOpen?'open':''}><summary>兼容设置与总请求保险上限</summary>${batchingHTML()}</details>`;}
 function afterSave(local){renderPage();toast(local?'预设已保存，刷新后保留':store.status.error,local?'ok':'warn');}
 function closeModal(){$('#demoModal').hidden=true;}
 /**
  * §21.5：**唯一**的预览实现。预览与真实请求共用同一组装函数（服务端 `prepare` +
  * `assemblePromptLayers`），所以这里不自己拼消息；任务用它的真实绑定与真实阶段。
  */
 async function showPreview(task,button){
  const name=taskNames[task]||task;
  if(typeof previewMessages!=='function')throw new Error('当前宿主没有提供请求预览端口，无法核对实际发送内容');
  const label=button?button.textContent:null;if(button){button.disabled=true;button.textContent='正在组装…';}
  try{
   const result=await previewMessages(task);
   const messages=Array.isArray(result?.messages)?result.messages:[];
   const layers=messages.map((message,index)=>({layer:index===0?'固定协议':`用户策略 / 任务`,role:message.role,chars:message.chars??String(message.content||'').length,name:message.name??null,content:message.content}));
   const caps=(result?.capabilities||engine.capabilities||[]);
   modal(name+' · 实际将发送的 messages',`<p class="scope-note">与真实请求同一条组装链（预览与发送共用同一函数）。阶段 ${esc(result?.phase||'—')}；来源 ${esc(result?.promptSource||'—')}；策略版本 ${esc(result?.policyVersion||engine.policyVersion||'未上报')}；程序能力 ${caps.length?caps.map(esc).join('、'):'（无）'}。</p>`
    +`<p class="scope-note">共 ${messages.length} 段：第 1 段是程序固定协议，其后是用户策略段，最后是程序填写的任务上下文。</p>`
    +`<pre>${esc(JSON.stringify(layers,null,2))}</pre>`
    +`<p class="scope-note">预览只读：没有发送模型请求，也没有改动存档或预设。</p>`);
  }catch(failure){error(failure.message);}
  finally{if(button){button.disabled=false;button.textContent=label;}}
 }
 function segment(id){return store.draft('prompt').segments.find(p=>p.id===id);}
 function exportPresets(type){download('atlas-'+(type==='all'?'presets':type+'-preset')+'.json',JSON.stringify(store.exportValue(type),null,2));toast('预设已导出，不含 API Key');}
 async function click(b){
  try{
   for(const [attr,fn] of [['presetNew',t=>store.add(t)],['presetCopy',t=>store.add(t,true)],['presetDiscard',t=>store.discard(t)]])if(b.dataset[attr]){await fn(b.dataset[attr]);renderPage();return true;}
   if(b.dataset.presetRename){const type=b.dataset.presetRename;modal('重命名预设',`<label class="preset-name-field">新名称<input id="presetRenameInput" value="${esc(store.draft(type).name)}"></label><div class="detail-actions"><button class="action-btn primary" data-confirm-rename="${type}">保存名称</button></div>`);$('#presetRenameInput').focus();return true;}
   if(b.dataset.confirmRename){const local=await store.rename(b.dataset.confirmRename,$('#presetRenameInput').value);closeModal();afterSave(local);return true;}
   if(b.dataset.presetDelete){const type=b.dataset.presetDelete;modal('删除预设',`<p class="detail-text">删除「${esc(store.draft(type).name)}」？使用它的任务将改用列表中第一套预设。</p><div class="detail-actions"><button class="action-btn danger" data-confirm-delete="${type}">确认删除</button><button class="action-btn" data-cancel-preset>取消</button></div>`);return true;}
   if(b.dataset.confirmDelete){await store.remove(b.dataset.confirmDelete);closeModal();renderPage();toast('预设已删除，任务引用已更新');return true;}
   if(b.hasAttribute('data-cancel-preset')){pendingImport=null;closeModal();return true;}
   if(b.dataset.exportPresets){exportPresets(b.dataset.exportPresets);return true;}
   if(b.hasAttribute('data-confirm-import')){if(!pendingImport)return true;const result=await store.importValue(pendingImport);pendingImport=null;closeModal();renderPage();toast(`已追加 ${result.connections} 套 API、${result.prompts} 套提示词预设`);return true;}
   if(b.hasAttribute('data-save-prompts')){afterSave(await store.save('prompt'));return true;}
   if(b.hasAttribute('data-save-connection')){afterSave(await store.save('connection'));return true;}
   if(b.hasAttribute('data-save-work-batching')){const saved=await store.saveWorkBatching();renderPage();toast(saved?'工作分批设置已保存':store.status.error,saved?'ok':'warn');return true;}
   if(b.hasAttribute('data-save-batching')){const saved=await store.saveBatching();renderPage();toast(saved?'分批设置已保存':store.status.error,saved?'ok':'warn');return true;}
   if(b.hasAttribute('data-fetch-models')){
    const draft=store.draft('connection'),identity=draft.id; b.disabled=true;b.textContent='正在获取…';
    try{const models=await fetchModels({...draft});if(store.draft('connection').id!==identity)return true;
      modal('选择模型',`<p class="scope-note">已获取 ${models.length} 个模型，选择后可保存连接。</p><div class="assignment-list">${models.map(id=>`<button class="action-btn" data-select-model="${esc(id)}">${esc(id)}</button>`).join('')}</div>`);
    }finally{b.disabled=false;b.textContent='获取模型';}return true;
   }
   if(b.hasAttribute('data-select-model')){store.draft('connection').model=b.dataset.selectModel;closeModal();renderPage();return true;}
   if(b.hasAttribute('data-key-toggle')){const field=$('#connectionKey'),visible=field.type==='password';field.type=visible?'text':'password';b.textContent=visible?'隐藏':'显示';b.setAttribute('aria-label',visible?'隐藏 API Key':'显示 API Key');return true;}
   if(b.hasAttribute('data-prompt-preview')){
    // 草稿未保存时不许拿草稿冒充「将发送的内容」：真实发送读的是**已保存**的预设。
    if(store.dirty('prompt'))toast('当前预设仍有未保存的修改；下面显示的是已保存版本将发送的内容','warn');
    await showPreview('advance',b);return true;
   }
   if(b.dataset.taskPreview){await showPreview(b.dataset.taskPreview,b);return true;}
   if(b.hasAttribute('data-adopt-suggested')){
    // 内置建议预设**只作为另一套预设另存**：不动当前预设、不动任务绑定。
    const suggested=engine.suggested;if(!suggested?.segments?.length)throw new Error('宿主没有上报内置建议策略内容');
    await store.add('prompt');
    const draft=store.draft('prompt');
    draft.name=`${suggested.name}（${suggested.version}）· 我的副本`.slice(0,120);
    draft.segments=suggested.segments.map(segment=>({id:store.uid('segment'),name:String(segment.name||'策略段').slice(0,120),role:['system','user','assistant'].includes(segment.role)?segment.role:'system',enabled:segment.enabled!==false,content:String(segment.content||'')}));
    afterSave(await store.save('prompt'));
    return true;
   }
   if(b.hasAttribute('data-insert-prompt')){const list=store.draft('prompt').segments;list.splice(+b.dataset.insertPrompt,0,{id:store.uid('segment'),name:'新提示词段',role:'system',enabled:true,content:''});renderPage();return true;}
   for(const action of ['up','down','copy','delete'])if(b.hasAttribute('data-prompt-'+action)){
    const list=store.draft('prompt').segments,index=list.findIndex(s=>s.id===b.getAttribute('data-prompt-'+action));if(index<0)return true;
    if(action==='up'&&index>0)[list[index-1],list[index]]=[list[index],list[index-1]];
    if(action==='down'&&index<list.length-1)[list[index+1],list[index]]=[list[index],list[index+1]];
    if(action==='copy'){list.splice(index+1,0,{...list[index],id:store.uid('segment'),name:list[index].name+' · 副本'});}
    if(action==='delete')list.splice(index,1);renderPage();return true;
   }
  }catch(e){error(e.message);return true;}
  return false;
 }
 function input(el){
  if(['workMaps','workCharacters','workEvidence','workOutcomes','workExtra'].includes(el.id)){store.workDraft()[{workMaps:'mapBatches',workCharacters:'characterBatches',workEvidence:'evidenceBatches',workOutcomes:'outcomeBatches',workExtra:'extraRequests'}[el.id]]=el.value===''?NaN:Number(el.value);const status=$('#workBatchingState');if(status)status.textContent='有未保存的分批修改';return true;}
  if(['batchCharacters','batchMaps','batchRequests'].includes(el.id)){store.batchDraft()[{batchCharacters:'charactersPerBatch',batchMaps:'mapsPerBatch',batchRequests:'requestsPerOperation'}[el.id]]=el.value===''?NaN:Number(el.value);const status=$('#batchingSaveState');if(status)status.textContent='有未保存的分批修改';return true;}
  if(el.dataset.promptName){segment(el.dataset.promptName).name=el.value;refreshStatus('prompt');return true;}
  if(el.dataset.promptContent){segment(el.dataset.promptContent).content=el.value;refreshStatus('prompt');return true;}
  if(el.id==='promptPresetName'){store.draft('prompt').name=el.value;refreshStatus('prompt');return true;}
  const fields={connectionName:'name',connectionUrl:'url',connectionModel:'model',connectionKey:'apiKey',connectionTemperature:'temperature',connectionTokens:'maxTokens',connectionTimeout:'timeoutMs'};
  if(fields[el.id]){store.draft('connection')[fields[el.id]]=['connectionTemperature','connectionTokens','connectionTimeout'].includes(el.id)?el.value===''?NaN:Number(el.value):el.value;refreshStatus('connection');return true;}
  return false;
 }
 async function change(el){
  try{
   if(el.dataset.presetSelect){await store.switchTo(el.dataset.presetSelect,el.value);renderPage();return true;}
   if(el.dataset.bindingTask){await store.assign(el.dataset.bindingTask,el.dataset.bindingType,el.value);refreshStatus();return true;}
   if(el.dataset.promptRole){segment(el.dataset.promptRole).role=el.value;refreshStatus('prompt');return true;}
   if(el.dataset.promptEnabled){segment(el.dataset.promptEnabled).enabled=el.checked;refreshStatus('prompt');return true;}
   if(el.id==='connectionProvider'){store.draft('connection').provider=el.value;renderPage();return true;}
   if(el.id==='connectionRememberKey'){store.draft('connection').rememberKey=el.checked;refreshStatus('connection');return true;}
   if(el.id==='connectionToolCalling'){store.draft('connection').toolCalling=el.checked;refreshStatus('connection');return true;}
   if(el.hasAttribute('data-import-presets')){
    const file=el.files?.[0];if(!file)return true;
    let raw;try{raw=JSON.parse(await file.text());}catch(e){throw new Error('文件不是合法的 JSON，未修改任何预设');}
    pendingImport=store.parseImport(raw);const data=pendingImport;
    modal('确认导入预设',`<p class="detail-text">追加 ${data.connections.length} 套 API 连接和 ${data.promptPresets.length} 套提示词预设。现有预设与未保存草稿保留，同名预设自动更名；API Key 不导入。${data.kind==='atlas-ui-presets'?'任务绑定将使用导入的组合。':''}</p><div class="import-name-list">${[...data.connections,...data.promptPresets].map(p=>`<span>${esc(p.name)}</span>`).join('')}</div><div class="detail-actions"><button class="action-btn primary" data-confirm-import>追加导入</button><button class="action-btn" data-cancel-preset>取消</button></div>`);el.value='';return true;
   }
  }catch(e){pendingImport=null;error(e.message);if(el.hasAttribute('data-import-presets'))el.value='';return true;}
  return false;
 }
 return {captureState:()=>{const legacy=$('[data-batch-legacy]');if(legacy)legacyBatchOpen=legacy.open;},render,click,input,change};
}
global.AtlasPresetUI={create};
})(window);
