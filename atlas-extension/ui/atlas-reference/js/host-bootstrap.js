/* Loads the unmodified visual assets and supplies only real host data. */
(async function(){
  'use strict';
  const root=document.getElementById('atlasDemo');root.style.visibility='hidden';
  const host=window.frameElement?.__atlasHost;
  if(!host)throw Error('ATLAS_HOST_UNAVAILABLE');
  try{
    const initial=await host.boot();window.AtlasHost=host;host.initial=initial;
    window.ATLAS_DEMO_DATA=JSON.parse(JSON.stringify(initial.data));
    const interaction=initial.preferences??{version:1,singleClickEnter:false,legendCollapsed:false};
    host.preferenceStorage={getItem:()=>JSON.stringify(interaction),setItem:(_,value)=>{Object.assign(interaction,JSON.parse(value));void host.savePreferences(interaction).catch(error=>host.diagnostic({level:'warn',source:'ui',code:'UI_PREFERENCE_SAVE_FAILED',details:{message:error.message}}));}};
    for(const name of ['map','presets','preset-ui','ui-model','app']){
      await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=`js/${name}.js`;script.onload=resolve;script.onerror=()=>reject(Error(`UI_ASSET_LOAD_FAILED:${name}`));document.body.append(script);});
    }
    const badge=root.querySelector('.demo-badge');if(badge)badge.textContent='ATLAS';
    root.style.visibility='';host.ready();
  }catch(error){
    root.style.visibility='';root.querySelector('#syncText').textContent='界面加载失败';
    root.querySelector('#inspector').textContent=error.message;console.error('[Atlas UI]',error);
    const retry=document.createElement('button');retry.className='action-btn primary';retry.textContent='重试加载';retry.onclick=()=>window.location.reload();root.querySelector('#inspector').append(retry);
    host.diagnostic({level:'error',source:'ui',code:'REFERENCE_UI_BOOT_FAILED',details:{message:error.message}});
  }
})();
