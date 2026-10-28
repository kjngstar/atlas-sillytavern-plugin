/**
 * atlas-world-build-acceptance.test.mjs — P15 §21「必须覆盖」的八组场景验收。
 *
 * §21 列的八组场景，本文件覆盖其中**决策/契约层可直接复现**的六组：
 *   1. 全量新世界初始化（多地区、大小城镇、明确内部、重要 NPC 据点、延后设施）
 *   2. 连续多窗口、单图失败、停止、刷新、下次续建、全局优先
 *   5. NPC 初始位置、可用设施、估计道路旅行（不因现实建图时间推进世界）
 *   6. 日常陈设转真实 item、拆毁/改建、世界书增量和关闭保留
 *   7. 静态与动态全部楼层回退、重生成、分支、在途请求过期
 *   8. 默认预设升级与自定义不修改；工作台反馈、不插聊天
 *
 * 第 3 组（统一玩家地图与主角/NPC 不同知识）与第 4 组（书架/玻璃/门窗开关与动作条件）
 * 需要真实 SQL 世界：由 `atlas-db-knowledge-view.test.mjs`（T22-01/02、正文投影）、
 * `atlas-spatial-*.test.mjs`、`atlas-space-state-patch.test.mjs`（§18.4 十二条）覆盖，
 * 本文件不重复造一遍夹具去掩盖它们。对照表见
 * `docs/world-build-spatial-implementation-20261026.md` §20。
 *
 * 纪律：全程离线、纯函数；不写库、不调模型、不读墙钟。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILD_BLOCKED_CODES,
  buildWorldBuildCoverage,
  countBuildTargets,
  invalidateBuildRun,
  nextJobStatus,
  planWorldBuildMutation,
  selectNextBuildUnits,
  validateBatchCommit,
} from '../src/atlas-world-build-state.ts';
import {
  NPC_PLACEMENT_BATCH_LIMIT,
  characterHasLocationEvidence,
  chooseInitialLocation,
  identityPurposeOf,
  isLegalPlacementLocation,
  planNpcInitialPlacement,
} from '../src/atlas-world-build-plan.ts';
import {
  agreesWithBatchTicket,
  isRunnerTicketLive,
  refreshDisplayState,
  shouldAutoResume,
  shouldStopOnScopeChange,
  stopBuildRun,
} from '../src/atlas-world-build-runner.ts';
import { estimatedArrival, nextNodeBoundary } from '../src/atlas-sim-motion.ts';
import {
  furnishingOriginKey,
  planFurnishingMove,
  promotionAllowedInPhase,
  promotionRestorePlan,
  resolveFurnishingRef,
} from '../src/atlas-furnishing-promotion.ts';
import { summarizeRollbackPlan } from '../src/atlas-rollback-preview.ts';
import {
  BUILTIN_SEGMENT_ORIGIN,
  classifyPreset,
  isBuiltinSegment,
  planBuiltinPresetUpgrade,
} from '../src/atlas-prompt-preset-migrate.ts';
import { buildWorkbenchStatus, sortWorkbenchFailures } from '../src/atlas-workbench-status.ts';

const CTX = { branchId: 'B1', turnId: 'TURN_9', opId: 'op_world_build' };
const POLICY = { totalOperations: 64, maxNewLocations: 12, maxNewRoutes: 16 };

function job(overrides = {}) {
  return {
    version: 1,
    id: 'J1',
    branchId: 'B1',
    kind: 'initialize',
    status: 'running',
    sourceManifestHash: 'manifest_1',
    policyVersion: 'policy_1',
    originFloorId: 'TURN_1',
    runEpoch: 1,
    nextWindowSequence: 1,
    committedWindowSequence: 0,
    cumulativeTransports: 0,
    cumulativeWindows: 0,
    stopReason: null,
    ...overrides,
  };
}

function target(overrides = {}) {
  return {
    version: 1,
    id: 'T1',
    jobId: 'J1',
    subjectId: 'L1',
    workKind: 'entity-construction',
    requirement: 'source-required',
    depth: 0,
    dependencyIds: [],
    inputSignature: 'sig_1',
    status: 'pending',
    attempts: 0,
    failureFingerprint: null,
    lastErrorCode: null,
    originFloorId: 'TURN_1',
    eventId: null,
    ...overrides,
  };
}

const scheduleOf = (overrides = {}) => selectNextBuildUnits({
  job: job(),
  targets: [],
  sourceScanComplete: true,
  policy: POLICY,
  branchId: 'B1',
  currentFloorId: 'TURN_9',
  limit: 1,
  schedulerSeq: 0,
  ...overrides,
});

/** 把某个目标标成完成 / 失败，模拟已 ACK 的窗口结果（不改动输入对象）。 */
const done = (targets, ids) => targets.map((item) => (ids.includes(item.id) ? { ...item, status: 'done', attempts: Math.max(1, item.attempts) } : item));
const failed = (targets, ids) => targets.map((item) => (ids.includes(item.id)
  ? { ...item, status: 'failed', attempts: Math.max(1, item.attempts), lastErrorCode: 'MAP_LAYOUT_FAILED', failureFingerprint: 'fp_map' }
  : item));
const blockedUpstream = (targets, ids) => targets.map((item) => (ids.includes(item.id) ? { ...item, status: 'blocked' } : item));

// ---------------------------------------------------------------------------
// §21-1 全量新世界初始化
// ---------------------------------------------------------------------------

test('§21-1 空世界初始化：扫描 → 方案 → 实体 → 内部 → NPC 据点逐层推进，延后内部不占必建分母', () => {
  // 一个「多地区、大小城镇、明确内部、重要 NPC 据点、延后设施」的初始世界。
  let targets = [
    target({ id: 'T_SCAN', workKind: 'source-scan', subjectId: null, depth: 0 }),
    target({ id: 'T_PLAN', workKind: 'settlement-plan', subjectId: 'R1', depth: 1 }),
    target({ id: 'T_REGION', workKind: 'entity-construction', subjectId: 'R1', depth: 0 }),
    target({ id: 'T_CITY', workKind: 'entity-construction', subjectId: 'L1', depth: 1, dependencyIds: ['T_REGION'] }),
    target({ id: 'T_TOWN', workKind: 'entity-construction', subjectId: 'L2', depth: 2, dependencyIds: ['T_CITY'] }),
    target({ id: 'T_INN', workKind: 'entity-construction', subjectId: 'L3', depth: 3, dependencyIds: ['T_TOWN'] }),
    // 延后设施：等到剧情真的进去再建，现在既不算完成也不算失败。
    target({ id: 'T_FARM', workKind: 'entity-construction', subjectId: 'L4', requirement: 'deferred-interior', depth: 4, dependencyIds: ['T_INN'], status: 'waiting-for-entry' }),
    target({ id: 'T_NPC', workKind: 'npc-initial-placement', subjectId: 'C9', depth: 3, dependencyIds: ['T_INN'] }),
  ];

  const window1 = scheduleOf({ targets, sourceScanComplete: false, limit: 2 });
  assert.deepEqual(window1.selected.map((unit) => unit.workKind), ['source-scan'], '来源没扫完不拿半份世界书去建实体');
  assert.ok(window1.blocked.some((item) => item.targetId === 'T_CITY' && item.code === 'DEPENDENCY_NOT_DONE'), '子空间不抢跑');

  targets = done(targets, ['T_SCAN']);
  const window2 = scheduleOf({ targets, limit: 2 });
  assert.deepEqual(window2.selected.map((unit) => unit.workKind), ['settlement-plan'], '方案先于实体');

  targets = done(targets, ['T_PLAN']);
  const window3 = scheduleOf({ targets });
  assert.deepEqual(window3.selected.flatMap((unit) => unit.targetIds), ['T_REGION']);

  targets = done(targets, ['T_REGION']);
  const window4 = scheduleOf({ targets });
  assert.deepEqual(window4.selected.flatMap((unit) => unit.targetIds), ['T_CITY']);

  targets = done(targets, ['T_CITY']);
  const window5 = scheduleOf({ targets });
  assert.deepEqual(window5.selected.flatMap((unit) => unit.targetIds), ['T_TOWN']);

  targets = done(targets, ['T_TOWN']);
  const window6 = scheduleOf({ targets });
  assert.deepEqual(window6.selected.flatMap((unit) => unit.targetIds), ['T_INN'], '明确内部先于 NPC 据点');

  targets = done(targets, ['T_INN']);
  const window7 = scheduleOf({ targets });
  assert.deepEqual(window7.selected.flatMap((unit) => unit.targetIds), ['T_NPC']);
  assert.ok(window7.blocked.some((item) => item.targetId === 'T_FARM' && item.code === 'WAITING_FOR_ENTRY'));

  targets = done(targets, ['T_NPC']);
  const window8 = scheduleOf({ targets });
  assert.deepEqual(window8.selected, [], '只剩延后内部时没有可开工单元');
  assert.equal(window8.terminal, true);

  // 覆盖账目：延后内部单列，不进必建分母；五桶之和等于分母。
  const counts = countBuildTargets(targets);
  assert.deepEqual(counts, {
    requiredTargets: 7,
    requiredDone: 7,
    requiredPending: 0,
    requiredFailed: 0,
    requiredBlocked: 0,
    deferredInteriors: 1,
    cancelled: 0,
  });

  const plan = planWorldBuildMutation({
    job: job({ cumulativeWindows: 7, cumulativeTransports: 12 }),
    targets,
    coverage: { sourceScanComplete: true },
    settlementPlansExpanded: true,
    maps: { registered: 3, ready: 3 },
    ctx: CTX,
  });
  assert.equal(plan.coverage.scopeSealed, true);
  assert.equal(plan.job.status, 'completed', '延后内部不阻塞收尾');
  assert.equal(plan.job.stopReason, null);
  // 规划阶段绝不推进窗口序号：只有真的 ACK 才推进。
  assert.equal(plan.job.nextWindowSequence, 1);
  assert.equal(plan.job.committedWindowSequence, 0);
  assert.equal(plan.groups[0]?.purpose, 'bookkeeping', '进度表写入走程序组，不伪装成世界业务变化');
});

// ---------------------------------------------------------------------------
// §21-2 连续多窗口、单图失败、停止、刷新、续建、全局优先
// ---------------------------------------------------------------------------

test('§21-2 连续多窗口：单图失败不终局、下游阻塞不重做、只有明确重试才回来', () => {
  // 一条深度链：A → B → C（地图布局）→ D。前两个窗口成功，第三个窗口布局失败。
  let targets = [
    target({ id: 'T_A' }),
    target({ id: 'T_B', depth: 1, dependencyIds: ['T_A'] }),
    target({ id: 'T_C', depth: 2, dependencyIds: ['T_B'] }),
    target({ id: 'T_D', depth: 3, dependencyIds: ['T_C'] }),
  ];

  const w1 = scheduleOf({ targets });
  const first = w1.selected.flatMap((unit) => unit.targetIds);
  assert.deepEqual(first, ['T_A'], '父层没做完，子层不抢跑');
  assert.ok(w1.blocked.some((item) => item.targetId === 'T_B' && item.code === 'DEPENDENCY_NOT_DONE'));
  targets = done(targets, first);

  const w2 = scheduleOf({ targets });
  const second = w2.selected.flatMap((unit) => unit.targetIds);
  assert.deepEqual(second, ['T_B']);
  targets = done(targets, second);

  const w3 = scheduleOf({ targets });
  const third = w3.selected.flatMap((unit) => unit.targetIds);
  assert.deepEqual(third, ['T_C']);
  targets = failed(targets, third);

  // 失败后下游立刻阻塞，并把依赖点出来；不重做、也不假装做完。
  const w4 = scheduleOf({ targets });
  assert.deepEqual(w4.selected, []);
  assert.equal(w4.terminal, false, '下游目标还在账本里（pending），只是这轮开不了工：不能宣布结束');
  const blocked = w4.blocked.find((item) => item.targetId === 'T_D');
  assert.equal(blocked.code, 'DEPENDENCY_FAILED');
  assert.equal(blocked.dependencyId, 'T_C');

  // 状态写入层把下游落成 blocked（调度只给理由，落库才有终态）。
  targets = blockedUpstream(targets, ['T_D']);
  assert.equal(scheduleOf({ targets }).terminal, true);

  const settled = planWorldBuildMutation({
    job: job({ cumulativeWindows: 3, cumulativeTransports: 6 }),
    targets,
    coverage: { sourceScanComplete: true },
    settlementPlansExpanded: true,
    maps: { registered: 2, ready: 1 },
    ctx: CTX,
  });
  assert.equal(settled.job.status, 'completed-with-issues', '有失败项不许报成功');
  assert.match(settled.job.stopReason, /1 个失败/);
  assert.equal(settled.coverage.requiredFailed, 1);
  assert.equal(settled.coverage.requiredBlocked, 1);

  // 普通 initialize 任务不会自动复活失败目标（否则就是无限重试）。
  assert.ok(!scheduleOf({ targets }).selected.some((unit) => unit.targetIds.includes('T_C')));

  // 明确重试：retry-failed 任务才把失败项拉回队列，且标成 retry。
  const retry = scheduleOf({ job: job({ kind: 'retry-failed' }), targets });
  assert.deepEqual(retry.selected.flatMap((unit) => unit.targetIds), ['T_C']);
  assert.equal(retry.selected[0].status, 'retry');
});

test('§21-2 停止/失效/刷新：epoch 抬升、已保存不撤回、累计发送只增不减、刷新零发送', () => {
  const running = job({ status: 'running', cumulativeWindows: 3, cumulativeTransports: 9, committedWindowSequence: 3, nextWindowSequence: 4 });

  const stopped = stopBuildRun(running, '用户停止');
  assert.equal(stopped.job.status, 'paused');
  assert.equal(stopped.job.runEpoch, running.runEpoch + 1, '旧票据靠 epoch 失效，不靠墙钟');
  assert.equal(stopped.withdrewSaved, false, '已经 ACK 的结果不撤回');
  const again = stopBuildRun(stopped.job, '用户停止');
  assert.equal(again.idempotent, true, '重复停止不重复抬 epoch');
  assert.equal(again.job.runEpoch, stopped.job.runEpoch);

  const invalidated = invalidateBuildRun(running, 'regenerate');
  assert.equal(invalidated.status, 'paused');
  assert.equal(invalidated.runEpoch, running.runEpoch + 1);
  assert.equal(invalidated.cumulativeTransports, 9, '已发生的网络发送是历史消耗，回退不能把它退回去');
  assert.equal(nextJobStatus(invalidated, buildWorldBuildCoverage({
    job: invalidated, targets: [], sourceScanComplete: true, settlementPlansExpanded: true, maps: { registered: 1, ready: 1 },
  })), 'paused');

  // 刷新/手动打开只读进度，永远零发送；暂停态必须显式重试才继续。
  const display = refreshDisplayState(running);
  assert.equal(display.autoFetch, false);
  assert.equal(display.waitingForTrigger, true);
  assert.match(display.label, /等待下一次合法世界更新/);
  assert.equal(shouldAutoResume('refresh', running).resume, false);
  assert.equal(shouldAutoResume('manual-open', running).resume, false);
  assert.equal(shouldAutoResume('allowed-map-update', running).resume, true, '合法更新才自动续建');
  assert.equal(shouldAutoResume('allowed-map-update', stopped.job).resume, false, '暂停的任务不自动恢复');
});

test('§21-2 全局优先：初始化进行中，增量工作整轮让路；初始化自己不被别人阻挡', () => {
  const init = job({ id: 'J_INIT', kind: 'initialize', status: 'running' });
  const incremental = job({ id: 'J_INC', kind: 'lore-incremental', status: 'running' });
  const targets = [target({ jobId: 'J_INC', id: 'T_INC' })];

  const yielded = scheduleOf({ job: incremental, targets, otherJobs: [init] });
  assert.deepEqual(yielded.selected, []);
  assert.equal(yielded.blocked.length, 1);
  assert.equal(yielded.blocked[0].code, 'INITIALIZATION_PRIORITY');
  assert.equal(yielded.blocked[0].dependencyId, 'J_INIT');
  assert.ok(BUILD_BLOCKED_CODES.includes(yielded.blocked[0].code), '阻塞码必须在白名单里');

  // 初始化暂停后屏障释放，增量工作才能继续。
  const released = scheduleOf({ job: incremental, targets, otherJobs: [{ ...init, status: 'paused' }] });
  assert.deepEqual(released.selected.flatMap((unit) => unit.targetIds), ['T_INC']);

  // 初始化任务本身不会因为「另一个初始化在跑」而让路。
  const self = scheduleOf({ job: init, targets: [target({ jobId: 'J_INIT' })], otherJobs: [init] });
  assert.equal(self.selected.length, 1);
});

test('§21-2 批次提交守卫：跨楼层、无 ACK、无起因楼层、无 head 一律拒绝', () => {
  const ticket = {
    version: 1, jobId: 'J1', chatUid: 'CHAT', branchId: 'B1', ownerFloorId: 'TURN_9',
    baseRevision: 4, baseStorageRevision: 2, sourceManifestHash: 'manifest_1', runEpoch: 1,
  };
  const ok = validateBatchCommit({ ticket, jobOriginFloorId: 'TURN_1', currentHeadTurnId: 'TURN_9', savedAck: true });
  assert.deepEqual(ok, { ok: true });
  assert.equal(agreesWithBatchTicket(ticket, ticket), true);

  const moved = validateBatchCommit({ ticket, jobOriginFloorId: 'TURN_1', currentHeadTurnId: 'TURN_10', savedAck: true });
  assert.equal(moved.code, 'WORLD_BUILD_CROSS_FLOOR_COMMIT', '不许把本批结果追加到旧楼层末尾');

  const noAck = validateBatchCommit({ ticket, jobOriginFloorId: 'TURN_1', currentHeadTurnId: 'TURN_9', savedAck: false });
  assert.equal(noAck.code, 'WORLD_BUILD_SAVE_NOT_ACKED', 'requested 不等于 saved');

  const noOrigin = validateBatchCommit({ ticket, jobOriginFloorId: '', currentHeadTurnId: 'TURN_9', savedAck: true });
  assert.equal(noOrigin.code, 'WORLD_BUILD_ORIGIN_FLOOR_MISSING');

  const noHead = validateBatchCommit({ ticket, jobOriginFloorId: 'TURN_1', currentHeadTurnId: '', savedAck: true });
  assert.equal(noHead.code, 'WORLD_BUILD_HEAD_MISSING');
});

// ---------------------------------------------------------------------------
// §21-5 NPC 初始位置、可用设施、估计道路旅行
// ---------------------------------------------------------------------------

test('§21-5 NPC 初始位置：身份对应设施优先、无合法落点不编造、已放置/在途/主角不动', () => {
  const locations = [
    { id: 'L_CITY', name: '灰石城', kind: 'city' },
    { id: 'L_SMITHY', name: '铁匠铺', kind: 'building', purpose: 'smithy' },
    { id: 'L_GUARD', name: '卫所', kind: 'building', purpose: 'guard-post' },
    { id: 'L_GRANARY', name: '谷仓', kind: 'building', purpose: 'granary' },
    { id: 'L_HOLLOW', name: '传闻中的塔', kind: 'building', existence_quality: 'hypothetical' },
    { id: 'L_GONE', name: '烧毁的驿站', kind: 'building', status: 'destroyed' },
  ];
  const characters = [
    { id: 'C_PROT', name: '主角', role: 'protagonist' },
    { id: 'C_SMITH', name: '老王', identity: '铁匠铺里的锻工' },
    { id: 'C_GUARD', name: '赵三', identity: '城门的巡逻卫兵' },
    { id: 'C_FARMER', name: '李四', identity: '城外的农夫' },
    { id: 'C_UNKNOWN', name: '一个话不多的年轻人' },
    { id: 'C_DEAD', name: '已故的掌柜', identity: '掌柜', physical_status: 'dead' },
    { id: 'C_HASLOC', name: '已有点位的人', location_id: 'L_GUARD' },
    { id: 'C_PLACED', name: '上次已经安排过的人', identity: '卫兵' },
    { id: 'C_TRANSIT', name: '正在路上的人', identity: '商人' },
  ];

  const result = planNpcInitialPlacement({
    characters,
    locations,
    settlementId: 'L_CITY',
    placed: [{ kind: 'npc-initial-placement', characterId: 'C_PLACED', locationId: 'L_GUARD', basis: 'estimated', reasonCode: 'IDENTITY_FACILITY', decidedAtTurn: 'TURN_1' }],
    openJourneys: [{ mover_entity_id: 'C_TRANSIT', status: 'moving' }],
    turnId: 'TURN_9',
  });

  const byId = new Map(result.placements.map((item) => [item.characterId, item]));
  assert.equal(byId.get('C_SMITH').locationId, 'L_SMITHY');
  assert.equal(byId.get('C_SMITH').reasonCode, 'IDENTITY_FACILITY');
  assert.equal(byId.get('C_GUARD').locationId, 'L_GUARD');
  assert.equal(byId.get('C_FARMER').locationId, 'L_GRANARY');
  assert.equal(byId.get('C_UNKNOWN').locationId, 'L_CITY', '判不出身份就先说「他在这个城里」，不猜房间');
  assert.equal(byId.get('C_UNKNOWN').reasonCode, 'SETTLEMENT_ANCHOR');

  const skipped = new Map(result.skipped.map((item) => [item.characterId, item.reason]));
  assert.equal(skipped.get('C_PROT'), 'PROTAGONIST_NOT_PLACED', '主角位置来自剧情，不在这里安排');
  assert.equal(skipped.get('C_DEAD'), 'INACTIVE_CHARACTER');
  assert.equal(skipped.get('C_HASLOC'), 'HAS_LOCATION');
  assert.equal(skipped.get('C_PLACED'), 'ALREADY_PLACED', '一次性记录存在就不再安排第二遍');
  assert.equal(skipped.get('C_TRANSIT'), 'IN_TRANSIT', '正在路上的人不拉回去重放');

  for (const placement of result.placements) {
    assert.equal(placement.op.op, 'character.upsert');
    assert.equal(placement.op.data.location_ref, placement.locationId);
    assert.equal(placement.record.kind, 'npc-initial-placement', '一次性记录写进建造进度账本');
  }

  // 合法性判定：假设中的、已毁的、不可进入的都不能当落点。
  assert.equal(isLegalPlacementLocation({ id: 'L_HOLLOW', kind: 'building', existence_quality: 'hypothetical' }).reasonCode, 'HYPOTHETICAL');
  assert.equal(isLegalPlacementLocation({ id: 'L_GONE', kind: 'building', status: 'destroyed' }).reasonCode, 'GONE');
  assert.equal(isLegalPlacementLocation({ id: 'L_LOCKED', kind: 'building', canEnter: false }).reasonCode, 'NOT_ENTERABLE');
  assert.equal(isLegalPlacementLocation({ id: 'L_ROOM', kind: 'room' }).legal, true);

  // 没有合法落点：不编造位置，给明确 issue。
  const nowhere = planNpcInitialPlacement({
    characters: [{ id: 'C_LOST', name: '无名者', identity: '铁匠' }],
    locations: [{ id: 'L_HOLLOW', name: '传闻中的塔', kind: 'building', existence_quality: 'hypothetical' }],
  });
  assert.deepEqual(nowhere.placements, []);
  assert.ok(nowhere.issues.some((item) => item.code === 'NPC_PLACEMENT_NO_LOCATION'));

  // 一批有界：超出 limit 的显式记账等下一批，不偷偷扩容。
  const many = Array.from({ length: NPC_PLACEMENT_BATCH_LIMIT + 1 }, (_, index) => ({ id: `C_BULK_${String(index).padStart(2, '0')}`, name: `铁匠${index}`, identity: '铁匠' }));
  const bulk = planNpcInitialPlacement({ characters: many, locations });
  assert.equal(bulk.placements.length, NPC_PLACEMENT_BATCH_LIMIT);
  const deferred = bulk.skipped.filter((item) => item.reason === 'BATCH_LIMIT');
  assert.equal(deferred.length, 1, '只延期一个，不多不少');
  assert.ok(!bulk.placements.some((item) => item.characterId === deferred[0].characterId));
});

test('§21-5 估计道路旅行只认世界时钟：暂停/阻塞不给假到达时间，墙钟不推进世界', () => {
  const journey = {
    status: 'moving',
    segments_json: [{ toLocationId: 'L2', routeId: 'R1', quality: 'confirmed', duration_override: { min_s: 600, nominal_s: 900, max_s: 1200 } }],
    segment_index: 0,
    segment_time_done_s: 0,
    started_at_s: 100,
    last_advanced_at_s: 100,
  };

  const at100 = estimatedArrival(journey, 100);
  assert.equal(at100.minS, 700);
  assert.equal(at100.maxS, 1300);
  assert.equal(at100.quality, 'estimated', '区间不是单点就不报 confirmed');

  // 纯函数：同样的输入给同样的答案，没有任何「当前墙钟」参与。
  assert.deepEqual(estimatedArrival(journey, 100), at100);

  // 只有世界时钟前进，到达时间才前进（现实建图耗时不推进世界）。
  assert.equal(estimatedArrival(journey, 160).minS, 760);

  const blocked = estimatedArrival({ ...journey, status: 'blocked' }, 100);
  assert.deepEqual(blocked, { minS: null, maxS: null, quality: 'unknown' }, '阻塞时给 null，不编一个到达时间');

  const boundary = nextNodeBoundary(journey);
  assert.deepEqual(boundary, { atS: 1000, toLocationId: 'L2', routeId: 'R1' });
  assert.equal(nextNodeBoundary({ ...journey, status: 'arrived' }), null);

  // 位置证据判定：有 location_id 或完整网格坐标才算「有位置」，未知就是没有。
  assert.equal(characterHasLocationEvidence({ location_id: 'L1' }), true);
  assert.equal(characterHasLocationEvidence({ map_id: 'M1', grid_x: 3, grid_y: 4 }), true);
  assert.equal(characterHasLocationEvidence({ map_id: 'M1', grid_x: 3 }), false);
  assert.equal(characterHasLocationEvidence({}), false);
  assert.equal(identityPurposeOf({ identity: 'smith' }), 'smithy');
  assert.equal(identityPurposeOf({ name: '一名旅人' }), null, '判不出职业就不硬塞一个');
});

// ---------------------------------------------------------------------------
// §21-6 陈设转真实 item、后台搬动、退得干净
// ---------------------------------------------------------------------------

test('§21-6 日常陈设转真实 item：originKey 稳定、短引用可解析、歧义与未知一律拒', () => {
  assert.equal(furnishingOriginKey('L1', 'F3'), 'space:L1:furn:F3');
  assert.equal(furnishingOriginKey('L1', 'furn:F3'), 'space:L1:furn:F3', '带前缀与不带前缀是同一个对象');
  assert.equal(furnishingOriginKey('L1', 'space:L1:furn:F3'), 'space:L1:furn:F3', '全限定 ID 幂等');
  assert.equal(furnishingOriginKey('L1', ''), '');

  const canonical = {
    locationId: 'L1',
    revision: 2,
    furnishing: [
      { localId: 'space:L1:furn:F3', itemId: null },
      { localId: 'space:L1:furn:F7', itemId: 'item_7' },
    ],
  };
  assert.equal(resolveFurnishingRef(canonical, 'F3').localId, 'space:L1:furn:F3');
  assert.equal(resolveFurnishingRef(canonical, 'furn:F3').localId, 'space:L1:furn:F3');
  assert.equal(resolveFurnishingRef(canonical, 'F7').furnishing.itemId, 'item_7', '已经提升过的对象复用同一个 item');

  const ambiguous = resolveFurnishingRef({
    locationId: 'L1',
    revision: 1,
    furnishing: [{ localId: 'space:L1:a:furn:F3' }, { localId: 'space:L1:b:furn:F3' }],
  }, 'furn:F3');
  assert.equal(ambiguous.localId, null);
  assert.ok(ambiguous.issues.some((item) => item.code === 'PROMOTION_REF_AMBIGUOUS'), '歧义引用不猜一条最像的');

  const unknown = resolveFurnishingRef(canonical, 'F9');
  assert.equal(unknown.furnishing, null);
  assert.ok(unknown.issues.some((item) => item.code === 'PROMOTION_FURNISHING_UNKNOWN'));

  const empty = resolveFurnishingRef(canonical, '');
  assert.ok(empty.issues.some((item) => item.code === 'PROMOTION_OBJECT_REQUIRED'));

  // 阶段门禁：只有观察与已接受结果两个阶段能提升，打算搬不算搬。
  assert.equal(promotionAllowedInPhase('observe'), true);
  assert.equal(promotionAllowedInPhase('outcome-effect'), true);
  assert.equal(promotionAllowedInPhase('decision'), false);
  assert.equal(promotionAllowedInPhase('planned'), false);
});

test('§21-6 后台搬动：只认已发生已接受的事件，目标必须真实，回退能退干净', () => {
  const base = {
    phase: 'outcome-effect',
    event: { id: 'E1', status: 'occurred', actorId: 'C1', furnishingLocalId: 'F3', accepted: true },
    target: { kind: 'hold', characterId: 'C2' },
    actorExists: (id) => id === 'C1',
    targetLegal: () => true,
  };

  assert.deepEqual(planFurnishingMove(base), { allowed: true, issues: [] });

  assert.equal(planFurnishingMove({ ...base, phase: 'decision' }).allowed, false);
  assert.ok(planFurnishingMove({ ...base, phase: 'decision' }).issues.some((item) => item.code === 'PROMOTION_MOVE_PHASE_NOT_ALLOWED'));

  assert.ok(planFurnishingMove({ ...base, event: null }).issues.some((item) => item.code === 'PROMOTION_MOVE_EVENT_REQUIRED'));
  assert.ok(planFurnishingMove({ ...base, event: { ...base.event, status: 'planned', accepted: false } })
    .issues.some((item) => item.code === 'PROMOTION_MOVE_EVENT_NOT_EFFECTIVE'), '未来意图不得立即执行');
  assert.ok(planFurnishingMove({ ...base, event: { ...base.event, actorId: 'GHOST' } }).issues.some((item) => item.code === 'PROMOTION_MOVE_ACTOR_UNKNOWN'));
  assert.ok(planFurnishingMove({ ...base, event: { ...base.event, furnishingLocalId: '' } }).issues.some((item) => item.code === 'PROMOTION_MOVE_OBJECT_REQUIRED'));
  assert.ok(planFurnishingMove({ ...base, target: null }).issues.some((item) => item.code === 'PROMOTION_MOVE_TARGET_REQUIRED'));
  assert.ok(planFurnishingMove({ ...base, target: { kind: 'hold', characterId: '' } }).issues.some((item) => item.code === 'PROMOTION_MOVE_HOLDER_REQUIRED'));
  assert.ok(planFurnishingMove({ ...base, target: { kind: 'move', locationId: '' } }).issues.some((item) => item.code === 'PROMOTION_MOVE_LOCATION_REQUIRED'));

  // 回退：物品行与地图绑定都在才算「退得干净」；缺一半就是 false，不假装成功。
  const clean = promotionRestorePlan({
    mutations: [
      { table: 'items', rowId: 'item_1', before: null },
      { table: 'maps', rowId: 'M1', before: { frame_json: '{}' } },
    ],
  });
  assert.equal(clean.complete, true);
  const dirty = promotionRestorePlan({
    mutations: [
      { table: 'items', rowId: 'item_1', before: null },
      { table: 'maps', rowId: 'M1', before: null },
    ],
  });
  assert.equal(dirty.complete, false, '地图原来没有绑定就没有可还原的绑定：不冒充退干净');
  assert.equal(promotionRestorePlan(null).complete, false);
});

// ---------------------------------------------------------------------------
// §21-7 楼层回退与在途请求过期
// ---------------------------------------------------------------------------

test('§21-7 回退预览：目标楼自己也算在受影响清单里，作者看行级清单、POV 只给计数', () => {
  const plan = {
    branchId: 'B1',
    targetTurnId: 'T3',
    turns: ['T3', 'T4'],
    steps: [
      { sequence: 1, turnId: 'T4', changeId: 'ch2', targetTable: 'maps', targetRowId: 'M1', operation: 'update', restore: {}, basis: {}, summary: '还原地图' },
      { sequence: 2, turnId: 'T3', changeId: 'ch1', targetTable: 'construction_progress', targetRowId: 'pw1', operation: 'insert', restore: { scope_key: 'world-build:J1' }, basis: {}, summary: '撤掉建设进度' },
    ],
    tableCounts: { maps: 1, construction_progress: 1 },
    clockBeforeS: 500,
    clockTargetS: 100,
    affectedTurns: 2,
    issues: [],
  };
  const turns = [
    { turnId: 'T3', floor: '3', kind: 'build', manual: true, status: 'committed' },
    { turnId: 'T4', floor: '4', kind: 'chat', manual: false, status: 'committed' },
  ];

  const author = summarizeRollbackPlan(plan, { turns, viewMode: 'author' });
  assert.deepEqual(author.affectedTurns.map((item) => item.turnId), ['T3', 'T4'], '回退目标楼本身也在受影响清单里');
  assert.equal(author.affectedTurnCount, 2);
  assert.equal(author.manualTurnCount, 1, '手动动作楼要单独数出来');
  assert.equal(author.targetFloor, '3');
  assert.deepEqual(author.affectedMaps, ['M1']);
  assert.deepEqual(author.affectedProgressScopes, ['world-build:J1']);
  assert.equal(author.clockTargetS, 100, '时钟回到目标楼之前');
  assert.equal(author.withheld, false);

  const pov = summarizeRollbackPlan(plan, { turns, viewMode: 'pov' });
  assert.equal(pov.withheld, true);
  assert.deepEqual(pov.affectedTurns, []);
  assert.deepEqual(pov.affectedMaps, [], 'POV 下不给行级清单');
  assert.equal(pov.affectedTurnCount, 2, '计数仍然如实');
  assert.equal(pov.steps, 2);
});

test('§21-7 在途请求过期：八种失效原因顺序固定，回退抬 epoch 后旧票据立即失效', () => {
  const ticket = {
    version: 1, jobId: 'J1', chatUid: 'CHAT_A', branchId: 'B1', ownerFloorId: 'TURN_9',
    baseRevision: 3, baseStorageRevision: 5, sourceManifestHash: 'manifest_1', runEpoch: 7, windowSequence: 2,
  };
  const current = { jobId: 'J1', chatUid: 'CHAT_A', branchId: 'B1', ownerFloorId: 'TURN_9', baseRevision: 3, baseStorageRevision: 5, sourceManifestHash: 'manifest_1', runEpoch: 7 };

  assert.deepEqual(isRunnerTicketLive(ticket, current), { live: true, reason: null });

  const cases = [
    [{ jobId: 'J2' }, 'job-mismatch'],
    [{ chatUid: 'CHAT_B' }, 'chat-switched'],
    [{ branchId: 'B2' }, 'branch-switched'],
    [{ ownerFloorId: 'TURN_10' }, 'owner-floor-moved'],
    [{ baseRevision: 4 }, 'revision-moved'],
    [{ baseStorageRevision: 6 }, 'storage-revision-moved'],
    [{ sourceManifestHash: 'manifest_2' }, 'source-manifest-changed'],
    [{ runEpoch: 8 }, 'epoch-stale'],
  ];
  for (const [patch, reason] of cases) {
    assert.deepEqual(isRunnerTicketLive(ticket, { ...current, ...patch }), { live: false, reason }, `${reason} 必须可复现`);
  }

  // 回退/重生成抬 epoch → 在途票据立刻变成 epoch-stale（与 §21-2 的停止共用同一条失效轴）。
  const rolledBack = invalidateBuildRun(job({ runEpoch: 7 }), 'rollback');
  assert.equal(isRunnerTicketLive(ticket, { ...current, runEpoch: rolledBack.runEpoch }).reason, 'epoch-stale');

  assert.equal(shouldStopOnScopeChange(ticket, { chatUid: 'CHAT_A', branchId: 'B2' }), true);
  assert.equal(shouldStopOnScopeChange(ticket, { chatUid: 'CHAT_A', branchId: 'B1' }), false);
});

// ---------------------------------------------------------------------------
// §21-8 预设升级与工作台反馈
// ---------------------------------------------------------------------------

test('§21-8 默认预设升级：内置段升级、作者段原样、自定义一律不动、下架段保留并报告', () => {
  const catalog = [{ builtinId: 'seg-protocol', version: '2', name: '协议', role: 'system', content: '新版协议' }];
  const builtin = { id: 's1', origin: BUILTIN_SEGMENT_ORIGIN, builtinId: 'seg-protocol', builtinVersion: '1', name: '协议', role: 'system', content: '旧版协议', enabled: true };
  const author = { id: 's2', name: '我的补充', role: 'user', content: '作者自己写的', enabled: false };

  const mixed = planBuiltinPresetUpgrade({ segments: [builtin, author], catalog });
  assert.equal(mixed.presetClass, 'mixed');
  assert.equal(mixed.changed, true);
  assert.deepEqual(mixed.upgradedSegmentIds, ['seg-protocol']);
  assert.equal(mixed.segments[0].content, '新版协议');
  assert.equal(mixed.segments[0].builtinVersion, '2');
  assert.equal(mixed.segments[0].enabled, true, '作者的启用状态不被覆盖');
  assert.deepEqual(mixed.segments[1], author, '作者段原样保留');

  const pureBuiltin = planBuiltinPresetUpgrade({ segments: [builtin], catalog });
  assert.equal(pureBuiltin.presetClass, 'builtin');

  const custom = planBuiltinPresetUpgrade({ segments: [author], catalog });
  assert.equal(custom.presetClass, 'custom');
  assert.equal(custom.changed, false);
  assert.deepEqual(custom.segments, [author], '自定义预设一个字节都不改');
  assert.equal(planBuiltinPresetUpgrade({ segments: [], catalog }).presetClass, 'custom');

  // 内置段已从目录下架：保留原文，只报告，不删段、不清空。
  const removed = planBuiltinPresetUpgrade({ segments: [{ ...builtin, builtinId: 'seg-gone' }], catalog });
  assert.deepEqual(removed.unknownBuiltinIds, ['seg-gone']);
  assert.equal(removed.changed, false);
  assert.equal(removed.segments[0].content, '旧版协议');
  assert.ok(removed.issues.some((item) => item.code === 'PRESET_BUILTIN_SEGMENT_UNKNOWN'));

  // 三件齐全才算内置：绝不按名字判断。
  assert.equal(isBuiltinSegment(builtin), true);
  assert.equal(isBuiltinSegment({ ...builtin, builtinVersion: '' }), false);
  assert.equal(isBuiltinSegment({ ...builtin, origin: 'user' }), false);
  assert.equal(isBuiltinSegment({ id: 'x', name: '协议', role: 'system', content: '旧版协议' }), false, '同名同内容但没标记的不算内置');
  assert.equal(classifyPreset(null), 'custom');
});

test('§21-8 工作台反馈不插聊天：唯一快照恒为只读、五桶不重叠、读不到的计数是 null 不是 0', () => {
  const targets = [
    target({ id: 'T1', status: 'done' }),
    target({ id: 'T2', status: 'done', requirement: 'inferred-shell' }),
    target({ id: 'T3', status: 'done' }),
    target({ id: 'T4', status: 'failed', lastErrorCode: 'MAP_LAYOUT_FAILED' }),
    target({ id: 'T5', status: 'blocked' }),
    target({ id: 'T6', status: 'waiting-for-entry', requirement: 'deferred-interior' }),
  ];
  const status = buildWorkbenchStatus({
    job: job({ status: 'completed-with-issues', stopReason: '存在 1 个失败 / 1 个阻塞目标', committedWindowSequence: 3, nextWindowSequence: 4, cumulativeWindows: 3, cumulativeTransports: 8 }),
    targets,
    maps: { registered: 4, laidOut: 2 },
    sourceScanComplete: true,
    settlementPlansExpanded: true,
    legacyRowCount: 2,
  });

  assert.equal(status.chatInjection, false, '进度/失败只进工作台与诊断，不插聊天');
  assert.deepEqual(status.manualOverrides, [], '不新增人工纠正入口');
  assert.equal(status.job.autoFetch, false, '工作台展示层不许触发请求');
  assert.equal(status.job.waitingForTrigger, true);
  assert.equal(status.phase, 'finished');

  assert.deepEqual(status.totals.required, { total: 5, done: 3, pending: 0, failed: 1, blocked: 1 }, '五桶互不重叠');
  assert.equal(status.totals.deferredInteriors, 1, '延后内部单列，不算失败也不算完成');
  assert.deepEqual(status.totals.byRequirement, { 'source-required': 4, 'inferred-shell': 1, 'deferred-interior': 1 });
  assert.equal(status.totals.required.total, countBuildTargets(targets).requiredTargets);

  assert.deepEqual(status.mapLayouts, { registered: 4, laidOut: 2 });
  assert.deepEqual(status.windows, { current: null, committed: 3, cumulative: 3, cumulativeTransports: 8, extraReasons: null, ledgerAvailable: false });
  const running=buildWorkbenchStatus({job:job({status:'running',committedWindowSequence:3,nextWindowSequence:4}),targets,windowActive:true});
  assert.equal(running.windows.current,4,'真实在途窗口使用未提交的序号，不重复上一已提交窗口');

  assert.equal(status.actions.canStop, false, '已完成的任务没有「停止本次运行」的意义');
  assert.equal(status.actions.canRetryFailed, true);
  assert.match(status.actions.retryScope, /失败/);
  assert.deepEqual(status.actions.failedTargets.map((item) => item.targetRef), ['T4']);
  assert.deepEqual(status.actions.blockedTargets.map((item) => item.targetRef), ['T5'], '阻塞不是失败');
  assert.equal(status.legacyRows, 2);

  // 读不到真实地图计数时是 null，不写 0 冒充「一张图都没有」。
  const unknownMaps = buildWorkbenchStatus({ job: null, targets: [] });
  assert.deepEqual(unknownMaps.mapLayouts, { registered: null, laidOut: null });
  assert.equal(unknownMaps.phase, 'idle');
  assert.equal(unknownMaps.job, null);

  // 失败项排序稳定：先按工作类型，再按目标 ID。
  const ordered = sortWorkbenchFailures([
    { targetRef: 'T9', workKind: 'entity-construction', status: 'failed' },
    { targetRef: 'T2', workKind: 'map-layout', status: 'failed' },
    { targetRef: 'T1', workKind: 'entity-construction', status: 'blocked' },
  ]);
  assert.deepEqual(ordered.map((item) => item.targetRef), ['T1', 'T9', 'T2']);
});
