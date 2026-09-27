/**
 * atlas-db-commit.test.mjs — T10（§18.3）：applyGroups 的保存点、组边界不变量与候选发布时机。
 *
 * §18.3 要求的断言：
 * - 保存点回滚仅本组：一组违反真实约束只回滚该组，前后独立组照常落库，且事后没有悬挂事务（§16.5）；
 * - 最终真实不变量失败拒候选：SQL 通过但违反 §7.6 的组必须 rejected/INVARIANT_FAILED，行不写库；
 * - SQL 成功但未宿主保存不发布：Repository 的 `prepareTurn` 不改正式库，直到 `confirmSaved({result:'saved'})`；
 * - 空变更与失败区分：零变更无错误的组是 `applied/changedRows 0`，只有致命编译错误的组是 `rejected` + 该错误的 code；
 * - 幂等：同一 turn 内重复应用同组只报 `duplicate`，行数不翻倍。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, selectOne, countRows, foreignKeyCheck } from './fixtures/atlas-sql/seed.mjs';
import { SOURCE_SNAPSHOT } from './fixtures/atlas-sql/model-cases.mjs';
import { parseOperations } from '../src/atlas-ops-parser.ts';
import { compileOperations } from '../src/atlas-ops-compile.ts';
import { buildAtomicGroups, orderGroups } from '../src/atlas-ops-groups.ts';
import { applyGroups } from '../src/atlas-db-commit.ts';
import { readTurnChanges, operationAlreadyApplied } from '../src/atlas-db-journal.ts';
import { validateCandidate } from '../src/atlas-db-invariants.ts';
import { createRow } from '../src/atlas-db-defaults.ts';
import { createTableReadPort } from '../src/atlas-db-readport.ts';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { sha256Hex } from '../src/atlas-db-envelope.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { makeAnchor, makeCompileContext } from './helpers/atlas-compile-context.mjs';

const SQL = await (await import('sql.js')).default();

const ANCHOR = makeAnchor();
const TURN_ID = IDS.seedTurn;
const BRANCH = IDS.branchMain;
const APPLY_CTX = { branchId: BRANCH, turnId: TURN_ID, attemptId: 'attempt_t10' };

async function fresh() {
  return makeSeedWith(SQL);
}

function rowCtx(id, clockS = 0) {
  return { branchId: BRANCH, id, turnId: TURN_ID, clockS, nowWallMs: 1_700_000_000_000, rulesetVersion: 'atlas-1' };
}

function mutation(table, rowId, before, after, opId) {
  return { table, rowId, before, after, sourceOpIds: [opId], basis: { kind: 'simulation', reason: 'T10 合成' } };
}

/** 一组「entity_keys + characters」插入；withEntityKey=false 时真实触发 BEFORE INSERT 触发器。 */
function characterGroup(groupId, opId, charId, name, options = {}) {
  const row = createRow('characters', { name, identity: '合成测试人物' }, rowCtx(charId));
  const mutations = [];
  if (options.withEntityKey !== false) {
    mutations.push(mutation('entity_keys', charId, null, { branch_id: BRANCH, id: charId, kind: 'character' }, opId));
  }
  mutations.push(mutation('characters', charId, null, row, opId));
  return { id: groupId, opIds: [opId], dependsOn: [], readSet: [], mutations };
}

function actionsInsertGroup(groupId, opId, rowId, input) {
  const row = createRow('actions', input, rowCtx(rowId));
  return { id: groupId, opIds: [opId], dependsOn: [], readSet: [], mutations: [mutation('actions', rowId, null, row, opId)] };
}

/* ───────────────────────── 保存点回滚仅本组 ───────────────────────── */

test('T10-01 保存点回滚仅本组：中间组违反真实约束只回滚自己，前后独立组落库且无悬挂事务', async () => {
  const seed = await fresh();
  try {
    const first = characterGroup('grp_first', 'op_first', 'chr_first', '先成功');
    // 人物行没有 entity_keys 身份 → characters 的 BEFORE INSERT 触发器真实 ABORT。
    const broken = characterGroup('grp_broken', 'op_broken', 'chr_broken', '缺身份', { withEntityKey: false });
    const second = characterGroup('grp_second', 'op_second', 'chr_second', '后成功');

    seed.db.run('BEGIN');
    let result;
    assert.doesNotThrow(() => {
      result = applyGroups(seed.db, [first, broken, second], APPLY_CTX);
    });
    seed.db.run('COMMIT');

    assert.deepEqual(result.groups.map((group) => group.status), ['applied', 'rejected', 'applied']);
    const rejected = result.groups[1];
    assert.equal(rejected.groupId, 'grp_broken');
    assert.equal(rejected.changedRows, 0);
    assert.equal(rejected.issues[0].code, 'SQL_CONSTRAINT');
    assert.equal(rejected.issues[0].severity, 'error');
    assert.equal(rejected.issues[0].groupId, 'grp_broken');
    assert.ok(
      rejected.issues[0].message.includes('ENTITY_KEY_KIND_MISMATCH'),
      `必须保留 SQLite 原始错误语义：${rejected.issues[0].message}`,
    );

    // 只回滚本组：第一组与第三组的行都在，失败组一行不留。
    assert.equal(selectOne(seed.db, 'characters', BRANCH, 'chr_first').name, '先成功');
    assert.equal(selectOne(seed.db, 'characters', BRANCH, 'chr_broken'), null);
    assert.equal(selectOne(seed.db, 'characters', BRANCH, 'chr_second').name, '后成功');
    assert.equal(selectOne(seed.db, 'entity_keys', BRANCH, 'chr_broken'), null);
    // 变更日志也随保存点一起回滚：失败组没有留下任何 turn_changes。
    const changedRows = readTurnChanges(seed.db, TURN_ID).map((change) => change.targetRowId);
    assert.equal(changedRows.includes('chr_broken'), false);
    assert.deepEqual([...new Set(changedRows)].sort(), ['chr_first', 'chr_second']);

    // 没有悬挂事务/保存点：随后还能正常开一个事务并提交。
    assert.doesNotThrow(() => {
      seed.db.run('BEGIN');
      seed.db.run('COMMIT');
    });
    assert.deepEqual(foreignKeyCheck(seed.db), []);
    assert.equal(validateCandidate(seed.db, { branchId: BRANCH }).ok, true);
    assert.equal(countRows(seed.db, 'characters', BRANCH), 6, '种子的 4 人 + 两个成功组');
  } finally {
    seed.close();
  }
});

/* ───────────────────────── 最终真实不变量失败拒候选 ───────────────────────── */

test('T10-02 最终真实不变量失败拒候选：SQL 通过但违反 §7.6 的组 rejected/INVARIANT_FAILED 且不写行', async () => {
  const seed = await fresh();
  try {
    // payload_json 是普通 TEXT：SQLite 拦不住悬空的 JSON 引用，只有 E03 提交校验能拦。
    const group = actionsInsertGroup('grp_dangling_ref', 'op_dangling_ref', 'act_dangling_ref', {
      actor_entity_id: IDS.C3,
      kind: 'travel',
      title: '去一个不存在的地方',
      intent: '验证悬空 JSON 引用被拒',
      payload_json: { destination_ref: 'L_not_exist', via_refs: [], mobility_key: 'walk', stop_policy: 'review' },
      status: 'planned',
    });

    let result;
    assert.doesNotThrow(() => {
      result = applyGroups(seed.db, [group], { ...APPLY_CTX, attemptId: 'attempt_t10_invariant' });
    });
    assert.equal(result.groups.length, 1);
    const [rejected] = result.groups;
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.changedRows, 0);
    const invariantIssue = rejected.issues.find((issue) => issue.code === 'INVARIANT_FAILED');
    assert.ok(invariantIssue, `必须报 INVARIANT_FAILED：${JSON.stringify(rejected.issues)}`);
    assert.equal(invariantIssue.severity, 'error');
    assert.equal(invariantIssue.retryable, false, '不变量失败不是可重试的模型行错误');
    assert.ok(
      invariantIssue.message.includes('INVARIANT_JSON_REF_UNKNOWN'),
      `必须点名具体不变量：${invariantIssue.message}`,
    );
    assert.ok(invariantIssue.message.includes('destination_ref'));

    // 候选被拒：这一行没有写进库，基础世界仍然通过全部不变量。
    assert.equal(selectOne(seed.db, 'actions', BRANCH, 'act_dangling_ref'), null);
    assert.deepEqual(readTurnChanges(seed.db, TURN_ID), []);
    assert.equal(validateCandidate(seed.db, { branchId: BRANCH }).ok, true);
    assert.deepEqual(foreignKeyCheck(seed.db), []);
    assert.doesNotThrow(() => {
      seed.db.run('BEGIN');
      seed.db.run('COMMIT');
    });
  } finally {
    seed.close();
  }
});

test('T10-03 SQLite 约束先拒绝：物品双放置来源与「有坐标无地图」都 rejected 且原行逐字段不变', async () => {
  const seed = await fresh();
  try {
    const port = createTableReadPort(seed.db);
    const itemBefore = port.selectOne('items', BRANCH, IDS.I1);
    const locationBefore = port.selectOne('locations', BRANCH, IDS.L1);

    const itemGroup = {
      id: 'grp_item_two_sources',
      opIds: ['op_item_two_sources'],
      dependsOn: [],
      readSet: [{ table: 'items', rowId: IDS.I1, rowRev: Number(itemBefore.row_rev) }],
      mutations: [
        mutation('items', IDS.I1, itemBefore, { ...itemBefore, holder_character_id: IDS.C1, location_id: IDS.L2 }, 'op_item_two_sources'),
      ],
    };
    const locationGroup = {
      id: 'grp_location_without_map',
      opIds: ['op_location_without_map'],
      dependsOn: [],
      readSet: [{ table: 'locations', rowId: IDS.L1, rowRev: Number(locationBefore.row_rev) }],
      mutations: [mutation('locations', IDS.L1, locationBefore, { ...locationBefore, map_id: null }, 'op_location_without_map')],
    };

    const result = applyGroups(seed.db, [itemGroup, locationGroup], { ...APPLY_CTX, attemptId: 'attempt_t10_sql' });
    assert.deepEqual(result.groups.map((group) => group.status), ['rejected', 'rejected']);
    for (const group of result.groups) {
      assert.equal(group.changedRows, 0);
      assert.equal(group.issues[0].code, 'SQL_CONSTRAINT');
      assert.ok(group.issues[0].message.includes('CHECK'), `必须保留 CHECK 语义：${group.issues[0].message}`);
    }

    // 被拒组不写行：物品仍只有一个放置来源，地点仍有地图。
    assert.deepEqual(port.selectOne('items', BRANCH, IDS.I1), itemBefore);
    assert.deepEqual(port.selectOne('locations', BRANCH, IDS.L1), locationBefore);
    assert.equal(selectOne(seed.db, 'items', BRANCH, IDS.I1).location_id, null);
    assert.equal(selectOne(seed.db, 'locations', BRANCH, IDS.L1).map_id, IDS.M1);
    assert.deepEqual(foreignKeyCheck(seed.db), []);
  } finally {
    seed.close();
  }
});

/* ───────────────────────── 空变更与失败区分 ───────────────────────── */

test('T10-04 空变更与失败区分：零变更无错误 → applied/changedRows 0；只有致命编译错误 → rejected + 该 code', async () => {
  const seed = await fresh();
  try {
    // 1) 空变更：没有任何写集、也没有错误（例如纯 noop / 仅副作用）。
    const emptyGroup = { id: 'grp_empty_changes', opIds: ['op_empty_changes'], dependsOn: [], readSet: [], mutations: [] };
    const emptyResult = applyGroups(seed.db, [emptyGroup], { ...APPLY_CTX, attemptId: 'attempt_t10_empty' });
    assert.equal(emptyResult.groups[0].status, 'applied');
    assert.equal(emptyResult.groups[0].changedRows, 0);
    assert.deepEqual(emptyResult.groups[0].issues, []);

    // 2) 只有致命编译错误：decision 阶段不得改身份 → PHASE_FIELD_NOT_ALLOWED，且该 op 一行都不写。
    const parsed = parseOperations('{"op":"character.upsert","ref":"C1","data":{"identity":"王宫卫队长"}}', { phase: 'decision' });
    const ctx = makeCompileContext({
      seed,
      phase: 'decision',
      anchor: ANCHOR,
      clockS: 0,
      sources: { phase: 'decision', snapshot: SOURCE_SNAPSHOT, clockS: 0 },
    });
    const out = compileOperations({
      operations: parsed.operations,
      anchor: ctx.anchor,
      phase: ctx.phase,
      clockS: ctx.clockS,
      revision: ctx.revision,
      tables: ctx.tables,
      sources: ctx.sources,
      makeId: ctx.makeId,
      knownRefs: seed.refs.map((ref) => ({ alias: ref.alias, id: ref.id, kind: ref.kind })),
    });
    const fatalIssues = out.results[0].result.issues.filter((issue) => issue.severity === 'error');
    assert.deepEqual(fatalIssues.map((issue) => issue.code), ['PHASE_FIELD_NOT_ALLOWED']);
    assert.deepEqual(out.results[0].result.mutations, [], '编译期报错的 op 不产生写集');

    const built = buildAtomicGroups([
      {
        opId: out.results[0].opId,
        issues: out.results[0].result.issues,
        mutations: out.results[0].result.mutations,
        readSet: out.results[0].result.readSet,
        dependencies: out.results[0].result.dependencies,
      },
    ]);
    assert.equal(built.groups.length, 1);
    const fatalResult = applyGroups(seed.db, orderGroups(built.groups).order, {
      ...APPLY_CTX,
      attemptId: 'attempt_t10_fatal',
    });
    const [failed] = fatalResult.groups;
    assert.equal(failed.status, 'rejected');
    assert.equal(failed.changedRows, 0);
    assert.deepEqual(failed.issues.map((issue) => issue.code), ['PHASE_FIELD_NOT_ALLOWED']);
    assert.equal(failed.issues[0].severity, 'error');
    assert.equal(failed.issues[0].opId, out.results[0].opId);
    assert.equal(failed.issues[0].groupId, failed.groupId);

    // 该 op 没有被写：C1 的身份保持原值，也没有产生任何变更日志。
    assert.equal(selectOne(seed.db, 'characters', BRANCH, IDS.C1).identity, '学校教师');
    assert.deepEqual(readTurnChanges(seed.db, TURN_ID), []);
    assert.equal(operationAlreadyApplied(seed.db, TURN_ID, out.results[0].opId, 'characters', IDS.C1), false);

    // 两者靠状态与 issues 都能区分开。
    assert.notEqual(emptyResult.groups[0].status, failed.status);
    assert.deepEqual(emptyResult.groups[0].issues, []);
    assert.notDeepEqual(failed.issues, []);
    assert.equal(emptyResult.groups[0].changedRows, failed.changedRows);
  } finally {
    seed.close();
  }
});

/* ───────────────────────── 幂等 ───────────────────────── */

test('T10-05 幂等：同一 turn 重复应用同组 → duplicate/0 changed rows，行数与日志都不翻倍', async () => {
  const seed = await fresh();
  try {
    const group = characterGroup('grp_idem', 'op_idem', 'chr_idem', '只写一次');
    const before = countRows(seed.db, 'characters', BRANCH);

    const first = applyGroups(seed.db, [group], { ...APPLY_CTX, attemptId: 'attempt_t10_first' });
    assert.equal(first.groups[0].status, 'applied');
    assert.equal(first.groups[0].changedRows, 2);
    assert.equal(countRows(seed.db, 'characters', BRANCH), before + 1);

    const second = applyGroups(seed.db, [group], { ...APPLY_CTX, attemptId: 'attempt_t10_second', appliedKeys: first.appliedKeys });
    assert.equal(second.groups[0].status, 'duplicate');
    assert.equal(second.groups[0].changedRows, 0);
    assert.deepEqual(second.groups[0].issues, []);
    assert.equal(countRows(seed.db, 'characters', BRANCH), before + 1, '重复应用不能让行数翻倍');

    // 即使调用方忘了回传 appliedKeys，§7.6.9「已成功的操作不得再次应用」也必须成立：
    // 行内容、行数、变更日志都不翻倍，并且操作已被标记为已应用。
    applyGroups(seed.db, [group], { ...APPLY_CTX, attemptId: 'attempt_t10_third' });
    assert.equal(countRows(seed.db, 'characters', BRANCH), before + 1, '第三次应用同样不能让行数翻倍');
    assert.equal(selectOne(seed.db, 'characters', BRANCH, 'chr_idem').name, '只写一次');
    assert.equal(readTurnChanges(seed.db, TURN_ID).filter((change) => change.targetRowId === 'chr_idem').length, 2);
    assert.equal(operationAlreadyApplied(seed.db, TURN_ID, 'op_idem', 'characters', 'chr_idem'), true);
  } finally {
    seed.close();
  }
});

test(
  'T10-06 幂等回执：没有回传 appliedKeys 的重复应用也必须报 duplicate/0 changed rows',
  async () => {
    const seed = await fresh();
    try {
      const group = characterGroup('grp_idem_ack', 'op_idem_ack', 'chr_idem_ack', '回执只算一次');
      const first = applyGroups(seed.db, [group], { ...APPLY_CTX, attemptId: 'attempt_t10_ack_first' });
      assert.equal(first.groups[0].status, 'applied');
      assert.equal(first.groups[0].changedRows, 2);

      // 同一 turn 内重复应用：一行都不写，回执也必须说「没有变更」。
      const second = applyGroups(seed.db, [group], { ...APPLY_CTX, attemptId: 'attempt_t10_ack_second' });
      assert.equal(second.groups[0].status, 'duplicate');
      assert.equal(second.groups[0].changedRows, 0);
    } finally {
      seed.close();
    }
  },
);

/* ───────────────────────── SQL 成功但未宿主保存不发布 ───────────────────────── */

function scriptedModel(responses) {
  const calls = [];
  return {
    calls,
    async request(req) {
      calls.push(req);
      const text = responses.length > 0 ? responses.shift() : '{"op":"noop"}';
      return { batchId: req.batchId, text, finishReason: 'stop', httpStatus: 200, durationMs: 5 };
    },
  };
}

function anchorFor(chatUid, baseRevision, overrides = {}) {
  return {
    chatUid,
    branchId: BRANCH,
    parentTurnId: TURN_ID,
    hostMessageUid: 'msg_1',
    variantKey: 'v1',
    baseRevision,
    baseStorageRevision: 0,
    inputHash: 'input_hash_t10',
    ...overrides,
  };
}

async function makeRepo(responses) {
  const model = scriptedModel(responses);
  const repo = createSqlRepository({
    chatUid: IDS.chatA,
    branchId: BRANCH,
    branchName: '主线',
    modelPort: model,
    now: () => 1_700_000_000_000,
    makeId: (kind, opId, alias) => `${kind.slice(0, 3)}_${Buffer.from(`${opId}:${alias}`).toString('hex').slice(0, 20)}`,
  });
  const seed = await makeSeedWith(SQL);
  const bytes = seed.exportBytes();
  seed.close();
  await repo.open({ bytes });
  return { repo, model };
}

test('T10-07 SQL 成功但未宿主保存不发布：prepareTurn 不动正式库，saved 才发布', async () => {
  const { repo } = await makeRepo([
    '{"op":"location.upsert","ref":"new:tower","data":{"name":"钟楼","kind":"building"}}',
    '{"op":"location.upsert","ref":"new:tower","data":{"name":"钟楼","kind":"building"}}',
  ]);
  try {
    const beforeHash = await sha256Hex(await repo.exportCurrent());
    const prepared = await repo.prepareTurn({
      anchor: anchorFor(IDS.chatA, 0),
      userText: '他望向钟楼。',
      assistantText: '钟楼在雨里。',
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    assert.equal(prepared.receipt.status, 'committed');
    assert.ok(prepared.receipt.groups.some((group) => group.status === 'applied'));
    assert.match(prepared.snapshotSha256, /^[0-9a-f]{64}$/);

    // 候选里确实建了钟楼，但正式库完全没变。
    const candidate = repo.getCandidate(prepared.token);
    assert.ok(candidate, '候选必须保留待宿主确认');
    const candidateRow = candidate.db.exec("SELECT id FROM locations WHERE name='钟楼'");
    assert.equal(candidateRow[0].values.length, 1);
    const towerId = String(candidateRow[0].values[0][0]);
    assert.equal(await sha256Hex(await repo.exportCurrent()), beforeHash, '未确认保存前正式库不得变化');

    const view = await repo.queryView({ kind: 'map', branchId: BRANCH });
    const visibleIds = view.items.flatMap((map) => [...map.points, ...map.coarseList].map((point) => point.entityId));
    assert.equal(visibleIds.includes(towerId), false, '正式视图不应看到候选改动');

    // 宿主明确失败：仍然不发布，且候选被丢弃。
    await repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'failed' });
    assert.equal(await sha256Hex(await repo.exportCurrent()), beforeHash, '保存失败后正式库必须逐字节一致');
    assert.equal(repo.getCandidate(prepared.token), null);
    assert.equal(countRows(repo.db, 'locations', BRANCH), 3, '正式库仍是种子里的三个地点');

    // 只有宿主 saved 才发布：同一基版本重做一次并确认。
    const second = await repo.prepareTurn({
      anchor: anchorFor(IDS.chatA, 0, { hostMessageUid: 'msg_2' }),
      userText: '他望向钟楼。',
      assistantText: '钟楼在雨里。',
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    assert.equal(second.receipt.status, 'committed');
    await repo.confirmSaved({ token: second.token, snapshotSha256: second.snapshotSha256, result: 'saved' });
    assert.equal(countRows(repo.db, 'locations', BRANCH), 4, 'saved 之后新地点才可见');
    assert.notEqual(await sha256Hex(await repo.exportCurrent()), beforeHash);
    const branch = queryBound(repo.db, 'SELECT revision FROM branches WHERE id = ?', [BRANCH]);
    assert.equal(Number(branch[0].revision), 1);
  } finally {
    await repo.close();
  }
});
