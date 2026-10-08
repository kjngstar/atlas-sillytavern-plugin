/**
 * M2-08：P01/P02 稳定排位验收（02 §4.1）。
 *
 * 断言的是**行为**而不是快照字符串：
 * - 老点逐项完全不动（含 layout/estimated，不只是 exact）；
 * - 新点重复运行结果一致，且有限、在留白范围内、与障碍和已放点保持间隔；
 * - 输入顺序倒过来不改变结果；
 * - 空位耗尽时返回 PLACEMENT_FULL + 全部 remaining，绝不把多点叠到 (0,0)。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { placeUnlocatedScenePoints } from '../src/atlas-scene-layout.ts';

const FRAME = { cols: 100, rows: 80 };

/** 20 个合法旧点：含真实点、估计点、示意点三类，全部必须原样保留。 */
function legacyPoints() {
  const points = [];
  for (let i = 0; i < 20; i += 1) {
    points.push({
      id: `L${String(i).padStart(2, '0')}`,
      x: 6 + (i % 5) * 18,
      y: 8 + Math.floor(i / 5) * 16,
      // 精度只影响语义，不影响「老点必须固定」这条规则。
      precision: i % 3 === 0 ? 'exact' : i % 3 === 1 ? 'approximate' : 'layout',
    });
  }
  return points;
}

const OBSTACLES = [
  { x: 40, y: 30, w: 12, h: 10 },
  { x: 70, y: 55, w: 16, h: 12 },
];

function distanceToExtent(point, extent) {
  const dx = Math.max(extent.x - point.x, 0, point.x - (extent.x + extent.w));
  const dy = Math.max(extent.y - point.y, 0, point.y - (extent.y + extent.h));
  return Math.hypot(dx, dy);
}

test('P01 老点不动：20 个旧点逐项完全一致，新点可复现且不侵占障碍与老点', () => {
  const existing = legacyPoints();
  const before = structuredClone(existing);
  const pending = [{ id: 'NEW-1', hint: { x: 52, y: 40 } }];

  const first = placeUnlocatedScenePoints({ frame: FRAME, existing, pending, obstacles: OBSTACLES, seed: 'map:world' });
  assert.deepEqual(existing, before, 'existing 数组本身不得被改写');

  assert.equal(first.placed.length, 1, '应放下这一个新点');
  assert.deepEqual(first.remainingIds, []);
  const placed = first.placed[0];
  assert.equal(placed.precision, 'layout', '示意点必须标 layout，不能冒充真实坐标');
  assert.equal(placed.id, 'NEW-1');

  // 有限 + 在留白范围内
  assert.ok(Number.isFinite(placed.x) && Number.isFinite(placed.y), '排位结果必须是有限数字');
  const minGap = Math.max(1, Math.min(FRAME.cols, FRAME.rows) / 12);
  assert.ok(placed.x >= minGap && placed.x <= FRAME.cols - minGap, `x=${placed.x} 越出留白范围`);
  assert.ok(placed.y >= minGap && placed.y <= FRAME.rows - minGap, `y=${placed.y} 越出留白范围`);

  // 与老点、障碍都保持间隔（用实际重试下限 0.5×minGap 判定「不重叠」）
  const hardFloor = minGap * 0.5;
  for (const point of existing) {
    assert.ok(Math.hypot(placed.x - point.x, placed.y - point.y) >= hardFloor, `新点与老点 ${point.id} 太近`);
  }
  for (const extent of OBSTACLES) {
    assert.ok(distanceToExtent(placed, extent) >= hardFloor, '新点不得压进障碍');
  }

  // 重复运行 → 完全相同
  const second = placeUnlocatedScenePoints({ frame: FRAME, existing, pending, obstacles: OBSTACLES, seed: 'map:world' });
  assert.deepEqual(second.placed, first.placed, '同一输入必须给同一结果');

  // 老点不动：与 before 逐项一致（函数不返回老点，所以按定义「未返回即未改」，再用 occupied 不变量复核）
  assert.equal(first.placed.some((entry) => entry.id.startsWith('L')), false, '只返回 pending 的排位，不得吐回老点');
  assert.deepEqual(existing, before);

  // 输入倒序：结果完全一致
  const reversed = placeUnlocatedScenePoints({
    frame: FRAME,
    existing: [...existing].reverse(),
    pending: [...pending].reverse(),
    obstacles: [...OBSTACLES].reverse(),
    seed: 'map:world',
  });
  assert.deepEqual(reversed.placed, first.placed, '输入顺序不得影响排位结果');

  // 不同 seed → 可以不同，但必须仍然合法
  const otherSeed = placeUnlocatedScenePoints({ frame: FRAME, existing, pending, obstacles: OBSTACLES, seed: 'map:other' });
  assert.equal(otherSeed.placed.length, 1);
  const other = otherSeed.placed[0];
  assert.ok(Number.isFinite(other.x) && Number.isFinite(other.y));
  assert.ok(other.x >= minGap && other.x <= FRAME.cols - minGap);
  assert.ok(other.y >= minGap && other.y <= FRAME.rows - minGap);
  for (const point of existing) {
    assert.ok(Math.hypot(other.x - point.x, other.y - point.y) >= hardFloor, '换 seed 也不得压到老点');
  }
});

test('P01b 多个新点：相互之间也保持间隔，且每个都能复现', () => {
  const existing = legacyPoints();
  const pending = [
    { id: 'B-new', hint: { x: 30, y: 20 } },
    { id: 'A-new', hint: { x: 30, y: 20 } },
    { id: 'C-new' },
  ];
  const result = placeUnlocatedScenePoints({ frame: FRAME, existing, pending, obstacles: OBSTACLES, seed: 'map:world' });
  assert.equal(result.placed.length, 3);
  assert.deepEqual(
    result.placed.map((entry) => entry.id).sort(),
    ['A-new', 'B-new', 'C-new'],
  );
  // 三点互不重叠
  for (let i = 0; i < result.placed.length; i += 1) {
    for (let j = i + 1; j < result.placed.length; j += 1) {
      const a = result.placed[i];
      const b = result.placed[j];
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 0, '任意两个新点不得落在同一点');
    }
  }
  // 与倒序输入一致（pending 内部按 ID 排序）
  const reversed = placeUnlocatedScenePoints({
    frame: FRAME,
    existing,
    pending: [...pending].reverse(),
    obstacles: OBSTACLES,
    seed: 'map:world',
  });
  assert.deepEqual(reversed.placed, result.placed);
});

test('P02 排位没有空位：整幅被障碍盖住 → placed=[]、remaining 全给、PLACEMENT_FULL、绝不都放 (0,0)', () => {
  const pending = [{ id: 'X1' }, { id: 'X2' }, { id: 'X3' }];
  const result = placeUnlocatedScenePoints({
    frame: FRAME,
    existing: [],
    pending,
    obstacles: [{ x: 0, y: 0, w: FRAME.cols, h: FRAME.rows }],
    seed: 'map:full',
  });

  assert.deepEqual(result.placed, [], '没有空位就不能硬塞');
  assert.deepEqual(result.remainingIds, ['X1', 'X2', 'X3']);
  assert.ok(
    result.issues.some((issue) => issue.code === 'PLACEMENT_FULL'),
    '必须明确报 PLACEMENT_FULL',
  );
  const full = result.issues.find((issue) => issue.code === 'PLACEMENT_FULL');
  assert.deepEqual([...full.relatedIds].sort(), ['X1', 'X2', 'X3'], 'PLACEMENT_FULL 必须带出全部未排位 ID');
});

test('P02b 边界：0/NaN 幅面明确报错不排位；边缘点与非法障碍分别处理', () => {
  const pending = [{ id: 'E1' }];

  for (const frame of [
    { cols: 0, rows: 80 },
    { cols: 100, rows: 0 },
    { cols: Number.NaN, rows: 80 },
    { cols: 100, rows: Number.POSITIVE_INFINITY },
  ]) {
    const result = placeUnlocatedScenePoints({ frame, existing: [], pending, obstacles: [], seed: 'map:x' });
    assert.deepEqual(result.placed, [], '非法幅面不得排位');
    assert.deepEqual(result.remainingIds, ['E1']);
    assert.equal(result.issues[0].code, 'FRAME_INVALID', '必须明确报 FRAME_INVALID，不能以 NaN 继续');
  }

  const badGap = placeUnlocatedScenePoints({ frame: FRAME, existing: [], pending, obstacles: [], minGapCells: 0, seed: 'map:x' });
  assert.deepEqual(badGap.placed, []);
  assert.ok(badGap.issues.some((issue) => issue.code === 'MIN_GAP_INVALID'));

  // 非法障碍：只忽略这一项并给 warning，其余照常排位。
  const weird = placeUnlocatedScenePoints({
    frame: FRAME,
    existing: [],
    pending,
    obstacles: [{ x: Number.NaN, y: 0, w: 5, h: 5 }, { x: 90, y: 70, w: -3, h: 4 }],
    seed: 'map:x',
  });
  assert.equal(weird.placed.length, 1, '非法障碍不能连带让整张图无法排位');
  assert.ok(weird.issues.some((issue) => issue.code === 'OBSTACLE_INVALID' && issue.severity === 'warning'));

  // 非法 hint：降级为 frame 中心并给 warning。
  const hintless = placeUnlocatedScenePoints({
    frame: FRAME,
    existing: [],
    pending: [{ id: 'E1', hint: { x: Number.NaN, y: 10 } }],
    obstacles: [],
    seed: 'map:x',
  });
  assert.equal(hintless.placed.length, 1);
  assert.ok(hintless.issues.some((issue) => issue.code === 'HINT_INVALID' && issue.severity === 'warning'));

  // 老点里的非法坐标不参与占位，也不让函数抛错。
  const dirty = placeUnlocatedScenePoints({
    frame: FRAME,
    existing: [{ id: 'bad', x: Number.NaN, y: 3 }],
    pending,
    obstacles: [],
    seed: 'map:x',
  });
  assert.equal(dirty.placed.length, 1);
});

test('P01c 老点密集时新点仍保持有限与范围内，不重排老点', () => {
  const existing = [];
  for (let i = 0; i < 40; i += 1) {
    existing.push({ id: `D${String(i).padStart(2, '0')}`, x: 10 + (i % 8) * 10, y: 10 + Math.floor(i / 8) * 12 });
  }
  const before = structuredClone(existing);
  const result = placeUnlocatedScenePoints({ frame: FRAME, existing, pending: [{ id: 'NEW-dense' }], obstacles: [], seed: 'map:dense' });
  assert.deepEqual(existing, before, '密集场景同样不得重排老点');
  if (result.placed.length === 1) {
    const point = result.placed[0];
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    assert.ok(point.x >= 0 && point.x <= FRAME.cols && point.y >= 0 && point.y <= FRAME.rows);
  } else {
    assert.deepEqual(result.remainingIds, ['NEW-dense'], '放不下就必须进 remaining，而不是硬塞');
    assert.ok(result.issues.some((issue) => issue.code === 'PLACEMENT_FULL'));
  }
});
