import { queryBound } from './atlas-db-runtime.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import { collectConfirmedSceneEntries } from './atlas-scene-entry.ts';
import type { ConfirmedSceneEntryV1, SceneEntryEventV1, ScenePositionChangeV1 } from './atlas-scene-entry.ts';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => typeof value === 'string' ? value : '';
function decoded(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  try { const value: unknown = JSON.parse(raw); return object(value) ? value : null; } catch { return null; }
}

/** Only committed story journals plus occurred events can activate an interior. */
export function readConfirmedSceneEntries(db: SqlDatabase, branchId: string): ConfirmedSceneEntryV1[] {
  const changes: ScenePositionChangeV1[] = [];
  const events: SceneEntryEventV1[] = [];
  const saved = new Set<string>();
  const rows = queryBound(db, `SELECT tc.turn_id,tc.before_json,tc.after_json FROM turn_changes tc JOIN turns t ON t.id=tc.turn_id
    WHERE t.branch_id=? AND t.status IN ('committed','partial') AND t.committed_revision IS NOT NULL AND tc.target_table='characters' AND tc.operation='update' ORDER BY t.rowid,tc.sequence`, [branchId]);
  for (const row of rows) {
    const before = decoded(row['before_json']), after = decoded(row['after_json']);
    const actorId = text(after?.['id']), locationId = text(after?.['location_id']), turnId = text(row['turn_id']);
    if (!actorId || !locationId || before?.['location_id'] === locationId) continue;
    const map = queryBound(db, "SELECT id FROM maps WHERE branch_id=? AND container_location_id=? AND kind='interior' AND status='active' ORDER BY id", [branchId, locationId])[0];
    const mapId = text(map?.['id']);
    if (!mapId) continue;
    const occurred = queryBound(db, "SELECT * FROM events WHERE branch_id=? AND created_turn_id=? AND location_id=? AND kind IN ('arrival','passage') AND status='occurred'", [branchId, turnId, locationId]);
    for (const event of occurred) {
      let participants: unknown = []; try { participants = JSON.parse(text(event['participants_json'])); } catch { continue; }
      if (event['subject_entity_id'] !== actorId && (!Array.isArray(participants) || !participants.includes(actorId))) continue;
      changes.push({ actorId, turnId, previousLocationId: text(before?.['location_id']) || null, locationId, compiled: true, kind: 'moved', interiorMapId: mapId });
      events.push({ eventId: text(event['id']), actorId, turnId, fromLocationId: text(before?.['location_id']) || null, toLocationId: locationId,
        type: text(event['kind']), occurredAtS: Number(event['occurred_at_s']), confirmed: true });
      saved.add(turnId);
    }
  }
  const protagonist = queryBound(db, "SELECT id FROM characters WHERE branch_id=? AND role='protagonist' AND status='active' ORDER BY id", [branchId]);
  return collectConfirmedSceneEntries({ events, positionChanges: changes, savedFloorIds: [...saved], protagonistId: protagonist.length === 1 ? text(protagonist[0]['id']) : null }).entries;
}
