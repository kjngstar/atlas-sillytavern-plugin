/**
 * U12：统一日志时间线 + 导出。
 *
 * 一条时间线合并 host / model / storage / map / receipt 的 issue，用 trace / attempt / turn / group 关联展开。
 * 纪律：
 * - 每个 code / path / dependency / message 完整显示，不折叠到「去推进页看」。
 * - 导出按游标走完整分页（Q12 的 nextChangeCursor / nextFailedCursor），不截断。
 * - 默认脱敏：key / header 不进导出与默认展示（由 sanitizeDiagnostic 保证，这里再兜一层）。
 */
const SOURCE_LABEL = {
  host: "宿主", ui: "界面", engine: "引擎", model: "模型", storage: "存储", lorebook: "世界书", map: "地图",
};

/** 兜底脱敏：即便上游漏了，也不能把密钥/回执正文带进日志页与导出。 */
export function redactLogText(value) {
  const text = value == null ? "" : String(value);
  if (!text) return "";
  return text
    .replace(/sk-[A-Za-z0-9_-]{4,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{4,}/gi, "Bearer [redacted]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[redacted]");
}
function sensitiveKey(key) {
  return /api_key|apiKey|authorization|token|secret|password|cookie|bearer|signature|response|headers/i.test(String(key ?? ""));
}
/** 关联键：同一 trace / attempt / turn / group 的条目堆在一起展开。 */
export function logGroupKey(entry) {
  return [
    entry?.traceId ? `trace:${entry.traceId}` : "",
    entry?.attemptId ? `attempt:${entry.attemptId}` : "",
    entry?.turnRef ? `turn:${entry.turnRef}` : "",
    entry?.groupId ? `group:${entry.groupId}` : "",
  ].filter(Boolean).join("|") || `single:${String(entry?.id ?? "")}`;
}

export function renderUnifiedLogTimeline(container, options = {}) {
  const doc = container.ownerDocument;
  const { entries = [], onExpand, exportPage = null, hasMore = false, onMore } = options;
  container.replaceChildren();
  if (!Array.isArray(entries) || !entries.length) {
    const empty = doc.createElement("p");
    empty.className = "awb-empty";
    empty.textContent = "当前没有诊断记录。";
    container.append(empty);
    return { destroy() { container.replaceChildren(); } };
  }
  const groups = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const key = logGroupKey(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const list = doc.createElement("ul");
  list.className = "awb-log-list";
  for (const [key, rows] of groups) {
    const li = doc.createElement("li");
    li.className = "awb-log-group";
    const head = doc.createElement("button");
    head.type = "button";
    head.className = "awb-log-head";
    head.textContent = `${rows.length > 1 ? `${rows.length} 条 · ` : ""}${key || "独立记录"}`;
    head.setAttribute("aria-expanded", "false");
    const body = doc.createElement("div");
    body.className = "awb-log-body";
    body.hidden = true;
    head.addEventListener("click", () => {
      const open = body.hidden;
      body.hidden = !open;
      head.setAttribute("aria-expanded", String(open));
      if (open && typeof onExpand === "function") onExpand({ key, rows });
    });
    for (const entry of rows) {
      const row = doc.createElement("div");
      row.className = "awb-log-row";
      const top = doc.createElement("div");
      top.className = "awb-log-top";
      const code = doc.createElement("code");
      code.textContent = redactLogText(entry.code ?? entry.errorCode ?? "UNKNOWN");
      const source = doc.createElement("span");
      source.className = "awb-log-source";
      source.textContent = SOURCE_LABEL[entry.source] ?? String(entry.source ?? "—");
      const level = doc.createElement("span");
      level.className = `awb-log-level is-${String(entry.level ?? "info")}`;
      level.textContent = String(entry.level ?? "info");
      top.append(level, source, code);
      row.append(top);
      const message = doc.createElement("p");
      message.className = "awb-log-message";
      message.textContent = redactLogText(entry.message ?? entry.summary ?? "");
      row.append(message);
      const path = entry.schemaPath ?? entry.path;
      if (path) {
        const pathEl = doc.createElement("p");
        pathEl.className = "awb-log-path";
        pathEl.textContent = `位置：${redactLogText(path)}`;
        row.append(pathEl);
      }
      if (Array.isArray(entry.dependencies) && entry.dependencies.length) {
        const dep = doc.createElement("p");
        dep.className = "awb-log-dep";
        dep.textContent = `依赖：${entry.dependencies.map((item) => redactLogText(item)).join("、")}`;
        row.append(dep);
      }
      for (const [key2, value] of Object.entries(entry.details ?? {})) {
        if (sensitiveKey(key2)) continue;
        const detail = doc.createElement("p");
        detail.className = "awb-log-detail";
        detail.textContent = `${key2}：${redactLogText(typeof value === "object" ? JSON.stringify(value) : value)}`;
        row.append(detail);
      }
      body.append(row);
    }
    li.append(head, body);
    list.append(li);
  }
  container.append(list);
  const tools = doc.createElement("div");
  tools.className = "awb-log-tools";
  if (hasMore && typeof onMore === "function") {
    const more = doc.createElement("button");
    more.type = "button";
    more.className = "awb-tool";
    more.textContent = "加载更多日志";
    more.addEventListener("click", () => onMore());
    tools.append(more);
  }
  if (typeof exportPage === "function") {
    const exportButton = doc.createElement("button");
    exportButton.type = "button";
    exportButton.className = "awb-tool";
    exportButton.textContent = "导出日志 JSON";
    exportButton.addEventListener("click", () => exportPage());
    tools.append(exportButton);
  }
  if (tools.childNodes.length) container.append(tools);
  return { destroy() { container.replaceChildren(); }, groupCount: groups.size };
}

/** 导出：按游标完整翻页，遇到脱敏字段再兜一层。返回 { entries, complete, nextCursor }。 */
export async function exportUnifiedLog(fetchPage, options = {}) {
  const { maxPages = 200 } = options;
  const entries = [];
  let cursor = null;
  let complete = false;
  if (typeof fetchPage !== "function") return { entries, complete: true, nextCursor: null, pages: 0 };
  for (let page = 0; page < maxPages; page += 1) {
    const payload = await fetchPage(cursor);
    const rows = Array.isArray(payload?.entries) ? payload.entries : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      entries.push({
        ...row,
        ...(row.message ? { message: redactLogText(row.message) } : {}),
        ...(row.details && typeof row.details === "object"
          ? { details: Object.fromEntries(Object.entries(row.details).filter(([key]) => !sensitiveKey(key))) }
          : {}),
      });
    }
    cursor = payload?.nextCursor ?? null;
    if (!cursor) { complete = true; break; }
  }
  return { entries, complete, nextCursor: cursor, pages: Math.ceil(entries.length / 50) };
}
