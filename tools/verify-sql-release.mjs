// Standalone release asset test. Serves only built files; no SillyTavern or model requests.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginVersion=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8')).version;
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
    const tables = mod.userTableNames(session.repo.db).slice().sort();
    const fk = mod.queryBound(session.repo.db, 'PRAGMA foreign_keys')[0].foreign_keys;
    const size = (await session.repo.exportCurrent()).length;
    await mod.closeSqlSession(session);
    return { tables: tables.length, tableNames: tables,
      declaredTables: Object.keys(mod.ATLAS_TABLE_COLUMNS).slice().sort(),
      declaredTableCount: mod.USER_TABLE_COUNT, schemaVersion: mod.ATLAS_SCHEMA_VERSION,
      fk, size, saves, metadataUnchanged: Object.keys(metadata).length === 0 };
  });
  // 表数不写死魔数：与 schema 自己声明的清单**逐名**比对 —— 少建一张、或建出未声明的表都会红。
  assert.deepEqual(main.tableNames, main.declaredTables, 'release 建出的用户表必须与 schema 声明的清单逐名一致');
  assert.equal(main.tables, main.declaredTableCount, 'userTableNames 数量必须等于 schema 导出的 USER_TABLE_COUNT');
  assert.equal(main.schemaVersion, 3, '发布产物必须建出当前 schema 版本（改 schema 版本时同步本断言）');
  assert.equal(main.fk, 1); assert.ok(main.size > 1000);
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
    const host = { chatId: 'release-startup', chatMetadata: {}, extensionSettings: {atlas_world_sim:{sqlMode:false}}, chat: [],
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
  assert.equal(startupRequests.some(url => /\/dist\/atlas-sql(?:\.mjs|-worker\.js)|\.wasm/.test(url)), false, 'SQL off startup must not load SQL');
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
    const ext = await import('/index.js');
    const previousDiagnostics = new Set(ext.getAtlasSafeDiagnosticsSnapshot().map(entry => entry.id));
    let calls = 0, layoutCalls = 0, retryCalls = 0, layoutTargets=[],layoutKinds=[];
    // Real packaged path: observation + construction + shared evidence + one
    // mixed hierarchy layout request. Valid synthetic replies need no repair.
    window.TavernHelper.generateRaw = async input => {
      calls++;
      const text = (input?.ordered_prompts ?? []).map(part => String(part?.content ?? '')).join('\n');
      if (text.includes('你是 Atlas 空间证据摘录器')) return '{"facts":[]}';
      if (text.includes('本图：')) {
        layoutCalls++;
        const scopes=JSON.parse(text.split('\n').find(line=>line.startsWith('本图：')).slice(3));layoutTargets.push(scopes.length);layoutKinds.push(...scopes.map(s=>s.kind));
        return scopes.map(scope=>JSON.stringify({op:'map.layout.request',ref:scope.map,data:{kind:scope.kind,
          spec:scope.kind==='floor'?{rooms:scope.baselineRooms}:scope.kind==='city'?{
            districts:[{id:scope.container.ref,name:scope.container.name,bank:'west',order:0}],
            buildings:scope.locations.filter(l=>l.kind==='building').map(l=>({id:l.ref,name:l.name,districtId:scope.container.ref,
              w:scope.childSpaces.find(c=>c.ref===l.ref)?.w??24,h:scope.childSpaces.find(c=>c.ref===l.ref)?.h??24})),enclosure:'open',riverWidth:0
          }:{surface:'mixed',zones:scope.locations.filter(l=>l.kind!=='room').map(l=>({id:l.ref,name:l.name,role:l.kind==='city'?'city':'other',size:'medium'})),features:[],links:[]}}})).join('\n');
      }
      if (text.includes('【布局格式纠错】')) retryCalls++;
      return calls===1?[
        {op:'location.upsert',ref:'new:auto_city',data:{name:'发布验收城市',kind:'city'}},
        {op:'location.upsert',ref:'new:auto_archive_building',data:{name:'发布验收档案馆',kind:'building',parent_ref:'new:auto_city'}},
        {op:'location.upsert',ref:'new:auto_archive',data:{name:'自动聊天档案室',kind:'room',parent_ref:'new:auto_archive_building'}},
        {op:'character.upsert',ref:'new:auto_pov',data:{name:'发布用户主角',identity:'档案馆访客',role:'protagonist',location_ref:'new:auto_archive'}},
      ].map(JSON.stringify).join('\n'):'{"op":"noop"}';
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
    const diagnosticRows = ext.getAtlasSafeDiagnosticsSnapshot().filter(entry => !previousDiagnostics.has(entry.id));
    const modelStarts = diagnosticRows.filter(entry => entry.code === 'MODEL_REQUEST_STARTED');
    const commitLog = diagnosticRows.find(entry => ['API_CALL_COMPLETE','API_CALL_PARTIAL'].includes(entry.code) && entry.details?.route === '/sql/chat/commit');
    const uiLog = diagnosticRows.find(entry => entry.code === 'COMMIT_SUCCEEDED');
    return { prepared, prepareSaves, commitSaves, calls, layoutCalls, retryCalls,layoutTargets,requestPlan:committed.receipts[0]?.detail?.receipt?.requestPlan??null,layoutKinds,issues:committed.receipts[0]?.detail?.issues,workBatching:(await window.releaseStartup.api.request('GET','/settings')).body.data?.workBatching,
      diagnosticEvidence:{modelStarts,commitLog,uiLog},
      commitStatus: committed.receipts[0]?.status, floor: committed.binding?.lastCommittedMessageId,
      rollbackFloor: rolledBack.binding?.lastCommittedMessageId,
      rollbackSaves: window.releaseStartupSaves() - before - commitSaves,
      tableWritten: Boolean(host.chatMetadata.atlas?.tables), error: rolledBack.lastError };
  });
  assert.equal(automaticChat.prepared, true, JSON.stringify(automaticChat));
  assert.equal(automaticChat.prepareSaves, 0);
  // 多批模型请求（决策/建设/布局）仍然只允许**一次保存** —— 这是本段真正要守的不变量。
  assert.equal(automaticChat.commitSaves, 1, `多批请求必须只产生一次保存：${JSON.stringify(automaticChat)}`);
  assert.equal(automaticChat.calls, 4, JSON.stringify(automaticChat));
  assert.equal(automaticChat.layoutCalls, 1, '地图必须合并规划');
  assert.ok(automaticChat.layoutTargets[0]>=3, JSON.stringify(automaticChat));
  assert.deepEqual(new Set(automaticChat.layoutKinds),new Set(['overview','city','floor']));
  assert.equal(automaticChat.retryCalls, 0, JSON.stringify(automaticChat));
  assert.deepEqual(automaticChat.requestPlan?.usage,{normal:{observe:1,construction:1,evidence:1,maps:1},extra:0,transports:4});
  assert.equal(automaticChat.commitStatus, 'committed');
  assert.equal(automaticChat.floor, '1'); assert.notEqual(automaticChat.rollbackFloor, '1');
  assert.equal(automaticChat.rollbackSaves, 1); assert.equal(automaticChat.tableWritten, false);
  const evidence=automaticChat.diagnosticEvidence;
  assert.equal(evidence.modelStarts.length, automaticChat.calls, '真实模型发送逐次入日志，不以轮询折叠次数充数');
  assert.equal(new Set(evidence.modelStarts.map(entry=>entry.requestRef)).size,automaticChat.calls);
  assert.ok(evidence.modelStarts.every(entry=>entry.pluginVersion===pluginVersion&&/^build-[a-f0-9]{16}$/.test(entry.buildId)));
  assert.ok(evidence.commitLog,JSON.stringify(evidence));
  assert.equal(evidence.commitLog.details.coreSaved,true);
  assert.equal(evidence.commitLog.details.saveConfirmed,true);
  assert.equal(evidence.commitLog.details.modelRequests,automaticChat.calls);
  assert.ok(evidence.modelStarts.every(entry=>entry.details.turnRef===evidence.commitLog.details.turnRef),'提取、建设与布局请求属于同一回合');
  assert.equal(evidence.uiLog.details.turnRef,evidence.commitLog.details.turnRef,'界面与引擎按同一回合关联');
  const timeoutEvidence=await startupPage.evaluate(async()=>{
    const ext=await import('/index.js'),api=window.releaseStartup.api,host=window.releaseStartupHost;
    const before=new Set(ext.getAtlasSafeDiagnosticsSnapshot().map(entry=>entry.id));
    const current=(await api.request('GET','/settings')).body.data;
    const preset=current.apiPresets.find(p=>p.id===current.activeApiPresetId);
    const update=await api.request('PUT','/settings',{action:'api.save',apiKeyMode:'keep',preset:{...preset,timeoutMs:1000}});
    if(!update.body.ok)throw Error(JSON.stringify(update.body));
    let calls=0;window.TavernHelper.generateRaw=()=>{calls++;return new Promise(()=>{});};
    const saves=window.releaseStartupSaves();
    const response=await api.request('POST','/sql/turn',{chatUid:host.chatId,branchId:'main',hostMessageUid:'timeout-fixture',variantKey:'original',inputHash:'timeout-fixture',userText:'等候',assistantText:'你在原地等候。'});
    const rows=ext.getAtlasSafeDiagnosticsSnapshot().filter(entry=>!before.has(entry.id));
    return {status:response.status,calls,saves:window.releaseStartupSaves()-saves,
      failures:rows.filter(entry=>entry.code==='MODEL_REQUEST_FAILED'),engine:rows.find(entry=>entry.code==='API_CALL_FAILED'),
      starts:rows.filter(entry=>entry.code==='MODEL_REQUEST_STARTED').length};
  });
  assert.equal(timeoutEvidence.status,500);
  assert.equal(timeoutEvidence.saves,0,'模型超时没有产生保存');
  assert.equal(timeoutEvidence.calls,timeoutEvidence.starts);
  assert.equal(timeoutEvidence.failures[0].errorCode,'API_TIMEOUT');
  assert.equal(timeoutEvidence.failures[0].details.timeoutMs,1000);
  assert.equal(timeoutEvidence.failures[0].details.cancelledBy,'timeout');
  assert.equal(timeoutEvidence.engine.causeCode,'API_TIMEOUT');
  console.log(JSON.stringify({ passed: true, main, worker,
    startup: { offSqlMode: off.sqlMode, coreSaved: started.turn.coreSaved, saves: started.saves, stored: started.stored },
    modelTurn,
    automaticChat,
    timeoutEvidence,
    wasmRequests: requests.filter(path => path.endsWith('.wasm')) }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
