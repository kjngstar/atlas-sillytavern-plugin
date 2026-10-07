/** Focused spatial task, built after the floor's actual entities and maps exist. */
import {createTableReadPort} from './atlas-db-readport.ts';
import {collectKnownRefs} from './atlas-sql-refs.ts';
import {buildStagePrompt} from './atlas-ops-prompts.ts';
import type {SqlDatabase} from './atlas-db-runtime.ts';
import type {TurnInput} from './atlas-ops-contract.ts';

export function buildSqlLayoutTask(db:SqlDatabase,branchId:string,input:TurnInput,turnId:string){
 const tables=createTableReadPort(db),known=collectKnownRefs(tables,branchId);
 const locations=tables.selectWhere('locations',{branch_id:branchId,status:'active'},1000);
 const characters=tables.selectWhere('characters',{branch_id:branchId,status:'active'},1000);
 const maps=tables.selectWhere('maps',{branch_id:branchId,status:'active'},1000);
 const ref=(id:unknown)=>known.find(r=>r.id===id)?.alias;
 const eligible=maps.filter(m=>m.container_location_id&&locations.some(l=>l.id===m.container_location_id&&['city','district','building','vehicle','room'].includes(String(l.kind))));
 const occupied=new Set(characters.map(c=>c.location_id));
 const chosen=(input.layoutMaps==='active'?eligible.filter(m=>occupied.has(m.container_location_id)).sort((a,b)=>String(a.id).localeCompare(String(b.id))):eligible.filter(m=>input.layoutMaps?.includes(String(m.id)))).slice(0,2);
 if(!chosen.length)return null;
 const scopes=chosen.map(m=>{
  const container=locations.find(l=>l.id===m.container_location_id)!;
  const kind=['city','district'].includes(String(container.kind))?'city':'floor';
  const frame=m.frame_json as Record<string,unknown>,scene=frame.atlasScene as Record<string,unknown>|undefined;
  const own=locations.filter(l=>l.map_id===m.id);
  const local=kind==='floor'&&container.kind==='room'?[container]:own;
  return {map:ref(m.id),name:m.name,kind,container:{ref:ref(container.id),kind:container.kind,name:container.name},
   frame:{cols:frame.cols,rows:frame.rows,metersPerCell:m.meters_per_cell,scaleLocked:!!m.scale_locked},
   locations:local.map(l=>({ref:ref(l.id),name:l.name,kind:l.kind,parent:ref(l.parent_location_id)})),
   actors:characters.filter(c=>local.some(l=>l.id===c.location_id)).map(c=>({ref:ref(c.id),name:c.name,roomId:ref(c.location_id)})),
   savedConstraints:scene?.constraints??null};
 });
 const request=buildStagePrompt({phase:'geography',allowedOps:['map.layout.request','noop'],batchId:`layout_${turnId}`,
  mapScope:JSON.stringify(scopes),geoMissing:'必须为以上地图生成或更新可绘制空间布局，每张图一行 map.layout.request。仅有坐标点不算完成。',
  geoSources:input.assistantText,sourceSnapshot:input.sourceSnapshot,
  mapLayoutIds:known.map(r=>`${r.alias}=${r.id}`).join('\n'),
  mapLayoutFrame:'width/height 为估计米数；未标定时必须与 cols:rows 成比例。floor 通常 12×8 或 24×24，city 至少 900×700。已有尺度使用 cols*metersPerCell、rows*metersPerCell。',
  mapLayoutLocks:'保留 savedConstraints 的既有结构；新增陈设只用正文提到的实物，尺寸可以合理估计并在 why 说明。没有河流依据时 riverWidth=0。',
 });
 request.messages[1].content+='\n布局字段：floor rooms=[{id:地点引用,name,w,h,side:"north"或"south"}]；contents=[{id:"本图局部陈设ID",name,type:"bench"/"shelf"/"desk"/"reading"/"stairs",roomId:房间引用,w,h}]；actors=[{id:人物引用,roomId:房间引用,near:可选陈设ID}]。单独房间用 container.ref 作为唯一 rooms.id，房间尺寸应小于幅面；楼层或载具使用已提供子房间，不新增地点。city districts=[{id:地点引用,name,bank:"west"或"east",order:整数}]，buildings=[{id:地点引用,name,districtId:地块引用,w,h}]；没有已登记街区时允许用城市 container.ref 表示整个城市的单个范围；有河道才给 riverWidth 正数。不要输出其他操作。';
 request.anchor=input.anchor;
 request.promptInput={injectionText:request.messages[1].content,userText:input.userText,assistantText:input.assistantText,
  loreSupplement:input.sourceSnapshot.filter(s=>s.kind==='lorebook').map(s=>s.text).join('\n'),baseRevision:input.anchor.baseRevision};
 return {request,mapIds:chosen.map(m=>String(m.id))};
}
