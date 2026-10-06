import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleWorkbenchMaps, workbenchMapPath, workbenchEntity } from '../ui/atlas-workbench-data.mjs';
import { createWorkbenchMapController } from '../ui/atlas-map-controller.mjs';

const maps = [
  { mapId: 'world', points: [{ kind: 'location', entityId: 'loc:house', hidden: true }] },
  { mapId: 'house', containerLocationId: 'loc:house', name: '建筑', points: [{ kind: 'location', entityId: 'loc:floor' }] },
  { mapId: 'floor', containerLocationId: 'loc:floor', name: '楼层', points: [] },
];
test('地图导航保留祖先链并转换 SQL 地点引用；循环不能进入', () => {
  assert.deepEqual(workbenchMapPath(maps, 'floor'), [{ pointId: 'house', name: '建筑' }, { pointId: 'floor', name: '楼层' }]);
  assert.deepEqual(workbenchMapPath(maps, 'world'), []);
  assert.equal(workbenchMapPath(maps, 'missing'), null);
  assert.equal(workbenchMapPath([{ mapId: 'x', containerLocationId: 'loc:x', points: [{ kind: 'location', entityId: 'loc:x' }] }], 'x'), null);
});
test('POV 地图树过滤未知容器及所有后代，author 保留完整树', () => {
  assert.equal(visibleWorkbenchMaps(maps, 'author').length, 3);
  assert.deepEqual(visibleWorkbenchMaps(maps, 'pov').map(row => row.mapId), ['world']);
  const known = structuredClone(maps); known[0].points[0].hidden = false;
  assert.equal(visibleWorkbenchMaps(known, 'pov').length, 3);
});
test('正式详情提供子地图、人物库存和名字；空查询不沿用旧对象', () => {
  const detail = workbenchEntity({ kind: 'location', location: { id: 'loc:house', name: '建筑' }, children: [], childMaps: [{ mapId: 'house' }] });
  assert.equal(detail.name, '建筑'); assert.equal(detail.childMaps[0].mapId, 'house');
  assert.equal(workbenchEntity({ kind: 'character', character: { id: 'npc:1', name: '人物' }, heldItems: [{ id: 'item:1' }] }).heldItems.length, 1);
  assert.equal(workbenchEntity(null), null);
});
test('切作用域立即清图并拒绝迟到结果；空图不得保留上个聊天', async () => {
  const drawn = [], pending = [];
  const renderer = { state: {}, setScene(scene) { drawn.push(scene); return true; }, destroy() {} };
  const controller = createWorkbenchMapController({ canvas: {}, createRenderer: () => renderer,
    projectors: { projectMapView: ({ scope }) => ({ ok: true, status: 'ready', scene: { mapId: 'world', chatId: scope.chatId } }) },
    queryView: (kind, query) => query.branchId === 'slow' ? new Promise(resolve => { pending.push(resolve); }) : Promise.resolve({ revision: 1, items: [] }) });
  const a = { chatId: 'A', branchId: 'main', revision: 1, viewMode: 'author' };
  await controller.showMap(a, 'world');
  const late = controller.showMap({ ...a, branchId: 'slow' }, 'world');
  assert.equal(drawn.at(-1), null);
  // A pending batch is invalidated even before another fetch completes.
  controller.invalidate(); controller.destroy();
  pending.forEach(resolve => resolve({ revision: 1, items: [] }));
  await late;
  assert.equal(drawn.at(-1), null);
});

test('A→B→A 不接受第一代 A 的迟到地图，拒绝坏场景的 false 返回值', async () => {
  const drawn = [], pending = []; let slow = false, reject = false;
  const renderer = { state: {}, setScene(scene) { if (scene && reject) return false; drawn.push(scene); return true; }, destroy() {} };
  const controller = createWorkbenchMapController({ canvas: {}, createRenderer: () => renderer,
    projectors: { projectMapView: ({ scope }) => ({ ok: true, status: 'ready', scene: { chatId: scope.chatId } }) },
    queryView: () => slow ? new Promise(resolve => pending.push(resolve)) : Promise.resolve({ revision: 1, items: [] }) });
  const a = { chatId: 'A', branchId: 'main', revision: 1, viewMode: 'author' };
  await controller.showMap(a, 'world'); slow = true;
  const old = controller.showMap(a, 'world'); slow = false;
  await controller.showMap({ ...a, chatId: 'B' }, 'world');
  await controller.showMap(a, 'world');
  const count = drawn.length;
  pending.forEach(resolve => resolve({ revision: 1, items: [] })); await old;
  assert.equal(drawn.length, count); assert.equal(drawn.at(-1).chatId, 'A');
  reject = true;
  assert.equal((await controller.showMap({ ...a, viewMode: 'pov' }, 'world')).status, 'invalid');
  assert.equal(drawn.at(-1), null); controller.destroy();
});
