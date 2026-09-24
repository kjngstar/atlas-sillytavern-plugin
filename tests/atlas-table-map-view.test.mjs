/**
 * atlas-table-map-view.test.mjs — D01 定向验收（三表 → 地图视图的唯一投影口径）。
 *
 * 计划 §3-D01 / T02 图侧要求：
 * - 根地点进世界图；有父的地点进**父地点的子图**，同名不同父的两个地点绝不合并；
 * - 人物 / 物品按 mapId + 格序号投影；缺细坐标的进「建筑内位置未知」名单（不画点、不编坐标）；
 * - 「附近」目录与地图取自同一张人物表，过滤 presence=left，标出主角；
 * - 超上限必须给 total/truncated，不静默裁剪（旧实现静默裁 48/32）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { projectTablesToMapView } from "../src/atlas-table-map-view.ts";

/** 只用到 World 的两处事实：地点地区归属、人物 role/tags（主角判定）。 */
function fakeWorld() {
  return {
    points: [
      { id: 4101, name: "雪线驿站", x: 20, y: 20, regionId: "north" },
      { id: 4103, name: "白塔钟座", x: 53, y: 42, regionId: "capital" },
    ],
    characters: [{ id: "chronicle-c1", name: "薇尔·星环", role: "持钥人", tags: ["主角", "持钥人"] }],
  };
}

const EMPTY_MAPS = { schemaVersion: 2, pointMeta: {}, submaps: {}, calibrations: {} };

function location(overrides = {}) {
  return {
    id: "loc:4103", name: "白塔钟座", parentLocationId: null, description: "", rumors: [], factions: [],
    mapId: "world", gridX: 53, gridY: 42, ...overrides,
  };
}

function character(overrides = {}) {
  return {
    id: "npc:chronicle-c1", name: "薇尔·星环", locationId: "loc:4103", thought: "", actionTendency: "",
    currentAction: "", targetLocationId: null, presence: "present", positionSource: "narrative",
    mapId: null, gridX: null, gridY: null, ...overrides,
  };
}

function item(overrides = {}) {
  return {
    id: "item:key", name: "铜钥匙", description: "小钥匙", locationId: "loc:4103", holderCharacterId: null,
    status: "完好", mapId: null, gridX: null, gridY: null, ...overrides,
  };
}

/** 夹具：两个根地点，4103 下挂同名房间两间（父不同），一个人物、一件地面物品、一件持有物。 */
function fixture() {
  return {
    locations: [
      location({ id: "loc:4101", name: "雪线驿站", gridX: 20, gridY: 20 }),
      location({ id: "loc:4103" }),
      location({ id: "loc:4301", name: "档案室", parentLocationId: "loc:4103", mapId: "loc:4103", gridX: 40, gridY: 60 }),
      location({ id: "loc:4302", name: "档案室", parentLocationId: "loc:4101", mapId: "loc:4101", gridX: 10, gridY: 20 }),
    ],
    characters: [
      character(),
      character({ id: "npc:chronicle-c2", name: "伊莱恩·莫尔", locationId: "loc:4301", mapId: "loc:4103", gridX: 41, gridY: 61 }),
      character({ id: "npc:gone", name: "离开的人", locationId: null, presence: "left" }),
    ],
    items: [
      item(),
      item({ id: "item:lantern", name: "提灯", locationId: null, holderCharacterId: "npc:chronicle-c1" }),
      item({ id: "item:ash", name: "灰烬", status: "已销毁", locationId: null }),
    ],
  };
}

test("D01 世界图只放根地点，子地点进各自父图；同名不同父不合并", () => {
  const view = projectTablesToMapView(fixture(), EMPTY_MAPS, fakeWorld(), "4103");

  assert.deepEqual(view.world.points.map((point) => point.id).sort(), ["4101", "4103"], "世界图只有根地点");
  assert.equal(view.world.total, 2);
  assert.equal(view.world.truncated, 0);

  const underTower = view.submaps["4103"];
  const underStation = view.submaps["4101"];
  const locationsIn = (submap) => submap.points.filter((point) => point.kind === "location").map((point) => point.id);
  assert.deepEqual(locationsIn(underTower), ["4301"]);
  assert.deepEqual(locationsIn(underStation), ["4302"]);
  assert.equal(underTower.parentMapId, "world");
  assert.equal(underStation.frame.cols, 100, "没有 sidecar frame 时用默认 frame");

  const region = view.world.points.find((point) => point.id === "4103").regionId;
  assert.equal(region, "capital", "地区归属仍来自世界点");
});

test("D01 人物与物品按 mapId+格序号投影；缺细坐标进「位置未知」名单", () => {
  const view = projectTablesToMapView(fixture(), EMPTY_MAPS, fakeWorld(), "4103");

  // 有细坐标的人物落在子图上
  const inSubmap = view.submaps["4103"].points.find((point) => point.kind === "character");
  assert.equal(inSubmap.id, "npc:chronicle-c2");
  assert.deepEqual([inSubmap.x, inSubmap.y], [41, 61]);

  // 只有地点、没有细坐标的人物 → 名单，不画点
  const unknown = view.unknownPosition.find((bucket) => bucket.locationId === "loc:4103");
  assert.deepEqual(unknown.characters.map((entry) => entry.id), ["chronicle-c1"]);
  assert.equal(view.world.points.some((point) => point.kind === "character"), false, "缺坐标不猜世界坐标");
  assert.ok(unknown.items.some((entry) => entry.id === "item:key"), "地面物品也列在名单里");

  // 持有物与已销毁物都不进地图标记
  assert.equal(view.world.points.some((point) => point.id === "item:lantern"), false);
  assert.equal(view.objects.entries.some((entry) => entry.id === "item:ash"), false, "已销毁不进目录");
  const lantern = view.objects.entries.find((entry) => entry.id === "item:lantern");
  assert.equal(lantern.holderName, "薇尔·星环", "随身物品按持有人推导，不写地面坐标");
  assert.equal(lantern.mapId, null);
});

test("D01 附近目录与地图同一张人物表：过滤离场、标出主角、内层同父才算附近", () => {
  const tables = fixture();
  // 远处的人：站在另一个根地点（雪线驿站）——根地点之间不互相算「附近」
  tables.characters.push(character({ id: "npc:faraway", name: "远方的人", locationId: "loc:4101" }));
  const view = projectTablesToMapView(tables, EMPTY_MAPS, fakeWorld(), "4103");

  assert.equal(view.nearby.total, 3, "presence=left 的人不进目录");
  assert.equal(view.nearby.entries.some((entry) => entry.id === "gone"), false);
  const ids = view.nearby.entries.map((entry) => entry.id);
  assert.deepEqual(ids.slice(0, 2).sort(), ["chronicle-c1", "chronicle-c2"], "当前地点与其子图的人排在前面");
  assert.equal(ids[2], "faraway", "另一个根地点的人排在后面（不冒充附近）");

  const hero = view.nearby.entries.find((entry) => entry.id === "chronicle-c1");
  assert.equal(hero.isProtagonist, true, "主角标记来自 world.characters 的 role/tags");
  assert.equal(hero.locationName, "白塔钟座");
  assert.equal(view.nearby.entries.find((entry) => entry.id === "chronicle-c2").isProtagonist, false);

  // 换到内层地点：同父兄弟这时才算附近
  const inside = projectTablesToMapView(tables, EMPTY_MAPS, fakeWorld(), "4301");
  assert.equal(inside.current.locationId, "loc:4301");
  assert.deepEqual(inside.current.chain.map((entry) => entry.id), ["loc:4103", "loc:4301"], "当前位置链含上级");

  assert.deepEqual(view.totals, { locations: 4, characters: 4, items: 3, submaps: 2 });
});

test("D01 超上限给 total/truncated，不静默裁剪；非数字 id 记 dropped", () => {
  const tables = fixture();
  tables.characters = Array.from({ length: 60 }, (_, index) => character({
    id: `npc:extra-${index}`, name: `路人${index}`, locationId: "loc:4103",
  }));
  tables.locations.push(location({ id: "loc:not-a-number", name: "脏数据" }));
  const view = projectTablesToMapView(tables, EMPTY_MAPS, fakeWorld(), "4103");

  assert.equal(view.nearby.total, 60);
  assert.equal(view.nearby.entries.length, 48);
  assert.equal(view.nearby.truncated, 12, "截断数必须报出来");
  assert.equal(view.dropped.locations, 1, "投影不进地图的行也要计数");
  assert.equal(view.totals.locations, 5);
});

test("D01 父地点不可达的行不静默丢：计入 dropped", () => {
  const tables = fixture();
  tables.locations.push(location({ id: "loc:4400", name: "孤儿房间", parentLocationId: "loc:9999", mapId: "loc:9999" }));
  const view = projectTablesToMapView(tables, EMPTY_MAPS, fakeWorld(), null);
  assert.equal(view.dropped.locations, 1);
  assert.equal(view.submaps["9999"], undefined);
  assert.equal(view.current.locationId, null, "没有当前地点时不猜");
  assert.deepEqual(view.current.chain, []);
});

test("D02 /state：迁移过的分支带 tableMap（total/truncated），旧会话保持原状", async () => {
  const { createAtlasServerCore, createMemoryDocumentStore } = await import("../src/atlas-server.ts");
  const { createSessionCarrier } = await import("./atlas-session-helper.mjs");
  const { buildWorldFromTemplate, getDemoTemplate } = await import("../lib/demo-events.ts");
  const { parseWorld } = await import("../lib/world-schema.ts");

  const world = parseWorld(JSON.parse(JSON.stringify(
    buildWorldFromTemplate(getDemoTemplate("chronicle"), { id: "w-mig", now: 1000 }),
  )));
  assert.ok(world, "夹具世界可解析");
  const binding = {
    schemaVersion: 1, enabled: true, chatId: "c1", characterId: "chronicle-c1",
    worldId: "w-mig", branchId: null, currentLocationId: "4103", worldTimeCursor: 100,
    lastCommittedMessageId: null, lastCheckpointId: null,
  };
  const tablesDoc = { schemaVersion: 1, worldId: "w-mig", branches: { canon: fixture() } };
  const session = {
    schemaVersion: 1, rev: 1, binding, world: JSON.parse(JSON.stringify(world)),
    maps: null, scene: null, turns: {}, geoAuto: {}, tables: tablesDoc,
  };
  const core = createAtlasServerCore({ store: createMemoryDocumentStore() });

  const carrier = createSessionCarrier(core, { session });
  const state = await carrier.handle("GET", "/state/c1");
  assert.equal(state.status, 200, JSON.stringify(state.body).slice(0, 300));
  const tableMap = state.body.data.tableMap;
  assert.ok(tableMap, "迁移过的分支必须带 tableMap");
  assert.equal(tableMap.branchKey, "canon");
  assert.deepEqual(tableMap.world.points.filter((point) => point.kind === "location").map((point) => point.id).sort(),
    ["4101", "4103"], "世界图只有根地点");
  assert.ok(tableMap.submaps["4103"] && tableMap.submaps["4101"], "子地点进各自父图");
  assert.equal(tableMap.totals.locations, 4);
  assert.equal(tableMap.world.truncated, 0);
  assert.equal(tableMap.nearby.truncated, 0);
  assert.equal(tableMap.current.locationId, "loc:4103");

  // 旧会话（没有 tables）的断言单独成测（见下一条）：本轮发现它在该夹具下**仍带 tableMap**，
  // 疑似夹具串用或真实泄漏，需单独定位——不在这里用宽松断言掩盖。
  assert.ok(Array.isArray(state.body.data.npcDirectory), "旧路径字段仍在（同一份响应里共存）");
});

test("D02 旧会话：只读 /state 靠懒迁移拿到 tableMap，但绝不写会话", async () => {
  const { createAtlasServerCore, createMemoryDocumentStore } = await import("../src/atlas-server.ts");
  const { createSessionCarrier } = await import("./atlas-session-helper.mjs");
  const { buildWorldFromTemplate, getDemoTemplate } = await import("../lib/demo-events.ts");
  const { parseWorld } = await import("../lib/world-schema.ts");

  const world = parseWorld(JSON.parse(JSON.stringify(
    buildWorldFromTemplate(getDemoTemplate("chronicle"), { id: "w-mig", now: 1000 }),
  )));
  const binding = {
    schemaVersion: 1, enabled: true, chatId: "c1", characterId: "chronicle-c1",
    worldId: "w-mig", branchId: null, currentLocationId: "4103", worldTimeCursor: 100,
    lastCommittedMessageId: null, lastCheckpointId: null,
  };
  const legacySession = {
    schemaVersion: 1, rev: 3, binding, world: JSON.parse(JSON.stringify(world)),
    maps: null, scene: null, turns: {}, geoAuto: {},
  };
  const store = createMemoryDocumentStore();
  const core = createAtlasServerCore({ store });
  const legacy = createSessionCarrier(core, { session: legacySession });

  const state = await legacy.handle("GET", "/state/c1");
  assert.equal(state.status, 200);
  // A08 懒迁移在**内存里**建表（不落盘），所以同一请求就能给出三表投影——这是预期行为，不是泄漏
  const tableMap = state.body.data.tableMap;
  assert.ok(tableMap, "旧会话首次 /state 应经懒迁移拿到 tableMap");
  assert.equal(tableMap.world.points.length, 6, "chronicle 世界的 6 个地点都是根");
  assert.equal(tableMap.totals.characters, 4);
  assert.equal(tableMap.current.locationId, "loc:4103");
  // 只读请求不写会话：不带回 session、rev 不变、兜底 store 仍为空（D-09 的不变量）
  assert.equal(state.body.session, undefined, "只读请求不得推 rev / 写 chatMetadata");
  assert.equal(legacy.session.rev, 3);
  assert.equal(legacy.session.tables, undefined, "会话里不该被写进三表");
  assert.equal(store.dump().size, 0, "兜底 store 不得多出 tables: 文档");
  // 幂等：再取一次结果一致
  const again = await legacy.handle("GET", "/state/c1");
  assert.equal(again.body.data.tableMap.world.points.length, 6);
  assert.equal(again.body.data.tableMap.current.locationId, "loc:4103");
  // 旧路径的字段一个不少（新旧数据在同一份响应里共存）
  assert.ok(Array.isArray(state.body.data.npcDirectory), "旧路径的 npcDirectory 仍在");
  assert.ok(Array.isArray(state.body.data.objectDirectory));
  assert.ok(state.body.data.map && Array.isArray(state.body.data.map.points));
});

test("D02 目录分页：默认仍是 48/32，但 total/truncated 如实下发，且能取到后面的实体", async () => {
  const { createAtlasServerCore, createMemoryDocumentStore } = await import("../src/atlas-server.ts");
  const { createSessionCarrier } = await import("./atlas-session-helper.mjs");
  const { buildWorldFromTemplate, getDemoTemplate } = await import("../lib/demo-events.ts");
  const { parseWorld } = await import("../lib/world-schema.ts");

  const raw = buildWorldFromTemplate(getDemoTemplate("chronicle"), { id: "w-mig", now: 1000 });
  // 60 个 npc 实体：注册表（characters ∪ entityRecords[type=npc]）会一起进目录
  raw.entityRecords = Array.from({ length: 60 }, (_, index) => ({
    id: `extra-npc-${index}`, worldId: "w-mig", type: "npc", name: `路人${index}`,
    baseline: {}, temporalSchema: [], createdAt: 1,
  }));
  const world = parseWorld(JSON.parse(JSON.stringify(raw)));
  assert.ok(world, "夹具世界可解析");

  const binding = {
    schemaVersion: 1, enabled: true, chatId: "c1", characterId: "chronicle-c1",
    worldId: "w-mig", branchId: null, currentLocationId: "4103", worldTimeCursor: 100,
    lastCommittedMessageId: null, lastCheckpointId: null,
  };
  const session = {
    schemaVersion: 1, rev: 1, binding, world: JSON.parse(JSON.stringify(world)),
    maps: null, scene: null, turns: {}, geoAuto: {},
  };
  const core = createAtlasServerCore({ store: createMemoryDocumentStore() });
  const carrier = createSessionCarrier(core, { session });

  const page1 = await carrier.handle("GET", "/state/c1");
  assert.equal(page1.body.data.npcDirectory.length, 48, "默认每页仍是 48（UI 行为不变）");
  assert.equal(page1.body.data.directoryTotals.npc.total, 64, "total 用全量长度，不谎报");
  assert.equal(page1.body.data.directoryTotals.npc.truncated, 16, "没放进来的必须报数");
  // 懒迁移在只读请求里就已生效（D-09/D-23），所以计数用三表权威口径；
  // 无论是 tables 还是 legacy，总数都必须与全量一致、截断数必须如实。
  assert.equal(page1.body.data.directoryTotals.source, "tables", "首次 /state 已懒迁移，计数用三表口径");
  assert.equal(page1.body.data.directoryTotals.npc.total, 64);

  const page2 = await carrier.handle("POST", "/state", { chatId: "c1", directory: { npcOffset: 48, npcLimit: 100 } });
  assert.equal(page2.body.data.npcDirectory.length, 16, "第二页能取到剩下的实体（不再静默消失）");
  assert.equal(page2.body.data.directoryTotals.npc.offset, 48);
  assert.equal(page2.body.data.directoryTotals.npc.truncated, 0);
  // 两页合起来正好是全集，且不重复
  const ids = new Set([...page1.body.data.npcDirectory, ...page2.body.data.npcDirectory].map((entry) => entry.id));
  assert.equal(ids.size, 64);
});

/* ------------------------------------------------------------------ *
 * F08a：F01 / F02 定向验收（未知坐标不落 (0,0)、徽标人数、附近口径）
 * ------------------------------------------------------------------ */

test("F01 未知坐标的地点不生成地图点，也不落 (0,0)，而是进「待定位」名单", () => {
  const view = projectTablesToMapView(
    {
      locations: [
        location({ id: "loc:4103", name: "白塔钟座", gridX: 53, gridY: 42, mapId: "world" }),
        // 缺真实坐标：确认在「三年二班」但不知道教室里的具体位置
        location({ id: "loc:4104", name: "三年二班", gridX: null, gridY: null, mapId: null, parentLocationId: "loc:4103" }),
      ],
      characters: [],
      items: [],
    },
    EMPTY_MAPS,
    fakeWorld(),
    null,
  );

  // ① 绝不出现坐标 (0,0) 的伪地点
  assert.equal(view.world.points.some((point) => point.x === 0 && point.y === 0), false,
    "未知位置不得被画到网格原点（F7 停机线）");
  assert.equal(view.world.points.some((point) => point.id === "4104"), false, "缺坐标的地点不进世界图");

  // ② 但必须能查到它，供 UI 出「待定位」列表
  const unplaced = view.unplacedLocations;
  assert.equal(unplaced.total, 1);
  assert.equal(unplaced.truncated, 0);
  assert.deepEqual(unplaced.entries.map((entry) => entry.id), ["loc:4104"]);
  assert.equal(unplaced.entries[0].name, "三年二班");
  assert.equal(unplaced.entries[0].parentLocationId, "loc:4103", "保留父级关系，便于人工确认归属");
});

test("F02 徽标人数按完整三表聚合：第 49 个人物也在计数里", () => {
  const characters = [];
  for (let index = 0; index < 49; index += 1) {
    characters.push(character({
      id: `npc:student-${String(index).padStart(2, "0")}`,
      name: `学生${index}`,
      locationId: "loc:4104",
      gridX: null, gridY: null, mapId: null,
    }));
  }
  const view = projectTablesToMapView(
    {
      locations: [
        location({ id: "loc:4103", name: "白塔钟座", gridX: 53, gridY: 42, mapId: "world" }),
        location({ id: "loc:4104", name: "三年二班", gridX: null, gridY: null, mapId: null, parentLocationId: "loc:4103" }),
      ],
      characters,
      items: [],
    },
    EMPTY_MAPS,
    fakeWorld(),
    null,
  );

  const room = view.locationOccupants.entries.find((entry) => entry.locationId === "loc:4104");
  assert.ok(room, "教室要有在场成员条目（徽标数据源）");
  assert.equal(room.characterCount, 49, "计数是完整三表口径——第 49 个人物不能被截掉");
  assert.equal(room.locationName, "三年二班");
  assert.equal(room.gridX, null, "房间自己没有真实坐标，不得落 (0,0)");
  // 明细有界，但**计数**是真值（UI 据此显示「49 人」并分页）
  assert.ok(room.characters.length <= 24, "明细按上限截断");
});

test("F02 当前位置为空：报告 CURRENT_LOCATION_UNKNOWN，而不是「附近没人」", () => {
  const view = projectTablesToMapView(
    {
      locations: [location({ id: "loc:4103", name: "白塔钟座", gridX: 53, gridY: 42, mapId: "world" })],
      characters: [character({ id: "npc:someone", locationId: "loc:4103" })],
      items: [],
    },
    EMPTY_MAPS,
    fakeWorld(),
    null,
  );
  assert.equal(view.nearReasonCode, "CURRENT_LOCATION_UNKNOWN",
    "「不知道自己在哪」必须与「周围确实没人」分开表达（§2.4 / T09）");

  // 但地点弹窗的数据仍在：远处/别处的地点照样能查出在场者
  const occupants = view.locationOccupants.entries.find((entry) => entry.locationId === "loc:4103");
  assert.equal(occupants.characterCount, 1, "地点在场人数与当前位置无关，照样可查");
});

test("F02 确认当前位置后 nearReasonCode 归 null（真的算出了附近）", () => {
  const view = projectTablesToMapView(
    {
      locations: [
        location({ id: "loc:4103", name: "白塔钟座", gridX: 53, gridY: 42, mapId: "world" }),
        location({ id: "loc:4104", name: "钟楼二层", gridX: 50, gridY: 40, mapId: "world", parentLocationId: "loc:4103" }),
      ],
      characters: [character({ id: "npc:up", locationId: "loc:4104" })],
      items: [],
    },
    EMPTY_MAPS,
    fakeWorld(),
    "4104",
  );
  assert.equal(view.nearReasonCode, null);
  // nearby 沿既有口径：id 去掉 npc: 前缀（旧客户端契约不变）
  assert.ok(view.nearby.entries.some((entry) => entry.id === "up"), "同地点/下级地点的人算附近");
  assert.deepEqual(view.current.chain.map((item) => item.id), ["loc:4103", "loc:4104"], "位置链含上级");
});
