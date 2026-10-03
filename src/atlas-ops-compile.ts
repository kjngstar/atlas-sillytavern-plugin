/**
 * atlas-ops-compile.ts — D15 compileOperations（§16.5 的确定顺序）。
 *
 * 顺序：
 * 1. 规范化词法/已知字段别名；为原响应完整操作分配固定 opId（由 parser 完成）。
 * 2. 第一遍登记全部 new: 声明，产生临时 ID → 真实 ID 的映射（declareRefs）。
 * 3. 第二遍解析引用和最少参数，构建读集/写集，**不写正式库**。
 * 4. 合并必须原子提交的操作（由 buildAtomicGroups 承担）。
 * 5. 对新增依赖建立有向边。
 * 6. 修复票据由 repair 层承担。
 */

import type { Issue, ParsedOperation, Phase, RefEntry, RefKind } from './atlas-ops-contract.ts';
import type { CompileContext, CompileResult, TableReadPort } from './atlas-ops-compile-types.ts';
import { emptyCompileResult, mergeCompileResults } from './atlas-ops-compile-types.ts';
import { createRefScope, declareRefs, refKindPrefix } from './atlas-ops-refs.ts';
import type { RefScope } from './atlas-ops-refs.ts';
import { normalizeOperation, validateMinimum } from './atlas-ops-normalize.ts';
import { bindSources } from './atlas-ops-sources.ts';
import type { SourceBindContext, BasisObject } from './atlas-ops-sources.ts';
import { compileLocationUpsert, compileCharacterUpsert, compileItemUpsert, compileItemTransfer, compileFactionUpsert, fieldIgnoredWarning } from './atlas-ops-entities.ts';
import { compileRelationUpsert } from './atlas-ops-relations.ts';
import { compilePlanPropose, compilePlanRevise } from './atlas-ops-actions.ts';
import { compileEventPropose } from './atlas-ops-events.ts';
import { compileInformationPropose, compileAttentionPropose, compileChannelUpsert } from './atlas-ops-information.ts';
import { compileMapEstimate, compileRoutePropose } from './atlas-ops-geography.ts';
import type { TurnAnchor } from './atlas-ops-contract.ts';

export type CompileOperationsInput = {
  operations: ParsedOperation[];
  anchor: TurnAnchor;
  phase: Phase;
  clockS: number;
  revision: number;
  tables: TableReadPort;
  sources: SourceBindContext;
  seedRefs?: RefEntry[];
  /** 已有的短引用（程序在上下文中提供 C1/L1 等）。 */
  knownRefs?: Array<{ alias: string; id: string; kind: RefKind; rowRev?: number | null }>;
  makeId?: (kind: string, opId: string, alias: string) => string;
  /** 本次**正在创建**的楼层 ID：审计列按它记账，不用 anchor.parentTurnId。 */
  turnId?: string;
  /**
   * 显式允许集合：作者手动编辑走**统一写入层**时，允许集合按提交的操作本身判定，
   * 不受单个 phase 限制；自动推演不传，仍按 phase 严格门禁。
   */
  allowedOps?: readonly string[];
};

export type CompiledOperations = {
  results: Array<{ opId: string; result: CompileResult }>;
  merged: CompileResult;
  issues: Issue[];
  scope: RefScope;
  aliasById: Map<string, string>;
  normalized: ParsedOperation[];
};

/** 默认确定性 ID 派生（不透明字符串，不使用 Math.random / 时间戳）。 */
export function defaultMakeId(anchor: TurnAnchor): (kind: string, opId: string, alias: string) => string {
  return (kind, opId, alias) => {
    const prefix = refKindPrefix(kind as RefKind);
    const text = `${anchor.chatUid}\u0000${anchor.branchId}\u0000${anchor.variantKey}\u0000${alias}\u0000${opId}`;
    return `${prefix}_${stableHash(text, 24)}`;
  };
}

/** FNV-1a 32 位 ×4 轮扩展，仅用于程序内部稳定 ID（不是安全哈希）。 */
export function stableHash(text: string, length = 24): string {
  let out = '';
  let seed = 0x811c9dc5;
  while (out.length < length) {
    let h = seed;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i) + out.length;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
    seed = (h ^ 0x9e3779b9) >>> 0;
  }
  return out.slice(0, length);
}

const COMPILERS: Record<string, (op: ParsedOperation, ctx: CompileContext) => CompileResult> = {
  'location.upsert': compileLocationUpsert,
  'character.upsert': compileCharacterUpsert,
  'item.upsert': compileItemUpsert,
  'item.transfer': compileItemTransfer,
  'faction.upsert': compileFactionUpsert,
  'relation.upsert': compileRelationUpsert,
  'plan.propose': compilePlanPropose,
  'plan.revise': compilePlanRevise,
  'event.propose': compileEventPropose,
  'information.propose': compileInformationPropose,
  'attention.propose': compileAttentionPropose,
  'channel.upsert': compileChannelUpsert,
  'map.estimate': compileMapEstimate,
  'route.propose': compileRoutePropose,
};

export function compilerFor(op: string): ((op: ParsedOperation, ctx: CompileContext) => CompileResult) | null {
  return COMPILERS[op] ?? null;
}

/**
 * D15 compileOperations。
 * 纯编排：返回候选变更，不执行 SQL、不调用网络、不改正式库。
 */
export function compileOperations(input: CompileOperationsInput): CompiledOperations {
  const issues: Issue[] = [];

  // 步骤 1：规范化（词法/别名/枚举/数字），保持原 opId 与行号。
  const normalized: ParsedOperation[] = [];
  for (const op of input.operations) {
    const norm = normalizeOperation(op.value, input.phase, input.allowedOps);
    issues.push(...norm.issues.map((i) => ({ ...i, opId: i.opId ?? op.opId, line: i.line ?? op.line })));
    if (!norm.op) continue;
    normalized.push({ opId: op.opId, line: op.line, rawHash: op.rawHash, value: norm.op });
  }

  // 步骤 2：第一遍登记全部 new: 声明（前向引用）。
  const makeId = input.makeId ?? defaultMakeId(input.anchor);
  const declared = declareRefs(normalized, {
    anchor: input.anchor,
    baseRevision: input.revision,
    seed: [...(input.seedRefs ?? []), ...(input.knownRefs ?? []).map(ref=>({...ref,rowRev:ref.rowRev??null,declaredByOpId:null}))],
    makeId,
  });
  issues.push(...declared.issues);

  const scope = createRefScope(input.seedRefs ?? []);
  for (const ref of input.knownRefs ?? []) {
    scope.declare({ alias: ref.alias, id: ref.id, kind: ref.kind, rowRev: ref.rowRev ?? null, declaredByOpId: null });
  }
  for (const entry of declared.declared) scope.declare(entry);

  /**
   * bindSources 上报的 warning（§16.8）：先收集，等所有 op 编译完再并入 issues。
   * `basisFor` 是懒调用（编译到某个 op 才跑），所以不能在 ctx 构建时就 merge。
   */
  const sourceIssues: Issue[] = [];
  const ctx: CompileContext = {
    phase: input.phase,
    anchor: input.anchor,
    clockS: input.clockS,
    revision: input.revision,
    scope,
    sources: input.sources,
    tables: input.tables,
    makeId,
    branchId: input.anchor.branchId,
    // 审计列按「本次正在创建的楼」记账（见 CompileContext.turnId）。
    ...(input.turnId ? { turnId: input.turnId } : {}),
    basisFor: (op, extra) => {
      // 前向引用是合法的：本批已声明的 new: 别名先解析成确定性 ID 再交给 bindSources，
      // 否则会对合法调用方误报 SOURCE_CAUSE_UNRESOLVED（真正的未解析别名仍会照常告警）。
      const causes = (input.sources?.causes ?? []).map((cause) => {
        const id = typeof cause?.id === 'string' ? cause.id : '';
        if (!id.startsWith('new:')) return cause;
        const alias = id.slice(4);
        const resolved = declared.aliasById.get(alias) ?? scope.get(alias)?.id ?? null;
        return resolved ? { ...cause, id: resolved } : cause;
      });
      const bound = bindSources(op.value, {
        ...input.sources,
        causes,
        opId: op.opId,
        // 前向引用合法：本批已声明的别名解析成确定性 ID，未声明的才告警。
        resolveAlias: (alias) => declared.aliasById.get(alias) ?? scope.get(alias)?.id ?? null,
      });
      // bindSources 的 issues 是**必须上报**的（SOURCE_CAUSE_UNRESOLVED 等）：
      // 原来这里只取 basis、把 issues 丢掉，于是这些 warning 走真实编译路径时根本不会出现在回执里，
      // §16.8 的「诊断可按 op 定位」和 repair 票据就都少了依据。
      for (const issue of bound.issues ?? []) sourceIssues.push(issue);
      const basis: BasisObject = { ...bound.basis };
      if (extra?.causes?.length) basis.causes = [...basis.causes, ...extra.causes];
      if (extra?.certainty) basis.certainty = extra.certainty;
      return basis;
    },
  };

  // 步骤 3：第二遍解析引用与最少参数，构建候选变更。
  const results: Array<{ opId: string; result: CompileResult }> = [];
  for (const op of normalized) {
    const minimum = validateMinimum(op.value, input.phase, { opId: op.opId, line: op.line });
    if (!minimum.ok) {
      issues.push(minimum.issue);
      results.push({ opId: op.opId, result: { ...emptyCompileResult(), issues: [minimum.issue] } });
      continue;
    }
    const compiler = compilerFor(op.value.op);
    if (!compiler) {
      const issue: Issue = {
        code: 'UNKNOWN_OPERATION',
        path: '$.op',
        message: `没有这个语义操作：${op.value.op}`,
        severity: 'error',
        retryable: true,
        opId: op.opId,
        line: op.line,
      };
      issues.push(issue);
      results.push({ opId: op.opId, result: { ...emptyCompileResult(), issues: [issue] } });
      continue;
    }
    let compiled: CompileResult;
    try {
      compiled = compiler(op, ctx);
    } catch (err) {
      const issue: Issue = {
        code: 'INTERNAL_ERROR',
        path: '$',
        message: `编译 ${op.value.op} 时内部错误：${(err as Error).message}`,
        severity: 'error',
        retryable: false,
        opId: op.opId,
        line: op.line,
      };
      issues.push(issue);
      results.push({ opId: op.opId, result: { ...emptyCompileResult(), issues: [issue] } });
      continue;
    }
    // 该 op 新声明的引用让同批后续 op 可见（前向引用已由 declareRefs 覆盖）。
    for (const ref of compiled.declaredRefs ?? []) {
      if (!scope.get(ref.alias)) scope.declare(ref);
    }
    issues.push(...compiled.issues);
    results.push({ opId: op.opId, result: { ...compiled, issues: compiled.issues } });
  }

  // bindSources 的告警在所有 op 编译完之后并入（basisFor 是懒调用），并按 (opId,code,path) 去重。
  const seenSource = new Set(issues.map((i) => `${i.opId ?? ''}|${i.code}|${i.path}`));
  for (const issue of sourceIssues) {
    const key = `${issue.opId ?? ''}|${issue.code}|${issue.path}`;
    if (seenSource.has(key)) continue;
    seenSource.add(key);
    issues.push(issue);
  }

  const merged = mergeCompileResults(results.map((r) => r.result));
  return { results, merged, issues, scope, aliasById: declared.aliasById, normalized };
}

/** 供测试断言：14 种操作都有对应编译器。 */
export function compilerTable(): string[] {
  return Object.keys(COMPILERS).sort();
}

export { fieldIgnoredWarning, emptyCompileResult };
export type { CompileContext, CompileResult, TableReadPort };
