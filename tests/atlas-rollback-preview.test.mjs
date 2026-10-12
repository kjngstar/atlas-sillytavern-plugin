/**
 * atlas-rollback-preview.test.mjs — P14/§21.4 回退影响预览（只读）
 *
 * 纪律：
 *  - 走**真实调用链**：真实 SQL seed 信封 → openSqlSession → runSqlTurn 建楼 →
 *    handleSqlChatRequest('rollback-preview') → 服务端同一个 planRollback；不手搓「计划」夹具；
 *  - 只读证明用**存档快照哈希 + turn_changes 行数**，不靠「没报错」；
 *  - POV 只给计数（withheld），行级清单不下发。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS } from './fixtures/atlas-sql/seed.mjs';
import { openSqlSession, runSqlTurn } from '../src/atlas-sql-session.ts';
import { handleSqlChatRequest } from '../src/atlas-sql-chat.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { encodeSnapshot, sha256Hex } from '../src/atlas-db-envelope.ts';
import { summarizeRollbackPlan } from '../src/atlas-rollback-preview.ts';

const SQL = await (await import('sql.js')).default();

const scripted = () => ({
  calls: [],
  async request(req) { this.calls.push(req); return { batchId: req.batchId, text: '{"op":"noop"}', finishReason: 'stop', httpStatus: 200, durationMs: 3 }; },
});

let seq = 0;
async function world() {
  const seed = await makeSeedWith(SQL);
  const bytes = seed.exportBytes();
  seed.close();
  const chatUid = `rollback-preview-${++seq}`;
  const chatMetadata = {};
  const envelope = await encodeSnapshot(bytes, { chatUid, worldUid: chatUid, storageRevision: 0, activeBranchId: IDS.branchMain });
  chatMetadata.atlas = { sqlMode: true, database: envelope };
  const modelPort = scripted();
  const session = await openSqlSession({ chatUid, chatMetadata, saveSession: async () => true, modelPort, now: () => 1_700_000_000_000 });
  return { session, chatMetadata, modelPort };
}

/** 真实推演两楼（narrative），楼层号来自各楼自己的 hostMessageUid。 */
async function twoFloors(session) {
  const run = async (hostMessageUid, assistantText) => {
    const result = await runSqlTurn(session, {
      anchor: {
        chatUid: session.chatUid,
        branchId: session.branchId,
        parentTurnId: session.repo.internal.currentHeadTurnId(),
        hostMessageUid,
        variantKey: 'v1',
        baseRevision: session.repo.internal.currentRevision(),
        baseStorageRevision: session.repo.storageRevision,
        inputHash: `input-${hostMessageUid}`,
      },
      userText: '', assistantText, sourceSnapshot: [], phaseBatches: ['observe'], manual: false,
    });
    assert.equal(result.coreSaved, true, `第 ${hostMessageUid} 楼必须真的保存`);
    return result;
  };
  await run('m1', '一楼。');
  await run('m2', '二楼。');
}

const floors = (session) => queryBound(session.repo.db,
  "SELECT id,host_message_uid,decisions_json FROM turns WHERE branch_id=? AND kind='narrative' AND status IN ('committed','partial') ORDER BY committed_revision ASC, created_wall_ms ASC",
  [session.branchId]).map((row) => {
    let floor = String(row.host_message_uid);
    try {
      const decisions = JSON.parse(String(row.decisions_json ?? '{}'));
      if (decisions?.host_message_index) floor = String(decisions.host_message_index);
    } catch { /* 读不到就用 uid，不编 */ }
    return { turnId: String(row.id), floor };
  });
const snapshotOf = async (session) => sha256Hex(await session.repo.exportCurrent());
const changesCount = (session) => Number(queryBound(session.repo.db, 'SELECT COUNT(*) AS n FROM turn_changes')[0].n);

test('RP01 · 预览给出目标楼层与将一并撤销的后续楼，楼层号取自真实记录', async () => {
  const { session } = await world();
  await twoFloors(session);
  const all = floors(session);
  assert.equal(all.length, 2, '夹具必须恰好两楼 narrative');
  const [first, second] = all;
  const result = await handleSqlChatRequest(session, 'rollback-preview', { assistantMessageId: first.floor, viewMode: 'author' });
  const preview = result.preview;
  assert.ok(preview, '预览必须返回真实计划');
  assert.equal(preview.targetFloor, first.floor, '目标楼层就是请求的那一楼');
  assert.equal(preview.affectedTurnCount, all.length, '受影响楼数必须覆盖目标楼及其后继');
  // 契约：plan.turns 是**逆因果序**（先撤最新楼，最后才撤目标楼），预览不得擅自重排。
  assert.deepEqual(preview.affectedTurns.map((t) => t.floor), [...all].reverse().map((t) => t.floor),
    '受影响楼必须按逆因果序列出（最新 → 目标）');
  assert.equal(preview.affectedTurns.at(-1).floor, first.floor, '目标楼必须排在逆因果序末位');
  assert.equal(preview.affectedTurns[0].floor, second.floor, '最新后继楼必须排在逆因果序首位');
  assert.ok(preview.affectedTurns.some((t) => t.floor === second.floor), '后继楼必须在受影响清单里');
  assert.equal(preview.affectedTurns.every((t) => t.kind === 'narrative'), true, '楼种来自真实 turns.kind');
  assert.equal(preview.withheld, false, '作者视角给行级清单');
  assert.ok(preview.clockTargetS <= preview.clockBeforeS);
  assert.ok(Object.keys(preview.tableCounts).length > 0, '受影响表计数来自真实计划步骤');
  assert.equal(result.coreSaved, false, '预览不是保存结果');
});

test('RP02 · 预览只读：存档快照哈希与 turn_changes 行数一间不变', async () => {
  const { session } = await world();
  await twoFloors(session);
  const [first] = floors(session);
  const before = await snapshotOf(session), beforeChanges = changesCount(session);
  await handleSqlChatRequest(session, 'rollback-preview', { assistantMessageId: first.floor, viewMode: 'author' });
  await handleSqlChatRequest(session, 'rollback-preview', { assistantMessageId: first.floor, viewMode: 'author' });
  assert.equal(await snapshotOf(session), before, '预览不得改写存档');
  assert.equal(changesCount(session), beforeChanges, '预览不得新增 journal 变更');
});

test('RP03 · 主角视角只给计数：行级清单被隐去并明示 withheld', async () => {
  const { session } = await world();
  await twoFloors(session);
  const [first] = floors(session);
  const author = (await handleSqlChatRequest(session, 'rollback-preview', { assistantMessageId: first.floor, viewMode: 'author' })).preview;
  const pov = (await handleSqlChatRequest(session, 'rollback-preview', { assistantMessageId: first.floor, viewMode: 'pov' })).preview;
  assert.equal(pov.withheld, true);
  assert.deepEqual(pov.affectedTurns, [], 'POV 不下发行级清单');
  assert.deepEqual(pov.affectedMaps, []);
  assert.deepEqual(pov.affectedProgressScopes, []);
  assert.equal(pov.affectedTurnCount, author.affectedTurnCount, '计数仍要真实');
  assert.equal(pov.targetFloor, author.targetFloor, '目标楼是作者自己点的那一楼，不算秘密');
});

test('RP04 · 拒绝语义：楼层对不上/版本不符一律明确报错，不猜一个目标', async () => {
  const { session } = await world();
  await twoFloors(session);
  await assert.rejects(
    () => handleSqlChatRequest(session, 'rollback-preview', { assistantMessageId: '不存在的楼层', viewMode: 'author' }),
    (error) => error.code === 'SQL_ROLLBACK_FLOOR_MISMATCH');
  const [first] = floors(session);
  await assert.rejects(
    () => handleSqlChatRequest(session, 'rollback-preview', { assistantMessageId: first.floor, expectedRevision: 999, viewMode: 'author' }),
    (error) => error.code === 'STALE_BASE');
  const ok = await handleSqlChatRequest(session, 'rollback-preview', { assistantMessageId: first.floor, viewMode: 'author' });
  assert.ok(ok.preview, '被拒绝之后原计划仍然可用（没有半写状态）');
});

test('RP05 · 纯摘要器：地图与建设进度范围来自真实 step，insert 行读不到就不列', () => {
  const plan = {
    branchId: 'main', targetTurnId: 't1', turns: ['t1', 't2'], affectedTurns: 2,
    clockBeforeS: 120, clockTargetS: 60, issues: [],
    tableCounts: { maps: 2, construction_progress: 2, locations: 1 },
    steps: [
      { sequence: 4, turnId: 't2', changeId: 'c4', targetTable: 'maps', targetRowId: 'm-annex', operation: 'insert', restore: null, basis: {}, summary: '' },
      { sequence: 3, turnId: 't2', changeId: 'c3', targetTable: 'maps', targetRowId: 'm-yard', operation: 'update', restore: { id: 'm-yard', frame_json: '{}' }, basis: {}, summary: '' },
      { sequence: 2, turnId: 't1', changeId: 'c2', targetTable: 'construction_progress', targetRowId: 'p1', operation: 'update', restore: { id: 'p1', scope_key: 'local|m-yard' }, basis: {}, summary: '' },
      { sequence: 1, turnId: 't1', changeId: 'c1', targetTable: 'construction_progress', targetRowId: 'p2', operation: 'insert', restore: null, basis: {}, summary: '' },
    ],
  };
  const turns = [{ turnId: 't1', floor: '楼层一', kind: 'narrative', manual: true, status: 'committed' },
    { turnId: 't2', floor: '楼层二', kind: 'narrative', manual: false, status: 'committed' }];
  const author = summarizeRollbackPlan(plan, { turns, viewMode: 'author' });
  assert.deepEqual(author.affectedMaps, ['m-annex', 'm-yard']);
  assert.deepEqual(author.affectedProgressScopes, ['local|m-yard'], 'insert 行没有可读 scope_key 就不编一个');
  assert.equal(author.manualTurnCount, 1);
  assert.equal(author.targetFloor, '楼层一');
  const pov = summarizeRollbackPlan(plan, { turns, viewMode: 'pov' });
  assert.equal(pov.withheld, true);
  assert.deepEqual(pov.affectedMaps, []);
  assert.equal(pov.affectedTurnCount, 2);
});
