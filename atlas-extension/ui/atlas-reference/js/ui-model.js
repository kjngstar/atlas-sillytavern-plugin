/* View-only rules. No database, story time, or model calls. */
(function(host){
'use strict';
const SCALE_WIDTH_PX=74,SEARCH_LIMIT=8,PREFERENCE_KEY='atlas.ui-demo.interaction.v1';
/**
 * M6-07②：比例尺。
 *
 * 线长**固定** 74 CSS px —— 缩放只改变距离数值，绝不为凑"整数字"去改线长。
 * `cssPixelsPerUnit` = 每 UI 单位多少 CSS 像素（camera.s）；`metersPerUnit` = 每 UI 单位多少米。
 * 未标定（或非正数）时用「格」而不是假装成米；单位只在真的 ≥1000 m 时升级到 km。
 * `options.estimated` 为真（尺度是估的/推的）时，数值前加「约」。
 */
function fixedScale(cssPixelsPerUnit,metersPerUnit,options){
 const estimated=options?.estimated===true;
 if(!Number.isFinite(cssPixelsPerUnit)||cssPixelsPerUnit<=0)return {width:SCALE_WIDTH_PX,distance:null,label:'—',unit:'unknown',estimated:false};
 const calibrated=Number.isFinite(metersPerUnit)&&metersPerUnit>0;
 const distance=SCALE_WIDTH_PX/cssPixelsPerUnit*(calibrated?metersPerUnit:1);
 if(!Number.isFinite(distance)||distance<=0)return {width:SCALE_WIDTH_PX,distance:null,label:'—',unit:'unknown',estimated:false};
 const unit=calibrated?(distance>=1000?'km':'m'):'格';
 const value=unit==='km'?distance/1000:distance;
 // Three significant digits without rounding a small nonzero distance to zero.
 const text=Number(value.toPrecision(3)).toLocaleString('en-US',{maximumSignificantDigits:3,useGrouping:false});
 return {width:SCALE_WIDTH_PX,distance,label:(estimated?'约 ':'')+text+' '+unit,unit,estimated};
}
function search(entries,query,limit=SEARCH_LIMIT){
 const q=String(query||'').trim().toLocaleLowerCase();
 if(!q)return {entries:[],total:0};
 const matches=entries.map((entry,index)=>{
  const title=String(entry.title).toLocaleLowerCase(),haystack=(title+' '+(entry.sub||'')).toLocaleLowerCase();
  return {entry,index,rank:title===q?0:title.startsWith(q)?1:title.includes(q)?2:3,match:haystack.includes(q)};
 }).filter(hit=>hit.match).sort((a,b)=>a.rank-b.rank||a.index-b.index);
 return {entries:matches.slice(0,limit).map(hit=>hit.entry),total:matches.length};
}
const PROFILE_SLOTS=Object.freeze(['titlebar','rail','locationTree','inspector','eventDock','map','breadcrumb','mapControls','legend','minimap','scaleBar','profileSwitcher','mapModes','placeSummary','ticker']);
const PROFILE_IDS=Object.freeze(['full','mapFocus','mapOnly']);
const PROFILE_REGISTRY=Object.freeze({
 full:Object.freeze({schemaVersion:1,id:'full',layout:'workspace',visible:Object.freeze(Object.fromEntries(PROFILE_SLOTS.map(k=>[k,true]))),behavior:Object.freeze({forceMapPage:false,selectionPresentation:'inspector'})}),
 mapFocus:Object.freeze({schemaVersion:1,id:'mapFocus',extends:'full',layout:'map-focus',visible:Object.freeze({rail:false,locationTree:false,eventDock:false,ticker:false}),behavior:Object.freeze({forceMapPage:true})}),
 mapOnly:Object.freeze({schemaVersion:1,id:'mapOnly',extends:'mapFocus',layout:'map-only',visible:Object.freeze({inspector:false,legend:false,minimap:false,mapModes:false,placeSummary:false}),behavior:Object.freeze({selectionPresentation:'map-overlay'})})
});
function validateUIProfile(v){
 const bad=errorCode=>({ok:false,errorCode});
 if(!v||typeof v!=='object'||Array.isArray(v))return bad('UI_PROFILE_INVALID');
 if(Object.keys(v).some(k=>!['schemaVersion','id','extends','layout','visible','behavior'].includes(k)))return bad('UI_PROFILE_UNKNOWN_FIELD');
 if(v.schemaVersion!==1)return bad('UI_PROFILE_VERSION_UNSUPPORTED');
 if(!PROFILE_IDS.includes(v.id)||v.extends!==undefined&&!PROFILE_IDS.includes(v.extends)||!['workspace','map-focus','map-only'].includes(v.layout))return bad('UI_PROFILE_ID_INVALID');
 for(const [key,allowed]of [['visible',PROFILE_SLOTS],['behavior',['forceMapPage','selectionPresentation']]]){
  const object=v[key];if(object===undefined)continue;if(!object||typeof object!=='object'||Array.isArray(object)||Object.keys(object).some(k=>!allowed.includes(k)))return bad('UI_PROFILE_UNKNOWN_FIELD');
  for(const [k,item]of Object.entries(object))if(k==='selectionPresentation'?!['inspector','map-overlay'].includes(item):typeof item!=='boolean')return bad('UI_PROFILE_VALUE_INVALID');
 }
 return {ok:true};
}
function resolveUIProfile(id,registry=PROFILE_REGISTRY){
 const visited=new Set();
 function resolve(key){if(!PROFILE_IDS.includes(key)||!Object.hasOwn(registry,key))throw Error('UI_PROFILE_NOT_FOUND');if(visited.has(key))throw Error('UI_PROFILE_CYCLE');visited.add(key);const value=registry[key],check=validateUIProfile(value);if(!check.ok)throw Error(check.errorCode);if(value.id!==key)throw Error('UI_PROFILE_ID_INVALID');const parent=value.extends?resolve(value.extends):null;return {...value,visible:{...parent?.visible,...value.visible},behavior:{...parent?.behavior,...value.behavior}};}
 try{const profile=resolve(id);for(const k of ['titlebar','map','breadcrumb','mapControls','scaleBar','profileSwitcher'])profile.visible[k]=true;Object.freeze(profile.visible);Object.freeze(profile.behavior);return {ok:true,profile:Object.freeze(profile),warnings:[]};}
 catch(error){return {ok:false,profile:resolveUIProfile('full').profile,errorCode:error.message,warnings:[]};}
}
function deriveEffectiveLayout(profile,manual={}){return {layout:profile.layout,visible:profile.visible,panels:{leftClosed:manual.leftClosed===true,rightClosed:manual.rightClosed===true},effectivePage:profile.behavior.forceMapPage?'map':manual.page||'map'};}
function preferences(storage){
 let saved={singleClickEnter:false,legendCollapsed:false,mapWidgetsCollapsed:true,profileId:'full'},persistent=!!storage,status='idle',lastSave=Promise.resolve({ok:!!storage}),sequence=0;
 try{const value=JSON.parse(storage?.getItem(PREFERENCE_KEY)||'null');if(value&&[1,2,3].includes(value.version)){for(const k of ['singleClickEnter','legendCollapsed','mapWidgetsCollapsed'])if(typeof value[k]==='boolean')saved[k]=value[k];if(PROFILE_IDS.includes(value.profileId))saved.profileId=value.profileId;}}catch(_){persistent=false;}
 return {get value(){return {...saved};},get persistent(){return persistent;},get status(){return status;},flush:()=>lastSave,
 set(key,value){if(!Object.hasOwn(saved,key)||(key==='profileId'?!PROFILE_IDS.includes(value):typeof value!=='boolean'))return false;saved[key]=value;status='pending';const ticket=++sequence;
 try{if(!storage)throw Error('UI_STORAGE_UNAVAILABLE');lastSave=Promise.resolve(storage.setItem(PREFERENCE_KEY,JSON.stringify({version:3,...saved}))).then(()=>{if(ticket===sequence){persistent=true;status='saved';}return {ok:true};},error=>{if(ticket===sequence){persistent=false;status='failed';}return {ok:false,errorCode:'UI_PREFERENCE_SAVE_FAILED',message:error.message};});}
 catch(error){persistent=false;status='failed';lastSave=Promise.resolve({ok:false,errorCode:'UI_PREFERENCE_SAVE_FAILED',message:error.message});}return true;}}
}
const api={SCALE_WIDTH_PX,SEARCH_LIMIT,PREFERENCE_KEY,PROFILE_SLOTS,PROFILE_IDS,PROFILE_REGISTRY,validateUIProfile,resolveUIProfile,deriveEffectiveLayout,fixedScale,search,preferences};
if(typeof module==='object'&&module.exports)module.exports=api;else host.AtlasUIModel=api;
})(typeof window==='object'?window:globalThis);
