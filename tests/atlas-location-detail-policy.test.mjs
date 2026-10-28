/**
 * atlas-location-detail-policy.test.mjs — P03 §9.5 重要性和细节。
 *
 * 关键纪律：tier 只影响细节深度；不按名字含「王」或文本长度判定；
 * 每一条 important 都必须给得出证据（理由码 + 断言 ID）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DETAIL_TIER_REASONS, resolveLocationDetailTier } from '../src/atlas-world-build-plan.ts';

function fact(overrides = {}) {
  return {
    version: 1,
    id: 'F1',
    subjectId: 'L1',
    predicate: 'exists',
    layer: 'baseline',
    origin: 'lorebook',
    producer: 'program',
    sourceKey: 'W1',
    sourceHash: 'h1',
    sourceSpan: null,
    quality: 'confirmed',
    effectiveTurnId: 'T1',
    effectiveClockS: null,
    supersedesFactId: null,
    value: true,
    ...overrides,
  };
}

const locationOf = (overrides = {}) => ({ id: 'L1', kind: 'building', name: '某处', ...overrides });

test('P03 §9.5: 没有任何重要证据就是 ordinary', () => {
  const result = resolveLocationDetailTier({ location: locationOf(), facts: [], knownCharacters: [], plotLinks: [] });
  assert.equal(result.tier, 'ordinary');
  assert.deepEqual(result.reasonCodes, ['ORDINARY_DEFAULT']);
  assert.deepEqual(result.evidenceFactIds, []);
});

test('P03 §9.5: 名字带「王」不构成重要（不按名字判定）', () => {
  const result = resolveLocationDetailTier({
    location: locationOf({ name: '王宫大殿' }),
    facts: [fact({ predicate: 'exists' })],
    knownCharacters: [],
    plotLinks: [],
  });
  assert.equal(result.tier, 'ordinary', '只靠名字不能判重要');
});

test('P03 §9.5: 重要 NPC 的据点是 important', () => {
  const result = resolveLocationDetailTier({
    location: locationOf(),
    facts: [],
    knownCharacters: [{ id: 'C1', importance: 'core', status: 'active', location_id: 'L1' }],
    plotLinks: [],
  });
  assert.equal(result.tier, 'important');
  assert.ok(result.reasonCodes.includes('IMPORTANT_CHARACTER_ANCHOR'));
});

test('P03 §9.5: 重要 NPC 的住所也算据点', () => {
  const result = resolveLocationDetailTier({
    location: locationOf(),
    facts: [],
    knownCharacters: [{ id: 'C1', importance: 'recurring', status: 'active', home_location_id: 'L1' }],
    plotLinks: [],
  });
  assert.equal(result.tier, 'important');
  assert.ok(result.reasonCodes.includes('IMPORTANT_CHARACTER_ANCHOR'));
});

test('P03 §9.5: supporting 角色与已归档角色不构成重要', () => {
  const supporting = resolveLocationDetailTier({
    location: locationOf(),
    facts: [],
    knownCharacters: [{ id: 'C1', importance: 'supporting', status: 'active', location_id: 'L1' }],
    plotLinks: [],
  });
  assert.equal(supporting.tier, 'ordinary');

  const archived = resolveLocationDetailTier({
    location: locationOf(),
    facts: [],
    knownCharacters: [{ id: 'C1', importance: 'core', status: 'archived', location_id: 'L1' }],
    plotLinks: [],
  });
  assert.equal(archived.tier, 'ordinary', '归档角色不再给地点加细节');
});

test('P03 §9.5: 明确剧情链接让地点变 important', () => {
  const result = resolveLocationDetailTier({
    location: locationOf(),
    facts: [],
    knownCharacters: [],
    plotLinks: [{ id: 'P1', kind: 'key-scene', location_id: 'L1' }],
  });
  assert.equal(result.tier, 'important');
  assert.ok(result.reasonCodes.includes('PLOT_LINKED'));
});

test('P03 §9.5: 非剧情类链接不算（不乱认）', () => {
  const result = resolveLocationDetailTier({
    location: locationOf(),
    facts: [],
    knownCharacters: [],
    plotLinks: [{ id: 'P1', kind: 'ambient', location_id: 'L1' }],
  });
  assert.equal(result.tier, 'ordinary');
});

test('P03 §9.5: 世界书反复确认描述（≥3 条）才升为 important，且给出断言证据', () => {
  const result = resolveLocationDetailTier({
    location: locationOf(),
    facts: [
      fact({ id: 'F3', predicate: 'contains', value: ['内厅'] }),
      fact({ id: 'F1', predicate: 'exists' }),
      fact({ id: 'F2', predicate: 'entrance', value: 'south' }),
    ],
    knownCharacters: [],
    plotLinks: [],
  });
  assert.equal(result.tier, 'important');
  assert.ok(result.reasonCodes.includes('SOURCE_HIGHLIGHTED'));
  assert.deepEqual(result.evidenceFactIds, ['F1', 'F2', 'F3'], '证据 ID 按稳定顺序');
});

test('P03 §9.5: 只有两条确认断言还不算重点描述', () => {
  const result = resolveLocationDetailTier({
    location: locationOf(),
    facts: [fact({ id: 'F1' }), fact({ id: 'F2', predicate: 'entrance' })],
    knownCharacters: [],
    plotLinks: [],
  });
  assert.equal(result.tier, 'ordinary');
});

test('P03 §9.5: 推测断言与未确认断言都不计入「重点描述」', () => {
  const result = resolveLocationDetailTier({
    location: locationOf(),
    facts: [
      fact({ id: 'F1' }),
      fact({ id: 'F2', origin: 'inferred', quality: 'estimated' }),
      fact({ id: 'F3', quality: 'estimated' }),
      fact({ id: 'F4', layer: 'state-event' }),
    ],
    knownCharacters: [],
    plotLinks: [],
  });
  assert.equal(result.tier, 'ordinary');
});

test('P03 §9.5: 别的地点的事实不参与判定', () => {
  const result = resolveLocationDetailTier({
    location: locationOf(),
    facts: [
      fact({ id: 'F1', subjectId: 'L2' }),
      fact({ id: 'F2', subjectId: 'L2' }),
      fact({ id: 'F3', subjectId: 'L2' }),
    ],
    knownCharacters: [],
    plotLinks: [],
  });
  assert.equal(result.tier, 'ordinary');
});

test('P03 §9.5: loc: 前缀的旧写法能对上同一地点', () => {
  const result = resolveLocationDetailTier({
    location: locationOf({ id: 'L1' }),
    facts: [],
    knownCharacters: [{ id: 'C1', importance: 'core', status: 'active', location_id: 'loc:L1' }],
    plotLinks: [],
  });
  assert.equal(result.tier, 'important');
});

test('P03 §9.5: 多个理由同时命中去重且顺序稳定', () => {
  const result = resolveLocationDetailTier({
    location: locationOf(),
    facts: [fact({ id: 'F1' }), fact({ id: 'F2' }), fact({ id: 'F3' })],
    knownCharacters: [{ id: 'C1', importance: 'core', status: 'active', location_id: 'L1' }],
    plotLinks: [{ id: 'P1', kind: 'quest', locationId: 'L1' }],
  });
  assert.equal(result.tier, 'important');
  assert.deepEqual(result.reasonCodes, ['IMPORTANT_CHARACTER_ANCHOR', 'PLOT_LINKED', 'SOURCE_HIGHLIGHTED']);
  assert.equal(new Set(result.reasonCodes).size, result.reasonCodes.length);
});

test('P03 §9.5: 理由码都在白名单内', () => {
  const cases = [
    { knownCharacters: [], plotLinks: [], facts: [] },
    { knownCharacters: [{ id: 'C1', importance: 'core', status: 'active', location_id: 'L1' }], plotLinks: [], facts: [] },
    { knownCharacters: [], plotLinks: [{ kind: 'quest', location_id: 'L1' }], facts: [] },
    { knownCharacters: [], plotLinks: [], facts: [fact({ id: 'A' }), fact({ id: 'B' }), fact({ id: 'C' })] },
  ];
  for (const item of cases) {
    const result = resolveLocationDetailTier({ location: locationOf(), ...item });
    for (const reason of result.reasonCodes) {
      assert.ok((DETAIL_TIER_REASONS).includes(reason), `理由码越界：${reason}`);
    }
    assert.ok(['ordinary', 'important'].includes(result.tier));
  }
});
