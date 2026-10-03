/** Targeted model repair of a saved partial turn. Successful operations and time stay frozen. */
import { AtlasDbError, queryBound } from './atlas-db-runtime.ts';
import { createTableReadPort } from './atlas-db-readport.ts';
import { collectKnownRefs, collectEntityRefs } from './atlas-db-repository.ts';
import { compileOperations } from './atlas-ops-compile.ts';
import { buildAtomicGroups } from './atlas-ops-groups.ts';
import { buildRepairBatch, mergeRepair } from './atlas-ops-repair.ts';
import { extractPayload, parseOperations } from './atlas-ops-parser.ts';
import { buildStagePrompt } from './atlas-ops-prompts.ts';
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
  if (!rejected.length) return { receipt, coreSaved: true, issues: [], duplicate: true };
  const history = JSON.parse(String(row.decisions_json)) as { operations: ParsedOperation['value'][]; operation_meta?: Array<Omit<ParsedOperation, 'value'>> };
  if (!history.operation_meta || history.operation_meta.length !== history.operations.length) throw new AtlasDbError('SQL_RETRY_HISTORY_MISSING', '旧 SQL 回合缺少操作身份记录，不能安全补交；请回退后重新推演，原存档未修改', {});
  if (!session.modelPort) throw new AtlasDbError('MODEL_PORT_MISSING', '补交没有活动模型端口', {});
  const operations = history.operations.map((value, index) => ({ ...history.operation_meta![index], value }));
  const failedIds = new Set(rejected.flatMap(g => g.opIds));
  const failed = operations.filter(op => failedIds.has(op.opId));
  if (failed.length !== failedIds.size) throw new AtlasDbError('SQL_RETRY_HISTORY_MISSING', '失败组的原操作记录不完整，拒绝补交', {});
  const revision = session.repo.internal.currentRevision(), storageRevision = session.repo.storageRevision;
  const anchor = { ...receipt.anchor, parentTurnId: input.turnId, baseRevision: revision, baseStorageRevision: storageRevision };
  const tables = createTableReadPort(session.repo.db), sources = input.sourceSnapshot ?? [];
  const original = compileOperations({ operations, anchor, phase: 'observe', allowedOps: ATLAS_SEMANTIC_OPS,
    clockS: receipt.clockAfterS, revision, tables, sources: { phase: 'repair', snapshot: sources, clockS: receipt.clockAfterS },
    turnId: input.turnId, makeId: session.repo.internal.makeId, knownRefs: collectKnownRefs(tables, session.branchId) });
  const allowedOps = [...new Set(failed.map(op => op.value.op))];
  const tickets = buildRepairBatch(failed.map(op => ({ op, issues: rejected.filter(g => g.opIds.includes(op.opId)).flatMap(g => g.issues),
    readSet: original.results.find(r => r.opId === op.opId)?.result.readSet ?? [] })), { phase: 'repair', allowedOps });
  const request = buildStagePrompt({ phase: 'repair', allowedOps, entityRefs: collectEntityRefs(tables, session.branchId),
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
  const knownRefs: NonNullable<Parameters<typeof compileOperations>[0]['knownRefs']> = collectKnownRefs(tables, session.branchId);
  for (const [alias, id] of original.aliasById) {
    const ref = original.scope.get(alias);
    if (ref && !failedIds.has(ref.declaredByOpId ?? '')) knownRefs.push({ alias, id, kind: ref.kind, rowRev: ref.rowRev });
  }
  const compiled = compileOperations({ operations: corrected.operations, anchor, phase: 'repair', allowedOps,
    clockS: receipt.clockAfterS, revision, tables, sources: { phase: 'repair', snapshot: sources, clockS: receipt.clockAfterS },
    turnId: input.turnId, makeId: session.repo.internal.makeId, knownRefs });
  const groups = buildAtomicGroups(compiled.results.map(r => ({ opId: r.opId, ...r.result })));
  const result = await runSqlRetry(session, { branchId: session.branchId, chatUid: session.chatUid, turnId: input.turnId,
    currentHeadTurnId: input.turnId, attemptId: `retry_${storageRevision}`, groups: groups.groups, clockS: receipt.clockAfterS, isCurrent: input.isCurrent });
  const updated = result.coreSaved ? JSON.parse(String(queryBound(session.repo.db, 'SELECT receipt_json FROM turns WHERE id=?', [input.turnId])[0].receipt_json)) as TurnReceipt : receipt;
  return { receipt: updated, coreSaved: result.coreSaved, issues: [...issues, ...compiled.issues, ...groups.issues, ...result.issues] };
}
