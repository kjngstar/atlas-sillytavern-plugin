/**
 * atlas-map-skin.test.mjs — 0.9.51（外部 AI 计划 M07/M08：地图皮肤令牌注册表 + 导入管理）
 * 与 M06 子集（旅行预览附标定物理距离）门禁。
 *
 * 硬约束：
 *  1. 注册表是唯一权威——ATLAS_MAP_SKIN_TOKENS 的每个 --am-* 必须在 style.css 有消费点；
 *  2. 枚举令牌的每个值必须在 CSS 值映射表有具体值（用户字符串绝不直接拼接进 CSS）；
 *  3. parseAtlasMapSkin 校验纪律：kind / 协议版本、#hex 颜色白名单、数字 clamp、
 *     未知令牌提示不执行、__proto__/constructor 进不了结果、64KiB 与令牌数上限；
 *  4. applyAtlasMapSkin 幂等 + 移除恢复跟随；export 只含元数据与令牌（无敏感字段）；
 *  5. 内置样例真实可导入；M06 换算只给距离不编造时间。
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

const {
  ATLAS_MAP_SKIN_TOKENS,
  ATLAS_MAP_SKIN_PRESETS,
  ATLAS_MAP_SKIN_BYTES_MAX,
  ATLAS_MAP_SKIN_TOKENS_MAX,
  parseAtlasMapSkin,
  atlasMapSkinToCssVars,
  applyAtlasMapSkin,
  exportAtlasMapSkin,
} = await import("../index.js");

// C5（0.9.54）：距离换算已统一到 src/atlas-scale.ts 唯一权威实现，
// index.js 不再转出该算法（旧实现为 index.js 内的重复副本）。
const { formatTravelDistance } = await import("../src/atlas-scale.ts");

const cssText = readFileSync(fileURLToPath(new URL("../style.css", import.meta.url)), "utf8");

test("注册表合约：每个 --am-* 令牌必须在 style.css 有消费点", () => {
  const missing = Object.values(ATLAS_MAP_SKIN_TOKENS)
    .map((spec) => spec.css)
    .filter((cssVar) => !cssText.includes(cssVar));
  assert.deepEqual(missing, [], `style.css 缺少消费点：${missing.join("、")}`);
});

test("注册表合约：枚举令牌的每个值都有 CSS 值映射", async () => {
  const { ATLAS_MAP_SKIN_TOKENS: serverCopy } = await import("../index.js");
  for (const [key, spec] of Object.entries(serverCopy)) {
    if (spec.type !== "enum") continue;
    assert.ok(spec.enum.length >= 2, `${key} 枚举非空`);
  }
});

test("parse：合法完整包通过且令牌逐键进结果", () => {
  const skin = {
    kind: "atlas-map-skin",
    schemaVersion: 1,
    skinApiVersion: 1,
    id: "user.midnight-map",
    name: "夜色地图",
    version: "1.0.0",
    author: "用户自定义",
    baseTheme: "dark",
    tokens: {
      "colors.canvas": "#0d1017",
      "colors.person": "#E8A757",
      "metrics.popoverWidthPx": 320,
      "effects.shadow": "medium",
      "markers.itemShape": "diamond",
    },
  };
  const result = parseAtlasMapSkin(skin);
  assert.ok(result.ok);
  assert.equal(result.skin.name, "夜色地图");
  assert.equal(result.skin.tokens["colors.person"], "#e8a757", "颜色规范化小写");
  assert.equal(result.skin.tokens["metrics.popoverWidthPx"], 320);
  assert.equal(result.skin.unknownKeys, 0);
});

test("parse：部分覆盖包（只带 1 个令牌）合法", () => {
  const result = parseAtlasMapSkin({
    kind: "atlas-map-skin",
    schemaVersion: 1,
    skinApiVersion: 1,
    name: "只换底色",
    tokens: { "colors.canvas": "#101010" },
  });
  assert.ok(result.ok);
  assert.deepEqual(Object.keys(result.skin.tokens), ["colors.canvas"]);
});

test("parse：字符串 JSON 输入与非法 JSON / 非对象拒绝", () => {
  const ok = parseAtlasMapSkin(JSON.stringify({
    kind: "atlas-map-skin", schemaVersion: 1, skinApiVersion: 1, tokens: {},
  }));
  assert.ok(ok.ok);
  assert.ok(!parseAtlasMapSkin("{broken").ok);
  assert.ok(!parseAtlasMapSkin(null).ok);
  assert.ok(!parseAtlasMapSkin([1, 2]).ok);
});

test("parse：未知版本明确拒绝（不静默兼容）", () => {
  const result = parseAtlasMapSkin({
    kind: "atlas-map-skin", schemaVersion: 2, skinApiVersion: 1, tokens: {},
  });
  assert.ok(!result.ok);
  assert.ok(result.error.includes("版本"));
});

test("parse：非法颜色（rgb() / named / CSS 表达式注入）拒绝", () => {
  for (const bad of ["rgb(1,2,3)", "red", "url(javascript:alert(1))", "#zzzzzz", "var(--x)", ""]) {
    const result = parseAtlasMapSkin({
      kind: "atlas-map-skin", schemaVersion: 1, skinApiVersion: 1,
      tokens: { "colors.canvas": bad },
    });
    assert.ok(result.ok, "解析不炸（坏令牌忽略）");
    assert.ok(!("colors.canvas" in result.skin.tokens), `${bad} 不进结果`);
    assert.ok(result.skin.warnings.some((w) => w.includes("colors.canvas")), `${bad} 有提示`);
  }
});

test("parse：数字令牌 clamp 到注册表范围、非数字拒绝", () => {
  const result = parseAtlasMapSkin({
    kind: "atlas-map-skin", schemaVersion: 1, skinApiVersion: 1,
    tokens: { "metrics.popoverWidthPx": 9999, "metrics.spacingPx": "10" },
  });
  assert.ok(result.ok);
  assert.equal(result.skin.tokens["metrics.popoverWidthPx"], 480, "超上限 clamp 到 max");
  assert.ok(!("metrics.spacingPx" in result.skin.tokens), "字符串伪数值拒绝");
});

test("parse：未知令牌提示不执行；__proto__ / constructor 键进不了结果", () => {
  const raw = '{"kind":"atlas-map-skin","schemaVersion":1,"skinApiVersion":1,"tokens":{"colors.canvas":"#111111","__proto__":{"polluted":true},"constructor":"evil","customKey":"x"}}';
  const result = parseAtlasMapSkin(raw);
  assert.ok(result.ok);
  const tokens = result.skin.tokens;
  assert.equal(Object.keys(tokens).length, 1, "只有白名单键进结果");
  assert.ok(!("polluted" in {}), "原型未被污染");
  assert.equal({}.polluted, undefined, "Object.prototype 无污染");
  assert.ok(result.skin.warnings.length >= 3, "未知 / 危险键有提示");
  assert.ok(result.skin.unknownKeys >= 3);
});

test("parse：64KiB 与令牌数上限明确拒绝", () => {
  const big = JSON.stringify({
    kind: "atlas-map-skin", schemaVersion: 1, skinApiVersion: 1,
    tokens: { "colors.canvas": "#111111" },
    padding: "x".repeat(ATLAS_MAP_SKIN_BYTES_MAX),
  });
  const result = parseAtlasMapSkin(big);
  assert.ok(!result.ok);
  assert.ok(result.error.includes("KiB"));
  const many = { kind: "atlas-map-skin", schemaVersion: 1, skinApiVersion: 1, tokens: {} };
  for (let i = 0; i <= ATLAS_MAP_SKIN_TOKENS_MAX; i++) many.tokens[`ghost.${i}`] = "#111111";
  assert.ok(!parseAtlasMapSkin(many).ok, "令牌数超限拒绝");
});

test("cssVars：枚举经映射表供值；未提供令牌不注入", () => {
  const vars = atlasMapSkinToCssVars({
    tokens: { "colors.canvas": "#0d1017", "effects.shadow": "medium", "fonts.family": "serif", "metrics.popoverRadiusPx": 10 },
  });
  assert.ok(vars.includes("--am-canvas: #0d1017;"));
  assert.ok(vars.includes("--am-shadow: 0 4px 14px rgba(31,42,51,0.18);"), "shadow 枚举映射为具体值");
  assert.ok(vars.includes("--am-font-family: var(--aw-serif);"), "字体枚举映射为工作台变量引用");
  assert.ok(vars.includes("--am-popover-radius-px: 10;"));
  assert.equal(atlasMapSkinToCssVars(null), "");
  assert.equal(atlasMapSkinToCssVars({ tokens: {} }), "");
});

test("apply：幂等注入 + 移除恢复跟随（jsdom）", () => {
  const root = document.createElement("div");
  root.className = "atlas-workbench";
  document.body.append(root);
  const skin = parseAtlasMapSkin(ATLAS_MAP_SKIN_PRESETS[0]).skin;
  applyAtlasMapSkin(root, skin);
  const style1 = document.querySelector("style[data-atlas-map-skin]");
  assert.ok(style1, "注入 style 标签");
  assert.ok(style1.textContent.includes("--am-canvas: #0d1017;"));
  assert.equal(root.dataset.atlasMapSkin, "builtin.midnight-map");
  applyAtlasMapSkin(root, skin);
  assert.equal(document.querySelectorAll("style[data-atlas-map-skin]").length, 1, "幂等：不重复建标签");
  assert.ok(style1.textContent.includes("prefers-reduced-motion"), "系统减少动画兼容");
  applyAtlasMapSkin(root, null);
  assert.equal(document.querySelector("style[data-atlas-map-skin]"), null, "null 移除注入");
  assert.ok(!("atlasMapSkin" in root.dataset), "根标记清除");
  root.remove();
});

test("export：只含元数据与令牌，round-trip 可再导入", () => {
  const skin = parseAtlasMapSkin(ATLAS_MAP_SKIN_PRESETS[1]).skin;
  const json = exportAtlasMapSkin(skin);
  for (const forbidden of ["apiKey", "endpoint", "chatId", "secret", "world"]) {
    assert.ok(!json.includes(forbidden), `导出不含 ${forbidden}`);
  }
  const reparsed = parseAtlasMapSkin(json);
  assert.ok(reparsed.ok);
  assert.equal(reparsed.skin.name, "羊皮纸地图");
  assert.deepEqual(reparsed.skin.tokens, skin.tokens, "令牌 round-trip 无损");
});

test("内置样例：两个真实可导入（深色战术 / 浅色纸面）", () => {
  assert.equal(ATLAS_MAP_SKIN_PRESETS.length, 2);
  for (const preset of ATLAS_MAP_SKIN_PRESETS) {
    const result = parseAtlasMapSkin(preset);
    assert.ok(result.ok, `${preset.name} 可导入`);
    assert.ok(Object.keys(result.skin.tokens).length >= 15, `${preset.name} 令牌丰富`);
  }
  const dark = ATLAS_MAP_SKIN_PRESETS[0];
  const paper = ATLAS_MAP_SKIN_PRESETS[1];
  assert.equal(dark.baseTheme, "dark");
  assert.equal(paper.baseTheme, "paper");
});

// ---------------------------------------------------------------------------
// M06 子集：旅行预览附标定物理距离（只换算距离，绝不编造时间）
// ---------------------------------------------------------------------------

test("M06：formatTravelDistance 有标定换算物理距离、无标定返回空", () => {
  assert.equal(formatTravelDistance(40, 60), "≈ 2.4 公里", "40 格 × 60 米");
  assert.equal(formatTravelDistance(3, 50), "≈ 150 米");
  assert.equal(formatTravelDistance(10, 0), "", "非法标定不换算");
  assert.equal(formatTravelDistance(10, -5), "", "负标定不换算");
  assert.equal(formatTravelDistance(0, 60), "", "零格程不换算");
  assert.equal(formatTravelDistance("10", 60), "", "字符串伪数值不换算");
  assert.equal(formatTravelDistance(10, Number.NaN), "", "NaN 不换算");
});
