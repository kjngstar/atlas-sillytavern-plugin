/**
 * atlas-r06-scene.test.mjs — R06 首次定位、开场识别与起点占位迁移回归测试。
 *
 * 对应《修复计划》R06 验收：
 * - 占位指纹：生成来源 + 结构指纹双确认才认定系统占位；用户真正创建名叫「起点」
 *   的地点（多编辑证据）原样保留；
 * - retired 迁移：定义修订审计 + sidecar 记录，重复运行幂等；
 * - 开场识别（mode=bootstrap，duration=0）：preview 不写世界；apply 一次 v2 提交、
 *   时间游标不动、占位自动退役、lastConfirmed 落档；
 * - v2 封套：$B 替换、协议设置切换、作者自定义预设不被覆盖；
 * - /state scene 块：未知与 lastConfirmed 分开。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(resolve(root, p)).href);
const { buildStarterWorld } = await imp("src/atlas-starter-world.ts");
const { legacyStartWorld } = await imp("tests/atlas-legacy-start-world.mjs");
const { detectStartPlaceholder, retireStartPlaceholder, sanitizeSceneDoc, emptySceneDoc, resolveSceneStatus, sceneDocKey } = await imp("src/atlas-scene.ts");
const { parseWorld } = await imp("lib/world-schema.ts");
const { substitutePromptPlaceholders } = await imp("src/atlas-api-client.ts");
const { createAtlasServerCore, createMemoryDocumentStore } = await imp("src/atlas-server.ts");

const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// 空地理（R06：新世界不再预置「起点」占位）
// ---------------------------------------------------------------------------

test("R06 空地理：新世界 0 地区 / 0 地点 / currentRegionId=null，不再生成「起点」", () => {
  const world = buildStarterWorld({ id: "w-new", now: 1, name: "测试卡" });
  assert.deepEqual(world.regions ?? [], [], "新世界无地区");
  assert.deepEqual(world.points ?? [], [], "新世界无地点——第一轮推演的场景识别产出真实地点");
  assert.equal(world.currentRegionId, null, "未知地区 = null，不归入不存在的「起点」");
  assert.equal(world.characters.length, 1, "主角实体仍在");
  assert.equal(world.characters[0].currentRegionId, null, "主角不挂在虚构地区上");
  assert.equal(detectStartPlaceholder(world).isPlaceholder, false, "空世界不存在系统占位");
  const names = [...(world.regions ?? []), ...(world.points ?? [])].map((x) => String(x.name));
  assert.equal(names.includes("起点"), false, "产物里不再出现「起点」");
});

test("R06 空地理：产物仍通过 parseWorld（核心 schema 允许空地图）", () => {
  assert.ok(parseWorld(buildStarterWorld({ id: "w-parse", now: 1, name: "爱丽丝" })), "空地理 parseWorld 必过");
});

// ---------------------------------------------------------------------------
// 占位指纹
// ---------------------------------------------------------------------------

test("R06 指纹：全新起始世界 → 系统占位成立", () => {
  const info = detectStartPlaceholder(legacyStartWorld({ id: "w1", now: 1, name: "测试卡" }));
  assert.equal(info.isPlaceholder, true);
  assert.equal(info.pointId, "1");
  assert.equal(info.regionId, "start");
  assert.deepEqual(info.reasons, []);
});

test("R06 指纹：用户创建且真正名叫「起点」的地点 → 不是占位（名字不是唯一依据）", () => {
  const world = legacyStartWorld({ id: "w2", now: 1, name: "测试卡" });
  world.points.push({ id: 2, name: "起点", x: 12, y: 34, regionId: "start" });
  const info = detectStartPlaceholder(world);
  assert.equal(info.isPlaceholder, false, "两个地点 → 指纹破裂");
  assert.ok(info.reasons.some((r) => r.includes("地点数")), "阻止原因必须列出");
});

test("R06 指纹：用户编辑过占位（坐标改动）→ 不是占位", () => {
  const world = legacyStartWorld({ id: "w3", now: 1, name: "测试卡" });
  world.points[0].x = 51;
  assert.equal(detectStartPlaceholder(world).isPlaceholder, false);
});

test("R06 指纹：推演发生（账本事件）或定义修订过 → 不是占位", () => {
  const played = legacyStartWorld({ id: "w4", now: 1, name: "测试卡" });
  played.stateEvents = [{ id: "e1", worldId: played.id, branchId: null, at: 1, sequence: 0, source: "author", narrativeSummary: "x", entityRefs: [], effects: [] }];
  assert.equal(detectStartPlaceholder(played).isPlaceholder, false, "有账本事件");
  const revised = legacyStartWorld({ id: "w5", now: 1, name: "测试卡" });
  revised.definitionRevisions = [{ id: "r1", worldId: revised.id, createdAt: 1, authorNote: "用户改过" }];
  assert.equal(detectStartPlaceholder(revised).isPlaceholder, false, "有定义修订");
});

test("R06 指纹：只改名字的世界（唯一地点仍叫起点但换了坐标等）→ 不是占位", () => {
  // 名字匹配单独不足：结构指纹其余项也必须吻合
  const world = legacyStartWorld({ id: "w6", now: 1, name: "测试卡" });
  world.characters.push({ id: "npc-1", worldId: world.id, name: "少女", role: "配角", description: "", currentRegionId: "start" });
  assert.equal(detectStartPlaceholder(world).isPlaceholder, false, "多了一个人物");
});

// ---------------------------------------------------------------------------
// retired 迁移
// ---------------------------------------------------------------------------

test("R06 retired：修订审计 + sidecar 记录；重复运行幂等", () => {
  const world = legacyStartWorld({ id: "w7", now: 1, name: "测试卡" });
  const doc = emptySceneDoc();
  const first = retireStartPlaceholder(world, doc, { now: 5 });
  assert.equal(first.changed, true);
  assert.deepEqual(first.doc.retiredPointIds, ["1"]);
  assert.equal((first.world.definitionRevisions ?? []).length, 1, "定义修订留痕");
  const second = retireStartPlaceholder(first.world, first.doc, { now: 6 });
  assert.equal(second.changed, false, "重复运行幂等");
  assert.equal((second.world.definitionRevisions ?? []).length, 1, "不重复加修订");
});

test("R06 retired：非占位世界调用 → 零改动", () => {
  const world = legacyStartWorld({ id: "w8", now: 1, name: "测试卡" });
  world.points.push({ id: 2, name: "客栈", x: 20, y: 20, regionId: "start" });
  const result = retireStartPlaceholder(world, emptySceneDoc(), { now: 5 });
  assert.equal(result.changed, false);
  assert.deepEqual(result.doc.retiredPointIds, []);
});

// ---------------------------------------------------------------------------
// 场景状态（未知 vs lastConfirmed 分开）
// ---------------------------------------------------------------------------

test("R06 场景状态：未知 ≠ 无上次确认；resolveSceneStatus 两者分开表达", () => {
  const world = legacyStartWorld({ id: "w9", now: 1, name: "测试卡" });
  world.points.push({ id: 2, name: "废墟深处", x: 70, y: 50, regionId: "start" });
  const doc = { ...emptySceneDoc(), lastConfirmed: { branchId: null, pointId: "2", at: 9 } };
  const status = resolveSceneStatus(world, doc, null);
  assert.equal(status.known, false, "当前游标未知");
  assert.equal(status.lastConfirmed?.pointId, "2", "上次确认仍可表达");
  assert.equal(status.lastConfirmed?.pointName, "废墟深处");
  const known = resolveSceneStatus(world, doc, "2");
  assert.equal(known.known, true);
});

// ---------------------------------------------------------------------------
// v2 封套与占位符
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 服务端开场识别（bootstrap preview / apply）
// ---------------------------------------------------------------------------

const GREETING = "你推开藤蔓，走进废墟深处。一个未具名少女站在阴影里，警戒地盯着你。";
/**
 * E10（0.9.59）：开场识别的**行增量**夹具——与旧的 v2 草稿同语义，
 * 但走的是唯一现行契约（一块逐行 JSON 的 `<atlasEdit>`）。
 *
 * - 新地点用块内临时引用 `new:loc:*`；
 * - 主角行随 `locationRef` 锚定（这就是开场定位的依据，不再有 v2 的 `scene.locationRef`）；
 * - 每行 `quote` 必须连续逐字出现在助手正文里。
 */
const BOOTSTRAP_EDIT = [
  "<atlasEdit>",
  JSON.stringify({
    table: "location", op: "add", ref: "new:loc:ruins", name: "废墟深处",
    description: "藤蔓后的废墟深处", quote: "走进废墟深处",
  }),
  JSON.stringify({
    table: "character", op: "add", ref: "new:npc:girl", name: "未具名少女",
    locationRef: "new:loc:ruins", thought: "警戒地盯着来客",
    quote: "一个未具名少女站在阴影里",
  }),
  JSON.stringify({
    table: "character", op: "set", ref: "npc:char-main",
    patch: { locationRef: "new:loc:ruins" }, basis: "observed", quote: "你推开藤蔓",
  }),
  "</atlasEdit>",
].join("\n");

/** 「诚实未知」夹具：只有氛围描写，没有任何可锚定的地点（零地点写入）。 */
const BOOTSTRAP_EDIT_UNKNOWN = [
  "<atlasEdit>",
  JSON.stringify({
    table: "location", op: "set", ref: "loc:1",
    patch: { description: "风声呜咽，看不出这是哪里。" }, basis: "observed", quote: "风声呜咽",
  }),
  "</atlasEdit>",
].join("\n");

function jsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

async function bootstrapSetup(responseText, worldFactory = legacyStartWorld) {
  const store = createMemoryDocumentStore();
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return jsonResponse(200, { choices: [{ message: { content: responseText } }] });
  };
  const rawCore = createAtlasServerCore({ store, fetchFn, now: () => NOW });
  // 0.9.42 会话承载：/worlds/import、/bindings、/state 走会话层，必须挂 carrier（与插件测试同款）
  const { createSessionCarrier, carrierAsCore } = await imp("tests/atlas-session-helper.mjs");
  const carrier = createSessionCarrier(rawCore);
  const core = carrierAsCore(carrier);
  const world = worldFactory({ id: "w-boot", now: 1, name: "测试卡" });
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", {
    action: "bind",
    binding: {
      schemaVersion: 1,
      enabled: true,
      chatId: "chat-boot",
      // E10：开场定位改由**主角行的 locationRef**给出，所以绑定必须指明主角是谁
      characterId: "char-main",
      worldId: world.id,
      branchId: null,
      currentLocationId: "1",
      worldTimeCursor: 0,
      lastCommittedMessageId: null,
      lastCheckpointId: null,
    },
  });
  await core.handle("PUT", "/settings", {
    action: "api.save",
    preset: { name: "mock", endpoint: "https://mock.example.invalid/v1", model: "atlas-mock", maxTokens: 1024, temperature: 0.7, topP: 0.95, timeoutMs: 5000 },
    apiKeyMode: "replace",
    apiKey: "sk-test",
  }, { local: true });
  // api.activate 用生成 id；从视图找回真实 id 再激活
  const view = await core.handle("GET", "/settings", null, { local: true });
  const apiId = view.body?.data?.apiPresets?.[0]?.id;
  if (apiId) await core.handle("PUT", "/settings", { action: "api.activate", id: apiId }, { local: true });
  /**
   * E01（0.9.59）：内置推进协议已收口到 `table-delta-v1`——这里**不再**显式声明 v2，
   * 因为设置层已经只接受并只归一化到增量协议（想切回 v1/v2 的写请求会被明确拒绝）。
   */
  return { store, core, calls, world, carrier };
}

test("R06 bootstrap 预览：解析行增量块返回候选，零写入世界", async () => {
  const { core, calls, carrier } = await bootstrapSetup(BOOTSTRAP_EDIT);
  const pointsBefore = (carrier.session.world?.points ?? []).length;
  const result = await core.handle("POST", "/scene/bootstrap", { chatId: "chat-boot", apply: false, assistantText: GREETING }, { local: true });
  assert.equal(result.status, 200, `应成功：${JSON.stringify(result.body?.error ?? {})}`);
  assert.equal(result.body.data.status, "preview");
  assert.equal(result.body.data.protocol, "table-delta-v1", "预览自报唯一现行协议");
  assert.equal(result.body.data.duration, 0, "开场预览不推进时间");
  assert.equal(result.body.data.callCount, 1, "明确调用次数 = 1");
  assert.equal(result.body.data.newLocations[0].name, "废墟深处");
  assert.equal(result.body.data.newCharacters[0].name, "未具名少女");
  assert.equal(result.body.data.rejectedRows.length, 0, "夹具各行都合法");
  assert.equal(calls.length, 1, "恰好 1 条推演请求");
  assert.equal((carrier.session.world?.points ?? []).length, pointsBefore, "预览不写世界");
  // 请求应使用增量契约（$B 替换 + bootstrap 任务段）
  const messageText = JSON.stringify(calls[0].body);
  assert.ok(messageText.includes("mode=bootstrap"), "请求含开场识别任务段");
  assert.ok(messageText.includes("atlasEdit"), "请求使用行增量契约段");
  assert.ok(!messageText.includes("$B"), "$B 应已替换（不再有裸占位符）");
});

test("R06 bootstrap 应用：duration=0 时间不动、主角行锚定、占位退役、lastConfirmed 落档", async () => {
  const { core, calls, carrier } = await bootstrapSetup(BOOTSTRAP_EDIT);
  const result = await core.handle("POST", "/scene/bootstrap", { chatId: "chat-boot", apply: true, assistantText: GREETING }, { local: true });
  assert.equal(result.status, 200, `应成功：${JSON.stringify(result.body?.error ?? {})}`);
  assert.equal(result.body.data.status, "committed", `status=${result.body.data.status}`);
  assert.equal(result.body.data.duration, 0, "duration=0：开场不推进时间");
  assert.equal(result.body.data.placeholderRetired, true, "起始占位自动退役");
  assert.ok(result.body.data.anchoredLocationId, "锚定到真实地点");

  const world = carrier.session.world;
  const sceneDoc = sanitizeSceneDoc(carrier.session.scene);
  assert.deepEqual(sceneDoc.retiredPointIds, ["1"], "占位 retired 记录");
  assert.equal(sceneDoc.lastConfirmed?.pointId, result.body.data.anchoredLocationId, "lastConfirmed 落档");
  assert.equal(sceneDoc.bootstrap?.attempts, 1, "bootstrap 簿记 1 次");
  assert.equal(carrier.session.binding.worldTimeCursor, 0, "时间游标不动");

  assert.equal(carrier.session.binding.currentLocationId, result.body.data.anchoredLocationId, "绑定游标随主角行锚定");

  // 新地点/人物已入库（块内临时引用 → 持久 ID）
  assert.equal((world.points ?? []).length, 2, "废墟深处已建点");
  const girlRecord = (world.entityRecords ?? []).find((e) => e.name === "未具名少女");
  assert.ok(girlRecord, "少女已建档");
  assert.equal(calls.length, 1, "只调用一次模型");
});

test("R06 空地理 + bootstrap：第一轮场景识别直接产出真实地点，无占位可退役", async () => {
  const { core, carrier } = await bootstrapSetup(BOOTSTRAP_EDIT, () => buildStarterWorld({ id: "w-empty", now: 1, name: "测试卡" }));
  const result = await core.handle("POST", "/scene/bootstrap", { chatId: "chat-boot", apply: true, assistantText: GREETING }, { local: true });
  assert.equal(result.status, 200, `应成功：${JSON.stringify(result.body?.error ?? {})}`);
  assert.equal(result.body.data.status, "committed");
  assert.equal(result.body.data.placeholderRetired, false, "空世界没有占位可退役");
  const world = carrier.session.world;
  assert.deepEqual(world.regions ?? [], [], "没造虚构地区");
  assert.equal((world.points ?? []).length, 1, "只有剧情产出的那一个真实地点");
  assert.equal((world.points ?? [])[0].name, "废墟深处");
  const sceneDoc = sanitizeSceneDoc(carrier.session.scene);
  assert.deepEqual(sceneDoc.retiredPointIds, [], "无占位 → 无 retired 记录");
  assert.equal(sceneDoc.lastConfirmed?.pointId, result.body.data.anchoredLocationId, "lastConfirmed 指向真实地点");
});

test("R06 bootstrap：无有效证据时诚实未知（不造起点、零地点写入）", async () => {
  const { core, carrier } = await bootstrapSetup(BOOTSTRAP_EDIT_UNKNOWN);
  const result = await core.handle("POST", "/scene/bootstrap", { chatId: "chat-boot", apply: true, assistantText: "风声呜咽。（只有氛围，无地点）" }, { local: true });
  assert.equal(result.status, 200, `应成功：${JSON.stringify(result.body?.error ?? {})}`);
  // E06：没有可锚定的主角 locationRef → 明确回报「未知」，绝不造一个起点
  assert.equal(result.body.data.status, "unknown");
  assert.equal(result.body.data.anchoredLocationId, null, "未定位就是 null");
  assert.equal(result.body.data.duration, 0, "未定位同样不推进时间");
  assert.equal((carrier.session.world?.points ?? []).length, 1, "无证据 → 不造地点");
  const sceneDoc = sanitizeSceneDoc(carrier.session.scene);
  assert.equal(sceneDoc.lastConfirmed, null, "无锚点不写 lastConfirmed");
  assert.deepEqual(sceneDoc.retiredPointIds, [], "占位未退役（识别未成功定位）");
});

test("R06 /state：scene 块分开表达未知 / lastConfirmed，retired 点从地图点列过滤", async () => {
  const { core } = await bootstrapSetup(BOOTSTRAP_EDIT);
  await core.handle("POST", "/scene/bootstrap", { chatId: "chat-boot", apply: true, assistantText: GREETING }, { local: true });
  const state = await core.handle("POST", "/state", { chatId: "chat-boot" }, { local: true });
  assert.equal(state.status, 200);
  const scene = state.body.data.scene;
  assert.equal(scene.known, true, "场景已锚定");
  assert.equal(scene.placeholder.retired, true, "占位已退役");
  assert.ok(scene.lastConfirmed?.pointId, "lastConfirmed 存在");
  const mapPointIds = state.body.data.map.points.map((p) => p.id);
  assert.ok(!mapPointIds.includes("1"), "retired 占位点不再进地图点列");
  assert.equal(mapPointIds.length, 1, "只展示真实地点（废墟深处）");
});

test("R06 /state：旧存档的纯占位「起点」默认不显示为真实地点（零写入）", async () => {
  const { core, carrier } = await bootstrapSetup(BOOTSTRAP_EDIT);
  const state = await core.handle("POST", "/state", { chatId: "chat-boot" }, { local: true });
  assert.equal(state.status, 200);
  assert.equal(state.body.data.scene.placeholder.isPlaceholder, true, "指纹吻合 = 系统占位");
  assert.deepEqual(state.body.data.map.points.map((p) => p.id), [], "占位不是地理事实，默认不进地图点列");
  assert.deepEqual(
    (carrier.session.world.points ?? []).map((p) => p.name),
    ["起点"],
    "结构保留：只是不展示，没删数据、引用不悬空",
  );
});

test("R06 协议设置：新装默认是 table-delta-v1，内置默认出六段行增量", async () => {
  const { core } = await bootstrapSetup(BOOTSTRAP_EDIT);
  const view = await core.handle("GET", "/settings", null, { local: true });
  assert.equal(view.body.data.worldTurnProtocol, "table-delta-v1", "新装默认 = 表格式增量");
  assert.equal(view.body.data.builtInPrompt.segments.length, 6, "内置默认是六段");
  assert.ok(
    view.body.data.builtInPrompt.segments.some((segment) => String(segment.content).includes("<atlasEdit>")),
    "分段展示块格式",
  );
  const bad = await core.handle("PUT", "/settings", { action: "runtime.update", worldTurnProtocol: "v9" }, { local: true });
  assert.equal(bad.status, 400, "非法协议拒绝");
  /**
   * E01（0.9.59）已落地：读取路径把缺失 / 非法 / 旧值 v1 / 旧值 v2 一律规范成
   * `table-delta-v1`，`runtime.update` **明确拒绝**再切回 v1/v2——运行时只有一个协议。
   * 这里等价覆盖原「v2 仍可写入」的断言：v2 写请求被具名拒绝，且存储里的协议不变。
   */
  const legacyRejected = await core.handle("PUT", "/settings", { action: "runtime.update", worldTurnProtocol: "v2" }, { local: true });
  assert.equal(legacyRejected.status, 400, "v2 写请求被明确拒绝（E01 已落地）");
  assert.equal(legacyRejected.body.error.code, "INVALID_PAYLOAD", "拒绝码 INVALID_PAYLOAD");
  assert.match(String(legacyRejected.body.error.message), /table-delta-v1/, "拒绝信息指向唯一协议");
  const after = await core.handle("GET", "/settings", null, { local: true });
  assert.equal(after.body.data.worldTurnProtocol, "table-delta-v1", "协议仍是 table-delta-v1");
});

test("legacy start inspection is read only; explicit repair is backed by session state and idempotent", async () => {
  const worldFactory = (options) => {
    const world = legacyStartWorld(options);
    world.points.push({ id: 2, name: "废墟深处", x: 70, y: 60, regionId: "start" });
    return world;
  };
  const { core, carrier, calls } = await bootstrapSetup(BOOTSTRAP_EDIT, worldFactory);
  carrier.session.binding.currentLocationId = "2";
  const originalWorld = JSON.stringify(carrier.session.world);
  const originalRev = carrier.session.rev;
  const preview = await core.handle("POST", "/scene/repair-start", { chatId: "chat-boot", apply: false });
  assert.equal(preview.body.data.status, "preview");
  const report = preview.body.data.report;
  assert.equal(report.structuralFingerprint, true);
  assert.equal(report.fullFingerprint, false, "世界已生长，完整空档指纹不再吻合");
  assert.equal(report.proposedPointId, "2");
  assert.equal(report.canApply, true);
  assert.equal(carrier.session.rev, originalRev, "只读检查不写会话");
  assert.equal(calls.length, 0, "账本和绑定足够时零 AI");
  const stale = await core.handle("POST", "/scene/repair-start", {
    chatId: "chat-boot", apply: true, reportToken: "stale",
  });
  assert.equal(stale.body.ok, false, "过期报告拒绝写入");
  const applied = await core.handle("POST", "/scene/repair-start", {
    chatId: "chat-boot", apply: true, reportToken: report.reportToken,
  });
  assert.equal(applied.body.data.status, "repaired");
  assert.deepEqual(carrier.session.scene.retiredPointIds, ["1"]);
  assert.equal(carrier.session.binding.currentLocationId, "2");
  assert.equal(JSON.stringify(carrier.session.world), originalWorld, "地点、皮肤和账本均不改写");
  const state = await core.handle("GET", "/state/chat-boot");
  assert.deepEqual(state.body.data.map.points.map((point) => point.id), ["2"], "系统占位不再作为真实地点展示");
  // E04a：三表投影（tableMap）必须与旧字段路径同一口径——已退役的「起点」不能从新通道冒回来
  const tableMapPoints = (state.body.data.tableMap?.world?.points ?? []).map((point) => point.id);
  assert.deepEqual(tableMapPoints, ["2"], "tableMap 世界图同样不显示已退役的系统占位");
  assert.ok(
    !JSON.stringify(state.body.data.tableMap ?? {}).includes("起点"),
    "tableMap 的任何字段都不再出现「起点」",
  );
  const again = await core.handle("POST", "/scene/repair-start", {
    chatId: "chat-boot", apply: true, reportToken: report.reportToken,
  });
  assert.equal(again.body.data.status, "unchanged");
  assert.deepEqual(carrier.session.scene.retiredPointIds, ["1"], "重复执行不增加退役记录");
});

test("legacy start repair refuses a genuine edited point named 起点", async () => {
  const worldFactory = (options) => {
    const world = legacyStartWorld(options);
    world.points[0].x = 12;
    world.points.push({ id: 2, name: "客栈", x: 40, y: 40, regionId: "start" });
    return world;
  };
  const { core, carrier } = await bootstrapSetup(BOOTSTRAP_EDIT, worldFactory);
  carrier.session.binding.currentLocationId = "2";
  const preview = await core.handle("POST", "/scene/repair-start", { chatId: "chat-boot", apply: false });
  assert.equal(preview.body.data.report.structuralFingerprint, false);
  assert.equal(preview.body.data.report.canApply, false);
  const applied = await core.handle("POST", "/scene/repair-start", {
    chatId: "chat-boot", apply: true, reportToken: preview.body.data.report.reportToken,
  });
  assert.equal(applied.body.ok, false);
  assert.equal(carrier.session.scene, null);
});
