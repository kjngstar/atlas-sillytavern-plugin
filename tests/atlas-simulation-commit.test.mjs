/**
 * atlas-simulation-commit.test.mjs — C09 / C10 / D05 端到端验收。
 *
 * 计划 §2.1「请求返回的 session.simulation 与 world/tables/turns 同一份候选会话一次保存」
 * 与 C09 / C10 / D05 的完成标准：
 *  1. 一次合法 table-delta 回合之后，`session.simulation` 出现本分支的推演任务，
 *     并且这一回合的 `simulationEvents` / `simulationUndo` 落在**同一份**会话文档里；
 *  2. 重复同一 turnKey 不重复产生事件（幂等）；
 *  3. `/state` 的 `simulationView` 能读回同一条已归档行动，且带真实 counts / truncated；
 *  4. 回退（rollback）后推演模块跟着回退，回合事件从可见视图消失；
 *  5. 旧会话（没有 simulation 字段）仍照常提交，且被当作**合法空模块**而不是损坏。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildWorldFromTemplate, getDemoTemplate } from "../lib/demo-events.ts";
import { parseWorld } from "../lib/world-schema.ts";
import { createAtlasServerCore, createMemoryDocumentStore } from "../src/atlas-server.ts";
import { createSessionCarrier, carrierAsCore } from "./atlas-session-helper.mjs";
import { scaleCalibrationKey } from "../src/atlas-scale.ts";

const NOW = 1_700_000_000_000;
const CURRENT_TIME = 418.07;
const CANON = "chronicle-canon";
/** 推演模块按 **branchKey** 分桶；正史线的 branchKey 是 `canon`（由 branchScopeForStory 得出）。 */
const BRANCH_KEY = "canon";
const SECRET = "sk-sim-secret-0001";

function jsonResponse(status, payload) {
  const raw = JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(raw), text: async () => raw };
}

function textResponse(status, content) {
  return jsonResponse(status, { choices: [{ message: { content } }] });
}

function buildWorld() {
  const base = buildWorldFromTemplate(getDemoTemplate("chronicle"), { id: "atlas-sim-fixture", now: 1000 });
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

/**
 * 一条「人物有行动倾向与目标」的合法行增量。
 * quote 必须连续逐字出现在助手正文里（与三表行的引文校验同口径）。
 */
function characterEditBlock() {
  return [
    "<atlasEdit>",
    JSON.stringify({
      table: "character", op: "set", ref: "npc:chronicle-c1",
      patch: { actionTendency: "赶往钟楼", targetLocationRef: "loc:9001" },
      basis: "observed", quote: "他决定赶往钟楼",
    }),
    "</atlasEdit>",
  ].join("\n");
}

/**
 * E04：一条 `simulation.propose` 行 —— 只登记「一件已公开的事实」。
 * quote 必须连续逐字出现在助手正文里（`signalBlock` 与下面的 commit 正文成对使用）。
 */
function signalBlock() {
  return [
    "<atlasEdit>",
    JSON.stringify({
      table: "simulation", op: "propose", ref: "new:sim:declaration", kind: "signal",
      originRef: "loc:9001", topic: "使者已带出宣战文书",
      quote: "使者带着宣战文书离开了钟楼", basis: "observed",
    }),
    "</atlasEdit>",
  ].join("\n");
}

async function setup({ scripts, session = null }) {
  const store = createMemoryDocumentStore();
  const world = buildWorld();
  let call = 0;
  const fetchFn = async () => {
    const script = scripts[Math.min(call, scripts.length - 1)];
    call += 1;
    if (!script) throw new Error("意外触发了模型请求");
    return script();
  };
  const rawCore = createAtlasServerCore({ store, fetchFn, now: () => NOW });
  const carrier = createSessionCarrier(rawCore, session ? { session } : {});
  const core = carrierAsCore(carrier);
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: bindingFor(world) });
  await core.handle("PUT", "/settings", {
    worldTurn: { name: "模拟推演", endpoint: "https://mock.example.invalid/v1", model: "atlas-mock", apiKey: SECRET, timeoutMs: 5000 },
  }, { local: true });
  await core.handle("PUT", "/settings", { action: "runtime.update", worldTurnProtocol: "table-delta-v1" }, { local: true });
  return { store, core, carrier, world };
}

function commitBody(overrides = {}) {
  return {
    turnId: "turn-x", chatId: "chat-a", userMessageId: "msg-10", assistantMessageId: "msg-11",
    swipeId: null, userText: "我跟着他。",
    assistantText: "他决定赶往钟楼，随后消失在街角。",
    ...overrides,
  };
}

test("C09：一次 table-delta 回合把 simulation 与 world/tables/turns 写进同一份会话", async () => {
  const { core, carrier } = await setup({ scripts: [() => textResponse(200, characterEditBlock())] });
  const result = await core.handle("POST", "/turns/commit", commitBody());
  assert.equal(result.status, 200, `应提交成功：${JSON.stringify(result.body.error ?? {})}`);

  // ① 推演模块随会话落盘，且是本分支
  const simulation = carrier.session.simulation;
  assert.ok(simulation, "session.simulation 必须存在");
  assert.equal(simulation.schemaVersion, 1);
  assert.equal(simulation.worldId, carrier.session.binding.worldId);
  const branch = simulation.branches[BRANCH_KEY];
  assert.ok(branch, "本分支推演数据必须存在");
  assert.ok(branch.tasks.length >= 1, "人物有行动倾向 → 至少一条推演任务");
  assert.ok(branch.tasks.every((row) => typeof row.id === "string" && row.id.length > 0), "任务 id 稳定非空");

  // ② 本轮事件与逐行 undo 落在同一个回合映射文档里
  const turnKeys = Object.keys(carrier.session.turns ?? {});
  assert.equal(turnKeys.length, 1, "恰好一条回合映射");
  const turn = carrier.session.turns[turnKeys[0]];
  assert.ok(Array.isArray(turn.simulationEvents), "回合记录带 simulationEvents");
  assert.ok(Array.isArray(turn.simulationUndo), "回合记录带 simulationUndo");
  assert.ok(turn.simulationEvents.length >= 1, "本轮至少归档一条推演事件");
  // 事件只说明已验证事实；摘要按 §2.1 有界 160 字
  for (const event of turn.simulationEvents) {
    assert.ok(typeof event.summary === "string" && event.summary.length > 0);
    assert.ok(event.summary.length <= 160, "事件摘要有界 160 字");
  }

  // ③ 会话里没有第二个世界身份（拒绝跨世界）
  assert.equal(simulation.worldId, carrier.session.world.id);
});

test("C09：重复同一 turnKey 幂等——事件与任务都不重复", async () => {
  const { core, carrier } = await setup({ scripts: [() => textResponse(200, characterEditBlock())] });
  const first = await core.handle("POST", "/turns/commit", commitBody());
  assert.equal(first.status, 200);
  const tasksAfterFirst = carrier.session.simulation.branches[BRANCH_KEY].tasks.length;
  const eventsAfterFirst = Object.values(carrier.session.turns)[0].simulationEvents.length;

  // 同一 turnKey 重放
  const second = await core.handle("POST", "/turns/commit", commitBody());
  assert.equal(second.body.data?.receipt?.status, "duplicate", "重复提交应判 duplicate");
  assert.equal(carrier.session.simulation.branches[BRANCH_KEY].tasks.length, tasksAfterFirst, "任务不重复");
  assert.equal(Object.values(carrier.session.turns)[0].simulationEvents.length, eventsAfterFirst, "事件不重复");
  assert.equal(Object.keys(carrier.session.turns).length, 1, "回合映射不重复");
});

test("D05：/state 的 simulationView 能读回已归档行动，并带真实 counts", async () => {
  const { core, carrier } = await setup({ scripts: [() => textResponse(200, characterEditBlock())] });
  await core.handle("POST", "/turns/commit", commitBody());

  const state = await core.handle("POST", "/state", { chatId: "chat-a" });
  assert.equal(state.status, 200, `状态读取应成功：${JSON.stringify(state.body.error ?? {})}`);
  const view = state.body.data.simulationView;
  assert.ok(view, "/state 必须带只读 simulationView");
  assert.equal(view.branchKey, BRANCH_KEY);
  assert.ok(Array.isArray(view.recentEvents), "recentEvents 是数组");
  assert.ok(view.recentEvents.length >= 1, "重开界面仍能看到同一条已归档行动");
  assert.equal(view.counts.events, Object.values(carrier.session.turns)[0].simulationEvents.length);
  assert.equal(typeof view.currentLocationKnown, "boolean");
  assert.equal(view.visibility, "known", "默认只出「已知」");
  assert.equal(view.corrupt, false);
  // 有界截断：视图条数不超过服务端上限
  assert.ok(view.tasks.length <= 20 && view.signals.length <= 12
    && view.deliveries.length <= 24 && view.recentEvents.length <= 16, "视图各自有界");
});

test("C10：回退后推演模块跟着回退，回合事件从可见视图消失", async () => {
  const { core, carrier } = await setup({ scripts: [() => textResponse(200, characterEditBlock())] });
  const committed = await core.handle("POST", "/turns/commit", commitBody());
  assert.equal(committed.status, 200);
  const tasksBefore = carrier.session.simulation.branches[BRANCH_KEY].tasks.length;
  assert.ok(tasksBefore >= 1);

  const rolled = await core.handle("POST", "/turns/rollback", {
    chatId: "chat-a", assistantMessageId: "msg-11",
  });
  assert.equal(rolled.status, 200, `回退应成功：${JSON.stringify(rolled.body.error ?? {})}`);

  // ① 推演模块逐行回退：本回合新建的任务被撤销
  assert.equal(carrier.session.simulation.branches[BRANCH_KEY].tasks.length, 0, "本回合新建的推演任务应被撤销");

  // ② 已回退回合的事件不再出现在可见视图里（文档保留 = 可审计）
  const state = await core.handle("POST", "/state", { chatId: "chat-a" });
  assert.equal(state.status, 200);
  assert.equal(state.body.data.simulationView.recentEvents.length, 0, "回退后不得再看到该回合的幕后事件");
});

test("C09 兼容：旧会话没有 simulation 字段时照常提交，并按合法空模块处理", async () => {
  const world = buildWorld();
  const legacySession = {
    schemaVersion: 1,
    rev: 3,
    binding: bindingFor(world),
    world: JSON.parse(JSON.stringify(world)),
    maps: null,
    scene: null,
    turns: {},
    geoAuto: {},
    tables: null,
    // 刻意不写 simulation —— 旧会话形状
  };
  assert.equal("simulation" in legacySession, false);

  const { core, carrier } = await setup({
    scripts: [() => textResponse(200, characterEditBlock())],
    session: legacySession,
  });
  const result = await core.handle("POST", "/turns/commit", commitBody());
  assert.equal(result.status, 200, `旧会话应能照常提交：${JSON.stringify(result.body.error ?? {})}`);
  assert.ok(carrier.session.simulation, "提交后长出合法推演模块");
  assert.equal(carrier.session.simulation.worldId, carrier.session.world.id);
});

test("D04：回执写人类可读摘要 + bounded simulationCounts，不再只会说「应用 N 行」", async () => {
  const { core } = await setup({ scripts: [() => textResponse(200, characterEditBlock())] });
  const result = await core.handle("POST", "/turns/commit", commitBody());
  assert.equal(result.status, 200, `应提交成功：${JSON.stringify(result.body.error ?? {})}`);
  const receipt = result.body.data.receipt;

  assert.ok(typeof receipt.summary === "string" && receipt.summary.length > 0, "回执必须有摘要");
  // F1：截图里反复出现的「表格增量：应用 5 行」不得再是唯一内容
  assert.ok(!receipt.summary.startsWith("表格增量：应用"), "摘要不再以表格行数开头");
  assert.ok((receipt.summary.match(/表格增量：应用/g) ?? []).length <= 1, "最多出现一次，不重复两次");
  // 第 0 段有任务但无旅行时，要明确写「等待时间推进」
  assert.match(receipt.summary, /意图|等待时间推进/, "要能读出人物动向或时间状态");

  // D04：回执增有界计数；旧回执不带该字段仍合法（前端不得据此判断成功）
  assert.ok(receipt.simulationCounts, "回执带 simulationCounts");
  for (const key of ["tasks", "signals", "deliveries", "blocked"]) {
    assert.equal(typeof receipt.simulationCounts[key], "number", `simulationCounts.${key} 是数字`);
    assert.ok(receipt.simulationCounts[key] >= 0, `simulationCounts.${key} 非负`);
  }
  assert.ok(receipt.simulationCounts.tasks >= 1, "本回合至少一条推演任务");
  assert.ok(receipt.summary.length <= 480, "摘要按既有口径有界");
});

test("D09：world.stateEvents 为空时，世界书「近期动向」仍来自 simulationEvents（F2 修复点）", async () => {
  const { core, carrier } = await setup({ scripts: [() => textResponse(200, characterEditBlock())] });
  const result = await core.handle("POST", "/turns/commit", commitBody());
  assert.equal(result.status, 200, `应提交成功：${JSON.stringify(result.body.error ?? {})}`);

  // F2 的前提就是「三表变了、stateEvents 没变」
  assert.deepEqual(carrier.session.world.stateEvents ?? [], [], "本轮 world.stateEvents 不新增（现状）");

  const lorebook = result.body.data.lorebook;
  assert.ok(lorebook, "committed 回合必须产出世界书规划");
  const entry = lorebook.entries.find((item) => item.category === "moves") ?? lorebook.entries[0];
  assert.ok(entry && typeof entry.content === "string", "有可读条目内容");
  const content = entry.content;

  assert.match(content, /近期动向：/, "条目带「近期动向」段");
  // 这就是修复点：旧路径在这里只会写「（暂无已归档的世界变化）」
  assert.ok(!content.includes("暂无已归档的世界变化"),
    "三表回合没有 stateEvents 时，动向必须来自 simulationEvents 而不是空占位");
  assert.match(content, /意图|赶往钟楼/, "动向里能读到本轮的推演事件摘要");
});

test("D09：hidden 的推演事件不透出到世界书（未送达 / 秘密不进主聊天注入）", async () => {
  const { core } = await setup({ scripts: [() => textResponse(200, characterEditBlock())] });
  const result = await core.handle("POST", "/turns/commit", commitBody());
  assert.equal(result.status, 200);

  const entry = result.body.data.lorebook.entries.find((item) => item.category === "moves");
  assert.ok(entry, "有 moves 条目");
  // 本轮所有事件都是 known（模型提出的 intent 默认可见），因此条目里不应出现 hidden 标记
  assert.ok(!/hidden|秘密/.test(entry.content), "不得把 hidden 内容写进注入文本");
  assert.ok(entry.content.length <= 4000, "条目内容按既有上限有界");
});

test("E04+D02 端到端：时段 0 只到发起地；有时段 + 已确认边之后才逐跳传播", async () => {
  const { core, carrier } = await setup({ scripts: [
    () => textResponse(200, characterEditBlock()),
    // 第二轮：只提一条已公开事实（没有三表改动）
    () => textResponse(200, signalBlock()),
    () => textResponse(200, signalBlock("msg-13")),
  ] });

  // 第一轮先让三表与推演模块落地
  const first = await core.handle("POST", "/turns/commit", commitBody());
  assert.equal(first.status, 200, `第一轮应成功：${JSON.stringify(first.body.error ?? {})}`);

  // 从真实三表取两个地点行，铺一条**已确认**的邻接边
  const locations = carrier.session.tables.branches[BRANCH_KEY].locations;
  assert.ok(locations.length >= 2, "夹具至少要有两个地点");
  // signal.propose 的 originRef 是 loc:9001（钟楼），必须拿真实行做发起地
  const origin = locations.find((row) => row.id === "loc:9001") ?? locations[0];
  const neighbor = locations.find((row) => row.id !== origin.id);
  assert.ok(neighbor, "需要另一个地点作为邻接接收点");
  carrier.session.simulation.branches[BRANCH_KEY].geoTopology.edges.push({
    id: `edge:${origin.id}->${neighbor.id}`,
    fromLocationId: origin.id, toLocationId: neighbor.id,
    kind: "adjacent", evidence: "story", channel: "walk",
  });

  // 第二轮：时间**不推进**（用户正文没有时间词）→ 风声一步都不许走
  const zeroTime = await core.handle("POST", "/turns/commit", {
    ...commitBody({
      userMessageId: "msg-12", assistantMessageId: "msg-12b",
      assistantText: "使者带着宣战文书离开了钟楼。",
    }),
    userText: "我看着他离开。",
  });
  assert.equal(zeroTime.status, 200, `第二轮应成功：${JSON.stringify(zeroTime.body.error ?? {})}`);
  const branchAfterZero = carrier.session.simulation.branches[BRANCH_KEY];
  const signals = branchAfterZero.signals;
  assert.equal(signals.length, 1, "propose 只创建一条 signal");
  const signalId = signals[0].id;
  const deliveredAtZero = branchAfterZero.deliveries.filter((row) => row.signalId === signalId);
  assert.ok(deliveredAtZero.some((row) => row.recipientType === "location" && row.recipientId === origin.id),
    "发起地本身算一处送达");
  assert.ok(!deliveredAtZero.some((row) => row.recipientId === neighbor.id),
    "第 0 时段绝不跨区：邻接地点不得已知");

  // 第三轮：明确的时间流逝 + 已确认边 → 风声走 1 跳
  const advanced = await core.handle("POST", "/turns/commit", {
    ...commitBody({ userMessageId: "msg-13", assistantMessageId: "msg-14" }),
    userText: "接下来一整天我们都在赶路。",
    assistantText: "使者带着宣战文书离开了钟楼。",
  });
  assert.equal(advanced.status, 200, `第三轮应成功：${JSON.stringify(advanced.body.error ?? {})}`);
  const after = carrier.session.simulation.branches[BRANCH_KEY];
  assert.ok(after.signals.length >= 1, "时间推进后信号仍在队列里");
  const reachedNeighbor = after.deliveries.some((row) => row.recipientId === neighbor.id);
  assert.ok(reachedNeighbor, "有时段 + 已确认边之后，风声应传到相邻地点");
});

test("E04：simulation.propose 的引文必须逐字命中助手正文，否则只拒该行", async () => {
  const block = [
    "<atlasEdit>",
    JSON.stringify({
      table: "simulation", op: "propose", ref: "new:sim:x", kind: "signal",
      originRef: "loc:9001", topic: "使者已带出宣战文书",
      quote: "这句话根本不在正文里", basis: "observed",
    }),
    "</atlasEdit>",
  ].join("\n");
  const { core, carrier } = await setup({ scripts: [() => textResponse(200, block)] });
  const result = await core.handle("POST", "/turns/commit", commitBody());
  assert.equal(result.status, 502, "整块只有无效行 → 整轮失败，不当作 noop");
  assert.match(String(result.body.error?.message ?? ""), /第 1 行|QUOTE_NOT_FOUND|行增量/, "错误要指向具体行/原因");
  assert.equal(carrier.session.simulation ?? null, null, "失败不得半截写入推演模块");
});

test("停机线：解析失败不得生成时段、地图或任何一表的更新", async () => {
  // ① 完全没有块（纯 prose）
  {
    const { core, carrier } = await setup({
      scripts: [() => textResponse(200, "他决定赶往钟楼，随后消失在街角。")],
    });
    const before = {
      world: JSON.stringify(carrier.session.world),
      tables: JSON.stringify(carrier.session.tables),
      cursor: carrier.session.binding.worldTimeCursor,
      turns: Object.keys(carrier.session.turns ?? {}).length,
    };
    const result = await core.handle("POST", "/turns/commit", commitBody());
    assert.equal(result.status, 502, "没有完整块 → 整轮失败");
    assert.equal(carrier.session.binding.worldTimeCursor, before.cursor, "时间游标一步都不能动");
    assert.equal(JSON.stringify(carrier.session.world), before.world, "世界不得半截更新");
    assert.equal(JSON.stringify(carrier.session.tables), before.tables, "三表不得半截更新");
    assert.equal(Object.keys(carrier.session.turns ?? {}).length, before.turns, "失败不落回合记录");
    assert.equal(carrier.session.simulation ?? null, null, "失败不建推演模块");
  }

  // ② 块存在但整块语法坏掉（未闭合）
  {
    const { core, carrier } = await setup({
      scripts: [() => textResponse(200, '<atlasEdit>\n{"table":"location","op":"set","ref":"loc:9001"\n')],
    });
    const cursorBefore = carrier.session.binding.worldTimeCursor;
    const result = await core.handle("POST", "/turns/commit", commitBody());
    assert.equal(result.status, 502, "未闭合块 → 整轮失败");
    assert.equal(carrier.session.binding.worldTimeCursor, cursorBefore, "时间未推进");
    assert.equal(carrier.session.simulation ?? null, null, "零推演写入");
  }
});

test("H09：/state 只下发**当前分支**的已确认拓扑（切 IF 不沿用正史）", async () => {
  const { core, carrier } = await setup({ scripts: [() => textResponse(200, characterEditBlock())] });
  await core.handle("POST", "/turns/commit", commitBody());

  const locations = carrier.session.tables.branches[BRANCH_KEY].locations;
  const [origin, neighbor] = locations;
  assert.ok(origin && neighbor, "夹具要有两个地点");
  carrier.session.simulation.branches[BRANCH_KEY].geoTopology.edges.push({
    id: `edge:${origin.id}->${neighbor.id}`,
    fromLocationId: origin.id, toLocationId: neighbor.id,
    kind: "adjacent", evidence: "story", channel: "walk",
  });

  const state = await core.handle("POST", "/state", { chatId: "chat-a" });
  assert.equal(state.status, 200);
  const topology = state.body.data.map.geoTopology;
  assert.ok(topology, "/state 必须带只读 geoTopology（H09）");
  assert.equal(topology.branchKey, BRANCH_KEY);
  assert.equal(topology.counts.edges, 1, "本分支的已确认边要下发");
  assert.equal(topology.edges[0].fromLocationId, origin.id);
  assert.equal(topology.truncated.edges, 0);
  assert.ok(Array.isArray(topology.areas) && Array.isArray(topology.vehicleAnchors),
    "范围与载具锚点各是数组（无数据时为空，不省略字段）");

  // 另一个分支有自己的空拓扑：当前分支的视图不得借用它
  carrier.session.simulation.branches["story-if"] = {
    tasks: [], signals: [], deliveries: [], geoTopology: { edges: [], areas: [], vehicles: [] },
  };
  const again = await core.handle("POST", "/state", { chatId: "chat-a" });
  assert.equal(again.body.data.map.geoTopology.branchKey, BRANCH_KEY, "按当前分支取");
  assert.equal(again.body.data.map.geoTopology.counts.edges, 1, "不因为别的分支存在就丢自己的边");
});

/* ------------------------------------------------------------------ *
 * H07a：作者手动确认归属 / 邻接 / 载具 / 坐标
 * ------------------------------------------------------------------ */

async function setupTopologyFixture() {
  const fixture = await setup({ scripts: [() => textResponse(200, characterEditBlock())] });
  const committed = await fixture.core.handle("POST", "/turns/commit", commitBody());
  assert.equal(committed.status, 200, `前置回合应成功：${JSON.stringify(committed.body.error ?? {})}`);
  const rows = fixture.carrier.session.tables.branches[BRANCH_KEY].locations;
  assert.ok(rows.length >= 2, "需要至少两个地点");
  return { ...fixture, rows, cityId: rows[0].id, roomId: rows[1].id };
}

test("H07a：set-parent 把地点放进上级（含环 / 深度 / 自指防护），并真的落盘", async () => {
  const { core, carrier, rows, cityId, roomId } = await setupTopologyFixture();

  const saved = await core.handle("POST", "/maps/topology/confirm", {
    chatId: "chat-a", operation: "set-parent", locationId: roomId, targetLocationId: cityId,
  });
  assert.equal(saved.status, 200, `应保存成功：${JSON.stringify(saved.body.error ?? {})}`);
  assert.equal(saved.body.data.status, "saved");
  assert.equal(saved.body.data.branchKey, BRANCH_KEY, "分支由服务端绑定派生");

  const row = carrier.session.tables.branches[BRANCH_KEY].locations.find((item) => item.id === roomId);
  assert.equal(row.parentLocationId, cityId, "归属真的写进三表");

  // 自指 / 成环一律拒绝，且不改数据
  const before = JSON.stringify(carrier.session.tables.branches[BRANCH_KEY].locations);
  const selfParent = await core.handle("POST", "/maps/topology/confirm", {
    chatId: "chat-a", operation: "set-parent", locationId: roomId, targetLocationId: roomId,
  });
  assert.equal(selfParent.status, 400, "自指必须被拒");
  assert.match(String(selfParent.body.error?.message ?? ""), /\$\.targetLocationId/, "错误要指到字段路径");
  const cycle = await core.handle("POST", "/maps/topology/confirm", {
    chatId: "chat-a", operation: "set-parent", locationId: cityId, targetLocationId: roomId,
  });
  assert.equal(cycle.status, 400, "成环必须被拒");
  assert.equal(JSON.stringify(carrier.session.tables.branches[BRANCH_KEY].locations), before,
    "被拒绝的写入不得改动任何一表");

  // 解除包含
  const detached = await core.handle("POST", "/maps/topology/confirm", {
    chatId: "chat-a", operation: "set-parent", locationId: roomId, targetLocationId: null,
  });
  assert.equal(detached.status, 200);
  assert.equal(carrier.session.tables.branches[BRANCH_KEY].locations.find((item) => item.id === roomId).parentLocationId,
    null, "targetLocationId=null 表示解除包含");
  void rows;
});

test("H07a：set-adjacent / set-vehicle / confirm-coordinate 各写对地方，/state 立刻可见", async () => {
  const { core, carrier, cityId, roomId } = await setupTopologyFixture();

  const adjacent = await core.handle("POST", "/maps/topology/confirm", {
    chatId: "chat-a", operation: "set-adjacent", locationId: roomId, targetLocationId: cityId,
  });
  assert.equal(adjacent.status, 200, `set-adjacent 应成功：${JSON.stringify(adjacent.body.error ?? {})}`);
  const edges = carrier.session.simulation.branches[BRANCH_KEY].geoTopology.edges;
  assert.equal(edges.length, 1);
  assert.equal(edges[0].kind, "adjacent");
  assert.equal(edges[0].evidence, "manual", "人工确认的边必须标 manual");

  // 重复确认同一对地点：无序去重 → 不产生第二条边
  await core.handle("POST", "/maps/topology/confirm", {
    chatId: "chat-a", operation: "set-adjacent", locationId: cityId, targetLocationId: roomId,
  });
  assert.equal(carrier.session.simulation.branches[BRANCH_KEY].geoTopology.edges.length, 1,
    "(A,B) 与 (B,A) 是同一条边");

  const vehicle = await core.handle("POST", "/maps/topology/confirm", {
    chatId: "chat-a", operation: "set-vehicle", locationId: roomId, targetLocationId: cityId,
  });
  assert.equal(vehicle.status, 200, `set-vehicle 应成功：${JSON.stringify(vehicle.body.error ?? {})}`);
  const anchors = carrier.session.simulation.branches[BRANCH_KEY].geoTopology.vehicles;
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].id, roomId, "锚点 id 恒等于地点行 id");
  assert.equal(anchors[0].status, "stopped");
  assert.equal(anchors[0].atLocationId, cityId);

  const coord = await core.handle("POST", "/maps/topology/confirm", {
    chatId: "chat-a", operation: "confirm-coordinate", locationId: roomId, mapId: "world", gridX: 12, gridY: 34,
  });
  assert.equal(coord.status, 200, `confirm-coordinate 应成功：${JSON.stringify(coord.body.error ?? {})}`);
  const row = carrier.session.tables.branches[BRANCH_KEY].locations.find((item) => item.id === roomId);
  assert.equal(row.gridX, 12);
  assert.equal(row.gridY, 34);
  assert.equal(row.mapId, "world");
  assert.equal(carrier.session.maps.pointMeta[String(roomId).replace("loc:", "")].coordinateStatus, "confirmed",
    "同时把 maps.pointMeta 标成 confirmed（H06a）");

  // /state 立刻反映人工确认的结果
  const state = await core.handle("POST", "/state", { chatId: "chat-a" });
  const topology = state.body.data.map.geoTopology;
  assert.equal(topology.counts.edges, 1);
  assert.equal(topology.counts.vehicles, 1);
});

test("H07a：非法 operation / 越界坐标一律拒绝且零写入；未绑定聊天不可写", async () => {
  const { core, carrier, roomId } = await setupTopologyFixture();
  const before = JSON.stringify(carrier.session);

  const badOp = await core.handle("POST", "/maps/topology/confirm", {
    chatId: "chat-a", operation: "teleport", locationId: roomId,
  });
  assert.equal(badOp.status, 400);
  assert.match(String(badOp.body.error?.message ?? ""), /\$\.operation/);

  const badCoord = await core.handle("POST", "/maps/topology/confirm", {
    chatId: "chat-a", operation: "confirm-coordinate", locationId: roomId, gridX: -1, gridY: 0,
  });
  assert.equal(badCoord.status, 400, "负坐标必须被拒");
  assert.match(String(badCoord.body.error?.message ?? ""), /\$\.gridX/);

  const missingLocation = await core.handle("POST", "/maps/topology/confirm", {
    chatId: "chat-a", operation: "set-parent", locationId: "loc:999999", targetLocationId: null,
  });
  assert.equal(missingLocation.status, 400);
  assert.equal(JSON.stringify(carrier.session), before, "全部被拒的请求不得改动会话");
});

/* ------------------------------------------------------------------ *
 * H15a：作者手动涂色范围
 * ------------------------------------------------------------------ */

async function setupAreaFixture() {
  const fixture = await setup({ scripts: [() => textResponse(200, characterEditBlock())] });
  const committed = await fixture.core.handle("POST", "/turns/commit", commitBody());
  assert.equal(committed.status, 200);
  const rows = fixture.carrier.session.tables.branches[BRANCH_KEY].locations;
  // 世界图上的地点（mapId === "world"）
  const worldRow = rows.find((row) => row.mapId === "world");
  assert.ok(worldRow, "夹具里要有世界图地点");
  return { ...fixture, worldRow };
}

test("H15a：涂 20 格保存后仍在；同 id 再涂取代上一块；cells=[] 只删人工范围", async () => {
  const { core, carrier, worldRow } = await setupAreaFixture();

  const cells = [];
  for (let index = 0; index < 20; index += 1) cells.push({ x: index, y: 0 });
  const saved = await core.handle("POST", "/maps/areas/upsert", {
    chatId: "chat-a", mapId: "world", locationId: worldRow.id, cells,
  });
  assert.equal(saved.status, 200, `保存应成功：${JSON.stringify(saved.body.error ?? {})}`);
  assert.equal(saved.body.data.status, "saved");
  assert.equal(saved.body.data.cells, 20);
  assert.equal(saved.body.data.removed, false);

  const areas = carrier.session.simulation.branches[BRANCH_KEY].geoTopology.areas;
  assert.equal(areas.length, 1, "只产生一块范围");
  assert.equal(areas[0].evidence, "manual", "本端点只写 manual");
  assert.equal(areas[0].cells.length, 20);
  assert.equal(areas[0].mapId, "world");
  assert.equal(areas[0].locationId, worldRow.id);
  const areaId = areas[0].id;

  // 同 id 更新取代上一次手工范围（不叠加）
  const replaced = await core.handle("POST", "/maps/areas/upsert", {
    chatId: "chat-a", mapId: "world", locationId: worldRow.id,
    cells: [{ x: 5, y: 5 }, { x: 5, y: 6 }],
  });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.data.areaId, areaId, "areaId = branchKey|mapId|locationId，稳定");
  const after = carrier.session.simulation.branches[BRANCH_KEY].geoTopology.areas;
  assert.equal(after.length, 1, "更新而不是新增");
  assert.equal(after[0].cells.length, 2);

  // 重复格去重
  await core.handle("POST", "/maps/areas/upsert", {
    chatId: "chat-a", mapId: "world", locationId: worldRow.id,
    cells: [{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 2 }],
  });
  assert.equal(carrier.session.simulation.branches[BRANCH_KEY].geoTopology.areas[0].cells.length, 2,
    "重复格子只算一次");

  // 删除自己涂的那一块
  const removed = await core.handle("POST", "/maps/areas/upsert", {
    chatId: "chat-a", mapId: "world", locationId: worldRow.id, cells: [],
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.data.removed, true);
  assert.equal(carrier.session.simulation.branches[BRANCH_KEY].geoTopology.areas.length, 0);

  // 再删同一块：没有可删的 → 明确报错而不是假装成功
  const again = await core.handle("POST", "/maps/areas/upsert", {
    chatId: "chat-a", mapId: "world", locationId: worldRow.id, cells: [],
  });
  assert.equal(again.status, 400);
  assert.match(String(again.body.error?.message ?? ""), /\$\.cells/);
});

test("H15a：越界坐标 / 错图 / 超 256 格一律拒绝，且不写任何数据", async () => {
  const { core, carrier, worldRow } = await setupAreaFixture();
  const before = JSON.stringify(carrier.session);

  const outOfFrame = await core.handle("POST", "/maps/areas/upsert", {
    chatId: "chat-a", mapId: "world", locationId: worldRow.id, cells: [{ x: -1, y: 0 }],
  });
  assert.equal(outOfFrame.status, 400, "负坐标越界");
  assert.match(String(outOfFrame.body.error?.message ?? ""), /\$\.cells/);

  const wrongMap = await core.handle("POST", "/maps/areas/upsert", {
    chatId: "chat-a", mapId: "loc:9001", locationId: worldRow.id, cells: [{ x: 0, y: 0 }],
  });
  assert.equal(wrongMap.status, 400, "地点必须真的住在请求的那张图上");
  assert.match(String(wrongMap.body.error?.message ?? ""), /\$\.mapId/);

  const tooMany = [];
  for (let index = 0; index < 300; index += 1) tooMany.push({ x: index % 100, y: Math.floor(index / 100) });
  const overLimit = await core.handle("POST", "/maps/areas/upsert", {
    chatId: "chat-a", mapId: "world", locationId: worldRow.id, cells: tooMany,
  });
  assert.equal(overLimit.status, 400, "超过 256 格必须被拒");
  assert.equal(JSON.stringify(carrier.session), before, "被拒的请求不得改动会话");
});

test("H15a：非 manual 来源的范围不能被人工端点删除", async () => {
  const { core, carrier, worldRow } = await setupAreaFixture();
  // 预置一块 worldbook 来源的范围（模拟从世界书提炼出来的边界）
  const branch = carrier.session.simulation.branches[BRANCH_KEY];
  branch.geoTopology.areas.push({
    id: `manual-protect|${worldRow.id}`,
    locationId: worldRow.id, mapId: "world",
    cells: [{ x: 1, y: 1 }], evidence: "worldbook",
  });
  const before = JSON.stringify(carrier.session);
  const denied = await core.handle("POST", "/maps/areas/upsert", {
    chatId: "chat-a", mapId: "world", locationId: worldRow.id, cells: [],
  });
  // areaId 由服务端按 branchKey|mapId|locationId 生成，与预置的那块 id 不同 → 找不到人工块
  assert.equal(denied.status, 400, "只删人工块；没有人工块时明确失败");
  assert.equal(JSON.stringify(carrier.session), before, "不得改动任何数据");
});

/* ------------------------------------------------------------------ *
 * H07a / H15a：跨聊天拒绝（计划完成标准「用 A chatId 试写 B 拒绝」）
 * ------------------------------------------------------------------ */

test("H07a / H15a：拿 A 聊天的会话去写 B 聊天 → 一律拒绝，且不落任何数据", async () => {
  const { core, carrier, roomId, cityId, worldRow } = await (async () => {
    const fixture = await setupAreaFixture();
    const rows = fixture.carrier.session.tables.branches[BRANCH_KEY].locations;
    const room = rows.find((row) => row.id !== fixture.worldRow.id) ?? rows[0];
    return { ...fixture, roomId: room.id, cityId: fixture.worldRow.id };
  })();

  // 先给 A 建一块人工范围，稍后确认 B 的请求没有碰到它
  await core.handle("POST", "/maps/areas/upsert", {
    chatId: "chat-a", mapId: "world", locationId: worldRow.id, cells: [{ x: 3, y: 3 }],
  });
  const before = JSON.stringify(carrier.session);

  // 同一个会话文档（绑定在 chat-a）冒充 chat-b 发起写入
  const confirmAsB = await core.handle("POST", "/maps/topology/confirm", {
    chatId: "chat-b", operation: "set-parent", locationId: roomId, targetLocationId: cityId,
  });
  assert.notEqual(confirmAsB.status, 200, `B 的身份不得写入 A 的会话：实际 ${confirmAsB.status}`);
  assert.equal(JSON.stringify(carrier.session), before, "被拒的跨聊天写入不得改动会话");

  const areasAsB = await core.handle("POST", "/maps/areas/upsert", {
    chatId: "chat-b", mapId: "world", locationId: worldRow.id, cells: [{ x: 9, y: 9 }],
  });
  assert.notEqual(areasAsB.status, 200, "跨聊天涂色同样必须被拒");
  assert.equal(JSON.stringify(carrier.session), before, "会话逐字节不变");
  assert.equal(carrier.session.simulation.branches[BRANCH_KEY].geoTopology.areas.length, 1,
    "A 自己那块范围还在，B 的请求没有动过它");
});

/* ------------------------------------------------------------------ *
 * H18e：标定按分支作用域读写（IF 重标不覆盖正史）
 * ------------------------------------------------------------------ */

test("H18e：正史标定沿用旧键（0.9.58 存档形状），键映射按分支作用域", async () => {
  const { core, carrier } = await setup({ scripts: [() => textResponse(200, characterEditBlock())] });
  await core.handle("POST", "/turns/commit", commitBody());

  // ① 正史：键就是裸 mapId —— 0.9.58 存档里的 calibrations[mapId] 必须照读照写
  const canon = await core.handle("POST", "/worlds/scale/calibrate", {
    chatId: "chat-a", mapId: "world", userMetersPerCell: 100,
  });
  assert.equal(canon.status, 200, `正史标定应成功：${JSON.stringify(canon.body.error ?? {})}`);
  assert.ok(carrier.session.maps, "会话里应落 maps 文档");
  assert.ok(carrier.session.maps.calibrations.world,
    `键应为裸 mapId：实际 ${JSON.stringify(Object.keys(carrier.session.maps.calibrations ?? {}))}`);
  assert.equal(carrier.session.maps.calibrations.world.metersPerCell, 100);
  assert.equal(carrier.session.maps.calibrations.world.source, "user");
  assert.equal(carrier.session.maps.calibrations.world.locked, true, "人工标定默认锁定");

  /**
   * ② 分支作用域：IF 用 `branchKey|mapId`，绝不与正史互相覆盖。
   *
   * 端到端这一步不切分支——`branchScopeForStory` 只认 `world.stories` 里 mode="if" 的
   * **真实分支**，而直接往会话世界对象里塞 story 会让世界文档过不了 `parseWorld`
   * （实测返回 WORLD_NOT_FOUND）。键映射本身是纯函数，完整用例在
   * tests/atlas-scale.test.mjs；这里交叉核对服务端用的是同一套映射。
   */
  assert.equal(scaleCalibrationKey("canon", "world"), "world", "正史 = 裸 mapId");
  assert.equal(scaleCalibrationKey("story-if", "world"), "story-if|world", "IF = branchKey|mapId");
  assert.notEqual(scaleCalibrationKey("story-if", "world"), scaleCalibrationKey("canon", "world"),
    "两个分支的键不同 → IF 重标同一张图不会覆盖正史（T12 / T27 / T28）");
  assert.notEqual(scaleCalibrationKey("canon", "9001"), scaleCalibrationKey("canon", "world"),
    "每张图各标一次：世界图尺度不外溢到子图");

  // ③ 同图再标一次：覆写并递增 revision（旧值留版本，供回退审计）
  const again = await core.handle("POST", "/worlds/scale/calibrate", {
    chatId: "chat-a", mapId: "world", userMetersPerCell: 50,
  });
  assert.equal(again.status, 200);
  assert.equal(carrier.session.maps.calibrations.world.metersPerCell, 50);
  assert.ok(Number(carrier.session.maps.calibrations.world.revision) >= 2,
    "覆写保留递增 revision 供回退审计");
});

test("H18e：非法人工数值被拒，且不动任何标定", async () => {
  const { core, carrier } = await setup({ scripts: [() => textResponse(200, characterEditBlock())] });
  await core.handle("POST", "/turns/commit", commitBody());
  await core.handle("POST", "/worlds/scale/calibrate", { chatId: "chat-a", mapId: "world", userMetersPerCell: 100 });
  const before = JSON.stringify(carrier.session.maps);

  for (const bad of [0, -5, "abc"]) {
    const denied = await core.handle("POST", "/worlds/scale/calibrate", {
      chatId: "chat-a", mapId: "world", userMetersPerCell: bad,
    });
    assert.equal(denied.status, 400, `非法值 ${String(bad)} 必须被拒`);
  }
  const missingMap = await core.handle("POST", "/worlds/scale/calibrate", {
    chatId: "chat-a", mapId: "  ", userMetersPerCell: 10,
  });
  assert.equal(missingMap.status, 400, "空 mapId 必须被拒");
  assert.equal(JSON.stringify(carrier.session.maps), before, "被拒的请求不得改动任何标定");
});

/* ------------------------------------------------------------------ *
 * H18a / E06b：建图时的尺度标定（开场只对新建地图尝试一次）
 * ------------------------------------------------------------------ */

/** 开场块：造一个「望海楼 → 望海楼大堂」两层结构，于是望海楼成为内层地图宿主。 */
function bootstrapHostBlock() {
  return [
    "<atlasEdit>",
    JSON.stringify({ table: "location", op: "add", ref: "new:loc:tower", name: "望海楼", description: "临海石楼", quote: "你推开望海楼的门" }),
    JSON.stringify({ table: "location", op: "add", ref: "new:loc:hall", name: "望海楼大堂", parentRef: "new:loc:tower", description: "楼内大堂", quote: "走进大堂" }),
    "</atlasEdit>",
  ].join("\n");
}

const BOOTSTRAP_TEXT = "你推开望海楼的门，走进大堂。";

test("H18a/E06b：新建内层地图会被尝试标定一次，结果按分支作用域落盘", async () => {
  const scaleAnswer = JSON.stringify({
    status: "estimated",
    extentMeters: { width: 1000, height: 1000 },
    coverage: "望海楼内部",
    basis: "大堂尺度描述",
    confidence: "medium",
    evidence: [{ sourceId: "msg:a", quote: "走进大堂" }],
  });
  const { core, carrier } = await setup({
    scripts: [() => textResponse(200, bootstrapHostBlock()), () => textResponse(200, scaleAnswer)],
  });

  const result = await core.handle("POST", "/scene/bootstrap", {
    chatId: "chat-a", apply: true, assistantText: BOOTSTRAP_TEXT,
  });
  assert.equal(result.status, 200, `开场应成功：${JSON.stringify(result.body.error ?? {})}`);
  assert.equal(result.body.data.duration, 0, "开场时段恒为零");

  const rows = carrier.session.tables.branches[BRANCH_KEY].locations;
  const tower = rows.find((row) => row.name === "望海楼");
  assert.ok(tower, "望海楼已建点");
  const towerPointId = String(tower.id).replace("loc:", "");

  // H18a：新建的内层地图拿到了一次标定尝试，结果如实回报
  const mapScale = result.body.data.mapScale;
  assert.ok(Array.isArray(mapScale), "响应带 mapScale 明细");
  assert.equal(mapScale.length, 1, "只对本次实际创建的一张内层地图尝试："
    + `rows=${JSON.stringify(rows.map((r) => [r.id, r.name, r.parentLocationId]))}`
    + ` rejected=${JSON.stringify(result.body.data.rejectedRows)}`);
  assert.equal(mapScale[0].mapId, towerPointId);
  assert.equal(mapScale[0].status, "calibrated", `应标定成功：${JSON.stringify(mapScale[0])}`);

  // 键按分支作用域：正史 = 裸 mapId（0.9.58 存档形状）
  const calibration = carrier.session.maps.calibrations[towerPointId];
  assert.ok(calibration, `标定应落到裸 mapId 键：实际 ${JSON.stringify(Object.keys(carrier.session.maps.calibrations ?? {}))}`);
  assert.equal(calibration.metersPerCell, 10, "1000 米 / 100 格 = 10 米/格（程序从 frame 推导）");
  assert.equal(calibration.source, "ai-estimated");
});

test("H18a：模型给 unknown 时地图保留、明确待定，绝不猜米数", async () => {
  const unknownAnswer = JSON.stringify({
    status: "unknown", extentMeters: null, coverage: "", basis: "材料不足", confidence: "low", evidence: [],
  });
  const { core, carrier } = await setup({
    scripts: [() => textResponse(200, bootstrapHostBlock()), () => textResponse(200, unknownAnswer)],
  });
  const result = await core.handle("POST", "/scene/bootstrap", {
    chatId: "chat-a", apply: true, assistantText: BOOTSTRAP_TEXT,
  });
  assert.equal(result.status, 200, "开场本身照常成功");
  const mapScale = result.body.data.mapScale;
  assert.equal(mapScale.length, 1);
  assert.equal(mapScale[0].status, "scale-pending", "unknown → 待定，而不是假标定");
  assert.equal(mapScale[0].reasonCode, "UNKNOWN", "原因码如实回报");

  const rows = carrier.session.tables.branches[BRANCH_KEY].locations;
  assert.ok(rows.some((row) => row.name === "望海楼大堂"), "地图保留，不因为没标定就丢数据");
  const towerPointId = String(rows.find((row) => row.name === "望海楼").id).replace("loc:", "");
  assert.equal(carrier.session.maps?.calibrations?.[towerPointId] ?? null, null,
    "绝不写一个猜出来的米数");
});

test("H18a：已有有效标定时不再发模型请求（零新请求），人工锁定不被覆盖", async () => {
  const scaleAnswer = JSON.stringify({
    status: "estimated", extentMeters: { width: 1000, height: 1000 },
    coverage: "望海楼内部", basis: "大堂尺度描述", confidence: "medium",
    evidence: [{ sourceId: "msg:a", quote: "走进大堂" }],
  });

  // 第一次开场：标定成功，从响应里拿到这张内层地图的 mapId
  const first = await setup({
    scripts: [() => textResponse(200, bootstrapHostBlock()), () => textResponse(200, scaleAnswer)],
  });
  const probe = await first.core.handle("POST", "/scene/bootstrap", {
    chatId: "chat-a", apply: true, assistantText: BOOTSTRAP_TEXT,
  });
  assert.equal(probe.status, 200, `第一次开场应成功：${JSON.stringify(probe.body.error ?? {})}`);
  const mapId = probe.body.data.mapScale[0].mapId;
  assert.equal(probe.body.data.mapScale[0].status, "calibrated");

  // 同一夹具下 id 分配是确定性的：换一个会话，预先给这张图放一份**人工锁定**标定。
  // 作者已手工标定过的图，建图流程绝不该再烧一次模型请求，也绝不该覆盖它。
  let calls = 0;
  const second = await setup({
    scripts: [
      () => { calls += 1; return textResponse(200, bootstrapHostBlock()); },
      () => { calls += 1; return textResponse(200, scaleAnswer); },
    ],
  });
  second.carrier.session.maps = {
    schemaVersion: 2, pointMeta: {}, submaps: {},
    calibrations: {
      [mapId]: { revision: 1, metersPerCell: 5, source: "user", locked: true, at: 1, coverage: "望海楼", basis: "人工" },
    },
  };

  const again = await second.core.handle("POST", "/scene/bootstrap", {
    chatId: "chat-a", apply: true, assistantText: BOOTSTRAP_TEXT,
  });
  assert.equal(again.status, 200, `第二次开场应成功：${JSON.stringify(again.body.error ?? {})}`);
  assert.equal(again.body.data.mapScale[0].status, "existing", "已有有效标定 → existing");
  assert.equal(calls, 1, "只发了开场识别那一次；标定零新请求");
  assert.equal(second.carrier.session.maps.calibrations[mapId].metersPerCell, 5, "人工标定未被覆盖");
  assert.equal(second.carrier.session.maps.calibrations[mapId].locked, true, "锁定状态保持");
});

test("H23 修复：行增量建出的内层地图可以做人工标定（不再 400 宿主不存在）", async () => {
  const { core, carrier } = await setup({
    scripts: [
      () => textResponse(200, bootstrapHostBlock()),
      () => textResponse(200, JSON.stringify({ status: "unknown", extentMeters: null, coverage: "", basis: "", confidence: "low", evidence: [] })),
    ],
  });
  const boot = await core.handle("POST", "/scene/bootstrap", {
    chatId: "chat-a", apply: true, assistantText: BOOTSTRAP_TEXT,
  });
  assert.equal(boot.status, 200, `开场应成功：${JSON.stringify(boot.body.error ?? {})}`);
  const mapId = String(boot.body.data.mapScale[0].mapId);

  /**
   * 这张内层地图**只存在于三表投影里**：`maps.submaps` 仅由 geo-apply（提炼/采纳）
   * 写入，行增量开场不走那条路。修复前 `handleScaleCalibrate` 只看 `doc.submaps[mapId]`，
   * 于是这里会 400「子图标定的宿主点位或父图不存在」——界面看得到子图、却锁不了标定。
   */
  assert.equal(carrier.session.maps?.submaps?.[mapId] ?? null, null,
    "前提：这张子图确实不在 maps.submaps 里（否则本条测不到修复）");

  const calibrated = await core.handle("POST", "/worlds/scale/calibrate", {
    chatId: "chat-a", mapId, userMetersPerCell: 6,
  });
  assert.equal(calibrated.status, 200,
    `内层地图的人工标定必须可用（「待定 → 人工锁定」）：${JSON.stringify(calibrated.body.error ?? {})}`);
  assert.equal(carrier.session.maps.calibrations[mapId].metersPerCell, 6);
  assert.equal(carrier.session.maps.calibrations[mapId].locked, true, "人工标定默认锁定");

  // 但「凭空捏一张不存在的图」仍必须被拒——修复不能把守卫拆掉
  const bogus = await core.handle("POST", "/worlds/scale/calibrate", {
    chatId: "chat-a", mapId: "999999", userMetersPerCell: 6,
  });
  assert.equal(bogus.status, 400, "没有任何子地点挂靠的 mapId 仍必须被拒");
});

/* ------------------------------------------------------------------ *
 * D03：助手正文的完成态行为也是时间来源（§2.3 三来源取最大、不叠加）
 *
 * 背景：`deriveElapsedPeriods` 之前是死代码，行增量回合只认「用户时间词 + 旅行耗时」，
 * 于是「助手正文写『睡到翌日 / 赶了半天路』」完全不计时段——三来源只落地了两条。
 * ------------------------------------------------------------------ */

test("D03：用户没给时间词时，助手正文的**完成态**行为会推进时段", async () => {
  const { core, carrier } = await setup({ scripts: [() => textResponse(200, characterEditBlock())] });
  const before = Number(carrier.session.binding.worldTimeCursor);

  const result = await core.handle("POST", "/turns/commit", commitBody({
    // 用户文本没有任何时间词；角色行只写意图、不跨地点 → 两条老来源都给不出时段
    userText: "我跟着他。",
    assistantText: "他决定赶往钟楼。睡到翌日，他才动身。",
  }));
  assert.equal(result.status, 200, `应成功：${JSON.stringify(result.body.error ?? {})}`);
  assert.equal(Number(carrier.session.binding.worldTimeCursor), before + 4,
    "「睡到翌日」= 过夜 = 一整天 = 4 时段（助手完成态来源）");
});

test("D03：计划态 / 未完成行为不计时段（「打算赶路」不推进时间）", async () => {
  const { core, carrier } = await setup({ scripts: [() => textResponse(200, characterEditBlock())] });
  const before = Number(carrier.session.binding.worldTimeCursor);

  const result = await core.handle("POST", "/turns/commit", commitBody({
    userText: "我跟着他。",
    assistantText: "他决定赶往钟楼。他打算明天再赶路，还没出发。",
  }));
  assert.equal(result.status, 200, `应成功：${JSON.stringify(result.body.error ?? {})}`);
  assert.equal(Number(carrier.session.binding.worldTimeCursor), before,
    "未完成 / 计划态按 §2.3 明确不计时——不能因为「打算赶路」就偷偷推进世界");
});

test("D03：三来源取最大、不叠加（用户时间词更长时不被助手行为相加）", async () => {
  const { core, carrier } = await setup({ scripts: [() => textResponse(200, characterEditBlock())] });
  const before = Number(carrier.session.binding.worldTimeCursor);

  // 用户给「一会儿」(1)，助手正文写「睡到翌日」(4) → 取最大 4，而不是 5
  const result = await core.handle("POST", "/turns/commit", commitBody({
    userText: "我等了一会儿。",
    assistantText: "他决定赶往钟楼。睡到翌日，他才动身。",
  }));
  assert.equal(result.status, 200, `应成功：${JSON.stringify(result.body.error ?? {})}`);
  assert.equal(Number(carrier.session.binding.worldTimeCursor), before + 4,
    "取最大且不叠加：max(1, 4) = 4");
});
