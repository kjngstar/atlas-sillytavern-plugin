/**
 * atlas-geo-topology.test.mjs — H01 / H02 / H10 / H11 定向验收（地理拓扑纯函数）。
 *
 * 计划来源：§2.1 固定存储契约、§2.5 地点层级与移动载具契约、§3-H01 / H02 / H10 / H11 / H21。
 *
 * 纪律（每条都有对应用例）：
 * - 空分支恰好三个空数组；ID 由「分支 + 两地点 + 关系类型」确定性生成，(A,B) 与 (B,A) 同一个 ID；
 * - 包含（parentLocationId）**不是**通道：父链不进邻接表，跨区必须走已确认边；
 * - `kind:"communication"` 的边只能传讯，不得当人物物理路线；没有边就是 NO_PATH，不许猜；
 * - 坏边 / 越界格 / 环 / 超 4 层父链 / 引用不存在地点 → 候选**整体拒绝**，但入参原文一字不改；
 * - 0 时段、未知道路、状态不明 → 车辆一动不动；时段足够且路线确认才 停靠→在途→到达；
 * - 车厢子地点内的乘员相对车厢位置不变（不生成两个独立世界坐标），移动只改锚点并可精确 undo；
 * - 地名仅相似而无原文证据 → pending（待确认），绝不自动建立关系；
 * - 分支（正史 / IF）与聊天之间互不串用：ID 带分支、错误路径带分支、模块不保存任何跨会话状态。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ATLAS_GEO_LIMITS,
  ATLAS_GEO_PARENT_DEPTH_MAX,
  buildEdgeAdjacency,
  buildWalkableAdjacency,
  cloneGeoTopology,
  createEmptyTopology,
  geoAreaId,
  geoEdgeId,
  judgeGeoRelation,
  moveVehicleAnchor,
  neighborsOf,
  resolveGeoPath,
  resolveVehicleCrew,
  undoVehicleBefore,
  validateGeoTopology,
} from "../src/atlas-geo-topology.ts";

const CANON = "canon";
const IF_BRANCH = "if:story-2";
const FRAME = { cols: 100, rows: 100 };

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

function loc(id, name, extra = {}) {
  return {
    id,
    name,
    parentLocationId: null,
    description: "",
    rumors: [],
    factions: [],
    mapId: "world",
    gridX: null,
    gridY: null,
    ...extra,
  };
}

function npc(id, name, locationId, extra = {}) {
  return {
    id,
    name,
    locationId,
    thought: "",
    actionTendency: "",
    currentAction: "",
    targetLocationId: null,
    presence: "present",
    positionSource: "narrative",
    mapId: null,
    gridX: null,
    gridY: null,
    ...extra,
  };
}

/** 边行：id 一律走被测的 geoEdgeId（H01 契约：调用方不自造 id）。 */
function edge(kind, from, to, channel, extra = {}) {
  return {
    id: geoEdgeId(CANON, from, to, kind),
    fromLocationId: from,
    toLocationId: to,
    kind,
    evidence: "worldbook",
    channel,
    ...extra,
  };
}

function area(locationId, mapId, cells, extra = {}) {
  return { id: geoAreaId(CANON, mapId, locationId), locationId, mapId, cells, evidence: "manual", ...extra };
}

function vehicle(locationId, status, atLocationId, routeEdgeId, extra = {}) {
  return { id: locationId, locationId, atLocationId, routeEdgeId, status, evidence: "story", ...extra };
}

/** 该分支地点表：学校→三年二班（包含）、城市→市场（包含）、外城区（世界图相邻）、载具与车厢。 */
function baseLocations() {
  return [
    loc("loc:school", "学校", { gridX: 10, gridY: 10 }),
    loc("loc:class", "三年二班", { parentLocationId: "loc:school", mapId: "loc:school", gridX: 3, gridY: 4 }),
    loc("loc:city", "圣罗兰城", { gridX: 40, gridY: 40 }),
    loc("loc:market", "圣罗兰奴隶市场", { parentLocationId: "loc:city", mapId: "loc:city", gridX: 5, gridY: 5 }),
    loc("loc:outer", "圣罗兰外城区", { gridX: 60, gridY: 40 }),
    loc("loc:gate", "城门", { gridX: 41, gridY: 40 }),
    // 载具不伪装成世界图固定坐标：停靠位置只由锚点 atLocationId 表达
    loc("loc:vehicle", "蒸汽马车厢"),
    loc("loc:cabin", "车厢内部", { parentLocationId: "loc:vehicle", mapId: "loc:vehicle", gridX: 2, gridY: 2 }),
    loc("loc:north", "北方驿站", { gridX: 80, gridY: 80 }),
  ];
}

function baseCharacters() {
  return [
    npc("npc:a", "阿甲", "loc:cabin", { mapId: "loc:vehicle", gridX: 3, gridY: 4 }),
    npc("npc:b", "阿乙", "loc:cabin", { mapId: "loc:vehicle", gridX: 5, gridY: 6 }),
    npc("npc:c", "阿丙", "loc:class", { mapId: "loc:school" }),
  ];
}

/** 载具自己的已确认路线：与该载具本体地点相连（H02 与 H11 同一「routeEdgeId 匹配」口径）。 */
function vehicleRouteEdge() {
  return edge("route", "loc:vehicle", "loc:north", "vehicle");
}

/** 两地之间的公路（供 H10 分段移动），不是任何一辆车的 routeEdgeId。 */
function roadEdge() {
  return edge("route", "loc:city", "loc:gate", "walk", { evidence: "story" });
}

function messageEdge() {
  return edge("communication", "loc:school", "loc:city", "message", { evidence: "story" });
}

function baseTopology() {
  return {
    edges: [edge("adjacent", "loc:city", "loc:outer", null), roadEdge(), vehicleRouteEdge(), messageEdge()],
    areas: [area("loc:class", "loc:school", [{ x: 3, y: 4 }])],
    vehicles: [],
  };
}

function stoppedVehicleTopology() {
  const topology = baseTopology();
  topology.vehicles.push(vehicle("loc:vehicle", "stopped", "loc:city", null));
  return topology;
}

const CANON_OPTIONS = () => ({
  branchKey: CANON,
  locations: baseLocations(),
  characters: baseCharacters(),
  frame: FRAME,
});

/* ------------------------------------------------------------------ *
 * H01：空拓扑 / 确定性 ID / 关系判定口径
 * ------------------------------------------------------------------ */

test("H01 空拓扑恰有三个空数组，两个副本互不共享引用", () => {
  const a = createEmptyTopology();
  const b = createEmptyTopology();

  assert.deepEqual(a, { edges: [], areas: [], vehicles: [] });
  assert.deepEqual(Object.keys(a), ["edges", "areas", "vehicles"]);
  assert.notEqual(a.edges, b.edges);
  assert.notEqual(a.areas, b.areas);
  assert.notEqual(a.vehicles, b.vehicles);

  a.edges.push(edge("adjacent", "loc:city", "loc:outer", null));
  assert.equal(b.edges.length, 0, "一个会话的写入不得影响另一个会话的空拓扑");
  assert.equal(createEmptyTopology().edges.length, 0);
});

test("H01 边 ID 以分支+两地点+类型稳定生成，(A,B) 与 (B,A) 是同一个 ID", () => {
  const ab = geoEdgeId(CANON, "loc:city", "loc:outer", "adjacent");
  const ba = geoEdgeId(CANON, "loc:outer", "loc:city", "adjacent");

  assert.equal(ab, ba, "反向调用必须得到同一个 ID（无向去重）");
  assert.equal(ab, geoEdgeId(CANON, "loc:city", "loc:outer", "adjacent"), "同输入恒同 ID");
  assert.notEqual(ab, geoEdgeId(CANON, "loc:city", "loc:outer", "route"), "关系类型不同 → 不同边");
  assert.notEqual(ab, geoEdgeId(IF_BRANCH, "loc:city", "loc:outer", "adjacent"), "分支不同 → 不同边");
  assert.notEqual(ab, geoEdgeId(CANON, "loc:city", "loc:gate", "adjacent"), "端点不同 → 不同边");

  const longA = `loc:${"a".repeat(200)}`;
  const longB = `loc:${"b".repeat(200)}`;
  const longId = geoEdgeId(CANON, longA, longB, "route");
  assert.equal(longId, geoEdgeId(CANON, longB, longA, "route"), "超长 id 也要无向稳定");
  assert.ok(longId.length <= ATLAS_GEO_LIMITS.idChars, "id 不得超 ATLAS_GEO_LIMITS.idChars");

  assert.equal(geoAreaId(CANON, "world", "loc:city"), `${CANON}|world|loc:city`, "区 ID = 分支+地图+地点");
});

test("H01 地名仅相似而无原文证据 → pending / 待确认，绝不自动建立关系", () => {
  const similarOnly = judgeGeoRelation({
    relation: "contained",
    fromName: "圣罗兰城",
    toName: "圣罗兰外城区",
  });
  assert.equal(similarOnly.verdict, "pending", "名字里带「圣罗兰城」不算证据");
  assert.equal(similarOnly.reasonCode, "NO_EVIDENCE");
  assert.equal(similarOnly.fromName, "圣罗兰城", "名称只回带展示，不参与判定");
  assert.equal(similarOnly.toName, "圣罗兰外城区");
  assert.equal(similarOnly.evidenceQuote, null);

  assert.equal(
    judgeGeoRelation({ relation: "contained", evidenceQuote: "   " }).verdict,
    "pending",
    "空白引文不是证据",
  );
  assert.equal(judgeGeoRelation({ relation: "adjacent" }).verdict, "pending");
  assert.equal(judgeGeoRelation({}).verdict, "none");
  assert.equal(judgeGeoRelation({ relation: "none", evidenceQuote: "市场在城内" }).verdict, "none");

  const grounded = judgeGeoRelation({
    relation: "contained",
    fromName: "圣罗兰城",
    toName: "圣罗兰奴隶市场",
    evidenceQuote: "奴隶市场就在圣罗兰城内",
    evidence: "worldbook",
  });
  assert.equal(grounded.verdict, "contained");
  assert.equal(grounded.reasonCode, "EVIDENCE_CONFIRMED");
  assert.equal(grounded.evidenceQuote, "奴隶市场就在圣罗兰城内");

  assert.equal(
    judgeGeoRelation({ relation: "adjacent", evidence: "manual" }).verdict,
    "adjacent",
    "用户在会话里人工确认可以直接成立",
  );

  // pending 的关系不进拓扑：没有原文证据时本就该是空边表，且空拓扑是合法输入。
  const pendingOnly = createEmptyTopology();
  assert.equal(pendingOnly.edges.length, 0);
  assert.deepEqual(validateGeoTopology(pendingOnly, CANON_OPTIONS()), { ok: true, errors: [] });
});

/* ------------------------------------------------------------------ *
 * H02：合法拓扑、包含 vs 邻接、坏边整体拒绝
 * ------------------------------------------------------------------ */

test("H02 合法拓扑通过：包含不等于邻接，通信边不影响物理路线", () => {
  const topology = stoppedVehicleTopology();
  assert.deepEqual(validateGeoTopology(topology, CANON_OPTIONS()), { ok: true, errors: [] });

  const edgesTouchingClass = topology.edges.filter(
    (item) => item.fromLocationId === "loc:class" || item.toLocationId === "loc:class",
  );
  assert.deepEqual(edgesTouchingClass, [], "parentLocationId 只表示包含，不自动生成边");

  const insideSchool = resolveGeoPath(topology, "loc:school", "loc:class");
  assert.equal(insideSchool.ok, false, "父链不是异地直达通道");
  assert.equal(insideSchool.reasonCode, "NO_PATH");

  const adjacent = resolveGeoPath(topology, "loc:city", "loc:outer");
  assert.equal(adjacent.ok, true);
  assert.deepEqual([...adjacent.path], ["loc:city", "loc:outer"]);
  assert.equal(adjacent.hops, 1);

  const containedCity = resolveGeoPath(topology, "loc:city", "loc:market");
  assert.equal(containedCity.ok, false, "市场在城市「内」也要走已确认边，包含不是路");
  assert.equal(containedCity.reasonCode, "NO_PATH");
});

test("H02 坏边整体拒绝：自指 / 未知端点 / 重复（含反向）/ id 不符，路径落到具体字段", () => {
  const options = CANON_OPTIONS();

  const selfEdge = createEmptyTopology();
  selfEdge.edges.push({ ...edge("adjacent", "loc:city", "loc:city", null), id: "geo-edge:raw" });
  const selfResult = validateGeoTopology(selfEdge, options);
  assert.equal(selfResult.ok, false);
  assert.ok(
    selfResult.errors.some(
      (item) =>
        item.path === `$.simulation.branches.${CANON}.geoTopology.edges[0].toLocationId` &&
        item.code === "GEO_EDGE_SELF",
    ),
    JSON.stringify(selfResult.errors),
  );

  const ghost = createEmptyTopology();
  ghost.edges.push({ id: "geo-edge:raw", fromLocationId: "loc:city", toLocationId: "loc:ghost", kind: "adjacent", evidence: "story", channel: null });
  const ghostResult = validateGeoTopology(ghost, options);
  assert.equal(ghostResult.ok, false);
  assert.ok(
    ghostResult.errors.some(
      (item) =>
        item.code === "GEO_EDGE_LOCATION_UNKNOWN" &&
        item.path === `$.simulation.branches.${CANON}.geoTopology.edges[0].toLocationId`,
    ),
    JSON.stringify(ghostResult.errors),
  );

  const duplicated = createEmptyTopology();
  duplicated.edges.push(edge("adjacent", "loc:city", "loc:outer", null));
  duplicated.edges.push(edge("adjacent", "loc:outer", "loc:city", null));
  const duplicatedResult = validateGeoTopology(duplicated, options);
  assert.equal(duplicatedResult.ok, false, "同 (kind, 两端) 的边只能有一行");
  assert.ok(
    duplicatedResult.errors.some(
      (item) => item.code === "GEO_EDGE_DUPLICATE" && item.path.endsWith("edges[1].id"),
    ),
    JSON.stringify(duplicatedResult.errors),
  );

  const wrongId = createEmptyTopology();
  wrongId.edges.push({ ...edge("adjacent", "loc:city", "loc:outer", null), id: "手工乱写的边" });
  const wrongIdResult = validateGeoTopology(wrongId, options);
  assert.equal(wrongIdResult.ok, false);
  assert.ok(wrongIdResult.errors.some((item) => item.code === "GEO_EDGE_ID_MISMATCH"));

  const overLimit = createEmptyTopology();
  for (let i = 0; i <= ATLAS_GEO_LIMITS.edges; i += 1) {
    const from = `loc:f${i}`;
    const to = `loc:t${i}`;
    overLimit.edges.push({ id: geoEdgeId(CANON, from, to, "adjacent"), fromLocationId: from, toLocationId: to, kind: "adjacent", evidence: "story", channel: null });
  }
  const overResult = validateGeoTopology(overLimit, { branchKey: CANON, frame: FRAME });
  assert.equal(overResult.ok, false);
  assert.ok(overResult.errors.some((item) => item.code === "GEO_LIMIT_EXCEEDED" && item.path.endsWith(".edges")));
});

test("H02 通道规则：communication 必须 message，route 必须有可信连通信息，adjacent 不得传讯", () => {
  const options = CANON_OPTIONS();
  const cases = [
    [{ kind: "communication", channel: null }, "GEO_COMMUNICATION_CHANNEL"],
    [{ kind: "communication", channel: "walk" }, "GEO_COMMUNICATION_CHANNEL"],
    [{ kind: "route", channel: null }, "GEO_ROUTE_CHANNEL"],
    [{ kind: "route", channel: "message" }, "GEO_ROUTE_CHANNEL"],
    [{ kind: "adjacent", channel: "message" }, "GEO_ADJACENT_CHANNEL"],
    [{ kind: "adjacent", channel: "boat" }, "GEO_CHANNEL_INVALID"],
    [{ kind: "adjacent", evidence: "传闻" }, "GEO_EVIDENCE_INVALID"],
    [{ kind: "shortcut", channel: null }, "GEO_EDGE_KIND_INVALID"],
  ];
  for (const [patch, code] of cases) {
    const topology = createEmptyTopology();
    topology.edges.push({ ...edge("adjacent", "loc:city", "loc:outer", null), ...patch, id: "geo-edge:raw" });
    const result = validateGeoTopology(topology, options);
    assert.equal(result.ok, false, `应拒绝：${JSON.stringify(patch)}`);
    assert.ok(
      result.errors.some((item) => item.code === code),
      `${JSON.stringify(patch)} 期望 ${code}，实际 ${JSON.stringify(result.errors)}`,
    );
  }

  const okChannels = createEmptyTopology();
  okChannels.edges.push(edge("communication", "loc:school", "loc:city", "message"));
  okChannels.edges.push(edge("route", "loc:city", "loc:gate", "walk"));
  okChannels.edges.push(edge("adjacent", "loc:city", "loc:outer", null));
  assert.deepEqual(validateGeoTopology(okChannels, options), { ok: true, errors: [] });
});

test("H02 area：越界格 / 重复格 / 非整数 / 超 256 格 / 一地点每图一块 全部拒绝", () => {
  const locations = baseLocations();

  const boundaryOk = createEmptyTopology();
  boundaryOk.areas.push(area("loc:class", "loc:school", [{ x: 0, y: 0 }, { x: 99, y: 99 }]));
  assert.deepEqual(validateGeoTopology(boundaryOk, { branchKey: CANON, locations, frame: FRAME }), {
    ok: true,
    errors: [],
  });

  const outside = createEmptyTopology();
  outside.areas.push(area("loc:class", "loc:school", [{ x: 100, y: 0 }]));
  const outsideResult = validateGeoTopology(outside, { branchKey: CANON, locations, frame: FRAME });
  assert.equal(outsideResult.ok, false);
  assert.ok(
    outsideResult.errors.some(
      (item) =>
        item.code === "GEO_AREA_CELL_OUT_OF_FRAME" &&
        item.path === `$.simulation.branches.${CANON}.geoTopology.areas[0].cells[0]`,
    ),
    JSON.stringify(outsideResult.errors),
  );

  const duplicatedCell = createEmptyTopology();
  duplicatedCell.areas.push(area("loc:class", "loc:school", [{ x: 1, y: 2 }, { x: 1, y: 2 }]));
  assert.ok(
    validateGeoTopology(duplicatedCell, { branchKey: CANON, locations, frame: FRAME }).errors.some(
      (item) => item.code === "GEO_AREA_CELL_DUPLICATE",
    ),
  );

  const fractional = createEmptyTopology();
  fractional.areas.push(area("loc:class", "loc:school", [{ x: 1.5, y: 2 }]));
  assert.ok(
    validateGeoTopology(fractional, { branchKey: CANON, locations, frame: FRAME }).errors.some(
      (item) => item.code === "GEO_AREA_CELL_INVALID",
    ),
  );

  const negative = createEmptyTopology();
  negative.areas.push(area("loc:class", "loc:school", [{ x: -1, y: 2 }]));
  assert.ok(
    validateGeoTopology(negative, { branchKey: CANON, locations, frame: FRAME }).errors.some(
      (item) => item.code === "GEO_AREA_CELL_INVALID",
    ),
  );

  const tooMany = createEmptyTopology();
  tooMany.areas.push(
    area(
      "loc:class",
      "loc:school",
      Array.from({ length: ATLAS_GEO_LIMITS.areaCells + 1 }, (_, i) => ({ x: i % 100, y: Math.floor(i / 100) })),
    ),
  );
  assert.ok(
    validateGeoTopology(tooMany, { branchKey: CANON, locations, frame: FRAME }).errors.some(
      (item) => item.code === "GEO_AREA_CELLS_EXCEEDED",
    ),
  );

  const twiceSameMap = createEmptyTopology();
  twiceSameMap.areas.push(area("loc:class", "loc:school", [{ x: 0, y: 0 }]));
  twiceSameMap.areas.push(area("loc:class", "loc:school", [{ x: 1, y: 1 }]));
  const twiceResult = validateGeoTopology(twiceSameMap, { branchKey: CANON, locations, frame: FRAME });
  assert.equal(twiceResult.ok, false);
  assert.ok(twiceResult.errors.some((item) => item.code === "GEO_AREA_DUPLICATE"), "一地点每图只有一块有效范围");

  const twoMaps = createEmptyTopology();
  twoMaps.areas.push(area("loc:city", "world", [{ x: 40, y: 40 }]));
  twoMaps.areas.push(area("loc:city", "loc:school", [{ x: 1, y: 1 }]));
  assert.equal(
    validateGeoTopology(twoMaps, { branchKey: CANON, locations, frame: FRAME }).errors.filter(
      (item) => item.code === "GEO_AREA_DUPLICATE",
    ).length,
    0,
    "同一地点在两张图各有一块是合法的",
  );

  const ghostArea = createEmptyTopology();
  ghostArea.areas.push(area("loc:ghost", "world", [{ x: 1, y: 1 }]));
  const ghostResult = validateGeoTopology(ghostArea, { branchKey: CANON, locations, frame: FRAME });
  assert.equal(ghostResult.ok, false);
  assert.ok(
    ghostResult.errors.some(
      (item) => item.code === "GEO_AREA_LOCATION_UNKNOWN" && item.path.endsWith("areas[0].locationId"),
    ),
  );

  const wrongId = createEmptyTopology();
  wrongId.areas.push({ ...area("loc:class", "loc:school", [{ x: 1, y: 1 }]), id: "手绘范围" });
  assert.ok(
    validateGeoTopology(wrongId, { branchKey: CANON, locations, frame: FRAME }).errors.some(
      (item) => item.code === "GEO_AREA_ID_MISMATCH",
    ),
  );
});

test("H02 area 的 cells 必须落在对应 frame 内；没给该图 frame 时不判越界", () => {
  const locations = baseLocations();
  const frames = { "loc:school": { cols: 5, rows: 5 } };

  const schoolArea = createEmptyTopology();
  schoolArea.areas.push(area("loc:class", "loc:school", [{ x: 6, y: 0 }]));
  const schoolResult = validateGeoTopology(schoolArea, { branchKey: CANON, locations, frames });
  assert.equal(schoolResult.ok, false);
  assert.ok(schoolResult.errors.some((item) => item.code === "GEO_AREA_CELL_OUT_OF_FRAME"));

  const worldArea = createEmptyTopology();
  worldArea.areas.push(area("loc:class", "world", [{ x: 6, y: 0 }]));
  assert.deepEqual(validateGeoTopology(worldArea, { branchKey: CANON, locations, frames }), {
    ok: true,
    errors: [],
  });

  const noFrame = createEmptyTopology();
  noFrame.areas.push(area("loc:class", "loc:school", [{ x: 999, y: 999 }]));
  assert.equal(
    validateGeoTopology(noFrame, { branchKey: CANON, locations }).ok,
    true,
    "没有 frame 就无从判界（写入口必须传 frame）",
  );

  const badFrame = createEmptyTopology();
  badFrame.areas.push(area("loc:class", "loc:school", [{ x: 1, y: 1 }]));
  const badFrameResult = validateGeoTopology(badFrame, {
    branchKey: CANON,
    locations,
    frame: { cols: 0, rows: 10 },
  });
  assert.equal(badFrameResult.ok, false);
  assert.ok(badFrameResult.errors.some((item) => item.code === "GEO_FRAME_INVALID"));
});

test("H02 vehicle：地点引用 / id=locationId / 停靠与在途字段 / routeEdgeId 必须匹配", () => {
  const options = CANON_OPTIONS();
  const vehicleEdge = vehicleRouteEdge();
  const base = () => {
    const topology = createEmptyTopology();
    topology.edges.push(vehicleEdge, roadEdge(), messageEdge());
    return topology;
  };

  const stopped = base();
  stopped.vehicles.push(vehicle("loc:vehicle", "stopped", "loc:city", null));
  assert.deepEqual(validateGeoTopology(stopped, options), { ok: true, errors: [] });

  const enRoute = base();
  enRoute.vehicles.push(vehicle("loc:vehicle", "en-route", null, vehicleEdge.id));
  assert.deepEqual(validateGeoTopology(enRoute, options), { ok: true, errors: [] });

  const unknown = base();
  unknown.vehicles.push(vehicle("loc:vehicle", "unknown", null, null));
  assert.deepEqual(validateGeoTopology(unknown, options), { ok: true, errors: [] });

  const cases = [
    [{ locationId: "loc:ghost", id: "loc:ghost" }, "GEO_VEHICLE_LOCATION_UNKNOWN"],
    [{ id: "vehicle-1" }, "GEO_VEHICLE_ID_MISMATCH"],
    [{ status: "flying" }, "GEO_VEHICLE_STATUS_INVALID"],
    [{ status: "stopped", atLocationId: null }, "GEO_VEHICLE_STOP_REQUIRED"],
    [{ status: "stopped", atLocationId: "loc:ghost" }, "GEO_VEHICLE_AT_UNKNOWN"],
    [{ status: "en-route", atLocationId: "loc:city", routeEdgeId: vehicleEdge.id }, "GEO_VEHICLE_AT_UNEXPECTED"],
    [{ status: "unknown", routeEdgeId: vehicleEdge.id }, "GEO_VEHICLE_ROUTE_STATUS"],
    [{ status: "stopped", atLocationId: "loc:city", routeEdgeId: vehicleEdge.id }, "GEO_VEHICLE_ROUTE_STATUS"],
    [{ status: "en-route", routeEdgeId: "geo-edge:missing" }, "GEO_VEHICLE_ROUTE_UNKNOWN"],
    [{ status: "en-route", routeEdgeId: messageEdge().id }, "GEO_VEHICLE_ROUTE_KIND"],
    [{ status: "en-route", routeEdgeId: roadEdge().id }, "GEO_VEHICLE_ROUTE_MISMATCH"],
  ];
  for (const [patch, code] of cases) {
    const topology = base();
    topology.vehicles.push({ ...vehicle("loc:vehicle", "stopped", "loc:city", null), ...patch });
    const result = validateGeoTopology(topology, options);
    assert.equal(result.ok, false, `应拒绝：${JSON.stringify(patch)}`);
    assert.ok(
      result.errors.some((item) => item.code === code),
      `${JSON.stringify(patch)} 期望 ${code}，实际 ${JSON.stringify(result.errors)}`,
    );
  }

  const overLimit = createEmptyTopology();
  for (let i = 0; i <= ATLAS_GEO_LIMITS.vehicles; i += 1) {
    overLimit.vehicles.push(vehicle(`loc:v${i}`, "unknown", null, null));
  }
  assert.ok(
    validateGeoTopology(overLimit, { branchKey: CANON, frame: FRAME }).errors.some(
      (item) => item.code === "GEO_LIMIT_EXCEEDED",
    ),
  );
});

test("H02 parent 链：自指 / 环 / 悬空 / 超过 4 层一律拒绝，正好 4 层合法", () => {
  const chain = (levels) => {
    const rows = [loc("loc:l0", "根")];
    for (let i = 1; i <= levels; i += 1) {
      rows.push(loc(`loc:l${i}`, `第${i}层`, { parentLocationId: `loc:l${i - 1}` }));
    }
    return rows;
  };

  const fourDeep = chain(4);
  const okTopology = createEmptyTopology();
  okTopology.edges.push(edge("adjacent", "loc:l4", "loc:l0", null));
  assert.deepEqual(validateGeoTopology(okTopology, { branchKey: CANON, locations: fourDeep, frame: FRAME }), {
    ok: true,
    errors: [],
  });
  assert.equal(ATLAS_GEO_PARENT_DEPTH_MAX, 4);

  const fiveDeep = chain(5);
  const tooDeep = createEmptyTopology();
  tooDeep.edges.push(edge("adjacent", "loc:l5", "loc:l0", null));
  const tooDeepResult = validateGeoTopology(tooDeep, { branchKey: CANON, locations: fiveDeep, frame: FRAME });
  assert.equal(tooDeepResult.ok, false);
  assert.ok(
    tooDeepResult.errors.some(
      (item) =>
        item.code === "GEO_LOCATION_DEPTH_EXCEEDED" &&
        item.path === `$.simulation.branches.${CANON}.geoTopology.edges[0].fromLocationId`,
    ),
    JSON.stringify(tooDeepResult.errors),
  );

  const selfParent = [loc("loc:s", "自指地点", { parentLocationId: "loc:s" })];
  const selfTopology = createEmptyTopology();
  selfTopology.edges.push(edge("adjacent", "loc:s", "loc:s2", null));
  const selfResult = validateGeoTopology(selfTopology, { branchKey: CANON, locations: selfParent, frame: FRAME });
  assert.equal(selfResult.ok, false);
  assert.ok(selfResult.errors.some((item) => item.code === "GEO_LOCATION_SELF_PARENT"));
  assert.ok(selfResult.errors.some((item) => item.code === "GEO_EDGE_LOCATION_UNKNOWN"));

  const cycle = [
    loc("loc:a", "甲", { parentLocationId: "loc:b" }),
    loc("loc:b", "乙", { parentLocationId: "loc:a" }),
  ];
  const cycleTopology = createEmptyTopology();
  cycleTopology.edges.push(edge("adjacent", "loc:a", "loc:b", null));
  const cycleResult = validateGeoTopology(cycleTopology, { branchKey: CANON, locations: cycle, frame: FRAME });
  assert.equal(cycleResult.ok, false);
  assert.ok(
    cycleResult.errors.some((item) => item.code === "GEO_LOCATION_PARENT_CYCLE"),
    JSON.stringify(cycleResult.errors),
  );

  const dangling = [loc("loc:x", "悬空", { parentLocationId: "loc:missing" })];
  const danglingTopology = createEmptyTopology();
  danglingTopology.areas.push(area("loc:x", "world", [{ x: 1, y: 1 }]));
  const danglingResult = validateGeoTopology(danglingTopology, {
    branchKey: CANON,
    locations: dangling,
    frame: FRAME,
  });
  assert.equal(danglingResult.ok, false);
  assert.ok(danglingResult.errors.some((item) => item.code === "GEO_LOCATION_PARENT_UNKNOWN"));
});

test("H02 同分支三表引用：同一 id 不能既是地点又是人物", () => {
  const characters = [npc("loc:city", "错位的人", "loc:class", { mapId: "loc:school" })];
  const result = validateGeoTopology(baseTopology(), {
    branchKey: CANON,
    locations: baseLocations(),
    characters,
    frame: FRAME,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (item) =>
        item.code === "GEO_LOCATION_ID_CONFLICT" &&
        item.path.startsWith(`$.simulation.branches.${CANON}.geoTopology.`),
    ),
    JSON.stringify(result.errors),
  );
});

test("H02 纯函数：坏输入被整体拒绝，但旧会话原文一字不改（可读可导出）", () => {
  const locations = baseLocations();
  const dirty = baseTopology();
  dirty.edges.push({
    id: "手工乱写的边",
    fromLocationId: "loc:ghost",
    toLocationId: "loc:ghost",
    kind: "communication",
    evidence: "story",
    channel: "walk",
  });
  dirty.areas.push(area("loc:class", "loc:school", [{ x: 500, y: 500 }, { x: 500, y: 500 }]));
  dirty.vehicles.push(vehicle("loc:vehicle", "stopped", null, null));
  const snapshot = structuredClone(dirty);

  const result = validateGeoTopology(dirty, CANON_OPTIONS());
  assert.equal(result.ok, false, "任何一条坏边或越界格都让候选写入被拒");
  assert.deepEqual(dirty, snapshot, "拒绝写入不得改动、清空或『顺手修好』原文");

  const codes = new Set(result.errors.map((item) => item.code));
  assert.ok(codes.has("GEO_EDGE_ID_MISMATCH"));
  assert.ok(codes.has("GEO_EDGE_SELF"));
  assert.ok(codes.has("GEO_COMMUNICATION_CHANNEL"));
  assert.ok(codes.has("GEO_AREA_CELL_OUT_OF_FRAME"));
  assert.ok(codes.has("GEO_AREA_CELL_DUPLICATE"));
  assert.ok(codes.has("GEO_VEHICLE_STOP_REQUIRED"));
  for (const item of result.errors) {
    assert.ok(
      item.path.startsWith(`$.simulation.branches.${CANON}.geoTopology`),
      `错误路径必须落在候选写入根下：${item.path}`,
    );
  }

  assert.ok(validateGeoTopology({ edges: [], areas: [], vehicles: [] }, CANON_OPTIONS()).ok);
  assert.equal(validateGeoTopology(null, CANON_OPTIONS()).errors[0].code, "GEO_NOT_OBJECT");
  assert.equal(validateGeoTopology("{}", CANON_OPTIONS()).errors[0].code, "GEO_NOT_OBJECT");
  assert.equal(
    validateGeoTopology({ edges: {}, areas: [], vehicles: [] }, CANON_OPTIONS()).errors[0].code,
    "GEO_COLLECTION_NOT_ARRAY",
  );
});

/* ------------------------------------------------------------------ *
 * H10：邻接表与 NO_PATH
 * ------------------------------------------------------------------ */

test("H10 邻接表只由已确认边构造：父链不是通道，通信边不是人物物理路线", () => {
  const topology = stoppedVehicleTopology();

  const all = buildEdgeAdjacency(topology);
  assert.equal(all.edgeCount, topology.edges.length);
  assert.equal(neighborsOf(all, "loc:school").length, 1, "学校只有一条 message 通信边");
  assert.equal(neighborsOf(all, "loc:school")[0].kind, "communication");
  assert.deepEqual(neighborsOf(all, "loc:class"), [], "容器子地点没有确认边 → 空，不许猜");

  const walkable = buildWalkableAdjacency(topology);
  assert.equal(neighborsOf(walkable, "loc:school").length, 0, "通信边不得作为人物物理路线");
  assert.equal(
    resolveGeoPath(topology, "loc:school", "loc:city", { mode: "walk" }).ok,
    false,
    "只有通信边也不能走过去",
  );
  assert.equal(resolveGeoPath(topology, "loc:school", "loc:city", { mode: "walk" }).reasonCode, "NO_PATH");
  assert.equal(resolveGeoPath(topology, "loc:school", "loc:city", { mode: "message" }).ok, true);
  assert.equal(resolveGeoPath(topology, "loc:school", "loc:city", { mode: "message" }).hops, 1);

  // 世界图上的相邻关系可以走；vehicle 模式只认 channel="vehicle" 的 route 边
  assert.equal(resolveGeoPath(topology, "loc:city", "loc:outer").hops, 1);
  assert.equal(resolveGeoPath(topology, "loc:city", "loc:outer", { mode: "vehicle" }).ok, false);
  assert.equal(resolveGeoPath(topology, "loc:vehicle", "loc:north", { mode: "vehicle" }).ok, true);
  assert.equal(resolveGeoPath(topology, "loc:city", "loc:gate", { mode: "walk" }).hops, 1);

  // 无边：同一个空拓扑里任何两点都是 NO_PATH，而不是"同一张图上就算到"
  const empty = createEmptyTopology();
  const noPath = resolveGeoPath(empty, "loc:city", "loc:market");
  assert.equal(noPath.ok, false);
  assert.equal(noPath.reasonCode, "NO_PATH");
  assert.equal(noPath.fromLocationId, "loc:city");
  assert.equal(noPath.toLocationId, "loc:market");
  assert.equal(resolveGeoPath(empty, "loc:city", "loc:city").hops, 0, "起点即终点不需要路");

  const multiHop = createEmptyTopology();
  multiHop.edges.push(edge("adjacent", "loc:city", "loc:gate", null));
  multiHop.edges.push(edge("adjacent", "loc:gate", "loc:north", null));
  const path = resolveGeoPath(multiHop, "loc:city", "loc:north");
  assert.equal(path.ok, true);
  assert.deepEqual([...path.path], ["loc:city", "loc:gate", "loc:north"]);
  assert.equal(path.hops, 2);
});

/* ------------------------------------------------------------------ *
 * H11：载具锚点移动
 * ------------------------------------------------------------------ */

test("H11 0 时段 / 状态不明 / 无锚点 / 路线不存在或未确认 → 车辆一动不动", () => {
  const locations = baseLocations();
  const characters = baseCharacters();
  const vehicleEdge = vehicleRouteEdge();
  const topology = stoppedVehicleTopology();
  const snapshot = structuredClone(topology);

  const noTime = moveVehicleAnchor({
    turnKey: "turn-1",
    topology,
    vehicleLocationId: "loc:vehicle",
    intent: { kind: "depart", routeEdgeId: vehicleEdge.id, toLocationId: "loc:north", remainingPeriods: 2 },
    periods: 0,
    locations,
    characters,
  });
  assert.deepEqual(noTime.next, snapshot, "0 时段不得移动车辆");
  assert.deepEqual(noTime.undo, []);
  assert.equal(noTime.events[0].status, "blocked");
  assert.equal(noTime.events[0].periods, 0);
  assert.equal(noTime.events[0].reasonCode, "NO_TIME");
  assert.equal(noTime.diagnostics[0].code, "NO_TIME");
  assert.equal(noTime.diagnostics[0].blocked, true);

  const unknownStatus = cloneGeoTopology(topology);
  unknownStatus.vehicles[0] = vehicle("loc:vehicle", "unknown", null, null);
  const unknownResult = moveVehicleAnchor({
    turnKey: "turn-1",
    topology: unknownStatus,
    vehicleLocationId: "loc:vehicle",
    intent: { kind: "depart", routeEdgeId: vehicleEdge.id, toLocationId: "loc:north", remainingPeriods: 2 },
    periods: 3,
    locations,
    characters,
  });
  assert.equal(unknownResult.diagnostics[0].code, "VEHICLE_NOT_ANCHORED");
  assert.deepEqual(unknownResult.next, unknownStatus);

  const noAnchor = moveVehicleAnchor({
    turnKey: "turn-1",
    topology: baseTopology(),
    vehicleLocationId: "loc:vehicle",
    intent: { kind: "depart", routeEdgeId: vehicleEdge.id, toLocationId: "loc:north", remainingPeriods: 2 },
    periods: 3,
    locations,
    characters,
  });
  assert.equal(noAnchor.diagnostics[0].code, "VEHICLE_ANCHOR_MISSING");
  assert.deepEqual(noAnchor.next, baseTopology());

  const missingRoute = moveVehicleAnchor({
    turnKey: "turn-1",
    topology,
    vehicleLocationId: "loc:vehicle",
    intent: { kind: "depart", routeEdgeId: "geo-edge:missing", toLocationId: "loc:north", remainingPeriods: 2 },
    periods: 3,
    locations,
    characters,
  });
  assert.equal(missingRoute.diagnostics[0].code, "ROUTE_NOT_FOUND");
  assert.deepEqual(missingRoute.next, snapshot);

  const messageRoute = moveVehicleAnchor({
    turnKey: "turn-1",
    topology,
    vehicleLocationId: "loc:vehicle",
    intent: { kind: "depart", routeEdgeId: messageEdge().id, toLocationId: "loc:city", remainingPeriods: 2 },
    periods: 3,
    locations,
    characters,
  });
  assert.equal(messageRoute.diagnostics[0].code, "ROUTE_NOT_CONFIRMED", "通信边不能当车的路线");
  assert.deepEqual(messageRoute.next, snapshot);

  const badPeriods = moveVehicleAnchor({
    turnKey: "turn-1",
    topology,
    vehicleLocationId: "loc:vehicle",
    intent: { kind: "depart", routeEdgeId: vehicleEdge.id, toLocationId: "loc:north", remainingPeriods: 0 },
    periods: 3,
    locations,
    characters,
  });
  assert.equal(badPeriods.diagnostics[0].code, "TRAVEL_PERIODS_INVALID");
  assert.deepEqual(badPeriods.next, snapshot);

  const badIntent = moveVehicleAnchor({
    turnKey: "turn-1",
    topology,
    vehicleLocationId: "loc:vehicle",
    intent: { kind: "stop", atLocationId: "loc:city" },
    periods: 3,
    locations,
    characters,
  });
  assert.equal(badIntent.diagnostics[0].code, "INTENT_INVALID");
  assert.deepEqual(badIntent.next, snapshot);

  const brokenTopology = moveVehicleAnchor({
    turnKey: "turn-1",
    topology: null,
    vehicleLocationId: "loc:vehicle",
    intent: { kind: "depart", routeEdgeId: vehicleEdge.id, toLocationId: "loc:north", remainingPeriods: 2 },
    periods: 3,
  });
  assert.equal(brokenTopology.diagnostics[0].code, "TOPOLOGY_INVALID");
  assert.deepEqual(brokenTopology.next, { edges: [], areas: [], vehicles: [] });
});

test("H11 停靠→在途→到达；两乘员跟车且相对车厢位置不变；undo 精确回退", () => {
  const locations = baseLocations();
  const characters = baseCharacters();
  const characterSnapshot = structuredClone(characters);
  const locationSnapshot = structuredClone(locations);
  const topology = stoppedVehicleTopology();
  const routeEdgeId = vehicleRouteEdge().id;

  /* 第 1 段：本段需要 2 个时段，本轮只有 1 个 → 在途 */
  const leg1 = moveVehicleAnchor({
    turnKey: "turn-7",
    topology,
    vehicleLocationId: "loc:vehicle",
    intent: { kind: "depart", routeEdgeId, toLocationId: "loc:north", remainingPeriods: 2 },
    periods: 1,
    period: 7,
    locations,
    characters,
  });
  assert.deepEqual(leg1.diagnostics, []);
  assert.equal(leg1.events.length, 1);
  assert.equal(leg1.events[0].status, "started");
  assert.equal(leg1.events[0].statusBefore, "stopped");
  assert.equal(leg1.events[0].statusAfter, "en-route");
  assert.equal(leg1.events[0].fromLocationId, "loc:city");
  assert.equal(leg1.events[0].toLocationId, "loc:north");
  assert.equal(leg1.events[0].periods, 1);
  assert.equal(leg1.events[0].remainingPeriods, 1);
  assert.equal(leg1.events[0].period, 7);
  assert.deepEqual([...leg1.events[0].crewCharacterIds], ["npc:a", "npc:b"]);

  const enRoute = leg1.next.vehicles[0];
  assert.equal(enRoute.status, "en-route");
  assert.equal(enRoute.atLocationId, null);
  assert.equal(enRoute.routeEdgeId, routeEdgeId);
  assert.deepEqual(leg1.undo, [
    {
      collection: "vehicles",
      id: "loc:vehicle",
      before: {
        id: "loc:vehicle",
        locationId: "loc:vehicle",
        atLocationId: "loc:city",
        routeEdgeId: null,
        status: "stopped",
        evidence: "story",
      },
    },
  ]);

  // 乘员仍住在车厢子地点：相对车厢的位置不变，读世界位置只能经锚点解析
  const crewEnRoute = resolveVehicleCrew(leg1.next, "loc:vehicle", locations, characters);
  assert.equal(crewEnRoute.status, "en-route");
  assert.equal(crewEnRoute.routeEdgeId, routeEdgeId);
  assert.deepEqual(
    crewEnRoute.members.map((m) => [m.characterId, m.locationId, m.mapId, m.gridX, m.gridY, m.inCabin]),
    [
      ["npc:a", "loc:cabin", "loc:vehicle", 3, 4, true],
      ["npc:b", "loc:cabin", "loc:vehicle", 5, 6, true],
    ],
  );

  /* 第 2 段：本段还差 1 个时段，本轮有 3 个 → 到达，剩余 2 个如实报出 */
  const leg2 = moveVehicleAnchor({
    turnKey: "turn-7",
    eventIndex: 1,
    topology: leg1.next,
    vehicleLocationId: "loc:vehicle",
    intent: { kind: "depart", routeEdgeId, toLocationId: "loc:north", remainingPeriods: 1 },
    periods: 3,
    period: 8,
    locations,
    characters,
  });
  assert.deepEqual(leg2.diagnostics, []);
  assert.equal(leg2.events[0].status, "arrived");
  assert.equal(leg2.events[0].statusBefore, "en-route");
  assert.equal(leg2.events[0].periods, 1, "到达只消耗本段真正需要的时段");
  assert.equal(leg2.events[0].leftoverPeriods, 2);
  assert.equal(leg2.events[0].remainingPeriods, 0);
  assert.notEqual(leg2.events[0].id, leg1.events[0].id, "同 turnKey 内事件 id 不撞");

  const arrived = leg2.next.vehicles[0];
  assert.equal(arrived.status, "stopped");
  assert.equal(arrived.atLocationId, "loc:north");
  assert.equal(arrived.routeEdgeId, null);

  const crewArrived = resolveVehicleCrew(leg2.next, "loc:vehicle", locations, characters);
  assert.equal(crewArrived.atLocationId, "loc:north");
  assert.deepEqual(
    crewArrived.members.map((m) => [m.characterId, m.locationId, m.mapId, m.gridX, m.gridY]),
    [
      ["npc:a", "loc:cabin", "loc:vehicle", 3, 4],
      ["npc:b", "loc:cabin", "loc:vehicle", 5, 6],
    ],
    "整辆车移动不重新制造每人的世界坐标",
  );

  // 移动前后的两份锚点都必须能过 H02（同一口径，H11 的输出永远可写）
  assert.deepEqual(validateGeoTopology(leg1.next, CANON_OPTIONS()), { ok: true, errors: [] });
  assert.deepEqual(validateGeoTopology(leg2.next, CANON_OPTIONS()), { ok: true, errors: [] });

  // 人物行与手工坐标一个字段都没动
  assert.deepEqual(characters, characterSnapshot);
  assert.deepEqual(locations, locationSnapshot);

  /* 回退：同一 turn 多次移动时按 id 取最早一项的 before 合并即整轮还原（C10 口径） */
  assert.equal(leg1.undo[0].before.status, "stopped", "第一段的 before 是原停靠行");
  assert.equal(leg2.undo[0].before.status, "en-route", "第二段的 before 是它自己动手前的行");
  const merged = new Map();
  for (const entry of [...leg1.undo, ...leg2.undo]) {
    assert.equal(entry.collection, "vehicles");
    if (!merged.has(entry.id)) merged.set(entry.id, entry);
  }
  const restored = cloneGeoTopology(leg2.next);
  for (const entry of merged.values()) {
    const restoredRow = undoVehicleBefore(entry);
    assert.notEqual(restoredRow, null);
    const slot = restored.vehicles.findIndex((item) => item.id === entry.id);
    assert.ok(slot >= 0);
    restored.vehicles[slot] = restoredRow;
  }
  assert.deepEqual(restored, topology, "swipe 后两个乘员回到原车（原停靠点）位置");
  assert.deepEqual(resolveVehicleCrew(restored, "loc:vehicle", locations, characters).members.length, 2);
});

test("H11 在途不许换路、终点必须是该边另一端、已在终点不再走", () => {
  const locations = baseLocations();
  const characters = baseCharacters();
  const routeEdgeId = vehicleRouteEdge().id;
  const enRouteTopology = cloneGeoTopology(stoppedVehicleTopology());
  enRouteTopology.vehicles[0] = vehicle("loc:vehicle", "en-route", null, routeEdgeId);

  const switchRoad = moveVehicleAnchor({
    turnKey: "turn-9",
    topology: enRouteTopology,
    vehicleLocationId: "loc:vehicle",
    intent: { kind: "depart", routeEdgeId: roadEdge().id, toLocationId: "loc:gate", remainingPeriods: 1 },
    periods: 2,
    locations,
    characters,
  });
  assert.equal(switchRoad.diagnostics[0].code, "ROUTE_MISMATCH");
  assert.deepEqual(switchRoad.undo, []);
  assert.deepEqual(switchRoad.next, enRouteTopology);

  const wrongDestination = moveVehicleAnchor({
    turnKey: "turn-9",
    topology: stoppedVehicleTopology(),
    vehicleLocationId: "loc:vehicle",
    intent: { kind: "depart", routeEdgeId, toLocationId: "loc:gate", remainingPeriods: 1 },
    periods: 2,
    locations,
    characters,
  });
  assert.equal(wrongDestination.diagnostics[0].code, "ROUTE_MISMATCH", "终点不是这条边的另一端");

  const foreignRoad = moveVehicleAnchor({
    turnKey: "turn-9",
    topology: stoppedVehicleTopology(),
    vehicleLocationId: "loc:vehicle",
    intent: { kind: "depart", routeEdgeId: roadEdge().id, toLocationId: "loc:gate", remainingPeriods: 1 },
    periods: 2,
    locations,
    characters,
  });
  assert.equal(foreignRoad.diagnostics[0].code, "ROUTE_MISMATCH", "这条 route 边不属于这辆车");

  const alreadyThere = moveVehicleAnchor({
    turnKey: "turn-9",
    topology: (() => {
      const atDestination = cloneGeoTopology(stoppedVehicleTopology());
      atDestination.vehicles[0] = vehicle("loc:vehicle", "stopped", "loc:north", null);
      return atDestination;
    })(),
    vehicleLocationId: "loc:vehicle",
    intent: { kind: "depart", routeEdgeId, toLocationId: "loc:north", remainingPeriods: 1 },
    periods: 2,
    locations,
    characters,
  });
  assert.equal(alreadyThere.diagnostics[0].code, "ROUTE_MISMATCH", "已在该段终点停靠，不必再走一次");

  // 终点必须在地点表里可解析（给了地点表才做这一步）
  const partialLocations = [loc("loc:vehicle", "蒸汽马车厢"), loc("loc:city", "圣罗兰城")];
  const unknownDestination = moveVehicleAnchor({
    turnKey: "turn-9",
    topology: stoppedVehicleTopology(),
    vehicleLocationId: "loc:vehicle",
    intent: { kind: "depart", routeEdgeId, toLocationId: "loc:north", remainingPeriods: 1 },
    periods: 2,
    locations: partialLocations,
    characters,
  });
  assert.equal(unknownDestination.diagnostics[0].code, "LOCATION_UNKNOWN");
  assert.equal(unknownDestination.diagnostics[0].blocked, true);
  assert.deepEqual(unknownDestination.undo, []);
});

test("H11 耗时不可信（remainingPeriods=null）只进在途，绝不到达", () => {
  const locations = baseLocations();
  const characters = baseCharacters();
  const routeEdgeId = vehicleRouteEdge().id;

  const leg = moveVehicleAnchor({
    turnKey: "turn-11",
    topology: stoppedVehicleTopology(),
    vehicleLocationId: "loc:vehicle",
    intent: { kind: "depart", routeEdgeId, toLocationId: "loc:north", remainingPeriods: null },
    periods: 5,
    locations,
    characters,
  });

  assert.equal(leg.events[0].status, "started");
  assert.equal(leg.events[0].periods, 5);
  assert.equal(leg.events[0].remainingPeriods, null, "没有可信耗时就不许写到达");
  assert.equal(leg.next.vehicles[0].status, "en-route");
  assert.equal(leg.next.vehicles[0].atLocationId, null);
  assert.equal(leg.next.vehicles[0].routeEdgeId, routeEdgeId);
  assert.equal(leg.diagnostics.length, 1);
  assert.equal(leg.diagnostics[0].code, "TRAVEL_PERIODS_UNKNOWN");
  assert.equal(leg.diagnostics[0].blocked, false, "只是信息性诊断，不是拒绝");
  assert.deepEqual(validateGeoTopology(leg.next, CANON_OPTIONS()), { ok: true, errors: [] });
});

/* ------------------------------------------------------------------ *
 * 分支 / 聊天隔离 与 手动坐标保留
 * ------------------------------------------------------------------ */

test("IF / 聊天隔离：ID 与错误路径都带分支，同一份候选不会跨分支通过", () => {
  const locations = baseLocations();
  const characters = baseCharacters();
  const canonTopology = baseTopology();

  assert.deepEqual(validateGeoTopology(canonTopology, { branchKey: CANON, locations, characters, frame: FRAME }), {
    ok: true,
    errors: [],
  });

  const ifResult = validateGeoTopology(canonTopology, {
    branchKey: IF_BRANCH,
    locations,
    characters,
    frame: FRAME,
  });
  assert.equal(ifResult.ok, false, "正史分支的边不能写进 IF 分支");
  assert.ok(ifResult.errors.every((item) => item.path.startsWith(`$.simulation.branches.${IF_BRANCH}.geoTopology`)));
  assert.ok(ifResult.errors.some((item) => item.code === "GEO_EDGE_ID_MISMATCH"));
  assert.ok(ifResult.errors.some((item) => item.code === "GEO_AREA_ID_MISMATCH"));

  // IF 分支自己的拓扑（ID 由 IF 分支生成）合法，且与正史互不影响
  const ifTopology = createEmptyTopology();
  ifTopology.edges.push({
    id: geoEdgeId(IF_BRANCH, "loc:city", "loc:outer", "adjacent"),
    fromLocationId: "loc:city",
    toLocationId: "loc:outer",
    kind: "adjacent",
    evidence: "manual",
    channel: null,
  });
  assert.deepEqual(validateGeoTopology(ifTopology, { branchKey: IF_BRANCH, locations, characters, frame: FRAME }), {
    ok: true,
    errors: [],
  });
  assert.deepEqual(validateGeoTopology(canonTopology, { branchKey: CANON, locations, characters, frame: FRAME }), {
    ok: true,
    errors: [],
  }, "另一个分支的校验不留下任何跨会话状态");
  assert.notEqual(
    geoEdgeId(CANON, "loc:city", "loc:outer", "adjacent"),
    geoEdgeId(IF_BRANCH, "loc:city", "loc:outer", "adjacent"),
  );
});

test("手动坐标与手工范围一律保留：校验和移动都不改写三表与已保存的格坐标", () => {
  const locations = baseLocations();
  const characters = baseCharacters();
  const topology = stoppedVehicleTopology();
  const locationSnapshot = structuredClone(locations);
  const characterSnapshot = structuredClone(characters);
  const topologySnapshot = structuredClone(topology);

  validateGeoTopology(topology, CANON_OPTIONS());
  moveVehicleAnchor({
    turnKey: "turn-13",
    topology,
    vehicleLocationId: "loc:vehicle",
    intent: { kind: "depart", routeEdgeId: vehicleRouteEdge().id, toLocationId: "loc:north", remainingPeriods: 1 },
    periods: 1,
    locations,
    characters,
  });

  assert.deepEqual(locations, locationSnapshot, "人工已有格坐标不得被自动布点重排");
  assert.deepEqual(characters, characterSnapshot, "确认在教室但缺室内坐标的人不被塞进 (0,0)");
  assert.deepEqual(topology, topologySnapshot, "纯函数不改入参拓扑");
  assert.equal(characters.find((row) => row.id === "npc:c").gridX, null);
  assert.equal(characters.find((row) => row.id === "npc:c").gridY, null);
  assert.deepEqual(topology.areas[0].cells, [{ x: 3, y: 4 }], "手工涂的范围原样保留");
  assert.equal(locations.find((row) => row.id === "loc:vehicle").gridX, null, "载具不伪装成世界图固定点");
});
