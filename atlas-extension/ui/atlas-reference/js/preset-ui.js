/* Preset editor, scoped to the ATLAS prototype root. No model requests. */
(function(global){
'use strict';
function create({root,store,esc,toast,diagnostic,modal,renderPage,download}){
 const $=selector=>root.querySelector(selector);
 const taskNames={initialize:'地图初始化',advance:'每轮世界推演',repair:'失败组纠错'};
 let pendingImport=null;
 function options(type,selected){const list=type==='connection'?store.document.connections:store.document.promptPresets;return list.map(p=>`<option value="${esc(p.id)}" ${p.id===selected?'selected':''}>${esc(p.name)}</option>`).join('');}
 function status(type){
  if(type&&store.dirty(type))return '有未保存的修改 · 切换时保留草稿';
  const s=store.status;return s.error||s.loadError||(s.mode==='local'?'已保存 · 刷新后保留':'本次页面保留 · 可导出备份');
 }
 function refreshStatus(type){const el=$('#presetSaveState');if(el){el.textContent=status(type);el.classList.toggle('unsaved',!!type&&store.dirty(type));}const discard=$('[data-preset-discard]');if(discard)discard.disabled=!store.dirty(discard.dataset.presetDiscard);const err=$('#presetError');if(err){err.textContent='';err.hidden=true;}}
 function error(message){const el=$('#presetError');if(el){el.textContent=message;el.hidden=false;}if(!$('#demoModal').hidden){let warning=$('#modalBody .preset-error');if(!warning){warning=document.createElement('p');warning.className='preset-error';warning.setAttribute('role','alert');$('#modalBody').append(warning);}warning.textContent=message;}toast(message,'warn');diagnostic('warn','PRESET_VALIDATION_FAILED',message);}
 function controls(type){const d=store.draft(type),doc=store.document,list=type==='connection'?doc.connections:doc.promptPresets,label=type==='connection'?'API 连接预设':'提示词预设';return `<div class="preset-selector-row"><label class="preset-selector">当前${label}<select data-preset-select="${type}" aria-label="当前${label}">${options(type,d.id)}</select></label><span class="preset-total">${list.length} 套</span></div><div class="preset-actions"><button class="action-btn" data-preset-new="${type}" ${list.length>=50?'disabled':''}>新建</button><button class="action-btn" data-preset-copy="${type}" ${list.length>=50?'disabled':''}>复制为新预设</button><button class="action-btn" data-preset-rename="${type}">重命名</button><button class="action-btn danger" data-preset-delete="${type}" ${list.length<=1?'disabled':''}>删除</button><button class="action-btn" data-export-presets="${type}">导出这一套</button><label class="action-btn preset-import">导入预设<input type="file" data-import-presets accept=".json,application/json"></label></div><div class="preset-status-row"><span id="presetSaveState" class="${store.dirty(type)?'unsaved':''}" aria-live="polite">${esc(status(type))}</span><button class="text-btn" data-preset-discard="${type}" ${store.dirty(type)?'':'disabled'}>恢复已保存</button></div><p id="presetError" class="preset-error" role="alert" hidden></p>`;}
 function promptHTML(){const p=store.draft('prompt');return controls('prompt')+`<label class="preset-name-field">预设名称<input id="promptPresetName" value="${esc(p.name)}" maxlength="120"></label><div class="preset-header"><div><h3>多角色提示词</h3><span>每段独立设置角色与内容，按显示顺序发送</span></div><button class="action-btn" data-prompt-preview>请求预览</button><button class="action-btn primary" data-save-prompts>保存预设</button></div><button class="insert-prompt" data-insert-prompt="0" ${p.segments.length>=64?'disabled':''}>＋ 在最上方插入一段</button><div class="prompt-stack">${p.segments.map((s,i)=>`<article class="prompt-segment" data-prompt-id="${esc(s.id)}"><header><span class="segment-index">${String(i+1).padStart(2,'0')}</span><input value="${esc(s.name)}" maxlength="120" data-prompt-name="${esc(s.id)}" aria-label="提示词名称"><select data-prompt-role="${esc(s.id)}" aria-label="提示词角色">${['system','user','assistant'].map(r=>`<option ${r===s.role?'selected':''}>${r}</option>`).join('')}</select><label class="segment-enabled"><input type="checkbox" data-prompt-enabled="${esc(s.id)}" ${s.enabled?'checked':''}>启用</label></header><textarea data-prompt-content="${esc(s.id)}" maxlength="65536" aria-label="${esc(s.name)}内容">${esc(s.content)}</textarea><footer><button class="text-btn" data-prompt-up="${esc(s.id)}" ${i===0?'disabled':''}>上移</button><button class="text-btn" data-prompt-down="${esc(s.id)}" ${i===p.segments.length-1?'disabled':''}>下移</button><button class="text-btn" data-prompt-copy="${esc(s.id)}" ${p.segments.length>=64?'disabled':''}>复制</button><button class="text-btn danger" data-prompt-delete="${esc(s.id)}">删除</button></footer></article><button class="insert-prompt" data-insert-prompt="${i+1}" ${p.segments.length>=64?'disabled':''}>＋ 在这里插入一段</button>`).join('')}</div><div class="settings-foot"><span>草稿独立保留；点击保存后可在下次打开时使用。</span></div>`;}
 function connectionHTML(){const c=store.draft('connection');return controls('connection')+`<div class="connection-form"><label>连接名称<input id="connectionName" maxlength="120" value="${esc(c.name)}"></label><label>连接方式<select id="connectionProvider"><option value="openai-compatible" ${c.provider==='openai-compatible'?'selected':''}>自定义 / OpenAI 兼容接口</option><option value="sillytavern" ${c.provider==='sillytavern'?'selected':''}>使用酒馆当前连接</option></select></label><label>API 地址<input id="connectionUrl" maxlength="2048" placeholder="https://api.example.com/v1" value="${esc(c.url)}" ${c.provider==='sillytavern'?'disabled':''}></label><label>模型<input id="connectionModel" maxlength="200" placeholder="输入模型名称" value="${esc(c.model)}" ${c.provider==='sillytavern'?'disabled':''}></label><label>API Key<span class="key-field"><input id="connectionKey" type="password" maxlength="4096" autocomplete="off" value="${esc(c.apiKey)}" placeholder="留空可先保存连接草稿" ${c.provider==='sillytavern'?'disabled':''}><button type="button" class="text-btn" data-key-toggle aria-label="显示 API Key">显示</button></span></label><label class="remember-key"><input id="connectionRememberKey" type="checkbox" ${c.rememberKey?'checked':''}><span>在此浏览器记住 Key</span></label><p class="scope-note">默认仅在本次页面保留 Key；勾选后保存在当前浏览器。导出文件始终不含 Key。</p><div class="connection-fields"><label>温度<input id="connectionTemperature" type="number" min="0" max="2" step="0.1" value="${esc(c.temperature)}"></label><label>输出上限<input id="connectionTokens" type="number" min="1" max="65536" step="1" value="${esc(c.maxTokens)}"></label></div><button class="action-btn primary" data-save-connection>保存 API 预设</button><p class="scope-note">保存后由插件使用此连接进行世界推演。</p><details class="connection-summary"><summary>查看已保存的连接配置</summary><pre id="connectionPreview">${esc(JSON.stringify(Object.fromEntries(Object.entries(store.document.connections.find(p=>p.id===c.id)).filter(([key])=>key!=='rememberKey')),null,2))}</pre></details></div>`;}
 function assignmentsHTML(){const doc=store.document;return `<div class="preset-header"><div><h3>按任务组合预设</h3><span>使用已保存的连接和提示词；各项互不影响</span></div></div><div class="assignment-list">${Object.entries(taskNames).map(([id,name])=>{const a=doc.assignments[id];return `<section class="assignment-row"><div class="assignment-title"><h3>${name}</h3><button class="action-btn" data-task-preview="${id}">请求预览</button></div><label>API 连接<select data-binding-task="${id}" data-binding-type="connection" aria-label="${name} API 连接">${options('connection',a.connectionId)}</select></label><label>提示词预设<select data-binding-task="${id}" data-binding-type="prompt" aria-label="${name}提示词预设">${options('prompt',a.promptPresetId)}</select></label></section>`;}).join('')}</div><div class="preset-status-row"><span id="presetSaveState" aria-live="polite">${esc(status())}</span></div><p id="presetError" class="preset-error" role="alert" hidden></p><div class="preset-backup"><h3>全部预设备份</h3><p>包含所有已保存的连接参数、提示词和任务绑定。导入会追加预设，不覆盖现有内容。</p><div class="preset-actions"><button class="action-btn" data-export-presets="all">导出全部预设</button><label class="action-btn preset-import">导入预设<input type="file" data-import-presets accept=".json,application/json"></label></div></div>`;}
 function render(tab){return tab==='prompts'?promptHTML():tab==='connection'?connectionHTML():assignmentsHTML();}
 function afterSave(local){renderPage();toast(local?'预设已保存，刷新后保留':store.status.error,local?'ok':'warn');}
 function closeModal(){$('#demoModal').hidden=true;}
 function segment(id){return store.draft('prompt').segments.find(p=>p.id===id);}
 function exportPresets(type){download('atlas-'+(type==='all'?'presets':type+'-preset')+'.json',JSON.stringify(store.exportValue(type),null,2));toast('预设已导出，不含 API Key');}
 async function click(b){
  try{
   for(const [attr,fn] of [['presetNew',t=>store.add(t)],['presetCopy',t=>store.add(t,true)],['presetDiscard',t=>store.discard(t)]])if(b.dataset[attr]){await fn(b.dataset[attr]);renderPage();return true;}
   if(b.dataset.presetRename){const type=b.dataset.presetRename;modal('重命名预设',`<label class="preset-name-field">新名称<input id="presetRenameInput" maxlength="120" value="${esc(store.draft(type).name)}"></label><div class="detail-actions"><button class="action-btn primary" data-confirm-rename="${type}">保存名称</button></div>`);$('#presetRenameInput').focus();return true;}
   if(b.dataset.confirmRename){const local=await store.rename(b.dataset.confirmRename,$('#presetRenameInput').value);closeModal();afterSave(local);return true;}
   if(b.dataset.presetDelete){const type=b.dataset.presetDelete;modal('删除预设',`<p class="detail-text">删除「${esc(store.draft(type).name)}」？使用它的任务将改用列表中第一套预设。</p><div class="detail-actions"><button class="action-btn danger" data-confirm-delete="${type}">确认删除</button><button class="action-btn" data-cancel-preset>取消</button></div>`);return true;}
   if(b.dataset.confirmDelete){await store.remove(b.dataset.confirmDelete);closeModal();renderPage();toast('预设已删除，任务引用已更新');return true;}
   if(b.hasAttribute('data-cancel-preset')){pendingImport=null;closeModal();return true;}
   if(b.dataset.exportPresets){exportPresets(b.dataset.exportPresets);return true;}
   if(b.hasAttribute('data-confirm-import')){if(!pendingImport)return true;const result=await store.importValue(pendingImport);pendingImport=null;closeModal();renderPage();toast(`已追加 ${result.connections} 套 API、${result.prompts} 套提示词预设`);return true;}
   if(b.hasAttribute('data-save-prompts')){afterSave(await store.save('prompt'));return true;}
   if(b.hasAttribute('data-save-connection')){afterSave(await store.save('connection'));return true;}
   if(b.hasAttribute('data-key-toggle')){const field=$('#connectionKey'),visible=field.type==='password';field.type=visible?'text':'password';b.textContent=visible?'隐藏':'显示';b.setAttribute('aria-label',visible?'隐藏 API Key':'显示 API Key');return true;}
   if(b.hasAttribute('data-prompt-preview')){const p=store.draft('prompt');modal('提示词草稿 · 最终 messages',`<p class="scope-note">仅包含启用的段落。变量由插件在请求时替换。</p><pre>${esc(JSON.stringify(p.segments.filter(s=>s.enabled).map(s=>({role:s.role,content:s.content})),null,2))}</pre>`);return true;}
   if(b.dataset.taskPreview){modal(taskNames[b.dataset.taskPreview]+' · 已保存的请求配置',`<pre>${esc(JSON.stringify(store.resolve(b.dataset.taskPreview),null,2))}</pre>`);return true;}
   if(b.hasAttribute('data-insert-prompt')){const list=store.draft('prompt').segments;if(list.length>=64)throw new Error('每套提示词最多包含 64 段');list.splice(+b.dataset.insertPrompt,0,{id:store.uid('segment'),name:'新提示词段',role:'system',enabled:true,content:''});renderPage();return true;}
   for(const action of ['up','down','copy','delete'])if(b.hasAttribute('data-prompt-'+action)){
    const list=store.draft('prompt').segments,index=list.findIndex(s=>s.id===b.getAttribute('data-prompt-'+action));if(index<0)return true;
    if(action==='up'&&index>0)[list[index-1],list[index]]=[list[index],list[index-1]];
    if(action==='down'&&index<list.length-1)[list[index+1],list[index]]=[list[index],list[index+1]];
    if(action==='copy'){if(list.length>=64)throw new Error('每套提示词最多包含 64 段');list.splice(index+1,0,{...list[index],id:store.uid('segment'),name:list[index].name.slice(0,110)+' · 副本'});}
    if(action==='delete')list.splice(index,1);renderPage();return true;
   }
  }catch(e){error(e.message);return true;}
  return false;
 }
 function input(el){
  if(el.dataset.promptName){segment(el.dataset.promptName).name=el.value;refreshStatus('prompt');return true;}
  if(el.dataset.promptContent){segment(el.dataset.promptContent).content=el.value;refreshStatus('prompt');return true;}
  if(el.id==='promptPresetName'){store.draft('prompt').name=el.value;refreshStatus('prompt');return true;}
  const fields={connectionName:'name',connectionUrl:'url',connectionModel:'model',connectionKey:'apiKey',connectionTemperature:'temperature',connectionTokens:'maxTokens'};
  if(fields[el.id]){store.draft('connection')[fields[el.id]]=['connectionTemperature','connectionTokens'].includes(el.id)?el.value===''?NaN:Number(el.value):el.value;refreshStatus('connection');return true;}
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
   if(el.hasAttribute('data-import-presets')){
    const file=el.files?.[0];if(!file)return true;if(file.size>store.limits.bytes)throw new Error('导入文件不能超过 1.5 MB');
    let raw;try{raw=JSON.parse(await file.text());}catch(e){throw new Error('文件不是合法的 JSON，未修改任何预设');}
    pendingImport=store.parseImport(raw);const data=pendingImport;
    modal('确认导入预设',`<p class="detail-text">追加 ${data.connections.length} 套 API 连接和 ${data.promptPresets.length} 套提示词预设。现有预设与未保存草稿保留，同名预设自动更名；API Key 不导入。${data.kind==='atlas-ui-presets'?'任务绑定将使用导入的组合。':''}</p><div class="import-name-list">${[...data.connections,...data.promptPresets].map(p=>`<span>${esc(p.name)}</span>`).join('')}</div><div class="detail-actions"><button class="action-btn primary" data-confirm-import>追加导入</button><button class="action-btn" data-cancel-preset>取消</button></div>`);el.value='';return true;
   }
  }catch(e){pendingImport=null;error(e.message);if(el.hasAttribute('data-import-presets'))el.value='';return true;}
  return false;
 }
 return {render,click,input,change};
}
global.AtlasPresetUI={create};
})(window);
