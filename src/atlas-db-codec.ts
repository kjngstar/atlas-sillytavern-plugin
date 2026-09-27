/**
 * atlas-db-codec.ts — §16.2 行 ↔ SQL 值转换（A29 / A30）。
 *
 * 唯一转换点：SQL 行用字段表的 snake_case，DTO 用 camelCase，只在这里转换。
 * 规则：
 * - bool 存 INTEGER 0/1；秒/米/坐标用有限 REAL；计数/版本用 INTEGER；ID/枚举/text 用 TEXT；
 *   小 JSON 列由程序 JSON.stringify 为 TEXT（不依赖 JSON1 扩展）。
 * - 损坏的 JSON 列必须报具体路径，**不能静默替换成 []**。
 * - NaN/Infinity 一律非法。
 * - 数据里的引号和分号完全当作值（参数绑定）。
 */

import { ATLAS_TABLE_COLUMNS, isKnownTable, tableColumnNames } from './atlas-db-schema.ts';
import type { AtlasTableName, SqlValue } from './atlas-db-contract.ts';

const BOOLEAN_COLUMNS = new Set(['scale_locked', 'bidirectional', 'is_pov']);

export function isJsonColumn(name: string): boolean {
  return name.endsWith('_json');
}

export function isBooleanColumn(name: string): boolean {
  return BOOLEAN_COLUMNS.has(name);
}

export type CodecIssue = { path: string; message: string; code: string };

export type EncodeResult<T> =
  | { ok: true; columns: string[]; values: SqlValue[]; row: T }
  | { ok: false; issues: CodecIssue[] };

export type DecodeResult<T> = { ok: true; row: T } | { ok: false; issues: CodecIssue[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 有限实数检查：NaN / ±Infinity / 非数字一律拒绝。 */
export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 规范化 JS 值 → SQL 绑定值。
 * - undefined → null
 * - boolean → 0/1（仅该列是 bool 列时；其它列上的 boolean 视为类型错误）
 * - object/array → 仅该列是 JSON 列时 stringify
 * - 有限数字 / string / null / Uint8Array 直接通过
 */
function normalizeValue(table: string, column: string, value: unknown): { ok: true; value: SqlValue } | { ok: false; issue: CodecIssue } {
  const path = `${table}.${column}`;
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value === 'boolean') {
    if (!isBooleanColumn(column)) {
      return { ok: false, issue: { code: 'CODEC_TYPE_INVALID', path, message: `列 ${column} 不是布尔列，不接受 boolean` } };
    }
    return { ok: true, value: value ? 1 : 0 };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return { ok: false, issue: { code: 'CODEC_NUMBER_NOT_FINITE', path, message: `列 ${column} 不接受 NaN/Infinity` } };
    }
    return { ok: true, value };
  }
  if (typeof value === 'string') return { ok: true, value };
  if (value instanceof Uint8Array) return { ok: true, value };
  if (isPlainObject(value) || Array.isArray(value)) {
    if (!isJsonColumn(column)) {
      return { ok: false, issue: { code: 'CODEC_TYPE_INVALID', path, message: `列 ${column} 不是 JSON 列，不接受对象/数组` } };
    }
    try {
      return { ok: true, value: JSON.stringify(value) };
    } catch (err) {
      return { ok: false, issue: { code: 'CODEC_JSON_UNSERIALIZABLE', path, message: `列 ${column} 无法序列化：${(err as Error).message}` } };
    }
  }
  return { ok: false, issue: { code: 'CODEC_TYPE_INVALID', path, message: `列 ${column} 的值类型不受支持：${typeof value}` } };
}

/**
 * A30 encodeRow：固定列序、参数数组、JSON 序列化。
 * 未出现在 row 里的列按 NULL 编码（调用方应先过 createRow 补默认）。
 */
export function encodeRow<T = Record<string, unknown>>(
  table: AtlasTableName,
  row: Record<string, unknown>,
  options: { requireAll?: boolean } = {},
): EncodeResult<T> {
  if (!isKnownTable(table)) {
    return { ok: false, issues: [{ code: 'CODEC_UNKNOWN_TABLE', path: String(table), message: `未知表名：${String(table)}` }] };
  }
  const spec = ATLAS_TABLE_COLUMNS[table];
  const issues: CodecIssue[] = [];
  const values: SqlValue[] = [];

  for (const column of spec) {
    const present = Object.prototype.hasOwnProperty.call(row, column.name);
    const value = present ? row[column.name] : null;
    if (!column.nullable && (value === null || value === undefined)) {
      issues.push({ code: 'CODEC_REQUIRED_NULL', path: `${table}.${column.name}`, message: `列 ${column.name} 不允许 NULL` });
      values.push(null);
      continue;
    }
    const normalized = normalizeValue(table, column.name, value);
    if (!normalized.ok) {
      issues.push(normalized.issue);
      values.push(null);
      continue;
    }
    values.push(normalized.value);
  }

  if (options.requireAll) {
    for (const key of Object.keys(row)) {
      if (!spec.some((c) => c.name === key)) {
        issues.push({ code: 'CODEC_UNKNOWN_COLUMN', path: `${table}.${key}`, message: `表 ${table} 没有列 ${key}` });
      }
    }
  }

  if (issues.length) return { ok: false, issues };
  return { ok: true, columns: tableColumnNames(table), values, row: row as T };
}

/** A30 辅助：生成 `INSERT INTO t (cols) VALUES (?,?,...)`。 */
export function buildInsertSql(table: AtlasTableName, columns: string[]): string {
  const placeholders = columns.map(() => '?').join(', ');
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
}

/** A30 辅助：生成按主键定位的 UPDATE。 */
export function buildUpdateSql(table: AtlasTableName, columns: string[]): string {
  const assignments = columns.map((c) => `${c} = ?`).join(', ');
  if (table === 'branches' || table === 'turns' || table === 'turn_changes' || table === 'sync_outbox') {
    return `UPDATE ${table} SET ${assignments} WHERE id = ?`;
  }
  return `UPDATE ${table} SET ${assignments} WHERE branch_id = ? AND id = ?`;
}

export function buildDeleteSql(table: AtlasTableName): string {
  if (table === 'branches' || table === 'turns' || table === 'turn_changes' || table === 'sync_outbox') {
    return `DELETE FROM ${table} WHERE id = ?`;
  }
  return `DELETE FROM ${table} WHERE branch_id = ? AND id = ?`;
}

/**
 * 无主键冲突的插入：entity_keys / mention_candidates 等在重试时不得因重复行失败。
 * 只对「已知键」做受控 ON CONFLICT DO NOTHING（§16.5 禁止把 INSERT OR REPLACE 当通用 upsert）。
 */
export function buildInsertOrIgnoreSql(table: AtlasTableName, columns: string[]): string {
  const placeholders = columns.map(() => '?').join(', ');
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
}

/**
 * 部分列插入：只写给定的列，其余列取 DDL 的 DEFAULT。
 * 仅用于没有 C 列 / 没有默认值约束问题的索引表（entity_keys）。
 * 仍然拒绝未知列名——列名必须来自表定义。
 */
export function encodePartialRow(
  table: AtlasTableName,
  row: Record<string, unknown>,
): EncodeResult<Record<string, unknown>> {
  if (!isKnownTable(table)) {
    return { ok: false, issues: [{ code: 'CODEC_UNKNOWN_TABLE', path: String(table), message: `未知表名：${String(table)}` }] };
  }
  const allowed = new Set(tableColumnNames(table));
  const issues: CodecIssue[] = [];
  const columns: string[] = [];
  const values: SqlValue[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (!allowed.has(key)) {
      issues.push({ code: 'CODEC_UNKNOWN_COLUMN', path: `${table}.${key}`, message: `表 ${table} 没有列 ${key}` });
      continue;
    }
    const normalized = normalizeValue(table, key, value);
    if (!normalized.ok) {
      issues.push(normalized.issue);
      continue;
    }
    columns.push(key);
    values.push(normalized.value);
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true, columns, values, row };
}

/**
 * A29 decodeRow：按列转换 boolean / JSON / NULL；错误返回精确路径。
 * 额外的源行字段（未知列）报 CODEC_UNKNOWN_COLUMN。
 */
export function decodeRow<T = Record<string, unknown>>(
  table: AtlasTableName,
  row: Record<string, unknown>,
  options: { allowExtra?: boolean } = {},
): DecodeResult<T> {
  if (!isKnownTable(table)) {
    return { ok: false, issues: [{ code: 'CODEC_UNKNOWN_TABLE', path: String(table), message: `未知表名：${String(table)}` }] };
  }
  const spec = ATLAS_TABLE_COLUMNS[table];
  const issues: CodecIssue[] = [];
  const out: Record<string, unknown> = {};

  for (const column of spec) {
    const raw = Object.prototype.hasOwnProperty.call(row, column.name) ? row[column.name] : null;
    if (raw === null || raw === undefined) {
      out[column.name] = null;
      continue;
    }
    if (isBooleanColumn(column.name)) {
      if (raw === 1 || raw === 0) {
        out[column.name] = raw === 1;
      } else if (typeof raw === 'boolean') {
        out[column.name] = raw;
      } else {
        issues.push({ code: 'CODEC_BOOLEAN_INVALID', path: `${table}.${column.name}`, message: `布尔列 ${column.name} 的值不是 0/1：${String(raw)}` });
      }
      continue;
    }
    if (isJsonColumn(column.name)) {
      if (typeof raw !== 'string') {
        issues.push({ code: 'CODEC_JSON_TYPE', path: `${table}.${column.name}`, message: `JSON 列 ${column.name} 的 SQL 值必须是 TEXT` });
        continue;
      }
      try {
        out[column.name] = JSON.parse(raw);
      } catch (err) {
        issues.push({
          code: 'CODEC_JSON_INVALID',
          path: `${table}.${column.name}`,
          message: `JSON 列 ${column.name} 损坏：${(err as Error).message}`,
        });
      }
      continue;
    }
    if (typeof raw === 'number' && !Number.isFinite(raw)) {
      issues.push({ code: 'CODEC_NUMBER_NOT_FINITE', path: `${table}.${column.name}`, message: `列 ${column.name} 读到 NaN/Infinity` });
      continue;
    }
    out[column.name] = raw;
  }

  if (!options.allowExtra) {
    for (const key of Object.keys(row)) {
      if (!spec.some((c) => c.name === key)) {
        issues.push({ code: 'CODEC_UNKNOWN_COLUMN', path: `${table}.${key}`, message: `表 ${table} 没有列 ${key}` });
      }
    }
  }

  if (issues.length) return { ok: false, issues };
  return { ok: true, row: out as T };
}

/** camelCase ↔ snake_case 单点转换（DTO 层用）。 */
export function snakeToCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

export function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function decodeRowToCamel<T = Record<string, unknown>>(table: AtlasTableName, row: Record<string, unknown>): DecodeResult<T> {
  const decoded = decodeRow<Record<string, unknown>>(table, row);
  if (!decoded.ok) return decoded;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(decoded.row)) out[snakeToCamel(k)] = v;
  return { ok: true, row: out as T };
}
