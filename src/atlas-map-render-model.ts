/** Renderer adapter: Atlas uses x-right/y-down cells; CRS.Simple uses latitude-up. */
import type { AtlasTableMapView, AtlasMapViewPoint } from './atlas-table-map-view.ts';
import { buildFloorplan, type Floorplan } from './atlas-floorplan.ts';
import { layoutUnplacedMarkers } from './atlas-map-layout.ts';

export function atlasToSimple(point: { x: number; y: number }): [number, number] {
  return [-point.y, point.x];
}
export function simpleToAtlas(point: { lat: number; lng: number }): { x: number; y: number } {
  return { x: point.lng, y: -point.lat };
}

export interface AtlasRenderScene {
  mapId: string;
  name: string;
  frame: { cols: number; rows: number };
  markers: AtlasMapViewPoint[];
  floorplan: Floorplan | null;
  truncated: number;
}

/** Consumes the existing table projection. No world/table writes and no second presence rules. */
export function buildAtlasRenderScene(input: {
  view: AtlasTableMapView; mapId: string; name: string;
  worldFrame?: { cols: number; rows: number };
}): AtlasRenderScene {
  const { view, mapId, name } = input;
  const map = mapId === 'world' ? view.world : view.submaps[mapId];
  const frame = mapId === 'world' ? input.worldFrame ?? { cols: 100, rows: 100 }
    : view.submaps[mapId]?.frame ?? { cols: 100, rows: 100 };
  const points = (map?.points ?? []).filter(point => mapId !== 'world' || point.kind === 'location');
  const unplaced = view.unplacedLocations.entries.filter(row =>
    row.parentLocationId === (mapId === 'world' ? null : `loc:${mapId}`));
  const floorplan = mapId === 'world' ? null : buildFloorplan({ name, ...frame, children: [
    ...points.filter(point => point.kind === 'location').map(point => ({ id: point.id, name: point.name,
      ...(point.positionQuality === 'confirmed' ? { x: point.x, y: point.y } : {}) })),
    ...unplaced.map(row => ({ id: row.id.replace(/^loc:/, ''), name: row.name })),
  ] });
  const layout = layoutUnplacedMarkers({ branchKey: 'render', mapId, frame,
    confirmed: points.filter(point => point.positionQuality === 'confirmed').map(point => ({ id: point.id, x: point.x, y: point.y })),
    unplaced: unplaced.map(row => ({ ...row, mapId })),
  });
  const markers = points.map(point => ({ ...point }));
  for (const point of layout.displayOnly) {
    const id = point.id.replace(/^loc:/, '');
    const room = floorplan?.markers.find(marker => marker.id === id);
    markers.push({ id, rowId: point.id, name: point.name, kind: 'location', regionId: null,
      x: room?.x ?? point.x, y: room?.y ?? point.y, positionQuality: 'estimated' });
  }
  return { mapId, name, frame: { cols: frame.cols, rows: frame.rows }, markers, floorplan,
    truncated: (map?.truncated ?? 0) + layout.counts.truncated };
}
