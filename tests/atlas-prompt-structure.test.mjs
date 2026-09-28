import test from "node:test";
import assert from "node:assert/strict";
import { applySettingsCommand, buildTableDeltaCompatiblePrompt, createDefaultSettingsV2, resolveWorldTurnPreset, sanitizeSettingsV2, settingsViewV2 } from "../src/atlas-settings.ts";
import { buildWorldTurnMessages, callAtlasWorldTurnApi } from "../src/atlas-api-client.ts";

const segments = [
  { role: "SYSTEM", name: "规则", content: "规则", mainSlot: "A" },
  { role: "USER", name: "备用素材", content: "PRIVATE_DISABLED $5", enabled: false, deletable: false },
  { role: "assistant", name: "确认", content: "确认 $8" },
];
const input = { injectionText: "状态", userText: "行动", assistantText: "正文" };

test("条目开关经保存、脱敏视图、重载及预设组合保留；实际 HTTP 请求跳过停用内容", async () => {
  const connection = applySettingsCommand(createDefaultSettingsV2(), { action: "api.save", apiKeyMode: "clear", preset: {
    name: "测试", endpoint: "https://example.test/v1", model: "m", maxTokens: 1024, temperature: 0.7, topP: 0.95, timeoutMs: 30000 } });
  assert.equal(connection.ok, true, connection.message);
  let settings = connection.settings;
  settings = applySettingsCommand(settings, { action: "api.activate", id: settings.apiPresets[0].id }).settings;
  const saved = applySettingsCommand(settings, { action: "prompt.save", preset: { name: "分段", systemPrompt: "", segments } });
  assert.equal(saved.ok, true);
  const id = saved.settings.promptPresets[0].id;
  settings = applySettingsCommand(saved.settings, { action: "prompt.activate", id }).settings;
  const reloaded = sanitizeSettingsV2(JSON.parse(JSON.stringify(settings))).settings;
  assert.equal(settingsViewV2(reloaded).promptPresets[0].segments[1].enabled, false);
  assert.equal(reloaded.promptPresets[0].segments[1].deletable, false);
  const preset = resolveWorldTurnPreset(reloaded);
  const requests = [];
  await callAtlasWorldTurnApi(preset, input, { fetchFn: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "{}" } }] }) };
  } });
  assert.deepEqual(requests[0].messages, [{ role: "system", content: "规则" }, { role: "assistant", content: "确认 行动" }]);
  assert.equal(JSON.stringify(requests).includes("PRIVATE_DISABLED"), false);
  const enabled = reloaded.promptPresets[0].segments.map((segment) => ({ ...segment, enabled: true }));
  const updated = applySettingsCommand(reloaded, { action: "prompt.save", preset: { id, name: "分段", systemPrompt: "", segments: enabled } });
  assert.equal(updated.ok, true);
  assert.deepEqual(buildWorldTurnMessages(resolveWorldTurnPreset(updated.settings), input).map((m) => m.content), ["规则", "PRIVATE_DISABLED 状态", "确认 行动"]);
});

test("全停用预设拒绝保存；旧损坏配置也不调用模型、不回退发送默认提示词", async () => {
  const settings = createDefaultSettingsV2();
  const disabled = segments.map((segment) => ({ ...segment, enabled: false }));
  const saved = applySettingsCommand(settings, { action: "prompt.save", preset: { name: "全停用", systemPrompt: "隐藏正文", segments: disabled } });
  assert.equal(saved.ok, false);
  assert.match(saved.message, /至少启用/);
  assert.deepEqual(buildWorldTurnMessages({ promptSegments: disabled }, input), []);
  let called = false;
  const result = await callAtlasWorldTurnApi({ name: "t", endpoint: "https://example.test/v1", model: "m", apiKey: "", promptSegments: disabled }, input,
    { fetchFn: async () => { called = true; throw new Error("should not be called"); } });
  assert.equal(called, false); assert.equal(result.ok, false); assert.equal(result.retryable, false);
  assert.match(result.message, /没有启用/);
});

test("创建兼容增量草稿时不把停用条目重新拼入启用的摘录", () => {
  const migrated = buildTableDeltaCompatiblePrompt({ id: "old", name: "旧预设", systemPrompt: "", segments: [
    { role: "user", content: "活动规则 narrativeSummary" },
    { role: "user", content: "PRIVATE_DISABLED", enabled: false },
  ] });
  assert.ok(migrated.segments.some((segment) => segment.content.includes("活动规则")));
  assert.equal(JSON.stringify(migrated).includes("PRIVATE_DISABLED"), false);
});
