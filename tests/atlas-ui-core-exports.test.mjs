/**
 * atlas-ui-core-exports.test.mjs — ATLAS-18 回归修复（0.9.4）的永久门禁。
 *
 * 背景：src/atlas-browser-entry.ts（esbuild 打包入口）漏转出 atlasCustomIncludeHeaders
 * → dist 没有该导出 → index.js testConnection 解构得到 undefined → 「测试连接 / 加载模型」
 * 全炸（0.9.2/0.9.3 真实酒馆暴露）。本测试双向把关：
 *   1. index.js 里所有 `const { ... } = await loadUiCore()` 解构的名字，dist 必须真的导出；
 *   2. 关键接线导出逐一显式断言（挂载 / 模型列表 / 生成代理三条链路）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexSource = readFileSync(join(root, "atlas-extension", "index.js"), "utf8");

test("dist/atlas-ui-core.mjs 覆盖 index.js 全部 loadUiCore 解构需求 + 关键接线导出", async () => {
  const dist = await import("../atlas-extension/dist/atlas-ui-core.mjs");

  // 1) 静态扫描 index.js 的 loadUiCore() 解构目标，逐一断言 dist 已导出且非 undefined
  const pattern = /\{\s*([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\s*\}\s*=\s*await\s+loadUiCore\(\)/g;
  const names = new Set();
  for (const match of indexSource.matchAll(pattern)) {
    for (const raw of match[1].split(",")) names.add(raw.trim());
  }
  assert.ok(names.size > 0, "index.js 应存在 loadUiCore() 解构（扫描器失效时报警）");
  for (const name of names) {
    assert.ok(name in dist, `dist 必须导出 index.js 解构的 "${name}"`);
    assert.notEqual(dist[name], undefined, `dist 导出的 "${name}" 不得为 undefined`);
  }

  // 2) 三条关键链路的显式断言（防止将来改写时漏出）
  assert.equal(typeof dist.atlasCustomIncludeHeaders, "function", "模型列表/测试连接链路");
  assert.equal(typeof dist.createStProxyFetch, "function", "生成代理链路");
  assert.equal(typeof dist.createAtlasUiCore, "function", "UI 核心链路");
  assert.equal(typeof dist.starterWorldIdForChat, "function", "确定性建世链路");
  assert.equal(dist.ATLAS_ST_GENERATE_PATH, "/api/backends/chat-completions/generate");
});

test("index.js PAGES 与 ui-core ATLAS_UI_PAGES 双源一致（防导航漂移）", async () => {
  const { ATLAS_UI_PAGES } = await import("../src/atlas-ui-core.ts");
  const js = readFileSync(join(root, "atlas-extension", "index.js"), "utf8");
  const block = js.match(/const PAGES = \[[\s\S]*?\];/);
  assert.ok(block, "index.js 应有 PAGES 数组");
  for (const page of ATLAS_UI_PAGES) {
    assert.ok(block[0].includes(`id: "${page.id}"`), `index.js PAGES 缺少页面 ${page.id}`);
    assert.ok(block[0].includes(`label: "${page.label}"`), `index.js PAGES 缺少标签 ${page.label}`);
  }
  assert.ok(!block[0].includes("settings"), "不得回流 settings 页");
});
