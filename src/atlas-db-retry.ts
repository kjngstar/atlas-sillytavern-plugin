/**
 * atlas-db-retry.ts — E07 retryFailedGroups：失败组原位补交（§7.5）。
 *
 * 固定规则（§7.5 / §6.4 / §16.5）：
 * 1. **默认只允许在原 turn 仍是当前推演头时原位补交失败组。** 后续已经产生新楼 → `RETRY_BASE_CHANGED`
 *    且 status=`replay_required`：调用方必须把它变成显式的「从该楼重演后续推演」操作，
 *    **绝不**把旧时点的刺杀/移动直接插进新状态。
 * 2. **已经提交的组不会再次出现。** 补交沿用原 `operation_id`：`applyGroups` 依据
 *    `(turn_id,operation_id,target_table,target_row_id)` 判重并返回 `duplicate`，
 *    不再走一遍路、不再消耗物品（§7.5 重复副作用为 0）。
 * 3. **逻辑时间不重复前进。** `clockS` 原样传递（只进诊断与重试记录），本函数**不写**
 *    `branches.clock_s`/`clock_min_s`/`clock_max_s`/`simulation_cursor_s`，也不改 `turns.clock_after_s`；
 *    有时间推进语义的组靠自己的幂等键去重。
 * 4. 使用调用方传入的 `appliedKeys`（本 turn 已成功的幂等键）继续累计，返回时回传。
 *
 * 事务：本函数自管事务（`BEGIN` … `COMMIT`）。若调用方已经开了事务（嵌套 `BEGIN` 会失败），
 * 则退化为「在调用方事务内应用」，由调用方决定 COMMIT/ROLLBACK。
 */

import { applyGroups } from './atlas-db-commit.ts';
import { operationAlreadyApplied } from './atlas-db-journal.ts';
import { orderGroups } from './atlas-ops-groups.ts';
import { beginTransaction, commitTransaction, queryBound, queryOne, rollbackTransaction, runBound } from './atlas-db-runtime.ts';
import { ATLAS_RUNTIME_LIMITS } from './atlas-runtime-limits.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { AtomicGroup, GroupResult, Issue } from './atlas-ops-contract.ts';

export type FailedGroupRetryInput = {
  db: SqlDatabase;
  branchId: string;
  chatUid: string;
  /** 原 turn：失败组所属的推演记录。 */
  turnId: string;
  /** 调用方捕获的当前推演头；null 表示未捕获（以库内 head 为准）。 */
  currentHeadTurnId: string | null;
  /** 本次补交的 attempt id（写入 turn_changes.attempt_id 与 turns.attempts_json）。 */
  attemptId: string;
  groups: AtomicGroup[];
  /** 本 turn 已经成功的幂等键。 */
  appliedKeys?: Set<string>;
  /** 当前逻辑时刻；原样传递，不重复前进。 */
  clockS: number;
};

export type FailedGroupRetryResult = {
  status: 'applied' | 'duplicate' | 'blocked' | 'replay_required';
  groups: GroupResult[];
  issues: Issue[];
};

/** applyGroups 在外键整批失败时追加的合成组 id；它不是真实因果组。 */
const FOREIGN_KEY_SENTINEL = '__foreign_key_check__';

function makeIssue(
  code: string,
  message: string,
  severity: Issue['severity'] = 'error',
  retryable = false,
  extra: Partial<Issue> = {},
): Issue {
  return { code, path: '$', message, severity, retryable, ...extra };
}

/** §18.4：RETRY_BASE_CHANGED / REPLAY_REQUIRED 必须留下「原 head / current head」。 */
export function replayRequiredIssue(originalHead: string | null, currentHead: string | null): Issue {
  return {
    code: 'RETRY_BASE_CHANGED',
    path: '$.currentHeadTurnId',
    message:
      `原推演头 ${originalHead ?? 'null'} 已不是当前推演头 ${currentHead ?? 'null'}：` +
      '不能把旧时点的刺杀/移动直接插进新状态，需要显式的「从该楼重演后续推演」操作',
    severity: 'error',
    retryable: false,
  };
}

/**
 * E07 retryFailedGroups。
 * 完成定义：时钟与成功物品数量不变化；补交到期动作结算正确。
 */
export function retryFailedGroups(input: FailedGroupRetryInput): FailedGroupRetryResult {
  const issues: Issue[] = [];
  const db = input.db;

  const branch = queryOne(db, 'SELECT id, head_turn_id, revision, clock_s FROM branches WHERE id = ? LIMIT 1', [input.branchId]);
  if (!branch) {
    return {
      status: 'blocked',
      groups: [],
      issues: [makeIssue('REF_UNKNOWN', `找不到分支：${input.branchId}`, 'error', true)],
    };
  }

  const dbHead = branch.head_turn_id === null || branch.head_turn_id === undefined ? null : String(branch.head_turn_id);

  // §7.5 优先判定：后续已经产生了新楼 → 转「重演后续推演」，绝不把旧时点动作插进新状态。
  // （即使调用方捕获的是旧 head，答案也必须是 RETRY_BASE_CHANGED，而不是含糊的过期提示。）
  if (dbHead !== null && dbHead !== input.turnId) {
    return { status: 'replay_required', groups: [], issues: [replayRequiredIssue(input.turnId, dbHead)] };
  }

  // 头部仍是原 turn，但调用方捕获的 head 与库内不一致：先回去重读，不能在错误基态上补交。
  if (input.currentHeadTurnId !== null && input.currentHeadTurnId !== dbHead) {
    return {
      status: 'blocked',
      groups: [],
      issues: [
        makeIssue(
          'STALE_BASE',
          `捕获的推演头 ${input.currentHeadTurnId} 与库内当前头 ${dbHead ?? 'null'} 不一致：重新读取基态后再补交`,
          'error',
          true,
        ),
      ],
    };
  }

  const turn = queryOne(db, 'SELECT id, branch_id FROM turns WHERE id = ? LIMIT 1', [input.turnId]);
  if (!turn) {
    return {
      status: 'blocked',
      groups: [],
      issues: [makeIssue('REF_UNKNOWN', `找不到要补交的 turn：${input.turnId}`, 'error', true)],
    };
  }
  if (String(turn.branch_id) !== input.branchId) {
    return {
      status: 'blocked',
      groups: [],
      issues: [
        makeIssue('TURN_BRANCH_MISMATCH', `turn ${input.turnId} 属于分支 ${String(turn.branch_id)}，不是 ${input.branchId}`, 'error', false),
      ],
    };
  }

  // 时钟只用于核对：漂移只提示，**不**在这里补时间（§7.5 逻辑时间不重加）。
  const branchClock = Number(branch.clock_s ?? 0);
  if (Number.isFinite(branchClock) && branchClock !== input.clockS) {
    issues.push(
      makeIssue(
        'RETRY_CLOCK_DRIFT',
        `补交时的逻辑时刻 ${input.clockS} 与分支当前 clock_s ${branchClock} 不同：本函数不推进时间，按原 operation_id 幂等去重`,
        'warning',
        false,
      ),
    );
  }

  const ordered = orderGroups(input.groups);
  issues.push(...ordered.issues);

  // 幂等键：调用方给的 appliedKeys + **变更日志里已经成功的 operation_id**
  // （日志是权威记录，即使调用方丢掉了内存里的 appliedKeys，已提交的组也只会得到 duplicate）。
  const appliedKeys = new Set(input.appliedKeys ?? []);
  for (const group of ordered.order) {
    for (const mutation of group.mutations) {
      const opKey = mutation.sourceOpIds.join('+');
      if (operationAlreadyApplied(db, input.turnId, opKey, mutation.table, mutation.rowId)) {
        appliedKeys.add(`${mutation.table}\u0000${mutation.rowId}\u0000${opKey}`);
      }
    }
  }

  // 自管事务；若调用方已开事务则在其事务内应用（嵌套 BEGIN 会失败）。
  let ownsTransaction = false;
  try {
    beginTransaction(db);
    ownsTransaction = true;
  } catch {
    ownsTransaction = false;
  }

  let applied: ReturnType<typeof applyGroups>;
  try {
    applied = applyGroups(db, ordered.order, {
      branchId: input.branchId,
      turnId: input.turnId,
      attemptId: input.attemptId,
      appliedKeys,
      validate: true,
    });
  } catch (err) {
    if (ownsTransaction) rollbackTransaction(db);
    return {
      status: 'blocked',
      groups: [],
      issues: [...issues, makeIssue('RETRY_FAILED', `补交失败：${(err as Error).message}`, 'error', true)],
    };
  }

  const sentinel = applied.groups.find((g) => g.groupId === FOREIGN_KEY_SENTINEL);
  const realGroups = applied.groups.filter((g) => g.groupId !== FOREIGN_KEY_SENTINEL);
  for (const group of realGroups) issues.push(...group.issues);

  if (sentinel) {
    issues.push(...sentinel.issues);
    if (ownsTransaction) rollbackTransaction(db);
    return { status: 'blocked', groups: realGroups, issues };
  }

  for (const journalIssue of applied.journalIssues) {
    issues.push(makeIssue('JOURNAL_WRITE_FAILED', journalIssue, 'error', false));
  }

  const anyApplied = realGroups.some((g) => g.status === 'applied');
  const anyFailed = realGroups.some((g) => g.status === 'rejected' || g.status === 'blocked');
  const anyDuplicate = realGroups.some((g) => g.status === 'duplicate');
  const status: FailedGroupRetryResult['status'] = anyApplied ? 'applied' : anyFailed ? 'blocked' : anyDuplicate ? 'duplicate' : 'blocked';

  // §6.3：补交作为一次 kind=retry 的尝试记录到原 turn；失败只记警告，不影响已应用的组。
  const attemptIssue = appendRetryAttempt(db, input, realGroups);
  if (attemptIssue) issues.push(attemptIssue);

  if (ownsTransaction) commitTransaction(db);

  return { status, groups: realGroups, issues };
}

/** 记录本次补交（Attempt:kind=retry）；越界/损坏只返回警告，不掩盖已应用的组。 */
function appendRetryAttempt(db: SqlDatabase, input: FailedGroupRetryInput, groups: GroupResult[]): Issue | null {
  try {
    const rows = queryBound(db, 'SELECT attempts_json FROM turns WHERE id = ? LIMIT 1', [input.turnId]);
    let attempts: Array<Record<string, unknown>> = [];
    const raw = rows[0]?.attempts_json;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) attempts = parsed as Array<Record<string, unknown>>;
    }
    const requested = [...new Set(groups.flatMap((g) => g.opIds))];
    attempts.push({
      id: input.attemptId,
      kind: 'retry',
      chat_uid: input.chatUid,
      branch_id: input.branchId,
      requested_operation_ids: requested,
      group_statuses: groups.map((g) => ({ groupId: g.groupId, status: g.status, changedRows: g.changedRows })),
      clock_s: input.clockS,
    });
    const bounded = attempts.slice(-ATLAS_RUNTIME_LIMITS.detailedAttemptsPerTurn);
    runBound(db, 'UPDATE turns SET attempts_json = ? WHERE id = ?', [JSON.stringify(bounded), input.turnId]);
    return null;
  } catch (err) {
    return makeIssue('RETRY_ATTEMPT_LOG_FAILED', `补交记录写入 turns.attempts_json 失败：${(err as Error).message}`, 'warning', false);
  }
}
