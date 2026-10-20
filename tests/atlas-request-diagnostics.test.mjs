import test from 'node:test';
import assert from 'node:assert/strict';
import { callAtlasWorldTurnApi } from '../src/atlas-api-client.ts';
import { createAtlasDiagnosticsSink, atlasRefFingerprint, sanitizeDiagnostic } from '../src/atlas-diagnostics.ts';
import { atlasDiagnosticContext, createAtlasApiDiagnosticLogger, emitAtlasIssueDiagnostics } from '../src/atlas-request-diagnostics.ts';
import { createSqlModelPort } from '../src/atlas-sql-model-port.ts';
import { createDefaultSettingsV2 } from '../src/atlas-settings.ts';
import { buildStagePrompt } from '../src/atlas-ops-prompts.ts';
import { referenceDiagnostics } from '../ui/atlas-reference-data.mjs';
import { createGenerationBudget } from '../src/atlas-sql-generation-budget.ts';

const preset = { name: 'fixture', model: 'google/gemini-test', endpoint: 'https://private.invalid/v1', apiKey: 'sk-private-fixture', timeoutMs: 1000, maxTokens: 0 };
const input = { injectionText: '', userText: 'private-user-story', assistantText: 'private-assistant-story', baseRevision: 0 };
const anchor = { chatUid: 'private-chat-A', branchId: 'private-branch', hostMessageUid: 'private-floor', variantKey: 'original', baseRevision: 7, baseStorageRevision: 9 };
const metadata = { pluginVersion: '0.9.96', buildId: 'build-0123456789abcdef', buildCommit: 'a'.repeat(40), buildDirty: true };
const success = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"op":"noop"}' } }] }));
function recorder() {
  const sink = createAtlasDiagnosticsSink({ metadata });
  return { sink, emit: event => sink.emit(event), rows: () => sink.getSnapshot() };
}

test('safe export retains actual route, build and request evidence without arbitrary URLs or credentials', () => {
  const event = { level: 'error', source: 'model', code: 'MODEL_REQUEST_FAILED', operation: 'generation', phase: 'request', outcome: 'failed', ...metadata,
    requestRef: atlasRefFingerprint('request'), causeCode: 'API_TIMEOUT', details: { route: '/sql/chat/commit', model: 'google/gemini-test', timeoutMs: 1200000, maxTokens: 0,
      promptChars: 12345, schemaPath: '$.maps[*].frame_json', headers: { Authorization: preset.apiKey }, request: input, endpoint: preset.endpoint } };
  const safe = sanitizeDiagnostic(event);
  assert.equal(safe.details.route, '/sql/chat/commit');
  assert.equal(safe.details.model, preset.model);
  assert.equal(safe.details.schemaPath, '$.maps[*].frame_json');
  assert.equal(safe.details.timeoutMs, 1200000);
  assert.deepEqual([safe.buildId, safe.buildCommit, safe.buildDirty], [metadata.buildId, metadata.buildCommit, true]);
  for (const route of ['/sql/chat/commit?key=secret', '/private/secret', 'https://private.invalid']) {
    assert.equal(sanitizeDiagnostic({ ...event, details: { route } }).details, undefined);
  }
  const exported = JSON.stringify(safe);
  for (const privateText of [preset.apiKey, preset.endpoint, input.userText, input.assistantText]) assert.equal(exported.includes(privateText), false);
});

test('request timeout reports API_TIMEOUT and the request phase, even when fetch ignores abort', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = recorder(); let sends = 0;
  const promise = callAtlasWorldTurnApi(preset, input, { fetchFn: () => { sends++; return new Promise(() => {}); },
    onDiagnostic: r.emit, diagnosticContext: atlasDiagnosticContext(anchor) });
  t.mock.timers.tick(1000);
  const result = await promise;
  assert.equal(result.code, 'API_TIMEOUT');
  const failure = r.rows().at(-1);
  assert.equal(failure.errorCode, 'API_TIMEOUT');
  assert.equal(failure.details.failureStage, 'request');
  assert.equal(failure.details.cancelledBy, 'timeout');
  assert.equal(failure.details.timeoutMs, 1000);
  assert.equal(failure.details.maxTokens, 0);
  assert.equal(sends, 1);
  assert.equal(r.rows().filter(e => e.code === 'MODEL_REQUEST_STARTED').length, 1);
  assert.equal(failure.requestRef, r.rows()[0].requestRef);
  assert.equal(failure.chatFingerprint, atlasRefFingerprint(anchor.chatUid));
});

test('body timeout preserves received HTTP status and distinguishes waiting for body from waiting for headers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = recorder(); let entered;
  const bodyStarted = new Promise(resolve => { entered = resolve; });
  const promise = callAtlasWorldTurnApi(preset, input, { onDiagnostic: r.emit,
    fetchFn: async () => ({ status: 200, text: () => { entered(); return new Promise(() => {}); } }) });
  await bodyStarted;
  t.mock.timers.tick(1000);
  const result = await promise;
  assert.equal(result.code, 'API_TIMEOUT');
  const failure = r.rows().at(-1);
  assert.equal(failure.details.failureStage, 'body');
  assert.equal(failure.httpStatus, 200);
  assert.equal(typeof failure.details.headersMs, 'number');
  assert.equal(typeof failure.details.bodyMs, 'number');
});

test('network failure keeps its classified code and safe exception name without copying exception text', async () => {
  const r = recorder();
  const result = await callAtlasWorldTurnApi(preset, input, { onDiagnostic: r.emit, fetchFn: async () => { throw new TypeError('private endpoint ' + preset.apiKey); } });
  assert.equal(result.code, 'SERVICE_OFFLINE');
  assert.equal(r.rows().at(-1).errorCode, 'SERVICE_OFFLINE');
  assert.equal(r.rows().at(-1).details.errorName, 'TypeError');
  assert.equal(r.sink.exportSafe().includes(preset.apiKey), false);
});

test('HTTP failures retain observed status and retryability', async () => {
  const r = recorder();
  const result = await callAtlasWorldTurnApi(preset, input, { onDiagnostic: r.emit, fetchFn: async () => new Response('{}', { status: 429 }) });
  assert.equal(result.ok, false);
  assert.equal(r.rows().at(-1).httpStatus, 429);
  assert.equal(r.rows().at(-1).retryable, result.retryable);
});

test('compatibility resend is counted as two real sends sharing one request reference', async () => {
  const r = recorder(); let sends = 0;
  const result = await callAtlasWorldTurnApi({ ...preset, endpoint: 'https://api.minimaxi.com/v1', apiKey: 'sk-cp-private-fixture' }, input, {
    onDiagnostic: r.emit, rescueTransport: () => ({ ok: true }),
    fetchFn: async () => ++sends === 1 ? new Response(JSON.stringify({ error: { message: 'Not Found' } })) : success(),
  });
  assert.equal(result.ok, true);
  const starts = r.rows().filter(e => e.code === 'MODEL_REQUEST_STARTED');
  assert.equal(starts.length, sends);
  assert.deepEqual(starts.map(e => e.details.transportAttempt), [1, 2]);
  assert.deepEqual(starts.map(e => e.details.retryKind), ['normal', 'compatibility']);
  assert.equal(new Set(r.rows().map(e => e.requestRef)).size, 1);
  assert.equal(r.rows().at(-1).details.modelRequests, 2);
});

test('denied budget records zero real sends and does not fabricate a started request', async () => {
  const r = recorder(); let sends = 0;
  const result = await callAtlasWorldTurnApi(preset, input, { onDiagnostic: r.emit,
    initialTransport: () => ({ ok: false }), fetchFn: async () => { sends++; return success(); } });
  assert.equal(result.code, 'MODEL_BUDGET_EXHAUSTED');
  assert.equal(sends, 0);
  assert.equal(r.rows().some(e => e.code === 'MODEL_REQUEST_STARTED'), false);
  assert.equal(r.rows().at(-1).details.failureStage, 'budget');
  assert.equal(r.rows().at(-1).details.modelRequests, 0);
});

test('diagnostic observer failure never changes a model result or causes an additional send', async () => {
  let sends = 0;
  const result = await callAtlasWorldTurnApi(preset, input, { onDiagnostic: () => { throw Error('observer unavailable'); },
    fetchFn: async () => { sends++; return success(); } });
  assert.equal(result.ok, true);
  assert.equal(sends, 1);
});

test('concurrent model requests keep separate request and chat references when completions arrive in reverse order', async () => {
  const r = recorder(); const releases = [];
  const fetchFn = () => new Promise(resolve => releases.push(() => resolve(success())));
  const a = callAtlasWorldTurnApi(preset, input, { fetchFn, onDiagnostic: r.emit, diagnosticContext: atlasDiagnosticContext(anchor) });
  const b = callAtlasWorldTurnApi(preset, input, { fetchFn, onDiagnostic: r.emit, diagnosticContext: atlasDiagnosticContext({ ...anchor, chatUid: 'private-chat-B' }) });
  releases[1](); await b; releases[0](); await a;
  const starts = r.rows().filter(e => e.code === 'MODEL_REQUEST_STARTED');
  assert.notEqual(starts[0].requestRef, starts[1].requestRef);
  for (const start of starts) {
    const end = r.rows().find(e => e.code === 'MODEL_REQUEST_COMPLETED' && e.requestRef === start.requestRef);
    assert.equal(end.chatFingerprint, start.chatFingerprint);
    assert.equal(end.details.turnRef, start.details.turnRef);
  }
});

test('engine failure exports the underlying issue and captures the original chat before a switch', async () => {
  const r = recorder(); let chat = anchor.chatUid;
  const log = createAtlasApiDiagnosticLogger({ emit: r.emit, context: () => ({ chatUid: chat, branchId: anchor.branchId }) });
  const issue = { code: 'API_TIMEOUT', path: '$.model', severity: 'error', message: input.assistantText, retryable: true };
  const response = { status: 500, body: { ok: false, error: { code: 'TURN_FAILED', details: { receipt: { anchor, issues: [issue] } } } } };
  const result = await log('POST', '/sql/chat/commit', async () => { chat = 'private-chat-B'; return response; }, anchor);
  assert.equal(result, response);
  const failure = r.rows().find(e => e.code === 'API_CALL_FAILED');
  assert.equal(failure.causeCode, 'API_TIMEOUT');
  assert.equal(failure.chatFingerprint, atlasRefFingerprint(anchor.chatUid));
  assert.equal(failure.details.coreSaved, undefined, 'HTTP 500 alone does not prove whether a save happened');
  const errors = r.rows().filter(e => e.code === 'REQUEST_ISSUE');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].errorCode, 'API_TIMEOUT');
  assert.equal(errors[0].requestRef, failure.requestRef);
  assert.equal(errors[0].details.schemaPath, '$.model');
  assert.equal(r.sink.exportSafe().includes(input.assistantText), false);
});

test('partial layout keeps saved state and emits every distinct issue, with hashed dynamic map keys', async () => {
  const r = recorder(); const log = createAtlasApiDiagnosticLogger({ emit: r.emit });
  const issues = [
    { code: 'LAYOUT_FRAME_UNUSABLE', path: '$.maps.private-map-id.frame_json', severity: 'warning', retryable: true },
    { code: 'LAYOUT_CONSTRAINT_FAILED', path: '$.layout.shapes[1]', severity: 'error', retryable: true },
  ];
  await log('POST', '/sql/chat/map/layout', async () => ({ status: 200, body: { ok: true,
    data: { coreSaved: true, sceneSaved: false, issues, receipt: { status: 'partial', anchor, issues, groups: [{ status: 'applied', changedRows: 2 }] } } } }), anchor);
  const done = r.rows().find(e => e.code === 'API_CALL_PARTIAL');
  assert.equal(done.details.coreSaved, true);
  assert.equal(done.details.sceneSaved, false);
  assert.equal(done.details.changedRows, 2);
  const errors = r.rows().filter(e => e.code === 'REQUEST_ISSUE');
  assert.equal(errors.length, 2, 'receipt and top-level issue duplicates must not duplicate the issue list');
  assert.equal(errors[0].details.schemaPath, '$.maps[*].frame_json');
  assert.equal(errors[0].details.mapRef, atlasRefFingerprint('private-map-id'));
  assert.equal(r.sink.exportSafe().includes('private-map-id'), false);
});

test('only polling logs fold; errors and real model sends remain individually countable', () => {
  const r = recorder();
  const poll = { level: 'info', source: 'engine', code: 'API_CALL_COMPLETE', operation: 'api', phase: 'response', outcome: 'success', chatFingerprint: atlasRefFingerprint('A'), details: { route: '/sql/chat/state' } };
  r.emit(poll); r.emit(poll);
  assert.equal(r.rows()[0].count, 2);
  r.emit({ ...poll, chatFingerprint: atlasRefFingerprint('B') });
  assert.equal(r.rows().length, 2, 'polling in different chats must not fold together');
  const error = { ...poll, level: 'error', code: 'API_CALL_FAILED', outcome: 'failed' };
  r.emit(error); r.emit(error);
  assert.equal(r.rows().filter(e => e.code === 'API_CALL_FAILED').length, 2);
  r.emit({ ...poll, source: 'model', code: 'MODEL_REQUEST_STARTED' });
  r.emit({ ...poll, source: 'model', code: 'MODEL_REQUEST_STARTED' });
  assert.equal(r.rows().filter(e => e.code === 'MODEL_REQUEST_STARTED').length, 2);
});

test('SQL model and host commit derive the same turn reference and export phase, batch and unlimited output budget', async () => {
  const r = recorder(); const settings = { ...createDefaultSettingsV2(), activeApiPresetId: 'test', apiPresets: [{ ...preset, id: 'test', updatedAt: 1, temperature: 0.4 }] };
  const port = createSqlModelPort({ readSettings: async () => settings, fetchFn: async () => success(), onDiagnostic: r.emit });
  const request = buildStagePrompt({ phase: 'geography', userSource: '', assistantSource: '' });
  request.anchor = { ...anchor, parentTurnId: null, inputHash: 'private-input-hash' };
  await port.request(request);
  const first = r.rows().find(e => e.code === 'MODEL_REQUEST_STARTED');
  const uiScope = atlasDiagnosticContext({ chatId: anchor.chatUid, branchId: anchor.branchId, assistantMessageId: anchor.hostMessageUid });
  assert.equal(first.details.turnRef, uiScope.details.turnRef);
  assert.equal(first.details.stage, 'geography');
  assert.equal(first.details.phase, 'geography');
  assert.equal(first.details.batchRef, atlasRefFingerprint(request.batchId));
  assert.equal(first.details.maxTokens, 0);
  request.phase='repair';request.repairOfBatchId='previous-batch';
  await port.request(request);
  assert.equal(r.rows().filter(e=>e.code==='MODEL_REQUEST_STARTED').at(-1).details.retryKind,'repair');
  const exported = referenceDiagnostics(r.rows()).map(JSON.stringify).join('\n').split('\n').map(JSON.parse);
  assert.equal(exported[0].buildId, metadata.buildId);
  assert.equal(exported[0].requestRef, first.requestRef);
  assert.equal(exported[0].details.turnRef, first.details.turnRef);
  assert.ok(exported.every(e => Number.isFinite(Date.parse(e.at))));
  assert.equal(JSON.stringify(exported).includes(anchor.chatUid), false);
});

test('legacy UI-only error has an explicit observation timestamp rather than an empty or invented event time', () => {
  const row = referenceDiagnostics([{ t: '', level: 'error', code: 'WORLD_ACTION_FAILED', message: '推演超时' }])[0];
  assert.equal(row.timestampSource, 'observed');
  assert.ok(Number.isFinite(Date.parse(row.at)));
  assert.equal(row.t, row.at);
});

test('database and UI error export redacts echoed secrets without stripping build or correlation hashes', () => {
  const [row]=referenceDiagnostics([{...metadata,at:Infinity,code:'WORLD_ACTION_FAILED',level:'error',
    message:`request ${preset.endpoint} Authorization: Bearer abcdefghijk ${preset.apiKey}`,
    details:{apiKey:'private-unprefixed-key',requestHeaders:'private-header',branchRef:atlasRefFingerprint('branch')}}]);
  const exported=JSON.stringify(row);
  for(const secret of [preset.endpoint,preset.apiKey,'abcdefghijk','private-unprefixed-key','private-header'])assert.equal(exported.includes(secret),false);
  assert.equal(row.buildCommit,metadata.buildCommit);
  assert.ok(row.details.branchRef);
  assert.ok(Number.isFinite(Date.parse(row.at)));
});

test('construction requests with incomplete business anchors inherit only the operation-local diagnostic identity', async () => {
  const r=recorder(),settings={...createDefaultSettingsV2(),activeApiPresetId:'test',apiPresets:[{...preset,id:'test',updatedAt:1,temperature:0.4}]};
  const port=createSqlModelPort({readSettings:async()=>settings,fetchFn:async()=>success(),onDiagnostic:r.emit});
  const request=buildStagePrompt({phase:'geography',userSource:'',assistantSource:''});
  const original=structuredClone(request.anchor);
  await port.withBudget(createGenerationBudget({diagnosticAnchor:anchor}),'world-build').request(request);
  const event=r.rows().find(e=>e.code==='MODEL_REQUEST_STARTED');
  assert.equal(event.details.turnRef,atlasDiagnosticContext(anchor).details.turnRef);
  assert.equal(event.details.stage,'world-build');
  assert.deepEqual(request.anchor,original,'diagnostics do not rewrite business identity or provider input');
});

test('all issue details survive observer failures without interrupting business code', () => {
  assert.doesNotThrow(() => emitAtlasIssueDiagnostics(() => { throw Error('storage full'); }, {
    level: 'error', source: 'map', code: 'LAYOUT_FAILED', operation: 'layout', phase: 'commit', outcome: 'failed',
  }, [{ code: 'INVALID_PAYLOAD', path: '$.layout', severity: 'error' } ]));
});
