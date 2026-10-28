/**
 * atlas-map-quality.test.mjs — P06 §12.7 可解释质量。
 *
 * 重点：五维分开报、硬失败不发布、未检查就是 unknown（不写 checked）、
 * 未标定图不给精确米数。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASPECT_DRIFT_REVIEW_THRESHOLD,
  MAP_QUALITY_DIMENSIONS,
  assessMapQuality,
} from '../src/atlas-map-quality.ts';

const health = (overrides = {}) => ({
  mapId: 'M1',
  calibrated: true,
  scaleQuality: 'confirmed',
  coverage: { requiredMembers: 3, presentMembers: 3 },
  geometry: { hardErrors: 0, lockViolations: 0 },
  navigability: { requiredRoutes: 2, drawnRoutes: 2 },
  scale: { aspectDrift: 0 },
  plausibility: { unsupportedStructures: 0 },
  ...overrides,
});

test('P06 §12.7: 五维全过才算 pass，且 inspected 为真', () => {
  const quality = assessMapQuality(health());
  assert.equal(quality.verdict, 'pass');
  assert.equal(quality.inspected, true);
  for (const dimension of MAP_QUALITY_DIMENSIONS) {
    assert.equal(quality.dimensions[dimension], 'pass', `${dimension} 应通过`);
  }
  assert.deepEqual(quality.issues, []);
});

test('P06 §12.7: 硬几何失败 → blocked，不发布坏图', () => {
  const quality = assessMapQuality(health({ geometry: { hardErrors: 2 } }));
  assert.equal(quality.dimensions['geometry-locks'], 'fail');
  assert.equal(quality.verdict, 'blocked');
  const blocked = quality.issues.find((item) => item.code === 'MAP_QUALITY_BLOCKED');
  assert.ok(blocked);
  assert.equal(blocked.severity, 'error');
});

test('P06 §12.7: 锁冲突同样阻断', () => {
  const quality = assessMapQuality(health({ geometry: { lockViolations: 1 } }));
  assert.equal(quality.verdict, 'blocked');
});

test('P06 §12.7: 必要通路没画出来 → blocked，不能声称交通完整', () => {
  const quality = assessMapQuality(health({ navigability: { requiredRoutes: 4, drawnRoutes: 3, undrawnRouteIds: ['R9'] } }));
  assert.equal(quality.dimensions.navigability, 'fail');
  assert.equal(quality.verdict, 'blocked');
  const finding = quality.findings.find((item) => item.dimension === 'navigability');
  assert.ok(finding.message.includes('R9'));
});

test('P06 §12.7: 成员缺项列 review，不阻断发布', () => {
  const quality = assessMapQuality(health({ coverage: { requiredMembers: 4, presentMembers: 3, missingIds: ['L9'] } }));
  assert.equal(quality.dimensions.coverage, 'review');
  assert.equal(quality.verdict, 'review');
});

test('P06 §12.7: 模板表达不了的结构列 review，不靠改 kind 假装完整', () => {
  const quality = assessMapQuality(health({ plausibility: { unsupportedStructures: 1 } }));
  assert.equal(quality.dimensions.plausibility, 'review');
  assert.equal(quality.verdict, 'review');
  assert.equal(quality.dimensions['geometry-locks'], 'pass', '不支持结构不是几何硬失败');
});

test('P06 §12.7: 预算耗尽 → 没检查的维度是 unknown，不写 checked', () => {
  const quality = assessMapQuality(health({
    budgetExhausted: true,
    checked: ['coverage'],
  }));
  assert.equal(quality.dimensions.coverage, 'pass');
  for (const dimension of MAP_QUALITY_DIMENSIONS.filter((item) => item !== 'coverage')) {
    assert.equal(quality.dimensions[dimension], 'unknown', `${dimension} 未检查必须 unknown`);
  }
  assert.equal(quality.inspected, false, '没检查完不能声称检查过');
  assert.equal(quality.verdict, 'unknown');
});

test('P06 §12.7: unknown 优先于 review —— 没看完就不能说「只是有点问题」', () => {
  const quality = assessMapQuality(health({
    budgetExhausted: true,
    checked: ['coverage'],
    coverage: { requiredMembers: 3, presentMembers: 1 },
  }));
  assert.equal(quality.dimensions.coverage, 'review');
  assert.equal(quality.verdict, 'unknown');
});

test('P06 §12.7: 未标定图不给精确米数，尺度结论保持 unknown', () => {
  const quality = assessMapQuality(health({ calibrated: false, scaleQuality: 'uncalibrated' }));
  assert.equal(quality.dimensions.scale, 'unknown');
  assert.equal(quality.scalePrecision, 'unknown');
  const finding = quality.findings.find((item) => item.dimension === 'scale');
  assert.ok(finding.message.includes('不输出精确米数'));
});

test('P06 §12.7: 标定但只是估计 → 精度只能说到 approximate', () => {
  const quality = assessMapQuality(health({ calibrated: true, scaleQuality: 'estimated' }));
  assert.equal(quality.scalePrecision, 'approximate');
  const confirmed = assessMapQuality(health({ calibrated: true, scaleQuality: 'confirmed' }));
  assert.equal(confirmed.scalePrecision, 'exact-meters');
});

test('P06 §12.7: 比例失真超阈值列 review，但不改锁、不重排', () => {
  const quality = assessMapQuality(health({ scale: { aspectDrift: ASPECT_DRIFT_REVIEW_THRESHOLD + 0.1 } }));
  assert.equal(quality.dimensions.scale, 'review');
  assert.equal(quality.verdict, 'review');
  const below = assessMapQuality(health({ scale: { aspectDrift: ASPECT_DRIFT_REVIEW_THRESHOLD - 0.1 } }));
  assert.equal(below.dimensions.scale, 'pass');
});

test('P06 §12.7: 硬失败优先于 unknown —— 已知坏图不能因为没检查完就放行', () => {
  const quality = assessMapQuality(health({
    budgetExhausted: true,
    checked: ['geometry-locks'],
    geometry: { hardErrors: 1 },
  }));
  assert.equal(quality.verdict, 'blocked');
});

test('P06 §12.7: 路线需求为 0 的图不因为「没路线」被判失败', () => {
  const quality = assessMapQuality(health({ navigability: { requiredRoutes: 0, drawnRoutes: 0 } }));
  assert.equal(quality.dimensions.navigability, 'pass');
  assert.equal(quality.verdict, 'pass');
});
