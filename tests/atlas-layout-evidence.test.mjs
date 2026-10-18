import test from 'node:test';
import assert from 'node:assert/strict';
import { planLayoutEvidence, parseLayoutEvidence, attachLayoutEvidence, layoutEvidenceSegments } from '../src/atlas-layout-evidence.ts';
import { createSqlModelPort } from '../src/atlas-sql-model-port.ts';
import { createDefaultSettingsV2 } from '../src/atlas-settings.ts';

const anchor = { chatUid: 'chat-a', branchId: 'branch-a', parentTurnId: null, hostMessageUid: 'host-a', variantKey: 'v', baseRevision: 1, baseStorageRevision: 1, inputHash: 'hash' };
const maps = [{ id: 'map-a', alias: 'M1', name: '港湾' }];

test('two-stage evidence includes source tail and excludes raw lore from layout', () => {
  const tail = '港湾的灯塔位于码头以东。';
  const text = '无关故事。'.repeat(3500) + tail;
  const batches = planLayoutEvidence([{ key: 'lore-a', kind: 'lorebook', hash: 'hash-a', text }], maps, anchor, 'layout-a');
  assert.ok(batches.length > 1);
  let covered = 0;
  for (const chunk of batches.flatMap(batch => batch.chunks)) {
    assert.equal(chunk.text, text.slice(chunk.start, chunk.end));
    assert.ok(chunk.start <= covered, '来源尾部与块间文字不能丢失');
    covered = Math.max(covered, chunk.end);
  }
  assert.equal(covered, text.length);
  assert.ok(batches.every(batch => batch.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) <= 12000));
  const last = batches.find(batch => batch.chunks.some(chunk => chunk.text.includes(tail)));
  assert.ok(last, '资料尾部必须进入第一步');
  const facts = parseLayoutEvidence(JSON.stringify({ facts: [{ mapRef: 'M1', quote: tail }] }), last.chunks, maps);
  assert.equal(facts[0].text, tail);
  assert.equal(facts[0].sourceKey, 'lore-a');
  assert.equal(facts[0].contentHash, 'hash-a');
  assert.equal(text.slice(facts[0].start, facts[0].end), tail);
  const layout = attachLayoutEvidence({ batchId: 'layout-a', phase: 'geography', anchor, allowedOps: ['map.layout.request'], maxTokens: 4096, timeoutMs: 120000,
    messages: [{ role: 'system', content: 'protocol' }, { role: 'user', content: '绘制地图' }],
    sourceSnapshot: [{ key: 'lore-a', kind: 'lorebook', hash: 'hash-a', text }],
    promptInput: { injectionText: '绘制地图', userText: text, assistantText: text, loreSupplement: text },
  }, facts, ['map-a']);
  assert.equal(layout.sourceSnapshot.length, 0);
  assert.equal(layout.promptInput.userText, '');
  assert.equal(layout.promptInput.assistantText, '');
  assert.equal(layout.promptInput.loreSupplement, '');
  assert.ok(layout.messages[1].content.includes(tail));
  assert.ok(!layout.messages[1].content.includes(text.slice(0, 500)));
});

test('ungrounded or malformed excerpts fail before layout', () => {
  const batch = planLayoutEvidence([{ key: 's', kind: 'story', hash: 'h', text: '港湾在山南。' }], maps, anchor, 'layout-b')[0];
  assert.equal(parseLayoutEvidence('<think>核对原文。</think>\n```json\n{"facts":[{"mapRef":"M1","quote":"港湾在山南。"}]}\n```', batch.chunks, maps)[0].text, '港湾在山南。');
  assert.throws(() => parseLayoutEvidence('{"facts":[', batch.chunks, maps), { code: 'LAYOUT_EVIDENCE_JSON' });
  assert.throws(() => parseLayoutEvidence('<think>未闭合 {"facts":[]}', batch.chunks, maps), { code: 'LAYOUT_EVIDENCE_JSON' });
  assert.throws(() => parseLayoutEvidence('{"facts":[{"mapRef":"M1","quote":"港湾在山北。"}]}', batch.chunks, maps), { code: 'LAYOUT_EVIDENCE_UNGROUNDED' });
  assert.throws(() => parseLayoutEvidence('{"facts":[{"mapRef":"M2","quote":"港湾在山南。"}]}', batch.chunks, maps), { code: 'LAYOUT_EVIDENCE_SCHEMA' });
});

test('final assembled model messages keep raw source in extraction only', async () => {
  const raw = '不应进入排版的长原文标记 ' + '甲'.repeat(500);
  const settings = createDefaultSettingsV2();
  settings.apiPresets = [{ id: 'api', name: 'fixture', endpoint: 'https://example.test/v1', apiKey: 'fixture', model: 'fixture', maxTokens: 4096, timeoutMs: 30000, temperature: 0.4, updatedAt: 1 }];
  settings.activeApiPresetId = 'api';
  const port = createSqlModelPort({ readSettings: async () => settings });
  const batch = planLayoutEvidence([{ key: 'lore', kind: 'lorebook', hash: 'h', text: raw }], maps, anchor, 'layout-final')[0];
  const extracted = await port.preview(batch.request);
  for (const segment of layoutEvidenceSegments(batch.chunks)) {
    assert.ok(extracted.messages.some(message => message.content.includes(segment.text)));
    assert.equal(segment.text, raw.slice(segment.start, segment.end));
  }
  assert.equal(extracted.messages.length, 2, '摘录阶段不混入 SQL 操作格式策略');
  const request = attachLayoutEvidence({ batchId: 'layout-final', phase: 'geography', anchor, allowedOps: ['map.layout.request'], maxTokens: 4096, timeoutMs: 120000,
    messages: [{ role: 'system', content: '布局协议' }, { role: 'user', content: '绘制港湾' }],
    sourceSnapshot: [{ key: 'lore', kind: 'lorebook', hash: 'h', text: raw }],
    promptInput: { injectionText: '绘制港湾', userText: raw, assistantText: raw, loreSupplement: raw },
  }, [], ['map-a']);
  const layout = await port.preview(request);
  assert.ok(!JSON.stringify(layout.messages).includes(raw));
  assert.ok(!JSON.stringify(layout.messages).includes('不应进入排版的长原文标记'));
});
