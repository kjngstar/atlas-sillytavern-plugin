/**
 * atlas-sim-motion.test.mjs — T17 行程推进与位置解析（§18.3 T17 / §9.3 / §16.7 / §12 数值核对例）。
 *
 * §18.3 要求本文件覆盖的断言：A-B-C 节点顺序、review 停留 120 秒、暂停不前进、
 * 无时间不动、无标定 ETA 未知、载具内部人跟随。
 * 被测模块：src/atlas-sim-motion.ts（startJourney / advanceJourney / estimatedArrival /
 * selectMobility / MOVEMENT_SPEED_PRESETS / NODE_REVIEW_DWELL_S / nextNodeBoundary）
 * 与 src/atlas-sim-position.ts（resolveEffectivePosition）。
 *
 * 世界来自 §18.1 合成夹具（tests/fixtures/atlas-sql/seed.mjs，未修改）：
 * L1 城市 —(R_AB 12km)— L2 学校，C2 信使步行名义速度固定 6km/h；本文件按 §18.1 的
 * 「A—B路12km、B—C路8km」在测试内补一条 L2→L3 8000m 的 R_BC，使 A—B—C 可走。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, insertRows, WALK_MPS } from './fixtures/atlas-sql/seed.mjs';
import {
  startJourney,
  advanceJourney,
  estimatedArrival,
  nextNodeBoundary,
  selectMobility,
  MOVEMENT_SPEED_PRESETS,
  NODE_REVIEW_DWELL_S,
} from '../src/atlas-sim-motion.ts';
import { resolveEffectivePosition, buildPositionCache } from '../src/atlas-sim-position.ts';

const SQL = await (await import('sql.js')).default();

const AB_M = 12000; // §12：A—B 12km
const BC_M = 8000; // §12：B—C 8km
const AB_S = AB_M / WALK_MPS; // 7200s（08:00 → 10:00）
const BC_S = BC_M / WALK_MPS; // 4800s
const TOTAL_S = AB_S + BC_S; // 12000s
const UNKNOWN_LOCATION_ID = 'L9';

/** 测试内补的 B—C 路段（夹具只含 A—B；§18.1 的设定里有 8km 的这一段）。 */
const ROUTE_BC = {
  branch_id: IDS.branchMain,
  id: IDS.R_BC,
  row_rev: 1,
  created_turn_id: IDS.seedTurn,
  updated_turn_id: IDS.seedTurn,
  from_location_id: IDS.L2,
  to_location_id: IDS.L3,
  kind: 'road',
  bidirectional: 1,
  map_id: IDS.M1,
  geometry_json: null,
  geometry_quality: 'estimated',
  geometry_rev: 1,
  distance_m: BC_M,
  distance_min_m: BC_M,
  distance_max_m: BC_M,
  distance_basis: 'narrative',
  terrain: 'road',
  allowed_modes_json: '["walk","ride"]',
  access_rules_json: null,
  travel_time_override_json: null,
  status: 'open',
  status_reason: '',
};

function travelAction(id, stopPolicy, destinationId) {
  return {
    branch_id: IDS.branchMain,
    id,
    row_rev: 1,
    created_turn_id: IDS.seedTurn,
    updated_turn_id: IDS.seedTurn,
    actor_entity_id: IDS.C2,
    parent_action_id: null,
    kind: 'travel',
    title: '赶路',
    intent: '',
    target_entity_id: null,
    target_location_id: destinationId,
    target_event_id: null,
    trigger_json: null,
    depends_on_json: '[]',
    payload_json: JSON.stringify({ stop_policy: stopPolicy }),
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
    status: 'ready',
    reason_code: null,
    result_event_id: null,
  };
}

/** 种子世界 + B—C 路段 + 一条 ready 的 travel 行动；调用方负责 try/finally 关闭句柄。 */
async function makeWorld({ actionId, stopPolicy, destinationId = IDS.L3, beforeAction } = {}) {
  const seed = await makeSeedWith(SQL);
  insertRows(seed.db, 'routes', [ROUTE_BC]);
  if (beforeAction) beforeAction(seed.db);
  const action = travelAction(actionId, stopPolicy, destinationId);
  insertRows(seed.db, 'actions', [action]);
  const world = {
    db: seed.db,
    branchId: IDS.branchMain,
    clockS: 0,
    makeId: (kind, opId, alias) => `${kind}_${opId}_${alias}`,
    turnId: IDS.seedTurn,
  };
  return { seed, world, action };
}

test('T17-01 A—B—C 节点顺序：L2 在 7200 秒被到达，再依次到 L3，不跳节点', async () => {
  const { seed, world, action } = await makeWorld({ actionId: 'A_ORDER', stopPolicy: 'continue' });
  try {
    const started = startJourney(action, world);
    assert.deepEqual(started.issues, []);
    const journey = started.journey;
    assert.ok(journey, 'ready 且条件成立的 travel 行动必须建立行程');
    const segments = JSON.parse(String(journey.segments_json));
    assert.deepEqual(
      segments.map((s) => [s.fromLocationId, s.toLocationId]),
      [[IDS.L1, IDS.L2], [IDS.L2, IDS.L3]],
      '路线必须是 A→B→C 两段（不伪造直连道路）',
    );
    assert.equal(segments[0].distanceNominalM, AB_M);
    assert.equal(segments[1].distanceNominalM, BC_M);
    assert.ok(Math.abs(AB_S - 7200) < 1e-9, `12km / 6km/h 应恰好 7200s，实际 ${AB_S}`);
    assert.ok(Math.abs(TOTAL_S - 12000) < 1e-9, `总时长应为 7200 + 8000/speed = 12000s，实际 ${TOTAL_S}`);

    // 下一个节点边界必须是 B，而不是直接给终点。
    const boundary = nextNodeBoundary(journey);
    assert.equal(boundary.toLocationId, IDS.L2);
    assert.equal(boundary.atS, AB_S);
    assert.equal(boundary.routeId, IDS.R_AB);

    const eta = estimatedArrival(journey, 0);
    assert.equal(eta.minS, TOTAL_S);
    assert.equal(eta.maxS, TOTAL_S);
    assert.equal(eta.quality, 'estimated');

    // 一次推进到终点：事件按时间顺序，B 节点没有被跳过。
    const advanced = advanceJourney(journey, 20000, world);
    assert.deepEqual(
      advanced.events.map((e) => [e.kind, e.locationId, e.atS, e.secondsUsed]),
      [
        ['node_reached', IDS.L2, AB_S, AB_S],
        ['arrived', IDS.L3, TOTAL_S, BC_S],
      ],
    );
    const times = advanced.events.map((e) => e.atS);
    assert.deepEqual(times, [...times].sort((a, b) => a - b), '节点事件必须按时间先后排列');
    assert.ok(
      advanced.events.findIndex((e) => e.kind === 'node_reached') < advanced.events.findIndex((e) => e.kind === 'arrived'),
      'B 节点必须在 C 到达之前产生',
    );
    assert.equal(advanced.journey.status, 'arrived');
    assert.equal(advanced.journey.arrived_at_s, TOTAL_S);
    assert.equal(advanced.journey.last_reached_location_id, IDS.L3);
    assert.equal(advanced.journey.segment_index, segments.length);
    assert.equal(advanced.remainingS, 20000 - TOTAL_S);
    assert.deepEqual(advanced.issues, []);
  } finally {
    seed.close();
  }
});

test('T17-02 review 停留 120 秒：§12 数值例（+1h→6km、Δt=0 不变、+75min 停在 B 剩 13 分钟）', async () => {
  const { seed, world, action } = await makeWorld({ actionId: 'A_REVIEW', stopPolicy: 'review' });
  try {
    const started = startJourney(action, world);
    assert.deepEqual(started.issues, []);
    const journey = started.journey;

    // §12 第 2 步：一轮正文经过 1 小时 → 09:00，走了 6km，仍在 A—B 路上。
    const atOneHour = advanceJourney(journey, 3600, world);
    assert.equal(atOneHour.journey.segment_distance_done_m, 6000, '步行 6km/h × 3600s = 6000m');
    assert.equal(atOneHour.journey.segment_time_done_s, 3600);
    assert.equal(atOneHour.journey.last_advanced_at_s, 3600);
    assert.equal(atOneHour.journey.status, 'moving');
    assert.deepEqual(atOneHour.events, [], '还在路上，不应产生节点事件');
    assert.equal(atOneHour.remainingS, 0);

    // §12 第 3 步：两楼短对话均 Δt=0 → 仍是 09:00，进度不变。
    const idleA = advanceJourney(atOneHour.journey, 3600, world);
    const idleB = advanceJourney(idleA.journey, 3600, world);
    assert.equal(idleA.journey.segment_distance_done_m, 6000);
    assert.equal(idleB.journey.segment_distance_done_m, 6000);
    assert.equal(idleB.journey.last_advanced_at_s, 3600);

    // §12 第 4/5 步：再过 75 分钟（到 10:15 = 8100s）→ 先 10:00（7200s）抵达 B，再扣 120s 节点观察。
    const later = advanceJourney(idleB.journey, 3600 + 75 * 60, world);
    assert.equal(NODE_REVIEW_DWELL_S, 120, '§16.7：review 默认节点观察 120 秒');
    assert.deepEqual(
      later.events.map((e) => [e.kind, e.locationId, e.atS, e.secondsUsed]),
      [
        ['node_reached', IDS.L2, AB_S, 3600],
        ['review_dwell', IDS.L2, AB_S, NODE_REVIEW_DWELL_S],
      ],
    );
    assert.equal(later.remainingS, 780, '停留后本轮剩余 13 分钟 = 780 秒');
    assert.equal(later.journey.status, 'paused', '到达 B 后停下等调用方决定，不能继续走');
    assert.equal(later.journey.stop_location_id, IDS.L2);
    assert.equal(later.journey.stop_reason, 'review');

    // §12 第 6 步：绝不能被推进到 10:15 又走 1.5km 去 C。
    assert.equal(later.journey.last_advanced_at_s, 3600 + 3600 + NODE_REVIEW_DWELL_S, '时钟停在 10:02');
    assert.ok(later.journey.last_advanced_at_s < 3600 + 75 * 60, '不得直接推到本轮结束时刻');
    assert.equal(later.journey.segment_index, 1, '停在 B 之后的下一段（B—C）');
    assert.equal(later.journey.segment_time_done_s, 0, '去 C 的那一段一秒都没有开始');
    assert.equal(later.journey.segment_distance_done_m, null);
    assert.deepEqual(later.issues, []);
  } finally {
    seed.close();
  }
});

test('T17-03 暂停不前进：paused 行程再推进 Δt 也不增加距离', async () => {
  const { seed, world, action } = await makeWorld({ actionId: 'A_PAUSE', stopPolicy: 'review' });
  try {
    const started = startJourney(action, world);
    const atOneHour = advanceJourney(started.journey, 3600, world);
    // 在 A—B 中途暂停：距离必须冻结在 6000m，时刻冻结在 3600s。
    const pausedMid = { ...atOneHour.journey, status: 'paused', stop_reason: 'manual', stop_location_id: IDS.L1 };
    const advancedMid = advanceJourney(pausedMid, 100000, world);
    assert.equal(advancedMid.journey.segment_distance_done_m, pausedMid.segment_distance_done_m, '暂停期间距离不变');
    assert.equal(advancedMid.journey.last_advanced_at_s, pausedMid.last_advanced_at_s, '暂停期间世界时刻不前进');
    assert.equal(advancedMid.journey.status, 'paused');
    assert.deepEqual(advancedMid.events, []);
    assert.equal(advancedMid.remainingS, 100000 - pausedMid.last_advanced_at_s, '整段余额留给其它事务');

    // 已在 B 停留的行程同样不能一边停留一边继续累加去 C 的距离（§12 第 6 步）。
    const stoppedAtB = advanceJourney(atOneHour.journey, 3600 + 75 * 60, world);
    assert.equal(stoppedAtB.journey.status, 'paused');
    assert.equal(stoppedAtB.journey.stop_location_id, IDS.L2);
    const afterStop = advanceJourney(stoppedAtB.journey, 99999, world);
    assert.equal(afterStop.journey.last_advanced_at_s, stoppedAtB.journey.last_advanced_at_s);
    assert.equal(afterStop.journey.segment_index, stoppedAtB.journey.segment_index);
    assert.equal(afterStop.journey.segment_time_done_s, 0);
    assert.equal(afterStop.journey.segment_distance_done_m, null, 'B—C 段不得凭空产生距离');
    assert.deepEqual(afterStop.events, []);
  } finally {
    seed.close();
  }
});

test('T17-04 无时间不动：Δt=0 时行程逐字节相同（无位移、无停留）', async () => {
  const { seed, world, action } = await makeWorld({ actionId: 'A_ZERO', stopPolicy: 'review' });
  try {
    const started = startJourney(action, world);
    // 起点处 Δt=0：完全不动。
    const atStart = advanceJourney(started.journey, 0, world);
    assert.equal(atStart.journey.segment_distance_done_m, 0);
    assert.equal(JSON.stringify(atStart.journey), JSON.stringify(started.journey), 'Δt=0 必须逐字节不变');
    assert.deepEqual(atStart.events, []);
    assert.equal(atStart.remainingS, 0);

    // 途中 Δt=0：距离值必须逐字节相同（6000m 不变），也不产生停留。
    const atOneHour = advanceJourney(started.journey, 3600, world);
    const idle = advanceJourney(atOneHour.journey, 3600, world);
    assert.equal(idle.journey.segment_distance_done_m, atOneHour.journey.segment_distance_done_m);
    assert.equal(idle.journey.segment_distance_done_m, 6000);
    assert.equal(JSON.stringify(idle.journey), JSON.stringify(atOneHour.journey), 'Δt=0 必须逐字节不变');
    assert.deepEqual(idle.events, [], '零时间不产生节点停留');
    assert.equal(idle.remainingS, 0);
  } finally {
    seed.close();
  }
});

test('T17-05 无标定 ETA 未知：null 距离 + null 速度不捏造进度与到达时刻', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    // 未标定的新地点：没有地图、没有坐标、路段没有距离与几何。
    insertRows(seed.db, 'entity_keys', [{ branch_id: IDS.branchMain, id: UNKNOWN_LOCATION_ID, kind: 'location' }]);
    insertRows(seed.db, 'locations', [
      {
        branch_id: IDS.branchMain, id: UNKNOWN_LOCATION_ID, row_rev: 1,
        created_turn_id: IDS.seedTurn, updated_turn_id: IDS.seedTurn,
        name: '无名渡口', aliases_json: '[]', kind: 'natural', description: '', parent_location_id: null,
        mobility: 'fixed', anchor_location_id: null, map_id: null, grid_x: null, grid_y: null,
        coord_precision: 'unknown', uncertainty_radius_cells: null, area_geometry_json: null, terrain: 'unknown',
        access_rules_json: null, vehicle_profile_json: null, existence_quality: 'inferred', status: 'active', merged_into_id: null,
      },
    ]);
    insertRows(seed.db, 'routes', [
      {
        branch_id: IDS.branchMain, id: 'R_UNKNOWN', row_rev: 1,
        created_turn_id: IDS.seedTurn, updated_turn_id: IDS.seedTurn,
        from_location_id: IDS.L1, to_location_id: UNKNOWN_LOCATION_ID, kind: 'estimated', bidirectional: 1, map_id: null,
        geometry_json: null, geometry_quality: 'unknown', geometry_rev: 1,
        distance_m: null, distance_min_m: null, distance_max_m: null, distance_basis: 'unknown',
        terrain: 'unknown', allowed_modes_json: '["walk"]', access_rules_json: null, travel_time_override_json: null,
        status: 'open', status_reason: '',
      },
    ]);
    const action = travelAction('A_UNKNOWN', 'continue', UNKNOWN_LOCATION_ID);
    insertRows(seed.db, 'actions', [action]);
    const world = {
      db: seed.db, branchId: IDS.branchMain, clockS: 0,
      makeId: (kind, opId, alias) => `${kind}_${opId}_${alias}`, turnId: IDS.seedTurn,
    };

    const started = startJourney(action, world);
    assert.ok(started.journey, '无距离依据仍保留在途状态，不是拒绝建立行程');
    assert.ok(
      started.issues.some((i) => i.code === 'JOURNEY_ETA_UNKNOWN'),
      `必须明确记下 ETA 未知，实际 ${JSON.stringify(started.issues)}`,
    );
    assert.equal(started.journey.estimated_arrival_min_s, null);
    assert.equal(started.journey.estimated_arrival_max_s, null);
    assert.equal(started.journey.position_quality, 'unlocated');
    assert.deepEqual(estimatedArrival(started.journey, 0), { minS: null, maxS: null, quality: 'unknown' });
    assert.equal(nextNodeBoundary(started.journey), null, '无依据时不给「下一个节点时刻」');

    // 直接构造同形状的段：距离与速度都是 null → ETA 未知，而不是 0 秒到达。
    const segmentOnly = {
      id: 'J', status: 'moving', started_at_s: 0, last_advanced_at_s: 0, segment_time_done_s: 0, segment_index: 0,
      segments_json: JSON.stringify([
        { toLocationId: IDS.L3, distanceNominalM: null, distanceMinM: null, distanceMaxM: null, speedNominalMps: null, speedMinMps: null, speedMaxMps: null, quality: 'unknown' },
      ]),
    };
    assert.deepEqual(estimatedArrival(segmentOnly, 0), { minS: null, maxS: null, quality: 'unknown' });
    assert.equal(nextNodeBoundary(segmentOnly), null);

    // 推进只累计经过时间，不伪造进度、坐标或到达事件。
    const advanced = advanceJourney(started.journey, 3600, world);
    assert.equal(advanced.journey.status, 'moving');
    assert.equal(advanced.journey.segment_distance_done_m, 0, '不得为了 UI 有进度捏造距离');
    assert.equal(advanced.journey.segment_index, 0, '未解析的路段不得被越过');
    assert.deepEqual(advanced.events, []);
    assert.ok(
      advanced.issues.some((i) => i.code === 'JOURNEY_PROGRESS_UNKNOWN'),
      `必须记录进度未知，实际 ${JSON.stringify(advanced.issues)}`,
    );
    assert.deepEqual(estimatedArrival(advanced.journey, 3600), { minS: null, maxS: null, quality: 'unknown' });
    assert.equal(nextNodeBoundary(advanced.journey), null);
  } finally {
    seed.close();
  }
});

test('T17-06 载具内部人跟随：在途乘客随车解析，停车后回到车厢粗位置（不复制世界坐标）', async () => {
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
        mobility: 'mobile', anchor_location_id: null, map_id: IDS.M1, grid_x: 10, grid_y: 10, coord_precision: 'approximate',
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
    // 乘客 C1 的位置就是「马车里的车厢」，自己没有世界坐标（§12：不给每个乘客复制坐标）。
    seed.db.run(
      `UPDATE characters SET location_id = 'V1C', map_id = NULL, grid_x = NULL, grid_y = NULL WHERE branch_id = ? AND id = ?`,
      [IDS.branchMain, IDS.C1],
    );
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

    // 载具有行程：乘客解析为 in_transit，并带上载具的行程 id（不是车厢/世界坐标）。
    const moving = resolveEffectivePosition(world, IDS.C1);
    assert.equal(moving.kind, 'in_transit', '马车在途时乘客必须随车解析');
    assert.equal(moving.journeyId, 'VJ1', '必须给出载具的行程 id');
    assert.equal(moving.fromId, IDS.L1);
    assert.equal(moving.toId, IDS.L2);
    assert.deepEqual(resolveEffectivePosition(world, IDS.C1, undefined, buildPositionCache(world)), moving, '批量缓存与逐行读取一致');

    // 载具停下（行程结束）：乘客回到车厢这个容器地点，绝不复制载具的世界坐标。
    seed.db.run(`UPDATE journeys SET status = 'arrived', arrived_at_s = 400, stop_location_id = NULL WHERE id = 'VJ1'`);
    const parked = resolveEffectivePosition(world, IDS.C1);
    assert.equal(parked.kind, 'at_location');
    assert.equal(parked.locationId, 'V1C', '停车后乘客属于车厢（粗位置），不是车厢外的世界点');
    assert.equal(parked.precision, 'coarse');
    assert.notEqual(parked.kind, 'at_grid');

    // 对照：载具自身仍有自己的世界坐标——乘客不复制它。
    const vehicle = resolveEffectivePosition(world, 'V1');
    assert.deepEqual(
      [vehicle.kind, vehicle.mapId, vehicle.x, vehicle.y],
      ['at_grid', IDS.M1, 10, 10],
      '车厢/载具的世界坐标只属于载具，不属于乘客',
    );
  } finally {
    seed.close();
  }
});

test('T17-07 传送没有速度值；selectMobility 不授予人物未具备的移动方式', () => {
  assert.equal(MOVEMENT_SPEED_PRESETS.teleport, null, '§16.7：传送没有速度值，不得用无限速度');
  assert.equal(MOVEMENT_SPEED_PRESETS.custom, null);
  for (const mode of ['walk', 'ride', 'ground_vehicle', 'water', 'flight', 'flight_narrative_aircraft']) {
    const preset = MOVEMENT_SPEED_PRESETS[mode];
    assert.ok(preset && preset.min_mps <= preset.nominal_mps && preset.nominal_mps <= preset.max_mps, `${mode} 预设区间必须有序`);
  }

  // 只有步行能力的人请求飞行：仍走 walk，且绝不返回飞机速度。
  const walker = {
    mobility_profiles_json: JSON.stringify([{ key: 'walk', label: '步行', mode: 'walk', enabled: true, speed_basis: 'preset' }]),
  };
  const requested = selectMobility(walker, { terrain: 'road', allowed_modes_json: ['walk', 'flight'] }, { mode: 'flight' });
  assert.equal(requested.mode, 'walk', '没有 flight 能力就不给 flight');
  assert.ok(
    requested.issues.some((i) => i.code === 'MOBILITY_MODE_UNAVAILABLE'),
    `必须说明不具备该方式，实际 ${JSON.stringify(requested.issues)}`,
  );
  assert.ok(
    requested.nominalMps <= MOVEMENT_SPEED_PRESETS.flight.min_mps,
    `不得授予飞行/飞机速度，实际 ${requested.nominalMps}`,
  );

  // 完全没有 MobilityProfile 的人物不自动获得任何移动方式。
  assert.equal(selectMobility({ mobility_profiles_json: '[]' }, { terrain: 'road' }, { mode: 'walk' }), null);
  assert.equal(selectMobility({}, { terrain: 'road' }, { mode: 'walk' }), null);

  // 明确具备传送：返回 0 速度 + 显式说明，由条件/准备耗时代替速度。
  const teleporter = { mobility_profiles_json: JSON.stringify([{ key: 'tp', mode: 'teleport', enabled: true }]) };
  const teleport = selectMobility(teleporter, { terrain: 'road' }, { mode: 'teleport' });
  assert.equal(teleport.mode, 'teleport');
  assert.deepEqual([teleport.minMps, teleport.nominalMps, teleport.maxMps], [0, 0, 0]);
  assert.equal(teleport.terrainMultiplier, 1, '传送不套地面地形乘数');
  assert.ok(teleport.issues.some((i) => i.code === 'TELEPORT_NO_SPEED'), JSON.stringify(teleport.issues));
});
