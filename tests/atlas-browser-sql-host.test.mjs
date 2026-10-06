import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserSqlHost } from '../src/atlas-browser-sql-host.ts';
import { createAtlasServerCore } from './legacy/atlas-server-fixture.ts';
import { loadAtlasSqlRuntime, persistSqlSession } from '../src/atlas-sql-session.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';

function hostFixture({ modelPort, loadRuntime = loadAtlasSqlRuntime } = {}) {
  let saves = 0;
  let saveHandler = async () => true;
  const host = { chatUid: 'browser-host-A', branchId: 'main', chatMetadata: {},
    saveMetadata: async () => { saves++; return saveHandler(); } };
  let live = host, enabled = true;
  const provider = createBrowserSqlHost({ enabled: () => enabled, context: () => live, loadRuntime, modelPort });
  const core = createAtlasServerCore({ store: { read: async () => null, write: async () => {} }, sqlSessionProvider: provider });
  return { host, provider, core, saves: () => saves, setSave: value => { saveHandler = value; }, setHost: value => { live = value; }, setEnabled: value => { enabled = value; } };
}
const turn = { chatUid: 'browser-host-A', branchId: 'main', hostMessageUid: 'm1', variantKey: 'v0', inputHash: 'test-one', manual: true,
  operations: [{ op: 'location.upsert', ref: 'new:room', data: { name: '宿主接线房间', kind: 'room' } }] };

test('Q01: disabled browser SQL host never loads runtime, including engine close', async () => {
  let loads = 0;
  const f = hostFixture({ loadRuntime: async () => { loads++; return loadAtlasSqlRuntime(); } });
  f.setEnabled(false);
  const response = await f.core.handle('POST', '/sql/turn', turn, { local: true });
  assert.equal(response.body.data.code, 'SQL_MODE_DISABLED');
  await f.provider.close();
  assert.equal(loads, 0); assert.equal(f.saves(), 0); assert.deepEqual(f.host.chatMetadata, {});
});

test('Q01: browser host creates its repository, saves once and reuses the confirmed snapshot', async () => {
  const f = hostFixture();
  try {
    const response = await f.core.handle('POST', '/sql/turn', turn, { local: true });
    assert.equal(response.body.data.coreSaved, true);
    assert.equal(f.saves(), 1); assert.ok(f.host.chatMetadata.atlas.database.data);
    const session = await f.provider.session('browser-host-A', 'main');
    assert.equal(session.repo.internal.currentRevision(), 1);
    assert.equal(await f.provider.session('browser-host-A', 'main'), session);
  } finally { await f.provider.close(); }
});

test('Q01: UI reads during asynchronous candidate save keep the pending repository alive', async () => {
  const f = hostFixture();
  try {
    const session = await f.provider.session(turn.chatUid);
    f.setSave(async () => {
      const readSession = await f.provider.session(turn.chatUid);
      assert.equal(readSession, session);
      assert.equal(session.closed, false);
      assert.equal(session.repo.internal.currentRevision(), 0, '保存确认前仍读取正式旧库');
      return true;
    });
    const response = await f.core.handle('POST', '/sql/turn', turn, { local: true });
    assert.equal(response.body.data.coreSaved, true);
    assert.equal(session.repo.internal.currentRevision(), 1);
    assert.equal(await f.provider.session(turn.chatUid), session);
    assert.equal(f.saves(), 1);
  } finally { await f.provider.close(); }
});

test('Q01: a host switch during lazy SQL opening rejects the old identity', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = hostFixture({ loadRuntime: async () => { await gate; return loadAtlasSqlRuntime(); } });
  const opening = f.provider.session('browser-host-A', 'main');
  f.setHost({ chatUid: 'browser-host-B', branchId: 'main', chatMetadata: {}, saveMetadata: async () => true });
  release();
  await assert.rejects(opening, error => error.code === 'CHAT_CHANGED');
  assert.deepEqual(f.host.chatMetadata, {}); assert.equal(f.saves(), 0);
  await f.provider.close();
});

test('Q08: corrupt legacy payload cannot be replaced by a new empty SQL database', async () => {
  const f = hostFixture(); f.host.chatMetadata.atlas = { tables: '损坏的旧三表' };
  const before = JSON.stringify(f.host.chatMetadata);
  await assert.rejects(f.provider.session('browser-host-A'), error => error.code === 'LEGACY_CORRUPT');
  assert.equal(JSON.stringify(f.host.chatMetadata), before); assert.equal(f.saves(), 0);
  await f.provider.close();
});

test('Q01: an external same-chat storage update during a model request cannot be overwritten', async () => {
  let release, markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const f = hostFixture({ modelPort: { request: async request => {
    markStarted(); await new Promise(resolve => { release = resolve; });
    return { batchId: request.batchId, text: '{"op":"noop"}', finishReason: 'stop', httpStatus: 200, durationMs: 1 };
  } } });
  try {
    await f.core.handle('POST', '/sql/turn', turn, { local: true });
    const request = f.core.handle('POST', '/sql/turn', { ...turn, hostMessageUid: 'm2', inputHash: 'test-two', manual: false, operations: undefined }, { local: true });
    await started;
    f.host.chatMetadata.atlas.database.storage_revision++;
    const external = JSON.stringify(f.host.chatMetadata);
    release();
    const response = await request;
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'SESSION_STALE');
    assert.equal(JSON.stringify(f.host.chatMetadata), external);
    assert.equal(f.saves(), 1, '只保存先前已确认回合，迟到模型请求不能再保存');
  } finally { release?.(); await f.provider.close(); }
});

test('Q03: external snapshot replacement while saving is preserved and never published', async () => {
  const f = hostFixture();
  try {
    await f.core.handle('POST', '/sql/turn', turn, { local: true });
    const session = await f.provider.session(turn.chatUid);
    const previous = structuredClone(f.host.chatMetadata.atlas.database);
    let external;
    f.setSave(async () => {
      external = { ...previous, storage_revision: previous.storage_revision + 9 };
      f.host.chatMetadata.atlas.database = external;
      f.host.chatMetadata.atlas.authorNote = '保存期间新增';
      return true;
    });
    const response = await f.core.handle('POST', '/sql/turn', { ...turn,
      hostMessageUid: 'm2', inputHash: 'save-race', operations: [{ op: 'location.upsert', ref: 'new:late', data: { name: '不应发布' } }] }, { local: true });
    assert.equal(response.body.data.coreSaved, false);
    assert.ok(response.body.data.issues.some(i => i.code === 'SESSION_STALE'));
    assert.equal(f.host.chatMetadata.atlas.database, external);
    assert.equal(f.host.chatMetadata.atlas.authorNote, '保存期间新增');
    assert.equal(session.repo.internal.currentRevision(), 1);
    assert.equal(session.repo.db.exec("SELECT name FROM locations WHERE name='不应发布'").length, 0);
  } finally { await f.provider.close(); }
});

test('Q03: failed saves restore only their database field and retain unrelated author edits', async () => {
  const f = hostFixture();
  try {
    await f.core.handle('POST', '/sql/turn', turn, { local: true });
    const previous = f.host.chatMetadata.atlas.database;
    f.setSave(async () => {
      f.host.chatMetadata.atlas.authorNote = '保留作者编辑';
      throw new Error('fixture host save failed');
    });
    const response = await f.core.handle('POST', '/sql/turn', { ...turn,
      hostMessageUid: 'm2', inputHash: 'save-failed', operations: [{ op: 'location.upsert', ref: 'new:failed_room', data: { name: '保存失败房间' } }] }, { local: true });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.coreSaved, false);
    assert.equal(f.host.chatMetadata.atlas.database, previous);
    assert.equal(f.host.chatMetadata.atlas.authorNote, '保留作者编辑');
  } finally { await f.provider.close(); }
});

test('Q03: maintenance persistence checks the live baseline before invoking the host save', async () => {
  const f = hostFixture();
  try {
    await f.core.handle('POST', '/sql/turn', turn, { local: true });
    const session = await f.provider.session(turn.chatUid);
    f.host.chatMetadata.atlas.database.storage_revision++;
    const before = JSON.stringify(f.host.chatMetadata);
    const result = await persistSqlSession(session);
    assert.equal(result.saved, false);
    assert.ok(result.issues.some(i => i.code === 'SESSION_STALE'));
    assert.equal(JSON.stringify(f.host.chatMetadata), before);
    assert.equal(f.saves(), 1);
  } finally { await f.provider.close(); }
});

test('Q03: concurrent and repeated completion events share one model request and one save', async () => {
  let release, markStarted, calls = 0;
  const started = new Promise(resolve => { markStarted = resolve; });
  const f = hostFixture({ modelPort: { request: async request => {
    calls++; markStarted(); await new Promise(resolve => { release = resolve; });
    return { batchId: request.batchId, text: '{"op":"location.upsert","ref":"new:room","data":{"name":"唯一房间"}}', finishReason: 'stop' };
  } } });
  try {
    const body = { ...turn, manual: false, operations: undefined };
    const first = f.core.handle('POST', '/sql/turn', body, { local: true });
    await started;
    const concurrent = f.core.handle('POST', '/sql/turn', body, { local: true });
    release();
    const responses = await Promise.all([first, concurrent]);
    assert.ok(responses.every(r => r.body.data.coreSaved));
    assert.equal(responses[1].body.data.duplicate, true);
    const repeated = await f.core.handle('POST', '/sql/turn', body, { local: true });
    assert.equal(repeated.body.data.duplicate, true);
    assert.equal(calls, 1); assert.equal(f.saves(), 1);
    const session = await f.provider.session(turn.chatUid);
    assert.equal(queryBound(session.repo.db, 'SELECT COUNT(*) AS n FROM locations', [])[0].n, 1);
  } finally { release?.(); await f.provider.close(); }
});

test('Q03: rollback permits regeneration of the same floor without colliding with its audit history', async () => {
  const f = hostFixture();
  try {
    const session = await f.provider.session(turn.chatUid);
    const baseline = session.repo.internal.currentHeadTurnId();
    const first = await f.core.handle('POST', '/sql/turn', turn, { local: true });
    const rollback = await f.core.handle('POST', '/sql/rollback', { chatUid: turn.chatUid, targetParentTurnId: baseline }, { local: true });
    assert.equal(rollback.body.data.coreSaved, true);
    assert.equal(queryBound(session.repo.db, 'SELECT COUNT(*) AS n FROM locations', [])[0].n, 0);
    const regenerated = await f.core.handle('POST', '/sql/turn', turn, { local: true });
    assert.equal(regenerated.status, 200, JSON.stringify(regenerated.body));
    assert.equal(regenerated.body.data.coreSaved, true);
    assert.notEqual(first.body.data.receipt.turnId, regenerated.body.data.receipt.turnId);
    assert.equal(queryBound(session.repo.db, 'SELECT COUNT(*) AS n FROM locations', [])[0].n, 1);
    assert.equal(queryBound(session.repo.db, "SELECT status FROM turns WHERE id=?", [first.body.data.receipt.turnId])[0].status, 'rolled_back');
  } finally { await f.provider.close(); }
});

test('Q03: retry groups do not change the live database before a confirmed save', async () => {
  const f = hostFixture();
  try {
    const first = await f.core.handle('POST', '/sql/turn', turn, { local: true });
    const session = await f.provider.session(turn.chatUid);
    const row = queryBound(session.repo.db, 'SELECT * FROM locations', [])[0];
    const head = session.repo.internal.currentHeadTurnId(), revision = session.repo.internal.currentRevision();
    const retry = { chatUid: turn.chatUid, turnId: first.body.data.receipt.turnId, attemptId: 'retry-one', clockS: 0,
      groups: [{ id: 'failed_patch', opIds: ['failed_patch'], dependsOn: [], readSet: [], mutations: [{
        table: 'locations', rowId: row.id, before: row, after: { ...row, description: '补交后的说明', row_rev: row.row_rev + 1 },
        sourceOpIds: ['failed_patch'], basis: {} }] }] };
    const envelope = f.host.chatMetadata.atlas.database;
    f.setSave(async () => { throw new Error('retry save failed'); });
    const failed = await f.core.handle('POST', '/sql/retry', retry, { local: true });
    assert.equal(failed.status, 200, JSON.stringify(failed.body));
    assert.equal(failed.body.data.coreSaved, false);
    assert.deepEqual(queryBound(session.repo.db, 'SELECT * FROM locations', [])[0], row);
    assert.equal(f.host.chatMetadata.atlas.database, envelope);
    f.setSave(async () => true);
    const saved = await f.core.handle('POST', '/sql/retry', retry, { local: true });
    assert.equal(saved.body.data.coreSaved, true);
    assert.equal(queryBound(session.repo.db, 'SELECT description FROM locations', [])[0].description, '补交后的说明');
    assert.equal(session.repo.internal.currentHeadTurnId(), head);
    assert.equal(session.repo.internal.currentRevision(), revision);
    assert.equal(session.repo.internal.currentClock(), 0);
    const repeated = await f.core.handle('POST', '/sql/retry', retry, { local: true });
    assert.equal(repeated.body.data.status, 'duplicate');
    assert.equal(queryBound(session.repo.db, "SELECT COUNT(*) AS n FROM turn_changes WHERE operation_id='failed_patch'", [])[0].n, 1);
  } finally { await f.provider.close(); }
});

test('Q03: automatic targeted repair commits its corrections under the original turn journal', async () => {
  let calls = 0;
  const f = hostFixture({ modelPort: { request: async request => {
    calls++;
    return { batchId: request.batchId, finishReason: 'stop', text: request.phase === 'repair'
      ? '{"ticket":"R1","op":"location.upsert","ref":"new:room","data":{"name":"纠错教室"}}'
      : '{"op":"location.upsert","ref":"new:room","data":{"name":"纠错教室","parent_ref":"L404"}}' };
  } } });
  try {
    const session = await f.provider.session(turn.chatUid);
    const baseline = session.repo.internal.currentHeadTurnId();
    const response = await f.core.handle('POST', '/sql/turn', { ...turn, manual: false, operations: undefined }, { local: true });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.coreSaved, true);
    assert.equal(calls, 2); assert.equal(f.saves(), 1);
    assert.equal(queryBound(session.repo.db, 'SELECT name FROM locations', [])[0].name, '纠错教室');
    assert.equal(queryBound(session.repo.db, 'SELECT DISTINCT turn_id FROM turn_changes', [])[0].turn_id, response.body.data.receipt.turnId);
    const rollback = await f.core.handle('POST', '/sql/rollback', { chatUid: turn.chatUid, targetParentTurnId: baseline }, { local: true });
    assert.equal(rollback.body.data.coreSaved, true);
    assert.equal(queryBound(session.repo.db, 'SELECT COUNT(*) AS n FROM locations', [])[0].n, 0);
  } finally { await f.provider.close(); }
});

test('Q03: a candidate exported before another maintenance save cannot replace the newer storage revision', async () => {
  const f = hostFixture();
  try {
    await f.core.handle('POST', '/sql/turn', turn, { local: true });
    const session = await f.provider.session(turn.chatUid);
    const anchor = { chatUid: turn.chatUid, branchId: session.branchId, parentTurnId: session.repo.internal.currentHeadTurnId(),
      hostMessageUid: 'old-maintenance', variantKey: 'maintenance', inputHash: 'old-maintenance',
      baseRevision: session.repo.internal.currentRevision(), baseStorageRevision: session.repo.storageRevision };
    const old = await session.repo.prepareMaintenance({ anchor });
    const saved = await f.core.handle('POST', '/sql/maintenance', { chatUid: turn.chatUid }, { local: true });
    assert.equal(saved.body.data.coreSaved, true);
    const before = JSON.stringify(f.host.chatMetadata), saves = f.saves();
    const stale = await persistSqlSession(session, { commit: old });
    assert.equal(stale.saved, false); assert.ok(stale.issues.some(i => i.code === 'STALE_BASE'));
    assert.equal(JSON.stringify(f.host.chatMetadata), before); assert.equal(f.saves(), saves);
    assert.equal(session.repo.getCandidate(old.token), null);
  } finally { await f.provider.close(); }
});

test('Q03: host snapshot changes during asynchronous export cannot become a new write baseline', async () => {
  const f = hostFixture();
  try {
    await f.core.handle('POST', '/sql/turn', turn, { local: true });
    const session = await f.provider.session(turn.chatUid);
    const exportEnvelope = session.repo.currentEnvelope.bind(session.repo);
    let external;
    session.repo.currentEnvelope = async () => {
      const old = await exportEnvelope();
      external = { ...f.host.chatMetadata.atlas.database, storage_revision: 99 };
      f.host.chatMetadata.atlas.database = external;
      return old;
    };
    const saves = f.saves();
    const result = await persistSqlSession(session);
    assert.equal(result.saved, false);
    assert.ok(result.issues.some(i => i.code === 'SESSION_STALE'));
    assert.equal(f.host.chatMetadata.atlas.database, external);
    assert.equal(f.saves(), saves);
  } finally { await f.provider.close(); }
});
