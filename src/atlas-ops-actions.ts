/**
 * atlas-ops-actions.ts — D07 compilePlanPropose / D08 compilePlanRevise（§4.3）。
 *
 * 关键规则：
 * - steps → 父 goal + 子行动 + 条件；**未出发不建 moving 行程**（说想去 C 不会立即出现在 C）。
 * - 一人正常只有一个占用主要行动时间的 active 行动；取消释放该占用。
 * - 已过去的历史（已经过 B）不会被改计划删除。
 * - 无法解析的自然语言条件保留在 intent，行动标记 blocked/CONDITION_UNCOMPILED，不假装条件已满足。
 */

import type { Issue, ParsedOperation, RowMutation } from './atlas-ops-contract.ts';
import type { CompileContext, CompileResult } from './atlas-ops-compile-types.ts';
import { emptyCompileResult } from './atlas-ops-compile-types.ts';
import { createRow } from './atlas-db-defaults.ts';
import { resolveRef } from './atlas-ops-refs.ts';
import { fieldIgnoredWarning, asString } from './atlas-ops-entities.ts';
import { ACTION_DEPENDS_LIMIT, ACTION_PAYLOAD_REF_LIMIT } from './atlas-runtime-limits.ts';

const STEP_KINDS = ['prepare', 'travel', 'wait', 'interact', 'transmit', 'investigate', 'act'];
const ACTION_SECRECY = ['public', 'restricted', 'secret'];

function issue(code: string, path: string, message: string, op: ParsedOperation, extra: Partial<Issue> = {}): Issue {
  return { code, path, message, severity: 'error', retryable: true, opId: op.opId, line: op.line, ...extra };
}

function basisOf(ctx: CompileContext, op: ParsedOperation, causes: Array<{ kind: string; id: string }> = []): Record<string, unknown> {
  if (ctx.basisFor) return ctx.basisFor(op, { causes, certainty: 'inferred' }) as unknown as Record<string, unknown>;
  return {
    kind: 'simulation',
    sources: [],
    causes,
    reason: op.value.why ?? '计划语义操作',
    verification: 'causal',
    certainty: 'inferred',
  };
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

export type CompiledStep = {
  kind: string;
  title: string;
  intent: string;
  payload: Record<string, unknown>;
  targetLocationId: string | null;
  targetEntityId: string | null;
  targetEventId: string | null;
  conditionUncompiled: string | null;
  durationHint: Record<string, unknown> | null;
  dependsOnIndexes: number[];
};

/** 把 steps 归一为程序内部的行动计划；不解析自由文本条件。 */
export function normalizeSteps(
  steps: unknown,
  op: ParsedOperation,
  ctx: CompileContext,
  issues: Issue[],
): CompiledStep[] {
  if (!Array.isArray(steps) || steps.length === 0) {
    issues.push(issue('MINIMUM_FIELD_MISSING', '$.data.steps', 'plan.propose 需要至少一个 step', op));
    return [];
  }
  const out: CompiledStep[] = [];
  steps.forEach((raw, i) => {
    if (!isPlainObject(raw)) {
      issues.push(issue('FIELD_TYPE_INVALID', `$.data.steps[${i}]`, 'step 必须是对象', op));
      return;
    }
    const kind = String(raw.kind ?? '');
    if (!STEP_KINDS.includes(kind)) {
      issues.push(issue('ENUM_INVALID', `$.data.steps[${i}].kind`, `step.kind 非法：${kind}`, op));
      return;
    }
    const payload: Record<string, unknown> = {};
    let targetLocationId: string | null = null;
    let targetEntityId: string | null = null;
    let targetEventId: string | null = null;
    let conditionUncompiled: string | null = null;
    const dependsOnIndexes: number[] = [];

    const resolveOne = (value: unknown, kinds: string[], field: string): string | null => {
      if (typeof value !== 'string' || value.trim() === '') return null;
      const r = resolveRef(value, kinds as never, ctx.scope, { opId: op.opId, field });
      if (!r.entry) {
        issues.push(...r.issues);
        return null;
      }
      return r.entry.id;
    };

    if (kind === 'travel') {
      const destination = resolveOne(raw.destination_ref, ['location'], `steps[${i}].destination_ref`);
      if (!destination) {
        issues.push(issue('MINIMUM_FIELD_MISSING', `$.data.steps[${i}].destination_ref`, 'travel step 需要 destination_ref', op));
        return;
      }
      targetLocationId = destination;
      const via: string[] = [];
      if (Array.isArray(raw.via_refs)) {
        for (const v of raw.via_refs.slice(0, ACTION_PAYLOAD_REF_LIMIT)) {
          const id = resolveOne(v, ['location'], `steps[${i}].via_refs`);
          if (id) via.push(id);
        }
      }
      payload.destination_ref = destination;
      payload.via_refs = via;
      payload.mobility_key = typeof raw.mobility_key === 'string' ? raw.mobility_key : null;
      const stopPolicy = raw.stop_policy === undefined ? 'review' : String(raw.stop_policy);
      payload.stop_policy = ['continue', 'review', 'stop'].includes(stopPolicy) ? stopPolicy : 'review';
    } else if (kind === 'wait') {
      const eventId = resolveOne(raw.wait_for_event_ref, ['event'], `steps[${i}].wait_for_event_ref`);
      if (eventId) {
        payload.until = { event_status: { event_ref: eventId, status: String(raw.wait_for_status ?? 'occurred') } };
        targetEventId = eventId;
      } else if (typeof raw.wait_for_status === 'string' && raw.wait_for_status.trim() !== '') {
        conditionUncompiled = raw.wait_for_status;
      } else {
        issues.push(
          issue('MINIMUM_FIELD_MISSING', `$.data.steps[${i}]`, 'wait step 需要 wait_for_event_ref 或明确条件；时间未知的典礼不要编一个具体时刻', op),
        );
        return;
      }
    } else if (kind === 'transmit') {
      const informationId = resolveOne(raw.information_ref, ['information'], `steps[${i}].information_ref`);
      const channelId = resolveOne(raw.channel_ref, ['channel'], `steps[${i}].channel_ref`);
      const recipient = resolveOne(raw.recipient_ref, ['character', 'faction', 'location'], `steps[${i}].recipient_ref`);
      if (!informationId || !recipient) {
        issues.push(issue('MINIMUM_FIELD_MISSING', `$.data.steps[${i}]`, 'transmit step 需要 information_ref 与 recipient_ref', op));
        return;
      }
      payload.information_ref = informationId;
      payload.channel_ref = channelId;
      payload.recipient = recipient;
      targetEntityId = recipient;
    } else if (kind === 'interact') {
      const other = resolveOne(raw.target_ref, null as never, `steps[${i}].target_ref`);
      if (!other) {
        issues.push(issue('MINIMUM_FIELD_MISSING', `$.data.steps[${i}].target_ref`, 'interact step 需要 target_ref', op));
        return;
      }
      payload.other_ref = other;
      payload.purpose = typeof raw.purpose === 'string' ? raw.purpose : (typeof raw.method === 'string' ? raw.method : '');
      targetEntityId = other;
    } else if (kind === 'investigate') {
      const subject = resolveOne(raw.target_ref, null as never, `steps[${i}].target_ref`);
      const informationId = resolveOne(raw.information_ref, ['information'], `steps[${i}].information_ref`);
      payload.subject_ref = subject;
      payload.information_ref = informationId;
      payload.method = typeof raw.method === 'string' ? raw.method : '';
      targetEntityId = subject;
    } else if (kind === 'prepare') {
      payload.method = typeof raw.method === 'string' ? raw.method : '';
      payload.capability_key = typeof raw.capability_key === 'string' ? raw.capability_key : null;
      payload.item_refs = [];
      if (Array.isArray(raw.item_refs)) {
        for (const v of raw.item_refs.slice(0, ACTION_PAYLOAD_REF_LIMIT)) {
          const id = resolveOne(v, ['item'], `steps[${i}].item_refs`);
          if (id) (payload.item_refs as string[]).push(id);
        }
      }
    } else if (kind === 'act') {
      payload.method = typeof raw.method === 'string' ? raw.method : '';
      payload.capability_key = typeof raw.capability_key === 'string' ? raw.capability_key : null;
      const stakes = raw.stakes === undefined ? 'ordinary' : String(raw.stakes);
      if (!['ordinary', 'major'].includes(stakes)) {
        issues.push(issue('ENUM_INVALID', `$.data.steps[${i}].stakes`, `stakes 非法：${stakes}`, op));
        return;
      }
      payload.stakes = stakes;
      const policy = raw.outcome_policy === undefined ? 'model_with_checks' : String(raw.outcome_policy);
      payload.outcome_policy = ['rules', 'model_with_checks'].includes(policy) ? policy : 'model_with_checks';
    }

    let durationHint: Record<string, unknown> | null = null;
    if (isPlainObject(raw.duration_hint)) {
      const hint = raw.duration_hint;
      const min = typeof hint.min_s === 'number' ? hint.min_s : null;
      const nominal = typeof hint.nominal_s === 'number' ? hint.nominal_s : null;
      const max = typeof hint.max_s === 'number' ? hint.max_s : null;
      if (min !== null && nominal !== null && max !== null && min >= 0 && min <= nominal && nominal <= max) {
        durationHint = { min_s: min, nominal_s: nominal, max_s: max, quality: 'estimated', basis_refs: [] };
      } else if (min !== null || nominal !== null || max !== null) {
        issues.push(issue('DURATION_ORDER_INVALID', `$.data.steps[${i}].duration_hint`, 'duration_hint 必须 0≤min≤nominal≤max', op));
      }
    }

    if (typeof raw.requires_action_ref === 'string' && raw.requires_action_ref.trim() !== '') {
      // 同批内的前置步骤用序号表达；跨批引用由 depends_on_json 承担。
      const idx = Number(raw.requires_action_ref);
      if (Number.isInteger(idx) && idx >= 0 && idx < i) dependsOnIndexes.push(idx);
    }

    out.push({
      kind,
      title: typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title : kind,
      intent: typeof raw.method === 'string' && kind !== 'travel' ? raw.method : '',
      payload,
      targetLocationId,
      targetEntityId,
      targetEventId,
      conditionUncompiled,
      durationHint,
      dependsOnIndexes,
    });
  });
  return out;
}

/** D07 compilePlanPropose。 */
export function compilePlanPropose(op: ParsedOperation, ctx: CompileContext): CompileResult {
  const result = emptyCompileResult();
  const data = (op.value.data ?? {}) as Record<string, unknown>;
  const known = new Set([
    'actor_ref', 'goal', 'steps', 'target_ref', 'target_location_ref', 'target_event_ref', 'secrecy',
  ]);
  const unknown = Object.keys(data).filter((k) => !known.has(k));
  if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));

  const actor = resolveRef(String(data.actor_ref ?? ''), null, ctx.scope, { opId: op.opId, line: op.line, field: 'actor_ref' });
  if (!actor.entry) {
    result.issues.push(
      ...(actor.issues.length ? actor.issues : [issue('MINIMUM_FIELD_MISSING', '$.data.actor_ref', 'plan.propose 需要 actor_ref', op)]),
    );
    return result;
  }
  const goal = asString(data.goal);
  if (!goal) {
    result.issues.push(issue('MINIMUM_FIELD_MISSING', '$.data.goal', 'plan.propose 需要 goal', op));
    return result;
  }

  const steps = normalizeSteps(data.steps, op, ctx, result.issues);
  if (result.issues.some((i) => i.severity === 'error')) return result;

  let secrecy = 'restricted';
  if (data.secrecy !== undefined) {
    const s = String(data.secrecy);
    if (!ACTION_SECRECY.includes(s)) {
      result.issues.push(issue('ENUM_INVALID', '$.data.secrecy', `secrecy 非法：${s}`, op));
      return result;
    }
    secrecy = s;
  }

  const turnId = ctx.turnId ?? ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;
  const actorId = actor.entry.id;
  const planId = ctx.makeId('action', op.opId, `plan:${goal}`);
  const parentRow = createRow(
    'actions',
    {
      actor_entity_id: actorId,
      parent_action_id: null,
      kind: 'goal',
      title: goal.slice(0, 80),
      intent: goal,
      secrecy,
      status: 'planned',
    },
    { branchId: ctx.branchId, id: planId, turnId, clockS: ctx.clockS, nowWallMs: Date.now(), rulesetVersion: 'atlas-1' },
  );
  result.mutations.push(mutation('actions', planId, null, parentRow, op, basisOf(ctx, op)));

  const stepIds: string[] = [];
  steps.forEach((step, index) => {
    const stepId = ctx.makeId('action', op.opId, `step:${index}:${step.kind}`);
    stepIds.push(stepId);
  });

  steps.forEach((step, index) => {
    const stepId = stepIds[index];
    const dependsOn = step.dependsOnIndexes.map((i) => stepIds[i]).filter(Boolean).slice(0, ACTION_DEPENDS_LIMIT);
    const row = createRow(
      'actions',
      {
        actor_entity_id: actorId,
        parent_action_id: planId,
        kind: step.kind,
        title: step.title.slice(0, 80),
        intent: step.conditionUncompiled ?? step.intent,
        target_entity_id: step.targetEntityId,
        target_location_id: step.targetLocationId,
        target_event_id: step.targetEventId,
        depends_on_json: dependsOn,
        payload_json: step.payload,
        duration_json: step.durationHint,
        secrecy,
        // §8.4：无法解析的自然语言条件保留在 intent，行动标记 blocked，不假装条件已满足。
        status: step.conditionUncompiled ? 'blocked' : 'planned',
        reason_code: step.conditionUncompiled ? 'CONDITION_UNCOMPILED' : null,
      },
      { branchId: ctx.branchId, id: stepId, turnId, clockS: ctx.clockS, nowWallMs: Date.now(), rulesetVersion: 'atlas-1' },
    );
    result.mutations.push(mutation('actions', stepId, null, row, op, basisOf(ctx, op)));
    if (step.conditionUncompiled) {
      result.issues.push({
        code: 'CONDITION_UNCOMPILED',
        path: `$.data.steps[${index}]`,
        message: `条件「${step.conditionUncompiled}」无法编译为确定条件树：保留在 intent，行动标记 blocked，不假装已满足`,
        severity: 'warning',
        retryable: false,
        opId: op.opId,
        line: op.line,
      });
    }
  });

  // 同批父计划 + 子行动必须原子（同一效果链）。
  for (let i = 1; i < stepIds.length; i += 1) result.dependencies.push(stepIds[0]);
  result.effects = [{ kind: 'plan_created', planId, stepIds }];
  return result;
}

/** D08 compilePlanRevise。 */
export function compilePlanRevise(op: ParsedOperation, ctx: CompileContext): CompileResult {
  const result = emptyCompileResult();
  const data = (op.value.data ?? {}) as Record<string, unknown>;
  const known = new Set(['ref', 'change', 'steps', 'destination_ref', 'why']);
  const unknown = Object.keys(data).filter((k) => !known.has(k));
  if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));

  const ref = (op.value.ref ?? asString(data.ref))?.trim();
  if (!ref) {
    result.issues.push(issue('MINIMUM_FIELD_MISSING', '$.ref', 'plan.revise 需要 ref', op));
    return result;
  }
  const change = data.change === undefined ? '' : String(data.change);
  if (!['pause', 'cancel', 'resume', 'replace_future'].includes(change)) {
    result.issues.push(issue('MINIMUM_FIELD_MISSING', '$.data.change', 'change 必须是 pause/cancel/resume/replace_future', op));
    return result;
  }
  const resolved = resolveRef(ref, 'action', ctx.scope, { opId: op.opId, line: op.line, field: 'ref' });
  if (!resolved.entry) {
    result.issues.push(...resolved.issues);
    return result;
  }
  const rowId = resolved.entry.id;
  const before = ctx.tables.selectOne('actions', ctx.branchId, rowId);
  if (!before) {
    result.issues.push(issue('REF_UNKNOWN', '$.ref', `行动引用存在但行不存在：${rowId}`, op));
    return result;
  }

  const turnId = ctx.turnId ?? ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;
  const touches: Array<{ rowId: string; row: Record<string, unknown>; target: Record<string, unknown> }> = [];
  const children = ctx.tables.selectWhere('actions', { branch_id: ctx.branchId, parent_action_id: rowId }, 64).filter(
    (c) => !['completed', 'failed', 'cancelled'].includes(String(c.status)),
  );

  const applyTo = (row: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> => {
    const merged: Record<string, unknown> = { ...row, ...patch };
    merged.row_rev = Number(row.row_rev ?? 1) + 1;
    merged.updated_turn_id = turnId;
    return merged;
  };

  if (change === 'pause') {
    if (before.status === 'completed' || before.status === 'cancelled') {
      result.issues.push(issue('ACTION_STATE_INVALID', '$.data.change', `已结束的行动（${before.status}）不能暂停`, op));
      return result;
    }
    touches.push({ rowId, row: before, target: applyTo(before, { status: 'paused', reason_code: 'PLAN_PAUSED' }) });
    for (const c of children) touches.push({ rowId: String(c.id), row: c, target: applyTo(c, { status: 'paused', reason_code: 'PLAN_PAUSED' }) });
  } else if (change === 'resume') {
    if (!['paused', 'blocked'].includes(String(before.status))) {
      result.issues.push(issue('ACTION_STATE_INVALID', '$.data.change', `只有 paused/blocked 的行动可以恢复（当前 ${before.status}）`, op));
      return result;
    }
    touches.push({ rowId, row: before, target: applyTo(before, { status: 'planned', reason_code: null }) });
    for (const c of children) {
      if (c.status === 'paused') touches.push({ rowId: String(c.id), row: c, target: applyTo(c, { status: 'planned', reason_code: null }) });
    }
  } else if (change === 'cancel') {
    // 取消释放主行动占用：本行与其未完成子行动全部 cancelled；已过去的历史保留。
    touches.push({
      rowId,
      row: before,
      target: applyTo(before, { status: 'cancelled', finished_at_s: ctx.clockS, reason_code: 'PLAN_CANCELLED' }),
    });
    for (const c of children) {
      touches.push({ rowId: String(c.id), row: c, target: applyTo(c, { status: 'cancelled', finished_at_s: ctx.clockS, reason_code: 'PLAN_CANCELLED' }) });
    }
  } else {
    // replace_future：只改未完成部分，已经过 B 的历史不会被删除。
    const steps = normalizeSteps(data.steps, op, ctx, result.issues);
    if (result.issues.some((i) => i.severity === 'error')) return result;
    if (steps.length === 0) {
      result.issues.push(issue('MINIMUM_FIELD_MISSING', '$.data.steps', 'replace_future 需要新的 steps', op));
      return result;
    }
    for (const c of children) {
      touches.push({ rowId: String(c.id), row: c, target: applyTo(c, { status: 'cancelled', reason_code: 'PLAN_REPLACED' }) });
    }
    steps.forEach((step, index) => {
      const stepId = ctx.makeId('action', op.opId, `future:${index}:${step.kind}`);
      const row = createRow(
        'actions',
        {
          actor_entity_id: String(before.actor_entity_id),
          parent_action_id: rowId,
          kind: step.kind,
          title: step.title.slice(0, 80),
          intent: step.conditionUncompiled ?? step.intent,
          target_entity_id: step.targetEntityId,
          target_location_id: step.targetLocationId,
          target_event_id: step.targetEventId,
          payload_json: step.payload,
          duration_json: step.durationHint,
          secrecy: String(before.secrecy ?? 'restricted'),
          status: step.conditionUncompiled ? 'blocked' : 'planned',
          reason_code: step.conditionUncompiled ? 'CONDITION_UNCOMPILED' : null,
        },
        { branchId: ctx.branchId, id: stepId, turnId, clockS: ctx.clockS, nowWallMs: Date.now(), rulesetVersion: 'atlas-1' },
      );
      result.mutations.push(mutation('actions', stepId, null, row, op, basisOf(ctx, op)));
    });
    if (Object.prototype.hasOwnProperty.call(data, 'destination_ref')) {
      const dest = resolveRef(String(data.destination_ref), 'location', ctx.scope, { opId: op.opId, field: 'destination_ref' });
      if (!dest.entry) result.issues.push(...dest.issues);
      else touches.push({ rowId, row: before, target: applyTo(before, { target_location_id: dest.entry.id }) });
    }
    result.effects = [{ kind: 'plan_replaced_future', planId: rowId }];
  }

  if (result.issues.some((i) => i.severity === 'error')) return result;
  for (const t of touches) {
    result.mutations.push(mutation('actions', t.rowId, t.row, t.target, op, basisOf(ctx, op)));
    result.readSet.push({ table: 'actions', rowId: t.rowId, rowRev: Number(t.row.row_rev ?? 1) });
  }
  return result;
}
