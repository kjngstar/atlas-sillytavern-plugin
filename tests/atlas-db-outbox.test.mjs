/**
 * atlas-db-outbox.test.mjs — T25（§18.3 / §6.6 / §7.3 / §7.4 / §17E E08 / §17G G12–G14）。
 *
 * 覆盖：
 * - 同步失败核心仍保存（runNextSync 失败后 characters 行数不变，任务记 failed + 退避重试）；
 * - 旧 revision 任务取消（enqueueProjectionSync 第二次把第一条置 superseded；同键重复入队是幂等）；
 * - 删楼重建：`planRollback`/`applyRollbackPlan`（E08）能定位**中间楼的后继**、按逆因果序恢复 before、
 *   拒绝 STALE_BASE/REF_UNKNOWN/ROLLBACK_TOO_LARGE，回退后重新入队生成**当前版本**的意图；
 * - 切聊天不覆盖：不同 chatUid 的投影互不写，跨聊天/跨分支条目一律拒绝；
 * - 只改插件管理条目：rebuildManagedLorebook 保留 `user:` 前缀与别的 `atlas:<other-chat>` 条目；
 * - 维护保存不推进世界、不生成循环同步（prepareMaintenance 后 revision/head/clock 不变、outbox 行数不增）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, countRows, inTransaction, selectOne, foreignKeyCheck } from './fixtures/atlas-sql/seed.mjs';
import { SOURCE_SNAPSHOT } from './fixtures/atlas-sql/model-cases.mjs';
import { makeAnchor, makeCompileContext } from './helpers/atlas-compile-context.mjs';
import { extractPayload, parseOperations } from '../src/atlas-ops-parser.ts';
import { compileOperations } from '../src/atlas-ops-compile.ts';
import { buildAtomicGroups, orderGroups } from '../src/atlas-ops-groups.ts';
import { applyGroups } from '../src/atlas-db-commit.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { planRollback, applyRollbackPlan } from '../src/atlas-db-rollback.ts';
import {
  enqueueProjectionSync,
  listOutbox,
  projectionHash,
  rebuildManagedLorebook,
  runNextSync,
} from '../src/atlas-db-outbox.ts';

const SQL = await (await import('sql.js')).default();
const WALL = 1_700_000_000_000;

/** 确定性 makeId：包含完整 (kind, opId, alias)，避免只截前缀导致不同键撞同一个 ID。 */
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

async function makeRepo(responses) {
  const model = scriptedModel(responses);
  const repo = createSqlRepository({
    chatUid: IDS.chatA,
    branchId: IDS.branchMain,
    branchName: '主线',
    modelPort: model,
    now: () => WALL,
    makeId,
  });
  const seed = await makeSeedWith(SQL);
  const bytes = seed.exportBytes();
  seed.close();
  await repo.open({ bytes });
  return { repo, model };
}

function anchorFor(baseRevision, overrides = {}) {
  return {
    chatUid: IDS.chatA,
    branchId: IDS.branchMain,
    parentTurnId: IDS.seedTurn,
    hostMessageUid: 'msg_outbox',
    variantKey: 'v1',
    baseRevision,
    baseStorageRevision: 0,
    inputHash: 'input_outbox',
    ...overrides,
  };
}

/** 内存世界书端口（不同聊天共用一个存储，用来验证「互不覆盖」）。 */
function memoryPort(memory = new Map()) {
  return {
    memory,
    async listKeys() {
      return [...memory.keys()];
    },
    async read(key) {
      return memory.has(key) ? memory.get(key) : null;
    },
    async write(entries) {
      for (const entry of entries) memory.set(entry.key, entry.content);
    },
    async remove(keys) {
      for (const key of keys) memory.delete(key);
    },
  };
}

function projectionFor(chatUid, branchId, scope, revision) {
  return {
    key: `atlas:${chatUid}:${branchId}:${scope}`,
    chatUid,
    branchId,
    scope,
    revision,
    content: `revision ${revision}`,
  };
}

/* ───────────── T25-01：同步失败不丢核心 ───────────── */

test('T25-01 世界书同步失败：核心回合仍已保存，任务记 failed 并等退避重试', async () => {
  const { repo } = await makeRepo(['{"op":"character.upsert","ref":"new:smith","data":{"name":"铁匠","identity":"城里的铁匠"}}']);
  try {
    const prepared = await repo.prepareTurn({
      anchor: anchorFor(0),
      userText: '',
      assistantText: '铁匠在铺子里。',
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    assert.equal(prepared.receipt.status, 'committed');
    await repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'saved' });
    const beforeCount = countRows(repo.db, 'characters', IDS.branchMain);
    assert.equal(beforeCount, 5, '核心数据已保存（含新铁匠）');

    const tasks = listOutbox(repo.db, IDS.branchMain, ['pending']);
    assert.equal(tasks.length, 1, '提交成功登记一条同步意图');
    assert.equal(tasks[0].target_revision, 1);

    const failing = {
      listKeys: async () => [],
      read: async () => null,
      write: async () => {
        throw new Error('世界书暂时不可用');
      },
      remove: async () => {},
    };
    const outcome = await runNextSync(repo.db, failing, {
      branchId: IDS.branchMain,
      chatUid: IDS.chatA,
      nowWallMs: WALL,
      buildProjection: (scope, revision) => [projectionFor(IDS.chatA, IDS.branchMain, scope, revision)],
    });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.errorCode, 'WORLD_SYNC_FAILED');
    assert.equal(outcome.attemptCount, 1);
    assert.ok(outcome.nextRetryWallMs > WALL, '失败要留退避时间，不能无限重试');
    assert.equal(countRows(repo.db, 'characters', IDS.branchMain), beforeCount, '同步失败不得丢核心回合');

    const after = listOutbox(repo.db, IDS.branchMain);
    assert.equal(after.length, 1, '同步失败不生成新任务');
    assert.equal(after[0].status, 'failed');
    assert.equal(after[0].last_error_code, 'WORLD_SYNC_FAILED');
    assert.equal(after[0].attempt_count, 1);
    assert.ok(String(after[0].last_error_message).includes('世界书暂时不可用'));

    // 到点重试成功：不再留待办，也不产生循环新任务。
    const memory = memoryPort();
    const ok = await runNextSync(repo.db, memory, {
      branchId: IDS.branchMain,
      chatUid: IDS.chatA,
      nowWallMs: outcome.nextRetryWallMs,
      buildProjection: (scope, revision) => [projectionFor(IDS.chatA, IDS.branchMain, scope, revision)],
    });
    assert.equal(ok.status, 'succeeded');
    assert.equal(listOutbox(repo.db, IDS.branchMain).length, 1, '同步结果不产生新任务');
    assert.equal([...memory.memory.keys()].length, 1);
    assert.equal(countRows(repo.db, 'characters', IDS.branchMain), beforeCount);
  } finally {
    await repo.close();
  }
});

/* ───────────── T25-02：旧 revision 任务取消 ───────────── */

test('T25-02 旧 revision 任务取消：第二次入队把第一条置 superseded，同键重复入队幂等', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const input = {
      branchId: IDS.branchMain,
      turnId: IDS.seedTurn,
      targetRevision: 1,
      projectionScope: 'pov',
      payloadHash: 'hash_r1',
      nowWallMs: WALL,
      makeId: (key) => makeId('outbox', key, 'pov'),
    };
    const first = enqueueProjectionSync(seed.db, input);
    assert.equal(first.enqueued, true);
    assert.deepEqual(first.superseded, []);

    const duplicate = enqueueProjectionSync(seed.db, { ...input, nowWallMs: WALL + 1 });
    assert.equal(duplicate.enqueued, false, '同 (branch, scope, revision, hash) 不重复入队');
    assert.equal(duplicate.taskId, first.taskId);
    assert.equal(listOutbox(seed.db, IDS.branchMain).length, 1);

    const second = enqueueProjectionSync(seed.db, {
      ...input,
      targetRevision: 2,
      payloadHash: 'hash_r2',
      nowWallMs: WALL + 2,
      makeId: (key) => makeId('outbox', key, 'pov2'),
    });
    assert.deepEqual(second.superseded, [first.taskId], '旧 revision 的待办必须取消');

    const rows = listOutbox(seed.db, IDS.branchMain);
    const firstRow = rows.find((r) => r.id === first.taskId);
    const secondRow = rows.find((r) => r.id === second.taskId);
    assert.equal(firstRow.status, 'superseded');
    assert.equal(firstRow.completed_wall_ms, WALL + 2);
    assert.equal(secondRow.status, 'pending');
    assert.equal(secondRow.target_revision, 2);
    assert.deepEqual(foreignKeyCheck(seed.db), []);
  } finally {
    seed.close();
  }
});

/* ───────────── T25-03：删楼重建（E08 计划 + 当前版本意图） ───────────── */

function compileForTurn(seed, responseText, turnId) {
  const anchor = { ...makeAnchor(), parentTurnId: turnId, hostMessageUid: `msg_${turnId}` };
  const extracted = extractPayload(responseText);
  const parsed = parseOperations(extracted.payload, { phase: 'observe' });
  const context = makeCompileContext({ seed, anchor });
  const compiled = compileOperations({
    operations: parsed.operations,
    anchor,
    phase: 'observe',
    clockS: 0,
    revision: 0,
    tables: context.tables,
    sources: { phase: 'observe', snapshot: [], clockS: 0 },
    knownRefs: seed.refs,
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
  return orderGroups(built.groups);
}

function addTurn(db, turnId, parentTurnId, clockBeforeS, clockAfterS, wallMs) {
  inTransaction(db, () => {
    db.run(
      `INSERT INTO turns (id, branch_id, parent_turn_id, host_message_uid, host_variant_key, kind, input_hash, story_hash,
                          base_revision, committed_revision, clock_before_s, elapsed_json, clock_after_s, rng_seed,
                          ruleset_version, decisions_json, receipt_json, attempts_json, status, created_wall_ms, prepared_wall_ms)
       VALUES (?, ?, ?, NULL, NULL, 'narrative', ?, NULL, 0, 0, ?, ?, ?, ?, 'atlas-1', '{}', NULL, '[]', 'committed', ?, ?)`,
      [
        turnId,
        IDS.branchMain,
        parentTurnId,
        `hash_${turnId}`,
        clockBeforeS,
        JSON.stringify({ min_s: 0, nominal_s: 0, max_s: 0, quality: 'explicit', basis_refs: [] }),
        clockAfterS,
        `rng_${turnId}`,
        wallMs,
        wallMs,
      ],
    );
  });
}

function applyTurn(seed, compiled, turnId, attemptId) {
  const db = seed.db;
  db.run('BEGIN');
  try {
    const applied = applyGroups(db, compiled.order, { branchId: IDS.branchMain, turnId, attemptId });
    db.run('COMMIT');
    return applied;
  } catch (err) {
    try {
      db.run('ROLLBACK');
    } catch {
      /* 保留原始错误 */
    }
    throw err;
  }
}

test('T25-03 删楼重建：E08 计划定位中间楼的后继，回退后重新入队当前版本的意图', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    addTurn(seed.db, 'turn_A2', IDS.seedTurn, 50, 100, WALL + 1000);
    addTurn(seed.db, 'turn_A3', 'turn_A2', 150, 200, WALL + 2000);
    addTurn(seed.db, 'turn_Asib', IDS.seedTurn, 50, 120, WALL + 3000);

    // A2 建立「甲」；A3 改 C1 心理并建立「乙」；兄弟楼 Asib 建立「丙」（不在 A2 的后继里）。
    applyTurn(seed, compileForTurn(seed, '{"op":"character.upsert","ref":"new:jia","data":{"name":"甲","identity":"A2 的人"}}', 'turn_A2'), 'turn_A2', 'attempt_a2');
    applyTurn(
      seed,
      compileForTurn(
        seed,
        [
          '{"op":"character.upsert","ref":"C1","data":{"thought":"A3 的想法"}}',
          '{"op":"character.upsert","ref":"new:yi","data":{"name":"乙","identity":"A3 的人"}}',
        ].join('\n'),
        'turn_A3',
      ),
      'turn_A3',
      'attempt_a3',
    );
    applyTurn(seed, compileForTurn(seed, '{"op":"character.upsert","ref":"new:bing","data":{"name":"丙","identity":"兄弟楼的人"}}', 'turn_Asib'), 'turn_Asib', 'attempt_sib');

    inTransaction(seed.db, () => {
      seed.db.run(
        'UPDATE branches SET head_turn_id = ?, revision = ?, clock_s = ?, clock_min_s = ?, clock_max_s = ?, simulation_cursor_s = ? WHERE id = ?',
        ['turn_A3', 3, 250, 250, 250, 250, IDS.branchMain],
      );
      seed.db.run('UPDATE characters SET thought = ? WHERE branch_id = ? AND id = ?', ['A3 的想法', IDS.branchMain, IDS.C1]);
    });

    // 回退前已有 revision 3 的待办：回退后它必须被当前版本的意图取代。
    const beforeTask = enqueueProjectionSync(seed.db, {
      branchId: IDS.branchMain,
      turnId: 'turn_A3',
      targetRevision: 3,
      projectionScope: 'pov',
      payloadHash: 'hash_r3',
      nowWallMs: WALL,
      makeId: (key) => makeId('outbox', key, 'r3'),
    });

    // 拒绝语义：版本不符 / 别的分支的楼 / 不存在的楼 / 超过 limits。
    assert.throws(() => planRollback({ db: seed.db, branchId: IDS.branchMain, targetTurnId: 'turn_A2', expectedRevision: 2 }), (err) => err.code === 'STALE_BASE');
    assert.throws(() => planRollback({ db: seed.db, branchId: IDS.branchMain, targetTurnId: IDS.seedTurnB }), (err) => err.code === 'REF_UNKNOWN');
    assert.throws(() => planRollback({ db: seed.db, branchId: IDS.branchMain, targetTurnId: 'turn_missing' }), (err) => err.code === 'REF_UNKNOWN');
    assert.throws(
      () => planRollback({ db: seed.db, branchId: IDS.branchMain, targetTurnId: 'turn_A2' }, { maxTurns: 1 }),
      (err) => err.code === 'ROLLBACK_TOO_LARGE',
    );
    assert.throws(
      () => planRollback({ db: seed.db, branchId: IDS.branchMain, targetTurnId: 'turn_A2' }, { maxSteps: 1 }),
      (err) => err.code === 'ROLLBACK_TOO_LARGE',
    );

    const plan = planRollback({ db: seed.db, branchId: IDS.branchMain, targetTurnId: 'turn_A2', expectedRevision: 3 });
    assert.deepEqual(plan.turns, ['turn_A3', 'turn_A2'], '逆因果序：后代先回退');
    assert.ok(!plan.turns.includes('turn_Asib'), '兄弟楼不是该楼的后继，不受影响');
    assert.equal(plan.affectedTurns, 2);
    assert.equal(plan.clockBeforeS, 250, 'clockBeforeS 取当前分支时钟');
    assert.equal(plan.clockTargetS, 50, 'clockTargetS 取目标楼 clock_before_s（不凭空换算）');
    assert.equal(plan.tableCounts.characters, 3, 'A3 的 C1/乙 + A2 的甲');
    assert.equal(plan.tableCounts.entity_keys, 2, '新建实体的身份行同样要回退');
    assert.equal(plan.tableCounts.branches, 1, '分支可回退字段用一条显式 step 表达');
    // 逆因果序：后代的步骤全部排在祖先前面，分支那条显式 step 永远最后。
    const turnOrder = [...new Set(plan.steps.map((s) => s.turnId))];
    assert.deepEqual(turnOrder, ['turn_A3', 'turn_A2'], '先回退后继楼，再回退目标楼');
    assert.equal(plan.steps[plan.steps.length - 1].targetTable, 'branches');
    // 同楼内必须按变更 sequence 逆序（用日志原序列校验，不靠猜）。
    for (const turnId of ['turn_A3', 'turn_A2']) {
      const logged = queryBound(seed.db, 'SELECT id FROM turn_changes WHERE turn_id = ? ORDER BY sequence DESC', [turnId]);
      const planned = plan.steps
        .filter((s) => s.turnId === turnId && s.targetTable !== 'branches')
        .map((s) => s.changeId);
      assert.deepEqual(planned, logged.map((row) => String(row.id)), `${turnId} 内逆序恢复 before`);
    }
    // 新建实体的行先删详情再删身份，避免 ON DELETE RESTRICT。
    assert.deepEqual(
      plan.steps
        .filter((s) => s.turnId === 'turn_A2' && s.targetTable !== 'branches')
        .map((s) => `${s.targetTable}:${s.operation}`),
      ['characters:insert', 'entity_keys:insert'],
    );
    const branchStep = plan.steps[plan.steps.length - 1];
    assert.equal(branchStep.targetRowId, IDS.branchMain);
    assert.equal(branchStep.restore.head_turn_id, IDS.seedTurn, '删楼后 head 指回该楼的父楼');
    assert.equal(branchStep.restore.clock_s, 50);
    assert.equal(branchStep.restore.revision, 4, '回退本身是新版本');
    assert.ok(!plan.steps.some((s) => ['turns', 'turn_changes', 'sync_outbox'].includes(s.targetTable)), '非日志化表不进 steps');

    // 调用方先写入回退 turn（E09 的顺序），本函数只应用计划。
    addTurn(seed.db, 'turn_rollback_1', 'turn_A3', 250, 50, WALL + 5000);

    seed.db.run('BEGIN');
    let applied;
    try {
      applied = await applyRollbackPlan(seed.db, plan, { turnId: 'turn_rollback_1', attemptId: 'attempt_rb' });
      seed.db.run('COMMIT');
    } catch (err) {
      seed.db.run('ROLLBACK');
      throw err;
    }
    assert.equal(applied.restored, plan.steps.length);
    assert.deepEqual(foreignKeyCheck(seed.db), []);

    const gone = (name) => seed.db.exec('SELECT COUNT(*) FROM characters WHERE branch_id = ? AND name = ?', [IDS.branchMain, name])[0].values[0][0];
    assert.equal(gone('甲'), 0, '目标楼建立的实体必须消失');
    assert.equal(gone('乙'), 0, '后继楼建立的实体同样回退');
    assert.equal(gone('丙'), 1, '兄弟楼不受影响');
    assert.equal(selectOne(seed.db, 'characters', IDS.branchMain, IDS.C1).thought, '', 'C1 心理恢复到变更前');
    const branch = queryBound(seed.db, 'SELECT head_turn_id, revision, clock_s, clock_min_s, clock_max_s, simulation_cursor_s FROM branches WHERE id = ?', [IDS.branchMain])[0];
    assert.equal(branch.head_turn_id, IDS.seedTurn);
    assert.equal(Number(branch.revision), 4);
    assert.equal(Number(branch.clock_s), 50);
    assert.equal(Number(branch.simulation_cursor_s), 50);

    // 回退后重新入队：生成当前版本（4）的意图，旧版本待办变 superseded。
    const rebuild = enqueueProjectionSync(seed.db, {
      branchId: IDS.branchMain,
      turnId: 'turn_rollback_1',
      targetRevision: Number(branch.revision),
      projectionScope: 'pov',
      payloadHash: projectionHash({ rollback: 'turn_A2', revision: Number(branch.revision) }),
      nowWallMs: WALL + 10,
      makeId: (key) => makeId('outbox', key, 'rollback'),
    });
    assert.equal(rebuild.enqueued, true);
    assert.deepEqual(rebuild.superseded, [beforeTask.taskId], '旧 revision 任务被取消');
    const tasks = listOutbox(seed.db, IDS.branchMain);
    assert.equal(tasks.find((t) => t.id === beforeTask.taskId).status, 'superseded');
    const current = tasks.find((t) => t.id === rebuild.taskId);
    assert.equal(current.status, 'pending');
    assert.equal(current.target_revision, 4, '重建任务必须是当前版本');
  } finally {
    seed.close();
  }
});

/* ───────────── T25-04：真实 Repository 的删楼重建 ───────────── */

test('T25-04 删楼重建（真实 Repository）：回退确认后 outbox 只剩当前版本待办', async () => {
  const { repo } = await makeRepo([
    '{"op":"character.upsert","ref":"new:first","data":{"name":"第一个","identity":"第一楼的人"}}',
    '{"op":"character.upsert","ref":"new:second","data":{"name":"第二个","identity":"第二楼的人"}}',
  ]);
  try {
    const first = await repo.prepareTurn({
      anchor: anchorFor(0, { hostMessageUid: 'm1' }),
      userText: '',
      assistantText: '第一楼。',
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    await repo.confirmSaved({ token: first.token, snapshotSha256: first.snapshotSha256, result: 'saved' });
    assert.equal(first.receipt.status, 'committed');

    const second = await repo.prepareTurn({
      anchor: anchorFor(1, { hostMessageUid: 'm2', parentTurnId: first.receipt.turnId, variantKey: 'v1' }),
      userText: '',
      assistantText: '第二楼。',
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    await repo.confirmSaved({ token: second.token, snapshotSha256: second.snapshotSha256, result: 'saved' });
    assert.equal(countRows(repo.db, 'characters', IDS.branchMain), 6);

    const rollback = await repo.prepareRollback({
      chatUid: IDS.chatA,
      branchId: IDS.branchMain,
      targetParentTurnId: second.receipt.turnId,
      expectedRevision: 2,
    });
    await repo.confirmSaved({ token: rollback.token, snapshotSha256: rollback.snapshotSha256, result: 'saved' });

    // 删除第二楼：撤销该楼及后继，业务 head 必须恢复为仍有效的第一楼。
    assert.equal(countRows(repo.db, 'characters', IDS.branchMain), 5, '被回退那一楼建立的实体消失');
    const branch = queryBound(repo.db, 'SELECT head_turn_id, revision FROM branches WHERE id = ?', [IDS.branchMain])[0];
    assert.equal(branch.head_turn_id, first.receipt.turnId);
    assert.equal(Number(branch.revision), 3);
    assert.equal(
      queryBound(repo.db, "SELECT COUNT(*) AS n FROM characters WHERE name = ?", ['第一个'])[0].n,
      1,
      '前一楼建立的人物保留',
    );

    const tasks = listOutbox(repo.db, IDS.branchMain);
    const pending = tasks.filter((t) => t.status === 'pending');
    assert.equal(pending.length, 1, '回退后只留当前版本的一条待办');
    assert.equal(pending[0].target_revision, 3, '重建意图必须是当前版本');
    assert.equal(pending[0].requested_by_turn_id, rollback.receipt.turnId);
    assert.ok(tasks.filter((t) => t.status === 'superseded').length >= 1, '旧版本任务被取消');
    assert.ok(!tasks.some((t) => t.status === 'pending' && t.target_revision < 3));
  } finally {
    await repo.close();
  }
});

/* ───────────── T25-05：切聊天不覆盖 / 只改插件管理条目 ───────────── */

test('T25-05 切聊天不覆盖：只改本聊天本分支条目，user: 与别的 atlas:<other-chat> 条目保留', async () => {
  const memory = new Map([
    ['user:我的设定', '用户自己的条目'],
    ['atlas:chat-B:main-B:pov', '别的聊天的投影'],
    ['atlas:chat-A:other-branch:pov', '本聊天别的分支的投影'],
    ['atlas:chat-A:main-A:pov', '旧 revision 的投影'],
  ]);
  const port = memoryPort(memory);

  const result = await rebuildManagedLorebook(port, {
    chatUid: IDS.chatA,
    branchId: IDS.branchMain,
    revision: 5,
    buildProjection: () => [
      projectionFor(IDS.chatA, IDS.branchMain, 'pov', 5),
      projectionFor(IDS.chatA, IDS.branchMain, 'scene_portrayal', 5),
    ],
  });

  assert.deepEqual(result.removed, ['atlas:chat-A:main-A:pov']);
  assert.equal(result.written, 2);
  assert.deepEqual(result.skippedForeign, ['atlas:chat-B:main-B:pov', 'atlas:chat-A:other-branch:pov']);
  assert.equal(memory.get('user:我的设定'), '用户自己的条目', '用户原有世界书不能被覆盖');
  assert.equal(memory.get('atlas:chat-B:main-B:pov'), '别的聊天的投影', '切聊天不写别的聊天');
  assert.equal(memory.get('atlas:chat-A:other-branch:pov'), '本聊天别的分支的投影');
  assert.equal(memory.get('atlas:chat-A:main-A:pov'), 'revision 5');
  assert.equal(memory.get('atlas:chat-A:main-A:scene_portrayal'), 'revision 5');
  assert.equal(memory.size, 5);

  // 同步时把非本聊天/分支的条目塞进投影 → 明确拒绝，不写任何条目。
  const seed = await makeSeedWith(SQL);
  try {
    enqueueProjectionSync(seed.db, {
      branchId: IDS.branchMain,
      turnId: IDS.seedTurn,
      targetRevision: 1,
      projectionScope: 'pov',
      payloadHash: 'hash_scope',
      nowWallMs: WALL,
      makeId: (key) => makeId('outbox', key, 'scope'),
    });
    const guard = memoryPort(new Map());
    const rejected = await runNextSync(seed.db, guard, {
      branchId: IDS.branchMain,
      chatUid: IDS.chatA,
      nowWallMs: WALL,
      buildProjection: (scope, revision) => [
        projectionFor(IDS.chatA, IDS.branchMain, scope, revision),
        projectionFor(IDS.chatB, IDS.branchB, scope, revision),
      ],
    });
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.errorCode, 'WORLD_SYNC_FAILED');
    assert.equal(guard.memory.size, 0, '越界投影一个条目都不能写');
    assert.equal(listOutbox(seed.db, IDS.branchMain)[0].status, 'failed');
  } finally {
    seed.close();
  }
});

/* ───────────── T25-06：维护保存不推进世界 ───────────── */

test('T25-06 维护保存：不推进 revision/head/clock，也不生成循环同步任务', async () => {
  const { repo } = await makeRepo(['{"op":"character.upsert","ref":"C1","data":{"thought":"维护前的变化"}}']);
  try {
    const prepared = await repo.prepareTurn({
      anchor: anchorFor(0),
      userText: '',
      assistantText: '一次提交。',
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    await repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'saved' });

    const branchBefore = queryBound(repo.db, 'SELECT revision, head_turn_id, clock_s, clock_min_s, clock_max_s, simulation_cursor_s FROM branches WHERE id = ?', [IDS.branchMain])[0];
    const outboxBefore = listOutbox(repo.db, IDS.branchMain);
    assert.equal(outboxBefore.length, 1);
    assert.equal(outboxBefore[0].status, 'pending');

    const maintenance = await repo.prepareMaintenance({
      anchor: anchorFor(Number(branchBefore.revision), { hostMessageUid: 'maint_1', variantKey: 'maint' }),
      outboxResults: [
        {
          taskId: outboxBefore[0].id,
          expectedStatus: 'pending',
          nextStatus: 'failed',
          attemptCount: 1,
          nextRetryWallMs: WALL + 600_000,
          lastErrorCode: 'WORLD_SYNC_FAILED',
          lastErrorMessage: '世界书不可用',
        },
      ],
    });
    assert.equal(maintenance.receipt, null, '维护不产生业务回执');
    await repo.confirmSaved({ token: maintenance.token, snapshotSha256: maintenance.snapshotSha256, result: 'saved' });

    const branchAfter = queryBound(repo.db, 'SELECT revision, head_turn_id, clock_s, clock_min_s, clock_max_s, simulation_cursor_s FROM branches WHERE id = ?', [IDS.branchMain])[0];
    assert.deepEqual(branchAfter, branchBefore, '维护不得推进世界/时钟/头指针');
    const outboxAfter = listOutbox(repo.db, IDS.branchMain);
    assert.equal(outboxAfter.length, outboxBefore.length, '维护不得产生新的同步任务');
    assert.equal(outboxAfter[0].id, outboxBefore[0].id);
    assert.equal(outboxAfter[0].status, 'failed');
    assert.equal(outboxAfter[0].attempt_count, 1);
    assert.equal(outboxAfter[0].last_error_code, 'WORLD_SYNC_FAILED');
    assert.equal(Number(outboxAfter[0].next_retry_wall_ms), WALL + 600_000);
    assert.equal(selectOne(repo.db, 'characters', IDS.branchMain, IDS.C1).thought, '维护前的变化', '维护不覆盖核心行');
    assert.deepEqual(foreignKeyCheck(repo.db), []);
  } finally {
    await repo.close();
  }
});
