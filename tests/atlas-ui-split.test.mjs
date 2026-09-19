/**
 * atlas-ui-split.test.mjs — ATLAS-18 侧边栏六栏结构与输入控件样式合约（先红后绿）。
 *
 * 口径来源：开发规格README.md 0.7（信息架构：删「设置」、新增「推进」）与 0.8（scoped CSS 契约）。
 *
 * 说明：本文件是**结构合约**单测（页面清单 / CSS 覆盖面 / 作用域），
 * 真实酒馆浅色与深色主题的计算样式与肉眼可读性仍必须人工截图验收（规格 0.8 明文要求）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ATLAS_UI_PAGES } from "../src/atlas-ui-core.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("侧边栏六栏：顺序固定为 概览/地图/附近/变化/推进/API，且不存在「设置」", () => {
  assert.deepEqual(
    ATLAS_UI_PAGES.map((p) => p.id),
    ["overview", "map", "nearby", "changes", "progression", "api"],
    "页面 id 顺序固定",
  );
  assert.deepEqual(
    ATLAS_UI_PAGES.map((p) => p.label),
    ["概览", "地图", "附近", "变化", "推进", "API"],
    "用户标签固定",
  );
  assert.ok(
    ATLAS_UI_PAGES.every((p) => p.id !== "settings"),
    "不得保留 settings 页面",
  );
});

test("源码中不再存在 settings 页面残留（page id / 导航 / 渲染分支）", () => {
  const uiCore = readFileSync(join(root, "src", "atlas-ui-core.ts"), "utf8");
  const indexJs = readFileSync(join(root, "atlas-extension", "index.js"), "utf8");
  assert.ok(!/page\s*[:=]\s*"settings"/.test(uiCore), "ui-core 不再出现 settings 页状态");
  assert.ok(!/id:\s*"settings",\s*label/.test(indexJs), "导航不再渲染「设置」项");
  assert.ok(!/settingsSlot/.test(indexJs), "settingsSlot 死代码已删除");
  assert.ok(/id:\s*"progression",\s*label:\s*"推进"/.test(indexJs), "导航出现「推进」项");
});

test("CSS 合约：scoped 覆盖 input / select / textarea / option / placeholder / autofill", () => {
  const css = readFileSync(join(root, "atlas-extension", "style.css"), "utf8");
  const required = [
    [".atlas-workbench.atlas-workbench input.aw-input", "input 控件"],
    [".atlas-workbench.atlas-workbench select.aw-input", "select 控件"],
    [".atlas-workbench.atlas-workbench textarea.aw-input", "textarea 控件"],
    ["option", "下拉选项"],
    ["::placeholder", "占位文字"],
    [":-webkit-autofill", "浏览器自动填充"],
  ];
  for (const [needle, label] of required) {
    assert.ok(css.includes(needle), `CSS 必须覆盖${label}（缺 ${needle}）`);
  }
  assert.ok(/background-color:\s*#fff\s*!important/i.test(css), "浅底必须用 !important 压过宿主主题");
  assert.ok(/color:\s*#1e383a\s*!important/i.test(css), "深字必须用 !important");
  assert.ok(/-webkit-text-fill-color/.test(css), "必须处理 -webkit-text-fill-color（密码框/自动填充）");
  assert.ok(/caret-color/.test(css), "光标颜色需明确");
  assert.ok(/color-scheme:\s*light/.test(css), "强制浅色控件配色方案");
});

test("CSS 合约：样式必须限定在 .atlas-workbench 内，不污染酒馆其他输入框", () => {
  const css = readFileSync(join(root, "atlas-extension", "style.css"), "utf8");
  // 逐条检查：任何给 input/select/textarea 设颜色的规则都必须带 .atlas-workbench 作用域
  const blocks = css.split("}");
  const offenders = [];
  for (const block of blocks) {
    const [selectorPart] = block.split("{");
    if (!selectorPart) continue;
    const selector = selectorPart.trim();
    if (!selector || selector.startsWith("/*") || selector.startsWith("@")) continue;
    if (!/(^|[\s,])(input|select|textarea|option)\b/.test(selector)) continue;
    if (/\.atlas-workbench/.test(selector)) continue;
    if (/^\s*(input|select|textarea|option)[^{]*$/.test(selector)) offenders.push(selector);
  }
  assert.deepEqual(offenders, [], "不得存在无作用域的裸控件选择器");
});
