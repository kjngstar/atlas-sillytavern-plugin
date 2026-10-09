/**
 * atlas-reference-map-render.test.mjs — 参考 UI 地图渲染层门禁
 * （M6-05 概览背景 / M6-06 开放城市与通用陈设 / M6-07 网格与比例尺）
 *
 * 纪律：
 *  - 这里只用**绘制指令替身**断言图层顺序、图元可辨性与裁剪范围；
 *    真正的像素结果（DPR、视口裁剪的实际像素、hover 缩放）由 M7 的真实浏览器脚本负责，
 *    绝不在这里用假的 jsdom/canvas 像素断言冒充。
 *  - 数据夹具一律走真实 `referenceGeometry` 投影，不手搓一份"理想 geo"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {referenceGeometry} from '../ui/atlas-reference-data.mjs';

const SOURCE = readFileSync(new URL('../ui/atlas-reference/js/map.js', import.meta.url), 'utf8');
const cut = (from, to) => SOURCE.slice(SOURCE.indexOf(from), SOURCE.indexOf(to));

test('独立房间视野适应实际房间，保留物理尺度与多房间整图视野',()=>{
 const room={x:-90,y:35,w:80,h:120};
 const st={kind:'floor',node:{extent:[-540,540,-340,360]},geo:{rooms:[room],corridor:{h:0}},vw:800,vh:600,cam:{},tgt:{}};
 const runtime=vm.createContext({st,EXTENT:{},Math,Number});
 vm.runInContext(cut('function extent()', 'function W2S('),runtime);
 vm.runInContext('fit(false)',runtime);
 assert.equal(st.cam.x,-50);assert.equal(st.cam.y,95);
 assert.ok(Math.abs(st.cam.s-600/(120*1.16))<1e-10);
 assert.deepEqual(st.node.extent,[-540,540,-340,360]);
 st.geo.rooms.push({...room,x:100});vm.runInContext('fit(false)',runtime);
 assert.equal(st.cam.x,0);assert.equal(st.cam.y,10);
 assert.ok(st.cam.s<1);
});
/** 模块级工具区（hash/rng/smooth/rrect/glow + 概览背景）。 */
const TOOLS = cut('function hash(s)', 'function create(canvas');

function recordCtx(){
  const log = [];
  const c = {
    fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '', font: '',
    textAlign: '', textBaseline: '', globalAlpha: 1, shadowBlur: 0, shadowColor: '', dash: [],
    save(){}, restore(){}, beginPath(){}, closePath(){}, moveTo(){}, lineTo(){},
    bezierCurveTo(){}, quadraticCurveTo(){}, rect(){}, ellipse(){}, clip(){}, fillText(){},
    measureText: () => ({width: 10}), drawImage(){}, translate(){}, scale(){}, rotate(){}, setTransform(){},
    fill(){ log.push({op: 'fill', fill: str(c.fillStyle)}); },
    stroke(){ log.push({op: 'stroke', stroke: str(c.strokeStyle), dash: [...c.dash]}); },
    fillRect(){ log.push({op: 'fillRect', fill: str(c.fillStyle)}); },
    strokeRect(){ log.push({op: 'strokeRect', stroke: str(c.strokeStyle)}); },
    clearRect(){}, arc(x, y){ log.push({op: 'arc', x, y}); },
    setLineDash(v){ c.dash = Array.from(v || []); },
    createLinearGradient: () => ({addColorStop(){}}),
    createRadialGradient: () => ({addColorStop(){}}),
    createPattern: () => null,
  };
  return {ctx: c, log};
}
const str = v => typeof v === 'string' ? v : 'gradient';
const indexOfOp = (log, pred) => { const i = log.findIndex(pred); return i; };
const strokes = (log, style) => log.filter(e => e.op === 'stroke' && e.stroke === style).length;

/** 在 vm 里拼出 map.js 的指定区段，并注入 canvas/st/pushLabel 替身。 */
function mapRuntime({ctx, st, pushLabel, sections}){
  const runtime = vm.createContext({
    ctx, st, pushLabel,
    extent: () => [-50, 50, -50, 50],
    hexA: (c, a) => c + '@' + a,
    Math, Number, Array, Object, String, JSON, console,
  });
  vm.runInContext(TOOLS + sections.map(([f, t]) => cut(f, t)).join(''), runtime);
  return runtime;
}
const FLOOR = [['function floorMap(', 'function drawFurn('], ['function drawFurn(', '/* ── L6 房间 ──']];
const CITY = [['function cityMap(', '/* ── L3 街区 ──']];
const ROOM = [['function roomMap(', 'function hexA(hex,a)']];

function sceneRuntime(sections, geo, extra = {}){
  const {ctx, log} = recordCtx(), labels = [];
  const st = {
    node: {id: 'n1', name: '测试空间', host: true, metric: 1, transform: {scale: 1, bounds: {w: 20}}},
    cam: {s: 1, x: 0, y: 0}, vw: 400, vh: 400, kind: 'floor',
    path: [{name: '上层'}, {name: '本层'}], showLabels: true, filter: new Set(), ...extra,
  };
  const runtime = mapRuntime({ctx, st, sections, pushLabel: (x, y, text, color, kind) => labels.push({x, y, text, kind})});
  return {runtime, log, labels, st};
}

/* ── G07：开放式城市不画默认城墙 ── */

const CITY_MAP = {
  mapId: 'city', name: '测试城', kind: 'city', containerLocationId: null,
  containerLocationKind: 'city', parentMapId: 'world', connectionQuality: 'contained',
  points: [{entityId: 'd1', kind: 'location', name: '旧城区', mapId: 'city', x: 0, y: 0}],
};

test('G07 · 开放式城市（wall=[]）不画任何城墙；有墙的城市保留城墙', () => {
  const openScene = {units: 'cells', layout: {kind: 'city', bounds: {x: -20, y: -20, w: 40, h: 40}, wall: [], districts: [], roads: []}};
  const openGeo = referenceGeometry(CITY_MAP, openScene).geo;
  assert.deepEqual(openGeo.wallPoints, [], '开放式城市的 wall 必须投影成空数组');
  const open = sceneRuntime(CITY, openGeo, {kind: 'city'});
  open.runtime.cityMap(openGeo);
  assert.equal(strokes(open.log, 'rgba(170,225,255,.5)'), 0, '开放式城市不得出现城墙描边');
  assert.equal(strokes(open.log, 'rgba(120,190,255,.13)'), 0, '开放式城市不得出现城墙外发光');

  const wallScene = {units: 'cells', layout: {kind: 'city', bounds: {x: -20, y: -20, w: 40, h: 40}, wall: [{x: -10, y: -10}, {x: 10, y: -10}, {x: 10, y: 10}], districts: [], roads: []}};
  const wallGeo = referenceGeometry(CITY_MAP, wallScene).geo;
  assert.equal(wallGeo.wallPoints.length, 3);
  const walled = sceneRuntime(CITY, wallGeo, {kind: 'city'});
  walled.runtime.cityMap(wallGeo);
  assert.equal(strokes(walled.log, 'rgba(170,225,255,.5)'), 1, '已有城墙的场景必须保留城墙');
});

/* ── G08 / U01：室内通用陈设 ── */

const FLOOR_MAP = {
  mapId: 'fl', name: '测试楼层', kind: 'interior', containerLocationId: 'bld',
  containerLocationKind: 'floor', parentMapId: 'city', connectionQuality: 'contained', points: [],
};
function floorScene(){
  return {units: 'meters', layout: {
    kind: 'floor', bounds: {x: 0, y: 0, w: 20, h: 12},
    corridor: {x: 0, y: 5, w: 20, h: 2},
    rooms: [
      {id: 'R1', name: '卧室', x: 0, y: 0, w: 8, h: 5, status: '已上锁'},
      {id: 'R2', name: '书房', x: 12, y: 0, w: 8, h: 5},
    ],
    doors: [{id: 'door:R1', roomId: 'R1', x: 3, y: 5, width: 1}],
    windows: [{id: 'window:R1:0', roomId: 'R1', x: 3, y: 0, width: 1.2}],
    lamps: [{id: 'light:R1', roomId: 'R1', x: 3, y: 2.4, elevation: 2.6}],
    groups: [
      {id: 'g-bed', roomId: 'R1', x: 1, y: 1, w: 2, h: 3, bodies: [
        {id: 'g-bed:bed', type: 'bed', groupId: 'g-bed', roomId: 'R1', solid: true, x: 1, y: 1, w: 2, h: 3},
        {id: 'g-bed:pillow', type: 'pillow', groupId: 'g-bed', roomId: 'R1', solid: false, x: 1.2, y: 1.2, w: 1.6, h: .4}]},
      {id: 'g-cab', roomId: 'R1', x: 5, y: 1, w: 2, h: .8, bodies: [
        {id: 'g-cab:cabinet', type: 'cabinet', groupId: 'g-cab', roomId: 'R1', solid: true, x: 5, y: 1, w: 2, h: .8}]},
      {id: 'g-tbl', roomId: 'R2', x: 13, y: 1, w: 2, h: 1.4, bodies: [
        {id: 'g-tbl:table', type: 'table', groupId: 'g-tbl', roomId: 'R2', solid: true, x: 13, y: 1, w: 2, h: 1.4},
        {id: 'g-tbl:chair', type: 'chair', groupId: 'g-tbl', roomId: 'R2', solid: true, x: 13.2, y: 2.6, w: .5, h: .5},
        {id: 'g-tbl:doorway', type: 'doorway', groupId: 'g-tbl', roomId: 'R2', solid: false, x: 15, y: 3, w: .8, h: .8},
        {id: 'g-tbl:decor', type: 'decor', groupId: 'g-tbl', roomId: 'R2', solid: false, x: 16.5, y: 3.4, w: .9, h: .6}]},
    ],
    actors: [{id: 'C1', name: '住客', roomId: 'R2', x: 14, y: 2, quality: 'layout'}],
    items: [],
  }};
}
const floorGeo = () => referenceGeometry(FLOOR_MAP, floorScene(), {viewMode: 'author'}).geo;

test('G08 · 通用陈设各自有可辨画法，实体障碍与装饰分开', () => {
  const geo = floorGeo();
  const {runtime, log} = sceneRuntime(FLOOR, geo);
  runtime.floorMap(geo);
  assert.equal(strokes(log, 'rgba(180,150,255,.45)'), 1, '床');
  assert.equal(strokes(log, 'rgba(255,205,130,.40)'), 1, '柜');
  assert.equal(strokes(log, 'rgba(200,230,255,.5)'), 1, '桌');
  assert.equal(strokes(log, 'rgba(200,225,255,.42)'), 1, '椅');
  assert.equal(strokes(log, 'rgba(255,225,150,.45)'), 1, '门洞');
  assert.equal(strokes(log, 'rgba(180,205,235,.22)'), 1, '装饰块');
  // 实体（solid）实线、装饰（doorway/decor）虚线：G08 要求两者一眼可分。
  const solid = log.find(e => e.op === 'stroke' && e.stroke === 'rgba(200,230,255,.5)');
  const soft = log.find(e => e.op === 'stroke' && e.stroke === 'rgba(180,205,235,.22)');
  assert.deepEqual(solid.dash, [], '实体家具走实线');
  assert.deepEqual(soft.dash, [3, 3], '装饰走虚线');
});

test('G08 · 灯光画在陈设与人物下方', () => {
  const geo = floorGeo();
  const {runtime, log} = sceneRuntime(FLOOR, geo);
  runtime.floorMap(geo);
  const lamp = indexOfOp(log, e => e.op === 'fill' && e.fill === 'rgba(255,232,180,.85)');
  const furn = indexOfOp(log, e => e.op === 'stroke' && e.stroke === 'rgba(200,230,255,.5)');
  assert.ok(lamp >= 0, '灯必须被画出来');
  assert.ok(furn > lamp, '灯必须压在所有陈设之下');
});

test('U01 · 房间副标题只写真实 status，不出现示例文案「禁书区」', () => {
  const geo = floorGeo();
  const {runtime, labels} = sceneRuntime(FLOOR, geo);
  runtime.floorMap(geo);
  assert.ok(labels.some(l => l.text === '已上锁'), '真实 status 必须原样显示');
  assert.ok(labels.some(l => l.text === '房间'), '没有 status 的房间给中性描述');
  assert.ok(!labels.some(l => /禁书区|上锁$/.test(l.text) && l.text !== '已上锁'), '不得印示例世界的固定文案');
  assert.ok(!labels.some(l => l.text.includes('禁书区')), '「禁书区」是旧示例文案，必须彻底删除');
});

test('G09 · 陈设按真实 roomId 归属：每件只画一次、错 roomId 不画', () => {
  const geo = floorGeo();
  const one = sceneRuntime(FLOOR, geo);
  one.runtime.floorMap(geo);
  // 旧写法靠几何包含判断归属，跨房间时会重复画或漏画；按 roomId 归属必须恰好一次。
  assert.equal(strokes(one.log, 'rgba(200,230,255,.5)'), 1, 'R2 的桌子必须被且仅被画一次');
  assert.equal(strokes(one.log, 'rgba(180,150,255,.45)'), 1, 'R1 的床必须被且仅被画一次');

  const orphan = {...geo, furn: [...geo.furn, {id: 'ghost', type: 'table', t: 'table', detail: true, solid: true, roomId: 'RX', r: [1, 1, 2, 2]}]};
  const isolated = sceneRuntime(FLOOR, orphan);
  isolated.runtime.floorMap(orphan);
  assert.equal(strokes(isolated.log, 'rgba(200,230,255,.5)'), 1, '指向不存在房间的陈设不得凭空出现');
});

test('G09 · POV 剥掉真实类型时画中性块，不编一件家具出来', () => {
  const geo = floorGeo();
  // 服务端 POV 白名单会把 body.type/solid 一起剥掉，只留几何。
  const povFurn = geo.furn.map(f => ({id: f.id, t: f.t, detail: false, solid: false, roomId: f.roomId, r: f.r}));
  const {runtime, log} = sceneRuntime(FLOOR, {...geo, furn: povFurn});
  runtime.floorMap({...geo, furn: povFurn});
  assert.equal(strokes(log, 'rgba(180,205,235,.22)'), povFurn.length, '没有真实类型时一律中性块');
  assert.equal(strokes(log, 'rgba(200,230,255,.5)'), 0, '不得凭渲染类别把中性块画成桌子');
});

test('M6-06 边界 · 未知室内几何不崩，退化成明确说明', () => {
  const {runtime, labels} = sceneRuntime(ROOM, {});
  assert.doesNotThrow(() => runtime.roomMap({}), '缺 walls 的室内几何不能让整张图白屏');
  assert.ok(labels.some(l => l.text === '尚未建立内部空间'));
});

/* ── M6-07：网格步长、屏幕空间与线数上限 / 比例尺 ── */

/** 只记线段端点与线宽的 canvas 替身：用来断言"画在哪、画多粗、画几条"。 */
function gridProbe(){
  const lines=[], widths=[], styles=[];
  let start=null;
  const c={
    lineWidth:0, strokeStyle:'',
    save(){}, restore(){}, beginPath(){ start=null; },
    moveTo(x,y){ start=[x,y]; },
    lineTo(x,y){ if(start)lines.push([start[0],start[1],x,y]); },
    stroke(){ widths.push(c.lineWidth); styles.push(c.strokeStyle); },
  };
  return {c,lines,widths,styles};
}
const isOneTwoFive = s => {
  const m = s/Math.pow(10, Math.floor(Math.log10(s)));
  return [1,2,5].some(v => Math.abs(m-v) < 1e-9);
};

test('M6-07 · 网格步长只取 1/2/5×10^n，屏幕间距恒定落在 12–40 CSS px', () => {
  const runtime = mapRuntime({ctx:{}, st:{}, sections:[], pushLabel(){}});
  const zooms=[1e-3,1e-2,.05,.1,.3,1,2,7,25,100,900,1e4];
  for(const s of zooms){
    const step=runtime.gridStep(s);
    assert.ok(Number.isFinite(step)&&step>0,`缩放 ${s} 必须得到有效步长`);
    assert.ok(isOneTwoFive(step),`步长 ${step} 必须落在 1/2/5×10^n 档`);
    const px=step*s;
    assert.ok(px>=12&&px<=40,`缩放 ${s} 的屏幕间距 ${px}px 必须落在 12–40`);
  }
  for(const bad of [0,-1,NaN,Infinity,null,undefined]) assert.equal(runtime.gridStep(bad),null,`${bad} 不得算出步长`);
});

test('M6-07 · 网格画在屏幕空间：线宽恒定 1 物理像素、坐标不出画布、单帧 ≤2000 条', () => {
  const runtime = mapRuntime({ctx:{}, st:{}, sections:[], pushLabel(){}});
  for(const [camS,vw,vh,dpr] of [[1,800,600,1],[0.001,800,600,2],[1e4,800,600,1.5],[37.5,1024,768,2]]){
    const {c,lines,widths}=gridProbe();
    const step=runtime.gridStep(camS);
    const count=runtime.paintGrid(c,{cam:{s:camS,x:1234.5,y:-678.25},vw,vh,dpr,step});
    assert.ok(count>0&&count<=2000,`单帧线数 ${count} 必须 ≤2000`);
    assert.equal(lines.length,count);
    assert.ok(widths.every(w=>w===1/dpr),'线宽必须恒为 1 物理像素');
    for(const [x0,y0,x1,y1] of lines){
      for(const v of [x0,y0,x1,y1]) assert.ok(Number.isFinite(v),'网格坐标不得为 NaN');
    }
    // 真正的"视口裁剪"证据：线数只能是视口所需的量级。
    // 旧实现按固定逻辑 extent 全画，缩小时线数会远大于这个上限。
    const slack=step*camS;
    const needed=Math.ceil(vw/slack)+2+Math.ceil(vh/slack)+2;
    assert.ok(count<=needed,`线数 ${count} 超过视口所需上限 ${needed}（说明仍在按逻辑 extent 全画）`);
    for(const [x0,y0,x1,y1] of lines){
      assert.ok(x0>=-slack-1&&x0<=vw+slack+1,`竖线 x=${x0} 超出视口两侧超过一个步长`);
      assert.ok(y0>=-slack-1&&y0<=vh+slack+1,`横线 y=${y0} 超出视口两侧超过一个步长`);
    }
  }
});

test('M6-07 · 网格范围跟随可见视口（平移后仍铺满画面），非法相机不画', () => {
  const runtime = mapRuntime({ctx:{}, st:{}, sections:[], pushLabel(){}});
  // 平移到很远的地方：仍必须有线横跨整个画布（旧实现用固定 extent，缩出去就是空白）。
  const {c,lines}=gridProbe();
  runtime.paintGrid(c,{cam:{s:1,x:99999,y:-99999},vw:400,vh:300,dpr:1,step:runtime.gridStep(1)});
  assert.ok(lines.some(([x0,y0,x1,y1])=>y0===0&&y1===300),'必须有竖线贯穿整个画布高度');
  assert.ok(lines.some(([x0,y0,x1,y1])=>x0===0&&x1===400),'必须有横线贯穿整个画布宽度');

  for(const cam of [{s:0,x:0,y:0},{s:NaN,x:0,y:0},{s:1,x:NaN,y:0},{s:1,x:0,y:Infinity}]){
    assert.equal(runtime.paintGrid(gridProbe().c,{cam,vw:400,vh:300,dpr:1,step:1}),0,'非法相机必须安全退出');
  }
  assert.equal(runtime.paintGrid(gridProbe().c,{cam:{s:1,x:0,y:0},vw:400,vh:300,dpr:1,step:NaN}),0);
});

test('M6-07 · 比例尺：线长恒定 74 CSS px，distance=74/px×metric，未标定用格、估计加约', () => {
  const source=readFileSync(new URL('../ui/atlas-reference/js/ui-model.js',import.meta.url),'utf8');
  const runtime=vm.createContext({});
  vm.runInContext(source,runtime);
  const ui=runtime.AtlasUIModel;
  assert.equal(ui.SCALE_WIDTH_PX,74);

  // 标定：每 UI 单位 2 m、每单位 10 px → 74px = 14.8 m。
  const calibrated=ui.fixedScale(10,2);
  assert.equal(calibrated.width,74);
  assert.ok(Math.abs(calibrated.distance-74/10*2)<1e-9);
  assert.equal(calibrated.unit,'m');
  assert.equal(calibrated.estimated,false);
  assert.ok(!calibrated.label.startsWith('约'));

  // 估计的尺度：同一个 74px，但数值必须打上"约"。
  assert.equal(ui.fixedScale(10,2,{estimated:true}).label.startsWith('约 '),true);

  // 未标定：报「格」，绝不因为数值大就自己升级成 km（km 只属于已标定的米制）。
  const cells=ui.fixedScale(10,null);
  assert.equal(cells.unit,'格');
  assert.equal(cells.distance,7.4);
  assert.ok(!cells.label.includes('km'));

  // 已标定且很大才进 km，且 74px 线长任何缩放都不变。
  assert.equal(ui.fixedScale(0.01,1000).unit,'km');
  for(const s of [0.001,0.1,1,50,1000]) assert.equal(ui.fixedScale(s,1).width,74,'绝不能为凑整数改线长');

  // NaN / 零缩放：给"—"，不给假数字。
  for(const bad of [0,-1,NaN,Infinity]){
    // vm realm 里的对象原型不同，逐字段比对而不是 deepEqual。
    const info=ui.fixedScale(bad,1);
    assert.equal(info.width,74);assert.equal(info.distance,null);assert.equal(info.label,'—');
    assert.equal(info.unit,'unknown');assert.equal(info.estimated,false);
  }
  assert.equal(ui.fixedScale(10,NaN).unit,'格','非正数 metric 视为未标定');
});

/* ── M6-10：悬停锚点稳定、标签避让、命中与绘制同源 ── */

const MODULE = cut('const C = {', 'function create(canvas');
const BODY = cut('function create(canvas', 'return { create, C };');

/** 记录式 canvas：额外记下 arc 的半径与 fillText 的落点，用来断言"画在哪"。 */
function paintLog(){
  const log=[];
  let cur=[0,0];
  const c={fillStyle:'',strokeStyle:'',lineWidth:0,lineCap:'',lineJoin:'',font:'',textAlign:'',textBaseline:'',
    globalAlpha:1,shadowBlur:0,shadowColor:'',globalCompositeOperation:'',dash:[],
    save(){},restore(){},closePath(){},bezierCurveTo(){},quadraticCurveTo(){},rect(){},ellipse(){},clip(){},
    beginPath(){log.push({op:'beginPath'});},
    moveTo(x,y){log.push({op:'moveTo',x,y});},
    lineTo(x,y){log.push({op:'lineTo',x,y});},
    arc(x,y,r){log.push({op:'arc',x,y,r});},
    fillText(text,x,y){log.push({op:'fillText',text,x,y});},
    stroke(){log.push({op:'stroke',style:c.strokeStyle,dash:[...c.dash]});},
    fill(){log.push({op:'fill',fill:c.fillStyle});},
    fillRect(){},
    // 每帧开头 `clearRect` 就是「这一帧的画布归零」——记录器也跟着归零，
    // 断言看到的是**最后一帧**的画面，而不是三帧叠在一起的累加。
    clearRect(){log.length=0;},strokeRect(){},translate(){},rotate(){},scale(){},setTransform(){},
    setLineDash(v){c.dash=Array.from(v||[]);},
    measureText:t=>({width:String(t).length*6}),
    createLinearGradient:()=>({addColorStop(){}}),createRadialGradient:()=>({addColorStop(){}}),
    createPattern:()=>null,createConicGradient:()=>{throw new Error('unsupported');}};
  return {c,log,cur};
}

/** 真实跑一遍 create()：paused + once 帧，让 drawMarks/drawLabels 真的执行。 */
function rendererHarness({node, path, hooks={}, width=400, height=300}){
  const {c:ctx,log}=paintLog();
  const {c:mctx}=paintLog();
  const canvas={width:0,height:0,style:{},getContext:()=>ctx,addEventListener(){},removeEventListener(){},
    parentElement:{getBoundingClientRect:()=>({width,height})}};
  const mini={width:0,height:0,style:{},getContext:()=>mctx,getBoundingClientRect:()=>({width:200,height:120})};
  // hexA 用真实实现：颜色透明度是断言的一部分，不能替换成假字符串。
  const realHexA=(hex,a)=>{const h=String(hex).replace('#','');const r=parseInt(h.substr(0,2),16),g=parseInt(h.substr(2,2),16),b=parseInt(h.substr(4,2),16);return `rgba(${r},${g},${b},${a})`;};
  const runtime=vm.createContext({
    Math,Number,Array,Object,String,JSON,console,Set,Map,performance:{now:()=>0},
    requestAnimationFrame:()=>0, cancelAnimationFrame(){}, window:{devicePixelRatio:1},
    hexA:realHexA, ctx, mctx, canvas, mini,
  });
  vm.runInContext(MODULE+BODY, runtime);
  const map=runtime.create(canvas, mini, hooks);
  map.setPaused(true);
  map.setPath(node, path || [node]);
  map.resize();       // paused + node → 触发一次 once 帧
  return {map, ctx, log, st:map.state};
}

const WORLD_NODE={id:'world',name:'测试世界',kind:'world',code:'L0',host:true,sceneStatus:'missing',geo:{},extent:[-300,300,-200,200],
  marks:[
    {id:'C1',type:'char',x:-60,y:0,name:'主角甲',initial:'甲',hero:true,live:true,c:'#43e0ff'},
    {id:'C2',type:'char',x:0,y:0,name:'同伴乙',initial:'乙',live:true,c:'#9b6bff'},
    {id:'P1',type:'poi',x:60,y:0,name:'据点丙',c:'#ffc247'},
  ]};

test('M6-10 · 悬停/选中只改样式不改坐标：绘制锚点与命中点完全一致', () => {
  const h=rendererHarness({node:WORLD_NODE});
  const cam=h.st.cam, vw=h.st.vw, vh=h.st.vh;
  const want=id=>{const m=WORLD_NODE.marks.find(x=>x.id===id);return [ (m.x-cam.x)*cam.s+vw/2, (m.y-cam.y)*cam.s+vh/2 ];};
  const before=WORLD_NODE.marks.map(m=>[m.x,m.y]);

  const hits=()=>h.st.hits.slice();
  const at=id=>hits().find(x=>x.m.id===id);
  assert.ok(at('P1'),'视口内的标记必须可命中');
  for(const id of ['C1','C2','P1']){
    const [ex,ey]=want(id);
    assert.ok(Math.abs(at(id).x-ex)<1e-6&&Math.abs(at(id).y-ey)<1e-6,`${id} 命中点必须是同一套固定坐标`);
  }
  // 悬停 + 选中各来一次，锚点必须一动不动。
  h.st.hover=WORLD_NODE.marks[1];
  h.map.resize();
  assert.deepEqual([at('C2').x,at('C2').y],want('C2'),'悬停不得移动锚点');
  h.st.sel=WORLD_NODE.marks[0];
  h.map.resize();
  assert.deepEqual([at('C1').x,at('C1').y],want('C1'),'选中不得移动锚点');
  // 绘制用的坐标（drawMark 里圆心半径 9 的那个圆）必须就是命中坐标。
  const pupils=h.log.filter(e=>e.op==='arc'&&e.r===9);
  assert.equal(pupils.length,2,'两个人物标记各画一次头像圆');
  assert.ok(pupils.some(p=>Math.abs(p.x-at('C1').x)<1e-6&&Math.abs(p.y-at('C1').y)<1e-6),'画出来的点必须点得中');
  assert.deepEqual(WORLD_NODE.marks.map(m=>[m.x,m.y]),before,'任何绘制都不得回写世界坐标');
});

test('M6-10 · 视口外的标记既不该画也不该命中', () => {
  const far={...WORLD_NODE,marks:[...WORLD_NODE.marks,{id:'FAR',type:'poi',x:99999,y:99999,name:'天边',c:'#ffc247'}]};
  const h=rendererHarness({node:far});
  assert.equal(h.st.hits.some(x=>x.m.id==='FAR'),false,'视口外的标记不得进入命中表');
  assert.equal(h.log.some(e=>e.op==='fillText'&&e.text==='天边'),false,'视口外的标记不得绘制');
});

test('M6-10 · 标签避让：首选位在锚点正中下方，拥挤换方位并带 leader，全挤不下则收纳', () => {
  const runtime=mapRuntime({ctx:{}, st:{}, sections:[], pushLabel(){}});
  const first=runtime.placeLabel([],100,50,60,17);
  assert.deepEqual([first.box.x,first.box.y],[70,50],'首选位保持原观感：正中、锚点正下方');
  assert.equal(first.leader,false,'首选位不需要引线');

  const second=runtime.placeLabel([first.box],100,50,60,17);
  assert.notDeepEqual([second.box.x,second.box.y],[70,50],'撞上了必须换方位');
  assert.equal(second.leader,true,'挪开画的位置必须拉 leader 线');
  assert.ok(second.lx>=second.box.x&&second.lx<=second.box.x+second.box.w,'leader 横落点必须在自己标签盒边上');
  assert.ok(second.ly===second.box.y||second.ly===second.box.y+second.box.h,'leader 纵落点必须在盒边上');

  const boxes=[];
  for(let spot=runtime.placeLabel(boxes,100,50,60,17);spot;spot=runtime.placeLabel(boxes,100,50,60,17))boxes.push(spot.box);
  assert.equal(boxes.length,6,'六个候选方位应当都能用上');
  assert.equal(runtime.placeLabel(boxes,100,50,60,17),null,'六个方位全占满必须收纳，绝不叠上去');
});

test('M6-10 · 标签拥挤时优先保住在场人物，副标题让位且不移 marker', () => {
  // 三个标记的锚点几乎重合 → 标签必然互相压。
  const crowded={...WORLD_NODE,marks:[
    {id:'C1',type:'char',x:0,y:0,name:'主角甲',sub:'在场',initial:'甲',hero:true,live:true,c:'#43e0ff'},
    {id:'P1',type:'poi',x:2,y:2,name:'据点丙',c:'#ffc247'},
  ]};
  const h=rendererHarness({node:crowded});
  const texts=h.log.filter(e=>e.op==='fillText').map(e=>e.text);
  assert.ok(texts.includes('主角甲'),'在场人物的名字必须优先保住');
  assert.ok(texts.includes('据点丙'),'第二个标记的标签要换方位保住，而不是直接丢');
  // 人物副标题是最后一位：两个名字都占着时它必须让位。
  assert.ok(!texts.includes('在场'),'拥挤时副标题必须收纳，不能顶掉别人');
});
