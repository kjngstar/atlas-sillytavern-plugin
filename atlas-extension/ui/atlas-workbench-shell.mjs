/**
 * U02：新工作台外壳（mountWorkbench）。
 *
 * 区域定义按包内 docs/05 第 1 节：左导航 / 左地图树 / 中央地图 / 右详情 / 下方事件带 / 左下读者侧栏。
 *
 * 纪律：
 * - root 上只挂一个工作台：重复 mount 先销毁旧的（含事件、RAF、渲染器）。
 * - 组件只持 UI 状态；世界数据一律经 ports.queryView（Q 系列只读口）。
 * - 资料名全部走 textContent，含 HTML 也不会被执行。
 * - 不为工作台再建第二份导航清单：页面来自 ATLAS_UI_PAGES（U14 单一权威）。
 */
import { createWorkbenchModel } from "./atlas-workbench-model.mjs";
import { renderMapTree } from "./atlas-map-tree.mjs";
import { renderEntityPanel } from "./atlas-entity-panel.mjs";
import { createCatalogController, renderCatalog } from "./atlas-catalog-panel.mjs";
import { renderTurnTimeline } from "./atlas-world-timeline.mjs";
import { renderWorldSummary } from "./atlas-world-summary.mjs";
import { renderUnifiedLogTimeline } from "./atlas-unified-log-panel.mjs";
import { createStarmapShell, atlasWorkbenchTree } from "./atlas-starmap-shell.mjs";

/** root → 实例：同一宿主不允许出现两个工作台（也就不会出现两个地图实例）。 */
const MOUNTED = new WeakMap();

function node(doc, tag, cls, text) {
  const result = doc.createElement(tag);
  if (cls) result.className = cls;
  if (text != null) result.textContent = String(text);
  return result;
}

export function mountWorkbench(host = {}, ports = {}) {
  const root = host.root;
  const doc = root?.ownerDocument ?? globalThis.document;
  if (!root) throw new Error("WORKBENCH_ROOT_REQUIRED");
  const previous = MOUNTED.get(root);
  if (previous) previous.destroy(); // 重复 mount：先销毁

  const model = host.model ?? createWorkbenchModel({
    queryView: ports.queryView, settings: ports.settings ?? {},
    emitDiagnostic: ports.emitDiagnostic, onScopeInvalidated: ports.onScopeInvalidated,
  });
  const shell = typeof host.createShell === "function"
    ? host.createShell(host)
    : createStarmapShell(host);
  const cleanups = [];

  // --- 左地图树（U05）：挂在层级图层面板里，与 shell 自有的层级列表不重复造树 ---
  const treeSlot = node(doc, "div", "awb-slot awb-slot--tree");
  treeSlot.setAttribute("aria-label", "地图层级");
  shell.layerSlot?.append(treeSlot);
  let treeView = null;
  function paintTree(tree, activeMapId) {
    treeView?.destroy?.();
    treeView = renderMapTree(treeSlot, {
      tree: tree ?? { nodes: [], childMapsByLocation: {}, issues: [] },
      activeMapId,
      onSelect: (row) => { model.setMap(row.mapId); host.onNavigate?.(row); },
      onEnter: (row) => { model.setMap(row.mapId); host.onNavigate?.(row); },
      onIssue: (issue) => ports.emitDiagnostic?.({ code: issue?.code ?? "MAP_TREE_ISSUE", message: issue?.message ?? "" }),
    });
  }
  cleanups.push(() => { treeView?.destroy?.(); treeSlot.remove(); });

  // --- 右详情（U06） ---
  const detailSlot = node(doc, "div", "awb-slot awb-slot--detail");
  shell.inspectorBody?.append(detailSlot);
  function paintEntity(entity) {
    renderEntityPanel(detailSlot, entity, {
      viewMode: model.scope?.viewMode ?? "pov",
      onSelect: (payload) => host.onSelectEntity?.(payload),
      onLocate: (payload) => host.onLocate?.(payload),
      onEnter: (payload) => host.onEnterLocation?.(payload),
    });
  }
  paintEntity(null);
  cleanups.push(() => detailSlot.remove());

  // --- 目录与搜索（U08） ---
  const catalogSlot = node(doc, "div", "awb-slot awb-slot--catalog");
  catalogSlot.hidden = true;
  (host.sideFoot ?? host.side)?.append(catalogSlot);
  // 每种目录各自维护游标：人物 / 物品 / 事件互不串页
  const catalogs = new Map();
  function catalogFor(kind) {
    if (!catalogs.has(kind)) catalogs.set(kind, createCatalogController({ model, kind }));
    return catalogs.get(kind);
  }
  function paintCatalogInto(container, kind, rows, hasMore, cursor) {
    const controller = catalogFor(kind);
    renderCatalog(container, {
      rows, kind, hasMore, nextCursor: cursor,
      onSelect: (payload) => host.onSelectEntity?.(payload),
      onMore: (next) => { void controller.loadPage(next).then((out) => out && paintCatalogInto(container, kind, out.rows, out.hasMore, out.nextCursor)); },
    });
  }
  function paintCatalog(rows, hasMore, cursor) { paintCatalogInto(catalogSlot, "location", rows, hasMore, cursor); }
  cleanups.push(() => { for (const controller of catalogs.values()) controller.destroy(); catalogs.clear(); catalogSlot.remove(); });

  // --- 底部世界时间线（U09） ---
  const timelineSlot = node(doc, "div", "awb-slot awb-slot--timeline");
  (host.sideChanges?.parentElement ?? host.moves?.parentElement ?? root)?.append(timelineSlot);
  let timelineView = null;
  function paintTimeline(payload) {
    timelineView?.destroy?.();
    timelineView = renderTurnTimeline(timelineSlot, {
      ...(payload ?? {}),
      viewMode: model.scope?.viewMode ?? "pov",
      onSelect: (entry) => host.onSelectEntity?.(entry),
      onLocate: (entry) => host.onLocate?.(entry),
      onToggleRelations: (next) => { model.setSetting("showRelations", next); host.onToggleRelations?.(next); paintTimeline({ ...(payload ?? {}), showRelations: next }); },
    });
  }
  cleanups.push(() => { timelineView?.destroy?.(); timelineSlot.remove(); });

  // --- 左下读者侧栏（U11） ---
  const summarySlot = node(doc, "div", "awb-slot awb-slot--summary");
  shell.layerSlot?.append(summarySlot);
  function paintSummary(summary) {
    renderWorldSummary(summarySlot, { summary, scope: { turnId: host.turnId?.() ?? null, revision: model.scope?.revision ?? null },
      onSelect: (payload) => host.onSelectEntity?.(payload) });
  }
  paintSummary(null);
  cleanups.push(() => summarySlot.remove());

  // --- 统一日志（U12） ---
  const logSlot = node(doc, "div", "awb-slot awb-slot--log");
  logSlot.hidden = true;
  (host.sideFoot ?? host.side)?.append(logSlot);
  function paintLog(entries, options = {}) {
    renderUnifiedLogTimeline(logSlot, {
      entries, hasMore: Boolean(options.hasMore),
      onMore: () => host.onMoreLog?.(),
      exportPage: typeof host.onExportLog === "function" ? () => host.onExportLog() : null,
    });
  }
  cleanups.push(() => logSlot.remove());

  cleanups.push(model.subscribe(({ reason }) => {
    if (reason.startsWith('stale:')) {
      paintEntity(null); paintSummary(null); paintTimeline(null);
      treeView?.destroy?.(); treeView = null; treeSlot.replaceChildren();
      catalogSlot.replaceChildren(); logSlot.replaceChildren();
    } else if (reason === 'map') paintEntity(null);
  }));

  function setPageVisible(page) {
    model.setPage(page);
    catalogSlot.hidden = page !== "characters" && page !== "items" && page !== "events";
    logSlot.hidden = page !== "logs";
  }

  const api = {
    model, shell, panels: { treeSlot, detailSlot, catalogSlot, timelineSlot, summarySlot, logSlot },
    /** U14/U15：把目录页渲染到宿主中央区（人物 / 物品 / 事件各一份游标）。 */
    async renderCatalogPage(container, kind) {
      const controller = catalogFor(kind);
      const out = await controller.loadPage(null);
      paintCatalogInto(container, kind, out?.rows ?? [], Boolean(out?.hasMore), out?.nextCursor ?? null);
      return out;
    },
    tree: atlasWorkbenchTree,
    sync(d, s, snapshot) {
      shell.sync(d, s, snapshot);
      /**
       * U01/U15 返工：宿主身份显式接入新 model——切聊天 / 分支 / 视角 / 修订
       * 都会换 scope key → 旧 ticket 全部作废，跨聊天回包不落地。
       *
       * 口径来源必须是**单一权威值**：宿主把当前 `sqlViewMode` 一并放进 snapshot
       * （index.js 侧 `{...sqlSnapshotScope(d), viewMode: sqlViewMode}`）。
       * 之前这里从 `d.sqlViewMode`（/state 的 DTO 字段，未声明时为 null）反推成 pov，
       * 于是工作台查询被压到主角所知口径：没登记主角知识的世界里目录页恒为空，
       * 同一份库用作者口径却查得到人物（验收报告 P1/U08 的另一半根因）。
       * 未声明时不写 viewMode——让引擎走自己的默认（author）。
       */
      const declared = snapshot?.viewMode ?? d?.sqlViewMode;
      model.setScope({
        chatId: String(s?.chatId ?? d?.chatId ?? ""),
        branchId: String(d?.branchId ?? s?.binding?.branchId ?? "main"),
        revision: Number.isInteger(d?.revision) ? Number(d.revision) : null,
        viewMode: declared === "author" || declared === "pov" ? declared : "",
        povId: null,
        snapshotKey: snapshot?.key ?? '',
      });
    },
    updateMap(next) {
      // U05 返工：spatialTree（vendor buildMapTree 的节点结构）才进新地图树；
      // 旧数组树只留给旧 shell 的面包屑 / 层梯，绝不把行数组错喂 renderMapTree 的 tree.nodes。
      // 权威标志一并传给旧 shell：它据此**不再绘制**旧树列表，两层都只留一份树。
      const spatialTree = next?.spatialTree;
      const authoritative = Boolean(spatialTree && Array.isArray(spatialTree.nodes));
      root.classList.toggle("awb-tree-authoritative", authoritative);
      shell.updateMap(authoritative ? { ...next, treeAuthoritative: true } : next);
      if (authoritative) {
        paintTree(spatialTree, next?.activeMapId ?? null);
      } else {
        if (treeView) { treeView.destroy?.(); treeView = null; }
        treeSlot.replaceChildren();
      }
    },
    dockDetail(panel) { shell.dockDetail(panel); },
    get layerSlot() { return shell.layerSlot; },
    get inspectorBody() { return shell.inspectorBody; },
    openInspector() { shell.openInspector(); },
    closeInspector() { shell.closeInspector(); },
    showEntity(entity) { paintEntity(entity); },
    showCatalog(rows, hasMore, cursor) { setPageVisible("characters"); paintCatalog(rows, hasMore, cursor); },
    searchCatalog(q) { return catalogFor("location").search(q).then((out) => { if (out) paintCatalog(out.rows, out.hasMore, out.nextCursor); return out; }); },
    showTimeline(payload) { paintTimeline(payload); },
    showSummary(summary) { paintSummary(summary); },
    showLog(entries, options) { setPageVisible("logs"); paintLog(entries, options); },
    setPageVisible,
    destroy() {
      MOUNTED.delete(root);
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
      model.dispose?.();
      shell.destroy?.();
    },
  };
  MOUNTED.set(root, api);
  return api;
}
