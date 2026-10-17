import {imageAsset} from './atlas-sql-map-assets.ts';
import {savedTurnHasScene} from './atlas-sql-receipt-evidence.ts';
import {inspectSqlWorld} from './atlas-sql-inspect.ts';
/** Explicit SQL map commands; legacy map routes never write this repository. */
import { parseWorld } from '../lib/world-schema.ts';
import { createTableReadPort, pageAllRows } from './atlas-db-readport.ts';
import { collectKnownRefs } from './atlas-sql-refs.ts';
import { findByNameExact } from './atlas-sql-ref-pages.ts';
import { AtlasDbError } from './atlas-db-runtime.ts';
import { stableHexHash } from './atlas-hash.ts';
import { ATLAS_RUNTIME_LIMITS } from './atlas-runtime-limits.ts';
import { runSqlTurn, commitPreparedTurn } from './atlas-sql-session.ts';
import type { SqlSession } from './atlas-sql-session.ts';
import type { ModelOperation, TurnInput, SourceSnapshotEntry, PreparedCommit, RequiredRef } from './atlas-ops-contract.ts';
import type { WorldCompletionInput, WorldFillStatus } from './atlas-world-contract.ts';
import { SPATIAL_CAPABILITIES } from './atlas-world-contract.ts';
import { SPATIAL_PROFILE_MODES, normalizeRequestedProfileMode } from './atlas-spatial-profile.ts';
import { readWorldFillState } from './atlas-sql-world-completion.ts';
import { completionMapIds, resolveCompletionMaps } from './atlas-world-completion-ownership.ts';
import { readProgressRows, readScanState, rowsInScope, scopeKeyFor, summarizeScope, discoverTargets } from './atlas-construction-progress.ts';
import { summarizeSources, readSourceLedger } from './atlas-construction-sources.ts';
import { selectWorldConstructionSources } from './atlas-sql-world-sources.ts';
import { planNextUnits } from './atlas-construction-scheduler.ts';

const previews=new WeakMap<SqlSession,Map<string,{commit:PreparedCommit;sourceHash:string}>>();

export async function handleSqlMapAction(session:SqlSession,action:string,body:Record<string,unknown>):Promise<Record<string,unknown>> {
  if(body.chatId!==session.chatUid)throw new AtlasDbError('CHAT_CHANGED','地图请求不属于当前聊天',{});
  const sourceHash=stableHexHash(JSON.stringify([body.openingMessageId,body.userText,body.assistantText,body.loreSupplement,body.charDescription,body.personaDescription]));
  if((action==='map/bootstrap'||action==='map/build')&&body.apply===true){
    const draft=previews.get(session)?.get(String(body.previewId??''));
    if(!draft||draft.sourceHash!==sourceHash||body.baseRevision!==draft.commit.anchor.baseRevision)throw new AtlasDbError('SQL_PREVIEW_EXPIRED','场景预览已失效，需要重新识别',{});
    const result=await commitPreparedTurn(session,draft.commit,typeof body.isCurrent==='function'?body.isCurrent as ()=>boolean:undefined);
    if(!result.coreSaved)throw new AtlasDbError('SESSION_WRITE_FAILED','场景候选未保存，正式世界保持原状',{issues:result.issues});
    previews.get(session)?.delete(String(body.previewId));
    return {coreSaved:true,status:'committed',receipt:result.receipt,issues:result.issues};
  }
  const db=session.repo.db,read=createTableReadPort(db);
  // ── P08/R05：先用**真实 ID** 收齐本次动作的必要引用，再分配 alias ──────────
  // 顺序很重要：alias 由「扫描结果 + 必要引用追加」共同决定，必要集合没定型就取 alias，
  // 后面追加的一条会把编号整体挪位，先前写下的 alias 就会改指向。
  const required:RequiredRef[]=[];
  const requireRef=(kind:RequiredRef['kind'],id:unknown)=>{const text=String(id??'').trim();if(text)required.push({kind,id:text});};
  let refsCache:ReturnType<typeof collectKnownRefs>|null=null;
  const refs=()=>refsCache??(refsCache=collectKnownRefs(read,session.branchId,{requiredRefs:required}));
  const beforeLocations = new Set(read.selectWhere('locations',{branch_id:session.branchId,status:'active'},1000).map(row=>String(row.id)));
  const find=(table:'locations'|'characters'|'items',value:unknown)=>{
    const id=String(value??''),row=read.selectOne(table,session.branchId,id)??read.selectOne(table,session.branchId,id.replace(/^(?:loc|npc|item):/,''))??read.selectOne(table,session.branchId,`${table==='locations'?'loc':table==='characters'?'npc':'item'}:${id}`);
    if(!row)throw new AtlasDbError('REF_UNKNOWN',`目标${table==='locations'?'地点':table==='characters'?'人物':'物品'}不存在`,{});
    requireRef(table==='locations'?'location':table==='characters'?'character':'item',row.id);
    return row;
  };
  const ref=(id:unknown)=>{const entry=refs().find(r=>r.id===id);if(!entry)throw new AtlasDbError('REF_UNKNOWN','目标不在本次只读目录中',{});return entry.alias;};
  const map=(value:unknown)=>{
    // REF02：跨页查图——第 51 张之后的图也必须能解析（不抬高 maps 全表 cap 50）。
    const key=String(value??''),maps=pageAllRows(read,'maps',session.branchId,500).filter(row=>String(row.status??'active')==='active');
    const branch=read.selectOne('branches',session.branchId,session.branchId)!;
    const selected=maps.find(m=>m.id===key)|| (key==='world'?maps.find(m=>m.id===branch.root_map_id||!m.container_location_id):maps.find(m=>m.container_location_id===key||m.container_location_id===key.replace(/^loc:/,'')||m.container_location_id===`loc:${key}`));
    if(!selected)throw new AtlasDbError('REF_UNKNOWN','目标地图不存在',{});
    requireRef('map',selected.id);
    return selected;
  };
  const operations:ModelOperation[]=[],calibration:TurnInput['mapCalibration']=undefined;
  const sources:SourceSnapshotEntry[]=[];
  for(const [key,kind] of [['loreSupplement','lorebook'],['assistantText','story'],['charDescription','lorebook'],['personaDescription','user']] as const){
    const value=body[key];if(typeof value==='string'&&value)sources.push({key,kind,text:value,hash:stableHexHash(value)});
  }
  let mapBackground:TurnInput['mapBackground'];
  /** P13/R03 §20：作者显式选择/清除绘图档案。 */
  let mapProfile:TurnInput['mapProfile'];
  let layoutMaps:TurnInput['layoutMaps'];
  let layoutTargetMapId:string|undefined;
  let worldCompletion:WorldCompletionInput|undefined;
  let constructionMode:TurnInput['constructionMode'];
  /** P09B/§16.4：继续建设（程序模式）与本轮的稳定请求身份。 */
  let constructionContinue=false;
  let continueIdentity='';
  let mapCalibration:TurnInput['mapCalibration']=calibration,manual=true,phases:TurnInput['phaseBatches']=[];
  if(action==='map/layout'){
    layoutTargetMapId=String(map(body.mapId).id);
    layoutMaps=[layoutTargetMapId];
  }else if(action==='map/build'){
    // M3-13：显式「建设世界」。manual narrativeKind + sceneOnly —— 只补结构，不推进世界时间。
    const mode:(WorldCompletionInput['mode'])=body.mode==='bootstrap'?'bootstrap':'local';
    const requested=Array.isArray(body.focusLocationIds)?body.focusLocationIds.map(value=>String(value)).filter(Boolean):[];
    if(requested.length>ATLAS_RUNTIME_LIMITS.worldFillTargets)throw new AtlasDbError('INVALID_PAYLOAD',`focusLocationIds 不能超过 ${ATLAS_RUNTIME_LIMITS.worldFillTargets} 个`,{});
    if(mode==='local'&&requested.length===0)throw new AtlasDbError('INVALID_PAYLOAD','局部建设需要至少一个 focusLocationIds',{});
    // 身份错误必须报具体错：焦点只能是本分支真实地点。
    const resolvedFocus=requested.map(value=>String(find('locations',value).id));
    // 显式建设允许调用方带上 baseRevision；带了就必须对得上，否则明确报 STALE_BASE。
    // 不带时由会话按权威 revision 自行构造 anchor（预览路径还会在 apply 时再校验一次）。
    if(body.baseRevision!==undefined&&body.baseRevision!==null){
      const expected=session.repo.internal.currentRevision();
      if(Number(body.baseRevision)!==expected)throw new AtlasDbError('STALE_BASE',`地图建设请求基于过期 revision：请求 ${String(body.baseRevision)}，当前 ${expected}`,{expected,actual:body.baseRevision});
    }
    worldCompletion={mode,focusLocationIds:resolvedFocus,policy:{version:1,density:'balanced',
      maxNewLocations:ATLAS_RUNTIME_LIMITS.newLocationsPerBatch,
      maxNewRoutes:ATLAS_RUNTIME_LIMITS.newRoutesPerBatch,
      maxAdditionalDepth:2}};
    // 分块抽取阶段（M3-15）：只做事实登记，不建设、不布局、不发总体空间请求。
    constructionMode=body.constructionMode==='extract-only'?'extract-only':undefined;
    if(!constructionMode)layoutMaps='active';
    manual=false;phases=['observe'];
    // P09B/§16.4：「继续建设」。不发前台请求，只推进持久队列里的下一单元；无待办时零请求返回。
    if(body.continue===true&&!constructionMode){
      const work=planConstructionDigest(read,session.branchId,mode,resolvedFocus,2,{
        baseRevision:session.repo.internal.currentRevision(),
        headTurnId:String(session.repo.internal.currentHeadTurnId()??''),
      },sources);
      if(!work.hasNext){
        return {coreSaved:false,status:'idle',pending:false,scopeKey:work.scopeKey,
          selectedTargets:0,message:'暂无待处理：持久建设队列里没有下一单元，也没有新目标'};
      }
      phases=[];
      constructionContinue=true;
      continueIdentity=stableHexHash(JSON.stringify(['build-continue',work.scopeKey,work.nextUnitId,work.baseRevision,work.headTurnId]));
    }
  }else if(action==='map/repair'){
    const report=inspectSqlWorld(session);
    if(!report.canApply||body.reportToken!==report.reportToken)throw new AtlasDbError('SQL_PREVIEW_EXPIRED','地图检查报告已变化，请重新检查',{});
  }else if(action==='map/profile'){
    // §20：作者手动选择档案是**显式布局语义变更** —— 只改绘图档案（frame 里的命名空间），
    // 旧 scene 原样保留到下一轮候选成功；不接受"名字像驿站/庭院"这种猜测，
    // 也不给模型开放随手写 frame 的入口：模式必须在合法枚举内，或显式 null 清除。
    const target=String(body.mapId??'world');
    const rawMode=body.mode===undefined?null:body.mode;
    if(rawMode!==null&&normalizeRequestedProfileMode(rawMode)===null){
      throw new AtlasDbError('ENUM_INVALID',`未知的绘图档案：${String(rawMode)}；合法值 ${SPATIAL_PROFILE_MODES.join(' / ')}（或用 null 清除）`,{allowed:[...SPATIAL_PROFILE_MODES]});
    }
    mapProfile={mapId:String(map(target).id),mode:rawMode===null?null:normalizeRequestedProfileMode(rawMode)};
  }else if(action==='map/image/set'){
    mapBackground={mapId:String(map(body.mapId??'world').id),asset:body.dataUrl===null?null:await imageAsset(body.dataUrl)};
  }else if(action==='map/move'){
    // 先用真实 ID 在两张候选表上定位（**不**提前取 alias：必要引用集合没定型就编号会漂移）。
    const raw=String(body.entityId??''),stripped=raw.replace(/^(?:npc|item):/,'');
    const asCharacter=read.selectOne('characters',session.branchId,raw)??read.selectOne('characters',session.branchId,stripped);
    const asItem=asCharacter?null:(read.selectOne('items',session.branchId,raw)??read.selectOne('items',session.branchId,stripped));
    const table=asItem?'items':'characters',entity=find(table,raw),target=find('locations',body.toPointId);
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
    const name=String(body.name??body.playerName??'').trim();
    if(!name)throw new AtlasDbError('INVALID_PAYLOAD','主角名字不能为空',{});
    // REF01/REF05：分页读全分支人物（不受 1,001 行硬上限影响），不再只看前面若干条。
    const candidates=pageAllRows(read,'characters',session.branchId,500).filter(row=>String(row.status??'active')==='active');
    // REF05：精确名称/别名匹配跨页进行；多个同名**一律报歧义**，不默认挑第一个。
    const matches=findByNameExact(read,'characters',session.branchId,name).ids
      .map(id=>read.selectOne('characters',session.branchId,id))
      .filter((row):row is Record<string,unknown>=>row!==null)
      .filter(row=>String(row.status??'active')==='active');
    if(matches.length>1)throw new AtlasDbError('REF_AMBIGUOUS','主角名字匹配了多个档案，不能随机选择',{matches:matches.map(row=>String(row.id))});
    // 本次动作引用到的角色先按真实 ID 登记为必要引用：排序末尾（第 206 个）的主角也能拿到 alias，
    // 不必抬高 characters 每表 200 条的固定上限。
    const demoted=candidates.filter(row=>row.role==='protagonist'&&row.name!==name);
    for(const candidate of demoted)requireRef('character',candidate.id);
    if(matches.length)requireRef('character',matches[0].id);
    for(const candidate of demoted)operations.push({op:'character.upsert',ref:ref(candidate.id),data:{role:'npc'}});
    if(matches.length)operations.push({op:'character.upsert',ref:ref(matches[0].id),data:{role:'protagonist'}});
    else operations.push({op:'character.upsert',ref:'new:player',data:{name,role:'protagonist',importance:'core',identity:'用户主角'}});
  }else if(action==='map/import'){
    if(!body.world||typeof body.world!=='object')throw new AtlasDbError('INVALID_PAYLOAD','导入需要世界文档',{});
    if(!parseWorld(body.world))throw new AtlasDbError('INVALID_PAYLOAD','世界文档格式不合法',{});
    const image=(body.world as {mapImage?:unknown}).mapImage;
    if(typeof image==='string'&&image)mapBackground={mapId:'world',asset:await imageAsset(image)};
  }else if(['map/geo','map/suggest','map/bootstrap'].includes(action)){
    manual=false;
    if(action==='map/bootstrap'){
      layoutMaps='active';
      // M3-13：初建也走同一建设阶段（预览同样在候选里跑），而不是另起一条旧路径。
      // bootstrap 的焦点 = 本分支的顶层地点；完全没有地点时 focus 为空，
      // builder 会返回 null —— 「完全无 world 不造假起点」，等 observe 先登记第一个场所。
      worldCompletion={mode:'bootstrap',focusLocationIds:[],policy:{version:1,density:'balanced',
        maxNewLocations:ATLAS_RUNTIME_LIMITS.newLocationsPerBatch,
        maxNewRoutes:ATLAS_RUNTIME_LIMITS.newRoutesPerBatch,
        maxAdditionalDepth:2}};
      phases=['observe'];
    }else phases=['geography'];
  }else throw new AtlasDbError('INVALID_PAYLOAD','未知 SQL 地图动作',{});
  if(action==='map/scale'&&!manual){
    const m=map(body.mapId),scope=JSON.stringify({targetMap:ref(m.id),name:m.name,frame:m.frame_json,currentScale:m.meters_per_cell});
    sources.push({key:'map-task',kind:'estimate',text:`仅用 map.estimate 标定 ${scope}，不要修改其他地图或生成地点。`,hash:stableHexHash(scope)});
  }
  const hash=stableHexHash(JSON.stringify([action,body,sources]));
  // §16.4：继续动作的请求身份由 scope + 下一单元 + 当前 baseRevision + 当前 head 稳定派生。
  // 同一次动作的双击/网络重试 → 同一身份、同一冻结 body → 只有一个有效任务；
  // 上一批 saved 后 head/revision 都变了 → 下一次 continue 不是上一条的 duplicate。
  const authorLabel=constructionContinue?`${action}/continue`:action;
  const identity=constructionContinue?(String(body.requestId??'').trim()||continueIdentity):(String(body.requestId??'').trim()||hash);
  const input:TurnInput={anchor:{chatUid:session.chatUid,branchId:session.branchId,parentTurnId:session.repo.internal.currentHeadTurnId(),
    baseRevision:session.repo.internal.currentRevision(),baseStorageRevision:session.repo.storageRevision,hostMessageUid:`author:${authorLabel}:${identity}`,variantKey:'author',inputHash:hash},
    userText:String(body.userText??''),assistantText:String(body.assistantText??''),sourceSnapshot:sources,phaseBatches:phases,manual,operations,
    // P08/R05：本次动作按真实 ID 声明的必要引用，交给仓库统一追加进冻结目录。
    requiredRefs:required.length?required:undefined,
    narrativeKind:'manual',sceneMaps:true,sceneOnly:true,layoutMaps,mapCalibration,mapBackground,mapProfile,worldCompletion,constructionMode,constructionContinue,legacyImport:action==='map/import'?{atlas:{world:body.world,maps:body.maps??null}}:undefined,povName:action==='map/protagonist'?String(body.name??body.playerName??''):undefined,isCurrent:typeof body.isCurrent==='function'?body.isCurrent as ()=>boolean:undefined};
  if((action==='map/bootstrap'||action==='map/build')&&body.apply===false){
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
  const readBack=createTableReadPort(session.repo.db);
  const added = readBack.selectWhere('locations',{branch_id:session.branchId,status:'active'},1000).filter(row=>!beforeLocations.has(String(row.id)));
  const build=action==='map/build'?summarizeWorldFill(readBack,session.branchId,worldCompletion):undefined;
  return {coreSaved:true,...(action==='map/layout'?{sceneSaved:savedTurnHasScene(session.repo.db,result.receipt.turnId,layoutTargetMapId)}:{}),pointsAdded:added.filter(row=>row.kind!=='region').length,regionsAdded:added.filter(row=>row.kind==='region').length,status:action==='map/scale'?'calibrated':constructionMode==='extract-only'?'extracted':result.receipt.status,message:constructionMode==='extract-only'?'分块事实已登记；总体建设留到抽取结束后一次执行':'已保存到当前聊天的 SQL 数据库',...(build?{build}:{}),receipt:result.receipt,issues:result.issues};
}

/**
 * P09B/§16.4：「继续建设」的**只读**前置判断。
 *
 * 无待办时必须零请求返回「暂无待处理」，所以这里先用持久进度行算一遍：
 * 有可调度的单元、有本轮能发现的新目标、或还有 pending 目标 → 才真的开回合。
 * 判定与仓库里的计划同源（同一 discoverTargets / planNextUnits / 同一持久 schedulerSeq），
 * 刷新、换聊天、fork 之后读到的都是同一份真实进度，不靠内存计数。
 */
function planConstructionDigest(
  read:ReturnType<typeof createTableReadPort>,
  branchId:string,
  mode:WorldCompletionInput['mode'],
  focusIds:readonly string[],
  maxAdditionalDepth:number,
  state:{baseRevision:number;headTurnId:string},
  sourceSnapshot:readonly SourceSnapshotEntry[],
):{scopeKey:string;hasNext:boolean;nextUnitId:string|null;baseRevision:number;headTurnId:string}{
  const rows=readProgressRows(read,branchId);
  const scopeKey=scopeKeyFor(mode==='bootstrap'?'bootstrap':'local',focusIds);
  const discovery=discoverTargets({tables:read,branchId,scopeKey,focusIds,rows,maxAdditionalDepth});
  const unitRows=rowsInScope(rows,scopeKey,'unit');
  const schedulerSeq=readScanState(rowsInScope(rows,scopeKey,'scope')[0]??null).schedulerSeq;
  const next=planNextUnits(unitRows,1,schedulerSeq);
  const pendingTargets=rowsInScope(rows,scopeKey,'target').filter(row=>row.status==='pending').length;
  const ledger=readSourceLedger(rows,scopeKey);
  const sourceSelection=selectWorldConstructionSources({snapshot:sourceSnapshot,chatId:'continue-preview',branchId,mode:'consume',
    skipChunkKeys:new Set([...ledger.chunks.values()].filter(chunk=>['pending','retry','processed'].includes(chunk.status)).map(chunk=>chunk.chunkKey))});
  const hasSourceWork=sourceSelection.chunks.length>0&&(focusIds.length>0||rowsInScope(rows,scopeKey,'target').some(row=>row.status==='processed'));
  return {
    scopeKey,
    hasNext:Boolean(next.unit)||discovery.enqueueIds.length>0||pendingTargets>0||hasSourceWork,
    nextUnitId:next.unit?.unitId??(hasSourceWork?stableHexHash(sourceSelection.chunks.map(chunk=>chunk.chunkKey).join('\n')):null),
    baseRevision:state.baseRevision,
    headTurnId:state.headTurnId,
  };
}

/**
 * M3-13 / P07：把本次建设状态如实回报给调用方（bootstrap 预览 / 应用都要看得到）。
 *
 * ready 只认程序写入的 frame 状态：HTTP 200 不算 ready；没有被应用就报 deferred。
 * 完成状态**按地点所属的内部图**汇总（共用 resolveCompletionMaps），不再用第一张外部图代表整批；
 * 每张图的状态单独交出，批次 status 只是汇总。没有任何内部图时退回根图上的批次级兼容记录，
 * 但那一条绝不冒充完成状态归属。
 */
function summarizeWorldFill(
  read:ReturnType<typeof createTableReadPort>,
  branchId:string,
  worldCompletion:WorldCompletionInput|undefined,
):Record<string,unknown>{
  const focusIds=[...new Set((worldCompletion?.focusLocationIds??[]).map(String).filter(Boolean))].sort();
  const owners=resolveCompletionMaps(read,branchId,focusIds);
  const ownedMapIds=completionMapIds(owners);
  const root=String(read.selectOne('branches',branchId,branchId)?.root_map_id??'');
  // 没有所属图时只看根图兼容记录；有归属时绝不回头读外部图。
  const targetMaps=ownedMapIds.length>0?ownedMapIds:(root?[root]:[]);
  const states=targetMaps.map(mapId=>({mapId,state:readWorldFillState(read,branchId,mapId)}));
  const recorded=states.filter(entry=>entry.state);
  const needsContainer=owners.some(owner=>owner.needsContainerMap);
  const conflicted=owners.some(owner=>owner.issues.some(item=>item.code==='COMPLETION_CONTAINER_MAP_CONFLICT'));
  let status:WorldFillStatus='deferred';
  let reasonCode:string|null='WORLD_FILL_NOT_WRITTEN';
  if(recorded.length>0){
    const statuses=recorded.map(entry=>entry.state!.status);
    status=statuses.every(value=>value==='ready')?'ready':statuses.some(value=>value==='partial')?'partial':'deferred';
    reasonCode=recorded.find(entry=>entry.state!.reasonCode)?.state!.reasonCode??null;
  }
  if(needsContainer||conflicted){
    if(status==='ready')status='partial';
    reasonCode=reasonCode??(conflicted?'WORLD_FILL_CONTAINER_MAP_CONFLICT':'WORLD_FILL_NEEDS_CONTAINER_MAP');
  }
  const first=recorded.find(entry=>entry.state!.remainingLocationIds.length>0)??recorded[0];
  // P09B/§16.5：队列回执读的是**持久进度行**，不是内存计数 —— 刷新/换聊天后仍报真实进度。
  const queue=worldCompletion
    ? summarizeScope(
        readProgressRows(read,branchId),
        scopeKeyFor(worldCompletion.mode==='bootstrap'?'bootstrap':'local',worldCompletion.focusLocationIds),
        focusIds.length,
        reasonCode,
      )
    : null;
  // P10/R02：来源账本回执（持久行派生）。游标是「连续成功前缀」，不是内存计数。
  const sources=worldCompletion
    ? summarizeSources(
        readProgressRows(read,branchId),
        scopeKeyFor(worldCompletion.mode==='bootstrap'?'bootstrap':'local',worldCompletion.focusLocationIds),
      )
    : null;
  const sceneTally={ready:0,partial:0,missing:0};
  for(const entry of states){
    if(entry.state?.status==='ready')sceneTally.ready+=1;
    else if(entry.state?.status==='partial')sceneTally.partial+=1;
    else sceneTally.missing+=1;
  }
  return {
    mode:worldCompletion?.mode??null,
    focusLocationIds:focusIds.slice(0,ATLAS_RUNTIME_LIMITS.worldFillTargets),
    status,
    reasonCode,
    createdLocationIds:first?.state?.createdLocationIds??[],
    createdRouteIds:first?.state?.createdRouteIds??[],
    remainingLocationIds:first?.state?.remainingLocationIds??[],
    // 完成状态所属图（内部图）；没有归属就如实为 null，不谎报外部图。
    completionMapId:ownedMapIds[0]??null,
    completionMapIds:ownedMapIds,
    focusMapId:ownedMapIds[0]??(ownedMapIds.length===0&&!needsContainer&&!conflicted?root||null:null),
    /** P10/R02：来源消费账本（sources/chunks/连续成功前缀/处理字符数）。 */
    sources,
    /** 逐图状态：批次 status 只是汇总，客户端可据这里决定对哪张图接着调 map/layout。 */
    mapStatuses:states.map(entry=>({mapId:entry.mapId,status:entry.state?.status??'unrecorded'})),
    /** §16.5：场景 ready / partial / missing 单独汇总。 */
    sceneSummary:sceneTally,
    /** §16.5：本批队列回执（选择目标数 / 有效处理数 / 待处理数 / 来源块数 / 重试单元数 / 延期原因）。 */
    ...(queue?{queue}:{}),
    /**
     * P11/R03 §18：程序**实际支持**的空间契约能力（权威在 atlas-world-contract.ts）。
     * 回执按真实常量下发，报告与测试都不许手写一份「已实现能力」清单。
     */
    capabilities:[...SPATIAL_CAPABILITIES],
  };
}
