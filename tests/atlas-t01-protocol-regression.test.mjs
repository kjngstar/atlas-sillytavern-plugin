/**
 * atlas-t01-protocol-regression.test.mjs — T01 / T11 端到端回归。
 *
 * T01（计划 §4）：用作者提供的 0.9.56 现场样例当**旧协议回归夹具**——
 *   「HTTP 200、响应 23321 字符、v2 校验在 `schemaPath:"$"` 处失败」。
 *   必须看到：
 *   1. 新模式（table-delta-v1）**不进入** v2 解析路径，只应用行增量；
 *   2. 旧 v2 协议保留原错误码（`RESPONSE_MALFORMED`）与诊断 kind；
 *   3. 网络 502 仍报网络错误（不能被当成"格式问题"）。
 *
 * T11：前置模型 API 502 / 超时 / 模型 200 但块无效 / 会话写回故障 —— 错误必须区分，
 *   失败不假装世界变化，游标不推进，回执可重复推演。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildWorldFromTemplate, getDemoTemplate } from "../lib/demo-events.ts";
import { parseWorld } from "../lib/world-schema.ts";
import { createAtlasServerCore, createMemoryDocumentStore } from "../src/atlas-server.ts";
import { ATLAS_ERROR_CODES } from "../src/atlas-contract.ts";
import { createSessionCarrier, carrierAsCore } from "./atlas-session-helper.mjs";

const NOW = 1_700_000_000_000;
const CURRENT_TIME = 418.07;
const CANON = "chronicle-canon";
const SECRET = "sk-t01-secret-9999";

/** 作者现场样例的形状：HTTP 200、正文很长、顶层封套在 `$` 处不合法。 */
function malformedV2Sample() {
  // 模拟"看起来像 v2 但顶层多了一层包装"的真实偏差：`{"world":{...}}`
  const inner = {
    schemaVersion: 2,
    baseRevision: CURRENT_TIME,
    duration: 1,
    evidence: [],
    discoveries: { locations: [], characters: [] },
    scene: { resolution: "unknown", locationRef: null, transition: "stay", evidenceIds: [] },
    identityUpdates: [], npcUpdates: [], relationUpdates: [], memories: [], worldFlags: [], events: [], mapScaleHints: [],
    summary: "无变化。",
  };
  // 23k 量级的响应：留出足够填充，但保持结构（T01 只关心"封套在 $ 处失败"）
  const padding = "（以下为模型多余推理）".repeat(600);
  return `${padding}\n${JSON.stringify({ world: inner })}`;
}

function jsonResponse(status, payload) {
  const raw = JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(raw), text: async () => raw };
}

function textResponse(status, content) {
  return jsonResponse(status, { choices: [{ message: { content } }] });
}

function buildWorld() {
  const base = buildWorldFromTemplate(getDemoTemplate("chronicle"), { id: "atlas-t01-fixture", now: 1000 });
  const regionId = String((base.regions ?? [])[0]?.id ?? "");
  const parsed = parseWorld(JSON.parse(JSON.stringify({
    ...base,
    points: [...(base.points ?? []), { id: 9001, name: "钟楼", x: 10, y: 10, regionId }],
  })));
  assert.ok(parsed !== null, "夹具世界可解析");
  return parsed;
}

function bindingFor(world) {
  return {
    schemaVersion: 1, enabled: true, chatId: "chat-a", characterId: null, worldId: world.id,
    branchId: CANON, currentLocationId: "4103", worldTimeCursor: CURRENT_TIME,
    lastCommittedMessageId: null, lastCheckpointId: null,
  };
}

function commitRequest(world, overrides = {}) {
  return {
    turnId: "turn-x", chatId: "chat-a", userMessageId: "msg-10", assistantMessageId: "msg-11",
    swipeId: null, userText: "我进钟楼。", assistantText: "你走进钟楼。", ...overrides,
  };
}

async function setup(scripts, { protocol = "table-delta-v1" } = {}) {
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const script = scripts[Math.min(calls.length - 1, scripts.length - 1)];
    if (!script) throw new Error("意外触发了模型请求");
    return script();
  };
  const rawCore = createAtlasServerCore({ store, fetchFn, now: () => NOW });
  const carrier = createSessionCarrier(rawCore);
  const core = carrierAsCore(carrier);
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: bindingFor(world) });
  await core.handle("PUT", "/settings", {
    worldTurn: { name: "模拟推演", endpoint: "https://mock.example.invalid/v1", model: "atlas-mock", apiKey: SECRET, timeoutMs: 5000 },
  }, { local: true });
  await core.handle("PUT", "/settings", { action: "runtime.update", worldTurnProtocol: protocol }, { local: true });
  return { store, core, carrier, world, calls };
}

test("T01：旧 v2 现场样例 → 具名协议冲突（不再进 v2 解析）；无块长响应走行增量拒绝路径；夹块长响应可提交", async () => {
  const sample = malformedV2Sample();
  assert.ok(sample.length > 5000, "现场样例是长响应（T01 的原始症状：23321 字符）");

  /**
   * ① E07 等效：v2 协议已不可选（`runtime.update` 写 v2 会被明确拒绝），旧现场样例因此得到的
   * 不再是「v2 校验失败」，而是**具名的协议冲突**：PROTOCOL_MISMATCH（409）+ 迁移入口，
   * 且世界与游标零变化——既不静默成功，也不被偷偷交给别的管线抢救。
   */
  {
    const { core, carrier, world } = await setup([() => textResponse(200, sample)]);
    const protocolWrite = await core.handle("PUT", "/settings", { action: "runtime.update", worldTurnProtocol: "v2" }, { local: true });
    assert.equal(protocolWrite.status, 400, "旧协议已不可写（前置）");
    const result = await core.handle("POST", "/turns/commit", commitRequest(world));
    assert.equal(result.status, 409, `旧 v2 封套 → 具名协议冲突 409：实际 ${result.status}`);
    assert.equal(result.body.error.code, ATLAS_ERROR_CODES.PROTOCOL_MISMATCH);
    assert.match(String(result.body.error.message), /旧「v2 世界封套」/, "错误信息指出是旧 v2 封套");
    assert.match(String(result.body.error.message), /\$\.schemaVersion/, "错误里带具体路径（$.schemaVersion）");
    assert.match(String(result.body.error.message), /迁移入口/, "错误里给出迁移入口");
    assert.equal(carrier.session.binding.worldTimeCursor, CURRENT_TIME, "失败不推进游标");
    assert.equal(Object.keys(carrier.session.turns ?? {}).length, 0, "失败不落回合记录");
    const logs = core.logs().filter((log) => log.kind === "world-turn-protocol-mismatch");
    assert.equal(logs.length, 1, "留一条协议冲突诊断（不静默）");
    assert.ok(!JSON.stringify(core.logs()).includes(sample.slice(0, 40)), "诊断不含模型原文");
  }

  // ② 既不是 v2 形状、也没有完整块的长响应 → 走行增量拒绝路径（不猜协议、不抢救半截 JSON）
  {
    const plainProse = `（模型只写了一堆散文，没有块）\n${"这是一段没有结构的正文。".repeat(300)}`;
    const { core, carrier, world } = await setup([() => textResponse(200, plainProse)]);
    const result = await core.handle("POST", "/turns/commit", commitRequest(world));
    assert.equal(result.status, 502, "没有完整 <atlasEdit> 块 → RESPONSE_MALFORMED（可重试）");
    assert.equal(result.body.error.code, ATLAS_ERROR_CODES.RESPONSE_MALFORMED);
    assert.match(String(result.body.error.message), /行增量块|atlasEdit/, "错误信息说的是行增量块缺失，不是 v2 封套");
    assert.equal(core.logs().filter((log) => log.kind === "world-turn-protocol-mismatch").length, 0, "**没有**走协议冲突路径");
    assert.equal(core.logs().filter((log) => log.kind === "world-turn-delta-rejected").length, 1, "走的是行增量拒绝路径");
    assert.equal(carrier.session.binding.worldTimeCursor, CURRENT_TIME, "失败不推进游标");
    assert.equal((carrier.session.turns ?? {})[Object.keys(carrier.session.turns ?? {})[0] ?? ""] ?? null, null, "失败不落回合记录");
  }

  // ③ 合法行增量块：同一份"长响应里夹一个块"的场景直接成功
  {
    const withBlock = `${sample}\n<atlasEdit>\n${JSON.stringify({ table: "location", op: "add", ref: "new:loc:hall", name: "钟楼大堂", parentRef: "loc:9001", description: "钟楼内部", quote: "你走进钟楼" })}\n</atlasEdit>`;
    const { core, carrier, world } = await setup([() => textResponse(200, withBlock)]);
    const result = await core.handle("POST", "/turns/commit", commitRequest(world));
    assert.equal(result.body.data?.receipt?.status, "committed", `夹块的长响应应可提交：${JSON.stringify(result.body.error ?? {})}`);
    const names = carrier.session.tables.branches.canon.locations.map((row) => row.name);
    assert.ok(names.includes("钟楼大堂"), "新地点进了三表");
  }
});

test("T11：502 / 超时 / 空响应 / 块无效 —— 错误分类清楚，失败零写入、游标不动", async () => {
  // ① 前置 API 502
  {
    const { core, carrier, world } = await setup([() => jsonResponse(502, { error: "bad gateway" })]);
    const result = await core.handle("POST", "/turns/commit", commitRequest(world));
    assert.equal(result.body.error.code, ATLAS_ERROR_CODES.API_REQUEST_FAILED, "502 → API_REQUEST_FAILED");
    assert.equal(carrier.session.binding.worldTimeCursor, CURRENT_TIME, "不推进游标");
  }
  // ② 请求超时（fetch 永不 resolve，由 timeoutMs 触发 AbortController）
  {
    const store = createMemoryDocumentStore();
    const world = buildWorld();
    const rawCore = createAtlasServerCore({
      store,
      fetchFn: (url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener?.("abort", () => reject(new Error("aborted")));
      }),
      now: () => NOW,
    });
    const carrier = createSessionCarrier(rawCore);
    const core = carrierAsCore(carrier);
    await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
    await core.handle("POST", "/bindings", { action: "bind", binding: bindingFor(world) });
    await core.handle("PUT", "/settings", {
      worldTurn: { name: "模拟推演", endpoint: "https://mock.example.invalid/v1", model: "atlas-mock", apiKey: SECRET, timeoutMs: 30 },
    }, { local: true });
    await core.handle("PUT", "/settings", { action: "runtime.update", worldTurnProtocol: "table-delta-v1" }, { local: true });
    const result = await core.handle("POST", "/turns/commit", commitRequest(world));
    assert.equal(result.body.error.code, ATLAS_ERROR_CODES.API_TIMEOUT, "超时 → API_TIMEOUT");
    assert.equal(carrier.session.binding.worldTimeCursor, CURRENT_TIME, "不推进游标");
  }
  // ③ 模型 200 但块无效（半截 JSON）
  {
    const { core, carrier, world } = await setup([
      () => textResponse(200, '<atlasEdit>\n{"table":"location","op":"add","ref":"new:loc:x","name":"半截'),
    ]);
    const result = await core.handle("POST", "/turns/commit", commitRequest(world));
    assert.equal(result.body.error.code, ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "块无效 → RESPONSE_MALFORMED");
    assert.equal(result.body.error.details?.retryable, true, "可重试");
    assert.equal(carrier.session.binding.worldTimeCursor, CURRENT_TIME, "不推进游标");
    assert.equal(carrier.session.tables ?? null, null, "零写入（三表甚至还没建立）");
  }
  // ④ 空响应
  {
    const { core, world } = await setup([() => textResponse(200, "   ")]);
    const result = await core.handle("POST", "/turns/commit", commitRequest(world));
    assert.equal(result.body.ok, false, "空响应必须失败");
    assert.ok(
      [ATLAS_ERROR_CODES.RESPONSE_MALFORMED, ATLAS_ERROR_CODES.API_REQUEST_FAILED].includes(result.body.error.code),
      `空响应给出明确错误码：实际 ${result.body.error.code}`,
    );
  }
});
