/**
 * atlas-space-state-patch.test.mjs — P12 §5.7 / §18.4：`space.state.patch` 全链路。
 *
 * 这个操作最容易做成「看起来改了」：只校字段、不落地、门在图上还是开的。
 * 因此这里逐层钉死：
 * 1. 规范化：几何不可写、作者锁不可写、布尔/枚举严格、至少一项变化、容量有上限；
 * 2. 编译：目标必须在**本图**冻结账本里（跨图同名门打不到）、没账本不猜；
 * 3. 落地：真的写成 `world-fact/v1` 状态事件，重试同一条 op 不产生第二行；
 * 4. 读回：正文/决策/通行判定读的是同一份事实（关门上锁之后路线真的过不去）；
 * 5. 派生：`blocksMovement` 这类字段写了必须和门自身状态一致，不能另造一个通行事实。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { makeSeedWith, insertRows, IDS } from './fixtures/atlas-sql/seed.mjs';
import { makeAnchor, makeCompileContext } from './helpers/atlas-compile-context.mjs';
import { SOURCE_SNAPSHOT } from './fixtures/atlas-sql/model-cases.mjs';
import { extractPayload, parseOperations } from '../src/atlas-ops-parser.ts';
import { compileOperations } from '../src/atlas-ops-compile.ts';
import { applyGroups } from '../src/atlas-db-commit.ts';
import { createTableReadPort } from '../src/atlas-db-readport.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { normalizeOperation, normalizeSpaceStateUpdates, SPACE_STATE_PATCH_LIMIT, validateMinimum } from '../src/atlas-ops-normalize.ts';
import { readFurnishingStates, readActorSceneFacts } from '../src/atlas-scene-facts.ts';
import { readObjectStateFacts } from '../src/atlas-space-state.ts';
import { evaluateCondition } from '../src/atlas-sim-actions.ts';
import { decodeWorldFact } from '../src/atlas-world-fact-policy.ts';

const SQL = await initSqlJs();
const LOC = IDS.L3;
const MAP = IDS.M2;
const DOOR = `space:${LOC}:furn:D1`;
const SHELF = `space:${LOC}:furn:F1`;

const canonical = {
  version: 1,
  locationId: LOC,
  revision: 1,
  size: { widthM: 6, heightM: 4 },
  furnishing: [
    { localId: SHELF, type: 'shelf', name: '书架', itemId: null, widthM: 3, heightM: 1, quality: 'confirmed' },
    { localId: DOOR, type: 'door', name: '木门', itemId: null, widthM: 1, heightM: 0.2, quality: 'confirmed' },
  ],
};

async function fixture() {
  const seed = await makeSeedWith(SQL);
  const { db } = seed;
  db.run('BEGIN');
  db.run('UPDATE maps SET frame_json = ? WHERE branch_id = ? AND id = ?', [
    JSON.stringify({ origin_x: 0, origin_y: 0, reference_width_cells: 20, reference_height_cells: 15, atlasSpaceCanonical: canonical, atlasScene: { version: 1 } }),
    seed.branchId, MAP,
  ]);
  db.run('UPDATE characters SET location_id = ?, map_id = NULL, grid_x = NULL, grid_y = NULL, coord_precision = ? WHERE branch_id = ? AND id = ?', [
    LOC, 'unknown', seed.branchId, IDS.C1,
  ]);
  db.run('COMMIT');
  return seed;
}

function compile(seed, responseText, { phase = 'observe' } = {}) {
  const extracted = extractPayload(responseText);
  const parsed = parseOperations(extracted.payload, { phase });
  const anchor = makeAnchor();
  const context = makeCompileContext({ seed, phase, anchor });
  const compiled = compileOperations({
    operations: parsed.operations,
    anchor,
    phase,
    clockS: 0,
    revision: 0,
    tables: context.tables ?? createTableReadPort(seed.db),
    sources: { phase, snapshot: SOURCE_SNAPSHOT, clockS: 0 },
    knownRefs: seed.refs,
  });
  return { parsed, compiled };
}

function patchText(updates, ref = MAP) {
  return JSON.stringify({ op: 'space.state.patch', ref, data: { updates }, source: 'S1' });
}

/** 真实提交一遍：走 applyGroups，不是只看编译结果。 */
function commit(seed, out, id = 'g_space_state') {
  seed.db.run('BEGIN');
  applyGroups(seed.db, [{
    id,
    opIds: out.compiled.results.map((entry) => entry.opId),
    dependsOn: [],
    readSet: out.compiled.merged.readSet,
    mutations: out.compiled.merged.mutations,
    opIssues: out.compiled.issues.filter((entry) => entry.severity === 'error'),
  }], { branchId: seed.branchId, turnId: seed.seedTurnId, attemptId: `attempt_${id}`, validate: true });
  seed.db.run('COMMIT');
}

/* ------------------------------------------------------------------ *
 * 1 规范化
 * ------------------------------------------------------------------ */

test('§18.4 updates 必填、至少一项、容量有上限', () => {
  const none = normalizeSpaceStateUpdates({});
  assert.equal(none.ok, false);
  assert.ok(none.issues.some((entry) => entry.code === 'SPACE_PATCH_UPDATES_REQUIRED'));

  const empty = normalizeSpaceStateUpdates({ updates: [] });
  assert.ok(empty.issues.some((entry) => entry.code === 'SPACE_PATCH_EMPTY'));

  const tooMany = normalizeSpaceStateUpdates({ updates: Array.from({ length: SPACE_STATE_PATCH_LIMIT + 1 }, () => ({ objectRef: 'F1', openingState: 'open' })) });
  assert.ok(tooMany.issues.some((entry) => entry.code === 'SPACE_PATCH_TOO_MANY'), '嵌套数组不能绕开单条容量');

  const noChange = normalizeSpaceStateUpdates({ updates: [{ objectRef: 'F1' }] });
  assert.ok(noChange.issues.some((entry) => entry.code === 'SPACE_PATCH_NO_CHANGE'), '没有任何变化字段就不该发这条操作');
});

test('§18.4 几何与作者锁不可写：不是静默忽略，是明确拒绝', () => {
  for (const field of ['widthM', 'heightM', 'footprintCells', 'size']) {
    const checked = normalizeSpaceStateUpdates({ updates: [{ objectRef: 'F1', openingState: 'open', [field]: 3 }] });
    assert.equal(checked.ok, false, `${field} 必须被拒`);
    assert.ok(checked.issues.some((entry) => entry.code === 'SPACE_PATCH_GEOMETRY_IMMUTABLE'), field);
  }
  const locked = normalizeSpaceStateUpdates({ updates: [{ objectRef: 'F1', authorLocked: false }] });
  assert.ok(locked.issues.some((entry) => entry.code === 'SPACE_PATCH_AUTHOR_LOCK_REFUSED'));
});

test('§18.4 布尔与枚举严格类型：不把 "yes" 当锁上', () => {
  const badLock = normalizeSpaceStateUpdates({ updates: [{ objectRef: 'F1', locked: 'yes' }] });
  assert.equal(badLock.ok, false);
  assert.ok(badLock.issues.some((entry) => entry.code === 'SPACE_PATCH_BOOLEAN_INVALID'));

  const badOpening = normalizeSpaceStateUpdates({ updates: [{ objectRef: 'F1', openingState: 'ajar' }] });
  assert.ok(badOpening.issues.some((entry) => entry.code === 'SPACE_PATCH_OPENING_INVALID'));

  const badMaterial = normalizeSpaceStateUpdates({ updates: [{ objectRef: 'F1', material: 'concrete' }] });
  assert.ok(badMaterial.issues.some((entry) => entry.code === 'SPACE_PATCH_MATERIAL_INVALID'));

  const good = normalizeSpaceStateUpdates({ updates: [{ objectRef: 'F1', openingState: 'closed', locked: true, material: 'wood', present: true }] });
  assert.equal(good.ok, true);
});

test('§18.4 缺 ref / 缺 updates 的最小参数提示给出可照抄的例子', () => {
  const missingRef = validateMinimum({ op: 'space.state.patch', data: { updates: [{ objectRef: 'F1', openingState: 'open' }] } }, 'observe');
  assert.equal(missingRef.ok, false);
  assert.ok(missingRef.issue.message.includes('space.state.patch'), '报错要说清是哪个操作');
  assert.ok(missingRef.issue.message.includes('"op":"space.state.patch"'), '报错要给出可照抄的例子');
  const normalized = normalizeOperation({ op: 'space.state.patch', ref: MAP, data: { updates: [{ objectRef: 'F1', openingState: 'open' }] } }, 'observe');
  assert.equal(normalized.op?.op, 'space.state.patch');
  assert.deepEqual(normalized.issues.filter((entry) => entry.severity === 'error'), []);
});

/* ------------------------------------------------------------------ *
 * 2 编译：目标必须在本图冻结账本里
 * ------------------------------------------------------------------ */

test('§18.4 编译层把「关门 + 上锁」写成世界事实，且门的状态真的读得回来', async () => {
  const seed = await fixture();
  const out = compile(seed, patchText([{ objectRef: 'D1', locationRef: LOC, openingState: 'closed', locked: true }]));
  assert.deepEqual(out.compiled.issues.filter((entry) => entry.severity === 'error'), []);
  const rows = out.compiled.merged.mutations.filter((entry) => entry.table === 'construction_progress');
  assert.equal(rows.length, 2, '开关与锁是两条独立事实（互不推导）');
  const payloads = rows.map((entry) => JSON.parse(String(entry.after.payload_json)));
  const opening = payloads.find((entry) => entry.predicate === 'opening-state');
  const lock = payloads.find((entry) => entry.predicate === 'owner-lock');
  assert.equal(opening.subjectId, DOOR, '事实主体用全限定对象 ID，不是短引用');
  assert.equal(opening.layer, 'state-event');
  assert.equal(opening.value, 'closed');
  assert.equal(lock.value, true);

  commit(seed, out);

  const settled = readFurnishingStates({ db: seed.db, branchId: seed.branchId }, LOC).states.get(DOOR);
  assert.equal(settled.openingState, 'closed');
  assert.equal(settled.locked, true, '锁与开关分开记录，不是同一个字段');

  const facts = readActorSceneFacts({ db: seed.db, branchId: seed.branchId }, {
    actorId: IDS.C1, locationId: LOC, position: { kind: 'at_location', precision: 'coarse' },
  });
  const doorLine = facts.lines.find((line) => line.startsWith('可观察入口'));
  assert.ok(doorLine.includes('木门（closed'), `正文要如实写上门是关的：${doorLine}`);
  assert.ok(doorLine.includes('上锁'), `锁也要写进正文：${doorLine}`);
  seed.close();
});

test('§18.4 重试同一条 op 不产生第二行（幂等），也不假装又改了一次', async () => {
  const seed = await fixture();
  const first = compile(seed, patchText([{ objectRef: 'D1', locationRef: LOC, openingState: 'closed', locked: true }]));
  commit(seed, first);

  const retry = compile(seed, patchText([{ objectRef: 'D1', locationRef: LOC, openingState: 'closed', locked: true }]));
  assert.deepEqual(retry.compiled.issues.filter((entry) => entry.severity === 'error'), []);
  assert.equal(retry.compiled.merged.mutations.filter((entry) => entry.table === 'construction_progress').length, 0, '没有真实变化就不写行');
  assert.ok(retry.compiled.issues.some((entry) => entry.code === 'SPACE_PATCH_NO_OP'));

  const count = queryBound(seed.db, 'SELECT COUNT(*) AS n FROM construction_progress WHERE branch_id = ?', [seed.branchId])[0].n;
  assert.equal(Number(count), 2, '仍然是两条状态事实，没有翻倍');
  seed.close();
});

test('§18.4 跨图同名门打不到：locationRef 属于别的地图直接拒', async () => {
  const seed = await fixture();
  // 把书架所在空间挪到另一张图：这份补丁就不再是本图的对象。
  seed.db.run('UPDATE locations SET map_id = ? WHERE branch_id = ? AND id = ?', [IDS.M1, seed.branchId, LOC]);
  const out = compile(seed, patchText([{ objectRef: 'D1', locationRef: LOC, locked: true }]));
  assert.ok(
    out.compiled.issues.some((entry) => entry.code === 'SPACE_PATCH_FOREIGN_MAP'),
    '未知门不能更新另一张图里的同名门',
  );
  assert.equal(out.compiled.merged.mutations.filter((entry) => entry.table === 'construction_progress').length, 0);
  seed.close();
});

test('§18.4 没有冻结陈设账本的空间拒绝改状态：没有稳定 ID 就没有可改的对象', async () => {
  const seed = await fixture();
  seed.db.run('UPDATE maps SET frame_json = ? WHERE branch_id = ? AND id = ?', [
    JSON.stringify({ origin_x: 0, origin_y: 0, reference_width_cells: 20, reference_height_cells: 15, atlasScene: { version: 1 } }),
    seed.branchId, MAP,
  ]);
  const out = compile(seed, patchText([{ objectRef: 'D1', locationRef: LOC, openingState: 'open' }]));
  assert.ok(out.compiled.issues.some((entry) => entry.code === 'SPACE_PATCH_NO_CANONICAL'));
  seed.close();
});

test('§18.4 不在账本里的对象拒绝：不凭空给不存在的门改状态', async () => {
  const seed = await fixture();
  const out = compile(seed, patchText([{ objectRef: 'F9', locationRef: LOC, openingState: 'open' }]));
  assert.ok(out.compiled.issues.some((entry) => entry.code === 'SPACE_PATCH_OBJECT_UNKNOWN'));
  seed.close();
});

test('§18.4 决策阶段不能改状态：打算开门不等于门开了', async () => {
  const seed = await fixture();
  const extracted = extractPayload(patchText([{ objectRef: 'D1', locationRef: LOC, locked: true }]));
  const parsed = parseOperations(extracted.payload, { phase: 'decision' });
  const anchor = makeAnchor();
  const compiled = compileOperations({
    operations: parsed.operations,
    anchor,
    phase: 'decision',
    clockS: 0,
    revision: 0,
    tables: createTableReadPort(seed.db),
    sources: { phase: 'decision', snapshot: SOURCE_SNAPSHOT, clockS: 0 },
    knownRefs: seed.refs,
  });
  assert.ok(compiled.issues.some((entry) => entry.code === 'UNKNOWN_OPERATION'), 'decision 阶段的允许集合里没有它');
  seed.close();
});

/* ------------------------------------------------------------------ *
 * 3 派生字段：门状态是权威，通行结论不能另写
 * ------------------------------------------------------------------ */

test('§18.4 派生字段与门自身状态冲突时拒绝，而不是写两个真相', async () => {
  const seed = await fixture();
  const conflict = compile(seed, patchText([{ objectRef: 'D1', locationRef: LOC, openingState: 'closed', blocksMovement: false }]));
  assert.ok(
    conflict.compiled.issues.some((entry) => entry.code === 'SPACE_PATCH_DERIVED_CONFLICT'),
    '关着的木门不可能不挡路',
  );
  assert.equal(conflict.compiled.merged.mutations.filter((entry) => entry.table === 'construction_progress').length, 0);

  const consistent = compile(seed, patchText([{ objectRef: 'D1', locationRef: LOC, openingState: 'closed', blocksMovement: true }]));
  assert.deepEqual(consistent.compiled.issues.filter((entry) => entry.severity === 'error'), []);
  seed.close();
});

/* ------------------------------------------------------------------ *
 * 4 通行：门关着/锁着，路线与消息就不能无条件穿过
 * ------------------------------------------------------------------ */

test('§18.4 space_state 条件读的是同一份事实：未知不放行，关着不放行，开了才放行', async () => {
  const seed = await fixture();
  const world = { db: seed.db, branchId: seed.branchId };
  const condition = { space_state: { object_ref: DOOR } };

  const unknown = evaluateCondition(world, condition, { clockS: 0 });
  assert.equal(unknown.ok, false, '从没记录过状态时不能假设能走');
  assert.ok(unknown.reasons.some((reason) => reason.startsWith('SPACE_STATE_UNKNOWN')));

  const closed = compile(seed, patchText([{ objectRef: 'D1', locationRef: LOC, openingState: 'closed' }]));
  commit(seed, closed, 'g_closed');
  assert.equal(evaluateCondition(world, condition, { clockS: 0 }).ok, false);

  const locked = compile(seed, patchText([{ objectRef: 'D1', locationRef: LOC, locked: true }]));
  commit(seed, locked, 'g_locked');
  assert.equal(evaluateCondition(world, { space_state: { object_ref: DOOR, locked: false } }, { clockS: 0 }).ok, false, '锁着就不是「没锁」');

  const opened = compile(seed, patchText([{ objectRef: 'D1', locationRef: LOC, openingState: 'open' }]));
  commit(seed, opened, 'g_open');
  assert.equal(evaluateCondition(world, condition, { clockS: 0 }).ok, true, '开了就真的能过');

  const stillLocked = evaluateCondition(world, { space_state: { object_ref: DOOR, locked: true } }, { clockS: 0 });
  assert.equal(stillLocked.ok, true, '开门不等于解锁：两件事各自记录、互不推导');
  seed.close();
});

test('§18.4 解锁可以记成状态事件；静态扫描仍然不能断言「没锁」', async () => {
  const seed = await fixture();
  const lock = compile(seed, patchText([{ objectRef: 'D1', locationRef: LOC, locked: true }]));
  commit(seed, lock, 'g_lock');
  assert.equal(readObjectStateFacts({ db: seed.db, branchId: seed.branchId }, DOOR).locked, true);

  const unlock = compile(seed, patchText([{ objectRef: 'D1', locationRef: LOC, locked: false }]));
  assert.deepEqual(unlock.compiled.issues.filter((entry) => entry.severity === 'error'), []);
  commit(seed, unlock, 'g_unlock');
  assert.equal(readObjectStateFacts({ db: seed.db, branchId: seed.branchId }, DOOR).locked, false, '解锁是真实状态事件');

  // 静态断言（baseline）拿不到锁不等于能断言没锁。
  const baseline = decodeWorldFact({
    version: 1,
    id: 'fact_static_unlock',
    subjectId: DOOR,
    predicate: 'owner-lock',
    layer: 'baseline',
    origin: 'lorebook',
    producer: 'program',
    sourceKey: 'W1',
    sourceHash: null,
    sourceSpan: null,
    quality: 'confirmed',
    effectiveTurnId: 'turn_1',
    effectiveClockS: 0,
    supersedesFactId: null,
    value: false,
  });
  assert.equal(baseline.ok, false, '扫描不到锁，不能反过来断言这扇门没锁');
  seed.close();
});

/* ------------------------------------------------------------------ *
 * 5 世界书重扫不复原
 * ------------------------------------------------------------------ */

test('§18.4 状态事件压过静态基线：重扫不会把已经打开/锁上的门改回去', async () => {
  const seed = await fixture();
  insertRows(seed.db, 'construction_progress', [{
    branch_id: seed.branchId,
    id: 'fact_baseline_door',
    row_rev: 1,
    created_turn_id: seed.seedTurnId,
    updated_turn_id: seed.seedTurnId,
    scope_key: 'world-facts:v1',
    kind: 'target',
    subject_key: 'fact:fact_baseline_door',
    input_signature: 'sig_baseline',
    status: 'processed',
    last_served_seq: 0,
    payload_json: JSON.stringify({
      payloadKind: 'world-fact/v1',
      version: 1,
      id: 'fact_baseline_door',
      subjectId: DOOR,
      predicate: 'opening-state',
      layer: 'baseline',
      origin: 'lorebook',
      producer: 'program',
      sourceKey: null,
      sourceHash: null,
      sourceSpan: null,
      supersedesFactId: null,
      quality: 'confirmed',
      effectiveTurnId: seed.seedTurnId,
      effectiveClockS: 0,
      value: 'closed',
    }),
  }]);

  const opened = compile(seed, patchText([{ objectRef: 'D1', locationRef: LOC, openingState: 'open' }]));
  commit(seed, opened, 'g_open_over_baseline');
  const settled = readFurnishingStates({ db: seed.db, branchId: seed.branchId }, LOC).states.get(DOOR);
  assert.equal(settled.openingState, 'open', '剧情开了门，世界书重扫不得改回 closed');
  seed.close();
});

test('T-O05 destroyed entrance state reaches real scene projection while preserving the saved geometry',async()=>{
  const seed=await fixture();try{
    const before=JSON.stringify(queryBound(seed.db,'SELECT frame_json FROM maps WHERE branch_id=? AND id=?',[seed.branchId,MAP])[0]);
    const destroyed=compile(seed,patchText([{objectRef:'D1',locationRef:LOC,destroyed:true}]));
    assert.deepEqual(destroyed.compiled.issues.filter(issue=>issue.severity==='error'),[]);
    commit(seed,destroyed,'destroyed-entrance');
    assert.equal(readFurnishingStates({db:seed.db,branchId:seed.branchId},LOC).states.get(DOOR).destroyed,true);
    const scene=readActorSceneFacts({db:seed.db,branchId:seed.branchId},{actorId:IDS.C1,locationId:LOC,position:null}).context;
    assert.equal(scene.entrances.some(entry=>entry.objectId===DOOR),false);
    assert.ok(scene.constraints.some(entry=>entry.code==='DESTROYED_EXIT_USED'));
    assert.equal(JSON.stringify(queryBound(seed.db,'SELECT frame_json FROM maps WHERE branch_id=? AND id=?',[seed.branchId,MAP])[0]),before);
  }finally{seed.close();}
});
