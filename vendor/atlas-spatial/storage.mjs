import {FRAME_SCENE_KEY,FRAME_SPACE_CANONICAL_KEY,SPACE_CANONICAL_MAX_FURNISHING,clone,plain,checkSceneDocument,sameScope,diagnostic,failure,bytes,LIMITS,stable,spaceLocalId,parseSpaceLocalId} from './contracts.mjs';
function record(v){if(typeof v==='string')return JSON.parse(v);if(plain(v))return clone(v);throw new Error('FRAME_INVALID');}
const sizesAgree=(a,b)=>!!a&&!!b&&Math.abs(a.widthM-b.widthM)/Math.max(a.widthM,b.widthM,1e-9)<=0.005&&Math.abs(a.heightM-b.heightM)/Math.max(a.heightM,b.heightM,1e-9)<=0.005;
/**
 * P12/R03 §19.2：从**已编译场景**派生本空间权威（尺寸 + 陈设账本）。
 *
 * - 尺寸顺序（§19.2）：作者确认（`authorSize`，由宿主把解析结果交进来）→ 场景量得 → 沿用旧账本。
 *   作者确认与已确认的旧账本**矛盾**时两边事实都保留：账本不被生成器改写（宿主侧列 `SPACE_SIZE_CONFLICT`）。
 * - 陈设条目按 `space:<locationId>:furn:<局部 id>` 命名；`itemId` 取场景里已通过登记表校验的物品。
 * - 上一版有、本轮放不下的条目**保留**（不因换图删家具）；`revision` 只在内容真的变化时 +1。
 */
export function canonicalForScene(scene,previous,locationId,authorSize,deletedContents=[]){
  const layout=plain(scene.layout)?scene.layout:{},bounds=plain(layout.bounds)?layout.bounds:null;
  const measured=(scene.units!=='cells'&&bounds&&Number.isFinite(bounds.w)&&Number.isFinite(bounds.h)&&bounds.w>0&&bounds.h>0)?{widthM:bounds.w,heightM:bounds.h}:null;
  const prevSize=plain(previous?.size)?previous.size:null;
  const prevBasis=prevSize&&plain(prevSize.basis)?{...prevSize.basis}:{kind:prevSize?'first-estimate':'first-estimate',referenceId:null,note:''};
  const author=plain(authorSize)&&Number.isFinite(authorSize.widthM)&&authorSize.widthM>0&&Number.isFinite(authorSize.heightM)&&authorSize.heightM>0?authorSize:null;
  let size=prevSize?{...prevSize,basis:prevBasis}:null;
  if(author){
    if(prevSize&&prevSize.quality==='confirmed'&&!sizesAgree(prevSize,author)){
      // §19.2：双方都确认且矛盾 —— 保留已保存事实，生成器不改写权威记录（由宿主列冲突让作者裁决）。
      size={...prevSize,basis:prevBasis};
    }else{
      size={widthM:author.widthM,heightM:author.heightM,quality:'confirmed',locked:prevSize?.locked===true,basis:{kind:'author',referenceId:typeof author.referenceId==='string'?author.referenceId:null,note:typeof author.note==='string'?author.note:'作者确认尺寸'}};
    }
  }else if(measured){
    const agrees=sizesAgree(prevSize,measured);
    if(prevSize&&(prevSize.quality==='confirmed'||prevSize.locked===true)&&!agrees){
      // 作者确认/锁定尺寸是事实：生成器不改写它（冲突由宿主侧列来源并报 SPACE_SIZE_CONFLICT）。
      size={...prevSize,basis:prevBasis};
    }else if(agrees){
      size={...prevSize,basis:prevBasis};
    }else{
      size={widthM:measured.widthM,heightM:measured.heightM,quality:'estimated',locked:false,basis:prevSize&&plain(prevSize.basis)?{...prevSize.basis}:{kind:'first-estimate',referenceId:null,note:'由本图已生成布局回写'}};
    }
  }
  // 场景里 floor 的陈设落在 layout.groups（每件含 bodies），不是 constraints.contents —— 账本读的是**画面**。
  const groups=Array.isArray(layout.groups)?layout.groups.filter(g=>plain(g)&&g.roomId===locationId):[];
  const items=Array.isArray(layout.items)?layout.items.filter(plain):[];
  const itemBySupport=new Map();
  for(const item of items){
    const on=typeof item.on==='string'&&item.on?item.on:(typeof item.containerId==='string'&&item.containerId?item.containerId:null);
    if(typeof item.id==='string'&&item.id&&on&&!itemBySupport.has(on))itemBySupport.set(on,item.id);
  }
  const prevList=Array.isArray(previous?.furnishing)?previous.furnishing.filter(plain):[];
  const prevByLocal=new Map(prevList.filter(e=>typeof e.localId==='string').map(e=>[e.localId,e]));
  const furnishing=[],seen=new Set();let droppedPrev=0;
  for(const content of groups){
    if(typeof content.id!=='string'||!content.id)continue;
    const parsedId=parseSpaceLocalId(content.id);
    const localId=parsedId?.locationId===locationId?content.id:spaceLocalId(locationId,content.id);
    if(seen.has(localId))continue;seen.add(localId);
    const prev=prevByLocal.get(localId);
    const widthM=Number.isFinite(content.w)&&content.w>0?content.w:(prev&&Number.isFinite(prev.widthM)?prev.widthM:0.2);
    const heightM=Number.isFinite(content.h)&&content.h>0?content.h:(prev&&Number.isFinite(prev.heightM)?prev.heightM:0.2);
    furnishing.push({localId,type:typeof content.type==='string'&&content.type?content.type:(prev?.type??'decor'),name:typeof content.name==='string'&&content.name?content.name:(prev?.name??content.id),itemId:itemBySupport.get(content.id)??null,widthM,heightM,quality:prev?.quality==='confirmed'?'confirmed':'layout'});
  }
  for(const prev of prevList){
    if(deletedContents.includes(prev.localId)||deletedContents.includes(parseSpaceLocalId(prev.localId)?.contentId))continue;
    if(typeof prev.localId!=='string'||seen.has(prev.localId))continue;
    if(furnishing.length>=SPACE_CANONICAL_MAX_FURNISHING){droppedPrev+=1;continue;}
    furnishing.push(prev);seen.add(prev.localId);
  }
  const changed=!previous||stable(previous.size??null)!==stable(size)||stable(previous.furnishing??[])!==stable(furnishing);
  const revision=previous&&Number.isInteger(previous.revision)&&previous.revision>=0?(changed?previous.revision+1:previous.revision):1;
  return {version:1,locationId,revision,size,furnishing,droppedPrev};
}
export function readSceneFrame(frame,{branchId,mapId}={}){
  try{const doc=record(frame)[FRAME_SCENE_KEY];if(doc===undefined)return {ok:true,scene:null,issues:[]};const issues=checkSceneDocument(doc);if(doc.branchId!==branchId||doc.mapId!==mapId)issues.push(diagnostic('SCENE_SCOPE_MISMATCH','$.atlasScene','场景与当前地图/分支不匹配'));return {ok:issues.length===0,scene:issues.length?null:clone(doc),issues};}catch{return failure('FRAME_JSON_INVALID','$.frame_json','地图框架无法读取，未覆盖原记录');}
}
/** Returns a normal maps RowMutation. Never begins a transaction or writes a database. */
export function buildSceneMutation({result,mapRow,scope,currentScope,turnId,operationId,expectedRowRev,spaceSize}={}){
  try{
    if(!sameScope(scope,currentScope)||!sameScope(result?.guard?.scope,scope))return failure('STALE_SCOPE','$.scope','生成期间会话、视角或修订发生变化');
    if(!result?.ok||!result.scene)return failure('SCENE_RESULT_FAILED','$.result','失败的布局不得覆盖原场景');
    if(mapRow?.branch_id!==scope.branchId||mapRow?.id!==result.scene.mapId)return failure('SCENE_SCOPE_MISMATCH','$.mapRow','地图行不属于本次生成作用域');
    if(mapRow.row_rev!==expectedRowRev)return failure('STALE_ROW','$.expectedRowRev','地图行已经被其他变更修改');
    if(typeof turnId!=='string'||!turnId||typeof operationId!=='string'||!operationId)return failure('COMMIT_ANCHOR_REQUIRED','$.turnId','需要程序分配的楼层与操作标识');
    const checks=checkSceneDocument(result.scene);if(checks.length)return {ok:false,status:'failed',issues:checks};
    const before=clone(mapRow),frame=record(mapRow.frame_json),old=frame[FRAME_SCENE_KEY];
    if(stable(old??null)===stable(result.scene)&&!frame.atlasLayoutRequest)return {ok:true,status:'duplicate',mutation:null,issues:result.issues??[]};
    const issues=[...(result.issues??[])];
    frame[FRAME_SCENE_KEY]=clone(result.scene);
    if(result.plannedSize){
      frame.cols=result.plannedSize.widthM/.25;frame.rows=result.plannedSize.heightM/.25;
      frame.reference_width_cells=frame.cols;frame.reference_height_cells=frame.rows;
    }
    delete frame.atlasLayoutRequest;
    // P12/R03 §19.1：空间权威与场景在**同一条 maps 变更**里写回 —— ACK 前不发布半边变化，
    // 失败时整条变更都不落盘，因此 canonical 不会与场景脱节。超限时保留原记录（不裁剪、不放宽预算）。
    const containerId=typeof mapRow.container_location_id==='string'&&mapRow.container_location_id?mapRow.container_location_id:null;
    if(containerId){
      const prevRaw=frame[FRAME_SPACE_CANONICAL_KEY];
      const previous=plain(prevRaw)&&prevRaw.version===1&&prevRaw.locationId===containerId?prevRaw:null;
      // §19.2 顺序第一：**作者确认尺寸**由宿主解析后交进来（`resolveMapSpaceSize().resolution.source==='author'`），
      // 生成器只记录事实与来源，不自己再估一次，也不覆盖已确认的矛盾事实。
      const authorSize=plain(spaceSize?.resolution)&&spaceSize.resolution.source==='author'
        ?{widthM:spaceSize.resolution.widthM,heightM:spaceSize.resolution.heightM,referenceId:plain(spaceSize.resolution.basis)&&typeof spaceSize.resolution.basis.referenceId==='string'?spaceSize.resolution.basis.referenceId:null,note:'作者确认的地点轮廓'}
        :null;
      const next=canonicalForScene(result.scene,previous,containerId,authorSize,result.deletedContents);
      if(next.furnishing.length>SPACE_CANONICAL_MAX_FURNISHING||next.droppedPrev>0){
        issues.push(diagnostic('SPACE_FURNISHING_DEFERRED','$.'+FRAME_SPACE_CANONICAL_KEY,'本空间陈设条目超过首版上限 '+SPACE_CANONICAL_MAX_FURNISHING+'（本轮还需丢弃 '+next.droppedPrev+' 条既有条目）：明确 deferred 并保留原账本（不静默裁剪）',{severity:'warning',entityId:containerId}));
      }else{
        const probe=record(frame);probe[FRAME_SPACE_CANONICAL_KEY]=clone(next);
        if(bytes(probe)<=LIMITS.sceneBytes+65536)frame[FRAME_SPACE_CANONICAL_KEY]=next;
        else issues.push(diagnostic('SPACE_CANONICAL_TOO_LARGE','$.'+FRAME_SPACE_CANONICAL_KEY,'空间权威写入后超出框架预算：保留原账本，不放宽 LIMITS.sceneBytes',{severity:'warning',entityId:containerId}));
      }
    }
    if(bytes(frame)>LIMITS.sceneBytes+65536)return failure('FRAME_TOO_LARGE','$.frame_json','框架与细节总量超限，保留原行');
    const after={...before,frame_json:frame,row_rev:before.row_rev+1,updated_turn_id:turnId};
    const metric=result.metricProposal;
    if(metric){if(Number(before.scale_locked)===1)return failure('SCALE_LOCKED','$.mapRow.scale_locked','不能覆盖锁定比例尺');after.meters_per_cell=metric.metersPerCell;after.scale_quality=metric.scaleQuality;after.scale_basis_json=metric.basis;after.calibration_rev=Number(before.calibration_rev??0)+1;}
    return {ok:true,status:'prepared',issues,mutation:{table:'maps',rowId:before.id,before,after,sourceOpIds:[operationId],basis:{kind:'layout',generator:result.scene.generator,mapId:before.id,sourceRevision:scope.revision}}};
  }catch(e){return failure(String(e.message),'$.mapRow','无法构造地图变更，原行未修改');}
}
/** Locations remain authoritative. This is a candidate-only projection, never a SQL write. */
export function sceneLocationGeometry(scene){
  // 布局空间 → 格坐标只换算一次：格制场景本来就是格，米制场景才除以 metersPerCell（绝不乘两次）。
  const scale=scene.units==='cells'?1:scene.metersPerCell;
  if(!(scale>0))return [];
  const layout=scene.layout;
  // 概览只映射真实已登记 zone；feature 永远没有 SQL 身份，proxy 入口只存在于场景里（07 §3）。
  // P06/N01：`layout.selfArea`（当前地图容器自身的范围示意）**故意不在**这里 —— 它不是新地点，
  // 回写它会把容器搬进它自己的内部坐标系、甚至改错容器的 map_id / 父图坐标。
  // P11/R03 §18.2 第 8 条：绑定的命名走廊要回写对应地点的几何；
  // 纯辅助通道（没有实体身份）和自身示意一样**不回写**，绝不凭空造一个 SQL 地点。
  const corridorBound=layout.kind==='floor'&&layout.corridor&&typeof layout.corridor.entityId==='string'&&layout.corridor.entityId
    ? [{...layout.corridor,id:layout.corridor.entityId}]:[];
  const parts=layout.kind==='floor'?[...layout.rooms,...(layout.areas??[]),...corridorBound]
    :layout.kind==='city'?[...layout.districts,...layout.buildings.filter(b=>!b.decorative)]
      :(layout.shapes??[]).filter(s=>s&&s.placement!=='proxy');
  const centroid=polygon=>{let x=0,y=0;for(const q of polygon){x+=q.x;y+=q.y;}return {x:x/polygon.length,y:y/polygon.length};};
  return parts.filter(p=>p.placement!=='proxy').map(p=>{const polygon=Array.isArray(p.polygon)?p.polygon.map(q=>Array.isArray(q)?{x:q[0],y:q[1]}:q):[{x:p.x,y:p.y},{x:p.x+p.w,y:p.y},{x:p.x+p.w,y:p.y+p.h},{x:p.x,y:p.y+p.h}];
    // 确认站点优先于多边形质心：已确认的点不能被估计轮廓重新落位。
    const locked=p.locked&&Number.isFinite(p.locked.x)&&Number.isFinite(p.locked.y)?p.locked:null;
    const point=locked??p.site??centroid(polygon);
    const confirmed=p.quality==='confirmed'||!!locked;
    return {entityId:p.id,mapId:scene.mapId,gridX:point.x/scale,gridY:point.y/scale,precision:confirmed?'exact':'layout',area:{kind:'polygon',points:polygon.map(q=>({x:q.x/scale,y:q.y/scale})),quality:p.quality==='confirmed'?'confirmed':'estimated',source:p.quality==='confirmed'?'author':'estimate'}};
  });
}
