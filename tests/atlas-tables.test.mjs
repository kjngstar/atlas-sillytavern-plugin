/**
 * atlas-tables.test.mjs — A01 / A02 定向验收（三表纯数据层）。
 *
 * 计划 §3 A01：行类型、统一上限、位置判定；`validateAtlasTables` 返回 {ok,errors:[{path,code}]}，
 * 禁止 NaN、父地点不存在 / 成环、跨世界 ID、人物与物品悬空引用、持有人与地点同时存在。
 * 计划 §3 A02：`cloneAtlasTables` 深拷贝、不改输入、序列化稳定（供一致性比较）。
 *
 * 本文件只测纯函数，零 IO、零模型调用。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildWorldFromTemplate, getDemoTemplate } from "../lib/demo-events.ts";
import { parseWorld } from "../lib/world-schema.ts";
import { emptyMapDoc } from "../src/atlas-geo-apply.ts";
import {
  ATLAS_ITEM_DESTROYED_STATUS,
  ATLAS_TABLE_LIMITS,
  allocateTableRowId,
  applyCharacterEdit,
  applyItemEdit,
  applyLocationEdit,
  atlasTablesFingerprint,
  cloneAtlasTables,
  createAtlasRefScope,
  declareAtlasRef,
  resolveTableRef,
  validateAtlasTables,
  validateAtlasTablesStore,
} from "../src/atlas-tables.ts";
import { migrateLegacyToTables, tablesToLegacyWorld } from "../src/atlas-table-migration.ts";

const POSITION = { mapId: "world", gridX: 0, gridY: 0 };

function location(overrides = {}) {
  return {
    id: "loc:city", name: "临江城", parentLocationId: null, description: "城墙与码头",
    rumors: [], factions: [], ...POSITION, ...overrides,
  };
}

function character(overrides = {}) {
  return {
    id: "npc:keeper", name: "看守", locationId: null,
    thought: "担心巡逻", actionTendency: "留在钟楼", currentAction: "守门",
    targetLocationId: null, presence: "unknown", positionSource: "narrative",
    mapId: null, gridX: null, gridY: null, ...overrides,
  };
}

function item(overrides = {}) {
  return {
    id: "item:key", name: "铜钥匙", description: "小钥匙",
    locationId: null, holderCharacterId: null, status: "完好",
    mapId: null, gridX: null, gridY: null, ...overrides,
  };
}

function tables(overrides = {}) {
  return { locations: [], characters: [], items: [], ...overrides };
}

/** 断言：校验失败且错误里含指定 path+code。 */
function expectError(result, path, code) {
  assert.equal(result.ok, false, `应当校验失败（期望 ${path} ${code}）`);
  const hit = result.errors.some((e) => e.path === path && e.code === code);
  assert.ok(hit, `缺少错误 ${path} ${code}；实际：${JSON.stringify(result.errors)}`);
}

test("A01 空三表合法", () => {
  assert.deepEqual(validateAtlasTables(tables()), { ok: true, errors: [] });
});

test("A01 非对象输入不抛异常，报 STORE_NOT_OBJECT", () => {
  for (const bad of [null, undefined, 42, "x", []]) {
    const result = validateAtlasTables(bad);
    expectError(result, "$", "STORE_NOT_OBJECT");
  }
});

test("A01 根地点 mapId=world、子地点 mapId=父 id 合法", () => {
  const result = validateAtlasTables(tables({
    locations: [
      location(),
      location({ id: "loc:inn", name: "客栈", parentLocationId: "loc:city", mapId: "loc:city", gridX: 3, gridY: 4 }),
    ],
  }));
  assert.deepEqual(result, { ok: true, errors: [] }, JSON.stringify(result));
});

test("A01 地点 mapId 与父不符 / 根地点不是 world 均拒绝", () => {
  const child = validateAtlasTables(tables({
    locations: [
      location(),
      location({ id: "loc:inn", name: "客栈", parentLocationId: "loc:city", mapId: "world", gridX: 1, gridY: 1 }),
    ],
  }));
  expectError(child, "$.locations[1].mapId", "MAP_ID_MISMATCH");

  const root = validateAtlasTables(tables({
    locations: [location({ id: "loc:inn", name: "客栈", parentLocationId: null, mapId: "loc:city" })],
  }));
  expectError(root, "$.locations[0].mapId", "MAP_ID_MISMATCH");
});

test("A01 字段缺失 / 类型错 / 空名 / 超长文本", () => {
  const missing = validateAtlasTables(tables({
    locations: [{ id: "loc:a", name: "A", parentLocationId: null, rumors: [], factions: [], mapId: "world", gridX: null, gridY: null }],
  }));
  expectError(missing, "$.locations[0].description", "FIELD_MISSING");

  const wrongType = validateAtlasTables(tables({ locations: [location({ description: 7 })] }));
  expectError(wrongType, "$.locations[0].description", "FIELD_TYPE");

  const emptyName = validateAtlasTables(tables({ locations: [location({ name: "" })] }));
  expectError(emptyName, "$.locations[0].name", "NAME_REQUIRED");

  const tooLong = validateAtlasTables(tables({ locations: [location({ description: "字".repeat(ATLAS_TABLE_LIMITS.textChars + 1) })] }));
  expectError(tooLong, "$.locations[0].description", "TEXT_TOO_LONG");

  const longId = validateAtlasTables(tables({ locations: [location({ id: "x".repeat(ATLAS_TABLE_LIMITS.idChars + 1) })] }));
  expectError(longId, "$.locations[0].id", "ID_TOO_LONG");

  const emptyId = validateAtlasTables(tables({ locations: [location({ id: "" })] }));
  expectError(emptyId, "$.locations[0].id", "ID_MISSING");

  const notArray = validateAtlasTables({ locations: {}, characters: [], items: [] });
  expectError(notArray, "$.locations", "TABLE_NOT_ARRAY");

  const rowNotObject = validateAtlasTables(tables({ items: ["x"] }));
  expectError(rowNotObject, "$.items[0]", "ROW_NOT_OBJECT");
});

test("A01 行内数组条数与元素受限", () => {
  const tooMany = validateAtlasTables(tables({
    locations: [location({ rumors: Array.from({ length: ATLAS_TABLE_LIMITS.listItems + 1 }, (_, i) => `传闻${i}`) })],
  }));
  expectError(tooMany, "$.locations[0].rumors", "LIST_TOO_LONG");

  const badItem = validateAtlasTables(tables({ locations: [location({ factions: ["商会", 3] })] }));
  expectError(badItem, "$.locations[0].factions[1]", "LIST_ITEM_INVALID");
});

test("A01 重复 id 拒绝；名称可重名不拒绝", () => {
  const dup = validateAtlasTables(tables({
    locations: [location(), location({ id: "loc:city", name: "另一个临江城" })],
  }));
  expectError(dup, "$.locations[1].id", "DUPLICATE_ID");

  const sameName = validateAtlasTables(tables({
    locations: [
      location({ id: "loc:north", name: "钟楼" }),
      location({ id: "loc:south", name: "钟楼" }),
    ],
  }));
  assert.deepEqual(sameName, { ok: true, errors: [] }, JSON.stringify(sameName));
});

test("A01 父地点不存在 / 自引用 / 两点成环均拒绝", () => {
  const missing = validateAtlasTables(tables({
    locations: [location({ id: "loc:a", name: "A", parentLocationId: "loc:ghost", mapId: "loc:ghost" })],
  }));
  expectError(missing, "$.locations[0].parentLocationId", "PARENT_MISSING");

  const self = validateAtlasTables(tables({
    locations: [location({ id: "loc:a", name: "A", parentLocationId: "loc:a", mapId: "loc:a" })],
  }));
  expectError(self, "$.locations[0].parentLocationId", "PARENT_CYCLE");

  const ring = validateAtlasTables(tables({
    locations: [
      location({ id: "loc:a", name: "A", parentLocationId: "loc:b", mapId: "loc:b" }),
      location({ id: "loc:b", name: "B", parentLocationId: "loc:a", mapId: "loc:a" }),
    ],
  }));
  assert.equal(ring.ok, false);
  assert.equal(ring.errors.filter((e) => e.code === "PARENT_CYCLE").length, 2, JSON.stringify(ring.errors));
});

test("A01 格序号：NaN / 负数 / 小数拒绝，单边为空拒绝，双 null 合法", () => {
  for (const bad of [NaN, -1, 1.5, Infinity, "3"]) {
    const result = validateAtlasTables(tables({ locations: [location({ gridX: bad, gridY: 0 })] }));
    const code = typeof bad === "number" ? "GRID_INVALID" : "GRID_INVALID";
    expectError(result, "$.locations[0].gridX", code);
  }

  const half = validateAtlasTables(tables({ locations: [location({ gridX: 1, gridY: null })] }));
  expectError(half, "$.locations[0].gridX", "GRID_PARTIAL");

  const bothNull = validateAtlasTables(tables({ locations: [location({ gridX: null, gridY: null })] }));
  assert.deepEqual(bothNull, { ok: true, errors: [] }, JSON.stringify(bothNull));

  const missing = validateAtlasTables(tables({
    locations: [{ id: "loc:a", name: "A", parentLocationId: null, description: "d", rumors: [], factions: [], mapId: "world" }],
  }));
  expectError(missing, "$.locations[0].gridX", "FIELD_MISSING");
  expectError(missing, "$.locations[0].gridY", "FIELD_MISSING");
});

test("A01 人物悬空引用与枚举非法", () => {
  const dangling = validateAtlasTables(tables({ characters: [character({ locationId: "loc:ghost" })] }));
  expectError(dangling, "$.characters[0].locationId", "REF_MISSING");

  const danglingTarget = validateAtlasTables(tables({ characters: [character({ targetLocationId: "loc:ghost" })] }));
  expectError(danglingTarget, "$.characters[0].targetLocationId", "REF_MISSING");

  const badPresence = validateAtlasTables(tables({ characters: [character({ presence: "here" })] }));
  expectError(badPresence, "$.characters[0].presence", "PRESENCE_INVALID");

  const badSource = validateAtlasTables(tables({ characters: [character({ positionSource: "guess" })] }));
  expectError(badSource, "$.characters[0].positionSource", "POSITION_SOURCE_INVALID");

  const unknownMap = validateAtlasTables(tables({ characters: [character({ mapId: "loc:ghost" })] }));
  expectError(unknownMap, "$.characters[0].mapId", "MAP_ID_UNKNOWN");

  const ok = validateAtlasTables(tables({
    locations: [location()],
    characters: [character({ locationId: "loc:city", targetLocationId: "loc:city", presence: "present", mapId: "world", gridX: 1, gridY: 2 })],
  }));
  assert.deepEqual(ok, { ok: true, errors: [] }, JSON.stringify(ok));
});

test("A01 物品：持有人与地点互斥、持有物坐标必须置空、持有人必须存在", () => {
  const both = validateAtlasTables(tables({
    locations: [location()],
    characters: [character({ locationId: "loc:city" })],
    items: [item({ locationId: "loc:city", holderCharacterId: "npc:keeper" })],
  }));
  expectError(both, "$.items[0].holderCharacterId", "HOLDER_AND_LOCATION");

  const heldWithGrid = validateAtlasTables(tables({
    characters: [character()],
    items: [item({ holderCharacterId: "npc:keeper", gridX: 2, gridY: 2 })],
  }));
  expectError(heldWithGrid, "$.items[0].gridX", "HELD_ITEM_GRID");

  const ghostHolder = validateAtlasTables(tables({ items: [item({ holderCharacterId: "npc:ghost" })] }));
  expectError(ghostHolder, "$.items[0].holderCharacterId", "REF_MISSING");

  const onGround = validateAtlasTables(tables({
    locations: [location()],
    items: [item({ locationId: "loc:city", mapId: "world", gridX: 5, gridY: 6 })],
  }));
  assert.deepEqual(onGround, { ok: true, errors: [] }, JSON.stringify(onGround));
});

test("A01 行数超过上限拒绝（地点 1001 行）", () => {
  const many = Array.from({ length: ATLAS_TABLE_LIMITS.locations + 1 }, (_, i) =>
    location({ id: `loc:${i}`, name: `地点${i}` }));
  const result = validateAtlasTables(tables({ locations: many }));
  expectError(result, "$.locations", "ROWS_EXCEEDED");
});

test("A01 存储外壳：schemaVersion / worldId / 跨世界 / 分支错误路径", () => {
  const good = { schemaVersion: 1, worldId: "w1", branches: { b1: tables({ locations: [location()] }) } };
  assert.deepEqual(validateAtlasTablesStore(good), { ok: true, errors: [] });
  assert.deepEqual(validateAtlasTablesStore(good, { expectedWorldId: "w1" }), { ok: true, errors: [] });

  const badVersion = validateAtlasTablesStore({ ...good, schemaVersion: 2 });
  expectError(badVersion, "$.schemaVersion", "STORE_SCHEMA_VERSION");

  const noWorld = validateAtlasTablesStore({ ...good, worldId: "" });
  expectError(noWorld, "$.worldId", "WORLD_ID_MISSING");

  const crossWorld = validateAtlasTablesStore(good, { expectedWorldId: "w2" });
  expectError(crossWorld, "$.worldId", "CROSS_WORLD");

  const badBranch = validateAtlasTablesStore({ schemaVersion: 1, worldId: "w1", branches: { b1: 5 } });
  expectError(badBranch, '$.branches["b1"]', "BRANCH_NOT_OBJECT");

  // 分支内的行级错误带上分支前缀，回执能定位到具体分支
  const branchRow = validateAtlasTablesStore({
    schemaVersion: 1, worldId: "w1",
    branches: { b1: tables({ locations: [location({ description: "x".repeat(600) })] }) },
  });
  expectError(branchRow, '$.branches["b1"].locations[0].description', "TEXT_TOO_LONG");

  const notObject = validateAtlasTablesStore(null);
  expectError(notObject, "$", "STORE_NOT_OBJECT");
});

test("A02 cloneAtlasTables 深拷贝：改拷贝不影响输入，嵌套数组也独立", () => {
  const original = tables({
    locations: [location({ rumors: ["北门有兵"] })],
    characters: [character({ locationId: "loc:city" })],
    items: [item({ id: "item:key2" })],
  });
  const snapshot = JSON.parse(JSON.stringify(original));
  const clone = cloneAtlasTables(original);

  clone.locations[0].name = "改名";
  clone.locations[0].rumors.push("南门也戒严");
  clone.locations[0].gridX = 99;
  clone.characters[0].presence = "left";
  clone.items.push(item({ id: "item:new" }));

  assert.deepEqual(original, snapshot, "输入对象必须原样不变");
  assert.notEqual(clone.locations[0], original.locations[0], "行必须是新引用");
  assert.notEqual(clone.locations[0].rumors, original.locations[0].rumors, "数组必须是新引用");
});

test("A02 cloneAtlasTables 规范键序、保留未知字段", () => {
  const clone = cloneAtlasTables(tables({
    locations: [{ factions: [], gridY: null, name: "钟楼", id: "loc:tower", extraNote: "保留我", description: "d", rumors: [], parentLocationId: null, mapId: "world", gridX: null }],
  }));
  const keys = Object.keys(clone.locations[0]);
  assert.deepEqual(keys, ["id", "name", "parentLocationId", "description", "rumors", "factions", "mapId", "gridX", "gridY", "extraNote"]);
  assert.equal(clone.locations[0].extraNote, "保留我");
});

test("A02 指纹：行序无关、内容敏感", () => {
  const a = tables({
    locations: [location({ id: "loc:a", name: "A" }), location({ id: "loc:b", name: "B" })],
    characters: [character({ id: "npc:a" }), character({ id: "npc:b" })],
  });
  const reordered = tables({
    locations: [location({ id: "loc:b", name: "B" }), location({ id: "loc:a", name: "A" })],
    characters: [character({ id: "npc:b" }), character({ id: "npc:a" })],
  });
  assert.equal(atlasTablesFingerprint(a), atlasTablesFingerprint(reordered), "行序不同不应影响一致性判定");

  const changed = tables({
    locations: [location({ id: "loc:a", name: "A" }), location({ id: "loc:b", name: "B2" })],
    characters: [character({ id: "npc:a" }), character({ id: "npc:b" })],
  });
  assert.notEqual(atlasTablesFingerprint(a), atlasTablesFingerprint(changed), "内容变化必须反映到指纹");

  // 与 clone 的组合用法：先克隆再改，原指纹不变
  const before = atlasTablesFingerprint(a);
  const clone = cloneAtlasTables(a);
  clone.locations[0].description = "改了描述";
  assert.equal(atlasTablesFingerprint(a), before);
  assert.notEqual(atlasTablesFingerprint(clone), before);
});

/* ================================================================== *
 * A03：旧 world + maps → 三表迁移
 * ================================================================== */

const CHILD_POINT_ID = 4200;

/** 示例世界（chronicle：6 地点 / 4 人物 / 4 条人物状态）+ 一个子地点与三条实体记录。 */
function migrationWorld(extra = {}) {
  const raw = buildWorldFromTemplate(getDemoTemplate("chronicle"), { id: "w-mig", now: 1000 });
  const merged = {
    ...raw,
    points: [
      ...(raw.points ?? []),
      { id: CHILD_POINT_ID, name: "钟楼档案室", x: 5, y: 9, regionId: "capital", parentPointId: 4103 },
      ...(extra.points ?? []),
    ],
    entityRecords: [
      {
        id: "item-key", worldId: "w-mig", type: "item", name: "铜钥匙",
        baseline: { description: "小钥匙", status: "完好" },
        // lib 要求 baseline 的每个键都必须在 temporalSchema 里声明（kind=base）
        temporalSchema: [
          { key: "description", kind: "base", valueType: "string" },
          { key: "status", kind: "base", valueType: "string" },
        ],
        mapAnchor: { pointId: "4103", x: 53, y: 42 }, createdAt: 1,
      },
      {
        id: "item-lantern", worldId: "w-mig", type: "item", name: "提灯",
        baseline: { holderCharacterId: "chronicle-c1", description: "铜提灯" },
        temporalSchema: [
          { key: "holderCharacterId", kind: "base", valueType: "string" },
          { key: "description", kind: "base", valueType: "string" },
        ],
        createdAt: 1,
      },
      { id: "chronicle-c5", worldId: "w-mig", type: "npc", name: "门房", baseline: {}, temporalSchema: [], createdAt: 1 },
      // 三表不覆盖的实体类型（势力）：镜像必须原样透传，不得因三表投影而消失
      {
        id: "faction-ash", worldId: "w-mig", type: "faction", name: "灰烬商会",
        baseline: { seat: "capital" },
        temporalSchema: [{ key: "seat", kind: "base", valueType: "string" }],
        createdAt: 1,
      },
      ...(extra.entityRecords ?? []),
    ],
    characterStates: [...(raw.characterStates ?? []), ...(extra.characterStates ?? [])],
  };
  const parsed = parseWorld(JSON.parse(JSON.stringify(merged)));
  assert.ok(parsed, "迁移夹具世界可解析");
  return parsed;
}

/** sidecar：4103 有子图布局（子节点 4200 在 40/60），4103 有点位描述。 */
function migrationMaps() {
  const doc = emptyMapDoc();
  doc.submaps["4103"] = {
    parentMapId: "world",
    ownerLocationId: "4103",
    frame: { cols: 100, rows: 100, frameRevision: 1 },
    points: [{ id: String(CHILD_POINT_ID), name: "钟楼档案室", x: 40, y: 60 }],
  };
  doc.pointMeta["4103"] = { description: "白塔钟座内部，第十三声的回廊。" };
  return doc;
}

test("A03 地点：根地点零起始格序号、子地点进父图、描述来自 sidecar", () => {
  const { tables } = migrateLegacyToTables({ world: migrationWorld(), maps: migrationMaps(), branchId: null });
  const validation = validateAtlasTables(tables);
  assert.deepEqual(validation, { ok: true, errors: [] }, JSON.stringify(validation));

  const byId = new Map(tables.locations.map((row) => [row.id, row]));
  assert.equal(byId.size, 7, "6 个根地点 + 1 个子地点");

  // 画布单位即格：1 画布单位 = 1 格（lib 的 mapAnchor 0..100 与子图布局空间同口径）
  const origin = byId.get("loc:4101");
  assert.equal(origin.mapId, "world");
  assert.deepEqual([origin.gridX, origin.gridY], [20, 20]);
  assert.deepEqual([byId.get("loc:4103").gridX, byId.get("loc:4103").gridY], [53, 42]);
  assert.deepEqual([byId.get("loc:4106").gridX, byId.get("loc:4106").gridY], [82, 76]);

  const child = byId.get("loc:4200");
  assert.equal(child.parentLocationId, "loc:4103");
  assert.equal(child.mapId, "loc:4103", "子地点属于父地点的子图");
  assert.deepEqual([child.gridX, child.gridY], [40, 60], "子图布局的格空间直接用");

  assert.equal(byId.get("loc:4103").description, "白塔钟座内部，第十三声的回廊。");
  assert.equal(byId.get("loc:4101").description, "", "没有 sidecar 描述就是空串，不编造");
});

test("A03 人物：分支可见事实、有位置即在场、只精确到地点", () => {
  const { tables } = migrateLegacyToTables({ world: migrationWorld(), maps: migrationMaps(), branchId: null });
  const chars = new Map(tables.characters.map((row) => [row.id, row]));

  assert.equal(chars.size, 5, "4 个人物档案 + entityRecords 里的 npc 实体");
  const c1 = chars.get("npc:chronicle-c1");
  assert.equal(c1.locationId, "loc:4103");
  assert.equal(c1.mapId, "world");
  assert.equal(c1.presence, "present", "有已知位置即在场");
  assert.equal(c1.gridX, null, "人物只精确到地点，不猜格序号");
  assert.match(c1.currentAction, /持钥人/);
  assert.equal(c1.thought, "", "旧数据没有想法字段：留空，不用 status 冒充");
  assert.equal(c1.positionSource, "unknown", "state 来源不是叙事推演");
  assert.ok(chars.has("npc:chronicle-c5"), "type=npc 的实体记录也进人物表");
});

test("A03 人物：IF 分支覆盖不污染正史（branchId 过滤）", () => {
  const world = migrationWorld({
    characterStates: [{
      characterId: "chronicle-c1", currentRegionId: "north", currentPointId: "4102",
      status: "IF 分支里的持钥人", updatedAt: 5, branchId: "if-1",
    }],
  });
  const canon = migrateLegacyToTables({ world, maps: migrationMaps(), branchId: null });
  assert.equal(canon.tables.characters.find((row) => row.id === "npc:chronicle-c1").locationId, "loc:4103");

  const branch = migrateLegacyToTables({ world, maps: migrationMaps(), branchId: "if-1" });
  assert.equal(branch.tables.characters.find((row) => row.id === "npc:chronicle-c1").locationId, "loc:4102");
});

test("A03 物品：地面物品带坐标、持有物位置置空、npc 实体不进物品表", () => {
  const { tables } = migrateLegacyToTables({ world: migrationWorld(), maps: migrationMaps(), branchId: null });
  const items = new Map(tables.items.map((row) => [row.id, row]));
  assert.equal(items.size, 2);

  const key = items.get("item:item-key");
  assert.equal(key.locationId, "loc:4103");
  assert.equal(key.mapId, "world");
  assert.deepEqual([key.gridX, key.gridY], [53, 42]);
  assert.equal(key.status, "完好");
  assert.equal(key.holderCharacterId, null);

  const lantern = items.get("item:item-lantern");
  assert.equal(lantern.holderCharacterId, "npc:chronicle-c1");
  assert.equal(lantern.locationId, null, "持有物不写地点");
  assert.equal(lantern.mapId, null);
  assert.equal(lantern.gridX, null);
  assert.equal(lantern.gridY, null);

  assert.equal(items.has("item:chronicle-c5"), false, "npc 实体不是物品");
});

test("A03 迁移幂等：同一输入两次迁移结果完全一致", () => {
  const first = migrateLegacyToTables({ world: migrationWorld(), maps: migrationMaps(), branchId: null });
  const second = migrateLegacyToTables({ world: migrationWorld(), maps: migrationMaps(), branchId: null });
  assert.deepEqual(first.tables, second.tables);
  assert.equal(atlasTablesFingerprint(first.tables), atlasTablesFingerprint(second.tables));
  assert.deepEqual(first.warnings, second.warnings);
});

test("A03 警告：父不可用保留为根、子图缺布局留空坐标、文本截断", () => {
  const world = migrationWorld({
    points: [
      { id: 4300, name: "孤儿地点", x: 100, y: 30, regionId: "north", parentPointId: 9999 },
      { id: 4301, name: "无布局内层", x: 40, y: 40, regionId: "capital", parentPointId: 4104 },
    ],
  });
  const maps = migrationMaps();
  maps.pointMeta["4105"] = { description: "长".repeat(ATLAS_TABLE_LIMITS.textChars + 120) };

  const { tables, warnings } = migrateLegacyToTables({ world, maps, branchId: null });
  const codes = warnings.map((item) => item.code);
  assert.ok(codes.includes("POINT_PARENT_UNKNOWN"), JSON.stringify(warnings));
  assert.ok(codes.includes("SUBMAP_LAYOUT_MISSING"), JSON.stringify(warnings));
  assert.ok(codes.includes("TEXT_TRUNCATED"), JSON.stringify(warnings));
  assert.deepEqual(validateAtlasTables(tables), { ok: true, errors: [] });

  const byId = new Map(tables.locations.map((row) => [row.id, row]));
  assert.equal(byId.get("loc:4300").parentLocationId, null, "父不可用不丢地点，保留为根");
  assert.equal(byId.get("loc:4300").mapId, "world");
  assert.equal(byId.get("loc:4301").mapId, "loc:4104");
  assert.equal(byId.get("loc:4301").gridX, null, "拿不到子图布局就保留位置未知");
  assert.equal(byId.get("loc:4105").description.length, ATLAS_TABLE_LIMITS.textChars);
});

/* ================================================================== *
 * A04：三表 → 旧 World 兼容镜像
 * ================================================================== */

/** 迁移 → 镜像的公共装配。 */
function mirrorFixture(extra = {}) {
  const world = migrationWorld(extra.world);
  const maps = migrationMaps();
  const migrated = migrateLegacyToTables({ world, maps, branchId: null });
  const mirror = tablesToLegacyWorld({ tables: migrated.tables, world, branchId: null });
  return { world, maps, tables: migrated.tables, mirror };
}

test("A04 镜像：地点/人物/物品投影成合法 World（parseWorld 必须通过）", () => {
  const { world, tables, mirror } = mirrorFixture();

  // 镜像是给现有引擎读的，必须仍是合法世界——否则 lib 解析失败等于旧档损坏
  const parsed = parseWorld(JSON.parse(JSON.stringify(mirror.world)));
  assert.ok(parsed, "镜像世界必须能通过 parseWorld");

  const points = new Map(mirror.world.points.map((point) => [point.id, point]));
  assert.equal(points.size, 7);
  const tower = points.get(4103);
  assert.equal(tower.name, "白塔钟座");
  assert.deepEqual([tower.x, tower.y], [53, 42], "格序号 1:1 还原为画布坐标");
  assert.equal(tower.regionId, "capital", "基底世界的地区归属原样保留");
  const child = points.get(CHILD_POINT_ID);
  assert.equal(child.parentPointId, 4103, "父子链进镜像，子图投影才能工作");
  // D-20：子地点在世界图上与父地点重合（它的格序号是「父图布局空间」的坐标，
  // 直接当世界画布坐标写会造出假的跨城距离）。子图内的位置由 sidecar 投影负责。
  assert.deepEqual([child.x, child.y], [tower.x, tower.y], "子地点世界坐标 = 父地点坐标");

  const states = new Map(mirror.world.characterStates.map((state) => [String(state.characterId), state]));
  const c1 = states.get("chronicle-c1");
  assert.equal(c1.currentPointId, "4103");
  assert.equal(c1.currentRegionId, "capital");
  assert.match(c1.status, /持钥人/);
  assert.equal(c1.branchId, null, "正史基线写 null");

  const records = new Map(mirror.world.entityRecords.map((record) => [String(record.id), record]));
  assert.ok(records.has("faction-ash"), "三表不覆盖的实体必须透传");
  const key = records.get("item-key");
  assert.equal(key.type, "item");
  assert.equal(key.baseline.description, "小钥匙");
  assert.equal(key.baseline.status, "完好");
  assert.deepEqual(key.temporalSchema.map((field) => field.key), ["description", "status"], "baseline 的键必须已声明");
  assert.deepEqual(key.mapAnchor, { pointId: "4103", x: 53, y: 42 });
  assert.equal("holderCharacterId" in key.baseline, false, "持有关系不进镜像（决定 D-02）");
  const lantern = records.get("item-lantern");
  assert.equal(lantern.mapAnchor, undefined, "持有物没有地图锚点");
  assert.ok(records.has("chronicle-c5"), "没有档案的人物用 npc 实体登记");
  assert.equal(records.get("chronicle-c5").type, "npc");

  // 人物档案是作者资产：本函数不改写
  assert.deepEqual(mirror.world.characters, world.characters);
  assert.equal(tables.items.length, 2);
});

test("A04 往返：world → 三表 → 镜像 → 三表 是不动点", () => {
  const { world, maps, tables, mirror } = mirrorFixture();
  const again = migrateLegacyToTables({ world: mirror.world, maps, branchId: null });

  assert.deepEqual(again.tables.locations, tables.locations, "地点（含格序号与父子）逐字一致");
  assert.deepEqual(again.tables.characters, tables.characters, "人物位置/在场/状态一致");

  // 已知损失（决定 D-02）：持有关系不进镜像，第二次迁移得到「无人持有的地面物品」
  const stripHolder = (rows) => rows.map(({ holderCharacterId, ...rest }) => ({ ...rest, holderCharacterId: null }));
  assert.deepEqual(stripHolder(again.tables.items), stripHolder(tables.items));
});

test("A04 警告：离场者不写位置、位置未知不静默造坐标、超限截断记账", () => {
  const { world } = mirrorFixture();
  const base = migrateLegacyToTables({ world, maps: migrationMaps(), branchId: null }).tables;

  // (1) presence=left：CharacterState 没有 presence 字段 → 不写位置并记警告
  const leftTables = cloneAtlasTables(base);
  leftTables.characters[0].presence = "left";
  const leftMirror = tablesToLegacyWorld({ tables: leftTables, world, branchId: null });
  const leftState = leftMirror.world.characterStates.find((s) => String(s.characterId) === "chronicle-c1");
  assert.equal(leftState.currentPointId, undefined, "离场者不能写成「还在这」");
  assert.ok(leftMirror.warnings.some((w) => w.code === "PRESENCE_NOT_MIRRORED"));

  // (2) 三表里的新地点在基底世界没有坐标：落在 (0,0) 但必须留痕
  const newTables = cloneAtlasTables(base);
  newTables.locations.push({
    id: "loc:5001", name: "新码头", parentLocationId: null, description: "",
    rumors: [], factions: [], mapId: "world", gridX: null, gridY: null,
  });
  const newMirror = tablesToLegacyWorld({ tables: newTables, world, branchId: null });
  const fresh = newMirror.world.points.find((point) => point.id === 5001);
  assert.deepEqual([fresh.x, fresh.y], [0, 0]);
  assert.ok(newMirror.warnings.some((w) => w.code === "POSITION_DERIVED" && w.path === "loc:5001"));

  // (3) 人物超限：镜像只放 lib 允许的条数，且必须记账
  const many = cloneAtlasTables(base);
  while (many.characters.length <= 500) {
    const index = many.characters.length;
    many.characters.push({
      id: `npc:extra-${index}`, name: `路人${index}`, locationId: null, thought: "", actionTendency: "",
      currentAction: "", targetLocationId: null, presence: "unknown", positionSource: "unknown",
      mapId: null, gridX: null, gridY: null,
    });
  }
  const cappedMirror = tablesToLegacyWorld({ tables: many, world, branchId: null });
  assert.ok(cappedMirror.warnings.some((w) => w.code === "MIRROR_ROWS_TRUNCATED"));
  assert.ok(cappedMirror.world.characterStates.length <= 500 + (world.characterStates?.length ?? 0));
  assert.ok(parseWorld(JSON.parse(JSON.stringify(cappedMirror.world))), "超限截断后镜像仍必须合法");
});

/* ================================================================== *
 * B01–B04：编辑操作、引用解析与三表变更
 * ================================================================== */

test("B04 引用解析：本块临时引用可用，未声明 / 跨类型 / 不存在各有具名错误", () => {
  const t = tables();
  const scope = createAtlasRefScope();

  const unknown = resolveTableRef(t, scope, "new:loc:1", "location");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "REF_UNKNOWN");

  const cross = resolveTableRef(t, scope, "new:npc:keeper", "location");
  assert.equal(cross.ok, false);
  assert.equal(cross.error.code, "REF_TYPE_MISMATCH");

  const garbage = resolveTableRef(t, scope, "钟楼", "location");
  assert.equal(garbage.error.code, "REF_INVALID", "名称不是 id");

  declareAtlasRef(scope, "location", "new:loc:1", "loc:7");
  assert.equal(resolveTableRef(t, scope, "new:loc:1", "location").id, "loc:7");

  const missing = resolveTableRef(t, scope, "loc:99", "location");
  assert.equal(missing.error.code, "ROW_NOT_FOUND");
  t.locations.push(location({ id: "loc:9" }));
  assert.equal(resolveTableRef(t, scope, "loc:9", "location").id, "loc:9");
});

test("B04 分配：失败行不占号、new: 引用绝不复用已有行身份", () => {
  const t = tables({
    locations: [location({ id: "loc:4106" })],
    characters: [character({ id: "npc:keeper" })],
  });
  assert.equal(allocateTableRowId(t, "location", "new:loc:1").id, "loc:4107");
  assert.equal(allocateTableRowId(t, "location", "new:loc:2").id, "loc:4107", "分配是候选表的纯函数：失败不占号");

  const clash = allocateTableRowId(t, "character", "new:npc:keeper");
  assert.equal(clash.ok, true);
  assert.equal(clash.id, "npc:keeper-2", "同名临时引用必须拿新身份，绝不复用旧行");

  const badPattern = allocateTableRowId(t, "item", "new:item:Bad Slug");
  assert.equal(badPattern.ok, false);
  assert.equal(badPattern.error.code, "REF_INVALID");
});

test("B01 地点 add：根 / 子、同父同名歧义、不同父同名放行、引用错误分型", () => {
  const t = tables();
  const scope = createAtlasRefScope();

  const root = applyLocationEdit(t, { table: "location", op: "add", ref: "new:loc:1", name: "临江城" }, scope);
  assert.equal(root.ok, true, JSON.stringify(root));
  assert.equal(root.id, "loc:1");
  assert.equal(t.locations[0].mapId, "world");
  assert.deepEqual([t.locations[0].gridX, t.locations[0].gridY], [null, null], "AI 不能写坐标");

  const inn = applyLocationEdit(t, { table: "location", op: "add", ref: "new:loc:2", name: "客栈", parentRef: "new:loc:1" }, scope);
  assert.equal(inn.ok, true);
  assert.equal(t.locations[1].parentLocationId, "loc:1");
  assert.equal(t.locations[1].mapId, "loc:1", "子地点进父地点的子图");

  const duplicate = applyLocationEdit(t, { table: "location", op: "add", ref: "new:loc:3", name: "客栈", parentRef: "new:loc:1" }, scope);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.code, "DUPLICATE_SIBLING_NAME");

  const sameNameElsewhere = applyLocationEdit(t, { table: "location", op: "add", ref: "new:loc:4", name: "客栈" }, scope);
  assert.equal(sameNameElsewhere.ok, true, "不同父下的同名地点不合并、也不算歧义");

  const missingParent = applyLocationEdit(t, { table: "location", op: "add", ref: "new:loc:5", name: "X", parentRef: "loc:99" }, scope);
  assert.equal(missingParent.error.code, "ROW_NOT_FOUND");
  const crossRef = applyLocationEdit(t, { table: "location", op: "add", ref: "new:loc:6", name: "Y", parentRef: "new:npc:keeper" }, scope);
  assert.equal(crossRef.error.code, "REF_TYPE_MISMATCH");

  assert.deepEqual(validateAtlasTables(t), { ok: true, errors: [] });
});

test("B01 深度上限 4 跳与换父成环", () => {
  const t = tables();
  const scope = createAtlasRefScope();
  let parentRef = null;
  for (let depth = 0; depth <= 4; depth += 1) {
    const res = applyLocationEdit(t, {
      table: "location", op: "add", ref: `new:loc:${depth + 1}`, name: `L${depth}`,
      ...(parentRef === null ? {} : { parentRef }),
    }, scope);
    assert.equal(res.ok, true, `第 ${depth} 层应可建：${JSON.stringify(res)}`);
    parentRef = `new:loc:${depth + 1}`;
  }
  const tooDeep = applyLocationEdit(t, { table: "location", op: "add", ref: "new:loc:9", name: "L5", parentRef: "new:loc:5" }, scope);
  assert.equal(tooDeep.ok, false);
  assert.equal(tooDeep.error.code, "PARENT_DEPTH_EXCEEDED", "第 5 张子图必须拒绝");

  const cycle = applyLocationEdit(t, { table: "location", op: "set", ref: "new:loc:1", patch: { parentRef: "new:loc:5" } }, scope);
  assert.equal(cycle.ok, false);
  assert.equal(cycle.error.code, "PARENT_CYCLE", "祖先不能挂到自己的后代下");
  assert.deepEqual(validateAtlasTables(t), { ok: true, errors: [] });
});

test("B01 set/remove：换父清坐标、删有子地点拒绝、删地点就地撤离引用", () => {
  const t = tables({
    locations: [
      location({ id: "loc:1", name: "临江城" }),
      location({ id: "loc:2", name: "客栈", parentLocationId: "loc:1", mapId: "loc:1", gridX: 5, gridY: 6 }),
    ],
    characters: [character({ id: "npc:a", locationId: "loc:2", mapId: "loc:1", presence: "present" })],
    items: [item({ id: "item:x", locationId: "loc:2", mapId: "loc:1" })],
  });
  const scope = createAtlasRefScope();

  const hasChildren = applyLocationEdit(t, { table: "location", op: "remove", ref: "loc:1" }, scope);
  assert.equal(hasChildren.error.code, "HAS_CHILDREN", "绝不级联删子地点");

  const reparent = applyLocationEdit(t, { table: "location", op: "set", ref: "loc:2", patch: { parentRef: null } }, scope);
  assert.equal(reparent.ok, true, JSON.stringify(reparent));
  const inn = t.locations.find((row) => row.id === "loc:2");
  assert.equal(inn.mapId, "world");
  assert.deepEqual([inn.gridX, inn.gridY], [null, null], "换父后旧格序号属于旧父图，必须失效");

  const removed = applyLocationEdit(t, { table: "location", op: "remove", ref: "loc:2" }, scope);
  assert.equal(removed.ok, true);
  assert.equal(t.characters[0].locationId, null, "人物就地撤离，不级联删人");
  assert.equal(t.items[0].locationId, null);
  assert.deepEqual(validateAtlasTables(t), { ok: true, errors: [] }, "撤离后候选不能留悬空引用");
});

test("B02 人物 add/set：位置改 mapId、坐标留空、四字段互不冒充", () => {
  const t = tables({
    locations: [
      location({ id: "loc:1" }),
      location({ id: "loc:2", name: "客栈", parentLocationId: "loc:1", mapId: "loc:1" }),
    ],
  });
  const scope = createAtlasRefScope();

  const added = applyCharacterEdit(t, { table: "character", op: "add", ref: "new:npc:keeper", name: "看守" }, scope);
  assert.equal(added.ok, true);
  assert.equal(added.id, "npc:keeper");
  assert.equal(t.characters[0].presence, "unknown", "没有位置就不假装在场");
  assert.equal(t.characters[0].mapId, null);

  const seated = applyCharacterEdit(t, { table: "character", op: "add", ref: "new:npc:smith", name: "铁匠", locationRef: "loc:2" }, scope);
  assert.equal(seated.ok, true);
  const smith = t.characters.find((row) => row.id === "npc:smith");
  assert.equal(smith.locationId, "loc:2");
  assert.equal(smith.mapId, "loc:1", "mapId = 该地点所在的图");
  assert.deepEqual([smith.gridX, smith.gridY], [null, null], "人物只精确到地点");
  assert.equal(smith.presence, "present");

  const setThought = applyCharacterEdit(t, {
    table: "character", op: "set", ref: "npc:smith",
    patch: { thought: "想把剑打好", actionTendency: "留在客栈" },
  }, scope);
  assert.equal(setThought.ok, true);
  assert.equal(smith.thought, "想把剑打好");
  assert.equal(smith.currentAction, "", "想法不冒充当前行动");

  const moved = applyCharacterEdit(t, { table: "character", op: "set", ref: "npc:smith", patch: { locationRef: "loc:1" } }, scope);
  assert.equal(moved.ok, true);
  assert.equal(smith.locationId, "loc:1");
  assert.equal(smith.mapId, "world");
  assert.equal(smith.positionSource, "narrative");
  assert.deepEqual(validateAtlasTables(t), { ok: true, errors: [] });
});

test("B02 主人公保护：名称与整行不可被模型改写，想法允许更新；普通人物 remove = 撤离", () => {
  const t = tables({ characters: [character({ id: "npc:hero", name: "主角", locationId: null, mapId: null })] });
  const scope = createAtlasRefScope();
  const options = { protectedCharacterIds: new Set(["npc:hero"]) };

  const rename = applyCharacterEdit(t, { table: "character", op: "set", ref: "npc:hero", patch: { name: "别人" } }, scope, options);
  assert.equal(rename.ok, false);
  assert.equal(rename.error.code, "PROTAGONIST_PROTECTED");

  const thought = applyCharacterEdit(t, { table: "character", op: "set", ref: "npc:hero", patch: { thought: "他在想事情" } }, scope, options);
  assert.equal(thought.ok, true, "想法 / 行动倾向不是身份，允许更新");

  const removed = applyCharacterEdit(t, { table: "character", op: "remove", ref: "npc:hero" }, scope, options);
  assert.equal(removed.error.code, "PROTAGONIST_PROTECTED");

  const other = tables({ characters: [character({ id: "npc:a", locationId: null, mapId: null })] });
  const left = applyCharacterEdit(other, { table: "character", op: "remove", ref: "npc:a" }, createAtlasRefScope());
  assert.equal(left.ok, true);
  assert.equal(other.characters[0].presence, "left");
  assert.equal(other.characters.length, 1, "撤离不删行");
});

test("B03 物品：地点与持有人互斥、转交清理旧归属、销毁是软删除", () => {
  const t = tables({
    locations: [location({ id: "loc:1" })],
    characters: [
      character({ id: "npc:a", locationId: "loc:1", mapId: "world", presence: "present" }),
      character({ id: "npc:b", locationId: "loc:1", mapId: "world", presence: "present" }),
    ],
  });
  const scope = createAtlasRefScope();

  const ground = applyItemEdit(t, { table: "item", op: "add", ref: "new:item:key", name: "铜钥匙", locationRef: "loc:1" }, scope);
  assert.equal(ground.ok, true, JSON.stringify(ground));
  assert.equal(ground.id, "item:key");
  const key = t.items[0];
  assert.equal(key.locationId, "loc:1");
  assert.equal(key.holderCharacterId, null);
  assert.equal(key.mapId, "world");

  const taken = applyItemEdit(t, { table: "item", op: "set", ref: "new:item:key", patch: { holderRef: "npc:a" } }, scope);
  assert.equal(taken.ok, true);
  assert.equal(key.holderCharacterId, "npc:a");
  assert.equal(key.locationId, null, "归人时必须清地点");
  assert.equal(key.mapId, null, "持有物不当地面图钉");

  const handed = applyItemEdit(t, { table: "item", op: "set", ref: "item:key", patch: { holderRef: "npc:b" } }, scope);
  assert.equal(handed.ok, true);
  assert.equal(key.holderCharacterId, "npc:b", "转交后旧持有人被清掉");

  const both = applyItemEdit(t, { table: "item", op: "set", ref: "item:key", patch: { locationRef: "loc:1", holderRef: "npc:a" } }, scope);
  assert.equal(both.error.code, "HOLDER_AND_LOCATION");

  const dropped = applyItemEdit(t, { table: "item", op: "set", ref: "item:key", patch: { holderRef: null } }, scope);
  assert.equal(dropped.ok, true);
  assert.equal(key.holderCharacterId, null);
  assert.equal(key.locationId, null, "放下但没给地点：位置未知，不猜原地");

  const destroyed = applyItemEdit(t, { table: "item", op: "remove", ref: "item:key" }, scope);
  assert.equal(destroyed.ok, true);
  assert.equal(key.status, ATLAS_ITEM_DESTROYED_STATUS);
  assert.equal(t.items.length, 1, "软删除保留行");
  assert.deepEqual(validateAtlasTables(t), { ok: true, errors: [] });
});

test("B04 同块重复声明同一临时引用：拒绝且不留半行", () => {
  const t = tables();
  const scope = createAtlasRefScope();
  const first = applyLocationEdit(t, { table: "location", op: "add", ref: "new:loc:1", name: "甲" }, scope);
  assert.equal(first.ok, true);
  const again = applyLocationEdit(t, { table: "location", op: "add", ref: "new:loc:1", name: "乙" }, scope);
  assert.equal(again.ok, false);
  assert.equal(again.error.code, "REF_INVALID");
  assert.equal(t.locations.length, 1, "失败行不得留下第二行");
  assert.equal(t.locations[0].name, "甲");
});
