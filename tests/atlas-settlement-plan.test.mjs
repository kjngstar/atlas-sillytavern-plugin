/**
 * atlas-settlement-plan.test.mjs — P03 §9.3 有限设施方案。
 *
 * 关注四件事：清单随世界观/规模变化、复用已有设施、同类多家只在规模允许时出现、
 * 输入不变就复用方案（续建不无限增殖）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSettlementPlanCurrent,
  planSettlementFacilities,
  settlementInputSignature,
  splitSettlementPlan,
} from '../src/atlas-world-build-plan.ts';

const purposes = (plan) => plan.facilities.map((facility) => facility.purpose);
const slotKeys = (plan) => plan.facilities.map((facility) => facility.slotKey);

test('P03 §9.3: 小城设施数量有界，且不机械重复同一用途', () => {
  const { plan, issues } = planSettlementFacilities({ settlementId: 'C1', scaleClass: 'small', worldviewTags: ['中世纪'] });
  assert.deepEqual(issues, []);
  assert.equal(plan.facilities.length, 4);
  assert.equal(new Set(purposes(plan)).size, 4, '小城不该出现两家同用途设施');
  assert.deepEqual(slotKeys(plan), purposes(plan), '每个用途只有一份时 slotKey 就是用途键');
});

test('P03 §9.3: 大城允许同类多家，slotKey 区分两份而不是按名字合并', () => {
  const { plan } = planSettlementFacilities({ settlementId: 'C1', scaleClass: 'large', worldviewTags: ['中世纪'] });
  assert.equal(plan.facilities.length, 9);
  const inns = plan.facilities.filter((facility) => facility.purpose === 'inn');
  assert.equal(inns.length, 2, '大城两家酒馆是两个合法 slot');
  assert.deepEqual(inns.map((facility) => facility.slotKey), ['inn', 'inn#2']);
  assert.equal(new Set(slotKeys(plan)).size, plan.facilities.length, 'slotKey 在方案内唯一');
});

test('P03 §9.3: 不同世界观给不同清单，不套同一张表', () => {
  const medieval = planSettlementFacilities({ settlementId: 'C1', scaleClass: 'medium', worldviewTags: ['中世纪'] }).plan;
  const maritime = planSettlementFacilities({ settlementId: 'C2', scaleClass: 'medium', worldviewTags: ['港口'] }).plan;
  const modern = planSettlementFacilities({ settlementId: 'C3', scaleClass: 'medium', worldviewTags: ['现代'] }).plan;

  assert.ok(purposes(maritime).includes('dock'), '港口聚落必须有码头');
  assert.ok(!purposes(maritime).includes('smithy'), '港口不照抄中世纪清单');
  assert.ok(purposes(modern).includes('clinic'));
  assert.notDeepEqual(purposes(medieval), purposes(maritime));
});

test('P03 §9.3: 世界书已有同用途设施时先复用，不重复造', () => {
  const { plan } = planSettlementFacilities({
    settlementId: 'C1',
    scaleClass: 'small',
    worldviewTags: ['中世纪'],
    existingLocations: [
      { id: 'L_INN', name: '老王酒馆', fromSource: true },
      { id: 'L_MARKET', name: '南门集市' },
    ],
  });
  const inn = plan.facilities.find((facility) => facility.purpose === 'inn');
  assert.equal(inn.existingLocationId, 'L_INN');
  assert.equal(inn.newLocationRef, null, '复用与新建互斥');
  assert.equal(inn.interiorPolicy, 'required-at-start', '世界书明确登记的设施按来源口径');

  const market = plan.facilities.find((facility) => facility.purpose === 'market');
  assert.equal(market.existingLocationId, 'L_MARKET');
  assert.equal(market.interiorPolicy, 'on-confirmed-entry', '没有来源标记就按常识补充口径');

  const smithy = plan.facilities.find((facility) => facility.purpose === 'smithy');
  assert.equal(smithy.existingLocationId, null);
  assert.ok(String(smithy.newLocationRef).startsWith('new:facility_'));
});

test('P03 §9.3: 同一个已有地点不会被两个 slot 重复占用', () => {
  const { plan } = planSettlementFacilities({
    settlementId: 'C1',
    scaleClass: 'large',
    worldviewTags: ['中世纪'],
    existingLocations: [{ id: 'L_INN', name: '唯一酒馆' }],
  });
  const claimed = plan.facilities.filter((facility) => facility.existingLocationId === 'L_INN');
  assert.equal(claimed.length, 1, '两家酒馆不能都指向同一个已有地点');
  const second = plan.facilities.filter((facility) => facility.purpose === 'inn')[1];
  assert.equal(second.existingLocationId, null);
  assert.ok(second.newLocationRef, '第二家必须真的新建，不能借名合并');
});

test('P03 §9.3: 新建引用是确定性的，同一输入两次结果一致', () => {
  const input = { settlementId: 'C1', scaleClass: 'medium', worldviewTags: ['中世纪'] };
  const first = planSettlementFacilities(input).plan;
  const second = planSettlementFacilities(input).plan;
  assert.deepEqual(first, second);
  assert.deepEqual(first.facilities.map((facility) => facility.newLocationRef), second.facilities.map((facility) => facility.newLocationRef));
});

test('P03 §9.3: 输入签名稳定；规模或已有地点变化就变', () => {
  const base = { settlementId: 'C1', scaleClass: 'small', worldviewTags: ['中世纪'] };
  const signature = settlementInputSignature(base);
  assert.equal(signature, settlementInputSignature({ ...base, worldviewTags: ['中世纪', '中世纪'] }), '重复标签不影响签名');

  const plan = planSettlementFacilities(base).plan;
  assert.equal(isSettlementPlanCurrent(plan, base), true, '输入未变 → 复用方案');

  assert.equal(isSettlementPlanCurrent(plan, { ...base, scaleClass: 'large' }), false);
  const withExisting = { ...base, existingLocations: [{ id: 'L1', name: '旧酒馆' }] };
  assert.notEqual(settlementInputSignature(withExisting), signature);
  assert.equal(isSettlementPlanCurrent(plan, withExisting), false);
});

test('P03 §9.3: 续建不增殖——同一方案反复规划长度不变', () => {
  const input = { settlementId: 'C1', scaleClass: 'medium', worldviewTags: ['中世纪'] };
  const first = planSettlementFacilities(input).plan;
  const again = planSettlementFacilities(input).plan;
  assert.equal(again.facilities.length, first.facilities.length);
  assert.deepEqual(slotKeys(again), slotKeys(first), '续建不该「又发现还缺一家」');
});

test('P03 §9.3: 方案过大时拆成 part 行，拼起来无损', () => {
  const { plan } = planSettlementFacilities({ settlementId: 'C1', scaleClass: 'large', worldviewTags: ['中世纪'] });
  const parts = splitSettlementPlan(plan, 4);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map((part) => part.part), [1, 2, 3]);
  assert.ok(parts.every((part) => part.totalParts === 3));
  assert.ok(parts.every((part) => part.settlementId === 'C1'));
  assert.ok(parts.every((part) => part.inputSignature === plan.inputSignature));

  const rejoined = parts.flatMap((part) => part.facilities);
  assert.deepEqual(rejoined, [...plan.facilities], '拆分不复制也不丢设施');
  assert.equal(new Set(rejoined.map((facility) => facility.slotKey)).size, plan.facilities.length);
});

test('P03 §9.3: 拆分的边界值（每片一个 / 单片装下全部）', () => {
  const { plan } = planSettlementFacilities({ settlementId: 'C1', scaleClass: 'small', worldviewTags: ['中世纪'] });
  const oneEach = splitSettlementPlan(plan, 1);
  assert.equal(oneEach.length, plan.facilities.length);
  assert.ok(oneEach.every((part) => part.facilities.length === 1));

  const single = splitSettlementPlan(plan, 100);
  assert.equal(single.length, 1);
  assert.equal(single[0].facilities.length, plan.facilities.length);
});

test('P03 §9.3: 规模不明按保守值规划，并明说这是解释性估计', () => {
  const { plan, issues } = planSettlementFacilities({ settlementId: 'C1', worldviewTags: ['中世纪'] });
  assert.equal(plan.scaleClass, 'unknown');
  assert.equal(plan.facilities.length, 5);
  const scaleIssue = issues.find((item) => item.code === 'SETTLEMENT_SCALE_UNKNOWN');
  assert.ok(scaleIssue);
  assert.ok(scaleIssue.message.includes('解释性估计'), '不伪称世界书写了具体人口');
});

test('P03 §9.3: 世界观标签认不出时退回通用目录，并显式告警', () => {
  const { plan, issues } = planSettlementFacilities({ settlementId: 'C1', scaleClass: 'small', worldviewTags: ['克苏鲁外海'] });
  assert.equal(plan.worldviewTags.includes('克苏鲁外海'), true, '未知标签仍进签名');
  assert.ok(issues.some((item) => item.code === 'SETTLEMENT_WORLDVIEW_UNKNOWN'));
  assert.equal(plan.facilities.length, 4);
  assert.deepEqual(purposes(plan), ['inn', 'market', 'well', 'stable']);
});

test('P03 §9.3: 目录不够目标时如实记录差额，不用副本凑数', () => {
  const { plan, issues } = planSettlementFacilities({ settlementId: 'C1', scaleClass: 'medium', worldviewTags: ['荒野'] });
  assert.equal(plan.facilities.length, 5, '荒野目录只有 5 项');
  const shortfall = issues.find((item) => item.code === 'SETTLEMENT_PLAN_BELOW_SCALE_TARGET');
  assert.ok(shortfall);
  assert.equal(new Set(purposes(plan)).size, plan.facilities.length, '不重复副本凑数');
});

test('P03 §9.3: 没有聚落 ID 就不生成设施（错误级，不猜）', () => {
  const { plan, issues } = planSettlementFacilities({ settlementId: '   ', scaleClass: 'small', worldviewTags: ['中世纪'] });
  assert.deepEqual(plan.facilities, []);
  const missing = issues.find((item) => item.code === 'SETTLEMENT_ID_MISSING');
  assert.ok(missing);
  assert.equal(missing.severity, 'error');
  assert.equal(missing.retryable, false);
});

test('P03 §9.3: 新建设施的 new: 引用都不同，且能对应回 slotKey', () => {
  const { plan } = planSettlementFacilities({ settlementId: 'C1', scaleClass: 'large', worldviewTags: ['中世纪'] });
  const refs = plan.facilities.map((facility) => facility.newLocationRef).filter(Boolean);
  assert.equal(new Set(refs).size, refs.length, '引用必须唯一');
  assert.ok(refs.every((ref) => ref.startsWith('new:facility_')), '本批只能声明有限 new: 引用');
  assert.equal(plan.facilities.every((facility) => Boolean(facility.newLocationRef) !== Boolean(facility.existingLocationId)), true);
});

test('P03 §9.3: 城区存在时设施落到城区，缺城区就留 null 不编造', () => {
  const withDistricts = planSettlementFacilities({
    settlementId: 'C1', scaleClass: 'small', worldviewTags: ['中世纪'], districtIds: ['D1', 'D2'],
  }).plan;
  assert.ok(withDistricts.facilities.every((facility) => facility.districtId === 'D1' || facility.districtId === 'D2'));

  const withoutDistricts = planSettlementFacilities({ settlementId: 'C1', scaleClass: 'small', worldviewTags: ['中世纪'] }).plan;
  assert.ok(withoutDistricts.facilities.every((facility) => facility.districtId === null));
});
