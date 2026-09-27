/**
 * atlas-ops-groups.test.mjs — T08（§18.3）：原子分组、拓扑次序、保存点提交与变更日志。
 *
 * 覆盖：
 * - E01（§16.5 步骤 4/5）：同一效果链/同一资源竞争必须合并，单纯读取同一既有地点不合并；
 * - E02：依赖拓扑次序稳定，失败依赖标 blocked，独立组照常应用；
 * - E05（§16.5 applyGroups 伪代码、§7.3）：每组 SAVEPOINT，失败只回滚本组，不留悬挂事务；
 * - E04（§6.4）：turn_changes 幂等键、insert 的 before_json 为空、同组同行合并；
 * - E03（§7.6）：候选库不变量（地点父链无环）。
 *
 * 分组输入形状即 §16.3 RowMutation/CompileResult：{opId, issues, mutations, readSet, dependencies,
 * entityKeyWrites?, operationKeys?}。真实编译路径（atlas-ops-compile.ts）在 T08-01/T08-14 覆盖。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeSeedWith,
  IDS,
  insertRows,
  selectOne,
  countRows,
  foreignKeyCheck,
} from './fixtures/atlas-sql/seed.mjs';
import { SOURCE_SNAPSHOT, caseById } from './fixtures/atlas-sql/model-cases.mjs';
import { parseOperations } from '../src/atlas-ops-parser.ts';
import { buildAtomicGroups, orderGroups } from '../src/atlas-ops-groups.ts';
import { applyGroups } from '../src/atlas-db-commit.ts';
import { readTurnChanges, mergeGroupMutations, operationAlreadyApplied } from '../src/atlas-db-journal.ts';
import { validateCandidate } from '../src/atlas-db-invariants.ts';
import { compileOperations } from '../src/atlas-ops-compile.ts';
import { createTableReadPort } from '../src/atlas-db-readport.ts';
import { createRow } from '../src/atlas-db-defaults.ts';

const SQL = await (await import('sql.js')).default();

const ANCHOR = {
  chatUid: IDS.chatA,
  branchId: IDS.branchMain,
  parentTurnId: IDS.seedTurn,
  hostMessageUid: 'msg-1',
  variantKey: 'v1',
  baseRevision: 0,
  baseStorageRevision: 0,
  inputHash: 'hash_input',
};

const TURN_ID = IDS.seedTurn;
const APPLY_CTX = { branchId: IDS.branchMain, turnId: TURN_ID, attemptId: 't' };

async function fresh() {
  return makeSeedWith(SQL);
}

function rowCtx(id) {
  return {
    branchId: IDS.branchMain,
    id,
    turnId: TURN_ID,
    clockS: 0,
    nowWallMs: 1_700_000_000_000,
    rulesetVersion: 'atlas-1',
  };
}

function mutation(table, rowId, before, after, opId) {
  return { table, rowId, before, after, sourceOpIds: [opId], basis: { kind: 'story', reason: 'T08 合成' } };
}

function compiledEntry(opId, extra = {}) {
  return { opId, issues: [], mutations: [], readSet: [], dependencies: [], ...extra };
}

/** 一组「entity_keys + characters」插入（§2.2：身份与详情必须一起写）。 */
function characterGroup(groupId, opId, charId, name, options = {}) {
  const row = createRow('characters', { name, identity: '合成测试人物' }, rowCtx(charId));
  const mutations = [];
  if (options.withEntityKey !== false) {
    mutations.push(mutation('entity_keys', charId, null, { branch_id: IDS.branchMain, id: charId, kind: 'character' }, opId));
  }
  mutations.push(mutation('characters', charId, null, row, opId));
  return { id: groupId, opIds: [opId], dependsOn: [], readSet: [], mutations };
}

function characterExists(db, id) {
  return selectOne(db, 'characters', IDS.branchMain, id);
}

/** 真实编译一件“广场刺杀”：event.propose + character_status + action_result。 */
function compileAssassination(seed) {
  const actionId = 'act_kill_king';
  insertRows(seed.db, 'actions', [
    createRow(
      'actions',
      {
        actor_entity_id: IDS.C3,
        kind: 'act',
        title: '刺杀国王',
        intent: '在广场动手',
        status: 'ready',
        target_entity_id: IDS.C4,
        secrecy: 'secret',
        payload_json: { method: 'blade', stakes: 'major' },
      },
      rowCtx(actionId),
    ),
  ]);

  const text = JSON.stringify({
    op: 'event.propose',
    why: '后台刺杀到期落实',
    data: {
      title: '广场刺杀',
      phase: 'simulated',
      kind: 'conflict',
      action_ref: 'A1',
      location_ref: 'L1',
      result: '国王在广场被刺',
      effects: [
        { type: 'character_status', target_ref: 'C4', value: 'dead' },
        { type: 'action_result', action_ref: 'A1', value: 'completed' },
      ],
    },
  });
  const parsed = parseOperations(text, { phase: 'outcome' });
  const out = compileOperations({
    operations: parsed.operations,
    anchor: ANCHOR,
    phase: 'outcome',
    clockS: 300,
    revision: 0,
    tables: createTableReadPort(seed.db),
    sources: { phase: 'outcome', snapshot: SOURCE_SNAPSHOT, clockS: 300 },
    knownRefs: [...seed.refs.map((ref) => ({ alias: ref.alias, id: ref.id, kind: ref.kind })), { alias: 'A1', id: actionId, kind: 'action' }],
  });
  return { parsed, out, actionId };
}

/** 把真实编译结果按效果链拆成两个 compiled 条目（事件+死亡 / 行动结果），由 dependencies 相连。 */
function assassinationChain(parsed, result) {
  const eventOpId = parsed.operations[0].opId;
  return [
    compiledEntry(eventOpId, {
      mutations: result.mutations.filter((m) => m.table !== 'actions'),
      readSet: result.readSet,
      dependencies: ['op_action_result'],
    }),
    compiledEntry('op_action_result', {
      mutations: result.mutations.filter((m) => m.table === 'actions'),
      readSet: result.readSet,
    }),
  ];
}

/* ───────────────────────── 分组：合并与不合并 ───────────────────────── */

test('T08-01 刺杀结果与死亡不可拆：事件、死亡、行动结果落在同一组', async () => {
  const seed = await fresh();
  try {
    const { parsed, out } = compileAssassination(seed);
    assert.deepEqual(out.issues, []);
    assert.equal(out.results.length, 1);
    const result = out.results[0].result;
    assert.deepEqual(
      result.mutations.map((m) => m.table).sort(),
      ['actions', 'characters', 'events'],
    );

    const chain = assassinationChain(parsed, result);
    const built = buildAtomicGroups(chain);
    assert.deepEqual(built.issues, []);
    assert.equal(built.groups.length, 1);
    const [group] = built.groups;

    assert.deepEqual([...group.opIds].sort(), [parsed.operations[0].opId, 'op_action_result'].sort());
    assert.deepEqual(group.dependsOn, []);

    const byTable = new Map(group.mutations.map((m) => [m.table, m]));
    assert.deepEqual([...byTable.keys()].sort(), ['actions', 'characters', 'events']);
    assert.equal(byTable.get('characters').rowId, IDS.C4);
    assert.equal(byTable.get('characters').after.physical_status, 'dead');
    assert.equal(byTable.get('actions').rowId, 'act_kill_king');
    assert.equal(byTable.get('actions').after.status, 'completed');
    // 行动结果指向同组刚刚插入的事件行：拆开就会留下悬空 result_event_id。
    assert.equal(byTable.get('actions').after.result_event_id, byTable.get('events').rowId);

    // 两条独立保证都不能把它们拆开：
    // 1) 显式 dependencies（同一效果链，§16.5 步骤 4）；
    // 2) 即使删掉显式依赖，编译器给出的 readSet 让两组互相读取对方要写的行
    //    （读后写次序），形成依赖环 → §16.5 步骤 5 只把循环组件合并为一组。
    const withoutExplicitDep = buildAtomicGroups(chain.map((entry) => ({ ...entry, dependencies: [] })));
    assert.equal(withoutExplicitDep.groups.length, 1);
    assert.ok(
      withoutExplicitDep.issues.some((issue) => issue.code === 'GROUP_DEPENDENCY_CYCLE_MERGED'),
      '互相读写的组件必须作为循环合并，并且留下 warning 而不是静默拆开',
    );
    assert.deepEqual(
      withoutExplicitDep.groups[0].mutations.map((m) => m.table).sort(),
      ['actions', 'characters', 'events'],
    );
  } finally {
    seed.close();
  }
});

test('T08-02 两件同地独立事情不合并：只共享地点读集写不同行 → 两组', async () => {
  const seed = await fresh();
  try {
    const sharedRead = [{ table: 'locations', rowId: IDS.L2, rowRev: 1 }];
    const firstChar = createRow('characters', { name: '甲', identity: '路人' }, rowCtx('chr_place_a'));
    const secondChar = createRow('characters', { name: '乙', identity: '路人' }, rowCtx('chr_place_b'));

    const built = buildAtomicGroups([
      compiledEntry('op_place_a', {
        mutations: [mutation('characters', 'chr_place_a', null, firstChar, 'op_place_a')],
        readSet: sharedRead,
      }),
      compiledEntry('op_place_b', {
        mutations: [mutation('characters', 'chr_place_b', null, secondChar, 'op_place_b')],
        readSet: sharedRead,
      }),
    ]);

    assert.deepEqual(built.issues, []);
    assert.equal(built.groups.length, 2);
    for (const group of built.groups) {
      assert.equal(group.opIds.length, 1);
      assert.deepEqual(group.readSet, sharedRead);
    }
    assert.deepEqual(built.groups.map((g) => g.mutations[0].rowId).sort(), ['chr_place_a', 'chr_place_b']);
  } finally {
    seed.close();
  }
});

test('T08-03 资源竞争：两个 op 写同一 item 行 → 合并为一组', async () => {
  const seed = await fresh();
  try {
    const port = createTableReadPort(seed.db);
    const before = port.selectOne('items', IDS.branchMain, IDS.I1);
    const takeByA = { ...before, holder_character_id: null, location_id: IDS.L2, row_rev: 2 };
    const takeByB = { ...before, holder_character_id: IDS.C2, row_rev: 2 };

    const built = buildAtomicGroups([
      compiledEntry('op_take_a', {
        mutations: [mutation('items', IDS.I1, before, takeByA, 'op_take_a')],
        readSet: [{ table: 'items', rowId: IDS.I1, rowRev: 1 }],
      }),
      compiledEntry('op_take_b', {
        mutations: [mutation('items', IDS.I1, before, takeByB, 'op_take_b')],
        readSet: [{ table: 'items', rowId: IDS.I1, rowRev: 1 }],
      }),
    ]);

    assert.equal(built.groups.length, 1);
    assert.deepEqual([...built.groups[0].opIds].sort(), ['op_take_a', 'op_take_b']);
    // 同一行不能被两组各自消耗：合并后这一行只有一条最终写入。
    assert.equal(built.groups[0].mutations.length, 2);
    assert.equal(new Set(built.groups[0].mutations.map((m) => `${m.table}:${m.rowId}`)).size, 1);
  } finally {
    seed.close();
  }
});

test('T08-04 资源竞争：共享同一 operationKeys 条目的 op → 合并为一组', async () => {
  const seed = await fresh();
  try {
    const key = [{ groupKey: 'consume:items', opKey: `${IDS.I1}:1` }];
    const shared = buildAtomicGroups([
      compiledEntry('op_consume_a', { operationKeys: key }),
      compiledEntry('op_consume_b', { operationKeys: key }),
    ]);
    assert.equal(shared.groups.length, 1);
    assert.deepEqual([...shared.groups[0].opIds].sort(), ['op_consume_a', 'op_consume_b']);

    // 键不同则各自成组（合并条件按完整键比较，不是按前缀）。
    const distinct = buildAtomicGroups([
      compiledEntry('op_consume_a', { operationKeys: [{ groupKey: 'consume:items', opKey: `${IDS.I1}:1` }] }),
      compiledEntry('op_consume_b', { operationKeys: [{ groupKey: 'consume:items', opKey: `${IDS.I1}:2` }] }),
    ]);
    assert.equal(distinct.groups.length, 2);
  } finally {
    seed.close();
  }
});

test('T08-05 依赖拓扑次序：C←B←A 的输出与输入顺序无关', async () => {
  const seed = await fresh();
  try {
    const built = buildAtomicGroups(
      ['op_chain_a', 'op_chain_b', 'op_chain_c'].map((opId) =>
        compiledEntry(opId, {
          mutations: [
            mutation('characters', `chr_${opId.slice(-1)}`, null, createRow('characters', { name: opId, identity: '链' }, rowCtx(`chr_${opId.slice(-1)}`)), opId),
          ],
        }),
      ),
    );
    assert.equal(built.groups.length, 3);
    const byOp = new Map(built.groups.map((group) => [group.opIds[0], group]));
    const a = byOp.get('op_chain_a');
    const b = byOp.get('op_chain_b');
    const c = byOp.get('op_chain_c');
    // buildAtomicGroups 把依赖相连的 op 并成一组（见 T08-01），所以组间边由调用方按
    // §16.5 步骤 5 的组级依赖给出；orderGroups 消费的就是这些边。
    const chain = [
      { ...a },
      { ...b, dependsOn: [a.id] },
      { ...c, dependsOn: [b.id] },
    ];

    const forward = orderGroups([chain[0], chain[1], chain[2]]);
    const reversed = orderGroups([chain[2], chain[1], chain[0]]);
    const shuffled = orderGroups([chain[1], chain[2], chain[0]]);
    const expected = ['op_chain_a', 'op_chain_b', 'op_chain_c'];

    assert.deepEqual(forward.order.map((g) => g.opIds[0]), expected);
    assert.deepEqual(reversed.order.map((g) => g.opIds[0]), expected);
    assert.deepEqual(shuffled.order.map((g) => g.opIds[0]), expected);
    assert.equal(forward.blockedBy.size, 0);
    assert.deepEqual(forward.issues, []);
  } finally {
    seed.close();
  }
});

/* ───────────────────────── 提交：保存点、阻塞、幂等 ───────────────────────── */

test('T08-06 失败依赖标 blocked：拒绝组不执行，独立第三组照常 applied', async () => {
  const seed = await fresh();
  try {
    const ok = characterGroup('grp_ok', 'op_g1', 'chr_new', '新人物');
    const bad = characterGroup('grp_bad', 'op_g2', 'chr_bad', '无身份人物', { withEntityKey: false });
    const dependent = characterGroup('grp_dep', 'op_g3', 'chr_dep', '依赖组');
    dependent.dependsOn = [bad.id];
    const independent = characterGroup('grp_free', 'op_g4', 'chr_free', '独立组');

    const ordered = orderGroups([ok, bad, dependent, independent]).order;
    assert.ok(
      ordered.findIndex((g) => g.id === dependent.id) > ordered.findIndex((g) => g.id === bad.id),
      '被依赖组必须排在被依赖之后',
    );

    const result = applyGroups(seed.db, ordered, APPLY_CTX);
    const statusOf = new Map(result.groups.map((entry) => [entry.groupId, entry.status]));
    assert.equal(statusOf.get(ok.id), 'applied');
    assert.equal(statusOf.get(bad.id), 'rejected');
    assert.equal(statusOf.get(dependent.id), 'blocked');
    assert.equal(statusOf.get(independent.id), 'applied');

    const rejected = result.groups.find((entry) => entry.groupId === bad.id);
    assert.equal(rejected.changedRows, 0);
    assert.ok(rejected.issues.some((issue) => issue.code === 'SQL_CONSTRAINT'));
    assert.ok(rejected.issues.some((issue) => issue.message.includes('ENTITY_KEY_KIND_MISMATCH')));

    const blocked = result.groups.find((entry) => entry.groupId === dependent.id);
    assert.equal(blocked.changedRows, 0);
    assert.equal(blocked.issues.length, 1);
    assert.equal(blocked.issues[0].code, 'DEPENDENCY_FAILED');
    assert.equal(blocked.issues[0].severity, 'error');
    assert.equal(blocked.issues[0].dependencyId, bad.id);
    assert.equal(blocked.issues[0].groupId, dependent.id);

    // 被依赖失败 ⇒ 依赖组一行都不写；独立组与被拒绝组无关。
    assert.equal(characterExists(seed.db, 'chr_dep'), null);
    assert.equal(characterExists(seed.db, 'chr_bad'), null);
    assert.equal(characterExists(seed.db, 'chr_new').name, '新人物');
    assert.equal(characterExists(seed.db, 'chr_free').name, '独立组');
  } finally {
    seed.close();
  }
});

test('T08-07 保存点回滚仅本组：失败组无残留行，且不留悬挂事务', async () => {
  const seed = await fresh();
  try {
    const ok = characterGroup('grp_first', 'op_first', 'chr_first', '先成功');
    const bad = characterGroup('grp_second', 'op_second', 'chr_second', '后失败', { withEntityKey: false });
    const dependent = characterGroup('grp_third', 'op_third', 'chr_third', '被阻塞');
    dependent.dependsOn = [bad.id];

    const result = applyGroups(seed.db, [ok, bad, dependent], APPLY_CTX);
    assert.deepEqual(result.groups.map((entry) => entry.status), ['applied', 'rejected', 'blocked']);

    // 先成功的组保留；失败组与被阻塞组都没有行。
    assert.equal(characterExists(seed.db, 'chr_first').name, '先成功');
    assert.equal(characterExists(seed.db, 'chr_second'), null);
    assert.equal(characterExists(seed.db, 'chr_third'), null);
    assert.deepEqual(foreignKeyCheck(seed.db), []);
    // 失败组没有留下 turn_changes（保存点回滚覆盖日志写入）。
    assert.deepEqual(
      readTurnChanges(seed.db, TURN_ID).map((change) => change.targetRowId),
      ['chr_first', 'chr_first'],
    );

    // 没有未释放的事务：随后可以直接 BEGIN/COMMIT。
    assert.doesNotThrow(() => {
      seed.db.run('BEGIN');
      seed.db.run('COMMIT');
    });
  } finally {
    seed.close();
  }
});

test('T08-08 readTurnChanges：应用组的行以 insert 记录，before_json 为空', async () => {
  const seed = await fresh();
  try {
    const ok = characterGroup('grp_ok', 'op_g1', 'chr_new', '新人物');
    const result = applyGroups(seed.db, [ok], { ...APPLY_CTX, attemptId: 'attempt-1' });
    assert.equal(result.groups[0].status, 'applied');
    assert.equal(result.sequencesUsed, 2);

    const changes = readTurnChanges(seed.db, TURN_ID);
    assert.equal(changes.length, 2);
    assert.deepEqual(changes.map((change) => change.sequence), [1, 2]);
    assert.deepEqual(changes.map((change) => change.targetTable), ['entity_keys', 'characters']);
    assert.deepEqual(changes.map((change) => change.targetRowId), ['chr_new', 'chr_new']);
    for (const change of changes) {
      assert.equal(change.operation, 'insert');
      assert.equal(change.beforeJson, null);
      assert.equal(change.groupId, ok.id);
      assert.equal(change.attemptId, 'attempt-1');
      assert.equal(change.operationId, 'op_g1');
      assert.ok(change.afterJson);
      assert.equal(JSON.parse(change.afterJson).id, 'chr_new');
    }
    assert.equal(JSON.parse(changes[1].afterJson).name, '新人物');
    assert.equal(JSON.parse(changes[1].afterJson).physical_status, 'unknown');
  } finally {
    seed.close();
  }
});

test('T08-09 幂等：同一 turn 重复应用同组 → duplicate，行数不翻倍', async () => {
  const seed = await fresh();
  try {
    const ok = characterGroup('grp_ok', 'op_g1', 'chr_new', '新人物');
    const before = countRows(seed.db, 'characters', IDS.branchMain);

    const first = applyGroups(seed.db, [ok], { ...APPLY_CTX, attemptId: 't1' });
    assert.equal(first.groups[0].status, 'applied');
    assert.equal(first.groups[0].changedRows, 2);
    assert.equal(countRows(seed.db, 'characters', IDS.branchMain), before + 1);
    assert.equal(operationAlreadyApplied(seed.db, TURN_ID, 'op_g1', 'characters', 'chr_new'), true);
    assert.equal(operationAlreadyApplied(seed.db, TURN_ID, 'op_g1', 'characters', 'chr_other'), false);

    const second = applyGroups(seed.db, [ok], { ...APPLY_CTX, attemptId: 't2', appliedKeys: first.appliedKeys });
    assert.equal(second.groups[0].status, 'duplicate');
    assert.equal(second.groups[0].changedRows, 0);

    // 即使调用方没有回传 appliedKeys，幂等键也拦住重复写入：行数不翻倍。
    applyGroups(seed.db, [ok], { ...APPLY_CTX, attemptId: 't3' });
    const rows = seed.db.exec(
      `SELECT COUNT(*) FROM characters WHERE branch_id='${IDS.branchMain}' AND id='chr_new'`,
    );
    assert.equal(Number(rows[0].values[0][0]), 1);
    assert.equal(countRows(seed.db, 'characters', IDS.branchMain), before + 1);
    assert.equal(operationAlreadyApplied(seed.db, TURN_ID, 'op_g1', 'characters', 'chr_new'), true);
    // 变更日志同样不重复：chr_new 仍只有两条（entity_keys + characters）。
    assert.equal(readTurnChanges(seed.db, TURN_ID).filter((c) => c.targetRowId === 'chr_new').length, 2);
  } finally {
    seed.close();
  }
});

test('T08-10 mergeGroupMutations：同组同行取最早 before 与最新 after，opIds 去重', async () => {
  const seed = await fresh();
  try {
    const merged = mergeGroupMutations([
      {
        table: 'characters',
        rowId: IDS.C1,
        before: { thought: '', action_tendency: '' },
        after: { thought: '先观察。', action_tendency: '' },
        sourceOpIds: ['op_1', 'op_2'],
        basis: { kind: 'story' },
      },
      {
        table: 'characters',
        rowId: IDS.C1,
        before: { thought: '先观察。', action_tendency: '' },
        after: { thought: '先观察。', action_tendency: '留在学校' },
        sourceOpIds: ['op_2', 'op_3'],
        basis: { kind: 'simulation' },
      },
    ]);

    assert.equal(merged.length, 1);
    assert.equal(merged[0].table, 'characters');
    assert.equal(merged[0].rowId, IDS.C1);
    assert.equal(merged[0].before.thought, '', 'before 取最早');
    assert.equal(merged[0].after.thought, '先观察。', 'after 取最新');
    assert.equal(merged[0].after.action_tendency, '留在学校');
    assert.deepEqual(merged[0].sourceOpIds, ['op_1', 'op_2', 'op_3']);

    // 不同行不合并，且保持首次出现顺序。
    const twoRows = mergeGroupMutations([
      { table: 'characters', rowId: 'chr_x', before: null, after: { id: 'chr_x' }, sourceOpIds: ['op_a'], basis: {} },
      { table: 'items', rowId: IDS.I1, before: { quantity: 1 }, after: { quantity: 0 }, sourceOpIds: ['op_b'], basis: {} },
      { table: 'characters', rowId: 'chr_x', before: { id: 'chr_x' }, after: { id: 'chr_x', thought: 'x' }, sourceOpIds: ['op_a'], basis: {} },
    ]);
    assert.equal(twoRows.length, 2);
    assert.deepEqual(twoRows.map((m) => `${m.table}:${m.rowId}`), ['characters:chr_x', 'items:I1']);
    assert.deepEqual(twoRows[0].sourceOpIds, ['op_a']);
    // 组内先 insert 后 update 同一行时，before 仍是组内最早的非空行（插入前的 null 被后续 before 补上）。
    assert.deepEqual(twoRows[0].before, { id: 'chr_x' });
    assert.deepEqual(twoRows[0].after, { id: 'chr_x', thought: 'x' });
    assert.equal(twoRows[1].before.quantity, 1);
  } finally {
    seed.close();
  }
});

/* ───────────────────────── 不变量校验 ───────────────────────── */

test('T08-11 validateCandidate：种子世界通过全部 §7.6 不变量', async () => {
  const seed = await fresh();
  try {
    const validation = validateCandidate(seed.db, { branchId: IDS.branchMain });
    assert.deepEqual(validation.violations, []);
    assert.equal(validation.ok, true);
    assert.ok(validation.checked.includes(`characters:${IDS.C1}`));
    assert.ok(validation.checked.includes(`locations:${IDS.L1}`));
    assert.deepEqual(validation.issues, []);
  } finally {
    seed.close();
  }
});

test('T08-12 validateCandidate：L1→L3→L2→L1 父链成环时报 INVARIANT_LOCATION_PARENT_CYCLE', async () => {
  const seed = await fresh();
  try {
    const parentOf = (id) => selectOne(seed.db, 'locations', IDS.branchMain, id).parent_location_id;
    assert.equal(parentOf(IDS.L1), null);
    assert.equal(parentOf(IDS.L2), IDS.L1);
    assert.equal(parentOf(IDS.L3), IDS.L2);
    assert.equal(validateCandidate(seed.db, { branchId: IDS.branchMain }).ok, true);

    seed.db.run(
      `UPDATE locations SET parent_location_id = '${IDS.L3}' WHERE branch_id = '${IDS.branchMain}' AND id = '${IDS.L1}'`,
    );

    const validation = validateCandidate(seed.db, { branchId: IDS.branchMain });
    assert.equal(validation.ok, false);
    const cycle = validation.violations.find((violation) => violation.code === 'INVARIANT_LOCATION_PARENT_CYCLE');
    assert.ok(cycle, '必须报出地点父链环');
    assert.equal(cycle.table, 'locations');
    assert.equal(cycle.field, 'parent_location_id');
    assert.ok(validation.issues.some((issue) => issue.code === 'INVARIANT_LOCATION_PARENT_CYCLE'));
  } finally {
    seed.close();
  }
});

test('T08-13 组内违反 schema CHECK：记 rejected 与错误，不从 applyGroups 抛出', async () => {
  const seed = await fresh();
  try {
    const port = createTableReadPort(seed.db);
    const before = port.selectOne('items', IDS.branchMain, IDS.I1);
    // holder_character_id 与 location_id 互斥：两个实际放置来源违反 items 的 CHECK。
    const badItem = { ...before, holder_character_id: IDS.C1, location_id: IDS.L2 };
    const group = {
      id: 'grp_item_conflict',
      opIds: ['op_item_conflict'],
      dependsOn: [],
      readSet: [{ table: 'items', rowId: IDS.I1, rowRev: 1 }],
      mutations: [mutation('items', IDS.I1, before, badItem, 'op_item_conflict')],
    };

    let result;
    assert.doesNotThrow(() => {
      result = applyGroups(seed.db, [group], APPLY_CTX);
    });
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].status, 'rejected');
    assert.equal(result.groups[0].changedRows, 0);
    const [issue] = result.groups[0].issues;
    assert.equal(issue.code, 'SQL_CONSTRAINT');
    assert.equal(issue.severity, 'error');
    assert.equal(issue.groupId, group.id);
    assert.ok(issue.message.includes('CHECK'));

    // 失败组回滚干净：原行不变，没有日志，随后仍可开事务。
    const after = selectOne(seed.db, 'items', IDS.branchMain, IDS.I1);
    assert.equal(after.holder_character_id, IDS.C1);
    assert.equal(after.location_id, null);
    assert.deepEqual(readTurnChanges(seed.db, TURN_ID), []);
    assert.doesNotThrow(() => {
      seed.db.run('BEGIN');
      seed.db.run('COMMIT');
    });
  } finally {
    seed.close();
  }
});

/* ───────────────────────── 真实编译路径端到端 ───────────────────────── */

test('T08-14 真实编译器 → 分组 → applyGroups：刺杀组落库且通过最终不变量', async () => {
  const seed = await fresh();
  try {
    const { parsed, out, actionId } = compileAssassination(seed);
    const chain = assassinationChain(parsed, out.results[0].result);
    const built = buildAtomicGroups(chain);
    assert.deepEqual(built.issues, []);
    assert.equal(built.groups.length, 1);

    const ordered = orderGroups(built.groups);
    assert.deepEqual(ordered.issues, []);
    const result = applyGroups(seed.db, ordered.order, APPLY_CTX);

    assert.deepEqual(result.groups.map((entry) => entry.status), ['applied']);
    assert.equal(result.groups[0].changedRows, 3);
    assert.equal(selectOne(seed.db, 'characters', IDS.branchMain, IDS.C4).physical_status, 'dead');
    assert.equal(selectOne(seed.db, 'actions', IDS.branchMain, actionId).status, 'completed');

    const changes = readTurnChanges(seed.db, TURN_ID);
    assert.deepEqual(
      changes.map((change) => [change.targetTable, change.operation]).sort(),
      [
        ['actions', 'update'],
        ['characters', 'update'],
        ['events', 'insert'],
      ],
    );
    const eventChange = changes.find((change) => change.targetTable === 'events');
    assert.equal(eventChange.beforeJson, null);
    assert.equal(JSON.parse(eventChange.afterJson).title, '广场刺杀');
    assert.equal(JSON.parse(eventChange.afterJson).status, 'occurred');
    assert.equal(selectOne(seed.db, 'actions', IDS.branchMain, actionId).result_event_id, eventChange.targetRowId);

    assert.deepEqual(foreignKeyCheck(seed.db), []);
    assert.equal(validateCandidate(seed.db, { branchId: IDS.branchMain }).ok, true);
  } finally {
    seed.close();
  }
});

test('T08-15 真实编译器（P02 前向引用）：新建地点与人物按组落库，身份与详情同组', async () => {
  const seed = await fresh();
  try {
    const parsed = parseOperations(caseById('P02').response, { phase: 'observe' });
    assert.equal(parsed.operations.length, 2);
    const out = compileOperations({
      operations: parsed.operations,
      anchor: ANCHOR,
      phase: 'observe',
      clockS: 0,
      revision: 0,
      tables: createTableReadPort(seed.db),
      sources: { phase: 'observe', snapshot: SOURCE_SNAPSHOT, clockS: 0 },
      knownRefs: seed.refs.map((ref) => ({ alias: ref.alias, id: ref.id, kind: ref.kind })),
    });
    assert.deepEqual(out.issues, []);

    const built = buildAtomicGroups(
      out.results.map((entry) => ({
        opId: entry.opId,
        issues: entry.result.issues,
        mutations: entry.result.mutations,
        readSet: entry.result.readSet,
        dependencies: entry.result.dependencies,
        entityKeyWrites: entry.result.entityKeyWrites,
        operationKeys: entry.result.operationKeys,
      })),
    );
    assert.deepEqual(built.issues, []);
    assert.equal(built.groups.length, 2);
    // §2.2：四张实体表的 id 同时引用 entity_keys；身份和详情不能拆到两组。
    const tableSets = built.groups.map((group) => group.mutations.map((m) => m.table).sort());
    assert.deepEqual(tableSets.sort(), [['characters', 'entity_keys'], ['entity_keys', 'locations']]);

    const applied = applyGroups(seed.db, orderGroups(built.groups).order, APPLY_CTX);
    assert.deepEqual(applied.groups.map((entry) => entry.status), ['applied', 'applied']);

    const school = seed.db.exec(
      `SELECT id, name, parent_location_id, grid_x FROM locations WHERE branch_id='${IDS.branchMain}' AND name='圣光学校' AND id <> '${IDS.L2}'`,
    );
    assert.equal(school[0].values.length, 1);
    const [schoolId, schoolName, schoolParent, schoolGridX] = school[0].values[0];
    assert.equal(schoolName, '圣光学校');
    assert.equal(schoolParent, null);
    assert.equal(schoolGridX, null);

    const elin = seed.db.exec(
      `SELECT id, name, location_id, grid_x, grid_y FROM characters WHERE branch_id='${IDS.branchMain}' AND name='艾琳' AND id <> '${IDS.C1}'`,
    );
    assert.equal(elin[0].values.length, 1);
    const [, elinName, elinLocation, elinGridX, elinGridY] = elin[0].values[0];
    assert.equal(elinName, '艾琳');
    // 前向引用：人物行指向同批、由后一条操作声明的学校；精坐标保持 NULL。
    assert.equal(elinLocation, schoolId);
    assert.equal(elinGridX, null);
    assert.equal(elinGridY, null);
    assert.equal(selectOne(seed.db, 'entity_keys', IDS.branchMain, schoolId).kind, 'location');

    assert.deepEqual(
      readTurnChanges(seed.db, TURN_ID).map((change) => `${change.targetTable}:${change.operation}`).sort(),
      ['characters:insert', 'entity_keys:insert', 'entity_keys:insert', 'locations:insert'],
    );
    assert.deepEqual(foreignKeyCheck(seed.db), []);
    assert.equal(validateCandidate(seed.db, { branchId: IDS.branchMain }).ok, true);
  } finally {
    seed.close();
  }
});
