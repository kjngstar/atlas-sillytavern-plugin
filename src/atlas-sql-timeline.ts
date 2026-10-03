/** Paginated author history from the same branch journal, including background consequences. */
import { queryBound, AtlasDbError } from './atlas-db-runtime.ts';
import type { ViewContext } from './atlas-db-views.ts';

export function querySqlCharacterTimeline(ctx:ViewContext,input:{characterId:string;offset?:number;limit?:number}) {
  const id=input.characterId.replace(/^npc:/,''), branchId=ctx.branchId;
  const character=queryBound(ctx.db,'SELECT name FROM characters WHERE branch_id=? AND id=?',[branchId,id])[0];
  if(!character)throw new AtlasDbError('REF_UNKNOWN','人物档案不存在',{});
  const offset=Number.isFinite(input.offset??0)?Math.max(0,Math.trunc(input.offset??0)):0;
  const limit=Number.isFinite(input.limit??25)?Math.max(1,Math.min(100,Math.trunc(input.limit??25))):25;
  const where=`t.branch_id=? AND t.status IN ('committed','partial')
    AND NOT EXISTS(SELECT 1 FROM turn_changes later WHERE later.turn_id=tc.turn_id AND later.target_table=tc.target_table AND later.target_row_id=tc.target_row_id AND later.sequence>tc.sequence)
    AND (
    (tc.target_table='characters' AND tc.target_row_id=?) OR
    json_extract(COALESCE(tc.after_json,tc.before_json),'$.actor_entity_id')=? OR
    json_extract(COALESCE(tc.after_json,tc.before_json),'$.mover_entity_id')=? OR
    json_extract(COALESCE(tc.after_json,tc.before_json),'$.knower_character_id')=? OR
    (tc.target_table='events' AND (json_extract(COALESCE(tc.after_json,tc.before_json),'$.subject_entity_id')=? OR
      json_extract(COALESCE(tc.after_json,tc.before_json),'$.cause_action_id') IN (SELECT id FROM actions WHERE branch_id=? AND actor_entity_id=?) OR
      EXISTS(SELECT 1 FROM json_each(json_extract(COALESCE(tc.after_json,tc.before_json),'$.participants_json')) participant WHERE json_extract(participant.value,'$.entity_id')=?))))`;
  const params=[branchId,id,id,id,id,id,branchId,id,id];
  const total=Number(queryBound(ctx.db,`SELECT COUNT(*) AS n FROM turn_changes tc JOIN turns t ON t.id=tc.turn_id WHERE ${where}`,params)[0].n);
  const records=queryBound(ctx.db,`SELECT tc.*,t.clock_before_s,t.clock_after_s FROM turn_changes tc JOIN turns t ON t.id=tc.turn_id WHERE ${where}
    ORDER BY COALESCE(json_extract(COALESCE(tc.after_json,tc.before_json),'$.occurred_at_s'),json_extract(COALESCE(tc.after_json,tc.before_json),'$.last_advanced_at_s'),json_extract(COALESCE(tc.after_json,tc.before_json),'$.evaluated_until_s'),t.clock_after_s) DESC,t.created_wall_ms DESC,tc.sequence DESC LIMIT ? OFFSET ?`,[...params,limit,offset]);
  const entries=records.map(record=>{
    const row=JSON.parse(String(record.after_json??record.before_json??'{}'));
    const locationId=row.location_id??row.stop_location_id??row.target_location_id??null;
    const location=locationId?queryBound(ctx.db,'SELECT name FROM locations WHERE branch_id=? AND id=?',[branchId,String(locationId)])[0]:null;
    const atS=row.occurred_at_s??row.last_advanced_at_s??row.evaluated_until_s??record.clock_after_s;
    return {id:String(record.id),characterId:id,name:String(character.name),period:Number(atS),atS:Number(atS),
      clockBeforeS:Number(record.clock_before_s),clockAfterS:Number(record.clock_after_s),locationId,locationName:location?.name??null,
      action:String(row.action_tendency??row.title??''),experience:String(record.summary??''),turnId:record.turn_id,
      sourceTable:record.target_table,position:{mapId:row.map_id??null,x:row.grid_x??null,y:row.grid_y??null}};
  });
  return {branchId,revision:ctx.revision,entries,total,offset,limit,nextOffset:offset+entries.length<total?offset+entries.length:null};
}
