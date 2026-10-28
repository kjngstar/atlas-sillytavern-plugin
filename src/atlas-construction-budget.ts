/** Construction selection applies only the explicit work quotas supplied by its caller.
 * Completed model replies have no implicit operation-count limit.
 */
import type { Issue, ModelOperation } from './atlas-ops-contract.ts';

/* ------------------------------------------------------------------ *
 * 1 契约
 * ------------------------------------------------------------------ */

export type ConstructionBudgetV1 = {
  version: 1;
  /** Explicit work budget; null means no additional total-operation cap. */
  totalOperations: number | null;
  /** 共同额度内最多新增多少地点。 */
  maxNewLocations: number;
  /** 共同额度内最多新增多少路线。 */
  maxNewRoutes: number;
};

export const CONSTRUCTION_BUDGET_VERSION = 1;

/** 操作分类：预算按类计数，但**只受一个总额约束**。 */
export const OPERATION_CLASSES = [
  'new-location',
  'new-route',
  'location-update',
  'route-update',
  'estimate',
  'state-patch',
  'other',
  'noop',
] as const;
export type OperationClass = (typeof OPERATION_CLASSES)[number];

export type BudgetUsage = {
  /** 计入额度的操作数（＝全部非 noop）。 */
  total: number;
  newLocations: number;
  newRoutes: number;
  byClass: Record<OperationClass, number>;
};

export type ConstructionBudgetVerdict = {
  ok: boolean;
  budget: ConstructionBudgetV1;
  usage: BudgetUsage;
  issues: Issue[];
};

export type ConstructionSelection = {
  /** 可提交的操作（依赖完整、未超配额）。 */
  accepted: ModelOperation[];
  /** 本批装不下或依赖未满足的操作：交回队列，不能当已完成。 */
  deferred: ModelOperation[];
  usage: BudgetUsage;
  issues: Issue[];
};

/* ------------------------------------------------------------------ *
 * 2 构造与分类
 * ------------------------------------------------------------------ */

/** Preserve explicit planning quotas without imposing another response limit. */
export function constructionBudget(input: {
  maxNewLocations: number;
  maxNewRoutes: number;
  /** A positive total opts into a bounded work selection; omitted/0 means unlimited. */
  totalOperations?: number;
}): ConstructionBudgetV1 {
  const total = input.totalOperations;
  const normalizeQuota = (value: number): number => Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  return {
    version: CONSTRUCTION_BUDGET_VERSION,
    totalOperations: typeof total === 'number' && Number.isFinite(total) && total > 0 ? Math.floor(total) : null,
    maxNewLocations: normalizeQuota(input.maxNewLocations),
    maxNewRoutes: normalizeQuota(input.maxNewRoutes),
  };
}

/** 引用是不是本批新建（`new:` 前缀，或目录里没有的非空 ID）。 */
export function isNewRef(ref: unknown, knownIds: ReadonlySet<string>): boolean {
  const value = typeof ref === 'string' ? ref.trim() : '';
  if (value.length === 0) return false;
  if (value.startsWith('new:')) return true;
  return !knownIds.has(value);
}

function opName(op: ModelOperation): string {
  return typeof op?.op === 'string' ? op.op.trim() : '';
}

function dataOf(op: ModelOperation): Record<string, unknown> {
  const data = op?.data;
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

/** 单个操作的预算分类。「更新」和「新建」共用同一总额，区别只在类型配额。 */
export function classifyOperation(op: ModelOperation, knownIds: ReadonlySet<string>): OperationClass {
  const name = opName(op);
  if (name === 'noop') return 'noop';

  if (name === 'location.upsert') {
    return isNewRef(op.ref, knownIds) ? 'new-location' : 'location-update';
  }
  if (name === 'route.propose') {
    return isNewRef(op.ref, knownIds) ? 'new-route' : 'route-update';
  }
  if (name === 'map.estimate') return 'estimate';
  if (name === 'space.state.patch') return 'state-patch';
  return 'other';
}

function emptyUsage(): BudgetUsage {
  const byClass = {} as Record<OperationClass, number>;
  for (const name of OPERATION_CLASSES) byClass[name] = 0;
  return { total: 0, newLocations: 0, newRoutes: 0, byClass };
}

function countInto(usage: BudgetUsage, cls: OperationClass): void {
  usage.byClass[cls] += 1;
  if (cls === 'noop') return;
  usage.total += 1;
  if (cls === 'new-location') usage.newLocations += 1;
  if (cls === 'new-route') usage.newRoutes += 1;
}

/** 统计一批操作的预算占用（不改动操作本身）。 */
export function budgetUsage(operations: readonly ModelOperation[], knownIds: ReadonlySet<string>): BudgetUsage {
  const usage = emptyUsage();
  for (const op of operations) countInto(usage, classifyOperation(op, knownIds));
  return usage;
}

/* ------------------------------------------------------------------ *
 * 3 依赖
 * ------------------------------------------------------------------ */

/** 操作本批内依赖的引用：地点的父、路线的两端。 */
function dependenciesOf(op: ModelOperation): string[] {
  const name = opName(op);
  const data = dataOf(op);
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.trim().length > 0) out.push(value.trim());
  };
  if (name === 'location.upsert') {
    push(data.parent_ref);
    push(data.anchor_ref);
  }
  if (name === 'route.propose') {
    push(data.from_ref);
    push(data.to_ref);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 4 预算检查（不截断，只判定）
 * ------------------------------------------------------------------ */

function budgetIssue(code: string, path: string, message: string, retryable: boolean): Issue {
  return { code, path, message, severity: 'error', retryable };
}

/**
 * 检查一批操作是否在预算内。
 *
 * 只判定、不修改：需要「挑一个子集继续」的调用方用 `selectWithinBudget`。
 * 超额同时报出实际数字与上限，不能只说一句 "too many"。
 */
export function checkConstructionBudget(
  operations: readonly ModelOperation[],
  options: { budget: ConstructionBudgetV1; knownIds: ReadonlySet<string> },
): ConstructionBudgetVerdict {
  const usage = budgetUsage(operations, options.knownIds);
  const { budget } = options;
  const issues: Issue[] = [];

  if (budget.totalOperations !== null && usage.total > budget.totalOperations) {
    issues.push(budgetIssue(
      'WORLD_CONSTRUCTION_BUDGET_EXCEEDED',
      '$.operations',
      `本批 ${usage.total} 条非 noop 操作，超过共同预算 ${budget.totalOperations} 条；`
      + `新地点 ${usage.newLocations}/${budget.maxNewLocations}、新路线 ${usage.newRoutes}/${budget.maxNewRoutes}。`
      + '地点与路线不是各自独立配额，它们共用同一个总额。',
      true,
    ));
  }

  if (usage.newLocations > budget.maxNewLocations) {
    issues.push(budgetIssue(
      'WORLD_CONSTRUCTION_LOCATION_QUOTA',
      '$.operations',
      `本批新增地点 ${usage.newLocations} 个，超过本批上限 ${budget.maxNewLocations} 个；超出部分应留待下一批。`,
      true,
    ));
  }

  if (usage.newRoutes > budget.maxNewRoutes) {
    issues.push(budgetIssue(
      'WORLD_CONSTRUCTION_ROUTE_QUOTA',
      '$.operations',
      `本批新增路线 ${usage.newRoutes} 条，超过本批上限 ${budget.maxNewRoutes} 条；超出部分应留待下一批。`,
      true,
    ));
  }

  return { ok: issues.length === 0, budget, usage, issues };
}

/* ------------------------------------------------------------------ *
 * 5 部分成功：选出依赖完整的子集
 * ------------------------------------------------------------------ */

/**
 * 在共同预算内挑出一个可提交的操作子集。
 *
 * 规则：
 * - 按输入顺序收，超配额或超总额的进 deferred（顺序稳定，不随机挑）。
 * - 依赖（父地点、路线两端）指向本批 `new:` 引用时，父必须**已经被接受**；
 *   否则本操作也进 deferred，绝不让「父没建成、子先落地」的半组进入 accepted。
 * - 依赖可能在后续操作里才声明，所以有专门的重试轮：直到某一轮没有任何进展为止。
 * - noop 不计额度，也不产生 deferred。
 */
export function selectWithinBudget(
  operations: readonly ModelOperation[],
  options: { budget: ConstructionBudgetV1; knownIds: ReadonlySet<string> },
): ConstructionSelection {
  const { budget, knownIds } = options;
  const usage = emptyUsage();
  const accepted: ModelOperation[] = [];
  const issues: Issue[] = [];
  /** 依赖暂时不满足，后续操作可能补齐。 */
  let pending: Array<{ op: ModelOperation; index: number }> = [];
  /** 额度不够：不参与重试，直接留待下一批。 */
  const outOfQuota: Array<{ op: ModelOperation; index: number }> = [];
  /** 本批已接受的新引用集合：`new:` 别名与真实 ID 都放这里。 */
  const acceptedRefs = new Set<string>();

  const canAdmit = (cls: OperationClass): boolean => {
    if (cls === 'noop') return true;
    if (budget.totalOperations !== null && usage.total + 1 > budget.totalOperations) return false;
    if (cls === 'new-location' && usage.newLocations + 1 > budget.maxNewLocations) return false;
    if (cls === 'new-route' && usage.newRoutes + 1 > budget.maxNewRoutes) return false;
    return true;
  };

  const depsSatisfied = (op: ModelOperation): boolean => {
    for (const dep of dependenciesOf(op)) {
      if (knownIds.has(dep) || acceptedRefs.has(dep)) continue;
      // 依赖的是本批新建对象，但那个对象还没被接受
      if (dep.startsWith('new:')) return false;
      // 依赖一个既不在目录、也不是 new: 的引用：留给校验层报 REF/SOURCE 错误，
      // 预算层不替它编造实体。
    }
    return true;
  };

  const admit = (op: ModelOperation): void => {
    countInto(usage, classifyOperation(op, knownIds));
    accepted.push(op);
    const ref = typeof op.ref === 'string' ? op.ref.trim() : '';
    if (ref.length > 0) acceptedRefs.add(ref);
  };

  for (let index = 0; index < operations.length; index += 1) {
    const op = operations[index];
    const cls = classifyOperation(op, knownIds);
    if (cls === 'noop') {
      accepted.push(op);
      continue;
    }
    if (!canAdmit(cls)) {
      outOfQuota.push({ op, index });
      continue;
    }
    if (!depsSatisfied(op)) {
      pending.push({ op, index });
      continue;
    }
    admit(op);
  }

  // 依赖重试：后续操作可能已经声明了父对象，直到某一轮零进展为止。
  let progressed = true;
  while (progressed && pending.length > 0) {
    progressed = false;
    const stillPending: Array<{ op: ModelOperation; index: number }> = [];
    for (const entry of pending) {
      const cls = classifyOperation(entry.op, knownIds);
      if (!canAdmit(cls)) {
        outOfQuota.push(entry);
        continue;
      }
      if (!depsSatisfied(entry.op)) {
        stillPending.push(entry);
        continue;
      }
      admit(entry.op);
      progressed = true;
    }
    pending = stillPending;
  }

  const deferred: ModelOperation[] = [];
  for (const entry of pending) {
    deferred.push(entry.op);
    issues.push(budgetIssue(
      'WORLD_CONSTRUCTION_DEPENDENCY_DEFERRED',
      `$.operations[${entry.index}]`,
      `${opName(entry.op)} 依赖的新建对象本批未被接受；该操作留待下一批，不能以「父不存在」的状态提交。`,
      true,
    ));
  }

  // 被配额挡下的操作也要说清楚原因与位置
  for (const entry of outOfQuota) {
    deferred.push(entry.op);
    issues.push(budgetIssue(
      'WORLD_CONSTRUCTION_BUDGET_DEFERRED',
      `$.operations[${entry.index}]`,
      `${opName(entry.op)} 超出本批共同预算 ${budget.totalOperations ?? 'unlimited'} 条（或类型配额），留待下一批。`,
      true,
    ));
  }

  return { accepted, deferred, usage, issues };
}

/** 用量摘要：给回执/诊断用的一行文字，不是给人看的散文。 */
export function describeBudgetUsage(usage: BudgetUsage, budget: ConstructionBudgetV1): string {
  return `ops ${usage.total}/${budget.totalOperations ?? 'unlimited'};`
    + ` newLoc ${usage.newLocations}/${budget.maxNewLocations};`
    + ` newRoute ${usage.newRoutes}/${budget.maxNewRoutes}`;
}
