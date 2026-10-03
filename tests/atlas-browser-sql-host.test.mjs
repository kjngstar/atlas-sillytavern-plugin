import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserSqlHost } from '../src/atlas-browser-sql-host.ts';
import { createAtlasServerCore } from '../src/atlas-server.ts';
import { loadAtlasSqlRuntime } from '../src/atlas-sql-session.ts';

function hostFixture({ modelPort, loadRuntime = loadAtlasSqlRuntime } = {}) {
  let saves = 0;
  const host = { chatUid: 'browser-host-A', branchId: 'main', chatMetadata: {},
    saveMetadata: async () => { saves++; return true; } };
  let live = host, enabled = true;
  const provider = createBrowserSqlHost({ enabled: () => enabled, context: () => live, loadRuntime, modelPort });
  const core = createAtlasServerCore({ store: { read: async () => null, write: async () => {} }, sqlSessionProvider: provider });
  return { host, provider, core, saves: () => saves, setHost: value => { live = value; }, setEnabled: value => { enabled = value; } };
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

test('Q01: old data cannot be replaced by a new empty SQL database before migration', async () => {
  const f = hostFixture(); f.host.chatMetadata.atlas = { tables: { locations: [], characters: [], items: [] } };
  const before = JSON.stringify(f.host.chatMetadata);
  await assert.rejects(f.provider.session('browser-host-A'), error => error.code === 'SQL_MIGRATION_REQUIRED');
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
