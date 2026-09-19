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

test("侧边栏七栏：顺序固定为 概览/地图/附近/变化/推进/API/日志，且不存在「设置」", () => {
  assert.deepEqual(
    ATLAS_UI_PAGES.map((p) => p.id),
    ["overview", "map", "nearby", "changes", "progression", "api", "logs"],
    "页面 id 顺序固定",
  );
  assert.deepEqual(
    ATLAS_UI_PAGES.map((p) => p.label),
    ["概览", "地图", "附近", "变化", "推进", "API", "日志"],
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

// ---------------------------------------------------------------------------
// ATLAS-18 结构与职责不变量（源码级；真实观感仍由人工验收）
// ---------------------------------------------------------------------------

test("职责隔离：API 页不出现提示词编辑，推进页不出现连接字段", () => {
  const js = readFileSync(join(root, "atlas-extension", "index.js"), "utf8");
  const apiPanel = js.slice(js.indexOf("function buildApiPanel()"), js.indexOf("async function testConnection"));
  const progression = js.slice(js.indexOf("function buildProgressionPanel()"), js.indexOf("function buildApiPanel()"));
  assert.ok(apiPanel.length > 0 && progression.length > 0, "两个面板都存在");
  assert.ok(!/systemPrompt/.test(apiPanel), "API 页不出现提示词字段");
  assert.ok(!/aw-input--area/.test(apiPanel), "API 页不出现提示词 textarea");
  assert.ok(/pages?.*「推进」|前往推进/.test(apiPanel), "API 页提供「前往推进」只读跳转");
  assert.ok(!/endpoint/.test(progression.replace(/当前 API[\s\S]*?api\)/, "")), "推进页不出现端点输入（只读摘要除外）");
  assert.ok(/前往 API/.test(progression), "推进页提供「前往 API」只读跳转");
  assert.ok(/当前生效提示词/.test(progression), "推进页有只读的当前生效提示词");
});

test("majorEvent 已从生产 UI 隐藏（未接线功能不得露出）", () => {
  const js = readFileSync(join(root, "atlas-extension", "index.js"), "utf8");
  assert.ok(!js.includes("majorEvent"), "生产 UI 不再出现 majorEvent 槽位");
  assert.ok(!js.includes("重大事件"), "生产 UI 不再出现「重大事件」按钮");
});

test("高级世界管理默认折叠；普通未绑定状态不要求导入", () => {
  const js = readFileSync(join(root, "atlas-extension", "index.js"), "utf8");
  assert.ok(/高级：迁移或恢复已有世界/.test(js), "高级入口文案存在");
  assert.ok(/createElement\("details"\)/.test(js), "用 <details> 折叠");
  assert.ok(!/details\.open\s*=\s*true/.test(js), "默认不展开");
  assert.ok(/无需导入/.test(js), "未绑定主路径写明无需导入");
  assert.ok(!/前往「设置」/.test(js), "不再引导用户去「设置」页");
});

test("草稿保护：统一未保存确认文案，且两页草稿互不阻塞", () => {
  const js = readFileSync(join(root, "atlas-extension", "index.js"), "utf8");
  assert.ok(/当前有未保存的更改。继续将丢弃这些更改。/.test(js), "统一确认文案");
  assert.ok(/apiDraftDirty/.test(js) && /promptDraftDirty/.test(js), "两个草稿各自维护 dirty");
  assert.ok(/confirmDiscard\("API 连接"\)/.test(js) && /confirmDiscard\("提示词"\)/.test(js), "确认分别作用于两个编辑区");
});

test("自动建世：确定性 ID + 并发闸门 + 切聊天保护（不再用时间戳 ID）", () => {
  const js = readFileSync(join(root, "atlas-extension", "index.js"), "utf8");
  assert.ok(/starterWorldIdForChat\(chatId\)/.test(js), "世界 ID 由 chatId 确定性派生");
  assert.ok(!/id: `world-\$\{Date\.now\(\)\}`/.test(js), "建世不再使用时间戳 ID（避免重试重复世界）");
  assert.ok(/const ensureWorldInFlight = new Map\(\)/.test(js), "并发闸门是 Map<chatId, Promise>");
  assert.ok(/ensureWorldInFlight\.get\(chatId\)/.test(js), "同聊天复用在途 Promise");
  assert.ok(/ensureWorldInFlight\.delete\(chatId\)/.test(js), "finally 清理在途标记");
  assert.ok(/"\/worlds\/ensure-starter"/.test(js), "走幂等端点，不走会覆盖的 import");
  assert.ok(/nowChatId !== chatId/.test(js), "ensure 期间切聊天则不绑定");
  assert.ok(!/初始化失败[\s\S]{0,120}throw/.test(js), "初始化失败不抛出（不阻断酒馆生成）");
});
