/** Optional Node transport stores the same per-chat envelope, never a second world mirror. */
import {createBrowserSqlHost} from './atlas-browser-sql-host.ts';
import type {AtlasDocumentStore} from './atlas-server-contract.ts';
import type {AtlasSqlRuntime,SqlSession} from './atlas-sql-session.ts';
import type {AtlasModelPort} from './atlas-db-contract.ts';
export function createNodeSqlHost(options:{store:AtlasDocumentStore;runtime:AtlasSqlRuntime;modelPort:AtlasModelPort}){
 const entries=new Map<string,{record:{chatUid:string;chatMetadata:Record<string,unknown>;saveMetadata:()=>Promise<boolean>};
  provider:ReturnType<typeof createBrowserSqlHost>;fingerprint:string}>();
 const key=(chat:string)=>`sql-chat:${chat}`;
 async function entryFor(chat:string){
  let saved=await options.store.read(key(chat));
  if(!saved){
   const binding=await options.store.read(`binding:${chat}`) as {worldId?:string}|null;
   const worldId=binding?.worldId;
   saved=worldId?{atlas:{schemaVersion:1,rev:0,binding,world:await options.store.read(`world:${worldId}`),
    maps:await options.store.read(`maps:${worldId}`),tables:await options.store.read(`tables:${worldId}`),
    simulation:await options.store.read(`simulation:${worldId}`),turns:{},geoAuto:{}}}:{};
  }
  const fingerprint=JSON.stringify(saved),existing=entries.get(chat);
  if(existing){if(existing.fingerprint!==fingerprint){existing.record.chatMetadata=saved as Record<string,unknown>;existing.fingerprint=fingerprint;}return existing;}
  // Do not close a database under an in-flight request when a different chat opens.
  if(entries.size>=128)throw Object.assign(new Error('SQL 会话缓存达到 128 个聊天；重启服务后可继续'),{code:'SQL_SESSION_LIMIT'});
  const record={chatUid:chat,chatMetadata:saved as Record<string,unknown>,saveMetadata:async()=>{
   await options.store.write(key(chat),record.chatMetadata);entry.fingerprint=JSON.stringify(record.chatMetadata);return true;
  }};
  const provider=createBrowserSqlHost({enabled:()=>true,context:()=>record,modelPort:options.modelPort,loadRuntime:async()=>options.runtime});
  const entry={record,provider,fingerprint};entries.set(chat,entry);return entry;
 }
 return {enabled:()=>true,runtime:async()=>options.runtime,
  session:async(chat:string,branch?:string)=>(await entryFor(chat)).provider.session(chat,branch),
  saved:(session:SqlSession)=>entries.get(session.chatUid)?.provider.saved(session),
  close:async()=>{await Promise.all([...entries.values()].map(entry=>entry.provider.close()));entries.clear();}};
}
