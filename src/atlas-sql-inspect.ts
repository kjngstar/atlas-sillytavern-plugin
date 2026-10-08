/**
 * atlas-sql-inspect.ts — 只读完整性报告（M2-06）。
 *
 * 纪律：
 * - **只读诊断，绝不直接修复**。作者要修就走正常候选组（journal / ACK / 回退），
 *   本函数不打开新会话、不写任何行、不产生候选。
 * - 物理上孤立不等于错误：可能是合法孤岛、只通航的岛屿或飞行场景。
 *   因此孤立只作为**需人工确认的提示**给出（needsInference），不判 severity=error。
 * - 明确的结构性坏图（父环/缺父/重复容器/自容器图/多顶图/未挂接）来自统一
 *   `resolveMapTopology`，每条都带具体 location/map 字段，便于定位。
 * - `reportToken` 必须随 DB revision 变化：包含 storageRevision、业务 revision、
 *   head turn、缺失地图、根图，以及本次诊断内容。
 */
import { foreignKeyCheck, queryBound } from './atlas-db-runtime.ts';
import { stableHexHash } from './atlas-hash.ts';
import { resolveMapTopology } from './atlas-map-topology.ts';
import { ATLAS_RUNTIME_LIMITS } from './atlas-runtime-limits.ts';
import type { SqlSession } from './atlas-sql-session.ts';
import type { TopologyLocation, TopologyMap } from './atlas-world-contract.ts';

export type InspectTopologyIssue = {
  code: string;
  mapId: string | null;
  locationId: string | null;
  relatedIds: string[];
  severity: 'warning' | 'error';
  /** error = 明确错误（结构坏了）；inference = 需要推断/确认，可能合法。 */
  kind: 'error' | 'inference';
  message: string;
};

export type InspectIsolatedComponent = {
  /** 该连通分量里的地点 ID（稳定排序）。 */
  locationIds: string[];
  size: number;
  /** 分量里是否有任何一条路线跨到其它分量——孤立分量恒为 false。 */
  connectedToMain: boolean;
  note: string;
};

export type InspectCoordinateConflict = {
  locationId: string;
  name: string;
  /** 地点已确认坐标所在的坐标系（locations.map_id）。 */
  mapId: string;
  /** 按父链应当所在的坐标系（父地点的内图）。 */
  expectedMapId: string;
  precision: string;
  hasArea: boolean;
  note: string;
};

export function inspectSqlWorld(session: SqlSession) {
  const branch = session.repo.internal.branchRow()!;
  const db = session.repo.db;
  const b = session.branchId;
  const counts = queryBound(
    db,
    'SELECT (SELECT COUNT(*) FROM locations WHERE branch_id=?) locations,(SELECT COUNT(*) FROM characters WHERE branch_id=?) characters,(SELECT COUNT(*) FROM items WHERE branch_id=?) items',
    [b, b, b],
  )[0];
  const missing = queryBound(
    db,
    "SELECT l.id FROM locations l WHERE l.branch_id=? AND l.status='active' AND NOT EXISTS (SELECT 1 FROM maps m WHERE m.branch_id=l.branch_id AND m.container_location_id=l.id AND m.status='active')",
    [b],
  );
  const foreignKeys = foreignKeyCheck(db);
  const rootMissing = Number(counts.locations) > 0 && !branch.root_map_id;

  const mapRows = queryBound(db, "SELECT id, container_location_id, status FROM maps WHERE branch_id=? AND status='active'", [b]);
  const locationRows = queryBound(
    db,
    "SELECT id, kind, parent_location_id, anchor_location_id, mobility, map_id, grid_x, grid_y, coord_precision, area_geometry_json, name, status FROM locations WHERE branch_id=? AND status='active'",
    [b],
  );
  const routeRows = queryBound(db, 'SELECT id, from_location_id, to_location_id FROM routes WHERE branch_id=?', [b]);
  const diagnostics = buildInspectDiagnostics({
    branchId: b,
    rootMapId: branch.root_map_id ? String(branch.root_map_id) : null,
    mapRows,
    locationRows,
    routeRows,
  });
  const { topologyIssues, unlinkedMapIds, unknownContainment, isolatedComponents, coordinateConflicts } = diagnostics;

  const reportToken = stableHexHash(
    JSON.stringify([
      session.repo.storageRevision,
      session.repo.internal.currentRevision(),
      session.repo.internal.currentHeadTurnId(),
      missing,
      branch.root_map_id,
      topologyIssues.map((issue) => [issue.code, issue.mapId, issue.locationId, issue.relatedIds]),
      unlinkedMapIds,
      unknownContainment.map((issue) => issue.locationId),
      isolatedComponents.map((component) => component.locationIds),
      coordinateConflicts.map((conflict) => [conflict.locationId, conflict.mapId, conflict.expectedMapId]),
    ]),
  );

  const errorCount = topologyIssues.filter((issue) => issue.kind === 'error').length;
  const inferenceCount = topologyIssues.filter((issue) => issue.kind === 'inference').length + unknownContainment.length + isolatedComponents.length;
  const reasons: string[] = [];
  if (foreignKeys.length) reasons.push('存在引用错误；保存候选会拒绝该状态，请从完整备份恢复');
  if (missing.length || rootMissing) reasons.push('部分地点缺少内部地图，可重建地图结构并记录回退');
  if (errorCount) reasons.push(`地图包含关系有 ${errorCount} 处明确错误（父环/缺父/重复容器/自容器图等），需作者经候选组修复`);
  if (inferenceCount) reasons.push(`有 ${inferenceCount} 处需要推断或人工确认（未知包含、孤立交通分量等），可能合法，不自动判错`);
  if (reasons.length === 0) reasons.push('地点、人物、物品和地图引用检查通过');

  return {
    database: true,
    ...counts,
    missingMapIds: missing.map((row) => String(row.id)),
    rootMissing,
    foreignKeys,
    // ── M2-06 新增：结构性诊断与需推断项，全部只读 ──────────────────────
    topologyIssues,
    unlinkedMapIds,
    unknownContainment,
    isolatedComponents,
    coordinateConflicts,
    /** 只读诊断**不修复**：作者要修必须走候选组（prepareTurn → ACK），此处永远为 true。 */
    readonlyDiagnosis: true,
    canApply: foreignKeys.length === 0 && (missing.length > 0 || rootMissing),
    reportToken,
    reason: reasons.join('；'),
  };
}

export type InspectDiagnostics = {
  topologyIssues: InspectTopologyIssue[];
  unlinkedMapIds: string[];
  unknownContainment: InspectTopologyIssue[];
  isolatedComponents: InspectIsolatedComponent[];
  coordinateConflicts: InspectCoordinateConflict[];
};

/**
 * M2-06 纯函数部分：只读诊断的构造，便于单独验证；不接触会话、不写库。
 */
export function buildInspectDiagnostics(input: {
  branchId: string;
  rootMapId: string | null;
  mapRows: Array<Record<string, unknown>>;
  locationRows: Array<Record<string, unknown>>;
  routeRows: Array<Record<string, unknown>>;
}): InspectDiagnostics {
  const { branchId: b, rootMapId, mapRows, locationRows, routeRows } = input;
  const topology = resolveMapTopology({
    branchId: b,
    rootMapId,
    maxDepth: ATLAS_RUNTIME_LIMITS.locationDepth,
    maps: mapRows.map((row): TopologyMap => ({
      id: String(row.id),
      branchId: b,
      containerLocationId: row.container_location_id === null || row.container_location_id === undefined ? null : String(row.container_location_id),
      status: String(row.status ?? 'active'),
    })),
    locations: locationRows.map((row): TopologyLocation => ({
      id: String(row.id),
      branchId: b,
      kind: (row.kind === null || row.kind === undefined ? 'other' : String(row.kind)) as TopologyLocation['kind'],
      parentLocationId: row.parent_location_id === null || row.parent_location_id === undefined ? null : String(row.parent_location_id),
      anchorLocationId: row.anchor_location_id === null || row.anchor_location_id === undefined ? null : String(row.anchor_location_id),
      mobility: row.mobility === 'mobile' ? 'mobile' : 'fixed',
      mapId: row.map_id === null || row.map_id === undefined ? null : String(row.map_id),
      status: String(row.status ?? 'active'),
    })),
  });
  const topologyIssues: InspectTopologyIssue[] = topology.issues.map((issue) => ({
    code: issue.code,
    mapId: issue.mapId ?? null,
    locationId: issue.locationId ?? null,
    relatedIds: [...(issue.relatedIds ?? [])],
    severity: issue.severity,
    kind: 'error',
    message: issue.message,
  }));

  const mapByContainer = new Map<string, string[]>();
  for (const row of mapRows) {
    const container = row.container_location_id === null || row.container_location_id === undefined ? null : String(row.container_location_id);
    if (!container) continue;
    mapByContainer.set(container, [...(mapByContainer.get(container) ?? []), String(row.id)]);
  }
  const mapById = new Map(mapRows.map((row) => [String(row.id), row]));
  const locationById = new Map(locationRows.map((row) => [String(row.id), row]));

  // ── 未知包含：没有父地点、又不在根图上 → 归属未知（需推断，不判错）──────
  const unknownContainment: InspectTopologyIssue[] = [];
  for (const row of locationRows) {
    const id = String(row.id);
    if (row.parent_location_id !== null && row.parent_location_id !== undefined) continue;
    const mapId = row.map_id === null || row.map_id === undefined ? null : String(row.map_id);
    const map = mapId ? mapById.get(mapId) : undefined;
    const onRoot = Boolean(map && !map.container_location_id);
    if (onRoot || !mapId) continue;
    unknownContainment.push({
      code: 'UNKNOWN_CONTAINMENT',
      mapId,
      locationId: id,
      relatedIds: [],
      severity: 'warning',
      kind: 'inference',
      message: `地点 ${id}（${String(row.name ?? '')}）没有父地点，却画在非根图 ${mapId} 上：包含关系需要推断或由作者确认`,
    });
  }

  // ── 交通孤立分量：按路线连通性分组，只给提示，不判错（可能是孤岛/飞行）──
  const adjacency = new Map<string, Set<string>>();
  for (const row of locationRows) adjacency.set(String(row.id), new Set<string>());
  for (const route of routeRows) {
    const from = String(route.from_location_id);
    const to = String(route.to_location_id);
    if (!adjacency.has(from) || !adjacency.has(to)) continue;
    adjacency.get(from)!.add(to);
    adjacency.get(to)!.add(from);
  }
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const id of [...adjacency.keys()].sort()) {
    if (seen.has(id)) continue;
    const stack = [id];
    const component: string[] = [];
    seen.add(id);
    while (stack.length > 0) {
      const current = stack.pop()!;
      component.push(current);
      for (const next of [...(adjacency.get(current) ?? [])].sort()) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    components.push(component.sort());
  }
  const main = components.reduce((a, c) => (c.length > a.length ? c : a), [] as string[]);
  const isolatedComponents: InspectIsolatedComponent[] = components
    .filter((component) => component !== main)
    .map((component) => ({
      locationIds: component,
      size: component.length,
      connectedToMain: false,
      note: '这些地点没有任何路线连到主分量：可能是合法孤岛、只通航的岛屿或飞行目的地，需人工确认后再补路线',
    }));

  // ── 坐标迁移冲突：已确认坐标落在与父链不一致的坐标系里 ────────────────
  // 02 §4.2：跨图移动时，exact/confirmed 几何只有在双方 frame 变换可靠时才能转换；
  // 没有可靠变换就必须原样保留并写 COORD_FRAME_MIGRATION_BLOCKED。这里只做只读甄别。
  const coordinateConflicts: InspectCoordinateConflict[] = [];
  for (const row of locationRows) {
    const id = String(row.id);
    const precision = String(row.coord_precision ?? 'unknown');
    if (precision !== 'exact') continue;
    if (typeof row.grid_x !== 'number' || typeof row.grid_y !== 'number') continue;
    const mapId = row.map_id === null || row.map_id === undefined ? null : String(row.map_id);
    if (!mapId) continue;
    const parentId = row.parent_location_id === null || row.parent_location_id === undefined ? null : String(row.parent_location_id);
    if (!parentId) continue;
    const parent = locationById.get(parentId);
    if (!parent) continue;
    const expected = (mapByContainer.get(parentId) ?? [])[0] ?? null;
    if (!expected || expected === mapId) continue;
    coordinateConflicts.push({
      locationId: id,
      name: String(row.name ?? ''),
      mapId,
      expectedMapId: expected,
      precision,
      hasArea: row.area_geometry_json !== null && row.area_geometry_json !== undefined && row.area_geometry_json !== '',
      note: '该地点的确认坐标落在父地点内图之外的坐标系：跨图迁移需要双方已确认的 frame 变换，否则保留原 map_id/坐标/范围（COORD_FRAME_MIGRATION_BLOCKED）',
    });
  }

  return { topologyIssues, unlinkedMapIds: [...topology.unlinkedMapIds], unknownContainment, isolatedComponents, coordinateConflicts };
}

