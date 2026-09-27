/**
 * atlas-sim-outcome-context.ts — F14：到期行动的结果判定上下文（§9.5 / §16.6 / §17F）。
 *
 * 固定行为：
 * - 只允许 `event.propose` 与 `information.propose`（§8.2 outcome 阶段；§16.6 后台真实结果必须
 *   由 event/effects 同组落实）。
 * - 资格检查覆盖**时间 / 空间 / 能力 / 物品 / 条件**，并给出具体原因；
 *   **条件不满足的行动不是自动成功**，只能以 `ok:false` + reasons 交给模型或程序拒绝。
 * - `facts` 是程序掌握的现场事实（作者层真值可用于后台结果判定：§16.6「后台死亡/重要结果 |
 *   到期行动/机会、时空与能力检查」），不是角色已知输入——角色能知道什么由 F13 决定。
 *
 * 纯查询层：不调用模型、不写库、不使用 `Date.now()`；当前时刻取 `branches.clock_s`。
 */

import { queryBound } from './atlas-db-runtime.ts';
import { decodeRow } from './atlas-db-codec.ts';
import { resolveEffectivePosition } from './atlas-sim-position.ts';
import { evaluateCondition } from './atlas-sim-actions.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { Opportunity } from './atlas-sim-opportunities.ts';

/** §8.2 / §8.4：outcome 阶段只允许这两种语义操作。 */
export const OUTCOME_ALLOWED_OPS: readonly string[] = ['event.propose', 'information.propose'];

export type OutcomeEligibility = { actionId: string; ok: boolean; reasons: string[] };

export type OutcomeContext = {
  dueActions: Array<Record<string, unknown>>;
  facts: Array<Record<string, unknown>>;
  eligibility: OutcomeEligibility[];
  allowedOps: readonly string[];
};

export type OutcomeWorld = { db: SqlDatabase; branchId: string };

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

function loadRow(world: OutcomeWorld, table: string, id: string): Record<string, unknown> | null {
  const rows = queryBound(world.db, `SELECT * FROM ${table} WHERE branch_id = ? AND id = ? LIMIT 1`, [world.branchId, id]);
  return rows.length > 0 ? decodeOrNull(table, rows[0]) : null;
}

function heldBy(world: OutcomeWorld, actorId: string, itemId: string): boolean {
  let cursor: string | null = itemId;
  const seen = new Set<string>();
  for (let depth = 0; cursor && depth <= 4; depth += 1) {
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    const item = loadRow(world, 'items', cursor);
    if (!item) return false;
    if (str(item.holder_character_id) === actorId) return true;
    cursor = str(item.container_item_id);
  }
  return false;
}

/** 结构化副本：JSON 列统一成对象，方便提示词层直接使用（不改变原行）。 */
function normalizeAction(action: Record<string, unknown>): Record<string, unknown> {
  return {
    ...action,
    payload_json: asObject(action.payload_json),
    trigger_json: asObject(action.trigger_json),
    duration_json: asObject(action.duration_json),
    depends_on_json: asArray(action.depends_on_json),
  };
}

/** 行动要求「人必须在该地点」的种类（travel 的目的地不是所在地）。 */
const PRESENCE_KINDS = new Set(['act', 'interact', 'prepare', 'investigate', 'wait']);

/**
 * F14：到期行动 + 现场事实 + 资格检查。
 * `ok:false` 表示条件/时空/能力/物品不满足，不能自动成功；具体原因写在 `reasons`。
 */
export function buildOutcomeContext(
  batch: { dueActions: Array<Record<string, unknown>>; opportunities?: Opportunity[] },
  world: OutcomeWorld,
): OutcomeContext {
  const branchRows = queryBound(world.db, 'SELECT clock_s, simulation_cursor_s FROM branches WHERE id = ? LIMIT 1', [world.branchId]);
  const clockS = branchRows.length > 0 ? num(branchRows[0].clock_s) ?? 0 : 0;
  const facts: Array<Record<string, unknown>> = [];
  const eligibility: OutcomeEligibility[] = [];

  if (branchRows.length === 0) {
    facts.push({ kind: 'branch_missing', branchId: world.branchId, note: '分支不存在，无法判定到期行动' });
  }
  facts.push({ kind: 'time', clockS, simulationCursorS: branchRows.length > 0 ? num(branchRows[0].simulation_cursor_s) ?? 0 : 0 });

  for (const opportunity of batch?.opportunities ?? []) {
    facts.push({
      kind: 'opportunity',
      opportunityId: opportunity.id,
      opportunityKind: opportunity.kind,
      receiverEntityId: opportunity.receiverEntityId,
      informationId: opportunity.informationId,
      locationId: opportunity.locationId,
      atS: opportunity.atS,
      requiresDwellS: opportunity.requiresDwellS,
    });
  }

  const dueActions: Array<Record<string, unknown>> = [];
  for (const raw of batch?.dueActions ?? []) {
    const action = normalizeAction(raw);
    dueActions.push(action);
    const actionId = String(action.id ?? '');
    const reasons: string[] = [];
    const actorId = str(action.actor_entity_id);
    const kind = String(action.kind ?? '');
    const payload = asObject(action.payload_json) ?? {};

    if (!actorId) {
      reasons.push('ACTOR_MISSING');
      eligibility.push({ actionId, ok: false, reasons });
      continue;
    }
    const actor = loadRow(world, 'characters', actorId);
    if (!actor) {
      reasons.push(`ACTOR_UNKNOWN:${actorId}`);
      eligibility.push({ actionId, ok: false, reasons });
      continue;
    }
    const physical = String(actor.physical_status ?? 'unknown');
    facts.push({
      kind: 'actor_state',
      actionId,
      actorId,
      physicalStatus: physical,
      conditionNote: String(actor.condition_note ?? ''),
      locationId: str(actor.location_id),
    });
    if (physical === 'dead') reasons.push('ACTOR_DEAD');
    else if (physical === 'incapacitated') reasons.push('ACTOR_INCAPACITATED');

    // —— 时间
    const evaluated = num(action.evaluated_until_s) ?? 0;
    const deadline = num(action.deadline_s);
    const startedAt = num(action.started_at_s);
    const duration = asObject(action.duration_json);
    const nominal = duration ? num(duration.nominal_s) : null;
    const progress = num(action.progress_s) ?? 0;
    const remaining = nominal !== null ? Math.max(0, nominal - progress) : null;
    facts.push({ kind: 'time_window', actionId, clockS, evaluatedUntilS: evaluated, startedAtS: startedAt, deadlineS: deadline, nominalS: nominal, progressS: progress, remainingS: remaining });
    if (deadline !== null && deadline < clockS) reasons.push(`DEADLINE_PASSED:${deadline}`);
    if (evaluated > clockS) reasons.push(`NOT_DUE_YET:evaluated_until_s=${evaluated}`);
    if (nominal === null) reasons.push('DURATION_UNKNOWN');

    // —— 空间（含「在路上就不能同时在场执行」）
    const position = resolveEffectivePosition({ db: world.db, branchId: world.branchId }, actorId);
    facts.push({ kind: 'position', actionId, actorId, position: position as unknown as Record<string, unknown> });
    const openJourney = queryBound(
      world.db,
      `SELECT id, status FROM journeys WHERE branch_id = ? AND mover_entity_id = ? AND status IN ('moving','paused','blocked') LIMIT 1`,
      [world.branchId, actorId],
    );
    const targetLocation = str(action.target_location_id);
    if (openJourney.length > 0 && PRESENCE_KINDS.has(kind)) {
      reasons.push(`ACTOR_IN_TRANSIT:${String(openJourney[0].id)}`);
    }
    if (targetLocation && PRESENCE_KINDS.has(kind)) {
      const here = position.kind === 'at_location' ? position.locationId : str(actor.location_id);
      if (here !== targetLocation) reasons.push(`NOT_AT_TARGET:${here ?? 'unknown'}!=${targetLocation}`);
    }

    // —— 能力
    const capabilityKey = str(payload.capability_key);
    if (capabilityKey) {
      const capabilities = asArray(actor.capabilities_json).filter(isPlainObject);
      const has = capabilities.some((c) => str(c.key) === capabilityKey);
      facts.push({ kind: 'capability', actionId, actorId, capabilityKey, has });
      if (!has) reasons.push(`CAPABILITY_MISSING:${capabilityKey}`);
    }

    // —— 物品
    const itemRefs = asArray(payload.item_refs).filter((v): v is string => typeof v === 'string');
    for (const itemId of itemRefs) {
      const has = heldBy(world, actorId, itemId);
      facts.push({ kind: 'item', actionId, actorId, itemId, held: has });
      if (!has) reasons.push(`ITEM_NOT_HELD:${itemId}`);
    }

    // —— 条件
    const trigger = asObject(action.trigger_json);
    if (trigger) {
      const evaluatedCondition = evaluateCondition(world, trigger, { clockS, actorId });
      facts.push({ kind: 'condition', actionId, ok: evaluatedCondition.ok, reasons: evaluatedCondition.reasons, atS: evaluatedCondition.atS });
      if (!evaluatedCondition.ok) reasons.push(...evaluatedCondition.reasons.map((r) => `CONDITION_UNMET:${r}`));
    }

    const unique = [...new Set(reasons)];
    eligibility.push({ actionId, ok: unique.length === 0, reasons: unique });
  }

  return { dueActions, facts, eligibility, allowedOps: OUTCOME_ALLOWED_OPS };
}
