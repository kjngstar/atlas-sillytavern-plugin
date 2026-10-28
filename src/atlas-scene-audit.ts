import { queryBound } from './atlas-db-runtime.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import { readActorSceneFacts } from './atlas-scene-facts.ts';
import { resolveSpatialTrait } from './atlas-spatial-facts.ts';
import { detectSceneContradictions } from './atlas-scene-contradictions.ts';
import type { SceneClaimV1, SceneAccessEventV1 } from './atlas-scene-contradictions.ts';
import type { SpatialTraitV1 } from './atlas-spatial-facts.ts';
import { progressId, progressRowMutation } from './atlas-construction-progress.ts';
import type { AtomicGroup } from './atlas-ops-contract.ts';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function row(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  try { const value: unknown = JSON.parse(raw); return object(value) ? value : null; } catch { return null; }
}
const num = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Strictly interior segment intersection; tangency, rotation and missing frames stay unevaluated. */
function crosses(start: number[], end: number[], rect: { x: number; y: number; width: number; height: number }): boolean {
  let lo = 0, hi = 1;
  for (const axis of [0, 1]) {
    const min = axis === 0 ? rect.x : rect.y, max = min + (axis === 0 ? rect.width : rect.height);
    const delta = end[axis] - start[axis];
    if (Math.abs(delta) < 1e-9) { if (start[axis] <= min || start[axis] >= max) return false; continue; }
    const a = (min - start[axis]) / delta, b = (max - start[axis]) / delta;
    lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
  }
  return hi - lo > 1e-6 && lo > 1e-6 && hi < 1 - 1e-6;
}

export function auditSavedSpatialMoves(input: { db: SqlDatabase; beforeDb: SqlDatabase; branchId: string; turnId: string }) {
  const claims: SceneClaimV1[] = [], traits: SpatialTraitV1[] = [];
  const accessEvents: SceneAccessEventV1[] = [];
  for (const change of queryBound(input.db, "SELECT after_json,sequence FROM turn_changes WHERE turn_id=? AND target_table='construction_progress' ORDER BY sequence", [input.turnId])) {
    const saved = row(change['after_json']), fact = row(saved?.['payload_json']);
    if (fact?.['payloadKind'] !== 'world-fact/v1' || typeof fact['subjectId'] !== 'string') continue;
    if (fact['predicate'] === 'opening-state' && fact['value'] === 'open' || fact['predicate'] === 'owner-lock' && fact['value'] === false)
      accessEvents.push({ objectId: fact['subjectId'], kind: fact['predicate'] === 'opening-state' ? 'open' : 'unlock', turnId: input.turnId, sequence: Number(change['sequence']) });
  }
  for (const change of queryBound(input.db, "SELECT before_json,after_json,sequence FROM turn_changes WHERE turn_id=? AND target_table='characters' AND operation='update' ORDER BY sequence", [input.turnId])) {
    const before = row(change['before_json']), after = row(change['after_json']);
    if (!before || !after || before['map_id'] !== after['map_id'] || typeof before['map_id'] !== 'string' || typeof before['location_id'] !== 'string'
      || !num(before['grid_x']) || !num(before['grid_y']) || !num(after['grid_x']) || !num(after['grid_y']) || typeof after['id'] !== 'string') continue;
    const scene = readActorSceneFacts({ db: input.beforeDb, branchId: input.branchId }, { actorId: after['id'], locationId: before['location_id'], position: null, maxObstacles: 64 }).context;
    if (!scene) continue;
    for (const piece of [...scene.entrances, ...scene.blockers]) {
      const geometry = piece.geometry;
      if (!geometry || geometry.mapId !== before['map_id'] || !geometry.width || !geometry.height || geometry.rotation && geometry.rotation !== 0) continue;
      const scale = geometry.units === 'cells' ? 1 : scene.location?.metersPerCell;
      if (!scale) continue;
      const trait = resolveSpatialTrait({ objectId: piece.objectId, kind: piece.kind, ...('locked' in piece ? { locked: piece.locked, openingState: piece.openingState } : {}) });
      if (trait.kind !== 'glass' && !(trait.kind === 'door' && trait.locked === true)) continue;
      if (crosses([before['grid_x'] * scale, before['grid_y'] * scale], [after['grid_x'] * scale, after['grid_y'] * scale], { ...geometry, width: geometry.width, height: geometry.height })) {
        traits.push(trait);
        claims.push({ claimId: `move:${change['sequence']}:${piece.objectId}`, actorId: after['id'], kind: 'pass-through', objectId: piece.objectId,
          sequence: Number(change['sequence']), turnId: input.turnId });
      }
    }
  }
  const result = detectSceneContradictions({ claims, traits, accessEvents });
  const scopeKey = 'scene-contradictions:v1';
  const groups: AtomicGroup[] = result.contradictions.map(finding => {
    const id = progressId('unit', scopeKey, finding.issueId), opId = `scene-audit:${finding.issueId}`;
    return { id: opId, opIds: [], dependsOn: [], readSet: [], purpose: 'bookkeeping', mutations: [progressRowMutation({ branchId: input.branchId, turnId: input.turnId, opId },
      { id, scopeKey, kind: 'unit', subjectKey: finding.issueId }, null, { status: 'processed', inputSignature: finding.issueId, payload: { payloadKind: 'scene-contradiction/v1', ...finding } })] };
  });
  return { ...result, groups };
}
