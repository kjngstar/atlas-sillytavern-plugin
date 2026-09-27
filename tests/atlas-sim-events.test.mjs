/**
 * atlas-sim-events.test.mjs — T19 事件、后台行动与结果（§4.3 / §5.1 / §7.6 / §9.1 / §16.5 / §16.7）。
 *
 * 覆盖：
 * - 后台准备：planned → active → completed 需要真实经过时间，Δt=0 不完成耗时步骤；
 * - 典礼触发：wait 行动在 event_status 条件成立前保持等待并给出 next_check_s，成立后才完成；
 *   （典礼时间未知时 next_check_s 为空——§4.3「未知触发时间为空」，绝不编一个具体时刻）
 * - simulated 事件必须绑定真实到期行动，未绑定明确拒绝（SIMULATED_EVENT_UNBOUND）；
 * - 事件 Δ 效果原子性：死亡写入与行动结果在同一原子组，不能事件成功但死亡写入失败；
 * - 角色死亡停止不适用的行动/行程，并保留最后已知位置（不伪造地点）；
 * - 没有本轮正文 quote 仍可有效推演：decision/outcome 阶段不产生 QUOTE_REQUIRED / QUOTE_NOT_FOUND；
 * - 未来事件不能当已发生；只给 title 的事件仍是 scheduled。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, insertRows, selectOne } from './fixtures/atlas-sql/seed.mjs';
import { advanceActions, haltActorWork } from '../src/atlas-sim-actions.ts';
import { compileEventPropose } from '../src/atlas-ops-events.ts';
import { compileOperations } from '../src/atlas-ops-compile.ts';
import { createTableReadPort } from '../src/atlas-db-readport.ts';
import { buildAtomicGroups, orderGroups } from '../src/atlas-ops-groups.ts';
import { makeCompileContext } from './helpers/atlas-compile-context.mjs';

const SQL = await (await import('sql.js')).default();

const BRANCH = IDS.branchMain;
const QUOTE_CODES = new Set(['QUOTE_REQUIRED', 'QUOTE_NOT_FOUND']);

const makeId = (kind, opId, alias) => `${kind}_${opId}_${alias}`;

function parsedOp(opId, value) {
  return { opId, line: 1, rawHash: `hash_${opId}`, value };
}

/** 用真实 advanceActions 的返回值写回 actions 表（模拟事务层持久化）。 */
function persistActions(db, rows) {
  for (const row of rows) {
    const columns = Object.keys(row).filter((column) => column !== 'branch_id' && column !== 'id');
    const params = columns.map((column) => {
      const value = row[column];
      if (value === null || value === undefined) return null;
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (typeof value === 'object') return JSON.stringify(value);
      return value;
    });
    db.run(
      `UPDATE actions SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE branch_id = ? AND id = ?`,
      [...params, row.branch_id, row.id],
    );
  }
}

/**
 * 真实提交顺序：结果事件先落地，行动行再指回它
 * （`actions.result_event_id` 是指向 events 的外键，同一原子组内先事件后行动）。
 */
function persistAdvance(db, result) {
  if (result.events.length > 0) insertRows(db, 'events', result.events);
  persistActions(db, result.actions);
}

function actionRow(id, overrides = {}) {
  return {
    branch_id: BRANCH,
    id,
    row_rev: 1,
    created_turn_id: IDS.seedTurn,
    updated_turn_id: IDS.seedTurn,
    actor_entity_id: IDS.C1,
    parent_action_id: null,
    kind: 'prepare',
    title: '准备',
    intent: '',
    target_entity_id: null,
    target_location_id: null,
    target_event_id: null,
    trigger_json: null,
    depends_on_json: '[]',
    payload_json: null,
    duration_json: null,
    progress_s: 0,
    earliest_start_s: null,
    deadline_s: null,
    next_check_s: null,
    started_at_s: null,
    finished_at_s: null,
    evaluated_until_s: 0,
    secrecy: 'restricted',
    priority: 'normal',
    status: 'planned',
    reason_code: null,
    result_event_id: null,
    ...overrides,
  };
}

function eventRow(id, overrides = {}) {
  return {
    branch_id: BRANCH,
    id,
    row_rev: 1,
    created_turn_id: IDS.seedTurn,
    updated_turn_id: IDS.seedTurn,
    title: '国王典礼',
    kind: 'ceremony',
    summary: '预定典礼',
    location_id: IDS.L1,
    route_id: null,
    route_progress_m: null,
    subject_entity_id: IDS.C4,
    participants_json: '[]',
    cause_action_id: null,
    parent_event_id: null,
    scheduled_start_s: null,
    trigger_json: null,
    occurred_at_s: null,
    ended_at_s: null,
    outcome: '',
    secrecy: 'public',
    status: 'scheduled',
    ...overrides,
  };
}

/** 编译上下文：真实 scope + table read port + 确定性 makeId。 */
function ctxFor(seed, { phase = 'outcome', clockS = 0, extraRefs = [] } = {}) {
  return makeCompileContext({
    seed,
    phase,
    clockS,
    refs: [...seed.refs, ...extraRefs],
  });
}

function eventMutation(result) {
  const mutation = result.mutations.find((m) => m.table === 'events');
  assert.ok(mutation, `应产生 events 行：${JSON.stringify(result.issues)}`);
  return mutation.after;
}

/* —— T19-01 后台准备 —— */

test('T19-01 后台准备：planned → active → completed 需要真实经过时间，Δt=0 不完成耗时步骤', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    insertRows(seed.db, 'actions', [
      actionRow('A_PREP', {
        actor_entity_id: IDS.C1,
        kind: 'prepare',
        title: '准备仪式',
        duration_json: JSON.stringify({ min_s: 900, nominal_s: 1800, max_s: 3600, quality: 'estimated', basis_refs: [] }),
      }),
    ]);
    const world = { db: seed.db, branchId: BRANCH, makeId, turnId: IDS.seedTurn };

    // Δt = 0：进入执行但一步都不推进，也不完成。
    const zero = advanceActions({ fromS: 0, untilS: 0 }, world);
    const step0 = zero.actions.find((a) => a.id === 'A_PREP');
    assert.equal(step0.status, 'active', '条件满足即进入执行');
    assert.equal(step0.progress_s, 0, 'Δt=0 不完成任何耗时步骤');
    assert.equal(step0.finished_at_s, null);
    assert.equal(step0.started_at_s, 0);
    assert.equal(zero.events.length, 0, '没有经过时间就不产生完成事件');
    persistAdvance(seed.db, zero);

    // 900 秒：累计一半，仍未完成。
    const half = advanceActions({ fromS: 0, untilS: 900 }, world);
    const step900 = half.actions.find((a) => a.id === 'A_PREP');
    assert.equal(step900.progress_s, 900);
    assert.equal(step900.status, 'active');
    assert.equal(step900.finished_at_s, null);
    persistAdvance(seed.db, half);

    // 再 900 秒：真正到 1800 秒才完成，完成时刻是真实经过时间。
    const done = advanceActions({ fromS: 900, untilS: 1800 }, world);
    const step1800 = done.actions.find((a) => a.id === 'A_PREP');
    assert.equal(step1800.status, 'completed');
    assert.equal(step1800.progress_s, 1800);
    assert.equal(step1800.finished_at_s, 1800);
    assert.equal(step1800.next_check_s, null, '已完成离开调度索引');
    assert.equal(done.events.length, 1);
    assert.equal(step1800.result_event_id, done.events[0].id);
    assert.equal(done.events[0].status, 'occurred');
    assert.equal(done.events[0].occurred_at_s, 1800);
    assert.equal(done.events[0].cause_action_id, 'A_PREP', '完成事件绑定产生它的行动');
    persistAdvance(seed.db, done);

    const stored = selectOne(seed.db, 'actions', BRANCH, 'A_PREP');
    assert.equal(stored.status, 'completed');
    assert.equal(Number(stored.finished_at_s), 1800);
    assert.equal(Number(stored.evaluated_until_s), 1800, '时间不会被下一次窗口重复计入');
  } finally {
    seed.close();
  }
});

/* —— T19-02 典礼触发 —— */

test('T19-02 典礼触发：wait 保持等待并给出 next_check_s，条件成立后才完成', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    insertRows(seed.db, 'events', [eventRow('EV1')]);
    insertRows(seed.db, 'actions', [
      actionRow('A_WAIT', {
        actor_entity_id: IDS.C4,
        kind: 'wait',
        title: '等典礼开始',
        target_location_id: IDS.L1,
        target_event_id: 'EV1',
        status: 'active',
        started_at_s: 0,
        // 可调度的等待条件：典礼已开始（event_status）且不早于 3000 秒。
        payload_json: JSON.stringify({
          until: {
            all: [
              { event_status: { event_ref: 'EV1', status: 'occurred' } },
              { time_at_or_after: { s: 3000 } },
            ],
          },
        }),
      }),
    ]);
    const world = { db: seed.db, branchId: BRANCH, makeId, turnId: IDS.seedTurn };

    const waiting = advanceActions({ fromS: 1800, untilS: 2400 }, world);
    const beforeEvent = waiting.actions.find((a) => a.id === 'A_WAIT');
    assert.equal(beforeEvent.status, 'active', '典礼还没开始，行动保持等待');
    assert.equal(beforeEvent.reason_code, 'WAIT_PENDING');
    assert.equal(beforeEvent.next_check_s, 3000, '等待中的行动必须给出下次检查时刻');
    assert.equal(beforeEvent.finished_at_s, null);
    assert.equal(waiting.events.length, 0);
    persistAdvance(seed.db, waiting);

    // 典礼真正开始（真实 event 行更新）后，wait 才完成。
    seed.db.run(`UPDATE events SET status = 'occurred', occurred_at_s = 2700 WHERE branch_id = ? AND id = 'EV1'`, [BRANCH]);
    const after = advanceActions({ fromS: 2400, untilS: 3600 }, world);
    const completed = after.actions.find((a) => a.id === 'A_WAIT');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.reason_code, null);
    assert.equal(completed.finished_at_s, 3000, '完成时刻取条件成立时刻（不早于允许的下界）');
    assert.equal(completed.next_check_s, null);
    persistAdvance(seed.db, after);
  } finally {
    seed.close();
  }
});

test('T19-02b 典礼时间未知：wait 保持等待但不编造具体时刻（next_check_s 为空）', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    insertRows(seed.db, 'events', [eventRow('EV1')]);
    insertRows(seed.db, 'actions', [
      actionRow('A_WAIT_UNKNOWN', {
        actor_entity_id: IDS.C4,
        kind: 'wait',
        title: '等典礼开始',
        target_location_id: IDS.L1,
        target_event_id: 'EV1',
        status: 'active',
        started_at_s: 0,
        payload_json: JSON.stringify({ until: { event_status: { event_ref: 'EV1', status: 'occurred' } } }),
      }),
    ]);
    const world = { db: seed.db, branchId: BRANCH, makeId, turnId: IDS.seedTurn };
    const waiting = advanceActions({ fromS: 0, untilS: 600 }, world);
    const row = waiting.actions.find((a) => a.id === 'A_WAIT_UNKNOWN');
    assert.equal(row.status, 'active');
    assert.equal(row.reason_code, 'WAIT_PENDING');
    assert.equal(row.next_check_s, null, '§4.3：未知触发时间为空，不为典礼编一个明天 8 点');
    persistAdvance(seed.db, waiting);

    seed.db.run(`UPDATE events SET status = 'occurred', occurred_at_s = 900 WHERE branch_id = ? AND id = 'EV1'`, [BRANCH]);
    const after = advanceActions({ fromS: 600, untilS: 1200 }, world);
    const done = after.actions.find((a) => a.id === 'A_WAIT_UNKNOWN');
    assert.equal(done.status, 'completed');
    assert.equal(done.finished_at_s, 900, '条件成立的实际时刻就是完成时刻');
  } finally {
    seed.close();
  }
});

/* —— T19-03 simulated 必须绑定真实到期行动 —— */

test('T19-03 simulated 事件必须绑定真实到期行动；未绑定时明确拒绝 SIMULATED_EVENT_UNBOUND', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    insertRows(seed.db, 'actions', [
      actionRow('A1', { actor_entity_id: IDS.C3, kind: 'act', title: '行刺', status: 'active', started_at_s: 0 }),
    ]);
    const ctx = ctxFor(seed, { clockS: 600, extraRefs: [{ alias: 'A1', id: 'A1', kind: 'action' }] });

    const unbound = compileEventPropose(
      parsedOp('op_unbound', { op: 'event.propose', data: { title: '国王遇刺', phase: 'simulated' } }),
      ctx,
    );
    const codes = unbound.issues.map((i) => i.code);
    assert.ok(codes.includes('SIMULATED_EVENT_UNBOUND'), `必须明确拒绝未绑定的推演结果：${JSON.stringify(codes)}`);
    assert.equal(unbound.mutations.length, 0, '拒绝时不产生任何行');

    const bound = compileEventPropose(
      parsedOp('op_bound', {
        op: 'event.propose',
        data: { title: '国王遇刺', phase: 'simulated', action_ref: 'A1', location_ref: 'L1', subject_ref: 'C4', result: '刺客得手' },
      }),
      ctx,
    );
    assert.deepEqual(
      bound.issues.filter((i) => i.severity === 'error'),
      [],
      `绑定真实行动后必须编译成功：${JSON.stringify(bound.issues)}`,
    );
    const row = eventMutation(bound);
    assert.equal(row.status, 'occurred');
    assert.equal(row.occurred_at_s, 600);
    assert.equal(row.cause_action_id, 'A1', '模拟结果绑定真实到期行动');
  } finally {
    seed.close();
  }
});

/* —— T19-04 Δ 效果原子性 —— */

test('T19-04 事件效果原子性：死亡写入与行动结果必须在同一原子组', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    insertRows(seed.db, 'actions', [
      actionRow('A1', { actor_entity_id: IDS.C3, kind: 'act', title: '行刺', status: 'active', started_at_s: 0 }),
    ]);
    const ctx = ctxFor(seed, { clockS: 900, extraRefs: [{ alias: 'A1', id: 'A1', kind: 'action' }] });
    const compiled = compileEventPropose(
      parsedOp('op_delta', {
        op: 'event.propose',
        data: {
          title: '国王遇刺',
          phase: 'simulated',
          action_ref: 'A1',
          location_ref: 'L1',
          subject_ref: 'C4',
          result: '国王当场死亡',
          effects: [
            { type: 'character_status', target_ref: 'C4', value: 'dead' },
            { type: 'action_result', action_ref: 'A1', value: 'completed' },
          ],
        },
      }),
      ctx,
    );
    assert.deepEqual(compiled.issues.filter((i) => i.severity === 'error'), [], JSON.stringify(compiled.issues));

    const built = buildAtomicGroups([
      {
        opId: 'op_delta',
        issues: compiled.issues,
        mutations: compiled.mutations,
        readSet: compiled.readSet,
        dependencies: compiled.dependencies,
      },
    ]);
    assert.equal(built.groups.length, 1, '一次 event.propose 及其 effects 只能是一个原子组');
    const group = built.groups[0];
    const tables = new Set(group.mutations.map((m) => m.table));
    assert.ok(tables.has('characters'), `死亡写入必须与事件同组：${JSON.stringify([...tables])}`);
    assert.ok(tables.has('actions'), `行动结果必须与事件同组：${JSON.stringify([...tables])}`);
    assert.ok(tables.has('events'));
    const characterMutation = group.mutations.find((m) => m.table === 'characters');
    assert.equal(characterMutation.after.physical_status, 'dead');
    const actionMutation = group.mutations.find((m) => m.table === 'actions');
    assert.equal(actionMutation.after.status, 'completed');
    assert.equal(actionMutation.after.result_event_id, eventMutation(compiled).id, '行动结果指回同一个事件');

    const ordered = orderGroups(built.groups);
    assert.equal(ordered.order.length, 1);
    assert.equal(ordered.order[0].id, group.id);
    assert.deepEqual(ordered.issues, [], '原子组内部没有跨组依赖，不会出现「事件成功但死亡写入失败」');
    // 死亡同时登记停止其未结束工作的副作用（由事务层执行 haltActorWork）。
    assert.deepEqual(
      compiled.effects.filter((e) => e.kind === 'halt_actor_work').map((e) => [e.entityId, e.reasonCode]),
      [[IDS.C4, 'ACTOR_DEAD']],
    );
  } finally {
    seed.close();
  }
});

/* —— T19-05 死亡停止不适用的行动，保留最后已知位置 —— */

test('T19-05 角色死亡停止未结束行程与行动，并保留最后已知位置（不伪造地点）', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    insertRows(seed.db, 'actions', [
      actionRow('A_ACTIVE', { actor_entity_id: IDS.C2, kind: 'travel', title: '去学校', status: 'active', started_at_s: 0, progress_s: 10, target_location_id: IDS.L2 }),
      actionRow('A_READY', { actor_entity_id: IDS.C2, kind: 'prepare', title: '整理行装', status: 'ready' }),
      actionRow('A_DONE', { actor_entity_id: IDS.C2, kind: 'prepare', title: '已完成的事', status: 'completed', finished_at_s: 30 }),
    ]);
    insertRows(seed.db, 'journeys', [
      {
        branch_id: BRANCH,
        id: 'J1',
        row_rev: 1,
        created_turn_id: IDS.seedTurn,
        updated_turn_id: IDS.seedTurn,
        action_id: 'A_ACTIVE',
        mover_entity_id: IDS.C2,
        origin_location_id: IDS.L1,
        destination_location_id: IDS.L2,
        segments_json: '[]',
        segment_index: 0,
        segment_distance_done_m: 100,
        segment_time_done_s: 60,
        last_reached_location_id: IDS.L1,
        stop_location_id: null,
        started_at_s: 0,
        last_advanced_at_s: 60,
        estimated_arrival_min_s: null,
        estimated_arrival_max_s: null,
        arrived_at_s: null,
        position_quality: 'route_estimated',
        status: 'moving',
        stop_reason: null,
      },
    ]);

    const before = selectOne(seed.db, 'characters', BRANCH, IDS.C2);
    const halted = haltActorWork(seed.db, BRANCH, IDS.C2, 120, 'ACTOR_DEAD');
    assert.equal(halted.actions, 2, '只停止未结束的行动');
    assert.equal(halted.journeys, 1);

    const active = selectOne(seed.db, 'actions', BRANCH, 'A_ACTIVE');
    const ready = selectOne(seed.db, 'actions', BRANCH, 'A_READY');
    const done = selectOne(seed.db, 'actions', BRANCH, 'A_DONE');
    assert.equal(active.status, 'cancelled');
    assert.equal(ready.status, 'cancelled');
    assert.equal(active.reason_code, 'ACTOR_DEAD');
    assert.equal(Number(active.finished_at_s), 120);
    assert.equal(done.status, 'completed', '已经结束的行动不受影响');

    const journey = selectOne(seed.db, 'journeys', BRANCH, 'J1');
    assert.equal(journey.status, 'cancelled', '死人不能继续自行走路');
    assert.equal(journey.stop_reason, 'ACTOR_DEAD');
    assert.equal(journey.stop_location_id, null, '不伪造停靠节点');
    assert.equal(journey.arrived_at_s, null, '不假装已经抵达');

    // 最后已知位置逐字保留（有可靠坐标才写回，没有就不写）。
    const after = selectOne(seed.db, 'characters', BRANCH, IDS.C2);
    for (const field of ['location_id', 'map_id', 'grid_x', 'grid_y', 'coord_precision', 'physical_status']) {
      assert.equal(after[field], before[field], `死亡不改变 ${field}`);
    }
    assert.equal(after.map_id, IDS.M1, '有可靠坐标时保留最后位置');
  } finally {
    seed.close();
  }
});

/* —— T19-06 没有本轮正文 quote 仍可有效推演 —— */

test('T19-06 没有本轮正文 quote 仍可有效推演：decision/outcome 编译不产生 QUOTE_REQUIRED / QUOTE_NOT_FOUND', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    insertRows(seed.db, 'actions', [
      actionRow('A1', { actor_entity_id: IDS.C3, kind: 'act', title: '行刺', status: 'active', started_at_s: 0 }),
    ]);
    const tables = createTableReadPort(seed.db);
    const anchor = {
      chatUid: IDS.chatA,
      branchId: BRANCH,
      parentTurnId: IDS.seedTurn,
      hostMessageUid: 'msg_decision',
      variantKey: 'v1',
      baseRevision: 0,
      baseStorageRevision: 0,
      inputHash: 'hash_decision',
    };
    const knownRefs = [...seed.refs, { alias: 'A1', id: 'A1', kind: 'action' }].map((ref) => ({
      alias: ref.alias,
      id: ref.id,
      kind: ref.kind,
      rowRev: 1,
    }));

    // decision：后台刺客的计划（正文里当然没有关于它的引文）。
    const decision = compileOperations({
      operations: [
        parsedOp('op_plan', {
          op: 'plan.propose',
          data: {
            actor_ref: 'C3',
            goal: '潜入王宫行刺',
            steps: [{ kind: 'prepare', method: '备好毒药', duration_hint: { min_s: 600, nominal_s: 1800, max_s: 3600 } }],
          },
        }),
      ],
      anchor,
      phase: 'decision',
      clockS: 600,
      revision: 0,
      tables,
      sources: { phase: 'decision', snapshot: [], clockS: 600 },
      knownRefs,
    });

    // outcome：后台行动到期后的结果事件。
    const outcome = compileOperations({
      operations: [
        parsedOp('op_event', {
          op: 'event.propose',
          data: { title: '国王遇刺', phase: 'simulated', action_ref: 'A1', location_ref: 'L1', subject_ref: 'C4', result: '刺客得手' },
        }),
      ],
      anchor,
      phase: 'outcome',
      clockS: 900,
      revision: 0,
      tables,
      sources: { phase: 'outcome', snapshot: [], clockS: 900 },
      knownRefs,
    });

    const allIssues = [...decision.issues, ...outcome.issues];
    assert.deepEqual(
      allIssues.filter((issue) => QUOTE_CODES.has(issue.code)),
      [],
      `没有本轮正文 quote 不能产生引文类错误：${JSON.stringify(allIssues.map((i) => i.code))}`,
    );
    // 「有效推演」：确实编译出了变更，而不是被静默丢弃。
    assert.ok(decision.merged.mutations.length > 0, '后台计划必须真的编译出行动行');
    assert.ok(decision.merged.mutations.some((m) => m.table === 'actions' && m.after.kind === 'goal'));
    assert.ok(decision.merged.mutations.some((m) => m.table === 'actions' && m.after.kind === 'prepare'));
    assert.ok(outcome.merged.mutations.some((m) => m.table === 'events' && m.after.cause_action_id === 'A1'));
    // 依据只能落在后台因果上，不能伪造引文。
    assert.equal(decision.merged.mutations[0].basis.kind, 'simulation');
  } finally {
    seed.close();
  }
});

/* —— T19-07 / T19-08 未来事件 —— */

test('T19-07 未来事件不能当已发生：scheduled 的 occurred_at_s 为空，改已发生需要显式 observed/simulated', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    insertRows(seed.db, 'actions', [
      actionRow('A1', { actor_entity_id: IDS.C3, kind: 'act', title: '行刺', status: 'active', started_at_s: 0 }),
    ]);
    const ctx = ctxFor(seed, { clockS: 7200, extraRefs: [{ alias: 'A1', id: 'A1', kind: 'action' }] });

    const future = eventMutation(
      compileEventPropose(
        parsedOp('op_sched', {
          op: 'event.propose',
          data: { title: '明天的城门典礼', phase: 'scheduled', time_hint: { at_s: 86400 }, location_ref: 'L1', subject_ref: 'C4' },
        }),
        ctx,
      ),
    );
    assert.equal(future.status, 'scheduled');
    assert.equal(future.occurred_at_s, null, '预定事件不能带发生时刻');
    assert.equal(Number(future.scheduled_start_s), 86400);
    assert.equal(future.outcome, '', '还没发生就没有结果');

    // 显式 observed：正文里看到典礼已经开始 → 才算已发生。
    const observed = eventMutation(
      compileEventPropose(
        parsedOp('op_obs', { op: 'event.propose', data: { title: '典礼已经开始', phase: 'observed', location_ref: 'L1', subject_ref: 'C4' } }),
        ctx,
      ),
    );
    assert.equal(observed.status, 'occurred');
    assert.equal(observed.occurred_at_s, 7200);

    // 显式 simulated：程序推演落实（必须绑定真实到期行动）。
    const simulated = eventMutation(
      compileEventPropose(
        parsedOp('op_sim', { op: 'event.propose', data: { title: '典礼上遇刺', phase: 'simulated', action_ref: 'A1', location_ref: 'L1', subject_ref: 'C4' } }),
        ctx,
      ),
    );
    assert.equal(simulated.status, 'occurred');
    assert.equal(simulated.occurred_at_s, 7200);
  } finally {
    seed.close();
  }
});

test('T19-08 不能仅凭标题默认 occurred：只给 title 的事件仍是 scheduled', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const ctx = ctxFor(seed, { clockS: 3600 });
    const row = eventMutation(
      compileEventPropose(parsedOp('op_title_only', { op: 'event.propose', data: { title: '国王的典礼', phase: 'scheduled' } }), ctx),
    );
    assert.equal(row.status, 'scheduled');
    assert.equal(row.occurred_at_s, null);
    assert.equal(row.kind, 'other', '标题不决定事件类型');
    assert.equal(row.scheduled_start_s, null, '时间未知就留空，不编一个具体时刻');
    assert.equal(typeof row.id, 'string');
    assert.ok(row.id.length > 0);
  } finally {
    seed.close();
  }
});
