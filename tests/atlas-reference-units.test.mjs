/**
 * atlas-reference-units.test.mjs — P03 / N03：坐标单位只转换一次。
 *
 * 覆盖：
 * - U01 格制载具点进入米制场景只换一次：(59.375, 29.1666667) × 0.24 ≈ (14.25, 7)，与同坐标锚点重合
 * - U02 mpp=1 / 100 正确；mpp=null / 0 / NaN / Infinity 不产生有效跨单位点
 * - U03 连续两次调用结果相等，原 DTO 深比较不变
 * - U04 格制场景不乘 mpp；场景内已有米制点不再乘一次
 * - U05 proxy 不升级精度；隐藏载具与隐藏位置的诊断不进入画面
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceGeometry, toScenePoint } from '../ui/atlas-reference-data.mjs';

const sceneOf = ({ units = 'meters', mpp = 0.24, points = [], pins = [], bounds = { x: 0, y: 0, w: 100, h: 100 } } = {}) => ({
  units, metersPerCell: mpp,
  layout: { kind: 'overview', bounds, surface: 'mixed', pins, shapes: [], routes: [], features: [] },
});

test('U01 格坐标载具在米制场景里只换一次单位，并与同坐标锚点重合', () => {
  const cell = { x: 59.375, y: 29.1666667 };
  const converted = toScenePoint(cell, 'cells', 'meters', 0.24);
  assert.ok(converted, '有效 mpp 必须能换算');
  assert.ok(Math.abs(converted.x - 14.25) < 1e-9, `横向应为 14.25m，实际 ${converted.x}`);
  assert.ok(Math.abs(converted.y - 7) < 1e-6, `纵向应约 7m，实际 ${converted.y}`);

  const map = {
    mapId: 'M', name: '世界图', kind: 'world', metersPerCell: 0.24,
    // 载具**只**作为格制移动点出现；锚点**只**作为米制 pin 出现在布局里。
    // 两者不能是同一个「同键实体」：uniquePins 用 `new Map(entries)` 去重，后者覆盖前者，
    // 若两点同键则旧代码（不换算）算出的也是同一个值，这条断言就失去判别力。
    points: [
      { entityId: 'veh', kind: 'location', name: '马车', mobility: 'mobile', markerQuality: 'exact', ...cell },
    ],
  };
  const scene = sceneOf({ mpp: 0.24, pins: [{ id: 'anchor', entityId: 'anchor', name: '锚点', type: 'location', x: 14.25, y: 7, quality: 'exact' }] });
  const g = referenceGeometry(map, scene);
  const veh = g.marks.find(m => m.id === 'veh');
  const anchor = g.marks.find(m => m.id === 'anchor');
  assert.ok(veh && anchor, '两个点都必须出现在画面里');
  // 直接对照绝对位置：不换算的旧实现会把载具画在格值对应的画布位置（52.5），与锚点（-200.2）差一大截。
  assert.ok(Math.abs(veh.x - anchor.x) < 1e-9, `载具与锚点必须横向重合：${veh.x} vs ${anchor.x}`);
  assert.ok(Math.abs(veh.y - anchor.y) < 1e-6, `载具与锚点必须纵向重合：${veh.y} vs ${anchor.y}`);
  assert.ok(Math.abs(veh.x - 52.5) > 1, `载具不得停在「格值直用」的位置 52.5（实际 ${veh.x}）`);
});

test('U02 mpp=1 / 100 正确；null / 0 / NaN / Infinity 不产生有效跨单位点', () => {
  assert.deepEqual(toScenePoint({ x: 3, y: 4 }, 'cells', 'meters', 1), { x: 3, y: 4 });
  assert.deepEqual(toScenePoint({ x: 3, y: 4 }, 'cells', 'meters', 100), { x: 300, y: 400 });
  assert.deepEqual(toScenePoint({ x: 300, y: 400 }, 'meters', 'cells', 100), { x: 3, y: 4 });
  for (const bad of [null, 0, -1, NaN, Infinity, undefined, '1']) {
    assert.equal(toScenePoint({ x: 3, y: 4 }, 'cells', 'meters', bad), null, `mpp=${String(bad)} 必须失败，不得默认 1`);
  }
  // 同单位不依赖 mpp。
  assert.deepEqual(toScenePoint({ x: 3, y: 4 }, 'cells', 'cells', null), { x: 3, y: 4 });
  assert.deepEqual(toScenePoint({ x: 3, y: 4 }, 'meters', 'meters', null), { x: 3, y: 4 });
  // 非有限坐标本身即失败。
  assert.equal(toScenePoint({ x: NaN, y: 4 }, 'cells', 'meters', 1), null);
});

test('U03 连续两次调用结果相等，且不修改传入的 map / scene', () => {
  const map = {
    mapId: 'M', kind: 'world', metersPerCell: 0.24,
    points: [{ entityId: 'veh', kind: 'location', name: '马车', mobility: 'mobile', x: 59.375, y: 29.1666667 }],
  };
  const scene = sceneOf({ points: [], pins: [{ id: 'p1', entityId: 'p1', name: '点', type: 'location', x: 14.25, y: 7, quality: 'exact' }] });
  const mapBefore = structuredClone(map), sceneBefore = structuredClone(scene);
  const first = referenceGeometry(map, scene);
  const second = referenceGeometry(map, scene);
  assert.deepEqual(first, second, '同一输入必须得到同一结果');
  assert.deepEqual(map, mapBefore, '不得修改地图 DTO');
  assert.deepEqual(scene, sceneBefore, '不得修改场景 DTO');
});

test('U04 格制场景不乘 mpp；场景内已有米制点不再乘一次', () => {
  const bounds = { x: 0, y: 0, w: 100, h: 100 };
  const scale = Math.min(940 / 100, 560 / 100);
  const expected = (v, b) => (v - b.x - b.w / 2) * scale;

  // 格制场景：载具点就是格，不乘 mpp（即使地图带了 metersPerCell）。
  const cellsMap = {
    mapId: 'M', kind: 'world', metersPerCell: 0.24,
    points: [{ entityId: 'veh', kind: 'location', name: '马车', mobility: 'mobile', x: 30, y: 40 }],
  };
  const cellsScene = sceneOf({ units: 'cells', mpp: 0.24, bounds });
  const cellsMark = referenceGeometry(cellsMap, cellsScene).marks.find(m => m.id === 'veh');
  assert.ok(cellsMark, '格制场景必须画出载具');
  assert.ok(Math.abs(cellsMark.x - expected(30, bounds)) < 1e-9, '格制点不得乘 mpp');
  assert.ok(Math.abs(cellsMark.y - expected(40, bounds)) < 1e-9);

  // 米制场景里的米制点：只套一次画布变换，不再乘 mpp。
  const metersMap = { mapId: 'M', kind: 'world', metersPerCell: 0.24, points: [] };
  const metersScene = sceneOf({ units: 'meters', mpp: 0.24, bounds, pins: [{ id: 'p1', entityId: 'p1', name: '点', type: 'location', x: 30, y: 40, quality: 'exact' }] });
  const metersMark = referenceGeometry(metersMap, metersScene).marks.find(m => m.id === 'p1');
  assert.ok(metersMark, '米制点必须出现在画面里');
  assert.ok(Math.abs(metersMark.x - expected(30, bounds)) < 1e-9, '米制点不得再乘 mpp');
  assert.ok(Math.abs(metersMark.y - expected(40, bounds)) < 1e-9);
});

test('U05 proxy 不升级精度；隐藏载具与缺尺度提示都不进画面', () => {
  // proxy：示意图标保留身份但精度显式降级。
  const proxyMap = {
    mapId: 'M', kind: 'world', metersPerCell: 0.24,
    points: [{ entityId: 'veh', kind: 'location', name: '马车', mobility: 'mobile', placement: 'proxy', markerQuality: 'exact', x: 5, y: 5 }],
  };
  const proxyMark = referenceGeometry(proxyMap, sceneOf({ mpp: 0.24 })).marks.find(m => m.id === 'veh');
  assert.equal(proxyMark.quality, 'proxy', 'proxy 绝不允许升级成 exact');
  assert.equal(proxyMark.proxy, true);

  // 隐藏载具：既不出现在画面，也不产生诊断（诊断可能泄露实体身份）。
  const hiddenMap = {
    mapId: 'M', kind: 'world', metersPerCell: 0.24,
    points: [{ entityId: 'secret-veh', kind: 'location', name: '密车', mobility: 'mobile', hidden: true, x: 5, y: 5 }],
  };
  const hiddenG = referenceGeometry(hiddenMap, sceneOf({ mpp: 0.24 }));
  assert.equal(hiddenG.marks.find(m => m.id === 'secret-veh'), undefined, '隐藏载具不得进画面');
  assert.equal(hiddenG.diagnostics.length, 0, '隐藏对象不得产生泄露身份的提示');

  // 跨单位缺尺度：可见对象保留可定位提示，但不下发错误坐标。
  const badMap = {
    mapId: 'M', kind: 'world', metersPerCell: null,
    points: [{ entityId: 'veh2', kind: 'location', name: '马车', mobility: 'mobile', x: 5, y: 5 }],
  };
  const badG = referenceGeometry(badMap, sceneOf({ mpp: null }));
  assert.equal(badG.marks.find(m => m.id === 'veh2'), undefined, '缺尺度不得塞入坏坐标');
  assert.equal(badG.diagnostics.length, 1, '必须留下一条可定位提示');
  assert.equal(badG.diagnostics[0].code, 'POINT_UNIT_UNCONVERTIBLE');
  assert.equal(badG.diagnostics[0].entityId, 'veh2');
});
