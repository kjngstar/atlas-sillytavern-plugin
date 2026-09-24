/**
 * atlas-browser-replay.test.mjs — G03（测试部分）：离线工作台的**浏览器级回放**。
 *
 * 计划 G03 原文要求「在离线工作台用固定假模型回放：0 时段 / 教室人物 / 城市·外城·载具地图 /
 * A/B 会话切换 / IF / swipe / 远方消息逐跳推进 / AI 标定成功与 unknown / 缩放 2 倍的
 * 左下角标尺；整理匿名截图与诊断」。
 *
 * 本文件把其中**可自动断言**的部分固化成回归测试：挂载**真实 index.js**（data:URL 注入
 * `export { renderPanel }`，与 tests/atlas-r01-map-visibility.test.mjs /
 * tests/atlas-map-vehicles.test.mjs 同一套挂载写法）+ jsdom，用固定假 `/state` 回放：
 *
 *  1. 缩放 2 倍时左下角固定长度标尺的读数与条长（H17 / H19a / §2.6）；
 *  2. 教室子图里的人物图钉（D-34 / F04 / §2.4：只画可信细格，不伪造房间坐标）；
 *  3. A/B 会话切换后左栏不含上一聊天的幕后动向（D07 / B03：simulationView 缺席退回旧回执）；
 *  4. 城市入口 / 相邻外城 / 在途载具（H16 / F06 / §2.5：在途不画点但必须如实列出）；
 *  5. 0 时段：只有意图、没有时间推进时左栏明说「不会移动、不会传到远方」（§2.3）；
 *  6. 服务端级：远方消息**逐跳**推进，收件人集合随段数严格增长（D02 / §2.5）。
 *
 * **明确没做的部分**：截图。本环境只有 jsdom，没有真实浏览器渲染管线，
 * 「整理匿名截图」这一项无法在这里产出——这里只断言 DOM 与读数，不假装有截图。
 *
 * 纪律：全部数字确定性（无 Date.now / Math.random）；视口尺寸按 R01/H13 的做法
 * 给 HTMLElement.prototype 打补丁，否则 jsdom 下 clientWidth/clientHeight 恒为 0。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

import { formatFixedScaleDistance } from "../src/atlas-scale.ts";
import { planSignalSpread } from "../src/atlas-signal-propagation.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** 视口尺寸（补丁给 HTMLElement.prototype；R01 / H13 同款）。 */
const VIEW_W = 720;
const VIEW_H = 480;
/** 固定长度标尺：96 CSS px（§2.6 / H17）。 */
const FIXED_BAR_PX = 96;
/** 回放用的固定假模型答案（不含任何时间戳 / 随机量）。 */
const CALIBRATION_100M = {
  revision: 1, metersPerCell: 100, source: "user", locked: true,
  coverage: "全图", basis: "人工标定：城墙间距", confidence: "high", at: 1,
};

let mountSeq = 0;

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 挂载真实 index.js 到 jsdom；返回可重渲染的面板与容器。 */
async function mountReplay(state) {
  const dom = new JSDOM("<!doctype html><head></head><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  // jsdom 没有布局：视口尺寸必须自己给，否则相机 k 与标尺条长都算不出来
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { get: () => VIEW_W, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { get: () => VIEW_H, configurable: true });

  const style = document.createElement("style");
  style.textContent = readFileSync(join(root, "style.css"), "utf8");
  document.head.append(style);

  mountSeq += 1;
  const source = `${readFileSync(join(root, "index.js"), "utf8")}\nexport { renderPanel };\n// g03-replay-${mountSeq}`;
  const { renderPanel } = await import(
    "data:text/javascript;base64," + Buffer.from(source).toString("base64")
  );

  // 发布形态由 atlas-browser-entry 提供；夹具按真实表面补齐（缺一项就会退化到空导航 / 无标尺）
  const mapMod = {
    ...(await import(pathToFileURL(join(root, "src", "atlas-map-camera.ts")).href)),
    ...(await import(pathToFileURL(join(root, "src", "atlas-map-interactions.ts")).href)),
    ...(await import(pathToFileURL(join(root, "src", "atlas-scale.ts")).href)),
    ...(await import(pathToFileURL(join(root, "src", "atlas-map-grid.ts")).href)),
    ...(await import(pathToFileURL(join(root, "src", "atlas-map-areas.ts")).href)),
    ...(await import(pathToFileURL(join(root, "src", "atlas-map-layout.ts")).href)),
    ATLAS_UI_PAGES: (await import(pathToFileURL(join(root, "src", "atlas-ui-core.ts")).href)).ATLAS_UI_PAGES,
  };

  // 假 UI 核心：getState 每次渲染都重新取 → 换聊天 = 换一份 /state（B03 的真实语义）
  const current = { state };
  const core = {
    getState: () => current.state,
    setState: (next) => { current.state = next; },
    setPage: () => {},
    setPanelOpen: () => {},
    setSimulationVisibility: async () => {},
    refresh: async () => {},
  };
  const api = { request: async () => ({ status: 200, body: { ok: true, data: {} } }) };
  const container = document.createElement("div");
  document.body.append(container);
  const rerender = renderPanel(core, container, api, { read: async () => null }, mapMod);
  await flush();
  return { dom, core, container, rerender };
}

/** 地图页 `/state` 夹具（形状与 atlas-map-vehicles.test.mjs 同源）。 */
function mapState({
  chatId = "chat-a", worldId = "w-replay", points = [], submaps = {}, calibrations = {},
  tableMap = null, currentLocationId = points[0]?.id ?? null, worldTimeCursor = 3,
} = {}) {
  return {
    page: "map",
    panelOpen: true,
    serviceStatus: "online",
    mode: "online",
    chatId,
    binding: {
      schemaVersion: 1, enabled: true, chatId, characterId: null, worldId,
      branchId: null, currentLocationId, worldTimeCursor,
    },
    receipts: [], pendingTurn: null, retryableCommit: null, lastError: null,
    simulationView: null, simulationVisibility: "known",
    modeHint: null, lorebookHint: null, worldNotice: null,
    stateData: {
      chatId, worldId, worldName: "回放世界", currentTime: worldTimeCursor, currentLocationId,
      map: {
        points,
        pointCount: points.length,
        pointParents: {},
        submaps,
        submapCount: Object.keys(submaps).length,
        calibrations,
        pointMeta: {},
        mapImagePresent: false,
        mapImageRevision: 0,
      },
      npcDirectory: [], objectDirectory: [], nearbyPointIds: [], relevantNpcIds: [],
      npcReasons: {}, triggerIds: [], regions: [],
      ...(tableMap ? { tableMap } : {}),
    },
  };
}

/** 从 stage 的 CSS transform 里读回真实 camera.k（`translate(...) scale(k)`）。 */
function cameraKOf(container) {
  const stage = container.querySelector(".aw-stage");
  const matched = /scale\(([-\d.eE+]+)\)/.exec(String(stage?.style.transform ?? ""));
  assert.ok(matched, `stage 必须带相机变换：实际 "${stage?.style.transform}"`);
  const k = Number(matched[1]);
  assert.ok(Number.isFinite(k) && k > 0, `camera.k 必须为正有限数（实际 ${k}）`);
  return k;
}

/** 读数文本 → 米（"960 米" / "1.92 千米" / "96 厘米" / "0.5 毫米"）。 */
function readingMeters(text) {
  const matched = /^([\d.]+)\s*(毫米|厘米|米|千米)$/.exec(String(text).trim());
  if (!matched) return null;
  const scale = { "毫米": 0.001, "厘米": 0.01, "米": 1, "千米": 1000 }[matched[2]];
  return Number(matched[1]) * scale;
}

function relativeDiff(a, b) {
  return Math.abs(a - b) / Math.abs(b);
}

/* ------------------------------------------------------------------ *
 * ① 缩放 2 倍：固定长度标尺的读数必须按比例变化，条长必须不变
 * ------------------------------------------------------------------ */

test("G03 回放：缩放 2 倍时左下角固定长度标尺读数减半、条长恒为 96px", async () => {
  const { dom, container } = await mountReplay(mapState({
    points: [
      { id: "1", name: "钟楼", x: 10, y: 10, regionId: null },
      { id: "2", name: "市场", x: 30, y: 30, regionId: null },
    ],
    calibrations: { world: CALIBRATION_100M },
  }));
  const labelOf = () => String(container.querySelector(".aw-scale__label")?.textContent ?? "");
  const barOf = () => container.querySelector(".aw-scale__bar");

  const kBefore = cameraKOf(container);
  const barBefore = barOf();
  assert.ok(barBefore, "左下角必须有常驻标尺条");
  assert.equal(barBefore.style.width, `${FIXED_BAR_PX}px`, "尺条长度固定在视口坐标系 96px");
  assert.equal(container.querySelectorAll(".aw-grid-stride").length, 0,
    "左下角只有比例尺——旧的「网格 N 格/线」叠加框不得回来");

  // 读数公式（§2.6）：D 米 = L × metersPerCell / camera.k
  const metersBefore = readingMeters(labelOf());
  assert.ok(metersBefore !== null, `已标定必须给米制读数：实际 "${labelOf()}"`);
  assert.ok(relativeDiff(metersBefore, (FIXED_BAR_PX * 100) / kBefore) < 0.01,
    `读数必须等于 96 × 100 / k：读数 ${metersBefore}，k=${kBefore}`);
  assert.equal(labelOf(), formatFixedScaleDistance((FIXED_BAR_PX * 100) / kBefore),
    "读数就是权威纯函数在同一 k 下的输出（3 位有效数字）");

  const zoomLabelBefore = String(container.querySelector(".aw-zoom__label")?.textContent ?? "");
  assert.equal(zoomLabelBefore, "100%", "初始为 fitAll 基准 100%");

  // ctrl+滚轮固定缩放到 2.0×（index.js: factor = min(2, max(0.5, exp(-deltaY*0.01)))；
  // deltaY = -70 → exp(0.7) = 2.0137 → 被夹到正好 2）
  const viewport = container.querySelector(".aw-viewport");
  assert.ok(viewport, "视口元素存在");
  viewport.dispatchEvent(new dom.window.WheelEvent("wheel", {
    deltaY: -70, ctrlKey: true, clientX: 200, clientY: 150, bubbles: true, cancelable: true,
  }));
  await flush();

  const kAfter = cameraKOf(container);
  assert.ok(relativeDiff(kAfter, kBefore * 2) < 1e-6,
    `相机必须恰好放大 2 倍：k ${kBefore} → ${kAfter}`);
  assert.equal(String(container.querySelector(".aw-zoom__label")?.textContent ?? ""), "200%", "缩放百分比翻倍");

  const metersAfter = readingMeters(labelOf());
  assert.ok(metersAfter !== null, `放大后仍是米制读数：实际 "${labelOf()}"`);
  assert.ok(relativeDiff(metersAfter * 2, metersBefore) < 0.01,
    `放大 2 倍 → 固定长度的读数必须减半：${metersBefore} → ${metersAfter}`);
  assert.notEqual(metersAfter, metersBefore, "读数确实变了（不是把同一个数字留在屏幕上）");
  assert.equal(labelOf(), formatFixedScaleDistance((FIXED_BAR_PX * 100) / kAfter),
    "放大后的读数同样等于权威纯函数在该 k 下的输出");
  assert.equal(barOf().style.width, `${FIXED_BAR_PX}px`, "尺条长度绝不随缩放变化");
  assert.equal(barOf().style.width, barBefore.style.width, "两次渲染的条长逐字相同");
  dom.window.close();
});

test("G03 回放：同一张图未标定（AI unknown）→ 只报格数并写明「未标定」，放大 2 倍格数减半", async () => {
  const state = mapState({
    points: [
      { id: "1", name: "钟楼", x: 10, y: 10, regionId: null },
      { id: "2", name: "市场", x: 30, y: 30, regionId: null },
    ],
    calibrations: {},
  });
  const { dom, core, container, rerender } = await mountReplay(state);
  const labelEl = () => container.querySelector(".aw-scale__label");
  const text = () => String(labelEl()?.textContent ?? "");
  const cells = () => {
    const matched = /约 ([\d.]+) 格/.exec(text());
    return matched ? Number(matched[1]) : null;
  };

  assert.match(text(), /未标定/, `未标定必须写明：实际 "${text()}"`);
  assert.equal(readingMeters(text()), null, "未标定不得产出任何米数");
  assert.match(String(labelEl()?.getAttribute("aria-label") ?? ""), /约等于/,
    "可访问文案说清「屏幕 N 像素约等于 X」");
  assert.equal(container.querySelector(".aw-scale__bar").style.width, `${FIXED_BAR_PX}px`, "未标定控件照常在位");

  // 未标定也照 §2.6 的固定公式：D 格 = L / camera.k
  const cellsBefore = cells();
  assert.ok(cellsBefore !== null && cellsBefore > 0, `未标定必须给出格数：实际 "${text()}"`);
  assert.ok(relativeDiff(cellsBefore, FIXED_BAR_PX / cameraKOf(container)) < 0.01,
    `格数必须等于 96 / k：读数 ${cellsBefore}，k=${cameraKOf(container)}`);

  // 假模型给了 unknown（标定表仍然为空）→ 换一份 /state 重渲染：读数仍是格数，不是米
  core.setState(mapState({
    points: state.stateData.map.points,
    calibrations: {},
  }));
  rerender();
  await flush();
  assert.match(text(), /未标定/);
  assert.equal(readingMeters(text()), null, "unknown 不会凭空变成米数（不猜 1 米/格）");

  // 未标定的固定尺同样满足「放大 2 倍读数减半」——退化的是单位，不是行为
  const viewport = container.querySelector(".aw-viewport");
  viewport.dispatchEvent(new dom.window.WheelEvent("wheel", {
    deltaY: -70, ctrlKey: true, clientX: 200, clientY: 150, bubbles: true, cancelable: true,
  }));
  await flush();
  const cellsAfter = cells();
  assert.ok(relativeDiff(cellsAfter * 2, cellsBefore) < 0.01,
    `未标定时放大 2 倍 → 格数减半：${cellsBefore} → ${cellsAfter}`);
  assert.equal(container.querySelector(".aw-scale__bar").style.width, `${FIXED_BAR_PX}px`, "条长仍固定 96px");
  dom.window.close();
});

/* ------------------------------------------------------------------ *
 * ② 教室子图：只画可信细格的人物图钉
 * ------------------------------------------------------------------ */

/** 学校（点 1）挂一张子图，里面是「学校本体 + 三年二班」。 */
function classroomState() {
  const points = [{ id: "1", name: "星海学校", x: 10, y: 10, regionId: null }];
  /**
   * 子图的权威来源是 `/state.tableMap.submaps`（index.js: `tableSubmaps ?? map.submaps`），
   * 所以两份夹具给同一份数据——真实服务端也是同一次投影产出这两处。
   */
  const submaps = {
    "1": {
      mapId: "1",
      parentMapId: "world",
      frame: { cols: 40, rows: 40, frameRevision: 1 },
      points: [
        { id: "1", name: "星海学校", x: 5, y: 5, kind: "location", rowId: "loc:1" },
        { id: "2", name: "三年二班", x: 20, y: 20, kind: "location", rowId: "loc:2" },
      ],
      total: 2, truncated: 0,
    },
  };
  const tableMap = {
    branchKey: "canon",
    world: { points: [{ id: "1", name: "星海学校", x: 10, y: 10, regionId: null, kind: "location", rowId: "loc:1" }], total: 1, truncated: 0 },
    submaps,
    objects: { entries: [], total: 0, truncated: 0 },
    current: { locationId: "loc:1", chain: [] },
    nearReasonCode: null,
    locationOccupants: {
      total: 1, truncated: 0,
      entries: [{
        locationId: "loc:2", locationName: "三年二班", locationPointId: "2",
        mapId: "1", gridX: 20, gridY: 20, characterCount: 1, itemCount: 0, characters: [], items: [],
      }],
    },
    /**
     * 四个人，四种「知道多少」：
     * - npc:in-room     有房间内真实细格 → 画图钉；
     * - npc:building    只知道在整栋楼里（位置 = 宿主地点本身）→ 不画点；
     * - npc:no-coords   在房间里但没有细坐标 → 不画点（进「位置未知」名单）；
     * - npc:coincident  细坐标恰好等于房间标点 → 计入徽标，不重复画图钉。
     */
    nearby: {
      total: 4, truncated: 0,
      entries: [
        { id: "npc:in-room", name: "教室里的学生", locationId: "loc:2", locationName: "三年二班", presence: "present", gridX: 22, gridY: 24, mapId: "1" },
        { id: "npc:building", name: "只知道在楼里", locationId: "loc:1", locationName: "星海学校", presence: "present", gridX: 5, gridY: 5, mapId: "1" },
        { id: "npc:no-coords", name: "没有细坐标", locationId: "loc:2", locationName: "三年二班", presence: "present", gridX: null, gridY: null, mapId: "1" },
        { id: "npc:coincident", name: "与房间同格", locationId: "loc:2", locationName: "三年二班", presence: "present", gridX: 20, gridY: 20, mapId: "1" },
      ],
    },
  };
  return mapState({ points, submaps, tableMap, currentLocationId: "1" });
}

test("G03 回放：教室子图只画可信细格的人物图钉，建筑级 / 无坐标 / 同格的人不伪造点位", async () => {
  const { dom, container } = await mountReplay(classroomState());

  // 世界图仍然是「人物由地点承载」：一个图钉都不画
  assert.equal(container.querySelectorAll(".aw-object--npc").length, 0,
    "世界图不画人物图钉（S9 口径：世界图上人物坐标 = 地点坐标）");

  // 进入学校内部地图
  const school = container.querySelector('.aw-point[data-point-id="1"]');
  assert.ok(school, "学校标点存在");
  assert.ok(school.classList.contains("aw-point--entrance"), "有子图的宿主标点标为城市/建筑入口");
  school.click();
  await flush();
  const enter = [...container.querySelectorAll(".aw-mappanel button")].find((node) => node.textContent === "进入内部地图");
  assert.ok(enter, "宿主地点的面板里有「进入内部地图」");
  enter.click();
  await flush();

  const pins = [...container.querySelectorAll(".aw-object--npc")];
  // 注意：图钉的 data-npc-id 是三表投影后的裸 id（`npc:` 前缀由 index.js 的 npcViewFromTableRow 去掉）
  assert.deepEqual(pins.map((node) => node.dataset.npcId), ["in-room"],
    `子图里只应有 1 枚可信细格图钉：实际 ${JSON.stringify(pins.map((n) => [n.dataset.npcId, n.style.left, n.style.top]))}`);
  const pin = pins[0];
  assert.match(String(pin.textContent ?? ""), /教室里的学生/, "这枚图钉确实是「在房间里且知道房间细格」的那位");
  assert.equal(pin.style.left, "22px", "图钉画在真实格坐标 x 上");
  assert.equal(pin.style.top, "24px", "图钉画在真实格坐标 y 上");
  assert.equal(pin.style.left === "20px" && pin.style.top === "20px", false, "不与房间标点重合");

  // 只知道「在整栋楼里」的人不画点：那是地点级信息，画出来等于伪造房间坐标
  assert.equal(container.querySelector('.aw-object--npc[data-npc-id="building"]'), null,
    "位置 = 宿主地点本身的人不得画成房间内图钉");
  assert.equal(container.querySelector('.aw-object--npc[data-npc-id="no-coords"]'), null,
    "没有房间内细坐标的人不得被画到某个坐标上");
  assert.equal(container.querySelector('.aw-object--npc[data-npc-id="coincident"]'), null,
    "细坐标与房间标点同格的人不重复画点（计入徽标）");
  // 没有细坐标的人进「建筑内 · 具体房间未知」名单，而不是被画到 (0,0)
  const roster = container.querySelector(".aw-interior-roster");
  assert.ok(roster, "子图必须有「建筑内 · 具体房间未知」名单");
  assert.equal(roster.style.display, "", "有人位置未细分时名单必须显示");
  assert.match(String(roster.querySelector(".aw-interior-roster__title")?.textContent ?? ""), /建筑内 · 具体房间未知/,
    "名单标题写明它承载的是「位置未细分」的人");
  assert.match(String(roster.textContent ?? ""), /没有细坐标/,
    `无细坐标的人必须仍可见：实际 "${roster.textContent}"`);
  assert.ok(!String(roster.textContent ?? "").includes("教室里的学生"),
    "已经画成图钉的人不在名单里重复出现");
  // 细坐标恰好与房间标点同格的人：计入徽标，不从地图上消失，也不重复画点
  const roomMarker = container.querySelector('.aw-point[data-point-id="2"]');
  assert.ok(roomMarker, "房间标点存在");
  assert.equal(roomMarker.querySelector(".aw-point__badge")?.textContent, "1", "房间徽标给出在场人数");
  // 没有任何图钉落在 (0,0)
  const atOrigin = [...container.querySelectorAll(".aw-object--npc")].filter(
    (node) => node.style.left === "0px" && node.style.top === "0px");
  assert.equal(atOrigin.length, 0, "未知坐标不落 (0,0)（F7 停机线）");
  dom.window.close();
});

/* ------------------------------------------------------------------ *
 * ③ A/B 会话切换：左栏不得残留上一聊天的幕后动向
 * ------------------------------------------------------------------ */

function movesState({ chatId, simulationView, receipts }) {
  const state = mapState({ chatId, worldId: "w-ab", points: [{ id: "1", name: "钟楼", x: 10, y: 10, regionId: null }] });
  state.simulationView = simulationView;
  state.receipts = receipts;
  return state;
}

const SIMULATION_A = {
  branchKey: "canon",
  tasks: [], signals: [], deliveries: [],
  counts: { tasks: 1, activeTasks: 1, blockedTasks: 0, signals: 1, deliveries: 1 },
  truncated: { tasks: 0, signals: 0, deliveries: 0, events: 0 },
  corrupt: false,
  visibility: "known",
  currentLocationKnown: true,
  recentEvents: [{
    id: "evt-a1", simulationId: "sig:a", kind: "signal", status: "delivered",
    actorCharacterId: null, fromLocationId: "loc:1", toLocationId: "loc:2",
    reasonCode: null, summary: "A 聊天的使者抵达城门", visibility: "known", period: 3,
  }],
};

test("G03 回放：A/B 会话切换后左栏不含 A 的幕后动向；simulationView 缺席时退回旧回执", async () => {
  const { dom, core, container, rerender } = await mountReplay(movesState({
    chatId: "chat-a", simulationView: SIMULATION_A, receipts: [],
  }));
  const movesText = () => String(container.querySelector(".aw-moves")?.textContent ?? "");

  assert.match(movesText(), /A 聊天的使者抵达城门/, "A 的左栏显示 A 的幕后动向");
  assert.match(movesText(), /幕后动向/, "动向卡标题在");

  // 切到 B：另一份 /state（没有推演模块，只有本轮之前的旧回执）
  core.setState(movesState({
    chatId: "chat-b",
    simulationView: null,
    receipts: [{
      receiptId: "rcpt-b1", status: "committed", branchId: null,
      previousTime: 1, currentTime: 2, previousLocationId: null, currentLocationId: "1",
      triggeredNpcIds: [], adoptedEventIds: [], adoptedEventCount: 0,
      summary: "B 聊天的旧回执摘要。", retryable: false,
    }],
  }));
  rerender();
  await flush();

  assert.ok(!movesText().includes("A 聊天的使者抵达城门"),
    `切到 B 后左栏不得残留 A 的动向：实际 "${movesText()}"`);
  assert.ok(!movesText().includes("已送达"),
    "B 没有 simulationView，就不该出现推演态标签");
  assert.match(movesText(), /B 聊天的旧回执摘要/, "simulationView 为 null 时退回旧回执摘要（旧行为不变）");

  // 切回 A：A 的动向完整恢复（不是被清空，而是按聊天作用域各归各的）
  core.setState(movesState({ chatId: "chat-a", simulationView: SIMULATION_A, receipts: [] }));
  rerender();
  await flush();
  assert.match(movesText(), /A 聊天的使者抵达城门/, "切回 A 完整恢复");
  assert.ok(!movesText().includes("B 聊天的旧回执摘要"), "A 里不出现 B 的回执");
  dom.window.close();
});

test("G03 回放：0 时段只有意图时，左栏明说「不会移动、不会传到远方」", async () => {
  const zeroPeriod = {
    ...SIMULATION_A,
    recentEvents: [],
    counts: { tasks: 1, activeTasks: 1, blockedTasks: 0, signals: 0, deliveries: 0 },
  };
  const { dom, container } = await mountReplay(movesState({
    chatId: "chat-a", simulationView: zeroPeriod, receipts: [],
  }));
  const text = String(container.querySelector(".aw-moves")?.textContent ?? "");
  assert.match(text, /已记录行动意图；时间未推进，人物不会移动、消息也不会传到远方。/,
    `第 0 时段必须说清「意图 ≠ 已发生」：实际 "${text}"`);
  assert.ok(!/已抵达|已送达/.test(text), "0 时段不得出现任何「已抵达 / 已送达」");
  dom.window.close();
});

/* ------------------------------------------------------------------ *
 * ④ 城市 / 外城 / 在途载具
 * ------------------------------------------------------------------ */

test("G03 回放：城市入口、相邻外城、在途载具——在途不画点但出现在说明行", async () => {
  const points = [
    { id: "1", name: "圣罗兰城", x: 10, y: 10, regionId: null },
    { id: "2", name: "圣罗兰外城区", x: 30, y: 30, regionId: null },
  ];
  const submaps = {
    "1": {
      mapId: "1",
      parentMapId: "world",
      frame: { cols: 40, rows: 40, frameRevision: 1 },
      points: [
        { id: "1", name: "圣罗兰城", x: 5, y: 5, kind: "location", rowId: "loc:1" },
        { id: "3", name: "奴隶市场", x: 20, y: 20, kind: "location", rowId: "loc:3" },
        { id: "4", name: "工厂区", x: 28, y: 12, kind: "location", rowId: "loc:4" },
      ],
      total: 3, truncated: 0,
    },
  };
  const tableMap = {
    branchKey: "canon",
    world: {
      points: [
        { id: "1", name: "圣罗兰城", x: 10, y: 10, regionId: null, kind: "location", rowId: "loc:1" },
        { id: "2", name: "圣罗兰外城区", x: 30, y: 30, regionId: null, kind: "location", rowId: "loc:2" },
      ],
      total: 2, truncated: 0,
    },
    submaps, nearby: { entries: [], total: 0, truncated: 0 },
    objects: { entries: [], total: 0, truncated: 0 },
    current: { locationId: "loc:1", chain: [] },
    nearReasonCode: null,
    locationOccupants: { total: 0, truncated: 0, entries: [] },
    /** 外城 ↔ 城市：已确认的 adjacent 边（不是靠坐标远近猜的） */
    geoTopology: {
      branchKey: "canon",
      edges: [{ id: "edge:1-2", fromLocationId: "loc:1", toLocationId: "loc:2", kind: "adjacent", evidence: "worldbook", channel: "walk" }],
      areas: [],
      /** 蒸汽马车：在途 → 没有确认坐标，一个点都不许画 */
      vehicleAnchors: [{ id: "loc:9", locationId: "loc:9", atLocationId: null, routeEdgeId: "edge:1-2", status: "en-route", evidence: "story" }],
    },
  };
  const { dom, container } = await mountReplay(mapState({ points, submaps, tableMap, currentLocationId: "1" }));

  const city = container.querySelector('.aw-point[data-point-id="1"]');
  const outer = container.querySelector('.aw-point[data-point-id="2"]');
  assert.ok(city && outer, "城市与外城标点都存在");
  assert.ok(city.classList.contains("aw-point--entrance"), "有子图的城市是「城市入口」");
  assert.ok(outer.classList.contains("aw-point--adjacent"), "外城由已确认 adjacent 边标为相邻");
  assert.ok(!outer.classList.contains("aw-point--entrance"), "外城不是城市入口（它自己有子图才算）");

  // 在途载具：不画点，但说明行必须如实列出（H16：不许消失）
  assert.equal(container.querySelector('.aw-point[data-point-id="9"]'), null, "在途载具不得画出标点");
  assert.equal(container.querySelectorAll(".aw-point__vehicle").length, 0, "在途不是停靠，不出载具徽标");
  const note = container.querySelector(".aw-mapvehicle-note");
  assert.ok(note, "在途载具说明行存在");
  assert.match(String(note.textContent ?? ""), /1 辆载具在途/,
    `说明行要写在途数量：实际 "${note.textContent}"`);
  assert.match(String(note.textContent ?? ""), /地图上不标点/, "说明行为什么看不见它");

  // 进入城市子图：市场 / 工厂区在城内，且标为内部点位
  city.click();
  await flush();
  const enter = [...container.querySelectorAll(".aw-mappanel button")].find((node) => node.textContent === "进入内部地图");
  assert.ok(enter, "城市入口可进入子图");
  enter.click();
  await flush();
  const inside = [...container.querySelectorAll(".aw-point[data-point-id]")].map((node) => node.dataset.pointId);
  assert.deepEqual(inside.sort(), ["1", "3", "4"], `城市子图应显示城内地点：实际 ${JSON.stringify(inside)}`);
  const market = container.querySelector('.aw-point[data-point-id="3"]');
  assert.ok(market.classList.contains("aw-point--interior"), "城内地点标为内部");
  assert.ok(!market.classList.contains("aw-point--adjacent"), "城内地点不是相邻外城");
  dom.window.close();
});

/* ------------------------------------------------------------------ *
 * ⑤ 服务端级：远方消息逐跳推进，收件人集合随段数增长
 * ------------------------------------------------------------------ */

test("G03 服务端级：远方消息按路由逐跳推进——收件人集合随跨过的段数增长", () => {
  const chain = (from, to) => ({
    id: `edge:${from}->${to}`, fromLocationId: from, toLocationId: to,
    kind: "adjacent", evidence: "story", channel: "walk",
  });
  const topology = {
    edges: [chain("loc:school", "loc:gate"), chain("loc:gate", "loc:market"), chain("loc:market", "loc:factory")],
    areas: [], vehicles: [],
  };
  const signal = {
    id: "sig:declaration", originLocationId: "loc:school", topic: "使者带出宣战文书",
    sourceTurnKey: "turn-1", sourceQuoteId: "quote-1", publishedPeriod: 0,
    visibility: "known", status: "active", propagationCursor: 0,
  };
  /** 两个人：一个在城门、一个在工厂——只有路由走到他们所在的地点才算得知。 */
  const characterLocations = [
    { id: "npc:gatekeeper", locationId: "loc:gate" },
    { id: "npc:foreman", locationId: "loc:factory" },
    { id: "npc:nowhere", locationId: null },
  ];

  // 第 0 段：一步都不走
  const zero = planSignalSpread({
    topology, signals: [signal], deliveries: [], characterLocations,
    period: 0, periodsElapsed: 0,
  });
  assert.equal(zero.deliveries.length, 0, "第 0 段远方无人得知（连城门也没有）");
  assert.ok(zero.diagnostics.some((d) => d.code === "NO_TIME"), "第 0 段要具名说明为什么没动");

  /**
   * 第 1 / 2 / 3 段：风声沿已确认的边**逐跳**走。
   *
   * 段落语义照 §2.5：「每完整新时段最多沿一条确认邻接边走 1 跳
   * （同轮跨多时段按真实时段数推进）」——第 N 段的候选集 = 从发起地起 N 跳以内，
   * 送达按 (signal, 收件人) 幂等累积，所以集合必须随段数**严格增长**。
   *
   * 注意（已核实的实现缺口，见交付报告）：服务端每轮回合只把**本轮**
   * 推进的时段数（`periodsThisTurn`）交给 planSignalSpread，而候选集是每轮
   * 重新从发起地按该跳数算的。于是「连续多个回合各推进 1 段」时，
   * 第 2 回合的候选集仍然只有 1 跳可达的那一个地点（已送达 → 去重后为空），
   * 消息会停在第一跳。这里断言的是路由算法本身（给定累计段数）的正确增长，
   * 不掩盖上面那条缺口。
   */
  const seenLocations = new Set();
  const seenCharacters = new Set();
  const locationsBySegment = [];
  const charactersBySegment = [];
  let deliveries = [];
  for (let segment = 1; segment <= 3; segment += 1) {
    const round = planSignalSpread({
      topology,
      signals: [signal],
      // 上一段的送达回灌：真实引擎就是这样逐轮累积的（幂等基线）
      deliveries: deliveries.map((row) => ({
        signalId: row.signalId, recipientType: row.recipientType, recipientId: row.recipientId,
      })),
      characterLocations,
      period: segment,
      periodsElapsed: segment,
    });
    for (const row of round.deliveries) {
      if (row.recipientType === "location") seenLocations.add(row.recipientId);
      else seenCharacters.add(row.recipientId);
    }
    locationsBySegment.push(
      round.deliveries.filter((row) => row.recipientType === "location").map((row) => row.recipientId).sort(),
    );
    charactersBySegment.push(
      round.deliveries.filter((row) => row.recipientType === "character").map((row) => row.recipientId).sort(),
    );
    deliveries = [...deliveries, ...round.deliveries];
  }

  // ① 每段只多一跳，且严格在路由上
  assert.deepEqual(locationsBySegment[0], ["loc:gate"], "第 1 段只到相邻的城门");
  assert.deepEqual(locationsBySegment[1], ["loc:market"], "第 2 段再走一跳：市场");
  assert.deepEqual(locationsBySegment[2], ["loc:factory"], "第 3 段再走一跳：工厂");
  assert.deepEqual([...seenLocations].sort(), ["loc:factory", "loc:gate", "loc:market"], "累计收件地点集合");

  // ② 累计集合逐段严格增长（这是「逐跳推进」的可判定形式）
  const cumulative = (index) => [...new Set(locationsBySegment.slice(0, index + 1).flat())].sort();
  assert.deepEqual(cumulative(0), ["loc:gate"]);
  assert.deepEqual(cumulative(1), ["loc:gate", "loc:market"]);
  assert.deepEqual(cumulative(2), ["loc:factory", "loc:gate", "loc:market"]);
  assert.ok(cumulative(0).length < cumulative(1).length && cumulative(1).length < cumulative(2).length,
    "收件人集合随段数严格增长");
  assert.ok(!seenLocations.has("loc:capital") && !seenLocations.has("loc:学校外"), "没有边的远方地点始终不知情");

  // ③ 人物只在路由真的走到他所在地时才知道；位置未知的人永远不知道
  assert.deepEqual(charactersBySegment[0], ["npc:gatekeeper"], "第 1 段只有城门在场者得知");
  assert.deepEqual(charactersBySegment[1], [], "第 2 段到达的市场当时无人");
  assert.deepEqual(charactersBySegment[2], ["npc:foreman"], "第 3 段工厂在场者才得知");
  assert.deepEqual([...seenCharacters].sort(), ["npc:foreman", "npc:gatekeeper"], "累计得知的人物");
  assert.ok(!seenCharacters.has("npc:nowhere"), "位置未知的人不得凭空得知（关联人物 ≠ 直接得知）");

  // ④ 每条送达都带来源与时段；多跳之后只是传言，不是已核实事实
  const byRecipient = new Map(deliveries.map((row) => [row.recipientId, row]));
  for (const row of deliveries) {
    assert.equal(row.signalId, "sig:declaration", "同一份信号，不复制成多条");
    assert.equal(row.fromLocationId, "loc:school", "来源 = 已确认的发起地");
    assert.ok(Number.isFinite(row.receivedPeriod) && row.receivedPeriod >= 1, "每条送达都有真实时段");
  }
  assert.equal(byRecipient.get("loc:gate").receivedPeriod, 1, "城门在第 1 段收到");
  assert.equal(byRecipient.get("loc:market").receivedPeriod, 2, "市场在第 2 段收到");
  assert.equal(byRecipient.get("loc:factory").receivedPeriod, 3, "工厂在第 3 段收到");
  assert.equal(byRecipient.get("loc:gate").confidence, "confirmed", "相邻一跳算已核实");
  assert.equal(byRecipient.get("loc:market").confidence, "rumor", "多跳之后只是风声");
  assert.equal(byRecipient.get("loc:factory").confidence, "rumor", "更远仍然只是风声");
});
