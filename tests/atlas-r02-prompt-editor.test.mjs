import {readUiSource} from './ui-source-helper.mjs';
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

/**
 * renderPanel 的 mod 夹具（C5/C6）：面板要从核心模块解构比例尺纯函数与页面清单
 * （发布形态由 atlas-browser-entry 提供）。此前这些测试把 settings 视图对象当 mod
 * 传入，只靠「解构出 undefined 也不抛错」侥幸通过；补齐真实表面后，
 * 导航与比例尺在本文件里也能真实渲染。
 */
const CORE_MOD_KEYS = {
  ...(await import(pathToFileURL(resolve(root, "src/atlas-scale.ts")).href)),
  ...(await import(pathToFileURL(resolve(root, "src/atlas-ui-core.ts")).href)),
  ...(await import(pathToFileURL(resolve(root, "src/atlas-map-camera.ts")).href)),
};

async function mount() {
  const dom = new JSDOM("<!doctype html><head></head><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  const style = document.createElement("style");
  style.textContent = readFileSync(resolve(root, "style.css"), "utf8");
  document.head.append(style);
  const source = readUiSource(resolve(root, "index.js"));
  const { renderPanel } = await import("data:text/javascript;base64," + Buffer.from(source + "\nexport {renderPanel};").toString("base64"));
  const { createDefaultSettingsV2, settingsViewV2 } = await import(pathToFileURL(resolve(root, "src/atlas-settings.ts")).href);
  const { DEFAULT_PROMPT_SEGMENTS_TABLE_DELTA } = await import(pathToFileURL(resolve(root, "src/atlas-api-client.ts")).href);
  return { dom, renderPanel, createDefaultSettingsV2, settingsViewV2, DEFAULT_PROMPT_SEGMENTS_TABLE_DELTA };
}

function tick(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

test('Q03 SQL editor displays editable SQL defaults and explicitly copies a legacy preset without activating it', async () => {
  const { dom, renderPanel, createDefaultSettingsV2, settingsViewV2 } = await mount();
  const { applySettingsCommand } = await import('../src/atlas-settings.ts');
  let settings = createDefaultSettingsV2();
  const source = { id:'old', name:'旧作者预设', systemPrompt:'只输出 <atlasEdit>', updatedAt:1 };
  settings = {...settings, promptPresets:[source]};
  const snapshot = JSON.stringify(source);
  const state = { page:'progression', panelOpen:true, receipts:[], serviceStatus:'online', mode:'online', chatId:'sql-editor',
    stateData:{ chatId:'sql-editor', worldId:'sql-editor', sqlModeEnabled:true, currentTime:0, map:{points:[]}, regions:[], npcDirectory:[], objectDirectory:[] } };
  const core = {getState:()=>state,setPanelOpen:()=>{},refresh:async()=>{}};
  const api = {request:async(method,path,body)=>{
    if (body?.action) {
      const next = applySettingsCommand(settings,body,{now:()=>2,makeId:()=> 'sql-draft'});
      assert.equal(next.ok,true); settings=next.settings;
    }
    return {status:200,body:{ok:true,data:settingsViewV2(settings)}};
  }};
  const container=document.createElement('div'); document.body.append(container);
  renderPanel(core,container,api,{read:async()=>null},CORE_MOD_KEYS); await tick();
  assert.ok(container.querySelector('[aria-label="第 1 段正文"]').value.includes('世界状态维护器'));
  assert.equal(container.querySelector('[aria-label="第 1 段正文"]').readOnly,false);
  const select=container.querySelector('.aw-prompt-selector select'); select.value='old';
  select.dispatchEvent(new dom.window.Event('change',{bubbles:true})); await tick();
  [...container.querySelectorAll('button')].find(b=>b.textContent==='创建 SQL 兼容草稿').click(); await tick();
  assert.equal(settings.activePromptPresetId,'old'); assert.equal(JSON.stringify(settings.promptPresets[0]),snapshot);
  assert.equal(settings.promptPresets[1].segments.at(-1).enabled,false);
  assert.ok(container.textContent.includes('请检查条目后'));
});

test("R02: 新建草稿立即可编辑；保存后 createdId 绑定，再存为覆盖", async () => {
  const { dom, renderPanel, createDefaultSettingsV2, settingsViewV2, DEFAULT_PROMPT_SEGMENTS_TABLE_DELTA } = await mount();
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
  renderPanel(core, container, api, { read: async () => null }, { ...CORE_MOD_KEYS, ...view, builtInPrompt: { segments: DEFAULT_PROMPT_SEGMENTS_TABLE_DELTA, systemPrompt: DEFAULT_PROMPT_SEGMENTS_TABLE_DELTA[0].content } });
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
  const { dom, renderPanel, createDefaultSettingsV2, settingsViewV2, DEFAULT_PROMPT_SEGMENTS_TABLE_DELTA } = await mount();
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
  renderPanel(core, container, api, { read: async () => null }, { ...CORE_MOD_KEYS, ...view, builtInPrompt: { segments: DEFAULT_PROMPT_SEGMENTS_TABLE_DELTA, systemPrompt: DEFAULT_PROMPT_SEGMENTS_TABLE_DELTA[0].content } });
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

function progressionState(chatId) {
  return {
    page: "progression", panelOpen: true, receipts: [], serviceStatus: "online",
    mode: "online", chatId,
    stateData: { chatId, worldId: null, worldName: "", currentTime: 0,
      currentLocationId: null, map: { points: [] }, regions: [], npcDirectory: [], objectDirectory: [] },
  };
}

async function promptEditorFixture(presets = []) {
  const mounted = await mount();
  const { applySettingsCommand } = await import("../src/atlas-settings.ts");
  let settings = { ...mounted.createDefaultSettingsV2(), promptPresets: presets, activePromptPresetId: presets[0]?.id ?? null };
  const commands = [];
  const state = progressionState("prompt-structure-ui");
  const core = { getState: () => state, setPage: () => {}, setPanelOpen: () => {}, refresh: async () => {} };
  const api = { request: async (_method, _path, body) => {
    if (body?.action) {
      commands.push(body);
      const result = applySettingsCommand(settings, body);
      if (!result.ok) return { status: 400, body: result };
      settings = result.settings;
    }
    return { status: 200, body: { ok: true, data: mounted.settingsViewV2(settings) } };
  } };
  const container = document.createElement("div"); document.body.append(container);
  mounted.renderPanel(core, container, api, { read: async () => null }, { ...CORE_MOD_KEYS, ...mounted.settingsViewV2(settings) });
  await tick();
  return { ...mounted, container, commands, getSettings: () => settings };
}

test("条目编辑器前置，修改角色与正文、复制、排序和删除后保存保留停用及保护字段", async () => {
  const { dom, container, getSettings } = await promptEditorFixture([{ id: "editable", name: "可编辑", systemPrompt: "", segments: [
    { role: "system", name: "规则", content: "原规则", mainSlot: "A" },
    { role: "user", name: "备用", content: "隐藏内容", enabled: false, deletable: false },
  ] }]);
  const query = (label) => container.querySelector(`[aria-label="${label}"]`);
  const editor = query("提示词条目编辑器");
  assert.equal(editor.parentElement.firstElementChild, editor);
  assert.equal(query("启用第 2 段").checked, false);
  assert.equal(query("删除第 2 段").disabled, true);
  const role = query("第 1 段角色"); role.value = "assistant"; role.dispatchEvent(new dom.window.Event("change"));
  const body = query("第 1 段正文"); body.value = "新规则 $8"; body.dispatchEvent(new dom.window.Event("input"));
  const name = query("第 1 段栏位名称"); name.value = "已修改"; name.dispatchEvent(new dom.window.Event("input"));
  query("复制第 1 段").click();
  assert.equal(query("第 2 段正文").value, "新规则 $8");
  query("上移第 2 段").click();
  assert.equal(query("第 1 段栏位名称").value, "已修改 副本");
  query("删除第 1 段").click();
  query("保存当前提示词预设").click(); await tick();
  assert.deepEqual(getSettings().promptPresets[0].segments, [
    { role: "assistant", name: "已修改", content: "新规则 $8", mainSlot: "A" },
    { role: "user", name: "备用", content: "隐藏内容", enabled: false, deletable: false },
  ]);
  // 保存重建编辑器之后开关仍正确；另存为不会把停用条目重新启用。
  assert.equal(query("启用第 2 段").checked, false);
  dom.window.prompt = () => "条目副本";
  query("以新名称保存提示词副本").click(); await tick();
  assert.equal(getSettings().promptPresets[1].segments[1].enabled, false);
  assert.equal(getSettings().promptPresets[1].segments[1].deletable, false);
});

test("每段可上方或下方插入，角色和顺序在保存后保留", async () => {
  const { dom, container, getSettings } = await promptEditorFixture([{ id: "editable", name: "可编辑", systemPrompt: "", segments: [
    { role: "system", name: "规则", content: "系统规则" },
    { role: "user", name: "行动", content: "用户行动" },
  ] }]);
  const query = (label) => container.querySelector(`[aria-label="${label}"]`);
  query("在第 2 段上方插入提示词").click();
  assert.equal(query("第 2 段角色").value, "system");
  const role = query("第 2 段角色");
  role.value = "assistant"; role.dispatchEvent(new dom.window.Event("change"));
  const body = query("第 2 段正文");
  body.value = "中间回执"; body.dispatchEvent(new dom.window.Event("input"));
  query("在第 3 段下方插入提示词").click();
  const tail = query("第 4 段正文");
  tail.value = "收尾"; tail.dispatchEvent(new dom.window.Event("input"));
  query("保存当前提示词预设").click(); await tick();
  assert.deepEqual(getSettings().promptPresets[0].segments.map((s) => [s.role, s.content]), [
    ["system", "系统规则"], ["assistant", "中间回执"], ["user", "用户行动"], ["system", "收尾"],
  ]);
  dom.window.close();
});

test("shujuku 多预设文件先载入可编辑草稿，选择并保存仅创建所选预设且不激活", async () => {
  const { dom, container, commands, getSettings } = await promptEditorFixture();
  const fileText = JSON.stringify([{ name: "外部甲", promptGroup: [{ role: "SYSTEM", content: "甲规则" }] },
    { name: "外部乙", promptGroup: [{ role: "USER", content: "乙规则" }, { role: "assistant", content: "乙备用", enabled: false }] }]);
  const previousReader = globalThis.FileReader;
  globalThis.FileReader = class { readAsText() { this.result = fileText; this.onload(); } };
  try {
    dom.window.confirm = () => true;
    const fileInput = container.querySelector('[aria-label="提示词预设 JSON 文件"]');
    Object.defineProperty(fileInput, "files", { value: [{ size: Buffer.byteLength(fileText) }] });
    fileInput.dispatchEvent(new dom.window.Event("change")); await tick();
    assert.equal(commands.length, 0, "载入不写设置");
    assert.equal(container.querySelector('[aria-label="提示词名称"]').readOnly, false);
    const candidates = container.querySelector('[aria-label="选择文件中的待导入预设"]');
    assert.equal(candidates.options.length, 2);
    candidates.value = "1"; candidates.dispatchEvent(new dom.window.Event("change")); await tick();
    assert.equal(container.querySelector('[aria-label="提示词名称"]').value, "外部乙");
    assert.equal(container.querySelector('[aria-label="启用第 2 段"]').checked, false);
    assert.match(container.textContent, /<atlasEdit>/);
    container.querySelector('[aria-label="保存当前提示词预设"]').click(); await tick();
    assert.equal(getSettings().promptPresets.length, 1);
    assert.equal(getSettings().promptPresets[0].name, "外部乙");
    assert.equal(getSettings().activePromptPresetId, null);
    assert.equal(commands.some((command) => command.action === "prompt.activate"), false);
  } finally { globalThis.FileReader = previousReader; }
});

test("内置默认首次载入为可选条目；编辑后保存并自动启用副本", async () => {
  const { dom, renderPanel, createDefaultSettingsV2, settingsViewV2 } = await mount();
  let settings = settingsViewV2(createDefaultSettingsV2());
  const commands = [];
  let finishGet;
  const api = { request: (method, _path, body) => {
    if (method === "GET") return new Promise((resolve) => { finishGet = resolve; });
    commands.push(body);
    if (body.action === "prompt.save") settings = { ...settings, promptPresets: [{ id: "custom-default", ...body.preset }] };
    if (body.action === "prompt.activate") settings = { ...settings, activePromptPresetId: body.id };
    return Promise.resolve({ status: 200, body: { ok: true, data: settings } });
  } };
  const state = progressionState("first-load");
  const core = { getState: () => state, setPage: () => {}, setPanelOpen: () => {}, refresh: async () => {} };
  const container = document.createElement("div");
  document.body.append(container);
  renderPanel(core, container, api, { read: async () => null }, { ...CORE_MOD_KEYS, ...settings });
  assert.match(container.textContent, /正在读取提示词与设置/);
  assert.equal(container.querySelectorAll('[aria-label^="第 "][aria-label$=" 段正文"]').length, 0);
  finishGet({ status: 200, body: { ok: true, data: settings } });
  await tick();
  const rows = container.querySelectorAll(".aw-seg-rows textarea");
  assert.equal(rows.length, settings.builtInPrompt.segments.length);
  assert.equal(rows[0].value, settings.builtInPrompt.segments[0].content);
  assert.equal(rows[0].readOnly, false);
  assert.equal(container.querySelector('[aria-label="选择提示词预设（选中即设为当前使用）"]').value, "builtin-default");
  const enabled = container.querySelector('[aria-label="启用第 3 段"]');
  enabled.checked = false;
  enabled.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  const role = container.querySelector('[aria-label="第 2 段角色"]');
  role.value = "system";
  role.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  container.querySelector('[aria-label="保存当前提示词预设"]').click();
  await tick();
  assert.deepEqual(commands.map((command) => command.action), ["prompt.save", "prompt.activate"]);
  assert.equal(commands[0].preset.segments[2].enabled, false);
  assert.equal(commands[0].preset.segments[1].role, "system");
  assert.equal(settings.activePromptPresetId, "custom-default");
  assert.equal(container.querySelector('[aria-label="选择提示词预设（选中即设为当前使用）"]').value, "custom-default");
});

test("R02: first load selects the saved preset and a failed activation restores the selection", async () => {
  const { dom, renderPanel, createDefaultSettingsV2, settingsViewV2 } = await mount();
  const saved = { id: "old-preset", name: "旧预设", systemPrompt: "",
    segments: [{ role: "assistant", name: "确认", content: "保留的旧内容" }], updatedAt: 1 };
  const settings = settingsViewV2({ ...createDefaultSettingsV2(),
    promptPresets: [saved], activePromptPresetId: saved.id });
  const state = progressionState("saved-first-load");
  const core = { getState: () => state, setPage: () => {}, setPanelOpen: () => {}, refresh: async () => {} };
  const api = { request: async (method) => method === "GET"
    ? { status: 200, body: { ok: true, data: settings } }
    : { status: 500, body: { ok: false, error: { message: "保存失败" } } } };
  const container = document.createElement("div");
  document.body.append(container);
  renderPanel(core, container, api, { read: async () => null }, { ...CORE_MOD_KEYS, ...settings });
  await tick();
  assert.equal(container.querySelector('[aria-label="提示词名称"]').value, saved.name);
  assert.equal(container.querySelector('[aria-label="第 1 段正文"]').value, saved.segments[0].content);
  const select = container.querySelector('[aria-label="选择提示词预设（选中即设为当前使用）"]');
  select.value = "builtin-default";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await tick();
  assert.equal(container.querySelector('[aria-label="选择提示词预设（选中即设为当前使用）"]').value, saved.id);
  assert.equal(container.querySelector('[aria-label="第 1 段正文"]').value, saved.segments[0].content);
  assert.match(container.textContent, /保存失败/);
});

test("R02: failed initial settings load offers retry without showing a false builtin editor", async () => {
  const { renderPanel, createDefaultSettingsV2, settingsViewV2 } = await mount();
  const settings = settingsViewV2(createDefaultSettingsV2());
  let reads = 0;
  const api = { request: async () => (++reads === 1)
    ? { status: 500, body: { ok: false, error: { message: "暂不可用" } } }
    : { status: 200, body: { ok: true, data: settings } } };
  const state = progressionState("retry-first-load");
  const core = { getState: () => state, setPage: () => {}, setPanelOpen: () => {}, refresh: async () => {} };
  const container = document.createElement("div");
  document.body.append(container);
  renderPanel(core, container, api, { read: async () => null }, { ...CORE_MOD_KEYS, ...settings });
  await tick();
  assert.match(container.textContent, /暂不可用/);
  assert.equal(container.querySelectorAll(".aw-seg-rows textarea").length, 0);
  [...container.querySelectorAll("button")].find((button) => button.textContent === "重试读取设置").click();
  await tick();
  assert.equal(reads, 2);
  assert.equal(container.querySelectorAll(".aw-seg-rows textarea").length, settings.builtInPrompt.segments.length);
});


test("R02: network failure while saving leaves the editable prompt draft intact", async () => {
  const { dom, renderPanel, createDefaultSettingsV2, settingsViewV2 } = await mount();
  const settings = settingsViewV2(createDefaultSettingsV2());
  const state = progressionState("network-save");
  const core = { getState: () => state, setPage: () => {}, setPanelOpen: () => {}, refresh: async () => {} };
  const api = { request: async (method) => {
    if (method === "PUT") throw new Error("network secret should not enter diagnostics");
    return { status: 200, body: { ok: true, data: settings } };
  } };
  const container = document.createElement("div");
  document.body.append(container);
  renderPanel(core, container, api, { read: async () => null }, { ...CORE_MOD_KEYS, ...settings });
  await tick();
  container.querySelector('[aria-label="新建提示词预设"]').click();
  await tick();
  const name = container.querySelector('[aria-label="提示词名称"]');
  name.value = "保留我的草稿";
  name.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const body = container.querySelector('[aria-label="系统提示词正文"]');
  body.value = "草稿正文";
  body.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  container.querySelector('[aria-label="保存当前提示词预设"]').click();
  await tick();
  assert.equal(container.querySelector('[aria-label="提示词名称"]').value, "保留我的草稿");
  assert.equal(container.querySelector('[aria-label="系统提示词正文"]').value, "草稿正文");
  assert.match(container.textContent, /草稿仍保留/);
});
test("R06: current-world inspection renders the read-only repair report without applying changes", async () => {
  const { renderPanel, createDefaultSettingsV2, settingsViewV2 } = await mount();
  const settings = settingsViewV2(createDefaultSettingsV2());
  const state = progressionState("legacy-chat");
  state.stateData.worldId = "legacy-world";
  const calls = [];
  const report = {
    structuralFingerprint: true, fullFingerprint: false, reason: "坐标已编辑",
    bindingPointId: "1", ledgerPointId: "2", confirmedPointId: "2", eventCount: 3,
    characterPositions: [], orphanPointIds: ["old-point"], orphanSubmapIds: [],
    fingerprintReasons: ["起点坐标不同"], canApply: false,
  };
  const api = { request: async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === "/scene/repair-start") return { status: 200, body: { ok: true, data: { status: "preview", report } } };
    return { status: 200, body: { ok: true, data: settings } };
  } };
  const core = { getState: () => state, setPage: () => {}, setPanelOpen: () => {}, refresh: async () => {} };
  const container = document.createElement("div");
  document.body.append(container);
  renderPanel(core, container, api, { read: async () => null }, { ...CORE_MOD_KEYS, ...settings });
  await tick();
  container.querySelector('[aria-label="只读检查旧起点、账本位置、人物与孤立子图"]').click();
  await tick();
  assert.deepEqual(calls.filter((call) => call.path === "/scene/repair-start"), [
    { method: "POST", path: "/scene/repair-start", body: { chatId: "legacy-chat", apply: false } },
  ]);
  assert.match(container.textContent, /坐标已编辑/);
  assert.match(container.textContent, /old-point/);
  assert.equal([...container.querySelectorAll("button")].some((button) => button.textContent === "下载备份并退役旧起点"), false);
});
