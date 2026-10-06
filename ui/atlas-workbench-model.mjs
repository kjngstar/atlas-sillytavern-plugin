/**
 * U01：工作台唯一 UI 状态。
 *
 * 纪律：
 * - 数据只从 Q 系列只读口来（ports.queryView），本文件不认识任何 demo-data / 示例世界。
 * - 不持有世界时钟，也不推进它：切页、选中、切图都不产生时间。
 * - 异步回包必须带 ticket 才能落地：scope 变了或翻页了，旧回包一律丢弃（防跨聊天/跨分支写入）。
 */
const EMPTY_VIEWS = Object.freeze({
  map: null, scene: null, flows: null, tasks: null, catalog: null, changes: null, diagnostics: null, entity: null,
});
/** 默认界面偏好：与世界数据分开保存，永远不被世界查询覆盖。 */
const DEFAULT_SETTINGS = Object.freeze({
  singleClickEnter: false,
  showRelations: false,
  showRoutes: true,
  showRumorLayer: true,
  compactSearch: true,
});
/** 紧凑搜索一页最多 20 项（§5），完整分页走 catalog。 */
export const SEARCH_RESULT_LIMIT = 20;

export function workbenchScopeKey(scope) {
  if (!scope || typeof scope !== "object") return "";
  const key = [scope.chatId ?? '', scope.branchId ?? '', scope.revision ?? '', scope.viewMode ?? '', scope.povId ?? ''].join('|');
  return scope.snapshotKey ? `${key}|${scope.snapshotKey}` : key;
}

/** 相机偏好 key 必须包含 chat/branch/map/viewMode：绝不能拿全局 currentScene 跨聊复用。 */
export function workbenchCameraKey(scope, mapId) {
  if (!scope || typeof scope !== "object") return "";
  return [scope.chatId ?? "", scope.branchId ?? "", scope.viewMode ?? "", scope.povId ?? "", mapId ?? ""].join("|");
}

export function createWorkbenchModel(ports = {}) {
  const { queryView, settings, emitDiagnostic, onScopeInvalidated } = ports;
  let scope = null;
  let scopeKey = "";
  let ticket = 0;
  let page = "map";
  let mapId = null;
  let selected = null;
  const views = { ...EMPTY_VIEWS };
  const cameraByMap = new Map();
  const prefs = { ...DEFAULT_SETTINGS, ...(settings && typeof settings === "object" ? settings : {}) };
  const listeners = new Set();

  function emit(code, details) {
    if (typeof emitDiagnostic === "function") {
      try { emitDiagnostic({ code, scope: scopeKey, ...(details ?? {}) }); } catch { /* 诊断失败不影响 UI */ }
    }
  }
  function notify(reason) {
    for (const listener of [...listeners]) {
      try { listener({ reason, state: snapshot() }); } catch { /* 单个监听失败不影响其他 */ }
    }
  }
  function snapshot() {
    return {
      scope, scopeKey, page, mapId, selected,
      views: { ...views },
      settings: { ...prefs },
      cameraKeys: [...cameraByMap.keys()],
    };
  }
  /** 每次 scope 变化 / 翻页都开新 ticket：旧异步回包就此作废。 */
  function nextTicket() {
    ticket += 1;
    return ticket;
  }
  function stale(reason) {
    for (const key of Object.keys(EMPTY_VIEWS)) views[key] = null;
    selected = null;
    emit("WORKBENCH_VIEW_CLEARED", { reason });
    notify("stale:" + reason);
  }
  function setScope(next) {
    const key = workbenchScopeKey(next);
    if (key === scopeKey) return { changed: false, ticket };
    const had = scope != null;
    scope = next && typeof next === "object" ? { ...next } : null;
    scopeKey = key;
    const nextTicketValue = nextTicket();
    if (had) stale("scope");
    if (had && typeof onScopeInvalidated === "function") {
      try { onScopeInvalidated({ reason: "scope", scope }); } catch { /* 宿主回调失败不影响状态 */ }
    }
    notify("scope");
    return { changed: true, ticket: nextTicketValue };
  }
  /** 空数据 / 旧修订：清空视图与选中，不保留上一聊天残留。 */
  function markEmpty(reason = "empty") { stale(reason); }
  function setPage(next) {
    if (next === page) return page;
    page = next;
    notify("page"); // 切页只换视图，绝不动世界时钟
    return page;
  }
  function setMap(next) {
    if (next === mapId) return mapId;
    mapId = next ?? null;
    selected = null; // 切图清旧 selected（§2）
    views.entity = null;
    notify("map");
    return mapId;
  }
  function select(kind, id, entity = null) {
    selected = id ? { kind: String(kind ?? ""), id: String(id) } : null;
    if (selected && entity) views.entity = entity;
    else if (selected) views.entity = null; // 详情走异步，不沿用上一个实体
    notify("select");
    return selected;
  }
  function setView(kind, payload, issuedTicket) {
    if (issuedTicket != null && issuedTicket !== ticket) return false; // 过期回包
    views[kind] = payload ?? null;
    notify("view:" + kind);
    return true;
  }
  function getView(kind) { return views[kind] ?? null; }
  /**
   * 唯一的查询出口。所有分页/翻页都带 ticket，q 变了旧 cursor 当场作废。
   * scope 显式映射到 ViewQuery 顶层字段（branchId / revision / viewMode / povId），
   * 不塞 scope 包、不依赖实现隐式猜测——这是 U 返工的验收点之一。
   * 返回 null 表示该查询已被更新的 scope/page 取代（调用方不要落地结果）。
   */
  async function load(kind, query = {}, options = {}) {
    if (typeof queryView !== "function") return null;
    // 新查询一律开新 ticket：旧查询的回包就此作废（q 变了取消旧 cursor）。
    const issued = options.keepTicket === true ? ticket : nextTicket();
    let result;
    try {
      result = await queryView(kind, {
        ...query,
        ...(scope ? {
          branchId: String(scope.branchId ?? ""),
          ...(Number.isInteger(scope.revision) ? { revision: Number(scope.revision) } : {}),
          ...(scope.viewMode ? { viewMode: String(scope.viewMode) } : {}),
          ...(scope.povId ? { povId: String(scope.povId) } : {}),
        } : {}),
      });
    } catch (error) {
      emit("WORKBENCH_QUERY_FAILED", { kind, errorCode: String(error?.code ?? error?.message ?? "UNKNOWN").slice(0, 80) });
      notify("query-failed:" + kind);
      return null;
    }
    return { issued, result };
  }
  function setCamera(map, camera) {
    const key = workbenchCameraKey(scope, map ?? mapId);
    if (!key) return false;
    if (camera == null) cameraByMap.delete(key);
    else cameraByMap.set(key, { ...camera });
    return true;
  }
  function getCamera(map) {
    const key = workbenchCameraKey(scope, map ?? mapId);
    return key ? cameraByMap.get(key) ?? null : null;
  }
  function clearCameras() { cameraByMap.clear(); }
  function setSetting(key, value) {
    if (!(key in prefs)) return false;
    prefs[key] = !!value;
    notify("settings:" + key);
    return true;
  }
  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  /** 组件销毁：清监听、清相机（相机是 UI 偏好，随实例一起走）。 */
  function dispose() {
    listeners.clear();
    cameraByMap.clear();
    for (const key of Object.keys(EMPTY_VIEWS)) views[key] = null;
    scope = null; scopeKey = ""; mapId = null; selected = null;
  }
  return {
    get scope() { return scope; },
    get scopeKey() { return scopeKey; },
    /** 当前 ticket：异步回包用它判定是否已被更新的 scope / 查询取代。 */
    get ticket() { return ticket; },
    get page() { return page; },
    get mapId() { return mapId; },
    get selected() { return selected; },
    get settings() { return { ...prefs }; },
    views, snapshot, subscribe, dispose,
    setScope, setPage, setMap, select, markEmpty,
    setView, getView, load, nextTicket,
    setCamera, getCamera, clearCameras, setSetting,
  };
}
