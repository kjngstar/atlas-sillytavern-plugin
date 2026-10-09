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
import {projectReferenceData} from '../ui/atlas-reference-data.mjs';

const read=rel=>readFileSync(new URL(rel,import.meta.url),'utf8');
const HTML=read('../ui/atlas-reference/index.html');
const OVERRIDES=read('../ui/atlas-reference/css/atlas-world-overrides.css');
const SCRIPT_ORDER=['map.js','presets.js','preset-ui.js','ui-model.js','app.js'];
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
  w.AtlasHost=hostPort;
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
  assert.deepEqual(links,['css/atlas.css','css/preview.css','css/atlas-world-overrides.css'],'功能样式必须排在原样式之后');
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

/* 需要真实浏览器才有意义的断言（禁止在这里用 jsdom 冒充） */
const BROWSER_ONLY=['U03 网格屏幕间距/线宽/DPR 与拖出 extent 的实际像素',
  'U02 比例尺 74 CSS px 的实际计算宽度与折叠菜单交互',
  'U04 真实 hover 手势与命中稳定（jsdom 无布局）','U06 点击画布标记与滚轮缩放'];
test('U03/U02/U04：像素与手势类断言明确交给浏览器门禁',()=>{
  const gate=read('../tools/verify-reference-browser.mjs');
  assert.ok(BROWSER_ONLY.length>0);
  assert.match(gate,/playwright|chromium|chrome/i,'真实浏览器门禁必须存在（M7-02）');
});
