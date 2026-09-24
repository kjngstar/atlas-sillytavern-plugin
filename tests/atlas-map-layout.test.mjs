/**
 * atlas-map-layout.test.mjs — H08 / H15 定向验收（示意排版 + 填色投影）。
 *
 * 覆盖计划原文里的硬性完成条件：
 * - H08：无坐标地点**不落 (0,0)**；同一分支 / 相同实体 ID / 相同 frame 重绘布局不跳动；
 *   不能回写地点表 / world；已有真实坐标不被改写；视觉避让只挪示意点；displayOnly 标记正确；
 *   重开地图 / 改窗口不能把房间搬进世界图、也不能让车厢变成永久点。
 * - H15：没有 areas 的地图一格都不许假染；只有地点中心时只返回 displayOnly 弱光圈
 *   （绝不返回物理 boundary）；默认透明度 ≤ 0.18；未知格保持透明；势力 / 热区只按已确证
 *   locationId 聚合。
 *
 * 运行：node --test --no-warnings=ExperimentalWarning --experimental-strip-types tests/atlas-map-layout.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ATLAS_MAP_LAYOUT_LIMITS,
  layoutUnplacedMarkers,
} from "../src/atlas-map-layout.ts";
import {
  COLOR_AREA_DEFAULT_OPACITY,
  COLOR_AREA_MAX_OPACITY,
  projectColorAreas,
} from "../src/atlas-map-areas.ts";

const WORLD_FRAME = { cols: 100, rows: 100 };

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function unplaced(id, overrides = {}) {
  return { id, name: overrides.name ?? id, ...overrides };
}

function layoutInput(overrides = {}) {
  return {
    branchKey: "canon",
    mapId: "world",
    frame: { ...WORLD_FRAME },
    confirmed: [],
    unplaced: [],
    vehicles: [],
    ...overrides,
  };
}

function colorArea(id, locationId, cells, evidence = "manual", mapId = "world") {
  return { id, locationId, mapId, cells, evidence };
}

function areaInput(overrides = {}) {
  return {
    mapId: "world",
    frame: { ...WORLD_FRAME },
    topology: { edges: [], areas: [], vehicles: [] },
    ...overrides,
  };
}

/** 冻结输入：函数若试图写入就抛 TypeError（ESM 严格模式），以此证明无副作用。 */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const markerAt = (result, id) => result.displayOnly.find((marker) => marker.id === id) ?? null;

// ---------------------------------------------------------------------------
// H08：示意排版
// ---------------------------------------------------------------------------

test("H08：无坐标地点不落 (0,0)，示意点带 displayOnly/schematic 标记且在图内不重叠", () => {
  const ids = Array.from({ length: 40 }, (_, index) => `loc:${9000 + index}`);
  const result = layoutUnplacedMarkers(layoutInput({ unplaced: ids.map((id) => unplaced(id)) }));

  assert.equal(result.displayOnly.length, 40);
  for (const marker of result.displayOnly) {
    assert.equal(marker.displayOnly, true);
    assert.equal(marker.coordinateStatus, "schematic");
    assert.ok(!(marker.x === 0 && marker.y === 0), `${marker.id} 不得冒充 (0,0)`);
    assert.ok(Number.isInteger(marker.x) && Number.isInteger(marker.y), "示意格必须是整数格");
    assert.ok(marker.x >= 0 && marker.x < WORLD_FRAME.cols, "示意点必须在 frame 内（x）");
    assert.ok(marker.y >= 0 && marker.y < WORLD_FRAME.rows, "示意点必须在 frame 内（y）");
  }
  assert.equal(new Set(result.displayOnly.map((marker) => `${marker.x},${marker.y}`)).size, 40, "同一图内示意点不互相压点");
  assert.equal(result.counts.candidates, 40);
  assert.equal(result.counts.displayOnlyTotal, 40);
  assert.equal(result.counts.truncated, 0);
  assert.deepEqual(result.confirmed, []);
  assert.deepEqual(result.collisionPoints, [], "没有任何真实坐标时碰撞点集为空");
});

test("H08：重开地图 / 改窗口（乱序输入 + 额外 viewport）布局逐字节稳定", () => {
  const unplacedRows = Array.from({ length: 12 }, (_, index) => unplaced(`loc:${9100 + index}`));
  const confirmedRows = [
    { id: "loc:4101", x: 20, y: 20 },
    { id: "loc:4103", x: 53, y: 42 },
    { id: "loc:4104", x: 53, y: 42 },
  ];
  const first = layoutUnplacedMarkers(layoutInput({ unplaced: unplacedRows, confirmed: confirmedRows }));
  const again = layoutUnplacedMarkers(layoutInput({ unplaced: unplacedRows, confirmed: confirmedRows }));
  const shuffled = layoutUnplacedMarkers({
    ...layoutInput({ unplaced: [...unplacedRows].reverse(), confirmed: [...confirmedRows].reverse() }),
    // 窗口尺寸根本不进计算：额外字段不改变任何输出字节
    viewport: { width: 320, height: 640 },
    window: { devicePixelRatio: 2 },
  });

  assert.equal(first.displayOnly.length, 12);
  assert.equal(JSON.stringify(again), JSON.stringify(first), "重开地图逐字节一致");
  assert.equal(JSON.stringify(shuffled), JSON.stringify(first), "调整窗口 / 输入顺序都不改变布局");
});

test("H08：已有真实坐标不被改写；视觉避让只挪示意点，碰撞检测仍只读真实坐标", () => {
  const target = "loc:9200";
  const before = layoutUnplacedMarkers(layoutInput({ unplaced: [unplaced(target)] }));
  const schematic = markerAt(before, target);
  assert.ok(schematic, "缺坐标地点应拿到示意位置");

  // 把一块真实坐标放在示意点本来会占用的格上
  const realPoint = { id: "loc:4103", x: schematic.x, y: schematic.y };
  const after = layoutUnplacedMarkers(layoutInput({ confirmed: [realPoint], unplaced: [unplaced(target)] }));

  assert.deepEqual(after.confirmed, [
    { id: "loc:4103", x: realPoint.x, y: realPoint.y, displayOnly: false, coordinateStatus: "confirmed" },
  ], "人工坐标必须原样保留");
  assert.deepEqual(after.collisionPoints, [{ id: "loc:4103", x: realPoint.x, y: realPoint.y }]);
  const moved = markerAt(after, target);
  assert.ok(moved, "避让后示意点仍然存在");
  assert.notDeepEqual({ x: moved.x, y: moved.y }, { x: realPoint.x, y: realPoint.y }, "示意点必须让开真实坐标");
  assert.ok(after.displayOnly.every((marker) => !after.collisionPoints.some((point) => point.x === marker.x && point.y === marker.y && point.id === marker.id)));
  assert.ok(after.collisionPoints.every((point) => !point.displayOnly), "碰撞点集里不能出现示意点");
});

test("H08：房间不被搬进世界图，车厢不变成永久点", () => {
  const vehicles = [
    { id: "loc:9301", locationId: "loc:9301", atLocationId: "loc:4101", routeEdgeId: "edge:1", status: "en-route", evidence: "story" },
    { id: "loc:9302", locationId: "loc:9302", atLocationId: null, routeEdgeId: null, status: "unknown", evidence: "story" },
    { id: "loc:9303", locationId: "loc:9303", atLocationId: "loc:4101", routeEdgeId: null, status: "stopped", evidence: "story" },
  ];
  const result = layoutUnplacedMarkers(layoutInput({
    confirmed: [{ id: "loc:4101", x: 20, y: 20 }],
    vehicles,
    unplaced: [
      unplaced("loc:4301", { mapId: "loc:4103", name: "三年二班" }), // 教室：宿主图是学校子图
      unplaced("loc:9301", { mobile: "vehicle" }), // 在途
      unplaced("loc:9302", { mobile: "vehicle" }), // 锚点状态未知
      unplaced("loc:9303", { mobile: "vehicle", anchorId: "loc:4101" }), // 已确认停靠
      unplaced("loc:9400", { mobile: "vehicle" }), // 载具本体但拓扑里没有锚点
      unplaced("loc:9500", { mapId: "world" }),
    ],
  }));

  const reasons = Object.fromEntries(result.pending.map((entry) => [entry.id, entry.reason]));
  assert.equal(reasons["loc:4301"], "WRONG_MAP");
  assert.equal(reasons["loc:9301"], "VEHICLE_EN_ROUTE");
  assert.equal(reasons["loc:9302"], "VEHICLE_ANCHOR_UNKNOWN");
  assert.equal(reasons["loc:9400"], "VEHICLE_ANCHOR_UNKNOWN");
  assert.equal(markerAt(result, "loc:4301"), null, "房间不得出现在世界图示意点里");
  assert.equal(markerAt(result, "loc:9301"), null, "在途载具不得有固定点");
  assert.equal(markerAt(result, "loc:9302"), null, "状态未知载具不得有固定点");

  const stopped = markerAt(result, "loc:9303");
  assert.ok(stopped, "已确认停靠的载具可以挂示意位置");
  assert.equal(stopped.anchorId, "loc:4101");
  assert.ok(Math.max(Math.abs(stopped.x - 20), Math.abs(stopped.y - 20)) <= 2, "停靠示意位置应贴在停靠点旁");
  assert.ok(!(stopped.x === 0 && stopped.y === 0));
  assert.ok(markerAt(result, "loc:9500"), "本图缺坐标的普通地点照常排版");
});

test("H08：分页给 total/truncated，不静默裁", () => {
  const rows = Array.from({ length: 12 }, (_, index) => unplaced(`loc:${9600 + index}`));
  const result = layoutUnplacedMarkers(layoutInput({ unplaced: rows, limit: 5 }));

  assert.equal(result.displayOnly.length, 5);
  assert.equal(result.counts.candidates, 12);
  assert.equal(result.counts.displayOnlyTotal, 12);
  assert.equal(result.counts.truncated, 7);
  assert.equal(result.counts.limit, 5);
  assert.equal(result.counts.slotCapacity, ATLAS_MAP_LAYOUT_LIMITS.slotsPerLayout);
  assert.equal(result.pending.length, 7);
  assert.ok(result.pending.every((entry) => entry.reason === "OVER_PAGE_LIMIT"));
});

test("H08：frame 非法或过小只出待定位名单，不硬造位置", () => {
  const tooSmall = layoutUnplacedMarkers(layoutInput({ frame: { cols: 2, rows: 2 }, unplaced: [unplaced("loc:9700")] }));
  assert.equal(tooSmall.displayOnly.length, 0);
  assert.equal(tooSmall.pending[0].reason, "NO_SLOT");
  assert.equal(tooSmall.counts.slotCapacity, 0);

  const broken = layoutUnplacedMarkers(layoutInput({ frame: { cols: Number.NaN, rows: 100 }, unplaced: [unplaced("loc:9701")] }));
  assert.equal(broken.displayOnly.length, 0);
  assert.equal(broken.pending[0].reason, "NO_FRAME");
  assert.deepEqual(broken.frame, { cols: 0, rows: 100 });
});

test("H08：纯函数（冻结输入可调用、不改输入）且源码不读时钟 / 随机源", () => {
  const input = deepFreeze(layoutInput({
    confirmed: [{ id: "loc:4101", x: 20, y: 20 }, { id: "loc:4102", x: Number.NaN, y: 3 }],
    vehicles: [{ id: "loc:9301", locationId: "loc:9301", atLocationId: null, routeEdgeId: null, status: "en-route", evidence: "story" }],
    unplaced: [
      unplaced("loc:9800"),
      unplaced("loc:9801", { mobile: "vehicle" }),
      unplaced("loc:9802", { mapId: "loc:4103" }),
      unplaced("", {}),
    ],
  }));
  const snapshot = JSON.stringify(input);
  const first = layoutUnplacedMarkers(input);

  assert.equal(JSON.stringify(input), snapshot, "不得修改输入对象");
  assert.equal(JSON.stringify(layoutUnplacedMarkers(input)), JSON.stringify(first), "同一输入重复调用逐字节一致");
  assert.equal(first.droppedConfirmed.length, 1, "非法真实坐标进 droppedConfirmed，不静默丢");
  assert.equal(first.droppedConfirmed[0].reason, "INVALID_COORDINATE");
  assert.ok(first.pending.some((entry) => entry.reason === "INVALID_ID"));

  const source = readFileSync(new URL("../src/atlas-map-layout.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Math\.random|Date\.now|performance\.now/, "布局不得依赖随机数或时钟");
});

// ---------------------------------------------------------------------------
// H15：填色投影
// ---------------------------------------------------------------------------

test("H15：没有 areas 的地图一格都不假染", () => {
  const empty = projectColorAreas(areaInput());
  assert.equal(empty.counts.paintedCells, 0);
  assert.equal(empty.areas.length, 0);
  assert.equal(empty.halos.length, 0);

  const missingTopology = projectColorAreas(areaInput({ topology: null }));
  assert.equal(missingTopology.counts.paintedCells, 0);

  const emptyCells = projectColorAreas(areaInput({ topology: { areas: [colorArea("canon|world|loc:A", "loc:A", [])] } }));
  assert.equal(emptyCells.counts.paintedCells, 0);
  assert.equal(emptyCells.areas.length, 0);
  assert.equal(emptyCells.skipped[0].reason, "NO_CELLS_NO_CENTER");

  const outOfFrame = projectColorAreas(areaInput({
    topology: { areas: [colorArea("canon|world|loc:B", "loc:B", [{ x: 150, y: 5 }, { x: -1, y: 3 }])] },
  }));
  assert.equal(outOfFrame.counts.paintedCells, 0);
  assert.equal(outOfFrame.counts.droppedCells, 2);
  assert.ok(outOfFrame.droppedCells.every((entry) => entry.reason === "OUT_OF_FRAME"));

  const brokenFrame = projectColorAreas(areaInput({
    frame: { cols: 0, rows: 100 },
    topology: { areas: [colorArea("canon|world|loc:A", "loc:A", [{ x: 0, y: 0 }])] },
  }));
  assert.equal(brokenFrame.counts.paintedCells, 0, "frame 非法时一格都不染");
});

test("H15：只把已证实 cells 投影为合并填区（含 evidence / areaId）", () => {
  const topology = { areas: [colorArea("canon|world|loc:4103", "loc:4103", [{ x: 10, y: 10 }, { x: 11, y: 10 }], "worldbook")] };
  const result = projectColorAreas(areaInput({ topology }));

  assert.equal(result.areas.length, 1);
  const region = result.areas[0];
  assert.equal(region.areaId, "canon|world|loc:4103");
  assert.equal(region.locationId, "loc:4103");
  assert.equal(region.evidence, "worldbook");
  assert.equal(region.layer, "area");
  assert.equal(region.cellCount, 2);
  assert.equal(region.subpaths, 1, "相邻格必须合并成一条外轮廓");
  assert.equal(region.path, "M 10 10 L 11 10 L 12 10 L 12 11 L 11 11 L 10 11 Z");
  assert.ok(region.opacity <= COLOR_AREA_MAX_OPACITY);

  const split = projectColorAreas(areaInput({
    topology: { areas: [colorArea("canon|world|loc:4104", "loc:4104", [{ x: 1, y: 1 }, { x: 8, y: 8 }], "story")] },
  }));
  assert.equal(split.areas[0].subpaths, 2, "不连通的格集合给多段");
  assert.equal(split.areas[0].cellCount, 2);
  assert.equal(split.counts.paintedCells, 2);

  // 中间空一格（洞）与对角相接：合并算法必须收敛并给出可填充的几何，不能挂死
  const ringCells = [];
  for (let x = 0; x < 3; x += 1) {
    for (let y = 0; y < 3; y += 1) {
      if (!(x === 1 && y === 1)) ringCells.push({ x, y });
    }
  }
  const ring = projectColorAreas(areaInput({
    frame: { cols: 10, rows: 10 },
    topology: { areas: [colorArea("canon|world|loc:R", "loc:R", ringCells, "manual")] },
  }));
  assert.equal(ring.areas[0].subpaths, 2, "带洞的格集合 = 外轮廓 + 洞轮廓");
  assert.equal(ring.counts.paintedCells, 8);

  const pinch = projectColorAreas(areaInput({
    frame: { cols: 10, rows: 10 },
    topology: { areas: [colorArea("canon|world|loc:P", "loc:P", [{ x: 0, y: 0 }, { x: 1, y: 1 }], "manual")] },
  }));
  assert.equal(pinch.areas[0].subpaths, 2, "对角相接仍然是两个闭环");
  assert.equal(pinch.areas[0].cellCount, 2);
});

test("H15：只有地点中心 → displayOnly 弱光圈，绝不返回物理 boundary", () => {
  const centered = projectColorAreas(areaInput({
    topology: { areas: [] },
    locationCenters: [{ locationId: "loc:4103", x: 20, y: 30 }],
  }));
  assert.equal(centered.areas.length, 0);
  assert.equal(centered.counts.paintedCells, 0);
  assert.equal(centered.halos.length, 1);
  const halo = centered.halos[0];
  assert.equal(halo.displayOnly, true);
  assert.equal(halo.boundary, null);
  assert.equal("path" in halo, false, "光圈不得带任何填区几何");
  assert.equal(halo.evidence, null, "纯中心点聚合不编造证据");
  assert.equal(halo.areaId, "");
  assert.equal(halo.locationId, "loc:4103");
  assert.equal(halo.layer, "area", "没有更具体图层归属的中心点留在区块层");
  assert.deepEqual({ x: halo.x, y: halo.y }, { x: 20, y: 30 });
  assert.ok(halo.opacity <= COLOR_AREA_MAX_OPACITY);

  const emptyCells = projectColorAreas(areaInput({
    topology: { areas: [colorArea("canon|world|loc:4103", "loc:4103", [], "story")] },
    locationCenters: [{ locationId: "loc:4103", x: 20, y: 30 }],
  }));
  assert.equal(emptyCells.areas.length, 0);
  assert.equal(emptyCells.halos[0].areaId, "canon|world|loc:4103");
  assert.equal(emptyCells.halos[0].evidence, "story");
  assert.equal(emptyCells.halos[0].boundary, null);

  const outside = projectColorAreas(areaInput({ locationCenters: [{ locationId: "loc:9", x: 500, y: 5 }] }));
  assert.equal(outside.halos.length, 0);
  assert.equal(outside.skipped[0].reason, "CENTER_OUT_OF_FRAME");
});

test("H15：默认透明度 ≤ 0.18 且是上限；未证实 evidence 不染", () => {
  const cells = [{ x: 5, y: 5 }];
  const base = projectColorAreas(areaInput({ topology: { areas: [colorArea("canon|world|loc:A", "loc:A", cells)] } }));
  assert.equal(base.opacity, COLOR_AREA_DEFAULT_OPACITY);
  assert.equal(base.areas[0].opacity, COLOR_AREA_DEFAULT_OPACITY);

  const tooHigh = projectColorAreas(areaInput({
    opacity: 0.9,
    topology: { areas: [colorArea("canon|world|loc:A", "loc:A", cells)] },
  }));
  assert.equal(tooHigh.opacity, COLOR_AREA_MAX_OPACITY);
  assert.ok(tooHigh.areas[0].opacity <= 0.18, "透明度上限是硬约束");

  const lower = projectColorAreas(areaInput({
    opacity: 0.05,
    topology: { areas: [colorArea("canon|world|loc:A", "loc:A", cells)] },
  }));
  assert.equal(lower.opacity, 0.05);

  const guessed = projectColorAreas(areaInput({ topology: { areas: [colorArea("canon|world|loc:A", "loc:A", cells, "guessed")] } }));
  assert.equal(guessed.counts.paintedCells, 0);
  assert.equal(guessed.skipped[0].reason, "UNVERIFIED_EVIDENCE");
});

test("H15：跨图 / 跨分支 / 重复 / 超上限的 area 不投影，原因逐条可见", () => {
  const topology = {
    areas: [
      colorArea("canon|loc:4103|loc:A", "loc:A", [{ x: 1, y: 1 }], "manual", "loc:4103"),
      colorArea("if-1|world|loc:B", "loc:B", [{ x: 2, y: 2 }], "manual", "world"),
      colorArea("canon|world|loc:C", "loc:C", [{ x: 3, y: 3 }], "manual", "world"),
      colorArea("canon|world|loc:C", "loc:C", [{ x: 4, y: 4 }], "manual", "world"),
      colorArea("canon|world|loc:D", "loc:D", [{ x: 5, y: 5 }], "manual", "world"),
    ],
  };
  const result = projectColorAreas(areaInput({ topology, branchKey: "canon", limit: 1 }));

  assert.deepEqual(
    result.skipped.map((entry) => entry.reason).sort(),
    ["DUPLICATE_AREA", "OTHER_BRANCH", "OTHER_MAP", "OVER_LIMIT"],
  );
  assert.deepEqual(result.areas.map((region) => region.locationId), ["loc:C"]);
  assert.equal(result.counts.truncatedAreas, 1);
  assert.equal(result.counts.scannedAreas, 5);
});

test("H15：势力范围 / 消息已达热区只按已确证 locationId 聚合", () => {
  const topology = {
    areas: [
      colorArea("canon|world|loc:A", "loc:A", [{ x: 1, y: 1 }], "worldbook"),
      colorArea("canon|world|loc:B", "loc:B", [{ x: 2, y: 2 }], "worldbook"),
      colorArea("canon|world|loc:C", "loc:C", [{ x: 3, y: 3 }], "worldbook"),
    ],
  };
  const result = projectColorAreas(areaInput({
    topology,
    layers: { faction: true, signal: true },
    factionLocationIds: ["loc:A"],
    signalReachedLocationIds: ["loc:D"],
    locationCenters: [{ locationId: "loc:D", x: 40, y: 40 }],
  }));

  assert.deepEqual(
    result.areas.filter((region) => region.layer === "area").map((region) => region.locationId),
    ["loc:A", "loc:B", "loc:C"],
    "默认只开区块：已证实格照常投影",
  );
  assert.deepEqual(
    result.areas.filter((region) => region.layer === "faction").map((region) => region.locationId),
    ["loc:A"],
    "势力层只染已确证归属的地点",
  );
  assert.deepEqual(result.areas.filter((region) => region.layer === "signal"), [], "未送达的地点不产生热区填色");
  assert.equal(result.halos.filter((item) => item.layer === "signal").length, 1, "已送达但无确证格 → 只给示意光圈");
  assert.equal(result.halos[0].locationId, "loc:D");
  assert.ok(!result.areas.some((region) => region.layer !== "area" && region.locationId !== "loc:A"));

  const factionOnly = projectColorAreas(areaInput({
    topology,
    layers: { area: false, faction: true },
    factionLocationIds: ["loc:A"],
  }));
  assert.deepEqual(factionOnly.areas.map((region) => `${region.layer}:${region.locationId}`), ["faction:loc:A"]);
  assert.equal(factionOnly.counts.paintedCells, 1);
  assert.equal(factionOnly.layers.find((item) => item.layer === "area").enabled, false);

  const signalOnly = projectColorAreas(areaInput({
    topology,
    layers: { area: false, signal: true },
    signalReachedLocationIds: ["loc:C", "loc:ZZ"],
  }));
  assert.deepEqual(signalOnly.areas.map((region) => `${region.layer}:${region.locationId}`), ["signal:loc:C"]);
  assert.equal(signalOnly.skipped.find((entry) => entry.locationId === "loc:ZZ").reason, "NO_CELLS_NO_CENTER");
});

test("H15：坏格（非整数 / 重复 / 越界）丢弃并记账，不假染", () => {
  const result = projectColorAreas(areaInput({
    topology: {
      areas: [colorArea("canon|world|loc:A", "loc:A", [{ x: 1, y: 1 }, { x: 1.5, y: 1 }, { x: 1, y: 1 }, { x: 999, y: 1 }])],
    },
  }));
  assert.equal(result.counts.paintedCells, 1);
  assert.equal(result.counts.droppedCells, 3);
  assert.deepEqual(
    Object.fromEntries(result.droppedCells.map((entry) => [entry.reason, entry.count])),
    { NOT_INTEGER: 1, DUPLICATE: 1, OUT_OF_FRAME: 1 },
  );
});

test("H15：纯函数（冻结输入可调用、不改输入）且输出与输入顺序无关", () => {
  const areas = [
    colorArea("canon|world|loc:A", "loc:A", [{ x: 1, y: 1 }, { x: 2, y: 1 }], "manual"),
    colorArea("canon|world|loc:B", "loc:B", [{ x: 6, y: 6 }], "story"),
  ];
  const centers = [
    { locationId: "loc:C", x: 30, y: 30 },
    { locationId: "loc:D", x: 31, y: 31 },
  ];
  const input = deepFreeze(areaInput({
    topology: { edges: [], vehicles: [], areas },
    locationCenters: centers,
    factionLocationIds: ["loc:A", "loc:A"],
    layers: { faction: true },
  }));
  const snapshot = JSON.stringify(input);
  const first = projectColorAreas(input);
  assert.equal(JSON.stringify(input), snapshot, "不得修改输入对象");
  assert.equal(JSON.stringify(projectColorAreas(input)), JSON.stringify(first), "同一输入重复调用逐字节一致");

  const shuffled = projectColorAreas(areaInput({
    topology: { edges: [], vehicles: [], areas: [...areas].reverse() },
    locationCenters: [...centers].reverse(),
    factionLocationIds: ["loc:A"],
    layers: { faction: true },
  }));
  assert.equal(JSON.stringify(shuffled), JSON.stringify(first), "输出与 areas / centers 输入顺序无关");

  const source = readFileSync(new URL("../src/atlas-map-areas.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Math\.random|Date\.now|performance\.now/, "投影不得依赖随机数或时钟");
});
