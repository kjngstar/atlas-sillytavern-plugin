/**
 * atlas-db-runtime.ts — sql.js 单例加载、打开/校验、参数绑定执行（B01–B04）。
 *
 * 规则（§16.1 / §16.4）：
 * - 固定使用 sql.js 1.14.1（package-lock 固定）；不得从 CDN 临时载入另一版 wasm。
 * - 打开连接后、开启事务之前启用并**读回校验**外键。
 * - 全部写操作走参数绑定；SQL 模板来自代码白名单。
 * - 每个 Statement 用 try/finally 释放；只读查询返回普通对象数组。
 */

import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic, Statement } from 'sql.js';
import { ATLAS_SCHEMA_VERSION } from './atlas-db-schema.ts';
import { sqlVendorLocator } from './atlas-db-assets.ts';
import type { SqlValue } from './atlas-db-contract.ts';

export type SqljsLocator = (file: string) => string;

export type SqlModule = SqlJsStatic;
export type SqlDatabase = Database;

let modulePromise: Promise<SqlModule> | null = null;

/** 已经在宿主里初始化过的模块实例（插件打包时由宿主注入，避免重复载入 wasm）。 */
let injectedModule: SqlModule | null = null;

export function injectSqlModule(mod: SqlModule): void {
  injectedModule = mod;
  modulePromise = Promise.resolve(mod);
}

export function resetSqlModuleForTests(): void {
  modulePromise = null;
  injectedModule = null;
}

export class AtlasDbError extends Error {
  code: string;
  detail: Record<string, unknown>;
  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AtlasDbError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * B01：单例异步加载固定 sql.js。wasm/asm 定位由调用者注入（离线本地资源）。
 * 失败一律报 DB_WASM_LOAD_FAILED，并带上实际相对资源路径。
 */
export async function loadSqlModule(locateFile?: SqljsLocator): Promise<SqlModule> {
  if (injectedModule) return injectedModule;
  if (!modulePromise) {
    modulePromise = (async () => {
      try {
        // Node 源码运行继续使用 sql.js 包内定位；发布浏览器与 Worker 必须走本地 vendor。
        const isNode = Boolean((globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node);
        const locator = locateFile ?? (isNode ? undefined : sqlVendorLocator());
        const config = locator ? { locateFile: locator } : {};
        return await initSqlJs(config);
      } catch (err) {
        throw new AtlasDbError('DB_WASM_LOAD_FAILED', `sql.js 加载失败：${(err as Error).message}`, {
          locateFile: locateFile ? String(locateFile('sql-wasm.wasm')) : null,
        });
      }
    })();
    modulePromise.catch(() => {
      modulePromise = null;
    });
  }
  return modulePromise;
}

function readPragmaNumber(db: SqlDatabase, pragma: string): number {
  const results = db.exec(`PRAGMA ${pragma}`);
  const value = results?.[0]?.values?.[0]?.[0];
  return typeof value === 'number' ? value : Number(value ?? 0);
}

/** §2.1：打开每一个数据库连接后、开启事务之前，启用并验证外键。 */
export function enableForeignKeys(db: SqlDatabase): void {
  db.run('PRAGMA foreign_keys = ON');
  const enabled = readPragmaNumber(db, 'foreign_keys');
  if (enabled !== 1) {
    throw new AtlasDbError('DB_FOREIGN_KEYS_OFF', '无法启用 SQLite 外键（foreign_keys 读回不是 1）', { enabled });
  }
}

/**
 * B02：创建/导入数据库，启用 FK 并读回校验，检查 schema 版本。
 * 不支持的新版存档只读报错，**不能清空新建**。
 */
export async function openDatabase(bytes?: Uint8Array, options: { sqlModule?: SqlModule } = {}): Promise<SqlDatabase> {
  const mod = options.sqlModule ?? (await loadSqlModule());
  let db: SqlDatabase;
  if (bytes && bytes.length > 0) {
    try {
      db = new mod.Database(bytes);
    } catch (err) {
      throw new AtlasDbError('DB_IMPORT_FAILED', `导入存档失败：${(err as Error).message}`, { byteLength: bytes.length });
    }
  } else {
    db = new mod.Database();
  }
  enableForeignKeys(db);

  if (bytes && bytes.length > 0) {
    const userVersion = readPragmaNumber(db, 'user_version');
    if (userVersion > ATLAS_SCHEMA_VERSION) {
      throw new AtlasDbError(
        'DB_SCHEMA_UNSUPPORTED',
        `存档 schema_version=${userVersion} 高于本实现支持的 ${ATLAS_SCHEMA_VERSION}；拒绝写库。`,
        { userVersion, supported: ATLAS_SCHEMA_VERSION },
      );
    }
  }
  return db;
}

/** 打开前先探测：返回存档里的 schema_version，不修改数据。 */
export async function probeSchemaVersion(bytes: Uint8Array, options: { sqlModule?: SqlModule } = {}): Promise<number> {
  const mod = options.sqlModule ?? (await loadSqlModule());
  const db = new mod.Database(bytes);
  try {
    return readPragmaNumber(db, 'user_version');
  } finally {
    db.close();
  }
}

/**
 * 归一绑定参数：undefined → null。
 * 只接受 sql.js 允许的类型；其它类型明确报 CODEC_TYPE_INVALID，不静默转字符串。
 */
export function normalizeParams(params: readonly unknown[]): Array<string | number | Uint8Array | null> {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'string' || typeof p === 'number') return p;
    if (p instanceof Uint8Array) return p;
    if (typeof p === 'boolean') return p ? 1 : 0;
    throw new AtlasDbError('CODEC_TYPE_INVALID', `绑定参数类型不受支持：${typeof p}`, {});
  });
}

function bindParams(stmt: Statement, params: readonly unknown[]): void {
  if (params.length === 0) return;
  stmt.bind(normalizeParams(params));
}

/**
 * B03：参数化执行写语句。SQL 必须来自代码白名单模板。
 * 返回受影响信息由调用方按需读取（sql.js 不返回 changes 计数，统一用查询核对）。
 */
export function runBound(db: SqlDatabase, sql: string, params: SqlValue[] = []): void {
  let stmt: Statement | null = null;
  try {
    stmt = db.prepare(sql);
    bindParams(stmt, params);
    while (stmt.step()) {
      // 写语句正常不返回行；吞掉也只是驱动执行。
    }
  } catch (err) {
    throw new AtlasDbError('SQL_CONSTRAINT', `SQL 执行失败：${(err as Error).message}`, {
      sqlTemplate: firstLine(sql),
      paramCount: params.length,
    });
  } finally {
    stmt?.free();
  }
}

/** 在同一连接上执行多条语句（仅用于 DDL / PRAGMA 白名单）。 */
export function runBatch(db: SqlDatabase, statements: string[]): void {
  for (const sql of statements) {
    try {
      db.run(sql);
    } catch (err) {
      throw new AtlasDbError('SQL_CONSTRAINT', `DDL 执行失败：${(err as Error).message}`, { sqlTemplate: firstLine(sql) });
    }
  }
}

/** B04：只读查询返回普通对象数组并释放 Statement。空结果 = []，绝不沿用上次结果。 */
export function queryBound(db: SqlDatabase, sql: string, params: SqlValue[] = []): Array<Record<string, SqlValue>> {
  let stmt: Statement | null = null;
  const rows: Array<Record<string, SqlValue>> = [];
  try {
    stmt = db.prepare(sql);
    bindParams(stmt, params);
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as Record<string, SqlValue>);
    }
  } catch (err) {
    throw new AtlasDbError('SQL_QUERY_FAILED', `SQL 查询失败：${(err as Error).message}`, {
      sqlTemplate: firstLine(sql),
      paramCount: params.length,
    });
  } finally {
    stmt?.free();
  }
  return rows;
}

export function queryOne(db: SqlDatabase, sql: string, params: SqlValue[] = []): Record<string, SqlValue> | null {
  const rows = queryBound(db, sql, params);
  return rows.length > 0 ? rows[0] : null;
}

export function countRows(db: SqlDatabase, table: string, where = '', params: SqlValue[] = []): number {
  const sql = where ? `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}` : `SELECT COUNT(*) AS n FROM ${table}`;
  const row = queryOne(db, sql, params);
  return Number(row?.n ?? 0);
}

/** §7.3：最终 COMMIT 前再次执行外键检查（不能以 RELEASE 代替）。 */
export type ForeignKeyViolation = { table: string; rowid: number | null; parent: string; fkid: number };

export function foreignKeyCheck(db: SqlDatabase, table?: string): ForeignKeyViolation[] {
  const sql = table ? `PRAGMA foreign_key_check(${table})` : 'PRAGMA foreign_key_check';
  const rows = queryBound(db, sql);
  return rows.map((r) => ({
    table: String(r.table ?? ''),
    rowid: r.rowid === null || r.rowid === undefined ? null : Number(r.rowid),
    parent: String(r.parent ?? ''),
    fkid: Number(r.fkid ?? 0),
  }));
}

export function userTableNames(db: SqlDatabase): string[] {
  const rows = queryBound(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  return rows.map((r) => String(r.name));
}

export function beginTransaction(db: SqlDatabase): void {
  db.run('BEGIN');
}

export function commitTransaction(db: SqlDatabase): void {
  db.run('COMMIT');
}

export function rollbackTransaction(db: SqlDatabase): void {
  try {
    db.run('ROLLBACK');
  } catch {
    // 已经回滚/没有活动事务：此处不掩盖真实错误，调用方按业务判断。
  }
}

export function savepoint(db: SqlDatabase, name: string): void {
  assertSafeIdentifier(name);
  db.run(`SAVEPOINT ${name}`);
}

export function releaseSavepoint(db: SqlDatabase, name: string): void {
  assertSafeIdentifier(name);
  db.run(`RELEASE SAVEPOINT ${name}`);
}

export function rollbackToSavepoint(db: SqlDatabase, name: string): void {
  assertSafeIdentifier(name);
  db.run(`ROLLBACK TO SAVEPOINT ${name}`);
}

/** §16.5：组名/表名来自程序常量与安全内部 ID，不拼模型原文。 */
export function assertSafeIdentifier(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new AtlasDbError('SQL_UNSAFE_IDENTIFIER', `非法 SQL 标识符：${name}`, { name });
  }
}

function firstLine(sql: string): string {
  return sql.split('\n')[0].trim().slice(0, 120);
}
