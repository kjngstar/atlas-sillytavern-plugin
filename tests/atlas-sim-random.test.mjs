/**
 * atlas-sim-random.test.mjs — T20 可复现抽样与回放（§18.3 T20 / §9.5 / §16.7 / §6.3）。
 *
 * §18.3 要求本文件覆盖的断言：同 key 复现；无关事件不扰动；新正文变体种子变化；
 * 回放复用模型决策而非仅重置 seed。
 * 被测模块：src/atlas-sim-random.ts
 * （deriveSeed / stableSubSeed / drawForEvent / recordDraw / ATTENTION_PROBABILITIES）。
 *
 * 模块真实合同（见该文件头注释）：
 * - 种子绑定 `chat_uid + 分支基点 + 正文变体 + 输入哈希 + 规则版本`；
 * - 每次抽取只由 `(seed, eventKey, rule.key)` 决定，**没有全局顺序随机序列**，
 *   所以多处理一个无关 NPC 不会改变另一个事件的结果；
 * - 抽样结果经 `recordDraw` 落入 `decisions_json.random_draws`
 *   （`{key,value,distribution,rule_version}`）——只重置 seed 不能让重新请求的语言模型
 *   给出同样的输出，因此要保存**决策与抽样值**本身。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTENTION_PROBABILITIES,
  ATLAS_SIM_RULESET_VERSION,
  deriveSeed,
  drawForEvent,
  recordDraw,
  stableSubSeed,
  verifyRecordedDraws,
} from '../src/atlas-sim-random.ts';

const SEED_PARTS = {
  chatUid: 'chat-A',
  branchId: 'main-A',
  forkTurnId: null,
  variantKey: 'variant-1',
  inputHash: 'hash_turn_7',
  rulesetVersion: ATLAS_SIM_RULESET_VERSION,
};

/** 一轮里真实会出现的抽样点（事件注意 / 暗杀结果 / 风声相信 / 统一随机）。 */
const TURN_DRAWS = [
  { eventKey: 'event:E1:king-assassination', rule: { key: 'attention', distribution: 'bernoulli', p: 'high' } },
  { eventKey: 'event:E2:rumor-reach-B', rule: { key: 'attention', distribution: 'bernoulli', p: 'low' } },
  { eventKey: 'event:E3:guard-patrol', rule: { key: 'attention', distribution: 'bernoulli', p: 'normal' } },
  { eventKey: 'action:C3:assassinate', rule: { key: 'success', distribution: 'bernoulli', p: 0.5 } },
  { eventKey: 'action:C1:chat', rule: { key: 'attention', distribution: 'bernoulli', p: 0.5 } },
  { eventKey: 'rumor:F1:believe', rule: { key: 'believe', distribution: 'bernoulli', p: 0.8 } },
  { eventKey: 'event:E4:weather', rule: { key: 'severity', distribution: 'uniform' } },
  { eventKey: 'action:C4:escape', rule: { key: 'timing', distribution: 'uniform' } },
];

/** 用种子跑一轮抽样并记录（等价于写入 decisions_json.random_draws）。 */
function runTurn(seed) {
  return TURN_DRAWS.map(({ eventKey, rule }) => recordDraw(drawForEvent(seed, eventKey, rule)));
}

test('T20-01 同 key 复现：同一 (seed,eventKey,rule) 永远得到同一个值', () => {
  const seed = deriveSeed(SEED_PARTS);
  const first = drawForEvent(seed, 'action:C3:assassinate', { key: 'success', distribution: 'bernoulli', p: 0.5 });
  const second = drawForEvent(seed, 'action:C3:assassinate', { key: 'success', distribution: 'bernoulli', p: 0.5 });
  assert.deepEqual(second, first, '同 key 必须复现');
  assert.equal(first.key, 'action:C3:assassinate#success');
  assert.equal(first.ruleVersion, ATLAS_SIM_RULESET_VERSION);
  // 重新推导同一个种子（同一聊天/分支/变体/输入/规则版本）也必须一致。
  assert.equal(deriveSeed({ ...SEED_PARTS }), seed);
  // 子种子只由输入串决定。
  assert.equal(stableSubSeed(`${seed}\u0001action:C3:assassinate\u0001success`), stableSubSeed(`${seed}\u0001action:C3:assassinate\u0001success`));
});

test('T20-02 无关事件不扰动：没有全局顺序随机序列', () => {
  const seed = deriveSeed(SEED_PARTS);
  const rule = { key: 'success', distribution: 'bernoulli', p: 0.5 };
  const before = drawForEvent(seed, 'action:C3:assassinate', rule);
  // 中间处理另一个无关 NPC 的抽取（如果实现是全局序列，这会改变后续取值）。
  drawForEvent(seed, 'action:C1:chat', { key: 'attention', distribution: 'bernoulli', p: 0.5 });
  drawForEvent(seed, 'event:E9:unrelated-npc', { key: 'attention', distribution: 'uniform' });
  const after = drawForEvent(seed, 'action:C3:assassinate', rule);
  assert.deepEqual(after, before, '多处理一个无关 NPC 不得改变刺杀结果');
  // 换一个抽取顺序同样不改变结果。
  const reversed = [...TURN_DRAWS].reverse().map(({ eventKey, rule: r }) => recordDraw(drawForEvent(seed, eventKey, r)));
  const forward = runTurn(seed);
  assert.deepEqual(
    Object.fromEntries(reversed.map((d) => [d.key, d.value])),
    Object.fromEntries(forward.map((d) => [d.key, d.value])),
    '抽取值只由 key 决定，与处理顺序无关',
  );
});

test('T20-03 新正文变体 → 新种子；同 key 的取值允许随之改变', () => {
  const seedV1 = deriveSeed(SEED_PARTS);
  const seedV2 = deriveSeed({ ...SEED_PARTS, variantKey: 'variant-2' });
  assert.notEqual(seedV2, seedV1, '正文变体必须参与种子派生');
  // 规则版本变化同样换种子（新规则本来就允许不同结果）。
  assert.notEqual(deriveSeed({ ...SEED_PARTS, rulesetVersion: 'atlas-sim-2' }), seedV1);
  // 输入哈希变化（不同基态）同样换种子。
  assert.notEqual(deriveSeed({ ...SEED_PARTS, inputHash: 'hash_turn_8' }), seedV1);

  const key = 'action:C3:assassinate';
  assert.notEqual(
    stableSubSeed(`${seedV2}\u0001${key}\u0001success`),
    stableSubSeed(`${seedV1}\u0001${key}\u0001success`),
    '变体不同 → 同一 key 的子种子必须不同',
  );

  const drawsV1 = runTurn(seedV1);
  const drawsV2 = runTurn(seedV2);
  assert.deepEqual(drawsV1.map((d) => d.key), drawsV2.map((d) => d.key), 'key 形状不变（同一个世界事件）');
  const changed = drawsV1.filter((d, i) => d.value !== drawsV2[i].value).length;
  assert.ok(changed >= 1, `新正文变体至少要在一个抽样点上取到不同值，实际 ${changed} 个相同`);
});

test('T20-04 bernoulli 概率边界：p=0 恒 0/false，p=1 恒 1/true', () => {
  const seed = deriveSeed(SEED_PARTS);
  const keys = ['k1', 'k2', 'k3', 'k4', 'event:E1', 'event:E2', 'action:C1', 'action:C2'];
  for (const eventKey of keys) {
    assert.equal(drawForEvent(seed, eventKey, { key: 'x', distribution: 'bernoulli', p: 0 }).value, 0);
    assert.equal(drawForEvent(seed, eventKey, { key: 'x', distribution: 'bernoulli', p: 1 }).value, 1);
  }
  // §16.7 默认注意概率可调整；命名档位必须等价于对应数值阈值。
  assert.deepEqual({ ...ATTENTION_PROBABILITIES }, { low: 0.2, normal: 0.5, high: 0.8 });
  for (const eventKey of keys) {
    assert.equal(
      drawForEvent(seed, eventKey, { key: 'x', distribution: 'bernoulli', p: 'low' }).value,
      drawForEvent(seed, eventKey, { key: 'x', distribution: 'bernoulli', p: ATTENTION_PROBABILITIES.low }).value,
    );
    assert.ok([0, 1].includes(drawForEvent(seed, eventKey, { key: 'x', distribution: 'bernoulli', p: 'normal' }).value));
  }
  // uniform 保留连续值，供需要区间抽样的规则使用。
  const uniform = drawForEvent(seed, 'k1', { key: 'u', distribution: 'uniform' });
  assert.equal(uniform.distribution, 'uniform');
  assert.ok(uniform.value >= 0 && uniform.value < 1, `uniform 值应在 [0,1)，实际 ${uniform.value}`);
});

test('T20-05 回放复用模型决策：同 seed + 同 key 必须得到逐项相同的已记录抽样', () => {
  const seed = deriveSeed(SEED_PARTS);
  const recorded = runTurn(seed); // 第一轮：抽 + 记录（写入 decisions_json.random_draws）
  const replayed = runTurn(deriveSeed({ ...SEED_PARTS })); // 回放：同基态、同正文、同规则版本

  assert.deepEqual(replayed, recorded, '回放必须复用同样的抽样值，而不是重新抽一个');
  assert.ok(recorded.length === TURN_DRAWS.length);
  for (const [i, entry] of recorded.entries()) {
    assert.deepEqual(Object.keys(entry).sort(), ['distribution', 'key', 'rule_version', 'value'], '记录形状固定（§6.3）');
    assert.equal(entry.rule_version, ATLAS_SIM_RULESET_VERSION, '规则版本必须随记录保存');
    assert.equal(entry.distribution, TURN_DRAWS[i].rule.distribution);
    assert.ok(Number.isFinite(entry.value));
    if (entry.distribution === 'bernoulli') assert.ok([0, 1].includes(entry.value), 'bernoulli 记录只能是 0/1');
  }
  // 记录值本身就足以复原这一轮判定（不需要重跑模型）。
  const byKey = new Map(recorded.map((d) => [d.key, d.value]));
  for (const { eventKey, rule } of TURN_DRAWS) {
    assert.equal(byKey.get(`${eventKey}#${rule.key}`), drawForEvent(seed, eventKey, rule).value);
  }
});

test('T20-06 变体不符必须由调用方发现：已记录抽样本身不携带种子', () => {
  const seedV1 = deriveSeed(SEED_PARTS);
  const seedV2 = deriveSeed({ ...SEED_PARTS, variantKey: 'variant-2' });
  const recorded = runTurn(seedV1);
  const different = runTurn(seedV2);

  // 用不同变体的种子「回放」会得到不同抽样 → 不得静默复用旧结果（§9.5）。
  assert.notEqual(seedV2, seedV1);
  const changed = recorded.filter((d, i) => d.value !== different[i].value).length;
  assert.ok(changed >= 1, '不同变体种子的回放必须能被看出不同');

  // 但已记录条目只有 key/value/distribution/rule_version，没有 seed/变体字段：
  // 调用方必须自己把 deriveSeed(...) 与 turns.rng_seed 对齐后再决定是否复用（本文件的
  // T20-07 记录了这一层缺少模块级入口）。
  assert.deepEqual(Object.keys(recorded[0]).sort(), ['distribution', 'key', 'rule_version', 'value']);
  assert.equal(Object.prototype.hasOwnProperty.call(recorded[0], 'seed'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(recorded[0], 'variantKey'), false);
});

test('T20-07 回放复用记录值：同种子逐条复核通过，换变体种子或坏 key 必须被判为不符', () => {
  // §6.3 的记录形状固定为 {key,value,distribution,rule_version}——不扩展协议。
  // 复现所需的来源就藏在 key（"eventKey#ruleKey"）里，种子由调用方从 turns.rng_seed 取出。
  const seed = deriveSeed(SEED_PARTS);
  const recorded = TURN_DRAWS.map((spec) => recordDraw(drawForEvent(seed, spec.eventKey, spec.rule)));
  // 当时生效的规则表，按完整抽样 key 索引（同一 ruleKey 在不同事件上概率不同）。
  const rules = Object.fromEntries(
    TURN_DRAWS.map((spec) => [`${spec.eventKey}#${spec.rule.key}`, { distribution: spec.rule.distribution, p: spec.rule.p }]),
  );

  assert.equal(recorded.length, TURN_DRAWS.length);
  for (const draw of recorded) {
    assert.deepEqual(Object.keys(draw).sort(), ['distribution', 'key', 'rule_version', 'value'], '记录形状必须与 §6.3 一致');
  }

  // 同一批 key 重算 → 逐条相等（这才是「复用模型决策」，不是把 seed 重置了事）。
  const replay = verifyRecordedDraws(seed, recorded, rules);
  assert.equal(replay.ok, true, `同种子回放必须逐条一致：${JSON.stringify(replay.mismatches)}`);
  assert.deepEqual(replay.mismatches, []);

  // 正文换变体 → 种子不同 → 模块自己必须报不符，调用方不得照用旧记录。
  const otherSeed = deriveSeed({ ...SEED_PARTS, variantKey: 'variant-2' });
  assert.notEqual(otherSeed, seed, '换变体必须换种子');
  const mismatched = verifyRecordedDraws(otherSeed, recorded, rules);
  assert.equal(mismatched.ok, false, '换了种子却仍说一致，等于悄悄沿用旧世界的抽样');
  assert.ok(mismatched.mismatches.length > 0);
  for (const item of mismatched.mismatches) {
    assert.equal(item.reason, 'SEED_OR_RULE_CHANGED');
    assert.equal(item.recorded, recorded.find((r) => r.key === item.key).value);
    assert.notEqual(item.recomputed, item.recorded);
  }

  // 规则版本变化同样必须被发现（同种子也不放过）。
  const ruleChanged = verifyRecordedDraws(seed, [
    { key: 'event:E1:king-assassination#attention', value: recorded[0].value === 1 ? 0 : 1, distribution: 'bernoulli', rule_version: '999' },
  ], rules);
  assert.equal(ruleChanged.ok, false, '值对不上就必须报不符');

  // key 坏掉（没有 # 分隔）必须明确报缺，而不是当作「一致」放过。
  const noKeys = verifyRecordedDraws(seed, [{ key: 'nohash', value: 0.5, distribution: 'uniform', rule_version: '1' }]);
  assert.equal(noKeys.ok, false);
  assert.equal(noKeys.mismatches[0].reason, 'RECORD_MISSING_KEYS');

  // 没给概率表时不能拿默认 0.5 冒充：bernoulli 必须明确报「无概率依据」。
  const noRules = verifyRecordedDraws(seed, [recorded[0]]);
  assert.equal(noRules.ok, false, '缺概率依据时不得声称一致');
  assert.equal(noRules.mismatches[0].reason, 'RULE_PROBABILITY_UNKNOWN');
});

test(
  'T20-08 同种子、同规则的 p≠0.5 回放必须判为一致；缺概率依据时必须明说而不是按 0.5 冒充',
  () => {
    // 同种子 + 同规则（含 p≠0.5）的合法回放必须判为一致：当时生效的规则表由调用方传入。
    const seed = deriveSeed(SEED_PARTS);
    let counterexample = null;
    for (let i = 0; i < 200 && counterexample === null; i += 1) {
      const eventKey = `event:probe:${i}`;
      const low = drawForEvent(seed, eventKey, { key: 'attention', distribution: 'bernoulli', p: ATTENTION_PROBABILITIES.low });
      const normal = drawForEvent(seed, eventKey, { key: 'attention', distribution: 'bernoulli', p: ATTENTION_PROBABILITIES.normal });
      if (low.value !== normal.value) counterexample = { eventKey, value: low.value };
    }
    assert.ok(counterexample, '应有 p=0.2 与 p=0.5 取值不同的抽样点可作反例');
    const recorded = [
      recordDraw(drawForEvent(seed, counterexample.eventKey, { key: 'attention', distribution: 'bernoulli', p: ATTENTION_PROBABILITIES.low })),
    ];
    // 当时生效的规则表：p=low(0.2)，按完整抽样 key 索引。
    const rules = { [`${counterexample.eventKey}#attention`]: { distribution: 'bernoulli', p: ATTENTION_PROBABILITIES.low } };
    const verified = verifyRecordedDraws(seed, recorded, rules);
    assert.equal(verified.ok, true, `同种子同规则的记录必须判为一致，实际 ${JSON.stringify(verified.mismatches)}`);
    assert.deepEqual(verified.mismatches, []);
  },
);
