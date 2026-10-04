

/**
 * H12（§16.3 / §17H-H12）：UI 消费的 SQL DTO 形状（与 `src/atlas-db-views.ts` 一字对齐）。
 *
 * 这些类型写在这里是为了让「界面读哪些字段」有唯一的书面口径：
 * - 一律**不补缺省 0**：`x` / `y` / `radius` / `distanceM` / `gridDistance` 未知就是 null，
 *   渲染层必须跳过（`atlasKnownCoordinate`）；
 * - `positionQuality` 必须一路带到 DOM（`data-position-quality`），作者一眼能分辨
 *   「量出来的」与「估出来的」；
 * - `coarseList` 的人物**不得**画成地图人物图标（§10.2：只进名单）。
 *
 * @typedef {"exact"|"approximate"|"layout"|"coarse"|"unknown"} AtlasSqlPositionQuality
 * @typedef {object} AtlasSqlMapPoint
 * @property {string} entityId 实体行 id（`loc:*` / `npc:*` / `item:*`）
 * @property {"location"|"character"|"item"} kind
 * @property {string} name
 * @property {string} mapId
 * @property {number|null} x 未知坐标 = null（绝不是 0）
 * @property {number|null} y
 * @property {string} precision
 * @property {number|null} radius
 * @property {string} markerQuality
 * @property {boolean} [hidden] 主角尚不知道（作者视图才显示；只影响 UI 过滤）
 * @property {string} [visibility] `'hidden'` 等价于 hidden
 * @typedef {object} AtlasSqlCoarseEntry
 * @property {string} entityId
 * @property {string} name
 * @property {string} locationId
 * @property {string|null} locationName
 * @typedef {object} AtlasSqlRoute
 * @property {string} routeId
 * @property {string} fromId
 * @property {string} toId
 * @property {string} geometryQuality `confirmed` 之外的几何一律虚线 + 「估计」
 * @property {number|null} distanceM
 * @property {boolean} dashed
 * @typedef {object} AtlasSqlMapViewItem
 * @property {string} mapId
 * @property {string} name
 * @property {string|null} containerLocationId 非空 = 该地点的子图
 * @property {number|null} metersPerCell 地图行原值：缩放只改读数，绝不改它（§10.3）
 * @property {string} scaleQuality
 * @property {boolean} scaleLocked
 * @property {AtlasSqlMapPoint[]} points
 * @property {AtlasSqlCoarseEntry[]} coarseList
 * @property {AtlasSqlRoute[]} routes
 * @property {{frame?: object, scaleBar?: object|null}} frames
 * @typedef {object} AtlasSqlViewResult
 * @property {string} branchId
 * @property {number} revision 界面只认当前修订（§10.1）
 * @property {unknown[]} items
 * @property {string} [nextCursor] 分页游标：只影响列表，不截断导出（H08）
 * @property {object} metadata
 * @typedef {object} AtlasSqlNearbyItem
 * @property {string} entityId
 * @property {string} name
 * @property {string} relevance
 * @property {string} positionQuality
 * @property {number|null} gridDistance 未知 = null（绝不显示「0 格」）
 * @typedef {object} AtlasSqlDiagnosticsItem
 * @property {string} logId 与回执错误**同一个** log ID（H08）
 * @property {"change"|"failed_turn"} kind
 * @property {string} turnId
 */

/** `loc:2` / `2` 两种写法的地点引用归一（地图点 id 与三表行 id 比较时统一用这个）。 */
export function atlasPointRefOf(entityId) {
  return String(entityId ?? "").trim().replace(/^loc:/, "");
}


/** H12：坐标只能是有限数；未知一律返回 null（**绝不返回 0**，绝不把 (0,0) 当合法缺省）。 */
export function atlasKnownCoordinate(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}


/** H06 / §10.2：位置质量词表归一（precision / markerQuality / positionQuality 共用一套词）。 */
export function atlasPositionQuality(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "exact" || raw === "precise" || raw === "confirmed") return "exact";
  if (raw === "approximate" || raw === "approx" || raw === "estimated") return "approximate";
  if (raw === "layout") return "layout";
  if (raw === "coarse" || raw === "location") return "coarse";
  return "unknown";
}


/**
 * H06：SQL 地图视图行 → UI 渲染模型（纯函数）。
 *
 * - 地点 / 人物 / 物品分成三组：**粗定位人物绝不混进人物标点**（§10.2）；
 * - 未知坐标一个点都不产出（H12：绝不用 0 补位）；
 * - 保留 `positionQuality` / `radius`，渲染层据此加范围或「估计」标识；
 * - `occupantCounts` 是地点标点上的「这里有 N 人」（粗定位名单 + 与该地点同坐标的人物）；
 * - `viewMode` 只影响**这一层显示什么**（§10.4：作者视图 = UI 过滤），
 *   不改数据结构、不改任何注入范围。
 */
export function atlasSqlMapModel(item, viewMode = "pov") {
  const record = item && typeof item === "object" ? item : {};
  const locations = [];
  const characterPins = [];
  const itemPins = [];
  for (const raw of atlasSqlFilterByViewMode(record.points, viewMode)) {
    if (!raw || typeof raw !== "object") continue;
    const x = atlasKnownCoordinate(raw.x);
    const y = atlasKnownCoordinate(raw.y);
    // H12：未知坐标一律丢弃（绝不落到 (0,0) 冒充一个真实位置）
    if (x === null || y === null) continue;
    const entityId = String(raw.entityId ?? "");
    const entry = {
      id: atlasPointRefOf(entityId),
      rowId: entityId,
      name: String(raw.name ?? ""),
      x,
      y,
      positionQuality: atlasPositionQuality(raw.markerQuality ?? raw.precision),
      radius: atlasKnownCoordinate(raw.radius),
      area: raw.area ?? null,
      locationId: raw.locationId == null ? null : String(raw.locationId),
      isProtagonist: raw.isProtagonist === true,
    };
    const kind = String(raw.kind ?? "location");
    if (kind === "character") characterPins.push(entry);
    else if (kind === "item") itemPins.push(entry);
    else locations.push(entry);
  }
  const coarseList = atlasSqlFilterByViewMode(record.coarseList, viewMode)
    .filter((raw) => raw && typeof raw === "object")
    .map((raw) => ({
      entityId: String(raw.entityId ?? ""),
      name: String(raw.name ?? ""),
      locationId: String(raw.locationId ?? ""),
      locationName: raw.locationName === null || raw.locationName === undefined ? null : String(raw.locationName),
    }));
  const occupantCounts = new Map();
  for (const entry of coarseList) {
    const key = String(entry.locationId);
    if (!key) continue;
    occupantCounts.set(key, (occupantCounts.get(key) ?? 0) + 1);
  }
  for (const pin of characterPins) {
    // 人物与地点坐标重合 = 只知「在这个地点」（§10.2：不叠图标，但人数必须看得见）
    const host = locations.find((location) => pin.locationId ? location.rowId === pin.locationId : location.x === pin.x && location.y === pin.y);
    if (host) occupantCounts.set(host.rowId, (occupantCounts.get(host.rowId) ?? 0) + 1);
  }
  const routes = (Array.isArray(record.routes) ? record.routes : [])
    .filter((raw) => raw && typeof raw === "object")
    .map((raw) => ({
      routeId: String(raw.routeId ?? ""),
      fromId: String(raw.fromId ?? ""),
      toId: String(raw.toId ?? ""),
      kind: String(raw.kind ?? ""),
      geometryQuality: String(raw.geometryQuality ?? "unknown"),
      distanceM: atlasKnownCoordinate(raw.distanceM),
      allowedModes: Array.isArray(raw.allowedModes) ? raw.allowedModes.map((mode) => String(mode)) : [],
      /** §10.2：只有已证实几何才画实线；其余一律虚线 + 「估计」说明。 */
      estimated: raw.dashed === true || String(raw.geometryQuality ?? "unknown") !== "confirmed",
    }));
  return {
    mapId: String(record.mapId ?? ""),
    name: String(record.name ?? ""),
    kind: String(record.kind ?? "world"),
    containerLocationId: record.containerLocationId === null || record.containerLocationId === undefined
      ? null : String(record.containerLocationId),
    backgroundAssetKey: record.backgroundAssetKey ?? null,
    metersPerCell: atlasKnownCoordinate(record.metersPerCell),
    scaleQuality: String(record.scaleQuality ?? "uncalibrated"),
    scaleLocked: record.scaleLocked === true,
    defaultTerrain: String(record.defaultTerrain ?? "unknown"),
    frame: record.frames?.frame && typeof record.frames.frame === "object" ? record.frames.frame : {},
    locations,
    characterPins,
    itemPins,
    coarseList,
    occupantCounts,
    areas: atlasSqlFilterByViewMode(record.points, viewMode).filter(point => point.kind === "location" && point.area).map(point => ({ locationId: String(point.entityId), geometry: point.area })),
    routes,
  };
}


/** H06：SQL 地图视图 → 子图索引（键 = 宿主地点的点 id；形状与旧 `maps.submaps` 一致）。 */
export function atlasSqlSubmaps(items) {
  const list = Array.isArray(items) ? items : [];
  const locationMapId = new Map();
  for (const item of list) {
    for (const point of Array.isArray(item?.points) ? item.points : []) {
      if (!point || typeof point !== "object") continue;
      if (String(point.kind ?? "location") !== "location") continue;
      const entityId = String(point.entityId ?? "");
      if (entityId) locationMapId.set(entityId, String(item?.mapId ?? ""));
    }
  }
  const byMapId = new Map(list.map((item) => [String(item?.mapId ?? ""), item]));
  const submaps = {};
  for (const item of list) {
    const container = item?.containerLocationId;
    if (container === null || container === undefined || String(container) === "") continue;
    const containerRef = String(container);
    const key = atlasPointRefOf(containerRef);
    if (!key || submaps[key]) continue;
    /**
     * `parentMapId` = 「从哪一层点进来的」：宿主地点自己所在的那张图的宿主地点点 id
     * （世界图 = "world"）。与旧 `maps.submaps` 同义，`hasChildSubmap` 的父链校验才能继续成立。
     */
    const hostItem = byMapId.get(locationMapId.get(containerRef) ?? "world") ?? null;
    const hostContainer = hostItem?.containerLocationId;
    // 子图索引必须看**全部**地点（含作者视图下才显示的）：否则父链会断，子图进不去；
    // 「显示什么」由渲染层按当前 viewMode 决定（见 atlasSqlMapModel 的第二参）。
    const model = atlasSqlMapModel(item, "author");
    submaps[key] = {
      parentMapId: hostContainer === null || hostContainer === undefined || String(hostContainer) === ""
        ? "world" : atlasPointRefOf(hostContainer),
      ownerLocationId: containerRef,
      mapId: model.mapId,
      name: model.name || key,
      metersPerCell: model.metersPerCell,
      scaleQuality: model.scaleQuality,
      /** SQL 模式没有旧式自由单位比例尺：保持 null，绝不伪造单位换算。 */
      scale: null,
      frame: model.frame,
      points: model.locations.map((location) => ({ id: location.id, name: location.name, x: location.x, y: location.y })),
      model,
    };
  }
  return submaps;
}


/** H06：按层级挑 SQL 地图行（pointId 为空 → 世界图 = containerLocationId 为空的那一张）。 */
export function atlasSqlMapItemFor(items, pointId) {
  const list = Array.isArray(items) ? items : [];
  const isWorld = (item) => item?.containerLocationId === null
    || item?.containerLocationId === undefined
    || String(item.containerLocationId) === "";
  if (pointId === null || pointId === undefined || String(pointId) === "") {
    return list.find((item) => isWorld(item)) ?? null;
  }
  const wanted = atlasPointRefOf(pointId);
  return list.find((item) => !isWorld(item) && atlasPointRefOf(item.containerLocationId) === wanted) ?? null;
}


/**
 * H12 / §10.4：UI 侧的「作者视图 / 主角所知」过滤（**只影响界面显示**）。
 *
 * `pov` 时隐藏 DTO 显式标记为隐藏的条目（`hidden` / `visibility: 'hidden'`）；
 * `author` 时全量显示。任何情况下都**不改数据、不改注入范围**——
 * 送进模型 / 世界书的投影只由 `buildSqlPromptScope`（永远按 pov 投影）构造。
 */
export function atlasSqlFilterByViewMode(items, viewMode = "pov") {
  const list = Array.isArray(items) ? items : [];
  if (String(viewMode) === "author") return list;
  return list.filter((item) => item?.hidden !== true && String(item?.visibility ?? "") !== "hidden");
}


/**
 * H07：SQL 附近视图 → 卡片数据。
 *
 * 只认**这一份**视图里的 `items`；没有 items 就返回空数组——调用方据此清空卡片，
 * 绝不保留「上几次的人物缓存」（§10.1）。距离未知时 `gridDistance` 为 null（绝不写 0）。
 */
export function atlasSqlNearbyCards(view, viewMode = "pov") {
  const list = atlasSqlFilterByViewMode(view?.items, viewMode);
  return list
    .filter((raw) => raw && typeof raw === "object")
    .map((raw) => ({
      id: String(raw.entityId ?? ""),
      name: String(raw.name ?? ""),
      relevance: String(raw.relevance ?? ""),
      positionQuality: atlasPositionQuality(raw.positionQuality),
      gridDistance: atlasKnownCoordinate(raw.gridDistance),
      lastSeenAt: raw.lastSeenAt ?? null,
    }));
}


/**
 * H12 / §10.4：SQL 模式下**唯一**允许送进模型 / 世界书的投影构造点。
 *
 * 界面上的「作者视图」开关只改 UI 过滤：`uiViewMode` 在这里**只被记录**，
 * 绝不参与投影计算——投影永远按 `projectForPov(world, pov)` 构造，字段级知识边界
 * 由 knowledge 决定，不因为作者开了作者地图就放宽注入范围（§10.4）。
 */
export function buildSqlPromptScope(sqlCore, world, pov, uiViewMode = "pov") {
  const mode = String(uiViewMode ?? "pov");
  const projectForPov = sqlCore?.projectForPov;
  if (typeof projectForPov !== "function") {
    return { ok: false, code: "SQL_CORE_UNAVAILABLE", projection: null, uiViewMode: mode };
  }
  // 刻意不把 viewMode 传进投影：注入范围与界面开关无关。
  const projection = projectForPov(world, pov);
  return { ok: true, projection, uiViewMode: mode };
}

/** Select compatibility input once, outside DOM rendering. SQL failures stay empty. */
export function atlasMapSource(d,resolved){
 const mapData=d.map??{};
    const sqlMapItems = resolved.active && Array.isArray(resolved.view.items) ? resolved.view.items : null;
    const sqlSubmapsResolved = sqlMapItems ? atlasSqlSubmaps(sqlMapItems) : null;
    // D03：已经懒迁移过的分支，`/state` 会带 `tableMap`（三表投影）。
    // 世界图与子图都优先用它——世界图只含根地点、子图按父地点键挂载，与 A03/A04/D-20 的口径一致。
    // 没有 `tableMap` 的旧会话（或 projection 为空）**完全走原来的逻辑**，行为一字不变。
    // H06：SQL 模式开启时 tableMap 不再参与渲染（唯一读权威 = SQL 视图）。
    const tableMap = !resolved.active && d.tableMap && typeof d.tableMap === "object" ? d.tableMap : null;
    const tableSubmaps = tableMap && tableMap.submaps && typeof tableMap.submaps === "object" ? tableMap.submaps : null;
    const submapSource = sqlSubmapsResolved
      ?? tableSubmaps
      ?? (mapData.submaps && typeof mapData.submaps === "object" ? mapData.submaps : {});
    const submaps = submapSource;
    const pointMeta = mapData.pointMeta && typeof mapData.pointMeta === "object" ? mapData.pointMeta : {};
 return {sqlMapItems,sqlSubmapsResolved,tableMap,submaps,pointMeta};
}

/** Read-only layer model. Legacy compatibility never runs when SQL is selected. */
export function atlasMapLayerInput(input,ports){
 const {d,mapData,tableMap,sqlMapItems,sqlModel,inSub,currentSub,view,regionFilter}=input;
 const {tableRowIdOf,npcViewFromTableRow,objectViewFromTableRow}=ports;
    const legacyPointsAll = Array.isArray(mapData.points) ? mapData.points : [];
    const tableWorldPoints = tableMap && Array.isArray(tableMap.world?.points)
      ? tableMap.world.points
        .filter((point) => !point.kind || point.kind === "location")
        .map((point) => ({ id: point.id, name: point.name, x: point.x, y: point.y, regionId: point.regionId ?? null }))
      : null;
    const sqlPoints = sqlModel ? sqlModel.locations : [];
    const pointsAll = sqlMapItems ? sqlPoints : (tableWorldPoints ?? legacyPointsAll);
    const subPoints = sqlMapItems
      ? sqlPoints
      : (inSub && Array.isArray(currentSub.points)
        ? (tableMap ? currentSub.points.filter((point) => !point.kind || point.kind === "location") : currentSub.points)
        : null);
    // SQL 模式不做地区筛选：地区染色来自 SQL 地点范围（`area_geometry_json` / relations），
    // 旧 `regionId` 在 SQL 行里没有对应字段——宁可不过滤，也不拿旧世界字段筛 SQL 点。
    const points = sqlMapItems
      ? sqlPoints
      : inSub
        ? subPoints
        : regionFilter
          ? pointsAll.filter((p) => String(p.regionId ?? "") === regionFilter)
          : pointsAll;
    // 世界图以地点和人数徽标承载人物；子图只有真实细格坐标才画独立人物点，
    // 建筑级与未知位置仍由地点面板名单承载。
    // H06：SQL 模式下目录 / 三表一律不参与（人物由 SQL 人物标点 + 粗定位名单承载）。
    const npcsAll = sqlMapItems ? [] : (Array.isArray(d.npcDirectory) ? d.npcDirectory : []);
    const objectsAll = sqlMapItems ? [] : (Array.isArray(d.objectDirectory) ? d.objectDirectory : []);
    let rosterNpcs = [];
    let objects;
    if (inSub) {
      const ownerId = String(view.pointId);
      // 账本 presence=left 的人已经离场，不能出现在「建筑内」名单里冒充在场
      rosterNpcs = npcsAll.filter((n) => String(n.pointId ?? "") === ownerId && n.presence !== "left");
      const estimatedNpcIds = new Set((Array.isArray(currentSub?.points) ? currentSub.points : [])
        .filter((point) => point?.kind === "character" && point.positionQuality === "estimated")
        .map((point) => String(point.rowId ?? point.id ?? "")));
      rosterNpcs = rosterNpcs.filter((npc) => !estimatedNpcIds.has(tableRowIdOf(npc.id)));
      objects = objectsAll.filter((o) => String(o.pointId ?? "") === ownerId);
      if (tableMap) {
        /**
         * D03 / D-34：子图名单同样以三表为准，并且**口径与地图一致**——
         * 当前层可见的房间 = 宿主 + `submaps` 里以宿主为父的那些房间（含再下一层），
         * 名单里列的是"归属于这些房间、但**没有房间内细坐标**"的人 / 物品。
         * 有细坐标的人已经在地图上画成图钉了，不该在名单里再出现一次。
         *
         * 旧实现按宿主 id 精确匹配位置，于是"位置=某个房间"的人一个都进不来——
         * 名单与地图会同时为空，而人其实就在这层楼里。
         */
        /**
         * 口径与地图上的图钉**完全一致**：可见房间 = 当前图层渲染出来的地点标点
         * （子图里 = 宿主 + 同层房间）。名单只列"归属于这些房间、但没有房间内细坐标"的人 / 物品；
         * 有细坐标的已经在地图上画成图钉，不在名单里重复出现。
         */
        const visibleRoomIds = new Set([`loc:${ownerId}`, ...points.map((point) => `loc:${String(point.id)}`)]);
        const hasFinePosition = (row) => typeof row.gridX === "number" && typeof row.gridY === "number";
        const knownNpcKeys = new Set();
        for (const npc of rosterNpcs) {
          knownNpcKeys.add(tableRowIdOf(npc.id));
          knownNpcKeys.add(String(npc.id ?? ""));
        }
        const tableObjectsHere = (tableMap.objects?.entries ?? []).filter((entry) =>
          visibleRoomIds.has(String(entry.locationId ?? "")) && entry.holderCharacterId === null);
        // 三表是物品权威；旧目录镜像若另用了 id，也不能把同一支水笔列两次。
        objects = objects.filter((object) => !tableObjectsHere.some((entry) =>
          String(entry.id) === String(object.id) ||
          (String(entry.name).trim() === String(object.name).trim()
            && String(entry.description ?? "").trim() === String(object.description ?? "").trim()
            && String(entry.locationId ?? "") === `loc:${String(object.pointId ?? ownerId)}`)));
        const knownObjectIds = new Set(objects.map((o) => String(o.id ?? "")));
        for (const entry of tableMap.nearby?.entries ?? []) {
          const locationId = String(entry.locationId ?? "");
          if (!visibleRoomIds.has(locationId)) continue;
          if (entry.presence === "left") continue;
          if (entry.isProtagonist === true) continue;
          const rowId = String(entry.id ?? "").startsWith("npc:") ? String(entry.id) : `npc:${String(entry.id ?? "")}`;
          if (hasFinePosition(entry) || estimatedNpcIds.has(rowId)) continue;
          if (knownNpcKeys.has(rowId)) continue;
          rosterNpcs = [...rosterNpcs, npcViewFromTableRow(entry)];
        }
        for (const entry of tableMap.objects?.entries ?? []) {
          const locationId = String(entry.locationId ?? "");
          if (!visibleRoomIds.has(locationId)) continue;
          if (entry.holderCharacterId !== null) continue;
          if (hasFinePosition(entry)) continue;
          if (knownObjectIds.has(String(entry.id ?? ""))) continue;
          objects = [...objects, objectViewFromTableRow(entry)];
        }
      }
    } else {
      objects = regionFilter ? objectsAll.filter((o) => String(o.regionId ?? "") === regionFilter) : objectsAll;
    }
 return {pointsAll,points,subPoints,rosterNpcs,objects};
}

/** Same per-revision model for the place popup, without DOM-side source merging. */
export function atlasMapOccupants(d,point,model,sqlEnabled,ports){
 const {tableNpcsAtLocation,tableObjectsAtLocation,npcViewFromTableRow,objectViewFromTableRow,sqlNpcsAtPoint}=ports;
    const d0 = d;
    // D04：有 `tableMap` 时，**位置与在场性以三表为准**（行增量回合只改三表）；
    // 目录只补它独有的字段（最近叙事 / reason / status），避免"面板说人在、三表说人走"。
    const panelTableMap = sqlEnabled ? null : d0?.tableMap ?? null;
    const tableNpcsHere = panelTableMap ? tableNpcsAtLocation(panelTableMap, point.id) : [];
    const directoryNpcs = Array.isArray(d0?.npcDirectory) ? d0.npcDirectory : [];
    const directoryById = new Map(directoryNpcs.map((n) => [String(n.id ?? ""), n]));
    const hereNpcs = panelTableMap
      ? tableNpcsHere.map((entry) => {
          const view = npcViewFromTableRow(entry);
          const rich = directoryById.get(view.id);
          // 合并顺序很重要：三表字段**最后展开**（位置 / 在场性 / 想法以三表为准），
          // 只从目录里取它独有的最近叙事与关联原因。
          return rich ? { ...rich, ...view, recentNarratives: rich.recentNarratives, reason: rich.reason } : view;
        })
      // H06：SQL 模式下列表来自 SQL 口径（粗定位名单 + 同坐标人物点），不读旧目录
      : model
        ? sqlNpcsAtPoint(model, point)
        : directoryNpcs.filter((n) => String(n.pointId ?? "") === String(point.id) && n.presence !== "left");
    const tableObjectsHere = panelTableMap ? tableObjectsAtLocation(panelTableMap, point.id) : [];
    const directoryObjects = Array.isArray(d0?.objectDirectory) ? d0.objectDirectory : [];
    const objectById = new Map(directoryObjects.map((o) => [String(o.id ?? ""), o]));
    const hereObjects = panelTableMap
      ? tableObjectsHere.map((entry) => {
          const view = objectViewFromTableRow(entry);
          const rich = objectById.get(view.id);
          return rich ? { ...rich, ...view } : view;
        })
      : model
        // H06：SQL 口径的物品标点（与自己所在地点同坐标的物品）
        ? model.itemPins
            .filter((pin) => pin.x === atlasKnownCoordinate(point.x) && pin.y === atlasKnownCoordinate(point.y))
            .map((pin) => ({ id: String(pin.rowId), name: String(pin.name), type: "物品" }))
        : directoryObjects.filter((o) => String(o.pointId ?? "") === String(point.id));
 const canonicalTable=sqlEnabled ? (d.sqlMode===true?d.tableMap:null) : panelTableMap;
 const candidateLocations=(canonicalTable?.locationOccupants?.entries ?? model?.locations?.map(row=>({locationId:row.rowId,locationName:row.name})) ?? [])
   .filter(row=>String(row.locationId ?? '')!==String(point.rowId ?? `loc:${point.id}`));
 return {hereNpcs,hereObjects,candidateLocations,branchKey:canonicalTable?.branchKey ?? d.branchId ?? 'main'};
}

export function buildTableMapNpcIndex(d) {
  const index = new Map();
  const tableMap = d?.tableMap;
  const entries = tableMap?.nearby?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return index;
  const currentRowId = String(tableMap?.current?.locationId ?? d?.currentLocationId ?? "");
  const chainIds = new Set((tableMap?.current?.chain ?? []).map((row) => String(row.id ?? "")));
  const nearRowIds = new Set();
  for (const row of chainIds) nearRowIds.add(row);
  for (const row of entries) {
    const locationId = String(row.locationId ?? "");
    if (!locationId) continue;
    if (locationId === currentRowId || chainIds.has(locationId)) nearRowIds.add(locationId);
  }
  for (const row of entries) {
    const id = String(row.id ?? "").replace(/^npc:/, "");
    if (!id) continue;
    const locationId = row.locationId === null || row.locationId === undefined ? null : String(row.locationId);
    const pointId = locationId === null ? null : locationId.replace(/^loc:/, "");
    index.set(id, {
      id,
      name: String(row.name ?? ""),
      pointId,
      pointName: row.locationName ?? null,
      presence: row.presence,
      thought: row.thought ?? "",
      actionTendency: row.actionTendency ?? "",
      currentAction: row.currentAction ?? "",
      positionSource: row.positionSource ?? null,
      isProtagonist: row.isProtagonist === true,
      fromTables: true,
      __isNear: row.isNear === true || (row.isNear !== false && locationId !== null && nearRowIds.has(locationId)),
    });
  }
  return index;
}

/** D05：目录人物 + 三表人物合并（三表字段最后展开 —— 位置 / 在场 / 想法以三表为准）。 */
export function mergeNearbyNpc(npc, table) {
  if (!table) return npc;
  return {
    ...npc,
    ...table,
    reason: npc.reason,
    recentNarratives: npc.recentNarratives,
    isProtagonist: npc.isProtagonist === true || table.isProtagonist === true,
  };
}


export function atlasLegacyNearby(d){
const npcs = Array.isArray(d.npcDirectory) ? d.npcDirectory : [];
      // S11（0.9.55）：附近页只展示**引擎判定的相关人物**，按 relevantNpcIds 的命中顺序，
      // 不再把整张 npcDirectory 当「附近」——旧实现把远在别处的目录成员也列成附近人物。
      // 目录本身不变：非相关成员仍在地点菜单（「当前在这里」）里可查、可纠偏。
      // 主角（服务端 isProtagonist，口径同 move-author）不在附近卡片里冒充 NPC；
      // 已离场者保留展示（卡片如实标「已离场」，不伪装在场）。
      const npcById = new Map(npcs.map((n) => [String(n.id ?? ""), n]));
      /**
       * D05：有 `tableMap` 时，**人物字段以三表为准**（想法 / 行动倾向 / 在场性 / 位置来源），
       * 目录只补它独有的最近叙事与关联原因。三表里有、目录里还没有的人物也要出现
       * （本轮刚被行增量记下的人不能因为目录投影滞后而消失）；已离场者不进"附近"。
       */
      const nearbyTableEntries = buildTableMapNpcIndex(d);
      const hasTableNearby = Array.isArray(d.tableMap?.nearby?.entries);
      const relevant = (Array.isArray(d.relevantNpcIds) ? d.relevantNpcIds : [])
        .map((id) => npcById.get(String(id)))
        .filter((npc) => Boolean(npc))
        .map((npc) => mergeNearbyNpc(npc, nearbyTableEntries.get(String(npc.id ?? ""))))
        .filter((npc) => npc.isProtagonist !== true && npc.presence !== "left"
          && (!hasTableNearby || nearbyTableEntries.get(String(npc.id ?? ""))?.__isNear === true));
      // 旧相关名单可能漏掉本轮新建 / 同步的人物；同地点判断以三表投影为准，
      // 即使旧目录已经有这个 ID，也必须出现在附近页，且只出现一次。
      const displayedIds = new Set(relevant.map((npc) => String(npc.id ?? "")));
      for (const [id, view] of nearbyTableEntries) {
        if (view.presence === "left" || view.isProtagonist) continue;
        if (!view.__isNear) continue;
        if (displayedIds.has(id)) continue;
        relevant.push(mergeNearbyNpc(npcById.get(id) ?? view, view));
        displayedIds.add(id);
      }

 return {relevant,nearbyTableEntries};
}

export function atlasClockLabel(seconds,sqlMode=true){
 if(!sqlMode)return `第 ${String(seconds ?? 0)} 时段`;
 const value=Math.max(0,Math.floor(Number(seconds)||0)),days=Math.floor(value/86400),h=Math.floor(value%86400/3600),m=Math.floor(value%3600/60),sec=value%60;
 return `世界经过 ${days?`${days} 天 `:""}${h} 时 ${m} 分 ${sec} 秒`;
}
