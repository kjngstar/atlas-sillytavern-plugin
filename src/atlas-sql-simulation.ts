/** One isolated turn owns foreground elapsed time and all background consequences. */
import { AtlasDbError, queryBound, runBound } from './atlas-db-runtime.ts';
import { JOURNALED_TABLES } from './atlas-db-contract.ts';
import { deriveElapsedInterval } from './atlas-sim-time.ts';
import { settleWindow } from './atlas-sim-scheduler.ts';
import { advanceActions, haltActorWork } from './atlas-sim-actions.ts';
import { advanceJourney, computeTravelInterval } from './atlas-sim-motion.ts';
import { collectOpportunities } from './atlas-sim-opportunities.ts';
import { buildDecisionContext } from './atlas-sim-decision-context.ts';
import { buildOutcomeContext } from './atlas-sim-outcome-context.ts';
import { buildStagePrompt } from './atlas-ops-prompts.ts';
import { extractPayload, parseOperations } from './atlas-ops-parser.ts';
import { compileOperations } from './atlas-ops-compile.ts';
import { buildAtomicGroups, orderGroups } from './atlas-ops-groups.ts';
import { applyGroups } from './atlas-db-commit.ts';
import { recordGroupChanges } from './atlas-db-journal.ts';
import { createTableReadPort } from './atlas-db-readport.ts';
import { collectKnownRefs, collectEntityRefs, inDecisionScope } from './atlas-sql-refs.ts';
import type { OperationContext } from './atlas-sql-refs.ts';
import { ATLAS_RUNTIME_LIMITS, decisionActorBudget } from './atlas-runtime-limits.ts';
import { deriveSeed, drawForEvent, recordDraw, ATLAS_SIM_RULESET_VERSION } from './atlas-sim-random.ts';
import type { RecordedDraw } from './atlas-sim-random.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { AtlasModelPort } from './atlas-db-contract.ts';
import type { Issue, ParsedOperation, TurnAnchor, RowMutation, GroupResult, Phase } from './atlas-ops-contract.ts';
import type { StagePromptInput } from './atlas-ops-prompts.ts';
import type { Opportunity } from './atlas-sim-opportunities.ts';
import type { ElapsedActivity } from './atlas-sim-time.ts';

type Input = { db: SqlDatabase; branchId: string; anchor: TurnAnchor; turnId: string; clockBefore: number;
  operations: ParsedOperation[]; modelPort?: AtlasModelPort | null; modelBudget: number;
  makeId: (kind: string, opId: string, alias: string) => string; isCurrent?: () => boolean; attemptKey?: string };

function snapshot(input: Input): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const table of JOURNALED_TABLES) {
    const where = table === 'branches' ? 'id' : 'branch_id';
    for (const row of queryBound(input.db, `SELECT * FROM ${table} WHERE ${where}=?`, [input.branchId])) out.set(`${table}\0${row.id}`, row);
  }
  return out;
}

/** Program rows are encoded through the same schema writer as semantic operations. */
function write(input: Input, table: string, row: Record<string, unknown>, before: Record<string, unknown> | null) {
  const groups = buildAtomicGroups([{opId:`sim:${table}:${row.id}`,mutations:[{table,rowId:String(row.id),before,after:row,sourceOpIds:[`sim:${table}:${row.id}`],basis:{kind:'simulation'}}],issues:[],readSet:[],dependencies:[]}]);
  const result = applyGroups(input.db, groups.groups, {branchId:input.branchId,turnId:input.turnId,attemptId:'simulation',journal:false});
  if (result.groups.some(g=>g.status==='rejected'||g.status==='blocked')) throw new AtlasDbError('SIMULATION_WRITE_FAILED','后台行未通过统一写入检查',{groups:result.groups});
}

export async function settleSqlTurn(input: Input) {
  const before = snapshot(input), issues: Issue[] = [], groups: GroupResult[] = [], modelOperations: ParsedOperation[] = [];
  const appliedIds = new Set(queryBound(input.db,'SELECT operation_id FROM turn_changes WHERE turn_id=?',[input.turnId]).flatMap(r=>String(r.operation_id).split('+')));
  const activities: ElapsedActivity[] = [];
  for (const op of input.operations) {
    if (!appliedIds.has(op.opId) || op.value.op !== 'event.propose' || op.value.data?.phase !== 'observed') continue;
    const d = op.value.data, a = d.activity;
    if (!a && !d.time_hint) continue;
    const activity = typeof a === 'object' && a !== null ? a as Record<string, unknown> : {kind:typeof a==='string'?a:'other'};
    const kind = ['dialogue','meal','rest','sleep','travel','combat','other'].includes(String(activity.kind)) ? String(activity.kind) as ElapsedActivity['kind'] : 'other';
    let hint=d.time_hint as ElapsedActivity['hint'];
    if(kind==='travel'&&activity.completed!==false&&!hint) {
      const change=queryBound(input.db,"SELECT after_json FROM turn_changes WHERE turn_id=? AND operation_id=? AND target_table='events'",[input.turnId,op.opId])[0];
      const event=change?JSON.parse(String(change.after_json)):null;
      const tables=createTableReadPort(input.db);
      const actor=event?.subject_entity_id?tables.selectOne('characters',input.branchId,event.subject_entity_id):null;
      const route=event?.route_id?tables.selectOne('routes',input.branchId,event.route_id):null;
      if(actor&&route) hint=computeTravelInterval(input,actor,route,typeof activity.mode==='string'?activity.mode:undefined)??undefined;
    }
    activities.push({kind,completed:activity.completed !== false,hint});
  }
  const elapsed = deriveElapsedInterval({activities:activities.length?activities:[{kind:'dialogue',completed:true}]},{clockS:input.clockBefore});
  if (elapsed.quality==='unknown') issues.push({code:'TIME_UNRESOLVED',path:'$.elapsed',message:'已完成行为缺少可结算的耗时依据，时钟保持原值，未知不当成零耗时',severity:'warning',retryable:false});
  const clockAfter = input.clockBefore + (elapsed.quality==='unknown'?0:elapsed.nominalS);
  const branch = queryBound(input.db,'SELECT * FROM branches WHERE id=?',[input.branchId])[0];
  const seed=deriveSeed({chatUid:input.anchor.chatUid,branchId:input.branchId,forkTurnId:String(branch.fork_turn_id??''),variantKey:input.anchor.variantKey,inputHash:input.anchor.inputHash,rulesetVersion:ATLAS_SIM_RULESET_VERSION});
  const clockMin=Number(branch.clock_min_s)+elapsed.minS, clockMax=Number(branch.clock_max_s)+elapsed.maxS;
  const randomDraws: RecordedDraw[]=[];
  let cursor = Number(branch.simulation_cursor_s), catchingUp = false, batches = 0;
  const steps: Array<Record<string, unknown>> = [];
  const pendingActors: string[] = [];
  const operationContexts: OperationContext[]=[];
  const assertCurrent = () => { if (input.isCurrent && !input.isCurrent()) throw new AtlasDbError('TURN_CANCELLED','后台模型等待期间楼层已变化',{}); };
  const ask = async (phase: Phase, fields: Partial<StagePromptInput>, atS: number, opportunities: Opportunity[] = [], dueEventIds: string[] = []) => {
    assertCurrent();
    if (!input.modelPort || batches >= input.modelBudget) throw new AtlasDbError('MODEL_BUDGET_EXHAUSTED','后台判断等待下一次结算',{});
    const tables = createTableReadPort(input.db), knownRefs = collectKnownRefs(tables,input.branchId);
    opportunities.forEach((o,i)=>knownRefs.push({alias:`O${i+1}`,id:o.id,kind:'opportunity',rowRev:null}));
    const byId = new Map(knownRefs.map(ref=>[ref.id,ref.alias]));
    // Replace internal IDs with the exact short references that the compiler receives.
    const request = buildStagePrompt({phase,...fields,batchId:`sim_${input.turnId}_${batches}`,entityRefs:collectEntityRefs(tables,input.branchId,knownRefs)});
    request.anchor=input.anchor;
    request.messages[1].content += '\n现有对象短引用：'+collectEntityRefs(tables,input.branchId,knownRefs).join('、');
    // Structured fields, already serialized by callers, also use the same aliases.
    for (const [id,alias] of byId) request.messages[1].content=request.messages[1].content.split(JSON.stringify(id)).join(JSON.stringify(alias));
    request.sourceSnapshot=[];
    batches++;
    const response = await input.modelPort.request(request); assertCurrent();
    const payload=extractPayload(response.text), parsed=parseOperations(payload.payload,{phase});
    issues.push(...payload.issues,...parsed.issues);
    let operations=parsed.operations.map(op=>({...op,opId:`sim_${input.attemptKey ?? input.turnId}_${batches}_${op.opId}`}));
    const context: OperationContext={opIds:[],phase,clockS:atS,knownRefs,opportunities,dueEventIds,
      actorIds:phase==='decision'?(JSON.parse(fields.actorSlices ?? '[]') as Array<{entityId:string}>).map(a=>a.entityId):[]};
    if (phase==='decision') operations=operations.filter(op=>{
      if (inDecisionScope(op,context,tables,input.branchId)) return true;
      issues.push({code:'ACTOR_SCOPE_VIOLATION',path:'$.decision',opId:op.opId,message:'决策仅能修改给定人物的心理、计划和有效接触认知，不能瞬移或改写其它人物',severity:'error',retryable:false});
      return false;
    });
    context.opIds=operations.map(op=>op.opId); operationContexts.push(context);
    const compiled=compileOperations({operations,anchor:input.anchor,phase,clockS:atS,revision:input.anchor.baseRevision,tables,
      sources:{phase,clockS:atS,snapshot:[],opportunities,dueEventIds},knownRefs,makeId:input.makeId,turnId:input.turnId});
    const built=buildAtomicGroups(compiled.results.map(r=>({opId:r.opId,...r.result}))), ordered=orderGroups(built.groups);
    const result=applyGroups(input.db,ordered.order,{branchId:input.branchId,turnId:input.turnId,attemptId:'simulation',journal:false});
    issues.push(...compiled.issues,...built.issues,...ordered.issues); groups.push(...result.groups); modelOperations.push(...operations);
    return {changed:result.groups.some(g=>g.status==='applied'&&g.changedRows>0),noop:parsed.explicitNoop};
  };
  for (const actor of queryBound(input.db,"SELECT id,physical_status FROM characters WHERE branch_id=? AND physical_status IN ('dead','incapacitated')",[input.branchId])) {
    haltActorWork(input.db,input.branchId,String(actor.id),input.clockBefore,String(actor.physical_status));
  }
  if (clockAfter > cursor || branch.simulation_status === 'catching_up') {
    const settled=await settleWindow({...input,chatUid:input.anchor.chatUid,clockS:cursor,untilS:clockAfter,deferOutcome:true,
      budgets:{modelBatches:input.modelBudget},modelPort:input.modelPort ? {request:async(raw:unknown)=>{
        const req=raw as {atS:number;boundary:{kind:string;refId:string}}, atS=req.atS;
        runBound(input.db,'UPDATE branches SET clock_s=?,clock_min_s=?,clock_max_s=?,simulation_cursor_s=? WHERE id=?',[atS,atS,atS,atS,input.branchId]);
        const opportunities=collectOpportunities({fromS:cursor,untilS:atS},{db:input.db,branchId:input.branchId});
        if (req.boundary.kind==='journey_node') {
          const journey=queryBound(input.db,'SELECT * FROM journeys WHERE branch_id=? AND id=?',[input.branchId,req.boundary.refId])[0];
          const context=buildDecisionContext({actors:[{entityId:String(journey.mover_entity_id)}],opportunities},{db:input.db,branchId:input.branchId});
          return ask('decision',{timeWindow:JSON.stringify({fromS:cursor,untilS:atS}),actorSlices:JSON.stringify(context.actorSlices),opportunities:JSON.stringify(opportunities)},atS,opportunities);
        }
        const due=queryBound(input.db,'SELECT * FROM actions WHERE branch_id=? AND id=?',[input.branchId,req.boundary.refId]);
        const context=buildOutcomeContext({dueActions:due,opportunities},{db:input.db,branchId:input.branchId});
        for (const action of due) {
          const payload=typeof action.payload_json==='string'?JSON.parse(action.payload_json):action.payload_json;
          if (payload?.stakes==='major') {
            const draw=recordDraw(drawForEvent(seed,String(action.id),{key:'outcome',distribution:'uniform'}));
            randomDraws.push(draw); context.facts.push({kind:'reproducible_draw',actionId:action.id,draw});
          }
        }
        const event=req.boundary.kind==='event_start'?queryBound(input.db,'SELECT * FROM events WHERE branch_id=? AND id=?',[input.branchId,req.boundary.refId]):[];
        if (context.eligibility.some(e=>!e.ok)) throw new AtlasDbError('OUTCOME_INELIGIBLE','到期行动不满足时空或能力约束，不能落实结果',{eligibility:context.eligibility});
        const outcome=await ask('outcome',{dueActions:JSON.stringify(context.dueActions),relevantWorldFacts:JSON.stringify([...context.facts,...event]),eligibility:JSON.stringify(context.eligibility)},atS,opportunities,event.map(e=>String(e.id)));
        if (!outcome.changed) throw new AtlasDbError('OUTCOME_DEFERRED','到期结果未落实，停在当前因果边界',{});
        return {resolved:true};
      }}:null});
    issues.push(...settled.issues); steps.push(...settled.steps); catchingUp=settled.catchingUp;
    cursor=settled.simulationCursorS;
    // Settle partial segments too; lack of a node before the window end is not lack of travel.
    for (const row of queryBound(input.db,"SELECT * FROM journeys WHERE branch_id=? AND status='moving'",[input.branchId])) {
      const advanced=advanceJourney(row,cursor,{db:input.db,branchId:input.branchId}); issues.push(...advanced.issues);
      if (JSON.stringify(advanced.journey)!==JSON.stringify(row)) write(input,'journeys',{...advanced.journey,row_rev:Number(row.row_rev)+1,updated_turn_id:input.turnId},row);
    }
    const actions=advanceActions({fromS:Number(branch.simulation_cursor_s),untilS:cursor},{db:input.db,branchId:input.branchId,makeId:input.makeId as never,turnId:input.turnId,deferOutcome:true});
    issues.push(...actions.issues);
    for (const row of actions.actions) write(input,'actions',row,queryBound(input.db,'SELECT * FROM actions WHERE branch_id=? AND id=?',[input.branchId,String(row.id)])[0]);
    for (const row of actions.events) write(input,'events',row,null);
    for (const journey of queryBound(input.db,"SELECT * FROM journeys WHERE branch_id=? AND status IN ('arrived','paused','blocked')",[input.branchId])) {
      // Historical arrivals are not movement in this window. Replaying one would
      // pull a character back after a later narrative or journey moved them away.
      if (JSON.stringify(before.get(`journeys\0${journey.id}`))===JSON.stringify(journey)) continue;
      if (!journey.stop_location_id) continue;
      const actor=queryBound(input.db,'SELECT * FROM characters WHERE branch_id=? AND id=?',[input.branchId,String(journey.mover_entity_id)])[0];
      if (actor && actor.location_id!==journey.stop_location_id) write(input,'characters',{...actor,location_id:journey.stop_location_id,map_id:null,grid_x:null,grid_y:null,coord_precision:'unknown',uncertainty_radius_cells:null,row_rev:Number(actor.row_rev)+1,updated_turn_id:input.turnId},actor);
      if (journey.status==='arrived') {
        const action=queryBound(input.db,'SELECT * FROM actions WHERE branch_id=? AND id=?',[input.branchId,String(journey.action_id)])[0];
        if (action && action.status!=='completed') write(input,'actions',{...action,status:'completed',finished_at_s:journey.arrived_at_s,reason_code:null,row_rev:Number(action.row_rev)+1,updated_turn_id:input.turnId},action);
      }
    }
    for (const goal of queryBound(input.db,"SELECT * FROM actions WHERE branch_id=? AND kind='goal' AND status IN ('planned','ready','active')",[input.branchId])) {
      const children=queryBound(input.db,'SELECT status FROM actions WHERE branch_id=? AND parent_action_id=?',[input.branchId,String(goal.id)]);
      if (children.length && children.every(c=>['completed','cancelled','failed'].includes(String(c.status)))) write(input,'actions',{...goal,status:children.some(c=>c.status==='failed')?'failed':'completed',finished_at_s:cursor,evaluated_until_s:cursor,row_rev:Number(goal.row_rev)+1,updated_turn_id:input.turnId},goal);
    }
    runBound(input.db,'UPDATE branches SET clock_s=?,clock_min_s=?,clock_max_s=?,simulation_cursor_s=? WHERE id=?',[clockAfter,clockMin,clockMax,cursor,input.branchId]);
    const opportunities=collectOpportunities({fromS:Number(branch.simulation_cursor_s),untilS:cursor},{db:input.db,branchId:input.branchId});
    let actors=queryBound(input.db,"SELECT id FROM characters WHERE branch_id=? AND status='active' AND physical_status='alive' AND role!='protagonist' ORDER BY importance,id",[input.branchId]);
    if (clockAfter === input.clockBefore && branch.simulation_status === 'catching_up') {
      const prior=queryBound(input.db,'SELECT decisions_json FROM turns WHERE id=?',[String(branch.head_turn_id)])[0];
      const waiting=prior ? JSON.parse(String(prior.decisions_json)).pending_actors as string[]|undefined : undefined;
      if (waiting?.length) actors=actors.filter(a=>waiting.includes(String(a.id)));
    }
    if (!catchingUp && actors.length) {
      let processed=0;
      const count=decisionActorBudget(ATLAS_RUNTIME_LIMITS.normalResponseTokens);
      for (;processed<actors.length && input.modelPort && batches<input.modelBudget;processed+=count) {
        const actorIds=actors.slice(processed,processed+count).map(c=>({entityId:String(c.id)}));
        const contacts=opportunities.filter(o=>actorIds.some(a=>a.entityId===o.receiverEntityId));
        const context=buildDecisionContext({actors:actorIds,opportunities:contacts},{db:input.db,branchId:input.branchId});
        try { await ask('decision',{timeWindow:JSON.stringify({fromS:input.clockBefore,untilS:cursor}),actorSlices:JSON.stringify(context.actorSlices),opportunities:JSON.stringify(contacts)},cursor,contacts); }
        catch (err) { if ((err as {code?:string}).code==='TURN_CANCELLED') throw err; issues.push({code:'MODEL_REQUEST_FAILED',path:'$.decision',message:String((err as Error).message),severity:'warning',retryable:true}); break; }
      }
      if (processed<actors.length) { pendingActors.push(...actors.slice(processed).map(a=>String(a.id))); catchingUp=true; issues.push({code:'ACTOR_BUDGET_EXHAUSTED',path:'$.decision',message:'剩余人物判断已记录，等待后续批次',severity:'warning',retryable:true}); }
    }
  }
  let after=snapshot(input);
  for (const [key,row] of after) {
    const previous=before.get(key);
    if (JSON.stringify(previous)===JSON.stringify(row) || !('row_rev' in row)) continue;
    const [table]=key.split('\0');
    runBound(input.db,`UPDATE ${table} SET row_rev=?,updated_turn_id=? WHERE branch_id=? AND id=?`,[Math.max(Number(row.row_rev),Number(previous?.row_rev??0)+1),input.turnId,input.branchId,String(row.id)]);
  }
  after=snapshot(input);
  const mutations:RowMutation[]=[];
  for (const key of new Set([...before.keys(),...after.keys()])) {
    const prior=before.get(key)??null, next=after.get(key)??null;
    if (JSON.stringify(prior)===JSON.stringify(next)) continue;
    const [table,rowId]=key.split('\0');
    mutations.push({table,rowId,before:prior,after:next,sourceOpIds:[`simulation:${input.attemptKey ?? input.turnId}`],basis:{kind:'simulation',clock_before_s:input.clockBefore,clock_after_s:clockAfter}});
  }
  const seq=Number(queryBound(input.db,'SELECT COALESCE(MAX(sequence),0) AS n FROM turn_changes WHERE turn_id=?',[input.turnId])[0].n)+1;
  const journal=recordGroupChanges(input.db,{id:`simulation_${input.attemptKey ?? input.turnId}`,mutations,opIds:[`simulation:${input.attemptKey ?? input.turnId}`]},{turnId:input.turnId,attemptId:input.attemptKey ?? 'simulation',startSequence:seq});
  if (journal.issues.length) throw new AtlasDbError('JOURNAL_WRITE_FAILED',`后台变化不能可靠回退，候选不发布：${journal.issues.join('；')}`,{issues:journal.issues});
  return {elapsed,clockAfter,clockMin,clockMax,seed,randomDraws,simulatedUntil:cursor,catchingUp,pendingActors,steps,issues,groups,modelOperations,operationContexts,worldChanged:mutations.some(m=>m.table!=='branches')};
}
