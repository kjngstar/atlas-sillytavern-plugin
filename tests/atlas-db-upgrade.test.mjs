/**
 * M1-12：S01–S04 schema 升级验收。
 *
 * 纪律：
 * - schema1 档用**基线 DDL**（locations 的 CHECK 不含 floor）真实生成，
 *   不允许「新 schema + user_version=1」冒充旧结构。
 * - 只允许迁移副本临时关闭外键；普通业务测试的 FK 一律保持开启。
 * - 断言真实 exitCode 级行为：表值、主键集合、FK、索引/触发器、user_version。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ATLAS_SCHEMA_VERSION,
  ATLAS_TABLE_COLUMNS,
  USER_TABLE_COUNT,
  installSchema,
  locationsSql,
} from '../src/atlas-db-schema.ts';
import { UPGRADE_TEMP_TABLE, upgradeSchema1To2 } from '../src/atlas-db-upgrade.ts';
import { AtlasDbError, loadSqlModule } from '../src/atlas-db-runtime.ts';
import { makeSeedWith } from './fixtures/atlas-sql/seed.mjs';

const SCHEMA1_LOCATIONS_MARKER = "'building','floor','room'";

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function pragmaNumber(db, pragma) {
  const rows = db.exec(`PRAGMA ${pragma}`);
  return Number(rows?.[0]?.values?.[0]?.[0] ?? 0);
}

function userTableNames(db) {
  const rows = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  return (rows?.[0]?.values ?? []).map((row) => String(row[0]));
}

function locationsDdl(db) {
  const rows = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='locations'");
  return String(rows?.[0]?.values?.[0]?.[0] ?? '');
}

function rowCounts(db) {
  const out = {};
  for (const table of Object.keys(ATLAS_TABLE_COLUMNS)) {
    out[table] = Number(db.exec(`SELECT COUNT(*) FROM ${table}`)?.[0]?.values?.[0]?.[0] ?? -1);
  }
  return out;
}

function locationKeys(db) {
  const rows = db.exec('SELECT branch_id, id FROM locations ORDER BY branch_id, id');
  return (rows?.[0]?.values ?? []).map((row) => `${row[0]}\u0000${row[1]}`);
}

function attachedNames(db) {
  const rows = db.exec(
    "SELECT name FROM sqlite_master WHERE tbl_name='locations' AND type IN ('index','trigger') AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name",
  );
  return (rows?.[0]?.values ?? []).map((row) => String(row[0]));
}

/** schema1 的 locations DDL：只把 floor 从 CHECK 里去掉，其余（列、FK、约束）逐字保留。 */
function schema1LocationsSql() {
  const sql = locationsSql();
  assert.ok(sql.includes(SCHEMA1_LOCATIONS_MARKER), 'locations DDL 模板应含 floor 所在位置');
  return sql
    .replace('CREATE TABLE IF NOT EXISTS locations', 'CREATE TABLE _atlas_locations_schema1')
    .replace(SCHEMA1_LOCATIONS_MARKER, "'building','room'");
}

/** 用基线 DDL 把已 seed 的真实世界降级为 schema1 结构，并写 user_version=1。 */
async function makeSchema1Bytes(SQL) {
  const seed = await makeSeedWith(SQL);
  const db = seed.db;
  const attached = attachedNames(db);
  assert.ok(attached.length > 0, 'seed 库应带 locations 索引/触发器，才能验证重建');
  const before = locationKeys(db);
  assert.ok(before.length > 0, 'seed 库应有地点行，才能验证升级不改值');

  db.run('PRAGMA foreign_keys = OFF');
  db.run('BEGIN');
  db.run(schema1LocationsSql());
  db.run('INSERT INTO _atlas_locations_schema1 SELECT * FROM locations');
  db.run('DROP TABLE locations');
  db.run('ALTER TABLE _atlas_locations_schema1 RENAME TO locations');
  db.run('COMMIT');
  db.run('PRAGMA user_version = 1');
  db.run('PRAGMA foreign_keys = ON');

  assert.equal(pragmaNumber(db, 'user_version'), 1);
  assert.ok(!locationsDdl(db).includes("'floor'"), 'schema1 档的 CHECK 不得含 floor');
  const bytes = seed.exportBytes();
  seed.close();
  return bytes;
}

test('S01 新空库是 schema2，CHECK 接受 floor 并拒绝未知 kind', async () => {
  const SQL = await loadSqlModule();
  const db = new SQL.Database();
  db.run('PRAGMA foreign_keys = OFF');
  installSchema(db);
  assert.equal(pragmaNumber(db, 'user_version'), ATLAS_SCHEMA_VERSION);
  assert.equal(ATLAS_SCHEMA_VERSION, 2);
  assert.ok(locationsSql().includes("'floor'"), 'schema2 的 locations DDL 必须含 floor');

  const insert = (kind) => {
    const id = `loc_${kind}`;
    // entity_kind 触发器要求先有 entity_keys 行（kind=location），否则报 ENTITY_KEY_KIND_MISMATCH。
    db.run("INSERT INTO entity_keys (branch_id, id, kind) VALUES ('branch', ?, 'location')", [id]);
    db.run(
      `INSERT INTO locations (branch_id, id, row_rev, created_turn_id, updated_turn_id, name, kind)
       VALUES ('branch', ?, 1, 'turn', 'turn', '测试地点', ?)`,
      [id, kind],
    );
  };
  assert.doesNotThrow(() => insert('floor'), 'schema2 必须允许 kind=floor');
  assert.throws(() => insert('foobar'), /CHECK|constraint/i, '未知 kind 必须被 CHECK 拒绝');
  db.close();
});

test('S02 版本1完整升级：20 表值/主键集合不变、floor 可用、临时表不泄漏', async () => {
  const SQL = await loadSqlModule();
  const bytes = await makeSchema1Bytes(SQL);
  const originalSha = sha256(bytes);

  const db = new SQL.Database(bytes);
  const countsBefore = rowCounts(db);
  const keysBefore = locationKeys(db);
  const attachedBefore = attachedNames(db);
  assert.equal(pragmaNumber(db, 'user_version'), 1);

  const result = upgradeSchema1To2(db);
  assert.equal(result.changed, true);
  assert.equal(result.from, 1);
  assert.equal(result.to, 2);
  assert.deepEqual(result.issues, []);

  assert.equal(pragmaNumber(db, 'user_version'), 2, '升级成功后才写 user_version=2');
  assert.equal(pragmaNumber(db, 'foreign_keys'), 1, 'finally 必须把外键恢复为 1');
  assert.deepEqual(userTableNames(db).sort(), Object.keys(ATLAS_TABLE_COLUMNS).sort(), '仍是 20 张表');
  assert.equal(userTableNames(db).length, USER_TABLE_COUNT);
  assert.ok(!userTableNames(db).includes(UPGRADE_TEMP_TABLE), '临时表不得泄漏进结果');
  assert.deepEqual(rowCounts(db), countsBefore, '各表行数在升级中不得改变');
  assert.deepEqual(locationKeys(db), keysBefore, 'locations 主键集合不得改变');
  assert.deepEqual(attachedNames(db), attachedBefore, 'locations 索引/触发器必须按原 SQL 重建');
  assert.equal((db.exec('PRAGMA foreign_key_check')?.[0]?.values ?? []).length, 0, '升级后不得有 FK 违规');
  assert.equal(String(db.exec('PRAGMA integrity_check')?.[0]?.values?.[0]?.[0]), 'ok');
  assert.ok(locationsDdl(db).includes("'floor'"), '升级后 CHECK 必须含 floor');

  db.run('PRAGMA foreign_keys = OFF');
  assert.doesNotThrow(
    () =>
      db.run(
        `INSERT INTO locations (branch_id, id, row_rev, created_turn_id, updated_turn_id, name, kind)
         VALUES ('branch', 'loc_new_floor', 1, 'turn', 'turn', '新楼层', 'floor')`,
      ),
    '升级后必须能存 kind=floor',
  );

  assert.equal(sha256(bytes), originalSha, '升级只作用于副本，原 bytes 不得被改写');
  db.close();
});

test('S03 迁移失败：ROLLBACK、原档保持、无临时表泄漏、外键恢复', async () => {
  const SQL = await loadSqlModule();
  const bytes = await makeSchema1Bytes(SQL);
  const originalSha = sha256(bytes);

  const db = new SQL.Database(bytes);
  // 注入失败：把 locations 换成缺列的同名表（表数仍是 20，进入迁移后在复制阶段失败）。
  db.run('PRAGMA foreign_keys = OFF');
  db.run('BEGIN');
  db.run('CREATE TABLE _atlas_broken_locations (branch_id TEXT, id TEXT)');
  db.run('DROP TABLE locations');
  db.run('ALTER TABLE _atlas_broken_locations RENAME TO locations');
  db.run('COMMIT');
  const countsBroken = rowCounts(db);

  assert.throws(
    () => upgradeSchema1To2(db),
    (err) => err instanceof AtlasDbError && err.code === 'DB_UPGRADE_FAILED',
    '结构不匹配必须报 DB_UPGRADE_FAILED',
  );

  assert.equal(pragmaNumber(db, 'user_version'), 1, '失败不得写 user_version=2');
  assert.ok(!userTableNames(db).includes(UPGRADE_TEMP_TABLE), '失败后不得残留临时表');
  assert.equal(pragmaNumber(db, 'foreign_keys'), 1, 'finally 必须恢复外键为 1');
  assert.deepEqual(rowCounts(db), countsBroken, '失败后副本内部状态不应被部分改写');
  assert.equal(sha256(bytes), originalSha, '失败时原 bytes 必须保持原样');
  db.close();
});

test('S04 更高版本档：明确拒绝且不改结构', async () => {
  const SQL = await loadSqlModule();
  const bytes = await makeSchema1Bytes(SQL);
  const db = new SQL.Database(bytes);
  db.run('PRAGMA user_version = 3');

  assert.throws(
    () => upgradeSchema1To2(db),
    (err) => err instanceof AtlasDbError && err.code === 'DB_SCHEMA_UNSUPPORTED',
    'user_version=3 必须明确拒绝',
  );
  assert.equal(pragmaNumber(db, 'user_version'), 3, '拒绝时不得改写版本号');
  assert.ok(!locationsDdl(db).includes("'floor'"), '拒绝时不得改动表结构');
  assert.ok(!userTableNames(db).includes(UPGRADE_TEMP_TABLE), '拒绝时不得建临时表');
  db.close();
});
