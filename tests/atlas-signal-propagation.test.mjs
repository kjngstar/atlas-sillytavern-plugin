/**
 * atlas-signal-propagation.test.mjs — D02 / D11a 定向验收（消息逐跳传播）。
 *
 * 对照计划 §2.5 与 D02 的完成标准：
 *  - 第 0 时段**一步都不走**（只有发起地 + 真正同地目击，那部分由 applySimulationEffects 负责）；
 *  - 每完整新时段沿**已确认的边**走 1 跳；同轮跨多个时段按真实时段数推进；
 *  - 没有边就是 NO_PATH，容器 parent 链不是通道；
 *  - 「在接收点」才算获知——关联人物不等于直接得知；
 *  - 每回合最多 8 个新收件人 / 20 个候选扫描，超限存游标、下一轮接着处理，不丢候选；
 *  - 同一 signal + 同一收件人幂等去重。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ATLAS_SIGNAL_MAX_NEW_RECIPIENTS,
  ATLAS_SIGNAL_MAX_SCANS,
  planSignalSpread,
  reachableLocationsWithin,
} from "../src/atlas-signal-propagation.ts";

function topology(edges) {
  return { edges, areas: [], vehicles: [] };
}

function edge(from, to, overrides = {}) {
  return {
    id: `edge:${from}->${to}`,
    fromLocationId: from,
    toLocationId: to,
    kind: "adjacent",
    evidence: "story",
    channel: "walk",
    ...overrides,
  };
}

function signal(overrides = {}) {
  return {
    id: "sig:1", originLocationId: "loc:a", topic: "使者带出宣战文书", sourceTurnKey: "turn-1",
    sourceQuoteId: "quote-1", publishedPeriod: 0, visibility: "known", status: "active",
    propagationCursor: 0, ...overrides,
  };
}

function baseInput(overrides = {}) {
  return {
    topology: topology([edge("loc:a", "loc:b")]),
    signals: [signal()],
    deliveries: [],
    characterLocations: [],
    period: 1,
    periodsElapsed: 1,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * 定时语义
 * ------------------------------------------------------------------ */

test("D02 第 0 时段：一步都不走，只登记 NO_TIME", () => {
  const result = planSignalSpread(baseInput({ periodsElapsed: 0, period: 0 }));
  assert.equal(result.deliveries.length, 0, "时间未推进不得跨区送达");
  assert.ok(result.diagnostics.some((d) => d.code === "NO_TIME"), "要具名说明为什么没动");
});

test("D02 每时段走 1 跳；同轮跨多时段按真实时段数推进", () => {
  const chain = topology([edge("loc:a", "loc:b"), edge("loc:b", "loc:c"), edge("loc:c", "loc:d")]);

  const oneHop = planSignalSpread(baseInput({ topology: chain, periodsElapsed: 1 }));
  assert.deepEqual(oneHop.deliveries.map((d) => d.recipientId), ["loc:b"], "1 时段只到相邻点");

  const twoHops = planSignalSpread(baseInput({ topology: chain, periodsElapsed: 2 }));
  assert.deepEqual(twoHops.deliveries.map((d) => d.recipientId).sort(), ["loc:b", "loc:c"]);
  assert.equal(twoHops.deliveries.find((d) => d.recipientId === "loc:c").confidence, "rumor",
    "多跳之后只是传言，不是已核实事实");
  assert.equal(twoHops.deliveries.find((d) => d.recipientId === "loc:b").confidence, "confirmed");

  const three = planSignalSpread(baseInput({ topology: chain, periodsElapsed: 3 }));
  assert.deepEqual(three.deliveries.map((d) => d.recipientId).sort(), ["loc:b", "loc:c", "loc:d"]);
});

test("D02 没有已确认的边 → NO_PATH，绝不猜路径", () => {
  const result = planSignalSpread(baseInput({ topology: topology([]) }));
  assert.equal(result.deliveries.length, 0);
  assert.ok(result.diagnostics.some((d) => d.code === "NO_PATH"));
});

test("D02 可达集只由边决定：与谁同名、谁包含谁无关", () => {
  const map = reachableLocationsWithin(topology([edge("loc:a", "loc:b")]), "loc:a", 5);
  assert.deepEqual([...map.keys()].sort(), ["loc:a", "loc:b"]);
  // 起点自己算 0 跳
  assert.equal(map.get("loc:a"), 0);
  // 没有边的地点完全不可达（不会因为名字像就被连上）
  assert.equal(map.has("loc:city"), false);
});

/* ------------------------------------------------------------------ *
 * 谁能得知：receipts 才算证据
 * ------------------------------------------------------------------ */

test("D02 只有身处接收点的人获知；关联人物不等于直接得知", () => {
  const result = planSignalSpread(baseInput({
    topology: topology([edge("loc:a", "loc:b"), edge("loc:b", "loc:c")]),
    periodsElapsed: 1,
    characterLocations: [
      { id: "npc:at-b", locationId: "loc:b" },
      { id: "npc:at-c", locationId: "loc:c" },
      { id: "npc:nowhere", locationId: null },
    ],
  }));
  const recipients = result.deliveries.map((d) => `${d.recipientType}:${d.recipientId}`);
  assert.ok(recipients.includes("location:loc:b"));
  assert.ok(recipients.includes("character:npc:at-b"), "在场的人算获知");
  assert.ok(!recipients.includes("character:npc:at-c"), "1 跳之外的人还不知情");
  assert.ok(!recipients.includes("character:npc:nowhere"), "位置未知的人不得凭空得知");
});

test("D02 幂等：同一 signal + 同一收件人不会重复产生送达", () => {
  const existing = [{ signalId: "sig:1", recipientType: "location", recipientId: "loc:b" }];
  const result = planSignalSpread(baseInput({ deliveries: existing }));
  assert.ok(!result.deliveries.some((d) => d.recipientId === "loc:b"), "已送达的地点不重复写");
});

test("D02 每份送达都带来源与时段，可核对「谁在何时何地听到」", () => {
  const result = planSignalSpread(baseInput({ periodsElapsed: 1, period: 42 }));
  const first = result.deliveries[0];
  assert.equal(first.fromLocationId, "loc:a", "来源 = 发起地");
  assert.equal(first.receivedPeriod, 42, "receivedPeriod = 当前时间游标");
  assert.equal(first.signalId, "sig:1");
  assert.ok(["witness", "travel", "messenger", "contact", "faction", "explicit-channel"].includes(first.via));
});

/* ------------------------------------------------------------------ *
 * 有界与游标
 * ------------------------------------------------------------------ */

test("D02 上限：每回合最多 8 个新收件人，超出存游标不丢候选", () => {
  // 一条长链：1 时段最多能到 loc:b，用大 periodsElapsed 让候选远超上限
  const edges = [];
  for (let index = 0; index < 40; index += 1) {
    edges.push(edge(`loc:${index}`, `loc:${index + 1}`));
  }
  const result = planSignalSpread(baseInput({
    topology: topology(edges),
    signals: [signal({ originLocationId: "loc:0" })],
    periodsElapsed: 40,
    period: 40,
  }));
  assert.ok(result.deliveries.length <= ATLAS_SIGNAL_MAX_NEW_RECIPIENTS,
    `新收件人不得超过 ${ATLAS_SIGNAL_MAX_NEW_RECIPIENTS}：实际 ${result.deliveries.length}`);
  assert.ok(result.scanned <= ATLAS_SIGNAL_MAX_SCANS, `扫描不得超过 ${ATLAS_SIGNAL_MAX_SCANS}`);
  assert.ok(result.backlog > 0, "有剩余候选必须如实计数");
  assert.ok(result.cursors["sig:1"] > 0, "游标必须前进，供下一轮续传");
  assert.ok(result.diagnostics.some((d) => d.code === "BACKLOG"));
});

test("D02 游标续传：下一轮从上次停下的地方继续，且不重复已送达的", () => {
  const edges = [];
  for (let index = 0; index < 40; index += 1) {
    edges.push(edge(`loc:${index}`, `loc:${index + 1}`));
  }
  const topo = topology(edges);
  const first = planSignalSpread(baseInput({
    topology: topo, signals: [signal({ originLocationId: "loc:0" })], periodsElapsed: 40, period: 40,
  }));
  const second = planSignalSpread(baseInput({
    topology: topo,
    signals: [signal({ originLocationId: "loc:0", propagationCursor: first.cursors["sig:1"] })],
    deliveries: first.deliveries.map((d) => ({
      signalId: d.signalId, recipientType: d.recipientType, recipientId: d.recipientId,
    })),
    periodsElapsed: 40,
    period: 41,
  }));
  const firstIds = new Set(first.deliveries.map((d) => d.recipientId));
  assert.ok(second.deliveries.length > 0, "续传必须真的继续处理");
  for (const delivery of second.deliveries) {
    assert.ok(!firstIds.has(delivery.recipientId), `不得重复投递：${delivery.recipientId}`);
  }
});

test("D02 非活动信号不传播（cancelled 就停）", () => {
  const result = planSignalSpread(baseInput({ signals: [signal({ status: "cancelled" })] }));
  assert.equal(result.deliveries.length, 0);
});

test("D02 通信边可用于传讯（消息传播复用同一张边表）", () => {
  const result = planSignalSpread(baseInput({
    topology: topology([edge("loc:a", "loc:far", { kind: "communication", channel: "message" })]),
    periodsElapsed: 1,
  }));
  assert.deepEqual(result.deliveries.map((d) => d.recipientId), ["loc:far"],
    "communication 边是消息通道，风声可以沿它走");
});

test("D02 纯函数：不改输入，同输入同输出", () => {
  const input = baseInput({
    topology: topology([edge("loc:a", "loc:b")]),
    characterLocations: [{ id: "npc:x", locationId: "loc:b" }],
  });
  const snapshot = JSON.stringify(input);
  const first = planSignalSpread(input);
  const second = planSignalSpread(input);
  assert.equal(JSON.stringify(input), snapshot, "入参一字不改");
  assert.deepEqual(first, second, "同输入逐字节同输出");
});
