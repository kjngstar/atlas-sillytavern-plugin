/**
 * atlas-db-branches.test.mjs — T14：分支分叉（E10）与父子独立。
 *
 * 覆盖（§17E E10 / §7.4）：
 * - 从 main-A 的基点分叉，业务当前行按需复制：数量不减、实体 ID 不变；
 * - 父子分支写入互不影响（各写各的 `(branch_id,id)` 行）；
 * - `branches.parent_branch_id` / `fork_turn_id` 指回，`head_turn_id` 是分叉 turn；
 * - 历史 `turns` 不复制（分叉分支的 turn 数远小于父分支总数）；
 * - 重复分支 ID → BRANCH_EXISTS；不存在的基点 turn → REF_UNKNOWN；
 * - 分叉后 `foreign_key_check` 为空、用户表仍恰 20 张。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, countRows, foreignKeyCheck, inTransaction, selectOne, userTables } from './fixtures/atlas-sql/seed.mjs';
import { FORK_COPY_TABLES, forkBranch, inspectForkBranch } from '../src/atlas-db-branches.ts';
import { createRow } from '../src/atlas-db-defaults.ts';
import { replayRequiredIssue, retryFailedGroups } from '../src/atlas-db-retry.ts';

const SQL = await (await import('sql.js')).default();

const nowWallMs = 1_700_000_000_001;
const FORK_ID = 'main-A-fork';

/** 确定性 makeId：同输入必得同 ID（不使用 Math.random）。 */
function makeId(kind, opId, alias) {
  let h = 0x811c9dc5;
  const text = `${kind}\u0000${opId}\u0000${alias}`;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${kind}_${h.toString(16).padStart(8, '0')}`;
}

function ids(db, table, branchId) {
  const rows = db.exec(`SELECT id FROM ${table} WHERE branch_id = ? ORDER BY id`, [branchId]);
  return rows.length ? rows[0].values.map((row) => String(row[0])) : [];
}

function branchRow(db, branchId) {
  const rows = db.exec('SELECT * FROM branches WHERE id = ?', [branchId]);
  assert.equal(rows.length, 1, `分支 ${branchId} 应存在`);
  const out = {};
  rows[0].columns.forEach((column, index) => {
    out[column] = rows[0].values[0][index];
  });
  return out;
}

/** 给父分支再添两楼：分叉分支的 turns 数才有「比父分支少」的对照。 */
function addParentTurns(db, turnIds) {
  inTransaction(db, () => {
    let parentTurnId = IDS.seedTurn;
    for (const turnId of turnIds) {
      db.run(
        `INSERT INTO turns (id, branch_id, parent_turn_id, host_message_uid, host_variant_key, kind, input_hash, story_hash,
                            base_revision, committed_revision, clock_before_s, elapsed_json, clock_after_s, rng_seed,
                            ruleset_version, decisions_json, receipt_json, attempts_json, status, created_wall_ms, prepared_wall_ms)
         VALUES (?, ?, ?, NULL, NULL, 'narrative', ?, NULL, 0, 0, 0, ?, 0, ?, 'atlas-1', '{}', NULL, '[]', 'committed', ?, ?)`,
        [
          turnId,
          IDS.branchMain,
          parentTurnId,
          `hash_${turnId}`,
          JSON.stringify({ min_s: 0, nominal_s: 0, max_s: 0, quality: 'explicit', basis_refs: [] }),
          `rng_${turnId}`,
          nowWallMs,
          nowWallMs,
        ],
      );
      parentTurnId = turnId;
    }
    db.run('UPDATE branches SET head_turn_id = ? WHERE id = ?', [parentTurnId, IDS.branchMain]);
  });
  return turnIds[turnIds.length - 1];
}

async function freshForked() {
  const seed = await makeSeedWith(SQL);
  const headTurnId = addParentTurns(seed.db, ['turn_A2', 'turn_A3']);
  const result = forkBranch(
    {
      parentBranchId: IDS.branchMain,
      newBranchId: FORK_ID,
      name: '分叉主线',
      forkTurnId: headTurnId,
      makeId,
      nowWallMs,
      rulesetVersion: 'atlas-1',
    },
    seed.db,
  );
  return { seed, result, headTurnId, forkTurnId: branchRow(seed.db, FORK_ID).head_turn_id };
}

test('T14-01 从基点分叉：复制业务当前行，实体 ID 不变、数量不减', async () => {
  const { seed, result, headTurnId } = await freshForked();
  try {
    const db = seed.db;
    assert.ok(result.copiedRows > 0, '应有业务当前行被复制');
    assert.equal(result.newBranchId, FORK_ID);
    assert.equal(result.issues.filter((issue) => issue.severity === 'error').length, 0);

    // 复制的行数 = 16 张表在父分支的行数合计
    let expected = 0;
    for (const table of FORK_COPY_TABLES) expected += countRows(db, table, IDS.branchMain);
    assert.equal(result.copiedRows, expected);

    // 数量不减、稳定 ID 完全一致
    for (const table of ['locations', 'characters', 'items', 'factions', 'maps', 'entity_keys', 'relations', 'routes', 'mention_candidates']) {
      assert.deepEqual(ids(db, table, FORK_ID), ids(db, table, IDS.branchMain), `${table} 的 ID 集合应保持不变`);
    }
    assert.equal(countRows(db, 'locations', FORK_ID), 3);
    assert.equal(countRows(db, 'characters', FORK_ID), 4);
    assert.equal(countRows(db, 'items', FORK_ID), 1);

    // row_rev 重置为 1、turn 列指向分叉 turn
    const forkedLocation = selectOne(db, 'locations', FORK_ID, IDS.L1);
    assert.equal(forkedLocation.name, '圣罗兰城');
    assert.equal(Number(forkedLocation.row_rev), 1);
    assert.equal(forkedLocation.created_turn_id, forkedLocation.updated_turn_id);

    // 分支行字段
    const parent = branchRow(db, IDS.branchMain);
    const fork = branchRow(db, FORK_ID);
    assert.equal(fork.parent_branch_id, IDS.branchMain);
    assert.equal(fork.fork_turn_id, headTurnId);
    assert.equal(fork.head_turn_id, forkedLocation.created_turn_id);
    assert.equal(fork.revision, parent.revision);
    assert.equal(fork.clock_s, parent.clock_s);
    assert.equal(fork.clock_min_s, parent.clock_min_s);
    assert.equal(fork.clock_max_s, parent.clock_max_s);
    assert.equal(fork.calendar_label, parent.calendar_label);
    assert.equal(fork.pov_character_id, parent.pov_character_id);
    assert.equal(fork.root_map_id, parent.root_map_id);
    assert.equal(fork.simulation_status, parent.simulation_status);
    assert.equal(fork.status, 'active');
    assert.equal(fork.ruleset_version, 'atlas-1');
  } finally {
    seed.close();
  }
});

test('T14-02 历史 turns 不复制：分叉分支只有自己的分叉 turn', async () => {
  const { seed, headTurnId } = await freshForked();
  try {
    const db = seed.db;
    const parentTurns = countRows(db, 'turns', IDS.branchMain);
    const forkTurns = countRows(db, 'turns', FORK_ID);
    assert.equal(parentTurns, 3);
    assert.equal(forkTurns, 1);
    assert.ok(forkTurns < parentTurns, '分叉分支的 turn 数应小于父分支总数');
    // turn_changes 属于被共享的祖先 turn：分叉分支自己的变更日志从 0 条开始。
    const forkChanges = db.exec(
      'SELECT COUNT(*) FROM turn_changes c JOIN turns t ON t.id = c.turn_id WHERE t.branch_id = ?',
      [FORK_ID],
    );
    assert.equal(Number(forkChanges[0].values[0][0]), 0);

    const forkTurn = db.exec('SELECT id, kind, parent_turn_id, branch_id FROM turns WHERE branch_id = ?', [FORK_ID]);
    assert.equal(String(forkTurn[0].values[0][1]), 'fork');
    assert.equal(String(forkTurn[0].values[0][2]), headTurnId, '分叉 turn 的父 turn 应指向父分支基点（历史按引用共享）');
    assert.equal(String(forkTurn[0].values[0][3]), FORK_ID);
  } finally {
    seed.close();
  }
});

test('T14-03 分叉后父子分支相互独立：一方的写不出现于另一方', async () => {
  const { seed, forkTurnId } = await freshForked();
  try {
    const db = seed.db;

    // fork 改自己的 L1 名称
    inTransaction(db, () => {
      db.run(`UPDATE locations SET name = '分叉城', row_rev = row_rev + 1 WHERE branch_id = ? AND id = ?`, [FORK_ID, IDS.L1]);
    });
    assert.equal(selectOne(db, 'locations', FORK_ID, IDS.L1).name, '分叉城');
    assert.equal(selectOne(db, 'locations', IDS.branchMain, IDS.L1).name, '圣罗兰城');

    // parent 改自己的人物想法
    inTransaction(db, () => {
      db.run(`UPDATE characters SET thought = '主线想法', row_rev = row_rev + 1 WHERE branch_id = ? AND id = ?`, [IDS.branchMain, IDS.C1]);
    });
    assert.equal(selectOne(db, 'characters', IDS.branchMain, IDS.C1).thought, '主线想法');
    assert.equal(selectOne(db, 'characters', FORK_ID, IDS.C1).thought, '');

    // fork 新增一行实体，parent 看不到
    inTransaction(db, () => {
      db.run(`INSERT INTO entity_keys (branch_id, id, kind) VALUES (?, 'L_FORK', 'location')`, [FORK_ID]);
      db.run(
        `INSERT INTO locations (branch_id, id, row_rev, created_turn_id, updated_turn_id, name, aliases_json, kind, description,
                                mobility, coord_precision, terrain, existence_quality, status)
         VALUES (?, 'L_FORK', 1, ?, ?, '分叉独有地点', '[]', 'building', '', 'fixed', 'unknown', 'unknown', 'confirmed', 'active')`,
        [FORK_ID, forkTurnId, forkTurnId],
      );
    });
    assert.equal(countRows(db, 'locations', FORK_ID), 4);
    assert.equal(countRows(db, 'locations', IDS.branchMain), 3);
    assert.equal(selectOne(db, 'locations', IDS.branchMain, 'L_FORK'), null);

    // 反向：parent 新增一行，fork 看不到
    inTransaction(db, () => {
      db.run(`INSERT INTO entity_keys (branch_id, id, kind) VALUES (?, 'L_MAIN', 'location')`, [IDS.branchMain]);
      db.run(
        `INSERT INTO locations (branch_id, id, row_rev, created_turn_id, updated_turn_id, name, aliases_json, kind, description,
                                mobility, coord_precision, terrain, existence_quality, status)
         VALUES (?, 'L_MAIN', 1, ?, ?, '主线独有地点', '[]', 'building', '', 'fixed', 'unknown', 'unknown', 'confirmed', 'active')`,
        [IDS.branchMain, IDS.seedTurn, IDS.seedTurn],
      );
    });
    assert.equal(countRows(db, 'locations', IDS.branchMain), 4);
    assert.equal(selectOne(db, 'locations', FORK_ID, 'L_MAIN'), null);

    assert.deepEqual(foreignKeyCheck(db), []);
    assert.equal(userTables(db).length, 20);
  } finally {
    seed.close();
  }
});

test('T14-04 重复分支 ID 拒绝（BRANCH_EXISTS），不存在的基点 turn 拒绝（REF_UNKNOWN）', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const db = seed.db;
    const base = {
      parentBranchId: IDS.branchMain,
      newBranchId: FORK_ID,
      name: '分叉主线',
      forkTurnId: IDS.seedTurn,
      makeId,
      nowWallMs,
      rulesetVersion: 'atlas-1',
    };

    // 与已有分支同名
    const duplicate = inspectForkBranch({ parentBranchId: IDS.branchMain, newBranchId: IDS.branchMain, forkTurnId: IDS.seedTurn }, db);
    assert.equal(duplicate.ok, false);
    assert.ok(duplicate.issues.some((issue) => issue.code === 'BRANCH_EXISTS'));
    assert.throws(
      () => forkBranch({ ...base, newBranchId: IDS.branchMain }, db),
      (err) => err.code === 'BRANCH_EXISTS',
    );

    // 基点 turn 不存在
    const unknownTurn = inspectForkBranch({ parentBranchId: IDS.branchMain, newBranchId: 'main-A-fork2', forkTurnId: 'turn_nope' }, db);
    assert.equal(unknownTurn.ok, false);
    assert.ok(unknownTurn.issues.some((issue) => issue.code === 'REF_UNKNOWN'));
    assert.throws(
      () => forkBranch({ ...base, newBranchId: 'main-A-fork2', forkTurnId: 'turn_nope' }, db),
      (err) => err.code === 'REF_UNKNOWN',
    );

    // 父分支不存在
    assert.throws(
      () => forkBranch({ ...base, parentBranchId: 'main-NOPE' }, db),
      (err) => err.code === 'REF_UNKNOWN',
    );

    // 成功分叉一次后再用同一 ID → BRANCH_EXISTS
    forkBranch(base, db);
    assert.throws(() => forkBranch(base, db), (err) => err.code === 'BRANCH_EXISTS');
    assert.equal(branchRow(db, FORK_ID).parent_branch_id, IDS.branchMain);
  } finally {
    seed.close();
  }
});

test('T14-05 分叉后外键检查为空、20 张用户表不变、身份与详情配对', async () => {
  const { seed } = await freshForked();
  try {
    const db = seed.db;
    assert.deepEqual(foreignKeyCheck(db), []);
    assert.equal(userTables(db).length, 20);

    const kinds = db.exec(`SELECT kind, COUNT(*) FROM entity_keys WHERE branch_id = ? GROUP BY kind ORDER BY kind`, [FORK_ID]);
    const counts = Object.fromEntries(kinds[0].values.map((row) => [String(row[0]), Number(row[1])]));
    assert.deepEqual(counts, { character: 4, faction: 1, item: 1, location: 3 });

    const mismatch = db.exec(
      `SELECT COUNT(*) FROM entity_keys k
        WHERE k.branch_id = ?
          AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.branch_id = k.branch_id AND l.id = k.id AND k.kind = 'location')
          AND NOT EXISTS (SELECT 1 FROM characters c WHERE c.branch_id = k.branch_id AND c.id = k.id AND k.kind = 'character')
          AND NOT EXISTS (SELECT 1 FROM items i WHERE i.branch_id = k.branch_id AND i.id = k.id AND k.kind = 'item')
          AND NOT EXISTS (SELECT 1 FROM factions f WHERE f.branch_id = k.branch_id AND f.id = k.id AND k.kind = 'faction')`,
      [FORK_ID],
    );
    assert.equal(Number(mismatch[0].values[0][0]), 0, '每个身份都应有对应详情');
  } finally {
    seed.close();
  }
});

/* ================================================================== *
 * E07 失败组原位补交（§7.5）
 * ================================================================== */

function clockOf(db) {
  const rows = db.exec('SELECT clock_s, head_turn_id, revision FROM branches WHERE id = ?', [IDS.branchMain]);
  return { clockS: Number(rows[0].values[0][0]), head: String(rows[0].values[0][1]), revision: Number(rows[0].values[0][2]) };
}

function countSnapshot(db) {
  return {
    entityKeys: countRows(db, 'entity_keys', IDS.branchMain),
    locations: countRows(db, 'locations', IDS.branchMain),
    characters: countRows(db, 'characters', IDS.branchMain),
    items: countRows(db, 'items', IDS.branchMain),
  };
}

/** 一个「新建地点」的原子组：entity_keys + locations 两行同组。 */
function locationGroup({ id, name, opId, groupId }) {
  const after = createRow(
    'locations',
    { name, kind: 'building' },
    { branchId: IDS.branchMain, id, turnId: IDS.seedTurn, clockS: 0, nowWallMs, rulesetVersion: 'atlas-1' },
  );
  return {
    id: groupId,
    opIds: [opId],
    dependsOn: [],
    readSet: [],
    mutations: [
      {
        table: 'entity_keys',
        rowId: id,
        before: null,
        after: { branch_id: IDS.branchMain, id, kind: 'location' },
        sourceOpIds: [opId],
        basis: { reason: '补交失败组' },
      },
      { table: 'locations', rowId: id, before: null, after, sourceOpIds: [opId], basis: { reason: '补交失败组' } },
    ],
  };
}

function retryInput(db, group, extra = {}) {
  return {
    db,
    branchId: IDS.branchMain,
    chatUid: IDS.chatA,
    turnId: IDS.seedTurn,
    currentHeadTurnId: IDS.seedTurn,
    attemptId: 'att_retry_1',
    groups: [group],
    clockS: 0,
    ...extra,
  };
}

/** 造一个后继楼并把分支头指过去（模拟「后续已经产生新楼」）。 */
function pushLaterHead(db, turnId) {
  inTransaction(db, () => {
    db.run(
      `INSERT INTO turns (id, branch_id, parent_turn_id, host_message_uid, host_variant_key, kind, input_hash, story_hash,
                          base_revision, committed_revision, clock_before_s, elapsed_json, clock_after_s, rng_seed,
                          ruleset_version, decisions_json, receipt_json, attempts_json, status, created_wall_ms, prepared_wall_ms)
       VALUES (?, ?, ?, NULL, NULL, 'narrative', ?, NULL, 0, 0, 0, ?, 0, ?, 'atlas-1', '{}', NULL, '[]', 'committed', ?, ?)`,
      [
        turnId,
        IDS.branchMain,
        IDS.seedTurn,
        `hash_${turnId}`,
        JSON.stringify({ min_s: 0, nominal_s: 0, max_s: 0, quality: 'explicit', basis_refs: [] }),
        `rng_${turnId}`,
        nowWallMs,
        nowWallMs,
      ],
    );
    db.run('UPDATE branches SET head_turn_id = ? WHERE id = ?', [turnId, IDS.branchMain]);
  });
}

test('T07-01 原 turn 仍是当前头时，失败组可以原位补交', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const db = seed.db;
    const group = locationGroup({ id: 'L_RETRY', name: '补交地点', opId: 'op_retry_1', groupId: 'grp_retry_1' });
    const result = retryFailedGroups(retryInput(db, group));
    assert.equal(result.status, 'applied');
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].status, 'applied');
    assert.ok(result.groups[0].changedRows > 0);
    const row = selectOne(db, 'locations', IDS.branchMain, 'L_RETRY');
    assert.ok(row, '补交后地点应存在');
    assert.equal(row.name, '补交地点');
    assert.equal(selectOne(db, 'entity_keys', IDS.branchMain, 'L_RETRY').kind, 'location');
    assert.equal(String(row.created_turn_id), IDS.seedTurn, '补交归属原 turn');
    assert.deepEqual(foreignKeyCheck(db), []);
  } finally {
    seed.close();
  }
});

test('T07-02 已提交的组补交只报 duplicate：时钟与行数都不变（重复副作用为 0）', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const db = seed.db;
    const group = locationGroup({ id: 'L_RETRY', name: '补交地点', opId: 'op_retry_1', groupId: 'grp_retry_1' });
    const first = retryFailedGroups(retryInput(db, group));
    assert.equal(first.status, 'applied');
    const clockBefore = clockOf(db);
    const countsBefore = countSnapshot(db);
    const turnsBefore = countRows(db, 'turns', IDS.branchMain);
    const afterRow = selectOne(db, 'locations', IDS.branchMain, 'L_RETRY');

    const again = retryFailedGroups(retryInput(db, group, { attemptId: 'att_retry_2' }));
    assert.equal(again.status, 'duplicate', '已提交的组只能得到 duplicate');
    assert.equal(again.groups[0].status, 'duplicate');
    assert.equal(again.groups[0].changedRows, 0);

    assert.deepEqual(clockOf(db), clockBefore, '逻辑时间不得再次前进');
    assert.deepEqual(countSnapshot(db), countsBefore, '行数不得变化');
    assert.equal(countRows(db, 'turns', IDS.branchMain), turnsBefore);
    assert.deepEqual(selectOne(db, 'locations', IDS.branchMain, 'L_RETRY'), afterRow, '已提交的行不得被改写');
    assert.equal(Number(clockOf(db).clockS), 0, 'clock_s 保持原值');
  } finally {
    seed.close();
  }
});

test('T07-03 后续已经产生新楼：返回 replay_required 与 RETRY_BASE_CHANGED，不插入旧时点动作', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const db = seed.db;
    pushLaterHead(db, 'turn_A_later');
    const group = locationGroup({ id: 'L_REPLAY', name: '旧时点刺杀', opId: 'op_replay_1', groupId: 'grp_replay_1' });
    // 调用方捕获的还是旧 head（原 turn），但库内已经产生了新楼。
    const result = retryFailedGroups(retryInput(db, group, { currentHeadTurnId: IDS.seedTurn }));
    assert.equal(result.status, 'replay_required');
    assert.equal(result.groups.length, 0);
    assert.equal(result.issues[0].code, 'RETRY_BASE_CHANGED');
    assert.equal(result.issues[0].retryable, false);
    assert.ok(result.issues[0].message.includes(IDS.seedTurn));
    assert.ok(result.issues[0].message.includes('turn_A_later'));
    assert.equal(selectOne(db, 'locations', IDS.branchMain, 'L_REPLAY'), null, '不得把旧时点动作直接插进新状态');
    assert.equal(clockOf(db).head, 'turn_A_later');
  } finally {
    seed.close();
  }
});

test('T07-04 replayRequiredIssue 命名原 head 与 current head；捕获的 head 过期时报 STALE_BASE', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const db = seed.db;
    const issue = replayRequiredIssue('turn_old', 'turn_new');
    assert.equal(issue.code, 'RETRY_BASE_CHANGED');
    assert.equal(issue.severity, 'error');
    assert.equal(issue.retryable, false);
    assert.ok(issue.message.includes('turn_old') && issue.message.includes('turn_new'));
    assert.ok(replayRequiredIssue(null, null).message.includes('null'));

    // 头没变但调用方捕获错了：拒绝在错误基态上补交。
    const group = locationGroup({ id: 'L_STALE', name: '过期补交', opId: 'op_stale_1', groupId: 'grp_stale_1' });
    const stale = retryFailedGroups(retryInput(db, group, { currentHeadTurnId: 'turn_not_head' }));
    assert.equal(stale.status, 'blocked');
    assert.equal(stale.issues[0].code, 'STALE_BASE');
    assert.equal(selectOne(db, 'locations', IDS.branchMain, 'L_STALE'), null);
  } finally {
    seed.close();
  }
});
