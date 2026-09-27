/**
 * atlas-sql-ui-wiring.test.mjs — H05–H08 / H12（SQL 世界数据 UI 接线）定向验收。
 *
 * 对照计划 §10.1（一个位置解析入口）/ §10.2（人物标点与层级）/ §10.3（染色和比例尺）/
 * §10.4（主角所知与作者视图）/ §11.1（旧 500 上限只影响兼容投影）/ §17H（H05–H08、H12）。
 *
 * 挂载方式沿用仓库既有做法（tests/atlas-changes-page.test.mjs / atlas-r01-map-visibility）：
 * jsdom + 把 `atlas-extension/index.js`（发布镜像）源码追加测试接缝后用 data: URL 导入，
 * 用**真实** renderPanel 挂到真实 DOM。
 *
 * 本文件只做一件事：证明 UI 侧的 SQL 世界数据接线是**显式 opt-in** 的——
 *   关闭 → 旧路径一字不变、且绝不加载 sql.js（一次都不尝试）；
 *   开启 → 地图 / 附近 / 日志只读 SQL 视图；缺核心 / 缺视图 → 具名诊断 + 旧渲染器兜底。
 * 测试用 data: URL 桩模块替代 `dist/atlas-sql.mjs`（绝不真的加载 sql.js/wasm）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** 发布镜像 = 真实扩展入口（与 atlas-changes-page / atlas-extension-harness 同源）。 */
const INDEX_SOURCE = readFileSync(join(root, "atlas-extension", "index.js"), "utf8");

/** 每个 mount 用唯一 URL：data: URL 模块按 URL 缓存，串用会让模块级状态跨用例泄漏。 */
let mountSeq = 0;

/** 测试接缝（追加导出；不改任何生产行为）。 */
const TEST_SEAMS = `
export { renderPanel };
export const __atlasSqlTest = {
  candidates: ATLAS_SQL_CORE_CANDIDATES,
  coreStatus: () => atlasSqlCoreStatus(),
  diagnostics: () => pendingDiagnostics.slice(),
  queue: () => atlasSqlPrepareQueue(),
  prepareStep: atlasSqlPrepareStep,
  floorIdentity: atlasFloorIdentity,
  promptScope: buildSqlPromptScope,
  filterByViewMode: atlasSqlFilterByViewMode,
  knownCoordinate: atlasKnownCoordinate,
  emitter: createEmitter,
};
`;

/**
 * `dist/atlas-sql.mjs` 的测试桩：只实现 UI 用到的只读面（`createSqlRepository` 存在性校验 +
 * `openSqlSession` + `repo.queryView`）。真实 sql.js 与 wasm 一概不加载。
 */
const SQL_CORE_STUB = `
export function createSqlRepository() { throw new Error("stub：测试不打开真实 sql.js 仓库"); }
export const ATLAS_DATABASE_KEY = "database";
export const ATLAS_SQL_MODE_KEY = "sqlMode";
export async function openSqlSession(options) {
  const store = globalThis.__atlasSqlStub;
  store.opens.push(options);
  if (store.openError) throw store.openError;
  return {
    repo: {
      queryView: async (query) => {
        store.queries.push(query);
        const view = (store.views ?? {})[query.kind];
        return view ? JSON.parse(JSON.stringify(view)) : { branchId: "main-A", revision: 3, items: [], metadata: {} };
      },
    },
    source: "existing", envelopePresent: true, issues: [], chatUid: options.chatUid,
    branchId: "main-A", closed: false,
  };
}
export async function closeSqlSession() {}
`;

function sqlStubUrl() {
  return "data:text/javascript," + encodeURIComponent(SQL_CORE_STUB);
}

/** 核心不可用：指向一个绝不存在的产物（加载必然失败）。 */
function missingCoreUrl() {
  return pathToFileURL(join(root, "dist", "atlas-sql-does-not-exist.mjs")).href;
}

const flush = async (times = 8) => {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

/** 旧路径夹具（模式关闭时必须原样渲染）。 */
function legacyMapData() {
  return {
    currentTime: 5,
    currentLocationId: "1",
    map: {
      points: [
        { id: "1", name: "旧钟楼", x: 10, y: 10, regionId: null },
        { id: "2", name: "旧市场", x: 30, y: 30, regionId: null },
      ],
      pointCount: 2,
      pointParents: {},
      mapImagePresent: false,
      mapImageRevision: 0,
      pointMeta: {},
      submaps: {},
      submapCount: 0,
      calibrations: { world: { revision: 1, metersPerCell: 100, source: "user", locked: true, coverage: "", basis: "", at: 1 } },
    },
    npcDirectory: [],
    objectDirectory: [],
    regions: [],
    relevantNpcIds: [],
    nearbyPointIds: [],
  };
}

/**
 * SQL 地图视图夹具（§16.4 `ViewResult` + G01 `MapViewItem`）。
 * 层级：世界图（城市L1 / 学校L2，学校有 3 人）→ 学校图（教室A）→ 教室图（讲台 + 人物标点）。
 */
function sqlMapView() {
  return {
    branchId: "main-A",
    revision: 3,
    items: [
      {
        mapId: "world", name: "城市图", kind: "world", containerLocationId: null,
        metersPerCell: 100, scaleQuality: "user", scaleLocked: true, calibrationRev: 1, defaultTerrain: "urban",
        points: [
          { entityId: "loc:1", kind: "location", name: "城市L1", mapId: "world", x: 10, y: 10, precision: "exact", radius: null, markerQuality: "exact" },
          { entityId: "loc:2", kind: "location", name: "学校L2", mapId: "world", x: 40, y: 20, precision: "exact", radius: null, markerQuality: "exact" },
          // 有格坐标但与学校同坐标：城市图上只计入「这里有 N 人」，不叠一枚人物图标（§10.2）
          { entityId: "npc:C1", kind: "character", name: "艾琳", mapId: "world", x: 40, y: 20, precision: "exact", radius: null, markerQuality: "exact" },
          // 主角尚不知道的地点：只在作者视图显示（§10.4 作者开关 = 纯 UI 过滤）
          { entityId: "loc:9", kind: "location", name: "密室", mapId: "world", x: 62, y: 62, precision: "exact", radius: null, markerQuality: "exact", visibility: "hidden" },
        ],
        coarseList: [
          { entityId: "npc:C2", name: "信使", locationId: "loc:2", locationName: "学校L2" },
          { entityId: "npc:C3", name: "刺客", locationId: "loc:2", locationName: "学校L2" },
        ],
        routes: [
          { routeId: "route:1", fromId: "loc:1", toId: "loc:2", kind: "road", geometryQuality: "estimated", distanceM: 12000, dashed: true, allowedModes: ["walk"] },
          { routeId: "route:2", fromId: "loc:1", toId: "loc:2", kind: "road", geometryQuality: "confirmed", distanceM: 9000, dashed: false, allowedModes: ["walk"] },
        ],
        frames: { frame: { cols: 100, rows: 100, frameRevision: 2 }, scaleBar: null },
      },
      {
        mapId: "map-school", name: "学校图", kind: "building", containerLocationId: "loc:2",
        metersPerCell: 5, scaleQuality: "user", scaleLocked: true, calibrationRev: 1, defaultTerrain: "indoor",
        points: [
          { entityId: "loc:3", kind: "location", name: "教室A", mapId: "map-school", x: 5, y: 5, precision: "exact", radius: null, markerQuality: "exact" },
        ],
        coarseList: [],
        routes: [],
        frames: { frame: { cols: 60, rows: 60 }, scaleBar: null },
      },
      {
        mapId: "map-class", name: "教室图", kind: "room", containerLocationId: "loc:3",
        metersPerCell: 1, scaleQuality: "user", scaleLocked: true, calibrationRev: 1, defaultTerrain: "indoor",
        points: [
          { entityId: "loc:4", kind: "location", name: "讲台", mapId: "map-class", x: 2, y: 2, precision: "exact", radius: null, markerQuality: "exact" },
          { entityId: "npc:C4", kind: "character", name: "国王", mapId: "map-class", x: 12, y: 9, precision: "exact", radius: null, markerQuality: "exact" },
          { entityId: "npc:C7", kind: "character", name: "侍从", mapId: "map-class", x: 30, y: 12, precision: "approximate", radius: 2, markerQuality: "approximate" },
          // 坐标未知（null）：绝不补 0，也绝不画点（H12）
          { entityId: "npc:C5", kind: "character", name: "近卫", mapId: "map-class", x: null, y: 3, precision: "unknown", radius: null, markerQuality: "unknown" },
        ],
        coarseList: [
          { entityId: "npc:C6", name: "学生", locationId: "loc:4", locationName: "讲台" },
        ],
        routes: [],
        frames: { frame: { cols: 40, rows: 40 }, scaleBar: null },
      },
    ],
    metadata: { mapCount: 3, pointCount: 6, coarseCount: 3, viewMode: "pov" },
  };
}

/** 挂载真实 index.js 面板（jsdom + data: URL）。 */
async function mountAtlas({
  stateData = {},
  page = "map",
  receipts = [],
  sqlCandidates = null,
  chatId = "chat-sql-ui",
  chatMetadata = { atlas: { schemaVersion: 1, database: { schemaVersion: 1 } } },
  binding = { schemaVersion: 1, enabled: true, chatId: "chat-sql-ui", worldId: "w-sql", branchId: "main-A" },
} = {}) {
  const dom = new JSDOM("<!doctype html><head></head><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;

  const style = document.createElement("style");
  style.textContent = readFileSync(join(root, "atlas-extension", "style.css"), "utf8");
  document.head.append(style);

  mountSeq += 1;
  const mod = await import(
    "data:text/javascript;base64," +
      Buffer.from(`${INDEX_SOURCE}\n// sql-ui-wiring mount-${mountSeq}\n${TEST_SEAMS}`).toString("base64")
  );

  // 宿主上下文：SQL 快照信封挂在 chatMetadata.atlas.database（openSqlSession 的只读入口）
  const stContext = {
    chatId,
    chatMetadata,
    extensionSettings: {},
    chat: [],
    saveMetadata: async () => {},
    saveSettingsDebounced: () => {},
    getRequestHeaders: () => ({}),
  };
  globalThis.SillyTavern = { getContext: () => stContext };

  const cameraMod = await import(pathToFileURL(join(root, "src", "atlas-map-camera.ts")).href);
  const mapMod = {
    ...cameraMod,
    ...(await import(pathToFileURL(join(root, "src", "atlas-map-interactions.ts")).href)),
    ...(await import(pathToFileURL(join(root, "src", "atlas-scale.ts")).href)),
    ...(await import(pathToFileURL(join(root, "src", "atlas-map-grid.ts")).href)),
    ...(await import(pathToFileURL(join(root, "src", "atlas-map-areas.ts")).href)),
    ATLAS_UI_PAGES: (await import(pathToFileURL(join(root, "src", "atlas-ui-core.ts")).href)).ATLAS_UI_PAGES,
  };

  const state = {
    page,
    panelOpen: true,
    serviceStatus: "online",
    chatId,
    binding,
    receipts,
    pendingTurn: null,
    retryableCommit: null,
    lastError: null,
    modeHint: null,
    lorebookHint: null,
    worldNotice: null,
    simulationView: null,
    stateData: {
      chatId,
      worldId: "w-sql",
      worldName: "SQL 世界",
      branchId: "main-A",
      currentTime: 5,
      currentLocationId: "loc:1",
      ...stateData,
    },
  };
  const core = {
    getState: () => state,
    setPage: () => {},
    setPanelOpen: () => {},
    refresh: async () => {},
    selectDestination: async () => {},
    retryLastCommit: async () => {},
    confirmTravel: () => {},
    cancelTravel: () => {},
  };
  const api = { request: async () => ({ status: 200, body: { ok: true, data: {} } }) };
  const container = document.createElement("div");
  document.body.append(container);

  if (Array.isArray(sqlCandidates)) {
    mod.__atlasSqlTest.candidates.length = 0;
    mod.__atlasSqlTest.candidates.push(...sqlCandidates);
  }
  const rerender = mod.renderPanel(core, container, api, { read: async () => null, write: async () => {} }, mapMod);
  return { dom, container, state, core, rerender, seam: mod.__atlasSqlTest, stContext, mod };
}

/** 挂载 SQL 地图页并等视图就绪（模式开 + 桩核心 + 桩视图）。 */
async function mountSqlMap(stateData = {}) {
  globalThis.__atlasSqlStub = { opens: [], queries: [], views: { map: sqlMapView() } };
  const mounted = await mountAtlas({
    page: "map",
    sqlCandidates: [sqlStubUrl()],
    stateData: { sqlModeEnabled: true, revision: 3, map: legacyMapData().map, ...stateData },
  });
  await flush();
  return mounted;
}

/** 打开某地点面板并进入它的内部地图（子图下钻：世界图 → 学校图 → 教室图）。 */
function enterSubmap(container, marker) {
  marker.click();
  const enter = [...container.querySelectorAll(".aw-mappanel__actions button")]
    .find((node) => String(node.textContent ?? "").includes("进入内部地图"));
  assert.ok(enter, `地点「${marker.textContent}」应有「进入内部地图」入口`);
  enter.click();
}

// ---------------------------------------------------------------------------
// 1) 模式关闭：旧路径 + 绝不加载 SQL 核心
// ---------------------------------------------------------------------------

test("H05：模式关闭 → 旧路径照常渲染，且 loadSqlCore 一次都不被调用（不付 sql.js 成本）", async () => {
  const mounted = await mountAtlas({
    page: "map",
    // 候选指向绝不存在的产物：一旦尝试加载，必然留下 SQL_CORE_* 诊断
    sqlCandidates: [missingCoreUrl()],
    stateData: { sqlModeEnabled: false, map: legacyMapData().map },
  });
  await flush();

  assert.equal(mounted.seam.coreStatus().status, "idle", "模式关闭时加载器必须从未被调用（状态仍是 idle）");
  const sqlDiagnostics = mounted.seam.diagnostics().filter((entry) => String(entry.code ?? "").startsWith("SQL_"));
  assert.deepEqual(sqlDiagnostics, [], "模式关闭不得产生任何 SQL 诊断（不加载、不提示）");
  assert.equal(mounted.seam.queue().hasPort(), false, "模式关闭不得注册 SQL 候选端口");

  const ids = [...mounted.container.querySelectorAll("[data-point-id]")].map((node) => node.dataset.pointId).sort();
  assert.deepEqual(ids, ["1", "2"], "旧三表点位照常渲染（行为一字不变）");
  assert.equal(mounted.container.querySelector(".aw-sql-roster")?.childElementCount, 0, "模式关闭不渲染 SQL 粗名单");
  assert.equal(mounted.container.querySelector(".aw-sql-note")?.style.display, "none", "模式关闭不显示 SQL 提示");
  mounted.dom.window.close();
});

// ---------------------------------------------------------------------------
// 2) 模式开启但 SQL 核心不可用：具名诊断 + 旧渲染器兜底
// ---------------------------------------------------------------------------

test("H05/H12：模式开启但 SQL 核心不可用 → 具名诊断 SQL_CORE_UNAVAILABLE，面板退回旧渲染器（不静默、不白屏）", async () => {
  const mounted = await mountAtlas({
    page: "map",
    sqlCandidates: [missingCoreUrl()],
    stateData: { sqlModeEnabled: true, revision: 3, map: legacyMapData().map },
  });
  await flush();

  assert.equal(mounted.seam.coreStatus().status, "unavailable", "加载失败必须落在 unavailable，绝不假装就绪");
  const codes = mounted.seam.diagnostics().map((entry) => entry.code);
  assert.ok(codes.includes("SQL_CORE_UNAVAILABLE"), `必须给出具名诊断：实际 ${codes.join(", ")}`);

  const note = mounted.container.querySelector('[data-sql-code="SQL_CORE_UNAVAILABLE"]');
  assert.ok(note, "面板上要有可见的具名提示（不是只在控制台里）");
  assert.ok(String(note.textContent).includes("SQL_CORE_UNAVAILABLE"), "提示里带诊断码");
  assert.ok(String(note.textContent).includes("dist/atlas-sql.mjs"), "提示要说清缺哪个产物");

  const ids = [...mounted.container.querySelectorAll("[data-point-id]")].map((node) => node.dataset.pointId).sort();
  assert.deepEqual(ids, ["1", "2"], "核心不可用时必须退回旧渲染器（绝不空白面板）");
  mounted.dom.window.close();
});

// ---------------------------------------------------------------------------
// 3) H06：城市图粗名单 / 教室子图人物标点 / 未知坐标不补 0
// ---------------------------------------------------------------------------

test("H06/§10.2：城市图给粗名单且不画粗定位人物；教室子图才出人物标点；未知坐标绝不补 0", async () => {
  const mounted = await mountSqlMap();
  const { container } = mounted;

  // —— 城市图：学校是地点点位，「这里有 3 人」由徽标承载 ——
  const school = container.querySelector('[data-point-id="2"]');
  assert.ok(school, "学校是世界图上的地点点位");
  assert.equal(school.dataset.pointId, "2", "SQL 地点点 id 与地图引用口径一致（去掉 loc: 前缀）");
  assert.equal(school.querySelector(".aw-point__badge")?.textContent, "3", "学校标点显示「这里有 3 人」（艾琳 + 粗名单 2 人）");

  const roster = container.querySelector(".aw-sql-roster");
  assert.ok(roster, "城市图有粗定位名单容器");
  assert.ok(String(roster.textContent).includes("信使") && String(roster.textContent).includes("刺客"),
    "只知「在学校」的人在名单里列出");
  assert.ok(String(roster.textContent).includes("学校L2"), "名单按地点分组");
  assert.ok(String(roster.textContent).includes("不叠人物图标"), "名单负责说明为什么不画图标");

  assert.equal(container.querySelectorAll("[data-npc-id]").length, 0, "城市图绝不把人物画成图标（含与学校同坐标的艾琳）");

  // —— 估计路线：虚线 + 「估计」说明 ——
  const estimated = container.querySelector('.aw-route__path[data-geometry-quality="estimated"]');
  const confirmed = container.querySelector('.aw-route__path[data-geometry-quality="confirmed"]');
  assert.equal(estimated?.getAttribute("stroke-dasharray"), "5 4", "estimated 路线必须虚线");
  assert.equal(confirmed?.getAttribute("stroke-dasharray"), null, "confirmed 路线不画虚线");
  assert.ok(String(container.querySelector(".aw-route-note")?.textContent ?? "").includes("估计"), "有「估计」说明");

  // —— 下钻：世界图 → 学校图 → 教室图 ——
  enterSubmap(container, school);
  await flush();
  const classroomA = container.querySelector('[data-point-id="3"]');
  assert.ok(classroomA, "学校子图显示教室点位（SQL 子图层级来自容器地点）");
  enterSubmap(container, classroomA);
  await flush();

  const king = container.querySelector('[data-npc-id="npc:C4"]');
  assert.ok(king, "教室详细图给有格坐标的人物画独立标点");
  assert.equal(king.dataset.positionQuality, "exact", "已确认落点如实标 exact");
  const servant = container.querySelector('[data-npc-id="npc:C7"]');
  assert.ok(servant, "近似落点也画点（但要带估计标识）");
  assert.equal(servant.dataset.positionQuality, "approximate");
  assert.ok(servant.querySelector(".aw-object__range"), "近似点必须带范围 / 估计角标");
  assert.ok(String(servant.getAttribute("title")).includes("估计"), "近似点的 title 说明是估计");

  assert.equal(container.querySelector('[data-npc-id="npc:C5"]'), null, "未知坐标的人物一个点都不画");
  const zeroPins = [...container.querySelectorAll("[data-npc-id]")].filter((node) => node.style.left === "0px" || node.style.top === "0px");
  assert.deepEqual(zeroPins, [], "绝不把未知坐标补成 0 落到 (0,0)");
  assert.equal(mounted.seam.knownCoordinate(null), null, "H12：未知坐标归一为 null，绝不返回 0");

  assert.ok(String(container.querySelector(".aw-sql-roster")?.textContent ?? "").includes("学生"),
    "教室图仍列出只知地点、未细分位置的人");
  mounted.dom.window.close();
});

// ---------------------------------------------------------------------------
// 4) H07：附近页只读当前修订；空视图替换旧卡片
// ---------------------------------------------------------------------------

test("H07/§10.1：附近页只用当前修订的 SQL 视图；空视图替换旧卡片（没有「上几次人物缓存」）", async () => {
  globalThis.__atlasSqlStub = {
    opens: [],
    queries: [],
    views: {
      nearby: {
        branchId: "main-A", revision: 3,
        items: [{ entityId: "npc:C9", name: "路人甲", relevance: "same_map", positionQuality: "approximate", gridDistance: 4.5 }],
        metadata: { anchor: "at_grid", anchorId: "loc:1", total: 1 },
      },
    },
  };
  const mounted = await mountAtlas({
    page: "nearby",
    sqlCandidates: [sqlStubUrl()],
    stateData: { sqlModeEnabled: true, revision: 3, protagonistId: "npc:C1" },
  });
  await flush();

  const card = mounted.container.querySelector('[data-npc-id="npc:C9"]');
  assert.ok(card, "SQL 附近卡片按视图渲染");
  assert.ok(String(card.textContent).includes("路人甲"), "卡片显示人物名");
  assert.ok(String(card.textContent).includes("位置为估计"), "位置质量如实标注");
  assert.ok(String(card.textContent).includes("4.5"), "距离照实显示");
  assert.deepEqual(globalThis.__atlasSqlStub.queries.map((query) => query.kind), ["nearby"], "只读查询一次 nearby 视图");
  assert.equal(globalThis.__atlasSqlStub.queries[0].entityId, "npc:C1", "锚点用主角实体（同一个位置解析入口）");

  // 新修订 + 空视图：旧卡片必须消失（DOM 节点真的移除，不是隐藏）
  globalThis.__atlasSqlStub.views.nearby = { branchId: "main-A", revision: 4, items: [], metadata: {} };
  mounted.state.stateData.revision = 4;
  mounted.rerender();
  await flush();

  assert.equal(mounted.container.querySelector('[data-npc-id="npc:C9"]'), null, "空视图必须替换旧内容");
  assert.equal(card.isConnected, false, "旧 DOM 节点必须真的从文档里移除");
  assert.ok(String(mounted.container.textContent).includes("清空卡片"), "空态如实说明（不沿用上次结果）");
  mounted.dom.window.close();
});

// ---------------------------------------------------------------------------
// 5) H08：单一时间线 + 同一 log ID + 完整导出
// ---------------------------------------------------------------------------

test("H08：日志页是一条时间线；回执错误链接同一个 log ID；分页不截断导出并如实报 droppedCount", async () => {
  globalThis.__atlasSqlStub = {
    opens: [],
    queries: [],
    views: {
      diagnostics: {
        branchId: "main-A", revision: 3,
        items: [{ logId: "turn_t1", kind: "failed_turn", turnId: "t1", status: "failed", receipt: {}, attempts: {} }],
        metadata: { totalCount: 130, returned: 1, droppedCount: 9, pageSize: 100, exportComplete: false },
        nextCursor: "1",
      },
    },
  };
  const mounted = await mountAtlas({
    page: "logs",
    sqlCandidates: [sqlStubUrl()],
    receipts: [{
      turnId: "t1", status: "failed", currentTime: 7, previousTime: 6, summary: "本轮失败，世界未更新",
      issues: [{ code: "MINIMUM_FIELD_MISSING", path: "$.ops[0].name", line: 2, message: "缺少 name", severity: "error", retryable: false }],
    }],
    stateData: { sqlModeEnabled: true, revision: 3 },
  });
  await flush();

  assert.equal(mounted.container.querySelectorAll(".aw-log--sql").length, 1, "日志页只有一条时间线");

  const ids = [...mounted.container.querySelectorAll('[data-log-id="turn_t1"]')];
  assert.ok(ids.length >= 2, `回执与它的错误明细必须共用同一个 log ID：实际 ${ids.length} 处`);

  const link = mounted.container.querySelector('a.aw-log__link[data-log-id="turn_t1"]');
  assert.ok(link, "错误行带锚点链接到同一个 log ID");
  assert.equal(link.textContent, "#turn_t1", "链接文案就是 log ID");
  assert.equal(link.getAttribute("href"), "#turn_t1");

  const text = String(mounted.container.textContent ?? "");
  assert.ok(text.includes("MINIMUM_FIELD_MISSING"), "错误码可见");
  assert.ok(text.includes("第 2 行"), "错误行号可见");
  assert.ok(text.includes("$.ops[0].name"), "字段路径可见");

  const exportLink = mounted.container.querySelector(".aw-sqllog__export");
  assert.ok(exportLink, "暴露完整导出入口");
  assert.ok(String(exportLink.dataset.exportPath).includes("/sql/diagnostics/export"), "导出走完整导出路径（分页只影响列表）");
  assert.ok(text.includes("留存上限已丢弃 9 条"), "留存丢弃如实报数，绝不静默截断导出");
  assert.ok(text.includes("不完整"), "视图标记 exportComplete=false 时如实说明");
  mounted.dom.window.close();
});

// ---------------------------------------------------------------------------
// 6) H06/§10.3：比例尺读 SQL 地图行；缩放只改读数
// ---------------------------------------------------------------------------

test("H06/§10.3：比例尺读 SQL 地图行的 metersPerCell；缩放只改读数，绝不改每格米数", async () => {
  const mounted = await mountSqlMap();
  const { container } = mounted;

  const bar = container.querySelector(".aw-scale__bar");
  assert.ok(bar, "左下角比例尺仍在（H09–H11 不动）");
  assert.equal(bar.dataset.metersPerCell, "100", "比例尺读的是 SQL 地图行的 meters_per_cell");
  assert.equal(bar.dataset.scaleSource, "sql", "来源如实标为 SQL 地图行");
  const readingBefore = String(container.querySelector(".aw-scale__label")?.textContent ?? "");
  assert.ok(/米|千米/.test(readingBefore), `已标定应给米制读数：实际 "${readingBefore}"`);
  const widthBefore = bar.style.width;

  const zoomIn = [...container.querySelectorAll("button")].find((node) => node.textContent === "＋");
  assert.ok(zoomIn, "有放大按钮");
  zoomIn.dispatchEvent(new mounted.dom.window.MouseEvent("click", { bubbles: true }));
  await flush();

  const readingAfter = String(container.querySelector(".aw-scale__label")?.textContent ?? "");
  assert.notEqual(readingAfter, readingBefore, `缩放必须改变读数：${readingBefore} → ${readingAfter}`);
  assert.equal(container.querySelector(".aw-scale__bar").style.width, widthBefore, "尺条固定在视口坐标系，不随缩放变长");
  assert.equal(container.querySelector(".aw-scale__bar").dataset.metersPerCell, "100", "缩放绝不改 meters_per_cell");
  assert.equal(globalThis.__atlasSqlStub.views.map.items[0].metersPerCell, 100, "地图行原值不变（UI 不改数据）");
  assert.equal(container.querySelectorAll(".aw-scale").length, 1, "仍然只有一条比例尺控件");
  mounted.dom.window.close();
});

// ---------------------------------------------------------------------------
// 7) H12/§10.4：作者开关只改 UI 过滤，不改注入范围
// ---------------------------------------------------------------------------

test("H12/§10.4：作者视图只改 UI 过滤；送入提示词的投影与 viewMode 无关（深相等）", async () => {
  const mounted = await mountSqlMap();
  const { container, seam } = mounted;

  // —— 纯函数层：投影构造刻意忽略 viewMode ——
  const calls = [];
  const sqlCore = {
    projectForPov: (world, pov) => {
      calls.push({ world, pov });
      return { entities: [{ id: "loc:1" }], knowledge: [{ id: "info:1" }] };
    },
  };
  const world = { id: "w-sql" };
  const pov = { id: "npc:C1" };
  const authorScope = seam.promptScope(sqlCore, world, pov, "author");
  const povScope = seam.promptScope(sqlCore, world, pov, "pov");
  assert.deepEqual(authorScope.projection, povScope.projection, "作者视图与主角所知的投影必须逐字段相同");
  assert.deepEqual(calls[0], calls[1], "投影构造参数完全一致（viewMode 不参与投影）");
  assert.equal(authorScope.uiViewMode, "author", "viewMode 只被记录，不影响注入");

  assert.equal(seam.filterByViewMode([{ hidden: true }, { hidden: false }], "author").length, 2, "作者视图显示全部");
  assert.equal(seam.filterByViewMode([{ hidden: true }, { hidden: false }], "pov").length, 1, "主角所知过滤隐藏条目");

  // —— UI 层：开关只改地图显示什么 ——
  assert.equal(container.querySelector('[data-point-id="9"]'), null, "主角所知不知道「密室」");
  const toggle = container.querySelector("#atlas-sql-viewmode-toggle");
  assert.ok(toggle, "SQL 模式下地图页有作者视图开关");
  assert.equal(toggle.getAttribute("aria-pressed"), "false", "默认不是作者视图");
  toggle.dispatchEvent(new mounted.dom.window.MouseEvent("click", { bubbles: true }));
  await flush();
  assert.equal(container.querySelector("#atlas-sql-viewmode-toggle")?.getAttribute("aria-pressed"), "true", "切换后如实反映");
  assert.ok(container.querySelector('[data-point-id="9"]'), "作者视图显示主角尚不知道的地点（纯 UI 过滤）");
  // 同一次切换之后，注入范围仍是主角所知（上面的深相等断言与开关无关）
  assert.deepEqual(seam.promptScope(sqlCore, world, pov, "author").projection, povScope.projection);
  mounted.dom.window.close();
});

// ---------------------------------------------------------------------------
// 8) H05：stop 取消 pending；重新生成用新 variantKey 起新 prepare
// ---------------------------------------------------------------------------

test("H05：stop 取消 pending 并丢弃迟到结果；重新生成换 variantKey 起新候选（截断后能恢复，不卡 NO_PENDING）", async () => {
  const mounted = await mountSqlMap();
  const seam = mounted.seam;

  const floorA = { mes: "第一版正文", is_user: false, swipe_id: 0, send_date: 1758600000000, swipes: ["第一版正文"] };
  const floorB = { mes: "第二版正文", is_user: false, swipe_id: 1, send_date: 1758600000000, swipes: ["第一版正文", "第二版正文"] };
  const identityA = seam.floorIdentity(floorA, 3, { chatId: "chat-sql-ui" });
  const identityB = seam.floorIdentity(floorB, 3, { chatId: "chat-sql-ui" });
  assert.equal(identityA.messageUID, "chat-sql-ui:a:1758600000000", "身份用宿主落盘时间戳，不用数组下标");
  assert.equal(identityA.messageUID, identityB.messageUID, "同一楼层的身份稳定（换 swipe 不换 UID）");
  assert.notEqual(identityA.variantKey, identityB.variantKey, "换 swipe 必然换 variantKey");
  assert.notEqual(identityA.contentHash, identityB.contentHash, "换正文必然换 contentHash");
  const indexOnly = seam.floorIdentity({ mes: "无时间戳", is_user: false }, 7, { chatId: "c" });
  assert.equal(indexOnly.identityFallback, true, "无宿主 id 也无可解析时间戳时才标记为内容寻址兜底");
  assert.ok(!indexOnly.messageUID.includes(":7") || indexOnly.messageUID.endsWith("#f7"),
    "下标只作为同内容重复楼层的消歧后缀，不冒充身份本体");

  // —— 纯状态机：stop 后能立刻起新候选 ——
  let state = { pending: null, cancelled: [], settled: [] };
  let step = seam.prepareStep(state, { type: "prepare", identity: identityA });
  assert.equal(step.status, "prepared");
  const tokenA = step.token;
  state = { pending: step.pending, cancelled: step.cancelled, settled: step.settled };
  step = seam.prepareStep(state, { type: "stop" });
  assert.equal(step.status, "cancelled", "stop 取消当前候选");
  assert.equal(step.pending, null, "取消后不再持有候选");
  state = { pending: step.pending, cancelled: step.cancelled, settled: step.settled };
  assert.equal(seam.prepareStep(state, { type: "stop" }).status, "noop", "没有候选时 stop 是 noop，绝不报错、绝不粘住状态");
  step = seam.prepareStep(state, { type: "prepare", identity: identityB });
  assert.equal(step.status, "prepared", "取消之后必须能起新候选（不被旧的 NO_PENDING 卡住）");
  assert.notEqual(step.token, tokenA, "新变体用新 token");
  const afterB = { pending: step.pending, cancelled: step.cancelled, settled: step.settled };
  const late = seam.prepareStep(afterB, { type: "settle", token: tokenA });
  assert.equal(late.status, "stale-dropped", "迟到的旧 token 结果一律丢弃");
  assert.ok(late.pending, "丢弃迟到结果不会误伤当前候选");

  // —— 控制器 + emitter 归一入口：宿主 stop 事件真的取消 pending ——
  // 必须用**模块单例**队列：emitter 的归一入口（atlasSqlNoteHostEvent）用的就是它，
  // 另建一个队列会让端口注册在错误的实例上（这正是「事件没取消候选」的现场）。
  const discarded = [];
  let release = null;
  const queue = seam.queue();
  queue.setPort({
    prepareTurn: () => new Promise((resolve) => { release = resolve; }),
    discardPrepared: async (token) => { discarded.push(token); return true; },
  });
  const pendingPrepare = queue.prepare(identityA);
  await flush(2);
  assert.ok(queue.snapshot().pending, "候选已登记（等 prepareTurn 回来）");

  const registered = [];
  const fired = [];
  const emitter = seam.emitter(() => ({
    eventSource: { on: (name, handler) => registered.push([name, handler]), removeListener: () => {}, off: () => {} },
    event_types: { GENERATION_STOPPED: "gs", MESSAGE_RECEIVED: "mr" },
    chat: [floorA],
    chatId: "chat-sql-ui",
  }));
  emitter.on("GENERATION_STOPPED", () => fired.push("stopped"));
  const stopHandler = registered.find(([name]) => name === "gs")?.[1];
  assert.ok(stopHandler, "stop 事件已注册");
  stopHandler();
  await flush(2);
  assert.deepEqual(fired, ["stopped"], "业务处理函数照常收到事件（归一入口不吞事件）");
  assert.equal(queue.snapshot().pending, null, "宿主 stop 事件必须取消 SQL 候选");
  assert.deepEqual(discarded, [tokenA], "停止生成时丢弃候选快照");
  release?.(null);
  assert.equal((await pendingPrepare).status, "stale-dropped", "停止之后的迟到结果不采纳");

  // 恢复：新变体立刻能起新候选（截断 → 重新生成不再永久卡住）
  queue.setPort({ prepareTurn: async () => ({ ok: true }), discardPrepared: async () => true });
  const recovered = await queue.prepare(identityB);
  assert.equal(recovered.status, "settled", "新变体可以正常起候选并结算");
  assert.equal(queue.snapshot().pending, null, "结算后没有悬挂候选");
  mounted.dom.window.close();
});
