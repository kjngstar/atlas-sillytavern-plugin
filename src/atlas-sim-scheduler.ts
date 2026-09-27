/**
 * atlas-sim-scheduler.ts — F11/F12：边界推进与窗口结算（§9.1 / §9.6 / §16.2 / §17F）。
 *
 * 固定行为：
 * - `nextBoundary` 取**最早到期**边界，同刻按稳定 ID 决定顺序（确定性，不受插入顺序影响）。
 * - `settleWindow` 逐边界推进：**绝不先推进到窗口终点再回头处理中间节点**（§9.1 的 A→B 反例）。
 * - 模型批次预算耗尽（或没有 modelPort）时，停在**最早未决的因果边界**，返回 `catchingUp:true`，
 *   并且绝不宣称「所有世界推演成功」（§9.6）；未决边界的时间写入 `simulationCursorS`，
 *   实际已处理到的时间写入 `processedUntilS`。
 * - 确定性程序步骤（旅行推进、传播周期、条件/到期检查）可以快速跑完；需要模型判断的边界
 *   （review 节点、到期行动结果、预定活动开始）不跳过。
 *
 * 边界种类：
 *   `journey_node`（行程下一个节点）｜`journey_start`（ready 的 travel 行动出发）
 *   `action_check`（条件/到期检查）｜`action_complete`（耗时行动完成，需要结果判断）
 *   `event_start`（预定活动开始）｜`front_spread`（风声传播周期）
 *
 * 纯程序层：除了显式 `modelPort.request` 之外不调用模型；不使用 `Math.random`/`Date.now()`。
 */

import { queryBound, runBound } from './atlas-db-runtime.ts';
import { decodeRow } from './atlas-db-codec.ts';
import { tableColumnNames } from './atlas-db-schema.ts';
import { advanceActions } from './atlas-sim-actions.ts';
import { advanceJourney, nextNodeBoundary, startJourney, NODE_REVIEW_DWELL_S } from './atlas-sim-motion.ts';
import { collectOpportunities } from './atlas-sim-opportunities.ts';
import { deliverDueInformation, PROPAGATION_CHECK_INTERVAL_S } from './atlas-sim-propagation.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { SqlValue } from './atlas-db-contract.ts';
import type { AtlasTableName } from './atlas-db-contract.ts';
import type { Issue } from './atlas-ops-contract.ts';
import type { Opportunity } from './atlas-sim-opportunities.ts';

export type Boundary = {
  atS: number;
  kind: string;
  stableId: string;
  /** 该边界是否需要模型判断（程序无法自行决定结果）。 */
  needsModel?: boolean;
  /** 关联行 ID（journey/action/event/front）。 */
  refId?: string;
  payload?: Record<string, unknown>;
};

export type SettleInput = {
  db: SqlDatabase;
  branchId: string;
  chatUid: string;
  clockS: number;
  untilS: number;
  budgets: { modelBatches: number };
  modelPort?: { request(req: unknown): Promise<unknown> } | null;
  makeId: (kind: string, opId: string, alias: string) => string;
  turnId: string;
};

export type SettleResult = {
  processedUntilS: number;
  simulationCursorS: number;
  catchingUp: boolean;
  steps: Array<Record<string, unknown>>;
  issues: Issue[];
};

/** 单次结算的最大边界步数（防止退化队列把一次调用拖死）。 */
export const SETTLE_MAX_STEPS = 512;

function issue(code: string, path: string, message: string, severity: 'warning' | 'error' = 'warning'): Issue {
  return { code, path, message, severity, retryable: false };
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
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

function decodeOrNull(table: string, row: Record<string, unknown>): Record<string, unknown> | null {
  const decoded = decodeRow(table as never, row, { allowExtra: true });
  return decoded.ok ? (decoded.row as Record<string, unknown>) : null;
}

function loadRows(world: { db: SqlDatabase; branchId: string }, table: string, where: string, params: Array<string | number | null>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const row of queryBound(world.db, `SELECT * FROM ${table} WHERE branch_id = ? AND ${where}`, [world.branchId, ...params])) {
    const decoded = decodeOrNull(table, row);
    if (decoded) out.push(decoded);
  }
  return out;
}

function bindable(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** 只按 schema 列写库：列名来自 `ATLAS_TABLE_COLUMNS`，值全部参数绑定。 */
function writeRow(db: SqlDatabase, table: AtlasTableName, row: Record<string, unknown>, mode: 'insert' | 'update'): void {
  const all = tableColumnNames(table);
  if (mode === 'insert') {
    const columns = all.filter((column) => Object.prototype.hasOwnProperty.call(row, column));
    runBound(
      db,
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      columns.map((column) => bindable(row[column])),
    );
    return;
  }
  const columns = all.filter((column) => column !== 'branch_id' && column !== 'id');
  runBound(
    db,
    `UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE branch_id = ? AND id = ?`,
    [...columns.map((column) => bindable(row[column])), bindable(row.branch_id), bindable(row.id)],
  );
}

/* —— F11 nextBoundary —— */

/**
 * F11：最早到期边界；同刻按稳定 ID 排序，保证同一队列重复调用得到同一顺序。
 * 只考虑 `atS <= untilS` 的边界；没有则返回 null。
 */
export function nextBoundary(queue: Boundary[], untilS: number): Boundary | null {
  let best: Boundary | null = null;
  for (const boundary of queue ?? []) {
    if (!boundary || !Number.isFinite(boundary.atS)) continue;
    if (boundary.atS > untilS) continue;
    if (best === null) {
      best = boundary;
      continue;
    }
    if (boundary.atS < best.atS) best = boundary;
    else if (boundary.atS === best.atS && boundary.stableId < best.stableId) best = boundary;
  }
  return best;
}

/* —— 边界队列构造 —— */

function stopPolicyOf(world: { db: SqlDatabase; branchId: string }, actionId: string | null): string {
  if (!actionId) return 'review';
  const rows = queryBound(world.db, 'SELECT payload_json FROM actions WHERE branch_id = ? AND id = ? LIMIT 1', [world.branchId, actionId]);
  const payload = rows.length > 0 ? asObject(rows[0].payload_json) : null;
  const policy = payload ? String(payload.stop_policy ?? '') : '';
  return policy === 'continue' || policy === 'review' || policy === 'stop' ? policy : 'review';
}

function actionCompletionAtS(action: Record<string, unknown>): number | null {
  const duration = asObject(action.duration_json);
  const nominal = duration ? num(duration.nominal_s) : null;
  if (nominal === null || nominal <= 0) return null;
  const started = num(action.started_at_s);
  if (started === null) return null;
  const progress = num(action.progress_s) ?? 0;
  return started + Math.max(0, nominal - progress);
}

/** 构造 `atS <= untilS` 的候选边界（调用方负责去掉已处理的稳定 ID）。 */
export function buildBoundaries(
  input: { db: SqlDatabase; branchId: string },
  cursor: number,
  untilS: number,
): Boundary[] {
  const boundaries: Boundary[] = [];
  const world = { db: input.db, branchId: input.branchId };

  for (const journey of loadRows(world, 'journeys', "status = 'moving'", [])) {
    const next = nextNodeBoundary(journey);
    if (!next || next.atS > untilS) continue;
    const journeyId = String(journey.id);
    const policy = stopPolicyOf(world, str(journey.action_id));
    boundaries.push({
      atS: next.atS,
      kind: 'journey_node',
      stableId: `journey:${journeyId}:${String(journey.segment_index ?? 0)}`,
      needsModel: policy !== 'continue',
      refId: journeyId,
      payload: { toLocationId: next.toLocationId, routeId: next.routeId, stopPolicy: policy },
    });
  }

  for (const action of loadRows(world, 'actions', "status IN ('planned','ready','active','paused','blocked')", [])) {
    const actionId = String(action.id);
    const kind = String(action.kind ?? '');
    const status = String(action.status ?? 'planned');
    const earliest = num(action.earliest_start_s);
    const nextCheck = num(action.next_check_s);

    if (status !== 'active') {
      if (kind === 'travel' && (status === 'ready' || status === 'planned')) {
        const atS = Math.max(cursor, earliest ?? cursor);
        if (atS <= untilS) {
          boundaries.push({ atS, kind: 'journey_start', stableId: `action:${actionId}:start`, needsModel: false, refId: actionId, payload: { status } });
        }
        continue;
      }
      const atS = Math.max(cursor, nextCheck ?? earliest ?? cursor);
      if (atS <= untilS) {
        boundaries.push({ atS, kind: 'action_check', stableId: `action:${actionId}:check`, needsModel: false, refId: actionId, payload: { status } });
      }
      continue;
    }

    if (kind === 'travel') continue; // 行程提供边界
    const completion = actionCompletionAtS(action);
    if (completion !== null && completion <= untilS) {
      boundaries.push({
        atS: Math.max(cursor, completion),
        kind: 'action_complete',
        stableId: `action:${actionId}:complete`,
        needsModel: true,
        refId: actionId,
      });
      continue;
    }
    if (nextCheck !== null && nextCheck <= untilS) {
      boundaries.push({ atS: Math.max(cursor, nextCheck), kind: 'action_check', stableId: `action:${actionId}:check`, needsModel: false, refId: actionId });
    }
  }

  for (const event of loadRows(world, 'events', "status = 'scheduled' AND scheduled_start_s IS NOT NULL", [])) {
    const atS = num(event.scheduled_start_s);
    if (atS === null || atS > untilS) continue;
    boundaries.push({
      atS: Math.max(cursor, atS),
      kind: 'event_start',
      stableId: `event:${String(event.id)}`,
      needsModel: true,
      refId: String(event.id),
    });
  }

  for (const front of loadRows(world, 'rumor_fronts', "status = 'active'", [])) {
    const nextCheck = num(front.next_spread_check_s) ?? (num(front.first_available_at_s) ?? 0) + PROPAGATION_CHECK_INTERVAL_S;
    if (nextCheck > untilS) continue;
    boundaries.push({
      atS: Math.max(cursor, nextCheck),
      kind: 'front_spread',
      stableId: `front:${String(front.id)}:${nextCheck}`,
      needsModel: false,
      refId: String(front.id),
    });
  }

  return boundaries;
}

/* —— 确定性边界处理 —— */

type StepOutcome = { step: Record<string, unknown>; issues: Issue[]; opportunities: Opportunity[]; cursorAfterS?: number };

function applyBoundary(input: SettleInput, boundary: Boundary, cursor: number): StepOutcome {
  const world = { db: input.db, branchId: input.branchId };
  const issues: Issue[] = [];
  const step: Record<string, unknown> = { boundaryId: boundary.stableId, kind: boundary.kind, atS: boundary.atS };

  if (boundary.kind === 'journey_node') {
    const journey = boundary.refId ? loadRows(world, 'journeys', 'id = ?', [boundary.refId])[0] : null;
    if (!journey) {
      issues.push(issue('BOUNDARY_ROW_MISSING', 'journeys', `边界 ${boundary.stableId} 引用的行程不存在`));
      return { step, issues, opportunities: [] };
    }
    const policy = String(boundary.payload?.stopPolicy ?? 'review');
    // review 节点先从本轮余额扣默认 120 秒观察用时（§16.7）；这里把「节点时刻 + 观察」一次性授予，
    // 之后停在节点上等调用方决定，绝不越过节点继续赶路。
    const grantUntilS = policy === 'review' ? Math.min(num(input.untilS) ?? boundary.atS, boundary.atS + NODE_REVIEW_DWELL_S) : boundary.atS;
    const result = advanceJourney(journey, grantUntilS, world);
    writeRow(input.db, 'journeys', result.journey, 'update');
    issues.push(...result.issues);
    const opportunities = collectOpportunities({ fromS: cursor, untilS: boundary.atS }, world);
    step.journeyId = String(journey.id);
    step.events = result.events;
    step.remainingS = result.remainingS;
    step.opportunityIds = opportunities.map((o) => o.id);
    const consumed = num(result.journey.last_advanced_at_s);
    return { step, issues, opportunities, cursorAfterS: consumed ?? boundary.atS };
  }

  if (boundary.kind === 'journey_start') {
    const action = boundary.refId ? loadRows(world, 'actions', 'id = ?', [boundary.refId])[0] : null;
    if (!action) {
      issues.push(issue('BOUNDARY_ROW_MISSING', 'actions', `边界 ${boundary.stableId} 引用的行动不存在`));
      return { step, issues, opportunities: [] };
    }
    const started = startJourney(action, {
      db: input.db,
      branchId: input.branchId,
      clockS: boundary.atS,
      makeId: input.makeId,
      turnId: input.turnId,
    });
    issues.push(...started.issues);
    step.actionId = String(action.id);
    if (!started.journey) {
      step.started = false;
      return { step, issues, opportunities: [] };
    }
    writeRow(input.db, 'journeys', started.journey, 'insert');
    const nextAction = {
      ...action,
      status: 'active',
      started_at_s: boundary.atS,
      reason_code: 'JOURNEY_RUNNING',
      evaluated_until_s: boundary.atS,
      row_rev: (num(action.row_rev) ?? 1) + 1,
      updated_turn_id: input.turnId,
    };
    writeRow(input.db, 'actions', nextAction, 'update');
    step.started = true;
    step.journeyId = String(started.journey.id);
    return { step, issues, opportunities: [] };
  }

  if (boundary.kind === 'action_check' || boundary.kind === 'action_complete') {
    const result = advanceActions({ fromS: cursor, untilS: boundary.atS }, {
      db: input.db,
      branchId: input.branchId,
      makeId: input.makeId as unknown as (...args: never[]) => string,
      turnId: input.turnId,
    });
    issues.push(...result.issues);
    for (const row of result.actions) writeRow(input.db, 'actions', row, 'update');
    for (const event of result.events) writeRow(input.db, 'events', event, 'insert');
    step.advanced = result.actions.length;
    step.events = result.events.map((event) => String(event.id));
    return { step, issues, opportunities: [] };
  }

  if (boundary.kind === 'front_spread') {
    const result = deliverDueInformation(boundary.atS, {
      db: input.db,
      branchId: input.branchId,
      clockS: boundary.atS,
      makeId: input.makeId as unknown as (...args: never[]) => string,
      turnId: input.turnId,
    });
    issues.push(...result.issues);
    step.frontsCreated = result.frontsCreated;
    step.opportunityIds = result.opportunities.map((o) => o.id);
    return { step, issues, opportunities: result.opportunities };
  }

  // event_start 是 needsModel 边界，正常不会走到这里。
  step.skipped = true;
  return { step, issues, opportunities: [] };
}

function modelRequestFor(input: SettleInput, boundary: Boundary, cursor: number, batchesLeft: number): Record<string, unknown> {
  return {
    kind: 'boundary_decision',
    phase: 'outcome',
    chatUid: input.chatUid,
    branchId: input.branchId,
    turnId: input.turnId,
    atS: boundary.atS,
    windowFromS: cursor,
    boundary: { kind: boundary.kind, stableId: boundary.stableId, refId: boundary.refId ?? null, payload: boundary.payload ?? {} },
    budgets: { modelBatchesLeft: batchesLeft },
    allowedOps: ['event.propose', 'information.propose'],
  };
}

function responseHash(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? '';
  } catch {
    text = String(value);
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `h${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * F12：按边界结算窗口。
 * - 需要模型判断的边界消耗一次 `budgets.modelBatches`；预算不足/无模型端口时停在**该边界**上，
 *   `catchingUp:true` 且 `simulationCursorS = 该边界时刻`，绝不假装整段世界已推演完成。
 * - 程序可自行决定的边界直接执行并继续（旅行推进、传播周期、条件/到期检查）。
 */
export async function settleWindow(input: SettleInput): Promise<SettleResult> {
  const untilS = num(input.untilS) ?? num(input.clockS) ?? 0;
  let cursor = Math.min(num(input.clockS) ?? 0, untilS);
  const steps: Array<Record<string, unknown>> = [];
  const issues: Issue[] = [];
  const processed = new Set<string>();
  let batchesLeft = Math.max(0, Math.trunc(num(input.budgets?.modelBatches) ?? 0));
  let pending: Boundary | null = null;

  for (let guard = 0; guard < SETTLE_MAX_STEPS; guard += 1) {
    const queue = buildBoundaries(input, cursor, untilS).filter((boundary) => !processed.has(boundary.stableId));
    const boundary = nextBoundary(queue, untilS);
    if (!boundary) break;

    if (boundary.needsModel === true) {
      if (!input.modelPort || batchesLeft <= 0) {
        // 停在最早未决的因果边界：不跳到终点，也不宣称全部成功（§9.6）。
        pending = boundary;
        steps.push({
          boundaryId: boundary.stableId,
          kind: boundary.kind,
          atS: boundary.atS,
          deferred: true,
          reason: input.modelPort ? 'MODEL_BUDGET_EXHAUSTED' : 'NO_MODEL_PORT',
        });
        issues.push(
          issue(
            input.modelPort ? 'MODEL_BUDGET_EXHAUSTED' : 'NO_MODEL_PORT',
            `boundary.${boundary.stableId}`,
            input.modelPort
              ? `模型批次预算用尽，${boundary.kind} 停在 ${boundary.atS} 秒等待补算`
              : `没有模型端口：只完成确定性步骤，${boundary.kind} 停在 ${boundary.atS} 秒`,
            'warning',
          ),
        );
        break;
      }
      // 需要判断的边界：先落实程序可确定的后果（到达节点、行动完成），再用一次模型批次决定
      // 「注意/相信/停留/结果」；不把待决事件跳过（§9.1 / §9.6）。
      const deterministic = boundary.kind === 'event_start' ? { step: {} as Record<string, unknown>, issues: [] as Issue[], opportunities: [] as Opportunity[] } : applyBoundary(input, boundary, cursor);
      batchesLeft -= 1;
      let modelBatch: Record<string, unknown>;
      try {
        const response = await input.modelPort.request(modelRequestFor(input, boundary, cursor, batchesLeft));
        modelBatch = { modelBatch: true, responseHash: responseHash(response), batchesLeft };
      } catch (err) {
        issues.push(...deterministic.issues);
        steps.push({ ...deterministic.step, boundaryId: boundary.stableId, kind: boundary.kind, atS: boundary.atS, deferred: true, reason: 'MODEL_REQUEST_FAILED' });
        pending = boundary;
        issues.push(
          issue(
            'MODEL_REQUEST_FAILED',
            `boundary.${boundary.stableId}`,
            `边界 ${boundary.stableId} 的模型判断失败：${(err as Error).message}；停在最早未决边界，等待下次补算`,
            'error',
          ),
        );
        break;
      }
      steps.push({ ...deterministic.step, boundaryId: boundary.stableId, kind: boundary.kind, atS: boundary.atS, ...modelBatch });
      issues.push(...deterministic.issues);
      processed.add(boundary.stableId);
      cursor = Math.max(cursor, boundary.atS, deterministic.cursorAfterS ?? 0);
      continue;
    }

    const outcome = applyBoundary(input, boundary, cursor);
    steps.push(outcome.step);
    issues.push(...outcome.issues);
    processed.add(boundary.stableId);
    cursor = Math.max(cursor, boundary.atS, outcome.cursorAfterS ?? 0);
    if (guard === SETTLE_MAX_STEPS - 1) {
      pending = boundary;
      issues.push(issue('SETTLE_STEP_LIMIT', 'settleWindow', `单次结算达到 ${SETTLE_MAX_STEPS} 步上限，停在 ${boundary.atS} 秒`, 'warning'));
    }
  }

  const catchingUp = pending !== null;
  return {
    processedUntilS: cursor,
    simulationCursorS: pending ? pending.atS : untilS,
    catchingUp,
    steps,
    issues,
  };
}
