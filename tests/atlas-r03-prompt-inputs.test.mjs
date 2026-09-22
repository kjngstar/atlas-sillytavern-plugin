/**
 * atlas-r03-prompt-inputs.test.mjs — R03 提示词实际输入与请求预览回归测试。
 *
 * 断言方向与 v0.9.51 基线相反（基线：injectionText/lastTurnSummary/recentContextText 哨兵均 false）：
 * - A01：默认装配含全部状态哨兵（$5/$6/$7/$U/$C/$1/$8/{{assistantReply}}）
 * - A02：素材文字本身包含 $8 等占位符字面量 → 原文保持，不二次替换
 * - 新默认无 assistant 应答段、无 `{` 预填
 * - A10：/turns/preview 与 callAtlasWorldTurnApi 的 messages 逐项一致（同一装配函数）
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(resolve(root, p)).href);
const { buildWorldTurnMessages, DEFAULT_PROMPT_SEGMENTS, substitutePromptPlaceholders, callAtlasWorldTurnApi } = await imp("src/atlas-api-client.ts");

const SENTINELS = {
  injectionText: "AUDIT_WORLD_STATE_IDS",
  lastTurnSummary: "AUDIT_LAST_TURN",
  recentContextText: "AUDIT_RECENT_CONTEXT",
  userText: "AUDIT_USER_ACTION",
  assistantText: "AUDIT_ASSISTANT_REPLY",
  personaDescription: "AUDIT_PERSONA",
  charDescription: "AUDIT_CHAR",
  loreSupplement: "AUDIT_LORE",
};

test("A01: 默认分段装配包含全部 8 项素材哨兵", () => {
  const messages = buildWorldTurnMessages({}, SENTINELS);
  const joined = JSON.stringify(messages);
  for (const [key, sentinel] of Object.entries(SENTINELS)) {
    assert.ok(joined.includes(sentinel), `哨兵 ${key}（${sentinel}）出现在默认装配中`);
  }
});

test("A01: 默认 6 段、无 assistant 应答、无 { 预填；$5 在世界状态段", () => {
  assert.equal(DEFAULT_PROMPT_SEGMENTS.length, 6, "默认 6 段");
  assert.ok(DEFAULT_PROMPT_SEGMENTS.every((s) => s.role !== "assistant"), "无 assistant 确认段");
  assert.ok(DEFAULT_PROMPT_SEGMENTS.every((s) => s.content.trim() !== "{"), "无 { 预填段");
  const stateSeg = DEFAULT_PROMPT_SEGMENTS.find((s) => s.content.includes("$5"));
  assert.ok(stateSeg, "存在含 $5 的世界状态段");
  const contSeg = DEFAULT_PROMPT_SEGMENTS.find((s) => s.content.includes("$6") && s.content.includes("$7"));
  assert.ok(contSeg, "存在含 $6/$7 的连续性材料段");
});

test("A02: 素材原文包含占位符字面量时不二次替换", () => {
  const input = {
    injectionText: "剧情里出现了字面 $8 和 {{assistantReply}} 还有 $6",
    userText: "行动原文 $5",
    assistantText: "回复原文",
  };
  const out = substitutePromptPlaceholders("A:$5\nB:$8\nC:{{assistantReply}}", input);
  // $5 展开为 injectionText；其中字面 $8/{{assistantReply}}/$6 必须原样保留
  assert.ok(out.includes("剧情里出现了字面 $8 和 {{assistantReply}} 还有 $6"), "注入内容原样保留（不二次展开）");
  // 模板里真正的 $8/{{assistantReply}} 正常展开
  assert.ok(out.includes("B:行动原文 $5"), "模板 $8 展开为 userText");
  assert.ok(out.includes("C:回复原文"), "模板 {{assistantReply}} 展开为 assistantText");
});

test("A02: 转义 \\$ 不替换；旧别名兼容", () => {
  const input = { injectionText: "W", userText: "U", assistantText: "A" };
  const out = substitutePromptPlaceholders("x \\$5 y {{worldState}} z {{userAction}}", input);
  assert.ok(out.includes("x \\$5 y"), "转义占位符保留原样（含反斜杠）");
  assert.ok(out.includes("{{worldState}}") === false || out.includes("W"), "旧别名 worldState 展开");
  assert.ok(out.includes("z U"), "旧别名 userAction 展开");
});

test("A10: callAtlasWorldTurnApi 实际发送的 messages 与 buildWorldTurnMessages 一致", async () => {
  const bodies = [];
  const fetchFn = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "{}" } }] }) };
  };
  const input = { injectionText: "W", userText: "U", assistantText: "A" };
  await callAtlasWorldTurnApi(
    { name: "t", endpoint: "https://api.example.com/v1", model: "m", apiKey: "k" },
    input,
    { fetchFn },
  );
  const expected = buildWorldTurnMessages({ name: "t", endpoint: "https://api.example.com/v1", model: "m", apiKey: "k" }, input);
  assert.deepEqual(
    bodies[0].messages,
    expected,
    "fetch 实际请求 messages 与装配函数输出逐项一致",
  );
});
