/**
 * atlas-spatial-flow-views.ts — M4/Q05 `kind='flows'` 只读流视图。
 *
 * 规则：
 * - **只读**：不推进行程、不写 knowledge、不调用 scheduleDeliveries 之类的传播调度。
 *   同一个 flow 在 UI 上停留 5 秒，进度必须一次都不变。
 * - 进度只依据**已提交**的 segment 距离/时间，绝不现场推演、不补时间。
 * - 路径用格坐标下发，由 UI 转场景单位；没有几何就 path=null + 明确 reason，不画假线。
 * - 跨图行程：只拼当前地图那几段，其余标 crossMap，绝不把别层的坐标接起来。
 * - POV 看不到后台秘密目的地：目的地未知就整条不下发。
 */

import { projectRouteGeometry } from './atlas-db-views.ts';
import type { ViewContext } from './atlas-db-views.ts';
import { queryBound } from './atlas-db-runtime.ts';
import { estimatedArrival } from './atlas-sim-motion.ts';
import { buildPositionCache, resolveEffectivePosition } from './atlas-sim-position.ts';
import { sqlVisibility } from './atlas-sql-visibility.ts';
import { parseAudienceAllows } from './atlas-catalog-views.ts';
import type { ViewQuery, ViewResult } from './atlas-ops-contract.ts';

export type FlowPath = { mapId: string; units: 'cells'; points: Array<{ x: number; y: number }> } | null;

export type SpatialFlow = {
  flowId: string;
  kind: 'journey' | 'relation' | 'propagation';
  label: string;
  status: string;
  fromLocationId: string | null;
  toLocationId: string | null;
  moverEntityId: string | null;
  progress: number | null;
  progressQuality: 'confirmed' | 'estimated' | 'unknown';
  etaMinS: number | null;
  etaMaxS: number | null;
  mapId: string | null;
  path: FlowPath;
  crossMap: boolean;
  reason: string | null;
};

function asArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((v) => v !== null && typeof v === 'object') as Array<Record<string, unknown>>;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed.filter((v) => v !== null && typeof v === 'object') as Array<Record<string, unknown>>) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** 只取「已提交」的路段标称耗时；缺依据返回 null（调用方据此把进度判为 unknown）。 */
function segmentNominalSeconds(segment: Record<string, unknown>): number | null {
  const override = asObject(segment.durationOverride ?? segment.duration_override);
  if (override) {
    const nominal = num(override.nominal_s);
    if (nominal !== null && nominal > 0) return nominal;
  }
  const quality = String(segment.quality ?? 'unknown');
  const distance = num(segment.distanceNominalM ?? segment.distance_nominal_m);
  const speed = num(segment.speedNominalMps ?? segment.speed_nominal_mps);
  if (quality === 'unknown' || distance === null || speed === null || speed <= 0) return null;
  return distance / speed;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function querySpatialFlows(ctx: ViewContext, query: ViewQuery): ViewResult {
  if (typeof query.revision === 'number' && query.revision !== ctx.revision) {
    return {
      branchId: ctx.branchId,
      revision: ctx.revision,
      items: [],
      metadata: { stale: true, requestedRevision: query.revision, currentRevision: ctx.revision },
    };
  }

  const mapId = typeof query.mapId === 'string' && query.mapId ? query.mapId : null;
  const selected = typeof query.selectedEntityId === 'string' && query.selectedEntityId ? query.selectedEntityId : null;
  const wanted = Array.isArray((query.filter as Record<string, unknown> | undefined)?.kinds)
    ? ((query.filter as Record<string, unknown>).kinds as unknown[]).map(String)
    : ['journey', 'relation', 'propagation'];
  const branch = queryBound(ctx.db, 'SELECT clock_s FROM branches WHERE id = ?', [ctx.branchId])[0] as Record<string, unknown> | undefined;
  const clock = num(branch?.clock_s) ?? 0;
  const visibility = sqlVisibility(ctx);
  const isPov = ctx.viewMode === 'pov';
  const positionCache = buildPositionCache(ctx);

  const routes = new Map<string, Record<string, unknown>>();
  for (const row of queryBound(ctx.db, "SELECT * FROM routes WHERE branch_id = ? AND status = 'open'", [ctx.branchId])) {
    routes.set(String((row as Record<string, unknown>).id), row as Record<string, unknown>);
  }
  const items: SpatialFlow[] = [];

  /* —— 行程流 —— */
  if (wanted.includes('journey')) {
    for (const raw of queryBound(ctx.db, "SELECT * FROM journeys WHERE branch_id = ? AND status <> 'cancelled'", [ctx.branchId])) {
      const journey = raw as Record<string, unknown>;
      const mover = journey.mover_entity_id === null || journey.mover_entity_id === undefined ? null : String(journey.mover_entity_id);
      const destination = journey.destination_location_id === null || journey.destination_location_id === undefined ? null : String(journey.destination_location_id);
      if (isPov) {
        if (!mover || !(visibility.povId === mover || visibility.visibleCharacters.has(mover))) continue;
        if (destination && !visibility.knownLocations.has(destination)) continue;
      }
      const segments = asArray(journey.segments_json);
      const index = Math.max(0, Math.trunc(num(journey.segment_index) ?? 0));
      const timeDone = num(journey.segment_time_done_s) ?? 0;

      let total: number | null = 0;
      let done = 0;
      let anyEstimated = false;
      let crossMap = false;
      const points: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < segments.length; i += 1) {
        const segment = segments[i];
        const nominal = segmentNominalSeconds(segment);
        if (nominal === null) total = null;
        else {
          if (total !== null) total += nominal;
          done += i < index ? nominal : 0;
        }
        if (String(segment.quality ?? 'unknown') !== 'confirmed') anyEstimated = true;
        const routeId = segment.routeId ?? segment.route_id;
        const route = routeId === null || routeId === undefined ? undefined : routes.get(String(routeId));
        if (!route) {
          if (String(segment.quality ?? '') !== 'confirmed') anyEstimated = true;
          continue;
        }
        const routeMapId = route.map_id === null || route.map_id === undefined ? null : String(route.map_id);
        if (mapId && routeMapId !== mapId) {
          crossMap = true;
          continue;
        }
        const projected = projectRouteGeometry(route, routeMapId ?? mapId ?? '');
        if (projected.geometry) points.push(...projected.geometry.points);
      }
      if (total === null || total <= 0) {
        items.push({
          flowId: String(journey.id),
          kind: 'journey',
          label: `在途：${mover ?? '未知'}`,
          status: String(journey.status ?? ''),
          fromLocationId: journey.origin_location_id === null || journey.origin_location_id === undefined ? null : String(journey.origin_location_id),
          toLocationId: destination,
          moverEntityId: mover,
          progress: null,
          progressQuality: 'unknown',
          etaMinS: null,
          etaMaxS: null,
          mapId,
          path: null,
          crossMap,
          reason: 'JOURNEY_PROGRESS_UNKNOWN',
        });
        continue;
      }
      const currentNominal = segmentNominalSeconds(segments[index] ?? {});
      done += Math.max(0, Math.min(timeDone, currentNominal ?? 0));
      const eta = estimatedArrival(journey, clock);
      const status = String(journey.status ?? '');
      items.push({
        flowId: String(journey.id),
        kind: 'journey',
        label: `在途：${mover ?? '未知'}`,
        status,
        fromLocationId: journey.origin_location_id === null || journey.origin_location_id === undefined ? null : String(journey.origin_location_id),
        toLocationId: destination,
        moverEntityId: mover,
        progress: status === 'arrived' ? 1 : clamp01(done / total),
        progressQuality: status === 'blocked' ? 'unknown' : anyEstimated ? 'estimated' : 'confirmed',
        etaMinS: eta.minS,
        etaMaxS: eta.maxS,
        mapId,
        path: points.length >= 2 && mapId ? { mapId, units: 'cells', points } : null,
        crossMap,
        reason: points.length >= 2 && mapId ? null : crossMap ? 'CROSS_MAP' : 'NO_ROUTE_GEOMETRY',
      });
    }
  }

  /* —— 关系流：默认只画选中对象的关系，避免一屏面条 —— */
  if (wanted.includes('relation') && selected) {
    for (const raw of queryBound(
      ctx.db,
      "SELECT * FROM relations WHERE branch_id = ? AND status = 'active' AND (subject_entity_id = ? OR object_entity_id = ?)",
      [ctx.branchId, selected, selected],
    )) {
      const relation = raw as Record<string, unknown>;
      const subject = String(relation.subject_entity_id);
      const object = String(relation.object_entity_id);
      if (isPov && !(visibility.knownCharacters.has(subject) && visibility.knownCharacters.has(object))) continue;
      const a = resolveEffectivePosition(ctx, subject, undefined, positionCache);
      const b = resolveEffectivePosition(ctx, object, undefined, positionCache);
      const onMap = a.kind === 'at_grid' && b.kind === 'at_grid' && a.mapId === b.mapId && (!mapId || a.mapId === mapId);
      items.push({
        flowId: String(relation.id),
        kind: 'relation',
        label: String(relation.label ?? relation.kind ?? ''),
        status: String(relation.status ?? ''),
        fromLocationId: null,
        toLocationId: null,
        moverEntityId: null,
        progress: null,
        progressQuality: 'unknown',
        etaMinS: null,
        etaMaxS: null,
        mapId: onMap ? a.mapId : null,
        path: onMap ? { mapId: a.mapId, units: 'cells', points: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }] } : null,
        crossMap: a.kind === 'at_grid' && b.kind === 'at_grid' && a.mapId !== b.mapId,
        reason: onMap ? null : 'ENDPOINTS_NOT_ON_MAP',
      });
    }
  }

  /* —— 信息传播流：只投影「已持久化的在途任务」与「已到达的风声」 —— */
  if (wanted.includes('propagation')) {
    const channelName = new Map<string, string>();
    for (const raw of queryBound(ctx.db, 'SELECT id, name FROM channels WHERE branch_id = ?', [ctx.branchId])) {
      channelName.set(String((raw as Record<string, unknown>).id), String((raw as Record<string, unknown>).name ?? ''));
    }
    for (const raw of queryBound(ctx.db, "SELECT * FROM actions WHERE branch_id = ? AND kind = 'transmit' AND status = 'active'", [ctx.branchId])) {
      const action = raw as Record<string, unknown>;
      const payload = asObject(action.payload_json);
      if (!payload || String(payload.program_kind ?? '') !== 'rumor_delivery') continue;
      const from = payload.from_location_id === null || payload.from_location_id === undefined ? null : String(payload.from_location_id);
      const to = payload.to_location_id === null || payload.to_location_id === undefined ? null : String(payload.to_location_id);
      if (isPov && to && !visibility.knownLocations.has(to)) continue;
      const depart = num(payload.depart_at_s);
      const arrive = num(payload.arrive_at_s);
      const progress = depart !== null && arrive !== null && arrive > depart ? clamp01((clock - depart) / (arrive - depart)) : null;
      items.push({
        flowId: String(action.id),
        kind: 'propagation',
        label: `信息在途：${channelName.get(String(payload.via_channel_id ?? '')) || '未知渠道'}`,
        status: String(action.status ?? ''),
        fromLocationId: from,
        toLocationId: to,
        moverEntityId: null,
        progress,
        progressQuality: progress === null ? 'unknown' : 'estimated',
        etaMinS: arrive,
        etaMaxS: arrive,
        mapId,
        path: null,
        crossMap: false,
        reason: 'NO_ROUTE_GEOMETRY',
      });
    }
    for (const raw of queryBound(ctx.db, "SELECT * FROM rumor_fronts WHERE branch_id = ? AND status = 'active'", [ctx.branchId])) {
      const front = raw as Record<string, unknown>;
      const at = front.location_id === null || front.location_id === undefined ? null : String(front.location_id);
      if (Number(front.first_available_at_s ?? 0) > clock) continue;
      if (isPov) {
        if (at && !visibility.knownLocations.has(at)) continue;
        if (!parseAudienceAllows(front.audience_json, visibility.povId ?? null)) continue;
      }
      items.push({
        flowId: String(front.id),
        kind: 'propagation',
        label: `风声传播到：${at ?? '未知地点'}`,
        status: String(front.status ?? ''),
        fromLocationId: front.source_front_id === null || front.source_front_id === undefined ? null : String(front.source_front_id),
        toLocationId: at,
        moverEntityId: null,
        progress: null,
        progressQuality: 'unknown',
        etaMinS: null,
        etaMaxS: null,
        mapId,
        path: null,
        crossMap: false,
        reason: 'ARRIVED_FRONT',
      });
    }
  }

  return {
    branchId: ctx.branchId,
    revision: ctx.revision,
    items,
    metadata: {
      viewMode: ctx.viewMode ?? 'author',
      mapId,
      selectedEntityId: selected,
      flowCount: items.length,
      // 只读口：这里不产生任何任务/行程，等待再久也不会自己往前走。
      readOnly: true,
    },
  };
}
