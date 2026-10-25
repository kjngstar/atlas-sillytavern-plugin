/** Author-only, paginated analysis of every stored turn, including successful/noop turns. */
import { AtlasDbError, queryBound, type SqlDatabase } from './atlas-db-runtime.ts';
import { atlasDiagnosticContext } from './atlas-request-diagnostics.ts';
import { atlasRefFingerprint, sanitizeDiagnostic } from './atlas-diagnostics.ts';
import { sanitizeModelCallAudit } from './atlas-model-call-audit.ts';
import type { ViewQuery, ViewResult } from './atlas-ops-contract.ts';

type Row = Record<string, unknown>;
type Context = { db: SqlDatabase; branchId: string; revision: number; chatId?: string; viewMode?: 'author' | 'pov' };
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const list = (value: unknown): Row[] => Array.isArray(value) ? value.map(object) : [];
function json(value: unknown): unknown { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } }
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const atom = (value: unknown) => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value) ? value : 'unknown';
function safeAttempt(row: Row, index: number) {
  const out: Row = { index: index + 1, stage: atom(row.kind ?? row.phase), phase: atom(row.phase),
    status: row.error || row.failure_kind ? 'failed' : 'completed' };
  for (const [source, target] of Object.entries({ started_wall_ms: 'startedWallMs', finished_wall_ms: 'finishedWallMs', duration_ms: 'durationMs',
    http_status: 'httpStatus', response_chars: 'responseChars', input_chars: 'inputChars', target_count: 'targetCount' })) if (integer(row[source])) out[target] = row[source];
  if (row.target_kind === 'maps' || row.target_kind === 'characters') out.targetKind = row.target_kind;
  if (typeof row.error_code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(row.error_code)) out.errorCode = row.error_code;
  if (row.failure_kind) out.failureKind = atom(row.failure_kind);
  // Error strings and model output stay out of this shareable analysis file.
  if (row.finish_reason) {
    const safe = sanitizeDiagnostic({ level:'info', source:'model', code:'MODEL_REQUEST_COMPLETED', operation:'generation', phase:'response', outcome:'success', details:{finishReason:row.finish_reason as string} });
    if (safe?.details?.finishReason) out.finishReason = safe.details.finishReason;
  }
  return out;
}
function safePlan(value: unknown) {
  const raw = object(value), usage = object(raw.usage);
  if (!integer(usage.transports)) return null;
  const counts = (value: unknown) => Object.fromEntries(['observe','construction','evidence','maps','characters','outcomes'].flatMap(key => integer(object(value)[key]) ? [[key,object(value)[key]]] : []));
  return { normalLimits: counts(raw.normalLimits), extraLimit: integer(raw.extraLimit) ? raw.extraLimit : null,
    usage: { normal: counts(usage.normal), extra: integer(usage.extra) ? usage.extra : null, transports:usage.transports } };
}

export function queryTurnAnalysis(ctx: Context, query: ViewQuery): ViewResult {
  if (ctx.viewMode !== 'author') throw new AtlasDbError('VIEW_AUTHOR_REQUIRED', '逐轮分析需要作者视角', {});
  if (query.revision !== undefined && query.revision !== ctx.revision) throw new AtlasDbError('VIEW_CURSOR_STALE', '导出期间世界修订已变化，请重新导出', {});
  const branchRef = atlasRefFingerprint(JSON.stringify([ctx.chatId ?? '', ctx.branchId]));
  const limit = Math.max(1, Math.min(200, Number.isSafeInteger(query.limit) ? query.limit! : 100));
  let after: [number, string] | null = null;
  if (query.cursor) {
    let cursor: unknown;
    try { cursor = JSON.parse(decodeURIComponent(query.cursor.replace(/^ta1:/, ''))); } catch { /* Invalid cursor below. */ }
    if (!query.cursor.startsWith('ta1:') || !Array.isArray(cursor) || cursor.length !== 4 || !integer(cursor[2]) || typeof cursor[3] !== 'string' || !cursor[3]) throw new AtlasDbError('VIEW_CURSOR_INVALID','逐轮分析游标无效',{});
    if (cursor[0] !== ctx.revision || cursor[1] !== branchRef) throw new AtlasDbError('VIEW_CURSOR_STALE','逐轮分析游标不属于当前聊天、分支或修订',{});
    after = [cursor[2],cursor[3]];
  }
  const params: Array<string | number> = [ctx.branchId];
  if (after) params.push(after[0],after[0],after[1]);
  const turns = queryBound(ctx.db, `SELECT id, host_message_uid, host_variant_key, kind, status, base_revision, committed_revision, created_wall_ms, receipt_json, attempts_json
    FROM turns WHERE branch_id = ?${after ? ' AND (created_wall_ms < ? OR (created_wall_ms = ? AND id < ?))' : ''}
    ORDER BY created_wall_ms DESC, id DESC LIMIT ?`, [...params,limit+1]);
  const hasMore = turns.length > limit, page = turns.slice(0,limit);
  const changes = page.length ? queryBound(ctx.db, `SELECT turn_id, target_table, operation, COUNT(*) AS n FROM turn_changes
    WHERE turn_id IN (${page.map(()=>'?').join(',')}) GROUP BY turn_id, target_table, operation`, page.map(row=>String(row.id))) : [];
  const items = page.map(row => {
    const receipt = object(json(row.receipt_json)), attempts = list(json(row.attempts_json));
    const audit = sanitizeModelCallAudit(receipt.requestAudit), plan = safePlan(receipt.requestPlan);
    const scoped = atlasDiagnosticContext({ chatUid:ctx.chatId, branchId:ctx.branchId, hostMessageUid:row.host_message_uid, variantKey:row.host_variant_key });
    const issues = list(receipt.issues).map(issue => {
      const path=typeof issue.path==='string'?issue.path:'';
      const mapKey=/^\$\.maps\.([^.\[\]]+)/.exec(path)?.[1];
      const schemaPath=mapKey?path.replace(`$.maps.${mapKey}`,'$.maps[*]'):path;
      const safe = sanitizeDiagnostic({level:'warn',source:'engine',code:'REQUEST_ISSUE',operation:'generation',phase:'validation',outcome:'failed',details:{schemaPath}});
      return { code: typeof issue.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(issue.code) ? issue.code : 'UNKNOWN_ISSUE',
        severity:issue.severity==='error'?'error':'warning',retryable:issue.retryable===true,
        ...(path?{pathRef:atlasRefFingerprint(path)}:{}),
        ...(mapKey?{mapRef:atlasRefFingerprint(mapKey)}:{}),
        ...(safe?.details?.schemaPath?{schemaPath:safe.details.schemaPath}:{}) };
    });
    const groups = list(receipt.groups);
    return {
      id: atlasRefFingerprint(String(row.id)), turnRef:scoped.details?.turnRef ?? atlasRefFingerprint(String(row.id)), branchRef,
      kind:atom(row.kind),status:row.status==='committed'&&receipt.status==='noop'?'noop':atom(row.status),receiptStatus:atom(receipt.status),createdWallMs:integer(row.created_wall_ms)?row.created_wall_ms:null,
      baseRevision:integer(row.base_revision)?row.base_revision:null,committedRevision:integer(row.committed_revision)?row.committed_revision:null,
      storedInSnapshot:true, worldChanged:receipt.worldChanged===true,timeChanged:receipt.timeChanged===true,
      changes:changes.filter(change=>change.turn_id===row.id).map(change=>({table:atom(change.target_table),operation:atom(change.operation),rows:Number(change.n)})),
      groups:{total:groups.length,applied:groups.filter(group=>group.status==='applied').length,rejected:groups.filter(group=>group.status==='rejected'||group.status==='blocked').length},
      issues, requestAudit:audit,requestPlan:plan,
      recordedModelTransports:audit?.transports??plan?.usage.transports??null,
      countSource:audit?'transport-journal':plan?'work-budget':'unknown',
      attempts:attempts.map(safeAttempt),
      coverage:{transportDetails:audit?'recorded':'unavailable-in-legacy-turn',droppedCalls:audit?.droppedCalls??null,
        attemptRecords:attempts.length,attemptRecordsAreNotTransportCounts:true},
    };
  });
  const total = Number(queryBound(ctx.db,'SELECT COUNT(*) AS n FROM turns WHERE branch_id = ?',[ctx.branchId])[0]?.n??0);
  const last = page.at(-1);
  return { branchId:ctx.branchId,revision:ctx.revision,items,
    ...(hasMore&&last?{nextCursor:'ta1:'+encodeURIComponent(JSON.stringify([ctx.revision,branchRef,last.created_wall_ms,last.id]))}:{}),
    metadata:{totalCount:total,pageSize:limit,viewMode:'author',source:'stored-turns',readOnly:true} };
}
