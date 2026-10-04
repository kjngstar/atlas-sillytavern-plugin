/** Same foreground request construction for submission and the zero-request preview. */
import {buildStagePrompt} from './atlas-ops-prompts.ts';
import {collectEntityRefs,collectKnownRefs} from './atlas-sql-refs.ts';
import type {TableReadPort} from './atlas-ops-compile-types.ts';
import type {TurnInput,Phase} from './atlas-ops-contract.ts';
export function buildSqlForegroundRequest(tables:TableReadPort,branchId:string,input:TurnInput,phase:Phase,turnId:string){
 const known=collectKnownRefs(tables,branchId),entityRefs=collectEntityRefs(tables,branchId);
 const request=buildStagePrompt({phase,assistantSource:input.assistantText,userSource:input.userText,entityRefs,
  geoEntities:entityRefs.join('\n'),mapScope:JSON.stringify(tables.selectWhere('maps',{branch_id:branchId,status:'active'},1000)
   .map(map=>({ref:known.find(ref=>ref.id===map.id)?.alias,name:map.name,frame:map.frame_json,scaleLocked:map.scale_locked}))),
  geoSources:input.assistantText,sourceSnapshot:input.sourceSnapshot,batchId:`${phase}_${turnId}`});
 request.anchor=input.anchor;request.sourceSnapshot=input.sourceSnapshot;
 request.promptInput={injectionText:entityRefs.join('\n'),userText:input.userText,assistantText:input.assistantText,
  loreSupplement:input.sourceSnapshot.filter(source=>source.kind==='lorebook').map(source=>source.text).join('\n'),baseRevision:input.anchor.baseRevision};
 return request;
}
