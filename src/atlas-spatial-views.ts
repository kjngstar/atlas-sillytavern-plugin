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
import { filterSceneForView, hydrateScene, projectMapView, readSceneFrame } from '../vendor/atlas-spatial/index.mjs';
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

function readMapFrames(ctx: ViewContext): Map<string, Record<string, unknown> | null> {
  const out = new Map<string, Record<string, unknown> | null>();
  for (const raw of queryBound(ctx.db, "SELECT * FROM maps WHERE branch_id = ? AND status = 'active'", [ctx.branchId])) {
    const decoded = decodeRow('maps', raw as Record<string, unknown>, { allowExtra: true });
    const row = (decoded.ok ? decoded.row : raw) as Record<string, unknown>;
    out.set(String(row.id), parseFrame(row.frame_json));
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

  const viewItems = mapView.items as Array<{ mapId: string; coarseList?: Array<{ entityId: string; name: string; locationId: string; locationName: string | null }> }>;
  if (viewItems.length === 0) {
    return {
      branchId: ctx.branchId,
      revision: ctx.revision,
      items: [],
      metadata: { ...mapMeta, viewMode: ctx.viewMode ?? 'author', empty: true },
    };
  }

  const frames = readMapFrames(ctx);
  const visibility = sqlVisibility(ctx);
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

    items.push({
      mapId,
      scene,
      coarseList: (projection.coarseList ?? []) as SpatialSceneItem['coarseList'],
      issues,
      sceneStatus: scene ? 'ready' : sceneStatus,
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
