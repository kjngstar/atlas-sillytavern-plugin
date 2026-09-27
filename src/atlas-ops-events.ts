/**
 * atlas-ops-events.ts — D09 compileEventPropose（§5.1 / §8.4）。
 *
 * 关键规则：
 * - scheduled / observed / simulated 分流；事件必须区分预定、观察到、推演落实三种来源。
 * - 不能仅凭标题默认 occurred。
 * - 一次 event.propose 及其全部 effects 是一个原子组：不能事件成功但死亡/转移写入失败。
 * - 事件效果对象仅允许 character_status / item_transfer / location_status / action_result。
 */

import type { Issue, ParsedOperation, RowMutation } from './atlas-ops-contract.ts';
import type { CompileContext, CompileResult } from './atlas-ops-compile-types.ts';
import { emptyCompileResult } from './atlas-ops-compile-types.ts';
import { createRow } from './atlas-db-defaults.ts';
import { resolveRef } from './atlas-ops-refs.ts';
import { fieldIgnoredWarning, asString, applyPatch, compileItemTransfer } from './atlas-ops-entities.ts';
import { PARTICIPANTS_LIMIT } from './atlas-runtime-limits.ts';

const EVENT_KINDS = ['ceremony', 'conflict', 'arrival', 'passage', 'discovery', 'trade', 'communication', 'incident', 'other'];
const EVENT_PHASES = ['scheduled', 'observed', 'simulated'];
const SECRECY = ['public', 'restricted', 'secret'];
const CHARACTER_STATUS = ['alive', 'incapacitated', 'dead', 'unknown'];
const LOCATION_STATUS = ['active', 'destroyed', 'merged', 'archived'];
const ACTION_RESULT = ['completed', 'failed', 'cancelled'];
const EFFECT_TYPES = ['character_status', 'item_transfer', 'location_status', 'action_result'];

function issue(code: string, path: string, message: string, op: ParsedOperation, extra: Partial<Issue> = {}): Issue {
  return { code, path, message, severity: 'error', retryable: true, opId: op.opId, line: op.line, ...extra };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mutation(
  table: string,
  rowId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  op: ParsedOperation,
  basis: Record<string, unknown>,
): RowMutation {
  return { table, rowId, before, after, sourceOpIds: [op.opId], basis };
}

function timeHintToEstimate(hint: unknown, op: ParsedOperation, issues: Issue[]): Record<string, unknown> {
  if (!isPlainObject(hint)) return { quality: 'unknown', basis_refs: [] };
  const elapsed = typeof hint.elapsed_s === 'number' && Number.isFinite(hint.elapsed_s) ? hint.elapsed_s : null;
  const min = typeof hint.min_s === 'number' && Number.isFinite(hint.min_s) ? hint.min_s : null;
  const max = typeof hint.max_s === 'number' && Number.isFinite(hint.max_s) ? hint.max_s : null;
  if (elapsed !== null && elapsed < 0) {
    issues.push(issue('DURATION_NEGATIVE', '$.data.time_hint.elapsed_s', 'elapsed_s 不能为负', op));
    return { quality: 'unknown', basis_refs: [] };
  }
  if (elapsed !== null) {
    return { min_s: min ?? elapsed, nominal_s: elapsed, max_s: max ?? elapsed, quality: 'explicit', basis_refs: [] };
  }
  if (min !== null || max !== null) {
    const lo = min ?? 0;
    const hi = max ?? lo;
    if (hi < lo) {
      issues.push(issue('DURATION_ORDER_INVALID', '$.data.time_hint', 'time_hint 需要 min_s ≤ max_s', op));
      return { quality: 'unknown', basis_refs: [] };
    }
    return { min_s: lo, nominal_s: Math.round((lo + hi) / 2), max_s: hi, quality: 'estimated', basis_refs: [] };
  }
  // 只有自然语言描述：保留 estimated/unknown，绝不因未知填 0。
  return { quality: 'unknown', basis_refs: [], text: typeof hint.text === 'string' ? hint.text : undefined };
}

/**
 * D09 compileEventPropose。
 * phase=observed：正文已发生 → occurred（需要实际时刻）；
 * phase=scheduled：预定 → scheduled，可以不填发生时间；
 * phase=simulated：程序推演落实 → occurred，但必须绑定真实到期行动或程序生成的机会。
 */
export function compileEventPropose(op: ParsedOperation, ctx: CompileContext): CompileResult {
  const result = emptyCompileResult();
  const data = (op.value.data ?? {}) as Record<string, unknown>;
  const known = new Set([
    'title', 'phase', 'kind', 'location_ref', 'route_ref', 'actor_ref', 'participants', 'action_ref', 'event_ref',
    'time_hint', 'activity', 'result', 'effects', 'secrecy', 'subject_ref',
  ]);
  const unknown = Object.keys(data).filter((k) => !known.has(k));
  if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));

  const title = asString(data.title);
  if (!title) {
    result.issues.push(issue('MINIMUM_FIELD_MISSING', '$.data.title', 'event.propose 需要 title', op));
    return result;
  }
  const phase = data.phase === undefined ? '' : String(data.phase);
  if (!EVENT_PHASES.includes(phase)) {
    result.issues.push(issue('MINIMUM_FIELD_MISSING', '$.data.phase', 'event.propose 需要 phase=scheduled/observed/simulated', op));
    return result;
  }

  const resolveOne = (value: unknown, kinds: string[], field: string): string | null => {
    if (typeof value !== 'string' || value.trim() === '') return null;
    const r = resolveRef(value, kinds as never, ctx.scope, { opId: op.opId, field });
    if (!r.entry) {
      result.issues.push(...r.issues);
      return null;
    }
    return r.entry.id;
  };

  const locationId = resolveOne(data.location_ref, ['location'], 'location_ref');
  const routeId = resolveOne(data.route_ref, ['route'], 'route_ref');
  const subjectId = resolveOne(data.subject_ref, ['character', 'faction', 'item'], 'subject_ref');
  const causeActionId = resolveOne(data.action_ref, ['action'], 'action_ref');
  const parentEventId = resolveOne(data.event_ref, ['event'], 'event_ref');

  // simulated 结果必须绑定真实到期行动或程序生成的机会（§8.4）。
  if (phase === 'simulated' && !causeActionId) {
    result.issues.push(
      issue('SIMULATED_EVENT_UNBOUND', '$.data.action_ref', 'simulated 事件必须绑定真实到期行动（action_ref）；不能凭标题落实结果', op),
    );
    return result;
  }

  const participants: Array<{ entity_id: string; role: string }> = [];
  if (Array.isArray(data.participants)) {
    for (const raw of data.participants.slice(0, PARTICIPANTS_LIMIT)) {
      if (!isPlainObject(raw)) continue;
      const refValue = raw.entity_ref ?? raw.ref ?? raw.entity_id;
      const id = resolveOne(refValue, ['character', 'faction', 'item', 'location'], 'participants');
      if (!id) continue;
      participants.push({ entity_id: id, role: typeof raw.role === 'string' ? raw.role : 'participant' });
    }
    if (data.participants.length > PARTICIPANTS_LIMIT) {
      result.issues.push(issue('FIELD_LIMIT_EXCEEDED', '$.data.participants', `participants 最多 ${PARTICIPANTS_LIMIT} 个`, op));
    }
  }

  let secrecy = 'restricted';
  if (data.secrecy !== undefined) {
    const s = String(data.secrecy);
    if (!SECRECY.includes(s)) {
      result.issues.push(issue('ENUM_INVALID', '$.data.secrecy', `secrecy 非法：${s}`, op));
      return result;
    }
    secrecy = s;
  }
  let kind = 'other';
  if (data.kind !== undefined) {
    const k = String(data.kind);
    if (!EVENT_KINDS.includes(k)) {
      result.issues.push(issue('ENUM_INVALID', '$.data.kind', `事件类型非法：${k}`, op));
      return result;
    }
    kind = k;
  }

  const elapsed = timeHintToEstimate(data.time_hint, op, result.issues);
  const occurredAt = phase === 'scheduled' ? null : ctx.clockS;
  const status = phase === 'scheduled' ? 'scheduled' : 'occurred';
  const scheduledStart = phase === 'scheduled' ? (typeof data.time_hint === 'object' && isPlainObject(data.time_hint) && typeof data.time_hint.at_s === 'number' ? data.time_hint.at_s : null) : occurredAt;

  const eventId = ctx.makeId('event', op.opId, `event:${title}`);
  const turnId = ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;
  const summary = asString(data.result) ?? title;
  const row = createRow(
    'events',
    {
      title,
      kind,
      summary,
      location_id: locationId,
      route_id: routeId,
      subject_entity_id: subjectId,
      participants_json: participants,
      cause_action_id: causeActionId,
      parent_event_id: parentEventId,
      scheduled_start_s: scheduledStart,
      occurred_at_s: occurredAt,
      outcome: phase === 'scheduled' ? '' : summary,
      secrecy,
      status,
    },
    { branchId: ctx.branchId, id: eventId, turnId, clockS: ctx.clockS, nowWallMs: Date.now(), rulesetVersion: 'atlas-1' },
  );
  result.mutations.push(mutation('events', eventId, null, row, op, basisWith(ctx, op, causeActionId ? [{ kind: 'action', id: causeActionId }] : [])));
  result.effects = [{ kind: 'event_time_estimate', eventId, elapsed, phase }];

  // —— effects：与事件同一原子组 ——
  const effects = data.effects;
  if (effects !== undefined) {
    if (!Array.isArray(effects)) {
      result.issues.push(issue('FIELD_TYPE_INVALID', '$.data.effects', 'effects 必须是数组', op));
      return result;
    }
    for (let i = 0; i < effects.length; i += 1) {
      const eff = effects[i];
      if (!isPlainObject(eff)) {
        result.issues.push(issue('FIELD_TYPE_INVALID', `$.data.effects[${i}]`, 'effect 必须是对象', op));
        continue;
      }
      const type = String(eff.type ?? '');
      if (!EFFECT_TYPES.includes(type)) {
        result.issues.push(issue('EFFECT_TYPE_UNSUPPORTED', `$.data.effects[${i}].type`, `不允许的事件效果类型：${type}`, op));
        continue;
      }
      if (type === 'character_status') {
        const targetId = resolveOne(eff.target_ref, ['character'], `effects[${i}].target_ref`);
        if (!targetId) continue;
        const value = String(eff.value ?? '');
        if (!CHARACTER_STATUS.includes(value)) {
          result.issues.push(issue('ENUM_INVALID', `$.data.effects[${i}].value`, `character_status 取值非法：${value}`, op));
          continue;
        }
        const before = ctx.tables.selectOne('characters', ctx.branchId, targetId);
        if (!before) {
          result.issues.push(issue('REF_UNKNOWN', `$.data.effects[${i}].target_ref`, `人物不存在：${targetId}`, op));
          continue;
        }
        const after = applyPatch(before, {
          physical_status: value,
          row_rev: Number(before.row_rev ?? 1) + 1,
          updated_turn_id: turnId,
        });
        result.mutations.push(mutation('characters', targetId, before, after, op, basisWith(ctx, op, [{ kind: 'event', id: eventId }])));
        result.readSet.push({ table: 'characters', rowId: targetId, rowRev: Number(before.row_rev ?? 1) });
        // §7.6 / 第 12 章：死亡同时处理不再可执行的行动与行程。
        if (value === 'dead' || value === 'incapacitated') {
          result.effects.push({ kind: 'halt_actor_work', entityId: targetId, reasonCode: value === 'dead' ? 'ACTOR_DEAD' : 'ACTOR_INCAPACITATED' });
        }
      } else if (type === 'location_status') {
        const targetId = resolveOne(eff.target_ref, ['location'], `effects[${i}].target_ref`);
        if (!targetId) continue;
        const value = String(eff.value ?? '');
        if (!LOCATION_STATUS.includes(value)) {
          result.issues.push(issue('ENUM_INVALID', `$.data.effects[${i}].value`, `location_status 取值非法：${value}`, op));
          continue;
        }
        const before = ctx.tables.selectOne('locations', ctx.branchId, targetId);
        if (!before) {
          result.issues.push(issue('REF_UNKNOWN', `$.data.effects[${i}].target_ref`, `地点不存在：${targetId}`, op));
          continue;
        }
        const after = applyPatch(before, { status: value, row_rev: Number(before.row_rev ?? 1) + 1, updated_turn_id: turnId });
        result.mutations.push(mutation('locations', targetId, before, after, op, basisWith(ctx, op, [{ kind: 'event', id: eventId }])));
        result.readSet.push({ table: 'locations', rowId: targetId, rowRev: Number(before.row_rev ?? 1) });
      } else if (type === 'action_result') {
        const actionId = resolveOne(eff.action_ref, ['action'], `effects[${i}].action_ref`);
        if (!actionId) continue;
        const value = String(eff.value ?? '');
        if (!ACTION_RESULT.includes(value)) {
          result.issues.push(issue('ENUM_INVALID', `$.data.effects[${i}].value`, `action_result 取值非法：${value}`, op));
          continue;
        }
        const before = ctx.tables.selectOne('actions', ctx.branchId, actionId);
        if (!before) {
          result.issues.push(issue('REF_UNKNOWN', `$.data.effects[${i}].action_ref`, `行动不存在：${actionId}`, op));
          continue;
        }
        const after = applyPatch(before, {
          status: value,
          finished_at_s: ctx.clockS,
          result_event_id: eventId,
          row_rev: Number(before.row_rev ?? 1) + 1,
          updated_turn_id: turnId,
        });
        result.mutations.push(mutation('actions', actionId, before, after, op, basisWith(ctx, op, [{ kind: 'event', id: eventId }])));
        result.readSet.push({ table: 'actions', rowId: actionId, rowRev: Number(before.row_rev ?? 1) });
      } else if (type === 'item_transfer') {
        const itemRef = eff.item_ref;
        const synthetic: ParsedOperation = {
          opId: op.opId,
          line: op.line,
          rawHash: op.rawHash,
          value: {
            op: 'item.transfer',
            ref: typeof itemRef === 'string' ? itemRef : undefined,
            data: { to: eff.to, quantity: eff.quantity },
            why: op.value.why,
          },
        };
        const transfer = compileItemTransfer(synthetic, ctx);
        result.issues.push(...transfer.issues.map((i) => ({ ...i, path: `$.data.effects[${i}].${i.path.replace(/^\$\./, '')}` })));
        result.mutations.push(...transfer.mutations);
        result.readSet.push(...transfer.readSet);
        if (transfer.entityKeyWrites) result.entityKeyWrites = [...(result.entityKeyWrites ?? []), ...transfer.entityKeyWrites];
      }
    }
  }

  result.declaredRefs = [];
  if (result.issues.some((i) => i.severity === 'error')) return result;
  return result;
}

function basisWith(ctx: CompileContext, op: ParsedOperation, causes: Array<{ kind: string; id: string }>): Record<string, unknown> {
  if (ctx.basisFor) return ctx.basisFor(op, { causes, certainty: 'inferred' }) as unknown as Record<string, unknown>;
  return {
    kind: op.value.op === 'event.propose' && ctx.phase === 'observe' ? 'story' : 'simulation',
    sources: [],
    causes,
    reason: op.value.why ?? '事件语义操作',
    verification: 'causal',
    certainty: 'inferred',
  };
}
