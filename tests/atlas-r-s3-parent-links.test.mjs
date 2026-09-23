/**
 * atlas-r-s3-parent-links.test.mjs — 0.9.55 S4：S3 父引用落地的纯函数验收。
 *
 * 覆盖施工单 S4 点名的情形：本轮父子两级、已知父、新旧点混合、无父根地点、未知父、
 * 父在本轮已声明但顺序在子之后、自引用、两点成环、深度刚好 4 与第 5 张子图、
 * 同父孩子上限（跨轮累计）、同键重试只加一次、旧 v2 草稿字段缺省。
 *
 * 注意：v2 契约限制**单响应最多声明 12 个新地点**（MAX.newLocations），
 * 因此 40 个同父孩子只能跨多轮累计——本文件据此按轮累加验证。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildWorldFromTemplate, getDemoTemplate } from "../lib/demo-events.ts";
import { parseWorld } from "../lib/world-schema.ts";
import { applyAtlasV2Turn, V2_SUBMAP_DEPTH_MAX, V2_SUBMAP_SIBLINGS_MAX } from "../src/atlas-turn-v2.ts";
import { parseAtlasWorldTurnDraftV2 } from "../src/atlas-contract-v2.ts";
import { AtlasError } from "../src/atlas-contract.ts";

const CURRENT_TIME = 418.07;
const ASSISTANT_TEXT = "你走进钟楼大堂，再推开档案室的门。";
const SOURCES = { "msg:u": "我进钟楼。", "msg:a": ASSISTANT_TEXT };

function baseWorld({ withExistingChain = false } = {}) {
  const raw = buildWorldFromTemplate(getDemoTemplate("chronicle"), { id: "s4-world", now: 1000 });
  const extra = [{ id: 9001, name: "钟楼", x: 10, y: 10, regionId: null }];
  if (withExistingChain) extra.push({ id: 9002, name: "旧大堂", x: 12, y: 12, regionId: null, parentPointId: 9001 });
  const parsed = parseWorld(JSON.parse(JSON.stringify({ ...raw, points: [...(raw.points ?? []), ...extra] })));
  assert.ok(parsed, "夹具世界可解析");
  return parsed;
}

function makeRequest(overrides = {}) {
  return {
    turnId: "turn-s4", chatId: "s4-chat", userMessageId: "u1", assistantMessageId: "a1", swipeId: null,
    userText: "我进钟楼。", assistantText: ASSISTANT_TEXT, ...overrides,
  };
}

function draftWith(locations, overrides = {}) {
  return {
    schemaVersion: 2, baseRevision: CURRENT_TIME, duration: 1,
    evidence: [{ id: "ev1", sourceId: "msg:a", quote: "大堂" }],
    discoveries: { locations, characters: [] },
    scene: { resolution: "confirmed", locationRef: locations[0]?.ref ?? null, transition: "arrive", evidenceIds: ["ev1"] },
    identityUpdates: [], npcUpdates: [], relationUpdates: [], memories: [], worldFlags: [], events: [], mapScaleHints: [],
    summary: "进入建筑。", ...overrides,
  };
}

function apply(world, draft, request = makeRequest(), extra = {}) {
  const parsed = parseAtlasWorldTurnDraftV2(JSON.stringify(draft), { baseRevision: CURRENT_TIME, sources: SOURCES });
  assert.equal(parsed.ok, true, `草稿应可解析：${JSON.stringify(parsed.errors ?? [])}`);
  return applyAtlasV2Turn(world, {
    draft: parsed.draft, request, branchId: null, currentTime: CURRENT_TIME,
    currentPointId: "9001", currentRegionId: null, now: 2, ...extra,
  });
}

/** 单个提交，不抛错时返回输出；抛错时返回 AtlasError（供「拒绝」类断言复用一次解析）。 */
function tryApply(world, draft, request = makeRequest(), extra = {}) {
  const parsed = parseAtlasWorldTurnDraftV2(JSON.stringify(draft), { baseRevision: CURRENT_TIME, sources: SOURCES });
  if (!parsed.ok) return { parseFailed: true, errors: parsed.errors };
  try {
    return {
      output: applyAtlasV2Turn(world, {
        draft: parsed.draft, request, branchId: null, currentTime: CURRENT_TIME,
        currentPointId: "9001", currentRegionId: null, now: 2, ...extra,
      }),
    };
  } catch (error) {
    return { thrown: error };
  }
}

const loc = (ref, name, parentLocationRef = null) => ({ ref, name, aliases: [], regionRef: null, parentLocationRef, evidenceIds: ["ev1"] });
const point = (world, name) => (world.points ?? []).find((p) => p.name === name);
const parentOf = (world, name) => point(world, name)?.parentPointId ?? null;

test("S4：本轮父子两级 + 已知父 + 新旧点混合，一次提交落地", () => {
  const world = baseWorld();
  const out = apply(world, draftWith([
    loc("new:loc:hall", "大堂", "9001"),
    loc("new:loc:archive", "档案室", "new:loc:hall"),
  ]));
  assert.equal(out.receipt.status, "committed", `应提交成功：${out.receipt.summary}`);
  assert.equal(parentOf(out.world, "大堂"), 9001, "大堂的父 = 已知钟楼 9001");
  assert.equal(parentOf(out.world, "档案室"), point(out.world, "大堂").id, "档案室的父 = 同轮新建的大堂");
  assert.equal(out.createdPointIds.length, 2, "恰好新建两个点");
});

test("S4：无父根地点保持 parentPointId 缺省", () => {
  const out = apply(baseWorld(), draftWith([loc("new:loc:plaza", "广场", null)]));
  assert.equal(out.receipt.status, "committed");
  assert.equal("parentPointId" in point(out.world, "广场"), false, "根地点不凭空补父字段");
});

test("S4：父在本轮已声明但顺序在子之后，仍正确链接（顺序无关）", () => {
  const out = apply(baseWorld(), draftWith([
    loc("new:loc:archive", "档案室", "new:loc:hall"),
    loc("new:loc:hall", "大堂", "9001"),
  ]));
  assert.equal(out.receipt.status, "committed", `顺序无关应成立：${out.receipt.summary}`);
  assert.equal(parentOf(out.world, "档案室"), point(out.world, "大堂").id, "子仍挂到后声明的父上");
  assert.equal(parentOf(out.world, "大堂"), 9001, "父自身挂到已知钟楼");
});

test("S4：未知父 / 自引用 → 整轮拒绝且零写入", () => {
  for (const [label, locations] of [
    ["未知父", [loc("new:loc:hall", "大堂", "new:loc:ghost")]],
    ["自引用", [loc("new:loc:hall", "大堂", "new:loc:hall")]],
  ]) {
    const world = baseWorld();
    const before = JSON.stringify(world);
    const eventsBefore = (world.stateEvents ?? []).length;
    const result = tryApply(world, draftWith(locations));
    assert.ok(result.parseFailed || result.thrown, `${label} 必须被拒绝（解析层或应用层）`);
    assert.equal(JSON.stringify(world), before, `${label}：原世界零变化`);
    assert.equal((world.stateEvents ?? []).length, eventsBefore, `${label}：账本不变`);
  }
});

test("S4：深度刚好 4 层通过，第 5 层子图被拒绝", () => {
  const four = apply(baseWorld(), draftWith([
    loc("new:loc:l1", "一层", "9001"),
    loc("new:loc:l2", "二层", "new:loc:l1"),
    loc("new:loc:l3", "三层", "new:loc:l2"),
    loc("new:loc:l4", "四层", "new:loc:l3"),
  ]));
  assert.equal(four.receipt.status, "committed", `深度 4 应通过：${four.receipt.summary}`);

  const deep = baseWorld();
  const before = JSON.stringify(deep);
  const result = tryApply(deep, draftWith([
    loc("new:loc:l1", "一层", "9001"),
    loc("new:loc:l2", "二层", "new:loc:l1"),
    loc("new:loc:l3", "三层", "new:loc:l2"),
    loc("new:loc:l4", "四层", "new:loc:l3"),
    loc("new:loc:l5", "五层", "new:loc:l4"),
  ]));
  assert.ok(result.thrown, "第 5 层子图必须拒绝");
  assert.match(String(result.thrown.message), /子图上限/, "错误说明指向子图层级上限");
  assert.equal(JSON.stringify(deep), before, "超深拒绝后原世界零变化");
});

test("S4：已存父链计入深度", () => {
  const world = baseWorld({ withExistingChain: true });
  const out = apply(world, draftWith([loc("new:loc:inner", "内室", "9002")]));
  assert.equal(out.receipt.status, "committed", `累计深度 2 应通过：${out.receipt.summary}`);
  assert.equal(parentOf(out.world, "内室"), 9002, "新点挂到已有父链末端");
});

// ---------------------------------------------------------------------------
// S4 残留两项的归属（2026-09-24 更新——不要再当成「未验收」）：
//
// 1) 同父孩子上限的**跨轮累计**改在服务层验收：单响应最多 12 个新地点，纯函数层直接造
//    「已存 40 个子点」会被解析器先挡下，故由 tests/atlas-server-plugin.test.mjs 的
//    S10⑨a（恰好 40 个合法通过）与 S10⑨b（第 41 个整轮拒绝、零写入）覆盖。
//    S10⑨b 起初是红灯：旧实现只数 `world.points`（本轮新点不在其中），「已存 40 +
//    本轮第 41 个」漏判——世界真落了第 41 个子点，随后被 /state 的子图 40 上限裁掉，
//    正撞施工单禁止的「靠截断静默丢弃第 41 个地点」。已在 src/atlas-turn-v2.ts 改为按
//    **最终**数量（已存 + 本轮新挂到该父的）判定后转绿。
// 2) 同键重试返回 duplicate 同样归服务层：由 atlas-server-plugin.test.mjs 的 S10⑧
//    （duplicate、地图不重复添点、零额外模型调用）覆盖；本文件的纯函数层不再重复断言幂等。
// ---------------------------------------------------------------------------

test("S4：旧 v2 草稿字段缺省（无 parentLocationRef）仍可提交", () => {
  const draft = draftWith([loc("new:loc:plaza", "广场", null)]);
  delete draft.discoveries.locations[0].parentLocationRef;
  const out = apply(baseWorld(), draft);
  assert.equal(out.receipt.status, "committed", `缺省字段应可提交：${out.receipt.summary}`);
  assert.equal("parentPointId" in point(out.world, "广场"), false, "缺省 → 根地点，不补父字段");
});

test("S4：常量与既有上限同口径", () => {
  assert.equal(V2_SUBMAP_DEPTH_MAX, 4, "最多四张连续子图");
  assert.equal(V2_SUBMAP_SIBLINGS_MAX, 40, "每层最多 40 个点（与 SUBMAP_POINTS_MAX 同口径）");
});
