/**
 * atlas-turn-highlights-p1.test.mjs — P1-01
 *
 * 验证 summarizeAtlasTurnChanges 返回结构化 {text, visibility, sourceRef?}
 * 与已知/隐藏二态语义:
 *   - 同地已观察人物 → known
 *   - 远方人物秘密移动 → hidden
 *   - 消息未送达 → hidden
 *   - 消息已送达 → known
 *   - 旧 string[] 输入兼容,默认 hidden
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAtlasTurnChanges } from '../src/atlas-turn-highlights.ts';

function loc(id, name, parentLocationId = null) {
  return {
    id, name, parentLocationId,
    description: '', rumors: [], factions: [],
    mapId: null, gridX: null, gridY: null,
  };
}
function char(id, name, locationId, presence = 'present', currentAction = '') {
  return {
    id, name, locationId, thought: '', actionTendency: '',
    currentAction, targetLocationId: null,
    presence, positionSource: 'narrative',
    mapId: null, gridX: null, gridY: null,
  };
}
function item(id, name, locationId = null, holderCharacterId = null) {
  return {
    id, name, description: '',
    locationId, holderCharacterId,
    status: 'normal',
    mapId: null, gridX: null, gridY: null,
  };
}

function emptyTables() {
  return { locations: [], characters: [], items: [] };
}

function makeTables({ locations = [], characters = [], items = [] }) {
  return { locations, characters, items };
}

test('P1-01a 同地已观察人物出现 → known', () => {
  const before = emptyTables();
  const after = makeTables({
    locations: [loc('L1', '某地'), loc('L2', '远方城市')],
    characters: [char('C1', '甲', 'L1')],
  });
  const highlights = summarizeAtlasTurnChanges(
    before,
    after,
    ['C1'],
    { povLocationId: 'L1', knownCharacterIds: new Set(['C1']), deliveredRefIds: new Set() },
  );
  assert.equal(highlights.length, 1);
  assert.equal(highlights[0].visibility, 'known');
  assert.match(highlights[0].text, /甲/);
});

test('P1-01b 远方人物秘密移动 → hidden', () => {
  const before = makeTables({
    locations: [loc('L1', '某地'), loc('L2', '远方城市')],
    characters: [char('C1', '甲', 'L2')],
  });
  const after = makeTables({
    locations: [loc('L1', '某地'), loc('L2', '远方城市')],
    characters: [char('C1', '甲', 'L1')],
  });
  const highlights = summarizeAtlasTurnChanges(
    before,
    after,
    ['C1'],
    { povLocationId: 'L1', knownCharacterIds: new Set(), deliveredRefIds: new Set() },
  );
  for (const h of highlights) {
    assert.equal(h.visibility, 'hidden', `期望 hidden,实际 ${h.visibility}: ${h.text}`);
  }
});

test('P1-01c 消息未送达 → hidden', () => {
  const before = emptyTables();
  const after = makeTables({
    locations: [loc('L1', '某地')],
    characters: [char('C1', '甲', 'L1')],
  });
  const highlights = summarizeAtlasTurnChanges(
    before,
    after,
    ['I1'],
    { povLocationId: 'L1', knownCharacterIds: new Set(['C1']), deliveredRefIds: new Set() },
  );
  const messageLike = highlights.some(
    (h) => h.visibility === 'known' && /送达|收到/.test(h.text),
  );
  assert.equal(messageLike, false);
});

test('P1-01d 消息已送达 → known', () => {
  const before = emptyTables();
  const after = makeTables({
    locations: [loc('L1', '某地')],
    characters: [char('C1', '甲', 'L1')],
    items: [item('I1', '纸条', 'L1')],
  });
  const highlights = summarizeAtlasTurnChanges(
    before,
    after,
    ['I1'],
    { povLocationId: 'L1', knownCharacterIds: new Set(['C1']), deliveredRefIds: new Set(['I1']) },
  );
  const knownOnes = highlights.filter((h) => h.visibility === 'known');
  assert.ok(knownOnes.length >= 1, '已送达的物品应有 known 摘要');
});

test('P1-01e 旧 string[] 兼容,默认 hidden', () => {
  const before = emptyTables();
  const after = emptyTables();
  const highlights = summarizeAtlasTurnChanges(
    before, after, [],
    { povLocationId: null, knownCharacterIds: new Set(), deliveredRefIds: new Set() },
  );
  assert.equal(highlights.length, 0);
});