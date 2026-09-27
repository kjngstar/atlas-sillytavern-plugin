/**
 * atlas-sim-propagation.test.mjs — T18 消息传播行为（§5.3 / §5.4 / §5.5 / §9.4 / §16.7）。
 *
 * 覆盖：
 * - 风声 front ≠ 所有人 knowledge：有传言不等于全城知情，程序不写 knowledge；
 * - 实际延迟：未到到达时刻绝不建 front，到点才建立且带真实到达时间；
 * - 地理/渠道去重：同一 (information, 目的地) 不重复插入，传播任务 ID 稳定；
 * - 私密消息不自动进入地理扩散；
 * - 组织知道 ≠ 成员全知；
 * - 同地不保证目击：普通公众接触要求 60 世界秒停留或明确看见/听见依据，已知者被排除；
 * - 特殊通信延迟可为 0（magic 渠道），信使依地理旅行且**只算一次**路程耗时。
 *
 * 全部走真实模块（atlas-sim-propagation / atlas-sim-opportunities），不另造桩。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, insertRows, countRows } from './fixtures/atlas-sql/seed.mjs';
import { PROPAGATION_CHECK_INTERVAL_S, scheduleDeliveries, deliverDueInformation } from '../src/atlas-sim-propagation.ts';
import { PUBLIC_CONTACT_DWELL_S, OPPORTUNITY_BUCKET_S, collectOpportunities } from '../src/atlas-sim-opportunities.ts';

const SQL = await (await import('sql.js')).default();

const BRANCH = IDS.branchMain;

/** 确定性 makeId（不使用 Math.random / Date.now）。 */
const makeId = (kind, opId, alias) => `${kind}_${opId}_${alias}`;

function worldFor(seed, clockS = 0) {
  return { db: seed.db, branchId: BRANCH, clockS, makeId, turnId: IDS.seedTurn };
}

function informationRow(id, secrecy, overrides = {}) {
  return {
    branch_id: BRANCH,
    id,
    row_rev: 1,
    created_turn_id: IDS.seedTurn,
    updated_turn_id: IDS.seedTurn,
    kind: 'rumor',
    title: '城门来了外人',
    content: '今天城门口来了一队陌生人',
    source_event_id: null,
    subject_entity_id: null,
    payload_json: '{}',
    origin_location_id: IDS.L1,
    originator_entity_id: null,
    parent_information_id: null,
    truth_status: 'unknown',
    secrecy,
    topic_key: `topic_${id}`,
    content_hash: `hash_${id}`,
    created_at_s: 0,
    expires_at_s: null,
    supersedes_information_id: null,
    status: 'active',
    ...overrides,
  };
}

function frontRow(id, informationId, locationId, overrides = {}) {
  return {
    branch_id: BRANCH,
    id,
    row_rev: 1,
    created_turn_id: IDS.seedTurn,
    updated_turn_id: IDS.seedTurn,
    information_id: informationId,
    location_id: locationId,
    via_channel_id: null,
    source_front_id: null,
    source_action_id: null,
    first_available_at_s: 0,
    last_reinforced_at_s: 0,
    next_spread_check_s: 0,
    expires_at_s: null,
    reach: 'local',
    audience_json: JSON.stringify({ access: 'public', tags: [] }),
    status: 'active',
    ...overrides,
  };
}

function channelRow(id, overrides = {}) {
  return {
    branch_id: BRANCH,
    id,
    row_rev: 1,
    created_turn_id: IDS.seedTurn,
    updated_turn_id: IDS.seedTurn,
    name: `渠道 ${id}`,
    kind: 'messenger',
    owner_entity_id: IDS.F1,
    source_entity_id: null,
    source_location_id: IDS.L1,
    recipient_entity_id: null,
    recipient_location_id: IDS.L2,
    scope_json: '{}',
    requirements_json: null,
    latency_json: JSON.stringify({ quality: 'unknown', basis_refs: [] }),
    transport_mode_key: 'walk',
    reliability: 'high',
    secrecy: 'secret',
    basis_quality: 'confirmed',
    valid_from_s: 0,
    valid_until_s: null,
    status: 'active',
    ...overrides,
  };
}

/** 传给 scheduleDeliveries 的 front 视图对象（与 decodeRow 后的形状一致）。 */
function frontView(id, informationId, locationId, overrides = {}) {
  return { id, information_id: informationId, location_id: locationId, status: 'active', first_available_at_s: 0, next_spread_check_s: 0, ...overrides };
}

/** 传给 scheduleDeliveries 的 channel 视图对象（与 decodeRow 后的形状一致）。 */
function channelView(id, overrides = {}) {
  return {
    id,
    status: 'active',
    source_location_id: IDS.L1,
    recipient_location_id: IDS.L2,
    source_entity_id: null,
    recipient_entity_id: null,
    transport_mode_key: 'walk',
    valid_from_s: 0,
    ...overrides,
  };
}

function countWhere(db, table, where, params = []) {
  const rows = db.exec(`SELECT COUNT(*) FROM ${table} WHERE ${where}`, params);
  return Number(rows[0].values[0][0]);
}

function receiversOf(opportunities, kind) {
  return opportunities.filter((o) => o.kind === kind).map((o) => o.receiverEntityId);
}

test('T18-01 §5.3/§9.4 风声 front ≠ 所有人 knowledge：有传言不等于全城知情', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    insertRows(seed.db, 'information', [informationRow('INF1', 'public')]);
    insertRows(seed.db, 'rumor_fronts', [frontRow('FR1', 'INF1', IDS.L1)]);
    assert.equal(countRows(seed.db, 'rumor_fronts', BRANCH), 1, '同消息同地点恰好一行风声');
    assert.equal(countRows(seed.db, 'knowledge', BRANCH), 0, '建立 front 不等于全城知情');
    // 收集机会（真实入口）也绝不写 knowledge：机会 ≠ 已知。
    const opportunities = collectOpportunities({ fromS: 0, untilS: 600 }, { db: seed.db, branchId: BRANCH });
    assert.ok(opportunities.length >= 1, '至少产生一条「这里有一次可能接触」的候选');
    assert.equal(countRows(seed.db, 'knowledge', BRANCH), 0, '候选机会不产生任何 knowledge 行');
    assert.equal(countRows(seed.db, 'rumor_fronts', BRANCH), 1);
  } finally {
    seed.close();
  }
});

test('T18-02 §16.7 实际延迟：未到到达时刻不建 front，到点才建立', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    assert.equal(PROPAGATION_CHECK_INTERVAL_S, 3600, '公开风声每 3600 世界秒检查一次可通行外出连接');
    insertRows(seed.db, 'information', [informationRow('INF1', 'public')]);
    insertRows(seed.db, 'rumor_fronts', [frontRow('FR1', 'INF1', IDS.L1)]);
    const world = worldFor(seed, 0);
    const scheduled = scheduleDeliveries([frontView('FR1', 'INF1', IDS.L1)], [], world);
    const delivery = scheduled.tasks.find((t) => t.task_kind === 'delivery');
    assert.ok(delivery, '公开风声必须给出带真实到达时间的投递任务');
    assert.equal(delivery.from_location_id, IDS.L1);
    assert.equal(delivery.to_location_id, IDS.L2);
    assert.equal(delivery.distance_m, 12000);
    assert.ok(delivery.speed_mps > 0, '必须按选用的携带方式算出速度，而不是立刻送达');
    // 出发 = front 可用后的第一次检查（3600）；到达 = 出发 + 真实路程耗时。
    assert.equal(delivery.depart_at_s, PROPAGATION_CHECK_INTERVAL_S);
    assert.equal(delivery.arrive_at_s, PROPAGATION_CHECK_INTERVAL_S + delivery.distance_m / delivery.speed_mps);
    assert.ok(delivery.arrive_at_s > delivery.depart_at_s, '到 B 需要真实路程时间');

    // 到达之前（正好在出发时刻）不建 front。
    const early = deliverDueInformation(delivery.depart_at_s, world);
    assert.equal(early.frontsCreated, 0, '还没到就不许建立 front');
    assert.equal(countWhere(seed.db, 'rumor_fronts', "information_id = 'INF1' AND location_id = 'L2'"), 0);

    // 到点之后建立 front，且 first_available_at_s 就是真实到达时刻。
    const late = deliverDueInformation(Math.ceil(delivery.arrive_at_s), world);
    assert.equal(late.frontsCreated, 1, '到点后才建立本地风声');
    const rows = seed.db.exec(`SELECT location_id, first_available_at_s FROM rumor_fronts WHERE information_id = 'INF1' AND location_id = 'L2'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].values[0][0], IDS.L2);
    assert.equal(Number(rows[0].values[0][1]), delivery.arrive_at_s, 'front 的可用时间 = 实际到达时间');
  } finally {
    seed.close();
  }
});

test('T18-03 §5.3/§9.4 地理去重：重复投递不产生第二行 front，传播任务 ID 稳定', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    insertRows(seed.db, 'information', [informationRow('INF1', 'public')]);
    insertRows(seed.db, 'rumor_fronts', [frontRow('FR1', 'INF1', IDS.L1)]);
    const view = frontView('FR1', 'INF1', IDS.L1);

    // 同一状态重复检查：投递任务 ID 与到达时刻逐字相同（稳定 ID、重复检查不重复投递）。
    const first = scheduleDeliveries([view], [], worldFor(seed, 0)).tasks.find((t) => t.task_kind === 'delivery');
    const again = scheduleDeliveries([view], [], worldFor(seed, 0)).tasks.find((t) => t.task_kind === 'delivery');
    const nextHour = scheduleDeliveries([view], [], worldFor(seed, PROPAGATION_CHECK_INTERVAL_S)).tasks.find((t) => t.task_kind === 'delivery');
    assert.equal(again.id, first.id, '同 (information, 目的地) 的传播任务 ID 必须稳定');
    assert.equal(nextHour.id, first.id, '下一次检查不会换一个传播任务 ID');
    assert.equal(again.arrive_at_s, first.arrive_at_s);
    assert.equal(nextHour.arrive_at_s, first.arrive_at_s, '重复检查不得把已经上路的信使再发一遍');
    assert.equal(first.dedupe_key, 'INF1|L2');

    // 到期落实一次 → 恰好一行；再落实（含更晚窗口）不产生第二行。
    const arrival = Math.ceil(first.arrive_at_s);
    assert.equal(deliverDueInformation(arrival, worldFor(seed, 0)).frontsCreated, 1);
    assert.equal(deliverDueInformation(arrival + 50000, worldFor(seed, 0)).frontsCreated, 0, '同一 (information, 地点) 不重复插入');
    assert.equal(countWhere(seed.db, 'rumor_fronts', "information_id = 'INF1' AND location_id = 'L2'"), 1);
    assert.equal(countRows(seed.db, 'rumor_fronts', BRANCH), 2, '只有来源地 L1 与新到达地 L2 各一行');
    // 到达后再次调度：已有 front 的目的地不再生成投递任务。
    const afterDelivery = scheduleDeliveries([frontView('FR1', 'INF1', IDS.L1, { next_spread_check_s: arrival + 50000 })], [], worldFor(seed, arrival + 50000));
    assert.equal(afterDelivery.tasks.filter((t) => t.task_kind === 'delivery').length, 0, '已到达地点不重复投递');
  } finally {
    seed.close();
  }
});

test('T18-04 §16.7 私密消息不公开扩散：secret 信息不会仅靠地理传播建立跨地 front', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    insertRows(seed.db, 'information', [informationRow('SEC1', 'secret')]);
    insertRows(seed.db, 'rumor_fronts', [frontRow('FR_SEC', 'SEC1', IDS.L1)]);
    const world = worldFor(seed, 0);
    const scheduled = scheduleDeliveries([frontView('FR_SEC', 'SEC1', IDS.L1)], [], world);
    assert.equal(scheduled.tasks.filter((t) => t.task_kind === 'delivery').length, 0, '私密信息不自动进入地理扩散');
    const before = countRows(seed.db, 'rumor_fronts', BRANCH);
    const delivered = deliverDueInformation(200000, world);
    assert.equal(delivered.frontsCreated, 0);
    assert.equal(countWhere(seed.db, 'rumor_fronts', "information_id = 'SEC1' AND location_id = 'L2'"), 0);
    assert.equal(countRows(seed.db, 'rumor_fronts', BRANCH), before);
    assert.equal(countRows(seed.db, 'knowledge', BRANCH), 0);

    // 公开对照：同样的地点/路线，公开信息才会沿路扩散。
    insertRows(seed.db, 'information', [informationRow('PUB1', 'public')]);
    insertRows(seed.db, 'rumor_fronts', [frontRow('FR_PUB', 'PUB1', IDS.L1)]);
    assert.equal(scheduleDeliveries([frontView('FR_PUB', 'PUB1', IDS.L1)], [], world).tasks.filter((t) => t.task_kind === 'delivery').length, 1);
  } finally {
    seed.close();
  }
});

test('T18-05 §5.4 组织知道不等于成员全知：势力认知不为成员生成 knowledge', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    insertRows(seed.db, 'information', [informationRow('INF1', 'restricted')]);
    insertRows(seed.db, 'knowledge', [
      {
        branch_id: BRANCH,
        id: 'K_F1',
        row_rev: 1,
        created_turn_id: IDS.seedTurn,
        updated_turn_id: IDS.seedTurn,
        knower_character_id: null,
        knower_faction_id: IDS.F1,
        is_pov: 0,
        information_id: 'INF1',
        source_entity_id: null,
        source_front_id: null,
        source_channel_id: null,
        first_received_at_s: 0,
        last_confirmed_at_s: null,
        belief: 'believed',
        attention: 'high',
        reaction_note: '暗卫报告',
        status: 'active',
      },
    ]);
    assert.equal(countRows(seed.db, 'knowledge', BRANCH), 1, '组织恰好一条认知');
    assert.equal(countWhere(seed.db, 'knowledge', "information_id = 'INF1' AND knower_character_id IS NOT NULL"), 0, '组织知道不写成员认知');
    // 组织成员（C1 是 F1 成员，见 seed 的 member_of 关系）不会因此多出一条认知。
    const memberRows = countWhere(
      seed.db,
      'knowledge',
      `branch_id = '${BRANCH}' AND knower_character_id = '${IDS.C1}' AND information_id = 'INF1'`,
    );
    assert.equal(memberRows, 0, '国王的暗卫报告先进入组织，不会自动变成所有成员的认知');
    assert.equal(countRows(seed.db, 'rumor_fronts', BRANCH), 0, '组织认知也不等于当地风声');
  } finally {
    seed.close();
  }
});

test('T18-06 §16.7 同地不保证目击：60 秒停留或明确看见才算候选，已知者被排除', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    assert.equal(PUBLIC_CONTACT_DWELL_S, 60);
    assert.equal(OPPORTUNITY_BUCKET_S, 3600);
    insertRows(seed.db, 'information', [informationRow('INF1', 'public')]);
    insertRows(seed.db, 'rumor_fronts', [frontRow('FR1', 'INF1', IDS.L1)]);

    // 1) 仅「同城」（characters.location_id = L1）不是候选：C4 国王一直在 L1，但没有停留/目击依据。
    const sameCityOnly = collectOpportunities({ fromS: 0, untilS: 600 }, { db: seed.db, branchId: BRANCH });
    assert.equal(sameCityOnly.some((o) => o.receiverEntityId === IDS.C4), false, '只凭粗粒度 location_id 不算停留证据');
    assert.equal(sameCityOnly.some((o) => o.receiverEntityId === IDS.C3), false);
    assert.ok(
      sameCityOnly.some((o) => o.kind === 'rumor_front' && o.locationId === IDS.L1),
      '风声本身仍然是「这里有一次可能接触」',
    );

    // 2) 有真实停留（≥60 世界秒）才是候选。
    insertRows(seed.db, 'actions', [
      {
        branch_id: BRANCH,
        id: 'ACT_C3_STAY',
        row_rev: 1,
        created_turn_id: IDS.seedTurn,
        updated_turn_id: IDS.seedTurn,
        actor_entity_id: IDS.C3,
        parent_action_id: null,
        kind: 'interact',
        title: '在城门打听',
        intent: '',
        target_entity_id: null,
        target_location_id: IDS.L1,
        target_event_id: null,
        trigger_json: null,
        depends_on_json: '[]',
        payload_json: null,
        duration_json: null,
        progress_s: 0,
        earliest_start_s: null,
        deadline_s: null,
        next_check_s: null,
        started_at_s: 0,
        finished_at_s: null,
        evaluated_until_s: 0,
        secrecy: 'restricted',
        priority: 'normal',
        status: 'active',
        reason_code: null,
        result_event_id: null,
      },
    ]);
    const withDwell = collectOpportunities({ fromS: 0, untilS: 600 }, { db: seed.db, branchId: BRANCH });
    const c3 = withDwell.find((o) => o.kind === 'same_location' && o.receiverEntityId === IDS.C3);
    assert.ok(c3, '停留满 60 世界秒才是候选');
    assert.equal(c3.requiresDwellS, PUBLIC_CONTACT_DWELL_S);
    assert.ok(Number(c3.basis.dwellS) >= PUBLIC_CONTACT_DWELL_S, `实际停留 ${String(c3.basis.dwellS)}`);
    assert.equal(c3.basis.reason, 'stayed_at_location');
    assert.equal(withDwell.some((o) => o.receiverEntityId === IDS.C4), false, '同城但未停留仍不是候选');

    // 3) 机会 ≠ 已知：已有 knowledge 的人不再产生同地机会。
    insertRows(seed.db, 'knowledge', [
      {
        branch_id: BRANCH,
        id: 'K_C3',
        row_rev: 1,
        created_turn_id: IDS.seedTurn,
        updated_turn_id: IDS.seedTurn,
        knower_character_id: IDS.C3,
        knower_faction_id: null,
        is_pov: 0,
        information_id: 'INF1',
        source_entity_id: null,
        source_front_id: null,
        source_channel_id: null,
        first_received_at_s: 0,
        last_confirmed_at_s: null,
        belief: 'heard',
        attention: 'normal',
        reaction_note: '',
        status: 'active',
      },
    ]);
    const known = collectOpportunities({ fromS: 0, untilS: 600 }, { db: seed.db, branchId: BRANCH });
    assert.equal(receiversOf(known, 'same_location').includes(IDS.C3), false, '已经知道的人不再重复触发接触机会');

    // 4) 明确看见/听见（渠道来源地就在此处）可以免停留成为候选。
    insertRows(seed.db, 'channels', [
      channelRow('CH_WATCH', {
        kind: 'surveillance',
        source_location_id: IDS.L1,
        recipient_entity_id: IDS.C4,
        recipient_location_id: null,
        transport_mode_key: null,
      }),
    ]);
    const explicit = collectOpportunities({ fromS: 0, untilS: 600 }, { db: seed.db, branchId: BRANCH });
    const c4 = explicit.find((o) => o.kind === 'same_location' && o.receiverEntityId === IDS.C4);
    assert.ok(c4, '明确看见/听见（渠道来源在范围内）不要求 60 秒停留');
    assert.equal(c4.basis.explicitVisibility, true);
    assert.equal(c4.basis.reason, 'explicit_hear_or_see');
  } finally {
    seed.close();
  }
});

test('T18-07 §9.4 信使渠道按路线耗时到达；总延迟只算一次路程', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    insertRows(seed.db, 'information', [informationRow('MSG1', 'restricted')]);
    insertRows(seed.db, 'rumor_fronts', [frontRow('FR_MSG', 'MSG1', IDS.L1)]);
    insertRows(seed.db, 'channels', [channelRow('CH_MSG', { latency_json: JSON.stringify({ min_s: 0, nominal_s: 0, max_s: 0 }) })]);
    const world = worldFor(seed, 0);
    const scheduled = scheduleDeliveries([frontView('FR_MSG', 'MSG1', IDS.L1)], [channelView('CH_MSG')], world);
    const delivery = scheduled.tasks.find((t) => t.task_kind === 'delivery');
    assert.ok(delivery, '明确渠道（有来源地与收件地）才可能传递私密消息');
    assert.equal(delivery.via_channel_id, 'CH_MSG');
    assert.equal(delivery.to_location_id, IDS.L2);
    assert.equal(delivery.speed_mps, 1.4, '信使按 route/transport_mode_key 的真实速度');
    assert.equal(delivery.distance_m, 12000);
    const travelS = delivery.distance_m / delivery.speed_mps;
    assert.ok(Math.abs(travelS - 12000 / 1.4) < 1e-9);
    const latency = delivery.arrive_at_s - delivery.depart_at_s;
    assert.ok(Math.abs(latency - travelS) < 1e-9, `总延迟必须等于路程耗时（实际 ${latency}，路程 ${travelS}）`);
    assert.ok(Math.abs(latency - 2 * travelS) > 1, '不能既算信使路程又重复加一遍相同距离延迟');

    const delivered = deliverDueInformation(Math.ceil(delivery.arrive_at_s), world);
    assert.equal(delivered.frontsCreated, 1);
    const row = seed.db.exec(`SELECT via_channel_id, first_available_at_s FROM rumor_fronts WHERE information_id = 'MSG1' AND location_id = 'L2'`);
    assert.equal(row[0].values[0][0], 'CH_MSG', '到达记录说明走了哪条渠道');
    assert.equal(Number(row[0].values[0][1]), delivery.arrive_at_s);
    assert.equal(countRows(seed.db, 'knowledge', BRANCH), 0, '到达只建立风声，不直接写认知');
  } finally {
    seed.close();
  }
});

test(
  'T18-07b §9.4 特殊通信延迟可为 0：magic 渠道 latency_json=0 立即到达',
  async () => {
    const seed = await makeSeedWith(SQL);
    try {
      insertRows(seed.db, 'information', [informationRow('MAG1', 'secret')]);
      insertRows(seed.db, 'rumor_fronts', [frontRow('FR_MAG', 'MAG1', IDS.L1)]);
      insertRows(seed.db, 'channels', [
        channelRow('CH_MAGIC', {
          name: '监视水晶',
          kind: 'magic',
          transport_mode_key: null,
          // TimeEstimate（§2.4）：延迟 0 必须是**明确**的 0；quality=unknown 的空值绝不当成 0。
          latency_json: JSON.stringify({ min_s: 0, nominal_s: 0, max_s: 0, quality: 'explicit', basis_refs: [] }),
        }),
      ]);
      const world = worldFor(seed, 0);
      const scheduled = scheduleDeliveries(
        [frontView('FR_MAG', 'MAG1', IDS.L1)],
        [
          channelView('CH_MAGIC', {
            transport_mode_key: null,
            latency_json: JSON.stringify({ min_s: 0, nominal_s: 0, max_s: 0, quality: 'explicit', basis_refs: [] }),
          }),
        ],
        world,
      );
      const delivery = scheduled.tasks.find((t) => t.task_kind === 'delivery');
      assert.ok(delivery, '带 latency_json 的 magic 渠道必须能传递消息（延迟 0 = 立即到达）');
      assert.equal(delivery.arrive_at_s, delivery.depart_at_s, '延迟 0 时到达时刻等于出发时刻');
      assert.equal(deliverDueInformation(delivery.depart_at_s, world).frontsCreated, 1);
    } finally {
      seed.close();
    }
  },
);
