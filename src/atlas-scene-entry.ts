/**
 * atlas-scene-entry.ts — P10 §16.1/§16.2：什么算「剧情实际进入」，以及进入后向正文提供什么。
 *
 * 两个函数分工明确：
 * - `collectConfirmedSceneEntries`：**只认已确认的进入**。用户说「我想进去」、点地图、hover、
 *   点生成按钮都不算 —— 它们没有正文依据，也没有合法编译后的人物位置变化。
 * - `buildActorSceneContext`：给正文的**当前 actor 投影**。只给能观察到的：地点链、入口、
 *   关键家具与障碍的真实占地、在场人物/物品、仍适用的空间约束。
 *
 * 纪律（§16.3）：
 * - 不注入整世界几何，不塞全人物名单、秘密房间、远处行动、NPC 私下认知；
 * - 容量不足时**原子保留** frame / 自身 / 相关障碍与引用关系，绝不截半个对象或留下无定义的 `O7`；
 * - 容量不足必须可诊断（`SCENE_CONTEXT_TRUNCATED`），不靠静默截断假装支持遮挡。
 */

import type { PlanIssue } from './atlas-world-contract.ts';
import type { SpatialGeometryV1 } from './atlas-spatial-facts.ts';
import type { SpatialTraitV1 } from './atlas-spatial-facts.ts';
import { resolveSpatialTrait } from './atlas-spatial-facts.ts';

/* ------------------------------------------------------------------ *
 * §16.1 进入触发
 * ------------------------------------------------------------------ */

/** 可以算「确认进入」的来源：全部来自正文/已发生事件。 */
export const SCENE_ENTRY_CONFIRMING_SOURCES = ['narrative-entry', 'narrative-arrival', 'event-move', 'compiled-position-change'] as const;
export type SceneEntryConfirmingSource = (typeof SCENE_ENTRY_CONFIRMING_SOURCES)[number];

/**
 * 明确**不算**进入的来源。列出来是为了让「意图不触发」变成可断言的常量，
 * 而不是散落在各处的 `if`。
 */
export const SCENE_ENTRY_NON_TRIGGERS = ['user-intent', 'map-click', 'map-hover', 'generate-button', 'ui-preview'] as const;

export type SceneEntryEventV1 = {
  eventId: string;
  turnId: string;
  /** 事件类型：move / enter / arrive …（大小写不敏感）。 */
  type: string;
  actorId: string;
  fromLocationId: string | null;
  toLocationId: string | null;
  occurredAtS: number;
  /** 是否来自已接受的事件/正文（false = 仅模型提议或界面动作）。 */
  confirmed: boolean;
};

export type ScenePositionChangeV1 = {
  actorId: string;
  turnId: string;
  previousLocationId: string | null;
  locationId: string;
  /** 编译是否通过；没通过的位置变化不算进入。 */
  compiled: boolean;
  /**
   * 变化种类：`moved` = 真的换了地点；
   * `precision-refined` = 主角从父层粗归属细化到同一房间的坐标（**不重复触发**）。
   */
  kind: 'moved' | 'precision-refined';
  /** 目标地点所在的内部地图（进入设施时才有）。 */
  interiorMapId?: string | null;
};

export type ConfirmedSceneEntryV1 = {
  version: 1;
  dedupeKey: string;
  actorId: string;
  fromLocationId: string | null;
  toLocationId: string;
  interiorMapId: string | null;
  source: SceneEntryConfirmingSource;
  eventId: string | null;
  turnId: string;
  confirmedAtS: number;
  isProtagonist: boolean;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function mapIdOf(value: unknown): string | null {
  const id = text(value);
  return id ? id : null;
}

/** 稳定去重键：同一 actor 同一次进入同一目标只产生一条。 */
export function sceneEntryDedupeKey(input: {
  actorId: string;
  toLocationId: string;
  turnId: string;
  interiorMapId?: string | null;
}): string {
  return [text(input?.actorId), text(input?.toLocationId), text(input?.turnId), mapIdOf(input?.interiorMapId) ?? ''].join('|');
}

export type CollectSceneEntriesInput = {
  events?: readonly SceneEntryEventV1[];
  positionChanges?: readonly ScenePositionChangeV1[];
  /** 已保存剧情批次的楼层：没保存的楼层不触发（§16.2 时序）。 */
  savedFloorIds?: readonly string[];
  protagonistId?: string | null;
  /** 界面意图，仅用于证明它们不触发；不影响结果。 */
  intents?: readonly { source: string }[];
};

export type CollectSceneEntriesResult = {
  entries: ConfirmedSceneEntryV1[];
  issues: PlanIssue[];
};

function issueOf(code: string, message: string, path = '$'): PlanIssue {
  return { code, path, message, severity: 'warning', retryable: false };
}

/**
 * §16.1：触发要**同时**具备三件事 ——
 * 本轮正文/已发生事件明确进入或抵达、合法编译后位置真的变化、楼层已保存。
 * 少一件就不建 job；重复 received/ended、同文重放不会建出两个 job。
 */
export function collectConfirmedSceneEntries(input: CollectSceneEntriesInput): CollectSceneEntriesResult {
  const saved = new Set((input?.savedFloorIds ?? []).map((id) => text(id)).filter(Boolean));
  const protagonistId = text(input?.protagonistId);
  const issues: PlanIssue[] = [];
  const entries: ConfirmedSceneEntryV1[] = [];
  const byPosition = new Map<string, ScenePositionChangeV1>();
  for (const change of input?.positionChanges ?? []) {
    byPosition.set(`${text(change?.actorId)}|${text(change?.turnId)}`, change);
  }

  for (const event of input?.events ?? []) {
    const actorId = text(event?.actorId);
    const toLocationId = text(event?.toLocationId);
    const turnId = text(event?.turnId);
    if (!actorId || !toLocationId || !turnId) {
      if (event?.confirmed) issues.push(issueOf('SCENE_ENTRY_INCOMPLETE', '事件缺少 actor/目标地点/楼层，无法确认进入。'));
      continue;
    }
    // 1) 只认已确认事件：模型提议、界面动作、用户意图都不进来。
    if (event.confirmed !== true) {
      issues.push(issueOf('SCENE_ENTRY_NOT_CONFIRMED', `${actorId} 的进入来自未确认来源，不触发建设。`));
      continue;
    }
    // 2) 楼层必须已保存：正文 N 的进入不能在本轮就要求内部布局。
    if (!saved.has(turnId)) {
      issues.push(issueOf('SCENE_ENTRY_FLOOR_UNSAVED', `楼层 ${turnId} 尚未保存：进入先记账，不触发内部建设。`));
      continue;
    }
    // 3) 必须有一次合法编译后的真实位置变化。
    const change = byPosition.get(`${actorId}|${turnId}`);
    if (!change || change.compiled !== true) {
      issues.push(issueOf('SCENE_ENTRY_NO_COMPILED_MOVE', `${actorId} 在 ${turnId} 没有合法编译后的位置变化：不算实际进入。`));
      continue;
    }
    // 4) 主角从父层粗归属细化到同一房间的坐标，不重复触发。
    if (change.kind === 'precision-refined') {
      issues.push(issueOf('SCENE_ENTRY_PRECISION_ONLY', `${actorId} 只是把粗归属细化到同一地点：不重复触发。`));
      continue;
    }
    if (text(change.locationId) !== toLocationId) {
      issues.push(issueOf('SCENE_ENTRY_POSITION_MISMATCH', `事件说进入 ${toLocationId}，编译后位置是 ${change.locationId}：以编译结果为准，不触发。`));
      continue;
    }
    if (change.previousLocationId && text(change.previousLocationId) === toLocationId) {
      issues.push(issueOf('SCENE_ENTRY_NO_MOVEMENT', `${actorId} 本来就在 ${toLocationId}：不算进入。`));
      continue;
    }
    const interiorMapId = mapIdOf(change.interiorMapId ?? (event as { interiorMapId?: string }).interiorMapId);
    const dedupeKey = sceneEntryDedupeKey({ actorId, toLocationId, turnId, interiorMapId });
    if (entries.some((entry) => entry.dedupeKey === dedupeKey)) {
      issues.push(issueOf('SCENE_ENTRY_DUPLICATE', `${actorId} 在 ${turnId} 进入 ${toLocationId} 已经记过：同文重放不建第二个 job。`));
      continue;
    }
    entries.push({
      version: 1,
      dedupeKey,
      actorId,
      fromLocationId: mapIdOf(change.previousLocationId) ?? mapIdOf(event.fromLocationId),
      toLocationId,
      interiorMapId,
      source: 'narrative-entry',
      eventId: text(event.eventId) || null,
      turnId,
      confirmedAtS: Number.isFinite(event.occurredAtS) ? Number(event.occurredAtS) : 0,
      isProtagonist: protagonistId.length > 0 && actorId === protagonistId,
    });
  }

  entries.sort((left, right) => (left.dedupeKey < right.dedupeKey ? -1 : left.dedupeKey > right.dedupeKey ? 1 : 0));
  return { entries, issues };
}

export type SceneEntryActivationV1 = {
  facilityLocationId: string;
  interiorMapId: string | null;
  /** 只激活该设施与必要已知子空间，**不扩成整个城镇**。 */
  activateTargetIds: string[];
  /** 恒 false：进入一个设施不等于要求建设整片聚落。 */
  expandToSettlement: false;
};

/**
 * §16.1 最后一句：进入一张 waiting-for-entry 内图时，只激活该设施及必要已知子空间。
 */
export function sceneEntryActivation(
  entry: ConfirmedSceneEntryV1,
  targets: readonly { id: string; subjectId: string | null; workKind: string; status: string }[],
  knownSubspaceIds: readonly string[] = [],
): SceneEntryActivationV1 {
  const facility = text(entry?.toLocationId);
  const allowed = new Set<string>([facility, ...knownSubspaceIds.map((id) => text(id)).filter(Boolean)]);
  const activateTargetIds = (targets ?? [])
    .filter((target) => target?.status === 'waiting-for-entry')
    .filter((target) => allowed.has(text(target.subjectId)) || (entry?.interiorMapId ? text(target.subjectId) === text(entry.interiorMapId) : false))
    .map((target) => String(target.id))
    .sort();
  return { facilityLocationId: facility, interiorMapId: mapIdOf(entry?.interiorMapId), activateTargetIds, expandToSettlement: false };
}

/* ------------------------------------------------------------------ *
 * §16.2 时序
 * ------------------------------------------------------------------ */

export type InteriorContextReadinessV1 = {
  ready: boolean;
  /** 未就绪时的结构状态文案：只说「未就绪」，不编造家具与尺寸。 */
  note: string | null;
  interiorMapId: string | null;
};

/**
 * 正文 N 确认进入、N+1 或之后才提供内部空间：布局没保存就明说未就绪。
 * 不能回头改写 N，也不能因为队列没赶上就编一套家具。
 */
export function interiorContextReadiness(input: {
  interiorMapId?: string | null;
  /** 该内图是否有已保存布局（frame 里有场景）。 */
  layoutSaved: boolean;
  /** 进入发生的楼层与当前要生成的楼层。 */
  entryTurnId: string;
  currentTurnId: string;
}): InteriorContextReadinessV1 {
  const interiorMapId = mapIdOf(input?.interiorMapId);
  if (!interiorMapId) return { ready: false, note: null, interiorMapId: null };
  if (input?.entryTurnId && input.currentTurnId && text(input.entryTurnId) === text(input.currentTurnId)) {
    return { ready: false, note: '本轮刚刚进入：内部布局按规则从下一轮起才提供', interiorMapId };
  }
  if (input?.layoutSaved !== true) {
    return { ready: false, note: '内部布局未就绪：只给真实位置与结构状态，不编造家具或尺寸', interiorMapId };
  }
  return { ready: true, note: null, interiorMapId };
}

/* ------------------------------------------------------------------ *
 * §16.3 正文输入：当前 actor 投影
 * ------------------------------------------------------------------ */

export type SceneContextLocationChainNodeV1 = { locationId: string; name: string; kind: string };

export type SceneContextEntranceV1 = {
  geometry?: SpatialGeometryV1 | null;
  objectId: string;
  name: string;
  kind: string;
  openingState: string;
  locked: boolean | null;
  blocksMovement: boolean | null;
};

export type SceneContextBlockerV1 = {
  geometry?: SpatialGeometryV1 | null;
  objectId: string;
  name: string;
  kind: string;
  blocksMovement: boolean | null;
  blocksSight: boolean | null;
  /** 真实占地（格）；未知就是 null，不猜。 */
  footprintCells: number | null;
  footprintMeters: { widthM: number; heightM: number } | null;
};

export type SceneContextActorV1 = {
  geometry?: SpatialGeometryV1 | null;
  entityId: string;
  name: string;
  /** 只在同地点/可直接观察时给；否则只给 last-known 或「不在视野内」。 */
  presence: 'here' | 'last-known' | 'elsewhere';
  lastKnownLocationId: string | null;
};

export type ActorSceneContextV1 = {
  perceptionCandidates?: readonly import('./atlas-spatial-perception.ts').PerceptionCandidate[];
  version: 1;
  actorId: string;
  location: {
    locationId: string;
    name: string;
    chain: SceneContextLocationChainNodeV1[];
    mapId: string | null;
    units: 'meters' | 'cells' | 'unknown';
    metersPerCell: number | null;
    precision: string;
  } | null;
  self: { label: string; quality: string; geometry?: SpatialGeometryV1 | null } | null;
  entrances: SceneContextEntranceV1[];
  blockers: SceneContextBlockerV1[];
  actors: SceneContextActorV1[];
  items: Array<{ objectId: string; name: string; holderId: string | null }>;
  constraints: Array<{ code: string; message: string }>;
  diagnostics: PlanIssue[];
  capacity: { limit: number; used: number; dropped: number };
  truncated: boolean;
};

export type ActorSceneContextInput = {
  actorId: string;
  location: {
    locationId: string;
    name: string;
    kind: string;
    mapId: string | null;
    units?: 'meters' | 'cells' | 'unknown';
    metersPerCell?: number | null;
    precision?: string;
  } | null;
  ancestors?: readonly { locationId: string; name: string; kind: string }[];
  position?: { kind: string; precision?: string | null; mapId?: string; x?: number; y?: number } | null;
  /** 可观察入口（相邻/直接门/所属空间关系）。 */
  entrances?: ReadonlyArray<{ objectId: string; name: string; kind?: string; openingState?: string; locked?: boolean | null; blocksMovement?: boolean | null; geometry?: SpatialGeometryV1 | null }>;
  /** 关键家具与障碍：用 P07 的单一事实表，不在这里另判一次挡不挡路。 */
  obstacles?: readonly {
    objectId: string; name: string; kind?: string; material?: string; openingState?: string;
    locked?: boolean | null; footprintCells?: number | null; footprintMeters?: { widthM: number; heightM: number } | null;
    geometry?: SpatialGeometryV1 | null;
  }[];
  actors?: readonly SceneContextActorV1[];
  items?: readonly { objectId: string; name: string; holderId: string | null }[];
  /** 已识别的仍相关空间约束。 */
  constraints?: readonly { code: string; message: string }[];
  /** 上下文字符预算；默认 1800（既有上限）。 */
  charLimit?: number;
  /** 内部布局是否已就绪；未就绪只给结构状态。 */
  interior?: InteriorContextReadinessV1 | null;
};

const ENTRANCE_KINDS = new Set(['door', 'window', 'glass', 'other']);
const DEFAULT_CHAR_LIMIT = 1800;

function positionLabel(position: ActorSceneContextInput['position']): ActorSceneContextV1['self'] {
  if (!position) return null;
  const kind = text(position.kind) || 'unknown';
  if (kind === 'unknown') return { label: '位置未知', quality: 'unknown' };
  if (kind === 'in_transit') return { label: '在途（未落地）', quality: 'approximate' };
  if (kind === 'at_location') return { label: '在地点内', quality: 'coarse' };
  const precision = text(position.precision) || 'unknown';
  const geometry: SpatialGeometryV1 | null = position.mapId && typeof position.x === 'number' && Number.isFinite(position.x) && typeof position.y === 'number' && Number.isFinite(position.y)
    ? { mapId: position.mapId, units: 'cells', x: position.x, y: position.y, width: null, height: null, rotation: null } : null;
  return { label: precision === 'exact' ? '图中精确位置' : '图中约略位置', quality: precision, ...(geometry ? { geometry } : {}) };
}

/**
 * 组装正文用的 actor 投影。
 *
 * 容量策略是**原子保留**：先放「自身 + 地点链 + 入口 + 障碍」，再放人物与物品；
 * 超预算时先丢人物/物品（并报 `SCENE_CONTEXT_TRUNCATED`），
 * 绝不把某个障碍的占地截掉 —— 那会让人以为「没写＝不挡路」。
 */
export function buildActorSceneContext(input: ActorSceneContextInput): ActorSceneContextV1 {
  const diagnostics: PlanIssue[] = [];
  const limit = Math.max(200, Math.floor(Number.isFinite(input?.charLimit) ? Number(input.charLimit) : DEFAULT_CHAR_LIMIT));
  const actorId = text(input?.actorId);
  if (!actorId) {
    diagnostics.push({ code: 'SCENE_CONTEXT_ACTOR_MISSING', path: '$.actorId', message: '没有 actor 就没有当前投影：本轮不注入空间上下文。', severity: 'error', retryable: false });
  }

  const location = input?.location
    ? {
      locationId: text(input.location.locationId),
      name: text(input.location.name),
      chain: (input.ancestors ?? []).map((node) => ({ locationId: text(node.locationId), name: text(node.name), kind: text(node.kind) })),
      mapId: mapIdOf(input.location.mapId),
      units: (input.location.units ?? 'unknown') as 'meters' | 'cells' | 'unknown',
      metersPerCell: typeof input.location.metersPerCell === 'number' && Number.isFinite(input.location.metersPerCell) && input.location.metersPerCell > 0 ? input.location.metersPerCell : null,
      precision: text(input.location.precision) || 'unknown',
    }
    : null;
  if (!location && actorId) {
    diagnostics.push({ code: 'SCENE_CONTEXT_LOCATION_MISSING', path: '$.location', message: '当前没有可注入的地点：只给位置状态，不编造场景。', severity: 'warning', retryable: false });
  }

  const entrances: SceneContextEntranceV1[] = (input.entrances ?? []).map((entry) => {
    const kind = text(entry.kind) || 'other';
    const openingState = text(entry.openingState) || 'unknown';
    return {
      objectId: text(entry.objectId),
      name: text(entry.name),
      kind: ENTRANCE_KINDS.has(kind) ? kind : 'other',
      openingState,
      locked: entry.locked === true ? true : entry.locked === false ? false : null,
      blocksMovement: resolveSpatialTrait({ objectId: entry.objectId, kind, openingState, locked: entry.locked }).blocksMovement,
      ...(entry.geometry ? { geometry: entry.geometry } : {}),
    };
  }).filter((entry) => entry.objectId.length > 0);

  const blockers: SceneContextBlockerV1[] = (input.obstacles ?? []).map((raw) => {
    const meters = raw.footprintMeters && Number.isFinite(raw.footprintMeters.widthM) && Number.isFinite(raw.footprintMeters.heightM)
      ? { widthM: Number(raw.footprintMeters.widthM), heightM: Number(raw.footprintMeters.heightM) }
      : null;
    /**
     * 先算格数再判属性：米制占地必须先换算成格，否则「3×1 米的书架」会因为没有 footprint
     * 被判成「高度未知」，正文就说不清它挡不挡视线。
     */
    const cellsFromMeters = meters && location?.metersPerCell
      ? Math.max(1, Math.round((meters.widthM * meters.heightM) / (location.metersPerCell * location.metersPerCell)))
      : null;
    const trait: SpatialTraitV1 = resolveSpatialTrait({
      objectId: raw.objectId, kind: raw.kind, material: raw.material,
      openingState: raw.openingState, locked: raw.locked,
      footprintCells: raw.footprintCells ?? cellsFromMeters,
    });
    return {
      objectId: trait.objectId,
      name: text(raw.name) || trait.objectId,
      kind: trait.kind,
      blocksMovement: trait.blocksMovement,
      blocksSight: trait.blocksSight,
      footprintCells: trait.footprintCells ?? cellsFromMeters,
      footprintMeters: meters,
      ...(raw.geometry ? { geometry: raw.geometry } : {}),
    };
  }).filter((entry) => entry.objectId.length > 0);
  blockers.sort((left, right) => (left.objectId < right.objectId ? -1 : left.objectId > right.objectId ? 1 : 0));

  const constraints = [...(input.constraints ?? [])].map((constraint) => ({ code: text(constraint.code), message: text(constraint.message) }));
  // 未知阻隔不放行：这是本投影最重要的一条约束。
  if (blockers.some((blocker) => blocker.blocksMovement === null && ENTRANCE_KINDS.has(blocker.kind))) {
    constraints.push({ code: 'UNKNOWN_OBSTRUCTION', message: '有入口的通行状态未知：不得假设可以穿过。' });
  }
  if (input?.interior && input.interior.ready !== true && input.interior.note) {
    constraints.push({ code: 'INTERIOR_LAYOUT_NOT_READY', message: input.interior.note });
  }

  const actors = [...(input.actors ?? [])];
  const items = [...(input.items ?? [])];
  const fixedSize = JSON.stringify({ actorId, location, self: positionLabel(input.position), entrances, blockers, constraints }).length;
  let used = fixedSize;
  let dropped = 0;
  const keptActors: SceneContextActorV1[] = [];
  for (const actor of actors) {
    const size = JSON.stringify(actor).length;
    if (used + size > limit) { dropped += 1; continue; }
    used += size;
    keptActors.push(actor);
  }
  const keptItems: Array<{ objectId: string; name: string; holderId: string | null }> = [];
  for (const item of items) {
    const size = JSON.stringify(item).length;
    if (used + size > limit) { dropped += 1; continue; }
    used += size;
    keptItems.push(item);
  }
  const truncated = dropped > 0;
  if (truncated) {
    diagnostics.push({
      code: 'SCENE_CONTEXT_TRUNCATED', path: '$.actors', severity: 'warning', retryable: false,
      message: `上下文超出 ${limit} 字：已按原子粒度丢弃 ${dropped} 个可选条目（人物/物品），frame、自身与障碍完整保留。`,
    });
  }

  return {
    version: 1,
    actorId,
    location,
    self: positionLabel(input.position),
    entrances,
    blockers,
    actors: keptActors,
    items: keptItems,
    constraints,
    diagnostics,
    capacity: { limit, used, dropped },
    truncated,
  };
}

/** 把投影压成给正文的几行；不出现米数以外的技术口径。 */
export function renderActorSceneContextLines(context: ActorSceneContextV1): string[] {
  const lines: string[] = [];
  if (context.location) {
    const chain = context.location.chain.map((node) => node.name).filter(Boolean).join(' › ');
    lines.push(`所在地点：${chain || context.location.name}`);
    if (context.location.metersPerCell !== null) {
      lines.push(`空间尺度：约每格 ${context.location.metersPerCell} 米（${context.location.precision}）`);
    }
  }
  const geometryLabel = (geometry: SpatialGeometryV1 | null | undefined): string => geometry
    ? `；坐标 (${geometry.x}, ${geometry.y}) ${geometry.units === 'meters' ? '米' : '格'}，frame=${geometry.mapId}${geometry.width !== null && geometry.height !== null ? `，占地 ${geometry.width}×${geometry.height}` : ''}${geometry.rotation !== null ? `，朝向 ${geometry.rotation}` : ''}` : '';
  if (context.self) lines.push(`自身位置：${context.self.label}${geometryLabel(context.self.geometry)}`);
  if (context.entrances.length) {
    lines.push(`可观察入口：${context.entrances.map((entry) => `${entry.name}（${entry.openingState}${entry.locked === true ? '，上锁' : ''}）[ref=${entry.objectId}${geometryLabel(entry.geometry)}]`).join('、')}`);
  }
  if (context.blockers.length) {
    lines.push(`关键陈设与障碍：${context.blockers.map((blocker) => {
      const footprint = blocker.footprintMeters
        ? `${blocker.footprintMeters.widthM}×${blocker.footprintMeters.heightM} 米`
        : blocker.footprintCells !== null ? `约 ${blocker.footprintCells} 格` : '占地未知';
      const pass = blocker.blocksMovement === true ? '挡路' : blocker.blocksMovement === false ? '不挡路' : '通行未知';
      const sight = blocker.blocksSight === true ? '挡视线' : blocker.blocksSight === false ? '不挡视线' : '视线影响未知';
      return `${blocker.name}（${footprint}，${pass}）[${sight}${geometryLabel(blocker.geometry)}；ref=${blocker.objectId}]`;
    }).join('、')}`);
  }
  if (context.actors.length) {
    lines.push(`可见人物：${context.actors.map((actor) => `${actor.name}${actor.presence === 'here' ? '' : actor.presence === 'last-known' ? '（上次见于此）' : '（不在视野内）'}${geometryLabel(actor.geometry)}`).join('、')}`);
  }
  for (const constraint of context.constraints) lines.push(`空间约束：${constraint.message}`);
  return lines;
}
