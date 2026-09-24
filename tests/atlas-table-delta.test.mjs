/**
 * atlas-table-delta.test.mjs — B05 / B06 定向验收（`table-delta-v1` 解析与应用）。
 *
 * 计划 §2 的固定解析顺序与上限：只认最后一个完整块、16 KiB / 64 行 / 单行 2 KiB、
 * 逐行语法 → 白名单 → 引用 → 引文；`basis="inferred"` 只可改推测字段；
 * 空块 / 缺闭合标签是明确失败，绝不抢救半截 JSON。
 * B06：依源顺序应用、逐行回执、失败依赖不执行、候选校验不过则整轮回退。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  ATLAS_EDIT_BLOCK_LIMITS,
  applyAtlasEditText,
  applyAtlasTableDelta,
  parseAtlasEditBlock,
} from "../src/atlas-table-delta.ts";
import { validateAtlasTables } from "../src/atlas-tables.ts";

const SOURCES = {
  "msg:u": "我进钟楼，把铜钥匙留在桌上。",
  "msg:a": "你走进钟楼，看见桌上的铜钥匙。守卫留在钟楼，担心夜里的巡逻。",
};

function block(...lines) {
  return `<atlasEdit>\n${lines.join("\n")}\n</atlasEdit>`;
}

function emptyTables() {
  return { locations: [], characters: [], items: [] };
}

function line(value) {
  return JSON.stringify(value);
}

test("B05 正常块：三类行全部接受，行号与 sourceId 由程序填好", () => {
  const text = [
    "先说一句废话，块外文字必须被忽略。",
    block(
      line({ table: "location", op: "add", ref: "new:loc:1", name: "钟楼", description: "旧钟楼", quote: "走进钟楼" }),
      line({ table: "character", op: "set", ref: "npc:keeper", patch: { thought: "担心巡逻", actionTendency: "留在钟楼" }, basis: "inferred" }),
      line({ table: "item", op: "add", ref: "new:item:1", name: "铜钥匙", locationRef: "new:loc:1", quote: "桌上的铜钥匙" }),
    ),
    "块后还有解释，也要忽略。",
  ].join("\n");

  const result = parseAtlasEditBlock(text, SOURCES);
  assert.equal(result.status, "edits", JSON.stringify(result.rejected));
  assert.equal(result.edits.length, 3);
  assert.deepEqual(result.edits.map((edit) => edit.line), [1, 2, 3]);
  assert.equal(result.edits[0].sourceId, "msg:a");
  assert.equal(result.edits[2].sourceId, "msg:a");
  assert.equal(result.rejected.length, 0);
});

test("B05 只认最后一个完整块；块外的同名标签不影响", () => {
  const first = block(line({ table: "location", op: "add", ref: "new:loc:1", name: "旧块", quote: "走进钟楼" }));
  const second = block(line({ table: "location", op: "add", ref: "new:loc:2", name: "新块", quote: "走进钟楼" }));
  const result = parseAtlasEditBlock(`${first}\n${second}`, SOURCES);
  assert.equal(result.status, "edits");
  assert.equal(result.edits.length, 1);
  assert.equal(result.edits[0].name, "新块");
});

test("B05 块缺失 / 未闭合 / 空块 / 空标签都是明确失败", () => {
  assert.equal(parseAtlasEditBlock("本轮没有任何块。", SOURCES).error.code, "BLOCK_MISSING");
  assert.equal(parseAtlasEditBlock("<atlasEdit>\n{}\n", SOURCES).error.code, "BLOCK_MISSING");
  assert.equal(parseAtlasEditBlock(block(""), SOURCES).error.code, "BLOCK_EMPTY");
  assert.equal(parseAtlasEditBlock(block("   "), SOURCES).error.code, "BLOCK_EMPTY");
});

test("B05 未闭合思考段里的块绝不抢救；完整前置推理段则照常剥离", () => {
  const good = `<think>先想一下</think>\n${block(line({ table: "location", op: "add", ref: "new:loc:1", name: "钟楼", quote: "走进钟楼" }))}`;
  assert.equal(parseAtlasEditBlock(good, SOURCES).status, "edits");

  const unfinished = `<think>我还在想\n${block(line({ table: "location", op: "add", ref: "new:loc:1", name: "钟楼", quote: "走进钟楼" }))}`;
  const result = parseAtlasEditBlock(unfinished, SOURCES);
  assert.equal(result.status, "rejected");
  assert.equal(result.error.code, "BLOCK_MISSING");
});

test("B05 noop 可成功且不造实体", () => {
  const result = parseAtlasEditBlock(block(line({ kind: "noop" })), SOURCES);
  assert.equal(result.status, "noop");
  assert.equal(result.noop, true);
  assert.equal(result.edits.length, 0);
  assert.equal(result.error, null);
});

test("B05 上限：64 行、单行 2 KiB、整块 16 KiB", () => {
  const many = Array.from({ length: ATLAS_EDIT_BLOCK_LIMITS.lines + 1 }, (_, index) =>
    line({ table: "location", op: "add", ref: `new:loc:${index + 1}`, name: `L${index}`, quote: "走进钟楼" }));
  assert.equal(parseAtlasEditBlock(block(...many), SOURCES).error.code, "TOO_MANY_LINES");

  const long = line({ table: "location", op: "add", ref: "new:loc:1", name: "钟楼", description: "字".repeat(ATLAS_EDIT_BLOCK_LIMITS.lineChars), quote: "走进钟楼" });
  assert.equal(parseAtlasEditBlock(block(long), SOURCES).error.code, "LINE_TOO_LONG");

  const huge = Array.from({ length: 10 }, (_, index) =>
    line({ table: "item", op: "add", ref: `new:item:${index}`, name: `物品${index}`, description: "甲".repeat(1800), locationRef: null }));
  assert.equal(parseAtlasEditBlock(block(...huge), SOURCES).error.code, "BLOCK_TOO_LARGE");
});

test("B05 单行语法错不影响其他行（有误格式只影响具体变更）", () => {
  const text = block(
    line({ table: "location", op: "add", ref: "new:loc:1", name: "钟楼", quote: "走进钟楼" }),
    '{ table: "location", op: "add", ref: "new:loc:2" }',
    line({ table: "item", op: "add", ref: "new:item:1", name: "铜钥匙", locationRef: "new:loc:1", quote: "桌上的铜钥匙" }),
  );
  const result = parseAtlasEditBlock(text, SOURCES);
  assert.equal(result.status, "edits");
  assert.deepEqual(result.edits.map((edit) => edit.ref), ["new:loc:1", "new:item:1"]);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].line, 2);
  assert.equal(result.rejected[0].code, "JSON_SYNTAX");
});

test("B05 白名单：模型不能直接写 id / 坐标 / 时间 / 比例尺，patch 同样受限", () => {
  const cases = [
    [{ table: "location", op: "add", ref: "new:loc:1", name: "钟楼", gridX: 5, quote: "走进钟楼" }, "$.gridX"],
    [{ table: "location", op: "set", ref: "loc:1", patch: { id: "loc:9" } }, "$.patch.id"],
    [{ table: "location", op: "set", ref: "loc:1", patch: { mapId: "world" } }, "$.patch.mapId"],
    [{ table: "character", op: "add", ref: "new:npc:a", name: "看守", positionSource: "narrative", quote: "守卫留在钟楼" }, "$.positionSource"],
    [{ table: "item", op: "set", ref: "item:1", patch: { gridY: 3 } }, "$.patch.gridY"],
  ];
  for (const [payload, path] of cases) {
    const result = parseAtlasEditBlock(block(line(payload)), SOURCES);
    assert.equal(result.status, "rejected", JSON.stringify(payload));
    const hit = result.rejected.find((item) => item.code === "FIELD_NOT_ALLOWED" && item.path === path);
    assert.ok(hit, `期望 FIELD_NOT_ALLOWED ${path}；实际 ${JSON.stringify(result.rejected)}`);
  }
});

test("B05 table / op / ref 形态错误各有具名错误", () => {
  const badTable = parseAtlasEditBlock(block(line({ table: "region", op: "add", ref: "new:loc:1", name: "X" })), SOURCES);
  assert.equal(badTable.rejected[0].code, "TABLE_INVALID");

  const badOp = parseAtlasEditBlock(block(line({ table: "location", op: "merge", ref: "loc:1" })), SOURCES);
  assert.equal(badOp.rejected[0].code, "OP_INVALID");

  const wrongKind = parseAtlasEditBlock(block(line({ table: "location", op: "add", ref: "new:npc:1", name: "X", quote: "走进钟楼" })), SOURCES);
  assert.equal(wrongKind.rejected[0].code, "REF_INVALID");

  const existingOnAdd = parseAtlasEditBlock(block(line({ table: "location", op: "add", ref: "loc:1", name: "X", quote: "走进钟楼" })), SOURCES);
  assert.equal(existingOnAdd.rejected[0].code, "REF_INVALID");

  const duplicateRef = parseAtlasEditBlock(block(
    line({ table: "location", op: "add", ref: "new:loc:1", name: "A", quote: "走进钟楼" }),
    line({ table: "location", op: "add", ref: "new:loc:1", name: "B", quote: "走进钟楼" }),
  ), SOURCES);
  assert.equal(duplicateRef.status, "edits");
  assert.equal(duplicateRef.edits.length, 1);
  assert.equal(duplicateRef.rejected[0].code, "REF_INVALID");
  assert.equal(duplicateRef.rejected[0].line, 2);
});

test("B05 引用未声明 / 声明失败的新增行 → dependency_failed（不是整轮失败）", () => {
  const text = block(
    line({ table: "location", op: "add", ref: "new:loc:1", name: "钟楼", quote: "走进钟楼" }),
    line({ table: "character", op: "add", ref: "new:npc:a", name: "看守", locationRef: "new:loc:404", quote: "守卫留在钟楼" }),
    line({ table: "item", op: "add", ref: "new:item:1", name: "铜钥匙", locationRef: "new:loc:1", quote: "桌上的铜钥匙" }),
  );
  const result = parseAtlasEditBlock(text, SOURCES);
  assert.equal(result.status, "edits", "有合法行就继续，不整轮丢");
  assert.deepEqual(result.edits.map((edit) => edit.line), [1, 3]);
  const failed = result.rejected.find((item) => item.code === "DEPENDENCY_FAILED");
  assert.ok(failed, JSON.stringify(result.rejected));
  assert.equal(failed.line, 2);
  assert.equal(failed.path, "$.locationRef");
  assert.equal(failed.ref, "new:loc:404");
});

test("B05 引文：位置/归属改动必须要 observed 原文；两处正文都认，程序决定 sourceId", () => {
  const missing = parseAtlasEditBlock(block(
    line({ table: "location", op: "add", ref: "new:loc:1", name: "钟楼" }),
  ), SOURCES);
  assert.equal(missing.rejected[0].code, "QUOTE_REQUIRED");

  const notFound = parseAtlasEditBlock(block(
    line({ table: "location", op: "add", ref: "new:loc:1", name: "钟楼", quote: "这句话不在正文里" }),
  ), SOURCES);
  assert.equal(notFound.rejected[0].code, "QUOTE_NOT_FOUND");

  const fromUser = parseAtlasEditBlock(block(
    line({ table: "location", op: "add", ref: "new:loc:1", name: "钟楼", quote: "我进钟楼" }),
  ), SOURCES);
  assert.equal(fromUser.status, "edits");
  assert.equal(fromUser.edits[0].sourceId, "msg:u");

  // 纯描述字段不强制引文
  const description = parseAtlasEditBlock(block(
    line({ table: "location", op: "set", ref: "loc:1", patch: { description: "旧钟楼" } }),
  ), SOURCES);
  assert.equal(description.status, "edits");
});

test("B05 inferred 只可改推测字段：想法可以，位置/销毁不行", () => {
  const thought = parseAtlasEditBlock(block(
    line({ table: "character", op: "set", ref: "npc:keeper", patch: { thought: "担心巡逻" }, basis: "inferred" }),
  ), SOURCES);
  assert.equal(thought.status, "edits");

  const target = parseAtlasEditBlock(block(
    line({ table: "character", op: "set", ref: "npc:keeper", patch: { targetLocationRef: "loc:1" }, basis: "inferred" }),
  ), SOURCES);
  assert.equal(target.status, "edits", "推测的目标地点允许，真正移动交给程序规则");

  const move = parseAtlasEditBlock(block(
    line({ table: "character", op: "set", ref: "npc:keeper", patch: { locationRef: "loc:1" }, basis: "inferred" }),
  ), SOURCES);
  assert.equal(move.rejected[0].code, "INFERRED_FIELD_NOT_ALLOWED");
  assert.equal(move.rejected[0].path, "$.patch.locationRef");

  const destroy = parseAtlasEditBlock(block(
    line({ table: "item", op: "remove", ref: "item:1", basis: "inferred" }),
  ), SOURCES);
  assert.ok(destroy.rejected.some((item) => item.code === "INFERRED_FIELD_NOT_ALLOWED" || item.code === "QUOTE_REQUIRED"));

  const badBasis = parseAtlasEditBlock(block(
    line({ table: "character", op: "set", ref: "npc:keeper", patch: { thought: "X" }, basis: "guessed" }),
  ), SOURCES);
  assert.equal(badBasis.rejected[0].code, "BASIS_INVALID");
});

/* ============================ B06 ============================ */

test("B06 T05 场景：行 1/4 应用、行 2 字段错误、行 3 dependency_failed，候选仍合法", () => {
  const text = block(
    line({ table: "location", op: "add", ref: "new:loc:1", name: "钟楼", quote: "走进钟楼" }),
    line({ table: "location", op: "add", ref: "new:loc:2", name: "地窖", parentRef: "loc:404", quote: "走进钟楼" }),
    line({ table: "character", op: "add", ref: "new:npc:a", name: "看守", locationRef: "new:loc:2", quote: "守卫留在钟楼" }),
    line({ table: "item", op: "add", ref: "new:item:1", name: "铜钥匙", locationRef: "new:loc:1", quote: "桌上的铜钥匙" }),
  );
  const base = emptyTables();
  const parse = parseAtlasEditBlock(text, SOURCES);
  assert.equal(parse.status, "edits", JSON.stringify(parse.rejected));

  const delta = applyAtlasTableDelta(base, parse.edits);
  assert.deepEqual(delta.applied.map((row) => row.line), [1, 4]);
  assert.deepEqual(delta.rejected.map((row) => [row.line, row.code]),
    [[2, "ROW_NOT_FOUND"], [3, "DEPENDENCY_FAILED"]]);
  assert.equal(delta.tables.locations.length, 1);
  assert.equal(delta.tables.items.length, 1);
  assert.equal(delta.tables.characters.length, 0, "依赖失败的行不得落地");
  assert.deepEqual(validateAtlasTables(delta.tables), { ok: true, errors: [] });
  assert.equal(base.locations.length, 0, "输入永不被修改");
});

test("B06 本块后声明先引用：同一块里新增地点后立刻挂子地点", () => {
  const text = block(
    line({ table: "location", op: "add", ref: "new:loc:1", name: "钟楼", quote: "走进钟楼" }),
    line({ table: "location", op: "add", ref: "new:loc:2", name: "档案室", parentRef: "new:loc:1", quote: "走进钟楼" }),
  );
  const delta = applyAtlasTableDelta(emptyTables(), parseAtlasEditBlock(text, SOURCES).edits);
  assert.equal(delta.ok, true);
  const child = delta.tables.locations.find((row) => row.name === "档案室");
  assert.equal(child.parentLocationId, delta.tables.locations[0].id);
  assert.equal(child.mapId, child.parentLocationId, "子地点进父地点的子图");
});

test("B06 失败行不占号：同一输入两次运行结果逐字相同", () => {
  const text = block(
    line({ table: "location", op: "add", ref: "new:loc:1", name: "钟楼", quote: "走进钟楼" }),
    line({ table: "location", op: "add", ref: "new:loc:2", name: "地窖", parentRef: "loc:404", quote: "走进钟楼" }),
    line({ table: "location", op: "add", ref: "new:loc:3", name: "塔顶", parentRef: "new:loc:1", quote: "走进钟楼" }),
  );
  const first = applyAtlasTableDelta(emptyTables(), parseAtlasEditBlock(text, SOURCES).edits);
  const second = applyAtlasTableDelta(emptyTables(), parseAtlasEditBlock(text, SOURCES).edits);
  assert.deepEqual(first.tables, second.tables, "分配是候选表的纯函数，失败行不留号");
  assert.deepEqual(first.tables.locations.map((row) => row.id), ["loc:1", "loc:2"], "第三个新地点接在第二个槽位后");
});

test("B06 候选校验不过 → 整轮回退，返回未改动的输入", () => {
  const broken = { locations: [{ id: "loc:1", name: "钟楼", parentLocationId: "loc:9", description: "", rumors: [], factions: [], mapId: "loc:9", gridX: null, gridY: null }], characters: [], items: [] };
  assert.equal(validateAtlasTables(broken).ok, false, "夹具本身非法");
  const text = block(line({ table: "item", op: "add", ref: "new:item:1", name: "铜钥匙", quote: "桌上的铜钥匙" }));
  const parse = parseAtlasEditBlock(text, SOURCES);
  const delta = applyAtlasTableDelta(broken, parse.edits);
  assert.equal(delta.ok, false);
  assert.equal(delta.error.code, "TABLE_VALIDATION_FAILED");
  assert.equal(delta.tables, broken, "整轮回退返回输入本体");
  assert.equal(delta.tables.items.length, 0);
});

test("B06 便利封装：noop 不改数据，解析失败不产生 delta", () => {
  const noop = applyAtlasEditText(emptyTables(), block(line({ kind: "noop" })), SOURCES);
  assert.equal(noop.parse.status, "noop");
  assert.equal(noop.delta.ok, true);
  assert.equal(noop.delta.applied.length, 0);

  const missing = applyAtlasEditText(emptyTables(), "没有块", SOURCES);
  assert.equal(missing.parse.status, "rejected");
  assert.equal(missing.delta, null, "解析失败绝不产生应用结果");
});

/* ================================================================== *
 * C03 / C05：上下文装配与一次回合提交（都是纯函数）
 * ================================================================== */

const { buildTableDeltaContext, commitTableDeltaTurn } = await import("../src/atlas-server.ts");
const { buildWorldFromTemplate, getDemoTemplate } = await import("../lib/demo-events.ts");
const { parseWorld } = await import("../lib/world-schema.ts");

const BASE_BINDING = {
  schemaVersion: 1, enabled: true, chatId: "c1", characterId: "chronicle-c1",
  worldId: "w-mig", branchId: null, currentLocationId: "4103", worldTimeCursor: 100,
  lastCommittedMessageId: null, lastCheckpointId: null,
};

function demoWorld() {
  const parsed = parseWorld(JSON.parse(JSON.stringify(
    buildWorldFromTemplate(getDemoTemplate("chronicle"), { id: "w-mig", now: 1000 }),
  )));
  assert.ok(parsed, "夹具世界可解析");
  return parsed;
}

/** 三表夹具：loc:4103（当前）下挂 loc:4200；一个人物、一件地面物品、一件持有物。 */
function tableFixture() {
  return {
    locations: [
      { id: "loc:4101", name: "雪线驿站", parentLocationId: null, description: "北境驿站", rumors: [], factions: [], mapId: "world", gridX: 20, gridY: 20 },
      { id: "loc:4103", name: "白塔钟座", parentLocationId: null, description: "钟塔内部", rumors: ["第十三声"], factions: [], mapId: "world", gridX: 53, gridY: 42 },
      { id: "loc:4200", name: "钟楼档案室", parentLocationId: "loc:4103", description: "", rumors: [], factions: [], mapId: "loc:4103", gridX: 40, gridY: 60 },
    ],
    characters: [
      { id: "npc:chronicle-c1", name: "薇尔·星环", locationId: "loc:4103", thought: "想守住王都", actionTendency: "留在钟座", currentAction: "看钟", targetLocationId: null, presence: "present", positionSource: "narrative", mapId: "world", gridX: null, gridY: null },
      { id: "npc:chronicle-c2", name: "伊莱恩·莫尔", locationId: "loc:4101", thought: "北境的旧约", actionTendency: "等待第十三声", currentAction: "", targetLocationId: null, presence: "present", positionSource: "narrative", mapId: "world", gridX: null, gridY: null },
    ],
    items: [
      { id: "item:key", name: "铜钥匙", description: "小钥匙", locationId: "loc:4103", holderCharacterId: null, status: "完好", mapId: "world", gridX: null, gridY: null },
      { id: "item:lantern", name: "提灯", description: "", locationId: null, holderCharacterId: "npc:chronicle-c1", status: "", mapId: null, gridX: null, gridY: null },
    ],
  };
}

test("C03 上下文：位置链、附近地点、人物、物品、地图口径都在，且有界", () => {
  const tables = tableFixture();
  const maps = { schemaVersion: 2, pointMeta: {}, submaps: {}, calibrations: {} };
  const built = buildTableDeltaContext({ tables, world: demoWorld(), binding: BASE_BINDING, maps });

  assert.ok(built.text.includes("【当前位置】loc:4103=白塔钟座"), built.text);
  assert.ok(built.text.includes("loc:4200=钟楼档案室"), "子地点进附近");
  assert.ok(built.text.includes("loc:4101=雪线驿站"), "同父兄弟进附近");
  assert.ok(built.text.includes("npc:chronicle-c1=薇尔·星环"), "同地点人物带 ID");
  assert.ok(built.text.includes("npc:chronicle-c2=伊莱恩·莫尔"), "有行动倾向的远方人物也带上");
  assert.ok(built.text.includes("item:key=铜钥匙(在 loc:4103)"), "地面物品");
  assert.ok(built.text.includes("item:lantern=提灯(由 npc:chronicle-c1 持有)"), "持有物按持有人列出");
  assert.ok(built.text.includes("未标定（按格计算）"), "没有标定就如实写未标定");
  assert.ok(built.text.includes("【地点 id 对照】") && built.text.includes("【人物 id 对照】"));
  assert.deepEqual(built.truncated, { locations: 0, characters: 0, items: 0 });
  assert.ok(built.text.length <= 6000);
});

test("C03 上下文：比例尺来自标定；当前位置未知时不猜", () => {
  const tables = tableFixture();
  const maps = {
    schemaVersion: 2, pointMeta: {}, submaps: {},
    calibrations: { world: { revision: 1, metersPerCell: 12, source: "user", locked: true, basis: "人工", coverage: "", confidence: "high", at: 1 } },
  };
  const built = buildTableDeltaContext({ tables, world: demoWorld(), binding: BASE_BINDING, maps });
  assert.ok(built.text.includes("每格 12 米"), built.text);
  assert.ok(built.text.includes("人工锁定"));

  const unknown = buildTableDeltaContext({ tables, world: demoWorld(), binding: { ...BASE_BINDING, currentLocationId: null }, maps });
  assert.ok(unknown.text.includes("【当前位置】未知"), unknown.text);
});

test("C03 上下文：人物超上限时如实报截断数（不静默裁）", () => {
  const tables = tableFixture();
  const many = Array.from({ length: 60 }, (_, index) => ({
    ...tables.characters[1], id: `npc:extra-${index}`, name: `路人${index}`, locationId: "loc:4103",
  }));
  const built = buildTableDeltaContext({
    tables: { ...tables, characters: [...tables.characters, ...many] },
    world: demoWorld(), binding: BASE_BINDING, maps: null,
  });
  assert.ok(built.truncated.characters > 0, JSON.stringify(built.truncated));
  assert.ok(built.text.includes("【截断说明】"), "截断必须留痕");
});

test("C05 一次回合提交：人物移动落到三表与镜像，时间不推进（无显式时间词）", () => {
  const assistant = "你推开档案室的门，薇尔跟了进来。";
  const text = block(line({
    table: "character", op: "set", ref: "npc:chronicle-c1",
    patch: { locationRef: "loc:4200", thought: "档案室里有旧账" }, basis: "observed", quote: "薇尔跟了进来",
  }));
  const result = commitTableDeltaTurn({
    tables: tableFixture(), tablesDoc: null, branchKey: "canon",
    baseWorld: demoWorld(), binding: BASE_BINDING,
    request: { userText: "我进档案室。", assistantText: assistant },
    text, now: 1_700_000_000_000,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.receipt.status, "committed");
  assert.equal(result.receipt.previousTime, 100);
  assert.equal(result.receipt.currentTime, 100, "没有显式时间词就不推进时间");
  assert.equal(result.receipt.currentLocationId, "4200", "玩家位置跟随主角行");
  assert.equal(result.settled, true, "日程结算已在表路径内完成，公共段不得重复");
  assert.equal(result.applied, 1);

  const row = result.tablesDoc.branches.canon.characters.find((item) => item.id === "npc:chronicle-c1");
  assert.equal(row.locationId, "loc:4200");
  assert.equal(row.thought, "档案室里有旧账");
  const state = result.world.characterStates.find((item) => String(item.characterId) === "chronicle-c1");
  assert.equal(state.currentPointId, "4200", "兼容镜像跟上三表");
  assert.ok(result.receipt.summary.includes("应用 1 行"));
});

test("C05 时间只认用户文本里的显式时间词，不采信模型数字", () => {
  const text = block(line({ table: "character", op: "set", ref: "npc:chronicle-c1", patch: { thought: "待了一会儿" }, basis: "inferred" }));
  const result = commitTableDeltaTurn({
    tables: tableFixture(), tablesDoc: null, branchKey: "canon",
    baseWorld: demoWorld(), binding: BASE_BINDING,
    request: { userText: "我在档案室待了一会儿。", assistantText: "时间静静过去。" },
    text, now: 1,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.receipt.currentTime, 101, "「一会儿」= 1 段");
  assert.ok(result.receipt.summary.includes("时间推进 1 段"));
});

test("C05 拒绝语义：块不可用 / 零有效行都不动世界与时间", () => {
  const missing = commitTableDeltaTurn({
    tables: tableFixture(), tablesDoc: null, branchKey: "canon",
    baseWorld: demoWorld(), binding: BASE_BINDING,
    request: { userText: "我进档案室。", assistantText: "门开着。" },
    text: "本轮没有任何块", now: 1,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "PARSE_REJECTED");

  // 唯一的行引用了不存在的正式 id → 零有效行 → 整轮拒绝（§2 / T05）
  const zero = commitTableDeltaTurn({
    tables: tableFixture(), tablesDoc: null, branchKey: "canon",
    baseWorld: demoWorld(), binding: BASE_BINDING,
    request: { userText: "我进档案室。", assistantText: "门开着。" },
    text: block(line({ table: "character", op: "set", ref: "npc:ghost", patch: { thought: "X" }, basis: "inferred" })), now: 1,
  });
  assert.equal(zero.ok, false);
  assert.equal(zero.code, "DELTA_REJECTED");
  assert.ok(zero.rejectedRows.length >= 1);
});

test("C05 部分应用：一行成功一行失败时照常提交，回执写明拒绝行数", () => {
  const assistant = "薇尔留在钟座。";
  const text = block(
    line({ table: "character", op: "set", ref: "npc:chronicle-c1", patch: { thought: "守着钟" }, basis: "observed", quote: "薇尔留在钟座" }),
    line({ table: "location", op: "set", ref: "loc:404", patch: { description: "不存在的地点" } }),
  );
  const result = commitTableDeltaTurn({
    tables: tableFixture(), tablesDoc: null, branchKey: "canon",
    baseWorld: demoWorld(), binding: BASE_BINDING,
    request: { userText: "继续。", assistantText: assistant }, text, now: 1,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.applied, 1);
  assert.equal(result.rejected, 1);
  assert.ok(result.receipt.summary.includes("拒绝 1 行"), result.receipt.summary);
});

test("C06 跨场景移动按既有旅行规则推进时间，且只加码不低估", () => {
  const assistant = "你离开钟座，一路向北。";
  const text = block(line({
    table: "character", op: "set", ref: "npc:chronicle-c1",
    patch: { locationRef: "loc:4101" }, basis: "observed", quote: "一路向北",
  }));
  const request = { userText: "我出发去雪线驿站。", assistantText: assistant };

  // 没有时间词：时长完全由旅行规则给出（只可能 ≥ 0）
  const travel = commitTableDeltaTurn({
    tables: tableFixture(), tablesDoc: null, branchKey: "canon",
    baseWorld: demoWorld(), binding: BASE_BINDING, request, text, now: 1,
  });
  assert.equal(travel.ok, true, JSON.stringify(travel));
  assert.equal(travel.receipt.currentLocationId, "4101");
  assert.ok(travel.receipt.currentTime >= 100, "时间不得倒退");
  if (travel.receipt.currentTime > 100) {
    assert.ok(travel.receipt.summary.includes("跨场景"), travel.receipt.summary);
  }

  // 有时间词「一整天」= 4 段：旅程只能加码，不能低于时间词给出的下限
  const withWord = commitTableDeltaTurn({
    tables: tableFixture(), tablesDoc: null, branchKey: "canon",
    baseWorld: demoWorld(), binding: BASE_BINDING,
    request: { userText: "我花了一整天赶路去雪线驿站。", assistantText: assistant },
    text, now: 1,
  });
  assert.equal(withWord.ok, true, JSON.stringify(withWord));
  assert.ok(withWord.receipt.currentTime >= 104, `时间词下限必须被尊重：${withWord.receipt.currentTime}`);
  assert.ok(withWord.receipt.currentTime >= travel.receipt.currentTime, "同一趟路不会因为多写时间词而更短");
});

test("C05 主人公保护：模型不能借行增量改写主角名字", () => {
  const text = block(line({
    table: "character", op: "set", ref: "npc:chronicle-c1", patch: { name: "别人" }, basis: "observed", quote: "薇尔留在钟座",
  }));
  const result = commitTableDeltaTurn({
    tables: tableFixture(), tablesDoc: null, branchKey: "canon",
    baseWorld: demoWorld(), binding: BASE_BINDING,
    request: { userText: "继续。", assistantText: "薇尔留在钟座。" }, text, now: 1,
    protectedCharacterIds: new Set(["npc:chronicle-c1"]),
  });
  assert.equal(result.ok, false, "唯一一行被拒 → 整轮拒绝");
  assert.ok(JSON.stringify(result.rejectedRows).includes("PROTAGONIST_PROTECTED"));
});
