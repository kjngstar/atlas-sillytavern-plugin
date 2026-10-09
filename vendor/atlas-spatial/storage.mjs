import {FRAME_SCENE_KEY,clone,plain,checkSceneDocument,sameScope,diagnostic,failure,bytes,LIMITS,stable} from './contracts.mjs';
function record(v){if(typeof v==='string')return JSON.parse(v);if(plain(v))return clone(v);throw new Error('FRAME_INVALID');}
export function readSceneFrame(frame,{branchId,mapId}={}){
  try{const doc=record(frame)[FRAME_SCENE_KEY];if(doc===undefined)return {ok:true,scene:null,issues:[]};const issues=checkSceneDocument(doc);if(doc.branchId!==branchId||doc.mapId!==mapId)issues.push(diagnostic('SCENE_SCOPE_MISMATCH','$.atlasScene','场景与当前地图/分支不匹配'));return {ok:issues.length===0,scene:issues.length?null:clone(doc),issues};}catch{return failure('FRAME_JSON_INVALID','$.frame_json','地图框架无法读取，未覆盖原记录');}
}
/** Returns a normal maps RowMutation. Never begins a transaction or writes a database. */
export function buildSceneMutation({result,mapRow,scope,currentScope,turnId,operationId,expectedRowRev}={}){
  try{
    if(!sameScope(scope,currentScope)||!sameScope(result?.guard?.scope,scope))return failure('STALE_SCOPE','$.scope','生成期间会话、视角或修订发生变化');
    if(!result?.ok||!result.scene)return failure('SCENE_RESULT_FAILED','$.result','失败的布局不得覆盖原场景');
    if(mapRow?.branch_id!==scope.branchId||mapRow?.id!==result.scene.mapId)return failure('SCENE_SCOPE_MISMATCH','$.mapRow','地图行不属于本次生成作用域');
    if(mapRow.row_rev!==expectedRowRev)return failure('STALE_ROW','$.expectedRowRev','地图行已经被其他变更修改');
    if(typeof turnId!=='string'||!turnId||typeof operationId!=='string'||!operationId)return failure('COMMIT_ANCHOR_REQUIRED','$.turnId','需要程序分配的楼层与操作标识');
    const checks=checkSceneDocument(result.scene);if(checks.length)return {ok:false,status:'failed',issues:checks};
    const before=clone(mapRow),frame=record(mapRow.frame_json),old=frame[FRAME_SCENE_KEY];
    if(stable(old??null)===stable(result.scene)&&!frame.atlasLayoutRequest)return {ok:true,status:'duplicate',mutation:null,issues:result.issues??[]};
    frame[FRAME_SCENE_KEY]=clone(result.scene);
    delete frame.atlasLayoutRequest;
    if(bytes(frame)>LIMITS.sceneBytes+65536)return failure('FRAME_TOO_LARGE','$.frame_json','框架与细节总量超限，保留原行');
    const after={...before,frame_json:frame,row_rev:before.row_rev+1,updated_turn_id:turnId};
    const metric=result.metricProposal;
    if(metric){if(Number(before.scale_locked)===1)return failure('SCALE_LOCKED','$.mapRow.scale_locked','不能覆盖锁定比例尺');after.meters_per_cell=metric.metersPerCell;after.scale_quality=metric.scaleQuality;after.scale_basis_json=metric.basis;after.calibration_rev=Number(before.calibration_rev??0)+1;}
    return {ok:true,status:'prepared',issues:result.issues??[],mutation:{table:'maps',rowId:before.id,before,after,sourceOpIds:[operationId],basis:{kind:'layout',generator:result.scene.generator,mapId:before.id,sourceRevision:scope.revision}}};
  }catch(e){return failure(String(e.message),'$.mapRow','无法构造地图变更，原行未修改');}
}
/** Locations remain authoritative. This is a candidate-only projection, never a SQL write. */
export function sceneLocationGeometry(scene){
  // 布局空间 → 格坐标只换算一次：格制场景本来就是格，米制场景才除以 metersPerCell（绝不乘两次）。
  const scale=scene.units==='cells'?1:scene.metersPerCell;
  if(!(scale>0))return [];
  const layout=scene.layout;
  // 概览只映射真实已登记 zone；feature 永远没有 SQL 身份，proxy 入口只存在于场景里（07 §3）。
  const parts=layout.kind==='floor'?layout.rooms
    :layout.kind==='city'?[...layout.districts,...layout.buildings.filter(b=>!b.decorative)]
      :(layout.shapes??[]).filter(s=>s&&s.placement!=='proxy');
  const centroid=polygon=>{let x=0,y=0;for(const q of polygon){x+=q.x;y+=q.y;}return {x:x/polygon.length,y:y/polygon.length};};
  return parts.map(p=>{const polygon=Array.isArray(p.polygon)?p.polygon.map(q=>Array.isArray(q)?{x:q[0],y:q[1]}:q):[{x:p.x,y:p.y},{x:p.x+p.w,y:p.y},{x:p.x+p.w,y:p.y+p.h},{x:p.x,y:p.y+p.h}];
    // 确认站点优先于多边形质心：已确认的点不能被估计轮廓重新落位。
    const locked=p.locked&&Number.isFinite(p.locked.x)&&Number.isFinite(p.locked.y)?p.locked:null;
    const point=locked??p.site??centroid(polygon);
    const confirmed=p.quality==='confirmed'||!!locked;
    return {entityId:p.id,mapId:scene.mapId,gridX:point.x/scale,gridY:point.y/scale,precision:confirmed?'exact':'layout',area:{kind:'polygon',points:polygon.map(q=>({x:q.x/scale,y:q.y/scale})),quality:p.quality==='confirmed'?'confirmed':'estimated',source:p.quality==='confirmed'?'author':'estimate'}};
  });
}
