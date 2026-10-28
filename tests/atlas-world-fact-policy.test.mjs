/**
 * atlas-world-fact-policy.test.mjs — P01 事实冲突策略断言（计划 §7 冲突真值表逐行）。
 *
 * 覆盖：世界书压剧情、确认压估计、状态事件覆盖静态、同级矛盾阻塞、
 * 普通补全不得改作者锁、真实拆毁改状态但保留历史几何、输入顺序不影响结果、
 * 重复 fact id 判坏数据；decodeWorldFact 的 version / 枚举 / value 形状校验。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeWorldFact,
  resolveWorldFactConflict,
  currentFactOf,
  isFactFieldBlocked,
  factValueKey,
} from '../src/atlas-world-fact-policy.ts';

/** 合法事实夹具：默认是「世界书说某地存在」的确认基线。 */
function fact(overrides = {}) {
  return {
    version: 1,
    id: 'f-1',
    subjectId: 'loc-tavern',
    predicate: 'exists',
    layer: 'baseline',
    origin: 'lorebook',
    producer: 'program',
    sourceKey: 'lore:world#1',
    sourceHash: 'sha256:aaa',
    sourceSpan: { start: 10, end: 42 },
    quality: 'confirmed',
    effectiveTurnId: 'turn-1',
    effectiveClockS: null,
    supersedesFactId: null,
    value: true,
    ...overrides,
  };
}

function resolve(baselineFacts, stateEvents = [], currentTurnId = 'turn-9') {
  return resolveWorldFactConflict({ baselineFacts, stateEvents, currentTurnId });
}

/* ─────────────────────── decodeWorldFact ─────────────────────── */

test('decodeWorldFact：合法断言解码成功', () => {
  const result = decodeWorldFact(fact());
  assert.equal(result.ok, true);
  assert.equal(result.value.predicate, 'exists');
  assert.equal(result.value.sourceSpan.start, 10);
  assert.equal(result.value.value, true);
});

test('decodeWorldFact：未知 version、未知 predicate 一律拒绝', () => {
  const badVersion = decodeWorldFact(fact({ version: 2 }));
  assert.equal(badVersion.ok, false);
  assert.equal(badVersion.issues[0].code, 'WORLD_FACT_VERSION_UNSUPPORTED');

  const badPredicate = decodeWorldFact(fact({ predicate: 'color' }));
  assert.equal(badPredicate.ok, false);
  assert.ok(badPredicate.issues.some((issue) => issue.code === 'WORLD_FACT_ENUM_INVALID'));
});

test('decodeWorldFact：value 形状按 predicate 收窄，不接受任意对象', () => {
  const badExists = decodeWorldFact(fact({ value: 'yes' }));
  assert.equal(badExists.ok, false);
  assert.equal(badExists.issues[0].code, 'WORLD_FACT_VALUE_INVALID');

  const badSize = decodeWorldFact(fact({ predicate: 'size', value: { w: 0, h: 4, units: 'meters' } }));
  assert.equal(badSize.ok, false);
  assert.match(badSize.issues[0].message, /w 必须是正数/);

  const goodSize = decodeWorldFact(fact({ predicate: 'size', value: { w: 4, h: 3, units: 'meters' } }));
  assert.equal(goodSize.ok, true);

  const badOpening = decodeWorldFact(fact({ predicate: 'opening-state', value: 'ajar' }));
  assert.equal(badOpening.ok, false);

  const badMaterial = decodeWorldFact(fact({ predicate: 'material', value: 'steel' }));
  assert.equal(badMaterial.ok, false);

  // 任意对象不能借 size 混进去
  const smuggled = decodeWorldFact(fact({ predicate: 'size', value: { anything: 1 } }));
  assert.equal(smuggled.ok, false);
});

test('decodeWorldFact：sourceSpan 反向与非法整数被拒绝', () => {
  const reversed = decodeWorldFact(fact({ sourceSpan: { start: 50, end: 10 } }));
  assert.equal(reversed.ok, false);
  const fractional = decodeWorldFact(fact({ sourceSpan: { start: 0.5, end: 10 } }));
  assert.equal(fractional.ok, false);
});

/* ─────────────────── 真值表第 1 行：世界书压剧情 ─────────────────── */

test('真值表1：世界书静态优先于普通剧情静态，剧情断言记为被覆盖', () => {
  const result = resolve([
    fact({ id: 'f-lore', origin: 'lorebook', quality: 'confirmed', value: true }),
    fact({ id: 'f-story', origin: 'story', quality: 'confirmed', value: false }),
  ]);

  assert.equal(result.baseline.length, 1);
  assert.equal(result.baseline[0].id, 'f-lore');
  assert.ok(result.supersededFactIds.includes('f-story'));

  const conflict = result.conflicts.find((item) => item.code === 'OVERRIDDEN_BY_PRIORITY');
  assert.ok(conflict, '应留下覆盖痕迹');
  assert.equal(conflict.blocking, false, '有明确胜者时不应阻塞');
  assert.deepEqual(conflict.factIds, ['f-lore', 'f-story']);
  // 不触发正文重写：解析层不返回任何「需重写」信号，只有冲突记录
  assert.equal(result.mayWriteCurrentState, true);
});

/* ─────────────── 真值表第 2 行：明确资料纠正估计 ─────────────── */

test('真值表2：同层下 confirmed 高于 estimated', () => {
  const result = resolve([
    fact({ id: 'f-est', origin: 'story', quality: 'estimated', predicate: 'size', value: { w: 24, h: 24, units: 'meters' } }),
    fact({ id: 'f-conf', origin: 'story', quality: 'confirmed', predicate: 'size', value: { w: 6, h: 4, units: 'meters' } }),
  ]);

  assert.equal(result.baseline.length, 1);
  assert.equal(result.baseline[0].id, 'f-conf');
  assert.equal(result.baseline[0].value.w, 6);
});

test('真值表2 补充：inferred 整体垫底，不论 estimated/confirmed', () => {
  const result = resolve([
    fact({ id: 'f-inf', origin: 'inferred', quality: 'confirmed', value: false }),
    fact({ id: 'f-story', origin: 'story', quality: 'estimated', value: true }),
  ]);
  assert.equal(result.baseline[0].id, 'f-story');
});

/* ─────────── 真值表第 3 行：酒馆存在 + 后来被烧毁 ─────────── */

test('真值表3：状态事件改变当前存在状态，基线保留为历史几何依据', () => {
  const result = resolve(
    [fact({ id: 'f-exists', layer: 'baseline', origin: 'lorebook', quality: 'confirmed', value: true })],
    [fact({
      id: 'f-burned',
      layer: 'state-event',
      origin: 'story',
      quality: 'confirmed',
      predicate: 'exists',
      value: false,
      effectiveTurnId: 'turn-7',
      effectiveClockS: 7200,
      supersedesFactId: 'f-exists',
    })],
  );

  assert.equal(result.stateOverlay.length, 1);
  assert.equal(result.stateOverlay[0].id, 'f-burned');
  assert.equal(currentFactOf(result, 'loc-tavern', 'exists').value, false, '当前状态应为不存在');

  // 基线没有被删：它仍解释这张图为什么画在这里（历史几何）
  assert.equal(result.baseline.length, 1);
  assert.equal(result.baseline[0].id, 'f-exists');
  assert.ok(!result.supersededFactIds.includes('f-exists'), '基线不进入被替代集合');

  const trace = result.conflicts.find((item) => item.code === 'OVERRIDDEN_BY_PRIORITY');
  assert.ok(trace);
  assert.equal(trace.blocking, false);
});

/* ─────────────── 真值表第 4 行：门关 → 后来打开 ─────────────── */

test('真值表4：门状态取时钟最新的状态事件，旧事件记为被替代', () => {
  const result = resolve(
    [fact({ id: 'f-door-init', subjectId: 'door-1', predicate: 'opening-state', origin: 'lorebook', value: 'closed' })],
    [
      fact({ id: 'f-door-a', subjectId: 'door-1', predicate: 'opening-state', layer: 'state-event', origin: 'story', quality: 'confirmed', value: 'closed', effectiveTurnId: 'turn-3', effectiveClockS: 300 }),
      fact({ id: 'f-door-b', subjectId: 'door-1', predicate: 'opening-state', layer: 'state-event', origin: 'story', quality: 'confirmed', value: 'open', effectiveTurnId: 'turn-5', effectiveClockS: 900 }),
    ],
  );

  assert.equal(result.stateOverlay.length, 1);
  assert.equal(result.stateOverlay[0].id, 'f-door-b');
  assert.equal(currentFactOf(result, 'door-1', 'opening-state').value, 'open');
  assert.ok(result.supersededFactIds.includes('f-door-a'));
});

/* ─────────────── 真值表第 5 行：同级同源矛盾 ─────────────── */

test('真值表5：同级同级矛盾不选任何一条，标记阻塞且保留依据', () => {
  const result = resolve([
    fact({ id: 'f-a', origin: 'lorebook', quality: 'confirmed', value: true }),
    fact({ id: 'f-b', origin: 'lorebook', quality: 'confirmed', value: false }),
  ]);

  assert.equal(result.baseline.length, 0, '两条同级矛盾断言都不能被选中');
  const conflict = result.conflicts.find((item) => item.code === 'SAME_LEVEL_CONFLICT');
  assert.ok(conflict);
  assert.equal(conflict.blocking, true);
  assert.deepEqual(conflict.factIds, ['f-a', 'f-b']);
  assert.equal(isFactFieldBlocked(result, 'loc-tavern', 'exists'), true);
  assert.equal(currentFactOf(result, 'loc-tavern', 'exists'), null, '不可判定时不得假装有值');
});

test('真值表5 补充：结果不随输入数组顺序变化', () => {
  const a = fact({ id: 'f-a', origin: 'lorebook', value: true });
  const b = fact({ id: 'f-b', origin: 'lorebook', value: false });
  const forward = resolve([a, b]);
  const backward = resolve([b, a]);

  assert.deepEqual(forward.baseline, backward.baseline);
  assert.deepEqual(forward.supersededFactIds, backward.supersededFactIds);
  assert.deepEqual(
    forward.conflicts.map((item) => ({ code: item.code, ids: item.factIds, blocking: item.blocking })),
    backward.conflicts.map((item) => ({ code: item.code, ids: item.factIds, blocking: item.blocking })),
  );
});

test('真值表5 补充：优先级的胜负也不随输入顺序变化', () => {
  const lore = fact({ id: 'f-lore', origin: 'lorebook', value: true });
  const story = fact({ id: 'f-story', origin: 'story', value: false });
  assert.equal(resolve([lore, story]).baseline[0].id, 'f-lore');
  assert.equal(resolve([story, lore]).baseline[0].id, 'f-lore');
});

/* ───────────── 真值表第 6 行：普通补全不得改作者锁 ───────────── */

test('真值表6：普通推测试图覆盖已确认断言被拒绝，且不阻塞其他字段', () => {
  const result = resolve(
    [
      fact({ id: 'f-locked', subjectId: 'furnace-1', predicate: 'material', origin: 'lorebook', quality: 'confirmed', producer: 'program', value: 'solid' }),
      fact({ id: 'f-other', subjectId: 'loc-tavern', predicate: 'exists', origin: 'lorebook', quality: 'confirmed', value: true }),
    ],
    [fact({
      id: 'f-inferred',
      subjectId: 'furnace-1',
      predicate: 'material',
      layer: 'state-event',
      origin: 'inferred',
      producer: 'model',
      quality: 'estimated',
      value: 'wood',
      effectiveTurnId: 'turn-8',
      effectiveClockS: 5000,
    })],
  );

  const refused = result.conflicts.find((item) => item.code === 'LOCKED_OVERRIDE_REFUSED');
  assert.ok(refused, '应拒绝覆盖作者锁');
  assert.equal(refused.blocking, false, '拒绝覆盖不等于整个世界不可写');
  assert.equal(currentFactOf(result, 'furnace-1', 'material').value, 'solid', '确认值保持不变');
  assert.ok(result.supersededFactIds.includes('f-inferred'));
  // 其他字段照常可写
  assert.equal(currentFactOf(result, 'loc-tavern', 'exists').value, true);
  assert.equal(result.mayWriteCurrentState, true);
});

/* ───────── 真值表第 7 行：真实拆毁影响被锁空间 ───────── */

test('真值表7：真实剧情事件可以改被锁对象的存在状态，历史几何不复活', () => {
  const result = resolve(
    [fact({ id: 'f-house', subjectId: 'house-1', predicate: 'exists', origin: 'lorebook', quality: 'confirmed', producer: 'program', value: true })],
    [fact({
      id: 'f-collapse',
      subjectId: 'house-1',
      predicate: 'exists',
      layer: 'state-event',
      origin: 'story',
      quality: 'confirmed',
      producer: 'program',
      value: false,
      effectiveTurnId: 'turn-6',
      effectiveClockS: 4000,
    })],
  );

  assert.equal(currentFactOf(result, 'house-1', 'exists').value, false, '真实事件应生效');
  assert.equal(result.baseline[0].id, 'f-house', '历史基线保留（几何依据）');
  assert.ok(!result.conflicts.some((item) => item.code === 'LOCKED_OVERRIDE_REFUSED'));
});

/* ─────────────────── 输入自检与边界 ─────────────────── */

test('重复 fact id 且内容不一致判为坏数据，整批不可写', () => {
  const result = resolve([
    fact({ id: 'f-dup', value: true }),
    fact({ id: 'f-dup', value: false }),
  ]);
  assert.equal(result.mayWriteCurrentState, false);
  assert.ok(result.conflicts.some((item) => item.code === 'DUPLICATE_FACT_ID'));
  assert.ok(result.blockedReasons.includes('duplicate-fact-id'));
});

test('层不匹配：baselineFacts 里混入 state-event 的断言被拒绝当基线', () => {
  const result = resolve([fact({ id: 'f-wrong-layer', layer: 'state-event' })]);
  assert.equal(result.baseline.length, 0);
  assert.ok(result.conflicts.some((item) => item.message.includes('layer=state-event')));
  assert.ok(result.blockedReasons.includes('layer-mismatch'));
});

test('完全相同的断言重复两次：不报冲突，只保留一条', () => {
  const result = resolve([fact({ id: 'f-x' }), fact({ id: 'f-y' })]);
  assert.equal(result.baseline.length, 1);
  assert.equal(result.baseline[0].id, 'f-x', '稳定取字典序最小');
  assert.ok(result.supersededFactIds.includes('f-y'));
  assert.equal(result.conflicts.length, 0);
});

test('状态事件缺时钟且值不同：拒绝按输入顺序取最后一条', () => {
  const result = resolve(
    [fact({ id: 'f-base', subjectId: 'door-2', predicate: 'opening-state', origin: 'lorebook', value: 'closed' })],
    [
      fact({ id: 'f-e1', subjectId: 'door-2', predicate: 'opening-state', layer: 'state-event', origin: 'story', quality: 'confirmed', value: 'open', effectiveTurnId: 'turn-4', effectiveClockS: null }),
      fact({ id: 'f-e2', subjectId: 'door-2', predicate: 'opening-state', layer: 'state-event', origin: 'story', quality: 'confirmed', value: 'closed', effectiveTurnId: 'turn-5', effectiveClockS: null }),
    ],
  );

  assert.equal(result.stateOverlay.length, 0);
  const tie = result.conflicts.find((item) => item.code === 'STATE_TIE');
  assert.ok(tie);
  assert.equal(tie.blocking, true);
  assert.equal(isFactFieldBlocked(result, 'door-2', 'opening-state'), true);
});

test('空输入返回空解析，不抛错也不编造断言', () => {
  const result = resolve([], []);
  assert.deepEqual(result.baseline, []);
  assert.deepEqual(result.stateOverlay, []);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.mayWriteCurrentState, true);
  assert.equal(currentFactOf(result, 'nope', 'exists'), null);
});

test('factValueKey：键顺序不影响值指纹', () => {
  assert.equal(factValueKey({ w: 1, h: 2 }), factValueKey({ h: 2, w: 1 }));
  assert.notEqual(factValueKey({ w: 1, h: 2 }), factValueKey({ w: 1, h: 3 }));
  assert.equal(factValueKey(['a', 'b']), factValueKey(['a', 'b']));
});
