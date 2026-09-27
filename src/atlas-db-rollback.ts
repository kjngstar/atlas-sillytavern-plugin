/**
 * atlas-db-rollback.ts — E08 planRollback / applyRollbackPlan（§7.4 / §6.4 / §17E）。
 *
 * 规则：
 * - **沿当前有效因果链**找到目标楼及其全部后继 turns（`collectDescendants`，不是「数字减 1」），
 *   按变更 `sequence` 逆序构造 before 恢复计划；中间楼删除必须能定位受影响后文。
 * - 计划里明确列出全部受影响 turn（`turns`）与被触及的表计数（`tableCounts`）。
 * - 非日志化表（`turns` / `turn_changes` / `sync_outbox`）不进 `steps`；`branches` 的 head 指针
 *   也不递归记日志，但它的**可回退字段**（clock/head/revision/cursor）用**一条显式 step**表达，
 *   由调用方的提交/回滚控制器决定何时应用。
 * - 时间：`clockTargetS` 取目标 turn 的 `clock_before_s`，`clockBeforeS` 取当前 `branches.clock_s`；
 *   **不把历史 period 换算成秒**。
 * - 只读：`planRollback` **不写库**；`applyRollbackPlan` 只在调用方事务内逐 step 应用并显式做外键检查。
 * - 拒绝语义用 `AtlasDbError` 抛出（与仓库既有 `STALE_BASE` / `REF_UNKNOWN` 约定一致）：
 *   目标 turn 不属于本分支或找不到 → `REF_UNKNOWN`；`expectedRevision` 不符 → `STALE_BASE`；
 *   超过 limits → `ROLLBACK_TOO_LARGE`（明确拒绝，**不截断后假装完成**）；恢复行损坏 → `ROLLBACK_PLAN_INVALID`。
 *   `RollbackPlan.issues` 只放非致命的计划说明（跳过非日志化表、目标楼已不在 head 链上等）。
 */

import { isJournaledTable, readTurnChanges } from './atlas-db-journal.ts';
import { collectDescendants } from './atlas-db-repository.ts';
import { assertSafeIdentifier, AtlasDbError, foreignKeyCheck, queryBound, runBound } from './atlas-db-runtime.ts';
import { isKnownTable, tableColumnNames } from './atlas-db-schema.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { Issue } from './atlas-ops-contract.ts';

/** §7.4：回退后要写回的一步。`restore === null` 表示该行原本不存在 → 逆操作是删除。 */
export type RollbackStep = {
  /** 计划内应用顺序（1..n，跨 turn 全局单调；数组顺序即应用顺序，逆因果序）。 */
  sequence: number;
  turnId: string;
  changeId: string;
  targetTable: string;
  targetRowId: string;
  /** 原日志的操作类型：insert 的行 `restore === null`（回退即删除）。 */
  operation: 'insert' | 'update' | 'delete';
  /** 要写回的完整行；null 表示删除。 */
  restore: Record<string, unknown> | null;
  basis: Record<string, unknown>;
  summary: string;
};

export type RollbackPlan = {
  branchId: string;
  targetTurnId: string;
  /** 受影响的后继 turn，按需要回退的顺序（逆因果序）排列。 */
  turns: string[];
  steps: RollbackStep[];
  tableCounts: Record<string, number>;
  /** 当前 `branches.clock_s`。 */
  clockBeforeS: number;
  /** 目标 turn 的 `clock_before_s`（回退后的时钟）。 */
  clockTargetS: number;
  affectedTurns: number;
  issues: Issue[];
};

export type RollbackChain = {
  db: SqlDatabase;
  branchId: string;
  targetTurnId: string;
  expectedRevision?: number;
};

export type RollbackLimits = { maxTurns?: number; maxSteps?: number };

/**
 * E08 的安全阀默认值。§16.2 的固定限制集中在 `atlas-runtime-limits.ts`；
 * 这里只放回退专属的守卫值，避免「先截断再假装完整」。
 */
export const ROLLBACK_DEFAULT_MAX_TURNS = 200;
export const ROLLBACK_DEFAULT_MAX_STEPS = 5000;

/** 非日志化表：turn_changes 里不会出现，也不允许作为回退 step 直接写。 */
const NON_JOURNALED_TABLES = new Set(['turns', 'turn_changes', 'sync_outbox']);
/** 主键只有 `id` 的表（没有 branch_id 列）。 */
const GLOBAL_PK_TABLES = new Set(['branches', 'turns', 'turn_changes', 'sync_outbox']);

function refuse(code: string, message: string, path: string, detail: Record<string, unknown>): AtlasDbError {
  const issue: Issue = { code, path, message, severity: 'error', retryable: code !== 'ROLLBACK_TOO_LARGE' };
  return new AtlasDbError(code, message, { ...detail, issues: [issue] });
}

/** 非致命计划说明：诊断能定位到具体 turn / change（Issue 形状里没有 turnId 字段，写进 message）。 */
function note(code: string, message: string, extra: { turnId?: string; changeId?: string } = {}): Issue {
  const tail = [extra.turnId ? `turn=${extra.turnId}` : '', extra.changeId ? `change=${extra.changeId}` : '']
    .filter((part) => part.length > 0)
    .join(' ');
  return {
    code,
    path: '$.steps',
    message: tail ? `${message}（${tail}）` : message,
    severity: 'warning',
    retryable: false,
  };
}

function finiteOr(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Math.trunc(value);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/** before_json → 恢复行；`null` 表示原本是 insert（回退即删除）。 */
function parseBefore(entry: { id: string; turnId: string; beforeJson: string | null }): Record<string, unknown> | null {
  if (entry.beforeJson === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.beforeJson);
  } catch (err) {
    throw refuse('ROLLBACK_PLAN_INVALID', `变更 ${entry.id} 的 before_json 损坏，无法构造恢复行：${(err as Error).message}`, '$.steps', {
      changeId: entry.id,
      turnId: entry.turnId,
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw refuse('ROLLBACK_PLAN_INVALID', `变更 ${entry.id} 的 before_json 不是对象行`, '$.steps', {
      changeId: entry.id,
      turnId: entry.turnId,
    });
  }
  return parsed as Record<string, unknown>;
}

function parseBasis(entry: { basisJson: string }): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(entry.basisJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * E08 planRollback：只读。
 * 完成定义（§17E）：中间楼删除能定位受影响后文，不仅按数字减 1。
 */
export function planRollback(chain: RollbackChain, limits: RollbackLimits = {}): RollbackPlan {
  const db = chain.db;
  const branchId = String(chain.branchId ?? '');
  const targetTurnId = String(chain.targetTurnId ?? '');
  if (!branchId) throw refuse('REF_UNKNOWN', 'planRollback 需要 branchId', '$.branchId', {});
  if (!targetTurnId) throw refuse('REF_UNKNOWN', 'planRollback 需要 targetTurnId', '$.targetTurnId', {});
  const maxTurns = positiveLimit(limits?.maxTurns, ROLLBACK_DEFAULT_MAX_TURNS);
  const maxSteps = positiveLimit(limits?.maxSteps, ROLLBACK_DEFAULT_MAX_STEPS);
  const issues: Issue[] = [];

  const branch = queryBound(db, 'SELECT * FROM branches WHERE id = ? LIMIT 1', [branchId])[0];
  if (!branch) throw refuse('REF_UNKNOWN', `找不到分支：${branchId}`, '$.branchId', { branchId });
  const clockBeforeS = finiteOr(branch.clock_s, 0);
  const revision = finiteOr(branch.revision, 0);

  if (chain.expectedRevision !== undefined && Number(chain.expectedRevision) !== revision) {
    throw refuse('STALE_BASE', `回退基版本不一致：请求 ${chain.expectedRevision}，当前 ${revision}`, '$.expectedRevision', {
      branchId,
      expected: Number(chain.expectedRevision),
      current: revision,
    });
  }

  const target = queryBound(db, 'SELECT * FROM turns WHERE id = ? LIMIT 1', [targetTurnId])[0];
  if (!target) throw refuse('REF_UNKNOWN', `找不到要回退的 turn：${targetTurnId}`, '$.targetTurnId', { targetTurnId });
  if (String(target.branch_id) !== branchId) {
    throw refuse('REF_UNKNOWN', `目标 turn ${targetTurnId} 不属于本分支 ${branchId}`, '$.targetTurnId', {
      targetTurnId,
      turnBranchId: String(target.branch_id),
      branchId,
    });
  }
  const clockTargetS = finiteOr(target.clock_before_s, Number.NaN);
  if (!Number.isFinite(clockTargetS)) {
    throw refuse('ROLLBACK_PLAN_INVALID', `目标 turn ${targetTurnId} 的 clock_before_s 不是有限数值`, '$.targetTurnId', {
      targetTurnId,
      clockBeforeS: String(target.clock_before_s),
    });
  }

  // 沿当前有效因果链：目标楼自身 + 全部后继（不是「数字减 1」）。
  const turnRows = queryBound(db, 'SELECT id, parent_turn_id, created_wall_ms FROM turns WHERE branch_id = ?', [branchId]);
  const parentOf = new Map<string, string | null>();
  const wallOf = new Map<string, number>();
  for (const row of turnRows) {
    const id = String(row.id);
    parentOf.set(id, row.parent_turn_id === null || row.parent_turn_id === undefined ? null : String(row.parent_turn_id));
    wallOf.set(id, finiteOr(row.created_wall_ms, 0));
  }
  const affected = new Set<string>(collectDescendants(db, branchId, targetTurnId));
  affected.add(targetTurnId);

  if (affected.size > maxTurns) {
    throw refuse(
      'ROLLBACK_TOO_LARGE',
      `受影响 turn 数 ${affected.size} 超过上限 ${maxTurns}：明确拒绝，不截断后假装完成`,
      '$.turns',
      { affectedTurns: affected.size, maxTurns, targetTurnId },
    );
  }

  // 深度：目标楼 0，子 1 …… 逆因果序 = 深度降序（后代先回退）。
  const depthOf = new Map<string, number>();
  depthOf.set(targetTurnId, 0);
  const children = new Map<string, string[]>();
  for (const [id, parent] of parentOf) {
    if (!parent || !affected.has(id)) continue;
    const list = children.get(parent) ?? [];
    list.push(id);
    children.set(parent, list);
  }
  const queue: string[] = [targetTurnId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const depth = depthOf.get(current) ?? 0;
    for (const child of children.get(current) ?? []) {
      if (depthOf.has(child)) continue;
      depthOf.set(child, depth + 1);
      queue.push(child);
    }
  }
  const turns = [...affected].sort((a, b) => {
    const da = depthOf.get(a) ?? 0;
    const db2 = depthOf.get(b) ?? 0;
    if (da !== db2) return db2 - da;
    const wa = wallOf.get(a) ?? 0;
    const wb = wallOf.get(b) ?? 0;
    if (wa !== wb) return wa - wb;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  // head 链提示：目标楼已不在当前有效故事历史里时如实说明（不静默）。
  const headTurnId = branch.head_turn_id === null || branch.head_turn_id === undefined ? null : String(branch.head_turn_id);
  const chainSet = new Set<string>();
  let cursor = headTurnId;
  while (cursor && !chainSet.has(cursor)) {
    chainSet.add(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }
  if (headTurnId && !chainSet.has(targetTurnId)) {
    issues.push({
      code: 'ROLLBACK_TARGET_NOT_IN_HEAD_CHAIN',
      path: '$.targetTurnId',
      message: `目标 turn ${targetTurnId} 不在当前 head ${headTurnId} 的祖先链上（可能已经回退过）`,
      severity: 'warning',
      retryable: false,
      dependencyId: headTurnId,
    });
  }

  const steps: RollbackStep[] = [];
  const tableCounts: Record<string, number> = {};
  let sequence = 1;

  for (const turnId of turns) {
    const entries = readTurnChanges(db, turnId);
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (NON_JOURNALED_TABLES.has(entry.targetTable) || !isJournaledTable(entry.targetTable)) {
        issues.push(
          note('ROLLBACK_TABLE_NOT_JOURNALED', `表 ${entry.targetTable} 由提交/回滚控制器处理，不进 steps`, {
            turnId,
            changeId: entry.id,
          }),
        );
        continue;
      }
      if (entry.targetTable === 'branches') {
        issues.push(
          note('ROLLBACK_BRANCH_FIELDS_FOLDED', `分支可回退字段由一条显式 step 统一表达（日志行 ${entry.id} 折入）`, {
            turnId,
            changeId: entry.id,
          }),
        );
        continue;
      }
      const restore = parseBefore(entry);
      steps.push({
        sequence,
        turnId,
        changeId: entry.id,
        targetTable: entry.targetTable,
        targetRowId: entry.targetRowId,
        operation: entry.operation,
        restore,
        basis: parseBasis(entry),
        summary: entry.summary,
      });
      sequence += 1;
      tableCounts[entry.targetTable] = (tableCounts[entry.targetTable] ?? 0) + 1;
      if (steps.length > maxSteps) {
        throw refuse('ROLLBACK_TOO_LARGE', `回退步数超过上限 ${maxSteps}：明确拒绝，不截断后假装完成`, '$.steps', {
          maxSteps,
          targetTurnId,
        });
      }
    }
  }

  // §6.4 / §17E：branches 的 head 指针与提交计数不进变更日志，但 clock/head/revision/cursor
  // 属于可回退字段，用**一条显式 step**表达（完整行 + 回退后的可回退字段）。
  const restoredCursorS = Math.min(finiteOr(branch.simulation_cursor_s, 0), clockTargetS);
  const branchRestore: Record<string, unknown> = { ...branch };
  branchRestore.head_turn_id = parentOf.get(targetTurnId) ?? null;
  branchRestore.revision = revision + 1;
  branchRestore.clock_s = clockTargetS;
  branchRestore.clock_min_s = clockTargetS;
  branchRestore.clock_max_s = clockTargetS;
  branchRestore.simulation_cursor_s = restoredCursorS;
  branchRestore.simulation_status = 'current';
  steps.push({
    sequence,
    turnId: targetTurnId,
    changeId: `rollback_branch_${branchId}`,
    targetTable: 'branches',
    targetRowId: branchId,
    operation: 'update',
    restore: branchRestore,
    basis: {
      kind: 'simulation',
      sources: [],
      causes: [{ kind: 'turn', id: targetTurnId }],
      reason: `删楼回退：分支 clock/head/revision/cursor 恢复到 ${targetTurnId} 之前`,
      verification: 'causal',
      certainty: 'confirmed',
    },
    summary: `回退分支「${branchId}」：head=${String(branchRestore.head_turn_id ?? 'null')}，clock=${clockTargetS}`,
  });
  tableCounts.branches = (tableCounts.branches ?? 0) + 1;

  return {
    branchId,
    targetTurnId,
    turns,
    steps,
    tableCounts,
    clockBeforeS,
    clockTargetS,
    affectedTurns: turns.length,
    issues,
  };
}

function normalizeValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return JSON.stringify(value);
  return value as string | number;
}

/**
 * E08 applyRollbackPlan：在**调用方事务内**逐 step 应用（全部参数绑定）。
 * - `restore === null` → DELETE；原操作是 delete → INSERT OR REPLACE 重建该行；其余 → UPDATE。
 * - 任何一步失败立即抛 `AtlasDbError`（调用方回滚），不吞异常。
 * - 应用完成后显式执行 `foreign_key_check`，非空则抛 `SQL_CONSTRAINT`（§7.3：不用 RELEASE 代替）。
 * - 非日志化表（turns / turn_changes / sync_outbox）与 turns 的「已回退」状态由调用方控制器负责。
 */
export async function applyRollbackPlan(
  db: SqlDatabase,
  plan: RollbackPlan,
  ctx: { turnId: string; attemptId: string },
): Promise<{ restored: number; issues: Issue[] }> {
  const issues: Issue[] = [...plan.issues];
  let restored = 0;

  for (const step of plan.steps) {
    const table = step.targetTable;
    if (!isKnownTable(table) || !isJournaledTable(table) || NON_JOURNALED_TABLES.has(table)) {
      throw new AtlasDbError('ROLLBACK_PLAN_INVALID', `回退步骤指向不可回退的表：${table}`, {
        table,
        changeId: step.changeId,
        turnId: ctx.turnId,
        attemptId: ctx.attemptId,
      });
    }
    assertSafeIdentifier(table);
    const allowed = new Set(tableColumnNames(table));
    const rowId = step.targetRowId;
    const isGlobal = GLOBAL_PK_TABLES.has(table);
    const whereSql = isGlobal ? 'id = ?' : 'branch_id = ? AND id = ?';
    const whereParams: Array<string | number | null> = isGlobal ? [rowId] : [plan.branchId, rowId];

    if (step.restore === null) {
      if (isGlobal) {
        // 分支/日志表永远不该被计划删除；这是计划损坏，不是数据损坏。
        throw new AtlasDbError('ROLLBACK_PLAN_INVALID', `计划要求删除 ${table} 行 ${rowId}：回退不允许删除分支或日志表`, {
          table,
          rowId,
          changeId: step.changeId,
        });
      }
      runBound(db, `DELETE FROM ${table} WHERE ${whereSql}`, whereParams);
      restored += 1;
      continue;
    }

    const unknown = Object.keys(step.restore).filter((column) => !allowed.has(column));
    if (unknown.length > 0) {
      throw new AtlasDbError('ROLLBACK_PLAN_INVALID', `恢复行含 ${table} 不存在的列：${unknown.join(', ')}`, {
        table,
        rowId,
        columns: unknown,
      });
    }
    const restoreBranch = step.restore.branch_id;
    if (!isGlobal && restoreBranch !== undefined && restoreBranch !== null && String(restoreBranch) !== plan.branchId) {
      throw new AtlasDbError('ROLLBACK_PLAN_INVALID', `恢复行的 branch_id=${String(restoreBranch)} 与计划分支 ${plan.branchId} 不一致`, {
        table,
        rowId,
        branchId: plan.branchId,
      });
    }

    const columns = Object.keys(step.restore);
    const values = columns.map((column) => normalizeValue((step.restore as Record<string, unknown>)[column]));
    if (step.operation === 'delete') {
      const placeholders = columns.map(() => '?').join(', ');
      runBound(db, `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`, values);
    } else {
      const assignments = columns.map((column) => `${column} = ?`).join(', ');
      runBound(db, `UPDATE ${table} SET ${assignments} WHERE ${whereSql}`, [...values, ...whereParams]);
    }
    restored += 1;
  }

  const violations = foreignKeyCheck(db);
  if (violations.length > 0) {
    const summary = violations.map((v) => `${v.table}->${v.parent}`).join(', ');
    throw new AtlasDbError('SQL_CONSTRAINT', `回退后外键检查未通过：${summary}`, {
      violations,
      turnId: ctx.turnId,
      attemptId: ctx.attemptId,
    });
  }

  return { restored, issues };
}
