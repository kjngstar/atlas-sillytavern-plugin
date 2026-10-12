/**
 * atlas-db-readport.ts — 编译器的只读基态/候选态读取入口。
 *
 * 表名与列名只来自 atlas-db-schema.ts 常量，不接受模型文本；值一律参数绑定。
 * 这是 §16.5 第二遍「构建读集」和编译器查询既有行的唯一通道。
 *
 * P09A/§15.4 第 12 条：`construction_progress` 是程序内部表，**只能由程序按常量表名访问**。
 * 它不在模型短引用目录（`atlas-sql-refs.ts` 的 CATALOG 是固定清单）里，
 * 也不接受任何来自模型文本的表名/列名 —— 因此不存在「模型 SQL 注入进度表」的路径。
 */

import { decodeRow, encodeRow } from './atlas-db-codec.ts';
import { ATLAS_TABLE_COLUMNS, isKnownTable, tableColumnNames } from './atlas-db-schema.ts';
import { queryBound } from './atlas-db-runtime.ts';
import type { AtlasTableName, SqlValue } from './atlas-db-contract.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { TableReadPort } from './atlas-ops-compile-types.ts';

function pkColumns(table: AtlasTableName): string[] {
  if (table === 'branches' || table === 'turns' || table === 'turn_changes' || table === 'sync_outbox') return ['id'];
  return ['branch_id', 'id'];
}

export function createTableReadPort(db: SqlDatabase): TableReadPort {
  return {
    selectOne(table: AtlasTableName, branchId: string, id: string): Record<string, unknown> | null {
      if (!isKnownTable(table)) return null;
      const pks = pkColumns(table);
      const where = pks.map((c) => `${c} = ?`).join(' AND ');
      const params: SqlValue[] = pks.includes('branch_id') ? [branchId, id] : [id];
      const rows = queryBound(db, `SELECT * FROM ${table} WHERE ${where} LIMIT 1`, params);
      if (rows.length === 0) return null;
      const decoded = decodeRow(table, rows[0], { allowExtra: true });
      if (!decoded.ok) throw new Error(`READ_DECODE_FAILED: ${table}: ${decoded.issues.map((i) => i.path).join(',')}`);
      const row = decoded.row as Record<string, unknown>;
      if (pks.includes('branch_id')) row.branch_id = branchId;
      return row;
    },
    selectWhere(table: AtlasTableName, where: Record<string, unknown>, limit = 200): Array<Record<string, unknown>> {
      if (!isKnownTable(table)) return [];
      const clauses: string[] = [];
      const params: SqlValue[] = [];
      for (const [key, value] of Object.entries(where)) {
        if (!tableColumnNames(table).includes(key)) continue;
        if (value === null) {
          clauses.push(`${key} IS NULL`);
        } else if (typeof value === 'boolean') {
          clauses.push(`${key} = ?`);
          params.push(value ? 1 : 0);
        } else if (typeof value === 'number' || typeof value === 'string') {
          clauses.push(`${key} = ?`);
          params.push(value);
        } else if (Array.isArray(value)) {
          if (value.length === 0) {
            clauses.push('0');
            continue;
          }
          clauses.push(`${key} IN (${value.map(() => '?').join(',')})`);
          for (const v of value) params.push(v as SqlValue);
        } else {
          continue;
        }
      }
      // 固定排序：程序提供的短引用（C1/L1 等）必须与行顺序一致且可复现，
      // 否则同一轮里「C2」会随机指向不同人物（§8.3 短引用稳定性）。
      const sql = `SELECT * FROM ${table}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${tableColumnNames(table).includes('branch_id') ? 'branch_id, ' : ''}id ASC LIMIT ${Math.max(1, Math.min(1001, limit))}`;
      const rows = queryBound(db, sql, params);
      return rows.map((row) => {
        const decoded = decodeRow(table, row, { allowExtra: true });
        if (!decoded.ok) throw new Error(`READ_DECODE_FAILED: ${table}: ${decoded.issues.map((i) => i.path).join(',')}`);
        return decoded.row as Record<string, unknown>;
      });
    },
    /**
     * P08/R05：程序白名单分页。表名先过 isKnownTable，条件固定为 `id > ?`，
     * 排序固定 `id ASC`，页大小夹在 1..500 —— 调用方无法注入任意列或表达式。
     * `branch_id` 只在有该列的表上参与过滤。
     */
    selectPage(table: AtlasTableName, branchId: string, afterId: string | null, pageSize: number): Array<Record<string, unknown>> {
      if (!isKnownTable(table)) return [];
      const size = Math.max(1, Math.min(500, Number.isFinite(pageSize) ? Math.floor(pageSize) : 200));
      const hasBranch = tableColumnNames(table).includes('branch_id');
      const clauses: string[] = [];
      const params: SqlValue[] = [];
      if (hasBranch) {
        clauses.push('branch_id = ?');
        params.push(branchId);
      }
      if (afterId !== null && afterId !== undefined && String(afterId).length > 0) {
        clauses.push('id > ?');
        params.push(String(afterId));
      }
      const sql = `SELECT * FROM ${table}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY id ASC LIMIT ${size}`;
      const rows = queryBound(db, sql, params);
      return rows.map((row) => {
        const decoded = decodeRow(table, row, { allowExtra: true });
        if (!decoded.ok) throw new Error(`READ_DECODE_FAILED: ${table}: ${decoded.issues.map((i) => i.path).join(',')}`);
        const decodedRow = decoded.row as Record<string, unknown>;
        if (hasBranch) decodedRow.branch_id = branchId;
        return decodedRow;
      });
    },
  };
}

/**
 * 逐页读完一张表（有 selectPage 走分页，否则退回按 id 排序的 selectWhere）。
 * 返回的 rows 一定按 id 升序，且不受 1,001 行硬上限影响。
 */
export function pageAllRows(
  tables: TableReadPort,
  table: AtlasTableName,
  branchId: string,
  pageSize = 500,
): Array<Record<string, unknown>> {
  if (typeof tables.selectPage !== 'function') {
    return tables.selectWhere(table, { branch_id: branchId }, 1001);
  }
  const out: Array<Record<string, unknown>> = [];
  let afterId: string | null = null;
  for (let guard = 0; guard < 10000; guard += 1) {
    const page = tables.selectPage(table, branchId, afterId, pageSize);
    if (page.length === 0) break;
    out.push(...page);
    const last = page[page.length - 1];
    const nextId = last && last.id !== undefined && last.id !== null ? String(last.id) : '';
    if (!nextId || nextId === afterId) break;
    afterId = nextId;
    if (page.length < pageSize) break;
  }
  return out;
}

/** 只读查询整表列名（供诊断/测试断言列序）。 */
export function describeTable(table: AtlasTableName): string[] {
  return ATLAS_TABLE_COLUMNS[table].map((c) => c.name);
}

/** 便于仓库层：编码一行用于写入前校验（不执行 SQL）。 */
export function encodeForWrite(table: AtlasTableName, row: Record<string, unknown>) {
  return encodeRow(table, row, { requireAll: true });
}
