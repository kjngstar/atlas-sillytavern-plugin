/**
 * atlas-sql-node-runtime.test.mjs — H13 Node 模式 SQL 运行时可达性。
 *
 * 关键断言（防止「声明了 /sql/* 但发布形态下永远 SQL_RUNTIME_UNAVAILABLE」这种缺口）：
 * 1. 服务插件的 SQL 运行时加载器在**构建产物形态**下能真正拿到运行时；
 * 2. `/sql/*` 路由已登记进插件注册表与核心清单，且两者一致；
 * 3. 没有 SQL 运行时/repository 时，路由回 SQL_MODE_DISABLED / SQL_RUNTIME_UNAVAILABLE
 *    这类**具名诊断**，而不是 404 或崩溃。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATLAS_PLUGIN_ROUTES, createAtlasServerPlugin } from '../atlas-server-plugin/index.mjs';
import { ATLAS_ROUTE_MANIFEST } from '../src/atlas-server.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sqlRoutes = ['/sql/turn', '/sql/retry', '/sql/rollback', '/sql/state', '/sql/maintenance', '/sql/migrate'];

test('H13-01 /sql/* 已登记进核心清单与插件注册表，且两者一致', () => {
  for (const path of sqlRoutes) {
    assert.ok(
      ATLAS_ROUTE_MANIFEST.some((r) => r.path === path && r.method === 'POST'),
      `核心清单缺 ${path}`,
    );
    assert.ok(
      ATLAS_PLUGIN_ROUTES.some((r) => r.path === path && r.method === 'POST'),
      `插件注册表缺 ${path}`,
    );
  }
  assert.equal(ATLAS_PLUGIN_ROUTES.length, ATLAS_ROUTE_MANIFEST.length, '插件注册表与核心清单必须一致');
  const plugin = createAtlasServerPlugin();
  for (const path of sqlRoutes) {
    assert.ok(plugin.routes.some((r) => r.path === `${'/api/plugins/atlas'}${path}`), `下发行缺少 ${path}`);
  }
});

test('H13-02 Node 侧 SQL 运行时加载器：优先 dist 产物，其次开发形态', () => {
  const source = readFileSync(join(root, 'atlas-server-plugin', 'index.mjs'), 'utf8');
  assert.match(source, /loadSqlRuntimeForNode/, '必须存在 Node 侧运行时加载器');
  const distIdx = source.indexOf('"./dist/atlas-sql.mjs"');
  const srcIdx = source.indexOf('"../src/atlas-sql-browser-entry.ts"');
  assert.ok(distIdx > 0, '必须优先加载组件内 dist 产物（发布形态）');
  assert.ok(srcIdx > distIdx, '开发形态只能作为兜底，且在发布形态之后');
  assert.match(source, /loadAtlasSqlRuntime/, '必须调用同一入口导出的 loadAtlasSqlRuntime');
  assert.match(source, /sqlRuntime/, '必须把运行时注入核心（否则 /sql/* 永远不可达）');
});

test('H13-03 构建产物存在时能真正载入 SQL 运行时（同一入口的 node 平台产物）', async (t) => {
  const distBundle = join(root, 'atlas-server-plugin', 'dist', 'atlas-sql.mjs');
  if (!existsSync(distBundle)) {
    t.skip('尚未运行 npm run build（缺 atlas-server-plugin/dist/atlas-sql.mjs）');
    return;
  }
  const mod = await import(new URL(`file://${distBundle.replace(/\\/g, '/')}`).href);
  assert.equal(typeof mod.loadAtlasSqlRuntime, 'function', '产物必须导出 loadAtlasSqlRuntime');
  const runtime = await mod.loadAtlasSqlRuntime();
  assert.ok(runtime, '运行时不得为 null');
  assert.equal(typeof runtime.openSqlSession, 'function');
  assert.equal(typeof runtime.runSqlTurn, 'function');
  assert.equal(typeof runtime.runSqlRollback, 'function');
  assert.equal(typeof runtime.persistSqlSession, 'function');
});

test('H13-04 无 repository 时 /sql/state 回具名诊断而不是 404/崩溃', async () => {
  const { createAtlasServerCore } = await import('../src/atlas-server.ts');
  const store = {
    async read() {
      return null;
    },
    async write() {},
    async list() {
      return [];
    },
    async remove() {},
  };
  const core = createAtlasServerCore({ store });
  const result = await core.handle('POST', '/sql/state', { chatId: 'c1', kind: 'map' }, { local: true });
  assert.ok(result.status >= 200 && result.status < 500, `不应是服务故障：${result.status}`);
  const codes = [];
  const collect = (value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.code === 'string') codes.push(value.code);
    for (const v of Object.values(value)) collect(v);
  };
  collect(result.body);
  assert.ok(
    codes.includes('SQL_MODE_DISABLED') || codes.includes('SQL_RUNTIME_UNAVAILABLE'),
    `应给出具名诊断，实际：${codes.join(',') || JSON.stringify(result.body).slice(0, 200)}`,
  );
});
