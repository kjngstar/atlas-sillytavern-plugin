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
  DEFAULT_WORLD_TURN_PROTOCOL,
  defaultSegmentsForProtocol,
  legacyWorldTurnProtocolNotice,
  migrateAtlasSettings,
  applySettingsCommand,
  normalizeWorldTurnProtocol,
  settingsViewV2,
  sanitizeSettingsV2,
  resolveWorldTurnPreset,
  normalizeConnectionMode,
  normalizeApiFormat,
  normalizePromptPostProcessing,
} from "../src/atlas-settings.ts";
import {
  DEFAULT_PROMPT_SEGMENTS_TABLE_DELTA,
  DEFAULT_WORLD_TURN_SYSTEM_PROMPT,
  TABLE_DELTA_BOOTSTRAP_TASK_CONTENT,
  isTableDeltaProtocolEnabled,
} from "../src/atlas-api-client.ts";

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
  // 0.9.17 shujuku 同款：显式空串 = 未选择保留；缺失/非法 → 默认 strict（强制角色交替）
  assert.equal(normalizePromptPostProcessing(""), "");
  assert.equal(normalizePromptPostProcessing("nonsense"), "strict");
  assert.equal(normalizePromptPostProcessing(undefined), "strict");
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

// ---------------------------------------------------------------------------
// 0.9.16 内容替换规则库：命令 + sanitize 兜底
// ---------------------------------------------------------------------------

test("replace.save/delete/reset：规则增删改 + 恢复预制（预制与手动同库平等）", () => {
  let s = createDefaultSettingsV2();
  assert.ok((s.contentReplaceRules ?? []).length >= 14, "默认带 shujuku 同款预制库");
  assert.ok(s.contentReplaceRules.some((r) => r.start === "<think" && r.enabled !== false), "预制含 think 规则且默认启用");

  // 新增
  const added = applySettingsCommand(s, {
    action: "replace.save",
    preset: { name: "我的规则", start: "<note", end: "</note>", enabled: true },
  }, testDeps());
  assert.equal(added.ok, true, added.ok ? "" : added.message);
  const addedRule = added.settings.contentReplaceRules.at(-1);
  assert.equal(addedRule.name, "我的规则");
  assert.ok(!addedRule.builtin, "手动规则无 builtin 标记");

  // 编辑（改名 + 停用）
  const edited = applySettingsCommand(added.settings, {
    action: "replace.save",
    preset: { id: addedRule.id, name: "我的规则改", start: "<note", end: "</note>", enabled: false },
  }, testDeps());
  assert.equal(edited.ok, true);
  const editedRule = edited.settings.contentReplaceRules.find((r) => r.id === addedRule.id);
  assert.equal(editedRule.name, "我的规则改");
  assert.equal(editedRule.enabled, false);

  // 删除
  const deleted = applySettingsCommand(edited.settings, { action: "replace.delete", id: addedRule.id }, testDeps());
  assert.equal(deleted.ok, true);
  assert.ok(!deleted.settings.contentReplaceRules.some((r) => r.id === addedRule.id));

  // 清空后恢复预制
  let emptied = deleted.settings;
  for (const r of [...emptied.contentReplaceRules]) {
    emptied = applySettingsCommand(emptied, { action: "replace.delete", id: r.id }, testDeps()).settings;
  }
  assert.equal(emptied.contentReplaceRules.length, 0, "全删后为空（尊重用户）");
  const reset = applySettingsCommand(emptied, { action: "replace.reset" }, testDeps());
  assert.equal(reset.ok, true);
  assert.ok(reset.settings.contentReplaceRules.length >= 14, "reset 还原预制库");
});

test("replace.save：非法载荷拒绝；sanitize 旧档缺 contentReplaceRules → 补预制库", () => {
  const s = createDefaultSettingsV2();
  const bad = applySettingsCommand(s, {
    action: "replace.save",
    preset: { name: "", start: "<a", end: "</a>" },
  }, testDeps());
  assert.equal(bad.ok, false, "名称必填");

  const badEnd = applySettingsCommand(s, {
    action: "replace.save",
    preset: { name: "x", start: "<a", end: "" },
  }, testDeps());
  assert.equal(badEnd.ok, false, "结束词必填");

  // 旧档（无 contentReplaceRules 字段）经 sanitize 补预制库；坏条目丢弃不炸库
  const legacyRecord = { schemaVersion: 2, apiPresets: [], promptPresets: [], activeApiPresetId: null, activePromptPresetId: null, autoCommit: true, rpmLimit: 30 };
  const sanitized = sanitizeSettingsV2(legacyRecord, testDeps());
  assert.ok((sanitized.settings.contentReplaceRules ?? []).length >= 14, "字段缺失 → 补预制");

  // 显式空数组 = 用户全删，尊重
  const emptied = sanitizeSettingsV2({ ...legacyRecord, contentReplaceRules: [] }, testDeps());
  assert.deepEqual(emptied.settings.contentReplaceRules, []);

  // junk / 重复 id 丢弃
  const junk = sanitizeSettingsV2({ ...legacyRecord, contentReplaceRules: [{ id: "r1", name: "n", start: "<a", end: "</a>", enabled: true }, "junk", { id: "r1", name: "dup", start: "<b", end: "</b>" }] }, testDeps());
  assert.equal(junk.settings.contentReplaceRules.length, 1, "坏条目与重复 id 被丢弃");
});

// ---------------------------------------------------------------------------
// 0.9.17 chatbox 同款：按连接 System Prompt（可选）——落库 / 清空 / 视图回传 / 运行时优先级
// ---------------------------------------------------------------------------

test("api.save systemPrompt：落库 trim；空白清空；视图回传；超长拒绝", () => {
  const base = createDefaultSettingsV2();
  const saved = applySettingsCommand(base, {
    action: "api.save",
    preset: {
      name: "带提示词连接", endpoint: "https://api.example.com/v1", model: "m1",
      maxTokens: 1024, temperature: 0.7, topP: 0.95, timeoutMs: 30_000,
      systemPrompt: "  你是测试系统提示词。  ",
    },
    apiKeyMode: "replace", apiKey: "",
  }, testDeps());
  assert.equal(saved.ok, true, saved.ok ? "" : saved.message);
  const p = saved.settings.apiPresets[0];
  assert.equal(p.systemPrompt, "你是测试系统提示词。", "保存时 trim");

  // 空白 = 清空覆盖（条目上不再带 systemPrompt）
  const cleared = applySettingsCommand(saved.settings, {
    action: "api.save",
    preset: { ...p, id: p.id, systemPrompt: "   " },
    apiKeyMode: "keep",
  }, testDeps());
  assert.equal(cleared.ok, true, cleared.ok ? "" : cleared.message);
  assert.equal(cleared.settings.apiPresets[0].systemPrompt, undefined, "空白清空后字段省略");

  // 视图回传：空 → ""（编辑器回填不炸）
  const view = settingsViewV2(cleared.settings);
  assert.equal(view.apiPresets[0].systemPrompt, "");

  // 超长（>8000）拒绝
  const tooLong = applySettingsCommand(base, {
    action: "api.save",
    preset: {
      name: "超长", endpoint: "https://api.example.com/v1", model: "m1",
      maxTokens: 1024, temperature: 0.7, topP: 0.95, timeoutMs: 30_000,
      systemPrompt: "x".repeat(8001),
    },
    apiKeyMode: "replace", apiKey: "",
  }, testDeps());
  assert.equal(tooLong.ok, false, "超过 8000 字拒绝");
});

test("resolveWorldTurnPreset systemPrompt 优先级：连接覆盖 > 提示词预设 > 空", () => {
  const base = createDefaultSettingsV2();
  const connSaved = applySettingsCommand(base, {
    action: "api.save",
    preset: {
      name: "连接", endpoint: "https://api.example.com/v1", model: "m1",
      maxTokens: 1024, temperature: 0.7, topP: 0.95, timeoutMs: 30_000,
      systemPrompt: "连接级提示词",
    },
    apiKeyMode: "replace", apiKey: "",
  }, testDeps());
  const promptSaved = applySettingsCommand(connSaved.settings, {
    action: "prompt.save",
    preset: { name: "全局提示词", systemPrompt: "全局提示词预设正文" },
  }, testDeps());
  assert.equal(promptSaved.ok, true);
  const activated = applySettingsCommand(promptSaved.settings, { action: "prompt.activate", id: promptSaved.settings.promptPresets[0].id }, testDeps());
  const withBoth = applySettingsCommand(activated.settings, { action: "api.activate", id: activated.settings.apiPresets[0].id }, testDeps());

  // 连接级覆盖生效
  const runtime1 = resolveWorldTurnPreset(withBoth.settings);
  assert.equal(runtime1.systemPrompt, "连接级提示词", "连接级 System Prompt 优先于提示词预设");

  // 清掉连接级 → 回落提示词预设
  const clearedConn = applySettingsCommand(withBoth.settings, {
    action: "api.save",
    preset: { ...withBoth.settings.apiPresets[0], systemPrompt: "" },
    apiKeyMode: "keep",
  }, testDeps());
  const runtime2 = resolveWorldTurnPreset(clearedConn.settings);
  assert.equal(runtime2.systemPrompt, "全局提示词预设正文", "回落「推进」页活动提示词预设");

  // 预设也清 → 空串兜底（引擎用内置默认）
  const noPrompt = applySettingsCommand(clearedConn.settings, { action: "prompt.activate", id: null }, testDeps());
  const runtime3 = resolveWorldTurnPreset(noPrompt.settings);
  assert.equal(runtime3.systemPrompt, undefined, "两级都空 → 不带 systemPrompt，引擎内置默认兜底");

  // sanitize：旧档无 systemPrompt 不受影响；坏类型忽略
  const sanitized = sanitizeSettingsV2({
    schemaVersion: 2,
    apiPresets: [{ id: "a1", name: "n", endpoint: "https://api.example.com/v1", model: "m", apiKey: "", maxTokens: 1024, temperature: 0.7, topP: 0.95, timeoutMs: 30_000, systemPrompt: 42, updatedAt: NOW }],
    promptPresets: [], activeApiPresetId: "a1", activePromptPresetId: null, autoCommit: true, rpmLimit: 30,
  }, testDeps());
  assert.equal(sanitized.settings.apiPresets[0].systemPrompt, undefined, "非字符串 systemPrompt 丢弃");
  assert.equal(sanitized.diagnostics.apiSkipped, 0, "绝不因 systemPrompt 非法丢整条连接");
});

test("promptPostProcessing 默认 strict（shujuku 同款）：缺失落库补 strict；显式空串保留；运行时据此携带", () => {
  const base = createDefaultSettingsV2();

  // 旧存档条目没有 promptPostProcessing 字段 → sanitize 不炸；视图显示 strict；运行时携带 strict
  const legacy = sanitizeSettingsV2({
    schemaVersion: 2,
    apiPresets: [{ id: "a1", name: "旧连接", endpoint: "https://api.example.com/v1", model: "m", apiKey: "", maxTokens: 1024, temperature: 0.7, topP: 0.95, timeoutMs: 30_000, updatedAt: NOW }],
    promptPresets: [], activeApiPresetId: "a1", activePromptPresetId: null, autoCommit: true, rpmLimit: 30,
  }, testDeps());
  assert.equal(legacy.diagnostics.apiSkipped, 0, "缺字段不丢条目");
  assert.equal(settingsViewV2(legacy.settings).apiPresets[0].promptPostProcessing, "strict", "视图缺省显示严格");
  const runtimeLegacy = resolveWorldTurnPreset(legacy.settings);
  assert.equal(runtimeLegacy.promptPostProcessing, "strict", "旧连接运行时默认带严格角色交替");

  // 显式「未选择」（空串）→ 落库保留空串 → 运行时不携带
  const savedNone = applySettingsCommand(base, {
    action: "api.save",
    preset: { name: "n1", endpoint: "https://api.example.com/v1", model: "m1", maxTokens: 1024, temperature: 0.7, topP: 0.95, timeoutMs: 30_000, promptPostProcessing: "" },
    apiKeyMode: "replace", apiKey: "",
  }, testDeps());
  assert.equal(savedNone.ok, true, savedNone.ok ? "" : savedNone.message);
  assert.equal(savedNone.settings.apiPresets[0].promptPostProcessing, "", "显式未选择保留空串");
  assert.equal(settingsViewV2(savedNone.settings).apiPresets[0].promptPostProcessing, "");
  const runtimeNone = resolveWorldTurnPreset({ ...savedNone.settings, activeApiPresetId: savedNone.settings.apiPresets[0].id });
  assert.equal(runtimeNone.promptPostProcessing, undefined, "未选择 → 请求不携带该字段");

  // 非法值经保存归一为 strict
  const savedJunk = applySettingsCommand(base, {
    action: "api.save",
    preset: { name: "n2", endpoint: "https://api.example.com/v1", model: "m1", maxTokens: 1024, temperature: 0.7, topP: 0.95, timeoutMs: 30_000, promptPostProcessing: "carrier-pigeon" },
    apiKeyMode: "replace", apiKey: "",
  }, testDeps());
  assert.equal(savedJunk.settings.apiPresets[0].promptPostProcessing, "strict", "非法值归一为严格");
});

// ---------------------------------------------------------------------------
// 0.9.18 分段提示词：落库 / 视图 / sanitize / 运行时 promptSegments 与优先级
// ---------------------------------------------------------------------------

test("prompt.save segments：非法角色与空段剔除；正文可空；超 16 段截断；视图与 sanitize 往返", () => {
  const base = createDefaultSettingsV2();
  const manySegments = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `段${i}` }));
  const saved = applySettingsCommand(base, {
    action: "prompt.save",
    preset: {
      name: "分段预设",
      systemPrompt: "",
      segments: [
        { role: "system", content: "第一条" },
        { role: "dragon", content: "非法角色" },
        { role: "user", content: "   " },
        ...manySegments,
      ],
    },
  }, testDeps());
  assert.equal(saved.ok, true, saved.ok ? "" : saved.message);
  const p = saved.settings.promptPresets[0];
  assert.equal(p.segments.length, 16, "剔除非法后截断到 16 段上限");
  assert.equal(p.segments[0].content, "第一条");
  assert.equal(p.systemPrompt, "", "分段模式正文允许为空");

  // 视图回传 + sanitize 往返（结构化克隆模拟落盘重读）
  const view = settingsViewV2(saved.settings);
  assert.equal(view.promptPresets[0].segments.length, 16);
  const sanitized = sanitizeSettingsV2(JSON.parse(JSON.stringify(saved.settings)), testDeps());
  assert.equal(sanitized.settings.promptPresets[0].segments.length, 16, "分段预设经 sanitize 存活");
  assert.equal(sanitized.diagnostics.promptSkipped, 0, "不丢条目");

  // 两者都空 → 拒绝
  const bothEmpty = applySettingsCommand(base, {
    action: "prompt.save",
    preset: { name: "空空", systemPrompt: "  ", segments: [{ role: "user", content: " " }] },
  }, testDeps());
  assert.equal(bothEmpty.ok, false, "正文与有效分段都空拒绝");
});

test("resolveWorldTurnPreset：segments → promptSegments；连接级 systemPrompt 仍最高优先；单条旧预设不回归", () => {
  const base = createDefaultSettingsV2();
  const segSaved = applySettingsCommand(base, {
    action: "prompt.save",
    preset: {
      name: "分段预设",
      systemPrompt: "",
      segments: [{ role: "system", content: "分段系统指令" }, { role: "user", content: "状态：{{worldState}}" }],
    },
  }, testDeps());
  assert.equal(segSaved.ok, true);
  const promptId = segSaved.settings.promptPresets[0].id;
  const connSaved = applySettingsCommand(segSaved.settings, {
    action: "api.save",
    preset: { name: "c", endpoint: "https://api.example.com/v1", model: "m", maxTokens: 1024, temperature: 0.7, topP: 0.95, timeoutMs: 30_000 },
    apiKeyMode: "replace", apiKey: "",
  }, testDeps());
  const activated = applySettingsCommand(connSaved.settings, { action: "prompt.activate", id: promptId }, testDeps());
  const withApi = applySettingsCommand(activated.settings, { action: "api.activate", id: activated.settings.apiPresets[0].id }, testDeps());

  // 分段预设 → 运行时 promptSegments（不带 systemPrompt）
  const runtimeSeg = resolveWorldTurnPreset(withApi.settings);
  assert.equal(runtimeSeg.promptSegments.length, 2, "分段预设运行时走 promptSegments");
  assert.equal(runtimeSeg.promptSegments[0].content, "分段系统指令");
  assert.equal(runtimeSeg.systemPrompt, undefined, "分段模式不带单条 systemPrompt");

  // 连接级 systemPrompt 覆盖分段（与 0.9.17 优先级一致）
  const overrideSaved = applySettingsCommand(withApi.settings, {
    action: "api.save",
    preset: { ...withApi.settings.apiPresets[0], systemPrompt: "连接级覆盖" },
    apiKeyMode: "keep",
  }, testDeps());
  const runtimeOverride = resolveWorldTurnPreset(overrideSaved.settings);
  assert.equal(runtimeOverride.systemPrompt, "连接级覆盖", "连接级覆盖最高优先");
  assert.equal(runtimeOverride.promptSegments, undefined, "被覆盖时不下发分段");

  // 旧单条预设（无 segments）→ systemPrompt 透传，行为不回归（先清掉连接级覆盖）
  const singleSaved = applySettingsCommand(overrideSaved.settings, {
    action: "api.save",
    preset: { ...overrideSaved.settings.apiPresets[0], systemPrompt: "" },
    apiKeyMode: "keep",
  }, testDeps());
  const singlePrompt = applySettingsCommand(singleSaved.settings, {
    action: "prompt.save",
    preset: { name: "单条预设", systemPrompt: "单条正文" },
  }, testDeps());
  const singleId = singlePrompt.settings.promptPresets.find((p) => p.name === "单条预设").id;
  const singleAct = applySettingsCommand(singlePrompt.settings, { action: "prompt.activate", id: singleId }, testDeps());
  const runtimeSingle = resolveWorldTurnPreset(singleAct.settings);
  assert.equal(runtimeSingle.systemPrompt, "单条正文");
  assert.equal(runtimeSingle.promptSegments, undefined, "单条预设不产生 promptSegments");
});

// 0.9.22 世界书资料开关（审核拦截逃生门）：缺省 true，runtime.update 可切换，非法值拒绝
test("loreSupplementEnabled：缺省 true / runtime.update 切换 / 非法值拒绝 / 视图回传", () => {
  const base = createDefaultSettingsV2(testDeps());
  assert.equal(base.loreSupplementEnabled, true, "缺省开启");
  const view0 = settingsViewV2(base);
  assert.equal(view0.loreSupplementEnabled, true, "视图回传缺省值");

  const off = applySettingsCommand(base, { action: "runtime.update", loreSupplementEnabled: false }, testDeps());
  assert.equal(off.ok, true, "关闭合法");
  assert.equal(off.settings.loreSupplementEnabled, false, "已关闭");
  assert.equal(settingsViewV2(off.settings).loreSupplementEnabled, false, "视图回传关闭态");

  const reopened = applySettingsCommand(off.settings, { action: "runtime.update", loreSupplementEnabled: true }, testDeps());
  assert.equal(reopened.settings.loreSupplementEnabled, true, "可再开");

  const bad = applySettingsCommand(base, { action: "runtime.update", loreSupplementEnabled: "yes" }, testDeps());
  assert.equal(bad.ok, false, "非布尔值被拒");

  // sanitize：旧存档缺字段 → 补 true；显式 false 保留
  const legacy = migrateAtlasSettings(v1Fixture(), testDeps());
  assert.equal(legacy.settings.loreSupplementEnabled, true, "旧存档补缺省 true");
  const explicitOff = sanitizeSettingsV2({ ...JSON.parse(JSON.stringify(base)), loreSupplementEnabled: false }, testDeps());
  assert.equal(explicitOff.settings.loreSupplementEnabled, false, "显式 false 保留");
});

test("segment-only legacy preset remains readable without systemPrompt", () => {
  const rawSettings = { ...createDefaultSettingsV2(),
    promptPresets: [{ id: "segment-only", name: "旧分段", updatedAt: NOW,
      segments: [{ role: "assistant", content: "旧正文" }] }],
    activePromptPresetId: "segment-only" };
  const result = sanitizeSettingsV2(rawSettings, testDeps());
  assert.equal(result.diagnostics.promptSkipped, 0);
  assert.equal(result.settings.activePromptPresetId, "segment-only");
  assert.equal(result.settings.promptPresets[0].systemPrompt, "");
  assert.equal(result.settings.promptPresets[0].segments[0].content, "旧正文");
});

/* ---------------------------------------------------------------------------
 * C01 / C02：table-delta-v1（三表行增量协议）
 * --------------------------------------------------------------------------- */
test("E01 协议枚举：读取归一化只给 table-delta-v1，runtime.update 明确拒绝切回 v1/v2", () => {
  const defaults = createDefaultSettingsV2();
  assert.equal(defaults.worldTurnProtocol, "table-delta-v1", "新装默认 = 三表行增量");
  assert.equal(DEFAULT_WORLD_TURN_PROTOCOL, "table-delta-v1", "默认值有唯一出处");

  const applied = applySettingsCommand(defaults, { action: "runtime.update", worldTurnProtocol: "table-delta-v1" }, testDeps());
  assert.equal(applied.ok, true, applied.ok ? "" : applied.message);
  assert.equal(settingsViewV2(applied.settings).worldTurnProtocol, "table-delta-v1");
  assert.equal(applied.settings.worldTurnProtocol, "table-delta-v1");

  const bad = applySettingsCommand(defaults, { action: "runtime.update", worldTurnProtocol: "v9" }, testDeps());
  assert.equal(bad.ok, false, "非法协议仍必须拒绝");

  // E01：想切回旧 v1 / v2 的写请求被**明确拒绝**（错误信息指向迁移入口）
  for (const legacy of ["v1", "v2"]) {
    const rejected = applySettingsCommand(defaults, { action: "runtime.update", worldTurnProtocol: legacy }, testDeps());
    assert.equal(rejected.ok, false, `切回 ${legacy} 必须被拒绝`);
    assert.equal(rejected.code, "INVALID_PAYLOAD", `${legacy}：错误码`);
    assert.match(String(rejected.message), /table-delta-v1/, `${legacy}：错误信息说明唯一现行协议`);
    assert.match(String(rejected.message), /兼容增量草稿|迁移/, `${legacy}：错误信息给出迁移入口`);
    assert.equal(rejected.settings.worldTurnProtocol, "table-delta-v1", `${legacy}：被拒时不改动设置`);
  }

  /**
   * 读取归一化：缺失 / 非法 / 旧值 v1 / 旧值 v2 **全部**在读取时规范成 table-delta-v1。
   * 持久层里的旧值不被改写——诊断字段 `legacyWorldTurnProtocol` 如实报告原始值。
   */
  assert.equal(normalizeWorldTurnProtocol("table-delta-v1"), "table-delta-v1");
  assert.equal(normalizeWorldTurnProtocol("v1"), "table-delta-v1", "旧 v1 在读取时升级");
  assert.equal(normalizeWorldTurnProtocol("v2"), "table-delta-v1", "旧 v2 在读取时升级");
  assert.equal(normalizeWorldTurnProtocol("junk"), "table-delta-v1", "非法值归唯一现行协议");
  assert.equal(normalizeWorldTurnProtocol(undefined), "table-delta-v1", "缺失值归唯一现行协议");

  // 旧值诊断：作者能看到「历史设置已升级为表格增量」，且原始设置没有被覆盖
  const legacyView = settingsViewV2({ ...defaults, worldTurnProtocol: "v2" });
  assert.equal(legacyView.worldTurnProtocol, "table-delta-v1", "视图只给现行协议");
  assert.equal(legacyView.legacyWorldTurnProtocol?.storedValue, "v2", "诊断带出存储里的原始旧值");
  assert.equal(legacyView.legacyWorldTurnProtocol?.effectiveValue, "table-delta-v1");
  assert.match(String(legacyView.legacyWorldTurnProtocol?.message), /历史设置已升级为表格增量/);
  assert.equal(settingsViewV2(defaults).legacyWorldTurnProtocol, null, "没有旧值时不出诊断");
  /**
   * 持久层原样保留用户原始设置：`sanitizeSettingsV2`（读取路径）内部即用
   * `normalizeWorldTurnProtocol` 归一，因此**归一化后的快照**只含现行协议——这正是
   * 「读取时升级」的含义；而旧值本身从未被写回存储（写入只在作者显式命令时发生）。
   */
  const persisted = sanitizeSettingsV2({ ...defaults, worldTurnProtocol: "v1" }).settings;
  assert.equal(persisted.worldTurnProtocol, "table-delta-v1", "读取路径在读取时升级为唯一现行协议");
  assert.equal(settingsViewV2(persisted).worldTurnProtocol, "table-delta-v1", "视图与运行时只给现行协议");
  // 原始载荷（未过读取路径）不受影响：归一化是纯函数，不产生写副作用
  const rawPayload = { ...defaults, worldTurnProtocol: "v1" };
  normalizeWorldTurnProtocol(rawPayload.worldTurnProtocol);
  assert.equal(rawPayload.worldTurnProtocol, "v1", "归一化不改写用户原始载荷");
  assert.equal(legacyWorldTurnProtocolNotice("v1")?.storedValue, "v1", "旧值诊断按原始值给出");
});

test("E02 内置默认分段只有增量六段；旧协议预设全文仍可查看与复制，另给兼容草稿", () => {
  const base = createDefaultSettingsV2();
  const legacyView = settingsViewV2({ ...base, worldTurnProtocol: "v2" }).builtInPrompt.segments;
  const delta = settingsViewV2({ ...base, worldTurnProtocol: "table-delta-v1" }).builtInPrompt.segments;

  assert.ok(delta.some((segment) => segment.content.includes("<atlasEdit>")), "行增量协议必须展示块格式");
  assert.equal(delta.some((segment) => segment.content.includes('"schemaVersion":2')), false, "不能混进 v2 封套");
  assert.equal(legacyView.some((segment) => segment.content.includes('"schemaVersion": 2')), false, "旧值也不再装 v2 封套");
  assert.deepEqual(legacyView, delta, "无论传入什么协议，内置默认只出增量六段");
  assert.deepEqual(defaultSegmentsForProtocol("table-delta-v1"), DEFAULT_PROMPT_SEGMENTS_TABLE_DELTA);
  assert.deepEqual(defaultSegmentsForProtocol("v1"), DEFAULT_PROMPT_SEGMENTS_TABLE_DELTA, "旧 v1 也只出增量段");
  assert.deepEqual(defaultSegmentsForProtocol("v2"), DEFAULT_PROMPT_SEGMENTS_TABLE_DELTA);
  assert.equal(defaultSegmentsForProtocol("v1").length, 6, "段位不变，bootstrap 才能按索引替换第 5 段");
  assert.equal(defaultSegmentsForProtocol("v2").length, 6);
});

test("E02 创建兼容增量草稿：旧预设原文一字不改，新草稿可预览、可显式启用", () => {
  const base = createDefaultSettingsV2();
  const legacyPrompt = {
    id: "legacy-v2-prompt",
    name: "作者的 v2 封套预设",
    systemPrompt: '输出 {"schemaVersion": 2, "duration": 1, "summary": "..."} 这样的封套。',
    updatedAt: 1,
  };
  const withLegacy = { ...base, promptPresets: [legacyPrompt], activePromptPresetId: legacyPrompt.id };
  const NO_MIGRATION_NEEDED = { action: "runtime.update", autoCommit: true };

  const migrated = applySettingsCommand(withLegacy, { action: "prompt.migrate-legacy", id: legacyPrompt.id }, testDeps());
  assert.equal(migrated.ok, true, migrated.ok ? "" : migrated.message);
  assert.ok(migrated.migratedPresetId, "命令返回新草稿 id（UI 据此预览）");
  assert.notEqual(migrated.migratedPresetId, legacyPrompt.id, "新建而不是覆盖");
  assert.match(String(migrated.migratedPresetName), /增量兼容草稿/);
  assert.ok((migrated.replacedKeywords ?? []).length > 0, "报告新草稿里改写过的旧关键词");

  // E02：`applySettingsCommand` 走的是**已 sanitize 的设置快照**（读取路径），
  // 因此断言「旧预设正文一字不改」，而不是比较 updatedAt 之类的簿记字段。
  const kept = migrated.settings.promptPresets.find((p) => p.id === legacyPrompt.id);
  assert.ok(kept, "旧预设仍在预设库里（没有被删除或改名）");
  assert.equal(kept.systemPrompt, legacyPrompt.systemPrompt, "旧预设正文一字不改（无静默字符串替换）");
  assert.equal(kept.name, legacyPrompt.name, "旧预设名称不变");
  // 新草稿是完整的增量契约：六段内置 + 原预设摘录
  const created = migrated.settings.promptPresets.find((p) => p.id === migrated.migratedPresetId);
  assert.ok(created, "新草稿已入库");
  assert.ok(created.segments.some((segment) => segment.content.includes("<atlasEdit>")), "新草稿带增量块格式");
  assert.equal(created.segments.some((segment) => String(segment.content).includes('"schemaVersion": 2')), false, "新草稿不含旧封套字样名称");
  assert.equal(migrated.settings.activePromptPresetId, legacyPrompt.id, "不擅自切换活动预设");
  assert.equal(applySettingsCommand(withLegacy, { ...NO_MIGRATION_NEEDED }).ok, true, "无关命令不受影响");

  const activated = applySettingsCommand(withLegacy, { action: "prompt.migrate-legacy", id: legacyPrompt.id, activate: true }, testDeps());
  assert.equal(activated.settings.activePromptPresetId, activated.migratedPresetId, "作者显式要求时才启用新草稿");
});

test("C01 协议判定收紧：table-delta-v1 不再被当成 v2（避免装错提示词）", () => {
  assert.equal(isTableDeltaProtocolEnabled("table-delta-v1"), true);
  assert.equal(isTableDeltaProtocolEnabled("v2"), false);
  assert.equal(isTableDeltaProtocolEnabled(undefined), false);
});

test("C01 行增量分段结构：段位与 v2 对齐，契约写明格式与禁止项", () => {
  const segments = DEFAULT_PROMPT_SEGMENTS_TABLE_DELTA;
  assert.equal(segments.length, 6, "与 v2 同段位，bootstrap 才能按索引替换「本轮行动」段");
  assert.equal(segments[0].role, "system");
  assert.equal(segments[0].mainSlot, "A");
  assert.equal(segments[4].mainSlot, "B");
  assert.equal(segments[5].role, "user");

  const contract = segments[0].content;
  for (const needle of ["<atlasEdit>", "noop", "new:loc:", "new:npc:", "new:item:", "quote", "inferred", "16 KiB", "64 行"]) {
    assert.ok(contract.includes(needle), `契约段缺少 ${needle}`);
  }
  for (const forbidden of ["格序号", "mapId", "时间", "距离"]) {
    assert.ok(contract.includes(forbidden), `契约段应明确提到禁止项 ${forbidden}`);
  }
  assert.ok(segments[4].content.includes("不要填任何数字"), "时间与距离不由模型决定");
  assert.ok(segments[5].content.includes("new:loc:"), "核对段覆盖引用形态");

  assert.ok(TABLE_DELTA_BOOTSTRAP_TASK_CONTENT.includes("{{assistantReply}}"));
  assert.ok(TABLE_DELTA_BOOTSTRAP_TASK_CONTENT.includes("不推进时间"), "开场识别只定位");
});
