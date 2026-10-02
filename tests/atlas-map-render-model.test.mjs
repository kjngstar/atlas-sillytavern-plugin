import test from 'node:test';
import assert from 'node:assert/strict';
import { atlasToSimple, simpleToAtlas, buildAtlasRenderScene } from '../src/atlas-map-render-model.ts';
import { projectTablesToMapView } from '../src/atlas-table-map-view.ts';

const location = (id, name, parent, x = null, y = null) => ({ id: `loc:${id}`, name,
  parentLocationId: parent === null ? null : `loc:${parent}`, mapId: parent === null ? 'world' : `loc:${parent}`,
  gridX: x, gridY: y, description: '', rumors: [], factions: [] });
const character = (id, presence = 'present') => ({ id: `npc:${id}`, name: `人物${id}`, locationId: 'loc:2',
  thought: '', actionTendency: '', currentAction: '窗边', targetLocationId: null, presence,
  positionSource: 'narrative', mapId: null, gridX: null, gridY: null });
const maps = { schemaVersion: 2, pointMeta: {}, calibrations: {}, submaps: { '2': {
  parentMapId: '1', frame: { cols: 12, rows: 8, frameRevision: 1 }, points: [] } } };

test('CRS.Simple adapter preserves fractional, negative and large cell coordinates, y-down orientation', () => {
  for (const point of [{ x: 0, y: 0 }, { x: 3.25, y: 7.5 }, { x: -11, y: -4 }, { x: 100000, y: 50000 }]) {
    const [lat, lng] = atlasToSimple(point);
    assert.deepEqual(simpleToAtlas({ lat, lng }), point);
  }
  assert.ok(atlasToSimple({ x: 0, y: 8 })[0] < atlasToSimple({ x: 0, y: 2 })[0]);
});
test('renderer consumes one projection: 50 room characters, departed hidden, actual 12×8 frame, source unchanged', () => {
  const tables = { locations: [location(1, '教学楼', null, 20, 20), location(2, '教室', 1)],
    characters: [...Array.from({ length: 50 }, (_, i) => character(i)), character('left', 'left')], items: [] };
  const original = structuredClone(tables);
  const view = projectTablesToMapView(tables, maps, { points: [], characters: [] }, '2');
  const before = structuredClone(view);
  const scene = buildAtlasRenderScene({ view, mapId: '2', name: '教室' });
  assert.equal(scene.markers.length, 50);
  assert.deepEqual(scene.frame, { cols: 12, rows: 8 });
  assert.ok(scene.markers.every(point => point.x > 0 && point.x < 12 && point.y > 0 && point.y < 8));
  assert.equal(new Set(scene.markers.map(point => `${point.x}|${point.y}`)).size, 50);
  assert.deepEqual(view, before);
  assert.deepEqual(tables, original);
});
test('known and unplaced rooms share architectural regions; world and parent floor exclude room character pins', () => {
  const tables = { locations: [location(1, '教学楼', null, 20, 20), location(2, '教室', 1), location(3, '阅览室', 1, 70, 40)],
    characters: [character('one')], items: [] };
  const view = projectTablesToMapView(tables, maps, { points: [], characters: [] }, '2');
  const building = buildAtlasRenderScene({ view, mapId: '1', name: '教学楼' });
  assert.equal(building.markers.length, 2);
  for (const marker of building.markers) {
    const region = building.floorplan.regions.find(area => area.childId === marker.id);
    assert.ok(marker.x > region.x && marker.x < region.x + region.width);
    assert.ok(marker.y > region.y && marker.y < region.y + region.height);
  }
  assert.equal(building.markers.find(point => point.id === '3').x, 70);
  assert.equal(buildAtlasRenderScene({ view, mapId: 'world', name: '世界图' }).markers.length, 1);
});
test('rebuilding after rollback consumes restored projection without stale room geometry', () => {
  const base = { locations: [location(1, '教学楼', null, 20, 20)], characters: [], items: [] };
  const view = tables => projectTablesToMapView(tables, maps, { points: [], characters: [] }, '1');
  const before = buildAtlasRenderScene({ view: view(base), mapId: '1', name: '教学楼' });
  const extended = buildAtlasRenderScene({ view: view({ ...base, locations: [...base.locations, location(2, '教室', 1)] }), mapId: '1', name: '教学楼' });
  assert.equal(extended.markers.length, 1);
  assert.deepEqual(buildAtlasRenderScene({ view: view(base), mapId: '1', name: '教学楼' }), before);
});
