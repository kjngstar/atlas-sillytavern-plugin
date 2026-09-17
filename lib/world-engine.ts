// W0-02：纯本地世界运转、网格事实与行动时长协作层
//
// 职责（来自 待办计划 README 的 W0-02 详细交接要求）：
//  - 生成行动、计算网格距离与地图线索、构造 `TravelHint`、推进确认后的时间、
//    解析起点 / 终点 / 途经来源、筛选触发器、使用记录的种子抽取结果、应用确定性状态变更。
//  - 主故事请求固定携带 `DefaultTravelBaseline`；当前世界有活动 World Agent 时
//    额外附加 `WorldAgentTravelGuide`，再按故事 / IF 的时间和焦点过滤。
//
// 硬性纪律：
//  - **无 React、无 DOM、0 fetch**。本文件不得出现 fetch / XMLHttpRequest / import 网络库。
//  - **禁止 Math.random() 与 Date.now()**：所有随机性来自持久化种子，所有时间戳由调用方注入。
//  - 同输入 + 基线版本 + 世界 Agent revision + 地图设置 + 种子 → 永远同一结果。

import type {
  World,
  WorldAction,
  WorldActionKind,
  WorldActionSourceRef,
  WorldOutcome,
  WorldTrigger,
  MapTravelSettings,
  DurationSource,
  StoryRuntime,
  CharacterState,
} from "./world-schema.ts";
import { WORLD_ACTION_KINDS, W0_LIMITS, branchScopeForStory, branchCharacterStates } from "./world-schema.ts";
import { getDefaultTravelBaseline, resolveTravelContext } from "./world-travel.ts";
import { hashString } from "./world-cards.ts";

// ---------------------------------------------------------------------------
// 1. 世界时钟（时段 / 日 / 月 / 年的进位）
// ---------------------------------------------------------------------------

export const DEFAULT_CLOCK_CONFIG = {
  /** 每天时段数（默认 4：晨 / 午 / 昏 / 夜） */
  periodsPerDay: 4,
  /** 每月天数 */
  daysPerMonth: 30,
  /** 每年月数 */
  monthsPerYear: 12,
} as const;

export type ClockConfig = {
  periodsPerDay: number;
  daysPerMonth: number;
  monthsPerYear: number;
};

/** 世界日历表示（年与月、日为 1-based；时段为 0-based） */
export type WorldCalendar = {
  year: number;
  month: number;
  day: number;
  period: number;
};

function normalizeClockConfig(cfg: ClockConfig = DEFAULT_CLOCK_CONFIG): Required<ClockConfig> {
  return {
    periodsPerDay: Math.max(1, Math.floor(cfg.periodsPerDay)),
    daysPerMonth: Math.max(1, Math.floor(cfg.daysPerMonth)),
    monthsPerYear: Math.max(1, Math.floor(cfg.monthsPerYear)),
  };
}

/** 把「总时段数」换算为日历。跨日 / 跨月 / 跨年进位完全可预测。 */
export function toCalendar(totalPeriods: number, cfg: ClockConfig = DEFAULT_CLOCK_CONFIG): WorldCalendar {
  const c = normalizeClockConfig(cfg);
  const t = Math.max(0, Math.floor(totalPeriods));
  const perMonth = c.periodsPerDay * c.daysPerMonth;
  const perYear = perMonth * c.monthsPerYear;
  const year = Math.floor(t / perYear) + 1;
  const restYear = t % perYear;
  const month = Math.floor(restYear / perMonth) + 1;
  const restMonth = restYear % perMonth;
  const day = Math.floor(restMonth / c.periodsPerDay) + 1;
  const period = restMonth % c.periodsPerDay;
  return { year, month, day, period };
}

/** 日历 → 总时段数（toCalendar 的逆运算）。 */
export function fromCalendar(cal: WorldCalendar, cfg: ClockConfig = DEFAULT_CLOCK_CONFIG): number {
  const c = normalizeClockConfig(cfg);
  const year = Math.max(1, Math.floor(cal.year)) - 1;
  const month = Math.max(1, Math.floor(cal.month)) - 1;
  const day = Math.max(1, Math.floor(cal.day)) - 1;
  const period = Math.max(0, Math.floor(cal.period));
  return ((year * c.monthsPerYear + month) * c.daysPerMonth + day) * c.periodsPerDay + period;
}

/**
 * 推进时间（永不为负）。
 * 标量时间线性推进；日 / 月 / 年的进位只影响**如何显示**，由 toCalendar 负责。
 */
export function advancePeriods(total: number, delta: number): number {
  return Math.max(0, Math.floor(total) + Math.floor(delta));
}

/** 人类可读的日历文本（用于日志与 UI）。 */
export function formatCalendar(cal: WorldCalendar): string {
  return `第 ${cal.year} 年 ${cal.month} 月 ${cal.day} 日 · 第 ${cal.period + 1} 时段`;
}

// ---------------------------------------------------------------------------
// 2. 网格距离与地图事实
// ---------------------------------------------------------------------------

/** 0-100 网格坐标上的欧氏距离，四舍五入为整数格数。 */
export function gridDistance(ax: number, ay: number, bx: number, by: number): number {
  return Math.round(Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2));
}

export type DistanceResult = {
  /** 网格格数（永远有值，是最诚实的事实） */
  cells: number;
  /** 标定后的实际距离；未标定时为 null，绝不伪造 */
  value: number | null;
  unit: string | null;
  /** 地图是否已标定比例 */
  calibrated: boolean;
};

/** 计算距离：优先用地图标定换算，未标定时只给格数。 */
export function computeDistance(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  settings?: MapTravelSettings | null,
): DistanceResult {
  const cells = gridDistance(ax, ay, bx, by);
  if (!settings || settings.enabled !== true || !(settings.distancePerCell > 0)) {
    return { cells, value: null, unit: null, calibrated: false };
  }
  const value = Math.round(cells * settings.distancePerCell * 100) / 100;
  return { cells, value, unit: settings.distanceUnit, calibrated: true };
}

export type TerrainCue = {
  key: string;
  label: string;
  factor: number;
  source: "settings" | "baseline";
};

/**
 * 解析地形系数。优先用地图设置里的作者自定义系数（地点 / 地区 / 途经段 key），
 * 没有则回退到默认基线的大道档（系数 1，即无修正）。
 */
export function resolveTerrainCue(keys: string[], settings?: MapTravelSettings | null): TerrainCue {
  const factors = settings && settings.terrainFactors ? settings.terrainFactors : null;
  for (const key of keys) {
    if (factors && Object.prototype.hasOwnProperty.call(factors, key)) {
      const factor = factors[key];
      if (typeof factor === "number" && factor > 0) {
        return { key, label: `自定义地形「${key}」`, factor, source: "settings" };
      }
    }
  }
  const baseline = getDefaultTravelBaseline();
  const road = baseline.terrainTiers[0];
  return {
    key: keys[0] ?? "road",
    label: road ? road.label : "大道 / 平原",
    factor: road ? road.factor : 1,
    source: "baseline",
  };
}

/** 取默认基线里的速度档；未指定或找不到时用「常速」。 */
export function resolveSpeedTier(speedTierId?: string | null) {
  const baseline = getDefaultTravelBaseline();
  if (speedTierId) {
    const hit = baseline.speedTiers.find((t) => t.id === speedTierId);
    if (hit) return hit;
  }
  const normal = baseline.speedTiers.find((t) => t.id === "normal");
  return normal ?? baseline.speedTiers[0] ?? null;
}

// ---------------------------------------------------------------------------
// 3. TravelHint（严格 0 fetch）
// ---------------------------------------------------------------------------

export type TravelHintInput = {
  fromPointId?: string | null;
  toPointId?: string | null;
  viaPointIds?: string[];
  /** 速度档 id；缺省用默认基线的「常速」 */
  speedTierId?: string | null;
  /** 故事线与分支（用于按时间与焦点过滤） */
  storyId?: string | null;
  branchId?: string | null;
  /** 当前焦点卡（CardAgentProfile.id） */
  focusCardId?: string | null;
  /** 附近地点半径（网格单位） */
  radius?: number;
};

export type TravelHint = {
  /** 默认基线版本（永远存在） */
  baselineVersion: string;
  /** 引用的世界 Agent revision；未使用时为 null */
  worldAgentRevision: string | null;
  status: ReturnType<typeof resolveTravelContext>["status"];
  from: { pointId: string | null; name: string | null; x: number | null; y: number | null };
  to: { pointId: string | null; name: string | null; x: number | null; y: number | null };
  via: Array<{ pointId: string; name: string; x: number; y: number }>;
  distance: DistanceResult;
  speedTier: { id: string; label: string; cellsPerPeriod: number } | null;
  terrainCue: TerrainCue;
  /** 抽象「格程 / 时段」表达（无标定时的诚实说法） */
  abstractExpression: string;
  /** 按网格与速度档算出的建议时段数 */
  suggestedPeriods: number;
  /** 建议写入的 duration（世界时段）；无速度档时为 null */
  suggestedDuration: number | null;
  /** 一句话依据（对应基线要求的 basis） */
  basis: string;
  /** 未标定地图 → 必须作者确认，不生成伪精确数字 */
  requiresAuthorConfirmation: boolean;
  nearbyPointIds: string[];
  /** 可读地图线索 */
  cues: string[];
  /** 是否叠加了世界 Agent 旅行辅助 */
  worldAgentAssistApplied: boolean;
};

/** 附近地点默认半径（网格单位）；写进结果以便复现。 */
export const DEFAULT_NEARBY_RADIUS = 12;

function findPoint(world: World, pointId: string | null | undefined) {
  if (!pointId) return null;
  return (world.points ?? []).find((p) => String(p.id) === pointId) ?? null;
}

/** 附近地点：以终点为中心、半径内的其它地点（半径写进结果，可复现）。 */
export function nearbyPoints(
  world: World,
  cx: number,
  cy: number,
  radius: number,
  excludePointId?: string | null,
): string[] {
  return (world.points ?? [])
    .filter((p) => String(p.id) !== String(excludePointId ?? ""))
    .filter((p) => gridDistance(cx, cy, p.x, p.y) <= radius)
    .map((p) => String(p.id));
}

/**
 * 构造 `TravelHint`：**严格 0 fetch**。
 * 固定携带默认基线；有活动世界 Agent 时额外叠加其旅行辅助；再按故事 / IF 的时间与焦点过滤。
 * 同输入 + 基线版本 + 世界 Agent revision + 地图设置 + 种子 → 永远同一结果。
 */
export function buildTravelHint(world: World, input: TravelHintInput = {}): TravelHint {
  const baseline = getDefaultTravelBaseline();
  const ctx = resolveTravelContext(world);

  const from = findPoint(world, input.fromPointId);
  const to = findPoint(world, input.toPointId);
  const via = (input.viaPointIds ?? [])
    .map((id) => findPoint(world, id))
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map((p) => ({ pointId: String(p.id), name: p.name, x: p.x, y: p.y }));

  // 距离：途经点分段累加
  let cells = 0;
  if (from && to) {
    const legs: Array<[number, number, number, number]> = [];
    let prev = from;
    for (const v of via) {
      legs.push([prev.x, prev.y, v.x, v.y]);
      prev = { ...prev, x: v.x, y: v.y };
    }
    legs.push([prev.x, prev.y, to.x, to.y]);
    cells = legs.reduce((sum, [ax, ay, bx, by]) => sum + gridDistance(ax, ay, bx, by), 0);
  }
  const distance: DistanceResult = from && to
    ? { ...computeDistance(from.x, from.y, to.x, to.y, world.travelSettings), cells }
    : { cells, value: null, unit: null, calibrated: false };

  // 地形：途经段 / 终点地区 / 终点地点
  const terrainKeys: string[] = [];
  if (from && to) terrainKeys.push(`${String(from.id)}->${String(to.id)}`);
  if (to?.regionId) terrainKeys.push(to.regionId);
  if (to) terrainKeys.push(String(to.id));
  const terrainCue = resolveTerrainCue(terrainKeys, world.travelSettings);

  const speedTier = resolveSpeedTier(input.speedTierId);
  const cellsPerPeriod = speedTier ? speedTier.cellsPerPeriod : 0;
  const rawPeriods = cellsPerPeriod > 0 ? (cells * terrainCue.factor) / cellsPerPeriod : 0;
  const suggestedPeriods = cells > 0 ? Math.max(1, Math.round(rawPeriods)) : 0;
  const suggestedDuration = speedTier && cells > 0 ? suggestedPeriods : null;
  const requiresAuthorConfirmation = !distance.calibrated;

  const abstractExpression = speedTier
    ? `约 ${cells} 格程 ÷ ${speedTier.label}（${cellsPerPeriod} 格/时段）${terrainCue.factor !== 1 ? ` × 地形 ${terrainCue.factor}` : ""} ≈ ${suggestedPeriods} 个时段`
    : `约 ${cells} 格程（无可用速度档，需作者确认时长）`;

  const distText = distance.calibrated
    ? `${distance.cells} 格 ≈ ${distance.value} ${distance.unit}`
    : `${distance.cells} 格程（地图未标定，不给真实里数）`;
  const basis = `网格距离 ${distText}；地形 ${terrainCue.label} ×${terrainCue.factor}；速度档 ${speedTier ? speedTier.label : "无"}。${requiresAuthorConfirmation ? "未标定地图，需作者确认。" : ""}`;

  const radius = typeof input.radius === "number" && input.radius > 0 ? input.radius : DEFAULT_NEARBY_RADIUS;
  const nearby = to ? nearbyPoints(world, to.x, to.y, Number(radius), String(to.id)) : [];

  const cues: string[] = [];
  if (from && to) {
    cues.push(`从「${from.name}」(${from.x},${from.y}) 到「${to.name}」(${to.x},${to.y})：${distText}`);
  } else {
    cues.push("起点或终点尚未选定，无法计算网格距离。");
  }
  if (via.length) cues.push(`途经：${via.map((v) => `「${v.name}」`).join(" → ")}`);
  cues.push(`地形：${terrainCue.label} ×${terrainCue.factor}（来源：${terrainCue.source === "settings" ? "地图设置" : "默认基线"}）`);
  cues.push(`速度档：${speedTier ? `${speedTier.label}（${cellsPerPeriod} 格/时段）` : "无"}`);
  cues.push(abstractExpression);
  if (nearby.length) cues.push(`附近地点（半径 ${radius} 格）：${nearby.length} 个`);

  // 世界 Agent 辅助叠加（只读；删除 / 失效时由 resolveTravelContext 保证回退基线）
  const guide = ctx.worldAgent?.travelGuide;
  const worldAgentAssistApplied = Boolean(guide && guide.content.trim());
  if (worldAgentAssistApplied && guide) {
    cues.push(`世界 Agent 旅行辅助（revision ${ctx.worldAgentRevision}）：${guide.content.trim()}`);
    if (guide.assumptions && guide.assumptions.length) {
      cues.push(`辅助假设：${guide.assumptions.join("；")}`);
    }
  }

  // 故事 / IF 的时间与焦点过滤
  if (input.storyId) {
    const branch = input.branchId ?? input.storyId;
    const runtime = (world.storyRuntimes ?? []).find((r) => r.storyId === branch)
      ?? (world.storyRuntimes ?? []).find((r) => r.storyId === input.storyId);
    if (runtime) {
      cues.push(`故事上下文：${formatCalendar(toCalendar(runtime.currentTime))}（第 ${runtime.currentTime} 时段）`);
    }
  }
  if (input.focusCardId) {
    const card = (world.cardProfiles ?? []).find((c) => c.id === input.focusCardId);
    cues.push(card ? `当前焦点卡：${card.summary ?? card.sourceCardId}` : `当前焦点卡：${input.focusCardId}（配置缺失）`);
  }

  return {
    baselineVersion: baseline.version,
    worldAgentRevision: ctx.worldAgentRevision,
    status: ctx.status,
    from: { pointId: from ? String(from.id) : null, name: from ? from.name : null, x: from ? from.x : null, y: from ? from.y : null },
    to: { pointId: to ? String(to.id) : null, name: to ? to.name : null, x: to ? to.x : null, y: to ? to.y : null },
    via,
    distance,
    speedTier: speedTier ? { id: speedTier.id, label: speedTier.label, cellsPerPeriod } : null,
    terrainCue,
    abstractExpression,
    suggestedPeriods,
    suggestedDuration,
    basis,
    requiresAuthorConfirmation,
    nearbyPointIds: nearby,
    cues,
    worldAgentAssistApplied,
  };
}

// ---------------------------------------------------------------------------
// 4. 来源解析
// ---------------------------------------------------------------------------

export type ActionSources = {
  regionIds: string[];
  pointIds: string[];
  characterIds: string[];
  /** 候选触发器 id（只从本次可达来源中挑选） */
  triggerIds: string[];
  /** 附近地点；半径写进结果以便复现 */
  nearbyPointIds: string[];
  radius: number;
  worldBookIds: string[];
};

/** 命中的世界书条目 id（全局 + 参与地区 / 地点；遵守启用与常驻规则）。 */
function collectWorldBookIds(world: World, regionIds: string[], pointIds: string[]): string[] {
  const out: string[] = [];
  const push = (entries: Array<{ id: string; enabled?: boolean }> | undefined) => {
    for (const e of entries ?? []) {
      if (e.enabled === false) continue; // 停用条目绝不发送
      out.push(e.id);
    }
  };
  push(world.worldBible);
  const regionSet = new Set(regionIds);
  for (const r of world.regions ?? []) if (regionSet.has(r.id)) push(r.worldBook);
  const pointSet = new Set(pointIds);
  for (const p of world.points ?? []) if (pointSet.has(String(p.id))) push(p.worldBook);
  return out;
}

/**
 * 解析本次行动的来源。
 * 只取本次可达的：起点 / 终点 / 途经地区与地点、附近地点、
 * 同行人物与当前地点 / 目的地 NPC。**绝不把整个世界的人物与记忆塞进去。**
 */
export function resolveActionSources(
  world: World,
  action: WorldAction,
  opts?: { radius?: number; companionIds?: string[]; branchId?: string | null; storyId?: string | null },
): ActionSources {
  const radius = typeof opts?.radius === "number" && opts.radius > 0 ? opts.radius : 12;

  const regionIds = new Set<string>();
  const pointIds = new Set<string>();
  for (const id of [action.fromRegionId, action.toRegionId]) if (id) regionIds.add(id);
  for (const id of [action.fromPointId, action.toPointId]) if (id) pointIds.add(id);
  for (const id of action.viaPointIds ?? []) if (id) pointIds.add(id);

  // 途经 / 起终点所在地区
  for (const p of world.points ?? []) {
    if (pointIds.has(String(p.id)) && p.regionId) regionIds.add(p.regionId);
  }

  // 附近地点（以终点为中心；没有终点时用起点）
  const anchorPointId = action.toPointId ?? action.fromPointId;
  const anchor = anchorPointId
    ? (world.points ?? []).find((p) => String(p.id) === anchorPointId)
    : null;
  const nearby = anchor ? nearbyPoints(world, anchor.x, anchor.y, radius, String(anchor.id)) : [];

  // 人物：同行者 + 当前地点 NPC + 目的地 / 途经地点 NPC
  const characterIds = new Set<string>();
  for (const id of opts?.companionIds ?? []) if (id) characterIds.add(id);
  if (action.actorId) characterIds.add(action.actorId);
  const targetPoints = new Set<string>([...pointIds, ...nearby]);
  // N2：按分支作用域读取 NPC 位置——正史读基线，IF 读「基线 + 本 IF 覆盖」的合并视图。
  const branch = opts?.branchId ?? branchScopeForStory(world, opts?.storyId ?? null);
  for (const s of branchCharacterStates(world, branch)) {
    if (s.currentPointId && targetPoints.has(String(s.currentPointId))) characterIds.add(s.characterId);
  }

  const worldBookIds = collectWorldBookIds(world, [...regionIds], [...pointIds, ...nearby]);

  // 触发器只从本次可达来源中挑选
  const triggerIds: string[] = [];
  for (const t of world.triggers ?? []) {
    if (t.enabled === false) continue;
    const scopeRegions = t.scopeRegionIds ?? [];
    const scopePoints = t.scopePointIds ?? [];
    const inScope =
      scopeRegions.length === 0 && scopePoints.length === 0
        ? true
        : scopeRegions.some((id) => regionIds.has(id)) || scopePoints.some((id) => pointIds.has(id) || nearby.includes(id));
    if (inScope) triggerIds.push(t.id);
  }

  return {
    regionIds: [...regionIds],
    pointIds: [...pointIds],
    characterIds: [...characterIds],
    triggerIds,
    nearbyPointIds: nearby,
    radius,
    worldBookIds,
  };
}

// ---------------------------------------------------------------------------
// 5. 触发器筛选（只支持可解释条件）
// ---------------------------------------------------------------------------

export type TriggerContext = {
  /** 当前世界时间（总时段） */
  at: number;
  regionId: string | null;
  pointId: string | null;
  characterIds: string[];
  /** 已发生的世界标记 */
  flags: string[];
};

/** 触发器是否命中当前上下文（时间 / 位置 / 参与人物 / 已发生 / 未发生标记）。 */
export function triggerMatches(trigger: WorldTrigger, ctx: TriggerContext): boolean {
  if (trigger.enabled === false) return false;
  const cond = trigger.condition;
  if (!cond) return true; // 无条件触发器：只要在来源范围内就命中

  if (typeof cond.minTime === "number" && ctx.at < cond.minTime) return false;
  if (typeof cond.maxTime === "number" && ctx.at > cond.maxTime) return false;
  if (cond.regionId && ctx.regionId !== cond.regionId) return false;
  if (cond.pointId && ctx.pointId !== cond.pointId) return false;
  if (cond.characterIds && cond.characterIds.length > 0) {
    const present = new Set(ctx.characterIds);
    if (!cond.characterIds.some((id) => present.has(id))) return false;
  }
  if (cond.requiresFlag && !ctx.flags.includes(cond.requiresFlag)) return false;
  if (cond.forbidsFlag && ctx.flags.includes(cond.forbidsFlag)) return false;
  return true;
}

/** 在可达来源内筛选本次命中的触发器。 */
export function selectTriggers(world: World, sources: ActionSources, ctx: TriggerContext): WorldTrigger[] {
  const allowed = new Set(sources.triggerIds);
  return (world.triggers ?? []).filter((t) => allowed.has(t.id) && triggerMatches(t, ctx));
}

// ---------------------------------------------------------------------------
// 6. 确定性随机（持久化种子驱动）
// ---------------------------------------------------------------------------

export type Rng = {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: T[]): T | null;
  chance(probability: number): boolean;
};

/**
 * mulberry32：确定性伪随机。相同种子永远产生相同序列。
 * 文件内禁止使用 Math.random()——随机性必须可复现。
 */
export function createRng(seed: number): Rng {
  let s = (Math.floor(seed) >>> 0) || 1;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (maxExclusive: number) => (maxExclusive <= 0 ? 0 : Math.floor(next() * maxExclusive)),
    pick: <T,>(items: T[]): T | null => (items.length === 0 ? null : items[Math.floor(next() * items.length)] ?? null),
    chance: (probability: number) => next() < probability,
  };
}

/**
 * 派生行动种子：由 worldId + 故事线 + 已发生行动数 + 当前时刻决定。
 * 这些值全部持久化，因此**刷新后重放能得到同一结果**，无需额外存种子。
 */
export function deriveActionSeed(world: World, storyId: string | null | undefined, actionCount: number, at: number): number {
  const raw = `${world.id}|${storyId ?? "-"}|${actionCount}|${at}`;
  return parseInt(hashString(raw).slice(0, 8), 16) >>> 0;
}

// ---------------------------------------------------------------------------
// 7. 结果抽取（本地，不调 API）
// ---------------------------------------------------------------------------

export type RollOptions = {
  /** 命中触发器的概率；缺省 0.35 */
  triggerChance?: number;
  /** 时间戳注入（禁止内部调用 Date.now） */
  now?: number;
};

/**
 * 用记录的种子抽取本次结果。
 * 「无事发生」也必须产出**可解释**的结果记录（写明为什么没触发）。
 */
export function rollActionOutcome(
  world: World,
  action: WorldAction,
  candidates: WorldTrigger[],
  opts: RollOptions = {},
): { action: WorldAction; outcome: WorldOutcome; trigger: WorldTrigger | null } {
  const seed = typeof action.seed === "number" ? action.seed : deriveActionSeed(world, null, 0, action.at);
  const rng = createRng(seed);
  const chance = typeof opts.triggerChance === "number" ? opts.triggerChance : 0.35;
  const at = opts.now ?? action.at;
  const outcomeId = `out-${hashString(`${action.id}|${seed}`)}`;

  if (candidates.length === 0) {
    const outcome: WorldOutcome = {
      id: outcomeId,
      actionId: action.id,
      kind: "nothing",
      result: "无事发生",
      reason: "本次行动可达来源内没有命中任何已启用触发器。",
      seed,
      at,
    };
    return { action: { ...action, outcomeId: outcome.id, seed }, outcome, trigger: null };
  }

  const fired = rng.chance(chance) ? rng.pick(candidates) : null;
  if (!fired) {
    const outcome: WorldOutcome = {
      id: outcomeId,
      actionId: action.id,
      kind: "nothing",
      result: "无事发生",
      reason: `可达来源内有 ${candidates.length} 个候选触发器，按种子 ${seed} 抽取未命中（概率 ${chance}）。`,
      changeRefs: candidates.map((t) => `trigger:${t.id}`),
      seed,
      at,
    };
    return { action: { ...action, outcomeId: outcome.id, seed }, outcome, trigger: null };
  }

  const outcome: WorldOutcome = {
    id: outcomeId,
    actionId: action.id,
    kind: "trigger",
    triggerId: fired.id,
    result: fired.outcomeTemplate ?? fired.title,
    changeRefs: [`trigger:${fired.id}`, ...(fired.outcomeTags ?? []).map((t) => `flag:${t}`)],
    reason: `按种子 ${seed} 命中触发器「${fired.title}」。`,
    seed,
    at,
  };
  return { action: { ...action, outcomeId: outcome.id, seed }, outcome, trigger: fired };
}

// ---------------------------------------------------------------------------
// 8. 状态变更（确定性）
// ---------------------------------------------------------------------------

export type ApplyOptions = {
  storyId?: string | null;
  branchId?: string | null;
  /** 同行者（一并移动到终点） */
  companionIds?: string[];
  /** 时间戳注入 */
  now?: number;
};

/** 写入或更新某个人物的位置状态（返回新数组，不修改入参）。
 * N2：`branchId` 为空时写**正史基线**，否则只写该 IF 的覆盖条目
 * （正史基线与兄弟 IF 一个字节都不动）。 */
function upsertCharacterState(
  states: CharacterState[],
  characterId: string,
  regionId: string | null,
  pointId: string | null,
  now: number,
  branchId: string | null = null,
): CharacterState[] {
  const out = [...states];
  const idx = out.findIndex(
    (s) => s.characterId === characterId && (branchId ? s.branchId === branchId : !s.branchId),
  );
  const patch: CharacterState = {
    characterId,
    currentRegionId: regionId,
    currentPointId: pointId,
    updatedAt: now,
    ...(branchId ? { branchId } : {}),
  };
  if (idx >= 0) {
    const prev = out[idx]!;
    out[idx] = { ...prev, ...patch, ...(prev.status !== undefined ? { status: prev.status } : {}) };
  } else {
    out.push(patch);
  }
  return out;
}

/**
 * 应用本次行动的确定性结果：推进时间、更新位置、写日志。
 * 纯函数：返回新的 World，不修改入参。全程 0 fetch。
 */
export function applyActionResult(world: World, action: WorldAction, outcome: WorldOutcome, opts: ApplyOptions = {}): World {
  const now = opts.now ?? 0;
  // PLAY-01 时间边界：只接受**有限的正**时长。`advancePeriods` 只把结果夹到 ≥0、不夹增量，
  // 所以负数会让时间倒退（实测 100 → 90）；NaN / Infinity 会污染 currentTime。
  // 解析层（三处 `duration < 0 → null`）与界面（manualValid 禁用按钮）已各自挡住，
  // 这里是纯函数层的兜底：任何内存调用方喂进来都不会让世界时间倒流。
  const duration = typeof action.duration === "number" && Number.isFinite(action.duration) && action.duration > 0
    ? action.duration
    : 0;
  let next: World = { ...world };

  // 1. 推进故事运行快照的时间与位置
  if (opts.storyId) {
    const branch = opts.branchId ?? opts.storyId;
    const runtimes = [...(next.storyRuntimes ?? [])];
    const idx = runtimes.findIndex((r) => r.storyId === branch);
    if (idx >= 0) {
      const rt: StoryRuntime = runtimes[idx]!;
      runtimes[idx] = {
        ...rt,
        currentTime: advancePeriods(rt.currentTime, duration),
        ...(action.toRegionId !== undefined ? { currentRegionId: action.toRegionId } : {}),
        ...(action.toPointId !== undefined ? { currentPointId: action.toPointId } : {}),
        actionLog: [...(rt.actionLog ?? []), action.id].slice(-W0_LIMITS.maxActions),
        updatedAt: now,
      };
      next = { ...next, storyRuntimes: runtimes };
    }
  }

  // 2. 移动发起者与同行者
  // 只有**确实存在目的地**时才移动：等待 / 原地交互没有终点，绝不能把人物位置清空。
  {
    const hasDestination = Boolean(action.toPointId) || Boolean(action.toRegionId);
    const movers = new Set<string>([...(opts.companionIds ?? [])]);
    if (action.actorId) movers.add(action.actorId);
    if (hasDestination && movers.size > 0) {
      // N2：正史线写基线（branchId=null），IF 只写自己的覆盖。
      const branch = opts.branchId ?? branchScopeForStory(world, opts.storyId ?? null);
      let states = next.characterStates ?? [];
      for (const id of movers) {
        states = upsertCharacterState(states, id, action.toRegionId ?? null, action.toPointId ?? null, now, branch);
      }
      next = { ...next, characterStates: states };
    }
  }

  // 3. 追加行动 / 结果日志（上限收敛，保留最近的）
  next = {
    ...next,
    actions: [...(next.actions ?? []), action].slice(-W0_LIMITS.maxActions),
    outcomes: [...(next.outcomes ?? []), outcome].slice(-W0_LIMITS.maxOutcomes),
  };

  // 4. 触发结果产生的世界标记
  const flagRefs = (outcome.changeRefs ?? []).filter((r) => r.startsWith("flag:")).map((r) => r.slice(5));
  if (flagRefs.length && opts.storyId) {
    const branch = opts.branchId ?? opts.storyId;
    const runtimes = [...(next.storyRuntimes ?? [])];
    const idx = runtimes.findIndex((r) => r.storyId === branch);
    if (idx >= 0) {
      const rt = runtimes[idx]!;
      const merged = [...new Set([...(rt.worldFlags ?? []), ...flagRefs])].slice(0, W0_LIMITS.maxWorldFlags);
      runtimes[idx] = { ...rt, worldFlags: merged, updatedAt: now };
      next = { ...next, storyRuntimes: runtimes };
    }
  }

  return next;
}

// ---------------------------------------------------------------------------
// 9. 完整流程编排
// ---------------------------------------------------------------------------

export type LocalActionInput = {
  kind: WorldActionKind;
  storyId?: string | null;
  branchId?: string | null;
  actorId?: string | null;
  fromPointId?: string | null;
  toPointId?: string | null;
  viaPointIds?: string[];
  /** 作者确认后的时长；未给则取 hint 建议值 */
  duration?: number;
  /** 时长来源（默认基线建议） */
  durationSource?: DurationSource;
  focusCardId?: string | null;
  speedTierId?: string | null;
  radius?: number;
  companionIds?: string[];
  /** 外部注入种子；不给则由 worldId + 故事线 + 行动数 + 时刻派生 */
  seed?: number;
  /** 时间戳注入（禁止内部 Date.now） */
  now?: number;
};

export type LocalActionResult = {
  world: World;
  action: WorldAction;
  outcome: WorldOutcome;
  hint: TravelHint;
  sources: ActionSources;
  trigger: WorldTrigger | null;
};

/**
 * 一次本地行动的完整流程：
 * 构造 TravelHint（基线 + 可选世界 Agent）→ 生成行动 → 解析来源
 * → 筛选触发器 → 用种子抽取结果 → 应用确定性状态变更。
 * **全程 0 fetch、0 Math.random、0 Date.now。**
 *
 * N4：`opts.apply === false` 时只掷骰不落库（行动确认后先进入创作反馈面板，
 * 逐项接受后才经 `applyActionResult` 写入），返回的 `world` 与入参引用相等。
 */
export function runLocalAction(world: World, input: LocalActionInput, opts: { triggerChance?: number; apply?: boolean } = {}): LocalActionResult | null {
  if (!WORLD_ACTION_KINDS.includes(input.kind)) return null;
  const now = input.now ?? 0;

  const branch = input.branchId ?? input.storyId ?? null;
  const runtime = branch
    ? (world.storyRuntimes ?? []).find((r) => r.storyId === branch)
    : undefined;
  const at = runtime ? runtime.currentTime : 0;

  const hint = buildTravelHint(world, {
    fromPointId: input.fromPointId,
    toPointId: input.toPointId,
    viaPointIds: input.viaPointIds,
    speedTierId: input.speedTierId,
    storyId: input.storyId,
    branchId: input.branchId,
    focusCardId: input.focusCardId,
    radius: input.radius,
  });

  const duration = typeof input.duration === "number"
    ? input.duration
    : (hint.suggestedDuration ?? 0);
  const durationSource: DurationSource =
    input.durationSource ?? (typeof input.duration === "number" ? "manual" : (hint.worldAgentAssistApplied ? "worldAgent" : "baseline"));

  const seed = typeof input.seed === "number"
    ? input.seed
    : deriveActionSeed(world, branch, (world.actions ?? []).length, at);

  const fromPoint = input.fromPointId
    ? (world.points ?? []).find((p) => String(p.id) === input.fromPointId)
    : undefined;
  const toPoint = input.toPointId
    ? (world.points ?? []).find((p) => String(p.id) === input.toPointId)
    : undefined;

  const actionId = `act-${hashString(`${world.id}|${branch ?? "-"}|${at}|${seed}`)}`;
  const travelContext = resolveTravelContext(world);
  const action: WorldAction = {
    id: actionId,
    at,
    kind: input.kind,
    ...(input.actorId ? { actorId: input.actorId } : { actorId: null }),
    fromRegionId: fromPoint?.regionId ?? null,
    fromPointId: input.fromPointId ?? null,
    toRegionId: toPoint?.regionId ?? null,
    toPointId: input.toPointId ?? null,
    ...(input.viaPointIds && input.viaPointIds.length ? { viaPointIds: [...input.viaPointIds] } : {}),
    duration,
    durationSource,
    baselineVersion: hint.baselineVersion,
    worldAgentRevision: travelContext.worldAgentRevision,
    ...(input.focusCardId ? { focusCardId: input.focusCardId } : { focusCardId: null }),
    startedAt: at,
    endedAt: advancePeriods(at, duration),
    seed,
    outcomeId: null,
  };

  const sources = resolveActionSources(world, action, {
    radius: input.radius,
    companionIds: input.companionIds,
  });

  const triggerCtx: TriggerContext = {
    at: action.endedAt ?? action.at,
    regionId: action.toRegionId ?? action.fromRegionId ?? null,
    pointId: action.toPointId ?? action.fromPointId ?? null,
    characterIds: sources.characterIds,
    flags: runtime?.worldFlags ?? [],
  };
  const candidates = selectTriggers(world, sources, triggerCtx);

  const rolled = rollActionOutcome(world, action, candidates, { triggerChance: opts.triggerChance, now: triggerCtx.at });
  if (opts.apply === false) {
    return { world, action: rolled.action, outcome: rolled.outcome, hint, sources, trigger: rolled.trigger };
  }
  const applied = applyActionResult(world, rolled.action, rolled.outcome, {
    storyId: input.storyId,
    branchId: input.branchId,
    companionIds: input.companionIds,
    now,
  });

  return {
    world: applied,
    action: rolled.action,
    outcome: rolled.outcome,
    hint,
    sources,
    trigger: rolled.trigger,
  };
}

/** 构造候选来源引用（供日志与上下文预算使用）。 */
export function toSourceRefs(sources: ActionSources): WorldActionSourceRef[] {
  const refs: WorldActionSourceRef[] = [];
  for (const id of sources.regionIds) refs.push({ kind: "region", id });
  for (const id of sources.pointIds) refs.push({ kind: "point", id });
  for (const id of sources.characterIds) refs.push({ kind: "character", id });
  for (const id of sources.worldBookIds) refs.push({ kind: "worldBook", id });
  for (const id of sources.triggerIds) refs.push({ kind: "trigger", id });
  return refs.slice(0, W0_LIMITS.maxCandidateSources);
}
