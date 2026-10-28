/**
 * atlas-npc-initial-placement.test.mjs — P11 §17.1「只安排已有 NPC」的判定证据。
 *
 * 这里只测决策层（不写库、不调模型）。要证明的是：
 * 1. 只有「已登记 + 位置无依据 + 不在路上 + 没被安排过」的 NPC 才进候选；
 * 2. 落点必须合法（存在、非假设、未毁、可进入），判不出来就**不安排**，不伪造位置；
 * 3. 一次性：安排过就进 ALREADY_PLACED，不会每次更新又把他「送回家」；
 * 4. 操作面只允许改现有 NPC 的位置字段：禁止 new: 人物、禁改身份、禁生成随从；
 * 5. 放置属于 characters 类，不混进 geography / decision 阶段。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NPC_PLACEMENT_BATCH_LIMIT,
  chooseInitialLocation,
  characterHasLocationEvidence,
  identityPurposeOf,
  isLegalPlacementLocation,
  npcPlacementRecordsFromProgress,
  placementAllowedInPhase,
  planNpcInitialPlacement,
  selectPlacementCandidates,
  validateNpcPlacementOp,
} from '../src/atlas-world-build-plan.ts';

const SETTLEMENT = 'L_CITY';
const SMITHY = 'L_SMITHY';
const INN = 'L_INN';
const RUIN = 'L_RUIN';
const GHOST = 'L_GHOST';
const TOWER = 'L_TOWER';

const locations = [
  { id: SETTLEMENT, name: '圣罗兰城', kind: 'city', purpose: null, existence_quality: 'confirmed', status: 'active' },
  { id: SMITHY, name: '铁匠铺', kind: 'building', purpose: 'smithy', existence_quality: 'confirmed', status: 'active' },
  { id: INN, name: '醉马客栈', kind: 'building', purpose: 'inn', existence_quality: 'confirmed', status: 'active' },
  { id: RUIN, name: '烧毁的仓库', kind: 'building', purpose: null, existence_quality: 'confirmed', status: 'destroyed' },
  { id: GHOST, name: '传闻中的地下室', kind: 'room', purpose: null, existence_quality: 'hypothetical', status: 'active' },
  { id: TOWER, name: '封闭塔楼', kind: 'building', purpose: null, existence_quality: 'confirmed', status: 'active', canEnter: false },
];

function npc(overrides = {}) {
  return {
    id: 'C_NPC', name: '无名者', role: 'npc', importance: 'supporting',
    status: 'active', physical_status: 'alive', identity: '', description: '',
    location_id: null, map_id: null, grid_x: null, grid_y: null, coord_precision: 'unknown',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * 1 候选资格
 * ------------------------------------------------------------------ */

test('§17.1 只选位置无明确依据、不在路上、未安排过的已登记 NPC', () => {
  const { candidates, skipped } = selectPlacementCandidates({
    characters: [
      npc({ id: 'C_MAIN', role: 'protagonist', location_id: null }),
      npc({ id: 'C_HOME', location_id: SETTLEMENT }),
      npc({ id: 'C_GRID', map_id: 'M1', grid_x: 3, grid_y: 4 }),
      npc({ id: 'C_DEAD', physical_status: 'dead' }),
      npc({ id: 'C_GONE', status: 'archived' }),
      npc({ id: 'C_WALKING' }),
      npc({ id: 'C_PLACED' }),
      npc({ id: 'C_FREE' }),
    ],
    locations,
    openJourneys: [{ mover_entity_id: 'C_WALKING', status: 'moving' }],
    placed: [{ kind: 'npc-initial-placement', characterId: 'C_PLACED', locationId: SETTLEMENT, basis: 'estimated', reasonCode: 'SETTLEMENT_ANCHOR', decidedAtTurn: 'turn_1' }],
  });

  assert.deepEqual(candidates.map((c) => c.id), ['C_FREE'], '只有 C_FREE 该被安排');
  const reasonOf = (id) => skipped.find((entry) => entry.characterId === id)?.reason;
  assert.equal(reasonOf('C_MAIN'), 'PROTAGONIST_NOT_PLACED', '主角的位置来自剧情，不在这里安排');
  assert.equal(reasonOf('C_HOME'), 'HAS_LOCATION', '已有地点的人沿用，不重排');
  assert.equal(reasonOf('C_GRID'), 'HAS_LOCATION', '网格坐标也算位置依据');
  assert.equal(reasonOf('C_DEAD'), 'INACTIVE_CHARACTER', '死人不安排');
  assert.equal(reasonOf('C_GONE'), 'INACTIVE_CHARACTER', '归档的人不动');
  assert.equal(reasonOf('C_WALKING'), 'IN_TRANSIT', '在路上的不拉回去');
  assert.equal(reasonOf('C_PLACED'), 'ALREADY_PLACED', '安排过就不再安排');
});

test('§17.1 位置依据只认地点或坐标，坐标必须配地图才成立', () => {
  assert.equal(characterHasLocationEvidence({ location_id: SETTLEMENT }), true);
  assert.equal(characterHasLocationEvidence({ map_id: 'M1', grid_x: 1, grid_y: 2 }), true);
  assert.equal(characterHasLocationEvidence({ grid_x: 1, grid_y: 2 }), false, '没有地图的坐标不成依据');
  assert.equal(characterHasLocationEvidence({ location_id: null, map_id: null }), false);
});

/* ------------------------------------------------------------------ *
 * 2 落点合法性
 * ------------------------------------------------------------------ */

test('§17.1 落点必须存在、非假设、未毁、结构类要可进入', () => {
  assert.equal(isLegalPlacementLocation(locations[0]).legal, true, '城市可当粗粒度落点');
  assert.equal(isLegalPlacementLocation(locations[1]).legal, true, '可进入建筑合法');
  assert.equal(isLegalPlacementLocation(locations[3]).reasonCode, 'GONE', '已毁建筑不是有效落点');
  assert.equal(isLegalPlacementLocation(locations[4]).reasonCode, 'HYPOTHETICAL', '只存在于推测的地点不安排');
  assert.equal(isLegalPlacementLocation(locations[5]).reasonCode, 'NOT_ENTERABLE', '不可进入的塔楼不当住处');
  assert.equal(isLegalPlacementLocation({ id: 'L_RIVER', kind: 'natural' }).reasonCode, 'UNKNOWN_KIND', '自然物不是落点');
});

test('§17.1 按身份落在设施上：铁匠 → 铁匠铺，掌柜 → 客栈', () => {
  assert.equal(identityPurposeOf({ identity: '镇上的铁匠' }), 'smithy');
  assert.equal(identityPurposeOf({ identity: '客栈掌柜' }), 'inn');
  assert.equal(identityPurposeOf({ description: '城门守卫' }), 'guard-post');
  assert.equal(identityPurposeOf({ identity: '王家信使' }), null, '信使不对应任何设施：不硬塞到哨所');
  assert.equal(identityPurposeOf({ identity: '街边的猫' }), null, '判不出职业就说不知道');

  const smith = chooseInitialLocation({ character: npc({ identity: '铁匠' }), locations, settlementId: SETTLEMENT });
  assert.deepEqual(smith, { locationId: SMITHY, reasonCode: 'IDENTITY_FACILITY' });
  const innkeeper = chooseInitialLocation({ character: npc({ identity: '掌柜' }), locations, settlementId: SETTLEMENT });
  assert.deepEqual(innkeeper, { locationId: INN, reasonCode: 'IDENTITY_FACILITY' });
});

test('§17.1 判不出身份时落在聚落，而不是塞到主角房间', () => {
  const choice = chooseInitialLocation({ character: npc({ identity: '路人' }), locations, settlementId: SETTLEMENT });
  assert.deepEqual(choice, { locationId: SETTLEMENT, reasonCode: 'SETTLEMENT_ANCHOR' });
});

test('§17.1 只有一个合法落点时用它，但仍标 ONLY_LEGAL_PLACE 而不是更具体的理由', () => {
  const choice = chooseInitialLocation({
    character: npc({ identity: '铁匠' }),
    locations: [{ id: SETTLEMENT, name: '孤城', kind: 'city', existence_quality: 'confirmed', status: 'active' }],
    settlementId: null,
  });
  assert.deepEqual(choice, { locationId: SETTLEMENT, reasonCode: 'ONLY_LEGAL_PLACE' });
});

test('§17.1 没有合法落点就放弃，不伪造位置', () => {
  const choice = chooseInitialLocation({
    character: npc({ identity: '铁匠' }),
    locations: [locations[3], locations[4], locations[5]],
    settlementId: SETTLEMENT,
  });
  assert.equal(choice.locationId, null);
  assert.equal(choice.reasonCode, null);
});

/* ------------------------------------------------------------------ *
 * 3 一批放置
 * ------------------------------------------------------------------ */

test('§17.1 一批放置：只写位置字段 + estimated 来源 + 一次性记录', () => {
  const result = planNpcInitialPlacement({
    characters: [
      npc({ id: 'C_SMITH', name: '老约翰', identity: '铁匠', importance: 'recurring' }),
      npc({ id: 'C_PASSER', name: '路人甲' }),
    ],
    locations,
    settlementId: SETTLEMENT,
    turnId: 'turn_42',
  });

  assert.equal(result.placements.length, 2);
  const smith = result.placements.find((entry) => entry.characterId === 'C_SMITH');
  assert.equal(smith.locationId, SMITHY);
  assert.equal(smith.reasonCode, 'IDENTITY_FACILITY');
  assert.equal(smith.basis, 'estimated');
  assert.equal(smith.workClass, 'characters', '放置属于 characters 类工作');
  assert.deepEqual(smith.op, {
    op: 'character.upsert',
    ref: 'C_SMITH',
    data: { location_ref: SMITHY },
    source: 'estimate:npc-initial-placement',
  }, '只动位置字段，不写身份/重要性/新人物');
  assert.equal(smith.record.decidedAtTurn, 'turn_42');
  assert.equal(smith.record.kind, 'npc-initial-placement');

  // 排序稳定：core/recurring 在前，同权重按 id。
  assert.deepEqual(result.placements.map((entry) => entry.characterId), ['C_SMITH', 'C_PASSER']);
  assert.ok(result.issues.some((issue) => issue.code === 'NPC_PLACEMENT_ESTIMATED'), 'estimated 来源要如实记账');
});

test('§17.1 安排过的角色下一批不再进候选（不每轮重新安排）', () => {
  const first = planNpcInitialPlacement({ characters: [npc({ id: 'C_SMITH', identity: '铁匠' })], locations, settlementId: SETTLEMENT });
  assert.equal(first.placements.length, 1);

  const second = planNpcInitialPlacement({
    characters: [npc({ id: 'C_SMITH', identity: '铁匠' })],
    locations,
    settlementId: SETTLEMENT,
    placed: first.placements.map((entry) => entry.record),
  });
  assert.equal(second.placements.length, 0, '第二次调用不得再放一遍');
  assert.deepEqual(second.skipped, [{ characterId: 'C_SMITH', reason: 'ALREADY_PLACED' }]);
});

test('§17.1 一次性记录可以从建造进度行读回来', () => {
  const records = npcPlacementRecordsFromProgress([
    { payload: { kind: 'npc-initial-placement', characterId: 'C1', locationId: 'L1', decidedAtTurn: 'turn_1' } },
    { payload: { kind: 'other', characterId: 'C2', locationId: 'L2' } },
    { payload: null },
    { payload: { kind: 'npc-initial-placement', characterId: '', locationId: 'L3' } },
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].characterId, 'C1');
  assert.equal(records[0].basis, 'estimated');
});

test('§17.1 没有合法落点的 NPC 进 NO_LEGAL_LOCATION 并显式报码', () => {
  const result = planNpcInitialPlacement({
    characters: [npc({ id: 'C_LOST', name: '迷路的人' })],
    locations: [locations[3], locations[4]],
    settlementId: SETTLEMENT,
  });
  assert.equal(result.placements.length, 0);
  assert.deepEqual(result.skipped, [{ characterId: 'C_LOST', reason: 'NO_LEGAL_LOCATION' }]);
  assert.ok(result.issues.some((entry) => entry.code === 'NPC_PLACEMENT_NO_LOCATION'));
});

test('§17.1 批次有界：超出的显式记 BATCH_LIMIT，不偷偷扩容', () => {
  const many = Array.from({ length: NPC_PLACEMENT_BATCH_LIMIT + 3 }, (_, index) => npc({ id: `C_${String(index).padStart(2, '0')}` }));
  const result = planNpcInitialPlacement({ characters: many, locations, settlementId: SETTLEMENT });
  assert.equal(result.placements.length, NPC_PLACEMENT_BATCH_LIMIT);
  assert.equal(result.skipped.filter((entry) => entry.reason === 'BATCH_LIMIT').length, 3);
});

/* ------------------------------------------------------------------ *
 * 4 操作面护栏
 * ------------------------------------------------------------------ */

test('§17.1 只允许改现有 NPC 的位置：new: 人物、改身份、生成随从一律拒绝', () => {
  const known = ['C1', 'C2'];
  assert.equal(validateNpcPlacementOp({ op: 'character.upsert', ref: 'C1', data: { location_ref: 'L1' } }, known), null);

  assert.equal(
    validateNpcPlacementOp({ op: 'character.upsert', ref: 'new:minion', data: { location_ref: 'L1' } }, known)?.code,
    'NPC_PLACEMENT_NEW_CHARACTER_FORBIDDEN',
  );
  assert.equal(
    validateNpcPlacementOp({ op: 'character.upsert', ref: 'C1', data: { location_ref: 'L1', identity: '国王' } }, known)?.code,
    'NPC_PLACEMENT_FIELD_NOT_ALLOWED',
  );
  assert.equal(
    validateNpcPlacementOp({ op: 'character.upsert', ref: 'C_STRANGER', data: { location_ref: 'L1' } }, known)?.code,
    'NPC_PLACEMENT_REF_UNKNOWN',
  );
  assert.equal(
    validateNpcPlacementOp({ op: 'character.create', ref: 'C1', data: { location_ref: 'L1' } }, known)?.code,
    'NPC_PLACEMENT_OP_NOT_ALLOWED',
  );
  assert.equal(
    validateNpcPlacementOp({ op: 'character.upsert', ref: 'C1', data: {} }, known)?.code,
    'NPC_PLACEMENT_LOCATION_MISSING',
  );
});

test('§17.1 放置不混进 geography / decision 阶段', () => {
  assert.equal(placementAllowedInPhase('observe'), true);
  assert.equal(placementAllowedInPhase('geography'), false, '不要误塞进地理阶段');
  assert.equal(placementAllowedInPhase('decision'), false, 'decision 只写想法/倾向');
  assert.equal(placementAllowedInPhase(undefined), false);
});

test('§17.1 同样输入两次得到同样结果（不含随机与时间）', () => {
  const input = {
    characters: [npc({ id: 'C_B', identity: '铁匠' }), npc({ id: 'C_A', identity: '掌柜' }), npc({ id: 'C_C' })],
    locations,
    settlementId: SETTLEMENT,
  };
  const first = planNpcInitialPlacement(input);
  const second = planNpcInitialPlacement(input);
  assert.deepEqual(first.placements, second.placements);
});

/* ------------------------------------------------------------------ *
 * 5 一次性记录接进建造状态读取层
 * ------------------------------------------------------------------ */

test('§17.1 放置记录从建造进度行读出后，同一批不会再安排第二遍', async () => {
  const { readNpcPlacementRecords, isNpcPlacementRow } = await import('../src/atlas-world-build-state.ts');
  const rows = [
    {
      id: 'progress_target_A',
      scopeKey: 'world-build:chat-A',
      payloadOk: true,
      payload: { payloadKind: 'npc-initial-placement', kind: 'npc-initial-placement', characterId: 'C_SMITH', locationId: SMITHY, decidedAtTurn: 'turn_9' },
    },
    { id: 'progress_target_B', scopeKey: 'world-build:chat-A', payloadOk: true, payload: { payloadKind: 'world-build-target/v1' } },
    { id: 'progress_target_C', scopeKey: 'world-build:chat-A', payloadOk: true, payload: { payloadKind: 'npc-initial-placement', kind: 'npc-initial-placement', characterId: '', locationId: '' } },
  ];
  assert.equal(isNpcPlacementRow(rows[0]), true);
  assert.equal(isNpcPlacementRow(rows[1]), false, '别的 payloadKind 不能被当成放置记录');

  const read = readNpcPlacementRecords(rows);
  assert.equal(read.values.length, 1);
  assert.equal(read.rejectedRows, 1, '缺 ID 的记录不能当成已放置');
  assert.ok(read.issues.some((issue) => issue.code === 'NPC_PLACEMENT_RECORD_INCOMPLETE'));

  const again = planNpcInitialPlacement({
    characters: [npc({ id: 'C_SMITH', identity: '铁匠' })],
    locations,
    settlementId: SETTLEMENT,
    placed: read.values,
  });
  assert.equal(again.placements.length, 0, '读回记录后不再重复安排');
  assert.deepEqual(again.skipped, [{ characterId: 'C_SMITH', reason: 'ALREADY_PLACED' }]);
});
