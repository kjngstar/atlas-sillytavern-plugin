/**
 * atlas-db-pack.test.mjs — T29 打包产物与发布卫生（§18.3 T29 / §16.1 / §17H H14、H15）。
 *
 * §18.3 要求本文件覆盖的断言：打包产物包含 JS/wasm/Worker，三处版本一致；禁 CDN 仍运行；
 * 无上级 src 依赖。
 *
 * 说明：
 * - 本文件只**读取**已存在的构建/打包产物，不触发构建（`npm run build` / `npm run pack` 由
 *   门槛顺序负责，见 §18.5）。产物缺失时明确 `t.skip` 并给出缺失路径，绝不把缺失当通过。
 * - `atlas-integration.test.mjs` 会在 `node --test` 下并发执行 `tools/pack.mjs`（先清空再重建
 *   release/、重写 dist），因此读取带重试：读失败或读到半截不算通过，也不会被重试掩盖真实违规。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ATLAS_SQL_VENDOR_FILES,
  ATLAS_SQL_WORKER_FILE,
  sqlVendorLocator,
  verifySqlVendorAssets,
} from '../src/atlas-db-assets.ts';
import { createAtlasServerPlugin } from '../atlas-server-plugin/index.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extDist = join(root, 'atlas-extension', 'dist');
const pluginDist = join(root, 'atlas-server-plugin', 'dist');
const releaseUi = join(root, 'release', 'atlas-ui-extension');
const releasePlugin = join(root, 'release', 'atlas-server-plugin');

/** §18.3-T29 点名的五件产物。 */
const ARTIFACTS = {
  'atlas-extension/dist/atlas-sql.mjs': join(extDist, 'atlas-sql.mjs'),
  'atlas-extension/dist/atlas-sql-worker.js': join(extDist, ATLAS_SQL_WORKER_FILE),
  'atlas-extension/dist/vendor/sql-wasm.js': join(extDist, 'vendor', 'sql-wasm.js'),
  'atlas-extension/dist/vendor/sql-wasm.wasm': join(extDist, 'vendor', 'sql-wasm.wasm'),
  'atlas-server-plugin/dist/atlas-sql.mjs': join(pluginDist, 'atlas-sql.mjs'),
};

const CDN_HOSTS = /cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|https:\/\/cdn\./;
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d]; // \0asm

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 并发 pack/build 会重写产物；读到半截或读失败时重试，最终仍失败就抛出（不静默跳过）。 */
async function readStable(file, isComplete = () => true, attempts = 40) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    if (existsSync(file)) {
      try {
        const data = readFileSync(file);
        if (isComplete(data)) return data;
      } catch (error) {
        lastError = error;
      }
    }
    await sleep(150);
  }
  throw new Error(`无法稳定读取 ${file}${lastError ? `（${lastError.message}）` : '（内容一直不完整，可能有并发构建）'}`);
}

async function readTextStable(file, isComplete) {
  const data = await readStable(file, (buf) => (isComplete ? isComplete(buf.toString('utf8')) : true));
  return data.toString('utf8');
}

/** 等产物出现（并发 pack 可能正在重建 release/）。 */
async function waitForFiles(files, attempts = 15) {
  for (let i = 0; i < attempts; i += 1) {
    if (files.every((file) => existsSync(file))) return true;
    await sleep(200);
  }
  return false;
}

/** 收集 ESM 产物的导出名（`export {...}` 与 `export function/const` 两种形态）。 */
function exportedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/export\s*\{([\s\S]*?)\}/g)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
  }
  for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }
  return names;
}

test('T29-01 打包产物包含 JS/wasm/Worker，且都非空', async (t) => {
  const missing = Object.entries(ARTIFACTS).filter(([, file]) => !existsSync(file)).map(([name]) => name);
  if (missing.length > 0) {
    t.skip(`构建产物尚未生成（缺 ${missing.join(', ')}）；先运行 npm run build`);
    return;
  }
  for (const [name, file] of Object.entries(ARTIFACTS)) {
    assert.ok(statSync(file).size > 0, `${name} 不应为空`);
  }
  const bundle = await readTextStable(
    ARTIFACTS['atlas-extension/dist/atlas-sql.mjs'],
    (text) => text.includes('createSqlRepository') && text.includes('loadAtlasSqlRuntime') && /export\s*\{/.test(text),
  );
  assert.ok(bundle.includes('createSqlRepository'), 'UI 侧 SQL 产物必须自带业务 Repository 入口');
  assert.ok(bundle.includes('loadAtlasSqlRuntime'), 'UI 侧产物必须自带 SQL 运行时装配入口');
  assert.ok(bundle.includes('ATLAS_SQL_VERSION') || bundle.includes('1.14.1'), '必须携带 §16.1 固定的 sql.js 版本标记');
  const serverBundle = await readTextStable(
    ARTIFACTS['atlas-server-plugin/dist/atlas-sql.mjs'],
    (text) => text.includes('createSqlRepository') && text.includes('loadAtlasSqlRuntime'),
  );
  assert.ok(serverBundle.includes('createSqlRepository'), 'server 侧 SQL 产物与 UI 侧同源同入口');
});

test('T29-02 Worker 是自包含 IIFE；wasm 是真实二进制（\\0asm 魔数）', async (t) => {
  const workerFile = ARTIFACTS['atlas-extension/dist/atlas-sql-worker.js'];
  const wasmFile = ARTIFACTS['atlas-extension/dist/vendor/sql-wasm.wasm'];
  const vendorJsFile = ARTIFACTS['atlas-extension/dist/vendor/sql-wasm.js'];
  const missing = [workerFile, wasmFile, vendorJsFile].filter((file) => !existsSync(file));
  if (missing.length > 0) {
    t.skip(`构建产物尚未生成（缺 ${missing.join(', ')}）；先运行 npm run build`);
    return;
  }
  const worker = await readTextStable(
    workerFile,
    (text) => text.includes('createSqlRepository') && text.includes('installSqlWorker') && text.includes('sql-wasm.wasm'),
  );
  assert.equal(/^\s*import\s/m.test(worker), false, 'Worker 必须是自包含产物：不得有裸 import 语句');
  assert.equal(/^\s*export\s/m.test(worker), false, 'Worker 用经典脚本加载，不得是 ESM/带 export');
  assert.match(worker, /\(\s*\(\s*\)\s*=>\s*\{|\(\s*function\s*\(\s*\)\s*\{/, 'Worker 必须是 IIFE 包裹');
  assert.ok(worker.includes('sql-wasm.wasm'), 'Worker 必须引用本地 wasm 文件名（相对路径，不是 CDN）');
  assert.equal(CDN_HOSTS.test(worker), false, 'Worker 不得引用 CDN');

  const wasmSize = statSync(wasmFile).size;
  const wasm = await readStable(
    wasmFile,
    (buf) => buf.length > 10000 && buf.length === statSync(wasmFile).size && buf[0] === 0x00 && buf[1] === 0x61,
  );
  assert.deepEqual([...wasm.subarray(0, 4)], WASM_MAGIC, 'wasm 必须以 \\0asm 魔数开头（不是占位文本）');
  assert.ok(wasm.length > 10000, `wasm 体积异常（${wasm.length} 字节）`);
  assert.equal(wasm.length, wasmSize, 'wasm 必须完整读入（不把半截文件当通过）');

  const vendorJs = await readTextStable(vendorJsFile, (text) => text.includes('sql-wasm.wasm'));
  assert.ok(vendorJs.includes('sql-wasm.wasm'), 'vendor JS 侧必须解析同一目录的 wasm');
});

test('T29-03 禁 CDN 仍运行：产物无 CDN 主机，vendor 定位器只放行两个白名单文件', async (t) => {
  const files = [
    ARTIFACTS['atlas-extension/dist/atlas-sql.mjs'],
    ARTIFACTS['atlas-extension/dist/atlas-sql-worker.js'],
    ARTIFACTS['atlas-extension/dist/vendor/sql-wasm.js'],
    ARTIFACTS['atlas-server-plugin/dist/atlas-sql.mjs'],
  ];
  const missing = files.filter((file) => !existsSync(file));
  if (missing.length > 0) {
    t.skip(`构建产物尚未生成（缺 ${missing.join(', ')}）；先运行 npm run build`);
    return;
  }
  for (const file of files) {
    const text = await readTextStable(file, (t2) => t2.length > 1000 && /export\s*\{|sql-wasm\.wasm/.test(t2));
    assert.equal(CDN_HOSTS.test(text), false, `${file} 不得引用任何 CDN 主机（§16.1）`);
  }

  // vendor 定位器：只认白名单文件名，且无论如何都返回本地相对路径。
  const locate = sqlVendorLocator('https://host.example/ext/dist/');
  assert.equal(locate('sql-wasm.wasm'), 'https://host.example/ext/dist/vendor/sql-wasm.wasm');
  assert.equal(locate('/abs/path/sql-wasm.js'), 'https://host.example/ext/dist/vendor/sql-wasm.js');
  assert.equal(
    locate('https://cdn.jsdelivr.net/npm/sql.js@1.14.1/dist/sql-wasm.wasm'),
    'https://host.example/ext/dist/vendor/sql-wasm.wasm',
    '即使 sql.js 给出 CDN 地址，也必须落到本地 vendor',
  );
  assert.throws(() => locate('sql-asm.js'), /DB_WASM_LOAD_FAILED/);
  assert.throws(() => locate('sql-wasm-debug.wasm'), /DB_WASM_LOAD_FAILED/);
  assert.throws(() => locate('evil.js'), /DB_WASM_LOAD_FAILED/);

  // 实际 vendor 目录必须与清单完全一致（不多不少）。
  const vendorDir = join(extDist, 'vendor');
  if (!existsSync(vendorDir)) {
    t.skip(`构建产物尚未生成（缺 ${vendorDir}）；先运行 npm run build`);
    return;
  }
  const present = readdirSync(vendorDir).map((name) => `vendor/${name}`);
  const verified = verifySqlVendorAssets(present);
  assert.equal(verified.ok, true, `vendor 缺文件：${JSON.stringify(verified.missing)}`);
  assert.deepEqual(verified.missing, []);
  assert.deepEqual(verified.extra, [], `vendor 目录出现白名单外文件：${JSON.stringify(verified.extra)}`);
  assert.deepEqual(
    ATLAS_SQL_VENDOR_FILES.map((asset) => asset.relative).sort(),
    ['vendor/sql-wasm.js', 'vendor/sql-wasm.wasm'],
  );
  assert.equal(ATLAS_SQL_WORKER_FILE, 'atlas-sql-worker.js');
});

test('T29-04 三处版本一致：package.json / manifest.json / server package = 插件 version', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const mirror = JSON.parse(readFileSync(join(root, 'atlas-extension', 'manifest.json'), 'utf8'));
  const serverPkg = JSON.parse(readFileSync(join(root, 'atlas-server-plugin', 'package.json'), 'utf8'));
  const plugin = createAtlasServerPlugin();

  assert.ok(/^\d+\.\d+/.test(String(pkg.version)), `package.json.version 形态异常：${pkg.version}`);
  assert.equal(manifest.version, pkg.version, 'manifest.json 版本必须等于 package.json');
  assert.equal(serverPkg.version, pkg.version, 'atlas-server-plugin/package.json 版本必须等于 package.json');
  assert.equal(plugin.version, pkg.version, 'createAtlasServerPlugin().version 必须等于 package.json');
  assert.equal(plugin.id, 'atlas');
  assert.equal(plugin.protocolVersion, 1);
  assert.equal(mirror.version, pkg.version, 'atlas-extension/manifest.json 镜像必须与根 manifest 同步（pack 会同步）');
});

test('T29-05 无上级 src 依赖：发布副本只走组件内 ./dist（dev 回退已剥离）', async (t) => {
  const entries = [join(releaseUi, 'index.js'), join(releasePlugin, 'index.mjs')];
  if (!(await waitForFiles(entries))) {
    const absent = entries.filter((file) => !existsSync(file));
    t.skip(`先运行 npm run pack（缺 ${absent.join(', ')}）`);
    return;
  }
  for (const file of entries) {
    const text = await readTextStable(file, (t2) => t2.includes('const attempts') || t2.includes('ATLAS_PLUGIN_VERSION'));

    // 1) 加载候选数组里的 dev 回退（`["../dist/x.mjs", "../src/x.ts"]`）必须已被 tools/pack.mjs 剥掉。
    assert.equal(
      /\[\s*"\.\/dist\/[a-z-]+\.mjs"\s*,\s*"\.\.\/src\/[a-z-]+\.ts"\s*\]/.test(text),
      false,
      `${file} 仍带 dev 回退数组（发布副本不得回读上级 src）`,
    );
    const attemptsLines = text.split(/\r?\n/).filter((line) => /const attempts\s*=/.test(line));
    assert.ok(attemptsLines.length > 0, `${file} 应保留组件内加载候选清单`);
    for (const line of attemptsLines) {
      assert.equal(/\.\.\//.test(line), false, `${file} 的加载候选不得指向上级目录：${line.trim()}`);
    }

    // 2) 可执行代码不得引用上级 src；注释里描述「源码在 ../src/xxx.ts」属于说明文字，不算依赖。
    const codeRefs = text
      .split(/\r?\n/)
      .filter((line) => line.includes('../src/') && !/^\s*(\*|\/\/|\/\*)/.test(line));
    assert.deepEqual(codeRefs, [], `${file} 的代码里出现上级 src 引用：\n${codeRefs.slice(0, 3).join('\n')}`);

    // 3) 动态 import 的字面量说明符也不得指向上级 src。
    for (const match of text.matchAll(/import\s*\(\s*(['"`])([^'"`]+)\1/g)) {
      assert.equal(match[2].includes('../src/'), false, `${file} 动态 import 了上级 src：${match[2]}`);
    }
  }
});

test('T29-06 打包的 server 插件 dist/atlas-sql.mjs 导出 loadAtlasSqlRuntime', async (t) => {
  const serverSql = ARTIFACTS['atlas-server-plugin/dist/atlas-sql.mjs'];
  if (!existsSync(serverSql)) {
    t.skip(`构建产物尚未生成（缺 atlas-server-plugin/dist/atlas-sql.mjs）；先运行 npm run build`);
    return;
  }
  const text = await readTextStable(
    serverSql,
    (t2) => t2.includes('openSqlSession') && /export\s*\{[\s\S]*loadAtlasSqlRuntime[\s\S]*\}/.test(t2),
  );
  const names = exportedNames(text);
  assert.ok(
    [...names].some((name) => name === 'loadAtlasSqlRuntime'),
    `Node 侧 SQL 运行时入口必须导出 loadAtlasSqlRuntime，实际导出 ${names.size} 项`,
  );
  assert.ok(names.has('createSqlRepository'), '同一产物必须导出 createSqlRepository');
  assert.ok(names.has('openSqlSession'), '同一产物必须导出会话入口（/sql/* 需要）');

  // 发布副本（npm run pack 之后）必须带同一个入口，打包插件里 /sql/* 才可达。
  const releaseSql = join(releasePlugin, 'dist', 'atlas-sql.mjs');
  if (existsSync(releaseSql)) {
    const releaseText = await readTextStable(
      releaseSql,
      (t2) => t2.includes('openSqlSession') && /export\s*\{[\s\S]*loadAtlasSqlRuntime[\s\S]*\}/.test(t2),
    );
    assert.ok(
      exportedNames(releaseText).has('loadAtlasSqlRuntime'),
      'release/atlas-server-plugin/dist/atlas-sql.mjs 必须同样导出 loadAtlasSqlRuntime',
    );
    assert.equal(CDN_HOSTS.test(releaseText), false, '发布副本不得引用 CDN');
  }
});
