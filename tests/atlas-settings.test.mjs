/**
 * atlas-settings.test.mjs — ATLAS-18 设置纯层（先红后绿）。
 *
 * 口径来源：开发规格README.md 第 0 节（0.4 数据模型 / 0.5 迁移 / 0.6 命令 / 0.11 测试矩阵）。
 * 本文件只测纯函数层：迁移、命令 reducer、脱敏视图、运行时组合。
 * 任何断言都不得依赖 UI 或真实网络。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ATLAS_SETTINGS_SCHEMA_VERSION,
  BUILTIN_PROMPT_PRESET_ID,
  createDefaultSettingsV2,
  migrateAtlasSettings,
  applySettingsCommand,
  settingsViewV2,
  resolveWorldTurnPreset,
  normalizeConnectionMode,
  normalizeApiFormat,
  normalizePromptPostProcessing,
} from "../src/atlas-settings.ts";
import { DEFAULT_WORLD_TURN_SYSTEM_PROMPT } from "../src/atlas-api-client.ts";

const NOW = 1_700_000_000_000;
const TEST_KEY = "sk-test-super-secret-1234";

/** 稳定 ID 依赖注入：同一 (kind,index,fingerprint) 永远同 ID（模拟重启后再迁移）。 */
function testDeps() {
  return {
    now: () => NOW,
    legacyIdFor: (kind, index, fingerprint) =>
      `legacy-${kind}-${index}-${String(fingerprint).slice(0, 8).toLowerCase()}`,
  };
}

function connection(overrides = {}) {
  return {
    name: "渠道A",
    endpoint: "https://api.example.com/v1/chat/completions",
    model: "gpt-4o-mini",
    apiKey: TEST_KEY,
    maxTokens: 1024,
    temperature: 0.7, topP: 0.95,
    timeoutMs: 30_000,
    ...overrides,
  };
}

/** v1 夹具：活动组合预设 + 预设库 + majorEvent 旧数据。 */
function v1Fixture() {
  return {
    schemaVersion: 1,
    worldTurn: connection({ name: "活动", systemPrompt: "你是世界推演引擎。" }),
    majorEvent: connection({ name: "重大", endpoint: "https://api.example.com/other/chat/completions" }),
    presetLibrary: {
      worldTurn: [
        connection({ name: "活动", systemPrompt: "你是世界推演引擎。" }),
        connection({ name: "备用渠道", endpoint: "https://api.example.com/v1/chat/completions", apiKey: "sk-other" }),
      ],
      majorEvent: [],
    },
    autoCommit: true,
    rpmLimit: 30,
  };
}

// ---------------------------------------------------------------------------
// 0.4 数据模型 + 默认值
// ---------------------------------------------------------------------------

test("默认设置：schemaVersion 2、两库为空、两个活动引用为 null、runtime 默认值", () => {
  const s = createDefaultSettingsV2();
  assert.equal(s.schemaVersion, ATLAS_SETTINGS_SCHEMA_VERSION);
  assert.equal(ATLAS_SETTINGS_SCHEMA_VERSION, 2);
  assert.deepEqual(s.apiPresets, []);
  assert.deepEqual(s.promptPresets, []);
  assert.equal(s.activeApiPresetId, null);
  assert.equal(s.activePromptPresetId, null);
  assert.equal(s.autoCommit, true);
  assert.equal(s.rpmLimit, 30);
});

// ---------------------------------------------------------------------------
// 0.5 v1 → v2 无损迁移
// ---------------------------------------------------------------------------

test("迁移：活动组合预设拆成「API 连接 + 提示词」两库并正确指向活动项", () => {
  const { settings, diagnostics } = migrateAtlasSettings(v1Fixture(), testDeps());
  assert.equal(settings.schemaVersion, 2);
  // 活动连接（含库内同名项）去重后应只剩两条不同连接指纹
  assert.equal(settings.apiPresets.length, 2, "重复指纹的连接被去重");
  assert.equal(settings.promptPresets.length, 1, "同一提示词正文只存一条");
  const active = settings.apiPresets.find((p) => p.id === settings.activeApiPresetId);
  assert.ok(active, "活动 API 引用有效");
  assert.equal(active.name, "活动");
  assert.equal(active.endpoint, "https://api.example.com/v1/chat/completions");
  assert.equal(active.model, "gpt-4o-mini");
  assert.equal(active.apiKey, TEST_KEY, "迁移保留密钥（迁移是纯数据变换）");
  const activePrompt = settings.promptPresets.find((p) => p.id === settings.activePromptPresetId);
  assert.equal(activePrompt.systemPrompt, "你是世界推演引擎。", "活动提示词指向迁移出的提示词预设");
  assert.equal(diagnostics.skipped, 0, "合法夹具无跳过项");
});

test("迁移：同名不同连接不覆盖（名称顺延编号）；每个连接保留自己的字段", () => {
  const raw = {
    schemaVersion: 1,
    worldTurn: null,
    majorEvent: null,
    presetLibrary: {
      worldTurn: [
        connection({ name: "同名", endpoint: "https://a.example.com/v1/chat/completions" }),
        connection({ name: "同名", endpoint: "https://b.example.com/v1/chat/completions" }),
      ],
      majorEvent: [],
    },
    autoCommit: true,
    rpmLimit: 30,
  };
  const { settings } = migrateAtlasSettings(raw, testDeps());
  assert.equal(settings.apiPresets.length, 2, "两条都保留");
  const names = settings.apiPresets.map((p) => p.name).sort();
  assert.deepEqual(names, ["同名", "同名 (2)"], "第二个同名连接顺延编号");
  const endpoints = settings.apiPresets.map((p) => p.endpoint).sort();
  assert.deepEqual(endpoints, ["https://a.example.com/v1/chat/completions", "https://b.example.com/v1/chat/completions"]);
});

test("迁移：空提示词 → 不生成提示词预设且活动提示词为 null（= 内置默认）", () => {
  const raw = {
    schemaVersion: 1,
    worldTurn: connection({ name: "无提示词", systemPrompt: "   " }),
    majorEvent: null,
    presetLibrary: { worldTurn: [], majorEvent: [] },
    autoCommit: true,
    rpmLimit: 30,
  };
  const { settings } = migrateAtlasSettings(raw, testDeps());
  assert.equal(settings.promptPresets.length, 0, "空白提示词不落库");
  assert.equal(settings.activePromptPresetId, null, "活动提示词回退内置默认");
  assert.ok(settings.activeApiPresetId, "活动 API 仍然有效");
});

test("迁移：majorEvent 旧数据只进 legacyMajorEvent，不进入运行时视图", () => {
  const { settings } = migrateAtlasSettings(v1Fixture(), testDeps());
  assert.ok(settings.legacyMajorEvent !== undefined, "旧数据被兼容保留");
  const view = settingsViewV2(settings);
  assert.equal(Object.prototype.hasOwnProperty.call(view, "majorEvent"), false, "视图不暴露 majorEvent");
  assert.equal(Object.prototype.hasOwnProperty.call(view, "legacyMajorEvent"), false, "视图不暴露 legacyMajorEvent");
  assert.equal(resolveWorldTurnPreset(settings).model, "gpt-4o-mini", "运行时只用 worldTurn 组合");
});

test("迁移：同一份 v1 夹具两次迁移结果深相等（稳定 ID，重启可复现）", () => {
  const a = migrateAtlasSettings(v1Fixture(), testDeps()).settings;
  const b = migrateAtlasSettings(v1Fixture(), testDeps()).settings;
  assert.deepEqual(a, b);
  assert.ok(a.apiPresets.every((p) => /^[A-Za-z0-9_-]{1,128}$/.test(p.id)), "ID 形状合法");
});

test("迁移：非法条目跳过并计数，诊断不泄漏密钥与正文", () => {
  const raw = {
    schemaVersion: 1,
    worldTurn: null,
    majorEvent: null,
    presetLibrary: {
      worldTurn: [
        { name: "", endpoint: "https://x.example.com", model: "m", apiKey: "sk-leak-me", maxTokens: 1, temperature: 0, topP: 0.95, timeoutMs: 1000 },
        connection({ name: "合法", apiKey: "sk-leak-me-2" }),
      ],
      majorEvent: [],
    },
    autoCommit: true,
    rpmLimit: 30,
  };
  const { settings, diagnostics } = migrateAtlasSettings(raw, testDeps());
  assert.equal(settings.apiPresets.length, 1, "非法条目被跳过");
  assert.equal(diagnostics.skipped, 1, "跳过数量被记录");
  const dump = JSON.stringify(diagnostics);
  assert.ok(!dump.includes("sk-leak-me"), "诊断不含密钥");
});

// ---------------------------------------------------------------------------
// 0.6 设置命令（含 Key 语义）
// ---------------------------------------------------------------------------

function withApi(settings, name = "渠道A") {
  const r = applySettingsCommand(settings, {
    action: "api.save",
    preset: {
      name,
      endpoint: "https://api.example.com/v1/chat/completions",
      model: "m1",
      maxTokens: 1024,
      temperature: 0.7, topP: 0.95,
      timeoutMs: 30_000,
    },
    apiKeyMode: "replace",
    apiKey: TEST_KEY,
  }, testDeps());
  assert.equal(r.ok, true, r.ok ? "" : r.message);
  return r.settings;
}

test("api.save：新建用 keep 必须失败；新建不自动激活", () => {
  const base = createDefaultSettingsV2();
  const bad = applySettingsCommand(base, {
    action: "api.save",
    preset: { name: "x", endpoint: "https://api.example.com/v1/chat/completions", model: "m", maxTokens: 10, temperature: 0, topP: 0.95, timeoutMs: 1000 },
    apiKeyMode: "keep",
  }, testDeps());
  assert.equal(bad.ok, false, "新建使用 keep 必须拒绝");
  assert.equal(bad.code, "INVALID_PAYLOAD");

  const created = withApi(base);
  assert.equal(created.apiPresets.length, 1);
  assert.equal(created.activeApiPresetId, null, "保存 ≠ 激活");
});

test("api.save：Key 的 keep / replace / clear 三路径", () => {
  let s = withApi(createDefaultSettingsV2());
  const id = s.apiPresets[0].id;

  const kept = applySettingsCommand(s, {
    action: "api.save",
    preset: { id, name: "渠道A改", endpoint: "https://api.example.com/v1/chat/completions", model: "m2", maxTokens: 512, temperature: 0.2, topP: 0.95, timeoutMs: 20_000 },
    apiKeyMode: "keep",
  }, testDeps());
  assert.equal(kept.ok, true);
  s = kept.settings;
  assert.equal(s.apiPresets[0].apiKey, TEST_KEY, "keep 沿用旧密钥");
  assert.equal(s.apiPresets[0].model, "m2", "其余字段被更新");
  assert.equal(s.apiPresets[0].id, id, "ID 稳定（重命名不换 ID）");

  const replaced = applySettingsCommand(s, {
    action: "api.save",
    preset: { id, name: "渠道A改", endpoint: "https://api.example.com/v1/chat/completions", model: "m2", maxTokens: 512, temperature: 0.2, topP: 0.95, timeoutMs: 20_000 },
    apiKeyMode: "replace",
    apiKey: "sk-new-key",
  }, testDeps());
  assert.equal(replaced.ok, true);
  assert.equal(replaced.settings.apiPresets[0].apiKey, "sk-new-key", "replace 覆盖密钥");

  const cleared = applySettingsCommand(replaced.settings, {
    action: "api.save",
    preset: { id, name: "渠道A改", endpoint: "https://api.example.com/v1/chat/completions", model: "m2", maxTokens: 512, temperature: 0.2, topP: 0.95, timeoutMs: 20_000 },
    apiKeyMode: "clear",
  }, testDeps());
  assert.equal(cleared.ok, true);
  assert.equal(cleared.settings.apiPresets[0].apiKey, "", "clear 落到空字符串");
});

test("api.activate / api.delete：活动引用清理规则", () => {
  let s = withApi(createDefaultSettingsV2(), "A");
  s = withApi(s, "B");
  const [a, b] = s.apiPresets;

  const activated = applySettingsCommand(s, { action: "api.activate", id: a.id }, testDeps());
  assert.equal(activated.ok, true);
  assert.equal(activated.settings.activeApiPresetId, a.id);

  const missing = applySettingsCommand(activated.settings, { action: "api.activate", id: "nope" }, testDeps());
  assert.equal(missing.ok, false, "激活不存在的 ID 必须失败");
  assert.deepEqual(missing.settings ?? activated.settings, activated.settings, "失败不改变设置");

  const delOther = applySettingsCommand(activated.settings, { action: "api.delete", id: b.id }, testDeps());
  assert.equal(delOther.ok, true);
  assert.equal(delOther.settings.activeApiPresetId, a.id, "删非活动项不影响活动引用");

  const delActive = applySettingsCommand(delOther.settings, { action: "api.delete", id: a.id }, testDeps());
  assert.equal(delActive.ok, true);
  assert.equal(delActive.settings.activeApiPresetId, null, "删活动项清空引用");
  assert.equal(delActive.settings.apiPresets.length, 0);
});

test("提示词命令：保存 / 激活 / 删除活动项回退内置默认；内置默认不可删改", () => {
  const base = createDefaultSettingsV2();
  const saved = applySettingsCommand(base, {
    action: "prompt.save",
    preset: { name: "严厉推演", systemPrompt: "只输出 JSON。" },
  }, testDeps());
  assert.equal(saved.ok, true);
  const pid = saved.settings.promptPresets[0].id;

  const empty = applySettingsCommand(saved.settings, { action: "prompt.save", preset: { name: "空", systemPrompt: "   " } }, testDeps());
  assert.equal(empty.ok, false, "空提示词不允许保存");

  const activated = applySettingsCommand(saved.settings, { action: "prompt.activate", id: pid }, testDeps());
  assert.equal(activated.ok, true);
  assert.equal(activated.settings.activePromptPresetId, pid);

  const toBuiltin = applySettingsCommand(activated.settings, { action: "prompt.activate", id: null }, testDeps());
  assert.equal(toBuiltin.ok, true);
  assert.equal(toBuiltin.settings.activePromptPresetId, null, "激活内置默认 = null");

  const deleted = applySettingsCommand(activated.settings, { action: "prompt.delete", id: pid }, testDeps());
  assert.equal(deleted.ok, true);
  assert.equal(deleted.settings.activePromptPresetId, null, "删除活动提示词同一次原子写入里回退内置默认");
  assert.equal(deleted.settings.promptPresets.length, 0);

  const overwriteBuiltin = applySettingsCommand(base, {
    action: "prompt.save",
    preset: { id: BUILTIN_PROMPT_PRESET_ID, name: "内置默认", systemPrompt: "偷偷改掉" },
  }, testDeps());
  assert.equal(overwriteBuiltin.ok, false, "内置默认不可覆盖");
  const deleteBuiltin = applySettingsCommand(base, { action: "prompt.delete", id: BUILTIN_PROMPT_PRESET_ID }, testDeps());
  assert.equal(deleteBuiltin.ok, false, "内置默认不可删除");
});

test("两库互不影响：API 命令不动提示词数据，提示词命令不动 API 数据（含密钥）", () => {
  let s = withApi(createDefaultSettingsV2());
  s = applySettingsCommand(s, { action: "prompt.save", preset: { name: "P", systemPrompt: "提示词正文" } }, testDeps()).settings;
  s = applySettingsCommand(s, { action: "prompt.activate", id: s.promptPresets[0].id }, testDeps()).settings;
  const promptsBefore = JSON.parse(JSON.stringify(s.promptPresets));
  const activePromptBefore = s.activePromptPresetId;

  const afterApi = applySettingsCommand(s, { action: "api.activate", id: s.apiPresets[0].id }, testDeps()).settings;
  assert.deepEqual(afterApi.promptPresets, promptsBefore, "API 命令前后提示词库深相等");
  assert.equal(afterApi.activePromptPresetId, activePromptBefore, "API 命令不动活动提示词");

  const apisBefore = JSON.parse(JSON.stringify(afterApi.apiPresets));
  const activeApiBefore = afterApi.activeApiPresetId;
  const afterPrompt = applySettingsCommand(afterApi, {
    action: "prompt.save",
    preset: { id: afterApi.promptPresets[0].id, name: "P", systemPrompt: "改过的正文" },
  }, testDeps()).settings;
  assert.deepEqual(afterPrompt.apiPresets, apisBefore, "提示词命令前后 API 库深相等（含密钥）");
  assert.equal(afterPrompt.activeApiPresetId, activeApiBefore, "提示词命令不动活动 API");
});

test("上限与校验：每库 20 条上限、非法 ID / 超长字段 / 非法参数被拒", () => {
  let s = createDefaultSettingsV2();
  for (let i = 0; i < 20; i += 1) s = withApi(s, `渠道${i}`);
  assert.equal(s.apiPresets.length, 20);
  const overflow = applySettingsCommand(s, {
    action: "api.save",
    preset: { name: "第21条", endpoint: "https://api.example.com/v1/chat/completions", model: "m", maxTokens: 10, temperature: 0, topP: 0.95, timeoutMs: 1000 },
    apiKeyMode: "replace",
    apiKey: "",
  }, testDeps());
  assert.equal(overflow.ok, false, "超过 20 条必须拒绝");

  const base = createDefaultSettingsV2();
  const badId = applySettingsCommand(base, { action: "api.activate", id: "有中文 空格" }, testDeps());
  assert.equal(badId.ok, false, "非法 ID 形状被拒");
  const badTemp = applySettingsCommand(base, {
    action: "api.save",
    preset: { name: "x", endpoint: "https://api.example.com/v1/chat/completions", model: "m", maxTokens: 10, temperature: 9, topP: 0.95, timeoutMs: 1000 },
    apiKeyMode: "replace",
    apiKey: "",
  }, testDeps());
  assert.equal(badTemp.ok, false, "temperature 越界被拒");
  const badRpm = applySettingsCommand(base, { action: "runtime.update", rpmLimit: 0 }, testDeps());
  assert.equal(badRpm.ok, false, "rpmLimit 越界被拒");
  const okRpm = applySettingsCommand(base, { action: "runtime.update", rpmLimit: 60, autoCommit: false }, testDeps());
  assert.equal(okRpm.ok, true);
  assert.equal(okRpm.settings.rpmLimit, 60);
  assert.equal(okRpm.settings.autoCommit, false);
});

test("悬挂引用：v2 数据里活动 API 指向不存在的 ID → 归一为 null，绝不偷切第一条", () => {
  const { settings } = migrateAtlasSettings(v1Fixture(), testDeps());
  const broken = { ...settings, activeApiPresetId: "ghost-id" };
  const view = settingsViewV2(broken);
  assert.equal(view.activeApiPresetId, null, "悬挂引用归一为 null（= 未配置）");
  assert.equal(resolveWorldTurnPreset(broken), null, "运行时不得回退到列表第一条");
});

// ---------------------------------------------------------------------------
// 0.6 GET 脱敏视图 + 运行时组合
// ---------------------------------------------------------------------------

test("GET 视图：明文 Key 回传（0.9.12 作者令照抄 shujuku）；含内置默认提示词全文", () => {
  const s = withApi(createDefaultSettingsV2());
  const view = settingsViewV2(s);
  assert.equal(view.apiPresets[0].apiKey, TEST_KEY, "明文 Key 供编辑器回填 / 测试连接复用");
  assert.equal(view.apiPresets[0].apiFormat, "openai", "协议字段缺省 openai");
  assert.equal(view.schemaVersion, 2);
  assert.equal(view.builtInPrompt.id, BUILTIN_PROMPT_PRESET_ID);
  assert.equal(view.builtInPrompt.readOnly, true);
  assert.equal(view.builtInPrompt.systemPrompt, DEFAULT_WORLD_TURN_SYSTEM_PROMPT, "内置提示词全文可查看");
  assert.deepEqual(view.promptPresets, [], "提示词预设原样返回（本来无密钥）");
});

test("运行时组合：活动 API + 活动提示词 → AtlasApiPreset；无活动 API → null", () => {
  let s = withApi(createDefaultSettingsV2());
  s = applySettingsCommand(s, { action: "api.activate", id: s.apiPresets[0].id }, testDeps()).settings;
  const noPrompt = resolveWorldTurnPreset(s);
  assert.equal(noPrompt.model, s.apiPresets[0].model);
  assert.ok(!noPrompt.systemPrompt || noPrompt.systemPrompt.trim() === "", "未选提示词 = 交给内置默认（不写死正文）");

  s = applySettingsCommand(s, { action: "prompt.save", preset: { name: "P1", systemPrompt: "组合后的提示词" } }, testDeps()).settings;
  s = applySettingsCommand(s, { action: "prompt.activate", id: s.promptPresets[0].id }, testDeps()).settings;
  const combo = resolveWorldTurnPreset(s);
  assert.equal(combo.systemPrompt, "组合后的提示词");
  assert.equal(combo.apiKey, TEST_KEY, "组合结果保留密钥供请求使用");
  assert.equal(combo.endpoint, "https://api.example.com/v1/chat/completions");

  const none = resolveWorldTurnPreset(createDefaultSettingsV2());
  assert.equal(none, null, "未配置活动 API → null（提交时必须报 API_NOT_CONFIGURED，零 fetch）");
});

// ---------------------------------------------------------------------------
// 0.9.13 全抄 shujuku：三连接方式 + 四协议 + 高级字段 roundtrip
// ---------------------------------------------------------------------------

test("normalize 枚举：connectionMode / apiFormat / promptPostProcessing 白名单回退", () => {
  assert.equal(normalizeConnectionMode("main"), "main");
  assert.equal(normalizeConnectionMode("profile"), "profile");
  assert.equal(normalizeConnectionMode("custom"), "custom");
  assert.equal(normalizeConnectionMode("carrier-pigeon"), "custom");
  assert.equal(normalizeConnectionMode(undefined), "custom");

  assert.equal(normalizeApiFormat("claude"), "claude");
  assert.equal(normalizeApiFormat("gemini"), "gemini");
  assert.equal(normalizeApiFormat("openai_responses"), "openai", "shujuku 同款回退：原版酒馆无独立后端");
  assert.equal(normalizeApiFormat("openai"), "openai");
  assert.equal(normalizeApiFormat("nope"), "openai");

  assert.equal(normalizePromptPostProcessing("strict"), "strict");
  assert.equal(normalizePromptPostProcessing("single"), "single");
  assert.equal(normalizePromptPostProcessing("nonsense"), "");
  assert.equal(normalizePromptPostProcessing(undefined), "");
});

test("api.save：main/profile 模式 endpoint 与 model 允许为空；新字段完整落库", () => {
  const base = createDefaultSettingsV2();

  const mainSaved = applySettingsCommand(base, {
    action: "api.save",
    preset: {
      name: "酒馆主API", endpoint: "", model: "", connectionMode: "main",
      maxTokens: 1024, temperature: 0.7, topP: 0.95, timeoutMs: 30_000,
    },
    apiKeyMode: "replace", apiKey: "",
  }, testDeps());
  assert.equal(mainSaved.ok, true, mainSaved.ok ? "" : mainSaved.message);
  const mainPreset = mainSaved.settings.apiPresets[0];
  assert.equal(mainPreset.connectionMode, "main");

  const profileSaved = applySettingsCommand(mainSaved.settings, {
    action: "api.save",
    preset: {
      name: "酒馆连接预设", endpoint: "", model: "", connectionMode: "profile", profileId: "prof-1",
      maxTokens: 1024, temperature: 0.7, topP: 0.95, timeoutMs: 30_000,
      bodyParams: "response_format:\n  type: json_object",
      excludeBodyParams: "top_p, reasoning_effort",
      requestHeaders: "X-Custom-Header: value",
      promptPostProcessing: "strict",
    },
    apiKeyMode: "replace", apiKey: "",
  }, testDeps());
  assert.equal(profileSaved.ok, true, profileSaved.ok ? "" : profileSaved.message);
  const p = profileSaved.settings.apiPresets[1];
  assert.equal(p.connectionMode, "profile");
  assert.equal(p.profileId, "prof-1");
  assert.equal(p.bodyParams, "response_format:\n  type: json_object");
  assert.equal(p.excludeBodyParams, "top_p, reasoning_effort");
  assert.equal(p.requestHeaders, "X-Custom-Header: value");
  assert.equal(p.promptPostProcessing, "strict");

  // settingsViewV2 回传（0.9.12 作者令：Key 明文回传编辑器）
  const view = settingsViewV2(profileSaved.settings);
  const viewPreset = view.apiPresets.find((x) => x.id === p.id);
  assert.equal(viewPreset.connectionMode, "profile");
  assert.equal(viewPreset.profileId, "prof-1");
  assert.equal(viewPreset.bodyParams, p.bodyParams);
  assert.equal(viewPreset.excludeBodyParams, p.excludeBodyParams);
  assert.equal(viewPreset.requestHeaders, p.requestHeaders);
  assert.equal(viewPreset.promptPostProcessing, p.promptPostProcessing);

  // 运行时透传（resolveWorldTurnPreset → callAtlasWorldTurnApi 消费面）
  profileSaved.settings.activeApiPresetId = p.id;
  const runtime = resolveWorldTurnPreset(profileSaved.settings);
  assert.equal(runtime.connectionMode, "profile");
  assert.equal(runtime.profileId, "prof-1");
  assert.equal(runtime.bodyParams, p.bodyParams);
  assert.equal(runtime.promptPostProcessing, "strict");
});

test("api.save：custom 模式仍要求 endpoint 与 model；非法 connectionMode 归一为 custom", () => {
  const base = createDefaultSettingsV2();
  const badEndpoint = applySettingsCommand(base, {
    action: "api.save",
    preset: { name: "x", endpoint: "", model: "m", connectionMode: "custom", maxTokens: 10, temperature: 0, topP: 0.95, timeoutMs: 1000 },
    apiKeyMode: "replace", apiKey: TEST_KEY,
  }, testDeps());
  assert.equal(badEndpoint.ok, false, "custom 模式空 endpoint 必须拒绝");

  // 存储层宽容（shujuku 同款归一）：未知 mode → custom；custom 校验随之生效
  const badMode = applySettingsCommand(base, {
    action: "api.save",
    preset: { name: "x", endpoint: "", model: "m", connectionMode: "carrier-pigeon", maxTokens: 10, temperature: 0, topP: 0.95, timeoutMs: 1000 },
    apiKeyMode: "replace", apiKey: TEST_KEY,
  }, testDeps());
  assert.equal(badMode.ok, false, "未知 mode 归一为 custom 后，空 endpoint 仍须拒绝");

  const tolerated = applySettingsCommand(base, {
    action: "api.save",
    preset: { name: "x", endpoint: "https://a.com/v1", model: "m", connectionMode: "carrier-pigeon", maxTokens: 10, temperature: 0, topP: 0.95, timeoutMs: 1000 },
    apiKeyMode: "replace", apiKey: TEST_KEY,
  }, testDeps());
  assert.equal(tolerated.ok, true, tolerated.ok ? "" : tolerated.message);
  assert.equal(tolerated.settings.apiPresets[0].connectionMode, undefined, "custom 是缺省态：落库省略字段（读取侧 normalize 回 custom）");
});
