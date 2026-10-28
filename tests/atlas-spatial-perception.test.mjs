/**
 * atlas-spatial-perception.test.mjs — P07 §13.3 保密过滤与感知候选。
 *
 * 核心：候选永远只是「可能」，不能直接写 knowledge；未知遮挡不放行；
 * 隐藏房间里的 NPC 不泄漏给主角；未标定图不给米数。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSpatialFacts, projectSpatialFactsForActor } from '../src/atlas-spatial-facts.ts';
import {
  buildPerceptionCandidates,
  canPromoteToKnowledge,
  summarizePerceptionForNarration,
} from '../src/atlas-spatial-perception.ts';

const trait = (overrides = {}) => ({ objectId: 'O1', kind: 'wall', material: 'solid', ...overrides });

function projectionOf(objects, overrides = {}) {
  const facts = collectSpatialFacts({ mapId: 'M1', metersPerCell: 0.5, objects });
  return projectSpatialFactsForActor({ facts, actorId: 'P1', ...overrides });
}

test('P07 §13.3: 同一空间的角色只产生 presence 候选，不是「已经看见」', () => {
  const projection = projectionOf([trait({ objectId: 'HALL', kind: 'wall' })]);
  const { candidates } = buildPerceptionCandidates({
    projection,
    observerObjectId: 'HALL',
    subjects: [{ subjectId: 'N1', atObjectId: 'HALL' }],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, 'presence');
  assert.equal(candidates[0].certainty, 'possible');
  assert.equal(candidates[0].evaluationOnly, true);
});

test('P07 §13.3: 隔着可透视房间才产生 sighting 候选', () => {
  const projection = projectionOf([trait({ objectId: 'GLASS_HALL', kind: 'glass', material: 'glass' })]);
  const { candidates } = buildPerceptionCandidates({
    projection,
    observerObjectId: 'ELSEWHERE',
    subjects: [{ subjectId: 'N1', atObjectId: 'GLASS_HALL' }],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, 'sighting');
  assert.equal(candidates[0].basis, 'observed');
});

test('P07 §13.3: 视线未知 → 不生成目击候选（未知不放行）', () => {
  const projection = projectionOf([trait({ objectId: 'FOGGY', kind: 'door' })]);
  const { candidates, issues } = buildPerceptionCandidates({
    projection,
    observerObjectId: 'ELSEWHERE',
    subjects: [{ subjectId: 'N1', atObjectId: 'FOGGY' }],
  });
  assert.deepEqual(candidates, []);
  assert.ok(issues.some((item) => item.code === 'PERCEPTION_SIGHT_UNKNOWN'));
});

test('P07 §13.3: 目标所在空间对该角色不可观察 → 不产生候选（不泄漏隐藏房间）', () => {
  const projection = projectionOf([trait({ objectId: 'SECRET', kind: 'wall' })], { secretObjectIds: ['SECRET'] });
  const { candidates } = buildPerceptionCandidates({
    projection,
    observerObjectId: 'ELSEWHERE',
    subjects: [{ subjectId: 'HIDDEN_NPC', atObjectId: 'SECRET' }],
  });
  assert.deepEqual(candidates, [], '秘密空间里的 NPC 不能因为「同图」就被感知到');
  assert.deepEqual(projection.withheldObjectIds, ['SECRET']);
});

test('P07 §13.3: 位置未知的对象不产生候选——未知不是「就在附近」', () => {
  const projection = projectionOf([trait({ objectId: 'HALL', kind: 'wall' })]);
  const { candidates } = buildPerceptionCandidates({
    projection,
    observerObjectId: 'HALL',
    subjects: [{ subjectId: 'N_UNKNOWN' }],
  });
  assert.deepEqual(candidates, []);
});

test('P07 §13.3: 候选永远不能直接升级成角色知识', () => {
  assert.equal(canPromoteToKnowledge(), false);
  const projection = projectionOf([trait({ objectId: 'HALL', kind: 'wall' })]);
  const { candidates } = buildPerceptionCandidates({
    projection,
    observerObjectId: 'HALL',
    subjects: [{ subjectId: 'N1', atObjectId: 'HALL' }],
  });
  for (const candidate of candidates) {
    assert.equal(candidate.certainty, 'possible');
    assert.equal(candidate.evaluationOnly, true);
  }
});

test('P07 §13.3: 没有角色 ID 就不生成任何候选', () => {
  const facts = collectSpatialFacts({ mapId: 'M1', metersPerCell: 0.5, objects: [trait()] });
  const naked = projectSpatialFactsForActor({ facts, actorId: '' });
  const { candidates, issues } = buildPerceptionCandidates({ projection: naked, subjects: [{ subjectId: 'N1', atObjectId: 'O1' }] });
  assert.deepEqual(candidates, []);
  assert.ok(issues.some((item) => item.code === 'PERCEPTION_ACTOR_MISSING'));
});

test('P07 §13.3: 显式屏蔽的物体即使可观察也不生成候选', () => {
  const projection = projectionOf([trait({ objectId: 'HALL', kind: 'wall' })]);
  const { candidates } = buildPerceptionCandidates({
    projection,
    observerObjectId: 'ELSEWHERE',
    subjects: [{ subjectId: 'N1', atObjectId: 'HALL' }],
    blockedObjectIds: ['HALL'],
  });
  assert.deepEqual(candidates, []);
});

test('P07 §13.3: 正文摘要只描述通/不通，不给米数', () => {
  const projection = projectionOf([
    trait({ objectId: 'OPEN_DOOR', kind: 'door', openingState: 'open' }),
    trait({ objectId: 'LOCKED_DOOR', kind: 'door', openingState: 'closed', locked: true }),
  ]);
  const { lines, issues } = summarizePerceptionForNarration({ projection });
  assert.ok(lines.some((line) => line.includes('可以通过')));
  assert.ok(lines.some((line) => line.includes('挡路')));
  assert.equal(lines.some((line) => /\d+\s*米/.test(line)), false, '正文不出现米数');
  assert.deepEqual(issues, []);
});

test('P07 §13.3: 未标定图在正文里明确不给度量', () => {
  const facts = collectSpatialFacts({ mapId: 'M1', objects: [trait({ objectId: 'D1', kind: 'door', openingState: 'open' })] });
  const projection = projectSpatialFactsForActor({ facts, actorId: 'P1' });
  const { issues } = summarizePerceptionForNarration({ projection });
  assert.ok(issues.some((item) => item.code === 'NARRATION_NO_METRICS'));
});

test('P07 §13.3: 候选输出确定性（同一输入同一顺序，无重复）', () => {
  const projection = projectionOf([trait({ objectId: 'HALL', kind: 'wall' })]);
  const input = {
    projection,
    observerObjectId: 'HALL',
    subjects: [
      { subjectId: 'N2', atObjectId: 'HALL' },
      { subjectId: 'N1', atObjectId: 'HALL' },
      { subjectId: 'N1', atObjectId: 'HALL' },
    ],
  };
  const first = buildPerceptionCandidates(input);
  const second = buildPerceptionCandidates(input);
  assert.deepEqual(first, second);
  assert.deepEqual(first.candidates.map((item) => item.subjectId), ['N1', 'N2'], '按候选 ID 排序且去重');
});
