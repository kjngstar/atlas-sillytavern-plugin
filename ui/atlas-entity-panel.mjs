/**
 * U06：右栏对象详情卡（地点 / 人物 / 物品）。
 *
 * 纪律：
 * - 只展示查询返回的内容：POV 读到什么显示什么，author 的隐藏内容显式标「后台」。
 * - 未选中时显示「未选中」，绝不沿用上一个实体。
 * - 异步详情必须带 selection+scope 校验（由调用方传 ticket，本文件只渲染）。
 */
function textOf(value, fallback = "") {
  if (value == null) return fallback;
  const out = String(value).trim();
  return out || fallback;
}
function listOf(value) {
  return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object") : [];
}

export function entityKindOf(entity) {
  const kind = String(entity?.kind ?? entity?.entityKind ?? "").toLowerCase();
  if (kind === "location" || kind === "place") return "location";
  if (kind === "character" || kind === "person" || kind === "npc") return "person";
  if (kind === "item" || kind === "object") return "item";
  return kind || "unknown";
}

function block(doc, container, title, rows) {
  if (!rows.length) return;
  const section = container.ownerDocument.createElement("section");
  section.className = "awb-card-block";
  const head = container.ownerDocument.createElement("h4");
  head.textContent = title;
  section.append(head);
  const list = container.ownerDocument.createElement("ul");
  for (const row of rows) {
    const li = container.ownerDocument.createElement("li");
    li.textContent = row;
    list.append(li);
  }
  section.append(list);
  container.append(section);
}

export function renderEntityPanel(container, entity, options = {}) {
  const doc = container.ownerDocument;
  const { onSelect, onLocate, onEnter, viewMode = "pov" } = options;
  container.replaceChildren();
  const author = viewMode === "author";
  if (!entity || typeof entity !== "object") {
    const empty = doc.createElement("p");
    empty.className = "awb-empty";
    empty.textContent = "未选中对象。点击地图或名单查看详情。";
    container.append(empty);
    return { destroy() { container.replaceChildren(); } };
  }
  const kind = entityKindOf(entity);
  const root = doc.createElement("div");
  root.className = `awb-card awb-card--${kind}`;
  root.dataset.entityId = String(entity.id ?? entity.entityId ?? "");
  const title = doc.createElement("h3");
  title.textContent = textOf(entity.name ?? entity.title, "未命名");
  root.append(title);
  if (author && entity.hidden === true) {
    const badge = doc.createElement("span");
    badge.className = "awb-badge awb-badge--hidden";
    badge.textContent = "后台（主角不可见）";
    root.append(badge);
  }
  const meta = doc.createElement("p");
  meta.className = "awb-card-meta";
  meta.textContent = [kind === "location" ? "地点" : kind === "person" ? "人物" : kind === "item" ? "物品" : "对象",
    entity.locationName ? `位于 ${textOf(entity.locationName)}` : null,
    entity.mapId ? `地图 ${textOf(entity.mapId)}` : null].filter(Boolean).join(" · ");
  root.append(meta);
  if (entity.summary || entity.description) {
    const intro = doc.createElement("p");
    intro.className = "awb-card-intro";
    intro.textContent = textOf(entity.summary ?? entity.description);
    root.append(intro);
  }
  container.append(root);

  const body = doc.createElement("div");
  body.className = "awb-card-body";
  container.append(body);

  const names = (rows, key = "name") => listOf(rows).map((row) => textOf(row[key] ?? row.title, "未命名"));
  block(doc, body, "子地点", names(entity.childLocations ?? entity.childMaps));
  block(doc, body, "在场", names(entity.present ?? entity.characters ?? entity.actors));
  block(doc, body, "地面物品", names(entity.groundItems));
  block(doc, body, "持有物品", names(entity.heldItems ?? entity.inventory));
  block(doc, body, "想法", listOf(entity.thoughts).map((row) => textOf(row.content ?? row.text)));
  block(doc, body, "行动", listOf(entity.actions).map((row) => textOf(row.summary ?? row.content ?? row.text)));
  block(doc, body, "行程", listOf(entity.journeys).map((row) => {
    const status = row.status ? `（${textOf(row.status)}）` : "";
    return `${textOf(row.summary ?? row.name, "行程")}${status}`;
  }));
  block(doc, body, "已知信息", listOf(entity.knowledge).map((row) => textOf(row.title ?? row.content ?? row.text)));

  const tools = doc.createElement("div");
  tools.className = "awb-card-tools";
  const entityId = String(entity.id ?? entity.entityId ?? "");
  if (entityId && typeof onLocate === "function") {
    const locate = doc.createElement("button");
    locate.type = "button";
    locate.className = "awb-tool";
    locate.textContent = "定位到地图";
    locate.setAttribute("aria-label", `定位到 ${textOf(entity.name, "该对象")}`);
    locate.addEventListener("click", () => onLocate({ kind, id: entityId, entity }));
    tools.append(locate);
  }
  const children = listOf(entity.childMaps?.length ? entity.childMaps : entity.childLocations);
  if (kind === "location" && typeof onEnter === "function") {
    const enter = doc.createElement("button");
    enter.type = "button";
    enter.className = "awb-tool";
    // 多个子地图不自动挑第一个：这里只给入口，选择交给 U07 的选择逻辑。
    enter.textContent = children.length > 1 ? "选择子地图" : "进入子地图";
    enter.disabled = children.length === 0;
    enter.addEventListener("click", () => onEnter({ kind, id: entityId, children, entity }));
    tools.append(enter);
  }
  if (tools.childNodes.length) container.append(tools);

  if (typeof onSelect === "function") {
    for (const [label, rows] of [["在场", entity.present ?? entity.characters ?? entity.actors], ["物品", entity.groundItems ?? entity.heldItems]]) {
      for (const row of listOf(rows)) {
        const id = String(row.id ?? row.entityId ?? "");
        if (!id) continue;
        const chip = doc.createElement("button");
        chip.type = "button";
        chip.className = "awb-chip";
        chip.textContent = `${label}：${textOf(row.name, "未命名")}`;
        chip.addEventListener("click", () => onSelect({ kind: label === "在场" ? "character" : "item", id, entity: row }));
        container.append(chip);
      }
    }
  }
  return {
    destroy() { container.replaceChildren(); },
  };
}
