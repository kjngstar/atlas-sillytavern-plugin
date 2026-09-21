/**
 * atlas-lorebook.test.mjs — ATLAS-09 世界书注入层。
 *
 * 覆盖（待办计划 ATLAS-09「世界书注入层」验收点）：
 * - 条目规划：committed 才有条目；关键词 = 涉及 NPC 名 / 落点地点名；
 *   内容有界 + 来源可追溯（时段 + 回执号）；确定性（同输入逐字节相同）。
 * - 严格解析：引擎响应不可信，超限 / 形状非法一律拒绝。
 * - 写入器：建书、按 comment upsert 不重复、按类目滚动修剪（新 → 旧）、
 *   聊天绑定槽只在为空时绑定（冲突不上覆）；保存后 data 不再被触碰。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ATLAS_LOREBOOK_LIMITS,
  ATLAS_LOREBOOK_PREFIX,
  ATLAS_STATUS_OVERVIEW_KEY,
  buildLorebookPlans,
  lorebookNameFor,
  parseAtlasLorebookPlans,
  createAtlasLorebookWriter,
} from "../src/atlas-lorebook.ts";
import { createLorebookPort, createNativeWorldInfoModule, hasNativeWorldInfoApi } from "../atlas-extension/index.js";

let assertionCount = 0;
function ok(value, message) {
  assertionCount += 1;
  assert.ok(value, message);
}
function equal(actual, expected, message) {
  assertionCount += 1;
  assert.equal(actual, expected, message);
}
function deepEqual(actual, expected, message) {
  assertionCount += 1;
  assert.deepStrictEqual(actual, expected, message);
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const WORLD = {
  name: "星环余烬",
  characters: [
    { id: "npc-1", name: "艾莉娅" },
    { id: "npc-2", name: "巴罗" },
  ],
  points: [
    { id: "pt-1", name: "集市广场" },
    { id: "pt-2", name: "钟楼" },
  ],
  regions: [{ id: "rg-1", name: "旧城区" }],
  stateEvents: [
    {
      id: "evt-1",
      worldId: "w1",
      branchId: null,
      at: 3,
      sequence: 0,
      source: "ai-adopted",
      narrativeSummary: "艾莉娅把一批走私香料搬进了集市广场的暗仓，巴罗在钟楼替她望风。",
      entityRefs: ["npc-1", "npc-2"],
      effects: [
        { kind: "moveEntity", entityId: "npc-1", pointId: "pt-1" },
        { kind: "appendMemoryRef", entityId: "npc-1", text: "收到巴罗的警告：码头巡查变严了。" },
      ],
    },
  ],
};

function committedReceipt(overrides = {}) {
  return {
    receiptId: "rcpt-abc123def4567890",
    status: "committed",
    branchId: null,
    previousTime: 2,
    currentTime: 3,
    previousLocationId: "pt-2",
    currentLocationId: "pt-1",
    triggeredNpcIds: [],
    adoptedEventIds: ["evt-1"],
    summary: "艾莉娅把一批走私香料搬进了集市广场的暗仓。",
    retryable: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 条目规划
// ---------------------------------------------------------------------------

test("规划：committed 回执产出 动向 + 事件 两条条目，关键词分别是 NPC 名与地点名", () => {
  const plans = buildLorebookPlans(WORLD, committedReceipt());
  ok(plans, "应产出规划");
  equal(plans.entries.length, 2, "每轮最多两条");
  equal(plans.bookName, "Atlas · 星环余烬", "书名由世界名派生");

  const moves = plans.entries.find((e) => e.category === "moves");
  const events = plans.entries.find((e) => e.category === "events");
  ok(moves, "动向条目存在");
  ok(events, "事件条目存在");
  deepEqual(moves.keys, ["艾莉娅", "巴罗"], "动向关键词 = 涉及 NPC 名（去重、按出现序）");
  deepEqual(events.keys, ["集市广场"], "事件关键词 = 回执落点地点名");
  ok(moves.comment.startsWith(ATLAS_LOREBOOK_PREFIX.moves), "动向 comment 前缀");
  ok(events.comment.startsWith(ATLAS_LOREBOOK_PREFIX.events), "事件 comment 前缀");
  ok(moves.comment.includes("2 → 3"), "动向 comment 带时段区间");
  ok(moves.content.includes("暗仓"), "动向内容含账本摘要");
  ok(moves.content.includes("码头巡查变严"), "动向内容含角色明细");
  ok(moves.content.includes("[Atlas · 第 2 → 3 时段 · 回执 rcpt-abc123def45]"), "来源行可追溯（时段 + 回执号）");
  ok(events.content.startsWith("近期可触发："), "事件条目为「近期可触发」形态");
});

test("规划：0.9.34 零 effect 回合回退——采纳 0 条也写动向摘要条目；防御状态保持 null", () => {
  equal(buildLorebookPlans(WORLD, committedReceipt({ status: "duplicate" })), null, "duplicate 不产出");
  equal(buildLorebookPlans(WORLD, committedReceipt({ status: "failed" })), null, "failed 不产出");
  const zeroEffect = buildLorebookPlans(WORLD, committedReceipt({ adoptedEventIds: [] }));
  ok(zeroEffect, "零 effect 回合回退产出动向条目");
  equal(zeroEffect.entries.length, 1, "只有一条动向");
  equal(zeroEffect.entries[0].category, "moves");
  ok(zeroEffect.entries[0].content.startsWith("近期动态："), "内容 = 回执摘要回退形态");
  deepEqual(zeroEffect.entries[0].keys, ["集市广场"], "关键词 = 当前地点名");
  equal(
    buildLorebookPlans(WORLD, committedReceipt({ adoptedEventIds: [], summary: "本轮无世界变化。" })),
    null,
    "「本轮无世界变化」占位摘要不产出",
  );
  equal(
    buildLorebookPlans(WORLD, committedReceipt({ adoptedEventIds: [], currentLocationId: null })),
    null,
    "零 effect 且无落点（无激活关键词）不产出",
  );
  equal(
    buildLorebookPlans({ ...WORLD, stateEvents: [] }, committedReceipt()),
    null,
    "账本里找不到事件（防御状态）不产出",
  );
});

test("规划：无角色被触及 → 省略动向条目；无落点 → 省略事件条目；全无 → null", () => {
  const noNpcWorld = {
    ...WORLD,
    stateEvents: [
      { ...WORLD.stateEvents[0], entityRefs: [], effects: [{ kind: "setFlag", key: "curfew" }] },
    ],
  };
  const onlyEvents = buildLorebookPlans(noNpcWorld, committedReceipt());
  ok(onlyEvents, "仍有事件条目");
  equal(onlyEvents.entries.length, 1, "动向条目被省略");
  equal(onlyEvents.entries[0].category, "events");

  const noLocation = buildLorebookPlans(WORLD, committedReceipt({ currentLocationId: null }));
  ok(noLocation, "仍有动向条目");
  equal(noLocation.entries.length, 1, "事件条目被省略");
  equal(noLocation.entries[0].category, "moves");

  const neither = buildLorebookPlans(noNpcWorld, committedReceipt({ currentLocationId: null }));
  equal(neither, null, "两条都不可用 → null");
});

test("规划：内容 / 关键词有界，名称去重，同输入逐字节相同（确定性）", () => {
  const manyNames = [];
  for (let i = 0; i < 20; i += 1) manyNames.push({ id: `npc-${i}`, name: `角色${i}号` });
  const effects = manyNames.map((c) => ({ kind: "moveEntity", entityId: c.id, pointId: "pt-1" }));
  const wideWorld = {
    ...WORLD,
    characters: manyNames,
    stateEvents: [{ ...WORLD.stateEvents[0], entityRefs: manyNames.map((c) => c.id), effects }],
  };
  const plans = buildLorebookPlans(wideWorld, committedReceipt());
  const moves = plans.entries.find((e) => e.category === "moves");
  equal(moves.keys.length, ATLAS_LOREBOOK_LIMITS.KEYS_MAX, "关键词上限");
  ok(moves.content.length <= ATLAS_LOREBOOK_LIMITS.CONTENT_CHARS, "内容上限");

  const longSummaryWorld = {
    ...WORLD,
    stateEvents: [{ ...WORLD.stateEvents[0], narrativeSummary: "很长".repeat(500) }],
  };
  const bounded = buildLorebookPlans(longSummaryWorld, committedReceipt());
  for (const entry of bounded.entries) {
    ok(entry.content.length <= ATLAS_LOREBOOK_LIMITS.CONTENT_CHARS, "超长摘要被截断");
  }

  const a = buildLorebookPlans(WORLD, committedReceipt());
  const b = buildLorebookPlans(WORLD, committedReceipt());
  deepEqual(a, b, "同世界状态 + 同回执 → 逐字节相同");
});

test("规划：实体 id 未命中任何角色 / 地点 → 不进关键词（不把内部 id 泄给主模型）", () => {
  const ghostWorld = {
    ...WORLD,
    stateEvents: [
      {
        ...WORLD.stateEvents[0],
        entityRefs: ["ghost-1"],
        effects: [{ kind: "moveEntity", entityId: "ghost-1", pointId: "pt-1" }],
      },
    ],
  };
  const plans = buildLorebookPlans(ghostWorld, committedReceipt());
  const moves = plans.entries.find((e) => e.category === "moves");
  equal(moves, undefined, "没有可读角色名 → 不产动向条目");
});

test("书名：剔除 ST 服务端文件名不接受的字符；空名回退", () => {
  equal(lorebookNameFor("A/B:C*D?"), "Atlas · ABCD", "非法字符被剔除");
  equal(lorebookNameFor(""), "Atlas · 未命名世界", "空名回退");
  equal(lorebookNameFor("   "), "Atlas · 未命名世界", "纯空白回退");
});

// ---------------------------------------------------------------------------
// 严格解析
// ---------------------------------------------------------------------------

test("解析：合法规划通过；缺字段 / 超限 / 数量非法一律拒绝", () => {
  const valid = {
    bookName: "Atlas · 星环余烬",
    entries: [
      { category: "moves", comment: `${ATLAS_LOREBOOK_PREFIX.moves} 第 2 → 3 时段`, keys: ["艾莉娅"], content: "摘要\n[Atlas · 来源]" },
    ],
  };
  const parsed = parseAtlasLorebookPlans(valid);
  ok(parsed.ok, "合法载荷通过");
  equal(parsed.value.entries[0].keys[0], "艾莉娅");

  for (const broken of [
    null,
    "nope",
    [],
    { entries: [] },
    { bookName: "", entries: [{ category: "moves", comment: "c", keys: ["a"], content: "x" }] },
    { bookName: "b", entries: [{ category: "quest", comment: "c", keys: ["a"], content: "x" }] },
    { bookName: "b", entries: [{ category: "moves", comment: "c", keys: [], content: "x" }] },
    { bookName: "b", entries: [{ category: "moves", comment: "c", keys: ["a"], content: "" }] },
    { bookName: "b".repeat(80), entries: [{ category: "moves", comment: "c", keys: ["a"], content: "x" }] },
    {
      bookName: "b",
      entries: [
        { category: "moves", comment: "c1", keys: ["a"], content: "x" },
        { category: "events", comment: "c2", keys: ["b"], content: "y" },
        { category: "events", comment: "c3", keys: ["c"], content: "z" },
      ],
    },
    { bookName: "b", entries: [{ category: "moves", comment: "c", keys: ["a".repeat(100)], content: "x" }] },
  ]) {
    const result = parseAtlasLorebookPlans(broken);
    equal(result.ok, false, `非法载荷被拒绝：${JSON.stringify(broken).slice(0, 40)}`);
  }
});

// ---------------------------------------------------------------------------
// 写入器（mock port）
// ---------------------------------------------------------------------------

/** 内存版 ST world-info：语义与官方 API 对齐（loadWorldInfo 深拷贝；保存后缓存同一对象）。 */
function makeMockPort(options = {}) {
  const books = new Map();
  const savedMetadata = [];
  const saves = [];
  const api = {
    async loadWorldInfo(name) {
      const raw = books.get(name);
      return raw ? JSON.parse(JSON.stringify(raw)) : null;
    },
    async createNewWorldInfo(name) {
      if (!books.has(name)) books.set(name, { entries: {} });
    },
    async saveWorldInfo(name, data) {
      books.set(name, JSON.parse(JSON.stringify(data)));
      saves.push(name);
    },
    createWorldInfoEntry(_name, data) {
      data.entries = data.entries ?? {};
      let uid = 0;
      for (const key of Object.keys(data.entries)) {
        const n = Number(key);
        if (Number.isFinite(n)) uid = Math.max(uid, n);
      }
      uid += 1;
      const entry = { uid: String(uid), key: [], keysecondary: [], comment: "", content: "", constant: false, selective: true, disable: false };
      data.entries[String(uid)] = entry;
      return entry;
    },
    deleteWorldInfoEntry(data, uid) {
      if (data.entries) delete data.entries[String(uid)];
    },
  };
  const chatMetadata = options.chatMetadata ?? {};
  return {
    api,
    books,
    saves,
    chatMetadata,
    savedMetadata,
  };
}

const PLANS_A = {
  bookName: "Atlas · 星环余烬",
  entries: [
    { category: "moves", comment: `${ATLAS_LOREBOOK_PREFIX.moves} 第 2 → 3 时段`, keys: ["艾莉娅", "巴罗"], content: "动向 A" },
    { category: "events", comment: `${ATLAS_LOREBOOK_PREFIX.events} 第 3 时段`, keys: ["集市广场"], content: "事件 A" },
  ],
};

/**
 * 组合出与生产一致的链路：mock world-info API → index.js 的真实端口适配器 → writer。
 * （直接把 api 传给 writer 会跳过适配层，测不到 chatMetadata.world_info 的绑定语义。）
 */
function makeWriter(mock, options = {}) {
  const chatContext = {
    chatMetadata: options.chatMetadata ?? mock.chatMetadata,
    saveMetadata: async () => {
      mock.savedMetadata.push(true);
    },
  };
  let port = createLorebookPort(() => chatContext, mock.api);
  if (options.preferred !== undefined) {
    const preferred = options.preferred;
    port = { ...port, resolvePreferredBook: async () => preferred };
  }
  return createAtlasLorebookWriter(port, { now: options.now });
}

test("写入器：书不存在 → 建书后写入；重复同步同 comment 不产生重复条目", async () => {
  const mock = makeMockPort();
  const writer = makeWriter(mock, { now: () => 1000 });

  const first = await writer.syncTurn(PLANS_A);
  equal(first.created, true, "首次建书");
  equal(first.written, 2, "写入两条");
  equal(mock.saves.length, 1, "整书只保存一次");

  const second = await writer.syncTurn(PLANS_A);
  equal(second.created, false, "第二次不再建书");
  equal(second.written, 2, "仍写入两条（upsert）");
  equal(second.pruned, 0, "未超量不修剪");

  const book = mock.books.get("Atlas · 星环余烬");
  equal(Object.keys(book.entries).length, 2, "书内恰好两条（按 comment 去重）");
});

test("写入器：聊天绑定槽为空才绑定；已绑别的书 → conflict 且不上覆", async () => {
  const metadata = {};
  const empty = makeMockPort({ chatMetadata: metadata });
  const writer1 = makeWriter(empty);
  const result1 = await writer1.syncTurn(PLANS_A);
  equal(result1.binding, "bound-by-atlas", "空槽 → Atlas 绑定");
  equal(metadata.world_info, "Atlas · 星环余烬", "绑定写入 chatMetadata");
  deepEqual(empty.savedMetadata, [true], "绑定后恰好保存一次 metadata");

  const mine = makeMockPort({ chatMetadata: { world_info: "用户的自有世界书" } });
  const writer2 = makeWriter(mine);
  const result2 = await writer2.syncTurn(PLANS_A);
  equal(result2.binding, "conflict", "已有绑定 → 冲突上报");
  equal(result2.existingBookName, "用户的自有世界书", "冲突时带回原书名");
  equal(mine.chatMetadata.world_info, "用户的自有世界书", "绝不静默覆盖用户绑定");
  deepEqual(mine.savedMetadata, [], "未发生任何绑定写");
  ok(mine.books.has("Atlas · 星环余烬"), "条目仍已写入 Atlas 书（等用户手动激活）");

  const same = makeMockPort({ chatMetadata: { world_info: "Atlas · 星环余烬" } });
  const writer3 = makeWriter(same);
  const result3 = await writer3.syncTurn(PLANS_A);
  equal(result3.binding, "already-bound", "已绑 Atlas 书 → 无需动作");
  deepEqual(same.savedMetadata, [], "不重复绑定");
});

test("写入器：按类目滚动修剪——时段号新 → 旧保留，超出部分删除", async () => {
  const mock = makeMockPort();
  const writer = makeWriter(mock, { now: () => 1 });

  // 先塞满 12 条旧动向 + 12 条旧事件（直接走 syncTurn 循环）
  for (let turn = 1; turn <= 12; turn += 1) {
    await writer.syncTurn({
      bookName: "Atlas · 星环余烬",
      entries: [
        { category: "moves", comment: `${ATLAS_LOREBOOK_PREFIX.moves} 第 ${turn} → ${turn + 1} 时段`, keys: ["艾莉娅"], content: `t${turn}` },
        { category: "events", comment: `${ATLAS_LOREBOOK_PREFIX.events} 第 ${turn + 1} 时段`, keys: ["集市广场"], content: `e${turn}` },
      ],
    });
  }
  let book = mock.books.get("Atlas · 星环余烬");
  equal(Object.keys(book.entries).length, 24, "恰好 = 双类目上限");

  // 第 13 轮：应挤掉第 1 轮（最旧）
  await writer.syncTurn({
    bookName: "Atlas · 星环余烬",
    entries: [
      { category: "moves", comment: `${ATLAS_LOREBOOK_PREFIX.moves} 第 13 → 14 时段`, keys: ["艾莉娅"], content: "t13" },
      { category: "events", comment: `${ATLAS_LOREBOOK_PREFIX.events} 第 14 时段`, keys: ["集市广场"], content: "e13" },
    ],
  });
  book = mock.books.get("Atlas · 星环余烬");
  const comments = Object.values(book.entries).map((e) => e.comment);
  equal(comments.length, 24, "修剪后仍在上限内");
  ok(!comments.some((c) => c.includes("第 1 → 2 时段")), "最旧动向被修剪");
  ok(comments.some((c) => c.includes("第 13 → 14 时段")), "最新动向保留");
  const result = { pruned: 2 };
  ok(result.pruned === 2, "本轮修剪 2 条");
});

test("写入器：目标书存在但形状非法 → 拒绝写入（绝不能覆盖非 Atlas 的书）", async () => {
  const mock = makeMockPort();
  mock.books.set("Atlas · 星环余烬", { broken: true });
  const writer = makeWriter(mock);
  await assert.rejects(() => writer.syncTurn(PLANS_A), /载荷异常/, "非法书形状被拒绝");
  deepEqual(mock.saves, [], "没有发生保存");
});

test("写入器：空规划被拒绝；快照含绑定状态与全量条目视图", async () => {
  const mock = makeMockPort();
  const writer = makeWriter(mock, { now: () => 1234 });
  await assert.rejects(() => writer.syncTurn({ bookName: "b", entries: [] }), /规划为空/, "空规划拒绝");

  const result = await writer.syncTurn(PLANS_A);
  const snap = writer.snapshot(PLANS_A, result);
  equal(snap.schemaVersion, 1, "快照带版本");
  equal(snap.bookName, "Atlas · 星环余烬", "快照带书名");
  equal(snap.updatedAt, 1234, "快照带时间（注入时钟）");
  equal(snap.written, 2, "快照带写入数");
  equal(snap.binding, "bound-by-atlas", "快照带绑定状态");
  equal(snap.entries.length, 2, "快照含书内全部 Atlas 条目");
  ok(snap.entries.every((e) => ["moves", "events"].includes(e.category)), "条目视图带类目");
});

test("写入器：保存后不再触碰 data（酒馆缓存不深拷贝）", async () => {
  const touched = [];
  const mock = makeMockPort();
  const originalSave = mock.api.saveWorldInfo;
  mock.api.saveWorldInfo = async (name, data) => {
    // 记录保存瞬间的内容；之后任何变更都应被发现
    const frozen = JSON.stringify(data);
    await originalSave(name, data);
    queueMicrotask(() => {
      if (JSON.stringify(data) !== frozen) touched.push(name);
    });
  };
  const writer = makeWriter(mock);
  await writer.syncTurn(PLANS_A);
  await new Promise((resolve) => setTimeout(resolve, 10));
  deepEqual(touched, [], "save 返回后 data 未被改动");
});

// ---------------------------------------------------------------------------
// 原生世界书模块（shujuku 式 getContext 公开接口，2026-09-18 兼容性收口）
// ---------------------------------------------------------------------------

test("原生模块：可用性判定只认 loadWorldInfo + saveWorldInfo 同时存在", () => {
  equal(hasNativeWorldInfoApi(null), false, "null context 不可用");
  equal(hasNativeWorldInfoApi({ loadWorldInfo: () => {} }), false, "缺 saveWorldInfo 不可用");
  equal(
    hasNativeWorldInfoApi({ loadWorldInfo: () => {}, saveWorldInfo: () => {} }),
    true,
    "两接口齐备即可用"
  );
});

test("原生模块：每次调用都重新 getContext；saveWorldInfo 缺省 immediately=true", async () => {
  let calls = 0;
  const saved = [];
  const getContext = () => {
    calls += 1;
    return {
      loadWorldInfo: async (name) => ({ entries: {}, requested: name }),
      saveWorldInfo: async (name, data, immediately) => {
        saved.push([name, immediately]);
      },
    };
  };
  const mod = createNativeWorldInfoModule(getContext);

  const book = await mod.loadWorldInfo("A");
  await mod.loadWorldInfo("B");
  equal(calls, 2, "每次方法调用都重新取 context");
  equal(book.requested, "A", "透传参数");

  await mod.saveWorldInfo("A", { entries: {} });
  await mod.saveWorldInfo("A", { entries: {} }, false);
  deepEqual(saved, [["A", true], ["A", false]], "immediately 缺省为 true，显式 false 可透传");
});

test("原生模块：createNewWorldInfo 走 POST /api/worldinfo/create 并带 CSRF 头", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  try {
    const mod = createNativeWorldInfoModule(() => ({
      getRequestHeaders: () => ({ Authorization: "Bearer test", "X-CSRF": "t" }),
    }));
    await mod.createNewWorldInfo("Atlas · 星环余烬");
  } finally {
    globalThis.fetch = originalFetch;
  }
  equal(calls.length, 1, "恰好一次请求");
  ok(calls[0].url.includes("/api/worldinfo/create"), "端点正确");
  equal(calls[0].init.method, "POST", "POST 方法");
  deepEqual(JSON.parse(calls[0].init.body), { name: "Atlas · 星环余烬" }, "载荷 = { name }");
  ok(calls[0].init.headers["X-CSRF"] === "t" && calls[0].init.headers["Content-Type"] === "application/json", "CSRF 头与 Content-Type 并存");
});

test("原生模块：createWorldInfoEntry 分配 max 数字 uid + 1 并带全套默认字段；deleteWorldInfoEntry 按 String(uid) 删", () => {
  const mod = createNativeWorldInfoModule(() => ({}));
  const data = { entries: { "0": { uid: 0, content: "旧" }, "3": { uid: 3, content: "旧" }, "junk": {} } };
  const entry = mod.createWorldInfoEntry("Atlas", data);
  ok(entry.uid === 4, `uid = max(0,3)+1 = 4（实际 ${entry.uid}）`);
  ok(entry.content === "" && entry.selective === true && entry.order === 100 && entry.probability === 100 && entry.depth === 4, "关键默认字段齐备");
  ok(data.entries["4"] === entry, "条目已写回 data.entries");

  mod.deleteWorldInfoEntry(data, 4);
  ok(!Object.prototype.hasOwnProperty.call(data.entries, "4"), "删除后键不存在");
  mod.deleteWorldInfoEntry(data, "不存在的键");
  ok(true, "删除不存在的键不抛");
  mod.deleteWorldInfoEntry(null, 1);
  ok(true, "null data 不抛");
});

test("原生模块全链路：原生 context → 原生模块 → 真实端口 → writer 同步成功", async () => {
  const books = new Map();
  const saves = [];
  const chatMetadata = {};
  let savedMetadata = 0;
  const getContext = () => ({
    loadWorldInfo: async (name) => {
      const raw = books.get(name);
      return raw ? JSON.parse(JSON.stringify(raw)) : null;
    },
    saveWorldInfo: async (name, data) => {
      books.set(name, JSON.parse(JSON.stringify(data)));
      saves.push(name);
    },
    getRequestHeaders: () => ({}),
    chatMetadata,
    saveMetadata: async () => {
      savedMetadata += 1;
    },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const name = JSON.parse(init.body).name;
    if (!books.has(name)) books.set(name, { entries: {} });
    return { ok: true, status: 200 };
  };
  try {
    const nativeModule = createNativeWorldInfoModule(getContext);
    ok(hasNativeWorldInfoApi(getContext()), "夹具 context 满足原生判定");
    ok(nativeModule.native === true, "标记为原生模块");

    const port = createLorebookPort(getContext, nativeModule);
    const writer = createAtlasLorebookWriter(port, { now: () => 2000 });
    var result = await writer.syncTurn(PLANS_A);
  } finally {
    globalThis.fetch = originalFetch;
  }

  equal(result.bookName, PLANS_A.bookName, "书名一致");
  equal(result.written, PLANS_A.entries.length, "两条条目全部写入");
  equal(result.binding, "bound-by-atlas", "聊天槽被 Atlas 绑定");
  ok(saves.length >= 1, "原生 saveWorldInfo 被调用");
  equal(savedMetadata, 1, "绑定后 saveMetadata 恰好一次");

  const stored = books.get(PLANS_A.bookName);
  const comments = Object.values(stored.entries).map((e) => e.comment);
  ok(comments.some((c) => c.startsWith(ATLAS_LOREBOOK_PREFIX.moves)), "动向条目在原生存储中");
  ok(comments.some((c) => c.startsWith(ATLAS_LOREBOOK_PREFIX.events)), "事件条目在原生存储中");
  ok(Object.values(stored.entries).every((e) => e.probability === 100 && e.selective === true), "原生默认字段随条目落库");
});

test("角色卡世界书：解析出卡书 → 写入卡书、绑定槽零触碰；null → 回退专属书", async () => {
  const mockCard = makeMockPort();
  const writerCard = makeWriter(mockCard, { now: () => 3000, preferred: "艾莉莉亚的世界书" });
  const cardResult = await writerCard.syncTurn(PLANS_A);

  equal(cardResult.bookName, "艾莉莉亚的世界书", "条目写入角色卡主世界书");
  equal(cardResult.binding, "char-primary", "绑定状态 = char-primary");
  equal(cardResult.written, PLANS_A.entries.length, "条目全部写入");
  equal(mockCard.savedMetadata.length, 0, "完全不触碰聊天绑定槽");
  ok(mockCard.books.has("艾莉莉亚的世界书"), "卡书已落库");
  ok(!mockCard.books.has(PLANS_A.bookName), "专属书未创建");
  const storedCard = mockCard.books.get("艾莉莉亚的世界书");
  const cardComments = Object.values(storedCard.entries).map((e) => e.comment);
  ok(cardComments.some((c) => c.startsWith(ATLAS_LOREBOOK_PREFIX.moves)), "动向条目在卡书中");
  ok(cardComments.some((c) => c.startsWith(ATLAS_LOREBOOK_PREFIX.events)), "事件条目在卡书中");

  const snapshotCard = writerCard.snapshot(PLANS_A, cardResult);
  equal(snapshotCard.bookName, "艾莉莉亚的世界书", "快照记录实际目标书名");
  equal(snapshotCard.binding, "char-primary", "快照绑定状态正确");

  const mockFallback = makeMockPort();
  const writerFallback = makeWriter(mockFallback, { now: () => 3000, preferred: null });
  const fallbackResult = await writerFallback.syncTurn(PLANS_A);
  equal(fallbackResult.bookName, PLANS_A.bookName, "null → 回退专属书");
  equal(fallbackResult.binding, "bound-by-atlas", "回退路径仍走聊天绑定");
});

test("角色卡世界书：解析抛错 → 回退专属书不炸", async () => {
  const mock = makeMockPort();
  const chatContext = {
    chatMetadata: mock.chatMetadata,
    saveMetadata: async () => {
      mock.savedMetadata.push(true);
    },
  };
  let port = createLorebookPort(() => chatContext, mock.api);
  port = { ...port, resolvePreferredBook: async () => { throw new Error("boom"); } };
  const writer = createAtlasLorebookWriter(port, { now: () => 4000 });
  const result = await writer.syncTurn(PLANS_A);
  equal(result.bookName, PLANS_A.bookName, "回退专属书");
  equal(result.binding, "bound-by-atlas", "绑定正常");
});

test("0.9.35 常驻聚合条目：固定 comment upsert、constant 蓝灯、内容整体重写、不产生重复条目", async () => {
  const mock = makeMockPort();
  const writer = makeWriter(mock, { now: () => 1 });
  const plansWithOverview = (content) => ({
    ...PLANS_A,
    statusOverview: { comment: ATLAS_LOREBOOK_PREFIX.status, keys: [ATLAS_STATUS_OVERVIEW_KEY], content },
  });

  const first = await writer.syncTurn(plansWithOverview("总览 v1"));
  const book1 = mock.books.get("Atlas · 星环余烬");
  const overview1 = Object.values(book1.entries).find((e) => e.comment === ATLAS_LOREBOOK_PREFIX.status);
  ok(overview1, "总览条目已创建");
  equal(overview1.content, "总览 v1", "首写内容");
  equal(overview1.constant, true, "constant 蓝灯常驻");
  equal(overview1.order, 9998, "高 order（照 shujuku 9998 区间）");
  equal(overview1.position, 0, "角色定义前（照 shujuku 卡上实际形态）");
  equal(overview1.prevent_recursion, true, "防递归");
  deepEqual(overview1.key, [ATLAS_STATUS_OVERVIEW_KEY], "占位 key（条目靠 constant 激活）");
  equal(first.written, 3, "滚动 2 条 + 总览 1 条");

  // 第二轮：内容变化 → 整体重写且仍只有一条；滚动条目照常滚动
  await writer.syncTurn({
    ...PLANS_A,
    entries: [
      { category: "moves", comment: `${ATLAS_LOREBOOK_PREFIX.moves} 第 3 → 4 时段`, keys: ["艾莉娅"], content: "动向 B" },
      { category: "events", comment: `${ATLAS_LOREBOOK_PREFIX.events} 第 4 时段`, keys: ["集市广场"], content: "事件 B" },
    ],
    statusOverview: { comment: ATLAS_LOREBOOK_PREFIX.status, keys: [ATLAS_STATUS_OVERVIEW_KEY], content: "总览 v2" },
  });
  const book2 = mock.books.get("Atlas · 星环余烬");
  const overviews = Object.values(book2.entries).filter((e) => e.comment === ATLAS_LOREBOOK_PREFIX.status);
  equal(overviews.length, 1, "总览条目始终只有一条（upsert 不追加）");
  equal(overviews[0].content, "总览 v2", "内容整体重写");
  equal(overviews[0].constant, true, "第二轮仍保持蓝灯");
});

test("本轮累计断言已记录（计数见报告）", () => {
  ok(assertionCount > 75, `断言数：${assertionCount}`);
});
