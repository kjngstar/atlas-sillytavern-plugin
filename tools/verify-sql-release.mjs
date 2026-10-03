// Standalone release asset test. Serves only built files; no SillyTavern or model requests.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = resolve(root, 'release/atlas-ui-extension');
const requests = [];
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  requests.push(pathname);
  if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Atlas SQL release verification</title>'); return; }
  const file = resolve(release, `.${decodeURIComponent(pathname)}`);
  if (!file.startsWith(`${release}${sep}`) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', extname(file) === '.wasm' ? 'application/wasm' : 'text/javascript');
  res.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.ATLAS_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage();
  const outgoing = [];
  page.on('request', req => outgoing.push(req.url()));
  await page.goto(origin);
  const main = await page.evaluate(async () => {
    const mod = await import('/dist/atlas-sql.mjs');
    const metadata = {};
    let saves = 0;
    const session = await mod.openSqlSession({ chatUid: 'release_verification', chatMetadata: metadata,
      saveSession: async () => { saves++; return true; } });
    const tables = mod.userTableNames(session.repo.db);
    const fk = mod.queryBound(session.repo.db, 'PRAGMA foreign_keys')[0].foreign_keys;
    const size = (await session.repo.exportCurrent()).length;
    await mod.closeSqlSession(session);
    return { tables: tables.length, fk, size, saves, metadataUnchanged: Object.keys(metadata).length === 0 };
  });
  assert.equal(main.tables, 20); assert.equal(main.fk, 1); assert.ok(main.size > 1000);
  assert.equal(main.saves, 0); assert.equal(main.metadataUnchanged, true);
  const worker = await page.evaluate(async () => {
    const worker = new Worker('/dist/atlas-sql-worker.js');
    const pending = new Map(); let seq = 0;
    worker.onmessage = event => {
      const row = event.data;
      const waiter = pending.get(row.requestId);
      if (!waiter) return;
      pending.delete(row.requestId);
      if (row.error) waiter.reject(Error(JSON.stringify(row.error))); else waiter.resolve(row.result);
    };
    const send = row => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(row.requestId); reject(Error('Worker SQL timeout')); }, 10000);
      pending.set(row.requestId, { resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); } });
      worker.postMessage(row);
    });
    try {
      await send({ type: 'init', requestId: 'init', options: { chatUid: 'release_worker' } });
      await send({ type: 'request', requestId: `r${++seq}`, method: 'open', payload: {} });
      const exported = await send({ type: 'request', requestId: `r${++seq}`, method: 'export', payload: {} });
      await send({ type: 'request', requestId: `r${++seq}`, method: 'close', payload: {} });
      return { bytes: exported.byteLength, header: atob(exported.base64).slice(0, 15) };
    } finally { worker.terminate(); }
  });
  assert.ok(worker.bytes > 1000); assert.equal(worker.header, 'SQLite format 3');
  assert.ok(requests.filter(path => path === '/dist/vendor/sql-wasm.wasm').length >= 2);
  assert.equal(requests.some(path => path.includes('sql-wasm-browser.wasm')), false);
  assert.ok(outgoing.every(url => url.startsWith(origin)));
  const startupPage = await browser.newPage();
  const startupRequests = [];
  startupPage.on('request', req => startupRequests.push(req.url()));
  await startupPage.goto(origin);
  const off = await startupPage.evaluate(async () => {
    let saves = 0;
    const host = { chatId: 'release-startup', chatMetadata: {}, extensionSettings: {}, chat: [],
      saveMetadata: async () => { saves++; return true; }, saveSettingsDebounced() {},
      getRequestHeaders: () => ({}), eventSource: { on() {}, off() {}, removeListener() {} }, event_types: {} };
    window.SillyTavern = { getContext: () => host };
    window.releaseStartupHost = host;
    window.releaseStartupSaves = () => saves;
    const ext = await import('/index.js');
    const mounted = await ext.connectAtlas();
    if (!mounted) throw Error('Real release startup failed');
    window.releaseStartup = mounted;
    const result = await mounted.api.request('POST', '/sql/state', { chatUid: host.chatId });
    return result.body.data;
  });
  assert.equal(off.sqlMode, false);
  assert.equal(startupRequests.some(url => /atlas-sql|\.wasm/.test(url)), false, 'SQL off startup must not load SQL');
  const started = await startupPage.evaluate(async () => {
    const host = window.releaseStartupHost;
    host.extensionSettings.atlas_world_sim = { sqlMode: true };
    const api = window.releaseStartup.api;
    const state = await api.request('POST', '/sql/state', { chatUid: host.chatId, branchId: 'main', query: { kind: 'map' } });
    if (!state.body.ok) throw Error(JSON.stringify(state.body));
    const turn = await api.request('POST', '/sql/turn', { chatUid: host.chatId, branchId: 'main', hostMessageUid: 'release-floor',
      variantKey: 'v0', inputHash: 'release-first-turn', manual: true,
      operations: [{ op: 'location.upsert', ref: 'new:release_room', data: { name: '发布启动验收房间', kind: 'room' } }] });
    return { state: state.body.data, turn: turn.body.data, saves: window.releaseStartupSaves(),
      stored: Boolean(host.chatMetadata.atlas?.database?.data) };
  });
  assert.equal(started.turn.coreSaved, true, JSON.stringify(started.turn));
  assert.equal(started.saves, 1); assert.equal(started.stored, true);
  const modelTurn = await startupPage.evaluate(async () => {
    const api = window.releaseStartup.api, host = window.releaseStartupHost;
    let calls = 0, prompts = [];
    // Synthetic host generation avoids a real provider call. Initialization,
    // connection dispatch, published JS, SQLite and WASM remain real.
    window.TavernHelper = { generateRaw: async input => {
      calls++; prompts = input.ordered_prompts;
      return '{"op":"location.upsert","ref":"new:generated_library","data":{"name":"发布模型接线图书馆","kind":"building"}}';
    } };
    const saved = await api.request('PUT', '/settings', { action: 'api.save', apiKeyMode: 'replace', apiKey: '',
      preset: { name: '发布主 API 验收', connectionMode: 'main', endpoint: '', model: 'host',
        maxTokens: 6000, temperature: 0.4, topP: 0.95, timeoutMs: 30000 } });
    if (!saved.body.ok) throw Error(JSON.stringify(saved.body));
    const id = saved.body.data.apiPresets[0].id;
    const active = await api.request('PUT', '/settings', { action: 'api.activate', id });
    if (!active.body.ok) throw Error(JSON.stringify(active.body));
    const body = { chatUid: host.chatId, branchId: 'main', hostMessageUid: 'release-model-floor',
      variantKey: 'v0', inputHash: 'release-model-turn', userText: '进入图书馆', assistantText: '你已经进入图书馆。',
      sourceSnapshot: [{ key: 'msg:a', text: '你已经进入图书馆。', kind: 'story', hash: 'fixture-story' }] };
    const turn = await api.request('POST', '/sql/turn', body);
    const repeated = await api.request('POST', '/sql/turn', body);
    return { coreSaved: turn.body.data?.coreSaved, duplicate: repeated.body.data?.duplicate,
      calls, saves: window.releaseStartupSaves(), tableWritten: Boolean(host.chatMetadata.atlas?.tables),
      mixedFormat: prompts.some(p => String(p.content).includes('<atlasEdit>')) };
  });
  assert.equal(modelTurn.coreSaved, true); assert.equal(modelTurn.duplicate, true);
  assert.equal(modelTurn.calls, 1); assert.equal(modelTurn.saves, 2);
  assert.equal(modelTurn.tableWritten, false); assert.equal(modelTurn.mixedFormat, false);
  const automaticChat = await startupPage.evaluate(async () => {
    const { core } = window.releaseStartup, host = window.releaseStartupHost;
    let calls = 0;
    window.TavernHelper.generateRaw = async () => {
      calls++;
      return '{"op":"location.upsert","ref":"new:auto_archive","data":{"name":"自动聊天档案室","kind":"room"}}';
    };
    host.name1 = '发布用户主角';
    host.chat.push({ is_user: true, mes: '进入档案室', send_date: 'release-user-1' });
    await core.refresh();
    const before = window.releaseStartupSaves();
    await core.handleEvent('MESSAGE_SENT', 0);
    const prepared = Boolean(core.getState().pendingTurn);
    const prepareSaves = window.releaseStartupSaves() - before;
    host.chat.push({ is_user: false, mes: '你走进档案室。', send_date: 'release-assistant-1' });
    await core.handleEvent('GENERATION_ENDED', 1);
    for (let n = 0; n < 150 && core.getState().pendingTurn; n++) await new Promise(resolve => setTimeout(resolve, 20));
    const committed = core.getState();
    if (committed.pendingTurn) throw Error('Published automatic completion timed out');
    const commitSaves = window.releaseStartupSaves() - before;
    // Use the actual published event adapter after the host removes the floor.
    host.chat.splice(1, 1);
    await core.handleEvent('MESSAGE_DELETED', 1);
    for (let n = 0; n < 150 && core.getState().binding?.lastCommittedMessageId === '1'; n++) await new Promise(resolve => setTimeout(resolve, 20));
    const rolledBack = core.getState();
    return { prepared, prepareSaves, commitSaves, calls,
      commitStatus: committed.receipts[0]?.status, floor: committed.binding?.lastCommittedMessageId,
      rollbackFloor: rolledBack.binding?.lastCommittedMessageId,
      rollbackSaves: window.releaseStartupSaves() - before - commitSaves,
      tableWritten: Boolean(host.chatMetadata.atlas?.tables), error: rolledBack.lastError };
  });
  assert.equal(automaticChat.prepared, true, JSON.stringify(automaticChat));
  assert.equal(automaticChat.prepareSaves, 0); assert.equal(automaticChat.commitSaves, 1);
  assert.equal(automaticChat.calls, 1); assert.equal(automaticChat.commitStatus, 'committed');
  assert.equal(automaticChat.floor, '1'); assert.notEqual(automaticChat.rollbackFloor, '1');
  assert.equal(automaticChat.rollbackSaves, 1); assert.equal(automaticChat.tableWritten, false);
  console.log(JSON.stringify({ passed: true, main, worker,
    startup: { offSqlMode: off.sqlMode, coreSaved: started.turn.coreSaved, saves: started.saves, stored: started.stored },
    modelTurn,
    automaticChat,
    wasmRequests: requests.filter(path => path.endsWith('.wasm')) }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
