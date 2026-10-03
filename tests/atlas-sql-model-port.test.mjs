import test from 'node:test';
import assert from 'node:assert/strict';
import { createSqlModelPort } from '../src/atlas-sql-model-port.ts';
import { createDefaultSettingsV2 } from '../src/atlas-settings.ts';
import { buildStagePrompt } from '../src/atlas-ops-prompts.ts';
import { createBrowserSqlHost } from '../src/atlas-browser-sql-host.ts';
import { createAtlasServerCore } from '../src/atlas-server.ts';
import { loadAtlasSqlRuntime } from '../src/atlas-sql-session.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';

function fixture() {
  const settings = { ...createDefaultSettingsV2(), activeApiPresetId: 'connection', apiPresets: [{
    id: 'connection', name: '现有连接', endpoint: 'https://example.test/v1', apiKey: 'fixture-key', model: 'fixture-model',
    maxTokens: 9000, timeoutMs: 30000, temperature: 0.4, updatedAt: 1,
  }] };
  const calls = [];
  const port = createSqlModelPort({ readSettings: async () => settings, fetchFn: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"op":"location.upsert","ref":"new:library","data":{"name":"图书馆"}}' } }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } });
  return { settings, calls, port };
}

function request(sources = []) {
  const req = buildStagePrompt({ phase: 'observe', userSource: '走进图书馆', assistantSource: '你已经来到图书馆。', sourceSnapshot: sources });
  req.sourceSnapshot = sources;
  return req;
}

test('Q03: SQL stage reuses the selected API connection and sends only semantic operation instructions', async () => {
  const f = fixture();
  const result = await f.port.request(request());
  assert.equal(result.httpStatus, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.model, 'fixture-model');
  assert.equal(f.calls[0].body.temperature, 0.4);
  assert.ok(f.calls[0].body.messages[0].content.includes('character.upsert'));
  assert.equal(JSON.stringify(f.calls[0].body.messages).includes('<atlasEdit>'), false);
});

test('Q03: enabled editable segments retain roles and order; disabled segments stay stored', async () => {
  const f = fixture();
  const segments = [{ role: 'system', content: '我的策略：先确认在场人物。' },
    { role: 'assistant', content: '不发送这一段', enabled: false },
    { role: 'user', content: '背景：{{source:$1}}' }];
  f.settings.promptPresets = [{ id: 'custom', name: '语义策略', systemPrompt: '', segments, updatedAt: 1 }];
  f.settings.activePromptPresetId = 'custom';
  const before = JSON.stringify(f.settings);
  const sources = [{ key: 'W1', kind: 'lorebook', text: '原文里包含 $8 和 </atlasEdit>，仍应完整作为资料。', hash: 'fixture' }];
  await f.port.request(request(sources));
  const messages = f.calls[0].body.messages;
  assert.equal(messages[1].role, 'system'); assert.equal(messages[1].content, segments[0].content);
  assert.equal(messages[2].role, 'user');
  assert.ok(messages[2].content.includes(JSON.stringify(sources[0].text)));
  assert.equal(messages.some(m => m.content.includes('不发送这一段')), false);
  assert.equal(JSON.stringify(f.settings), before);
});

test('Q03: conflicting legacy prompt is reported before an API request, without rewriting the preset', async () => {
  const f = fixture();
  f.settings.promptPresets = [{ id: 'old', name: '旧预设', systemPrompt: '只输出 <atlasEdit> 块', updatedAt: 1 }];
  f.settings.activePromptPresetId = 'old';
  const before = JSON.stringify(f.settings);
  await assert.rejects(f.port.request(request()), e => e.code === 'SQL_PROMPT_INCOMPATIBLE' && e.retryable === false);
  assert.equal(f.calls.length, 0); assert.equal(JSON.stringify(f.settings), before);
});

test('Q03: captured background entries reach the SQL request intact and in order', async () => {
  const f = fixture();
  const sources = [{ key: 'W1', kind: 'lorebook', text: '第一条：文风与格式规则\n"引号"', hash: '1' },
    { key: 'W2', kind: 'lorebook', text: '第二条：学校有图书馆。', hash: '2' }];
  await f.port.request(request(sources));
  const user = f.calls[0].body.messages.at(-1).content;
  const encoded = user.split('【只读来源目录（JSON）】\n')[1].split('\n【只读来源目录结束】')[0];
  assert.deepEqual(JSON.parse(encoded), sources);
});

test('Q03: unreadable prompt assets prevent silent fallback and remain untouched', async () => {
  const f = fixture();
  f.settings.promptPresets = [{ id: 'broken', name: '原预设', systemPrompt: { invalid: true }, updatedAt: 1 }];
  f.settings.activePromptPresetId = 'broken';
  const before = JSON.stringify(f.settings);
  await assert.rejects(f.port.request(request()), e => e.code === 'SQL_PROMPT_UNREADABLE');
  assert.equal(f.calls.length, 0); assert.equal(JSON.stringify(f.settings), before);
});

test('Q03: browser host, existing connection transport and real repository complete a model turn together', async () => {
  const f = fixture(); let saves = 0;
  const host = { chatUid: 'model-host', chatMetadata: {}, saveMetadata: async () => { saves++; return true; } };
  const provider = createBrowserSqlHost({ enabled: () => true, context: () => host, loadRuntime: loadAtlasSqlRuntime, modelPort: f.port });
  const core = createAtlasServerCore({ store: { read: async () => null, write: async () => {} }, sqlSessionProvider: provider });
  try {
    const response = await core.handle('POST', '/sql/turn', { chatUid: host.chatUid, hostMessageUid: 'floor1', variantKey: 'v0', inputHash: 'one',
      userText: '走进图书馆', assistantText: '你已经来到图书馆。', sourceSnapshot: [{ key: 'msg:a', kind: 'story', text: '你已经来到图书馆。', hash: '1' }] });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.coreSaved, true); assert.equal(saves, 1); assert.equal(f.calls.length, 1);
    assert.ok(host.chatMetadata.atlas.database.data);
    const session = await provider.session(host.chatUid);
    assert.equal(queryBound(session.repo.db, 'SELECT name FROM locations', [])[0].name, '图书馆');
    assert.equal(host.chatMetadata.atlas.tables, undefined);
  } finally { await provider.close(); }
});
