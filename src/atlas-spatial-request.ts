/**
 * atlas-spatial-request.ts — M2/P04：`map.layout.request` 的语义编译器。
 *
 * 职责边界（与 vendor/atlas-spatial 严格分开）：
 * - 本模块**只产出候选变更**：一条普通的 `maps` RowMutation，把模型给的「小约束」
 *   写进 `frame_json.atlasLayoutRequest`。不执行 SQL、不发起网络、不生成几何。
 * - 几何/布局由空间工具包在渲染侧生成；这里只负责引用解析、合并与冲突判定。
 *
 * 三条不可动摇的规则：
 * 1. 省略即保持：spec 里没给的集合/键不动已保存约束；删除只能走显式 `deletes`。
 * 2. 同批累积在**已编译候选态**进行：同一张图的后一个请求并进前一个的结果，
 *    绝不抹掉前一个独立房间（journal 的同行合并是后写覆盖，所以必须在这里累积）。
 * 3. 冲突不静默挑一个：mapId 不一致 / kind 冲突 / 同批同 id 不同值 / 父图子图混用
 *    一律 LAYOUT_REQUEST_CONFLICT，由模型自己消歧。
 */

import type { Issue, ParsedOperation, RowMutation } from './atlas-ops-contract.ts';
import type { CompileContext, CompileResult } from './atlas-ops-compile-types.ts';
import { emptyCompileResult } from './atlas-ops-compile-types.ts';
import { LAYOUT_SPEC_REF_FIELDS, resolveLayoutSpecRefs, resolveRef } from './atlas-ops-refs.ts';
import { LAYOUT_SPEC_COLLECTIONS, LAYOUT_SPEC_SCALARS, normalizeLayoutSpec } from './atlas-ops-normalize.ts';
import { applyPatch } from './atlas-ops-entities.ts';
import { ATLAS_ERROR_CODES } from './atlas-ops-errors.ts';

/** 规格中本操作专属的错误码（已登记进 ATLAS_ERROR_CODES）。 */
const LAYOUT_REQUEST_CONFLICT = ATLAS_ERROR_CODES.LAYOUT_REQUEST_CONFLICT;

/** floor 模板只认这些集合；city 模板只认 districts/buildings。混用即冲突。 */
const FLOOR_COLLECTIONS = ['rooms', 'contents', 'actors', 'items'] as const;
const CITY_COLLECTIONS = ['districts', 'buildings'] as const;

/** 指令型字段：不写进持久化约束（否则会把一次性意图固化下来）。 */
const DIRECTIVE_KEYS = ['deletes', 'rebuild'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function issue(code: string, path: string, message: string, op: ParsedOperation, extra: Partial<Issue> = {}): Issue {
  return { code, path, message, severity: 'error', retryable: true, opId: op.opId, line: op.line, ...extra };
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

function basisOf(ctx: CompileContext, op: ParsedOperation): Record<string, unknown> {
  if (ctx.basisFor) return ctx.basisFor(op, { certainty: 'inferred' }) as unknown as Record<string, unknown>;
  return {
    kind: ctx.phase === 'geography' ? 'estimate' : ctx.phase === 'observe' ? 'story' : 'simulation',
    sources: [],
    causes: [],
    reason: op.value.why ?? '布局约束请求',
    verification: ctx.phase === 'observe' ? 'source_bound' : 'causal',
    certainty: 'inferred',
  };
}

/** 稳定序列化：对象键排序，数组保序。用于签名与同值比较，不受键序影响。 */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** FNV-1a ×4 轮扩展 → 32 位十六进制。仅用于程序内部签名，不是安全哈希。 */
function signatureOf(text: string): string {
  let out = '';
  let seed = 0x811c9dc5;
  while (out.length < 32) {
    let h = seed;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i) + out.length;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
    seed = (h ^ 0x9e3779b9) >>> 0;
  }
  return out.slice(0, 32);
}

/**
 * 逐键合并一行约束。strict=true（同批累积）时，同一键出现不同值记冲突而不是覆盖。
 */
function mergeRow(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  path: string,
  strict: boolean,
  conflicts: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (!(key in out)) {
      out[key] = value;
      continue;
    }
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = mergeRow(out[key] as Record<string, unknown>, value, `${path}.${key}`, strict, conflicts);
      continue;
    }
    if (canonicalJson(out[key]) === canonicalJson(value)) continue;
    if (strict) conflicts.push(`${path}.${key}`);
    out[key] = value;
  }
  return out;
}

/**
 * 增量合并：省略=保持、显式 deletes 才删除、同 id 逐键合并。
 * strict=true 用于「同批后一个请求并进前一个」——此时同键不同值是矛盾，不是更新。
 */
function mergeConstraints(
  baseSpec: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
  strict: boolean,
): { spec: Record<string, unknown>; conflicts: string[] } {
  const conflicts: string[] = [];
  const out: Record<string, unknown> = isPlainObject(baseSpec) ? { ...baseSpec } : {};

  const deletes = incoming['deletes'];
  if (isPlainObject(deletes)) {
    // The geometry generator also merges previous constraints; carry the
    // explicit deletion through that boundary so removed rows cannot return.
    out['deletes'] = deletes;
    for (const [collection, ids] of Object.entries(deletes)) {
      if (!Array.isArray(ids)) continue;
      const rows = out[collection];
      if (!Array.isArray(rows)) continue;
      const drop = new Set(ids.map((v) => String(v)));
      out[collection] = rows.filter((row) => !(isPlainObject(row) && drop.has(String(row['id']))));
    }
  }

  for (const collection of LAYOUT_SPEC_COLLECTIONS) {
    const rows = incoming[collection];
    if (!Array.isArray(rows)) continue;
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of Array.isArray(out[collection]) ? (out[collection] as unknown[]) : []) {
      if (isPlainObject(row)) byId.set(String(row['id']), row);
    }
    for (const raw of rows) {
      if (!isPlainObject(raw)) continue;
      const id = String(raw['id']);
      const existing = byId.get(id);
      byId.set(id, existing ? mergeRow(existing, raw, `spec.${collection}[${id}]`, strict, conflicts) : { ...raw });
    }
    out[collection] = [...byId.values()];
  }

  for (const key of LAYOUT_SPEC_SCALARS) {
    if ((DIRECTIVE_KEYS as readonly string[]).includes(key)) continue;
    const value = incoming[key];
    if (value === undefined) continue;
    if (strict && key in out && canonicalJson(out[key]) !== canonicalJson(value)) {
      conflicts.push(`spec.${key}`);
      continue;
    }
    out[key] = value;
  }

  delete out['rebuild'];
  return { spec: out, conflicts };
}

/** 收集 spec 里解析完成、指向 location 的实体 ID（用于父图/子图校验）。 */
function collectLocationRefs(spec: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const [collection, fields] of Object.entries(LAYOUT_SPEC_REF_FIELDS)) {
    const rows = spec[collection];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!isPlainObject(row)) continue;
      for (const [field, kind] of Object.entries(fields)) {
        if (kind !== 'location') continue;
        const value = row[field];
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (trimmed === '' || trimmed.startsWith('new:')) continue;
        out.add(trimmed);
      }
    }
  }
  return [...out];
}

type BatchEntry = { kind: string; spec: Record<string, unknown> };

/**
 * 同批累积表：以 CompileContext 对象为键（compileOperations 每次调用建一个新 ctx），
 * 因此只在单次编译内可见，不跨调用残留、不需要手工清理，也不引入模块级可变状态。
 */
const BATCH_STATE = new WeakMap<CompileContext, Map<string, BatchEntry>>();

/** M2/P04 compileMapLayoutRequest：小约束 → maps.frame_json.atlasLayoutRequest。 */
export function compileMapLayoutRequest(op: ParsedOperation, ctx: CompileContext): CompileResult {
  const result = emptyCompileResult();
  const data = (op.value.data ?? {}) as Record<string, unknown>;

  const kind = typeof data['kind'] === 'string' ? data['kind'].trim().toLowerCase() : '';
  if (kind !== 'floor' && kind !== 'city') {
    result.issues.push(
      issue(
        ATLAS_ERROR_CODES.MINIMUM_FIELD_MISSING,
        '$.data.kind',
        `map.layout.request kind must be one of {floor,city}; got ${JSON.stringify(data['kind'] ?? null)}`,
        op,
      ),
    );
    return result;
  }

  // spec 深校验 + 剥离程序独占字段（SYSTEM_FIELD_IGNORED 在这里才上报：
  // validateMinimum 通过时不会保留这些 warning）。
  const cleaned = normalizeLayoutSpec(data, { opId: op.opId, line: op.line });
  result.issues.push(...cleaned.issues);
  if (!cleaned.ok || !cleaned.spec) return result;
  const spec: Record<string, unknown> = { ...cleaned.spec };

  const ref = op.value.ref?.trim() ?? '';
  if (ref === '') {
    result.issues.push(issue(ATLAS_ERROR_CODES.MINIMUM_FIELD_MISSING, '$.ref', 'map.layout.request 需要 ref 指定地图', op));
    return result;
  }
  const resolved = resolveRef(ref, 'map', ctx.scope, { opId: op.opId, line: op.line, field: 'ref' });
  if (!resolved.entry) {
    result.issues.push(...resolved.issues);
    return result;
  }
  const mapId = resolved.entry.id;

  const before = ctx.tables.selectOne('maps', ctx.branchId, mapId);
  if (!before) {
    result.issues.push(issue(ATLAS_ERROR_CODES.REF_UNKNOWN, '$.ref', `地图行不存在：${mapId}`, op));
    return result;
  }

  // spec.mapId 规范化：必须与 ref 指向同一张图，否则冲突（不静默挑一个）。
  const specMapId = typeof spec['mapId'] === 'string' ? spec['mapId'].trim() : '';
  if (specMapId !== '' && specMapId !== mapId) {
    result.issues.push(
      issue(
        LAYOUT_REQUEST_CONFLICT,
        '$.data.spec.mapId',
        `spec.mapId（${specMapId}）与 ref 解析出的地图（${mapId}）不一致；同一请求不能跨图。`,
        op,
      ),
    );
    return result;
  }
  spec['mapId'] = mapId;

  // floor / city 集合不可混用（父图与子图是两套模板）。
  const wrong = kind === 'floor' ? CITY_COLLECTIONS : FLOOR_COLLECTIONS;
  for (const collection of wrong) {
    const rows = spec[collection];
    if (Array.isArray(rows) && rows.length > 0) {
      result.issues.push(
        issue(
          LAYOUT_REQUEST_CONFLICT,
          `$.data.spec.${collection}`,
          `kind=${kind} 的布局请求不接受 ${collection}；floor 与 city 是两套模板，父图/子图引用不可混用。`,
          op,
        ),
      );
      return result;
    }
  }

  // 嵌套引用解析：别名 → 当前分支规范 ID，家具局部 ID 不建 entity_keys。
  const refs = resolveLayoutSpecRefs(spec, ctx.scope, { opId: op.opId, line: op.line });
  result.issues.push(...refs.issues);
  if (!refs.ok || !refs.spec) return result;
  const resolvedSpec = refs.spec;

  // 父图/子图混用：引用的地点必须属于这张图（未归属的地点允许，归属别图的拒绝）。
  for (const id of collectLocationRefs(resolvedSpec)) {
    const row = ctx.tables.selectOne('locations', ctx.branchId, id);
    if (!row) continue;
    const owner = row['map_id'] === null || row['map_id'] === undefined ? '' : String(row['map_id']);
    if (owner !== '' && owner !== mapId && id !== before.container_location_id) {
      result.issues.push(
        issue(
          LAYOUT_REQUEST_CONFLICT,
          '$.data.spec',
          `实体 ${id} 属于另一张图（${owner}），不能出现在 ${mapId} 的布局里：父图/子图引用不可混用。`,
          op,
        ),
      );
      return result;
    }
  }

  // 已保存请求 + 同批已编译结果 → 合并。
  const frame = isPlainObject(before.frame_json) ? (before.frame_json as Record<string, unknown>) : {};
  const saved = isPlainObject(frame['atlasLayoutRequest']) ? (frame['atlasLayoutRequest'] as Record<string, unknown>) : null;
  const savedSpec = saved && isPlainObject(saved['spec']) ? (saved['spec'] as Record<string, unknown>) : null;
  const savedKind = saved && typeof saved['kind'] === 'string' ? String(saved['kind']) : null;

  let state = BATCH_STATE.get(ctx);
  if (!state) {
    state = new Map<string, BatchEntry>();
    BATCH_STATE.set(ctx, state);
  }
  const previous = state.get(mapId);

  if (savedKind !== null && savedKind !== kind) {
    result.issues.push(
      issue(
        LAYOUT_REQUEST_CONFLICT,
        '$.data.kind',
        `该图已保存 kind=${savedKind} 的布局请求，本次是 ${kind}；同一张图的两套模板不能并存，请先显式重建。`,
        op,
      ),
    );
    return result;
  }
  if (previous && previous.kind !== kind) {
    result.issues.push(
      issue(LAYOUT_REQUEST_CONFLICT, '$.data.kind', `同批前一个请求是 ${previous.kind}，本次是 ${kind}。`, op),
    );
    return result;
  }

  // 同批累积在已编译候选态进行：第二个请求并入第一个的结果，不抹掉前一个独立房间。
  const merged = mergeConstraints(previous ? previous.spec : savedSpec, resolvedSpec, previous !== undefined);
  if (merged.conflicts.length > 0) {
    result.issues.push(
      issue(
        LAYOUT_REQUEST_CONFLICT,
        `$.data.spec.${merged.conflicts[0].replace(/^spec\./, '')}`,
        `本次请求与同批已编译的约束在 ${merged.conflicts.join('、')} 上冲突；不静默覆盖，请合并成一条或改用不同 id。`,
        op,
      ),
    );
    return result;
  }
  state.set(mapId, { kind, spec: merged.spec });

  const requestId = ctx.makeId('layout_request', op.opId, `map:${mapId}`);
  const turnId = ctx.turnId ?? ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;
  const rebuild = spec['rebuild'] === true;
  const signature = signatureOf(canonicalJson({ kind, mapId, spec: merged.spec, rebuild }));

  const dependencies = [mapId, ...refs.dependencies];
  for (const id of dependencies) if (!result.dependencies.includes(id)) result.dependencies.push(id);
  result.readSet.push({ table: 'maps', rowId: mapId, rowRev: Number(before.row_rev ?? 1) });

  // 幂等：重复相同 request 与 scene 约束不产生新变更（只回读集与依赖）。
  const savedSignature = saved && typeof saved['inputSignature'] === 'string' ? String(saved['inputSignature']) : null;
  if (savedSignature === signature) return result;

  const nextFrame: Record<string, unknown> = { ...frame };
  nextFrame['atlasLayoutRequest'] = {
    requestId,
    operationId: op.opId,
    createdTurnId: turnId,
    kind,
    mapId,
    rebuild,
    spec: merged.spec,
    inputSignature: signature,
  };
  const after = applyPatch(before, {
    frame_json: nextFrame,
    row_rev: Number(before.row_rev ?? 1) + 1,
    updated_turn_id: turnId,
  });
  result.mutations.push(mutation('maps', mapId, before, after, op, basisOf(ctx, op)));
  return result;
}
