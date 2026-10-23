/**
 * U11：左下读者侧栏（这一轮 1–3 条世界动向）。
 *
 * 纪律：
 * - 绑定当前 turnId / revision / 视角：stale 或无新数据一律显示等待，不沿用上一聊天的摘要。
 * - 不把技术计数（行数 / MIGRATED / WORLD_TURN success）当世界动向。
 */
export function renderWorldSummary(container, options = {}) {
  const doc = container.ownerDocument;
  const { summary = null, scope = null, onSelect } = options;
  container.replaceChildren();
  const head = doc.createElement("div");
  head.className = "awb-summary-head";
  const title = doc.createElement("span");
  title.className = "awb-summary-title";
  title.textContent = "这一轮动向";
  head.append(title);
  if (summary && summary.turnId != null) {
    const meta = doc.createElement("span");
    meta.className = "awb-summary-meta";
    meta.textContent = `回合 ${String(summary.turnId).slice(0, 8)} · 修订 ${summary.revision ?? "—"} · ${summary.viewMode === "author" ? "后台" : "主角所知"}`;
    head.append(meta);
  }
  container.append(head);

  const staleByTurn = Boolean(scope && summary && (
    (scope.turnId != null && summary.turnId != null && String(scope.turnId) !== String(summary.turnId))
    || (Number.isInteger(scope.revision) && Number.isInteger(summary.revision) && Number(scope.revision) !== Number(summary.revision))
  ));
  if (!summary || staleByTurn || !Array.isArray(summary.lines) || !summary.lines.length) {
    const empty = doc.createElement("p");
    empty.className = "awb-empty";
    empty.textContent = summary?.note ? String(summary.note) : "等待这一轮的世界动向。";
    container.append(empty);
    return { destroy() { container.replaceChildren(); } };
  }
  const list = doc.createElement("ul");
  list.className = "awb-summary-list";
  for (const line of summary.lines.slice(0, 3)) {
    const li = doc.createElement("li");
    const value = String(line ?? "").trim();
    if (!value) continue;
    if (typeof onSelect === "function") {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "awb-summary-entry";
      button.textContent = value;
      button.addEventListener("click", () => onSelect({ line: value }));
      li.append(button);
    } else {
      li.textContent = value;
    }
    list.append(li);
  }
  container.append(list);
  if (summary.source === "model") {
    const flag = doc.createElement("span");
    flag.className = "awb-summary-source";
    flag.textContent = "模型摘要";
    container.append(flag);
  }
  return { destroy() { container.replaceChildren(); } };
}
