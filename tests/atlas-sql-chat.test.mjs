import test from 'node:test';
import assert from 'node:assert/strict';
import { createAtlasUiCore } from '../src/atlas-ui-core.ts';
import { createAtlasServerCore } from '../src/atlas-server.ts';
import { createBrowserSqlHost } from '../src/atlas-browser-sql-host.ts';
import { loadAtlasSqlRuntime } from '../src/atlas-sql-session.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';

const room = '{"op":"location.upsert","ref":"new:library","data":{"name":"图书馆","kind":"room"}}';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture({ response = room, model, identity, lore = '全部世界书原文：文风规则与地点。' } = {}) {
  let enabled = true, saves = 0, calls = 0, saveOk = true;
  const requests = [], batches = [];
  const current = { chatUid: 'chat-auto', branchId: 'main', chatMetadata: {}, saveMetadata: async () => { saves++; return saveOk; } };
  let live = current;
  const provider = createBrowserSqlHost({ enabled: () => enabled, context: () => live, loadRuntime: loadAtlasSqlRuntime,
    modelPort: { request: async request => { calls++; batches.push(request); const generated = model ? await model(request) : null;
      return { batchId: request.batchId, text: typeof generated === 'string' ? generated : response, finishReason: 'stop', httpStatus: 200, durationMs: 1 }; } } });
  const server = createAtlasServerCore({ store: { read: async () => null, write: async () => {} }, sqlSessionProvider: provider });
  const host = { getChatId: () => live.chatUid, readPanelOpen: () => false, writePanelOpen() {},
    readBinding: () => { throw Error('SQL must not read or migrate the old session'); }, writeBinding: async b => { current.chatMetadata.atlas.sqlChatEnabled = b.enabled; },
    readData: () => null, writeData() {}, fillInput() {} };
  const ui = createAtlasUiCore({ host, emitter: { on() {}, off() {} }, sqlEnabled: () => enabled,
    api: { request: async (method, path, body) => { requests.push({ method, path, body }); return server.handle(method, path, body, { local: true }); } },
    adaptEvent: (_event, payload) => payload ?? null, endedDebounceMs: 0, mutationDebounceMs: 0,
    getPlayerName: () => '用户主角', getLoreSupplement: async () => lore,
    getCommitIdentity: identity ? () => identity : undefined,
    getCommitContext: async () => ({ charDescription: '角色卡设定', personaDescription: '用户人设', recentAssistantTexts: ['开场白'] }),
    ensureWorld: async () => { throw Error('Must not build an old world'); },
    syncProtagonistIdentity: async () => { throw Error('Must not write old characters'); },
    getOpeningMessage: async () => { throw Error('Must not bootstrap old tables'); },
    onLorebookSync: async () => { throw Error('Must not project the old worldbook'); },
  });
  async function prepare(id = '0') { await ui.handleEvent('MESSAGE_SENT', { kind: 'message-sent', messageId: id, userText: '走进图书馆' }); assert.ok(ui.getState().pendingTurn); }
  async function end(id = '1') { await ui.handleEvent('GENERATION_ENDED', { kind: 'generation-ended', assistantMessageId: id, assistantText: '你走进了图书馆。' }); await pause(5); await ui.handleEvent('FLUSH'); }
  async function mutate(kind = 'message-deleted', id = '1') { await ui.handleEvent('MESSAGE_DELETED', { kind, messageId: id }); await pause(5); await ui.handleEvent('FLUSH'); }
  return { ui, server, provider, current, requests, batches, prepare, end, mutate,
    calls: () => calls, saves: () => saves, setSave: value => { saveOk = value; }, setEnabled: value => { enabled = value; },
    switchChat: () => { live = { ...current, chatUid: 'chat-other', chatMetadata: {} }; },
    async close() { ui.dispose(); await provider.close(); },
  };
}

test('Q03 automatic events: prepare is read-only; completion writes one real SQL snapshot and no legacy world', async () => {
  const f = fixture();
  try {
    await f.ui.refresh(); await f.prepare();
    assert.equal(f.saves(), 0); assert.equal(f.calls(), 0); assert.deepEqual(f.current.chatMetadata, {});
    await f.end();
    assert.equal(f.calls(), 1); assert.equal(f.saves(), 1);
    assert.equal(f.ui.getState().receipts.at(-1).status, 'committed');
    assert.equal(f.ui.getState().binding.lastCommittedMessageId, '1');
    assert.deepEqual(Object.keys(f.current.chatMetadata.atlas), ['database']);
    assert.equal(f.requests.filter(r => r.method === 'POST').every(r => r.path.startsWith('/sql/')), true);
    const sources = f.batches[0].sourceSnapshot;
    assert.ok(sources.some(s => s.key === 'lore' && s.text.includes('文风规则与地点')));
    assert.deepEqual(JSON.parse(sources.find(s => s.key === 'player').text), { name: '用户主角', description: '用户人设' });
    const session = await f.provider.session('chat-auto');
    assert.equal(queryBound(session.repo.db, 'SELECT name FROM locations', [])[0].name, '图书馆');
    await f.ui.handleEvent('GENERATION_ENDED', { kind: 'generation-ended', assistantMessageId: '1', assistantText: '你走进了图书馆。' });
    await pause(5); await f.ui.handleEvent('FLUSH'); assert.equal(f.calls(), 1); assert.equal(f.saves(), 1);
  } finally { await f.close(); }
});

test('Q03 automatic save failure: UI reports failed; retry uses the original SQL request and confirms once', async () => {
  const f = fixture();
  try {
    f.setSave(false); await f.ui.refresh(); await f.prepare(); await f.end();
    assert.equal(f.ui.getState().receipts.at(-1).status, 'failed'); assert.ok(f.ui.getState().retryableCommit);
    const session = await f.provider.session('chat-auto');
    assert.equal(queryBound(session.repo.db, 'SELECT COUNT(*) AS n FROM locations', [])[0].n, 0);
    f.setSave(true); await f.ui.retryLastCommit();
    assert.equal(f.ui.getState().receipts.at(-1).status, 'committed'); assert.equal(f.ui.getState().retryableCommit, null);
    assert.equal(f.calls(), 2); assert.equal(f.saves(), 2);
    assert.equal(queryBound(session.repo.db, 'SELECT COUNT(*) AS n FROM locations', [])[0].n, 1);
  } finally { await f.close(); }
});

test('Q03 automatic delete: failed host save keeps the floor and world; confirmed rollback removes both', async () => {
  const f = fixture();
  try {
    await f.ui.refresh(); await f.prepare(); await f.end(); f.setSave(false); await f.mutate();
    assert.equal(f.ui.getState().binding.lastCommittedMessageId, '1'); assert.ok(f.ui.getState().lastError);
    f.setSave(true); await f.mutate();
    const session = await f.provider.session('chat-auto');
    assert.equal(queryBound(session.repo.db, 'SELECT COUNT(*) AS n FROM locations', [])[0].n, 0);
    assert.equal(f.ui.getState().binding.lastCommittedMessageId, null);
    await f.prepare(); await f.end(); assert.equal(f.calls(), 2);
    assert.equal(queryBound(session.repo.db, 'SELECT COUNT(*) AS n FROM locations', [])[0].n, 1);
  } finally { await f.close(); }
});

for (const change of ['stop', 'edit', 'chat', 'mode']) test(`Q03 late model result after ${change}: no candidate is saved`, async () => {
  let release, started;
  const gate = new Promise(resolve => { started = resolve; });
  const f = fixture({ model: async () => { started(); await new Promise(resolve => { release = resolve; }); } });
  try {
    await f.ui.refresh(); await f.prepare();
    const finishing = f.end(); await gate;
    if (change === 'stop') void f.ui.handleEvent('GENERATION_STOPPED', { kind: 'generation-stopped' });
    if (change === 'edit') void f.ui.handleEvent('MESSAGE_EDITED', { kind: 'message-edited', messageId: '1' });
    if (change === 'chat') f.switchChat();
    if (change === 'mode') f.setEnabled(false);
    release(); await finishing;
    assert.equal(f.saves(), 0); assert.equal(f.current.chatMetadata.atlas?.database, undefined);
  } finally { await f.close(); }
});

test('Q03 confirmed SQL noop is a valid UI receipt and does not appear as a failed request', async () => {
  const f = fixture({ response: '{"op":"noop"}' });
  try {
    await f.ui.refresh(); await f.prepare(); await f.end();
    assert.equal(f.ui.getState().receipts.at(-1).status, 'committed'); assert.equal(f.ui.getState().lastError, null);
    assert.equal(f.ui.getState().retryableCommit, null); assert.equal(f.saves(), 1);
  } finally { await f.close(); }
});

test('Q03 mode changed between prepare and prose completion cannot fall back to a legacy commit', async () => {
  const f = fixture();
  try {
    await f.ui.refresh(); await f.prepare(); f.setEnabled(false); await f.end();
    assert.equal(f.calls(), 0); assert.equal(f.saves(), 0);
    assert.equal(f.requests.some(r => r.path === '/turns/commit'), false);
    assert.ok(f.ui.getState().lastError.includes('存储模式'));
  } finally { await f.close(); }
});

test('Q08 formal UI migrates a valid old chat once and retains its original documents', async () => {
  const f = fixture(); f.current.chatMetadata.atlas = { world: { original: true }, tables: { locations: [], characters: [], items: [] } };
  try {
    const retained = JSON.stringify(f.current.chatMetadata.atlas); await f.ui.refresh();
    assert.ok(f.ui.getState().binding); assert.equal(f.ui.getState().lastError,null);
    await f.prepare(); assert.equal(f.calls(),0); assert.equal(f.saves(),1);
    const {database,...old}=f.current.chatMetadata.atlas; assert.ok(database);assert.equal(JSON.stringify(old),retained);
    await f.ui.refresh();assert.equal(f.saves(),1);
  } finally { await f.close(); }
});

test('Q03 failed SQL request cannot be retried through the legacy writer after a mode switch', async () => {
  const f = fixture();
  try {
    f.setSave(false); await f.ui.refresh(); await f.prepare(); await f.end();
    assert.ok(f.ui.getState().retryableCommit); f.setEnabled(false); await f.ui.retryLastCommit();
    assert.equal(f.requests.some(r => r.path === '/turns/retry'), false); assert.equal(f.calls(), 1);
    assert.equal(f.ui.getState().retryableCommit, null); assert.ok(f.ui.getState().lastError.includes('存储模式'));
  } finally { await f.close(); }
});

test('Q03 manual advance requests the SQL model and preserves the narrative floor locator', async () => {
  const f = fixture();
  try {
    await f.ui.refresh(); await f.ui.manualAdvance();
    assert.equal(f.calls(), 1); assert.equal(f.saves(), 1);
    assert.equal(f.ui.getState().receipts[0].status, 'committed'); assert.equal(f.ui.getState().binding.lastCommittedMessageId, null);
    const session = await f.provider.session('chat-auto');
    assert.equal(queryBound(session.repo.db, "SELECT COUNT(*) AS n FROM turns WHERE kind='manual'", [])[0].n, 1);
  } finally { await f.close(); }
});

test('Q03 SQL enable/disable and unbind preserve the database and avoid legacy binding routes', async () => {
  const f = fixture();
  try {
    await f.ui.refresh(); await f.prepare(); await f.end();
    const snapshot = f.current.chatMetadata.atlas.database;
    await f.ui.setEnabled(false); assert.equal(f.ui.getState().binding.enabled, false);
    await f.ui.setEnabled(true); assert.equal(f.ui.getState().binding.enabled, true);
    await f.ui.unbind(); assert.equal(f.ui.getState().binding.enabled, false);
    assert.equal(f.current.chatMetadata.atlas.database, snapshot);
    assert.equal(f.requests.some(r => r.path === '/bindings'), false);
  } finally { await f.close(); }
});

test('Q03 SQL stores the stable floor identity; UI locator and rollback still use the displayed floor', async () => {
  const f = fixture({ identity: { messageUID: 'stable-floor-uid', variantKey: 'swipe-2-content' } });
  try {
    await f.ui.refresh(); await f.prepare(); await f.end();
    const session = await f.provider.session('chat-auto');
    const row = queryBound(session.repo.db, "SELECT host_message_uid, host_variant_key, decisions_json FROM turns WHERE kind='narrative'", [])[0];
    assert.equal(row.host_message_uid, 'stable-floor-uid'); assert.equal(row.host_variant_key, 'swipe-2-content');
    assert.equal(JSON.parse(row.decisions_json).host_message_index, '1');
    assert.equal(f.ui.getState().binding.lastCommittedMessageId, '1');
    await f.mutate(); assert.equal(f.ui.getState().binding.lastCommittedMessageId, null);
    assert.equal(queryBound(session.repo.db, 'SELECT COUNT(*) AS n FROM locations', [])[0].n, 0);
  } finally { await f.close(); }
});

test('Q03 partial UI retry repairs failed operations only; host failure and repeated retry do not repeat successful quantities', async () => {
  let repairs = 0;
  const f = fixture({ model: async request => {
    if (request.phase === 'repair') {
      repairs++;
      return repairs === 1 ? '{"ticket":"R1","op":"noop","why":"暂时无法修复"}'
        : '{"ticket":"R1","op":"location.upsert","ref":"new:room","data":{"name":"补交教室","kind":"room"}}';
    }
    return '{"op":"item.upsert","ref":"new:pen","data":{"name":"水笔","quantity":5}}\n{"op":"location.upsert","ref":"new:room","data":{"name":"补交教室","kind":"invalid-kind"}}';
  } });
  try {
    await f.ui.refresh(); await f.prepare(); await f.end();
    const session = await f.provider.session('chat-auto');
    assert.equal(f.ui.getState().receipts[0].status, 'committed'); assert.ok(f.ui.getState().retryableCommit);
    const head = session.repo.internal.currentHeadTurnId(), revision = session.repo.internal.currentRevision();
    const quantity = () => queryBound(session.repo.db, 'SELECT quantity FROM items', [])[0].quantity;
    assert.equal(quantity(), 5);
    f.setSave(false); await f.ui.retryLastCommit(); assert.ok(f.ui.getState().retryableCommit);
    assert.equal(quantity(), 5); assert.equal(queryBound(session.repo.db, 'SELECT COUNT(*) AS n FROM locations', [])[0].n, 0);
    f.setSave(true); await f.ui.retryLastCommit();
    assert.equal(f.ui.getState().retryableCommit, null, f.ui.getState().lastError ?? '');
    assert.equal(quantity(), 5); assert.equal(queryBound(session.repo.db, 'SELECT COUNT(*) AS n FROM locations', [])[0].n, 1);
    assert.equal(session.repo.internal.currentHeadTurnId(), head); assert.equal(session.repo.internal.currentRevision(), revision);
    assert.equal(session.repo.internal.currentClock(), 0);
    await f.ui.retryLastCommit(); assert.equal(f.calls(), 4);
    await f.mutate(); assert.equal(queryBound(session.repo.db, 'SELECT COUNT(*) AS n FROM items', [])[0].n, 0);
    assert.equal(queryBound(session.repo.db, 'SELECT COUNT(*) AS n FROM locations', [])[0].n, 0);
  } finally { await f.close(); }
});

test('Q03 deleting an earlier SQL floor restores its maps and all dependent later turns',async()=>{
 const f=fixture({model:async req=>req.anchor.hostMessageUid.includes('3')?'{"op":"location.upsert","ref":"new:later","data":{"name":"后续地点","kind":"room"}}':room});
 try{
  await f.ui.refresh();await f.prepare('0');await f.end('1');await f.prepare('2');await f.end('3');
  const s=await f.provider.session('chat-auto');assert.equal(f.ui.getState().binding.lastCommittedMessageId,'3');
  assert.equal(queryBound(s.repo.db,"SELECT COUNT(*) n FROM turns WHERE kind='narrative' AND status='committed'",[])[0].n,2);
  await f.mutate('message-deleted','1');
  assert.equal(queryBound(s.repo.db,'SELECT COUNT(*) n FROM locations',[])[0].n,0);assert.equal(queryBound(s.repo.db,'SELECT COUNT(*) n FROM maps',[])[0].n,0);
  assert.equal(queryBound(s.repo.db,"SELECT COUNT(*) n FROM turns WHERE kind='narrative' AND status IN ('committed','partial')",[])[0].n,0);
  assert.equal(f.ui.getState().binding.lastCommittedMessageId,null);
 }finally{await f.close();}
});
