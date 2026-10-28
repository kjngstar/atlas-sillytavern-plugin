import { AtlasDbError } from './atlas-db-runtime.ts';
import { readProgressRows } from './atlas-construction-progress.ts';
import { createTableReadPort } from './atlas-db-readport.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import { SCENE_CONTRADICTION_CODES } from './atlas-scene-contradictions.ts';
import type { SceneContradictionV1 } from './atlas-scene-contradictions.ts';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function readSceneContradictions(db: SqlDatabase, branchId: string): SceneContradictionV1[] {
  return readProgressRows(createTableReadPort(db), branchId).filter(row => row.payload['payloadKind'] === 'scene-contradiction/v1').map(row => {
    const value = row.payload;
    const code = SCENE_CONTRADICTION_CODES.find(code => code === value['code']);
    if (value['version'] !== 1 || !code || typeof value['issueId'] !== 'string' || typeof value['actorId'] !== 'string'
      || typeof value['turnId'] !== 'string' || typeof value['message'] !== 'string' || !object(value['evidence'])
      || value['objectId'] !== null && typeof value['objectId'] !== 'string' || value['eventId'] !== null && typeof value['eventId'] !== 'string')
      throw new AtlasDbError('SCENE_CONTRADICTION_INVALID', '空间矛盾记录损坏，不能当成没有问题', {});
    return { version: 1, code, issueId: value['issueId'], actorId: value['actorId'], turnId: value['turnId'], message: value['message'], evidence: value['evidence'], objectId: value['objectId'], eventId: value['eventId'] };
  });
}
