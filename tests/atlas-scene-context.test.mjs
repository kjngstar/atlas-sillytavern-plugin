import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSceneLines, projectReceivedClues, renderSceneContext } from '../src/atlas-scene-context.ts';
import { applyAtlasEditText } from '../src/atlas-table-delta.ts';
import { validateAtlasTables } from '../src/atlas-tables.ts';

const location = (id, name = id) => ({ id, name, parentLocationId: null, description: '作者私密地点说明', rumors: [], factions: [], mapId: 'world', gridX: null, gridY: null });
const character = (id, locationId, positionSource = 'narrative') => ({ id, name: id, locationId, thought: '秘密刺杀计划', actionTendency: '明天潜入卧室', currentAction: '', targetLocationId: null, presence: locationId ? 'present' : 'unknown', positionSource, mapId: locationId ? 'world' : null, gridX: null, gridY: null });
const tables = () => ({ schemaVersion: 1, locations: [location('loc:1', '大厅'), location('loc:2', '远方城镇')], characters: [character('npc:hero', null, 'unknown'), character('npc:girl', 'loc:1'), character('npc:far', 'loc:2')], items: [] });
const block = (...rows) => '<atlasEdit>\n' + rows.map(row => JSON.stringify(row)).join('\n') + '\n</atlasEdit>';
const move = (ref, target, extra = {}) => ({ table: 'character', op: 'set', ref, patch: { locationRef: target, ...extra }, basis: 'inferred' });

test('主角位置：承接上下文的提议无需引文，来源明确为剧情推测', () => {
  const base = tables();
  const result = applyAtlasEditText(base, block(move('npc:hero', 'loc:1')), { 'msg:a': '她走到我面前，递来一封信。' }, { protagonistCharacterId: 'npc:hero' });
  assert.equal(result.delta.ok, true);
  const hero = result.delta.tables.characters[0];
  assert.equal(hero.locationId, 'loc:1');
  assert.equal(hero.positionSource, 'inferred');
  assert.equal(validateAtlasTables(result.delta.tables).ok, true);
  assert.equal(base.characters[0].locationId, null, '候选不会改动回合前状态');
});

test('位置纠偏：推测不覆盖手动记录；直接正文可升级为观察', () => {
  const base = tables(); base.characters[0] = character('npc:hero', 'loc:2', 'manual');
  const weak = applyAtlasEditText(base, block(move('npc:hero', 'loc:1')), { 'msg:a': '她走近。' }, { protagonistCharacterId: 'npc:hero' });
  assert.equal(weak.delta.rejected[0].code, 'POSITION_CONFLICT');
  assert.equal(weak.delta.tables.characters[0].locationId, 'loc:2');
  const strong = applyAtlasEditText(base, block({ ...move('npc:hero', 'loc:1'), basis: 'observed', quote: '我走进大厅' }), { 'msg:a': '我走进大厅' });
  assert.equal(strong.delta.tables.characters[0].positionSource, 'narrative');
});

test('远方 NPC：意图不变成抵达，位置失败不吞掉合法想法', () => {
  const result = applyAtlasEditText(tables(), block(move('npc:far', 'loc:1', { thought: '先等消息' })), { 'msg:a': '他想去大厅。' });
  assert.equal(result.delta.rejected[0].code, 'TRAVEL_NOT_ELAPSED');
  assert.equal(result.delta.tables.characters[2].locationId, 'loc:2');
  assert.equal(result.delta.tables.characters[2].thought, '先等消息');
});

test('位置：未知目标拒绝，已观察同地记录不降级，离场角色不复活', () => {
  const base = tables();
  base.characters[1].mapId = 'loc:1'; base.characters[1].gridX = 3; base.characters[1].gridY = 4;
  const missing = applyAtlasEditText(base, block(move('npc:hero', 'loc:404')), { 'msg:a': '她走近。' });
  assert.equal(missing.delta.rejected[0].code, 'ROW_NOT_FOUND');
  const same = applyAtlasEditText(base, block(move('npc:girl', 'loc:1')), { 'msg:a': '她走近。' });
  assert.equal(same.delta.tables.characters[1].positionSource, 'narrative');
  assert.equal(same.delta.tables.characters[1].gridX, 3, '同地确认不擦除已标定坐标');
  assert.equal(same.delta.tables.characters[1].mapId, 'loc:1', '坐标仍在原来的图层');
  base.characters[1].presence = 'left';
  const gone = applyAtlasEditText(base, block(move('npc:girl', 'loc:1')), { 'msg:a': '她走近。' });
  assert.equal(gone.delta.rejected[0].code, 'POSITION_CONFLICT');
});

test('场景：只列当前参与者，不暴露私下想法、未来动作和远方人员', () => {
  const text = renderSceneContext(projectSceneLines(tables(), '1'), []);
  assert.match(text, /大厅/); assert.match(text, /npc:girl/);
  assert.doesNotMatch(text, /秘密刺杀|明天潜入|远方城镇|npc:far|作者私密/);
});

test('线索：未送达、送达别处/其他人物、隐秘或未来消息均不注入', () => {
  const signals = ['public', 'hidden', 'future'].map((id, i) => ({ id, topic: `${id}消息`, visibility: i === 1 ? 'hidden' : 'known', status: 'active', publishedPeriod: i === 2 ? 10 : 1 }));
  const input = { signals, protagonistCharacterId: 'npc:hero', deliveries: [] };
  assert.deepEqual(projectReceivedClues(input, 'loc:1', 2), []);
  input.deliveries = signals.map(signal => ({ signalId: signal.id, recipientType: 'character', recipientId: 'npc:other' }));
  assert.deepEqual(projectReceivedClues(input, 'loc:1', 2), []);
  input.deliveries.forEach(receipt => { receipt.recipientId = 'npc:hero'; });
  assert.deepEqual(projectReceivedClues(input, null, 2), ['听到的传闻：public消息']);
});

test('线索：地点风声是接触候选，不自动成为角色已知；距离未知不外推', () => {
  const input = { signals: [{ id: 's', topic: '库房有动静', visibility: 'known', status: 'active', publishedPeriod: 1 }],
    deliveries: [{ signalId: 's', recipientType: 'location', recipientId: 'loc:1', receivedPeriod: 2 }] };
  assert.deepEqual(projectReceivedClues(input, 'loc:2', 2), []);
  assert.deepEqual(projectReceivedClues(input, null, 2), []);
  assert.match(projectReceivedClues(input, '1', 2)[0], /不代表已经注意或核实/);
  assert.deepEqual(projectReceivedClues(input, '1', 1), []);
});

test('格式：无内容不注入，预算包含闭合标签，重复消息只列一次', () => {
  assert.equal(renderSceneContext([], []), '');
  assert.equal(renderSceneContext(['大厅'], [], 20), '');
  const text = renderSceneContext(['大厅'], Array(20).fill('一条很长的消息'.repeat(20)), 320);
  assert.ok(text.length <= 320); assert.ok(text.endsWith('</atlas_scene_context>'));
  const input = { protagonistCharacterId: 'npc:hero', signals: [{ id: 's', topic: '消息', visibility: 'known', status: 'active', publishedPeriod: 1 }],
    events: [{ simulationId: 's', kind: 'signal', visibility: 'known', summary: '重复消息', status: 'published', period: 1 }],
    deliveries: [{ signalId: 's', recipientType: 'character', recipientId: 'npc:hero', confidence: 'confirmed' }] };
  assert.deepEqual(projectReceivedClues(input, 'loc:1', 2), ['收到的消息：消息']);
});
