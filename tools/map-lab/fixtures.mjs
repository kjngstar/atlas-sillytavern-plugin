import { projectTablesToMapView } from '../../src/atlas-table-map-view.ts';

export function createMapLabFixture(crowded = false) {
  const definitions = [
    ['晴川市', null], ['学园街区', 1], ['晴川学校', 2], ['第二教学楼', 3], ['教学楼·二楼', 4],
    ['二年三班教室', 5], ['阅览室', 5], ['办公室', 5], ['实验室', 5], ['休息室', 5], ['器材室', 5],
  ];
  const locations = definitions.map(([name, parent], i) => ({ id: `loc:${i + 1}`, name,
    parentLocationId: parent === null ? null : `loc:${parent}`, mapId: parent === null ? 'world' : `loc:${parent}`,
    gridX: i < 4 ? 35 + i * 8 : null, gridY: i < 4 ? 35 + i * 3 : null,
    description: '', rumors: [], factions: [] }));
  const characters = Array.from({ length: crowded ? 50 : 6 }, (_, i) => ({
    id: `npc:student-${i}`, name: i === 0 ? '林同学' : `同学${i + 1}`, locationId: 'loc:6', presence: 'present',
    thought: '', actionTendency: '', currentAction: i % 2 ? '站在窗边' : '坐在课桌旁',
    targetLocationId: null, positionSource: 'narrative', mapId: crowded ? 'loc:6' : null,
    gridX: crowded ? 6 : null, gridY: crowded ? 4 : null,
  }));
  const maps = { schemaVersion: 2, pointMeta: {}, calibrations: {}, submaps: { '6': {
    parentMapId: '5', frame: { cols: 12, rows: 8, frameRevision: 1 }, points: [] } } };
  const tables = { locations, characters, items: [] };
  return { tables, view: projectTablesToMapView(tables, maps, { points: [], characters: [] }, '6'),
    names: Object.fromEntries([['world', '世界图'], ...locations.map(row => [row.id.slice(4), row.name])]),
    parents: Object.fromEntries(locations.map(row => [row.id.slice(4), row.parentLocationId?.slice(4) ?? 'world'])) };
}
