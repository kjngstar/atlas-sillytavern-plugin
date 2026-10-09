/** Resume saved background work without repeating the narrative or elapsed time. */
import { AtlasDbError, queryBound, runBound, foreignKeyCheck } from './atlas-db-runtime.ts';
import { withChatCommitLock } from './atlas-db-queue.ts';
import { validateCandidate } from './atlas-db-invariants.ts';
import { settleSqlTurn } from './atlas-sql-simulation.ts';
import { persistSqlSession } from './atlas-sql-session.ts';
import { enqueueProjectionSync, projectionHash } from './atlas-db-outbox.ts';
import { recordGroupChanges } from './atlas-db-journal.ts';
import { ATLAS_RUNTIME_LIMITS } from './atlas-runtime-limits.ts';
import { bindModelBudget, createGenerationBudget } from './atlas-sql-generation-budget.ts';
import type { SqlSession } from './atlas-sql-session.ts';
import type { TurnReceipt } from './atlas-ops-contract.ts';

export async function runSqlResume(session: SqlSession, input: {turnId:string;isCurrent?:()=>boolean}) {
  return withChatCommitLock(session.chatUid,async()=>{
    const assertCurrent=()=>{
      if (session.closed || session.isCurrentHost && !session.isCurrentHost()) throw new AtlasDbError('SESSION_STALE','后台继续结算宿主已变化',{});
      if (input.isCurrent && !input.isCurrent()) throw new AtlasDbError('TURN_CANCELLED','后台继续结算楼层已变化',{});
      if (session.repo.internal.currentHeadTurnId()!==input.turnId) throw new AtlasDbError('RETRY_BASE_CHANGED','只能继续当前楼层的后台结算',{});
    };
    assertCurrent();
    const row=queryBound(session.repo.db,'SELECT * FROM turns WHERE id=? AND branch_id=?',[input.turnId,session.branchId])[0];
    if (!row) throw new AtlasDbError('REF_UNKNOWN','原结算回合不存在',{});
    const receipt=JSON.parse(String(row.receipt_json)) as TurnReceipt;
    const branch=queryBound(session.repo.db,'SELECT * FROM branches WHERE id=?',[session.branchId])[0];
    if (branch.simulation_status!=='catching_up') return {receipt,coreSaved:true,issues:[],duplicate:true};
    const anchor={...receipt.anchor,parentTurnId:input.turnId,baseRevision:session.repo.internal.currentRevision(),baseStorageRevision:session.repo.storageRevision};
    const candidate=await session.repo.createCandidate(anchor,'maintenance');
    try {
      const simulation=await settleSqlTurn({db:candidate.db,branchId:session.branchId,anchor,turnId:input.turnId,
        clockBefore:Number(branch.clock_s),operations:[],modelPort:session.modelPort ? bindModelBudget(session.modelPort, createGenerationBudget(), 'background') : null,
        modelBudget:ATLAS_RUNTIME_LIMITS.foregroundModelBatchesPerTurn,makeId:session.repo.internal.makeId,
        isCurrent:()=>{assertCurrent();return true;},attemptKey:`resume_${anchor.baseStorageRevision}`});
      assertCurrent();
      if (anchor.baseRevision!==session.repo.internal.currentRevision()||anchor.baseStorageRevision!==session.repo.storageRevision) throw new AtlasDbError('STALE_BASE','后台等待期间快照已变化',{});
      const previous=queryBound(candidate.db,'SELECT * FROM branches WHERE id=?',[session.branchId])[0];
      runBound(candidate.db,'UPDATE branches SET simulation_cursor_s=?,simulation_status=? WHERE id=?',
        [simulation.simulatedUntil,simulation.catchingUp?'catching_up':'current',session.branchId]);
      const after=queryBound(candidate.db,'SELECT * FROM branches WHERE id=?',[session.branchId])[0];
      const seq=Number(queryBound(candidate.db,'SELECT COALESCE(MAX(sequence),0) AS n FROM turn_changes WHERE turn_id=?',[input.turnId])[0].n)+1;
      const opId=`resume_status_${anchor.baseStorageRevision}`;
      const journal=recordGroupChanges(candidate.db,{id:opId,opIds:[opId],mutations:[{table:'branches',rowId:session.branchId,before:previous,after,sourceOpIds:[opId],basis:{kind:'simulation'}}]},
        {turnId:input.turnId,attemptId:opId,startSequence:seq});
      if (journal.issues.length) throw new AtlasDbError('JOURNAL_WRITE_FAILED','继续结算无法记录回退',{});
      const pendingCodes=new Set(['MODEL_REQUEST_FAILED','MODEL_BUDGET_EXHAUSTED','ACTOR_BUDGET_EXHAUSTED','OUTCOME_DEFERRED','OUTCOME_PENDING']);
      receipt.issues=receipt.issues.filter(i=>!pendingCodes.has(i.code)); receipt.issues.push(...simulation.issues);
      receipt.groups.push(...simulation.groups); receipt.simulatedUntilS=simulation.simulatedUntil;
      receipt.worldChanged ||= simulation.worldChanged;
      receipt.status=simulation.catchingUp||receipt.groups.some(g=>g.status==='rejected'||g.status==='blocked')?'partial':'committed';
      const history=JSON.parse(String(row.decisions_json));
      history.operations.push(...simulation.modelOperations.map(op=>op.value));
      history.operation_meta.push(...simulation.modelOperations.map(({opId,line,rawHash})=>({opId,line,rawHash})));
      history.operation_context=(history.operation_context??[]).concat(simulation.operationContexts);
      history.simulation_steps=(history.simulation_steps??[]).concat(simulation.steps);
      history.pending_actors=simulation.pendingActors;
      history.random_draws=(history.random_draws??[]).concat(simulation.randomDraws);
      for (const [key,op] of [['attention_decisions','attention.propose'],['outcome_decisions','event.propose']]) history[key]=(history[key]??[]).concat(simulation.modelOperations.filter(o=>o.value.op===op).map(o=>o.value));
      runBound(candidate.db,'UPDATE turns SET receipt_json=?,decisions_json=?,status=? WHERE id=?',[JSON.stringify(receipt),JSON.stringify(history),receipt.status,input.turnId]);
      const check=validateCandidate(candidate.db,{branchId:session.branchId});
      if (!check.ok||foreignKeyCheck(candidate.db).length) throw new AtlasDbError('INVARIANT_FAILED','后台继续结算候选校验失败',{violations:check.violations});
      if (simulation.worldChanged) enqueueProjectionSync(candidate.db,{branchId:session.branchId,turnId:input.turnId,targetRevision:anchor.baseRevision,
        projectionScope:'pov',payloadHash:projectionHash({resume:input.turnId,storageRevision:anchor.baseStorageRevision}),nowWallMs:session.now(),
        makeId:key=>session.repo.internal.makeId('outbox',input.turnId,opId+key)});
      const prepared=await session.repo.exportCandidate(candidate,receipt);
      const persisted=await persistSqlSession(session,{commit:{...prepared,kind:'maintenance',receipt:null},isCurrent:input.isCurrent});
      return {receipt,coreSaved:persisted.saved,issues:persisted.issues};
    } catch(err) {await session.repo.discardPrepared(candidate.token);throw err;}
  });
}
