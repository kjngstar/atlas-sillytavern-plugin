/**
 * atlas-lore-selection.test.mjs — P2-02
 *
 * 验证 selectAtlasLoreSupplement:
 *  - 70 条无关条目排前、相关地点排末仍能选到后者
 *  - 输入次序改变输出稳定(确定性)
 *  - 正文/场景为空时不凭空激活
 *  - 中文长内容优先保留含关键词片段
 *  - 不超过 6000 字
 *  - 未激活 ≠ 禁用,降级时 sourceMode 明确
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAtlasLoreSupplement } from '../src/atlas-lore-selection.ts';

test('原文模式不按标题、激活状态或关键词选择条目，不重排或摘录正文', () => {
  const entries = ['文风规则', 'DS写作思维链', '角色背景', '学校地点'].map((title,i) =>
    makeEntry(String(i), `第${i}条原文。\n这里保留全部内容。`, { title }));
  entries.push(makeEntry('off', '作者禁用的内容', { enabled:false }));
  const result = selectAtlasLoreSupplement({ entries, includeAllEnabled:true, mode:'turn', maxChars:6000,
    activatedUids:new Set(['默认书:3']), chatKeywords:new Set(['学校']), sceneKeywords:new Set() });
  assert.deepEqual(result.selectedUids, ['默认书:0','默认书:1','默认书:2','默认书:3']);
  for (const entry of entries.slice(0,4)) assert.ok(result.text.includes(entry.content));
  assert.equal(result.text.includes('作者禁用的内容'), false);
});

test('原文模式只受长度预算限制，过长条目不会因为标题开销被整条丢弃', () => {
  const result = selectAtlasLoreSupplement({ entries:[makeEntry('long','原文'.repeat(4000), {title:'长资料'})],
    includeAllEnabled:true, mode:'turn',maxChars:6000,chatKeywords:new Set(),sceneKeywords:new Set() });
  assert.deepEqual(result.selectedUids, ['默认书:long']);
  assert.equal(result.text.length,6000);
  assert.equal(result.truncatedCount,1);
});

function makeEntry(uid, content, opts = {}) {
  return {
    uid,
    title: opts.title ?? '',
    bookName: opts.bookName ?? '默认书',
    content,
    enabled: opts.enabled ?? true,
    activated: opts.activated ?? false,
  };
}

test('P2-02a 70 条无关条目排前,相关地点排末能选到', () => {
  const entries = [];
  for (let i = 0; i < 70; i++) {
    entries.push(makeEntry(`n${i}`, `第 ${i} 条无关描述:非常长的背景介绍说明文字。`.repeat(10)));
  }
  entries.push(makeEntry('relplace', '相关地点:甲乙丙所在的具体场所描述。', {
    bookName: '卡书', title: '地图',
  }));
  const result = selectAtlasLoreSupplement({
    entries,
    activatedUids: new Set(),
    chatKeywords: new Set(['甲乙丙']),
    sceneKeywords: new Set(['甲乙丙']),
    mode: 'geo',
    maxChars: 6000,
  });
  assert.ok(result.selectedUids.includes('卡书:relplace'), `期望选中 relplace,实际 ${JSON.stringify(result.selectedUids)}`);
});

test('P2-02b 输入次序改变输出稳定(确定性)', () => {
  const a = [
    makeEntry('A', 'A 条目内容'),
    makeEntry('B', 'B 条目内容'),
    makeEntry('C', 'C 条目内容'),
  ];
  const b = [a[2], a[1], a[0]];
  const inputA = {
    entries: a,
    chatKeywords: new Set(),
    sceneKeywords: new Set(),
    mode: 'turn',
    maxChars: 6000,
  };
  const inputB = { ...inputA, entries: b };
  const rA = selectAtlasLoreSupplement(inputA);
  const rB = selectAtlasLoreSupplement(inputB);
  assert.deepEqual(rA.selectedUids, rB.selectedUids, '不同次序应输出相同选择');
});

test('P2-02c 正文或场景为空时不凭空激活', () => {
  const entries = [
    makeEntry('A', 'A 内容:参数化'),
    makeEntry('B', 'B 内容:背景'),
  ];
  const result = selectAtlasLoreSupplement({
    entries,
    chatKeywords: new Set(),
    sceneKeywords: new Set(),
    mode: 'turn',
    maxChars: 6000,
  });
  assert.equal(result.text, '', '没有正文相关性或已验证的激活条目时不注入背景');
});

test('P2-02d 中文长内容优先含关键词片段', () => {
  const filler = '无关背景介绍填充文字。'.repeat(500);
  const entries = [
    makeEntry('fill', filler + '关键词命中段应在中部。' + filler),
    makeEntry('hit', '短条目只有关键词命中段。'),
  ];
  const result = selectAtlasLoreSupplement({
    entries,
    chatKeywords: new Set(['关键词']),
    sceneKeywords: new Set(),
    mode: 'turn',
    maxChars: 6000,
  });
  assert.ok(result.selectedUids.includes('默认书:hit'), `关键词命中的短条目应被选中,实际 ${JSON.stringify(result.selectedUids)}`);
  assert.ok(result.text.includes('短条目只有关键词命中段'), '短条目正文应在 text 里');
  assert.ok(result.text.includes('关键词命中段应在中部'), '长条目须截取命中附近的正文');
});

test('P2-02e 不超过 6000 字(字符预算)', () => {
  const entries = [];
  for (let i = 0; i < 60; i++) {
    entries.push(makeEntry(`e${i}`, 'A'.repeat(400)));
  }
  const result = selectAtlasLoreSupplement({
    entries,
    chatKeywords: new Set(),
    sceneKeywords: new Set(),
    mode: 'turn',
    maxChars: 6000,
  });
  assert.ok(result.text.length <= 6000, `期望 ≤ 6000,实际 ${result.text.length}`);
});

test('P2-02f sourceMode 反映输入 mode', () => {
  const entries = [makeEntry('A', 'A')];
  const r1 = selectAtlasLoreSupplement({
    entries, chatKeywords: new Set(), sceneKeywords: new Set(),
    mode: 'turn', maxChars: 6000,
  });
  assert.equal(r1.sourceMode, 'turn');
  const r2 = selectAtlasLoreSupplement({
    entries, chatKeywords: new Set(), sceneKeywords: new Set(),
    mode: 'geo', maxChars: 6000,
  });
  assert.equal(r2.sourceMode, 'geo');
});

test('P2-02g disabled 条目不参与', () => {
  const entries = [
    makeEntry('on', '启用条目'),
    makeEntry('off', '禁用条目', { enabled: false }),
  ];
  const result = selectAtlasLoreSupplement({
    entries,
    chatKeywords: new Set(['启用条目']),
    sceneKeywords: new Set(),
    mode: 'turn',
    maxChars: 6000,
  });
  assert.ok(result.selectedUids.includes('默认书:on'));
  assert.ok(!result.selectedUids.includes('默认书:off'));
});

test('P2-02h 激活条目优先于未激活条目(同分时按书名/uid 稳定)', () => {
  const entries = [
    makeEntry('A', 'A 内容'),
    makeEntry('B', 'B 内容', { activated: true }),
  ];
  const result = selectAtlasLoreSupplement({
    entries,
    activatedUids: new Set(['默认书:B']),
    chatKeywords: new Set(),
    sceneKeywords: new Set(),
    mode: 'turn',
    maxChars: 6000,
  });
  assert.equal(result.selectedUids[0], '默认书:B', '激活的应排在最前');
});

test('两本书同 UID 只激活指定书，且预算包含换行', () => {
  const entries = [makeEntry('7', '甲书内容', { bookName: '甲书' }), makeEntry('7', '乙书内容', { bookName: '乙书' })];
  const result = selectAtlasLoreSupplement({ entries, activatedUids: new Set(['乙书:7']),
    chatKeywords: new Set(), sceneKeywords: new Set(), mode: 'turn', maxChars: 6000 });
  assert.deepEqual(result.selectedUids, ['乙书:7']);
  assert.equal(result.selectedOutputChars, result.text.length);
});
