/**
 * atlas-table-map-view-p3.test.mjs — P3-05
 *
 * 验证 projectTablesToMapView 输出含 positionQuality 字段:
 *  - confirmed:可信坐标(gridX/Y 都是有限非负数)
 *  - unknown:缺坐标时不进 world.points
 *  - 子地点在父地图或合适子地图,不在错误层级
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTablesToMapView } from '../src/atlas-table-map-view.ts';

function loc(id, name, parentLocationId = null, gridX = 0, gridY = 0) {
  return {
    id: `loc:${id}`, name, parentLocationId,
    description: '', rumors: [], factions: [],
    mapId: 'world', gridX, gridY,
  };
}
function char(id, name, locationId, presence = 'present') {
  return {
    id: `npc:${id}`, name, locationId,
    thought: '', actionTendency: '', currentAction: '',
    targetLocationId: null,
    presence, positionSource: 'narrative',
    mapId: 'world', gridX: 10, gridY: 10,
  };
}
function item(id, name, locationId = null, holderCharacterId = null, gridX = 10, gridY = 10) {
  return {
    id, name, description: '',
    locationId, holderCharacterId,
    status: 'normal',
    mapId: 'world', gridX, gridY,
  };
}

function emptyTables() {
  return { locations: [], characters: [], items: [] };
}

test('P3-05a 有可信坐标的地点 → confirmed', () => {
  const tables = emptyTables();
  tables.locations = [loc('1', '地点A')];
  const view = projectTablesToMapView(tables, null, { id: 'w', mapId: 'world', points: [] }, 'loc:1');
  const pt = view.world.points.find((p) => p.id === '1');
  assert.ok(pt);
  assert.equal(pt.positionQuality, 'confirmed');
});

test('P3-05b 缺坐标的地点不进 world.points', () => {
  const tables = emptyTables();
  tables.locations = [loc('1', '已知点', null, 0, 0), loc('2', '未知点', null, null, null)];
  const view = projectTablesToMapView(tables, null, { id: 'w', mapId: 'world', points: [] }, null);
  const ids = view.world.points.map((p) => p.id);
  assert.ok(ids.includes('1'));
  assert.ok(!ids.includes('2'));
  // 缺坐标的地点进 unplacedLocations(待定位地点名单),
  // 不是 unknownPosition(后者是「在已知地点但无细坐标」的人物/物品名单)。
  const u = view.unplacedLocations.entries.find((e) => e.id === 'loc:2');
  assert.ok(u, '未知坐标地点应进 unplacedLocations');
  assert.equal(u.name, '未知点');
});

test('P3-05c 角色有可信坐标 → confirmed 出现在父地图', () => {
  const tables = emptyTables();
  tables.locations = [loc('1', '城A', null, 5, 5)];
  tables.characters = [char('1', '甲', 'loc:1')];
  const view = projectTablesToMapView(tables, null, { id: 'w', mapId: 'world', points: [] }, 'loc:1');
  const npc = view.world.points.find((p) => p.kind === 'character');
  assert.ok(npc);
  assert.equal(npc.positionQuality, 'confirmed');
});

test('P3-05d 物品有可信坐标 → confirmed 出现在父地图', () => {
  const tables = emptyTables();
  tables.locations = [loc('1', '城A', null, 5, 5)];
  tables.items = [item('I1', '纸条', 'loc:1')];
  const view = projectTablesToMapView(tables, null, { id: 'w', mapId: 'world', points: [] }, 'loc:1');
  const obj = view.world.points.find((p) => p.kind === 'item');
  assert.ok(obj);
  assert.equal(obj.positionQuality, 'confirmed');
});