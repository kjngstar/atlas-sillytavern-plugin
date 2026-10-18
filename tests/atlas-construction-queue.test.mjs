/**
 * atlas-construction-queue.test.mjs — P09B / R01：持久目标队列与公平重试（QUEUE01–QUEUE09）。
 *
 * 覆盖（交接稿 §16）：
 * - QUEUE01 65 个目标：首批 64 个全部有效保存，**下一批轮到第 65 个**（不是同一前缀）；
 * - QUEUE02 局部失败后仍能轮到新工作：永久失败/重试单元不占满名额（3 新 : 1 重试）；
 * - QUEUE03 目标数超过单次发现上限：按持久游标分页循环，最终发现最后一个；
 * - QUEUE04 游标**之前**新插入的 ID，下一扫描周期能被发现；
 * - QUEUE05 结构处理成功、布局未完成：下次只做布局，不重发同一结构单元；
 * - QUEUE06 未保存/取消 → 正式进度不变；fork 继承；rollback 恢复目标、单元与调度序号；
 * - QUEUE07 焦点变化不使另外 scope 的进度丢失；
 * - QUEUE08 同一正文下 saved 后「继续建设」：下一目标真的被请求并保存，observe 次数不增加；
 * - QUEUE09 同一继续动作双击/网络重试只有一个有效任务与一次推进；下一单元仍可独立执行。
 *
 * 全程走真实路径：createSqlRepository.prepareTurn（含 sceneMaps/layout 步骤）+ 真实
 * handleSqlMapAction。夹具只用 seed 合成实体，不带任何用户文本。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { createRow } from '../src/atlas-db-defaults.ts';
import { makeSeedWith, IDS, insertRows } from './fixtures/atlas-sql/seed.mjs';
import { forkBranch } from '../src/atlas-db-branches.ts';
import { rotationOrder } from '../src/atlas-construction-scheduler.ts';
import { DISCOVERY_MAX_ROWS, DISCOVERY_PAGE_SIZE, MAX_UNIT_ATTEMPTS, UNIT_TARGET_LIMIT, scopeKeyFor } from '../src/atlas-construction-progress.ts';
import { createBrowserSqlHost } from '../src/atlas-browser-sql-host.ts';
import { loadAtlasSqlRuntime } from '../src/atlas-sql-session.ts';
import { handleSqlMapAction } from '../src/atlas-sql-map-actions.ts';

const SQL = await (await import('sql.js')).default();
const BRANCH = IDS.branchMain;
const noop = '{"op":"noop"}';

const model = (fn) => ({
  calls: [],
  async request(req) {
    this.calls.push(req);
    return { batchId: req.batchId, text: fn(req, this.calls.length, req), httpStatus: 200, durationMs: 1 };
  },
});

const constructionCalls = (port) => port.calls.filter((call) => call.batchId.startsWith('construction_'));
const observeCalls = (port) => port.calls.filter((call) => call.batchId.startsWith('observe_'));

/** 从建设提示词里取出本批焦点别名（`focus=A、B、C、maxNewLocations=…`）。 */
const promptFoci = (req) => {
  const match = req.messages[1].content.match(/focus=([^\n]*?)、maxNewLocations=/);
  return match ? match[1].split('、').map((item) => item.trim()).filter((item) => item.length > 0 && item !== '（无）') : [];
};

/**
 * 对本批的前几个焦点各写一条描述：合法、可应用、不新增地点
 * （结构未变 → 不改变后续签名）。只写前几个是为了让请求体保持小规模 ——
 * 每个模型组都会跑一次全库不变式校验，这是既有实现的成本特征，不是队列引入的。
 */
const PATCH_OPS_PER_BATCH = 4;
const patchModel = () => model((req) => {
  if (!req.batchId.startsWith('construction_')) return noop;
  const foci = promptFoci(req).slice(0, PATCH_OPS_PER_BATCH);
  if (foci.length === 0) return noop;
  return foci
    .map((focus) => JSON.stringify({ op: 'location.upsert', ref: focus, data: { description: '队列核对过结构' } }))
    .join('\n');
});

async function seeded(port, setup) {
  const seed = await makeSeedWith(SQL);
  setup?.(seed.db);
  const bytes = seed.exportBytes();
  seed.close();
  const repo = createSqlRepository({ chatUid: IDS.chatA, branchId: BRANCH, modelPort: port });
  await repo.open({ bytes });
  return repo;
}

let round = 0;
const turnInput = (repo, extra = {}) => {
  round += 1;
  return {
    anchor: {
      chatUid: IDS.chatA,
      branchId: BRANCH,
      parentTurnId: repo.internal.currentHeadTurnId() ?? IDS.seedTurn,
      hostMessageUid: `queue-round-${round}`,
      variantKey: 'author',
      inputHash: `queue-round-${round}`,
      baseRevision: repo.internal.currentRevision(),
      baseStorageRevision: repo.storageRevision,
    },
    userText: '合成队列', assistantText: '合成队列', sourceSnapshot: [],
    phaseBatches: ['observe'], manual: false, sceneOnly: true,
    worldCompletion: { mode: 'local', focusLocationIds: [IDS.L3] },
    ...extra,
  };
};

const queuedIds = (count) => Array.from({ length: count }, (_, index) => `queued_${String(index).padStart(4, '0')}`);

/** 在 parent 下挂 count 个房间（无 map_id → 未分类且无内部结构，优先级最高）。 */
const equip = (db, ids, parent = IDS.L2) => {
  db.run('BEGIN');
  insertRows(db, 'entity_keys', ids.map((id) => ({ branch_id: BRANCH, id, kind: 'location' })));
  insertRows(db, 'locations', ids.map((id) => createRow('locations', { name: id, kind: 'room', parent_location_id: parent, map_id: null }, { branchId: BRANCH, id, turnId: IDS.seedTurn, clockS: 0, nowWallMs: 1, rulesetVersion: 'atlas-1' })));
  db.run('COMMIT');
};

const progressRows = (db) => queryBound(db, 'SELECT * FROM construction_progress WHERE branch_id = ? ORDER BY kind, id', [BRANCH]);
const targetRows = (db) => progressRows(db).filter((row) => row.kind === 'target');
const unitRows = (db) => progressRows(db).filter((row) => row.kind === 'unit');
const scopeRow = (db) => progressRows(db).find((row) => row.kind === 'scope') ?? null;
const save = (repo, prepared) => repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'saved' });

/* ------------------------------------------------------------------ *
 * QUEUE01：65 个目标，首批 64，下一批轮到第 65 个
 * ------------------------------------------------------------------ */

test('QUEUE01 65 个目标：首批 64 个有效保存，下一批真的轮到第 65 个', async () => {
  const ids = queuedIds(65);
  const port = patchModel();
  const repo = await seeded(port, (db) => equip(db, ids));
  try {
    const focus = ids;
    const first = await repo.prepareTurn(turnInput(repo, { worldCompletion: { mode: 'local', focusLocationIds: focus } }));
    assert.equal(constructionCalls(port).length, 1);
    assert.equal(UNIT_TARGET_LIMIT, 64);
    await save(repo, first);

    const afterFirst = targetRows(repo.db);
    assert.equal(afterFirst.length, 65, '每个焦点一条持久进度行');
    assert.equal(afterFirst.filter((row) => row.status === 'processed').length, 64, '首批必须是 64 个有效处理');
    assert.deepEqual(afterFirst.filter((row) => row.status === 'pending').map((row) => row.subject_key), [ids[64]], '第 65 个必须留在持久队列里');
    const processedByFirst = new Set(afterFirst.filter((row) => row.status === 'processed').map((row) => row.subject_key));

    // 下一批：焦点相同 → 必须真的再发一次建设请求，而且处理的是第 65 个（不是重复同一前缀）。
    const second = await repo.prepareTurn(turnInput(repo, { worldCompletion: { mode: 'local', focusLocationIds: focus } }));
    assert.equal(constructionCalls(port).length, 2, '有待办就必须再发一次建设请求');
    await save(repo, second);

    const afterSecond = targetRows(repo.db);
    assert.equal(afterSecond.filter((row) => row.status === 'processed').length, 65, '第 65 个必须被处理');
    assert.equal(afterSecond.filter((row) => row.status === 'pending').length, 0);
    const newlyProcessed = afterSecond.filter((row) => row.status === 'processed' && !processedByFirst.has(row.subject_key));
    assert.deepEqual(newlyProcessed.map((row) => row.subject_key), [ids[64]], '第二批处理的正是第 65 个');
    assert.equal(unitRows(repo.db).filter((row) => row.status === 'processed').length, 2, '两次有效结构处理 = 两个已完成单元');
  } finally { await repo.close(); }
});

/* ------------------------------------------------------------------ *
 * QUEUE02：公平重试
 * ------------------------------------------------------------------ */

test('QUEUE02 3 新 : 1 重试 的轮转与「失败目标不占满名额」', async () => {
  const unit = (unitId, status, lastServedSeq) => ({ unitId, status, lastServedSeq, targetIds: [unitId], sourceChunkKeys: [], inputSignature: 'sig', catalogueHash: '', attemptCount: 0 });
  const fresh = [unit('u1', 'pending', 0), unit('u2', 'pending', 0), unit('u3', 'pending', 0)];
  const retry = [unit('r1', 'retry', 5)];
  assert.deepEqual(rotationOrder(fresh, retry, 0).map((item) => item.unitId), ['u1', 'u2', 'u3', 'r1'], '前三个名额给新单元，第四个才轮到重试');
  assert.deepEqual(rotationOrder(fresh, retry, 3).map((item) => item.unitId)[0], 'r1', '第 4 批先照顾重试');
  assert.deepEqual(rotationOrder([], retry, 0).map((item) => item.unitId), ['r1'], '新单元为空时名额释放给重试');
  assert.deepEqual(rotationOrder(fresh, [], 3).map((item) => item.unitId), ['u1', 'u2', 'u3'], '重试为空时名额释放给新单元');

  // Production rotation: fresh targets must be considered before they have
  // persistent unit rows. A failed first unit cannot consume fresh slots 2/3.
  const ids = queuedIds(260);
  const port = model((req) => {
    if (!req.batchId.startsWith('construction_')) return noop;
    throw new Error('合成网络失败');
  });
  const repo = await seeded(port, (db) => equip(db, ids));
  try {
    const focus = ids;
    const selected=[];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const prepared = await repo.prepareTurn(turnInput(repo, { worldCompletion: { mode: 'local', focusLocationIds: focus } }));
      await save(repo, prepared);
      const served=unitRows(repo.db).sort((a,b)=>Number(b.last_served_seq)-Number(a.last_served_seq))[0];
      selected.push(served.subject_key);
    }
    assert.equal(new Set(selected.slice(0,3)).size,3,'前三个实际名额处理三个不同新单元');
    assert.equal(selected[3],selected[0],'第四个实际名额重试最早失败单元');
    const units=unitRows(repo.db);
    assert.equal(units.length,3);
    assert.deepEqual(units.map(row=>JSON.parse(row.payload_json).attemptCount).sort(),[1,1,2]);
    assert.equal(targetRows(repo.db).filter(row=>row.status==='processed').length,0);
    assert.equal(targetRows(repo.db).filter(row=>row.status==='pending').length,260);
    assert.equal(constructionCalls(port).length,4);
  } finally { await repo.close(); }
});

/* ------------------------------------------------------------------ *
 * QUEUE03 / QUEUE04：分页发现与扫描周期
 * ------------------------------------------------------------------ */

test('QUEUE03 目标数超过单次发现上限：按持久游标分页循环，最终发现最后一个', async () => {
  const total = DISCOVERY_MAX_ROWS + 200;
  const ids = queuedIds(total);
  const port = patchModel();
  const repo = await seeded(port, (db) => equip(db, ids));
  try {
    const focus = [IDS.L2];
    let saved = 0;
    // 每批最多发现 DISCOVERY_MAX_ROWS 行；游标必须先向后推进，再在到尾部后开启新周期。
    const seenCursors = new Set();
    for (let batch = 0; batch < 2; batch += 1) {
      const prepared = await repo.prepareTurn(turnInput(repo, { worldCompletion: { mode: 'local', focusLocationIds: focus } }));
      const scope = scopeRow(repo.getCandidate(prepared.token).db);
      const payload = JSON.parse(String(scope.payload_json));
      assert.ok(payload.scanAfterId.length > 0 || payload.scanCycle > 0, '游标或扫描周期必须持久推进');
      seenCursors.add(`${payload.scanAfterId}|${payload.scanCycle}`);
      await save(repo, prepared);
      saved += 1;
    }
    assert.equal(saved, 2);
    const discovered = new Set(targetRows(repo.db).map((row) => row.subject_key));
    assert.ok(discovered.has(ids[total - 1]), `分页循环必须最终发现最后一个目标 ${ids[total - 1]}`);
    assert.ok(ids.every((id) => discovered.has(id)), '每个目标都要有持久进度行');
    assert.ok(discovered.size > DISCOVERY_MAX_ROWS, `单批发现上限 ${DISCOVERY_MAX_ROWS} 必须被分页突破，实际 ${discovered.size}`);
    const scope = scopeRow(repo.db);
    const payload = JSON.parse(String(scope.payload_json));
    assert.equal(payload.scanCycle, 1, '扫到尾部后开启新周期并把游标归零');
    assert.equal(payload.scanAfterId, '');
    assert.ok(DISCOVERY_PAGE_SIZE <= DISCOVERY_MAX_ROWS);

    // 已处理且签名未变的目标不再被重新处理：下一批只处理**当时还 pending** 的目标。
    const processedBefore = new Set(targetRows(repo.db).filter((row) => row.status === 'processed').map((row) => row.subject_key));
    const pendingBefore = new Set(targetRows(repo.db).filter((row) => row.status === 'pending').map((row) => row.subject_key));
    const unitsBefore = new Set(unitRows(repo.db).map((row) => row.id));
    const again = await repo.prepareTurn(turnInput(repo, { worldCompletion: { mode: 'local', focusLocationIds: focus } }));
    await save(repo, again);
    const newUnit = unitRows(repo.db).find((row) => !unitsBefore.has(row.id));
    assert.ok(newUnit, '还有待处理目标时必须真的建一个单元');
    const covered = JSON.parse(String(newUnit.payload_json)).targetIds;
    assert.ok(covered.length > 0, '单元必须冻结自己的目标集合');
    assert.ok(covered.every((id) => pendingBefore.has(id)), '本批只允许处理当时还没处理过的目标');
    assert.ok(covered.every((id) => !processedBefore.has(id)), '签名不变的已处理目标不得被重新入队');
  } finally { await repo.close(); }
});

test('QUEUE04 游标之前新插入的目标，下一扫描周期能被发现', async () => {
  const total = DISCOVERY_MAX_ROWS + 200;
  const ids = queuedIds(total);
  const port = patchModel();
  const repo = await seeded(port, (db) => equip(db, ids));
  try {
    const focus = [IDS.L2];
    const first = await repo.prepareTurn(turnInput(repo, { worldCompletion: { mode: 'local', focusLocationIds: focus } }));
    const cursor = JSON.parse(String(scopeRow(repo.getCandidate(first.token).db).payload_json)).scanAfterId;
    assert.ok(cursor.length > 0, '第一批不应扫到尾部（目标数超过单次发现上限）');
    await save(repo, first);

    // 插入一个字典序**在游标之前**的新目标（扫描若只向后就永远看不到它）。
    const lateId = 'aaa_late_target';
    equip(repo.db, [lateId], IDS.L2);
    assert.ok(lateId < cursor, '新目标必须排在旧游标之前');

    const second = await repo.prepareTurn(turnInput(repo, { worldCompletion: { mode: 'local', focusLocationIds: focus } }));
    await save(repo, second);
    const third = await repo.prepareTurn(turnInput(repo, { worldCompletion: { mode: 'local', focusLocationIds: focus } }));
    await save(repo, third);

    const discovered = new Set(targetRows(repo.db).map((row) => row.subject_key));
    assert.ok(discovered.has(lateId), '扫描周期回到头部后必须发现游标之前新插入的目标');
  } finally { await repo.close(); }
});

/* ------------------------------------------------------------------ *
 * QUEUE05：结构成功、布局未完成
 * ------------------------------------------------------------------ */

test('QUEUE05 结构处理成功但布局未完成：下次只做布局，不重发同一结构单元', async () => {
  const hall = 'queue_hall';
  const port = patchModel();
  const repo = await seeded(port, (db) => equip(db, [hall]));
  try {
    const focus = [hall];
    const first = await repo.prepareTurn(turnInput(repo, { worldCompletion: { mode: 'local', focusLocationIds: focus }, layoutMaps: 'active' }));
    await save(repo, first);
    const processed = targetRows(repo.db).filter((row) => row.status === 'processed');
    assert.equal(processed.length, 1, '结构处理成功 → 目标变 processed');
    assert.equal(unitRows(repo.db)[0].status, 'processed');
    assert.equal(constructionCalls(port).length, 1);
    // 没有容器图 → 完成状态只能是 partial/deferred：布局待办与结构进度是两件事。
    const fill = JSON.parse(String(queryBound(repo.db, 'SELECT frame_json FROM maps WHERE id = ?', [IDS.M1])[0].frame_json)).atlasWorldFill;
    assert.ok(fill, '必须有兜底完成记录');
    assert.notEqual(fill.status, 'ready', '布局没完成就不能报 ready');

    const second = await repo.prepareTurn(turnInput(repo, { worldCompletion: { mode: 'local', focusLocationIds: focus }, layoutMaps: 'active' }));
    await save(repo, second);
    assert.equal(constructionCalls(port).length, 1, '已处理的结构单元不得被重新放回建世界阶段');
    assert.equal(unitRows(repo.db).length, 1, '不得为同一目标再建一个单元');
  } finally { await repo.close(); }
});

/* ------------------------------------------------------------------ *
 * QUEUE06：未保存 / fork / rollback
 * ------------------------------------------------------------------ */

test('QUEUE06 未保存进度不变；fork 继承合法状态；rollback 恢复目标、单元与调度序号', async () => {
  const ids = queuedIds(65);
  const port = patchModel();
  const repo = await seeded(port, (db) => equip(db, ids));
  try {
    const focus = ids;
    // 1) 候选没保存（宿主拒存 / 用户取消）→ 正式库一个字节都不动。
    const draft = await repo.prepareTurn(turnInput(repo, { worldCompletion: { mode: 'local', focusLocationIds: focus } }));
    assert.ok(progressRows(repo.getCandidate(draft.token).db).length > 0, '候选里必须有进度');
    await repo.discardPrepared(draft.token);
    assert.equal(progressRows(repo.db).length, 0, '未保存的批次不得推进正式进度');

    // 2) 真正保存一批 → fork 必须继承同一份进度（ID 稳定、父子独立）。
    const saved = await repo.prepareTurn(turnInput(repo, { worldCompletion: { mode: 'local', focusLocationIds: focus } }));
    await save(repo, saved);
    const parentRows = progressRows(repo.db);
    const scopeBefore = JSON.parse(String(scopeRow(repo.db).payload_json));
    assert.equal(parentRows.length, 1 + 65 + 1, 'scope + 65 目标 + 1 单元');

    const forked = forkBranch({ parentBranchId: BRANCH, newBranchId: 'main-queue-fork', name: '队列分叉', forkTurnId: saved.receipt.turnId, makeId: (_k, opId, alias) => `fork_${opId}_${alias}`, nowWallMs: 2, rulesetVersion: 'atlas-1' }, repo.db);
    assert.ok(forked.copiedRows > 0);
    const childRows = queryBound(repo.db, 'SELECT * FROM construction_progress WHERE branch_id = ? ORDER BY id', ['main-queue-fork']);
    assert.deepEqual(childRows.map((row) => row.id).sort(), parentRows.map((row) => row.id).sort(), 'fork 继承同一批进度行 ID');
    assert.ok(childRows.every((row) => row.row_rev === 1), 'fork 里 row_rev 归 1');
    assert.equal(JSON.parse(String(childRows.find((row) => row.kind === 'scope').payload_json)).schedulerSeq, scopeBefore.schedulerSeq, '调度序号一并继承');
    // 原分支一个字节不动。
    assert.deepEqual(progressRows(repo.db).map((row) => row.id).sort(), parentRows.map((row) => row.id).sort());

    // 3) rollback：目标行、单元行、调度序号一起回到该楼之前。
    const rollback = await repo.prepareRollback({ chatUid: IDS.chatA, branchId: BRANCH, targetParentTurnId: saved.receipt.turnId, expectedRevision: 1 });
    await save(repo, rollback);
    assert.equal(progressRows(repo.db).length, 0, 'rollback 必须把本轮进度一并撤销');
  } finally { await repo.close(); }
});

/* ------------------------------------------------------------------ *
 * QUEUE07：跨 scope 不互相清空
 * ------------------------------------------------------------------ */

test('QUEUE07 焦点变化不使另外 scope 的进度丢失', async () => {
  const idsA = queuedIds(10).map((id) => `alpha_${id}`);
  const idsB = queuedIds(10).map((id) => `beta_${id}`);
  const port = patchModel();
  const repo = await seeded(port, (db) => { equip(db, idsA, IDS.L2); equip(db, idsB, IDS.L3); });
  try {
    const first = await repo.prepareTurn(turnInput(repo, { worldCompletion: { mode: 'local', focusLocationIds: [IDS.L2] } }));
    await save(repo, first);
    const scopeA = scopeRow(repo.db).scope_key;
    const rowsA = new Map(progressRows(repo.db).filter((row) => row.scope_key === scopeA).map((row) => [row.id, `${row.row_rev}|${row.status}|${row.input_signature}`]));
    assert.ok(rowsA.size >= idsA.length, 'A 范围必须登记自己的进度');

    const second = await repo.prepareTurn(turnInput(repo, { worldCompletion: { mode: 'local', focusLocationIds: [IDS.L3] } }));
    await save(repo, second);
    const scopes = progressRows(repo.db).map((row) => row.scope_key);
    const scopeB = [...new Set(scopes)].find((key) => key !== scopeA);
    assert.ok(scopeB, '新的焦点集合必须是另一个 scope');

    const rowsAAfter = new Map(progressRows(repo.db).filter((row) => row.scope_key === scopeA).map((row) => [row.id, `${row.row_rev}|${row.status}|${row.input_signature}`]));
    assert.deepEqual([...rowsAAfter.keys()].sort(), [...rowsA.keys()].sort(), 'B 范围的建设不得删除 A 范围的行');
    for (const [id, state] of rowsA) assert.equal(rowsAAfter.get(id), state, 'A 范围的进度逐行不变');
  } finally { await repo.close(); }
});

/* ------------------------------------------------------------------ *
 * QUEUE08 / QUEUE09：真实 handleSqlMapAction 的「继续建设」
 * ------------------------------------------------------------------ */

/** 初建：登记一个旅店并给它一张内部图；建设批次按标签里的焦点补描述。 */
const bootstrapModel = () => model((req, n) => {
  if (req.batchId.includes('_evidence_')) return '{"facts":[]}';
  if (req.batchId.startsWith('layout_')) {
    const line = req.messages[1].content.split('\n').find((item) => item.startsWith('本图：'));
    return JSON.parse(line.slice(3))
      .map((scope) => JSON.stringify({ op: 'map.layout.request', ref: scope.map, data: { kind: scope.kind, spec: scope.kind === 'floor' ? { rooms: scope.baselineRooms } : { surface: 'mixed' } } }))
      .join('\n');
  }
  if (req.batchId.startsWith('construction_')) return patchModelText(req);
  return n === 1
    ? JSON.stringify({ op: 'location.upsert', ref: 'new:lodge', data: { name: '新旅店', kind: 'building' } })
    : noop;
});

const patchModelText = (req) => {
  const foci = promptFoci(req);
  if (foci.length === 0) return noop;
  return foci.map((focus) => JSON.stringify({ op: 'location.upsert', ref: focus, data: { description: '继续建设核对' } })).join('\n');
};

const buildHost = (port) => {
  const record = { chatUid: 'queue-chat', branchId: 'main', chatMetadata: {}, saveMetadata: async () => true };
  const provider = createBrowserSqlHost({ enabled: () => true, context: () => record, loadRuntime: loadAtlasSqlRuntime, modelPort: port });
  return { record, provider, port };
};

/** 通过真实动作建好一个带内部图的旅店，返回 {session, lodge}。 */
async function bootstrappedHost() {
  const { record, provider, port } = buildHost(bootstrapModel());
  const session = await provider.session(record.chatUid);
  await handleSqlMapAction(session, 'map/bootstrap', { chatId: record.chatUid, requestId: 'q-bootstrap', assistantText: '主角进入旅店。' });
  const lodge = String(queryBound(session.repo.db, 'SELECT id FROM locations WHERE branch_id = ? AND name = ?', [session.branchId, '新旅店'])[0].id);
  return { record, provider, port, session, lodge };
}

test('QUEUE08 同一正文下「继续建设」：下一目标被真实请求并保存，observe 不再增加', async () => {
  const { record, provider, port, session, lodge } = await bootstrappedHost();
  try {
    const localScope = scopeKeyFor('local', [lodge]);
    const continueBody = { chatId: record.chatUid, mode: 'local', focusLocationIds: [lodge], continue: true, requestId: 'q08-continue-1', assistantText: '继续建设旅店内部。' };
    const before = port.calls.length;
    const first = await handleSqlMapAction(session, 'map/build', continueBody);
    assert.notEqual(first.status, 'idle', `第一次继续建设必须真的有活干：${JSON.stringify(first)}`);
    assert.equal(port.calls.length - before, 1, '继续建设只发一次模型请求（跳过 observe）');
    assert.equal(port.calls[port.calls.length - 1].batchId.startsWith('construction_'), true, '这一次请求必须是建设，不是 observe');
    const target = queryBound(session.repo.db, 'SELECT * FROM construction_progress WHERE branch_id = ? AND kind = ? AND scope_key = ? AND subject_key = ?', [session.branchId, 'target', localScope, lodge])[0];
    assert.ok(target, '继续建设必须为焦点登记持久进度（local 范围）');
    assert.equal(target.status, 'processed', '本批必须真的保存下来');
    assert.equal(typeof first.build?.queue?.selectedTargets, 'number', '回执必须交出队列口径（§16.5）');

    // 队列空了：零请求返回「暂无待处理」，不伪造一次模型请求。
    const idle = await handleSqlMapAction(session, 'map/build', { ...continueBody, requestId: 'q08-continue-2' });
    assert.equal(idle.pending, false);
    assert.equal(idle.status, 'idle');
    assert.equal(port.calls.length - before, 1, '无待办时零请求');
  } finally { await provider.close(); }
});

test('QUEUE09 同一继续动作双击只有一个有效任务；下一单元仍可独立执行', async () => {
  const { record, provider, port, session, lodge } = await bootstrappedHost();
  try {
    const localScope = scopeKeyFor('local', [lodge]);
    const body = { chatId: record.chatUid, mode: 'local', focusLocationIds: [lodge], continue: true, requestId: 'q09-click', assistantText: '继续建设旅店内部。' };
    const before = port.calls.length;
    const [first, second] = await Promise.all([
      handleSqlMapAction(session, 'map/build', body),
      handleSqlMapAction(session, 'map/build', body),
    ]);
    assert.equal(port.calls.length - before, 1, '双击只能有一次真实模型请求');
    assert.equal(first.receipt.turnId, second.receipt.turnId, '双击必须落在同一个回合身份上');
    const localRows = queryBound(session.repo.db, 'SELECT * FROM construction_progress WHERE branch_id = ? AND scope_key = ?', [session.branchId, localScope]);
    assert.equal(localRows.filter((row) => row.kind === 'unit').length, 1, '双击只能推进一个单元');
    assert.equal(localRows.filter((row) => row.kind === 'unit')[0].status, 'processed');
    assert.equal(localRows.filter((row) => row.kind === 'scope').length, 1, '双击不能写两条范围行');
  } finally { await provider.close(); }

  // 下一单元仍可独立执行：同一 continue 模式下，第二批轮到第 65 个目标自己的单元。
  const ids = queuedIds(65);
  const port2 = patchModel();
  const repo = await seeded(port2, (db) => equip(db, ids));
  try {
    const focus = ids;
    const firstRound = await repo.prepareTurn(turnInput(repo, { worldCompletion: { mode: 'local', focusLocationIds: focus } }));
    await save(repo, firstRound);
    const observeBefore = observeCalls(port2).length;
    const secondRound = await repo.prepareTurn(turnInput(repo, { worldCompletion: { mode: 'local', focusLocationIds: focus }, constructionContinue: true }));
    assert.equal(constructionCalls(port2).length, 2, '继续模式必须真的请求下一个单元');
    assert.equal(observeCalls(port2).length, observeBefore, '继续模式不得发 observe/正文重放');
    await save(repo, secondRound);
    const units = unitRows(repo.db);
    assert.equal(units.length, 2);
    assert.notEqual(units[0].id, units[1].id, '两个单元必须是不同身份');
    assert.equal(units.filter((row) => row.status === 'processed').length, 2);
    assert.equal(targetRows(repo.db).filter((row) => row.status === 'processed').length, 65);
  } finally { await repo.close(); }
});
