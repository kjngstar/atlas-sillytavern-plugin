/**
 * atlas-scene-contradictions.test.mjs — P10 §16.4/§16.5 空间矛盾识别。
 *
 * 核心纪律：
 * 1. 只判「结构化事件 + 已知空间事实」能对上的类型；自然语言正文记进 unevaluated。
 * 2. 先开门再通行是正常描写，不能误报。
 * 3. 未知状态不判违规（未知不等于通畅，也不等于违规）。
 * 4. 只产出发现：不改世界、不重写正文、不额外发请求。
 * 5. 下一轮只强调仍适用的约束，不把警告永久刷屏。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSpatialTrait } from '../src/atlas-spatial-facts.ts';
import {
  CONTRADICTIONS_MUTATE_WORLD,
  constraintsForNextTurn,
  contradictionsToDiagnostics,
  detectSceneContradictions,
  sceneContradictionIssueId,
  stillApplicable,
} from '../src/atlas-scene-contradictions.ts';

const lockedDoor = resolveSpatialTrait({ objectId: 'D1', kind: 'door', material: 'wood', openingState: 'closed', locked: true });
const openDoor = resolveSpatialTrait({ objectId: 'D1', kind: 'door', material: 'wood', openingState: 'open', locked: false });
const glass = resolveSpatialTrait({ objectId: 'G1', kind: 'glass', material: 'glass' });
const unknownDoor = resolveSpatialTrait({ objectId: 'D9', kind: 'door' });

const claim = (overrides = {}) => ({
  claimId: 'K1', actorId: 'C1', kind: 'pass-through', objectId: 'D1',
  sequence: 10, turnId: 'turn-7', eventId: 'E1', ...overrides,
});

const detect = (overrides = {}) => detectSceneContradictions({ traits: [lockedDoor, glass], claims: [claim()], ...overrides });

// ── 1. 被点名要覆盖的四类 ───────────────────────────────────────────────────

test('P10: 门仍上锁且没开过就被穿过 → LOCKED_ENTRY_CROSSED', () => {
  const { contradictions } = detect();
  assert.equal(contradictions.length, 1);
  assert.equal(contradictions[0].code, 'LOCKED_ENTRY_CROSSED');
  assert.equal(contradictions[0].objectId, 'D1');
  assert.match(contradictions[0].message, /仍上锁/);
});

test('P10: 先开门再通行是顺序更新，不误报', () => {
  const { contradictions } = detect({ accessEvents: [{ objectId: 'D1', kind: 'open', sequence: 5, turnId: 'turn-7' }] });
  assert.deepEqual(contradictions, []);
});

test('P10: 开门事件发生在通行之后不算已经开了', () => {
  const { contradictions } = detect({ accessEvents: [{ objectId: 'D1', kind: 'open', sequence: 12, turnId: 'turn-7' }] });
  assert.equal(contradictions.length, 1, '顺序反了就是没开');
});

test('P10: 别的楼层的开门事件不能给这一层背书', () => {
  const { contradictions } = detect({ accessEvents: [{ objectId: 'D1', kind: 'open', sequence: 1, turnId: 'turn-6' }] });
  assert.equal(contradictions.length, 1);
});

test('P10: 把玻璃当可直接步行穿越 → GLASS_WALKED_THROUGH', () => {
  const { contradictions } = detectSceneContradictions({
    traits: [glass], claims: [claim({ objectId: 'G1' })],
  });
  assert.equal(contradictions.length, 1);
  assert.equal(contradictions[0].code, 'GLASS_WALKED_THROUGH');
  assert.match(contradictions[0].message, /可以直接看见，但不能直接走过去/);
});

test('P10: 把已毁出口当有效通道 → DESTROYED_EXIT_USED', () => {
  const { contradictions } = detect({ destroyedObjectIds: ['D1'] });
  assert.equal(contradictions.length, 1);
  assert.equal(contradictions[0].code, 'DESTROYED_EXIT_USED');
});

test('P10: 明确遮挡下声称看见 → SIGHT_THROUGH_OPAQUE', () => {
  const wall = resolveSpatialTrait({ objectId: 'W1', kind: 'wall', material: 'solid' });
  const { contradictions } = detectSceneContradictions({
    traits: [wall], claims: [claim({ objectId: 'W1', kind: 'see-through' })],
  });
  assert.equal(contradictions.length, 1);
  assert.equal(contradictions[0].code, 'SIGHT_THROUGH_OPAQUE');
});

test('P10: 玻璃不挡视线，所以「隔着玻璃看见」不是矛盾', () => {
  const { contradictions } = detectSceneContradictions({
    traits: [glass], claims: [claim({ objectId: 'G1', kind: 'see-through' })],
  });
  assert.deepEqual(contradictions, []);
});

test('P10: 同参考系下方位相反 → OPPOSITE_DIRECTION_CLAIM', () => {
  const { contradictions } = detectSceneContradictions({
    traits: [], claims: [claim({ kind: 'direction', objectId: 'L9', direction: '北', observedDirection: '南', referenceFrame: 'compass', observedReferenceFrame: 'compass' })],
  });
  assert.equal(contradictions.length, 1);
  assert.equal(contradictions[0].code, 'OPPOSITE_DIRECTION_CLAIM');
});

test('P10: 参考系不同不比较，只记未评估', () => {
  const result = detectSceneContradictions({
    traits: [], claims: [claim({ kind: 'direction', objectId: 'L9', direction: '北', observedDirection: '南', referenceFrame: 'compass', observedReferenceFrame: 'scene-local' })],
  });
  assert.deepEqual(result.contradictions, []);
  assert.ok(result.unevaluated.some((entry) => entry.scope.startsWith('direction')), '参考系不同不能硬判');
});

// ── 2. 不冒充全检 ───────────────────────────────────────────────────────────

test('P10: 未知状态不判违规，也记进未评估范围', () => {
  const result = detectSceneContradictions({ traits: [unknownDoor], claims: [claim({ objectId: 'D9' })] });
  assert.deepEqual(result.contradictions, [], '未知不放行，但也不诬告');
  assert.ok(result.unevaluated.some((entry) => entry.reason.includes('未知')));
});

test('P10: 自然语言正文永远列在未评估范围里', () => {
  const result = detect();
  assert.ok(result.unevaluated.some((entry) => entry.scope === 'free-text-narration'), '不许用一个正则宣称全检');
});

test('P10: 没有空间属性的物体不猜挡不挡路', () => {
  const result = detectSceneContradictions({ traits: [], claims: [claim({ objectId: 'X1' })] });
  assert.deepEqual(result.contradictions, []);
  assert.ok(result.unevaluated.some((entry) => entry.reason.includes('没有空间属性')));
});

test('P10: 拿取与遮挡的关系首版不推断，明确记为未评估', () => {
  const result = detectSceneContradictions({ traits: [glass], claims: [claim({ objectId: 'G1', kind: 'take' })] });
  assert.deepEqual(result.contradictions, []);
  assert.ok(result.unevaluated.some((entry) => entry.reason.includes('接触事件')));
});

// ── 3. 稳定 ID 与去重 ───────────────────────────────────────────────────────

test('P10: 同 floor/event/object/code 派生稳定 issueId，重放不产生两条', () => {
  const repeated = detect({ claims: [claim(), claim({ claimId: 'K1-replay' })] });
  assert.equal(repeated.contradictions.length, 1, '同文重放只有一条');
  assert.equal(
    repeated.contradictions[0].issueId,
    sceneContradictionIssueId({ turnId: 'turn-7', eventId: 'E1', objectId: 'D1', code: 'LOCKED_ENTRY_CROSSED' }),
  );
  const otherTurn = detect({ claims: [claim({ turnId: 'turn-8' })] });
  assert.notEqual(otherTurn.contradictions[0].issueId, repeated.contradictions[0].issueId, '换了楼层就是新问题');
  assert.equal(repeated.contradictions[0].evidence.claimId, 'K1', 'claimId 只留在证据里，不参与 ID');
});

test('P10: 只产出发现，不改世界真相', () => {
  assert.equal(CONTRADICTIONS_MUTATE_WORLD, false, '这一层永远不改 World');
  const result = detect();
  assert.deepEqual(Object.keys(result).sort(), ['contradictions', 'unevaluated']);
});

test('P10: 转成诊断条目供工作台提示，不碰正文', () => {
  const diagnostics = contradictionsToDiagnostics(detect().contradictions);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'LOCKED_ENTRY_CROSSED');
  assert.equal(diagnostics[0].severity, 'warning');
  assert.equal(diagnostics[0].retryable, false, '不因为矛盾自动重试正文');
});

// ── 4. 下一轮约束 ───────────────────────────────────────────────────────────

test('P10: 仍适用的约束才带到下一轮，状态变了就不再刷', () => {
  const contradiction = detect().contradictions[0];
  assert.equal(stillApplicable(contradiction, [lockedDoor]), true);
  assert.equal(stillApplicable(contradiction, [openDoor]), false, '门开了就不该继续提醒');
  assert.equal(stillApplicable(contradiction, []), false, '物体不在了就不提醒');
  const nextTurn = constraintsForNextTurn([contradiction], [lockedDoor], { currentTurnId: 'turn-8' });
  assert.equal(nextTurn.length, 1);
  const afterOpen = constraintsForNextTurn([contradiction], [openDoor], { currentTurnId: 'turn-8' });
  assert.deepEqual(afterOpen, [], '上一轮的错误不能永久附到每一轮');
});

test('P10: 本轮矛盾一定带上，历史矛盾按上限截断', () => {
  const current = detect({ claims: [claim({ turnId: 'turn-9', eventId: 'E9' })] }).contradictions[0];
  const older = [1, 2, 3].map((index) => ({ ...current, turnId: `turn-${index}`, issueId: `old-${index}` }));
  const list = constraintsForNextTurn([current, ...older], [lockedDoor], { currentTurnId: 'turn-9', limit: 2 });
  assert.equal(list.length, 2);
  assert.equal(list[0].issueId, current.issueId, '本轮的排在最前');
});

test('P10: 没有当前楼层时不把历史条目当成本轮事实', () => {
  const contradiction = detect().contradictions[0];
  assert.deepEqual(constraintsForNextTurn([contradiction], [openDoor], { currentTurnId: 'turn-9' }), []);
});
