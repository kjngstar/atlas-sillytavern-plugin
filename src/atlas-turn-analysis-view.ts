/** Author-only, paginated analysis of every stored turn, including successful/noop turns. */
import { AtlasDbError, queryBound, type SqlDatabase } from './atlas-db-runtime.ts';
import { atlasDiagnosticContext } from './atlas-request-diagnostics.ts';
import { atlasRefFingerprint, sanitizeDiagnostic } from './atlas-diagnostics.ts';
import { sanitizeModelCallAudit, type ModelCallRecord } from './atlas-model-call-audit.ts';
import { summarizeTransportTiming } from './atlas-response-metrics.ts';
import { countsAsBusinessTurn, groupTurnTransportTotals, summarizeTurnTransports, type GroupableTurn } from './atlas-turn-analysis-groups.ts';
import { readProgressRows } from './atlas-construction-progress.ts';
import { createTableReadPort } from './atlas-db-readport.ts';
import { isWorldBuildJobRow, readWorldBuildJobs } from './atlas-world-build-state.ts';
import type { ViewQuery, ViewResult } from './atlas-ops-contract.ts';
import { readWorldBuildTurnLink, resolveBuildOriginHost } from './atlas-world-build-ledger.ts';

type Row = Record<string, unknown>;
// P08 §14：玩家作用域也会流到这里，运行时仍只放行 author（下面有 VIEW_AUTHOR_REQUIRED 守卫）。
type Context = { db: SqlDatabase; branchId: string; revision: number; chatId?: string; viewMode?: 'author' | 'pov' | 'player' };
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

/* ------------------------------------------------------------------ *
 * P14 §20.2 / §20.3：长度与耗时的区间汇总
 * ------------------------------------------------------------------ */

/**
 * 三口径求和：`null` 表示「至少一条记录没有该字段」，不能当成 0 参与相加。
 * raw 缺失时按 0 处理没意义，所以三项都用同一规则——有未知就整体未知。
 */
function sumLengths(calls: readonly ModelCallRecord[]): { rawResponseChars: number | null; visibleTextChars: number | null; reasoningTextChars: number | null } {
  const sum = (pick: (call: ModelCallRecord) => number | null | undefined): number | null => {
    let total = 0;
    for (const call of calls) {
      const value = pick(call);
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
      total += value;
    }
    return total;
  };
  return {
    rawResponseChars: sum(call => call.rawResponseChars ?? call.responseChars),
    visibleTextChars: sum(call => call.visibleTextChars),
    reasoningTextChars: sum(call => call.reasoningTextChars),
  };
}

/**
 * 一个楼层 / 窗口里「第一次真正确认发出」的批次引用，用来回答「为什么发」。
 * 只给引用不给内容：导出文件仍然不能出现提示词或正文。
 */
function attemptReasons(calls: readonly ModelCallRecord[]): Array<{ sequence: number; workClass: string; reason: string; status: string }> {
  return calls.slice(0, 64).map(call => ({ sequence: call.sequence, workClass: call.workClass, reason: call.reason, status: call.status }));
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
  const turns = queryBound(ctx.db, `SELECT id, host_message_uid, host_variant_key, kind, status, base_revision, committed_revision, created_wall_ms, receipt_json, attempts_json, decisions_json
    FROM turns WHERE branch_id = ?${after ? ' AND (created_wall_ms < ? OR (created_wall_ms = ? AND id < ?))' : ''}
    ORDER BY created_wall_ms DESC, id DESC LIMIT ?`, [...params,limit+1]);
  const hasMore = turns.length > limit, page = turns.slice(0,limit);
  const changes = page.length ? queryBound(ctx.db, `SELECT turn_id, target_table, operation, COUNT(*) AS n FROM turn_changes
    WHERE turn_id IN (${page.map(()=>'?').join(',')}) GROUP BY turn_id, target_table, operation`, page.map(row=>String(row.id))) : [];
  /**
   * P14 §20.2：独立建图窗口的**类型与所属楼层**。
   *
   * 窗口序号不记在 turn 行上（`turns` 表没有这一列，也不该为诊断加一列）。
   * 权威来源是 job payload 自己的 `originFloorId` 与累计窗口账：用它把「哪一轮发起了建图」
   * 标出来，窗口总量直接引用 job 的累计值，**不从 turn 反推**。
   */
  const jobs = (() => {
    try {
      const rows = readProgressRows(createTableReadPort(ctx.db), ctx.branchId).filter(isWorldBuildJobRow);
      return readWorldBuildJobs(rows).values;
    } catch {
      // 读任务行失败不能让分析视图整体失败：退回「无建图关联」并如实标记。
      return [];
    }
  })();
  const jobsById = new Map(jobs.map(job=>[job.id,job]));
  const originHosts = new Map(jobs.map(job=>[job.id,resolveBuildOriginHost(ctx.db,ctx.branchId,job.originFloorId)]));
  const jobsByOriginFloor = new Map<string, typeof jobs[number]>();
  for (const job of jobs) if (job.originFloorId) jobsByOriginFloor.set(job.originFloorId, job);

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
    const countSource: 'transport-journal' | 'work-budget' | 'unknown' = audit ? 'transport-journal' : plan ? 'work-budget' : 'unknown';
    const recordedModelTransports = audit?.transports ?? plan?.usage.transports ?? null;
    const calls: readonly ModelCallRecord[] = audit?.calls ?? [];
    const counting = countsAsBusinessTurn({
      kind: String(row.kind ?? ''),
      countSource,
      recordedModelTransports,
      worldChanged: receipt.worldChanged === true,
      timeChanged: receipt.timeChanged === true,
    });
    const transport = summarizeTurnTransports([{ countSource, calls: audit?.calls, recordedModelTransports, droppedCalls: audit?.droppedCalls ?? null }]);
    const link=readWorldBuildTurnLink(row.decisions_json);
    const job=link?jobsById.get(link.jobId):jobsByOriginFloor.get(String(row.id));
    const originFloor = job ? originHosts.get(job.id)??null : String(row.host_message_uid ?? '')||null;
    return {
      id: atlasRefFingerprint(String(row.id)), turnRef:scoped.details?.turnRef ?? atlasRefFingerprint(String(row.id)), branchRef,
      /** P14 §20.2：所属正文楼层。同一楼层内的内部批次共用它，不冒充多条正文。 */
      floorRef: originFloor ? atlasRefFingerprint(originFloor) : null,
      kind:atom(row.kind),status:row.status==='committed'&&receipt.status==='noop'?'noop':atom(row.status),receiptStatus:atom(receipt.status),createdWallMs:integer(row.created_wall_ms)?row.created_wall_ms:null,
      baseRevision:integer(row.base_revision)?row.base_revision:null,committedRevision:integer(row.committed_revision)?row.committed_revision:null,
      storedInSnapshot:true, worldChanged:receipt.worldChanged===true,timeChanged:receipt.timeChanged===true,
      changes:changes.filter(change=>change.turn_id===row.id).map(change=>({table:atom(change.target_table),operation:atom(change.operation),rows:Number(change.n)})),
      groups:{total:groups.length,applied:groups.filter(group=>group.status==='applied').length,rejected:groups.filter(group=>group.status==='rejected'||group.status==='blocked').length},
      issues, requestAudit:audit,requestPlan:plan,
      recordedModelTransports,
      countSource,
      /** P14 §20.2：这一轮算不算模型业务轮，附上理由（迁移/纯本地/无证据各自不同）。 */
      countsAsBusinessTurn: counting.countsAsBusinessTurn,
      ...(counting.countsAsBusinessTurn ? {} : { countExclusionReason: counting.reason }),
      /** P14 §20.2/§20.3：真实传输去重与三口径长度、分段耗时。 */
      transport,
      lengths: sumLengths(calls),
      timing: summarizeTransportTiming(calls.map(call => ({
        headersMs: call.headersMs, bodyMs: call.bodyMs,
        logicalDurationMs: call.logicalDurationMs,
        durationIncludesCompatibilityRetry: call.durationIncludesCompatibilityRetry,
      }))),
      reasons: attemptReasons(calls),
      /**
       * P14 §20.2：建图关联。`role=origin-floor` 表示这一轮就是那次建图的发起楼层。
       * 窗口序号不从 turn 推断，直接引用 job 的累计账（见 summary.jobWindows）。
       */
      buildLinkage: job
        ? { jobRef: atlasRefFingerprint(job.id), jobKind: job.kind, jobStatus: job.status,
          role:link?(link.aborted?'aborted-window':link.window?'build-window':'build-control'):'origin-floor',
          windowSequence:link?.windowSequence??null,originFloorRef:originFloor?atlasRefFingerprint(originFloor):null }
        : null,
      attempts:attempts.map(safeAttempt),
      coverage:{transportDetails:audit?'recorded':'unavailable-in-legacy-turn',droppedCalls:audit?.droppedCalls??null,
        attemptRecords:attempts.length,attemptRecordsAreNotTransportCounts:true},
    };
  });

  /* ---- P14 §20.2：楼层 / 窗口分组。两栏重叠，**不提供相加入口**。 ---- */
  const groupable: GroupableTurn[] = items.map(item => ({
    countSource: item.countSource,
    calls: item.requestAudit?.calls,
    recordedModelTransports: item.recordedModelTransports,
    droppedCalls: item.requestAudit?.droppedCalls ?? null,
    floorRef: item.floorRef ?? 'unknown-floor',
    windowSequence: item.buildLinkage?.windowSequence??null,
    jobRef: item.buildLinkage?.jobRef ?? null,
  }));
  const groups = groupTurnTransportTotals(groupable);

  const total = Number(queryBound(ctx.db,'SELECT COUNT(*) AS n FROM turns WHERE branch_id = ?',[ctx.branchId])[0]?.n??0);
  const last = page.at(-1);
  return { branchId:ctx.branchId,revision:ctx.revision,items,
    ...(hasMore&&last?{nextCursor:'ta1:'+encodeURIComponent(JSON.stringify([ctx.revision,branchRef,last.created_wall_ms,last.id]))}:{}),
    summary:{
      /** 分页范围：这里的合计只覆盖当前页，不冒充全库累计。 */
      scope: hasMore ? 'page' : 'all-stored-turns',
      pageSize: items.length,
      businessTurns: items.filter(item => item.countsAsBusinessTurn).length,
      excludedTurns: items.filter(item => !item.countsAsBusinessTurn).length,
      transport: groups.overall,
      groups: { byFloor: groups.byFloor, byWindow: groups.byWindow },
      floorAndWindowTotalsAreIndependent: groups.floorAndWindowTotalsAreIndependent,
      /**
       * P14 §20.2：建图窗口的权威累计来自 job payload，不从 turn 反推。
       * 与楼层合计**不同口径**（同一批传输既属于楼层也属于窗口），因此不能相加。
       */
      jobWindows: jobs.map(job => ({
        jobRef: atlasRefFingerprint(job.id), kind: job.kind, status: job.status,
        originFloorRef: originHosts.get(job.id) ? atlasRefFingerprint(originHosts.get(job.id)!) : null,
        cumulativeWindows: job.cumulativeWindows, nextWindowSequence: job.nextWindowSequence,
        cumulativeTransports: job.cumulativeTransports,
        source: 'job-payload' as const,
      })),
      windowLinkage: items.some(item=>item.buildLinkage?.windowSequence!==null&&item.buildLinkage) ? 'stored-turn-window-ledger' : jobs.length ? 'job-payload-cumulative' : 'no-build-job-recorded',
    },
    metadata:{totalCount:total,pageSize:limit,viewMode:'author',source:'stored-turns',readOnly:true} };
}
