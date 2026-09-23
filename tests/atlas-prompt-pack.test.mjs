/**
 * atlas-prompt-pack.test.mjs — R15：推演提示词预设导入导出（R02 残留「JSON 包」交付）门禁。
 *
 * 纪律：
 *  1. 包里只有预设语义字段（name / segments / contextTurnCount）——显式白名单构造，
 *     绝无 API 地址 / 密钥 / 连接配置字段（将来误加字段必须在这里被抓住）；
 *  2. 导入是严格预校验：协议不匹配 / 非法 JSON / 无效分段 / 越界上下文档数
 *     一律拒绝并给人话原因，绝不半信半疑地落库；
 *  3. 重名消解不动既有预设（追加「（导入）」序号），导入不自动启用；
 *  4. 导出对旧式单条 systemPrompt 预设自动包成一段 system 段；空预设不产空包。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!doctype html><html><head></head><body></body></html>`, {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;

const {
  ATLAS_PROMPT_PACK_PROTOCOL,
  ATLAS_PROMPT_PACK_BYTES_MAX,
  buildAtlasPromptPack,
  parseAtlasPromptPack,
  uniquePromptPresetName,
} = await import("../index.js");

const SEGMENTS = [
  { role: "system", content: "你是世界引擎。", name: "身份", mainSlot: "A" },
  { role: "user", content: "背景：$1", name: "背景" },
  { role: "assistant", content: "{" },
];

test("PP-01: 分段预设 round-trip 无损（name / segments / 栏位字段 / contextTurnCount）", () => {
  const pack = buildAtlasPromptPack({
    id: "local-only-id",
    name: "剧情推进",
    systemPrompt: "",
    segments: SEGMENTS,
    contextTurnCount: 5,
  }, 1758500000000);
  assert.ok(pack, "非空预设必须能导出");
  const parsed = parseAtlasPromptPack(pack);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
  assert.equal(parsed.preset.name, "剧情推进");
  assert.equal(parsed.preset.contextTurnCount, 5);
  assert.deepEqual(parsed.preset.segments, [
    { role: "system", content: "你是世界引擎。", name: "身份", mainSlot: "A" },
    { role: "user", content: "背景：$1", name: "背景" },
    { role: "assistant", content: "{" },
  ]);
  // 本地 id 不外泄：包只带语义字段
  assert.equal(pack.includes("local-only-id"), false, "预设本地 id 不进包");
});

test("PP-02: 导出白名单——包里只有 protocol / exportedAt / preset(name,segments[,contextTurnCount])", () => {
  const pack = buildAtlasPromptPack({ name: "t", segments: SEGMENTS, updatedAt: 1 }, 1758500000000);
  const parsed = JSON.parse(pack);
  assert.deepEqual(Object.keys(parsed).sort(), ["exportedAt", "preset", "protocol"]);
  assert.deepEqual(Object.keys(parsed.preset).sort(), ["name", "segments"], "缺省 contextTurnCount 时只有两个字段");
  assert.equal(parsed.protocol, ATLAS_PROMPT_PACK_PROTOCOL);
  const withCount = JSON.parse(buildAtlasPromptPack({ name: "t", segments: SEGMENTS, contextTurnCount: 4 }));
  assert.deepEqual(Object.keys(withCount.preset).sort(), ["contextTurnCount", "name", "segments"]);
  // 敏感 / 本地字段绝不出现在包文本里
  for (const forbidden of ["apiKey", "baseUrl", "endpoint", "apiPresets", "updatedAt"]) {
    assert.equal(pack.includes(forbidden), false, `包内不得出现「${forbidden}」`);
  }
});

test("PP-03: 旧式单条 systemPrompt 预设自动包成一段 system 段", () => {
  const pack = buildAtlasPromptPack({ name: "老预设", systemPrompt: "你是 Atlas。", segments: [] });
  const parsed = parseAtlasPromptPack(pack);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
  assert.deepEqual(parsed.preset.segments, [{ role: "system", content: "你是 Atlas。" }]);
  assert.equal(parsed.preset.contextTurnCount, undefined, "缺省不写 contextTurnCount");
});

test("PP-04: 空预设（分段与单条正文皆空）不产空包 → null", () => {
  assert.equal(buildAtlasPromptPack({ name: "空", segments: [], systemPrompt: "   " }), null);
  assert.equal(buildAtlasPromptPack(null), null);
});

test("PP-05: 协议不匹配 / 非法 JSON / 空文件 一律拒绝并给人话原因", () => {
  const good = JSON.parse(buildAtlasPromptPack({ name: "t", segments: SEGMENTS }));
  assert.deepEqual(parseAtlasPromptPack(""), { ok: false, error: "文件为空。" });
  assert.equal(parseAtlasPromptPack("{ not json").ok, false);
  assert.match(parseAtlasPromptPack("{ not json").error, /合法 JSON/);
  const wrongProtocol = parseAtlasPromptPack(JSON.stringify({ ...good, protocol: "atlas-prompt-pack@2" }));
  assert.equal(wrongProtocol.ok, false);
  assert.match(wrongProtocol.error, /协议不匹配/);
  assert.match(parseAtlasPromptPack(JSON.stringify({ protocol: ATLAS_PROMPT_PACK_PROTOCOL })).error, /preset/);
});

test("PP-06: 无效分段（空正文 / 非法 role / 非数组）拒绝；超量分段截断到 16", () => {
  const base = JSON.parse(buildAtlasPromptPack({ name: "t", segments: SEGMENTS }));
  const emptyContent = parseAtlasPromptPack(JSON.stringify({ ...base, preset: { name: "t", segments: [{ role: "system", content: "  " }] } }));
  assert.equal(emptyContent.ok, false);
  assert.match(emptyContent.error, /有效分段/);
  const badRole = parseAtlasPromptPack(JSON.stringify({ ...base, preset: { name: "t", segments: [{ role: "tool", content: "x" }] } }));
  assert.equal(badRole.ok, false);
  const notArray = parseAtlasPromptPack(JSON.stringify({ ...base, preset: { name: "t", segments: "nope" } }));
  assert.equal(notArray.ok, false);

  const many = Array.from({ length: 30 }, (_, i) => ({ role: "user", content: `段 ${i}` }));
  const truncated = parseAtlasPromptPack(JSON.stringify({ ...base, preset: { name: "t", segments: many } }));
  assert.equal(truncated.ok, true);
  assert.equal(truncated.preset.segments.length, 16, "分段上限 16");
});

test("PP-07: contextTurnCount 越界 / 非整数 / 字符串伪数值 拒绝；1 与 10 是合法边界", () => {
  const base = JSON.parse(buildAtlasPromptPack({ name: "t", segments: SEGMENTS }));
  for (const bad of [0, 11, 3.5, "3", -1]) {
    const result = parseAtlasPromptPack(JSON.stringify({ ...base, preset: { ...base.preset, contextTurnCount: bad } }));
    assert.equal(result.ok, false, `contextTurnCount=${String(bad)} 必须拒绝`);
    assert.match(result.error, /1–10/);
  }
  for (const good of [1, 10]) {
    const result = parseAtlasPromptPack(JSON.stringify({ ...base, preset: { ...base.preset, contextTurnCount: good } }));
    assert.equal(result.ok, true);
    assert.equal(result.preset.contextTurnCount, good);
  }
  const omitted = parseAtlasPromptPack(JSON.stringify({ ...base, preset: { ...base.preset, contextTurnCount: null } }));
  assert.equal(omitted.ok, true);
  assert.equal(omitted.preset.contextTurnCount, undefined, "null 视为未提供");
});

test("PP-08: 预设名缺失 / 超长 / 非字符串 拒绝", () => {
  const base = JSON.parse(buildAtlasPromptPack({ name: "t", segments: SEGMENTS }));
  for (const bad of ["", "   ", undefined, 42, "x".repeat(81)]) {
    const result = parseAtlasPromptPack(JSON.stringify({ ...base, preset: { ...base.preset, name: bad } }));
    assert.equal(result.ok, false, `name=${String(bad)} 必须拒绝`);
  }
});

test("PP-09: 超过 64KiB 上限的文件拒绝（不解析）", () => {
  const huge = `{"protocol":"${ATLAS_PROMPT_PACK_PROTOCOL}","preset":{"name":"t","segments":[]},"pad":"${"x".repeat(ATLAS_PROMPT_PACK_BYTES_MAX)}"}`;
  const result = parseAtlasPromptPack(huge);
  assert.equal(result.ok, false);
  assert.match(result.error, /KiB/);
});

test("PP-10: 重名消解——不动既有预设，追加「（导入）」序号", () => {
  assert.equal(uniquePromptPresetName("剧情推进", ["别的"]), "剧情推进");
  assert.equal(uniquePromptPresetName("剧情推进", ["剧情推进"]), "剧情推进（导入）");
  assert.equal(uniquePromptPresetName("剧情推进", ["剧情推进", "剧情推进（导入）"]), "剧情推进（导入 2）");
  assert.equal(uniquePromptPresetName("", []), "导入的预设");
  // 非数组输入不炸
  assert.equal(uniquePromptPresetName("x", null), "x");
});

test("PP-11: 导出 → 导入 → 再导出：包内容稳定（导出时间戳之外完全一致）", () => {
  const preset = { name: "稳定", segments: SEGMENTS, contextTurnCount: 3 };
  const first = JSON.parse(buildAtlasPromptPack(preset, 1758500000000));
  const parsed = parseAtlasPromptPack(JSON.stringify(first));
  assert.equal(parsed.ok, true);
  const second = JSON.parse(buildAtlasPromptPack({ ...parsed.preset }, 1758500001000));
  assert.deepEqual(second.preset, first.preset, "语义字段 round-trip 稳定");
  assert.notEqual(second.exportedAt, first.exportedAt, "时间戳各自独立");
});
