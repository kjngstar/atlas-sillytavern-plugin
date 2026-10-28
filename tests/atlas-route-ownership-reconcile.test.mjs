/**
 * atlas-route-ownership-reconcile.test.mjs — P06 §12.4 跨批次路线对账。
 *
 * 重点：同图才画、跨图只保留拓扑、显式意图受保护、历史路线不自动修、
 * 统计口径分开算。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUTE_ASSIGNMENT_ACTIONS,
  planNewRouteMapAssignments,
  summarizeRouteAssignments,
} from '../src/atlas-route-ownership-reconcile.ts';

const intent = (overrides = {}) => ({
  routeId: 'R1',
  originJobId: 'J1',
  sourceOperationId: 'op_1',
  mapIntent: 'omitted',
  inferredMapId: null,
  ...overrides,
});

const endpoint = (overrides = {}) => ({ routeId: 'R1', fromMapId: 'M1', toMapId: 'M1', ...overrides });

test('P06 §12.4: 两端同图 → 可绘制归属', () => {
  const { assignments, issues } = planNewRouteMapAssignments({
    intents: [intent()],
    endpoints: [endpoint()],
  });
  assert.deepEqual(issues, []);
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].action, 'assign');
  assert.equal(assignments[0].mapId, 'M1');
});

test('P06 §12.4: 跨图不拼接局部坐标，只保留拓扑', () => {
  const { assignments, issues } = planNewRouteMapAssignments({
    intents: [intent()],
    endpoints: [endpoint({ toMapId: 'M2' })],
  });
  assert.equal(assignments[0].action, 'omit');
  assert.equal(assignments[0].mapId, null);
  const issue = issues.find((item) => item.code === 'ROUTE_CROSS_MAP_TOPOLOGY_ONLY');
  assert.ok(issue);
  assert.equal(issue.severity, 'warning');
});

test('P06 §12.4: 显式 null 保持拓扑，不画到任何图上', () => {
  const { assignments } = planNewRouteMapAssignments({
    intents: [intent({ mapIntent: 'explicit-null' })],
    endpoints: [endpoint()],
  });
  assert.equal(assignments[0].action, 'omit');
  assert.equal(assignments[0].mapId, null);
});

test('P06 §12.4: 显式 map 与端点一致 → assign', () => {
  const { assignments } = planNewRouteMapAssignments({
    intents: [intent({ mapIntent: 'explicit-map', inferredMapId: 'M1' })],
    endpoints: [endpoint()],
  });
  assert.equal(assignments[0].action, 'assign');
  assert.equal(assignments[0].mapId, 'M1');
});

test('P06 §12.4: 显式 map 与端点矛盾 → 报冲突，不挑一个「看起来对」的', () => {
  const { assignments, issues } = planNewRouteMapAssignments({
    intents: [intent({ mapIntent: 'explicit-map', inferredMapId: 'M9' })],
    endpoints: [endpoint()],
  });
  assert.equal(assignments[0].action, 'conflict');
  assert.equal(assignments[0].mapId, null);
  const issue = issues.find((item) => item.code === 'ROUTE_MAP_INTENT_CONFLICT');
  assert.ok(issue);
  assert.equal(issue.severity, 'error');
  assert.ok(issue.message.includes('M9'));
});

test('P06 §12.4: explicit-map 没给 mapId → 报错，不降级成 omitted', () => {
  const { assignments, issues } = planNewRouteMapAssignments({
    intents: [intent({ mapIntent: 'explicit-map', inferredMapId: null })],
    endpoints: [endpoint()],
  });
  assert.equal(assignments[0].action, 'conflict');
  assert.ok(issues.some((item) => item.code === 'ROUTE_INTENT_MAP_MISSING'));
});

test('P06 §12.4: 端点还没归图 → 显式归属先挂起（可重试）', () => {
  const { assignments, issues } = planNewRouteMapAssignments({
    intents: [intent({ mapIntent: 'explicit-map', inferredMapId: 'M1' })],
    endpoints: [],
  });
  assert.equal(assignments[0].action, 'conflict');
  const issue = issues.find((item) => item.code === 'ROUTE_ENDPOINTS_UNKNOWN');
  assert.ok(issue);
  assert.equal(issue.retryable, true, '端点归图后会再对账');
});

test('P06 §12.4: 一端没归图时 omitted 路线只保留拓扑，不半路画出来', () => {
  const { assignments } = planNewRouteMapAssignments({
    intents: [intent()],
    endpoints: [endpoint({ toMapId: null })],
  });
  assert.equal(assignments[0].action, 'omit');
});

test('P06 §12.4: 确认几何 / 锁受保护，普通对账不覆盖', () => {
  const { assignments, issues } = planNewRouteMapAssignments({
    intents: [intent()],
    endpoints: [endpoint({ fromMapId: 'M2', toMapId: 'M2' })],
    protectedRouteIds: ['R1'],
  });
  assert.equal(assignments[0].action, 'keep');
  assert.deepEqual(issues, [], '受保护路线不需要报问题');
});

test('P06 §12.4: 同一路线多条意图 → 一条都不执行，报冲突', () => {
  const { assignments, issues } = planNewRouteMapAssignments({
    intents: [intent({ inferredMapId: 'M1' }), intent({ inferredMapId: 'M2' })],
    endpoints: [endpoint()],
  });
  assert.equal(assignments.length, 1, '同一路线只产出一条结论');
  assert.equal(assignments[0].action, 'conflict');
  assert.equal(assignments.filter((item) => item.action === 'assign').length, 0, '不许先按第一条 assign');
  assert.ok(issues.some((item) => item.code === 'ROUTE_INTENT_DUPLICATE'));
});

test('P06 §12.4: 幂等 —— 同一输入两次结果完全一致', () => {
  const input = {
    intents: [intent({ routeId: 'R2' }), intent({ routeId: 'R1' })],
    endpoints: [endpoint({ routeId: 'R1' }), endpoint({ routeId: 'R2', toMapId: 'M2' })],
  };
  const first = planNewRouteMapAssignments(input);
  const second = planNewRouteMapAssignments(input);
  assert.deepEqual(first, second);
  assert.deepEqual(first.assignments.map((item) => item.routeId), ['R1', 'R2'], '按 routeId 升序，与输入顺序无关');
});

test('P06 §12.4: 统计口径分开算，不把拓扑与可绘制相加冒充完整', () => {
  const { assignments } = planNewRouteMapAssignments({
    intents: [
      intent({ routeId: 'R1' }),
      intent({ routeId: 'R2' }),
      intent({ routeId: 'R3', mapIntent: 'explicit-null' }),
    ],
    endpoints: [endpoint({ routeId: 'R1' }), endpoint({ routeId: 'R2', toMapId: 'M2' })],
    protectedRouteIds: ['R9'],
  });
  const summary = summarizeRouteAssignments(assignments);
  assert.equal(summary.owned, 1);
  assert.equal(summary.topologyOnly, 2);
  assert.equal(summary.conflicts, 0);
});

test('P06 §12.4: 只产出白名单里的 action', () => {
  const { assignments } = planNewRouteMapAssignments({
    intents: [
      intent({ routeId: 'R1' }),
      intent({ routeId: 'R2', mapIntent: 'explicit-null' }),
      intent({ routeId: 'R3', mapIntent: 'explicit-map', inferredMapId: 'X' }),
      intent({ routeId: 'R4' }),
    ],
    endpoints: [endpoint({ routeId: 'R1' }), endpoint({ routeId: 'R2' }), endpoint({ routeId: 'R3' })],
    protectedRouteIds: ['R4'],
  });
  for (const item of assignments) {
    assert.ok(ROUTE_ASSIGNMENT_ACTIONS.includes(item.action), `越界 action：${item.action}`);
  }
});
