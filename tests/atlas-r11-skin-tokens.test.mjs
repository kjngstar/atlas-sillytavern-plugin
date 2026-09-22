/**
 * atlas-r11-skin-tokens.test.mjs — R11 增量皮肤令牌 + 新样式类契约测试。
 *
 * 对应主计划 R11：
 * - 新增 `--am-selected-outline / --am-selected-shadow`（选中态）
 * - 新增 `--am-breadcrumb-text / --am-breadcrumb-sep / --am-breadcrumb-active`（子图面包屑）
 * - 新增 `--am-status-info / --am-status-warn / --am-status-error`（状态提示三态）
 * - 新增 `--am-avatar-npc / --am-avatar-obj` + `--am-section-label-color`（替换 mappanel 写死色）
 * - 新增 `.aw-breadcrumb / .aw-breadcrumb__item / .aw-breadcrumb__sep` 占位类（R09 UI 接入点）
 * - 新增 `.aw-status--info / --warn / --error` 与 `.aw-banner--info / --warn / --error`
 * - mappanel 头像 / section-label / here-label 全部走令牌，不留写死颜色
 *
 * 设计纪律：仅扩展 `--am-*` 白名单（用户可覆盖）；不引入新前缀；值与现有 `--aw-*` 收口令牌共享。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const styleCss = readFileSync(resolve(root, "style.css"), "utf8");
const indexJs = readFileSync(resolve(root, "index.js"), "utf8");

const REQUIRED_TOKENS = [
  // R11 增量
  "--am-selected-outline",
  "--am-selected-shadow",
  "--am-breadcrumb-text",
  "--am-breadcrumb-sep",
  "--am-breadcrumb-active",
  "--am-status-info-bg",
  "--am-status-info-text",
  "--am-status-warn-bg",
  "--am-status-warn-text",
  "--am-status-error-bg",
  "--am-status-error-text",
  "--am-avatar-npc-bg",
  "--am-avatar-npc-text",
  "--am-avatar-npc-border",
  "--am-avatar-obj-bg",
  "--am-avatar-obj-text",
  "--am-avatar-obj-border",
  "--am-section-label-color",
];

const REQUIRED_CLASSES = [
  ".aw-point.is-selected",
  ".aw-breadcrumb",
  ".aw-breadcrumb__item",
  ".aw-breadcrumb__sep",
  ".aw-status--info",
  ".aw-status--warn",
  ".aw-banner--info",
  ".aw-banner--warn",
  ".aw-banner--error",
];

// ---- T1：所有 R11 增量令牌都在 :root 块内定义 ----
test("R11-T1: all required --am-* tokens are defined in style.css :root", () => {
  for (const token of REQUIRED_TOKENS) {
    // 简化匹配：必须出现 `--token-name:`（定义）而非仅 var(--token-name)
    const defRegex = new RegExp(`${escapeRe(token)}\\s*:`);
    assert.ok(defRegex.test(styleCss), `${token} 必须在 :root 内定义`);
  }
});

// ---- T2：所有 R11 新增 CSS 类都有规则 ----
test("R11-T2: all required CSS class selectors have rule blocks", () => {
  for (const cls of REQUIRED_CLASSES) {
    // 类选择器后跟 {，允许逗号分隔符（.aw-status--info, .aw-banner--info {...}）
    const re = new RegExp(`${escapeRe(cls)}\\s*(?:,\\s*[^,{]+)*\\{`);
    assert.ok(re.test(styleCss), `${cls} 必须在 style.css 中有规则`);
  }
});

// ---- T3：mappanel 头像/标签已替换为令牌（不残留写死颜色） ----
test("R11-T3: mappanel avatar/section-label/here-label use tokens (no hardcoded colors)", () => {
  // .aw-mappanel__avatar--npc 块不应再含 #d8b26a / #42320f / #fff8df
  const npcAvatarBlock = extractBlock(styleCss, ".aw-mappanel__avatar--npc");
  assert.ok(npcAvatarBlock, ".aw-mappanel__avatar--npc 块应存在");
  assert.ok(!/#d8b26a/.test(npcAvatarBlock), "npc avatar 写死颜色应已替换");
  assert.ok(/var\(--am-avatar-npc-bg\)/.test(npcAvatarBlock), "npc avatar bg 应走令牌");
  assert.ok(/var\(--am-avatar-npc-text\)/.test(npcAvatarBlock), "npc avatar text 应走令牌");
  assert.ok(/var\(--am-avatar-npc-border\)/.test(npcAvatarBlock), "npc avatar border 应走令牌");

  const objAvatarBlock = extractBlock(styleCss, ".aw-mappanel__avatar--obj");
  assert.ok(/var\(--am-avatar-obj-bg\)/.test(objAvatarBlock), "obj avatar bg 应走令牌");

  const sectionLabelBlock = extractBlock(styleCss, ".aw-mappanel__section-label");
  assert.ok(/var\(--am-section-label-color\)/.test(sectionLabelBlock), "section-label 应走令牌");
  assert.ok(!/^[^:]*color\s*:\s*#8a6a1c/m.test(sectionLabelBlock), "section-label 不应残留 #8a6a1c");

  const hereLabelBlock = extractBlock(styleCss, ".aw-mappanel__here-label");
  assert.ok(/var\(--am-section-label-color\)/.test(hereLabelBlock), "here-label 应走令牌");
});

// ---- T4：aw-breadcrumb 占位类定义完整 ----
test("R11-T4: aw-breadcrumb / __item / __sep / is-current are all defined", () => {
  for (const sel of [".aw-breadcrumb", ".aw-breadcrumb__item", ".aw-breadcrumb__sep", ".aw-breadcrumb__item.is-current"]) {
    const re = new RegExp(`${escapeRe(sel)}\\s*\\{`);
    assert.ok(re.test(styleCss), `${sel} 缺样式`);
  }
});

// ---- T5：状态提示三态令牌 + 类齐全 ----
test("R11-T5: status info/warn/error tokens + classes are all present", () => {
  // 令牌：--am-status-info-bg/text, --am-status-warn-bg/text, --am-status-error-bg/text
  for (const tok of ["--am-status-info-bg", "--am-status-info-text", "--am-status-warn-bg", "--am-status-warn-text", "--am-status-error-bg", "--am-status-error-text"]) {
    const defRegex = new RegExp(`${escapeRe(tok)}\\s*:`);
    assert.ok(defRegex.test(styleCss), `${tok} 缺定义`);
  }
  // 类：.aw-status--info / --warn / --error + .aw-banner--info / --warn / --error
  for (const cls of [".aw-status--info", ".aw-status--warn", ".aw-status--error", ".aw-banner--info", ".aw-banner--warn", ".aw-banner--error"]) {
    const re = new RegExp(`${escapeRe(cls)}\\s*(?:,\\s*[^,{]+)*\\{`);
    assert.ok(re.test(styleCss), `${cls} 缺规则`);
  }
});

// ---- T6：aw-point.is-selected 钩子供 UI 接入 ----
test("R11-T6: .aw-point.is-selected visual hook is defined (UI toggle point)", () => {
  const re = /\.aw-point\.is-selected\s*\{[\s\S]*?\}/;
  assert.ok(re.test(styleCss), ".aw-point.is-selected 规则应存在");
  // 选中态用 outline 而非 background（不动命中 / 不改大小）
  assert.ok(/outline\s*:\s*var\(--am-selected-outline\)/.test(styleCss), "选中态用 outline 钩子");
  assert.ok(/outline-offset\s*:\s*2px/.test(styleCss), "outline-offset 应留 2px 间距");
});

// ---- T7：index.js 不引用未在 R11 列表里的新令牌（避免遗漏） ----
test("R11-T7: index.js does not reference any --am-* tokens NOT in the whitelist", () => {
  // 提取 index.js 中所有 var(--am-xxx) 引用
  const refs = new Set();
  const refRe = /var\(\s*(--am-[a-z0-9-]+)/g;
  let m;
  while ((m = refRe.exec(indexJs))) refs.add(m[1]);
  // 现有 style.css 已用令牌集合（粗略）：从 REQUIRED_TOKENS + 已知历史 am 令牌合并
  const whitelist = new Set([
    ...REQUIRED_TOKENS,
    "--am-grid-minor",
    "--am-canvas",
    "--am-error",
    "--am-font-family",
    "--am-body-font-size-px",
    "--am-border",
    "--am-shadow",
    "--am-scale-bg",
    "--am-scale-text",
    "--am-estimated",
    "--am-spacing-px",
    "--am-marker-radius-location",
    "--am-marker-radius-person",
    "--am-location",
    "--am-text",
    "--am-popover-width-px",
    "--am-popover-radius-px",
    "--am-popover-bg",
    "--am-popover-header-bg",
    "--am-title-font-size-px",
    "--am-text-muted",
    "--am-motion",
    "--am-title-font-size-px",
  ]);
  for (const ref of refs) {
    assert.ok(whitelist.has(ref), `index.js 引用了白名单外令牌 ${ref}`);
  }
});

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 提取 .selector { ... } 的完整规则块（最外层）。简化版：找第一个 { 后匹配的 }。 */
function extractBlock(css, selector) {
  const re = new RegExp(`${escapeRe(selector)}\\s*\\{`, "g");
  const match = re.exec(css);
  if (!match) return null;
  let depth = 1;
  let i = match.index + match[0].length;
  while (i < css.length && depth > 0) {
    const ch = css[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    i += 1;
  }
  return css.slice(match.index, i);
}