/**
 * atlas-background.ts — E06：远方 NPC 的**后台自主行动**（纯函数，零 IO）。
 *
 * 计划 §3-E06 原文：
 *   `planBackgroundMoves(tables, context)`：只挑选 `actionTendency`、目标地点、可到达路线
 *   且时间游标已推进的少数 NPC；上限每回合 20 人；没有可靠路径或未确认位置只更新行动，不瞬移。
 *
 * 与日程结算（`atlas-schedule.ts`）的分工：
 * - **日程**回答「这个人的作息表说他此刻在哪」——有 routine 记录的人，确定性重算；
 * - **后台行动**回答「这个人自己想动，且时间够他走过去」——由 `actionTendency` + `targetLocationId`
 *   驱动，按**旅行距离**决定本回合能走多远；走不到就只把行动记录改成"在途"，绝不瞬移。
 *
 * 纪律（写在这里，避免以后有人"顺手"放宽）：
 * 1. **必须有明确目标**：`targetLocationId` 为空 → 不动（想法可以改，位置不能猜）；
 * 2. **必须有可到达路线**：目标地点不存在 / 不在同一张可见地图 / 父链不可达 → 只更新行动；
 * 3. **时间必须真的推进了**：`prevTime === newTime`（短对话 0 段）→ 谁都不动；
 * 4. **速度上限**：本回合可走的格数 = `travelSpeedCellsPerPeriod × 推进时段数`，
 *    距离按同一张图的格序号算；超了就分批走（朝目标移动 min(可走, 距离) 格），
 *    并在回执里如实说明"在路上"；
 * 5. **离场 / 在场未知的人不动**（`presence !== "present"`）——不把"人不知道在哪"当成"人在这儿"；
 * 6. **主角不动**（`isProtagonistRole` 的安全网；三表不存 role，由调用方传入名单）；
 * 7. **每回合上限 20 人**（计划 §3-E06 原话），按"目标距离近的优先"确定性排序，超出部分如实计数。
 *
 * 本模块不做任何持久化：调用方拿 `plan.tables` 写回三表（C05 的提交段已经在做这件事）。
 */

import {
  cloneAtlasTables,
  type AtlasCharacterRow,
  type AtlasLocationRow,
  type AtlasThreeTablesV1,
} from "./atlas-tables.ts";
import { resolveGeoPath, type AtlasGeoTopology } from "./atlas-geo-topology.ts";

/** 每回合最多让多少人自主移动（计划 §3-E06 定的硬上限）。 */
export const ATLAS_BACKGROUND_MOVE_MAX = 20;

/**
 * 一个时段能走多少格。
 *
 * 口径与旅行规则同源：`atlas-geo-apply` 的步行档是「1 时段 ≈ 若干格」，这里取保守值 6 格/时段
 * （跨场景旅行 `atlasTravelPreview` 用的也是同一量级）。调大 = 远方人物更快到位。
 */
export const ATLAS_BACKGROUND_CELLS_PER_PERIOD = 6;

/**
 * 目标距离超过这个格数时，本回合只更新行动记录、**不移动**。
 *
 * 理由：跨半张地图的移动不该在一个回合里"跳"过去——远方宣战要随传讯与距离逐轮变化
 * （计划 §3-E07 原话）。超距的人每回合照常尝试，够近了自然开始走。
 */
export const ATLAS_BACKGROUND_FAR_CELLS = 60;

export interface AtlasBackgroundMove {
  characterId: string;
  characterName: string;
  fromLocationId: string | null;
  /** 本回合到达的地点（分批移动时是朝目标迈出的一站；null = 没动） */
  toLocationId: string | null;
  /** 目标地点 */
  targetLocationId: string;
  /** 本回合实际走过的格数（0 = 只更新了行动记录） */
  travelledCells: number;
  /** 剩余距离（格） */
  remainingCells: number;
  /** 本回合的处置：`moved` 到位 / `enroute` 在路上 / `blocked` 只更新行动 */
  status: "moved" | "enroute" | "blocked";
  /** 为什么只更新行动（`status !== "moved"` 时才有） */
  reasonCode?: "NO_ROUTE" | "TOO_FAR" | "NO_TIME" | "NO_PATH";
  /**
   * D01：沿**已确认边**分段前进时的完整地点路径（含起点与终点）。
   * 只在真的有确认路线时出现——没有路线仍旧 blocked，绝不猜路径、绝不瞬移。
   */
  viaPath?: readonly string[];
}

export interface AtlasBackgroundPlanInput {
  tables: AtlasThreeTablesV1;
  /** 世界时间：本回合开始 / 结束（同一对数字喂给日程结算，语义一致）。 */
  prevTime: number;
  newTime: number;
  /** 主人公等不可被后台移动的**人物行 id**（调用方按 world.characters[].role 算好传入）。 */
  protectedCharacterIds?: ReadonlySet<string>;
  /** 每回合人数上限；缺省 `ATLAS_BACKGROUND_MOVE_MAX`。 */
  maxMoves?: number;
  /** 每时段可走格数；缺省 `ATLAS_BACKGROUND_CELLS_PER_PERIOD`。 */
  cellsPerPeriod?: number;
  /** 「太远就先不动」的阈值；缺省 `ATLAS_BACKGROUND_FAR_CELLS`。 */
  farCells?: number;
  /**
   * D01：本分支**已确认**的地理拓扑。提供它时，超距 / 跨图目标改为沿
   * `resolveGeoPath` 的确认路线**逐段接近**（每时段推进一个路段），
   * 取代 0.9.58 的「>60 格永久 TOO_FAR」；没有路线仍是 blocked(NO_PATH/NO_ROUTE)。
   * 不提供时行为与 0.9.58 完全一致（既有测试不受影响）。
   */
  topology?: AtlasGeoTopology | null;
}

export interface AtlasBackgroundPlan {
  /** 应用了后台行动的三表（纯函数返回；没人动时是入参的深拷贝，调用方可以无条件写回）。 */
  tables: AtlasThreeTablesV1;
  moves: AtlasBackgroundMove[];
  /** 因为超过人数上限而**本回合没被处理**的人数（如实报出，不静默）。 */
  skipped: number;
  /** 有目标但只更新了行动记录的人数（在途 / 太远 / 无路）。 */
  blocked: number;
  notes: string[];
}

/** 地点行 id → 该点的格坐标（拿不到坐标 → null，按"无法判距"处理）。 */
function gridOfLocation(row: AtlasLocationRow): { x: number; y: number } | null {
  if (typeof row.gridX !== "number" || typeof row.gridY !== "number") return null;
  if (!Number.isFinite(row.gridX) || !Number.isFinite(row.gridY)) return null;
  return { x: row.gridX, y: row.gridY };
}

/** 同一张可见地图内才谈得上"走过去"：mapId 必须一致且都非 null。 */
function sameMap(a: AtlasLocationRow, b: AtlasLocationRow): boolean {
  if (a.mapId === null || b.mapId === null) return false;
  return a.mapId === b.mapId;
}

function distanceBetween(a: AtlasLocationRow, b: AtlasLocationRow): number | null {
  if (!sameMap(a, b)) return null;
  const left = gridOfLocation(a);
  const right = gridOfLocation(b);
  if (!left || !right) return null;
  return Math.round(Math.hypot(left.x - right.x, left.y - right.y));
}

/** 朝目标迈一步：从给定格坐标朝目标行插值（在途的人从"现在在哪格"继续走，不会退回起点）。 */
function stepToward(
  from: { x: number; y: number },
  to: AtlasLocationRow,
  cells: number,
): { x: number; y: number } | null {
  const end = gridOfLocation(to);
  if (!end) return null;
  const total = Math.hypot(end.x - from.x, end.y - from.y);
  if (total <= 0) return null;
  const ratio = Math.min(1, cells / total);
  return {
    x: Math.round(from.x + (end.x - from.x) * ratio),
    y: Math.round(from.y + (end.y - from.y) * ratio),
  };
}

/** 在途的人到目标的剩余距离（用他自己的格坐标算，不用地点行）。 */
function distanceFromGrid(from: { x: number; y: number }, to: AtlasLocationRow): number | null {
  const end = gridOfLocation(to);
  if (!end) return null;
  return Math.round(Math.hypot(end.x - from.x, end.y - from.y));
}

/**
 * 挑选并**在候选副本上**执行这一轮的后台行动。
 *
 * 纯函数：不改入参 `tables`；返回的 `tables` 已经含本回合的位置 / 行动记录更新。
 */
export function planBackgroundMoves(input: AtlasBackgroundPlanInput): AtlasBackgroundPlan {
  const plan: AtlasBackgroundPlan = {
    tables: cloneAtlasTables(input.tables),
    moves: [],
    skipped: 0,
    blocked: 0,
    notes: [],
  };
  const prevTime = Math.max(0, Math.floor(input.prevTime));
  const newTime = Math.max(prevTime, Math.floor(input.newTime));
  const periods = newTime - prevTime;
  // 时间没推进（短对话 0 段）→ 谁都不动：这是"远方宣战不该一轮传遍全图"的第一道闸
  if (periods <= 0) return plan;

  const maxMoves = Math.max(0, Math.floor(input.maxMoves ?? ATLAS_BACKGROUND_MOVE_MAX));
  const cellsPerPeriod = Math.max(0, input.cellsPerPeriod ?? ATLAS_BACKGROUND_CELLS_PER_PERIOD);
  const farCells = Math.max(0, input.farCells ?? ATLAS_BACKGROUND_FAR_CELLS);
  const budget = Math.max(0, cellsPerPeriod * periods);
  if (budget <= 0 || maxMoves === 0) return plan;

  const locationById = new Map(plan.tables.locations.map((row) => [row.id, row]));

  /** 候选：有目标、在场、非主角、且目标地点存在。 */
  const protectedIds = input.protectedCharacterIds ?? new Set<string>();
  const candidates: Array<{ row: AtlasCharacterRow; target: AtlasLocationRow; distance: number | null; enRoute: boolean }> = [];
  for (const row of plan.tables.characters) {
    if (row.targetLocationId === null) continue;
    // 在场性守卫：离场 / 在场未知的人不动。
    // 例外：**在途**的人（背景行动刚把他放上路：`presence="unknown"` + 有格坐标 + 有目标）
    // 必须能接着走——否则一次分批移动就把人永久卡在路上。
    const enRoute = row.presence === "unknown" && row.locationId === null
      && typeof row.gridX === "number" && typeof row.gridY === "number" && row.targetLocationId !== null;
    if (row.presence !== "present" && !enRoute) continue;
    if (protectedIds.has(row.id)) continue;
    const target = locationById.get(row.targetLocationId);
    if (!target) continue;
    const current = row.locationId === null ? null : locationById.get(row.locationId) ?? null;
    candidates.push({ row, target, distance: current ? distanceBetween(current, target) : null, enRoute });
  }

  /**
   * 确定性排序：距离近的先走（更可能真的到达），距离未知的排最后（只能更新行动），
   * 同距离按行 id 升序——同一份输入永远得到同一份计划，回退 / 重放才对得上。
   */
  candidates.sort((a, b) => {
    const left = a.distance === null ? Number.POSITIVE_INFINITY : a.distance;
    const right = b.distance === null ? Number.POSITIVE_INFINITY : b.distance;
    if (left !== right) return left - right;
    return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0;
  });

  const selected = candidates.slice(0, maxMoves);
  plan.skipped = Math.max(0, candidates.length - selected.length);

  for (const candidate of selected) {
    const { row, target, enRoute } = candidate;
    const current = row.locationId === null ? null : locationById.get(row.locationId) ?? null;
    // 位置未知又不在途（没被本模块放上路）→ 只更新行动记录（不知道他在哪，就不能算他走到哪）
    if (!current && !enRoute) {
      plan.blocked += 1;
      plan.moves.push({
        characterId: row.id, characterName: row.name, fromLocationId: row.locationId,
        toLocationId: null, targetLocationId: target.id, travelledCells: 0, remainingCells: 0,
        status: "blocked", reasonCode: "NO_PATH",
      });
      continue;
    }
    if (row.locationId === target.id) {
      // 已经到了：清掉目标，不再每回合重复处理
      row.targetLocationId = null;
      continue;
    }
    /**
     * 起点坐标：在途的人用**他当前所在的格**（继续往前走），刚出发的人用出发地点行的坐标。
     * 用错这一处，在途的人每个回合都会被"拉回出发点"重新起步——位置永远到不了。
     */
    const origin = enRoute ? { x: row.gridX as number, y: row.gridY as number } : gridOfLocation(current!);
    if (!origin) {
      plan.blocked += 1;
      plan.moves.push({
        characterId: row.id, characterName: row.name, fromLocationId: row.locationId,
        toLocationId: null, targetLocationId: target.id, travelledCells: 0, remainingCells: 0,
        status: "blocked", reasonCode: "NO_PATH",
      });
      continue;
    }
    const distance = enRoute ? distanceFromGrid(origin, target) : candidate.distance;
    /**
     * D01：距离未知（跨图 / 无坐标）或超过阈值时，不再一律「永久不动」——
     * 只要拓扑里有**已确认的边**，就沿路线走一个路段，逐段接近目标。
     * 每时段推进一个路段（保守：不把一条跨州邻接当成 1 时段徒步到达）。
     * 没有确认路线 ⇒ 保留原语义（NO_ROUTE / TOO_FAR），绝不猜路径、绝不瞬移。
     */
    if (distance === null || distance > farCells) {
      const routed = (() => {
        const topology = input.topology ?? null;
        if (!topology || periods < 1 || row.locationId === null) return null;
        const found = resolveGeoPath(topology, row.locationId, target.id, { mode: "walk" });
        if (!found.ok || found.path.length < 2) return null;
        return { nextLocationId: found.path[1]!, path: [...found.path] };
      })();
      if (routed) {
        const nextRow = locationById.get(routed.nextLocationId) ?? null;
        const atTarget = routed.nextLocationId === target.id;
        row.locationId = routed.nextLocationId;
        row.mapId = nextRow ? nextRow.mapId : null;
        // 路段落点没有细坐标：宁可留空，也不编一个格坐标
        row.gridX = null;
        row.gridY = null;
        row.positionSource = "simulation";
        row.presence = "present";
        row.currentAction = (atTarget ? `抵达${target.name}` : `正在赶往${target.name}`).slice(0, 120);
        if (atTarget) row.targetLocationId = null;
        plan.moves.push({
          characterId: row.id, characterName: row.name,
          fromLocationId: current ? current.id : null,
          toLocationId: atTarget ? target.id : null,
          targetLocationId: target.id,
          travelledCells: 0,
          remainingCells: Math.max(0, routed.path.length - 2),
          status: atTarget ? "moved" : "enroute",
          viaPath: routed.path,
        });
        continue;
      }
      const reason: "NO_ROUTE" | "TOO_FAR" = distance === null ? "NO_ROUTE" : "TOO_FAR";
      if (reason === "TOO_FAR") row.actionTendency = row.actionTendency.trim() || `赶往${target.name}`;
      plan.blocked += 1;
      plan.moves.push({
        characterId: row.id, characterName: row.name, fromLocationId: row.locationId,
        toLocationId: null, targetLocationId: target.id, travelledCells: 0,
        remainingCells: distance ?? 0,
        status: "blocked", reasonCode: reason,
      });
      continue;
    }
    const step = stepToward(origin, target, Math.min(budget, distance));
    if (!step) {
      plan.blocked += 1;
      plan.moves.push({
        characterId: row.id, characterName: row.name, fromLocationId: row.locationId,
        toLocationId: null, targetLocationId: target.id, travelledCells: 0, remainingCells: distance,
        status: "blocked", reasonCode: "NO_PATH",
      });
      continue;
    }
    const travelled = Math.min(budget, distance);
    const remaining = Math.max(0, distance - travelled);
    const arrived = remaining === 0;
    row.gridX = step.x;
    row.gridY = step.y;
    row.mapId = target.mapId;
    row.positionSource = "simulation";
    if (arrived) {
      row.locationId = target.id;
      row.targetLocationId = null;
      row.presence = "present";
      row.currentAction = `抵达${target.name}`.slice(0, 120);
    } else {
      /**
       * 在途：`locationId = null` + 格坐标指向路上。
       *
       * 这里**故意**不把 `locationId` 留在出发地：留在出发地等于对 UI 说"他还在这儿"
       * （地点面板会把他列在出发地），而他已经走了。`locationId = null` 让地点面板读作
       * 「位置未知」，格坐标则让地图上看得见他在路上——三者口径一致，且没有瞬移。
       */
      row.locationId = null;
      row.presence = "unknown";
      row.currentAction = `正在赶往${target.name}`.slice(0, 120);
    }
    plan.moves.push({
      characterId: row.id, characterName: row.name, fromLocationId: current ? current.id : null,
      toLocationId: arrived ? target.id : null, targetLocationId: target.id,
      travelledCells: travelled, remainingCells: remaining,
      status: arrived ? "moved" : "enroute",
    });
  }

  const arrivedCount = plan.moves.filter((move) => move.status === "moved").length;
  const enrouteCount = plan.moves.filter((move) => move.status === "enroute").length;
  if (arrivedCount > 0) plan.notes.push(`后台行动 ${arrivedCount} 人到位`);
  if (enrouteCount > 0) plan.notes.push(`${enrouteCount} 人在路上`);
  if (plan.blocked > 0) plan.notes.push(`${plan.blocked} 人有目标但本回合只更新了行动`);
  if (plan.skipped > 0) plan.notes.push(`${plan.skipped} 人因每回合 ${maxMoves} 人上限未处理`);
  return plan;
}

/** E06 的便利判定：这个人是否有"下一步要去哪"的明确目标（供 UI / 诊断用）。 */
export function hasBackgroundIntent(row: AtlasCharacterRow): boolean {
  return row.targetLocationId !== null && row.presence === "present";
}
