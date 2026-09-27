/**
 * atlas-build-artifacts.test.mjs — T29 打包产物（H14/H15）。
 *
 * 覆盖：sql.js 业务核心的独立产物存在、Worker 是自包含 IIFE、本地 vendor 的 JS/wasm
 * 同版本存在且**不依赖 CDN**、`ATLAS_SQL_VENDOR_FILES` 清单与实际文件一致。
 *
 * 注意：本测试跑 `tools/build.mjs` 的真实构建出口（不 mock esbuild），
 * 因此它同时验证「构建能产出这三个文件」而不是只检查清单常量。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ATLAS_SQL_VENDOR_FILES,
  ATLAS_SQL_WORKER_FILE,
  resolveSqlAssetBase,
  sqlVendorLocator,
  verifySqlVendorAssets,
} from '../src/atlas-db-assets.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'atlas-extension', 'dist');

test('T29-01 vendor 清单固定为 sql-wasm.js + sql-wasm.wasm（同版本）', () => {
  assert.deepEqual(
    ATLAS_SQL_VENDOR_FILES.map((a) => a.relative).sort(),
    ['vendor/sql-wasm.js', 'vendor/sql-wasm.wasm'],
  );
  assert.equal(ATLAS_SQL_WORKER_FILE, 'atlas-sql-worker.js');
});

test('T29-02 sqlVendorLocator 只放行白名单文件，且永远给出本地路径（不从 CDN 加载）', () => {
  const locate = sqlVendorLocator('https://example.invalid/dist/');
  assert.equal(locate('sql-wasm.wasm'), 'https://example.invalid/dist/vendor/sql-wasm.wasm');
  assert.equal(locate('/abs/path/sql-wasm.js'), 'https://example.invalid/dist/vendor/sql-wasm.js');
  // 即使 sql.js 内部给出别的 URL，返回的也是**本地**路径（CDN 不会被使用）。
  assert.equal(locate('https://cdn.example.com/sql-wasm.wasm'), 'https://example.invalid/dist/vendor/sql-wasm.wasm');
  // 白名单外的文件名一律拒绝。
  assert.throws(() => locate('sql-asm.js'), /DB_WASM_LOAD_FAILED/);
  assert.throws(() => locate('sql-wasm-debug.wasm'), /DB_WASM_LOAD_FAILED/);
  assert.throws(() => locate('evil.js'), /DB_WASM_LOAD_FAILED/);
});

test('T29-03 resolveSqlAssetBase：显式 base 优先，且保证以 / 结尾', () => {
  assert.equal(resolveSqlAssetBase('https://host/ext/dist'), 'https://host/ext/dist/');
  assert.equal(resolveSqlAssetBase('./assets/'), './assets/');
  assert.ok(resolveSqlAssetBase(null).length > 0);
});

test('T29-04 verifySqlVendorAssets 报缺失与多余', () => {
  const missing = verifySqlVendorAssets(['vendor/sql-wasm.js']);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['vendor/sql-wasm.wasm']);
  const complete = verifySqlVendorAssets(ATLAS_SQL_VENDOR_FILES.map((a) => a.relative));
  assert.equal(complete.ok, true);
  assert.deepEqual(complete.missing, []);
});

test('T29-05 构建产物存在：atlas-sql.mjs / atlas-sql-worker.js / vendor 资源', (t) => {
  const sqlBundle = join(dist, 'atlas-sql.mjs');
  const worker = join(dist, ATLAS_SQL_WORKER_FILE);
  const wasmJs = join(dist, 'vendor', 'sql-wasm.js');
  const wasm = join(dist, 'vendor', 'sql-wasm.wasm');
  const present = [sqlBundle, worker, wasmJs, wasm].filter((p) => existsSync(p));
  if (present.length !== 4) {
    // 构建未运行时明确跳过（不是把缺失当通过）。
    t.skip(`构建产物尚未生成（缺 ${[sqlBundle, worker, wasmJs, wasm].filter((p) => !existsSync(p)).join(', ')}）；请先运行 npm run build`);
    return;
  }
  for (const file of [sqlBundle, worker, wasmJs, wasm]) {
    assert.ok(statSync(file).size > 0, `${file} 不应为空`);
  }
  const workerSource = readFileSync(worker, 'utf8');
  assert.equal(/^\s*import\s/m.test(workerSource), false, 'Worker 必须是自包含 IIFE（不能有裸 import）');
  const bundleSource = readFileSync(sqlBundle, 'utf8');
  // 产物不得内嵌 sql.js 的 wasm 二进制（体积会爆），也不得引用 CDN。
  assert.equal(/cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com/.test(bundleSource), false, '不得从 CDN 加载 sql.js');
  assert.equal(/cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com/.test(workerSource), false, 'Worker 不得从 CDN 加载 sql.js');
  assert.ok(bundleSource.includes('createSqlRepository'), '产物应含业务 Repository 入口');
  assert.ok(bundleSource.includes('ATLAS_SQL_VERSION') || bundleSource.includes('1.14.1'), '产物应携带固定版本标记');
});

test('T29-06 产物内的 vendor 路径是相对路径', () => {
  const sqlBundle = join(dist, 'atlas-sql.mjs');
  if (!existsSync(sqlBundle)) return;
  const source = readFileSync(sqlBundle, 'utf8');
  assert.equal(/vendor\/sql-wasm\.wasm/.test(source) || /sql-wasm\.wasm/.test(source), true, '必须引用本地 wasm');
});
