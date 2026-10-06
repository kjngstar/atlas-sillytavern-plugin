import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { atlasWorkbenchTree, createStarmapShell } from '../ui/atlas-starmap-shell.mjs';

const location = (entityId, name, extra = {}) => ({ entityId, name, kind: 'location', ...extra });
const maps = [
  { mapId: 'map:root', name: '城市地图', containerLocationId: null,
    points: [location('loc:school', '学院'), location('loc:hidden', '秘密入口', { visibility: 'hidden' })] },
  { mapId: 'map:opaque-id', containerLocationId: 'loc:school',
    points: [location('loc:room', '教室')] },
  { mapId: 'map:secret', containerLocationId: 'loc:hidden', points: [location('loc:deep', '隐秘房间')] },
];

test('星幕地图树用地图容器关系导航；主角视图不泄漏隐藏父级和子级', () => {
  const before = JSON.stringify(maps);
  const pov = atlasWorkbenchTree({ sqlItems: maps });
  assert.deepEqual(pov.map(row => row.name), ['城市地图', '学院', '教室']);
  assert.equal(pov[1].entityId, 'loc:school');
  assert.equal(pov[1].mapId, 'map:opaque-id');
  assert.deepEqual(pov[2].parentPath, [{ pointId: 'school', name: '学院' }]);
  assert.equal(pov[2].hasMap, false);
  assert.deepEqual(atlasWorkbenchTree({ sqlItems: maps, viewMode: 'author' }).map(row => row.name),
    ['城市地图', '学院', '教室', '秘密入口', '隐秘房间']);
  assert.equal(JSON.stringify(maps), before, '只读投影不修改源地图');
  assert.deepEqual(atlasWorkbenchTree({ sqlItems: [] }), [], 'SQL 空结果不制造世界图');
});

test('星幕旧地图树拒绝错误父链；环和重复实体不导致无限树', () => {
  const rows = atlasWorkbenchTree({ worldName: '世界', rootPoints: [{ id: '1', name: '学院' }],
    submaps: { '1': { parentMapId: 'world', points: [{ id: '2', name: '教室' }] },
      '2': { parentMapId: 'world', points: [{ id: '3', name: '错误子图' }] } } });
  assert.deepEqual(rows.map(row => row.name), ['世界', '学院', '教室']);
  assert.equal(rows[2].hasMap, false);
  const cycle = atlasWorkbenchTree({ sqlItems: [
    { mapId: 'root', points: [location('x', '入口')] },
    { mapId: 'inside', containerLocationId: 'x', points: [location('x', '循环')] },
  ] });
  assert.equal(cycle.length, 2);
});

test('星幕切聊天和修订清掉地点搜索、旧名单与选择，控件只调用已有操作', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const create = () => document.createElement('div');
    const root = create(), rail = create(), brand = create(), foot = create(), main = create();
    const topbar = create(), topbarLeft = create(), topbarRight = create(), side = create(), center = create();
    const sideChanges = create(), devSlot = create(), moves = create();
    brand.innerHTML = '<span class="aw-brand__mark"></span><span>ATLAS</span>';
    topbar.append(topbarLeft, topbarRight); main.append(topbar, center);
    root.append(rail, main, side); document.body.append(root);
    const calls = [];
    const shell = createStarmapShell({ root, rail, brand, navButtons: new Map(), foot, main,
      topbar, topbarLeft, topbarRight, center, side, sideChanges, devSlot, moves,
      core: { setPage: page => calls.push(page) }, onNavigate: row => calls.push(row.id),
      onSelect: (kind, row) => calls.push(`${kind}:${row.id}`), onCloseDetail: () => calls.push('close'),
      onLocate: () => calls.push('locate'), onViewMode: () => calls.push('view') });
    const state = { chatId: 'chat-a', page: 'map', receipts: [] };
    shell.sync({ revision: 1 }, state);
    shell.updateMap({ sql: true, viewMode: 'pov', tree: atlasWorkbenchTree({ sqlItems: maps }),
      path: [], ownerId: 'world', name: '城市地图', characters: [{ id: 'c1', name: '艾琳' }],
      locations: [], items: [] });
    const search = root.querySelector('[aria-label="搜索已知地点"]');
    search.value = '学院'; search.dispatchEvent(new dom.window.Event('input'));
    assert.equal(root.querySelectorAll('.as-tree-entry').length, 1);
    root.querySelector('.as-tree-entry').click();
    root.querySelector('.as-entity-card').click();
    assert.ok(calls.includes('school'));
    assert.ok(calls.includes('characters:c1'));
    assert.equal(root.querySelector('.as-entity-card').textContent, '艾艾琳当前地图', '名单没有重复的按钮标签');
    shell.sync({ revision: 1 }, { ...state, chatId: 'chat-b' });
    assert.equal(search.value, '');
    assert.equal(root.querySelectorAll('.as-entity-card').length, 0);
    assert.equal(root.querySelectorAll('.as-tree-entry').length, 0);
    assert.equal(root.classList.contains('is-inspector-open'), false);
  } finally { globalThis.document = previous; dom.window.close(); }
});
