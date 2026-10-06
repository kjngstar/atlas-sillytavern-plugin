import test from 'node:test';
import assert from 'node:assert/strict';
import { createSqlModelPort } from '../src/atlas-sql-model-port.ts';
import { createDefaultSettingsV2, applySettingsCommand, settingsViewV2 } from '../src/atlas-settings.ts';
import { DEFAULT_SQL_PROMPT_SEGMENTS } from '../src/atlas-sql-prompts.ts';
import { buildStagePrompt } from '../src/atlas-ops-prompts.ts';
import { createBrowserSqlHost } from '../src/atlas-browser-sql-host.ts';
import { createAtlasServerCore } from './legacy/atlas-server-fixture.ts';
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
  assert.equal(f.calls[0].body.max_tokens, 9000, '保存的输出上限不得被阶段默认 4096 隐式压低');
  assert.ok(f.calls[0].body.messages[0].content.includes('character.upsert'));
  assert.equal(JSON.stringify(f.calls[0].body.messages).includes('<atlasEdit>'), false);
  assert.deepEqual(f.calls[0].body.messages.slice(1, 7), DEFAULT_SQL_PROMPT_SEGMENTS.map(({role,content}) => ({role,content})));
  assert.deepEqual(settingsViewV2(f.settings).builtInSqlPrompt.segments.map(({role,content}) => ({role,content})), f.calls[0].body.messages.slice(1,7));
});

test('Q03: SQL repair also honors a saved output limit above the stage default', async () => {
  const f = fixture();
  const req = request(); req.phase = 'repair'; req.maxTokens = 2048;
  await f.port.request(req);
  assert.equal(f.calls[0].body.max_tokens, 9000);
});

test('Q03: explicit SQL draft preserves the original and copied entries, only disables conflicting protocols in the new copy', async () => {
  const f = fixture();
  const old = { id: 'old', name: '作者预设', systemPrompt: '', updatedAt: 1,
    segments: [{ role: 'system', name: '旧输出', content: '只输出 <atlasEdit>，table-delta-v1' },
      { role: 'assistant', name: '自定义策略', content: '别名优先复用。', enabled: true }] };
  f.settings.promptPresets = [old]; f.settings.activePromptPresetId = old.id;
  const before = JSON.stringify(old);
  const built = applySettingsCommand(f.settings, { action: 'prompt.migrate-sql', id: old.id }, { now: () => 2, makeId: () => 'draft' });
  assert.equal(built.ok, true); assert.equal(built.settings.activePromptPresetId, 'old');
  assert.equal(JSON.stringify(built.settings.promptPresets[0]), before);
  const draft = built.settings.promptPresets[1];
  assert.equal(draft.segments[6].content, old.segments[0].content); assert.equal(draft.segments[6].enabled, false);
  assert.deepEqual(draft.segments[7], old.segments[1]);
  Object.assign(f.settings, built.settings, { activePromptPresetId: draft.id });
  await f.port.request(request()); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.messages.some(m => m.content.includes('<atlasEdit>')), false);
  assert.equal(f.calls[0].body.messages[7].role, 'assistant');
});

test('Q03: full prompt entry capacity cannot silently truncate a compatibility draft', () => {
  const f = fixture();
  const old = { id: 'full', name: '完整预设', systemPrompt: '', updatedAt: 1, segments: Array.from({length:16}, (_,i) => ({role:'user',content:`条目 ${i}`})) };
  f.settings.promptPresets = [old]; const before = JSON.stringify(f.settings);
  const built = applySettingsCommand(f.settings, {action:'prompt.migrate-sql',id:old.id});
  assert.equal(built.ok, false); assert.equal(built.code, 'FIELD_LIMIT_EXCEEDED');
  assert.equal(JSON.stringify(f.settings), before);
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
