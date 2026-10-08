/**
 * atlas-db-upgrade.ts — schema 1 → 2 的独立副本升级（locations.kind 加入 floor）。
 *
 * 依据 02 文档 §2「floor 枚举的可靠升级」，严格按十步执行：
 * 1. 版本判断（2 直接返回，>2 只读错误，1 才升级）
 * 2. 由调用方在**独立副本**上打开（本文件不读取、不修改原信封）
 * 3. BEGIN 前 foreign_keys=OFF 并读回 0（仅迁移副本允许）
 * 4. 事务内保存挂在 locations 上的索引/触发器 SQL（排除自动索引）
 * 5. 以新 locationsSql() 为模板建固定临时表
 * 6. 固定列清单复制并核对数量与 (branch_id,id) 集合
 * 7. DROP 原表 → RENAME 临时表 → 重建索引/触发器（其他 19 表不动）
 * 8. foreign_key_check / integrity_check / 20 表 / 行数 / 主键集合全部通过后才写 user_version 并 COMMIT
 * 9. finally 恢复 foreign_keys=ON 并读回 1；任何失败 ROLLBACK，临时表不泄漏
 * 10. 不推进 clock_s/revision，不产生故事事件（由调用方与宿主 ACK 负责保存时机）
 *
 * 本文件不做旧三表导入（那是 atlas-db-migrate.ts 的职责），也不碰原信封。
 */

import {
  ATLAS_SCHEMA_VERSION,
  ATLAS_TABLE_COLUMNS,
  USER_TABLE_COUNT,
  locationsSql,
} from './atlas-db-schema.ts';
import { AtlasDbError, type SqlDatabase } from './atlas-db-runtime.ts';

/** 固定迁移临时表名；不接受任何外部标识符。 */
export const UPGRADE_TEMP_TABLE = '_atlas_locations_upgrade_2';

/** 升级结果；changed=false 表示本来已是目标版本。 */
export type UpgradeResult = {
  changed: boolean;
  from: number;
  to: number;
  issues: string[];
};

type AttachedObject = { type: string; name: string; sql: string };

function pragmaNumber(db: SqlDatabase, pragma: string): number {
  const result = db.exec(`PRAGMA ${pragma}`);
  const value = result?.[0]?.values?.[0]?.[0];
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function scalar(db: SqlDatabase, sql: string): unknown {
  const result = db.exec(sql);
  const rows = result?.[0]?.values ?? [];
  return rows.length > 0 ? rows[0][0] : null;
}

function tableNames(db: SqlDatabase): string[] {
  const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  return (result?.[0]?.values ?? []).map((row) => String(row[0]));
}

function columnNames(db: SqlDatabase, table: string): string[] {
  const result = db.exec(`PRAGMA table_info(${table})`);
  return (result?.[0]?.values ?? []).map((row) => String(row[1]));
}

/** 读取 (branch_id,id) 集合，用于升级前后的主键集合比对。 */
function readKeyPairs(db: SqlDatabase, table: string): Set<string> {
  const result = db.exec(`SELECT branch_id, id FROM ${table}`);
  const out = new Set<string>();
  for (const row of result?.[0]?.values ?? []) out.add(`${String(row[0])}\u0000${String(row[1])}`);
  return out;
}

function rowCounts(db: SqlDatabase): Map<string, number> {
  const out = new Map<string, number>();
  for (const table of Object.keys(ATLAS_TABLE_COLUMNS)) {
    out.set(table, Number(scalar(db, `SELECT COUNT(*) FROM ${table}`) ?? 0));
  }
  return out;
}

/** 第 5 步：把新 DDL 的固定建表名替换为迁移临时表名，保留全部 FK 名称。 */
export function upgradeTemporaryTableSql(): string {
  const ddl = locationsSql();
  const marker = 'CREATE TABLE IF NOT EXISTS locations';
  if (!ddl.startsWith(marker)) {
    throw new AtlasDbError('DB_UPGRADE_FAILED', 'locations DDL 模板与预期不符，拒绝迁移。', {});
  }
  return `CREATE TABLE ${UPGRADE_TEMP_TABLE}${ddl.slice(marker.length)}`;
}

/**
 * 在**独立副本**上执行 schema1 → schema2 升级。
 * 失败时抛 AtlasDbError(DB_UPGRADE_FAILED)，调用方必须丢弃该副本、保留原 bytes。
 */
export function upgradeSchema1To2(db: SqlDatabase): UpgradeResult {
  const from = pragmaNumber(db, 'user_version');
  const to = ATLAS_SCHEMA_VERSION;

  if (from === to) return { changed: false, from, to, issues: [] };
  if (from > to) {
    throw new AtlasDbError('DB_SCHEMA_UNSUPPORTED', `副本 schema_version=${from} 高于本实现支持的 ${to}。`, {
      from,
      supported: to,
    });
  }
  if (from !== 1) {
    throw new AtlasDbError('DB_UPGRADE_FAILED', `副本 schema_version=${from} 不是可升级的版本 1。`, { from });
  }

  const tablesBefore = tableNames(db).sort();
  if (tablesBefore.length !== USER_TABLE_COUNT) {
    throw new AtlasDbError('DB_UPGRADE_FAILED', `副本不是预期的 ${USER_TABLE_COUNT} 张表，实际 ${tablesBefore.length}。`, {
      tables: tablesBefore.length,
    });
  }

  const fixedColumns = ATLAS_TABLE_COLUMNS.locations.map((spec) => spec.name);
  const issues: string[] = [];

  // 第 3 步：迁移副本临时关闭外键，并读回确认。
  db.run('PRAGMA foreign_keys = OFF');
  const fkAfterOff = pragmaNumber(db, 'foreign_keys');
  if (fkAfterOff !== 0) {
    throw new AtlasDbError('DB_UPGRADE_FAILED', 'foreign_keys 未能关闭为 0，拒绝在开启外键时迁移。', { fkAfterOff });
  }

  const countsBefore = rowCounts(db);
  const keysBefore = readKeyPairs(db, 'locations');
  const columnNamesBefore = columnNames(db, 'locations');

  try {
    // 第 4 步：保存挂在 locations 上的索引/触发器（排除 sqlite_autoindex）。必须在事务内读取。
    db.run('BEGIN');
    const attachedResult = db.exec(
      "SELECT type, name, sql FROM sqlite_master WHERE tbl_name='locations' AND type IN ('index','trigger') AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY type, name",
    );
    const attached: AttachedObject[] = (attachedResult?.[0]?.values ?? []).map((row) => ({
      type: String(row[0]),
      name: String(row[1]),
      sql: String(row[2]),
    }));

    // 第 5 步：固定模板建临时表。
    db.run(upgradeTemporaryTableSql());

    // 第 6 步：固定列复制，并核对列清单、数量与主键集合。
    // 注意：ATLAS_TABLE_COLUMNS 是 codec 的**逻辑列序**，与 DDL 物理列序不同，
    // 因此这里只校验「列集合」与「固定列都存在」，不要求顺序相同。
    const missingFixed = fixedColumns.filter((name) => !columnNamesBefore.includes(name));
    if (missingFixed.length > 0) {
      throw new AtlasDbError('DB_UPGRADE_FAILED', '固定列清单含原 locations 表没有的列。', { missing: missingFixed });
    }
    const columnList = fixedColumns.join(', ');
    db.run(`INSERT INTO ${UPGRADE_TEMP_TABLE} (${columnList}) SELECT ${columnList} FROM locations`);

    const tempColumns = columnNames(db, UPGRADE_TEMP_TABLE);
    if (
      tempColumns.length !== columnNamesBefore.length ||
      tempColumns.some((name) => !columnNamesBefore.includes(name))
    ) {
      throw new AtlasDbError('DB_UPGRADE_FAILED', '临时表列与原 locations 列集合不一致。', {
        expected: columnNamesBefore.length,
        actual: tempColumns.length,
      });
    }
    const copiedCount = Number(scalar(db, `SELECT COUNT(*) FROM ${UPGRADE_TEMP_TABLE}`) ?? -1);
    if (copiedCount !== countsBefore.get('locations')) {
      throw new AtlasDbError('DB_UPGRADE_FAILED', `locations 复制行数不符：${copiedCount} ≠ ${countsBefore.get('locations')}。`, {});
    }
    const tempKeys = readKeyPairs(db, UPGRADE_TEMP_TABLE);
    if (tempKeys.size !== keysBefore.size || [...keysBefore].some((key) => !tempKeys.has(key))) {
      throw new AtlasDbError('DB_UPGRADE_FAILED', 'locations 复制后 (branch_id,id) 集合与升级前不一致。', {});
    }
    if (columnNamesBefore.length !== fixedColumns.length) {
      // 逻辑列清单与物理列数不同是正常的（列序不同），但两者列集合必须一致：
      // 上面已校验 fixedColumns 全部存在于原表，且临时表列集合等于原表列集合。
      issues.push(`LOCATIONS_COLUMN_ORDER_DIFFERS:physical=${columnNamesBefore.length},logical=${fixedColumns.length}`);
    }

    // 第 7 步：换表并重建索引/触发器；其他 19 表不重建。
    db.run('DROP TABLE locations');
    db.run(`ALTER TABLE ${UPGRADE_TEMP_TABLE} RENAME TO locations`);
    for (const item of attached) db.run(item.sql);

    // 第 8 步：全部校验通过后才写 user_version。
    const foreignKeyIssues = db.exec('PRAGMA foreign_key_check');
    if ((foreignKeyIssues?.[0]?.values ?? []).length > 0) {
      throw new AtlasDbError('DB_UPGRADE_FAILED', '升级后 foreign_key_check 报告违规。', {
        violations: (foreignKeyIssues[0].values ?? []).length,
      });
    }
    const integrity = String(scalar(db, 'PRAGMA integrity_check') ?? '');
    if (integrity !== 'ok') {
      throw new AtlasDbError('DB_UPGRADE_FAILED', `升级后 integrity_check 不是 ok：${integrity}。`, { integrity });
    }
    const tablesAfter = tableNames(db).sort();
    if (tablesAfter.length !== USER_TABLE_COUNT || tablesAfter.some((name, i) => name !== tablesBefore[i])) {
      throw new AtlasDbError('DB_UPGRADE_FAILED', '升级后表清单发生变化。', { before: tablesBefore.length, after: tablesAfter.length });
    }
    const finalColumns = columnNames(db, 'locations');
    if (
      finalColumns.length !== columnNamesBefore.length ||
      finalColumns.some((name) => !columnNamesBefore.includes(name))
    ) {
      throw new AtlasDbError('DB_UPGRADE_FAILED', '升级后 locations 列集合与升级前不一致。', {});
    }
    const countsAfter = rowCounts(db);
    for (const [table, before] of countsBefore) {
      const after = countsAfter.get(table) ?? -1;
      if (after !== before) {
        throw new AtlasDbError('DB_UPGRADE_FAILED', `表 ${table} 行数在升级中被改变：${before} → ${after}。`, { table });
      }
    }
    const keysAfter = readKeyPairs(db, 'locations');
    if (keysAfter.size !== keysBefore.size || [...keysBefore].some((key) => !keysAfter.has(key))) {
      throw new AtlasDbError('DB_UPGRADE_FAILED', '升级后 locations 主键集合与升级前不一致。', {});
    }
    if (tableNames(db).includes(UPGRADE_TEMP_TABLE)) {
      throw new AtlasDbError('DB_UPGRADE_FAILED', '迁移临时表泄漏进结果文件。', {});
    }

    db.run(`PRAGMA user_version = ${to}`);
    db.run('COMMIT');
  } catch (err) {
    try {
      db.run('ROLLBACK');
    } catch {
      /* ROLLBACK 失败时保留原始错误上抛，由调用方丢弃副本。 */
    }
    throw err instanceof AtlasDbError
      ? err
      : new AtlasDbError('DB_UPGRADE_FAILED', `schema 升级失败：${(err as Error).message}`, { from });
  } finally {
    // 第 9 步：无论成败都恢复外键，并读回确认。
    db.run('PRAGMA foreign_keys = ON');
    if (pragmaNumber(db, 'foreign_keys') !== 1) issues.push('FOREIGN_KEYS_RESTORE_FAILED');
  }

  return { changed: true, from, to, issues };
}
