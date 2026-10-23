/** Map interaction ownership: cameras, navigation, gestures, resize and teardown. */
export function createMapController(math) {
 const cameras=new Map(),viewports=new Map(),cleanups=[];
 let disposed=false,stack=[];
 function listen(target,type,handler,options){
  target.addEventListener(type,handler,options);
  cleanups.push(()=>target.removeEventListener(type,handler,options));
 }
 function observe(viewport,onResize){
  if(typeof ResizeObserver!=="function")return;
  let timer=null,w=0,h=0;
  const observer=new ResizeObserver(entries=>{
   const rect=entries[0]?.contentRect;if(!rect||disposed)return;
   const nextW=Math.round(rect.width),nextH=Math.round(rect.height);
   if(nextW===w&&nextH===h)return;w=nextW;h=nextH;
   if(timer)clearTimeout(timer);
   timer=setTimeout(()=>{timer=null;if(!disposed)onResize();},120);
  });
  observer.observe(viewport);
  cleanups.push(()=>{observer.disconnect();if(timer)clearTimeout(timer);});
 }
 function mountViewport(ports){
  const {viewport,readCamera,commitCamera,areaDraw,areaDrawCellAt,renderAreaDraw,closeMapPanel}=ports;
  const {createPanGesture,createPinchTracker,zoomCameraAtPoint,panCameraBy}=math;
    const panGesture = createPanGesture();
    const pinch = createPinchTracker();
    const activePointers = new Map();
    const GESTURE_BLOCK_SELECTOR =
      "button, input, select, textarea, label, .aw-mappanel, .aw-maptools, .aw-scale, .aw-mapcrumb, .aw-maplegend, .aw-travel, .aw-zoom";
    listen(viewport, "pointerdown", (e) => {
      const camera = readCamera();
      if (!camera) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const interactive = Boolean(e.target?.closest?.(GESTURE_BLOCK_SELECTOR));
      /**
       * H15b：绘制模式**独占**网格点击——不启动平移，把这一下当成「选中/取消一个格」。
       * 工具栏 / 弹层等交互元素仍然照常可点（interactive 优先）。
       */
      if (areaDraw.active && !interactive) {
        const cell = areaDrawCellAt(e.clientX, e.clientY);
        if (cell) {
          const key = `${cell.x},${cell.y}`;
          if (areaDraw.cells.has(key)) areaDraw.cells.delete(key); else areaDraw.cells.add(key);
          renderAreaDraw();
        }
        return;
      }
      if (interactive) return;
      pinch.down(e.pointerId, e.clientX, e.clientY);
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activePointers.size >= 2) {
        panGesture.cancel(); // 进入双指：终止单指平移
        viewport.setPointerCapture?.(e.pointerId);
        return;
      }
      panGesture.down(e.clientX, e.clientY);
      viewport.setPointerCapture?.(e.pointerId);
    });
    listen(viewport, "pointermove", (e) => {
      const camera = readCamera();
      if (!camera) return;
      if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch.active) {
        const update = pinch.move(e.pointerId, e.clientX, e.clientY);
        if (update) {
          const rect = viewport.getBoundingClientRect();
          commitCamera(zoomCameraAtPoint(camera, update.x - rect.left, update.y - rect.top, viewport.clientWidth || 0, viewport.clientHeight || 0, update.factor));
        }
        return;
      }
      const step = panGesture.move(e.clientX, e.clientY);
      if (step?.panning) commitCamera(panCameraBy(camera, step.dx, step.dy));
    });
    const endMapPointer = (e, cancelled) => {
      if (activePointers.has(e.pointerId)) {
        activePointers.delete(e.pointerId);
        if (cancelled) pinch.cancel();
        else pinch.up(e.pointerId);
      }
      if (pinch.active) return;
      if (activePointers.size === 1) {
        // 双指回落到单指：以剩余指位重启平移基线
        const [only] = [...activePointers.values()];
        panGesture.cancel();
        panGesture.down(only.x, only.y);
        return;
      }
      if (cancelled) panGesture.cancel();
      else panGesture.up(); // suppress 标记保留给 click 消费（不在 pointerup 提前清除）
    };
    listen(viewport, "pointerup", (e) => endMapPointer(e, false));
    listen(viewport, "pointercancel", (e) => endMapPointer(e, true));
    // 光标缩放：光标下世界点不漂移（zoomCameraAtPoint）；ctrl+滚轮 = 触控板捏合细步
    listen(viewport, "wheel", (e) => {
      const camera = readCamera();
      if (!camera) return;
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const factor = e.ctrlKey
        ? Math.min(2, Math.max(0.5, Math.exp(-e.deltaY * 0.01)))
        : e.deltaY < 0 ? 1.2 : 1 / 1.2;
      commitCamera(zoomCameraAtPoint(camera, e.clientX - rect.left, e.clientY - rect.top, viewport.clientWidth || 0, viewport.clientHeight || 0, factor));
    }, { passive: false });
    // 0.9.47 mapview 同款交互：点地图空白处 / 按 ESC 关面板；面板内点击不冒泡
    listen(viewport, "click", () => {
      if (panGesture.consumeClick()) return; // pan 结束的合成 click 不当空白点击
      closeMapPanel();
    });

  cleanups.push(()=>{
   for(const id of activePointers.keys())try{viewport.releasePointerCapture?.(id);}catch{}
   activePointers.clear();panGesture.cancel();pinch.cancel();
  });
 }
 function dispose(){
  if(disposed)return;disposed=true;
  for(const cleanup of cleanups.splice(0).reverse())cleanup();
  cameras.clear();viewports.clear();stack=[];
 }
 return {cameras,viewports,observe,mountViewport,dispose,listen,
  get stack(){return stack;},set stack(value){stack=value;}};
}
export function markerPopupPosition(viewport,marker,width=280,height=240){
 let left=marker.right-viewport.left+10;
 if(left+width>viewport.width-10)left=marker.left-viewport.left-width-10;
 if(left<10)left=Math.max(10,(viewport.width-width)/2);
 let top=Math.min(Math.max(8,marker.top-viewport.top),Math.max(8,viewport.height-height-10));
 return {left:Math.round(left),top:Math.round(top)};
}

// ---------------------------------------------------------------------------
// U04 / U07：新工作台的地图控制器（场景渲染器 + 点击进入）
// ---------------------------------------------------------------------------

/**
 * 一个手势 owner：渲染器自己接管指针/滚轮，宿主不再另挂一份 wheel/pointer 监听。
 *
 * ports:
 *  - canvas: HTMLCanvasElement（必需）
 *  - createRenderer: createSpatialRenderer 或同签名工厂（必需，不导入 vendor，便于测试注入）
 *  - projectors: { unwrapViewResult, projectMapView }（必需；缺失只报 issue，绝不伪造几何）
 *  - model: createWorkbenchModel 实例（相机偏好 / selected / scope）
 *  - queryView(kind, query): 同 scope 并行取 map / scene / flows
 *  - onSelect(entity) / onIssue(issue) / onEnter(mapId) / onChoose(maps)
 *  - theme / scaleBarWidth
 *
 * 纪律：
 *  - 同 scope 并行取数后**先确认同一 revision 快照**再投影；过期 response 不 setScene。
 *  - 缺 scene 时显示 SQL 概览（overview 投影），不画虚构细场景。
 *  - 错误 scene 不清掉已经有效的旧图，只标状态。
 */
export function createWorkbenchMapController(ports = {}) {
  const { canvas, createRenderer, projectors, model, queryView, onSelect, onIssue, onEnter, onChoose,
    theme = {}, scaleBarWidth = 96, onViewport, getChildren = () => [] } = ports;
  let renderer = null;
  let scope = null;
  let mapId = null;
  let ticket = 0;
  let lastGood = null;
  let destroyed = false;
  let renderedKey = '', lastResult = null;
  const cleanups = [];

  function issue(code, message, details) {
    if (typeof onIssue !== "function") return;
    onIssue({ code, message, ...(details ?? {}) });
  }
  function ensureRenderer() {
    if (renderer || destroyed) return renderer;
    if (typeof createRenderer !== "function") { issue("SPATIAL_RENDERER_MISSING", "缺少 createSpatialRenderer"); return null; }
    try {
      renderer = createRenderer({
        canvas, theme, scaleBarWidth, ownsGestures: true,
        onSelect: (entity) => handleClick(entity, { children: getChildren(entity), settings: model?.settings }),
        onViewport,
        onIssue: (row) => issue(row?.code ?? "SPATIAL_RENDERER_ISSUE", row?.message ?? "", row),
      });
    } catch (error) {
      issue("SPATIAL_RENDERER_FAILED", String(error?.message ?? error));
      renderer = null;
    }
    return renderer;
  }
  function saveCamera() {
    if (!renderer || !model) return;
    const cam = renderer.state?.cam;
    if (cam && typeof cam === "object") model.setCamera(mapId, { s: cam.s, x: cam.x, y: cam.y,
      zoom: renderer.state.zoom, offset: { ...renderer.state.offset } });
  }
  function restoreCamera() {
    if (!renderer || !model) return;
    const saved = model.getCamera(mapId);
    if (saved) renderer.setCamera(saved);
  }
  /** 同 scope 并行取 map / scene / flows，确认快照后再投影。 */
  async function fetchSnapshot(nextScope, nextMapId) {
    if (typeof queryView !== "function") return null;
    // scope 显式映射到 ViewQuery 顶层字段（与 model.load 同一口径），不塞 scope 包。
    const identity = nextScope && typeof nextScope === "object" ? {
      branchId: String(nextScope.branchId ?? ""),
      ...(Number.isInteger(nextScope.revision) ? { revision: Number(nextScope.revision) } : {}),
      ...(nextScope.viewMode ? { viewMode: String(nextScope.viewMode) } : {}),
      ...(nextScope.povId ? { povId: String(nextScope.povId) } : {}),
    } : {};
    const [map, scene, flows] = await Promise.all([
      queryView("map", { mapId: nextMapId, ...identity }).catch(() => null),
      queryView("scene", { mapId: nextMapId, ...identity }).catch(() => null),
      queryView("flows", { mapId: nextMapId, ...identity }).catch(() => null),
    ]);
    const revisionOf = (view) => (view && typeof view === "object" ? view.revision ?? view?.metadata?.revision : null);
    const revisions = [revisionOf(map), revisionOf(scene), revisionOf(flows)].filter((value) => value != null);
    // 确认快照：三者必须属于同一 revision，否则这一批作废（不投影、不清旧图）
    if (revisions.length && new Set(revisions).size > 1) {
      issue("SPATIAL_SNAPSHOT_MISMATCH", "map/scene/flows 不属于同一修订，已跳过本次投影");
      return null;
    }
    return { map, scene, flows, revision: revisions[0] ?? null };
  }
  /**
   * U04 返工：优先消费 scene 视图（Q03 的 DTO 已按视角过滤 + 同 revision hydrate）。
   * 返回 { mode:'scene', scene } 或 { mode:'overview', projection }；
   * sceneStatus 为 missing/invalid（或 scene 视图缺席）才退回 SQL 概览投影。
   */
  function resolveScene(snapshot) {
    const items = Array.isArray(snapshot?.scene?.items) ? snapshot.scene.items : [];
    const entry = items.find((row) => row && typeof row === "object" && String(row.mapId ?? "") === String(mapId ?? ""));
    if (entry && entry.sceneStatus === "ready" && entry.scene && typeof entry.scene === "object") {
      return { mode: "scene", scene: entry.scene, issues: Array.isArray(entry.issues) ? entry.issues : [] };
    }
    if (entry && entry.sceneStatus === "invalid") {
      issue("SPATIAL_SCENE_INVALID", "已保存的场景不可用，退回 SQL 概览显示");
    } else if (entry && entry.sceneStatus === "missing") {
      issue("SPATIAL_SCENE_EMPTY", "这张地图还没有场景布局，按 SQL 概览显示");
    }
    return { mode: "overview", issues: [] };
  }
  function project(snapshot) {
    if (!projectors || typeof projectors.projectMapView !== "function") {
      issue("SPATIAL_PROJECTOR_MISSING", "缺少 projectMapView，不渲染任何几何");
      return null;
    }
    const wrap = typeof projectors.unwrapViewResult === "function"
      ? projectors.unwrapViewResult(snapshot.map, "direct") : { ok: true, view: snapshot.map };
    if (!wrap?.ok) { issue(wrap?.code ?? "VIEW_SHAPE_INVALID", wrap?.message ?? "地图视图形状不合法"); return null; }
    const projection = projectors.projectMapView({ view: wrap.view, mapId, scope });
    if (!projection?.ok) { issue(projection?.code ?? "PROJECT_FAILED", projection?.message ?? "投影失败"); return null; }
    return projection;
  }
  async function showMap(nextScope, nextMapId) {
    if (destroyed) return null;
    const key = JSON.stringify([nextScope, nextMapId]);
    if (nextScope?.snapshotKey && key === renderedKey) return lastResult;
    const sameScope = JSON.stringify(scope) === JSON.stringify(nextScope);
    if (sameScope && mapId !== nextMapId) saveCamera();
    if (!sameScope || mapId !== nextMapId) invalidate();
    const mine = ++ticket;
    scope = nextScope && typeof nextScope === "object" ? { ...nextScope } : null;
    mapId = nextMapId ?? null;
    if (model && typeof model.setMap === "function") model.setMap(mapId);
    if (!mapId) { renderer?.setScene?.(null); return null; }
    const snapshot = await fetchSnapshot(scope, mapId);
    if (destroyed || mine !== ticket) return null; // 过期 response
    if (!snapshot) return null;
    const target = ensureRenderer();
    if (!target) return null;
    // U04 返工：先看 scene 视图——ready 的已保存场景（floor/city）优先上屏。
    const resolved = resolveScene(snapshot);
    let sceneToDraw = null;
    if (resolved.mode === "scene") {
      sceneToDraw = resolved.scene;
    } else {
      const projection = project(snapshot);
      if (!projection) return null;
      if (projection.status === "empty") {
        // 概览也没有内容：如实空屏（不虚构细场景，也不清掉已有效的旧图）
        issue("SPATIAL_SCENE_EMPTY", "这张地图在 SQL 视图里没有可显示的内容");
        target.setScene?.(null); lastGood = null;
        return { status: "empty" };
      }
      sceneToDraw = projection.scene;
      if (Array.isArray(projection.issues)) for (const row of projection.issues) issue(row?.code ?? "SPATIAL_ISSUE", row?.message ?? "", row);
    }
    try {
      if (target.setScene?.(sceneToDraw) === false) throw new Error('场景校验失败');
    } catch (error) {
      // 坏 scene 不清掉已有效的旧图，只标状态
      issue("SPATIAL_SCENE_INVALID", String(error?.message ?? error));
      if (lastGood) target.setScene?.(lastGood);
      return { status: "invalid" };
    }
    lastGood = sceneToDraw;
    restoreCamera();
    if (Array.isArray(snapshot.flows?.items)) target.setOverlays?.(snapshot.flows.items);
    if (Array.isArray(resolved.issues)) for (const row of resolved.issues) issue(row?.code ?? "SPATIAL_ISSUE", row?.message ?? "", row);
    renderedKey = key;
    lastResult = { status: "ready", mode: resolved.mode, revision: snapshot.revision };
    return lastResult;
  }
  /**
   * U07：进入选中地点。
   * - singleClickEnter=false（默认）：只开详情，不进入。
   * - 唯一子地图 → 直接进；多个子地图 → 交 onChoose 选层，绝不自动挑第一个。
   */
  function enterSelectedLocation(selected, children = [], settings = {}) {
    if (!selected || String(selected.kind ?? "") !== "location") return { entered: false, reason: "not-location" };
    const maps = (Array.isArray(children) ? children : []).map((row) => String(row?.mapId ?? row?.id ?? "")).filter(Boolean);
    if (!maps.length) return { entered: false, reason: "no-child" };
    if (maps.length > 1) {
      if (typeof onChoose === "function") onChoose({ selected, maps });
      return { entered: false, reason: "multiple", maps };
    }
    if (settings.singleClickEnter !== true) return { entered: false, reason: "setting-off", maps };
    if (typeof onEnter === "function") onEnter(maps[0]);
    return { entered: true, mapId: maps[0] };
  }
  /** 单击处理：默认只选中；开启开关时地点才可能直接进入。双击 / Enter 走 force=true。 */
  function handleClick(entity, options = {}) {
    const type = String(entity?.type ?? '');
    const kind = type === 'person' ? 'character' : ['room', 'district', 'building'].includes(type) ? 'location' : type;
    const selected = entity ? { kind, id: String(entity.id ?? "") } : null;
    if (model && typeof model.select === "function") model.select(selected?.kind, selected?.id, entity);
    if (typeof onSelect === "function") onSelect(entity);
    if (options.force === true && selected?.kind === "location") {
      return enterSelectedLocation(selected, options.children ?? [], { ...(options.settings ?? {}), singleClickEnter: true });
    }
    if (options.settings?.singleClickEnter === true && selected?.kind === "location") {
      return enterSelectedLocation(selected, options.children ?? [], options.settings);
    }
    return { entered: false, reason: "detail" };
  }
  function focus(id) {
    if (!renderer || typeof renderer.focus !== "function") return false;
    return renderer.focus(String(id ?? ""));
  }
  function resize() { renderer?.resize?.(); }
  function invalidate() {
    ticket += 1; renderedKey = ''; lastResult = null; lastGood = null;
    scope = null; renderer?.setScene?.(null);
    model?.select?.(null, null);
  }
  function listen(type, handler) {
    canvas?.addEventListener?.(type, handler);
    cleanups.push(() => canvas?.removeEventListener?.(type, handler));
  }
  const enter = () => {
    const entity = renderer?.state?.selected;
    if (entity) handleClick(entity, { force: true, children: getChildren(entity), settings: model?.settings });
  };
  listen('dblclick', enter);
  listen('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); enter(); } });
  function destroy() {
    destroyed = true;
    ticket += 1;
    saveCamera();
    cleanups.splice(0).forEach(cleanup => cleanup());
    try { renderer?.destroy?.(); } catch { /* 销毁失败也要清干净引用 */ }
    renderer = null; lastGood = null; scope = null; mapId = null;
  }
  return { showMap, handleClick, enterSelectedLocation, focus, resize, destroy, invalidate,
    zoomBy: factor => renderer?.zoomBy?.(factor), fit: () => renderer?.fit?.(),
    get renderer() { return renderer; }, get mapId() { return mapId; } };
}

/** 拖拽超过 4 CSS px 视为平移，不触发点击；双指松手不误开详情。 */
export const WORKBENCH_DRAG_THRESHOLD_PX = 4;
export function isDragMovement(dx, dy, threshold = WORKBENCH_DRAG_THRESHOLD_PX) {
  return Math.hypot(Number(dx) || 0, Number(dy) || 0) > threshold;
}
