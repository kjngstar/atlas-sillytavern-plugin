/**
 * atlas-ops-groups.ts — §16.5 原子分组与拓扑排序（E01 / E02）。
 *
 * 规则：
 * - 合并必须原子提交的操作：同一效果链、共享同一资源转移、同一新对象的必要组成、互相影响的不变量。
 * - 单纯读取同一既有地点**不合并**（一个城市中的两件无关事可独立提交）。
 * - 对新增依赖建立有向边；仅循环依赖组件合并为一组。
 * - 非法地点父环/容器环仍拒绝（由 E03 不变量校验）。
 */

import type { AtomicGroup, Issue, RowMutation } from './atlas-ops-contract.ts';

export type { AtomicGroup } from './atlas-ops-contract.ts';

export type CompiledGroupInput = {
  opId: string;
  issues: Issue[];
  mutations: RowMutation[];
  readSet: Array<{ table: string; rowId: string; rowRev: number }>;
  dependencies: string[];
  /** 该 op 声明的实体身份（同组必须一起写 entity_keys）。 */
  entityKeyWrites?: Array<{ id: string; kind: 'location' | 'character' | 'item' | 'faction' }>;
  /** 该 op 会消费的幂等键（资源竞争去重）。 */
  operationKeys?: Array<{ groupKey: string; opKey: string }>;
};

function stableHash(text: string): string {
  // FNV-1a 32 位，仅用于稳定分组 ID（不是安全哈希）。
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 写集键：table + rowId。 */
function writeKeys(mutations: RowMutation[]): Set<string> {
  const set = new Set<string>();
  for (const m of mutations) set.add(`${m.table}\u0000${m.rowId}`);
  return set;
}

class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_v, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

/**
 * E01 buildAtomicGroups。
 * 合并条件（满足其一即合并）：
 * 1. 写冲突：两 op 写同一行（同一新对象的必要组成、互相影响的不变量）。
 * 2. 显式依赖：op A 的 dependencies 指向 op B。
 * 3. 共享资源转移：同一 entityKey / 同一 operationKey（同一资源不能被两组各自消耗）。
 * 4. 同一效果链：event.propose 与其 effects（由 dependencies 表达）。
 * **单纯读取同一行不合并。**
 */
export function buildAtomicGroups(compiled: CompiledGroupInput[]): { groups: AtomicGroup[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const n = compiled.length;
  const uf = new UnionFind(n);
  const indexByOpId = new Map<string, number>();
  compiled.forEach((c, i) => indexByOpId.set(c.opId, i));

  const writeKeyOwners = new Map<string, number>();
  const opKeyOwners = new Map<string, number>();
  const entityKeyOwners = new Map<string, number>();

  compiled.forEach((c, i) => {
    for (const key of writeKeys(c.mutations)) {
      const owner = writeKeyOwners.get(key);
      if (owner === undefined) writeKeyOwners.set(key, i);
      else uf.union(owner, i);
    }
    for (const ek of c.entityKeyWrites ?? []) {
      const key = `${ek.kind}\u0000${ek.id}`;
      const owner = entityKeyOwners.get(key);
      if (owner === undefined) entityKeyOwners.set(key, i);
      else uf.union(owner, i);
    }
    for (const ok of c.operationKeys ?? []) {
      const key = `${ok.groupKey}\u0000${ok.opKey}`;
      const owner = opKeyOwners.get(key);
      if (owner === undefined) opKeyOwners.set(key, i);
      else uf.union(owner, i);
    }
    for (const dep of c.dependencies) {
      const target = indexByOpId.get(dep);
      if (target === undefined) {
        // 依赖在别处不可见：交给调用方按 op 存在性判断，这里只记录未合并。
        continue;
      }
      uf.union(target, i);
    }
  });

  const buckets = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const root = uf.find(i);
    const list = buckets.get(root);
    if (list) list.push(i);
    else buckets.set(root, [i]);
  }

  const groups: AtomicGroup[] = [];
  for (const memberIdx of buckets.values()) {
    const opIds = memberIdx.map((i) => compiled[i].opId);
    const mutations: RowMutation[] = [];
    const readSet: Array<{ table: string; rowId: string; rowRev: number }> = [];
    const internal = new Set(opIds);
    const dependsOn = new Set<string>();
    const opIssues: Issue[] = [];
    for (const i of memberIdx) {
      const c = compiled[i];
      mutations.push(...c.mutations);
      readSet.push(...c.readSet);
      if (c.issues?.length) opIssues.push(...c.issues);
      for (const dep of c.dependencies) {
        if (!internal.has(dep) && indexByOpId.has(dep)) dependsOn.add(dep);
      }
    }    const id = `grp_${stableHash(opIds.join('|'))}`;
    groups.push({ id, opIds, dependsOn: [...dependsOn], readSet: dedupeReadSet(readSet), mutations, opIssues });
  }

  // 组间依赖：把 op 级依赖转成组级依赖（同一 op 只属于一个组）。
  const groupOfOp = new Map<string, string>();
  for (const g of groups) for (const opId of g.opIds) groupOfOp.set(opId, g.id);
  const normalized = groups.map((g) => ({
    ...g,
    dependsOn: g.dependsOn.map((op) => groupOfOp.get(op) ?? op).filter((dep) => dep !== g.id),
  }));

  // 读后写次序：若一个组读取的行由另一个组写入（引用本轮新建实体），
  // 读方必须排在被读方之后——否则外键检查会在写方提交前失败。
  const writerOfRow = new Map<string, string>();
  for (const g of normalized) {
    for (const key of writeKeys(g.mutations)) {
      if (!writerOfRow.has(key)) writerOfRow.set(key, g.id);
    }
  }
  for (const g of normalized) {
    for (const read of g.readSet) {
      const writer = writerOfRow.get(`${read.table}\u0000${read.rowId}`);
      if (writer && writer !== g.id && !g.dependsOn.includes(writer)) g.dependsOn.push(writer);
    }
  }

  // 仅循环依赖组件合并为一组（说明存在互引用，必须原子）。
  const merged = mergeDependencyCycles(normalized, issues);
  return { groups: merged, issues };
}

function dedupeReadSet(readSet: Array<{ table: string; rowId: string; rowRev: number }>): Array<{ table: string; rowId: string; rowRev: number }> {
  const map = new Map<string, { table: string; rowId: string; rowRev: number }>();
  for (const r of readSet) {
    const key = `${r.table}\u0000${r.rowId}`;
    const existing = map.get(key);
    if (!existing || r.rowRev > existing.rowRev) map.set(key, r);
  }
  return [...map.values()];
}

function mergeDependencyCycles(groups: AtomicGroup[], issues: Issue[]): AtomicGroup[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles: string[][] = [];

  const dfs = (id: string, stack: string[]): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      if (start >= 0) cycles.push(stack.slice(start));
      return;
    }
    visiting.add(id);
    stack.push(id);
    const g = byId.get(id);
    for (const dep of g?.dependsOn ?? []) {
      if (byId.has(dep)) dfs(dep, stack);
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const g of groups) dfs(g.id, []);

  if (cycles.length === 0) return groups;

  issues.push({
    code: 'GROUP_DEPENDENCY_CYCLE_MERGED',
    path: '$',
    message: `检测到 ${cycles.length} 个组间循环依赖，已合并为原子组（保持因果不可拆）`,
    severity: 'warning',
    retryable: false,
  } as Issue);

  const uf = new UnionFind(groups.length);
  const indexById = new Map(groups.map((g, i) => [g.id, i]));
  for (const cycle of cycles) {
    const idxs = cycle.map((id) => indexById.get(id)!).filter((v) => v !== undefined);
    for (let i = 1; i < idxs.length; i += 1) uf.union(idxs[0], idxs[i]);
  }

  const buckets = new Map<number, AtomicGroup[]>();
  groups.forEach((g, i) => {
    const root = uf.find(i);
    const list = buckets.get(root);
    if (list) list.push(g);
    else buckets.set(root, [g]);
  });

  const out: AtomicGroup[] = [];
  for (const members of buckets.values()) {
    if (members.length === 1) {
      out.push(members[0]);
      continue;
    }
    const memberIds = new Set(members.map((m) => m.id));
    const opIds = members.flatMap((m) => m.opIds);
    const dependsOn = new Set<string>();
    for (const m of members) {
      for (const dep of m.dependsOn) if (!memberIds.has(dep)) dependsOn.add(dep);
    }
    out.push({
      id: `grp_${stableHash(opIds.join('|'))}`,
      opIds,
      dependsOn: [...dependsOn],
      readSet: dedupeReadSet(members.flatMap((m) => m.readSet)),
      mutations: members.flatMap((m) => m.mutations),
    });
  }
  return out;
}

/**
 * E02 orderGroups：拓扑排序，失败依赖标 blocked，稳定顺序。
 * 输出顺序变化不改变依赖结果：同层按 group id 字典序，保证确定性。
 */
export function orderGroups(groups: AtomicGroup[]): { order: AtomicGroup[]; blockedBy: Map<string, string>; issues: Issue[] } {
  const issues: Issue[] = [];
  const byId = new Map(groups.map((g) => [g.id, g]));
  const state = new Map<string, 'todo' | 'done'>();
  const order: AtomicGroup[] = [];
  const blockedBy = new Map<string, string>();
  const stack = new Set<string>();

  const visit = (g: AtomicGroup, chain: string[]): boolean => {
    const st = state.get(g.id);
    if (st === 'done') return !blockedBy.has(g.id);
    if (stack.has(g.id)) {
      issues.push({
        code: 'GROUP_ORDER_CYCLE',
        path: '$',
        message: `拓扑排序遇到未合并的循环依赖：${[...chain, g.id].join(' -> ')}`,
        severity: 'error',
        retryable: false,
        groupId: g.id,
      } as Issue);
      return false;
    }
    stack.add(g.id);
    let ok = true;
    for (const dep of [...g.dependsOn].sort()) {
      const depGroup = byId.get(dep);
      if (!depGroup) {
        blockedBy.set(g.id, dep);
        issues.push({
          code: 'DEPENDENCY_FAILED',
          path: '$',
          message: `组 ${g.id} 依赖的组 ${dep} 不存在`,
          severity: 'error',
          retryable: false,
          groupId: g.id,
          dependencyId: dep,
        } as Issue);
        ok = false;
        continue;
      }
      if (!visit(depGroup, [...chain, g.id])) {
        if (!blockedBy.has(g.id)) blockedBy.set(g.id, dep);
        ok = false;
      }
    }
    stack.delete(g.id);
    if (ok && !blockedBy.has(g.id)) {
      state.set(g.id, 'done');
      order.push(g);
      return true;
    }
    state.set(g.id, 'done');
    if (!order.includes(g)) order.push(g);
    return false;
  };

  for (const g of [...groups].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    visit(g, []);
  }
  return { order, blockedBy, issues };
}

/** 供分组层使用的最小输入形状；定义在 atlas-ops-groups-types.ts。 */
