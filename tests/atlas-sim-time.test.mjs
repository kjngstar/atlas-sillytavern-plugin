/**
 * atlas-sim-time.test.mjs — T16 时间区间推导（§18.3 T16 / §16.7 / §9.2 / §12 数值核对例）。
 *
 * §18.3 要求本文件覆盖的断言：短聊 0、准备睡觉 0、明确半小时 1800、吃饭+聊天同区间不加倍、
 * 明确先后相加、未知不假装 0、到达覆盖旧预测。
 * 被测模块：src/atlas-sim-time.ts（deriveElapsedInterval / ACTIVITY_DEFAULTS / activityDefault）。
 *
 * 断言口径全部取自模块真实合同，不发明 API：
 * - `explicitElapsedS` 最高优先（§16.7「明确持续时间 → …」）；冲突时正文明确事实胜出。
 * - 同区间活动取 max（缺关系时保守同区间并标 estimated），`after_ref` 链相加。
 * - 未知（`quality:'unknown'`）与「明确 0」（`quality:'explicit'` 且三值为 0）是两件事；
 *   未知时三个数值字段只是占位，调用方必须读 `quality`（§2.1 禁止「未知当 0」）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveElapsedInterval, ACTIVITY_DEFAULTS, activityDefault } from '../src/atlas-sim-time.ts';

const CLOCK = { clockS: 0 };

/** §18.3 每个用例都要成立的不变量：0 ≤ minS ≤ nominalS ≤ maxS，且全部有限。 */
function assertIntervalInvariant(result, label) {
  for (const key of ['minS', 'nominalS', 'maxS']) {
    assert.ok(Number.isFinite(result[key]), `${label}：${key} 必须是有限数，实际 ${String(result[key])}`);
  }
  assert.ok(result.minS >= 0, `${label}：minS 不得为负，实际 ${result.minS}`);
  assert.ok(result.minS <= result.nominalS, `${label}：minS(${result.minS}) ≤ nominalS(${result.nominalS}) 不成立`);
  assert.ok(result.nominalS <= result.maxS, `${label}：nominalS(${result.nominalS}) ≤ maxS(${result.maxS}) 不成立`);
}

test('T16-01 短聊 0：完成的短对话是「明确 0」，不是未知', () => {
  const result = deriveElapsedInterval({ activities: [{ kind: 'dialogue', completed: true }] }, CLOCK);
  assert.deepEqual([result.minS, result.nominalS, result.maxS], [0, 0, 0], '短对话不推进时钟');
  assert.equal(result.quality, 'explicit', '明确 0 必须标 explicit（unknown 才是「不知道」）');
  assert.ok(result.basisRefs.includes('ACTIVITY_DEFAULT:dialogue'), JSON.stringify(result.basisRefs));
  assertIntervalInvariant(result, '短聊');
});

test('T16-02 准备睡觉 / 刚吃一口：未完成活动 0，且依据标明是未完成计划', () => {
  for (const [kind, label] of [['sleep', '准备睡觉'], ['meal', '刚吃一口']]) {
    const result = deriveElapsedInterval({ activities: [{ kind, completed: false }] }, CLOCK);
    assert.deepEqual([result.minS, result.nominalS, result.maxS], [0, 0, 0], `${label}不能让时钟前进`);
    assert.equal(result.quality, 'explicit', `${label}：未完成计划是明确的 0`);
    assert.ok(
      result.basisRefs.includes(`INCOMPLETE_ACTIVITY_ZERO:${kind}`),
      `${label}：依据必须标出未完成活动，实际 ${JSON.stringify(result.basisRefs)}`,
    );
    assert.ok(
      !result.basisRefs.some((ref) => ref.startsWith('ACTIVITY_DEFAULT:')),
      `${label}：未完成活动不得套用整次活动的默认时长，实际 ${JSON.stringify(result.basisRefs)}`,
    );
    assertIntervalInvariant(result, label);
  }
  // 默认区间本身仍按 §16.7 存在（睡觉整夜 4–10 小时），只是未完成时不用它。
  assert.deepEqual(activityDefault('sleep'), ACTIVITY_DEFAULTS.sleep);
  assert.deepEqual(activityDefault('meal'), { min_s: 900, nominal_s: 1800, max_s: 3600 });
});

test('T16-03 明确半小时 = 1800；explicitElapsedS 压过活动估计', () => {
  const halfHour = deriveElapsedInterval({ explicitElapsedS: 1800 }, CLOCK);
  assert.equal(halfHour.nominalS, 1800);
  assert.equal(halfHour.minS, 1800);
  assert.equal(halfHour.maxS, 1800);
  assert.equal(halfHour.quality, 'explicit');
  assert.ok(halfHour.basisRefs.includes('EXPLICIT_ELAPSED'));
  assertIntervalInvariant(halfHour, '明确半小时');

  // 同一批事实里既有「正文明确 5 分钟」又有「睡了一觉」的默认估计：明确事实胜出。
  const explicitBeatsEstimate = deriveElapsedInterval(
    { explicitElapsedS: 300, activities: [{ kind: 'sleep', completed: true }] },
    CLOCK,
  );
  assert.equal(explicitBeatsEstimate.nominalS, 300, '明确时间约束与动作估计冲突时采用正文明确事实');
  assert.equal(explicitBeatsEstimate.quality, 'explicit');
  assert.ok(explicitBeatsEstimate.basisRefs.includes('EXPLICIT_ELAPSED'));
  assert.ok(
    !explicitBeatsEstimate.basisRefs.some((ref) => ref.startsWith('ACTIVITY_DEFAULT:')),
    `不得再叠加活动默认估计，实际 ${JSON.stringify(explicitBeatsEstimate.basisRefs)}`,
  );
  assertIntervalInvariant(explicitBeatsEstimate, '明确压过估计');

  // 无明确时间时，整次完成的活动才回落默认区间（估计，不是 0）。
  const byDefault = deriveElapsedInterval({ activities: [{ kind: 'meal', completed: true }] }, CLOCK);
  assert.equal(byDefault.quality, 'estimated');
  assert.deepEqual(
    [byDefault.minS, byDefault.nominalS, byDefault.maxS],
    [ACTIVITY_DEFAULTS.meal.min_s, ACTIVITY_DEFAULTS.meal.nominal_s, ACTIVITY_DEFAULTS.meal.max_s],
  );
});

test('T16-04 吃饭 + 聊天同区间不加倍：取 max，不把「吃饭聊了半小时」累计两次', () => {
  const mealOnly = deriveElapsedInterval({ activities: [{ kind: 'meal', completed: true }] }, CLOCK);
  const dialogueOnly = deriveElapsedInterval({ activities: [{ kind: 'dialogue', completed: true }] }, CLOCK);

  // 形态一：缺关系时按同区间保守处理（§16.7），并标记 estimated / SAME_INTERVAL_INFERRED。
  const implicit = deriveElapsedInterval(
    { activities: [{ kind: 'meal', completed: true }, { kind: 'dialogue', completed: true }] },
    CLOCK,
  );
  assert.deepEqual(
    [implicit.minS, implicit.nominalS, implicit.maxS],
    [mealOnly.minS, mealOnly.nominalS, mealOnly.maxS],
    '同区间取 max：结果必须等于只算吃饭',
  );
  assert.ok(implicit.nominalS < mealOnly.nominalS + dialogueOnly.nominalS + 1, '不得相加');
  assert.equal(implicit.nominalS, 1800);
  assert.equal(implicit.quality, 'estimated');
  assert.ok(implicit.basisRefs.includes('SAME_INTERVAL_INFERRED'), JSON.stringify(implicit.basisRefs));
  assertIntervalInvariant(implicit, '隐式同区间');

  // 形态二：显式 same_interval_as 指向本批活动 key，结论必须一致。
  const explicitSame = deriveElapsedInterval(
    {
      activities: [
        { kind: 'meal', completed: true, ref: 'meal_1' },
        { kind: 'dialogue', completed: true, hint: { same_interval_as: 'meal_1' } },
      ],
    },
    CLOCK,
  );
  assert.deepEqual(
    [explicitSame.minS, explicitSame.nominalS, explicitSame.maxS],
    [mealOnly.minS, mealOnly.nominalS, mealOnly.maxS],
    'same_interval_as 与隐式同区间口径一致',
  );
  assert.equal(explicitSame.quality, 'estimated');
  assert.deepEqual(explicitSame.conflicts, []);
  assertIntervalInvariant(explicitSame, '显式同区间');
});

test('T16-05 明确先后相加：after_ref 链指向本批活动 key 时两段时长相加', () => {
  // 模块的真实口径：after_ref 只在本批活动内解析（显式 ref/id/key、a<index> 或唯一的 kind 名）。
  const byExplicitRef = deriveElapsedInterval(
    {
      activities: [
        { kind: 'meal', completed: true, ref: 'meal_1', hint: { elapsed_s: 1800 } },
        { kind: 'travel', completed: true, hint: { elapsed_s: 600, after_ref: 'meal_1' } },
      ],
    },
    CLOCK,
  );
  assert.equal(byExplicitRef.nominalS, 2400, '1800 + 600：明确先后必须相加');
  assert.ok(byExplicitRef.nominalS > 1800, '严格大于单独吃饭');
  assert.ok(byExplicitRef.nominalS > 600, '严格大于单独赶路');
  assert.equal(byExplicitRef.quality, 'explicit');
  assert.deepEqual(byExplicitRef.conflicts, []);
  assertIntervalInvariant(byExplicitRef, 'after_ref 相加');

  // 同一批活动的 a<index> 别名同样可解析（调用方不必自己造 key）。
  const byIndexAlias = deriveElapsedInterval(
    {
      activities: [
        { kind: 'meal', completed: true, hint: { elapsed_s: 1800 } },
        { kind: 'travel', completed: true, hint: { elapsed_s: 600, after_ref: 'a0' } },
      ],
    },
    CLOCK,
  );
  assert.equal(byIndexAlias.nominalS, 2400);
  assert.equal(byIndexAlias.quality, 'explicit');

  // 三段链：1800 + 600 + 300 全部相加。
  const threeLegs = deriveElapsedInterval(
    {
      activities: [
        { kind: 'meal', completed: true, ref: 'x1', hint: { elapsed_s: 1800 } },
        { kind: 'travel', completed: true, ref: 'x2', hint: { elapsed_s: 600, after_ref: 'x1' } },
        { kind: 'rest', completed: true, ref: 'x3', hint: { elapsed_s: 300, after_ref: 'x2' } },
      ],
    },
    CLOCK,
  );
  assert.equal(threeLegs.nominalS, 2700);

  // 指不到本批活动的 after_ref：不得静默相加，必须登记冲突并退回保守（同区间 max）。
  const unresolved = deriveElapsedInterval(
    {
      activities: [
        { kind: 'meal', completed: true, ref: 'meal_1', hint: { elapsed_s: 1800 } },
        { kind: 'travel', completed: true, hint: { elapsed_s: 600, after_ref: 'not_in_this_batch' } },
      ],
    },
    CLOCK,
  );
  assert.equal(unresolved.nominalS, 1800, '解析不到的先后关系不能当成已知先后去相加');
  assert.ok(
    unresolved.conflicts.includes('UNRESOLVED_ACTIVITY_REF:not_in_this_batch'),
    `必须登记未解析引用，实际 ${JSON.stringify(unresolved.conflicts)}`,
  );
  assert.notEqual(unresolved.quality, 'unknown', '两段本身都有明确时长，不是未知');
  assertIntervalInvariant(unresolved, '未解析 after_ref');
});

test('T16-06 未知不假装 0：quality=unknown 且带 TIME_UNRESOLVED 依据', () => {
  const unresolved = deriveElapsedInterval(
    { activities: [{ kind: 'other', completed: true, hint: { text: '过了一会儿' } }] },
    CLOCK,
  );
  assert.equal(unresolved.quality, 'unknown', '无事前依据的已完成活动是未知，不是 0');
  assert.ok(unresolved.basisRefs.includes('TIME_UNRESOLVED'), JSON.stringify(unresolved.basisRefs));
  assert.ok(
    !unresolved.basisRefs.includes('EXPLICIT_ELAPSED'),
    '未知不得声称是明确的经过时间',
  );
  assertIntervalInvariant(unresolved, '未知活动');

  // 完全没有时间事实同样是未知（不是「本轮 0 秒」）。
  const empty = deriveElapsedInterval({}, CLOCK);
  assert.equal(empty.quality, 'unknown');
  assert.ok(empty.basisRefs.includes('TIME_UNRESOLVED'));
  const explicitNull = deriveElapsedInterval({ explicitElapsedS: null }, CLOCK);
  assert.equal(explicitNull.quality, 'unknown');

  // 对照：真正的 0（短对话 / 明确 0）才是 explicit——调用方用 quality 区分两者。
  const realZero = deriveElapsedInterval({ explicitElapsedS: 0 }, CLOCK);
  assert.deepEqual([realZero.nominalS, realZero.quality], [0, 'explicit']);
  assert.ok(unresolved.quality !== realZero.quality, '未知与明确 0 必须可区分');

  // travel 没有路程依据时同样保持未知（由路程计算，不套活动先验）。
  const travelUnknown = deriveElapsedInterval({ activities: [{ kind: 'travel', completed: true }] }, CLOCK);
  assert.equal(travelUnknown.quality, 'unknown');
  assert.equal(activityDefault('travel'), null);
  assert.equal(activityDefault('other'), null);
});

test('T16-07 到达覆盖旧预测：明确/计算出的到达压过先前的区间估计', () => {
  // 同一段旅行既带「已完成到达」的 elapsed_s，又带旧的范围预测：明确到达胜出。
  const arrival = deriveElapsedInterval(
    { activities: [{ kind: 'travel', completed: true, hint: { elapsed_s: 7200, min_s: 3600, max_s: 9000 } }] },
    { clockS: 7200 },
  );
  assert.deepEqual([arrival.minS, arrival.nominalS, arrival.maxS], [7200, 7200, 7200], '旧预测 3600–9000 必须被覆盖');
  assert.equal(arrival.quality, 'explicit');
  assert.ok(arrival.basisRefs.includes('TRAVEL_COMPUTED'), JSON.stringify(arrival.basisRefs));
  assert.ok(!arrival.basisRefs.includes('HINT_RANGE'), '不得同时把旧区间当成依据');
  assert.ok(!arrival.basisRefs.includes('ACTIVITY_DEFAULT:travel'));
  assertIntervalInvariant(arrival, '到达覆盖预测');

  // 正文明确时刻变化（explicitElapsedS）压过计算出的行程耗时（§16.7 冲突时用明确事实）。
  const explicitFact = deriveElapsedInterval(
    { explicitElapsedS: 3000, activities: [{ kind: 'travel', completed: true, hint: { elapsed_s: 7200 } }] },
    CLOCK,
  );
  assert.equal(explicitFact.nominalS, 3000);
  assert.equal(explicitFact.quality, 'explicit');
  assert.ok(explicitFact.basisRefs.includes('EXPLICIT_ELAPSED'));
  assert.ok(!explicitFact.basisRefs.includes('TRAVEL_COMPUTED'));

  // 有依据的区间估计压过活动默认先验（不叠加默认值）。
  const hintOverDefault = deriveElapsedInterval(
    { activities: [{ kind: 'meal', completed: true, hint: { min_s: 600, max_s: 1200 } }] },
    CLOCK,
  );
  assert.deepEqual([hintOverDefault.minS, hintOverDefault.nominalS, hintOverDefault.maxS], [600, 900, 1200]);
  assert.equal(hintOverDefault.quality, 'estimated');
  assert.ok(hintOverDefault.basisRefs.includes('HINT_RANGE'));
  assert.ok(!hintOverDefault.basisRefs.includes('ACTIVITY_DEFAULT:meal'));
  assertIntervalInvariant(hintOverDefault, 'hint 覆盖默认');
});

test('T16-08 区间次序不变量在每类事实下都成立', () => {
  const cases = [
    ['短聊', { activities: [{ kind: 'dialogue', completed: true }] }],
    ['未完成睡觉', { activities: [{ kind: 'sleep', completed: false }] }],
    ['明确 0', { explicitElapsedS: 0 }],
    ['明确 1800', { explicitElapsedS: 1800 }],
    ['吃饭默认', { activities: [{ kind: 'meal', completed: true }] }],
    ['冲突', { activities: [{ kind: 'combat', completed: true }, { kind: 'rest', completed: true }] }],
    ['先后', {
      activities: [
        { kind: 'meal', completed: true, ref: 'm', hint: { elapsed_s: 1800 } },
        { kind: 'rest', completed: true, hint: { elapsed_s: 300, after_ref: 'm' } },
      ],
    }],
    ['未知', { activities: [{ kind: 'other', completed: true }] }],
    ['空事实', {}],
  ];
  for (const [label, facts] of cases) {
    const result = deriveElapsedInterval(facts, { clockS: 1234 });
    assertIntervalInvariant(result, label);
  }
});
