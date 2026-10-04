/** Explicit import into the isolated current turn. Legacy input is read once, never mirrored back. */
import {JOURNALED_TABLES} from './atlas-db-contract.ts';
import type {AtlasTableName} from './atlas-db-contract.ts';
import {queryBound,AtlasDbError} from './atlas-db-runtime.ts';
import type {SqlDatabase} from './atlas-db-runtime.ts';
import {decodeRow} from './atlas-db-codec.ts';
import {inspectLegacySession,migrateLegacyEntities,restoreLegacySceneMaps} from './atlas-db-migrate.ts';
import {recordGroupChanges} from './atlas-db-journal.ts';
import type {GroupResult,Issue,RowMutation} from './atlas-ops-contract.ts';

export function applySqlLegacyImport(input:{db:SqlDatabase;branchId:string;turnId:string;clockS:number;
 nowWallMs:number;rulesetVersion:string;makeId:(kind:string,opId:string,alias:string)=>string;legacy:unknown}):{result:GroupResult;issues:Issue[]} {
 const {db,branchId,turnId}=input,plan=inspectLegacySession(input.legacy);
 if(plan.kind!=='legacy')throw new AtlasDbError('IMPORT_FORMAT_INVALID','请选择有效的旧世界或三表文档；当前数据库存档使用显式 SQL 导入',{});
 const snapshot=()=>new Map(JOURNALED_TABLES.map(name=>{
  const table=name as AtlasTableName,rows=queryBound(db,`SELECT * FROM ${table} WHERE ${table==='branches'?'id':'branch_id'}=?`,[branchId]);
  if(rows.length>10000)throw new AtlasDbError('IMPORT_LIMIT','本次导入变更日志超过单表 10000 行上限，原库保持原状',{});
  return [table,new Map(rows.map(raw=>{const parsed=decodeRow(table,raw,{allowExtra:true});
   if(!parsed.ok)throw new AtlasDbError('IMPORT_DECODE_FAILED','导入基线无法解码',{});
   return [String(raw.id),parsed.row as Record<string,unknown>];}))] as const;
 }));
 const before=snapshot();
 const migrated=migrateLegacyEntities(plan,input.legacy,db,{branchId,turnId,clockS:input.clockS,nowWallMs:input.nowWallMs,rulesetVersion:input.rulesetVersion,makeId:input.makeId});
 if(migrated.issues.some(issue=>issue.severity==='error'))throw new AtlasDbError('IMPORT_REJECTED','旧世界有未解决的引用或结构错误，整份导入候选撤销',{issues:migrated.issues});
 const issues=[...migrated.issues,...restoreLegacySceneMaps(input.legacy,db,{branchId})];
 const after=snapshot(),opId=`legacy_import_${turnId}`,mutations:RowMutation[]=[];
 for(const [table,rows] of after)for(const [id,row] of rows){const old=before.get(table)?.get(id)??null;
  if(JSON.stringify(old)!==JSON.stringify(row))mutations.push({table,rowId:id,before:old,after:row,sourceOpIds:[opId],basis:{kind:'manual',reason:'作者显式导入旧世界；已有稳定身份保留，重复档案跳过',certainty:'confirmed'}});
 }
 const start=Number(queryBound(db,'SELECT COALESCE(MAX(sequence)+1,1) n FROM turn_changes WHERE turn_id=?',[turnId])[0].n);
 const journal=recordGroupChanges(db,{id:opId,opIds:[opId],mutations},{turnId,attemptId:'legacy-import',startSequence:start});
 if(journal.issues.length)throw new AtlasDbError('IMPORT_JOURNAL_FAILED','导入未能完整记录回退日志，候选撤销',{issues:journal.issues});
 return {result:{groupId:opId,opIds:[opId],status:mutations.length?'applied':'duplicate',issues,changedRows:mutations.length},issues};
}
