/**
 * atlas-route-ownership-reconcile.ts — 跨批次路线对账（P06 §12.4）。
 *
 * 全局初始化会跨多个窗口，所以「本次新建的路线」不能只活在内存里：每条由程序推导的
 * 路线都要留一份归属意图（`BuildRouteIntentV1`），后续窗口端点归图完成后才能继续对账。
 *
 * 纪律：
 * - 只登记**实际应用成功**的新路线；被拒绝的组不留意图（由调用方决定不传进来）。
 * - 历史路线没有意图记录 → 不自动修（`skip`），不按标题/坐标猜归属。
 * - 显式 `null` 保持拓扑（topology-only），显式 `map` 与端点不符 → 报冲突，不改。
 * - 同图端点才产生可绘制归属；跨图不拼接局部坐标。
 * - 确认几何与锁受保护，普通对账不得覆盖。
 */

import type { PlanIssue } from './atlas-world-contract.ts';

export const ROUTE_MAP_INTENTS = ['omitted', 'explicit-null', 'explicit-map'] as const;
export type RouteMapIntent = (typeof ROUTE_MAP_INTENTS)[number];

export type BuildRouteIntentV1 = {
  routeId: string;
  originJobId: string;
  sourceOperationId: string;
  mapIntent: RouteMapIntent;
  /** 程序推导出的归属图（`omitted` 时由端点决定，`explicit-map` 时为显式指定）。 */
  inferredMapId: string | null;
};

export type RouteEndpointMaps = {
  routeId: string;
  /** 起点所在地点当前所在图；未知为 null。 */
  fromMapId: string | null;
  /** 终点所在地点当前所在图；未知为 null。 */
  toMapId: string | null;
};

export const ROUTE_ASSIGNMENT_ACTIONS = [
  /** 同图且可绘制：写入该图归属。 */
  'assign',
  /** 已有确认归属 / 受保护：保持原值。 */
  'keep',
  /** 只能做拓扑：跨图或显式 null，不画局部坐标。 */
  'omit',
  /** 意图与端点矛盾：报冲突，不挑一个「看起来对」的。 */
  'conflict',
  /** 历史路线没有意图记录：不自动修。 */
  'skip',
] as const;
export type RouteAssignmentAction = (typeof ROUTE_ASSIGNMENT_ACTIONS)[number];

export type RouteAssignment = {
  routeId: string;
  action: RouteAssignmentAction;
  /** 建议的归属图；`omit` / `conflict` / `skip` 时为 null。 */
  mapId: string | null;
  /** 程序推导依据（进诊断，不进玩家地图）。 */
  reason: string;
};

export type RouteReconcileResult = {
  assignments: RouteAssignment[];
  issues: PlanIssue[];
};

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/**
 * §12.4：给「本 job 新建的路线」算归属。
 *
 * 幂等：同一批意图 + 同一批端点，永远给同一批 assignment，顺序按 routeId 升序。
 */
export function planNewRouteMapAssignments(input: {
  /** 本 job 由程序推导、需要继续对账的路线意图。 */
  intents: readonly BuildRouteIntentV1[];
  /** 实际端点当前所在的图。 */
  endpoints: readonly RouteEndpointMaps[];
  /** 已有确认归属 / 几何锁的路线：一律不动。 */
  protectedRouteIds?: readonly string[];
}): RouteReconcileResult {
  const issues: PlanIssue[] = [];
  const endpoints = new Map<string, RouteEndpointMaps>();
  for (const entry of input?.endpoints ?? []) {
    const routeId = text(entry?.routeId);
    if (routeId.length === 0) continue;
    endpoints.set(routeId, {
      routeId,
      fromMapId: text(entry.fromMapId).length > 0 ? text(entry.fromMapId) : null,
      toMapId: text(entry.toMapId).length > 0 ? text(entry.toMapId) : null,
    });
  }
  const guarded = new Set((input?.protectedRouteIds ?? []).map(text).filter((id) => id.length > 0));

  const intents = [...(input?.intents ?? [])]
    .filter((intent) => text(intent?.routeId).length > 0)
    .sort((left, right) => (text(left.routeId) < text(right.routeId) ? -1 : text(left.routeId) > text(right.routeId) ? 1 : 0));

  const assignments: RouteAssignment[] = [];
  const seen = new Set<string>();

  // 先数重复：同一路线出现多条意图时**一条都不执行**，不能先按第一条 assign 再报冲突。
  const intentCount = new Map<string, number>();
  for (const intent of intents) {
    const routeId = text(intent.routeId);
    intentCount.set(routeId, (intentCount.get(routeId) ?? 0) + 1);
  }

  for (const intent of intents) {
    const routeId = text(intent.routeId);
    if (seen.has(routeId)) continue;
    seen.add(routeId);

    if ((intentCount.get(routeId) ?? 0) > 1) {
      assignments.push({ routeId, action: 'conflict', mapId: null, reason: '同一路线出现多条归属意图' });
      issues.push({
        code: 'ROUTE_INTENT_DUPLICATE',
        path: `$.routes.${routeId}.mapIntent`,
        message: `路线 ${routeId} 在本 job 里有多条归属意图：不按数组顺序取最后一条，整条路线本轮不执行，需人工核对。`,
        severity: 'error',
        retryable: false,
        relatedIds: [routeId],
      });
      continue;
    }

    if (guarded.has(routeId)) {
      assignments.push({ routeId, action: 'keep', mapId: null, reason: '该路线已有确认几何或锁：普通对账不覆盖' });
      continue;
    }

    intentBranch(intent, routeId, endpoints, assignments, issues);
  }

  return { assignments, issues };
}

function intentBranch(
  intent: BuildRouteIntentV1,
  routeId: string,
  endpoints: Map<string, RouteEndpointMaps>,
  assignments: RouteAssignment[],
  issues: PlanIssue[],
): void {
  const endpoint = endpoints.get(routeId) ?? null;

  if (intent.mapIntent === 'explicit-null') {
    assignments.push({ routeId, action: 'omit', mapId: null, reason: '显式 null：只保留拓扑，不画到任何图上' });
    return;
  }

  if (intent.mapIntent === 'explicit-map') {
    const declared = text(intent.inferredMapId);
    if (declared.length === 0) {
      assignments.push({ routeId, action: 'conflict', mapId: null, reason: '声明了 explicit-map 却没给 mapId' });
      issues.push({
        code: 'ROUTE_INTENT_MAP_MISSING',
        path: `$.routes.${routeId}.inferredMapId`,
        message: `路线 ${routeId} 的归属意图是 explicit-map，但没有给出 mapId：不降级为 omitted，直接报错。`,
        severity: 'error',
        retryable: false,
        relatedIds: [routeId],
      });
      return;
    }
    if (!endpoint) {
      assignments.push({ routeId, action: 'conflict', mapId: null, reason: '端点归图未知，无法核对显式归属' });
      issues.push({
        code: 'ROUTE_ENDPOINTS_UNKNOWN',
        path: `$.routes.${routeId}.endpoints`,
        message: `路线 ${routeId} 的端点当前还不在任何图上：显式归属先挂起，等端点归图完成再对账。`,
        severity: 'warning',
        retryable: true,
        relatedIds: [routeId],
      });
      return;
    }
    const inMap = [endpoint.fromMapId, endpoint.toMapId].filter((id): id is string => id !== null);
    if (inMap.length === 0) {
      assignments.push({ routeId, action: 'conflict', mapId: null, reason: '两端都没有归属图' });
      issues.push({
        code: 'ROUTE_ENDPOINTS_UNMAPPED',
        path: `$.routes.${routeId}.endpoints`,
        message: `路线 ${routeId} 两端都还没有归属图：显式归属无法核对。`,
        severity: 'warning',
        retryable: true,
        relatedIds: [routeId],
      });
      return;
    }
    if (!inMap.every((mapId) => mapId === declared)) {
      assignments.push({ routeId, action: 'conflict', mapId: null, reason: `显式归属 ${declared} 与端点所在图 ${[...new Set(inMap)].join('/')} 不符` });
      issues.push({
        code: 'ROUTE_MAP_INTENT_CONFLICT',
        path: `$.routes.${routeId}.mapIntent`,
        message: `路线 ${routeId} 声明归属 ${declared}，但端点实际在 ${[...new Set(inMap)].join(' / ')}：保留真实拓扑并报冲突，不挪坐标、不跨图拼接。`,
        severity: 'error',
        retryable: false,
        relatedIds: [routeId],
      });
      return;
    }
    assignments.push({ routeId, action: 'assign', mapId: declared, reason: '显式归属与端点一致' });
    return;
  }

  // omitted：由端点决定。
  if (!endpoint) {
    assignments.push({ routeId, action: 'omit', mapId: null, reason: '端点归图未知：先只保留拓扑' });
    return;
  }
  if (endpoint.fromMapId === null || endpoint.toMapId === null) {
    assignments.push({ routeId, action: 'omit', mapId: null, reason: '还有端点没归图：等归图完成后再对账' });
    return;
  }
  if (endpoint.fromMapId !== endpoint.toMapId) {
    assignments.push({ routeId, action: 'omit', mapId: null, reason: `跨图（${endpoint.fromMapId} → ${endpoint.toMapId}）：不拼接局部坐标` });
    issues.push({
      code: 'ROUTE_CROSS_MAP_TOPOLOGY_ONLY',
      path: `$.routes.${routeId}.mapId`,
      message: `路线 ${routeId} 的两端在 ${endpoint.fromMapId} 与 ${endpoint.toMapId} 两张图上：只保留拓扑关系，不在任一张图上画局部线。`,
      severity: 'warning',
      retryable: false,
      relatedIds: [routeId],
    });
    return;
  }
  assignments.push({ routeId, action: 'assign', mapId: endpoint.fromMapId, reason: '两端同图，可绘制归属' });
}

/**
 * 统计口径（§12.4）：同图 owned、跨图 topology-only、历史归属未知**分开算**，不能相加冒充完整。
 */
export function summarizeRouteAssignments(assignments: readonly RouteAssignment[]): {
  owned: number;
  topologyOnly: number;
  kept: number;
  conflicts: number;
  skipped: number;
} {
  let owned = 0;
  let topologyOnly = 0;
  let kept = 0;
  let conflicts = 0;
  let skipped = 0;
  for (const item of assignments) {
    if (item.action === 'assign') owned += 1;
    else if (item.action === 'omit') topologyOnly += 1;
    else if (item.action === 'keep') kept += 1;
    else if (item.action === 'conflict') conflicts += 1;
    else skipped += 1;
  }
  return { owned, topologyOnly, kept, conflicts, skipped };
}
