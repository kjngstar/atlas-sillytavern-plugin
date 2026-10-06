/**
 * U16：新工作台的浏览器级测试（**jsdom harness，不是真实浏览器**）。
 *
 * 包内要求 playwright 真实点击 / 拖拽 / 双指 / 320px / 固定标尺。本环境只装了 jsdom
 * （node_modules 里没有 playwright，也没有浏览器二进制），因此：
 *  - 真实 DOM 事件（click / input）走 jsdom 派发，断言真实 DOM 结构；
 *  - 320px 与固定 96px 标尺改为断言 CSS 契约（媒体查询 + 容器 min-width:0 + 条长不随 zoom）；
 *  - 拖拽 / 双指的手势判定用事件坐标走单元级断言（tests/atlas-workbench.test.mjs）。
 * 明确标注：没有真实 ST / 浏览器验收，这里是 harness。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

import { ATLAS_UI_PAGES } from "../src/atlas-ui-core.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VIEW_W = 720, VIEW_H = 480;

function setupDom() {
  const dom = new JSDOM("<!doctype html><head></head><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { get: () => VIEW_W, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { get: () => VIEW_H, configurable: true });
  return dom;
}

/** 宿主外壳替身：只提供 U02 需要的槽位与既有 shell 表面。 */
function stubShell(doc) {
  const layerSlot = doc.createElement("div");
  const inspectorBody = doc.createElement("div");
  doc.body.append(layerSlot, inspectorBody); // 槽位必须真正在文档里，否则组件等于没挂上
  const calls = { destroyed: false, synced: 0, updated: 0 };
  return {
    calls, layerSlot, inspectorBody,
    sync() { calls.synced += 1; },
    updateMap() { calls.updated += 1; },
    dockDetail() {},
    openInspector() {}, closeInspector() {},
    destroy() { calls.destroyed = true; },
  };
}

function buildHost(doc, overrides = {}) {
  const root = doc.createElement("div");
  root.className = "atlas-starmap";
  const rail = doc.createElement("aside");
  const foot = doc.createElement("div");
  const side = doc.createElement("aside");
  const sideFoot = doc.createElement("div");
  side.append(sideFoot);
  const main = doc.createElement("main");
  const sideChanges = doc.createElement("div");
  sideFoot.append(sideChanges);
  const moves = doc.createElement("div");
  doc.body.append(root, rail, foot, side, main);
  return { doc, root, rail, foot, side, sideFoot, sideChanges, moves, ...overrides };
}

async function mount(doc, host, ports = {}) {
  const { mountWorkbench } = await import("../ui/atlas-workbench-shell.mjs");
  return mountWorkbench(host, ports);
}

test('原版 UI 正式入口只挂参考 UI，不包含旧面板',()=>{
 const js=readFileSync(join(root,'index.js'),'utf8');
 assert.ok(js.includes('return mountReferenceUi('));
 assert.ok(!js.includes('function renderLegacyPanel'));
 assert.ok(!js.includes('function renderHistoricalPanel'));
 assert.ok(!js.includes('mountWorkbench'));
});
test('原版地图通过独立文档接线，canvas 与手势来自提供的源文件',()=>{
 const host=readFileSync(join(root,'ui/atlas-reference-host.mjs'),'utf8'),html=readFileSync(join(root,'ui/atlas-reference/index.html'),'utf8'),map=readFileSync(join(root,'ui/atlas-reference/js/map.js'),'utf8');
 assert.ok(host.includes("createElement('iframe')"));assert.ok(html.includes('<canvas id="map"'));
 assert.ok(map.includes("listen(canvas,'pointerdown'"));assert.ok(map.includes('if(st.node.host)return (st.node.marks||[])'));
});
test('原版样式与字体随生产包分发，正式文档有实际加载入口',()=>{
 const html=readFileSync(join(root,'atlas-extension/ui/atlas-reference/index.html'),'utf8');
 for(const css of ['atlas.css','preview.css']){assert.ok(html.includes('css/'+css));assert.ok(existsSync(join(root,'atlas-extension/ui/atlas-reference/css',css)));}
 assert.ok(existsSync(join(root,'atlas-extension/ui/atlas-reference/fonts/atlas-sans.woff')));
});

test("U08 返工回归：视图类型不被查询参数覆盖（控制器侧防线）", () => {
  // 进度验收 20261006 指出的 P1：{kind, ...query} 会把目录查询的视图类型覆盖成 entityKind 值。
  // 防线 = 合并顺序：kind 放在 query 之后，查询参数永远无法覆盖视图类型。
  const controllerSource = readFileSync(join(root, "ui", "atlas-sql-view-controller.mjs"), "utf8");
  assert.ok(
    /\{\s*\.\.\.scopedQuery,\s*kind\s*\}/.test(controllerSource),
    "sqlQueryView 必须以 { ...query, kind } 合并（kind 最后落地，不可被覆盖）",
  );
  // 行为层由 tests/atlas-workbench.test.mjs 的「目录查询 kind=视图类型」用例覆盖（query.kind 不携带）。
  // 面板侧防线：目录控制器传 entityKind，不传 kind
  const panelSource = readFileSync(join(root, "ui", "atlas-catalog-panel.mjs"), "utf8");
  assert.ok(/entityKind:\s*kind/.test(panelSource), "目录面板必须用 entityKind 传实体种类");
});

test("U14 导航清单单一权威：包含人物/物品/事件/提示词，原有页一个不少", () => {
  const ids = ATLAS_UI_PAGES.map((page) => page.id);
  for (const id of ["characters", "items", "events", "prompts"]) {
    assert.ok(ids.includes(id), `清单必须包含 ${id}`);
  }
  for (const id of ["overview", "map", "nearby", "changes", "progression", "api", "replace", "skin", "logs"]) {
    assert.ok(ids.includes(id), `原有页 ${id} 不得因新导航消失`);
  }
  assert.equal(new Set(ids).size, ids.length, "页面不重复");
});

test("U02 新 UI 连接：区域齐全（左树 / 右详情 / 目录 / 时间线 / 摘要 / 日志）", async () => {
  const dom = setupDom();
  const host = buildHost(dom.window.document);
  const shell = stubShell(dom.window.document);
  host.createShell = () => shell;
  const workbench = await mount(dom.window.document, host, {});
  for (const [name, slot] of Object.entries(workbench.panels)) {
    assert.ok(slot && slot.isConnected !== false, `${name} 必须挂到 DOM`);
  }
  // 真实 shell 会把 foot 搬进 rail（左栏底部）；替身里 foot 就是左栏底槽。
  assert.ok(shell.layerSlot.contains(workbench.panels.summarySlot), "读者摘要挂在完整宽度的左地图栏");
  assert.ok(host.sideFoot.contains(workbench.panels.catalogSlot), "目录挂在右栏");
  assert.equal(workbench.panels.catalogSlot.hidden, true, "默认不显示目录页");
  workbench.destroy();
});

test("U02 重复 mount 先销毁旧实例：同一 root 只挂一个工作台", async () => {
  const dom = setupDom();
  const host = buildHost(dom.window.document);
  const first = stubShell(dom.window.document);
  const second = stubShell(dom.window.document);
  let useSecond = false;
  host.createShell = () => (useSecond ? second : first);
  const a = await mount(dom.window.document, host, {});
  useSecond = true;
  const b = await mount(dom.window.document, host, {});
  assert.equal(first.calls.destroyed, true, "旧实例必须先销毁");
  assert.notEqual(a, b);
  b.destroy();
});

test("U06 详情卡：未选中说未选中；资料名含 HTML 不执行", async () => {
  const dom = setupDom();
  const doc = dom.window.document;
  const host = buildHost(doc);
  host.createShell = () => stubShell(doc);
  const workbench = await mount(doc, host, {});
  assert.match(workbench.panels.detailSlot.textContent, /未选中/, "未选中不能沿用上一个实体");
  workbench.showEntity({
    kind: "location", id: "L1", name: "<img src=x onerror=alert(1)>教室",
    summary: "这是一间教室", childLocations: [{ name: "讲台" }], present: [{ id: "C1", name: "艾拉" }],
  });
  const detail = workbench.panels.detailSlot;
  assert.ok(detail.textContent.includes("教室"), "详情显示名称");
  assert.equal(detail.querySelector("img"), null, "名称里的 HTML 不得变成元素");
  assert.ok(detail.querySelector(".awb-card--location"), "地点卡");
  workbench.destroy();
});

test("U08 目录：点击条目触发宿主选中；POV 不显示总数", async () => {
  const dom = setupDom();
  const doc = dom.window.document;
  const host = buildHost(doc);
  host.createShell = () => stubShell(doc);
  const picks = [];
  host.onSelectEntity = (payload) => picks.push(payload);
  const model = null;
  const workbench = await mount(doc, host, {
    queryView: async () => ({ items: [{ id: "E1", name: "长剑", entityKind: "item", locationName: "铁匠铺" }], nextCursor: null }),
  });
  const pageHost = doc.createElement("div");
  doc.body.append(pageHost);
  await workbench.renderCatalogPage(pageHost, "item");
  const entry = pageHost.querySelector(".awb-catalog-entry");
  assert.ok(entry, "目录条目必须渲染");
  entry.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(picks.length, 1, "点击条目要触发选中");
  assert.equal(picks[0].id, "E1");
  assert.ok(!/\d+\s*条|\/\s*\d+/.test(pageHost.textContent), "POV 不返回总数");
  assert.equal(model, null);
  workbench.destroy();
});

test("U08 紧凑搜索：q 变化旧结果不落地（debounce + ticket）", async () => {
  const dom = setupDom();
  const doc = dom.window.document;
  const host = buildHost(doc);
  host.createShell = () => stubShell(doc);
  const workbench = await mount(doc, host, {
    queryView: async (kind, query) => ({ items: [{ id: `S:${query.q ?? ""}`, name: `结果-${query.q ?? ""}` }], nextCursor: null }),
  });
  const first = workbench.searchCatalog("剑");
  const second = workbench.searchCatalog("剑士");
  const firstOut = await first;
  assert.equal(firstOut, null, "被新搜索取代的结果不落地");
  const secondOut = await second;
  assert.ok(secondOut && secondOut.rows.length === 1);
  assert.equal(secondOut.rows[0].name, "结果-剑士");
  workbench.destroy();
});

test("U09 时间线：blocked 不标已发生；POV 看不到秘密事件", async () => {
  const dom = setupDom();
  const doc = dom.window.document;
  const host = buildHost(doc);
  host.createShell = () => stubShell(doc);
  const workbench = await mount(doc, host, {});
  workbench.showTimeline({
    events: [
      { id: "EV1", title: "钟声响了", occurred: true },
      { id: "EV2", title: "秘密会议", hidden: true },
    ],
    tasks: [{ id: "T1", title: "送信去港口", blocked: true }],
  });
  const text = workbench.panels.timelineSlot.textContent;
  assert.ok(text.includes("钟声响了"));
  assert.ok(!text.includes("秘密会议"), "POV 不显示秘密事件");
  assert.ok(text.includes("等待条件"), "blocked 不能标成已发生");
  workbench.destroy();
});

test("U11 摘要：turnId / revision 不一致就是 stale，不沿用上一聊天", async () => {
  const dom = setupDom();
  const doc = dom.window.document;
  const host = buildHost(doc);
  host.createShell = () => stubShell(doc);
  const workbench = await mount(doc, host, {});
  workbench.showSummary({ turnId: "t-1", revision: 3, viewMode: "pov", lines: ["艾拉进了教室。"], source: "program", note: null });
  assert.ok(workbench.panels.summarySlot.textContent.includes("艾拉进了教室。"));
  host.turnId = () => "t-2"; // 换一轮
  const staleHost = buildHost(doc);
  const stale = await mount(doc, { ...staleHost, createShell: () => stubShell(doc), turnId: () => "t-2" }, {});
  stale.showSummary({ turnId: "t-1", revision: 3, viewMode: "pov", lines: ["艾拉进了教室。"], source: "program", note: null });
  assert.ok(!stale.panels.summarySlot.textContent.includes("艾拉进了教室。"), "stale 摘要不得沿用");
  assert.match(stale.panels.summarySlot.textContent, /等待|没有/, "给等待/空说明");
  workbench.destroy();
  stale.destroy();
});

test("U12 统一日志：密钥脱敏、分组可展开、导出剔除敏感字段", async () => {
  const dom = setupDom();
  const doc = dom.window.document;
  const host = buildHost(doc);
  host.createShell = () => stubShell(doc);
  const workbench = await mount(doc, host, {});
  workbench.showLog([
    { id: "1", traceId: "tr-1", attemptId: "at-1", code: "SPATIAL_FRAME_INVALID", level: "error", source: "storage",
      message: "key sk-abcdef1234567890 失效", schemaPath: "$.maps.frame_json",
      details: { mapRef: "map:abc", api_key: "sk-nope", bytes: 2048 } },
    { id: "2", traceId: "tr-1", attemptId: "at-1", code: "SPATIAL_ROUTE_INVALID", level: "warn", source: "map", message: "路线不可读" },
  ]);
  const slot = workbench.panels.logSlot;
  assert.ok(!slot.textContent.includes("sk-abcdef1234567890"), "日志页不显示密钥原文");
  assert.ok(slot.textContent.includes("[redacted]"), "脱敏占位");
  assert.ok(!slot.textContent.includes("api_key"), "敏感字段名不进日志页");
  assert.ok(slot.textContent.includes("2048"), "允许字段完整显示");
  const head = slot.querySelector(".awb-log-head");
  assert.ok(head && head.textContent.includes("2 条"), "按 trace/attempt 分组");
  head.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(slot.querySelector(".awb-log-body").hidden, false, "点击展开");
  workbench.destroy();
});

test("U03 样式契约：320px 抽屉、canvas 容器 min-width:0、标尺固定 96px、无全局 reset", () => {
  const css = readFileSync(join(root, "ui", "atlas-workbench.css"), "utf8");
  assert.ok(/\.atlas-starmap\s+canvas\s*\{[^}]*min-width:\s*0/.test(css), "canvas 容器可收缩");
  assert.ok(css.includes("@media (max-width: 900px)"), "窄屏抽屉");
  assert.ok(/width:\s*96px/.test(css), "标尺固定 96 CSS px");
  assert.ok(/@media \(prefers-reduced-motion: reduce\)/.test(css), "尊重减弱动效");
  assert.ok(!/^\s*body\s*\{/m.test(css), "不 reset body");
  assert.ok(!/^\s*button\s*\{/m.test(css), "不 reset button");
});

test("U05 地图树渲染：点击行进入导航；多楼层都渲染出来（spatialTree 节点结构）", async () => {
  const dom = setupDom();
  const doc = dom.window.document;
  const host = buildHost(doc);
  host.createShell = () => stubShell(doc);
  const moves = [];
  host.onNavigate = (row) => moves.push(row.mapId);
  const workbench = await mount(doc, host, {});
  const spatialTree = {
    nodes: [
      { mapId: "world", name: "世界", kind: "world", parentMapId: null },
      { mapId: "school", name: "学校", kind: "building", parentMapId: "world" },
      { mapId: "f1", name: "一层", kind: "floor", parentMapId: "school" },
      { mapId: "f2", name: "二层", kind: "floor", parentMapId: "school" },
    ],
    childMapsByLocation: {}, issues: [],
  };
  workbench.updateMap({ spatialTree, activeMapId: "school", ownerId: "school", path: [], name: "学校" });
  const labels = [...workbench.panels.treeSlot.querySelectorAll(".awb-tree-label")].map((el) => el.textContent);
  assert.deepEqual(labels, ["世界", "学校", "一层", "二层"], "两个楼层都要出现，不自动挑第一项");
  const school = [...workbench.panels.treeSlot.querySelectorAll(".awb-tree-label")].find((el) => el.textContent === "学校");
  school.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(moves, ["school"], "点击层级行触发导航");
  workbench.destroy();
});

test("U05 返工回归：旧数组树不得喂进 renderMapTree（不再出现两份树）", async () => {
  const dom = setupDom();
  const doc = dom.window.document;
  const host = buildHost(doc);
  host.createShell = () => stubShell(doc);
  const workbench = await mount(doc, host, {});
  // 旧 atlasWorkbenchTree 的行数组（带 path/hasMap，无 nodes）——只归旧 shell。
  workbench.updateMap({
    tree: [{ id: "world", name: "世界", depth: 0, path: [], parentPath: [], mapId: null, hasMap: true }],
    ownerId: "world", path: [], name: "世界地图",
  });
  assert.equal(workbench.panels.treeSlot.querySelectorAll(".awb-tree-row").length, 0,
    "旧数组树不得渲染进新树（此前 tree.nodes 读 undefined → 恒空树 + 双树并存）");
  workbench.destroy();
});
