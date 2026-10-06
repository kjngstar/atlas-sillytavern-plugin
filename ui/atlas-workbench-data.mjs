/** Adapt read-only SQL DTOs for the workbench. No world mutations. */
export function visibleWorkbenchMaps(items, viewMode) {
  const rows = Array.isArray(items) ? items : [];
  if (viewMode !== 'pov') return rows;
  const kept = new Set(rows.filter(row => !row.containerLocationId).map(row => String(row.mapId)));
  for (let pass = 0; pass < rows.length; pass += 1) {
    const visible = new Set(rows.filter(row => kept.has(String(row.mapId))).flatMap(row =>
      (row.points ?? []).filter(point => point.kind === 'location' && point.hidden !== true).map(point => String(point.entityId))));
    let added = false;
    for (const row of rows) if (!kept.has(String(row.mapId)) && visible.has(String(row.containerLocationId))) {
      kept.add(String(row.mapId)); added = true;
    }
    if (!added) break;
  }
  return rows.filter(row => kept.has(String(row.mapId)));
}

/** Full ancestry in the legacy navigation stack's point-ID convention. */
export function workbenchMapPath(items, mapId) {
  const byId = new Map((items ?? []).map(row => [String(row.mapId), row]));
  const owners = new Map();
  for (const row of items ?? []) for (const point of row.points ?? []) {
    if (point.kind === 'location') owners.set(String(point.entityId), String(row.mapId));
  }
  const path = [], seen = new Set();
  let row = byId.get(String(mapId));
  if (!row) return null;
  while (row?.containerLocationId) {
    const id = String(row.mapId);
    if (seen.has(id) || path.length >= 16) return null;
    seen.add(id);
    const container = String(row.containerLocationId);
    path.unshift({ pointId: container.replace(/^loc:/, ''), name: String(row.name ?? '') });
    row = byId.get(owners.get(container));
    if (!row) return null;
  }
  return path;
}

export function workbenchEntity(detail) {
  if (!detail) return null;
  const kind = detail.kind;
  const row = detail.character ?? detail.location ?? detail.item ?? detail.faction;
  if (!row?.id) return null;
  return {
    ...row, kind, id: String(row.id), name: String(row.name ?? ''),
    mapId: detail.position?.mapId ?? row.map_id ?? null,
    locationId: row.location_id ?? null,
    childLocations: detail.children ?? [], childMaps: detail.childMaps ?? [],
    present: detail.present ?? [], groundItems: detail.groundItems ?? [], heldItems: detail.heldItems ?? [],
    actions: detail.actions ?? [], journeys: detail.journeys ?? [], knowledge: detail.knowledge ?? [],
    thoughts: row.thought ? [{ content: row.thought }] : [],
    description: row.description ?? row.summary ?? '',
  };
}
