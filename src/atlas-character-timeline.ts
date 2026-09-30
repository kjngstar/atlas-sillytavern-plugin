import type { AtlasCharacterRow, AtlasThreeTablesV1 } from "./atlas-tables.ts";
import type { AtlasSimulationEvent } from "./atlas-simulation.ts";

/** 作者档案，不进入世界书或正文提示词。每条只描述本轮确实提交的变化。 */
export interface AtlasCharacterTimelineEntry {
  characterId: string;
  name: string;
  period: number;
  kind: "state" | "event" | "correction";
  locationId: string | null;
  locationName: string | null;
  fromLocationId: string | null;
  action: string;
  experience: string;
  positionSource: AtlasCharacterRow["positionSource"] | null;
  visibility: "author";
}

export function buildCharacterTimeline(
  before: AtlasThreeTablesV1 | null,
  after: AtlasThreeTablesV1 | null,
  events: readonly AtlasSimulationEvent[],
  period: number,
): AtlasCharacterTimelineEntry[] {
  const result: AtlasCharacterTimelineEntry[] = [];
  const oldRows = new Map((before?.characters ?? []).map((row) => [row.id, row]));
  const names = new Map((after?.locations ?? before?.locations ?? []).map((row) => [row.id, row.name]));
  const characters = new Map((after?.characters ?? []).map((row) => [row.id, row]));
  for (const row of after?.characters ?? []) {
    const prior = oldRows.get(row.id);
    if (prior && prior.locationId === row.locationId && prior.currentAction === row.currentAction &&
        prior.presence === row.presence && prior.gridX === row.gridX && prior.gridY === row.gridY &&
        prior.mapId === row.mapId) continue;
    result.push({
      characterId: row.id, name: row.name, period, kind: "state",
      locationId: row.locationId, locationName: row.locationId ? names.get(row.locationId) ?? null : null,
      fromLocationId: prior?.locationId ?? null,
      action: row.currentAction.slice(0, 300),
      experience: !prior ? "首次记录" : prior.locationId !== row.locationId ? "位置变化" : "状态变化",
      positionSource: row.positionSource,
      visibility: "author",
    });
  }
  for (const event of events) {
    if (!event.actorCharacterId) continue;
    const row = characters.get(event.actorCharacterId);
    if (!row) continue;
    const locationId = event.toLocationId ?? row.locationId;
    result.push({
      characterId: row.id, name: row.name, period: event.period, kind: "event",
      locationId, locationName: locationId ? names.get(locationId) ?? null : null,
      fromLocationId: event.fromLocationId,
      action: row.currentAction.slice(0, 300), experience: event.summary.slice(0, 500),
      positionSource: row.positionSource, visibility: "author",
    });
  }
  return result;
}
