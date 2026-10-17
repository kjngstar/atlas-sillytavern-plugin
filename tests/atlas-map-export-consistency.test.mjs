/**
 * atlas-map-export-consistency.test.mjs — P01c：快照一致性与真实截断计数（E04 / E05）。
 *
 * 生产链：repository.queryView → UI 投影 → buildMapAnalysisExport。
 * 第二至第五项只在**真实读出后的 DTO** 上改变待测字段，不手写假 DTO。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { makeSeedWith, IDS } from './fixtures/atlas-sql/seed.mjs';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { projectReferenceData } from '../ui/atlas-reference-data.mjs';
import { buildMapAnalysisExport } from '../ui/atlas-map-export.mjs';

const SQL = await initSqlJs();

async function withSnapshot(viewMode, run, { mutate } = {}) {
  const seed = await makeSeedWith(SQL);
  if (mutate) mutate(seed.db);
  const bytes = seed.exportBytes();
  seed.close();
  const repo = createSqlRepository({
    chatUid: IDS.chatA, branchId: IDS.branchMain,
    modelPort: { async request() { throw Error('此测试禁止模型调用'); } },
  });
  try {
    await repo.open({ bytes });
    const query = kind => repo.queryView({ kind, branchId: IDS.branchMain, viewMode });
    const mapView = await query('map');
    const sceneView = await query('scene');
    const catalogView = await query('catalog');
    const data = projectReferenceData({ mapView, sceneView, catalogView, viewMode });
    return await run({
      data, mapView, sceneView, catalogView, mapId: IDS.M1,
      exportedAt: '2026-10-11T00:00:00Z',
    }, mapView);
  } finally {
    await repo.close();
  }
}

test('E04 revision 相同但分支不同：拒绝混合快照', async () => {
  await withSnapshot('author', fixture => {
    assert.ok(buildMapAnalysisExport(fixture), '基线必须能导出');
    fixture.catalogView.branchId = 'another-branch';
    assert.throws(() => buildMapAnalysisExport(fixture), /分支/);
  });
});

test('E04 revision 相同但视角不同：拒绝混合快照', async () => {
  await withSnapshot('author', fixture => {
    fixture.catalogView.viewMode = 'pov';
    assert.throws(() => buildMapAnalysisExport(fixture), /视角/);
    // 极端情况：地图自己带着与投影不一致的视角，也必须被识破。
    delete fixture.catalogView.viewMode;
    fixture.sceneView.viewMode = 'pov';
    assert.throws(() => buildMapAnalysisExport(fixture), /视角/);
  });
});

test('E05 读数上限显示截断时导出被阻止', async () => {
  await withSnapshot('author', fixture => {
    assert.ok(buildMapAnalysisExport(fixture), '基线必须能导出');
    fixture.mapView.metadata = { ...(fixture.mapView.metadata ?? {}), readLimits: { routes: { limit: 1000, total: 1003, shown: 1000, truncated: 3 } } };
    assert.throws(() => buildMapAnalysisExport(fixture), /截断/);
  });
});

test('E05 1,001 条 open 路线必须计数为 1,001 而非 0', async () => {
  const ROUTE_COUNT = 1001;
  const mutate = db => {
    for (let i = 0; i < ROUTE_COUNT; i += 1) {
      db.run(
        `INSERT INTO routes (branch_id, id, row_rev, created_turn_id, updated_turn_id, from_location_id, to_location_id, kind, bidirectional, map_id, geometry_json, geometry_quality, geometry_rev, distance_basis, terrain, allowed_modes_json, status)
         VALUES (?, ?, 1, ?, ?, ?, ?, 'path', 1, ?, NULL, 'estimated', 1, 'unknown', 'unknown', '[]', 'open')`,
        [IDS.branchMain, `R_FILL_${i}`, IDS.seedTurn, IDS.seedTurn, IDS.L1, IDS.L2, IDS.M1],
      );
    }
  };
  await withSnapshot('author', (fixture, mapView) => {
    const limits = mapView.metadata.readLimits.routes;
    assert.ok(limits, '必须回报 routes 的读取上限');
    assert.ok(limits.total >= ROUTE_COUNT, `1,001 条 open 路线必须被数出来，实际 total=${limits.total}`);
    assert.notEqual(limits.total, 0, '绝不能因为用 status=\'active\' 过滤而报 0');
    assert.equal(limits.truncated, 0, '所有分页确实读完后不应继续假报截断');
    assert.equal(limits.complete, true);
    assert.equal(limits.shown, limits.total);
    const exported = buildMapAnalysisExport(fixture);
    assert.ok(exported.file.maps.find(map => map.mapId === IDS.M1).routes.length >= ROUTE_COUNT, '完整导出必须包含尾部路线');
  }, { mutate });
});

test('E05 POV 不下发全库隐藏总数', async () => {
  const ROUTE_COUNT = 1001;
  const mutate = db => {
    for (let i = 0; i < ROUTE_COUNT; i += 1) {
      db.run(
        `INSERT INTO routes (branch_id, id, row_rev, created_turn_id, updated_turn_id, from_location_id, to_location_id, kind, bidirectional, map_id, geometry_json, geometry_quality, geometry_rev, distance_basis, terrain, allowed_modes_json, status)
         VALUES (?, ?, 1, ?, ?, ?, ?, 'path', 1, ?, NULL, 'estimated', 1, 'unknown', 'unknown', '[]', 'open')`,
        [IDS.branchMain, `R_FILL_P_${i}`, IDS.seedTurn, IDS.seedTurn, IDS.L1, IDS.L2, IDS.M1],
      );
    }
  };
  await withSnapshot('pov', (fixture, mapView) => {
    const limits = mapView.metadata.readLimits.routes;
    assert.equal(limits.total, limits.shown, 'POV 不得回报全库隐藏总数');
    assert.equal(limits.truncated, 0, 'POV 不提供隐藏截断数量');
    assert.equal(limits.overLimit, false, '所有分页已经完成，不再假报超限');
    assert.equal(limits.complete, true);
    const visibleRoutes = new Set(mapView.items.flatMap(map => map.routes.map(route => route.routeId)));
    assert.equal(limits.total, visibleRoutes.size, 'POV 统计必须来自可见路线而不是私有全库数量');
  }, { mutate });
});
