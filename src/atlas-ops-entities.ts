/**
 * atlas-ops-entities.ts — D01–D05 实体四类 + 物品转移编译器。
 *
 * 公共规则：
 * - 所有写正式库的动作都表达为 RowMutation；本文件不执行 SQL。
 * - 新建时程序分配 ID 并写 entity_keys（与详情同组，§2.2）。
 * - 省略 = 保持；显式 null = 清空允许为空的字段（§8.4）。
 * - 位置对象只用 `{x,y,precision,radius?}`，必须与 map_ref 同时提供；未知精确位置用 location_ref。
 */

import type { Issue, ParsedOperation, RefEntry, RefKind, RowMutation } from './atlas-ops-contract.ts';
import type { CompileContext, CompileResult } from './atlas-ops-compile-types.ts';
import { emptyCompileResult } from './atlas-ops-compile-types.ts';
import { createRow } from './atlas-db-defaults.ts';
// E15：候选生命周期（去重计数、256 上限回收、二次评估）的唯一权威。
import { updateMentionCandidates } from './atlas-db-mentions.ts';
import type { RefScope } from './atlas-ops-refs.ts';
import { resolveRef } from './atlas-ops-refs.ts';
import { ALIAS_LIMIT, CAPABILITY_LIMIT, MOBILITY_PROFILE_LIMIT, ITEM_PROPERTY_LIMIT } from './atlas-runtime-limits.ts';
// 唯一来源：atlas-location-kinds.ts（含 floor）。本文件不再复制地点类型枚举。
import { ATLAS_LOCATION_KINDS } from './atlas-location-kinds.ts';

type Data = Record<string, unknown>;

function issue(code: string, path: string, message: string, op: ParsedOperation, extra: Partial<Issue> = {}): Issue {
  return {
    code,
    path,
    message,
    severity: 'error',
    retryable: true,
    opId: op.opId,
    line: op.line,
    ...extra,
  };
}

export function fieldIgnoredWarning(op: ParsedOperation, fields: string[]): Issue {
  return {
    code: 'FIELD_IGNORED',
    path: '$.data',
    message: `本操作不写这些字段，已忽略：${fields.join('、')}`,
    severity: 'warning',
    retryable: false,
    opId: op.opId,
    line: op.line,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function dataOf(op: ParsedOperation): Data {
  return isPlainObject(op.value.data) ? op.value.data : {};
}

export function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/** 省略 = 保持；显式 null = 清空；其余 = 覆盖。 */
export function applyPatch(existing: Record<string, unknown>, changes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

function readSetFor(ctx: CompileContext, table: string, rowId: string): Array<{ table: string; rowId: string; rowRev: number }> {
  const row = ctx.tables.selectOne(table as never, ctx.branchId, rowId);
  const rowRev = row && typeof row.row_rev === 'number' ? row.row_rev : 0;
  return [{ table, rowId, rowRev }];
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

/**
 * 审计列归属的当前楼层。
 * **必须**是本次提交正在创建的楼（ctx.turnId），不是父楼——
 * 记成父楼会让 first_turn_id/last_turn_id/created_turn_id 系统性偏一楼。
 */
function turnIdOf(ctx: CompileContext): string {
  if (typeof ctx.turnId === 'string' && ctx.turnId !== '') return ctx.turnId;
  return ctx.turnId ?? ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;
}

function basisFor(
  ctx: CompileContext,
  op: ParsedOperation,
  extra: { causes?: Array<{ kind: string; id: string }>; certainty?: 'confirmed' | 'inferred' | 'hypothetical' } = {},
): Record<string, unknown> {
  if (ctx.basisFor) return ctx.basisFor(op, extra) as unknown as Record<string, unknown>;
  return {
    kind: ctx.phase === 'observe' ? 'story' : 'simulation',
    sources: [],
    causes: extra.causes ?? [],
    reason: op.value.why ?? `${op.value.op} 语义操作`,
    verification: ctx.phase === 'observe' ? 'source_bound' : 'causal',
    certainty: extra.certainty ?? (ctx.phase === 'observe' ? 'confirmed' : 'inferred'),
  };
}

function entityKeyMutation(
  ctx: CompileContext,
  op: ParsedOperation,
  id: string,
  kind: 'location' | 'character' | 'item' | 'faction',
): RowMutation {
  const existing = ctx.tables.selectOne('entity_keys', ctx.branchId, id);
  return mutation('entity_keys', id, existing, { branch_id: ctx.branchId, id, kind }, op, basisFor(ctx, op));
}

function ensureAliases(value: unknown, op: ParsedOperation, path: string): { value: string[] | null; issues: Issue[] } {
  if (value === undefined) return { value: null, issues: [] };
  if (value === null) return { value: [], issues: [] };
  if (!Array.isArray(value)) return { value: null, issues: [issue('FIELD_TYPE_INVALID', path, 'aliases 必须是字符串数组', op)] };
  const list = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
  if (list.length > ALIAS_LIMIT) {
    return {
      value: list.slice(0, ALIAS_LIMIT),
      issues: [issue('FIELD_LIMIT_EXCEEDED', path, `aliases 最多 ${ALIAS_LIMIT} 个，收到 ${list.length} 个`, op)],
    };
  }
  return { value: list, issues: [] };
}

/**
 * 位置对象：`{x,y,precision,radius?}`，必须与 map_ref 同时给出。
 * 未知精确位置时**省略 position**（不是给 0）。
 */
function applyPosition(target: Record<string, unknown>, data: Data, op: ParsedOperation, issues: Issue[], scope: RefScope): void {
  if (!Object.prototype.hasOwnProperty.call(data, 'position')) return;
  const position = data.position;
  if (position === null) {
    target.grid_x = null;
    target.grid_y = null;
    target.map_id = null;
    target.coord_precision = 'unknown';
    target.uncertainty_radius_cells = null;
    return;
  }
  if (!isPlainObject(position)) {
    issues.push(issue('FIELD_TYPE_INVALID', '$.data.position', 'position 必须是 {x,y,precision,radius?}', op));
    return;
  }
  const x = asFiniteNumber(position.x);
  const y = asFiniteNumber(position.y);
  if (x === null || y === null) {
    issues.push(
      issue('COORD_INCOMPLETE', '$.data.position', 'position 必须同时给出有限数字 x 与 y；不知道精确位置时请省略 position', op),
    );
    return;
  }
  const precision = position.precision === undefined ? 'approximate' : String(position.precision);
  if (!['exact', 'approximate', 'layout', 'unknown'].includes(precision)) {
    issues.push(issue('ENUM_INVALID', '$.data.position.precision', `coord precision 取值非法：${precision}`, op));
    return;
  }
  const mapRefRaw = data.map_ref;
  if (typeof mapRefRaw !== 'string' || mapRefRaw.trim() === '') {
    issues.push(issue('COORD_MAP_REQUIRED', '$.data.map_ref', '给出坐标必须同时给出 map_ref（程序不把坐标默认挂到根图）', op));
    return;
  }
  const mapResolved = resolveRef(mapRefRaw, 'map', scope, { opId: op.opId, line: op.line, field: 'map_ref' });
  if (!mapResolved.entry) {
    issues.push(...mapResolved.issues);
    return;
  }
  target.map_id = mapResolved.entry.id;
  target.grid_x = x;
  target.grid_y = y;
  target.coord_precision = precision;
  const radius = asFiniteNumber(position.radius);
  target.uncertainty_radius_cells = radius !== null && radius >= 0 ? radius : null;
}

function ensureLocationRef(
  data: Data,
  field: string,
  op: ParsedOperation,
  issues: Issue[],
  target: Record<string, unknown>,
  targetField: string,
  expectedKind: RefKind[],
  scope: RefScope,
): void {
  if (!Object.prototype.hasOwnProperty.call(data, field)) return;
  const raw = data[field];
  if (raw === null) {
    target[targetField] = null;
    return;
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    issues.push(issue('FIELD_TYPE_INVALID', `$.data.${field}`, `${field} 必须是引用字符串`, op));
    return;
  }
  const resolved = resolveRef(raw, expectedKind, scope, { opId: op.opId, line: op.line, field });
  if (!resolved.entry) {
    issues.push(...resolved.issues);
    return;
  }
  target[targetField] = resolved.entry.id;
}

function declaredRef(alias: string, id: string, kind: RefKind, opId: string): RefEntry {
  return { alias, id, kind, rowRev: null, declaredByOpId: opId };
}

export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

const LOCATION_FIELDS = new Set([
  'name', 'aliases', 'kind', 'description', 'parent_ref', 'mobility', 'anchor_ref', 'map_ref', 'position',
  'area', 'terrain', 'access', 'vehicle_profile', 'existence_quality',
]);
const LOCATION_KINDS: readonly string[] = ATLAS_LOCATION_KINDS;
const LOCATION_EXISTENCE = ['confirmed', 'inferred', 'hypothetical'];

/** D01 compileLocationUpsert。 */
export function compileLocationUpsert(op: ParsedOperation, ctx: CompileContext): CompileResult {
  const result = emptyCompileResult();
  const data = dataOf(op);
  const unknown = Object.keys(data).filter((k) => !LOCATION_FIELDS.has(k));
  if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));

  const ref = op.value.ref?.trim();
  const resolvingExisting = Boolean(ref) && !ref!.startsWith('new:');
  const existing = resolvingExisting ? resolveRef(ref, 'location', ctx.scope, { opId: op.opId, line: op.line, field: 'ref' }) : null;
  if (resolvingExisting && !existing?.entry) {
    result.issues.push(...(existing?.issues ?? [issue('REF_UNKNOWN', '$.ref', `找不到地点引用：${ref}`, op)]));
    return result;
  }

  const creating = !existing?.entry;
  const rowId = existing?.entry
    ? existing.entry.id
    : ctx.makeId('location', op.opId, ref && ref.startsWith('new:') ? ref.slice(4) : `auto:${op.opId}`);
  const before = existing?.entry ? ctx.tables.selectOne('locations', ctx.branchId, rowId) : null;
  if (!creating && !before) {
    result.issues.push(issue('REF_UNKNOWN', '$.ref', `引用存在但地点行不存在：${rowId}`, op));
    return result;
  }

  const changes: Data = {};
  const name = asString(data.name);
  if (creating) {
    if (!name) {
      result.issues.push(issue('MINIMUM_FIELD_MISSING', '$.data.name', '新建地点必须给 name', op));
      return result;
    }
    changes.name = name;
  } else if (Object.prototype.hasOwnProperty.call(data, 'name')) {
    if (!name) {
      result.issues.push(issue('FIELD_TYPE_INVALID', '$.data.name', '地点名称 trim 后不能为空', op));
      return result;
    }
    changes.name = name;
  }

  const aliases = ensureAliases(data.aliases, op, '$.data.aliases');
  result.issues.push(...aliases.issues);
  if (aliases.value) changes.aliases_json = aliases.value;

  if (Object.prototype.hasOwnProperty.call(data, 'kind')) {
    const kind = String(data.kind);
    if (!LOCATION_KINDS.includes(kind)) result.issues.push(issue('ENUM_INVALID', '$.data.kind', `地点类型非法：${kind}`, op));
    else changes.kind = kind;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'description')) changes.description = String(data.description ?? '');
  if (Object.prototype.hasOwnProperty.call(data, 'terrain')) changes.terrain = asString(data.terrain) ?? 'unknown';
  if (Object.prototype.hasOwnProperty.call(data, 'mobility')) {
    const mobility = String(data.mobility);
    if (!['fixed', 'mobile'].includes(mobility)) result.issues.push(issue('ENUM_INVALID', '$.data.mobility', `mobility 非法：${mobility}`, op));
    else changes.mobility = mobility;
  }
  // M1-08：新建载具在未写 mobility 时默认 mobile。
  // 只作用于新建；显式 fixed 与既有行的 mobility 一律保留，不用默认值反转作者纠偏。
  if (creating && !Object.prototype.hasOwnProperty.call(data, 'mobility') && changes.kind === 'vehicle') {
    changes.mobility = 'mobile';
  }
  if (Object.prototype.hasOwnProperty.call(data, 'existence_quality')) {
    const q = String(data.existence_quality);
    if (!LOCATION_EXISTENCE.includes(q)) result.issues.push(issue('ENUM_INVALID', '$.data.existence_quality', `existence_quality 非法：${q}`, op));
    else changes.existence_quality = q;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'access')) changes.access_rules_json = data.access ?? null;
  if (Object.prototype.hasOwnProperty.call(data, 'area')) changes.area_geometry_json = data.area ?? null;
  if (Object.prototype.hasOwnProperty.call(data, 'vehicle_profile')) changes.vehicle_profile_json = data.vehicle_profile ?? null;

  ensureLocationRef(data, 'parent_ref', op, result.issues, changes, 'parent_location_id', ['location'], ctx.scope);
  ensureLocationRef(data, 'anchor_ref', op, result.issues, changes, 'anchor_location_id', ['location'], ctx.scope);
  applyPosition(changes, data, op, result.issues, ctx.scope);

  if (result.issues.some((i) => i.severity === 'error')) return result;

  if (creating) {
    const row = createRow('locations', { ...changes }, {
      branchId: ctx.branchId,
      id: rowId,
      turnId: turnIdOf(ctx),
      clockS: ctx.clockS,
      nowWallMs: Date.now(),
      rulesetVersion: 'atlas-1',
    });
    result.mutations.push(entityKeyMutation(ctx, op, rowId, 'location'));
    result.mutations.push(mutation('locations', rowId, null, row, op, basisFor(ctx, op)));
    result.entityKeyWrites = [{ id: rowId, kind: 'location' }];
  } else {
    const merged = applyPatch(before!, changes);
    if (merged.parent_location_id === rowId) {
      result.issues.push(issue('INVARIANT_LOCATION_PARENT_CYCLE', '$.data.parent_ref', '地点不能以自己为父地点', op));
      return result;
    }
    merged.row_rev = Number(before!.row_rev ?? 1) + 1;
    merged.updated_turn_id = turnIdOf(ctx);
    result.mutations.push(mutation('locations', rowId, before, merged, op, basisFor(ctx, op)));
    result.readSet.push(...readSetFor(ctx, 'locations', rowId));
  }
  result.declaredRefs = ref?.startsWith('new:') ? [declaredRef(ref, rowId, 'location', op.opId)] : [];
  return result;
}

const CHARACTER_FIELDS = new Set([
  'registration', 'name', 'aliases', 'role', 'identity', 'description', 'personality', 'importance',
  'importance_reason', 'thought', 'action_tendency', 'physical_status', 'condition_note', 'location_ref',
  'map_ref', 'position', 'mobility_profiles', 'capabilities',
]);
const CHARACTER_ROLES = ['protagonist', 'companion', 'npc'];
const CHARACTER_IMPORTANCE = ['core', 'recurring', 'supporting'];
const CHARACTER_PHYSICAL = ['alive', 'incapacitated', 'dead', 'unknown'];

/**
 * D02 的候选写入：**委派 E15**（`updateMentionCandidates`），不再自带一份内联实现。
 * 这样「重试同一楼不算第二次出现」「>256 时按重要性/时间回收」「第二次提及只触发评估」
 * 这些规则只有一处实现，不会与 E15 漂移。
 * 注意：本函数只产出 mutation（不写库），调用方把它放进当前组以保证可回退。
 */
/**
 * D02 的候选写入。
 *
 * **已知限制（不得当成已完成）**：`src/atlas-db-mentions.ts`（E15）已经是候选生命周期的权威
 * ——它多了「>256 按重要性/时间回收」「重复出现只触发评估」「recent 保留最新 8 条」「同名不同
 * context_key 是两条候选」这些规则，并且已被 `tests/atlas-db-outbox.test.mjs` 等直接覆盖。
 * 但 E15 的入参是真实 `SqlDatabase`，而编译器只持有**只读端口** `TableReadPort`；
 * 在把 E15 的读接口改成端口之前，这里有第二份较简的实现（只做去重计数与 recent 截断）。
 * 把端口当 db 传是错的（E15 内部 queryBound 会抛，整条 op 会退化成 INTERNAL_ERROR），
 * 因此这里明确保留内联版本，并把接线列为待办，而不是留一个假的委派。
 */
/**
 * D02 的候选写入：**委派 E15**（`updateMentionCandidates`），不再自带第二份实现。
 * 只传 `reads`（编译器的只读端口）而不是 `db` —— 编译器刻意不持有 SqlDatabase。
 * 「重试同一楼不算第二次出现」「>256 按重要性/时间回收」「recent 保留最新 8 条」
 * 「同名不同 context_key 是两条候选」这些规则因此只有一处实现，不会漂移。
 */
function mentionMutations(
  ctx: CompileContext,
  op: ParsedOperation,
  params: { name: string; identity: string; importanceHint: 'none' | 'review' | 'core'; sourceKeys: string[] },
): { mutations: RowMutation[]; issues: Issue[] } {
  const observed = updateMentionCandidates({
    reads: ctx.tables,
    branchId: ctx.branchId,
    turnId: turnIdOf(ctx),
    clockS: ctx.clockS,
    nowWallMs: Date.now(),
    rulesetVersion: 'atlas-1',
    observations: [
      {
        name: params.name,
        kindHint: 'character',
        identity: params.identity,
        contextSummary: params.identity,
        lorebookSourceKeys: params.sourceKeys,
        importanceHint: params.importanceHint,
      },
    ],
    makeId: (kind, opId, alias) => ctx.makeId(kind, opId, alias),
  });
  void op;
  return { mutations: observed.mutations, issues: observed.issues };
}
/** D02 compileCharacterUpsert。 */
export function compileCharacterUpsert(op: ParsedOperation, ctx: CompileContext): CompileResult {
  const result = emptyCompileResult();
  const data = dataOf(op);
  const unknown = Object.keys(data).filter((k) => !CHARACTER_FIELDS.has(k));
  if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));

  const ref = op.value.ref?.trim();
  const registration = data.registration === undefined ? 'auto' : String(data.registration);
  if (!['auto', 'watch'].includes(registration)) {
    result.issues.push(issue('ENUM_INVALID', '$.data.registration', `registration 非法：${registration}`, op));
    return result;
  }

  const resolvingExisting = Boolean(ref) && !ref!.startsWith('new:');
  const existing = resolvingExisting ? resolveRef(ref, 'character', ctx.scope, { opId: op.opId, line: op.line, field: 'ref' }) : null;
  if (resolvingExisting && !existing?.entry) {
    result.issues.push(...(existing?.issues ?? [issue('REF_UNKNOWN', '$.ref', `找不到人物引用：${ref}`, op)]));
    return result;
  }

  const creating = !existing?.entry;
  const name = asString(data.name);
  const identity = asString(data.identity) ?? '';
  const importanceReason = asString(data.importance_reason);
  const hasImportance = Object.prototype.hasOwnProperty.call(data, 'importance') || importanceReason !== null;
  const hasBootstrapHint = identity !== '' || hasImportance;
  const sourceKeys = Array.isArray(op.value.source) ? op.value.source : op.value.source ? [op.value.source] : [];

  // §8.4：registration=watch 只进候选，不创建人物实体；候选只需 name。
  if (registration === 'watch' && creating) {
    if (!name) {
      result.issues.push(issue('MINIMUM_FIELD_MISSING', '$.data.name', 'watch 候选至少需要 name', op));
      return result;
    }
    const mention = mentionMutations(ctx, op, { name, identity, importanceHint: 'review', sourceKeys });
    result.mutations.push(...mention.mutations);
    result.issues.push(...mention.issues);
    result.issues.push({
      code: 'MENTION_TRACKED',
      path: '$.data.name',
      message: `「${name}」只进入临时提及候选，未创建人物实体（registration=watch）`,
      severity: 'warning',
      retryable: false,
      opId: op.opId,
      line: op.line,
    });
    return result;
  }

  // §8.4：auto 下已有身份/重要性线索可以首楼建档；仅有名字而无理由时暂存候选。
  if (creating && !hasBootstrapHint) {
    if (name) {
      const mention = mentionMutations(ctx, op, { name, identity, importanceHint: 'review', sourceKeys });
      result.mutations.push(...mention.mutations);
      result.issues.push(...mention.issues);
      result.issues.push({
        code: 'MENTION_TRACKED',
        path: '$.data.name',
        message: `「${name}」尚无身份/重要性线索，先记为临时提及候选，不创建人物实体`,
        severity: 'warning',
        retryable: false,
        opId: op.opId,
        line: op.line,
      });
      return result;
    }
    result.issues.push(
      issue('MINIMUM_FIELD_MISSING', '$.data.name', '新建人物必须给 name，并至少给 identity / importance / importance_reason 之一', op),
    );
    return result;
  }

  const rowId = existing?.entry
    ? existing.entry.id
    : ctx.makeId('character', op.opId, ref && ref.startsWith('new:') ? ref.slice(4) : `auto:${op.opId}`);
  const before = existing?.entry ? ctx.tables.selectOne('characters', ctx.branchId, rowId) : null;
  if (!creating && !before) {
    result.issues.push(issue('REF_UNKNOWN', '$.ref', `引用存在但人物行不存在：${rowId}`, op));
    return result;
  }

  const changes: Data = {};
  if (creating) {
    changes.name = name;
  } else if (Object.prototype.hasOwnProperty.call(data, 'name')) {
    if (!name) {
      result.issues.push(issue('FIELD_TYPE_INVALID', '$.data.name', '人物名称 trim 后不能为空', op));
      return result;
    }
    changes.name = name;
  }

  const aliases = ensureAliases(data.aliases, op, '$.data.aliases');
  result.issues.push(...aliases.issues);
  if (aliases.value) changes.aliases_json = aliases.value;

  if (Object.prototype.hasOwnProperty.call(data, 'role')) {
    const role = String(data.role);
    if (!CHARACTER_ROLES.includes(role)) result.issues.push(issue('ENUM_INVALID', '$.data.role', `role 非法：${role}`, op));
    else changes.role = role;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'importance')) {
    const importance = String(data.importance);
    if (!CHARACTER_IMPORTANCE.includes(importance)) result.issues.push(issue('ENUM_INVALID', '$.data.importance', `importance 非法：${importance}`, op));
    else changes.importance = importance;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'physical_status')) {
    const st = String(data.physical_status);
    if (!CHARACTER_PHYSICAL.includes(st)) result.issues.push(issue('ENUM_INVALID', '$.data.physical_status', `physical_status 非法：${st}`, op));
    else changes.physical_status = st;
  }
  for (const field of ['identity', 'description', 'personality', 'thought', 'action_tendency', 'condition_note']) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      changes[field] = typeof data[field] === 'string' ? data[field] : data[field] === null ? '' : String(data[field]);
    }
  }
  if (Object.prototype.hasOwnProperty.call(data, 'importance_reason')) {
    changes.importance_reason = typeof data.importance_reason === 'string' ? data.importance_reason : String(data.importance_reason ?? '');
  }
  if (Object.prototype.hasOwnProperty.call(data, 'mobility_profiles')) {
    const list = Array.isArray(data.mobility_profiles) ? data.mobility_profiles : null;
    if (!list) result.issues.push(issue('FIELD_TYPE_INVALID', '$.data.mobility_profiles', 'mobility_profiles 必须是数组', op));
    else if (list.length > MOBILITY_PROFILE_LIMIT) result.issues.push(issue('FIELD_LIMIT_EXCEEDED', '$.data.mobility_profiles', `最多 ${MOBILITY_PROFILE_LIMIT} 种移动方式`, op));
    else changes.mobility_profiles_json = list;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'capabilities')) {
    const list = Array.isArray(data.capabilities) ? data.capabilities : null;
    if (!list) result.issues.push(issue('FIELD_TYPE_INVALID', '$.data.capabilities', 'capabilities 必须是数组', op));
    else if (list.length > CAPABILITY_LIMIT) result.issues.push(issue('FIELD_LIMIT_EXCEEDED', '$.data.capabilities', `最多 ${CAPABILITY_LIMIT} 项能力`, op));
    else changes.capabilities_json = list;
  }

  // §8.2 / D02：decision 阶段只写想法/倾向/注意，不改身份与位置。
  if (ctx.phase === 'decision' && !creating) {
    const allowed = new Set(['thought', 'action_tendency', 'importance', 'importance_reason', 'condition_note', 'physical_status']);
    const illegal = Object.keys(changes).filter((k) => !allowed.has(k));
    if (illegal.length) {
      result.issues.push(
        issue('PHASE_FIELD_NOT_ALLOWED', '$.data', `decision 阶段不得修改这些字段：${illegal.join('、')}（本阶段只写想法/倾向/注意）`, op),
      );
      return result;
    }
  }

  ensureLocationRef(data, 'location_ref', op, result.issues, changes, 'location_id', ['location'], ctx.scope);
  if(before&&Object.prototype.hasOwnProperty.call(changes,'location_id')&&changes.location_id!==before.location_id&&!Object.prototype.hasOwnProperty.call(data,'position')){
    Object.assign(changes,{map_id:null,grid_x:null,grid_y:null,coord_precision:'unknown',uncertainty_radius_cells:null});
  }
  applyPosition(changes, data, op, result.issues, ctx.scope);

  if (result.issues.some((i) => i.severity === 'error')) return result;

  if (creating) {
    const row = createRow('characters', { ...changes }, {
      branchId: ctx.branchId,
      id: rowId,
      turnId: turnIdOf(ctx),
      clockS: ctx.clockS,
      nowWallMs: Date.now(),
      rulesetVersion: 'atlas-1',
    });
    result.mutations.push(entityKeyMutation(ctx, op, rowId, 'character'));
    result.mutations.push(mutation('characters', rowId, null, row, op, basisFor(ctx, op)));
    result.entityKeyWrites = [{ id: rowId, kind: 'character' }];
  } else {
    const merged = applyPatch(before!, changes);
    merged.row_rev = Number(before!.row_rev ?? 1) + 1;
    merged.updated_turn_id = turnIdOf(ctx);
    result.mutations.push(mutation('characters', rowId, before, merged, op, basisFor(ctx, op)));
    result.readSet.push(...readSetFor(ctx, 'characters', rowId));
  }
  result.declaredRefs = ref?.startsWith('new:') ? [declaredRef(ref, rowId, 'character', op.opId)] : [];
  return result;
}

const ITEM_FIELDS = new Set([
  'name', 'aliases', 'kind', 'description', 'quantity', 'unit', 'condition_note', 'properties', 'status', 'placement',
]);
const ITEM_KINDS = ['object', 'resource', 'document', 'equipment', 'container', 'other'];
const ITEM_STATUS = ['active', 'consumed', 'destroyed', 'lost', 'merged', 'archived'];

/** D03 compileItemUpsert。 */
export function compileItemUpsert(op: ParsedOperation, ctx: CompileContext): CompileResult {
  const result = emptyCompileResult();
  const data = dataOf(op);
  const unknown = Object.keys(data).filter((k) => !ITEM_FIELDS.has(k));
  if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));

  const ref = op.value.ref?.trim();
  const resolvingExisting = Boolean(ref) && !ref!.startsWith('new:');
  const existing = resolvingExisting ? resolveRef(ref, 'item', ctx.scope, { opId: op.opId, line: op.line, field: 'ref' }) : null;
  if (resolvingExisting && !existing?.entry) {
    result.issues.push(...(existing?.issues ?? [issue('REF_UNKNOWN', '$.ref', `找不到物品引用：${ref}`, op)]));
    return result;
  }
  const creating = !existing?.entry;
  const name = asString(data.name);
  if (creating && !name) {
    result.issues.push(issue('MINIMUM_FIELD_MISSING', '$.data.name', '新建物品必须给 name', op));
    return result;
  }
  const rowId = existing?.entry
    ? existing.entry.id
    : ctx.makeId('item', op.opId, ref && ref.startsWith('new:') ? ref.slice(4) : `auto:${op.opId}`);
  const before = existing?.entry ? ctx.tables.selectOne('items', ctx.branchId, rowId) : null;
  if (!creating && !before) {
    result.issues.push(issue('REF_UNKNOWN', '$.ref', `引用存在但物品行不存在：${rowId}`, op));
    return result;
  }

  const changes: Data = {};
  if (creating) changes.name = name;
  else if (Object.prototype.hasOwnProperty.call(data, 'name')) changes.name = name;
  const aliases = ensureAliases(data.aliases, op, '$.data.aliases');
  result.issues.push(...aliases.issues);
  if (aliases.value) changes.aliases_json = aliases.value;

  if (Object.prototype.hasOwnProperty.call(data, 'kind')) {
    const kind = String(data.kind);
    if (!ITEM_KINDS.includes(kind)) result.issues.push(issue('ENUM_INVALID', '$.data.kind', `物品类别非法：${kind}`, op));
    else changes.kind = kind;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'status')) {
    const st = String(data.status);
    if (!ITEM_STATUS.includes(st)) result.issues.push(issue('ENUM_INVALID', '$.data.status', `物品状态非法：${st}`, op));
    else changes.status = st;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'description')) changes.description = String(data.description ?? '');
  if (Object.prototype.hasOwnProperty.call(data, 'condition_note')) changes.condition_note = String(data.condition_note ?? '');
  if (Object.prototype.hasOwnProperty.call(data, 'unit')) changes.unit = asString(data.unit) ?? '件';

  // §16.2：数量未知不得默认为「很多」；明确单件可以是 1；数量为 0 转为 consumed。
  if (Object.prototype.hasOwnProperty.call(data, 'quantity')) {
    if (data.quantity === null) {
      changes.quantity = null;
    } else {
      const q = asFiniteNumber(data.quantity);
      if (q === null || q < 0) {
        result.issues.push(issue('QUANTITY_INVALID', '$.data.quantity', 'quantity 必须是有限非负数或 null（未知）', op));
      } else {
        changes.quantity = q;
        if (q === 0) changes.status = 'consumed';
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(data, 'properties')) {
    const list = Array.isArray(data.properties) ? data.properties : null;
    if (!list) result.issues.push(issue('FIELD_TYPE_INVALID', '$.data.properties', 'properties 必须是数组', op));
    else if (list.length > ITEM_PROPERTY_LIMIT) result.issues.push(issue('FIELD_LIMIT_EXCEEDED', '$.data.properties', `properties 最多 ${ITEM_PROPERTY_LIMIT} 项`, op));
    else changes.properties_json = list;
  }

  // §8.4：创建时可有 placement；已存在物品换落点必须走 item.transfer。
  if (creating && Object.prototype.hasOwnProperty.call(data, 'placement')) {
    const placement = data.placement;
    if (isPlainObject(placement)) {
      if (Object.prototype.hasOwnProperty.call(placement, 'holder_ref')) {
        const r = resolveRef(String(placement.holder_ref), 'character', ctx.scope, { opId: op.opId, field: 'placement.holder_ref' });
        if (r.entry) changes.holder_character_id = r.entry.id;
        else result.issues.push(...r.issues);
      } else if (Object.prototype.hasOwnProperty.call(placement, 'container_ref')) {
        const r = resolveRef(String(placement.container_ref), 'item', ctx.scope, { opId: op.opId, field: 'placement.container_ref' });
        if (r.entry) changes.container_item_id = r.entry.id;
        else result.issues.push(...r.issues);
      } else if (Object.prototype.hasOwnProperty.call(placement, 'location_ref')) {
        const r = resolveRef(String(placement.location_ref), 'location', ctx.scope, { opId: op.opId, field: 'placement.location_ref' });
        if (r.entry) changes.location_id = r.entry.id;
        else result.issues.push(...r.issues);
      } else {
        result.issues.push(issue('TRANSFER_TARGET_CONFLICT', '$.data.placement', 'placement 需要 holder_ref / container_ref / location_ref 之一', op));
      }
    } else {
      result.issues.push(issue('FIELD_TYPE_INVALID', '$.data.placement', 'placement 必须是 {holder_ref|container_ref|location_ref}', op));
    }
  }

  if (result.issues.some((i) => i.severity === 'error')) return result;

  if (creating) {
    const row = createRow('items', { ...changes }, {
      branchId: ctx.branchId,
      id: rowId,
      turnId: turnIdOf(ctx),
      clockS: ctx.clockS,
      nowWallMs: Date.now(),
      rulesetVersion: 'atlas-1',
    });
    result.mutations.push(entityKeyMutation(ctx, op, rowId, 'item'));
    result.mutations.push(mutation('items', rowId, null, row, op, basisFor(ctx, op)));
    result.entityKeyWrites = [{ id: rowId, kind: 'item' }];
  } else {
    const merged = applyPatch(before!, changes);
    merged.row_rev = Number(before!.row_rev ?? 1) + 1;
    merged.updated_turn_id = turnIdOf(ctx);
    result.mutations.push(mutation('items', rowId, before, merged, op, basisFor(ctx, op)));
    result.readSet.push(...readSetFor(ctx, 'items', rowId));
  }
  result.declaredRefs = ref?.startsWith('new:') ? [declaredRef(ref, rowId, 'item', op.opId)] : [];
  return result;
}

/** D04 compileItemTransfer：互斥落点，按数量拆分，持有与所有权分开。 */
export function compileItemTransfer(op: ParsedOperation, ctx: CompileContext): CompileResult {
  const result = emptyCompileResult();
  const data = dataOf(op);
  const ref = op.value.ref?.trim();
  if (!ref) {
    result.issues.push(issue('MINIMUM_FIELD_MISSING', '$.ref', 'item.transfer 需要 ref', op));
    return result;
  }
  const resolved = resolveRef(ref, 'item', ctx.scope, { opId: op.opId, line: op.line, field: 'ref' });
  if (!resolved.entry) {
    result.issues.push(...resolved.issues);
    return result;
  }
  const rowId = resolved.entry.id;
  const before = ctx.tables.selectOne('items', ctx.branchId, rowId) ?? ctx.newItemRows?.get(rowId) ?? null;
  if (!before) {
    result.issues.push(issue('REF_UNKNOWN', '$.ref', `物品行不存在：${rowId}`, op));
    return result;
  }

  const to = data.to;
  if (!isPlainObject(to)) {
    result.issues.push(issue('MINIMUM_FIELD_MISSING', '$.data.to', 'item.transfer 需要 to={holder_ref|container_ref|location_ref|unknown}', op));
    return result;
  }
  const kinds = ['holder_ref', 'container_ref', 'location_ref'].filter(
    (k) => Object.prototype.hasOwnProperty.call(to, k) && to[k] !== null,
  );
  const isUnknown = to.unknown === true;
  if (isUnknown && kinds.length > 0) {
    result.issues.push(issue('TRANSFER_TARGET_CONFLICT', '$.data.to', 'to 的落点互斥：unknown 不能与 holder_ref/container_ref/location_ref 同时出现', op));
    return result;
  }
  if (!isUnknown && kinds.length !== 1) {
    result.issues.push(issue('TRANSFER_TARGET_CONFLICT', '$.data.to', `to 必须且只能给出一种落点（收到 ${kinds.length} 种）`, op));
    return result;
  }

  const changes: Data = {
    holder_character_id: null,
    container_item_id: null,
    location_id: null,
    map_id: null,
    grid_x: null,
    grid_y: null,
    coord_precision: 'unknown',
    uncertainty_radius_cells: null,
  };

  if (kinds[0] === 'holder_ref') {
    const r = resolveRef(String(to.holder_ref), 'character', ctx.scope, { opId: op.opId, field: 'to.holder_ref' });
    if (!r.entry) {
      result.issues.push(...r.issues);
      return result;
    }
    changes.holder_character_id = r.entry.id;
  } else if (kinds[0] === 'container_ref') {
    const r = resolveRef(String(to.container_ref), 'item', ctx.scope, { opId: op.opId, field: 'to.container_ref' });
    if (!r.entry) {
      result.issues.push(...r.issues);
      return result;
    }
    if (r.entry.id === rowId) {
      result.issues.push(issue('INVARIANT_CONTAINER_CYCLE', '$.data.to.container_ref', '物品不能装在自己里面', op));
      return result;
    }
    changes.container_item_id = r.entry.id;
  } else if (kinds[0] === 'location_ref') {
    const r = resolveRef(String(to.location_ref), 'location', ctx.scope, { opId: op.opId, field: 'to.location_ref' });
    if (!r.entry) {
      result.issues.push(...r.issues);
      return result;
    }
    changes.location_id = r.entry.id;
    if (isPlainObject(to.position)) {
      const x = asFiniteNumber(to.position.x);
      const y = asFiniteNumber(to.position.y);
      const mapRef = typeof data.map_ref === 'string' ? data.map_ref : null;
      if (x !== null && y !== null && mapRef) {
        const mr = resolveRef(mapRef, 'map', ctx.scope, { opId: op.opId, field: 'map_ref' });
        if (mr.entry) {
          changes.map_id = mr.entry.id;
          changes.grid_x = x;
          changes.grid_y = y;
          changes.coord_precision = String(to.position.precision ?? 'approximate');
        } else {
          result.issues.push(...mr.issues);
        }
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(data, 'owner_ref')) {
    if (data.owner_ref === null) {
      changes.owner_entity_id = null;
    } else {
      const r = resolveRef(String(data.owner_ref), ['character', 'faction'], ctx.scope, { opId: op.opId, field: 'owner_ref' });
      if (!r.entry) {
        result.issues.push(...r.issues);
        return result;
      }
      changes.owner_entity_id = r.entry.id;
    }
  }

  const movedQty = Object.prototype.hasOwnProperty.call(data, 'quantity') ? asFiniteNumber(data.quantity) : null;
  const heldQty = typeof before.quantity === 'number' ? before.quantity : null;
  if (Object.prototype.hasOwnProperty.call(data, 'quantity') && (movedQty === null || movedQty <= 0)) {
    result.issues.push(issue('QUANTITY_INVALID', '$.data.quantity', '转移数量必须为正有限数', op));
    return result;
  }
  if (movedQty !== null && heldQty !== null && movedQty > heldQty) {
    result.issues.push(issue('QUANTITY_INSUFFICIENT', '$.data.quantity', `转移数量 ${movedQty} 超过持有量 ${heldQty}`, op));
    return result;
  }

  if (result.issues.some((i) => i.severity === 'error')) return result;

  const turnId = turnIdOf(ctx);
  if (movedQty !== null && heldQty !== null && movedQty < heldQty) {
    const remaining = heldQty - movedQty;
    const sourceAfter = applyPatch(before, { quantity: remaining, row_rev: Number(before.row_rev ?? 1) + 1, updated_turn_id: turnId });
    result.mutations.push(mutation('items', rowId, before, sourceAfter, op, basisFor(ctx, op)));
    const newId = ctx.makeId('item', op.opId, `split:${rowId}:${movedQty}`);
    const newRow = createRow(
      'items',
      { ...before, ...changes, quantity: movedQty },
      { branchId: ctx.branchId, id: newId, turnId, clockS: ctx.clockS, nowWallMs: Date.now(), rulesetVersion: 'atlas-1' },
    );
    newRow.row_rev = 1;
    result.mutations.push(entityKeyMutation(ctx, op, newId, 'item'));
    result.mutations.push(mutation('items', newId, null, newRow, op, basisFor(ctx, op)));
    result.entityKeyWrites = [{ id: newId, kind: 'item' }];
    result.operationKeys = [{ groupKey: `item:${rowId}`, opKey: `transfer:${op.opId}` }];
    result.readSet.push(...readSetFor(ctx, 'items', rowId));
    return result;
  }

  const after = applyPatch(before, { ...changes, row_rev: Number(before.row_rev ?? 1) + 1, updated_turn_id: turnId });
  if (movedQty !== null && heldQty !== null) after.quantity = Math.max(0, heldQty - movedQty);
  if (after.quantity === 0) after.status = 'consumed';
  result.mutations.push(mutation('items', rowId, before, after, op, basisFor(ctx, op)));
  result.operationKeys = [{ groupKey: `item:${rowId}`, opKey: `transfer:${op.opId}` }];
  result.readSet.push(...readSetFor(ctx, 'items', rowId));
  return result;
}

const FACTION_FIELDS = new Set(['name', 'aliases', 'kind', 'description', 'goal', 'headquarters_ref', 'capabilities', 'status']);
const FACTION_KINDS = ['nation', 'organization', 'family', 'team', 'other'];
const FACTION_STATUS = ['active', 'dissolved', 'merged', 'archived'];

/** D05 compileFactionUpsert。 */
export function compileFactionUpsert(op: ParsedOperation, ctx: CompileContext): CompileResult {
  const result = emptyCompileResult();
  const data = dataOf(op);
  const unknown = Object.keys(data).filter((k) => !FACTION_FIELDS.has(k));
  if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));

  const ref = op.value.ref?.trim();
  const resolvingExisting = Boolean(ref) && !ref!.startsWith('new:');
  const existing = resolvingExisting ? resolveRef(ref, 'faction', ctx.scope, { opId: op.opId, line: op.line, field: 'ref' }) : null;
  if (resolvingExisting && !existing?.entry) {
    result.issues.push(...(existing?.issues ?? [issue('REF_UNKNOWN', '$.ref', `找不到势力引用：${ref}`, op)]));
    return result;
  }
  const creating = !existing?.entry;
  const name = asString(data.name);
  if (creating && !name) {
    result.issues.push(issue('MINIMUM_FIELD_MISSING', '$.data.name', '新建势力必须给 name', op));
    return result;
  }
  const rowId = existing?.entry
    ? existing.entry.id
    : ctx.makeId('faction', op.opId, ref && ref.startsWith('new:') ? ref.slice(4) : `auto:${op.opId}`);
  const before = existing?.entry ? ctx.tables.selectOne('factions', ctx.branchId, rowId) : null;
  if (!creating && !before) {
    result.issues.push(issue('REF_UNKNOWN', '$.ref', `引用存在但势力行不存在：${rowId}`, op));
    return result;
  }

  const changes: Data = {};
  if (creating) changes.name = name;
  else if (Object.prototype.hasOwnProperty.call(data, 'name')) changes.name = name;
  const aliases = ensureAliases(data.aliases, op, '$.data.aliases');
  result.issues.push(...aliases.issues);
  if (aliases.value) changes.aliases_json = aliases.value;

  if (Object.prototype.hasOwnProperty.call(data, 'kind')) {
    const kind = String(data.kind);
    if (!FACTION_KINDS.includes(kind)) result.issues.push(issue('ENUM_INVALID', '$.data.kind', `势力类型非法：${kind}`, op));
    else changes.kind = kind;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'status')) {
    const st = String(data.status);
    if (!FACTION_STATUS.includes(st)) result.issues.push(issue('ENUM_INVALID', '$.data.status', `势力状态非法：${st}`, op));
    else changes.status = st;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'description')) changes.description = String(data.description ?? '');
  if (Object.prototype.hasOwnProperty.call(data, 'goal')) changes.goal = String(data.goal ?? '');
  if (Object.prototype.hasOwnProperty.call(data, 'capabilities')) {
    const list = Array.isArray(data.capabilities) ? data.capabilities : null;
    if (!list) result.issues.push(issue('FIELD_TYPE_INVALID', '$.data.capabilities', 'capabilities 必须是数组', op));
    else if (list.length > CAPABILITY_LIMIT) result.issues.push(issue('FIELD_LIMIT_EXCEEDED', '$.data.capabilities', `最多 ${CAPABILITY_LIMIT} 项能力`, op));
    else changes.capabilities_json = list;
  }
  ensureLocationRef(data, 'headquarters_ref', op, result.issues, changes, 'headquarters_location_id', ['location'], ctx.scope);

  if (result.issues.some((i) => i.severity === 'error')) return result;

  const turnId = turnIdOf(ctx);
  if (creating) {
    const row = createRow('factions', { ...changes }, {
      branchId: ctx.branchId,
      id: rowId,
      turnId,
      clockS: ctx.clockS,
      nowWallMs: Date.now(),
      rulesetVersion: 'atlas-1',
    });
    result.mutations.push(entityKeyMutation(ctx, op, rowId, 'faction'));
    result.mutations.push(mutation('factions', rowId, null, row, op, basisFor(ctx, op)));
    result.entityKeyWrites = [{ id: rowId, kind: 'faction' }];
  } else {
    const merged = applyPatch(before!, changes);
    merged.row_rev = Number(before!.row_rev ?? 1) + 1;
    merged.updated_turn_id = turnId;
    result.mutations.push(mutation('factions', rowId, before, merged, op, basisFor(ctx, op)));
    result.readSet.push(...readSetFor(ctx, 'factions', rowId));
  }
  result.declaredRefs = ref?.startsWith('new:') ? [declaredRef(ref, rowId, 'faction', op.opId)] : [];
  return result;
}
