import {createSkinAssetLoader} from './atlas-skin-assets.mjs';
import {readSkinPack,writeSkinPack} from './atlas-skin-pack.mjs';
export {appearanceSettingsHTML} from './atlas-appearance-settings.mjs';

/** One transactional appearance channel for the existing UI and map instance. */
export function createAppearanceController({runtime,host,apply,getSkin,onApplied=()=>{},diagnostic=()=>{},assetLoader=createSkinAssetLoader()}={}){
 let generation=0,disposed=false,abort=null,active=null,mutations=Promise.resolve(),writes=Promise.resolve();
 const session=new Map(),removing=new Set();
 const status=(code,message)=>({ok:false,errorCode:code,message});
 const removingStatus=()=>status('SKIN_REMOVING','该皮肤正在移除，请稍后再试');
 const log=error=>diagnostic({level:'warn',source:'ui',code:error.code||error.errorCode||'SKIN_OPERATION_FAILED',details:{message:error.message||String(error)}});
 function enqueue(fn){const next=mutations.then(()=>{if(disposed)throw Error('UI_DISPOSED');return fn();});mutations=next.catch(()=>{});return next;}
 function remember(pack){session.delete(pack.id);session.set(pack.id,pack);let bytes=[...session.values()].reduce((n,p)=>n+p.files.reduce((s,f)=>s+f.bytes.byteLength,0),0);while(session.size>4||bytes>32*1024*1024){const key=session.keys().next().value,p=session.get(key);session.delete(key);bytes-=p.files.reduce((s,f)=>s+f.bytes.byteLength,0);}}
 async function saveSkin(skin,ticket=generation){
  const snapshot=JSON.parse(JSON.stringify(skin));
  const pending=writes.then(async()=>{if(disposed||ticket!==generation)return false;await host.saveSkin(snapshot);return true;});writes=pending.catch(()=>{});return pending;
 }
 async function setSkin(value,{pack=null,persist=true,stored=true}={}){
  if(disposed)return status('UI_DISPOSED');if(removing.has(typeof value==='string'?value:value?.id))return removingStatus();
  const ticket=++generation;abort?.abort();const controller=new AbortController();abort=controller;
  let prepared=null;
  try{
   if(typeof value==='string'&&!value.startsWith('builtin.')){pack=pack||session.get(value)||await host.getSkinPack?.(value);if(!pack)throw Object.assign(Error('SKIN_NOT_FOUND'),{code:'SKIN_NOT_FOUND'});value=pack.theme;}
   const result=runtime.migrate(value);if(!result.ok)return result;const skin=result.skin;if(session.has(skin.id))stored=false;
   if(Object.keys(skin.assets).length&&!pack){pack=session.get(skin.id)||await host.getSkinPack?.(skin.id);if(session.has(skin.id))stored=false;}
   if(ticket!==generation||disposed)return status('SKIN_SUPERSEDED');
   prepared=await assetLoader.prepare(pack,skin,{signal:controller.signal});
   if(ticket!==generation||disposed){prepared.release();return status('SKIN_SUPERSEDED');}
   const applied=apply(skin,prepared.resources);if(!applied?.ok){prepared.release();return applied||status('SKIN_APPLY_FAILED');}
   const previous=active;active={pack,skin,resources:prepared};previous?.resources.release();onApplied(skin);
   let saved=false;
   if(persist&&(stored||!Object.keys(skin.assets).length)){try{saved=await saveSkin(skin,ticket);}catch(error){log(Object.assign(error,{code:'SKIN_PREFERENCE_SAVE_FAILED'}));}}
   if(ticket!==generation||disposed)return status('SKIN_SUPERSEDED');return {ok:true,skin,saved,warnings:saved||!persist?[]:['SKIN_PREVIEW_ONLY']};
  }catch(error){prepared?.release();if(ticket!==generation||disposed||controller.signal.aborted)return status('SKIN_SUPERSEDED');log(error);return status(error.code||'SKIN_PREPARE_FAILED',error.message);}
 }
 async function install(pack){
  if(disposed)return status('UI_DISPOSED');if(removing.has(pack.id))return removingStatus();
  const ticket=++generation;abort?.abort();const controller=new AbortController();abort=controller;let stored=false;
  const checked=runtime.resolve(pack.theme);if(!checked.ok)return checked;
  try{const probe=await assetLoader.prepare(pack,{...checked.skin,assets:Object.fromEntries((pack.files||[]).map((file,index)=>[String(index),file.id]))},{signal:controller.signal});probe.release();}catch(error){if(disposed||ticket!==generation)return status('SKIN_SUPERSEDED');log(error);return status(error.code||'SKIN_PREPARE_FAILED',error.message);}
  if(disposed||ticket!==generation)return status('SKIN_SUPERSEDED');
  // Invalidate the old preview within the storage queue, before a newer write can finish.
  try{await enqueue(async()=>{if(typeof host.putSkinPack!=='function')throw Error('SKIN_STORAGE_UNAVAILABLE');await host.putSkinPack(pack);session.delete(pack.id);});stored=true;}
  catch(error){if(disposed)return status('UI_DISPOSED');log(Object.assign(error,{code:error.code||'SKIN_STORAGE_FAILED'}));remember(pack);}
  if(disposed)return status('UI_DISPOSED');if(ticket!==generation)return status('SKIN_SUPERSEDED');return setSkin(pack.theme,{pack,stored});
 }
 async function importFile(file){
  const ticket=++generation;abort?.abort();try{
   if(file.size>8*1024*1024)return status('SKIN_FILE_TOO_LARGE');
   if(/\.zip$/i.test(file.name)){const pack=await readSkinPack(await file.arrayBuffer());return ticket===generation&&!disposed?install(pack):status('SKIN_SUPERSEDED');}
   const text=await file.text();if(new TextEncoder().encode(text).length>64*1024)return status('SKIN_MANIFEST_TOO_LARGE');
   const result=runtime.migrate(JSON.parse(text));if(!result.ok)return result;if(Object.keys(result.skin.assets).length)return status('SKIN_ASSET_MISSING');
   const skin={...result.skin,id:result.skin.id.startsWith('builtin.')?'user.imported.'+Date.now():result.skin.id};return ticket===generation&&!disposed?install({id:skin.id,name:skin.id,theme:skin,files:[]}):status('SKIN_SUPERSEDED');
  }catch(error){log(error);return status(error.code||'SKIN_IMPORT_FAILED',error.message);}
 }
 async function list(){if(disposed)return [];let rows=[];try{rows=await host.listSkinPacks?.()||[];}catch(error){log(error);}const all=new Map(rows.map(row=>[row.id,row]));for(const pack of session.values())all.set(pack.id,{id:pack.id,name:pack.name,previewOnly:true});return [...all.values()];}
 async function remove(id){
  if(disposed)return status('UI_DISPOSED');if(removing.has(id))return removingStatus();
  // Block new uses before awaiting fallback; invalidate reads/decodes already in flight.
  removing.add(id);generation++;abort?.abort();
  try{
   if(getSkin().id===id){const result=await setSkin('builtin.starmap');if(!result.ok||!result.saved)return status('SKIN_REMOVE_FALLBACK_UNSAVED');}
   await enqueue(()=>host.removeSkinPack?.(id));session.delete(id);return {ok:true};
  }catch(error){log(error);return status(error.code||'SKIN_REMOVE_FAILED',error.message);}
  finally{removing.delete(id);}
 }
 return {
  setSkin,setTheme:id=>setSkin(id),install,importFile,list,remove,
  async exportPack(){if(disposed)throw Error('UI_DISPOSED');const skin=getSkin(),pack=active?.pack;return writeSkinPack(pack||{name:skin.id,files:[]},skin);},
  async save(){if(disposed)return false;try{return await saveSkin(getSkin());}catch(error){log(error);return false;}},
  async start(value){const pending=setSkin(value||'builtin.starmap',{persist:false}),ticket=generation,result=await pending;if(!result.ok&&ticket===generation&&!disposed){log(result);return setSkin('builtin.starmap',{persist:false});}return result;},
  destroy(){if(disposed)return;disposed=true;generation++;abort?.abort();active?.resources.release();active=null;session.clear();}
 };
}
