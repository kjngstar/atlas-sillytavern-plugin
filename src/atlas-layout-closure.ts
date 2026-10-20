import {compileSceneGroup,collectMapLocations} from '../vendor/atlas-spatial/index.mjs';
import {normalizeFrame,normalizeSqlMapFrame,fitFrameToPhysicalSize,alignSqlFrameToPhysicalSize,type SpatialScope} from './atlas-spatial-frame.ts';
import {resolveMapSpaceSize,locationSpaceSize,readSpaceCanonical} from './atlas-space-canonical.ts';
import type {AtomicGroup,RowMutation} from './atlas-ops-contract.ts';
import {resolveSpatialProfile} from './atlas-spatial-profile.ts';
type Row=Record<string,unknown>;

/** Complete linked physical projections before publishing this layout group. */
export function completeLayoutClosure(input:{group:AtomicGroup;maps:Row[];locations:Row[];characters:Row[];items:Row[];routes:Row[];scope:SpatialScope;turnId:string;operationId:string}){
  const {scope,turnId,operationId}=input;
  let maps=structuredClone(input.maps),locations=structuredClone(input.locations);
  const mutations=new Map<string,RowMutation>(),queue:string[]=[],seen=new Set<string>(),initialLedgers=new Set<string>(),completed=new Set<string>(input.group.mutations.filter(m=>m.table==='maps').slice(0,1).map(m=>m.rowId));
  const merge=(mutation:RowMutation)=>{
    const key=mutation.table+'\0'+mutation.rowId,old=mutations.get(key);
    const merged=old?{...old,after:mutation.after}:mutation;
    if(merged.before&&merged.after&&typeof merged.before.row_rev==='number')merged.after={...merged.after,row_rev:merged.before.row_rev+1};
    mutations.set(key,merged);
    if(mutation.table==='maps')maps=maps.map(row=>row.id===mutation.rowId?structuredClone(merged.after!):row);
    if(mutation.table==='locations')locations=locations.map(row=>row.id===mutation.rowId?structuredClone(merged.after!):row);
    if(mutation.table==='maps'){
      const a=normalizeFrame(mutation.after?.frame_json).atlasSpaceCanonical as Row|undefined,b=normalizeFrame(mutation.before?.frame_json).atlasSpaceCanonical;
      if(a&&JSON.stringify(a)!==JSON.stringify(b)){
        if(!b)initialLedgers.add(mutation.rowId);
        queue.push(mutation.rowId);
        const parent=locations.find(l=>l.id===mutation.after?.container_location_id)?.map_id;
        if(typeof parent==='string'&&parent!==mutation.rowId)queue.push(parent);
      }
    }
  };
  for(const mutation of input.group.mutations)merge(mutation);
  let attempts=0;
  while(queue.length){
    const mapId=queue.shift()!,map=maps.find(m=>m.id===mapId&&m.status==='active');if(!map)continue;
    const frame=normalizeFrame(map.frame_json),canonical=readSpaceCanonical(frame,String(map.container_location_id)).canonical;
    const signature=mapId+JSON.stringify([canonical,locations.filter(l=>l.map_id===mapId).map(l=>[l.id,locationSpaceSize({maps,locations,locationId:String(l.id),branchId:scope.branchId})])]);
    if(seen.has(signature))continue;seen.add(signature);
    if(++attempts>24)return {ok:false,issues:[{code:'SPACE_PROJECTION_LIMIT',path:'$.layout',message:'关联空间投影超过本轮有限预算；保留原组件',severity:'error',retryable:false}]};
    const container=locations.find(l=>l.id===map.container_location_id),scene=frame.atlasScene as Row|undefined;
    const layout=scene?.layout as Row|undefined;
    const members=collectMapLocations({mapRow:map,maps,locations});
    const profile=resolveSpatialProfile({map,container:container??null,parentContainer:locations.find(row=>row.id===container?.parent_location_id)??null,members,routes:input.routes.filter(r=>r.map_id===mapId)});
    const pending=frame.atlasLayoutRequest as Row|undefined;
    // A parent footprint establishes a non-leaf floor's size, not its internal
    // layout. Leave it for its own pending request instead of inventing a self
    // room and marking the real multi-room request completed.
    const kind=layout||pending?.status==='pending'?profile.layoutKind:(members.length===0&&['room','floor'].includes(String(container?.kind))&&canonical?'floor':null);
    if(kind!=='floor'&&kind!=='city'&&kind!=='overview')continue;
    const spaceSize=resolveMapSpaceSize({maps,locations,mapRow:map,branchId:scope.branchId});
    let spec=structuredClone(pending?.status==='pending'?pending.spec:scene?.constraints??{}) as Row;
    if(kind==='floor'&&initialLedgers.has(mapId)&&canonical&&Array.isArray(spec.rooms)&&spec.rooms.length===1&&(spec.rooms[0] as Row).id===container?.id){
      // Legacy child guesses had no shared furniture identity. The first shared
      // ledger becomes the single source; keep old frames in the ordinary journal.
      const ids=new Set(canonical.furnishing.map(f=>f.localId.split(':furn:')[1]));
      const oldConstraints=scene?.constraints as Row|undefined;
      const oldContents=Array.isArray(oldConstraints?.contents)?oldConstraints.contents as Row[]:[];
      spec.deletes={...(spec.deletes as Row??{}),contents:oldContents.filter(f=>!ids.has(String(f.id))).map(f=>f.id)};
      if(canonical.furnishing.length)spec.contents=oldContents.filter(f=>ids.has(String(f.id)));
      spec.actors=input.characters.filter(c=>c.status==='active'&&c.location_id===container?.id).map(c=>({id:c.id,roomId:container!.id}));
      spec.items=[];
    }
    if(kind==='overview'&&layout?.kind!=='overview'&&pending?.kind!=='overview')spec={surface:'mixed',zones:members.filter(l=>l.kind!=='room'&&l.mobility!=='mobile').map(l=>({id:l.id,name:l.name,role:'other',size:'medium'})),links:input.routes.filter(r=>r.map_id===mapId).map(r=>({id:r.id})),features:[]};
    if(kind==='floor'){
      const rooms=Array.isArray(spec.rooms)?spec.rooms as Row[]:[];
      if(!rooms.length&&container&&canonical?.size)spec.rooms=[{id:container.id,name:container.name,w:canonical.size.widthM,h:canonical.size.heightM,side:'north'}];
    }
    if(spaceSize){
      const normalized=normalizePlannedFrame(map,spaceSize.resolution,locations,[...input.characters,...input.items],turnId,operationId+':linked-frame');
      if(normalized)merge(normalized);
      const alignedMap=maps.find(m=>m.id===mapId)!;
      const aligned=alignSqlFrameToPhysicalSize({mapRow:alignedMap,widthM:spaceSize.resolution.widthM,heightM:spaceSize.resolution.heightM,scope,currentScope:scope,expectedRowRev:Number(alignedMap.row_rev),turnId,operationId:operationId+':linked-fit',source:{kind:spaceSize.resolution.source,referenceId:spaceSize.locationId}});
      if(!aligned.ok)return {ok:false,issues:aligned.issues};
      if(aligned.mutation)merge(aligned.mutation as RowMutation);
    }
    const current=maps.find(m=>m.id===mapId)!;
    const result=compileSceneGroup({request:{kind,spec},scope,currentScope:scope,mapRow:current,maps,locations,characters:input.characters,items:input.items,routes:input.routes,turnId,operationId:operationId+':linked:'+attempts,spaceSize,
      autoPlan:true,planningProjection:true,
      childSpaces:Object.fromEntries(locations.filter(l=>l.map_id===mapId).flatMap(l=>{const size=locationSpaceSize({maps,locations,locationId:String(l.id),branchId:scope.branchId});return size?[[String(l.id),size]]:[];}))});
    if(!result.ok||result.issues?.some((i:Row)=>i.severity==='error'))return {ok:false,issues:result.issues?.map((issue:Row)=>({...issue,message:String(issue.message)+'（关联图 '+mapId+'）'}))};
    completed.add(mapId);
    for(const mutation of result.group?.mutations??[])merge(mutation);
  }
  return {ok:true,issues:[],completedMapIds:[...completed],group:{...input.group,readSet:[...mutations.values()].filter(m=>m.before).map(m=>({table:m.table,rowId:m.rowId,rowRev:Number(m.before!.row_rev)})),mutations:[...mutations.values()]}};
}

/** Re-express legacy estimated frames from known physical dimensions, never aliases. */
export function normalizePlannedFrame(map:Row,size:{widthM:number;heightM:number},locations:Row[],occupants:Row[],turnId:string,operationId:string):RowMutation|null{
  if(normalizeSqlMapFrame(map.frame_json).ok||Number(map.scale_locked)===1||map.scale_quality==='confirmed')return null;
  if([...locations,...occupants].some(row=>row.map_id===map.id&&row.coord_precision==='exact'))return null;
  const fit=fitFrameToPhysicalSize({widthM:size.widthM,heightM:size.heightM,cols:null,rows:null,metersPerCell:null});
  if(!fit.ok||!fit.cols||!fit.rows||!fit.metersPerCell)return null;
  const frame={...normalizeFrame(map.frame_json),cols:fit.cols,rows:fit.rows,reference_width_cells:fit.cols,reference_height_cells:fit.rows};
  return {table:'maps',rowId:String(map.id),before:map,after:{...map,frame_json:frame,meters_per_cell:fit.metersPerCell,scale_quality:'estimated',scale_basis_json:{source:'known-space-frame',widthM:size.widthM,heightM:size.heightM},calibration_rev:Number(map.calibration_rev??0)+1,row_rev:Number(map.row_rev)+1,updated_turn_id:turnId},sourceOpIds:[operationId],basis:{kind:'layout',source:'known-space-frame'}};
}

/** Bind only a unique local entity explicitly supported by this turn's sources. */
export function supportedCorridor(map:Row,locations:Row[],sourceText:string):string|null{
  const container=locations.find(l=>l.id===map.container_location_id);
  if(!container||!sourceText.includes(String(container.name)))return null;
  const candidates=locations.filter(l=>l.status==='active'&&l.map_id===map.id&&l.parent_location_id===container.id&&/(?:走廊|廊道|corridor)/i.test(String(l.name))&&sourceText.includes(String(l.name)));
  if(candidates.length!==1||!/(?:相连|连接|串联|两侧|贯通|connect)/i.test(sourceText))return null;
  const name=String(candidates[0].name);
  if(sourceText.includes('没有'+name)||sourceText.includes('不存在'+name))return null;
  return String(candidates[0].id);
}
