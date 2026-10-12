// P01b：地图分析导出的路线、质量字段与公开 frame 白名单（E02 / E06 / E07）。
// 生产链：repository.queryView → UI 投影 → buildMapAnalysisExport。
import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import {makeSeedWith, IDS} from './fixtures/atlas-sql/seed.mjs';
import {createSqlRepository} from '../src/atlas-db-repository.ts';
import {projectReferenceData} from '../ui/atlas-reference-data.mjs';
import {buildMapAnalysisExport} from '../ui/atlas-map-export.mjs';

const SQL = await initSqlJs();
const SECRET_LOCATION = 'L_SECRET_X';
const SECRET_ROUTE = 'R_SECRET_X';

/** 打开真实 seed，允许在查询前改库（write 只在测试夹具内发生）。 */
async function withSnapshot(viewMode, run, {mutate} = {}) {
  const seed = await makeSeedWith(SQL);
  if (mutate) mutate(seed.db);
  const bytes = seed.exportBytes();
  seed.close();
  const repo = createSqlRepository({
    chatUid: IDS.chatA,
    branchId: IDS.branchMain,
    modelPort: {async request() {throw Error('此测试禁止模型调用');}},
  });
  try {
    await repo.open({bytes});
    const query = kind => repo.queryView({kind, branchId: IDS.branchMain, viewMode});
    const mapView = await query('map');
    const sceneView = await query('scene');
    const catalogView = await query('catalog');
    const data = projectReferenceData({mapView, sceneView, catalogView, viewMode});
    return await run({
      data, mapView, sceneView, catalogView, mapId: IDS.M1,
      exportedAt: '2026-10-11T00:00:00Z',
    }, mapView.items.find(m => m.mapId === IDS.M1));
  } finally {
    await repo.close();
  }
}
const exportedMap = fixture => {
  const output = buildMapAnalysisExport(fixture);
  const map = output.file.maps.find(m => m.mapId === IDS.M1);
  assert.ok(map, '导出必须包含选中的真实地图');
  return map;
};

/** 插入一个主角不可见的地点与一条以它为端点的路线。 */
const insertSecret = db => {
  // entity_keys 是 locations 必填的身份行（触发器校验 kind 一致）。
  db.run(
    `INSERT INTO entity_keys (branch_id, id, kind) VALUES (?, ?, 'location')`,
    [IDS.branchMain, SECRET_LOCATION],
  );
  db.run(
    `INSERT INTO locations (branch_id, id, row_rev, created_turn_id, updated_turn_id, name, kind, parent_location_id, map_id, status)
     VALUES (?, ?, 1, ?, ?, '秘密据点', 'building', ?, ?, 'active')`,
    [IDS.branchMain, SECRET_LOCATION, IDS.seedTurn, IDS.seedTurn, IDS.L1, IDS.M1],
  );
  db.run(
    `INSERT INTO routes (branch_id, id, row_rev, created_turn_id, updated_turn_id, from_location_id, to_location_id, kind, bidirectional, map_id, geometry_json, geometry_quality, geometry_rev, distance_basis, terrain, allowed_modes_json, status)
     VALUES (?, ?, 1, ?, ?, ?, ?, 'path', 1, ?, ?, 'confirmed', 1, 'unknown', 'unknown', '[]', 'open')`,
    [IDS.branchMain, SECRET_ROUTE, IDS.seedTurn, IDS.seedTurn, IDS.L1, SECRET_LOCATION, IDS.M1,
      JSON.stringify({kind: 'line', coordinates: [[1, 1], [5, 5]]})],
  );
};

test('E02 作者视图导出可见 open 路线且端点/归属/几何质量一致', async () => {
  await withSnapshot('author', fixture => {
    const map = exportedMap(fixture);
    const route = map.routes.find(r => r.routeId === IDS.R_AB);
    assert.ok(route, '作者视图必须导出真实路线 R_AB');
    assert.equal(route.mapId, IDS.M1);
    assert.equal(route.fromLocationId, IDS.L1);
    assert.equal(route.toLocationId, IDS.L2);
    assert.equal(route.status, 'open');
    assert.equal(route.bidirectional, true);
    assert.equal(route.geometryQuality, 'estimated');
    assert.equal(route.geometryRev, 1);
    assert.equal(route.distanceM, 12000);
    assert.equal(route.dashed, true, 'estimated 路线必须是虚线');
  });
});

test('E02 秘密路线与秘密端点不进入 POV 导出', async () => {
  const check = async viewMode => withSnapshot(viewMode, fixture => exportedMap(fixture), {mutate: insertSecret});
  const author = await check('author');
  const authorJson = JSON.stringify(author);
  assert.match(authorJson, /R_SECRET_X/, '作者视图本应看到秘密路线（用于对照）');
  assert.match(authorJson, /L_SECRET_X/, '作者视图本应看到秘密地点（用于对照）');

  const pov = await check('pov');
  const povJson = JSON.stringify(pov);
  assert.doesNotMatch(povJson, /R_SECRET_X/, 'POV 不得导出秘密路线');
  assert.doesNotMatch(povJson, /L_SECRET_X/, 'POV 不得导出秘密端点');
  assert.doesNotMatch(povJson, /秘密据点/, 'POV 不得导出秘密地点名称');
  assert.ok(!pov.routes.some(r => r.fromLocationId === SECRET_LOCATION || r.toLocationId === SECRET_LOCATION),
    'POV 路线端点不得引用秘密地点');
});

test('E06 未标定 mpp 保持 null 且不从渲染缩放制造比例尺', async () => {
  const mutate = db => {
    db.run(`UPDATE maps SET meters_per_cell = NULL, scale_quality = 'uncalibrated', scale_locked = 0 WHERE branch_id = ? AND id = ?`,
      [IDS.branchMain, IDS.M1]);
  };
  await withSnapshot('author', fixture => {
    const map = exportedMap(fixture);
    assert.equal(map.metersPerCell, null, '未标定必须保持 null');
    assert.equal(map.scaleBar, null, '未标定不得生成比例尺');
    assert.equal(map.scaleQuality, 'uncalibrated');
    assert.ok(map.frame?.reference_width_cells > 0, '幅面字段仍应保留');
  }, {mutate});
});

test('E07 内部命名空间不进公开 frame 与导出', async () => {
  const mutate = db => {
    const frame = {
      origin_x: 0, origin_y: 0, reference_width_cells: 120, reference_height_cells: 80,
      atlasScene: {kind: 'atlas-scene', secret: 'ATLAS_SCENE_SECRET'},
      atlasLayoutRequest: {kind: 'floor', secret: 'LAYOUT_REQ_SECRET'},
      atlasWorldFill: {secret: 'WORLD_FILL_SECRET'},
      atlasLayoutContext: {version: 2, secret: 'LAYOUT_CTX_SECRET'},
      atlasSecretLedger: {secret: 'NEW_NAMESPACE_SECRET', secretId: 'SECRET_ID_42'},
    };
    db.run(`UPDATE maps SET frame_json = ? WHERE branch_id = ? AND id = ?`,
      [JSON.stringify(frame), IDS.branchMain, IDS.M1]);
  };
  await withSnapshot('author', (fixture, source) => {
    assert.deepEqual(source.frames.frame,
      {origin_x: 0, origin_y: 0, reference_width_cells: 120, reference_height_cells: 80},
      '公开 frame 必须是白名单结果');
    const map = exportedMap(fixture);
    assert.deepEqual(map.frame,
      {origin_x: 0, origin_y: 0, reference_width_cells: 120, reference_height_cells: 80},
      '导出 frame 与公开 frame 相等');
    const json = JSON.stringify(map);
    for (const secret of ['ATLAS_SCENE_SECRET', 'LAYOUT_REQ_SECRET', 'WORLD_FILL_SECRET', 'LAYOUT_CTX_SECRET', 'NEW_NAMESPACE_SECRET', 'SECRET_ID_42', 'atlasSecretLedger']) {
      assert.doesNotMatch(json, new RegExp(secret), `导出不得包含内部命名空间内容：${secret}`);
    }
  }, {mutate});
});
