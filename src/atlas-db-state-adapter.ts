/**
 * atlas-db-state-adapter.ts — H04 旧 UI DTO 适配器（只读，§7.2 / §11.1 / §10.4）。
 *
 * 目的：让既有渲染层（`index.js` 的 `renderMap` / `renderCenter`）在 SQL 世界数据模式下**不改字段名**
 * 就能继续工作，同时把新字段（`revision` / `positionQuality` / `coarseList` / `metadata`）一并下发。
 *
 * 纪律：
 * - **只读**：本文件不发 SQL、不写库；SQL 一律经 Repository 的 ViewResult。
 * - §11.1：旧 lib 的 500 实体上限只能是**有界投影**——超过就截断显示并报 droppedCount，
 *   **绝不删数据**，也绝不让镜像截断反过来删库（数据库行数不受本适配器影响）。
 * - 空结果必须给出空列表（UI 据此清卡片）；**绝不沿用上一次的列表**。
 * - §10.4：作者视图开关只改 UI 过滤，不改变注入范围。
 */

import type { GroupResult, Issue, TurnReceipt, ViewQuery, ViewResult } from './atlas-ops-contract.ts';
import type { PovProjection } from './atlas-db-knowledge-view.ts';

/** 旧 lib 的兼容上限（有界投影，不是数据库上限）。 */
export const LEGACY_ENTITY_CAP = 500;

export type LegacyStateOptions = {
  /** 兼容投影上限；缺省 500（§11.1）。 */
  entityLimit?: number;
};

export type LegacyAdapterMetadata = {
  kind: ViewQuery['kind'];
  branchId: string;
  revision: number;
  cap: number;
  total: number;
  returned: number;
  truncated: boolean;
  droppedCount: number;
  dropped: Record<string, number>;
  diagnostics: Issue[];
};

/* ------------------------------------------------------------------ *
 * 收窄工具（ViewResult.items 是 unknown[]，检查前表示）
 * ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return asRecord(parsed);
    } catch {
      return {};
    }
  }
  return asRecord(value);
}

function diagnostic(code: string, message: string, details: Record<string, unknown> = {}): Issue {
  return { code, path: '$.metadata', message, severity: 'warning', retryable: false, ...details };
}

/* ------------------------------------------------------------------ *
 * H04：ViewResult → 旧 /state DTO
 * ------------------------------------------------------------------ */

type Collected = {
  /** 旧 `map.points`（世界图根地点）。 */
  worldPoints: Array<Record<string, unknown>>;
  /** 旧 `tableMap.world.points`（含人物/物品标记，带 kind）。 */
  tableWorldPoints: Array<Record<string, unknown>>;
  npcs: Array<Record<string, unknown>>;
  objects: Array<Record<string, unknown>>;
  submaps: Record<string, unknown>;
  pointParents: Record<string, string>;
  calibrations: Record<string, unknown>;
  routes: Array<Record<string, unknown>>;
  coarseList: Array<Record<string, unknown>>;
  positionQuality: Record<string, string>;
  relevantNpcIds: string[];
  nearReasonCode: string | null;
  currentLocationId: string | null;
  currentTime: number;
  rootMapId: string | null;
  mapCount: number;
  entities: unknown[];
  changes: Array<Record<string, unknown>>;
  logs: unknown[];
  entity: Record<string, unknown> | null;
  simulation: Record<string, unknown> | null;
};

function emptyCollected(): Collected {
  return {
    worldPoints: [],
    tableWorldPoints: [],
    npcs: [],
    objects: [],
    submaps: {},
    pointParents: {},
    calibrations: {},
    routes: [],
    coarseList: [],
    positionQuality: {},
    relevantNpcIds: [],
    nearReasonCode: null,
    currentLocationId: null,
    currentTime: 0,
    rootMapId: null,
    mapCount: 0,
    entities: [],
    changes: [],
    logs: [],
    entity: null,
    simulation: null,
  };
}

function legacyMapPoint(point: Record<string, unknown>, kind: string): Record<string, unknown> {
  const id = str(point.entityId ?? point.id);
  return {
    id,
    name: str(point.name),
    x: num(point.x) ?? 0,
    y: num(point.y) ?? 0,
    regionId: null,
    kind,
    rowId: id,
  };
}

function legacyNpc(entry: Record<string, unknown>, quality: string): Record<string, unknown> {
  const id = str(entry.entityId ?? entry.id);
  return {
    id,
    name: str(entry.name),
    pointId: entry.locationId ? null : str(entry.mapId) || null,
    regionId: null,
    x: num(entry.x),
    y: num(entry.y),
    reason: entry.relevance === undefined ? 'sameLocation' : String(entry.relevance),
    status: null,
    presence: 'present',
    isProtagonist: false,
    lastConfirmedAt: null,
    recentNarratives: [],
    pointName: str(entry.locationName) || null,
    positionSource: 'sql',
    locationId: entry.locationId ? str(entry.locationId) : null,
    locationName: entry.locationName ? str(entry.locationName) : null,
    positionQuality: quality,
  };
}

function legacyObject(entry: Record<string, unknown>, locationName: string | null): Record<string, unknown> {
  const id = str(entry.entityId ?? entry.id);
  return {
    id,
    name: str(entry.name),
    type: 'item',
    pointId: str(entry.mapId) || null,
    regionId: null,
    x: num(entry.x),
    y: num(entry.y),
    description: null,
    pointName: locationName,
    positionQuality: str(entry.precision) || 'unknown',
  };
}

/** map / nearby / entity 三种视图共用的实体收集。 */
function collectFromView(view: ViewResult, query: ViewQuery, collected: Collected): void {
  for (const rawItem of view.items) {
    const item = asRecord(rawItem);
    if (query.kind === 'nearby') {
      const entry = legacyNpc(item, str(item.positionQuality) || 'coarse');
      collected.npcs.push(entry);
      collected.positionQuality[str(entry.id)] = str(entry.positionQuality);
      collected.relevantNpcIds.push(str(entry.id));
      continue;
    }
    if (query.kind === 'entity') {
      const kind = str(item.kind);
      if (kind === 'character') {
        collected.entities.push(item);
        collected.npcs.push(legacyNpc(item, 'coarse'));
      } else if (kind === 'location') {
        collected.entities.push(item);
        const location = asRecord(item.location);
        const position = asRecord(item.position);
        const point = {
          entityId: str(location.id),
          name: str(location.name),
          x: num(location.grid_x),
          y: num(location.grid_y),
          mapId: str(location.map_id),
          precision: str(location.coord_precision),
        };
        collected.tableWorldPoints.push(legacyMapPoint(point, 'location'));
        collected.worldPoints.push({ id: str(location.id), name: str(location.name), x: num(location.grid_x) ?? 0, y: num(location.grid_y) ?? 0, regionId: null });
        collected.positionQuality[str(location.id)] = str(position.kind ?? location.coord_precision ?? 'unknown');
      } else if (kind === 'item') {
        collected.entities.push(item);
        const row = asRecord(item.item);
        collected.objects.push(legacyObject({ entityId: str(row.id), name: str(row.name), mapId: str(row.map_id), x: num(row.grid_x), y: num(row.grid_y), precision: str(row.coord_precision) }, null));
      } else {
        collected.entities.push(item);
      }
      continue;
    }

    // kind === 'map'
    const mapId = str(item.mapId);
    const containerLocationId = item.containerLocationId === null || item.containerLocationId === undefined ? null : str(item.containerLocationId);
    if (collected.rootMapId === null && containerLocationId === null) collected.rootMapId = mapId;
    collected.mapCount += 1;
    const metersPerCell = num(item.metersPerCell);
    collected.calibrations[mapId] = {
      revision: num(item.calibrationRev) ?? 1,
      metersPerCell,
      source: 'sql',
      locked: item.scaleLocked === true,
      basis: '',
      coverage: '',
      confidence: str(item.scaleQuality) || 'uncalibrated',
      at: view.revision,
    };
    const pointsRaw = asArray(item.points).map(asRecord);
    const isRoot = containerLocationId === null;
    for (const point of pointsRaw) {
      const kind = str(point.kind) || 'location';
      const entityId = str(point.entityId);
      const legacyPoint = { id: entityId, name: str(point.name), x: num(point.x) ?? 0, y: num(point.y) ?? 0, regionId: null };
      if (kind === 'location') {
        collected.tableWorldPoints.push({ ...legacyPoint, kind, rowId: entityId });
        if (isRoot) collected.worldPoints.push(legacyPoint);
        collected.pointParents[entityId] = mapId;
      } else if (kind === 'character') {
        collected.npcs.push(
          legacyNpc(
            { entityId, name: str(point.name), mapId, x: num(point.x), y: num(point.y) },
            str(point.markerQuality ?? point.precision) || 'exact',
          ),
        );
      } else {
        collected.objects.push(legacyObject({ entityId, name: str(point.name), mapId, x: num(point.x), y: num(point.y), precision: str(point.precision) }, null));
      }
      collected.positionQuality[entityId] = str(point.markerQuality ?? point.precision) || 'unknown';
    }
    const coarse = asArray(item.coarseList).map(asRecord);
    for (const entry of coarse) {
      const entityId = str(entry.entityId);
      const record = {
        entityId,
        name: str(entry.name),
        locationId: str(entry.locationId),
        locationName: entry.locationName === null || entry.locationName === undefined ? null : str(entry.locationName),
        mapId,
      };
      collected.coarseList.push({ ...record, positionQuality: 'coarse' });
      collected.npcs.push(legacyNpc(record, 'coarse'));
      collected.positionQuality[entityId] = 'coarse';
    }
    for (const route of asArray(item.routes).map(asRecord)) {
      collected.routes.push({
        id: str(route.routeId),
        routeId: str(route.routeId),
        fromId: str(route.fromId),
        toId: str(route.toId),
        kind: str(route.kind),
        geometryQuality: str(route.geometryQuality),
        distanceM: num(route.distanceM),
        dashed: route.dashed === true,
        allowedModes: asArray(route.allowedModes).map(str),
      });
    }
    collected.submaps[mapId] = {
      mapId,
      parentMapId: containerLocationId === null ? 'world' : str(containerLocationId),
      ownerLocationId: containerLocationId,
      frame: jsonObject(item.frames ? asRecord(item.frames).frame : {}),
      scale: { metersPerCell, quality: str(item.scaleQuality) || 'uncalibrated' },
      points: pointsRaw.map((point) => legacyMapPoint(point, str(point.kind) || 'location')),
      total: pointsRaw.length,
      truncated: 0,
    };
  }
}

function collectOtherKinds(view: ViewResult, query: ViewQuery, collected: Collected): void {
  if (query.kind === 'simulation') {
    const first = asRecord(view.items[0]);
    const clockS = num(first.clockS) ?? 0;
    collected.currentTime = clockS;
    collected.simulation = {
      branchKey: view.branchId,
      clockS,
      clockMinS: num(first.clockMinS) ?? clockS,
      clockMaxS: num(first.clockMaxS) ?? clockS,
      calendarLabel: first.calendarLabel ?? null,
      simulationCursorS: num(first.simulationCursorS) ?? clockS,
      simulationStatus: str(first.simulationStatus) || 'current',
      pendingNotice: first.pendingNotice ?? null,
      branchKeySource: 'sql',
    };
    collected.entities = view.items;
  } else if (query.kind === 'changes') {
    collected.changes = view.items.map((raw) => {
      const row = asRecord(raw);
      return {
        changeId: str(row.changeId),
        turnId: str(row.turnId),
        sequence: num(row.sequence) ?? 0,
        groupId: str(row.groupId),
        operationId: str(row.operationId),
        table: str(row.table),
        rowId: str(row.rowId),
        operation: str(row.operation),
        summary: str(row.summary),
        turnKind: str(row.turnKind),
        basis: asRecord(row.basis),
      };
    });
    collected.entities = view.items;
  } else if (query.kind === 'diagnostics') {
    collected.logs = view.items;
    collected.entities = view.items;
  } else if (query.kind === 'prompt') {
    // kind='prompt' 由 atlas-db-knowledge-view 的 projectPromptView 承担（见 /sql/state）。
    collected.entities = view.items;
  }
}

function bounded<T>(rows: T[], limit: number): { kept: T[]; dropped: number } {
  if (rows.length <= limit) return { kept: rows, dropped: 0 };
  return { kept: rows.slice(0, limit), dropped: rows.length - limit };
}

/**
 * H04：把 Repository 的 map/nearby/entity/changes/diagnostics/simulation/prompt ViewResult
 * 适配成旧 UI 读取的 DTO 形状。
 *
 * 空视图 → 空列表（UI 清卡片）；超上限 → `metadata.truncated=true` + 精确 droppedCount，
 * 且**不动数据库任何一行**。
 */
export function toLegacyStateDto(
  view: ViewResult,
  query: ViewQuery,
  options: LegacyStateOptions = {},
): Record<string, unknown> {
  const limit = Math.max(1, Math.floor(options.entityLimit ?? LEGACY_ENTITY_CAP));
  const collected = emptyCollected();
  if (query.kind === 'map' || query.kind === 'nearby' || query.kind === 'entity') {
    collectFromView(view, query, collected);
  } else {
    collectOtherKinds(view, query, collected);
  }

  // §11.1：500 实体上限只影响兼容投影。按 地点 → 人物 → 物品 的稳定顺序切分，
  // 超出的部分只记 droppedCount，绝不删除数据库行。
  let remaining = limit;
  const keptPoints = bounded(collected.worldPoints, Math.max(0, remaining));
  remaining -= keptPoints.kept.length;
  const keptNpcs = bounded(collected.npcs, Math.max(0, remaining));
  remaining -= keptNpcs.kept.length;
  const keptObjects = bounded(collected.objects, Math.max(0, remaining));

  const entityTotal = collected.worldPoints.length + collected.npcs.length + collected.objects.length;
  const returned = keptPoints.kept.length + keptNpcs.kept.length + keptObjects.kept.length;
  const droppedCount = entityTotal - returned;
  const truncated = droppedCount > 0;
  const dropped = {
    locations: keptPoints.dropped,
    characters: keptNpcs.dropped,
    items: keptObjects.dropped,
  };
  const diagnostics: Issue[] = [];
  if (truncated) {
    diagnostics.push(
      diagnostic(
        'LEGACY_ENTITY_CAP_APPLIED',
        `旧 ${limit} 实体上限是有界投影：本次未显示 ${droppedCount} 行（地点 ${dropped.locations} / 人物 ${dropped.characters} / 物品 ${dropped.items}），数据库未删除任何行`,
        { droppedCount },
      ),
    );
  }

  const metadata: LegacyAdapterMetadata = {
    kind: query.kind,
    branchId: view.branchId,
    revision: view.revision,
    cap: limit,
    total: entityTotal,
    returned,
    truncated,
    droppedCount,
    dropped,
    diagnostics,
  };

  const npcTotal = collected.npcs.length;
  const objectTotal = collected.objects.length;

  return {
    // —— 旧字段名（renderMap / renderCenter 直接读）——
    chatId: null,
    worldId: null,
    worldName: null,
    branchId: view.branchId,
    branchKey: view.branchId,
    currentTime: collected.currentTime,
    currentLocationId: collected.currentLocationId,
    scene: null,
    nearbyPointIds: [],
    relevantNpcIds: collected.relevantNpcIds,
    npcReasons: {},
    triggerIds: [],
    map: {
      points: keptPoints.kept,
      pointCount: collected.worldPoints.length,
      pointParents: collected.pointParents,
      mapImagePresent: false,
      mapImageRevision: view.revision,
      pointMeta: {},
      submaps: collected.submaps,
      submapCount: Object.keys(collected.submaps).length,
      calibrations: collected.calibrations,
      routes: collected.routes,
      scaleQuality: Object.values(collected.calibrations).length > 0 ? asRecord(Object.values(collected.calibrations)[0]).confidence : 'uncalibrated',
      geoTopology: {
        branchKey: view.branchId,
        edges: [],
        areas: [],
        vehicleAnchors: [],
        counts: { edges: 0, areas: 0, vehicles: 0 },
        truncated: { edges: 0, areas: 0, vehicles: 0 },
      },
    },
    npcDirectory: keptNpcs.kept,
    regions: [],
    objectDirectory: keptObjects.kept,
    lastAdvance: null,
    directoryTotals: {
      npc: { offset: 0, limit, total: npcTotal, returned: keptNpcs.kept.length, truncated: keptNpcs.dropped },
      object: { offset: 0, limit, total: objectTotal, returned: keptObjects.kept.length, truncated: keptObjects.dropped },
      source: 'sql',
    },
    tableMap: {
      branchKey: view.branchId,
      world: {
        mapId: collected.rootMapId ?? 'world',
        points: collected.tableWorldPoints,
        total: collected.tableWorldPoints.length,
        truncated: 0,
      },
      submaps: collected.submaps,
      nearby: {
        entries: keptNpcs.kept,
        total: npcTotal,
        truncated: keptNpcs.dropped,
      },
      objects: {
        entries: keptObjects.kept,
        total: objectTotal,
        truncated: keptObjects.dropped,
      },
      unknownPosition: [],
      unplacedLocations: {
        entries: collected.coarseList.map((entry) => ({
          id: str(entry.entityId),
          name: str(entry.name),
          parentLocationId: str(entry.locationId) || null,
        })),
        total: collected.coarseList.length,
        truncated: 0,
      },
      nearReasonCode: collected.nearReasonCode,
      locationOccupants: { byLocation: {}, truncated: 0 },
      current: { locationId: collected.currentLocationId, chain: [] },
      totals: {
        locations: collected.worldPoints.length,
        characters: npcTotal,
        items: objectTotal,
        submaps: Object.keys(collected.submaps).length,
      },
      dropped: { locations: keptPoints.dropped },
    },
    simulationView: collected.simulation,
    changes: collected.changes,
    logs: collected.logs,
    entity: collected.entity,
    // —— 新字段（H12：UI 不得用缺省 0 补未知坐标）——
    revision: view.revision,
    positionQuality: collected.positionQuality,
    coarseList: collected.coarseList,
    entities: collected.entities,
    metadata,
  };
}

/* ------------------------------------------------------------------ *
 * §6.3：统一回执 → 旧回执字段
 * ------------------------------------------------------------------ */

export type LegacyReceiptOptions = {
  /** 只有宿主确认的字段才能是 true；缺省 null = 「未由宿主确认」，绝不伪造。 */
  coreSaved?: boolean | null;
};

/**
 * §6.3：内部 `partial` 不等于强迫旧接口新增枚举——适配旧接口时用 `status:'committed'`
 * 加 `rejectedGroups`、`warnings`；**零组成功且无有效时间/程序变化**才报告 `failed`。
 * 完整 `groups`/`issues` 保留在 `receipt` 字段里（新接口读它）。
 */
export function toLegacyTurnReceipt(
  receipt: TurnReceipt,
  options: LegacyReceiptOptions = {},
): Record<string, unknown> {
  const groups: GroupResult[] = Array.isArray(receipt.groups) ? receipt.groups : [];
  const issues: Issue[] = Array.isArray(receipt.issues) ? receipt.issues : [];
  const succeeded = groups.filter((group) => group.status === 'applied' || group.status === 'duplicate');
  const rejected = groups.filter((group) => group.status === 'rejected' || group.status === 'blocked');

  let status: 'committed' | 'noop' | 'failed';
  if (succeeded.length === 0 && !receipt.timeChanged && !receipt.worldChanged) {
    status = receipt.status === 'noop' ? 'noop' : 'failed';
  } else if (receipt.status === 'noop' && succeeded.length === 0) {
    status = 'noop';
  } else {
    // partial / committed / 被纠错补上的局部失败：旧接口一律 committed + rejectedGroups。
    status = 'committed';
  }

  const warnings = issues
    .filter((item) => item.severity === 'warning')
    .map((item) => ({ code: item.code, path: item.path, message: item.message, retryable: item.retryable }));

  return {
    receiptId: receipt.turnId,
    turnId: receipt.turnId,
    status,
    branchId: receipt.anchor.branchId,
    rejectedGroups: rejected.map((group) => group.groupId),
    warnings,
    coreSaved: options.coreSaved ?? null,
    previousTime: receipt.clockBeforeS,
    currentTime: receipt.clockAfterS,
    previousLocationId: null,
    currentLocationId: null,
    triggeredNpcIds: [],
    adoptedEventIds: [],
    summary: `统一回执：成功组 ${succeeded.length}，失败组 ${rejected.length}，时间 ${receipt.clockBeforeS}→${receipt.clockAfterS}`,
    retryable: rejected.length > 0,
    // 新接口读这里（完整分组与问题，不再另造一份 snake_case 回执）。
    receipt: {
      turnId: receipt.turnId,
      anchor: receipt.anchor,
      status: receipt.status,
      groups,
      issues,
      clockBeforeS: receipt.clockBeforeS,
      clockAfterS: receipt.clockAfterS,
      simulatedUntilS: receipt.simulatedUntilS,
      worldChanged: receipt.worldChanged,
      timeChanged: receipt.timeChanged,
    },
    groups,
    issues,
    groupCounts: {
      applied: groups.filter((group) => group.status === 'applied').length,
      duplicate: groups.filter((group) => group.status === 'duplicate').length,
      rejected: rejected.length,
    },
  };
}

/* ------------------------------------------------------------------ *
 * §10.4：主角视图 vs 作者视图
 * ------------------------------------------------------------------ */

export type PovStateOptions = { viewMode?: 'pov' | 'author' };

/**
 * §10.4：作者开关只改 **UI 过滤**，不改变注入范围。
 * 因此 `injectedScope` 与 `promptScope` 在两种模式下**逐字段相同**，只有 `ui` 不同；
 * 作者独有的真假/秘密只出现在 `ui.authorOnly`，不进任何注入区。
 */
export function toPovStateDto(
  projection: PovProjection,
  options: PovStateOptions = {},
): Record<string, unknown> {
  const viewMode: 'pov' | 'author' = options.viewMode === 'author' ? 'author' : 'pov';
  // 注入范围：与 viewMode 无关（同一份字段级投影）。
  const injectedScope = {
    povId: projection.povId,
    isPovRow: projection.isPovRow,
    knownFacts: projection.knownFacts,
    knownLocations: projection.knownLocations,
    knownCharacters: projection.knownCharacters,
    lastSeen: projection.lastSeen,
    boundaries: projection.boundaries,
  };
  const authorOnly = {
    truthForAuthor: projection.knownFacts.map((fact) => ({ informationId: fact.informationId, truthStatus: fact.truthForAuthor })),
    secretChannels: projection.knownChannels.filter((channel) => channel.kind === 'surveillance'),
    note: '作者视图只改 UI 过滤：以下内容不会因为切到作者图而进入正文注入范围（§10.4）',
  };
  return {
    viewMode,
    revision: null,
    injectedScope,
    promptScope: [...projection.boundaries],
    knownFacts: projection.knownFacts,
    knownLocations: projection.knownLocations,
    knownCharacters: projection.knownCharacters,
    lastSeen: projection.lastSeen,
    ui: {
      viewMode,
      filter: viewMode === 'author' ? 'author' : 'pov',
      showAuthorTruth: viewMode === 'author',
      showSecretChannels: viewMode === 'author',
      showHiddenThoughts: viewMode === 'author',
      // 只影响显示；注入用上面的 injectedScope。
      displayOnly: true,
      authorOnly,
    },
    injectionUnchangedByViewMode: true,
  };
}
