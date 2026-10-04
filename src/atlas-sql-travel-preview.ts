/** Route preview uses the same movement rules as settlement, without writing a journey. */
import {startJourney,estimatedArrival} from './atlas-sim-motion.ts';
import {createTableReadPort} from './atlas-db-readport.ts';
import type {SqlSession} from './atlas-sql-session.ts';
export function previewSqlTravel(session:SqlSession,destination:unknown){
 const read=createTableReadPort(session.repo.db),branch=session.repo.internal.branchRow()!;
 const id=String(destination??''),clock=Number(branch.clock_s);
 const planned=startJourney({id:'preview',status:'ready',kind:'travel',actor_entity_id:branch.pov_character_id,
  target_location_id:id,payload_json:{}},{db:session.repo.db,branchId:session.branchId,clockS:clock,turnId:'preview',makeId:()=>'preview'});
 if(!read.selectOne('locations',session.branchId,id)||!planned.journey)return {preview:null,issues:planned.issues,coreSaved:false};
 const arrival=estimatedArrival(planned.journey,clock),segments=JSON.parse(String(planned.journey.segments_json)) as Array<{distanceNominalM?:number|null}>;
 const distance=segments.every(segment=>typeof segment.distanceNominalM==='number')?segments.reduce((n,segment)=>n+segment.distanceNominalM!,0):null;
 if(distance===null||arrival.minS===null||arrival.maxS===null)return {preview:null,reason:'路线未标定或角色移动能力未确定；展示布局不作为实际路程',issues:planned.issues,coreSaved:false};
 return {preview:{destinationId:id,distance,estimatedDuration:(arrival.minS+arrival.maxS)/2-clock,
  distanceUnit:'m',durationUnit:'s',factors:['按已知路线及角色实际移动能力估算']},issues:planned.issues,coreSaved:false};
}
