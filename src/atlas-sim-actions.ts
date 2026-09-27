/**
 * atlas-sim-actions.ts — F08：行动计划推进与停止（§4.3 / §9.1 / §9.6）。
 *
 * 固定行为：
 * - 状态机 `planned → ready → active → completed`，另有 `paused`（明确暂停条件）、
 *   `blocked`（条件不成立）与 `cancelled`（停用/死亡等）；`completed/cancelled` 离开调度索引。
 * - 触发条件用 `collectConditionLeaves` 的同一套叶子语义求值（`evaluateCondition`，本文件导出，
 *   F03 路线通行条件与 F14 资格检查复用）。
 * - **一人主行动时间不双计**（§4.3）：每个 actor 在同一窗口里只有**一个**占用主要行动时间的 active
 *   行动累计 `progress_s`；被动能力（payload.passive=true）并行累计但不抢占主行动；第二个非被动 active
 *   行动本窗口不推进并记 ACTION_TIME_SHARED。所有已处理行动的 `evaluated_until_s` 都推进到窗口终点，
 *   这样时间不会被下一次窗口重新计入。
 * - `Δt = 0` 不完成任何耗时步骤；未知 duration 不自动当成 0，也不偷偷完成（记 DURATION_UNKNOWN）。
 * - `kind='travel'` 的进度由 journeys 推动，本函数不重复累加路程时间。
 * - `haltActorWork`：死亡/失去行动能力的人不再走路——取消其未结束行动与开放行程，
 *   **保留最后已知位置**，不伪造新地点（§7.6 / §12）。
 *
 * 纯程序层：不调用模型、不使用 `Math.random`/`Date.now()`；时间由调用方传入。
 * `advanceActions` 只**返回**要写入的行（含 row_rev/updated_turn_id），由事务层持久化。
 */

import { queryBound, runBound } from './atlas-db-runtime.ts';
import { decodeRow } from './atlas-db-codec.ts';
import { tableColumnNames } from './atlas-db-schema.ts';
import { ATLAS_RUNTIME_LIMITS } from './atlas-runtime-limits.ts';
import { resolveEffectivePosition } from './atlas-sim-position.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { Issue } from './atlas-ops-contract.ts';

export type ConditionWorld = { db: SqlDatabase; branchId: string };

export type ConditionResult = { ok: boolean; reasons: string[]; atS: number | null };

const CONDITION_DEPTH = ATLAS_RUNTIME_LIMITS.conditionDepth;
const CONTAINER_DEPTH = ATLAS_RUNTIME_LIMITS.containerDepth;

/** §5.1 events.kind 与 actions.kind 的固定映射（程序补齐，不让标题决定 occurred）。 */
const EVENT_KIND_BY_ACTION: Record<string, string> = {
  prepare: 'other',
  travel: 'passage',
  wait: 'other',
  interact: 'incident',
  transmit: 'communication',
  investigate: 'discovery',
  act: 'incident',
  goal: 'other',
};

const BELIEF_RANK: Record<string, number> = { rejected: 0, heard: 1, doubted: 2, believed: 3, verified: 4 };

function issue(code: string, path: string, message: string, severity: 'warning' | 'error' = 'warning'): Issue {
  return { code, path, message, severity, retryable: false };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (isPlainObject(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function decodeOrNull(table: string, row: Record<string, unknown>): Record<string, unknown> | null {
  const decoded = decodeRow(table as never, row, { allowExtra: true });
  return decoded.ok ? (decoded.row as Record<string, unknown>) : null;
}

function loadRow(world: ConditionWorld, table: string, id: string): Record<string, unknown> | null {
  const rows = queryBound(world.db, `SELECT * FROM ${table} WHERE branch_id = ? AND id = ? LIMIT 1`, [world.branchId, id]);
  return rows.length > 0 ? decodeOrNull(table, rows[0]) : null;
}

/* —— 条件求值（F03/F08/F14 共用）—— */

function leafResult(ok: boolean, reason: string | null, atS: number | null): ConditionResult {
  return { ok, reasons: ok || !reason ? [] : [reason], atS: ok ? atS : null };
}

function heldBy(world: ConditionWorld, actorId: string, itemId: string): boolean {
  let cursor: string | null = itemId;
  const seen = new Set<string>();
  for (let depth = 0; cursor && depth <= CONTAINER_DEPTH; depth += 1) {
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    const item = loadRow(world, 'items', cursor);
    if (!item) return false;
    if (str(item.holder_character_id) === actorId) return true;
    cursor = str(item.container_item_id);
  }
  return false;
}

function actorLocation(world: ConditionWorld, actorId: string): string | null {
  const position = resolveEffectivePosition({ db: world.db, branchId: world.branchId }, actorId);
  if (position.kind === 'at_location') return position.locationId;
  const row = loadRow(world, 'characters', actorId) ?? loadRow(world, 'locations', actorId);
  return row ? str(row.location_id) : null;
}

function entityStatusMatches(world: ConditionWorld, entityId: string, expected: string): boolean {
  for (const table of ['characters', 'locations', 'items', 'factions']) {
    const row = loadRow(world, table, entityId);
    if (!row) continue;
    return String(row.status ?? '') === expected || String(row.physical_status ?? '') === expected;
  }
  return false;
}

function eventAtS(row: Record<string, unknown> | null): number | null {
  if (!row) return null;
  return num(row.occurred_at_s) ?? num(row.scheduled_start_s) ?? num(row.ended_at_s);
}

/**
 * §2.4 Condition 求值：`all` / `any` / 九种叶子；深度上限 4。
 * 未知条件按**不成立**处理（条件不满足不能自动成功，§16.6），并给出具体 reason。
 * `atS` 是条件成立时刻的下界估计（用于 wait 行动与 accrual 起点），无法判断时为 null。
 */
export function evaluateCondition(
  world: ConditionWorld,
  condition: unknown,
  opts: { clockS: number; actorId?: string | null },
): ConditionResult {
  const clockS = num(opts?.clockS) ?? 0;
  const actorId = opts?.actorId ?? null;

  const walk = (node: unknown, depth: number): ConditionResult => {
    if (depth > CONDITION_DEPTH) return leafResult(false, 'CONDITION_DEPTH_EXCEEDED', null);
    if (node === null || node === undefined) return { ok: true, reasons: [], atS: null };
    if (!isPlainObject(node)) return leafResult(false, 'CONDITION_INVALID', null);
    const keys = Object.keys(node);
    if (keys.length === 0) return { ok: true, reasons: [], atS: null };

    if (Array.isArray(node.all)) {
      const results = (node.all as unknown[]).map((child) => walk(child, depth + 1));
      const ok = results.every((r) => r.ok);
      if (!ok) return { ok: false, reasons: results.flatMap((r) => r.reasons), atS: null };
      const times = results.map((r) => r.atS).filter((t): t is number => t !== null);
      return { ok: true, reasons: [], atS: times.length > 0 ? Math.max(...times) : null };
    }
    if (Array.isArray(node.any)) {
      const results = (node.any as unknown[]).map((child) => walk(child, depth + 1));
      const ok = results.some((r) => r.ok);
      if (!ok) return { ok: false, reasons: results.flatMap((r) => r.reasons), atS: null };
      const times = results.filter((r) => r.ok).map((r) => r.atS).filter((t): t is number => t !== null);
      return { ok: true, reasons: [], atS: times.length > 0 ? Math.min(...times) : null };
    }

    const kind = keys[0] as string;
    const body = isPlainObject(node[kind]) ? (node[kind] as Record<string, unknown>) : {};
    const actor = str(body.actor_ref) ?? actorId;

    switch (kind) {
      case 'time_at_or_after': {
        const s = num(body.s);
        if (s === null) return leafResult(false, 'CONDITION_FIELD_MISSING:time_at_or_after.s', null);
        return leafResult(clockS >= s, `TIME_BEFORE:${s}`, s);
      }
      case 'at_location': {
        const locationId = str(body.location_ref);
        if (!actor || !locationId) return leafResult(false, 'CONDITION_FIELD_MISSING:at_location', null);
        return leafResult(actorLocation(world, actor) === locationId, `NOT_AT_LOCATION:${actor}->${locationId}`, null);
      }
      case 'event_status': {
        const eventId = str(body.event_ref);
        if (!eventId) return leafResult(false, 'CONDITION_FIELD_MISSING:event_status.event_ref', null);
        const event = loadRow(world, 'events', eventId);
        if (!event) return leafResult(false, `EVENT_UNKNOWN:${eventId}`, null);
        const expected = Array.isArray(body.status) ? body.status.map(String) : [String(body.status ?? '')];
        return leafResult(expected.includes(String(event.status)), `EVENT_STATUS:${eventId}=${String(event.status)}`, eventAtS(event));
      }
      case 'knows': {
        const informationId = str(body.information_ref);
        if (!actor || !informationId) return leafResult(false, 'CONDITION_FIELD_MISSING:knows', null);
        const rows = queryBound(
          world.db,
          `SELECT * FROM knowledge WHERE branch_id = ? AND information_id = ? AND status <> 'forgotten' AND (knower_character_id = ? OR is_pov = 1) LIMIT 1`,
          [world.branchId, informationId, actor],
        );
        if (rows.length === 0) return leafResult(false, `NOT_KNOWN:${actor}->${informationId}`, null);
        const row = decodeOrNull('knowledge', rows[0]) ?? {};
        const minRank = BELIEF_RANK[String(body.min_belief ?? 'heard')] ?? 1;
        const actual = BELIEF_RANK[String(row.belief ?? 'heard')] ?? 1;
        return leafResult(actual >= minRank, `BELIEF_TOO_LOW:${String(row.belief)}`, num(row.first_received_at_s));
      }
      case 'has_item': {
        const itemId = str(body.item_ref);
        if (!actor || !itemId) return leafResult(false, 'CONDITION_FIELD_MISSING:has_item', null);
        return leafResult(heldBy(world, actor, itemId), `ITEM_NOT_HELD:${actor}->${itemId}`, null);
      }
      case 'action_status': {
        const actionId = str(body.action_ref);
        if (!actionId) return leafResult(false, 'CONDITION_FIELD_MISSING:action_status.action_ref', null);
        const row = loadRow(world, 'actions', actionId);
        if (!row) return leafResult(false, `ACTION_UNKNOWN:${actionId}`, null);
        const expected = Array.isArray(body.status) ? body.status.map(String) : [String(body.status ?? '')];
        return leafResult(expected.includes(String(row.status)), `ACTION_STATUS:${actionId}=${String(row.status)}`, num(row.finished_at_s));
      }
      case 'entity_status': {
        const entityId = str(body.entity_ref);
        if (!entityId) return leafResult(false, 'CONDITION_FIELD_MISSING:entity_status.entity_ref', null);
        return leafResult(entityStatusMatches(world, entityId, String(body.status ?? '')), `ENTITY_STATUS:${entityId}`, null);
      }
      case 'capability': {
        const key = str(body.key);
        if (!actor || !key) return leafResult(false, 'CONDITION_FIELD_MISSING:capability', null);
        const row = loadRow(world, 'characters', actor) ?? loadRow(world, 'factions', actor);
        const capabilities = asArray(row?.capabilities_json).filter(isPlainObject);
        return leafResult(capabilities.some((c) => str(c.key) === key), `CAPABILITY_MISSING:${key}`, null);
      }
      case 'event_match': {
        const eventKind = str(body.kind);
        if (!eventKind) return leafResult(false, 'CONDITION_FIELD_MISSING:event_match.kind', null);
        const params: Array<string | number | null> = [world.branchId, eventKind];
        let sql = "SELECT * FROM events WHERE branch_id = ? AND kind = ? AND status IN ('ongoing','occurred')";
        const subject = str(body.subject_ref);
        if (subject) {
          sql += ' AND subject_entity_id = ?';
          params.push(subject);
        }
        const place = str(body.place_ref);
        if (place) {
          sql += ' AND location_id = ?';
          params.push(place);
        }
        sql += ' ORDER BY COALESCE(occurred_at_s, scheduled_start_s) LIMIT 1';
        const rows = queryBound(world.db, sql, params);
        if (rows.length === 0) return leafResult(false, `EVENT_MATCH_NONE:${eventKind}`, null);
        return leafResult(true, null, eventAtS(decodeOrNull('events', rows[0])));
      }
      default:
        return leafResult(false, `CONDITION_UNSUPPORTED:${kind}`, null);
    }
  };

  const result = walk(condition, 0);
  return { ok: result.ok, reasons: [...new Set(result.reasons)], atS: result.atS };
}

/** `next_check_s` 调度索引：只对 `time_at_or_after` 能给出确切时间；未知触发时间为空（§4.3）。 */
export function nextTriggerTime(condition: unknown, afterS: number): number | null {
  if (!isPlainObject(condition)) return null;
  const times: number[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > CONDITION_DEPTH || !isPlainObject(node)) return;
    if (Array.isArray(node.all) || Array.isArray(node.any)) {
      for (const child of (node.all ?? node.any) as unknown[]) walk(child, depth + 1);
      return;
    }
    const body = isPlainObject(node.time_at_or_after) ? (node.time_at_or_after as Record<string, unknown>) : null;
    if (body) {
      const s = num(body.s);
      if (s !== null && s > afterS) times.push(s);
    }
  };
  walk(condition, 0);
  return times.length > 0 ? Math.min(...times) : null;
}

/* —— F08 advanceActions —— */

export type ActionsWorld = {
  db: SqlDatabase;
  branchId: string;
  makeId: (...args: never[]) => string;
  turnId: string;
};

const OPEN_STATUSES = "('planned','ready','active','paused','blocked')";

function statusRank(status: string): number {
  return { active: 0, ready: 1, paused: 2, blocked: 3, planned: 4 }[status] ?? 5;
}

function priorityRank(priority: string): number {
  return { high: 0, normal: 1, low: 2 }[priority] ?? 3;
}

function isPassive(action: Record<string, unknown>): boolean {
  const payload = asObject(action.payload_json);
  return payload?.passive === true;
}

function completionEvent(
  world: ActionsWorld,
  action: Record<string, unknown>,
  atS: number,
  makeId: (kind: string, opId: string, alias: string) => string,
): Record<string, unknown> {
  const actorId = String(action.actor_entity_id ?? '');
  const title = str(action.title) ?? '';
  return {
    branch_id: world.branchId,
    id: makeId('event', String(action.id ?? ''), 'action_done'),
    row_rev: 1,
    created_turn_id: world.turnId,
    updated_turn_id: world.turnId,
    title: title !== '' ? `${title}（完成）` : '行动完成',
    kind: EVENT_KIND_BY_ACTION[String(action.kind ?? '')] ?? 'other',
    summary: str(action.intent) ?? title,
    location_id: str(action.target_location_id),
    route_id: null,
    route_progress_m: null,
    subject_entity_id: actorId !== '' ? actorId : null,
    participants_json: JSON.stringify(actorId !== '' ? [{ entity_id: actorId, role: 'actor' }] : []),
    cause_action_id: str(action.id),
    parent_event_id: null,
    scheduled_start_s: null,
    trigger_json: null,
    occurred_at_s: atS,
    ended_at_s: null,
    outcome: '',
    secrecy: String(action.secrecy ?? 'restricted'),
    status: 'occurred',
  };
}

/**
 * F08：窗口内推进计划与行动。
 * 返回**要写入**的 action 行（完整列 + row_rev 已加 1）与新建的 event 行（JSON 列已是 TEXT），
 * 由调用方放进同一个原子组提交。
 */
export function advanceActions(
  window: { fromS: number; untilS: number },
  world: ActionsWorld,
): { actions: Array<Record<string, unknown>>; events: Array<Record<string, unknown>>; issues: Issue[] } {
  const fromS = num(window?.fromS) ?? 0;
  const untilS = num(window?.untilS) ?? fromS;
  const makeId = world.makeId as unknown as (kind: string, opId: string, alias: string) => string;
  const issues: Issue[] = [];
  const events: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];

  const rows: Array<Record<string, unknown>> = [];
  for (const raw of queryBound(world.db, `SELECT * FROM actions WHERE branch_id = ? AND status IN ${OPEN_STATUSES}`, [world.branchId])) {
    const decoded = decodeOrNull('actions', raw);
    if (decoded) rows.push(decoded);
  }
  rows.sort((a, b) => {
    const byStatus = statusRank(String(a.status)) - statusRank(String(b.status));
    if (byStatus !== 0) return byStatus;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  });

  const byId = new Map<string, Record<string, unknown>>();
  for (const row of rows) byId.set(String(row.id), row);

  // 每个 actor 只能有一个占用主要行动时间的 active 行动（§4.3）；travel 行动同样占用主时间
  // （它的进度由 journeys 推动，见下面的分支），因此也登记进主行动表。
  const mainAssigned = new Map<string, string>();
  const activeRows = rows.filter((r) => String(r.status) === 'active');
  const sortByPriority = (a: Record<string, unknown>, b: Record<string, unknown>): number => {
    const byPriority = priorityRank(String(a.priority)) - priorityRank(String(b.priority));
    if (byPriority !== 0) return byPriority;
    return String(a.id) < String(b.id) ? -1 : 1;
  };
  for (const row of activeRows.filter((r) => String(r.kind) !== 'travel' && !isPassive(r)).sort(sortByPriority)) {
    const actor = String(row.actor_entity_id);
    if (!mainAssigned.has(actor)) mainAssigned.set(actor, String(row.id));
  }
  for (const row of activeRows.filter((r) => String(r.kind) === 'travel').sort(sortByPriority)) {
    const actor = String(row.actor_entity_id);
    if (!mainAssigned.has(actor)) mainAssigned.set(actor, String(row.id));
  }

  const actorCache = new Map<string, Record<string, unknown> | null>();
  const actorRow = (actorId: string): Record<string, unknown> | null => {
    if (!actorCache.has(actorId)) actorCache.set(actorId, loadRow(world, 'characters', actorId));
    return actorCache.get(actorId) ?? null;
  };

  for (const row of rows) {
    const actionId = String(row.id);
    const actorId = String(row.actor_entity_id ?? '');
    const kind = String(row.kind ?? '');
    const payload = asObject(row.payload_json) ?? {};
    const trigger = asObject(row.trigger_json);
    const evaluated = num(row.evaluated_until_s) ?? 0;
    const startFloor = Math.max(fromS, evaluated);

    const condition = trigger ? evaluateCondition(world, trigger, { clockS: untilS, actorId }) : { ok: true, reasons: [], atS: null };
    const dependencies = asArray(row.depends_on_json).filter((d): d is string => typeof d === 'string');
    const pendingDeps = dependencies.filter((dep) => String(byId.get(dep)?.status ?? '') !== 'completed');
    const actor = actorRow(actorId);
    const physical = actor ? String(actor.physical_status ?? 'unknown') : 'unknown';
    const able = physical !== 'dead' && physical !== 'incapacitated';

    let status = String(row.status ?? 'planned');
    let reasonCode = row.reason_code === null || row.reason_code === undefined ? null : String(row.reason_code);
    let nextCheck = num(row.next_check_s);
    let startedAt = num(row.started_at_s);
    let finishedAt = num(row.finished_at_s);
    let resultEventId = str(row.result_event_id);
    let progress = num(row.progress_s) ?? 0;

    // 计划 → 就绪
    if (status === 'planned') {
      if (pendingDeps.length > 0) {
        reasonCode = 'DEPENDENCY_PENDING';
        nextCheck = null;
      } else if (!condition.ok) {
        reasonCode = 'TRIGGER_PENDING';
        nextCheck = nextTriggerTime(trigger, untilS);
      } else {
        const earliest = num(row.earliest_start_s);
        if (earliest !== null && earliest > untilS) {
          reasonCode = 'EARLIEST_START_PENDING';
          nextCheck = earliest;
        } else {
          status = 'ready';
          reasonCode = null;
        }
      }
    }

    // 就绪 → 执行
    if (status === 'ready' && able && pendingDeps.length === 0 && condition.ok) {
      const earliest = num(row.earliest_start_s);
      const startAt = Math.min(untilS, Math.max(startFloor, earliest ?? startFloor, condition.atS ?? startFloor));
      startedAt = startedAt ?? startAt;
      status = 'active';
      reasonCode = null;
      if (kind !== 'travel' && !isPassive(row) && !mainAssigned.has(actorId)) mainAssigned.set(actorId, actionId);
    } else if (status === 'ready' && (!able || pendingDeps.length > 0 || !condition.ok)) {
      status = able ? 'blocked' : 'paused';
      reasonCode = able ? (pendingDeps.length > 0 ? 'DEPENDENCY_PENDING' : 'CONDITION_FAILED') : 'ACTOR_UNABLE';
    }

    // 暂停/受阻 → 恢复
    if ((status === 'paused' || status === 'blocked') && able && pendingDeps.length === 0 && condition.ok) {
      status = 'active';
      reasonCode = null;
      startedAt = startedAt ?? startFloor;
      if (kind !== 'travel' && !isPassive(row) && !mainAssigned.has(actorId)) mainAssigned.set(actorId, actionId);
    } else if (status === 'blocked' && !able) {
      status = 'paused';
      reasonCode = 'ACTOR_UNABLE';
    }

    // 执行中：扣有效时间
    if (status === 'active') {
      if (!condition.ok && kind !== 'wait') {
        status = 'blocked';
        reasonCode = 'CONDITION_FAILED';
      } else if (!able) {
        reasonCode = 'ACTOR_UNABLE';
        issues.push(issue('ACTION_ACTOR_UNABLE', `actions.${actionId}`, `${actorId} 已死亡或失去行动能力，行动不再推进（应由 haltActorWork 取消）`, 'warning'));
      } else {
        const accrualStart = Math.max(startFloor, startedAt ?? startFloor);
        let start = accrualStart;
        for (const dep of dependencies) {
          const depFinish = num(byId.get(dep)?.finished_at_s);
          if (depFinish !== null) start = Math.max(start, depFinish);
        }
        const dt = Math.max(0, untilS - start);

        if (kind === 'travel') {
          // 路程进度由 journeys 精确扣减，这里不重复累计（§4.3 / §4.4）。
          reasonCode = 'JOURNEY_RUNNING';
        } else if (kind === 'wait') {
          const until = asObject(payload.until);
          const waitCondition = until ? evaluateCondition(world, until, { clockS: untilS, actorId }) : { ok: true, reasons: [], atS: null };
          if (waitCondition.ok) {
            const at = Math.min(untilS, Math.max(start, waitCondition.atS ?? untilS));
            status = 'completed';
            finishedAt = at;
            progress = Math.max(0, at - (startedAt ?? start));
            reasonCode = null;
          } else {
            reasonCode = 'WAIT_PENDING';
            nextCheck = nextTriggerTime(until, untilS);
          }
        } else {
          const isMain = mainAssigned.get(actorId) === actionId;
          const passive = isPassive(row);
          if (isMain || passive) {
            const duration = asObject(row.duration_json);
            const nominal = duration ? num(duration.nominal_s) : null;
            if (dt > 0) {
              progress += dt;
            }
            if (nominal === null) {
              reasonCode = 'DURATION_UNKNOWN';
              issues.push(
                issue('ACTION_DURATION_UNKNOWN', `actions.${actionId}`, '有效执行时间未知：累计时间但不假装完成，也不当成本轮 0 秒', 'warning'),
              );
            } else if (nominal <= 0) {
              status = 'completed';
              finishedAt = start;
              reasonCode = null;
            } else if (progress >= nominal) {
              const consume = nominal - (num(row.progress_s) ?? 0);
              finishedAt = Math.min(untilS, Math.max(start, start + Math.max(0, consume)));
              status = 'completed';
              progress = nominal;
              reasonCode = null;
            }
          } else if (dt > 0) {
            reasonCode = 'TIME_SHARED';
            issues.push(
              issue(
                'ACTION_TIME_SHARED',
                `actions.${actionId}`,
                `${actorId} 的主要行动时间已被 ${mainAssigned.get(actorId)} 占用，本窗口不重复计进度`,
                'warning',
              ),
            );
          }
        }
      }
    }

    if (status === 'completed' && finishedAt !== null && resultEventId === null) {
      const event = completionEvent(world, row, finishedAt, makeId);
      events.push(event);
      resultEventId = String(event.id);
    }

    const complete = status === 'completed' || status === 'cancelled';
    const nextRow: Record<string, unknown> = {
      ...row,
      status,
      reason_code: reasonCode,
      progress_s: progress,
      started_at_s: startedAt,
      finished_at_s: finishedAt,
      next_check_s: complete ? null : nextCheck,
      evaluated_until_s: untilS,
      result_event_id: resultEventId,
    };
    const dirtyFields = ['status', 'reason_code', 'progress_s', 'started_at_s', 'finished_at_s', 'next_check_s', 'evaluated_until_s', 'result_event_id'];
    const dirty = dirtyFields.some((field) => nextRow[field] !== row[field]);
    if (dirty) {
      nextRow.row_rev = (num(row.row_rev) ?? 1) + 1;
      nextRow.updated_turn_id = world.turnId;
    }
    updated.push(nextRow);
  }

  return { actions: updated, events, issues };
}

/* —— F08 haltActorWork —— */

function assertColumns(table: string, columns: string[]): string[] {
  const known = new Set(tableColumnNames(table as never));
  for (const column of columns) if (!known.has(column)) throw new Error(`haltActorWork 列名不在 schema：${table}.${column}`);
  return columns;
}

/**
 * F08：死亡/失去行动能力的人必须停止走路。
 * - 取消其所有未结束行动（planned/ready/active/paused/blocked → cancelled）与开放行程
 *   （moving/paused/blocked → cancelled）。
 * - **保留最后已知位置**：不改 `characters.location_id`，不给行程伪造 `stop_location_id`
 *   （§7.6.5「不伪造节点」）。
 * - 返回受影响行数；调用方负责把它放进本轮的原子组。
 */
export function haltActorWork(
  db: SqlDatabase,
  branchId: string,
  entityId: string,
  clockS: number,
  reasonCode: string,
): { actions: number; journeys: number } {
  const actionRows = queryBound(db, `SELECT id FROM actions WHERE branch_id = ? AND actor_entity_id = ? AND status IN ${OPEN_STATUSES}`, [
    branchId,
    entityId,
  ]);
  const journeyRows = queryBound(
    db,
    `SELECT id FROM journeys WHERE branch_id = ? AND mover_entity_id = ? AND status IN ('moving','paused','blocked')`,
    [branchId, entityId],
  );

  if (actionRows.length > 0) {
    const columns = assertColumns('actions', ['status', 'finished_at_s', 'reason_code', 'evaluated_until_s']);
    runBound(
      db,
      `UPDATE actions SET ${columns.map((c) => `${c} = ?`).join(', ')}, row_rev = row_rev + 1 WHERE branch_id = ? AND actor_entity_id = ? AND status IN ${OPEN_STATUSES}`,
      ['cancelled', clockS, reasonCode, clockS, branchId, entityId],
    );
  }
  if (journeyRows.length > 0) {
    const columns = assertColumns('journeys', ['status', 'stop_reason']);
    runBound(
      db,
      `UPDATE journeys SET ${columns.map((c) => `${c} = ?`).join(', ')}, row_rev = row_rev + 1 WHERE branch_id = ? AND mover_entity_id = ? AND status IN ('moving','paused','blocked')`,
      ['cancelled', reasonCode, branchId, entityId],
    );
  }
  return { actions: actionRows.length, journeys: journeyRows.length };
}
