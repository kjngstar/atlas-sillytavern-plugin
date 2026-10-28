/**
 * atlas-world-build-state.test.mjs — P01 进度行命名空间编码/读取与旧 V1 回归。
 *
 * 覆盖：job / target / fact 编码解码往返；行 ID 稳定派生；SQL 粗状态映射；
 * payload 超预算拒绝；读取按 payloadKind 过滤（旧行不被当新行）；
 * 坏 payload 与未知 version 的逐行报错；**旧 V1 bootstrap 进度仍可被 readScanState 正确读取**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, insertRows } from './fixtures/atlas-sql/seed.mjs';
import { createTableReadPort } from '../src/atlas-db-readport.ts';
import { readProgressRows, readScanState } from '../src/atlas-construction-progress.ts';
import {
  encodeWorldBuildJobPayload,
  encodeWorldBuildTargetPayload,
  encodeWorldFactPayload,
  worldBuildJobMutation,
  worldBuildTargetMutation,
  worldFactMutation,
  worldBuildJobRowId,
  worldBuildTargetRowId,
  worldFactRowId,
  readWorldBuildJobs,
  readWorldBuildTargets,
  readWorldFacts,
  isWorldBuildJobRow,
  isWorldBuildTargetRow,
  isWorldFactRow,
  isLegacyConstructionRow,
  legacyConstructionRows,
  progressRowPayloadKind,
  WORLD_BUILD_PAYLOAD_BUDGET_BYTES,
  PAYLOAD_KIND_FIELD,
} from '../src/atlas-world-build-state.ts';
import {
  decodeWorldBuildJob,
  decodeWorldBuildTarget,
  worldBuildScopeKey,
  worldBuildTargetSubjectKey,
  WORLD_FACTS_SCOPE_KEY,
  worldFactSubjectKey,
} from '../src/atlas-world-build-contract.ts';
import { checkCoverageInvariant, canReportFinalCompletion } from '../src/atlas-world-contract.ts';
import { decodeWorldFact } from '../src/atlas-world-fact-policy.ts';

const SQL = await (await import('sql.js')).default();
const BRANCH = IDS.branchMain;
const CTX = { branchId: BRANCH, turnId: 'turn-p01', opId: 'op-p01' };

function job(overrides = {}) {
  return {
    version: 1,
    id: 'job-1',
    branchId: BRANCH,
    kind: 'initialize',
    status: 'running',
    sourceManifestHash: 'sha256:manifest',
    policyVersion: 'world-build/v1',
    originFloorId: 'floor-1',
    runEpoch: 0,
    nextWindowSequence: 1,
    committedWindowSequence: 0,
    cumulativeTransports: 3,
    cumulativeWindows: 1,
    stopReason: null,
    ...overrides,
  };
}

function target(overrides = {}) {
  return {
    version: 1,
    id: 'target-1',
    jobId: 'job-1',
    subjectId: 'loc-1',
    workKind: 'map-layout',
    requirement: 'source-required',
    depth: 1,
    dependencyIds: [],
    inputSignature: 'sig-target-1',
    status: 'pending',
    attempts: 0,
    failureFingerprint: null,
    lastErrorCode: null,
    originFloorId: 'floor-1',
    eventId: null,
    ...overrides,
  };
}

function fact(overrides = {}) {
  return {
    version: 1,
    id: 'fact-1',
    subjectId: 'loc-tavern',
    predicate: 'exists',
    layer: 'baseline',
    origin: 'lorebook',
    producer: 'program',
    sourceKey: 'lore:world#1',
    sourceHash: 'sha256:aaa',
    sourceSpan: { start: 0, end: 12 },
    quality: 'confirmed',
    effectiveTurnId: 'turn-1',
    effectiveClockS: null,
    supersedesFactId: null,
    value: true,
    ...overrides,
  };
}

/** 造一行进度记录（直接插入，绕开 mutation，用于模拟历史数据）。 */
function progressRow(overrides = {}) {
  return {
    branch_id: BRANCH,
    id: 'cp_row_1',
    row_rev: 1,
    created_turn_id: IDS.seedTurn,
    updated_turn_id: IDS.seedTurn,
    scope_key: 'bootstrap',
    kind: 'scope',
    subject_key: 'bootstrap',
    input_signature: 'sig',
    status: 'processed',
    last_served_seq: 0,
    payload_json: '{}',
    ...overrides,
  };
}

async function seedWith(rows) {
  const seed = await makeSeedWith(SQL);
  if (rows.length > 0) insertRows(seed.db, 'construction_progress', rows);
  return seed;
}

/* ─────────────────────── 编码解码往返 ─────────────────────── */

test('job payload：带 payloadKind，解码回去与输入一致', () => {
  const original = job();
  const payload = encodeWorldBuildJobPayload(original);
  assert.equal(payload[PAYLOAD_KIND_FIELD], 'world-build-job/v1');

  const decoded = decodeWorldBuildJob(payload);
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.value, original);
});

test('target payload：依赖数组与可空字段逐项保留', () => {
  const original = target({ dependencyIds: ['t-a', 't-b'], subjectId: null, eventId: 'evt-3' });
  const payload = encodeWorldBuildTargetPayload(original);
  assert.equal(payload[PAYLOAD_KIND_FIELD], 'world-build-target/v1');

  const decoded = decodeWorldBuildTarget(payload);
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.value, original);
});

test('fact payload：value 是对象时也不被改写', () => {
  const original = fact({ predicate: 'size', value: { w: 6, h: 4, units: 'meters' } });
  const payload = encodeWorldFactPayload(original);
  assert.equal(payload[PAYLOAD_KIND_FIELD], 'world-fact/v1');

  const decoded = decodeWorldFact(payload);
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.value.value, { w: 6, h: 4, units: 'meters' });
});

test('payload 超预算直接报错，不静默截断', () => {
  const huge = target({ dependencyIds: Array.from({ length: 400 }, (_v, i) => `dep-${i}-${'x'.repeat(40)}`) });
  let message = '';
  try {
    encodeWorldBuildTargetPayload(huge);
  } catch (error) {
    message = error.message;
  }
  assert.match(message, new RegExp(String(WORLD_BUILD_PAYLOAD_BUDGET_BYTES)));
  assert.match(message, /不内嵌世界清单|超过/);
});

/* ─────────────────────── 行身份与变更 ─────────────────────── */

test('行 ID 稳定派生：同一 job/target 反复算得同一个 ID', () => {
  assert.equal(worldBuildJobRowId('job-1'), worldBuildJobRowId('job-1'));
  assert.notEqual(worldBuildJobRowId('job-1'), worldBuildJobRowId('job-2'));
  assert.equal(worldBuildTargetRowId('job-1', 't1'), worldBuildTargetRowId('job-1', 't1'));
  assert.notEqual(worldBuildTargetRowId('job-1', 't1'), worldBuildTargetRowId('job-2', 't1'));
  assert.equal(worldFactRowId('f1'), worldFactRowId('f1'));
});

test('job mutation：scope/subject 与 SQL 粗状态按契约落位', () => {
  const mutation = worldBuildJobMutation(CTX, null, job({ status: 'completed-with-issues' }));

  assert.equal(mutation.table, 'construction_progress');
  assert.equal(mutation.after.scope_key, worldBuildScopeKey('job-1'));
  assert.equal(mutation.after.subject_key, 'job');
  assert.equal(mutation.after.kind, 'scope');
  // completed-with-issues 落 processed，但仍要靠 payload.status 区分
  assert.equal(mutation.after.status, 'processed');
  assert.match(String(mutation.after.payload_json), /completed-with-issues/);
  assert.equal(mutation.before, null);
  assert.equal(mutation.after.row_rev, 1);
  assert.equal(mutation.after.created_turn_id, 'turn-p01');
});

test('target mutation：failed 落 suspended，payload 保留精确状态', () => {
  const mutation = worldBuildTargetMutation(CTX, null, target({ status: 'failed', attempts: 3, lastErrorCode: 'LAYOUT_CLOSURE_FAILED' }));

  assert.equal(mutation.after.scope_key, worldBuildScopeKey('job-1'));
  assert.equal(mutation.after.subject_key, worldBuildTargetSubjectKey('target-1'));
  assert.equal(mutation.after.status, 'suspended');
  assert.match(String(mutation.after.payload_json), /"status":"failed"/);
});

test('target mutation：waiting-for-entry 同样 suspended 但语义不同', () => {
  const mutation = worldBuildTargetMutation(CTX, null, target({ status: 'waiting-for-entry', requirement: 'deferred-interior' }));
  assert.equal(mutation.after.status, 'suspended');
  assert.match(String(mutation.after.payload_json), /waiting-for-entry/);
});

test('变更有 before 时 row_rev 递增且保留原 created_turn_id', () => {
  const before = { row_rev: 4, created_turn_id: 'turn-old', last_served_seq: 7 };
  const mutation = worldBuildTargetMutation(CTX, before, target());
  assert.equal(mutation.after.row_rev, 5);
  assert.equal(mutation.after.created_turn_id, 'turn-old');
  assert.equal(mutation.after.updated_turn_id, 'turn-p01');
});

test('fact mutation：事实行落在独立 scope，不混进建设目标', () => {
  const mutation = worldFactMutation(CTX, null, fact());
  assert.equal(mutation.after.scope_key, WORLD_FACTS_SCOPE_KEY);
  assert.equal(mutation.after.subject_key, worldFactSubjectKey('fact-1'));
  assert.equal(mutation.after.status, 'processed');
});

/* ─────────────────── 读取：namespace 过滤 ─────────────────── */

test('读取：job / target / fact 各归各类，互不串行', async () => {
  const seed = await seedWith([
    progressRow({
      id: worldBuildJobRowId('job-1'),
      scope_key: worldBuildScopeKey('job-1'),
      kind: 'scope',
      subject_key: 'job',
      payload_json: JSON.stringify(encodeWorldBuildJobPayload(job())),
    }),
    progressRow({
      id: worldBuildTargetRowId('job-1', 'target-1'),
      scope_key: worldBuildScopeKey('job-1'),
      kind: 'target',
      subject_key: worldBuildTargetSubjectKey('target-1'),
      payload_json: JSON.stringify(encodeWorldBuildTargetPayload(target())),
    }),
    progressRow({
      id: worldFactRowId('fact-1'),
      scope_key: WORLD_FACTS_SCOPE_KEY,
      kind: 'target',
      subject_key: worldFactSubjectKey('fact-1'),
      payload_json: JSON.stringify(encodeWorldFactPayload(fact())),
    }),
  ]);

  const rows = readProgressRows(createTableReadPort(seed.db), BRANCH);

  const jobs = readWorldBuildJobs(rows);
  assert.equal(jobs.values.length, 1);
  assert.equal(jobs.values[0].id, 'job-1');
  assert.equal(jobs.issues.length, 0);

  const targets = readWorldBuildTargets(rows, 'job-1');
  assert.equal(targets.values.length, 1);
  assert.equal(targets.values[0].status, 'pending');

  const facts = readWorldFacts(rows);
  assert.equal(facts.values.length, 1);
  assert.equal(facts.values[0].predicate, 'exists');

  // 三类计数不会互相污染
  assert.equal(rows.filter(isWorldBuildJobRow).length, 1);
  assert.equal(rows.filter(isWorldBuildTargetRow).length, 1);
  assert.equal(rows.filter(isWorldFactRow).length, 1);
});

test('读取：别的 job 的 target 在指定 jobId 时被排除', async () => {
  const seed = await seedWith([
    progressRow({
      id: worldBuildTargetRowId('job-2', 'target-9'),
      scope_key: worldBuildScopeKey('job-2'),
      kind: 'target',
      subject_key: worldBuildTargetSubjectKey('target-9'),
      payload_json: JSON.stringify(encodeWorldBuildTargetPayload(target({ id: 'target-9', jobId: 'job-2' }))),
    }),
  ]);
  const rows = readProgressRows(createTableReadPort(seed.db), BRANCH);

  assert.equal(readWorldBuildTargets(rows, 'job-1').values.length, 0);
  assert.equal(readWorldBuildTargets(rows, 'job-2').values.length, 1);
  assert.equal(readWorldBuildTargets(rows).values.length, 1, '不指定 jobId 时读全部');
});

test('读取：坏 JSON payload 在解码阶段就被明确拒绝，不静默变空对象', async () => {
  const seed = await seedWith([
    progressRow({
      id: 'cp_bad_json',
      scope_key: worldBuildScopeKey('job-x'),
      kind: 'scope',
      subject_key: 'job',
      payload_json: '{not json',
    }),
  ]);

  // codec 的纪律：损坏的 JSON 列必须报具体路径，不能悄悄替换成 {}
  let message = '';
  try {
    readProgressRows(createTableReadPort(seed.db), BRANCH);
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /READ_DECODE_FAILED/);
  assert.match(message, /payload_json/);
});

test('读取：合法 JSON 但未知 version 逐行报错并计入 rejectedRows', async () => {
  const seed = await seedWith([
    progressRow({
      id: 'cp_bad_version',
      scope_key: worldBuildScopeKey('job-y'),
      kind: 'scope',
      subject_key: 'job',
      payload_json: JSON.stringify({ ...encodeWorldBuildJobPayload(job({ id: 'job-y' })), version: 7 }),
    }),
  ]);
  const rows = readProgressRows(createTableReadPort(seed.db), BRANCH);
  const result = readWorldBuildJobs(rows);

  assert.equal(result.values.length, 0);
  assert.equal(result.rejectedRows, 1);
  assert.ok(result.issues.some((issue) => issue.code === 'WORLD_BUILD_VERSION_UNSUPPORTED'));
  assert.equal(result.issues[0].rowId, 'cp_bad_version');
  assert.equal(result.issues[0].scopeKey, worldBuildScopeKey('job-y'));
});

/* ─────────────── 旧 V1 进度回归（P01 完成条件） ─────────────── */

test('旧 V1 bootstrap 进度仍可读：readScanState 拿到原字段', async () => {
  const legacyPayload = {
    version: 1,
    policyVersion: 1,
    mode: 'bootstrap',
    focusIds: [],
    scanAfterId: 'L20',
    scanCycle: 3,
    allocationSeq: 7,
    schedulerSeq: 11,
  };
  const seed = await seedWith([
    progressRow({
      id: 'cp_legacy_scope',
      scope_key: 'bootstrap',
      kind: 'scope',
      subject_key: 'bootstrap',
      payload_json: JSON.stringify(legacyPayload),
    }),
  ]);

  const rows = readProgressRows(createTableReadPort(seed.db), BRANCH);
  const row = rows.find((item) => item.id === 'cp_legacy_scope');
  assert.ok(row);
  assert.equal(row.payloadOk, true);

  const state = readScanState(row);
  assert.deepEqual(state, { scanAfterId: 'L20', scanCycle: 3, allocationSeq: 7, schedulerSeq: 11 });

  // 旧行没有 payloadKind：不能被当成新契约行
  assert.equal(progressRowPayloadKind(row), null);
  assert.equal(isWorldBuildJobRow(row), false);
  assert.equal(isWorldBuildTargetRow(row), false);
  assert.equal(isWorldFactRow(row), false);
  assert.equal(isLegacyConstructionRow(row), true);
  assert.equal(readWorldBuildJobs(rows).values.length, 0);
});

test('旧工作单元行同样不被误认：unit + 无 payloadKind', async () => {
  const seed = await seedWith([
    progressRow({
      id: 'cp_legacy_unit',
      scope_key: 'bootstrap',
      kind: 'unit',
      subject_key: 'cp_unit_1',
      status: 'pending',
      payload_json: JSON.stringify({ version: 1, targetIds: ['L1'], attemptCount: 1 }),
    }),
  ]);
  const rows = readProgressRows(createTableReadPort(seed.db), BRANCH);
  const unit = rows.find((row) => row.kind === 'unit');
  assert.ok(unit);
  assert.equal(isLegacyConstructionRow(unit), true);

  const legacy = legacyConstructionRows(rows);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].id, 'cp_legacy_unit');
});

test('新旧混存：过滤函数只交出新契约行之外的记录，不丢任何旧数据', async () => {
  const seed = await seedWith([
    progressRow({ id: 'cp_old', scope_key: 'bootstrap', kind: 'target', subject_key: 'L1' }),
    progressRow({
      id: worldBuildTargetRowId('job-1', 'target-1'),
      scope_key: worldBuildScopeKey('job-1'),
      kind: 'target',
      subject_key: worldBuildTargetSubjectKey('target-1'),
      payload_json: JSON.stringify(encodeWorldBuildTargetPayload(target())),
    }),
  ]);
  const rows = readProgressRows(createTableReadPort(seed.db), BRANCH);

  assert.equal(rows.length, 2);
  assert.deepEqual(legacyConstructionRows(rows).map((row) => row.id), ['cp_old']);
});

/* ─────────────────────── 覆盖率不变式 ─────────────────────── */

test('覆盖率：四项之和必须等于 requiredTargets', () => {
  const base = {
    version: 1,
    sourceScanComplete: true,
    scopeSealed: true,
    requiredTargets: 10,
    requiredDone: 6,
    requiredPending: 2,
    requiredFailed: 1,
    requiredBlocked: 1,
    deferredInteriors: 4,
    registeredMaps: 5,
    readyMaps: 2,
    cumulativeTransports: 9,
    completedWithIssues: true,
  };
  assert.equal(checkCoverageInvariant(base), null);

  const broken = { ...base, requiredTargets: 11 };
  assert.match(checkCoverageInvariant(broken), /requiredTargets/);

  const impossibleMaps = { ...base, readyMaps: 6 };
  assert.match(checkCoverageInvariant(impossibleMaps), /readyMaps/);
});

test('覆盖率：扫描未完成或范围未封口时不许报最终完成率', () => {
  const coverage = {
    version: 1,
    sourceScanComplete: false,
    scopeSealed: false,
    requiredTargets: 0,
    requiredDone: 0,
    requiredPending: 0,
    requiredFailed: 0,
    requiredBlocked: 0,
    deferredInteriors: 0,
    registeredMaps: 0,
    readyMaps: 0,
    cumulativeTransports: 0,
    completedWithIssues: false,
  };
  assert.equal(canReportFinalCompletion(coverage), false);
  assert.equal(canReportFinalCompletion({ ...coverage, sourceScanComplete: true }), false);
  assert.equal(canReportFinalCompletion({ ...coverage, sourceScanComplete: true, scopeSealed: true }), true);
  // deferredInteriors 不进必建分母
  assert.equal(checkCoverageInvariant({ ...coverage, deferredInteriors: 99 }), null);
});
