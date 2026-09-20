/**
 * atlas-geo-adopt.test.mjs — 0.9.24「从世界书提炼地理」服务端契约（先红后绿）。
 *
 * 口径来源：POST /worlds/geo/adopt（atlas-server.ts handleGeoAdopt）
 * - 空 loreSupplement → INVALID_PAYLOAD；未配置推演 API → API_NOT_CONFIGURED（零 fetch）。
 * - 恰好 1 条推演请求（fetch 恰好 1 次）；产出只增不改：重名（大小写不敏感）跳过。
 * - 新地点走黄金角螺旋布点（4..96 内、不与起点 (50,50) 重叠）。
 * - 成功后追加定义修订（revisionAppended）；全部重名 → 0 增量 + 提示信息。
 * - 模型输出非法 JSON → RESPONSE_MALFORMED 且 retryable。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildStarterWorld } from "../src/atlas-starter-world.ts";
import { createAtlasServerCore, createMemoryDocumentStore } from "../src/atlas-server.ts";
import { ATLAS_ERROR_CODES } from "../src/atlas-contract.ts";

const WORLD_ID = "world-auto-0123456789abcdef";

function preset(overrides = {}) {
  return {
    name: "模拟推演",
    endpoint: "https://mock.example.invalid/v1",
    model: "atlas-mock",
    apiKey: "sk-test-secret",
    timeoutMs: 5000,
    ...overrides,
  };
}

function openAiResponse(content) {
  const payload = JSON.stringify({ choices: [{ message: { content } }] });
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(payload),
    text: async () => payload,
  };
}

async function makeCore({ fetchScripts, configurePreset = true } = {}) {
  let tick = 1_700_000_000_000;
  const fetchCalls = [];
  const fetchFn = async (url, init) => {
    fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const script = fetchScripts?.[Math.min(fetchCalls.length - 1, fetchScripts.length - 1)];
    if (!script) throw new Error("意外触发了模型请求");
    return script();
  };
  const store = createMemoryDocumentStore();
  const core = createAtlasServerCore({ store, fetchFn, now: () => (tick += 1) });

  await core.handle(
    "POST",
    "/worlds/ensure-starter",
    { world: JSON.parse(JSON.stringify(buildStarterWorld({ id: WORLD_ID, now: 1_700_000_000_000, name: "测试角色" }))) },
    { local: true },
  );
  await core.handle("POST", "/bindings", {
    action: "bind",
    binding: {
      schemaVersion: 1,
      enabled: true,
      chatId: "chat-1",
      worldId: WORLD_ID,
      branchId: null,
      currentLocationId: "1",
      worldTimeCursor: 0,
    },
  });
  if (configurePreset) {
    await core.handle("PUT", "/settings", { worldTurn: preset() }, { local: true });
  }
  return { store, core, fetchCalls };
}

const EXTRACTION_JSON = JSON.stringify({
  regions: [
    { name: "低语森林", description: "迷雾笼罩的古老森林" },
    { name: "起点", description: "试图覆盖已有地区" },
  ],
  points: [
    { name: "避风树洞", regionName: "低语森林" },
    { name: "起点", regionName: "低语森林" },
    { name: "无名石碑" },
  ],
});

async function adopt(core, loreSupplement = "- 低语森林：迷雾笼罩的古老森林\n- 避风树洞：森林里的安全据点") {
  return core.handle("POST", "/worlds/geo/adopt", { chatId: "chat-1", loreSupplement });
}

test("geo/adopt：成功提炼 → 加地区加点、修订追加、只增不改、恰好 1 次请求", async () => {
  const { store, core, fetchCalls } = await makeCore({
    fetchScripts: [() => openAiResponse(EXTRACTION_JSON)],
  });

  const before = await store.read(`world:${WORLD_ID}`);
  const result = await adopt(core);

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.data.regionsAdded, 1, "重名「起点」跳过，只加低语森林");
  assert.equal(result.body.data.pointsAdded, 2, "重名「起点」跳过，加树洞与石碑");
  assert.equal(result.body.data.skipped, 2);
  assert.equal(result.body.data.revisionAppended, true);
  assert.deepEqual(result.body.data.regionNames, ["低语森林"]);
  assert.ok(result.body.data.pointNames.includes("避风树洞"));
  assert.equal(fetchCalls.length, 1, "一次点击恰好 1 条模型请求");
  assert.ok(
    JSON.stringify(fetchCalls[0].body).includes("低语森林"),
    "世界书资料进入提炼请求",
  );
  assert.ok(
    !JSON.stringify(fetchCalls[0].body).includes("sk-test-secret"),
    "请求体不含明文密钥",
  );

  const after = await store.read(`world:${WORLD_ID}`);
  assert.equal(after.regions.length, 2, "1 起始地区 + 1 新地区");
  assert.equal(after.points.length, 3, "1 起始地点 + 2 新地点");
  const newRegion = after.regions.find((r) => r.name === "低语森林");
  assert.ok(newRegion, "新地区落库");
  assert.match(newRegion.id, /^geo-r-/);
  assert.equal(after.regions.find((r) => r.id === "start").description, before.regions[0].description, "既有地区描述未被改写");

  const treeHole = after.points.find((p) => p.name === "避风树洞");
  assert.ok(treeHole, "新地点落库");
  assert.equal(treeHole.id, 2, "地点 id 从最大值递增");
  assert.equal(treeHole.regionId, newRegion.id, "regionName 映射到新地区 id");
  assert.ok(treeHole.x >= 4 && treeHole.x <= 96 && treeHole.y >= 4 && treeHole.y <= 96, "坐标在画布范围内");
  assert.notDeepEqual([treeHole.x, treeHole.y], [50, 50], "不与起点坐标重叠");
  const stele = after.points.find((p) => p.name === "无名石碑");
  assert.equal(stele.regionId, "start", "无 regionName 回退 start 地区");

  const revisions = after.revisions ?? after.definitionRevisions ?? [];
  assert.ok(
    Array.isArray(revisions) && revisions.some((r) => String(r.note ?? r.authorNote ?? "").includes("世界书提炼地理")),
    "定义修订已追加（审计留痕）",
  );
});

test("geo/adopt：第二次提炼同名 → 0 增量，全部跳过", async () => {
  const { core, fetchCalls } = await makeCore({
    fetchScripts: [() => openAiResponse(EXTRACTION_JSON), () => openAiResponse(EXTRACTION_JSON)],
  });
  const first = await adopt(core);
  assert.equal(first.body.data.regionsAdded, 1);

  const second = await adopt(core);
  assert.equal(second.body.ok, true);
  assert.equal(second.body.data.regionsAdded, 0);
  assert.equal(second.body.data.pointsAdded, 0);
  assert.ok(second.body.data.message, "0 增量时给出提示信息");
  assert.equal(fetchCalls.length, 2, "每次点击仍是恰好 1 条请求");
});

test("geo/adopt：空 loreSupplement → INVALID_PAYLOAD，零请求", async () => {
  const { core, fetchCalls } = await makeCore({ fetchScripts: [] });
  for (const lore of ["", "   ", null, undefined]) {
    const result = await core.handle("POST", "/worlds/geo/adopt", { chatId: "chat-1", loreSupplement: lore });
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, ATLAS_ERROR_CODES.INVALID_PAYLOAD);
  }
  const noField = await core.handle("POST", "/worlds/geo/adopt", { chatId: "chat-1" });
  assert.equal(noField.body.error.code, ATLAS_ERROR_CODES.INVALID_PAYLOAD, "缺字段同样拒绝");
  assert.equal(fetchCalls.length, 0, "拒绝时不发任何模型请求");
});

test("geo/adopt：未配置推演 API → API_NOT_CONFIGURED，零请求", async () => {
  const { core, fetchCalls } = await makeCore({ fetchScripts: [], configurePreset: false });
  const result = await adopt(core);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.error.code, ATLAS_ERROR_CODES.API_NOT_CONFIGURED);
  assert.equal(fetchCalls.length, 0, "未配置时不发请求");
});

test("geo/adopt：模型输出非法 JSON → RESPONSE_MALFORMED 且可重试", async () => {
  const { core, fetchCalls } = await makeCore({
    fetchScripts: [() => openAiResponse("这不是 JSON，我偏要自由发挥。")],
  });
  const result = await adopt(core);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.error.code, ATLAS_ERROR_CODES.RESPONSE_MALFORMED);
  assert.equal(result.body.error.details.retryable, true, "模型不守契约可重试");
  assert.equal(fetchCalls.length, 1);
});

test("geo/adopt：代码围栏包裹的 JSON 也能解析；未绑定聊天 → 绑定错误", async () => {
  const fenced = "```json\n" + EXTRACTION_JSON + "\n```";
  const { core, fetchCalls } = await makeCore({
    fetchScripts: [() => openAiResponse(fenced)],
  });
  const result = await adopt(core);
  assert.equal(result.body.ok, true, "围栏剥除后正常解析");
  assert.equal(result.body.data.regionsAdded, 1);
  assert.equal(fetchCalls.length, 1);

  const unbound = await core.handle("POST", "/worlds/geo/adopt", { chatId: "chat-none", loreSupplement: "低语森林" });
  assert.equal(unbound.body.ok, false, "未绑定聊天被拒");
  assert.equal(fetchCalls.length, 1, "绑定检查在模型请求之前");
});

// ---------------------------------------------------------------------------
// 0.9.26 地图抢救：剧情模式（recentTexts）
// ---------------------------------------------------------------------------

test("geo/adopt 剧情模式：只给 recentTexts（无 lore）→ 正常提炼，剧情文本进请求", async () => {
  const { core, fetchCalls } = await makeCore({
    fetchScripts: [() => openAiResponse(JSON.stringify({
      regions: [{ name: "灰港", description: "剧情里抵达的港口城市" }],
      points: [{ name: "旧灯塔", regionName: "灰港" }],
    }))],
  });
  const result = await core.handle("POST", "/worlds/geo/adopt", {
    chatId: "chat-1",
    recentTexts: ["他们抵达灰港，在旧灯塔下过夜。"],
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true, "剧情模式不再要求 loreSupplement");
  assert.equal(result.body.data.regionsAdded, 1);
  assert.equal(result.body.data.pointsAdded, 1);
  assert.equal(fetchCalls.length, 1);
  assert.ok(JSON.stringify(fetchCalls[0].body).includes("灰港"), "剧情文本进入提炼请求");
});

test("geo/adopt 剧情模式：已有地点不重复输出 → 全部跳过；夹带说明文字的响应可抢救", async () => {
  const { core, fetchCalls } = await makeCore({
    fetchScripts: [
      () => openAiResponse(JSON.stringify({
        regions: [{ name: "低语森林" }],
        points: [{ name: "避风树洞", regionName: "低语森林" }],
      })),
      // 第二次：模型输出前后夹说明文字 + 只提炼出已有地点 → 抢救解析成功 + 全跳过
      () => openAiResponse('好的，以下是提炼结果：{"regions":[],"points":[{"name":"避风树洞","regionName":"低语森林"}]} 请查收。'),
    ],
  });
  const first = await adopt(core);
  assert.equal(first.body.data.regionsAdded, 1);

  const second = await core.handle("POST", "/worlds/geo/adopt", {
    chatId: "chat-1",
    recentTexts: ["他们回到了避风树洞休整。"],
  });
  assert.equal(second.body.ok, true, "夹带说明文字的响应经容错提取仍可解析");
  assert.equal(second.body.data.regionsAdded, 0);
  assert.equal(second.body.data.pointsAdded, 0, "已有地点跳过");
  assert.equal(second.body.data.skipped, 1);
  assert.equal(fetchCalls.length, 2);
});

test("geo/adopt 剧情模式：形状不对的 recentTexts 宽容丢弃；两者都空 → INVALID_PAYLOAD", async () => {
  const { core, fetchCalls } = await makeCore({ fetchScripts: [] });
  const garbage = await core.handle("POST", "/worlds/geo/adopt", {
    chatId: "chat-1",
    recentTexts: [42, null, "   ", { bad: true }],
  });
  assert.equal(garbage.body.ok, false);
  assert.equal(garbage.body.error.code, ATLAS_ERROR_CODES.INVALID_PAYLOAD, "有效条目为 0 → 拒绝");
  assert.equal(fetchCalls.length, 0, "零请求");
});
