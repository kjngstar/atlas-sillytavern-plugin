/**
 * atlas-sql-task-refs.ts — M3-01：定向构造「冻结引用目录」。
 *
 * 为什么另起一份，而不是继续用 `atlas-sql-refs.ts` 的 collectKnownRefs：
 * 旧实现是**全表 + 每表固定条数上限**（maps 只取 50 条）。图一多，
 * 目标图就会被挤到上限之外，alias 也就随插入顺序漂移。
 *
 * 本模块的目录是**按任务定向收集**的：
 * 1. 只查目标 map/location、其完整祖先、直接子、相关路线与双端点、必要 occupants；
 *    `selectWhere` 一律带显式 ID 集合，不做无过滤的全表扫描。
 * 2. 每 kind 按 **ID 稳定排序**后连续分配本批 alias（`L1`/`M1`/…），
 *    因此候选期间插入无关实体不会让 alias 改指向。
 * 3. 目标与祖先是「必要项」，永远进目录；超出 maxEntries 时只截断非必要项，
 *    并把完整 remainingIds + Issue 交回去，不静默丢。
 * 4. `catalogueHash` 覆盖（kind,id,rowRev）有序列表：同批重解析必须命中同一目录，
 *    禁止后续重新收集 / 重新编号。
 */

import { ATLAS_RUNTIME_LIMITS } from './atlas-runtime-limits.ts';
import { stableHexHash } from './atlas-hash.ts';
import type { TableReadPort } from './atlas-ops-compile-types.ts';
import type { AtlasTableName } from './atlas-db-contract.ts';
import type { KnownRef } from './atlas-sql-refs.ts';
import type { RefKind } from './atlas-ops-contract.ts';
import type { PlanIssue, TaskCatalogue, TaskRefInput } from './atlas-world-contract.ts';

type SqlRow = Record<string, unknown>;

/** 与 atlas-sql-refs.ts 的 CATALOG 同一套前缀/kind，保证 alias 在两个目录间可互认。 */
const REF_TABLES: Array<{ table: AtlasTableName; prefix: string; kind: RefKind }> = [
  { table: 'locations', prefix: 'L', kind: 'location' },
  { table: 'characters', prefix: 'C', kind: 'character' },
  { table: 'items', prefix: 'I', kind: 'item' },
  { table: 'factions', prefix: 'F', kind: 'faction' },
  { table: 'maps', prefix: 'M', kind: 'map' },
  { table: 'actions', prefix: 'A', kind: 'action' },
  { table: 'information', prefix: 'N', kind: 'information' },
  { table: 'routes', prefix: 'R', kind: 'route' },
  { table: 'events', prefix: 'E', kind: 'event' },
  { table: 'journeys', prefix: 'J', kind: 'journey' },
  { table: 'channels', prefix: 'H', kind: 'channel' },
  { table: 'knowledge', prefix: 'K', kind: 'knowledge' },
];

/** 单次 selectWhere 的读取上限（与 readport 内部 clamp 一致，不新增第二套限制）。 */
const SELECT_LIMIT = 1000;

const rowId = (row: SqlRow | null | undefined): string | null => {
  if (!row) return null;
  const id = row.id;
  return typeof id === 'string' && id ? id : id === null || id === undefined ? null : String(id);
};

const rowRev = (row: SqlRow): number | null => (typeof row.row_rev === 'number' ? row.row_rev : null);

/** 字典序比较，不用 localeCompare（避免宿主 locale 影响别名分配的可复现性）。 */
const byId = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function addAll(target: Set<string>, values: Iterable<string | null>): void {
  for (const value of values) if (value !== null && value !== '') target.add(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : [];
}

/**
 * collectTaskRefs：按任务定向收集一站式引用目录（只读，不写库）。
 *
 * `tables` 是编译器共用的只读端口；`input` 描述本次任务的焦点与要带的关联面。
 */
export function collectTaskRefs(tables: TableReadPort, input: TaskRefInput): TaskCatalogue {
  const branchId = String(input.branchId ?? '');
  const issues: PlanIssue[] = [];
  const maxEntries = Number.isInteger(input.maxEntries) && input.maxEntries > 0
    ? input.maxEntries
    : ATLAS_RUNTIME_LIMITS.refCatalogMaxEntries;

  // ── 1. 焦点：目标地图与目标地点是必要项 ────────────────────────────────
  const neededMaps = new Set<string>();
  const neededLocations = new Set<string>();
  const extraMaps = new Set<string>();
  const extraLocations = new Set<string>();
  const extraCharacters = new Set<string>();
  const extraItems = new Set<string>();
  const extraRoutes = new Set<string>();

  addAll(neededMaps, asStringArray(input.focusMapIds));
  addAll(neededLocations, asStringArray(input.focusLocationIds));

  const readOne = (table: AtlasTableName, id: string): SqlRow | null => tables.selectOne(table, branchId, id) as SqlRow | null;
  const readWhere = (table: AtlasTableName, where: Record<string, unknown>): SqlRow[] =>
    tables.selectWhere(table, { branch_id: branchId, ...where }, SELECT_LIMIT) as SqlRow[];

  // ── 2. 完整祖先链：父地点必须能一直查到根，且其地图也要能 resolve ────────
  const ancestorVisited = new Set<string>();
  const pendingAncestors = [...neededLocations];
  while (pendingAncestors.length > 0) {
    const current = pendingAncestors.pop() as string;
    if (ancestorVisited.has(current)) continue;
    ancestorVisited.add(current);
    const row = readOne('locations', current);
    if (!row) continue;
    const parent = row.parent_location_id === null || row.parent_location_id === undefined ? null : String(row.parent_location_id);
    if (parent && parent !== current) {
      neededLocations.add(parent);
      pendingAncestors.push(parent);
    }
    if (input.includeAncestors && row.map_id !== null && row.map_id !== undefined) neededMaps.add(String(row.map_id));
  }
  for (const id of [...neededLocations]) {
    const row = readOne('locations', id);
    if (!row) continue;
    if (row.map_id !== null && row.map_id !== undefined) neededMaps.add(String(row.map_id));
    if (input.includeAncestors && row.parent_location_id !== null && row.parent_location_id !== undefined) {
      neededLocations.add(String(row.parent_location_id));
    }
  }

  // ── 3. 直接子（一层，不递归；递归会把整棵树拖进目录） ──────────────────
  if (input.includeDirectChildren) {
    const parents = [...neededLocations].sort(byId);
    if (parents.length > 0) {
      for (const row of readWhere('locations', { parent_location_id: parents })) {
        addAll(extraLocations, [rowId(row)]);
      }
    }
  }

  // ── 4. 每张已选地图都要进目录：容器图 + 地点自带 map_id ────────────────
  const selectedLocations = (): string[] => [...new Set([...neededLocations, ...extraLocations])].sort(byId);
  const containerHosts = selectedLocations();
  if (containerHosts.length > 0) {
    for (const row of readWhere('maps', { container_location_id: containerHosts })) addAll(extraMaps, [rowId(row)]);
  }
  for (const id of containerHosts) {
    const row = readOne('locations', id);
    const mapId = row?.map_id;
    if (mapId !== null && mapId !== undefined) neededMaps.add(String(mapId));
  }

  // ── 5. 路线与双端点：与已选地点相连的路线都要能 resolve ────────────────
  if (input.includeRoutes && containerHosts.length > 0) {
    const seenRoutes = new Set<string>();
    for (const column of ['from_location_id', 'to_location_id'] as const) {
      for (const row of readWhere('routes', { [column]: containerHosts })) {
        const id = rowId(row);
        if (id === null || seenRoutes.has(id)) continue;
        seenRoutes.add(id);
        extraRoutes.add(id);
        if (row.status !== undefined && String(row.status) !== 'active') continue;
        addAll(extraLocations, [
          row.from_location_id === null || row.from_location_id === undefined ? null : String(row.from_location_id),
          row.to_location_id === null || row.to_location_id === undefined ? null : String(row.to_location_id),
        ]);
        if (row.map_id !== null && row.map_id !== undefined) extraMaps.add(String(row.map_id));
      }
    }
  }

  // ── 6. 必要 occupants：在图/在地点上的人与物 ──────────────────────────
  if (input.includeOccupants) {
    const hosts = selectedLocations();
    const selectedMaps = [...new Set([...neededMaps, ...extraMaps])].sort(byId);
    for (const table of ['characters', 'items'] as const) {
      const sink = table === 'characters' ? extraCharacters : extraItems;
      if (hosts.length > 0) for (const row of readWhere(table, { location_id: hosts })) addAll(sink, [rowId(row)]);
      if (selectedMaps.length > 0) for (const row of readWhere(table, { map_id: selectedMaps })) addAll(sink, [rowId(row)]);
      for (const id of [...sink]) {
        const row = readOne(table, id);
        if (!row) continue;
        if (row.location_id !== null && row.location_id !== undefined) extraLocations.add(String(row.location_id));
        if (row.map_id !== null && row.map_id !== undefined) extraMaps.add(String(row.map_id));
      }
    }
  }

  // 地点集合可能在上面几步里被扩张过，回收一轮它们自带的地图。
  for (const id of selectedLocations()) {
    const row = readOne('locations', id);
    const mapId = row?.map_id;
    if (mapId !== null && mapId !== undefined) neededMaps.add(String(mapId));
  }

  // ── 7. 组装：必要项优先，逐表按 ID 稳定排序后连续编号 ──────────────────
  const buckets: Record<string, { needed: Set<string>; extra: Set<string> }> = {
    locations: { needed: neededLocations, extra: extraLocations },
    maps: { needed: neededMaps, extra: extraMaps },
    characters: { needed: new Set<string>(), extra: extraCharacters },
    items: { needed: new Set<string>(), extra: extraItems },
    routes: { needed: new Set<string>(), extra: extraRoutes },
  };

  // 第一遍：所有表的必要项全量保留（目标/祖先/焦点图绝不因上限消失）。
  const neededByTable = new Map<AtlasTableName, string[]>();
  let neededTotal = 0;
  for (const { table } of REF_TABLES) {
    const bucket = buckets[table];
    const ids = bucket ? [...bucket.needed].sort(byId) : [];
    neededByTable.set(table, ids);
    neededTotal += ids.length;
  }

  // 第二遍：非必要项按表顺序吃剩余额度，吃不到的完整列入 remainingIds。
  const remainingIds: string[] = [];
  const extraByTable = new Map<AtlasTableName, string[]>();
  let budget = Math.max(0, maxEntries - neededTotal);
  let truncated = 0;
  for (const { table } of REF_TABLES) {
    const bucket = buckets[table];
    if (!bucket) continue;
    const extras = [...bucket.extra].filter((id) => !bucket.needed.has(id)).sort(byId);
    const keptExtras: string[] = [];
    for (const id of extras) {
      if (budget <= 0) {
        remainingIds.push(id);
        truncated += 1;
        continue;
      }
      keptExtras.push(id);
      budget -= 1;
    }
    extraByTable.set(table, keptExtras);
  }

  const rows: Record<string, SqlRow[]> = {};
  const knownRefs: KnownRef[] = [];
  for (const { table, prefix, kind } of REF_TABLES) {
    const ordered = [...(neededByTable.get(table) ?? [])];
    for (const id of extraByTable.get(table) ?? []) if (!ordered.includes(id)) ordered.push(id);
    const tableRows: SqlRow[] = [];
    let ordinal = 0;
    for (const id of ordered) {
      const row = readOne(table, id);
      if (!row) continue;
      ordinal += 1;
      tableRows.push(row);
      knownRefs.push({ alias: `${prefix}${ordinal}`, id, kind, rowRev: rowRev(row) });
    }
    rows[table] = tableRows;
  }

  if (neededTotal > maxEntries) {
    issues.push({
      code: 'REF_CATALOGUE_OVERSIZE',
      path: '$.catalogue',
      message: `必要引用 ${neededTotal} 条已超过目录上限 ${maxEntries}：必要项一律保留（目标与祖先不能丢），本次不再纳入任何非必要引用，请在调用方分批`,
      severity: 'warning',
      retryable: true,
    });
  } else if (truncated > 0) {
    issues.push({
      code: 'REF_CATALOGUE_TRUNCATED',
      path: '$.catalogue',
      message: `${remainingIds.length} 个非必要引用超出目录上限 ${maxEntries}（${remainingIds.slice(0, 12).join(' / ')}${remainingIds.length > 12 ? ' …' : ''}）：目标与祖先已全部保留，超出部分列入 remainingIds，需分批处理`,
      severity: 'warning',
      retryable: true,
    });
  }

  const catalogueHash = stableHexHash(
    knownRefs.map((ref) => `${ref.kind}\u0000${ref.id}\u0000${ref.rowRev ?? ''}`).join('\u0001'),
  );

  return { knownRefs, rows, remainingIds, issues, catalogueHash };
}
