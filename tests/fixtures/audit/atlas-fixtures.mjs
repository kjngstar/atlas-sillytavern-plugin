/**
 * atlas-fixtures.mjs — R00 验收夹具（不含私人聊天）。
 *
 * 计划书 §6 R00 要求的四套夹具：
 * 1. 空世界开局（starter world，无剧情）
 * 2. 截图式废墟相遇（开局文本「羽风站在废墟深处。一名未报姓名的少女正在他身旁。」）
 * 3. 已有多 NPC 世界（多人物多地点，含账本事件）
 * 4. 多层子图带底图（点 + 子图引用 + 底图 dataURL 占位）
 *
 * 全部为纯数据构造，不依赖网络与随机；供 R05–R13 验收测试复用。
 */

import { buildStarterWorld } from "../../../src/atlas-starter-world.ts";
import { atlasCommitIdempotencyKey } from "../../../src/atlas-contract.ts";

const NOW = 1758600000000; // 固定时间戳，保证确定性

/** 1) 空世界开局：只有起点占位 + 主角实体，无任何剧情事件。 */
export function fixtureEmptyWorld() {
  return { world: buildStarterWorld({ id: "fx-empty", now: NOW, name: "空世界" }), now: NOW };
}

/** 2) 截图式废墟相遇：世界仍是起点，剧情文本已把玩家写在废墟深处。 */
export function fixtureRuinsEncounter() {
  const world = buildStarterWorld({ id: "fx-ruins", now: NOW, name: "废墟相遇" });
  return {
    world,
    now: NOW,
    conversation: {
      userText: "环顾四周",
      assistantText: "羽风站在废墟深处。一名未报姓名的少女正在他身旁。",
      expected: {
        newLocationName: "废墟深处",
        newCharacterDisplayName: "未具名少女",
        sceneTransition: "initial",
      },
    },
  };
}

/** 3) 已有多 NPC 世界：3 个地点 + 3 个 NPC + 账本移动事件。 */
export function fixtureMultiNpcWorld() {
  const world = buildStarterWorld({ id: "fx-multi", now: NOW, name: "多NPC世界" });
  world.points.push(
    { id: 2, name: "市集", x: 70, y: 40, regionId: "start" },
    { id: 3, name: "城门", x: 30, y: 70, regionId: "start" },
  );
  world.characters.push(
    { id: "npc-merchant", worldId: world.id, name: "商贩", role: "配角", description: "市集上的小贩。", currentRegionId: "start" },
    { id: "npc-guard", worldId: world.id, name: "守卫", role: "配角", description: "驻守城门。", currentRegionId: "start" },
    { id: "npc-girl", worldId: world.id, name: "少女", role: "配角", description: "身份不明。", currentRegionId: "start" },
  );
  return { world, now: NOW };
}

/** 4) 多层子图带底图：世界图 → 建筑子图 → 房间，附 1×1 dataURL 底图占位。 */
export function fixtureMultiLayerWorld() {
  const world = buildStarterWorld({ id: "fx-layers", now: NOW, name: "多层世界" });
  world.points.push(
    { id: 2, name: "酒馆", x: 60, y: 60, regionId: "start" },
    { id: 3, name: "吧台", x: 40, y: 40, regionId: "start" },
  );
  // 最小合法 1×1 透明 PNG（43 字节），不引外部资源
  const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  world.mapImage = { imageDataUrl: pixel, revision: 1 };
  return { world, now: NOW, submaps: [{ id: "sub-tavern", name: "酒馆内部", parentPointId: 2, points: [3] }] };
}

/* ================================================================== *
 * A01 —— 可重放审计夹具（计划 §3 阶段 A01，2026-09-25 追加）
 *
 * 场景覆盖（全部纯数据构造：确定性、零网络、零随机，node 可直接 import）：
 *  1. fixtureTurnZeroCarriage()    第 0 段：蒸汽马车厢（含「车厢内部」子地点）里两个人，
 *                                  玩家位置未知（binding.currentLocationId = null），时间游标 0，无已提交回合。
 *  2. fixtureSharedCardChats()     A / B 两个聊天共用同一张角色卡（同一 cardId）：
 *                                  A 有 5 地点 + 2 人物 + 1 件物品；B 是全新聊天（空三表 / 空地图 / 空推演）。
 *  3. fixtureSchoolHierarchy()     学校 → 三年二班 的父子层级；确认在教室但无室内细坐标（gridX/Y = null）。
 *  4. fixtureSaintLaurentCity()    圣罗兰城（世界图城市入口）+ 圣罗兰工厂区 / 圣罗兰奴隶市场（城市 contained 子地点）
 *                                  + 圣罗兰外城区（adjacent，**不写 parent**）。
 *  5. fixtureSaintLaurentPending() T19 负例：只有地名、没有归属 / 边界 / 距离证据 → parent = null、待确认、不染色。
 *  6. fixtureVehicleMove()         载具（蒸汽马车厢）移动：停靠 → 在途，两名乘员随车，不各自生成世界坐标。
 *  7. fixtureDistantDeclaration()  远方宣战信号：一份 signal + 发起地 / 目击 delivery；工厂的人在 0/1 时段都未获知。
 *  8. fixtureIfBranch()            IF 分支：正史有宣战信号与标定，IF 只有自己的分支键，不含正史未来事实。
 *  9. fixtureSwipeVariant()        swipe：同一 userMessageId 的两个助手变体，幂等键（= turnKey）不同、事实不同。
 * 10. fixtureScaleHundredMeters()  标尺 100 米/格：世界图已标定、教室图未标定，固定 96px 标尺的期望数值。
 *
 * 身份可区分：每个夹具都带 identity = { scenario, chatIds, worldIds, branchIds, branchKeys,
 * messageIds, locationRowIds, mapIds, mapKeys }；fixtureReplayCatalog() 汇总全部夹具，
 * collectFixtureIdentityIds() 拍平成按类别分组的 id 列表，供测试断言「chatId / worldId / 消息 ID /
 * branchId / 分支键 / 地点行 ID / 图键（worldId|mapId）各自互不相同」。
 *
 * 纪律：夹具只**只读地**构造数据，不经过编辑管线、不碰 src、不改现有真实聊天；
 * 三表行字段与 src/atlas-tables.ts 的 AtlasLocationRow / AtlasCharacterRow / AtlasItemRow 对齐，
 * 可用 validateAtlasTables 直接校验。推演块按计划 §2.1 就地构造（C01 的 src/atlas-simulation.ts
 * 落地稳定后，这里应改为 import 真实类型 / 空模块构造器，见 atlas-session-helper.mjs 的同款说明）。
 * ================================================================== */

/* ---------------- 只读构造器（夹具内部使用，不导出） ---------------- */

function fixtureLocation({ id, name, parentLocationId = null, description = "", rumors = [], factions = [], mapId = "world", gridX = null, gridY = null }) {
  return { id, name, parentLocationId, description, rumors, factions, mapId, gridX, gridY };
}

function fixtureCharacter({ id, name, locationId = null, thought = "", actionTendency = "", currentAction = "", targetLocationId = null, presence = "present", positionSource = "narrative", mapId = null, gridX = null, gridY = null }) {
  return { id, name, locationId, thought, actionTendency, currentAction, targetLocationId, presence, positionSource, mapId, gridX, gridY };
}

function fixtureItem({ id, name, description = "", locationId = null, holderCharacterId = null, status = "", mapId = null, gridX = null, gridY = null }) {
  return { id, name, description, locationId, holderCharacterId, status, mapId, gridX, gridY };
}

function fixtureTableDoc(worldId, branchKey, { locations = [], characters = [], items = [] } = {}) {
  return { schemaVersion: 1, worldId, branches: { [branchKey]: { locations, characters, items } } };
}

function fixtureMapsDoc({ pointMeta = {}, submaps = {}, calibrations = {} } = {}) {
  return { schemaVersion: 2, pointMeta, submaps, calibrations };
}

function fixtureBinding({ chatId, worldId, currentLocationId = null, worldTimeCursor = 0, branchId = null, characterId = "char-main" }) {
  return {
    schemaVersion: 1, enabled: true, chatId, characterId, worldId, branchId,
    currentLocationId, worldTimeCursor, lastCommittedMessageId: null, lastCheckpointId: null,
  };
}

function fixtureSession({ rev = 1, binding, world, maps = null, tables = null, simulation = null, turns = {}, scene = null }) {
  return { schemaVersion: 1, rev, binding, world, maps, scene, turns, geoAuto: {}, tables, simulation };
}

function fixtureCalibration({ metersPerCell, source = "user", locked = true, basis = "", coverage = "", confidence = "high", revision = 1 }) {
  return { revision, metersPerCell, source, locked, basis, coverage, confidence, at: NOW };
}

/** §2.1 的推演模块：C01 落地前由夹具就地构造，字段名与 §2.1 一字不差。 */
function fixtureSimulation(worldId, branchKey, branch = {}) {
  return {
    schemaVersion: 1,
    worldId,
    branches: {
      [branchKey]: {
        tasks: [], signals: [], deliveries: [],
        geoTopology: { edges: [], areas: [], vehicles: [] },
        ...branch,
      },
    },
  };
}

/** 汇总某夹具里出现过的全部身份 id（供「互相可区分」断言使用）。 */
function fixtureIdentity({ scenario, chatIds, worldIds, branchIds = [], branchKeys = [], messageIds = [], locationRowIds = [], mapIds = [] }) {
  return {
    scenario,
    chatIds: [...chatIds],
    worldIds: [...worldIds],
    branchIds: branchIds.filter((value) => value !== null && value !== undefined),
    branchKeys: branchKeys.map((key, index) => `${worldIds[index % worldIds.length]}|${key}`),
    messageIds: [...messageIds],
    locationRowIds: [...locationRowIds],
    mapIds: [...mapIds],
    mapKeys: mapIds.map((mapId, index) => `${worldIds[index % worldIds.length]}|${mapId}`),
  };
}

function mergeIdentities(scenario, ...parts) {
  const merged = fixtureIdentity({ scenario, chatIds: [], worldIds: [], mapIds: [] });
  for (const part of parts) {
    merged.chatIds.push(...part.chatIds);
    merged.worldIds.push(...part.worldIds);
    merged.branchIds.push(...part.branchIds);
    merged.branchKeys.push(...part.branchKeys);
    merged.messageIds.push(...part.messageIds);
    merged.locationRowIds.push(...part.locationRowIds);
    merged.mapIds.push(...part.mapIds);
    merged.mapKeys.push(...part.mapKeys);
  }
  return merged;
}

/** 1) 第 0 段：蒸汽马车厢里两个人，玩家位置未知。 */
export function fixtureTurnZeroCarriage() {
  const scenario = "t0-carriage";
  const chatId = "chat-t0-carriage";
  const worldId = "world-t0-carriage";
  const branchKey = "canon";
  const carriage = "loc:7001";  // 移动载具本体：世界图上没有确认格坐标
  const cabin = "loc:7002";     // 车厢内部：parentLocationId = 车厢
  const station = "loc:7003";   // 当前停靠点：有确认格坐标
  const world = buildStarterWorld({ id: worldId, now: NOW, name: "蒸汽马车厢" });
  // 兼容镜像（world）保留示意排版坐标；三表 gridX/Y 仍为 null（§2.5 / H06a）
  world.points.push(
    { id: 7001, name: "蒸汽马车厢", x: 48, y: 52, regionId: "start" },
    { id: 7003, name: "城门车站", x: 52, y: 48, regionId: "start" },
  );
  world.characters.push(
    { id: "carriage-driver", worldId, name: "车夫", role: "配角", description: "赶车的人。", currentRegionId: "start" },
    { id: "carriage-passenger", worldId, name: "同行乘客", role: "配角", description: "坐在车厢里的人。", currentRegionId: "start" },
  );
  world.currentRegionId = "start";
  world.characterStates = [
    { characterId: "carriage-driver", currentRegionId: "start", currentPointId: "7002", status: "在车厢里", updatedAt: NOW },
    { characterId: "carriage-passenger", currentRegionId: "start", currentPointId: "7002", status: "在车厢里", updatedAt: NOW },
  ];

  const tables = fixtureTableDoc(worldId, branchKey, {
    locations: [
      fixtureLocation({ id: carriage, name: "蒸汽马车厢", description: "停靠中的移动载具。", mapId: "world" }),
      fixtureLocation({ id: cabin, name: "车厢内部", parentLocationId: carriage, description: "两个人坐在里面。", mapId: carriage }),
      fixtureLocation({ id: station, name: "城门车站", description: "车厢此刻停靠的车站。", mapId: "world", gridX: 52, gridY: 48 }),
    ],
    characters: [
      fixtureCharacter({ id: "npc:carriage-driver", name: "车夫", locationId: cabin, thought: "等客人上车", actionTendency: "守着车厢", currentAction: "整理缰绳" }),
      fixtureCharacter({ id: "npc:carriage-passenger", name: "同行乘客", locationId: cabin, thought: "先不出声", actionTendency: "观察车夫" }),
    ],
    items: [
      fixtureItem({ id: "item:carriage-bag", name: "行囊", description: "塞在座位下。", locationId: cabin }),
    ],
  });

  const maps = fixtureMapsDoc({
    pointMeta: {
      "7001": { description: "移动载具，停靠时挂在车站。" },
      "7002": { description: "车厢内部。" },
    },
    submaps: {
      "7001": {
        parentMapId: "world",
        ownerLocationId: "7001",
        frame: { cols: 100, rows: 100, frameRevision: 1 },
        points: [{ id: "7002", name: "车厢内部", x: 50, y: 50, description: "两个人坐着的位置未知" }],
      },
    },
  });

  const binding = fixtureBinding({ chatId, worldId, currentLocationId: null, worldTimeCursor: 0 });
  const messages = {
    userMessageId: "msg-t0-carriage-u1",
    assistantMessageId: "msg-t0-carriage-a1",
    assistantText: "车厢轻轻晃了一下。车夫没有回头，乘客也没有说话。",
  };
  return {
    scenario,
    now: NOW,
    chatId,
    worldId,
    branchId: null,
    branchKey,
    mapIds: ["world", carriage],
    world,
    tables,
    maps,
    binding,
    /** 第 0 段：尚无提交回合；simulation 缺失 = 合法空模块（旧会话语义）。 */
    simulation: null,
    turns: {},
    messages,
    session: fixtureSession({ binding, world, maps, tables, simulation: null, turns: {} }),
    identity: fixtureIdentity({
      scenario, chatIds: [chatId], worldIds: [worldId], branchKeys: [branchKey],
      messageIds: [messages.userMessageId, messages.assistantMessageId],
      locationRowIds: [carriage, cabin, station],
      mapIds: ["world", carriage],
    }),
  };
}

/** 2) A / B 两个聊天共用同一张角色卡。 */
export function fixtureSharedCardChats() {
  const scenario = "shared-card-AB";
  const cardId = "card-saint-laurent";
  const link = "chat-card-A";
  const seen = "chat-card-B";
  const linkWorld = "world-card-A";
  const seenWorld = "world-card-B";

  const chatA = (() => {
    const world = buildStarterWorld({ id: linkWorld, now: NOW, name: "圣罗兰编年史" });
    world.points.push(
      { id: 101, name: "圣罗兰城门", x: 40, y: 55, regionId: "start" },
      { id: 102, name: "奴隶市场", x: 30, y: 60, regionId: "start" },
      { id: 103, name: "工厂区", x: 66, y: 44, regionId: "start" },
      { id: 104, name: "老钟楼", x: 55, y: 35, regionId: "start" },
    );
    world.characters.push(
      { id: "gate-guard", worldId: linkWorld, name: "城门守卫", role: "配角", description: "守在城门。", currentRegionId: "start" },
      { id: "factory-foreman", worldId: linkWorld, name: "工厂领班", role: "配角", description: "在工厂区。", currentRegionId: "start" },
    );
    const tables = fixtureTableDoc(linkWorld, "canon", {
      locations: [
        fixtureLocation({ id: "loc:101", name: "圣罗兰城门", gridX: 40, gridY: 55 }),
        fixtureLocation({ id: "loc:102", name: "奴隶市场", gridX: 30, gridY: 60 }),
        fixtureLocation({ id: "loc:103", name: "工厂区", gridX: 66, gridY: 44 }),
        fixtureLocation({ id: "loc:104", name: "老钟楼", gridX: 55, gridY: 35 }),
        fixtureLocation({ id: "loc:105", name: "城门哨塔", parentLocationId: "loc:101", mapId: "loc:101" }),
      ],
      characters: [
        fixtureCharacter({ id: "npc:gate-guard", name: "城门守卫", locationId: "loc:101", thought: "夜里风大", actionTendency: "守门" }),
        fixtureCharacter({ id: "npc:factory-foreman", name: "工厂领班", locationId: "loc:103", thought: "机器又坏了", actionTendency: "催工" }),
      ],
      items: [fixtureItem({ id: "item:gate-lantern", name: "城门提灯", description: "挂在哨塔上。", locationId: "loc:105" })],
    });
    const maps = fixtureMapsDoc({
      pointMeta: { "101": { description: "城市入口。" }, "105": { description: "哨塔内部。" } },
      submaps: {
        "101": {
          parentMapId: "world", ownerLocationId: "101",
          frame: { cols: 100, rows: 100, frameRevision: 1 },
          points: [{ id: "105", name: "城门哨塔", x: 10, y: 10 }],
        },
      },
      calibrations: { world: fixtureCalibration({ metersPerCell: 100, basis: "世界书：南北约十公里", coverage: "约 10km × 10km" }) },
    });
    const binding = fixtureBinding({ chatId: link, worldId: linkWorld, currentLocationId: "loc:101", worldTimeCursor: 3 });
    const messages = { userMessageId: "msg-card-A-u1", assistantMessageId: "msg-card-A-a1" };
    return {
      chatId: link, worldId: linkWorld, cardId, branchId: null, branchKey: "canon", mapIds: ["world", "loc:101"],
      world, tables, maps, binding, simulation: null, turns: {}, messages,
      session: fixtureSession({ rev: 2, binding, world, maps, tables, turns: {} }),
      identity: fixtureIdentity({
        scenario: "shared-card-A", chatIds: [link], worldIds: [linkWorld], branchKeys: ["canon"],
        messageIds: [messages.userMessageId, messages.assistantMessageId],
        locationRowIds: ["loc:101", "loc:102", "loc:103", "loc:104", "loc:105"],
        mapIds: ["world", "loc:101"],
      }),
    };
  })();

  const chatB = (() => {
    const world = buildStarterWorld({ id: seenWorld, now: NOW, name: "圣罗兰编年史" });
    const tables = fixtureTableDoc(seenWorld, "canon");   // 全新聊天：三表全空，不读 A 的任何行
    const maps = fixtureMapsDoc();
    const binding = fixtureBinding({ chatId: seen, worldId: seenWorld, currentLocationId: null, worldTimeCursor: 0 });
    const messages = { userMessageId: "msg-card-B-u1", assistantMessageId: "msg-card-B-a1" };
    return {
      chatId: seen, worldId: seenWorld, cardId, branchId: null, branchKey: "canon", mapIds: ["world"],
      world, tables, maps, binding, simulation: null, turns: {}, messages,
      session: fixtureSession({ rev: 1, binding, world, maps, tables, turns: {} }),
      identity: fixtureIdentity({
        scenario: "shared-card-B", chatIds: [seen], worldIds: [seenWorld], branchKeys: ["canon"],
        messageIds: [messages.userMessageId, messages.assistantMessageId], locationRowIds: [], mapIds: ["world"],
      }),
    };
  })();

  return {
    scenario, now: NOW, cardId, chats: [chatA, chatB],
    /** T10：A 有 5 地点 2 人物，B 全新；两个聊天的三表 / 地图 / 推演必须零交集。 */
    expectation: { aLocations: 5, aCharacters: 2, bLocations: 0, bCharacters: 0, sharedRows: 0 },
    identity: mergeIdentities(scenario, chatA.identity, chatB.identity),
  };
}

/** 3) 学校 → 三年二班 的父子层级（确认在教室但无室内细坐标）。 */
export function fixtureSchoolHierarchy() {
  const scenario = "school-hierarchy";
  const chatId = "chat-school";
  const worldId = "world-school";
  const school = "loc:7101";
  const classroom = "loc:7102";
  const world = buildStarterWorld({ id: worldId, now: NOW, name: "圣罗兰学校" });
  world.points.push(
    { id: 7101, name: "圣罗兰学校", x: 34, y: 62, regionId: "start" },
    { id: 7102, name: "三年二班", x: 20, y: 20, regionId: "start", parentPointId: 7101 },
  );
  world.characters.push(
    { id: "teacher-lin", worldId, name: "林老师", role: "配角", description: "三年二班班主任。", currentRegionId: "start" },
    { id: "student-b", worldId, name: "同桌同学", role: "配角", description: "坐在旁边的同学。", currentRegionId: "start" },
  );
  const tables = fixtureTableDoc(worldId, "canon", {
    locations: [
      fixtureLocation({ id: school, name: "圣罗兰学校", description: "城墙边的学校。", gridX: 34, gridY: 62 }),
      // 教室进父地点的子图；具体座位未知 → gridX/Y 保持 null（不得落到 0,0）
      fixtureLocation({ id: classroom, name: "三年二班", parentLocationId: school, description: "二楼的教室。", mapId: school }),
    ],
    characters: [
      fixtureCharacter({ id: "npc:player", name: "羽风", locationId: classroom, thought: "先找自己的座位", actionTendency: "留在教室" }),
      fixtureCharacter({ id: "npc:teacher-lin", name: "林老师", locationId: classroom, thought: "点名", actionTendency: "上课" }),
      fixtureCharacter({ id: "npc:student-b", name: "同桌同学", locationId: classroom, thought: "偷偷看窗外", actionTendency: "发呆" }),
    ],
    items: [fixtureItem({ id: "item:textbook", name: "课本", description: "摊在课桌上。", locationId: classroom })],
  });
  const maps = fixtureMapsDoc({
    pointMeta: { "7102": { description: "三年二班（室内坐标未知）。" } },
    submaps: {
      "7101": {
        parentMapId: "world", ownerLocationId: "7101",
        frame: { cols: 40, rows: 30, frameRevision: 1 },
        points: [{ id: "7102", name: "三年二班", x: 20, y: 12 }],
      },
    },
    // 学校子图**未标定**（§2.6：每张图各标一次，缺证据显示「未标定 · 按格」）
  });
  const binding = fixtureBinding({ chatId, worldId, currentLocationId: classroom, worldTimeCursor: 0 });
  const messages = { userMessageId: "msg-school-u1", assistantMessageId: "msg-school-a1" };
  return {
    scenario, now: NOW, chatId, worldId, branchId: null, branchKey: "canon",
    mapIds: ["world", school],
    schoolLocationId: school, classroomLocationId: classroom,
    world, tables, maps, binding, simulation: null, turns: {}, messages,
    /** T07：教室标点上应出现「3 人」徽标；没有任何人有室内细坐标，不得捏造座位。 */
    expectation: { classroomOccupants: 3, classroomGridX: null, classroomGridY: null, schoolCalibrated: false },
    session: fixtureSession({ binding, world, maps, tables, turns: {} }),
    identity: fixtureIdentity({
      scenario, chatIds: [chatId], worldIds: [worldId], branchKeys: ["canon"],
      messageIds: [messages.userMessageId, messages.assistantMessageId],
      locationRowIds: [school, classroom], mapIds: ["world", school],
    }),
  };
}

/** 4) 圣罗兰城 / 外城区 / 奴隶市场 / 工厂区：contained 与 adjacent 分开。 */
export function fixtureSaintLaurentCity() {
  const scenario = "saint-laurent-city";
  const chatId = "chat-city";
  const worldId = "world-city";
  const city = "loc:7201";
  const outer = "loc:7202";
  const market = "loc:7203";
  const factory = "loc:7204";
  const world = buildStarterWorld({ id: worldId, now: NOW, name: "圣罗兰城" });
  world.points.push(
    { id: 7201, name: "圣罗兰城", x: 50, y: 50, regionId: "start" },
    { id: 7202, name: "圣罗兰外城区", x: 62, y: 38, regionId: "start" },
  );
  const tables = fixtureTableDoc(worldId, "canon", {
    locations: [
      fixtureLocation({ id: city, name: "圣罗兰城", description: "有城墙的城市入口。", gridX: 50, gridY: 50 }),
      // 外城区与城市是**邻接**关系，绝不凭地名写成 contained
      fixtureLocation({ id: outer, name: "圣罗兰外城区", description: "城墙外的聚落。", gridX: 62, gridY: 38 }),
      fixtureLocation({ id: market, name: "圣罗兰奴隶市场", parentLocationId: city, description: "城内的市场。", mapId: city, gridX: 20, gridY: 30 }),
      fixtureLocation({ id: factory, name: "圣罗兰工厂区", parentLocationId: city, description: "城内的工厂区。", mapId: city, gridX: 70, gridY: 60 }),
    ],
    characters: [
      fixtureCharacter({ id: "npc:market-crier", name: "市场掮客", locationId: market, thought: "今天没开张", actionTendency: "吆喝" }),
      fixtureCharacter({ id: "npc:factory-foreman", name: "工厂领班", locationId: factory, thought: "炉子要熄了", actionTendency: "催工" }),
    ],
    items: [fixtureItem({ id: "item:market-ledger", name: "市场账本", description: "掮客手里的册子。", holderCharacterId: "npc:market-crier" })],
  });
  const maps = fixtureMapsDoc({
    pointMeta: {
      "7201": { description: "世界图上的城市入口。" },
      "7202": { description: "城墙外的聚落。" },
      "7203": { description: "城市子图中的市场。" },
      "7204": { description: "城市子图中的工厂区。" },
    },
    submaps: {
      "7201": {
        parentMapId: "world", ownerLocationId: "7201",
        frame: { cols: 100, rows: 100, frameRevision: 1 },
        points: [
          { id: "7203", name: "圣罗兰奴隶市场", x: 20, y: 30 },
          { id: "7204", name: "圣罗兰工厂区", x: 70, y: 60 },
        ],
      },
    },
  });
  const geoTopology = {
    edges: [
      // 邻接（walk）：外城区 ↔ 城市，两边都是已确认地点，但 parentLocationId 保持 null
      { id: "edge:7201:7202:adjacent", fromLocationId: city, toLocationId: outer, kind: "adjacent", evidence: "story", channel: "walk" },
      // 城市子图内的邻接
      { id: "edge:7203:7204:adjacent", fromLocationId: market, toLocationId: factory, kind: "adjacent", evidence: "story", channel: "walk" },
    ],
    areas: [
      { id: `area:${worldId}:world:${city}`, locationId: city, mapId: "world", cells: [{ x: 49, y: 49 }, { x: 50, y: 49 }, { x: 50, y: 50 }, { x: 49, y: 50 }], evidence: "story" },
    ],
    vehicles: [],
  };
  const simulation = fixtureSimulation(worldId, "canon", { geoTopology });
  const binding = fixtureBinding({ chatId, worldId, currentLocationId: city, worldTimeCursor: 2 });
  const messages = { userMessageId: "msg-city-u1", assistantMessageId: "msg-city-a1" };
  return {
    scenario, now: NOW, chatId, worldId, branchId: null, branchKey: "canon",
    mapIds: ["world", city],
    cityLocationId: city, outerLocationId: outer, marketLocationId: market, factoryLocationId: factory,
    world, tables, maps, binding, simulation, turns: {}, messages,
    /** T18：世界图 = 城市入口 + 外城区；城市子图 = 市场 + 工厂；外城区 parent 必须为 null。 */
    expectation: { outerParent: null, marketParent: city, factoryParent: city, adjacentEdges: 2 },
    session: fixtureSession({ binding, world, maps, tables, simulation, turns: {} }),
    identity: fixtureIdentity({
      scenario, chatIds: [chatId], worldIds: [worldId], branchKeys: ["canon"],
      messageIds: [messages.userMessageId, messages.assistantMessageId],
      locationRowIds: [city, outer, market, factory], mapIds: ["world", city],
    }),
  };
}

/** 5) T19 负例：只有地名、证据不足 → parent = null、待确认、不染色。 */
export function fixtureSaintLaurentPending() {
  const scenario = "saint-laurent-pending";
  const chatId = "chat-city-pending";
  const worldId = "world-city-pending";
  const market = "loc:7251";
  const world = buildStarterWorld({ id: worldId, now: NOW, name: "圣罗兰（资料不足）" });
  const tables = fixtureTableDoc(worldId, "canon", {
    locations: [
      // 只出现过名字：不因「圣罗兰」三个字强行嵌套，也不编坐标
      fixtureLocation({ id: market, name: "圣罗兰奴隶市场", description: "只在世界书里被提到一次。" }),
    ],
    characters: [], items: [],
  });
  const maps = fixtureMapsDoc({
    pointMeta: { "7251": { description: "来源不明，坐标待人工确认。" } },
  });
  const simulation = fixtureSimulation(worldId, "canon", {
    geoTopology: { edges: [], areas: [], vehicles: [] },
  });
  const binding = fixtureBinding({ chatId, worldId, currentLocationId: null, worldTimeCursor: 0 });
  const messages = { userMessageId: "msg-city-pending-u1", assistantMessageId: "msg-city-pending-a1" };
  return {
    scenario, now: NOW, chatId, worldId, branchId: null, branchKey: "canon", mapIds: ["world"],
    pendingLocationId: market,
    world, tables, maps, binding, simulation, turns: {}, messages,
    /** T19：没有证据就不写 parent、不给格坐标、不染任何格；只进「待确认归属」列表。 */
    pendingRelations: [{ locationId: market, reasonCode: "NO_EVIDENCE", suggestedParentName: "圣罗兰城" }],
    expectation: { parent: null, gridX: null, gridY: null, areas: 0, edges: 0 },
    session: fixtureSession({ binding, world, maps, tables, simulation, turns: {} }),
    identity: fixtureIdentity({
      scenario, chatIds: [chatId], worldIds: [worldId], branchKeys: ["canon"],
      messageIds: [messages.userMessageId, messages.assistantMessageId],
      locationRowIds: [market], mapIds: ["world"],
    }),
  };
}

/** 6) 载具（蒸汽马车厢）移动：停靠 → 在途，两名乘员随车。 */
export function fixtureVehicleMove() {
  const scenario = "vehicle-move";
  const chatId = "chat-vehicle";
  const worldId = "world-vehicle";
  const vehicle = "loc:7301";
  const cabin = "loc:7302";
  const station = "loc:7303";
  const gate = "loc:7304";
  const driver = "npc:vehicle-driver";
  const passenger = "npc:vehicle-passenger";
  const world = buildStarterWorld({ id: worldId, now: NOW, name: "夜路" });
  world.points.push(
    { id: 7301, name: "蒸汽马车厢", x: 30, y: 70, regionId: "start" },
    { id: 7303, name: "城南车站", x: 30, y: 70, regionId: "start" },
    { id: 7304, name: "北门", x: 30, y: 40, regionId: "start" },
  );
  const tables = fixtureTableDoc(worldId, "canon", {
    locations: [
      fixtureLocation({ id: vehicle, name: "蒸汽马车厢", description: "移动载具本体。", mapId: "world" }),
      fixtureLocation({ id: cabin, name: "车厢内部", parentLocationId: vehicle, description: "两名乘员。", mapId: vehicle }),
      fixtureLocation({ id: station, name: "城南车站", description: "出发点。", gridX: 30, gridY: 70 }),
      fixtureLocation({ id: gate, name: "北门", description: "目的地。", gridX: 30, gridY: 40 }),
    ],
    characters: [
      fixtureCharacter({ id: driver, name: "车夫", locationId: cabin, thought: "赶在天亮前到北门", actionTendency: "上路", currentAction: "挥鞭" }),
      fixtureCharacter({ id: passenger, name: "同行乘客", locationId: cabin, thought: "抓紧扶手", actionTendency: "待在车里" }),
    ],
    items: [],
  });
  const maps = fixtureMapsDoc({
    pointMeta: { "7301": { description: "停靠时挂在车站；在途时按路线画中性图标。" } },
    submaps: {
      "7301": {
        parentMapId: "world", ownerLocationId: "7301",
        frame: { cols: 20, rows: 20, frameRevision: 1 },
        points: [{ id: "7302", name: "车厢内部", x: 10, y: 10 }],
      },
    },
    calibrations: { world: fixtureCalibration({ metersPerCell: 100, basis: "世界书：南北约十公里", coverage: "约 10km × 10km" }) },
  });
  const routeEdge = {
    id: "edge:7303:7304:route", fromLocationId: station, toLocationId: gate,
    kind: "route", evidence: "story", channel: "vehicle",
  };
  const stoppedAnchor = {
    id: vehicle, locationId: vehicle, atLocationId: station, routeEdgeId: null,
    status: "stopped", evidence: "worldbook",
  };
  const enRouteAnchor = {
    id: vehicle, locationId: vehicle, atLocationId: null, routeEdgeId: routeEdge.id,
    status: "en-route", evidence: "story",
  };
  const beforeSimulation = fixtureSimulation(worldId, "canon", {
    tasks: [
      {
        id: "task:vehicle-move:1", kind: "travel", status: "queued", actorCharacterId: driver,
        originLocationId: cabin, targetLocationId: gate, topic: "把车赶到北门", signalId: null,
        visibility: "known", source: "character-intent", createdTurnKey: "turn-vehicle-0",
        lastAppliedTurnKey: null, createdPeriod: 0, nextEligiblePeriod: 1, reasonCode: null,
      },
    ],
    geoTopology: { edges: [routeEdge], areas: [], vehicles: [stoppedAnchor] },
  });
  const afterSimulation = fixtureSimulation(worldId, "canon", {
    tasks: [
      {
        ...beforeSimulation.branches.canon.tasks[0],
        status: "active", lastAppliedTurnKey: "turn-vehicle-1", nextEligiblePeriod: 2,
      },
    ],
    geoTopology: { edges: [routeEdge], areas: [], vehicles: [enRouteAnchor] },
  });
  const simulationEvents = [
    {
      id: "evt:turn-vehicle-1:1", simulationId: "task:vehicle-move:1", kind: "travel",
      actorCharacterId: driver, fromLocationId: station, toLocationId: gate, status: "progressed",
      reasonCode: null, summary: "蒸汽马车厢离开城南车站上路（车厢内 2 人随车）",
      visibility: "known", period: 1,
    },
  ];
  const simulationUndo = [{ collection: "vehicles", id: vehicle, before: stoppedAnchor }];
  const binding = fixtureBinding({ chatId, worldId, currentLocationId: null, worldTimeCursor: 1 });
  const messages = { userMessageId: "msg-vehicle-u1", assistantMessageId: "msg-vehicle-a1" };
  return {
    scenario, now: NOW, chatId, worldId, branchId: null, branchKey: "canon",
    mapIds: ["world", vehicle],
    vehicleLocationId: vehicle, cabinLocationId: cabin, stationLocationId: station, gateLocationId: gate,
    crew: [driver, passenger],
    before: { worldTimeCursor: 0, simulation: beforeSimulation, turns: {} },
    after: {
      worldTimeCursor: 1, simulation: afterSimulation,
      turns: {
        "turn-vehicle-1": {
          schemaVersion: 1, chatId, branchId: null, effectiveAt: 1,
          userMessageId: messages.userMessageId, assistantMessageId: messages.assistantMessageId,
          swipeId: null, simulationEvents, simulationUndo,
        },
      },
    },
    /** T20：整辆车移动时，两名乘员仍只在 cabin（相对车厢位置不变），不生成两个世界图坐标。 */
    expectation: { crewLocationAfterMove: cabin, worldPointsAdded: 0, vehicleStatusAfterMove: "en-route" },
    world, tables, maps, binding, simulation: afterSimulation, turns: {}, messages,
    session: fixtureSession({ binding, world, maps, tables, simulation: afterSimulation, turns: {} }),
    identity: fixtureIdentity({
      scenario, chatIds: [chatId], worldIds: [worldId], branchKeys: ["canon"],
      messageIds: [messages.userMessageId, messages.assistantMessageId, "turn-vehicle-0", "turn-vehicle-1"],
      locationRowIds: [vehicle, cabin, station, gate], mapIds: ["world", vehicle],
    }),
  };
}

/** 7) 远方宣战信号：一份 signal，逐跳送达；工厂的人在 0/1 时段都不知道。 */
export function fixtureDistantDeclaration() {
  const scenario = "distant-declaration";
  const chatId = "chat-signal";
  const worldId = "world-signal";
  const school = "loc:7401";
  const gate = "loc:7402";
  const market = "loc:7403";
  const factory = "loc:7404";
  const messenger = "npc:messenger";
  const gateGuard = "npc:gate-guard";
  const foreman = "npc:factory-foreman";
  const turnKey0 = "turn-signal-0";
  const signalId = "sig:chat-signal:canon:turn-signal-0:loc:7401:1";
  const world = buildStarterWorld({ id: worldId, now: NOW, name: "宣战之日" });
  world.points.push(
    { id: 7401, name: "圣罗兰学校", x: 20, y: 20, regionId: "start" },
    { id: 7402, name: "圣罗兰城门", x: 40, y: 40, regionId: "start" },
    { id: 7403, name: "奴隶市场", x: 50, y: 50, regionId: "start" },
    { id: 7404, name: "工厂区", x: 80, y: 80, regionId: "start" },
  );
  const tables = fixtureTableDoc(worldId, "canon", {
    locations: [
      fixtureLocation({ id: school, name: "圣罗兰学校", gridX: 20, gridY: 20 }),
      fixtureLocation({ id: gate, name: "圣罗兰城门", gridX: 40, gridY: 40 }),
      fixtureLocation({ id: market, name: "奴隶市场", gridX: 50, gridY: 50 }),
      fixtureLocation({ id: factory, name: "工厂区", gridX: 80, gridY: 80 }),
    ],
    characters: [
      fixtureCharacter({ id: messenger, name: "使者", locationId: school, thought: "文书必须送到", actionTendency: "出城送信" }),
      fixtureCharacter({ id: gateGuard, name: "城门守卫", locationId: gate, thought: "今晚要加岗", actionTendency: "守门" }),
      // 远居另一图的关系人：**没有任何 delivery**，不得因为「与消息有关」就得知
      fixtureCharacter({ id: foreman, name: "工厂领班", locationId: factory, thought: "炉子要熄了", actionTendency: "催工" }),
    ],
    items: [],
  });
  const maps = fixtureMapsDoc({ calibrations: { world: fixtureCalibration({ metersPerCell: 100, basis: "世界书：南北约十公里", coverage: "约 10km × 10km" }) } });
  const edgeSchoolGate = { id: "edge:7401:7402:adjacent", fromLocationId: school, toLocationId: gate, kind: "adjacent", evidence: "worldbook", channel: "walk" };
  const edgeGateMarket = { id: "edge:7402:7403:adjacent", fromLocationId: gate, toLocationId: market, kind: "adjacent", evidence: "worldbook", channel: "walk" };
  const period0 = fixtureSimulation(worldId, "canon", {
    tasks: [
      {
        id: "task:signal:1", kind: "intent", status: "queued", actorCharacterId: messenger,
        originLocationId: school, targetLocationId: gate, topic: "把宣战文书带出学校", signalId: null,
        visibility: "known", source: "character-intent", createdTurnKey: turnKey0,
        lastAppliedTurnKey: null, createdPeriod: 0, nextEligiblePeriod: 1, reasonCode: null,
      },
      {
        id: "task:signal:2", kind: "travel", status: "blocked", actorCharacterId: foreman,
        originLocationId: factory, targetLocationId: market, topic: "去市场打听消息", signalId: null,
        visibility: "hidden", source: "character-intent", createdTurnKey: turnKey0,
        lastAppliedTurnKey: turnKey0, createdPeriod: 0, nextEligiblePeriod: null, reasonCode: "NO_TIME",
      },
    ],
    signals: [
      {
        id: signalId, originLocationId: school, topic: "使者已带出宣战文书",
        sourceTurnKey: turnKey0, sourceQuoteId: "msg:msg-signal-a1", publishedPeriod: 0,
        visibility: "known", status: "active", propagationCursor: 0,
      },
    ],
    deliveries: [
      { id: `dlv:${signalId}:location:${school}`, signalId, recipientType: "location", recipientId: school, via: "witness", fromLocationId: school, receivedPeriod: 0, confidence: "confirmed" },
      { id: `dlv:${signalId}:character:${messenger}`, signalId, recipientType: "character", recipientId: messenger, via: "witness", fromLocationId: school, receivedPeriod: 0, confidence: "confirmed" },
    ],
    geoTopology: { edges: [edgeSchoolGate, edgeGateMarket], areas: [], vehicles: [] },
  });
  const period1 = fixtureSimulation(worldId, "canon", {
    tasks: [
      { ...period0.branches.canon.tasks[0], status: "active", lastAppliedTurnKey: "turn-signal-1", nextEligiblePeriod: 2 },
      {
        id: "task:signal:3", kind: "reaction", status: "queued", actorCharacterId: gateGuard,
        originLocationId: gate, targetLocationId: null, topic: "把城门加岗的消息报上去", signalId,
        visibility: "known", source: "observed", createdTurnKey: "turn-signal-1",
        lastAppliedTurnKey: null, createdPeriod: 1, nextEligiblePeriod: 2, reasonCode: null,
      },
      period0.branches.canon.tasks[1],
    ],
    signals: [{ ...period0.branches.canon.signals[0], propagationCursor: 2 }],
    deliveries: [
      ...period0.branches.canon.deliveries,
      { id: `dlv:${signalId}:location:${gate}`, signalId, recipientType: "location", recipientId: gate, via: "messenger", fromLocationId: school, receivedPeriod: 1, confidence: "confirmed" },
      { id: `dlv:${signalId}:character:${gateGuard}`, signalId, recipientType: "character", recipientId: gateGuard, via: "messenger", fromLocationId: school, receivedPeriod: 1, confidence: "confirmed" },
    ],
    geoTopology: { edges: [edgeSchoolGate, edgeGateMarket], areas: [], vehicles: [] },
  });
  const binding = fixtureBinding({ chatId, worldId, currentLocationId: school, worldTimeCursor: 0 });
  const messages = {
    userMessageId: "msg-signal-u1",
    assistantMessageId: "msg-signal-a1",
    assistantText: "使者带着宣战文书离开了学校。",
    quote: "使者带着宣战文书离开了学校",
  };
  return {
    scenario, now: NOW, chatId, worldId, branchId: null, branchKey: "canon", mapIds: ["world"],
    signalId, originLocationId: school, gateLocationId: gate, marketLocationId: market, factoryLocationId: factory,
    messengerCharacterId: messenger, gateGuardCharacterId: gateGuard, distantCharacterId: foreman,
    periods: [
      { period: 0, simulation: period0, deliveries: period0.branches.canon.deliveries.length },
      { period: 1, simulation: period1, deliveries: period1.branches.canon.deliveries.length },
    ],
    world, tables, maps, binding, simulation: period1, turns: {}, messages,
    /** T03 / T04 / T21：第 0 段只有发起地与同地目击；工厂领班在 0/1 时段都**没有** delivery。 */
    expectation: {
      signals: 1,
      period0Deliveries: 2,
      period1Deliveries: 4,
      distantCharacterDeliveries: 0,
      distantBlockedReason: "NO_TIME",
    },
    session: fixtureSession({ binding, world, maps, tables, simulation: period1, turns: {} }),
    identity: fixtureIdentity({
      scenario, chatIds: [chatId], worldIds: [worldId], branchKeys: ["canon"],
      messageIds: [messages.userMessageId, messages.assistantMessageId],
      locationRowIds: [school, gate, market, factory], mapIds: ["world"],
    }),
  };
}

/** 8) IF 分支：正史有宣战信号与标定，IF 只有自己的分支键。 */
export function fixtureIfBranch() {
  const scenario = "if-branch";
  const chatId = "chat-if-canon";
  const worldId = "world-if";
  const canonStoryId = "story-canon";
  const ifStoryId = "story-if-1";
  const school = "loc:7501";
  const factory = "loc:7502";
  const signalId = "sig:chat-if-canon:canon:turn-if-0:loc:7501:1";
  const world = buildStarterWorld({ id: worldId, now: NOW, name: "宣战之日（IF）" });
  world.points.push(
    { id: 7501, name: "圣罗兰学校", x: 20, y: 20, regionId: "start" },
    { id: 7502, name: "工厂区", x: 80, y: 80, regionId: "start" },
  );
  world.stories = [
    { id: canonStoryId, worldId, mode: "canon", title: "正史", steps: [], createdAt: NOW, updatedAt: NOW },
    {
      id: ifStoryId, worldId, mode: "if", title: "IF：文书没有送出", steps: [],
      parentStoryId: canonStoryId, divergenceEventId: null, createdAt: NOW, updatedAt: NOW,
      ifOrigin: {
        rootStoryId: canonStoryId, sourceStoryId: canonStoryId, anchorEventId: null,
        anchorStep: 0, anchorAt: 0, viewpointCharacterId: null, variant: 1, label: "a", approx: false,
      },
    },
  ];
  world.characterStates = [
    { characterId: "gate-guard", currentRegionId: "start", currentPointId: "7501", status: "正史：在校门口", updatedAt: NOW },
    { characterId: "gate-guard", currentRegionId: "start", currentPointId: "7502", status: "IF：没有去学校", updatedAt: NOW, branchId: ifStoryId },
  ];
  const tables = fixtureTableDoc(worldId, "canon", {
    locations: [
      fixtureLocation({ id: school, name: "圣罗兰学校", gridX: 20, gridY: 20 }),
      fixtureLocation({ id: factory, name: "工厂区", gridX: 80, gridY: 80 }),
    ],
    characters: [
      fixtureCharacter({ id: "npc:gate-guard", name: "城门守卫", locationId: school, thought: "文书还没送出去", actionTendency: "留在学校" }),
      fixtureCharacter({ id: "npc:messenger", name: "使者", locationId: school, thought: "正要出发", actionTendency: "去城门" }),
    ],
    items: [],
  });
  const tablesDoc = {
    schemaVersion: 1, worldId,
    branches: {
      canon: tables.branches.canon,
      // IF 自己的三表：只有它自己确认过的事实（正史的未来事实不在里面）
      [ifStoryId]: {
        locations: [
          fixtureLocation({ id: school, name: "圣罗兰学校", gridX: 20, gridY: 20 }),
          fixtureLocation({ id: factory, name: "工厂区", gridX: 80, gridY: 80 }),
        ],
        characters: [
          fixtureCharacter({ id: "npc:gate-guard", name: "城门守卫", locationId: factory, thought: "什么都没听说", actionTendency: "催工" }),
          fixtureCharacter({ id: "npc:messenger", name: "使者", locationId: school, thought: "还没动身", actionTendency: "留在学校" }),
        ],
        items: [],
      },
    },
  };
  const maps = fixtureMapsDoc({
    calibrations: {
      // 正史世界图已标定；IF 派生时可读作初值，但 IF 自己的修改只写自己的分支键
      world: fixtureCalibration({ metersPerCell: 100, basis: "世界书：南北约十公里", coverage: "约 10km × 10km" }),
    },
  });
  const canonSimulation = fixtureSimulation(worldId, "canon", {
    signals: [
      {
        id: signalId, originLocationId: school, topic: "使者已带出宣战文书",
        sourceTurnKey: "turn-if-0", sourceQuoteId: "msg:msg-if-a1", publishedPeriod: 0,
        visibility: "known", status: "active", propagationCursor: 1,
      },
    ],
    deliveries: [
      { id: `dlv:${signalId}:location:${school}`, signalId, recipientType: "location", recipientId: school, via: "witness", fromLocationId: school, receivedPeriod: 0, confidence: "confirmed" },
    ],
    geoTopology: {
      edges: [{ id: "edge:7501:7502:adjacent", fromLocationId: school, toLocationId: factory, kind: "adjacent", evidence: "worldbook", channel: "walk" }],
      areas: [{ id: `area:${worldId}:world:${school}`, locationId: school, mapId: "world", cells: [{ x: 20, y: 20 }], evidence: "story" }],
      vehicles: [],
    },
  });
  const simulation = {
    schemaVersion: 1, worldId,
    branches: {
      canon: canonSimulation.branches.canon,
      // IF 空模块：没有正史的 signal / delivery / area
      [ifStoryId]: { tasks: [], signals: [], deliveries: [], geoTopology: { edges: [], areas: [], vehicles: [] } },
    },
  };
  const canonBinding = fixtureBinding({ chatId, worldId, currentLocationId: school, worldTimeCursor: 1, branchId: canonStoryId });
  const ifBinding = fixtureBinding({ chatId, worldId, currentLocationId: factory, worldTimeCursor: 0, branchId: ifStoryId });
  const messages = { userMessageId: "msg-if-u1", assistantMessageId: "msg-if-a1" };
  return {
    scenario, now: NOW, chatId, worldId,
    canonStoryId, ifStoryId,
    /** branchScopeForStory(world, branchId)：正史 → "canon"；IF → 该 story id。 */
    canonBranchKey: "canon", ifBranchKey: ifStoryId,
    mapIds: ["world"],
    world, tables: tablesDoc, maps, binding: canonBinding, simulation,
    ifBinding, turns: {}, messages,
    expectation: {
      canonSignals: 1, canonDeliveries: 1, ifSignals: 0, ifDeliveries: 0, ifAreas: 0,
      ifCharacterKnowledge: [], ifCalibrationKey: `${ifStoryId}|world`,
    },
    session: fixtureSession({ rev: 4, binding: canonBinding, world, maps, tables: tablesDoc, simulation, turns: {} }),
    identity: fixtureIdentity({
      scenario, chatIds: [chatId], worldIds: [worldId],
      branchIds: [canonStoryId, ifStoryId], branchKeys: ["canon"],
      messageIds: [messages.userMessageId, messages.assistantMessageId],
      locationRowIds: [school, factory], mapIds: ["world"],
    }),
  };
}

/** 9) swipe：同一 userMessageId 的两个助手变体。 */
export function fixtureSwipeVariant() {
  const scenario = "swipe-variant";
  const chatId = "chat-swipe";
  const worldId = "world-swipe";
  const gate = "loc:7601";
  const school = "loc:7602";
  const userMessageId = "msg-swipe-u1";
  const variantA = { name: "A", assistantMessageId: "msg-swipe-a1", swipeId: null, assistantText: "使者带着宣战文书离开了学校。" };
  const variantB = { name: "B", assistantMessageId: "msg-swipe-a2", swipeId: "swipe-2", assistantText: "使者收起文书，决定再等一夜。" };
  const turnKeyA = atlasCommitIdempotencyKey({ chatId, userMessageId, assistantMessageId: variantA.assistantMessageId, swipeId: variantA.swipeId });
  const turnKeyB = atlasCommitIdempotencyKey({ chatId, userMessageId, assistantMessageId: variantB.assistantMessageId, swipeId: variantB.swipeId });
  const signalId = `sig:${chatId}:canon:${turnKeyA}:${school}:1`;
  const world = buildStarterWorld({ id: worldId, now: NOW, name: "一夜之差" });
  world.points.push(
    { id: 7601, name: "圣罗兰城门", x: 40, y: 40, regionId: "start" },
    { id: 7602, name: "圣罗兰学校", x: 20, y: 20, regionId: "start" },
  );
  const baselineTables = {
    locations: [
      fixtureLocation({ id: gate, name: "圣罗兰城门", gridX: 40, gridY: 40 }),
      fixtureLocation({ id: school, name: "圣罗兰学校", gridX: 20, gridY: 20 }),
    ],
    characters: [
      fixtureCharacter({ id: "npc:messenger", name: "使者", locationId: school, thought: "文书在怀里", actionTendency: "等命令" }),
      fixtureCharacter({ id: "npc:gate-guard", name: "城门守卫", locationId: gate, thought: "夜里风大", actionTendency: "守门" }),
    ],
    items: [],
  };
  const movedTables = {
    locations: baselineTables.locations,
    characters: [
      fixtureCharacter({ id: "npc:messenger", name: "使者", locationId: gate, thought: "文书必须送到", actionTendency: "出城", currentAction: "赶路" }),
      baselineTables.characters[1],
    ],
    items: [],
  };
  const simulationA = fixtureSimulation(worldId, "canon", {
    tasks: [
      {
        id: "task:swipe:1", kind: "travel", status: "active", actorCharacterId: "npc:messenger",
        originLocationId: school, targetLocationId: gate, topic: "把宣战文书送到城门", signalId: null,
        visibility: "known", source: "observed", createdTurnKey: turnKeyA,
        lastAppliedTurnKey: turnKeyA, createdPeriod: 0, nextEligiblePeriod: 1, reasonCode: null,
      },
    ],
    signals: [
      {
        id: signalId, originLocationId: school, topic: "使者已带出宣战文书",
        sourceTurnKey: turnKeyA, sourceQuoteId: `msg:${variantA.assistantMessageId}`, publishedPeriod: 0,
        visibility: "known", status: "active", propagationCursor: 1,
      },
    ],
    deliveries: [
      { id: `dlv:${signalId}:location:${school}`, signalId, recipientType: "location", recipientId: school, via: "witness", fromLocationId: school, receivedPeriod: 0, confidence: "confirmed" },
      { id: `dlv:${signalId}:character:${"npc:messenger"}`, signalId, recipientType: "character", recipientId: "npc:messenger", via: "witness", fromLocationId: school, receivedPeriod: 0, confidence: "confirmed" },
    ],
  });
  const simulationB = fixtureSimulation(worldId, "canon", {
    tasks: [
      {
        id: "task:swipe:1", kind: "intent", status: "queued", actorCharacterId: "npc:messenger",
        originLocationId: school, targetLocationId: gate, topic: "再等一夜", signalId: null,
        visibility: "known", source: "character-intent", createdTurnKey: turnKeyB,
        lastAppliedTurnKey: null, createdPeriod: 0, nextEligiblePeriod: 1, reasonCode: null,
      },
    ],
  });
  const turnA = {
    schemaVersion: 1, chatId, branchId: null, effectiveAt: 1,
    userMessageId, assistantMessageId: variantA.assistantMessageId, swipeId: variantA.swipeId,
    tablesBefore: { branchKey: "canon", tables: baselineTables },
    receipt: { status: "committed", summary: `表格增量：应用 1 行；时间未推进` },
    simulationEvents: [
      {
        id: `evt:${turnKeyA}:1`, simulationId: "task:swipe:1", kind: "travel", actorCharacterId: "npc:messenger",
        fromLocationId: school, toLocationId: gate, status: "progressed", reasonCode: null,
        summary: "使者带着文书动身去城门", visibility: "known", period: 0,
      },
      {
        id: `evt:${turnKeyA}:2`, simulationId: signalId, kind: "signal", actorCharacterId: null,
        fromLocationId: school, toLocationId: null, status: "published", reasonCode: null,
        summary: "宣战文书已公布（发起地：学校）", visibility: "known", period: 0,
      },
    ],
    simulationUndo: [
      { collection: "tasks", id: "task:swipe:1", before: null },
      { collection: "signals", id: signalId, before: null },
      { collection: "deliveries", id: `dlv:${signalId}:location:${school}`, before: null },
    ],
  };
  const turnB = {
    schemaVersion: 1, chatId, branchId: null, effectiveAt: 0,
    userMessageId, assistantMessageId: variantB.assistantMessageId, swipeId: variantB.swipeId,
    tablesBefore: { branchKey: "canon", tables: baselineTables },
    receipt: { status: "committed", summary: `表格增量：应用 1 行；时间未推进` },
    simulationEvents: [], simulationUndo: [],
  };
  const binding = fixtureBinding({ chatId, worldId, currentLocationId: school, worldTimeCursor: 0 });
  return {
    scenario, now: NOW, chatId, worldId, branchId: null, branchKey: "canon", mapIds: ["world"],
    userMessageId,
    variants: [
      {
        ...variantA, turnKey: turnKeyA, isCommitTurnKey: turnKeyA === `${chatId}::${userMessageId}::${variantA.assistantMessageId}::`,
        tables: movedTables, simulation: simulationA, turn: turnA,
      },
      {
        ...variantB, turnKey: turnKeyB, isCommitTurnKey: turnKeyB === `${chatId}::${userMessageId}::${variantB.assistantMessageId}::${variantB.swipeId}`,
        tables: baselineTables, simulation: simulationB, turn: turnB,
      },
    ],
    /** T13：A 变体宣布传令 → swipe 回退 → B 变体里没有 A 的 signal / delivery / 未来事实。 */
    expectation: {
      distinctTurnKeys: turnKeyA !== turnKeyB,
      afterRollbackToB: { signals: 0, deliveries: 0, messengerLocation: school },
    },
    world, tables: fixtureTableDoc(worldId, "canon", baselineTables), maps: fixtureMapsDoc(),
    binding, simulation: simulationB, turns: { [turnKeyA]: turnA, [turnKeyB]: turnB },
    messages: { userMessageId, assistantMessageId: variantA.assistantMessageId, swipeId: null },
    session: fixtureSession({ binding, world, maps: fixtureMapsDoc(), tables: fixtureTableDoc(worldId, "canon", baselineTables), simulation: simulationB, turns: { [turnKeyA]: turnA, [turnKeyB]: turnB } }),
    identity: fixtureIdentity({
      scenario, chatIds: [chatId], worldIds: [worldId], branchKeys: ["canon"],
      messageIds: [userMessageId, variantA.assistantMessageId, variantB.assistantMessageId, turnKeyA, turnKeyB],
      locationRowIds: [gate, school], mapIds: ["world"],
    }),
  };
}

/** 10) 标尺 100 米/格：世界图已标定、教室图未标定。 */
export function fixtureScaleHundredMeters() {
  const scenario = "scale-100m";
  const chatId = "chat-scale";
  const worldId = "world-scale";
  const school = "loc:7701";
  const classroom = "loc:7702";
  const world = buildStarterWorld({ id: worldId, now: NOW, name: "十公里世界" });
  world.points.push(
    { id: 7701, name: "圣罗兰学校", x: 34, y: 62, regionId: "start" },
    { id: 7702, name: "三年二班", x: 20, y: 20, regionId: "start", parentPointId: 7701 },
  );
  const tables = fixtureTableDoc(worldId, "canon", {
    locations: [
      fixtureLocation({ id: school, name: "圣罗兰学校", gridX: 34, gridY: 62 }),
      fixtureLocation({ id: classroom, name: "三年二班", parentLocationId: school, mapId: school }),
    ],
    characters: [fixtureCharacter({ id: "npc:player", name: "羽风", locationId: classroom, thought: "先坐下", actionTendency: "留在教室" })],
    items: [],
  });
  const maps = fixtureMapsDoc({
    pointMeta: { "7702": { description: "教室：尚无尺寸证据，未标定。" } },
    submaps: {
      "7701": {
        parentMapId: "world", ownerLocationId: "7701",
        frame: { cols: 40, rows: 30, frameRevision: 1 },
        points: [{ id: "7702", name: "三年二班", x: 20, y: 12 }],
      },
    },
    calibrations: {
      // 世界图：可信旧标定 100 米/格（人工锁定）
      world: fixtureCalibration({ metersPerCell: 100, basis: "世界书：南北约十公里 / 100 格", coverage: "约 10km × 10km" }),
    },
  });
  const binding = fixtureBinding({ chatId, worldId, currentLocationId: classroom, worldTimeCursor: 0 });
  const messages = { userMessageId: "msg-scale-u1", assistantMessageId: "msg-scale-a1" };
  return {
    scenario, now: NOW, chatId, worldId, branchId: null, branchKey: "canon",
    mapIds: ["world", school],
    worldLocationId: school, classroomLocationId: classroom,
    world, tables, maps, binding, simulation: null, turns: {}, messages,
    /**
     * 固定 96px 标尺的期望数值（§2.6 / H17 computeViewportScaleBar）：
     * D 米 = 96 × metersPerCell / camera.k；未标定则 D 格 = 96 / camera.k。
     * H17 落地后应直接复现这张表；此处只记录期望值，不引用尚不存在的函数。
     */
    bar: {
      cssPx: 96, narrowViewportPx: 64,
      calibrated: [
        { cameraK: 10, meters: 960, label: "960 米" },
        { cameraK: 20, meters: 480, label: "480 米" },
        { cameraK: 5, meters: 1920, label: "1.92 千米" },
      ],
      uncalibrated: [
        { cameraK: 10, cells: 9.6, label: "约 9.6 格 · 未标定" },
        { cameraK: 20, cells: 4.8, label: "约 4.8 格 · 未标定" },
      ],
      worldMetersPerCell: 100, classroomMetersPerCell: null,
    },
    expectation: { worldCalibrated: true, classroomCalibrated: false, zoomTwiceHalves: 960 / 2 === 480 },
    session: fixtureSession({ binding, world, maps, tables, turns: {} }),
    identity: fixtureIdentity({
      scenario, chatIds: [chatId], worldIds: [worldId], branchKeys: ["canon"],
      messageIds: [messages.userMessageId, messages.assistantMessageId],
      locationRowIds: [school, classroom], mapIds: ["world", school],
    }),
  };
}

/** A01 夹具目录：一次拿到全部可重放场景（每次调用重新构造，互不共享引用）。 */
export function fixtureReplayCatalog() {
  return {
    turnZeroCarriage: fixtureTurnZeroCarriage(),
    sharedCardChats: fixtureSharedCardChats(),
    schoolHierarchy: fixtureSchoolHierarchy(),
    saintLaurentCity: fixtureSaintLaurentCity(),
    saintLaurentPending: fixtureSaintLaurentPending(),
    vehicleMove: fixtureVehicleMove(),
    distantDeclaration: fixtureDistantDeclaration(),
    ifBranch: fixtureIfBranch(),
    swipeVariant: fixtureSwipeVariant(),
    scaleHundredMeters: fixtureScaleHundredMeters(),
  };
}

/**
 * 把目录里的 identity 拍平成按类别分组的 id 列表。
 * 断言口径：chatIds / worldIds / messageIds / branchIds / branchKeys / locationRowIds / mapKeys
 * 每一类内部都**不得有重复**（mapKeys 是「worldId|mapId」复合键，因为 "world" 是约定的根图名）。
 */
export function collectFixtureIdentityIds(catalog = fixtureReplayCatalog()) {
  const buckets = {
    chatIds: [], worldIds: [], branchIds: [], branchKeys: [],
    messageIds: [], locationRowIds: [], mapKeys: [], scenarios: [],
  };
  for (const fixture of Object.values(catalog)) {
    if (!fixture || !fixture.identity) continue;
    const id = fixture.identity;
    buckets.scenarios.push(id.scenario);
    buckets.chatIds.push(...id.chatIds);
    buckets.worldIds.push(...id.worldIds);
    buckets.branchIds.push(...id.branchIds);
    buckets.branchKeys.push(...id.branchKeys);
    buckets.messageIds.push(...id.messageIds);
    buckets.locationRowIds.push(...id.locationRowIds);
    buckets.mapKeys.push(...id.mapKeys);
  }
  return buckets;
}
