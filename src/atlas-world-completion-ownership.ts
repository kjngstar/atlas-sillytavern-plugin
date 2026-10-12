/**
 * atlas-world-completion-ownership.ts — P07 / R04：建设完成状态的所属地图解析（共用 resolver）。
 *
 * 铁律：**建设空间任务的完成状态由该地点唯一的 active 容器图持有。**
 * 地点在外部图上的 marker 归属（`locations.map_id`）只说明它当前画在哪张图上，
 * 不说明「它的内部空间建完了没有」。旧实现里读的时候用地点自己的内部图、
 * 写的时候又退回 `firstFocus.map_id`（外部图），于是完成标记落到错误所属图 —— R04 的病灶。
 *
 * 本模块只做只读解析，不写库；`buildSqlWorldCompletionTask`（候选构建）、
 * `atlas-db-repository`（保存时重算）、`summarizeWorldFill`（回执汇总）三处必须共用它，
 * 否则读、写、回报会各按各的口径走。
 */

import type { TableReadPort } from './atlas-ops-compile-types.ts';
import type { PlanIssue } from './atlas-world-contract.ts';

export type CompletionOwner = {
  locationId: string;
  /** 该地点唯一的 active 容器图；无唯一容器图时为 null。 */
  completionMapId: string | null;
  /** true 表示需要先按 sceneMaps / ensureContainerMap 路径创建容器图，再重新解析。 */
  needsContainerMap: boolean;
  issues: PlanIssue[];
};

function asId(value: unknown): string {
  const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  return text.trim();
}

function byId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 位置归一到地点 ID：地点 ID 本身可能就叫 `loc:1`（旧三表导入），因此先认原值再剥前缀。 */
function containerMatches(value: unknown, locationId: string): boolean {
  if (value === null || value === undefined) return false;
  const text = String(value);
  if (text === locationId) return true;
  return text.startsWith('loc:') && text.slice(4) === locationId;
}

function issue(code: string, path: string, message: string, severity: 'warning' | 'error', retryable: boolean, extra: Partial<PlanIssue> = {}): PlanIssue {
  return { code, path, message, severity, retryable, ...extra };
}

/**
 * 逐个焦点地点解析「完成状态所属地图」。
 *
 * - 恰好一张 active 容器图 → 选它；
 * - 多张 → 报容器图冲突，**不挑查询第一张**；
 * - 没有容器图 → `needsContainerMap=true`，由调用方按 sceneMaps / ensureContainerMap 候选路径创建后再调本函数；
 * - 地点不存在 → 明确诊断，不返回 root 图冒充。
 */
export function resolveCompletionMaps(
  tables: TableReadPort,
  branchId: string,
  locationIds: readonly string[],
): CompletionOwner[] {
  const owners: CompletionOwner[] = [];
  const seen = new Set<string>();
  for (const raw of locationIds ?? []) {
    const locationId = asId(raw);
    if (!locationId || seen.has(locationId)) continue;
    seen.add(locationId);

    const location = tables.selectOne('locations', branchId, locationId);
    if (!location) {
      owners.push({
        locationId,
        completionMapId: null,
        needsContainerMap: false,
        issues: [issue(
          'COMPLETION_LOCATION_MISSING',
          `$.focusLocationIds.${locationId}`,
          `焦点地点 ${locationId} 不在本分支中，无法确定完成状态所属图；已跳过，不用根图冒充。`,
          'warning',
          false,
          { locationId },
        )],
      });
      continue;
    }

    const containers = tables.selectWhere('maps', { branch_id: branchId, status: 'active' })
      .filter((map) => containerMatches(map.container_location_id, locationId));

    if (containers.length === 0) {
      owners.push({
        locationId,
        completionMapId: null,
        needsContainerMap: true,
        issues: [issue(
          'COMPLETION_NEEDS_CONTAINER_MAP',
          `$.focusLocationIds.${locationId}`,
          `${locationId} 没有 active 容器图：完成状态应落在它的内部图上。需先按 sceneMaps / ensureContainerMap 路径创建；创建失败则 deferred，不给外部图写 ready。`,
          'warning',
          true,
          { locationId },
        )],
      });
      continue;
    }

    if (containers.length > 1) {
      const ids = containers.map((map) => String(map.id)).sort(byId);
      owners.push({
        locationId,
        completionMapId: null,
        needsContainerMap: false,
        issues: [issue(
          'COMPLETION_CONTAINER_MAP_CONFLICT',
          `$.focusLocationIds.${locationId}`,
          `${locationId} 有 ${ids.length} 张 active 容器图（${ids.join(' / ')}）：完成状态所属图不唯一，不能挑查询第一张；需作者确认后再写。`,
          'error',
          false,
          { locationId, relatedIds: ids },
        )],
      });
      continue;
    }

    owners.push({ locationId, completionMapId: String(containers[0].id), needsContainerMap: false, issues: [] });
  }
  return owners;
}

/** 解析结果里所有唯一的完成状态所属图（稳定排序，便于读写与回执共用同一口径）。 */
export function completionMapIds(owners: readonly CompletionOwner[]): string[] {
  return [...new Set(owners.map((owner) => owner.completionMapId).filter((id): id is string => Boolean(id)))].sort(byId);
}

/** 解析结果里的全部诊断，便于上层原样并入回执/目录。 */
export function completionOwnershipIssues(owners: readonly CompletionOwner[]): PlanIssue[] {
  return owners.flatMap((owner) => owner.issues);
}
