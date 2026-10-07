import {imageAsset} from './atlas-sql-map-assets.ts';
import {inspectSqlWorld} from './atlas-sql-inspect.ts';
/** Explicit SQL map commands; legacy map routes never write this repository. */
import { parseWorld } from '../lib/world-schema.ts';
import { createTableReadPort } from './atlas-db-readport.ts';
import { collectKnownRefs } from './atlas-sql-refs.ts';
import { AtlasDbError } from './atlas-db-runtime.ts';
import { stableHexHash } from './atlas-hash.ts';
import { runSqlTurn, commitPreparedTurn } from './atlas-sql-session.ts';
import type { SqlSession } from './atlas-sql-session.ts';
import type { ModelOperation, TurnInput, SourceSnapshotEntry, PreparedCommit } from './atlas-ops-contract.ts';

const previews=new WeakMap<SqlSession,Map<string,{commit:PreparedCommit;sourceHash:string}>>();

export async function handleSqlMapAction(session:SqlSession,action:string,body:Record<string,unknown>):Promise<Record<string,unknown>> {
  if(body.chatId!==session.chatUid)throw new AtlasDbError('CHAT_CHANGED','地图请求不属于当前聊天',{});
  const sourceHash=stableHexHash(JSON.stringify([body.openingMessageId,body.userText,body.assistantText,body.loreSupplement,body.charDescription,body.personaDescription]));
  if(action==='map/bootstrap'&&body.apply===true){
    const draft=previews.get(session)?.get(String(body.previewId??''));
    if(!draft||draft.sourceHash!==sourceHash||body.baseRevision!==draft.commit.anchor.baseRevision)throw new AtlasDbError('SQL_PREVIEW_EXPIRED','场景预览已失效，需要重新识别',{});
    const result=await commitPreparedTurn(session,draft.commit,typeof body.isCurrent==='function'?body.isCurrent as ()=>boolean:undefined);
    if(!result.coreSaved)throw new AtlasDbError('SESSION_WRITE_FAILED','场景候选未保存，正式世界保持原状',{issues:result.issues});
    previews.get(session)?.delete(String(body.previewId));
    return {coreSaved:true,status:'committed',receipt:result.receipt,issues:result.issues};
  }
  const db=session.repo.db,read=createTableReadPort(db),refs=collectKnownRefs(read,session.branchId);
  const beforeLocations = new Set(read.selectWhere('locations',{branch_id:session.branchId,status:'active'},1000).map(row=>String(row.id)));
  const find=(table:'locations'|'characters'|'items',value:unknown)=>{
    const id=String(value??''),row=read.selectOne(table,session.branchId,id)??read.selectOne(table,session.branchId,id.replace(/^(?:loc|npc|item):/,''))??read.selectOne(table,session.branchId,`${table==='locations'?'loc':table==='characters'?'npc':'item'}:${id}`);
    if(!row)throw new AtlasDbError('REF_UNKNOWN',`目标${table==='locations'?'地点':table==='characters'?'人物':'物品'}不存在`,{});
    return row;
  };
  const ref=(id:unknown)=>{const entry=refs.find(r=>r.id===id);if(!entry)throw new AtlasDbError('REF_UNKNOWN','目标不在本次只读目录中',{});return entry.alias;};
  const map=(value:unknown)=>{
    const key=String(value??''),maps=read.selectWhere('maps',{branch_id:session.branchId,status:'active'},1000);
    const branch=read.selectOne('branches',session.branchId,session.branchId)!;
    const selected=maps.find(m=>m.id===key)|| (key==='world'?maps.find(m=>m.id===branch.root_map_id||!m.container_location_id):maps.find(m=>m.container_location_id===key||m.container_location_id===key.replace(/^loc:/,'')||m.container_location_id===`loc:${key}`));
    if(!selected)throw new AtlasDbError('REF_UNKNOWN','目标地图不存在',{});return selected;
  };
  const operations:ModelOperation[]=[],calibration:TurnInput['mapCalibration']=undefined;
  let mapBackground:TurnInput['mapBackground'];
  let layoutMaps:TurnInput['layoutMaps'];
  let mapCalibration:TurnInput['mapCalibration']=calibration,manual=true,phases:TurnInput['phaseBatches']=[];
  if(action==='map/layout'){
    layoutMaps=[String(map(body.mapId).id)];
  }else if(action==='map/repair'){
    const report=inspectSqlWorld(session);
    if(!report.canApply||body.reportToken!==report.reportToken)throw new AtlasDbError('SQL_PREVIEW_EXPIRED','地图检查报告已变化，请重新检查',{});
  }else if(action==='map/image/set'){
    mapBackground={mapId:String(map(body.mapId??'world').id),asset:body.dataUrl===null?null:await imageAsset(body.dataUrl)};
  }else if(action==='map/move'){
    const raw=String(body.entityId??''),kind=refs.find(r=>r.id===raw||r.id===raw.replace(/^(?:npc|item):/,''))?.kind;
    const table=kind==='item'?'items':'characters',entity=find(table,raw),target=find('locations',body.toPointId);
    if(table==='characters')operations.push({op:'character.upsert',ref:ref(entity.id),data:{location_ref:ref(target.id),position:null},why:'作者纠偏当前位置'});
    else operations.push({op:'item.transfer',ref:ref(entity.id),data:{to:{location_ref:ref(target.id)}},why:'作者纠偏物品位置'});
  }else if(action==='map/topology'){
    const location=find('locations',body.locationId),data:Record<string,unknown>={};
    if(body.operation==='set-parent')data.parent_ref=body.targetLocationId==null?null:ref(find('locations',body.targetLocationId).id);
    else if(body.operation==='set-adjacent'){
      const target=find('locations',body.targetLocationId);
      operations.push({op:'route.propose',ref:`new:adjacent-${location.id}-${target.id}`,data:{from_ref:ref(location.id),to_ref:ref(target.id),kind:'adjacent',bidirectional:true,quality:'confirmed'},why:'作者确认邻接'});
    }else if(body.operation==='confirm-coordinate'){
      const m=map(body.mapId),x=Number(body.gridX),y=Number(body.gridY);
      if(!Number.isFinite(x)||!Number.isFinite(y))throw new AtlasDbError('INVALID_PAYLOAD','坐标必须是有限数字',{});
      Object.assign(data,{map_ref:ref(m.id),position:{x,y,precision:'exact'}});
    }else if(body.operation==='set-vehicle')Object.assign(data,{mobility:body.mobile===false?'fixed':'mobile',anchor_ref:(body.anchorLocationId??body.targetLocationId)==null?null:ref(find('locations',body.anchorLocationId??body.targetLocationId).id)});
    else throw new AtlasDbError('INVALID_PAYLOAD','未知的地图关系确认动作',{});
    if(Object.keys(data).length)operations.push({op:'location.upsert',ref:ref(location.id),data,why:'作者确认地点关系'});
  }else if(action==='map/areas'){
    const location=find('locations',body.locationId),m=map(body.mapId),frame=m.frame_json as {cols?:number;rows?:number};
    if(location.map_id!==m.id)throw new AtlasDbError('INVALID_PAYLOAD','该地点不属于目标地图',{});
    if(!Array.isArray(body.cells)||body.cells.length>256)throw new AtlasDbError('INVALID_PAYLOAD','范围需为最多 256 格的数组',{});
    const cells=body.cells.map(cell=>{const c=cell as {x:number;y:number};
      if(!c||!Number.isInteger(c.x)||!Number.isInteger(c.y)||c.x<0||c.y<0||c.x>=(frame.cols??100)||c.y>=(frame.rows??100))throw new AtlasDbError('INVALID_PAYLOAD','范围格子必须在目标地图内',{});
      return {x:c.x,y:c.y};});
    operations.push({op:'location.upsert',ref:ref(location.id),data:{area:cells.length?{kind:'cells',cells,quality:'confirmed',source:'manual'}:null},why:'作者绘制地点范围'});
  }else if(action==='map/scale'){
    const m=map(body.mapId);
    if(body.userMetersPerCell!==undefined){mapCalibration={mapId:String(m.id),metersPerCell:Number(body.userMetersPerCell),locked:true};}
    else{
      if(m.scale_locked)throw new AtlasDbError('MAP_SCALE_LOCKED','作者已锁定地图尺度，AI 不覆盖该值',{});
      manual=false;phases=['geography'];
    }
  }else if(action==='map/protagonist'){
    const candidates=read.selectWhere('characters',{branch_id:session.branchId,status:'active'},1000),name=String(body.name??body.playerName??'').trim();
    const matches=candidates.filter(c=>c.name===name||Array.isArray(c.aliases_json)&&c.aliases_json.includes(name));
    if(matches.length>1)throw new AtlasDbError('REF_AMBIGUOUS','主角名字匹配了多个档案，不能随机选择',{});
    if(!name)throw new AtlasDbError('INVALID_PAYLOAD','主角名字不能为空',{});
    for(const candidate of candidates.filter(row=>row.role==='protagonist'&&row.name!==name))operations.push({op:'character.upsert',ref:ref(candidate.id),data:{role:'npc'}});
    if(matches.length)operations.push({op:'character.upsert',ref:ref(matches[0].id),data:{role:'protagonist'}});
    else operations.push({op:'character.upsert',ref:'new:player',data:{name,role:'protagonist',importance:'core',identity:'用户主角'}});
  }else if(action==='map/import'){
    if(!body.world||typeof body.world!=='object')throw new AtlasDbError('INVALID_PAYLOAD','导入需要世界文档',{});
    if(!parseWorld(body.world))throw new AtlasDbError('INVALID_PAYLOAD','世界文档格式不合法',{});
    const image=(body.world as {mapImage?:unknown}).mapImage;
    if(typeof image==='string'&&image)mapBackground={mapId:'world',asset:await imageAsset(image)};
  }else if(['map/geo','map/suggest','map/bootstrap'].includes(action)){
    manual=false;phases=action==='map/bootstrap'?['observe']:['geography'];
  }else throw new AtlasDbError('INVALID_PAYLOAD','未知 SQL 地图动作',{});
  const sources:SourceSnapshotEntry[]=[];
  for(const [key,kind] of [['loreSupplement','lorebook'],['assistantText','story'],['charDescription','lorebook'],['personaDescription','user']] as const){
    const value=body[key];if(typeof value==='string'&&value)sources.push({key,kind,text:value,hash:stableHexHash(value)});
  }
  if(action==='map/scale'&&!manual){
    const m=map(body.mapId),scope=JSON.stringify({targetMap:ref(m.id),name:m.name,frame:m.frame_json,currentScale:m.meters_per_cell});
    sources.push({key:'map-task',kind:'estimate',text:`仅用 map.estimate 标定 ${scope}，不要修改其他地图或生成地点。`,hash:stableHexHash(scope)});
  }
  const hash=stableHexHash(JSON.stringify([action,body,sources]));
  const input:TurnInput={anchor:{chatUid:session.chatUid,branchId:session.branchId,parentTurnId:session.repo.internal.currentHeadTurnId(),
    baseRevision:session.repo.internal.currentRevision(),baseStorageRevision:session.repo.storageRevision,hostMessageUid:`author:${action}:${body.requestId??hash}`,variantKey:'author',inputHash:hash},
    userText:String(body.userText??''),assistantText:String(body.assistantText??''),sourceSnapshot:sources,phaseBatches:phases,manual,operations,
    narrativeKind:'manual',sceneMaps:true,sceneOnly:true,layoutMaps,mapCalibration,mapBackground,legacyImport:action==='map/import'?{atlas:{world:body.world,maps:body.maps??null}}:undefined,povName:action==='map/protagonist'?String(body.name??body.playerName??''):undefined,isCurrent:typeof body.isCurrent==='function'?body.isCurrent as ()=>boolean:undefined};
  if(action==='map/bootstrap'&&body.apply===false){
    const commit=await session.repo.prepareTurn(input),previewId=commit.token;
    let drafts=previews.get(session);if(!drafts){drafts=new Map();previews.set(session,drafts);}
    while(drafts.size>=4){const id=drafts.keys().next().value!;await session.repo.discardPrepared(drafts.get(id)!.commit.token);drafts.delete(id);}
    drafts.set(previewId,{commit,sourceHash});
    const candidate=session.repo.getCandidate(previewId)!.db,newLocations=read.selectWhere('locations',{branch_id:session.branchId,status:'active'},1000);
    const previewRead=createTableReadPort(candidate);
    return {coreSaved:false,status:'preview',previewId,baseRevision:input.anchor.baseRevision,
      scene:{resolution:'已识别'},newLocations:previewRead.selectWhere('locations',{branch_id:session.branchId,status:'active'},1000).filter(row=>!newLocations.some(old=>old.id===row.id)).map(row=>({name:row.name})),
      newCharacters:previewRead.selectWhere('characters',{branch_id:session.branchId,status:'active'},1000).filter(row=>row.created_turn_id===commit.receipt.turnId).map(row=>({displayName:row.name})),summary:'确认后写入当前聊天；识别不推进时间'};
  }
  const result=await runSqlTurn(session,input);
  if(!result.coreSaved)throw new AtlasDbError('SESSION_WRITE_FAILED','地图候选未获得宿主保存确认',{issues:result.issues});
  const added = createTableReadPort(session.repo.db).selectWhere('locations',{branch_id:session.branchId,status:'active'},1000).filter(row=>!beforeLocations.has(String(row.id)));
  return {coreSaved:true,pointsAdded:added.filter(row=>row.kind!=='region').length,regionsAdded:added.filter(row=>row.kind==='region').length,status:action==='map/scale'?'calibrated':'committed',message:'已保存到当前聊天的 SQL 数据库',receipt:result.receipt,issues:result.issues};
}
