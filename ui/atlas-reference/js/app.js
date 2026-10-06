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
function within(id,ancestor){return (path(id)||[]).some(n=>n.id===ancestor);}
function sceneCast(id=state.nodeId){return D.CAST.filter(c=>c.state!=='away'&&c.state!=='off'&&c.state!=='unknown'&&within(c.mapNodeId||c.locationId,id)&&known(c));}
function sceneItems(id=state.nodeId){return D.ITEMS.filter(it=>within(it.mapNodeId||it.locationId,id)&&known(it));}
function sceneMessages(id=state.nodeId){return D.MESSAGES.filter(m=>(within(m.mapNodeId||m.locationId,id)||within(id,m.mapNodeId||m.locationId))&&known(m));}
function message(id){return D.MESSAGES.find(m=>m.id===id);}
function task(id){return D.TASKS.find(t=>t.id===id);}
function setPage(page){window.AtlasHost.onPage?.(page);state.page=names[page]?page:'map';state.query='';state.filter='all';renderPage();renderRail();map.setPaused(state.page!=='map'||document.hidden);if(state.page==='map')requestAnimationFrame(()=>map.resize());}
function navigate(n,silent=false){
 if(typeof n==='string')n=byId(n);if(!n||!known(n))return false;if(!n.host){const child=byId(n.childMapIds?.[0]);if(!child)return false;n=child;}
 if(map.state.node)state.cameras.set(state.nodeId,{...map.state.tgt,fit:map.fitScale()});
 state.nodeId=n.id;state.selected=null;state.inspectorTab='cast';state.page='map';
 for(const v of path(n.id)||[])state.open.add(v.id);
 map.setPath(n,path(n.id)||[n]);map.setFilter(new Set());
 const cam=state.cameras.get(n.id);if(cam){map.state.cam={x:cam.x,y:cam.y,s:cam.s*map.fitScale()/(cam.fit||map.fitScale())};map.state.tgt={...map.state.cam};}
 map.setMode(state.mapMode);map.setPaused(document.hidden);
 renderAll();requestAnimationFrame(()=>map.resize());
 if(!silent)toast(`已进入 ${n.name}`);return true;
}
function select(kind,id,show=false){state.selected={kind,id};state.inspectorTab='details';renderInspector();if(show)openRight();const capturedScope=D.meta.scopeKey,capturedRevision=D.meta.revision;void window.AtlasHost.inspect(kind,id).then(value=>{if(!value||D.meta.scopeKey!==capturedScope||D.meta.revision!==capturedRevision||state.selected?.kind!==kind||state.selected?.id!==id)return;const row=kind==='character'?D.CAST.find(x=>x.id===id):kind==='item'?D.ITEMS.find(x=>x.id===id):(D.LOCATIONS||[]).find(x=>x.id===id);if(row)Object.assign(row,value);renderInspector();}).catch(error=>toast(error.message,'warn'));}
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
const map=window.AtlasMap.create($('#map'),$('#minimap'),{
 onSelect(m){if(m?.placeId){if(state.singleClickEnter&&m.node)navigate(m.node);else inspectPlace(m.placeId);return;}if(!m){state.selected=null;state.inspectorTab='cast';renderInspector();return;}if(m.node){if(state.singleClickEnter)navigate(m.node);else inspectPlace(m.node.id);return;}
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
  if(m.type==='char'){const c=D.CAST.find(c=>c.id===m.id);if(!c)return false;return known(c)&&c.state!=='away'&&c.state!=='off'&&c.state!=='unknown'&&within(c.locationId,n.id);}
  if(m.type==='item'){const it=D.ITEMS.find(it=>it.id===m.id);return it?known(it)&&within(it.locationId,n.id):false;}
  if(m.node)return known(m.node);if(m.type==='sig')return message(m.id)?known(message(m.id)):false;return true;
 });},
 getFlows:id=>(D.FLOWS[id]||[]).filter(known),getJourneys:id=>(D.JOURNEYS[id]||[]).filter(known),
 activeEdge:()=>state.selected?.kind==='message'||state.selected?.kind==='task'?state.selected.id:null,
 getMotion:()=>state.motion
});
const presetUI=window.AtlasPresetUI.create({root,store:presets,esc,toast,diagnostic,modal,renderPage,download});
function formatDistance(m){if(m>=1000)return `${+(m/1000).toFixed(2)} km`;return `${+m.toFixed(m<1?2:1)} m`;}
function frameChrome(st){
 if(!st.node)return;
 const scale=ui.fixedScale(st.node.metric?st.cam.s:st.cam.s*(st.node.transform?.scale||1),st.node.metric),bar=$('.sc-line i'),label=scale.label;
 if($('#scaleLabel').textContent!==label)$('#scaleLabel').textContent=label;
 $('#scaleLabel').dataset.distance=scale.distance===null?'':String(scale.distance);bar.dataset.width=String(scale.width);
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
const flags=[['showGrid','网格底图'],['showMarks','世界标记'],['showLabels','名称标签'],['showRadar','雷达扫描']];
function renderSwitches(){const el=$('#switchList');el.innerHTML=flags.map(([k,t])=>`<button class="sw-row ${map.state[k]?'on':''}" data-flag="${k}" aria-pressed="${map.state[k]}"><span>${t}</span><i class="sw"></i></button>`).join('');$('#zGrid').classList.toggle('on',map.state.showGrid);}
function renderChips(){const g=current().geo,arr=current().kind==='city'?(g.districts||[]):[];$('#regionChips').innerHTML=arr.length?`<button class="chip ${!map.state.filter.size?'on':''}" data-filter-region="all">全部</button>`+arr.map(d=>`<button class="chip ${map.state.filter.has(d.id)?'on':''}" data-filter-region="${esc(d.id)}">${esc(d.name)}</button>`).join(''):'<span class="scope-note">筛选会随当前地图切换</span>';}
function renderPlace(){const n=current(),roster=sceneCast(),items=sceneItems();$('#placeCard').innerHTML=`<div class="pl-top"><div><div class="pl-name">${esc(n.name)}</div><div class="pl-path mono">${esc(n.code)} · ${esc(D.LEVELS.find(l=>l.key===n.kind)?.name||n.tag)} <span class="diagram-tag">空间示意</span></div></div></div><div class="pl-grid"><div class="pl-cell"><span>人物</span><b class="c">${roster.length}</b></div><div class="pl-cell"><span>物品</span><b class="a">${items.length}</b></div><div class="pl-cell"><span>消息</span><b class="v">${sceneMessages().length}</b></div></div>`;
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
  return `<div class="detail-tags"><em>地点</em><em>${esc(D.LEVELS.find(l=>l.key===n.kind)?.name||n.tag)}</em></div><h3 class="detail-place-name">${esc(n.name)}</h3><p class="detail-text">${esc(n.description||'已记录的地点。')}</p>${field('所属路径',(path(n.id)||[]).filter(known).map(p=>p.name).join(' › '))}<div class="detail-actions">${(n.host&&n.id!==state.nodeId)||n.childMapIds?.length?`<button class="action-btn primary" data-go="${esc(n.childMapIds?.[0]||n.id)}">进入此地点</button>`:'<span class="scope-note">当前正在查看此地点</span>'}</div><div class="section-label">在这里的人物 · ${cast.length}</div>${cast.map(c=>castCard(c)).join('')||empty('这里暂无已记录的在场人物')}<div class="section-label">物品 · ${items.length}</div>${items.map(itemCard).join('')||'<p class="scope-note">暂无已记录物品</p>'}${children.length?`<div class="section-label">下属地点 · ${children.length}</div>${children.map(ch=>`<button class="child-location" data-inspect-place="${esc(ch.id)}"><i style="--ac:${color[ch.kind]}"></i><span>${esc(ch.name)}</span><em>${esc(ch.code)}</em>›</button>`).join('')}`:''}`;
 }
 if(s.kind==='character'){const c=D.CAST.find(c=>c.id===s.id);if(!c||!known(c))return empty('当前视角没有该人物的信息');return `<div class="entity-hero" style="--ac:${c.c}"><div class="entity-avatar">${esc(c.initial)}</div><div><h3>${esc(c.name)}</h3><span>${esc(c.role)}</span></div></div><div class="detail-tags"><em>${esc(c.tag)}</em><em>${esc(placeName(c.locationId))}</em></div>${field('当前行动',c.doing)}${state.viewMode==='author'?field('后台想法',c.mind):field('可见表现','仅显示主角能够观察到的行动与状态。')}${field('位置',c.state==='away'?(c.description||'目前在途'):placeName(c.locationId))}<div class="detail-actions">${action('查看地图位置','character',c.id,true)}${action('查看人物经历','timeline',c.id)}</div><div class="section-label">携带物品</div>${D.ITEMS.filter(it=>it.holder===c.id&&known(it)).map(itemCard).join('')||empty('暂无已记录的携带物品')}<div class="section-label">最近相关事件</div>${D.EVENTS.filter(e=>e.target===c.id&&known(e)).map(eventRow).join('')||'<p class="scope-note">暂无相关记录</p>'}`;}
 if(s.kind==='item'){const it=D.ITEMS.find(it=>it.id===s.id);if(!it||!known(it))return empty('当前视角没有该物品的信息');return `<div class="detail-title">${icon('box')}<h3>${esc(it.name)}</h3></div>${field('描述',it.description)}${field('当前状态',it.st)}${field('归属',it.holder?(D.CAST.find(c=>c.id===it.holder)?.name||'未知持有者'):'放置于地点')}${field('所在地点',placeName(it.locationId))}<div class="detail-actions">${action('查看地图位置','item',it.id,true)}${it.holder?action('查看持有者','character',it.holder):''}</div>`;}
 if(s.kind==='message'){const m=message(s.id);if(!m||!known(m))return empty('该消息尚未进入当前视角');return `<div class="detail-title">${icon('wave')}<h3>${esc(m.src)}</h3></div><div class="detail-tags"><em>${esc(m.status)}</em><em>${m.known?'主角已可获知':'世界后台 · 未送达主角'}</em></div><p class="detail-text">${esc(m.txt)}</p>${field('来源地点',placeName(m.locationId))}<div class="section-label">传播节点</div><div class="flow-steps">${m.hops.map((h,i)=>`<div><i>${i+1}</i><span>${esc(h)}</span></div>`).join('')}</div><div class="detail-actions"><button class="action-btn" data-show-flow="${esc(m.id)}">在地图上查看信息流</button></div>`;}
 if(s.kind==='task'){const t=task(s.id);if(!t||!known(t))return empty('当前视角没有此后台任务');return `<div class="detail-title">${icon('cpu')}<h3>${esc(t.n)}</h3></div>${field('状态',t.stName)}${field('行动',t.d)}${t.p!=null?`<div class="task-progress"><span>当前进度 ${t.p}%</span><div><i style="width:${t.p}%"></i></div></div>`:field('进度','等待条件满足，尚无可计算的进度')}<div class="detail-actions"><button class="action-btn" data-task-map="${esc(t.id)}">查看地图动向</button>${action('查看相关人物','character',t.entityId)}</div>`;}
 if(s.kind==='event'){const e=D.EVENTS.find(e=>e.id===s.id);if(!e||!known(e))return empty('当前视角没有此事件');return `<div class="detail-tags"><em>第 ${e.turn} 轮</em><em>${esc(e.t)}</em></div><h3 class="event-title">${esc(e.title)}</h3><p class="detail-text">${esc(e.detail)}</p>${field('发生地点',placeName(e.mapId))}<div class="detail-actions">${action('查看相关对象',e.targetKind,e.target)}<button class="action-btn" data-go="${esc(e.mapId)}">查看发生地点</button></div><p class="scope-note">这里展示历史记录，世界保持当前状态。</p>`;}
 if(s.kind==='lore'){const l=D.LORE.find(l=>l.id===s.id);if(!l)return '';return `<div class="detail-tags"><em>${esc(l.kind)}</em><em>${l.enabled?'已启用':'已停用'}</em></div><h3>${esc(l.title)}</h3><p class="detail-text">${esc(l.content)}</p><button class="action-btn" data-lore-target="${esc(l.id)}">查看关联对象</button>`;}
 return `<h3>${esc(s.name||'地图对象')}</h3>${field('信息',s.sub||'点击层级树可查看所属地点。')}`;
}
function renderInspector(){const n=current(),sel=state.selected;if(!sel&&state.inspectorTab==='details')state.inspectorTab='cast';$('#insTitle').textContent=sel?'对象详情':n.name;const tabs=$('#inspTabs');tabs.innerHTML=sel?`<button class="it active" data-inspector="details">详情</button><button class="it" data-clear-selection>返回地点</button>`:[['cast','人物',sceneCast().length],['items','物品',sceneItems().length],['msgs','消息',sceneMessages().length],['lore','地点','']].map(([k,t,num])=>`<button class="it ${state.inspectorTab===k?'active':''}" data-inspector="${k}">${t} <em>${num}</em></button>`).join('');
 const el=$('#inspector');if(sel){el.innerHTML=detailHTML();return;}
 if(state.inspectorTab==='cast')el.innerHTML=`<div class="scope-caption">${esc(n.name)} · 本地图的人物</div>`+(sceneCast().map(c=>castCard(c)).join('')||empty('这里暂无已记录的在场人物'));
 else if(state.inspectorTab==='items')el.innerHTML=sceneItems().map(itemCard).join('')||empty('这里暂无已记录的物品');
 else if(state.inspectorTab==='msgs')el.innerHTML=sceneMessages().map(messageCard).join('')||empty('这里暂无可见消息');
 else el.innerHTML=`<h3 class="detail-place-name">${esc(n.name)}</h3><p class="detail-text">${esc(n.description||'已记录的地图与地点信息。')}</p>${field('层级路径',(path(n.id)||[]).map(p=>p.name).join(' › '))}<div class="section-label">下属地点</div>${(n.children||[]).filter(known).map(ch=>`<button class="child-location" data-go="${esc(ch.id)}"><i style="--ac:${color[ch.kind]}"></i><span>${esc(ch.name)}</span><em>${esc(ch.code)}</em>›</button>`).join('')||'<p class="scope-note">当前为最细一级空间</p>'}`;
}
function eventRow(e){return `<button class="event-row" data-event="${esc(e.id)}"><span class="event-time">${esc(e.t)}</span><em class="event-kind ${e.kind}">${{cast:'人物',msg:'消息',sim:'行程',item:'物品',geo:'地理'}[e.kind]||'事件'}</em><span class="event-summary">${esc(e.title)}</span>${e.known?'':'<span class="event-private">后台</span>'}${icon('chev')}</button>`;}
function taskCard(t){return `<button class="task-card" style="--c:${t.c}" data-select-kind="task" data-select="${esc(t.id)}"><div class="tc-h"><span class="tc-n">${esc(t.n)}</span><em class="tc-st ${t.st}">${esc(t.stName)}</em></div><div class="tc-d">${esc(t.d)}</div>${t.p==null?'<div class="task-indeterminate">等待条件满足</div>':`<div class="tc-progress"><i style="width:${t.p}%"></i></div><div class="task-percent">${t.p}%</div>`}</button>`;}
function receiptCard(r){const partial=r.detail?.receipt?.status==='partial',status=partial?'部分成功':{committed:'已提交',duplicate:'重复回执',failed:'失败','pending-review':'待审阅'}[r.status]||r.status,detail={status:r.status,...(r.detail??{}),...(r.logs?.length?{logs:r.logs}:{})};return `<div class="receipt-row"><i class="rc-ok ${r.ok&&!partial?'':'rc-fail'}"></i><div><b>推演回执 · ${esc(status)} · ${esc(r.t)}</b><p>${esc(r.m)}</p>${r.issue?`<code>${esc(r.issue)}</code>`:''}<details class="diagnostic-row"><summary>查看本轮日志</summary><pre>${esc(JSON.stringify(detail,null,2))}</pre></details></div>${r.retryable?`<button class="action-btn" data-retry="${esc(r.id)}">重试失败项</button>`:r.ok?`<span class="receipt-done">${esc(status)}</span>`:'<button class="action-btn" data-page="diag">查看诊断</button>'}</div>`;}
function enginePhaseText(engine=D.meta.engine??{}){return {'awaiting-reply':'等待酒馆正文完成…',queued:'推演排队中…','reading-context':'正在读取推演资料…',committing:'正在推演，等待回执…'}[engine.phase]||'正在处理…';}
function renderDock(){
 $$('#dockTabs .dt').forEach(b=>{b.classList.toggle('active',b.dataset.tab===state.dock);b.setAttribute('aria-selected',b.dataset.tab===state.dock);});
 const el=$('#dockBody');
 if(state.dock==='log')el.innerHTML=`<div class="event-list">${D.EVENTS.filter(known).slice(0,12).map(eventRow).join('')}</div>`;
 else if(state.dock==='tasks')el.innerHTML=`<div class="task-grid">${D.TASKS.filter(known).map(taskCard).join('')||empty('当前视角暂无后台任务')}</div>`;
 else if(state.dock==='receipt')el.innerHTML=(D.RECEIPTS.length?'<button class="action-btn" data-export="receipts">导出推演回执</button>':'')+D.RECEIPTS.map(receiptCard).join('')+(D.meta.engine?.error?`<div class="receipt-row"><i class="rc-ok rc-fail"></i><div><b>当前错误</b><p>${esc(D.meta.engine.error)}</p></div><button class="action-btn" data-page="diag">查看诊断</button></div>`:'')+(!D.RECEIPTS.length&&!D.meta.engine?.error?empty(D.meta.engine?.busy?'正在推演，等待回执…':'尚无推演回执；首次推演完成后在此查看结果与日志'):'');
 else el.innerHTML=`<div class="prop-grid">${D.MESSAGES.filter(known).map(m=>`<button class="propagation-row" data-show-flow="${esc(m.id)}"><i class="pd sm"></i><div><b>${esc(m.src)}</b><span>${esc(m.hops.join(' → '))}</span></div><em>${esc(m.status)}</em>${icon('chev')}</button>`).join('')}</div>`;
 $('#turnChip').textContent=`第 ${D.meta.turn} 轮 · ${clock()}`;
 $('#queueLabel').textContent=`${D.TASKS.filter(t=>known(t)&&t.st!=='done').length} 项后台动向`;
 $('#dockTabs [data-tab="tasks"] em').textContent=D.TASKS.filter(known).length;
 $('#syncText').textContent=`${D.meta.engine?.busy?enginePhaseText()+' · ':D.meta.engine?.error?'推演失败 · ':D.meta.snapshotSaved===false?'等待首次保存 · ':''}修订 ${D.meta.revision} · ${clock()}`;
 $('#undoDemo').disabled=!D.meta.canUndo;
 const engine=D.meta.engine??{};$('#nextDemo').disabled=!!engine.busy||!engine.hasChat||!engine.sqlEnabled||engine.bound&&!engine.enabled;$('#nextDemo').textContent=engine.busy?enginePhaseText(engine):engine.bound?'立即推演':'建立当前世界';
}
function pageHeader(title,sub,extra=''){return `<div class="workspace-header"><div><span class="workspace-eyebrow">ATLAS · ${esc(D.meta.worldName)}</span><h2>${esc(title)}</h2><p>${esc(sub)}</p></div>${extra}</div>`;}
function renderPage(){const el=$('#workspacePage');el.hidden=state.page==='map';$('#viewport').classList.toggle('page-open',state.page!=='map');
 if(state.page==='map'){el.innerHTML='';return;}
 const descriptions={cast:'查看当前世界已记录的人物；选择卡片查看详情与位置。',items:'查看放置于地点或由人物持有的物品。',msgs:'查看已送达、传播中与待核实的消息。',sim:'查看后台准备、旅行与消息传播，选择任务可联动地图。',time:'按回合查看世界发生过的事情。',lore:'浏览启用资料与地图、人物之间的关联。',diag:'所有问题汇总在同一时间线，可展开完整内容。',prefs:'自由编辑分段角色与内容，调整界面外观。'};
 el.innerHTML=pageHeader(names[state.page],descriptions[state.page],`<button class="action-btn" data-page="map">${icon('map')}返回地图</button>`);
 if(['cast','items','msgs'].includes(state.page)){
  const options=state.page==='cast'?[['all','全部人物'],['here','当前地点'],['travel','在途'],['away','其他地点']]:state.page==='items'?[['all','全部物品'],['ground','地点物品'],['held','人物持有']]:[['all','全部消息'],['delivered','已送达'],['rumor','传播与传闻'],['disputed','待核实']];
  el.innerHTML+=`<div class="catalog-toolbar"><label class="search-field">${icon('search')}<input id="catalogSearch" aria-label="搜索${esc(names[state.page])}" placeholder="搜索名称、地点或内容…" value="${esc(state.query)}"></label><div class="catalog-filters">${options.map(([k,t])=>`<button class="filter-btn ${state.filter===k?'on':''}" data-catalog-filter="${k}">${t}</button>`).join('')}</div></div><div class="catalog-count" id="catalogCount"></div><div class="catalog-grid ${state.page}" id="catalogResults"></div>`;renderCatalog();
 }else if(state.page==='sim')el.innerHTML+=simulationControlsHTML()+`<div class="full-task-grid">${D.TASKS.filter(known).map(taskCard).join('')}</div><div class="section-label">本轮世界动向</div><div class="event-list">${D.EVENTS.filter(known).filter(e=>e.turn===D.meta.turn).map(eventRow).join('')}</div>`;
 else if(state.page==='time')el.innerHTML+=timelineHTML();
 else if(state.page==='lore')el.innerHTML+=`<div class="lore-grid">${D.LORE.map(l=>`<article class="lore-card"><div><em class="tag-s ${l.enabled?'g':'a'}">${l.enabled?'已启用':'已停用'}</em><span>${esc(l.kind)}</span></div><button class="lore-title" data-select-kind="lore" data-select="${esc(l.id)}">${esc(l.title)}</button><p>${esc(l.content)}</p><div class="lore-actions"><button class="action-btn" data-lore-target="${esc(l.id)}">查看关联对象</button><button class="text-btn" data-lore-toggle="${esc(l.id)}">${l.enabled?'停用':'启用'}</button></div></article>`).join('')}</div>`;
 else if(state.page==='diag')el.innerHTML+=diagnosticsHTML();
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
function simulationControlsHTML(){const e=D.meta.engine??{},status=!e.hasChat?'请先打开一个聊天':!e.sqlEnabled?'SQL 世界数据已关闭':!e.bound?'尚未建立世界':e.enabled?'本聊天推演已启用':'本聊天推演已停用';return `<div class="simulation-banner"><span class="pd"></span><div><b>${esc(status)}</b><span>世界时间 ${clock()} · 浏览与动画不会推进世界时间</span></div><button class="action-btn primary" data-demo-next ${e.busy||!e.hasChat||!e.sqlEnabled||e.bound&&!e.enabled?'disabled':''}>${e.busy?'正在处理…':e.bound?'立即推演':'建立当前世界'}</button></div><div class="detail-actions">${e.bound?`<button class="action-btn" data-engine-enable="${e.enabled?'false':'true'}" ${e.busy||!e.sqlEnabled?'disabled':''}>${e.enabled?'暂停本聊天推演':'启用本聊天推演'}</button>`:''}<button class="action-btn" data-open-backend="connection">API 连接</button><button class="action-btn" data-open-backend="prompts">提示词</button><button class="action-btn" data-open-backend="assignments">任务绑定</button><button class="action-btn" data-page="diag">查看诊断</button></div>${e.error?`<div class="receipt-row"><i class="rc-ok rc-fail"></i><div><b>最近一次操作失败</b><p role="alert" data-engine-error>${esc(e.error)}</p></div><button class="action-btn" data-page="diag">查看详细日志</button></div>`:''}<div class="section-label">推演回执</div>${D.RECEIPTS.map(receiptCard).join('')||empty(e.busy?'正在推演，等待回执…':'尚无推演回执')}<p class="scope-note">连接与提示词在此工作台内设置；世界引擎运行在浏览器中，世界数据随当前酒馆聊天保存。</p>`;}
function diagnosticsHTML(){return `<div class="catalog-toolbar"><label class="search-field">${icon('search')}<input id="diagnosticSearch" placeholder="搜索错误代码、内容或字段路径…" aria-label="搜索诊断"></label><select id="diagnosticLevel" aria-label="日志等级"><option value="all">全部等级</option><option value="error">错误</option><option value="warn">警告</option><option value="info">信息</option><option value="debug">调试</option></select><button class="action-btn" data-export="diagnostics">导出日志</button></div><div id="diagnosticRows">${diagnosticRows()}</div>`;}
function diagnosticRows(q='',level='all'){const rows=D.DIAGNOSTICS.filter(d=>(level==='all'||d.level===level)&&JSON.stringify(d).toLowerCase().includes(q.toLowerCase()));return rows.map(d=>`<details class="diagnostic-row ${d.level}"><summary><time>${esc(d.t)}</time><em>${esc(d.level)}</em><div><b>${esc(d.code)}</b><span>${esc(d.message)}</span></div>${icon('chev')}</summary><pre>${esc(JSON.stringify(d,null,2))}</pre></details>`).join('')||empty('没有符合条件的日志');}
function settingsHTML(){const tabs=[['prompts','提示词'],['connection','API 连接'],['assignments','任务绑定'],['interaction','地图交互'],['appearance','外观']];let html=`<div class="settings-tabs" role="tablist" aria-label="预设分类">${tabs.map(([id,t])=>`<button class="filter-btn ${state.settingsTab===id?'on':''}" data-settings-tab="${id}" role="tab" aria-selected="${state.settingsTab===id}">${t}</button>`).join('')}</div>`;
 if(state.settingsTab==='interaction')return html+`<div class="appearance-form"><h3>地图交互</h3><label class="appearance-row"><span>单击地点直接进入子地图</span><input type="checkbox" data-single-click-enter ${state.singleClickEnter?'checked':''}></label><p class="scope-note">默认关闭：单击地点查看右栏信息，再点击「进入此地点」。人物、物品与消息始终单击查看详情。</p><label class="appearance-row"><span>收起地图图例</span><input type="checkbox" data-legend-collapsed ${state.legendCollapsed?'checked':''}></label><p class="scope-note">图例固定收纳在比例尺上方。比例尺长度保持不变，缩放只改变距离数值。</p><p class="scope-note">${preferences.persistent?'交互偏好保存在当前浏览器。':'当前环境无法保存到浏览器，偏好在本次打开期间有效。'}</p></div>`;
 if(state.settingsTab!=='appearance')return html+presetUI.render(state.settingsTab);
 return html+`<div class="appearance-form"><h3>星幕 · 界面外观</h3><p>保留层级结构与交互，按偏好调整视觉。</p><label class="appearance-row"><span>界面强调色</span><input id="skinAccent" type="color" value="${state.accent||'#43e0ff'}"></label><label class="appearance-row"><span>地图雷达扫描</span><input type="checkbox" data-appearance-radar ${map.state.showRadar?'checked':''}></label><label class="appearance-row"><span>界面动画</span><input type="checkbox" data-appearance-motion ${state.motion?'checked':''}></label><label class="appearance-row"><span>显示坐标读数</span><input type="checkbox" data-appearance-coordinates ${root.classList.contains('show-coordinates')?'checked':''}></label><div class="detail-actions"><button class="action-btn" data-export="skin">导出皮肤</button><label class="action-btn">导入皮肤<input id="skinImport" type="file" accept=".json,application/json" hidden></label><button class="action-btn" data-skin-reset>恢复默认外观</button></div><p class="scope-note">皮肤包含颜色与显示选项，导入后立即预览。</p></div>`;
}
function renderAll(){renderRail();renderCrumbs();renderLadder();renderTree();renderSwitches();renderChips();renderPlace();renderInspector();renderDock();renderPage();renderModes();}
function renderModes(){$$('#viewModes .vm').forEach(b=>{b.classList.toggle('active',b.dataset.mode===state.mapMode);b.setAttribute('aria-pressed',b.dataset.mode===state.mapMode);});}
function showFlow(id){const m=message(id);if(!m||!known(m))return;let destination=Object.keys(D.FLOWS).find(mapId=>(D.FLOWS[mapId]||[]).some(e=>e.id===id)&&mapId===state.nodeId)||Object.keys(D.FLOWS).find(mapId=>(D.FLOWS[mapId]||[]).some(e=>e.id===id));destination=destination||m.locationId;state.mapMode='flow';navigate(destination,true);map.setMode('flow');select('message',id,true);renderModes();}
function showTask(id){const t=task(id);if(!t||!known(t))return;state.mapMode='sim';navigate(t.mapId,true);map.setMode('sim');select('task',id,true);renderModes();}
function showEvent(id){const e=D.EVENTS.find(e=>e.id===id);if(!e||!known(e))return;if(byId(e.mapId))navigate(e.mapId,true);select('event',id,true);map.selectKey(e.target);}
function openRight(){state.rightClosed=false;$('#panelRight').classList.remove('collapsed');root.classList.toggle('right-open',root.clientWidth<=720);$('#reopenRight').hidden=false;later(()=>map.resize(),280);}
function togglePanel(side){const left=side==='left',key=left?'leftClosed':'rightClosed',panel=$(left?'#panelLeft':'#panelRight');state[key]=!state[key];panel.classList.toggle('collapsed',state[key]);root.classList.toggle(left?'left-open':'right-open',!state[key]&&root.clientWidth<=(left?960:720));$(left?'#reopenLeft':'#reopenRight').hidden=false;later(()=>map.resize(),280);}
function toast(text,kind='ok'){const n=document.createElement('div');n.className='toast '+kind;const dot=document.createElement('i');dot.className='td';const span=document.createElement('span');span.textContent=text;n.append(dot,span);$('#toastWrap').append(n);later(()=>{n.classList.add('out');later(()=>n.remove(),320);},2400);}
function diagnostic(level,code,message,details=''){D.DIAGNOSTICS.unshift({id:'diag-'+Date.now(),t:clock()+':00',level,source:'preview',code,message,details});}
function advanceDemo(){state.dock='receipt';$('#dock').classList.remove('collapsed');renderDock();return runHost('advance','推演请求已处理');}
function undoDemo(){return runHost('undo','世界已回退');}
function resetDemo(){return runHost('refresh','已刷新当前世界');}
function retry(){return runHost('retry','重试请求已处理');}
function switchView(){return window.AtlasHost.setViewMode(state.viewMode==='author'?'pov':'author').catch(error=>toast(error.message,'warn'));}
function download(name,content,type='application/json'){const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();later(()=>URL.revokeObjectURL(url),1000);}
function exportData(kind){if(kind==='receipts')download('atlas-turn-receipts.json',JSON.stringify(D.RECEIPTS,null,2));else if(kind==='diagnostics')download('atlas-preview-diagnostics.jsonl',D.DIAGNOSTICS.map(d=>JSON.stringify(d)).join('\n'),'application/x-ndjson');else download('atlas-preview-skin.json',JSON.stringify({kind:'atlas-preview-skin',version:1,accent:state.accent||'#43e0ff',motion:state.motion,radar:map.state.showRadar,coordinates:root.classList.contains('show-coordinates')},null,2));}
function skinValue(){return {kind:'atlas-preview-skin',version:1,accent:state.accent||'#43e0ff',motion:state.motion,radar:map.state.showRadar,coordinates:root.classList.contains('show-coordinates')};}
function saveSkin(){void window.AtlasHost.saveSkin(skinValue()).catch(error=>toast(error.message,'warn'));}
function applySkin(s){if(s.kind!=='atlas-preview-skin'||s.version!==1||!/^#[0-9a-f]{6}$/i.test(s.accent))throw new Error('皮肤格式不支持，请使用导出的皮肤文件。');state.accent=s.accent;root.style.setProperty('--cyan',s.accent);state.motion=s.motion!==false;root.dataset.motion=state.motion?'full':'reduced';map.setFlag('showRadar',s.radar!==false);root.classList.toggle('show-coordinates',s.coordinates===true);renderSwitches();}
function modal(title,body){$('#modalTitle').textContent=title;$('#modalBody').innerHTML=body;$('#demoModal').hidden=false;$('#modalClose').focus();}
let paletteList=[],paletteIndex=0;
function paletteCommands(){return [
 ...nodes().filter(n=>(path(n.id)||[]).every(known)).map(n=>({title:n.name,sub:'地点 · '+(path(n.id)||[]).slice(-3).map(p=>p.name).join(' › '),run:()=>inspectPlace(n.id,true)})),
 ...D.CAST.filter(known).map(c=>({title:c.name,sub:'人物 · '+placeName(c.locationId),run:()=>showEntity('character',c.id,true)})),
 ...D.ITEMS.filter(known).map(it=>({title:it.name,sub:'物品 · '+placeName(it.locationId),run:()=>showEntity('item',it.id,true)})),
 ...D.MESSAGES.filter(known).map(m=>({title:m.src,sub:'消息 · '+m.status,run:()=>showFlow(m.id)})),
 {title:'预设与设置',sub:'API、提示词与地图交互',run:()=>setPage('prefs')},
 {title:'立即推演',sub:'观察人物、事件与消息变化',run:advanceDemo},
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
  if(b.dataset.mode){state.mapMode=b.dataset.mode;map.setMode(state.mapMode);renderModes();return;}
  if(b.dataset.flag){map.setFlag(b.dataset.flag,!map.state[b.dataset.flag]);renderSwitches();return;}
  if(b.dataset.filterRegion){const id=b.dataset.filterRegion;if(id==='all')map.setFilter(new Set());else {const set=new Set(map.state.filter);set.has(id)?set.delete(id):set.add(id);map.setFilter(set);}renderChips();return;}
  if(b.dataset.tab){state.dock=b.dataset.tab;renderDock();$('#dock').classList.remove('collapsed');return;}
  if(b.dataset.catalogFilter){state.filter=b.dataset.catalogFilter;$$('[data-catalog-filter]').forEach(el=>el.classList.toggle('on',el===b));renderCatalog();return;}
  if(b.dataset.showFlow){showFlow(b.dataset.showFlow);return;}if(b.dataset.taskMap){showTask(b.dataset.taskMap);return;}
  if(b.dataset.event){showEvent(b.dataset.event);return;}if(b.dataset.retry){retry(b.dataset.retry);return;}
  if(b.dataset.settingsTab){state.settingsTab=b.dataset.settingsTab;renderPage();return;}
  if(b.dataset.export){exportData(b.dataset.export);return;}
  if(b.dataset.loreToggle){try{await window.AtlasHost.toggleLore(b.dataset.loreToggle);toast('世界书条目已更新');}catch(error){toast(error.message,'warn');}return;}
  if(b.dataset.loreTarget){const l=D.LORE.find(l=>l.id===b.dataset.loreTarget);if(!l.target){toast('当前条目没有匹配到已记录对象','warn');return;}if(byId(l.target))navigate(l.target);else showEntity('character',l.target,true);return;}
  if(b.hasAttribute('data-demo-next')){advanceDemo();return;}
  if(b.hasAttribute('data-skin-reset')){applySkin({kind:'atlas-preview-skin',version:1,accent:'#43e0ff',motion:true,radar:true,coordinates:false});saveSkin();renderPage();return;}
  if(b.dataset.command!=null){runCommand(+b.dataset.command);return;}
  if(b.classList.contains('rail-ava')||b.id==='viewBadge'){switchView();return;}
 });
 listen(root,'input',e=>{const el=e.target;if(presetUI.input(el))return;if(el.id==='catalogSearch'){state.query=el.value;renderCatalog();}if(el.id==='palInput'){paletteIndex=0;renderPalette();}
  if(el.id==='diagnosticSearch')$('#diagnosticRows').innerHTML=diagnosticRows(el.value,$('#diagnosticLevel').value);
  if(el.id==='skinAccent'){state.accent=el.value;root.style.setProperty('--cyan',el.value);saveSkin();}
 });
 listen(root,'change',async e=>{const el=e.target;if(await presetUI.change(el))return;
  if(el.id==='diagnosticLevel')$('#diagnosticRows').innerHTML=diagnosticRows($('#diagnosticSearch').value,el.value);
  if(el.hasAttribute('data-appearance-radar')){map.setFlag('showRadar',el.checked);renderSwitches();}
  if(el.hasAttribute('data-appearance-motion')){state.motion=el.checked;root.dataset.motion=el.checked?'full':'reduced';}
  if(el.hasAttribute('data-appearance-coordinates'))root.classList.toggle('show-coordinates',el.checked);
  if(el.hasAttribute('data-single-click-enter'))setPreference('singleClickEnter',el.checked);
  if(el.hasAttribute('data-legend-collapsed'))setPreference('legendCollapsed',el.checked);
  if(el.hasAttribute('data-appearance-radar')||el.hasAttribute('data-appearance-motion')||el.hasAttribute('data-appearance-coordinates'))saveSkin();
  if(el.id==='skinImport'&&el.files?.[0]){try{applySkin(JSON.parse(await el.files[0].text()));saveSkin();renderPage();toast('皮肤已导入');}catch(err){toast(err.message,'warn');}}
 });
 $('#zIn').onclick=()=>map.zoomBy(1.3);$('#zOut').onclick=()=>map.zoomBy(1/1.3);$('#zFit').onclick=()=>map.fit(true);
 $('#zGrid').onclick=()=>{map.setFlag('showGrid',!map.state.showGrid);renderSwitches();};
 $('#btnLocate').onclick=()=>D.meta.protagonistId?showEntity('character',D.meta.protagonistId,true):toast('当前世界尚未明确主角位置','warn');
 $('#leftCollapse').onclick=()=>togglePanel('left');$('#rightCollapse').onclick=()=>togglePanel('right');
 $('#reopenLeft').onclick=()=>{if(state.leftClosed)togglePanel('left');else root.classList.toggle('left-open');};
 $('#reopenRight').onclick=()=>{if(state.rightClosed)togglePanel('right');else root.classList.toggle('right-open');};
 $('#dockToggle').onclick=()=>{$('#dock').classList.toggle('collapsed');later(()=>map.resize(),280);};
 $('#legendToggle').onclick=()=>setPreference('legendCollapsed',!state.legendCollapsed);
 $('#nextDemo').onclick=advanceDemo;$('#undoDemo').onclick=undoDemo;$('#resetDemo').onclick=resetDemo;
 $('#btnPalette').onclick=openPalette;$('#btnSettings').onclick=()=>setPage('prefs');
 $('.palette-backdrop').onclick=closePalette;
 $('#modalClose').onclick=()=>$('#demoModal').hidden=true;
 $('#demoModal').onclick=e=>{if(e.target===$('#demoModal'))$('#demoModal').hidden=true;};
 $$('.wc').forEach(b=>b.onclick=()=>{if(b.dataset.act==='max'){root.classList.toggle('maximized');map.resize();}else{window.AtlasHost.close();map.setPaused(true);}});
 $('#windowRestore').onclick=()=>{$('#appWindow').hidden=false;$('#windowRestore').hidden=true;map.resize();map.setPaused(state.page!=='map');};
 listen(document,'keydown',e=>{
  const editing=/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openPalette();return;}
  if(e.key==='Escape'){closePalette();$('#demoModal').hidden=true;root.classList.remove('left-open','right-open');$('#reopenLeft').hidden=false;$('#reopenRight').hidden=false;return;}
  if($('#paletteWrap').classList.contains('on')){if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();paletteIndex+=e.key==='ArrowDown'?1:-1;renderPalette();}if(e.key==='Enter'){e.preventDefault();runCommand();}return;}
  if(editing)return;if(e.key.toLowerCase()==='g'&&D.meta.protagonistId)showEntity('character',D.meta.protagonistId,true);if(e.key.toLowerCase()==='f')map.fit(true);
 });
 listen(document,'visibilitychange',()=>map.setPaused(document.hidden||state.page!=='map'));
 const observer=new ResizeObserver(()=>{if(!$('#appWindow').hidden)map.resize();});observer.observe($('#viewport'));unlisten.push(()=>observer.disconnect());
 listen(window,'pagehide',destroy);
}
function updateSnapshot(value,{resetScope=false}={}){const page=state.page,id=state.nodeId,selected=state.selected,oldScope=D.meta.scopeKey;for(const key of Object.keys(D))delete D[key];Object.assign(D,clone(value));state.viewMode=D.meta.viewMode;if(resetScope||oldScope!==D.meta.scopeKey){state.cameras.clear();state.selected=null;state.open.clear();}const next=nodes().find(n=>n.id===id)?id:D.meta.initialNodeId||D.ROOT.id;navigate(next,true);if(!resetScope&&oldScope===D.meta.scopeKey&&selected){const exists=selected.kind==='character'?D.CAST.some(x=>x.id===selected.id):selected.kind==='item'?D.ITEMS.some(x=>x.id===selected.id):selected.kind==='place'?!!byId(selected.id):selected.kind==='message'?!!message(selected.id):selected.kind==='task'?!!task(selected.id):selected.kind==='lore'?D.LORE.some(x=>x.id===selected.id):D.EVENTS.some(x=>x.id===selected.id);if(exists)state.selected=selected;}state.page=page;renderAll();map.setPaused(page!=='map'||document.hidden);}
async function runHost(action,success,...args){const before=D.meta.scopeKey;try{await window.AtlasHost[action](...args);if(before===D.meta.scopeKey)toast(success);}catch(error){toast(error.message,'warn');if(before===D.meta.scopeKey){D.meta.engine??={};D.meta.engine.error=error.message;diagnostic('error','UI_ACTION_FAILED',error.message,{action});renderDock();renderPage();}window.AtlasHost.diagnostic({level:'error',source:'ui',code:'UI_ACTION_FAILED',details:{action,message:error.message}});}}
function destroy(){map.destroy();timers.forEach(clearTimeout);timers.clear();unlisten.splice(0).forEach(fn=>fn());}
state.open=new Set((path(state.nodeId)||[]).map(n=>n.id));
if(window.AtlasHost.initial.skin)applySkin(window.AtlasHost.initial.skin);applyInteractionPreferences();map.boot();bind();navigate(state.nodeId,true);
requestAnimationFrame(()=>{map.resize();map.fit(false);});
window.AtlasPreview={state,map,data:D,presets,updateSnapshot,setVisible:visible=>{map.setPaused(!visible||state.page!=='map');if(visible){$('#appWindow').hidden=false;map.resize();}},go:id=>navigate(id),page:setPage,select,inspectPlace,showEntity,showFlow,showTask,advance:advanceDemo,undo:undoDemo,reset:resetDemo,switchView,destroy,formatDistance,frameChrome};
})();
