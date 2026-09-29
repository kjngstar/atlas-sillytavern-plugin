/**
 * atlas-build-artifacts-p0.browser.test.mjs — P0-04
 *
 * 验证 npm run build 后,atlas-extension/dist/atlas-sql.mjs 在
 * 没有 Node `Buffer` 的环境下能成功加载并调用 parseOperations / extractPayload。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distPath = resolve(root, 'atlas-extension/dist/atlas-sql.mjs');

test('P0-04a npm run build 产物存在且不含 Buffer.byteLength', () => {
  const buf = readFileSync(distPath);
  assert.ok(buf.length > 0, 'dist/atlas-sql.mjs 应存在');
  const text = buf.toString('utf8');
  assert.equal(
    text.includes('Buffer.byteLength'),
    false,
    'dist/atlas-sql.mjs 不应再含 Buffer.byteLength',
  );
});

test('P0-04b 在无 Buffer 环境下加载并调用 parseOperations', async () => {
  // 在子进程里跑(避免污染主进程 globalThis.Buffer)
  // 用 vm.SourceTextModule + 自定义 context 不行(dist 用了 ESM import)。
  // 改用 child_process 跑内嵌脚本:它会 import dist 并调用 parseOperations。
  const inlineScript = `
    // 模拟浏览器:删掉 Buffer
    delete globalThis.Buffer;
    const url = ${JSON.stringify(pathToFileURL(distPath).href)};
    const mod = await import(url);
    const result = mod.parseOperations(
      JSON.stringify({ op: 'character.upsert', ref: 'C1', data: { name: '甲' } }),
      { phase: 'observe' },
    );
    if (result.operations.length !== 1) {
      console.error('operations.length !== 1: ' + JSON.stringify(result));
      process.exit(2);
    }
    if (result.issues.length !== 0) {
      console.error('issues.length !== 0: ' + JSON.stringify(result));
      process.exit(3);
    }
    // extractPayload 也要可跑
    const extracted = mod.extractPayload('\`\`\`json\\n{"op":"noop"}\\n\`\`\`');
    if (typeof extracted.payload !== 'string' || !extracted.payload.includes('"op":"noop"')) {
      console.error('extractPayload failed: ' + JSON.stringify(extracted));
      process.exit(4);
    }
    console.log('OK');
  `;
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', inlineScript],
    { encoding: 'utf8', timeout: 30000 },
  );
  assert.match(out, /OK/);
});

test('P0-04c 浏览器路径:超长输入仍返回 TOO_LARGE Issue', async () => {
  const inlineScript = `
    delete globalThis.Buffer;
    const url = ${JSON.stringify(pathToFileURL(distPath).href)};
    const mod = await import(url);
    const huge = '{"op":"noop","data":{"x":"' + 'A'.repeat(80000) + '"}}';
    const result = mod.parseOperations(huge, { phase: 'observe' });
    if (result.issues.length === 0) {
      console.error('expected at least one issue, got: ' + JSON.stringify(result));
      process.exit(2);
    }
    const code = result.issues[0].code;
    if (typeof code !== 'string' || !code.includes('TOO_LARGE')) {
      console.error('expected TOO_LARGE code, got: ' + code);
      process.exit(3);
    }
    console.log('OK');
  `;
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', inlineScript],
    { encoding: 'utf8', timeout: 30000 },
  );
  assert.match(out, /OK/);
});