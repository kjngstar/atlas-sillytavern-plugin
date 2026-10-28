/**
 * atlas-map-camera-fit.test.mjs — P14/§21.3 地图观感（取景）
 *
 * 纪律：
 *  - 夹具一律走真实 `projectMapView` + `referenceGeometry`，不手搓一份「理想 geo」；
 *  - 断言的是**取景范围**与「只动相机」这条契约，不用像素结果冒充浏览器验收；
 *  - 楼层（floor）沿用房间几何的既有行为必须保持不变，别把 N01 的修正做成 floor 回归。
 *
 * 真实病灶：`layout.bounds` 声明的是整幅幅面；当实际对象只占其中一小块时，
 * 旧取景按 EXTENT 铺满整幅，内容就变成画面正中一个点。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {projectReferenceData, referenceGeometry} from '../ui/atlas-reference-data.mjs';
import {projectMapView} from '../vendor/atlas-spatial/view-adapter.mjs';

const SOURCE = readFileSync(new URL('../ui/atlas-reference/js/map.js', import.meta.url), 'utf8');
const cut = (from, to) => SOURCE.slice(SOURCE.indexOf(from), SOURCE.indexOf(to));
const view = items => ({branchId: 'main', revision: 0, items});
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/**
 * 真实 SQL 概览夹具：400×400 的幅面里放一块 `size` 大小的场地 + 一个端点。
 * `bounds` 故意远大于内容 —— 这正是「一个点」的成因。
 */
function overviewFixture({metersPerCell = 2, size = 10, origin = 0, extraPoints = [], extraRoutes = [], bounds = {x: 0, y: 0, w: 400, h: 400}} = {}) {
  const area = {kind: 'polygon', points: [{x: origin, y: origin}, {x: origin + size, y: origin},
    {x: origin + size, y: origin + size}, {x: origin, y: origin + size}]};
  const map = {
    mapId: 'm1', name: '测试区域', kind: 'overview', containerLocationId: null, parentMapId: null,
    connectionQuality: 'root', metersPerCell,
    points: [
      {entityId: 'yard', kind: 'location', name: '空庭院', mapId: 'm1', x: origin, y: origin, markerQuality: 'exact', area},
      {entityId: 'gate', kind: 'location', name: '入口', mapId: 'm1', x: origin + size / 2, y: origin + size / 2},
      ...extraPoints,
    ],
    routes: [
      {routeId: 'r1', fromLocationId: 'yard', toLocationId: 'gate', geometryQuality: 'confirmed',
        geometry: {mapId: 'm1', units: 'cells', points: [{x: origin, y: origin}, {x: origin + size / 2, y: origin + size / 2}]}},
      ...extraRoutes,
    ],
  };
  const result = projectMapView({view: view([map]), mapId: 'm1',
    scope: {chatId: 'test', branchId: 'main', revision: 0, viewMode: 'author'}});
  const scene = result.scene;
  scene.layout.bounds = bounds;
  return {map, scene};
}

/** 在 vm 里跑 map.js 的取景区段（extent/contentExtent/fitExtent/fitPad/fitScale/fit）。 */
function cameraRuntime(st) {
  const runtime = vm.createContext({st, EXTENT: {}, Math, Number, Array, Object, Infinity});
  vm.runInContext(cut('function extent()', 'function W2S('), runtime);
  return runtime;
}
const camera = (st, kind = 'region') => {
  st.kind = kind; st.vw = 800; st.vh = 600; st.cam = {}; st.tgt = {}; st.showMarks = true;
  return cameraRuntime(st);
};
const span = fit => [fit[1] - fit[0], fit[3] - fit[2]];
const unionOf = points => [Math.min(...points.map(p => p[0])), Math.max(...points.map(p => p[0])),
  Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[1]))];

test('CAMP01 · 内容只占幅面一小块时按内容取景，不再把内容画成整幅幅面里的一个点', () => {
  const {map, scene} = overviewFixture({origin: 40, size: 200});
  const geometry = referenceGeometry(map, scene);
  const shapePts = geometry.geo.overviewShapes[0].pts;
  const expected = unionOf([...shapePts, ...geometry.marks.map(m => [m.x, m.y])]);
  assert.notDeepEqual(expected, [-660, 660, -400, 400]);
  const st = {geo: geometry.geo, node: {extent: [-660, 660, -400, 400], marks: geometry.marks}};
  const runtime = camera(st);
  const fit = vm.runInContext('fitExtent()', runtime);
  assert.ok(near(fit[0], expected[0]) && near(fit[1], expected[1]), `取景 x 必须贴住真实内容，实际 ${fit}`);
  assert.ok(near(fit[2], expected[2]) && near(fit[3], expected[3]), `取景 y 必须贴住真实内容，实际 ${fit}`);
  const [wx, hy] = span(fit);
  assert.ok(wx < 1320 && hy < 800, `取景必须小于整幅幅面，实际 ${wx}×${hy}`);
  vm.runInContext('fit(false)', runtime);
  for (const [x, y] of shapePts) {
    const sx = (x - st.cam.x) * st.cam.s + st.vw / 2, sy = (y - st.cam.y) * st.cam.s + st.vh / 2;
    assert.ok(sx > 0 && sx < st.vw && sy > 0 && sy < st.vh, '内容边界必须留在视口内');
  }
  assert.deepEqual(st.node.extent, [-660, 660, -400, 400], '世界幅面本身不动');
  assert.equal(vm.runInContext('fitPad()', runtime), 1.12, '内容取景用约 12% 留白');
});

test('CAMP02 · 只有一个点时给最小可读视窗，不把镜头推到无限近', () => {
  const {map, scene} = overviewFixture({size: 0.001});
  const geometry = referenceGeometry(map, scene);
  const st = {geo: geometry.geo, node: {extent: [-660, 660, -400, 400], marks: geometry.marks}};
  const runtime = camera(st);
  const fit = vm.runInContext('fitExtent()', runtime);
  const [wx, hy] = span(fit);
  assert.ok(near(wx, 140, 1e-9), `单点必须给最小可读视窗宽度，实际 ${wx}`);
  assert.ok(near(hy, 140, 1e-9), `单点必须给最小可读视窗高度，实际 ${hy}`);
  const expected = unionOf([...geometry.geo.overviewShapes[0].pts, ...geometry.marks.map(m => [m.x, m.y])]);
  assert.ok(near((fit[0] + fit[1]) / 2, (expected[0] + expected[1]) / 2, 1e-3), '最小视窗要居中在真实内容上');
  assert.ok(near((fit[2] + fit[3]) / 2, (expected[2] + expected[3]) / 2, 1e-3));
});

test('CAMP03 · 内容范围大于整幅幅面时保留幅面，不用内容缩小世界', () => {
  const st = {geo: {overviewShapes: [{id: 'huge', pts: [[-2000, -1200], [2000, -1200], [2000, 1200]]}]},
    node: {extent: [-660, 660, -400, 400], marks: []}};
  const runtime = camera(st);
  assert.deepEqual(vm.runInContext('fitExtent()', runtime), [-660, 660, -400, 400]);
  assert.equal(vm.runInContext('fitPad()', runtime), 1.16, '退回幅面时留白也回到原值');
});

test('CAMP04 · 取景只动相机：geo、比例尺与 SQL 坐标一律不变', () => {
  const {map, scene} = overviewFixture({origin: 40, size: 200});
  const geometry = referenceGeometry(map, scene);
  const before = structuredClone({geo: geometry.geo, metric: geometry.metric, marks: geometry.marks, map});
  const st = {geo: geometry.geo, node: {extent: [-660, 660, -400, 400], marks: geometry.marks}};
  const runtime = camera(st);
  vm.runInContext('fit(false)', runtime);
  assert.deepEqual(geometry.geo, before.geo, 'geo 不许被取景改写');
  assert.deepEqual(geometry.metric, before.metric, '比例尺基准不变（74px 线长的换算源）');
  assert.deepEqual(geometry.marks, before.marks);
  assert.deepEqual(map, before.map, 'SQL 地图坐标不变');
});

test('CAMP05 · 在途/隐藏载具不进入内容范围（画面、诊断与相机 bounds 同源）', () => {
  const truck = {entityId: 'truck', kind: 'location', name: '货车', mapId: 'm1', x: 395, y: 395,
    markerQuality: 'exact', area: {kind: 'polygon', points: [{x: 380, y: 380}, {x: 400, y: 380}, {x: 400, y: 400}, {x: 380, y: 400}]}};
  const {map, scene} = overviewFixture({origin: 40, size: 200, extraPoints: [truck]});
  // 只有货车是「移动载具」，空庭院与入口是静态地点 —— 故意留对照组，避免整张图被一起滤掉。
  const place = (truckMobile) => view([
    {entityId: 'yard', entityKind: 'location', name: '空庭院', mapId: 'm1', locationKind: 'region'},
    {entityId: 'gate', entityKind: 'location', name: '入口', mapId: 'm1', locationKind: 'region'},
    {entityId: 'truck', entityKind: 'location', name: '货车', mapId: 'm1', locationKind: 'region', ...(truckMobile ? {mobility: 'mobile'} : {})},
  ]);
  const flow = (status) => view([{flowId: 'f1', kind: 'journey', status, moverEntityId: 'truck', mapId: 'm1'}]);
  const project = (catalog, status) => projectReferenceData({mapView: view([map]), sceneView: view([{mapId: 'm1', scene}]),
    catalogView: catalog, flowView: flow(status), viewMode: 'author'}).ROOT;
  const moving = project(place(true), 'moving');
  assert.equal(moving.geo.overviewShapes.length, 1, '在途载具的范围不进公开几何');
  assert.equal(moving.geo.overviewShapes[0].id, 'yard');
  assert.equal(moving.marks.filter(m => m.id === 'truck').length, 0, '在途载具不产生标记');
  const parked = project(place(true), 'arrived');
  assert.equal(parked.geo.overviewShapes.length, 1, '停靠载具同样没有永久地理 footprint');
  assert.equal(parked.marks.filter(m => m.id === 'truck').length, 1, '停靠载具的标记照常显示（对照组）');
  const statics = project(place(false), 'arrived');
  assert.equal(statics.geo.overviewShapes.length, 2, '同一张图里的静态地点照常进几何（对照组）');
  const fitOf = (node) => {
    const st = {geo: node.geo, node: {extent: [-660, 660, -400, 400], marks: node.marks}};
    return vm.runInContext('fitExtent()', camera(st));
  };
  const movingFit = fitOf(moving), parkedFit = fitOf(parked), staticFit = fitOf(statics);
  const expected = unionOf([...moving.geo.overviewShapes[0].pts, ...moving.marks.map(m => [m.x, m.y])]);
  assert.ok(near(movingFit[0], expected[0]) && near(movingFit[1], expected[1])
    && near(movingFit[2], expected[2]) && near(movingFit[3], expected[3]), `取景必须只由可见内容决定，实际 ${movingFit}`);
  assert.ok(parkedFit[1] > movingFit[1], '停靠载具若被算进去，取景会被拉到更远处 —— 证明在途排除真的生效');
  assert.ok(staticFit[1] > movingFit[1], '静态载具（对照组）确实会把取景拉远，说明差值来自载具本身');
});

test('CAMP06 · 楼层沿用房间几何：单房间与多房间 host 的既有行为不回归', () => {
  const room = {x: -90, y: 35, w: 80, h: 120};
  const st = {kind: 'floor', node: {extent: [-540, 540, -340, 360]}, geo: {rooms: [room], corridor: {h: 0}}};
  const runtime = camera(st, 'floor');
  vm.runInContext('fit(false)', runtime);
  assert.equal(st.cam.x, -50);
  assert.equal(st.cam.y, 95);
  assert.ok(near(st.cam.s, 600 / (120 * 1.16), 1e-10), 'floor 仍用 1.16 留白与房间几何');
  st.geo.rooms.push({...room, x: 100});
  vm.runInContext('fit(false)', runtime);
  assert.equal(st.cam.x, 0, '非 host 多房间仍是整层幅面');
  assert.equal(st.cam.y, 10);
  st.node.host = true;
  vm.runInContext('fit(false)', runtime);
  assert.ok(st.cam.s > 1, '已保存的多房间布局填满视野');
  assert.deepEqual(st.node.extent, [-540, 540, -340, 360]);
});

test('CAMP07 · 相机不可信/无内容时退回幅面，不产生 NaN 取景', () => {
  const st = {geo: {overviewShapes: [{id: 'bad', pts: [[NaN, 1], [2, Infinity]]}]},
    node: {extent: [-660, 660, -400, 400], marks: []}};
  const runtime = camera(st);
  assert.deepEqual(vm.runInContext('fitExtent()', runtime), [-660, 660, -400, 400]);
  assert.equal(vm.runInContext('fitPad()', runtime), 1.16);
});

function sparseGeography({metersPerCell=2,extra=[]}={}){
  const far={entityId:'far',kind:'location',name:'远方城市',mapId:'m1',x:150,y:3100,
    area:{kind:'polygon',points:[{x:130,y:3080},{x:170,y:3080},{x:170,y:3120},{x:130,y:3120}]}};
  const {map,scene}=overviewFixture({origin:100,size:40,metersPerCell,extraPoints:[far,...extra],bounds:{x:0,y:0,w:8000,h:8000}});
  const geometry=referenceGeometry(map,scene);
  const st={geo:geometry.geo,node:{host:true,extent:geometry.extent,marks:geometry.marks,metric:geometry.metric}};
  return {map,scene,geometry,st,runtime:camera(st)};
}
const conventionalFit=runtime=>vm.runInContext('(()=>{const [x0,x1,y0,y1]=fitExtent(),pad=fitPad();return Math.min(st.vw/((x1-x0)*pad),st.vh/((y1-y0)*pad));})()',runtime);

test('CAMP08 · 稀疏地区图收紧屏幕间距，世界坐标与实际距离保持',()=>{
  const {map,scene,geometry,st,runtime}=sparseGeography();
  const before=structuredClone({map,scene,geometry});
  const base=conventionalFit(runtime);
  vm.runInContext('fit(false)',runtime);
  assert.ok(st.cam.s<base,'只有少数分散地点时不再铺到视口两端');
  const a=st.node.marks.find(m=>m.id==='yard'),b=st.node.marks.find(m=>m.id==='far');
  const screenDistance=Math.hypot(a.x-b.x,a.y-b.y)*st.cam.s;
  assert.ok(screenDistance<=220+1e-6,'默认视图把稀疏地点放在紧凑可读范围');
  const physicalDistance=Math.hypot(100-150,100-3100)*2;
  assert.ok(near(screenDistance/st.cam.s*geometry.metric,physicalDistance),'缩放后换回同一物理距离');
  assert.deepEqual({map,scene,geometry},before,'不改存档、几何、格数或米/格');
  const model=vm.createContext({module:{exports:{}}});
  vm.runInContext(readFileSync(new URL('../ui/atlas-reference/js/ui-model.js',import.meta.url),'utf8'),model);
  const oldBar=model.module.exports.fixedScale(base,geometry.metric),newBar=model.module.exports.fixedScale(st.cam.s,geometry.metric);
  assert.ok(newBar.distance>oldBar.distance,'缩小地图时同长标尺表达更长距离');
  assert.ok(near(newBar.distance/oldBar.distance,base/st.cam.s),'标尺随实际相机比例精确更新');
});

test('CAMP09 · 窄屏仍以相同比例缩放两轴，未标定图继续用格',()=>{
  const {geometry,st,runtime}=sparseGeography({metersPerCell:null});
  st.vw=320;st.vh=720;
  vm.runInContext(cut('function W2S(', 'function S2W('),runtime);
  vm.runInContext('fit(false)',runtime);
  const places=st.node.marks;
  for(const a of places)for(const b of places){
    const p=vm.runInContext(`W2S(${a.x},${a.y})`,runtime),q=vm.runInContext(`W2S(${b.x},${b.y})`,runtime);
    assert.ok(near(Math.hypot(p[0]-q[0],p[1]-q[1]),Math.hypot(a.x-b.x,a.y-b.y)*st.cam.s));
    assert.ok(Math.hypot(p[0]-q[0],p[1]-q[1])<=320*.42+1e-6);
  }
  assert.equal(geometry.metric,null,'未标定不因紧凑取景变成米制');
});

test('CAMP10 · 密集地点、城市以及丰富地形保留通常取景',()=>{
  const extra=Array.from({length:3},(_,i)=>({entityId:'extra'+i,kind:'location',name:'其他地点',mapId:'m1',x:250+i*100,y:1000+i*300}));
  const dense=sparseGeography({extra});
  assert.equal(vm.runInContext('fitScale()',dense.runtime),conventionalFit(dense.runtime));
  const city=sparseGeography();city.st.kind='city';
  assert.equal(vm.runInContext('fitScale()',city.runtime),conventionalFit(city.runtime));
  const terrain=sparseGeography();
  terrain.st.geo.overviewFeatures.push({id:'forest',type:'forest_texture',poly:terrain.st.geo.overviewShapes[0].pts});
  assert.equal(vm.runInContext('fitScale()',terrain.runtime),conventionalFit(terrain.runtime));
});
