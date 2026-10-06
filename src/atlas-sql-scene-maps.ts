/** Program-owned map structure, compiled in the same candidate and journal as its floor. */
import { createTableReadPort } from './atlas-db-readport.ts';
import { createRow } from './atlas-db-defaults.ts';
import { containerMapKind } from './atlas-ops-geography.ts';
import { scenePositions } from './atlas-scene-layout.ts';
import { queryBound, AtlasDbError } from './atlas-db-runtime.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { AtomicGroup, RowMutation } from './atlas-ops-contract.ts';

export type SqlMapCalibration = {mapId:string;metersPerCell?:number;locked?:boolean;frame?:{cols:number;rows:number};quality?:'estimated'|'confirmed'};

export function compileSqlSceneMaps(input:{db:SqlDatabase;branchId:string;turnId:string;clockS:number;operationId?:string;
  makeId:(kind:string,opId:string,alias:string)=>string;calibration?:SqlMapCalibration;ensureScenes?:boolean;povName?:string;background?:{mapId:string;asset:import('./atlas-db-contract.ts').AtlasAssetRef|null}}):AtomicGroup|null {
  const {db,branchId,turnId,clockS,makeId}=input,read=createTableReadPort(db);
  const locations=read.selectWhere('locations',{branch_id:branchId,status:'active'},1000);
  if(input.ensureScenes && Number(queryBound(db,"SELECT COUNT(*) AS n FROM locations WHERE branch_id=? AND status='active'",[branchId])[0].n)>1000)
    throw new AtlasDbError('SCENE_MAP_LIMIT','地点超过单次地图结构处理上限 1000；保留原存档，需分批处理',{});
  const maps=read.selectWhere('maps',{branch_id:branchId,status:'active'},1001);
  const changes:RowMutation[]=[],opId=input.operationId??`scene_maps_${turnId}`;
  const change=(table:string,before:Record<string,unknown>|null,after:Record<string,unknown>)=>{
    if(before&&JSON.stringify(before)===JSON.stringify(after))return;
    const previous=changes.find(change=>change.table===table&&change.rowId===after.id);
    const baseline=previous?previous.before:before;
    const next=previous?{...previous.after,...Object.fromEntries(Object.entries(after).filter(([key,value])=>JSON.stringify(value)!==JSON.stringify(before?.[key])))}:after;
    const mutation:RowMutation={table,rowId:String(after.id),before:baseline,after:baseline&&'row_rev' in baseline?{...next,row_rev:Number(baseline.row_rev)+1,updated_turn_id:turnId}:next,
      sourceOpIds:[opId],basis:{kind:input.calibration||input.background?'manual':'estimate',reason:input.calibration?'作者地图标定':input.background?'作者设置地图底图':'按实际地点层级建立地图；布局坐标不证明真实距离',certainty:input.calibration||input.background?'confirmed':'inferred'}};
    if(previous)changes[changes.indexOf(previous)]=mutation;else changes.push(mutation);
  };
  const makeMap=(id:string,name:string,kind:string,container:string|null,frame:{cols:number;rows:number})=>createRow('maps',{
    name,kind,container_location_id:container,frame_json:{...frame,origin_x:0,origin_y:0,reference_width_cells:frame.cols,reference_height_cells:frame.rows},
  },{branchId,id,turnId,clockS,nowWallMs:Date.now(),rulesetVersion:'atlas-1'});
  const branch=read.selectOne('branches',branchId,branchId)!;
  let root=maps.find(map=>map.id===branch.root_map_id)??maps.find(map=>!map.container_location_id);
  if(input.ensureScenes&&locations.length){
    if(!root){root=makeMap(makeId('map',opId,'world'),'世界图','world',null,{cols:100,rows:100});change('maps',null,root);maps.push(root);}
    const byContainer=new Map(maps.filter(map=>map.container_location_id).map(map=>[String(map.container_location_id),map]));
    for(const location of locations){
      const id=String(location.id);
      // A location is a real scene at every level, including a street or a room.
      if(!byContainer.has(id)){
        const frame=location.kind==='room'?{cols:12,rows:8}:{cols:100,rows:100};
        const map=makeMap(makeId('map',opId,`container:${id}`),String(location.name),containerMapKind(String(location.kind)),id,frame);
        change('maps',null,map);byContainer.set(id,map);maps.push(map);
      }
    }
    const childrenByMap=new Map<string,Record<string,unknown>[]>();
    for(const location of locations){
      const parentMap=location.parent_location_id?byContainer.get(String(location.parent_location_id)):root;
      if(!parentMap)throw new AtlasDbError('REF_UNKNOWN','父地点没有对应地图',{});
      const list=childrenByMap.get(String(parentMap.id))??[];list.push(location);childrenByMap.set(String(parentMap.id),list);
    }
    for(const [mapId,children] of childrenByMap){
      const map=maps.find(map=>map.id===mapId)!,frame=input.calibration?.mapId===mapId&&input.calibration.frame?input.calibration.frame:map.frame_json as {cols?:number;rows?:number};
      const pins=scenePositions(children.map(row=>({id:String(row.id),label:String(row.name)})),{cols:frame.cols??100,rows:frame.rows??100});
      children.forEach((location)=>{
        if(location.map_id===mapId&&location.grid_x!=null&&location.grid_y!=null&&location.coord_precision!=='unknown'&&(location.coord_precision==='exact'||Number(location.grid_x)>=0&&Number(location.grid_y)>=0&&Number(location.grid_x)<=(frame.cols??100)&&Number(location.grid_y)<=(frame.rows??100)))return;
        const pin=pins.get(String(location.id))!;
        change('locations',location,{...location,map_id:mapId,grid_x:pin.x,grid_y:pin.y,coord_precision:'layout',uncertainty_radius_cells:null,
          ...(location.map_id&&location.map_id!==mapId?{area_geometry_json:null}:{})});
      });
    }
    const protagonists=read.selectWhere('characters',{branch_id:branchId,status:'active',role:'protagonist'},3);
    const named=input.povName?protagonists.filter(row=>row.name===input.povName):[];
    const pov=named.length===1?named[0].id:branch.pov_character_id??(protagonists.length===1?protagonists[0].id:null);
    change('branches',branch,{...branch,root_map_id:root.id,pov_character_id:pov});
  }
  if(input.calibration){
    const c=input.calibration,map=maps.find(m=>m.id===c.mapId||c.mapId==='world'&&m.id===root?.id);
    if(!map)throw new AtlasDbError('REF_UNKNOWN','标定目标地图不存在',{});
    if(c.metersPerCell!==undefined&&(!Number.isFinite(c.metersPerCell)||c.metersPerCell<=0))throw new AtlasDbError('INVALID_PAYLOAD','每格距离必须为正数',{});
    if(c.frame&&(!Number.isInteger(c.frame.cols)||!Number.isInteger(c.frame.rows)||c.frame.cols<1||c.frame.rows<1||c.frame.cols>10000||c.frame.rows>10000))throw new AtlasDbError('INVALID_PAYLOAD','地图格数应为 1～10000 的整数',{});
    const after={...map,...(c.metersPerCell!==undefined?{meters_per_cell:c.metersPerCell,scale_min_meters_per_cell:c.metersPerCell,scale_max_meters_per_cell:c.metersPerCell,scale_quality:c.quality??'confirmed',
      scale_basis_json:{refs:[],note:'作者确认'},calibration_rev:Number(map.calibration_rev)+1}:{}),
      ...(c.locked!==undefined?{scale_locked:c.locked?1:0}:{}),...(c.frame?{frame_json:{...(map.frame_json as Record<string,unknown>),...c.frame,reference_width_cells:c.frame.cols,reference_height_cells:c.frame.rows}}:{})};
    change('maps',map,after);
  }
  if(input.background){
    const target=maps.find(map=>map.id===input.background!.mapId||input.background!.mapId==='world'&&map.id===root?.id);
    if(!target)throw new AtlasDbError('REF_UNKNOWN','底图对应地图不存在',{});
    change('maps',target,{...target,background_asset_key:input.background.asset?.key??null});
  }
  return changes.length?{id:opId,opIds:[opId],dependsOn:[],readSet:[],mutations:changes}:null;
}
