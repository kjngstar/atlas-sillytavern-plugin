/* UI-only preset repository. It never reads or writes the demonstration world. */
(function(global){
'use strict';
const STORAGE_KEY='atlas.ui-demo.presets.v1';
const TASKS=['initialize','advance','repair'];
const LIMITS={presets:50,segments:64,content:65536,bytes:1500000};
const clone=value=>JSON.parse(JSON.stringify(value));
let serial=0;
function uid(prefix){return prefix+'-'+(global.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+(++serial));}
function fail(message){throw new Error(message);}
function text(value,label,max,empty=false){
 if(typeof value!=='string'||value.length>max||(!empty&&!value.trim()))fail(label+'不能为空或超过长度限制');
 return empty?value:value.trim();
}
function identity(value){if(typeof value!=='string'||!/^[a-zA-Z0-9:_-]{1,128}$/.test(value))fail('预设标识不合法');return value;}
function segments(list){
 if(!Array.isArray(list)||list.length>LIMITS.segments)fail('每套提示词最多包含 64 段');
 const ids=new Set();return list.map(p=>{
  if(!p||typeof p!=='object')fail('提示词段不是有效对象');
  const id=identity(p.id);if(ids.has(id))fail('提示词段标识重复');ids.add(id);
  if(!['system','user','assistant'].includes(p.role)||typeof p.enabled!=='boolean')fail('提示词角色或启用状态不合法');
  return {...p,id,name:text(p.name,'段落名称',120),role:p.role,enabled:p.enabled,content:text(p.content,'提示词内容',LIMITS.content,true)};
 });
}
function prompt(p){if(!p||typeof p!=='object')fail('提示词预设不是有效对象');return {id:identity(p.id),name:text(p.name,'预设名称',120),segments:segments(p.segments)};}
function connection(c,keepKey=false){
 if(!c||typeof c!=='object')fail('API 预设不是有效对象');
 const url=text(c.url,'API 地址',2048,true).trim();
 if(url){try{const parsed=new URL(url);if(!['https:','http:'].includes(parsed.protocol)||parsed.username||parsed.password)fail('API 地址需为不含账号密码的 http / https 地址');}catch(e){fail('API 地址需为不含账号密码的 http / https 地址');}}
 if(!['openai-compatible','sillytavern'].includes(c.provider))fail('连接方式不支持');
 if(typeof c.temperature!=='number'||!Number.isFinite(c.temperature)||c.temperature<0||c.temperature>2)fail('温度必须介于 0 和 2');
 if(!Number.isInteger(c.maxTokens)||c.maxTokens<1||c.maxTokens>65536)fail('输出上限必须是 1 至 65536 的整数');
 const timeoutMs=c.timeoutMs??60000;
 if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>1200000)fail('请求超时必须是 1000 至 1200000 毫秒的整数');
 const out={toolCalling:c.toolCalling===true,id:identity(c.id),name:text(c.name,'连接名称',120),provider:c.provider,url,model:text(c.model,'模型名称',200,true).trim(),temperature:c.temperature,maxTokens:c.maxTokens,timeoutMs,rememberKey:keepKey&&c.rememberKey===true};
 if(keepKey&&out.rememberKey)out.apiKey=text(c.apiKey||'','API Key',4096,true);
 return out;
}
function uniqueRows(rows,validator,label){
 if(!Array.isArray(rows)||rows.length>LIMITS.presets)fail(label+'最多保存 50 套');
 const seen=new Set();return rows.map(row=>{const result=validator(row);if(seen.has(result.id))fail(label+'标识重复');seen.add(result.id);return result;});
}
function validateDoc(value,keepKey=false){
 if(!value||value.kind!=='atlas-ui-presets'||value.version!==1)fail('预设文件格式或版本不支持');
 const connections=uniqueRows(value.connections,c=>connection(c,keepKey),'API 预设');
 const promptPresets=uniqueRows(value.promptPresets,prompt,'提示词预设');
 if(!connections.length||!promptPresets.length)fail('至少保留一套 API 和一套提示词预设');
 const hasC=id=>connections.some(c=>c.id===id),hasP=id=>promptPresets.some(p=>p.id===id);
 function pair(p){if(!p||!hasC(p.connectionId)||!hasP(p.promptPresetId))fail('任务绑定或当前预设引用了不存在的预设');return {connectionId:p.connectionId,promptPresetId:p.promptPresetId};}
 const active=pair(value.active),assignments={};for(const task of TASKS)assignments[task]=pair(value.assignments?.[task]);
 return {kind:'atlas-ui-presets',version:1,connections,promptPresets,active,assignments};
}
function bytes(value){return new TextEncoder().encode(JSON.stringify(value)).byteLength;}
function bounded(value){if(bytes(value)>LIMITS.bytes)fail('预设配置超过 1.5 MB，请减少段落或拆分文件');return value;}
function publicDoc(doc){return validateDoc(doc,false);}
function blankConnection(id,name){return {id,name,provider:'openai-compatible',url:'',model:'',temperature:0.7,maxTokens:8192,rememberKey:false};}
function defaults(seed){
 const connections=[blankConnection('connection-default','自定义服务商')];
 const promptPresets=[
  {id:'prompt-world',name:'世界推演',segments:segments(clone(seed))},
  {id:'prompt-map',name:'地图初始化',segments:[
   {id:'map-system',name:'地图职责',role:'system',enabled:true,content:'根据提供的世界资料与当前场景整理地点层级。区分包含、相邻和移动载具关系，保持稳定的实体标识。'},
   {id:'map-input',name:'地图资料',role:'user',enabled:true,content:'世界资料：{{worldInfo}}\n当前场景：{{scene}}'},
   {id:'map-output',name:'数据输出',role:'system',enabled:true,content:'按已选择的插件协议提交增量变更。位置推断保留依据与不确定性，不把估计当成正文事实。'}]},
  {id:'prompt-repair',name:'失败纠错',segments:[
   {id:'repair-system',name:'纠错职责',role:'system',enabled:true,content:'只修复给出的失败变更及其依赖。保留已成功提交的内容，不重复推进时间。'},
   {id:'repair-input',name:'失败组与诊断',role:'user',enabled:true,content:'失败变更：{{failedEdits}}\n完整诊断：{{diagnostics}}\n当前状态：{{worldContext}}'}]}
 ];
 const active={connectionId:connections[0].id,promptPresetId:promptPresets[0].id};
 const assignments={initialize:{connectionId:active.connectionId,promptPresetId:'prompt-map'},advance:clone(active),repair:{connectionId:active.connectionId,promptPresetId:'prompt-repair'}};
 return {kind:'atlas-ui-presets',version:1,connections,promptPresets,active,assignments};
}
function create(seed,options={}){
 let doc=defaults(seed),storage=null,storageMode='session',storageError='',loadError='';
 const drafts={connections:new Map(),promptPresets:new Map()},keys=new Map();
 try{
  storage=Object.hasOwn(options,'storage')?options.storage:global.localStorage;
  if(storage){const raw=storage.getItem(STORAGE_KEY);if(raw){if(new TextEncoder().encode(raw).byteLength>LIMITS.bytes)fail('已保存的预设过大');doc=validateDoc(JSON.parse(raw),true);}storageMode='local';}
 }catch(error){if(storage)loadError='已保存的配置无法读取，当前使用内置预设';else storageError='浏览器不允许本地保存，配置仅在本次页面保留；可导出备份';storageMode=storage?'local':'session';}
 doc.connections.forEach(c=>{if(c.apiKey)keys.set(c.id,c.apiKey);});
 function listName(type){if(type==='connection')return 'connections';if(type==='prompt')return 'promptPresets';fail('预设类型不支持');}
 function activeKey(type){return type==='connection'?'connectionId':'promptPresetId';}
 function saved(type,id=doc.active[activeKey(type)]){return doc[listName(type)].find(p=>p.id===id)||null;}
 function draft(type,id=doc.active[activeKey(type)]){
  const name=listName(type),row=saved(type,id);if(!row)fail('预设不存在');
  if(!drafts[name].has(id)){const value=clone(row);if(type==='connection')value.apiKey=keys.get(id)||row.apiKey||'';drafts[name].set(id,value);}
  return drafts[name].get(id);
 }
 if(options.initialDocument)doc=validateDoc(clone(options.initialDocument),true);doc.connections.forEach(c=>{if(c.apiKey)keys.set(c.id,c.apiKey);});let committed=clone(doc);
 function persisted(){return bounded(validateDoc(doc,true));}
 async function persist(action={kind:'selection'}){if(options.onPersist){try{const value=persisted();value.connections.forEach(c=>{c.apiKey=keys.get(c.id)||c.apiKey||'';});await options.onPersist(value,action);committed=clone(doc);storageMode='local';storageError='';return true;}catch(error){doc=clone(committed);storageError=error.message;throw error;}}
  try{if(!storage)fail('浏览器不允许本地保存');storage.setItem(STORAGE_KEY,JSON.stringify(persisted()));storageMode='local';storageError='';return true;}
  catch(error){storageMode='session';storageError='浏览器暂不允许保存，配置仅在本次页面保留；可导出备份';return false;}
 }
 function dirty(type){const d=draft(type),s=saved(type);if(type==='connection')return JSON.stringify({...s,apiKey:keys.get(s.id)||s.apiKey||''})!==JSON.stringify(d);return JSON.stringify(d)!==JSON.stringify(s);}
 async function save(type){
  const d=draft(type),value=type==='connection'?connection(d,true):prompt(d),name=listName(type);
  const candidate=clone(doc);candidate[name][candidate[name].findIndex(p=>p.id===d.id)]=value;bounded(validateDoc(candidate,true));
  doc=candidate;if(type==='connection'){keys.set(d.id,d.apiKey||'');drafts[name].set(d.id,{...clone(value),apiKey:d.apiKey||''});}else drafts[name].set(d.id,clone(value));
  loadError='';return persist({kind:'save',type,id:d.id});
 }
 function uniqueName(base,type,rows=doc[listName(type)]){let name=base.slice(0,110),n=2;while(rows.some(p=>p.name===name))name=base.slice(0,100)+' '+n++;return name;}
 async function switchTo(type,id){if(!saved(type,id))fail('预设不存在');doc.active[activeKey(type)]=id;draft(type,id);await persist();}
 async function add(type,copy=false){
  const name=listName(type);if(doc[name].length>=LIMITS.presets)fail('同类预设最多保存 50 套');
  let value=copy?clone(draft(type)):type==='connection'?blankConnection(uid('connection'),'新 API 连接'):{id:uid('prompt'),name:'新提示词预设',segments:[{id:uid('segment'),name:'新提示词段',role:'system',enabled:true,content:''}]};
  if(copy){value.id=uid(type);value.name=uniqueName(value.name+' · 副本',type);if(type==='prompt')value.segments.forEach(s=>s.id=uid('segment'));}
  else value.name=uniqueName(value.name,type);
  if(type==='connection'){value.apiKey='';value.rememberKey=false;value=connection(value,true);}else value=prompt(value);
  const candidate=clone(doc);candidate[name].push(value);candidate.active[activeKey(type)]=value.id;bounded(validateDoc(candidate,true));doc=candidate;await persist({kind:'draft'});return draft(type);
 }
 async function remove(type){
  const name=listName(type),id=doc.active[activeKey(type)];if(doc[name].length<=1)fail('至少保留一套同类预设');
  doc[name]=doc[name].filter(p=>p.id!==id);const fallback=doc[name][0].id,key=activeKey(type);doc.active[key]=fallback;
  for(const task of TASKS)if(doc.assignments[task][key]===id)doc.assignments[task][key]=fallback;
  drafts[name].delete(id);keys.delete(id);await persist({kind:'delete',type,id});return fallback;
 }
 async function rename(type,name){const d=draft(type),before=d.name;d.name=name;try{return await save(type);}catch(error){d.name=before;throw error;}}
 function discard(type){drafts[listName(type)].delete(doc.active[activeKey(type)]);return draft(type);}
 async function assign(task,type,id){if(!TASKS.includes(task)||!saved(type,id))fail('任务或预设不存在');doc.assignments[task][activeKey(type)]=id;await persist({kind:'assignment',task});}
 function resolve(task){
  const pair=doc.assignments[task];if(!pair)fail('任务不存在');
  const c=saved('connection',pair.connectionId),p=saved('prompt',pair.promptPresetId);
  return {connection:connection(c,false),promptPreset:{id:p.id,name:p.name},messages:p.segments.filter(s=>s.enabled).map(s=>({role:s.role,content:s.content}))};
 }
 function exportValue(type='all'){
  if(type==='all')return publicDoc(doc);
  const value=type==='connection'?connection(draft(type),false):prompt(draft(type));
  return {kind:'atlas-ui-preset-export',version:1,connections:type==='connection'?[value]:[],promptPresets:type==='prompt'?[value]:[]};
 }
 function parseImport(value){
  bounded(value);
  if(value?.kind==='atlas-preview-prompts')value={kind:'atlas-ui-preset-export',version:1,connections:[],promptPresets:[{id:uid('prompt'),name:'导入的提示词预设',segments:value.segments}]};
  if(value?.kind==='atlas-ui-presets')return publicDoc(value);
  if(value?.kind!=='atlas-ui-preset-export'||value.version!==1)fail('预设文件格式或版本不支持');
  const connections=uniqueRows(value.connections,c=>connection(c,false),'API 预设'),promptPresets=uniqueRows(value.promptPresets,prompt,'提示词预设');
  if(!connections.length&&!promptPresets.length)fail('文件中没有可导入的预设');
  return {kind:value.kind,version:1,connections,promptPresets};
 }
 async function importValue(value){
  const incoming=parseImport(value),candidate=clone(doc),cMap=new Map(),pMap=new Map();
  if(candidate.connections.length+incoming.connections.length>LIMITS.presets||candidate.promptPresets.length+incoming.promptPresets.length>LIMITS.presets)fail('导入后同类预设不能超过 50 套');
  for(const c of incoming.connections){const id=uid('connection');cMap.set(c.id,id);candidate.connections.push({...c,id,name:uniqueName(c.name,'connection',candidate.connections),rememberKey:false});}
  for(const p of incoming.promptPresets){const id=uid('prompt');pMap.set(p.id,id);candidate.promptPresets.push({...p,id,name:uniqueName(p.name,'prompt',candidate.promptPresets),segments:p.segments.map(s=>({...s,id:uid('segment')}))});}
  if(incoming.kind==='atlas-ui-presets'){
   for(const task of TASKS)candidate.assignments[task]={connectionId:cMap.get(incoming.assignments[task].connectionId),promptPresetId:pMap.get(incoming.assignments[task].promptPresetId)};
   candidate.active={connectionId:cMap.get(incoming.active.connectionId),promptPresetId:pMap.get(incoming.active.promptPresetId)};
  }else{
   if(cMap.size)candidate.active.connectionId=cMap.values().next().value;
   if(pMap.size)candidate.active.promptPresetId=pMap.values().next().value;
  }
  bounded(validateDoc(candidate,true));doc=candidate;await persist({kind:'import'});return {connections:cMap.size,prompts:pMap.size};
 }
 return {
  get document(){return publicDoc(doc);},get status(){return {mode:storageMode,error:storageError,loadError};},
  draft,dirty,save,switchTo,add,remove,rename,discard,assign,resolve,exportValue,parseImport,importValue,
  uid,get limits(){return {...LIMITS};},storageKey:STORAGE_KEY
 };
}
global.AtlasPresetStore={create,storageKey:STORAGE_KEY,limits:LIMITS};
})(window);
