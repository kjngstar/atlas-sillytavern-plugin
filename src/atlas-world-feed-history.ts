/**
 * atlas-world-feed-history.ts — M5-01：回合净变化合并与历史快照重建（02 §7.1）。
 *
 * 两条纪律：
 * 1. **净变化**：同一 (turn, table, row) 取第一次 before 与最后一次 after；
 *    中途 set→set→restore 视为无净变化，不发卡。技术列（row_rev / updated_turn_id）
 *    变化不算「故事动过这一行」，否则每次写入都会凭空造出一张动作卡。
 * 2. **过去不能看现在**：历史快照只能由 journal 重建。找不到历史依据的行返回
 *    unresolved，调用方必须按「不确定/隐藏」处理，绝不拿当前行冒充当时状态。
 *
 * 只读：不写库、不建事务、不调用模型。表名只来自程序白名单，绝不拼模型文本。
 */

import { assertSafeIdentifier, queryBound } from './atlas-db-runtime.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import { ATLAS_USER_TABLES } from './atlas-db-contract.ts';
import type { SqlValue } from './atlas-db-contract.ts';
import type { JournalSnapshot, PlanIssue } from './atlas-world-contract.ts';

/** journal 行的最小输入投影；与 contracts/atlas-world-plan-contract.ts 的 collapseTurnSnapshots 入参逐字一致。 */
export type TurnChangeInput = {
  turnId: string;
  sequence: number;
  table: string;
  rowId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  operationId: string;
  groupId: string;
};

/**
 * 技术记账列：它们随每次写入变化，但不构成任何「世界动过」的证据。
 * 同回合 A→B→A 的 row_rev 会从 1 变到 3，如果参与比较就会被误判成净变化。
 */
const BOOKKEEPING_COLUMNS = new Set(['row_rev', 'updated_turn_id']);

/** 只有这些回合状态提供可信历史：完整提交或部分提交。pending/failed/rolled_back 一律排除。 */
export const HISTORICAL_TURN_STATUSES = ['committed', 'partial'] as const;

/** 默认需要重建历史快照的表（人物位置、地点归属、信息接收时刻）。 */
export const HISTORICAL_DEFAULT_TABLES = ['characters', 'locations', 'information'] as const;

const MAX_TURN_IDS_PER_QUERY = 200;

function planIssue(
  code: string,
  path: string,
  message: string,
  extra: Partial<PlanIssue> = {},
): PlanIssue {
  return { code, path, message, severity: 'warning', retryable: false, ...extra };
}

/** 稳定序列化：键排序、跳过 undefined。数组保持顺序（顺序本身就是数据）。 */
function canonicalValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalValue(record[k])}`).join(',')}}`;
}

/** 行级净变化口径：剔除技术记账列后做 canonical 比较。 */
function canonicalRow(row: Record<string, unknown> | null | undefined): string {
  if (row === null || row === undefined) return 'null';
  const keys = Object.keys(row)
    .filter((k) => !BOOKKEEPING_COLUMNS.has(k) && row[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalValue(row[k])}`).join(',')}}`;
}

function asRow(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return { ...(value as Record<string, unknown>) };
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * E03：把同一回合的 journal 行合并成「每行一次净变化」。
 * - 组内按 sequence 排序（输入顺序可以乱），before 取第一条、after 取最后一条。
 * - operation/group ID 去重合并后升序，保证乱序输入给出完全一致的结果。
 * - before 与 after 的 canonical 形式相同 → 无净变化，直接丢弃（A→B→A 不发卡）。
 * - 输出按 (turnId, table, rowId) 排序，与输入顺序无关。
 */
export function collapseTurnSnapshots(rows: readonly TurnChangeInput[]): JournalSnapshot[] {
  type Group = {
    key: string;
    turnId: string;
    table: string;
    rowId: string;
    entries: Array<{ sequence: number; order: number; operationId: string; groupId: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>;
  };
  const groups = new Map<string, Group>();
  let order = 0;

  for (const raw of rows ?? []) {
    if (!raw || typeof raw.turnId !== 'string' || typeof raw.table !== 'string' || typeof raw.rowId !== 'string') continue;
    const key = `${raw.turnId}\u0000${raw.table}\u0000${raw.rowId}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, turnId: raw.turnId, table: raw.table, rowId: raw.rowId, entries: [] };
      groups.set(key, group);
    }
    group.entries.push({
      sequence: Number.isFinite(raw.sequence) ? Number(raw.sequence) : 0,
      order: order++,
      operationId: typeof raw.operationId === 'string' ? raw.operationId : '',
      groupId: typeof raw.groupId === 'string' ? raw.groupId : '',
      before: asRow(raw.before),
      after: asRow(raw.after),
    });
  }

  const out: JournalSnapshot[] = [];
  for (const group of groups.values()) {
    group.entries.sort(
      (a, b) => a.sequence - b.sequence || compareText(a.operationId, b.operationId) || compareText(a.groupId, b.groupId) || a.order - b.order,
    );
    const first = group.entries[0];
    const last = group.entries[group.entries.length - 1];
    if (canonicalRow(first.before) === canonicalRow(last.after)) continue;
    const operationIds = [...new Set(group.entries.map((e) => e.operationId).filter(Boolean))].sort(compareText);
    const groupIds = [...new Set(group.entries.map((e) => e.groupId).filter(Boolean))].sort(compareText);
    out.push({ turnId: group.turnId, table: group.table, rowId: group.rowId, before: first.before, after: last.after, operationIds, groupIds });
  }
  out.sort(
    (a, b) => compareText(a.turnId, b.turnId) || compareText(a.table, b.table) || compareText(a.rowId, b.rowId),
  );
  return out;
}

export type HistoricalRow = {
  table: string;
  rowId: string;
  /** 截至目标回合，这一行是否存在（false = 那时还没建，或那时已删除）。 */
  exists: boolean;
  /** 目标回合时的字段快照；exists=false 时为 null。 */
  row: Record<string, unknown> | null;
  /** 最后一次影响该行的回合；快照就是它写下的 after。 */
  lastTurnId: string;
  lastSequence: number;
  operationIds: string[];
  groupIds: string[];
};

export type HistoricalSnapshotResult = {
  ok: boolean;
  branchId: string;
  turnId: string;
  /** 目标回合的 committed_revision；不可信时是 null。 */
  committedRevision: number | null;
  turnStatus: string | null;
  /** 参与重建的完整回合 ID（按提交顺序，含目标回合）。 */
  turnIds: string[];
  /** 键为 `${table}\u0000${rowId}`，只含 journal 有依据的行。 */
  rows: Record<string, HistoricalRow>;
  /** 目标回合时确实存在的行 ID（按表）。 */
  present: Record<string, string[]>;
  /**
   * 现在存在、但 journal 窗口里查不到任何依据的行 —— 只能用「不确定/隐藏」处理。
   * 绝不允许用当前行冒充当时状态（E05）。
   */
  unresolved: Record<string, string[]>;
  /** 本次实际读取的 journal 行数（用于分页/预算观察）。 */
  journalEntries: number;
  issues: PlanIssue[];
};

/** 读取 journal 原始行（无 LIMIT：不能把一轮里前 N 行截断当成完整变化）。 */
function readJournalRows(
  db: SqlDatabase,
  turnIds: readonly string[],
  tables: readonly string[],
): { entries: TurnChangeInput[]; issues: PlanIssue[]; rawCount: number; countsByTurn: Map<string, number> } {
  const issues: PlanIssue[] = [];
  const entries: TurnChangeInput[] = [];
  const countsByTurn = new Map<string, number>();
  let rawCount = 0;
  if (turnIds.length === 0) return { entries, issues, rawCount, countsByTurn };
  const allowed = new Set(tables);

  for (let start = 0; start < turnIds.length; start += MAX_TURN_IDS_PER_QUERY) {
    const chunk = turnIds.slice(start, start + MAX_TURN_IDS_PER_QUERY);
    const sql = `SELECT turn_id, sequence, operation_id, group_id, target_table, target_row_id, before_json, after_json
       FROM turn_changes WHERE turn_id IN (${chunk.map(() => '?').join(', ')}) ORDER BY sequence ASC`;
    const rows = queryBound(db, sql, chunk as string[]);
    for (const row of rows) {
      rawCount += 1;
      const table = String(row.target_table ?? '');
      const turnId = String(row.turn_id ?? '');
      countsByTurn.set(turnId, (countsByTurn.get(turnId) ?? 0) + 1);
      if (!allowed.has(table)) continue;
      const sequence = Number(row.sequence ?? 0);
      const beforeJson = row.before_json === null || row.before_json === undefined ? null : String(row.before_json);
      const afterJson = row.after_json === null || row.after_json === undefined ? null : String(row.after_json);
      let before: Record<string, unknown> | null = null;
      let after: Record<string, unknown> | null = null;
      let broken = false;
      try {
        before = beforeJson === null ? null : asRow(JSON.parse(beforeJson));
        after = afterJson === null ? null : asRow(JSON.parse(afterJson));
      } catch {
        broken = true;
      }
      if (broken) {
        issues.push(
          planIssue('JOURNAL_JSON_INVALID', `$.turnChanges.${table}.${String(row.target_row_id ?? '')}`,
            '变更日志里的 before/after 不是可解析的 JSON；该行按「历史不可判定」处理，不采用当前值', {
              severity: 'error',
              relatedIds: [String(row.target_row_id ?? '')],
            }),
        );
        continue;
      }
      entries.push({
        turnId,
        sequence,
        table,
        rowId: String(row.target_row_id ?? ''),
        before,
        after,
        operationId: String(row.operation_id ?? ''),
        groupId: String(row.group_id ?? ''),
      });
    }
  }
  return { entries, issues, rawCount, countsByTurn };
}

/**
 * 供事件流视图使用：一次读出若干回合的 journal 原始行，并给出每回合的行数
 * （用于「单轮 journal 超上限就整轮不发卡」的判定）。
 * 绝不加行级 LIMIT，否则会把半轮当成完整变化。
 */
export function readTurnChangeRows(
  db: SqlDatabase,
  turnIds: readonly string[],
  tables: readonly string[],
): { entries: TurnChangeInput[]; issues: PlanIssue[]; rawCount: number; countsByTurn: Map<string, number> } {
  return readJournalRows(db, turnIds, tables);
}

/**
 * E03/E05：按目标回合的 committed_revision 重建当时的人物/地点/信息快照。
 *
 * - 只认 committed / partial 且有 committed_revision 的回合；failed、rolled_back、pending 一律排除。
 * - 目标回合自身不可信时直接 ok:false，绝不退化成「读当前行」。
 * - 逐回合按 sequence 折叠：行的状态 = 窗口里最后一次 after。
 */
export function readHistoricalRows(
  db: SqlDatabase,
  input: { branchId: string; turnId: string; tables?: readonly string[] },
): HistoricalSnapshotResult {
  const branchId = String(input?.branchId ?? '');
  const turnId = String(input?.turnId ?? '');
  const tables = [...new Set((input?.tables ?? HISTORICAL_DEFAULT_TABLES).map((t) => String(t)))];
  const base: HistoricalSnapshotResult = {
    ok: false,
    branchId,
    turnId,
    committedRevision: null,
    turnStatus: null,
    turnIds: [],
    rows: {},
    present: {},
    unresolved: {},
    journalEntries: 0,
    issues: [],
  };
  if (!branchId || !turnId) {
    return { ...base, issues: [planIssue('TURN_REF_REQUIRED', '$.turnId', '需要分支与回合标识', { severity: 'error' })] };
  }
  for (const table of tables) {
    if (!(ATLAS_USER_TABLES as readonly string[]).includes(table)) {
      return { ...base, issues: [planIssue('TABLE_NOT_ALLOWED', '$.tables', `时间线只读白名单之外的表明：${table}`, { severity: 'error' })] };
    }
  }

  const turnRows = queryBound(
    db,
    'SELECT id, status, committed_revision FROM turns WHERE branch_id = ? AND id = ?',
    [branchId, turnId],
  );
  if (turnRows.length === 0) {
    return { ...base, issues: [planIssue('TURN_NOT_FOUND', '$.turnId', '该分支没有这个回合，不能凭当前数据假装知道当时状态', { severity: 'error' })] };
  }
  const turnStatus = String(turnRows[0].status ?? '');
  const committedRevisionRaw = turnRows[0].committed_revision;
  if (!(HISTORICAL_TURN_STATUSES as readonly string[]).includes(turnStatus) || committedRevisionRaw === null || committedRevisionRaw === undefined) {
    return {
      ...base,
      turnStatus,
      issues: [planIssue('TURN_NOT_COMMITTED', '$.turnId', `回合状态为 ${turnStatus || 'unknown'}，失败/回退/未提交的回合没有可信历史`, { severity: 'error' })],
    };
  }
  const committedRevision = Number(committedRevisionRaw);
  if (!Number.isInteger(committedRevision)) {
    return { ...base, turnStatus, issues: [planIssue('TURN_REVISION_INVALID', '$.committedRevision', 'committed_revision 不是整数，历史窗口无法界定', { severity: 'error' })] };
  }

  const windowTurns = queryBound(
    db,
    `SELECT id, committed_revision, created_wall_ms FROM turns
      WHERE branch_id = ? AND committed_revision IS NOT NULL AND committed_revision <= ?
        AND status IN (${HISTORICAL_TURN_STATUSES.map(() => '?').join(', ')})
      ORDER BY committed_revision ASC, created_wall_ms ASC, id ASC`,
    [branchId, committedRevision, ...HISTORICAL_TURN_STATUSES] as SqlValue[],
  );
  const turnIds = windowTurns.map((t) => String(t.id));
  const turnRank = new Map(turnIds.map((id, index) => [id, index]));

  const { entries, issues, rawCount } = readJournalRows(db, turnIds, tables);
  entries.sort(
    (a, b) => (turnRank.get(a.turnId) ?? 0) - (turnRank.get(b.turnId) ?? 0) || a.sequence - b.sequence,
  );

  const folded = new Map<string, HistoricalRow>();
  for (const entry of entries) {
    const key = `${entry.table}\u0000${entry.rowId}`;
    const existing = folded.get(key);
    const operationIds = new Set(existing?.operationIds ?? []);
    if (entry.operationId) operationIds.add(entry.operationId);
    const groupIds = new Set(existing?.groupIds ?? []);
    if (entry.groupId) groupIds.add(entry.groupId);
    folded.set(key, {
      table: entry.table,
      rowId: entry.rowId,
      exists: entry.after !== null,
      row: entry.after,
      lastTurnId: entry.turnId,
      lastSequence: entry.sequence,
      operationIds: [...operationIds].sort(compareText),
      groupIds: [...groupIds].sort(compareText),
    });
  }

  const rows: Record<string, HistoricalRow> = {};
  const present: Record<string, string[]> = {};
  const unresolved: Record<string, string[]> = {};
  for (const table of tables) {
    assertSafeIdentifier(table);
    present[table] = [];
    unresolved[table] = [];
    const currentIds = queryBound(db, `SELECT id FROM ${table} WHERE branch_id = ?`, [branchId])
      .map((r) => String(r.id ?? ''))
      .filter(Boolean);
    for (const id of currentIds) {
      if (!folded.has(`${table}\u0000${id}`)) unresolved[table].push(id);
    }
    present[table].sort(compareText);
    unresolved[table].sort(compareText);
  }
  for (const [key, value] of folded) {
    rows[key] = value;
    if (value.exists) present[value.table]?.push(value.rowId);
  }
  for (const table of tables) present[table]?.sort(compareText);

  return {
    ok: true,
    branchId,
    turnId,
    committedRevision,
    turnStatus,
    turnIds,
    rows,
    present,
    unresolved,
    journalEntries: rawCount,
    issues,
  };
}
