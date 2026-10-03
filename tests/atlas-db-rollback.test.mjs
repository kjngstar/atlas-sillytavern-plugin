/**
 * atlas-db-rollback.test.mjs — T14 删楼回退（§18.3 / §7.4 / §6.4 / §17E E08/E09）。
 *
 * §18.3 必须覆盖的断言：
 * - 回退全部 20 表相关状态、时钟、知识、提及：一轮里改地点、改人物位置/心理、改物品数量、
 *   建事件、建信息 + 认知 + 提及候选，回退后逐表恢复到本轮之前；branches 的
 *   clock_s/clock_min_s/clock_max_s 回到目标楼的 clock_before_s，head_turn_id 指向目标楼；
 * - 中间楼后继失效：T1→T2→T3 回退到 T1 时，T2/T3 被标 rolled_back，`planRollback().turns`
 *   同时包含两者（不是把计数器减一），它们的效果不再描述当前状态；
 * - 重演不继承未来信息：回退后从同一基点重演，看不到被回退的未来建立的认知行；
 * - manual / 后台续算归属：两种楼的变更都记在**各自的 turn_id** 上，并随该楼一起回退；
 * - 拒绝语义：别的分支的楼 → REF_UNKNOWN；expectedRevision 不符 → STALE_BASE；
 *   超过 limits → ROLLBACK_TOO_LARGE 且**不截断、不写库**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, selectOne } from './fixtures/atlas-sql/seed.mjs';
import { SOURCE_SNAPSHOT } from './fixtures/atlas-sql/model-cases.mjs';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { planRollback, applyRollbackPlan } from '../src/atlas-db-rollback.ts';
import { applyGroups } from '../src/atlas-db-commit.ts';
import { compileOperations } from '../src/atlas-ops-compile.ts';
import { buildAtomicGroups, orderGroups } from '../src/atlas-ops-groups.ts';
import { defaultMakeId } from '../src/atlas-ops-compile.ts';
import { makeCompileContext } from './helpers/atlas-compile-context.mjs';
import { encodeSnapshot, sha256Hex } from '../src/atlas-db-envelope.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';

const SQL = await (await import('sql.js')).default();
const WALL = 1_700_000_000_000;

function makeId(kind, opId, alias) {
  let h = 0x811c9dc5;
  const text = `${kind}\u0000${opId}\u0000${alias}`;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${kind.slice(0, 3)}_${h.toString(16).padStart(8, '0')}_${Buffer.from(text).toString('hex').slice(-16)}`;
}

function scriptedModel(responses) {
  return {
    calls: [],
    async request(req) {
      this.calls.push(req);
      const text = responses.length > 0 ? responses.shift() : '{"op":"noop"}';
      return { batchId: req.batchId, text, finishReason: 'stop', httpStatus: 200, durationMs: 5 };
    },
  };
}

async function makeRepo(responses = []) {
  const model = scriptedModel(responses);
  const repo = createSqlRepository({ chatUid: IDS.chatA, branchId: IDS.branchMain, branchName: '主线', modelPort: model, now: () => WALL, makeId });
  const seed = await makeSeedWith(SQL);
  const bytes = seed.exportBytes();
  seed.close();
  await repo.open({ bytes });
  return { repo, model };
}

function anchorFor(baseRevision, parentTurnId, hostMessageUid, overrides = {}) {
  return {
    chatUid: IDS.chatA,
    branchId: IDS.branchMain,
    parentTurnId,
    hostMessageUid,
    variantKey: 'v1',
    baseRevision,
    baseStorageRevision: 0,
    inputHash: `input_${hostMessageUid}`,
    ...overrides,
  };
}

function turnInput(anchor, assistantText, overrides = {}) {
  return { anchor, userText: '', assistantText, sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false, ...overrides };
}

async function commitTurn(repo, anchor, assistantText, overrides = {}) {
  const prepared = await repo.prepareTurn(turnInput(anchor, assistantText, overrides));
  await repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'saved' });
  return prepared;
}

function branchRow(repo) {
  return queryBound(repo.db, 'SELECT revision, head_turn_id, clock_s, clock_min_s, clock_max_s FROM branches WHERE id = ?', [IDS.branchMain])[0];
}

/** Coherent settled seed time for rollback assertions; backlog is tested separately. */
function setBranchClock(repo, value) {
  repo.db.run('UPDATE branches SET clock_s = ?, clock_min_s = ?, clock_max_s = ?, simulation_cursor_s = ? WHERE id = ?', [value, value, value, value, IDS.branchMain]);
}

const T1_OPS = [
  '{"op":"location.upsert","ref":"L2","data":{"description":"T1 改过的学校说明"}}',
  '{"op":"character.upsert","ref":"C1","data":{"location_ref":"L3","thought":"T1 的想法"}}',
  '{"op":"item.upsert","ref":"I1","data":{"quantity":9}}',
  '{"op":"event.propose","data":{"title":"T1 事件","phase":"observed","location_ref":"L2","subject_ref":"C1"}}',
  '{"op":"character.upsert","ref":"new:watcher","data":{"name":"夜枭","registration":"watch","source":"W1"}}',
  '{"op":"information.propose","data":{"content":"T1 才知道的事","kind":"observation","recipient_ref":"C1","spread_at_ref":"L2","subject_ref":"L2"}}',
].join('\n');

/* ───────────── T14-01：回退覆盖面（地点/人物/物品/事件/信息/认知/提及） ───────────── */

test('T14-01 回退覆盖面：地点、人物位置与心理、物品数量、事件、信息、认知、提及全部恢复', async () => {
  const { repo } = await makeRepo([T1_OPS]);
  try {
    const t1 = await commitTurn(repo, anchorFor(0, IDS.seedTurn, 'm1'), '第一楼正文。');
    assert.equal(t1.receipt.status, 'committed', `T1 应提交：${t1.receipt.issues.map((i) => i.code).join(',')}`);

    // 本轮确实动了每一类状态
    assert.equal(selectOne(repo.db, 'locations', IDS.branchMain, IDS.L2).description, 'T1 改过的学校说明', 'locations 应被改');
    const c1 = selectOne(repo.db, 'characters', IDS.branchMain, IDS.C1);
    assert.equal(c1.location_id, IDS.L3, 'characters（位置）应被改');
    assert.equal(c1.thought, 'T1 的想法', 'characters（心理）应被改');
    assert.equal(selectOne(repo.db, 'items', IDS.branchMain, IDS.I1).quantity, 9, 'items 应被改');
    assert.equal(queryBound(repo.db, 'SELECT COUNT(*) AS n FROM events WHERE branch_id = ?', [IDS.branchMain])[0].n, 1, 'events 应新增一行');
    const information = queryBound(repo.db, 'SELECT id FROM information WHERE branch_id = ?', [IDS.branchMain]);
    assert.equal(information.length, 1, 'information 应新增一行');
    const knowledge = queryBound(repo.db, 'SELECT id FROM knowledge WHERE branch_id = ?', [IDS.branchMain]);
    assert.equal(knowledge.length, 1, 'knowledge 应新增一行');
    const mentions = queryBound(repo.db, "SELECT id FROM mention_candidates WHERE branch_id = ? AND name = '夜枭'", [IDS.branchMain]);
    assert.equal(mentions.length, 1, 'mention_candidates 应新增一行');

    const rb = await repo.prepareRollback({
      chatUid: IDS.chatA,
      branchId: IDS.branchMain,
      targetParentTurnId: t1.receipt.turnId,
      expectedRevision: 1,
    });
    assert.equal(rb.kind, 'rollback');
    await repo.confirmSaved({ token: rb.token, snapshotSha256: rb.snapshotSha256, result: 'saved' });

    // 逐表恢复（每条断言点名它覆盖的表）
    assert.equal(selectOne(repo.db, 'locations', IDS.branchMain, IDS.L2).description, '', 'locations.description 必须回到本轮之前');
    const c1After = selectOne(repo.db, 'characters', IDS.branchMain, IDS.C1);
    assert.equal(c1After.location_id, IDS.L2, 'characters.location_id 必须回到本轮之前');
    assert.equal(c1After.thought, '', 'characters.thought 必须回到本轮之前');
    assert.equal(c1After.row_rev, 1, 'characters.row_rev 也必须回到本轮之前');
    assert.equal(selectOne(repo.db, 'items', IDS.branchMain, IDS.I1).quantity, 1, 'items.quantity 必须回到本轮之前');
    assert.equal(queryBound(repo.db, 'SELECT COUNT(*) AS n FROM events WHERE branch_id = ?', [IDS.branchMain])[0].n, 0, 'events 本轮新增必须撤销');
    assert.equal(queryBound(repo.db, 'SELECT COUNT(*) AS n FROM information WHERE branch_id = ?', [IDS.branchMain])[0].n, 0, 'information 本轮新增必须撤销');
    assert.equal(queryBound(repo.db, 'SELECT COUNT(*) AS n FROM knowledge WHERE branch_id = ?', [IDS.branchMain])[0].n, 0, 'knowledge 本轮新增必须撤销');
    assert.equal(queryBound(repo.db, 'SELECT COUNT(*) AS n FROM rumor_fronts WHERE branch_id = ?', [IDS.branchMain])[0].n, 0, 'rumor_fronts 本轮新增必须撤销');
    assert.equal(
      queryBound(repo.db, 'SELECT COUNT(*) AS n FROM mention_candidates WHERE branch_id = ?', [IDS.branchMain])[0].n,
      0,
      'mention_candidates 本轮新增必须撤销',
    );
    assert.equal(queryBound(repo.db, "SELECT COUNT(*) AS n FROM characters WHERE branch_id = ? AND name = '夜枭'", [IDS.branchMain])[0].n, 0, '本轮转入候选的人物不得留在正式库');
    assert.deepEqual(queryBound(repo.db, 'PRAGMA foreign_key_check'), [], '回退后外键必须干净');

    // 时钟与 head：恢复到目标楼之前
    const target = queryBound(repo.db, 'SELECT clock_before_s FROM turns WHERE id = ?', [t1.receipt.turnId])[0];
    const branch = branchRow(repo);
    assert.equal(branch.clock_s, Number(target.clock_before_s), 'branches.clock_s 必须回到目标楼的 clock_before_s');
    assert.equal(branch.clock_min_s, Number(target.clock_before_s), 'branches.clock_min_s 必须回到目标楼的 clock_before_s');
    assert.equal(branch.clock_max_s, Number(target.clock_before_s), 'branches.clock_max_s 必须回到目标楼的 clock_before_s');
    assert.equal(branch.head_turn_id, IDS.seedTurn, '撤销目标楼后 head 必须指向仍有效的父楼');
    assert.equal(Number(branch.revision), 2, '回退本身是一次新发布');
    assert.equal(queryBound(repo.db, 'SELECT status FROM turns WHERE id = ?', [t1.receipt.turnId])[0].status, 'rolled_back');
  } finally {
    await repo.close();
  }
});

/* ───────────── T14-02：中间楼后继失效 ───────────── */

test('T14-02 中间楼后继失效：回退到 T1 会同时撤销 T2/T3，plan.turns 两者都在（不是减一）', async () => {
  const { repo } = await makeRepo([
    '{"op":"character.upsert","ref":"C1","data":{"thought":"T1 的想法"}}',
    '{"op":"item.upsert","ref":"I1","data":{"quantity":5}}',
    '{"op":"information.propose","data":{"content":"T3 才知道的事","kind":"observation","recipient_ref":"C1"}}',
    '{"op":"noop"}',
  ]);
  try {
    const t1 = await commitTurn(repo, anchorFor(0, IDS.seedTurn, 'm1'), '一。');
    setBranchClock(repo, 600);
    const t2 = await commitTurn(repo, anchorFor(1, t1.receipt.turnId, 'm2'), '二。');
    setBranchClock(repo, 1200);
    const t3 = await commitTurn(repo, anchorFor(2, t2.receipt.turnId, 'm3'), '三。');
    assert.equal(Number(branchRow(repo).revision), 3);
    assert.equal(selectOne(repo.db, 'items', IDS.branchMain, IDS.I1).quantity, 5, 'T2 的效果在库');
    const infoRows = queryBound(repo.db, 'SELECT id FROM information WHERE branch_id = ?', [IDS.branchMain]);
    assert.equal(infoRows.length, 1, 'T3 的效果在库');
    const infoId = String(infoRows[0].id);

    // 计划：必须同时包含 T2 与 T3（证明不是按数字减一），时钟目标取 T1 之前
    const plan = planRollback({ db: repo.db, branchId: IDS.branchMain, targetTurnId: t1.receipt.turnId, expectedRevision: 3 });
    assert.ok(plan.turns.includes(t2.receipt.turnId), `plan.turns 必须包含中间楼的后继 T2：${plan.turns.join(',')}`);
    assert.ok(plan.turns.includes(t3.receipt.turnId), `plan.turns 必须包含中间楼的后继 T3：${plan.turns.join(',')}`);
    assert.equal(plan.turns.length, 3, '受影响的是 T1/T2/T3 三楼');
    assert.equal(plan.clockBeforeS, 1200, 'clockBeforeS 取当前分支时钟');
    assert.equal(plan.clockTargetS, 0, 'clockTargetS 取目标楼 T1 的 clock_before_s');
    assert.deepEqual(
      [...new Set(plan.steps.filter((s) => s.targetTable !== 'branches').map((s) => s.turnId))],
      [t3.receipt.turnId, t2.receipt.turnId, t1.receipt.turnId],
      '恢复顺序必须是逆因果序：先后继楼再目标楼',
    );

    const rb = await repo.prepareRollback({
      chatUid: IDS.chatA,
      branchId: IDS.branchMain,
      targetParentTurnId: t1.receipt.turnId,
      expectedRevision: 3,
    });
    await repo.confirmSaved({ token: rb.token, snapshotSha256: rb.snapshotSha256, result: 'saved' });

    // T2/T3 被标记 rolled_back，且它们的效果不再描述当前状态
    for (const turnId of [t2.receipt.turnId, t3.receipt.turnId]) {
      assert.equal(queryBound(repo.db, 'SELECT status FROM turns WHERE id = ?', [turnId])[0].status, 'rolled_back', `${turnId} 必须标 rolled_back`);
    }
    assert.equal(selectOne(repo.db, 'items', IDS.branchMain, IDS.I1).quantity, 1, 'T2 改过的 items 行不得再描述当前状态');
    assert.equal(queryBound(repo.db, 'SELECT COUNT(*) AS n FROM information WHERE branch_id = ?', [IDS.branchMain])[0].n, 0, 'T3 建立的 information 不得再存在');
    assert.equal(queryBound(repo.db, 'SELECT COUNT(*) AS n FROM knowledge WHERE branch_id = ?', [IDS.branchMain])[0].n, 0, 'T3 建立的 knowledge 不得再存在');
    assert.equal(selectOne(repo.db, 'characters', IDS.branchMain, IDS.C1).thought, '', 'T1 的改动同样被回退（目标楼自身也要恢复）');

    // 时钟回到 T1 的 clock_before_s；head 指向目标楼
    const branch = branchRow(repo);
    assert.equal(branch.clock_s, 0);
    assert.equal(branch.clock_min_s, 0);
    assert.equal(branch.clock_max_s, 0);
    assert.equal(branch.head_turn_id, IDS.seedTurn, '回退中间楼及后文后 head 指向其父楼');
    assert.equal(Number(branch.revision), 4);

    // turn_changes 里 T2/T3 的「after」不再等于当前行值（记录不再描述当前状态）
    const t2Change = queryBound(repo.db, "SELECT after_json FROM turn_changes WHERE turn_id = ? AND target_table = 'items' LIMIT 1", [t2.receipt.turnId])[0];
    assert.ok(t2Change, 'T2 的 items 变更日志应保留用于诊断');
    assert.equal(JSON.parse(t2Change.after_json).quantity, 5, '日志里记录的仍是当时的 after');
    assert.notEqual(selectOne(repo.db, 'items', IDS.branchMain, IDS.I1).quantity, 5, '但当前行已不等于该 after');
  } finally {
    await repo.close();
  }
});

/* ───────────── T14-03：重演不继承未来信息 ───────────── */

test('T14-03 重演不继承未来信息：回退后新推演看不到被回退未来建立的认知行', async () => {
  const { repo } = await makeRepo([
    '{"op":"character.upsert","ref":"C1","data":{"thought":"T1 的想法"}}',
    '{"op":"character.upsert","ref":"C1","data":{"thought":"T2 的想法"}}',
    '{"op":"information.propose","data":{"content":"T3 才知道的事","kind":"observation","recipient_ref":"C1"}}',
    '{"op":"noop"}',
  ]);
  try {
    const t1 = await commitTurn(repo, anchorFor(0, IDS.seedTurn, 'm1'), '一。');
    const t2 = await commitTurn(repo, anchorFor(1, t1.receipt.turnId, 'm2'), '二。');
    const t3 = await commitTurn(repo, anchorFor(2, t2.receipt.turnId, 'm3'), '三。');

    const infoRows = queryBound(repo.db, 'SELECT id FROM information WHERE branch_id = ?', [IDS.branchMain]);
    const knowledgeRows = queryBound(repo.db, 'SELECT id, information_id FROM knowledge WHERE branch_id = ?', [IDS.branchMain]);
    assert.equal(infoRows.length, 1);
    assert.equal(knowledgeRows.length, 1);
    const futureInfoId = String(infoRows[0].id);
    const futureKnowledgeId = String(knowledgeRows[0].id);

    // 回退前：主角认知视图里确实有这条未来信息
    const beforeView = await repo.queryView({ kind: 'entity', branchId: IDS.branchMain, entityId: IDS.C1 });
    assert.ok(
      beforeView.items[0].knowledge.some((k) => String(k.information_id) === futureInfoId),
      '回退前 C1 的认知里应有 T3 的信息',
    );

    const rb = await repo.prepareRollback({
      chatUid: IDS.chatA,
      branchId: IDS.branchMain,
      targetParentTurnId: t1.receipt.turnId,
      expectedRevision: 3,
    });
    await repo.confirmSaved({ token: rb.token, snapshotSha256: rb.snapshotSha256, result: 'saved' });

    // 被回退的未来行确实消失
    assert.equal(queryBound(repo.db, 'SELECT id FROM information WHERE id = ?', [futureInfoId]).length, 0, 'T3 的信息行必须消失');
    assert.equal(queryBound(repo.db, 'SELECT id FROM knowledge WHERE id = ?', [futureKnowledgeId]).length, 0, 'T3 的认知行必须消失');
    const afterView = await repo.queryView({ kind: 'entity', branchId: IDS.branchMain, entityId: IDS.C1 });
    assert.equal(
      afterView.items[0].knowledge.some((k) => String(k.information_id) === futureInfoId),
      false,
      '重演前的认知视图不得再包含被回退的未来信息',
    );

    // 从同一基点重演：拿着被回退未来的 ID 当依据必须被拒（前提是那一行真的没了）
    const revisionAfterRollback = Number(branchRow(repo).revision);
    await assert.rejects(
      () =>
        repo.prepareTurn(
          turnInput(anchorFor(revisionAfterRollback, t1.receipt.turnId, 'm_replay', { variantKey: 'replay' }), '', {
            manual: true,
            sourceSnapshot: [],
            phaseBatches: [],
            operations: [{ op: 'information.propose', data: { content: '重演时想引用不存在的信息', parent_ref: futureInfoId } }],
          }),
        ),
      (err) => {
        assert.equal(err.code, 'TURN_FAILED', `重演若拿被回退未来当依据，必须整轮失败：${err.code}`);
        const codes = err.detail.receipt.issues.map((i) => i.code);
        assert.ok(codes.includes('REF_UNKNOWN'), `必须报 REF_UNKNOWN，实际 ${codes.join(',')}`);
        return true;
      },
    );
    assert.equal(
      queryBound(repo.db, "SELECT COUNT(*) AS n FROM information WHERE content = '重演时想引用不存在的信息'")[0].n,
      0,
      '不存在的父信息不得被重演凭空建出来',
    );
    assert.equal(selectOne(repo.db, 'characters', IDS.branchMain, IDS.C1).thought, '', '失败的重演不得改动正式库');

    // 同一基点的正常重演仍然可以提交（回退不是把聊天锁死）
    const fresh = await repo.prepareTurn(
      turnInput(anchorFor(revisionAfterRollback, t1.receipt.turnId, 'm_fresh', { variantKey: 'fresh' }), '重演正文。'),
    );
    assert.equal(fresh.receipt.status, 'noop', '模型输出 noop 时重演应正常返回，而不是继承未来信息');
    assert.equal(selectOne(repo.db, 'characters', IDS.branchMain, IDS.C1).thought, '', '重演不会把 T2 的心理带回来');
  } finally {
    await repo.close();
  }
});

/* ───────────── T14-04：manual / 后台续算归属 ───────────── */

test('T14-04 manual 与后台续算归属：各记自己的 turn_id，并随该楼一起回退', async () => {
  const { repo } = await makeRepo([]);
  try {
    // manual 楼：kind=manual，变更记在它自己的 turn_id 上
    const manual = await repo.prepareTurn({
      anchor: anchorFor(0, IDS.seedTurn, 'm_manual', { variantKey: 'manual' }),
      userText: '手动改',
      assistantText: '',
      sourceSnapshot: [],
      phaseBatches: [],
      manual: true,
      operations: [{ op: 'character.upsert', ref: 'C1', data: { thought: '手动编辑的想法' } }],
    });
    assert.equal(manual.receipt.status, 'committed');
    await repo.confirmSaved({ token: manual.token, snapshotSha256: manual.snapshotSha256, result: 'saved' });
    assert.equal(queryBound(repo.db, 'SELECT kind FROM turns WHERE id = ?', [manual.receipt.turnId])[0].kind, 'manual');
    const manualChanges = queryBound(repo.db, 'SELECT DISTINCT turn_id FROM turn_changes WHERE turn_id = ?', [manual.receipt.turnId]);
    assert.equal(manualChanges.length, 1, 'manual 的变更必须记在自己的 turn_id 上');
    assert.equal(selectOne(repo.db, 'characters', IDS.branchMain, IDS.C1).thought, '手动编辑的想法');

    // 后台续算楼：kind=background，parent 指向触发它的 manual 楼
    const backgroundTurnId = 'turn_background_m14';
    const backgroundAnchor = anchorFor(1, manual.receipt.turnId, 'm_background', { variantKey: 'background' });
    const backgroundOps = [
      { opId: 'op_bg_1', line: 1, rawHash: 'h_bg_1', value: { op: 'character.upsert', ref: 'C2', data: { thought: '后台续算的想法' } } },
    ];
    const seed = { db: repo.db, refs: [
      { alias: 'L1', id: IDS.L1, kind: 'location' },
      { alias: 'L2', id: IDS.L2, kind: 'location' },
      { alias: 'L3', id: IDS.L3, kind: 'location' },
      { alias: 'C1', id: IDS.C1, kind: 'character' },
      { alias: 'C2', id: IDS.C2, kind: 'character' },
      { alias: 'C3', id: IDS.C3, kind: 'character' },
      { alias: 'C4', id: IDS.C4, kind: 'character' },
      { alias: 'I1', id: IDS.I1, kind: 'item' },
      { alias: 'F1', id: IDS.F1, kind: 'faction' },
      { alias: 'M1', id: IDS.M1, kind: 'map' },
      { alias: 'M2', id: IDS.M2, kind: 'map' },
    ] };
    const context = makeCompileContext({ seed, anchor: backgroundAnchor, revision: 1 });
    const compiled = compileOperations({
      operations: backgroundOps,
      anchor: backgroundAnchor,
      phase: 'observe',
      clockS: 0,
      revision: 1,
      tables: context.tables,
      sources: { phase: 'observe', snapshot: [], clockS: 0 },
      makeId: defaultMakeId(backgroundAnchor),
      knownRefs: seed.refs.map((r) => ({ alias: r.alias, id: r.id, kind: r.kind, rowRev: 1 })),
    });
    const built = buildAtomicGroups(
      compiled.results.map((r) => ({
        opId: r.opId,
        issues: r.result.issues,
        mutations: r.result.mutations,
        readSet: r.result.readSet,
        dependencies: r.result.dependencies,
        entityKeyWrites: r.result.entityKeyWrites,
        operationKeys: r.result.operationKeys,
      })),
    );
    const ordered = orderGroups(built.groups);
    repo.db.run('BEGIN');
    try {
      repo.db.run(
        `INSERT INTO turns (id, branch_id, parent_turn_id, host_message_uid, host_variant_key, kind, input_hash, story_hash,
                            base_revision, committed_revision, clock_before_s, elapsed_json, clock_after_s, rng_seed,
                            ruleset_version, decisions_json, receipt_json, attempts_json, status, created_wall_ms, prepared_wall_ms)
         VALUES (?, ?, ?, NULL, NULL, 'background', ?, NULL, 1, 2, 0, ?, 0, ?, 'atlas-1', '{}', NULL, '[]', 'committed', ?, ?)`,
        [
          backgroundTurnId,
          IDS.branchMain,
          manual.receipt.turnId,
          'hash_bg',
          JSON.stringify({ min_s: 0, nominal_s: 0, max_s: 0, quality: 'unknown', basis_refs: [] }),
          'rng_bg',
          WALL + 500,
          WALL + 500,
        ],
      );
      applyGroups(repo.db, ordered.order, { branchId: IDS.branchMain, turnId: backgroundTurnId, attemptId: 'attempt_bg' });
      repo.db.run('UPDATE branches SET revision = 2, head_turn_id = ?, clock_s = 300, clock_min_s = 300, clock_max_s = 300 WHERE id = ?', [
        backgroundTurnId,
        IDS.branchMain,
      ]);
      repo.db.run('COMMIT');
    } catch (err) {
      repo.db.run('ROLLBACK');
      throw err;
    }

    assert.equal(queryBound(repo.db, 'SELECT kind FROM turns WHERE id = ?', [backgroundTurnId])[0].kind, 'background');
    assert.equal(selectOne(repo.db, 'characters', IDS.branchMain, IDS.C2).thought, '后台续算的想法');
    const bgChanges = queryBound(repo.db, 'SELECT DISTINCT turn_id FROM turn_changes WHERE turn_id = ?', [backgroundTurnId]);
    assert.equal(bgChanges.length, 1, '后台续算的变更必须记在自己的 turn_id 上');
    assert.equal(bgChanges[0].turn_id, backgroundTurnId);

    // 回退 manual 楼：它自己与后台续算（因果后继）都要一起回退
    const plan = planRollback({ db: repo.db, branchId: IDS.branchMain, targetTurnId: manual.receipt.turnId, expectedRevision: 2 });
    assert.ok(plan.turns.includes(backgroundTurnId), `后台续算是 manual 楼的后继，必须一起回退：${plan.turns.join(',')}`);
    const rb = await repo.prepareRollback({
      chatUid: IDS.chatA,
      branchId: IDS.branchMain,
      targetParentTurnId: manual.receipt.turnId,
      expectedRevision: 2,
    });
    await repo.confirmSaved({ token: rb.token, snapshotSha256: rb.snapshotSha256, result: 'saved' });

    assert.equal(selectOne(repo.db, 'characters', IDS.branchMain, IDS.C1).thought, '', 'manual 楼的改动随它自己回退');
    assert.equal(selectOne(repo.db, 'characters', IDS.branchMain, IDS.C2).thought, '', '后台续算的改动随触发楼回退');
    assert.equal(
      queryBound(repo.db, 'SELECT status FROM turns WHERE id = ?', [backgroundTurnId])[0].status,
      'rolled_back',
      '后台续算楼必须随触发楼标 rolled_back',
    );
    const branch = branchRow(repo);
    assert.equal(branch.head_turn_id, IDS.seedTurn, '回退后 head 指向仍有效的父楼');
    assert.equal(branch.clock_s, 0);
  } finally {
    await repo.close();
  }
});

/* ───────────── T14-05：拒绝语义（不写库） ───────────── */

test('T14-05 拒绝语义：别的分支 REF_UNKNOWN、版本不符 STALE_BASE、超限 ROLLBACK_TOO_LARGE 且不写库', async () => {
  const { repo } = await makeRepo([
    '{"op":"character.upsert","ref":"C1","data":{"thought":"T1 的想法"}}',
    '{"op":"character.upsert","ref":"C1","data":{"thought":"T2 的想法"}}',
  ]);
  try {
    const t1 = await commitTurn(repo, anchorFor(0, IDS.seedTurn, 'm1'), '一。');
    const t2 = await commitTurn(repo, anchorFor(1, t1.receipt.turnId, 'm2'), '二。');
    const before = await sha256Hex(await repo.exportCurrent());

    // 别的分支的楼
    assert.throws(
      () => planRollback({ db: repo.db, branchId: IDS.branchMain, targetTurnId: IDS.seedTurnB }),
      (err) => err.code === 'REF_UNKNOWN',
    );
    // 不存在的楼
    assert.throws(
      () => planRollback({ db: repo.db, branchId: IDS.branchMain, targetTurnId: 'turn_does_not_exist' }),
      (err) => err.code === 'REF_UNKNOWN',
    );
    // 版本不符
    assert.throws(
      () => planRollback({ db: repo.db, branchId: IDS.branchMain, targetTurnId: t1.receipt.turnId, expectedRevision: 1 }),
      (err) => err.code === 'STALE_BASE',
    );
    // 超过 limits：明确拒绝，不截断
    assert.throws(
      () => planRollback({ db: repo.db, branchId: IDS.branchMain, targetTurnId: t1.receipt.turnId, expectedRevision: 2 }, { maxTurns: 1 }),
      (err) => err.code === 'ROLLBACK_TOO_LARGE',
    );
    const overSteps = (() => {
      try {
        planRollback({ db: repo.db, branchId: IDS.branchMain, targetTurnId: t1.receipt.turnId, expectedRevision: 2 }, { maxSteps: 1 });
        return null;
      } catch (err) {
        return err;
      }
    })();
    assert.ok(overSteps, 'maxSteps 超限必须抛错');
    assert.equal(overSteps.code, 'ROLLBACK_TOO_LARGE');
    assert.equal(overSteps.detail.issues[0].retryable, false, '超限是不可重试的明确拒绝');

    // 拒绝过程一个字节都不能写
    assert.equal(await sha256Hex(await repo.exportCurrent()), before, '被拒绝的计划不得改动正式库');
    assert.equal(selectOne(repo.db, 'characters', IDS.branchMain, IDS.C1).thought, 'T2 的想法');
    assert.equal(Number(branchRow(repo).revision), 2);
    assert.equal(branchRow(repo).head_turn_id, t2.receipt.turnId);

    // 仓库入口的拒绝语义
    await assert.rejects(
      () => repo.prepareRollback({ chatUid: IDS.chatA, branchId: IDS.branchMain, targetParentTurnId: t1.receipt.turnId, expectedRevision: 1 }),
      (err) => err.code === 'STALE_BASE',
    );
    await assert.rejects(
      () => repo.prepareRollback({ chatUid: IDS.chatA, branchId: IDS.branchMain, targetParentTurnId: 'turn_missing', expectedRevision: 2 }),
      (err) => err.code === 'REF_UNKNOWN',
    );
    await assert.rejects(
      () => repo.prepareRollback({ chatUid: IDS.chatB, branchId: IDS.branchMain, targetParentTurnId: t1.receipt.turnId, expectedRevision: 2 }),
      (err) => err.code === 'CHAT_CHANGED',
    );
    assert.equal(await sha256Hex(await repo.exportCurrent()), before, '仓库入口的拒绝同样不得改动正式库');

    // applyRollbackPlan 在调用方事务里失败必须整体回滚，不留半截状态
    const plan = planRollback({ db: repo.db, branchId: IDS.branchMain, targetTurnId: t1.receipt.turnId, expectedRevision: 2 });
    const corrupt = {
      ...plan,
      steps: [...plan.steps, {
        sequence: plan.steps.length + 1,
        turnId: t1.receipt.turnId,
        changeId: 'chg_broken',
        targetTable: 'characters',
        targetRowId: IDS.C1,
        operation: 'update',
        restore: { branch_id: IDS.branchMain, id: IDS.C1, 不存在的列: 1 },
        basis: {},
        summary: '损坏的恢复行',
      }],
    };
    const candidate = await repo.createCandidate(anchorFor(2, t2.receipt.turnId, 'm_rb', { variantKey: 'rollback' }), 'rollback');
    const candidateBefore = candidate.db.export();
    candidate.db.run('BEGIN');
    await assert.rejects(
      () => applyRollbackPlan(candidate.db, corrupt, { turnId: 'turn_rb', attemptId: 'a1' }),
      (err) => err.code === 'ROLLBACK_PLAN_INVALID',
    );
    candidate.db.run('ROLLBACK');
    assert.equal(await sha256Hex(candidate.db.export()), await sha256Hex(candidateBefore), '失败的 applyRollbackPlan 必须整体回滚');
    await repo.discardPrepared(candidate.token);

    // 正常计划仍然可用（拒绝没有把能力一起关掉）
    const good = await repo.prepareRollback({ chatUid: IDS.chatA, branchId: IDS.branchMain, targetParentTurnId: t1.receipt.turnId, expectedRevision: 2 });
    await repo.confirmSaved({ token: good.token, snapshotSha256: good.snapshotSha256, result: 'saved' });
    assert.equal(selectOne(repo.db, 'characters', IDS.branchMain, IDS.C1).thought, '', '合法回退仍必须生效');
    void encodeSnapshot;
  } finally {
    await repo.close();
  }
});
