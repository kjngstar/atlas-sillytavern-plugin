/**
 * atlas-reference-world-ui.test.mjs — M6-17 正式投影与交互契约
 *
 * 纪律（施工单 M6-17）：
 *  - 数据一律走**真实投影** `projectReferenceData`（SQL 只读视图的真实 DTO 形状），不手搓一份理想快照；
 *  - 这里只断言 **jsdom 能诚实断言的东西**：DOM 结构、可见性过滤、点击目标、比例尺换算数据、事件归属；
 *  - **不用假的像素断言**冒充浏览器：网格实际屏幕间距、DPR、真实 hover/滚轮手势、CSS 计算值
 *    全部由 M7-02 的真实浏览器门禁负责（见文件末尾 BROWSER_ONLY）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import * as appearance from '../ui/atlas-appearance-controller.mjs';
import {projectReferenceData} from '../ui/atlas-reference-data.mjs';

const read=rel=>readFileSync(new URL(rel,import.meta.url),'utf8');
const HTML=read('../ui/atlas-reference/index.html');
const OVERRIDES=read('../ui/atlas-reference/css/atlas-world-overrides.css');
const SCRIPT_ORDER=['skin-runtime.js','map.js','presets.js','preset-ui.js','ui-model.js','app.js'];
const CODE=SCRIPT_ORDER.map(name=>[name,read(`../ui/atlas-reference/js/${name}`)]);

/** 记录式 2D 替身：只保证真实代码能跑完一帧，不产出、也不断言任何像素。 */
function stubContext(){
  const noop=()=>{};
  const gradient={addColorStop:noop};
  return {fillStyle:'',strokeStyle:'',lineWidth:1,lineCap:'',lineJoin:'',font:'',textAlign:'',textBaseline:'',
    globalAlpha:1,globalCompositeOperation:'',shadowBlur:0,shadowColor:'',shadowOffsetY:0,lineDashOffset:0,dash:[],
    save:noop,restore:noop,beginPath:noop,closePath:noop,moveTo:noop,lineTo:noop,bezierCurveTo:noop,quadraticCurveTo:noop,
    rect:noop,ellipse:noop,clip:noop,arc:noop,arcTo:noop,fill:noop,stroke:noop,fillRect:noop,strokeRect:noop,clearRect:noop,
    fillText:noop,strokeText:noop,translate:noop,rotate:noop,scale:noop,setTransform:noop,resetTransform:noop,
    setLineDash:v=>{},getLineDash:()=>[],measureText:t=>({width:String(t).length*6}),
    createLinearGradient:()=>gradient,createRadialGradient:()=>gradient,createConicGradient:()=>gradient,
    createPattern:()=>null,drawImage:noop,putImageData:noop,getImageData:()=>({data:new Uint8ClampedArray(4)})};
}

const view=items=>({branchId:'main',revision:4,items});

/* ── 真实 SQL DTO 形状（与只读视图一致；导航父子只认 parentMapId） ── */

const WORLD={mapId:'world',name:'测试世界',kind:'world',containerLocationId:null,containerLocationKind:null,parentMapId:null,connectionQuality:'root',metersPerCell:2,
  points:[{entityId:'L-bld',kind:'location',name:'钟楼',x:0,y:0,mapId:'world'}]};
/** U01：一栋建筑**只有一张**子图 —— 单子图不能把外层世界吞掉。 */
const BUILDING_MAP={mapId:'bld-map',name:'钟楼内部',kind:'interior',containerLocationId:'L-bld',containerLocationKind:'building',parentMapId:'world',connectionQuality:'contained',
  points:[{entityId:'R1',kind:'location',name:'钟室',x:2,y:2,mapId:'bld-map'},
    {entityId:'C1',kind:'character',name:'守钟人',x:3,y:3,mapId:'bld-map',locationId:'R1',isProtagonist:true},
    {entityId:'I1',kind:'item',name:'铜钥匙',x:4,y:3,mapId:'bld-map',locationId:'R1'}]};
const CATALOG=[
  {entityId:'L-bld',entityKind:'location',name:'钟楼',mapId:'world',summary:'一座钟楼'},
  {entityId:'R1',entityKind:'location',name:'钟室',mapId:'bld-map',summary:'顶层钟室'},
  {entityId:'C1',entityKind:'character',name:'守钟人',mapId:'bld-map',locationId:'R1',summary:'看守钟楼的人'},
  {entityId:'I1',entityKind:'item',name:'铜钥匙',mapId:'bld-map',locationId:'R1',summary:'一把铜钥匙'},
];
const BUILDING_DATA=projectReferenceData({mapView:view([WORLD,BUILDING_MAP]),catalogView:view(CATALOG),viewMode:'author',scopeKey:'S1'});

/** jsdom 没有布局引擎：给它一个确定的画布矩形，地图才能算出真实视口与缩放。 */
const MAP_W=920,MAP_H=620,MINI={width:212,height:132};
const box=(width,height)=>()=>({width,height,left:0,top:0,right:width,bottom:height,x:0,y:0,toJSON(){return this;}});

/** 启动真实 UI（真 index.html + 真脚本），只替换宿主、画布与布局尺寸。 */
function boot({data=BUILDING_DATA,host={},preferences={version:1,singleClickEnter:false,legendCollapsed:false},chatId='chat-A'}={}){
  const dom=new JSDOM(HTML,{url:'http://localhost/',pretendToBeVisual:true,runScripts:'outside-only'});
  const w=dom.window;
  w.HTMLCanvasElement.prototype.getContext=()=>stubContext();
  w.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
  if(!w.crypto?.randomUUID)w.crypto={randomUUID:()=>'00000000-0000-4000-8000-'+String(Math.random()).slice(2,14)};
  // 视口替身必须在脚本 eval 之前装好 —— 地图 boot() 里第一次 resize() 就要读它。
  w.document.getElementById('map').parentElement.getBoundingClientRect=box(MAP_W,MAP_H);
  w.document.getElementById('minimap').getBoundingClientRect=box(MINI.width,MINI.height);
  const store={...preferences};
  const calls={inspect:[],build:[],pages:[],views:[],prefs:[]};
  const hostPort={
    initial:{presets:null,skin:null,preferences:{...preferences}},
    preferenceStorage:{getItem:()=>JSON.stringify({...preferences}),setItem:(_,value)=>{Object.assign(store,JSON.parse(value));calls.prefs.push(JSON.parse(value));}},
    persistPresets:async()=>true,onPage:page=>calls.pages.push(page),close(){},diagnostic(entry){calls.views.push(entry);},
    inspect:async(kind,id)=>{calls.inspect.push([kind,id]);return null;},
    build:async(mapId,options)=>{calls.build.push([mapId,options]);return {coreSaved:true};},
    layout:async()=>null,advance:async()=>true,undo:async()=>true,retry:async()=>true,refresh:async()=>true,
    setEnabled:async()=>true,setViewMode:async()=>true,saveSkin:async()=>true,toggleLore:async()=>true,
    savePreferences:async value=>{Object.assign(store,value);calls.prefs.push(value);},
    exportUpgradeBackup:async()=>{const error=Error('当前聊天没有可导出的升级前原档备份（或备份不属于本聊天）');error.code='BACKUP_NOT_AVAILABLE';throw error;},
    ...host,
  };
  w.AtlasHost=hostPort;w.AtlasAppearance=appearance;
  w.ATLAS_DEMO_DATA=JSON.parse(JSON.stringify(data));
  for(const [name,code] of CODE)w.eval(`/* ${name} */\n${code}`);
  /**
   * jsdom 里地图的 rAF 帧循环会一直挂着，测试跑完进程也不退场（会被 --test-timeout 判死刑）。
   * 每个用例必须显式释放：停帧循环 + 关窗口。
   */
  let disposed=false;
  const dispose=()=>{if(disposed)return;disposed=true;try{w.AtlasPreview?.destroy?.();}catch(_){}try{dom.window.close();}catch(_){}};
  return {dom,w,preview:w.AtlasPreview,calls,store,dispose};
}

/** 起一个 UI 并在本用例结束后自动释放（断言失败也释放，否则整个文件挂死）。 */
function withUI(t,options){const ui=boot(options);t.after(ui.dispose);return ui;}

const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('地图按真实父子关系导航，同类场所可以连续嵌套，界面不显示固定等级',async t=>{
 const maps=[WORLD,
  {mapId:'yard',name:'院落',kind:'region',containerLocationId:'Y',containerLocationKind:'other',parentMapId:'world',points:[]},
  {mapId:'garden',name:'内园',kind:'region',containerLocationId:'G',containerLocationKind:'other',parentMapId:'yard',points:[]},
  {mapId:'cart',name:'车厢',kind:'interior',containerLocationId:'V',containerLocationKind:'vehicle',parentMapId:'garden',points:[]},
 ];
 const data=projectReferenceData({mapView:view(maps),catalogView:view([]),viewMode:'author'});
 const {w,preview,calls}=withUI(t,{data});preview.go('cart');
 const chain=data.ROOT.children[0];
 assert.equal(chain.kind,'other');assert.equal(chain.children[0].kind,'other');
 assert.equal(chain.children[0].children[0].kind,'vehicle');
 assert.equal('LEVELS' in data,false);assert.equal('code' in chain,false);
 assert.deepEqual([...w.document.querySelectorAll('#crumbs [data-go]')].map(b=>b.dataset.go),['world','yard','garden','cart']);
 assert.doesNotMatch(w.document.getElementById('panelLeft').textContent,/\bL[0-7]\b|层级图层/);
 assert.equal(w.document.getElementById('depthLadder'),null);
 w.document.querySelector('#crumbs [data-go="garden"]').click();
 await tick();
 assert.equal(preview.state.nodeId,'garden');assert.deepEqual(calls.build,[]);
});
test('父图保留可点击的画布略图，进入子图后显示细节且不发模型请求',async t=>{
 const dock={mapId:'dock',name:'渡口',kind:'site',containerLocationId:'dock-place',containerLocationKind:'other',parentMapId:'world',connectionQuality:'contained',points:[]};
 const shelter={mapId:'shelter',name:'候船棚',kind:'interior',containerLocationId:'shelter-place',containerLocationKind:'building',parentMapId:'dock',connectionQuality:'contained',points:[]};
 const scene={kind:'atlas-scene',units:'meters',layout:{kind:'floor',bounds:{x:0,y:0,w:12,h:8},rooms:[{id:'shelter-place',name:'候船棚',x:0,y:0,w:12,h:8}],corridor:{x:0,y:8,w:0,h:0},doors:[],groups:[],actors:[],items:[]}};
 const data=projectReferenceData({mapView:view([WORLD,dock,shelter]),sceneView:view([{mapId:'shelter',scene}]),catalogView:view([]),viewMode:'author'});
 const {w,preview,calls}=withUI(t,{data});preview.go('dock');
 assert.equal(w.document.getElementById('placeStructure'),null);
 assert.equal(w.document.getElementById('map').getAttribute('aria-hidden'),null);
 const sketch=preview.map.state.geo.exploration;assert.equal(sketch.areas[0].nodeId,'shelter');assert.equal(sketch.areas[0].recorded,true);
 assert.equal(preview.map.scaleQuality().schematic,true);
 const canvas=w.document.getElementById('map'),area=sketch.areas[0],st=preview.map.state,r=canvas.getBoundingClientRect();
 canvas.dispatchEvent(new w.MouseEvent('dblclick',{bubbles:true,clientX:r.left+(area.x-st.cam.x)*st.cam.s+st.vw/2,clientY:r.top+(area.y-st.cam.y)*st.cam.s+st.vh/2}));
 await tick();assert.equal(preview.state.nodeId,'shelter');assert.equal(preview.map.state.geo.exploration,undefined);
 assert.equal(preview.map.scaleQuality().calibrated,true);assert.deepEqual(calls.build,[]);
 preview.go('dock');assert.equal(preview.map.state.geo.exploration.areas[0].nodeId,'shelter');
});

test('地图沿用地点图标，无进入文字按钮，单击图标进入细图，平移不丢焦点且不发模型请求',async t=>{
 const road={mapId:'road',name:'旧驿道',kind:'site',containerLocationId:'road-place',containerLocationKind:'other',parentMapId:'world',points:[]};
 const bridge={mapId:'bridge',name:'石桥',kind:'site',containerLocationId:'bridge-place',containerLocationKind:'other',parentMapId:'road',points:[]};
 const scene={kind:'atlas-scene',units:'cells',layout:{kind:'overview',bounds:{x:0,y:0,w:100,h:100},shapes:[],pins:[],routes:[],features:[{id:'river',type:'watercourse',path:[{x:50,y:0},{x:50,y:50},{x:50,y:100}],width:8}]}};
 const data=projectReferenceData({mapView:view([WORLD,road,bridge]),sceneView:view([{mapId:'bridge',scene}]),catalogView:view([{entityId:'bridge-place',entityKind:'location',locationKind:'other',name:'石桥',mapId:'road'},{entityId:'road-place',entityKind:'location',locationKind:'other',name:'旧驿道',mapId:'world'}]),viewMode:'author'});
 const {w,preview,calls}=withUI(t,{data});preview.go('road');preview.map.setPaused(true);preview.map.resize();
 const entry=w.document.querySelector('#mapLocationIcons [aria-label="进入石桥地图"]');assert.ok(entry);assert.equal(entry.textContent,'');assert.equal(w.document.getElementById('mapEntries'),null);
 const hit=preview.map.state.hits.find(h=>h.m.node?.id==='bridge');assert.ok(hit);assert.equal(hit.m.iconEntry,true);assert.equal(entry.style.left,Math.round(hit.x-20)+'px');assert.equal(entry.style.top,Math.round(hit.y-20)+'px');
 entry.focus();preview.map.state.cam.x+=4;preview.map.resize();assert.equal(w.document.querySelector('#mapLocationIcons button'),entry);assert.equal(w.document.activeElement,entry);
 entry.click();await tick();assert.equal(preview.state.nodeId,'bridge');assert.equal(w.document.getElementById('mapLocationIcons').hidden,true);assert.deepEqual(calls.build,[]);
 assert.match(w.document.getElementById('map').getAttribute('aria-label'),/单击地点图标/);
});

test('存档城市地点图标带 placeId 仍单击进入，街区轮廓单击保持查看详情',async t=>{
 const city={mapId:'city-map',name:'枫镇',containerLocationId:'C',containerLocationKind:'city',parentMapId:'world',points:[{entityId:'L',kind:'location',name:'枫巷',x:50,y:50,mapId:'city-map'}]};
 const lane={mapId:'lane-map',name:'枫巷',containerLocationId:'L',containerLocationKind:'other',parentMapId:'city-map',points:[]};
 const block={mapId:'block-map',name:'旧街区',containerLocationId:'D',containerLocationKind:'district',parentMapId:'city-map',points:[]};
 const scene={units:'cells',layout:{kind:'city',bounds:{x:0,y:0,w:100,h:100},districts:[{id:'D',name:'旧街区',polygon:[[0,0],[100,0],[100,100],[0,100]]}],roads:[],pins:[{id:'L',entityId:'L',name:'枫巷',type:'location',x:50,y:50}]}};
 const catalog=[['C','枫镇','city','world'],['L','枫巷','other','city-map'],['D','旧街区','district','city-map']].map(([entityId,name,locationKind,mapId])=>({entityId,entityKind:'location',name,locationKind,mapId}));
 const data=projectReferenceData({mapView:view([WORLD,city,lane,block]),sceneView:view([{mapId:'city-map',scene}]),catalogView:view(catalog),viewMode:'author'});
 const {w,preview,calls}=withUI(t,{data});preview.go('city-map');preview.map.setPaused(true);preview.map.resize();
 const hit=preview.map.state.hits.find(h=>h.m.id==='L');assert.ok(hit);assert.equal(hit.m.placeId,'L');
 const canvas=w.document.getElementById('map');canvas.dispatchEvent(new w.MouseEvent('click',{clientX:hit.x,clientY:hit.y}));await tick();
 assert.equal(preview.state.nodeId,'lane-map');assert.deepEqual(calls.build,[]);
 preview.go('city-map');preview.map.resize();const s=preview.map.state,p=s.geo.districts[0].pts[0];
 canvas.dispatchEvent(new w.MouseEvent('click',{clientX:(p[0]+25-s.cam.x)*s.cam.s+s.vw/2,clientY:(p[1]+25-s.cam.y)*s.cam.s+s.vh/2}));await tick();
 assert.equal(preview.state.nodeId,'city-map','点轮廓不能触发图标的单击进入规则');
});

test('楼层用原生选择器导航；未明楼层房间保留入口，导航不会偷偷请求生成',async t=>{
 const upper={mapId:'upper-map',name:'二楼',kind:'interior',containerLocationId:'upper',containerLocationKind:'floor',parentMapId:'bld-map',points:[]};
 const pantry={mapId:'pantry-map',name:'厨房',kind:'interior',containerLocationId:'pantry',containerLocationKind:'room',parentMapId:'bld-map',points:[]};
 const data=projectReferenceData({mapView:view([WORLD,BUILDING_MAP,upper,pantry]),catalogView:view([...CATALOG,{entityId:'upper',entityKind:'location',locationKind:'floor',name:'二楼',mapId:'bld-map'},{entityId:'pantry',entityKind:'location',locationKind:'room',name:'厨房',mapId:'bld-map'}]),viewMode:'author'});
 const generated=[],{w,preview}=withUI(t,{data,host:{layout:id=>generated.push(id),build:id=>generated.push(id)}});
 preview.go('bld-map');const select=w.document.getElementById('floorSwitcher');
 assert.equal(select.hidden,false);assert.deepEqual([...select.options].map(o=>o.value),['bld-map','upper-map']);
 assert.match(w.document.getElementById('spaceNavigation').textContent,/房间 · 楼层未标明/);
 select.value='upper-map';select.dispatchEvent(new w.Event('change',{bubbles:true}));await tick();assert.equal(preview.state.nodeId,'upper-map');
 preview.go('pantry-map');assert.equal(select.hidden,true);assert.deepEqual(generated,[]);
 assert.equal(w.document.getElementById('depthLadder'),null);
 assert.deepEqual([...w.document.querySelectorAll('#crumbs button')].map(b=>b.dataset.go),['world','bld-map','pantry-map']);
 assert.match(w.document.getElementById('crumbs').textContent,/测试世界.*钟楼内部.*厨房/);
});
test('map tools start tucked away and retain canvas, camera, selection and independent legend state',async t=>{
 const {w,preview,calls}=withUI(t),doc=w.document,canvas=doc.getElementById('map'),toggle=doc.getElementById('mapWidgetsToggle'),widgets=doc.getElementById('mapHudWidgets');
 assert.equal(widgets.hidden,true);assert.equal(toggle.getAttribute('aria-expanded'),'false');
 const camera=JSON.stringify(preview.map.state.tgt),node=preview.state.nodeId;
 preview.showEntity('character','C1');const selected=JSON.stringify(preview.state.selected);
 toggle.click();assert.equal(widgets.hidden,false);
 doc.getElementById('legendToggle').click();
 const select=doc.getElementById('mapModeSwitcher');select.value='heat';select.dispatchEvent(new w.Event('change',{bubbles:true}));await tick();
 toggle.click();toggle.click();
 assert.equal(doc.getElementById('map'),canvas);assert.equal(JSON.stringify(preview.map.state.tgt),camera);assert.equal(preview.state.nodeId,node);
 assert.equal(JSON.stringify(preview.state.selected),selected);assert.equal(preview.state.mapMode,'heat');assert.equal(select.value,'heat');
 assert.equal(doc.getElementById('legendToggle').getAttribute('aria-expanded'),'false');
 await preview.setUIProfile('mapOnly');assert.equal(widgets.hidden,false);assert.equal(toggle.hasAttribute('data-profile-hidden'),false);
 assert.equal(calls.build.length,0);
});
test('the restored map-tools preference is independent of profile and survives saving another preference',async t=>{
 const ui=withUI(t,{preferences:{version:3,mapWidgetsCollapsed:false,legendCollapsed:true,profileId:'mapFocus'}});
 assert.equal(ui.w.document.getElementById('mapHudWidgets').hidden,false);
 ui.w.document.getElementById('legendToggle').click();await tick();
 assert.equal(ui.store.version,3);assert.equal(ui.store.mapWidgetsCollapsed,false);assert.equal(ui.store.profileId,'mapFocus');
});
test('failed map-tools persistence keeps the session choice and leaves the restore control usable',async t=>{
 const ui=withUI(t,{host:{preferenceStorage:{getItem:()=>null,setItem:()=>Promise.reject(Error('denied'))}}});
 const toggle=ui.w.document.getElementById('mapWidgetsToggle');toggle.click();await tick();
 assert.equal(ui.w.document.getElementById('mapHudWidgets').hidden,false);
 toggle.click();await tick();assert.equal(ui.w.document.getElementById('mapHudWidgets').hidden,true);assert.equal(toggle.getAttribute('aria-expanded'),'false');
});
test('生成布局直接完成空间规划，界面不要求用户修复或选择绘图档案',async t=>{
 const ui=withUI(t);assert.equal(ui.w.document.querySelector('[data-map-profile]'),null);
 ui.preview.page('diag');await tick();assert.equal(ui.w.document.querySelector('[data-history-preview]'),null);
 assert.equal(ui.w.document.querySelector('[data-history-apply]'),null);
});


test('世界书读取开关呈现独立状态，点击只调用 ATLAS 读取端口',async t=>{
 const data=structuredClone(BUILDING_DATA);data.LORE=[{id:JSON.stringify(['Book','1']),kind:'Book',title:'城市资料',content:'中性地理资料',enabled:true,atlasReadable:false,keys:[]}];
 const reads=[],hostToggles=[];const ui=withUI(t,{data,host:{setLoreRead:async(...args)=>reads.push(args),toggleLore:async id=>hostToggles.push(id)}});
 ui.w.document.querySelector('[data-view="lore"]').click();await tick();
 const control=ui.w.document.querySelector('[data-lore-read-toggle]');assert.equal(control.getAttribute('aria-checked'),'false');assert.match(control.textContent,/开启 ATLAS 读取/);
 control.click();await tick();assert.deepEqual(reads,[[data.LORE[0].id,true]]);assert.equal(hostToggles.length,0);
 assert.match(ui.w.document.querySelector('.lore-card').textContent,/已启用/);
});
/** 停掉 rAF 并同步画一帧 —— jsdom 的 rAF 是定时器，先跑断言只会看到空 hits。 */
function freeze(map){map.setPaused(true);return map;}
/**
 * boot() 之后地图默认落在**主角所在的最细地图**（initialNodeId）上，
 * 世界根的标记与米制标定在子图上读不到。要断言世界这一层，先退回去再画一帧。
 */
function openWorld(preview,id='world'){preview.go(id);preview.map.fit(false);return freeze(preview.map);}

const text=el=>el?.innerHTML??'';

/* ── U01 · 详情与子图导航 ── */

test('U01：单子图不吞外层 —— 建筑的唯一内部图仍然挂在世界之下',()=>{
  assert.equal(BUILDING_DATA.ROOT.id,'world','世界根必须保留');
  assert.equal(BUILDING_DATA.ROOT.children.length,1);
  assert.equal(BUILDING_DATA.ROOT.children[0].id,'bld-map');
  const building=BUILDING_DATA.LOCATIONS.find(l=>l.id==='L-bld');
  assert.deepEqual(building.childMapIds,['bld-map'],'地点→子图的入口来自真实 container_location_id');
  assert.equal(BUILDING_DATA.ROOT.children[0].kind,'building','导航层级取 SQL 容器种类，不因为画法是 floor 就变成楼层');
});

test('U01：unclassified 是「挂到世界根」而不是「坏图」——内部图不许被整批孤立',()=>{
  // 回归：真实夹具里每张内部图的 connectionQuality 就是 'unclassified'
  // （容器地点种类不认识 → 服务端挂到根图）。旧实现把它当坏图，
  // 结果 6 张子图全进「未挂接」，真正的世界图还被挤成合成根的子节点。
  const child=(id,name)=>Object.assign({},BUILDING_MAP,{mapId:id,name,parentMapId:'world',connectionQuality:'unclassified'});
  const data=projectReferenceData({mapView:view([WORLD,child('m-a','雪线驿站'),child('m-b','潮门港'),
    {...BUILDING_MAP,mapId:'m-broken',name:'断裂图',parentMapId:'world',connectionQuality:'invalid'}]),
    catalogView:view(CATALOG),viewMode:'author',scopeKey:'S4'});
  assert.equal(data.ROOT.id,'world','世界根必须是真正的世界图，不是包一层的合成容器');
  assert.equal(data.ROOT.mapId,'world','合成容器壳没有 mapId —— 有 mapId 才证明这是服务端那张真图');
  assert.ok(data.ROOT.host,'世界根必须自己就是一张地图');
  assert.equal(data.ROOT.kind,'world');
  const names=data.ROOT.children.filter(n=>!n.unclassified).map(n=>n.id);
  assert.deepEqual(names,['m-a','m-b'],'unclassified 的内部图按服务端 parentMapId 挂在世界图下');
  // 「未挂接」分组是**多出来的一个分组**，不许把真世界图挤下去 —— 根必须还是那张有 points 的世界图。
  assert.equal(data.ROOT.children.at(-1).id,'__unclassified__','坏图只在世界根下多一个分组，不另起合成根');
  const bucket=data.ROOT.children.find(n=>n.unclassified);
  assert.ok(bucket,'invalid 的图必须单独进「未挂接」');
  assert.deepEqual(bucket.children.map(n=>n.id),['m-broken']);
  // 每张图恰好可达一次，谁都没丢（「未挂接」是分组壳，没有 mapId，按 mapId 分辨）。
  const reachable=[];const walk=n=>{if(n.mapId)reachable.push(n.id);for(const c of n.children||[])walk(c);};walk(data.ROOT);
  assert.deepEqual([...reachable].sort(),['m-a','m-b','m-broken','world'].sort());
});

test('U01：单击开对应详情，入口按钮进子图，外层地图不被替换',t=>{
  const {w,preview}=withUI(t);
  freeze(preview.map);
  preview.select('character','C1');
  assert.match(text(w.document.getElementById('inspector')),/守钟人/,'单击人物必须开人物详情');
  preview.select('place','L-bld');
  const html=text(w.document.getElementById('inspector'));
  assert.match(html,/进入此地点/,'地点详情必须给子图入口');
  assert.match(html,/data-go="bld-map"/,'入口指向真实的子图 id');
  w.document.querySelector('[data-go="bld-map"]').click();
  assert.equal(preview.state.nodeId,'bld-map','入口按钮必须真的进入子图');
  assert.equal(preview.data.ROOT.id,'world','进入子图后世界根仍然在');
  preview.go('world');
  assert.equal(preview.state.nodeId,'world','可以退回外层，单子图没有把世界根顶掉');
});

test('进入未绘制地点只是导航，不偷偷触发布局模型请求',async t=>{
 const layoutCalls=[];
 const data=structuredClone(BUILDING_DATA);data.meta.engine={bound:true,busy:false};
 const {preview,w}=withUI(t,{data,host:{layout:async id=>layoutCalls.push(id)}});
 preview.select('place','L-bld');w.document.querySelector('[data-go="bld-map"]').click();await tick();
 assert.equal(preview.state.nodeId,'bld-map');assert.deepEqual(layoutCalls,[]);
 assert.ok(w.document.querySelector('[aria-label="导出当前地图"]'));
});

test('U01：singleClickEnter 开关写进偏好存储（刷新后仍在）',async t=>{
  const {w,store,calls,preview}=withUI(t);
  freeze(preview.map);
  // 开关住在「预设与外观 → 地图交互」，先切到那个分类再问 DOM（不切页自然找不到）。
  preview.page('prefs');
  await tick();
  const tab=w.document.querySelector('[data-settings-tab="interaction"]');
  assert.ok(tab,'设置页必须有「地图交互」分类');
  tab.click();
  await tick();
  const box=w.document.querySelector('[data-single-click-enter]');
  assert.ok(box,'地图交互设置里必须有这个开关');
  assert.equal(box.checked,false,'默认关闭：单击只看详情');
  box.checked=true;box.dispatchEvent(new w.Event('change',{bubbles:true}));
  await tick();
  assert.equal(store.singleClickEnter,true,'开关必须持久化');
  assert.ok(calls.prefs.some(p=>p.singleClickEnter===true));
  assert.match(w.document.getElementById('map').getAttribute('aria-label'),/进入子地图/,'开启后提示文案同步');
});

/* ── U02 · 比例尺固定（数据契约；实际 74 物理像素归浏览器） ── */

test('U02：74px 线长恒定 —— 同一张图缩放 1/2/4 倍，读数按反比走（148/74/37 m）',t=>{
  const {preview,w}=withUI(t);
  const model=w.AtlasUIModel;
  assert.equal(model.SCALE_WIDTH_PX,74);
  // 纯函数契约：线长永不参与"凑整数"，缩放只改读数。
  for(const [zoom,expected] of [[1,148],[2,74],[4,37]]){
    const bar=model.fixedScale(zoom,2);
    assert.equal(bar.width,74,`缩放 ${zoom} 时线长仍必须是 74 CSS px`);
    assert.equal(bar.distance,expected,`缩放 ${zoom} 的读数必须是 ${expected} m`);
    assert.equal(bar.label,`${expected} m`);
    assert.equal(bar.estimated,false,'已标定的尺度不加「约」');
  }
  const estimated=model.fixedScale(2,2,{estimated:true});
  assert.equal(estimated.width,74);
  assert.ok(estimated.label.startsWith('约 '),'估计出来的尺度必须带「约」');
  assert.equal(model.fixedScale(2,null).unit,'格','未标定时报「格」，不假装成米');
  assert.equal(model.fixedScale(0,2).label,'—','坏相机尺度给破折号，不给 NaN');
  // DOM 侧只验证「真实相机 → 同一个权威换算」这条线没断：比值关系与 74px 恒定。
  const map=openWorld(preview);
  const read=s=>{map.state.cam={x:0,y:0,s};map.state.tgt={x:0,y:0,s};map.resize();
    const label=w.document.getElementById('scaleLabel');
    return {width:Number(w.document.querySelector('.sc-line i').dataset.width),distance:Number(label.dataset.distance),text:label.textContent};};
  const one=read(1),half=read(2),quarter=read(4);
  for(const sample of [one,half,quarter])assert.equal(sample.width,74,'DOM 里的线长同样钉在 74');
  assert.ok(Math.abs(one.distance-2*half.distance)<1e-9,'缩放加倍，读数减半');
  assert.ok(Math.abs(one.distance-4*quarter.distance)<1e-9,'缩放四倍，读数减到四分之一');
  assert.ok(/ m$/.test(one.text),'已标定的读数必须带米制单位');
});

test('U02：override 样式层在原样式之后加载，且 74px 不被折叠/布局改动',()=>{
  const links=[...HTML.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m=>m[1]);
  assert.deepEqual(links,['css/atlas.css','css/preview.css','css/atlas-world-overrides.css','css/atlas-view-profiles.css','css/atlas-skin-overrides.css'],'功能样式必须排在原样式之后');
  for(const href of links)assert.ok(existsSync(new URL(`../ui/atlas-reference/${href}`,import.meta.url)),`${href} 必须真实存在（网络不得 404）`);
  assert.match(OVERRIDES,/\.hud-scale \.sc-line i\{width:74px;flex:0 0 74px;min-width:74px;max-width:74px;\}/,'比例尺线长必须在样式层被钉死');
  assert.match(OVERRIDES,/\.hud-legend\{order:1;\}/);
  assert.match(OVERRIDES,/\.hud-scale\{order:2;\}/,'图例必须排在比例尺上方');
  assert.ok(!/transform:scale\(|zoom:/.test(OVERRIDES),'不得用 CSS transform/zoom 缩放画布或比例尺');
});

/* ── U03 · 网格（jsdom 只到配置层；真实像素归浏览器） ── */

test('U03：步长只取 1/2/5×10^n、屏距落 12–40px、单帧线数封顶 2000',t=>{
  const {preview}=withUI(t);
  const map=preview.map;
  // 渲染器的两个纯函数入口是可断言的（不靠读源码正则猜）。
  assert.equal(typeof map.gridStep,'function','步长函数必须能从 UI 层直接调用');
  assert.equal(typeof map.paintGrid,'function','网格绘制必须能从 UI 层直接调用');
  for(const s of [0.02,0.1,0.5,1,3.7,12,60,300]){
    const step=map.gridStep(s);
    assert.ok(step>0,`缩放 ${s} 必须给出有限步长（旧实现会饱和在 1000 只能刷上万条线）`);
    const lead=Math.abs(Number(step.toExponential().split('e')[0]));
    assert.ok([1,2,5].some(m=>Math.abs(lead-m)<1e-9),`步长 ${step} 不在 1/2/5 档里（25/250 这种混进来过）`);
    const px=step*s;
    assert.ok(px>=12&&px<=40.0001,`缩放 ${s} 的屏幕间距 ${px}px 超出 12–40`);
  }
  assert.equal(map.gridStep(0),null,'零缩放必须返回 null，不许进死循环');
  assert.equal(map.gridStep(NaN),null);
  // 单帧线数硬上限：极端缩放下也只是画满 2000 条就停，不会把视口冻住。
  const count=map.paintGrid(stubContext(),{cam:{x:0,y:0,s:1e-6},vw:4000,vh:4000,dpr:1,step:1e-9});
  assert.ok(count<=2000,`单帧线数必须封顶 2000，实际 ${count}`);
  assert.equal(map.paintGrid(stubContext(),{cam:{x:0,y:NaN},vw:100,vh:100,dpr:1,step:1}),0,'坏相机坐标直接不画');
  const source=read('../ui/atlas-reference/js/map.js');
  assert.equal((source.match(/function gridStep\(/g)||[]).length,1,'网格步长只能有一个实现');
});

/* ── U04 · 不跳动的 hover ── */

test('U04：hover/选中只改样式 —— 可命中点与世界坐标一动不动',t=>{
  const {preview}=withUI(t);
  // 世界这一层才有 L-bld 标记；boot 默认停在主角所在的最细图上。
  const map=openWorld(preview);
  map.resize();
  const hits=()=>map.state.hits.map(h=>[h.m.id,h.x,h.y]);
  const before=hits();
  assert.ok(before.some(([id])=>id==='L-bld'),'视口内的地点必须可命中');
  const target=map.state.hits.find(h=>h.m.id==='L-bld');
  map.state.hover=target.m;map.resize();
  assert.deepEqual(hits(),before,'悬停不得改变任何可命中点的坐标');
  map.state.sel=target.m;map.resize();
  assert.deepEqual(hits(),before,'选中不得改变任何可命中点的坐标');
  const marks=BUILDING_DATA.ROOT.marks.map(m=>[m.x,m.y]);
  map.resize();
  assert.deepEqual(BUILDING_DATA.ROOT.marks.map(m=>[m.x,m.y]),marks,'绘制不得回写世界坐标');
});

test('U04：样式层明确取消 hover 位移（不靠「看起来没动」）',()=>{
  assert.match(OVERRIDES,/:hover\{transform:none;\}/,'hover 必须显式取消 transform');
  assert.ok(!/:hover[^}]*translateY/.test(OVERRIDES),'hover 不得引入 translateY');
});

/* ── U05 · 当前回合动向 ── */

const TURN_MAPS={...WORLD,points:[]};
function turnFeed({latest='T3',manual=true,withCurrent=false}={}){
  const items=[
    {id:'e1',turnId:'T2',turnOrdinal:2,timeLabel:'第 2 轮 08:00',title:'商队抵达',summary:'三辆货车进了城门',category:'event',visibility:'known',mapId:'world',target:{id:'L-bld',kind:'location'},links:[]},
    {id:'e2',turnId:'T2',turnOrdinal:2,timeLabel:'第 2 轮 08:10',title:'守钟人换岗',summary:'铜钥匙交到下一班手上',category:'event',visibility:'known',mapId:'world',target:{id:'C1',kind:'character'},links:[]},
    {id:'e3',turnId:'T2',turnOrdinal:2,timeLabel:'第 2 轮 08:20',title:'货单登记',summary:'账房记下三车货物',category:'message',visibility:'known',mapId:'world',target:{id:'I1',kind:'item'},links:[]},
  ];
  if(manual)items.push({id:'m1',turnId:'M1',turnOrdinal:2,timeLabel:'作者标定',title:'作者补记坐标',summary:'手动标定，不是剧情推进',category:'manual',sourceKind:'manual',visibility:'known',mapId:'world',target:null,links:[]});
  if(withCurrent)items.push({id:'c1',turnId:latest,turnOrdinal:3,timeLabel:'第 3 轮 09:00',title:'本轮事件',summary:'真的发生了',category:'event',visibility:'known',mapId:'world',target:null,links:[]});
  return {branchId:'main',revision:4,items,metadata:{latestNarrativeTurnId:latest,latestNarrativeOrdinal:3,hasMoreVisible:false}};
}
const turnData=options=>projectReferenceData({mapView:view([TURN_MAPS]),catalogView:view(CATALOG),worldFeedView:turnFeed(options),viewMode:'author',scopeKey:'S2'});

test('U05：最新 narrative 没有事件时，左栏明说「本轮暂无新的世界动向」',t=>{
  const data=turnData({latest:'T3'});
  assert.equal(data.meta.latestTurnId,'T3','时间基准来自 feed.metadata，不是数组顺序');
  assert.equal(data.meta.turn,3);
  assert.equal(data.EVENTS.filter(e=>e.turnId==='T3').length,0);
  const {w,preview}=withUI(t,{data});
  assert.deepEqual(preview.turnEvents(),[],'本轮确实没有剧情动向');
  preview.page('sim');
  const page=text(w.document.getElementById('workspacePage'));
  assert.match(page,/本轮暂无新的世界动向/,'空回合必须给明确说明，而不是留一片空白');
  assert.equal(preview.historyEvents().length,4,'历史记录仍在');
});

test('U05：dock 里仍能看到上一轮的 3 张卡与标定记录',t=>{
  const {w,preview}=withUI(t,{data:turnData({latest:'T3'})});
  const dock=text(w.document.getElementById('dockBody'));
  for(const title of ['商队抵达','守钟人换岗','货单登记'])assert.match(dock,new RegExp(title),`历史卡「${title}」必须留在事件栏`);
  assert.match(dock,/本轮暂无新的世界动向/,'本轮为空时事件栏也要说清楚');
  assert.match(text(w.document.getElementById('dockBody')),/作者补记坐标/,'作者标定留在历史里，但不冒充剧情');
  assert.equal(preview.state.dock,'log');
});

test('U05：manual 标定不改变 latestNarrative（不冒充发生的故事）',()=>{
  const manual=turnData({latest:'T3'});
  const withCurrent=turnData({latest:'T3',withCurrent:true});
  assert.equal(manual.meta.latestTurnId,withCurrent.meta.latestTurnId,'标定不得推高 narrative 基准');
  const m=manual.EVENTS.find(e=>e.id==='m1');
  assert.equal(m.category,'manual');
  assert.notEqual(m.turnId,manual.meta.latestTurnId,'标定不属于最新 narrative 回合');
});

/* ── U06 · 隐藏实体与点击关联 ── */

function linkFeed(viewMode){
  return {branchId:'main',revision:4,items:[{id:'ev1',turnId:'T2',turnOrdinal:2,timeLabel:'08:00',title:'密会',summary:'有人在后巷碰头',
    category:'event',visibility:viewMode==='author'?'known':'unknown',mapId:'world',target:{id:'HIDDEN',kind:'character'},
    links:[{id:'C1',kind:'character',label:'守钟人'},{id:'I1',kind:'item',label:'铜钥匙'},
      {id:'t1',kind:'action',label:'换岗行动'},{id:'j1',kind:'journey',label:'夜行旅程'},
      {id:'m1',kind:'message',label:'线报'},{id:'GHOST',kind:'character',label:'不该出现的链接'}]}],
    metadata:{latestNarrativeTurnId:'T2',latestNarrativeOrdinal:2}};
}
const LINK_TASKS=[{taskId:'t1',title:'换岗行动',actorEntityId:'C1',status:'running',targetLocationId:'R1'},{taskId:'j1',title:'夜行旅程',actorEntityId:'C1',status:'planned',targetLocationId:'R1'}];
const LINK_MESSAGES=[{entityId:'m1',entityKind:'rumor',name:'线报',summary:'后巷有人看见两个陌生人',mapId:'world',locationId:'R1'}];
const linkData=viewMode=>projectReferenceData({mapView:view([TURN_MAPS]),catalogView:view([...CATALOG,...LINK_MESSAGES]),taskView:view(LINK_TASKS),worldFeedView:linkFeed(viewMode),viewMode,scopeKey:'S3'});

test('U06：POV 事件不下发隐藏目标，也不留可点的死链',t=>{
  const pov=linkData('pov');
  const e=pov.EVENTS[0];
  assert.equal(e.known,false,'POV 下不可见事件必须是 known=false');
  const {w,preview}=withUI(t,{data:pov});
  assert.equal(preview.eventLinksHTML(e),'','隐藏事件不得产出任何关联按钮');
  const hidden=w.document.createElement('div');
  hidden.innerHTML=preview.eventLinksHTML(e);
  assert.equal(hidden.querySelectorAll('button').length,0);
});

test('U06：作者视图的 message/action/journey 各开自己的详情，不交给只认三实体的 inspect',t=>{
  const author=linkData('author');
  const e=author.EVENTS[0];
  assert.equal(e.known,true);
  const {preview,calls}=withUI(t,{data:author});
  const html=preview.eventLinksHTML(e);
  assert.match(html,/data-select-kind="message" data-select="m1"/,'消息链接指向消息详情');
  assert.match(html,/data-select-kind="task" data-select="t1"/,'行动链接指向任务详情');
  assert.match(html,/data-select-kind="task" data-select="j1"/,'旅程链接指向任务详情');
  assert.ok(!/GHOST/.test(html),'本地没有的目标不许画按钮（点了必然报错）');
  assert.ok(!/data-select-kind="task" data-select="GHOST"/.test(html));
  // 点击行动链接：走的是真实仓库里的任务详情，而不是把 action 当人物/地点塞给 inspect。
  const dom=new JSDOM(`<div id="host"></div>`);
  const holder=dom.window.document.getElementById('host');holder.innerHTML=html;
  const button=[...holder.querySelectorAll('button')].find(b=>b.dataset.select==='t1');
  assert.equal(button.dataset.selectKind,'task');
  assert.equal(preview.data.TASKS.find(t=>t.id==='t1').n,'换岗行动','任务标题来自真实 tasks 视图');
  assert.equal(preview.data.MESSAGES.find(m=>m.id==='m1').txt,'后巷有人看见两个陌生人','消息正文来自真实目录视图');
  void calls;
});

/* ── M6-18 · 升级前备份导出入口 ── */

test('map export prepares a persistent, explicit JSON download link from the selected real map',async t=>{
 const ids=[],downloads=[];
 const {w,preview}=withUI(t,{host:{downloadMap:(name,text)=>downloads.push({name,file:JSON.parse(text)}),exportMap:async id=>{ids.push(id);return {filename:'atlas-map-测试世界-r4.json',file:{scope:{mapCount:2},maps:[WORLD,BUILDING_MAP]}};}}});
 preview.go('world');
 let blob;
 w.URL.createObjectURL=value=>{blob=value;return 'blob:http://localhost/export-fixture';};
 w.URL.revokeObjectURL=()=>{};
 w.document.querySelector('[data-export="map"]').click();
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.deepEqual(ids,['world']);assert.equal(blob.type,'application/json');
 const link=w.document.querySelector('#modalBody a[download]');
 assert.equal(link.textContent,'下载地图 JSON');assert.equal(link.download,'atlas-map-测试世界-r4.json');
 assert.equal(w.document.querySelector('#demoModal').hidden,false);
 assert.match(w.document.querySelector('#modalBody').textContent,/2 张地图/);
 link.click();assert.equal(downloads[0].name,link.download);assert.equal(downloads[0].file.scope.mapCount,2);
});

test('S05：无备份时入口禁用并说明原因；有备份时显示 SHA256 供核对',async t=>{
  const denied=withUI(t);
  denied.preview.page('diag');
  let panel=text(denied.w.document.querySelector('.backup-panel'));
  assert.match(panel,/导出升级前备份/);
  assert.match(panel,/\bdisabled\b/,'没有持久备份时必须禁用');
  denied.preview.refreshBackupStatus();
  await new Promise(resolve=>setTimeout(resolve,10));
  panel=text(denied.w.document.querySelector('.backup-panel'));
  assert.match(panel,/不可导出/,'必须说明为什么不能导出');

  // 有备份时：按钮可点，状态里带 SHA256 与时间，导出的是只读快照。
  const sha='a'.repeat(64);
  const ok=withUI(t,{host:{exportUpgradeBackup:async()=>({backup:{envelopeSha256:sha,createdAtMs:Date.UTC(2026,9,8,1,2,3)},envelope:{kind:'atlas-upgrade-backup'}})}});
  ok.preview.page('diag');
  ok.preview.refreshBackupStatus(true);
  await new Promise(resolve=>setTimeout(resolve,10));
  const ready=text(ok.w.document.querySelector('.backup-panel'));
  assert.ok(!/\bdisabled\b/.test(ready),'有持久备份时按钮必须可点');
  assert.match(ready,/可导出/);
  assert.match(ready,new RegExp(sha.slice(0,16)),'必须给出 SHA256 让用户核对');
});

/**
 * P14/§21.3：回执面板必须把「世界数据已保存 / 布局：… / 缺漏与语义：…」分开显示。
 * 数据来自真实投影（referenceReceipts → referenceReceiptReport），DOM 只负责画。
 */
test('P14：回执面板分层显示保存 / 布局 / 缺漏，官道无场景时不许写「生成完成」',async t=>{
  const receipts=[
    {receiptId:'r-map',chatId:'chat-A',status:'committed',recordedAt:1,
      detail:{operation:'build',coreSaved:true,receipt:{status:'committed',issues:[]},issues:[],
        build:{sceneSummary:{ready:1,partial:0,missing:0},queue:{pendingTargets:0}}}},
    {receiptId:'r-road',chatId:'chat-A',status:'committed',recordedAt:2,
      detail:{operation:'build',coreSaved:true,receipt:{status:'committed',issues:[]},issues:[],
        build:{sceneSummary:{ready:0,partial:0,missing:1}}}},
  ];
  const data=projectReferenceData({state:{chatId:'chat-A',receipts},mapView:view([WORLD,BUILDING_MAP]),
    catalogView:view(CATALOG),viewMode:'author',scopeKey:'S1'});
  const ui=withUI(t,{data}),doc=ui.w.document;
  const tab=doc.querySelector('#dockTabs .dt[data-tab="receipt"]');
  assert.ok(tab,'回执标签必须存在');
  tab.click();await tick();
  const layers=[...doc.querySelectorAll('.receipt-layers')];
  assert.equal(layers.length,2,'两份地图回执各自分层，普通推演回执不加这三行');
  const lines=layers.map(row=>[...row.children].map(li=>li.textContent.trim()));
  assert.deepEqual(lines[0],['世界数据已保存','布局：生成完成','缺漏与语义：暂无可见缺项']);
  assert.deepEqual(lines[1],['世界数据已保存','布局：更新失败','缺漏与语义：可见缺项 1 个']);
  assert.ok(layers[1].querySelector('.rl-layout').classList.contains('rl-failed'),'无场景的图要标成更新失败');
});

/* ── P14/§21.4 · 复制功能的独立验收（真实按钮 + 真实 Clipboard Promise） ── */

/**
 * 纪律：不做「点了没报错就算通过」。这里检查 Clipboard API 的 Promise 真的被等到，
 * 成功才提示成功、失败要把错误显示出来；没有 API 时给出替代路径。
 * 内置浏览器限制与插件缺陷必须分开 —— 不因为 jsdom/某浏览器缺 API 就把通用功能判死。
 */
const LOG_FIXTURE = ({id = 'd1', level = 'error', code = 'LAYOUT_TASK_FAILED', message = '布局更新失败'} = {}) => ({
  mapView: view([WORLD, BUILDING_MAP]), catalogView: view(CATALOG), viewMode: 'author', scopeKey: 'S1',
  logsView: view([{logId: id, level, code, message, details: {mapId: 'bld-map'}, at: '2026-10-11 09:00'}]),
});
const diagData = (options) => projectReferenceData(LOG_FIXTURE(options));
test('日志增量更新保留搜索和展开详情，不重建回执或地图',t=>{
  const ui=withUI(t,{data:diagData()});ui.preview.page('diag');
  const search=ui.w.document.querySelector('#diagnosticSearch');search.value='LAYOUT';
  const detail=ui.w.document.querySelector('[data-diagnostic-id="d1"]');detail.open=true;
  const dock=ui.w.document.querySelector('#dockBody'),before=dock.innerHTML;
  const entry=ui.preview.data.DIAGNOSTICS[0];
  ui.preview.updateDiagnostics([{...entry,count:18},{id:'next',code:'MODEL_REQUEST_FAILED',level:'error',message:'超时',details:{timeoutMs:300000}}]);
  assert.equal(ui.w.document.querySelector('#diagnosticSearch'),search);
  assert.equal(search.value,'LAYOUT');
  assert.equal(ui.w.document.querySelector('[data-diagnostic-id="d1"]').open,true);
  assert.equal(ui.w.document.querySelector('[data-diagnostic-id="next"]'),null,'当前搜索条件继续生效');
  assert.match(ui.w.document.querySelector('#diagnosticRows').textContent,/折叠 18 条同类日志/);
  assert.equal(dock.innerHTML,before,'单纯新增日志不重建回执详情');
  assert.equal(ui.preview.data.DIAGNOSTICS.length,2);
});
const clipboardOf = (w, impl) => Object.defineProperty(w.navigator, 'clipboard', {configurable: true, value: impl});
const toastText = (w) => w.document.getElementById('toastWrap').textContent;
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

test('P14：点真实「复制当前列表」按钮 —— Promise 未完成前不许提前报成功，完成后复制的就是列表内容', async t => {
  const ui = withUI(t, {data: diagData()});
  const written = []; let settle;
  clipboardOf(ui.w, {writeText: (text) => {written.push(text); return new Promise((resolve, reject) => {settle = {resolve, reject};});}});
  ui.preview.page('diag');
  await tick();
  const button = ui.w.document.querySelector('[data-copy-diagnostics]');
  assert.ok(button, '诊断页必须有「复制当前列表」按钮');
  button.click();
  await flush();
  assert.equal(written.length, 1, '按钮点击必须真的调用 Clipboard API');
  assert.equal(toastText(ui.w).includes('诊断已复制'), false, 'Promise 还没完成，不许提前宣布成功');
  assert.match(written[0], /LAYOUT_TASK_FAILED/, '复制的必须是当前列表的真实内容');
  assert.match(written[0], /布局更新失败/);
  settle.resolve();
  await flush();
  assert.match(toastText(ui.w), /诊断已复制到剪贴板/);
  assert.equal(ui.w.document.querySelectorAll('#toastWrap .toast.warn').length, 0, '成功路径不许顺带报警告');
});

test('P14：Clipboard 被拒绝时错误必须看得见（不许静默，也不许写成通用缺陷）', async t => {
  const ui = withUI(t, {data: diagData()});
  clipboardOf(ui.w, {writeText: () => Promise.reject(new Error('剪贴板被拒绝：document is not focused'))});
  ui.preview.page('diag');
  await tick();
  ui.w.document.querySelector('[data-copy-diagnostics]').click();
  await flush();
  const warn = ui.w.document.querySelector('#toastWrap .toast.warn');
  assert.ok(warn, '被拒绝时必须给可见的警告提示，而不是安静地失败');
  assert.match(warn.textContent, /剪贴板被拒绝/, '提示要带上真实错误原因，便于定位是浏览器限制还是插件问题');
});

test('P14：环境没有 Clipboard API 时给替代路径，并把限制说清楚', async t => {
  const ui = withUI(t, {data: diagData()});
  assert.equal(ui.w.navigator.clipboard, undefined, 'jsdom 默认没有剪贴板，正是「不支持」这条路径');
  ui.preview.page('diag');
  await tick();
  ui.w.document.querySelector('[data-copy-diagnostics]').click();
  await flush();
  const warn = ui.w.document.querySelector('#toastWrap .toast.warn');
  assert.ok(warn);
  assert.match(warn.textContent, /当前环境不支持剪贴板/);
  assert.match(warn.textContent, /导出日志/, '必须给出可用的替代路径，不能只报错');
});

test('P14：地图 JSON 复制走真实导出结果；Promise 失败时不冒充复制成功', async t => {
  const file = {scope: {mapCount: 2}, maps: [WORLD, BUILDING_MAP]};
  const ui = withUI(t, {host: {exportMap: async () => ({filename: 'atlas-map-测试世界-r4.json', file})}});
  ui.w.URL.createObjectURL = () => 'blob:http://localhost/export-fixture';
  ui.w.URL.revokeObjectURL = () => {};
  const written = []; let mode = 'ok';
  clipboardOf(ui.w, {writeText: (text) => {written.push(text); return mode === 'ok' ? Promise.resolve() : Promise.reject(new Error('剪贴板不可用'));}});
  ui.preview.go('world');
  ui.w.document.querySelector('[data-export="map"]').click();
  await flush();
  const copy = ui.w.document.querySelector('#modalBody [data-copy-map-export]');
  assert.ok(copy, '导出弹窗必须有独立的复制按钮（下载另走一条路）');
  copy.click();
  await flush();
  assert.equal(written.length, 1);
  const parsed = JSON.parse(written[0]);
  assert.equal(parsed.scope.mapCount, 2, '复制的必须是同一次真实导出的结果');
  assert.deepEqual(parsed.maps.map((m) => m.mapId), ['world', 'bld-map']);
  assert.match(toastText(ui.w), /地图 JSON 已复制/);
  mode = 'fail';
  copy.click();
  await flush();
  assert.match(ui.w.document.querySelector('#toastWrap .toast.warn').textContent, /复制不可用/,
    'Promise 被拒绝时要撤回成功语气并给出替代做法（展开 JSON 或下载链接）');
});

/* ── P14/§21.5 · 提示词分层：策略版本 / 能力版本 / 真实预览 ── */

const ENGINE = {policyVersion: 'atlas-policy/2026-10-11', capabilities: ['corridor-binding/v1', 'space-canonical/v1', 'spatial-profile/v1'],
  activePromptPresetId: null, suggested: {version: 'atlas-policy/2026-10-11', name: '内置 SQL 世界维护策略', segments: [
    {role: 'system', name: '职责与输出', content: '你是 Atlas 世界状态维护器。', enabled: true},
    {role: 'system', name: '越权与声明边界（atlas-policy/2026-10-11）', content: '不要把「已保存」声称为整个地图建设完成。', enabled: true}]}};
const engineUI = (t, host = {}) => withUI(t, {host: {...host, initial: {presets: null, skin: null, preferences: {version: 1, singleClickEnter: false, legendCollapsed: false}, engine: ENGINE}}});

test('P14：提示词页照实显示策略版本与程序真实声明的能力（不把未实现的能力写成已支持）', async t => {
  const ui = engineUI(t);
  ui.preview.page('prefs');
  await tick();
  const strip = ui.w.document.querySelector('.engine-strip');
  assert.ok(strip, '提示词页必须有分层现状条');
  assert.match(strip.textContent, /固定协议 → 用户策略 → 程序任务上下文/);
  assert.match(strip.textContent, /atlas-policy\/2026-10-11/);
  for (const capability of ENGINE.capabilities) assert.ok(strip.textContent.includes(capability), `能力 ${capability} 必须显示`);
  assert.ok(!strip.textContent.includes('/v2'), '未声明的能力版本不得出现在界面上');
  ui.w.document.querySelector('[data-settings-tab="assignments"]').click();
  await tick();
  assert.ok(ui.w.document.querySelector('.engine-strip'), '任务绑定页同样要能看到策略版本与能力');
});

test('P14：任务「请求预览」走真实组装结果（含分层标注），宿主没有该端口时要看得见', async t => {
  const host = {previewMessages: async (task) => ({task, phase: task === 'repair' ? 'repair' : 'observe', promptSource: 'preset', coreSaved: false,
    policyVersion: 'atlas-policy/2026-10-11', capabilities: ['space-canonical/v1'],
    messages: [{role: 'system', content: '固定协议段', chars: 5}, {role: 'system', name: '作者策略', content: '用户策略段', chars: 5},
      {role: 'user', content: '任务上下文段', chars: 6}]})};
  const ui = engineUI(t, host);
  ui.preview.page('prefs');
  await tick();
  ui.w.document.querySelector('[data-settings-tab="assignments"]').click();
  await tick();
  const button = ui.w.document.querySelector('[data-task-preview="advance"]');
  assert.ok(button, '任务绑定必须有自己的请求预览入口');
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const body = ui.w.document.getElementById('modalBody').textContent;
  assert.match(body, /固定协议/);
  assert.match(body, /用户策略/);
  assert.match(body, /任务上下文段/, '预览必须显示实际会发送的消息正文，而不是「已保存的请求配置」');
  assert.match(body, /atlas-policy\/2026-10-11/);
  assert.match(body, /space-canonical\/v1/);
  assert.match(body, /没有发送模型请求/, '必须说明预览只读');

  const denied = engineUI(t);
  denied.preview.page('prefs');
  await tick();
  denied.w.document.querySelector('[data-settings-tab="assignments"]').click();
  await tick();
  denied.w.document.querySelector('[data-task-preview="repair"]').click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(denied.w.document.getElementById('toastWrap').textContent, /没有提供请求预览/,
    '宿主缺端口时必须明确报错，不许静默退回自造的预览');
});

/* 需要真实浏览器才有意义的断言（禁止在这里用 jsdom 冒充） */
const BROWSER_ONLY=['U03 网格屏幕间距/线宽/DPR 与拖出 extent 的实际像素',
  'U02 比例尺 74 CSS px 的实际计算宽度与折叠菜单交互',
  'U04 真实 hover 手势与命中稳定（jsdom 无布局）','U06 点击画布标记与滚轮缩放'];
test('U03/U02/U04：像素与手势类断言明确交给浏览器门禁',()=>{
  const gate=read('../tools/verify-reference-browser.mjs');
  assert.ok(BROWSER_ONLY.length>0);
  assert.match(gate,/playwright|chromium|chrome/i,'真实浏览器门禁必须存在（M7-02）');
});

test('外观与显示配置共享同一 Canvas、世界投影和手动折叠状态',async t=>{
 const ui=withUI(t);await ui.preview.appearanceReady;const canvas=ui.w.document.querySelector('#map'),data=JSON.stringify(ui.preview.data),map=ui.preview.map;
 ui.w.document.querySelector('#leftCollapse').click();
 for(const id of ['mapFocus','mapOnly','full'])assert.equal((await ui.preview.setUIProfile(id)).ok,true);
 assert.equal(ui.w.document.querySelector('#map'),canvas);assert.equal(ui.preview.map,map);assert.equal(ui.preview.state.leftClosed,true);assert.equal(JSON.stringify(ui.preview.data),data);assert.equal(ui.calls.build.length,0);
});
test('显示配置保留逻辑设置页、输入节点、草稿、光标和滚动',async t=>{
 const ui=withUI(t);await ui.preview.appearanceReady;ui.preview.page('prefs');ui.w.document.querySelector('[data-insert-prompt]').click();await tick();const input=ui.w.document.querySelector('textarea');assert.ok(input);input.value='未保存的分段草稿';input.dispatchEvent(new ui.w.Event('input',{bubbles:true}));input.focus();input.setSelectionRange(2,5);input.scrollTop=13;const workspace=ui.w.document.querySelector('#workspacePage');workspace.scrollTop=29;
 await ui.preview.setUIProfile('mapOnly');assert.equal(ui.preview.state.page,'prefs');assert.equal(ui.preview.effectivePage(),'map');assert.equal(workspace.hidden,true);
 await ui.preview.setUIProfile('full');assert.equal(ui.w.document.querySelector('textarea'),input);assert.equal(input.value,'未保存的分段草稿');assert.equal(input.selectionStart,2);assert.equal(input.selectionEnd,5);assert.equal(workspace.scrollTop,29);
});
test('关闭宿主后快照和导航不会重新启动地图动画',async t=>{
 const ui=withUI(t);await ui.preview.appearanceReady;ui.preview.setVisible(false);ui.preview.updateSnapshot(ui.preview.data);ui.preview.go('world');assert.equal(ui.preview.map.state.paused,true);await ui.preview.setUIProfile('mapOnly');assert.equal(ui.preview.map.state.paused,true);ui.preview.setVisible(true);assert.equal(ui.preview.map.state.paused,false);
});
test('皮肤切换保留地图事实、选择与相机，非法配置保留上一外观',async t=>{
 const ui=withUI(t);await ui.preview.appearanceReady;const before=JSON.stringify(ui.preview.data),cam={...ui.preview.map.state.tgt};assert.equal((await ui.preview.setTheme('builtin.parchment')).ok,true);assert.equal(ui.preview.getSkin().mapStyles.markers,'seal');assert.equal(JSON.stringify(ui.preview.data),before);assert.deepEqual({...ui.preview.map.state.tgt},cam);
 const previous=ui.preview.getSkin();assert.equal((await ui.preview.setSkin({...previous,tokens:{'ui.accent':'bad'}})).ok,false);assert.deepEqual(ui.preview.getSkin(),previous);
});
test('跨聊天重置地图选择、搜索与相机缓存，保留全局界面偏好',async t=>{
 const ui=withUI(t);await ui.preview.appearanceReady;await ui.preview.setUIProfile('mapOnly');ui.preview.state.query='旧聊天';ui.preview.state.cameras.set('old',{x:9,y:9,s:2});ui.preview.select('character','C1');const next=JSON.parse(JSON.stringify(ui.preview.data));next.meta.scopeKey='new-chat';ui.preview.updateSnapshot(next,{resetScope:true});assert.equal(ui.preview.state.selected,null);assert.equal(ui.preview.state.query,'');assert.equal(ui.preview.state.cameras.has('old'),false);assert.equal(ui.preview.state.profileId,'mapOnly');
});
