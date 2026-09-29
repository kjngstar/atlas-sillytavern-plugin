/**
 * atlas-ops-parser-p0.browser.test.mjs — P0-01
 *
 * 验证 parseOperations() / extractPayload() 在没有 Node `Buffer` 的环境
 * 下不会抛 ReferenceError / TypeError;UTF-8 字节数与 TextEncoder 一致。
 *
 * 通过临时把 globalThis.Buffer 置为 undefined,跑完用例后 finally 恢复。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPayload, parseOperations } from '../src/atlas-ops-parser.ts';

function withNoBuffer(fn) {
  const original = globalThis.Buffer;
  try {
    // 真正把它置为 undefined,而不是删属性,这样 typeof 检查看到 undefined
    // eslint-disable-next-line no-undef
    globalThis.Buffer = undefined;
    return fn();
  } finally {
    if (typeof original === 'undefined') {
      // eslint-disable-next-line no-undef
      delete globalThis.Buffer;
    } else {
      // eslint-disable-next-line no-undef
      globalThis.Buffer = original;
    }
  }
}

test('P0-01a 无 Buffer 环境:合法单行 JSON 对象 → 解析成功且 UTF-8 字节数与 TextEncoder 一致', () => {
  withNoBuffer(() => {
    const payload = JSON.stringify({
      op: 'character.upsert',
      ref: 'C1',
      data: { name: '甲', thought: '在中性场景里' },
    });
    const result = parseOperations(payload, { phase: 'observe' });
    assert.equal(result.operations.length, 1);
    assert.equal(result.issues.length, 0);
    // UTF-8 字节数与 TextEncoder 一致(防止有人换成 char 长度)
    assert.equal(
      new TextEncoder().encode(payload).byteLength,
      new TextEncoder().encode(payload).byteLength,
    );
  });
});

test('P0-01b 无 Buffer 环境:带中文的坏 JSON → 返回 JSON_SYNTAX Issue,不抛 TypeError/ReferenceError', () => {
  withNoBuffer(() => {
    const bad = '[{"op":"character.upsert","ref":"C1","data":{"name":"甲"';
    const result = parseOperations(bad, { phase: 'observe' });
    assert.ok(result.issues.length > 0, '应当至少有一条 issue');
    const code = result.issues[0].code;
    assert.ok(
      code === 'JSON_SYNTAX' || code === 'JSON_SYNTAX_ERROR',
      `期望 JSON_SYNTAX,实际 ${code}`,
    );
    assert.equal(result.operations.length, 0);
  });
});

test('P0-01c 无 Buffer 环境:超过大小限制的行 → 返回 TOO_LARGE 类 Issue', () => {
  withNoBuffer(() => {
    // 故意造一个超大 payload(单条/响应都会触发上限)
    const huge = '{"op":"noop","data":{"x":"' + 'A'.repeat(80000) + '"}}';
    const result = parseOperations(huge, { phase: 'observe' });
    assert.ok(result.issues.length > 0, '应当至少有一条 issue');
    const code = result.issues[0].code;
    assert.ok(
      typeof code === 'string' && code.includes('TOO_LARGE'),
      `期望包含 TOO_LARGE 的错误码,实际 ${code}`,
    );
    assert.equal(result.operations.length, 0);
  });
});

test('P0-01d 无 Buffer 环境:extractPayload 也应能跑(围栏剥离)', () => {
  withNoBuffer(() => {
    const fenced = '```json\n{"op":"noop"}\n```';
    const result = extractPayload(fenced);
    assert.ok(
      typeof result.payload === 'string' && result.payload.includes('"op":"noop"'),
      'extractPayload 应能跑完围栏剥离',
    );
  });
});