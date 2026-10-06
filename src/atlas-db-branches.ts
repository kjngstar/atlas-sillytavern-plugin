/**
 * atlas-db-branches.ts — E10 forkBranch：按需复制业务当前行，历史引用祖先 turn（§7.4）。
 *
 * 口径（§7.4「分叉初版采用按需复制业务当前行；历史 turns 链共享祖先引用」）：
 * - 只复制**业务当前行**：14 张业务表 + `entity_keys` + `mention_candidates` 共 16 张。
 * - **不**复制父分支的 `turns` / `turn_changes`：新分支的 turns 从分叉 turn 开始，历史按引用共享
 *   祖先 turn（`branches.fork_turn_id` 指回父分支的基点 turn）。
 * - 实体身份 `id` **保持不变**（业务表主键是 `(branch_id,id)`，同 ID 换分支是合法的新行）；
 *   `row_rev` 重置为 1，`created_turn_id`/`updated_turn_id` 指向新分支的分叉 turn。
 * - `branches` 复制时钟/上下界/日历/视角/根图/后台结算字段，`revision` = 父分支当前 revision，
 *   `head_turn_id` = 新分支的分叉 turn，`status='active'`。
 * - 分叉后两个分支完全独立：写入只命中各自的 `(branch_id,id)` 行。
 * - 全部写入在**一个事务**里；`foreign_keys` 保持开启，COMMIT 前显式 `PRAGMA foreign_key_check`。
 *
 * 拒绝语义：`newBranchId` 已存在 → `BRANCH_EXISTS`；`forkTurnId` 不存在 → `REF_UNKNOWN`。
 * 这两个是硬前置条件，`forkBranch` 直接抛 `AtlasDbError`（`.code` 即上述代码）；
 * 需要不抛异常的预检查时用 `inspectForkBranch`。返回值里的 `issues` 承载**非致命**诊断。
 *
 * 本文件不生成随机数：分叉 turn 的 id 由调用方注入的 `makeId` 决定，哈希文本由输入派生。
 */

import {
  AtlasDbError,
  beginTransaction,
  commitTransaction,
  enableForeignKeys,
  foreignKeyCheck,
  queryBound,
  queryOne,
  rollbackTransaction,
  runBound,
} from './atlas-db-runtime.ts';
import { buildInsertSql } from './atlas-db-codec.ts';
import { tableColumnNames } from './atlas-db-schema.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { SqlValue } from './atlas-db-contract.ts';
import type { AtlasTableName } from './atlas-db-contract.ts';
import type { Issue } from './atlas-ops-contract.ts';
import { copySceneForBranch } from './atlas-spatial-branch.ts';

/**
 * 分叉时复制的表（**恰好 16 张**）：14 张业务表 + entity_keys + mention_candidates。
 * `turns`/`turn_changes` 共享祖先引用，`sync_outbox` 属于来源分支（§6.6：换分支停止旧任务并重建）。
 */
export const FORK_COPY_TABLES: readonly AtlasTableName[] = [
  // 身份索引必须先写：四张实体表的 BEFORE INSERT 触发器要求同分支同 ID 的 entity_keys 已在。
  'entity_keys',
  'maps',
  'locations',
  'characters',
  'items',
  'factions',
  'relations',
  'routes',
  'actions',
  'journeys',
  'events',
  'information',
  'rumor_fronts',
  'knowledge',
  'channels',
  'mention_candidates',
];

export type ForkBranchInput = {
  parentBranchId: string;
  newBranchId: string;
  name: string;
  forkTurnId: string | null;
  makeId: (kind: string, opId: string, alias: string) => string;
  nowWallMs: number;
  rulesetVersion: string;
};

export type ForkBranchResult = {
  /** 复制进新分支的**行数**（16 张表合计；不含 branches/new fork turn 自身）。 */
  copiedRows: number;
  newBranchId: string;
  issues: Issue[];
};

export type ForkBranchPrecheck = {
  parentBranchId: string;
  newBranchId: string;
  forkTurnId: string | null;
};

function issue(code: string, path: string, message: string, severity: Issue['severity'] = 'error', retryable = false): Issue {
  return { code, path, message, severity, retryable };
}

/** 稳定短哈希（FNV-1a），只用于确定性 ID/hash 文本，不是安全哈希。 */
function stableHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function text(value: SqlValue | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * 不写库的预检查：分叉前置条件是否成立。
 * 完成定义：重复的分支 ID 与不存在的基点 turn 在这里就能给出具体代码，不必先开事务。
 */
export function inspectForkBranch(input: ForkBranchPrecheck, db: SqlDatabase): { ok: boolean; issues: Issue[] } {
  const issues: Issue[] = [];
  const newBranchId = input.newBranchId.trim();
  if (newBranchId.length === 0) {
    issues.push(issue('BRANCH_ID_INVALID', '$.newBranchId', '新分支 ID 不能为空'));
  }
  if (newBranchId.length > 0 && newBranchId === input.parentBranchId) {
    issues.push(issue('BRANCH_EXISTS', '$.newBranchId', `新分支 ID 与父分支相同：${newBranchId}`, 'error', false));
  }
  const parent = queryOne(db, 'SELECT id FROM branches WHERE id = ? LIMIT 1', [input.parentBranchId]);
  if (!parent) {
    issues.push(issue('REF_UNKNOWN', '$.parentBranchId', `找不到要分叉的父分支：${input.parentBranchId}`));
  }
  const existing = queryOne(db, 'SELECT id FROM branches WHERE id = ? LIMIT 1', [newBranchId]);
  if (existing) {
    issues.push(issue('BRANCH_EXISTS', '$.newBranchId', `分支已存在，不能覆盖：${newBranchId}`, 'error', false));
  }
  if (input.forkTurnId !== null) {
    const turn = queryOne(db, 'SELECT id, branch_id FROM turns WHERE id = ? LIMIT 1', [input.forkTurnId]);
    if (!turn) {
      issues.push(issue('REF_UNKNOWN', '$.forkTurnId', `分叉基点 turn 不存在：${input.forkTurnId}`, 'error', false));
    }
  }
  return { ok: issues.every((i) => i.severity !== 'error'), issues };
}

/**
 * E10 forkBranch：从基点复制业务当前行，历史引用祖先 turn。
 * 完成定义：父子分支后续互不影响。
 */
export function forkBranch(input: ForkBranchInput, db: SqlDatabase): ForkBranchResult {
  enableForeignKeys(db);

  const check = inspectForkBranch(
    { parentBranchId: input.parentBranchId, newBranchId: input.newBranchId, forkTurnId: input.forkTurnId },
    db,
  );
  const fatal = check.issues.find((i) => i.severity === 'error');
  if (fatal) {
    throw new AtlasDbError(fatal.code, fatal.message, {
      parentBranchId: input.parentBranchId,
      newBranchId: input.newBranchId,
      forkTurnId: input.forkTurnId,
      issues: check.issues,
    });
  }

  const parent = queryOne(db, 'SELECT * FROM branches WHERE id = ? LIMIT 1', [input.parentBranchId]);
  if (!parent) {
    // inspectForkBranch 已经拦过；这里只是消除 null 分支并保持不变量。
    throw new AtlasDbError('REF_UNKNOWN', `找不到要分叉的父分支：${input.parentBranchId}`, { parentBranchId: input.parentBranchId });
  }
  const parentHead = text(parent.head_turn_id) || null;
  const issues: Issue[] = [...check.issues];
  if (input.forkTurnId !== null && parentHead !== null && input.forkTurnId !== parentHead) {
    issues.push(
      issue(
        'FORK_TURN_NOT_HEAD',
        '$.forkTurnId',
        `分叉基点 ${input.forkTurnId} 不是父分支当前推演头 ${parentHead}：新分支从历史基点开始，历史按引用共享`,
        'warning',
        false,
      ),
    );
  }

  const parentRevision = Number(parent.revision ?? 0);
  const parentClockS = Number(parent.clock_s ?? 0);
  const parentClockMinS = Number(parent.clock_min_s ?? 0);
  const parentClockMaxS = Number(parent.clock_max_s ?? 0);
  const parentCursorS = Number(parent.simulation_cursor_s ?? 0);
  const parentStatus = text(parent.simulation_status) || 'current';
  const calendarLabel = parent.calendar_label === null || parent.calendar_label === undefined ? null : String(parent.calendar_label);
  const povCharacterId = text(parent.pov_character_id) || null;
  const rootMapId = text(parent.root_map_id) || null;
  const rulesetVersion = input.rulesetVersion || text(parent.ruleset_version) || 'atlas-1';

  // 分叉 turn 的 ID 由调用方注入的 makeId 决定（程序分配，不使用随机数）。
  const forkTurnId = input.makeId('turn', 'branch.fork', `${input.parentBranchId}:${input.forkTurnId ?? 'root'}:${input.newBranchId}`);
  const inputHash = `fork:${stableHash(`${input.parentBranchId}\u0000${input.forkTurnId ?? 'root'}\u0000${input.newBranchId}`)}`;
  const rngSeed = `rng_fork_${stableHash(`${input.newBranchId}\u0000${input.forkTurnId ?? 'root'}`)}`;

  let copiedRows = 0;
  beginTransaction(db);
  try {
    // 1) 分支身份：parent/fork 指回父分支与基点 turn；head 指向本分支自己的分叉 turn。
    runBound(
      db,
      `INSERT INTO branches (id, parent_branch_id, fork_turn_id, head_turn_id, revision, name, pov_character_id, root_map_id,
                             clock_s, clock_min_s, clock_max_s, calendar_label, simulation_cursor_s, simulation_status,
                             ruleset_version, status, created_wall_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [
        input.newBranchId,
        input.parentBranchId,
        input.forkTurnId,
        forkTurnId,
        parentRevision,
        input.name,
        povCharacterId,
        rootMapId,
        parentClockS,
        parentClockMinS,
        parentClockMaxS,
        calendarLabel,
        parentCursorS,
        parentStatus,
        rulesetVersion,
        input.nowWallMs,
      ],
    );

    // 2) 本分支的第一个 turn（kind='fork'）；parent_turn_id 指向父分支的基点 turn（共享引用）。
    runBound(
      db,
      `INSERT INTO turns (id, branch_id, parent_turn_id, host_message_uid, host_variant_key, kind, input_hash, story_hash,
                          base_revision, committed_revision, clock_before_s, elapsed_json, clock_after_s, rng_seed,
                          ruleset_version, decisions_json, receipt_json, attempts_json, status, created_wall_ms, prepared_wall_ms)
       VALUES (?, ?, ?, NULL, NULL, 'fork', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]', 'committed', ?, ?)`,
      [
        forkTurnId,
        input.newBranchId,
        input.forkTurnId,
        inputHash,
        parentRevision,
        parentRevision,
        parentClockS,
        JSON.stringify({ min_s: 0, nominal_s: 0, max_s: 0, quality: 'explicit', basis_refs: [] }),
        parentClockS,
        rngSeed,
        rulesetVersion,
        JSON.stringify({ operations: [], attention_decisions: [], outcome_decisions: [], random_draws: [] }),
        input.nowWallMs,
        input.nowWallMs,
      ],
    );

    // 3) 复制业务当前行：同 ID、换 branch_id、row_rev 归 1、turn 列指向分叉 turn。
    for (const table of FORK_COPY_TABLES) {
      copiedRows += copyTableRows(db, table, input.parentBranchId, input.newBranchId, forkTurnId, parentRevision, issues);
    }

    // §7.4/§7.3：COMMIT 前显式外键检查（不能以 RELEASE/写入成功代替）。
    const violations = foreignKeyCheck(db);
    if (violations.length > 0) {
      throw new AtlasDbError(
        'SQL_CONSTRAINT',
        `分叉后外键检查未通过：${violations.map((v) => `${v.table}->${v.parent}`).join(', ')}`,
        { violations },
      );
    }
    commitTransaction(db);
  } catch (err) {
    rollbackTransaction(db);
    if (err instanceof AtlasDbError) throw err;
    throw new AtlasDbError('FORK_FAILED', `分叉失败：${(err as Error).message}`, {
      parentBranchId: input.parentBranchId,
      newBranchId: input.newBranchId,
      copiedRows,
    });
  }

  return { copiedRows, newBranchId: input.newBranchId, issues };
}

/** 复制一张表的全部分支行；列名来自 schema 常量，值全部参数绑定。 */
function copyTableRows(db: SqlDatabase, table: AtlasTableName, parentBranchId: string, newBranchId: string, forkTurnId: string, newRevision: number, issues: Issue[]): number {
  const columns = tableColumnNames(table);
  const rows = queryBound(db, `SELECT ${columns.join(', ')} FROM ${table} WHERE branch_id = ?`, [parentBranchId]);
  if (rows.length === 0) return 0;
  const insertSql = buildInsertSql(table, columns);
  for (const row of rows) {
    const values: SqlValue[] = columns.map((column) => {
      if (column === 'branch_id') return newBranchId;
      if (column === 'row_rev') return 1;
      if (column === 'created_turn_id' || column === 'updated_turn_id') return forkTurnId;
      // M3/W07：地图框架的分支归属随场景一起搬，父分支的 pending 布局请求不带过来。
      if (table === 'maps' && column === 'frame_json') {
        const copied = copySceneForBranch(row[column], newBranchId, newRevision);
        for (const item of copied.issues) issues.push(item);
        return JSON.stringify(copied.frame);
      }
      const value = row[column];
      return value === undefined ? null : value;
    });
    runBound(db, insertSql, values);
  }
  return rows.length;
}
