import {normalizeScope,finite,plain,diagnostic,failure} from './contracts.mjs';
import {readSceneFrame} from './storage.mjs';
export function buildLayoutContext({scope,mapRow,locations=[],characters=[],items=[]}={}){
  try{
    scope=normalizeScope(scope);if(mapRow?.branch_id!==scope.branchId)return failure('MAP_BRANCH_MISMATCH','$.mapRow','地图与当前分支不匹配');
    const frame=typeof mapRow.frame_json==='string'?JSON.parse(mapRow.frame_json):mapRow.frame_json,mpp=mapRow.meters_per_cell;
    if(!plain(frame))return failure('FRAME_INVALID','$.mapRow.frame_json','需要完整地图框架');
    const active=rows=>rows.filter(r=>r.branch_id===scope.branchId&&r.status==='active'),ls=active(locations),cs=active(characters),its=active(items).filter(i=>!i.holder_character_id&&!i.container_item_id);
    const own=ls.filter(l=>l.map_id===mapRow.id),locks={rooms:{},buildings:{},actors:{}};
    if(finite(mpp)&&mpp>0){
      for(const l of own){const area=typeof l.area_geometry_json==='string'?JSON.parse(l.area_geometry_json):l.area_geometry_json;
        if(area?.quality!=='confirmed'||area?.kind!=='polygon'||area.points?.length!==4)continue;
        const p=area.points;if(!p.every(p=>finite(p.x)&&finite(p.y)))continue;const xs=p.map(p=>p.x),ys=p.map(p=>p.y),x=Math.min(...xs),y=Math.min(...ys),w=Math.max(...xs)-x,h=Math.max(...ys)-y;
        // Only exact axis-aligned rectangular outlines are compatible with this floor solver.
        if(w<=0||h<=0||!p.every(p=>(Math.abs(p.x-x)<1e-6||Math.abs(p.x-x-w)<1e-6)&&(Math.abs(p.y-y)<1e-6||Math.abs(p.y-y-h)<1e-6)))continue;
        locks[l.kind==='room'?'rooms':'buildings'][l.id]={x:x*mpp,y:y*mpp,w:w*mpp,h:h*mpp};
      }
      for(const c of cs)if(c.map_id===mapRow.id&&c.coord_precision==='exact'&&finite(c.grid_x)&&finite(c.grid_y))locks.actors[c.id]={x:c.grid_x*mpp,y:c.grid_y*mpp};
    }
    const saved=readSceneFrame(frame,{branchId:scope.branchId,mapId:mapRow.id});
    if(!saved.ok)return saved;
    return {ok:true,context:{scope,map:{id:mapRow.id,name:mapRow.name,containerLocationId:mapRow.container_location_id??null,metersPerCell:finite(mpp)&&mpp>0?mpp:null,scaleQuality:mapRow.scale_quality,scaleLocked:Number(mapRow.scale_locked)===1,frame},entities:{locations:ls.map(l=>l.id),characters:cs.map(c=>c.id),items:its.map(i=>i.id)},locks,previousScene:saved.scene,seed:mapRow.id},issues:[]};
  }catch(e){return failure('CONTEXT_BUILD_FAILED','$','当前分支行或已保存场景不可读取',{detailCode:String(e.message)});}
}
