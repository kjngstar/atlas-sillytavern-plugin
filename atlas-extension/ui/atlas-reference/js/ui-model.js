/* View-only rules. No database, story time, or model calls. */
(function(host){
'use strict';
const SCALE_WIDTH_PX=74,SEARCH_LIMIT=8,PREFERENCE_KEY='atlas.ui-demo.interaction.v1';
function fixedScale(cssPixelsPerUnit,metersPerUnit){
 if(!Number.isFinite(cssPixelsPerUnit)||cssPixelsPerUnit<=0)return {width:SCALE_WIDTH_PX,distance:null,label:'—',unit:'unknown'};
 const calibrated=Number.isFinite(metersPerUnit)&&metersPerUnit>0;
 const distance=SCALE_WIDTH_PX/cssPixelsPerUnit*(calibrated?metersPerUnit:1);
 const unit=calibrated?(distance>=1000?'km':'m'):'格';
 const value=unit==='km'?distance/1000:distance;
 // Three significant digits without rounding a small nonzero distance to zero.
 const text=Number(value.toPrecision(3)).toLocaleString('en-US',{maximumSignificantDigits:3,useGrouping:false});
 return {width:SCALE_WIDTH_PX,distance,label:text+' '+unit,unit};
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
