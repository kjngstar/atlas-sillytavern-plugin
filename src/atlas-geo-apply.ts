/**
 * atlas-geo-apply.ts — 0.9.31 每轮新地点确定性并入（纯函数）。
 *
 * 作者需求：每轮推演时判断有没有新地点加入。账本 effect 白名单（lib/ 快照）没有
 * addPoint/addRegion，推演不能造点——本模块把模型在本轮 JSON 里顺带输出的
 * newLocations（{name, regionName?, description?}）在 commit 时直接并入世界：
 * 与 /worlds/geo/adopt 同款口径——重名跳过、黄金角螺旋布点、只增不改、定义修订。
 * 不发任何请求：地名来自推演 JSON，归属与坐标全部本地确定性计算。
 */

import type { World } from "../lib/world-schema.ts";
import { appendDefinitionRevision } from "../lib/world-definition.ts";
import { hashString } from "../lib/world-cards.ts";
import { sanitizeCalibration, type MapScaleCalibration } from "./atlas-scale.ts";

/** 单轮新地点上限（与 geo 提炼口径一致：宁缺毋滥）。 */
export const NEW_LOCATIONS_MAX = 12;
const NAME_CHARS = 40;
const DESC_CHARS = 300;
/** 子图内点数上限（一层内部结构足够；递归深度由点挂点自然形成）。 */
export const SUBMAP_POINTS_MAX = 40;

/** 子图比例尺（可选；不标定就保持「格程」诚实表达）。 */
export interface SubMapScale {
  distancePerCell: number;
  unit?: string;
}

/** 点挂子图（0.9.32）：与父图同构——网格 + 标记点 + 可选比例尺；递归结构。 */
export interface SubMapDraft {
  scale?: SubMapScale;
  points: Array<{ name: string; description?: string }>;
}

export interface NewLocationDraft {
  name: string;
  regionName?: string;
  description?: string;
  submap?: SubMapDraft;
}

export interface CreatedPoint {
  id: number;
  name: string;
  description?: string;
  submap?: SubMapDraft;
}

export interface GeoAdoptOutcome {
  world: World;
  regionsAdded: number;
  pointsAdded: number;
  skipped: number;
  regionNames: string[];
  pointNames: string[];
  revisionAppended: boolean;
  /** 0.9.32 本次实际创建的地点（含带 submap 的），供 sidecar 子图落库 */
  createdPoints: CreatedPoint[];
}

/** 子图清洗（不可信）：点名单必须；比例尺数字必须为正；超界丢弃 / 截断。 */
function sanitizeSubMap(raw: unknown): SubMapDraft | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  let scale: SubMapScale | undefined;
  const scaleRaw = record.scale;
  if (scaleRaw && typeof scaleRaw === "object" && !Array.isArray(scaleRaw)) {
    const distance = Number((scaleRaw as Record<string, unknown>).distancePerCell);
    if (Number.isFinite(distance) && distance > 0) {
      const unit = String((scaleRaw as Record<string, unknown>).unit ?? "").trim().slice(0, 12);
      scale = { distancePerCell: Math.round(distance * 100) / 100, ...(unit ? { unit } : {}) };
    }
  }
  const rawPoints = Array.isArray(record.points) ? record.points : [];
  const points: Array<{ name: string; description?: string }> = [];
  for (const item of rawPoints.slice(0, SUBMAP_POINTS_MAX * 2)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const name = String((item as Record<string, unknown>).name ?? "").trim().replace(/\s+/g, " ").slice(0, NAME_CHARS);
    if (!name) continue;
    const description = String((item as Record<string, unknown>).description ?? "").trim().replace(/\s+/g, " ").slice(0, DESC_CHARS);
    points.push({ name, ...(description ? { description } : {}) });
    if (points.length >= SUBMAP_POINTS_MAX) break;
  }
  if (points.length === 0) return undefined;
  return { ...(scale ? { scale } : {}), points };
}

/** 不可信 newLocations 清洗：坏条目丢弃（name 必填；字段截断；条目封顶）。 */
export function sanitizeNewLocations(raw: unknown): NewLocationDraft[] {
  if (!Array.isArray(raw)) return [];
  const result: NewLocationDraft[] = [];
  for (const item of raw.slice(0, NEW_LOCATIONS_MAX * 2)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const name = String(record.name ?? "").trim().replace(/\s+/g, " ").slice(0, NAME_CHARS);
    if (!name) continue;
    const regionName = String(record.regionName ?? "").trim().replace(/\s+/g, " ").slice(0, NAME_CHARS);
    const description = String(record.description ?? "").trim().replace(/\s+/g, " ").slice(0, DESC_CHARS);
    const submap = sanitizeSubMap(record.submap);
    result.push({
      name,
      ...(regionName ? { regionName } : {}),
      ...(description ? { description } : {}),
      ...(submap ? { submap } : {}),
    });
    if (result.length >= NEW_LOCATIONS_MAX) break;
  }
  return result;
}

/**
 * 把新地点 / 新地区并入世界（/worlds/geo/adopt 同款口径）：
 * 重名跳过；regionName 解析不到已有地区 → 归入起始地区（与 geo 提炼一致）；
 * 黄金角螺旋布点绕中心散开，绝不与已有点重叠；成功后追加定义修订。
 * 没有新增 → 原世界原样返回（零写入）。
 */
export function applyNewLocations(
  world: World,
  locations: NewLocationDraft[],
  options: { now: number },
): GeoAdoptOutcome {
  const empty: GeoAdoptOutcome = {
    world,
    regionsAdded: 0,
    pointsAdded: 0,
    skipped: 0,
    regionNames: [],
    pointNames: [],
    revisionAppended: false,
    createdPoints: [],
  };
  if (!Array.isArray(locations) || locations.length === 0) return empty;

  const clean = (text: unknown): string => String(text ?? "").trim().replace(/\s+/g, " ");
  const norm = (text: string) => text.toLowerCase();

  const existingRegionNames = new Set((world.regions ?? []).map((r) => norm(clean(r.name))));
  const existingPointNames = new Set((world.points ?? []).map((p) => norm(clean(p.name))));
  const regionIdByName = new Map((world.regions ?? []).map((r) => [norm(clean(r.name)), String(r.id)]));

  let skipped = 0;
  const newRegions: Array<{ id: string; worldId: string; name: string; type: "other"; description: string; coordinates: { x: number; y: number } }> = [];
  for (const item of locations) {
    if (newRegions.length >= 6) break; // 单轮地区上限（地点为主，地区少量）
    if (existingRegionNames.has(norm(item.name))) {
      skipped += 1;
      continue;
    }
    const id = `turn-r-${hashString(`${world.id}|r|${item.name}|${options.now}`)}`;
    newRegions.push({
      id,
      worldId: world.id,
      name: item.name,
      type: "other",
      description: item.description || "由剧情推演提炼。",
      coordinates: { x: 0, y: 0 },
    });
    existingRegionNames.add(norm(item.name));
    regionIdByName.set(norm(item.name), id);
  }

  const nextPointIdBase = (world.points ?? []).reduce((max, p) => Math.max(max, Number(p.id) || 0), 0) + 1;
  const newPoints: Array<{ id: number; name: string; x: number; y: number; regionId?: string }> = [];
  for (const item of locations) {
    if (newPoints.length >= NEW_LOCATIONS_MAX) break;
    if (existingPointNames.has(norm(item.name))) {
      skipped += 1;
      continue;
    }
    const regionId = (item.regionName ? regionIdByName.get(norm(item.regionName)) : null) ?? "start";
    const index = newPoints.length;
    const angle = index * 2.39996;
    const radius = 14 + 3.4 * Math.sqrt(index + 1);
    newPoints.push({
      id: nextPointIdBase + newPoints.length,
      name: item.name,
      x: Math.round(Math.min(96, Math.max(4, 50 + radius * Math.cos(angle)))),
      y: Math.round(Math.min(96, Math.max(4, 50 + radius * Math.sin(angle)))),
      regionId,
    });
    existingPointNames.add(norm(item.name));
  }

  if (newRegions.length === 0 && newPoints.length === 0) {
    return { ...empty, skipped };
  }

  let updated: World = {
    ...world,
    regions: [...(world.regions ?? []), ...newRegions],
    points: [...(world.points ?? []), ...newPoints],
    updatedAt: options.now,
  };
  const revision = appendDefinitionRevision(updated, {
    authorNote: `剧情推演新地点：+${newRegions.length} 地区 +${newPoints.length} 地点`,
    now: options.now,
  });
  if (revision.ok) updated = revision.value;

  // createdPoints：本次真实创建的地点（name → id），带 submap / description 的交给 sidecar 落库
  const createdPoints: CreatedPoint[] = newPoints.map((p) => {
    const source = locations.find((item) => norm(item.name) === norm(p.name));
    return {
      id: p.id,
      name: p.name,
      ...(source?.description ? { description: source.description } : {}),
      ...(source?.submap ? { submap: source.submap } : {}),
    };
  });

  return {
    world: updated,
    regionsAdded: newRegions.length,
    pointsAdded: newPoints.length,
    skipped,
    regionNames: newRegions.map((r) => r.name),
    pointNames: newPoints.map((p) => p.name),
    revisionAppended: revision.ok,
    createdPoints,
  };
}

// ---------------------------------------------------------------------------
// 0.9.32 子图 sidecar 文档（maps:<worldId>；lib/ 点位 schema 不动，子图存独立文档）
// ---------------------------------------------------------------------------

export interface SubMapPoint {
  id: string;
  name: string;
  x: number;
  y: number;
  description?: string;
}

/** 子图：与父图同构——网格 + 标记点 + 可选比例尺。 */
export interface SubMap {
  scale?: SubMapScale;
  points: SubMapPoint[];
}

/**
 * 地图 sidecar 文档：点位描述 + 点挂子图（pointId 键）+ 地图尺度标定（0.9.50）。
 * schemaVersion 2：+calibrations（键 = mapId：世界图 "world"、子图 = 宿主点位 id）。
 * 0.9.50 起sanitizeMapDoc 同时接受 v1（缺 calibrations 视为空）与 v2。
 */
export interface AtlasMapDoc {
  schemaVersion: 2;
  pointMeta: Record<string, { description?: string }>;
  submaps: Record<string, SubMap>;
  calibrations: Record<string, MapScaleCalibration>;
}

export function emptyMapDoc(): AtlasMapDoc {
  return { schemaVersion: 2, pointMeta: {}, submaps: {}, calibrations: {} };
}

/** sidecar 文档形状不可信（兼容旧 / 手改）：宽容清洗，绝不炸面板。 */
export function sanitizeMapDoc(raw: unknown): AtlasMapDoc {
  const doc = emptyMapDoc();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return doc;
  const record = raw as Record<string, unknown>;
  const meta = record.pointMeta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    for (const [key, value] of Object.entries(meta as Record<string, unknown>).slice(0, 120)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const description = String((value as Record<string, unknown>).description ?? "").trim().slice(0, 300);
      if (description) doc.pointMeta[key] = { description };
    }
  }
  const submaps = record.submaps;
  if (submaps && typeof submaps === "object" && !Array.isArray(submaps)) {
    for (const [key, value] of Object.entries(submaps as Record<string, unknown>).slice(0, 60)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const subRecord = value as Record<string, unknown>;
      let scale: SubMapScale | undefined;
      const scaleRaw = subRecord.scale;
      if (scaleRaw && typeof scaleRaw === "object" && !Array.isArray(scaleRaw)) {
        const distance = Number((scaleRaw as Record<string, unknown>).distancePerCell);
        if (Number.isFinite(distance) && distance > 0) {
          const unit = String((scaleRaw as Record<string, unknown>).unit ?? "").trim().slice(0, 12);
          scale = { distancePerCell: Math.round(distance * 100) / 100, ...(unit ? { unit } : {}) };
        }
      }
      const points: SubMapPoint[] = [];
      if (Array.isArray(subRecord.points)) {
        for (const item of subRecord.points.slice(0, SUBMAP_POINTS_MAX)) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const pointRecord = item as Record<string, unknown>;
          const name = String(pointRecord.name ?? "").trim().slice(0, NAME_CHARS);
          const x = Number(pointRecord.x);
          const y = Number(pointRecord.y);
          if (!name || !Number.isFinite(x) || !Number.isFinite(y)) continue;
          const description = String(pointRecord.description ?? "").trim().slice(0, 300);
          points.push({
            id: String(pointRecord.id ?? `${key}-${points.length + 1}`).slice(0, 64),
            name,
            x: Math.round(x),
            y: Math.round(y),
            ...(description ? { description } : {}),
          });
        }
      }
      if (points.length > 0) doc.submaps[key] = { ...(scale ? { scale } : {}), points };
    }
  }
  // 0.9.50 标定清洗：每格距离必须正有限；来源白名单外按 legacy 处理；封顶 40 张图
  const calibrations = record.calibrations;
  if (calibrations && typeof calibrations === "object" && !Array.isArray(calibrations)) {
    for (const [key, value] of Object.entries(calibrations as Record<string, unknown>).slice(0, 40)) {
      const calibration = sanitizeCalibration(value);
      if (calibration) doc.calibrations[key] = calibration;
    }
  }
  return doc;
}

/** 从子图草稿构建 SubMap：黄金角螺旋布点（子图自己的 0-100 网格），id 确定性派生。 */
export function buildSubMapFromDraft(
  draft: SubMapDraft,
  context: { worldId: string; pointId: string; now: number },
): SubMap {
  const points: SubMapPoint[] = [];
  for (const item of draft.points.slice(0, SUBMAP_POINTS_MAX)) {
    const index = points.length;
    const angle = index * 2.39996;
    const radius = index === 0 ? 0 : 12 + 3.2 * Math.sqrt(index);
    const x = Math.round(Math.min(96, Math.max(4, 50 + radius * Math.cos(angle))));
    const y = Math.round(Math.min(96, Math.max(4, 50 + radius * Math.sin(angle))));
    points.push({
      id: `sub-${hashString(`${context.worldId}|${context.pointId}|${item.name}|${context.now}`)}-${index}`,
      name: item.name,
      x,
      y,
      ...(item.description ? { description: item.description } : {}),
    });
  }
  return { ...(draft.scale ? { scale: draft.scale } : {}), points };
}
