/** Functional regions share their host's open floor; they never create walls or obstacles. */
import { readSceneFrame, sceneLocationGeometry, checkSceneDocument, LIMITS } from '../vendor/atlas-spatial/index.mjs';
import type { Bounds, FloorArea } from '../vendor/atlas-spatial/index.mjs';
import type { AtomicGroup, Issue, RowMutation } from './atlas-ops-contract.ts';
import type { TableReadPort } from './atlas-ops-compile-types.ts';
import { pageAllRows } from './atlas-db-readport.ts';
import { normalizeFrame } from './atlas-spatial-frame.ts';
import { functionalAreaMembers } from './atlas-spatial-profile.ts';
import { canonicalAuthoredArea } from './atlas-layout-signature.ts';
import { locationSpaceSize } from './atlas-space-canonical.ts';
import { computeMapLayoutSignatures, LAYOUT_CONTEXT_FRAME_KEY } from './atlas-sql-layout-task.ts';
import { stableHexHash } from './atlas-hash.ts';
import { AtlasDbError } from './atlas-db-runtime.ts';

type TableRow=NonNullable<ReturnType<TableReadPort['selectOne']>>;
const contains=(host:Bounds,area:Bounds)=>area.x>=host.x&&area.y>=host.y&&area.x+area.w<=host.x+host.w&&area.y+area.h<=host.y+host.h;

function areaGeometry(member:TableRow,host:Bounds,index:number,count:number,mpp:number,maps:TableRow[],locations:TableRow[],branchId:string,anchors:readonly {x:number;y:number}[]):FloorArea|null {
  const polygon=canonicalAuthoredArea(member.area_geometry_json);
  const size=locationSpaceSize({maps,locations,locationId:String(member.id),branchId});
  const stride=host.w/(count+1);
  let rect:Bounds=size
    ?{x:host.x+host.w-size.widthM,y:host.y,w:size.widthM,h:size.heightM}
    :{x:host.x+(index+1)*stride+.2,y:host.y+.2,w:stride-.4,h:host.h-.4};
  if(polygon){
    const xs=polygon.map(p=>p[0]*mpp),ys=polygon.map(p=>p[1]*mpp);
    rect={x:Math.min(...xs),y:Math.min(...ys),w:Math.max(...xs)-Math.min(...xs),h:Math.max(...ys)-Math.min(...ys)};
    if(polygon.length!==4||polygon.some((_,i)=>!(xs[i]===rect.x||xs[i]===rect.x+rect.w)||!(ys[i]===rect.y||ys[i]===rect.y+rect.h)))return null;
  }else if(member.coord_precision==='exact'){
    rect={...rect,x:Number(member.grid_x)*mpp-rect.w/2,y:Number(member.grid_y)*mpp-rect.h/2};
  }else if(!size&&anchors.length){
    const left=Math.min(rect.x,...anchors.map(p=>p.x-.1)),top=Math.min(rect.y,...anchors.map(p=>p.y-.1));
    const right=Math.max(rect.x+rect.w,...anchors.map(p=>p.x+.1)),bottom=Math.max(rect.y+rect.h,...anchors.map(p=>p.y+.1));
    rect={x:left,y:top,w:right-left,h:bottom-top};
  }
  if(rect.w<=0||rect.h<=0||!contains(host,rect)||anchors.some(p=>p.x<rect.x||p.x>rect.x+rect.w||p.y<rect.y||p.y>rect.y+rect.h))return null;
  return {version:1,id:String(member.id),name:String(member.name),roomId:String(member.parent_location_id),...rect,quality:polygon?'confirmed':'estimated'};
}

export function planFunctionalAreaProjections(input:{tables:TableReadPort;branchId:string;turnId:string;mapIds:readonly string[];requireCurrentInputs:boolean}):{groups:AtomicGroup[];issues:Issue[]} {
  const {tables,branchId,turnId}=input;
  const maps=pageAllRows(tables,'maps',branchId).filter(row=>row.status==='active');
  const locations=pageAllRows(tables,'locations',branchId).filter(row=>row.status==='active');
  const occupants=[...pageAllRows(tables,'characters',branchId),...pageAllRows(tables,'items',branchId)].filter(row=>row.status==='active');
  const signatures=input.requireCurrentInputs?computeMapLayoutSignatures(tables,branchId):null;
  const groups:AtomicGroup[]=[],issues:Issue[]=[];
  for(const mapId of new Set(input.mapIds)){
    const map=maps.find(row=>row.id===mapId);
    if(!map)continue;
    const container=locations.find(row=>row.id===map.container_location_id)??null;
    const members=functionalAreaMembers(container,locations.filter(row=>row.map_id===mapId),maps).sort((a,b)=>String(a.id)<String(b.id)?-1:1);
    if(members.length===0)continue;
    const frame=normalizeFrame(map.frame_json),read=readSceneFrame(frame,{branchId,mapId});
    if(!read.ok)throw new AtlasDbError('FUNCTIONAL_AREA_SCENE_INVALID','功能分区所属场景不可读取',{mapId,issues:read.issues});
    const scene=read.scene;
    if(!scene||scene.layout.kind!=='floor')continue;
    if(input.requireCurrentInputs){
      const request=frame.atlasLayoutRequest,context=frame[LAYOUT_CONTEXT_FRAME_KEY];
      if(request!==null&&typeof request==='object'&&'status' in request&&(request.status==='failed'||request.status==='pending'))continue;
      if(context===null||typeof context!=='object'||!('hash' in context)||context.hash!==signatures?.get(mapId))continue;
    }
    const host=scene.layout.hostArea??scene.layout.rooms.find((room:Bounds&{id:string})=>room.id===container?.id);
    if(!host)throw new AtlasDbError('FUNCTIONAL_AREA_HOST_MISSING','功能分区缺少已生成的父房间范围',{mapId});
    if(members.length>LIMITS.zones)throw new AtlasDbError('FUNCTIONAL_AREA_LIMIT','功能分区数量超过场景容量',{mapId});
    const areas=members.map((member,index)=>{
      const ids=new Set(occupants.filter(row=>row.location_id===member.id).map(row=>row.id));
      const anchors=[...scene.layout.actors,...scene.layout.items].filter((point:{id:string})=>ids.has(point.id));
      return areaGeometry(member,host,index,members.length,scene.units==='meters'?Number(map.meters_per_cell):1,maps,locations,branchId,anchors);
    });
    if(areas.some(area=>area===null)){
      issues.push({code:'FUNCTIONAL_AREA_GEOMETRY_CONFLICT',path:`$.maps.${mapId}.areas`,message:'功能分区的确认范围或物理尺寸无法放入父房间，原几何保留',severity:'error',retryable:false});continue;
    }
    const nextScene={...scene,layout:{...scene.layout,areas}};
    const invalid=checkSceneDocument(nextScene);
    if(invalid.length)throw new AtlasDbError('FUNCTIONAL_AREA_SCENE_INVALID','功能分区未通过场景契约',{mapId,issues:invalid});
    if(JSON.stringify(scene.layout.areas??[])===JSON.stringify(areas))continue;
    const opId=`functional-areas:${turnId}:${mapId}:${stableHexHash(JSON.stringify([areas,scene.inputSignature])).slice(0,12)}`;
    const mutations:RowMutation[]=[{table:'maps',rowId:mapId,before:map,after:{...map,frame_json:{...frame,atlasScene:nextScene},row_rev:Number(map.row_rev)+1,updated_turn_id:turnId},sourceOpIds:[opId],basis:{kind:'functional-area-projection',mapId}}];
    const ids=new Set(members.map(member=>member.id));
    for(const geo of sceneLocationGeometry(nextScene).filter((geo:{entityId:string})=>ids.has(geo.entityId))){
      const before=locations.find(row=>row.id===geo.entityId);
      if(!before)throw new AtlasDbError('FUNCTIONAL_AREA_LOCATION_MISSING','功能分区实体不存在',{mapId,entityId:geo.entityId});
      const area=normalizeFrame(before.area_geometry_json);
      const after={...before,grid_x:before.coord_precision==='exact'?before.grid_x:geo.gridX,grid_y:before.coord_precision==='exact'?before.grid_y:geo.gridY,
        coord_precision:before.coord_precision==='exact'?'exact':'layout',area_geometry_json:area.quality==='confirmed'?before.area_geometry_json:geo.area,row_rev:Number(before.row_rev)+1,updated_turn_id:turnId};
      if(JSON.stringify([before.grid_x,before.grid_y,before.coord_precision,before.area_geometry_json])===JSON.stringify([after.grid_x,after.grid_y,after.coord_precision,after.area_geometry_json]))continue;
      mutations.push({table:'locations',rowId:String(before.id),before,after,sourceOpIds:[opId],basis:{kind:'functional-area-projection',mapId}});
    }
    groups.push({id:opId,opIds:[opId],dependsOn:[],readSet:mutations.map(mutation=>({table:mutation.table,rowId:mutation.rowId,rowRev:Number(mutation.before?.row_rev)})),mutations});
  }
  return {groups,issues};
}
