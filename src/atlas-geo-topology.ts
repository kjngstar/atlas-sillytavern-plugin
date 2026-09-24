/**
 * atlas-geo-topology.ts — 会话级地理拓扑（已确认边 / 有证据区域 / 移动载具锚点）纯数据层。
 *
 * 依据《Atlas 0.9.58 → 下一版本：后台动向、推演表、协议收口、地图与会话隔离施工计划》
 * §2.1「存储与归属」、§2.5「地点层级、移动载具、拓扑与图层契约」与 H01 / H02 / H10 / H11：
 * - geoTopology 只保存**已确认**的空间事实：edges（邻接 / 路线 / 通信）、areas（有明确证据或人工编辑的
 *   网格集合）、vehicles（移动载具当下的锚点）。它不是 SQL 数据库，也不在全局 store 另开永久文件（§2.1）。
 * - 地点 `parentLocationId` **只表示"包含"**：容器父链只代表进入 / 离开容器，
 *   不自动成为异地直达通道（§2.5）。本模块的邻接表**只**由 edges 构造，绝不从父链或地名推路。
 * - 零 IO、零副作用、纯函数：不读 store、不调模型、不改会话文档；ID 全部由
 *   「分支 + 实体 + 关系类型」确定性生成，不使用 `Date.now` / 随机数 / 时间游标。
 * - 错误码只描述结构性事实（中文文案交给调用方）；不因**地名相似**、同图坐标或黄金角螺旋坐标
 *   推导归属 / 邻接 / 距离 / 边界（H01 完成口径与 §2.5 停机线）。
 *
 * 分工：H01 = 类型 / 常量 / 空拓扑 / 确定性 ID；H02 = `validateGeoTopology`（候选写入的唯一闸门，
 * 坏边或越界格**整体拒绝**，旧会话原文仍可读可导出）；H10 = 只读邻接表与 `NO_PATH` 语义；
 * H11 = `moveVehicleAnchor`（时段 + 已确认路线才动，返回精确变更与 undo）。三表 / 会话文档的
 * 读写属 `atlas-tables.ts` / `atlas-server.ts` 职责，本模块一概不碰。
 */

import { SUBMAP_DEPTH_MAX } from "./atlas-geo-apply.ts";
import type { AtlasCharacterRow, AtlasLocationRow } from "./atlas-tables.ts";

/* ------------------------------------------------------------------ *
 * §2.1 固定契约（字段名 / 类型 / 字面量联合逐字照抄，不在此处改写）
 * ------------------------------------------------------------------ */

export interface AtlasGeoEdge {
  id: string;
  fromLocationId: string;
  toLocationId: string;
  kind: "adjacent" | "route" | "communication";
  evidence: "worldbook" | "story" | "manual";
  channel: "walk" | "vehicle" | "message" | null; // communication 须有明确传讯方式
}

export interface AtlasGeoArea {
  id: string; // branchKey + mapId + locationId；一地点每图一块有效范围
  locationId: string;
  mapId: string;
  cells: Array<{ x: number; y: number }>; // 明确证据/用户编辑的网格集合，不能从名称推断边界
  evidence: "worldbook" | "story" | "manual";
}

export interface AtlasVehicleAnchor {
  id: string; // 等于 locationId，供精确 undo / 覆写查找
  locationId: string; // 地点表中的移动载具本体，内舱地点用 parentLocationId 归属
  atLocationId: string | null; // 停靠时确认的地点；在途或不明时 null
  routeEdgeId: string | null; // 在途且已确认的 route edge；未知时 null
  status: "stopped" | "en-route" | "unknown";
  evidence: "worldbook" | "story" | "manual";
}

export interface AtlasGeoTopology {
  edges: AtlasGeoEdge[];
  areas: AtlasGeoArea[];
  vehicles: AtlasVehicleAnchor[];
}

/** 命名别名：只从上面的固定契约派生，保证与 §2.1 的字面量联合永远同源。 */
export type AtlasGeoEdgeKind = AtlasGeoEdge["kind"];
export type AtlasGeoEvidence = AtlasGeoEdge["evidence"];
export type AtlasGeoChannel = AtlasGeoEdge["channel"];
export type AtlasVehicleStatus = AtlasVehicleAnchor["status"];

/* ------------------------------------------------------------------ *
 * H01：上限常量、确定性 ID、空拓扑
 * ------------------------------------------------------------------ */

/**
 * 每分支上限（§2.1）：**唯一权威**，禁止在别处再抄一份数字。
 * `idChars` 同时用于边 / 区 / 锚点 id 的长度上限。
 */
export const ATLAS_GEO_LIMITS = {
  /** edges 上限。 */
  edges: 256,
  /** areas 上限。 */
  areas: 64,
  /** 单个 area 的 cells 上限。 */
  areaCells: 256,
  /** vehicles 上限。 */
  vehicles: 64,
  /** 行 id 长度上限（字）。 */
  idChars: 120,
} as const;

/**
 * `parentLocationId` 链最大层数（H02「parent 链最大 4 层」）。
 * 与子图递归深度 R09 是同一个口径，因此复用 `SUBMAP_DEPTH_MAX`，不另抄一个 4。
 * 语义：某地点之上最多 4 层祖先（根地点 0 层）。
 */
export const ATLAS_GEO_PARENT_DEPTH_MAX = SUBMAP_DEPTH_MAX;

const GEO_ID_SEP = "|";

/** id 分段转义：先 `%` 后分隔符，保证拼接可逆（不同输入不产生同一个 id）。 */
function escapeGeoIdPart(part: string): string {
  return part.split("%").join("%25").split(GEO_ID_SEP).join("%7C");
}

/** 32 位 FNV-1a：确定性、无依赖、无随机；只用于把超长 id 收敛到 `idChars` 以内。 */
function geoIdHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** 拼接 id：长度不超上限就用可读拼接；超长则截断并附确定性哈希后缀（同输入恒同 id）。 */
function joinGeoId(parts: readonly string[]): string {
  const raw = parts.map(escapeGeoIdPart).join(GEO_ID_SEP);
  if (raw.length <= ATLAS_GEO_LIMITS.idChars) return raw;
  const suffix = `~${geoIdHash(raw)}`;
  return `${raw.slice(0, ATLAS_GEO_LIMITS.idChars - suffix.length)}${suffix}`;
}

/** 无向排序：(A,B) 与 (B,A) 归一成同一个 (左,右)。 */
function orderEdgePair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

/**
 * H01：边 id = 分支 + 两地点 + 关系类型，同输入恒同 id，调用方无需自造。
 *
 * **无向去重**：`geoEdgeId(b, A, B, kind) === geoEdgeId(b, B, A, kind)` —— 两个端点先按字典序归一，
 * 因此反向调用得到**同一个** id，写入时按 id 覆盖即可保证「A↔B 只有一行」；方向不参与 id，
 * 读的时候按 `fromLocationId` / `toLocationId` 解释（H02 另查 (kind, 两端) 重复）。
 */
export function geoEdgeId(
  branchKey: string,
  fromLocationId: string,
  toLocationId: string,
  kind: AtlasGeoEdgeKind,
): string {
  const [left, right] = orderEdgePair(fromLocationId, toLocationId);
  return joinGeoId([branchKey, "geo-edge", kind, left, right]);
}

/** H01 / H15a：区 id = 分支 + 地图 + 地点；一地点每图一块有效范围。 */
export function geoAreaId(branchKey: string, mapId: string, locationId: string): string {
  return joinGeoId([branchKey, mapId, locationId]);
}

/**
 * H01：空拓扑 —— 恰好三个空数组。
 * 不使用 `Date.now` 造 ID（本函数不造任何 ID）；每次调用返回**互不共享引用**的新数组。
 */
export function createEmptyTopology(): AtlasGeoTopology {
  return { edges: [], areas: [], vehicles: [] };
}

/** 深拷贝拓扑（cells 也逐格复制）：纯函数返回值与 undo 快照都用它，避免调用方互相串改。 */
export function cloneGeoTopology(topology: AtlasGeoTopology): AtlasGeoTopology {
  return {
    edges: topology.edges.map((edge) => ({ ...edge })),
    areas: topology.areas.map((area) => ({ ...area, cells: area.cells.map((cell) => ({ ...cell })) })),
    vehicles: topology.vehicles.map((anchor) => ({ ...anchor })),
  };
}

/* ------------------------------------------------------------------ *
 * 内部工具（纯函数，不导出）
 * ------------------------------------------------------------------ */

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGridIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isEdgeKind(value: unknown): value is AtlasGeoEdgeKind {
  return value === "adjacent" || value === "route" || value === "communication";
}

function isEvidence(value: unknown): value is AtlasGeoEvidence {
  return value === "worldbook" || value === "story" || value === "manual";
}

function isChannelValue(value: unknown): value is AtlasGeoChannel {
  return value === null || value === "walk" || value === "vehicle" || value === "message";
}

function isVehicleStatus(value: unknown): value is AtlasVehicleStatus {
  return value === "stopped" || value === "en-route" || value === "unknown";
}

function toPeriodCount(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

/* ------------------------------------------------------------------ *
 * H02：校验（同分支三表引用 / 上限 / 拓扑结构）
 * ------------------------------------------------------------------ */

export type AtlasGeoErrorCode =
  /* 形状与上限 */
  | "GEO_NOT_OBJECT"
  | "GEO_COLLECTION_NOT_ARRAY"
  | "GEO_LIMIT_EXCEEDED"
  | "GEO_ROW_NOT_OBJECT"
  | "GEO_FIELD_MISSING"
  | "GEO_FIELD_TYPE"
  | "GEO_ID_MISSING"
  | "GEO_ID_TOO_LONG"
  | "GEO_ID_DUPLICATE"
  | "GEO_EVIDENCE_INVALID"
  | "GEO_FRAME_INVALID"
  /* 边 */
  | "GEO_EDGE_KIND_INVALID"
  | "GEO_EDGE_SELF"
  | "GEO_EDGE_LOCATION_UNKNOWN"
  | "GEO_EDGE_DUPLICATE"
  | "GEO_EDGE_ID_MISMATCH"
  | "GEO_CHANNEL_INVALID"
  | "GEO_COMMUNICATION_CHANNEL"
  | "GEO_ROUTE_CHANNEL"
  | "GEO_ADJACENT_CHANNEL"
  /* 区域 */
  | "GEO_AREA_LOCATION_UNKNOWN"
  | "GEO_AREA_MAP_REQUIRED"
  | "GEO_AREA_DUPLICATE"
  | "GEO_AREA_ID_MISMATCH"
  | "GEO_AREA_CELLS_NOT_ARRAY"
  | "GEO_AREA_CELLS_EXCEEDED"
  | "GEO_AREA_CELL_INVALID"
  | "GEO_AREA_CELL_DUPLICATE"
  | "GEO_AREA_CELL_OUT_OF_FRAME"
  /* 载具 */
  | "GEO_VEHICLE_LOCATION_UNKNOWN"
  | "GEO_VEHICLE_ID_MISMATCH"
  | "GEO_VEHICLE_STATUS_INVALID"
  | "GEO_VEHICLE_STOP_REQUIRED"
  | "GEO_VEHICLE_AT_UNEXPECTED"
  | "GEO_VEHICLE_AT_UNKNOWN"
  | "GEO_VEHICLE_ROUTE_UNKNOWN"
  | "GEO_VEHICLE_ROUTE_KIND"
  | "GEO_VEHICLE_ROUTE_MISMATCH"
  | "GEO_VEHICLE_ROUTE_STATUS"
  /* 同分支三表引用（地点表结构） */
  | "GEO_LOCATION_ID_CONFLICT"
  | "GEO_LOCATION_SELF_PARENT"
  | "GEO_LOCATION_PARENT_UNKNOWN"
  | "GEO_LOCATION_PARENT_CYCLE"
  | "GEO_LOCATION_DEPTH_EXCEEDED";

export interface AtlasGeoError {
  path: string;
  code: AtlasGeoErrorCode;
}

export type AtlasGeoValidation =
  | { ok: true; errors: [] }
  | { ok: false; errors: AtlasGeoError[] };

/** 一张地图的 frame（列 / 行，正整数格）。 */
export interface AtlasGeoFrame {
  cols: number;
  rows: number;
}

/**
 * H02 校验的输入选项。
 * - `locations` / `characters`：该分支三表（可选）。给了才做同分支引用检查；不给只查拓扑自身结构。
 * - `frame`：默认 frame；`frames`：按 mapId 覆盖（每张子图各有 frame）。
 *   两个都没给 → **不判越界**（无从判起）；H07a / H15a 这类写入口必须传 frame。
 * - `branchKey`：只用于拼错误路径与复算确定性 id；不传时路径里写 `<branch>` 且跳过 id 复算。
 */
export interface AtlasGeoValidationOptions {
  branchKey?: string;
  locations?: readonly AtlasLocationRow[];
  characters?: readonly AtlasCharacterRow[];
  frame?: AtlasGeoFrame | null;
  frames?: Readonly<Record<string, AtlasGeoFrame>>;
}

type Push = (path: string, code: AtlasGeoErrorCode) => void;

interface GeoRowRef {
  row: Record<string, unknown>;
  index: number;
}

interface LocationEntry {
  parent: string | null;
}

interface RefCheckContext {
  locations: Map<string, LocationEntry> | null;
  characterIds: ReadonlySet<string>;
  push: Push;
}

type GeoChainProblem =
  | "GEO_LOCATION_SELF_PARENT"
  | "GEO_LOCATION_PARENT_UNKNOWN"
  | "GEO_LOCATION_PARENT_CYCLE"
  | "GEO_LOCATION_DEPTH_EXCEEDED";

/** 错误路径统一挂在候选写入的根下：`$.simulation.branches.<branch>.geoTopology.<collection>[i].<field>`。 */
function geoPath(branchKey: string | null, tail: string): string {
  const base = `$.simulation.branches.${branchKey ?? "<branch>"}.geoTopology`;
  return tail.length === 0 ? base : `${base}.${tail}`;
}

function asGeoRows(value: unknown, path: string, cap: number, push: Push): GeoRowRef[] {
  if (!Array.isArray(value)) {
    push(path, "GEO_COLLECTION_NOT_ARRAY");
    return [];
  }
  if (value.length > cap) push(path, "GEO_LIMIT_EXCEEDED");
  const rows: GeoRowRef[] = [];
  value.forEach((item, index) => {
    if (!isObj(item)) {
      push(`${path}[${index}]`, "GEO_ROW_NOT_OBJECT");
      return;
    }
    rows.push({ row: item, index });
  });
  return rows;
}

function readId(row: Record<string, unknown>, key: string, path: string, push: Push): string | null {
  const value = row[key];
  if (value === undefined) {
    push(`${path}.${key}`, "GEO_FIELD_MISSING");
    return null;
  }
  if (typeof value !== "string") {
    push(`${path}.${key}`, "GEO_FIELD_TYPE");
    return null;
  }
  if (value.length === 0) {
    push(`${path}.${key}`, "GEO_ID_MISSING");
    return null;
  }
  return value;
}

function checkRowId(row: Record<string, unknown>, path: string, seen: Set<string>, push: Push): string | null {
  const id = readId(row, "id", path, push);
  if (id === null) return null;
  if (id.length > ATLAS_GEO_LIMITS.idChars) push(`${path}.id`, "GEO_ID_TOO_LONG");
  if (seen.has(id)) push(`${path}.id`, "GEO_ID_DUPLICATE");
  else seen.add(id);
  return id;
}

function buildLocationIndex(locations: unknown): Map<string, LocationEntry> | null {
  if (!Array.isArray(locations)) return null;
  const index = new Map<string, LocationEntry>();
  for (const item of locations) {
    if (!isObj(item)) continue;
    const id = item.id;
    if (typeof id !== "string" || id.length === 0 || index.has(id)) continue;
    const parent = item.parentLocationId;
    index.set(id, { parent: typeof parent === "string" && parent.length > 0 ? parent : null });
  }
  return index;
}

function buildCharacterIds(characters: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(characters)) return ids;
  for (const item of characters) {
    if (isObj(item) && typeof item.id === "string" && item.id.length > 0) ids.add(item.id);
  }
  return ids;
}

/**
 * parent 链结构检查：自指 / 环 / 悬空父 / 超过 4 层。
 * 只检查**被拓扑引用到**的地点（未被引用的地点行由三表校验负责），避免越权拒绝整轮。
 */
function chainProblemOf(locationId: string, index: Map<string, LocationEntry>): GeoChainProblem | null {
  const start = index.get(locationId);
  if (start === undefined) return null;
  const seen = new Set<string>([locationId]);
  let cursor: string | null = start.parent;
  let hops = 0;
  while (cursor !== null) {
    if (cursor === locationId && hops === 0) return "GEO_LOCATION_SELF_PARENT";
    if (seen.has(cursor)) return "GEO_LOCATION_PARENT_CYCLE";
    const entry = index.get(cursor);
    if (entry === undefined) return "GEO_LOCATION_PARENT_UNKNOWN";
    seen.add(cursor);
    hops += 1;
    if (hops > ATLAS_GEO_PARENT_DEPTH_MAX) return "GEO_LOCATION_DEPTH_EXCEEDED";
    cursor = entry.parent;
  }
  return null;
}

function checkLocationRef(
  id: string | null,
  path: string,
  unknownCode: AtlasGeoErrorCode,
  ctx: RefCheckContext,
): void {
  if (id === null || ctx.locations === null) return;
  if (!ctx.locations.has(id)) {
    ctx.push(path, unknownCode);
    return;
  }
  // 同分支三表引用检查：同一 id 不能既是地点又是人物（三表各自查重都查不到这种串线）。
  if (ctx.characterIds.has(id)) ctx.push(path, "GEO_LOCATION_ID_CONFLICT");
  const problem = chainProblemOf(id, ctx.locations);
  if (problem !== null) ctx.push(path, problem);
}

function normalizeFrame(frame: unknown): AtlasGeoFrame | null {
  if (!isObj(frame)) return null;
  const cols = frame.cols;
  const rows = frame.rows;
  if (!isGridIndex(cols) || !isGridIndex(rows)) return null;
  if (cols === 0 || rows === 0) return null;
  return { cols, rows };
}

/**
 * H02：校验一个分支的 geoTopology 候选（纯函数，不改输入）。
 *
 * 覆盖计划点名的全部禁止项：
 * - 同分支三表引用：edge 两端、area.locationId、vehicle.locationId / atLocationId 必须存在于地点表；
 *   `parentLocationId` 链自指 / 成环 / 悬空 / 超过 4 层一律拒绝；
 * - `kind="communication"` 必须 `channel="message"`；`kind="route"` 必须有可信连通信息
 *   （channel 只能是 walk / vehicle，光有同图坐标不算）；`kind="adjacent"` 不得宣称传讯；
 * - 边去重：同 (kind, 两端) 只能一行，id 必须等于 `geoEdgeId` 的稳定结果（无向去重）；
 * - area：cells 全部落在对应 frame 内、不重复、单区 ≤ 256 格、坐标是整数，且一地点每图只有一块；
 * - vehicle：只能引已存在地点、id 必须等于 locationId、停靠必须有确认地点、在途 / 不明不得带停靠点、
 *   `routeEdgeId` 必须是**与该载具本体地点相连**的一条 route 边（可信 channel）且状态为 en-route
 *   —— 与 H11 同一口径，保证 H11 移出的锚点一定能通过本校验。
 *
 * 任何一条错误都让候选**整体拒绝**（`ok:false`）；本函数只报告路径与结构码，
 * 不修改、不修复、也不清空旧会话原文（H02 完成口径：旧档仍可读并保留）。
 * 错误路径形如 `$.simulation.branches.<branch>.geoTopology.<collection>[i].<field>`。
 */
export function validateGeoTopology(
  input: unknown,
  options: AtlasGeoValidationOptions = {},
): AtlasGeoValidation {
  const branchKey =
    typeof options.branchKey === "string" && options.branchKey.length > 0 ? options.branchKey : null;
  const errors: AtlasGeoError[] = [];
  const push: Push = (path, code) => {
    errors.push({ path, code });
  };

  if (!isObj(input)) {
    return { ok: false, errors: [{ path: geoPath(branchKey, ""), code: "GEO_NOT_OBJECT" }] };
  }

  const edgeRows = asGeoRows(input.edges, geoPath(branchKey, "edges"), ATLAS_GEO_LIMITS.edges, push);
  const areaRows = asGeoRows(input.areas, geoPath(branchKey, "areas"), ATLAS_GEO_LIMITS.areas, push);
  const vehicleRows = asGeoRows(
    input.vehicles,
    geoPath(branchKey, "vehicles"),
    ATLAS_GEO_LIMITS.vehicles,
    push,
  );

  const ctx: RefCheckContext = {
    locations: buildLocationIndex(options.locations),
    characterIds: buildCharacterIds(options.characters),
    push,
  };

  // frame 选项本身不合法时只报一条（否则每个越界格都会重复报同一个选项问题）。
  const defaultFrame = normalizeFrame(options.frame ?? null);
  const perMapFrames = isObj(options.frames) ? options.frames : null;
  let frameOptionInvalid = options.frame !== undefined && options.frame !== null && defaultFrame === null;
  if (perMapFrames !== null) {
    for (const key of Object.keys(perMapFrames)) {
      if (normalizeFrame(perMapFrames[key]) === null) frameOptionInvalid = true;
    }
  }
  const frameOf = (mapId: unknown): AtlasGeoFrame | null => {
    if (typeof mapId === "string" && perMapFrames !== null && Object.prototype.hasOwnProperty.call(perMapFrames, mapId)) {
      return normalizeFrame(perMapFrames[mapId]);
    }
    return defaultFrame;
  };

  /* ------------------------------ edges ------------------------------ */

  const edgeIds = new Set<string>();
  const edgePairs = new Set<string>();
  const edgeById = new Map<string, AtlasGeoEdge>();

  for (const { row, index } of edgeRows) {
    const path = geoPath(branchKey, `edges[${index}]`);
    const id = checkRowId(row, path, edgeIds, push);
    const from = readId(row, "fromLocationId", path, push);
    const to = readId(row, "toLocationId", path, push);
    const kind = row.kind;
    const channel = row.channel;

    if (!isEdgeKind(kind)) push(`${path}.kind`, "GEO_EDGE_KIND_INVALID");
    if (!isEvidence(row.evidence)) push(`${path}.evidence`, "GEO_EVIDENCE_INVALID");
    if (channel === undefined) push(`${path}.channel`, "GEO_FIELD_MISSING");
    else if (!isChannelValue(channel)) push(`${path}.channel`, "GEO_CHANNEL_INVALID");
    else if (isEdgeKind(kind)) {
      // communication 须有明确传讯方式；route 须有可信连通信息；adjacent 只说明相邻，不得宣称传讯。
      if (kind === "communication" && channel !== "message") {
        push(`${path}.channel`, "GEO_COMMUNICATION_CHANNEL");
      }
      if (kind === "route" && channel !== "walk" && channel !== "vehicle") {
        push(`${path}.channel`, "GEO_ROUTE_CHANNEL");
      }
      if (kind === "adjacent" && channel === "message") push(`${path}.channel`, "GEO_ADJACENT_CHANNEL");
    }

    if (from !== null && to !== null && from === to) push(`${path}.toLocationId`, "GEO_EDGE_SELF");
    checkLocationRef(from, `${path}.fromLocationId`, "GEO_EDGE_LOCATION_UNKNOWN", ctx);
    checkLocationRef(to, `${path}.toLocationId`, "GEO_EDGE_LOCATION_UNKNOWN", ctx);

    if (from !== null && to !== null && isEdgeKind(kind)) {
      const [left, right] = orderEdgePair(from, to);
      const pairKey = `${kind}${GEO_ID_SEP}${left}${GEO_ID_SEP}${right}`;
      if (edgePairs.has(pairKey)) push(`${path}.id`, "GEO_EDGE_DUPLICATE");
      else edgePairs.add(pairKey);
      if (id !== null && branchKey !== null && id !== geoEdgeId(branchKey, from, to, kind)) {
        push(`${path}.id`, "GEO_EDGE_ID_MISMATCH");
      }
      if (id !== null) {
        edgeById.set(id, {
          id,
          fromLocationId: from,
          toLocationId: to,
          kind,
          evidence: isEvidence(row.evidence) ? row.evidence : "manual",
          channel: isChannelValue(channel) ? channel : null,
        });
      }
    }
  }

  /* ------------------------------ areas ------------------------------ */

  const areaIds = new Set<string>();
  const areaKeys = new Set<string>();

  for (const { row, index } of areaRows) {
    const path = geoPath(branchKey, `areas[${index}]`);
    const id = checkRowId(row, path, areaIds, push);
    const locationId = readId(row, "locationId", path, push);
    const mapId = row.mapId;

    if (mapId === undefined) push(`${path}.mapId`, "GEO_FIELD_MISSING");
    else if (typeof mapId !== "string" || mapId.length === 0) push(`${path}.mapId`, "GEO_AREA_MAP_REQUIRED");
    if (!isEvidence(row.evidence)) push(`${path}.evidence`, "GEO_EVIDENCE_INVALID");
    checkLocationRef(locationId, `${path}.locationId`, "GEO_AREA_LOCATION_UNKNOWN", ctx);

    if (typeof mapId === "string" && mapId.length > 0 && locationId !== null) {
      const key = `${mapId}${GEO_ID_SEP}${locationId}`;
      if (areaKeys.has(key)) push(`${path}.id`, "GEO_AREA_DUPLICATE");
      else areaKeys.add(key);
      if (id !== null && branchKey !== null && id !== geoAreaId(branchKey, mapId, locationId)) {
        push(`${path}.id`, "GEO_AREA_ID_MISMATCH");
      }
    }

    const cells = row.cells;
    if (!Array.isArray(cells)) {
      push(`${path}.cells`, "GEO_AREA_CELLS_NOT_ARRAY");
      continue;
    }
    if (cells.length > ATLAS_GEO_LIMITS.areaCells) push(`${path}.cells`, "GEO_AREA_CELLS_EXCEEDED");
    const frame = frameOf(mapId);
    const cellSeen = new Set<string>();
    cells.forEach((cell, cellIndex) => {
      const cellPath = `${path}.cells[${cellIndex}]`;
      if (!isObj(cell)) {
        push(cellPath, "GEO_AREA_CELL_INVALID");
        return;
      }
      const x = cell.x;
      const y = cell.y;
      if (!isGridIndex(x) || !isGridIndex(y)) {
        push(cellPath, "GEO_AREA_CELL_INVALID");
        return;
      }
      const key = `${x},${y}`;
      if (cellSeen.has(key)) push(cellPath, "GEO_AREA_CELL_DUPLICATE");
      else cellSeen.add(key);
      if (frame !== null && (x >= frame.cols || y >= frame.rows)) {
        push(cellPath, "GEO_AREA_CELL_OUT_OF_FRAME");
      }
    });
  }

  /* ---------------------------- vehicles ---------------------------- */

  const vehicleIds = new Set<string>();

  for (const { row, index } of vehicleRows) {
    const path = geoPath(branchKey, `vehicles[${index}]`);
    const id = checkRowId(row, path, vehicleIds, push);
    const locationId = readId(row, "locationId", path, push);
    const status = row.status;
    const atLocationId = row.atLocationId;
    const routeEdgeId = row.routeEdgeId;

    if (!isVehicleStatus(status)) push(`${path}.status`, "GEO_VEHICLE_STATUS_INVALID");
    if (!isEvidence(row.evidence)) push(`${path}.evidence`, "GEO_EVIDENCE_INVALID");
    if (atLocationId === undefined) push(`${path}.atLocationId`, "GEO_FIELD_MISSING");
    else if (atLocationId !== null && typeof atLocationId !== "string") {
      push(`${path}.atLocationId`, "GEO_FIELD_TYPE");
    } else if (typeof atLocationId === "string" && atLocationId.length === 0) {
      push(`${path}.atLocationId`, "GEO_ID_MISSING");
    }
    if (routeEdgeId === undefined) push(`${path}.routeEdgeId`, "GEO_FIELD_MISSING");
    else if (routeEdgeId !== null && typeof routeEdgeId !== "string") {
      push(`${path}.routeEdgeId`, "GEO_FIELD_TYPE");
    } else if (typeof routeEdgeId === "string" && routeEdgeId.length === 0) {
      push(`${path}.routeEdgeId`, "GEO_ID_MISSING");
    }
    if (id !== null && locationId !== null && id !== locationId) {
      push(`${path}.id`, "GEO_VEHICLE_ID_MISMATCH");
    }
    checkLocationRef(locationId, `${path}.locationId`, "GEO_VEHICLE_LOCATION_UNKNOWN", ctx);

    if (status === "stopped") {
      if (atLocationId === null || atLocationId === undefined) {
        push(`${path}.atLocationId`, "GEO_VEHICLE_STOP_REQUIRED");
      } else if (typeof atLocationId === "string") {
        checkLocationRef(atLocationId, `${path}.atLocationId`, "GEO_VEHICLE_AT_UNKNOWN", ctx);
      }
    } else if (isVehicleStatus(status) && atLocationId !== null && atLocationId !== undefined) {
      push(`${path}.atLocationId`, "GEO_VEHICLE_AT_UNEXPECTED");
    }

    if (typeof routeEdgeId === "string" && routeEdgeId.length > 0) {
      if (status !== "en-route") push(`${path}.routeEdgeId`, "GEO_VEHICLE_ROUTE_STATUS");
      const edge = edgeById.get(routeEdgeId);
      if (edge === undefined) push(`${path}.routeEdgeId`, "GEO_VEHICLE_ROUTE_UNKNOWN");
      else if (edge.kind !== "route") push(`${path}.routeEdgeId`, "GEO_VEHICLE_ROUTE_KIND");
      else if (
        locationId !== null &&
        edge.fromLocationId !== locationId &&
        edge.toLocationId !== locationId
      ) {
        push(`${path}.routeEdgeId`, "GEO_VEHICLE_ROUTE_MISMATCH");
      }
    }
  }

  if (frameOptionInvalid) push(geoPath(branchKey, "areas"), "GEO_FRAME_INVALID");

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

/* ------------------------------------------------------------------ *
 * H01 / H05 边界：关系判定口径（地名相似不算证据）
 * ------------------------------------------------------------------ */

export type AtlasGeoRelationVerdict = "contained" | "adjacent" | "none" | "pending";

export interface AtlasGeoRelationCandidate {
  /** 候选关系（模型提炼或人工输入）：contained = 包含，adjacent = 相邻，none = 无关系。 */
  relation?: "contained" | "adjacent" | "none";
  /** 关系依据的连续原文（世界书 / 助手正文）；`manual` 依据可由用户显式确认代替。 */
  evidenceQuote?: string | null;
  /** 依据来源；manual = 用户在会话里人工确认。 */
  evidence?: AtlasGeoEvidence | null;
  /** 两端名称：只回带用于展示，**绝不参与判定**（H01：不因地名相似造关系）。 */
  fromName?: string;
  toName?: string;
}

export interface AtlasGeoRelationDecision {
  verdict: AtlasGeoRelationVerdict;
  reasonCode: "EVIDENCE_CONFIRMED" | "NO_RELATION" | "NO_EVIDENCE";
  evidenceQuote: string | null;
  fromName: string | null;
  toName: string | null;
}

/**
 * H01 / H05 之间唯一的关系判定口径：**只有带依据的关系才能建立**。
 *
 * - `relation` 缺省或 `none` → `none`（不建立任何行）；
 * - `manual` 依据 = 用户显式确认，可直接成立；
 * - 其余来源必须有非空引用原文，否则一律 `pending`（待确认）；
 * - 名称只回带，不参与判定：「圣罗兰外城区」含「圣罗兰城」这种相似**不是**证据。
 */
export function judgeGeoRelation(candidate: AtlasGeoRelationCandidate): AtlasGeoRelationDecision {
  const relation = candidate.relation ?? "none";
  const quote =
    typeof candidate.evidenceQuote === "string" && candidate.evidenceQuote.trim().length > 0
      ? candidate.evidenceQuote
      : null;
  const base = {
    evidenceQuote: quote,
    fromName: typeof candidate.fromName === "string" ? candidate.fromName : null,
    toName: typeof candidate.toName === "string" ? candidate.toName : null,
  };
  if (relation === "none") return { verdict: "none", reasonCode: "NO_RELATION", ...base };
  if (candidate.evidence === "manual") {
    return { verdict: relation, reasonCode: "EVIDENCE_CONFIRMED", ...base };
  }
  if (quote === null) return { verdict: "pending", reasonCode: "NO_EVIDENCE", ...base };
  return { verdict: relation, reasonCode: "EVIDENCE_CONFIRMED", ...base };
}

/* ------------------------------------------------------------------ *
 * H10：只读邻接表与 NO_PATH 语义
 * ------------------------------------------------------------------ */

export interface AtlasGeoNeighbor {
  /** 对端地点 id。 */
  locationId: string;
  edgeId: string;
  kind: AtlasGeoEdgeKind;
  channel: AtlasGeoChannel;
  evidence: AtlasGeoEvidence;
}

export interface AtlasGeoAdjacency {
  /** 地点 id → 只读邻居列表（按对端 id + 边 id 排序，结果稳定）。 */
  readonly neighbors: ReadonlyMap<string, readonly AtlasGeoNeighbor[]>;
  /** 参与建表的边数。 */
  readonly edgeCount: number;
  /** 自指边（from === to）不产生邻居，单独列出供调用方诊断。 */
  readonly selfLoopEdgeIds: readonly string[];
}

function buildAdjacency(
  edges: readonly AtlasGeoEdge[],
  usable: (edge: AtlasGeoEdge) => boolean,
): AtlasGeoAdjacency {
  const neighbors = new Map<string, AtlasGeoNeighbor[]>();
  const selfLoopEdgeIds: string[] = [];
  let edgeCount = 0;
  const add = (from: string, to: string, edge: AtlasGeoEdge): void => {
    const list = neighbors.get(from);
    const entry: AtlasGeoNeighbor = {
      locationId: to,
      edgeId: edge.id,
      kind: edge.kind,
      channel: edge.channel,
      evidence: edge.evidence,
    };
    if (list === undefined) neighbors.set(from, [entry]);
    else list.push(entry);
  };
  for (const edge of edges) {
    if (!usable(edge)) continue;
    edgeCount += 1;
    if (edge.fromLocationId === edge.toLocationId) {
      selfLoopEdgeIds.push(edge.id);
      continue;
    }
    add(edge.fromLocationId, edge.toLocationId, edge);
    add(edge.toLocationId, edge.fromLocationId, edge);
  }
  for (const list of neighbors.values()) {
    list.sort((a, b) => (a.locationId === b.locationId ? a.edgeId.localeCompare(b.edgeId) : a.locationId.localeCompare(b.locationId)));
  }
  return { neighbors, edgeCount, selfLoopEdgeIds };
}

/**
 * H10：由 edges 构造只读邻接表（含 communication，供消息传播复用）。
 *
 * **容器 parent 链不参与**：本表只读 edges，父链只代表进入 / 离开容器，不自动成为异地直达通道（§2.5）。
 * 地点没有确认边时不会出现在表里 —— 调用方必须按 `NO_PATH` 处理，不许猜路径。
 */
export function buildEdgeAdjacency(topology: AtlasGeoTopology): AtlasGeoAdjacency {
  return buildAdjacency(topology.edges, () => true);
}

/**
 * H10：人物物理路线用的只读邻接表 —— **排除 `kind:"communication"`**。
 * 传讯边只能传消息，不能让人走过去（§2.5）；`adjacent` / `route` 才可通行。
 */
export function buildWalkableAdjacency(topology: AtlasGeoTopology): AtlasGeoAdjacency {
  return buildAdjacency(topology.edges, (edge) => edge.kind !== "communication");
}

/** 邻居查询：没有确认边时返回空数组（调用方据此报 NO_PATH，而不是猜一条路）。 */
export function neighborsOf(adjacency: AtlasGeoAdjacency, locationId: string): readonly AtlasGeoNeighbor[] {
  return adjacency.neighbors.get(locationId) ?? [];
}

export type AtlasGeoPathMode = "walk" | "vehicle" | "message" | "any";

export type AtlasGeoPathResult =
  | { ok: true; path: readonly string[]; edgeIds: readonly string[]; hops: number }
  | { ok: false; reasonCode: "NO_PATH"; fromLocationId: string; toLocationId: string };

function edgeUsableFor(edge: AtlasGeoEdge, mode: AtlasGeoPathMode): boolean {
  if (mode === "any") return true;
  if (mode === "message") return edge.kind === "communication";
  if (mode === "vehicle") return edge.kind === "route" && edge.channel === "vehicle";
  // walk：邻接与路线都能走；通信边只能传讯（§2.5「步行跨区必须邻接/路线」）。
  return edge.kind === "adjacent" || edge.kind === "route";
}

/**
 * H10：在已确认边上找最短路（按跳数，邻居排序固定 → 结果确定）。
 *
 * - `mode` 缺省 `walk`；`vehicle` 只走 `channel="vehicle"` 的 route 边；
 *   `message` 只走 communication 边（**不得**当成人物物理路线）。
 * - 起点等于终点：返回 0 跳（人已经在里面，不需要路）。
 * - 无边 / 不可达 / 但两地在同一容器父链上：**一律 `NO_PATH`**，绝不把包含关系当通道。
 */
export function resolveGeoPath(
  topology: AtlasGeoTopology,
  fromLocationId: string,
  toLocationId: string,
  options: { mode?: AtlasGeoPathMode } = {},
): AtlasGeoPathResult {
  const mode = options.mode ?? "walk";
  if (fromLocationId === toLocationId) {
    return { ok: true, path: [fromLocationId], edgeIds: [], hops: 0 };
  }
  const adjacency = buildAdjacency(topology.edges, (edge) => edgeUsableFor(edge, mode));
  const cameFrom = new Map<string, { previous: string; edgeId: string }>();
  const visited = new Set<string>([fromLocationId]);
  const queue: string[] = [fromLocationId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const neighbor of neighborsOf(adjacency, current)) {
      if (visited.has(neighbor.locationId)) continue;
      visited.add(neighbor.locationId);
      cameFrom.set(neighbor.locationId, { previous: current, edgeId: neighbor.edgeId });
      queue.push(neighbor.locationId);
    }
  }
  const path: string[] = [toLocationId];
  const edgeIds: string[] = [];
  let cursor = toLocationId;
  while (cursor !== fromLocationId) {
    const step = cameFrom.get(cursor);
    if (step === undefined) {
      return { ok: false, reasonCode: "NO_PATH", fromLocationId, toLocationId };
    }
    edgeIds.push(step.edgeId);
    path.push(step.previous);
    cursor = step.previous;
  }
  path.reverse();
  edgeIds.reverse();
  return { ok: true, path, edgeIds, hops: edgeIds.length };
}

/* ------------------------------------------------------------------ *
 * H11：移动载具锚点（纯函数；时段 + 已确认路线才动）
 * ------------------------------------------------------------------ */

export type AtlasGeoUndoCollection =
  | "tasks"
  | "signals"
  | "deliveries"
  | "edges"
  | "areas"
  | "vehicles";

/** 本模块拥有的行类型；推演行（tasks / signals / deliveries）的行类型由推演模块自己维护。 */
export type AtlasGeoUndoRow = AtlasGeoEdge | AtlasGeoArea | AtlasVehicleAnchor;

/** §2.1 turn.simulationUndo 的一项：逆向恢复精确到行，`before: null` = 这一行本来不存在。 */
export interface AtlasGeoUndoEntry {
  collection: AtlasGeoUndoCollection;
  id: string;
  before: AtlasGeoUndoRow | null;
}

/** 从 undo 项里取载具行快照（collection 不是 vehicles 时返回 null），供后续回合回退。 */
export function undoVehicleBefore(entry: AtlasGeoUndoEntry): AtlasVehicleAnchor | null {
  if (entry.collection !== "vehicles" || entry.before === null) return null;
  const row = entry.before as AtlasVehicleAnchor;
  if (typeof row !== "object" || row === null || typeof row.locationId !== "string") return null;
  if (!isVehicleStatus(row.status) || !isEvidence(row.evidence)) return null;
  return row;
}

export type AtlasGeoDiagnosticCode =
  | "TOPOLOGY_INVALID"
  | "INTENT_INVALID"
  | "NO_TIME"
  | "VEHICLE_ANCHOR_MISSING"
  | "VEHICLE_NOT_ANCHORED"
  | "ROUTE_NOT_FOUND"
  | "ROUTE_NOT_CONFIRMED"
  | "ROUTE_MISMATCH"
  | "LOCATION_UNKNOWN"
  | "TRAVEL_PERIODS_INVALID"
  | "TRAVEL_PERIODS_UNKNOWN";

export interface AtlasGeoDiagnostic {
  code: AtlasGeoDiagnosticCode;
  /** true = 本次没有任何字段被改（车辆一个字段都没动，调用方不得写回）。 */
  blocked: boolean;
  locationId: string | null;
  edgeId: string | null;
  /** 本次可用时段（原样回带，便于调用方核对时间游标）。 */
  periods: number;
}

export interface AtlasGeoMoveEvent {
  /** turnKey + 序号 + 载具 + 结果，确定性生成（不用时间）。 */
  id: string;
  kind: "travel";
  status: "started" | "progressed" | "arrived" | "blocked";
  vehicleLocationId: string;
  /** 移动前锚点的停靠点；在途 / 不明时为 null（行里没有更早的出发端）。 */
  fromLocationId: string | null;
  /** 本段终点（blocked 时是本次意图的终点或 null）。 */
  toLocationId: string | null;
  routeEdgeId: string | null;
  /** 本次真正消耗的新时段（blocked 恒为 0；到达时只算本段所需时段）。 */
  periods: number;
  /** 本段走完还需要的时段；null = 耗时不可信（此时**绝不到达**）。 */
  remainingPeriods: number | null;
  /** 走完本段后本次还剩多少时段（本函数一段一调用，不自动跨段）。 */
  leftoverPeriods: number;
  /** 载具本体移动前的位置状态。 */
  statusBefore: AtlasVehicleStatus;
  statusAfter: AtlasVehicleStatus;
  /** 车厢乘员（相对车厢位置不变，读世界位置须经锚点解析）。 */
  crewCharacterIds: readonly string[];
  evidence: AtlasGeoEvidence;
  reasonCode: AtlasGeoDiagnosticCode | null;
  /** 调用方给的时段号，仅回带；本模块不读时间游标。 */
  period: number | null;
}

export interface AtlasVehicleDepartIntent {
  kind: "depart";
  /** 已确认路线：必须在 edges 里存在、`kind="route"`、channel 为 walk / vehicle。 */
  routeEdgeId: string;
  /** 本段终点：必须是该 route 边的另一端。 */
  toLocationId: string;
  /** 走完本段还需要的完整时段数；`null` = 没有可信耗时 → 只进在途，绝不到达。 */
  remainingPeriods: number | null;
  /** 本段依据；缺省沿用该车现有锚点的 evidence（不凭空升级证据）。 */
  evidence?: AtlasGeoEvidence;
}

export interface AtlasVehicleMoveInput {
  /** 本回合的 turnKey（事件 id 前缀）；本模块不用时间造 ID。 */
  turnKey: string;
  topology: AtlasGeoTopology;
  /** 载具本体地点行 id（必须已有一条 vehicle 锚点）。 */
  vehicleLocationId: string;
  intent: AtlasVehicleDepartIntent;
  /** 本次可用的完整新时段数；0 = 时间未推进 → 车辆一动不动。 */
  periods: number;
  /** 同一 turnKey 内多次移动用不同序号，事件 id 才不撞（默认 0）。 */
  eventIndex?: number;
  /** 时段号，仅回带进事件。 */
  period?: number | null;
  /** 该分支地点表（可选）：给了才校验终点存在与车厢子地点。 */
  locations?: readonly AtlasLocationRow[];
  /** 该分支人物表（可选）：给了才解析车厢乘员清单一并回带。 */
  characters?: readonly AtlasCharacterRow[];
}

export interface AtlasVehicleMoveResult {
  /** 应用后的拓扑（始终是深拷贝；blocked 时与入参等值）。 */
  next: AtlasGeoTopology;
  events: AtlasGeoMoveEvent[];
  undo: AtlasGeoUndoEntry[];
  diagnostics: AtlasGeoDiagnostic[];
}

export interface AtlasVehicleCrewMember {
  characterId: string;
  /** 人物行自己的归属地点（载具本体或车厢子地点）。 */
  locationId: string | null;
  /** 人物所在图；车厢子地点内的人物其相对坐标不随车辆移动改变。 */
  mapId: string | null;
  gridX: number | null;
  gridY: number | null;
  /** true = 在车厢子地点内（相对车厢的位置不变，世界位置经锚点解析）。 */
  inCabin: boolean;
}

export interface AtlasVehicleCrewView {
  vehicleLocationId: string;
  status: AtlasVehicleStatus;
  atLocationId: string | null;
  routeEdgeId: string | null;
  /** 在场乘员（按人物 id 排序，结果稳定）。 */
  members: AtlasVehicleCrewMember[];
}

function readAnchors(value: unknown): AtlasVehicleAnchor[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is AtlasVehicleAnchor =>
      isObj(item) && typeof item.id === "string" && typeof item.locationId === "string",
  );
}

function readEdges(value: unknown): AtlasGeoEdge[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is AtlasGeoEdge =>
      isObj(item) &&
      typeof item.id === "string" &&
      typeof item.fromLocationId === "string" &&
      typeof item.toLocationId === "string" &&
      isEdgeKind(item.kind),
  );
}

function readTopology(value: unknown): AtlasGeoTopology | null {
  if (!isObj(value)) return null;
  if (!Array.isArray(value.edges) || !Array.isArray(value.areas) || !Array.isArray(value.vehicles)) {
    return null;
  }
  return value as unknown as AtlasGeoTopology;
}

function diagnostic(
  code: AtlasGeoDiagnosticCode,
  blocked: boolean,
  extra: Partial<AtlasGeoDiagnostic> = {},
): AtlasGeoDiagnostic {
  return { code, blocked, locationId: null, edgeId: null, periods: 0, ...extra };
}

/**
 * 解析某载具的在场乘员（H11 / H07 复用）。
 *
 * 乘员 = 人物行 `locationId` 等于载具本体地点，或等于**其车厢子地点**（沿 `parentLocationId`
 * 上溯到载具本体）。人物自己的 `mapId / gridX / gridY` 是相对所在图的坐标，车辆移动时**不改**；
 * 读世界位置请用返回的锚点（`atLocationId` / `routeEdgeId` / `status`）解析。
 * 没有锚点行时 `status` 报 `"unknown"`（未确认，不猜停靠点）。
 */
export function resolveVehicleCrew(
  topology: AtlasGeoTopology,
  vehicleLocationId: string,
  locations: readonly AtlasLocationRow[] = [],
  characters: readonly AtlasCharacterRow[] = [],
): AtlasVehicleCrewView {
  const anchors = readAnchors(topology?.vehicles);
  const anchor = anchors.find((item) => item.locationId === vehicleLocationId || item.id === vehicleLocationId);
  const parentOf = new Map<string, string | null>();
  for (const row of Array.isArray(locations) ? locations : []) {
    if (!isObj(row) || typeof row.id !== "string") continue;
    const parent = row.parentLocationId;
    parentOf.set(row.id, typeof parent === "string" && parent.length > 0 ? parent : null);
  }
  const members: AtlasVehicleCrewMember[] = [];
  for (const row of Array.isArray(characters) ? characters : []) {
    if (!isObj(row) || typeof row.id !== "string") continue;
    if (row.presence === "left") continue;
    const locationId = typeof row.locationId === "string" && row.locationId.length > 0 ? row.locationId : null;
    if (locationId === null) continue;
    let inCabin = false;
    let cursor: string | null = locationId;
    const seen = new Set<string>();
    while (cursor !== null && !seen.has(cursor)) {
      if (cursor === vehicleLocationId) {
        inCabin = true;
        break;
      }
      seen.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
    if (!inCabin) continue;
    members.push({
      characterId: row.id,
      locationId,
      mapId: typeof row.mapId === "string" ? row.mapId : null,
      gridX: typeof row.gridX === "number" ? row.gridX : null,
      gridY: typeof row.gridY === "number" ? row.gridY : null,
      inCabin: locationId !== vehicleLocationId,
    });
  }
  members.sort((a, b) => a.characterId.localeCompare(b.characterId));
  return {
    vehicleLocationId,
    status: anchor?.status ?? "unknown",
    atLocationId: anchor?.atLocationId ?? null,
    routeEdgeId: anchor?.routeEdgeId ?? null,
    members,
  };
}

function moveEventId(
  turnKey: string,
  eventIndex: number,
  vehicleLocationId: string,
  status: AtlasGeoMoveEvent["status"],
): string {
  return joinGeoId([turnKey, String(eventIndex), "travel", vehicleLocationId, status]);
}

/**
 * H11：移动一辆已确认停靠或在途的载具锚点（纯函数，不做 IO）。
 *
 * 规则（每条都有对应用例）：
 * - **0 时段不动**：`periods ≤ 0` → 一个字段都不改，只留 `NO_TIME` 诊断与一条 blocked 事件；
 * - **未知道路不动**：路线不存在 / 不是 route / 没有 walk|vehicle 通行信息 / 该边不与载具本体相连 /
 *   在途却换路 / 终点不是该边的另一端 → blocked；
 * - **状态不明不动**：`status:"unknown"` 或「停靠却没有确认地点」→ 不允许凭空出发（人工确认走 H07a）；
 * - **时段足够且路线确认才到达**：`periods ≥ remainingPeriods` → stopped@终点、routeEdgeId 清空；
 *   否则进在途（`atLocationId=null`、`routeEdgeId=边`）；`remainingPeriods=null`（耗时不可信）
 *   只进在途、**绝不到达**，并留 `TRAVEL_PERIODS_UNKNOWN` 诊断；
 * - **车厢子地点内人物相对车厢位置不变**：本函数**不碰任何人物行**（§2.5「整辆车移动时不重新制造
 *   每人的世界坐标」），乘员世界位置由锚点解析（见 `resolveVehicleCrew`）；
 * - 返回本次精确变更与 `undo`（`{collection:"vehicles", id, before}`，`before` 是**本次移动前**整行），
 *   供 C10 回退；同一 turn 内多次移动时，回退按「同一 id 取最早一项的 before」合并即整轮还原。
 *   `next` 始终是深拷贝，调用方可无条件写回。
 */
export function moveVehicleAnchor(input: AtlasVehicleMoveInput): AtlasVehicleMoveResult {
  const topology = readTopology(input?.topology);
  if (topology === null) {
    return {
      next: createEmptyTopology(),
      events: [],
      undo: [],
      diagnostics: [diagnostic("TOPOLOGY_INVALID", true)],
    };
  }
  const next = cloneGeoTopology(topology);
  const periods = toPeriodCount(input?.periods, 0);
  const vehicleLocationId = typeof input?.vehicleLocationId === "string" ? input.vehicleLocationId : "";
  const intent = input?.intent;
  const period = typeof input?.period === "number" && Number.isFinite(input.period) ? input.period : null;
  const eventIndex = toPeriodCount(input?.eventIndex, 0);
  const edges = readEdges(next.edges);
  const locations = Array.isArray(input?.locations) ? input.locations : [];
  const characters = Array.isArray(input?.characters) ? input.characters : [];

  const blocked = (code: AtlasGeoDiagnosticCode, extra: Partial<AtlasGeoDiagnostic> = {}): AtlasVehicleMoveResult => {
    const anchor = next.vehicles.find(
      (item) => item.locationId === vehicleLocationId || item.id === vehicleLocationId,
    );
    const event: AtlasGeoMoveEvent = {
      id: moveEventId(
        typeof input?.turnKey === "string" && input.turnKey.length > 0 ? input.turnKey : "turn",
        eventIndex,
        vehicleLocationId,
        "blocked",
      ),
      kind: "travel",
      status: "blocked",
      vehicleLocationId,
      fromLocationId: anchor?.atLocationId ?? null,
      toLocationId: isObj(intent) && typeof intent.toLocationId === "string" ? intent.toLocationId : null,
      routeEdgeId: isObj(intent) && typeof intent.routeEdgeId === "string" ? intent.routeEdgeId : null,
      periods: 0,
      remainingPeriods:
        isObj(intent) && typeof intent.remainingPeriods === "number" ? intent.remainingPeriods : null,
      leftoverPeriods: 0,
      statusBefore: anchor?.status ?? "unknown",
      statusAfter: anchor?.status ?? "unknown",
      crewCharacterIds: resolveVehicleCrew(next, vehicleLocationId, locations, characters).members.map(
        (member) => member.characterId,
      ),
      evidence: anchor?.evidence ?? "manual",
      reasonCode: code,
      period,
    };
    return {
      next,
      events: [event],
      undo: [],
      diagnostics: [diagnostic(code, true, { locationId: vehicleLocationId || null, periods, ...extra })],
    };
  };

  if (!isObj(intent) || intent.kind !== "depart") return blocked("INTENT_INVALID");
  const routeEdgeId = typeof intent.routeEdgeId === "string" ? intent.routeEdgeId : "";
  const toLocationId = typeof intent.toLocationId === "string" ? intent.toLocationId : "";
  const remainingRaw = intent.remainingPeriods;
  const diagnostics: AtlasGeoDiagnostic[] = [];

  // 时间闸：没有任何新时段，车辆一个字段都不动（§2.5 第 0 时段规则）。
  if (periods <= 0) return blocked("NO_TIME", { edgeId: routeEdgeId || null });

  const anchorIndex = next.vehicles.findIndex(
    (item) => item.locationId === vehicleLocationId || item.id === vehicleLocationId,
  );
  if (vehicleLocationId.length === 0 || anchorIndex < 0) {
    return blocked("VEHICLE_ANCHOR_MISSING", { edgeId: routeEdgeId || null });
  }
  const anchor = next.vehicles[anchorIndex];

  const edge = edges.find((item) => item.id === routeEdgeId);
  if (edge === undefined) return blocked("ROUTE_NOT_FOUND", { edgeId: routeEdgeId || null });
  if (edge.kind !== "route" || (edge.channel !== "walk" && edge.channel !== "vehicle")) {
    return blocked("ROUTE_NOT_CONFIRMED", { edgeId: edge.id });
  }
  if (anchor.status === "unknown") return blocked("VEHICLE_NOT_ANCHORED", { edgeId: edge.id });
  if (anchor.status === "stopped" && anchor.atLocationId === null) {
    return blocked("VEHICLE_NOT_ANCHORED", { edgeId: edge.id });
  }
  if (anchor.status === "en-route" && anchor.routeEdgeId === null) {
    // 在途但自己的路线未知（待定位）：先确认锚点，不许猜一条路继续走。
    return blocked("ROUTE_NOT_CONFIRMED", { edgeId: edge.id });
  }
  if (anchor.status === "en-route" && anchor.routeEdgeId !== edge.id) {
    // 一段没走完不许换路。
    return blocked("ROUTE_MISMATCH", { edgeId: edge.id });
  }
  // 「routeEdgeId 要匹配该地点所在路线」：H02 与 H11 同一口径 —— 该边必须与**载具本体地点**
  // （locationId）相连；两地之间的公路是另一类 route 边，供 H10 的分段移动使用，不能冒充某辆车的路线。
  const selfLocationId = anchor.locationId;
  if (edge.fromLocationId !== selfLocationId && edge.toLocationId !== selfLocationId) {
    return blocked("ROUTE_MISMATCH", { edgeId: edge.id });
  }
  const destination = edge.fromLocationId === selfLocationId ? edge.toLocationId : edge.fromLocationId;
  if (toLocationId !== destination) return blocked("ROUTE_MISMATCH", { edgeId: edge.id });
  if (anchor.status === "stopped" && anchor.atLocationId === destination) {
    // 已在该段终点停靠，不必再走一次。
    return blocked("ROUTE_MISMATCH", { edgeId: edge.id });
  }
  if (
    locations.length > 0 &&
    !locations.some((row) => isObj(row) && row.id === toLocationId)
  ) {
    return blocked("LOCATION_UNKNOWN", { edgeId: edge.id });
  }

  const wasEnRoute = anchor.status === "en-route";
  const before: AtlasVehicleAnchor = { ...anchor };
  const evidence = isEvidence(intent.evidence) ? intent.evidence : anchor.evidence;
  const crewCharacterIds = resolveVehicleCrew(next, vehicleLocationId, locations, characters).members.map(
    (member) => member.characterId,
  );

  let status: AtlasVehicleStatus;
  let atLocationId: string | null;
  let activeRouteEdgeId: string | null;
  let remainingPeriods: number | null;
  let spentPeriods: number;
  let leftoverPeriods: number;
  let eventStatus: AtlasGeoMoveEvent["status"];

  if (remainingRaw === null || remainingRaw === undefined) {
    status = "en-route";
    atLocationId = null;
    activeRouteEdgeId = edge.id;
    remainingPeriods = null;
    spentPeriods = periods;
    leftoverPeriods = 0;
    eventStatus = wasEnRoute ? "progressed" : "started";
    diagnostics.push(
      diagnostic("TRAVEL_PERIODS_UNKNOWN", false, {
        locationId: vehicleLocationId,
        edgeId: edge.id,
        periods,
      }),
    );
  } else if (typeof remainingRaw !== "number" || !Number.isFinite(remainingRaw) || remainingRaw < 1) {
    return blocked("TRAVEL_PERIODS_INVALID", { edgeId: edge.id });
  } else {
    const remaining = Math.floor(remainingRaw);
    if (periods >= remaining) {
      status = "stopped";
      atLocationId = toLocationId;
      activeRouteEdgeId = null;
      remainingPeriods = 0;
      spentPeriods = remaining;
      leftoverPeriods = periods - remaining;
      eventStatus = "arrived";
    } else {
      status = "en-route";
      atLocationId = null;
      activeRouteEdgeId = edge.id;
      remainingPeriods = remaining - periods;
      spentPeriods = periods;
      leftoverPeriods = 0;
      eventStatus = wasEnRoute ? "progressed" : "started";
    }
  }

  next.vehicles[anchorIndex] = {
    ...anchor,
    atLocationId,
    routeEdgeId: activeRouteEdgeId,
    status,
    evidence,
  };

  const event: AtlasGeoMoveEvent = {
    id: moveEventId(
      typeof input?.turnKey === "string" && input.turnKey.length > 0 ? input.turnKey : "turn",
      eventIndex,
      vehicleLocationId,
      eventStatus,
    ),
    kind: "travel",
    status: eventStatus,
    vehicleLocationId,
    fromLocationId: before.atLocationId,
    toLocationId,
    routeEdgeId: activeRouteEdgeId,
    periods: spentPeriods,
    remainingPeriods,
    leftoverPeriods,
    statusBefore: before.status,
    statusAfter: status,
    crewCharacterIds,
    evidence,
    reasonCode: null,
    period,
  };

  return {
    next,
    events: [event],
    undo: [{ collection: "vehicles", id: before.id, before }],
    diagnostics,
  };
}
