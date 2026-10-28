/**
 * atlas-generated-route-integration.test.mjs — P11 §17.3「设施与道路真正可用」。
 *
 * 全部走真实 SQL 与真实入口（`startJourney` / `advanceJourney` / `computeTravelInterval` /
 * `scheduleDeliveries`），不用假桩。要证明的六件事：
 * 1. **estimated 路线可用**，不因为没 confirmed 就被一律拒绝；
 * 2. 但它**不伪装精确**：ETA 是区间，位置质量是 route_estimated；
 * 3. 未标定的地图不把格数当米（量不出距离就报未知，不硬算）；
 * 4. 不同图的局部坐标不相减（同一条几何在同一帧上能量出米，跨帧就量不出）；
 * 5. 路关了就停在原地，不穿过；访问条件（宵禁/关卡）变化时同样停；
 * 6. 消息也只沿真实、当前可通行的道路传播；Δt=0 不瞬移、不传播。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { makeSeedWith, insertRows, IDS } from './fixtures/atlas-sql/seed.mjs';
import { createRow } from '../src/atlas-db-defaults.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { startJourney, advanceJourney, computeTravelInterval } from '../src/atlas-sim-motion.ts';
import { scheduleDeliveries, PROPAGATION_CHECK_INTERVAL_S } from '../src/atlas-sim-propagation.ts';

const SQL = await initSqlJs();
const UNCAL_MAP = 'M_UNCAL';
const FAR1 = 'L_FAR1';
const FAR2 = 'L_FAR2';
const NEAR = 'L_NEAR';

const base = (seed, id) => ({
  branch_id: seed.branchId, id, row_rev: 1,
  created_turn_id: seed.seedTurnId, updated_turn_id: seed.seedTurnId,
});

function locationRow(seed, id, overrides = {}) {
  return {
    ...base(seed, id),
    name: `地点 ${id}`, aliases_json: '[]', kind: 'building', description: '',
    parent_location_id: null, mobility: 'fixed', anchor_location_id: null,
    map_id: IDS.M1, grid_x: 10, grid_y: 10, coord_precision: 'approximate',
    uncertainty_radius_cells: null, area_geometry_json: null, terrain: 'road',
    access_rules_json: null, vehicle_profile_json: null,
    existence_quality: 'confirmed', status: 'active', merged_into_id: null,
    ...overrides,
  };
}

function routeRow(seed, id, overrides = {}) {
  return {
    ...base(seed, id),
    from_location_id: IDS.L1, to_location_id: IDS.L2, kind: 'road', bidirectional: 1,
    map_id: IDS.M1, geometry_json: null, geometry_quality: 'unknown', geometry_rev: 1,
    distance_m: null, distance_min_m: null, distance_max_m: null, distance_basis: 'unknown',
    terrain: 'road', allowed_modes_json: '["walk","ride"]', access_rules_json: null,
    travel_time_override_json: null, status: 'open', status_reason: '',
    ...overrides,
  };
}

async function fixture() {
  const seed = await makeSeedWith(SQL);
  const { db } = seed;
  db.run('BEGIN');

  // 一张**未标定**的图：有 frame、没有米/格。格数不能当米用。
  insertRows(db, 'maps', [{
    ...base(seed, UNCAL_MAP),
    name: '未标定的荒野图', kind: 'region', container_location_id: null, description: '',
    frame_json: JSON.stringify({ origin_x: 0, origin_y: 0, reference_width_cells: 40, reference_height_cells: 40 }),
    meters_per_cell: null, scale_min_meters_per_cell: null, scale_max_meters_per_cell: null,
    scale_quality: 'uncalibrated', scale_basis_json: '{}', scale_locked: 0, calibration_rev: 1,
    background_asset_key: null, default_terrain: 'plain', status: 'active',
  }]);

  for (const id of [FAR1, FAR2, NEAR]) {
    insertRows(db, 'entity_keys', [{ branch_id: seed.branchId, id, kind: 'location' }]);
  }
  insertRows(db, 'locations', [
    locationRow(seed, FAR1, { map_id: UNCAL_MAP, grid_x: 2, grid_y: 2 }),
    locationRow(seed, FAR2, { map_id: UNCAL_MAP, grid_x: 14, grid_y: 2 }),
    locationRow(seed, NEAR, { map_id: IDS.M1, grid_x: 12, grid_y: 11 }),
  ]);

  const line = (a, b) => JSON.stringify({ kind: 'line', coordinates: [a, b] });
  insertRows(db, 'routes', [
    // 同一帧、已标定：几何能量出米（对照组）。
    routeRow(seed, 'R_SAME_FRAME', {
      to_location_id: NEAR, geometry_json: line([10, 10], [12, 11]), geometry_quality: 'estimated',
    }),
    // 未标定帧：几何在那里，但没有米/格 → 不量。
    routeRow(seed, 'R_UNCAL', {
      from_location_id: FAR1, to_location_id: FAR2, map_id: UNCAL_MAP,
      geometry_json: line([2, 2], [14, 2]), geometry_quality: 'estimated',
    }),
    // 跨帧：几何画在 M1 上，但一端在教室（M2）→ 不能拿 M1 的格差当两点距离。
    routeRow(seed, 'R_CROSS_FRAME', {
      from_location_id: IDS.L1, to_location_id: IDS.L3,
      geometry_json: line([10, 10], [5, 6]), geometry_quality: 'estimated',
    }),
  ]);

  db.run('COMMIT');
  return seed;
}

function actor(world, id = IDS.C2) {
  return queryBound(world.db, 'SELECT * FROM characters WHERE branch_id = ? AND id = ?', [world.branchId, id])[0];
}

function travelAction(target, overrides = {}) {
  return {
    id: 'A_TRAVEL', status: 'ready', kind: 'travel', actor_entity_id: IDS.C2,
    target_location_id: target, payload_json: '{}', ...overrides,
  };
}

const journeyWorld = (seed) => ({
  db: seed.db, branchId: seed.branchId, clockS: 0, turnId: seed.seedTurnId,
  makeId: (kind, opId, alias) => `${kind}_${opId}_${alias}`,
});

/* ------------------------------------------------------------------ *
 * 1 estimated 路线可用，但不伪装精确
 * ------------------------------------------------------------------ */

test('§17.3 estimated 路线可以真的走：不被「未确认」一律拒绝', async () => {
  const seed = await fixture();
  const world = { db: seed.db, branchId: seed.branchId };
  seed.db.run(
    'UPDATE routes SET distance_m = ?, distance_min_m = ?, distance_max_m = ?, distance_basis = ?, geometry_quality = ? WHERE branch_id = ? AND id = ?',
    [12000, 9000, 15000, 'estimated', 'estimated', seed.branchId, IDS.R_AB],
  );

  const interval = computeTravelInterval(world, actor(world), queryBound(seed.db, 'SELECT * FROM routes WHERE branch_id = ? AND id = ?', [seed.branchId, IDS.R_AB])[0]);
  assert.ok(interval, '估计路程必须参与旅行，而不是一律返回 null');
  assert.ok(interval.min_s < interval.nominal_s && interval.nominal_s < interval.max_s, '估计路程给的是区间，不是单点');

  const started = startJourney(travelAction(IDS.L2), journeyWorld(seed));
  assert.ok(started.journey, `estimated 路线应建立行程：${JSON.stringify(started.issues)}`);
  const segments = JSON.parse(String(started.journey.segments_json));
  assert.equal(segments[0].quality, 'estimated', '路段质量如实标 estimated');
  assert.equal(started.journey.position_quality, 'route_estimated', '位置质量不冒充 route_confirmed');
  assert.ok(
    started.journey.estimated_arrival_min_s < started.journey.estimated_arrival_max_s,
    'ETA 是区间，不伪装成精确到达时刻',
  );
  seed.close();
});

test('§17.3 精确路线才报 confirmed：距离与几何都确认后才不是估计', async () => {
  const seed = await fixture();
  const world = { db: seed.db, branchId: seed.branchId };
  // seed 的 R_AB 是 narrative 12000 单值（距离确认），但几何质量仍是 estimated。
  const interval = computeTravelInterval(world, actor(world), queryBound(seed.db, 'SELECT * FROM routes WHERE branch_id = ? AND id = ?', [seed.branchId, IDS.R_AB])[0]);
  assert.ok(interval);
  assert.equal(interval.min_s, interval.max_s, '单值距离给单值耗时');
  assert.equal(startJourney(travelAction(IDS.L2), journeyWorld(seed)).journey.position_quality, 'route_estimated', '只有距离确认、几何未确认 → 仍按估计');

  // 几何也确认后才允许报 confirmed。
  seed.db.run('UPDATE routes SET geometry_quality = ? WHERE branch_id = ? AND id = ?', ['confirmed', seed.branchId, IDS.R_AB]);
  const confirmed = startJourney(travelAction(IDS.L2), journeyWorld(seed));
  assert.equal(confirmed.journey.position_quality, 'route_confirmed');
  seed.close();
});

/* ------------------------------------------------------------------ *
 * 2 未标定不把格数当米 / 跨帧不相减
 * ------------------------------------------------------------------ */

test('§17.3 未标定地图不把格数当米：量不出距离就报未知', async () => {
  const seed = await fixture();
  const world = { db: seed.db, branchId: seed.branchId };
  const route = queryBound(seed.db, 'SELECT * FROM routes WHERE branch_id = ? AND id = ?', [seed.branchId, 'R_UNCAL'])[0];
  assert.equal(computeTravelInterval(world, actor(world), route), null, '没有米/格就不量距离（不把 12 格当 12 米）');
  seed.close();
});

test('§17.3 同一帧的几何能量出米，跨帧的同一形状量不出 —— 不跨图相减局部坐标', async () => {
  const seed = await fixture();
  const world = { db: seed.db, branchId: seed.branchId };
  const sameFrame = queryBound(seed.db, 'SELECT * FROM routes WHERE branch_id = ? AND id = ?', [seed.branchId, 'R_SAME_FRAME'])[0];
  const crossFrame = queryBound(seed.db, 'SELECT * FROM routes WHERE branch_id = ? AND id = ?', [seed.branchId, 'R_CROSS_FRAME'])[0];

  assert.ok(computeTravelInterval(world, actor(world), sameFrame), '同一张已标定图上，几何+米/格可以给出估计路程');
  assert.equal(computeTravelInterval(world, actor(world), crossFrame), null, '一端在另一张图上时，几何长度不能当两点距离');

  const started = startJourney(travelAction(IDS.L3, { id: 'A_CROSS' }), journeyWorld(seed));
  assert.ok(started.journey, '仍可建立行程（只是时间未知）');
  assert.equal(started.journey.estimated_arrival_min_s, null, 'ETA 未知就不给数字');
  assert.ok(started.issues.some((entry) => entry.code === 'JOURNEY_ETA_UNKNOWN'), '未知要如实记账');
  seed.close();
});

/* ------------------------------------------------------------------ *
 * 3 关闭 / 访问条件变化
 * ------------------------------------------------------------------ */

test('§17.3 路关了就找不到可通行路段，不伪造绕行', async () => {
  const seed = await fixture();
  seed.db.run('UPDATE routes SET status = ? WHERE branch_id = ? AND id = ?', ['closed', seed.branchId, IDS.R_AB]);
  const started = startJourney(travelAction(IDS.L2), journeyWorld(seed));
  assert.equal(started.journey, null, '唯一的路关了，就不该建行程');
  assert.ok(started.issues.some((entry) => entry.code === 'JOURNEY_NO_ROUTE'));
  seed.close();
});

test('§17.3 行程中途封路：停在原地、不穿过去、剩余时间不推进', async () => {
  const seed = await fixture();
  const started = startJourney(travelAction(IDS.L2), journeyWorld(seed));
  const first = advanceJourney(started.journey, 100, { db: seed.db, branchId: seed.branchId });
  assert.equal(first.journey.status, 'moving');
  const distanceBefore = first.journey.segment_distance_done_m;
  assert.ok(Number(distanceBefore) > 0, '100 秒应该走出一段距离');

  seed.db.run('UPDATE routes SET status = ? WHERE branch_id = ? AND id = ?', ['closed', seed.branchId, IDS.R_AB]);
  const blocked = advanceJourney(first.journey, 4000, { db: seed.db, branchId: seed.branchId });
  assert.equal(blocked.journey.status, 'blocked', '封路后状态转 blocked');
  assert.equal(blocked.journey.stop_reason, 'route_blocked');
  assert.equal(blocked.journey.last_advanced_at_s, 100, '不许假装时间过去了（世界时钟不动）');
  assert.equal(blocked.journey.segment_distance_done_m, distanceBefore, '不穿过去，距离不增加');
  assert.ok(blocked.events.some((event) => event.kind === 'blocked' && event.secondsUsed === 0), '阻塞事件不消耗时间');
  seed.close();
});

test('§17.3 访问条件中途变化（宵禁/关卡）：当前有效通行受限，停在原地', async () => {
  const seed = await fixture();
  const world = { db: seed.db, branchId: seed.branchId };
  const started = startJourney(travelAction(IDS.L2), journeyWorld(seed));
  assert.ok(started.journey);

  // 出发后才上的门禁：世界时刻 50000 秒之前这条路不可通行。
  seed.db.run('UPDATE routes SET access_rules_json = ? WHERE branch_id = ? AND id = ?', [
    JSON.stringify({ time_at_or_after: { s: 50000 } }), seed.branchId, IDS.R_AB,
  ]);

  const denied = advanceJourney(started.journey, 60, world);
  assert.equal(denied.journey.status, 'blocked');
  assert.equal(denied.journey.stop_reason, 'route_access_denied');
  assert.equal(denied.journey.last_advanced_at_s, 0, '不让他在封路期间偷偷前进');
  assert.ok(denied.issues.some((entry) => entry.code === 'JOURNEY_ROUTE_ACCESS_DENIED'));

  // 条件成立之后才恢复：这里验证「同一规则在时刻到达后放行」，而不是永久封死。
  const allowed = advanceJourney({ ...started.journey, last_advanced_at_s: 50000, started_at_s: 50000 }, 50300, world);
  assert.equal(allowed.journey.status, 'moving', '宵禁结束后可以继续走');
  seed.close();
});

/* ------------------------------------------------------------------ *
 * 4 消息沿真实道路传播
 * ------------------------------------------------------------------ */

async function withPublicFront(seed, informationId = 'INF_RUMOR') {
  const info = createRow('information', {
    title: '城里传开的消息', content: '铁匠铺昨夜进了贼', kind: 'rumor', secrecy: 'public', status: 'active',
  }, { branchId: seed.branchId, id: informationId, turnId: seed.seedTurnId, clockS: 0, nowWallMs: 1_700_000_000_000, rulesetVersion: 'atlas-1' });
  insertRows(seed.db, 'information', [info]);
  return [{ id: 'FR_1', information_id: informationId, location_id: IDS.L1, status: 'active', next_spread_check_s: 0, first_available_at_s: 0 }];
}

test('§17.3 消息沿真实道路传播：有路、有速度、有距离才有到达时刻', async () => {
  const seed = await fixture();
  const fronts = await withPublicFront(seed);
  const scheduled = scheduleDeliveries(fronts, [], {
    db: seed.db, branchId: seed.branchId, clockS: 0, turnId: seed.seedTurnId, makeId: () => 'x',
  });
  const delivery = scheduled.tasks.find((task) => task.task_kind === 'delivery');
  assert.ok(delivery, '城里有路就该排出一条投递任务');
  assert.equal(delivery.route_id, IDS.R_AB, '走的是真实路段，不是凭空连线');
  assert.ok(delivery.distance_m > 0 && delivery.speed_mps > 0);
  assert.equal(delivery.depart_at_s, PROPAGATION_CHECK_INTERVAL_S, '按固定周期发车');
  assert.ok(delivery.arrive_at_s > delivery.depart_at_s, '到达时刻必须晚于出发');
  assert.equal(delivery.arrive_at_s - delivery.depart_at_s, delivery.distance_m / delivery.speed_mps, '耗时=距离/速度');
  seed.close();
});

test('§17.3 路关了消息也不穿过', async () => {
  const seed = await fixture();
  const fronts = await withPublicFront(seed);
  seed.db.run('UPDATE routes SET status = ? WHERE branch_id = ? AND id = ?', ['closed', seed.branchId, IDS.R_AB]);
  const scheduled = scheduleDeliveries(fronts, [], {
    db: seed.db, branchId: seed.branchId, clockS: 0, turnId: seed.seedTurnId, makeId: () => 'x',
  });
  assert.equal(scheduled.tasks.filter((task) => task.task_kind === 'delivery').length, 0, '没有可通行路段就没有投递任务');
  seed.close();
});

test('§17.3 访问条件不成立的路上不传播，并如实报码', async () => {
  const seed = await fixture();
  const fronts = await withPublicFront(seed);
  seed.db.run('UPDATE routes SET access_rules_json = ? WHERE branch_id = ? AND id = ?', [
    JSON.stringify({ time_at_or_after: { s: 999999 } }), seed.branchId, IDS.R_AB,
  ]);
  const scheduled = scheduleDeliveries(fronts, [], {
    db: seed.db, branchId: seed.branchId, clockS: 0, turnId: seed.seedTurnId, makeId: () => 'x',
  });
  assert.equal(scheduled.tasks.filter((task) => task.task_kind === 'delivery').length, 0);
  assert.ok(scheduled.issues.some((entry) => entry.code === 'PROPAGATION_ROUTE_CLOSED'));
  seed.close();
});

test('§17.3 Δt=0 不瞬移：同一时刻推进不产生距离也不到达', async () => {
  const seed = await fixture();
  const started = startJourney(travelAction(IDS.L2), journeyWorld(seed));
  const still = advanceJourney(started.journey, 0, { db: seed.db, branchId: seed.branchId });
  assert.equal(still.remainingS, 0);
  assert.equal(still.events.length, 0, '零时间没有节点事件');
  assert.equal(still.journey.segment_distance_done_m, 0, '不因「建模花了几分钟」就凭空前进');
  assert.equal(still.journey.status, 'moving');
  seed.close();
});
