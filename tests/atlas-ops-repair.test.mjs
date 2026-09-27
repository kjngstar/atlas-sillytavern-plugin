/**
 * atlas-ops-repair.test.mjs — T09（§18.3）：定向修复票据、作用域与合并。
 *
 * §18.3 要求的断言：
 * - 部分成功也会修失败组：真实 `applyGroups` 部分成功时，只有失败组的操作进入修复批次（§7.5、§8.2 repair）；
 * - 最多一次：每批一次纠错额度，用完只报 `REPAIR_ATTEMPTS_EXHAUSTED` 并原样返回（§7.5）；
 * - ticket 映射：修复条目映射回**原 opId / 原行号**，已成功操作不重新编号（§16.5 步骤 6）；
 * - 成功 opId 不变：修复后的操作仍用原 opId，确定性 ID 不漂移；
 * - 超范围修复拒绝：非法 op、原依赖集合之外的新 `new:` 别名 → `REPAIR_SCOPE_VIOLATION`，局部失败不牵连（§16.5 步骤 7）；
 * - 缺票据具体报错：缺少 ticket 的条目要点名票据缺失并列出本批票据，不是泛泛一句错误。
 *
 * 真实入口：`src/atlas-ops-repair.ts` 的 `buildRepairBatch` / `mergeRepair`，失败组由
 * `parseOperations` → `compileOperations` → `applyGroups` 真实产出。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, countRows } from './fixtures/atlas-sql/seed.mjs';
import { SOURCE_SNAPSHOT } from './fixtures/atlas-sql/model-cases.mjs';
import { parseOperations } from '../src/atlas-ops-parser.ts';
import { compileOperations } from '../src/atlas-ops-compile.ts';
import { buildAtomicGroups, orderGroups } from '../src/atlas-ops-groups.ts';
import { applyGroups } from '../src/atlas-db-commit.ts';
import { buildRepairBatch, mergeRepair } from '../src/atlas-ops-repair.ts';
import { createTableReadPort } from '../src/atlas-db-readport.ts';
import { makeAnchor, makeCompileContext } from './helpers/atlas-compile-context.mjs';

const SQL = await (await import('sql.js')).default();

const ANCHOR = makeAnchor();
const TURN_ID = IDS.seedTurn;
const BRANCH = IDS.branchMain;

async function fresh() {
  return makeSeedWith(SQL);
}

/** 两个失败操作 → 两张票据（R1/R2）；用于映射、越权、重复票据等断言。 */
function ticketFixture({ allowedOps = ['character.upsert'] } = {}) {
  const parsed = parseOperations(
    '{"op":"character.upsert","ref":"C1","data":{"location_ref":"new:missing"}}\n' +
      '{"op":"character.upsert","ref":"C2","data":{"thought":"保持观察。"}}',
    { phase: 'repair' },
  );
  assert.equal(parsed.operations.length, 2);
  const original = parsed.operations;
  const issueFor = (index, code) => [
    { code, path: '$.data', message: `合成失败：${code}`, severity: 'error', retryable: true, line: original[index].line, opId: original[index].opId },
  ];
  const batch = buildRepairBatch(
    [
      { op: original[0], issues: issueFor(0, 'REF_UNKNOWN'), readSet: [{ table: 'locations', rowId: IDS.L2, rowRev: 1 }] },
      { op: original[1], issues: issueFor(1, 'REF_TYPE_MISMATCH') },
    ],
    { phase: 'repair', allowedOps },
  );
  return { original, tickets: batch.tickets, batch };
}

function repairOps(text) {
  return parseOperations(text, { phase: 'repair' }).operations;
}

/* ───────────────────────── 部分成功也会修失败组 ───────────────────────── */

test('T09-01 部分成功也修失败组：真实 rejected 组进修复批次，恰好一票且不含成功操作文本', async () => {
  const seed = await fresh();
  try {
    const response =
      '{"op":"character.upsert","ref":"C1","data":{"thought":"先观察。"}}\n' +
      '{"op":"plan.revise","ref":"A9","data":{"change":"cancel"}}';
    const parsed = parseOperations(response, { phase: 'decision' });
    assert.equal(parsed.operations.length, 2);
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
    const applied = applyGroups(seed.db, orderGroups(built.groups).order, {
      branchId: BRANCH,
      turnId: TURN_ID,
      attemptId: 'attempt_t09_partial',
    });

    // 真实的部分成功：一组落库，另一组 rejected。
    const byStatus = new Map(applied.groups.map((group) => [group.status, group]));
    assert.equal(byStatus.get('applied')?.changedRows, 1);
    assert.equal(countRows(seed.db, 'characters', BRANCH), 4);
    assert.equal(createTableReadPort(seed.db).selectOne('characters', BRANCH, IDS.C1).thought, '先观察。');

    const failedGroups = applied.groups.filter((group) => group.status === 'rejected' || group.status === 'blocked');
    assert.equal(failedGroups.length, 1, '只有失败组进入修复');
    const failedGroup = failedGroups[0];
    const fatal = failedGroup.issues.filter((issue) => issue.severity === 'error');
    assert.deepEqual(fatal.map((issue) => issue.code), ['REF_UNKNOWN']);
    assert.ok(fatal[0].opId, '失败组必须留下可定位的 opId');

    const failedOp = parsed.operations.find((op) => op.opId === fatal[0].opId);
    assert.ok(failedOp, '失败组必须能映射回原操作');
    const succeededOp = parsed.operations.find((op) => op.opId !== failedOp.opId);
    assert.equal(succeededOp.value.data.thought, '先观察。');

    const batch = buildRepairBatch([{ op: failedOp, issues: failedGroup.issues, readSet: [] }], {
      phase: 'repair',
      allowedOps: ['plan.revise'],
      failureGroupId: failedGroup.groupId,
    });

    // 恰好一张票据对应失败操作。
    assert.equal(batch.tickets.length, 1);
    assert.equal(batch.tickets[0].ticket, 'R1');
    assert.equal(batch.tickets[0].originalOpId, failedOp.opId);
    assert.deepEqual(batch.tickets[0].allowedOps, ['plan.revise']);
    assert.deepEqual(
      batch.tickets[0].issues.map((issue) => issue.code),
      ['REF_UNKNOWN'],
    );
    assert.deepEqual(batch.issues, []);

    // 提示词里只有失败操作：成功操作的正文、opId、原文都不能出现。
    const prompt = batch.promptLines.join('\n');
    assert.ok(prompt.includes('R1'));
    assert.ok(prompt.includes(failedOp.opId));
    assert.ok(prompt.includes('REF_UNKNOWN'));
    assert.ok(prompt.includes('A9'));
    assert.ok(!prompt.includes('先观察。'), '成功操作的正文不得进入修复提示词');
    assert.ok(!prompt.includes(succeededOp.opId), '成功操作的 opId 不得进入修复提示词');
    assert.ok(!prompt.includes(JSON.stringify(succeededOp.value)), '禁止重发成功操作');
  } finally {
    seed.close();
  }
});

/* ───────────────────────── 最多一次 ───────────────────────── */

test('T09-02 最多一次：attemptsUsed=1 时 REPAIR_ATTEMPTS_EXHAUSTED，操作原样返回', async () => {
  const seed = await fresh();
  try {
    const { original, tickets } = ticketFixture();
    const repaired = repairOps('{"ticket":"R1","op":"character.upsert","ref":"C1","data":{"location_ref":"L2"}}');
    assert.equal(repaired.length, 1);

    const merged = mergeRepair(original, repaired, tickets, { phase: 'repair', attemptsUsed: 1 });
    assert.equal(merged.issues.length, 1);
    assert.equal(merged.issues[0].code, 'REPAIR_ATTEMPTS_EXHAUSTED');
    assert.equal(merged.issues[0].severity, 'error');
    assert.equal(merged.issues[0].retryable, false);
    assert.deepEqual(merged.operations, original, '额度用尽必须原样返回原操作');
    assert.equal(merged.operations[0], original[0]);
    assert.equal(merged.operations[0].value.data.location_ref, 'new:missing', '没有被修复条目改写');
    assert.deepEqual(merged.consumedTickets, []);
    assert.equal(merged.exceededScope, false);

    // 额度是「每批一次」，不是每条坏行各自一次：attemptsUsed=0 时允许。
    const allowed = mergeRepair(original, repaired, tickets, { phase: 'repair', attemptsUsed: 0 });
    assert.deepEqual(allowed.issues, []);
    assert.deepEqual(allowed.consumedTickets, ['R1']);
    assert.equal(allowed.operations[0].value.data.location_ref, 'L2');
  } finally {
    seed.close();
  }
});

/* ───────────────────────── ticket 映射 / 成功 opId 不变 ───────────────────────── */

test('T09-03 ticket 映射：修复条目回到原 opId 与原行号，成功操作不被重新编号', async () => {
  const seed = await fresh();
  try {
    const { original, tickets } = ticketFixture();
    const repaired = repairOps(
      '{"ticket":"R1","op":"character.upsert","ref":"C1","data":{"location_ref":"L2"}}\n' +
        '{"ticket":"R2","op":"character.upsert","ref":"C2","data":{"thought":"改主意了。"}}',
    );
    assert.equal(repaired.length, 2);
    assert.notEqual(repaired[0].opId, original[0].opId, '修复响应里的行是新的解析结果');

    const merged = mergeRepair(original, repaired, tickets, { phase: 'repair' });
    assert.deepEqual(merged.issues, []);
    assert.deepEqual(merged.consumedTickets, ['R1', 'R2']);
    assert.equal(merged.exceededScope, false);
    assert.equal(merged.operations.length, original.length);

    for (const index of [0, 1]) {
      assert.equal(merged.operations[index].opId, original[index].opId, '必须保留原 opId');
      assert.equal(merged.operations[index].line, original[index].line, '必须保留原行号');
      assert.notEqual(merged.operations[index].opId, repaired[index].opId, '不得改用修复响应的新 opId');
      assert.equal(merged.operations[index].value.ticket, `R${index + 1}`, 'ticket 保留在操作值上供回执定位');
    }
    assert.equal(merged.operations[0].value.data.location_ref, 'L2');
    assert.equal(merged.operations[1].value.data.thought, '改主意了。');
  } finally {
    seed.close();
  }
});

/* ───────────────────────── 票据错误的具体报错 ───────────────────────── */

test('T09-04 未知票据：REPAIR_TICKET_UNKNOWN 点名票据并列出本批票据，合法条目仍生效', async () => {
  const seed = await fresh();
  try {
    const { original, tickets } = ticketFixture();
    const repaired = repairOps(
      '{"ticket":"R9","op":"character.upsert","ref":"C2","data":{"thought":"越权写入"}}\n' +
        '{"ticket":"R1","op":"character.upsert","ref":"C1","data":{"location_ref":"L2"}}',
    );

    const merged = mergeRepair(original, repaired, tickets, { phase: 'repair' });
    const unknown = merged.issues.filter((issue) => issue.code === 'REPAIR_TICKET_UNKNOWN');
    assert.equal(unknown.length, 1);
    assert.equal(unknown[0].severity, 'error');
    assert.equal(unknown[0].retryable, false);
    assert.equal(unknown[0].path, '$.ticket');
    assert.ok(unknown[0].message.includes('R9'), '必须点名未知票据');
    assert.ok(unknown[0].message.includes('R1'), '必须列出本批真实票据');
    assert.ok(unknown[0].message.includes('R2'));

    assert.deepEqual(merged.consumedTickets, ['R1']);
    assert.equal(merged.operations[0].value.data.location_ref, 'L2', '合法条目照常生效');
    assert.equal(merged.operations[1], original[1], '越权条目没有落到任何操作上');
    assert.equal(merged.operations[1].value.data.thought, '保持观察。');
  } finally {
    seed.close();
  }
});

test('T09-05 缺票据具体报错：点名「缺少 ticket」并列出本批票据与行号，不是泛泛一句错误', async () => {
  const seed = await fresh();
  try {
    const { original, tickets } = ticketFixture();
    const repaired = repairOps(
      '{"op":"character.upsert","ref":"C2","data":{"thought":"忘了带票据"}}\n' +
        '{"ticket":"R1","op":"character.upsert","ref":"C1","data":{"location_ref":"L2"}}',
    );

    const merged = mergeRepair(original, repaired, tickets, { phase: 'repair' });
    const missing = merged.issues.filter((issue) => issue.code === 'REPAIR_TICKET_UNKNOWN');
    assert.equal(missing.length, 1);
    const [issue] = missing;
    assert.equal(issue.severity, 'error');
    assert.equal(issue.retryable, false);
    assert.equal(issue.path, '$.ticket');
    assert.equal(issue.line, repaired[0].line, '必须能定位到具体行');
    assert.ok(issue.message.includes('缺少 ticket'), `必须说明缺的是什么：${issue.message}`);
    assert.ok(issue.message.includes(`第 ${repaired[0].line} 行`), `必须给出行号：${issue.message}`);
    assert.ok(issue.message.includes('R1') && issue.message.includes('R2'), `必须列出本批票据：${issue.message}`);
    assert.ok(issue.message.includes('拒绝'), '必须明确该条被拒绝');

    // 缺票据与未知票据是两种具体诊断，不是同一句泛泛报错。
    const unknownMerged = mergeRepair(
      original,
      repairOps('{"ticket":"R9","op":"character.upsert","ref":"C1","data":{"location_ref":"L2"}}'),
      tickets,
      { phase: 'repair' },
    );
    const unknownMessage = unknownMerged.issues.find((entry) => entry.code === 'REPAIR_TICKET_UNKNOWN').message;
    assert.ok(unknownMessage.includes('未知票据'));
    assert.notEqual(unknownMessage, issue.message);

    assert.deepEqual(merged.consumedTickets, ['R1'], '缺票据的条目没有消耗任何票据');
    assert.equal(merged.operations[0].value.data.location_ref, 'L2');
    assert.equal(merged.operations[1], original[1]);
  } finally {
    seed.close();
  }
});

/* ───────────────────────── 超范围修复拒绝 ───────────────────────── */

test('T09-06 超范围修复拒绝（非法 op）：REPAIR_SCOPE_VIOLATION 点名票据/非法 op/允许集合，同批合法条目仍生效', async () => {
  const seed = await fresh();
  try {
    const { original, tickets } = ticketFixture({ allowedOps: ['character.upsert'] });
    const repaired = repairOps(
      '{"ticket":"R1","op":"location.upsert","ref":"L2","data":{"name":"越权改名"}}\n' +
        '{"ticket":"R2","op":"character.upsert","ref":"C2","data":{"thought":"合法修复"}}',
    );

    const merged = mergeRepair(original, repaired, tickets, { phase: 'repair' });
    const violations = merged.issues.filter((issue) => issue.code === 'REPAIR_SCOPE_VIOLATION');
    assert.equal(violations.length, 1);
    assert.equal(violations[0].severity, 'error');
    assert.equal(violations[0].retryable, false);
    assert.equal(violations[0].path, '$.op');
    assert.ok(violations[0].message.includes('R1'), '必须点名票据');
    assert.ok(violations[0].message.includes('location.upsert'), '必须点名非法操作');
    assert.ok(violations[0].message.includes('character.upsert'), '必须列出该票据允许的集合');
    assert.equal(violations[0].opId, original[0].opId, '越权条目映射回原 opId 供回执定位');
    assert.equal(merged.exceededScope, true);

    // 局部失败不牵连：同批无关的合法条目照常生效，被拒条目没有消耗票据。
    assert.deepEqual(merged.consumedTickets, ['R2']);
    assert.equal(merged.operations[0], original[0], '越权条目不得改写原失败操作');
    assert.equal(merged.operations[0].value.data.location_ref, 'new:missing');
    assert.equal(merged.operations[1].value.data.thought, '合法修复');
    assert.equal(merged.operations[1].opId, original[1].opId);
  } finally {
    seed.close();
  }
});

test('T09-07 超范围修复拒绝（新增 new: 别名）：原依赖集合之外的别名被拒，同批合法条目仍生效', async () => {
  const seed = await fresh();
  try {
    const { original, tickets } = ticketFixture({ allowedOps: ['character.upsert'] });
    // 原操作的依赖集合只有 data 里引用过的 new:missing；new:helper 是凭空新增的辅助对象。
    assert.equal(original[0].value.data.location_ref, 'new:missing');

    const repaired = repairOps(
      '{"ticket":"R1","op":"character.upsert","ref":"new:helper","data":{"name":"帮手","identity":"临时"}}\n' +
        '{"ticket":"R2","op":"character.upsert","ref":"C2","data":{"thought":"合法修复"}}',
    );

    const merged = mergeRepair(original, repaired, tickets, { phase: 'repair' });
    const violations = merged.issues.filter((issue) => issue.code === 'REPAIR_SCOPE_VIOLATION');
    assert.equal(violations.length, 1);
    assert.equal(violations[0].severity, 'error');
    assert.equal(violations[0].path, '$.ref');
    assert.ok(violations[0].message.includes('R1'));
    assert.ok(violations[0].message.includes('new:helper'), '必须点名非法新增的别名');
    assert.ok(violations[0].message.includes('new:missing'), '必须给出该票据原本允许的依赖集合');
    assert.equal(merged.exceededScope, true);
    assert.deepEqual(merged.consumedTickets, ['R2']);
    assert.equal(merged.operations[0], original[0]);
    assert.equal(merged.operations[1].value.data.thought, '合法修复');

    // 对照：沿用原操作已经引用过的 new: 别名不算越权。
    const reused = mergeRepair(
      original,
      repairOps('{"ticket":"R1","op":"character.upsert","ref":"C1","data":{"location_ref":"new:missing"}}'),
      tickets,
      { phase: 'repair' },
    );
    assert.deepEqual(reused.issues, []);
    assert.equal(reused.exceededScope, false);
    assert.deepEqual(reused.consumedTickets, ['R1']);
    assert.equal(reused.operations[0].opId, original[0].opId);
  } finally {
    seed.close();
  }
});

test('T09-08 重复修复同一票据：REPAIR_DUPLICATE_TICKET，第二份不重复应用', async () => {
  const seed = await fresh();
  try {
    const { original, tickets } = ticketFixture();
    const repaired = repairOps(
      '{"ticket":"R1","op":"character.upsert","ref":"C1","data":{"location_ref":"L2"}}\n' +
        '{"ticket":"R1","op":"character.upsert","ref":"C1","data":{"location_ref":"L3"}}',
    );

    const merged = mergeRepair(original, repaired, tickets, { phase: 'repair' });
    const duplicates = merged.issues.filter((issue) => issue.code === 'REPAIR_DUPLICATE_TICKET');
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0].severity, 'error');
    assert.equal(duplicates[0].retryable, false);
    assert.ok(duplicates[0].message.includes('R1'));
    assert.equal(duplicates[0].opId, original[0].opId, '重复条目映射回同一个原 opId');
    assert.equal(duplicates[0].line, repaired[1].line);

    assert.deepEqual(merged.consumedTickets, ['R1'], '票据只被消费一次');
    assert.equal(merged.operations[0].value.data.location_ref, 'L2', '只有第一份生效，不重复应用');
    assert.equal(merged.operations[0].opId, original[0].opId);
    assert.equal(merged.operations[0].line, original[0].line);
    assert.equal(merged.operations[1], original[1]);
    assert.equal(merged.exceededScope, false);
  } finally {
    seed.close();
  }
});
