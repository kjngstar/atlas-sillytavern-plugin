/**
 * atlas-spatial-candidate.ts — M3/W01 + W02 + W05：候选事务内的布局请求处理。
 *
 * 纪律（改这个文件前先读一遍）：
 * 1. **只在宿主已有的候选事务内执行**：`ports.insideCandidateTransaction` 必须是宿主签发的票据；
 *    本模块绝不 COMMIT、绝不保存聊天、绝不发起模型或网络请求。
 * 2. **生成器是同步纯函数**：不持有事务等待任何 await。读到的都是最终 SQL 位置。
 * 3. **一张图一个 savepoint**：applySceneGroup 内部包了 `atlas_spatial_component` savepoint，
 *    失败整组恢复（延迟外键失败也会退回），旧 scene 与地点坐标都不变。不要绕过它。
 * 4. **预算**：默认 maxJobs=2，超出预算的图保持 pending 并回报，不偷偷多跑。
 * 5. **失败也落库**：标 failed 的请求用一条普通 maps 变更 + journal 记录完整 Issue 列表，
 *    这样重开界面不会自动重试同一请求。
 */

import type { GroupResult, Issue, RowMutation } from './atlas-ops-contract.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import { AtlasDbError, queryBound } from './atlas-db-runtime.ts';
import { decodeRow } from './atlas-db-codec.ts';
import type { ApplyGroupsContext, ApplyGroupsResult } from './atlas-db-commit.ts';
import { reconcileOccupantsSpec, placeLooseItems } from './atlas-spatial-occupants.ts';
import { applySceneGroup, buildSceneMutation, compileSceneGroup } from '../vendor/atlas-spatial/index.mjs';
import {
  SPATIAL_REQUEST_KEY,
  ensureInitialSpatialFrame,
  readSpatialFrame,
  spatialIssue,
  type SpatialScope,
} from './atlas-spatial-frame.ts';

type SqlRow = Record<string, unknown>;

export type SpatialPorts = {
  /** 宿主现有的 applyGroups（真实事务/日志/校验）。 */
  applyGroups: (db: SqlDatabase, groups: unknown[], ctx: ApplyGroupsContext) => ApplyGroupsResult;
  queryBound?: typeof queryBound;
  decodeRow?: typeof decodeRow;
  isCurrent: () => boolean;
  branchId: string;
  turnId: string;
  attemptId?: string;
};

export type ApplyPendingInput = {
  db: SqlDatabase;
  scope: SpatialScope;
  isCurrent?: () => boolean;
  turnId: string;
  clockS?: number;
  maxJobs?: number;
  ports: SpatialPorts;
};

export type ApplyPendingResult = {
  groups: GroupResult[];
  issues: Issue[];
  /** 已处理（成功/重复）的 requestId。 */
  processed: string[];
  /** 仍然待处理的 requestId（超出本轮预算或未被选中）。 */
  pending: string[];
};

const DEFAULT_MAX_JOBS = 2;

function plain(value: unknown): value is SqlRow {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readTable(db: SqlDatabase, table: 'maps' | 'locations' | 'characters' | 'items', branchId: string, ports: SpatialPorts): SqlRow[] {
  const run = ports.queryBound ?? queryBound;
  const decode = ports.decodeRow ?? decodeRow;
  const out: SqlRow[] = [];
  for (const raw of run(db, `SELECT * FROM ${table} WHERE branch_id = ?`, [branchId])) {
    const decoded = decode(table, raw as SqlRow, { allowExtra: true });
    if (decoded.ok) out.push(decoded.row as SqlRow);
  }
  return out;
}

function readMapRow(db: SqlDatabase, mapId: string, branchId: string, ports: SpatialPorts): SqlRow | null {
  const run = ports.queryBound ?? queryBound;
  const decode = ports.decodeRow ?? decodeRow;
  const rows = run(db, 'SELECT * FROM maps WHERE branch_id = ? AND id = ?', [branchId, mapId]);
  if (rows.length === 0) return null;
  const decoded = decode('maps', rows[0] as SqlRow, { allowExtra: true });
  return decoded.ok ? (decoded.row as SqlRow) : null;
}

type PendingRequest = {
  mapId: string;
  requestId: string;
  operationId: string;
  kind: 'floor' | 'city';
  request: SqlRow;
};

/** 候选事务内同步挑出 pending 请求，按 requestId 稳定排序（同 Id 再按 mapId）。 */
export function collectPendingRequests(
  db: SqlDatabase,
  scope: SpatialScope,
  ports: SpatialPorts,
): { pending: PendingRequest[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const found: PendingRequest[] = [];
  for (const mapRow of readTable(db, 'maps', scope.branchId, ports)) {
    const mapId = typeof mapRow.id === 'string' ? mapRow.id : '';
    if (mapId === '' || String(mapRow.status ?? 'active') !== 'active') continue;
    const read = readSpatialFrame(mapRow.frame_json, { branchId: scope.branchId, mapId }, { mapId, branchId: scope.branchId });
    const request = read.request;
    if (!request) continue;
    const status = typeof request.status === 'string' ? request.status : 'pending';
    if (status !== 'pending') continue;
    const kind = request.kind === 'floor' || request.kind === 'city' ? request.kind : null;
    if (kind === null) {
      issues.push(
        spatialIssue({ code: 'LAYOUT_KIND_UNSUPPORTED', path: '$.frame_json.atlasLayoutRequest.kind', message: '待处理布局请求缺少 floor/city 种类，跳过本图。', severity: 'warning' }, { mapId }),
      );
      continue;
    }
    if (!plain(request.spec)) {
      issues.push(
        spatialIssue({ code: 'LAYOUT_SPEC_INVALID', path: '$.frame_json.atlasLayoutRequest.spec', message: '待处理布局请求缺少约束对象，跳过本图。', severity: 'warning' }, { mapId }),
      );
      continue;
    }
    const requestId = typeof request.requestId === 'string' && request.requestId ? request.requestId : `req_${mapId}`;
    const operationId = typeof request.operationId === 'string' && request.operationId ? request.operationId : requestId;
    found.push({ mapId, requestId, operationId, kind, request });
  }
  found.sort((a, b) => (a.requestId === b.requestId ? (a.mapId < b.mapId ? -1 : a.mapId > b.mapId ? 1 : 0) : a.requestId < b.requestId ? -1 : 1));
  return { pending: found, issues };
}

/* ───────────────────────── W02：失败请求标记 ───────────────────────── */

export type RecordFailedInput = {
  db: SqlDatabase;
  mapRow: SqlRow;
  mapId: string;
  request: SqlRow;
  issues: Issue[];
  turnId: string;
  operationId: string;
  ports: SpatialPorts;
};

export type RecordFailedResult = { group: GroupResult | null; issues: Issue[]; changedRows: number };

/**
 * W02 recordFailedSpatialRequest：把请求标成 failed 并保存完整 Issue 列表。
 *
 * 只改 frame.atlasLayoutRequest（status + issues），**保留 atlasScene 与地点坐标**；
 * 走普通 maps 变更 + journal，所以能在 turn_changes 里查到每个字段错误。
 * 若连「标记失败」这一步都写不进去，说明存档一致性有问题 → 抛明确核心错误，不静默继续。
 */
export function recordFailedSpatialRequest(input: RecordFailedInput): RecordFailedResult {
  const { db, mapRow, mapId, request, issues, turnId, operationId, ports } = input;
  const frame = readSpatialFrame(mapRow.frame_json, { branchId: ports.branchId, mapId }, { mapId }).frame;
  frame[SPATIAL_REQUEST_KEY] = {
    ...request,
    status: 'failed',
    failedAtTurnId: turnId,
    issues: issues.map((item) => ({ code: item.code, path: item.path, message: item.message, severity: item.severity, retryable: item.retryable })),
  };
  const after: SqlRow = {
    ...mapRow,
    frame_json: frame,
    row_rev: Number(mapRow.row_rev ?? 1) + 1,
    updated_turn_id: turnId,
  };
  const mutation: RowMutation = {
    table: 'maps',
    rowId: mapId,
    before: { ...mapRow },
    after,
    sourceOpIds: [operationId],
    basis: { kind: 'layout-failed', mapId, operationId, failedIssues: issues.map((i) => i.code) },
  };
  const group = {
    id: `layout-failed:${operationId}`,
    opIds: [operationId],
    dependsOn: [],
    readSet: [{ table: 'maps', rowId: mapId, rowRev: Number(mapRow.row_rev ?? 1) }],
    mutations: [mutation],
  };
  const applied = ports.applyGroups(db, [group], {
    branchId: ports.branchId,
    turnId,
    attemptId: ports.attemptId ?? 'spatial',
    validate: true,
    journal: true,
  });
  const first = applied.groups[0] ?? null;
  if (
    applied.journalIssues.length > 0 ||
    !first ||
    first.status === 'rejected' ||
    first.status === 'blocked'
  ) {
    throw new AtlasDbError(
      'SPATIAL_FAILURE_RECORD_FAILED',
      `无法把失败的布局请求写回地图 ${mapId}：存档一致性无法保证，本轮不提交`,
      { mapId, operationId, journal: applied.journalIssues, status: first?.status ?? 'none' },
    );
  }
  return { group: first, issues: [], changedRows: first.changedRows };
}

/* ───────────────────────── W05：地面物品的视觉锚点 ───────────────────────── */

type LoosePassInput = {
  db: SqlDatabase;
  mapId: string;
  markers: Array<{ id: string; roomId: string; name: string; type: 'item' }>;
  scope: SpatialScope;
  isCurrent: () => boolean;
  turnId: string;
  operationId: string;
  ports: SpatialPorts;
  groups: GroupResult[];
  issues: Issue[];
};

function rectOf(row: unknown): { x: number; y: number; w: number; h: number } | null {
  if (!plain(row)) return null;
  const x = Number(row.x);
  const y = Number(row.y);
  const w = Number(row.w);
  const h = Number(row.h);
  if (![x, y, w, h].every((v) => Number.isFinite(v)) || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/**
 * 没有支撑家具组的地面物品：在房间可通行区里补视觉点。
 *
 * 只改 `scene.layout.items`，**不写 characters/items 的 SQL 归属**，也不凭空造一张桌子。
 * 这一步走自己的 savepoint：失败时整组恢复，已应用的场景不受影响。
 */
function applyLooseItemMarkers(input: LoosePassInput): void {
  const { db, mapId, markers, scope, isCurrent, turnId, operationId, ports } = input;
  if (markers.length === 0) return;
  if (!isCurrent()) return;
  const mapRow = readMapRow(db, mapId, scope.branchId, ports);
  if (!mapRow) return;
  const read = readSpatialFrame(mapRow.frame_json, { branchId: scope.branchId, mapId }, { mapId });
  const scene = read.scene as unknown as SqlRow | null;
  const layout = (scene?.layout ?? null) as SqlRow | null;
  if (!scene || layout?.kind !== 'floor') return;

  const regions = new Map<string, Array<{ x: number; y: number }>>();
  for (const room of Array.isArray(layout.rooms) ? (layout.rooms as SqlRow[]) : []) {
    const id = typeof room?.id === 'string' ? room.id : '';
    const rect = rectOf(room);
    if (!id || !rect) continue;
    const { x, y, w, h } = rect;
    regions.set(id, [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]);
  }

  const constraints = plain(scene.constraints) ? (scene.constraints as SqlRow) : {};
  const roomOfGroup = new Map<string, string>();
  for (const entry of Array.isArray(constraints.contents) ? (constraints.contents as SqlRow[]) : []) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    const roomId = typeof entry?.roomId === 'string' ? entry.roomId : '';
    if (id && roomId) roomOfGroup.set(id, roomId);
  }
  const obstacles = new Map<string, Array<{ x: number; y: number; w: number; h: number }>>();
  for (const group of Array.isArray(layout.groups) ? (layout.groups as SqlRow[]) : []) {
    const id = typeof group?.id === 'string' ? group.id : '';
    const roomId = roomOfGroup.get(id);
    const rect = rectOf(group);
    if (!roomId || !rect) continue;
    const list = obstacles.get(roomId) ?? [];
    list.push(rect);
    obstacles.set(roomId, list);
  }

  const placed = placeLooseItems({ scene: scene as never, markers, regions, obstacles });
  input.issues.push(...placed.issues);
  if (placed.points.length === 0) return;

  const placedIds = new Set(placed.points.map((p) => p.id));
  const keptItems = (Array.isArray(layout.items) ? (layout.items as SqlRow[]) : []).filter((p) => !placedIds.has(String(p?.id)));
  const nextScene = {
    ...(scene as SqlRow),
    layout: {
      ...layout,
      items: [...keptItems, ...placed.points.map((p) => ({ id: p.id, x: p.x, y: p.y, quality: p.quality, name: p.name }))],
    },
  };
  const rebuilt = buildSceneMutation({
    result: { ok: true, status: 'reused', scene: nextScene as never, issues: [], guard: { scope, mapId, inputSignature: typeof scene.inputSignature === 'string' ? scene.inputSignature : '' } },
    mapRow,
    scope,
    currentScope: { ...scope, viewMode: 'author' },
    turnId,
    operationId: `${operationId}:items`,
    expectedRowRev: Number(mapRow.row_rev ?? 1),
  }) as { ok: boolean; status: string; mutation: RowMutation | null; issues: Array<Record<string, unknown>> };
  if (!rebuilt.ok || !rebuilt.mutation) {
    for (const item of rebuilt.issues ?? []) {
      input.issues.push(spatialIssue(item as never, { mapId, branchId: scope.branchId, operationId, turnId }));
    }
    return;
  }
  const group = {
    id: `layout-items:${operationId}`,
    opIds: [`${operationId}:items`],
    dependsOn: [],
    readSet: [{ table: 'maps', rowId: mapId, rowRev: Number(mapRow.row_rev ?? 1) }],
    mutations: [rebuilt.mutation],
  };
  const applied = applySceneGroup(db, group, {
    insideCandidateTransaction: true,
    applyGroups: ports.applyGroups,
    queryBound: ports.queryBound ?? queryBound,
    isCurrent,
    branchId: scope.branchId,
    turnId,
    attemptId: ports.attemptId ?? 'spatial',
  }) as { ok: boolean; groups?: GroupResult[]; issues?: Array<Record<string, unknown>> };
  if (applied.ok) {
    input.groups.push(...(applied.groups ?? []));
    return;
  }
  for (const item of applied.issues ?? []) {
    input.issues.push(spatialIssue(item as never, { mapId, branchId: scope.branchId, operationId, turnId }));
  }
}

/* ───────────────────────── W08：显式重试的重新武装 ───────────────────────── */

export type ArmRetryInput = {
  db: SqlDatabase;
  branchId: string;
  mapId: string;
  /** 宿主分配的新 ticket / opID；不复用旧 ID，避免与已失败的操作混淆。 */
  requestId: string;
  operationId: string;
  turnId: string;
  ports: SpatialPorts;
};

/**
 * W08 armLayoutRetry：把一条 failed 请求重新武装成 pending，交给同轮的 W01 处理。
 *
 * 只改 frame 里的请求状态与 ID，**不动场景、不动地点坐标**；没有失败请求时是 noop。
 * 这只是一次普通 maps 变更 + journal，不重放事件、不推进时间。
 */
export function armLayoutRetry(input: ArmRetryInput): { groups: GroupResult[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const mapRow = readMapRow(input.db, input.mapId, input.branchId, input.ports);
  if (!mapRow) {
    issues.push(spatialIssue({ code: 'MAP_ROW_MISSING', path: '$.maps', message: '找不到该地图行，重试未执行。', severity: 'warning' }, { mapId: input.mapId }));
    return { groups: [], issues };
  }
  const read = readSpatialFrame(mapRow.frame_json, { branchId: input.branchId, mapId: input.mapId }, { mapId: input.mapId });
  const request = read.request;
  if (!request || String(request.status ?? '') !== 'failed') {
    issues.push(
      spatialIssue({ code: 'LAYOUT_RETRY_NOOP', path: '$.frame_json.atlasLayoutRequest', message: '该地图没有失败的布局请求，重试未执行。', severity: 'warning' }, { mapId: input.mapId }),
    );
    return { groups: [], issues };
  }
  const frame = read.frame;
  frame[SPATIAL_REQUEST_KEY] = {
    ...request,
    status: 'pending',
    requestId: input.requestId,
    operationId: input.operationId,
    createdTurnId: input.turnId,
    failedAtTurnId: undefined,
    issues: undefined,
  };
  // 注意：这里必须用独立的 opID（…:arm）。请求自己带的 operationId 马上会被场景写入使用，
  // 同 turn 同表同行的重复 opID 会被幂等记账判成 duplicate，把场景那一条整组吞掉。
  const armOpId = `${input.operationId}:arm`;
  const after: SqlRow = { ...mapRow, frame_json: frame, row_rev: Number(mapRow.row_rev ?? 1) + 1, updated_turn_id: input.turnId };
  const mutation: RowMutation = {
    table: 'maps',
    rowId: input.mapId,
    before: { ...mapRow },
    after,
    sourceOpIds: [armOpId],
    basis: { kind: 'layout-retry', mapId: input.mapId, previousRequestId: String(request.requestId ?? '') },
  };
  const group = {
    id: `layout-retry:${input.operationId}`,
    opIds: [armOpId],
    dependsOn: [],
    readSet: [{ table: 'maps', rowId: input.mapId, rowRev: Number(mapRow.row_rev ?? 1) }],
    mutations: [mutation],
  };
  const applied = input.ports.applyGroups(input.db, [group], {
    branchId: input.branchId,
    turnId: input.turnId,
    attemptId: input.ports.attemptId ?? 'spatial',
    validate: true,
    journal: true,
  });
  const first = applied.groups[0] ?? null;
  if (applied.journalIssues.length > 0 || !first || first.status === 'rejected' || first.status === 'blocked') {
    throw new AtlasDbError('SPATIAL_RETRY_ARM_FAILED', `无法重新武装地图 ${input.mapId} 的布局请求`, {
      mapId: input.mapId,
      operationId: input.operationId,
      journal: applied.journalIssues,
      status: first?.status ?? 'none',
    });
  }
  return { groups: [first], issues };
}

/* ───────────── M2-12：仅清理已移走的局部锚点 ───────────── */

/**
 * 旧场景会留着「上一轮还在地图上、这一轮已经搬到别处」的成员锚点。编译器的合并逻辑
 * 只判断「实体是否还在本分支引用表」，管不到「实体还在、但已经不属于这张图」这一类；
 * 这里补上这个洞：按本图**实际成员**算出失效 ID，喂进请求的 `deletes`，让剪除随这次
 * 编译的 maps 变更一起落库、一起被 journal 记录、一起受候选 scope guard 保护（不另开写）。
 *
 * 三条纪律：
 * 1. 只在候选事务内、编译前计算；本模块自己不写库（写入仍走 applySceneGroup 的 savepoint）。
 * 2. 只有「确实是已知实体，但既不按 parent 归属本图、也不带本图 map_id」的成员才剪；
 *    静态背景/程序生成装饰（id 根本不在实体表里）一律保留。
 * 3. 家具组（contents）自身不是实体，按 roomId 悬空剪除；routes 不是可合并约束键，每次编译重算。
 */

/** 场景里由实体支撑的约束集合 → 实体种类。 */
const SCENE_MEMBER_KIND = Object.freeze({
  rooms: 'locations',
  districts: 'locations',
  buildings: 'locations',
  actors: 'characters',
  items: 'items',
} as const);

type MemberKind = 'locations' | 'characters' | 'items';

function idsOf(rows: SqlRow[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows) if (typeof row.id === 'string' && row.id) out.add(row.id);
  return out;
}

function containerKey(value: unknown, locationIds: Set<string>): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value);
  if (!raw) return null;
  // 与 M2-09 同一套判定：地点 ID 本身可能就叫 `loc:1`，不能无脑剥前缀。
  if (locationIds.has(raw)) return raw;
  if (raw.startsWith('loc:') && locationIds.has(raw.slice(4))) return raw.slice(4);
  return raw;
}

export type SceneMemberIds = {
  mapId: string;
  /** 本图**实际**成员：按 parent 归属本图、或带本图 map_id 的地点；角色/物品同理。 */
  members: Record<MemberKind, Set<string>>;
  /** 本分支全部已知实体（用于把「程序装饰」和「搬走的实体」区分开）。 */
  known: Record<MemberKind, Set<string>>;
};

/**
 * collectSceneMemberIds：算出「谁真的在这张图上」以及「本分支都有哪些实体」。
 *
 * 地点归属以 **parent 链** 为准（与 M2-09/M2-10 一致：导航按已纠正的 parent），
 * 同时把 `map_id === 本图` 也算作归属——两个信号任一成立就保留，宁可少剪不误剪。
 * 角色/物品先看自己的 map_id，再看它所在房间是否归属本图（location_id 反查）。
 */
export function collectSceneMemberIds(input: {
  mapId: string;
  maps: SqlRow[];
  locations: SqlRow[];
  characters: SqlRow[];
  items: SqlRow[];
}): SceneMemberIds {
  const { mapId, maps, locations, characters, items } = input;
  const locationIds = new Set(locations.map((row) => String(row.id)));
  const mapIdByContainer = new Map<string, string>();
  let rootMapId: string | null = null;
  for (const map of maps) {
    if (String(map.status ?? 'active') !== 'active') continue;
    const id = String(map.id);
    const key = containerKey(map.container_location_id, locationIds);
    if (key === null) {
      // 容器为空 = 根图。多张根图时取 id 最小的一张，保证可复现。
      if (rootMapId === null || id < rootMapId) rootMapId = id;
      continue;
    }
    const held = mapIdByContainer.get(key);
    if (held === undefined || id < held) mapIdByContainer.set(key, id);
  }

  const memberLocations = new Set<string>();
  for (const location of locations) {
    if (String(location.status ?? 'active') !== 'active') continue;
    const id = String(location.id);
    if (String(location.map_id ?? '') === mapId) {
      memberLocations.add(id);
      continue;
    }
    const parentKey = containerKey(location.parent_location_id, locationIds);
    const owner = parentKey === null ? rootMapId : mapIdByContainer.get(parentKey) ?? null;
    if (owner === mapId) memberLocations.add(id);
  }

  const memberCharacters = new Set<string>();
  for (const character of characters) {
    if (String(character.status ?? 'active') !== 'active') continue;
    const id = String(character.id);
    if (String(character.map_id ?? '') === mapId || memberLocations.has(String(character.location_id ?? ''))) {
      memberCharacters.add(id);
    }
  }

  const memberItems = new Set<string>();
  for (const item of items) {
    if (String(item.status ?? 'active') !== 'active') continue;
    const id = String(item.id);
    if (String(item.map_id ?? '') === mapId || memberLocations.has(String(item.location_id ?? ''))) {
      memberItems.add(id);
    }
  }

  return {
    mapId,
    members: { locations: memberLocations, characters: memberCharacters, items: memberItems },
    known: { locations: idsOf(locations), characters: idsOf(characters), items: idsOf(items) },
  };
}

export type PruneSceneResult = {
  /** 可直接并进请求 spec.deletes 的失效 ID；空对象表示本图没有要剪的东西。 */
  deletes: Record<string, string[]>;
  /** 被剪掉的全部 ID（含家具组），按集合名排序，便于诊断与测试断言。 */
  pruned: string[];
  issues: Issue[];
};

/**
 * pruneInvalidSceneMembers：拿旧场景 + 本图实际成员，算出「该剪掉哪些锚点」。
 *
 * 只读；不写库、不改入参。没有任何失效成员时返回空 deletes（调用方据此保持零写入）。
 */
export function pruneInvalidSceneMembers(input: {
  scene: unknown;
  mapId: string;
  memberIds: SceneMemberIds;
}): PruneSceneResult {
  const { scene, mapId, memberIds } = input;
  const deletes: Record<string, string[]> = {};
  const pruned: string[] = [];
  const issues: Issue[] = [];
  const constraints = plain(scene) && plain((scene as SqlRow).constraints) ? ((scene as SqlRow).constraints as SqlRow) : null;
  if (!constraints) return { deletes, pruned, issues };

  const bump = (key: string, id: string): void => {
    const list = deletes[key] ?? [];
    list.push(id);
    deletes[key] = list;
    pruned.push(id);
  };

  for (const [key, kind] of Object.entries(SCENE_MEMBER_KIND) as Array<[string, MemberKind]>) {
    const entries = constraints[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const id = plain(entry) && typeof (entry as SqlRow).id === 'string' ? String((entry as SqlRow).id) : '';
      // 不在实体表里的 id 是程序装饰/静态背景：保留，绝不误剪。
      if (!id || !memberIds.known[kind].has(id)) continue;
      if (memberIds.members[kind].has(id)) continue;
      bump(key, id);
    }
  }

  // 家具组自身不是实体：房间被剪掉后，挂在它下面的组会变成悬空引用，一并剪除。
  const prunedRooms = new Set(deletes.rooms ?? []);
  if (prunedRooms.size > 0 && Array.isArray(constraints.contents)) {
    for (const entry of constraints.contents as unknown[]) {
      if (!plain(entry)) continue;
      const roomId = typeof (entry as SqlRow).roomId === 'string' ? String((entry as SqlRow).roomId) : '';
      const id = typeof (entry as SqlRow).id === 'string' ? String((entry as SqlRow).id) : '';
      if (!id || !roomId || !prunedRooms.has(roomId)) continue;
      bump('contents', id);
    }
  }

  if (pruned.length > 0) {
    const detail = Object.entries(deletes)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([key, list]) => `${key}:${[...list].sort().join(',')}`)
      .join(' / ');
    issues.push(
      spatialIssue(
        {
          code: 'SCENE_STALE_MEMBER_PRUNED',
          path: '$.frame_json.atlasScene.constraints',
          message: `地图 ${mapId} 的旧场景里 ${pruned.length} 个锚点已不属于本图（${detail}）：本次只剪这些失效锚点，其余旧几何与静态背景原样保留`,
          severity: 'warning',
          retryable: false,
        },
        { mapId },
      ),
    );
  }

  return { deletes, pruned, issues };
}

/* ───────────────────────── W01：处理 pending ───────────────────────── */

/**
 * W01 applyPendingSpatialRequests：在宿主候选事务内处理至多 maxJobs 张图的布局请求。
 *
 * 返回 groups（追加到回执）、issues（追加到 allIssues）、processed 与仍 pending 的 requestId。
 * 没有任何请求时不产生任何写入。
 */
export function applyPendingSpatialRequests(input: ApplyPendingInput): ApplyPendingResult {
  const groups: GroupResult[] = [];
  const issues: Issue[] = [];
  const processed: string[] = [];
  const pending: string[] = [];
  const ports = input.ports;
  const maxJobs = Number.isInteger(input.maxJobs) && (input.maxJobs as number) > 0 ? (input.maxJobs as number) : DEFAULT_MAX_JOBS;
  const turnId = input.turnId;
  const scope = input.scope;
  const isCurrent = input.isCurrent ?? ports?.isCurrent;

  if (!ports || typeof ports.applyGroups !== 'function') {
    issues.push({ code: 'COMMIT_PORT_REQUIRED', path: '$.ports', message: '缺少宿主应用接口，本轮不处理布局请求。', severity: 'error', retryable: false });
    return { groups, issues, processed, pending };
  }
  if (typeof isCurrent !== 'function') {
    issues.push({ code: 'COMMIT_PORT_REQUIRED', path: '$.ports.isCurrent', message: '缺少宿主身份守卫，本轮不处理布局请求。', severity: 'error', retryable: false });
    return { groups, issues, processed, pending };
  }
  if (!isCurrent()) {
    issues.push({ code: 'STALE_SCOPE', path: '$.scope', message: '世界已经切换，禁止应用布局。', severity: 'error', retryable: false });
    return { groups, issues, processed, pending };
  }

  const collected = collectPendingRequests(input.db, scope, ports);
  issues.push(...collected.issues);
  const queue = collected.pending;
  if (queue.length === 0) return { groups, issues, processed, pending };

  const locations = readTable(input.db, 'locations', scope.branchId, ports);
  const characters = readTable(input.db, 'characters', scope.branchId, ports);
  const items = readTable(input.db, 'items', scope.branchId, ports);
  const maps = readTable(input.db, 'maps', scope.branchId, ports);

  for (let index = 0; index < queue.length; index += 1) {
    const job = queue[index];
    if (processed.length >= maxJobs) {
      pending.push(job.requestId);
      continue;
    }
    if (!isCurrent()) {
      issues.push({ code: 'STALE_SCOPE', path: '$.scope', message: `处理 ${job.requestId} 前世界已切换，剩余请求保持待处理。`, severity: 'error', retryable: false });
      pending.push(job.requestId);
      continue;
    }
    // 每次都重读候选行：同一轮可能已被 map.estimate / 初始化 / 前一个请求改过。
    let mapRow = readMapRow(input.db, job.mapId, scope.branchId, ports);
    if (!mapRow) {
      issues.push(spatialIssue({ code: 'MAP_ROW_MISSING', path: '$.maps', message: '候选里找不到该地图行，跳过。', severity: 'warning' }, { mapId: job.mapId }));
      pending.push(job.requestId);
      continue;
    }

    // 新空地图先初始化一致尺度（有 scene / 已定位 / 已锁定时 retained，不写）。
    // W04：先按最后 SQL 归属对账占用者，再把结果喂给生成器。
    // 没有语义结构变化时这只是更新视觉锚点，不会重生房间/城市。
    const spec = plain(job.request.spec) ? { ...job.request.spec } : {};
    const frameRead = readSpatialFrame(mapRow.frame_json, { branchId: scope.branchId, mapId: job.mapId }, { mapId: job.mapId });
    const occupants = reconcileOccupantsSpec({
      scene: frameRead.scene,
      requestSpec: spec,
      locations,
      characters,
      items,
    });
    issues.push(...occupants.issues);
    spec.actors = occupants.spec.actors;
    spec.items = occupants.spec.items;
    // M2-12：编译前按本图**实际成员**剪掉已经搬走的旧锚点。剪除随这次编译的 maps 变更
    // 一起落库、一起 journal、一起受候选 scope guard 保护，不另开写。
    const stale = pruneInvalidSceneMembers({
      scene: frameRead.scene,
      mapId: job.mapId,
      memberIds: collectSceneMemberIds({ mapId: job.mapId, maps, locations, characters, items }),
    });
    issues.push(...stale.issues);
    const deletes: Record<string, string[]> = {};
    const mergeDeletes = (source: unknown): void => {
      if (!plain(source)) return;
      for (const [key, value] of Object.entries(source)) {
        if (!Array.isArray(value)) continue;
        const list = deletes[key] ?? [];
        for (const id of value) if (typeof id === 'string' && id && !list.includes(id)) list.push(id);
        deletes[key] = list;
      }
    };
    mergeDeletes(plain(spec.deletes) ? spec.deletes : null);
    mergeDeletes({ actors: occupants.deleted.actors, items: occupants.deleted.items });
    mergeDeletes(stale.deletes);
    if (Object.keys(deletes).length > 0) spec.deletes = deletes;
    const initial = ensureInitialSpatialFrame({
      mapRow,
      scope,
      currentScope: scope,
      expectedRowRev: Number(mapRow.row_rev ?? 1),
      widthM: typeof spec.width === 'number' ? spec.width : null,
      heightM: typeof spec.height === 'number' ? spec.height : null,
      locations,
      turnId,
      operationId: `${job.operationId}:init`,
    });
    issues.push(...initial.issues);
    if (initial.mutation) {
      const initGroup = {
        id: `layout-init:${job.operationId}`,
        opIds: [`${job.operationId}:init`],
        dependsOn: [],
        readSet: [{ table: 'maps', rowId: job.mapId, rowRev: Number(mapRow.row_rev ?? 1) }],
        mutations: [initial.mutation],
      };
      const appliedInit = ports.applyGroups(input.db, [initGroup], {
        branchId: scope.branchId,
        turnId,
        attemptId: ports.attemptId ?? 'spatial',
        validate: true,
        journal: true,
      });
      const firstInit = appliedInit.groups[0] ?? null;
      groups.push(...appliedInit.groups);
      for (const message of appliedInit.journalIssues) {
        issues.push({ code: 'JOURNAL_WRITE_FAILED', path: '$.turn_changes', message, severity: 'error', retryable: false });
      }
      if (!firstInit || firstInit.status === 'rejected' || firstInit.status === 'blocked') {
        const failed = recordFailedSpatialRequest({
          db: input.db,
          mapRow,
          mapId: job.mapId,
          request: job.request,
          issues: [...initial.issues, ...issues.filter((i) => i.severity === 'error')],
          turnId,
          operationId: `${job.operationId}:failed`,
          ports,
        });
        if (failed.group) groups.push(failed.group);
        continue;
      }
      // 重读：编译必须用初始化后的候选行。
      mapRow = readMapRow(input.db, job.mapId, scope.branchId, ports) ?? mapRow;
    }

    const compiled = compileSceneGroup({
      request: { kind: job.kind, spec },
      scope,
      currentScope: { ...scope, viewMode: 'author' },
      mapRow,
      locations,
      characters,
      items,
      turnId,
      operationId: `${job.operationId}:scene`,
    }) as { ok: boolean; status: string; scene?: unknown; issues?: Array<Record<string, unknown>>; group?: Record<string, unknown> | null };

    const kitIssues = (compiled.issues ?? []).map((item) =>
      spatialIssue(item as never, { mapId: job.mapId, branchId: scope.branchId, revision: scope.revision, operationId: job.operationId, turnId }),
    );
    const errors = kitIssues.filter((item) => item.severity === 'error');
    issues.push(...kitIssues);

    if (!compiled.ok || !compiled.group) {
      if (errors.length === 0) {
        // duplicate：内容与已保存场景相同且请求已被消费 → 不算失败。
        processed.push(job.requestId);
        continue;
      }
      const failed = recordFailedSpatialRequest({
        db: input.db,
        mapRow,
        mapId: job.mapId,
        request: job.request,
        issues: errors,
        turnId,
        operationId: `${job.operationId}:failed`,
        ports,
      });
      if (failed.group) groups.push(failed.group);
      continue;
    }

    const applied = applySceneGroup(input.db, compiled.group, {
      insideCandidateTransaction: true,
      applyGroups: ports.applyGroups,
      queryBound: ports.queryBound ?? queryBound,
      isCurrent,
      branchId: scope.branchId,
      turnId,
      attemptId: ports.attemptId ?? 'spatial',
    }) as { ok: boolean; status: string; groups?: GroupResult[]; issues?: Array<Record<string, unknown>> };

    if (!applied.ok) {
      const applyIssues = (applied.issues ?? []).map((item) =>
        spatialIssue(item as never, { mapId: job.mapId, branchId: scope.branchId, operationId: job.operationId, turnId }),
      );
      issues.push(...applyIssues);
      const failed = recordFailedSpatialRequest({
        db: input.db,
        mapRow,
        mapId: job.mapId,
        request: job.request,
        issues: [...errors, ...applyIssues],
        turnId,
        operationId: `${job.operationId}:failed`,
        ports,
      });
      if (failed.group) groups.push(failed.group);
      continue;
    }

    groups.push(...(applied.groups ?? []));
    // W05：地面物品没有支撑家具组时，用房间可通行区补视觉点（只追加 scene.layout.items）。
    applyLooseItemMarkers({
      db: input.db,
      mapId: job.mapId,
      markers: occupants.looseItemMarkers,
      scope,
      isCurrent,
      turnId,
      operationId: job.operationId,
      ports,
      groups,
      issues,
    });
    processed.push(job.requestId);
  }

  if (!isCurrent()) {
    issues.push({ code: 'STALE_SCOPE', path: '$.scope', message: '布局处理期间世界已切换：已应用的组随候选一并放弃。', severity: 'error', retryable: false });
  }
  return { groups, issues, processed, pending };
}
