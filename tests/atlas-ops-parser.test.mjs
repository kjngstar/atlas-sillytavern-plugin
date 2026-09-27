/**
 * atlas-ops-parser.test.mjs — T04 解析/规范化断言（§18.3 T04、§18.2 P01/P03/P07–P11）。
 *
 * 覆盖：§18.2 样例原样解析；空回复与 noop 可区分；代码围栏；未闭合思考段不抽取；
 * 超限不静默截断；损坏数组不提取内部 data 对象；自由文本逐字节保留；别名/未知字段/系统字段处理；
 * 统一 Issue 与密钥脱敏。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { caseById } from './fixtures/atlas-sql/model-cases.mjs';
import { extractPayload, parseOperations, looksLikeSql } from '../src/atlas-ops-parser.ts';
import { normalizeOperation, validateMinimum } from '../src/atlas-ops-normalize.ts';
import { ATLAS_ERROR_CODES, toIssue, redactSecrets, AtlasIssueError } from '../src/atlas-ops-errors.ts';

const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function parsedLines(result) {
  return result.operations.map((o) => o.value);
}

test('T04-01 P01 原文 → 1 条操作，opId 稳定、line=1、full sha256、无 issue', () => {
  const response = caseById('P01').response;
  const first = parseOperations(response, { phase: 'observe' });
  const second = parseOperations(response, { phase: 'observe' });
  assert.equal(first.operations.length, 1);
  assert.equal(first.operations[0].opId, second.operations[0].opId);
  assert.equal(first.operations[0].line, 1);
  assert.equal(first.operations[0].rawHash, sha256Hex(response.trim()));
  assert.match(first.operations[0].rawHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.issues, []);
  assert.deepEqual(parsedLines(first), [
    { op: 'character.upsert', ref: 'C1', data: { thought: '他似乎在隐瞒什么。' } },
  ]);
});

test('T04-02 P03 第一行保留；JSON_SYNTAX 只定位第二行；incomplete=true', () => {
  const result = parseOperations(caseById('P03').response, { phase: 'observe' });
  assert.equal(result.operations.length, 1);
  assert.deepEqual(parsedLines(result), [
    { op: 'character.upsert', ref: 'C1', data: { thought: '先观察。' } },
  ]);
  assert.deepEqual(result.issues.map((i) => [i.code, i.line]), [['JSON_SYNTAX', 2]]);
  assert.equal(result.incomplete, true);
});

test('T04-03 P07 转义引号还原为 "，\\n 还原为真实换行；修好输入则报 issue', () => {
  const value = parseOperations(caseById('P07').response, { phase: 'observe' }).operations[0].value;
  assert.equal(value.data.thought, '她说："明天再来"，但我还不确定。\n先观察。');
  assert.equal(value.data.thought.includes('\n'), true);
  assert.equal(value.data.thought.includes('\\n'), false);
  assert.equal(value.data.thought.includes('\\"'), false);
});

test('T04-04 P08 SQL 文本：looksLikeSql=true；不是操作也不是 noop', () => {
  const sql = caseById('P08').response;
  assert.equal(looksLikeSql(sql), true);
  const result = parseOperations(sql, { phase: 'observe' });
  assert.equal(result.operations.length, 0);
  assert.equal(result.explicitNoop, false);
});

test('T04-05 P09 未闭合思考段：reasoningBlocked/payload 为空/0 操作', () => {
  const extract = extractPayload(caseById('P09').response);
  assert.equal(extract.reasoningBlocked, true);
  assert.equal(extract.payload, '');
  assert.deepEqual(extract.issues.map((i) => [i.code, i.severity, i.line]), [
    ['UNTERMINATED_REASONING', 'error', 1],
  ]);
  const result = parseOperations(extract.payload, { phase: 'observe' });
  assert.equal(result.operations.length, 0);
});

test('T04-05b 已闭合的 <think> 段被剥掉，后面的行仍能解析', () => {
  const text = [
    '<think>',
    '可能可以这样写：',
    '{"op":"character.upsert","ref":"C2","data":{"thought":"这是思考里的示例"}}',
    '</think>',
    '{"op":"character.upsert","ref":"C1","data":{"thought":"按原计划。"}}',
  ].join('\n');
  const extract = extractPayload(text);
  assert.equal(extract.reasoningBlocked, false);
  assert.equal(extract.payload.includes('示例'), false);
  const result = parseOperations(extract.payload, { phase: 'observe' });
  assert.equal(result.operations.length, 1);
  assert.deepEqual(parsedLines(result), [
    { op: 'character.upsert', ref: 'C1', data: { thought: '按原计划。' } },
  ]);
});

test('T04-06 P10 整个数组 → 2 条操作，顺序一致且 opId 不同', () => {
  const result = parseOperations(caseById('P10').response, { phase: 'observe' });
  assert.equal(result.operations.length, 2);
  assert.deepEqual(result.operations.map((o) => o.value.ref), ['C1', 'C2']);
  assert.notEqual(result.operations[0].opId, result.operations[1].opId);
});

test('T04-07 P11 漏 </atlasEdit>：保留 1 条可用操作 + WRAPPER_INCOMPLETE 警告', () => {
  const extract = extractPayload(caseById('P11').response);
  assert.equal(extract.incomplete, true);
  assert.deepEqual(extract.issues.map((i) => [i.code, i.severity]), [['WRAPPER_INCOMPLETE', 'warning']]);
  const result = parseOperations(extract.payload, { phase: 'observe' });
  assert.equal(result.operations.length, 1);
  assert.deepEqual(parsedLines(result), [
    { op: 'character.upsert', ref: 'C1', data: { thought: '等待消息。' } },
  ]);
});

test('T04-08 空回复与 {"op":"noop"} 可区分', () => {
  const empty = parseOperations('', { phase: 'observe' });
  assert.deepEqual([empty.operations.length, empty.explicitNoop, empty.incomplete], [0, false, true]);

  const noop = parseOperations('{"op":"noop"}', { phase: 'observe' });
  assert.deepEqual([noop.operations.length, noop.explicitNoop, noop.incomplete], [0, true, false]);
  assert.equal(noop.operations.length === empty.operations.length, true);
  assert.notEqual(noop.explicitNoop, empty.explicitNoop);
});

test('T04-09 代码围栏：extractPayload 与直接 parseOperations 都得到 1 条操作', () => {
  const fenced = ['```json', '{"op":"character.upsert","ref":"C1","data":{"thought":"先观察。"}}', '```'].join('\n');

  const extract = extractPayload(fenced);
  assert.equal(extract.payload.includes('```'), false);
  const viaExtract = parseOperations(extract.payload, { phase: 'observe' });
  assert.deepEqual(parsedLines(viaExtract), [
    { op: 'character.upsert', ref: 'C1', data: { thought: '先观察。' } },
  ]);

  // 防御：调用者漏掉 extractPayload 时 parser 自己也要剥围栏。
  const direct = parseOperations(fenced, { phase: 'observe' });
  assert.deepEqual(parsedLines(direct), [
    { op: 'character.upsert', ref: 'C1', data: { thought: '先观察。' } },
  ]);
});

test('T04-10 65 条合法操作 → 保留 64 条 + TOO_MANY_OPERATIONS 报出两个数量', () => {
  const lines = Array.from(
    { length: 65 },
    (_v, i) => `{"op":"character.upsert","ref":"C${i + 1}","data":{"thought":"观察${i + 1}。"}}`,
  );
  const result = parseOperations(lines.join('\n'), { phase: 'observe' });
  assert.equal(result.operations.length, 64);
  const issues = result.issues.filter((i) => i.code === 'TOO_MANY_OPERATIONS');
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /contains 65 valid operations, over the 64 per-response limit/);
  assert.match(issues[0].message, /remaining 1/);
  assert.equal(result.incomplete, true);
});

test('T04-11 损坏的整个数组 → 0 条操作 + JSON_SYNTAX，且不抽取内部 data', () => {
  const result = parseOperations('[{"op":"noop"},{"op":"noop"', { phase: 'observe' });
  assert.equal(result.operations.length, 0);
  assert.deepEqual([...new Set(result.issues.map((i) => i.code))], ['JSON_SYNTAX']);
  assert.equal(result.explicitNoop, false);
  assert.equal(result.operations.some((op) => op.value.data !== undefined), false);
});

test('T04-12 normalizeOperation 逐字节保留自由文本（P04 名称不被改写）', () => {
  const value = parseOperations(caseById('P04').response, { phase: 'observe' }).operations[0].value;
  const normalized = normalizeOperation(value, 'observe');
  assert.equal(normalized.op.data.name, "O'Neil；“渡鸦”");
  assert.equal(normalized.op.data.name, caseById('P04').expected.mustCreate[0].nameEquals);
  assert.equal(normalized.op.data.identity, '港口联络人');
});

test('T04-12b normalizeOperation 不 trim thought / description 内容', () => {
  const raw = {
    op: 'character.upsert',
    ref: 'C1',
    data: { thought: '  先观察。  ', description: '  外观描述  \n第二行 ' },
  };
  const normalized = normalizeOperation(raw, 'observe');
  assert.equal(raw.data.thought, '  先观察。  ');
  assert.equal(raw.data.description, '  外观描述  \n第二行 ');
  assert.deepEqual(
    [normalized.op.data.thought, normalized.op.data.description],
    ['  先观察。  ', '  外观描述  \n第二行 '],
  );
});

test('T04-13 normalizeOperation 应用固定别名 locationRef/actionTendency', () => {
  const normalized = normalizeOperation(
    {
      op: 'character.upsert',
      ref: 'C1',
      data: { locationRef: 'L2', actionTendency: '先看情况' },
    },
    'observe',
  );
  assert.deepEqual([normalized.op.data.location_ref, normalized.op.data.action_tendency], ['L2', '先看情况']);
  assert.equal('locationRef' in normalized.op.data, false);
});

test('T04-13b 未知 data 字段 → FIELD_IGNORED warning，操作仍然返回', () => {
  const normalized = normalizeOperation(
    { op: 'character.upsert', ref: 'C1', data: { thought: 'x', bogus_field: 1 } },
    'observe',
  );
  assert.notEqual(normalized.op, null);
  assert.deepEqual(normalized.ignoredFields, ['bogus_field']);
  assert.deepEqual(normalized.issues.map((i) => [i.code, i.severity, i.path]), [
    ['FIELD_IGNORED', 'warning', '$.data.bogus_field'],
  ]);
  assert.deepEqual(normalized.op.data, { thought: 'x' });
});

test('T04-13c 系统字段 branch_id/row_rev → SYSTEM_FIELD_IGNORED 并被剔除', () => {
  const normalized = normalizeOperation(
    { op: 'character.upsert', ref: 'C1', data: { thought: 'x', branch_id: 'main-B', row_rev: 99 } },
    'observe',
  );
  assert.deepEqual(normalized.systemFields, ['branch_id', 'row_rev']);
  assert.deepEqual(normalized.issues.map((i) => [i.code, i.severity, i.path]), [
    ['SYSTEM_FIELD_IGNORED', 'warning', '$.data.branch_id'],
    ['SYSTEM_FIELD_IGNORED', 'warning', '$.data.row_rev'],
  ]);
  assert.deepEqual(normalized.op.data, { thought: 'x' });
  assert.equal('branch_id' in normalized.op.data, false);
  assert.equal('row_rev' in normalized.op.data, false);
});

test('T04-14 normalizeOperation 未知 op → op 为 null + UNKNOWN_OPERATION 点名该值', () => {
  const normalized = normalizeOperation({ op: 'character.teleport', ref: 'C1', data: {} }, 'observe');
  assert.equal(normalized.op, null);
  assert.deepEqual(normalized.issues.map((i) => i.code), ['UNKNOWN_OPERATION']);
  assert.match(normalized.issues[0].message, /character\.teleport/);
});

test('T04-15 toIssue 保留抛出错误的 code，默认 severity/retryable', () => {
  const error = new Error('boom');
  error.code = 'SQL_CONSTRAINT';
  const issue = toIssue(error, { path: 'characters.C1' });
  assert.deepEqual([issue.code, issue.severity, issue.retryable, issue.path], [
    'SQL_CONSTRAINT',
    'error',
    false,
    'characters.C1',
  ]);
});

test('T04-15b toIssue 无法判定 code 时回落 INTERNAL_ERROR', () => {
  const issue = toIssue(new Error('没有任何错误码'));
  assert.equal(issue.code, ATLAS_ERROR_CODES.INTERNAL_ERROR);
  assert.deepEqual([issue.severity, issue.retryable], ['error', false]);
});

test('T04-15c toIssue 对 AtlasIssueError 保留 code 与 message 并脱敏', () => {
  const issue = toIssue(
    new AtlasIssueError({
      code: 'JSON_SYNTAX',
      path: '$',
      message: 'line 2 无法解析',
      severity: 'warning',
      retryable: true,
    }),
  );
  assert.deepEqual([issue.code, issue.severity, issue.retryable], ['JSON_SYNTAX', 'warning', true]);
  assert.equal(issue.message, 'line 2 无法解析');
});

test('T04-15d redactSecrets 去掉 sk-… 与 Bearer … 令牌', () => {
  const text = 'key=sk-proj-AbCd1234EfGh5678 header=Bearer abcDEF123456ghiJKL';
  const out = redactSecrets(text);
  assert.equal(out.includes('sk-proj-AbCd1234EfGh5678'), false);
  assert.equal(out.includes('abcDEF123456ghiJKL'), false);
  assert.equal(out.includes('[redacted]'), true);
});

test('T04-16 validateMinimum：已有 ref 的心理修改合法；新建缺身份线索不合法', () => {
  const ok = validateMinimum(
    { op: 'character.upsert', ref: 'C1', data: { thought: 'x' } },
    'observe',
  );
  assert.equal(ok.ok, true);

  const bad = validateMinimum(
    { op: 'character.upsert', ref: 'new:x', data: { name: '某人' } },
    'observe',
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.issue.code, 'MINIMUM_FIELD_MISSING');
});

test('T04-16b validateMinimum：item.transfer 两个去向同时给出不合法', () => {
  const result = validateMinimum(
    { op: 'item.transfer', ref: 'I1', data: { to: { holder_ref: 'C1', container_ref: 'I2' } } },
    'observe',
  );
  assert.equal(result.ok, false);
  assert.equal(result.issue.code, 'MINIMUM_FIELD_MISSING');
  assert.equal(result.issue.path, '$.data.to');
});

test('T04-16c validateMinimum：单个去向的 item.transfer 合法', () => {
  const result = validateMinimum(
    { op: 'item.transfer', ref: 'I1', data: { to: { holder_ref: 'C1' } } },
    'observe',
  );
  assert.equal(result.ok, true);
});
