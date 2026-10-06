import { atlasPointRefOf, atlasSqlFilterByViewMode, atlasClockLabel } from './atlas-scene-ui-adapter.mjs';

// A presentation layer over the existing workbench. It never saves world data.
const ICONS = {
  brand: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6.7" stroke-dasharray="2 3"/><path d="m12 4.5 6 12H6Zm0 4 2.5 5h-5Z"/>',
  overview: '<path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/>',
  map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Z"/><path d="M9 3v15M15 6v15"/>',
  nearby: '<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2M17 4a4 4 0 0 1 0 7M22 21v-2a4 4 0 0 0-3-4"/>',
  changes: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  progression: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  api: '<path d="M8 3v5M16 3v5M5 8h14v3a7 7 0 0 1-14 0ZM12 18v4"/>',
  replace: '<path d="M4 7h14l-3-3M20 17H6l3 3M18 7l-3 3M6 17l3-3"/>',
  skin: '<path d="M12 3a9 9 0 0 0 0 18h2a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h4a4 4 0 0 0 4-4c0-3-4-6-9-6Z"/><circle cx="7" cy="10" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7" r="1"/>',
  logs: '<path d="M2 12h4l3-7 4 14 3-9 2 2h4"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8Zm-10 10 10 5 10-5M2 18l10 5 10-5"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  expand: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
  fold: '<path d="m8 4 8 8-8 8"/>',
};

function node(tag, cls, text) {
  const result = document.createElement(tag);
  if (cls) result.className = cls;
  if (text != null) result.textContent = String(text);
  return result;
}

export function atlasUiIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  // Only fixed, local icon paths are interpolated here.
  svg.innerHTML = ICONS[name] ?? ICONS.layers;
  return svg;
}

function button(label, action, cls = 'as-icon-button', icon) {
  const result = node('button', cls, icon ? null : label);
  result.type = 'button';
  result.setAttribute('aria-label', label);
  result.title = label;
  if (icon) result.append(atlasUiIcon(icon));
  result.addEventListener('click', action);
  return result;
}

/** Map IDs and entity IDs stay distinct; hidden parent locations hide their subtree. */
export function atlasWorkbenchTree({ sqlItems, viewMode = 'pov', worldName, rootPoints = [], submaps = {} }) {
  const rows = [];
  const visited = new Set();
  const sql = Array.isArray(sqlItems);
  const rootMap = sql ? sqlItems.find(item => !item?.containerLocationId) : null;
  if (sql && !rootMap) return rows;
  rows.push({ id: 'world', name: rootMap?.name || worldName || '世界地图', depth: 0,
    path: [], parentPath: [], mapId: rootMap?.mapId ?? null, hasMap: true });
  const visit = (item, points, owners, depth) => {
    if (depth > 9) return;
    for (const point of points) {
      if (!point || String(point.kind ?? 'location') !== 'location') continue;
      const entityId = String(point.entityId ?? point.rowId ?? point.id ?? '');
      const id = atlasPointRefOf(entityId);
      if (!id || visited.has(id)) continue;
      visited.add(id);
      const candidate = sql ? sqlItems.find(map => String(map?.containerLocationId ?? '') === entityId) : submaps[id];
      const parentId = owners.at(-1)?.pointId ?? 'world';
      const child = sql || String(candidate?.parentMapId ?? 'world') === parentId ? candidate : null;
      const hasMap = Boolean(child);
      const path = hasMap ? [...owners, { pointId: id, name: String(point.name || id) }] : owners;
      rows.push({ id, entityId, name: String(point.name || id), depth, path, parentPath: owners,
        mapId: child?.mapId ?? null, hasMap });
      if (child) visit(child, sql ? atlasSqlFilterByViewMode(child.points, viewMode) : child.points ?? [], path, depth + 1);
    }
  };
  visit(rootMap, sql ? atlasSqlFilterByViewMode(rootMap.points, viewMode) : rootPoints, [], 1);
  return rows;
}

export function createStarmapShell({ root, rail, brand, navButtons, foot, main, topbar, topbarLeft,
  topbarRight, center, side, sideChanges, devSlot, moves, core, onNavigate, onSelect,
  onCloseDetail, onLocate, onViewMode, onResetPosition }) {
  root.classList.add('atlas-starmap');
  for (const [id, entry] of navButtons) entry.querySelector('.aw-nav__icon')?.replaceChildren(atlasUiIcon(id));
  const brandMark = brand.querySelector('.aw-brand__mark');
  brandMark.textContent = '';
  brandMark.append(atlasUiIcon('brand'));
  brand.append(node('span', 'as-brand-sub', 'WORLD STATE ENGINE'));
  const header = node('header', 'as-header');
  const headerCrumbs = node('nav', 'as-crumbs');
  headerCrumbs.setAttribute('aria-label', '当前地图路径');
  const tools = node('div', 'as-window-tools');
  tools.append(button('地图层级', () => togglePane('tree'), 'as-icon-button', 'layers'),
    button('对象详情', () => togglePane('inspector'), 'as-icon-button', 'nearby'),
    button('扩大或还原工作台', () => {
      const expanded = root.classList.toggle('is-maximized');
      root.style.translate = '';
      onResetPosition?.();
      tools.querySelector('[aria-label="扩大或还原工作台"]').setAttribute('aria-pressed', String(expanded));
    }, 'as-icon-button', 'expand'));
  topbar.insertBefore(brand, topbarLeft);
  topbarLeft.after(headerCrumbs);
  topbarRight.before(tools);
  header.append(topbar);

  const body = node('div', 'as-body');
  const treePane = node('aside', 'as-tree-pane');
  treePane.setAttribute('aria-label', '地图层级与图层');
  const treeHead = node('div', 'as-pane-head');
  const treeTitle = node('span', 'as-pane-title', '层级图层');
  treeTitle.prepend(atlasUiIcon('layers'));
  treeHead.append(treeTitle, button('定位当前位置', onLocate, 'as-icon-button', 'map'),
    button('折叠地图层级', () => togglePane('tree'), 'as-icon-button', 'fold'));
  const ladder = node('div', 'as-depth-ladder');
  const searchLabel = node('label', 'as-tree-search');
  searchLabel.append(atlasUiIcon('search'));
  const search = node('input');
  search.type = 'search'; search.placeholder = '搜索已知地点';
  search.setAttribute('aria-label', '搜索已知地点');
  searchLabel.append(search);
  const treeList = node('div', 'as-tree-list');
  const treeNote = node('div', 'as-tree-note');
  const layerSlot = node('div', 'as-layer-controls');
  treePane.append(treeHead, ladder, searchLabel, treeList, layerSlot, treeNote);
  rail.querySelector('.aw-brand')?.remove();
  rail.append(foot);
  main.querySelector('.aw-topbar')?.remove();
  const inspectorHead = node('div', 'as-pane-head');
  const inspectorTitle = node('span', 'as-pane-title', '当前地图');
  inspectorHead.append(inspectorTitle, button('返回当前地图概览', onCloseDetail, 'as-icon-button', 'map'),
    button('折叠对象详情', () => togglePane('inspector'), 'as-icon-button', 'fold'));
  const inspectorBody = node('div', 'as-inspector-content');
  const roster = node('div', 'as-inspector-roster');
  const inspectorTabs = node('div', 'as-inspector-tabs');
  const rosterList = node('div', 'as-roster-list');
  roster.append(inspectorTabs, rosterList);
  side.replaceChildren(inspectorHead, inspectorBody);
  inspectorBody.append(roster, devSlot);
  body.append(rail, treePane, main, side);

  const events = node('section', 'as-events');
  events.setAttribute('aria-label', '世界事件与推演回执');
  const eventHead = node('div', 'as-event-head');
  const eventTabs = node('div', 'as-event-tabs');
  let eventTab = 'events';
  const eventButton = button('事件流', () => showEvents('events'), 'as-event-tab');
  const receiptButton = button('推演回执', () => showEvents('receipts'), 'as-event-tab');
  eventTabs.append(eventButton, receiptButton);
  const eventMeta = node('span', 'as-event-meta');
  const collapseEvents = button('收起或展开事件栏', () => {
    const collapsed = events.classList.toggle('is-collapsed');
    collapseEvents.setAttribute('aria-expanded', String(!collapsed));
  }, 'as-icon-button', 'fold');
  collapseEvents.setAttribute('aria-expanded', 'true');
  eventHead.append(eventTabs, eventMeta,
    button('变化详情', () => core.setPage('changes'), 'as-event-link'),
    button('诊断', () => core.setPage('logs'), 'as-event-link'), collapseEvents);
  const eventBody = node('div', 'as-event-body');
  eventBody.append(moves, sideChanges);
  events.append(eventHead, eventBody);
  root.append(header, body, events);

  let scope = null;
  let lastSnapshot = null;
  let mapState = null;
  let rosterTab = 'characters';
  const viewBadge = button('切换世界视角', onViewMode, 'as-view-badge');
  tools.prepend(viewBadge);
  search.addEventListener('input', renderTree);

  function togglePane(pane) {
    const width = root.ownerDocument.defaultView?.innerWidth ?? 1600;
    if (pane === 'tree' && width > 1050) { root.classList.toggle('is-tree-collapsed'); return; }
    if (pane === 'inspector' && width > 850) { root.classList.toggle('is-inspector-collapsed'); return; }
    if (pane === 'tree') {
      root.classList.remove('is-inspector-open');
      root.classList.toggle('is-tree-open');
    } else {
      root.classList.remove('is-tree-open');
      root.classList.toggle('is-inspector-open');
    }
  }
  function showEvents(tab) {
    eventTab = tab;
    eventButton.classList.toggle('is-active', tab === 'events');
    receiptButton.classList.toggle('is-active', tab === 'receipts');
    moves.hidden = tab !== 'events'; sideChanges.hidden = tab !== 'receipts';
  }
  function renderTree() {
    treeList.replaceChildren();
    // U05 返工：权威树接管时旧树**根本不画**（不是画完再隐藏）——
    // 同一层级只允许存在一份地图树，DOM 里也不留第二份可被点到/被读到的旧行。
    // 面包屑与层梯仍由本文件的 updateMap 从 next.tree 生成，不依赖这份列表。
    if (mapState?.treeAuthoritative === true) return;
    const q = search.value.trim().toLocaleLowerCase();
    const visible = (mapState?.tree ?? []).filter(row => !q || row.name.toLocaleLowerCase().includes(q));
    for (const row of visible) {
      const entry = button(row.name, () => {
        onNavigate(row);
        if (root.clientWidth <= 900) root.classList.remove('is-tree-open');
      }, 'as-tree-entry');
      entry.style.setProperty('--as-depth', q ? '0' : String(row.depth));
      entry.dataset.entityId = row.entityId ?? ''; entry.dataset.mapId = row.mapId ?? '';
      entry.classList.toggle('is-active', row.id === mapState?.ownerId);
      entry.append(node('span', 'as-tree-depth', `L${row.depth}`));
      entry.prepend(node('span', `as-tree-dot${row.hasMap ? ' has-map' : ''}`));
      treeList.append(entry);
    }
    if (!visible.length) treeList.append(node('p', 'as-empty', q ? '没有匹配的已知地点。' : '当前聊天暂无可用地图。'));
  }
  function renderRoster() {
    inspectorTabs.replaceChildren(); rosterList.replaceChildren();
    const entries = mapState?.[rosterTab] ?? [];
    for (const [tab, title] of [['characters', '人物'], ['items', '物品'], ['locations', '地点']]) {
      const count = mapState?.[tab]?.length ?? 0;
      const entry = button(`${title} ${count}`, () => { rosterTab = tab; renderRoster(); }, 'as-roster-tab');
      entry.classList.toggle('is-active', tab === rosterTab);
      inspectorTabs.append(entry);
    }
    for (const entry of entries) {
      const card = button(`查看${entry.name}`, () => {
        onSelect(rosterTab, entry);
        root.classList.add('is-inspector-open');
      }, 'as-entity-card');
      const avatar = node('span', `as-avatar as-avatar--${rosterTab}`, entry.name.slice(0, 1));
      const text = node('span', 'as-entity-text');
      text.append(node('strong', '', entry.name), node('span', '', entry.meta || '当前地图'));
      card.replaceChildren(avatar, text);
      card.dataset.entityId = entry.rowId ?? entry.entityId ?? entry.id;
      rosterList.append(card);
    }
    if (!entries.length) rosterList.append(node('p', 'as-empty', '当前地图暂无可见条目。'));
  }
  function sync(d, s, snapshot = null) {
    root.dataset.page = s.page;
    const nextScope = JSON.stringify([s.chatId, d.worldId, d.branchId, d.revision, d.currentTime, s.binding?.branchId]);
    const sameSnapshot = snapshot?.key === lastSnapshot?.key
      && snapshot?.snapshotData === lastSnapshot?.snapshotData && snapshot?.metadata === lastSnapshot?.metadata;
    if (scope !== nextScope || !sameSnapshot) {
      scope = nextScope; mapState = null; search.value = ''; rosterTab = 'characters';
      lastSnapshot = snapshot;
      onCloseDetail(); renderTree(); renderRoster();
      root.classList.remove('is-tree-open', 'is-inspector-open');
    }
    const sql = d.sqlMode === true || d.sqlModeEnabled === true || d.sqlViews != null;
    eventMeta.textContent = d.currentTime == null ? '等待世界状态' :
      `${atlasClockLabel(d.currentTime, sql)} · ${s.receipts?.length ?? 0} 份回执`;
    viewBadge.hidden = s.page !== 'map' || !mapState?.sql;
    showEvents(eventTab);
  }
  function updateMap(next) {
    mapState = next;
    inspectorTitle.textContent = next.name || '当前地图';
    viewBadge.hidden = !next.sql;
    viewBadge.textContent = next.viewMode === 'author' ? '世界后台' : '主角所知';
    viewBadge.setAttribute('aria-pressed', String(next.viewMode === 'author'));
    headerCrumbs.replaceChildren(); ladder.replaceChildren();
    const ancestors = (next.tree ?? []).filter(row => row.id === 'world' || next.path.some(owner => owner.pointId === row.id));
    for (const row of ancestors) {
      const crumb = button(row.name, () => onNavigate(row), 'as-crumb');
      crumb.classList.toggle('is-active', row.id === next.ownerId);
      headerCrumbs.append(crumb);
      const level = button(`L${row.depth}`, () => onNavigate(row), 'as-depth');
      level.classList.toggle('is-active', row.id === next.ownerId);
      ladder.append(level);
    }
    treeNote.textContent = next.truncated ? '当前视图有读取上限，未显示的条目可在详细页面查看。' : '浏览与切换图层不会推进世界时间。';
    renderTree(); renderRoster();
  }
  return { sync, updateMap, layerSlot, inspectorBody,
    dockDetail(panel) { inspectorBody.insertBefore(panel, devSlot); },
    openInspector() { root.classList.remove('is-tree-open', 'is-inspector-collapsed'); root.classList.add('is-inspector-open'); },
    closeInspector() { root.classList.remove('is-inspector-open'); },
  };
}
