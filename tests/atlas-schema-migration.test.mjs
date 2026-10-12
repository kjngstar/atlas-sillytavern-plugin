/**
 * atlas-schema-migration.test.mjs — P09A / schema 2→3（独立建设进度表）验收 MIG01–MIG07。
 *
 * 被替代的旧方案是把完整目标队列塞进 `maps.frame_json.atlasConstructionProgress`：
 * 地图 frame 已与场景共用容量，UI 的 publicMapFrame 又靠删键过滤，内部命名空间迟早漏出。
 * 现在进度是**独立内部表** `construction_progress`（kind: scope/target/source/chunk/unit，
 * status: pending/processed/retry/suspended），schema 版本 2 → 3。
 *
 * 覆盖：
 * - MIG01 schema1 与 schema2 各一份**真实**旧库可升级；旧 ID/head/clock/scene/journal 不变；
 * - MIG02 建表 / 索引 / 校验 / 宿主保存四个位置注入失败：原库 bytes 与信封不变；
 * - MIG03 新表 mutation 进 journal，回退恢复 before；重复确认不重复写；
 * - MIG04 fork 后父子进度独立，source/chunk ID 与 target 实体身份可用，原分支不被修改；
 * - MIG05 完整备份恢复新进度；地图分析 / POV 导出没有内部进度表内容；
 * - MIG06 旧 schema 校验不因期待 21 表先报坏库；未来 schema 不降级；
 * - MIG07 只新增进度/调度记录时实体新增数为 0、clock_s 不变、业务计数不虚增；stale guard 仍生效。
 *
 * 纪律：旧档必须是**真旧结构**（20 张表），不允许「新 schema + 旧版本号」冒充。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import initSqlJs from 'sql.js';

import { makeSeedWith, IDS, countRows, insertRows, userTables } from './fixtures/atlas-sql/seed.mjs';
import { createRow } from '../src/atlas-db-defaults.ts';
import {
  ATLAS_SCHEMA_VERSION,
  ATLAS_TABLE_COLUMNS,
  USER_TABLE_COUNT,
  currentSchemaVersion,
  expectedTableCount,
  installSchema,
  installSchemaSafe,
  locationsSql,
} from '../src/atlas-db-schema.ts';
import {
  SCHEMA_2_TO_3_TARGET,
  upgradeSchema,
  upgradeSchema1To2,
  upgradeSchema2To3,
} from '../src/atlas-db-upgrade.ts';
import { decodeSnapshot, encodeSnapshot, sha256Hex } from '../src/atlas-db-envelope.ts';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { forkBranch, FORK_COPY_TABLES } from '../src/atlas-db-branches.ts';
import { planRollback, applyRollbackPlan } from '../src/atlas-db-rollback.ts';
import { applyGroups } from '../src/atlas-db-commit.ts';
import { toLegacyTurnReceipt } from '../src/atlas-db-state-adapter.ts';
import { groupChangesBusiness, isBusinessMutationTable } from '../src/atlas-ops-contract.ts';
import { AtlasDbError, queryBound } from '../src/atlas-db-runtime.ts';
import { createBrowserSqlHost } from '../src/atlas-browser-sql-host.ts';
import { createTableReadPort } from '../src/atlas-db-readport.ts';
import { collectKnownRefs } from '../src/atlas-sql-refs.ts';
import { loadAtlasSqlRuntime } from '../src/atlas-sql-session.ts';
import { handleSqlMapAction } from '../src/atlas-sql-map-actions.ts';
import { projectReferenceData } from '../ui/atlas-reference-data.mjs';
import { buildMapAnalysisExport } from '../ui/atlas-map-export.mjs';

const SQL = await initSqlJs();
const BRANCH = IDS.branchMain;
const TURN = IDS.seedTurn;
const WALL = 1_700_000_000_000;
const PROGRESS = 'construction_progress';
const PICK_INDEX = 'idx_construction_progress_pick';

const sha = (value) => createHash('sha256').update(String(value)).digest('hex');
const ctx = (id, over = {}) => ({ branchId: BRANCH, id, turnId: TURN, clockS: 0, nowWallMs: WALL, rulesetVersion: 'atlas-1', ...over });

function pragmaNumber(db, name) {
  const rows = db.exec(`PRAGMA ${name}`);
  return Number(rows?.[0]?.values?.[0]?.[0] ?? 0);
}

function tableNames(db) {
  const rows = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  return (rows?.[0]?.values ?? []).map((row) => String(row[0]));
}

function currentVersionOf(db) {
  return currentSchemaVersion(db);
}

function locationsDdl(db) {
  const rows = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='locations'");
  return String(rows?.[0]?.values?.[0]?.[0] ?? '');
}

/** 旧档在升级中**绝不能变**的四个面：身份/指针/时钟、地图画面、上下文（= 地点行）、变更日志。 */
function preservedSnapshot(db) {
  const branches = queryBound(
    db,
    'SELECT id, head_turn_id, clock_s, clock_min_s, clock_max_s, simulation_cursor_s, revision, pov_character_id FROM branches ORDER BY id',
    [],
  );
  const scenes = queryBound(db, 'SELECT id, frame_json, meters_per_cell FROM maps ORDER BY id', [])
    .map((row) => `${String(row.id)}:${sha(row.frame_json)}:${String(row.meters_per_cell)}`);
  const places = queryBound(db, 'SELECT branch_id, id, parent_location_id FROM locations ORDER BY branch_id, id', [])
    .map((row) => `${String(row.branch_id)}\u0000${String(row.id)}\u0000${String(row.parent_location_id)}`);
  const journal = queryBound(
    db,
    'SELECT id, turn_id, sequence, target_table, target_row_id, operation, before_json, after_json FROM turn_changes ORDER BY id',
    [],
  ).map((row) => JSON.stringify(row));
  return { branches, scenes, places, journal };
}

async function withSeed(fn) {
  const seed = await makeSeedWith(SQL);
  try {
    return await fn(seed);
  } finally {
    seed.close();
  }
}

/** 把 seed（当前 schema）降级为**真 schema2**：去掉 schema3 独有的表与索引，写 user_version=2。 */
function dropToSchema2(db) {
  assert.ok(tableNames(db).includes(PROGRESS), '前置：seed 是当前 schema，含 construction_progress');
  db.run('PRAGMA foreign_keys = OFF');
  db.run('BEGIN');
  db.run(`DROP INDEX IF EXISTS ${PICK_INDEX}`);
  db.run(`DROP TABLE IF EXISTS ${PROGRESS}`);
  db.run('COMMIT');
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA user_version = 2');
  assert.equal(pragmaNumber(db, 'user_version'), 2);
  assert.equal(tableNames(db).length, expectedTableCount(2), '真 schema2 恰 20 张表');
  assert.ok(!tableNames(db).includes(PROGRESS));
}

/** 再把**真 schema2** 降级为 schema1：locations 的 CHECK 去掉 floor，其余逐字保留。 */
function dropToSchema1(db) {
  const marker = "'building','floor','room'";
  const ddl = locationsSql();
  assert.ok(ddl.includes(marker), 'locations DDL 模板应含 floor 所在位置');
  db.run('PRAGMA foreign_keys = OFF');
  db.run('BEGIN');
  db.run(
    ddl
      .replace('CREATE TABLE IF NOT EXISTS locations', 'CREATE TABLE _atlas_locations_schema1')
      .replace(marker, "'building','room'"),
  );
  db.run('INSERT INTO _atlas_locations_schema1 SELECT * FROM locations');
  db.run('DROP TABLE locations');
  db.run('ALTER TABLE _atlas_locations_schema1 RENAME TO locations');
  db.run('COMMIT');
  db.run('PRAGMA user_version = 1');
  db.run('PRAGMA foreign_keys = ON');
  assert.equal(pragmaNumber(db, 'user_version'), 1);
  assert.ok(!locationsDdl(db).includes("'floor'"), 'schema1 档不得含 floor');
}

function exportBytes(db) {
  return db.export();
}

/* ------------------------------------------------------------------ *
 * MIG01：真旧库可升级，旧 ID/head/clock/scene/journal 一个字节不变
 * ------------------------------------------------------------------ */

test('MIG01 schema1 与 schema2 各一份真实旧库都能升到 3；旧指针/时钟/画面/日志逐项不变', async () => {
  assert.equal(ATLAS_SCHEMA_VERSION, 3);
  assert.equal(SCHEMA_2_TO_3_TARGET, 3);
  assert.equal(USER_TABLE_COUNT, 21);

  // —— schema2 档 ——
  await withSeed((seed) => {
    dropToSchema2(seed.db);
    const before = preservedSnapshot(seed.db);
    const result = upgradeSchema(seed.db);
    assert.equal(result.from, 2);
    assert.equal(result.to, 3);
    assert.equal(result.changed, true);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(preservedSnapshot(seed.db), before, 'schema2→3 不得改动旧 ID/head/clock/scene/journal');
    assert.equal(pragmaNumber(seed.db, 'user_version'), 3);
    assert.deepEqual(tableNames(seed.db).sort(), Object.keys(ATLAS_TABLE_COLUMNS).sort(), '升级后恰 21 张表');
    assert.equal(countRows(seed.db, PROGRESS, BRANCH), 0, '新增进度表初始为空');
    assert.deepEqual(queryBound(seed.db, 'PRAGMA foreign_key_check', []), []);
    assert.equal(String(queryBound(seed.db, 'PRAGMA integrity_check', [])[0]?.integrity_check ?? ''), 'ok');
  });

  // —— schema1 档：必须走 1→2→3 两段，而不是一次写 3 ——
  await withSeed((seed) => {
    dropToSchema2(seed.db);
    dropToSchema1(seed.db);
    const before = preservedSnapshot(seed.db);
    const result = upgradeSchema(seed.db);
    assert.equal(result.from, 1);
    assert.equal(result.to, 3);
    assert.equal(result.changed, true);
    assert.deepEqual(preservedSnapshot(seed.db), before, 'schema1→3 不得改动旧 ID/head/clock/scene/journal');
    assert.ok(locationsDdl(seed.db).includes("'floor'"), '1→2 段必须换上含 floor 的 locations DDL');
    assert.equal(tableNames(seed.db).length, 21);
    assert.equal(countRows(seed.db, PROGRESS, BRANCH), 0);
    assert.deepEqual(queryBound(seed.db, 'PRAGMA foreign_key_check', []), []);
  });

  // —— 分段函数本身的边界：1→2 停在 2，2→3 停在 3，重复调用不重复迁移 ——
  await withSeed((seed) => {
    dropToSchema2(seed.db);
    dropToSchema1(seed.db);
    const step = upgradeSchema1To2(seed.db);
    assert.equal(step.to, 2);
    assert.equal(currentVersionOf(seed.db), 2);
    assert.ok(!tableNames(seed.db).includes(PROGRESS), '1→2 段不得越级建 schema3 的表');
    const step2 = upgradeSchema2To3(seed.db);
    assert.equal(step2.to, 3);
    assert.equal(step2.changed, true);
    const again = upgradeSchema2To3(seed.db);
    assert.equal(again.changed, false, '已是目标版本：幂等，不重复迁移');
    const againAll = upgradeSchema(seed.db);
    assert.equal(againAll.changed, false);
    assert.equal(currentVersionOf(seed.db), 3);
  });
});

/* ------------------------------------------------------------------ *
 * MIG02：四个位置注入失败，原库 bytes / 信封不变
 * ------------------------------------------------------------------ */

test('MIG02a 建表位置失败：预存同名表（半升级）→ 明确拒绝，副本不改', async () => {
  await withSeed((seed) => {
    dropToSchema2(seed.db);
    // 预存一张同名但结构不符的表：这是「半升级状态」，不是可以 CREATE IF NOT EXISTS 盖过去的。
    seed.db.run('CREATE TABLE construction_progress (branch_id TEXT, id TEXT)');
    const before = preservedSnapshot(seed.db);
    const tablesBefore = tableNames(seed.db);
    assert.throws(
      () => upgradeSchema(seed.db),
      (err) => err instanceof AtlasDbError && err.code === 'DB_UPGRADE_FAILED',
    );
    assert.equal(pragmaNumber(seed.db, 'user_version'), 2, '失败不得写 user_version=3');
    assert.deepEqual(tableNames(seed.db), tablesBefore, '失败不得留下新表/临时表');
    assert.deepEqual(preservedSnapshot(seed.db), before, '失败不得改动旧表数据');
    assert.equal(pragmaNumber(seed.db, 'foreign_keys'), 1, '失败也必须把外键恢复为 1');
  });
});

test('MIG02b 索引位置失败：同名索引已被占用 → CREATE IF NOT EXISTS 静默跳过必须被判失败', async () => {
  await withSeed((seed) => {
    dropToSchema2(seed.db);
    // 占住迁移要建的索引名：CREATE INDEX IF NOT EXISTS 会静默跳过。
    seed.db.run(`CREATE INDEX ${PICK_INDEX} ON branches(id)`);
    const before = preservedSnapshot(seed.db);
    const tablesBefore = tableNames(seed.db);
    assert.throws(
      () => upgradeSchema(seed.db),
      (err) => err instanceof AtlasDbError && err.code === 'DB_UPGRADE_FAILED',
      '静默跳过索引必须报错，不能把半升级当成功',
    );
    assert.equal(pragmaNumber(seed.db, 'user_version'), 2);
    assert.deepEqual(tableNames(seed.db), tablesBefore, '拒绝后不得残留新建的表');
    assert.deepEqual(preservedSnapshot(seed.db), before);
    assert.equal(pragmaNumber(seed.db, 'foreign_keys'), 1);
  });
});

test('MIG02c 校验位置失败：1→2 复制阶段结构不符 → 原 bytes 逐字节不变、无临时表', async () => {
  await withSeed(async (seed) => {
    dropToSchema2(seed.db);
    dropToSchema1(seed.db);
    // 注入：把 locations 换成缺列的同名表（表数仍是 20，进入迁移后在复制阶段失败）。
    seed.db.run('PRAGMA foreign_keys = OFF');
    seed.db.run('BEGIN');
    seed.db.run('CREATE TABLE _atlas_broken_locations (branch_id TEXT, id TEXT)');
    seed.db.run('DROP TABLE locations');
    seed.db.run('ALTER TABLE _atlas_broken_locations RENAME TO locations');
    seed.db.run('COMMIT');
    seed.db.run('PRAGMA foreign_keys = ON');

    const bytes = exportBytes(seed.db);
    const bytesSha = await sha256Hex(bytes);
    assert.throws(
      () => upgradeSchema(seed.db),
      (err) => err instanceof AtlasDbError && err.code === 'DB_UPGRADE_FAILED',
    );
    assert.equal(pragmaNumber(seed.db, 'user_version'), 1);
    assert.ok(!tableNames(seed.db).includes('_atlas_locations_upgrade_2'), '失败后不得残留迁移临时表');
    assert.ok(!tableNames(seed.db).includes(PROGRESS));
    assert.equal(pragmaNumber(seed.db, 'foreign_keys'), 1);
    assert.equal(await sha256Hex(seed.db.export()), bytesSha, '失败后副本内部状态不得被部分改写');
  });
});

test('MIG02d 宿主保存位置失败：旧信封保持 schema2 逐字节不变，世界不发布', async () => {
  const chatUid = 'mig02d';
  const source = await makeSeedWith(SQL);
  dropToSchema2(source.db);
  const schema2Bytes = source.exportBytes();
  const schema2Sha = await sha256Hex(schema2Bytes);
  source.close();

  // encodeSnapshot 只产当前版本的信封；schema2 信封由当前信封显式标回 2
  // （sha256 只覆盖 bytes，标版本号不影响完整性校验）。
  const envelope = {
    ...(await encodeSnapshot(schema2Bytes, {
      chatUid,
      worldUid: `world_${chatUid}`,
      storageRevision: 0,
      activeBranchId: BRANCH,
    })),
    schema_version: 2,
  };
  assert.equal(envelope.schema_version, 2, '夹具必须是 schema2 信封');
  const envelopeSha = await sha256Hex(new TextEncoder().encode(JSON.stringify(envelope)));

  const host = {
    chatUid,
    branchId: BRANCH,
    chatMetadata: { atlas: { database: envelope } },
    // 宿主保存被拒绝：候选不发布，原信封一个字节都不能动。
    saveMetadata: async () => false,
  };
  const provider = createBrowserSqlHost({
    enabled: () => true,
    context: () => host,
    loadRuntime: loadAtlasSqlRuntime,
    modelPort: null,
  });
  try {
    const session = await provider.session(chatUid);
    await assert.rejects(
      () => handleSqlMapAction(session, 'map/scale', { chatId: chatUid, mapId: IDS.M1, userMetersPerCell: 2 }),
      (err) => err.code === 'SESSION_WRITE_FAILED',
      '宿主拒绝保存必须明确失败，不得假装已发布',
    );
    assert.equal(
      String(host.chatMetadata.atlas.database.chat_uid),
      chatUid,
      '信封对象不得被换成别的东西',
    );
    assert.equal(host.chatMetadata.atlas.database.schema_version, 2, '未确认保存前不得写入 schema3 信封');
    assert.equal(
      await sha256Hex(new TextEncoder().encode(JSON.stringify(host.chatMetadata.atlas.database))),
      envelopeSha,
      '宿主失败后原信封必须逐字节不变',
    );
    assert.equal(await sha256Hex(schema2Bytes), schema2Sha, '原 bytes 不得被改写');
  } finally {
    await provider.close();
  }
});

/* ------------------------------------------------------------------ *
 * MIG03：journal / 回退 / 幂等
 * ------------------------------------------------------------------ */

function progressRow(id, over = {}, ctxOver = {}) {
  return createRow(
    PROGRESS,
    {
      scope_key: 'bootstrap',
      kind: 'target',
      subject_key: IDS.L1,
      input_signature: 'sig-v1',
      status: 'pending',
      last_served_seq: 0,
      payload_json: { version: 1, assignedUnitId: 'u1', result: 'ok' },
      ...over,
    },
    ctx(id, ctxOver),
  );
}

/** 插一条普通叙事楼并把它设为分支 head：回退链只覆盖非 migration 楼。 */
function insertTurn(db, id, parentTurnId) {
  db.run(
    `INSERT INTO turns (id, branch_id, parent_turn_id, host_message_uid, host_variant_key, kind, input_hash, story_hash,
                        base_revision, committed_revision, clock_before_s, elapsed_json, clock_after_s, rng_seed,
                        ruleset_version, decisions_json, receipt_json, attempts_json, status, created_wall_ms, prepared_wall_ms)
     VALUES (?, ?, ?, NULL, NULL, 'narrative', ?, NULL, 0, 0, 0, ?, 0, ?, 'atlas-1', '{}', NULL, '[]', 'committed', ?, ?)`,
    [
      id,
      BRANCH,
      parentTurnId,
      `hash_${id}`,
      JSON.stringify({ min_s: 0, nominal_s: 0, max_s: 0, quality: 'explicit', basis_refs: [] }),
      `rng_${id}`,
      WALL,
      WALL,
    ],
  );
  db.run('UPDATE branches SET head_turn_id = ? WHERE id = ?', [id, BRANCH]);
}

function bookkeepingGroup(id, mutations) {
  return {
    id,
    opIds: [id],
    dependsOn: [],
    readSet: [],
    mutations,
    purpose: 'bookkeeping',
  };
}

test('MIG03 进度表 mutation 进 journal 且可逆序恢复；重复确认不重复写', async () => {
  await withSeed(async (seed) => {
    const db = seed.db;
    const progressTurn = 'turn_p09a_progress';
    insertTurn(db, progressTurn, TURN);
    const row = progressRow('cp_1', {}, { turnId: progressTurn });
    const group = bookkeepingGroup('grp_progress_1', [
      { table: PROGRESS, rowId: 'cp_1', before: null, after: row, sourceOpIds: ['grp_progress_1'], basis: { kind: 'simulation', reason: '建设进度记账' } },
    ]);

    const journalCount = () => Number(queryBound(db, 'SELECT COUNT(*) AS n FROM turn_changes', [])[0].n);
    const journalBefore = journalCount();
    const first = applyGroups(db, [group], { branchId: BRANCH, turnId: progressTurn, attemptId: 'p09a', validate: true });
    assert.equal(first.groups[0].status, 'applied');
    assert.equal(first.groups[0].changedRows, 1);
    assert.equal(first.groups[0].purpose, 'bookkeeping', '组的用途必须带到回执，供统计层分类');
    assert.equal(countRows(db, PROGRESS, BRANCH), 1);

    const journalAfter = journalCount();
    assert.equal(journalAfter, journalBefore + 1, '进度写入必须恰好记一条变更日志');
    const entry = queryBound(db, 'SELECT * FROM turn_changes WHERE target_table = ? ORDER BY sequence DESC LIMIT 1', [PROGRESS])[0];
    assert.ok(entry, '必须有 construction_progress 的日志行');
    assert.equal(String(entry.operation), 'insert');
    assert.equal(entry.before_json, null, '新建行的 before 必须是 null');
    assert.equal(JSON.parse(String(entry.after_json)).id, 'cp_1');

    // 重复确认：同一幂等键只能返回 duplicate，且不得再写一行日志。
    const again = applyGroups(db, [group], {
      branchId: BRANCH,
      turnId: progressTurn,
      attemptId: 'p09a',
      validate: true,
      appliedKeys: first.appliedKeys,
    });
    assert.equal(again.groups[0].status, 'duplicate');
    assert.equal(again.groups[0].changedRows, 0);
    assert.equal(journalCount(), journalAfter, '重复确认不得重复写日志');
    assert.equal(countRows(db, PROGRESS, BRANCH), 1);

    // 非 bookkeeping 组想写进度表：结构上直接拒绝。
    const forbidden = applyGroups(
      db,
      [{ ...group, id: 'grp_progress_bad', purpose: undefined }],
      { branchId: BRANCH, turnId: progressTurn, attemptId: 'p09a-bad', validate: true },
    );
    assert.equal(forbidden.groups[0].status, 'rejected');
    assert.equal(forbidden.groups[0].issues[0].code, 'PROGRAM_TABLE_WRITE_FORBIDDEN');
    assert.equal(countRows(db, PROGRESS, BRANCH), 1, '被拒绝的组不得写入');

    // 回退：真实计划 + 真实应用，进度行必须被删掉（before = null）。
    const plan = planRollback({ db, branchId: BRANCH, targetTurnId: progressTurn });
    const progressSteps = plan.steps.filter((step) => step.targetTable === PROGRESS);
    assert.equal(progressSteps.length, 1, '进度行必须进入回退步骤（不能借「内部表」名义绕过回退）');
    assert.equal(progressSteps[0].restore, null, 'before=null 的恢复动作是删除');
    seed.db.run('BEGIN');
    await applyRollbackPlan(db, plan, { turnId: progressTurn, attemptId: 'rollback' });
    seed.db.run('COMMIT');
    assert.equal(countRows(db, PROGRESS, BRANCH), 0, '回退必须把进度行恢复到 before');
    assert.deepEqual(queryBound(db, 'PRAGMA foreign_key_check', []), []);
  });
});

/* ------------------------------------------------------------------ *
 * MIG04：fork 后父子进度独立
 * ------------------------------------------------------------------ */

test('MIG04 fork 复制进度行：父子独立、审计列按 fork turn 重建、原分支不被修改', async () => {
  await withSeed(async (seed) => {
    const db = seed.db;
    const forked = 'main-fork-p09a';
    insertRows(db, PROGRESS, [progressRow('cp_scope', { kind: 'scope', subject_key: 'bootstrap' })]);
    insertRows(db, PROGRESS, [
      progressRow('cp_chunk', {
        kind: 'chunk',
        scope_key: 'bootstrap',
        subject_key: 'src@hash#0:10@v1',
        input_signature: 'chunk-sig',
        status: 'processed',
        payload_json: { version: 1, start: 0, end: 10, unitId: 'u1', result: 'ok' },
      }),
    ]);
    const parentBefore = queryBound(db, 'SELECT * FROM construction_progress WHERE branch_id = ? ORDER BY id', [BRANCH]);

    const result = forkBranch(
      { parentBranchId: BRANCH, newBranchId: forked, name: '分叉进度', forkTurnId: TURN, makeId: (kind, opId, alias) => `${kind}_${opId}_${alias}`, nowWallMs: WALL, rulesetVersion: 'atlas-1' },
      db,
    );
    assert.equal(result.issues.filter((issue) => issue.severity === 'error').length, 0, JSON.stringify(result.issues));

    let expected = 0;
    for (const table of FORK_COPY_TABLES) expected += countRows(db, table, BRANCH);
    assert.equal(result.copiedRows, expected, '复制行数必须覆盖新的 17 张表');
    assert.ok(FORK_COPY_TABLES.includes(PROGRESS), 'construction_progress 必须在 fork 复制清单里');

    const forkTurnId = String(queryBound(db, 'SELECT head_turn_id FROM branches WHERE id = ?', [forked])[0].head_turn_id);
    const copies = queryBound(db, 'SELECT * FROM construction_progress WHERE branch_id = ? ORDER BY id', [forked]);
    assert.deepEqual(copies.map((row) => String(row.id)), ['cp_chunk', 'cp_scope'], '进度 ID 稳定继承');
    assert.ok(copies.every((row) => Number(row.row_rev) === 1), 'row_rev 归 1');
    assert.ok(copies.every((row) => String(row.created_turn_id) === forkTurnId && String(row.updated_turn_id) === forkTurnId), '审计列按 fork turn 重建');
    assert.equal(
      String(copies.find((row) => String(row.id) === 'cp_chunk').payload_json),
      String(parentBefore.find((row) => String(row.id) === 'cp_chunk').payload_json),
      '进度内容按行复制',
    );
    assert.deepEqual(
      queryBound(db, 'SELECT * FROM construction_progress WHERE branch_id = ? ORDER BY id', [BRANCH]).map((row) => String(row.status)),
      ['processed', 'pending'],
      '原分支进度一个字段都不许改',
    );

    // 父子独立：改一方不出现于另一方。
    db.run('UPDATE construction_progress SET status = ?, row_rev = row_rev + 1 WHERE branch_id = ? AND id = ?', ['suspended', forked, 'cp_scope']);
    assert.equal(String(queryBound(db, 'SELECT status FROM construction_progress WHERE branch_id = ? AND id = ?', [BRANCH, 'cp_scope'])[0].status), 'pending');
    assert.equal(String(queryBound(db, 'SELECT status FROM construction_progress WHERE branch_id = ? AND id = ?', [forked, 'cp_scope'])[0].status), 'suspended');

    // 身份可用：target/source 引用的实体与来源在两条分支上都解析得到。
    assert.equal(Number(queryBound(db, 'SELECT COUNT(*) AS n FROM locations WHERE branch_id = ? AND id = ?', [forked, IDS.L1])[0].n), 1);
    assert.equal(Number(queryBound(db, 'SELECT COUNT(*) AS n FROM locations WHERE branch_id = ? AND id = ?', [BRANCH, IDS.L1])[0].n), 1);
    assert.deepEqual(queryBound(db, 'PRAGMA foreign_key_check', []), []);
    assert.equal(countRows(db, PROGRESS, forked), 2);
  });
});

/* ------------------------------------------------------------------ *
 * MIG05：完整备份恢复进度；分析/POV 导出不含进度
 * ------------------------------------------------------------------ */

test('MIG05 完整备份恢复新进度；地图分析导出与 POV 画面都不含内部进度', async () => {
  const chatUid = 'mig05';
  const source = await makeSeedWith(SQL);
  insertRows(source.db, PROGRESS, [
    progressRow('cp_scope', { kind: 'scope', subject_key: 'bootstrap', payload_json: { version: 1, mode: 'local', secretMarker: 'PROGRESS_LEAK_CANARY' } }),
    progressRow('cp_unit', { kind: 'unit', subject_key: 'unit-1', status: 'processed', payload_json: { version: 1, attemptCount: 2, secretMarker: 'PROGRESS_LEAK_CANARY' } }),
  ]);
  const bytes = source.exportBytes();
  source.close();

  const repo = createSqlRepository({ chatUid, branchId: BRANCH, modelPort: null, now: () => WALL });
  try {
    await repo.open({ bytes });
    assert.equal(countRows(repo.db, PROGRESS, BRANCH), 2, '打开后进度行仍在');
    const exported = await repo.exportCurrent();
    const envelope = await encodeSnapshot(exported, {
      chatUid,
      worldUid: `world_${chatUid}`,
      storageRevision: 0,
      activeBranchId: BRANCH,
    });
    const decoded = await decodeSnapshot(envelope);
    assert.equal(decoded.ok, true, JSON.stringify(decoded));
    const reopened = createSqlRepository({ chatUid, branchId: BRANCH, modelPort: null, now: () => WALL });
    await reopened.open({ bytes: decoded.bytes });
    const restored = queryBound(reopened.db, 'SELECT id, kind, status, payload_json FROM construction_progress WHERE branch_id = ? ORDER BY id', [BRANCH]);
    assert.deepEqual(restored.map((row) => String(row.id)), ['cp_scope', 'cp_unit'], '完整备份必须恢复新进度');
    assert.equal(String(restored[1].status), 'processed');
    assert.match(String(restored[0].payload_json), /PROGRESS_LEAK_CANARY/);

    // 地图分析导出：走真实视图与真实导出器，进度内容一个字节都不许出现。
    const mapView = await reopened.queryView({ kind: 'map', branchId: BRANCH, viewMode: 'author' });
    const sceneView = await reopened.queryView({ kind: 'scene', branchId: BRANCH, viewMode: 'author' });
    const catalogView = await reopened.queryView({ kind: 'catalog', branchId: BRANCH, viewMode: 'author' });
    const data = projectReferenceData({ mapView, sceneView, catalogView, viewMode: 'author' });
    const analysis = JSON.stringify(buildMapAnalysisExport({ data, mapView, sceneView, catalogView, mapId: IDS.M1, exportedAt: '2026-10-11T00:00:00Z' }));
    assert.doesNotMatch(analysis, /PROGRESS_LEAK_CANARY/);
    assert.doesNotMatch(analysis, /construction_progress/);
    assert.doesNotMatch(JSON.stringify([mapView, sceneView, catalogView]), /PROGRESS_LEAK_CANARY/, '视图 DTO 不得回显内部进度');

    // 短引用目录也不得把进度表当成可引用实体。
    const refs = queryBound(reopened.db, 'SELECT COUNT(*) AS n FROM sqlite_master WHERE type = ? AND name = ?', ['table', PROGRESS]);
    assert.equal(Number(refs[0].n), 1, '进度表确实存在于库里（证明上面的「不含」不是因为它不存在）');
    const catalogue = collectKnownRefs(createTableReadPort(reopened.db), BRANCH);
    assert.ok(catalogue.length > 0, '目录本身不是空的');
    assert.ok(
      catalogue.every((ref) => !String(ref.id).startsWith('cp_')),
      '内部进度行不得进入模型短引用目录（进度不是模型可写实体）',
    );
    const fixedKinds = new Set(['action', 'channel', 'character', 'event', 'faction', 'information', 'item', 'journey', 'knowledge', 'location', 'map', 'route']);
    for (const kind of new Set(catalogue.map((ref) => ref.kind))) {
      assert.ok(fixedKinds.has(kind), `目录里出现了非固定种类 ${kind}：内部表不得污染短引用目录`);
    }
    await reopened.close();
  } finally {
    await repo.close();
  }
});

/* ------------------------------------------------------------------ *
 * MIG06：版本判定与不降级
 * ------------------------------------------------------------------ */

test('MIG06 旧 schema 不被新版本期待误判为坏库；未来 schema 明确拒绝且不降级', async () => {
  await withSeed((seed) => {
    dropToSchema2(seed.db);
    const before = preservedSnapshot(seed.db);
    // schema2 恰好 20 张表：不能因为本构建期待 21 张就先报 DB_SCHEMA_INVALID。
    assert.throws(
      () => installSchemaSafe(seed.db),
      (err) => /DB_UPGRADE_REQUIRED/.test(String(err.message)),
      '旧档必须先走副本迁移，而不是被当成坏库或被 CREATE IF NOT EXISTS 假升级',
    );
    assert.equal(pragmaNumber(seed.db, 'user_version'), 2, '拒绝时不得改版本号');
    assert.deepEqual(preservedSnapshot(seed.db), before, '拒绝时不得改任何表');
    assert.ok(!tableNames(seed.db).includes(PROGRESS));
  });

  await withSeed((seed) => {
    dropToSchema2(seed.db);
    dropToSchema1(seed.db);
    assert.throws(
      () => installSchemaSafe(seed.db),
      (err) => /DB_UPGRADE_REQUIRED/.test(String(err.message)),
      'schema1 也必须是「需要升级」而不是「坏库」',
    );
  });

  // 真实 schema2 信封经会话打开：自动升级到 3，且原信封不被改写。
  {
    const chatUid = 'mig06';
    const source = await makeSeedWith(SQL);
    dropToSchema2(source.db);
    const bytes = source.exportBytes();
    source.close();
    const envelope = {
      ...(await encodeSnapshot(bytes, {
        chatUid,
        worldUid: `world_${chatUid}`,
        storageRevision: 0,
        activeBranchId: BRANCH,
      })),
      schema_version: 2,
    };
    const envSha = await sha256Hex(new TextEncoder().encode(JSON.stringify(envelope)));
    const host = { chatUid, branchId: BRANCH, chatMetadata: { atlas: { database: envelope } }, saveMetadata: async () => true };
    const provider = createBrowserSqlHost({ enabled: () => true, context: () => host, loadRuntime: loadAtlasSqlRuntime, modelPort: null });
    try {
      const session = await provider.session(chatUid);
      assert.equal(userTables(session.repo.db).length, USER_TABLE_COUNT);
      assert.equal(currentVersionOf(session.repo.db), ATLAS_SCHEMA_VERSION);
      assert.equal(host.chatMetadata.atlas.database.schema_version, 2, '未确认保存前不得替换原信封');
      assert.equal(await sha256Hex(new TextEncoder().encode(JSON.stringify(host.chatMetadata.atlas.database))), envSha);
    } finally {
      await provider.close();
    }
  }

  // 未来 schema：只读拒绝，不清空、不降级。
  await withSeed((seed) => {
    seed.db.run('PRAGMA user_version = 4');
    const before = preservedSnapshot(seed.db);
    assert.throws(() => installSchemaSafe(seed.db), (err) => /DB_SCHEMA_UNSUPPORTED/.test(String(err.message)));
    assert.throws(() => upgradeSchema(seed.db), (err) => err.code === 'DB_SCHEMA_UNSUPPORTED');
    assert.equal(pragmaNumber(seed.db, 'user_version'), 4);
    assert.deepEqual(preservedSnapshot(seed.db), before);
    assert.deepEqual(tableNames(seed.db).sort(), Object.keys(ATLAS_TABLE_COLUMNS).sort());
  });

  // 更高版本的信封：读的时候就拒绝。
  {
    const chatUid = 'mig06-future';
    const source = await makeSeedWith(SQL);
    const bytes = source.exportBytes();
    source.close();
    const envelope = await encodeSnapshot(bytes, {
      chatUid,
      worldUid: `world_${chatUid}`,
      storageRevision: 0,
      activeBranchId: BRANCH,
    });
    const future = { ...envelope, schema_version: 4 };
    const decoded = await decodeSnapshot(future);
    assert.equal(decoded.ok, false);
    assert.equal(decoded.code, 'DB_SCHEMA_UNSUPPORTED');
  }

  // 完全空库仍然能正常安装当前 schema。
  {
    const empty = new SQL.Database();
    installSchema(empty);
    assert.equal(pragmaNumber(empty, 'user_version'), ATLAS_SCHEMA_VERSION);
    assert.equal(tableNames(empty).length, expectedTableCount(ATLAS_SCHEMA_VERSION));
    installSchemaSafe(empty);
    assert.equal(tableNames(empty).length, expectedTableCount(ATLAS_SCHEMA_VERSION));
    empty.close();
  }
});

/* ------------------------------------------------------------------ *
 * MIG07：进度写入不算业务变化
 * ------------------------------------------------------------------ */

test('MIG07 只新增进度记录：实体新增数为 0、clock_s 不变、业务计数不虚增，stale guard 仍生效', async () => {
  // 分类判据本身：看到表 + 看到用途，绝不看 id 前缀。
  assert.equal(isBusinessMutationTable(PROGRESS), false);
  assert.equal(isBusinessMutationTable('characters'), true);
  assert.equal(groupChangesBusiness({ purpose: 'bookkeeping', mutations: [{ table: 'maps' }] }), false, '记账组写业务表也不算业务变化');
  assert.equal(groupChangesBusiness({ mutations: [{ table: PROGRESS }] }), false, '只写内部表不算业务变化');
  assert.equal(groupChangesBusiness({ mutations: [{ table: 'maps' }, { table: PROGRESS }] }), true, '同时写业务表就算业务变化');
  // 名字前缀不再参与判定：换一个前缀、只要用途/表对，结论一样。
  assert.equal(groupChangesBusiness({ purpose: 'bookkeeping', mutations: [{ table: 'characters' }] }), false);

  await withSeed(async (seed) => {
    const db = seed.db;
    const clockBefore = Number(queryBound(db, 'SELECT clock_s FROM branches WHERE id = ?', [BRANCH])[0].clock_s);
    const revisionBefore = Number(queryBound(db, 'SELECT revision FROM branches WHERE id = ?', [BRANCH])[0].revision);
    const entitiesBefore =
      countRows(db, 'locations', BRANCH) + countRows(db, 'characters', BRANCH) + countRows(db, 'items', BRANCH) + countRows(db, 'factions', BRANCH);

    const row = progressRow('cp_only');
    const applied = applyGroups(db, [bookkeepingGroup('grp_world_fill_p09a', [
      { table: PROGRESS, rowId: 'cp_only', before: null, after: row, sourceOpIds: ['grp_world_fill_p09a'], basis: { kind: 'simulation' } },
    ])], { branchId: BRANCH, turnId: TURN, attemptId: 'p09a-only', validate: true });
    assert.equal(applied.groups[0].changedRows, 1, '进度行确实写进去了');
    assert.equal(applied.groups[0].purpose, 'bookkeeping');

    assert.equal(
      countRows(db, 'locations', BRANCH) + countRows(db, 'characters', BRANCH) + countRows(db, 'items', BRANCH) + countRows(db, 'factions', BRANCH),
      entitiesBefore,
      '只写进度不得新增任何实体',
    );
    assert.equal(Number(queryBound(db, 'SELECT clock_s FROM branches WHERE id = ?', [BRANCH])[0].clock_s), clockBefore, 'clock_s 不得动');
    assert.equal(Number(queryBound(db, 'SELECT revision FROM branches WHERE id = ?', [BRANCH])[0].revision), revisionBefore, 'revision 不得动');

    // 回执适配层：业务成功组不把记账组算进去，但摘要要说清「另保存建设进度」。
    const legacy = toLegacyTurnReceipt({
      turnId: TURN,
      anchor: { chatUid: IDS.chatA, branchId: BRANCH, parentTurnId: null, hostMessageUid: 'u', variantKey: 'v', baseRevision: revisionBefore, baseStorageRevision: 0, inputHash: 'h' },
      status: 'committed',
      groups: applied.groups,
      issues: [],
      clockBeforeS: clockBefore,
      clockAfterS: clockBefore,
      simulatedUntilS: clockBefore,
      worldChanged: false,
      timeChanged: false,
    });
    assert.equal(legacy.groupCounts.applied, 1, '组确实是 applied（不是被静默丢掉）');
    assert.match(String(legacy.summary), /成功组 0/, '业务成功组必须是 0');
    assert.match(String(legacy.summary), /另保存建设进度/);
    assert.equal(legacy.receipt.worldChanged, false, '世界没变化：不得借内部写入推进 revision');

    // stale guard 仍生效：基版本不符的锚点在真实仓库入口就必须被拒。
    const repo = createSqlRepository({ chatUid: IDS.chatA, branchId: BRANCH, modelPort: null, now: () => WALL });
    const seedBytes = db.export();
    await repo.open({ bytes: seedBytes });
    await assert.rejects(
      () =>
        repo.prepareTurn({
          anchor: {
            chatUid: IDS.chatA,
            branchId: BRANCH,
            parentTurnId: TURN,
            hostMessageUid: 'stale',
            variantKey: 'v1',
            baseRevision: revisionBefore + 99,
            baseStorageRevision: 0,
            inputHash: 'stale',
          },
          userText: '过期锚点',
          assistantText: '过期锚点',
          sourceSnapshot: [],
          operations: [],
          phaseBatches: [],
          manual: true,
        }),
      (err) => err.code === 'STALE_BASE',
      'stale/base guard 不得因为新增内部表而失效',
    );
    await repo.close();
  });
});
