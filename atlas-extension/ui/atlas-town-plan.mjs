const validPoint = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const validPolygon = points => points?.length >= 3 && points.every(validPoint);
const areaRoles = new Set(['city', 'settlement', 'district', 'campus', 'land', 'mountain', 'ruins']);
const largeBuildingAreaM2 = 300;

function isLargeFootprint(pts, metersPerUnit) {
  if (!(metersPerUnit > 0)) return false;
  const [originX, originY] = pts[0];
  const twiceArea = pts.reduce((sum, [x, y], i) => {
    const [nextX, nextY] = pts[(i + 1) % pts.length];
    return sum + (x - originX) * (nextY - originY) - (y - originY) * (nextX - originX);
  }, 0);
  return Math.abs(twiceArea) * metersPerUnit ** 2 / 2 >= largeBuildingAreaM2;
}

/**
 * Draw a local plan in the saved map frame. Street widths without a measured
 * value are cartographic symbols. All positions and connections come from the
 * projected scene or the registered route geometry.
 */
export function townPlan(node, locations) {
  const g = node.geo;
  if (!['city', 'district'].includes(node.containerLocationKind) || g.localSite) return null;

  const streets = [...(g.townRoutes ?? [])];
  const routeIds = new Set(streets.map(r => r.id));
  const roadIds = new Set((g.avenues ?? []).map(r => r.id));
  const bridges = (g.cityBridges ?? []).filter(b => roadIds.has(b.roadId) && !routeIds.has(b.roadId));
  for (const road of g.avenues ?? []) {
    if (routeIds.has(road.id)) continue;
    streets.push({ ...road, kind: road.kind === 'path' ? 'path' : 'road', points: [road.from, road.to] });
  }

  const terrain = [...(g.cityTerrain ?? [])];
  const parcels = [];
  const shapes = g.overviewShapes ?? [];
  for (const shape of shapes) {
    if (shape.proxy || !validPolygon(shape.pts)) continue;
    if (shape.role === 'water' || shape.role === 'forest') {
      terrain.push({ ...shape, kind: shape.role });
    } else {
      const kind = locations?.get(shape.id)?.entityKind;
      const building = kind === 'building';
      const footprint = building && shape.hasFootprint && isLargeFootprint(shape.pts, node.metric);
      parcels.push({ ...shape, footprint, markerOnly: building ? !footprint : !areaRoles.has(shape.role) });
    }
  }
  if (validPolygon(g.cityRiverArea)) terrain.push({ kind: 'water', river: true, pts: g.cityRiverArea });
  const forestDensities = ['low', 'medium', 'high'];
  for (const feature of g.overviewFeatures ?? []) {
    if (feature.type === 'forest_texture' && validPolygon(feature.poly)) {
      const owner = feature.zoneId ? terrain.findIndex(t => t.id === feature.zoneId &&
        (t.kind === 'forest' || t.kind === 'woods')) : -1;
      if (owner >= 0) {
        // The forest already supplies the outline and click target. Its
        // texture controls tree spacing without adding a second painted area.
        const patch = terrain[owner];
        const current = patch.density ?? (patch.kind === 'woods' ? 'high' : undefined);
        if (forestDensities.indexOf(feature.density) > forestDensities.indexOf(current)) {
          terrain[owner] = { ...patch, density: feature.density };
        }
      } else {
        terrain.push({ kind: 'forest', pts: feature.poly, density: feature.density });
      }
    }
  }
  for (const b of [...(g.cityBuildings ?? []), ...(g.cityBlocks ?? [])]) {
    if (![b.x, b.y, b.w, b.h].every(Number.isFinite) || b.w <= 0 || b.h <= 0) continue;
    const pts = b.pts ?? [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
    const footprint = !b.decorative && !b.proxy && isLargeFootprint(pts, node.metric);
    parcels.push({ ...b, footprint, markerOnly: !footprint, pts });
  }
  const watercourses = (g.overviewFeatures ?? []).filter(f => f.type === 'watercourse' && f.line?.length >= 2);
  if (!validPolygon(g.cityRiverArea) && g.river?.length >= 2 && g.riverWidth > 0) {
    watercourses.push({ line: g.river, width: g.riverWidth });
  }
  const namedParcels = parcels.some(p => !p.decorative);
  if (!streets.length || !(namedParcels || terrain.length || watercourses.length)) return null;

  // Template district cells are allocation envelopes. Named, non-template
  // boundaries still provide useful context and retain their own identity.
  const terrainIds = new Set(terrain.map(p => p.id));
  const namedDistricts = (g.districts ?? []).filter(d => d.id !== node.containerLocationId && !terrainIds.has(d.id));
  const districts = namedDistricts.filter(d => !(g.templateCity || g.streetPattern) || ['confirmed', 'exact'].includes(d.quality));
  const districtLabels = namedDistricts.filter(d => validPoint(d.site));
  const otherRoutes = (g.overviewRoutes ?? []).filter(r => !routeIds.has(r.id));
  return { streets, bridges, terrain, watercourses, parcels, districts, districtLabels, otherRoutes, surface: g.surface };
}
