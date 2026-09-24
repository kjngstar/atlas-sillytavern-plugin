/**
 * atlas-lorebook.test.mjs — ATLAS-09 世界书注入层。
 *
 * 覆盖（0.9.40 收口：世界书只要动向、不特意强调时段）：
 * - 条目规划：committed 才有条目；唯一滚动条目「Atlas 动向」（固定 comment、
 *   constant、内容 = 当前时间 / 位置 / 近期动向）；零 effect 回合同样重写
 *   （当前时间永远最新）；引擎「无变化」注记剥离；确定性（同输入逐字节相同）。
 * - D11b / D09（施工计划 §3-D11b、问题 F2）：三表回合**没有** `world.stateEvents`
 *   时，第 4 参 `simulationDelta` 的推演事件仍要产出「近期动向」——意图标「（意图）」、
 *   hidden 与未送达消息不透出、主角未获知的消息不注入；不传该参数时旧路径行为不变。
 * - 严格解析：引擎响应不可信，超限 / 形状非法一律拒绝。
 * - 写入器：建书、按 comment upsert 不重复、存量旧条目（逐轮动向 / 事件 /
 *   状态总览）一次性清理、聊天绑定槽只在为空时绑定（冲突不上覆）；
 *   保存后 data 不再被触碰。
 * - B05（施工计划 §3-B05 / F10）：**聊天作用域与跨聊天隔离**——作用域纯函数
 *   （作用域名 / 专属书名 / 注入 key / 条目归属判定）、两个聊天并行开同一角色卡
 *   互不可见对方的「Atlas 动向」、共享主卡书不写跨聊天动态条目、静态用户世界书
 *   原样保留、旧条目迁移只在新路径成功后清理（失败则旧条目仍在）、
 *   setExtensionPrompt 注入通道优先。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ATLAS_LOREBOOK_INJECTION_KEY_PREFIX,
  ATLAS_LOREBOOK_LIMITS,
  ATLAS_LOREBOOK_PREFIX,
  ATLAS_MOVES_ENTRY_COMMENT,
  ATLAS_MOVES_ENTRY_KEY,
  ATLAS_SCOPED_COMMENT_PREFIX,
  atlasLorebookChatFingerprint,
  atlasLorebookInjectionKey,
  atlasLorebookScopeEquals,
  atlasLorebookScopeKey,
  atlasScopedEntryComment,
  buildAtlasInjectionText,
  buildLorebookPlans,
  classifyAtlasLorebookEntry,
  lorebookNameFor,
  normalizeAtlasLorebookScope,
  parseAtlasLorebookPlans,
  scopeBookName,
  summarizeAtlasLorebookOwnership,
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

test("E08：行增量回合把三表上下文（位置链 / 身边人物 / 地面物品）注入滚动条目", () => {
  const tables = {
    locations: [
      { id: "loc:pt-1", name: "集市广场", parentLocationId: "loc:pt-9", description: "", rumors: [], factions: [], mapId: "world", gridX: 10, gridY: 10 },
      { id: "loc:pt-9", name: "旧城区", parentLocationId: null, description: "", rumors: [], factions: [], mapId: "world", gridX: 5, gridY: 5 },
    ],
    characters: [
      { id: "npc-1", name: "艾莉娅", locationId: "loc:pt-1", thought: "别让人看出破绽", actionTendency: "尽快把货转手",
        currentAction: "清点香料", targetLocationId: null, presence: "present", positionSource: "narrative", mapId: "world", gridX: null, gridY: null },
      { id: "npc-2", name: "巴罗", locationId: "loc:pt-1", thought: "", actionTendency: "",
        currentAction: "望风", targetLocationId: null, presence: "present", positionSource: "narrative", mapId: "world", gridX: null, gridY: null },
      // 已离场 / 在别处的人不得进条目
      { id: "npc-3", name: "离场的人", locationId: "loc:pt-1", thought: "我不该出现", actionTendency: "",
        currentAction: "", targetLocationId: null, presence: "left", positionSource: "narrative", mapId: "world", gridX: null, gridY: null },
    ],
    items: [
      { id: "item:crate", name: "香料箱", description: "", locationId: "loc:pt-1", holderCharacterId: null, status: "在地上", mapId: "world", gridX: 12, gridY: 12 },
      // 持有物与已销毁物不列（持有关系在人物那一行）
      { id: "item:key", name: "钥匙", description: "", locationId: null, holderCharacterId: "npc-1", status: "随身", mapId: null, gridX: null, gridY: null },
      { id: "item:ash", name: "灰烬", description: "", locationId: "loc:pt-1", holderCharacterId: null, status: "已销毁", mapId: "world", gridX: null, gridY: null },
    ],
  };
  const plans = buildLorebookPlans(WORLD, committedReceipt(), {
    tables, branchKey: "canon", currentLocationId: "pt-1",
  });
  ok(plans, "应产出规划");
  const content = plans.entries[0].content;
  ok(content.includes("位置链：旧城区 → 集市广场"), `位置链含上级地点：实际「${content}」`);
  ok(content.includes("在场：艾莉娅（想法：别让人看出破绽；行动倾向：尽快把货转手）"), "身边人物带想法与行动倾向");
  ok(content.includes("在场：巴罗"), "没有想法的人也在场列出");
  ok(!content.includes("离场的人"), "已离场的人不进条目");
  ok(content.includes("地面物品：香料箱"), "地面物品列出");
  ok(!content.includes("钥匙"), "持有物不列为地面物品");
  ok(!content.includes("灰烬"), "已销毁物不列为地面物品");
  ok(content.indexOf("位置链") < content.indexOf("近期动向："), "三表上下文在「近期动向」之前（顺序固定，可逐字节重放）");

  // 分支隔离：只读传入的那一份快照——传另一分支的表就得到另一份内容
  const otherBranch = buildLorebookPlans(WORLD, committedReceipt(), {
    tables: { ...tables, locations: [tables.locations[1]] }, branchKey: "if-x", currentLocationId: "pt-1",
  });
  ok(!otherBranch.entries[0].content.includes("位置链：旧城区 → 集市广场"), "另一个分支的快照不含该地点 → 不编造位置链");
});

test("E08：三表上下文有界——超量人物 / 物品如实写「还有 N 位」，不静默截断", () => {
  const characters = [];
  for (let i = 0; i < 10; i += 1) {
    characters.push({
      id: `npc-${i}`, name: `路人${i}`, locationId: "loc:1", thought: "", actionTendency: "",
      currentAction: "", targetLocationId: null, presence: "present", positionSource: "narrative", mapId: "world", gridX: null, gridY: null,
    });
  }
  const tables = {
    locations: [{ id: "loc:1", name: "广场", parentLocationId: null, description: "", rumors: [], factions: [], mapId: "world", gridX: 0, gridY: 0 }],
    characters,
    items: [],
  };
  const plans = buildLorebookPlans(WORLD, committedReceipt(), { tables, branchKey: "canon", currentLocationId: "1" });
  const content = plans.entries[0].content;
  ok(content.includes("另有"), `超量时如实说明剩余人数：实际「${content}」`);
  ok(content.length <= 480, "条目仍然受 CONTENT_CHARS 上限约束");
});

test("规划：committed 回执产出唯一滚动条目「Atlas 动向」（固定 comment、constant、标题不带时段）", () => {
  const plans = buildLorebookPlans(WORLD, committedReceipt());
  ok(plans, "应产出规划");
  equal(plans.entries.length, 1, "0.9.40 只有一条滚动条目");
  equal(plans.bookName, "Atlas · 星环余烬", "书名由世界名派生");

  const entry = plans.entries[0];
  equal(entry.category, "moves", "动向类目");
  equal(entry.comment, ATLAS_MOVES_ENTRY_COMMENT, "固定 comment（= 前缀本身）");
  ok(!entry.comment.includes("时段"), "标题不强调时段");
  deepEqual(entry.keys, [ATLAS_MOVES_ENTRY_KEY], "占位 key（条目靠 constant 激活）");
  equal(entry.constant, true, "constant 蓝灯常驻");
  ok(entry.content.includes("当前时间：第 3 时段"), "当前时间 = 回执时段");
  ok(entry.content.includes("当前位置：集市广场"), "当前位置 = 回执落点");
  ok(entry.content.includes("近期动向"), "近期动向块存在");
  ok(entry.content.includes("暗仓"), "内容含账本叙事");
  ok(!entry.content.includes("回执"), "不再带回执来源行（0.9.40 去可追溯尾注）");
  ok(entry.content.length <= ATLAS_LOREBOOK_LIMITS.CONTENT_CHARS, "内容有界");
});

test("规划：duplicate / failed 不产出；零 effect 回合同样重写滚动条目（当前时间永远最新）", () => {
  equal(buildLorebookPlans(WORLD, committedReceipt({ status: "duplicate" })), null, "duplicate 不产出");
  equal(buildLorebookPlans(WORLD, committedReceipt({ status: "failed" })), null, "failed 不产出");

  // 0.9.39 矛盾根因修复验证：采纳 0 条（仅时间 / 位置推进）也产出规划
  const zeroEffect = buildLorebookPlans(
    WORLD,
    committedReceipt({ adoptedEventIds: [], summary: "艾莉娅在集市广场逗留。（本轮无实体变化：仅时间 / 位置推进，未写入账本）" }),
  );
  ok(zeroEffect, "零 effect 回合也产出");
  equal(zeroEffect.entries[0].comment, ATLAS_MOVES_ENTRY_COMMENT, "同一固定 comment（writer upsert 整体重写）");
  ok(zeroEffect.entries[0].content.includes("当前时间：第 3 时段"), "当前时间照样推进");
  ok(!zeroEffect.entries[0].content.includes("本轮无实体变化"), "回执摘要的引擎注记不进条目（条目不取 receipt.summary）");

  const emptyWorld = buildLorebookPlans(
    { ...WORLD, stateEvents: [] },
    committedReceipt({ adoptedEventIds: [], currentLocationId: null }),
  );
  ok(emptyWorld, "零 effect 且无落点也产出（时间推进也是世界变化）");
  ok(emptyWorld.entries[0].content.includes("当前时间：第 3 时段"), "时间永远最新");
  ok(emptyWorld.entries[0].content.includes("（暂无已归档的世界变化）"), "空账本回退占位行");
});

test("规划：叙事里的引擎「无变化」注记被剥离，只留模型叙事", () => {
  const suffixWorld = {
    ...WORLD,
    stateEvents: [
      { ...WORLD.stateEvents[0], narrativeSummary: "艾莉娅在集市广场逗留。（本轮无实体变化：仅时间 / 位置推进，未写入账本）" },
    ],
  };
  const plans = buildLorebookPlans(suffixWorld, committedReceipt());
  ok(plans, "产出规划");
  ok(plans.entries[0].content.includes("艾莉娅在集市广场逗留。"), "模型叙事保留");
  ok(!plans.entries[0].content.includes("本轮无实体变化"), "引擎注记被剥离");
});

test("规划：内容有界；同输入逐字节相同（确定性）", () => {
  const longSummaryWorld = {
    ...WORLD,
    stateEvents: [{ ...WORLD.stateEvents[0], narrativeSummary: "很长".repeat(500) }],
  };
  const bounded = buildLorebookPlans(longSummaryWorld, committedReceipt());
  for (const entry of bounded.entries) {
    ok(entry.content.length <= ATLAS_LOREBOOK_LIMITS.CONTENT_CHARS, "超长摘会被截断");
  }

  const a = buildLorebookPlans(WORLD, committedReceipt());
  const b = buildLorebookPlans(WORLD, committedReceipt());
  deepEqual(a, b, "同世界状态 + 同回执 → 逐字节相同");
});

/* ------------------------------------------------------------------ *
 * D11b / D09：三表回合没有 world.stateEvents 时，世界书里依然要有动向
 *
 * F2 的现场：三表的人物位置 / 想法每轮都在变，而旧事件流水 world.stateEvents
 * 根本不新增（表格增量的 receipt.adoptedEventIds 为空）→ 条目只剩
 * 「（暂无已归档的世界变化）」，书和界面都不知道后台具体发生了什么。
 * 修复口径：第 4 参 simulationDelta 有事件时，「近期动向」**优先**取本分支的
 * simulationEvents；旧 stateEvents 只在没有推演事件时兜底（旧档行为不变）。
 *
 * 纪律（§2.3 / D09）逐条断言：
 * 1. 只有**已发生**的事实进条目；意图显式标「（意图）」，不写成已发生；
 * 2. hidden 不进主聊天注入（作者显式全知开关除外）；
 * 3. 一条消息要真的**送达过**才算动向；主角在已知地点时，消息还得送到过那里。
 * ------------------------------------------------------------------ */

/** D11b 夹具：世界**没有**任何 stateEvents —— 旧路径下只会产出占位行。 */
const D11B_WORLD = { ...WORLD, stateEvents: [] };

function d11bEvent(overrides = {}) {
  return {
    simulationId: "sim:task-1",
    kind: "intent",
    status: "intent-recorded",
    visibility: "known",
    summary: "艾莉娅打算今夜把香料转手",
    period: 3,
    ...overrides,
  };
}

test("D11b：三表回合无 stateEvents 时依然有动向——行来自 simulationEvents，不再只剩占位文案", () => {
  const delta = {
    branchKey: "canon",
    events: [
      d11bEvent({ simulationId: "sim:task-1", kind: "intent", status: "intent-recorded", summary: "艾莉娅打算今夜把香料转手", period: 3 }),
      d11bEvent({ simulationId: "sim:task-2", kind: "travel", status: "arrived", summary: "巴罗已抵达钟楼", period: 3 }),
    ],
    deliveries: [],
    protagonistLocationIds: ["pt-1"],
  };

  const plans = buildLorebookPlans(D11B_WORLD, committedReceipt({ adoptedEventIds: [] }), null, delta);
  ok(plans, "committed + 有推演事件 → 必须产出规划");
  const content = plans.entries[0].content;

  // ① 关键回归：旧路径的占位文案必须消失（D11b 的验收点）
  ok(!content.includes("（暂无已归档的世界变化）"),
    `有 simulationEvents 时不得再退化成空账本占位行：实际「${content}」`);
  // ② 动向行确实来自 simulationEvents（含时段前缀）
  ok(content.includes("· [第 3 时段] 巴罗已抵达钟楼"),
    `已发生的推演事件要逐条进条目：实际「${content}」`);
  // ③ 意图不能冒充已发生（§2.3 停机线）
  ok(content.includes("· [第 3 时段] （意图）艾莉娅打算今夜把香料转手"),
    `意图要显式标注「（意图）」：实际「${content}」`);
  ok(!content.includes("· [第 3 时段] 艾莉娅打算今夜把香料转手"),
    "意图行不得省略标注、伪装成已发生的事实");
  // ④ 最新在前（读取事件数组的逆序），与旧 stateEvents 路径同口径
  ok(content.indexOf("巴罗已抵达钟楼") < content.indexOf("艾莉娅打算今夜把香料转手"),
    "事件按最新在前排列");
  // ⑤ 旧 stateEvents 路径的核心要素不变：当前时间照样写
  ok(content.includes("当前时间：第 3 时段"), "当前时间仍取回执时段");
  ok(content.length <= ATLAS_LOREBOOK_LIMITS.CONTENT_CHARS, "条目仍受 CONTENT_CHARS 上限约束");

  // 对照：不传 simulationDelta（旧档 / 旧调用点）→ 空 stateEvents 仍走占位行。
  // 这不是矛盾，而是「旧行为一字不变」的另一半；见本文件上面 0.9.40 那条用例。
  const legacy = buildLorebookPlans(D11B_WORLD, committedReceipt({ adoptedEventIds: [], currentLocationId: null }));
  ok(legacy.entries[0].content.includes("（暂无已归档的世界变化）"),
    "不传 simulationDelta 时旧占位行照旧（旧档兼容口径不变）");
});

test("D11b：hidden 与未送达的消息不得透出到主聊天注入", () => {
  const visible = d11bEvent({ simulationId: "sim:task-1", kind: "intent", status: "intent-recorded", summary: "艾莉娅打算今夜把香料转手" });
  const hidden = d11bEvent({ simulationId: "sim:secret", kind: "intent", status: "intent-recorded", summary: "巴罗私下盘算告发艾莉娅", visibility: "hidden" });
  const undeliveredSignal = d11bEvent({ simulationId: "sig:1", kind: "signal", status: "published", summary: "使者带出宣战文书" });
  const deliveredSignal = d11bEvent({ simulationId: "sig:2", kind: "signal", status: "published", summary: "钟楼传来封港令" });
  const farOnlySignal = d11bEvent({ simulationId: "sig:3", kind: "signal", status: "published", summary: "码头已封锁" });

  const plans = buildLorebookPlans(
    D11B_WORLD,
    committedReceipt({ adoptedEventIds: [] }),
    null,
    {
      branchKey: "canon",
      events: [visible, hidden, undeliveredSignal, deliveredSignal, farOnlySignal],
      deliveries: [
        // sig:2 送到过主角所在地 pt-1 → 可注入
        { signalId: "sig:2", recipientType: "location", recipientId: "pt-1" },
        // sig:3 只送到过别处 → 主角没获知，不得注入
        { signalId: "sig:3", recipientType: "location", recipientId: "pt-2" },
        // sig:1 没有任何送达记录（这里刻意只给别的 signal 的送达）
      ],
      protagonistLocationIds: ["pt-1"],
    },
  );
  ok(plans, "应产出规划");
  const content = plans.entries[0].content;

  ok(content.includes("艾莉娅打算今夜把香料转手"), "已知且已发生的意图照常进条目");
  ok(!content.includes("巴罗私下盘算告发艾莉娅"), "hidden 不进主聊天注入（默认关闭作者全知）");
  ok(!content.includes("使者带出宣战文书"), "一条还没送到任何地方的消息不算已发生的动向");
  ok(content.includes("钟楼传来封港令"), "真的送达过主角所在地的消息要注入");
  ok(!content.includes("码头已封锁"), "只送到别处的消息不得注入（主角并未获知）");
  // 送达记录本身不是「消息」：只有 location 收件人算到达，character 收件人不改变上面的判定
  const characterOnly = buildLorebookPlans(
    D11B_WORLD,
    committedReceipt({ adoptedEventIds: [], currentLocationId: null }),
    null,
    {
      branchKey: "canon",
      events: [undeliveredSignal],
      deliveries: [{ signalId: "sig:1", recipientType: "character", recipientId: "npc-1" }],
      protagonistLocationIds: [],
    },
  );
  ok(!characterOnly.entries[0].content.includes("使者带出宣战文书"),
    "只记了人物收件人、没有任何地点送达 → 仍不算「已发生的动向」");

  // 作者显式全知是**单独的开关**：打开才看得到 hidden（首版默认关闭，见 §2.3）
  const omniscient = buildLorebookPlans(
    D11B_WORLD,
    committedReceipt({ adoptedEventIds: [], currentLocationId: null }),
    null,
    { branchKey: "canon", events: [visible, hidden], deliveries: [], protagonistLocationIds: [], authorOmniscient: true },
  );
  ok(omniscient.entries[0].content.includes("巴罗私下盘算告发艾莉娅"),
    "authorOmniscient=true 是显式作者视图，hidden 才会出现");
});

test("D11b：推演事件有界（RECENT_LINES_MAX）且有事件时不落回 stateEvents", () => {
  const events = [];
  for (let i = 1; i <= 8; i += 1) {
    events.push(d11bEvent({
      simulationId: `sim:task-${i}`, kind: "intent", status: "intent-recorded",
      summary: `第 ${i} 条已知意图`, period: 3,
    }));
  }
  const plans = buildLorebookPlans(
    // 世界里有旧事件：推演事件存在时**不得**混入旧路径的行（否则同一条动向会出现两份）
    WORLD,
    committedReceipt({ adoptedEventIds: ["evt-1"] }),
    null,
    { branchKey: "canon", events, deliveries: [], protagonistLocationIds: [] },
  );
  const content = plans.entries[0].content;
  const lines = content.split("\n").filter((line) => line.startsWith("· "));
  equal(lines.length, ATLAS_LOREBOOK_LIMITS.RECENT_LINES_MAX,
    `动向行数必须收敛到 RECENT_LINES_MAX=${ATLAS_LOREBOOK_LIMITS.RECENT_LINES_MAX}`);
  ok(!content.includes("暗仓"), "有推演事件时不混入旧 stateEvents 的行（两条来源不叠加）");
  ok(lines.every((line) => line.includes("第 3 时段")), "每一行都带时段前缀");
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
      { category: "moves", comment: ATLAS_MOVES_ENTRY_COMMENT, keys: [ATLAS_MOVES_ENTRY_KEY], content: "动向", constant: true },
    ],
  };
  const parsed = parseAtlasLorebookPlans(valid);
  ok(parsed.ok, "合法载荷通过");
  equal(parsed.value.entries[0].constant, true, "constant 字段透传");
  equal(parsed.value.entries[0].keys[0], ATLAS_MOVES_ENTRY_KEY);

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
    { category: "moves", comment: ATLAS_MOVES_ENTRY_COMMENT, keys: [ATLAS_MOVES_ENTRY_KEY], content: "动向 A", constant: true },
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
  equal(first.written, 1, "写入一条滚动条目");
  equal(mock.saves.length, 1, "整书只保存一次");

  const second = await writer.syncTurn(PLANS_A);
  equal(second.created, false, "第二次不再建书");
  equal(second.written, 1, "仍写入一条（upsert）");
  equal(second.pruned, 0, "无存量不清理");

  const book = mock.books.get("Atlas · 星环余烬");
  equal(Object.keys(book.entries).length, 1, "书内恰好一条（按 comment 去重）");
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

test("写入器：0.9.40 存量清理——旧逐轮条目与状态总览一次性收敛为单条滚动条目", async () => {
  const mock = makeMockPort();
  const writer = makeWriter(mock, { now: () => 1 });

  // 直接塞一本 0.9.39 形态的书：12 条逐轮动向 + 12 条逐轮事件 + 1 条状态总览
  const legacyEntries = {};
  for (let turn = 1; turn <= 12; turn += 1) {
    legacyEntries[String(turn * 2)] = {
      uid: String(turn * 2), key: ["艾莉娅"], keysecondary: [],
      comment: `${ATLAS_LOREBOOK_PREFIX.moves} 第 ${turn} → ${turn + 1} 时段`, content: `t${turn}`, disable: false,
    };
    legacyEntries[String(turn * 2 + 1)] = {
      uid: String(turn * 2 + 1), key: ["集市广场"], keysecondary: [],
      comment: `${ATLAS_LOREBOOK_PREFIX.events} 第 ${turn + 1} 时段`, content: `e${turn}`, disable: false,
    };
  }
  legacyEntries["99"] = {
    uid: "99", key: ["Atlas 状态总览-Key"], keysecondary: [],
    comment: "Atlas 状态总览", content: "旧总览", constant: true, disable: false,
  };
  mock.books.set("Atlas · 星环余烬", { entries: legacyEntries });

  const result = await writer.syncTurn(PLANS_A);
  equal(result.pruned, 25, "25 条旧条目全部清除");
  const book = mock.books.get("Atlas · 星环余烬");
  const comments = Object.values(book.entries).map((e) => e.comment);
  equal(comments.length, 1, "书里只剩滚动条目");
  equal(comments[0], ATLAS_MOVES_ENTRY_COMMENT, "滚动条目 comment 固定");
  equal(result.entries.length, 1, "快照同步");

  // 再同步一轮：清理循环变 no-op
  const again = await writer.syncTurn(PLANS_A);
  equal(again.pruned, 0, "收敛后不再清理");
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
  equal(snap.written, 1, "快照带写入数");
  equal(snap.binding, "bound-by-atlas", "快照带绑定状态");
  equal(snap.entries.length, 1, "快照含书内全部 Atlas 条目");
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
  equal(result.written, PLANS_A.entries.length, "滚动条目写入");
  equal(result.binding, "bound-by-atlas", "聊天槽被 Atlas 绑定");
  ok(saves.length >= 1, "原生 saveWorldInfo 被调用");
  equal(savedMetadata, 1, "绑定后 saveMetadata 恰好一次");

  const stored = books.get(PLANS_A.bookName);
  const comments = Object.values(stored.entries).map((e) => e.comment);
  equal(comments.length, 1, "原生书里只有一条");
  ok(comments[0].startsWith(ATLAS_LOREBOOK_PREFIX.moves), "滚动条目在原生存储中");
  ok(Object.values(stored.entries).every((e) => e.probability === 100 && e.selective === true), "原生默认字段随条目落库");
});

test("角色卡世界书：解析出卡书 → 写入卡书、绑定槽零触碰；null → 回退专属书", async () => {
  const mockCard = makeMockPort();
  const writerCard = makeWriter(mockCard, { now: () => 3000, preferred: "艾莉莉亚的世界书" });
  const cardResult = await writerCard.syncTurn(PLANS_A);

  equal(cardResult.bookName, "艾莉莉亚的世界书", "条目写入角色卡主世界书");
  equal(cardResult.binding, "char-primary", "绑定状态 = char-primary");
  equal(cardResult.written, PLANS_A.entries.length, "条目写入");
  equal(mockCard.savedMetadata.length, 0, "完全不触碰聊天绑定槽");
  ok(mockCard.books.has("艾莉莉亚的世界书"), "卡书已落库");
  ok(!mockCard.books.has(PLANS_A.bookName), "专属书未创建");
  const storedCard = mockCard.books.get("艾莉莉亚的世界书");
  const cardComments = Object.values(storedCard.entries).map((e) => e.comment);
  equal(cardComments.length, 1, "卡书里只有一条");
  ok(cardComments[0].startsWith(ATLAS_LOREBOOK_PREFIX.moves), "滚动条目在卡书中");

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

test("0.9.40 滚动条目：固定 comment upsert、constant 蓝灯、每轮整体重写、不产生重复", async () => {
  const mock = makeMockPort();
  const writer = makeWriter(mock, { now: () => 1 });

  const first = await writer.syncTurn(PLANS_A);
  const book1 = mock.books.get("Atlas · 星环余烬");
  const entry1 = Object.values(book1.entries).find((e) => e.comment === ATLAS_MOVES_ENTRY_COMMENT);
  ok(entry1, "滚动条目已创建");
  equal(entry1.content, "动向 A", "首写内容");
  equal(entry1.constant, true, "constant 蓝灯常驻");
  equal(entry1.order, 9998, "高 order（照 shujuku 9998 区间）");
  equal(entry1.position, 0, "角色定义前（照 shujuku 卡上实际形态）");
  equal(entry1.prevent_recursion, true, "防递归");
  deepEqual(entry1.key, [ATLAS_MOVES_ENTRY_KEY], "占位 key（条目靠 constant 激活）");
  equal(first.written, 1, "只写一条");

  // 第二轮：内容变化 → 整体重写且仍只有一条
  await writer.syncTurn({ ...PLANS_A, entries: [{ ...PLANS_A.entries[0], content: "动向 B" }] });
  const book2 = mock.books.get("Atlas · 星环余烬");
  const matches = Object.values(book2.entries).filter((e) => e.comment === ATLAS_MOVES_ENTRY_COMMENT);
  equal(matches.length, 1, "滚动条目始终只有一条（upsert 不追加）");
  equal(matches[0].content, "动向 B", "内容整体重写");
  equal(matches[0].constant, true, "第二轮仍保持蓝灯");
});

// ---------------------------------------------------------------------------
// B05：聊天作用域与跨聊天隔离（施工计划 §3-B05 / 问题 F10）
// ---------------------------------------------------------------------------

/**
 * B05 夹具：**同一张角色卡 + 多个聊天**的真实拓扑。
 *
 * - 一本**共享主卡世界书**（character.data.extensions.world，随卡激活，所有聊天都看得到）；
 * - 每聊天各自的 chatMetadata（聊天绑定槽各自独立）；
 * - 每聊天各自解析出的 chatId + worldId（模拟 createLorebookPort 里
 *   `binding.worldId` 的解析结果——就是 B05 要求的作用域来源）。
 */
function makeChatScopeRig(options = {}) {
  const books = new Map();
  const saves = [];
  const worldId = options.worldId ?? "w1";
  const cardBook = options.cardBook ?? "艾莉莉亚的世界书";
  const injectionAvailable = options.injectionAvailable !== false;
  const injected = new Map();
  let injectFailures = options.injectFailures ?? 0;
  const failWrites = options.failWrites === true;
  const scopesResolved = [];
  let injectCalls = 0;

  const chats = new Map();
  function chat(chatId) {
    if (!chats.has(chatId)) {
      chats.set(chatId, { chatMetadata: {}, savedMetadata: 0, chatId, worldId });
    }
    return chats.get(chatId);
  }

  const api = {
    async loadWorldInfo(name) {
      const raw = books.get(name);
      return raw ? JSON.parse(JSON.stringify(raw)) : null;
    },
    async createNewWorldInfo(name) {
      if (!books.has(name)) books.set(name, { entries: {} });
    },
    async saveWorldInfo(name, data) {
      if (failWrites) throw new Error("B05 夹具：写书失败");
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

  function portFor(scope) {
    const owner = chat(scope.chatId);
    return {
      async loadBook(name) {
        try {
          const data = await api.loadWorldInfo(name);
          return data ?? null;
        } catch {
          return null;
        }
      },
      async createBook(name) {
        await api.createNewWorldInfo(name);
      },
      async saveBook(name, data) {
        await api.saveWorldInfo(name, data);
      },
      createEntry(data, patch) {
        const entry = api.createWorldInfoEntry("Atlas", data);
        if (!entry) return null;
        entry.key = [...patch.keys];
        entry.keysecondary = [];
        entry.comment = patch.comment;
        entry.content = patch.content;
        entry.disable = false;
        entry.constant = patch.constant === true;
        if (typeof patch.order === "number") entry.order = patch.order;
        if (typeof patch.position === "number") entry.position = patch.position;
        entry.prevent_recursion = patch.preventRecursion === true;
        entry.selective = true;
        return entry;
      },
      deleteEntry(data, uid) {
        api.deleteWorldInfoEntry(data, uid);
      },
      async resolvePreferredBook() {
        return cardBook;
      },
      async resolveChatScope() {
        scopesResolved.push(owner.chatId);
        return { chatId: owner.chatId, worldId: owner.worldId };
      },
      async getChatBookName() {
        const name = owner.chatMetadata.world_info;
        return typeof name === "string" && name.trim().length > 0 ? name : null;
      },
      async bindChatBook(name) {
        owner.chatMetadata.world_info = name;
        owner.savedMetadata += 1;
      },
      async injectTurn(key, value) {
        injectCalls += 1;
        if (!injectionAvailable) throw new Error("B05 夹具：宿主没有 setExtensionPrompt");
        if (injectFailures > 0) {
          injectFailures -= 1;
          throw new Error("B05 夹具：注入通道故障");
        }
        injected.set(key, value);
      },
    };
  }

  return {
    api,
    books,
    saves,
    chats,
    cardBook,
    worldId,
    injected,
    scopesResolved,
    get injectCalls() {
      return injectCalls;
    },
    /** 给某个聊天造一个 writer（作用域由 resolveChatScope 解析，与生产 createLorebookPort 同形） */
    writer(chatId, opts = {}) {
      const owner = chat(chatId);
      return createAtlasLorebookWriter(portFor(owner), { now: opts.now ?? (() => 5000) });
    },
    comments(bookName) {
      const book = books.get(bookName);
      return book ? Object.values(book.entries).map((e) => e.comment) : [];
    },
    /** 往共享主卡书里塞 0.9.58 形态的存量：2 条旧 Atlas 动态条目 + 1 条用户静态条目 */
    seedLegacyCardBook() {
      books.set(cardBook, {
        entries: {
          "1": { uid: "1", key: ["Atlas 动向-Key"], keysecondary: [], comment: "Atlas 动向", content: "旧共享动向（无作用域）", constant: true, disable: false },
          "2": { uid: "2", key: ["艾莉娅"], keysecondary: [], comment: "Atlas 动向 第 3 → 4 时段", content: "更旧的逐轮动向", disable: false },
          "3": {
            uid: "3", key: ["圣罗兰"], keysecondary: [],
            comment: "用户的静态设定", content: "圣罗兰城：城墙高三十米。", constant: false, disable: false,
          },
        },
      });
    },
  };
}

function scopedPlans(content, bookName = "Atlas · 星环余烬") {
  return {
    bookName,
    entries: [{ category: "moves", comment: ATLAS_MOVES_ENTRY_COMMENT, keys: [ATLAS_MOVES_ENTRY_KEY], content, constant: true }],
  };
}

test("B05：作用域名/书名/注入 key 是纯函数——同 chatId+worldId 稳定，不同聊天必不同", () => {
  equal(atlasLorebookScopeKey("chat-A", "w1"), atlasLorebookScopeKey("chat-A", "w1"), "同输入 → 同作用域键（确定性）");
  ok(atlasLorebookScopeKey("chat-A", "w1") !== atlasLorebookScopeKey("chat-B", "w1"), "不同聊天 → 不同作用域键");
  ok(atlasLorebookScopeKey("chat-A", "w1") !== atlasLorebookScopeKey("chat-A", "w2"), "不同世界 → 不同作用域键");
  ok(atlasLorebookScopeKey("chat A", "w1").includes("chat-A"), "空白折叠成 -（文件名义安全）");
  const longChat = "c".repeat(60);
  const longKey = atlasLorebookScopeKey(longChat, "w1");
  ok(longKey.includes(atlasLorebookChatFingerprint(longChat)), "超长 chatId 用确定性指纹收敛，不静默合并");
  ok(
    atlasLorebookScopeKey(`${"c".repeat(40)}x`, "w1") !== atlasLorebookScopeKey(`${"c".repeat(40)}y`, "w1"),
    "前 40 字相同、尾巴不同 → 仍是两个键（哈希兜住）",
  );

  const bookA = scopeBookName("Atlas · 星环余烬", { chatId: "chat-A", worldId: "w1" });
  const bookB = scopeBookName("Atlas · 星环余烬", { chatId: "chat-B", worldId: "w1" });
  ok(bookA !== bookB, "两个聊天的专属书名不同（写的是两本书）");
  equal(bookA, scopeBookName("Atlas · 星环余烬", { chatId: "chat-A", worldId: "w1" }), "同作用域 → 同书名");
  ok(bookA.startsWith("Atlas · 星环余烬"), "书名保留世界基底");
  ok(bookA.length <= ATLAS_LOREBOOK_LIMITS.BOOK_NAME_CHARS, "书名有界");
  ok(!/[\\/:*?"<>|]/.test(bookA), "书名不含 ST 服务端不接受的字符");
  equal(scopeBookName("Atlas · 星环余烬", null), "Atlas · 星环余烬", "无作用域 → 沿用旧书名形态");
  equal(scopeBookName("Atlas · 星环余烬", { chatId: "", worldId: "w1" }), "Atlas · 星环余烬", "缺 chatId → 不硬凑作用域");

  equal(normalizeAtlasLorebookScope({ chatId: " a ", worldId: " w1 " }).chatId, "a", "作用域字段去空白");
  equal(normalizeAtlasLorebookScope({ chatId: "", worldId: "w1" }), null, "空 chatId → null（不造假身份）");
  equal(normalizeAtlasLorebookScope({ chatId: "a" }), null, "缺 worldId → null");
  equal(normalizeAtlasLorebookScope(null), null, "null → null");
  ok(atlasLorebookScopeEquals({ chatId: "a", worldId: "w" }, { chatId: "a", worldId: "w" }), "同作用域判定为真");
  ok(!atlasLorebookScopeEquals({ chatId: "a", worldId: "w" }, { chatId: "b", worldId: "w" }), "不同聊天判定为假");
  ok(!atlasLorebookScopeEquals({ chatId: "a", worldId: "w" }, null), "缺席作用域判定为假");

  const keyA = atlasLorebookInjectionKey({ chatId: "chat-A", worldId: "w1" });
  const keyB = atlasLorebookInjectionKey({ chatId: "chat-B", worldId: "w1" });
  ok(keyA.startsWith(ATLAS_LOREBOOK_INJECTION_KEY_PREFIX), "注入 key 带 Atlas 前缀");
  ok(keyA !== keyB, "注入 key 按聊天作用域命名，不串档");
});

test("B05：条目归属判定——旧共享条目可迁移、别人的条目是别人的、用户条目 foreign 且永不清理", () => {
  const scope = { chatId: "chat-A", worldId: "w1" };
  const own = classifyAtlasLorebookEntry(atlasScopedEntryComment(scope), scope);
  equal(own.reason, "scoped-current", "本聊天的作用域条目 = 当前的");
  equal(own.owned, true, "归属为真");
  equal(own.pruneable, false, "当前条目不可清理");

  const other = classifyAtlasLorebookEntry(atlasScopedEntryComment({ chatId: "chat-B", worldId: "w1" }), scope);
  equal(other.reason, "scoped-other", "别的聊天的条目 = 别人的");
  equal(other.owned, false, "绝不当成自己的");
  equal(other.pruneable, true, "别人的遗留条目可清理（本聊天内容已走新路径）");

  equal(classifyAtlasLorebookEntry("Atlas 动向", scope).reason, "legacy", "0.9.58 无作用域滚动条目 = 旧路径");
  equal(classifyAtlasLorebookEntry("Atlas 动向 第 3 → 4 时段", scope).reason, "legacy", "旧逐轮条目光是 legacy");
  equal(classifyAtlasLorebookEntry("Atlas 事件 第 4 时段", scope).reason, "legacy", "旧事件条目是 legacy");
  equal(classifyAtlasLorebookEntry("Atlas 状态总览", scope).reason, "legacy", "0.9.35 总览是 legacy");
  equal(classifyAtlasLorebookEntry("Atlas 动向", scope).pruneable, true, "legacy 可在新路径成功后清理");

  const user = classifyAtlasLorebookEntry("用户的静态设定", scope);
  equal(user.reason, "foreign", "用户条目 = foreign");
  equal(user.atlas, false, "用户条目不是 Atlas 条目");
  equal(user.pruneable, false, "用户条目必须原样保留（静态世界书不移动）");
  equal(user.comment, "", "用户条目的原文不外泄进判定结果");
  equal(classifyAtlasLorebookEntry("Atlas 动向", null).owned, false, "作用域缺席时任何条目都不归属当前聊天");
  equal(classifyAtlasLorebookEntry(undefined, scope).reason, "foreign", "非法 comment 一律当用户条目（宁可不删）");

  const summary = summarizeAtlasLorebookOwnership({
    entries: {
      "1": { comment: "Atlas 动向" },
      "2": { comment: "用户的静态设定" },
      "3": { comment: atlasScopedEntryComment(scope) },
      "10": { comment: atlasScopedEntryComment({ chatId: "chat-B", worldId: "w1" }) },
    },
  }, scope);
  equal(summary.current, 1, "当前作用域条目 1 条");
  equal(summary.stale, 2, "旧路径 + 别的聊天共 2 条待清理");
  deepEqual(summary.staleUids, ["1", "10"], "待清理 uid 按数值序确定");
  equal(summary.foreign, 1, "用户条目 1 条（不算进待清理）");
});

test("B05：两个聊天并行开同一角色卡——互不可见对方的「Atlas 动向」，共享主卡书不被写动态条目", async () => {
  // 注入通道缺席的宿主（老酒馆 / 未接 setExtensionPrompt）→ 必须走「按 chatId+worldId
  // 独立的专属世界书」这条回退路径，这正是两聊天最容易互见的场景。
  const rig = makeChatScopeRig({ injectionAvailable: false });
  rig.seedLegacyCardBook();
  const writerA = rig.writer("chat-A");
  const writerB = rig.writer("chat-B");

  // A 先跑一轮
  const resultA = await writerA.syncTurn(scopedPlans("A 的动向：艾莉娅在集市广场"));
  equal(resultA.contentTarget, "book", "无注入通道 → 动态内容落专属世界书");
  equal(resultA.scopeKey, atlasLorebookScopeKey("chat-A", "w1"), "回执带当前作用域键");
  equal(resultA.binding, "bound-by-atlas", "专属书模式绑定空槽");

  // B 紧接着跑一轮（同一张卡、同一个 worldId、不同 chatId）
  const resultB = await writerB.syncTurn(scopedPlans("B 的动向：巴罗在钟楼"));
  ok(resultA.bookName !== resultB.bookName, "两个聊天写到两本不同的书");
  equal(resultB.scopeKey, atlasLorebookScopeKey("chat-B", "w1"), "B 的作用域键与 A 不同");

  // 互不可见：A 的书里没有 B 的动向，B 的书里没有 A 的动向
  const bookA = rig.books.get(resultA.bookName);
  const bookB = rig.books.get(resultB.bookName);
  ok(bookA && bookB, "两本专属书都已落库");
  const entriesA = Object.values(bookA.entries);
  const entriesB = Object.values(bookB.entries);
  equal(entriesA.length, 1, "A 的书里恰好一条");
  equal(entriesB.length, 1, "B 的书里恰好一条");
  equal(entriesA[0].content, "A 的动向：艾莉娅在集市广场", "A 只看到自己的动向");
  equal(entriesB[0].content, "B 的动向：巴罗在钟楼", "B 只看到自己的动向");
  ok(!JSON.stringify(bookB).includes("艾莉娅在集市广场"), "B 的书里搜不到 A 的内容（互不可见两个方向）");
  ok(!JSON.stringify(bookA).includes("巴罗在钟楼"), "A 的书里搜不到 B 的内容");
  equal(entriesA[0].comment, atlasScopedEntryComment({ chatId: "chat-A", worldId: "w1" }), "A 条目的 comment 带 A 的作用域");
  equal(entriesB[0].comment, atlasScopedEntryComment({ chatId: "chat-B", worldId: "w1" }), "B 条目的 comment 带 B 的作用域");
  ok(entriesA[0].comment !== entriesB[0].comment, "两条 comment 不同（面板/后续读取都分得清归属）");
  deepEqual(resultA.ownedEntries.map((e) => e.content), ["A 的动向：艾莉娅在集市广场"], "回执的 ownedEntries 只含自己的条目");
  deepEqual(resultB.ownedEntries.map((e) => e.content), ["B 的动向：巴罗在钟楼"], "B 同理");

  // 共享主卡书：动态条目已被迁移清空，且**从未**被写入任一聊天的动态内容
  const cardBook = rig.books.get(rig.cardBook);
  ok(cardBook, "共享主卡书仍在");
  ok(!JSON.stringify(cardBook).includes("A 的动向：艾莉娅在集市广场"), "共享主卡书没有 A 的动态条目");
  ok(!JSON.stringify(cardBook).includes("B 的动向：巴罗在钟楼"), "共享主卡书没有 B 的动态条目");
  for (const comment of rig.comments(rig.cardBook)) {
    ok(!comment.startsWith(ATLAS_LOREBOOK_PREFIX.moves), `共享主卡书已无 Atlas 动向条目：实际「${comment}」`);
    ok(!comment.startsWith(ATLAS_SCOPED_COMMENT_PREFIX), `共享主卡书已无作用域条目：实际「${comment}」`);
  }
  equal(resultA.cleanedShared, 2, "A 那次把共享书里的 2 条旧 Atlas 条目清掉（新路径成功之后）");
  equal(resultA.sharedClean, true, "A 的回执报告共享书已无跨聊天动态条目");
  equal(resultB.cleanedShared, 0, "B 那次已无需清理（A 已清空）；清理是幂等的 no-op");
  equal(resultB.sharedClean, true, "B 的回执同样报告共享书干净");
  equal(resultB.keptForeign, 0, "共享书里没有残留的跨聊天动态条目");

  // 静态用户设定在任何一次同步后都原样保留
  equal(rig.comments(rig.cardBook).filter((c) => c === "用户的静态设定").length, 1, "用户静态条目仍在共享书里");
  const userEntry = Object.values(rig.books.get(rig.cardBook).entries).find((e) => e.comment === "用户的静态设定");
  equal(userEntry.content, "圣罗兰城：城墙高三十米。", "用户条目的内容逐字未改");
  equal(userEntry.disable, false, "用户条目的启停状态未改");

  // 重复同步不产生重复条目（同作用域 upsert）
  await writerA.syncTurn(scopedPlans("A 的动向：艾莉娅改在钟楼"));
  const entriesA2 = Object.values(rig.books.get(resultA.bookName).entries);
  equal(entriesA2.length, 1, "A 再同步仍只有一条");
  equal(entriesA2[0].content, "A 的动向：艾莉娅改在钟楼", "内容整体重写");
  ok(!JSON.stringify(rig.books.get(resultB.bookName)).includes("艾莉娅改在钟楼"), "A 的新内容不会出现在 B 的书里");
});

test("B05：迁移旧 Atlas 条目只在新路径成功后——成功才清共享书，失败则旧条目原样保留", async () => {
  // --- 成功路径：专属书写成功后，共享书里的 legacy 条目才被清掉 ---
  const rig = makeChatScopeRig({ injectionAvailable: false });
  rig.seedLegacyCardBook();
  const writer = rig.writer("chat-A");
  const result = await writer.syncTurn(scopedPlans("A 的动向：新路径已成功"));
  ok(rig.books.has(result.bookName), "新路径（专属书）已写成功");
  equal(result.migrated, 2, "成功后迁移掉 2 条 legacy 条目");
  equal(result.cleanedShared, 2, "其中共享书清理 2 条");
  equal(result.keptForeign, 0, "没有残留的跨聊天动态条目");
  equal(result.sharedClean, true, "共享书报告干净");
  deepEqual(rig.comments(rig.cardBook), ["用户的静态设定"], "共享书只剩用户条目");
  equal(result.pruned, 2, "回执 pruned 汇总迁移清理数");
  const snapshot = writer.snapshot(scopedPlans("A 的动向：新路径已成功"), result);
  equal(snapshot.migrated, 2, "快照带迁移数");
  equal(snapshot.sharedClean, true, "快照带共享书干净标志");
  equal(snapshot.scopeKey, atlasLorebookScopeKey("chat-A", "w1"), "快照带作用域键");

  // --- 失败路径：新路径整条不通 → 旧条目必须原样保留（旧档无损） ---
  const broken = makeChatScopeRig({ failWrites: true, injectionAvailable: false });
  broken.seedLegacyCardBook();
  const brokenWriter = broken.writer("chat-A");
  await assert.rejects(
    () => brokenWriter.syncTurn(scopedPlans("写不进去的动向")),
    /写书失败/,
    "两条路径都失败 → 向上抛错（调用方可重试）",
  );
  deepEqual(
    broken.comments(broken.cardBook),
    ["Atlas 动向", "Atlas 动向 第 3 → 4 时段", "用户的静态设定"],
    "新路径失败 → 共享书里的旧 Atlas 条目与用户条目全部原样保留",
  );
  equal(broken.saves.length, 0, "失败路径没有产生任何一次成功保存");

  // --- 注入失败但专属书成功：仍然只在新路径成功后清理 ---
  const flash = makeChatScopeRig({ injectFailures: 1 });
  flash.seedLegacyCardBook();
  const flashWriter = flash.writer("chat-A");
  const flashResult = await flashWriter.syncTurn(scopedPlans("注入挂了但书写成功"));
  equal(flashResult.contentTarget, "book", "注入失败 → 落回专属世界书");
  equal(flashResult.migrated, 2, "回退路径写成功后同样完成迁移");
  deepEqual(flash.comments(flash.cardBook), ["用户的静态设定"], "共享书同样被清干净");
});

test("B05：注入通道可用时动态内容只走当前聊天（setExtensionPrompt 优先），旧条目在新路径成功后清理", async () => {
  const rig = makeChatScopeRig();
  rig.seedLegacyCardBook();
  const writer = rig.writer("chat-A");
  const result = await writer.syncTurn(scopedPlans("A 的动向：只注入给当前聊天"));

  equal(result.contentTarget, "injection", "有注入通道 → 动态内容走注入，不写世界书");
  equal(result.binding, "injected", "绑定状态如实标注 injected");
  equal(result.injectionKey, atlasLorebookInjectionKey({ chatId: "chat-A", worldId: "w1" }), "注入 key 按作用域命名");
  equal(rig.injectCalls, 1, "恰好调用一次注入");
  ok(rig.injected.has(result.injectionKey), "注入内容落在当前聊天的 key 上");
  const text = rig.injected.get(result.injectionKey);
  ok(text.includes("A 的动向：只注入给当前聊天"), "注入文本含本轮动向");
  ok(text.includes("仅限当前聊天"), "注入文本带边界说明（这一轮临时上下文，不属于共享书）");
  equal(buildAtlasInjectionText(scopedPlans("x".repeat(1000))).length, ATLAS_LOREBOOK_LIMITS.INJECTION_CHARS, "注入文本有界");
  equal(buildAtlasInjectionText(null), "", "空规划 → 空注入文本");
  equal(buildAtlasInjectionText(null), buildAtlasInjectionText(undefined), "空输入确定性");

  // 注入路径不写专属书（动态内容不落共享/专属世界书）
  const scopedName = scopeBookName("Atlas · 星环余烬", { chatId: "chat-A", worldId: "w1" });
  ok(!rig.books.has(scopedName), "注入路径不创建专属书（内容只在注入通道里）");
  equal(result.written, 0, "注入路径没有写任何世界书（计数如实为 0，送达由 contentTarget 表达）");
  // 新路径成功之后才清共享书
  equal(result.migrated, 2, "注入成功后迁移旧条目");
  deepEqual(rig.comments(rig.cardBook), ["用户的静态设定"], "共享书只剩用户静态条目");
  equal(result.sharedClean, true, "回执报告共享书已干净");
  equal(rig.chats.get("chat-A").savedMetadata, 0, "注入路径不触碰聊天绑定槽");
});

test("B05：专属书绑定槽冲突（共享书被别的聊天绑着）→ 绝不覆盖，只报 skipped-conflict", async () => {
  const rig = makeChatScopeRig({ injectionAvailable: false });
  // 别的聊天已经把共享主卡书绑进本聊天的槽（真实场景：用户手动绑 / 遗留绑定）
  rig.chats.set("chat-A", { chatMetadata: { world_info: rig.cardBook }, savedMetadata: 0, chatId: "chat-A", worldId: rig.worldId });
  const writer = rig.writer("chat-A");
  const result = await writer.syncTurn(scopedPlans("A 的动向：专属书已写"));
  equal(result.binding, "skipped-conflict", "已绑定别的书 → skipped-conflict（不覆盖）");
  equal(result.existingBookName, rig.cardBook, "回执带回原绑定书名");
  equal(rig.chats.get("chat-A").chatMetadata.world_info, rig.cardBook, "绑定槽逐字未改");
  equal(rig.chats.get("chat-A").savedMetadata, 0, "没有发生任何绑定写");
  ok(rig.books.has(result.bookName), "内容仍已写进本聊天的专属书（不丢）");
});

test("B05：未接作用域的旧调用点行为与 0.9.58 一致（回执如实标注未隔离）", async () => {
  const mock = makeMockPort();
  const writer = makeWriter(mock, { preferred: null });
  const result = await writer.syncTurn(PLANS_A);
  equal(result.contentTarget, "none", "无作用域 → 旧路径（contentTarget=none）");
  equal(result.scopeKey, null, "没有作用域键");
  equal(result.sharedClean, false, "未隔离时不谎报共享书干净");
  equal(result.binding, "bound-by-atlas", "旧绑定语义不变");
  equal(result.entries.length, 1, "旧条目视图不变");
  equal(mock.books.get(PLANS_A.bookName).entries["1"].comment, ATLAS_MOVES_ENTRY_COMMENT, "旧调用点仍写固定 comment（不擅自加作用域）");
  const snapshot = writer.snapshot(PLANS_A, result);
  equal(snapshot.schemaVersion, 1, "快照版本不变");
  equal(snapshot.scopeKey, null, "快照带作用域字段（旧行为下为 null）");
});

test("B05：两个聊天**同时**（Promise.all）开同一角色卡 → 仍互不可见、共享书无动态条目", async () => {
  const rig = makeChatScopeRig({ injectionAvailable: false });
  rig.seedLegacyCardBook();
  const writerA = rig.writer("chat-A");
  const writerB = rig.writer("chat-B");

  // 真正并行：两轮同步的 await 交错，作用域与迁移顺序都必须扛得住
  const [resultA, resultB] = await Promise.all([
    writerA.syncTurn(scopedPlans("A 并行动向：艾莉娅守集市")),
    writerB.syncTurn(scopedPlans("B 并行动向：巴罗登钟楼")),
  ]);
  ok(resultA.bookName !== resultB.bookName, "并行也各自写各自的书");
  ok(!JSON.stringify(rig.books.get(resultA.bookName)).includes("B 并行动向"), "A 的书里没有 B 的动向");
  ok(!JSON.stringify(rig.books.get(resultB.bookName)).includes("A 并行动向"), "B 的书里没有 A 的动向");
  equal(Object.values(rig.books.get(resultA.bookName).entries).length, 1, "A 的书恰好一条");
  equal(Object.values(rig.books.get(resultB.bookName).entries).length, 1, "B 的书恰好一条");

  // 共享书：只有用户静态条目，动态条目一条不剩（A/B 谁先清都是幂等 no-op）
  deepEqual(rig.comments(rig.cardBook), ["用户的静态设定"], "共享书并行跑完只剩用户条目");
  ok(resultA.sharedClean && resultB.sharedClean, "两份回执都报告共享书干净");
  equal(resultA.keptForeign + resultB.keptForeign, 0, "没有残留的跨聊天动态条目");
  // 说明：并发下两次清理可能各自读到同一份旧快照（各报 migrated=2），也可能一先一后
  // （2 + 0）——两者都合法。硬要求只有一条：**实际最终状态**里旧动态条目归零。
  ok(
    resultA.migrated + resultB.migrated >= 2 && resultA.migrated <= 2 && resultB.migrated <= 2,
    `两次上报的迁移数都在合法区间（实际 ${resultA.migrated} + ${resultB.migrated}）`,
  );
  const leftover = rig
    .comments(rig.cardBook)
    .filter((c) => c.startsWith(ATLAS_LOREBOOK_PREFIX.moves) || c.startsWith(ATLAS_SCOPED_COMMENT_PREFIX));
  deepEqual(leftover, [], "共享书最终状态：跨聊天动态条目归零");
  ok(rig.comments(rig.cardBook).includes("用户的静态设定"), "用户静态条目在并发迁移后仍在");
});

test("本轮累计断言已记录（计数见报告）", () => {
  ok(assertionCount > 60, `断言数：${assertionCount}`);
});
