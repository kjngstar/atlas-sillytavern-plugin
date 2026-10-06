/**
 * atlas-task-views.ts — M4/Q06 `kind='tasks'` 只读任务视图。
 *
 * 规则：
 * - 只读 actions / journeys / events 三张实际表，不另造 deliveries 表，不推演未来。
 * - **计划 ≠ 已发生**：`planned=true` 只表示意图；没发生就是 occurredAtS=null，绝不用当前时钟补一个「一楼时间」。
 * - 时间没有依据就 `timeQuality='unknown'` + null，不猜、不插零。
 * - POV 只拿 public 且与主角已知集合相交的条目；后台秘密任务整条不下发。
 */

import { queryBound } from './atlas-db-runtime.ts';
import { estimatedArrival } from './atlas-sim-motion.ts';
import { sqlVisibility } from './atlas-sql-visibility.ts';
import type { ViewContext } from './atlas-db-views.ts';
import type { ViewQuery, ViewResult } from './atlas-ops-contract.ts';

export type TaskTimeQuality = 'confirmed' | 'estimated' | 'unknown';

export type TaskItem = {
  taskId: string;
  kind: 'action' | 'journey' | 'event';
  title: string;
  status: string;
  actorEntityId: string | null;
  targetLocationId: string | null;
  targetEntityId: string | null;
  /** 计划（意图）还是已发生的事实。计划条目 occurredAtS 必为 null。 */
  planned: boolean;
  startAtS: number | null;
  startMinS: number | null;
  startMaxS: number | null;
  etaMinS: number | null;
  etaMaxS: number | null;
  occurredAtS: number | null;
  timeQuality: TaskTimeQuality;
  reasonCode: string | null;
};

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

export function queryTasks(ctx: ViewContext, query: ViewQuery): ViewResult {
  if (typeof query.revision === 'number' && query.revision !== ctx.revision) {
    return {
      branchId: ctx.branchId,
      revision: ctx.revision,
      items: [],
      metadata: { stale: true, requestedRevision: query.revision, currentRevision: ctx.revision },
    };
  }

  const branch = queryBound(ctx.db, 'SELECT clock_s FROM branches WHERE id = ?', [ctx.branchId])[0] as Record<string, unknown> | undefined;
  const clock = num(branch?.clock_s) ?? 0;
  const visibility = sqlVisibility(ctx);
  const isPov = ctx.viewMode === 'pov';
  const actor = typeof query.entityId === 'string' && query.entityId ? query.entityId : null;
  const statusFilter = typeof query.status === 'string' && query.status ? query.status : null;
  const items: TaskItem[] = [];

  const knownActor = (id: string | null): boolean => !isPov || (id !== null && (id === visibility.povId || visibility.knownCharacters.has(id)));
  const knownPlace = (id: string | null): boolean => !isPov || id === null || visibility.knownLocations.has(id);

  /* —— actions：NPC 计划 / 待执行 —— */
  const actionParams: Array<string | number | null> = [ctx.branchId];
  let actionSql = "SELECT * FROM actions WHERE branch_id = ?";
  if (actor) {
    actionSql += ' AND actor_entity_id = ?';
    actionParams.push(actor);
  }
  for (const raw of queryBound(ctx.db, actionSql, actionParams)) {
    const row = raw as Record<string, unknown>;
    const status = String(row.status ?? '');
    if (status === 'cancelled') continue;
    if (statusFilter && status !== statusFilter) continue;
    const actorId = str(row.actor_entity_id);
    const targetLocationId = str(row.target_location_id);
    if (!knownActor(actorId) || !knownPlace(targetLocationId)) continue;
    if (isPov && String(row.secrecy ?? 'restricted') !== 'public') continue;
    const startAt = num(row.started_at_s);
    const planned = status === 'planned' || status === 'pending' || startAt === null;
    items.push({
      taskId: String(row.id),
      kind: 'action',
      title: String(row.title ?? row.kind ?? ''),
      status,
      actorEntityId: actorId,
      targetLocationId,
      targetEntityId: str(row.target_entity_id),
      planned,
      startAtS: startAt,
      startMinS: num(row.earliest_start_s),
      startMaxS: num(row.deadline_s),
      etaMinS: num(row.next_check_s),
      etaMaxS: num(row.deadline_s),
      occurredAtS: num(row.finished_at_s),
      timeQuality: startAt !== null ? 'confirmed' : num(row.earliest_start_s) !== null ? 'estimated' : 'unknown',
      reasonCode: str(row.reason_code),
    });
  }

  /* —— journeys：在途 / 停留 / 改道 —— */
  const journeyParams: Array<string | number | null> = [ctx.branchId];
  let journeySql = 'SELECT * FROM journeys WHERE branch_id = ?';
  if (actor) {
    journeySql += ' AND mover_entity_id = ?';
    journeyParams.push(actor);
  }
  for (const raw of queryBound(ctx.db, journeySql, journeyParams)) {
    const row = raw as Record<string, unknown>;
    const status = String(row.status ?? '');
    if (status === 'cancelled') continue;
    if (statusFilter && status !== statusFilter) continue;
    const mover = str(row.mover_entity_id);
    const destination = str(row.destination_location_id);
    if (!knownActor(mover) || !knownPlace(destination)) continue;
    const eta = estimatedArrival(row, clock);
    const startAt = num(row.started_at_s);
    items.push({
      taskId: String(row.id),
      kind: 'journey',
      title: `前往 ${destination ?? '未知地点'}`,
      status,
      actorEntityId: mover,
      targetLocationId: destination,
      targetEntityId: null,
      planned: status === 'planned' || startAt === null,
      startAtS: startAt,
      startMinS: startAt,
      startMaxS: startAt,
      etaMinS: eta.minS ?? num(row.estimated_arrival_min_s),
      etaMaxS: eta.maxS ?? num(row.estimated_arrival_max_s),
      occurredAtS: num(row.arrived_at_s),
      timeQuality: status === 'blocked' ? 'unknown' : eta.quality === 'unknown' ? 'unknown' : startAt !== null ? 'confirmed' : 'estimated',
      reasonCode: str(row.stop_reason),
    });
  }

  /* —— events：已发生 / 已排期 —— */
  const eventParams: Array<string | number | null> = [ctx.branchId];
  let eventSql = 'SELECT * FROM events WHERE branch_id = ?';
  if (actor) {
    eventSql += ' AND (subject_entity_id = ? OR participants_json LIKE ?)';
    eventParams.push(actor, `%"${actor}"%`);
  }
  for (const raw of queryBound(ctx.db, eventSql, eventParams)) {
    const row = raw as Record<string, unknown>;
    const status = String(row.status ?? '');
    if (status === 'cancelled') continue;
    if (statusFilter && status !== statusFilter) continue;
    const locationId = str(row.location_id);
    const subjectId = str(row.subject_entity_id);
    if (!knownPlace(locationId) || !knownActor(subjectId)) continue;
    if (isPov && String(row.secrecy ?? 'restricted') !== 'public') continue;
    const occurredAt = num(row.occurred_at_s);
    items.push({
      taskId: String(row.id),
      kind: 'event',
      title: String(row.title ?? row.kind ?? ''),
      status,
      actorEntityId: subjectId,
      targetLocationId: locationId,
      targetEntityId: str(row.route_id),
      planned: occurredAt === null,
      startAtS: num(row.scheduled_start_s),
      startMinS: num(row.scheduled_start_s),
      startMaxS: num(row.scheduled_start_s),
      etaMinS: null,
      etaMaxS: null,
      occurredAtS: occurredAt,
      timeQuality: occurredAt !== null ? 'confirmed' : num(row.scheduled_start_s) !== null ? 'estimated' : 'unknown',
      reasonCode: str(row.outcome),
    });
  }

  return {
    branchId: ctx.branchId,
    revision: ctx.revision,
    items,
    metadata: {
      viewMode: ctx.viewMode ?? 'author',
      clockS: clock,
      actorEntityId: actor,
      status: statusFilter,
      plannedCount: items.filter((t) => t.planned).length,
      occurredCount: items.filter((t) => !t.planned).length,
      unknownTimeCount: items.filter((t) => t.timeQuality === 'unknown').length,
    },
  };
}
