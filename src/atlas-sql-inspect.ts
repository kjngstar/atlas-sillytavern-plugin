/** Read-only integrity report; repairing missing maps uses the normal candidate journal. */
import {foreignKeyCheck,queryBound} from './atlas-db-runtime.ts';
import {stableHexHash} from './atlas-hash.ts';
import type {SqlSession} from './atlas-sql-session.ts';
export function inspectSqlWorld(session:SqlSession){
 const branch=session.repo.internal.branchRow()!,db=session.repo.db,b=session.branchId;
 const counts=queryBound(db,'SELECT (SELECT COUNT(*) FROM locations WHERE branch_id=?) locations,(SELECT COUNT(*) FROM characters WHERE branch_id=?) characters,(SELECT COUNT(*) FROM items WHERE branch_id=?) items',[b,b,b])[0];
 const missing=queryBound(db,"SELECT l.id FROM locations l WHERE l.branch_id=? AND l.status='active' AND NOT EXISTS (SELECT 1 FROM maps m WHERE m.branch_id=l.branch_id AND m.container_location_id=l.id AND m.status='active')",[b]);
 const foreignKeys=foreignKeyCheck(db),rootMissing=Number(counts.locations)>0&&!branch.root_map_id;
 return {database:true,...counts,missingMapIds:missing.map(row=>String(row.id)),rootMissing,foreignKeys,
  canApply:foreignKeys.length===0&&(missing.length>0||rootMissing),
  reportToken:stableHexHash(JSON.stringify([session.repo.storageRevision,session.repo.internal.currentRevision(),session.repo.internal.currentHeadTurnId(),missing,branch.root_map_id])),
  reason:foreignKeys.length?'存在引用错误；保存候选会拒绝该状态，请从完整备份恢复':missing.length||rootMissing?'部分地点缺少内部地图，可重建地图结构并记录回退':'地点、人物、物品和地图引用检查通过'};
}
