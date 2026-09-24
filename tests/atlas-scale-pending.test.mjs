/**
 * atlas-scale-pending.test.mjs — H23 / H18a / E06b / T25 端到端验收。
 *
 * 计划原文（§2.6 / H23 / T25）：
 * 「缺 API、超时、unknown、conflict、材料不足时地图照样创建，但显示
 *  『未标定 · 按格』，不可静默填 1 米/格或显示虚假米数。」
 * 「模型给 unknown / conflict、以及完全没有 API 时，地图仍然能建出来并按未标定显示。」
 *
 * 本文件把这条从纯函数（tests/atlas-scale.test.mjs）推进到**真实服务端链路**：
 *   POST /scene/bootstrap ──► 解析行增量 ──► 写 world/tables/scene ──► ensureMapScaleOnCreate
 * 四条硬断言：
 *  1. 标定失败**不影响开场本身**：HTTP 200、status=committed、duration=0、地点行全部保留；
 *  2. 结果**具名**回报（`mapScale[].status === "scale-pending"` + `reasonCode`），
 *     而不是静默吞掉、也不是伪装成 calibrated；
 *  3. `maps.calibrations` 里**一个米数都没有**（连候选值都不留）——停机线
 *     「模型标定把 unknown 当米制」的反面；
 *  4. 完全没有可用 API 时给出具名 `API_NOT_CONFIGURED`，零 fetch，且不产生半截写入。
 *
 * 纪律：夹具 ID / 时间全确定性（注入 NOW，不用 Date.now / Math.random）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildWorldFromTemplate, getDemoTemplate } from "../lib/demo-events.ts";
import { parseWorld } from "../lib/world-schema.ts";
import { ATLAS_ERROR_CODES } from "../src/atlas-contract.ts";
import { createAtlasServerCore, createMemoryDocumentStore } from "../src/atlas-server.ts";
import { createSessionCarrier, carrierAsCore } from "./atlas-session-helper.mjs";

const NOW = 1_700_000_000_000;
const CURRENT_TIME = 418.07;
const CANON = "chronicle-canon";
/** 推演/标定都按 branchKey 分桶；正史线的 branchKey 是 `canon`。 */
const BRANCH_KEY = "canon";
const SECRET = "sk-scale-secret-0001";

function jsonResponse(status, payload) {
  const raw = JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(raw), text: async () => raw };
}

function textResponse(status, content) {
  return jsonResponse(status, { choices: [{ message: { content } }] });
}

function buildWorld() {
  const base = buildWorldFromTemplate(getDemoTemplate("chronicle"), { id: "atlas-scale-fixture", now: 1000 });
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
 * 开场块：造一个「望海楼 → 望海楼大堂」两层结构，于是望海楼成为**内层地图宿主**，
 * `ensureMapScaleOnCreate` 会对它尝试一次尺度标定（H18a：只为本次实际创建的内层地图）。
 */
function bootstrapHostBlock() {
  return [
    "<atlasEdit>",
    JSON.stringify({ table: "location", op: "add", ref: "new:loc:tower", name: "望海楼", description: "临海石楼", quote: "你推开望海楼的门" }),
    JSON.stringify({ table: "location", op: "add", ref: "new:loc:hall", name: "望海楼大堂", parentRef: "new:loc:tower", description: "楼内大堂", quote: "走进大堂" }),
    "</atlasEdit>",
  ].join("\n");
}

const BOOTSTRAP_TEXT = "你推开望海楼的门，走进大堂。";

async function setup({ scripts, withApi = true }) {
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
  const carrier = createSessionCarrier(rawCore, {});
  const core = carrierAsCore(carrier);
  await core.handle("POST", "/worlds/import", { world: JSON.parse(JSON.stringify(world)) }, { local: true });
  await core.handle("POST", "/bindings", { action: "bind", binding: bindingFor(world) });
  if (withApi) {
    await core.handle("PUT", "/settings", {
      worldTurn: { name: "模拟推演", endpoint: "https://mock.example.invalid/v1", model: "atlas-mock", apiKey: SECRET, timeoutMs: 5000 },
    }, { local: true });
    await core.handle("PUT", "/settings", { action: "runtime.update", worldTurnProtocol: "table-delta-v1" }, { local: true });
  }
  return { store, core, carrier, world, modelCalls: () => call };
}

function bootstrap(chatId = "chat-a") {
  return { chatId, apply: true, assistantText: BOOTSTRAP_TEXT };
}

/** 会话里的标定表（maps 还没落过就是空表）。 */
function calibrationsOf(carrier) {
  const calibrations = carrier.session?.maps?.calibrations;
  return calibrations && typeof calibrations === "object" ? calibrations : {};
}

/**
 * 停机线断言：**没有任何**米数被写进标定表。
 * 不只看这张图的键——任何一条带数字 metersPerCell 的记录都算「猜了米数」。
 */
function assertNoCalibrationWritten(carrier, mapId, label) {
  const calibrations = calibrationsOf(carrier);
  assert.equal(Object.prototype.hasOwnProperty.call(calibrations, mapId), false,
    `${label}：${mapId} 不得有任何标定记录（绝不写一个猜出来的米数）`);
  const numeric = Object.entries(calibrations)
    .filter(([, row]) => row && typeof row === "object" && typeof row.metersPerCell === "number");
  assert.deepEqual(numeric.map(([key]) => key), [],
    `${label}：标定表里不得出现任何米数（实际 ${JSON.stringify(numeric)}）`);
}

function towerPointId(carrier) {
  const rows = carrier.session.tables.branches[BRANCH_KEY].locations;
  const tower = rows.find((row) => row.name === "望海楼");
  assert.ok(tower, "望海楼已建点");
  return String(tower.id).replace("loc:", "");
}

/* ------------------------------------------------------------------ *
 * H23：模型 unknown / conflict —— 地图照常建出来，明确「未标定」
 * ------------------------------------------------------------------ */

test("H23 端到端：模型 unknown → 开场照常成功、地点行保留、明确 scale-pending、零米数", async () => {
  const unknownAnswer = JSON.stringify({
    status: "unknown", extentMeters: null, coverage: "", basis: "材料不足", confidence: "low", evidence: [],
  });
  const { core, carrier, modelCalls } = await setup({
    scripts: [() => textResponse(200, bootstrapHostBlock()), () => textResponse(200, unknownAnswer)],
  });

  const result = await core.handle("POST", "/scene/bootstrap", bootstrap());
  assert.equal(result.status, 200, `开场必须照常成功：${JSON.stringify(result.body.error ?? {})}`);
  // 夹具开场块只建地点、不移动主角 → 位置按 E06 如实保持未知（「未定位只返回未知」）；
  // 关键恰恰在这里：**位置未知 + 标定失败都拦不住开场**，地图与三表照样落盘。
  assert.equal(result.body.data.status, "unknown", "未定位的开场如实报 unknown，而不是伪造一个起点");
  assert.equal(result.body.data.anchoredLocationId, null, "没有已接受的主角行就不锚定位置");
  assert.equal(result.body.data.protocol, "table-delta-v1", "只走行增量契约");
  assert.equal(result.body.data.duration, 0, "开场时段恒为零（标定失败不该推进时间）");
  assert.equal(modelCalls(), 2, "恰好两次模型请求：开场识别 + 一次尺度判断（不是跳过标定）");

  // ① 地图照常建出来：地点行一条不少（标定是显示层的事，不能连累实体）
  const rows = carrier.session.tables.branches[BRANCH_KEY].locations;
  assert.deepEqual(rows.map((row) => row.name).filter((name) => name.startsWith("望海楼")),
    ["望海楼", "望海楼大堂"], "开场建立的两条地点行都必须保留");
  assert.equal(rows.find((row) => row.name === "望海楼大堂").parentLocationId, `loc:${towerPointId(carrier)}`,
    "父子关系照常落库（标定失败不影响地理结构）");
  assert.ok(carrier.session.world, "world 已落盘");

  // ② 结果具名：scale-pending + 原因码，而不是静默吞掉或伪装成 calibrated
  const mapScale = result.body.data.mapScale;
  assert.ok(Array.isArray(mapScale), "响应必须带 mapScale 明细");
  assert.equal(mapScale.length, 1, "只为本次实际创建的一张内层地图尝试");
  assert.equal(mapScale[0].mapId, towerPointId(carrier));
  assert.equal(mapScale[0].status, "scale-pending", `unknown → 待定而不是假标定：${JSON.stringify(mapScale[0])}`);
  assert.equal(mapScale[0].reasonCode, "UNKNOWN", "原因码如实回报（具名，不是 undefined）");
  assert.notEqual(mapScale[0].status, "calibrated", "绝不把 unknown 记成已标定");

  // ③ 停机线：地图照建，但**一个米数都不许写**
  assertNoCalibrationWritten(carrier, towerPointId(carrier), "unknown");

  // ④ 待定不是终局：作者仍可人工锁定（§2.6「提供明确重新 AI 判断 / 人工锁定按钮」）
  const manual = await core.handle("POST", "/worlds/scale/calibrate", {
    chatId: "chat-a", mapId: "world", userMetersPerCell: 8,
  });
  assert.equal(manual.status, 200, `待定之后仍可人工标定：${JSON.stringify(manual.body.error ?? {})}`);
  const locked = calibrationsOf(carrier).world;
  assert.ok(locked, "人工标定按正史裸 mapId 键落盘");
  assert.equal(locked.metersPerCell, 8, "人工值生效");
  assert.equal(locked.source, "user", "来源标注为人工");
  assert.equal(locked.locked, true, "人工标定默认锁定，后续 AI 估计不得覆盖");
});

test("H23 端到端：模型 conflict（自报 + 宽高互斥）→ 同样建图成功并待定，零米数", async () => {
  const declaredConflict = JSON.stringify({
    status: "conflict", extentMeters: null, coverage: "临海石楼", basis: "材料互相矛盾", confidence: "low", evidence: [],
  });
  const first = await setup({
    scripts: [() => textResponse(200, bootstrapHostBlock()), () => textResponse(200, declaredConflict)],
  });
  const declared = await first.core.handle("POST", "/scene/bootstrap", bootstrap());
  assert.equal(declared.status, 200, `conflict 也不许让开场失败：${JSON.stringify(declared.body.error ?? {})}`);
  assert.equal(declared.body.data.mapScale[0].status, "scale-pending", "自报 conflict → 待定");
  assert.equal(declared.body.data.mapScale[0].reasonCode, "CONFLICT", "原因码 CONFLICT");
  assertNoCalibrationWritten(first.carrier, towerPointId(first.carrier), "自报 conflict");
  assert.ok(first.carrier.session.tables.branches[BRANCH_KEY].locations.some((row) => row.name === "望海楼大堂"),
    "conflict 时地图照常保留");

  /**
   * 第二种 conflict：模型自称 estimated，但横纵每格距离差超 1% 容差。
   * 这正是「不静默取平均、不把不一致宽高分别用于 x/y 拉伸」的现场——
   * 结果必须是 conflict，而不是硬算出一个 59 米/格之类的假米数。
   */
  const inconsistent = JSON.stringify({
    status: "estimated", extentMeters: { width: 6000, height: 5500 },
    coverage: "临海石楼", basis: "描述里只给了宽", confidence: "medium", evidence: [],
  });
  const second = await setup({
    scripts: [() => textResponse(200, bootstrapHostBlock()), () => textResponse(200, inconsistent)],
  });
  const measured = await second.core.handle("POST", "/scene/bootstrap", bootstrap());
  assert.equal(measured.status, 200, "宽高互斥也不许让开场失败");
  assert.equal(measured.body.data.mapScale[0].status, "scale-pending", "宽高互斥 → 待定");
  assert.equal(measured.body.data.mapScale[0].reasonCode, "CONFLICT", "同样归 CONFLICT，不静默取平均");
  assertNoCalibrationWritten(second.carrier, towerPointId(second.carrier), "estimated 但宽高互斥");
  assert.ok(second.carrier.session.tables.branches[BRANCH_KEY].locations.some((row) => row.name === "望海楼"),
    "地图保留");
});

test("H23 端到端：标定响应不可解析 / 张冠李戴 → 待定并具名原因码，不猜米数", async () => {
  // ① 不是 JSON 对象：UNPARSEABLE
  const broken = await setup({
    scripts: [() => textResponse(200, bootstrapHostBlock()), () => textResponse(200, "我觉得大概有十来公里吧。")],
  });
  const brokenResult = await broken.core.handle("POST", "/scene/bootstrap", bootstrap());
  assert.equal(brokenResult.status, 200, "解析失败不得让开场失败（更不许 502）");
  assert.equal(brokenResult.body.data.mapScale[0].status, "scale-pending");
  assert.equal(brokenResult.body.data.mapScale[0].reasonCode, "UNPARSEABLE", "具名说明为什么没有尺度");
  assertNoCalibrationWritten(broken.carrier, towerPointId(broken.carrier), "不可解析");

  // ② 回答的是**另一张图**：FRAME_MISMATCH（绝不把别图尺度挪到本图）
  const mismatched = await setup({
    scripts: [
      () => textResponse(200, bootstrapHostBlock()),
      () => textResponse(200, JSON.stringify({
        mapRef: "world", frameRevision: 1, status: "estimated",
        extentMeters: { width: 10000, height: 10000 }, coverage: "世界图", basis: "别处", confidence: "high", evidence: [],
      })),
    ],
  });
  const mismatchResult = await mismatched.core.handle("POST", "/scene/bootstrap", bootstrap());
  assert.equal(mismatchResult.status, 200, "身份不符也不许让开场失败");
  assert.equal(mismatchResult.body.data.mapScale[0].status, "scale-pending");
  assert.equal(mismatchResult.body.data.mapScale[0].reasonCode, "FRAME_MISMATCH", "张冠李戴的尺度必须被拒");
  assertNoCalibrationWritten(mismatched.carrier, towerPointId(mismatched.carrier), "mapRef 不符");
});

/* ------------------------------------------------------------------ *
 * H23：完全没有可用 API
 * ------------------------------------------------------------------ */

test("H23：完全没有可用 API → 具名 API_NOT_CONFIGURED，零 fetch、零半截写入", async () => {
  const { core, carrier, modelCalls } = await setup({ scripts: [], withApi: false });
  const before = JSON.stringify(carrier.session);

  const result = await core.handle("POST", "/scene/bootstrap", bootstrap());
  assert.equal(result.status, 409, `未配置 API 必须明确失败：${JSON.stringify(result.body)}`);
  assert.equal(result.body.error?.code, ATLAS_ERROR_CODES.API_NOT_CONFIGURED,
    "错误码具名 API_NOT_CONFIGURED（不是静默成功，也不是无信息的 500）");
  assert.ok(String(result.body.error?.message ?? "").length > 0, "带可读的错误说明");
  assert.equal(modelCalls(), 0, "零 fetch：没有 API 就一个请求都不发");
  assert.equal(JSON.stringify(carrier.session), before, "失败不产生任何半截会话写入");
  assert.equal((carrier.session.maps?.calibrations ?? null), null, "没有地图尺度被凭空写出来");
  assert.equal(carrier.session.tables?.branches?.[BRANCH_KEY]?.locations?.some?.((row) => row.name === "望海楼") ?? false,
    false, "没有任何地点被静默造出来");
});

test("H23：标定接口本身不可用（5xx / 断网 / 鉴权失败）→ 地图保留、原因码具名、开场不 502", async () => {
  /**
   * T25 的另一半：「没 API 或模型 unknown/conflict/**超时** → 地图照常生成……
   * 模型超时不造成回合 502」。
   *
   * 现实里「没有可用 API」最常表现为**标定这一次请求失败**（网关 5xx、断网、密钥失效），
   * 而不是配置里一个连接都没有（那种情况见上一条：开场自己就被具名拒绝）。
   * 三种失败都必须：① 开场 HTTP 200；② mapScale 具名 scale-pending + 具体错误码；
   * ③ 一个米数都不落。
   */
  const cases = [
    { label: "网关 500", script: () => jsonResponse(500, { error: "upstream boom" }), reasonCode: "API_REQUEST_FAILED" },
    { label: "断网（fetch 抛错）", script: () => { throw new Error("network down"); }, reasonCode: "SERVICE_OFFLINE" },
    { label: "鉴权失败 401", script: () => jsonResponse(401, { error: "bad key" }), reasonCode: "API_AUTH_FAILED" },
  ];
  for (const item of cases) {
    const { core, carrier } = await setup({
      scripts: [() => textResponse(200, bootstrapHostBlock()), item.script],
    });
    const result = await core.handle("POST", "/scene/bootstrap", bootstrap());
    assert.equal(result.status, 200, `${item.label}：标定失败绝不能让开场变成 502`);
    const mapScale = result.body.data.mapScale;
    assert.equal(mapScale.length, 1, `${item.label}：仍然尝试过一次标定`);
    assert.equal(mapScale[0].status, "scale-pending", `${item.label}：待定而不是静默成功`);
    assert.equal(mapScale[0].reasonCode, item.reasonCode, `${item.label}：原因码具名到具体错误`);
    assertNoCalibrationWritten(carrier, towerPointId(carrier), item.label);
    assert.ok(carrier.session.tables.branches[BRANCH_KEY].locations.some((row) => row.name === "望海楼"),
      `${item.label}：地图照常保留（标定是显示层的事）`);
  }
});

test("H23/H18a 说明：标定成功后图钉与标定共用同一分支键，人工锁定不被 AI 覆盖", async () => {
  /**
   * 反差对照：同一张图在 estimated 合法时**必须**落标定，证明上面的 pending
   * 不是「这条链路根本没接线」。
   */
  const answer = JSON.stringify({
    status: "estimated", extentMeters: { width: 1000, height: 1000 },
    coverage: "望海楼内部", basis: "大堂尺度描述", confidence: "medium", evidence: [],
  });
  const { core, carrier } = await setup({
    scripts: [() => textResponse(200, bootstrapHostBlock()), () => textResponse(200, answer)],
  });
  const result = await core.handle("POST", "/scene/bootstrap", bootstrap());
  assert.equal(result.status, 200, `开场应成功：${JSON.stringify(result.body.error ?? {})}`);
  assert.equal(result.body.data.mapScale[0].status, "calibrated", "合法 estimated → 真的落标定");
  const mapId = result.body.data.mapScale[0].mapId;
  const calibration = calibrationsOf(carrier)[mapId];
  assert.ok(calibration, "标定按当前分支键落盘（正史 = 裸 mapId）");
  assert.equal(calibration.metersPerCell, 10, "1000 米 / 100 格 = 10 米/格（程序从 frame 推导）");
  assert.equal(calibration.source, "ai-estimated", "来源如实标注");
  assert.equal(calibration.locked, false, "AI 估计默认不锁定（人工可覆盖）");
});
