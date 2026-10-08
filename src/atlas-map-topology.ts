/**
 * atlas-map-topology.ts — 地图包含关系的纯函数解析（M2-01，依据 02 §3）。
 *
 * 固定纪律：
 * - 输入只有 branchId / rootMapId / maps / locations，**不接收 UI 状态**，不写数据库。
 * - 地图归属只由「容器地点 + 地点父链」推导；**不看 `location.map_id`**。
 *   所以 `location.map_id` 变化（例如跨图迁移）不影响包含导航（验收 T01）。
 * - 输出 `parentMapId` 是本次解析结果，**不在 maps 上加永久重复权威列**。
 * - 找不到可用祖先时只在**输出**上挂根图并标 `unclassified`，绝不把 SQL parent 改成 root。
 * - 载具（mobility=mobile）优先有效当前停靠（anchor_location_id）的内部图，标 `anchored`。
 * - 所有节点按 mapId 稳定排序，每个地图恰好出现一次（T03：可达一次，或在 unlinked）。
 */

import type {
  ConnectionQuality,
  MapTopology,
  PlanIssue,
  TopologyInput,
  TopologyLocation,
  TopologyMap,
} from './atlas-world-contract.ts';

const ACTIVE = 'active';
/** 兜底父边上限；调用方应传入 ATLAS_RUNTIME_LIMITS.locationDepth。 */
const DEFAULT_MAX_DEPTH = 12;

function topologyIssue(
  code: string,
  message: string,
  severity: PlanIssue['severity'],
  extra: Partial<PlanIssue> = {},
): PlanIssue {
  return { code, path: '$.topology', message, severity, retryable: false, ...extra };
}

/** 单张地图的归属解析结果。 */
type Resolved = { parentMapId: string | null; quality: ConnectionQuality };

/**
 * 从地点父链解析地图导航父子关系。
 * 纯函数：不写 DB、不调用模型、不依赖 map_id 决定永久父级。
 */
export function resolveMapTopology(input: TopologyInput): MapTopology {
  const issues: PlanIssue[] = [];
  const maxDepth =
    Number.isFinite(input.maxDepth) && input.maxDepth > 0 ? Math.floor(input.maxDepth) : DEFAULT_MAX_DEPTH;

  // ── 1. 只取本分支的 active 地点与 active 地图（重复 id 取首次出现）──────
  const locationsById = new Map<string, TopologyLocation>();
  for (const location of input.locations) {
    if (location.branchId !== input.branchId || location.status !== ACTIVE) continue;
    if (!locationsById.has(location.id)) locationsById.set(location.id, location);
  }
  const mapsById = new Map<string, TopologyMap>();
  for (const map of input.maps) {
    if (map.branchId !== input.branchId || map.status !== ACTIVE) continue;
    if (!mapsById.has(map.id)) mapsById.set(map.id, map);
  }
  const mapIds = [...mapsById.keys()].sort();

  // ── 2. container location → 内部地图（多值索引，保留全部 ID 以便报歧义）──
  const mapsByContainer = new Map<string, string[]>();
  for (const mapId of mapIds) {
    const container = mapsById.get(mapId)!.containerLocationId;
    if (!container) continue;
    const list = mapsByContainer.get(container);
    if (list) list.push(mapId);
    else mapsByContainer.set(container, [mapId]);
  }

  const unlinked = new Set<string>();
  /** 同一份坏图问题只报一次，避免多张地图重复刷屏。 */
  const reported = new Set<string>();

  function report(
    code: string,
    key: string,
    message: string,
    severity: PlanIssue['severity'] = 'error',
    extra: Partial<PlanIssue> = {},
  ): void {
    if (reported.has(key)) return;
    reported.add(key);
    issues.push(topologyIssue(code, message, severity, extra));
  }

  /**
   * 某地点作为容器时对应的**唯一**内部地图。
   * 重复容器不随机取第一项：全部列入 unlinked 并把全部 ID 报出来。
   */
  function soleContainerMap(locationId: string, selfMapId: string): string | null {
    const list = mapsByContainer.get(locationId);
    if (!list || list.length === 0) return null;
    if (list.length > 1) {
      for (const id of list) if (id !== selfMapId) unlinked.add(id);
      report(
        'AMBIGUOUS_CONTAINER_MAP',
        `ambiguous:${locationId}`,
        `地点 ${locationId} 被 ${list.length} 张地图当作容器：不随机取第一项，全部列入未挂接`,
        'error',
        { locationId, relatedIds: [...list] },
      );
      return null;
    }
    const only = list[0];
    // 唯一内部图就是正在解析的这张 → 容器与内图互相引用成环。
    if (only === selfMapId) return null;
    return only;
  }

  // ── 3. 根图（多根只报问题，不假造唯一根）────────────────────────────
  // container_location_id IS NULL 的 active 地图即「候选根」。
  const nullContainerIds = mapIds.filter((id) => !mapsById.get(id)!.containerLocationId);
  const designatedRoot = input.rootMapId && mapsById.has(input.rootMapId) ? input.rootMapId : null;

  if (input.rootMapId && !designatedRoot) {
    report(
      'ROOT_MAP_MISSING',
      `root:${input.rootMapId}`,
      `根图 ${input.rootMapId} 不是本分支的 active 地图：不假造根图，相关地图列为未挂接`,
      'error',
      { mapId: input.rootMapId, relatedIds: [...nullContainerIds] },
    );
  }
  if (nullContainerIds.length > 1) {
    // 多根不一定致命（可能合法多顶图），但有指定根时其余顶图归属不明 → warning。
    const extraRoot = nullContainerIds.find((id) => id !== designatedRoot) ?? null;
    report(
      'MULTIPLE_ROOT_MAPS',
      'roots',
      `本分支有 ${nullContainerIds.length} 张无容器顶图：只按 ${designatedRoot ?? '首个顶图'} 作回落根，其余顶图按自身为根单独列出`,
      designatedRoot ? 'warning' : 'error',
      { mapId: extraRoot ?? undefined, relatedIds: [...nullContainerIds] },
    );
  }
  if (nullContainerIds.length === 0 && !designatedRoot) {
    report('ROOT_MAP_MISSING', 'root:none', '分支没有根图：所有地图只能单独列出，不猜根');
  }

  // 回落锚点：优先指定根，否则唯一顶图，否则无。
  const fallbackRootId = designatedRoot ?? (nullContainerIds.length === 1 ? nullContainerIds[0] : null);

  // ── 4. 逐图解析 ────────────────────────────────────────────────────
  function resolveMap(mapId: string, map: TopologyMap): Resolved {
    const containerId = map.containerLocationId;
    if (!containerId) {
      report('MAP_CONTAINER_MISSING', `container:${mapId}`, `地图 ${mapId} 没有容器地点：无法确定归属`, 'error', {
        mapId,
      });
      return { parentMapId: null, quality: 'invalid' };
    }
    const container = locationsById.get(containerId);
    if (!container) {
      report(
        'CONTAINER_LOCATION_MISSING',
        `containerMissing:${mapId}`,
        `地图 ${mapId} 的容器地点 ${containerId} 不存在或不是 active：不猜归属`,
        'error',
        { mapId, locationId: containerId },
      );
      return { parentMapId: null, quality: 'invalid' };
    }
    // 容器地点直接挂了不止一张 active 地图 → 归属歧义，不随机取第一项。
    const siblings = mapsByContainer.get(containerId) ?? [];
    if (siblings.length > 1) {
      for (const id of siblings) unlinked.add(id);
      report(
        'AMBIGUOUS_CONTAINER_MAP',
        `ambiguous:${containerId}`,
        `地点 ${containerId} 被 ${siblings.length} 张地图当作容器：不随机取第一项，全部列入未挂接`,
        'error',
        { mapId, locationId: containerId, relatedIds: [...siblings] },
      );
      return { parentMapId: null, quality: 'invalid' };
    }
    // 容器地点自身就登记在本图内 → 自容器循环。
    if (container.mapId === mapId) {
      report(
        'MAP_SELF_CONTAINED',
        `self:${mapId}`,
        `地图 ${mapId} 的容器地点 ${containerId} 自身位于该图内：自容器循环，拒绝挂接`,
        'error',
        { mapId, locationId: containerId },
      );
      return { parentMapId: null, quality: 'invalid' };
    }

    // 4a. 载具：优先有效当前停靠的内部图（标 anchored）。
    if (container.mobility === 'mobile' && container.anchorLocationId) {
      const anchorId = container.anchorLocationId;
      if (!locationsById.has(anchorId)) {
        report(
          'ANCHOR_LOCATION_MISSING',
          `anchor:${mapId}`,
          `载具容器 ${containerId} 的停靠 ${anchorId} 不存在或不是 active：本次按结构父链回落`,
          'warning',
          { mapId, locationId: anchorId },
        );
      } else {
        const anchorMap = soleContainerMap(anchorId, mapId);
        if (anchorMap && anchorMap !== mapId) return { parentMapId: anchorMap, quality: 'anchored' };
      }
    }

    // 4b. 沿容器地点的 parent_location_id 向上找最近拥有内部图的祖先。
    let cursor: TopologyLocation = container;
    const seen = new Set<string>([container.id]);
    let depth = 0;
    while (cursor.parentLocationId) {
      depth += 1;
      if (depth > maxDepth) {
        report(
          'LOCATION_DEPTH_LIMIT',
          `depth:${container.id}`,
          `地图 ${mapId} 的容器父链超过 ${maxDepth} 条父边：拒绝继续深挖，不无限上溯`,
          'error',
          { mapId, locationId: container.id, relatedIds: [...seen] },
        );
        return { parentMapId: null, quality: 'invalid' };
      }
      const parentId = cursor.parentLocationId;
      if (seen.has(parentId)) {
        report('LOCATION_PARENT_CYCLE', `cycle:${container.id}`, `地点父链成环（回到 ${parentId}）：不无限上溯`, 'error', {
          locationId: parentId,
          mapId,
          relatedIds: [...seen],
        });
        return { parentMapId: null, quality: 'invalid' };
      }
      const parent = locationsById.get(parentId);
      if (!parent) {
        report(
          'LOCATION_PARENT_MISSING',
          `parentMissing:${mapId}`,
          `地图 ${mapId} 的容器 ${container.id} 上溯到不存在的父地点 ${parentId}：不猜归属`,
          'error',
          { mapId, locationId: parentId },
        );
        return { parentMapId: null, quality: 'invalid' };
      }
      seen.add(parentId);
      const parentMap = soleContainerMap(parentId, mapId);
      if (parentMap && parentMap !== mapId) return { parentMapId: parentMap, quality: 'contained' };
      cursor = parent;
    }

    // 4c. 没有可用祖先：有回落根则只在输出上挂根，绝不改 SQL parent。
    if (fallbackRootId && fallbackRootId !== mapId) {
      return { parentMapId: fallbackRootId, quality: 'unclassified' };
    }
    report('MAP_UNLINKED', `unlinked:${mapId}`, `地图 ${mapId} 找不到可用祖先且没有可用根图：列入未挂接`, 'error', {
      mapId,
    });
    return { parentMapId: null, quality: 'invalid' };
  }

  const nodes: MapTopology['nodes'] = [];
  for (const mapId of mapIds) {
    const map = mapsById.get(mapId)!;
    if (!map.containerLocationId) {
      // 无容器顶图本身即根；多个顶图各自成根，不互相挂接。
      nodes.push({
        mapId,
        containerLocationId: null,
        parentMapId: null,
        connectionQuality: 'root',
      });
      continue;
    }
    const resolved = resolveMap(mapId, map);
    if (resolved.quality === 'invalid') unlinked.add(mapId);
    nodes.push({
      mapId,
      containerLocationId: map.containerLocationId,
      parentMapId: resolved.parentMapId,
      connectionQuality: resolved.quality,
    });
  }

  // 已指定回落根（或只有唯一顶图）时，其余顶图归属不明 → 也报进 unlinked，
  // 保证「每张图要么可达一次、要么在 unlinked」这条断言对所有坏图成立。
  // 若本身就是多顶图且没有任何指定根，则它们各自成根，不塞进未挂接。
  if (nullContainerIds.length > 1 && fallbackRootId) {
    for (const id of nullContainerIds) if (id !== fallbackRootId) unlinked.add(id);
  }

  return {
    nodes,
    rootMapIds: [...nullContainerIds].sort(),
    unlinkedMapIds: [...unlinked].sort(),
    issues,
  };
}
