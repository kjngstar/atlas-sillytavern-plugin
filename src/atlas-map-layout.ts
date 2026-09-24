/**
 * atlas-map-layout.ts — H08：只给「没有坐标的地点」生成渲染用示意位置（纯函数，零 IO、零副作用）。
 *
 * 依据（计划 §2.4 / §2.5 与 H08 原文）：
 * - §2.4：「地点 gridX/Y 未知则不画地理标点，出『待定位地点』列表供点击，不能冒充 (0,0)」；
 *   「图钉碰撞解决只能偏移视觉标签，不修改真实数据的格坐标」。
 * - §2.5 层级表：蒸汽马车厢是 mobile vehicle，**不随机成为世界图固定坐标**；停靠可附在
 *   停靠点，行进显示路线标记，未知进「在途/待定位」列表。
 * - H08：「新增 src/atlas-map-layout.ts / layoutUnplacedMarkers：仅给没有坐标的地点生成渲染用
 *   位置 {x,y,displayOnly:true}，在对应图内稳定排版；同一分支相同实体 ID 和 frame 重绘布局不
 *   跳动；不能回写地点表/world；保留现存人工坐标，视觉避让不能改变碰撞检测使用的真实坐标」；
 *   「完成：重开地图/调整窗口不能把房间搬进世界图或让车厢变成永久点」。
 *
 * 本模块的可验证承诺：
 * 1. **纯**：不读时钟、不用随机数、不改任何输入对象、不碰 world / 三表 / 任何存储。布局只是
 *    (branchKey, mapId, frame, 已确证坐标集合, 待定实体 ID 集合) 的确定性函数——同一分支、
 *    相同实体 ID、相同 frame 重绘**逐字节一致**；本模块没有 viewport/window 参数，窗口尺寸
 *    不进入任何计算，所以调整窗口在原理上不可能搬动标记。
 * 2. **两类点分得清**：confirmed = 真实坐标（原样回显，displayOnly:false）；displayOnly =
 *    渲染用示意位置（displayOnly:true + coordinateStatus:"schematic"）。碰撞检测/距离只能读
 *    collisionPoints（= confirmed），示意点永不参与。
 * 3. **原点 (0,0) 永不出现**在示意位置里：未知坐标不得冒充 (0,0)。示意格一律落在 frame 内，
 *    且优先贴 frame 边栏（图上的「待定位」区），避免伪装成图内真实地理点。
 * 4. **视觉避让只挪示意点**：已被真实坐标占用的格，示意点跳过；真实坐标一个字节都不改。
 * 5. **载具不变成永久点**：在途 / 锚点未知的载具本体不拿固定示意点，进「在途/待定位」名单。
 * 6. **上限显式**：分页上限、图内示意格容量都给 total/truncated 与逐条原因，不静默裁。
 */

import type { AtlasVehicleAnchor } from "./atlas-geo-topology.ts";

/** 单图示意点分页上限（与 H07 单图点位上口径一致；调用方可用 limit 覆盖）与示意格枚举硬上限。 */
export const ATLAS_MAP_LAYOUT_LIMITS = {
  markersPerMap: 200,
  slotsPerLayout: 4096,
} as const;

/** 能排出「非原点」示意格的最小 frame：cols/rows 都 ≥ 3 才有边栏与内格，否则只出待定位名单。 */
export const ATLAS_MAP_LAYOUT_MIN_FRAME = 3;

/** 坐标状态标签：UI 必须显示「示意/待定位」而非伪装测绘数据（§2.5 最后一段）。 */
export const ATLAS_MAP_LAYOUT_CONFIRMED_STATUS = "confirmed" as const;
export const ATLAS_MAP_LAYOUT_SCHEMATIC_STATUS = "schematic" as const;

export type AtlasMapLayoutCoordinateStatus =
  | typeof ATLAS_MAP_LAYOUT_CONFIRMED_STATUS
  | typeof ATLAS_MAP_LAYOUT_SCHEMATIC_STATUS;

/** 未拿到示意位置的原因（每条都要能显示给用户，不许静默丢）。 */
export type AtlasMapLayoutPendingReason =
  | "INVALID_ID"
  | "DUPLICATE_ID"
  | "WRONG_MAP"
  | "NO_FRAME"
  | "NO_SLOT"
  | "OVER_PAGE_LIMIT"
  | "OVER_SLOT_CAPACITY"
  | "VEHICLE_EN_ROUTE"
  | "VEHICLE_ANCHOR_UNKNOWN";

export interface AtlasMapLayoutFrame {
  cols: number;
  rows: number;
}

/** 已有真实坐标的标记（只读输入：只用于避让，绝不回显改写）。 */
export interface AtlasMapLayoutConfirmedInput {
  id: string;
  x: number;
  y: number;
}

/**
 * 本图缺坐标、需要示意位置的地点（由 H07 按 parentLocationId 逐层选好宿主图后交进来）。
 * 字段都可选：给得越多，本模块越能挡住「房间被搬进世界图」「车厢变成永久点」。
 */
export interface AtlasMapLayoutUnplacedInput {
  id: string;
  name?: string;
  /** 该地点行声明的宿主图（世界图 "world" / 子图宿主点 id）；与本图不符 → 不进本图示意。 */
  mapId?: string | null;
  /** 地点行 mobile：载具本体不随机成为固定点（§2.5）。 */
  mobile?: "vehicle" | "fixed" | null;
  /** 可选：把示意位置贴在一个**已有真实坐标**的锚点上（如停靠载具挂靠停靠点）。 */
  anchorId?: string | null;
}

export interface AtlasMapLayoutInput {
  /** 当前分支键（canon / IF 的 branchKey）；只作布局种子，不读任何分支数据。 */
  branchKey: string;
  /** 目标图 id：世界图 = "world"，子图 = 宿主地点数字点 id。 */
  mapId: string;
  /** 该图网格 frame（cols×rows）。frame 变了才允许重排。 */
  frame: AtlasMapLayoutFrame;
  /** 已有真实坐标的标记（只读）。 */
  confirmed?: readonly AtlasMapLayoutConfirmedInput[];
  /** 本图缺坐标、需要示意位置的地点。 */
  unplaced?: readonly AtlasMapLayoutUnplacedInput[];
  /** 当前分支 geoTopology.vehicles（只读）：判定载具在途/未知。 */
  vehicles?: readonly AtlasVehicleAnchor[];
  /** 本次最多给多少示意点（缺省 ATLAS_MAP_LAYOUT_LIMITS.markersPerMap）。 */
  limit?: number;
}

/** 真实坐标点：值原样回显，只加一个 displayOnly:false 便于 UI 分通道渲染。 */
export interface AtlasMapLayoutConfirmedMarker {
  id: string;
  x: number;
  y: number;
  displayOnly: false;
  coordinateStatus: typeof ATLAS_MAP_LAYOUT_CONFIRMED_STATUS;
}

/** 渲染用示意点：不是真实网格坐标，不得参与碰撞/距离/边界计算。 */
export interface AtlasMapLayoutDisplayMarker {
  id: string;
  name: string;
  x: number;
  y: number;
  displayOnly: true;
  coordinateStatus: typeof ATLAS_MAP_LAYOUT_SCHEMATIC_STATUS;
  /** 贴靠的真实坐标锚点 id（停靠载具用）；没有贴靠时为 null。 */
  anchorId: string | null;
}

export interface AtlasMapLayoutPendingEntry {
  id: string;
  name: string;
  reason: AtlasMapLayoutPendingReason;
  detail: string;
}

export interface AtlasMapLayoutDroppedConfirmed {
  id: string;
  reason: "INVALID_ID" | "INVALID_COORDINATE";
}

export interface AtlasMapLayoutCounts {
  /** 去重后需要示意位置的缺坐标地点数（含被门禁挡下的）。 */
  candidates: number;
  /** 回显的真实坐标点数（= collisionPoints.length）。 */
  confirmed: number;
  /** 本次实际给出的示意点数。 */
  displayOnly: number;
  /** 通过门禁、本应给示意位置的总数（含被分页/容量/frame 挡下的）。 */
  displayOnlyTotal: number;
  /** displayOnlyTotal - displayOnly。 */
  truncated: number;
  /** 待定位 / 在途 / 被拒名单条数。 */
  pending: number;
  limit: number;
  /** 本图可用于示意位置的格数（含边栏；frame 非法时为 0）。 */
  slotCapacity: number;
}

export interface AtlasMapLayoutResult {
  branchKey: string;
  mapId: string;
  frame: AtlasMapLayoutFrame;
  /** 真实坐标点（只读回显）：**这是唯一可以进碰撞检测/距离计算的点集**。 */
  confirmed: AtlasMapLayoutConfirmedMarker[];
  /** 与 confirmed 同内容的纯坐标视图，给碰撞检测直接使用（不含任何示意点）。 */
  collisionPoints: Array<{ id: string; x: number; y: number }>;
  /** 仅示意位置的点（渲染用；绝不回写三表/world）。 */
  displayOnly: AtlasMapLayoutDisplayMarker[];
  /** 未拿到位置的地点：待定位 / 在途 / 越界 / 上限。 */
  pending: AtlasMapLayoutPendingEntry[];
  /** 因坐标非法而无法回显的真实点（不静默丢）。 */
  droppedConfirmed: AtlasMapLayoutDroppedConfirmed[];
  counts: AtlasMapLayoutCounts;
}

// ---------------------------------------------------------------------------
// 内部工具（全部纯函数）
// ---------------------------------------------------------------------------

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** frame 规范化：非有限 / 非正 → 0（调用方按 NO_FRAME 处理）。 */
function normalizeFrame(raw: unknown): AtlasMapLayoutFrame {
  const record = asRecord(raw);
  const cols = Number(record?.cols);
  const rows = Number(record?.rows);
  return {
    cols: Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : 0,
    rows: Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 0,
  };
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** FNV-1a 32 位：确定性散列（不依赖平台随机源），保证同一实体 ID 永远落在同一起点格。 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 示意格序列长度：边栏（frame 四边，去掉原点）+ 图内格。
 * 边栏顺序 = 上（跳过原点）→ 右 → 下 → 左；总数 = cols×rows − 1，即除原点 (0,0) 外全部格。
 */
function railLength(cols: number, rows: number): number {
  return 2 * cols + 2 * rows - 5;
}

/** 第 index 个示意格：先边栏（贴边的「待定位」区），再图内。frame 必须满足 MIN_FRAME。 */
function slotCell(index: number, cols: number, rows: number): { x: number; y: number } {
  const rail = railLength(cols, rows);
  if (index < rail) {
    const top = cols - 1; // (1,0)..(cols-1,0)：跳过原点 (0,0)
    if (index < top) return { x: index + 1, y: 0 };
    let cursor = index - top;
    const right = rows - 1; // (cols-1,1)..(cols-1,rows-1)
    if (cursor < right) return { x: cols - 1, y: cursor + 1 };
    cursor -= right;
    const bottom = cols - 1; // (cols-2,rows-1)..(0,rows-1)
    if (cursor < bottom) return { x: cols - 2 - cursor, y: rows - 1 };
    cursor -= bottom;
    // 左边： (0,rows-2)..(0,1)——不会经过原点
    return { x: 0, y: rows - 2 - cursor };
  }
  const width = cols - 2;
  const inner = index - rail;
  return { x: 1 + (inner % width), y: 1 + Math.floor(inner / width) };
}

/** 贴靠锚点用的确定性邻格顺序（先四邻，再对角，再距离 2；绝不含原点）。 */
const ANCHOR_OFFSETS: ReadonlyArray<{ dx: number; dy: number }> = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
  { dx: 1, dy: -1 },
  { dx: 1, dy: 1 },
  { dx: -1, dy: 1 },
  { dx: -1, dy: -1 },
  { dx: 0, dy: -2 },
  { dx: 2, dy: 0 },
  { dx: 0, dy: 2 },
  { dx: -2, dy: 0 },
];

// ---------------------------------------------------------------------------
// H08 主函数
// ---------------------------------------------------------------------------

/**
 * 为缺坐标地点生成渲染用示意位置。**不产生任何真实坐标、不写任何存储。**
 *
 * @param input 见 AtlasMapLayoutInput；`unplaced` 只需是本图缺坐标的地点，宿主图选择由 H07 负责。
 */
export function layoutUnplacedMarkers(input: AtlasMapLayoutInput): AtlasMapLayoutResult {
  const source = (input ?? {}) as AtlasMapLayoutInput;
  const branchKey = typeof source.branchKey === "string" ? source.branchKey : "";
  const mapId = typeof source.mapId === "string" ? source.mapId : "";
  const frame = normalizeFrame(source.frame);

  const limitRaw = Number(source.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(Math.floor(limitRaw), ATLAS_MAP_LAYOUT_LIMITS.slotsPerLayout)
    : ATLAS_MAP_LAYOUT_LIMITS.markersPerMap;

  // 1) 真实坐标：只读取、只回显；非法值进 droppedConfirmed，不猜、不改、不截断。
  const confirmed: AtlasMapLayoutConfirmedMarker[] = [];
  const droppedConfirmed: AtlasMapLayoutDroppedConfirmed[] = [];
  const occupied = new Set<string>();
  const confirmedCellById = new Map<string, { x: number; y: number }>();
  for (const entry of Array.isArray(source.confirmed) ? source.confirmed : []) {
    const record = asRecord(entry);
    const id = readText(record?.id);
    if (id === "") {
      droppedConfirmed.push({ id, reason: "INVALID_ID" });
      continue;
    }
    const x = Number(record?.x);
    const y = Number(record?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      droppedConfirmed.push({ id, reason: "INVALID_COORDINATE" });
      continue;
    }
    confirmed.push({ id, x, y, displayOnly: false, coordinateStatus: ATLAS_MAP_LAYOUT_CONFIRMED_STATUS });
    occupied.add(cellKey(x, y));
    if (!confirmedCellById.has(id)) confirmedCellById.set(id, { x, y });
  }
  // 按 id 排序保证输入顺序变化不影响输出字节（重复 id 再按坐标比）。
  confirmed.sort((left, right) =>
    compareText(left.id, right.id) || left.x - right.x || left.y - right.y);

  // 2) 载具锚点表（只影响「能不能给固定示意点」，不改真实数据）。
  const anchorByLocationId = new Map<string, Record<string, unknown>>();
  for (const item of Array.isArray(source.vehicles) ? source.vehicles : []) {
    const record = asRecord(item);
    if (!record) continue;
    const key = readText(record.locationId) || readText(record.id); // §2.1：anchor.id = locationId
    if (key !== "" && !anchorByLocationId.has(key)) anchorByLocationId.set(key, record);
  }

  // 3) 候选：去重 + 排序（排序使布局与输入数组顺序无关）。
  const candidates: Array<{ id: string; name: string; mapId: string; mobile: string; anchorId: string }> = [];
  const pending: AtlasMapLayoutPendingEntry[] = [];
  const seenIds = new Set<string>();
  for (const entry of Array.isArray(source.unplaced) ? source.unplaced : []) {
    const record = asRecord(entry);
    const id = readText(record?.id);
    const name = readText(record?.name) || id;
    if (id === "") {
      pending.push({ id, name, reason: "INVALID_ID", detail: "地点行 id 缺失：不进示意排版" });
      continue;
    }
    if (seenIds.has(id)) {
      pending.push({ id, name, reason: "DUPLICATE_ID", detail: "同一 id 只排一次，重复行进名单" });
      continue;
    }
    seenIds.add(id);
    candidates.push({
      id,
      name,
      mapId: readText(record?.mapId),
      mobile: readText(record?.mobile),
      anchorId: readText(record?.anchorId),
    });
  }
  candidates.sort((left, right) => compareText(left.id, right.id));

  // 4) 门禁 + 排版。
  const frameUsable = frame.cols >= ATLAS_MAP_LAYOUT_MIN_FRAME && frame.rows >= ATLAS_MAP_LAYOUT_MIN_FRAME;
  const slotCapacity = frameUsable
    ? Math.min(frame.cols * frame.rows - 1, ATLAS_MAP_LAYOUT_LIMITS.slotsPerLayout)
    : 0;
  const frameReason: AtlasMapLayoutPendingReason = frame.cols <= 0 || frame.rows <= 0 ? "NO_FRAME" : "NO_SLOT";

  const displayOnly: AtlasMapLayoutDisplayMarker[] = [];
  let eligibleTotal = 0;
  for (const candidate of candidates) {
    const gate = gateCandidate(candidate, mapId, anchorByLocationId);
    if (gate) {
      pending.push({ id: candidate.id, name: candidate.name, reason: gate.reason, detail: gate.detail });
      continue;
    }
    eligibleTotal += 1;
    if (!frameUsable) {
      pending.push({
        id: candidate.id,
        name: candidate.name,
        reason: frameReason,
        detail: frameReason === "NO_FRAME"
          ? "本图 frame 非法（cols/rows 必须为正整数）：不给示意位置"
          : `本图 frame 太小（需 ≥ ${ATLAS_MAP_LAYOUT_MIN_FRAME}×${ATLAS_MAP_LAYOUT_MIN_FRAME} 才有非原点示意格）：只进待定位名单`,
      });
      continue;
    }
    if (displayOnly.length >= limit) {
      pending.push({
        id: candidate.id,
        name: candidate.name,
        reason: "OVER_PAGE_LIMIT",
        detail: `示意点分页上限 ${limit}：本页未排，总数见 counts.displayOnlyTotal`,
      });
      continue;
    }
    const cell = pickSlot(candidate, { branchKey, mapId, frame, slotCapacity, occupied, confirmedCellById });
    if (!cell) {
      pending.push({
        id: candidate.id,
        name: candidate.name,
        reason: "OVER_SLOT_CAPACITY",
        detail: `本图可用示意格（${slotCapacity}）已被真实坐标占满：不硬挤、不覆盖`,
      });
      continue;
    }
    occupied.add(cellKey(cell.x, cell.y));
    displayOnly.push({
      id: candidate.id,
      name: candidate.name,
      x: cell.x,
      y: cell.y,
      displayOnly: true,
      coordinateStatus: ATLAS_MAP_LAYOUT_SCHEMATIC_STATUS,
      anchorId: cell.anchorId,
    });
  }

  // 5) 名单与计数按确定性顺序输出（逐字节稳定）。
  pending.sort((left, right) =>
    compareText(left.id, right.id) || compareText(left.reason, right.reason) || compareText(left.detail, right.detail));
  droppedConfirmed.sort((left, right) => compareText(left.id, right.id) || compareText(left.reason, right.reason));

  return {
    branchKey,
    mapId,
    frame,
    confirmed,
    collisionPoints: confirmed.map((marker) => ({ id: marker.id, x: marker.x, y: marker.y })),
    displayOnly,
    pending,
    droppedConfirmed,
    counts: {
      candidates: candidates.length,
      confirmed: confirmed.length,
      displayOnly: displayOnly.length,
      displayOnlyTotal: eligibleTotal,
      truncated: Math.max(0, eligibleTotal - displayOnly.length),
      pending: pending.length,
      limit,
      slotCapacity,
    },
  };
}

/** 候选门禁：不属于本图的地点、在途/锚点未知的载具本体，一律不进示意排版。 */
function gateCandidate(
  candidate: { id: string; mapId: string; mobile: string },
  mapId: string,
  anchorByLocationId: ReadonlyMap<string, Record<string, unknown>>,
): { reason: AtlasMapLayoutPendingReason; detail: string } | null {
  if (candidate.mapId !== "" && candidate.mapId !== mapId) {
    return {
      reason: "WRONG_MAP",
      detail: `地点声明的宿主图是 ${candidate.mapId}，不是本图 ${mapId}：房间不得被搬进世界图`,
    };
  }
  const anchor = anchorByLocationId.get(candidate.id) ?? null;
  const isVehicle = candidate.mobile === "vehicle" || anchor !== null;
  if (!isVehicle) return null;
  if (!anchor) {
    return {
      reason: "VEHICLE_ANCHOR_UNKNOWN",
      detail: "载具本体没有拓扑锚点（停靠点/路线未知）：不生成固定示意点",
    };
  }
  const status = readText(anchor.status);
  const atLocationId = readText(anchor.atLocationId);
  if (status === "en-route") {
    return { reason: "VEHICLE_EN_ROUTE", detail: "载具在途：按路线中性图标显示，不给固定点" };
  }
  if (status !== "stopped" || atLocationId === "") {
    return { reason: "VEHICLE_ANCHOR_UNKNOWN", detail: "载具停靠状态/停靠点未知：进在途与待定位名单" };
  }
  return null; // 已确认停靠：可给示意位置（可贴在停靠点旁，见 pickSlot）
}

/** 逐格探测：先贴锚点邻格，再按确定性散列起点线性探测；永不返回原点 (0,0)。 */
function pickSlot(
  candidate: { id: string; anchorId: string },
  context: {
    branchKey: string;
    mapId: string;
    frame: AtlasMapLayoutFrame;
    slotCapacity: number;
    occupied: ReadonlySet<string>;
    confirmedCellById: ReadonlyMap<string, { x: number; y: number }>;
  },
): { x: number; y: number; anchorId: string | null } | null {
  const { frame, slotCapacity, occupied } = context;
  const docked = candidate.anchorId === "" ? null : context.confirmedCellById.get(candidate.anchorId) ?? null;
  if (docked) {
    for (const offset of ANCHOR_OFFSETS) {
      const x = docked.x + offset.dx;
      const y = docked.y + offset.dy;
      if (x === 0 && y === 0) continue; // 原点永不充当示意位置
      if (x < 0 || x >= frame.cols || y < 0 || y >= frame.rows) continue;
      if (occupied.has(cellKey(x, y))) continue;
      return { x, y, anchorId: candidate.anchorId };
    }
  }
  if (slotCapacity <= 0) return null;
  const base = fnv1a(`${context.branchKey}|${context.mapId}|${candidate.id}|${frame.cols}x${frame.rows}`) % slotCapacity;
  for (let probe = 0; probe < slotCapacity; probe += 1) {
    const cell = slotCell((base + probe) % slotCapacity, frame.cols, frame.rows);
    if (occupied.has(cellKey(cell.x, cell.y))) continue;
    return { x: cell.x, y: cell.y, anchorId: null };
  }
  return null;
}
