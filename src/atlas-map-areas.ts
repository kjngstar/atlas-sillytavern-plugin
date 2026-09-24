/**
 * atlas-map-areas.ts — H15：把 geoTopology.areas 的已证实格投影为地图填色图层（纯函数，零 IO）。
 *
 * 依据（计划 §2.5 网格视觉层次与 H15 原文）：
 * - H15：「新增 src/atlas-map-areas.ts / projectColorAreas：只把 geoTopology.areas 的**已证实**
 *   cells 投影为合并的 SVG 填区，含 evidence/areaId；如果只有地点中心给 displayOnly 光圈，
 *   **不返回物理 boundary**；默认透明度 ≤0.18，未知格保持透明。势力范围/风声到达热区另由
 *   已知 locationId 聚合，不能把届时未送达的人的区域染成已知。完成：没有 areas 的地图一格
 *   都不假染」。
 * - §2.5：「已知范围 cells 才可涂准确颜色；仅知道中心城市时画带『示意』标签的弱光圈，不涂出
 *   编造边界。区块色/势力色/消息已达范围分别开关并有图例，默认只开区块」。
 * - §2.1：`AtlasGeoArea { id, locationId, mapId, cells, evidence }`，`areaId = branchKey|mapId|locationId`，
 *   每区最多 256 格、单分支最多 64 个 area。
 *
 * 本模块的可验证承诺：
 * 1. **只涂有证据的格**：没有 areas / cells 为空 / cells 全部越界 / evidence 不是
 *    worldbook|story|manual → 一格都不染（paintedCells = 0）。未知格永远透明。
 * 2. **示意不等于边界**：只有地点中心时只给 displayOnly 弱光圈（boundary: null，且没有 path），
 *    绝不产出可供距离/边界计算的几何。
 * 3. **透明度上限**：默认 0.18 且是上限——调用方传更大的值会被夹回 0.18。
 * 4. **势力/热区只认已确证 locationId**：由调用方给出的已确认 id 集合聚合，未送达的人的区域
 *    不会因此被染色；没有任何 id 就没有任何热区填色。
 * 5. **确定性与无副作用**：不读时钟、不用随机数、不改输入；同一输入逐字节相同输出
 *    （输出数组一律按稳定键排序）。
 */

import { ATLAS_GEO_LIMITS } from "./atlas-geo-topology.ts";
import type { AtlasGeoArea, AtlasGeoEvidence, AtlasGeoTopology } from "./atlas-geo-topology.ts";

/** 区块填色透明度上限（H15 原文：默认 ≤ 0.18）。这是**上限**，不是建议值。 */
export const COLOR_AREA_MAX_OPACITY = 0.18;
/** 未指定时的默认透明度。 */
export const COLOR_AREA_DEFAULT_OPACITY = 0.18;
/** 弱光圈（只有中心点、没有 cells）的透明度与半径：明确是示意，不是测量。 */
export const COLOR_AREA_HALO_OPACITY = 0.1;
export const COLOR_AREA_HALO_RADIUS_CELLS = 2;
/** 单区格数上限 / 单图投影 area 上限：直接沿用 §2.1 的唯一权威常量，不在此另抄一份数字。 */
export const COLOR_AREA_CELL_LIMIT = ATLAS_GEO_LIMITS.areaCells;
export const COLOR_AREA_PROJECTION_LIMIT = ATLAS_GEO_LIMITS.areas;

/** 已证实来源（§2.1）：沿用 atlas-geo-topology.ts 的契约别名，保证字面量联合永远同源。 */
export type AtlasColorAreaEvidence = AtlasGeoEvidence;

/** 图层：区块色 / 势力色 / 消息已达范围（§2.5「分别开关并有图例，默认只开区块」）。 */
export type AtlasColorAreaLayer = "area" | "faction" | "signal";

/** 整块 area / 地点被拒绝投影的原因（必须让调用方看得见）。 */
export type AtlasColorAreaSkipReason =
  | "INVALID_AREA"
  | "OTHER_MAP"
  | "OTHER_BRANCH"
  | "UNVERIFIED_EVIDENCE"
  | "DUPLICATE_AREA"
  | "OVER_LIMIT"
  | "NO_CELLS_NO_CENTER"
  | "CENTER_OUT_OF_FRAME";

/** 单格被丢弃的原因（不静默丢格）。 */
export type AtlasColorAreaDropReason = "NOT_INTEGER" | "DUPLICATE" | "OUT_OF_FRAME" | "OVER_CELL_LIMIT";

/** 已确认坐标的地点中心（来自三表已确认 gridX/Y）；只用来画示意光圈。 */
export interface AtlasColorAreaCenter {
  locationId: string;
  x: number;
  y: number;
}

/** 只读拓扑的最小形状（便于调用方只传 areas，也容忍旧档缺字段）。 */
export interface AtlasColorAreaTopologyLike {
  areas?: readonly AtlasGeoArea[] | null;
}

export interface AtlasColorAreaInput {
  /** 目标图 id（世界图 "world" / 子图宿主点 id）；只投影本图的 area。 */
  mapId: string;
  /** 目标图 frame（cols×rows）：越界格一律不涂。 */
  frame: { cols: number; rows: number };
  /** 当前分支 geoTopology（只读；缺省/空 = 空模块，一格不染）。 */
  topology?: AtlasGeoTopology | AtlasColorAreaTopologyLike | null;
  /** 当前分支键；给了就核对 areaId 前缀（branchKey|mapId|locationId），防跨分支串色。 */
  branchKey?: string;
  /** 图层开关；缺省只开区块（area）。 */
  layers?: { area?: boolean; faction?: boolean; signal?: boolean };
  /** 填色透明度（上限 0.18；越界值被夹回）。 */
  opacity?: number;
  /** 只有中心点、没有确证 cells 的地点：传进来即请求 displayOnly 弱光圈。 */
  locationCenters?: readonly AtlasColorAreaCenter[];
  /** 已确证的势力归属 locationId（未确证的不要传）。 */
  factionLocationIds?: readonly string[];
  /** 已送达消息的地点 locationId（未送达的不要传：热区只按已确证集合聚合）。 */
  signalReachedLocationIds?: readonly string[];
  /** 本次最多投影多少个 area（缺省 COLOR_AREA_PROJECTION_LIMIT）。 */
  limit?: number;
}

/** 已证实 cells 合并出来的 SVG 填区（一格 = 网格 1×1）。 */
export interface AtlasProjectedColorArea {
  areaId: string;
  locationId: string;
  mapId: string;
  evidence: AtlasColorAreaEvidence;
  layer: AtlasColorAreaLayer;
  /** 合并后的 SVG path（M/L/Z，可含多段；相邻格合并为一条外轮廓）。 */
  path: string;
  /** path 里的子路径数（不连通的格集合会 > 1）。 */
  subpaths: number;
  /** 参与合并的已证实格（已去重、已排序、已裁到 frame 内）。 */
  cells: Array<{ x: number; y: number }>;
  cellCount: number;
  opacity: number;
}

/** 弱光圈：只有地点中心，**没有** cells —— 明确不是物理 boundary。 */
export interface AtlasColorAreaHalo {
  /** 有对应 area 行时为其 id；纯中心点聚合时为空字符串。 */
  areaId: string;
  locationId: string;
  layer: AtlasColorAreaLayer;
  displayOnly: true;
  x: number;
  y: number;
  radiusCells: number;
  opacity: number;
  /** 有 area 行才带证据；纯中心点聚合时 null（不编造证据）。 */
  evidence: AtlasColorAreaEvidence | null;
  /** 恒为 null：示意光圈绝不返回物理边界。 */
  boundary: null;
}

export interface AtlasColorAreaSkip {
  layer: AtlasColorAreaLayer | null;
  areaId: string;
  locationId: string;
  reason: AtlasColorAreaSkipReason;
  detail: string;
}

export interface AtlasColorAreaDroppedCells {
  areaId: string;
  locationId: string;
  reason: AtlasColorAreaDropReason;
  count: number;
}

export interface AtlasColorAreaLayerInfo {
  layer: AtlasColorAreaLayer;
  enabled: boolean;
  opacity: number;
  label: string;
}

export interface AtlasColorAreaProjection {
  mapId: string;
  frame: { cols: number; rows: number };
  opacity: number;
  /** 已证实 cells 的合并填区（区块 / 势力 / 热区三层各自列出，areaId + evidence 齐全）。 */
  areas: AtlasProjectedColorArea[];
  /** displayOnly 弱光圈（没有 cells，只有中心点）。 */
  halos: AtlasColorAreaHalo[];
  /** 未涂色的 area / 地点及其原因。 */
  skipped: AtlasColorAreaSkip[];
  /** 被丢掉的格数（按原因分组）。 */
  droppedCells: AtlasColorAreaDroppedCells[];
  /** 图层开关与图例信息。 */
  layers: AtlasColorAreaLayerInfo[];
  counts: {
    scannedAreas: number;
    projectedAreas: number;
    truncatedAreas: number;
    paintedCells: number;
    droppedCells: number;
    halos: number;
    skipped: number;
  };
}

// ---------------------------------------------------------------------------
// 内部工具（全部纯函数；输入一律当不可信数据处理）
// ---------------------------------------------------------------------------

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const LAYER_ORDER: Record<AtlasColorAreaLayer, number> = { area: 0, faction: 1, signal: 2 };

const LAYER_LABELS: Record<AtlasColorAreaLayer, string> = {
  area: "区块（已证实格）",
  faction: "势力范围（已确证归属）",
  signal: "消息已达热区（已送达地点）",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isAreaEvidence(value: unknown): value is AtlasColorAreaEvidence {
  return value === "worldbook" || value === "story" || value === "manual";
}

/** frame 规范化：非有限 / 非正 → 0（此时没有任何格能落在图内，等于一格不染）。 */
function normalizeFrame(raw: unknown): { cols: number; rows: number } {
  const record = asRecord(raw);
  const cols = Number(record?.cols);
  const rows = Number(record?.rows);
  return {
    cols: Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : 0,
    rows: Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 0,
  };
}

/** 透明度：默认 0.18；给得更大被夹回上限（H15：默认透明度 ≤ 0.18）。 */
function clampAreaOpacity(value: unknown): number {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return COLOR_AREA_DEFAULT_OPACITY;
  return Math.min(raw, COLOR_AREA_MAX_OPACITY);
}

function normalizeLayers(raw: unknown): Record<AtlasColorAreaLayer, boolean> {
  const record = asRecord(raw);
  return {
    area: record?.area !== false, // 默认只开区块
    faction: record?.faction === true,
    signal: record?.signal === true,
  };
}

function normalizeLimit(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return COLOR_AREA_PROJECTION_LIMIT;
  return Math.floor(value);
}

/** 去重 + 排序的 id 列表：保证输出与输入顺序无关。 */
function dedupeSortedIds(raw: unknown): string[] {
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    const id = readText(item);
    if (id !== "") seen.add(id);
  }
  return [...seen].sort(compareText);
}

interface SanitizedCells {
  cells: Array<{ x: number; y: number }>;
  dropped: Array<{ reason: AtlasColorAreaDropReason; count: number }>;
}

/**
 * 逐格清洗：只接受落在 frame 内的整数格；重复格、越界格、非整数格全部丢弃并记账。
 * 未知（没有证据）的格不会凭空出现——这里只做减法，不做扩张。
 */
function sanitizeAreaCells(rawCells: unknown, frame: { cols: number; rows: number }): SanitizedCells {
  const counts: Record<AtlasColorAreaDropReason, number> = {
    NOT_INTEGER: 0,
    DUPLICATE: 0,
    OUT_OF_FRAME: 0,
    OVER_CELL_LIMIT: 0,
  };
  const seen = new Set<string>();
  const cells: Array<{ x: number; y: number }> = [];
  for (const item of Array.isArray(rawCells) ? rawCells : []) {
    const record = asRecord(item);
    const x = Number(record?.x);
    const y = Number(record?.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      counts.NOT_INTEGER += 1;
      continue;
    }
    const key = `${x},${y}`;
    if (seen.has(key)) {
      counts.DUPLICATE += 1;
      continue;
    }
    if (x < 0 || x >= frame.cols || y < 0 || y >= frame.rows) {
      counts.OUT_OF_FRAME += 1;
      continue;
    }
    if (cells.length >= COLOR_AREA_CELL_LIMIT) {
      counts.OVER_CELL_LIMIT += 1;
      continue;
    }
    seen.add(key);
    cells.push({ x, y });
  }
  cells.sort((left, right) => left.y - right.y || left.x - right.x);
  const dropped = (Object.keys(counts) as AtlasColorAreaDropReason[])
    .filter((reason) => counts[reason] > 0)
    .map((reason) => ({ reason, count: counts[reason] }));
  return { cells, dropped };
}

interface BoundaryEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const edgeKey = (edge: BoundaryEdge): string => `${edge.x1},${edge.y1}>${edge.x2},${edge.y2}`;

/**
 * 格集合 → 合并的 SVG 填区：只保留「外侧」边界边（与已存在邻格共享的边相互抵消），
 * 再把边界边串成闭环，输出 M/L/Z。相邻格因此合并为一条外轮廓，而不是并排的方块。
 */
function mergeCellPath(cells: ReadonlyArray<{ x: number; y: number }>): { path: string; subpaths: number } {
  const present = new Set(cells.map((cell) => `${cell.x},${cell.y}`));
  const edges = new Map<string, BoundaryEdge>();
  const addEdge = (x1: number, y1: number, x2: number, y2: number): void => {
    edges.set(`${x1},${y1}>${x2},${y2}`, { x1, y1, x2, y2 });
  };
  // 每格四条有向边（顺时针，y 向下）；与邻格共享的边会与反向边成对抵消。
  for (const cell of cells) {
    const { x, y } = cell;
    if (!present.has(`${x},${y - 1}`)) addEdge(x, y, x + 1, y);
    if (!present.has(`${x + 1},${y}`)) addEdge(x + 1, y, x + 1, y + 1);
    if (!present.has(`${x},${y + 1}`)) addEdge(x + 1, y + 1, x, y + 1);
    if (!present.has(`${x - 1},${y}`)) addEdge(x, y + 1, x, y);
  }
  for (const [key, edge] of [...edges]) {
    const reverse = `${edge.x2},${edge.y2}>${edge.x1},${edge.y1}`;
    if (edges.has(reverse)) {
      edges.delete(key);
      edges.delete(reverse);
    }
  }
  const byStart = new Map<string, BoundaryEdge[]>();
  for (const edge of edges.values()) {
    const bucket = byStart.get(`${edge.x1},${edge.y1}`) ?? [];
    bucket.push(edge);
    byStart.set(`${edge.x1},${edge.y1}`, bucket);
  }
  for (const bucket of byStart.values()) {
    bucket.sort((left, right) => left.x2 - right.x2 || left.y2 - right.y2);
  }
  const starts = [...edges.values()].sort((left, right) =>
    left.y1 - right.y1 || left.x1 - right.x1 || left.y2 - right.y2 || left.x2 - right.x2);
  const used = new Set<string>();
  const parts: string[] = [];
  for (const start of starts) {
    if (used.has(edgeKey(start))) continue;
    const points: string[] = [];
    let cursor: BoundaryEdge | null = start;
    for (let guard = 0; cursor && guard <= edges.size + 1; guard += 1) {
      used.add(edgeKey(cursor));
      points.push(`${cursor.x1} ${cursor.y1}`);
      if (cursor.x2 === start.x1 && cursor.y2 === start.y1) break;
      // 显式标注：cursor 的控制流收窄与 next 的推断互为依赖，不标注会被 TS 判为循环推断。
      const next: BoundaryEdge | undefined = (byStart.get(`${cursor.x2},${cursor.y2}`) ?? [])
        .find((edge) => !used.has(edgeKey(edge)));
      cursor = next ?? null;
    }
    parts.push(`M ${points.join(" L ")} Z`);
  }
  return { path: parts.join(" "), subpaths: parts.length };
}

/** areaId 口径为 branchKey|mapId|locationId（§2.1）；没有分隔符就不猜，交给 mapId 校验。 */
function areaBranchMatches(areaId: string, branchKey: string | null): boolean {
  if (branchKey === null) return true;
  const separator = areaId.indexOf("|");
  if (separator <= 0) return true;
  return areaId.slice(0, separator) === branchKey;
}

// ---------------------------------------------------------------------------
// H15 主函数
// ---------------------------------------------------------------------------

/**
 * 把本分支 geoTopology.areas 的已证实 cells 投影成地图填色图层。
 * 没有 areas / 没有 cells / 没有证据 → 一个格都不染。
 *
 * @param input 见 AtlasColorAreaInput。
 */
export function projectColorAreas(input: AtlasColorAreaInput): AtlasColorAreaProjection {
  const source = (input ?? {}) as AtlasColorAreaInput;
  const mapId = readText(source.mapId);
  const frame = normalizeFrame(source.frame);
  const opacity = clampAreaOpacity(source.opacity);
  const enabled = normalizeLayers(source.layers);
  const limit = normalizeLimit(source.limit);
  const branchKey = readText(source.branchKey) === "" ? null : readText(source.branchKey);

  const skipped: AtlasColorAreaSkip[] = [];
  const droppedCells: AtlasColorAreaDroppedCells[] = [];
  const areas: AtlasProjectedColorArea[] = [];
  const halos: AtlasColorAreaHalo[] = [];

  // 1) 中心点表（只有中心、没有 cells 的地点靠它出弱光圈）。
  const centers = new Map<string, { x: number; y: number; inFrame: boolean }>();
  for (const item of Array.isArray(source.locationCenters) ? source.locationCenters : []) {
    const record = asRecord(item);
    if (!record) continue;
    const locationId = readText(record.locationId);
    if (locationId === "" || centers.has(locationId)) continue;
    const x = Number(record.x);
    const y = Number(record.y);
    const inFrame = Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x < frame.cols && y >= 0 && y < frame.rows;
    centers.set(locationId, { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0, inFrame });
  }

  // 2) 逐条 area 清洗：只留本图、本分支、已证实证据的格集合。
  const topologyRecord = asRecord(source.topology);
  const rawAreas = Array.isArray(topologyRecord?.areas) ? (topologyRecord?.areas as unknown[]) : [];
  interface SanitizedArea {
    areaId: string;
    locationId: string;
    evidence: AtlasColorAreaEvidence;
    cells: Array<{ x: number; y: number }>;
  }
  const sanitized: SanitizedArea[] = [];
  const seenAreaIds = new Set<string>();
  for (const item of rawAreas) {
    const record = asRecord(item);
    if (!record) {
      skipped.push({ layer: null, areaId: "", locationId: "", reason: "INVALID_AREA", detail: "areas[i] 不是对象：不投影" });
      continue;
    }
    const areaId = readText(record.id);
    const locationId = readText(record.locationId);
    const areaMapId = readText(record.mapId);
    if (areaMapId !== mapId) {
      skipped.push({
        layer: null,
        areaId,
        locationId,
        reason: "OTHER_MAP",
        detail: `area.mapId=${areaMapId === "" ? "(缺失)" : areaMapId} ≠ 目标图 ${mapId === "" ? "(缺失)" : mapId}：不跨图染色`,
      });
      continue;
    }
    if (!areaBranchMatches(areaId, branchKey)) {
      skipped.push({ layer: null, areaId, locationId, reason: "OTHER_BRANCH", detail: "areaId 前缀不是当前分支：不跨分支染色" });
      continue;
    }
    const evidenceRaw: unknown = record.evidence;
    if (!isAreaEvidence(evidenceRaw)) {
      skipped.push({
        layer: "area",
        areaId,
        locationId,
        reason: "UNVERIFIED_EVIDENCE",
        detail: "evidence 不是 worldbook/story/manual：未证实范围不投影",
      });
      continue;
    }
    if (seenAreaIds.has(areaId)) {
      skipped.push({ layer: "area", areaId, locationId, reason: "DUPLICATE_AREA", detail: "同一 areaId 只投影第一条" });
      continue;
    }
    seenAreaIds.add(areaId);
    const { cells, dropped } = sanitizeAreaCells(record.cells, frame);
    for (const entry of dropped) {
      droppedCells.push({ areaId, locationId, reason: entry.reason, count: entry.count });
    }
    sanitized.push({ areaId, locationId, evidence: evidenceRaw, cells });
  }
  sanitized.sort((left, right) =>
    compareText(left.areaId, right.areaId) || compareText(left.locationId, right.locationId));

  // 3) 超上限的 area 一律不投影（含势力/热区层），逐条报 OVER_LIMIT。
  const truncated = sanitized.slice(limit);
  for (const area of truncated) {
    skipped.push({
      layer: "area",
      areaId: area.areaId,
      locationId: area.locationId,
      reason: "OVER_LIMIT",
      detail: `本图最多投影 ${limit} 个 area（§2.1 单分支上限）：本条未投影`,
    });
  }
  const budgeted = sanitized.slice(0, limit);
  const cellsByLocation = new Map<string, SanitizedArea>();
  for (const area of budgeted) {
    if (area.cells.length > 0 && !cellsByLocation.has(area.locationId)) cellsByLocation.set(area.locationId, area);
  }

  // 4) 区块层：只把已证实 cells 画成合并填区。
  if (enabled.area) {
    for (const area of budgeted) {
      if (area.cells.length === 0) continue;
      const merged = mergeCellPath(area.cells);
      areas.push({
        areaId: area.areaId,
        locationId: area.locationId,
        mapId,
        evidence: area.evidence,
        layer: "area",
        path: merged.path,
        subpaths: merged.subpaths,
        cells: area.cells.map((cell) => ({ ...cell })),
        cellCount: area.cells.length,
        opacity,
      });
    }
  }

  // 5) 势力范围 / 消息已达热区：只由已确证 locationId 聚合；不在名单里的地点绝不被染。
  const layerSets: Array<{ layer: "faction" | "signal"; ids: string[] }> = [
    { layer: "faction", ids: dedupeSortedIds(source.factionLocationIds) },
    { layer: "signal", ids: dedupeSortedIds(source.signalReachedLocationIds) },
  ];
  for (const { layer, ids } of layerSets) {
    if (!enabled[layer]) continue;
    for (const locationId of ids) {
      const hit = cellsByLocation.get(locationId);
      if (!hit) continue; // 没有确证格：下面按「光圈 / 未涂色」处理
      const merged = mergeCellPath(hit.cells);
      areas.push({
        areaId: hit.areaId,
        locationId,
        mapId,
        evidence: hit.evidence,
        layer,
        path: merged.path,
        subpaths: merged.subpaths,
        cells: hit.cells.map((cell) => ({ ...cell })),
        cellCount: hit.cells.length,
        opacity,
      });
    }
  }

  // 6) 只有地点中心、没有确证 cells → displayOnly 弱光圈（绝不产出物理 boundary）。
  //    一个地点只画一圈：图层取最有信息量的那一层（热区 > 势力 > 区块），避免同点套三圈。
  const haloRequests: Array<{ layer: AtlasColorAreaLayer; areaId: string; locationId: string; evidence: AtlasColorAreaEvidence | null }> = [];
  const haloSeen = new Set<string>();
  const requestHalo = (
    layer: AtlasColorAreaLayer,
    areaId: string,
    locationId: string,
    evidence: AtlasColorAreaEvidence | null,
  ): void => {
    if (locationId === "" || haloSeen.has(locationId)) return;
    haloSeen.add(locationId);
    haloRequests.push({ layer, areaId, locationId, evidence });
  };
  for (const layer of ["signal", "faction"] as const) {
    if (!enabled[layer]) continue;
    const ids = layerSets.find((entry) => entry.layer === layer)?.ids ?? [];
    for (const locationId of ids) {
      if (cellsByLocation.has(locationId)) continue;
      const area = budgeted.find((item) => item.locationId === locationId) ?? null;
      requestHalo(layer, area?.areaId ?? "", locationId, area?.evidence ?? null);
    }
  }
  if (enabled.area) {
    for (const area of budgeted) {
      if (area.cells.length > 0) continue;
      requestHalo("area", area.areaId, area.locationId, area.evidence);
    }
    // 只传了中心点、连 area 行都没有的地点：传中心点即请求示意光圈（H15 原文）。
    for (const locationId of [...centers.keys()].sort(compareText)) {
      if (cellsByLocation.has(locationId)) continue;
      requestHalo("area", "", locationId, null);
    }
  }
  for (const request of haloRequests) {
    const center = centers.get(request.locationId) ?? null;
    if (!center) {
      skipped.push({
        layer: request.layer,
        areaId: request.areaId,
        locationId: request.locationId,
        reason: "NO_CELLS_NO_CENTER",
        detail: "既没有确证 cells 也没有地点中心：不涂色、不给光圈",
      });
      continue;
    }
    if (!center.inFrame) {
      skipped.push({
        layer: request.layer,
        areaId: request.areaId,
        locationId: request.locationId,
        reason: "CENTER_OUT_OF_FRAME",
        detail: `中心点 (${center.x},${center.y}) 不落在 frame 内：不给光圈`,
      });
      continue;
    }
    halos.push({
      areaId: request.areaId,
      locationId: request.locationId,
      layer: request.layer,
      displayOnly: true,
      x: center.x,
      y: center.y,
      radiusCells: COLOR_AREA_HALO_RADIUS_CELLS,
      opacity: Math.min(opacity, COLOR_AREA_HALO_OPACITY),
      evidence: request.evidence,
      boundary: null,
    });
  }

  // 7) 输出排序（逐字节稳定）与计数。
  areas.sort((left, right) =>
    LAYER_ORDER[left.layer] - LAYER_ORDER[right.layer] ||
    compareText(left.areaId, right.areaId) ||
    compareText(left.locationId, right.locationId));
  halos.sort((left, right) => LAYER_ORDER[left.layer] - LAYER_ORDER[right.layer] || compareText(left.locationId, right.locationId));
  skipped.sort((left, right) =>
    compareText(left.areaId, right.areaId) ||
    compareText(left.locationId, right.locationId) ||
    compareText(left.reason, right.reason));
  droppedCells.sort((left, right) => compareText(left.areaId, right.areaId) || compareText(left.reason, right.reason));

  const paintedCells = areas.reduce((sum, item) => sum + item.cellCount, 0);
  return {
    mapId,
    frame,
    opacity,
    areas,
    halos,
    skipped,
    droppedCells,
    layers: (Object.keys(LAYER_ORDER) as AtlasColorAreaLayer[]).map((layer) => ({
      layer,
      enabled: enabled[layer],
      opacity,
      label: LAYER_LABELS[layer],
    })),
    counts: {
      scannedAreas: rawAreas.length,
      projectedAreas: areas.length,
      truncatedAreas: truncated.length,
      paintedCells,
      droppedCells: droppedCells.reduce((sum, item) => sum + item.count, 0),
      halos: halos.length,
      skipped: skipped.length,
    },
  };
}
