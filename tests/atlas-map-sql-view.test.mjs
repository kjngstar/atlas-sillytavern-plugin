/**
 * atlas-map-sql-view.test.mjs — T26 地图 SQL 读视图、比例尺与网格（§10.2 / §10.3 / §16.9）。
 *
 * 覆盖：
 * - 左下只有一条比例尺：`computeViewportScaleBar` 是唯一标尺入口，固定条长 [64, 96]px，
 *   未标定时只报格数并写明「未标定」，绝不冒充米；
 * - 缩放只改读数：`cameraK` 翻倍 → 读数减半，`meters_per_cell` 与传入的 map 行对象都不变；
 * - 刻度候选取自 1/2/5×10^n（`computeScaleBar`），固定长度条的读数由 `formatFixedScaleDistance` 给出；
 * - 格矢量清晰：放大给更密的次网格、缩小时相反，每轴线数有界；
 * - 拖动视口只平移屏幕坐标，地点/人物行坐标逐字不变；
 * - 估计路线用虚线，`coord_precision='unknown'` 的人物不产生伪精点，只进粗定位名单；
 * - 每张子图各自标定（教室图不继承世界图的米/格）；
 * - 地图/附近/详情使用同一 revision，revision 不符时明确 stale 且清空。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, selectOne } from './fixtures/atlas-sql/seed.mjs';
import {
  SCALE_BAR_FIXED_PX,
  SCALE_BAR_FIXED_MIN_PX,
  computeScaleBar,
  computeViewportScaleBar,
  formatFixedScaleDistance,
  formatScaleReading,
} from '../src/atlas-scale.ts';
import {
  MAP_GRID_MAX_LINES_PER_AXIS,
  MAP_GRID_MAJOR_STEPS,
  getVisibleGridPaths,
  gridCameraFromMapCamera,
  gridScreenPosition,
} from '../src/atlas-map-grid.ts';
import { fitCamera, panCameraBy, setCameraZoom, worldToScreen } from '../src/atlas-map-camera.ts';
import { queryEntityDetail, queryMapView, queryNearby } from '../src/atlas-db-views.ts';

const SQL = await (await import('sql.js')).default();

const BRANCH = IDS.branchMain;
const VIEW = { width: 640, height: 480 };
const FRAME = { cols: 100, rows: 100 };
const FRAME_BOX = { minX: 0, minY: 0, maxX: 100, maxY: 100, spanX: 100, spanY: 100 };

function viewCtx(seed, revision = 0) {
  return { db: seed.db, branchId: BRANCH, revision, viewMode: 'author', povId: null };
}

/** 1/2/5×10^n（指数 -2..7）——§10.3 允许的漂亮刻度。 */
function isOneTwoFiveSeries(value) {
  if (!Number.isFinite(value) || value <= 0) return false;
  for (let exp = -2; exp <= 7; exp += 1) {
    for (const mult of [1, 2, 5]) {
      if (Math.abs(value - mult * 10 ** exp) < 1e-9) return true;
    }
  }
  return false;
}

function snapshotCoordinateRows(seed) {
  const locations = seed.db.exec('SELECT id, map_id, grid_x, grid_y, coord_precision FROM locations ORDER BY id');
  const characters = seed.db.exec('SELECT id, map_id, grid_x, grid_y, coord_precision FROM characters ORDER BY id');
  return JSON.stringify({ locations: locations[0].values, characters: characters[0].values });
}

/* —— T26-01 左下只有一条比例尺 —— */

test('T26-01 左下只有一条比例尺：固定条长 [64,96]px，未标定只报格数、绝不冒充米', async () => {
  const wide = computeViewportScaleBar({ cameraK: 40, metersPerCell: 100, viewportWidth: 900 });
  assert.ok(wide, '标准视口必须给出唯一那条比例尺');
  assert.equal(wide.barWidthPx, SCALE_BAR_FIXED_PX);
  assert.ok(
    wide.barWidthPx >= SCALE_BAR_FIXED_MIN_PX && wide.barWidthPx <= SCALE_BAR_FIXED_PX,
    `条长必须在 [${SCALE_BAR_FIXED_MIN_PX}, ${SCALE_BAR_FIXED_PX}]：${wide.barWidthPx}`,
  );
  assert.equal(wide.unitMode, 'meters');
  // 唯一读数来源：固定条 + formatFixedScaleDistance，不存在第二条并列标尺。
  assert.equal(wide.label, formatFixedScaleDistance(wide.distanceMeters));
  assert.equal(wide.ariaLabel, `屏幕 ${Math.round(wide.barWidthPx)} 像素约等于 ${wide.label}`);

  // 窄视口只缩短同一条尺，不会多出第二条。
  const narrow = computeViewportScaleBar({ cameraK: 40, metersPerCell: 100, viewportWidth: 100 });
  assert.equal(narrow.barWidthPx, SCALE_BAR_FIXED_MIN_PX);

  // 未标定：unitMode=cells，label 写明「未标定」，绝不冒充米。
  const uncalibrated = computeViewportScaleBar({ cameraK: 40, metersPerCell: null, viewportWidth: 900 });
  assert.equal(uncalibrated.unitMode, 'cells');
  assert.equal(uncalibrated.distanceMeters, null);
  assert.ok(uncalibrated.label.includes('未标定'), `未标定必须在读数里写明：${uncalibrated.label}`);
  assert.equal(/米|千米|厘米|毫米/.test(uncalibrated.label), false, `未标定不得显示假米数：${uncalibrated.label}`);
  assert.equal(uncalibrated.label, `约 ${formatScaleReading(uncalibrated.distanceCells)} 格 · 未标定`);
  assert.equal(uncalibrated.distanceCells, SCALE_BAR_FIXED_PX / 40);

  // 非法缩放返回 null（调用方隐藏标尺），不显示 0 长度的伪标尺。
  assert.equal(computeViewportScaleBar({ cameraK: 0, metersPerCell: 100 }), null);
  assert.equal(computeViewportScaleBar({ cameraK: Number.NaN, metersPerCell: 100 }), null);
  assert.equal(computeViewportScaleBar({ cameraK: -3, metersPerCell: 100 }), null);

  // 地图视图给出的也必须是同一个对象形状（单条尺，不是数组）。
  const seed = await makeSeedWith(SQL);
  try {
    const result = queryMapView(viewCtx(seed), { kind: 'map', branchId: BRANCH, mapId: IDS.M1 });
    const scaleBar = result.items[0].frames.scaleBar;
    assert.ok(scaleBar && !Array.isArray(scaleBar), 'frames.scaleBar 是单条尺');
    assert.equal(scaleBar.barWidthPx, SCALE_BAR_FIXED_PX);
  } finally {
    seed.close();
  }
});

/* —— T26-02 缩放比例尺值变，米/格不变 —— */

test('T26-02 缩放只改读数：cameraK 翻倍距离减半，meters_per_cell 与 map 行对象都不变', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const mapRow = selectOne(seed.db, 'maps', BRANCH, IDS.M1);
    const rowSnapshot = JSON.stringify(mapRow);
    const at40 = computeViewportScaleBar({ cameraK: 40, metersPerCell: mapRow.meters_per_cell, viewportWidth: 900 });
    const at80 = computeViewportScaleBar({ cameraK: 80, metersPerCell: mapRow.meters_per_cell, viewportWidth: 900 });
    assert.equal(at80.barWidthPx, at40.barWidthPx, '条长钉死在视口坐标系，不随缩放一起放大');
    assert.equal(at80.distanceMeters, at40.distanceMeters / 2, '放大一倍 → 同一段距离的读数减半');
    assert.equal(at80.distanceCells, at40.distanceCells / 2);
    assert.notEqual(at80.label, at40.label);
    assert.equal(JSON.stringify(mapRow), rowSnapshot, '纯函数不得修改传入的 map 行对象');

    // 视图查询也不写库：meters_per_cell 逐字不变。
    const view = queryMapView(viewCtx(seed), { kind: 'map', branchId: BRANCH, mapId: IDS.M1 });
    assert.equal(view.items[0].metersPerCell, 100);
    const stored = selectOne(seed.db, 'maps', BRANCH, IDS.M1);
    assert.equal(Number(stored.meters_per_cell), 100, '缩放只变标尺显示，绝不能改 meters_per_cell');
    assert.equal(Number(stored.calibration_rev), Number(mapRow.calibration_rev));
    assert.equal(Number(stored.scale_locked), Number(mapRow.scale_locked));
  } finally {
    seed.close();
  }
});

/* —— T26-03 刻度候选与读数 —— */

test('T26-03 刻度取自 1/2/5×10^n；固定长度条的读数由 formatFixedScaleDistance 给出', async () => {
  const combos = [
    { metersPerCell: 100, cellPx: 40, zoom: 1 },
    { metersPerCell: 100, cellPx: 40, zoom: 0.41 },
    { metersPerCell: 1, cellPx: 24, zoom: 8 },
    { metersPerCell: 0.5, cellPx: 60, zoom: 2 },
    { metersPerCell: 5000, cellPx: 8, zoom: 0.2 },
  ];
  for (const combo of combos) {
    const bar = computeScaleBar(combo);
    assert.ok(bar, `候选刻度必须存在：${JSON.stringify(combo)}`);
    assert.ok(
      isOneTwoFiveSeries(bar.distanceMeters),
      `刻度只能从 1/2/5×10^n 里选：${bar.distanceMeters}（${JSON.stringify(combo)}）`,
    );
    assert.ok(bar.barWidthPx > 0);
  }

  // 固定长度条：条长恒定，读数随缩放连续变化，单位自动换算。
  const readings = new Map([
    [5, '1.92 千米'],
    [10, '960 米'],
    [40, '240 米'],
    [160, '60 米'],
  ]);
  for (const [cameraK, expected] of readings) {
    const bar = computeViewportScaleBar({ cameraK, metersPerCell: 100, viewportWidth: 900 });
    assert.equal(bar.barWidthPx, SCALE_BAR_FIXED_PX);
    assert.equal(bar.distanceMeters, (SCALE_BAR_FIXED_PX * 100) / cameraK);
    assert.equal(bar.label, formatFixedScaleDistance(bar.distanceMeters));
    assert.equal(bar.label, expected, `读数单位必须自动选 m/km：${cameraK}`);
  }
  assert.deepEqual([...MAP_GRID_MAJOR_STEPS], [5, 25, 125]);
});

/* —— T26-04 格矢量清晰 —— */

test('T26-04 格矢量清晰：放大给更密次网格，缩小时相反，每轴线数有界', async () => {
  const fit = fitCamera(FRAME_BOX, VIEW.width, VIEW.height);
  const gridAt = (k) =>
    getVisibleGridPaths({
      viewport: VIEW,
      camera: gridCameraFromMapCamera(setCameraZoom(fit, k), VIEW.width, VIEW.height),
      frame: FRAME,
      devicePixelRatio: 1,
    });

  const dense = gridAt(40);
  const coarse = gridAt(1);
  assert.equal(dense.minorHidden, false, '明显放大时次网格可见');
  assert.equal(coarse.minorHidden, true, '缩小时次线过密则隐藏，只留主线');
  assert.ok(dense.majorStep < coarse.majorStep, `放大主线步长更小：${dense.majorStep} vs ${coarse.majorStep}`);
  assert.ok(dense.counts.vertical > coarse.counts.vertical, '放大后可见格线更多');
  assert.ok(dense.counts.horizontal > coarse.counts.horizontal);

  for (const grid of [dense, coarse]) {
    assert.ok(grid.counts.vertical <= MAP_GRID_MAX_LINES_PER_AXIS, `竖线数必须 ≤ ${MAP_GRID_MAX_LINES_PER_AXIS}`);
    assert.ok(grid.counts.horizontal <= MAP_GRID_MAX_LINES_PER_AXIS, `横线数必须 ≤ ${MAP_GRID_MAX_LINES_PER_AXIS}`);
    assert.equal(grid.counts.vertical, grid.counts.minorVertical + grid.counts.majorVertical);
    assert.equal(grid.counts.horizontal, grid.counts.minorHorizontal + grid.counts.majorHorizontal);
    assert.equal(grid.strokeWidth, 1, '线宽 1 CSS px，不随缩放变粗');
  }
  // 次线隐藏时只有主线，且主线精确落在 majorStep 整数倍上。
  assert.equal(coarse.counts.minorVertical, 0);
  assert.equal(coarse.counts.minorHorizontal, 0);
  assert.equal(coarse.columns.first % coarse.majorStep, 0);
  assert.equal(coarse.columns.last % coarse.majorStep, 0);
});

/* —— T26-05 拖动视口不改变世界坐标 —— */

test('T26-05 拖动视口只平移屏幕坐标：地点/人物 SQL 行坐标逐字不变', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const before = snapshotCoordinateRows(seed);
    const cam = setCameraZoom(fitCamera(FRAME_BOX, VIEW.width, VIEW.height), 20);
    const panned = panCameraBy(cam, 137, -42);
    const world = { x: 12.5, y: 11.25 };

    const from = worldToScreen(cam, world.x, world.y, VIEW.width, VIEW.height);
    const to = worldToScreen(panned, world.x, world.y, VIEW.width, VIEW.height);
    assert.ok(Math.abs(to.x - from.x - 137) < 1e-9, `同一世界点的屏幕位移必须等于拖动量：${to.x - from.x}`);
    assert.ok(Math.abs(to.y - from.y + 42) < 1e-9);

    // 网格相机只由相机变换派生（同一套 tx/ty），世界坐标不被平移改写。
    const gridBefore = gridCameraFromMapCamera(cam, VIEW.width, VIEW.height);
    const gridAfter = gridCameraFromMapCamera(panned, VIEW.width, VIEW.height);
    assert.equal(gridAfter.k, gridBefore.k);
    assert.ok(Math.abs(gridAfter.tx - gridBefore.tx - 137) < 1e-9);
    assert.ok(Math.abs(gridAfter.ty - gridBefore.ty + 42) < 1e-9);
    const posBefore = gridScreenPosition(gridBefore, world.x, world.y);
    const posAfter = gridScreenPosition(gridAfter, world.x, world.y);
    assert.ok(Math.abs(posAfter.x - posBefore.x - 137) < 1e-9);
    assert.ok(Math.abs(posAfter.y - posBefore.y + 42) < 1e-9);

    // 反复拖动 + 查询视图后，SQL 里的坐标逐字相等。
    for (const [dx, dy] of [[10, 10], [-25, 60], [0, -140]]) {
      panCameraBy(panned, dx, dy);
      queryMapView(viewCtx(seed), { kind: 'map', branchId: BRANCH });
    }
    assert.equal(snapshotCoordinateRows(seed), before, '拖动视口不得改写任何地点/人物坐标');
    assert.equal(Number(selectOne(seed.db, 'characters', BRANCH, IDS.C2).grid_x), 10.5);
    assert.equal(String(selectOne(seed.db, 'locations', BRANCH, IDS.L2).coord_precision), 'approximate');
  } finally {
    seed.close();
  }
});

/* —— T26-06 估计路线不给伪精点 —— */

test("T26-06 估计路线 dashed；coord_precision='unknown' 的人物不产生点，只进粗定位名单", async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const ctx = viewCtx(seed);
    const result = queryMapView(ctx, { kind: 'map', branchId: BRANCH, mapId: IDS.M1 });
    const world = result.items.find((m) => m.mapId === IDS.M1);

    const route = world.routes.find((r) => r.routeId === IDS.R_AB);
    assert.equal(route.geometryQuality, 'estimated');
    assert.equal(route.dashed, true, '估计路线必须虚线并标估计，不能画成已知真实位置');
    seed.db.run(`UPDATE routes SET geometry_quality = 'confirmed' WHERE branch_id = ? AND id = ?`, [BRANCH, IDS.R_AB]);
    const confirmed = queryMapView(ctx, { kind: 'map', branchId: BRANCH, mapId: IDS.M1 }).items[0];
    assert.equal(confirmed.routes.find((r) => r.routeId === IDS.R_AB).dashed, false, '确认路线不标虚线');
    seed.db.run(`UPDATE routes SET geometry_quality = 'estimated' WHERE branch_id = ? AND id = ?`, [BRANCH, IDS.R_AB]);
    for (const quality of ['unknown', 'estimated']) {
      seed.db.run(`UPDATE routes SET geometry_quality = ? WHERE branch_id = ? AND id = ?`, [quality, BRANCH, IDS.R_AB]);
      const view = queryMapView(ctx, { kind: 'map', branchId: BRANCH, mapId: IDS.M1 }).items[0];
      assert.equal(view.routes.find((r) => r.routeId === IDS.R_AB).dashed, true, `${quality} 也不得画成精确几何`);
    }

    // 未知坐标：C3/C4 coord_precision='unknown' → 不产生点。
    for (const id of [IDS.C3, IDS.C4]) {
      assert.equal(world.points.some((p) => p.entityId === id), false, `${id} 未知坐标不得产生伪精点`);
      const coarse = world.coarseList.find((c) => c.entityId === id);
      assert.ok(coarse, `${id} 必须留在粗定位名单里`);
      assert.equal(coarse.locationId, IDS.L1);
    }
    // 对照：有近似坐标的 C2 可以有点，但带范围与 approximate 标识。
    const approximate = world.points.find((p) => p.entityId === IDS.C2);
    assert.ok(approximate);
    assert.equal(approximate.markerQuality, 'approximate');
    assert.equal(approximate.radius, 0.25);
  } finally {
    seed.close();
  }
});

/* —— T26-07 子图独立标定 —— */

test('T26-07 子图独立标定：教室图不继承世界图的米/格', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const result = queryMapView(viewCtx(seed), { kind: 'map', branchId: BRANCH });
    const worldMap = result.items.find((m) => m.mapId === IDS.M1);
    const roomMap = result.items.find((m) => m.mapId === IDS.M2);
    assert.ok(worldMap && roomMap);
    assert.equal(worldMap.metersPerCell, 100);
    assert.equal(roomMap.metersPerCell, 1, '每张子图有自己的标定');
    assert.equal(Number(selectOne(seed.db, 'maps', BRANCH, IDS.M1).meters_per_cell), 100);
    assert.equal(Number(selectOne(seed.db, 'maps', BRANCH, IDS.M2).meters_per_cell), 1);

    assert.equal(worldMap.frames.scaleBar.unitMode, 'meters');
    assert.equal(roomMap.frames.scaleBar.unitMode, 'meters');
    assert.equal(worldMap.frames.scaleBar.label, '240 米');
    assert.equal(roomMap.frames.scaleBar.label, '2.4 米');
    assert.notEqual(roomMap.frames.scaleBar.label, worldMap.frames.scaleBar.label);
    assert.equal(
      roomMap.frames.scaleBar.distanceMeters,
      worldMap.frames.scaleBar.distanceMeters / 100,
      '教室图读数按自己的米/格算，不继承世界图比例',
    );
    assert.deepEqual(
      roomMap.frames.scaleBar,
      computeViewportScaleBar({ cameraK: 40, metersPerCell: roomMap.metersPerCell }),
    );
  } finally {
    seed.close();
  }
});

/* —— T26-08 同一 revision —— */

test('T26-08 地图/附近/详情使用同一 revision，revision 不符时明确 stale 且清空', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const ctx = viewCtx(seed, 0);
    const map = queryMapView(ctx, { kind: 'map', branchId: BRANCH, revision: 0 });
    const nearby = queryNearby(ctx, { kind: 'nearby', branchId: BRANCH, entityId: IDS.C2 });
    const detail = queryEntityDetail(ctx, { kind: 'entity', branchId: BRANCH, entityId: IDS.C1 });
    assert.equal(map.revision, 0);
    assert.equal(nearby.revision, map.revision);
    assert.equal(detail.revision, map.revision);
    assert.equal(map.branchId, BRANCH);
    assert.equal(map.metadata.stale, undefined, '同 revision 不得标 stale');
    assert.ok(map.items.length > 0 && nearby.items.length > 0 && detail.items.length > 0);

    const stale = queryMapView(ctx, { kind: 'map', branchId: BRANCH, revision: 7 });
    assert.deepEqual(stale.items, [], '修订变化时旧缓存必须失效清空，不显示旧卡片');
    assert.equal(stale.metadata.stale, true);
    assert.equal(stale.metadata.requestedRevision, 7);
    assert.equal(stale.metadata.currentRevision, 0);
    assert.equal(stale.revision, 0);
  } finally {
    seed.close();
  }
});

test(
  'T26-08b revision 不符时 queryNearby/queryEntityDetail 也必须 stale 且清空',
  async () => {
    const seed = await makeSeedWith(SQL);
    try {
      const ctx = viewCtx(seed, 0);
      const staleNearby = queryNearby(ctx, { kind: 'nearby', branchId: BRANCH, entityId: IDS.C2, revision: 7 });
      const staleDetail = queryEntityDetail(ctx, { kind: 'entity', branchId: BRANCH, entityId: IDS.C1, revision: 7 });
      assert.deepEqual(staleNearby.items, []);
      assert.equal(staleNearby.metadata.stale, true);
      assert.deepEqual(staleDetail.items, []);
      assert.equal(staleDetail.metadata.stale, true);
    } finally {
      seed.close();
    }
  },
);
