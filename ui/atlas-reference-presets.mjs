/** Translate the supplied editor to existing settings commands, preserving extension fields. */
const clone = value => JSON.parse(JSON.stringify(value));
const pair = (connectionId,promptPresetId) => ({connectionId,promptPresetId});
export function referencePresetDocument(settings={},preferences={},defaultPrompt='') {
  const connections=(settings.apiPresets??[]).map(c=>({id:c.id,name:c.name,provider:c.connectionMode==='main'||c.connectionMode==='profile'?'sillytavern':'openai-compatible',
    toolCalling:c.toolCalling===true,url:c.endpoint??'',model:c.model??'',temperature:c.temperature??0.7,maxTokens:c.maxTokens??8192,timeoutMs:c.timeoutMs??60000,rememberKey:!!c.apiKey,apiKey:c.apiKey??''}));
  if(!connections.length)connections.push({id:'reference-unconfigured',name:'尚未配置连接',provider:'openai-compatible',url:'',model:'',temperature:0.7,maxTokens:8192,rememberKey:false});
  const promptPresets=(settings.promptPresets??[]).map(p=>({id:p.id,name:p.name,segments:(p.segments?.length?p.segments:[{role:'system',name:'系统提示词',content:p.systemPrompt,enabled:true}]).map((s,i)=>({...s,id:`segment-${i}`,name:s.name??`第 ${i+1} 段`,enabled:s.enabled!==false}))}));
  if(!promptPresets.length){const builtin=settings.builtInSqlPrompt??settings.builtInPrompt;promptPresets.push({id:'reference-default-prompt',name:'内置默认提示词 · 可另存',segments:(builtin?.segments?.length?builtin.segments:[{name:'世界推演',role:'system',content:defaultPrompt}]).map((s,i)=>({...s,id:`segment-${i}`,name:s.name||`第 ${i+1} 段`,enabled:s.enabled!==false}))});}
  // Unsaved drafts belong to the editor. Saved settings remain the authoritative library.
  for(const c of preferences.drafts?.connections??[])if(!connections.some(x=>x.id===c.id))connections.push({...c,apiKey:''});
  for(const p of preferences.drafts?.promptPresets??[])if(!promptPresets.some(x=>x.id===p.id))promptPresets.push(clone(p));
  const existingC=new Set(connections.map(x=>x.id)),existingP=new Set(promptPresets.map(x=>x.id));
  const fallback=pair(existingC.has(settings.activeApiPresetId)?settings.activeApiPresetId:connections[0].id,existingP.has(settings.activePromptPresetId)?settings.activePromptPresetId:promptPresets[0].id);
  const assignments={};for(const task of ['initialize','advance','repair']){const saved=preferences.assignments?.[task];assignments[task]=saved&&existingC.has(saved.connectionId)&&existingP.has(saved.promptPresetId)?clone(saved):clone(fallback);}
  const active=preferences.active&&existingC.has(preferences.active.connectionId)&&existingP.has(preferences.active.promptPresetId)?clone(preferences.active):fallback;
  return {kind:'atlas-ui-presets',version:1,connections,promptPresets,active,assignments};
}

export function referenceSettingsCommands(doc,settings={},action={}) {
  const commands=[];
  const selected=action.type==='connection'?doc.connections.find(x=>x.id===action.id):doc.promptPresets.find(x=>x.id===action.id);
  if(action.kind==='save'&&!selected)throw Error('预设不存在');
  function connection(c){
    if(c.id==='reference-unconfigured'&&c.provider!=='sillytavern'&&!c.url&&!c.model)throw Error('请先填写 API 地址与模型，或选择酒馆主 API。');
    const old=settings.apiPresets?.find(x=>x.id===c.id)??{};
    const connectionMode=c.provider==='sillytavern'?(old.connectionMode==='profile'?'profile':'main'):'custom';
    const preset={...old,id:c.id,name:c.name,connectionMode,endpoint:c.url,model:c.model,toolCalling:c.toolCalling===true,temperature:c.temperature,maxTokens:c.maxTokens,topP:old.topP??1,timeoutMs:c.timeoutMs??old.timeoutMs??60000};
    delete preset.apiKey;delete preset.hasApiKey;delete preset.apiKeyLast4;
    const key=c.rememberKey?c.apiKey??'':'';
    commands.push({action:'api.save',create:!old.id,preset,apiKeyMode:old.id&&key===old.apiKey?'keep':key?'replace':'clear',...(key?{apiKey:key}:{})});
  }
  function prompt(p){
    if(p.segments.length>16)throw Error('插件最多支持 16 段提示词；未保存，原预设保留。');
    if(p.segments.some(s=>s.content.length>8000))throw Error('每段提示词最多 8000 字；未保存，原预设保留。');
    const old=settings.promptPresets?.find(x=>x.id===p.id)??{};
    commands.push({action:'prompt.save',create:!old.id,preset:{...old,id:p.id,name:p.name,systemPrompt:'',segments:p.segments.map(({id,...s})=>s),contextTurnCount:old.contextTurnCount??3}});
  }
  if(action.kind==='save')action.type==='connection'?connection(selected):prompt(selected);
  if(action.kind==='import') { for(const c of doc.connections)if(!(settings.apiPresets??[]).some(x=>x.id===c.id)&&(c.provider==='sillytavern'||c.url&&c.model))connection(c);for(const p of doc.promptPresets)if(!(settings.promptPresets??[]).some(x=>x.id===p.id)&&p.segments.some(s=>s.content.trim()))prompt(p); }
  if(action.kind==='delete'&&(action.type==='connection'?settings.apiPresets:settings.promptPresets)?.some(x=>x.id===action.id))commands.push({action:action.type==='connection'?'api.delete':'prompt.delete',id:action.id});
  const advance=doc.assignments.advance;
  const hasC=(settings.apiPresets??[]).some(x=>x.id===advance.connectionId)||commands.some(x=>x.action==='api.save'&&x.preset.id===advance.connectionId);
  const hasP=(settings.promptPresets??[]).some(x=>x.id===advance.promptPresetId)||commands.some(x=>x.action==='prompt.save'&&x.preset.id===advance.promptPresetId);
  if(hasC&&settings.activeApiPresetId!==advance.connectionId)commands.push({action:'api.activate',id:advance.connectionId});
  if(hasP&&settings.activePromptPresetId!==advance.promptPresetId)commands.push({action:'prompt.activate',id:advance.promptPresetId});
  return commands;
}
