/**
 * atlas-skin.test.mjs — 0.9.45 皮肤系统门禁。
 *
 * 三条硬约束：
 *  1. style.css 基座定义的每个 --aw-* 令牌必须在 ATLAS_SKIN_VARIABLES 注册清单里
 *     （自定义皮肤作者看清单改令牌，清单漏一个 = 有一个位置皮肤改不动）；
 *  2. 深色主题覆盖块只准覆盖在册令牌（不准偷偷发明清单外变量）；
 *  3. applyAtlasSkin 幂等：主题属性挂根节点、自定义 CSS 注入单个 <style>、超长截断。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!doctype html><html><head></head><body></body></html>`, {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;

const { ATLAS_SKIN_VARIABLES, ATLAS_SKIN_THEMES, normalizeAtlasSkinTheme, applyAtlasSkin } =
  await import("../atlas-extension/index.js");

const cssText = readFileSync(fileURLToPath(new URL("../style.css", import.meta.url)), "utf8");

/** 提取一个 CSS 块内定义的 --aw-* 变量名（key: value 形式）。 */
function variablesInBlock(block) {
  return [...block.matchAll(/(--aw-[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
}

/** 按「选择器 {」切出顶层块（本文件无嵌套 @media 里的 --aw- 定义，字符串切分足够）。 */
function extractBlock(selector) {
  const index = cssText.indexOf(selector);
  assert.notEqual(index, -1, `style.css 必须包含 ${selector}`);
  const open = cssText.indexOf("{", index);
  let depth = 1;
  let cursor = open + 1;
  while (depth > 0 && cursor < cssText.length) {
    if (cssText[cursor] === "{") depth += 1;
    else if (cssText[cursor] === "}") depth -= 1;
    cursor += 1;
  }
  return cssText.slice(open + 1, cursor - 1);
}

test("皮肤注册清单：基座定义的每个 --aw-* 令牌都在 ATLAS_SKIN_VARIABLES 里", () => {
  const base = extractBlock(".atlas-workbench {");
  const defined = variablesInBlock(base);
  assert.ok(defined.length >= 34, `基座至少 34 个令牌（实测 ${defined.length}）`);
  const registry = new Set(ATLAS_SKIN_VARIABLES);
  const missing = defined.filter((name) => !registry.has(name));
  assert.deepEqual(missing, [], "未注册的令牌（必须补进 ATLAS_SKIN_VARIABLES）");
  const unique = new Set(ATLAS_SKIN_VARIABLES);
  assert.equal(unique.size, ATLAS_SKIN_VARIABLES.length, "注册清单不得有重复项");
});

test("皮肤注册清单：深色主题块只覆盖在册令牌，且覆盖的是可读子集", () => {
  const dark = extractBlock('.atlas-workbench[data-atlas-theme="dark"] {');
  const overridden = variablesInBlock(dark);
  const registry = new Set(ATLAS_SKIN_VARIABLES);
  const unknown = overridden.filter((name) => !registry.has(name));
  assert.deepEqual(unknown, [], "深色主题不得使用注册清单之外的令牌");
  assert.ok(overridden.length >= 25, `深色主题应覆盖主要视觉令牌（实测 ${overridden.length}）`);
  // 字体不随主题变：深色块不得覆盖 --aw-serif / --aw-sans
  assert.ok(!overridden.includes("--aw-serif") && !overridden.includes("--aw-sans"), "字体令牌不随主题切换");
});

test("normalizeAtlasSkinTheme：未知值回退 paper，合法值原样通过", () => {
  assert.equal(normalizeAtlasSkinTheme("dark"), "dark");
  assert.equal(normalizeAtlasSkinTheme("paper"), "paper");
  assert.equal(normalizeAtlasSkinTheme("nord"), "paper");
  assert.equal(normalizeAtlasSkinTheme(undefined), "paper");
  assert.equal(normalizeAtlasSkinTheme(null), "paper");
  assert.equal(normalizeAtlasSkinTheme(""), "paper");
  assert.ok(ATLAS_SKIN_THEMES.some((t) => t.id === "dark"), "内置主题必须含 dark");
});

test("applyAtlasSkin：主题挂 dataset、自定义 CSS 注入单个 style 标签、超长截断、幂等", () => {
  const root = document.createElement("div");
  root.className = "atlas-workbench";

  // 缺省：paper = 无 data-atlas-theme 属性
  applyAtlasSkin(root, {});
  assert.equal(root.hasAttribute("data-atlas-theme"), false, "paper 主题不得挂属性");
  assert.equal(document.querySelectorAll("style[data-atlas-custom-skin]").length, 1, "自定义样式标签恰一个");
  assert.equal(document.querySelector("style[data-atlas-custom-skin]").textContent, "", "无自定义 CSS 时为空");

  // 深色：属性挂上，CSS 注入
  applyAtlasSkin(root, { theme: "dark", customCss: ".atlas-workbench { --aw-gold: red; }" });
  assert.equal(root.dataset.atlasTheme, "dark");
  assert.equal(
    document.querySelector("style[data-atlas-custom-skin]").textContent,
    ".atlas-workbench { --aw-gold: red; }",
  );

  // 幂等：重复调用不叠加 style 标签；回 paper 时属性被移除
  applyAtlasSkin(root, { theme: "dark", customCss: "b {}" });
  applyAtlasSkin(root, { theme: "paper", customCss: "" });
  assert.equal(root.hasAttribute("data-atlas-theme"), false);
  assert.equal(document.querySelectorAll("style[data-atlas-custom-skin]").length, 1);
  assert.equal(document.querySelector("style[data-atlas-custom-skin]").textContent, "");

  // 超长截断（20000 上限）与非法主题回退
  const huge = "x".repeat(25000);
  const result = applyAtlasSkin(root, { theme: "nord", customCss: huge });
  assert.equal(result.theme, "paper");
  assert.equal(result.customCss.length, 20000);
  assert.equal(document.querySelector("style[data-atlas-custom-skin]").textContent.length, 20000);

  // 无 document 环境（Node 直调）：只算不炸
  const savedDocument = globalThis.document;
  delete globalThis.document;
  try {
    const bare = applyAtlasSkin(null, { theme: "dark", customCss: "c {}" });
    assert.equal(bare.theme, "dark");
    assert.equal(bare.customCss, "c {}");
  } finally {
    globalThis.document = savedDocument;
  }
});
