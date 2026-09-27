/**
 * atlas-ops-actions.test.mjs — T07（§18.3）：计划与行动的编译、改未来、未知时间等待与取消释放。
 *
 * §18.3 要求的断言：
 * - 计划未执行不移动：`plan.propose` 建立父 goal + 子步骤，**不建 journeys 行**，人物位置不变（§4.4）；
 * - 改未来步骤保留过去：`plan.revise` replace_future 只取消未完成子步骤，已完成步骤逐字段不变；
 * - 等待时间未知典礼：没有时间叶子的 wait 条件保持 blocked/CONDITION_UNCOMPILED 并留 warning（§8.4）；
 * - 取消释放主行动占用：parent + 未完成子行动 cancelled，之后同一人物仍可提出新计划；
 * - §4.3 形式上限被拒绝而不是静默截断：depends_on_json > 8 项、travel step 缺 destination_ref。
 *
 * 全部通过真实编译路径：`parseOperations` → `compileOperations`（`makeCompileContext` 提供真实
 * TableReadPort / 确定性 makeId）→ `buildAtomicGroups`/`orderGroups` → `applyGroups` 落库。
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
import { SOURCE_SNAPSHOT } from './fixtures/atlas-sql/model-cases.mjs';
import { parseOperations } from '../src/atlas-ops-parser.ts';
import { compileOperations } from '../src/atlas-ops-compile.ts';
import { compilePlanPropose, compilePlanRevise } from '../src/atlas-ops-actions.ts';
import { buildAtomicGroups, orderGroups } from '../src/atlas-ops-groups.ts';
import { applyGroups } from '../src/atlas-db-commit.ts';
import { createRow } from '../src/atlas-db-defaults.ts';
import { validateCandidate } from '../src/atlas-db-invariants.ts';
import { makeAnchor, makeCompileContext } from './helpers/atlas-compile-context.mjs';

const SQL = await (await import('sql.js')).default();

const ANCHOR = makeAnchor();
const TURN_ID = IDS.seedTurn;
const BRANCH = IDS.branchMain;

async function fresh() {
  return makeSeedWith(SQL);
}

function rowCtx(id, clockS = 0) {
  return { branchId: BRANCH, id, turnId: TURN_ID, clockS, nowWallMs: 1_700_000_000_000, rulesetVersion: 'atlas-1' };
}

function knownRefsOf(seed, extra = []) {
  return [...seed.refs.map((ref) => ({ alias: ref.alias, id: ref.id, kind: ref.kind })), ...extra];
}

/** 真实编译路径：parser → compileOperations（上下文来自 makeCompileContext）。 */
function compileText(seed, text, { phase = 'decision', clockS = 0, extraRefs = [] } = {}) {
  const parsed = parseOperations(text, { phase });
  const ctx = makeCompileContext({
    seed,
    phase,
    anchor: ANCHOR,
    clockS,
    sources: { phase, snapshot: SOURCE_SNAPSHOT, clockS },
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
    knownRefs: knownRefsOf(seed, extraRefs),
  });
  return { parsed, ctx, out };
}

/** 编译结果 → 分组 → 拓扑排序 → 真实事务落库。 */
function groupAndApply(seed, out, { attemptId = 'attempt_t07' } = {}) {
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
  const ordered = orderGroups(built.groups);
  const applied = applyGroups(seed.db, ordered.order, { branchId: BRANCH, turnId: TURN_ID, attemptId });
  return { built, ordered, applied };
}

/** 父 goal 行与它的直接子步骤行（保持 result.mutations 的原始顺序）。 */
function planRows(result) {
  const rows = result.mutations.filter((m) => m.table === 'actions').map((m) => m.after);
  const parent = rows.find((row) => row.parent_action_id === null);
  assert.ok(parent, '计划必须有父 goal 行');
  const steps = rows.filter((row) => row.parent_action_id === parent.id);
  return { parent, steps };
}

function actionRow(seed, id) {
  return selectOne(seed.db, 'actions', BRANCH, id);
}

function decodedAction(seed, id) {
  return makeCompileContext({ seed, phase: 'decision', anchor: ANCHOR, clockS: 0 }).tables.selectOne('actions', BRANCH, id);
}

/** 用真实 applyGroups 造出「已经过去」的行动状态（不改 schema、不绕过写入层）。 */
function patchActionRow(seed, id, patch, attemptId) {
  const before = decodedAction(seed, id);
  assert.ok(before, `行动行必须存在：${id}`);
  const after = { ...before, ...patch, row_rev: Number(before.row_rev ?? 1) + 1, updated_turn_id: TURN_ID };
  const group = {
    id: `grp_patch_${id}`,
    opIds: [`op_patch_${id}`],
    dependsOn: [],
    readSet: [{ table: 'actions', rowId: id, rowRev: Number(before.row_rev ?? 1) }],
    mutations: [
      {
        table: 'actions',
        rowId: id,
        before,
        after,
        sourceOpIds: [`op_patch_${id}`],
        basis: { kind: 'simulation', reason: 'T07 构造已经发生的过去步骤' },
      },
    ],
  };
  const result = applyGroups(seed.db, [group], { branchId: BRANCH, turnId: TURN_ID, attemptId });
  assert.equal(result.groups[0].status, 'applied');
  return { before, after };
}

const TRAVEL_PLAN =
  '{"op":"plan.propose","data":{"actor_ref":"C3","goal":"去圣光学校查清校长的底细","secrecy":"secret","steps":[' +
  '{"kind":"prepare","title":"准备伪装","method":"弄一身教师衣服"},' +
  '{"kind":"travel","title":"前往圣光学校","destination_ref":"L2","mobility_key":"walk","stop_policy":"review","requires_action_ref":"0"}]}}';

/* ───────────────────────── 计划未执行不移动 ───────────────────────── */

test('T07-01 计划未执行不移动：plan.propose 建父 goal + 子步骤，不建 journeys 行且人物位置不变', async () => {
  const seed = await fresh();
  try {
    const beforeActor = makeCompileContext({ seed, phase: 'decision', anchor: ANCHOR, clockS: 0 }).tables.selectOne(
      'characters',
      BRANCH,
      IDS.C3,
    );
    assert.equal(beforeActor.location_id, IDS.L1);
    assert.equal(countRows(seed.db, 'journeys', BRANCH), 0);

    const { out } = compileText(seed, TRAVEL_PLAN);
    assert.deepEqual(out.issues, []);
    assert.equal(out.results.length, 1);

    const { parent, steps } = planRows(out.results[0].result);
    assert.equal(parent.kind, 'goal');
    assert.equal(parent.actor_entity_id, IDS.C3);
    assert.equal(parent.parent_action_id, null);
    assert.equal(parent.status, 'planned');
    assert.equal(parent.secrecy, 'secret');
    assert.equal(steps.length, 2);
    assert.deepEqual(steps.map((step) => step.kind), ['prepare', 'travel']);
    assert.equal(steps[0].parent_action_id, parent.id);
    assert.equal(steps[1].target_location_id, IDS.L2);
    assert.equal(steps[1].payload_json.destination_ref, IDS.L2);
    assert.equal(steps[1].status, 'planned');
    // 依赖用序号表达：后一步依赖前一步的确定性 ID。
    assert.deepEqual(steps[1].depends_on_json, [steps[0].id]);
    // 「说想去 C」不等于已经在 C：编译结果里没有任何 journeys 变更。
    assert.equal(out.results[0].result.mutations.some((m) => m.table === 'journeys'), false);

    const { applied } = groupAndApply(seed, out);
    assert.deepEqual(applied.groups.map((g) => g.status), ['applied']);
    assert.equal(countRows(seed.db, 'actions', BRANCH), 3);
    assert.equal(countRows(seed.db, 'journeys', BRANCH), 0, '计划未执行不得建立行程');
    assert.equal(actionRow(seed, parent.id).status, 'planned');
    assert.equal(actionRow(seed, steps[1].id).target_location_id, IDS.L2);
    // 人物位置没有被计划带偏。
    assert.equal(
      makeCompileContext({ seed, phase: 'decision', anchor: ANCHOR, clockS: 0 }).tables.selectOne('characters', BRANCH, IDS.C3)
        .location_id,
      IDS.L1,
    );
    assert.deepEqual(foreignKeyCheck(seed.db), []);
    assert.equal(validateCandidate(seed.db, { branchId: BRANCH }).ok, true);
  } finally {
    seed.close();
  }
});

/* ───────────────────────── 改未来不动过去 ───────────────────────── */

test('T07-02 改未来步骤保留过去：replace_future 只取消未完成子步骤，已完成步骤逐字段不变', async () => {
  const seed = await fresh();
  try {
    const proposed = compileText(seed, TRAVEL_PLAN);
    assert.deepEqual(proposed.out.issues, []);
    groupAndApply(seed, proposed.out, { attemptId: 'attempt_t07_propose' });
    const { parent, steps } = planRows(proposed.out.results[0].result);
    const [pastStep, futureStep] = steps;

    // 第一步已经真正发生过（例如已经经过 B）：completed + finished_at_s。
    patchActionRow(seed, pastStep.id, { status: 'completed', finished_at_s: 120 }, 'attempt_t07_past');
    const pastBefore = decodedAction(seed, pastStep.id);
    const parentBefore = decodedAction(seed, parent.id);
    assert.equal(pastBefore.status, 'completed');
    assert.equal(pastBefore.finished_at_s, 120);

    const revised = compileText(
      seed,
      `{"op":"plan.revise","ref":"A1","data":{"change":"replace_future","steps":[{"kind":"travel","title":"改去教室","destination_ref":"L3","mobility_key":"walk"}]}}`,
      { clockS: 300, extraRefs: [{ alias: 'A1', id: parent.id, kind: 'action' }] },
    );
    assert.deepEqual(revised.out.issues, []);
    const result = revised.out.results[0].result;

    const updates = result.mutations.filter((m) => m.before !== null);
    const inserts = result.mutations.filter((m) => m.before === null);
    assert.equal(updates.length, 1, '只有未完成的子步骤被改写');
    assert.equal(updates[0].rowId, futureStep.id);
    assert.equal(updates[0].after.status, 'cancelled');
    assert.equal(updates[0].after.reason_code, 'PLAN_REPLACED');
    assert.equal(inserts.length, 1, '新步骤作为新行加入');
    assert.equal(inserts[0].after.parent_action_id, parent.id);
    assert.equal(inserts[0].after.target_location_id, IDS.L3);
    assert.equal(inserts[0].after.status, 'planned');
    // 过去那一步根本不在写集里。
    assert.equal(
      result.mutations.some((m) => m.rowId === pastStep.id),
      false,
      '已经完成的步骤不能被改未来碰到',
    );

    const { applied } = groupAndApply(seed, revised.out, { attemptId: 'attempt_t07_revise' });
    assert.deepEqual(applied.groups.map((g) => g.status), ['applied']);
    assert.deepEqual(decodedAction(seed, pastStep.id), pastBefore, '过去步骤必须逐字段不变');
    assert.equal(actionRow(seed, pastStep.id).status, 'completed');
    assert.equal(actionRow(seed, pastStep.id).finished_at_s, 120);
    assert.equal(actionRow(seed, futureStep.id).status, 'cancelled');
    assert.equal(actionRow(seed, futureStep.id).reason_code, 'PLAN_REPLACED');
    assert.deepEqual(decodedAction(seed, parent.id), parentBefore, '父计划本身不被 replace_future 改写');
    assert.equal(actionRow(seed, parent.id).status, 'planned');
    const newStep = actionRow(seed, inserts[0].after.id);
    assert.equal(newStep.target_location_id, IDS.L3);
    assert.equal(newStep.status, 'planned');
    assert.equal(countRows(seed.db, 'journeys', BRANCH), 0);
  } finally {
    seed.close();
  }
});

/* ───────────────────────── 等待时间未知典礼 ───────────────────────── */

test('T07-03 等待时间未知典礼：没有时间叶子 → blocked/CONDITION_UNCOMPILED + warning，不编具体时刻', async () => {
  const seed = await fresh();
  try {
    const text =
      '{"op":"plan.propose","data":{"actor_ref":"C4","goal":"等国王典礼结束再动手","steps":[' +
      '{"kind":"wait","title":"等典礼","wait_for_status":"国王的典礼开始的时候"}]}}';
    const { parsed, out } = compileText(seed, text);
    assert.equal(out.issues.length, 1);
    const warning = out.issues[0];
    assert.equal(warning.code, 'CONDITION_UNCOMPILED');
    assert.equal(warning.severity, 'warning');
    assert.equal(warning.retryable, false);
    assert.equal(warning.path, '$.data.steps[0]');
    assert.ok(warning.message.includes('国王的典礼开始的时候'), 'warning 必须保留原始条件文本');

    const { steps } = planRows(out.results[0].result);
    assert.equal(steps.length, 1);
    const wait = steps[0];
    assert.equal(wait.kind, 'wait');
    assert.equal(wait.status, 'blocked');
    assert.equal(wait.reason_code, 'CONDITION_UNCOMPILED');
    assert.equal(wait.intent, '国王的典礼开始的时候', '条件原文保留在 intent');
    // 「不为典礼编一个明天 8 点」：没有条件树、没有时间叶子、没有 next_check_s。
    assert.equal(wait.trigger_json, null);
    assert.equal(wait.next_check_s, null);
    assert.equal(Object.prototype.hasOwnProperty.call(wait.payload_json, 'until'), false);
    assert.deepEqual(wait.payload_json, {});

    // 同一个符号（src/atlas-ops-actions.ts::compilePlanPropose）直接调用也给出同样结论。
    const direct = compilePlanPropose(
      parsed.operations[0],
      makeCompileContext({ seed, phase: 'decision', anchor: ANCHOR, clockS: 0 }),
    );
    assert.equal(direct.issues[0].code, 'CONDITION_UNCOMPILED');
    const directStep = direct.mutations.find((m) => m.after.parent_action_id !== null).after;
    assert.equal(directStep.status, 'blocked');
    assert.equal(directStep.reason_code, 'CONDITION_UNCOMPILED');

    const { applied } = groupAndApply(seed, out, { attemptId: 'attempt_t07_wait' });
    assert.deepEqual(applied.groups.map((g) => g.status), ['applied']);
    const stored = actionRow(seed, wait.id);
    assert.equal(stored.status, 'blocked');
    assert.equal(stored.reason_code, 'CONDITION_UNCOMPILED');
    assert.equal(stored.next_check_s, null);
    assert.equal(countRows(seed.db, 'journeys', BRANCH), 0);
  } finally {
    seed.close();
  }
});

/* ───────────────────────── 取消释放主行动占用 ───────────────────────── */

test('T07-04 取消释放主行动占用：父与未完成子行动 cancelled，之后同一人物仍能提出新计划', async () => {
  const seed = await fresh();
  try {
    const proposed = compileText(seed, TRAVEL_PLAN);
    groupAndApply(seed, proposed.out, { attemptId: 'attempt_t07_propose' });
    const { parent, steps } = planRows(proposed.out.results[0].result);
    patchActionRow(seed, steps[0].id, { status: 'completed', finished_at_s: 60 }, 'attempt_t07_past');

    const cancelled = compileText(
      seed,
      '{"op":"plan.revise","ref":"A1","data":{"change":"cancel","why":"目标已经不存在"}}',
      { clockS: 600, extraRefs: [{ alias: 'A1', id: parent.id, kind: 'action' }] },
    );
    assert.deepEqual(cancelled.out.issues, []);
    const cancelResult = cancelled.out.results[0].result;
    // 父 + 未完成子行动都拿到 finished_at_s；已经完成的历史不重新计时。
    const touched = cancelResult.mutations.map((m) => m.rowId).sort();
    assert.deepEqual(touched, [parent.id, steps[1].id].sort());
    for (const mutation of cancelResult.mutations) {
      assert.equal(mutation.after.status, 'cancelled');
      assert.equal(mutation.after.reason_code, 'PLAN_CANCELLED');
      assert.equal(mutation.after.finished_at_s, 600);
    }
    assert.equal(cancelResult.mutations.some((m) => m.rowId === steps[0].id), false, '已完成步骤不被取消改写');

    const { applied } = groupAndApply(seed, cancelled.out, { attemptId: 'attempt_t07_cancel' });
    assert.deepEqual(applied.groups.map((g) => g.status), ['applied']);
    const oldParent = actionRow(seed, parent.id);
    assert.equal(oldParent.status, 'cancelled');
    assert.equal(oldParent.finished_at_s, 600);
    assert.equal(actionRow(seed, steps[1].id).status, 'cancelled');
    assert.equal(actionRow(seed, steps[1].id).finished_at_s, 600);
    assert.equal(actionRow(seed, steps[0].id).status, 'completed');

    // 取消释放占用：这个人物不再有未结束的主行动。
    const openRows = seed.db.exec(
      `SELECT COUNT(*) FROM actions WHERE branch_id='${BRANCH}' AND actor_entity_id='${IDS.C3}' AND parent_action_id IS NULL AND status IN ('planned','ready','active','paused','blocked')`,
    );
    assert.equal(Number(openRows[0].values[0][0]), 0, '取消后不应再有未结束的主计划');

    // 同一人物可以提出另一份计划：没有任何东西挡着它。
    const next = compileText(
      seed,
      '{"op":"plan.propose","data":{"actor_ref":"C3","goal":"改去教室躲雨","steps":[{"kind":"travel","title":"去教室","destination_ref":"L3","mobility_key":"walk"}]}}',
      { clockS: 900 },
    );
    assert.deepEqual(next.out.issues, []);
    const { applied: secondApplied } = groupAndApply(seed, next.out, { attemptId: 'attempt_t07_next' });
    assert.deepEqual(secondApplied.groups.map((g) => g.status), ['applied']);
    const nextPlan = planRows(next.out.results[0].result);
    const nextParentRow = actionRow(seed, nextPlan.parent.id);
    assert.ok(nextParentRow, '新计划的父行必须真实存在');
    assert.equal(nextParentRow.status, 'planned');
    assert.equal(nextParentRow.actor_entity_id, IDS.C3);
    assert.notEqual(nextPlan.parent.id, parent.id, '新计划是新行，不覆盖被取消的旧计划');
    assert.equal(actionRow(seed, nextPlan.steps[0].id).status, 'planned');
    assert.equal(actionRow(seed, parent.id).status, 'cancelled', '旧计划保持 cancelled，不因新计划复活');
    assert.equal(countRows(seed.db, 'journeys', BRANCH), 0);
    assert.deepEqual(foreignKeyCheck(seed.db), []);
  } finally {
    seed.close();
  }
});

/* ───────────────────────── §4.3 形式上限：拒绝而不是静默截断 ───────────────────────── */

test('T07-05 depends_on_json 超过 8 项被拒绝：模型字段被点名忽略，超限行在组边界拒绝且不写库', async () => {
  const seed = await fresh();
  try {
    // 1) 模型不可能靠 data.depends_on_json 直接塞依赖：该字段被点名忽略，也不会留下一个「截断到 8 项」的副本。
    const text =
      '{"op":"plan.propose","data":{"actor_ref":"C3","goal":"带九个依赖的计划","depends_on_json":["a","b","c","d","e","f","g","h","i"],"steps":[{"kind":"prepare","title":"准备"}]}}';
    const { out } = compileText(seed, text);
    const ignored = out.issues.find((issue) => issue.code === 'FIELD_IGNORED' && issue.path === '$.data.depends_on_json');
    assert.ok(ignored, `必须点名 depends_on_json：${JSON.stringify(out.issues)}`);
    assert.ok(ignored.message.includes('depends_on_json'));
    const { parent, steps } = planRows(out.results[0].result);
    assert.deepEqual(steps[0].depends_on_json, [], '不得静默截断成 8 项');
    assert.deepEqual(parent.depends_on_json, []);

    // 2) 真正带 9 项依赖的行动行必须被组边界拒绝：8 项通过、9 项拒绝。
    const depIds = [];
    const depRows = [];
    for (let i = 0; i < 9; i += 1) {
      const id = `act_dep_${i}`;
      depIds.push(id);
      depRows.push(createRow('actions', { actor_entity_id: IDS.C3, kind: 'prepare', title: `前置${i}`, intent: '', status: 'planned' }, rowCtx(id)));
    }
    insertRows(seed.db, 'actions', depRows);

    const makeGroup = (rowId, deps) => ({
      id: `grp_${rowId}`,
      opIds: [`op_${rowId}`],
      dependsOn: [],
      readSet: [],
      mutations: [
        {
          table: 'actions',
          rowId,
          before: null,
          after: createRow(
            'actions',
            {
              actor_entity_id: IDS.C3,
              kind: 'goal',
              title: '依赖数量上限',
              intent: '验证 §4.3 的 8 项上限',
              depends_on_json: deps,
              status: 'planned',
            },
            rowCtx(rowId),
          ),
          sourceOpIds: [`op_${rowId}`],
          basis: { kind: 'simulation', reason: 'T07-05 依赖数量上限' },
        },
      ],
    });

    const okRow = createRow('actions', { actor_entity_id: IDS.C3, kind: 'goal', title: '八项依赖', intent: '边界内', depends_on_json: depIds.slice(0, 8), status: 'planned' }, rowCtx('act_dep_eight'));
    const okResult = applyGroups(
      seed.db,
      [
        {
          id: 'grp_dep_eight',
          opIds: ['op_dep_eight'],
          dependsOn: [],
          readSet: [],
          mutations: [{ table: 'actions', rowId: 'act_dep_eight', before: null, after: okRow, sourceOpIds: ['op_dep_eight'], basis: { kind: 'simulation' } }],
        },
      ],
      { branchId: BRANCH, turnId: TURN_ID, attemptId: 'attempt_t07_eight' },
    );
    assert.equal(okResult.groups[0].status, 'applied', '恰好 8 项依赖是合法的');
    assert.equal(actionRow(seed, 'act_dep_eight').id, 'act_dep_eight');
    assert.equal(JSON.parse(actionRow(seed, 'act_dep_eight').depends_on_json).length, 8);

    const tooManyGroup = makeGroup('act_dep_nine', depIds);
    let nineResult;
    assert.doesNotThrow(() => {
      nineResult = applyGroups(seed.db, [tooManyGroup], { branchId: BRANCH, turnId: TURN_ID, attemptId: 'attempt_t07_nine' });
    });
    assert.equal(nineResult.groups[0].status, 'rejected');
    assert.equal(nineResult.groups[0].changedRows, 0);
    const violation = nineResult.groups[0].issues.find((issue) => issue.code === 'INVARIANT_FAILED');
    assert.ok(violation, `必须报 INVARIANT_FAILED：${JSON.stringify(nineResult.groups[0].issues)}`);
    assert.ok(
      violation.message.includes('INVARIANT_ACTION_DEPENDENCY_COUNT'),
      `必须点名不变量而不是泛泛报错：${violation.message}`,
    );
    assert.ok(violation.message.includes('depends_on_json'));
    assert.equal(violation.retryable, false);
    assert.equal(actionRow(seed, 'act_dep_nine'), null, '超限的行不能写进库（不得截断后写入）');
    assert.deepEqual(foreignKeyCheck(seed.db), []);
    assert.equal(validateCandidate(seed.db, { branchId: BRANCH }).ok, true);
  } finally {
    seed.close();
  }
});

test('T07-06 travel step 缺 destination_ref 被拒绝：MINIMUM_FIELD_MISSING 点名字段，整份计划一行不写', async () => {
  const seed = await fresh();
  try {
    const badPlan =
      '{"op":"plan.propose","data":{"actor_ref":"C3","goal":"去一个还没想好的地方","steps":[{"kind":"travel","title":"出发","mobility_key":"walk"}]}}';
    const { out } = compileText(seed, badPlan);
    const missing = out.issues.find((issue) => issue.code === 'MINIMUM_FIELD_MISSING');
    assert.ok(missing, `必须报 MINIMUM_FIELD_MISSING：${JSON.stringify(out.issues)}`);
    assert.equal(missing.path, '$.data.steps[0].destination_ref');
    assert.equal(missing.severity, 'error');
    assert.ok(missing.message.includes('destination_ref'));
    assert.deepEqual(out.results[0].result.mutations, [], '缺目的地的旅行步骤不能落成一个「没有目的地」的计划');

    // 直接调用 src/atlas-ops-actions.ts::compilePlanPropose 也是同一个字段级错误。
    const parsed = parseOperations(badPlan, { phase: 'decision' });
    const direct = compilePlanPropose(parsed.operations[0], makeCompileContext({ seed, phase: 'decision', anchor: ANCHOR, clockS: 0 }));
    assert.equal(direct.issues[0].code, 'MINIMUM_FIELD_MISSING');
    assert.equal(direct.issues[0].path, '$.data.steps[0].destination_ref');
    assert.deepEqual(direct.mutations, []);

    // 改未来的坏步骤同样不能半途改写：整条 revise 被拒，现有子步骤保持 planned。
    const proposed = compileText(seed, TRAVEL_PLAN);
    groupAndApply(seed, proposed.out, { attemptId: 'attempt_t07_propose' });
    const { parent, steps } = planRows(proposed.out.results[0].result);

    const badRevise = compileText(
      seed,
      '{"op":"plan.revise","ref":"A1","data":{"change":"replace_future","steps":[{"kind":"travel","title":"出发"}]}}',
      { clockS: 300, extraRefs: [{ alias: 'A1', id: parent.id, kind: 'action' }] },
    );
    const reviseIssue = badRevise.out.issues.find((issue) => issue.code === 'MINIMUM_FIELD_MISSING');
    assert.ok(reviseIssue);
    assert.equal(reviseIssue.path, '$.data.steps[0].destination_ref');
    assert.deepEqual(badRevise.out.results[0].result.mutations, [], '报错时不得先取消旧步骤');
    assert.equal(actionRow(seed, steps[1].id).status, 'planned');
    assert.equal(actionRow(seed, parent.id).status, 'planned');

    // 直接调用 compilePlanRevise 也拒绝同一个字段。
    const parsedRevise = parseOperations(
      '{"op":"plan.revise","ref":"A1","data":{"change":"replace_future","steps":[{"kind":"travel","title":"出发"}]}}',
      { phase: 'decision' },
    );
    const ctx = makeCompileContext({ seed, phase: 'decision', anchor: ANCHOR, clockS: 300 });
    const directRevise = compilePlanRevise(parsedRevise.operations[0], {
      ...ctx,
      scope: (() => {
        const scope = ctx.scope;
        scope.declare({ alias: 'A1', id: parent.id, kind: 'action', rowRev: null, declaredByOpId: null });
        return scope;
      })(),
    });
    assert.equal(directRevise.issues[0].code, 'MINIMUM_FIELD_MISSING');
    assert.equal(directRevise.issues[0].path, '$.data.steps[0].destination_ref');
    assert.deepEqual(directRevise.mutations, []);
    assert.equal(countRows(seed.db, 'journeys', BRANCH), 0);
    assert.deepEqual(foreignKeyCheck(seed.db), []);
  } finally {
    seed.close();
  }
});
