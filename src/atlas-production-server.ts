/** Published dispatch: one SQL writer; legacy documents are migration inputs only. */
import {createAtlasSettingsRoutes} from './atlas-settings-routes.ts';
import {createAtlasSqlRouteGroup} from './atlas-sql-routes.ts';
import {okResult,errorResult} from './atlas-route-result.ts';
import {AtlasError,ATLAS_ERROR_CODES} from './atlas-contract.ts';
import {createDefaultSettingsV2} from './atlas-settings.ts';
export {createNodeSqlHost} from './atlas-node-sql-host.ts';
export {createSqlModelPort} from './atlas-sql-model-port.ts';
import type {AtlasServerCoreDeps,AtlasRequestContext,AtlasSessionDoc} from './atlas-server-contract.ts';
import type {AtlasServerSettingsV2} from './atlas-settings.ts';

export function createAtlasServerCore(deps:AtlasServerCoreDeps){
 let override:AtlasServerSettingsV2|null=null;
 const logs:Record<string,unknown>[]=[];
 const settings=createAtlasSettingsRoutes({store:deps.store,now:deps.now,override:()=>override,log:entry=>logs.push(entry)});
 const sql=createAtlasSqlRouteGroup({repository:deps.sqlRepository??null,sessionProvider:deps.sqlSessionProvider,
  modelPort:deps.sqlModelPort,host:deps.sqlHost,lorebookPort:deps.sqlLorebookPort,buildProjection:deps.sqlBuildProjection,
  now:deps.now,runtime:deps.sqlRuntime});
 async function handle(method:string,path:string,body:unknown,ctx:AtlasRequestContext={}){
  try{
   const route=path.replace(/^\/api\/plugins\/atlas/,'').replace(/\/+$/,'')||'/';
   if(method==='GET'&&route==='/health')return await settings.handleHealth();
   if(method==='GET'&&route==='/settings')return await settings.handleGetSettings(ctx);
   if(method==='PUT'&&route==='/settings')return await settings.handlePutSettings(body,ctx);
   if(route.startsWith('/sql/')){
    if(!ctx.local)throw new AtlasError(ATLAS_ERROR_CODES.FORBIDDEN,'只有本机已登录会话可以访问聊天数据库');
    return await sql.handle(method,route,body,ctx);
   }
   const record=body&&typeof body==='object'&&!Array.isArray(body)?body as Record<string,unknown>:{};
   if(method==='GET'&&route==='/worlds'){
    const worlds=[];
    for(const key of await deps.store.list('world:')){const world=await deps.store.read(key) as Record<string,unknown>|null;if(world)worlds.push({id:world.id,name:world.name,migrationOnly:true});}
    return okResult({worlds});
   }
   if(method==='POST'&&route==='/session/export'){
    if(!ctx.local)throw new AtlasError(ATLAS_ERROR_CODES.FORBIDDEN,'迁移资料仅供本机会话读取');
    const chat=String(record.chatId??''),world=String(record.worldId??'');
    if(!chat||!world)throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD,'迁移需要聊天与世界身份');
    const turns:Record<string,unknown>={};
    const session={schemaVersion:1,rev:0,binding:await deps.store.read(`binding:${chat}`),
     world:await deps.store.read(`world:${world}`),maps:await deps.store.read(`maps:${world}`),scene:await deps.store.read(`scene:${world}`),
     tables:await deps.store.read(`tables:${world}`),simulation:await deps.store.read(`simulation:${world}`),turns,geoAuto:{}};
    for(const key of await deps.store.list(`turn:${chat}:`))session.turns[key]=await deps.store.read(key);
    return okResult({session,found:Boolean(session.world||session.tables)});
   }
   // Old backups remain available for explicit recovery. No production route mutates them.
   if(method==='POST'&&route==='/session/purge')return okResult({purged:false,retained:true,turnDocs:0});
   if(method==='POST'&&route==='/state')return okResult({binding:null,world:null,map:{points:[]},
    currentTime:0,nearbyNpcs:[],npcDirectory:[],objectDirectory:[],sqlMode:false,
    paused:true,notice:'SQL 已暂停。原档保留；重新开启后继续同一数据库，不再运行旧写入链。'});
   throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD,`旧写入入口已退出：${method} ${route}；请使用当前聊天的 SQL 操作。`);
  }catch(error){return errorResult(error);}
 }
 return {handle,logs:()=>logs.map(entry=>({...entry})),
  reconcilePending:async(_session?:AtlasSessionDoc|null)=>({scanned:0,cleaned:0,kept:0,malformed:0,errors:[]}),
  __setSettingsForTest:(next:Partial<AtlasServerSettingsV2>)=>{override={...createDefaultSettingsV2(),...next};},
  sqlMode:()=>({enabled:sql.enabled(),sessions:sql.sessionCount()}),closeSqlSessions:()=>sql.close()};
}
export type AtlasServerCore=ReturnType<typeof createAtlasServerCore>;
export type {AtlasDocumentStore,AtlasRequestContext} from './atlas-server-contract.ts';
