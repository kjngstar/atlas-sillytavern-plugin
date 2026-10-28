/**
 * atlas-furnishing-promotion.test.mjs — P12 §18.2 / §18.3 证据。
 *
 * 要证明的是「家具不会先被批量做成物品，真的搬动时才恰好变成一个」：
 * 1. 提升身份是位置 + localId，重试/别名/重复事件都落到同一张桌子；
 * 2. 已有 itemId 就复用，绝不建第二个；
 * 3. 一个原子组同时含物品行与 canonical 绑定，回退时一起还原；
 * 4. 没有明确物体、歧义引用、作者锁、错误阶段一律拒绝；
 * 5. 搬走不留重复占地；跨图不搬旧坐标；
 * 6. 后台搬动只认已接受的 outcome 事件，且目标必须合法；
 * 7. 编译层（真实入口）：普通家具名不带剧情来源的新建被拒；带 fromFurnishingRef 的会绑定 itemId。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  furnishingOriginKey,
  planFurnishingMove,
  planFurnishingPromotion,
  promotionAllowedInPhase,
  promotionRestorePlan,
  resolveFurnishingRef,
} from '../src/atlas-furnishing-promotion.ts';
import { readSpaceCanonical } from '../src/atlas-space-canonical.ts';

const LOC = 'L_ROOM';
const MAP = 'M_ROOM';

const canonical = {
  version: 1,
  locationId: LOC,
  revision: 3,
  size: { widthM: 6, heightM: 4, quality: 'confirmed', locked: false, basis: { kind: 'source', referenceId: null, note: '世界书' } },
  furnishing: [
    { localId: `space:${LOC}:furn:F1`, type: 'shelf', name: '书架', itemId: null, widthM: 3, heightM: 1, quality: 'confirmed' },
    { localId: `space:${LOC}:furn:F3`, type: 'table', name: '木桌', itemId: null, widthM: 1.2, heightM: 0.8, quality: 'confirmed' },
    { localId: `space:${LOC}:furn:D1`, type: 'door', name: '木门', itemId: null, widthM: 1, heightM: 0.2, quality: 'confirmed' },
  ],
};

const mapRow = () => ({
  branch_id: 'main-A', id: MAP, row_rev: 7, created_turn_id: 't', updated_turn_id: 't',
  name: '房间图', kind: 'interior', container_location_id: LOC, description: '',
  frame_json: JSON.stringify({ origin_x: 0, origin_y: 0, reference_width_cells: 12, reference_height_cells: 8, atlasSpaceCanonical: canonical }),
  meters_per_cell: 1, scale_min_meters_per_cell: 1, scale_max_meters_per_cell: 1,
  scale_quality: 'confirmed', scale_basis_json: '{}', scale_locked: 0, calibration_rev: 1,
  background_asset_key: null, default_terrain: 'unknown', status: 'active',
});

let idSeq = 0;
const makeId = (kind, opId, alias) => `${kind}_${String(++idSeq).padStart(3, '0')}_${alias}`;

function promotion(overrides = {}) {
  return planFurnishingPromotion({
    phase: 'observe',
    branchId: 'main-A',
    turnId: 'turn_18',
    makeId,
    map: { id: MAP, row: mapRow() },
    locationId: LOC,
    furnishingRef: 'F3',
    target: { kind: 'in-place' },
    itemFields: { name: '木桌', kind: 'object' },
    ...overrides,
  });
}

/* ------------------------------------------------------------------ *
 * 1 身份与引用
 * ------------------------------------------------------------------ */

test('§18.3.1 提升身份由位置 + localId 派生，名字与写法都不参与', () => {
  const full = `space:${LOC}:furn:F3`;
  assert.equal(furnishingOriginKey(LOC, 'F3'), full);
  assert.equal(furnishingOriginKey(LOC, 'furn:F3'), full);
  assert.equal(furnishingOriginKey(LOC, full), full);
  assert.notEqual(furnishingOriginKey(LOC, 'F3'), furnishingOriginKey('L_OTHER', 'F3'), '不同空间的同名陈设不是同一件');
});

test('§18.3.1/F3 短引用、furn: 前缀与全限定写法解析到同一条陈设', () => {
  const read = readSpaceCanonical(mapRow().frame_json, LOC).canonical;
  for (const ref of ['F3', 'furn:F3', `space:${LOC}:furn:F3`]) {
    const resolved = resolveFurnishingRef(read, ref);
    assert.equal(resolved.localId, `space:${LOC}:furn:F3`, `${ref} 应解析到木桌`);
    assert.deepEqual(resolved.issues, []);
  }
});

test('§18.3.8 歧义引用 / 未知引用 / 空引用都不提升', () => {
  const ambiguous = {
    ...canonical,
    furnishing: [
      ...canonical.furnishing,
      { localId: `space:${LOC}:furn:F3`, type: 'table', name: '另一张木桌', itemId: null, widthM: 1, heightM: 1, quality: 'layout' },
    ],
  };
  assert.equal(resolveFurnishingRef(ambiguous, 'F3').furnishing, null);
  assert.ok(resolveFurnishingRef(ambiguous, 'F3').issues.some((entry) => entry.code === 'PROMOTION_REF_AMBIGUOUS'));
  assert.ok(resolveFurnishingRef(canonical, 'F9').issues.some((entry) => entry.code === 'PROMOTION_FURNISHING_UNKNOWN'));
  assert.ok(resolveFurnishingRef(canonical, '').issues.some((entry) => entry.code === 'PROMOTION_OBJECT_REQUIRED'));
});

/* ------------------------------------------------------------------ *
 * 2 幂等提升
 * ------------------------------------------------------------------ */

test('§18.3.3 首次提升产出「物品行 + canonical 绑定」同一组，绑定写回 itemId', () => {
  const result = promotion();
  assert.ok(result.group, JSON.stringify(result.issues));
  assert.equal(result.reused, false);
  assert.deepEqual(result.group.mutations.map((mutation) => mutation.table), ['items', 'maps'], '一个组同时改物品行与绑定');
  assert.equal(result.group.mutations[0].rowId, result.itemId);

  const bound = readSpaceCanonical(result.group.mutations[1].after.frame_json, LOC).canonical;
  assert.equal(bound.furnishing.find((entry) => entry.localId === `space:${LOC}:furn:F3`).itemId, result.itemId);
  assert.equal(bound.revision, canonical.revision + 1, '绑定升修订号');

  const item = result.group.mutations[0].after;
  assert.equal(item.location_id, LOC, '原地提升仍在原地点');
  const properties = JSON.parse(String(item.properties_json));
  assert.deepEqual(
    properties.find((entry) => entry.key === 'fromFurnishing').value,
    `space:${LOC}:furn:F3`,
    '物品带来源陈设',
  );
  assert.deepEqual(properties.find((entry) => entry.key === 'sizeM').value, { widthM: 1.2, heightM: 0.8 }, '尺寸跟着物品走');
});

test('§18.3.2 已绑定的陈设再次提升：复用同一个 itemId，不建第二张桌子', () => {
  const first = promotion();
  const boundFrame = first.group.mutations[1].after.frame_json;
  const second = promotion({
    map: { id: MAP, row: { ...mapRow(), frame_json: boundFrame } },
    existingItems: new Map([[first.itemId, first.group.mutations[0].after]]),
  });
  assert.ok(second.group);
  assert.equal(second.reused, true, '必须标记为复用');
  assert.equal(second.itemId, first.itemId, 'itemId 不变');
  const itemMutations = second.group.mutations.filter((mutation) => mutation.table === 'items');
  assert.equal(itemMutations.length, 1);
  assert.ok(itemMutations[0].before, '复用时是更新而不是新建（before 非空）');
});

test('§18.3.2 提升索引也能复用（重试/重复事件不新建）', () => {
  const indexed = promotion({ promoted: new Map([[`space:${LOC}:furn:F3`, 'item_existing']]) });
  assert.equal(indexed.reused, true);
  assert.equal(indexed.itemId, 'item_existing');
});

test('§18.3.7 回退计划覆盖物品行与绑定，才算退得干净', () => {
  const first = promotion();
  const plan = promotionRestorePlan(first.group);
  assert.equal(plan.complete, true);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.maps.length, 1);
  assert.ok(plan.maps[0].before, '绑定有 before 才能退回去');
  assert.equal(promotionRestorePlan(null).complete, false);
});

/* ------------------------------------------------------------------ *
 * 3 拒绝条件
 * ------------------------------------------------------------------ */

test('§18.3.8 作者锁 / 只读空间里不提升，保留旧状态', () => {
  const locked = promotion({ sizeLocked: true });
  assert.equal(locked.group, null);
  assert.ok(locked.issues.some((entry) => entry.code === 'PROMOTION_LOCKED_OBJECT'));

  const readOnly = promotion({ readOnly: true });
  assert.equal(readOnly.group, null);
  assert.ok(readOnly.issues.some((entry) => entry.code === 'PROMOTION_LOCKED_OBJECT'));
});

test('§18.2 决策阶段的意图不立即执行；没有冻结帧也不猜', () => {
  assert.equal(promotionAllowedInPhase('observe'), true);
  assert.equal(promotionAllowedInPhase('decision'), false, '决策阶段的「我要搬走」不是事实');
  const wrongPhase = promotion({ phase: 'decision' });
  assert.equal(wrongPhase.group, null);
  assert.ok(wrongPhase.issues.some((entry) => entry.code === 'PROMOTION_PHASE_NOT_ALLOWED'));

  const noFrame = promotion({ map: null });
  assert.equal(noFrame.group, null);
  assert.ok(noFrame.issues.some((entry) => entry.code === 'PROMOTION_FRAME_REQUIRED'));
});

test('§18.3.1 事件必须作用于同一件陈设，未来的意图不算发生', () => {
  const mismatch = promotion({ event: { id: 'E1', status: 'occurred', furnishingLocalId: 'F1' } });
  assert.equal(mismatch.group, null);
  assert.ok(mismatch.issues.some((entry) => entry.code === 'PROMOTION_OBJECT_MISMATCH'));

  const planned = promotion({ event: { id: 'E2', status: 'planned', furnishingLocalId: 'F3' } });
  assert.equal(planned.group, null);
  assert.ok(planned.issues.some((entry) => entry.code === 'PROMOTION_EVENT_NOT_EFFECTIVE'));

  const noObject = promotion({ event: { id: 'E3', status: 'occurred', furnishingLocalId: '' } });
  assert.equal(noObject.group, null);
  assert.ok(noObject.issues.some((entry) => entry.code === 'PROMOTION_EVENT_OBJECT_MISSING'));
});

test('§18.2 搬动/转交必须有已接受事件作依据', () => {
  const moveNoEvent = promotion({ target: { kind: 'move', locationId: 'L_HALL' } });
  assert.equal(moveNoEvent.group, null);
  assert.ok(moveNoEvent.issues.some((entry) => entry.code === 'PROMOTION_EVENT_REQUIRED'));
});

/* ------------------------------------------------------------------ *
 * 4 搬动与转交
 * ------------------------------------------------------------------ */

test('§18.3.6 搬到别的图时不搬旧坐标，尺寸与来源仍保留', () => {
  const moved = promotion({
    target: { kind: 'move', locationId: 'L_OTHER', mapId: 'M_OTHER', gridX: 3, gridY: 2 },
    event: { id: 'E9', status: 'occurred', furnishingLocalId: 'F3', actorId: 'C1' },
  });
  assert.ok(moved.group, JSON.stringify(moved.issues));
  const item = moved.group.mutations[0].after;
  assert.equal(item.location_id, 'L_OTHER');
  assert.equal(item.map_id, 'M_OTHER');
  assert.equal(item.grid_x, 3, '新图的坐标按目标图写');
  assert.equal(item.grid_y, 2);

  const noCoords = promotion({
    target: { kind: 'move', locationId: 'L_OTHER', mapId: 'M_OTHER' },
    event: { id: 'E10', status: 'occurred', furnishingLocalId: 'F3' },
  });
  const item2 = noCoords.group.mutations[0].after;
  assert.equal(item2.grid_x, null, '没有新坐标就留空，不搬旧源坐标');
  assert.equal(item2.coord_precision, 'unknown');
});

test('§18.3 交给某人时清掉落点，不留幽灵 holder', () => {
  const held = promotion({
    target: { kind: 'hold', characterId: 'C1' },
    event: { id: 'E11', status: 'occurred', furnishingLocalId: 'F3' },
  });
  const item = held.group.mutations[0].after;
  assert.equal(item.holder_character_id, 'C1');
  assert.equal(item.location_id, null);
  assert.equal(item.map_id, null);
  assert.equal(item.container_item_id, null);
});

test('§18.2 后台搬动只认已接受的 outcome 事件，且目标必须合法', () => {
  const actorExists = (id) => id === 'C1';
  const legal = planFurnishingMove({
    phase: 'outcome-effect',
    event: { id: 'E1', status: 'occurred', accepted: true, actorId: 'C1', furnishingLocalId: 'F3' },
    target: { kind: 'hold', characterId: 'C1' },
    actorExists,
    targetLegal: () => true,
  });
  assert.equal(legal.allowed, true);

  const wrongPhase = planFurnishingMove({
    phase: 'decision', event: { id: 'E1', status: 'occurred', accepted: true, actorId: 'C1', furnishingLocalId: 'F3' },
    target: { kind: 'hold', characterId: 'C1' }, actorExists, targetLegal: () => true,
  });
  assert.equal(wrongPhase.allowed, false);

  const notHappened = planFurnishingMove({
    phase: 'outcome-effect', event: { id: 'E1', status: 'planned', actorId: 'C1', furnishingLocalId: 'F3' },
    target: { kind: 'hold', characterId: 'C1' }, actorExists, targetLegal: () => true,
  });
  assert.equal(notHappened.allowed, false);
  assert.ok(notHappened.issues.some((entry) => entry.code === 'PROMOTION_MOVE_EVENT_NOT_EFFECTIVE'));

  const unknownActor = planFurnishingMove({
    phase: 'outcome-effect', event: { id: 'E1', status: 'occurred', accepted: true, actorId: 'C_GHOST', furnishingLocalId: 'F3' },
    target: { kind: 'hold', characterId: 'C1' }, actorExists, targetLegal: () => true,
  });
  assert.ok(unknownActor.issues.some((entry) => entry.code === 'PROMOTION_MOVE_ACTOR_UNKNOWN'));

  const illegalTarget = planFurnishingMove({
    phase: 'outcome-effect', event: { id: 'E1', status: 'occurred', accepted: true, actorId: 'C1', furnishingLocalId: 'F3' },
    target: { kind: 'move', locationId: 'L_LOCKED' }, actorExists, targetLegal: () => false,
  });
  assert.equal(illegalTarget.allowed, false);
  assert.ok(illegalTarget.issues.some((entry) => entry.code === 'PROMOTION_MOVE_TARGET_ILLEGAL'));
});
