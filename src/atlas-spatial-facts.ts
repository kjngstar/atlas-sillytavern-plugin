/**
 * atlas-spatial-facts.ts — 基础空间属性与统一投影（P07 §13.1/§13.2）。
 *
 * 这一层只做一件事：把「场景里有什么、它挡不挡路、挡不挡视线」变成**同一份**可比较事实，
 * 然后按角色投影出去。正文、NPC、玩家地图都从这一份出发，不各算一套。
 *
 * 纪律：
 * - 只读真实 scene / canonical / traits，**不生成地图**；玩家地图不用于反推世界事实。
 * - 坐标统一局部 top-left / right / down；跨图比较必须先有显式变换，否则返回 null 并报错。
 * - 米与格不混算：`units` 与 `metersPerCell` 一起给，缺一个就不做换算。
 * - 不明确材质或状态一律 unknown，**不从图片颜色、透明度 CSS 或名字硬猜**。
 * - 渲染用的 opacity 是配色透明度，永远不当 blocksSight。
 */

import type { PlanIssue } from './atlas-world-contract.ts';

export type SpatialGeometryV1 = {
  mapId: string;
  units: 'meters' | 'cells';
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  rotation: number | null;
};

export const SPATIAL_OBJECT_KINDS = ['wall', 'glass', 'door', 'window', 'furniture', 'other', 'unknown'] as const;
export type SpatialObjectKind = (typeof SPATIAL_OBJECT_KINDS)[number];

export const SPATIAL_MATERIALS = ['solid', 'glass', 'wood', 'fabric', 'other', 'unknown'] as const;
export type SpatialMaterial = (typeof SPATIAL_MATERIALS)[number];

export const SPATIAL_OPENING_STATES = ['open', 'closed', 'not-applicable', 'unknown'] as const;
export type SpatialOpeningState = (typeof SPATIAL_OPENING_STATES)[number];

export const SPATIAL_TRAIT_SOURCES = ['author', 'canonical', 'estimated', 'unknown'] as const;
export type SpatialTraitSource = (typeof SPATIAL_TRAIT_SOURCES)[number];

export type SpatialTraitV1 = {
  geometry?: SpatialGeometryV1 | null;
  objectId: string;
  kind: SpatialObjectKind;
  material: SpatialMaterial;
  openingState: SpatialOpeningState;
  /** 锁状态：`null` 表示不适用或未知（门窗以外通常是 null）。 */
  locked: boolean | null;
  /** 当前是否阻挡移动。`null` = 不知道（不自动放行）。 */
  blocksMovement: boolean | null;
  /** 当前是否阻挡视线。`null` = 不知道。 */
  blocksSight: boolean | null;
  /** 占地格数（已知才有）。 */
  footprintCells: number | null;
  source: SpatialTraitSource;
};

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function pick<T extends string>(values: readonly T[], raw: unknown, fallback: T): T {
  const value = text(raw).toLowerCase();
  return (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

function finitePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * §13.2 的真值表：把「什么材质 + 什么状态」翻成「挡不挡路 / 挡不挡视线」。
 *
 * 这张表是**唯一**判定点。渲染层、正文层、NPC 层都读它，不许各自再写一套 if。
 * 未知一律 `null`：未知不等于通畅，也不等于阻挡。
 */
export function resolveSpatialTrait(input: {
  geometry?: SpatialGeometryV1 | null;
  objectId: unknown;
  kind?: unknown;
  material?: unknown;
  openingState?: unknown;
  locked?: unknown;
  footprintCells?: unknown;
  source?: unknown;
}): SpatialTraitV1 {
  const objectId = text(input?.objectId);
  const kind = pick(SPATIAL_OBJECT_KINDS, input?.kind, 'unknown');
  const material = pick(SPATIAL_MATERIALS, input?.material, 'unknown');
  const openingState = pick(SPATIAL_OPENING_STATES, input?.openingState, 'unknown');
  const locked = input?.locked === true ? true : input?.locked === false ? false : null;
  const footprintCells = finitePositive(input?.footprintCells);
  const source = pick(SPATIAL_TRAIT_SOURCES, input?.source, 'unknown');

  const base: SpatialTraitV1 = {
    ...(input.geometry ? { geometry: input.geometry } : {}),
    objectId,
    kind,
    material,
    openingState,
    locked,
    blocksMovement: null,
    blocksSight: null,
    footprintCells,
    source,
  };

  // 实墙：挡路、挡视线。材质不明但形态明确是墙时，仍按墙处理（形态是显式档案）。
  if (kind === 'wall') {
    return { ...base, blocksMovement: true, blocksSight: material === 'glass' ? false : true };
  }

  // 完整玻璃隔断：挡路、可透视（≠ 可穿越）。墙+玻璃材质已在上一条分支里处理。
  if (kind === 'glass') {
    return { ...base, blocksMovement: true, blocksSight: false };
  }

  // 门：打开不挡路（门扇几何仍在，由几何层表达）；关闭挡路可尝试开；上锁要锁条件。
  if (kind === 'door') {
    if (openingState === 'open') return { ...base, blocksMovement: false, blocksSight: false };
    if (openingState === 'closed') {
      // 关闭的门不是「永久无路」：挡路，但行动可以尝试开门。
      return { ...base, blocksMovement: true, blocksSight: material === 'glass' ? false : true };
    }
    return { ...base, blocksMovement: null, blocksSight: null };
  }

  // 窗户：透视与穿越分开表达；开窗不默认能走人（穿越要靠入口事实或门的档案）。
  if (kind === 'window') {
    return { ...base, blocksMovement: true, blocksSight: false };
  }

  // 家具：占地与遮挡按档案给；高书架/大柜这一层不猜，只看档案。
  if (kind === 'furniture') {
    const tall = footprintCells !== null && footprintCells >= 4 ? true : null;
    return { ...base, blocksMovement: true, blocksSight: tall };
  }

  // other / unknown：不猜。
  return base;
}

export type SpatialFactsUnits = 'cells' | 'meters';
export type SpatialMetricQuality = 'calibrated' | 'estimated' | 'unknown';

export type SpatialRouteFact = {
  routeId: string;
  fromObjectId: string;
  toObjectId: string;
  passable: boolean | null;
};

export type SpatialFactsV1 = {
  version: 1;
  mapId: string;
  /** 坐标单位：米与格绝不混算。 */
  units: SpatialFactsUnits;
  /** 一格多少米；`units === 'cells'` 且此值为 null 时不允许换算。 */
  metersPerCell: number | null;
  metricQuality: SpatialMetricQuality;
  /** 输入来源的版本（revision / 场景签名），用于判断投影是否过期。 */
  sourceRevision: number;
  sceneSignature: string;
  objects: readonly SpatialTraitV1[];
  routes: readonly SpatialRouteFact[];
  issues: readonly PlanIssue[];
};

export type SpatialFactsInput = {
  mapId: unknown;
  objects?: readonly {
    geometry?: SpatialGeometryV1 | null;
    objectId: unknown;
    kind?: unknown;
    material?: unknown;
    openingState?: unknown;
    locked?: unknown;
    footprintCells?: unknown;
    source?: unknown;
  }[];
  routes?: readonly { routeId: unknown; fromObjectId: unknown; toObjectId: unknown; passable?: unknown }[];
  metersPerCell?: unknown;
  sourceRevision?: unknown;
  sceneSignature?: unknown;
};

/**
 * §13.1：单一事实构建器。
 *
 * 只读、只投影，不写库。同一份输入永远得到同一份输出（对象按 ID 排序）。
 */
export function collectSpatialFacts(input: SpatialFactsInput): SpatialFactsV1 {
  const mapId = text(input?.mapId);
  const issues: PlanIssue[] = [];
  const metersPerCell = finitePositive(input?.metersPerCell);
  const units: SpatialFactsUnits = metersPerCell !== null ? 'meters' : 'cells';
  const metricQuality: SpatialMetricQuality = metersPerCell !== null ? 'estimated' : 'unknown';

  if (mapId.length === 0) {
    issues.push({
      code: 'SPATIAL_FACTS_MAP_MISSING',
      path: '$.mapId',
      message: '没有地图 ID 就无法把事实绑定到任何一张图上；本结果不参与投影。',
      severity: 'error',
      retryable: false,
    });
  }

  const seen = new Set<string>();
  const objects: SpatialTraitV1[] = [];
  for (const raw of input?.objects ?? []) {
    const trait = resolveSpatialTrait(raw);
    if (trait.objectId.length === 0) {
      issues.push({
        code: 'SPATIAL_TRAIT_OBJECT_MISSING',
        path: '$.objects',
        message: '有空间属性条目没有物体 ID：无法绑定到真实 scene，已跳过（不按「第一个门」猜）。',
        severity: 'warning',
        retryable: false,
      });
      continue;
    }
    if (seen.has(trait.objectId)) {
      issues.push({
        code: 'SPATIAL_TRAIT_DUPLICATE',
        path: `$.objects.${trait.objectId}`,
        message: `物体 ${trait.objectId} 有多条属性：不按数组顺序取最后一条，保留第一条并报重复。`,
        severity: 'warning',
        retryable: false,
      });
      continue;
    }
    seen.add(trait.objectId);
    objects.push(trait);
  }
  objects.sort((left, right) => (left.objectId < right.objectId ? -1 : left.objectId > right.objectId ? 1 : 0));

  const routes: SpatialRouteFact[] = (input?.routes ?? [])
    .map((route) => ({
      routeId: text(route?.routeId),
      fromObjectId: text(route?.fromObjectId),
      toObjectId: text(route?.toObjectId),
      passable: route?.passable === true ? true : route?.passable === false ? false : null,
    }))
    .filter((route) => route.routeId.length > 0)
    .sort((left, right) => (left.routeId < right.routeId ? -1 : left.routeId > right.routeId ? 1 : 0));

  return {
    version: 1,
    mapId,
    units,
    metersPerCell,
    metricQuality,
    sourceRevision: typeof input?.sourceRevision === 'number' && Number.isFinite(input.sourceRevision)
      ? Math.max(0, Math.floor(input.sourceRevision))
      : 0,
    sceneSignature: text(input?.sceneSignature),
    objects,
    routes,
    issues,
  };
}

/* ------------------------------------------------------------------ *
 * 坐标与跨图变换
 * ------------------------------------------------------------------ */

export type LocalPoint = { x: number; y: number };

/**
 * 跨图比较必须先有显式变换（§13.1）。
 *
 * 没有变换就返回 null —— 不拿两张图的局部坐标直接相减，也不「差不多对齐」。
 */
export function transformPointBetweenMaps(input: {
  point: LocalPoint;
  transform: { scale: number; offsetX: number; offsetY: number } | null | undefined;
}): LocalPoint | null {
  const transform = input?.transform;
  if (!transform) return null;
  const scale = finitePositive(transform.scale);
  if (scale === null) return null;
  if (!Number.isFinite(transform.offsetX) || !Number.isFinite(transform.offsetY)) return null;
  const x = Number(input.point?.x);
  const y = Number(input.point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: x * scale + transform.offsetX, y: y * scale + transform.offsetY };
}

/* ------------------------------------------------------------------ *
 * §13.3 角色投影
 * ------------------------------------------------------------------ */

export type ActorSpatialFactsV1 = {
  version: 1;
  actorId: string;
  mapId: string;
  units: SpatialFactsUnits;
  metersPerCell: number | null;
  /** 该角色**当前可观察**的物体与属性。 */
  observed: readonly SpatialTraitV1[];
  /** 只知道「以前在哪」的位置：明确带 asOfTurnId，不当成当前实测。 */
  lastKnown: readonly { objectId: string; asOfTurnId: string }[];
  /** 被过滤掉的物体 ID（用于诊断「为什么正文里没有它」）。 */
  withheldObjectIds: readonly string[];
  issues: readonly PlanIssue[];
};

/**
 * 按角色投影空间事实。
 *
 * - `knownObjectIds` 为空表示「同地即可见」的粗粒度场景：投影全部**非秘密**物体；
 * - 秘密空间（`secretObjectIds`）与显式隐匿的物体一律不投影；
 * - `lastKnownPositions` 只作为历史位置输出，并带 asOfTurnId —— 不标成当前实测。
 */
export function projectSpatialFactsForActor(input: {
  facts: SpatialFactsV1;
  actorId: unknown;
  knownObjectIds?: readonly string[];
  secretObjectIds?: readonly string[];
  hiddenObjectIds?: readonly string[];
  lastKnownPositions?: readonly { objectId: unknown; asOfTurnId: unknown }[];
}): ActorSpatialFactsV1 {
  const actorId = text(input?.actorId);
  const facts = input?.facts;
  const secret = new Set((input?.secretObjectIds ?? []).map(text).filter((id) => id.length > 0));
  const hidden = new Set((input?.hiddenObjectIds ?? []).map(text).filter((id) => id.length > 0));
  const knownList = (input?.knownObjectIds ?? []).map(text).filter((id) => id.length > 0);
  const known = knownList.length > 0 ? new Set(knownList) : null;
  const issues: PlanIssue[] = [];

  const observed: SpatialTraitV1[] = [];
  const withheld: string[] = [];
  for (const trait of facts?.objects ?? []) {
    if (secret.has(trait.objectId) || hidden.has(trait.objectId)) {
      withheld.push(trait.objectId);
      continue;
    }
    if (known !== null && !known.has(trait.objectId)) {
      withheld.push(trait.objectId);
      continue;
    }
    observed.push(trait);
  }

  const lastKnown = (input?.lastKnownPositions ?? [])
    .map((entry) => ({ objectId: text(entry?.objectId), asOfTurnId: text(entry?.asOfTurnId) }))
    .filter((entry) => entry.objectId.length > 0 && entry.asOfTurnId.length > 0)
    // 秘密/隐匿物体连「以前在哪」都不给 —— 那本身就是泄漏。
    .filter((entry) => !secret.has(entry.objectId) && !hidden.has(entry.objectId))
    .sort((left, right) => (left.objectId < right.objectId ? -1 : left.objectId > right.objectId ? 1 : 0));

  if (facts?.metersPerCell === null && facts?.units === 'cells') {
    issues.push({
      code: 'SPATIAL_PROJECTION_UNITS_CELLS',
      path: `$.actors.${actorId}.spatial`,
      message: '该图未标定（只有格、没有米）：投影里不出现米制距离，避免把格当米说给玩家。',
      severity: 'warning',
      retryable: false,
    });
  }

  return {
    version: 1,
    actorId,
    mapId: facts?.mapId ?? '',
    units: facts?.units ?? 'cells',
    metersPerCell: facts?.metersPerCell ?? null,
    observed,
    lastKnown,
    withheldObjectIds: [...new Set(withheld)].sort(),
    issues,
  };
}
