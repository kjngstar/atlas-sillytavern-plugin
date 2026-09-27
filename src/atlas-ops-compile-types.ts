/**
 * atlas-ops-compile-types.ts — 语义操作编译器的公共契约（§17D）。
 *
 * 公共签名统一为 `(op: ParsedOperation, ctx: CompileContext) => CompileResult`。
 * CompileContext 含只读基态/候选态、RefScope、SourceSnapshot、Phase、Clock；
 * CompileResult 是 mutations/readSet/dependencies/issues，**不直接执行 SQL、网络或 UI**。
 */

import type { Issue, ParsedOperation, Phase, RefEntry, RowMutation, TurnAnchor } from './atlas-ops-contract.ts';
import type { AtlasTableName } from './atlas-db-contract.ts';
import type { BasisObject, SourceBindContext } from './atlas-ops-sources.ts';
import type { RefScope } from './atlas-ops-refs.ts';

export type TableReadPort = {
  selectOne(table: AtlasTableName, branchId: string, id: string): Record<string, unknown> | null;
  selectWhere(table: AtlasTableName, where: Record<string, unknown>, limit?: number): Array<Record<string, unknown>>;
  nextSeq?: () => number;
};

export type CompileContext = {
  phase: Phase;
  anchor: TurnAnchor;
  clockS: number;
  revision: number;
  scope: RefScope;
  sources: SourceBindContext;
  tables: TableReadPort;
  /** 程序分配 ID（确定性，不透明）。 */
  makeId: (kind: string, opId: string, alias: string) => string;
  /** 当前分支 id（= anchor.branchId）。 */
  branchId: string;
  /** 程序生成来源依据的统一入口；编译器也可自行构造。 */
  basisFor?: (op: ParsedOperation, extra?: { causes?: Array<{ kind: string; id: string }>; certainty?: BasisObject['certainty'] }) => BasisObject;
};

export type CompileResult = {
  mutations: RowMutation[];
  readSet: Array<{ table: string; rowId: string; rowRev: number }>;
  dependencies: string[];
  issues: Issue[];
  /** 该 op 需要写入的实体身份（同组必须一起写 entity_keys）。 */
  entityKeyWrites?: Array<{ id: string; kind: 'location' | 'character' | 'item' | 'faction' }>;
  /** 该 op 声明的引用，供后续 op 解析。 */
  declaredRefs?: RefEntry[];
  /** 幂等键（资源竞争去重）。 */
  operationKeys?: Array<{ groupKey: string; opKey: string }>;
  /** 非变更的语义结果（例如行程计划、传播任务），由上层程序执行。 */
  effects?: Array<Record<string, unknown>>;
};

export function emptyCompileResult(): CompileResult {
  return { mutations: [], readSet: [], dependencies: [], issues: [] };
}

export function mergeCompileResults(results: CompileResult[]): CompileResult {
  const merged: CompileResult = { mutations: [], readSet: [], dependencies: [], issues: [] };
  const readMap = new Map<string, { table: string; rowId: string; rowRev: number }>();
  for (const r of results) {
    merged.mutations.push(...r.mutations);
    merged.issues.push(...r.issues);
    for (const dep of r.dependencies) if (!merged.dependencies.includes(dep)) merged.dependencies.push(dep);
    for (const read of r.readSet) {
      const key = `${read.table}\u0000${read.rowId}`;
      const existing = readMap.get(key);
      if (!existing || read.rowRev > existing.rowRev) readMap.set(key, read);
    }
    if (r.entityKeyWrites?.length) merged.entityKeyWrites = [...(merged.entityKeyWrites ?? []), ...r.entityKeyWrites];
    if (r.declaredRefs?.length) merged.declaredRefs = [...(merged.declaredRefs ?? []), ...r.declaredRefs];
    if (r.operationKeys?.length) merged.operationKeys = [...(merged.operationKeys ?? []), ...r.operationKeys];
    if (r.effects?.length) merged.effects = [...(merged.effects ?? []), ...r.effects];
  }
  merged.readSet = [...readMap.values()];
  return merged;
}

/** 单个语义操作的编译器签名。 */
export type OperationCompiler = (op: ParsedOperation, ctx: CompileContext) => CompileResult;
