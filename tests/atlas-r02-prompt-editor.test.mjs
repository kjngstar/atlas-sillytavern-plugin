/**
 * atlas-r02-prompt-editor.test.mjs — R02 推进编辑器状态模型回归测试。
 *
 * 断言方向与 v0.9.51 基线相反（基线：新建后 nameReadOnly=true / insertButtons=0 / readOnlySegments=8）：
 * - D07：新建草稿立即可编辑（kind=new，不再是「没有 id 就当内置」）
 * - 保存新预设后绑定 createdId：再次保存 = 覆盖（命令带 id），不重复新建
 * - D15：另存为完整保留 role/name/mainSlot/content 与 contextTurnCount
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function mount() {
  const dom = new JSDOM("<!doctype html><head></head><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  const style = document.createElement("style");
  style.textContent = readFileSync(resolve(root, "style.css"), "utf8");
  document.head.append(style);
  const source = readFileSync(resolve(root, "index.js"), "utf8");
  const { renderPanel } = await import("data:text/javascript;base64," + Buffer.from(source + "\nexport {renderPanel};").toString("base64"));
  const { createDefaultSettingsV2, settingsViewV2 } = await import(pathToFileURL(resolve(root, "src/atlas-settings.ts")).href);
  const { DEFAULT_PROMPT_SEGMENTS } = await import(pathToFileURL(resolve(root, "src/atlas-api-client.ts")).href);
  return { dom, renderPanel, createDefaultSettingsV2, settingsViewV2, DEFAULT_PROMPT_SEGMENTS };
}

function tick(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

test("R02: 新建草稿立即可编辑；保存后 createdId 绑定，再存为覆盖", async () => {
  const { dom, renderPanel, createDefaultSettingsV2, settingsViewV2, DEFAULT_PROMPT_SEGMENTS } = await mount();
  const commands = [];
  let settingsV2 = createDefaultSettingsV2();
  const state = {
    page: "progression",
    panelOpen: true,
    receipts: [],
    serviceStatus: "online",
    mode: "online",
    chatId: "r02-chat",
    stateData: { chatId: "r02-chat", worldId: null, worldName: "", currentTime: 0, currentLocationId: null, map: { points: [] }, regions: [], npcDirectory: [], objectDirectory: [] },
  };
  const core = {
    getState: () => state,
    setPage: (p) => { state.page = p; core.__renderPage(); },
    setPanelOpen: () => {},
    refresh: async () => {},
  };
  const api = {
    request: async (_method, _path, body) => {
      if (body && body.action) commands.push(body);
      if (body?.action === "prompt.save") {
        const created = {
          id: `prompt-${commands.length}`,
          name: body.preset.name,
          systemPrompt: body.preset.systemPrompt ?? "",
          ...(body.preset.segments ? { segments: body.preset.segments } : {}),
          ...(body.preset.contextTurnCount != null ? { contextTurnCount: body.preset.contextTurnCount } : {}),
        };
        settingsV2 = { ...settingsV2, promptPresets: [...settingsV2.promptPresets, created], activePromptPresetId: created.id };
      }
      return { status: 200, body: { ok: true, data: settingsV2 } };
    },
  };
  // settingsViewV2 会给出 promptPresets 视图；面板直接消费 settingsV2 形状
  const view = settingsViewV2(settingsV2);
  settingsV2 = { ...settingsV2, promptPresets: view.promptPresets ?? [] };
  const container = document.createElement("div");
  document.body.append(container);
  renderPanel(core, container, (x) => x, api, { read: async () => null }, { ...view, builtInPrompt: { segments: DEFAULT_PROMPT_SEGMENTS, systemPrompt: DEFAULT_PROMPT_SEGMENTS[0].content } });
  await tick();

  // 新建 → 立即可编辑（D07 修复）
  container.querySelector('[aria-label="新建提示词预设"]').click();
  await tick();
  const nameInput = container.querySelector('[aria-label="提示词名称"]');
  assert.equal(nameInput.readOnly, false, "新建草稿名称可写");
  assert.ok(container.querySelectorAll(".aw-seg-insert").length >= 2, "插入按钮存在");
  assert.equal(container.querySelectorAll(".aw-seg-rows--readonly textarea").length, 0, "没有只读分段误挂");

  // 填名 + 插一段 + 写正文 + 保存
  nameInput.value = "R02 预设";
  nameInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  container.querySelector(".aw-seg-insert").click();
  await tick();
  const area = container.querySelector('[aria-label="第 1 段正文"]');
  area.value = "A 段正文 $5";
  area.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const saveBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "保存新预设");
  saveBtn.click();
  await tick();
  const saveCmd = commands.filter(Boolean).find((c) => c.action === "prompt.save");
  assert.ok(saveCmd, "发出 prompt.save");
  assert.equal(saveCmd.preset.id, undefined, "首次保存无 id（新建）");
  assert.equal(saveCmd.preset.segments[0].content, "A 段正文 $5", "段正文保真");

  // 改名再保存 → 命令带 id（覆盖语义，不重复新建）
  // 注意：保存后 renderCenter 重建了 DOM，必须重新查询输入框（旧节点已失焦 detached）
  const nameInput2 = container.querySelector('[aria-label="提示词名称"]');
  nameInput2.value = "R02 预设改";
  nameInput2.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const saveBtn2 = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("保存修改到"));
  assert.ok(saveBtn2, "保存按钮转为覆盖文案");
  assert.equal(saveBtn2.disabled, false, "dirty 后保存按钮可用");
  saveBtn2.click();
  await tick();
  const cmds = commands.filter(Boolean).filter((c) => c.action === "prompt.save");
  assert.equal(cmds.length, 2, "只发出两次保存");
  assert.equal(cmds[1].preset.id, saveCmd ? `prompt-1` : undefined, "第二次保存带 createdId（覆盖）");
});

test("R02: 另存为完整保留段字段与上下文条数（D15）", async () => {
  const { dom, renderPanel, createDefaultSettingsV2, settingsViewV2, DEFAULT_PROMPT_SEGMENTS } = await mount();
  const commands = [];
  const savedPreset = {
    id: "prompt-src",
    name: "来源预设",
    systemPrompt: "",
    segments: [{ role: "user", name: "世界状态", mainSlot: "A", content: "$5" }],
    contextTurnCount: 5,
  };
  let settingsV2 = { ...createDefaultSettingsV2(), promptPresets: [savedPreset], activePromptPresetId: "prompt-src" };
  const state = {
    page: "progression",
    panelOpen: true,
    receipts: [],
    serviceStatus: "online",
    mode: "online",
    chatId: "r02b-chat",
    stateData: { chatId: "r02b-chat", worldId: null, worldName: "", currentTime: 0, currentLocationId: null, map: { points: [] }, regions: [], npcDirectory: [], objectDirectory: [] },
  };
  const core = {
    getState: () => state,
    setPage: (p) => { state.page = p; core.__renderPage(); },
    setPanelOpen: () => {},
    refresh: async () => {},
  };
  const api = {
    request: async (_method, _path, body) => {
      commands.push(body);
      if (body?.action === "prompt.save") {
        const created = { id: "prompt-copy", name: body.preset.name, systemPrompt: body.preset.systemPrompt ?? "", ...(body.preset.segments ? { segments: body.preset.segments } : {}), ...(body.preset.contextTurnCount != null ? { contextTurnCount: body.preset.contextTurnCount } : {}) };
        settingsV2 = { ...settingsV2, promptPresets: [...settingsV2.promptPresets, created] };
      }
      return { status: 200, body: { ok: true, data: settingsV2 } };
    },
  };
  const view = settingsViewV2(settingsV2);
  const container = document.createElement("div");
  document.body.append(container);
  renderPanel(core, container, (x) => x, api, { read: async () => null }, { ...view, builtInPrompt: { segments: DEFAULT_PROMPT_SEGMENTS, systemPrompt: DEFAULT_PROMPT_SEGMENTS[0].content } });
  await tick();

  // 选中已存预设 → saved 工作副本；另存为
  const select = container.querySelector('[aria-label="选择提示词预设（选中即设为当前使用）"]');
  select.value = "prompt-src";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await tick();
  dom.window.prompt = () => "来源预设 副本";
  const saveAsBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "另存为");
  saveAsBtn.click();
  await tick();
  const cmd = commands.filter(Boolean).find((c) => c.action === "prompt.save");
  assert.ok(cmd, "发出另存为命令");
  assert.equal(cmd.preset.segments[0].name, "世界状态", "段名称保留");
  assert.equal(cmd.preset.segments[0].mainSlot, "A", "主槽位保留");
  assert.equal(cmd.preset.contextTurnCount, 5, "上下文条数保留");
  // 另存为后编辑器载入新副本
  const nameAfter = container.querySelector('[aria-label="提示词名称"]');
  assert.equal(nameAfter.value, "来源预设 副本", "编辑器载入另存为结果");
});
