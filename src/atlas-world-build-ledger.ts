/** Read persisted window identity and transport evidence; never infer missing sends. */
import { queryBound, type SqlDatabase } from './atlas-db-runtime.ts';
import { sanitizeModelCallAudit } from './atlas-model-call-audit.ts';

const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const parse=(v:unknown):Record<string,unknown>=>{try{return object(typeof v==='string'?JSON.parse(v):v);}catch{return {};}};
export function readWorldBuildTurnLink(decisions:unknown) {
  const raw=object(parse(decisions)['world_build']);
  if(raw['version']!==undefined&&raw['version']!==1)return null;
  if(typeof raw['jobId']!=='string'||!raw['jobId']||raw['jobId'].length>256)return null;
  const window=raw['window']===true||raw['aborted']===true;
  const seq=raw['windowSequence'];
  return {jobId:raw['jobId'],window,aborted:raw['aborted']===true,
    windowSequence:window&&typeof seq==='number'&&Number.isSafeInteger(seq)&&seq>0?seq:null,
    originFloorId:typeof raw['originFloorId']==='string'?raw['originFloorId']:null};
}

/** Job origins are SQL turn IDs. Internal build turns inherit their narrative ancestor. */
export function resolveBuildOriginHost(db:SqlDatabase,branchId:string,turnId:string|null):string|null {
  const seen=new Set<string>();let id=turnId;
  while(id&&!seen.has(id)&&seen.size<128){
    seen.add(id);
    const row=queryBound(db,'SELECT host_message_uid,parent_turn_id FROM turns WHERE branch_id=? AND id=?',[branchId,id])[0];
    if(!row)return null;
    const host=typeof row['host_message_uid']==='string'?row['host_message_uid']:'';
    if(host&&!host.startsWith('world-build:'))return host;
    id=typeof row['parent_turn_id']==='string'?row['parent_turn_id']:null;
  }
  return null;
}

export function readBuildAuditSummary(db:SqlDatabase,branchId:string,jobId:string) {
  const rows=queryBound(db,'SELECT decisions_json,receipt_json FROM turns WHERE branch_id=? AND decisions_json LIKE ?',[branchId,'%'+jobId+'%']);
  let available=false,complete=true;
  const reasons=new Map<string,Set<number>>();
  for(const row of rows){
    const link=readWorldBuildTurnLink(row['decisions_json']);
    if(link?.jobId!==jobId||!link.window||link.windowSequence===null)continue;
    const audit=sanitizeModelCallAudit(parse(row['receipt_json'])['requestAudit']);
    if(!audit){complete=false;continue;}
    available=true;if(audit.droppedCalls>0)complete=false;
    for(const call of audit.calls){
      if(call.reason==='scheduled')continue;
      const windows=reasons.get(call.reason)??new Set<number>();windows.add(link.windowSequence);reasons.set(call.reason,windows);
    }
  }
  return {ledgerAvailable:available,extraReasons:available&&complete?[...reasons].sort(([a],[b])=>a.localeCompare(b)).map(([reason,windows])=>({reason,windows:windows.size})):null};
}
