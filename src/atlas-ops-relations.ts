/**
 * atlas-ops-relations.ts — D06 compileRelationUpsert。
 *
 * 规则（§4.1）：
 * - 默认唯一键 `(branch,subject,object,kind,label)`：同一关系修改原行，历史留在变更日志。
 * - A 信任 B 不会自动产生 B 信任 A；双向事实由上层语义操作原子生成两行。
 * - 关系与地点控制权分开表达（controls 也是一种 relation）。
 */

import type { Issue, ParsedOperation, RowMutation } from './atlas-ops-contract.ts';
import type { CompileContext, CompileResult } from './atlas-ops-compile-types.ts';
import { emptyCompileResult } from './atlas-ops-compile-types.ts';
import { createRow } from './atlas-db-defaults.ts';
import { resolveRef } from './atlas-ops-refs.ts';
import { fieldIgnoredWarning, asString } from './atlas-ops-entities.ts';

const RELATION_FIELDS = new Set([
  'subject_ref', 'object_ref', 'kind', 'label', 'attitude', 'trust', 'description', 'secrecy', 'ends_after_s',
]);
const RELATION_KINDS = ['member_of', 'leads', 'controls', 'knows', 'kinship', 'ally', 'hostile', 'owes', 'protects', 'other'];
const RELATION_ATTITUDE = ['supportive', 'neutral', 'suspicious', 'hostile', 'unknown'];
const RELATION_TRUST = ['high', 'medium', 'low', 'unknown'];
const RELATION_SECRECY = ['public', 'restricted', 'secret'];

function issue(code: string, path: string, message: string, op: ParsedOperation, extra: Partial<Issue> = {}): Issue {
  return { code, path, message, severity: 'error', retryable: true, opId: op.opId, line: op.line, ...extra };
}

function basisOf(ctx: CompileContext, op: ParsedOperation): Record<string, unknown> {
  if (ctx.basisFor) return ctx.basisFor(op) as unknown as Record<string, unknown>;
  return {
    kind: ctx.phase === 'observe' ? 'story' : 'simulation',
    sources: [],
    causes: [],
    reason: op.value.why ?? '关系语义操作',
    verification: ctx.phase === 'observe' ? 'source_bound' : 'causal',
    certainty: ctx.phase === 'observe' ? 'confirmed' : 'inferred',
  };
}

/** D06 compileRelationUpsert。 */
export function compileRelationUpsert(op: ParsedOperation, ctx: CompileContext): CompileResult {
  const result = emptyCompileResult();
  const data = (op.value.data ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(data).filter((k) => !RELATION_FIELDS.has(k));
  if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));

  const ref = op.value.ref?.trim();
  let subjectId: string | null = null;
  let objectId: string | null = null;
  let existingRow: Record<string, unknown> | null = null;
  let rowId: string;

  if (ref && !ref.startsWith('new:')) {
    const r = resolveRef(ref, 'relation', ctx.scope, { opId: op.opId, line: op.line, field: 'ref' });
    if (!r.entry) {
      result.issues.push(...r.issues);
      return result;
    }
    rowId = r.entry.id;
    existingRow = ctx.tables.selectOne('relations', ctx.branchId, rowId);
    if (!existingRow) {
      result.issues.push(issue('REF_UNKNOWN', '$.ref', `关系引用存在但行不存在：${rowId}`, op));
      return result;
    }
    subjectId = String(existingRow.subject_entity_id);
    objectId = String(existingRow.object_entity_id);
  } else {
    const subject = resolveRef(String(data.subject_ref ?? ''), null, ctx.scope, { opId: op.opId, field: 'subject_ref' });
    if (!subject.entry) {
      result.issues.push(...(subject.issues.length ? subject.issues : [issue('MINIMUM_FIELD_MISSING', '$.data.subject_ref', 'relation.upsert 需要 subject_ref', op)]));
      return result;
    }
    const object = resolveRef(String(data.object_ref ?? ''), null, ctx.scope, { opId: op.opId, field: 'object_ref' });
    if (!object.entry) {
      result.issues.push(...(object.issues.length ? object.issues : [issue('MINIMUM_FIELD_MISSING', '$.data.object_ref', 'relation.upsert 需要 object_ref', op)]));
      return result;
    }
    subjectId = subject.entry.id;
    objectId = object.entry.id;
    if (subjectId === objectId) {
      result.issues.push(issue('RELATION_SELF_TARGET', '$.data.object_ref', '关系的主体和客体不能是同一条身份', op));
      return result;
    }
    const kind = data.kind === undefined ? 'other' : String(data.kind);
    const label = asString(data.label) ?? '';
    // 默认唯一键 (branch, subject, object, kind, label)：命中则更新原行。
    const found = ctx.tables.selectWhere(
      'relations',
      { branch_id: ctx.branchId, subject_entity_id: subjectId, object_entity_id: objectId, kind, label },
      1,
    );
    existingRow = found.length ? found[0] : null;
    rowId = existingRow ? String(existingRow.id) : ctx.makeId('relation', op.opId, ref ?? `rel:${subjectId}:${objectId}:${kind}:${label}`);
  }

  const changes: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(data, 'kind')) {
    const kind = String(data.kind);
    if (!RELATION_KINDS.includes(kind)) result.issues.push(issue('ENUM_INVALID', '$.data.kind', `关系类型非法：${kind}`, op));
    else changes.kind = kind;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'label')) changes.label = asString(data.label) ?? '';
  if (Object.prototype.hasOwnProperty.call(data, 'attitude')) {
    const attitude = String(data.attitude);
    if (!RELATION_ATTITUDE.includes(attitude)) result.issues.push(issue('ENUM_INVALID', '$.data.attitude', `attitude 非法：${attitude}`, op));
    else changes.attitude = attitude;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'trust')) {
    const trust = String(data.trust);
    if (!RELATION_TRUST.includes(trust)) result.issues.push(issue('ENUM_INVALID', '$.data.trust', `trust 非法：${trust}`, op));
    else changes.trust = trust;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'description')) changes.description = String(data.description ?? '');
  if (Object.prototype.hasOwnProperty.call(data, 'secrecy')) {
    const secrecy = String(data.secrecy);
    if (!RELATION_SECRECY.includes(secrecy)) result.issues.push(issue('ENUM_INVALID', '$.data.secrecy', `secrecy 非法：${secrecy}`, op));
    else changes.secrecy = secrecy;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'ends_after_s')) {
    const ends = data.ends_after_s;
    if (ends === null) {
      changes.valid_until_s = null;
      changes.status = 'active';
    } else if (typeof ends === 'number' && Number.isFinite(ends)) {
      changes.valid_until_s = ctx.clockS + ends;
    } else {
      result.issues.push(issue('FIELD_TYPE_INVALID', '$.data.ends_after_s', 'ends_after_s 必须是有限秒数或 null', op));
    }
  }

  if (result.issues.some((i) => i.severity === 'error')) return result;

  const turnId = ctx.turnId ?? ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;
  if (existingRow) {
    const merged: Record<string, unknown> = { ...existingRow, ...changes };
    merged.row_rev = Number(existingRow.row_rev ?? 1) + 1;
    merged.updated_turn_id = turnId;
    result.mutations.push({
      table: 'relations',
      rowId,
      before: existingRow,
      after: merged,
      sourceOpIds: [op.opId],
      basis: basisOf(ctx, op),
    } as RowMutation);
    result.readSet.push({ table: 'relations', rowId, rowRev: Number(existingRow.row_rev ?? 1) });
  } else {
    const row = createRow(
      'relations',
      { subject_entity_id: subjectId!, object_entity_id: objectId!, basis_quality: ctx.phase === 'observe' ? 'confirmed' : 'inferred', ...changes },
      { branchId: ctx.branchId, id: rowId, turnId, clockS: ctx.clockS, nowWallMs: Date.now(), rulesetVersion: 'atlas-1' },
    );
    result.mutations.push({ table: 'relations', rowId, before: null, after: row, sourceOpIds: [op.opId], basis: basisOf(ctx, op) } as RowMutation);
  }
  return result;
}
