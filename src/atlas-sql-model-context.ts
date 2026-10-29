/** Same foreground request construction for submission and the zero-request preview. */
import {buildStagePrompt} from './atlas-ops-prompts.ts';
import {collectEntityRefs,collectKnownRefs} from './atlas-sql-refs.ts';
import type {KnownRef} from './atlas-sql-refs.ts';
import type {TableReadPort} from './atlas-ops-compile-types.ts';
import type {TurnInput,Phase} from './atlas-ops-contract.ts';
import {normalizeFrame} from './atlas-spatial-frame.ts';
/**
 * P08/R05：提示词目录与编译目录必须是**同一份**。
 *
 * 旧实现里本函数自己 `collectKnownRefs` 一遍，repository 编译时又收集一遍；
 * 两遍扫描之间只要有写入或不同的必要引用集合，模型看到的 alias 和编译器理解的 alias
 * 就会指向不同的实体（R05 的根因之一，只改提示词目录修不好）。
 *
 * 因此 `frozenRefs` 由调用方（repository 的同一个候选快照）算好传入；
 * 只有独立调用本函数（如测试、预览脚本）时才回退到自行扫描。
 */
export function buildSqlForegroundRequest(tables:TableReadPort,branchId:string,input:TurnInput,phase:Phase,turnId:string,frozenRefs?:readonly KnownRef[]){
 const known:KnownRef[]=frozenRefs?[...frozenRefs]:collectKnownRefs(tables,branchId,{requiredRefs:input.requiredRefs});
 const entityRefs=collectEntityRefs(tables,branchId,known);
 const request=buildStagePrompt({phase,assistantSource:input.assistantText,userSource:input.userText,entityRefs,
  geoEntities:entityRefs.join('\n'),mapScope:JSON.stringify(tables.selectWhere('maps',{branch_id:branchId,status:'active'},1000)
   .map(map=>{const frame=normalizeFrame(map.frame_json);return {ref:known.find(ref=>ref.id===map.id)?.alias,name:map.name,
     frame:{cols:frame.cols,rows:frame.rows},metersPerCell:map.meters_per_cell,scaleQuality:map.scale_quality,scaleLocked:map.scale_locked};})),
  geoSources:input.assistantText,sourceSnapshot:input.sourceSnapshot,batchId:`${phase}_${turnId}`});
 request.anchor=input.anchor;request.sourceSnapshot=input.sourceSnapshot;
 request.promptInput={injectionText:entityRefs.join('\n'),userText:input.userText,assistantText:input.assistantText,
  loreSupplement:input.sourceSnapshot.filter(source=>source.kind==='lorebook').map(source=>source.text).join('\n'),baseRevision:input.anchor.baseRevision};
 return request;
}
