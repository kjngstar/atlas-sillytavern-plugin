/**
 * atlas-geo-apply.ts — 0.9.31 每轮新地点确定性并入（纯函数）。
 *
 * 作者需求：每轮推演时判断有没有新地点加入。账本 effect 白名单（lib/ 快照）没有
 * addPoint/addRegion，推演不能造点——本模块把模型在本轮 JSON 里顺带输出的
 * newLocations（{name, regionName?, description?}）在 commit 时直接并入世界：
 * 与 /worlds/geo/adopt 同款口径——重名跳过、黄金角螺旋布点、只增不改、定义修订。
 * 不发任何请求：地名来自推演 JSON，归属与坐标全部本地确定性计算。
 */

import type { MapPoint, World } from "../lib/world-schema.ts";
import { appendDefinitionRevision } from "../lib/world-definition.ts";
import { hashString } from "../lib/world-cards.ts";
import { roundPositiveScale, sanitizeCalibration, type MapScaleCalibration } from "./atlas-scale.ts";

/** 单轮新地点上限（与 geo 提炼口径一致：宁缺毋滥）。 */
export const NEW_LOCATIONS_MAX = 12;
const NAME_CHARS = 40;
const DESC_CHARS = 300;
/** 子图内点数上限（一层内部结构足够；递归深度由点挂点自然形成）。 */
export const SUBMAP_POINTS_MAX = 40;
/** R09：子图最大递归层级（世界→建筑→房间→细节）。超过的 parentLocationRef 不再下钻，记 warning。 */
export const SUBMAP_DEPTH_MAX = 4;

/** 子图比例尺（可选；不标定就保持「格程」诚实表达）。 */
export interface SubMapScale {
  distancePerCell: number;
  unit?: string;
}

/**
 * R09：子图 frame——持久化 cols/rows/frameRevision，让 v2 mapScaleHints 校验真正生效。
 * 旧子图（0.9.50 及之前）无 frame 字段：sanitizeMapDoc 兜底默认 100×100。
 */
export interface SubMapFrame {
  cols: number;
  rows: number;
  frameRevision: number;
}

/** 子图 frame 默认值（0.9.51 兼容档）。 */
export const SUBMAP_FRAME_DEFAULT: SubMapFrame = { cols: 100, rows: 100, frameRevision: 1 };

/** 返回一张子图的父链深度；循环或超限时拒绝。旧图缺 parentMapId 视为世界图子图。 */
export function validateSubmapDepth(doc: AtlasMapDoc, pointId: string): { ok: boolean; depth: number; maxReached: boolean } {
  const seen = new Set<string>();
  let depth = 0;
  let current = pointId;
  while (doc.submaps[current]) {
    if (seen.has(current)) return { ok: false, depth, maxReached: depth >= SUBMAP_DEPTH_MAX };
    seen.add(current);
    depth += 1;
    if (depth > SUBMAP_DEPTH_MAX) return { ok: false, depth, maxReached: true };
    const parent = doc.submaps[current].parentMapId ?? "world";
    if (parent === "world") break;
    if (!doc.submaps[parent]) return { ok: false, depth, maxReached: false };
    current = parent;
  }
  return { ok: true, depth, maxReached: false };
}

/** 点挂子图（0.9.32）：与父图同构——网格 + 标记点 + 可选比例尺；递归结构。 */
export interface SubMapDraft {
  scale?: SubMapScale;
  /** R09：可选 frame；缺省 = 100×100 default。 */
  frame?: SubMapFrame;
  points: Array<{ name: string; description?: string; submap?: SubMapDraft }>;
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

/** 子图清洗（不可信）：点名单必须；比例尺数字必须为正；frame cols/rows 走宽容默认。 */
export function sanitizeSubMap(raw: unknown, depth = 1): SubMapDraft | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  let scale: SubMapScale | undefined;
  const scaleRaw = record.scale;
  if (scaleRaw && typeof scaleRaw === "object" && !Array.isArray(scaleRaw)) {
    const distance = Number((scaleRaw as Record<string, unknown>).distancePerCell);
    if (Number.isFinite(distance) && distance > 0) {
      const unit = String((scaleRaw as Record<string, unknown>).unit ?? "").trim().slice(0, 12);
      scale = { distancePerCell: roundPositiveScale(distance), ...(unit ? { unit } : {}) };
    }
  }
  // R09：frame 清洗——cols/rows 正整数，frameRevision 非负整数；坏值丢弃走默认。
  let frame: SubMapFrame | undefined;
  const frameRaw = record.frame;
  if (frameRaw && typeof frameRaw === "object" && !Array.isArray(frameRaw)) {
    const colsRaw = (frameRaw as Record<string, unknown>).cols;
    const rowsRaw = (frameRaw as Record<string, unknown>).rows;
    const revisionRaw = (frameRaw as Record<string, unknown>).frameRevision;
    // 严格 number 类型：拒绝字符串 / null / boolean 伪数字
    if (typeof colsRaw === "number" && typeof rowsRaw === "number" && typeof revisionRaw === "number"
        && Number.isFinite(colsRaw) && colsRaw > 0 && colsRaw <= 10000
        && Number.isFinite(rowsRaw) && rowsRaw > 0 && rowsRaw <= 10000
        && Number.isFinite(revisionRaw) && revisionRaw >= 0 && revisionRaw <= 1000000) {
      frame = { cols: Math.floor(colsRaw), rows: Math.floor(rowsRaw), frameRevision: Math.floor(revisionRaw) };
    }
  }
  const rawPoints = Array.isArray(record.points) ? record.points : [];
  const points: Array<{ name: string; description?: string }> = [];
  for (const item of rawPoints.slice(0, SUBMAP_POINTS_MAX * 2)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const name = String((item as Record<string, unknown>).name ?? "").trim().replace(/\s+/g, " ").slice(0, NAME_CHARS);
    if (!name) continue;
    const description = String((item as Record<string, unknown>).description ?? "").trim().replace(/\s+/g, " ").slice(0, DESC_CHARS);
    const child = depth < SUBMAP_DEPTH_MAX
      ? sanitizeSubMap((item as Record<string, unknown>).submap, depth + 1)
      : undefined;
    points.push({ name, ...(description ? { description } : {}), ...(child ? { submap: child } : {}) });
    if (points.length >= SUBMAP_POINTS_MAX) break;
  }
  if (points.length === 0) return undefined;
  return { ...(scale ? { scale } : {}), ...(frame ? { frame } : {}), points };
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

/** 子图：与父图同构——网格 + 标记点 + 可选比例尺 + R09 frame 字段。 */
export interface SubMap {
  /** world for direct submaps; otherwise the parent submap key. */
  parentMapId?: string;
  /** Point ID in the parent map that owns this submap. */
  ownerLocationId?: string;
  scale?: SubMapScale;
  /** R09：子图 frame（cols/rows/frameRevision）。sanitize 缺省 = SUBMAP_FRAME_DEFAULT。 */
  frame?: SubMapFrame;
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

/**
 * S5（0.9.55）：由 `World.points[].parentPointId` 派生 v2 父子地图，与已清洗的
 * sidecar 合并，产出**只给 `/state` 使用**的地图 doc。纯函数：不修改入参。
 *
 * 口径（施工单「先固定数据契约」）：
 * - 唯一地点身份仍是 `World.points[].id`（数字 ID）；子图内 marker 的 id 用该数字的字符串。
 * - `submaps[父ID]` 装其直接子地点；子图 `parentMapId` 指向父所在图（"world" 或父的父 ID）。
 * - sidecar 已有的同 ID 布局坐标 / frame / 比例尺 / 描述**优先保留**；新点按父 ID 与
 *   子 ID 确定性散布（不依赖时间戳或数组顺序），同一孩子二次投影结果深相等。
 * - 兼容 v1 sidecar 的虚拟 `sub-*` 点：合并且不改 ID；与 v2 新点同名时两者都保留，
 *   绝不按名字偷偷合并或搬走旧手工布局。
 * - 超过 SUBMAP_DEPTH_MAX 层可达的地点不再下钻（其子图不生成），并计入 dropped 供日志。
 * - 坏 sidecar 引用（同名但不存在的父）丢弃于视图并计数。
 */
export function projectWorldSubmaps(
  points: readonly MapPoint[],
  sidecar: AtlasMapDoc,
): { doc: AtlasMapDoc; dropped: number } {
  // 只认有限正整数的 parentPointId；其余（含自引用）视为根，避免脏数据造环
  const byId = new Map<number, MapPoint>();
  for (const point of points) {
    const id = Number(point.id);
    if (Number.isInteger(id) && id > 0) byId.set(id, point);
  }
  const childrenOf = new Map<number, MapPoint[]>();
  let dropped = 0;
  for (const point of byId.values()) {
    const pid = Number(point.parentPointId);
    if (!Number.isInteger(pid) || pid <= 0) continue;      // 根地点
    if (pid === Number(point.id)) { dropped += 1; continue; } // 自引用：脏数据
    if (!byId.has(pid)) { dropped += 1; continue; }           // 父不在当前可见世界
    const bucket = childrenOf.get(pid) ?? [];
    bucket.push(point);
    childrenOf.set(pid, bucket);
  }

  const doc: AtlasMapDoc = {
    schemaVersion: 2,
    pointMeta: { ...sidecar.pointMeta },
    submaps: { ...sidecar.submaps },
    calibrations: { ...sidecar.calibrations },
  };

  // 深度：从根地点向下走，超过 SUBMAP_DEPTH_MAX 层的地点不下钻（其子图不生成）
  const depthById = new Map<number, number>();
  const resolveDepth = (id: number, guard = 0): number => {
    const cached = depthById.get(id);
    if (cached !== undefined) return cached;
    if (guard > SUBMAP_DEPTH_MAX + 1) return SUBMAP_DEPTH_MAX + 2; // 防御：环
    const point = byId.get(id);
    const pid = Number(point?.parentPointId);
    const depth = Number.isInteger(pid) && pid > 0 && byId.has(pid) ? resolveDepth(pid, guard + 1) + 1 : 0;
    depthById.set(id, depth);
    return depth;
  };

  for (const [parentId, children] of childrenOf) {
    const depth = resolveDepth(parentId);
    // parentId 本身是第 depth 层；其子图为第 depth+1 张 → 超过上限则不下钻
    if (depth + 1 > SUBMAP_DEPTH_MAX) {
      dropped += children.length;
      continue;
    }
    const key = String(parentId);
    const existing = sidecar.submaps[key];
    // v1 虚拟点先入列（保留其 id 与手工坐标），v2 子点按数字 ID 追加
    const kept: SubMapPoint[] = Array.isArray(existing?.points)
      ? existing.points.map((p) => ({ ...p }))
      : [];
    const knownIds = new Set(kept.map((p) => p.id));
    const newOnes = [...children].sort((a, b) => Number(a.id) - Number(b.id));

    newOnes.forEach((child, index) => {
      const childKey = String(child.id);
      const disk = kept.find((p) => p.id === childKey);
      if (disk) {
        // sidecar 已有该点的布局/描述：优先保留坐标与描述，只补名称
        if (!disk.name) disk.name = child.name;
        return;
      }
      // 确定性散布：仅由 父ID 与 子ID 决定，与调用顺序 / 时间戳无关
      // （hashString 返回 8 位十六进制串，转回整数用作散列种子）
      const seed = Number.parseInt(hashString(`${parentId}:${childKey}`), 16) || 0;
      const angle = ((seed % 3600) / 3600) * Math.PI * 2;
      const radius = 12 + 3.2 * Math.sqrt(index + 1);
      kept.push({
        id: childKey,
        name: child.name,
        x: Math.round(Math.min(96, Math.max(4, 50 + radius * Math.cos(angle)))),
        y: Math.round(Math.min(96, Math.max(4, 50 + radius * Math.sin(angle)))),
        ...(typeof doc.pointMeta[childKey]?.description === "string"
          ? { description: doc.pointMeta[childKey]!.description as string }
          : {}),
      });
      knownIds.add(childKey);
    });

    doc.submaps[key] = {
      // 父所在的图：父是根（depth 0）→ 世界图；否则 → 父的父 ID
      parentMapId: depth === 0 ? "world" : String(byId.get(parentId)!.parentPointId),
      ownerLocationId: key,
      points: kept,
      ...(existing?.scale ? { scale: existing.scale } : {}),
      ...(existing?.frame ? { frame: existing.frame } : {}),
    };
  }

  return { doc, dropped };
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
          scale = { distancePerCell: roundPositiveScale(distance), ...(unit ? { unit } : {}) };
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
      if (points.length > 0) {
      // R09：解析 frame 字段——严格类型校验，缺省走 SUBMAP_FRAME_DEFAULT
      let frame: SubMapFrame | undefined;
      const frameRaw = subRecord.frame;
      if (frameRaw && typeof frameRaw === "object" && !Array.isArray(frameRaw)) {
        const rec = frameRaw as Record<string, unknown>;
        const colsRaw = rec.cols;
        const rowsRaw = rec.rows;
        const revisionRaw = rec.frameRevision;
        if (typeof colsRaw === "number" && typeof rowsRaw === "number" && typeof revisionRaw === "number"
            && Number.isFinite(colsRaw) && colsRaw > 0 && colsRaw <= 10000
            && Number.isFinite(rowsRaw) && rowsRaw > 0 && rowsRaw <= 10000
            && Number.isFinite(revisionRaw) && revisionRaw >= 0 && revisionRaw <= 1000000) {
          frame = { cols: Math.floor(colsRaw), rows: Math.floor(rowsRaw), frameRevision: Math.floor(revisionRaw) };
        }
      }
      const parentMapId = typeof subRecord.parentMapId === "string"
        && subRecord.parentMapId.length <= 64 && subRecord.parentMapId !== key
        ? subRecord.parentMapId : "world";
      doc.submaps[key] = {
        parentMapId,
        ownerLocationId: key,
        ...(scale ? { scale } : {}),
        ...(frame ? { frame } : { frame: { ...SUBMAP_FRAME_DEFAULT } }),
        points,
      };
    }
  }
  }
  // 旧文档没有父链：若宿主点确实属于另一子图，按点位 ID 推断父图。
  for (const [mapId, submap] of Object.entries(doc.submaps)) {
    if (submap.parentMapId !== "world" || !mapId.startsWith("sub-")) continue;
    const parent = Object.entries(doc.submaps).find(([candidateId, candidate]) =>
      candidateId !== mapId && candidate.points.some((point) => point.id === mapId));
    if (parent) submap.parentMapId = parent[0];
  }
  // 循环或超限的旧数据保留文档但不提供嵌套入口，避免误删原始资料。
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
  return {
    parentMapId: "world",
    ownerLocationId: context.pointId,
    ...(draft.scale ? { scale: draft.scale } : {}),
    frame: draft.frame ? { ...draft.frame } : { ...SUBMAP_FRAME_DEFAULT },
    points,
  };
}

/** Flat registry with explicit parent links; nested drafts become real maps. */
export function buildSubMapTreeFromDraft(
  draft: SubMapDraft,
  context: { worldId: string; pointId: string; now: number },
  parentMapId = "world",
  depth = 1,
): Record<string, SubMap> {
  const root = buildSubMapFromDraft(draft, context);
  root.parentMapId = parentMapId;
  const maps: Record<string, SubMap> = { [context.pointId]: root };
  if (depth >= SUBMAP_DEPTH_MAX) return maps;
  for (let index = 0; index < root.points.length; index++) {
    const childDraft = draft.points[index]?.submap;
    const childPoint = root.points[index];
    if (!childDraft || !childPoint) continue;
    Object.assign(maps, buildSubMapTreeFromDraft(childDraft, {
      worldId: context.worldId, pointId: childPoint.id, now: context.now,
    }, context.pointId, depth + 1));
  }
  return maps;
}
