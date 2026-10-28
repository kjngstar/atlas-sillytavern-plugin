/**
 * atlas-construction-budget.test.mjs — P02 共同操作预算断言。
 *
 * 覆盖：总额只有一个来源（operationsPerResponse），地点/路线共用而非各 64；
 * 分类计数（新增/更新/estimate/state-patch 都计入）；超限报出实际数字；
 * 部分成功只收依赖完整的子集、父未接收则子延后；noop 不占额度；顺序无关的依赖重试。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  constructionBudget,
  classifyOperation,
  budgetUsage,
  checkConstructionBudget,
  selectWithinBudget,
  isNewRef,
  describeBudgetUsage,
  OPERATION_CLASSES,
} from '../src/atlas-construction-budget.ts';
import { ATLAS_RUNTIME_LIMITS } from '../src/atlas-runtime-limits.ts';

const KNOWN = new Set(['L1', 'L2', 'L3', 'R1']);

function budget(maxNewLocations = 32, maxNewRoutes = 32) {
  return constructionBudget({ maxNewLocations, maxNewRoutes });
}

function loc(ref, parentRef) {
  const data = {};
  if (parentRef) data.parent_ref = parentRef;
  return { op: 'location.upsert', ref, data };
}

function route(ref, from, to) {
  return { op: 'route.propose', ref, data: { from_ref: from, to_ref: to } };
}

/* ─────────────────────── 总额来源 ─────────────────────── */

test('总额只有一个来源：operationsPerResponse，调用方不能把它撑大', () => {
  const built = budget();
  assert.equal(built.totalOperations, ATLAS_RUNTIME_LIMITS.operationsPerResponse);
  assert.equal(built.totalOperations, 64);

  // 传更大的值也没用——类型配额被夹在总额内
  const greedy = constructionBudget({ maxNewLocations: 200, maxNewRoutes: 200 });
  assert.equal(greedy.maxNewLocations, 64);
  assert.equal(greedy.maxNewRoutes, 64);
});

test('显式替换总额也被夹回协议上限之外的合法整数', () => {
  const custom = constructionBudget({ maxNewLocations: 10, maxNewRoutes: 10, totalOperations: 0 });
  assert.equal(custom.totalOperations, ATLAS_RUNTIME_LIMITS.operationsPerResponse, '0 不是合法总额，回退协议值');
  const negative = constructionBudget({ maxNewLocations: -5, maxNewRoutes: 10 });
  assert.equal(negative.maxNewLocations, 0);
});

/* ─────────────────────── 分类 ─────────────────────── */

test('分类：新地点/更新/新路线/尺度/状态补丁/其他/noop', () => {
  assert.equal(classifyOperation(loc('new:A'), KNOWN), 'new-location');
  assert.equal(classifyOperation(loc('A'), KNOWN), 'new-location', '不在目录的 ID 也算新');
  assert.equal(classifyOperation(loc('L1'), KNOWN), 'location-update');
  assert.equal(classifyOperation(route('R2', 'L1', 'L2'), KNOWN), 'new-route');
  assert.equal(classifyOperation(route('R1', 'L1', 'L2'), KNOWN), 'route-update');
  assert.equal(classifyOperation({ op: 'map.estimate', ref: 'M1', data: { width_m: 100 } }, KNOWN), 'estimate');
  assert.equal(classifyOperation({ op: 'space.state.patch', ref: 'M1', data: { updates: [] } }, KNOWN), 'state-patch');
  assert.equal(classifyOperation({ op: 'noop' }, KNOWN), 'noop');
  assert.equal(classifyOperation({ op: 'something.else' }, KNOWN), 'other');
});

test('isNewRef：空串不算新建，new: 前缀与未登记 ID 算', () => {
  assert.equal(isNewRef('', KNOWN), false);
  assert.equal(isNewRef(undefined, KNOWN), false);
  assert.equal(isNewRef('new:x', KNOWN), true);
  assert.equal(isNewRef('L9', KNOWN), true);
  assert.equal(isNewRef('L1', KNOWN), false);
});

/* ─────────────────────── 验收数字 ─────────────────────── */

test('20 地点 + 20 路线 + 5 更新 = 45 条，在 64 条共同预算内', () => {
  const ops = [];
  for (let i = 0; i < 20; i += 1) ops.push(loc(`new:L${i}`, 'L1'));
  for (let i = 0; i < 20; i += 1) ops.push(route(`new:R${i}`, 'L1', 'L2'));
  for (let i = 0; i < 5; i += 1) ops.push(loc(['L1', 'L2', 'L3'][i % 3], undefined));

  const verdict = checkConstructionBudget(ops, { budget: budget(32, 32), knownIds: KNOWN });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.usage.total, 45);
  assert.equal(verdict.usage.newLocations, 20);
  assert.equal(verdict.usage.newRoutes, 20);
  assert.equal(verdict.usage.byClass['location-update'], 5);
});

test('40 地点 + 30 路线 = 70 条，明确超额并报出全部三个数字', () => {
  const ops = [];
  for (let i = 0; i < 40; i += 1) ops.push(loc(`new:A${i}`, 'L1'));
  for (let i = 0; i < 30; i += 1) ops.push(route(`new:B${i}`, 'L1', 'L2'));

  const verdict = checkConstructionBudget(ops, { budget: budget(64, 64), knownIds: KNOWN });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.usage.total, 70);

  const codes = verdict.issues.map((issue) => issue.code);
  assert.ok(codes.includes('WORLD_CONSTRUCTION_BUDGET_EXCEEDED'));
  const exceeded = verdict.issues.find((issue) => issue.code === 'WORLD_CONSTRUCTION_BUDGET_EXCEEDED');
  assert.match(exceeded.message, /70/);
  assert.match(exceeded.message, /64/);
  // 消息必须点明「不是各自独立配额」
  assert.match(exceeded.message, /共用同一个总额/);
});

test('地点与路线各 64 条时总额 128，不能因为「各 64」就放行', () => {
  const ops = [];
  for (let i = 0; i < 64; i += 1) ops.push(loc(`new:A${i}`, 'L1'));
  for (let i = 0; i < 64; i += 1) ops.push(route(`new:B${i}`, 'L1', 'L2'));

  const verdict = checkConstructionBudget(ops, { budget: budget(64, 64), knownIds: KNOWN });
  assert.equal(verdict.usage.total, 128);
  assert.equal(verdict.ok, false);
});

test('类型配额单独超出也报错（总额没超也要拦）', () => {
  const ops = [];
  for (let i = 0; i < 12; i += 1) ops.push(loc(`new:A${i}`, 'L1'));
  const verdict = checkConstructionBudget(ops, { budget: budget(5, 32), knownIds: KNOWN });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.issues.some((issue) => issue.code === 'WORLD_CONSTRUCTION_LOCATION_QUOTA'));
  assert.equal(verdict.usage.total, 12, '总额没超，只有类型配额超');
});

test('noop 不占额度，但会被计数到 byClass', () => {
  const ops = [{ op: 'noop' }, { op: 'noop' }, loc('new:A', 'L1')];
  const usage = budgetUsage(ops, KNOWN);
  assert.equal(usage.total, 1);
  assert.equal(usage.byClass.noop, 2);
});

test('estimate 与 state-patch 也计入共同总额，没有隐藏通道', () => {
  const ops = [
    { op: 'map.estimate', ref: 'M1', data: { width_m: 10 } },
    { op: 'space.state.patch', ref: 'M1', data: { updates: [] } },
    loc('L1', undefined),
  ];
  const usage = budgetUsage(ops, KNOWN);
  assert.equal(usage.total, 3);
  assert.equal(usage.byClass.estimate, 1);
  assert.equal(usage.byClass['state-patch'], 1);
});

/* ─────────────────────── 部分成功 ─────────────────────── */

test('部分成功：20+20+5 全部接收，无延后', () => {
  const ops = [];
  for (let i = 0; i < 20; i += 1) ops.push(loc(`new:L${i}`, 'L1'));
  for (let i = 0; i < 20; i += 1) ops.push(route(`new:R${i}`, 'L1', 'L2'));
  for (let i = 0; i < 5; i += 1) ops.push(loc('L2', undefined));

  const selection = selectWithinBudget(ops, { budget: budget(32, 32), knownIds: KNOWN });
  assert.equal(selection.accepted.length, 45);
  assert.equal(selection.deferred.length, 0);
});

test('部分成功：超配额时收满为止，余下进 deferred 而不是丢弃', () => {
  const ops = [];
  for (let i = 0; i < 10; i += 1) ops.push(loc(`new:A${i}`, 'L1'));

  const selection = selectWithinBudget(ops, { budget: budget(4, 32), knownIds: KNOWN });
  assert.equal(selection.accepted.length, 4);
  assert.equal(selection.deferred.length, 6);
  assert.equal(selection.usage.newLocations, 4);
  assert.ok(selection.issues.every((issue) => issue.code === 'WORLD_CONSTRUCTION_BUDGET_DEFERRED'));
  // deferred 不是空话：能说出每一条的位置
  assert.ok(selection.issues.every((issue) => /^\$\.operations\[\d+\]$/.test(issue.path)));
});

test('部分成功：父未被接收时，子不得进入 accepted', () => {
  const ops = [loc('new:CHILD', 'new:PARENT')];
  const selection = selectWithinBudget(ops, { budget: budget(32, 32), knownIds: KNOWN });

  assert.equal(selection.accepted.length, 0, '父不存在就不能收子');
  assert.equal(selection.deferred.length, 1);
  assert.ok(selection.issues.some((issue) => issue.code === 'WORLD_CONSTRUCTION_DEPENDENCY_DEFERRED'));
});

test('部分成功：子写在父前面也能收（依赖重试，与顺序无关）', () => {
  const ops = [loc('new:CHILD', 'new:PARENT'), loc('new:PARENT', 'L1')];
  const selection = selectWithinBudget(ops, { budget: budget(32, 32), knownIds: KNOWN });

  assert.equal(selection.accepted.length, 2);
  assert.equal(selection.deferred.length, 0);
  // 父先被收，保证下游拿到可用的顺序
  assert.equal(selection.accepted[0].ref, 'new:PARENT');
  assert.equal(selection.accepted[1].ref, 'new:CHILD');
});

test('部分成功：三层依赖链完整才收', () => {
  const ops = [
    loc('new:GRANDCHILD', 'new:CHILD'),
    loc('new:CHILD', 'new:PARENT'),
    loc('new:PARENT', 'L1'),
  ];
  const selection = selectWithinBudget(ops, { budget: budget(32, 32), knownIds: KNOWN });
  assert.equal(selection.accepted.length, 3);
  assert.deepEqual(selection.accepted.map((op) => op.ref), ['new:PARENT', 'new:CHILD', 'new:GRANDCHILD']);
});

test('部分成功：环路依赖的两条都不收，不会死循环', () => {
  const ops = [loc('new:A', 'new:B'), loc('new:B', 'new:A')];
  const selection = selectWithinBudget(ops, { budget: budget(32, 32), knownIds: KNOWN });
  assert.equal(selection.accepted.length, 0);
  assert.equal(selection.deferred.length, 2);
});

test('部分成功：路线两端引用未登记的新对象时同样延后', () => {
  const ops = [route('new:R1', 'new:TOWN', 'new:TOWN2')];
  const selection = selectWithinBudget(ops, { budget: budget(32, 32), knownIds: KNOWN });
  assert.equal(selection.accepted.length, 0);
  assert.equal(selection.deferred.length, 1);
});

test('部分成功：已登记 ID 的依赖不阻塞', () => {
  const ops = [route('R2', 'L1', 'L2')];
  const selection = selectWithinBudget(ops, { budget: budget(32, 32), knownIds: KNOWN });
  assert.equal(selection.accepted.length, 1);
});

test('部分成功：总额先被更新类操作吃掉时，新增也要让位（共用总额）', () => {
  const ops = [];
  for (let i = 0; i < 3; i += 1) ops.push(loc('L1', undefined)); // 3 条更新
  for (let i = 0; i < 5; i += 1) ops.push(loc(`new:A${i}`, 'L1'));

  const selection = selectWithinBudget(ops, { budget: constructionBudget({ maxNewLocations: 32, maxNewRoutes: 32, totalOperations: 5 }), knownIds: KNOWN });
  assert.equal(selection.accepted.length, 5);
  assert.equal(selection.usage.total, 5);
  assert.equal(selection.deferred.length, 3, '总额被更新吃掉后，剩下 3 条新增延后');
});

test('describeBudgetUsage 给出可核对的一行数字', () => {
  const usage = budgetUsage([loc('new:A', 'L1'), route('R2', 'L1', 'L2')], KNOWN);
  const text = describeBudgetUsage(usage, budget(32, 32));
  assert.match(text, /ops 2\/64/);
  assert.match(text, /newLoc 1\/32/);
  assert.match(text, /newRoute 1\/32/);
});

test('分类表覆盖所有声明的类别，没有漏项', () => {
  for (const name of OPERATION_CLASSES) {
    assert.equal(typeof name, 'string');
  }
  assert.equal(new Set(OPERATION_CLASSES).size, OPERATION_CLASSES.length);
});

/* ───────────── P02 集成：共同总额前移到生成侧（F03 修复） ───────────── */

test('P02 集成：64 地点 + 64 路线 = 128 条，normalize 后只剩 64 条', async () => {
  const { normalizeConstructionOps } = await import('../src/atlas-sql-world-completion.ts');

  const ops = [
    ...Array.from({ length: 64 }, (_v, i) => ({
      op: 'location.upsert',
      ref: `new:L${i}`,
      data: { name: `匿名地点${i}`, parent_ref: 'L1' },
    })),
    ...Array.from({ length: 64 }, (_v, i) => ({
      op: 'route.propose',
      ref: `new:R${i}`,
      data: { from_ref: 'L1', to_ref: 'L2' },
    })),
  ];

  const result = normalizeConstructionOps({
    operations: ops,
    knownIds: ['L1', 'L2'],
    policy: { budgetMode: 'workload', maxNewLocations: 64, maxNewRoutes: 64 },
  });

  const kept = result.operations.filter((op) => op.op !== 'noop');
  assert.equal(kept.length, 64, '共同总额 64：不能因为地点/路线各 64 就放行 128');
  assert.ok(kept.every((op) => op.op === 'location.upsert'), '按顺序保留前 64 条');

  const overBudget = result.issues.filter((issue) => issue.code === 'WORLD_CONSTRUCTION_BUDGET_EXCEEDED');
  assert.equal(overBudget.length, 64, '被延后的 64 条逐条报出，不是一句总数了事');
  assert.ok(overBudget.every((issue) => issue.severity === 'warning' && issue.retryable === true));
  assert.match(overBudget[0].message, /共用同一总额/);
});

test('P02 集成：65 条地点在生成侧就被拦住，不会留到解析器截断', async () => {
  const { normalizeConstructionOps } = await import('../src/atlas-sql-world-completion.ts');

  const ops = Array.from({ length: 65 }, (_v, i) => ({
    op: 'location.upsert',
    ref: `new:L${i}`,
    data: { name: `匿名地点${i}`, parent_ref: 'L1' },
  }));

  const result = normalizeConstructionOps({
    operations: ops,
    knownIds: ['L1'],
    policy: { budgetMode: 'workload', maxNewLocations: 64, maxNewRoutes: 64 },
  });

  const kept = result.operations.filter((op) => op.op !== 'noop');
  assert.ok(kept.length <= 64, `生成侧输出 ${kept.length} 条，必须 ≤ 64`);
  // 第 65 条被地点配额延后（旧的类型配额路径），仍是一条明确的延后记录
  assert.ok(result.issues.some((issue) => issue.code === 'WORLD_CONSTRUCTION_DEFERRED'));
});
