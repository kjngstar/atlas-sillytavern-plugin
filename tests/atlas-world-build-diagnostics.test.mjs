/**
 * P14 §20 — 工作台、诊断与分析导出的可核对回归。
 *
 * 覆盖验收项：
 * - T-D01 多窗口全局 job：阶段/覆盖/窗口/累计请求与停止可见；
 * - T-D02 失败/阻塞/等待分类准确，集中重试只处理失败；
 * - T-D04 同 floor/object/code 矛盾稳定去重，不刷屏；
 * - T-D05 进度/失败/矛盾只进工作台，不插聊天；
 * - T-D07 旧日志/留存淘汰/账本重叠：null + 下界，不伪造 0、不重复相加；
 * - T-D08 raw/visible/reasoning 字符口径分开，未知为 null，不输出推理正文；
 * - T-D09 恶意错误含密钥/URL/用户正文时导出无敏感原文。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import initSql from 'sql.js';

import { measureResponseLengths, summarizeTransportTiming, transportMetricsFromDetails } from '../src/atlas-response-metrics.ts';
import { sanitizeDiagnostic, atlasRefFingerprint } from '../src/atlas-diagnostics.ts';
import { sanitizeModelCallAudit, createModelCallAudit } from '../src/atlas-model-call-audit.ts';
import {
  countsAsBusinessTurn,
  dedupeContradictionsByFloor,
  groupTurnTransportTotals,
  planFailedRetry,
  summarizeTurnTransports,
  transportKey,
} from '../src/atlas-turn-analysis-groups.ts';
import { buildWorkbenchStatus, sortWorkbenchFailures } from '../src/atlas-workbench-status.ts';
import { queryTurnAnalysis } from '../src/atlas-turn-analysis-view.ts';
import { buildTurnAnalysisExport } from '../ui/atlas-turn-analysis-export.mjs';
import { buildMapAnalysisExport } from '../ui/atlas-map-export.mjs';
import { queryBound, runBound } from '../src/atlas-db-runtime.ts';
import { makeSeedWith, IDS } from './fixtures/atlas-sql/seed.mjs';

/* ------------------------------------------------------------------ *
 * §20.3 长度三口径
 * ------------------------------------------------------------------ */

const openAi = (content, extra = {}) => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content, ...extra } }] });

test('§20.3 raw / visible / reasoning 三个长度分开算，推理缺失时为 null 而不是 0', () => {
  const raw = openAi('{"op":"noop"}');
  const metrics = measureResponseLengths(JSON.parse(raw), raw);
  assert.equal(metrics.rawResponseChars, raw.length, 'raw 是传输长度');
  assert.equal(metrics.visibleTextChars, '{"op":"noop"}'.length, 'visible 是助手正文长度');
  assert.equal(metrics.reasoningTextChars, null, '没有推理字段就是 null：未知 ≠ 0');
  assert.ok(metrics.rawResponseChars > metrics.visibleTextChars, 'JSON 包装让 raw 更大 —— 所以不能用差值当推理');

  const reasoned = measureResponseLengths(JSON.parse(raw), raw + '\n\n\n');
  assert.equal(reasoned.reasoningTextChars, null, '多出来的空白不能被当成推理长度');
});

test('§20.3 有明确推理字段时才计长度，且只计长度不落正文', () => {
  const raw = openAi('', { reasoning_content: 'thinking-hard-about-doors' });
  const metrics = measureResponseLengths(JSON.parse(raw), raw);
  assert.equal(metrics.visibleTextChars, 0, 'content 存在但为空 → 可见长度是 0（不是未知）');
  assert.equal(metrics.reasoningTextChars, 'thinking-hard-about-doors'.length);
  assert.equal(JSON.stringify(metrics).includes('thinking-hard'), false, '只留长度，不留推理正文');

  const thinking = measureResponseLengths(
    { responseContent: { parts: [{ text: 'visible part' }, { text: 'thought part', thought: true }] } },
    '{"responseContent":"…"}',
  );
  assert.equal(thinking.visibleTextChars, 'visible part'.length);
  assert.equal(thinking.reasoningTextChars, 'thought part'.length);
});

test('§20.3 认不出响应形状时长度未知，也不拿 raw 长度顶替', () => {
  const raw = 'data: not-json\n';
  const metrics = measureResponseLengths(null, raw);
  assert.equal(metrics.rawResponseChars, raw.length);
  assert.equal(metrics.visibleTextChars, null);
  assert.equal(metrics.reasoningTextChars, null);
});

test('§20.3 headersMs / bodyMs 单列；覆盖兼容重发的耗时不得当单次累加', () => {
  const summary = summarizeTransportTiming([
    { headersMs: 120, bodyMs: 800, logicalDurationMs: 1000 },
    { headersMs: 130, bodyMs: 900, logicalDurationMs: 2000, durationIncludesCompatibilityRetry: true },
  ]);
  assert.equal(summary.transportsWithHeaders, 2);
  assert.equal(summary.transportsWithBody, 2);
  assert.equal(summary.singleRequestLogicalMs, 1000, '只有单次那一条进单次合计');
  assert.equal(summary.transportsCoveringRetry, 1);
  assert.equal(summary.retryCoveringLogicalMs, 2000);
  assert.equal(summary.timingUnknown, false);

  assert.equal(summarizeTransportTiming([]).timingUnknown, true, '没有计时证据就是未知，不是 0ms');
});

test('§20.3 诊断白名单放行新长度字段，但拒绝负数/小数/正文', () => {
  const safe = sanitizeDiagnostic({
    level: 'info', source: 'model', code: 'MODEL_REQUEST_COMPLETED',
    operation: 'generation', phase: 'response', outcome: 'success',
    details: {
      rawResponseChars: 900, visibleTextChars: null, reasoningTextChars: 12,
      headersMs: 90, bodyMs: 700, durationIncludesCompatibilityRetry: true,
    },
  });
  assert.equal(safe.details.rawResponseChars, 900);
  assert.equal(safe.details.visibleTextChars, null, '显式 null 必须保留：表示「探测过、没有该字段」');
  assert.equal(safe.details.reasoningTextChars, 12);
  assert.equal(safe.details.durationIncludesCompatibilityRetry, true);

  const dirty = sanitizeDiagnostic({
    level: 'info', source: 'model', code: 'MODEL_REQUEST_COMPLETED',
    operation: 'generation', phase: 'response', outcome: 'success',
    details: { rawResponseChars: -1, visibleTextChars: 1.5, reasoningTextChars: 'sk-live-secret-and-story-text' },
  });
  assert.equal(dirty.details?.rawResponseChars, undefined, '负数不是测量值');
  assert.equal(dirty.details?.visibleTextChars, undefined, '小数不是字符数');
  assert.equal(JSON.stringify(dirty).includes('sk-live-secret'), false, '字符串塞不进长度字段');
});

test('§20.3 审计记录保留分段耗时与兼容重发标记，旧记录缺字段仍是未知', () => {
  const journal = createModelCallAudit();
  journal.sent('geography', 'batch-a', { kind: 'maps' });
  const batchRef = atlasRefFingerprint('batch-a');
  const requestRef = atlasRefFingerprint('request-a');
  journal.observe(sanitizeDiagnostic({
    level: 'info', source: 'model', code: 'MODEL_REQUEST_STARTED', operation: 'generation', phase: 'request', outcome: 'started',
    requestRef, details: { batchRef, transportAttempt: 1 },
  }));
  journal.observe(sanitizeDiagnostic({
    level: 'info', source: 'model', code: 'MODEL_RESPONSE_HEADERS', operation: 'generation', phase: 'headers', outcome: 'success',
    requestRef, details: { batchRef, transportAttempt: 1, headersMs: 88 },
  }));
  journal.observe(sanitizeDiagnostic({
    level: 'info', source: 'model', code: 'MODEL_REQUEST_COMPLETED', operation: 'generation', phase: 'response', outcome: 'success',
    requestRef, durationMs: 900,
    details: { batchRef, transportAttempt: 1, headersMs: 88, bodyMs: 700, rawResponseChars: 400, visibleTextChars: 300, reasoningTextChars: null, durationIncludesCompatibilityRetry: true },
  }));
  const call = journal.snapshot().calls[0];
  assert.equal(call.headersMs, 88);
  assert.equal(call.bodyMs, 700);
  assert.equal(call.rawResponseChars, 400);
  assert.equal(call.visibleTextChars, 300);
  assert.equal(call.reasoningTextChars, null, 'null 必须原样保留');
  assert.equal(call.durationIncludesCompatibilityRetry, true);

  const projected = sanitizeModelCallAudit(JSON.parse(JSON.stringify(journal.snapshot()))).calls[0];
  assert.deepEqual(
    { headersMs: projected.headersMs, bodyMs: projected.bodyMs, visibleTextChars: projected.visibleTextChars, durationIncludesCompatibilityRetry: projected.durationIncludesCompatibilityRetry },
    { headersMs: 88, bodyMs: 700, visibleTextChars: 300, durationIncludesCompatibilityRetry: true },
  );

  const legacy = sanitizeModelCallAudit({ version: 1, transports: 1, droppedCalls: 0,
    calls: [{ sequence: 1, batchRef, stage: 'geography', workClass: 'maps', reason: 'scheduled', status: 'completed' }] }).calls[0];
  assert.equal(legacy.headersMs, undefined, '旧记录没有该字段就是未知，不补 0');
  assert.equal(transportMetricsFromDetails({}).metrics.rawResponseChars, undefined);
});

/* ------------------------------------------------------------------ *
 * §20.2 计数纪律
 * ------------------------------------------------------------------ */

test('§20.2 迁移/纯本地/无证据各自不计入业务轮，理由不同', () => {
  assert.deepEqual(countsAsBusinessTurn({ kind: 'migration', countSource: 'transport-journal', recordedModelTransports: 0, worldChanged: false, timeChanged: false }),
    { countsAsBusinessTurn: false, reason: 'non-generation-turn' });
  assert.deepEqual(countsAsBusinessTurn({ kind: 'manual', countSource: 'transport-journal', recordedModelTransports: 0, worldChanged: true, timeChanged: false }),
    { countsAsBusinessTurn: false, reason: 'non-generation-turn' });
  assert.deepEqual(countsAsBusinessTurn({ kind: 'narrative', countSource: 'transport-journal', recordedModelTransports: 0, worldChanged: false, timeChanged: false }),
    { countsAsBusinessTurn: false, reason: 'local-only' });
  assert.deepEqual(countsAsBusinessTurn({ kind: 'narrative', countSource: 'unknown', recordedModelTransports: null, worldChanged: true, timeChanged: false }),
    { countsAsBusinessTurn: false, reason: 'no-transport-evidence' }, '读不到次数不能当成 0 次');
  assert.deepEqual(countsAsBusinessTurn({ kind: 'narrative', countSource: 'transport-journal', recordedModelTransports: 3, worldChanged: true, timeChanged: false }),
    { countsAsBusinessTurn: true });
});

test('§20.2 去重键是 requestRef+transportAttempt；重叠的来源不直接相加', () => {
  assert.equal(transportKey({ requestRef: 'ref-aaaaaaaa', transportAttempt: 1 }), 'ref-aaaaaaaa#1');
  assert.equal(transportKey({ requestRef: '', transportAttempt: 1 }), null);
  assert.equal(transportKey({ requestRef: 'ref-aaaaaaaa' }), null, '缺一半就不是可核对的键');

  const requestRef = atlasRefFingerprint('same-request');
  const shared = [{ requestRef, transportAttempt: 1 }, { requestRef, transportAttempt: 2 }];
  const summary = summarizeTurnTransports([
    { countSource: 'transport-journal', calls: shared, recordedModelTransports: 2, droppedCalls: 0 },
    { countSource: 'transport-journal', calls: shared, recordedModelTransports: 2, droppedCalls: 0 },
  ]);
  assert.equal(summary.transports, 2, '同一批传输出现两次只算两次传输，不是四次');
  assert.equal(summary.sourcesNotAddable, true);

  const overlapping = summarizeTurnTransports([
    { countSource: 'transport-journal', calls: shared, recordedModelTransports: 2, droppedCalls: 0 },
    { countSource: 'unknown', recordedModelTransports: 5 },
  ]);
  assert.equal(overlapping.transports, null, '有旧记录 → 整栏降级为 null，不伪造数字');
  assert.equal(overlapping.transportsLowerBound, 7, '下界 = 已知键 2 + 旧记录自报 5');
  assert.equal(overlapping.turnsWithoutCompleteLedger, 1);
});

test('§20.2 楼层栏与窗口栏重叠，不提供相加入口', () => {
  const requestRef = atlasRefFingerprint('floor-window');
  const turns = [
    { countSource: 'transport-journal', calls: [{ requestRef, transportAttempt: 1 }], floorRef: 'floor-a', windowSequence: 0 },
    { countSource: 'transport-journal', calls: [{ requestRef, transportAttempt: 2 }], floorRef: 'floor-a', windowSequence: 0 },
    { countSource: 'transport-journal', calls: [{ requestRef, transportAttempt: 3 }], floorRef: 'floor-b', windowSequence: 1 },
  ];
  const totals = groupTurnTransportTotals(turns);
  assert.equal(totals.overall.transports, 3, '全局按去重键算是 3');
  assert.equal(totals.byFloor.find(row => row.floorRef === 'floor-a').transports, 2);
  assert.equal(totals.byFloor.find(row => row.floorRef === 'floor-b').transports, 1);
  assert.equal(totals.byWindow.find(row => row.windowSequence === 0).transports, 2);
  assert.equal(totals.floorAndWindowTotalsAreIndependent, false);
  assert.equal(totals.byFloor.reduce((sum, row) => sum + row.transports, 0), 3);
  assert.equal(totals.byFloor.reduce((sum, row) => sum + row.transports, 0)
    + totals.byWindow.reduce((sum, row) => sum + row.transports, 0), 6, '两栏相加会翻倍——所以导出里禁止相加');
});

/* ------------------------------------------------------------------ *
 * §20.1 工作台
 * ------------------------------------------------------------------ */

const target = (overrides = {}) => ({
  version: 1, id: 'target-a', jobId: 'job-a', subjectId: null, workKind: 'entity-construction',
  requirement: 'source-required', depth: 0, dependencyIds: [], inputSignature: 'sig',
  status: 'pending', attempts: 0, failureFingerprint: null, lastErrorCode: null,
  originFloorId: 'floor-a', eventId: null, ...overrides,
});
const job = (overrides = {}) => ({
  version: 1, id: 'job-a', branchId: 'branch-a', kind: 'initialize', status: 'running',
  sourceManifestHash: 'hash', policyVersion: 'policy', originFloorId: 'floor-a', runEpoch: 0,
  nextWindowSequence: 3, committedWindowSequence: 2, cumulativeTransports: 7, cumulativeWindows: 2,
  stopReason: null, ...overrides,
});

test('§20.1 工作台给全：阶段/覆盖/五桶/窗口/累计请求/停止与集中重试', () => {
  const status = buildWorkbenchStatus({
    job: job(),
    targets: [
      target({ id: 't-done', status: 'done' }),
      target({ id: 't-pending', status: 'pending' }),
      target({ id: 't-failed', status: 'failed', attempts: 2, lastErrorCode: 'LAYOUT_MISSING' }),
      target({ id: 't-blocked', status: 'blocked' }),
      target({ id: 't-waiting', status: 'waiting-for-entry', requirement: 'deferred-interior' }),
      target({ id: 't-scan', status: 'done', workKind: 'source-scan' }),
      target({ id: 't-plan', status: 'done', workKind: 'settlement-plan' }),
    ],
    maps: { registered: 12, laidOut: 9 },
    sourceScanComplete: true,
    settlementPlansExpanded: true,
    legacyRowCount: 3,
  });
  assert.equal(status.job.kind, 'initialize');
  assert.equal(status.job.autoFetch, false, '展示层不许触发请求');
  assert.equal(status.phase, 'layout');
  assert.equal(status.sourceScan.scopeSealed, true);

  // 必建分母五桶互不重叠：done 3（t-done / t-scan / t-plan）、pending 1、failed 1、blocked 1。
  assert.deepEqual(status.totals.required, { total: 6, done: 3, pending: 1, failed: 1, blocked: 1 });
  assert.equal(status.totals.deferredInteriors, 1, '等待实际进入单列，不算失败也不进必建分母');
  assert.equal(status.totals.byRequirement['source-required'], 6);
  assert.equal(status.totals.byRequirement['deferred-interior'], 1);

  assert.deepEqual(status.mapLayouts, { registered: 12, laidOut: 9 }, '真实地图布局数量');
  assert.equal(status.windows.current, null,'没有运行所有权证据时不把已提交窗口当成当前窗口');
  assert.equal(status.windows.committed, 2);
  assert.equal(status.windows.cumulativeTransports, 7);
  assert.equal(status.windows.extraReasons, null, '没有账本 → 原因未知，不写空数组冒充「没有额外请求」');

  assert.equal(status.actions.canStop, true);
  assert.equal(status.actions.canRetryFailed, true);
  assert.deepEqual(status.actions.failedTargets.map(row => row.targetRef), ['t-failed']);
  assert.deepEqual(status.actions.blockedTargets.map(row => row.targetRef), ['t-blocked']);
  assert.match(status.actions.retryScope, /只重试 1 个失败目标/);
});

test('§20.1 读不到地图数就是 null，不写 0；已完成任务不再暴露「停止」', () => {
  const status = buildWorkbenchStatus({ job: job({ status: 'completed' }), targets: [target({ status: 'done' })], maps: null });
  assert.deepEqual(status.mapLayouts, { registered: null, laidOut: null });
  assert.equal(status.actions.canStop, false);
  assert.equal(status.actions.canRetryFailed, false);
  assert.equal(status.actions.retryScope, null);
  assert.equal(buildWorkbenchStatus({ job: null, targets: [] }).job, null);
});

test('§20.1 / T-D05 / R41 进度与失败只进工作台，不插聊天、不开人工纠正入口', () => {
  const status = buildWorkbenchStatus({ job: job(), targets: [target({ status: 'failed' })], maps: { registered: 1, laidOut: 1 } });
  assert.equal(status.chatInjection, false, '不把提示消息插进酒馆聊天');
  assert.deepEqual(status.manualOverrides, [], '本轮不新增手动改重要性/坐标/世界事实入口');
  const serialized = JSON.stringify(status);
  for (const forbidden of ['setExtensionPrompt', 'role:system', 'chatMessage', 'importance', 'gridX', 'gridY']) {
    assert.equal(serialized.includes(forbidden), false, `工作台状态不得包含 ${forbidden}`);
  }
});

test('T-D02 集中重试只处理失败项，不重做成功图，阻塞单列', () => {
  const plan = planFailedRetry([
    { targetRef: 'a', workKind: 'map-layout', requirement: 'source-required', status: 'failed', lastErrorCode: 'X', attempts: 2 },
    { targetRef: 'b', workKind: 'map-layout', requirement: 'source-required', status: 'blocked', lastErrorCode: 'Y', attempts: 1 },
    { targetRef: 'c', workKind: 'map-layout', requirement: 'source-required', status: 'done', lastErrorCode: null, attempts: 1 },
    { targetRef: 'd', workKind: 'route-reconcile', requirement: 'source-required', status: 'waiting-for-entry', lastErrorCode: null, attempts: 0 },
  ]);
  assert.deepEqual(plan.candidates.map(row => row.targetRef), ['a']);
  assert.deepEqual(plan.dependencyBlocked.map(row => row.targetRef), ['b']);
  assert.equal(plan.excludesCompleted, true);
  assert.deepEqual(sortWorkbenchFailures(plan.candidates).map(row => row.targetRef), ['a']);
});

/* ------------------------------------------------------------------ *
 * T-D04 矛盾去重
 * ------------------------------------------------------------------ */

test('T-D04 同 floor/object/code 合并为一条，跨楼层各自保留', () => {
  const merged = dedupeContradictionsByFloor([
    { issueId: 'i1', code: 'SIGHT_THROUGH_OPAQUE', objectId: 'F1', floorRef: 'floor-a', turnRef: 'turn-1', message: '旧说明' },
    { issueId: 'i2', code: 'SIGHT_THROUGH_OPAQUE', objectId: 'F1', floorRef: 'floor-a', turnRef: 'turn-2', message: '新说明' },
    { issueId: 'i3', code: 'SIGHT_THROUGH_OPAQUE', objectId: 'F1', floorRef: 'floor-b', turnRef: 'turn-3', message: '另一层' },
    { issueId: 'i4', code: 'LOCKED_ENTRY_CROSSED', objectId: 'F1', floorRef: 'floor-a', turnRef: 'turn-4', message: '不同代码' },
  ]);
  assert.equal(merged.length, 3, '同层同物同码只留一条');
  const first = merged.find(row => row.floorRef === 'floor-a' && row.code === 'SIGHT_THROUGH_OPAQUE');
  assert.equal(first.occurrences, 2);
  assert.equal(first.issueId, 'i2', '保留最近一次');
  assert.equal(first.message, '新说明');
  assert.equal(first.firstTurnRef, 'turn-1');
  assert.equal(first.lastTurnRef, 'turn-2');
});

/* ------------------------------------------------------------------ *
 * T-D07 / 端到端：逐轮分析视图 + 导出
 * ------------------------------------------------------------------ */

const SQL = await initSql();
function insertTurn(db, id, { status = 'committed', kind = 'narrative', receipt = {}, attempts = [], time = 1700000000100, branch = IDS.branchMain, message = id } = {}) {
  const template = queryBound(db, 'SELECT * FROM turns WHERE id=?', [IDS.seedTurn])[0];
  const row = { ...template, id, branch_id: branch, host_message_uid: message, host_variant_key: 'original', kind, status, created_wall_ms: time,
    receipt_json: JSON.stringify({ status, ...receipt }), attempts_json: JSON.stringify(attempts) };
  const columns = Object.keys(row);
  runBound(db, `INSERT INTO turns (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, columns.map(key => row[key]));
}

test('T-D07 旧记录次数为 null + 下界；完整账本才给数字', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const requestRef = atlasRefFingerprint('request-legacy');
    insertTurn(seed.db, 'legacy-floor', { receipt: { attempts: [] } });
    insertTurn(seed.db, 'journal-floor', {
      time: 1700000000200,
      receipt: { requestAudit: { version: 1, transports: 1, byWorkClass: { maps: 1 }, droppedCalls: 0,
        calls: [{ sequence: 1, batchRef: atlasRefFingerprint('b1'), stage: 'geography', workClass: 'maps', reason: 'scheduled', status: 'completed', requestRef, transportAttempt: 1 }] } },
    });
    const page = queryTurnAnalysis({ db: seed.db, chatId: IDS.chatA, branchId: IDS.branchMain, revision: 0, viewMode: 'author' },
      { kind: 'turn-analysis', branchId: IDS.branchMain });
    const legacy = page.items.find(item => item.recordedModelTransports === null);
    const journaled = page.items.find(item => item.recordedModelTransports === 1);
    assert.equal(legacy.transport.transports, null, '旧记录不能伪造 0');
    assert.equal(legacy.countsAsBusinessTurn, false);
    assert.equal(legacy.countExclusionReason, 'no-transport-evidence');
    assert.equal(journaled.transport.transports, 1);
    assert.equal(journaled.countsAsBusinessTurn, true, '发过请求的轮次必须计入分母');

    assert.equal(page.summary.transport.transports, null, '相关记录不全 → 整栏 null');
    assert.ok(page.summary.transport.transportsLowerBound >= 1, '但下界仍然有证据');
    assert.equal(page.summary.floorAndWindowTotalsAreIndependent, false);
    assert.equal(JSON.stringify(page.items).includes('request-legacy'), false, '不导出原始标识');
  } finally {
    seed.db.close();
  }
});

test('§20.2 逐轮分析带上楼层引用与建图关联；没有 job 时如实说未记录', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    insertTurn(seed.db, 'with-floor', { message: 'floor-uid-1' });
    const page = queryTurnAnalysis({ db: seed.db, chatId: IDS.chatA, branchId: IDS.branchMain, revision: 0, viewMode: 'author' },
      { kind: 'turn-analysis', branchId: IDS.branchMain });
    assert.equal(page.items[0].floorRef, atlasRefFingerprint('floor-uid-1'), '楼层引用是脱敏指纹');
    assert.equal(page.items[0].buildLinkage, null);
    assert.equal(page.summary.windowLinkage, 'no-build-job-recorded', '没有建图任务就说没有，不编一个窗口');
    assert.deepEqual(page.summary.jobWindows, []);
  } finally {
    seed.db.close();
  }
});

test('§20.2 / §20.3 导出把投影原样带上，且两栏合计禁止相加', () => {
  const identity = { chatFingerprint: atlasRefFingerprint('chat-x'), details: { branchRef: atlasRefFingerprint('branch-x'), turnRef: atlasRefFingerprint('turn-x') } };
  const page = { scope: 'all-stored-turns', businessTurns: 2, excludedTurns: 1,
    transport: { transports: 3, transportsLowerBound: 3, turnsWithoutCompleteLedger: 0 },
    groups: { byFloor: [{ floorRef: 'f1', turns: 2, transports: 3, transportsLowerBound: 3 }], byWindow: [{ windowSequence: 0, turns: 2, transports: 3, transportsLowerBound: 3 }] },
    jobWindows: [{ jobRef: 'job', cumulativeWindows: 1 }], windowLinkage: 'job-payload-cumulative' };
  const file = buildTurnAnalysisExport({
    turns: [{ turnRef: identity.details.turnRef, floorRef: 'f1', countsAsBusinessTurn: true,
      lengths: { rawResponseChars: 900, visibleTextChars: 700, reasoningTextChars: null },
      timing: { singleRequestLogicalMs: 1000, transportsCoveringRetry: 0, retryCoveringLogicalMs: 0 },
      transport: { transports: 3, transportsLowerBound: 3 },
      requestAudit: { version: 1, transports: 3, byWorkClass: { maps: 3 }, droppedCalls: 0, calls: [] }, attempts: [] }],
    diagnostics: [], scope: identity, projection: [page],
  });
  assert.equal(file.projection.transports, 3);
  assert.equal(file.projection.floorAndWindowTotalsAreIndependent, false);
  assert.equal(file.rounds[0].floorRef, 'f1');
  assert.equal(file.rounds[0].countsAsBusinessTurn, true);
  assert.deepEqual(file.rounds[0].lengths, { rawResponseChars: 900, visibleTextChars: 700, reasoningTextChars: null });
  assert.match(file.explanation.lengths, /不从原始与可见的差值推断/);
  assert.match(file.explanation.totals, /不要相加/);

  const incomplete = buildTurnAnalysisExport({
    turns: [], diagnostics: [], scope: identity,
    projection: [{ transport: { transports: null, transportsLowerBound: 4, turnsWithoutCompleteLedger: 1 } }],
  });
  assert.equal(incomplete.projection.transports, null, '任一页不确定 → 整份 null');
  assert.equal(incomplete.projection.transportsLowerBound, 4);
});

/* ------------------------------------------------------------------ *
 * T-D05 接线：UI 数据层必须原样搬运 buildStatus（不二次汇总）
 * ------------------------------------------------------------------ */

test('T-D05 工作台数据层原样搬运 buildStatus，缺省为 null', async () => {
  const { projectReferenceData, emptyReferenceData } = await import('../ui/atlas-reference-data.mjs');
  const status = buildWorkbenchStatus({
    job: job(), targets: [target({ status: 'failed' })], maps: { registered: 3, laidOut: 2 },
  });
  const projected = projectReferenceData({ state: { stateData: { buildStatus: status } } });
  assert.deepEqual(projected.buildStatus.totals.required, status.totals.required, '五桶原样搬运');
  assert.deepEqual(projected.buildStatus.mapLayouts, { registered: 3, laidOut: 2 });
  assert.equal(projected.buildStatus.chatInjection, false);
  assert.equal(projectReferenceData({ state: { stateData: {} } }).buildStatus, null, '没有状态就是 null，不编一份空壳');
  assert.equal(emptyReferenceData().buildStatus, undefined, '空数据不给默认建图态');
});

/* ------------------------------------------------------------------ *
 * §20.4 地图分析导出
 * ------------------------------------------------------------------ */

const fixture = () => {
  const node = { id: 'M1', host: true, name: '甲镇', children: [], renderKind: 'grid', extent: [10, 10], transform: {}, metric: {}, geo: {},
    marks: [{ node: null, x: 1, y: 2, kind: 'location' }] };
  return {
    data: { meta: { revision: 7, viewMode: 'player' }, ROOT: { id: 'ROOT', children: [node] } },
    mapView: { branchId: 'main', revision: 7, viewMode: 'player', items: [{
      mapId: 'M1', name: '甲镇', kind: 'site', containerLocationId: null, points: [{ kind: 'location', entityId: 'L1' }],
      connectionQuality: 'estimated', topologyIssueCodes: ['ROUTE_UNVERIFIED'], frames: { frame: { width: 10 } },
      metersPerCell: 4, scaleLocked: true, scaleQuality: 'estimated',
      routes: [
        { routeId: 'R1', fromId: 'L1', toId: 'L2', mapId: 'M1', kind: 'road', status: 'open', geometryQuality: 'estimated', geometry: { points: [] } },
        { routeId: 'R2', fromId: 'L1', toId: 'L3', mapId: 'M1', kind: 'road', status: 'closed', geometryQuality: 'unknown', geometry: null },
        { routeId: 'R3', fromId: 'L1', toId: 'L9', mapId: 'M2', kind: 'sea', status: 'open', geometryQuality: 'estimated', geometry: { points: [] } },
      ],
    }] },
    sceneView: { branchId: 'main', revision: 7, viewMode: 'player', items: [{ mapId: 'M1', sceneStatus: 'ready', scene: { generator: 'layout-v3' }, issues: [{ code: 'X' }] }] },
    catalogView: { branchId: 'main', revision: 7, viewMode: 'player', items: [] },
    mapId: 'M1',
    buildCoverage: { sourceScanComplete: true, scopeSealed: true, requiredTargets: 6, requiredDone: 4, requiredPending: 1,
      requiredFailed: 1, requiredBlocked: 0, deferredInteriors: 2, registeredMaps: 3, readyMaps: 2, cumulativeTransports: 11,
      completedWithIssues: false },
  };
};

test('§20.4 地图导出带覆盖摘要、路线归属与未绘制原因、质量块', () => {
  const { file } = buildMapAnalysisExport(fixture());
  const map = file.maps[0];
  assert.deepEqual(map.coverage.routes, { total: 3, withGeometry: 2, withoutGeometry: 1, undrawnReasons: ['route-closed-no-geometry'] });
  assert.deepEqual(map.coverage.points, { location: 1 });
  assert.equal(map.coverage.sceneStatus, 'ready');
  assert.equal(map.quality.scaleLocked, true);
  assert.equal(map.quality.connection, 'estimated');

  const closed = map.routes.find(route => route.routeId === 'R2');
  assert.equal(closed.undrawnReason, 'route-closed-no-geometry', '没有几何才叫未绘制，并给出原因');
  assert.equal(map.routes.find(route => route.routeId === 'R1').undrawnReason, null, '有几何就不写未绘制原因');
  assert.equal(map.routes.find(route => route.routeId === 'R3').attribution.drawnOnThisMap, false, '跨图路线归属如实标出');

  assert.deepEqual(file.buildCoverage.maps, { registered: 3, laidOut: 2 });
  assert.deepEqual(file.buildCoverage.required, { total: 6, done: 4, pending: 1, failed: 1, blocked: 0 });
  assert.equal(file.scope.occupancyBasis, 'player-visible-full');
  assert.match(file.scope.occupancyNote, /玩家可见全量/);
});

test('§20.4 没有覆盖数据时是 null，读不到的单项也是 null 而不是 0', () => {
  const base = fixture();
  const without = buildMapAnalysisExport({ ...base, buildCoverage: null }).file;
  assert.equal(without.buildCoverage, null, '不传就是 null，不写全 0 的假摘要');
  const partial = buildMapAnalysisExport({ ...base, buildCoverage: { requiredTargets: 2, registeredMaps: null, readyMaps: null } }).file;
  assert.equal(partial.buildCoverage.required.total, 2);
  assert.deepEqual(partial.buildCoverage.maps, { registered: null, laidOut: null });
});

test('T-D09 导出文件里不出现密钥、URL 或隐藏内容', () => {
  const base = fixture();
  // 未在导出契约里的字段（连接密钥）绝不能跟着地图 DTO 一起漏出去。
  base.mapView.items[0].apiKey = 'sk-live-secret';
  base.mapView.items[0].endpoint = 'https://evil.invalid/v1';
  // hidden 路线（POV 下不可见）必须被排除，连 routeId 都不该出现。
  base.mapView.items[0].routes.push({ routeId: 'R-HIDDEN', fromId: 'L1', toId: 'L7', mapId: 'M1', kind: 'road', status: 'open', hidden: true, geometry: { points: [] } });
  const file = buildMapAnalysisExport(base).file;
  const serialized = JSON.stringify(file);
  for (const secret of ['sk-live-secret', 'evil.invalid']) {
    assert.equal(serialized.includes(secret), false, `地图导出不得包含 ${secret}`);
  }
  assert.equal(serialized.includes('R-HIDDEN'), false, '隐藏路线不进分析文件');
  assert.equal(serialized.includes('https://'), false, '导出不包含任何原始 URL');
  const turnFile = buildTurnAnalysisExport({
    turns: [{ turnRef: 'turn-x', requestAudit: { version: 1, transports: 1, byWorkClass: { maps: 1 }, droppedCalls: 0,
      calls: [{ sequence: 1, batchRef: 'ref-bbbbbbbb', stage: 'geography', workClass: 'maps', reason: 'scheduled', status: 'completed' }] }, attempts: [] }],
    diagnostics: [sanitizeDiagnostic({ level: 'error', source: 'model', code: 'MODEL_REQUEST_FAILED', operation: 'generation',
      phase: 'response', outcome: 'failed', errorCode: 'API_AUTH_FAILED',
      details: { route: 'https://evil.invalid/?key=sk-live-secret', model: 'sk-live-secret', reasonCode: 'sk-live-secret' } })],
    scope: { chatFingerprint: atlasRefFingerprint('c'), branchRef: atlasRefFingerprint('b') },
  });
  const serializedTurns = JSON.stringify(turnFile);
  for (const secret of ['sk-live-secret', 'evil.invalid', 'https://']) {
    assert.equal(serializedTurns.includes(secret), false, `逐轮导出不得包含 ${secret}`);
  }
});
