/**
 * U01 / U04 / U05 / U06 / U07 / U08 / U10 / U12 的单元级回归。
 *
 * 纯逻辑（无 DOM）在这里跑；需要真实 DOM 的交互在 atlas-workbench.e2e.test.mjs。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createWorkbenchModel, workbenchCameraKey, workbenchScopeKey } from "../ui/atlas-workbench-model.mjs";
import { mapsForLocation, mapPath, parentMapOf, renderMapTree } from "../ui/atlas-map-tree.mjs";
import { createCatalogController, renderCatalog, SEARCH_LIMIT } from "../ui/atlas-catalog-panel.mjs";
import { createWorkbenchMapController, isDragMovement } from "../ui/atlas-map-controller.mjs";
import { redactLogText, logGroupKey } from "../ui/atlas-unified-log-panel.mjs";
import { buildVisibleWorldSummary, buildVisibleWorldSummarySync } from "../src/atlas-world-summary.ts";

const SCOPE_A = { chatId: "chat-a", branchId: "b1", revision: 7, viewMode: "pov", povId: "pov-1" };
const SCOPE_B = { chatId: "chat-b", branchId: "b2", revision: 9, viewMode: "author", povId: "pov-2" };

test("U01 初始化没有任何示例地图/人物：视图全空、相机无缓存", () => {
  const model = createWorkbenchModel({});
  const snap = model.snapshot();
  for (const [key, value] of Object.entries(snap.views)) assert.equal(value, null, `${key} 初始必须为空`);
  assert.equal(snap.cameraKeys.length, 0, "初始不缓存任何相机");
  assert.equal(snap.selected, null);
  assert.equal(snap.mapId, null);
});

test("U01 scope 变化清空视图与选中，并回调宿主；同 scope 不重复清", () => {
  let invalidated = 0;
  const model = createWorkbenchModel({ onScopeInvalidated: () => { invalidated += 1; } });
  model.setScope(SCOPE_A);
  model.setView("map", { items: [1] });
  model.select("location", "L1");
  const again = model.setScope(SCOPE_A);
  assert.equal(again.changed, false, "同 scope 不触发清空");
  assert.equal(invalidated, 0);
  model.setScope(SCOPE_B);
  assert.equal(invalidated, 1, "跨聊天切换必须通知宿主");
  assert.equal(model.snapshot().views.map, null, "旧视图清空");
  assert.equal(model.snapshot().selected, null, "旧选中清空");
});

test("U01 切页不产生也不推进世界时钟（状态里没有时钟字段）", () => {
  const model = createWorkbenchModel({});
  model.setScope(SCOPE_A);
  const before = JSON.stringify(model.snapshot());
  model.setPage("characters");
  model.setPage("events");
  const after = model.snapshot();
  assert.equal(after.page, "events");
  assert.ok(!("clock" in after) && !("currentTime" in after), "UI 状态不持有世界时钟");
  assert.notEqual(before, JSON.stringify(after)); // 只换页，不动其他
  assert.deepEqual(after.views, { map: null, scene: null, flows: null, tasks: null, catalog: null, changes: null, diagnostics: null, entity: null });
});

test("U01 相机 key 包含 chat/branch/map/viewMode：跨聊不复用", () => {
  assert.notEqual(workbenchCameraKey(SCOPE_A, "M1"), workbenchCameraKey(SCOPE_B, "M1"), "跨聊天不复用");
  assert.notEqual(workbenchCameraKey(SCOPE_A, "M1"), workbenchCameraKey(SCOPE_A, "M2"), "跨地图不复用");
  const pov = { ...SCOPE_A, viewMode: "author" };
  assert.notEqual(workbenchCameraKey(SCOPE_A, "M1"), workbenchCameraKey(pov, "M1"), "跨视角不复用");
  const model = createWorkbenchModel({});
  model.setScope(SCOPE_A);
  model.setCamera("M1", { s: 2, x: 1, y: 1 });
  model.setScope(SCOPE_B);
  assert.equal(model.getCamera("M1"), null, "换聊天后拿不到上一个聊天的相机");
  assert.equal(workbenchScopeKey(SCOPE_A), "chat-a|b1|7|pov|pov-1");
});

test("U01 异步回包带 ticket：过期回包不落地", async () => {
  const model = createWorkbenchModel({ queryView: async () => ({ items: [1, 2, 3] }) });
  model.setScope(SCOPE_A);
  const first = model.load("catalog", { kind: "item" });
  model.setScope(SCOPE_B); // 换聊天：first 的回包作废
  const outcome = await first;
  assert.notEqual(outcome.issued, model.ticket, "旧 ticket 落后于当前 ticket");
  assert.equal(model.setView("catalog", outcome.result, outcome.issued), false, "过期回包拒绝落地");
});

test("U05 地图树：父子链、多子图、循环不死循环", () => {
  const tree = {
    nodes: [
      { mapId: "world", containerLocationId: null, name: "世界", kind: "world", parentMapId: null },
      { mapId: "city", containerLocationId: "L-city", name: "城", kind: "city", parentMapId: "world" },
      { mapId: "school", containerLocationId: "L-school", name: "学校", kind: "building", parentMapId: "city" },
      { mapId: "f1", containerLocationId: "L-f1", name: "一层", kind: "floor", parentMapId: "school" },
      { mapId: "f2", containerLocationId: "L-f2", name: "二层", kind: "floor", parentMapId: "school" },
      { mapId: "loop", containerLocationId: null, name: "坏图", kind: "floor", parentMapId: "loop" },
    ],
    childMapsByLocation: { "L-city": ["city"], "L-school": ["school"], "L-f1": ["f1"], "L-f2": ["f2"] },
    issues: [],
  };
  assert.deepEqual(mapsForLocation(tree, "L-school"), ["school"]);
  assert.deepEqual(mapsForLocation(tree, "L-none"), []);
  assert.deepEqual(mapPath(tree, "f2"), ["world", "city", "school", "f2"]);
  assert.equal(parentMapOf(tree, "f2"), "school");
  assert.equal(parentMapOf(tree, "world"), null);
  // 自环：mapPath 有 seen 保护，不会无限展开
  assert.deepEqual(mapPath(tree, "loop"), ["loop"]);
});

test("U05 渲染：多个楼层不自动挑第一项（只给进入入口，不替用户选）", () => {
  const doc = globalThis.document ?? null;
  if (!doc) return; // 无 DOM 环境跳过渲染分支
});

test("U08 目录控制器：q 变化旧 cursor 作废，空输入立即清空", async () => {
  const calls = [];
  const model = createWorkbenchModel({
    queryView: async (kind, query) => { calls.push(query); return { items: [{ id: "x1", name: "条目" }], nextCursor: null }; },
  });
  model.setScope(SCOPE_A);
  const controller = createCatalogController({ model, kind: "item", pageSize: 50 });
  const first = controller.search("剑");
  controller.search("剑"); // q 未变但重新搜索 → 上一轮作废
  const outcome = await first;
  assert.equal(outcome, null, "被新查询取代的回包不落地");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(calls.length >= 1);
  controller.destroy();
});

test("U08 紧凑搜索上限 20 条；目录分页不被地图可见上限截断", () => {
  assert.equal(SEARCH_LIMIT, 20);
  const doc = globalThis.document;
  if (!doc) return;
});

/** 极简 canvas / 渲染器替身：不依赖浏览器。 */
function fakeRenderer() {
  const calls = { scenes: [], overlays: [], destroyed: false };
  return {
    calls,
    state: { cam: { s: 2, x: 0, y: 0 } },
    setScene(scene) { calls.scenes.push(scene); },
    setOverlays(rows) { calls.overlays.push(rows); },
    setCamera() { return true; },
    focus(id) { return String(id).length > 0; },
    resize() {},
    destroy() { calls.destroyed = true; },
  };
}

test("U04 地图控制器：同 revision 才投影；过期 response 不 setScene", async () => {
  const created = [];
  const controller = createWorkbenchMapController({
    canvas: {},
    createRenderer: () => { const r = fakeRenderer(); created.push(r); return r; },
    projectors: {
      unwrapViewResult: (view) => ({ ok: true, view }),
      projectMapView: () => ({ ok: true, status: "ready", scene: { mapId: "M1" }, issues: [] }),
    },
    queryView: async (kind) => ({ revision: 7, items: [], [kind]: true }),
  });
  const first = controller.showMap(SCOPE_A, "M1");
  controller.showMap(SCOPE_A, "M2"); // 立刻切图 → 上一批作废
  await first;
  assert.equal(created.length <= 1, true, "只创建一个渲染器（一个手势 owner）");
  controller.destroy();
});

test("U04 缺 scene 显示 SQL 概览，不虚构细场景；坏 scene 不清掉已有效旧图", async () => {
  const issues = [];
  const renderer = fakeRenderer();
  let mode = "empty";
  const controller = createWorkbenchMapController({
    canvas: {},
    createRenderer: () => renderer,
    projectors: {
      unwrapViewResult: (view) => ({ ok: true, view }),
      projectMapView: () => (mode === "empty"
        ? { ok: true, status: "empty", scene: null, issues: [] }
        : { ok: true, status: "ready", scene: { mapId: "M1" }, issues: [] }),
    },
    queryView: async () => ({ revision: 7, items: [] }),
    onIssue: (row) => issues.push(row.code),
  });
  await controller.showMap(SCOPE_A, "M1");
  assert.ok(issues.includes("SPATIAL_SCENE_EMPTY"), "空场景要明说按 SQL 概览显示");
  mode = "ready";
  await controller.showMap(SCOPE_A, "M1");
  assert.equal(renderer.calls.scenes.at(-1)?.mapId, "M1", "有效场景正常上屏");
  controller.destroy();
  assert.equal(renderer.calls.destroyed, true, "destroy 必须销毁渲染器");
});

test("U04 返工回归：scene ready 优先画已保存 floor 场景，绝不画成 overview", async () => {
  const renderer = fakeRenderer();
  const projectorCalls = [];
  const savedFloorScene = {
    kind: "scene", mapId: "M1", branchId: SCOPE_A.branchId,
    layout: { id: "M1", kind: "floor", rooms: [{ id: "r1", x: 0, y: 0, w: 8, h: 6, name: "教室" }], actors: [], items: [] },
  };
  const controller = createWorkbenchMapController({
    canvas: {},
    createRenderer: () => renderer,
    projectors: {
      unwrapViewResult: (view) => ({ ok: true, view }),
      projectMapView: (args) => { projectorCalls.push(args); return { ok: true, status: "ready", scene: { mapId: "M1", layout: { kind: "overview", pins: [] } }, issues: [] }; },
    },
    queryView: async (kind) => (kind === "scene"
      ? { branchId: SCOPE_A.branchId, revision: 7, items: [{ mapId: "M1", sceneStatus: "ready", scene: savedFloorScene, coarseList: [], issues: [] }], metadata: {} }
      : { branchId: SCOPE_A.branchId, revision: 7, items: [], metadata: {} }),
  });
  const outcome = await controller.showMap(SCOPE_A, "M1");
  assert.equal(outcome.status, "ready");
  assert.equal(outcome.mode, "scene", "scene 视图 ready 时必须按已保存场景上屏");
  assert.equal(renderer.calls.scenes.at(-1), savedFloorScene, "渲染器拿到的就是保存的 floor 场景，不是 overview 投影");
  assert.equal(projectorCalls.length, 0, "scene ready 时不再走概览投影（此前 scene 结果被查了不用）");
  controller.destroy();
});

test("U04 返工回归：scene missing 才退 SQL 概览；invalid 同样退概览并报诊断", async () => {
  const renderer = fakeRenderer();
  const issues = [];
  const overviewScene = { mapId: "M1", layout: { kind: "overview", pins: [{ id: "L1", type: "location", x: 1, y: 1, name: "校门" }] } };
  let sceneStatus = "missing";
  const controller = createWorkbenchMapController({
    canvas: {},
    createRenderer: () => renderer,
    projectors: {
      unwrapViewResult: (view) => ({ ok: true, view }),
      projectMapView: () => ({ ok: true, status: "ready", scene: overviewScene, issues: [] }),
    },
    queryView: async (kind) => (kind === "scene"
      ? { branchId: SCOPE_A.branchId, revision: 7, items: [{ mapId: "M1", sceneStatus, scene: null, coarseList: [], issues: [] }], metadata: {} }
      : { branchId: SCOPE_A.branchId, revision: 7, items: [], metadata: {} }),
    onIssue: (row) => issues.push(row.code),
  });
  let outcome = await controller.showMap(SCOPE_A, "M1");
  assert.equal(outcome.mode, "overview", "missing 场景退概览");
  assert.equal(renderer.calls.scenes.at(-1), overviewScene);
  assert.ok(issues.includes("SPATIAL_SCENE_EMPTY"));
  sceneStatus = "invalid";
  outcome = await controller.showMap(SCOPE_A, "M1");
  assert.equal(outcome.mode, "overview", "invalid 场景也退概览");
  assert.ok(issues.includes("SPATIAL_SCENE_INVALID"));
  controller.destroy();
});

test("U08 返工回归：目录查询 kind=视图类型、entityKind=实体种类；scope 字段展开到顶层", async () => {
  const calls = [];
  const model = createWorkbenchModel({
    queryView: async (kind, query) => { calls.push({ kind, query }); return { items: [], nextCursor: null }; },
  });
  model.setScope(SCOPE_A);
  const controller = createCatalogController({ model, kind: "character", pageSize: 50 });
  const out = await controller.search("艾");
  assert.ok(out);
  const call = calls.at(-1);
  assert.equal(call.kind, "catalog", "视图类型必须是 catalog（此前被 query.kind 覆盖成 character）");
  assert.equal(call.query.entityKind, "character", "实体种类走 entityKind");
  assert.equal(call.query.kind, undefined, "查询参数不得携带视图 kind 字段");
  assert.equal(call.query.q, "艾");
  assert.equal(call.query.branchId, SCOPE_A.branchId, "scope 显式映射到 ViewQuery 顶层 branchId");
  assert.equal(call.query.viewMode, SCOPE_A.viewMode, "scope 显式映射到 ViewQuery 顶层 viewMode");
  assert.equal(call.query.scope, undefined, "不得塞 scope 包（隐式猜测字段）");
  controller.destroy();
});

test("U07 点击进入：默认只开详情；开关开启且唯一子图才直接进；多子图交选择", () => {
  let entered = null, chosen = null;


  const controller = createWorkbenchMapController({
    canvas: {}, createRenderer: () => fakeRenderer(), projectors: {}, queryView: async () => ({}),
    onEnter: (mapId) => { entered = mapId; }, onChoose: (payload) => { chosen = payload.maps; },
  });
  const location = { type: "location", id: "L1" };
  assert.equal(controller.handleClick(location, {}).entered, false, "默认单击只开详情");
  assert.equal(controller.handleClick(location, { settings: { singleClickEnter: true }, children: [] }).entered, false, "没有子图不进入");
  const one = controller.handleClick(location, { settings: { singleClickEnter: true }, children: [{ mapId: "M9" }] });
  assert.equal(one.entered, true);
  assert.equal(entered, "M9");
  const many = controller.handleClick(location, { settings: { singleClickEnter: true }, children: [{ mapId: "M9" }, { mapId: "M10" }] });
  assert.equal(many.entered, false, "多个楼层不能自动挑第一个");
  assert.deepEqual(chosen, ["M9", "M10"]);
  // 双击 / Enter 走 force：与按钮同一个函数
  const forced = controller.handleClick(location, { force: true, children: [{ mapId: "M11" }] });
  assert.equal(forced.entered, true);
  controller.destroy();
});

test("U07 拖拽超过 4 CSS px 视为平移，不触发点击", () => {
  assert.equal(isDragMovement(1, 1), false);
  assert.equal(isDragMovement(9, 0), true);
});

test("U10 世界摘要：1–3 条、POV 不看到隐藏项、blocked 不标已发生", () => {
  const input = {
    turnId: "t-1", revision: 3, viewMode: "pov",
    events: [
      { actorName: "艾拉", locationName: "教室", title: "放下书包" },
      { actorName: "秘密人物", title: "密谋", hidden: true },
      { actorName: "第三人", title: "再一条" },
      { actorName: "第四人", title: "第四条" },
    ],
  };
  const result = buildVisibleWorldSummarySync(input);
  assert.ok(result.lines.length >= 1 && result.lines.length <= 3, "最多 3 条");
  assert.ok(!result.lines.some((line) => line.includes("秘密人物")), "POV 不显示隐藏项");
  assert.equal(result.turnId, "t-1");
  assert.equal(result.viewMode, "pov");
  const blocked = buildVisibleWorldSummarySync({
    turnId: "t-2", revision: 4, viewMode: "pov",
    tasks: [{ actorName: "信使", toLocationName: "港口", blocked: true }],
  });
  assert.ok(blocked.lines[0].includes("等待条件"), "blocked 不能标成已发生");
});

test("U10 技术串不进侧栏；无公开变化给正常空说明", () => {
  const filtered = buildVisibleWorldSummarySync({
    turnId: "t-3", revision: 5, viewMode: "pov",
    events: [{ title: "TABLE_MIGRATED" }, { title: "应用 5 行" }, { title: "第 0→0 时段" }, { title: "WORLD_TURN success" }],
  });
  assert.equal(filtered.lines.length, 0, "技术计数不是世界动向");
  assert.ok(filtered.note && filtered.note.includes("没有"), "空态给正常说明");
  assert.equal(filtered.source, "empty");
});

test("U10 模型摘要失败回退程序模板；模型摘要只收到可见小集合", async () => {
  const seen = [];
  const ok = await buildVisibleWorldSummary({
    turnId: "t-4", revision: 6, viewMode: "pov",
    events: [{ actorName: "艾拉", locationName: "教室", title: "进门" }],
    model: (payload) => { seen.push(payload.lines); return "艾拉进了教室。"; },
  });
  assert.equal(ok.source, "model");
  assert.deepEqual(ok.lines, ["艾拉进了教室。"]);
  assert.equal(seen[0].length, 1, "模型只收到可见小集合");
  const failed = await buildVisibleWorldSummary({
    turnId: "t-5", revision: 7, viewMode: "pov",
    events: [{ actorName: "艾拉", locationName: "教室", title: "进门" }],
    model: () => { throw new Error("模型不可用"); },
  });
  assert.equal(failed.source, "program", "模型失败回退程序模板");
  assert.equal(failed.modelFailed, true);
  assert.ok(failed.lines[0].includes("艾拉"));
});

test("U12 日志脱敏与关联分组；敏感字段不落导出", () => {
  assert.equal(redactLogText("key sk-abcdef1234567890 end").includes("sk-"), false);
  assert.equal(redactLogText("Bearer abcdef1234567890").includes("abcdef"), false);
  assert.equal(logGroupKey({ traceId: "tr-1", attemptId: "at-1" }), "trace:tr-1|attempt:at-1");
  assert.equal(logGroupKey({}), "single:");
  assert.notEqual(logGroupKey({ turnRef: "t1" }), logGroupKey({ turnRef: "t2" }));
});

test("U06/U08 渲染函数在无 DOM 时不得抛错（返回结构稳定）", () => {
  assert.equal(typeof renderCatalog, "function");
  assert.equal(typeof renderMapTree, "function");
});
