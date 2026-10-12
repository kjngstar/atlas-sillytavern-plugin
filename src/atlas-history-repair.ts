/**
 * atlas-history-repair.ts — P15/§22 历史数据修复（只读预览 + 原子候选构造）。
 *
 * 预览把「保留 ID / 退役 ID / 引用重定向 / 地图保留或退役 /
 * 事实冲突 / 锁 / 预计变化量」全部摊开给作者看，执行另走一次明确选定方案的流程（§22 第 9 条：
 * 应用要经正常候选、外键、ACK、journal，失败保持原库、rollback 恢复）。
 * `applyHistoryRepair()` 只返回候选组，宿主负责校验、持久化与 ACK。
 *
 * 纪律：
 * - 全库检索一律**分页**（按 id 递增翻页），翻不完就报 `HISTORY_SCAN_INCOMPLETE`；
 *   绝不用「前 1000 行没发现问题」冒充修复完毕。
 * - 同名但**父地点不同**的对象保持独立（R03 的父身份保护），只有同父同名才进候选。
 * - 两个候选各有 active 子图时先报归属冲突，**不产生唯一约束破坏**。
 * - 确认几何/锁冲突 → 该动作 `applicable=false`，其他独立候选照常可审阅。
 * - 旧 `map_id=null` 路线只有**两端归属唯一可推导**且无冲突时才列入建议。
 * - 预览是纯读：任何一次调用都不得改动存档（快照哈希与 journal 行数作为证据）。
 * - `previewHash` 绑 branch / revision / head：世界变了旧预览立刻失效，不许拿来强写新库。
 */

import { queryBound } from './atlas-db-runtime.ts';
import { stableHexHash } from './atlas-hash.ts';
import { SPACE_CANONICAL_FRAME_KEY, SPACE_SIZE_REL_TOLERANCE, resolveMapSpaceSize, sizesAgree } from './atlas-space-canonical.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { PlanIssue } from './atlas-world-contract.ts';
import { createTableReadPort } from './atlas-db-readport.ts';
import type { AtomicGroup, RowMutation } from './atlas-ops-contract.ts';
import type { AtlasTableName } from './atlas-db-contract.ts';
import { compileSceneGroup } from '../vendor/atlas-spatial/index.mjs';

export const HISTORY_REPAIR_PREVIEW_VERSION = 1;
/** 分页大小：纯读查询，一次 200 行足以让 id 游标稳定推进。 */
export const HISTORY_SCAN_PAGE = 200;
/** 翻页上限：翻不完就是「没扫完」，报错而不是宣布没问题。 */
export const HISTORY_SCAN_MAX_PAGES = 500;
/** 旧 ID → 保留实体 的解析深度上限（§22.2 第 2 条：固定深度、同分支、无环）。 */
export const MERGE_REDIRECT_MAX_DEPTH = 8;

/** 带 `merged_into_id` 的四张实体表；不在表内一律拒绝，绝不拼未校验的表名。 */
const MERGED_TABLES: ReadonlySet<string> = new Set(['locations', 'characters', 'items', 'factions']);

export type MergedIdResolution = {
  requestedId: string;
  /** 解析后的当前态实体 ID；没合并过就是它自己。 */
  resolvedId: string;
  /** 解析链（含起点、不含终点）：连续合并过几次就多长。 */
  chain: string[];
  merged: boolean;
};

/**
 * §22.2 第 2 条：**当前态**读取把已合并的旧 ID 指向保留实体。
 *
 * - 只在同一分支内解析（各分支历史独立，不跨分支借 ID）；
 * - 固定深度上限 + 环检测：坏记录报 `HISTORY_MERGE_CYCLE` / `HISTORY_MERGE_DEPTH_EXCEEDED`，
 *   而不是把读取拖进死循环，也不是假装「没合并过」；
 * - 只有 `status='merged'` 且 `merged_into_id` 非空才跳转 —— 二者缺一都不算一次合并记录。
 * - **历史态**读取（journal / 当时落盘的记录）不走这里：过去就是过去，不用今天的 redirect 改写。
 */
export function resolveMergedId(input: { db: SqlDatabase; branchId: string; table?: string; id: string; maxDepth?: number }): MergedIdResolution {
  const table = input.table ?? 'locations';
  if (!MERGED_TABLES.has(table)) throw fail('HISTORY_MERGE_UNKNOWN_TABLE', `表 ${table} 没有合并记录字段；只支持 ${[...MERGED_TABLES].join('、')}`);
  const maxDepth = input.maxDepth ?? MERGE_REDIRECT_MAX_DEPTH;
  let current = input.id;
  const chain: string[] = [];
  const seen = new Set<string>();
  for (;;) {
    const rows = queryBound(input.db, `SELECT merged_into_id AS next, status FROM ${table} WHERE branch_id = ? AND id = ?`,
      [input.branchId, current]) as Row[];
    const row = rows[0];
    if (!row) break;
    const next = idOf(row.next);
    if (!next || text(row.status) !== 'merged') break;
    if (chain.length >= maxDepth) {
      throw fail('HISTORY_MERGE_DEPTH_EXCEEDED', `旧 ID ${input.id} 的合并链超过 ${maxDepth} 层仍未到达保留实体；链上可能是坏记录`);
    }
    if (seen.has(next) || next === current) {
      throw fail('HISTORY_MERGE_CYCLE', `旧 ID ${input.id} 的合并链出现环（${[...chain, current, next].join(' → ')}）；不解析成任意一个，先修数据`);
    }
    seen.add(current);
    chain.push(current);
    current = next;
  }
  return { requestedId: input.id, resolvedId: current, chain, merged: chain.length > 0 };
}

export type HistoryRepairActionKind = 'merge-location' | 'repair-route-map' | 'adopt-space-size';

export type HistoryRepairReferenceChange = {
  table: string;
  rowId: string;
  column: string;
  from: string | null;
  to: string;
};

export type HistoryRepairChildMapChange = { mapId: string; action: 'keep' | 'retire'; reason: string };

export type HistoryRepairAction = {
  kind: HistoryRepairActionKind;
  /** 保留哪个实体；歧义未解时为 null（明确「不选」而不是随便挑一个）。 */
  retainedId: string | null;
  retiredIds: string[];
  /** 当前态里指向退役实体的真实引用（分类核对的结果）。 */
  referenceChanges: HistoryRepairReferenceChange[];
  childMapChanges: HistoryRepairChildMapChange[];
  /** adopt-space-size：canonical 推荐值与影响范围（只推荐，不覆盖确认尺寸）。 */
  recommendation?: { locationId: string; widthM: number; heightM: number; basis: string; impact: string[] };
  conflicts: PlanIssue[];
  /** 有未解决的确认事实/锁/归属冲突时为 false：该动作不可应用，其他候选不受影响。 */
  applicable: boolean;
};

export type HistoricalRepairPreview = {
  version: number;
  branchId: string;
  baseRevision: number;
  baseHeadTurnId: string | null;
  previewHash: string;
  actions: HistoryRepairAction[];
  counts: Record<string, number>;
  scanned: { locations: number; maps: number; routes: number; pages: number };
};

export class HistoryRepairError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'HistoryRepairError';
    this.code = code;
  }
}
const fail = (code: string, message: string) => new HistoryRepairError(code, message);

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));
const idOf = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/**
 * 当前态里**所有**可能指向地点的列。合并候选必须按这张表逐列核对；
 * 少一列就意味着「合完还有半截引用指向退役实体」。
 */
const LOCATION_REFERENCE_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'locations', column: 'parent_location_id' },
  { table: 'locations', column: 'anchor_location_id' },
  { table: 'characters', column: 'location_id' },
  { table: 'items', column: 'location_id' },
  { table: 'maps', column: 'container_location_id' },
  { table: 'routes', column: 'from_location_id' },
  { table: 'routes', column: 'to_location_id' },
  { table: 'events', column: 'location_id' },
  { table: 'actions', column: 'target_location_id' },
  { table: 'information', column: 'origin_location_id' },
  { table: 'rumor_fronts', column: 'location_id' },
  { table: 'factions', column: 'headquarters_location_id' },
  { table: 'journeys', column: 'origin_location_id' },
  { table: 'journeys', column: 'destination_location_id' },
  { table: 'journeys', column: 'stop_location_id' },
  { table: 'journeys', column: 'last_reached_location_id' },
  { table: 'items', column: 'owner_entity_id' },
  { table: 'relations', column: 'subject_entity_id' },
  { table: 'relations', column: 'object_entity_id' },
  { table: 'actions', column: 'actor_entity_id' },
  { table: 'actions', column: 'target_entity_id' },
  { table: 'journeys', column: 'mover_entity_id' },
  { table: 'events', column: 'subject_entity_id' },
  { table: 'information', column: 'subject_entity_id' },
  { table: 'information', column: 'originator_entity_id' },
  { table: 'knowledge', column: 'source_entity_id' },
  { table: 'channels', column: 'owner_entity_id' },
  { table: 'channels', column: 'source_entity_id' },
  { table: 'channels', column: 'recipient_entity_id' },
  { table: 'channels', column: 'source_location_id' },
  { table: 'channels', column: 'recipient_location_id' },
  { table: 'mention_candidates', column: 'promoted_entity_id' },
];

type Row = Record<string, unknown>;

/** 按 id 游标翻页读完一张表；翻不完直接报错。 */
function pageAll(db: SqlDatabase, table: string, branchId: string, columns: string): { rows: Row[]; pages: number } {
  const rows: Row[] = [];
  let cursor = '';
  let pages = 0;
  for (;;) {
    const batch = queryBound(db, `SELECT ${columns} FROM ${table} WHERE branch_id = ? AND id > ? ORDER BY id LIMIT ?`, [branchId, cursor, HISTORY_SCAN_PAGE]) as Row[];
    pages += 1;
    if (batch.length) { rows.push(...batch); cursor = text(batch[batch.length - 1].id); }
    if (batch.length < HISTORY_SCAN_PAGE) return { rows, pages };
    if (pages >= HISTORY_SCAN_MAX_PAGES) {
      throw fail('HISTORY_SCAN_INCOMPLETE', `${table} 翻页到上限 ${HISTORY_SCAN_MAX_PAGES} 页仍未读完；本次不宣布「未发现问题」`);
    }
  }
}

const issue = (code: string, path: string, message: string, severity: 'warning' | 'error' = 'warning'): PlanIssue =>
  ({ code, path, message, severity }) as PlanIssue;

export type HistoryRepairInput = {
  db: SqlDatabase;
  branchId: string;
  /** 预览绑定的当前 revision / head：应用前必须复核，世界变了旧预览作废。 */
  revision: number;
  headTurnId: string | null;
};

export function buildHistoryRepairPreview(input: HistoryRepairInput): HistoricalRepairPreview {
  const { db, branchId } = input;
  const locations = pageAll(db, 'locations', branchId, 'id,name,kind,parent_location_id,status,merged_into_id,area_geometry_json,map_id,anchor_location_id');
  const maps = pageAll(db, 'maps', branchId, 'id,name,kind,status,container_location_id,frame_json,meters_per_cell,scale_locked');
  const routes = pageAll(db, 'routes', branchId, 'id,from_location_id,to_location_id,map_id,status,geometry_json');
  const counts: Record<string, number> = {
    locations: locations.rows.length, maps: maps.rows.length, routes: routes.rows.length,
    locationsMerged: 0,
    sameNameSameParent: 0, sameNameDifferentParent: 0, ambiguousSameNameRoot: 0,
    routeMapNull: 0, routeResolved: 0, routeUndetermined: 0, sizeConflicts: 0, actions: 0,
  };
  const activeMaps = maps.rows.filter((row) => text(row.status) === 'active');
  const liveLocations = locations.rows.filter((row) => !text(row.merged_into_id) && text(row.status) !== 'merged');
  // 已经合并过的行不再进候选：预览对「部分修好的档」是幂等的，不反复提同一件事。
  counts.locationsMerged = locations.rows.length - liveLocations.length;
  const actions: HistoryRepairAction[] = [];
  // 同名但父地点不同 → **保持独立**（R03 的父身份保护）；这里只统计，不产生任何动作。
  const byName = new Map<string, Row[]>();
  for (const row of liveLocations) {
    const name = text(row.name);
    (byName.get(name) ?? byName.set(name, []).get(name)!).push(row);
  }
  for (const rows of byName.values()) {
    if (new Set(rows.map((row) => text(row.parent_location_id))).size > 1) counts.sameNameDifferentParent += 1;
  }

  // ── 候选 1：同父同名重复地点（§22 候选范围第 1/3 条） ──
  const groups = new Map<string, Row[]>();
  for (const row of liveLocations) {
    const key = `${text(row.name)}\u0000${text(row.parent_location_id)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(row);
  }
  const containerOf = new Map<string, Row[]>();
  for (const map of activeMaps) {
    const container = idOf(map.container_location_id);
    if (!container) continue;
    (containerOf.get(container) ?? containerOf.set(container, []).get(container)!).push(map);
  }
  /**
   * 当前态里指向地点的**全部**引用：一次扫完建索引（按被引用 ID 分组），
   * 既用于排序（谁被引用得多 → 更该保留），又用于逐列产出重定向清单。
   * 任一引用列读取失败就中止预览，不能把漏扫当成无引用。
   */
  const referenceIndex = new Map<string, Array<{ table: string; rowId: string; column: string }>>();
  for (const { table, column } of LOCATION_REFERENCE_COLUMNS) {
    let rows: Row[];
    try {
      rows = queryBound(db, `SELECT id, ${column} AS ref FROM ${table} WHERE branch_id = ? AND ${column} IS NOT NULL`, [branchId]) as Row[];
    } catch {
      throw fail('HISTORY_REFERENCE_SCAN_FAILED', `历史修复未能核对 ${table}.${column} 的地点引用；本次预览不完整`);
    }
    for (const row of rows) {
      const ref = idOf(row.ref);
      if (!ref) continue;
      (referenceIndex.get(ref) ?? referenceIndex.set(ref, []).get(ref)!)
        .push({ table, rowId: text(row.id), column });
    }
  }
  const refCount = (locationId: string) => (referenceIndex.get(locationId) ?? []).length;
  const referenceCensus = (targetIds: Set<string>) => {
    const changes: HistoryRepairReferenceChange[] = [];
    for (const target of [...targetIds].sort()) {
      for (const hit of referenceIndex.get(target) ?? []) {
        // 引用方自己也在退役集合里 → 它整行都要走，不需要重定向。
        if (targetIds.has(hit.rowId)) continue;
        changes.push({ table: hit.table, rowId: hit.rowId, column: hit.column, from: target, to: '' });
      }
    }
    return changes;
  };

  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const parentId = idOf(members[0].parent_location_id);
    if (parentId !== null) counts.sameNameSameParent += 1; else counts.ambiguousSameNameRoot += 1;
    const ids = members.map((row) => text(row.id));
    const withChildren = ids.filter((id) => (containerOf.get(id) ?? []).length > 0);
    const shapes = new Set(members.map((row) => text(row.area_geometry_json) || '(无几何)'));
    // 根层两个同名实体各有自己的城市子树 → 歧义，禁止自动合并（§22 候选范围第 2 条）。
    const ambiguousRoot = parentId === null && withChildren.length >= 2;
    // 两方都有 active 子图 → 唯一容器图未定（§22 合并约束第 5 条）。
    const containerAmbiguous = withChildren.length >= 2 && !ambiguousRoot;
    const conflicts: PlanIssue[] = [];
    if(routes.rows.some(route=>ids.includes(text(route.from_location_id))&&ids.includes(text(route.to_location_id))))conflicts.push(issue('REPAIR_ROUTE_SELF_LINK','$.routes','合并后已有路线会变成同地点到自身；先明确处理这条旧路线再合并','error'));
    if (ambiguousRoot) conflicts.push(issue('REPAIR_AMBIGUOUS_SAME_NAME_ROOT', '$.locations',
      `根层有 ${members.length} 个同名对象且各有独立子图，来源与城市子树需要人工判断；预览不选保留对象`, 'error'));
    if (containerAmbiguous) conflicts.push(issue('REPAIR_CONTAINER_AMBIGUOUS', '$.maps.container_location_id',
      `${withChildren.length} 个候选各有处于 active 状态的容器图；先决定唯一容器图再合并，否则会出现两张同容器 active 图`, 'error'));
    if (shapes.size > 1) conflicts.push(issue('REPAIR_CONFIRMED_GEOMETRY_CONFLICT', '$.locations.area_geometry_json',
      '候选之间的确认几何不一致；不合并确认尺寸，等作者显式选定', 'error'));
    // 保留方取「引用最多」；并列时取 id 最小，保证预览可重复。
    const ranked = [...members].sort((a, b) => {
      const byRefs = refCount(text(b.id)) - refCount(text(a.id));
      return byRefs !== 0 ? byRefs : text(a.id).localeCompare(text(b.id));
    });
    const retained = ambiguousRoot ? null : text(ranked[0].id);
    const retired = ambiguousRoot ? ids : ids.filter((id) => id !== retained);
    const targetIds = new Set(retired);
    const referenceChanges = referenceCensus(targetIds).map((change) => ({ ...change, to: retained ?? '' }));
    const childMapChanges: HistoryRepairChildMapChange[] = [];
    for (const id of retired) for (const map of containerOf.get(id) ?? []) {
      childMapChanges.push({ mapId: text(map.id), action: withChildren.length===1?'keep':'retire', reason: withChildren.length===1?'唯一容器图随地点身份重定向保留':`容器地点 ${id} 退役后不再保留独立容器图（历史图保留在历史里）` });
    }
    for (const map of retained ? containerOf.get(retained) ?? [] : []) {
      childMapChanges.push({ mapId: text(map.id), action: 'keep', reason: '保留方自己的容器图不动' });
    }
    actions.push({
      kind: 'merge-location', retainedId: retained, retiredIds: retired,
      referenceChanges, childMapChanges, conflicts, applicable: conflicts.length === 0,
    });
  }

  // ── 候选 2：旧 map_id=null 路线，只有两端归属唯一可推导才建议（§22 候选范围第 4 条） ──
  const locationMap = new Map(liveLocations.map((row) => [text(row.id), idOf(row.map_id)]));
  const mapOfLocation = (locationId: string | null): { mapId: string | null; unique: boolean } => {
    if (!locationId) return { mapId: null, unique: false };
    const own = locationMap.get(locationId) ?? null;
    if (own) return { mapId: own, unique: true };
    // 没有 map_id 时，看它是不是恰好只有一张 active 容器图 —— 多于一张就是不唯一。
    const containers = containerOf.get(locationId) ?? [];
    return containers.length === 1 ? { mapId: text(containers[0].id), unique: true } : { mapId: null, unique: false };
  };
  for (const route of routes.rows) {
    if (idOf(route.map_id)) continue;
    counts.routeMapNull += 1;
    const from = mapOfLocation(idOf(route.from_location_id));
    const to = mapOfLocation(idOf(route.to_location_id));
    if (!from.unique || !to.unique || !from.mapId || from.mapId !== to.mapId) { counts.routeUndetermined += 1; continue; }
    counts.routeResolved += 1;
    actions.push({
      kind: 'repair-route-map', retainedId: from.mapId, retiredIds: [],
      referenceChanges: [{ table: 'routes', rowId: text(route.id), column: 'map_id', from: null, to: from.mapId }],
      childMapChanges: [], conflicts: [], applicable: true,
    });
  }

  // ── 候选 3：父子估计尺寸冲突 → 给 canonical 推荐，不覆盖确认尺寸（§22 候选范围第 5 条） ──
  //
  // 口径直接复用 §19 的唯一权威：`resolveMapSpaceSize` 取「作者确认轮廓 → 该地点唯一容器图的
  // canonical → 该地点所属**父图**场景里的轮廓」。父图轮廓只是 canonical 的投影，两者不一致
  // 就是历史遗留的估计分歧 —— 推荐 canonical，且**不自动覆盖**确认尺寸/锁定事实。
  //
  // 注意：schema 的 `idx_maps_container_unique` 保证「同一容器地点至多一张 active 图」，
  // 所以冲突只可能来自「父图投影 vs 唯一容器图的 canonical」，不存在「同容器多图」这种状态。
  const sizeActions = new Map<string, HistoryRepairAction>();
  for (const map of activeMaps) {
    const container = idOf(map.container_location_id);
    if (!container || sizeActions.has(container)) continue;
    const resolved = resolveMapSpaceSize({ maps: maps.rows, locations: locations.rows, mapRow: map, branchId });
    if (!resolved) continue;
    const sources = resolved.resolution.sources;
    const canonicalSrc = sources.find((row) => row.source === 'canonical') ?? null;
    const parentSrc = sources.find((row) => row.source === 'parent-footprint') ?? null;
    // 只有一侧有记录 = 「另一侧还没记录」，不是冲突；两边都在且不一致才进候选。
    if (!canonicalSrc || !parentSrc || sizesAgree(canonicalSrc, parentSrc)) continue;
    counts.sizeConflicts += 1;
    const canonicalSize = resolved.canonical?.size ?? null;
    const locked = canonicalSize?.locked === true;
    const confirmed = canonicalSrc.quality === 'confirmed';
    const confirmedConflict = confirmed || resolved.resolution.conflict;
    const sourceLabel = (row: typeof sources[number]) => `${row.source === 'canonical' ? text(map.id) : text(row.referenceId)}`
      + `（${row.widthM}×${row.heightM}m · ${row.source}${row.quality === 'confirmed' ? ' · 已确认' : ''}`
      + `${row.source === 'canonical' && locked ? ' · 已锁定' : ''}）`;
    const conflicts: PlanIssue[] = [];
    if (locked) {
      conflicts.push(issue('REPAIR_LOCKED_FACT', `$.frame_json.${SPACE_CANONICAL_FRAME_KEY}`,
        `地点 ${container} 的 canonical 尺寸被锁定；锁定事实不参与自动采纳，父图投影 ${parentSrc.widthM}×${parentSrc.heightM}m 原样保留`, 'error'));
    } else if (confirmedConflict) {
      conflicts.push(issue('REPAIR_CONFIRMED_SIZE_CONFLICT', `$.frame_json.${SPACE_CANONICAL_FRAME_KEY}`,
        `地点 ${container} 的 canonical 尺寸已是确认级，与父图投影 ${parentSrc.widthM}×${parentSrc.heightM}m 不一致；确认尺寸不自动覆盖，等作者显式选定`, 'error'));
    } else {
      conflicts.push(issue('REPAIR_SIZE_MISMATCH', `$.frame_json.${SPACE_CANONICAL_FRAME_KEY}`,
        `地点 ${container} 的父图投影 ${parentSrc.widthM}×${parentSrc.heightM}m 与 canonical ${canonicalSrc.widthM}×${canonicalSrc.heightM}m 不一致（超出 ${SPACE_SIZE_REL_TOLERANCE * 100}% 容差）；推荐采用 canonical ${canonicalSrc.widthM}×${canonicalSrc.heightM}m`));
    }
    sizeActions.set(container, {
      kind: 'adopt-space-size', retainedId: container, retiredIds: [], referenceChanges: [], childMapChanges: [],
      recommendation: {
        locationId: container, widthM: canonicalSrc.widthM, heightM: canonicalSrc.heightM,
        basis: text(canonicalSize?.basis.kind ?? 'canonical'),
        impact: sources.map(sourceLabel),
      },
      conflicts, applicable: !locked && !confirmedConflict,
    });
  }
  for (const action of sizeActions.values()) actions.push(action);

  actions.sort((a, b) => (a.kind === b.kind
    ? text(a.retainedId ?? a.retiredIds[0]).localeCompare(text(b.retainedId ?? b.retiredIds[0]))
    : a.kind.localeCompare(b.kind)));
  counts.actions = actions.length;
  return {
    version: HISTORY_REPAIR_PREVIEW_VERSION, branchId, baseRevision: input.revision, baseHeadTurnId: input.headTurnId ?? null,
    previewHash: stableHexHash(JSON.stringify({ version: HISTORY_REPAIR_PREVIEW_VERSION, branchId, revision: input.revision, head: input.headTurnId ?? null, actions })),
    actions, counts, scanned: { locations: locations.pages, maps: maps.pages, routes: routes.pages, pages: locations.pages + maps.pages + routes.pages },
  };
}

/**
 * 应用前复核（§22 第 8 条）：世界变了 / 换了分支 / head 动了 → 预览作废。
 * 这一版**只做失效判断**，不做写入。
 */
export function assertHistoryPreviewFresh(preview: HistoricalRepairPreview,
  current: { branchId: string; revision: number; headTurnId: string | null }): void {
  if (preview.branchId !== current.branchId) throw fail('HISTORY_PREVIEW_STALE', `预览属于分支 ${preview.branchId}，当前分支是 ${current.branchId}`);
  if (preview.baseRevision !== current.revision) throw fail('HISTORY_PREVIEW_STALE', `预览基于 revision ${preview.baseRevision}，当前已是 ${current.revision}`);
  if ((preview.baseHeadTurnId ?? null) !== (current.headTurnId ?? null)) throw fail('HISTORY_PREVIEW_STALE', '预览的 head 回合已经改变，重新生成预览再决定');
}

/**
 * 执行入口：本版**明确拒绝**。
 *
 * 不静默 no-op、不「顺手合并」：真实旧聊天的合并要求作者显式选定方案，并走正常候选 /
 * 外键 / ACK / journal 路径（失败保持原库、rollback 恢复）。调用方必须能看到这条明确错误。
 */
export type HistoryRepairSelection = { previewHash:string; actionIndexes:number[] };
/** Compile selected actions into one ordinary atomic group. No writes or ACK here. */
export function applyHistoryRepair(input: HistoryRepairInput & HistoryRepairSelection & {turnId:string;chatUid?:string}): AtomicGroup {
  if(!input)throw fail('HISTORY_SELECTION_INVALID','必须提供明确选定的历史修复预览');
  const preview=buildHistoryRepairPreview(input);
  if(preview.previewHash!==input.previewHash)throw fail('HISTORY_PREVIEW_STALE','历史修复预览已变化，请重新查看并选定动作');
  if(!Array.isArray(input.actionIndexes)||!input.actionIndexes.length||new Set(input.actionIndexes).size!==input.actionIndexes.length
    ||input.actionIndexes.some(i=>!Number.isSafeInteger(i)||i<0||i>=preview.actions.length))throw fail('HISTORY_SELECTION_INVALID','必须明确选择有效且不重复的预览动作编号');
  const chosen=input.actionIndexes.map(i=>preview.actions[i]);
  if(chosen.some(a=>!a.applicable||!a.retainedId))throw fail('HISTORY_ACTION_CONFLICT','选择中有未解决的身份、几何或容器归属冲突');
  const read=createTableReadPort(input.db),mutations=new Map<string,RowMutation>();
  const opId=`history-repair:${input.previewHash}`;
  const edit=(table:string,rowId:string,change:(row:Record<string,unknown>)=>void):void=>{
    const key=`${table}\0${rowId}`;let mutation=mutations.get(key);
    if(!mutation){
      const before=read.selectOne(table as AtlasTableName,input.branchId,rowId);
      if(!before)throw fail('HISTORY_REFERENCE_MISSING',`引用行 ${table}/${rowId} 已不存在`);
      mutation={table:table as AtlasTableName,rowId,before,after:structuredClone(before),sourceOpIds:[opId],basis:{kind:'history-repair',previewHash:input.previewHash}};
      mutations.set(key,mutation);
    }
    const after=mutation.after as Record<string,unknown>;change(after);
    if(typeof mutation.before?.row_rev==='number')after.row_rev=mutation.before.row_rev+1;
    if('updated_turn_id' in after)after.updated_turn_id=input.turnId;
  };
  const redirects=new Map(chosen.flatMap(a=>a.kind==='merge-location'?a.retiredIds.map(id=>[id,a.retainedId!] as const):[]));
  const branchRows=(table:AtlasTableName)=>queryBound(input.db,`SELECT id FROM ${table} WHERE branch_id=?`,[input.branchId]).map(r=>read.selectOne(table,input.branchId,String(r.id))!).filter(Boolean);
  for(const action of chosen){
    if(action.kind==='adopt-space-size'){
      const location=read.selectOne('locations',input.branchId,action.retainedId!),parent=location?.map_id?read.selectOne('maps',input.branchId,String(location.map_id)):null;
      const frame=parent?.frame_json as Record<string,unknown>|undefined,scene=frame?.atlasScene as Record<string,unknown>|undefined,layout=scene?.layout as Record<string,unknown>|undefined;
      const kind=layout?.kind,recommendation=action.recommendation!;
      if(!parent||(kind!=='floor'&&kind!=='city'))throw fail('HISTORY_SIZE_PROJECTION_UNSUPPORTED','父图没有可重建的室内或建筑足迹场景；原图保留');
      const key=kind==='floor'?'rooms':'buildings',rows=layout?.[key] as Record<string,unknown>[]|undefined,row=rows?.find(r=>r.id===action.retainedId);
      if(!row)throw fail('HISTORY_SIZE_PROJECTION_MISSING','父图中的空间投影已经变化，请重新预览');
      const scope={chatId:input.chatUid??'history-repair',branchId:input.branchId,revision:input.revision,viewMode:'author' as const};
      const projection=compileSceneGroup({request:{kind,spec:{[key]:[{...row,w:recommendation.widthM,h:recommendation.heightM}]}},scope,currentScope:scope,mapRow:parent,locations:branchRows('locations'),characters:branchRows('characters'),items:branchRows('items'),routes:branchRows('routes'),turnId:input.turnId,operationId:opId,
        spaceSize:resolveMapSpaceSize({mapRow:parent,maps:branchRows('maps'),locations:branchRows('locations'),branchId:input.branchId})});
      if(!projection.ok||projection.issues?.some((i:Record<string,unknown>)=>i.severity==='error'))throw fail('HISTORY_SIZE_PROJECTION_CONFLICT',`父图无法容纳权威尺寸，保留原图：${(projection.issues??[]).map((i:Record<string,unknown>)=>i.code).join('、')}`);
      for(const mutation of (projection.group?.mutations??[]) as RowMutation[]){
        const key=`${mutation.table}\0${mutation.rowId}`;
        if(mutations.has(key))throw fail('HISTORY_SELECTION_CONFLICT','多个动作改变同一幅空间布局，请分批选择并重新预览');
        mutations.set(key,mutation);
      }
      continue;
    }
    for(const ref of action.referenceChanges){
      edit(ref.table,ref.rowId,row=>{
        if(row[ref.column]!==ref.from)throw fail('HISTORY_REFERENCE_CHANGED',`引用 ${ref.table}/${ref.rowId}/${ref.column} 已变化`);
        row[ref.column]=ref.to;
      });
    }
    for(const id of action.retiredIds)edit('locations',id,row=>{row.status='merged';row.merged_into_id=action.retainedId;});
    for(const map of action.childMapChanges.filter(m=>m.action==='retire'))edit('maps',map.mapId,row=>{row.status='archived';});
  }
  // Saved scenes are current projections, not historical facts. Invalidate a scene
  // whose entity identity changed; its exact old bytes stay in this turn's journal.
  const mentionsRetired=(v:unknown):boolean=>typeof v==='string'?redirects.has(v):Array.isArray(v)?v.some(mentionsRetired):!!v&&typeof v==='object'&&Object.values(v).some(mentionsRetired);
  for(const raw of queryBound(input.db,'SELECT id FROM maps WHERE branch_id=?',[input.branchId])){
    const row=read.selectOne('maps',input.branchId,String(raw.id));if(!row)continue;
    const frame=row.frame_json as Record<string,unknown>;
    if(!frame||typeof frame!=='object')continue;
    if(!mentionsRetired(frame)&&!redirects.has(String(row.container_location_id)))continue;
    edit('maps',String(raw.id),after=>{
      const next=after.frame_json as Record<string,unknown>;
      delete next.atlasScene;delete next.atlasLayoutContext;delete next.atlasLayoutRequest;
      const canonical=next[SPACE_CANONICAL_FRAME_KEY] as Record<string,unknown>|undefined;
      if(canonical&&redirects.has(String(canonical.locationId))){
        const old=String(canonical.locationId),retained=redirects.get(old)!;canonical.locationId=retained;
        if(Array.isArray(canonical.furnishing))for(const furnishing of canonical.furnishing){
          if(furnishing&&typeof furnishing.localId==='string'&&furnishing.localId.startsWith(`space:${old}:furn:`))furnishing.localId=`space:${retained}:furn:`+furnishing.localId.slice(`space:${old}:furn:`.length);
        }
      }
    });
  }
  return {id:opId,opIds:[opId],dependsOn:[],mutations:[...mutations.values()],readSet:[...mutations.values()].flatMap(m=>typeof m.before?.row_rev==='number'?[{table:m.table,rowId:m.rowId,rowRev:m.before.row_rev}]:[])};
}
