/**
 * Program-owned map structure, compiled in the same candidate and journal as its floor.
 *
 * M2-09 容器阶段的三条硬规矩：
 * 1. 先按 container_location_id **唯一**查既有图（老档写 `loc:<id>` 也算同一容器），
 *    同场景重复编译绝不重建第二张；同容器多张旧图只报告，不删除、不改写 kind/ID。
 * 2. kind 走 `containerMapKind` 这张共享表，不在本文件复制第二份映射。
 * 3. 幅面一律走 `normalizeSqlMapFrame`：旧 `reference_width_cells/reference_height_cells`
 *    档（例如 120×80）读得出来，坏的明确报错，绝不以 NaN 继续排位。
 * 4. 跨图坐标按 02 §4.2 决策表分流：unknown/layout 走 `placeUnlocatedScenePoints`；
 *    exact/confirmed 没有可靠 transform 一律保留旧 map_id/坐标/范围并写
 *    `COORD_FRAME_MIGRATION_BLOCKED` —— 不搬 old x/y、不悄悄降级成 layout。
 *
 * 只返回 journal 用的 AtomicGroup，不直接保存；读视图不经过本函数，因此读不会写入。
 */
import { createTableReadPort } from './atlas-db-readport.ts';
import { createRow } from './atlas-db-defaults.ts';
import { containerMapKind } from './atlas-ops-geography.ts';
import { placeUnlocatedScenePoints } from './atlas-scene-layout.ts';
import { normalizeSqlMapFrame } from './atlas-spatial-frame.ts';
import { queryBound, AtlasDbError } from './atlas-db-runtime.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { AtomicGroup, Issue, RowMutation } from './atlas-ops-contract.ts';

export type SqlMapCalibration = {mapId:string;metersPerCell?:number;locked?:boolean;frame?:{cols:number;rows:number};quality?:'estimated'|'confirmed'};

/**
 * 单次场景编译的行保护预算。
 * 原本是两个散落的字面量（locations 的 1000 与 maps 的 1001）；这里只把同一个数字命名一次，
 * 不新增第二套限制。超预算的地点进 remaining 诊断，绝不删除任何旧图来腾位置。
 */
const SCENE_ROW_LIMIT = 1000;

/** 新容器图的默认幅面：房间用小格，其余用整幅（沿用既有取值）。 */
const CONTAINER_FRAME_CELLS = { room: { cols: 12, rows: 8 }, other: { cols: 100, rows: 100 } } as const;

/** 容器键归一：返回 null 表示没有容器；否则返回该容器在本分支里的权威地点 ID。 */
function containerRaw(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text ? text : null;
}

export function compileSqlSceneMaps(input:{db:SqlDatabase;branchId:string;turnId:string;clockS:number;operationId?:string;
  makeId:(kind:string,opId:string,alias:string)=>string;calibration?:SqlMapCalibration;ensureScenes?:boolean;povName?:string;background?:{mapId:string;asset:import('./atlas-db-contract.ts').AtlasAssetRef|null}}):AtomicGroup|null {
  const {db,branchId,turnId,clockS,makeId}=input,read=createTableReadPort(db);
  const locations=read.selectWhere('locations',{branch_id:branchId,status:'active'},SCENE_ROW_LIMIT+1);
  if(input.ensureScenes && Number(queryBound(db,"SELECT COUNT(*) AS n FROM locations WHERE branch_id=? AND status='active'",[branchId])[0].n)>SCENE_ROW_LIMIT)
    throw new AtlasDbError('SCENE_MAP_LIMIT',`地点超过单次地图结构处理上限 ${SCENE_ROW_LIMIT}；保留原存档，需分批处理`,{});
  const maps=read.selectWhere('maps',{branch_id:branchId,status:'active'},SCENE_ROW_LIMIT+1);
  const changes:RowMutation[]=[],opId=input.operationId??`scene_maps_${turnId}`,opIssues:Issue[]=[];
  const change=(table:string,before:Record<string,unknown>|null,after:Record<string,unknown>)=>{
    if(before&&JSON.stringify(before)===JSON.stringify(after))return;
    const previous=changes.find(change=>change.table===table&&change.rowId===after.id);
    const baseline=previous?previous.before:before;
    const next=previous?{...previous.after,...Object.fromEntries(Object.entries(after).filter(([key,value])=>JSON.stringify(value)!==JSON.stringify(before?.[key])))}:after;
    const mutation:RowMutation={table,rowId:String(after.id),before:baseline,after:baseline&&'row_rev' in baseline?{...next,row_rev:Number(baseline.row_rev)+1,updated_turn_id:turnId}:next,
      sourceOpIds:[opId],basis:{kind:input.calibration||input.background?'manual':'estimate',reason:input.calibration?'作者地图标定':input.background?'作者设置地图底图':'按实际地点层级建立地图；布局坐标不证明真实距离',certainty:input.calibration||input.background?'confirmed':'inferred'}};
    if(previous)changes[changes.indexOf(previous)]=mutation;else changes.push(mutation);
  };
  const makeMap=(id:string,name:string,kind:string,container:string|null,size:{cols:number;rows:number})=>createRow('maps',{
    name,kind,container_location_id:container,
    // 两套字段同时写：新读法认 cols/rows，旧读法认 reference_*，不给未来的归一留下歧义。
    frame_json:{origin_x:0,origin_y:0,cols:size.cols,rows:size.rows,reference_width_cells:size.cols,reference_height_cells:size.rows},
  },{branchId,id,turnId,clockS,nowWallMs:Date.now(),rulesetVersion:'atlas-1'});
  const branch=read.selectOne('branches',branchId,branchId)!;

  // 稳定排序：同一容器有多张旧图时，谁当权威不能随 SQL 返回顺序变。
  maps.sort((left,right)=>String(left.id)<String(right.id)?-1:String(left.id)>String(right.id)?1:0);

  // ── 1. 既有图唯一索引：同一容器只认一张 ────────────────────────────────
  // 权威写法按**真实地点集合**判定：地点 ID 本身可能就叫 `loc:1`（旧三表导入就是这种），
  // 所以不能无脑剥 `loc:` 前缀——那会把 `loc:1` 误归一到 `1`，凭空建出第二张图撞唯一索引。
  const locationIds=new Set(locations.map(row=>String(row.id)));
  const canonicalContainerId=(value:unknown):string|null=>{
    const raw=containerRaw(value);
    if(raw===null)return null;
    if(locationIds.has(raw))return raw;
    if(raw.startsWith('loc:')&&locationIds.has(raw.slice(4)))return raw.slice(4);
    return raw;
  };
  const byContainer=new Map<string,Record<string,unknown>>(),duplicateContainers=new Map<string,string[]>();
  for(const map of maps){
    const key=canonicalContainerId(map.container_location_id);
    if(key===null)continue;
    const held=byContainer.get(key);
    if(!held){byContainer.set(key,map);continue;}
    const ids=duplicateContainers.get(key)??[String(held.id)];
    ids.push(String(map.id));duplicateContainers.set(key,ids);
    // 取 id 最小的那张当权威：可复现，且不需要改写任何旧行。
    if(String(map.id)<String(held.id))byContainer.set(key,map);
  }
  for(const [containerId,ids] of [...duplicateContainers.entries()].sort((a,b)=>(a[0]<b[0]?-1:1))){
    const kept=byContainer.get(containerId)!;
    opIssues.push({code:'SCENE_MAP_DUPLICATE_CONTAINER',path:`$.maps.${String(kept.id)}`,
      message:`容器地点 ${containerId} 有 ${ids.length} 张地图（${[...ids].sort().join(' / ')}）：本次沿用 ${String(kept.id)}，其余旧图原样保留（不删除、不改写 kind/ID）`,
      severity:'warning',retryable:false});
  }

  let root=maps.find(map=>map.id===branch.root_map_id)??maps.find(map=>canonicalContainerId(map.container_location_id)===null);
  if(input.ensureScenes&&locations.length){
    if(!root){root=makeMap(makeId('map',opId,'world'),'世界图','world',null,CONTAINER_FRAME_CELLS.other);change('maps',null,root);maps.push(root);}

    // ── 2. 只补缺图：已存在的图一张都不重建；不为凑上限删除任何旧图 ──────
    const createBudget=Math.max(0,SCENE_ROW_LIMIT-maps.length),remainingLocationIds:string[]=[];
    let created=0;
    for(const location of locations){
      const id=String(location.id);
      if(byContainer.has(id))continue;
      if(created>=createBudget){remainingLocationIds.push(id);continue;}
      // A location is a real scene at every level, including a street or a room.
      const size=String(location.kind)==='room'?CONTAINER_FRAME_CELLS.room:CONTAINER_FRAME_CELLS.other;
      const map=makeMap(makeId('map',opId,`container:${id}`),String(location.name),containerMapKind(String(location.kind)),id,size);
      change('maps',null,map);byContainer.set(id,map);maps.push(map);created+=1;
    }
    if(remainingLocationIds.length)opIssues.push({code:'SCENE_MAP_BUDGET_REMAINING',path:'$.maps',
      message:`地图数量已达保护预算 ${SCENE_ROW_LIMIT}：本次未建 ${remainingLocationIds.length} 张容器图（${[...remainingLocationIds].sort().join(' / ')}）。旧图一律保留，需分批处理`,
      severity:'warning',retryable:true});

    // ── 3. 位置排位：父图必须存在，幅面必须先归一 ──────────────────────
    const childrenByMap=new Map<string,Record<string,unknown>[]>();
    for(const location of locations){
      const parentKey=location.parent_location_id?canonicalContainerId(location.parent_location_id):null;
      const parentMap=parentKey?byContainer.get(parentKey):root;
      if(!parentMap)throw new AtlasDbError('REF_UNKNOWN','父地点没有对应地图',{});
      const list=childrenByMap.get(String(parentMap.id))??[];list.push(location);childrenByMap.set(String(parentMap.id),list);
    }
    const frameBlocked:string[]=[],fullMapIds:string[]=[],blockedMigrations:string[]=[],unplacedFrames:string[]=[];
    for(const mapId of [...childrenByMap.keys()].sort()){
      const children=childrenByMap.get(mapId)!,map=maps.find(row=>row.id===mapId)!;
      const override=input.calibration?.mapId===mapId&&input.calibration.frame?input.calibration.frame:null;
      const normalized=normalizeSqlMapFrame(map.frame_json,{mapId,branchId,turnId,operationId:opId});
      const frame=override&&Number.isInteger(override.cols)&&Number.isInteger(override.rows)&&override.cols>=1&&override.rows>=1
        ?override
        :normalized.ok?{cols:normalized.cols as number,rows:normalized.rows as number}:null;
      if(!frame){
        // 一张坏幅面不能拖垮整轮回执：降级为 warning，本图不排位、不写 NaN，旧坐标原样保留。
        frameBlocked.push(mapId);
        for(const item of normalized.issues)opIssues.push({...item,severity:'warning'});
        continue;
      }

      // ── 02 §4.2 决策表：先分流，再排位。绝不把 old x/y 直接搬进新图。 ──
      const existing:Array<{id:string;x:number;y:number}>=[],pending:Array<{id:string}>=[];
      for(const location of children){
        const id=String(location.id);
        const precision=String(location.coord_precision??'unknown');
        const confirmed=precision==='exact'||precision==='confirmed';
        const onThisMap=String(location.map_id??'')===mapId;
        const finite=Number.isFinite(Number(location.grid_x))&&Number.isFinite(Number(location.grid_y));
        if(!confirmed){
          // unknown / layout / 未锁定估计：可以在新图稳定排位。
          if(onThisMap&&finite)existing.push({id,x:Number(location.grid_x),y:Number(location.grid_y)});
          else pending.push({id});
          continue;
        }
        // exact / confirmed：只有存在「双方已确认的 frame transform」才允许换算坐标与完整范围。
        // 当前 20 表 schema 没有任何存放跨参考系变换的权威字段，因此本版本一律走下面的
        // 「保留旧字段 + COORD_FRAME_MIGRATION_BLOCKED」，不搬 old x/y、不降级为 layout。
        if(onThisMap)continue;
        blockedMigrations.push(`${id}→${mapId}`);
      }
      if(!pending.length&&!existing.length)continue;

      const placement=placeUnlocatedScenePoints({frame,existing,pending,obstacles:[],seed:`${branchId}\u0000${mapId}`});
      for(const item of placement.issues){
        // 幅面/间隔已经在上面校验过，这里只可能是排位失败；统一按 warning 汇总，不拒绝整组。
        if(item.code==='PLACEMENT_FULL')continue;
        opIssues.push({code:item.code,path:item.path,message:item.message,severity:'warning',retryable:false});
      }
      if(placement.remainingIds.length)fullMapIds.push(`${mapId}(${placement.remainingIds.length})`);
      const byId=new Map(pending.map(entry=>[entry.id,entry]));
      for(const point of placement.placed){
        const location=children.find(row=>String(row.id)===point.id)!;
        byId.delete(point.id);
        change('locations',location,{...location,map_id:mapId,grid_x:point.x,grid_y:point.y,coord_precision:'layout',uncertainty_radius_cells:null,
          ...(location.map_id&&String(location.map_id)!==mapId?{area_geometry_json:null}:{})});
      }
      // 没能排上位的地点：旧字段原样保留，绝不清空成半截状态。
      for(const id of byId.keys())unplacedFrames.push(id);
    }
    if(blockedMigrations.length)opIssues.push({code:'COORD_FRAME_MIGRATION_BLOCKED',path:'$.locations',
      message:`${blockedMigrations.length} 个已确认地点需要跨图但没有可靠的 frame transform（${blockedMigrations.join(' / ')}）：保留原 map_id/坐标/范围，不降级为 layout、不搬 old x/y；导航仍按已纠正的 parent，新父图的代理入口由布局阶段补`,
      severity:'warning',retryable:false});
    if(frameBlocked.length)opIssues.push({code:'SCENE_MAP_FRAME_INVALID',path:'$.maps',
      message:`${frameBlocked.length} 张地图幅面无法归一（${frameBlocked.join(' / ')}）：本次不排位、不写 NaN，旧坐标原样保留；按上面 FRAME_INVALID / FRAME_ALIAS_CONFLICT 明细纠正`,
      severity:'warning',retryable:false});
    if(fullMapIds.length)opIssues.push({code:'SCENE_MAP_PLACEMENT_FULL',path:'$.maps',
      message:`${fullMapIds.length} 张地图没有可用空位（${fullMapIds.join(' / ')}）：这些地点保持原坐标，等扩容或作者指定位置；绝不叠到同一点`,
      severity:'warning',retryable:false});
    if(unplacedFrames.length)opIssues.push({code:'SCENE_MAP_UNPLACED',path:'$.locations',
      message:`${unplacedFrames.length} 个地点本次没有排上位（${[...unplacedFrames].sort().join(' / ')}）：旧字段原样保留，下一轮或作者指定后再放`,
      severity:'warning',retryable:true});

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
  // 只有 warning 的组不会拖垮保存；零变更但仍有诊断时也照样回执，避免 remaining 被吞掉。
  if(!changes.length&&!opIssues.length)return null;
  return {id:opId,opIds:[opId],dependsOn:[],readSet:[],mutations:changes,opIssues};
}
