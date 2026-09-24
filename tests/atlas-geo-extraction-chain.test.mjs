/**
 * atlas-geo-extraction-chain.test.mjs — H04 / H05 关系规划的定向验收。
 *
 * 背景：H04（提炼契约扩展）与 H05（两趟处理 + 证据校验）的实现已落地并被
 * `runGeoExtraction` 真实调用（`src/atlas-server.ts` :956 定义、:2620 调用），
 * 但 `planGeoRelations` 此前在 tests/ 下**零覆盖**——全量绿灯只是因为没人碰它。
 * 本文件补上这块空白，锁住计划点名的几条硬性语义。
 *
 * 为什么值得单独锁：
 * - 「有引文才算证据」是这条链唯一的防腐层：没有它，模型说谁属于谁就直接写进三表；
 * - 「名字含城名」是计划亲自点名的反例（「圣罗兰外城区」不能因为含「圣罗兰城」
 *   就自动变成城市的下级）；
 * - 「证据不足留待用户确认」是 §2.1 的纪律：宁可 pending，也不猜。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { planGeoRelations } from "../src/atlas-server.ts";

/** 本轮可用材料：引文必须**逐字**出现在这里面才算证据。 */
const MATERIAL = [
  "学校把三年二班收在里面。",
  "圣罗兰城挨着外城区。",
  "驿站在市场旁边。",
];
const quoteSource = (quote) => (MATERIAL.includes(quote) ? "story" : null);

const loc = (id, name, parentLocationId = null) => ({ id, name, parentLocationId });

function cand(over = {}) {
  return {
    id: "loc:100",
    name: "三年二班",
    existing: false,
    relation: "none",
    counterpartName: null,
    mobile: null,
    anchorName: null,
    evidenceQuote: null,
    ...over,
  };
}

test("H05：有逐字引文的 contained 才进 parents（证据链是唯一的放行口）", () => {
  const plan = planGeoRelations({
    locations: [loc("loc:1", "学校")],
    candidates: [cand({
      id: "loc:100", name: "三年二班",
      relation: "contained", counterpartName: "学校",
      evidenceQuote: "学校把三年二班收在里面。",
    })],
    quoteSource,
  });
  assert.deepEqual(plan.parents, [{ childId: "loc:100", parentId: "loc:1" }],
    "有引文的包含关系必须落进 parents");
  assert.equal(plan.pending.length, 0, "证据充分就不该进 pending");
  const row = plan.preview.find((item) => item.id === "loc:100");
  assert.ok(row, "预览里应有该候选");
  assert.equal(row.parent, "loc:1", "预览要如实回报已确认的父");
  assert.equal(row.pending, false);
});

test("H05：引文不在本轮材料里 → 只进 pending，绝不写父子", () => {
  const plan = planGeoRelations({
    locations: [loc("loc:1", "学校")],
    candidates: [cand({
      relation: "contained", counterpartName: "学校",
      evidenceQuote: "这句话根本不在材料里。",
    })],
    quoteSource,
  });
  assert.equal(plan.parents.length, 0, "没有证据不得写父子关系");
  assert.equal(plan.pending.length, 1, "必须留待用户确认，不能静默丢弃");
  assert.ok(typeof plan.pending[0].reasonCode === "string" && plan.pending[0].reasonCode.length > 0,
    `pending 必须带具名原因：${JSON.stringify(plan.pending[0])}`);
});

/**
 * 没有引文的 contained：必须进 pending，且**不得**退化成「本来就没有关系」。
 *
 * 计划 H05 原文：「重名、缺 parent、环、**没有引文或引文不在世界书/正文**时把该关系
 * **留待用户确认**」。此前 `planGeoRelations` 只处理 `contained` / `adjacent` 两种 verdict，
 * `judgeGeoRelation` 返回的 `verdict:"pending"` 没被接住，于是预览行落到默认的
 * `NO_RELATION` —— 作者看不出「模型主张过这条关系、只是缺证据」。
 * 现已接住，本用例锁死这个语义。
 */
test("H05：声明了 contained 却没有引文 → 进 pending（NO_EVIDENCE），不退化成「无关系」", () => {
  const plan = planGeoRelations({
    locations: [loc("loc:1", "学校")],
    candidates: [cand({ relation: "contained", counterpartName: "学校", evidenceQuote: null })],
    quoteSource,
  });
  assert.equal(plan.parents.length, 0, "没有引文绝不能写父子关系");
  assert.equal(plan.pending.length, 1, "缺引文的关系必须留待用户确认，不能静默吞掉");
  assert.equal(plan.pending[0].reasonCode, "NO_EVIDENCE", "原因码要具体到「缺证据」");
  assert.equal(plan.pending[0].kind, "contained", "pending 要如实记录模型主张的是哪种关系");
  const row = plan.preview.find((item) => item.id === "loc:100");
  assert.ok(row, "候选仍要出现在预览里（不静默丢弃）");
  assert.equal(row.parent, null, "预览里的父必须是空的");
  assert.notEqual(row.reasonCode, "NO_RELATION",
    "不得把「主张过但缺证据」说成「本来就没有关系」");
});

test("H04/H05：名字里含城名**不等于**包含关系（计划点名的反例）", () => {
  const plan = planGeoRelations({
    locations: [loc("loc:1", "圣罗兰城")],
    candidates: [cand({
      id: "loc:200", name: "圣罗兰外城区",
      // 模型没给关系也没给引文 —— 只有名字沾亲带故
      relation: "none", counterpartName: null, evidenceQuote: null,
    })],
    quoteSource,
  });
  assert.equal(plan.parents.length, 0,
    "「圣罗兰外城区」不得因为名字含「圣罗兰城」就自动变成它的子地点");
  assert.ok(!plan.parents.some((row) => row.parentId === "loc:1"),
    "更不允许把城市当成它的父");
});

test("H05：有引文的 adjacent 落进 adjacencies，且证据来源如实回显", () => {
  const plan = planGeoRelations({
    locations: [loc("loc:1", "圣罗兰城"), loc("loc:2", "外城区")],
    candidates: [cand({
      id: "loc:2", name: "外城区", existing: true,
      relation: "adjacent", counterpartName: "圣罗兰城",
      evidenceQuote: "圣罗兰城挨着外城区。",
    })],
    quoteSource,
  });
  assert.equal(plan.adjacencies.length, 1, "有证据的邻接要落进 adjacencies");
  assert.equal(plan.adjacencies[0].evidence, "story", "证据来源要如实回显");
  assert.equal(plan.parents.length, 0, "adjacent 绝不能被当成父子（§2.5）");
});

test("H05：同名歧义 → 留待用户确认，不猜是哪一个", () => {
  const plan = planGeoRelations({
    locations: [loc("loc:1", "市场"), loc("loc:2", "市场")],
    candidates: [cand({
      id: "loc:300", name: "摊子",
      relation: "contained", counterpartName: "市场",
      evidenceQuote: "驿站在市场旁边。",
    })],
    quoteSource,
  });
  assert.equal(plan.parents.length, 0, "同名两处时不得任选一个当父");
  assert.equal(plan.pending.length, 1, "歧义必须留给用户确认");
});

test("H05：对端地点不认识 → 留待确认，不凭空造一个父", () => {
  const plan = planGeoRelations({
    locations: [loc("loc:1", "学校")],
    candidates: [cand({
      relation: "contained", counterpartName: "从未出现过的地名",
      evidenceQuote: "学校把三年二班收在里面。",
    })],
    quoteSource,
  });
  assert.equal(plan.parents.length, 0);
  assert.equal(plan.pending.length, 1);
});

test("H05：existing=true 表示复用既有地点，预览回显的是既有 id", () => {
  const plan = planGeoRelations({
    locations: [loc("loc:1", "学校"), loc("loc:2", "三年二班", "loc:1")],
    candidates: [cand({ id: "loc:2", name: "三年二班", existing: true, relation: "none" })],
    quoteSource,
  });
  const row = plan.preview.find((item) => item.id === "loc:2");
  assert.ok(row, "复用既有地点也要出现在预览里");
  assert.equal(row.id, "loc:2", "必须是既有的正式 id，绝不新建第二个同名点");
});

test("H05：纯函数——不改入参（调用方要用同一份候选写回）", () => {
  const locations = [loc("loc:1", "学校")];
  const candidates = [cand({
    relation: "contained", counterpartName: "学校",
    evidenceQuote: "学校把三年二班收在里面。",
  })];
  const snapshot = JSON.stringify({ locations, candidates });
  planGeoRelations({ locations, candidates, quoteSource });
  assert.equal(JSON.stringify({ locations, candidates }), snapshot, "入参必须原样不动");
});
