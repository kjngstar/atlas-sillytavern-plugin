/**
 * atlas-db-export.test.mjs — T27 存档导出/导入与打包资产（§7.1 / §11.3 / §18.3 T27）。
 *
 * 覆盖：
 * - 导出/导入 hash 一致：export → encodeSnapshot → decodeSnapshot 逐字节相等、sha256 一致，
 *   用解码结果重新 open 后 20 张表的数据行数不变；
 * - 版本高于实现拒绝写且不清库（DB_SCHEMA_UNSUPPORTED，原数据仍可读）；
 * - hash / 长度 / base64 不符分别拒绝（ENVELOPE_HASH_MISMATCH / ENVELOPE_LENGTH_MISMATCH /
 *   ENVELOPE_BASE64_INVALID），任何失败都不返回 bytes；
 * - 资产 manifest 缺失时不丢实体（实体行数与 ID 逐字不变、assets 保持为空）；
 * - 批量体积实测（tools/atlas-db-benchmark.mjs 的 small 规模，只断言关系不断言阈值）；
 * - 打包资产清单：verifySqlVendorAssets 对完整清单 ok，缺一个精确报缺。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, countRows, userTables, foreignKeyCheck } from './fixtures/atlas-sql/seed.mjs';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { decodeSnapshot, encodeSnapshot, envelopeSummary, sha256Hex } from '../src/atlas-db-envelope.ts';
import { ATLAS_SQL_VENDOR_FILES, verifySqlVendorAssets } from '../src/atlas-db-assets.ts';

const SQL = await (await import('sql.js')).default();

const BRANCH = IDS.branchMain;
const CHAT = IDS.chatA;
const COMPLETE_VENDOR_ASSETS = ['vendor/sql-wasm.js', 'vendor/sql-wasm.wasm'];

async function openRepo(bytes, envelope = null) {
  const repo = createSqlRepository({ chatUid: CHAT, branchId: BRANCH });
  await repo.open(envelope ? { bytes, envelope } : { bytes });
  return repo;
}

function countAll(db, table) {
  const rows = db.exec(`SELECT COUNT(*) FROM ${table}`);
  return Number(rows[0].values[0][0]);
}

function idList(db, table) {
  const rows = db.exec(`SELECT id FROM ${table} ORDER BY id`);
  return rows.length ? rows[0].values.map((value) => String(value[0])) : [];
}

async function envelopeFor(bytes, extra = {}) {
  return encodeSnapshot(bytes, {
    chatUid: CHAT,
    worldUid: `world_${CHAT}`,
    storageRevision: 1,
    activeBranchId: BRANCH,
    ...extra,
  });
}

test('T27-01 导出/导入 hash 一致：bytes 逐字节相等、sha256 一致、20 表行数不变', async () => {
  const seed = await makeSeedWith(SQL);
  let repo = null;
  let reopened = null;
  try {
    repo = await openRepo(seed.exportBytes());
    const bytes = await repo.exportCurrent();
    assert.ok(bytes instanceof Uint8Array);
    assert.ok(bytes.length > 0);

    const envelope = await envelopeFor(bytes);
    assert.equal(envelope.format, 'atlas-sqlite');
    assert.equal(envelope.storage_version, 1);
    assert.equal(envelope.encoding, 'sqlite-base64');
    assert.equal(envelope.byte_length, bytes.length);
    assert.equal(envelope.sha256, await sha256Hex(bytes), '信封 sha256 必须是真实数据哈希');

    const decoded = await decodeSnapshot(envelope);
    assert.equal(decoded.ok, true, JSON.stringify(decoded));
    assert.equal(decoded.bytes.length, bytes.length);
    assert.deepEqual(decoded.bytes, bytes, '编解码必须逐字节一致');
    assert.equal(decoded.envelope.sha256, envelope.sha256);
    assert.equal(decoded.envelope.assetCount, undefined);
    assert.equal(envelopeSummary(decoded.envelope).assetCount, 0);

    // 用解码结果重新打开：20 张表行数与 ID 全部不变。
    reopened = await openRepo(decoded.bytes);
    const tables = userTables(seed.db);
    assert.equal(tables.length, 20);
    for (const table of tables) {
      assert.equal(countAll(reopened.db, table), countAll(seed.db, table), `${table} 行数必须不变`);
    }
    for (const table of ['maps', 'locations', 'characters', 'items', 'factions', 'routes', 'relations']) {
      assert.deepEqual(idList(reopened.db, table), idList(seed.db, table), `${table} 的 ID 必须逐字不变`);
    }
    assert.deepEqual(foreignKeyCheck(reopened.db), [], '导入后外键自检为空');
  } finally {
    if (reopened) await reopened.close();
    if (repo) await repo.close();
    seed.close();
  }
});

test('T27-02 版本高于实现：拒绝写且不清库，原存档仍能读出原有行', async () => {
  const seed = await makeSeedWith(SQL);
  let repo = null;
  let reopened = null;
  try {
    const bytes = seed.exportBytes();
    const envelope = await envelopeFor(bytes);
    const tampered = { ...envelope, schema_version: 99 };
    const decoded = await decodeSnapshot(tampered);
    assert.equal(decoded.ok, false);
    assert.equal(decoded.code, 'DB_SCHEMA_UNSUPPORTED');
    assert.equal(decoded.bytes, undefined, '拒绝时绝不返回可写字节');
    assert.match(decoded.message, /不清空重建/);

    // 同一份原始 bytes 仍能打开并读到原有行：没有被清成空库。
    reopened = await openRepo(bytes);
    assert.equal(userTables(reopened.db).length, 20);
    assert.equal(countRows(reopened.db, 'characters', BRANCH), 4);
    assert.equal(countRows(reopened.db, 'maps', BRANCH), 2);
    assert.equal(countRows(reopened.db, 'locations', BRANCH), 3);
    assert.equal(countRows(reopened.db, 'entity_keys', BRANCH), 9);
    assert.ok(idList(reopened.db, 'characters').includes(IDS.C4));
    repo = reopened;
  } finally {
    if (reopened) await reopened.close();
    if (repo && repo !== reopened) await repo.close();
    seed.close();
  }
});

test('T27-03a sha256 不符拒绝（ENVELOPE_HASH_MISMATCH）', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const envelope = await envelopeFor(seed.exportBytes());
    const decoded = await decodeSnapshot({ ...envelope, sha256: 'deadbeef'.repeat(8) });
    assert.equal(decoded.ok, false);
    assert.equal(decoded.code, 'ENVELOPE_HASH_MISMATCH');
    assert.equal(decoded.bytes, undefined);
  } finally {
    seed.close();
  }
});

test('T27-03b byte_length 不符拒绝（ENVELOPE_LENGTH_MISMATCH）', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const envelope = await envelopeFor(seed.exportBytes());
    const decoded = await decodeSnapshot({ ...envelope, byte_length: envelope.byte_length + 1 });
    assert.equal(decoded.ok, false);
    assert.equal(decoded.code, 'ENVELOPE_LENGTH_MISMATCH');
    assert.equal(decoded.detail.declared, envelope.byte_length + 1);
    assert.equal(decoded.detail.actual, envelope.byte_length);
    assert.equal(decoded.bytes, undefined);
  } finally {
    seed.close();
  }
});

test('T27-03c data 非法 base64 拒绝（ENVELOPE_BASE64_INVALID）', async () => {
  const seed = await makeSeedWith(SQL);
  const savedBuffer = globalThis.Buffer;
  try {
    const envelope = await envelopeFor(seed.exportBytes());
    // Node 的 Buffer.from(..., 'base64') 会静默忽略非法字符，模块为此保留了纯 JS 解码回退；
    // 临时隐藏 globalThis.Buffer 才能走到那条真正的校验分支（本文件内串行执行，finally 恢复）。
    // @ts-ignore 测试专用：验证模块自带的非 Buffer 解码路径
    delete globalThis.Buffer;
    const decoded = await decodeSnapshot({ ...envelope, data: '不是base64!!' });
    assert.equal(decoded.ok, false);
    assert.equal(decoded.code, 'ENVELOPE_BASE64_INVALID');
    assert.equal(decoded.bytes, undefined);
    assert.match(decoded.message, /Base64 含非法字符/);
  } finally {
    globalThis.Buffer = savedBuffer;
    seed.close();
  }
});

test('T27-04 资产 manifest 缺失：导入成功、实体行数与 ID 不变、assets 为空', async () => {
  const seed = await makeSeedWith(SQL);
  let repo = null;
  try {
    seed.db.run(`UPDATE maps SET background_asset_key = 'assets/world-bg.png' WHERE branch_id = ? AND id = ?`, [BRANCH, IDS.M1]);
    const beforeIds = {};
    for (const table of ['maps', 'locations', 'characters', 'items', 'factions']) beforeIds[table] = idList(seed.db, table);
    const bytes = seed.exportBytes();

    // 信封里没有任何资产条目，但地图行引用了底图。
    const envelope = await envelopeFor(bytes, { assets: [] });
    assert.deepEqual(envelope.assets, []);
    assert.equal(envelopeSummary(envelope).assetCount, 0);

    const decoded = await decodeSnapshot(envelope);
    assert.equal(decoded.ok, true, JSON.stringify(decoded));
    repo = await openRepo(decoded.bytes, envelope);
    assert.equal(repo.storageRevision, 1);
    for (const table of Object.keys(beforeIds)) {
      assert.deepEqual(idList(repo.db, table), beforeIds[table], `${table} 实体不能因为缺底图丢失`);
    }
    assert.equal(countRows(repo.db, 'maps', BRANCH), 2);
    assert.equal(countRows(repo.db, 'characters', BRANCH), 4);
    assert.equal(countRows(repo.db, 'locations', BRANCH), 3);
    const mapRow = repo.db.exec(`SELECT background_asset_key FROM maps WHERE branch_id = '${BRANCH}' AND id = '${IDS.M1}'`);
    assert.equal(mapRow[0].values[0][0], 'assets/world-bg.png', '引用底图的字段本身不能在导入时被抹掉');
    assert.equal(countAll(repo.db, 'turn_changes'), 0);
  } finally {
    if (repo) await repo.close();
    seed.close();
  }
});

test('T27-04b 缺底图必须有具名诊断/元数据：实体完整但仍明确提示底图缺失', async () => {
  const seed = await makeSeedWith(SQL);
  let repo = null;
  try {
    seed.db.run(`UPDATE maps SET background_asset_key = 'assets/world-bg.png' WHERE branch_id = ? AND id = ?`, [BRANCH, IDS.M1]);
    const envelope = await envelopeFor(seed.exportBytes(), { assets: [] });
    // 真实导入路径：宿主把没有资产的信封交给 repository，视图必须说实话而不是静默丢底图。
    repo = await openRepo(seed.exportBytes(), envelope);
    const view = await repo.queryView({ kind: 'map', branchId: BRANCH, revision: 0 });
    assert.deepEqual(
      view.metadata.missingAssets,
      ['assets/world-bg.png'],
      '缺底图必须有一条具名诊断指出缺哪个资产',
    );
    assert.equal(view.metadata.missingAssetCount, 1);
    assert.match(String(view.metadata.assetNotice ?? ''), /缺底图/, '必须给 UI 一句可读的缺底图提示');
    // 提示缺底图不等于丢实体：同一次返回里地图与实体依然齐全。
    assert.equal(view.items.length, 2, '两张地图都在');
    assert.equal(countRows(repo.db, 'characters', BRANCH), 4);
    assert.equal(countRows(repo.db, 'locations', BRANCH), 3);
  } finally {
    if (repo) await repo.close();
    seed.close();
  }
});

test('T27-05 批量体积实测（small：5 图 / 50 人 / 200 物）：打印真实数字，不承诺阈值', async () => {
  const { runBenchmark } = await import('../tools/atlas-db-benchmark.mjs');
  const result = await runBenchmark('small');
  assert.deepEqual(result.failures, [], `基准不能漏记失败：${JSON.stringify(result.failures)}`);
  assert.ok(result.bytes, '必须有体积结果');
  assert.ok(result.bytes.rawDb > 0, '导出的 SQLite 字节必须大于 0');
  assert.ok(
    result.bytes.envelopeJson > result.bytes.rawDb,
    `base64 信封一定比原始库大：envelopeJson=${result.bytes.envelopeJson} rawDb=${result.bytes.rawDb}`,
  );
  assert.equal(result.bytes.byteLengthField, result.bytes.rawDb, 'byte_length 字段必须等于真实字节数');
  assert.ok(result.bytes.encodedData >= result.bytes.rawDb, 'base64 载荷不小于原始字节');
  assert.ok(result.bytes.sha256.length === 64, '必须记录可核对的 sha256');
  assert.equal(result.counts.maps, 5);
  assert.equal(result.counts.characters, 50);
  assert.equal(result.counts.items, 200);
  console.log(
    `[T27-05 实测] small：rawDb=${result.bytes.rawDb}B envelopeJson=${result.bytes.envelopeJson}B ` +
      `base64=${result.bytes.encodedData}B sha256=${result.bytes.sha256} 表行数=${JSON.stringify(result.counts)} ` +
      `耗时=${JSON.stringify(result.timings)} 查询=${JSON.stringify(result.queryResults)}`,
  );
});

test('T27-06 打包资产清单：完整清单 ok，缺一个精确报缺', async () => {
  assert.deepEqual(
    ATLAS_SQL_VENDOR_FILES.map((asset) => asset.relative),
    COMPLETE_VENDOR_ASSETS,
    'sql.js 资源只有这两个文件，且不得从 CDN 临时载入另一版',
  );
  const complete = verifySqlVendorAssets(COMPLETE_VENDOR_ASSETS);
  assert.equal(complete.ok, true);
  assert.deepEqual(complete.missing, []);
  assert.deepEqual(complete.extra, []);

  const missingWasm = verifySqlVendorAssets(COMPLETE_VENDOR_ASSETS.filter((asset) => asset !== 'vendor/sql-wasm.wasm'));
  assert.equal(missingWasm.ok, false);
  assert.deepEqual(missingWasm.missing, ['vendor/sql-wasm.wasm'], 'missing 必须精确到缺的那一个文件');

  const missingJs = verifySqlVendorAssets(['vendor/sql-wasm.wasm']);
  assert.equal(missingJs.ok, false);
  assert.deepEqual(missingJs.missing, ['vendor/sql-wasm.js']);

  const empty = verifySqlVendorAssets([]);
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.missing, COMPLETE_VENDOR_ASSETS);
  assert.deepEqual(empty.extra, []);

  const withExtra = verifySqlVendorAssets([...COMPLETE_VENDOR_ASSETS, 'vendor/other.js']);
  assert.equal(withExtra.ok, true);
  assert.deepEqual(withExtra.extra, ['vendor/other.js']);
});
