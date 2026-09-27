/**
 * tests/helpers/atlas-compile-context.mjs — 测试用 CompileContext 构造器。
 *
 * 只用于测试：把真实 RefScope / TableReadPort / 确定性 makeId 组装成编译器需要的上下文，
 * 保证测试走的是生产同一条编译路径，而不是另造一份桩。
 */

import { createRefScope } from '../../src/atlas-ops-refs.ts';
import { createTableReadPort } from '../../src/atlas-db-readport.ts';
import { defaultMakeId } from '../../src/atlas-ops-compile.ts';

export function makeAnchor(overrides = {}) {
  return {
    chatUid: 'chat-A',
    branchId: 'main-A',
    parentTurnId: 'turn_seed_A',
    hostMessageUid: 'msg_test',
    variantKey: 'v1',
    baseRevision: 0,
    baseStorageRevision: 0,
    inputHash: 'input_hash_test',
    ...overrides,
  };
}

export function makeCompileContext({ seed, tables = null, phase = 'observe', anchor = makeAnchor(), clockS = 0, revision = 0, refs = null, sources = null } = {}) {
  const db = seed.db;
  const branchId = anchor.branchId;
  const scope = createRefScope(refs ?? (seed.refs ?? []).map((r) => ({ alias: r.alias, id: r.id, kind: r.kind, rowRev: 1, declaredByOpId: null })));
  const makeId = defaultMakeId(anchor);
  return {
    phase,
    anchor,
    clockS,
    revision,
    scope,
    sources: sources ?? { phase, snapshot: [], clockS },
    tables: tables ?? createTableReadPort(db),
    makeId,
    branchId,
  };
}

/** 简单的位置副作用上下文（仅供需要 db 的辅助函数使用）。 */
export function boundaryContext() {
  return null;
}
