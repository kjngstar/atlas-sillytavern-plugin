/**
 * atlas-ops-groups-types.ts — 分组层与编译器之间共享的最小形状。
 *
 * 单独一个文件是为了避免 `atlas-ops-compile-types.ts` ↔ `atlas-ops-groups.ts` 的循环 import。
 * types-only 文件不产生运行时代码。
 */

import type { AtomicGroup, Issue, RowMutation } from './atlas-ops-contract.ts';

/** 单个 op 编译后的结果（编译器公共签名 `(op, ctx) => CompileResult`）。 */
export type CompileResultLike = {
  opId: string;
  mutations: RowMutation[];
  readSet: Array<{ table: string; rowId: string; rowRev: number }>;
  dependencies: string[];
  issues: Issue[];
  entityKeyWrites?: Array<{ id: string; kind: 'location' | 'character' | 'item' | 'faction' }>;
  operationKeys?: Array<{ groupKey: string; opKey: string }>;
  effects?: Array<Record<string, unknown>>;
};

export type { AtomicGroup, Issue, RowMutation };
