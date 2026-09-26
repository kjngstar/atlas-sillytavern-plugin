/**
 * atlas-changes-page.test.mjs — D08 定向验收（变化页「幕后推演」四分类）。
 *
 * 对照计划 §2.3 / D08：
 *  - 按回合分组之外，另给「实体改动 / 后台行动 / 消息传播 / 失败行」四类；
 *  - 消息要标出公开 / 传递 / 传言 / 争议信度；
 *  - 失败行要能看到行号与字段路径（引擎按「第 N 行 CODE @ path」如实回报）；
 *  - 默认**仅已知**；作者显式切「查看全部幕后推演」才带上 hidden，并且界面要说明
 *    它只是作者视图、不改变任何人的知识；
 *  - 同一条信号在左栏 / 变化页 / 人物知识状态上的含义必须一致（同源于 simulationView）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 挂载真实 index.js 的变化页（与 R01 同套路：data:URL 注入 `export { renderPanel }`）。 */
async function mountChangesPage({ simulationView, receipts = [], visibility = "known", page = "changes", diagnostics = [] }) {
  const dom = new JSDOM("<!doctype html><head></head><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;

  const style = document.createElement("style");
  style.textContent = readFileSync(join(root, "atlas-extension", "style.css"), "utf8");
  document.head.append(style);

  const source = readFileSync(join(root, "index.js"), "utf8");
  const { renderPanel, addTestDiagnostics } = await import(
    "data:text/javascript;base64," + Buffer.from(`${source}\nexport { renderPanel }; export function addTestDiagnostics(entries) { pendingDiagnostics.push(...entries); }`).toString("base64")
  );
  addTestDiagnostics(diagnostics);

  const cameraMod = await import(pathToFileURL(join(root, "src", "atlas-map-camera.ts")).href);
  const mapMod = {
    ...cameraMod,
    ...(await import(pathToFileURL(join(root, "src", "atlas-map-interactions.ts")).href)),
    ...(await import(pathToFileURL(join(root, "src", "atlas-scale.ts")).href)),
    ...(await import(pathToFileURL(join(root, "src", "atlas-map-grid.ts")).href)),
    ...(await import(pathToFileURL(join(root, "src", "atlas-map-areas.ts")).href)),
    ATLAS_UI_PAGES: (await import(pathToFileURL(join(root, "src", "atlas-ui-core.ts")).href)).ATLAS_UI_PAGES,
  };

  const state = {
    page,
    panelOpen: true,
    serviceStatus: "online",
    chatId: "chat-d08",
    binding: { schemaVersion: 1, enabled: true, chatId: "chat-d08", worldId: "w-d08", branchId: null, currentLocationId: null, worldTimeCursor: 5 },
    receipts,
    pendingTurn: null,
    retryableCommit: null,
    simulationView,
    simulationVisibility: visibility,
    lastError: null,
    modeHint: null,
    lorebookHint: null,
    worldNotice: null,
    stateData: { chatId: "chat-d08", worldId: "w-d08", worldName: "D08 世界", currentTime: 5, currentLocationId: null },
  };
  const visibilityCalls = [];
  const core = {
    getState: () => state,
    setPage: () => {},
    setPanelOpen: () => {},
    refresh: async () => {},
    setSimulationVisibility: async (next) => { visibilityCalls.push(next); },
  };
  const api = { request: async () => ({ status: 200, body: { ok: true, data: {} } }) };
  const container = document.createElement("div");
  document.body.append(container);
  renderPanel(core, container, api, { read: async () => null }, mapMod);
  return { dom, container, visibilityCalls };
}

function simulationViewWith(events, overrides = {}) {
  return {
    branchKey: "canon",
    tasks: [], signals: [], deliveries: [
      { id: "dlv:1", signalId: "sig:1", recipientType: "location", recipientId: "loc:2", via: "contact", fromLocationId: "loc:1", receivedPeriod: 5, confidence: "rumor" },
    ],
    recentEvents: events,
    counts: { tasks: 1, signals: 1, deliveries: 1, events: events.length, activeTasks: 1, blockedTasks: 0 },
    truncated: { tasks: 0, signals: 0, deliveries: 0, events: 0 },
    currentLocationKnown: false,
    visibility: "known",
    corrupt: false,
    ...overrides,
  };
}

test("D08 变化页：四个分类齐备，消息带信度，失败行显示行号与字段路径", async () => {
  const { dom, container } = await mountChangesPage({
    simulationView: simulationViewWith([
      {
        id: "evt:1", simulationId: "task:1", kind: "travel", actorCharacterId: "npc:x",
        fromLocationId: "loc:1", toLocationId: "loc:2", status: "blocked",
        reasonCode: "NO_PATH", summary: "npc:x 暂不能行动：赶车", visibility: "known", period: 5,
      },
      {
        id: "evt:2", simulationId: "dlv:1", kind: "delivery", actorCharacterId: "npc:y",
        fromLocationId: "loc:1", toLocationId: "loc:2", status: "delivered",
        reasonCode: null, summary: "获知消息：使者带出宣战文书", visibility: "known", period: 5,
      },
    ]),
    receipts: [{
      receiptId: "r1", status: "committed", branchId: null,
      previousTime: 1, currentTime: 5, triggeredNpcIds: [], adoptedEventIds: [],
      summary: "1 位人物记下行动意图；等待时间推进", retryable: false,
    }],
  });

  const text = container.textContent ?? "";
  assert.ok(text.includes("幕后推演"), "有「幕后推演」区块");
  assert.ok(text.includes("实体改动"), "分类①实体改动");
  assert.ok(text.includes("后台行动"), "分类②后台行动");
  assert.ok(text.includes("消息传播"), "分类③消息传播");
  assert.ok(text.includes("失败行"), "分类④失败行");

  // 消息必须标信度：这条 delivery 的 confidence=rumor → 显示「传言」
  assert.ok(text.includes("传言"), `消息传播要带信度标签：${text.slice(0, 200)}`);
  // 后台行动的阻塞原因必须写明
  assert.ok(text.includes("NO_PATH"), "阻塞原因要写明");
  // 默认仅已知
  assert.ok(text.includes("仅已知"), "默认只显示已知范围");
  dom.window.close();
});

test("D08 失败行：行号与字段路径可见，且不冒充成功", async () => {
  const { dom, container } = await mountChangesPage({
    simulationView: simulationViewWith([]),
    receipts: [{
      receiptId: "r2", status: "failed", branchId: null,
      previousTime: 5, currentTime: 5, triggeredNpcIds: [], adoptedEventIds: [],
      summary: "行增量块不可用（DEPENDENCY_FAILED）。本轮未提交，世界与时间未变化；可重试推演。 首个问题：第 2 行 ROW_NOT_FOUND @ $.ref",
      retryable: true,
    }],
  });
  const text = container.textContent ?? "";
  assert.ok(text.includes("失败行（1）"), "失败行计数如实");
  assert.ok(text.includes("第 2 行"), `失败行要能读到具体行号：${text.slice(0, 300)}`);
  assert.ok(text.includes("$.ref"), "失败行要能读到字段路径");
  dom.window.close();
});

test("D08 作者开关：默认仅已知；点「查看全部幕后推演」才请求全量，并说明它不改数据", async () => {
  const { dom, container, visibilityCalls } = await mountChangesPage({
    simulationView: simulationViewWith([
      {
        id: "evt:1", simulationId: "sig:1", kind: "signal", actorCharacterId: null,
        fromLocationId: "loc:1", toLocationId: "loc:1", status: "published",
        reasonCode: null, summary: "消息已公开：使者带出宣战文书", visibility: "known", period: 5,
      },
    ]),
  });
  const buttons = [...container.querySelectorAll("button")];
  const toggle = buttons.find((node) => (node.textContent ?? "").includes("查看全部幕后推演"));
  assert.ok(toggle, "有「查看全部幕后推演」按钮");
  assert.ok((container.textContent ?? "").includes("只是作者视图"),
    "必须说明全量视图只是作者视图、不改变谁真的知道什么");

  toggle.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(visibilityCalls, ["all"], "点击后请求全量视图");
  dom.window.close();
});

test("D08 旧会话：没有 simulationView 时给明确说明，不假装「没有动向」", async () => {
  const { dom, container } = await mountChangesPage({ simulationView: null });
  const text = container.textContent ?? "";
  assert.ok(text.includes("幕后推演"), "区块仍在（作者看得到开关与说明）");
  assert.ok(text.includes("还没有推演数据"), "明确说明是旧会话没有该数据，而不是断言「没有动向」");
  dom.window.close();
});

test("日志页把本轮宿主与引擎拒绝行交错显示，并直接展示全部字段路径", async () => {
  const at = (seconds) => `2026-09-26T12:37:${String(seconds).padStart(2, "0")}.000Z`;
  const base = { level: "error", outcome: "failed", source: "engine" };
  const { dom, container } = await mountChangesPage({
    page: "logs", simulationView: null,
    diagnostics: [
      { at: at(1), level: "info", source: "host", code: "TURN_STARTED",
        phase: "message", outcome: "started", traceId: "turn-abc-1" },
      { ...base, at: at(2), code: "WORLD_TURN_DELTA_REJECTED", phase: "world-turn-delta-rejected",
        details: { count: 3, reasonCode: "PARSE_REJECTED" } },
      ...[
        [3, 1, "QUOTE_REQUIRED", "$.quote"],
        [4, 2, "DEPENDENCY_FAILED", "$.locationRef"],
        [5, 3, "DEPENDENCY_FAILED", "$.patch.locationRef"],
      ].map(([second, rowLine, reasonCode, schemaPath]) => ({
        ...base, at: at(second), code: "WORLD_TURN_DELTA_ROW_REJECTED",
        phase: "world-turn-delta-row-rejected", details: { rowLine, reasonCode, schemaPath },
      })),
      { ...base, source: "ui", at: at(6), code: "COMMIT_FAILED", phase: "response",
        traceId: "turn-abc-1", errorCode: "RESPONSE_MALFORMED" },
    ],
  });
  const rows = [...container.querySelectorAll(".aw-log__row")];
  assert.equal(rows.length, 6, "一条展开的时间线包含 UI 与引擎事件");
  assert.equal(container.querySelectorAll(".aw-log__timeline").length, 0, "不再把后台事件折叠成第二组");
  assert.match(rows[0].textContent, /COMMIT_FAILED/);
  assert.match(rows[1].textContent, /\$\.patch\.locationRef/);
  assert.match(rows[2].textContent, /\$\.locationRef/);
  assert.match(rows[3].textContent, /QUOTE_REQUIRED/);
  assert.match(rows[3].textContent, /"rowLine":1/);
  dom.window.close();
});
