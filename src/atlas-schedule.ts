/**
 * atlas-schedule.ts — ATLAS-13 回合边界 NPC 日程结算（纯函数，零 API、零 DOM、零随机）。
 *
 * 作者 2026-09-19 问：「如果在 NPC 行动的时候，user 又做了新的会有影响的事情呢？」
 * 设计结论（已向作者说明）：NPC 日程不是后台进程，而是**推演提交后的纯函数结算**：
 *  - NPC 没有「未来计划」存档——日程是作者登记的**静态日常**（entityRecords 基线字段），
 *    每回合按推进的时段**确定性重算**，回滚 / swipe 天然无残留（下一回合重算即修正）。
 *  - 三裁定：
 *      ① 抢先提交先生效——结算读的是提交后的世界与时间，玩家先提交的事实即现实；
 *      ② 半路拦截玩家主权——NPC 移动只写 NPC 自己的 CharacterState，绝不改写玩家路径；
 *        玩家位置是结算的输入，不是输出；
 *      ③ 同段同地算法判遭遇——同一时段 + 同一地点 = 遭遇，算法判定（triggeredNpcIds + 〔日程〕注记）。
 *
 * 日程数据（存放在 entityRecords，parseWorld 白名单重建下唯一能持久化自定义字段的地方；
 * 本模块绝不改动 vendored lib）：
 *  - 某个 NPC 的日常 = **id 与 character.id 相同**的 entityRecord 上的 base 字段 `routine`：
 *      `"routine": ["0-6:31", "8-18:32", "18-24:33"]（31/32/33 = 地点 id；比对时按字符串化处理）`
 *    每段 `"start-end:pointId"`（整数、半开区间 [start,end)），gap = 该时段不移动（原地驻留）。
 *  - 一天 = 多少时段：type 为 "world" 的 entityRecord 的 base 字段 `periodsPerDay`（数字），
 *    缺省 12，允许 1..72。
 *  - 没有日程记录的人物 = 原地驻留（仍参与遭遇判定：玩家走到TA面前也算相遇）。
 *
 * 为什么 NPC 移动不走账本 moveEntity：账本 effect 的实体校验只认 entityRecords，
 * 对 characters 会报「实体不存在」；且日程位置是 routine 的确定性投影而非独立事实，
 * 写 CharacterState（分支感知）+ 每回合重算即可，账本保持「玩家行动 + AI 草稿」的单一职责。
 */

import type { World } from "../lib/world-schema.ts";
import { W0_LIMITS } from "../lib/world-schema.ts";
import { moveCharacterTo, resolveCharacterPosition } from "../lib/world-npc.ts";

/** 一天 = 多少时段（缺省；可被 type=world 的 entityRecord 基线字段 periodsPerDay 覆盖） */
export const DEFAULT_PERIODS_PER_DAY = 12;
const MIN_PERIODS_PER_DAY = 1;
const MAX_PERIODS_PER_DAY = 72;
/** 单个 NPC 日程最多段数（有界；超过丢弃并注记） */
const MAX_ROUTINE_SEGMENTS = 12;

/** 一段日常：天内时段 [start, end) 停在 pointId */
export interface AtlasRoutineSegment {
  start: number;
  end: number;
  pointId: string;
}

/** 读取「一天 = N 时段」（非法 / 缺失 → 缺省 12） */
export function periodsPerDayOf(world: World): number {
  const cfg = (world.entityRecords ?? []).find((r) => r.type === "world");
  const raw = cfg?.baseline["periodsPerDay"];
  if (typeof raw === "number" && Number.isFinite(raw) && Number.isInteger(raw) && raw >= MIN_PERIODS_PER_DAY && raw <= MAX_PERIODS_PER_DAY) {
    return raw;
  }
  return DEFAULT_PERIODS_PER_DAY;
}

/** 解析 routine 字符串数组 → 段列表（非法段丢弃；调用方负责 pointId 存在性校验） */
export function parseRoutineSegments(raw: unknown): AtlasRoutineSegment[] {
  if (!Array.isArray(raw)) return [];
  const segments: AtlasRoutineSegment[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.length === 0 || item.length > 200) continue;
    const match = /^(\d+)-(\d+):(.+)$/.exec(item.trim());
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const pointId = match[3].trim();
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 0 || end <= start || pointId === "") continue;
    segments.push({ start, end, pointId });
    if (segments.length >= MAX_ROUTINE_SEGMENTS) break;
  }
  return segments;
}

/** 某人物在 entityRecords 上的日程段（id 与 character.id 相同的记录；无 → 空） */
export function routineFor(world: World, characterId: string): AtlasRoutineSegment[] {
  const record = (world.entityRecords ?? []).find((r) => String(r.id) === String(characterId));
  if (!record) return [];
  return parseRoutineSegments(record.baseline["routine"]);
}

/** 天内时段 → 该停的地点（半开区间 [start,end)，按数组顺序取首个命中；无命中 → null = 原地驻留） */
export function routinePointAt(segments: AtlasRoutineSegment[], periodOfDay: number): string | null {
  for (const seg of segments) {
    if (periodOfDay >= seg.start && periodOfDay < seg.end) return seg.pointId;
  }
  return null;
}

export interface AtlasSettlementMove {
  characterId: string;
  characterName: string;
  pointId: string;
  /** 移动前的地点（未知 / 无状态时为 null） */
  fromPointId: string | null;
  /** 发生移动的天内时段（periodOfDay） */
  periodOfDay: number;
}

export interface AtlasSettlementEncounter {
  characterId: string;
  characterName: string;
  pointId: string;
  /** 世界时间（绝对时段序号） */
  at: number;
}

export interface AtlasSettlementResult {
  /** NPC 位置已落 CharacterState 的新世界（纯函数返回；无移动时 === 入参 world） */
  world: World;
  moves: AtlasSettlementMove[];
  encounters: AtlasSettlementEncounter[];
  /** 〔日程〕注记（调用方合入回执 summary 尾部；有界截断由调用方负责） */
  notes: string[];
}

/**
 * 回合边界日程结算：对本次推进的每个时段（prevTime+1 .. newTime），确定性重算
 * 有日程 NPC 的位置并判定与玩家的同段同地遭遇。
 *
 * 时间语义（唯一口径，AR-ATLAS-13）：绝对时段负责推进；日内时段 = 绝对时段对
 * periodsPerDay 取模（跨日 11→12→13 即 11→0→1）。缺省一天 12 时段。
 *
 * 旅行语义（唯一口径，AR-ATLAS-13）：玩家移动时，出发后的中间时段 = **在途**
 * （不在起点也不在终点，不判遭遇）；只在抵达时刻（newTime）进入目的地。
 * 玩家未移动时全程在原地（原地时段正常判遭遇——NPC 可以上门）。
 *
 * NPC 判定（唯一口径，AR-ATLAS-13）：
 * - 主角 / 玩家 / 观察者类角色（protagonist/主角/player/玩家/user/observer/观察者）
 *   **绝不被日程移动，也绝不进遭遇候选**（安全网——自我遭遇不可能发生）；
 * - 其余角色：有 routine 记录（显式登记）→ 参与日程移动；
 *   遭遇候选 = 有 routine 记录 ∪ role 恰为 "npc"（大小写不敏感）的驻留角色；
 *   未知 role 且无 routine → 不移动、不进遭遇（保守：不把叙事道具当 NPC）。
 */
const PROTAGONIST_ROLES = new Set(["protagonist", "主角", "player", "玩家", "user", "observer", "观察者"]);

export function isProtagonistRole(role: unknown): boolean {
  if (typeof role !== "string") return false;
  return PROTAGONIST_ROLES.has(role.trim().toLowerCase()) || PROTAGONIST_ROLES.has(role.trim());
}

export function settleNpcSchedules(
  world: World,
  input: {
    branchId: string | null;
    /** 本回合开始时的世界时间 */
    prevTime: number;
    /** 本回合结束时的世界时间（= prevTime + duration） */
    newTime: number;
    /** 玩家本回合开始时的地点（绑定游标） */
    playerFromPointId: string | null;
    /** 玩家本回合的移动目的地（无移动 → null） */
    playerToPointId: string | null;
    now?: number;
  },
): AtlasSettlementResult {
  const prevTime = Math.max(0, Math.floor(input.prevTime));
  const newTime = Math.max(prevTime, Math.floor(input.newTime));
  const periodsPerDay = periodsPerDayOf(world);
  const knownPointIds = new Set((world.points ?? []).map((p) => String(p.id)));
  const nameOf = (id: string) => (world.characters ?? []).find((c) => String(c.id) === String(id))?.name ?? id;

  // 玩家位置（每时段）：移动时中间时段在途（null 不判遭遇），只在抵达时刻进入目的地
  const playerAt = (at: number): string | null => {
    if (input.playerToPointId) {
      return at === newTime ? input.playerToPointId : null;
    }
    return input.playerFromPointId;
  };

  // NPC 判定：主角类安全网排除；遭遇候选 = routine 记录 ∪ role === "npc"
  const characters = (world.characters ?? []).filter((c) => !isProtagonistRole(c.role));
  const hasRoutineRecord = new Set(
    (world.entityRecords ?? [])
      .filter((r) => characters.some((c) => String(c.id) === String(r.id)))
      .map((r) => String(r.id)),
  );
  const isNpcRole = (id: string) => {
    const role = (world.characters ?? []).find((c) => String(c.id) === String(id))?.role;
    return typeof role === "string" && role.trim().toLowerCase() === "npc";
  };
  const isEncounterCandidate = (id: string) => hasRoutineRecord.has(id) || isNpcRole(id);

  // NPC 当前位置快照（结算中随移动更新）
  const positions = new Map<string, { regionId: string | null; pointId: string | null }>();
  for (const c of characters) {
    const pos = resolveCharacterPosition(world, String(c.id), { branchId: input.branchId });
    positions.set(String(c.id), { regionId: pos.regionId, pointId: pos.pointId });
  }

  // 日程缓存（无 routine 的 key = 空 → 原地驻留）
  const routines = new Map<string, AtlasRoutineSegment[]>();
  const droppedUnknownPoints = new Map<string, string>(); // pointId → characterId
  for (const c of characters) {
    const id = String(c.id);
    const segments = routineFor(world, id).filter((seg) => {
      if (knownPointIds.has(seg.pointId)) return true;
      droppedUnknownPoints.set(seg.pointId, id);
      return false;
    });
    routines.set(id, segments);
  }

  const working = world;
  let current = working;
  const moves: AtlasSettlementMove[] = [];
  const encounters: AtlasSettlementEncounter[] = [];
  const seenEncounters = new Set<string>();
  const now = input.now ?? 0;

  for (let at = prevTime + 1; at <= newTime; at += 1) {
    const periodOfDay = ((at % periodsPerDay) + periodsPerDay) % periodsPerDay;

    // 1) 有日程的 NPC：按日常移动（每次移动立即生效，影响后续时段）
    for (const c of characters) {
      const id = String(c.id);
      const segments = routines.get(id) ?? [];
      if (segments.length === 0) continue;
      const target = routinePointAt(segments, periodOfDay);
      const pos = positions.get(id)!;
      if (!target || target === pos.pointId) continue;
      const point = (world.points ?? []).find((p) => String(p.id) === String(target));
      const regionId = point?.regionId ?? null;
      const fromPointId = pos.pointId;
      const moved = moveCharacterTo(current, id, regionId ?? null, target, now, { branchId: input.branchId });
      if (moved.ok) {
        current = moved.world;
        pos.regionId = regionId ?? null;
        pos.pointId = target;
        moves.push({ characterId: id, characterName: nameOf(id), pointId: target, fromPointId, periodOfDay });
      }
    }

    // 2) 同段同地判遭遇：玩家该时段位置 vs 日程 NPC / role=npc 驻留角色的当前位置
    const playerPointId = playerAt(at);
    if (!playerPointId) continue;
    for (const c of characters) {
      const id = String(c.id);
      if (!isEncounterCandidate(id)) continue;
      const pos = positions.get(id)!;
      if (!pos.pointId || String(pos.pointId) !== String(playerPointId)) continue;
      const key = `${id}:${pos.pointId}`;
      if (seenEncounters.has(key)) continue;
      seenEncounters.add(key);
      encounters.push({ characterId: id, characterName: nameOf(id), pointId: pos.pointId, at });
    }
  }

  // 3) 〔日程〕注记（人类可读：谁从哪到哪、在哪里相遇；有界截断由调用方负责）
  const notes: string[] = [];
  for (const unknownPoint of droppedUnknownPoints.keys()) {
    notes.push(`〔日程〕忽略日程里的未知地点「${unknownPoint.slice(0, 32)}」`);
  }
  if (moves.length > 0) {
    const detail = moves
      .slice(0, 6)
      .map((m) => `${m.characterName} 从「${(m.fromPointId ?? "?").slice(0, 24)}」到「${m.pointId.slice(0, 24)}」（日内第 ${m.periodOfDay} 时段）`)
      .join("；");
    notes.push(`〔日程〕${moves.length} 次 NPC 日常移动：${detail}${moves.length > 6 ? "…" : ""}`);
  }
  if (encounters.length > 0) {
    const detail = encounters
      .slice(0, 6)
      .map((e) => `${e.characterName} 在「${e.pointId.slice(0, 24)}」相遇（时段 ${e.at}）`)
      .join("；");
    notes.push(`〔日程〕同段同地遭遇：${detail}${encounters.length > 6 ? "…" : ""}`);
  }

  return { world: current, moves, encounters, notes };
}

/** 〔日程〕注记合入 summary 尾部（与裁决层同款的有界截断） */
export function mergeSettlementNotes(summary: string, notes: string[]): string {
  if (notes.length === 0) return summary;
  const base = summary.trim();
  const merged = `${base}${base ? "；" : ""}${notes.join("；")}`;
  return merged.slice(0, W0_LIMITS.maxStateEventSummary);
}
