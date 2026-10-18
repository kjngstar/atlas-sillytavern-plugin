/**
 * atlas-spatial-views.ts — M4/Q03 `kind='scene'` 只读视图（包内 docs/04 第 8 节固定 DTO）。
 *
 * 规则：
 * - 只读。不写 frame、不跑生成器、不标 failed、不碰 pending 请求——那些是写侧（M3）的事。
 * - 顺序固定：**先读场景 → 再用当前 SQL 可见集合过滤 → 再按同 revision 投影 hydrate → 返回**。
 *   POV 拿不到隐藏实体名/ID、inputSignature、structureKey、待生成 spec。
 * - `scene.sourceRevision` 旧于当前 revision **允许静态复用**（01 第 6 节）；UI 响应的 revision 恒为当前修订。
 * - 没有 atlasScene 是合法旧档：sceneStatus='missing'，由 UI 用 kind='map' 的 overview 兜底，不伪造空场景。
 */

import { decodeRow } from './atlas-db-codec.ts';
import { queryBound } from './atlas-db-runtime.ts';
import { queryMapView } from './atlas-db-views.ts';
import type { ViewContext } from './atlas-db-views.ts';
import { sqlVisibility } from './atlas-sql-visibility.ts';
import { createTableReadPort } from './atlas-db-readport.ts';
import { computeMapLayoutSignatures } from './atlas-sql-layout-task.ts';
import { assessMapCompleteness } from './atlas-map-assessment.ts';
import type { MapAssessmentV1 } from './atlas-map-assessment.ts';
import { boundCorridorIdOf, resolveSpatialProfile } from './atlas-spatial-profile.ts';
import { filterSceneForView, hydrateScene, projectMapView, readSceneFrame, collectMapLocations } from '../vendor/atlas-spatial/index.mjs';
import type { Diagnostic, SceneDocument } from '../vendor/atlas-spatial/index.mjs';
import type { ViewQuery, ViewResult } from './atlas-ops-contract.ts';

export type SpatialSceneStatus = 'ready' | 'missing' | 'invalid';

export type SpatialSceneItem = {
  mapId: string;
  /** 过滤 + hydrate 后的固定 SceneDocument；没有可用场景时为 null。 */
  scene: SceneDocument | null;
  /** 只知粗粒度地点的人物名单（POV 下已过滤）。 */
  coarseList: Array<{ entityId: string; name: string; locationId: string; locationName: string | null }>;
  issues: Diagnostic[];
  sceneStatus: SpatialSceneStatus;
  /**
   * P14/R04 §21.1：本图的可核对状态（保存/请求/场景/完整性/度量质量/语义）。
   *
   * 与场景**同源**：期望集合取本视图已过滤的成员与点位，已表示集合取同一个（已过滤的）场景。
   * UI 不需要、也不允许用图标数量自己猜。
   */
  assessment: MapAssessmentV1;
};

function parseFrame(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function readMapRows(ctx: ViewContext): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const raw of queryBound(ctx.db, "SELECT * FROM maps WHERE branch_id = ? AND status = 'active'", [ctx.branchId])) {
    const decoded = decodeRow('maps', raw as Record<string, unknown>, { allowExtra: true });
    const row = (decoded.ok ? decoded.row : raw) as Record<string, unknown>;
    out.set(String(row.id), row);
  }
  return out;
}

export function querySpatialScene(ctx: ViewContext, query: ViewQuery): ViewResult {
  // 同 revision 守卫：修订不符一律空视图，绝不把上一修订的场景画成现状。
  if (typeof query.revision === 'number' && query.revision !== ctx.revision) {
    return {
      branchId: ctx.branchId,
      revision: ctx.revision,
      items: [],
      metadata: { stale: true, requestedRevision: query.revision, currentRevision: ctx.revision },
    };
  }

  const mapView = queryMapView(ctx, { ...query, kind: 'map' });
  const mapMeta = mapView.metadata as Record<string, unknown>;
  if (mapMeta.stale === true) return mapView;

  const viewItems = mapView.items as Array<{
    mapId: string;
    points?: Array<Record<string, unknown>>;
    routes?: Array<Record<string, unknown>>;
    coarseList?: Array<{ entityId: string; name: string; locationId: string; locationName: string | null }>;
  }>;
  if (viewItems.length === 0) {
    return {
      branchId: ctx.branchId,
      revision: ctx.revision,
      items: [],
      metadata: { ...mapMeta, viewMode: ctx.viewMode ?? 'author', empty: true },
    };
  }

  const mapRows = readMapRows(ctx);
  const frames = new Map<string, Record<string, unknown> | null>();
  for (const [mapId, row] of mapRows) frames.set(mapId, parseFrame(row.frame_json));
  // P14/R04 §21.1–21.2：完整性评估要用的成员与路线。地点/路线只读一次，避免逐图重复查询。
  const locationRows = queryBound(ctx.db, "SELECT * FROM locations WHERE branch_id = ? AND status = 'active'", [ctx.branchId]) as Array<Record<string, unknown>>;
  const routeRows = queryBound(ctx.db, 'SELECT * FROM routes WHERE branch_id = ?', [ctx.branchId]) as Array<Record<string, unknown>>;
  const locationById = new Map<string, Record<string, unknown>>();
  for (const row of locationRows) locationById.set(String(row.id), row);
  const visibility = sqlVisibility(ctx);
  // Author signatures are never compared for POV: even a boolean could reveal
  // hidden structural changes. POV reports alignment as unverified instead.
  const currentSignatures = ctx.viewMode === 'pov' ? new Map<string, string>()
    : computeMapLayoutSignatures(createTableReadPort(ctx.db), ctx.branchId);
  const scope = {
    chatId: ctx.chatId ?? `branch:${ctx.branchId}`,
    branchId: ctx.branchId,
    revision: ctx.revision,
    viewMode: ctx.viewMode === 'pov' ? ('pov' as const) : ('author' as const),
  };
  // 名字只用于给存活下来的图元补显示名；names 本身不进响应，隐藏实体名不会因此外泄。
  const names: Record<string, string> = {};
  for (const item of mapView.items as Array<Record<string, unknown>>) {
    const points = Array.isArray(item.points) ? (item.points as Array<Record<string, unknown>>) : [];
    for (const point of points) names[String(point.entityId)] = String(point.name ?? '');
    const coarse = Array.isArray(item.coarseList) ? (item.coarseList as Array<Record<string, unknown>>) : [];
    for (const entry of coarse) names[String(entry.entityId)] = String(entry.name ?? '');
  }

  const items: SpatialSceneItem[] = [];
  for (const viewItem of viewItems) {
    const mapId = viewItem.mapId;
    const frame = frames.get(mapId) ?? null;
    const hasScene = frame !== null && Object.prototype.hasOwnProperty.call(frame, 'atlasScene');
    const read = readSceneFrame(frame, { branchId: ctx.branchId, mapId });
    const issues: Diagnostic[] = [...(read.issues ?? [])];

    let scene: SceneDocument | null = read.scene;
    let sceneStatus: SpatialSceneStatus = scene ? 'ready' : hasScene ? 'invalid' : 'missing';
    if (frame === null && !hasScene) {
      issues.push({
        code: 'FRAME_MISSING',
        path: `$.maps[${mapId}].frame_json`,
        message: '地图没有可用框架，按无场景处理',
        severity: 'warning' as const,
        entityId: mapId,
        retryable: false,
        module: 'atlas-spatial-views',
      });
    }

    const projection = projectMapView({ view: mapView as unknown as Record<string, unknown>, mapId, scope });
    if (Array.isArray(projection.issues)) issues.push(...projection.issues);

    if (scene) {
      const filtered = filterSceneForView(scene, {
        scope,
        visibleLocations: [...visibility.knownLocations],
        visibleCharacters: [...visibility.visibleCharacters],
        visibleItems: [...visibility.visibleItems],
        names,
      });
      if (filtered.ok && filtered.scene) {
        scene = filtered.scene;
        if (Array.isArray(filtered.issues)) issues.push(...filtered.issues);
      } else {
        // 过滤失败（损坏文档 / 分支不符）不下发任何几何，保留 SQL 概览。
        scene = null;
        sceneStatus = 'invalid';
        if (Array.isArray(filtered.issues)) issues.push(...filtered.issues);
        else
          issues.push({
            code: 'SCENE_FILTER_FAILED',
            path: '$.scene',
            message: '场景按当前视角过滤失败，已不下发几何',
            severity: 'error' as const,
            entityId: mapId,
            retryable: false,
            module: 'atlas-spatial-views',
          });
      }
    }

    if (scene && projection.ok && projection.scene) {
      const hydrated = hydrateScene(scene, projection as unknown as Record<string, unknown>);
      if (hydrated.ok && hydrated.scene) {
        scene = hydrated.scene;
        if (Array.isArray(hydrated.issues)) issues.push(...hydrated.issues);
      } else if (Array.isArray(hydrated.issues)) {
        // 尺度/作用域不一致时保留已过滤的静态场景，只上报，不假装已对齐。
        issues.push(...hydrated.issues);
      }
    }

    const coarseList = (projection.coarseList ?? []) as SpatialSceneItem['coarseList'];

    // ── P14/R04 §21.1–21.2：完整性评估 ────────────────────────────────────
    // 期望集合**只**来自本视图已经过滤过的内容（点位/粗定位名单/可见成员），
    // 这样 POV 在计算之前就过滤完了，秘密成员既不会进 missingIds，也不会改变数量。
    const mapRow = mapRows.get(mapId) ?? { id: mapId, frame_json: frame };
    const containerId = mapRow.container_location_id ? String(mapRow.container_location_id) : '';
    const container = containerId ? locationById.get(containerId) ?? null : null;
    const visible = (id: string): boolean => scope.viewMode !== 'pov' || visibility.knownLocations.has(id);
    const members = collectMapLocations({ mapRow, maps: [...mapRows.values()], locations: locationRows })
      .filter((row) => visible(String(row.id)));
    const profile = resolveSpatialProfile({
      map: mapRow,
      container,
      corridorEntityId: boundCorridorIdOf(mapRow),
      members,
      routes: routeRows.filter((row) => containerId !== ''
        && (String(row.from_location_id ?? '') === containerId || String(row.to_location_id ?? '') === containerId)),
    });
    const points = (viewItem.points ?? []) as Array<Record<string, unknown>>;
    const knownEntityIds = new Set<string>([
      ...visibility.knownLocations,
      ...visibility.visibleCharacters,
      ...visibility.visibleItems,
    ]);
    for (const row of members) knownEntityIds.add(String(row.id));
    if (containerId) knownEntityIds.add(containerId);
    const visibleRoutes = ((viewItem.routes ?? []) as Array<Record<string, unknown>>).map((route) => ({
      id: route.routeId,
      from_location_id: route.fromLocationId,
      to_location_id: route.toLocationId,
      // 路线几何用 DTO 里**已投影**的那份：raw 行只有 geometry_json，不能拿来判「有没有几何」。
      geometry: route.geometry ?? null,
    }));
    const assessment = assessMapCompleteness({
      map: mapRow,
      // 评估只认**本视图实际下发的**场景：POV 已在前面过滤完，秘密成员不会进
      // expectedIds / renderedIds / missingIds，也不会改变数量与诊断。
      scene: scene ?? null,
      container,
      profile: { layoutKind: profile.layoutKind, unsupported: profile.unsupported },
      members,
      characters: points.filter((point) => point.kind === 'character').map((point) => ({ id: point.entityId })),
      items: points.filter((point) => point.kind === 'item').map((point) => ({ id: point.entityId })),
      listIds: coarseList.map((entry) => entry.entityId),
      routes: visibleRoutes,
      knownEntityIds,
      // 保存状态只由最终 ACK 决定；读视图读的是**已发布**的分支库，预览路径必须用 receipt 覆盖。
      saveState: 'saved',
      currentLayoutHash: currentSignatures.get(mapId) ?? null,
      // 没有下发场景时，下发的状态就是权威（invalid/missing），不让评估另算一个。
      ...(scene ? {} : { sceneState: sceneStatus }),
    });

    items.push({
      mapId,
      scene,
      coarseList,
      issues,
      sceneStatus: scene ? 'ready' : sceneStatus,
      assessment,
    });
  }

  return {
    branchId: ctx.branchId,
    revision: ctx.revision,
    items,
    metadata: {
      viewMode: scope.viewMode,
      mapCount: items.length,
      readyCount: items.filter((i) => i.sceneStatus === 'ready').length,
      missingCount: items.filter((i) => i.sceneStatus === 'missing').length,
      invalidCount: items.filter((i) => i.sceneStatus === 'invalid').length,
    },
  };
}
