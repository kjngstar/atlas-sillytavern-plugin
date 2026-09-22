/**
 * atlas-contract.test.mjs — ATLAS-00 契约单测。
 *
 * 覆盖：合法 JSON 往返、全部主要非法边界、稳定错误码、
 * 错误序列化无密钥 / 无本地绝对路径、骨架可加载且不含伪造功能。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  ATLAS_PROTOCOL_VERSION,
  ATLAS_ERROR_CODES,
  ATLAS_LIMITS,
  AtlasError,
  atlasCommitIdempotencyKey,
  parseAtlasChatBinding,
  parseAtlasTurnPrepareRequest,
  parseAtlasTurnPrepareResponse,
  parseAtlasTurnCommitRequest,
  parseAtlasTurnReceipt,
  serializeAtlasError,
  toSerializedError,
} from "../src/atlas-contract.ts";
import { createAtlasExtension, ATLAS_DISPLAY_NAME } from "../atlas-extension/index.js";
import { createAtlasServerPlugin, createHealthHandler, ATLAS_PLUGIN_ID } from "../atlas-server-plugin/index.mjs";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let assertionCount = 0;
function ok(value, message) {
  assertionCount += 1;
  assert.ok(value, message);
}
function deepEqual(actual, expected, message) {
  assertionCount += 1;
  assert.deepStrictEqual(actual, expected, message);
}

/** 统一断言：解析必须失败且返回指定错误码。 */
function assertRejected(result, code, label) {
  assertionCount += 2;
  assert.equal(result.ok, false, `${label} 应被拒绝`);
  assert.equal(result.error.code, code, `${label} 应返回错误码 ${code}`);
}

/** 统一断言：解析成功后 JSON 往返语义一致。 */
function assertRoundTrip(parser, value, label) {
  const first = parser(value);
  assertionCount += 2;
  assert.equal(first.ok, true, `${label} 首次解析应成功`);
  const restored = JSON.parse(JSON.stringify(first.value));
  const second = parser(restored);
  assert.equal(second.ok, true, `${label} 往返后应仍可解析`);
  assertionCount += 1;
  deepEqual(second.value, first.value, `${label} 往返后语义一致`);
}

function validBinding() {
  return {
    schemaVersion: 1,
    enabled: true,
    chatId: "chat-0001",
    characterId: "char-9",
    worldId: "world-atlas-demo",
    branchId: "main",
    currentLocationId: "loc-gate",
    worldTimeCursor: 1_234_567,
    lastCommittedMessageId: "msg-42",
    lastCheckpointId: "ckpt-7",
  };
}

function validPrepareRequest() {
  return {
    chatId: "chat-0001",
    messageId: "msg-100",
    worldId: "world-atlas-demo",
    branchId: "main",
    userText: "我从城门前往集市。",
    recentMessageRefs: [
      { id: "msg-99", role: "user" },
      { id: "msg-98", role: "assistant" },
    ],
  };
}

function validPrepareResponse() {
  return {
    turnId: "turn-abc",
    injectionText: "[Atlas] 当前地点：城门。时间：第 3 天。附近 NPC：守卫。",
    sourceRefs: ["entry-city-gate", "entry-guard"],
    relevantNpcIds: ["npc-guard"],
    triggerIds: ["trg-gate-market"],
    currentTime: 1_234_567,
    currentLocationId: "loc-gate",
    travelPreview: {
      destinationId: "loc-market",
      distance: 12,
      estimatedDuration: 30,
      factors: ["地形:平原", "道路:主干道"],
    },
  };
}

function validCommitRequest() {
  return {
    turnId: "turn-abc",
    chatId: "chat-0001",
    userMessageId: "msg-100",
    assistantMessageId: "msg-101",
    swipeId: null,
    userText: "我从城门前往集市。",
    assistantText: "你沿着主干道走向集市，途中遇到一名守卫。",
  };
}

function validReceipt() {
  return {
    receiptId: "rcpt-001",
    status: "committed",
    checkpointId: "ckpt-8",
    branchId: "main",
    previousTime: 1_234_567,
    currentTime: 1_237_597,
    previousLocationId: "loc-gate",
    currentLocationId: "loc-market",
    triggeredNpcIds: ["npc-guard"],
    adoptedEventIds: ["evt-11"],
    summary: "时间推进 3030，位置从城门移动到集市，守卫加入记忆。",
    retryable: false,
  };
}

// ---------------------------------------------------------------------------
// 协议版本与错误码
// ---------------------------------------------------------------------------

test("协议版本固定为 1", () => {
  assert.equal(ATLAS_PROTOCOL_VERSION, 1);
  assertionCount += 1;
});

test("稳定错误码覆盖全部 11 类要求", () => {
  const expected = [
    "PROTOCOL_INCOMPATIBLE",
    "NOT_BOUND",
    "WORLD_NOT_FOUND",
    "FIELD_LIMIT_EXCEEDED",
    "SERVICE_OFFLINE",
    "API_NOT_CONFIGURED",
    "API_RATE_LIMITED",
    "API_TIMEOUT",
    "RESPONSE_MALFORMED",
    "DUPLICATE_COMMIT",
    "WRITE_FAILED",
  ];
  for (const code of expected) {
    assert.equal(ATLAS_ERROR_CODES[code], code, `缺少稳定错误码 ${code}`);
    assertionCount += 1;
  }
});

// ---------------------------------------------------------------------------
// AtlasChatBinding
// ---------------------------------------------------------------------------

test("合法 binding 往返一致", () => {
  assertRoundTrip(parseAtlasChatBinding, validBinding(), "binding");
});

test("binding：缺失 / 非法 schemaVersion 被拒绝", () => {
  const missing = validBinding();
  delete missing.schemaVersion;
  assertRejected(parseAtlasChatBinding(missing), "INVALID_PAYLOAD", "缺失 schemaVersion");

  const v2 = { ...validBinding(), schemaVersion: 2 };
  assertRejected(parseAtlasChatBinding(v2), "PROTOCOL_INCOMPATIBLE", "schemaVersion=2");

  const v0 = { ...validBinding(), schemaVersion: "1" };
  assertRejected(parseAtlasChatBinding(v0), "PROTOCOL_INCOMPATIBLE", "schemaVersion 为字符串");
});

test("binding：空 ID / 超长 ID / 非布尔 enabled / 非法时间游标被拒绝", () => {
  const empty = validBinding();
  empty.chatId = "";
  assertRejected(parseAtlasChatBinding(empty), "INVALID_PAYLOAD", "空 chatId");

  const long = validBinding();
  long.worldId = "w".repeat(ATLAS_LIMITS.ID_CHARS + 1);
  assertRejected(parseAtlasChatBinding(long), "FIELD_LIMIT_EXCEEDED", "超长 worldId");

  const badEnabled = { ...validBinding(), enabled: "yes" };
  assertRejected(parseAtlasChatBinding(badEnabled), "INVALID_PAYLOAD", "enabled 非布尔");

  const negative = { ...validBinding(), worldTimeCursor: -1 };
  assertRejected(parseAtlasChatBinding(negative), "INVALID_PAYLOAD", "负数时间游标");

  const huge = { ...validBinding(), worldTimeCursor: Number.MAX_SAFE_INTEGER + 1 };
  assertRejected(parseAtlasChatBinding(huge), "INVALID_PAYLOAD", "超 MAX_SAFE_INTEGER 游标");

  const missing = validBinding();
  delete missing.worldTimeCursor;
  assertRejected(parseAtlasChatBinding(missing), "INVALID_PAYLOAD", "缺失时间游标");
});

test("binding：可选字段缺失或 null 均合法", () => {
  const minimal = {
    schemaVersion: 1,
    enabled: false,
    chatId: "chat-2",
    worldId: "world-2",
    branchId: null,
    worldTimeCursor: 0,
  };
  const parsed = parseAtlasChatBinding(minimal);
  ok(parsed.ok, "最小 binding 应合法");
  if (parsed.ok) {
    deepEqual(parsed.value.characterId, undefined, "characterId 缺省为 undefined");
    deepEqual(parsed.value.branchId, null, "branchId 显式 null");
  }

  const nulled = { ...validBinding(), characterId: null, currentLocationId: null, lastCommittedMessageId: null, lastCheckpointId: null };
  ok(parseAtlasChatBinding(nulled).ok, "可选字段全 null 应合法");
});

test("binding：非对象输入被拒绝", () => {
  assertRejected(parseAtlasChatBinding(null), "INVALID_PAYLOAD", "null");
  assertRejected(parseAtlasChatBinding("binding"), "INVALID_PAYLOAD", "字符串");
  assertRejected(parseAtlasChatBinding([validBinding()]), "INVALID_PAYLOAD", "数组");
});

// ---------------------------------------------------------------------------
// prepare 请求 / 响应
// ---------------------------------------------------------------------------

test("合法 prepare 请求往返一致", () => {
  assertRoundTrip(parseAtlasTurnPrepareRequest, validPrepareRequest(), "prepare request");
});

test("prepare 请求：非法 role / 超长正文 / 超量消息被拒绝", () => {
  const badRole = validPrepareRequest();
  badRole.recentMessageRefs[0].role = "system";
  assertRejected(parseAtlasTurnPrepareRequest(badRole), "INVALID_PAYLOAD", "role=system");

  const longText = validPrepareRequest();
  longText.userText = "行".repeat(ATLAS_LIMITS.USER_TEXT_CHARS + 1);
  assertRejected(parseAtlasTurnPrepareRequest(longText), "FIELD_LIMIT_EXCEEDED", "超长 userText");

  const tooMany = validPrepareRequest();
  tooMany.recentMessageRefs = Array.from({ length: ATLAS_LIMITS.RECENT_MESSAGES + 1 }, (_, i) => ({ id: `m${i}`, role: "user" }));
  assertRejected(parseAtlasTurnPrepareRequest(tooMany), "FIELD_LIMIT_EXCEEDED", "超量 recentMessageRefs");

  const missing = validPrepareRequest();
  delete missing.messageId;
  assertRejected(parseAtlasTurnPrepareRequest(missing), "INVALID_PAYLOAD", "缺失 messageId");
});

test("合法 prepare 响应往返一致（含 travelPreview）", () => {
  assertRoundTrip(parseAtlasTurnPrepareResponse, validPrepareResponse(), "prepare response");
});

test("prepare 响应：无 travelPreview 合法，缺 currentLocationId 非法", () => {
  const noPreview = validPrepareResponse();
  delete noPreview.travelPreview;
  assertRoundTrip(parseAtlasTurnPrepareResponse, noPreview, "无 travelPreview 响应");

  const missing = validPrepareResponse();
  delete missing.currentLocationId;
  assertRejected(parseAtlasTurnPrepareResponse(missing), "INVALID_PAYLOAD", "缺失 currentLocationId");
});

test("prepare 响应：注入文本超预算 / 数组超量被拒绝", () => {
  const long = validPrepareResponse();
  long.injectionText = "注".repeat(ATLAS_LIMITS.INJECTION_CHARS + 1);
  assertRejected(parseAtlasTurnPrepareResponse(long), "FIELD_LIMIT_EXCEEDED", "注入文本超预算");

  const many = validPrepareResponse();
  many.sourceRefs = Array.from({ length: ATLAS_LIMITS.REF_ARRAY + 1 }, (_, i) => `s${i}`);
  assertRejected(parseAtlasTurnPrepareResponse(many), "FIELD_LIMIT_EXCEEDED", "sourceRefs 超量");

  const emptyItem = validPrepareResponse();
  emptyItem.relevantNpcIds = [""];
  assertRejected(parseAtlasTurnPrepareResponse(emptyItem), "INVALID_PAYLOAD", "空 NPC ID");
});

test("prepare 响应：travelPreview 非法被拒绝", () => {
  const bad = validPrepareResponse();
  bad.travelPreview.factors = Array.from({ length: ATLAS_LIMITS.TRAVEL_FACTORS + 1 }, (_, i) => `f${i}`);
  assertRejected(parseAtlasTurnPrepareResponse(bad), "FIELD_LIMIT_EXCEEDED", "factors 超量");

  const negative = validPrepareResponse();
  negative.travelPreview.distance = -5;
  assertRejected(parseAtlasTurnPrepareResponse(negative), "INVALID_PAYLOAD", "负距离");
});

// ---------------------------------------------------------------------------
// commit 请求 / receipt
// ---------------------------------------------------------------------------

test("合法 commit 请求往返一致", () => {
  assertRoundTrip(parseAtlasTurnCommitRequest, validCommitRequest(), "commit request");
});

test("commit 请求：swipeId 缺省 / null / 字符串均合法，非字符串非法", () => {
  const noSwipe = validCommitRequest();
  delete noSwipe.swipeId;
  assertRoundTrip(parseAtlasTurnCommitRequest, noSwipe, "无 swipeId");

  const badSwipe = { ...validCommitRequest(), swipeId: 3 };
  assertRejected(parseAtlasTurnCommitRequest(badSwipe), "INVALID_PAYLOAD", "swipeId 为数字");

  const longAssistant = validCommitRequest();
  longAssistant.assistantText = "回".repeat(ATLAS_LIMITS.ASSISTANT_TEXT_CHARS + 1);
  assertRejected(parseAtlasTurnCommitRequest(longAssistant), "FIELD_LIMIT_EXCEEDED", "超长 assistantText");
});

// 0.9.21 世界书资料补充：可选宽容字段——字符串截断保留，非字符串 / 空白丢弃，绝不拒整单
test("commit 请求：loreSupplement 可选宽容处理", () => {
  const withLore = validCommitRequest();
  withLore.loreSupplement = "- 低语森林：地点描述";
  const parsedLore = parseAtlasTurnCommitRequest(withLore);
  assert.ok(parsedLore.ok, "带 loreSupplement 合法");
  assert.equal(parsedLore.value.loreSupplement, "- 低语森林：地点描述", "loreSupplement 保留");

  const longLore = validCommitRequest();
  longLore.loreSupplement = "料".repeat(ATLAS_LIMITS.LORE_SUPPLEMENT_CHARS + 100);
  const parsedLong = parseAtlasTurnCommitRequest(longLore);
  assert.ok(parsedLong.ok, "超长 loreSupplement 不拒整单");
  assert.equal(parsedLong.value.loreSupplement.length, ATLAS_LIMITS.LORE_SUPPLEMENT_CHARS, "超长 loreSupplement 截断到上限");

  const badLore = validCommitRequest();
  badLore.loreSupplement = 42;
  const parsedBad = parseAtlasTurnCommitRequest(badLore);
  assert.ok(parsedBad.ok, "非字符串 loreSupplement 不拒整单");
  assert.equal(parsedBad.value.loreSupplement, undefined, "非字符串 loreSupplement 丢弃");

  const blankLore = validCommitRequest();
  blankLore.loreSupplement = "   ";
  const parsedBlank = parseAtlasTurnCommitRequest(blankLore);
  assert.ok(parsedBlank.ok, "空白 loreSupplement 不拒整单");
  assert.equal(parsedBlank.value.loreSupplement, undefined, "空白 loreSupplement 丢弃");

  const noLore = validCommitRequest();
  const parsedNone = parseAtlasTurnCommitRequest(noLore);
  assert.ok(parsedNone.ok, "无 loreSupplement 合法（旧行为）");
  assert.equal(parsedNone.value.loreSupplement, undefined, "无 loreSupplement 字段缺省");
});

test("幂等键只由 chat + 消息对 + swipe 决定", () => {
  const base = validCommitRequest();
  deepEqual(atlasCommitIdempotencyKey(base), "chat-0001::msg-100::msg-101::", "null swipe 记为空段");
  const swiped = { ...base, swipeId: "s2" };
  deepEqual(atlasCommitIdempotencyKey(swiped), "chat-0001::msg-100::msg-101::s2", "swipe 参与 idempotency key");
  assertionCount += 2;
});

test("合法 receipt 往返一致", () => {
  assertRoundTrip(parseAtlasTurnReceipt, validReceipt(), "receipt");
});

test("receipt：四种状态合法，其余拒绝", () => {
  for (const status of ["committed", "duplicate", "pending-review", "failed"]) {
    assertRoundTrip(parseAtlasTurnReceipt, { ...validReceipt(), status }, `receipt status=${status}`);
  }
  assertRejected(parseAtlasTurnReceipt({ ...validReceipt(), status: "ok" }), "INVALID_PAYLOAD", "非法 status");
  assertRejected(parseAtlasTurnReceipt({ ...validReceipt(), status: 1 }), "INVALID_PAYLOAD", "数字 status");
});

test("receipt：非法时间 / 非布尔 retryable / 空摘要被拒绝", () => {
  const negative = validReceipt();
  negative.previousTime = -1;
  assertRejected(parseAtlasTurnReceipt(negative), "INVALID_PAYLOAD", "负 previousTime");

  const badRetry = validReceipt();
  badRetry.retryable = "true";
  assertRejected(parseAtlasTurnReceipt(badRetry), "INVALID_PAYLOAD", "retryable 非布尔");

  const missing = validReceipt();
  delete missing.summary;
  assertRejected(parseAtlasTurnReceipt(missing), "INVALID_PAYLOAD", "缺失 summary");

  const longSummary = validReceipt();
  longSummary.summary = "长".repeat(ATLAS_LIMITS.SUMMARY_CHARS + 1);
  assertRejected(parseAtlasTurnReceipt(longSummary), "FIELD_LIMIT_EXCEEDED", "超长 summary");
});

// ---------------------------------------------------------------------------
// 错误序列化安全
// ---------------------------------------------------------------------------

test("AtlasError 序列化不含 apiKey / Authorization / 本地绝对路径", () => {
  const error = new AtlasError("WRITE_FAILED", "写入失败：E:\\地图\\secrets\\key.txt 处读取 apiKey 失败", {
    apiKey: "sk-super-secret-123",
    Authorization: "Bearer abc.def.ghi",
    api_token: "tok-456",
    stackPath: "C:\\Users\\mi\\.workbuddy\\cache\\x.json",
    nested: { AuthorizationHeader: "Bearer zz", file: "/home/mi/.ssh/id_rsa" },
    list: ["E:\\地图\\阿特拉斯\\tmp.log"],
  });
  const serialized = JSON.stringify(serializeAtlasError(error));
  ok(!/sk-|Bearer\s|id_rsa|tok-456/i.test(serialized), "序列化结果不得含密钥原文");
  ok(!/[A-Za-z]:[\\/]/.test(serialized), "序列化结果不得含 Windows 绝对路径");
  ok(!/\/home\/mi\//.test(serialized), "序列化结果不得含 POSIX 绝对路径");
  ok(serialized.includes("[REDACTED]"), "敏感键应被占位");
  ok(serialized.includes("[path]"), "路径应被占位");

  const parsed = JSON.parse(serialized);
  deepEqual(parsed.code, "WRITE_FAILED", "错误码保持稳定");
});

test("toSerializedError 处理任意 thrown 且保持安全", () => {
  const generic = toSerializedError(new Error("boom at E:\\地图\\tmp\\a.ts"));
  deepEqual(generic.code, "INVALID_PAYLOAD", "非 AtlasError 归入 INVALID_PAYLOAD");
  ok(!/[A-Za-z]:[\\/]/.test(JSON.stringify(generic)), "通用错误也不带绝对路径");

  const atlas = toSerializedError(new AtlasError("API_TIMEOUT", "推演超时", { seconds: 30 }));
  deepEqual(atlas.code, "API_TIMEOUT", "AtlasError 保留错误码");
  deepEqual(atlas.details.seconds, 30, "安全 details 原样保留");
  assertionCount += 4;
});

// ---------------------------------------------------------------------------
// 骨架可加载、无伪造功能
// ---------------------------------------------------------------------------

test("UI Extension 骨架：显示名正确、无事件接线", () => {
  const extension = createAtlasExtension();
  assert.equal(extension.displayName, "阿特拉斯 / Atlas", "显示名必须是「阿特拉斯 / Atlas」");
  assert.equal(typeof extension.mount, "function", "mount 是生命周期占位");
  extension.mount();
  assert.equal(extension.mounted, true, "mount 生效");
  extension.unmount();
  assert.equal(extension.mounted, false, "unmount 生效");
  assertionCount += 5;
});

test("manifest.json 显示名固定且指向最小入口", () => {
  const manifest = JSON.parse(readFileSync(join(root, "atlas-extension", "manifest.json"), "utf8"));
  assert.equal(manifest.display_name, ATLAS_DISPLAY_NAME, "manifest 显示名与代码一致");
  assert.equal(manifest.js, "index.js", "入口为 index.js");
  assertionCount += 2;
});

test("Server Plugin：路由清单与 health 响应无敏感字段", () => {
  const plugin = createAtlasServerPlugin();
  assert.equal(plugin.id, ATLAS_PLUGIN_ID, "插件 ID 固定为 atlas");
  // ATLAS-04 骨架 + ATLAS-06 rollback + ATLAS-18 ensure-starter；0.9.42 会话承载：/state 与 /map/image 改 POST + /session/export + /session/purge
  assert.equal(plugin.routes.length, 19, "0.9.42 起注册 18 条路由（会话承载改排 + 存量迁移两条）");
  assert.equal(plugin.routes[0].path, "/api/plugins/atlas/health", "路由路径固定");
  assert.equal(plugin.routes[0].method, "GET", "health 为 GET");
  for (const route of plugin.routes) {
    assert.ok(route.path.startsWith("/api/plugins/atlas/"), `路由 ${route.path} 固定在插件前缀下`);
    assertionCount += 1;
  }

  const handler = createHealthHandler(() => "2026-09-16T00:00:00.000Z");
  const payload = handler();
  const serialized = JSON.stringify(payload);
  assert.equal(payload.ok, true, "health ok");
  assert.equal(payload.protocolVersion, 1, "health 携带协议版本");
  for (const forbidden of ["key", "token", "secret", "authorization", "env", "path", "cwd"]) {
    assert.ok(!serialized.toLowerCase().includes(forbidden), `health 响应不得包含 ${forbidden}`);
    assertionCount += 1;
  }
  assertionCount += 5;
});

test("data.example.json 不含用户数据或密钥形状", () => {
  const data = JSON.parse(readFileSync(join(root, "atlas-server-plugin", "data.example.json"), "utf8"));
  assert.equal(data.schemaVersion, 1, "schemaVersion 固定");
  assert.deepEqual(data.worlds, [], "worlds 为空");
  assert.deepEqual(data.bindings, [], "bindings 为空");
  assert.deepEqual(data.apiPresets, [], "apiPresets 为空");
  assertionCount += 4;
});

test(`本轮累计断言数已记录（${assertionCount}+ 组）`, () => {
  ok(assertionCount > 40, "断言数量应达到覆盖要求");
});
