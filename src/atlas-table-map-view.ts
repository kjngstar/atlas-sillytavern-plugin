/**
 * atlas-table-map-view.ts — D01：三表 → 地图视图的**唯一投影口径**（纯函数，零 IO）。
 *
 * 计划 §3-D01 规定：
 * - 根地点（`parentLocationId = null`）显示在世界图；任意有父的地点进**父地点的子图**；
 * - 人物与物品按 `mapId` + 格序号投影；同地点但无细坐标的归入「建筑内位置未知」名单；
 * - 「附近」目录与地图**取自同一张人物表**（不再有第二份运行时视图）；
 * - 分页/截断必须显式：返回 `total` 与 `truncated`，绝不静默 `slice`（旧实现静默裁 48/32）。
 *
 * 坐标口径（与 A03/A04/D-03 一致）：世界图的 x/y = 格序号；子图内的 x/y = 该子图自己的
 * 0..100 布局空间。**ID 口径**：对 UI 暴露的是旧世界数字点 id（`loc:<n>` → `"<n>"`），
 * 与 `world.points[].id` 及既有 `map.points/submaps` 字段完全对齐。
 */

import type { World } from "../lib/world-schema.ts";
import type { AtlasMapDoc } from "./atlas-geo-apply.ts";
import { SUBMAP_FRAME_DEFAULT, type SubMapFrame } from "./atlas-geo-apply.ts";
import {
  ATLAS_ITEM_DESTROYED_STATUS,
  pointIdFromLocationRowId,
  type AtlasCharacterRow,
  type AtlasLocationRow,
  type AtlasThreeTablesV1,
} from "./atlas-tables.ts";

/** D01 输出的上限：超过就给 total/truncated，让调用方分页，不静默裁。 */
export const ATLAS_MAP_VIEW_LIMITS = {
  pointsPerMap: 200,
  submaps: 40,
  nearby: 48,
  objects: 32,
} as const;

export interface AtlasMapViewPoint {
  /** 旧世界数字点 id（字符串），与既有 UI 字段一致。 */
  id: string;
  name: string;
  x: number;
  y: number;
  regionId: string | null;
  kind: "location" | "character" | "item";
  /** 该标记来自哪张表行（回执 / 排障用）。 */
  rowId: string;
}

export interface AtlasMapViewSubmap {
  /** 宿主地点的数字点 id。 */
  mapId: string;
  parentMapId: string;
  frame: SubMapFrame;
  points: AtlasMapViewPoint[];
  total: number;
  truncated: number;
}

export interface AtlasMapViewUnknownPosition {
  locationId: string;
  locationName: string;
  characters: Array<{ id: string; name: string; presence: AtlasCharacterRow["presence"] }>;
  items: Array<{ id: string; name: string; status: string }>;
}

export interface AtlasMapViewNpc {
  id: string;
  name: string;
  locationId: string | null;
  locationName: string | null;
  presence: AtlasCharacterRow["presence"];
  thought: string;
  actionTendency: string;
  currentAction: string;
  isProtagonist: boolean;
  /** 有细坐标时才给（否则 UI 只列名单，不画点）。 */
  gridX: number | null;
  gridY: number | null;
  mapId: string | null;
}

export interface AtlasMapViewObject {
  id: string;
  name: string;
  description: string;
  status: string;
  locationId: string | null;
  locationName: string | null;
  holderCharacterId: string | null;
  holderName: string | null;
  mapId: string | null;
  gridX: number | null;
  gridY: number | null;
}

export interface AtlasTableMapView {
  world: { mapId: "world"; points: AtlasMapViewPoint[]; total: number; truncated: number };
  submaps: Record<string, AtlasMapViewSubmap>;
  /** 有地点但缺细坐标的实体：只列名单，不画点（§1「不得捏造房间坐标」）。 */
  unknownPosition: AtlasMapViewUnknownPosition[];
  nearby: { entries: AtlasMapViewNpc[]; total: number; truncated: number };
  objects: { entries: AtlasMapViewObject[]; total: number; truncated: number };
  current: { locationId: string | null; chain: Array<{ id: string; name: string }> };
  totals: { locations: number; characters: number; items: number; submaps: number };
  /** 未投影进任何地图的行数（id 非数字 / 父不可达等），必须让调用方看得见。 */
  dropped: { locations: number };
}

function isGrid(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function regionOfPoint(world: World, pointId: string): string | null {
  const point = (world.points ?? []).find((item) => String(item.id) === pointId);
  return point?.regionId ?? null;
}

/** D01 主投影：`tables` 是实体现值的唯一来源，`world` 只用来补地区归属与主角判定。 */
export function projectTablesToMapView(
  tables: AtlasThreeTablesV1,
  maps: AtlasMapDoc | null,
  world: World,
  currentLocationId: string | null,
  /**
   * E04a：既不显示为真实地点的旧点 id（场景 sidecar 的 `retiredPointIds` 与「起点」占位）。
   * 旧字段路径（`map.points`）一直按这个口径过滤；三表投影若不过滤，同一张图上
   * 「已退役的起点」会从 `tableMap` 通道重新冒出来冒充地理事实。
   */
  hiddenLocationIds: ReadonlySet<string> = new Set<string>(),
): AtlasTableMapView {
  const byRowId = new Map(tables.locations.map((row) => [row.id, row]));
  const protagonistIds = new Set(
    (world.characters ?? [])
      .filter((character) => String(character.role ?? "").toLowerCase().includes("主角") || character.tags?.includes("主角"))
      .map((character) => String(character.id)),
  );

  // 1) 地点 → 世界图 / 父图
  const worldPoints: AtlasMapViewPoint[] = [];
  const submapBuckets = new Map<string, AtlasMapViewPoint[]>();
  let droppedLocations = 0;
  let rootTotal = 0;
  for (const row of tables.locations) {
    const pointId = pointIdFromLocationRowId(row.id);
    if (pointId === null) {
      droppedLocations += 1;
      continue;
    }
    // E04a：已退役的「起点」占位不是地理事实——不进世界图、也不当子图宿主
    if (hiddenLocationIds.has(String(pointId))) continue;
    const parent = row.parentLocationId === null ? null : byRowId.get(row.parentLocationId) ?? null;
    if (row.parentLocationId !== null && parent === null) {
      droppedLocations += 1;
      continue;
    }
    const view: AtlasMapViewPoint = {
      id: String(pointId),
      name: row.name,
      x: row.gridX ?? 0,
      y: row.gridY ?? 0,
      regionId: regionOfPoint(world, String(pointId)),
      kind: "location",
      rowId: row.id,
    };
    if (parent === null) {
      rootTotal += 1;
      if (worldPoints.length < ATLAS_MAP_VIEW_LIMITS.pointsPerMap) worldPoints.push(view);
      continue;
    }
    const bucket = submapBuckets.get(parent.id) ?? [];
    bucket.push(view);
    submapBuckets.set(parent.id, bucket);
  }

  // 2) 人物 / 物品标记（有细坐标才画点；持有物不地面化）
  const unknownPosition = new Map<string, AtlasMapViewUnknownPosition>();
  const unknownBucket = (row: AtlasLocationRow): AtlasMapViewUnknownPosition => {
    const existing = unknownPosition.get(row.id);
    if (existing) return existing;
    const created: AtlasMapViewUnknownPosition = { locationId: row.id, locationName: row.name, characters: [], items: [] };
    unknownPosition.set(row.id, created);
    return created;
  };

  const placeMarker = (
    mapId: string | null,
    gridX: number | null,
    gridY: number | null,
    factory: (x: number, y: number) => AtlasMapViewPoint,
  ): boolean => {
    if (mapId === null || !isGrid(gridX) || !isGrid(gridY)) return false;
    const point = factory(gridX, gridY);
    if (mapId === "world") {
      if (worldPoints.length < ATLAS_MAP_VIEW_LIMITS.pointsPerMap) worldPoints.push(point);
      return true;
    }
    const mapRow = byRowId.get(mapId);
    if (!mapRow) return false;
    const bucket = submapBuckets.get(mapRow.id) ?? [];
    bucket.push(point);
    submapBuckets.set(mapRow.id, bucket);
    return true;
  };

  const visibleLocationIds = new Set(tables.locations.map((row) => row.id));
  for (const row of tables.characters) {
    const characterId = row.id.startsWith("npc:") ? row.id.slice(4) : row.id;
    const placed = placeMarker(row.mapId, row.gridX, row.gridY, (x, y) => ({
      id: `npc:${characterId}`,
      name: row.name,
      x,
      y,
      regionId: null,
      kind: "character",
      rowId: row.id,
    }));
    if (!placed && row.locationId !== null) {
      const location = byRowId.get(row.locationId);
      // 藏在已退役地点里的实体不进"位置未知"名单：那里根本不是地理事实
      if (location && !hiddenLocationIds.has(String(pointIdFromLocationRowId(location.id) ?? ""))) {
        unknownBucket(location).characters.push({ id: characterId, name: row.name, presence: row.presence });
      }
    }
  }
  for (const row of tables.items) {
    if (row.status === ATLAS_ITEM_DESTROYED_STATUS || row.holderCharacterId !== null) continue; // 持有物与已销毁物不落地
    const placed = placeMarker(row.mapId, row.gridX, row.gridY, (x, y) => ({
      id: row.id,
      name: row.name,
      x,
      y,
      regionId: null,
      kind: "item",
      rowId: row.id,
    }));
    if (!placed && row.locationId !== null) {
      const location = byRowId.get(row.locationId);
      if (location && !hiddenLocationIds.has(String(pointIdFromLocationRowId(location.id) ?? ""))) {
        unknownBucket(location).items.push({ id: row.id, name: row.name, status: row.status });
      }
    }
  }

  // 3) 子图（超过上限的按 total/truncated 报，不静默丢）
  const submapKeys = [...submapBuckets.keys()]
    .filter((key) => visibleLocationIds.has(key))
    .sort((a, b) => {
      const left = pointIdFromLocationRowId(a) ?? 0;
      const right = pointIdFromLocationRowId(b) ?? 0;
      return left - right;
    });
  const submaps: Record<string, AtlasMapViewSubmap> = {};
  let submapTotal = 0;
  for (const key of submapKeys) {
    const row = byRowId.get(key)!;
    const points = submapBuckets.get(key) ?? [];
    submapTotal += 1;
    if (Object.keys(submaps).length >= ATLAS_MAP_VIEW_LIMITS.submaps) continue;
    const mapKey = String(pointIdFromLocationRowId(key) ?? key);
    submaps[mapKey] = {
      mapId: mapKey,
      parentMapId: row.parentLocationId === null
        ? "world"
        : String(pointIdFromLocationRowId(row.parentLocationId) ?? "world"),
      frame: maps?.submaps?.[mapKey]?.frame ?? { ...SUBMAP_FRAME_DEFAULT },
      points: points.slice(0, ATLAS_MAP_VIEW_LIMITS.pointsPerMap),
      total: points.length,
      truncated: Math.max(0, points.length - ATLAS_MAP_VIEW_LIMITS.pointsPerMap),
    };
  }

  // 4) 附近目录与物品目录：与地图同一张人物表 / 物品表
  const currentRow = currentLocationId === null
    ? null
    : byRowId.get(currentLocationId.startsWith("loc:") ? currentLocationId : `loc:${currentLocationId}`) ?? null;
  const nearIds = new Set<string>();
  if (currentRow) {
    nearIds.add(currentRow.id);
    for (const row of tables.locations) {
      if (row.id === currentRow.id) continue;
      // 子地点永远算「身边」（你在里面）；同父兄弟只在**当前就在某个内层地点**时才算
      // ——根地点之间是世界图上的两座城，不能互相冒充「附近」。
      if (row.parentLocationId === currentRow.id) nearIds.add(row.id);
      else if (currentRow.parentLocationId !== null && row.parentLocationId === currentRow.parentLocationId) nearIds.add(row.id);
    }
  }
  const nearbyEntries: AtlasMapViewNpc[] = tables.characters
    .filter((row) => row.presence !== "left")
    .map((row) => ({
      id: row.id.startsWith("npc:") ? row.id.slice(4) : row.id,
      name: row.name,
      locationId: row.locationId,
      locationName: row.locationId === null ? null : byRowId.get(row.locationId)?.name ?? null,
      presence: row.presence,
      thought: row.thought,
      actionTendency: row.actionTendency,
      currentAction: row.currentAction,
      isProtagonist: protagonistIds.has(row.id.startsWith("npc:") ? row.id.slice(4) : row.id),
      gridX: row.gridX,
      gridY: row.gridY,
      mapId: row.mapId,
    }))
    .sort((left, right) => {
      const leftNear = left.locationId !== null && nearIds.has(left.locationId) ? 0 : 1;
      const rightNear = right.locationId !== null && nearIds.has(right.locationId) ? 0 : 1;
      if (leftNear !== rightNear) return leftNear - rightNear;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });

  const characterNameById = new Map(tables.characters.map((row) => [row.id, row.name]));
  const objectEntries: AtlasMapViewObject[] = tables.items
    .filter((row) => row.status !== ATLAS_ITEM_DESTROYED_STATUS)
    .map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      locationId: row.locationId,
      locationName: row.locationId === null ? null : byRowId.get(row.locationId)?.name ?? null,
      holderCharacterId: row.holderCharacterId,
      holderName: row.holderCharacterId === null ? null : characterNameById.get(row.holderCharacterId) ?? null,
      mapId: row.mapId,
      gridX: row.gridX,
      gridY: row.gridY,
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  // 5) 当前位置链（含自身；父不可达就断在那里，不猜）
  const chain: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  let cursor: AtlasLocationRow | null = currentRow;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.unshift({ id: cursor.id, name: cursor.name });
    cursor = cursor.parentLocationId === null ? null : byRowId.get(cursor.parentLocationId) ?? null;
  }

  return {
    world: {
      mapId: "world",
      points: worldPoints,
      total: rootTotal,
      truncated: Math.max(0, rootTotal - worldPoints.length),
    },
    submaps,
    unknownPosition: [...unknownPosition.values()].sort((left, right) => (left.locationId < right.locationId ? -1 : 1)),
    nearby: {
      entries: nearbyEntries.slice(0, ATLAS_MAP_VIEW_LIMITS.nearby),
      total: nearbyEntries.length,
      truncated: Math.max(0, nearbyEntries.length - ATLAS_MAP_VIEW_LIMITS.nearby),
    },
    objects: {
      entries: objectEntries.slice(0, ATLAS_MAP_VIEW_LIMITS.objects),
      total: objectEntries.length,
      truncated: Math.max(0, objectEntries.length - ATLAS_MAP_VIEW_LIMITS.objects),
    },
    current: { locationId: currentRow?.id ?? null, chain },
    totals: {
      locations: tables.locations.length,
      characters: tables.characters.length,
      items: tables.items.length,
      submaps: submapTotal,
    },
    dropped: { locations: droppedLocations },
  };
}
