/**
 * U05：地图层级树（地区 → 城 → 建筑 → 楼层 → 房间）。
 *
 * 用 vendor 的 buildMapTree 产出结构；本文件只负责渲染与交互，不自己推断层级。
 * 全部文本走 textContent，实体名里的 HTML 不会被当成标签执行。
 */
const MAX_DEPTH = 9;

export function mapsForLocation(tree, locationId) {
  const id = locationId == null ? "" : String(locationId);
  const rows = tree?.childMapsByLocation?.[id];
  return Array.isArray(rows) ? rows.filter((value) => typeof value === "string" && value) : [];
}

/** 节点的祖先链（含自己）：面包屑与「返回父图」都用它，避免 UI 自己另算一份父关系。 */
export function mapPath(tree, mapId) {
  const byId = new Map((tree?.nodes ?? []).map((node) => [String(node.mapId), node]));
  const out = [];
  const seen = new Set();
  let cursor = mapId == null ? "" : String(mapId);
  while (cursor && byId.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    out.unshift(cursor);
    cursor = byId.get(cursor)?.parentMapId ?? "";
  }
  return out;
}

export function parentMapOf(tree, mapId) {
  const path = mapPath(tree, mapId);
  return path.length > 1 ? path[path.length - 2] : null;
}

function rowFor(node, depth) {
  return {
    mapId: String(node.mapId),
    name: String(node.name ?? node.mapId),
    kind: String(node.kind ?? "map"),
    depth,
    containerLocationId: node.containerLocationId ?? null,
    parentMapId: node.parentMapId ?? null,
  };
}

/**
 * 渲染层级树。返回 { refresh(next), destroy() }。
 * 选项：{ tree, activeMapId, pathIds, onSelect(row), onEnter(row), onIssue(issue) }
 */
export function renderMapTree(container, options = {}) {
  const { onSelect, onEnter, onIssue } = options;
  let tree = options.tree ?? { nodes: [], childMapsByLocation: {}, issues: [] };
  let activeMapId = options.activeMapId ?? null;
  let expanded = new Set(mapPath(tree, activeMapId));
  let destroyed = false;

  if (Array.isArray(tree?.issues)) {
    for (const issue of tree.issues) {
      if (issue && typeof onIssue === "function") onIssue(issue);
    }
  }

  function node(tag, cls, text) {
    const result = container.ownerDocument.createElement(tag);
    if (cls) result.className = cls;
    if (text != null) result.textContent = String(text);
    return result;
  }
  function childrenOf(mapId) {
    return (tree?.nodes ?? []).filter((node) => {
      const parent = node.parentMapId ?? null;
      return mapId == null ? !parent : String(parent) === String(mapId);
    });
  }
  function paint() {
    if (destroyed) return;
    container.replaceChildren();
    const roots = childrenOf(null);
    if (!roots.length) {
      container.append(node("p", "awb-empty", "当前世界还没有可进入的地图。"));
      return;
    }
    const walk = (nodes, depth, parentEl) => {
      if (depth > MAX_DEPTH) return; // 层级过深只截断，不循环
      for (const raw of nodes) {
        const row = rowFor(raw, depth);
        const entry = node("div", "awb-tree-row");
        entry.dataset.mapId = row.mapId;
        entry.style.setProperty("--awb-depth", String(depth));
        entry.classList.toggle("is-active", row.mapId === String(activeMapId ?? ""));
        const label = node("button", "awb-tree-label", row.name);
        label.type = "button";
        label.setAttribute("aria-label", `查看地图 ${row.name}`);
        label.addEventListener("click", () => { activeMapId = row.mapId; onSelect?.(row); paint(); });
        entry.append(label);
        const kids = childrenOf(row.mapId);
        if (kids.length) {
          const toggle = node("button", "awb-tree-toggle", expanded.has(row.mapId) ? "−" : "+");
          toggle.type = "button";
          toggle.setAttribute("aria-expanded", String(expanded.has(row.mapId)));
          toggle.setAttribute("aria-label", `展开或折叠 ${row.name}`);
          toggle.addEventListener("click", () => {
            if (expanded.has(row.mapId)) expanded.delete(row.mapId); else expanded.add(row.mapId);
            paint();
          });
          entry.append(toggle);
        }
        const holder = node("span", "awb-tree-meta", `L${depth}`);
        if (row.containerLocationId) holder.textContent += " · 地点内";
        entry.append(holder);
        parentEl.append(entry);
        if (kids.length && expanded.has(row.mapId)) walk(kids, depth + 1, parentEl);
      }
    };
    walk(roots, 0, container);
    const active = activeMapId ? (tree.nodes ?? []).find((n) => String(n.mapId) === String(activeMapId)) : null;
    if (active) {
      const enter = node("button", "awb-tree-enter", "进入这张地图");
      enter.type = "button";
      enter.addEventListener("click", () => onEnter?.(rowFor(active, 0)));
      container.append(enter);
    }
  }
  paint();
  return {
    refresh(next = {}) {
      if (next.tree) tree = next.tree;
      if ("activeMapId" in next) {
        activeMapId = next.activeMapId ?? null;
        for (const id of mapPath(tree, activeMapId)) expanded.add(id);
      }
      paint();
    },
    destroy() { destroyed = true; container.replaceChildren(); },
  };
}
