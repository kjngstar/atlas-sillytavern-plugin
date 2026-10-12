// P01a：buildMapAnalysisExport 公开 frame 来源契约（修复后正向回归）。
// 生产读取链：repository.queryView → UI 投影 → buildMapAnalysisExport。
import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import {makeSeedWith, IDS} from './fixtures/atlas-sql/seed.mjs';
import {createSqlRepository} from '../src/atlas-db-repository.ts';
import {projectReferenceData} from '../ui/atlas-reference-data.mjs';
import {buildMapAnalysisExport} from '../ui/atlas-map-export.mjs';

const SQL = await initSqlJs();
async function withSnapshot(run) {
  const seed = await makeSeedWith(SQL);
  const bytes = seed.exportBytes();
  seed.close();
  const repo = createSqlRepository({
    chatUid: IDS.chatA,
    branchId: IDS.branchMain,
    modelPort: {async request() {throw Error('此测试禁止模型调用');}},
  });
  try {
    await repo.open({bytes});
    const query = kind => repo.queryView({
      kind, branchId: IDS.branchMain, viewMode: 'author',
    });
    const mapView = await query('map');
    const sceneView = await query('scene');
    const catalogView = await query('catalog');
    const data = projectReferenceData({
      mapView, sceneView, catalogView, viewMode: 'author',
    });
    const fixture = {
      data, mapView, sceneView, catalogView, mapId: IDS.M1,
      exportedAt: '2026-10-11T00:00:00Z',
    };
    const source = mapView.items.find(m => m.mapId === IDS.M1);
    assert.ok(source, '夹具必须包含真实世界地图');
    assert.ok(Object.hasOwn(source.frames, 'frame'), '真实 DTO 必须提供 frames.frame');
    assert.ok(source.frames.frame, '基线夹具的公开 frame 必须有值');
    await run(fixture, source);
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

test('P01A-01 真实查询链保留 frames.frame 且导出不共享输入对象', async () => {
  await withSnapshot((fixture, source) => {
    const before = structuredClone(source.frames.frame);
    const output = exportedMap(fixture);
    assert.deepEqual(output.frame, before);
    output.frame.reference_width_cells = 9999;
    assert.deepEqual(source.frames.frame, before);
  });
});
test('P01A-02 frames.frame 显式 null 时禁止回退顶层 frame', async () => {
  await withSnapshot((fixture, source) => {
    source.frames.frame = null;
    source.frame = {reference_width_cells: 9999, legacyLeak: 'forbidden'};
    const output = exportedMap(fixture);
    assert.equal(output.frame, null);
    assert.doesNotMatch(JSON.stringify(output.frame), /legacyLeak|forbidden/);
    assert.equal(source.frame.legacyLeak, 'forbidden');
  });
});
test('P01A-03 仅缺少 frames.frame 键时接受旧 DTO 的顶层 frame', async () => {
  await withSnapshot((fixture, source) => {
    delete source.frames.frame;
    source.frame = {origin_x: 0, origin_y: 0, reference_width_cells: 17, reference_height_cells: 19};
    assert.deepEqual(exportedMap(fixture).frame, source.frame);
  });
});
test('P01A-04 新旧来源均缺失时保持 null 不从渲染信息反推', async () => {
  await withSnapshot((fixture, source) => {
    delete source.frames.frame;
    delete source.frame;
    assert.equal(exportedMap(fixture).frame, null);
  });
});
test('P01A-05 frames.frame 拥有键但值为 undefined 时禁止旧字段回退', async () => {
  await withSnapshot((fixture, source) => {
    source.frames.frame = undefined;
    source.frame = {reference_width_cells: 9999, legacyLeak: 'forbidden'};
    assert.equal(exportedMap(fixture).frame, null);
  });
});
