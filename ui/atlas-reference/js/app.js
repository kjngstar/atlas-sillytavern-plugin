/* Supplied ATLAS controller, connected to the real host. */
(function(){
'use strict';
const root=document.getElementById('atlasDemo'),D=window.ATLAS_DEMO_DATA;
if(!root||!D)throw new Error('ATLAS_PREVIEW_MISSING_ROOT_OR_DATA');
const $=s=>root.querySelector(s),$$=s=>Array.from(root.querySelectorAll(s));
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone=o=>JSON.parse(JSON.stringify(o));
const icon=n=>`<svg aria-hidden="true"><use href="#i-${n}"/></svg>`;
const color={world:'#43e0ff',region:'#39e0a0',city:'#9b6bff',district:'#ffc247',building:'#7fd4ff',floor:'#43e0ff',room:'#ff5f92',detail:'#39e0a0'};
const names={map:'地图',cast:'全部人物',items:'全部物品',msgs:'全部消息',sim:'世界推演',time:'世界时间线',lore:'世界书',diag:'诊断',prefs:'预设与外观'};
const ui=window.AtlasUIModel;
let preferenceStorage=window.AtlasHost.preferenceStorage;
const preferences=ui.preferences(preferenceStorage);
const state={page:'map',nodeId:D.meta.initialNodeId||D.ROOT.id,selected:null,inspectorTab:'cast',dock:'log',viewMode:D.meta.viewMode||'pov',mapMode:'map',open:new Set(),cameras:new Map(),query:'',filter:'all',settingsTab:'prompts',motion:true,leftClosed:false,rightClosed:false,branch:'main',advance:0,...preferences.value};
const timers=new Set(),unlisten=[];
let flowReadSequence=0,scopedFlows=null,disposed=false,hostVisible=true,profileSequence=0,layoutFrame=0,layoutWaiters=[],fullFocus=null;
function refreshFlows(){
 const sequence=++flowReadSequence,scopeKey=D.meta.scopeKey,revision=D.meta.revision,mapId=state.nodeId;
 const selectedEntityId=state.selected?.kind==='character'?state.selected.id:null;
 scopedFlows=null;
 if(typeof window.AtlasHost.readFlows!=='function')return;
 void window.AtlasHost.readFlows(mapId,selectedEntityId).then(value=>{
  if(sequence!==flowReadSequence||scopeKey!==D.meta.scopeKey||revision!==D.meta.revision||mapId!==state.nodeId)return;
  if(!value||value.scopeKey!==scopeKey||value.revision!==revision||value.mapId!==mapId)return;
  scopedFlows=value;renderPlace();renderDock();
 }).catch(error=>{if(sequence===flowReadSequence)toast(error.message,'warn');});
}
let mapExportUrl=null;
let mapExportText='';
let activeSkin=window.AtlasSkinRuntime.builtin('builtin.starmap'),skinCatalog=[],skinCatalogSequence=0;

const presets=window.AtlasPresetStore.create(D.PROMPTS,{storage:null,initialDocument:window.AtlasHost.initial.presets,onPersist:window.AtlasHost.persistPresets});
function later(fn,ms){const id=setTimeout(()=>{timers.delete(id);fn();},ms);timers.add(id);return id;}
function listen(el,type,fn,opt){el.addEventListener(type,fn,opt);unlisten.push(()=>el.removeEventListener(type,fn,opt));}
function nodes(n=D.ROOT,out=[]){out.push(n);for(const c of n.children||[])nodes(c,out);return out;}
function byId(id){return nodes().find(n=>n.id===id)||(D.LOCATIONS||[]).find(n=>n.id===id)||null;}
function path(id,n=D.ROOT,p=[]){if(n===D.ROOT){const location=(D.LOCATIONS||[]).find(l=>l.id===id);if(location){const parent=path(location.mapId);return parent?parent.concat(location):[location];}}const q=p.concat(n);if(n.id===id)return q;for(const c of n.children||[]){const r=path(id,c,q);if(r)return r;}return null;}
function current(){return byId(state.nodeId)||D.ROOT;}
function clock(){const m=D.meta.timeMinutes;return `${String(Math.floor(m/60)%24).padStart(2,'0')}:${String(Math.floor(m%60)).padStart(2,'0')}`;}
function placeName(id){return byId(id)?.name||'位置未明确';}
function known(o){return state.viewMode==='author'||o.known!==false;}
/**
 * M6-11①：左栏读的是**本轮故事**，判据是服务端给的真实 narrative 回合 id（`meta.latestTurnId`），
 * 不是数组顺序、也不是「本地第几个事件」——manual 标定与地图建设都会造事件，
 * 但它们**不推进** latestNarrativeTurnId，所以标定之后左栏该说「本轮暂无新的世界动向」，
 * 而不是把上一条标定当成剧情动向报出来。
 */
function turnEvents(){const id=D.meta?.latestTurnId;return id==null?[]:D.EVENTS.filter(e=>known(e)&&e.turnId===id);}
function historyEvents(){const id=D.meta?.latestTurnId;return D.EVENTS.filter(e=>known(e)&&(id==null||e.turnId!==id));}
const EVENT_KIND={event:'事件',story:'事件',observation:'见闻',message:'消息',action:'行动',journey:'行程',manual:'作者标定',build:'世界建设',cast:'人物',msg:'消息',sim:'行程',item:'物品',geo:'地理'};
function eventKindLabel(e){return EVENT_KIND[e.category]||EVENT_KIND[e.kind]||'事件';}
/** M6-11②：事件 → 可点击关联对象的 kind 映射（message/action/journey 各走自己的详情）。 */
const LINK_KIND={message:'消息',action:'行动',journey:'旅程'};
function within(id,ancestor){return (path(id)||[]).some(n=>n.id===ancestor);}
function sceneCast(id=state.nodeId){return D.CAST.filter(c=>c.state!=='away'&&c.state!=='off'&&c.state!=='unknown'&&within(c.mapNodeId||c.locationId,id)&&known(c));}
function sceneItems(id=state.nodeId){return D.ITEMS.filter(it=>within(it.mapNodeId||it.locationId,id)&&known(it));}
function sceneMessages(id=state.nodeId){return D.MESSAGES.filter(m=>(within(m.mapNodeId||m.locationId,id)||within(id,m.mapNodeId||m.locationId))&&known(m));}
function message(id){return D.MESSAGES.find(m=>m.id===id);}
function task(id){return D.TASKS.find(t=>t.id===id);}
function effectivePage(){return ui.resolveUIProfile(state.profileId).profile.behavior.forceMapPage?'map':state.page;}
function syncMapVisibility(){map.setPaused(disposed||!hostVisible||document.hidden||effectivePage()!=='map');}
function resizeAfterLayout(){
 if(disposed)return Promise.resolve({ok:false,errorCode:'UI_DISPOSED'});
 if(!hostVisible||document.hidden||!$('#viewport').getBoundingClientRect().width)return Promise.resolve({ok:true,layoutPending:true});
 return new Promise(resolve=>{layoutWaiters.push(resolve);if(layoutFrame)return;layoutFrame=requestAnimationFrame(()=>{layoutFrame=0;let result;try{if(!disposed&&hostVisible&&!document.hidden)map.resize();result={ok:!disposed};}catch(error){result={ok:false,errorCode:'UI_PROFILE_LAYOUT_FAILED',message:error.message};}layoutWaiters.splice(0).forEach(done=>done(result));});});
}
function renderSelectionOverlay(){const el=$('#mapSelection');if(!el)return;const show=ui.resolveUIProfile(state.profileId).profile.behavior.selectionPresentation==='map-overlay'&&!!state.selected&&!state.overlayDismissed;el.hidden=!show;if(show)$('#mapSelectionBody').innerHTML=detailHTML();}
function applyUIProfile(){
 const profile=ui.resolveUIProfile(state.profileId).profile;root.dataset.uiProfile=profile.id;
 for(const el of $$('[data-ui-slot]'))el.toggleAttribute('data-profile-hidden',profile.visible[el.dataset.uiSlot]===false);
 for(const [id,slot]of [['reopenLeft','locationTree'],['reopenRight','inspector']])$('#'+id).toggleAttribute('data-profile-hidden',!profile.visible[slot]);
 $('#profileSwitcher').value=profile.id;$('#workspacePage').hidden=effectivePage()==='map';$('#viewport').classList.toggle('page-open',effectivePage()!=='map');renderSelectionOverlay();syncMapVisibility();
}
async function setUIProfile(id){
 if(disposed)return {ok:false,errorCode:'UI_DISPOSED'};const result=ui.resolveUIProfile(id);if(!result.ok)return result;
 const ticket=++profileSequence,previous=state.profileId;
 if(previous==='full'&&id!=='full'){const element=document.activeElement;fullFocus={element,start:element?.selectionStart,end:element?.selectionEnd,scroll:element?.scrollTop,workspace:$('#workspacePage').scrollTop};}
 state.profileId=id;applyUIProfile();const measured=await resizeAfterLayout();
 if(ticket!==profileSequence||disposed)return {ok:false,errorCode:'UI_PROFILE_SUPERSEDED'};
 if(!measured.ok){state.profileId=previous;applyUIProfile();diagnostic('warn','UI_PROFILE_RECOVERED','布局失败，已恢复上一显示配置');return measured;}
 if(id==='full'&&fullFocus){const saved=fullFocus;fullFocus=null;$('#workspacePage').scrollTop=saved.workspace;if(saved.element?.isConnected){saved.element.focus({preventScroll:true});if(saved.start!=null)saved.element.setSelectionRange?.(saved.start,saved.end);saved.element.scrollTop=saved.scroll;}}
 preferences.set('profileId',id);const saved=await preferences.flush();if(ticket!==profileSequence||disposed)return {ok:false,errorCode:'UI_PROFILE_SUPERSEDED'};
 return {ok:true,profileId:id,saved:saved.ok,layoutPending:measured.layoutPending===true,warnings:saved.ok?[]:['UI_PREFERENCE_SAVE_FAILED']};
}
function setPage(page){window.AtlasHost.onPage?.(page);state.page=names[page]?page:'map';if(state.page!=='map'&&state.profileId!=='full')void setUIProfile('full');state.query='';state.filter='all';renderPage();renderRail();syncMapVisibility();if(effectivePage()==='map')void resizeAfterLayout();}
function navigate(n,silent=false,{preserveWorkspace=false,logicalPage=null,resetScope=false}={}){
 if(typeof n==='string')n=byId(n);if(!n||!known(n))return false;if(!n.host){const child=byId(n.childMapIds?.[0]);if(!child)return false;n=child;}
 if(map.state.node&&!resetScope)state.cameras.set(state.nodeId,{...map.state.tgt,fit:map.fitScale()});
 state.nodeId=n.id;state.selected=null;state.overlayDismissed=false;state.inspectorTab='cast';state.page=logicalPage||'map';
 for(const v of path(n.id)||[])state.open.add(v.id);
 map.setPath(n,path(n.id)||[n]);map.setFilter(new Set());
 const cam=state.cameras.get(n.id);if(cam){map.state.cam={x:cam.x,y:cam.y,s:cam.s*map.fitScale()/(cam.fit||map.fitScale())};map.state.tgt={...map.state.cam};}
 map.setMode(state.mapMode);syncMapVisibility();
 renderAll({preserveWorkspace});refreshFlows();void resizeAfterLayout();
 if(!silent)toast(`已进入 ${n.name}`);
 return true;
}
function select(kind,id,show=false){state.overlayDismissed=false;state.selected={kind,id};refreshFlows();state.inspectorTab='details';renderInspector();if(show)openRight();const capturedScope=D.meta.scopeKey,capturedRevision=D.meta.revision;void window.AtlasHost.inspect(kind,id).then(value=>{if(!value||D.meta.scopeKey!==capturedScope||D.meta.revision!==capturedRevision||state.selected?.kind!==kind||state.selected?.id!==id)return;const row=kind==='character'?D.CAST.find(x=>x.id===id):kind==='item'?D.ITEMS.find(x=>x.id===id):kind==='message'?D.MESSAGES.find(x=>x.id===id):(kind==='task'||kind==='action'||kind==='journey')?D.TASKS.find(x=>x.id===id):(D.LOCATIONS||[]).find(x=>x.id===id);if(row)Object.assign(row,value);renderInspector();}).catch(error=>toast(error.message,'warn'));}
function inspectPlace(id,focus=false){
 const n=byId(id);if(!n||!known(n))return false;
 if(focus){const chain=path(id)||[],parent=chain[chain.length-2];navigate(parent||n,true);map.refreshMarks();map.focusKey(id);}
 select('place',id,true);return true;
}
function showEntity(kind,id,focus=false){
 if(focus){
  let destination=kind==='character'?D.CAST.find(c=>c.id===id)?.locationId:kind==='item'?D.ITEMS.find(it=>it.id===id)?.locationId:kind==='message'?message(id)?.locationId:id;
  const entity=kind==='character'?D.CAST.find(c=>c.id===id):kind==='item'?D.ITEMS.find(i=>i.id===id):message(id);destination=entity?.mapNodeId||((D.LOCATIONS||[]).find(l=>l.id===destination)?.childMapIds?.[0])||((D.LOCATIONS||[]).find(l=>l.id===destination)?.mapId)||destination;if(kind==='character'&&entity?.state==='away')state.mapMode='sim';
  if(!destination||!byId(destination)||!known(byId(destination))){toast('该对象目前没有可查看的位置','warn');select(kind,id,true);return false;}
  navigate(destination,true);
  map.setMode(state.mapMode);map.refreshMarks();map.focusKey(id);
 }
 select(kind,id,true);return true;
}
/**
 * P14/§21.5：提示词分层的**引擎信息**——策略版本、程序真实声明的能力、内置建议预设。
 * 全部来自宿主设置视图的真实字段；缺省就给空值，不编一个「已支持」的能力出来。
 *
 * 位置注意：必须放在下面那句 `AtlasMap.create(...)` **之前** ——
 * 无头验收夹具（`tests/atlas-map-overview-acceptance.test.mjs`）拿那一行当切片锚点，
 * 在只有 `window.AtlasMap` 的 vm 里跑标记筛选；把读宿主的代码挪到锚点之后会直接炸。
 * （注释里刻意不写锚点原文，否则 `indexOf` 会先命中注释。）
 */
const engine=window.AtlasHost?.initial?.engine??{policyVersion:null,capabilities:[],activePromptPresetId:null,suggested:null};
const map=window.AtlasMap.create($('#map'),$('#minimap'),{
 onSelect(m){if(m?.placeId){if(state.singleClickEnter&&m.node)navigate(m.node.id);else inspectPlace(m.placeId);return;}if(!m){state.selected=null;refreshFlows();state.inspectorTab='cast';renderInspector();return;}if(m.node){if(state.singleClickEnter)navigate(m.node.id);else inspectPlace(m.node.id);return;}
  if(m.type==='char')select('character',m.id,true);
  else if(m.type==='item')select('item',m.id,true);
  else if(m.type==='message'||m.type==='sig')select('message',m.id||'m4',true);
  else if(m.type==='journey')select('task',m.id,true);
  else {state.selected={kind:'place-marker',id:m.id,name:m.name,sub:m.sub};renderInspector();openRight();}
 },
 onHover(m,x,y){const tt=$('#tooltip');if(!m){tt.classList.remove('on');return;}const rect=root.getBoundingClientRect();
  tt.textContent=m.name+(m.node?(state.singleClickEnter?' · 单击进入':' · 单击查看'):'');tt.style.left=Math.min(rect.width-210,Math.max(8,x-rect.left+14))+'px';tt.style.top=Math.min(rect.height-48,y-rect.top+18)+'px';tt.classList.add('on');},
 onFrame:frameChrome,
 getMarks(n,marks){return marks.filter(m=>{
  if(m.type==='char'){const c=D.CAST.find(c=>c.id===m.id);if(!c)return false;return known(c)&&c.state!=='away'&&c.state!=='off'&&c.state!=='unknown'&&within(c.mapNodeId||c.locationId,n.id);}
  if(m.type==='item'){const it=D.ITEMS.find(it=>it.id===m.id);return it?known(it)&&within(it.mapNodeId||it.locationId,n.id):false;}
  if(m.node)return known(m.node);if(m.type==='sig')return message(m.id)?known(message(m.id)):false;return true;
 });},
 getFlows:id=>(scopedFlows?.mapId===id?scopedFlows.flows:D.FLOWS[id]||[]).filter(known),
 getJourneys:id=>(scopedFlows?.mapId===id?scopedFlows.journeys:D.JOURNEYS[id]||[]).filter(known),
 getRelations:id=>scopedFlows?.mapId===id?scopedFlows.relations:[],
 activeEdge:()=>state.selected?.kind==='message'||state.selected?.kind==='task'?state.selected.id:null,
 getMotion:()=>state.motion
});
const presetUI=window.AtlasPresetUI.create({root,store:presets,esc,toast,diagnostic,modal,renderPage,download,engine,
 fetchModels:connection=>window.AtlasHost.fetchModels(connection),
 /** 真实预览：走宿主 → 服务端同一条组装链；没有这个端口时明确报「预览不可用」。 */
 previewMessages:task=>typeof window.AtlasHost.previewMessages==='function'?window.AtlasHost.previewMessages(task):Promise.reject(Error('当前宿主没有提供请求预览'))});
function formatDistance(m){if(m>=1000)return `${+(m/1000).toFixed(2)} km`;return `${+m.toFixed(m<1?2:1)} m`;}
function frameChrome(st){
 if(!st.node)return;
 // M6-07②：比例尺的尺度依据由地图层给出（真实相机尺度 + 这个尺度可不可信）；
 // 74px 线长与换算公式只在 ui-model.fixedScale 里写一次 —— 这里不重复实现。
 const q=typeof map.scaleQuality==='function'?map.scaleQuality():null;
 const pxPerUnit=q&&Number.isFinite(q.cssPixelsPerUnit)?q.cssPixelsPerUnit:(st.node.metric?st.cam.s:st.cam.s*(st.node.transform?.scale||1));
 const scale=ui.fixedScale(pxPerUnit,q?q.metersPerUnit:st.node.metric,{estimated:!!q&&q.estimated}),bar=$('.sc-line i'),label=scale.label;
 if($('#scaleLabel').textContent!==label)$('#scaleLabel').textContent=label;
 $('#scaleLabel').dataset.distance=scale.distance===null?'':String(scale.distance);
 $('#scaleLabel').dataset.estimated=scale.estimated?'1':'';
 bar.dataset.width=String(scale.width);
 $('#mmZoom').textContent=Math.round(st.cam.s/map.fitScale()*100)+'%';
 $('#coordLabel').textContent=`X ${st.cam.x.toFixed(1)} · Y ${st.cam.y.toFixed(1)}`;
}
function renderRail(){
 $$('.rail-btn').forEach(b=>{const on=b.dataset.view===state.page;b.classList.toggle('active',on);b.setAttribute('aria-current',on?'page':'false');});
 $('.rail-ava').textContent=state.viewMode==='author'?'作':'知';$('.rail-ava').setAttribute('aria-label',state.viewMode==='author'?'当前作者视图，切换主角所知':'当前主角所知，切换作者视图');
 $('#viewBadge').textContent=state.viewMode==='author'?'世界后台':'主角所知';
 $('[data-view="msgs"] .rail-badge').textContent=D.MESSAGES.filter(known).length;
 $('[data-view="sim"] .rail-badge').textContent=D.TASKS.filter(t=>known(t)&&t.st!=='done').length;
}
function renderCrumbs(){const arr=path(state.nodeId)||[D.ROOT];$('#crumbs').innerHTML=arr.map((n,i)=>`${i?'<span class="crumb-sep">›</span>':''}<button class="crumb ${i===arr.length-1?'cur':''}" data-go="${esc(n.id)}"><span class="lv">${esc(n.code)}</span><span>${esc(n.name)}</span></button>`).join('');}
function renderLadder(){const arr=path(state.nodeId)||[];$('#depthLadder').innerHTML=D.LEVELS.map((lv,i)=>{const n=arr.find(n=>n.code===lv.code);return `<button class="dl-cell ${n?(n.id===state.nodeId?'cur':'done'):''}" ${n?`data-go="${esc(n.id)}"`:'disabled'} aria-label="${esc(lv.name+(n?'，'+n.name:'，未建立'))}"><div class="dl-bar"></div><div class="dl-lb">${lv.code}</div></button>`;}).join('');}
function renderTree(){let count=0;const walk=(n,depth)=>{if(!known(n))return '';count++;const has=n.children?.some(known),open=state.open.has(n.id),active=n.id===state.nodeId;
 return `<div class="tree-row ${active?'on':''}" style="padding-left:${6+depth*12}px"><button class="tw ${open&&has?'open':''}" data-expand="${esc(n.id)}" aria-label="${open?'收起':'展开'}${esc(n.name)}" ${has?'':'disabled'}>${has?icon('chev'):''}</button><button class="tree-link" data-go="${esc(n.id)}"><i class="tdot" style="--c:${color[n.kind]||color.world}"></i><span class="tname">${esc(n.name)}</span>${sceneCast(n.id).length?`<em class="tflag live">${sceneCast(n.id).length}人</em>`:''}<em class="tnum">${esc(n.code)}</em></button></div>${has&&open?n.children.map(c=>walk(c,depth+1)).join(''):''}`;};
 $('#layerTree').innerHTML=walk(D.ROOT,0);$('#treeCount').textContent=count+' 节点';
}
const flags=[['showGrid','网格底图'],['showMarks','世界标记'],['showLabels','名称标签'],['showLinks','人物联系线'],['showRadar','室外距离环']];
function renderSwitches(){const el=$('#switchList');el.innerHTML=flags.map(([k,t])=>`<button class="sw-row ${map.state[k]?'on':''}" data-flag="${k}" aria-pressed="${map.state[k]}"><span>${t}</span><i class="sw"></i></button>`).join('');$('#zGrid').classList.toggle('on',map.state.showGrid);}
function renderChips(){const g=current().geo,arr=current().kind==='city'?(g.districts||[]):[];$('#regionChips').innerHTML=arr.length?`<button class="chip ${!map.state.filter.size?'on':''}" data-filter-region="all">全部</button>`+arr.map(d=>`<button class="chip ${map.state.filter.has(d.id)?'on':''}" data-filter-region="${esc(d.id)}">${esc(d.name)}</button>`).join(''):'<span class="scope-note">筛选会随当前地图切换</span>';}
function renderPlace(){const n=current(),roster=sceneCast(),items=sceneItems();let body=`<div class="pl-path mono">${esc(n.code)} · ${esc(D.LEVELS.find(l=>l.key===n.kind)?.name||n.tag)} <span class="diagram-tag">空间示意</span></div><div class="pl-grid"><div class="pl-cell"><span>人物</span><b class="c">${roster.length}</b></div><div class="pl-cell"><span>物品</span><b class="a">${items.length}</b></div><div class="pl-cell"><span>消息</span><b class="v">${sceneMessages().length}</b></div></div>`;
 if(n.containerLocationId&&state.viewMode==='author')body+=`<div class="detail-actions"><button class="action-btn" data-layout="${esc(n.id)}" ${D.meta.engine?.busy?'disabled':''}>${n.hasLayout?'更新布局':'生成布局'}</button><span class="scope-note">${n.hasLayout?'已保存空间布局':'尚未生成空间布局'}</span></div>`;
 if(scopedFlows?.mapId===n.id)body+=`<p class="scope-note" aria-live="polite">联系 ${scopedFlows.relations.length} · 传播 ${scopedFlows.flows.length} · 行程 ${scopedFlows.journeys.length}${state.selected?.kind==='character'?'':' · 选中人物查看联系'}</p>`;
 $('#placeCard').innerHTML=`<summary class="pl-summary"><span class="pl-name">${esc(n.name)}</span><span class="pl-summary-hint">概况</span>${icon('chev-d')}</summary><div class="pl-body">${body}</div>`;
 $('#scWorld').textContent=n.code+' · '+n.name;$('#scRatio').textContent=n.metric?'1 u ≈ '+formatDistance(n.metric):'未标定 · 坐标格';
 $('#ticker').textContent=D.EVENTS.filter(known).slice(0,2).map(e=>e.title).join('　 ·　 ');$('#ticker').style.animation='none';
}
function castCard(c,global=false){const here=within(c.locationId,state.nodeId)&&c.state==='present';return `<button class="cast-card ${state.selected?.id===c.id?'on':''}" data-select-kind="character" data-select="${esc(c.id)}" style="--ac:${c.c}"><div class="cc-top"><div class="cc-ava">${esc(c.initial)}<i class="st ${c.state==='present'?'':'off'}"></i></div><div class="cc-meta"><div class="cc-name"><b>${esc(c.name)}</b><em class="cc-tag ${c.state==='present'?'':'away'}">${esc(c.tag)}</em>${!global&&here?'<em class="cc-tag">本地图</em>':''}</div><div class="cc-sub">${esc(c.role)} · ${esc(placeName(c.locationId))}</div></div></div><div class="cc-body"><div class="cc-line"><span class="k">动作</span><span class="v">${esc(c.doing)}</span></div>${state.viewMode==='author'?`<div class="cc-line"><span class="k">想法</span><span class="v mind">${esc(c.mind)}</span></div>`:''}</div></button>`;}
function itemCard(it){return `<button class="row-item" data-select-kind="item" data-select="${esc(it.id)}"><div class="ri-ico">${icon('box')}</div><div class="ri-main"><div class="ri-t">${esc(it.name)}</div><div class="ri-s">${esc(it.description)}</div></div><div class="ri-r"><em class="tag-s ${it.holder?'g':'p'}">${it.holder?esc(D.CAST.find(c=>c.id===it.holder)?.name||'持有者'):esc(placeName(it.locationId))}</em></div></button>`;}
function messageCard(m){return `<button class="msg-card ${m.kind} ${state.selected?.id===m.id?'selected':''}" data-select-kind="message" data-select="${esc(m.id)}"><div class="mc-h"><div class="mc-src"><i class="dot"></i>${esc(m.src)}</div><em class="tag-s ${m.known?'g':'a'}">${esc(m.status)}</em></div><div class="mc-txt">${esc(m.txt)}</div>${m.status==='传播中'?`<div class="mc-prop"><div class="mc-track rumor"><i style="width:${m.pct}%"></i></div><span class="mc-pct">${m.pct}%</span></div>`:''}<div class="mc-foot">${m.hops.map(h=>`<i class="mc-hop">${esc(h)}</i>`).join('')}${!m.known?'<i class="mc-hop">主角尚未知晓</i>':''}</div></button>`;}
function empty(text){return `<div class="empty-state">${icon('layers')}<span>${esc(text)}</span></div>`;}
function field(label,value){return `<div class="detail-field"><span>${esc(label)}</span><div>${esc(value)}</div></div>`;}
function action(label,kind,id,focus=false){return `<button class="action-btn" data-${focus?'locate':'select-kind'}="${esc(kind)}" ${focus?`data-locate-id="${esc(id)}"`:`data-select="${esc(id)}"`}>${esc(label)}</button>`;}
function detailHTML(){const s=state.selected;if(!s)return '';
 if(s.kind==='place'){
  const n=byId(s.id);if(!n||!known(n))return empty('当前视角没有该地点的信息');
  const cast=sceneCast(n.id),items=sceneItems(n.id),children=(n.children||[]).filter(known);
  return `<div class="detail-tags"><em>地点</em><em>${esc(D.LEVELS.find(l=>l.key===n.kind)?.name||n.tag)}</em>${n.sceneStatus==='missing'?'<em>尚无内部结构</em>':''}</div><h3 class="detail-place-name">${esc(n.name)}</h3><p class="detail-text">${esc(n.description||'已记录的地点。')}</p>${field('所属路径',(path(n.id)||[]).filter(known).map(p=>p.name).join(' › '))}<div class="detail-actions">${(n.host&&n.id!==state.nodeId)||n.childMapIds?.length?`<button class="action-btn primary" data-go="${esc(n.childMapIds?.[0]||n.id)}">进入此地点</button>`:'<span class="scope-note">当前正在查看此地点</span>'}${
    // M6-11③：只有**用户点这个按钮**才会请求模型补结构；打开地图/切页都不会自动建设。
    n.host&&n.sceneStatus==='missing'?`<button class="action-btn" data-build-map="${esc(n.id)}">完善本图</button>`:''}</div>${
    n.host&&n.sceneStatus==='missing'?'<p class="scope-note">「完善本图」只在点击后才会调用一次模型；切页、缩放与打开地图不会自动建设。</p>':''}<div class="section-label">在这里的人物 · ${cast.length}</div>${cast.map(c=>castCard(c)).join('')||empty('这里暂无已记录的在场人物')}<div class="section-label">物品 · ${items.length}</div>${items.map(itemCard).join('')||'<p class="scope-note">暂无已记录物品</p>'}${children.length?`<div class="section-label">下属地点 · ${children.length}</div>${children.map(ch=>`<button class="child-location" data-inspect-place="${esc(ch.id)}"><i style="--ac:${color[ch.kind]}"></i><span>${esc(ch.name)}</span><em>${esc(ch.code)}</em>›</button>`).join('')}`:''}`;
 }
 if(s.kind==='character'){const c=D.CAST.find(c=>c.id===s.id);if(!c||!known(c))return empty('当前视角没有该人物的信息');return `<div class="entity-hero" style="--ac:${c.c}"><div class="entity-avatar">${esc(c.initial)}</div><div><h3>${esc(c.name)}</h3><span>${esc(c.role)}</span></div></div><div class="detail-tags"><em>${esc(c.tag)}</em><em>${esc(placeName(c.locationId))}</em></div>${field('当前行动',c.doing)}${state.viewMode==='author'?field('后台想法',c.mind):field('可见表现','仅显示主角能够观察到的行动与状态。')}${field('位置',c.state==='away'?(c.description||'目前在途'):placeName(c.locationId))}<div class="detail-actions">${action('查看地图位置','character',c.id,true)}${action('查看人物经历','timeline',c.id)}</div><div class="section-label">携带物品</div>${D.ITEMS.filter(it=>it.holder===c.id&&known(it)).map(itemCard).join('')||empty('暂无已记录的携带物品')}<div class="section-label">最近相关事件</div>${D.EVENTS.filter(e=>e.target===c.id&&known(e)).map(eventRow).join('')||'<p class="scope-note">暂无相关记录</p>'}`;}
 if(s.kind==='item'){const it=D.ITEMS.find(it=>it.id===s.id);if(!it||!known(it))return empty('当前视角没有该物品的信息');return `<div class="detail-title">${icon('box')}<h3>${esc(it.name)}</h3></div>${field('描述',it.description)}${field('当前状态',it.st)}${field('归属',it.holder?(D.CAST.find(c=>c.id===it.holder)?.name||'未知持有者'):'放置于地点')}${field('所在地点',placeName(it.locationId))}<div class="detail-actions">${action('查看地图位置','item',it.id,true)}${it.holder?action('查看持有者','character',it.holder):''}</div>`;}
 if(s.kind==='message'){const m=message(s.id);if(!m||!known(m))return empty('该消息尚未进入当前视角');return `<div class="detail-title">${icon('wave')}<h3>${esc(m.src)}</h3></div><div class="detail-tags"><em>${esc(m.status)}</em><em>${m.known?'主角已可获知':'世界后台 · 未送达主角'}</em></div><p class="detail-text">${esc(m.txt)}</p>${field('来源地点',placeName(m.locationId))}<div class="section-label">传播节点</div><div class="flow-steps">${m.hops.map((h,i)=>`<div><i>${i+1}</i><span>${esc(h)}</span></div>`).join('')}</div><div class="detail-actions"><button class="action-btn" data-show-flow="${esc(m.id)}">在地图上查看信息流</button></div>`;}
 if(s.kind==='task'){const t=task(s.id);if(!t||!known(t))return empty('当前视角没有此后台任务');return `<div class="detail-title">${icon('cpu')}<h3>${esc(t.n)}</h3></div>${field('状态',t.stName)}${field('行动',t.d)}${t.p!=null?`<div class="task-progress"><span>当前进度 ${t.p}%</span><div><i style="width:${t.p}%"></i></div></div>`:field('进度','等待条件满足，尚无可计算的进度')}<div class="detail-actions"><button class="action-btn" data-task-map="${esc(t.id)}">查看地图动向</button>${action('查看相关人物','character',t.entityId)}</div>`;}
 if(s.kind==='event'){const e=D.EVENTS.find(e=>e.id===s.id);if(!e||!known(e))return empty('当前视角没有此事件');return `<div class="detail-tags"><em>第 ${e.turn} 轮</em><em>${esc(eventKindLabel(e))}</em><em>${esc(e.t)}</em></div><h3 class="event-title">${esc(e.title)}</h3><p class="detail-text">${esc(e.detail)}</p>${field('发生地点',placeName(e.mapId))}${eventLinksHTML(e)}<div class="detail-actions">${e.target&&e.targetKind&&known(e)?action('查看相关对象',e.targetKind,e.target):''}<button class="action-btn" data-go="${esc(e.mapId)}">查看发生地点</button></div><p class="scope-note">这里展示历史记录，世界保持当前状态。</p>`;}
 if(s.kind==='lore'){const l=D.LORE.find(l=>l.id===s.id);if(!l)return '';return `<div class="detail-tags"><em>${esc(l.kind)}</em><em>${l.enabled?'已启用':'已停用'}</em></div><h3>${esc(l.title)}</h3><p class="detail-text">${esc(l.content)}</p><button class="action-btn" data-lore-target="${esc(l.id)}">查看关联对象</button>`;}
 return `<h3>${esc(s.name||'地图对象')}</h3>${field('信息',s.sub||'点击层级树可查看所属地点。')}`;
}
function renderInspector(){renderSelectionOverlay();const n=current(),sel=state.selected;if(!sel&&state.inspectorTab==='details')state.inspectorTab='cast';$('#insTitle').textContent=sel?'对象详情':n.name;const tabs=$('#inspTabs');tabs.innerHTML=sel?`<button class="it active" data-inspector="details">详情</button><button class="it" data-clear-selection>返回地点</button>`:[['cast','人物',sceneCast().length],['items','物品',sceneItems().length],['msgs','消息',sceneMessages().length],['lore','地点','']].map(([k,t,num])=>`<button class="it ${state.inspectorTab===k?'active':''}" data-inspector="${k}">${t} <em>${num}</em></button>`).join('');
 const el=$('#inspector');if(sel){el.innerHTML=detailHTML();return;}
 if(state.inspectorTab==='cast')el.innerHTML=`<div class="scope-caption">${esc(n.name)} · 本地图的人物</div>`+(sceneCast().map(c=>castCard(c)).join('')||empty('这里暂无已记录的在场人物'));
 else if(state.inspectorTab==='items')el.innerHTML=sceneItems().map(itemCard).join('')||empty('这里暂无已记录的物品');
 else if(state.inspectorTab==='msgs')el.innerHTML=sceneMessages().map(messageCard).join('')||empty('这里暂无可见消息');
 else el.innerHTML=`<h3 class="detail-place-name">${esc(n.name)}</h3><p class="detail-text">${esc(n.description||'已记录的地图与地点信息。')}</p>${field('层级路径',(path(n.id)||[]).map(p=>p.name).join(' › '))}<div class="section-label">下属地点</div>${(n.children||[]).filter(known).map(ch=>`<button class="child-location" data-go="${esc(ch.id)}"><i style="--ac:${color[ch.kind]}"></i><span>${esc(ch.name)}</span><em>${esc(ch.code)}</em>›</button>`).join('')||'<p class="scope-note">当前为最细一级空间</p>'}`;
}
function eventRow(e){return `<button class="event-row" data-event="${esc(e.id)}"><span class="event-time">${esc(e.t)}</span><em class="event-kind ${esc(e.category||e.kind||'event')}">${esc(eventKindLabel(e))}</em><span class="event-summary">${esc(e.title)}</span>${e.known?'':'<span class="event-private">后台</span>'}${icon('chev')}</button>`;}
/**
 * M6-11②③：关联对象。三条例律：
 * - 只给**当前视角看得见**的目标做链接（隐藏目标不留可点死链）；
 * - message 走消息详情，action/journey 走各自的任务/旅程详情，**不塞给只认三实体的 inspect**；
 * - 目标不在本地已加载数据里就不画按钮 —— 宁可少一个入口，也不做一个点了报错的按钮。
 */
function eventLinksHTML(e){
  // POV 下整条事件都不可见时，**任何**关联按钮都不该出现：
  // 隐藏事件本身就不该在左栏/详情里被点开，漏了这一层等于把 POV 裁掉的实体又递回给读者。
  if(!e||!known(e))return '';
  const rows=(Array.isArray(e.links)?e.links:[]).filter(l=>l&&l.id&&l.kind).map(l=>{
    if(l.kind==='message'){const m=message(l.id);if(!m||!known(m))return '';return `<button class="action-btn" data-select-kind="message" data-select="${esc(l.id)}">${esc(l.label||LINK_KIND.message)}</button>`;}
    if(l.kind==='action'||l.kind==='journey'){const t=task(l.id);if(!t||!known(t))return '';return `<button class="action-btn" data-select-kind="task" data-select="${esc(l.id)}">${esc(l.label||LINK_KIND[l.kind])}</button>`;}
    if(l.kind==='item'){const it=D.ITEMS.find(x=>x.id===l.id);if(!it||!known(it))return '';return action(l.label||'相关物品','item',l.id);}
    const c=D.CAST.find(x=>x.id===l.id);if(!c||!known(c))return '';
    return action(l.label||'相关人物','character',l.id);
  }).filter(Boolean);
  return rows.length?`<div class="section-label">关联对象</div><div class="detail-actions">${rows.join('')}</div>`:'';
}
function taskCard(t){return `<button class="task-card" style="--c:${t.c}" data-select-kind="task" data-select="${esc(t.id)}"><div class="tc-h"><span class="tc-n">${esc(t.n)}</span><em class="tc-st ${t.st}">${esc(t.stName)}</em></div><div class="tc-d">${esc(t.d)}</div>${t.p==null?'<div class="task-indeterminate">等待条件满足</div>':`<div class="tc-progress"><i style="width:${t.p}%"></i></div><div class="task-percent">${t.p}%</div>`}</button>`;}
/**
 * P14/§21.3：回执分层 —— 「世界数据已保存」/「布局：…」/「缺漏与语义：…」分开写。
 * report 由数据层从**真实结果字段**派生（见 referenceReceiptReport），这里只负责画；
 * 没有 report（普通推演回执）就不画这三行，免得凭空多出一句「布局失败」。
 */
function receiptLayers(r){const p=r.report;if(!p)return '';
  return `<ul class="receipt-layers"><li class="rl-core">${esc(p.core.label)}</li><li class="rl-layout rl-${esc(p.layout.state)}">${esc(p.layout.label)}</li><li class="rl-gaps">${esc(p.gaps.label)}</li></ul>`;}
function receiptBatches(detail){
 const attempts=Array.isArray(detail?.attempts)?detail.attempts:[];
 const plan=detail?.receipt?.requestPlan,parts=[];if(plan?.usage&&Number.isSafeInteger(plan.usage.transports))parts.push(`实际发送 ${plan.usage.transports} 次；额外 ${plan.usage.extra}/${plan.extraLimit} 次`);for(const [kind,label,unit] of [['characters','人物','位'],['maps','地图','张']]){
  const batches=attempts.filter(a=>a.target_kind===kind&&Number.isSafeInteger(a.target_count)&&a.target_count>0).map(a=>a.target_count);
  if(batches.length)parts.push(`${label} ${batches.length} 批（${batches.join(' / ')} ${unit}）`);
 }return parts.length?`<p class="scope-note">本轮合批：${esc(parts.join('；'))}</p>`:'';
}
function receiptCard(r){const partial=r.detail?.receipt?.status==='partial',status=partial?'部分成功':{committed:'已提交',duplicate:'重复回执',failed:'失败','pending-review':'待审阅'}[r.status]||r.status,detail={status:r.status,...(r.detail??{}),...(r.logs?.length?{logs:r.logs}:{})};return `<div class="receipt-row"><i class="rc-ok ${r.ok&&!partial?'':'rc-fail'}"></i><div><b>推演回执 · ${esc(status)} · ${esc(r.t)}</b><p>${esc(r.m)}</p>${receiptLayers(r)}${receiptBatches(r.detail)}${r.issue?`<code>${esc(r.issue)}</code>`:''}<details class="diagnostic-row"><summary>查看本轮日志</summary><pre>${esc(JSON.stringify(detail,null,2))}</pre></details></div>${r.retryable?`<button class="action-btn" data-retry="${esc(r.id)}">重试失败项</button>`:r.ok?`<span class="receipt-done">${esc(status)}</span>`:'<button class="action-btn" data-page="diag">查看诊断</button>'}</div>`;}
function enginePhaseText(engine=D.meta.engine??{}){return {'awaiting-reply':'等待酒馆正文完成…',queued:'推演排队中…','reading-context':'正在读取推演资料…',committing:'正在推演，等待回执…'}[engine.phase]||'正在处理…';}
function renderDock(){
 $$('#dockTabs .dt').forEach(b=>{b.classList.toggle('active',b.dataset.tab===state.dock);b.setAttribute('aria-selected',b.dataset.tab===state.dock);});
 const el=$('#dockBody');
 // §21.4：待确认的回退影响面板永远排在最前 —— 它是执行前必须看到的东西。
 const rb=rollbackPanel();
 if(rb){el.innerHTML=rb;return;}
 if(state.dock==='log'){const now=turnEvents(),old=historyEvents();
   el.innerHTML=`<div class="section-label">本轮世界动向 · ${now.length}</div><div class="event-list">${now.map(eventRow).join('')||'<p class="scope-note">本轮暂无新的世界动向</p>'}</div>`+
     (old.length?`<div class="section-label">历史记录 · ${old.length}</div><div class="event-list">${old.slice(0,60).map(eventRow).join('')}</div>`:'');}
 else if(state.dock==='tasks')el.innerHTML=`<div class="task-grid">${D.TASKS.filter(known).map(taskCard).join('')||empty('当前视角暂无后台任务')}</div>`;
 else if(state.dock==='receipt')el.innerHTML=(D.RECEIPTS.length?'<button class="action-btn" data-export="receipts">导出推演回执</button>':'')+D.RECEIPTS.map(receiptCard).join('')+(D.meta.engine?.error?`<div class="receipt-row"><i class="rc-ok rc-fail"></i><div><b>当前错误</b><p>${esc(D.meta.engine.error)}</p></div><button class="action-btn" data-page="diag">查看诊断</button></div>`:'')+(!D.RECEIPTS.length&&!D.meta.engine?.error?empty(D.meta.engine?.busy?'正在推演，等待回执…':'尚无推演回执；首次推演完成后在此查看结果与日志'):'');
 else el.innerHTML=`<div class="prop-grid">${D.MESSAGES.filter(known).map(m=>`<button class="propagation-row" data-show-flow="${esc(m.id)}"><i class="pd sm"></i><div><b>${esc(m.src)}</b><span>${esc(m.hops.join(' → '))}</span></div><em>${esc(m.status)}</em>${icon('chev')}</button>`).join('')}</div>`+(scopedFlows?.cards??[]).map(c=>`<p class="scope-note">${esc(c.name)} · ${{NO_ROUTE_GEOMETRY:'缺少已保存路线，暂不画线',ENDPOINTS_NOT_ON_MAP:'两端未定位在本图',ARRIVED_FRONT:'已到达；没有可显示的传播路径',SCALE_UNKNOWN:'地图尺度未标定',CROSS_MAP:'路径位于其他地图'}[c.reason]||'暂无可绘制路径'}</p>`).join('');
 $('#turnChip').textContent=`第 ${D.meta.turn} 轮 · ${clock()}`;
 $('#queueLabel').textContent=`${D.TASKS.filter(t=>known(t)&&t.st!=='done').length} 项后台动向`;
 $('#dockTabs [data-tab="tasks"] em').textContent=D.TASKS.filter(known).length;
 $('#syncText').textContent=`${D.meta.engine?.busy?enginePhaseText()+' · ':D.meta.engine?.error?'推演失败 · ':D.meta.snapshotSaved===false?'等待首次保存 · ':''}修订 ${D.meta.revision} · ${clock()}`;
 $('#undoDemo').disabled=!D.meta.canUndo;
 const engine=D.meta.engine??{};$('#nextDemo').disabled=!!engine.busy||!engine.hasChat||!engine.sqlEnabled||engine.bound&&!engine.enabled;$('#nextDemo').textContent=engine.busy?enginePhaseText(engine):engine.bound?'立即推演':'建立当前世界';
}
function pageHeader(title,sub,extra=''){return `<div class="workspace-header"><div><span class="workspace-eyebrow">ATLAS · ${esc(D.meta.worldName)}</span><h2>${esc(title)}</h2><p>${esc(sub)}</p></div>${extra}</div>`;}
function renderPage(){presetUI.captureState();const el=$('#workspacePage');el.hidden=effectivePage()==='map';$('#viewport').classList.toggle('page-open',effectivePage()!=='map');
 if(effectivePage()==='map'){if(state.page==='map')el.replaceChildren();return;}
 const descriptions={cast:'查看当前世界已记录的人物；选择卡片查看详情与位置。',items:'查看放置于地点或由人物持有的物品。',msgs:'查看已送达、传播中与待核实的消息。',sim:'查看后台准备、旅行与消息传播，选择任务可联动地图。',time:'按回合查看世界发生过的事情。',lore:'浏览启用资料与地图、人物之间的关联。',diag:'所有问题汇总在同一时间线，可展开完整内容。',prefs:'自由编辑分段角色与内容，调整界面外观。'};
 el.innerHTML=pageHeader(names[state.page],descriptions[state.page],`<button class="action-btn" data-page="map">${icon('map')}返回地图</button>`);
 if(['cast','items','msgs'].includes(state.page)){
  const options=state.page==='cast'?[['all','全部人物'],['here','当前地点'],['travel','在途'],['away','其他地点']]:state.page==='items'?[['all','全部物品'],['ground','地点物品'],['held','人物持有']]:[['all','全部消息'],['delivered','已送达'],['rumor','传播与传闻'],['disputed','待核实']];
  el.innerHTML+=`<div class="catalog-toolbar"><label class="search-field">${icon('search')}<input id="catalogSearch" aria-label="搜索${esc(names[state.page])}" placeholder="搜索名称、地点或内容…" value="${esc(state.query)}"></label><div class="catalog-filters">${options.map(([k,t])=>`<button class="filter-btn ${state.filter===k?'on':''}" data-catalog-filter="${k}">${t}</button>`).join('')}</div></div><div class="catalog-count" id="catalogCount"></div><div class="catalog-grid ${state.page}" id="catalogResults"></div>`;renderCatalog();
 }else if(state.page==='sim'){const events=turnEvents();
  el.innerHTML+=simulationControlsHTML()+`<div class="full-task-grid">${D.TASKS.filter(known).map(taskCard).join('')}</div><div class="section-label">本轮世界动向</div><div class="event-list">${events.slice(0,3).map(eventRow).join('')||'<p class="scope-note">本轮暂无新的世界动向</p>'}</div>`+(events.length>3?`<p class="scope-note">另有 ${events.length-3} 条动向在下方事件栏</p>`:'');}
 else if(state.page==='time')el.innerHTML+=timelineHTML();
 else if(state.page==='lore')el.innerHTML+=`<p class="scope-note">酒馆启停控制正常聊天中的世界书；ATLAS 读取开关仅控制插件推演、建图和布局的资料输入。同一世界书条目的读取设置会保留并用于其他聊天。</p><div class="lore-grid">${D.LORE.map(l=>`<article class="lore-card"><div><em class="tag-s ${l.enabled?'g':'a'}">${l.enabled?'已启用':'已停用'}</em><em class="tag-s ${l.atlasReadable===false?'a':'g'}">${l.atlasReadable===false?'ATLAS 不读取':'ATLAS 读取'}</em><span>${esc(l.kind)}</span></div><button class="lore-title" data-select-kind="lore" data-select="${esc(l.id)}">${esc(l.title)}</button><p>${esc(l.content)}</p><div class="lore-actions"><button class="action-btn" data-lore-target="${esc(l.id)}">查看关联对象</button><button class="action-btn" role="switch" aria-checked="${l.atlasReadable!==false}" aria-label="ATLAS 读取：${esc(l.title)}" data-lore-read-toggle="${esc(l.id)}" data-lore-read-enabled="${l.atlasReadable===false}">${l.atlasReadable===false?'开启 ATLAS 读取':'关闭 ATLAS 读取'}</button><button class="text-btn" data-lore-toggle="${esc(l.id)}">${l.enabled?'停用':'启用'}</button></div></article>`).join('')}</div>`;
 else if(state.page==='diag'){el.innerHTML+=diagnosticsHTML();refreshBackupStatus();}
 else if(state.page==='prefs')el.innerHTML+=settingsHTML();
}
function renderCatalog(){const q=state.query.trim().toLowerCase(),f=state.filter,p=state.page;let list=p==='cast'?D.CAST:p==='items'?D.ITEMS:D.MESSAGES;
 list=list.filter(known).filter(o=>JSON.stringify(o).toLowerCase().includes(q));
 if(p==='cast')list=list.filter(c=>f==='all'||f==='here'&&sceneCast().some(v=>v.id===c.id)||f==='travel'&&c.state==='away'||f==='away'&&!sceneCast().some(v=>v.id===c.id)&&c.state!=='away');
 if(p==='items')list=list.filter(it=>f==='all'||f==='held'&&it.holder||f==='ground'&&!it.holder);
 if(p==='msgs')list=list.filter(m=>f==='all'||m.kind===f);
 $('#catalogCount').textContent=`${list.length} 条记录 · ${state.viewMode==='author'?'世界后台':'主角所知'}`;
 $('#catalogResults').innerHTML=list.length?list.map(o=>p==='cast'?castCard(o,true):p==='items'?itemCard(o):messageCard(o)).join(''):empty('没有符合条件的记录');
}
function timelineHTML(){const turns=[...new Set(D.EVENTS.filter(known).map(e=>e.turn))];return `<div class="timeline">${turns.map(t=>`<section><div class="timeline-turn"><i></i><span>第 ${t} 轮</span><em>${esc(D.EVENTS.find(e=>e.turn===t).t)}</em></div><div class="timeline-events">${D.EVENTS.filter(e=>e.turn===t&&known(e)).map(eventRow).join('')}</div></section>`).join('')}</div>`;}
function simulationControlsHTML(){const e=D.meta.engine??{},status=!e.hasChat?'请先打开一个聊天':!e.sqlEnabled?'SQL 世界数据已关闭':!e.bound?'尚未建立世界':e.enabled?'本聊天推演已启用':'本聊天推演已停用';return `<div class="simulation-banner"><span class="pd"></span><div><b>${esc(status)}</b><span>世界时间 ${clock()} · 浏览与动画不会推进世界时间</span></div><button class="action-btn primary" data-demo-next ${e.busy||!e.hasChat||!e.sqlEnabled||e.bound&&!e.enabled?'disabled':''}>${e.busy?'正在处理…':e.bound?'立即推演':'建立当前世界'}</button></div><div class="detail-actions">${e.bound?`<button class="action-btn" data-engine-enable="${e.enabled?'false':'true'}" ${e.busy||!e.sqlEnabled?'disabled':''}>${e.enabled?'暂停本聊天推演':'启用本聊天推演'}</button>`:''}<button class="action-btn" data-open-backend="connection">API 连接</button><button class="action-btn" data-open-backend="prompts">提示词</button><button class="action-btn" data-open-backend="assignments">任务与分批</button><button class="action-btn" data-page="diag">查看诊断</button></div>${e.error?`<div class="receipt-row"><i class="rc-ok rc-fail"></i><div><b>最近一次操作失败</b><p role="alert" data-engine-error>${esc(e.error)}</p></div><button class="action-btn" data-page="diag">查看详细日志</button></div>`:''}<div class="section-label">推演回执</div>${D.RECEIPTS.map(receiptCard).join('')||empty(e.busy?'正在推演，等待回执…':'尚无推演回执')}<p class="scope-note">连接与提示词在此工作台内设置；世界引擎运行在浏览器中，世界数据随当前酒馆聊天保存。</p>`;}
/**
 * M6-16：统一诊断页。
 *
 * 一次推演会同时来自 host / model / storage / layout / world-build 与回执，
 * 旧实现把两边的错误各列一份，用户得在两个页面之间猜哪份才是全的。
 * 现在**只剩这一份**：按真实 trace（没有 trace 时退回阶段）分组，每条都带
 * stage / code / opId / group / line / path —— 一次 layout 的每一处问题都能查到具体位置。
 */
function diagnosticMeta(d){
  const t=d&&typeof d.details==='object'&&d.details?d.details:{},bits=[];
  if(d?.phase)bits.push(`阶段 ${d.phase}`);
  if(d?.operation)bits.push(`动作 ${d.operation}`);
  if(t.stage)bits.push(`stage ${t.stage}`);
  if(t.opId)bits.push(`opId ${t.opId}`);
  if(t.groupId)bits.push(`group ${t.groupId}`);
  if(t.line!==undefined&&t.line!==null)bits.push(`line ${t.line}`);
  if(t.path)bits.push(`path ${t.path}`);
  if(t.route)bits.push(`route ${t.route}`);
  if(d?.errorCode)bits.push(`错误码 ${d.errorCode}`);
  if(d?.causeCode)bits.push(`底层原因 ${d.causeCode}`);
  if(d?.requestRef)bits.push(`请求 ${d.requestRef}`);
  if(t.turnRef)bits.push(`回合 ${t.turnRef}`);
  if(typeof d?.durationMs==='number')bits.push(`耗时 ${d.durationMs}ms`);
  if(typeof t.timeoutMs==='number')bits.push(`超时 ${t.timeoutMs}ms`);
  if(typeof t.transportAttempt==='number')bits.push(`第 ${t.transportAttempt} 次发送`);
  if(typeof d?.count==='number'&&d.count>1)bits.push(`折叠 ${d.count} 条同类日志`);
  if(typeof t.coreSaved==='boolean')bits.push(t.coreSaved?'已确认保存':'未确认保存');
  if(typeof t.retryable==='boolean')bits.push(t.retryable?'可重试':'不可重试');
  if(Array.isArray(t.issues)&&t.issues.length)bits.push(`${t.issues.length} 项问题`);
  return bits.join(' · ');
}
function diagnosticGroups(rows){
  const groups=new Map();
  for(const d of rows){const key=String(d.details?.turnRef??d.traceId??d.requestRef??d.turnId??d.phase??'其他记录');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(d);}
  return [...groups.entries()];
}
function backupPanelHTML(){
  const b=state.backup;
  const status=!b?'正在检查升级前备份…':b.available?`可导出 · SHA256 ${esc(String(b.sha||'').slice(0,16))}… · ${esc(String(b.createdAt||''))}`:`不可导出：${esc(b.reason||'当前聊天没有持久备份')}`;
  return `<section class="backup-panel"><div class="section-label">升级前原档</div><p class="scope-note">只保留最近一次升级前的原档；导出是只读操作，不会改动当前数据库，也不会清除备份。</p><div class="detail-actions"><button class="action-btn" data-backup-export ${b?.available?'':'disabled'}>导出升级前备份</button><button class="action-btn" data-backup-recheck>重新检查</button></div><p class="scope-note" data-backup-status>${status}</p></section>`;
}
function diagnosticsHTML(){return `<div class="catalog-toolbar"><label class="search-field">${icon('search')}<input id="diagnosticSearch" placeholder="搜索错误代码、内容或字段路径…" aria-label="搜索诊断"></label><select id="diagnosticLevel" aria-label="日志等级"><option value="all">全部等级</option><option value="error">错误</option><option value="warn">警告</option><option value="info">信息</option><option value="debug">调试</option></select><button class="action-btn" data-copy-diagnostics>复制当前列表</button><button class="action-btn" data-export="diagnostics">导出日志</button></div>${backupPanelHTML()}<div id="diagnosticRows">${diagnosticRows()}</div>`;}
function diagnosticRows(q='',level='all'){
  const rows=D.DIAGNOSTICS.filter(d=>(level==='all'||d.level===level)&&JSON.stringify(d).toLowerCase().includes(q.toLowerCase()));
  if(!rows.length)return empty('没有符合条件的日志');
  return diagnosticGroups(rows).map(([key,list])=>`<section class="diagnostic-group"><div class="section-label">${esc(key)} · ${list.length} 项</div>${list.map(d=>{const meta=diagnosticMeta(d);return `<details class="diagnostic-row ${esc(d.level)}" data-diagnostic-id="${esc(d.id)}"><summary><time>${esc(d.t)}</time><em>${esc(d.level)}</em><div><b>${esc(d.code)}</b><span>${esc(d.message)}</span>${meta?`<code class="diag-meta">${esc(meta)}</code>`:''}</div>${icon('chev')}</summary><pre>${esc(JSON.stringify(d,null,2))}</pre></details>`;}).join('')}</section>`).join('');
}
function settingsHTML(){const tabs=[['prompts','提示词'],['connection','API 连接'],['assignments','任务与分批'],['interaction','地图交互'],['appearance','外观']];let html=`<div class="settings-tabs" role="tablist" aria-label="预设分类">${tabs.map(([id,t])=>`<button class="filter-btn ${state.settingsTab===id?'on':''}" data-settings-tab="${id}" role="tab" aria-selected="${state.settingsTab===id}">${t}</button>`).join('')}</div>`;
 if(state.settingsTab==='interaction')return html+`<div class="appearance-form"><h3>地图交互</h3><label class="appearance-row"><span>单击地点直接进入子地图</span><input type="checkbox" data-single-click-enter ${state.singleClickEnter?'checked':''}></label><p class="scope-note">默认关闭：单击地点查看右栏信息，再点击「进入此地点」。人物、物品与消息始终单击查看详情。</p><label class="appearance-row"><span>收起地图工具</span><input type="checkbox" data-map-widgets-collapsed ${state.mapWidgetsCollapsed?'checked':''}></label><p class="scope-note">默认只显示「地图工具」入口，点击可展开地点卡、视图选择、缩放、小地图、图例和状态条；不改变地图位置或缩放。</p><label class="appearance-row"><span>收起地图图例</span><input type="checkbox" data-legend-collapsed ${state.legendCollapsed?'checked':''}></label><p class="scope-note">图例固定收纳在比例尺上方。比例尺长度保持不变，缩放只改变距离数值。</p><p class="scope-note">${preferences.persistent?'交互偏好保存在当前浏览器。':'当前环境无法保存到浏览器，偏好在本次打开期间有效。'}</p></div>`;
 if(state.settingsTab!=='appearance')return html+presetUI.render(state.settingsTab);
 return html+window.AtlasAppearance.appearanceSettingsHTML({skin:skinValue(),catalog:skinCatalog,runtime:window.AtlasSkinRuntime});
}
function renderAll({preserveWorkspace=false}={}){renderRail();renderCrumbs();renderLadder();renderTree();renderSwitches();renderChips();renderPlace();renderInspector();renderDock();if(!preserveWorkspace)renderPage();renderModes();applyUIProfile();}
function renderModes(){$('#mapModeSwitcher').value=state.mapMode;}
function showFlow(id){const m=message(id);if(!m||!known(m))return;let destination=Object.keys(D.FLOWS).find(mapId=>(D.FLOWS[mapId]||[]).some(e=>e.id===id)&&mapId===state.nodeId)||Object.keys(D.FLOWS).find(mapId=>(D.FLOWS[mapId]||[]).some(e=>e.id===id));destination=destination||m.mapNodeId||m.locationId;state.mapMode='flow';navigate(destination,true);map.setMode('flow');select('message',id,true);renderModes();}
function showTask(id){const t=task(id);if(!t||!known(t))return;state.mapMode='sim';navigate(t.mapId,true);map.setMode('sim');select('task',id,true);renderModes();}
function showEvent(id){const e=D.EVENTS.find(e=>e.id===id);if(!e||!known(e))return;if(byId(e.mapId))navigate(e.mapId,true);select('event',id,true);map.selectKey(e.target);}
function openRight(){if(ui.resolveUIProfile(state.profileId).profile.behavior.selectionPresentation==='map-overlay'){renderSelectionOverlay();return;}state.rightClosed=false;$('#panelRight').classList.remove('collapsed');root.classList.toggle('right-open',root.clientWidth<=720);$('#reopenRight').hidden=false;later(()=>map.resize(),280);}
function togglePanel(side){const left=side==='left',key=left?'leftClosed':'rightClosed',panel=$(left?'#panelLeft':'#panelRight');state[key]=!state[key];panel.classList.toggle('collapsed',state[key]);root.classList.toggle(left?'left-open':'right-open',!state[key]&&root.clientWidth<=(left?960:720));$(left?'#reopenLeft':'#reopenRight').hidden=false;later(()=>map.resize(),280);}
function toast(text,kind='ok'){const n=document.createElement('div');n.className='toast '+kind;const dot=document.createElement('i');dot.className='td';const span=document.createElement('span');span.textContent=text;n.append(dot,span);$('#toastWrap').append(n);later(()=>{n.classList.add('out');later(()=>n.remove(),320);},2400);}
function diagnostic(level,code,message,details=''){D.DIAGNOSTICS.unshift({id:'diag-'+Date.now(),t:clock()+':00',level,source:'preview',code,message,details});}
function advanceDemo(){state.dock='receipt';$('#dock').classList.remove('collapsed');renderDock();return runHost('advance','推演请求已处理');}
/**
 * P14/§21.4：回退必须先看真实影响再执行。
 *
 * 第一次点击只取**只读计划**（服务端同一个 planRollback）并弹影响面板；面板上的
 * 「确认回退」才真的执行。旧宿主没有 rollbackPreview 时保持原行为（直接执行），
 * 免得老宿主点了没反应。
 */
let rollbackPreview=null;
function rollbackPanel(){
  const p=rollbackPreview;if(!p)return '';
  const floors=p.affectedTurns.map(t=>t.floor??t.turnId).filter(Boolean);
  const list=(p.withheld?'（当前为主角视角，只给计数）':floors.length?floors.map(f=>`<li>${esc(f)}</li>`).join(''):'<li>无</li>');
  const maps=p.withheld?'':(p.affectedMaps.length?p.affectedMaps.map(id=>`<li>${esc(id)}</li>`).join(''):'<li>无</li>');
  const scopes=p.withheld?'':(p.affectedProgressScopes.length?p.affectedProgressScopes.map(k=>`<li>${esc(k)}</li>`).join(''):'<li>无</li>');
  return `<div class="receipt-row" data-rollback-preview>
    <i class="rc-ok rc-fail"></i><div><b>回退影响预览 · 目标楼层 ${esc(p.targetFloor??p.targetTurnId)}</b>
    <ul class="receipt-layers">
      <li class="rl-core">将一并撤销 ${p.affectedTurnCount} 楼（含目标楼）· 其中手动建设 ${p.manualTurnCount} 楼 · 计划步骤 ${p.steps} 步</li>
      <li class="rl-gaps">受影响地图：${p.withheld?'—':'见下'} · 建设进度范围：${p.withheld?'—':'见下'}</li>
      <li>时钟：${Math.round(p.clockBeforeS)} → ${Math.round(p.clockTargetS)} 秒</li>
    </ul>
    <details class="diagnostic-row" open><summary>受影响的楼层 / 地图 / 进度范围</summary>
      <div class="prop-grid"><div><span class="scope-note">楼层</span><ul class="receipt-layers" data-rollback-floors>${list}</ul></div>
      <div><span class="scope-note">地图</span><ul class="receipt-layers" data-rollback-maps>${maps}</ul></div>
      <div><span class="scope-note">建设进度范围</span><ul class="receipt-layers" data-rollback-scopes>${scopes}</ul></div></div></details>
    </div>
    <button class="action-btn" data-rollback-confirm>确认回退</button>
    <button class="action-btn" data-rollback-cancel>取消</button></div>`;
}
async function undoDemo(){
  if(rollbackPreview){rollbackPreview=null;return runHost('undo','世界已回退');}
  const host=window.AtlasHost??{};
  if(typeof host.rollbackPreview!=='function')return runHost('undo','世界已回退');
  let preview=null;
  try{preview=await host.rollbackPreview();}catch(error){toast(error.message,'warn');return;}
  if(preview===null||preview===undefined)return runHost('undo','世界已回退');
  rollbackPreview=preview;state.dock='receipt';$('#dock').classList.remove('collapsed');renderDock();
}
function cancelRollback(){rollbackPreview=null;renderDock();}
function resetDemo(){return runHost('refresh','已刷新当前世界');}
function retry(){return runHost('retry','重试请求已处理');}
 function generateLayout(id=state.nodeId){return runHost('layout','空间布局已保存',id);}
function switchView(){return window.AtlasHost.setViewMode(state.viewMode==='author'?'pov':'author').catch(error=>toast(error.message,'warn'));}
function download(name,content,type='application/json'){if(window.AtlasHost.downloadFile){window.AtlasHost.downloadFile(name,content,type);return;}const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();later(()=>URL.revokeObjectURL(url),1000);}
/** M6-11③：显式建设本图。切页/缩放/打开地图都不会走到这里，只有按钮会。 */
function buildMap(mapId){return runHost('build','本图建设已提交',mapId,{mode:'local'});}
/** M6-18：导出升级前原档。失败必须给明确原因并写进统一诊断，成功则让用户核对 SHA256。 */
function exportUpgradeBackup(){
  const host=window.AtlasHost;
  if(typeof host?.exportUpgradeBackup!=='function'){toast('当前宿主不支持导出升级前备份','warn');return Promise.resolve();}
  return Promise.resolve(host.exportUpgradeBackup()).then(({backup,envelope})=>{
    const at=Number(backup?.createdAtMs);
    const stamp=new Date(Number.isFinite(at)&&at>0?at:Date.now()).toISOString().replace(/[:.]/g,'-');
    download(`atlas-upgrade-backup-${stamp}.json`,JSON.stringify(envelope,null,2));
    toast(`升级前备份已导出 · SHA256 ${String(backup?.envelopeSha256??'').slice(0,12)}…`);
    state.backup={available:true,sha:backup?.envelopeSha256??'',createdAt:Number.isFinite(at)&&at>0?new Date(at).toLocaleString('zh-CN',{hour12:false}):'时间未知'};
    renderPage();
  }).catch(error=>{toast(error.message,'warn');diagnostic('error','UPGRADE_BACKUP_EXPORT_FAILED',error.message,{stage:'world-build'});renderPage();});
}
/** 只在诊断页首次渲染时探一次（只读路由，不改库、不下载、不清除备份）。 */
function refreshBackupStatus(force=false){
  const host=window.AtlasHost;
  if(!host?.exportUpgradeBackup||(!force&&state.backupChecked))return;
  state.backupChecked=true;
  Promise.resolve(host.exportUpgradeBackup()).then(({backup})=>{
    const at=Number(backup?.createdAtMs);
    state.backup={available:true,sha:backup?.envelopeSha256??'',createdAt:Number.isFinite(at)&&at>0?new Date(at).toLocaleString('zh-CN',{hour12:false}):'时间未知'};
  }).catch(error=>{state.backup={available:false,reason:error.message};}).finally(()=>{if(state.page==='diag')renderPage();});
}
function copyDiagnostics(){
  const rows=diagnosticGroups(D.DIAGNOSTICS.filter(d=>(($('#diagnosticLevel')?.value)||'all')==='all'||d.level===($('#diagnosticLevel')?.value))).map(([key,list])=>[`## ${key}`,...list.map(d=>JSON.stringify(d))].join('\n')).join('\n\n');
  if(!navigator.clipboard?.writeText){toast('当前环境不支持剪贴板，请使用「导出日志」','warn');return;}
  void navigator.clipboard.writeText(rows).then(()=>toast('诊断已复制到剪贴板')).catch(error=>toast(error.message,'warn'));
}
async function exportData(kind){
 if(kind==='map'){
  try{
   const result=await window.AtlasHost.exportMap(current().id);
   mapExportText=JSON.stringify(result.file,null,2);
   if(mapExportUrl)URL.revokeObjectURL(mapExportUrl);
   mapExportUrl=URL.createObjectURL(new Blob([mapExportText],{type:'application/json'}));
   modal('导出当前地图',`<p>已准备 ${result.file.scope.mapCount} 张地图（含子图）的布局、坐标与组装约束。</p><p><a class="action-btn" href="${esc(mapExportUrl)}" download="${esc(result.filename)}">下载地图 JSON</a> <button class="action-btn" data-copy-map-export>复制地图 JSON</button></p><p class="scope-note">此文件用于分析，不是可直接导入的存档。</p><details><summary>查看 JSON</summary><pre>${esc(mapExportText)}</pre></details>`);
   if(window.AtlasHost.downloadMap){const text=mapExportText;$('#modalBody a[download]').onclick=event=>{event.preventDefault();window.AtlasHost.downloadMap(result.filename,text);};}
  }catch(error){toast(error.message,'warn');}
 }else if(kind==='receipts')download('atlas-turn-receipts.json',JSON.stringify(D.RECEIPTS,null,2));else if(kind==='diagnostics')download('atlas-preview-diagnostics.jsonl',D.DIAGNOSTICS.map(d=>JSON.stringify(d)).join('\n'),'application/x-ndjson');else if(Object.keys(skinValue().assets).length)download('atlas-skin.zip',await appearance.exportPack(),'application/zip');else download('atlas-ui-theme.json',JSON.stringify(skinValue(),null,2));
}
function skinValue(){return clone(activeSkin);}
function applySkin(value,resources={}){const result=window.AtlasSkinRuntime.apply(value,{root,map,resources});if(result.ok){activeSkin=result.skin;state.accent=activeSkin.tokens['ui.accent']||'#43e0ff';state.motion=activeSkin.options.motion;renderSwitches();}return result;}
async function refreshSkinCatalog(){const sequence=++skinCatalogSequence,rows=await appearance.list();if(!disposed&&sequence===skinCatalogSequence){skinCatalog=rows;if(state.page==='prefs'&&state.settingsTab==='appearance')renderPage();}}
const appearance=window.AtlasAppearance.createAppearanceController({runtime:window.AtlasSkinRuntime,host:window.AtlasHost,apply:applySkin,getSkin:skinValue,diagnostic:entry=>window.AtlasHost.diagnostic(entry)});
async function setSkin(value){const result=await appearance.setSkin(value);if(!result.ok&&result.errorCode!=='SKIN_SUPERSEDED')toast(result.message||result.errorCode,'warn');if(result.ok)await resizeAfterLayout();return result;}
async function setTheme(id){return setSkin(id);}
async function updateSkin(section,key,value){const next=skinValue();next[section][key]=value;return setSkin(next);}
async function importSkin(file){const result=await appearance.importFile(file);if(result.ok){await refreshSkinCatalog();toast(result.saved?'皮肤已安装并保存':'皮肤已应用，本次预览尚未保存');renderPage();}else if(result.errorCode!=='SKIN_SUPERSEDED')toast(result.message||result.errorCode,'warn');return result;}

function modal(title,body){$('#modalTitle').textContent=title;$('#modalBody').innerHTML=body;$('#demoModal').hidden=false;$('#modalClose').focus();}
let paletteList=[],paletteIndex=0;
function paletteCommands(){return [
 ...nodes().filter(n=>(path(n.id)||[]).every(known)).map(n=>({title:n.name,sub:'地点 · '+(path(n.id)||[]).slice(-3).map(p=>p.name).join(' › '),run:()=>inspectPlace(n.id,true)})),
 ...D.CAST.filter(known).map(c=>({title:c.name,sub:'人物 · '+placeName(c.locationId),run:()=>showEntity('character',c.id,true)})),
 ...D.ITEMS.filter(known).map(it=>({title:it.name,sub:'物品 · '+placeName(it.locationId),run:()=>showEntity('item',it.id,true)})),
 ...D.MESSAGES.filter(known).map(m=>({title:m.src,sub:'消息 · '+m.status,run:()=>showFlow(m.id)})),
 {title:'预设与设置',sub:'API、提示词与地图交互',run:()=>setPage('prefs')},
 {title:'立即推演',sub:'观察人物、事件与消息变化',run:advanceDemo},
 {title:'生成当前地图布局',sub:'绘制房间、陈设与城市范围',run:()=>generateLayout()},
 {title:'回退演示回合',sub:'恢复人物、时间与消息',run:undoDemo}
 ];}
function paletteSuggestions(){
 const chain=path(state.nodeId)||[],parent=chain[chain.length-2],list=[{title:'查看当前位置',sub:current().name,run:()=>inspectPlace(state.nodeId)}];
 if(parent)list.push({title:'返回上级地图',sub:parent.name,run:()=>navigate(parent)});
 if(state.nodeId!==D.ROOT.id&&parent?.id!==D.ROOT.id)list.push({title:'返回世界地图',sub:D.ROOT.name,run:()=>navigate(D.ROOT)});
 list.push({title:'预设与设置',sub:'API、提示词与地图交互',run:()=>setPage('prefs')});return list;
}
function renderPalette(){
 const q=$('#palInput').value.trim(),result=q?ui.search(paletteCommands(),q):{entries:paletteSuggestions(),total:0};
 paletteList=result.entries;paletteIndex=Math.max(0,Math.min(paletteIndex,paletteList.length-1));
 $('#palCount').textContent=q?(result.total>paletteList.length?`显示 ${paletteList.length} / ${result.total} 项 · 继续输入缩小范围`:`${result.total} 项匹配`):'常用入口 · 输入名称搜索';
 $('#palList').innerHTML=paletteList.map((c,i)=>`<button class="pal-i ${i===paletteIndex?'sel':''}" data-command="${i}"><span class="pi-i">${icon('search')}</span><span class="pi-t">${esc(c.title)}<small>${esc(c.sub)}</small></span></button>`).join('')||empty('没有匹配的对象');
 $('#palList .sel')?.scrollIntoView({block:'nearest'});
}
function openPalette(){$('#paletteWrap').classList.add('on');$('#palInput').value='';paletteIndex=0;renderPalette();$('#palInput').focus();}
function closePalette(){$('#paletteWrap').classList.remove('on');}
function runCommand(i=paletteIndex){const c=paletteList[i];if(!c)return;closePalette();c.run();}
function applyInteractionPreferences(){
 const widgets=$('#mapHudWidgets'),toggle=$('#mapWidgetsToggle'),wasHidden=widgets.hidden;
 if(state.mapWidgetsCollapsed&&widgets.contains(document.activeElement))toggle.focus({preventScroll:true});
 widgets.hidden=state.mapWidgetsCollapsed;
 toggle.setAttribute('aria-expanded',String(!state.mapWidgetsCollapsed));
 toggle.querySelector('span').textContent=state.mapWidgetsCollapsed?'地图工具':'收起工具';
 if(wasHidden&&!widgets.hidden)map.resize();
 $('#legend').classList.toggle('collapsed',state.legendCollapsed);
 $('#legendToggle').textContent=state.legendCollapsed?'展开':'收起';
 $('#legendToggle').setAttribute('aria-expanded',String(!state.legendCollapsed));
 $('#map').setAttribute('aria-label','世界地图；拖动平移，滚轮缩放，单击地点'+(state.singleClickEnter?'进入子地图':'查看信息'));
}
function setPreference(key,value){
 if(!preferences.set(key,value))return;
 state[key]=value;applyInteractionPreferences();
 if(!preferences.persistent)toast('当前环境无法保存，偏好在本次打开期间有效','warn');
}
function bind(){
 listen(root,'click',async e=>{
  const b=e.target.closest('button,[data-view],.rail-ava');if(!b||b.disabled)return;
  if(await presetUI.click(b))return;
  if(b.hasAttribute('data-engine-enable')){await runHost('setEnabled','推演开关已更新',b.dataset.engineEnable==='true');return;}
  if(b.dataset.openBackend){state.settingsTab=b.dataset.openBackend;setPage('prefs');return;}
  if(b.dataset.page){setPage(b.dataset.page);return;}if(b.dataset.view){setPage(b.dataset.view);return;}
  if(b.dataset.go){navigate(b.dataset.go);return;}
  if(b.dataset.inspectPlace){inspectPlace(b.dataset.inspectPlace);return;}
  if(b.dataset.expand){const id=b.dataset.expand;state.open.has(id)?state.open.delete(id):state.open.add(id);renderTree();return;}
  if(b.dataset.selectKind){if(b.dataset.selectKind==='timeline'){setPage('time');return;}showEntity(b.dataset.selectKind,b.dataset.select);return;}
  if(b.dataset.locate){showEntity(b.dataset.locate,b.dataset.locateId,true);return;}
  if(b.dataset.inspector){state.inspectorTab=b.dataset.inspector;renderInspector();return;}
  if(b.hasAttribute('data-clear-selection')){state.selected=null;state.inspectorTab='cast';renderInspector();return;}
  if(b.dataset.flag){map.setFlag(b.dataset.flag,!map.state[b.dataset.flag]);renderSwitches();return;}
  if(b.dataset.filterRegion){const id=b.dataset.filterRegion;if(id==='all')map.setFilter(new Set());else {const set=new Set(map.state.filter);set.has(id)?set.delete(id):set.add(id);map.setFilter(set);}renderChips();return;}
  if(b.hasAttribute('data-rollback-confirm')){await undoDemo();return;}
  if(b.hasAttribute('data-rollback-cancel')){cancelRollback();return;}
  if(b.dataset.tab){state.dock=b.dataset.tab;renderDock();$('#dock').classList.remove('collapsed');return;}
  if(b.dataset.catalogFilter){state.filter=b.dataset.catalogFilter;$$('[data-catalog-filter]').forEach(el=>el.classList.toggle('on',el===b));renderCatalog();return;}
  if(b.dataset.showFlow){showFlow(b.dataset.showFlow);return;}if(b.dataset.taskMap){showTask(b.dataset.taskMap);return;}
  if(b.dataset.buildMap){buildMap(b.dataset.buildMap);return;}
  if(b.hasAttribute('data-backup-export')){exportUpgradeBackup();return;}
  if(b.hasAttribute('data-backup-recheck')){state.backupChecked=false;state.backup=undefined;renderPage();refreshBackupStatus(true);return;}
  if(b.hasAttribute('data-copy-diagnostics')){copyDiagnostics();return;}
  if(b.dataset.event){showEvent(b.dataset.event);return;}if(b.dataset.retry){retry(b.dataset.retry);return;}
  if(b.dataset.settingsTab){state.settingsTab=b.dataset.settingsTab;renderPage();if(state.settingsTab==='appearance')void refreshSkinCatalog();return;}
  if(b.hasAttribute('data-copy-map-export')){try{await navigator.clipboard.writeText(mapExportText);toast('地图 JSON 已复制');}catch{toast('复制不可用，请展开 JSON 后复制或使用下载链接','warn');}return;}
  if(b.dataset.export){await exportData(b.dataset.export);return;}
  if(b.dataset.loreToggle){try{await window.AtlasHost.toggleLore(b.dataset.loreToggle);toast('世界书条目已更新');}catch(error){toast(error.message,'warn');}return;}
  if(b.dataset.loreReadToggle){b.disabled=true;try{await window.AtlasHost.setLoreRead(b.dataset.loreReadToggle,b.dataset.loreReadEnabled==='true');toast('ATLAS 读取设置已保存');}catch(error){toast(error.message,'warn');}finally{b.disabled=false;}return;}
  if(b.dataset.loreTarget){const l=D.LORE.find(l=>l.id===b.dataset.loreTarget);if(!l.target){toast('当前条目没有匹配到已记录对象','warn');return;}if(byId(l.target))navigate(l.target);else showEntity('character',l.target,true);return;}
  if(b.hasAttribute('data-demo-next')){advanceDemo();return;}
  if(b.hasAttribute('data-layout')){generateLayout(b.dataset.layout);return;}
  if(b.hasAttribute('data-skin-reset')){await setTheme('builtin.starmap');renderPage();return;}
  if(b.hasAttribute('data-export-skin-pack')){try{download('atlas-skin.zip',await appearance.exportPack(),'application/zip');}catch(error){toast(error.message,'warn');}return;}
  if(b.hasAttribute('data-remove-skin')){const result=await appearance.remove(activeSkin.id);if(!result.ok)toast(result.errorCode,'warn');await refreshSkinCatalog();renderPage();return;}
  if(b.dataset.command!=null){runCommand(+b.dataset.command);return;}
  if(b.classList.contains('rail-ava')||b.id==='viewBadge'){switchView();return;}
 });
 listen(root,'input',e=>{const el=e.target;if(presetUI.input(el))return;if(el.id==='catalogSearch'){state.query=el.value;renderCatalog();}if(el.id==='palInput'){paletteIndex=0;renderPalette();}
  if(el.id==='diagnosticSearch')$('#diagnosticRows').innerHTML=diagnosticRows(el.value,$('#diagnosticLevel').value);
  if(el.id==='skinAccent')void updateSkin('tokens','ui.accent',el.value);
 });
 listen(root,'change',async e=>{const el=e.target;if(await presetUI.change(el))return;
  if(el.id==='diagnosticLevel')$('#diagnosticRows').innerHTML=diagnosticRows($('#diagnosticSearch').value,el.value);
  if(el.id==='profileSwitcher'){await setUIProfile(el.value);return;}
  if(el.id==='mapModeSwitcher'){state.mapMode=el.value;map.setMode(state.mapMode);refreshFlows();renderModes();return;}
  if(el.hasAttribute('data-skin-select')){await setTheme(el.value);renderPage();return;}
  for(const [attribute,section]of [['skinComponent','components'],['skinMapStyle','mapStyles'],['skinToken','tokens']])if(el.dataset[attribute]){await updateSkin(section,el.dataset[attribute],el.type==='range'?Number(el.value):el.value);return;}
  for(const key of ['radar','motion','coordinates'])if(el.hasAttribute('data-appearance-'+key)){await updateSkin('options',key,el.checked);return;}
  if(el.hasAttribute('data-single-click-enter'))setPreference('singleClickEnter',el.checked);
  if(el.hasAttribute('data-legend-collapsed'))setPreference('legendCollapsed',el.checked);
  if(el.hasAttribute('data-map-widgets-collapsed'))setPreference('mapWidgetsCollapsed',el.checked);
  if(el.id==='skinImport'&&el.files?.[0])await importSkin(el.files[0]);
 });
 $('#zIn').onclick=()=>map.zoomBy(1.3);$('#zOut').onclick=()=>map.zoomBy(1/1.3);$('#zFit').onclick=()=>map.fit(true);
 $('#zGrid').onclick=()=>{map.setFlag('showGrid',!map.state.showGrid);renderSwitches();};
 $('#btnLocate').onclick=()=>D.meta.protagonistId?showEntity('character',D.meta.protagonistId,true):toast('当前世界尚未明确主角位置','warn');
 $('#leftCollapse').onclick=()=>togglePanel('left');$('#rightCollapse').onclick=()=>togglePanel('right');
 $('#reopenLeft').onclick=()=>{if(state.leftClosed)togglePanel('left');else root.classList.toggle('left-open');};
 $('#reopenRight').onclick=()=>{if(state.rightClosed)togglePanel('right');else root.classList.toggle('right-open');};
 $('#dockToggle').onclick=()=>{$('#dock').classList.toggle('collapsed');later(()=>map.resize(),280);};
 $('#legendToggle').onclick=()=>setPreference('legendCollapsed',!state.legendCollapsed);
 $('#mapWidgetsToggle').onclick=()=>setPreference('mapWidgetsCollapsed',!state.mapWidgetsCollapsed);
 $('#nextDemo').onclick=advanceDemo;$('#undoDemo').onclick=undoDemo;$('#resetDemo').onclick=resetDemo;
 $('#btnPalette').onclick=openPalette;$('#btnSettings').onclick=()=>setPage('prefs');
 $('.palette-backdrop').onclick=closePalette;
 $('#modalClose').onclick=()=>$('#demoModal').hidden=true;
 $('#demoModal').onclick=e=>{if(e.target===$('#demoModal'))$('#demoModal').hidden=true;};
 $('#closeMapSelection').onclick=()=>{state.overlayDismissed=true;renderSelectionOverlay();$('#map').focus({preventScroll:true});};
 $('#expandMapSelection').onclick=async()=>{state.page='map';await setUIProfile('full');renderPage();openRight();};
 $$('.wc').forEach(b=>b.onclick=()=>{if(b.dataset.act==='max'){root.classList.toggle('maximized');void resizeAfterLayout();}else{hostVisible=false;syncMapVisibility();window.AtlasHost.close();}});
 $('#windowRestore').onclick=()=>{$('#appWindow').hidden=false;$('#windowRestore').hidden=true;hostVisible=true;syncMapVisibility();void resizeAfterLayout();};
 listen(document,'keydown',e=>{
  if(!hostVisible||document.hidden)return;
  const editing=/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openPalette();return;}
  if(e.key==='Escape'){if(!$('#mapSelection').hidden){state.overlayDismissed=true;renderSelectionOverlay();$('#map').focus({preventScroll:true});return;}closePalette();$('#demoModal').hidden=true;root.classList.remove('left-open','right-open');$('#reopenLeft').hidden=false;$('#reopenRight').hidden=false;return;}
  if($('#paletteWrap').classList.contains('on')){if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();paletteIndex+=e.key==='ArrowDown'?1:-1;renderPalette();}if(e.key==='Enter'){e.preventDefault();runCommand();}return;}
  if(editing)return;if(e.key.toLowerCase()==='g'&&D.meta.protagonistId)showEntity('character',D.meta.protagonistId,true);if(e.key.toLowerCase()==='f')map.fit(true);
 });
 listen(document,'visibilitychange',()=>{syncMapVisibility();if(!document.hidden&&hostVisible)void resizeAfterLayout();});
 const observer=new ResizeObserver(()=>{if(!$('#appWindow').hidden)map.resize();});observer.observe($('#viewport'));unlisten.push(()=>observer.disconnect());
 listen(window,'pagehide',destroy);
}
function updateSnapshot(value,{resetScope=false}={}){
 const snapshot=clone(value);if(!snapshot?.meta||!snapshot.ROOT)throw Error('ATLAS_SNAPSHOT_INVALID');
 const page=state.page,id=state.nodeId,selected=state.selected,sameScope=!resetScope&&D.meta?.scopeKey===snapshot.meta.scopeKey;
 for(const key of Object.keys(D))delete D[key];Object.assign(D,snapshot);state.viewMode=D.meta.viewMode;
 if(!sameScope){state.cameras.clear();state.open.clear();state.query='';state.filter='all';fullFocus=null;}
 const next=sameScope&&nodes().find(n=>n.id===id)?id:D.meta.initialNodeId||D.ROOT.id;
 navigate(next,true,{preserveWorkspace:page==='prefs',logicalPage:sameScope||page==='prefs'?page:'map',resetScope:!sameScope});
 if(sameScope&&selected){const row=selected.kind==='character'?D.CAST.find(x=>x.id===selected.id):selected.kind==='item'?D.ITEMS.find(x=>x.id===selected.id):selected.kind==='place'?byId(selected.id):selected.kind==='message'?message(selected.id):selected.kind==='task'?task(selected.id):selected.kind==='lore'?D.LORE.find(x=>x.id===selected.id):D.EVENTS.find(x=>x.id===selected.id);if(row&&known(row)){state.selected=selected;map.selectKey(selected.id);renderInspector();}}
 refreshFlows();applyUIProfile();syncMapVisibility();
}
function updateDiagnostics(rows){
 D.DIAGNOSTICS=clone(rows);
 const container=$('#diagnosticRows');if(!container)return;
 const expanded=new Set([...container.querySelectorAll('details[open]')].map(node=>node.dataset.diagnosticId));
 const search=$('#diagnosticSearch')?.value||'',level=$('#diagnosticLevel')?.value||'all';
 container.innerHTML=diagnosticRows(search,level);
 for(const node of container.querySelectorAll('details'))if(expanded.has(node.dataset.diagnosticId))node.open=true;
}
async function runHost(action,success,...args){const before=D.meta.scopeKey;try{await window.AtlasHost[action](...args);if(before===D.meta.scopeKey)toast(success);}catch(error){toast(error.message,'warn');if(before===D.meta.scopeKey){D.meta.engine??={};D.meta.engine.error=error.message;diagnostic('error','UI_ACTION_FAILED',error.message,{action});renderDock();renderPage();}window.AtlasHost.diagnostic({level:'error',source:'ui',code:'UI_ACTION_FAILED',details:{action,message:error.message}});}}
function destroy(){if(disposed)return;disposed=true;profileSequence++;skinCatalogSequence++;flowReadSequence++;appearance.destroy();cancelAnimationFrame(layoutFrame);layoutFrame=0;layoutWaiters.splice(0).forEach(resolve=>resolve({ok:false,errorCode:'UI_DISPOSED'}));if(mapExportUrl)URL.revokeObjectURL(mapExportUrl);mapExportUrl=null;mapExportText='';map.destroy();timers.forEach(clearTimeout);timers.clear();unlisten.splice(0).forEach(fn=>fn());}
state.open=new Set((path(state.nodeId)||[]).map(n=>n.id));
applySkin('builtin.starmap');applyInteractionPreferences();map.boot();bind();navigate(state.nodeId,true);applyUIProfile();
const appearanceReady=appearance.start(window.AtlasHost.initial.skin||'builtin.starmap').then(result=>{void refreshSkinCatalog();return result;});
void resizeAfterLayout();
window.AtlasPreview={appearanceReady,importSkinFile:importSkin,exportSkinPack:()=>appearance.exportPack(),listSkins:()=>appearance.list(),removeSkin:id=>appearance.remove(id),setUIProfile,setTheme,setSkin,getSkin:skinValue,effectivePage,state,map,data:D,presets,updateSnapshot,updateDiagnostics,setVisible:visible=>{const changed=hostVisible!==!!visible;hostVisible=!!visible;syncMapVisibility();if(visible){$('#appWindow').hidden=false;if(changed)void resizeAfterLayout();}},go:id=>navigate(id),page:setPage,select,inspectPlace,showEntity,showFlow,showTask,advance:advanceDemo,undo:undoDemo,reset:resetDemo,switchView,destroy,formatDistance,frameChrome,
 turnEvents,historyEvents,eventLinksHTML,backupPanelHTML,buildMap,exportUpgradeBackup,refreshBackupStatus};
})();
