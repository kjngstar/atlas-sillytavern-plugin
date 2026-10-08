/**
 * atlas-db-invariants.ts — E03 validateCandidate（§7.6 提交时必须成立的不变量）。
 *
 * 返回具体表/行/字段；**不吞掉基态损坏**；不静默忽略任何一类失败。
 * 组边界检查（E05）也在本文件提供 `validateGroup`，最终全库检查用 `validateCandidate`。
 */

import { ATLAS_TABLE_COLUMNS, isKnownTable, tableColumnNames } from './atlas-db-schema.ts';
import { queryBound } from './atlas-db-runtime.ts';
import { ATLAS_RUNTIME_LIMITS, ATLAS_FIELD_LIMITS } from './atlas-runtime-limits.ts';
import { decodeRow } from './atlas-db-codec.ts';
import { resolveMapTopology } from './atlas-map-topology.ts';
import type { PlanIssue, TopologyInput, TopologyLocation } from './atlas-world-contract.ts';
import type { AtlasTableName } from './atlas-db-contract.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { Issue } from './atlas-ops-contract.ts';

const LOCATION_DEPTH = ATLAS_RUNTIME_LIMITS.locationDepth;
const CONTAINER_DEPTH = ATLAS_RUNTIME_LIMITS.containerDepth;
const ACTION_PLAN_DEPTH = ATLAS_RUNTIME_LIMITS.actionPlanDepth;
const CAPABILITY_LIMIT = ATLAS_FIELD_LIMITS.capabilityLimit;
const MOBILITY_PROFILE_LIMIT = ATLAS_FIELD_LIMITS.mobilityProfileLimit;
const ALIAS_LIMIT = ATLAS_FIELD_LIMITS.aliasLimit;
const PARTICIPANTS_LIMIT = ATLAS_FIELD_LIMITS.participantsLimit;
const GEOMETRY_VERTEX_LIMIT = ATLAS_FIELD_LIMITS.geometryVertexLimit;
const ITEM_PROPERTY_LIMIT = ATLAS_FIELD_LIMITS.itemPropertyLimit;
const MENTION_RECENT_LIMIT = ATLAS_FIELD_LIMITS.mentionRecentLimit;

export type InvariantViolation = {
  code: string;
  table: string;
  rowId: string | null;
  field: string;
  message: string;
  beforeAfter?: { before: unknown; after: unknown };
};

export type CandidateValidation = {
  ok: boolean;
  violations: InvariantViolation[];
  issues: Issue[];
  checked: string[];
};

function violation(
  code: string,
  table: string,
  rowId: string | null,
  field: string,
  message: string,
  beforeAfter?: { before: unknown; after: unknown },
): InvariantViolation {
  return { code, table, rowId, field, message, beforeAfter };
}

function toIssue(v: InvariantViolation): Issue {
  return {
    code: v.code,
    path: `${v.table}.${v.field}`,
    message: `${v.message}（表 ${v.table} 行 ${v.rowId ?? '—'} 字段 ${v.field}）`,
    severity: 'error',
    retryable: false,
  };
}

function rowsOf(db: SqlDatabase, table: AtlasTableName, branchId: string): Array<Record<string, unknown>> {
  const hasBranch = tableColumnNames(table).includes('branch_id');
  const sql = hasBranch ? `SELECT * FROM ${table} WHERE branch_id = ?` : `SELECT * FROM ${table}`;
  const raw = queryBound(db, sql, hasBranch ? [branchId] : []);
  return raw.map((r) => {
    const decoded = decodeRow(table, r, { allowExtra: true });
    return decoded.ok ? (decoded.row as Record<string, unknown>) : (r as Record<string, unknown>);
  });
}

function rowIdOf(_table: AtlasTableName, row: Record<string, unknown>): string {
  return String(row.id ?? '');
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return Number.NaN;
  return value;
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

// ─────────────────────── M2-03：统一地图包含权威接入 ───────────────────────

/**
 * 组边界候选行。`before` 是可选的**基线行**：有它才能判断某个坏拓扑
 * 是「本次候选引入/恶化」还是「旧档自带」。生产路径由 atlas-db-commit 从
 * `mergeGroupMutations` 的 before 传入；缺失时按「未改变」保守处理
 * （不因缺信息而误判成新问题）。
 */
export type PendingRow = {
  table: string;
  rowId: string;
  row: Record<string, unknown> | null;
  before?: Record<string, unknown> | null;
};

/** 把尚未落库的候选行合并进基线行集合，得到「候选态」世界快照。 */
function mergePendingRows(rows: Array<Record<string, unknown>>, table: string, pending: PendingRow[]): Array<Record<string, unknown>> {
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  for (const item of pending) {
    if (item.table !== table) continue;
    if (!item.row) {
      byId.delete(item.rowId);
      continue;
    }
    const existing = byId.get(item.rowId);
    byId.set(item.rowId, existing ? { ...existing, ...item.row } : item.row);
  }
  return [...byId.values()];
}

/** 用候选行的 `before` 还原「候选之前」的世界快照（未提供 before 的行保持不变）。 */
function revertPendingRows(rows: Array<Record<string, unknown>>, table: string, pending: PendingRow[]): Array<Record<string, unknown>> {
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  for (const item of pending) {
    if (item.table !== table) continue;
    if (item.before === undefined) continue;
    if (item.before === null) {
      byId.delete(item.rowId);
      continue;
    }
    byId.set(item.rowId, item.before);
  }
  return [...byId.values()];
}

function topologyInputOf(
  branchId: string,
  rootMapId: string | null,
  mapRows: Array<Record<string, unknown>>,
  locationRows: Array<Record<string, unknown>>,
): TopologyInput {
  return {
    branchId,
    rootMapId,
    maxDepth: LOCATION_DEPTH,
    maps: mapRows.map((row) => ({
      id: String(row.id),
      branchId: textOrNull(row.branch_id) ?? branchId,
      containerLocationId: textOrNull(row.container_location_id),
      status: textOrNull(row.status) ?? 'active',
    })),
    locations: locationRows.map((row) => ({
      id: String(row.id),
      branchId: textOrNull(row.branch_id) ?? branchId,
      kind: (textOrNull(row.kind) ?? 'other') as TopologyLocation['kind'],
      parentLocationId: textOrNull(row.parent_location_id),
      anchorLocationId: textOrNull(row.anchor_location_id),
      mobility: row.mobility === 'mobile' ? 'mobile' : 'fixed',
      mapId: textOrNull(row.map_id),
      status: textOrNull(row.status) ?? 'active',
    })),
  };
}

/**
 * 坏图问题 → 不变量码。逐行坐标检查（`checkCoordinates`）只保留
 * 「map_id 与地点 id 字面相同」这一条本地判据；**「地点落自己内图」的真实判据
 * 是容器关系**（`maps.container_location_id === location.id`），必须放进下面
 * 的候选/基线比较里才判得准（T05：比较实际容器，不比较两个字符串是否相等）。
 */
const TOPOLOGY_INVARIANT_CODES: Record<string, string> = {
  AMBIGUOUS_CONTAINER_MAP: 'INVARIANT_MAP_CONTAINER_AMBIGUOUS',
  CONTAINER_LOCATION_MISSING: 'INVARIANT_MAP_CONTAINER_MISSING',
  MAP_CONTAINER_MISSING: 'INVARIANT_MAP_CONTAINER_MISSING',
  MAP_SELF_CONTAINED: 'INVARIANT_LOCATION_MAP_SELF',
  LOCATION_PARENT_MISSING: 'INVARIANT_MAP_PARENT_MISSING',
  ANCHOR_LOCATION_MISSING: 'INVARIANT_MAP_ANCHOR_MISSING',
  ROOT_MAP_MISSING: 'INVARIANT_MAP_ROOT_MISSING',
  MULTIPLE_ROOT_MAPS: 'INVARIANT_MAP_MULTIPLE_ROOTS',
  MAP_UNLINKED: 'INVARIANT_MAP_UNLINKED',
};

/** 问题落点：报告成哪张表的哪个字段（行 id 取地图或地点）。 */
const TOPOLOGY_ISSUE_TARGET: Record<string, { table: string; field: string; rowFrom: 'map' | 'location' }> = {
  AMBIGUOUS_CONTAINER_MAP: { table: 'maps', field: 'container_location_id', rowFrom: 'map' },
  CONTAINER_LOCATION_MISSING: { table: 'maps', field: 'container_location_id', rowFrom: 'map' },
  MAP_CONTAINER_MISSING: { table: 'maps', field: 'container_location_id', rowFrom: 'map' },
  MULTIPLE_ROOT_MAPS: { table: 'maps', field: 'container_location_id', rowFrom: 'map' },
  MAP_UNLINKED: { table: 'maps', field: 'container_location_id', rowFrom: 'map' },
  MAP_SELF_CONTAINED: { table: 'locations', field: 'map_id', rowFrom: 'location' },
  LOCATION_PARENT_MISSING: { table: 'locations', field: 'parent_location_id', rowFrom: 'location' },
  ANCHOR_LOCATION_MISSING: { table: 'locations', field: 'anchor_location_id', rowFrom: 'location' },
  ROOT_MAP_MISSING: { table: 'branches', field: 'root_map_id', rowFrom: 'map' },
};

/** 问题键：用于「候选新引入/恶化」比较，含全部关联 ID。 */
function topologyIssueKey(issue: PlanIssue): string {
  const related = [...(issue.relatedIds ?? [])].sort().join(',');
  return `${issue.code}|${issue.mapId ?? ''}|${issue.locationId ?? ''}|${related}`;
}

function isJsonColumn(name: string): boolean {
  return name.endsWith('_json');
}

void isJsonColumn;

/**
 * §7.6.2：坐标 x/y 同空或同非空；有坐标必须有 map_id；数值有限；精度与地图归属一致。
 *
 * 关于「地点落自己内图」（T05, INVARIANT_LOCATION_MAP_SELF）：判据是**容器关系**
 * `maps.container_location_id === location.id`，属于跨表结构问题，放在
 * `validateCandidate` 的候选/基线拓扑比较里报告；这里只保留「map_id 与地点 id
 * 字面相同」这一条纯本行判据（历史行为，且不依赖其它行）。
 */
function checkCoordinates(
  table: AtlasTableName,
  row: Record<string, unknown>,
  out: InvariantViolation[],
): void {
  const hasX = row.grid_x !== undefined && row.grid_x !== null;
  const hasY = row.grid_y !== undefined && row.grid_y !== null;
  const id = rowIdOf(table, row);
  if (hasX !== hasY) {
    out.push(violation('INVARIANT_COORD_PAIR', table, id, 'grid_x/grid_y', '坐标 x/y 必须同时有值或同时为空'));
  }
  const x = finiteOrNull(row.grid_x);
  const y = finiteOrNull(row.grid_y);
  if (x !== null && Number.isNaN(x)) out.push(violation('INVARIANT_COORD_NOT_FINITE', table, id, 'grid_x', '坐标必须是有限数字（未知不是 NaN/Infinity）'));
  if (y !== null && Number.isNaN(y)) out.push(violation('INVARIANT_COORD_NOT_FINITE', table, id, 'grid_y', '坐标必须是有限数字（未知不是 NaN/Infinity）'));
  if ((hasX || hasY) && (row.map_id === null || row.map_id === undefined)) {
    out.push(violation('INVARIANT_COORD_WITHOUT_MAP', table, id, 'map_id', '有坐标必须有 map_id'));
  }
  if (table === 'characters' && row.coord_precision === 'layout') {
    out.push(violation('INVARIANT_CHARACTER_LAYOUT_COORD', table, id, 'coord_precision', '人物不把 layout 坐标当实际位置'));
  }
  if (table === 'locations' && row.map_id && row.map_id === id) {
    out.push(violation('INVARIANT_LOCATION_MAP_SELF', table, id, 'map_id', '地点所在坐标系不能是它自己的内部地图'));
  }
}

/** 有向图环检测（父链、容器链、信息母版本链、计划依赖链）。 */
function findCycle(edges: Map<string, string | null>, selfLoopCode: string, table: string, field: string, out: InvariantViolation[]): void {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (node: string): void => {
    const st = state.get(node) ?? 0;
    if (st === 1) {
      const start = stack.indexOf(node);
      const cyclePath = [...stack.slice(start >= 0 ? start : 0), node];
      out.push(violation(selfLoopCode, table, node, field, `检测到环：${cyclePath.join(' -> ')}`));
      return;
    }
    if (st === 2) return;
    state.set(node, 1);
    stack.push(node);
    const next = edges.get(node) ?? null;
    if (next && edges.has(next)) visit(next);
    else if (next === node) out.push(violation(selfLoopCode, table, node, field, '指向自身形成环'));
    stack.pop();
    state.set(node, 2);
  };
  for (const node of edges.keys()) visit(node);
}

export type ValidateOptions = {
  branchId: string;
  /** 只检查这些表（组边界用）；缺省检查全部。 */
  tables?: AtlasTableName[];
  /** 只检查这些行 id（组边界用）。 */
  rowIds?: Set<string>;
  /** 组内新写行的临时视图（尚未落库时用于组边界检查）。 */
  pendingRows?: PendingRow[];
};

/**
 * E03 validateCandidate：§7.6 全部不变量。
 * 完成定义：返回具体表/行/字段；不吞掉 base 损坏。
 */
export function validateCandidate(db: SqlDatabase, options: ValidateOptions): CandidateValidation {
  const branchId = options.branchId;
  const violations: InvariantViolation[] = [];
  const checked: string[] = [];
  const only = options.tables ? new Set(options.tables) : null;
  const onlyRows = options.rowIds;

  const shouldCheck = (table: AtlasTableName, id: string): boolean => {
    if (only && !only.has(table)) return false;
    if (onlyRows && onlyRows.size > 0 && !onlyRows.has(id)) return false;
    return true;
  };

  // M2-03：容器索引先建好，供坐标检查（地点落自己内图）与坏拓扑检测共用。
  const mapRows = rowsOf(db, 'maps', branchId);

  // —— 1. 实体身份 ↔ 详情恰有一份 ——
  const entityKeys = rowsOf(db, 'entity_keys', branchId);
  const keyKindById = new Map<string, string>();
  for (const key of entityKeys) {
    const id = String(key.id ?? '');
    const kind = String(key.kind ?? '');
    if (!['location', 'character', 'item', 'faction'].includes(kind)) {
      violations.push(violation('INVARIANT_ENTITY_KEY_KIND', 'entity_keys', id, 'kind', `身份类型非法：${kind}`));
      continue;
    }
    keyKindById.set(id, kind);
  }
  const detailTables: Array<[AtlasTableName, string]> = [
    ['locations', 'location'],
    ['characters', 'character'],
    ['items', 'item'],
    ['factions', 'faction'],
  ];
  const detailIdsByKind = new Map<string, Set<string>>();
  for (const [table, kind] of detailTables) {
    const rows = rowsOf(db, table, branchId);
    const ids = new Set<string>();
    for (const row of rows) {
      const id = rowIdOf(table, row);
      ids.add(id);
      const keyKind = keyKindById.get(id);
      if (!keyKind) {
        violations.push(violation('INVARIANT_ENTITY_WITHOUT_KEY', table, id, 'id', '实体详情没有对应的 entity_keys 身份'));
      } else if (keyKind !== kind) {
        violations.push(violation('INVARIANT_ENTITY_KIND_MISMATCH', table, id, 'id', `身份类型 ${keyKind} 与详情表 ${table} 不一致`));
      }
      if (shouldCheck(table, id)) {
        checkCoordinates(table, row, violations);
        checked.push(`${table}:${id}`);
      }
    }
    detailIdsByKind.set(kind, ids);
  }
  for (const key of entityKeys) {
    const id = String(key.id ?? '');
    const kind = String(key.kind ?? '');
    const ids = detailIdsByKind.get(kind);
    if (ids && !ids.has(id)) {
      violations.push(violation('INVARIANT_KEY_WITHOUT_ENTITY', 'entity_keys', id, 'id', `身份没有对应的 ${kind} 详情`));
    }
  }

  // —— 2. 地点父链无环 + 层级上限 ——
  // 层级按**父边数**计算：从该地点出发向上走一条 parent_location_id 记 1 条边，
  // 走到第 LOCATION_DEPTH 条仍合法，第 LOCATION_DEPTH+1 条（即 13）越界。
  // 物品容器链的 CONTAINER_DEPTH=4 是另一条独立上限，二者互不影响（T04）。
  const locations = rowsOf(db, 'locations', branchId);
  const parentEdges = new Map<string, string | null>();
  const parentOf = new Map<string, string | null>();
  for (const loc of locations) {
    const id = String(loc.id);
    const parent = loc.parent_location_id === null || loc.parent_location_id === undefined ? null : String(loc.parent_location_id);
    parentEdges.set(id, parent);
    parentOf.set(id, parent);
  }
  findCycle(parentEdges, 'INVARIANT_LOCATION_PARENT_CYCLE', 'locations', 'parent_location_id', violations);
  for (const id of parentOf.keys()) {
    let depth = 0;
    let cursor = parentOf.get(id) ?? null;
    const seen = new Set<string>([id]);
    while (cursor) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      depth += 1;
      if (depth > LOCATION_DEPTH) {
        violations.push(violation('INVARIANT_LOCATION_DEPTH', 'locations', id, 'parent_location_id', `地点层级超过上限 ${LOCATION_DEPTH}`));
        break;
      }
      cursor = parentOf.get(cursor) ?? null;
    }
  }

  // —— 2b. 地图包含权威（M2-03）——
  // 复用 atlas-map-topology 的统一解析识别「坏根 / 坏父链 / 重复容器 / 自容器图 / 未挂接」，
  // 但**只拒绝候选新引入或恶化的问题**：旧档自带的问题保持只读诊断（由 inspect 展示），
  // 不能因为历史坏数据就让之后每一次写入都必死。比较基准是问题键集合
  // （码 + 地图/地点 ID + 全部关联 ID），新增键才算候选引入或恶化。
  //
  // 基线从候选行的 `before` 还原。全库一致性检查（无 pendingRows，例如保存前
  // 对候选库的整体校验）拿不到 before，于是候选态与基线完全相同 → 这里**不会**
  // 对旧档问题报警；「新引入即拒绝对应原子组」由组边界路径负责，与 02 §3
  // 「新候选造成同样问题则拒绝对应原子组」一致。
  const pendingList = options.pendingRows ?? [];
  const branchRows = rowsOf(db, 'branches', branchId);
  let baseRootMapId = textOrNull(branchRows[0]?.root_map_id);
  let candidateRootMapId = baseRootMapId;
  for (const item of pendingList) {
    if (item.table !== 'branches') continue;
    if (branchRows.length > 0 && item.rowId !== String(branchRows[0].id)) continue;
    if (item.before === undefined) continue;
    baseRootMapId = item.before === null ? null : textOrNull(item.before.root_map_id);
    if (item.row) candidateRootMapId = textOrNull(item.row.root_map_id);
  }
  const baseTopology = resolveMapTopology(
    topologyInputOf(
      branchId,
      baseRootMapId,
      revertPendingRows(mapRows, 'maps', pendingList),
      revertPendingRows(locations, 'locations', pendingList),
    ),
  );
  const candidateTopology = resolveMapTopology(
    topologyInputOf(
      branchId,
      candidateRootMapId,
      mergePendingRows(mapRows, 'maps', pendingList),
      mergePendingRows(locations, 'locations', pendingList),
    ),
  );
  const baseTopologyKeys = new Set(baseTopology.issues.map(topologyIssueKey));
  for (const issue of candidateTopology.issues) {
    const mapped = TOPOLOGY_INVARIANT_CODES[issue.code];
    if (!mapped) continue;
    if (baseTopologyKeys.has(topologyIssueKey(issue))) continue;
    const target = TOPOLOGY_ISSUE_TARGET[issue.code] ?? {
      table: 'maps',
      field: 'container_location_id',
      rowFrom: 'map' as const,
    };
    const rowId = (target.rowFrom === 'location' ? issue.locationId : issue.mapId) ?? issue.mapId ?? issue.locationId ?? null;
    violations.push(violation(mapped, target.table, rowId, target.field, `${issue.code}：${issue.message}`));
  }

  // —— 3. 物品容器链无环 + 层级上限 + 位置互斥（schema 已约束，逐项复核） ——
  const items = rowsOf(db, 'items', branchId);
  const containerEdges = new Map<string, string | null>();
  for (const item of items) {
    const id = String(item.id);
    const container = item.container_item_id === null || item.container_item_id === undefined ? null : String(item.container_item_id);
    containerEdges.set(id, container);
    const sources = [item.holder_character_id, item.container_item_id, item.location_id].filter((v) => v !== null && v !== undefined);
    if (sources.length > 1) {
      violations.push(violation('INVARIANT_ITEM_MULTIPLE_PLACEMENT', 'items', id, 'holder_character_id/container_item_id/location_id', '一件物品只能有一个实际持有/容纳/独立放置来源'));
    }
    if (typeof item.quantity === 'number' && item.quantity < 0) {
      violations.push(violation('INVARIANT_QUANTITY_NEGATIVE', 'items', id, 'quantity', '数量不能为负'));
    }
    if (item.quantity === 0 && item.status === 'active') {
      violations.push(violation('INVARIANT_QUANTITY_ZERO_ACTIVE', 'items', id, 'status', '数量为 0 时必须转为 consumed，不能继续交易'));
    }
    if (shouldCheck('items', id)) checkCoordinates('items', item, violations);
  }
  findCycle(containerEdges, 'INVARIANT_CONTAINER_CYCLE', 'items', 'container_item_id', violations);
  for (const id of containerEdges.keys()) {
    let depth = 0;
    let cursor = containerEdges.get(id) ?? null;
    const seen = new Set<string>([id]);
    while (cursor) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      depth += 1;
      if (depth > CONTAINER_DEPTH) {
        violations.push(violation('INVARIANT_CONTAINER_DEPTH', 'items', id, 'container_item_id', `容器链超过上限 ${CONTAINER_DEPTH}`));
        break;
      }
      cursor = containerEdges.get(cursor) ?? null;
    }
  }

  // —— 4. 人物：死亡/失去行动能力不能继续自行走路 ——
  const characters = rowsOf(db, 'characters', branchId);
  const deadOrDown = new Set<string>();
  for (const ch of characters) {
    const id = String(ch.id);
    if (ch.physical_status === 'dead' || ch.physical_status === 'incapacitated') deadOrDown.add(id);
    if (shouldCheck('characters', id)) checkCoordinates('characters', ch, violations);
    checkListLimits('characters', id, ch, violations);
  }
  const journeys = rowsOf(db, 'journeys', branchId);
  const openByMover = new Map<string, string[]>();
  for (const j of journeys) {
    const mover = String(j.mover_entity_id);
    const status = String(j.status);
    if (['moving', 'paused', 'blocked'].includes(status)) {
      const list = openByMover.get(mover) ?? [];
      list.push(String(j.id));
      openByMover.set(mover, list);
    }
    if (['moving', 'paused', 'blocked'].includes(status) && deadOrDown.has(mover)) {
      violations.push(violation('INVARIANT_DEAD_MOVER_TRAVELING', 'journeys', String(j.id), 'mover_entity_id', '已死亡/失去行动能力者不能有未结束行程'));
    }
    if (status === 'moving' && j.stop_location_id !== null && j.stop_location_id !== undefined) {
      violations.push(violation('INVARIANT_MOVING_WITH_STOP', 'journeys', String(j.id), 'stop_location_id', 'moving 与静止落点互斥'));
    }
    const started = finiteOrNull(j.started_at_s);
    const advanced = finiteOrNull(j.last_advanced_at_s);
    if (started !== null && advanced !== null && !Number.isNaN(started) && !Number.isNaN(advanced) && advanced < started) {
      violations.push(violation('INVARIANT_JOURNEY_TIME_ORDER', 'journeys', String(j.id), 'last_advanced_at_s', 'last_advanced_at_s 不能早于 started_at_s'));
    }
  }
  for (const list of openByMover.values()) {
    if (list.length > 1) {
      violations.push(violation('INVARIANT_MULTIPLE_OPEN_JOURNEYS', 'journeys', list[0], 'mover_entity_id', `同一 mover 有 ${list.length} 条未结束行程`));
    }
  }
  const actions = rowsOf(db, 'actions', branchId);
  for (const a of actions) {
    if (deadOrDown.has(String(a.actor_entity_id)) && ['active', 'ready'].includes(String(a.status))) {
      violations.push(violation('INVARIANT_DEAD_ACTOR_ACTION', 'actions', String(a.id), 'actor_entity_id', '死亡/失去行动能力者不能继续执行 active/ready 行动'));
    }
  }

  // —— 5. 计划依赖链无环 + 层级上限 ——
  const actionById = new Map(actions.map((a) => [String(a.id), a]));
  const actionDepends = new Map<string, string | null>();
  for (const a of actions) {
    const id = String(a.id);
    const parent = a.parent_action_id === null || a.parent_action_id === undefined ? null : String(a.parent_action_id);
    actionDepends.set(id, parent);
    if (Array.isArray(a.depends_on_json)) {
      for (const dep of a.depends_on_json as string[]) {
        if (!actionById.has(dep)) {
          violations.push(violation('INVARIANT_ACTION_DEPENDENCY_UNKNOWN', 'actions', id, 'depends_on_json', `依赖的行动不存在：${dep}`));
        }
        if (dep === id) {
          violations.push(violation('INVARIANT_ACTION_DEPENDENCY_CYCLE', 'actions', id, 'depends_on_json', '行动不能依赖自己'));
        }
      }
      if ((a.depends_on_json as string[]).length > 8) {
        violations.push(violation('INVARIANT_ACTION_DEPENDENCY_COUNT', 'actions', id, 'depends_on_json', 'depends_on_json 最多 8 项'));
      }
    }
    let depth = 0;
    let cursor = parent;
    const seen = new Set<string>([id]);
    while (cursor) {
      if (seen.has(cursor)) {
        violations.push(violation('INVARIANT_ACTION_PLAN_CYCLE', 'actions', id, 'parent_action_id', '计划父子链形成环'));
        break;
      }
      seen.add(cursor);
      depth += 1;
      if (depth > ACTION_PLAN_DEPTH) {
        violations.push(violation('INVARIANT_ACTION_PLAN_DEPTH', 'actions', id, 'parent_action_id', `计划最多 ${ACTION_PLAN_DEPTH} 层`));
        break;
      }
      const parentRow = actionById.get(cursor);
      cursor = parentRow && parentRow.parent_action_id ? String(parentRow.parent_action_id) : null;
    }
  }
  findCycle(actionDepends, 'INVARIANT_ACTION_PARENT_CYCLE', 'actions', 'parent_action_id', violations);

  // —— 6. 信息母版本链无环；事件 occurred 需要实际时刻 ——
  const information = rowsOf(db, 'information', branchId);
  const infoEdges = new Map<string, string | null>();
  for (const info of information) {
    const id = String(info.id);
    infoEdges.set(id, info.parent_information_id === null || info.parent_information_id === undefined ? null : String(info.parent_information_id));
    const created = finiteOrNull(info.created_at_s);
    const expires = finiteOrNull(info.expires_at_s);
    if (created !== null && expires !== null && !Number.isNaN(created) && !Number.isNaN(expires) && expires < created) {
      violations.push(violation('INVARIANT_INFORMATION_EXPIRY', 'information', id, 'expires_at_s', 'expires_at_s 不能早于 created_at_s'));
    }
  }
  findCycle(infoEdges, 'INVARIANT_INFORMATION_LINK_CYCLE', 'information', 'parent_information_id', violations);

  const events = rowsOf(db, 'events', branchId);
  for (const ev of events) {
    const id = String(ev.id);
    const status = String(ev.status);
    if ((status === 'occurred' || status === 'ongoing') && (ev.occurred_at_s === null || ev.occurred_at_s === undefined)) {
      violations.push(violation('INVARIANT_EVENT_OCCURRED_NEEDS_TIME', 'events', id, 'occurred_at_s', 'occurred/ongoing 事件必须有实际发生时刻'));
    }
    if (Array.isArray(ev.participants_json) && (ev.participants_json as unknown[]).length > PARTICIPANTS_LIMIT) {
      violations.push(violation('INVARIANT_EVENT_PARTICIPANTS_LIMIT', 'events', id, 'participants_json', `participants 最多 ${PARTICIPANTS_LIMIT} 个`));
    }
  }

  // —— 7. 认知：三种持有者恰选一个 ——
  const knowledge = rowsOf(db, 'knowledge', branchId);
  const seenKnower = new Map<string, string>();
  for (const k of knowledge) {
    const id = String(k.id);
    const hasCharacter = k.knower_character_id !== null && k.knower_character_id !== undefined;
    const hasFaction = k.knower_faction_id !== null && k.knower_faction_id !== undefined;
    const isPov = Number(k.is_pov ?? 0) === 1;
    const count = (hasCharacter ? 1 : 0) + (hasFaction ? 1 : 0) + (isPov ? 1 : 0);
    if (count !== 1) {
      violations.push(violation('INVARIANT_KNOWLEDGE_HOLDER', 'knowledge', id, 'knower_character_id/knower_faction_id/is_pov', '三种持有者必须且只能选择一种'));
    }
    const informationId = String(k.information_id);
    const key = hasCharacter ? `c:${String(k.knower_character_id)}:${informationId}` : hasFaction ? `f:${String(k.knower_faction_id)}:${informationId}` : `pov:${informationId}`;
    const existing = seenKnower.get(key);
    if (existing && existing !== id) {
      violations.push(violation('INVARIANT_KNOWLEDGE_DUPLICATE', 'knowledge', id, 'information_id', `同一持有者对同一信息有两条当前认知（另一条 ${existing}）`));
    } else {
      seenKnower.set(key, id);
    }
  }

  // —— 8. 渠道：范围不能是世界，recipient 至多一个 ——
  const channels = rowsOf(db, 'channels', branchId);
  for (const c of channels) {
    const id = String(c.id);
    if (c.recipient_entity_id && c.recipient_location_id) {
      violations.push(violation('INVARIANT_CHANNEL_RECIPIENT', 'channels', id, 'recipient_entity_id/recipient_location_id', 'recipient 实体/地点至多一个'));
    }
    const scope = c.scope_json as Record<string, unknown> | null;
    const hasScope = Boolean(scope && ((Array.isArray(scope.location_refs) && scope.location_refs.length > 0) || (Array.isArray(scope.entity_refs) && scope.entity_refs.length > 0)));
    if (!c.source_entity_id && !c.source_location_id && !hasScope) {
      violations.push(violation('INVARIANT_CHANNEL_SCOPE', 'channels', id, 'scope_json', '渠道必须至少有一项来源或有效范围；范围不能默认为整个世界'));
    }
    if (Array.isArray(scope?.location_refs)) {
      for (const ref of scope!.location_refs as string[]) {
        if (!parentOf.has(ref)) violations.push(violation('INVARIANT_CHANNEL_SCOPE_REF', 'channels', id, 'scope_json.location_refs', `地点引用不存在：${ref}`));
      }
    }
  }

  // —— 9. mention_candidates 上限与引用 ——
  const mentions = rowsOf(db, 'mention_candidates', branchId);
  for (const m of mentions) {
    const id = String(m.id);
    if (Array.isArray(m.recent_turn_ids_json) && (m.recent_turn_ids_json as unknown[]).length > MENTION_RECENT_LIMIT) {
      violations.push(violation('INVARIANT_MENTION_RECENT_LIMIT', 'mention_candidates', id, 'recent_turn_ids_json', `最近提及最多 ${MENTION_RECENT_LIMIT} 条`));
    }
    if (m.promoted_entity_id && !keyKindById.has(String(m.promoted_entity_id))) {
      violations.push(violation('INVARIANT_MENTION_PROMOTED_REF', 'mention_candidates', id, 'promoted_entity_id', `promoted_entity_id 指向不存在的身份：${String(m.promoted_entity_id)}`));
    }
    if (typeof m.distinct_turn_count === 'number' && m.distinct_turn_count < 1) {
      violations.push(violation('INVARIANT_MENTION_COUNT', 'mention_candidates', id, 'distinct_turn_count', 'distinct_turn_count 至少为 1'));
    }
  }

  // —— 10. 小 JSON 列的引用由提交校验器显式检查（§11.1） ——
  validateJsonRefs(db, branchId, keyKindById, parentOf, violations);

  // —— 11. 版本号与 C 列 ——
  for (const table of ['maps', 'locations', 'characters', 'items', 'factions', 'relations', 'routes', 'actions', 'journeys', 'events', 'information', 'rumor_fronts', 'knowledge', 'channels'] as AtlasTableName[]) {
    const rows = rowsOf(db, table, branchId);
    for (const row of rows) {
      const id = String(row.id);
      if (row.row_rev !== undefined && (typeof row.row_rev !== 'number' || row.row_rev < 1)) {
        violations.push(violation('INVARIANT_ROW_REV', table, id, 'row_rev', 'row_rev 必须是正整数'));
      }
      if (!row.created_turn_id || !row.updated_turn_id) {
        violations.push(violation('INVARIANT_TURN_REF', table, id, 'created_turn_id/updated_turn_id', 'C 列的创建/更新推演记录不能为空'));
      }
      for (const [column, value] of Object.entries(row)) {
        if (isJsonColumn(column) && value !== null && typeof value === 'object') {
          continue;
        }
      }
    }
  }

  // —— 12. branches 时钟顺序 ——
  const branches = rowsOf(db, 'branches', branchId);
  for (const b of branches) {
    const id = String(b.id);
    const clock = finiteOrNull(b.clock_s);
    const min = finiteOrNull(b.clock_min_s);
    const max = finiteOrNull(b.clock_max_s);
    if (clock === null || min === null || max === null || Number.isNaN(clock) || Number.isNaN(min) || Number.isNaN(max)) {
      violations.push(violation('INVARIANT_BRANCH_CLOCK_FINITE', 'branches', id, 'clock_s', '时钟必须是有限数字'));
      continue;
    }
    if (clock < 0 || min < 0 || max < 0) violations.push(violation('INVARIANT_BRANCH_CLOCK_NEGATIVE', 'branches', id, 'clock_s', '负时间非法'));
    if (!(min <= clock && clock <= max)) {
      violations.push(violation('INVARIANT_BRANCH_CLOCK_ORDER', 'branches', id, 'clock_s', 'clock_min ≤ clock ≤ clock_max 必须成立'));
    }
    const pov = b.pov_character_id;
    if (pov && !detailIdsByKind.get('character')?.has(String(pov))) {
      violations.push(violation('INVARIANT_BRANCH_POV', 'branches', id, 'pov_character_id', `pov_character_id 必须在本分支的人物中：${String(pov)}`));
    }
    const root = b.root_map_id;
    if (root) {
      const mapExists = queryBound(db, 'SELECT COUNT(*) AS n FROM maps WHERE branch_id = ? AND id = ?', [branchId, String(root)]);
      if (Number(mapExists[0]?.n ?? 0) === 0) {
        violations.push(violation('INVARIANT_BRANCH_ROOT_MAP', 'branches', id, 'root_map_id', `root_map_id 指向不存在的地图：${String(root)}`));
      }
    }
  }

  // —— 13. 待写入的行（组边界尚未落库的候选）也检查坐标与 C 列 ——
  for (const pending of options.pendingRows ?? []) {
    if (!isKnownTable(pending.table)) continue;
    if (!pending.row) continue;
    const table = pending.table;
    if ((['locations', 'characters', 'items'] as string[]).includes(table)) {
      checkCoordinates(table, pending.row, violations);
    }
    for (const column of ATLAS_TABLE_COLUMNS[table]) {
      if (!column.nullable && (pending.row[column.name] === null || pending.row[column.name] === undefined)) {
        violations.push(violation('INVARIANT_REQUIRED_NULL', table, pending.rowId, column.name, `列 ${column.name} 不允许为 NULL`));
      }
    }
    for (const [column, value] of Object.entries(pending.row)) {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        violations.push(violation('INVARIANT_NOT_FINITE', table, pending.rowId, column, '数值必须是有限数字（NaN/Infinity 非法）'));
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    issues: violations.map(toIssue),
    checked,
  };
}

function checkListLimits(table: AtlasTableName, id: string, row: Record<string, unknown>, out: InvariantViolation[]): void {
  const checks: Array<[string, number]> = [
    ['aliases_json', ALIAS_LIMIT],
    ['capabilities_json', CAPABILITY_LIMIT],
    ['mobility_profiles_json', MOBILITY_PROFILE_LIMIT],
    ['properties_json', ITEM_PROPERTY_LIMIT],
  ];
  for (const [column, limit] of checks) {
    const value = row[column];
    if (Array.isArray(value) && value.length > limit) {
      out.push(violation('INVARIANT_LIST_LIMIT', table, id, column, `${column} 超过上限 ${limit}`));
    }
  }
  const geometry = row.area_geometry_json;
  if (geometry && typeof geometry === 'object' && Array.isArray((geometry as { coordinates?: unknown[] }).coordinates)) {
    if (((geometry as { coordinates: unknown[] }).coordinates).length > GEOMETRY_VERTEX_LIMIT) {
      out.push(violation('INVARIANT_GEOMETRY_LIMIT', table, id, 'area_geometry_json', `几何顶点超过上限 ${GEOMETRY_VERTEX_LIMIT}`));
    }
  }
}

/** §11.1：小 JSON 列的引用由提交校验器显式检查，失败定位具体路径。 */
function validateJsonRefs(
  db: SqlDatabase,
  branchId: string,
  keyKindById: Map<string, string>,
  locationIds: Map<string, string | null>,
  out: InvariantViolation[],
): void {
  const actions = rowsOf(db, 'actions', branchId);
  const actionIds = new Set(actions.map((a) => String(a.id)));
  const informationIds = new Set(rowsOf(db, 'information', branchId).map((i) => String(i.id)));
  const channelIds = new Set(rowsOf(db, 'channels', branchId).map((c) => String(c.id)));
  const routeIds = new Set(rowsOf(db, 'routes', branchId).map((r) => String(r.id)));
  const eventIds = new Set(rowsOf(db, 'events', branchId).map((e) => String(e.id)));

  for (const a of actions) {
    const id = String(a.id);
    const payload = a.payload_json as Record<string, unknown> | null;
    if (!payload || typeof payload !== 'object') continue;
    const refKeys = ['destination_ref', 'information_ref', 'channel_ref', 'other_ref', 'subject_ref'];
    for (const key of refKeys) {
      const value = payload[key];
      if (typeof value !== 'string' || value === '') continue;
      const ok =
        (key === 'destination_ref' && locationIds.has(value)) ||
        (key === 'information_ref' && informationIds.has(value)) ||
        (key === 'channel_ref' && channelIds.has(value)) ||
        ((key === 'other_ref' || key === 'subject_ref') && keyKindById.has(value));
      if (!ok) {
        out.push(violation('INVARIANT_JSON_REF_UNKNOWN', 'actions', id, `payload_json.${key}`, `JSON 引用不存在：${value}`));
      }
    }
    if (Array.isArray(payload.via_refs)) {
      for (const v of payload.via_refs as string[]) {
        if (!locationIds.has(v)) {
          out.push(violation('INVARIANT_JSON_REF_UNKNOWN', 'actions', id, 'payload_json.via_refs', `JSON 引用不存在：${v}`));
        }
      }
    }
    const trigger = a.trigger_json as Record<string, unknown> | null;
    if (trigger && typeof trigger === 'object') {
      const leaves = collectConditionLeaves(trigger, 0);
      for (const leaf of leaves) {
        const kind = Object.keys(leaf)[0] ?? '';
        const body = leaf[kind] as Record<string, unknown> | undefined;
        if (!body) continue;
        if (kind === 'at_location' && body.location_ref && !locationIds.has(String(body.location_ref))) {
          out.push(violation('INVARIANT_JSON_REF_UNKNOWN', 'actions', id, 'trigger_json.at_location.location_ref', `条件引用不存在：${String(body.location_ref)}`));
        }
        if (kind === 'action_status' && body.action_ref && !actionIds.has(String(body.action_ref))) {
          out.push(violation('INVARIANT_JSON_REF_UNKNOWN', 'actions', id, 'trigger_json.action_status.action_ref', `条件引用不存在：${String(body.action_ref)}`));
        }
        if (kind === 'event_status' && body.event_ref && !eventIds.has(String(body.event_ref))) {
          out.push(violation('INVARIANT_JSON_REF_UNKNOWN', 'actions', id, 'trigger_json.event_status.event_ref', `条件引用不存在：${String(body.event_ref)}`));
        }
      }
    }
  }

  const fronts = rowsOf(db, 'rumor_fronts', branchId);
  for (const f of fronts) {
    const id = String(f.id);
    if (!informationIds.has(String(f.information_id))) {
      out.push(violation('INVARIANT_JSON_REF_UNKNOWN', 'rumor_fronts', id, 'information_id', `引用不存在：${String(f.information_id)}`));
    }
    if (!locationIds.has(String(f.location_id))) {
      out.push(violation('INVARIANT_JSON_REF_UNKNOWN', 'rumor_fronts', id, 'location_id', `引用不存在：${String(f.location_id)}`));
    }
  }

  const events = rowsOf(db, 'events', branchId);
  for (const e of events) {
    const id = String(e.id);
    if (e.route_id && !routeIds.has(String(e.route_id))) {
      out.push(violation('INVARIANT_JSON_REF_UNKNOWN', 'events', id, 'route_id', `引用不存在：${String(e.route_id)}`));
    }
    if (Array.isArray(e.participants_json)) {
      for (const p of e.participants_json as Array<{ entity_id?: string }>) {
        if (p && typeof p.entity_id === 'string' && !keyKindById.has(p.entity_id)) {
          out.push(violation('INVARIANT_JSON_REF_UNKNOWN', 'events', id, 'participants_json', `参与者引用不存在：${p.entity_id}`));
        }
      }
    }
  }
}

export function collectConditionLeaves(condition: Record<string, unknown>, depth: number): Array<Record<string, unknown>> {
  if (depth > 4) return [];
  const leaves: Array<Record<string, unknown>> = [];
  for (const [key, value] of Object.entries(condition)) {
    if ((key === 'all' || key === 'any') && Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object') leaves.push(...collectConditionLeaves(child as Record<string, unknown>, depth + 1));
      }
    } else if (key !== 'all' && key !== 'any') {
      leaves.push({ [key]: value });
    }
  }
  return leaves;
}

/** 组边界检查：只看本组触及的表/行 + 组内待写入行。 */
export function validateGroup(
  db: SqlDatabase,
  branchId: string,
  tables: AtlasTableName[],
  rowIds: string[],
  pendingRows?: PendingRow[],
): CandidateValidation {
  return validateCandidate(db, { branchId, tables, rowIds: new Set(rowIds), pendingRows });
}
