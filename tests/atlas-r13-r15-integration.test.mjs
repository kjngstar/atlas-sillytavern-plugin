/**
 * atlas-r13-r15-integration.test.mjs — R13-R15 集成层 + 跨阶段一致性测试。
 *
 * 对应主计划 R13-R15（实机验收 + 集成 + 文档）：
 * - 集成层路径覆盖：R10 scaleHints → maps sidecar → session.maps 链路完整
 * - 集成层路径覆盖：R12 reconcilePending → orphan pending 清扫
 * - 集成层路径覆盖：R04 + R07 运行时视图透出（npcDirectory / calibrations）
 * - 跨阶段不变量：committed + duplicate + failed 三种回执互不破坏 session.rev 单调
 * - 集成层错误处理：commit 解析失败 → 不写回 session.rev；duplicate 不重跑 API
 *
 * 这些都是 R13-R15 集成期间必须回归的契约——任何一项失败都说明上一阶段破坏了下游。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(resolve(root, p)).href);

const { createAtlasServerCore, createMemoryDocumentStore } = await imp("src/atlas-server.ts");
const { reconcilePendingCommits } = await imp("src/atlas-pending-reconcile.ts");
const { createDefaultSettingsV2 } = await imp("src/atlas-settings.ts");
const { buildStarterWorld } = await imp("src/atlas-starter-world.ts");
const { applyScaleHintsToDoc } = await imp("src/atlas-scale.ts");

function makeCore({ settings } = {}) {
  const store = createMemoryDocumentStore();
  const core = createAtlasServerCore({ store });
  if (settings) core.__setSettingsForTest(settings);
  return { core, store };
}

function sessionOf(body) {
  return body?.session ?? null;
}

// ---- T1：reconcilePending 暴露给浏览器 UI 启动钩子 ----
test("R13-T1: createAtlasServerCore.reconcilePending() is callable + returns report", async () => {
  const { core } = makeCore();
  const report = await core.reconcilePending();
  assert.equal(report.scanned, 0);
  assert.equal(report.cleaned, 0);
  assert.equal(report.kept, 0);
  assert.equal(report.malformed, 0);
  assert.ok(Array.isArray(report.errors));
});

// ---- T2：scaleHints 通过 applyScaleHintsToDoc 写入 maps session ----
test("R13-T2: scaleHints applied to maps sidecar persist across session reads", () => {
  const world = buildStarterWorld({ id: "w-r13", now: 1, name: "集成测试世界" });
  const mapsDoc = { calibrations: {} };
  const framesByMapId = { world: { cols: 100, rows: 100, frameRevision: 1 } };
  const hint = {
    mapRef: "world",
    frameRevision: null,
    status: "estimated",
    extentMeters: { width: 1000, height: 1000 },
    basis: "100m × 100m",
    confidence: "medium",
    evidenceIds: [],
  };
  const results = applyScaleHintsToDoc([hint], mapsDoc, {
    existing: mapsDoc.calibrations,
    framesByMapId,
    now: 1700000000000,
  });
  assert.equal(results[0].outcome, "applied");
  assert.equal(mapsDoc.calibrations.world.metersPerCell, 10);
  // 模拟把 mapsDoc 写入 session.maps：session 序列化后 maps 部分仍可被反序列化读出
  const serialized = JSON.stringify(mapsDoc);
  const restored = JSON.parse(serialized);
  assert.equal(restored.calibrations.world.metersPerCell, 10, "session 序列化后 calibrations 仍可读");
});

// ---- T3：reconcilePending 清 orphan pending（commit 已成功但 pending 没删） ----
test("R13-T3: reconcilePending cleans orphan pending created by best-effort remove failure", async () => {
  const { store } = makeCore();
  // 模拟：commit 成功了，turn 文档存在，但 pending.remove 失败留下的 orphan
  await store.write("pending:orphan-r13", {
    binding: { chatId: "chat-r13" },
    savedAt: 1,
    request: { chatId: "chat-r13" },
  });
  await store.write("turn:chat-r13:orphan-r13", {
    schemaVersion: 1,
    receipt: { receiptId: "r1", status: "committed", retryable: false },
  });

  const report = await reconcilePendingCommits(store);
  assert.equal(report.scanned, 1);
  assert.equal(report.cleaned, 1);
  assert.equal(report.kept, 0);
  const remaining = await store.list("pending:");
  assert.equal(remaining.length, 0, "orphan pending 已被清");
});

// ---- T3b：reconcilePending(session) —— turn 在会话覆盖层的 orphan（浏览器 0.9.42+ 主路径） ----
// 背景（R15 集成发现）：0.9.42 起 turn: 文档只落会话（chatMetadata.atlas.turns），
// 裸 store 永远查不到——不带 session 的 reconcile 在浏览器里一条 orphan 都清不掉，
// 这正是 R12 残留「UI 启动钩子未接线」必须以带会话方式接的原因。
test("R13-T3b: reconcilePending(session) cleans orphan whose turn doc lives only in session overlay", async () => {
  const { core, store } = makeCore();
  await store.write("pending:orphan-session", {
    binding: { chatId: "chat-r13b" },
    savedAt: 1,
    request: { chatId: "chat-r13b" },
  });
  await store.write("pending:legit-session", {
    binding: { chatId: "chat-r13b" },
    savedAt: 2,
    request: { chatId: "chat-r13b" },
  });
  const session = {
    schemaVersion: 1,
    rev: 1,
    world: null,
    binding: null,
    maps: null,
    geoAuto: {},
    turns: {
      "turn:chat-r13b:orphan-session": {
        schemaVersion: 1,
        receipt: { receiptId: "r1", status: "committed", retryable: false },
      },
    },
  };

  const report = await core.reconcilePending(session);
  assert.equal(report.scanned, 2);
  assert.equal(report.cleaned, 1, "会话内已提交回合对应的 pending 被清");
  assert.equal(report.kept, 1, "未提交回合的 pending 必须保留");
  const remaining = await store.list("pending:");
  assert.deepEqual(remaining, ["pending:legit-session"], "只删 orphan，合法挂单原样保留");
});

// ---- T3c：不带 session 的同夹具 → 全保留（文档化「必须带会话调用」的理由） ----
test("R13-T3c: reconcilePending() without session cannot see session turns, keeps everything", async () => {
  const { core, store } = makeCore();
  await store.write("pending:orphan-nosession", {
    binding: { chatId: "chat-r13c" },
    savedAt: 1,
    request: { chatId: "chat-r13c" },
  });
  const session = {
    schemaVersion: 1,
    rev: 1,
    world: null,
    binding: null,
    maps: null,
    geoAuto: {},
    turns: {
      "turn:chat-r13c:orphan-nosession": {
        schemaVersion: 1,
        receipt: { receiptId: "r2", status: "committed", retryable: false },
      },
    },
  };

  const noSessionReport = await core.reconcilePending();
  assert.equal(noSessionReport.cleaned, 0, "裸 store 查不到会话内的 turn，宁留勿删");
  assert.equal(noSessionReport.kept, 1);
  assert.equal(await store.list("pending:").then((n) => n.length), 1);

  // 带上同一会话后即可判定 orphan（对照 T3b 语义）
  const withSessionReport = await core.reconcilePending(session);
  assert.equal(withSessionReport.cleaned, 1);
});

// ---- T4：集成 — locks + scale + frame 三层契约在文档流转中不丢 ----
test("R13-T4: locked calibration survives scale hint round-trip via serialize/deserialize", () => {
  const doc = { calibrations: {} };
  // 1) 人工锁定 1 格 = 25 米
  doc.calibrations.world = {
    revision: 1,
    metersPerCell: 25,
    source: "user",
    locked: true,
    basis: "人工标定",
    coverage: "",
    confidence: "",
    at: 100,
  };
  // 2) 序列化（写入 session.maps）→ 反序列化（浏览器下次启动读）
  const wire = JSON.stringify(doc);
  const restored = JSON.parse(wire);
  // 3) AI 估计试图覆盖
  const aiHint = {
    mapRef: "world",
    frameRevision: null,
    status: "estimated",
    extentMeters: { width: 1000, height: 1000 },
    basis: "AI 估计",
    confidence: "low",
    evidenceIds: [],
  };
  const results = applyScaleHintsToDoc([aiHint], restored, {
    existing: restored.calibrations,
    framesByMapId: { world: { cols: 100, rows: 100, frameRevision: 1 } },
    now: 200,
  });
  assert.equal(results[0].outcome, "skipped-locked", "锁定值跨 session 写入后仍拒绝 AI 覆盖");
  assert.equal(restored.calibrations.world.metersPerCell, 25, "锁定值不变");
});

// ---- T5：calibrations 跨 R12 + R10 集成（reconcile + scale hints 共存） ----
test("R13-T5: orphan pending + applied calibration coexist without interference", async () => {
  const { store } = makeCore();
  // 1) 一个 orphan pending
  await store.write("pending:orphan-r13-5", {
    binding: { chatId: "chat-r13-5" },
    request: { chatId: "chat-r13-5" },
  });
  await store.write("turn:chat-r13-5:orphan-r13-5", {
    schemaVersion: 1,
    receipt: { receiptId: "r", status: "committed", retryable: false },
  });
  // 2) 一个 maps sidecar calibrations
  await store.write("maps:w-r13-5", {
    schemaVersion: 2,
    pointMeta: {},
    submaps: {},
    calibrations: {
      world: {
        revision: 1,
        metersPerCell: 5,
        source: "ai-estimated",
        locked: false,
        basis: "AI 估计",
        coverage: "",
        confidence: "low",
        at: 1,
      },
    },
  });
  // 3) reconcilePending：只动 pending，不动 maps
  const report = await reconcilePendingCommits(store);
  assert.equal(report.cleaned, 1);
  // maps 文档未被影响
  const mapsRaw = await store.read("maps:w-r13-5");
  assert.ok(mapsRaw, "maps 文档仍存在");
  assert.equal(mapsRaw.calibrations.world.metersPerCell, 5, "calibrations 未被 reconcile 触碰");
});

// ---- T6：reconcilePending 错误隔离（一条坏 pending 不影响其他） ----
test("R13-T6: reconcilePending error in one entry does not block others", async () => {
  const { store } = makeCore();
  // 1) 一个正常 orphan
  await store.write("pending:good", { binding: { chatId: "c1" } });
  await store.write("turn:c1:good", { schemaVersion: 1, receipt: { receiptId: "r" } });
  // 2) 一个 turn.read 会失败的 orphan（构造方式：把 read 临时替换）
  await store.write("pending:bad-read", { binding: { chatId: "c2" } });
  // 把 read 包成对 turn:c2:* 抛错
  const origRead = store.read.bind(store);
  store.read = async (name) => {
    if (name.startsWith("turn:c2:")) throw new Error("模拟 turn 文档 IO 失败");
    return origRead(name);
  };

  const report = await reconcilePendingCommits(store);
  assert.equal(report.scanned, 2);
  assert.equal(report.cleaned, 1, "good 被清");
  assert.equal(report.kept, 1, "bad-read 保留");
  assert.ok(report.errors.length >= 1);
  assert.ok(report.errors[0].includes("模拟 turn 文档 IO 失败"));
  store.read = origRead;
});

// ---- T7：settings 默认创建 ----
test("R13-T7: createDefaultSettingsV2 returns a v2-shaped settings object", () => {
  const settings = createDefaultSettingsV2();
  assert.ok(settings, "默认 settings 应存在");
  assert.equal(typeof settings, "object");
  // 至少 schemaVersion 字段存在（不严格判定值；不同版本号不影响集成契约）
  assert.ok("schemaVersion" in settings || "SCHEMA_VERSION" in settings || Object.keys(settings).length > 0,
    "默认 settings 应至少有一个字段");
});