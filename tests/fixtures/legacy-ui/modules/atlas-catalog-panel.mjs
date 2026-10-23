/**
 * U08：目录页（人物 / 物品 / 地点 / 事件 / 风声）与紧凑搜索。
 *
 * 纪律：
 * - 分页游标来自 Q04 响应；q 变了旧 cursor 立刻作废（新查询开新 ticket）。
 * - 紧凑搜索最多 20 条，完整目录靠分页，不被「当前地图可见上限」截断。
 * - 点击结果：确保可见 → 切地图 → 定位 / 详情（切换由调用方 onPick 执行，本文件不算坐标）。
 */
export const SEARCH_LIMIT = 20;
const KIND_LABEL = {
  location: "地点", character: "人物", item: "物品", event: "事件", rumor: "风声",
};

export function catalogKindLabel(kind) { return KIND_LABEL[String(kind ?? "")] ?? "条目"; }

export function renderCatalog(container, options = {}) {
  const doc = container.ownerDocument;
  const { rows = [], kind = "", hasMore = false, nextCursor = null, onSelect, onMore, emptyText = "没有可显示的条目。" } = options;
  container.replaceChildren();
  if (!Array.isArray(rows) || !rows.length) {
    const empty = doc.createElement("p");
    empty.className = "awb-empty";
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }
  const list = doc.createElement("ul");
  list.className = "awb-catalog-list";
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = String(row.id ?? row.entityId ?? "");
    const li = doc.createElement("li");
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "awb-catalog-entry";
    button.dataset.entityId = id;
    const name = doc.createElement("strong");
    name.textContent = String(row.name ?? row.title ?? "未命名");
    button.append(name);
    const meta = doc.createElement("span");
    meta.className = "awb-catalog-meta";
    meta.textContent = [catalogKindLabel(row.entityKind ?? kind), row.locationName ? String(row.locationName) : null,
      row.mapId ? `地图 ${String(row.mapId)}` : null].filter(Boolean).join(" · ");
    button.append(meta);
    if (row.summary) {
      const summary = doc.createElement("span");
      summary.className = "awb-catalog-summary";
      summary.textContent = String(row.summary);
      button.append(summary);
    }
    if (id && typeof onSelect === "function") {
      button.addEventListener("click", () => onSelect({ kind: String(row.entityKind ?? kind), id, row }));
    }
    li.append(button);
    list.append(li);
  }
  container.append(list);
  // POV 不返回总数：只说「还有更多」，不说「共 N 条」。
  if (hasMore && typeof onMore === "function") {
    const more = doc.createElement("button");
    more.type = "button";
    more.className = "awb-tool";
    more.textContent = "加载更多";
    more.addEventListener("click", () => onMore(nextCursor));
    container.append(more);
  }
}

/**
 * 目录控制器：一次只跑一个查询，q 变化时旧请求与旧 cursor 一起作废。
 * ports: { model, kind, pageSize }
 */
export function createCatalogController(ports = {}) {
  const { model, kind = "location", pageSize = 50 } = ports;
  let lastQuery = "";
  let currentCursor = null;
  let rows = [];
  let destroyed = false;
  let debounceTimer = null;
  /** 搜索代次：新一代搜索开始时，上一代的结果直接作废（resolve null，不让它悬着）。 */
  let generation = 0;
  let pending = null;
  /** model.load 返回 { issued, result }：issued 落后于 model.ticket 即已被更新的 scope / 查询取代。 */
  function stale(outcome) {
    if (destroyed || !outcome || typeof outcome !== "object") return true;
    return outcome.issued !== model?.ticket;
  }
  async function run(query, options = {}) {
    if (!model || typeof model.load !== "function") return null;
    // U08 返工：目录的「实体种类」走 entityKind（ViewQuery 契约字段）；
    // kind 是视图类型，只能是 catalog，两者不得混用。
    const outcome = await model.load("catalog", { entityKind: kind, limit: pageSize, ...query }, {});
    if (stale(outcome)) return null;
    const payload = outcome.result ?? {};
    const next = Array.isArray(payload.items) ? payload.items : [];
    rows = options.append ? rows.concat(next) : next;
    currentCursor = payload.nextCursor ?? null;
    return { rows: rows.slice(), hasMore: Boolean(currentCursor), nextCursor: currentCursor };
  }
  return {
    get rows() { return rows.slice(); },
    get cursor() { return currentCursor; },
    get query() { return lastQuery; },
    async loadPage(cursor = null) {
      return run({ ...(lastQuery ? { q: lastQuery } : {}), ...(cursor ? { cursor } : {}) }, { append: Boolean(cursor) });
    },
    /** 紧凑搜索：debounce + ticket，q 变取消旧 cursor。空输入立即清空。 */
    search(q, waitMs = 180) {
      lastQuery = String(q ?? "").trim();
      if (debounceTimer) clearTimeout(debounceTimer);
      generation += 1;
      const mine = generation;
      rows = []; // 空输入立即清空；q 变了旧 cursor 一起作废
      currentCursor = null;
      return new Promise((resolve) => {
        // 上一代搜索当场作废：不是让它永远悬着，而是明确 resolve(null)。
        if (pending) { const stale = pending; pending = null; stale.resolve(null); }
        pending = { resolve, mine };
        debounceTimer = setTimeout(async () => {
          debounceTimer = null;
          const current = pending;
          pending = null;
          if (destroyed || !current || current.mine !== mine) return resolve(null);
          current.resolve(await run({ ...(lastQuery ? { q: lastQuery } : {}), limit: SEARCH_LIMIT }));
        }, Math.max(0, waitMs));
      });
    },
    destroy() { destroyed = true; if (debounceTimer) clearTimeout(debounceTimer); debounceTimer = null; rows = []; },
  };
}
