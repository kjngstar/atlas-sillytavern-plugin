/**
 * atlas-map-export-v2.test.mjs — P01d：v2 契约、追加式 metadata 与整体回归。
 *
 * 生产链：repository.queryView → UI 投影 → buildMapAnalysisExport。
 * 只改「真实读出后的 DTO」上的字段，不手写假 DTO。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { makeSeedWith, IDS } from './fixtures/atlas-sql/seed.mjs';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { projectReferenceData } from '../ui/atlas-reference-data.mjs';
import { buildMapAnalysisExport } from '../ui/atlas-map-export.mjs';

const SQL = await initSqlJs();

async function withSnapshot(run) {
  const seed = await makeSeedWith(SQL);
  const bytes = seed.exportBytes();
  seed.close();
  const repo = createSqlRepository({
    chatUid: IDS.chatA, branchId: IDS.branchMain,
    modelPort: { async request() { throw Error('此测试禁止模型调用'); } },
  });
  try {
    await repo.open({ bytes });
    const query = kind => repo.queryView({ kind, branchId: IDS.branchMain, viewMode: 'author' });
    const mapView = await query('map');
    const sceneView = await query('scene');
    const catalogView = await query('catalog');
    const data = projectReferenceData({ mapView, sceneView, catalogView, viewMode: 'author' });
    return await run({ data, mapView, sceneView, catalogView, mapId: IDS.M1, exportedAt: '2026-10-11T00:00:00Z' });
  } finally {
    await repo.close();
  }
}

test('P01D-01 导出为 v2；v1 字段名与含义保持不变（追加式升级）', async () => {
  await withSnapshot(fixture => {
    const output = buildMapAnalysisExport(fixture);
    assert.equal(output.file.kind, 'atlas-map-analysis');
    assert.equal(output.file.version, 2, 'P01d 后版本必须是 2');
    // v1 的字段名一个都不能改名或删除。
    for (const key of ['maps', 'locations', 'scope', 'rendered', 'notes', 'exportedAt']) {
      if (key === 'rendered') { assert.ok(output.file.maps[0].rendered); continue; }
      assert.ok(Object.hasOwn(output.file, key), `v1 字段 ${key} 必须保留`);
    }
    assert.ok(Array.isArray(output.file.maps[0].routes), 'P01b 追加的 routes 必须在');
    assert.equal(typeof output.file.maps[0].scaleQuality !== 'undefined', true);
  });
});

test('P01D-02 metadata：pluginVersion/layoutPolicyVersion 由调用方传入，不手写常量', async () => {
  await withSnapshot(fixture => {
    const plain = buildMapAnalysisExport(fixture).file;
    assert.equal(plain.metadata.pluginVersion, null, '宿主没给就不能编一个版本号');
    assert.equal(plain.metadata.layoutPolicyVersion, null);
    assert.ok(Array.isArray(plain.metadata.generatorVersions));

    const supplied = buildMapAnalysisExport({ ...fixture, pluginVersion: '9.9.9-test', layoutPolicyVersion: 7 }).file;
    assert.equal(supplied.metadata.pluginVersion, '9.9.9-test');
    assert.equal(supplied.metadata.layoutPolicyVersion, 7);
    // 传空串 / 非数字同样不伪造。
    const blank = buildMapAnalysisExport({ ...fixture, pluginVersion: '', layoutPolicyVersion: 'x' }).file;
    assert.equal(blank.metadata.pluginVersion, null);
    assert.equal(blank.metadata.layoutPolicyVersion, null);
  });
});

test('P01D-03 generatorVersions 从已保存场景去重取得', async () => {
  await withSnapshot(fixture => {
    // 真实读出后再改待测字段：先确认 seed 没有已保存场景。
    assert.deepEqual(buildMapAnalysisExport(fixture).file.metadata.generatorVersions, []);
    // 给真实 scene DTO 安上生成器标识（含重复值），确认去重且稳定排序。
    fixture.sceneView.items = [
      { mapId: IDS.M1, sceneStatus: 'ready', scene: { units: 'meters', generator: 'kit/2', layout: { kind: 'overview', bounds: { x: 0, y: 0, w: 10, h: 10 }, pins: [], shapes: [], routes: [], features: [] } } },
      { mapId: IDS.M2, sceneStatus: 'ready', scene: { units: 'meters', generator: 'kit/1', layout: { kind: 'overview', bounds: { x: 0, y: 0, w: 10, h: 10 }, pins: [], shapes: [], routes: [], features: [] } } },
    ];
    const versions = buildMapAnalysisExport(fixture).file.metadata.generatorVersions;
    assert.deepEqual(versions, ['kit/1', 'kit/2'], '必须去重且稳定排序');
  });
});
