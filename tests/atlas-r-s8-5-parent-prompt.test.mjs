/**
 * atlas-r-s8-5-parent-prompt.test.mjs — 0.9.55 S8.5：父子层级接进提示词 + 对照表层级标注。
 *
 * 编号说明：施工单 S0～S12 的正本 S9 是「人物从地图重叠标记移入地点菜单」，本文件不是那一步。
 * 它是 S8（UI 允许第四层）与正本 S9 之间的**触发缺口补线**：没有这段接线，模型不知道何时给父，
 * S0–S8 在真实推演里根本不会产出内层地点。
 *
 * 背景：S0–S8 已把「v2 parentLocationRef → 落候选世界 → 投影子图 → /state 只下发根地点
 * → UI 四层」整条链路打通，但默认协议是 v2，而模型看到的 v2 契约里**只有字段名、没有纪律**；
 * v1 老契约（worldTurnProtocol=v1 时使用）还写着「暂不生成子图布局」。缺了这段接线，
 * 真实推演不会产出内层地点，S0–S8 在实机上触发不了。
 *
 * 本文件锁三件事：
 * 1) v2 契约写明何时给父、父能填什么、上限多少，且数字直接取自执行层常量（单一权威，零漂移）；
 * 2) 契约里写的层数上限**就是** S3 的实际拒绝边界——数字从提示词原文里读出来再跑一遍；
 * 3) 地点 id 对照表标注已有子地点的父 ID（根地点不标注），模型据此续接层级而不重复登记。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildWorldFromTemplate, getDemoTemplate } from "../lib/demo-events.ts";
import { parseWorld } from "../lib/world-schema.ts";
import {
  DEFAULT_PROMPT_SEGMENTS,
  DEFAULT_PROMPT_SEGMENTS_V2,
} from "../src/atlas-api-client.ts";
import { parseAtlasWorldTurnDraftV2 } from "../src/atlas-contract-v2.ts";
import { parseAtlasTurnPrepareRequest } from "../src/atlas-contract.ts";
import { prepareAtlasTurn } from "../src/atlas-turn.ts";
import { applyAtlasV2Turn, V2_SUBMAP_DEPTH_MAX, V2_SUBMAP_SIBLINGS_MAX } from "../src/atlas-turn-v2.ts";

const V2_CONTRACT = DEFAULT_PROMPT_SEGMENTS_V2[0].content;
const V1_CONTRACT = DEFAULT_PROMPT_SEGMENTS[0].content;
const segmentByName = (name) => DEFAULT_PROMPT_SEGMENTS_V2.find((s) => s.name === name);

// ---------------------------------------------------------------------------
// 1) v2 契约的父地点纪律
// ---------------------------------------------------------------------------

test("S9：v2 契约含父子层级纪律，层数/宽度上限取自执行层常量（零漂移）", () => {
  assert.ok(V2_CONTRACT.includes("parentLocationRef"), "契约点名父字段");
  assert.ok(
    V2_CONTRACT.includes(`最多 ${V2_SUBMAP_DEPTH_MAX} 层`),
    `契约给出层数上限（取自 V2_SUBMAP_DEPTH_MAX=${V2_SUBMAP_DEPTH_MAX}）`,
  );
  assert.ok(
    V2_CONTRACT.includes(`不超过 ${V2_SUBMAP_SIBLINGS_MAX} 个`),
    `契约给出同父子地点上限（取自 V2_SUBMAP_SIBLINGS_MAX=${V2_SUBMAP_SIBLINGS_MAX}）`,
  );
});

test("S9：契约说清何时给父 / 父能填什么 / 猜错的代价", () => {
  for (const phrase of [
    "只给本轮新建的内层地点",
    "已知地点 ID 或本响应声明的 new:loc: 引用",
    "不能填自己",
    "成环",
    "再用 new:loc: 登记同名地点",
    "宁可平级也不要猜父",
    "整体拒绝",
  ]) {
    assert.ok(V2_CONTRACT.includes(phrase), `契约应含纪律：${phrase}`);
  }
});

test("S9：v1 契约不再对模型说「暂不生成子图布局」，并明确指向 v2", () => {
  assert.ok(!V1_CONTRACT.includes("暂不生成子图布局"), "旧禁令已改写");
  assert.ok(V1_CONTRACT.includes("不支持地点父子层级"), "v1 限制说明清楚");
  assert.ok(V1_CONTRACT.includes("v2"), "v1 契约指向 v2 协议");
  assert.ok(!V2_CONTRACT.includes("暂不生成子图布局"), "v2 契约不得残留 v1 的禁令");
});

test("S9：任务段与核对段都接线（提示词三处提示，不只契约段）", () => {
  const task = segmentByName("本轮行动与实际结果");
  const check = segmentByName("提交前核对");
  assert.ok(task, "存在任务段");
  assert.ok(check, "存在核对段");
  assert.ok(task.content.includes("parentLocationRef"), "任务段提示走进内部时怎么登记");
  assert.ok(check.content.includes("parentLocationRef"), "核对段要求提交前自查父引用");
});

// ---------------------------------------------------------------------------
// 2) 提示词里的数字 = 执行层的拒绝边界
// ---------------------------------------------------------------------------

const CURRENT_TIME = 418.07;
const ASSISTANT_TEXT = "你走进钟楼大堂，再推开档案室的门。";
const SOURCES = { "msg:u": "我进钟楼。", "msg:a": ASSISTANT_TEXT };

function baseWorld() {
  const raw = buildWorldFromTemplate(getDemoTemplate("chronicle"), { id: "s9-world", now: 1000 });
  const parsed = parseWorld(
    JSON.parse(JSON.stringify({ ...raw, points: [...(raw.points ?? []), { id: 9001, name: "钟楼", x: 10, y: 10, regionId: null }] })),
  );
  assert.ok(parsed, "夹具世界可解析");
  return parsed;
}

const loc = (ref, name, parentLocationRef = null) => ({
  ref, name, aliases: [], regionRef: null, parentLocationRef, evidenceIds: ["ev1"],
});

function draftWith(locations) {
  return {
    schemaVersion: 2, baseRevision: CURRENT_TIME, duration: 1,
    evidence: [{ id: "ev1", sourceId: "msg:a", quote: "大堂" }],
    discoveries: { locations, characters: [] },
    scene: { resolution: "confirmed", locationRef: locations[0]?.ref ?? null, transition: "arrive", evidenceIds: ["ev1"] },
    identityUpdates: [], npcUpdates: [], relationUpdates: [], memories: [], worldFlags: [], events: [], mapScaleHints: [],
    summary: "进入建筑。",
  };
}

/** 从 9001 钟楼往下挂 depth 层新地点（返回草稿用地点数组）。 */
function chainOfDepth(depth) {
  const chain = [];
  for (let i = 1; i <= depth; i += 1) {
    chain.push(loc(`new:loc:l${i}`, `第${i}层`, i === 1 ? "9001" : `new:loc:l${i - 1}`));
  }
  return chain;
}

function applyDraft(world, draft) {
  const parsed = parseAtlasWorldTurnDraftV2(JSON.stringify(draft), { baseRevision: CURRENT_TIME, sources: SOURCES });
  assert.equal(parsed.ok, true, `草稿应可解析：${JSON.stringify(parsed.errors ?? [])}`);
  return applyAtlasV2Turn(world, {
    draft: parsed.draft,
    request: { turnId: "turn-s9", chatId: "s9-chat", userMessageId: "u1", assistantMessageId: "a1", swipeId: null, userText: "我进钟楼。", assistantText: ASSISTANT_TEXT },
    branchId: null, currentTime: CURRENT_TIME, currentPointId: "9001", currentRegionId: null, now: 2,
  });
}

test("S9：契约里的层数上限就是执行层的拒绝边界（读提示词数字 → 边界过 / 越界拒）", () => {
  const matched = /最多 (\d+) 层/.exec(V2_CONTRACT);
  assert.ok(matched, "契约给出可读的层数上限");
  const promptDepthMax = Number(matched[1]);
  assert.equal(promptDepthMax, V2_SUBMAP_DEPTH_MAX, "提示词数字与执行层常量同值");

  const okWorld = baseWorld();
  const okOut = applyDraft(okWorld, draftWith(chainOfDepth(promptDepthMax)));
  assert.equal(okOut.receipt.status, "committed", `提示词允许的 ${promptDepthMax} 层必须能提交：${okOut.receipt.summary}`);

  const deepWorld = baseWorld();
  const before = JSON.stringify(deepWorld);
  let thrown = null;
  try {
    applyDraft(deepWorld, draftWith(chainOfDepth(promptDepthMax + 1)));
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `提示词上限之上的第 ${promptDepthMax + 1} 层必须被拒（否则提示词在骗模型）`);
  assert.match(String(thrown.message), /子图上限/, "拒绝原因指向子图层级上限");
  assert.equal(JSON.stringify(deepWorld), before, "拒绝后原世界零变化");
});

// ---------------------------------------------------------------------------
// 3) 地点 id 对照表的层级标注
// ---------------------------------------------------------------------------

function prepareWith(points, currentPointId = "4103") {
  const raw = buildWorldFromTemplate(getDemoTemplate("chronicle"), { id: "s9-prepare", now: 1000 });
  const world = parseWorld(JSON.parse(JSON.stringify({ ...raw, points: [...(raw.points ?? []), ...points] })));
  assert.ok(world, "夹具世界可解析");
  const request = parseAtlasTurnPrepareRequest({
    chatId: "chat-s9", messageId: "msg-1", worldId: world.id, branchId: "chronicle-canon",
    userText: "我进钟楼。", recentMessageRefs: [],
  });
  assert.equal(request.ok, true, "prepare 请求可解析");
  const { response } = prepareAtlasTurn(world, {
    request: request.value, currentTime: CURRENT_TIME, currentPointId, currentRegionId: "capital",
    flags: [], radius: 30,
  });
  return response.injectionText;
}

test("S9：地点 id 对照标注已有子地点的父 ID，根地点不标注", () => {
  const injectionText = prepareWith([
    { id: 9001, name: "钟楼", x: 10, y: 10, regionId: null },
    { id: 9002, name: "大堂", x: 12, y: 12, regionId: null, parentPointId: 9001 },
    { id: 9003, name: "档案室", x: 13, y: 13, regionId: null, parentPointId: 9002 },
  ]);
  const roster = injectionText.split("\n").find((line) => line.startsWith("地点 id 对照："));
  assert.ok(roster, "注入文本含地点 id 对照");
  assert.ok(roster.includes("9002=大堂（在 9001 内）"), `子地点带父 ID：${roster}`);
  assert.ok(roster.includes("9003=档案室（在 9002 内）"), `二级子地点带父 ID：${roster}`);
  assert.ok(roster.includes("9001=钟楼"), "根地点仍在名单里");
  assert.ok(!roster.includes("9001=钟楼（在 "), "根地点不标注父");
});

test("S9：无子地点的世界不出现层级标注（标注不凭空产生）", () => {
  const injectionText = prepareWith([{ id: 9001, name: "钟楼", x: 10, y: 10, regionId: null }]);
  const roster = injectionText.split("\n").find((line) => line.startsWith("地点 id 对照："));
  assert.ok(roster, "注入文本含地点 id 对照");
  assert.ok(roster.includes("9001=钟楼"), "地点仍以 id=名字 形式出现");
  assert.ok(!roster.includes("（在 "), `无父子关系时不得出现层级标注：${roster}`);
});
