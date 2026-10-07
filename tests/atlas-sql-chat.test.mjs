import test from 'node:test';
import assert from 'node:assert/strict';
import { createAtlasUiCore } from '../src/atlas-ui-core.ts';
import { createAtlasServerCore } from './legacy/atlas-server-fixture.ts';
import { createBrowserSqlHost } from '../src/atlas-browser-sql-host.ts';
import { loadAtlasSqlRuntime } from '../src/atlas-sql-session.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';

const room = '{"op":"location.upsert","ref":"new:library","data":{"name":"图书馆","kind":"room"}}';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('普通酒馆楼层自动生成真实车厢房间和陈设，保存后重开仍有几何且不移动父地图位置',async()=>{
 const f=fixture({model:async req=>{
  if(req.phase==='geography'){
   const scopes=JSON.parse(req.messages[1].content.split('\n').find(l=>l.startsWith('本图：')).slice(3));
   return scopes.map(s=>JSON.stringify({op:'map.layout.request',ref:s.map,data:{kind:'floor',spec:{width:12,height:8,rooms:[{id:s.container.ref,name:'车厢',w:10,h:6,side:'north'}],contents:[{id:'bench',name:'软垫长椅',roomId:s.container.ref,type:'bench',w:2,h:.7},{id:'cabinet',name:'木柜',roomId:s.container.ref,type:'shelf',w:1,h:.5}]}}})).join('\n');
  }
  return '{"op":"location.upsert","ref":"new:cabin","data":{"name":"车厢","kind":"room"}}\n{"op":"character.upsert","ref":"new:player","data":{"name":"用户主角","identity":"乘客","role":"protagonist","location_ref":"new:cabin"}}';
 }});
 try{
  await f.ui.refresh();await f.prepare();await f.end();
  const s=await f.provider.session('chat-auto'),map=queryBound(s.repo.db,"SELECT * FROM maps WHERE container_location_id IS NOT NULL",[])[0];
  const scene=JSON.parse(map.frame_json).atlasScene;
  assert.ok(scene,JSON.stringify(f.ui.getState().receipts[0]));assert.equal(scene.layout.rooms.length,1);
  assert.equal(scene.layout.groups.length,2);assert.equal(scene.layout.actors.length,1);assert.equal(scene.layout.corridor.h,0);
  assert.equal(queryBound(s.repo.db,'SELECT map_id FROM locations WHERE id=?',[map.container_location_id])[0].map_id===map.id,false);
  f.restartUi();await f.ui.refresh();
  const read=await f.server.handle('POST','/sql/chat/ui-read',{chatUid:'chat-auto',kind:'scene',viewMode:'author'},{local:true});
  assert.ok(read.body.data.items.some(x=>x.mapId===map.id));
  assert.equal(f.calls(),2);assert.equal(f.saves(),1);
 }finally{await f.close();}
});
test('空短引用目录的补交显示同批已保存人物的稳定 ID，关系可引用且不重建人物',async()=>{
 let repairs=0;
 const f=fixture({model:async req=>{
  if(req.phase!=='repair')return '{"op":"character.upsert","ref":"new:mentor","data":{"name":"老师","identity":"导师"}}\n{"op":"character.upsert","ref":"new:pupil","data":{"name":"学生","identity":"学徒"}}\n{"op":"relation.upsert","data":{},"why":"老师是学生的导师"}';
  if(++repairs===1)return '{"ticket":"R1","op":"noop","why":"等待补交"}';
  const text=req.messages.map(m=>m.content).join('\n');
  const mentor=text.match(/(chr_[a-z0-9]+)=老师（character）/),pupil=text.match(/(chr_[a-z0-9]+)=学生（character）/);
  assert.ok(mentor,text);assert.ok(pupil,text);
  return JSON.stringify({ticket:'R1',op:'relation.upsert',data:{subject_ref:mentor[1],object_ref:pupil[1],label:'导师'}});
 }});
 try{await f.ui.refresh();await f.prepare();await f.end();await f.ui.retryLastCommit();
  assert.equal(f.ui.getState().receipts[0].detail.receipt.status,'committed',f.ui.getState().lastError??'');
  const s=await f.provider.session('chat-auto');assert.equal(queryBound(s.repo.db,'SELECT COUNT(*) n FROM characters',[])[0].n,2);
  assert.equal(queryBound(s.repo.db,'SELECT COUNT(*) n FROM relations',[])[0].n,1);
 }finally{await f.close();}
});
test('部分补交替换失败操作的旧诊断，保留成功组且不重复累计失败组',async()=>{
 let repairs=0;
 const f=fixture({model:async req=>{
  if(req.phase!=='repair')return '{"op":"event.propose","data":{"title":"进入图书馆","phase":"observed"}}\n{"op":"location.upsert","ref":"L1","data":{"name":"图书馆","kind":"building"}}\n{"op":"character.upsert","ref":"C1","data":{"name":"用户主角","role":"protagonist"}}';
  repairs++;
  const tickets=req.messages.map(m=>m.content).join('\n').split('\n').filter(l=>l.startsWith('{"ticket"')&&l.includes('originalOpId=')).map(l=>JSON.parse(l.split(' ｜')[0]));
  if(repairs===1)return tickets.map(t=>JSON.stringify({ticket:t.ticket,op:'noop',why:'等待补交'})).join('\n');
  return tickets.map(t=>JSON.stringify({...t,ref:t.ref.startsWith('new:')?t.ref:'new:'+t.ref,data:{...t.data,...(repairs>=3&&t.op==='character.upsert'?{identity:'读者'}:{})}})).join('\n');
 }});
 try{
  await f.ui.refresh();await f.prepare();await f.end();await f.ui.retryLastCommit();
  let r=f.ui.getState().receipts[0].detail.receipt;
  const failures=r.groups.filter(g=>g.status==='rejected'||g.status==='blocked');
  assert.equal(failures.length,1);assert.equal(failures[0].issues[0].code,'MINIMUM_FIELD_MISSING');
  assert.equal(new Set(r.groups.map(g=>g.groupId)).size,r.groups.length);
  assert.ok(!r.issues.some(i=>i.code==='REF_UNKNOWN'));
  await f.ui.retryLastCommit();r=f.ui.getState().receipts[0].detail.receipt;assert.equal(r.status,'committed',JSON.stringify({r,repairs,error:f.ui.getState().lastError}));
  assert.equal(new Set(r.groups.map(g=>g.groupId)).size,r.groups.length);
  const s=await f.provider.session('chat-auto');assert.equal(queryBound(s.repo.db,'SELECT COUNT(*) n FROM events',[])[0].n,1);
  assert.equal(queryBound(s.repo.db,'SELECT COUNT(*) n FROM characters',[])[0].n,1);
 }finally{await f.close();}
});
function fixture({ response = room, model, identity, retryFloor, lore = '全部世界书原文：文风规则与地点。' } = {}) {
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
  const makeUi = () => createAtlasUiCore({ host, emitter: { on() {}, off() {} }, sqlEnabled: () => enabled,
    api: { request: async (method, path, body) => { requests.push({ method, path, body }); return server.handle(method, path, body, { local: true }); } },
    adaptEvent: (_event, payload) => payload ?? null, endedDebounceMs: 0, mutationDebounceMs: 0,
    getPlayerName: () => '用户主角', getLoreSupplement: async () => lore,
    getCommitIdentity: identity ? () => identity : undefined,
    resolveRetryFloor: retryFloor,
    getCommitContext: async () => ({ charDescription: '角色卡设定', personaDescription: '用户人设', recentAssistantTexts: ['开场白'] }),
    ensureWorld: async () => { throw Error('Must not build an old world'); },
    syncProtagonistIdentity: async () => { throw Error('Must not write old characters'); },
    getOpeningMessage: async () => { throw Error('Must not bootstrap old tables'); },
    onLorebookSync: async () => { throw Error('Must not project the old worldbook'); },
  });
  let ui=makeUi();
  async function prepare(id = '0') { await ui.handleEvent('MESSAGE_SENT', { kind: 'message-sent', messageId: id, userText: '走进图书馆' }); assert.ok(ui.getState().pendingTurn); }
  async function end(id = '1') { await ui.handleEvent('GENERATION_ENDED', { kind: 'generation-ended', assistantMessageId: id, assistantText: '你走进了图书馆。' }); await pause(5); await ui.handleEvent('FLUSH'); }
  async function mutate(kind = 'message-deleted', id = '1') { await ui.handleEvent('MESSAGE_DELETED', { kind, messageId: id }); await pause(5); await ui.handleEvent('FLUSH'); }
  return { get ui(){return ui;}, restartUi(){ui.dispose();ui=makeUi();}, server, provider, current, requests, batches, prepare, end, mutate,
    calls: () => calls, saves: () => saves, setSave: value => { saveOk = value; }, setEnabled: value => { enabled = value; },
    switchChat: () => { live = { ...current, chatUid: 'chat-other', chatMetadata: {} }; },
    async close() { ui.dispose(); await provider.close(); },
  };
}

test('原版 UI 只读入口：新聊天没有保存快照仍读取同一个内存库，零保存零模型调用',async()=>{const f=fixture();try{await f.ui.refresh();assert.equal(f.current.chatMetadata.atlas?.database,undefined);const result=await f.server.handle('POST','/sql/chat/ui-read',{chatUid:'chat-auto',kind:'map',viewMode:'author'},{local:true});assert.equal(result.status,200);assert.ok(Array.isArray(result.body.data.items));assert.equal(result.body.data.metadata.snapshotSaved,false);assert.equal(f.saves(),0);assert.equal(f.calls(),0);const bad=await f.server.handle('POST','/sql/chat/ui-read',{chatUid:'chat-auto',kind:'logs'},{local:true});assert.equal(bad.status,400);assert.equal(f.current.chatMetadata.atlas?.database,undefined);}finally{await f.close();}});
test('原版 UI 回执：模型失败在无快照时也形成有错误码的真实回执',async()=>{const f=fixture({model:async()=>{throw Object.assign(Error('连接未配置'),{code:'API_NOT_CONFIGURED',retryable:false});}});try{await f.ui.refresh();await f.prepare();await f.end();const r=f.ui.getState().receipts[0];assert.equal(r.status,'failed');assert.match(r.summary,/连接未配置/);assert.equal(r.detail.coreSaved,false);assert.equal(r.detail.httpStatus,500);assert.ok(r.detail.receipt||r.errorCode);assert.equal(f.current.chatMetadata.atlas?.database,undefined);const read=await f.server.handle('POST','/sql/chat/ui-read',{chatUid:'chat-auto',kind:'diagnostics',viewMode:'author'},{local:true});assert.equal(read.status,200);assert.equal(f.saves(),0);}finally{await f.close();}});
test('原版 UI 回执：成功提交保留原生分组与保存状态',async()=>{const f=fixture();try{await f.ui.refresh();await f.prepare();await f.end();const r=f.ui.getState().receipts[0];assert.equal(r.detail.coreSaved,true);assert.ok(r.detail.receipt.groups.length>0);assert.equal(r.detail.receipt.groups[0].status,'applied');assert.equal('anchor' in r.detail.receipt,false);}finally{await f.close();}});

test('首轮未知短编号的命名对象可定向修正声明，保存实际地点层级、人物位置和地图', async () => {
  const f = fixture({ model: async request => {
    if (request.phase !== 'repair') return [
      { op:'location.upsert', ref:'L1', data:{name:'验收城',kind:'city'} },
      { op:'location.upsert', ref:'L2', data:{name:'验收图书馆',kind:'building',parent_ref:'L1'} },
      { op:'character.upsert', ref:'C1', data:{name:'用户主角',identity:'读者',role:'protagonist',location_ref:'L2'} },
    ].map(op=>JSON.stringify(op)).join('\n');
    const tickets = request.messages.map(m=>m.content).join('\n').split('\n')
      .filter(line=>line.startsWith('{"ticket"')&&line.includes('originalOpId='))
      .map(line=>JSON.parse(line.split(' ｜')[0]));
    assert.equal(tickets.length,3);
    return tickets.map(op=>JSON.stringify({...op,ref:'new:'+op.ref,data:{...op.data,
      ...(op.data.parent_ref?{parent_ref:'new:'+op.data.parent_ref}:{}),
      ...(op.data.location_ref?{location_ref:'new:'+op.data.location_ref}:{})}})).join('\n');
  }});
  try {
    await f.ui.refresh(); await f.prepare(); await f.end();
    const receipt=f.ui.getState().receipts.at(-1);
    assert.equal(receipt.detail.coreSaved,true);
    assert.ok(receipt.detail.receipt.groups.every(group=>group.status==='applied'));
    const session=await f.provider.session('chat-auto');
    const locations=queryBound(session.repo.db,'SELECT id,name,parent_location_id,map_id FROM locations',[]);
    const city=locations.find(row=>row.name==='验收城'),library=locations.find(row=>row.name==='验收图书馆');
    assert.equal(locations.length,2); assert.equal(library.parent_location_id,city.id);
    assert.ok(library.map_id);
    assert.equal(queryBound(session.repo.db,'SELECT location_id FROM characters WHERE name=?',['用户主角'])[0].location_id,library.id);
    assert.ok(queryBound(session.repo.db,'SELECT id FROM maps',[]).length>=3);
    assert.ok(f.current.chatMetadata.atlas.database); assert.equal(f.saves(),1);
  } finally { await f.close(); }
});

test('刷新后恢复最新部分回合的补交入口，旧失败地点可补回而成功事件不重复', async () => {
  let repairCalls=0,allowFloor=true;
  const identity={messageUID:'stable-last-floor',variantKey:'content-original'};
  const f=fixture({identity,retryFloor:id=>allowFloor&&id==='1'?{userMessageId:'0',userText:'走进图书馆',assistantText:'你走进了图书馆。'}:null,
    model:async request=>request.phase==='repair'?(++repairCalls===1?'{"ticket":"R1","op":"noop","why":"暂时未完成"}':'{"ticket":"R1","op":"location.upsert","ref":"new:L1","data":{"name":"图书馆","kind":"building"}}'):
      '{"op":"location.upsert","ref":"L1","data":{"name":"图书馆","kind":"building"}}\n{"op":"event.propose","data":{"title":"进入图书馆","phase":"observed"}}'});
  try{
    await f.ui.refresh(); await f.prepare(); await f.end();
    const session=await f.provider.session('chat-auto'),head=session.repo.internal.currentHeadTurnId();
    assert.equal(queryBound(session.repo.db,'SELECT COUNT(*) n FROM locations',[])[0].n,0);
    assert.equal(queryBound(session.repo.db,'SELECT COUNT(*) n FROM events',[])[0].n,1);
    allowFloor=false; f.restartUi(); await f.ui.refresh(); assert.equal(f.ui.getState().retryableCommit,null);
    allowFloor=true;identity.variantKey='edited-content';f.restartUi();await f.ui.refresh();assert.equal(f.ui.getState().retryableCommit,null);
    identity.variantKey='content-original';f.restartUi();await f.ui.refresh();
    assert.ok(f.ui.getState().retryableCommit);assert.equal(f.calls(),2,'恢复入口零模型调用');
    await f.ui.retryLastCommit();
    assert.equal(f.ui.getState().retryableCommit,null,f.ui.getState().lastError??'');
    assert.equal(queryBound(session.repo.db,'SELECT COUNT(*) n FROM locations',[])[0].n,1);
    assert.equal(queryBound(session.repo.db,'SELECT COUNT(*) n FROM maps',[])[0].n,2);
    assert.equal(queryBound(session.repo.db,'SELECT COUNT(*) n FROM events',[])[0].n,1);
    assert.equal(session.repo.internal.currentHeadTurnId(),head);assert.equal(f.calls(),3);
  }finally{await f.close();}
});

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
