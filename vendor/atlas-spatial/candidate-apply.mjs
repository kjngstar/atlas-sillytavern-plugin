import {failure,diagnostic} from './contracts.mjs';
/** Apply only inside the host's isolated candidate transaction. Never COMMIT a chat. */
export function applySceneGroup(db,group,ports){
  if(ports?.insideCandidateTransaction!==true)return failure('CANDIDATE_TRANSACTION_REQUIRED','$','只能在宿主已有的候选事务内应用布局');
  if(!group)return {ok:true,status:'duplicate',groups:[],issues:[]};
  if(typeof ports.applyGroups!=='function'||typeof ports.queryBound!=='function'||typeof ports.isCurrent!=='function')return failure('COMMIT_PORT_REQUIRED','$','缺少宿主应用、查询或身份守卫接口');
  if(!ports.isCurrent())return failure('STALE_SCOPE','$.scope','世界已经切换，禁止应用布局');
  if(db.exec('PRAGMA foreign_keys')[0]?.values[0]?.[0]!==1)return failure('FOREIGN_KEYS_OFF','$','需要宿主在开启事务前启用并读回外键');
  for(const r of group.readSet??[]){
    if(!['maps','locations'].includes(r.table))return failure('READ_TABLE_INVALID','$.readSet','布局读集只包含地图和地点');
    const row=ports.queryBound(db,'SELECT row_rev FROM '+r.table+' WHERE branch_id=? AND id=?',[ports.branchId,r.rowId])[0];
    if(row?.row_rev!==r.rowRev)return failure('STALE_ROW','$.readSet','候选行在编译后已改变');
  }
  const savepoint='atlas_spatial_component';db.run('SAVEPOINT '+savepoint);
  try{
    const applied=ports.applyGroups(db,[group],{branchId:ports.branchId,turnId:ports.turnId,attemptId:ports.attemptId??'spatial',validate:true,journal:true});
    const failed=applied.groups.some(g=>g.status==='rejected'||g.status==='blocked')||applied.journalIssues.length>0;
    if(failed){db.run('ROLLBACK TO SAVEPOINT '+savepoint);db.run('RELEASE SAVEPOINT '+savepoint);return {ok:false,status:'failed',groups:applied.groups.map(g=>({...g,status:'rejected',changedRows:0})),issues:[...applied.groups.flatMap(g=>g.issues??[]),...applied.journalIssues.map(message=>diagnostic('JOURNAL_WRITE_FAILED','$.turn_changes',message))]};}
    db.run('RELEASE SAVEPOINT '+savepoint);return {ok:true,status:'applied',groups:applied.groups,issues:[]};
  }catch(e){db.run('ROLLBACK TO SAVEPOINT '+savepoint);db.run('RELEASE SAVEPOINT '+savepoint);return failure(e.code??'SCENE_APPLY_FAILED','$',String(e.message));}
}
