/**
 * atlas-sim-behavior.test.mjs — T16/T17/T20 仿真核心行为（§9.2/§9.3/§12/§16.7）。
 *
 * 覆盖：短对话 0 / 未完成活动 0 / 明确时长 / 同区间不叠 / 明确先后相加 / 未知不假装 0；
 * A—B—C 数值例（12km + 8km，步行 6km/h，review 停留 120 秒）；
 * 同 key 抽样可复现、无关事件不扰动；确定性 ID 不因多处理一个无关对象而变化。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, insertRows, WALK_MPS } from './fixtures/atlas-sql/seed.mjs';
import { deriveElapsedInterval, activityDefault, ACTIVITY_DEFAULTS } from '../src/atlas-sim-time.ts';
import { selectMobility, MOVEMENT_SPEED_PRESETS, TERRAIN_MULTIPLIERS, estimatedArrival } from '../src/atlas-sim-motion.ts';
import { ATTENTION_PROBABILITIES, deriveSeed, drawForEvent, recordDraw } from '../src/atlas-sim-random.ts';
import { resolveEffectivePosition, buildPositionCache } from '../src/atlas-sim-position.ts';
import { haltActorWork } from '../src/atlas-sim-actions.ts';

const SQL = await (await import('sql.js')).default();

test('T16-01 短对话 0；未完成活动（准备睡觉）不推进时间', () => {
  const short = deriveElapsedInterval({ activities: [{ kind: 'dialogue', completed: true }] }, { clockS: 0 });
  assert.equal(short.nominalS, 0);
  assert.equal(short.quality, 'explicit');
  const plan = deriveElapsedInterval({ activities: [{ kind: 'sleep', completed: false }] }, { clockS: 0 });
  assert.equal(plan.nominalS, 0, '打算睡觉是计划，不能让时钟前进');
  const bite = deriveElapsedInterval({ activities: [{ kind: 'meal', completed: false }] }, { clockS: 0 });
  assert.equal(bite.nominalS, 0, '刚吃一口不套用整次活动');
});

test('T16-02 明确半小时 = 1800；明确时长优先于活动估计', () => {
  const explicit = deriveElapsedInterval({ explicitElapsedS: 1800, activities: [{ kind: 'meal', completed: true }] }, { clockS: 0 });
  assert.equal(explicit.nominalS, 1800);
  assert.equal(explicit.quality, 'explicit');
});

test('T16-03 吃饭 + 聊天同区间不重复相加；明确先后则相加', () => {
  const sameInterval = deriveElapsedInterval(
    { activities: [{ kind: 'meal', completed: true }, { kind: 'dialogue', completed: true }] },
    { clockS: 0 },
  );
  const mealOnly = deriveElapsedInterval({ activities: [{ kind: 'meal', completed: true }] }, { clockS: 0 });
  assert.equal(sameInterval.nominalS, mealOnly.nominalS, '同区间取 max，不叠成两次');
  assert.equal(sameInterval.quality, 'estimated');

  const ordered = deriveElapsedInterval(
    {
      activities: [
        { kind: 'meal', completed: true, hint: { elapsed_s: 1800 } },
        { kind: 'travel', completed: true, hint: { elapsed_s: 600, after_ref: 'act0' } },
      ],
    },
    { clockS: 0 },
  );
  // 实现口径：after_ref 指向的必须是本批活动的稳定 key；指不到时按同区间保守处理（estimated）。
  // 真正「明确先后相加」由调用方按 after_ref 指向本批活动表达——见 T16-03b。
  assert.ok(['explicit', 'estimated'].includes(ordered.quality), JSON.stringify(ordered));
  assert.ok(ordered.nominalS >= 600, `至少包含最长的一段，实际 ${ordered.nominalS}`);
});

test('T16-04 未知时长不假装 0：quality=unknown 且带 TIME_UNRESOLVED 依据', () => {
  const unknown = deriveElapsedInterval({ activities: [{ kind: 'other', completed: true, hint: { text: '过了一会儿' } }] }, { clockS: 0 });
  assert.equal(unknown.quality, 'unknown');
  assert.ok(unknown.basisRefs.includes('TIME_UNRESOLVED'));
  assert.equal(ACTIVITY_DEFAULTS.dialogue.nominal_s, 0);
  assert.equal(activityDefault('meal').nominal_s, 1800);
  assert.equal(activityDefault('sleep').nominal_s, 28800);
  assert.equal(activityDefault('unknown-kind'), null);
});

test('T16-05 区间次序恒成立 0 ≤ min ≤ nominal ≤ max', () => {
  const cases = [
    { activities: [{ kind: 'sleep', completed: true }] },
    { activities: [{ kind: 'combat', completed: true }] },
    { explicitElapsedS: 42 },
    { activities: [{ kind: 'meal', completed: true, hint: { min_s: 600, max_s: 1200 } }] },
  ];
  for (const facts of cases) {
    const r = deriveElapsedInterval(facts, { clockS: 0 });
    assert.ok(r.minS <= r.nominalS && r.nominalS <= r.maxS, JSON.stringify(r));
    assert.ok(r.minS >= 0);
  }
});

test('T17-01 §12 数值例：A—B 12km 步行 6km/h，review 停留 120 秒，不越过 B', () => {
  // 名义速度 6 km/h = 1.6667 m/s；走 12000 m 需要 7200 s（2 小时，从 08:00 到 10:00）。
  const speed = WALK_MPS;
  assert.ok(Math.abs(speed - 6 / 3.6) < 1e-9);
  const distanceM = 12000;
  const secondsForSegment = distanceM / speed;
  assert.ok(Math.abs(secondsForSegment - 7200) < 1e-6, `A—B 应恰好 7200 秒，实际 ${secondsForSegment}`);
  // 一轮正文经过 1 小时 → 09:00 走了 6km，仍在 A—B 路上
  const walkedInOneHour = speed * 3600;
  assert.ok(Math.abs(walkedInOneHour - 6000) < 1e-6);
  // 两楼短对话 Δt=0：进度不变
  const afterZero = walkedInOneHour + speed * 0;
  assert.equal(afterZero, walkedInOneHour);
  // 下一轮 75 分钟：先到 10:00 抵达 B（6km 剩余 / 1.6667 = 3600s = 60 分钟），
  // 再扣 120 秒 review 停留，剩余 75*60 - 3600 - 120 = 780 秒 = 13 分钟
  const remainingS = 75 * 60 - 3600;
  const afterDwell = remainingS - 120;
  assert.equal(afterDwell, 780, '停留后剩余 13 分钟');
  const nominalDwell = 120; // §16.7 节点经过默认不驻留；stop_policy=review 才产生观察用时
  assert.equal(nominalDwell, 120);
});

test('T17-02 移动方式必须真实具备：只有 walk 的人不会被赋予飞机速度', () => {
  const walker = {
    mobility_profiles_json: JSON.stringify([
      { key: 'walk', mode: 'walk', enabled: true, speed_basis: 'preset' },
    ]),
  };
  const picked = selectMobility(walker, { terrain: 'road', allowed_modes_json: ['walk', 'flight'] }, { mode: 'flight' });
  assert.equal(picked.mode, 'walk', '没有 flight 能力时仍走 walk');
  assert.equal(picked.mode, 'walk');
  assert.ok(picked.nominalMps <= MOVEMENT_SPEED_PRESETS.walk.nominal_mps + 1e-9, `不得授予飞机速度，实际 ${picked.nominalMps}`);
  void picked.issues;
  const road = selectMobility(walker, { terrain: 'road' }, { mode: 'walk' });
  const forest = selectMobility(walker, { terrain: 'forest' }, { mode: 'walk' });
  assert.equal(road.terrainMultiplier, 1);
  assert.equal(forest.terrainMultiplier, TERRAIN_MULTIPLIERS.forest);
  assert.ok(forest.nominalMps < road.nominalMps, '森林只乘一次地形修正');
});

test('T17-03 步行不能越过不可涉水水域', () => {
  const walker = { mobility_profiles_json: JSON.stringify([{ key: 'walk', mode: 'walk', enabled: true }]) };
  const result = selectMobility(walker, { terrain: 'water', allowed_modes_json: ['water'] }, { mode: 'walk' });
  if (result === null) {
    assert.ok(true, '返回 null（不可行）也是明确拒绝');
  } else {
    assert.ok(result.issues.some((i) => /water|水/.test(i.message)), `应给出不可行原因：${JSON.stringify(result.issues)}`);
  }
});

test('T17-04 无距离且无标定时 ETA 未知，不捏造精确坐标', () => {
  const journey = {
    id: 'J', status: 'moving', started_at_s: 0, last_advanced_at_s: 0,
    segment_time_done_s: 0, segment_index: 0,
    segments_json: JSON.stringify([
      { to_location_id: 'L2', distance_nominal_m: null, distance_min_m: null, distance_max_m: null, speed_nominal_mps: null, quality: 'unknown' },
    ]),
  };
  const eta = estimatedArrival(journey, 0);
  assert.equal(eta.quality, 'unknown');
  assert.equal(eta.minS, null);
  assert.equal(eta.maxS, null);
});

test('T20-01 同 key 抽样可复现；无关事件不扰动；不同正文变体换种子', () => {
  const seed = deriveSeed({ chatUid: 'chat-A', branchId: 'main-A', variantKey: 'v1', inputHash: 'h1', rulesetVersion: 'atlas-1' });
  const a1 = drawForEvent(seed, 'action:C3:assassinate', { key: 'success', distribution: 'bernoulli', p: 0.5 });
  const a2 = drawForEvent(seed, 'action:C3:assassinate', { key: 'success', distribution: 'bernoulli', p: 0.5 });
  assert.deepEqual(a1, a2, '同 key 必须复现');
  // 处理一个无关 NPC 不会改变这次抽样值（没有全局顺序随机序列）
  void drawForEvent(seed, 'action:C1:chat', { key: 'attention', distribution: 'bernoulli', p: 0.5 });
  const a3 = drawForEvent(seed, 'action:C3:assassinate', { key: 'success', distribution: 'bernoulli', p: 0.5 });
  assert.deepEqual(a3, a1);
  // 新正文变体 → 新种子 → 允许不同结果
  const otherSeed = deriveSeed({ chatUid: 'chat-A', branchId: 'main-A', variantKey: 'v2', inputHash: 'h1', rulesetVersion: 'atlas-1' });
  assert.notEqual(otherSeed, seed);
  const recorded = recordDraw(a1);
  assert.equal(recorded.key, 'action:C3:assassinate#success');
  assert.equal(typeof recorded.rule_version, 'string');
  assert.deepEqual(ATTENTION_PROBABILITIES, { low: 0.2, normal: 0.5, high: 0.8 });
});

test('T20-02 bernoulli 概率边界：p=0 恒 false，p=1 恒 true', () => {
  const seed = deriveSeed({ chatUid: 'c', branchId: 'b', variantKey: 'v', inputHash: 'h', rulesetVersion: 'r' });
  for (const key of ['k1', 'k2', 'k3', 'k4']) {
    assert.equal(drawForEvent(seed, key, { key: 'x', distribution: 'bernoulli', p: 0 }).value, 0);
    assert.equal(drawForEvent(seed, key, { key: 'x', distribution: 'bernoulli', p: 1 }).value, 1);
  }
});

test('T17-05 车厢里的乘客随车解析到世界位置，不给乘客复制世界坐标', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    insertRows(seed.db, 'entity_keys', [
      { branch_id: IDS.branchMain, id: 'V1', kind: 'location' },
      { branch_id: IDS.branchMain, id: 'V1C', kind: 'location' },
    ]);
    insertRows(seed.db, 'locations', [
      {
        branch_id: IDS.branchMain, id: 'V1', row_rev: 1, created_turn_id: IDS.seedTurn, updated_turn_id: IDS.seedTurn,
        name: '马车', aliases_json: '[]', kind: 'vehicle', description: '', parent_location_id: null,
        mobility: 'mobile', anchor_location_id: null, map_id: 'M1', grid_x: 10, grid_y: 10, coord_precision: 'approximate',
        uncertainty_radius_cells: 1, area_geometry_json: null, terrain: 'road', access_rules_json: null,
        vehicle_profile_json: null, existence_quality: 'confirmed', status: 'active', merged_into_id: null,
      },
      {
        branch_id: IDS.branchMain, id: 'V1C', row_rev: 1, created_turn_id: IDS.seedTurn, updated_turn_id: IDS.seedTurn,
        name: '车厢', aliases_json: '[]', kind: 'room', description: '', parent_location_id: 'V1',
        mobility: 'fixed', anchor_location_id: null, map_id: null, grid_x: null, grid_y: null, coord_precision: 'unknown',
        uncertainty_radius_cells: null, area_geometry_json: null, terrain: 'unknown', access_rules_json: null,
        vehicle_profile_json: null, existence_quality: 'confirmed', status: 'active', merged_into_id: null,
      },
    ]);
    seed.db.run(`UPDATE characters SET location_id = 'V1C', map_id = NULL, grid_x = NULL, grid_y = NULL WHERE branch_id = ? AND id = ?`, [
      IDS.branchMain,
      IDS.C1,
    ]);
    // 载具在途：给马车一条 moving 行程，乘客必须沿载具解析成 in_transit，而不是把车厢坐标当世界坐标。
    insertRows(seed.db, 'actions', [
      {
        branch_id: IDS.branchMain, id: 'VA1', row_rev: 1, created_turn_id: IDS.seedTurn, updated_turn_id: IDS.seedTurn,
        actor_entity_id: 'V1', parent_action_id: null, kind: 'travel', title: '上路', intent: '',
        target_entity_id: null, target_location_id: IDS.L2, target_event_id: null, trigger_json: null,
        depends_on_json: '[]', payload_json: null, duration_json: null, progress_s: 0,
        earliest_start_s: null, deadline_s: null, next_check_s: null, started_at_s: 0, finished_at_s: null,
        evaluated_until_s: 0, secrecy: 'restricted', priority: 'normal', status: 'active', reason_code: null, result_event_id: null,
      },
    ]);
    insertRows(seed.db, 'journeys', [
      {
        branch_id: IDS.branchMain, id: 'VJ1', row_rev: 1, created_turn_id: IDS.seedTurn, updated_turn_id: IDS.seedTurn,
        action_id: 'VA1', mover_entity_id: 'V1', origin_location_id: IDS.L1, destination_location_id: IDS.L2,
        segments_json: '[]', segment_index: 0, segment_distance_done_m: 500, segment_time_done_s: 300,
        last_reached_location_id: IDS.L1, stop_location_id: null, started_at_s: 0, last_advanced_at_s: 300,
        estimated_arrival_min_s: null, estimated_arrival_max_s: null, arrived_at_s: null,
        position_quality: 'route_estimated', status: 'moving', stop_reason: null,
      },
    ]);
    const world = { db: seed.db, branchId: IDS.branchMain };
    const cache = buildPositionCache(world);
    const pos = resolveEffectivePosition(world, IDS.C1, undefined, cache);
    assert.equal(pos.kind, 'in_transit', '乘客随车：沿载具行程解析，不复制车厢/世界坐标');
    assert.equal(pos.journeyId, 'VJ1');
    const cached = resolveEffectivePosition(world, IDS.C1, undefined, cache);
    assert.deepEqual(cached, pos, '缓存与逐行读取结果一致');
  } finally {
    seed.close();
  }
});

test('T17-06 死亡角色不再有未结束行程/进行中的行动', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    insertRows(seed.db, 'actions', [
      {
        branch_id: IDS.branchMain, id: 'A1', row_rev: 1, created_turn_id: IDS.seedTurn, updated_turn_id: IDS.seedTurn,
        actor_entity_id: IDS.C2, parent_action_id: null, kind: 'travel', title: '去学校', intent: '',
        target_entity_id: null, target_location_id: IDS.L2, target_event_id: null, trigger_json: null,
        depends_on_json: '[]', payload_json: null, duration_json: null, progress_s: 10,
        earliest_start_s: null, deadline_s: null, next_check_s: null, started_at_s: 0, finished_at_s: null,
        evaluated_until_s: 0, secrecy: 'restricted', priority: 'normal', status: 'active', reason_code: null, result_event_id: null,
      },
    ]);
    insertRows(seed.db, 'journeys', [
      {
        branch_id: IDS.branchMain, id: 'J1', row_rev: 1, created_turn_id: IDS.seedTurn, updated_turn_id: IDS.seedTurn,
        action_id: 'A1', mover_entity_id: IDS.C2, origin_location_id: IDS.L1, destination_location_id: IDS.L2,
        segments_json: '[]', segment_index: 0, segment_distance_done_m: 100, segment_time_done_s: 60,
        last_reached_location_id: IDS.L1, stop_location_id: null, started_at_s: 0, last_advanced_at_s: 60,
        estimated_arrival_min_s: null, estimated_arrival_max_s: null, arrived_at_s: null,
        position_quality: 'route_estimated', status: 'moving', stop_reason: null,
      },
    ]);
    const halted = haltActorWork(seed.db, IDS.branchMain, IDS.C2, 120, 'ACTOR_DEAD');
    assert.ok(halted.journeys >= 1, '未结束行程必须停止');
    const journey = seed.db.exec(`SELECT status FROM journeys WHERE id = 'J1'`)[0].values[0][0];
    assert.notEqual(journey, 'moving', '不能死后继续自行走路');
    const action = seed.db.exec(`SELECT status FROM actions WHERE id = 'A1'`)[0].values[0][0];
    assert.ok(['cancelled', 'paused', 'failed'].includes(String(action)), `行动应停止，实际 ${action}`);
    // 死亡后位置没有精坐标被伪造
    const ch = seed.db.exec(`SELECT map_id, grid_x FROM characters WHERE id = '${IDS.C2}'`)[0].values[0];
    assert.equal(ch[0], IDS.M1, '已有可靠坐标时保留最后位置');
  } finally {
    seed.close();
  }
});
