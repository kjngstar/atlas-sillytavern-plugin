/**
 * atlas-ops-refs.test.mjs — T05（§18.3）+ 少量 T09 断言。
 *
 * 覆盖：
 * - P02 前向引用（§18.2）：人物行引用本轮后面才建立的地点，第一遍登记必须先生效；
 * - P05（§18.2）：`data` 里的 `new:` 是引用而不是声明 → REF_UNKNOWN，且不牵连独立操作；
 * - P12（§18.2）：`source:"W1"` 绑定世界书来源，无 quote 不返回 QUOTE_REQUIRED；
 * - 重名/歧义（§8.4、§16.5 步骤 2/3）、类型不符、别名精确匹配（§8.4）；
 * - 依据绑定（C07/§2.3、§16.6）与定向修复票据（C08/C09、§16.5 步骤 6/7）。
 *
 * 本文件只调用纯函数层（refs/sources/repair），不打开数据库。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS } from './fixtures/atlas-sql/seed.mjs';
import { caseById, SOURCE_SNAPSHOT } from './fixtures/atlas-sql/model-cases.mjs';
import { extractPayload, parseOperations } from '../src/atlas-ops-parser.ts';
import {
  createRefScope,
  declareRefs,
  resolveRef,
  resolveByDisplayName,
  refKindPrefix,
} from '../src/atlas-ops-refs.ts';
import { bindSources, emptyBasis } from '../src/atlas-ops-sources.ts';
import { buildRepairBatch, mergeRepair } from '../src/atlas-ops-repair.ts';

const SQL = await (await import('sql.js')).default();

/** §16.5 步骤 2 的锚点：同 chatUid/branch/variant/opId ⇒ 同确定性 ID。 */
const ANCHOR = {
  chatUid: 'chat-A',
  branchId: 'main-A',
  parentTurnId: 'turn_seed_A',
  hostMessageUid: 'msg-1',
  variantKey: 'v1',
  baseRevision: 0,
  baseStorageRevision: 0,
  inputHash: 'hash_input',
};

async function fresh() {
  return makeSeedWith(SQL);
}

/** 把模型原始文本走一遍 extractPayload → parseOperations（§8.3 规范路径）。 */
function opsOf(responseText) {
  const extracted = extractPayload(responseText);
  return { extracted, parsed: parseOperations(extracted.payload, { phase: 'observe' }) };
}

/** 声明结果全部登记进 scope，模拟 §16.5 步骤 3 的第二遍。 */
function scopeWith(seed, declared) {
  const scope = createRefScope(seed.refs);
  for (const entry of declared.declared) scope.declare(entry);
  return scope;
}

function refEntry(alias, id, kind) {
  return { alias, id, kind, rowRev: null, declaredByOpId: null };
}

function p05FailedIssues(seed, parsed) {
  const declared = declareRefs(parsed.operations, { anchor: ANCHOR, baseRevision: 0, seed: seed.refs });
  const scope = scopeWith(seed, declared);
  const first = parsed.operations[0];
  const unknown = resolveRef('new:missing', 'location', scope, {
    opId: first.opId,
    line: first.line,
    field: 'location_ref',
  });
  const mismatch = resolveRef('C1', 'location', scope, {
    opId: first.opId,
    line: first.line,
    field: 'location_ref',
  });
  return { declared, scope, issues: [unknown.issues[0], mismatch.issues[0]] };
}

/* ───────────────────────────── T05 ───────────────────────────── */

test('T05-01 P02 前向引用：第一条操作引用本轮后面才声明的学校', async () => {
  const seed = await fresh();
  try {
    const response = caseById('P02').response;
    const lines = response.split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes('"ref":"new:elin"'));
    assert.ok(lines[0].includes('"location_ref":"new:school"'));
    assert.ok(lines[1].includes('"ref":"new:school"'));

    const { parsed } = opsOf(response);
    assert.equal(parsed.operations.length, 2);
    assert.deepEqual(parsed.operations.map((op) => op.line), [1, 2]);
    assert.equal(parsed.operations[0].value.ref, 'new:elin');
    assert.equal(parsed.operations[1].value.ref, 'new:school');

    const declared = declareRefs(parsed.operations, { anchor: ANCHOR, baseRevision: 0, seed: seed.refs });
    assert.deepEqual(declared.issues, []);
    assert.deepEqual(declared.declared.map((entry) => entry.alias).sort(), ['elin', 'school']);

    const elin = declared.declared.find((entry) => entry.alias === 'elin');
    const school = declared.declared.find((entry) => entry.alias === 'school');
    assert.equal(elin.kind, 'character');
    assert.equal(school.kind, 'location');
    assert.notEqual(elin.id, school.id);
    assert.match(elin.id, /^[a-z]{3}_[0-9a-f]{24}$/);
    assert.match(school.id, /^[a-z]{3}_[0-9a-f]{24}$/);
    assert.equal(elin.id.slice(0, 4), `${refKindPrefix('character')}_`);
    assert.equal(school.id.slice(0, 4), `${refKindPrefix('location')}_`);
    // 学校由第 2 行声明，但第一遍已经登记，所以第 1 行可以前向引用。
    assert.equal(school.declaredByOpId, parsed.operations[1].opId);

    const scope = scopeWith(seed, declared);
    const resolved = resolveRef(parsed.operations[0].value.data.location_ref, 'location', scope, {
      opId: parsed.operations[0].opId,
      field: 'location_ref',
    });
    assert.deepEqual(resolved.issues, []);
    assert.equal(resolved.entry.id, school.id);
    assert.equal(declared.aliasById.get('school'), school.id);
  } finally {
    seed.close();
  }
});

test('T05-02 确定性 ID：同 anchor 复现同一映射，换 variantKey 则换 ID', async () => {
  const seed = await fresh();
  try {
    const { parsed } = opsOf(caseById('P02').response);
    const first = declareRefs(parsed.operations, { anchor: ANCHOR, baseRevision: 0, seed: seed.refs });
    const again = declareRefs(parsed.operations, { anchor: { ...ANCHOR }, baseRevision: 0, seed: seed.refs });
    assert.deepEqual([...first.aliasById.entries()], [...again.aliasById.entries()]);
    assert.deepEqual(first.declared, again.declared);

    const otherVariant = declareRefs(parsed.operations, {
      anchor: { ...ANCHOR, variantKey: 'v2' },
      baseRevision: 0,
      seed: seed.refs,
    });
    assert.notEqual(otherVariant.aliasById.get('elin'), first.aliasById.get('elin'));
    assert.notEqual(otherVariant.aliasById.get('school'), first.aliasById.get('school'));
    // 前缀仍由类型决定，只有哈希段变化。
    assert.match(otherVariant.aliasById.get('elin'), /^chr_[0-9a-f]{24}$/);
    assert.match(otherVariant.aliasById.get('school'), /^loc_[0-9a-f]{24}$/);

    // ID 由 chatUid/branch/variant/opId 哈希决定：换聊天或换分支都不会撞 ID（跨聊天隔离）。
    const otherChat = declareRefs(parsed.operations, {
      anchor: { ...ANCHOR, chatUid: 'chat-B' },
      baseRevision: 0,
      seed: seed.refs,
    });
    assert.notEqual(otherChat.aliasById.get('elin'), first.aliasById.get('elin'));
    assert.notEqual(otherChat.aliasById.get('school'), first.aliasById.get('school'));

    const otherBranch = declareRefs(parsed.operations, {
      anchor: { ...ANCHOR, branchId: 'main-B' },
      baseRevision: 0,
      seed: seed.refs,
    });
    assert.notEqual(otherBranch.aliasById.get('school'), first.aliasById.get('school'));

    // baseRevision 不进哈希：同基点重算不会换 ID（修复保持原 opId 即保持同一 ID）。
    const otherRevision = declareRefs(parsed.operations, { anchor: ANCHOR, baseRevision: 7, seed: seed.refs });
    assert.deepEqual([...otherRevision.aliasById.entries()], [...first.aliasById.entries()]);
  } finally {
    seed.close();
  }
});

test('T05-03 P05：new:missing 报 REF_UNKNOWN，独立引用 C1 仍可解析', async () => {
  const seed = await fresh();
  try {
    const { parsed } = opsOf(caseById('P05').response);
    assert.equal(parsed.operations.length, 2);

    const declared = declareRefs(parsed.operations, { anchor: ANCHOR, baseRevision: 0, seed: seed.refs });
    assert.deepEqual(declared.issues, []);
    const scope = scopeWith(seed, declared);

    const first = parsed.operations[0];
    assert.equal(first.value.data.location_ref, 'new:missing');
    const missing = resolveRef(first.value.data.location_ref, 'location', scope, {
      opId: first.opId,
      line: first.line,
      field: 'location_ref',
    });
    assert.equal(missing.entry, null);
    assert.equal(missing.issues.length, 1);
    const [issue] = missing.issues;
    assert.equal(issue.code, 'REF_UNKNOWN');
    assert.equal(issue.path, '$.data.location_ref');
    assert.ok(issue.message.includes('new:missing'));
    assert.equal(issue.retryable, true);
    assert.equal(issue.severity, 'error');
    assert.equal(issue.opId, first.opId);
    assert.equal(issue.line, first.line);

    // 第二行是完全独立的更新，不受第一条坏引用牵连。
    const second = parsed.operations[1];
    assert.equal(second.value.ref, 'C2');
    const independent = resolveRef(second.value.ref, 'character', scope, {
      opId: second.opId,
      line: second.line,
      field: 'ref',
    });
    assert.deepEqual(independent.issues, []);
    assert.equal(independent.entry.id, IDS.C2);
    assert.equal(independent.entry.kind, 'character');

    // C1 能解析正是因为它在 createRefScope 的 seed 里（短引用由程序提供）。
    const withC1 = resolveRef('C1', 'character', scope);
    assert.deepEqual(withC1.issues, []);
    assert.equal(withC1.entry.id, IDS.C1);
    const withoutSeed = resolveRef('C1', 'character', createRefScope([]));
    assert.equal(withoutSeed.entry, null);
    assert.equal(withoutSeed.issues[0].code, 'REF_UNKNOWN');
  } finally {
    seed.close();
  }
});

test('T05-04 类型不符：REF_TYPE_MISMATCH 同时指出实际类型与期望类型', async () => {
  const seed = await fresh();
  try {
    const scope = createRefScope(seed.refs);
    const resolved = resolveRef('C1', 'location', scope, { field: 'location_ref' });
    assert.equal(resolved.entry, null);
    assert.equal(resolved.issues.length, 1);
    const [issue] = resolved.issues;
    assert.equal(issue.code, 'REF_TYPE_MISMATCH');
    assert.equal(issue.path, '$.data.location_ref');
    assert.equal(issue.severity, 'error');
    assert.equal(issue.retryable, true);
    assert.match(issue.message, /「C1」/);
    assert.match(issue.message, /指向 character/);
    assert.match(issue.message, /需要 location/);

    // 地点引用反过来当人物用同样被拒。
    const opposite = resolveRef('L2', 'character', scope, { field: 'actor_ref' });
    assert.equal(opposite.entry, null);
    assert.equal(opposite.issues[0].code, 'REF_TYPE_MISMATCH');
    assert.match(opposite.issues[0].message, /指向 location/);
    assert.match(opposite.issues[0].message, /需要 character/);

    // 期望多种类型时按集合判定，不误报。
    const union = resolveRef('I1', ['item', 'location'], scope);
    assert.deepEqual(union.issues, []);
    assert.equal(union.entry.id, IDS.I1);
  } finally {
    seed.close();
  }
});

test('T05-05 别名歧义：两个 ID 共享别名时 REF_AMBIGUOUS，绝不随机挑一个', async () => {
  const seed = await fresh();
  try {
    const leftId = 'loc_aaaaaaaaaaaaaaaaaaaaaaaa';
    const rightId = 'loc_bbbbbbbbbbbbbbbbbbbbbbbb';
    const scope = createRefScope([
      ...seed.refs,
      refEntry('X', leftId, 'location'),
      refEntry('X', rightId, 'location'),
    ]);
    // 歧义别名不允许 get 直接返回其中一个。
    assert.equal(scope.get('X'), null);
    assert.equal(scope.all().filter((entry) => entry.alias === 'X').length, 2);

    const resolved = resolveRef('X', null, scope);
    assert.equal(resolved.entry, null);
    assert.equal(resolved.issues.length, 1);
    assert.equal(resolved.issues[0].code, 'REF_AMBIGUOUS');
    assert.ok(resolved.issues[0].message.includes(leftId));
    assert.ok(resolved.issues[0].message.includes(rightId));
    assert.equal(resolved.issues[0].retryable, true);

    // 明确写出稳定 ID 时不歧义。
    const byId = resolveRef(leftId, 'location', scope);
    assert.deepEqual(byId.issues, []);
    assert.equal(byId.entry.id, leftId);
  } finally {
    seed.close();
  }
});

test('T05-06 同批重复声明 new: 别名：REF_AMBIGUOUS 并点名两个 opId', async () => {
  const seed = await fresh();
  try {
    const response =
      '{"op":"location.upsert","ref":"new:x","data":{"name":"甲"}}\n' +
      '{"op":"location.upsert","ref":"new:x","data":{"name":"乙"}}';
    const { parsed } = opsOf(response);
    assert.equal(parsed.operations.length, 2);

    const declared = declareRefs(parsed.operations, { anchor: ANCHOR, baseRevision: 0, seed: seed.refs });
    assert.equal(declared.issues.length, 1);
    const [issue] = declared.issues;
    assert.equal(issue.code, 'REF_AMBIGUOUS');
    assert.equal(issue.path, '$.ref');
    assert.equal(issue.severity, 'error');
    assert.ok(issue.message.includes(parsed.operations[0].opId));
    assert.ok(issue.message.includes(parsed.operations[1].opId));
    assert.equal(issue.line, 2);
    assert.equal(issue.opId, parsed.operations[1].opId);
    // 不静默登记两份冲突声明。
    assert.equal(declared.declared.filter((entry) => entry.alias === 'x').length, 1);
  } finally {
    seed.close();
  }
});

test('T05-07 resolveByDisplayName 只做别名精确匹配（大小写/全角归一）', async () => {
  const seed = await fresh();
  try {
    const scope = createRefScope([...seed.refs, refEntry('Elin', 'chr_elin000000000000000000', 'character')]);

    const exact = resolveByDisplayName('Elin', 'character', scope);
    assert.equal(exact.entry.id, 'chr_elin000000000000000000');
    const warning = exact.issues.find((issue) => issue.code === 'REF_RESOLVED_BY_ALIAS');
    assert.ok(warning, '按别名精确匹配必须留下诊断');
    assert.equal(warning.severity, 'warning');

    const lower = resolveByDisplayName('elin', 'character', scope);
    assert.equal(lower.entry.id, 'chr_elin000000000000000000');

    const upper = resolveByDisplayName('ELIN', 'character', scope);
    assert.equal(upper.entry.id, 'chr_elin000000000000000000');

    // 全角拉丁字母经 NFKC 归一后仍算精确匹配。
    const fullWidth = resolveByDisplayName('ｅｌｉｎ', 'character', scope);
    assert.equal(fullWidth.entry.id, 'chr_elin000000000000000000');

    // 期望类型不符仍然拒绝。
    const wrongKind = resolveByDisplayName('Elin', 'location', scope);
    assert.equal(wrongKind.entry, null);
    assert.equal(wrongKind.issues[0].code, 'REF_TYPE_MISMATCH');
  } finally {
    seed.close();
  }
});

test('T05-08 resolveByDisplayName 对仅相似的名字返回 REF_UNKNOWN', async () => {
  const seed = await fresh();
  try {
    const scope = createRefScope([...seed.refs, refEntry('圣罗兰', IDS.L1, 'location')]);

    const exact = resolveByDisplayName('圣罗兰', 'location', scope);
    assert.equal(exact.entry.id, IDS.L1);

    const similar = resolveByDisplayName('圣罗兰城', 'location', scope);
    assert.equal(similar.entry, null);
    assert.equal(similar.issues.length, 1);
    assert.equal(similar.issues[0].code, 'REF_UNKNOWN');
    assert.match(similar.issues[0].message, /圣罗兰城/);
    assert.equal(similar.issues[0].retryable, true);

    const empty = resolveByDisplayName('   ', 'location', scope);
    assert.equal(empty.entry, null);
    assert.equal(empty.issues[0].code, 'REF_UNKNOWN');
  } finally {
    seed.close();
  }
});

test('T05-09 resolveByDisplayName 对两个匹配返回 REF_AMBIGUOUS', async () => {
  const seed = await fresh();
  try {
    const scope = createRefScope([
      ...seed.refs,
      refEntry('X', 'loc_cccccccccccccccccccccccc', 'location'),
      refEntry('x', 'loc_dddddddddddddddddddddddd', 'location'),
    ]);
    const resolved = resolveByDisplayName('X', 'location', scope);
    assert.equal(resolved.entry, null);
    assert.equal(resolved.issues.length, 1);
    assert.equal(resolved.issues[0].code, 'REF_AMBIGUOUS');
    assert.ok(resolved.issues[0].message.includes('loc_cccccccccccccccccccccccc'));
    assert.ok(resolved.issues[0].message.includes('loc_dddddddddddddddddddddddd'));
  } finally {
    seed.close();
  }
});

test('T05-10 P12：source:"W1" 绑定世界书快照，不要求逐字引文', async () => {
  const seed = await fresh();
  try {
    const { parsed } = opsOf(caseById('P12').response);
    assert.equal(parsed.operations.length, 1);
    const op = parsed.operations[0].value;
    assert.equal(op.source, 'W1');
    assert.equal(op.ref, 'new:captain');
    assert.equal(op.data.importance, 'core');

    const { basis, issues } = bindSources(op, { phase: 'observe', snapshot: SOURCE_SNAPSHOT, clockS: 0 });
    assert.deepEqual(issues, []);
    assert.equal(basis.sources.length, 1);
    assert.equal(basis.sources[0].source_key, 'W1');
    assert.equal(basis.sources[0].content_hash, 'hash_W1');
    assert.equal(basis.kind, 'lorebook');
    assert.equal(basis.verification, 'source_bound');
    assert.deepEqual(basis.sources[0].spans, []);
    const json = JSON.stringify(basis);
    assert.ok(!json.includes('QUOTE_REQUIRED'));
    assert.ok(!json.includes('QUOTE_NOT_FOUND'));
  } finally {
    seed.close();
  }
});

test('T05-11 bindSources：不存在的 source 报 SOURCE_UNKNOWN 并列出可用键', async () => {
  const seed = await fresh();
  try {
    const { basis, issues } = bindSources(
      { op: 'character.upsert', ref: 'new:ghost', data: { name: '幽灵' }, source: 'W9' },
      { phase: 'observe', snapshot: SOURCE_SNAPSHOT, clockS: 0 },
    );
    assert.equal(issues.length, 1);
    const [issue] = issues;
    assert.equal(issue.code, 'SOURCE_UNKNOWN');
    assert.equal(issue.path, '$.source');
    assert.equal(issue.severity, 'error');
    assert.equal(issue.retryable, true);
    assert.ok(issue.message.includes('W9'));
    assert.ok(issue.message.includes('W1'));
    assert.ok(issue.message.includes('S1'));
    // 找不到来源不伪造引文。
    assert.deepEqual(basis.sources, []);
    assert.equal(basis.verification, 'unverified');
  } finally {
    seed.close();
  }
});

test('T05-12 decision 阶段省略 source：按后台因果记 causal，无引文门槛', async () => {
  const seed = await fresh();
  try {
    const { basis, issues } = bindSources(
      { op: 'character.upsert', ref: 'C1', data: { thought: '先确认来访者的身份。' } },
      { phase: 'decision', snapshot: SOURCE_SNAPSHOT, clockS: 0 },
    );
    assert.deepEqual(issues, []);
    assert.equal(basis.verification, 'causal');
    assert.equal(basis.kind, 'simulation');
    assert.deepEqual(basis.sources, []);
    assert.equal(basis.certainty, 'inferred');
    const json = JSON.stringify(basis);
    assert.ok(!json.includes('QUOTE_REQUIRED'));
    assert.ok(!json.includes('QUOTE_NOT_FOUND'));

    // 对照：真正没有依据时要显式 unverified，而不是伪装成 causal/confirmed。
    const blank = emptyBasis('simulation', '没有任何可用依据');
    assert.equal(blank.verification, 'unverified');
    assert.deepEqual(blank.sources, []);
  } finally {
    seed.close();
  }
});

test('T05-13 bindSources：命中引文给 explicit_span 与真实 [start,end)', async () => {
  const seed = await fresh();
  try {
    const excerpt = '王宫卫队长伊娜';
    const sourceText = SOURCE_SNAPSHOT[0].text;
    assert.ok(sourceText.includes(excerpt));

    const { basis, issues } = bindSources(
      { op: 'character.upsert', ref: 'new:captain', data: { name: '伊娜', excerpt }, source: 'W1' },
      { phase: 'observe', snapshot: SOURCE_SNAPSHOT, clockS: 0 },
    );
    assert.deepEqual(issues, []);
    assert.equal(basis.verification, 'explicit_span');
    assert.equal(basis.sources.length, 1);
    const [bound] = basis.sources;
    assert.equal(bound.spans.length, 1);
    const [span] = bound.spans;
    assert.ok(Number.isInteger(span.start));
    assert.ok(Number.isInteger(span.end));
    assert.ok(span.end > span.start);
    assert.equal(sourceText.slice(span.start, span.end), excerpt);
    assert.equal(bound.excerpt, excerpt);
  } finally {
    seed.close();
  }
});

test('T05-14 bindSources：找不到引文时降级 source_bound，不编造 span', async () => {
  const seed = await fresh();
  try {
    const excerpt = '这句话并不存在于世界书条目里';
    const { basis, issues } = bindSources(
      { op: 'character.upsert', ref: 'new:captain', data: { quote: excerpt }, source: 'W1' },
      { phase: 'observe', snapshot: SOURCE_SNAPSHOT, clockS: 0 },
    );

    const warning = issues.find((issue) => issue.code === 'SOURCE_EXCERPT_NOT_FOUND');
    assert.ok(warning, '找不到引文必须留 warning');
    assert.equal(warning.severity, 'warning');
    assert.equal(warning.retryable, false);

    assert.equal(basis.verification, 'source_bound');
    assert.equal(basis.sources.length, 1);
    assert.equal(basis.sources[0].source_key, 'W1');
    assert.deepEqual(basis.sources[0].spans, []);
    assert.equal(basis.sources[0].excerpt, undefined);
  } finally {
    seed.close();
  }
});

/* ───────────────────────── T09（本文件内的少量断言） ───────────────────────── */

test('T09-01 buildRepairBatch：一个失败操作两个错误 → 恰好一张票据 R1', async () => {
  const seed = await fresh();
  try {
    const { parsed } = opsOf(caseById('P05').response);
    const { issues } = p05FailedIssues(seed, parsed);
    assert.deepEqual(issues.map((issue) => issue.code), ['REF_UNKNOWN', 'REF_TYPE_MISMATCH']);

    const failedOp = parsed.operations[0];
    const batch = buildRepairBatch(
      [{ op: failedOp, issues, readSet: [{ table: 'locations', rowId: IDS.L2, rowRev: 1 }] }],
      { phase: 'repair', allowedOps: ['character.upsert'], failureGroupId: 'grp_failed' },
    );

    assert.equal(batch.tickets.length, 1);
    assert.equal(batch.tickets[0].ticket, 'R1');
    assert.equal(batch.tickets[0].originalOpId, failedOp.opId);
    assert.deepEqual(batch.tickets[0].allowedOps, ['character.upsert']);
    assert.deepEqual(
      batch.tickets[0].issues.map((issue) => issue.code),
      ['REF_UNKNOWN', 'REF_TYPE_MISMATCH'],
    );
    assert.deepEqual(batch.tickets[0].originalReadSet, [{ table: 'locations', rowId: IDS.L2, rowRev: 1 }]);

    const prompt = batch.promptLines.join('\n');
    assert.ok(prompt.includes('R1'));
    assert.ok(prompt.includes('REF_UNKNOWN'));
    assert.ok(prompt.includes('REF_TYPE_MISMATCH'));
    assert.ok(prompt.includes(failedOp.opId));
    assert.ok(prompt.includes('new:missing'));

    // 成功操作不在修复输入里：它的正文与 opId 都不能出现在提示词中。
    const succeeded = parsed.operations[1];
    assert.equal(succeeded.value.data.thought, '按原路继续。');
    assert.ok(!prompt.includes('按原路继续。'));
    assert.ok(!prompt.includes(succeeded.opId));
    assert.ok(!prompt.includes(JSON.stringify(succeeded.value)));
  } finally {
    seed.close();
  }
});

test('T09-02 mergeRepair：票据条目映射回原 opId 与原行号', async () => {
  const seed = await fresh();
  try {
    const { parsed } = opsOf(caseById('P05').response);
    const { issues } = p05FailedIssues(seed, parsed);
    const original = parsed.operations;
    const tickets = buildRepairBatch([{ op: original[0], issues }], {
      phase: 'repair',
      allowedOps: ['character.upsert'],
    }).tickets;

    const repaired = parseOperations(
      '{"ticket":"R1","op":"character.upsert","ref":"C1","data":{"location_ref":"L2"}}',
      { phase: 'repair' },
    ).operations;
    assert.equal(repaired.length, 1);

    const merged = mergeRepair(original, repaired, tickets, { phase: 'repair' });
    assert.deepEqual(merged.issues, []);
    assert.deepEqual(merged.consumedTickets, ['R1']);
    assert.equal(merged.exceededScope, false);
    assert.equal(merged.operations.length, original.length);

    assert.equal(merged.operations[0].opId, original[0].opId);
    assert.equal(merged.operations[0].line, original[0].line);
    assert.equal(merged.operations[0].value.ref, 'C1');
    assert.equal(merged.operations[0].value.data.location_ref, 'L2');
    // 未修复的操作原样保留，成功操作不会被重新编号。
    assert.equal(merged.operations[1], original[1]);
  } finally {
    seed.close();
  }
});

test('T09-03 mergeRepair：未知票据 R9 被拒，同批合法条目仍生效', async () => {
  const seed = await fresh();
  try {
    const { parsed } = opsOf(caseById('P05').response);
    const { issues } = p05FailedIssues(seed, parsed);
    const original = parsed.operations;
    const tickets = buildRepairBatch([{ op: original[0], issues }], {
      phase: 'repair',
      allowedOps: ['character.upsert'],
    }).tickets;

    const repaired = parseOperations(
      '{"ticket":"R9","op":"character.upsert","ref":"C2","data":{"thought":"越权写入"}}\n' +
        '{"ticket":"R1","op":"character.upsert","ref":"C1","data":{"location_ref":"L2"}}',
      { phase: 'repair' },
    ).operations;
    assert.equal(repaired.length, 2);

    const merged = mergeRepair(original, repaired, tickets, { phase: 'repair' });
    const unknown = merged.issues.filter((issue) => issue.code === 'REPAIR_TICKET_UNKNOWN');
    assert.equal(unknown.length, 1);
    assert.equal(unknown[0].severity, 'error');
    assert.ok(unknown[0].message.includes('R9'));
    assert.ok(unknown[0].message.includes('R1'));

    assert.deepEqual(merged.consumedTickets, ['R1']);
    assert.equal(merged.operations[0].value.data.location_ref, 'L2');
    // 越权条目没有落到任何操作上：C2 仍是原来的心理描述。
    assert.equal(merged.operations[1].value.data.thought, '按原路继续。');
  } finally {
    seed.close();
  }
});

test('T09-04 mergeRepair：超出票据允许操作 → REPAIR_SCOPE_VIOLATION，合法条目仍保留', async () => {
  const seed = await fresh();
  try {
    const { parsed } = opsOf(caseById('P05').response);
    const { issues } = p05FailedIssues(seed, parsed);
    const original = parsed.operations;
    const tickets = buildRepairBatch([{ op: original[0], issues }], {
      phase: 'repair',
      allowedOps: ['character.upsert'],
    }).tickets;

    const repaired = parseOperations(
      '{"ticket":"R1","op":"location.upsert","ref":"L2","data":{"name":"不该出现的改名"}}\n' +
        '{"ticket":"R1","op":"character.upsert","ref":"C1","data":{"location_ref":"L2"}}',
      { phase: 'repair' },
    ).operations;

    const merged = mergeRepair(original, repaired, tickets, { phase: 'repair' });
    const violations = merged.issues.filter((issue) => issue.code === 'REPAIR_SCOPE_VIOLATION');
    assert.equal(violations.length, 1);
    assert.equal(violations[0].severity, 'error');
    assert.ok(violations[0].message.includes('R1'));
    assert.ok(violations[0].message.includes('character.upsert'));
    assert.equal(merged.exceededScope, true);

    // 被拒条目没有消耗票据，同批合法条目照常生效。
    assert.deepEqual(merged.consumedTickets, ['R1']);
    assert.equal(merged.operations[0].value.data.location_ref, 'L2');
    assert.equal(merged.operations[1].value.data.thought, '按原路继续。');
  } finally {
    seed.close();
  }
});

test('T09-05 mergeRepair：本批额度用尽 → REPAIR_ATTEMPTS_EXHAUSTED 且原样返回', async () => {
  const seed = await fresh();
  try {
    const { parsed } = opsOf(caseById('P05').response);
    const { issues } = p05FailedIssues(seed, parsed);
    const original = parsed.operations;
    const tickets = buildRepairBatch([{ op: original[0], issues }], {
      phase: 'repair',
      allowedOps: ['character.upsert'],
    }).tickets;

    const repaired = parseOperations(
      '{"ticket":"R1","op":"character.upsert","ref":"C1","data":{"location_ref":"L2"}}',
      { phase: 'repair' },
    ).operations;

    const merged = mergeRepair(original, repaired, tickets, { phase: 'repair', attemptsUsed: 1 });
    assert.equal(merged.issues.length, 1);
    assert.equal(merged.issues[0].code, 'REPAIR_ATTEMPTS_EXHAUSTED');
    assert.equal(merged.issues[0].severity, 'error');
    assert.equal(merged.issues[0].retryable, false);
    assert.deepEqual(merged.operations, original);
    assert.equal(merged.operations[0].value.data.location_ref, 'new:missing');
    assert.deepEqual(merged.consumedTickets, []);
    assert.equal(merged.exceededScope, false);
  } finally {
    seed.close();
  }
});

test('T09-06 mergeRepair：同票据 noop → REPAIR_DECLINED 警告，原失败操作仍未解决', async () => {
  const seed = await fresh();
  try {
    const { parsed } = opsOf(caseById('P05').response);
    const { issues } = p05FailedIssues(seed, parsed);
    const original = parsed.operations;
    const tickets = buildRepairBatch([{ op: original[0], issues }], {
      phase: 'repair',
      allowedOps: ['character.upsert'],
    }).tickets;

    // 裸 noop 会被 parser 记为 explicitNoop 而不下发 operations（§8.3）；
    // repair 层按 §19.6 仍需处理「同 ticket 的 noop」，因此这里按 mergeRepair 的入参形态构造。
    const noopParsed = parseOperations('{"op":"noop","ticket":"R1"}', { phase: 'repair' });
    assert.equal(noopParsed.explicitNoop, true);
    assert.deepEqual(noopParsed.operations, []);

    const noopEntry = {
      opId: 'op_repair_noop',
      line: 1,
      rawHash: 'hash_repair_noop',
      value: { op: 'noop', ticket: 'R1', why: '当前上下文没有可用的地点引用' },
    };
    const merged = mergeRepair(original, [noopEntry], tickets, { phase: 'repair' });

    const declined = merged.issues.find((issue) => issue.code === 'REPAIR_DECLINED');
    assert.ok(declined, '同票据 noop 必须留 REPAIR_DECLINED');
    assert.equal(declined.severity, 'warning');
    assert.equal(declined.retryable, false);
    assert.ok(declined.message.includes('R1'));
    assert.deepEqual(merged.consumedTickets, ['R1']);
    assert.equal(merged.operations[0].value.data.location_ref, 'new:missing');
    assert.equal(merged.operations[0].opId, original[0].opId);
    assert.equal(merged.operations[0].line, original[0].line);
  } finally {
    seed.close();
  }
});
