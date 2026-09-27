/**
 * atlas-db-journal.ts — §6.4 变更日志（E04）。
 *
 * 规则：
 * - 同组同一行多次更新合并为一个 before/after，避免每改一个字段都复制整行。
 * - 唯一键至少包含 (turn_id, operation_id, target_table, target_row_id)；
 *   turn+sequence 唯一。
 * - 表名只能来自程序白名单，不能直接拼 AI 字符串形成 SQL。
 * - 记录范围：14 业务表、entity_keys、mention_candidates，以及 branches 的可回退字段。
 */

import { assertSafeIdentifier, runBound } from './atlas-db-runtime.ts';
import { JOURNALED_TABLES, ATLAS_USER_TABLES } from './atlas-db-contract.ts';
import type { RowMutation } from './atlas-ops-contract.ts';
import type { SqlValue } from './atlas-db-contract.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';

export type JournalEntry = {
  id: string;
  turnId: string;
  sequence: number;
  attemptId: string;
  groupId: string;
  operationId: string;
  targetTable: string;
  targetRowId: string;
  operation: 'insert' | 'update' | 'delete';
  beforeJson: string | null;
  afterJson: string | null;
  basisJson: string;
  summary: string;
};

export function isJournaledTable(table: string): boolean {
  return JOURNALED_TABLES.includes(table);
}

export function isKnownUserTable(table: string): boolean {
  return (ATLAS_USER_TABLES as readonly string[]).includes(table);
}

function serializeNullable(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

/**
 * 合并同一 group 内同一行的多次更新：
 * before 取最早，after 取最新；sourceOpIds 与 basis 合并。
 */
export function mergeGroupMutations(mutations: RowMutation[]): RowMutation[] {
  const byKey = new Map<string, RowMutation>();
  const order: string[] = [];
  for (const m of mutations) {
    const key = `${m.table}\u0000${m.rowId}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        table: m.table,
        rowId: m.rowId,
        before: m.before === null ? null : { ...m.before },
        after: m.after === null ? null : { ...m.after },
        sourceOpIds: [...m.sourceOpIds],
        basis: { ...m.basis },
      });
      order.push(key);
      continue;
    }
    if (existing.before === null && m.before !== null) existing.before = { ...m.before };
    existing.after = m.after === null ? null : { ...m.after };
    for (const opId of m.sourceOpIds) {
      if (!existing.sourceOpIds.includes(opId)) existing.sourceOpIds.push(opId);
    }
    existing.basis = { ...existing.basis, ...m.basis };
  }
  return order.map((k) => byKey.get(k)!);
}

export function mutationOperationKind(m: RowMutation): 'insert' | 'update' | 'delete' {
  if (m.before === null && m.after !== null) return 'insert';
  if (m.before !== null && m.after === null) return 'delete';
  return 'update';
}

/**
 * E04 recordGroupChanges：写 turn_changes。
 * 需要调用方提供该 turn 已用到的最大 sequence，返回写入条数与新的最大 sequence。
 */
export function recordGroupChanges(
  db: SqlDatabase,
  group: { id: string; mutations: RowMutation[]; opIds: string[] },
  ctx: { turnId: string; attemptId: string; startSequence: number; makeLogId?: (group: string, index: number, table: string, rowId: string) => string },
): { written: number; nextSequence: number; issues: string[] } {
  const merged = mergeGroupMutations(group.mutations);
  let sequence = ctx.startSequence;
  let written = 0;
  const issues: string[] = [];

  for (let i = 0; i < merged.length; i += 1) {
    const m = merged[i];
    if (!isKnownUserTable(m.table)) {
      issues.push(`JOURNAL_TABLE_NOT_ALLOWED: ${m.table}`);
      continue;
    }
    if (!isJournaledTable(m.table)) {
      issues.push(`JOURNAL_TABLE_NOT_JOURNALED: ${m.table}`);
      continue;
    }
    assertSafeIdentifier(m.table);
    const operation = mutationOperationKind(m);
    const operationId = m.sourceOpIds.length > 0 ? m.sourceOpIds.join('+') : `${group.id}:${i}`;
    const id = ctx.makeLogId
      ? ctx.makeLogId(group.id, i, m.table, m.rowId)
      : `chg_${ctx.turnId}_${sequence}_${i}`;
    const entry: JournalEntry = {
      id,
      turnId: ctx.turnId,
      sequence,
      attemptId: ctx.attemptId,
      groupId: group.id,
      operationId,
      targetTable: m.table,
      targetRowId: m.rowId,
      operation,
      beforeJson: serializeNullable(m.before),
      afterJson: serializeNullable(m.after),
      basisJson: JSON.stringify(m.basis ?? {}),
      summary: summarizeMutation(m, operation),
    };
    const bind = [
      entry.id,
      entry.turnId,
      entry.sequence,
      entry.attemptId,
      entry.groupId,
      entry.operationId,
      entry.targetTable,
      entry.targetRowId,
      entry.operation,
      entry.beforeJson,
      entry.afterJson,
      entry.basisJson,
      entry.summary,
    ];
    try {
      runBound(
        db,
        `INSERT INTO turn_changes (id, turn_id, sequence, attempt_id, group_id, operation_id, target_table, target_row_id, operation, before_json, after_json, basis_json, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        bind as Array<string | number | null>,
      );
    } catch (err) {
      issues.push(`JOURNAL_INSERT_FAILED: ${(err as Error).message}`);
      continue;
    }
    sequence += 1;
    written += 1;
  }
  return { written, nextSequence: sequence, issues };
}

function summarizeMutation(m: RowMutation, operation: 'insert' | 'update' | 'delete'): string {
  const name = (m.after ?? m.before ?? {}) as Record<string, unknown>;
  const label = typeof name.name === 'string' ? name.name : typeof name.title === 'string' ? name.title : m.rowId;
  const verb = operation === 'insert' ? '新增' : operation === 'delete' ? '删除' : '修改';
  if (operation === 'update' && m.before && m.after) {
    const changed = Object.keys(m.after).filter((k) => JSON.stringify((m.before as Record<string, unknown>)[k]) !== JSON.stringify((m.after as Record<string, unknown>)[k]));
    const fields = changed.slice(0, 6).join('、');
    return `${verb}${m.table}「${label}」：${fields}${changed.length > 6 ? ' 等' : ''}`;
  }
  return `${verb}${m.table}「${label}」`;
}

/** 幂等检查：同 (turn, operation_id, table, row) 已存在则返回 true（重复执行只能返回 duplicate）。 */
export function operationAlreadyApplied(
  db: SqlDatabase,
  turnId: string,
  operationId: string,
  table: string,
  rowId: string,
): boolean {
  const rows = db.exec(
    `SELECT COUNT(*) AS n FROM turn_changes WHERE turn_id = ? AND operation_id = ? AND target_table = ? AND target_row_id = ?`,
    [turnId, operationId, table, rowId] as string[],
  );
  const n = rows?.[0]?.values?.[0]?.[0];
  return Number(n ?? 0) > 0;
}

/** 逆序读出某 turn 的变更行（回退用）。 */
export function readTurnChanges(db: SqlDatabase, turnId: string): JournalEntry[] {
  const rows = db.exec(
    `SELECT id, turn_id, sequence, attempt_id, group_id, operation_id, target_table, target_row_id, operation, before_json, after_json, basis_json, summary
     FROM turn_changes WHERE turn_id = ? ORDER BY sequence ASC`,
    [turnId] as string[],
  );
  if (!rows || rows.length === 0) return [];
  const cols = rows[0].columns;
  return rows[0].values.map((v) => {
    const rec: Record<string, SqlValue> = {};
    cols.forEach((c, i) => {
      rec[c] = v[i] as SqlValue;
    });
    return {
      id: String(rec.id),
      turnId: String(rec.turn_id),
      sequence: Number(rec.sequence),
      attemptId: String(rec.attempt_id ?? ''),
      groupId: String(rec.group_id ?? ''),
      operationId: String(rec.operation_id ?? ''),
      targetTable: String(rec.target_table),
      targetRowId: String(rec.target_row_id),
      operation: rec.operation as 'insert' | 'update' | 'delete',
      beforeJson: rec.before_json === null ? null : String(rec.before_json),
      afterJson: rec.after_json === null ? null : String(rec.after_json),
      basisJson: String(rec.basis_json ?? '{}'),
      summary: String(rec.summary ?? ''),
    };
  });
}
