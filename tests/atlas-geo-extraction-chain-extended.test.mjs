/**
 * atlas-geo-extraction-chain-extended.test.mjs — H04 / H05 / H06a / H06b / H06c / H18b 回归。
 *
 * 姊妹文件 `tests/atlas-geo-extraction-chain.test.mjs` 锁的是 `planGeoRelations` 的
 * 纯函数语义（有引文才落库 / 重名歧义 / 未知父 / 不改入参）。本文件补上**它没有覆盖**、
 * 但同属这条提炼链的硬性口径：
 *
 *  - H04：`runGeoExtraction` 真正发出去的契约长什么样（抓真实请求体断言字段表与禁令），
 *         以及旧模型只回 `{name, regionName}` 时照样能解析；
 *  - H05：端到端两趟 —— 重名复用、合法父子只落子图、具名 pending 落进回执与 geoAuto、
 *         绝不造第二个同名地点；成环 / 自指 / 未知父 / 超深的具名拒绝；输出形状；
 *  - H06a：标定清洗上限 80，第 41 张不被无提示截掉；
 *  - H06b：`applyNewLocations` 不再给新地点写死 `"start"` 地区默认值；
 *  - H06b / H06c：提炼新建行 schematic → 三表 `gridX/gridY = null` + `pointMeta` 标 schematic，
 *         人工已确认坐标保留，螺旋镜像坐标绝不进三表；
 *  - H18b：首次建出世界图后调用 `ensureMapScaleOnCreate`（成功 / 待定 / 复用 / 不重复请求）。
 *
 * 纪律：ID 与时间全确定性（注入 `now`，不用 Date.now / Math.random）；只读 src，不改实现。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildStarterWorld } from "../src/atlas-starter-world.ts";
import { legacyStartWorld } from "./atlas-legacy-start-world.mjs";
import { createAtlasServerCore, createMemoryDocumentStore, planGeoRelations } from "../src/atlas-server.ts";
import {
  MAP_DOC_CALIBRATIONS_MAX,
  MAP_DOC_LIMITS,
  applyNewLocations,
  mapDocOverCapLosses,
  sanitizeMapDoc,
} from "../src/atlas-geo-apply.ts";
import { layoutUnplacedMarkers } from "../src/atlas-map-layout.ts";
import { createSessionCarrier, carrierAsCore } from "./atlas-session-helper.mjs";

const NOW = 1_700_000_000_000;
const WORLD_ID = "world-geo-chain-0123456789abcdef";
const EMPTY_WORLD_ID = "world-geo-chain-empty-0123456789";
const LEGACY_WORLD_ID = "world-geo-chain-legacy-0123456789";
const CHAT_ID = "chat-1";
/** 正史线的 branchKey 恒为 `canon`（binding.branchId = null）。 */
const BRANCH_KEY = "canon";
const SECRET = "sk-geo-chain-secret";

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

function openAiResponse(content) {
  const payload = JSON.stringify({ choices: [{ message: { content } }] });
  return { ok: true, status: 200, json: async () => JSON.parse(payload), text: async () => payload };
}

/**
 * 端到端夹具：`createAtlasServerCore` + `createSessionCarrier`（会话随请求往返）。
 * `entry` 决定用哪条建世路由：旧档形状走 `/worlds/ensure-starter`，空地理新世界走 `/worlds/import`。
 */
async function makeCore({ world, entry = "import", fetchScripts = [], configurePreset = true, lazyMigrate = true }) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const script = fetchScripts[Math.min(calls.length - 1, fetchScripts.length - 1)];
    if (!script) throw new Error(`意外触发了模型请求（第 ${calls.length} 次）`);
    return script();
  };
  const store = createMemoryDocumentStore();
  const rawCore = createAtlasServerCore({ store, fetchFn, now: () => NOW });
  const carrier = createSessionCarrier(rawCore);
  const core = carrierAsCore(carrier);
  await core.handle(
    "POST",
    entry === "ensure-starter" ? "/worlds/ensure-starter" : "/worlds/import",
    { world: JSON.parse(JSON.stringify(world)) },
    { local: true },
  );
  await core.handle("POST", "/bindings", {
    action: "bind",
    binding: {
      schemaVersion: 1,
      enabled: true,
      chatId: CHAT_ID,
      characterId: null,
      worldId: world.id,
      branchId: null,
      currentLocationId: null,
      worldTimeCursor: 0,
      lastCommittedMessageId: null,
      lastCheckpointId: null,
    },
  });
  if (configurePreset) {
    await core.handle("PUT", "/settings", {
      worldTurn: {
        name: "模拟推演", endpoint: "https://mock.example.invalid/v1", model: "atlas-mock",
        apiKey: SECRET, timeoutMs: 5000,
      },
    }, { local: true });
  }
  // 懒迁移出三表（E02 的补齐目标必须存在，否则回执只会是 TABLE_BRANCH_MISSING）
  if (lazyMigrate) await core.handle("GET", `/state/${CHAT_ID}`);
  return { store, core, carrier, calls, callCount: () => calls.length };
}

function adopt(core, body = {}) {
  return core.handle("POST", "/worlds/geo/adopt", { chatId: CHAT_ID, ...body });
}

/** 旧档形状：1 个「起点」地区 + 1 个「起点」地点（id=1）。 */
function legacyWorld() {
  return legacyStartWorld({ id: LEGACY_WORLD_ID, now: NOW, name: "地理链" });
}

/** 空地理新世界：0 地区 0 地点（R06 起 buildStarterWorld 的正常形状）。 */
function emptyWorld() {
  return buildStarterWorld({ id: EMPTY_WORLD_ID, now: NOW, name: "空地理" });
}

function locationsOf(carrier) {
  return carrier.session.tables.branches[BRANCH_KEY].locations;
}

function worldPointByName(carrier, name) {
  return (carrier.session.world.points ?? []).filter((point) => point.name === name);
}

/* ------------------------------------------------------------------ *
 * H04：提炼契约
 * ------------------------------------------------------------------ */

const CONTRACT_PREFIX = "只输出一个 JSON 对象：";

function messagesOf(call) {
  const messages = call?.body?.messages;
  assert.ok(Array.isArray(messages) && messages.length > 0, "提炼请求必须带 messages 段");
  return messages;
}

function userContentOf(call) {
  const user = messagesOf(call).find((message) => message.role === "user");
  assert.ok(user, "提炼请求必须带 user 段（否则模型看不到契约）");
  return String(user.content ?? "");
}

/** 契约行就是那段 JSON 模板；解析得动才说明字段表是结构化的，而不是一句自然语言。 */
function contractOf(content) {
  const line = content.split("\n").find((row) => row.startsWith(CONTRACT_PREFIX));
  assert.ok(line, `契约行必须以「${CONTRACT_PREFIX}」开头`);
  return JSON.parse(line.slice(CONTRACT_PREFIX.length));
}

test("H04：契约把 parentName/relation/mobile/anchorName/evidenceQuote 列为可选字段，且明令禁止坐标与每格米数", async () => {
  const { core, calls } = await makeCore({
    world: legacyWorld(),
    entry: "ensure-starter",
    fetchScripts: [() => openAiResponse(JSON.stringify({ regions: [], points: [{ name: "白桦教室" }] }))],
  });
  const result = await adopt(core, { loreSupplement: "- 白桦教室：学校里的教室" });
  assert.equal(result.status, 200, `提炼应成功：${JSON.stringify(result.body.error ?? {})}`);
  assert.equal(calls.length, 1, "世界书模式恰好一条提炼请求");

  const messages = messagesOf(calls[0]);
  const system = messages.find((message) => message.role === "system");
  assert.ok(system, "必须带 system 段");
  assert.ok(String(system.content).includes("地理信息抽取器"), "system 段声明抽取器角色");
  assert.ok(String(system.content).includes("只输出一个 JSON 对象"), "system 段要求单对象输出");

  const content = userContentOf(calls[0]);
  const spec = contractOf(content);

  // ① H04：从 {name, regionName} 扩展出来的可选字段一个不少
  assert.deepEqual(Object.keys(spec.regions[0]), ["name", "description"]);
  assert.deepEqual(
    Object.keys(spec.points[0]),
    ["name", "regionName", "parentName", "relation", "mobile", "anchorName", "evidenceQuote"],
    "契约字段表必须与 H04 施工单一致",
  );
  assert.equal(spec.points[0].relation, "contained|adjacent|none", "relation 只有三态");
  assert.equal(spec.points[0].mobile, "vehicle|fixed", "mobile 只有两态");

  // ② H04：契约**不要求**模型输出坐标 / 每格米数 / 边界
  for (const forbidden of ["gridX", "gridY", "metersPerCell", "coordinateStatus", "boundary"]) {
    assert.ok(!(forbidden in spec.points[0]), `契约不得要求模型输出 ${forbidden}`);
  }
  assert.ok(!content.includes('"gridX"'), "契约里不得把 gridX 列成输出字段");
  assert.ok(!content.includes("metersPerCell"), "提示词里不得出现 metersPerCell（那是程序推导的）");
  assert.ok(
    content.includes("绝对不要输出 gridX / gridY / 坐标 / 每格米数 / 边界范围"),
    "必须显式禁止坐标 / 每格米数 / 边界",
  );

  // ③ H04：只提炼有文字确证的关系；名字相似不算证据（计划点名的反例要写进规则）
  assert.ok(content.includes("不要因为地名相似"), "必须显式禁止按地名相似度推断包含");
  assert.ok(content.includes("「XX外城区」与「XX城」"), "计划点名的反例必须写进规则");
  assert.ok(content.includes("evidenceQuote = 证明上面那条关系的那句原文"), "必须定义引文字段");
  assert.ok(content.includes("逐字连续"), "引文必须逐字命中才算证据");
  assert.ok(content.includes("留待作者确认"), "拿不出引文要留待确认，而不是硬写");
  assert.ok(content.includes("宁可留待确认，也不要编"), "缺证据时的默认动作是留待确认");

  // ④ H04：沿用原有地区 / 地点上限；没有地理信息就输出空对象
  assert.ok(content.includes("最多 12 个地区、40 个地点"), "沿用原有地区/地点上限");
  assert.ok(content.includes('{"regions":[],"points":[]}'), "没有地理信息时的空输出契约");

  // ⑤ 这个夹具走的是世界书模式，取材说明与原文都必须进请求体（引文核验的 materials）
  assert.ok(content.includes("从下面的角色卡世界书资料中提炼"), "世界书模式要有对应的取材说明");
  assert.ok(content.includes("【世界书资料】"), "世界书原文要随请求下发");
  assert.ok(content.includes("白桦教室：学校里的教室"), "本轮资料进入请求体（引文核验的对照材料）");
});

/* ------------------------------------------------------------------ *
 * H04：向后兼容（旧模型只回 {name, regionName}）
 * ------------------------------------------------------------------ */

test("H04：旧模型只回 {name, regionName} 照样解析——不因缺新字段整单失败", async () => {
  const legacyShape = JSON.stringify({
    regions: [{ name: "低语森林", description: "迷雾笼罩的古老森林" }],
    points: [
      { name: "避风树洞", regionName: "低语森林" },
      { name: "无名石碑" },
    ],
  });
  const { core, carrier, calls } = await makeCore({
    world: legacyWorld(),
    entry: "ensure-starter",
    fetchScripts: [() => openAiResponse(legacyShape)],
  });
  const result = await adopt(core, { loreSupplement: "- 低语森林：迷雾笼罩的古老森林" });

  assert.equal(result.status, 200, `旧形状必须照常成功：${JSON.stringify(result.body.error ?? {})}`);
  assert.equal(result.body.data.regionsAdded, 1);
  assert.equal(result.body.data.pointsAdded, 2);
  assert.deepEqual(result.body.data.pending, [], "模型没声明关系 → 一条 pending 都不该凭空产生");
  assert.equal(calls.length, 1, "仍然只发一条提炼请求");

  const rows = result.body.data.preview;
  assert.equal(rows.length, 2, "两个新地点都要出现在预览里");
  for (const row of rows) {
    assert.deepEqual(
      Object.keys(row).sort(),
      ["adjacent", "id", "name", "parent", "pending", "reasonCode", "vehicle"],
      "预览行形状必须是 H05 的 {id,parent,adjacent,vehicle,pending,reasonCode}（外加 name）",
    );
    assert.equal(row.parent, null, "旧模型没给 parentName → 不得凭空造父");
    assert.deepEqual(row.adjacent, []);
    assert.equal(row.vehicle, null);
    assert.equal(row.pending, false, "没有声明关系就不是待确认");
    assert.equal(row.reasonCode, "NO_RELATION");
  }

  // 世界与三表都真的长出来了；regionName 照旧映射到新地区
  const treeHole = (carrier.session.world.points ?? []).find((point) => point.name === "避风树洞");
  assert.ok(treeHole, "地点落库");
  assert.equal(treeHole.regionId, (carrier.session.world.regions ?? []).find((r) => r.name === "低语森林").id);
  const steleRow = locationsOf(carrier).find((row) => row.name === "无名石碑");
  assert.ok(steleRow, "地点进三表");
  assert.equal(result.body.data.tables?.status, "synced");
});

/* ------------------------------------------------------------------ *
 * H05：纯函数——结构校验（成环 / 自指 / 未知父 / 超深 / 输出形状）
 * ------------------------------------------------------------------ */

const planLoc = (id, name, parentLocationId = null) => ({ id, name, parentLocationId });

function planCand(overrides = {}) {
  return {
    id: "loc:100", name: "三年二班", existing: false, relation: "none",
    counterpartName: null, mobile: null, anchorName: null, evidenceQuote: null,
    ...overrides,
  };
}

test("H05：成环 / 自指 / 未知父 / 超过 4 层全部具名 pending，同一批里已确认的关系一个都不丢", () => {
  // 既有父链：P1 ← P2 ← P3 ← P4 ← P5（P5 的父在上溯 4 跳处）
  const chain = [
    planLoc("loc:p1", "P1"),
    planLoc("loc:p2", "P2", "loc:p1"),
    planLoc("loc:p3", "P3", "loc:p2"),
    planLoc("loc:p4", "P4", "loc:p3"),
    planLoc("loc:p5", "P5", "loc:p4"),
    planLoc("loc:a", "A城"),
    planLoc("loc:b", "B镇", "loc:a"),
  ];
  const plan = planGeoRelations({
    locations: chain,
    candidates: [
      // 成环：A城 想认 B镇 当父，而 B镇 已经挂在 A城 下面
      planCand({ id: "loc:a", name: "A城", existing: true, relation: "contained", counterpartName: "B镇", evidenceQuote: "B镇就在A城边上" }),
      // 自指
      planCand({ id: "loc:c", name: "C村", relation: "contained", counterpartName: "C村", evidenceQuote: "C村就是C村" }),
      // 未知父
      planCand({ id: "loc:d", name: "D港", relation: "contained", counterpartName: "从未出现过的地名", evidenceQuote: "D港在那个地方" }),
      // 超深：P5 上溯已经 4 跳，再挂一层 = 5 层
      planCand({ id: "loc:e", name: "E村", relation: "contained", counterpartName: "P5", evidenceQuote: "E村在P5里" }),
      // 深度边界内的合法关系（同批必须照样落定 → 证明不是「一坏全废」）
      planCand({ id: "loc:f", name: "F村", relation: "contained", counterpartName: "P4", evidenceQuote: "F村在P4里" }),
    ],
    quoteSource: (quote) => (quote.length > 0 ? "worldbook" : null),
  });

  const reasons = new Map(plan.pending.map((row) => [row.fromName, row.reasonCode]));
  assert.equal(reasons.get("A城"), "PARENT_CYCLE", "成环必须具名拒绝");
  assert.equal(reasons.get("C村"), "PARENT_SELF", "自指必须具名拒绝");
  assert.equal(reasons.get("D港"), "PARENT_UNRESOLVED", "未知父必须具名拒绝");
  assert.equal(reasons.get("E村"), "PARENT_DEPTH_EXCEEDED", "超过 4 层必须具名拒绝");
  for (const row of plan.pending) {
    assert.equal(row.fromLocationId !== null, true, `pending 行要指出是谁提的关系：${JSON.stringify(row)}`);
    assert.ok(typeof row.toName === "string" && row.toName.length > 0, "pending 行要带对端名字");
  }

  // 边界：正好第 4 层合法；超过才拒
  assert.deepEqual(plan.parents, [{ childId: "loc:f", parentId: "loc:p4" }], "合法父链只落这一条（不多不少）");

  // 已确认地点一个都不丢：本批每个候选都在预览里（loc:b 本轮不是候选，不进预览）
  const previewIds = plan.preview.map((row) => row.id).sort();
  assert.deepEqual(previewIds, ["loc:a", "loc:c", "loc:d", "loc:e", "loc:f"], "预览不得丢行");
  const accepted = plan.preview.find((row) => row.id === "loc:f");
  assert.equal(accepted.parent, "loc:p4");
  assert.equal(accepted.pending, false);
  assert.equal(accepted.reasonCode, "EVIDENCE_CONFIRMED");
  for (const id of ["loc:a", "loc:c", "loc:d", "loc:e"]) {
    assert.equal(plan.preview.find((row) => row.id === id).parent, null, `${id} 的关系不得落库`);
  }
});

test("H05：对端重名（同名不同 id）→ LOCATION_NAME_AMBIGUOUS，绝不替作者挑一个", () => {
  const plan = planGeoRelations({
    locations: [planLoc("loc:1", "圣罗兰城"), planLoc("loc:9", "圣罗兰城")],
    candidates: [
      planCand({
        id: "loc:20", name: "奴隶市场",
        relation: "contained", counterpartName: "圣罗兰城", evidenceQuote: "市场就在城内",
      }),
    ],
    quoteSource: () => "story",
  });
  assert.deepEqual(plan.parents, [], "同名两处时不得任选一个当父");
  assert.equal(plan.pending.length, 1, "重名必须留待用户确认，不是悄悄丢掉");
  assert.equal(plan.pending[0].reasonCode, "LOCATION_NAME_AMBIGUOUS");
  assert.equal(plan.pending[0].kind, "contained");
  assert.equal(plan.pending[0].fromLocationId, "loc:20");
  assert.equal(plan.pending[0].toName, "圣罗兰城");
  const row = plan.preview.find((item) => item.id === "loc:20");
  assert.equal(row.parent, null, "预览里不得预选任何一个同名地点");
  assert.equal(row.pending, true);
  assert.equal(row.reasonCode, "LOCATION_NAME_AMBIGUOUS");
});

test("H05：输出形状与「载具的相邻 = 可执行路段」——只有过了证据校验的才落 adjacencies / routes / vehicles", () => {
  const material = [
    "城门就在城北",
    "马车停在驿站外",
    "船停在不存在的港口",
    "货船往返于驿站码头",
    "荒野孤塔立在风里",
  ];
  const plan = planGeoRelations({
    locations: [planLoc("loc:1", "圣罗兰城"), planLoc("loc:2", "北方驿站")],
    candidates: [
      planCand({ id: "loc:10", name: "城门", relation: "adjacent", counterpartName: "圣罗兰城", evidenceQuote: "城门就在城北" }),
      planCand({ id: "loc:11", name: "马车", mobile: "vehicle", anchorName: "北方驿站", evidenceQuote: "马车停在驿站外" }),
      planCand({ id: "loc:12", name: "无证马车", mobile: "vehicle", anchorName: "北方驿站" }),
      planCand({ id: "loc:13", name: "幽灵船", mobile: "vehicle", anchorName: "不存在的地方", evidenceQuote: "船停在不存在的港口" }),
      planCand({ id: "loc:14", name: "货船", relation: "adjacent", counterpartName: "北方驿站", mobile: "vehicle", evidenceQuote: "货船往返于驿站码头" }),
      planCand({ id: "loc:15", name: "荒野孤塔", relation: "contained", counterpartName: "不存在的城堡", evidenceQuote: "荒野孤塔立在风里" }),
    ],
    quoteSource: (quote) => (material.includes(quote) ? "story" : null),
  });

  // 形状：每条预览行都是 {id,parent,adjacent,vehicle,pending,reasonCode}（+ name）
  for (const row of plan.preview) {
    assert.deepEqual(
      Object.keys(row).sort(),
      ["adjacent", "id", "name", "parent", "pending", "reasonCode", "vehicle"],
      `预览行形状不符：${JSON.stringify(row)}`,
    );
    assert.ok(Array.isArray(row.adjacent) && typeof row.pending === "boolean");
    assert.ok(typeof row.reasonCode === "string" && row.reasonCode.length > 0);
  }

  // 行人相邻 → adjacencies；载具相邻 → routes（H11 只认与载具本体相连的 route 边）
  assert.deepEqual(plan.adjacencies, [{ fromLocationId: "loc:10", toLocationId: "loc:1", evidence: "story" }]);
  assert.deepEqual(plan.routes, [{ fromLocationId: "loc:14", toLocationId: "loc:2", evidence: "story" }]);
  assert.equal(
    plan.adjacencies.some((row) => row.fromLocationId === "loc:14"),
    false,
    "载具的 adjacent 不得退化成步行邻接",
  );

  // 停靠载具：锚点有据 → stopped 落在锚点上
  assert.deepEqual(plan.preview.find((row) => row.id === "loc:11").vehicle, { atLocationId: "loc:2", status: "stopped" });
  // 缺引文的载具：绝不落锚点，进 pending
  const noEvidence = plan.preview.find((row) => row.id === "loc:12");
  assert.equal(noEvidence.vehicle, null, "没有引文不得写锚点");
  assert.equal(noEvidence.pending, true);
  assert.equal(noEvidence.reasonCode, "NO_EVIDENCE");
  // 有引文但锚点解析不到：车确实存在（unknown），同时留待确认
  const ghost = plan.preview.find((row) => row.id === "loc:13");
  assert.deepEqual(ghost.vehicle, { atLocationId: null, status: "unknown" });
  assert.equal(ghost.reasonCode, "ANCHOR_UNRESOLVED");
  assert.deepEqual(
    plan.vehicles.filter((row) => row.locationId === "loc:13"),
    [{ locationId: "loc:13", atLocationId: null, evidence: "story" }],
  );
  assert.equal(plan.vehicles.some((row) => row.locationId === "loc:12"), false, "缺引文的载具不得进 vehicles");

  // pending 行同样具名（kind + reasonCode）
  const pendingCodes = plan.pending.map((row) => `${row.kind}:${row.reasonCode}`).sort();
  assert.deepEqual(pendingCodes, [
    "anchor:ANCHOR_UNRESOLVED",
    "anchor:ANCHOR_UNRESOLVED",
    "contained:PARENT_UNRESOLVED",
    "vehicle:NO_EVIDENCE",
  ]);
});

/* ------------------------------------------------------------------ *
 * H05：端到端两趟提炼（/worlds/geo/adopt）
 * ------------------------------------------------------------------ */

const STORY_TEXT = [
  "他们走进圣罗兰城，奴隶市场就在圣罗兰城内，铁笼一排排立在广场边。",
  "驿站与圣罗兰城之间只隔着一条河，渡船一天两趟。",
  "荒野孤塔立在风里，很久没有人来过。",
  "灰篷马车停在驿站外，车夫靠着车辕打盹。",
].join("\n");

function pendingChainExtraction() {
  return JSON.stringify({
    regions: [{ name: "北境", description: "故事发生的北境" }],
    points: [
      { name: "圣罗兰城", regionName: "北境" },
      { name: "圣罗兰奴隶市场", regionName: "北境", parentName: "圣罗兰城", relation: "contained", evidenceQuote: "奴隶市场就在圣罗兰城内" },
      { name: "圣罗兰外城区", parentName: "圣罗兰城", relation: "contained" },
      { name: "北方驿站", parentName: "圣罗兰城", relation: "adjacent", evidenceQuote: "驿站与圣罗兰城之间只隔着一条河" },
      { name: "灰篷马车", mobile: "vehicle", anchorName: "北方驿站", evidenceQuote: "马车停在驿站外" },
      { name: "无据哨所", parentName: "圣罗兰城", relation: "contained", evidenceQuote: "这句原文根本不在资料里" },
      { name: "荒野孤塔", parentName: "不存在的城堡", relation: "contained", evidenceQuote: "荒野孤塔立在风里" },
      { name: "圣罗兰奴隶市场", regionName: "北境" },
      { name: "起点" },
    ],
  });
}

test("H05 端到端：合法父子只落子图、重名复用不造第二个同名点、四类关系按证据分流", async () => {
  const { core, carrier, calls } = await makeCore({
    world: legacyWorld(),
    entry: "ensure-starter",
    fetchScripts: [() => openAiResponse(pendingChainExtraction())],
  });
  const result = await adopt(core, { recentTexts: [STORY_TEXT] });

  assert.equal(result.status, 200, `提炼应成功：${JSON.stringify(result.body.error ?? {})}`);
  const data = result.body.data;
  assert.equal(data.regionsAdded, 1);
  assert.equal(data.pointsAdded, 7, "7 个新地点（含重复名的那个只建一次）");
  assert.equal(data.skipped, 2, "重复的新名字 + 已存在的「起点」各跳过一次");
  assert.equal(calls.length, 1, "两趟都在服务端完成，不再多发请求");
  // 剧情模式必须把已有地理名单随请求下发（防止模型重复输出已有城市 → 造第二个同名地点）
  const storyContent = userContentOf(calls[0]);
  assert.ok(storyContent.includes("已有地理（禁止重复输出这些名字）：起点"),
    "剧情模式要下发已有地名名单（夹具里是「起点」）");
  assert.ok(storyContent.includes("【近期剧情（AI 输出，按时间先后）】"), "剧情正文要随请求下发");
  assert.equal(data.tables?.status, "synced");
  assert.equal(data.tables?.added?.locations, 7);

  const world = carrier.session.world;
  const byName = (name) => (world.points ?? []).filter((point) => point.name === name);
  const ids = Object.fromEntries(
    ["圣罗兰城", "圣罗兰奴隶市场", "圣罗兰外城区", "北方驿站", "灰篷马车", "无据哨所", "荒野孤塔"]
      .map((name) => [name, byName(name)[0].id]),
  );

  // ① 重名：模型重复输出同一个新地名 → 绝不造第二个同名地点
  assert.equal(byName("圣罗兰奴隶市场").length, 1, "同名只允许一行");
  assert.equal(byName("起点").length, 1, "已有地点被复用，不是又建一个");
  const tableNames = locationsOf(carrier).map((row) => row.name);
  assert.equal(tableNames.filter((name) => name === "圣罗兰奴隶市场").length, 1);
  assert.equal(tableNames.filter((name) => name === "起点").length, 1);

  // ② 合法父子：预览层如实回报「有引文确证的 contained」（H05 第二趟的判定结果）
  const marketRow = locationsOf(carrier).find((row) => row.name === "圣罗兰奴隶市场");
  assert.ok(marketRow, "新地点必须进三表");
  const previewById = new Map(data.preview.map((row) => [row.id, row]));
  const marketPreview = previewById.get(marketRow.id);
  assert.equal(marketPreview.parent, `loc:${ids["圣罗兰城"]}`, "有逐字引文的包含关系必须被判为已确认");
  assert.equal(marketPreview.pending, false);
  assert.equal(marketPreview.reasonCode, "EVIDENCE_CONFIRMED");
  const cityPoint = (world.points ?? []).find((point) => point.name === "圣罗兰城");
  assert.equal(cityPoint.parentPointId, undefined, "父地点自己不得被写成任何人的孩子");

  /**
   * 缺陷 A（已发现并写入交付报告，未改 src）：判定为「已确认」的父子关系**没有落进世界镜像与三表**。
   *
   * 实测（本轮夹具，与 planGeoRelations 的纯函数结论对得上）：
   *   `preview` 给出 `loc:3.parent === "loc:2"`，
   *   但 `world.points[3].parentPointId === undefined`、
   *   且 `tables.locations[loc:3].parentLocationId === null`，
   *   日志里恰好一条 `world-geo-mirror-links-skipped`（skipped=1, scanned=0）。
   * 根因：`src/atlas-server.ts` 的 `nextPoints` 只拷贝**既有**世界点，新地点在后面才追加进
   * `points`，于是 `plan.parents` 对新子点在 `pointById` 里永远查不到条目而被跳过；
   * 三表的 `parentLocationId` 又是由这个镜像投影（`rebuildBranchTablesFromWorld`）得出的。
   *
   * 这里**不把该行为固化成期望**（写成 `parentLocationId === null` 会让修复反而变红），
   * 只锁「预览层如实回报」与 ③④ 的安全侧。
   */

  // ③ 缺引文 / 引文不在材料 / 未知父：安全侧一律不落库
  const outerRow = locationsOf(carrier).find((row) => row.name === "圣罗兰外城区");
  assert.equal(outerRow.parentLocationId, null,
    "「圣罗兰外城区」不能因为名字里含「圣罗兰城」就自动变成城市的下级（计划点名的反例）");
  const sentryRow = locationsOf(carrier).find((row) => row.name === "无据哨所");
  assert.equal(sentryRow.parentLocationId, null, "引文不在材料里 → 绝不落库");
  const towerRow = locationsOf(carrier).find((row) => row.name === "荒野孤塔");
  assert.equal(towerRow.parentLocationId, null, "父地点根本不存在 → 绝不落库");

  // ④ 具名 pending 落进回执（作者据此去 H07a 人工确认）
  const pendingByFrom = new Map(data.pending.map((row) => [row.fromName, row]));
  assert.equal(pendingByFrom.get("无据哨所")?.reasonCode, "QUOTE_NOT_FOUND", "引文找不到必须具名");
  assert.equal(pendingByFrom.get("荒野孤塔")?.reasonCode, "PARENT_UNRESOLVED", "未知父必须具名");
  assert.equal(pendingByFrom.get("无据哨所")?.toName, "圣罗兰城");
  assert.equal(pendingByFrom.get("无据哨所")?.kind, "contained");
  assert.equal(data.pendingTotal, data.pending.length);
  // 已知缺口 B（详见交付报告）：缺引文的 contained（「圣罗兰外城区」）只守住「不落库」，
  // 没有进 pending —— 这里只锁安全属性，不把该行为固化成预期。
  assert.equal(
    data.pending.some((row) => row.fromName === "圣罗兰外城区" && row.reasonCode === "EVIDENCE_CONFIRMED"),
    false,
    "缺引文的关系绝不能被当成已确认",
  );

  // ⑤ 具名 pending 也要留痕（会话 geoAuto），不能只活在这一次响应里
  const pendingDoc = carrier.session.geoAuto?.[`pending:${world.id}`];
  assert.ok(pendingDoc, "pending 必须落进会话 geoAuto");
  assert.equal(pendingDoc.branchKey, BRANCH_KEY);
  assert.ok(pendingDoc.rows.some((row) => row.reasonCode === "QUOTE_NOT_FOUND"));
  assert.ok(pendingDoc.rows.some((row) => row.reasonCode === "PARENT_UNRESOLVED"));

  // ⑥ 预览行如实回报每一类分流
  assert.equal(previewById.get(outerRow.id).parent, null);
  assert.equal(previewById.get(sentryRow.id).reasonCode, "QUOTE_NOT_FOUND");
  assert.equal(previewById.get(towerRow.id).reasonCode, "PARENT_UNRESOLVED");
  assert.equal(previewById.get("loc:1").reasonCode, "EXISTING_REUSED", "复用既有地点要如实标注，不是新建");
  const stationRow = locationsOf(carrier).find((row) => row.name === "北方驿站");
  assert.deepEqual(previewById.get(stationRow.id).adjacent, [`loc:${ids["圣罗兰城"]}`], "有引文的相邻落进 adjacent");

  // ⑦ 已确认的邻接边真的进了本分支 geoTopology（且只有这一条）
  const edges = carrier.session.simulation.branches[BRANCH_KEY].geoTopology.edges;
  assert.equal(edges.length, 1, "只有一条有证据的相邻边");
  assert.deepEqual(
    [edges[0].fromLocationId, edges[0].toLocationId].sort(),
    [`loc:${ids["圣罗兰城"]}`, stationRow.id].sort(),
  );
  assert.equal(edges[0].kind, "adjacent");
  assert.equal(edges[0].channel, "walk");
  assert.equal(edges[0].evidence, "story", "证据来源如实标注为正文");

  // ⑧ H06c：载具锚点只由「有引文 + 锚点解析得到」的提炼结果写
  const anchors = carrier.session.simulation.branches[BRANCH_KEY].geoTopology.vehicles;
  assert.equal(anchors.length, 1, "恰好一条载具锚点（没有引文的载具不得落锚）");
  assert.equal(anchors[0].id, `loc:${ids["灰篷马车"]}`, "锚点 id 恒等于其地点行 id");
  assert.equal(anchors[0].locationId, `loc:${ids["灰篷马车"]}`);
  assert.equal(anchors[0].atLocationId, `loc:${ids["北方驿站"]}`, "停靠点来自有引文的 anchorName");
  assert.equal(anchors[0].status, "stopped");
  assert.equal(anchors[0].evidence, "story");
  assert.equal(anchors[0].routeEdgeId, null, "没有路线边就不许编一条");
});

/* ------------------------------------------------------------------ *
 * H06b：不再写死 "start" 地区默认值
 * ------------------------------------------------------------------ */

test("H06b：applyNewLocations 不再给新地点写死 \"start\"，但显式 regionName 照旧解析", () => {
  const empty = emptyWorld();
  const outcome = applyNewLocations(
    empty,
    [{ name: "白桦教室" }, { name: "旧钟楼", regionName: "从未出现过的地区" }],
    { now: NOW },
  );
  assert.equal(outcome.pointsAdded, 2);
  const classroom = outcome.world.points.find((point) => point.name === "白桦教室");
  assert.ok(classroom, "新地点落库");
  assert.ok(
    classroom.regionId === null || classroom.regionId === undefined,
    `空地理世界不得回退到 "start"（实际 ${JSON.stringify(classroom.regionId)}）`,
  );
  const tower = outcome.world.points.find((point) => point.name === "旧钟楼");
  assert.ok(
    tower.regionId === null || tower.regionId === undefined,
    `regionName 解析不到时也要留空，绝不写死不存在的地区（实际 ${JSON.stringify(tower.regionId)}）`,
  );

  // 旧世界里真有 start 地区：解析不到仍然留空（不是「找不到就塞 start」）
  const legacy = legacyWorld();
  const legacyOutcome = applyNewLocations(legacy, [{ name: "避风树洞" }], { now: NOW });
  assert.ok(
    !legacyOutcome.world.points.find((point) => point.name === "避风树洞").regionId,
    "没有 regionName 的新地点保持无归属",
  );
  // 只去掉「写死的默认值」，没有误伤显式归属
  const mapped = applyNewLocations(legacy, [{ name: "森林边缘", regionName: "起点" }], { now: NOW });
  assert.equal(mapped.world.points.find((point) => point.name === "森林边缘").regionId, "start");

  // H06b：返回新点 id 的 schematic 集合，供调用方原子写 maps.pointMeta
  assert.deepEqual(outcome.schematicPointIds, outcome.createdPoints.map((point) => point.id));
  assert.equal(outcome.schematicPointIds.length, 2);
  assert.ok(outcome.createdPoints.every((point) => Number.isInteger(point.id)),
    "schematic 集合是地图 sidecar 的键，必须是数字点位 id");
});

/* ------------------------------------------------------------------ *
 * H06b / H06c：坐标三态（schematic / confirmed / legacy-unknown）
 * ------------------------------------------------------------------ */

test("H06b/H06c：提炼新建行 schematic → 三表 gridX/gridY=null、pointMeta 标 schematic；人工已确认值保留", async () => {
  const { core, carrier, calls } = await makeCore({
    world: legacyWorld(),
    entry: "ensure-starter",
    fetchScripts: [
      () => openAiResponse(JSON.stringify({ regions: [], points: [{ name: "白桦教室" }] })),
      () => openAiResponse(JSON.stringify({ regions: [], points: [{ name: "旧钟楼" }, { name: "灰瓦仓库" }] })),
    ],
  });

  // 第一轮提炼：把地点建出来，同时把三表带回会话。
  // （A08 的懒迁移是**只读请求内的临时挂载**：只有写请求的响应才会把会话树带回浏览器，
  //   所以第二轮之前必须先有一轮真实写入，否则本地会话里根本没有三表可改。）
  const first = await adopt(core, { loreSupplement: "- 白桦教室：学校里的教室" });
  assert.equal(first.status, 200, `第一轮提炼应成功：${JSON.stringify(first.body.error ?? {})}`);
  assert.equal(locationsOf(carrier).some((row) => row.name === "白桦教室"), true, "第一轮地点进三表");

  // 作者这一侧的动作：给既有行手工确认坐标；把**下一个**新点位标成 confirmed（H07a 的人工确认值）
  const originRow = locationsOf(carrier).find((row) => row.name === "起点");
  originRow.gridX = 17;
  originRow.gridY = 23;
  carrier.session.maps = {
    schemaVersion: 2,
    pointMeta: { "3": { coordinateStatus: "confirmed" } },
    submaps: {},
    calibrations: {},
  };

  // 第二轮提炼：一个新点是 confirmed（人工值），另一个是缺省 schematic
  const second = await adopt(core, { loreSupplement: "- 旧钟楼：北境的旧塔\n- 灰瓦仓库：码头边的仓库" });
  assert.equal(second.status, 200, `第二轮提炼应成功：${JSON.stringify(second.body.error ?? {})}`);
  assert.equal(second.body.data.pointsAdded, 2);
  assert.equal(calls.length, 2, "补坐标是本地推导，不发额外请求");

  const classroom = (carrier.session.world.points ?? []).find((point) => point.name === "白桦教室");
  const tower = (carrier.session.world.points ?? []).find((point) => point.name === "旧钟楼");
  const shed = (carrier.session.world.points ?? []).find((point) => point.name === "灰瓦仓库");
  assert.equal(tower.id, 3, "点位 id 从既有最大值递增（夹具确定性）");
  assert.equal(shed.id, 4);
  const classroomRow = locationsOf(carrier).find((row) => row.name === "白桦教室");
  const towerRow = locationsOf(carrier).find((row) => row.name === "旧钟楼");
  const shedRow = locationsOf(carrier).find((row) => row.name === "灰瓦仓库");

  // ① schematic（缺省）：三表坐标必须是 null —— 螺旋坐标只是镜像排版，绝不参与精确距离
  assert.equal(shedRow.gridX, null, "schematic 地点不得有格坐标");
  assert.equal(shedRow.gridY, null);
  assert.ok(Number.isFinite(shed.x) && Number.isFinite(shed.y),
    "旧 schema 兼容镜像仍要有有限坐标（否则旧客户端画不出点）");
  assert.notEqual(shedRow.gridX, shed.x, "镜像 x 绝不能被当成三表格坐标");

  // ② confirmed（作者已确认）：人工数值保留
  assert.equal(towerRow.gridX, tower.x, "confirmed 的人工数值必须保留（H06c）");
  assert.equal(towerRow.gridY, tower.y);

  // ③ 既有行的人工坐标不因补地理被重排（第二轮提炼也没动它）
  assert.equal(originRow.gridX, 17, "已人工锁定的既有坐标不得被重排");
  assert.equal(originRow.gridY, 23);
  // 第一轮的行也不会被第二轮重排
  assert.equal(classroomRow.gridX, null, "第一轮的 schematic 行保持 null");
  assert.equal(classroomRow.gridY, null);
  assert.ok(Number.isFinite(classroom.x) && Number.isFinite(classroom.y));

  // ④ maps.pointMeta 的新键必须标 schematic（供 H06a/UI 区分「示意」与「已确认」）
  assert.equal(carrier.session.maps.pointMeta[String(shed.id)].coordinateStatus, "schematic");

  // ⑤ 「UI 说未知、后台却拿螺旋坐标算出精确距离」的正面反证：
  //    把刚提炼出来的行喂给示意排版，它只能进 schematic 通道，不能冒充真实坐标。
  const layout = layoutUnplacedMarkers({
    branchKey: BRANCH_KEY,
    mapId: "world",
    frame: { cols: 100, rows: 100, frameRevision: 1 },
    unplaced: [{ id: shedRow.id, name: shedRow.name, mapId: shedRow.mapId }],
  });
  assert.deepEqual(layout.confirmed, [], "三表没有确认坐标 → 不得进「真实坐标」通道");
  assert.equal(layout.displayOnly.length, 1);
  assert.equal(layout.displayOnly[0].id, shedRow.id);
  assert.equal(layout.displayOnly[0].displayOnly, true);
  assert.equal(layout.displayOnly[0].coordinateStatus, "schematic");
});

test("H06a：pointMeta.coordinateStatus 原样往返；未知 / 缺失值按 legacy-unknown 解读，不清空地图", () => {
  const doc = sanitizeMapDoc({
    schemaVersion: 2,
    pointMeta: {
      "3": { coordinateStatus: "schematic" },
      "4": { coordinateStatus: "confirmed" },
      "5": { coordinateStatus: "legacy-unknown" },
      "6": { description: "旧档点位", coordinateStatus: "这不是合法值" },
      "7": { description: "没有状态字段的旧档点位" },
    },
    submaps: {},
    calibrations: {},
  });
  assert.equal(doc.pointMeta["3"].coordinateStatus, "schematic");
  assert.equal(doc.pointMeta["4"].coordinateStatus, "confirmed");
  assert.equal(doc.pointMeta["5"].coordinateStatus, "legacy-unknown", "三态之一必须原样保留");
  assert.equal(doc.pointMeta["6"].coordinateStatus, undefined, "未知值不得冒充三态之一 → 调用方按 legacy-unknown 读");
  assert.equal(doc.pointMeta["6"].description, "旧档点位", "一个坏状态不得清空该点的其它信息");
  assert.equal(doc.pointMeta["7"].coordinateStatus, undefined, "旧档缺字段照读（legacy-unknown 语义）");
  assert.equal(doc.pointMeta["7"].description, "没有状态字段的旧档点位");
});

/* ------------------------------------------------------------------ *
 * H06a：标定上限 80
 * ------------------------------------------------------------------ */

test("H06a：标定清洗上限 80，第 41 张不被无提示截掉；真超限时截断数量可查", () => {
  assert.equal(MAP_DOC_LIMITS.calibrations, 80);
  assert.equal(MAP_DOC_CALIBRATIONS_MAX, 80, "上限必须是 80（40 会被 IF 的 branchKey|mapId 键挤爆）");

  const calibration = (index) => ({
    revision: 1, metersPerCell: 5, source: "user", locked: true,
    basis: `第 ${index} 张标定`, coverage: "约 500m × 500m", confidence: "high", at: NOW,
  });
  const build = (count) => {
    const calibrations = {};
    for (let index = 1; index <= count; index += 1) calibrations[`if-${index}|classroom`] = calibration(index);
    return { schemaVersion: 2, pointMeta: {}, submaps: {}, calibrations };
  };

  const fortyOne = build(41);
  const doc = sanitizeMapDoc(fortyOne);
  assert.equal(Object.keys(doc.calibrations).length, 41, "41 张必须一张不少（旧上限 40 会静默吃掉最后一张）");
  assert.equal(doc.calibrations["if-41|classroom"].metersPerCell, 5, "第 41 张必须还在");
  assert.equal(doc.calibrations["if-41|classroom"].basis, "第 41 张标定");
  assert.equal(doc.calibrations["if-1|classroom"].basis, "第 1 张标定");
  assert.deepEqual(
    mapDocOverCapLosses(fortyOne),
    { pointMeta: 0, submaps: 0, calibrations: 0, submapPoints: 0 },
    "41 张不算超限：丢失统计必须是 0",
  );

  // 真超限（>80）仍会截断，但**必须可被调用方算出来**（据此留具名痕迹，不得静默）
  const eightyOne = build(81);
  assert.equal(Object.keys(sanitizeMapDoc(eightyOne).calibrations).length, 80);
  assert.equal(mapDocOverCapLosses(eightyOne).calibrations, 1, "第 81 张的丢失数量必须可查");
});

/* ------------------------------------------------------------------ *
 * H18b：建图时标定
 * ------------------------------------------------------------------ */

const POINT_JSON = JSON.stringify({ regions: [], points: [{ name: "望海楼" }] });
const SCALE_ESTIMATED = JSON.stringify({
  status: "estimated", extentMeters: { width: 1000, height: 1000 },
  coverage: "望海楼一带", basis: "资料写了方圆十里", confidence: "medium", evidence: [],
});
const SCALE_UNKNOWN = JSON.stringify({
  status: "unknown", extentMeters: null, coverage: "", basis: "材料不足", confidence: "low", evidence: [],
});

test("H18b：本轮首次建出世界图 → 顺势标定成功，标定落在当前分支的 key 上（含 frame 证据）", async () => {
  const { core, carrier, calls } = await makeCore({
    world: emptyWorld(),
    entry: "import",
    fetchScripts: [() => openAiResponse(POINT_JSON), () => openAiResponse(SCALE_ESTIMATED)],
  });
  const result = await adopt(core, { loreSupplement: "- 望海楼：临海石楼，方圆十里" });

  assert.equal(result.status, 200, `提炼应成功：${JSON.stringify(result.body.error ?? {})}`);
  assert.equal(result.body.data.pointsAdded, 1, "地点照常落库");
  assert.equal(calls.length, 2, "恰好两次模型请求：提炼 1 条 + 建图标定 1 条");
  assert.equal(result.body.data.mapScale.status, "calibrated", `建图后必须给出尺度状态：${JSON.stringify(result.body.data.mapScale)}`);

  // 标定真的落在「当前分支 + 这张图」的键上（正史 = 裸 mapId）
  const calibration = carrier.session.maps.calibrations.world;
  assert.ok(calibration, "maps.calibrations 里必须有这张图的键");
  assert.equal(calibration.metersPerCell, 10, "1000 米 / 100 格 = 10 米/格（程序从 frame 推导）");
  assert.equal(calibration.source, "ai-estimated");
  assert.equal(calibration.locked, false, "AI 估计默认不锁，人工可覆盖");

  // 建图前先有 frame：标定请求必须带 frame，模型不许自己猜画布
  const scaleText = JSON.stringify(calls[1].body);
  assert.ok(scaleText.includes("frameRevision=1"), "标定请求必须带 frameRevision");
  assert.ok(scaleText.includes("cols=100") && scaleText.includes("rows=100"), "标定请求必须带 frame 宽高");
  assert.ok(scaleText.includes("你是 Atlas 地图范围估计器"), "第二条请求确实是尺度估计器");
});

test("H18b：标定拿不到结论（unknown）→ 具名 scale-pending，提炼结果照常提交", async () => {
  const { core, carrier, calls } = await makeCore({
    world: emptyWorld(),
    entry: "import",
    fetchScripts: [() => openAiResponse(POINT_JSON), () => openAiResponse(SCALE_UNKNOWN)],
  });
  const result = await adopt(core, { loreSupplement: "- 望海楼：一座石楼" });

  assert.equal(result.status, 200, "标定待定绝不能让建图失败");
  assert.equal(result.body.data.mapScale.status, "scale-pending");
  assert.equal(result.body.data.mapScale.reasonCode, "UNKNOWN", "具名原因码，不是静默 undefined");
  assert.equal(calls.length, 2, "仍然尝试过一次标定");
  // 地图与地点照常保留，且绝不写一个猜出来的米数
  assert.equal(locationsOf(carrier).some((row) => row.name === "望海楼"), true, "地点照常落库");
  assert.equal(carrier.session.maps.calibrations.world, undefined, "待定时一个米数都不许落");
  assert.equal(
    Object.values(carrier.session.maps.calibrations).some((row) => typeof row?.metersPerCell === "number"),
    false,
    "标定表里不得出现任何米数",
  );
});

test("H18b：同一轮已有可验证尺度依据 → 直接复用，不额外发模型请求", async () => {
  const { core, carrier, calls } = await makeCore({
    world: emptyWorld(),
    entry: "import",
    fetchScripts: [() => openAiResponse(POINT_JSON)],
  });
  // 作者已经人工锁定过世界图尺度
  carrier.session.maps = {
    schemaVersion: 2,
    pointMeta: {},
    submaps: {},
    calibrations: {
      world: {
        revision: 3, metersPerCell: 100, source: "user", locked: true,
        basis: "作者人工锁定", coverage: "约 10km × 10km", confidence: "high", at: NOW,
      },
    },
  };
  const result = await adopt(core, { loreSupplement: "- 望海楼：临海石楼" });

  assert.equal(result.status, 200, `提炼应成功：${JSON.stringify(result.body.error ?? {})}`);
  assert.equal(result.body.data.mapScale.status, "existing", "已有标定 → 复用，状态具名 existing");
  assert.equal(calls.length, 1, "复用时零额外请求（只有提炼那一条）");
  const calibration = carrier.session.maps.calibrations.world;
  assert.equal(calibration.metersPerCell, 100, "复用不改写人工值");
  assert.equal(calibration.locked, true);
  assert.equal(calibration.revision, 3, "未经确认不得覆写既有标定记录");
});

test("H18b：已有世界图的提炼不再额外请求标定（mapScale 明确为 null）", async () => {
  const { core, calls } = await makeCore({
    world: legacyWorld(),
    entry: "ensure-starter",
    fetchScripts: [() => openAiResponse(JSON.stringify({ regions: [], points: [{ name: "白桦教室" }] }))],
  });
  const result = await adopt(core, { loreSupplement: "- 白桦教室：学校里的教室" });
  assert.equal(result.status, 200, `提炼应成功：${JSON.stringify(result.body.error ?? {})}`);
  assert.equal(result.body.data.pointsAdded, 1);
  assert.equal(result.body.data.mapScale, null, "已有世界图 → 不建图就不标定，如实回报 null");
  assert.equal(calls.length, 1, "一次普通提炼只花一条模型请求");
});
