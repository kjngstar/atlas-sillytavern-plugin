import { queryBound } from './atlas-db-runtime.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';

/** Evidence belongs to this saved turn, never to a scene left over from an older turn. */
export function savedTurnHasScene(db: SqlDatabase, turnId: string, mapId?: string): boolean {
  const rows=queryBound(db,"SELECT before_json,after_json FROM turn_changes WHERE turn_id=? AND target_table='maps'"+(mapId?' AND target_row_id=?':''),mapId?[turnId,mapId]:[turnId]);
  const scene=(raw:unknown):unknown=>{
    if(typeof raw!=='string')return null;
    const row=JSON.parse(raw),frame=typeof row.frame_json==='string'?JSON.parse(row.frame_json):row.frame_json;
    return frame?.atlasScene??null;
  };
  return rows.some(row=>{
    const after=scene(row.after_json);
    return !!after&&JSON.stringify(after)!==JSON.stringify(scene(row.before_json));
  });
}

export function mapReceiptOperation(hostMessageUid: unknown): 'layout'|'build'|null {
  if(typeof hostMessageUid!=='string')return null;
  if(/^author:map\/layout:/.test(hostMessageUid))return 'layout';
  if(/^author:map\/(?:build|bootstrap)(?:\/continue)?:/.test(hostMessageUid))return 'build';
  return null;
}
