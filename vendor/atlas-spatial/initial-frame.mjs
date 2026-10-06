import {clone,plain,finite,sameScope,failure} from './contracts.mjs';
/** One initial estimate for an empty, unlocked map; never rescales positioned entities. */
export function prepareInitialFrame({mapRow,scope,currentScope,locations=[],widthM,heightM,turnId,operationId,expectedRowRev}={}){
  try{
    if(!sameScope(scope,currentScope))return failure('STALE_SCOPE','$.scope','初始化时作用域已经改变');
    if(mapRow?.branch_id!==scope.branchId)return failure('MAP_BRANCH_MISMATCH','$.mapRow','地图不在当前分支');
    if(!Number.isInteger(mapRow.row_rev)||mapRow.row_rev!==expectedRowRev)return failure('STALE_ROW','$.expectedRowRev','地图行已经改变');
    const frame=typeof mapRow.frame_json==='string'?JSON.parse(mapRow.frame_json):clone(mapRow.frame_json);
    if(!plain(frame))return failure('FRAME_INVALID','$.frame_json','框架必须是普通对象');
    const positioned=locations.some(l=>l.branch_id===scope.branchId&&l.map_id===mapRow.id&&l.status==='active'&&finite(l.grid_x)&&finite(l.grid_y));
    if(frame.atlasScene||positioned||Number(mapRow.scale_locked)===1||mapRow.scale_quality==='confirmed')return {ok:true,status:'retained',mutation:null,issues:[]};
    if(!finite(widthM)||!finite(heightM)||widthM<=0||heightM<=0)return failure('INITIAL_EXTENT_REQUIRED','$','新空地图需要有限正尺寸，或继续使用原概览');
    if(typeof turnId!=='string'||!turnId||typeof operationId!=='string'||!operationId)return failure('COMMIT_ANCHOR_REQUIRED','$.turnId','需要当前楼层与操作ID');
    const mpp=widthM/100,rows=heightM/mpp;
    if(!finite(mpp)||!finite(rows)||mpp<=0||rows<=0)return failure('INITIAL_FRAME_RANGE_INVALID','$','尺寸无法得到有效坐标跨度');
    const before=clone(mapRow),after={...clone(mapRow),frame_json:{...frame,cols:100,rows,origin_x:0,origin_y:0},meters_per_cell:mpp,scale_quality:'estimated',scale_min_meters_per_cell:null,scale_max_meters_per_cell:null,scale_basis_json:{source:'initial-spatial-extent',widthM,heightM},calibration_rev:Number(mapRow.calibration_rev??0)+1,row_rev:mapRow.row_rev+1,updated_turn_id:turnId};
    return {ok:true,status:'prepared',issues:[],mutation:{table:'maps',rowId:mapRow.id,before,after,sourceOpIds:[operationId],basis:{kind:'estimate',source:'initial-spatial-extent'}}};
  }catch(e){return failure('INITIAL_FRAME_INVALID','$','初始化没有写入原地图',{detailCode:String(e.message)});}
}
