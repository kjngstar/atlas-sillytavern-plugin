/**
 * atlas-spatial-facts.test.mjs — P07 §13.1/§13.2 基础空间属性与统一投影。
 *
 * 覆盖：玻璃与实墙不同、门状态区分、未知不猜、跨图必须显式变换、
 * 两个角色共享同一份物理事实却拿到不同投影。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectSpatialFacts,
  projectSpatialFactsForActor,
  resolveSpatialTrait,
  transformPointBetweenMaps,
} from '../src/atlas-spatial-facts.ts';

const trait = (overrides = {}) => ({ objectId: 'O1', kind: 'wall', material: 'solid', ...overrides });

// ---------------------------------------------------------------------------
// §13.2 真值表
// ---------------------------------------------------------------------------

test('P07 §13.2: 实墙挡路也挡视线', () => {
  const wall = resolveSpatialTrait(trait());
  assert.equal(wall.blocksMovement, true);
  assert.equal(wall.blocksSight, true);
});

test('P07 §13.2: 完整玻璃隔断挡路但可透视，不等同可穿越', () => {
  const glass = resolveSpatialTrait(trait({ kind: 'glass', material: 'glass' }));
  assert.equal(glass.blocksMovement, true, '玻璃不能穿过去');
  assert.equal(glass.blocksSight, false, '但能看见');
});

test('P07 §13.2: 玻璃材质的墙同样可透视', () => {
  const wall = resolveSpatialTrait(trait({ kind: 'wall', material: 'glass' }));
  assert.equal(wall.blocksMovement, true);
  assert.equal(wall.blocksSight, false);
});

test('P07 §13.2: 打开的门不挡路，关闭的门挡路但可尝试开', () => {
  const open = resolveSpatialTrait(trait({ kind: 'door', openingState: 'open' }));
  assert.equal(open.blocksMovement, false);
  const closed = resolveSpatialTrait(trait({ kind: 'door', openingState: 'closed' }));
  assert.equal(closed.blocksMovement, true, '关闭挡路');
  assert.equal(closed.locked, null, '没档案就不假装知道锁没锁');
});

test('P07 §13.2: 上锁的门仍保留锁状态，不因为是门就放行', () => {
  const locked = resolveSpatialTrait(trait({ kind: 'door', openingState: 'closed', locked: true }));
  assert.equal(locked.locked, true);
  assert.equal(locked.blocksMovement, true);
});

test('P07 §13.2: 门状态未知 → 挡不挡路也未知（不自动放行）', () => {
  const unknown = resolveSpatialTrait(trait({ kind: 'door' }));
  assert.equal(unknown.blocksMovement, null);
  assert.equal(unknown.blocksSight, null);
});

test('P07 §13.2: 窗户可透视，但开窗不默认能走人', () => {
  const window = resolveSpatialTrait(trait({ kind: 'window', material: 'glass', openingState: 'open' }));
  assert.equal(window.blocksSight, false);
  assert.equal(window.blocksMovement, true, '开窗不等于门');
});

test('P07 §13.2: 高大家具按占地判遮挡；占地小也不等于一定不挡', () => {
  const big = resolveSpatialTrait(trait({ kind: 'furniture', material: 'wood', footprintCells: 6 }));
  assert.equal(big.blocksMovement, true);
  assert.equal(big.blocksSight, true);
  const small = resolveSpatialTrait(trait({ kind: 'furniture', material: 'wood', footprintCells: 1 }));
  assert.equal(small.blocksMovement, true, '家具都占地');
  assert.equal(small.blocksSight, null, '占地小推不出高度：不确定就是 null，不写 false 假装看清了');
  const unknown = resolveSpatialTrait(trait({ kind: 'furniture' }));
  assert.equal(unknown.blocksSight, null, '没有占地信息就不猜高度');
});

test('P07 §13.2: 材质与状态不明确 → unknown，不从名字或颜色硬猜', () => {
  const unknown = resolveSpatialTrait({ objectId: 'O9', kind: 'other', material: 'transparent-looking' });
  assert.equal(unknown.material, 'unknown', '非法材质降为 unknown');
  assert.equal(unknown.blocksMovement, null);
  assert.equal(unknown.blocksSight, null);
  assert.equal(unknown.source, 'unknown');
});

test('P07 §13.2: 没有渲染透明度的入口——opacity 不是空间属性', () => {
  const wall = resolveSpatialTrait(trait({ kind: 'wall', material: 'solid', opacity: 0.1 }));
  assert.equal(wall.blocksSight, true, '配色透明度不影响遮挡判定');
});

// ---------------------------------------------------------------------------
// §13.1 事实构建器
// ---------------------------------------------------------------------------

test('P07 §13.1: 同一输入产出同一份事实（对象按 ID 排序）', () => {
  const input = {
    mapId: 'M1',
    metersPerCell: 0.5,
    objects: [trait({ objectId: 'O2' }), trait({ objectId: 'O1' })],
    routes: [{ routeId: 'R2', fromObjectId: 'O1', toObjectId: 'O2', passable: true }, { routeId: 'R1', fromObjectId: 'O1', toObjectId: 'O2' }],
  };
  const first = collectSpatialFacts(input);
  const second = collectSpatialFacts({ ...input, objects: [...input.objects].reverse() });
  assert.deepEqual(first.objects.map((item) => item.objectId), ['O1', 'O2']);
  assert.deepEqual(first.routes.map((item) => item.routeId), ['R1', 'R2']);
  assert.deepEqual(first, second, '输入顺序不影响结果');
});

test('P07 §13.1: 有米/格换算才能说 units=meters，否则只有格', () => {
  const meters = collectSpatialFacts({ mapId: 'M1', metersPerCell: 0.5 });
  assert.equal(meters.units, 'meters');
  assert.equal(meters.metersPerCell, 0.5);
  const cells = collectSpatialFacts({ mapId: 'M1' });
  assert.equal(cells.units, 'cells');
  assert.equal(cells.metersPerCell, null);
  assert.equal(cells.metricQuality, 'unknown');
});

test('P07 §13.1: 重复物体与缺 ID 的条目显式报出，不静默取第一条', () => {
  const facts = collectSpatialFacts({
    mapId: 'M1',
    objects: [trait({ objectId: 'O1', kind: 'wall' }), trait({ objectId: 'O1', kind: 'door' }), trait({ objectId: '' })],
  });
  assert.equal(facts.objects.length, 1);
  assert.equal(facts.objects[0].kind, 'wall', '保留第一条，不按顺序取最后一条');
  assert.ok(facts.issues.some((item) => item.code === 'SPATIAL_TRAIT_DUPLICATE'));
  assert.ok(facts.issues.some((item) => item.code === 'SPATIAL_TRAIT_OBJECT_MISSING'));
});

test('P07 §13.1: 没有地图 ID 时报错（事实绑不到任何图）', () => {
  const facts = collectSpatialFacts({ mapId: '', objects: [trait()] });
  assert.ok(facts.issues.some((item) => item.code === 'SPATIAL_FACTS_MAP_MISSING' && item.severity === 'error'));
});

test('P07 §13.1: 跨图没有显式变换就不给坐标', () => {
  assert.equal(transformPointBetweenMaps({ point: { x: 10, y: 20 }, transform: null }), null);
  assert.equal(transformPointBetweenMaps({ point: { x: 10, y: 20 }, transform: { scale: 0, offsetX: 0, offsetY: 0 } }), null);
  const moved = transformPointBetweenMaps({ point: { x: 10, y: 20 }, transform: { scale: 2, offsetX: 5, offsetY: -5 } });
  assert.deepEqual(moved, { x: 25, y: 35 });
});

// ---------------------------------------------------------------------------
// §13.3 投影：同一份事实，不同角色不同知识
// ---------------------------------------------------------------------------

const factsOf = () => collectSpatialFacts({
  mapId: 'M1',
  metersPerCell: 0.5,
  objects: [
    trait({ objectId: 'HALL', kind: 'wall' }),
    trait({ objectId: 'SECRET_ROOM', kind: 'wall' }),
    trait({ objectId: 'MAIN_DOOR', kind: 'door', openingState: 'open' }),
  ],
});

test('P07 §13.3: 两个角色共享同一份物理事实，却拿到不同投影', () => {
  const facts = factsOf();
  const player = projectSpatialFactsForActor({ facts, actorId: 'P1', secretObjectIds: ['SECRET_ROOM'] });
  const insider = projectSpatialFactsForActor({ facts, actorId: 'N1' });

  assert.equal(player.observed.some((item) => item.objectId === 'SECRET_ROOM'), false, '秘密房间不进玩家投影');
  assert.deepEqual(player.withheldObjectIds, ['SECRET_ROOM']);
  assert.equal(insider.observed.some((item) => item.objectId === 'SECRET_ROOM'), true);
  assert.equal(facts.objects.length, 3, '底层事实本身不变');
});

test('P07 §13.3: 已知物体清单存在时只投影这些；不存在则按同地可见', () => {
  const facts = factsOf();
  const narrow = projectSpatialFactsForActor({ facts, actorId: 'P1', knownObjectIds: ['HALL'] });
  assert.deepEqual(narrow.observed.map((item) => item.objectId), ['HALL']);

  const wide = projectSpatialFactsForActor({ facts, actorId: 'P1' });
  assert.equal(wide.observed.length, 3);
});

test('P07 §13.3: last-known 位置必须带时点，且秘密物体连历史位置都不给', () => {
  const projection = projectSpatialFactsForActor({
    facts: factsOf(),
    actorId: 'P1',
    secretObjectIds: ['SECRET_ROOM'],
    lastKnownPositions: [
      { objectId: 'SECRET_ROOM', asOfTurnId: 'T1' },
      { objectId: 'HALL', asOfTurnId: 'T2' },
      { objectId: 'HALL' },
    ],
  });
  assert.deepEqual(projection.lastKnown, [{ objectId: 'HALL', asOfTurnId: 'T2' }]);
});

test('P07 §13.3: 未标定的图在投影里明确不给米', () => {
  const cells = collectSpatialFacts({ mapId: 'M1', objects: [trait()] });
  const projection = projectSpatialFactsForActor({ facts: cells, actorId: 'P1' });
  assert.equal(projection.metersPerCell, null);
  assert.ok(projection.issues.some((item) => item.code === 'SPATIAL_PROJECTION_UNITS_CELLS'));
});
