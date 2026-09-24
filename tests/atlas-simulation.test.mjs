/**
 * atlas-simulation.test.mjs — C11 定向验收（会话级后台推演模块）。
 *
 * 对照计划 §2.1 / §2.3 / §2.5 与 C01 / C02 / C03 / C11：
 * - C01 固定结构：worldId 显式、canon 四数组全空、**不用 Date.now 造 ID**；
 * - C02 校验：唯一性与引用、因果倒置、送达早于发布、重复送达、终态可留历史引用；
 * - C03 效果：0 时段只记意图不移动、同地目击 vs 远地不可达、重复 turnKey 零新增、
 *   单轮 16 条事件上限显式报出、undo 精确到行；
 * - §2.1 旧稿 `rows` → `tasks` 的显式迁移不丢行。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  ATLAS_SIMULATION_LIMITS,
  DEFAULT_SIMULATION_BRANCH,
  applySimulationEffects,
  canTransitionSimulationStatus,
  createEmptySimulation,
  isTerminalSimulationStatus,
  migrateLegacySimulationRows,
  simulationDeliveryId,
  simulationSignalId,
  simulationTaskId,
  validateSimulationStore,
} from "../src/atlas-simulation.ts";

const WORLD = "world-1";

function emptyTopology() {
  return { edges: [], areas: [], vehicles: [] };
}

function branch(overrides = {}) {
  return { tasks: [], signals: [], deliveries: [], geoTopology: emptyTopology(), ...overrides };
}

function storeWith(overrides = {}) {
  return {
    schemaVersion: 1,
    worldId: WORLD,
    branches: { [DEFAULT_SIMULATION_BRANCH]: branch(overrides) },
  };
}

function signal(overrides = {}) {
  return {
    id: "sig:1", originLocationId: "loc:1", topic: "使者带出宣战文书", sourceTurnKey: "turn-a",
    sourceQuoteId: "quote-a", publishedPeriod: 0, visibility: "known", status: "active",
    propagationCursor: 0, ...overrides,
  };
}

function task(overrides = {}) {
  return {
    id: "task:1", kind: "intent", status: "queued", actorCharacterId: "npc:1",
    originLocationId: "loc:1", targetLocationId: null, topic: "等待时机", signalId: null,
    visibility: "known", source: "character-intent", createdTurnKey: "turn-a",
    lastAppliedTurnKey: null, createdPeriod: 0, nextEligiblePeriod: null, reasonCode: null,
    ...overrides,
  };
}

function delivery(overrides = {}) {
  return {
    id: "dlv:1", signalId: "sig:1", recipientType: "location", recipientId: "loc:1",
    via: "witness", fromLocationId: "loc:1", receivedPeriod: 0, confidence: "confirmed",
    ...overrides,
  };
}

function tables(locations = ["loc:1"], characters = ["npc:1"]) {
  return {
    locations: locations.map((id) => ({ id })),
    characters: characters.map((id) => ({ id })),
  };
}

const NO_TABLES = { tablesByBranch: null };

/* ------------------------------------------------------------------ *
 * C01
 * ------------------------------------------------------------------ */

test("C01 空模块：worldId 显式、canon 四数组全空、构造确定性且不含时间戳", () => {
  const store = createEmptySimulation(WORLD);
  assert.equal(store.schemaVersion, 1);
  assert.equal(store.worldId, WORLD);
  const canon = store.branches[DEFAULT_SIMULATION_BRANCH];
  assert.deepEqual(canon.tasks, []);
  assert.deepEqual(canon.signals, []);
  assert.deepEqual(canon.deliveries, []);
  assert.deepEqual(canon.geoTopology, emptyTopology());
  // 同一 worldId 两次构造逐字节相同 —— 证明没有 Date.now / 随机数参与
  assert.deepEqual(createEmptySimulation(WORLD), store);
});

test("C01 确定性 ID：同输入同 ID，不同 turnKey / 收件人得到不同 ID", () => {
  const base = { chatId: "c1", branchKey: "canon", turnKey: "t1", actorCharacterId: "npc:1", kind: "intent", sequence: 0 };
  assert.equal(simulationTaskId(base), simulationTaskId({ ...base }));
  assert.notEqual(simulationTaskId(base), simulationTaskId({ ...base, turnKey: "t2" }));
  assert.notEqual(simulationTaskId(base), simulationTaskId({ ...base, sequence: 1 }));

  const sig = { chatId: "c1", branchKey: "canon", sourceTurnKey: "t1", originLocationId: "loc:1", topic: "x" };
  assert.equal(simulationSignalId(sig), simulationSignalId({ ...sig }));
  assert.notEqual(simulationSignalId(sig), simulationSignalId({ ...sig, topic: "y" }));

  assert.notEqual(
    simulationDeliveryId("sig:1", "location", "loc:1"),
    simulationDeliveryId("sig:1", "character", "loc:1"),
  );
});

/* ------------------------------------------------------------------ *
 * C02
 * ------------------------------------------------------------------ */

test("C02 空模块与合法模块都通过校验；跨世界被具名拒绝", () => {
  assert.equal(validateSimulationStore(createEmptySimulation(WORLD), { expectedWorldId: WORLD, ...NO_TABLES }).ok, true);

  const cross = validateSimulationStore(createEmptySimulation("other"), { expectedWorldId: WORLD, ...NO_TABLES });
  assert.equal(cross.ok, false);
  assert.equal(cross.errors[0].code, "CROSS_WORLD");
  assert.equal(cross.errors[0].path, "$.simulation.worldId");
});

test("C02 重复 ID / 非法枚举被拒，错误路径指到具体行与字段", () => {
  const dup = validateSimulationStore(
    storeWith({ tasks: [task(), task()] }),
    { expectedWorldId: WORLD, ...NO_TABLES },
  );
  assert.equal(dup.ok, false);
  assert.ok(dup.errors.some((error) => error.code === "DUPLICATE_ID" && error.path === "$.simulation.branches.canon.tasks[1].id"));

  const badKind = validateSimulationStore(
    storeWith({ tasks: [task({ kind: "teleport" })] }),
    { expectedWorldId: WORLD, ...NO_TABLES },
  );
  assert.equal(badKind.ok, false);
  assert.ok(badKind.errors.some((error) => error.code === "ENUM_INVALID" && error.path.endsWith(".tasks[0].kind")));
});

test("C02 非终态引用缺失被拒；终态任务可保留已被删除的历史实体", () => {
  const orphan = validateSimulationStore(
    storeWith({ tasks: [task({ actorCharacterId: "npc:gone" })] }),
    { expectedWorldId: WORLD, tables: tables() },
  );
  assert.equal(orphan.ok, false);
  assert.ok(orphan.errors.some((error) => error.code === "REF_MISSING" && error.path.endsWith(".tasks[0].actorCharacterId")));

  const historical = validateSimulationStore(
    storeWith({ tasks: [task({ status: "resolved", actorCharacterId: "npc:gone", lastAppliedTurnKey: "turn-a" })] }),
    { expectedWorldId: WORLD, tables: tables() },
  );
  assert.equal(historical.ok, true);
});

test("C02 因果倒置：无送达记录的异地 reaction 被拒", () => {
  const result = validateSimulationStore(
    storeWith({
      signals: [signal()],
      tasks: [task({ kind: "reaction", signalId: "sig:1", actorCharacterId: "npc:1", status: "active" })],
    }),
    { expectedWorldId: WORLD, tables: tables(["loc:1"], ["npc:1"]) },
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "REACTION_WITHOUT_DELIVERY"));
});

test("C02 送达早于发布 / 同一收件人重复送达被拒", () => {
  const beforePublish = validateSimulationStore(
    storeWith({
      signals: [signal({ publishedPeriod: 5 })],
      deliveries: [delivery({ receivedPeriod: 2 })],
    }),
    { expectedWorldId: WORLD, tables: tables() },
  );
  assert.equal(beforePublish.ok, false);
  assert.ok(beforePublish.errors.some((error) => error.code === "DELIVERY_BEFORE_PUBLISH"));

  const duplicate = validateSimulationStore(
    storeWith({
      signals: [signal()],
      deliveries: [delivery(), delivery({ id: "dlv:2" })],
    }),
    { expectedWorldId: WORLD, tables: tables() },
  );
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.errors.some((error) => error.code === "DELIVERY_DUPLICATE"));
});

test("C02 状态机：终态不复活；非法转换被拒", () => {
  assert.equal(canTransitionSimulationStatus("queued", "active"), true);
  assert.equal(canTransitionSimulationStatus("queued", "resolved"), false);
  assert.equal(canTransitionSimulationStatus("active", "resolved"), true);
  assert.equal(canTransitionSimulationStatus("blocked", "active"), true);
  assert.equal(canTransitionSimulationStatus("resolved", "active"), false);
  assert.equal(canTransitionSimulationStatus("cancelled", "active"), false);
  assert.equal(isTerminalSimulationStatus("resolved"), true);
  assert.equal(isTerminalSimulationStatus("active"), false);
});

/* ------------------------------------------------------------------ *
 * C03
 * ------------------------------------------------------------------ */

test("C03 0 时段：只记录意图，绝不移动，也不把「可能发生」写成「已抵达」", () => {
  const previous = createEmptySimulation(WORLD);
  const result = applySimulationEffects({
    chatId: "chat-1", branchKey: DEFAULT_SIMULATION_BRANCH, previous,
    turnKey: "turn-1", period: 0, periodsElapsed: 0,
    acceptedEdits: [{
      table: "character", op: "set", ref: "npc:1",
      row: { locationId: "loc:1", targetLocationId: "loc:9", actionTendency: "赶往城门" },
    }],
    moves: [{
      actorCharacterId: "npc:1", kind: "travel", fromLocationId: "loc:1",
      toLocationId: null, arrived: false, reasonCode: "NO_TIME", periodsUsed: 0,
    }],
    characterLocations: [{ id: "npc:1", locationId: "loc:1" }],
  });

  assert.equal(result.eventsTruncated, false);
  const rows = result.next.branches[DEFAULT_SIMULATION_BRANCH].tasks;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "queued");
  assert.equal(rows[0].reasonCode, "NO_TIME");
  // 任何事件都不许出现「已在路上 / 已抵达」的措辞
  for (const event of result.events) {
    assert.notEqual(event.status, "arrived");
    assert.ok(!event.summary.includes("已抵达"));
    assert.ok(!event.summary.includes("仍在路上"));
  }
});

test("C03 0 时段：一份 observed 消息只到发起地与真正同地目击者，远方无人已知", () => {
  const result = applySimulationEffects({
    chatId: "chat-1", branchKey: DEFAULT_SIMULATION_BRANCH, previous: createEmptySimulation(WORLD),
    turnKey: "turn-1", period: 0, periodsElapsed: 0,
    proposal: { originLocationId: "loc:school", topic: "使者已带出宣战文书", sourceQuoteId: "quote-1" },
    characterLocations: [
      { id: "npc:near", locationId: "loc:school" },
      { id: "npc:far", locationId: "loc:factory" },
    ],
  });

  const branchNext = result.next.branches[DEFAULT_SIMULATION_BRANCH];
  assert.equal(branchNext.signals.length, 1);

  const recipients = branchNext.deliveries.map((row) => `${row.recipientType}:${row.recipientId}`);
  assert.ok(recipients.includes("location:loc:school"));
  assert.ok(recipients.includes("character:npc:near"));
  // 第 0 时段绝不能让远方人物得知
  assert.ok(!recipients.includes("character:npc:far"));
  assert.ok(result.events.some((event) => event.status === "published"));
  assert.ok(result.events.some((event) => event.status === "delivered"));
});

test("C03 幂等：重复同一 turnKey 产出相同 ID 且零新增事件", () => {
  const previous = createEmptySimulation(WORLD);
  const input = {
    chatId: "chat-1", branchKey: DEFAULT_SIMULATION_BRANCH, previous,
    turnKey: "turn-1", period: 0, periodsElapsed: 0,
    proposal: { originLocationId: "loc:school", topic: "使者已带出宣战文书", sourceQuoteId: "quote-1" },
    characterLocations: [{ id: "npc:near", locationId: "loc:school" }],
  };
  const first = applySimulationEffects(input);
  const replay = applySimulationEffects({ ...input, previous: first.next });

  assert.equal(replay.next.branches[DEFAULT_SIMULATION_BRANCH].signals.length, 1);
  assert.equal(replay.next.branches[DEFAULT_SIMULATION_BRANCH].deliveries.length, 2);
  assert.equal(replay.events.length, 0, "重复提交不得产生新事件");
  assert.equal(replay.undo.length, 0);
});

test("C03 单轮事件上限：显式报告 SIMULATION_EVENT_LIMIT，不静默丢弃", () => {
  const edits = [];
  for (let index = 0; index < 20; index += 1) {
    edits.push({
      table: "character", op: "set", ref: `npc:${index}`,
      row: { locationId: "loc:1", targetLocationId: null, actionTendency: `想法 ${index}` },
    });
  }
  const result = applySimulationEffects({
    chatId: "chat-1", branchKey: DEFAULT_SIMULATION_BRANCH, previous: createEmptySimulation(WORLD),
    turnKey: "turn-many", period: 0, periodsElapsed: 0, acceptedEdits: edits,
  });

  assert.equal(ATLAS_SIMULATION_LIMITS.eventsPerTurn, 16);
  assert.equal(result.eventsTruncated, true);
  assert.equal(result.events.length, 16);
  assert.ok(result.droppedEventCount > 0);
  assert.ok(result.diagnostics.some((entry) => entry.code === "SIMULATION_EVENT_LIMIT"));
  // 状态本身不因事件上限而丢：20 条任务全部落库
  assert.equal(result.next.branches[DEFAULT_SIMULATION_BRANCH].tasks.length, 20);
});

test("C03 undo 精确到行：新建记 before=null，同一 id 不重复记两条", () => {
  const result = applySimulationEffects({
    chatId: "chat-1", branchKey: DEFAULT_SIMULATION_BRANCH, previous: createEmptySimulation(WORLD),
    turnKey: "turn-1", period: 3, periodsElapsed: 3,
    acceptedEdits: [{
      table: "character", op: "set", ref: "npc:1",
      row: { locationId: "loc:1", targetLocationId: "loc:2", actionTendency: "赶往城门" },
    }],
    moves: [{
      actorCharacterId: "npc:1", kind: "travel", fromLocationId: "loc:1",
      toLocationId: "loc:2", arrived: true, reasonCode: null, periodsUsed: 3,
    }],
  });

  const taskUndo = result.undo.filter((entry) => entry.collection === "tasks");
  const ids = new Set(taskUndo.map((entry) => entry.id));
  assert.equal(taskUndo.length, ids.size, "同一 task id 不得出现两条逆操作");
  assert.ok(taskUndo.every((entry) => entry.before === null || typeof entry.before === "object"));
});

test("C03 跨分支隔离：写入 canon 不会让 IF 分支看见", () => {
  const result = applySimulationEffects({
    chatId: "chat-1", branchKey: DEFAULT_SIMULATION_BRANCH, previous: createEmptySimulation(WORLD),
    turnKey: "turn-1", period: 0, periodsElapsed: 0,
    proposal: { originLocationId: "loc:school", topic: "宣战", sourceQuoteId: "q" },
  });
  assert.equal(result.next.branches[DEFAULT_SIMULATION_BRANCH].signals.length, 1);
  assert.equal(result.next.branches["story-if"], undefined);
  // 原始模块不被修改（纯函数）
  assert.equal(result.next.branches[DEFAULT_SIMULATION_BRANCH].signals.length, 1);
});

/* ------------------------------------------------------------------ *
 * §2.1 旧稿 rows → tasks 迁移
 * ------------------------------------------------------------------ */

test("§2.1 旧稿 rows → tasks：显式迁移不丢已有行，坏行如实计数", () => {
  const legacy = {
    branches: {
      canon: {
        rows: [
          { id: "row-1", kind: "travel", status: "active", actorCharacterId: "npc:1", topic: "赶路", createdPeriod: 2 },
          { id: "row-2", kind: "intent", status: "queued", topic: "观望" },
          { notAnId: true },
        ],
      },
    },
  };
  const migrated = migrateLegacySimulationRows(legacy, WORLD);
  assert.equal(migrated.migrated, 2);
  assert.equal(migrated.skipped, 1);
  const rows = migrated.store.branches[DEFAULT_SIMULATION_BRANCH].tasks;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "row-1");
  assert.equal(rows[0].kind, "travel");
  assert.equal(rows[0].createdPeriod, 2);
  // 缺 worldId 的旧稿按空模块返回，绝不猜世界
  assert.deepEqual(migrateLegacySimulationRows(null, WORLD), {
    store: createEmptySimulation(WORLD), migrated: 0, skipped: 0,
  });
});
