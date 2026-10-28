/**
 * atlas-space-estimate.test.mjs — P06 §12.2 物理尺度估计。
 *
 * 核心回归：普通客运马车不再默认 24×24 m；说不出类型的载具保持待估计；
 * 100×100 格不再被强制变成正方形物理空间。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_METERS_PER_CELL,
  VEHICLE_TYPE_DEFAULTS,
  estimateSpaceFromType,
  fitFrameToPhysicalSize,
} from '../src/atlas-space-estimate.ts';

test('P06 §12.2: 马车按类型兜底 6×3 m，而不是整层 24 m', () => {
  const estimate = estimateSpaceFromType({ containerKind: 'vehicle', name: '客运马车' });
  assert.ok(estimate);
  assert.equal(estimate.vehicleType, 'carriage');
  assert.equal(estimate.widthM, 6);
  assert.equal(estimate.heightM, 3);
  assert.equal(estimate.source, 'type-default');
  assert.equal(estimate.quality, 'estimated', '这是兜底估计，不是实测标准');
  assert.notEqual(estimate.widthM, 24, 'F06 回归：不许再默认 24 m');
  assert.ok(estimate.issues.some((item) => item.code === 'SPACE_SIZE_ESTIMATED_FROM_TYPE'));
});

test('P06 §12.2: 载具档案里的显式类型优先于名称关键词', () => {
  const estimate = estimateSpaceFromType({
    containerKind: 'vehicle',
    name: '马车',
    vehicleProfile: { type: 'ship' },
  });
  assert.equal(estimate.vehicleType, 'ship');
  assert.equal(estimate.widthM, 40, '显式档案说是船，就不能按名字里的马车兜底');
  assert.ok(estimate.assumption.includes('档案声明类型'));
});

test('P06 §12.2: 大船不会被缩小成马车尺寸', () => {
  const estimate = estimateSpaceFromType({ containerKind: 'vehicle', name: '远洋商船' });
  assert.equal(estimate.vehicleType, 'ship');
  assert.ok(estimate.widthM >= 40, '船必须按船的量级估计');
  assert.ok(estimate.widthM > 6);
});

test('P06 §12.2: 小船先于大船匹配（顺序即优先级）', () => {
  const estimate = estimateSpaceFromType({ containerKind: 'vehicle', name: '河边小船' });
  assert.equal(estimate.vehicleType, 'boat');
  assert.equal(estimate.widthM, 8);
});

test('P06 §12.2: 只有「载具」标签、说不出类型 → 保留待估计', () => {
  const estimate = estimateSpaceFromType({ containerKind: 'vehicle', name: '不明载具' });
  assert.ok(estimate);
  assert.equal(estimate.source, 'none');
  assert.equal(estimate.vehicleType, null);
  assert.equal(estimate.widthM, 0, '没有依据就不给数字');
  assert.ok(estimate.issues.some((item) => item.code === 'SPACE_ESTIMATE_TYPE_UNKNOWN'));
});

test('P06 §12.2: vehicle_profile 是坏 JSON 时不当成显式类型，也不抛错', () => {
  const estimate = estimateSpaceFromType({
    containerKind: 'vehicle',
    name: '马车',
    vehicleProfile: '{not json',
  });
  assert.equal(estimate.vehicleType, 'carriage', '退回名称线索');
});

test('P06 §12.2: 非载具类型不由本模块估计（房间/城市的既有基准不变）', () => {
  for (const kind of ['room', 'city', 'building', 'floor', 'region', 'natural', '']) {
    assert.equal(estimateSpaceFromType({ containerKind: kind, name: '马车' }), null, `${kind} 不该走载具兜底`);
  }
});

test('P06 §12.2: 100×100 格不被强行变成正方形物理空间', () => {
  const frame = fitFrameToPhysicalSize({ widthM: 6, heightM: 3 });
  assert.equal(frame.cols, 12);
  assert.equal(frame.rows, 6);
  assert.equal(frame.metersPerCell, DEFAULT_METERS_PER_CELL);
  assert.notEqual(frame.cols, frame.rows, '6×3 的马车不能被画成正方形');
  assert.equal(frame.cols / frame.rows, 2, '宽高比必须与物理尺寸一致');
  assert.equal(frame.widthM, 6);
  assert.equal(frame.heightM, 3);
});

test('P06 §12.2: 幅面向上取整时只多留边、不把载具画短', () => {
  const frame = fitFrameToPhysicalSize({ widthM: 6.2, heightM: 3.1, targetMetersPerCell: 0.5 });
  assert.ok(frame.widthM >= 6.2);
  assert.ok(frame.heightM >= 3.1);
  assert.ok(frame.cols >= Math.ceil(6.2 / 0.5));
});

test('P06 §12.2: 非法尺寸/单位不产出幅面', () => {
  assert.equal(fitFrameToPhysicalSize({ widthM: 0, heightM: 3 }), null);
  assert.equal(fitFrameToPhysicalSize({ widthM: 6, heightM: -1 }), null);
  assert.equal(fitFrameToPhysicalSize({ widthM: Number.NaN, heightM: 3 }), null);
  assert.equal(fitFrameToPhysicalSize({ widthM: '6', heightM: 3 }), null, '字符串不是数字');
});

test('P06 §12.2: 目标格宽被夹在有界区间内', () => {
  const tiny = fitFrameToPhysicalSize({ widthM: 6, heightM: 3, targetMetersPerCell: 0.0001 });
  assert.equal(tiny.metersPerCell, 0.05);
  const huge = fitFrameToPhysicalSize({ widthM: 6, heightM: 3, targetMetersPerCell: 1000 });
  assert.equal(huge.metersPerCell, 10);
});

test('P06 §12.2: 类型兜底表覆盖计划点名的载具，且都是正数', () => {
  const types = VEHICLE_TYPE_DEFAULTS.map((entry) => entry.type);
  for (const expected of ['carriage', 'ship', 'train', 'airship']) {
    assert.ok(types.includes(expected), `缺少类型 ${expected}`);
  }
  for (const entry of VEHICLE_TYPE_DEFAULTS) {
    assert.ok(entry.widthM > 0 && entry.heightM > 0);
    assert.ok(entry.widthM >= entry.heightM, `${entry.type} 的长边应不小于短边`);
    assert.ok(entry.keywords.length > 0);
  }
});
