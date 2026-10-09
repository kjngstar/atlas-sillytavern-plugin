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
function preferences(storage){
 let saved={singleClickEnter:false,legendCollapsed:false},persistent=true;
 try{
  if(!storage)throw new Error('Storage unavailable');
  const value=JSON.parse(storage.getItem(PREFERENCE_KEY)||'null');
  if(value&&value.version===1){for(const key of Object.keys(saved))if(typeof value[key]==='boolean')saved[key]=value[key];}
 }catch(_){persistent=false;}
 return {
  get value(){return {...saved};},get persistent(){return persistent;},
  set(key,value){
   if(!Object.prototype.hasOwnProperty.call(saved,key)||typeof value!=='boolean')return false;
   saved[key]=value;
   try{if(!storage)throw new Error('Storage unavailable');storage.setItem(PREFERENCE_KEY,JSON.stringify({version:1,...saved}));persistent=true;}
   catch(_){persistent=false;}
   return true;
  }
 };
}
const api={SCALE_WIDTH_PX,SEARCH_LIMIT,PREFERENCE_KEY,fixedScale,search,preferences};
if(typeof module==='object'&&module.exports)module.exports=api;else host.AtlasUIModel=api;
})(typeof window==='object'?window:globalThis);
