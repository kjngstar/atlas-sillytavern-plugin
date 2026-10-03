/** Targeted model repair of a saved partial turn. Successful operations and time stay frozen. */
import { AtlasDbError, queryBound } from './atlas-db-runtime.ts';
import { createTableReadPort } from './atlas-db-readport.ts';
import { collectEntityRefs, inDecisionScope } from './atlas-sql-refs.ts';
import type { KnownRef, OperationContext } from './atlas-sql-refs.ts';
import { compileOperations } from './atlas-ops-compile.ts';
import { buildAtomicGroups } from './atlas-ops-groups.ts';
import { buildRepairBatch, mergeRepair } from './atlas-ops-repair.ts';
import { extractPayload, parseOperations } from './atlas-ops-parser.ts';
import { buildStagePrompt } from './atlas-ops-prompts.ts';
import { runSqlResume } from './atlas-sql-resume.ts';
import { runSqlRetry } from './atlas-sql-session.ts';
import { ATLAS_SEMANTIC_OPS } from './atlas-ops-contract.ts';
import type { SqlSession } from './atlas-sql-session.ts';
import type { Issue, ParsedOperation, SourceSnapshotEntry, TurnReceipt } from './atlas-ops-contract.ts';

type RetryInput = { turnId: string; sourceSnapshot?: SourceSnapshotEntry[]; isCurrent?: () => boolean };
type RetryResult = { receipt: TurnReceipt; coreSaved: boolean; issues: Issue[]; duplicate?: boolean };
const flights = new WeakMap<SqlSession, Map<string, Promise<RetryResult>>>();
export async function runSqlModelRetry(session: SqlSession, input: RetryInput): Promise<RetryResult> {
  let pending = flights.get(session);
  if (!pending) { pending = new Map(); flights.set(session, pending); }
  const existing = pending.get(input.turnId);
  if (existing) return existing;
  const task = retry(session, input);
  pending.set(input.turnId, task);
  try { return await task; } finally { if (pending.get(input.turnId) === task) pending.delete(input.turnId); }
}
async function retry(session: SqlSession, input: RetryInput): Promise<RetryResult> {
  const assertCurrent = () => {
    if (session.closed || session.isCurrentHost && !session.isCurrentHost()) throw new AtlasDbError('SESSION_STALE', '补交宿主已变化', {});
    if (input.isCurrent && !input.isCurrent()) throw new AtlasDbError('TURN_CANCELLED', '补交楼层或模式已变化', {});
    if (session.repo.internal.currentHeadTurnId() !== input.turnId) throw new AtlasDbError('RETRY_BASE_CHANGED', '原回合已不是当前推演头，请从原楼层重演后文，不能把旧操作插入新状态', {});
  };
  assertCurrent();
  const row = queryBound(session.repo.db, 'SELECT receipt_json, decisions_json FROM turns WHERE id=? AND branch_id=?', [input.turnId, session.branchId])[0];
  if (!row) throw new AtlasDbError('REF_UNKNOWN', '原补交回合不存在', {});
  const receipt = JSON.parse(String(row.receipt_json)) as TurnReceipt;
  const rejected = receipt.groups.filter(g => g.status === 'rejected' || g.status === 'blocked');
  if (!rejected.length) return runSqlResume(session,input);
  const history = JSON.parse(String(row.decisions_json)) as { operations: ParsedOperation['value'][]; operation_meta?: Array<Omit<ParsedOperation, 'value'>>; known_refs?: KnownRef[]; operation_context?: OperationContext[] };
  if (!history.known_refs || !history.operation_meta || history.operation_meta.length !== history.operations.length) throw new AtlasDbError('SQL_RETRY_HISTORY_MISSING', '旧 SQL 回合缺少操作身份或原短引用记录，不能安全补交；请回退后重新推演，原存档未修改', {});
  if (!session.modelPort) throw new AtlasDbError('MODEL_PORT_MISSING', '补交没有活动模型端口', {});
  let operations = history.operations.map((value, index) => ({ ...history.operation_meta![index], value }));
  const allFailedIds = new Set(rejected.flatMap(g => g.opIds));
  // Repair one original catalogue at a time. Mixing two batches' C1 aliases is unsafe.
  const contexts=history.operation_context ?? [];
  const context=contexts.find(ctx=>ctx.opIds.some(id=>allFailedIds.has(id)));
  const contextualIds=new Set(contexts.flatMap(ctx=>ctx.opIds));
  operations=operations.filter(op=>context?context.opIds.includes(op.opId):!contextualIds.has(op.opId));
  const failedIds = new Set(operations.filter(op=>allFailedIds.has(op.opId)).map(op=>op.opId));
  if (!failedIds.size) throw new AtlasDbError('SQL_RETRY_HISTORY_MISSING', '失败批次的原引用上下文不完整，拒绝补交', {});
  const failed = operations.filter(op => failedIds.has(op.opId));
  if (failed.length !== failedIds.size) throw new AtlasDbError('SQL_RETRY_HISTORY_MISSING', '失败组的原操作记录不完整，拒绝补交', {});
  const revision = session.repo.internal.currentRevision(), storageRevision = session.repo.storageRevision;
  const anchor = { ...receipt.anchor, parentTurnId: input.turnId, baseRevision: revision, baseStorageRevision: storageRevision };
  const tables = createTableReadPort(session.repo.db), sources = context ? [] : input.sourceSnapshot ?? [];
  const refs=context?.knownRefs ?? history.known_refs;
  const clockS=context?.clockS ?? receipt.clockBeforeS;
  const sourceContext={phase:'repair' as const,snapshot:sources,clockS,opportunities:context?.opportunities,dueEventIds:context?.dueEventIds};
  const original = compileOperations({ operations, anchor, phase: 'observe', allowedOps: ATLAS_SEMANTIC_OPS,
    clockS, revision, tables, sources: sourceContext,
    turnId: input.turnId, makeId: session.repo.internal.makeId, knownRefs: refs });
  const allowedOps = [...new Set(failed.map(op => op.value.op))];
  const tickets = buildRepairBatch(failed.map(op => ({ op, issues: rejected.filter(g => g.opIds.includes(op.opId)).flatMap(g => g.issues),
    readSet: original.results.find(r => r.opId === op.opId)?.result.readSet ?? [] })), { phase: 'repair', allowedOps });
  const request = buildStagePrompt({ phase: 'repair', allowedOps, entityRefs: collectEntityRefs(tables, session.branchId, refs),
    repairTickets: tickets.promptLines.join('\n'), sourceSnapshot: sources, batchId: 'retry_' + tickets.batchId, repairOfBatchId: tickets.batchId });
  request.anchor = anchor; request.sourceSnapshot = sources;
  const response = await session.modelPort.request(request);
  assertCurrent();
  if (revision !== session.repo.internal.currentRevision() || storageRevision !== session.repo.storageRevision) throw new AtlasDbError('STALE_BASE', '模型补交等待期间快照已变化，候选不发布', {});
  const payload = extractPayload(response.text);
  const parsed = parseOperations(payload.payload, { phase: 'repair', allowedOps });
  const corrected = mergeRepair(failed, parsed.operations, tickets.tickets, { phase: 'repair', attemptsUsed: 0 });
  const issues = [...tickets.issues, ...payload.issues, ...parsed.issues, ...corrected.issues];
  if (!corrected.operations.length) return { receipt, coreSaved: false, issues };
  if (context?.phase==='decision' && corrected.operations.some(op=>!inDecisionScope(op,context,tables,session.branchId))) throw new AtlasDbError('ACTOR_SCOPE_VIOLATION','补交不能扩大原人物决策权限',{});
  const knownRefs = [...refs];
  for (const alias of original.aliasById.keys()) {
    const ref = original.scope.get(alias);
      if (ref && !failedIds.has(ref.declaredByOpId ?? '')) knownRefs.push({ alias, id:ref.id, kind: ref.kind, rowRev: ref.rowRev });
  }
  const compiled = compileOperations({ operations: corrected.operations, anchor, phase: 'repair', allowedOps,
    clockS, revision, tables, sources: sourceContext,
    turnId: input.turnId, makeId: session.repo.internal.makeId, knownRefs,
    seedRefs:original.scope.all().filter(ref=>!failedIds.has(ref.declaredByOpId ?? '')) });
  const groups = buildAtomicGroups(compiled.results.map(r => ({ opId: r.opId, ...r.result })));
  const result = await runSqlRetry(session, { branchId: session.branchId, chatUid: session.chatUid, turnId: input.turnId,
    currentHeadTurnId: input.turnId, attemptId: `retry_${storageRevision}`, groups: groups.groups, clockS: receipt.clockAfterS, isCurrent: input.isCurrent });
  const updated = result.coreSaved ? JSON.parse(String(queryBound(session.repo.db, 'SELECT receipt_json FROM turns WHERE id=?', [input.turnId])[0].receipt_json)) as TurnReceipt : receipt;
  return { receipt: updated, coreSaved: result.coreSaved, issues: [...issues, ...compiled.issues, ...groups.issues, ...result.issues] };
}
