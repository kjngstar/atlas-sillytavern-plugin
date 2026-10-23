/**
 * U09：底部世界时间线（本轮可见事件 / 到达 / 经过 / 风声）。
 *
 * 纪律：
 * - 不从技术日志造剧情：只渲染查询返回的条目，不补写「好像发生了什么」。
 * - blocked（条件等待）的计划标「等待条件」，绝不标成已发生。
 * - 秘密条目只在 author 视角出现；等 UI 不推进世界时间。
 */
function labelOf(entry) {
  return String(entry?.title ?? entry?.summary ?? entry?.name ?? "未命名事件");
}
function occurredOf(entry) {
  if (entry?.status === "blocked" || entry?.blocked === true) return false;
  if (typeof entry?.occurredAtS === "number") return true;
  return entry?.occurred === true || entry?.status === "occurred";
}

export function renderTurnTimeline(container, options = {}) {
  const doc = container.ownerDocument;
  const { events = [], arrivals = [], passages = [], fronts = [], tasks = [], viewMode = "pov",
    onSelect, onLocate, showRelations = false, onToggleRelations } = options;
  const author = viewMode === "author";
  container.replaceChildren();

  const head = doc.createElement("div");
  head.className = "awb-timeline-head";
  const title = doc.createElement("span");
  title.className = "awb-timeline-title";
  title.textContent = "本轮动向";
  head.append(title);
  if (typeof onToggleRelations === "function") {
    const toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.className = "awb-tool";
    toggle.textContent = showRelations ? "隐藏关系线" : "显示关系线";
    toggle.setAttribute("aria-pressed", String(showRelations));
    toggle.addEventListener("click", () => onToggleRelations(!showRelations));
    head.append(toggle);
  }
  container.append(head);

  const groups = [
    ["事件", events], ["到达", arrivals], ["经过", passages], ["风声", fronts], ["任务", tasks],
  ];
  let total = 0;
  const list = doc.createElement("ul");
  list.className = "awb-timeline-list";
  for (const [groupName, rows] of groups) {
    if (!Array.isArray(rows)) continue;
    for (const entry of rows) {
      if (!entry || typeof entry !== "object") continue;
      if (!author && (entry.hidden === true || entry.secret === true)) continue; // 秘密只 author
      total += 1;
      const li = doc.createElement("li");
      li.className = "awb-timeline-item";
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "awb-timeline-entry";
      const kind = doc.createElement("span");
      kind.className = "awb-timeline-kind";
      kind.textContent = groupName;
      const text = doc.createElement("span");
      const occurred = occurredOf(entry);
      text.textContent = occurred ? labelOf(entry) : `${labelOf(entry)}（等待条件）`;
      if (!occurred) button.classList.add("is-pending");
      button.append(kind, text);
      if (author && entry.hidden === true) {
        const badge = doc.createElement("span");
        badge.className = "awb-badge";
        badge.textContent = "后台";
        button.append(badge);
      }
      const id = String(entry.id ?? entry.entityId ?? "");
      if (id) {
        button.addEventListener("click", () => {
          // 跨地图事件：先切图再定位/详情（顺序由调用方保证，这里只把地图信息带上）。
          const payload = { id, entry, mapId: entry.mapId ?? null, kind: entry.entityKind ?? groupName };
          if (typeof onLocate === "function") onLocate(payload);
          if (typeof onSelect === "function") onSelect(payload);
        });
      }
      li.append(button);
      list.append(li);
    }
  }
  if (!total) {
    const empty = doc.createElement("p");
    empty.className = "awb-empty";
    empty.textContent = "本轮没有可见动向。";
    container.append(empty);
    return { destroy() { container.replaceChildren(); } };
  }
  container.append(list);
  return { destroy() { container.replaceChildren(); } };
}
