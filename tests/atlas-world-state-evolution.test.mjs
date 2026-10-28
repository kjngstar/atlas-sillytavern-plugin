/**
 * atlas-world-state-evolution.test.mjs — P12 §18.1 状态演变 + §18.4 门窗更新。
 *
 * 要证明的是：
 * 1. 变化原因分得开：纠正旧推测 ≠ 真实剧情变化 ≠ 拆改（不能全叫 rebuild）；
 * 2. 世界书重扫**不复原**已被剧情改变的事实（毁掉的建筑/搬走的桌子/打开的门）；
 * 3. 静态补缺看到已提升/已搬走的陈设不再补一份同款；
 * 4. 门窗补丁按候选内顺序应用，开关/锁/材质互相独立，跨图同名门打不到；
 * 5. 模型开锁不解除作者锁，也不改占地；
 * 6. 状态事实真的会进正文与决策切片（不是只存在于判定函数里）。
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
import {
  WORLD_FACT_CHANGE_REASONS,
  classifyWorldFactChange,
  staticReplenishVerdict,
  staticRescanVerdict,
} from '../src/atlas-world-fact-policy.ts';
import { applySpaceStatePatches, patchedPassability, resolvePatchObjectId } from '../src/atlas-space-state.ts';
import { readSpaceCanonical } from '../src/atlas-space-canonical.ts';
import { readActorSceneFacts } from '../src/atlas-scene-facts.ts';
import { buildDecisionContext } from '../src/atlas-sim-decision-context.ts';

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
    { localId: `space:${LOC}:furn:F1`, type: 'shelf', name: '书架', itemId: null, widthM: 3, heightM: 1, quality: 'confirmed' },
    { localId: DOOR, type: 'door', name: '木门', itemId: null, widthM: 1, heightM: 0.2, quality: 'confirmed' },
    { localId: `space:${LOC}:furn:G1`, type: 'partition', name: '玻璃隔断', itemId: null, widthM: 2, heightM: 0.2, quality: 'confirmed' },
  ],
};

let factSeq = 0;
function fact(overrides = {}) {
  return {
    version: 1,
    id: `fact_${String(++factSeq).padStart(3, '0')}`,
    subjectId: SHELF,
    predicate: 'opening-state',
    layer: 'baseline',
    origin: 'lorebook',
    producer: 'program',
    sourceKey: null,
    sourceHash: null,
    sourceSpan: null,
    quality: 'confirmed',
    effectiveTurnId: 'turn_1',
    effectiveClockS: 0,
    supersedesFactId: null,
    value: 'closed',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * §18.1 变化原因
 * ------------------------------------------------------------------ */

test('§18.1 变化原因分得开：首值 / 纠正 / 剧情变化 / 拆改', () => {
  assert.deepEqual([...WORLD_FACT_CHANGE_REASONS], ['initial-estimate', 'source-correction', 'story-change', 'rebuild', 'rescan-refused']);

  assert.equal(classifyWorldFactChange({ previous: null, next: fact() }).reason, 'initial-estimate');

  const corrected = classifyWorldFactChange({
    previous: fact({ origin: 'inferred', quality: 'estimated' }),
    next: fact({ origin: 'lorebook' }),
  });
  assert.equal(corrected.reason, 'source-correction', '明确资料纠正推测是「纠正」');
  assert.equal(corrected.applies, true);

  const story = classifyWorldFactChange({
    previous: fact({ value: 'closed' }),
    next: fact({ layer: 'state-event', origin: 'story', value: 'open' }),
  });
  assert.equal(story.reason, 'story-change', '门被打开是状态演变，不是纠正');
  assert.equal(story.supersedes !== null, true);

  const rebuilt = classifyWorldFactChange({
    previous: fact({ predicate: 'size' }),
    next: fact({ predicate: 'size', layer: 'state-event', origin: 'story' }),
  });
  assert.equal(rebuilt.reason, 'rebuild', '改尺寸/结构是拆改，跟开门不是一个量级');
});

test('§18.1 静态来源不能复原已被剧情改变的事实', () => {
  const verdict = classifyWorldFactChange({
    previous: fact({ layer: 'state-event', origin: 'story', value: 'open' }),
    next: fact({ layer: 'baseline', origin: 'lorebook', value: 'closed' }),
  });
  assert.equal(verdict.reason, 'rescan-refused');
  assert.equal(verdict.applies, false, '不能写回去');
  assert.ok(verdict.message.includes('state-event'));

  const rescan = staticRescanVerdict({
    existing: fact({ layer: 'state-event', origin: 'story', value: 'open' }),
    incoming: fact({ layer: 'baseline', origin: 'lorebook', value: 'closed' }),
  });
  assert.equal(rescan.applied, false);
  assert.equal(rescan.reason, 'rescan-refused');

  const staticOnly = staticRescanVerdict({
    existing: fact({ origin: 'inferred', quality: 'estimated' }),
    incoming: fact({ origin: 'lorebook' }),
  });
  assert.equal(staticOnly.applied, true, '静态扫描可以纠正旧的推测');
});

test('§18.1 静态扫描不产生状态事件（剧情变化只能来自真实事件）', () => {
  const verdict = staticRescanVerdict({
    existing: fact({ layer: 'state-event', origin: 'story' }),
    incoming: fact({ layer: 'state-event', origin: 'story' }),
  });
  assert.equal(verdict.applied, false);
  assert.ok(verdict.message.includes('不产生状态事件'));
});

test('§18.1 已提升/已搬走/已有剧情状态的陈设不再被补缺', () => {
  assert.equal(staticReplenishVerdict({ previous: null, promotedItemId: 'item_1' }).replenish, false);
  assert.equal(staticReplenishVerdict({ previous: null, present: false }).replenish, false);
  assert.equal(staticReplenishVerdict({ previous: fact({ layer: 'state-event', origin: 'story' }) }).replenish, false);
  assert.equal(staticReplenishVerdict({ previous: fact({ origin: 'inferred' }) }).replenish, true);
});

/* ------------------------------------------------------------------ *
 * §18.4 门窗补丁
 * ------------------------------------------------------------------ */

function patch(overrides = {}) {
  return { objectId: 'D1', locationId: LOC, mapId: MAP, ...overrides };
}

test('§18.4 补丁按候选内顺序应用：先开再锁 与 先锁再开 结果不同', () => {
  const openThenLock = applySpaceStatePatches({
    canonical, locationId: LOC, mapId: MAP,
    patches: [patch({ openingState: 'open' }), patch({ locked: true })],
  });
  assert.deepEqual(openThenLock.states, [{ objectId: DOOR, openingState: 'open', locked: true, material: null, present: true, destroyed: false }]);

  const lockThenOpen = applySpaceStatePatches({
    canonical, locationId: LOC, mapId: MAP,
    patches: [patch({ locked: true }), patch({ openingState: 'open' })],
  });
  assert.deepEqual(lockThenOpen.states, [{ objectId: DOOR, openingState: 'open', locked: true, material: null, present: true, destroyed: false }]);
  // 两段顺序不会把锁「自动解开」：开与锁是独立字段。
  assert.equal(lockThenOpen.states[0].locked, true);
});

test('§18.4 跨图/未声明空间的同名门打不到', () => {
  const foreign = applySpaceStatePatches({
    canonical, locationId: LOC, mapId: MAP,
    patches: [{ objectId: 'D1', locationId: LOC, mapId: 'M_OTHER', openingState: 'open' }],
  });
  assert.deepEqual(foreign.states, []);
  assert.ok(foreign.issues.some((entry) => entry.code === 'SPACE_PATCH_FOREIGN_MAP'));

  const noLocation = applySpaceStatePatches({
    canonical, locationId: LOC, mapId: MAP,
    patches: [{ objectId: 'D1', openingState: 'open' }],
  });
  assert.ok(noLocation.issues.some((entry) => entry.code === 'SPACE_PATCH_LOCATION_REQUIRED'));

  const otherSpace = applySpaceStatePatches({
    canonical, locationId: LOC, mapId: MAP,
    patches: [{ objectId: `space:L_OTHER:furn:D1`, locationId: LOC, mapId: MAP, openingState: 'open' }],
  });
  assert.ok(otherSpace.issues.some((entry) => entry.code === 'SPACE_PATCH_FOREIGN_LOCATION'));
  assert.deepEqual(otherSpace.states, []);
});

test('§18.4 不存在的门不给改状态', () => {
  const result = applySpaceStatePatches({ canonical, locationId: LOC, mapId: MAP, patches: [patch({ objectId: 'D9' })] });
  assert.equal(result.states.length, 0);
  assert.ok(result.issues.some((entry) => entry.code === 'SPACE_PATCH_OBJECT_UNKNOWN'));
});

test('§18.4 模型开锁不解除作者锁，也不改占地', () => {
  const unlock = applySpaceStatePatches({
    canonical, locationId: LOC, mapId: MAP,
    patches: [patch({ locked: false })],
    authorLockedObjectIds: [DOOR],
  });
  assert.deepEqual(unlock.states, []);
  assert.ok(unlock.issues.some((entry) => entry.code === 'SPACE_PATCH_UNLOCK_AUTHOR_LOCKED'));

  const writeAuthorLock = applySpaceStatePatches({
    canonical, locationId: LOC, mapId: MAP,
    patches: [patch({ authorLocked: false })],
  });
  assert.ok(writeAuthorLock.issues.some((entry) => entry.code === 'SPACE_PATCH_AUTHOR_LOCK_REFUSED'));

  const changeFootprint = applySpaceStatePatches({
    canonical, locationId: LOC, mapId: MAP,
    patches: [patch({ widthM: 9 })],
  });
  assert.ok(changeFootprint.issues.some((entry) => entry.code === 'SPACE_PATCH_GEOMETRY_IMMUTABLE'));

  const readOnly = applySpaceStatePatches({ canonical, locationId: LOC, mapId: MAP, patches: [patch({ openingState: 'open' })], readOnly: true });
  assert.ok(readOnly.issues.some((entry) => entry.code === 'SPACE_PATCH_READ_ONLY'));
});

test('§18.4 开窗不等于能走人，玻璃透明不等于空气', () => {
  const glass = `space:${LOC}:furn:G1`;
  const result = applySpaceStatePatches({
    canonical, locationId: LOC, mapId: MAP,
    patches: [{ objectId: 'G1', locationId: LOC, mapId: MAP, openingState: 'open', material: 'glass' }],
  });
  const state = result.states.find((entry) => entry.objectId === glass);
  assert.equal(state.openingState, 'open');
  assert.equal(state.material, 'glass');
  assert.ok(result.issues.some((entry) => entry.code === 'SPACE_PATCH_GLASS_OPEN_NOT_AIR'));

  // 通行结论仍由统一属性判定给出：打开=不挡路，但与「是不是入口」是两件事。
  assert.equal(patchedPassability(state).blocksMovement, false);
  assert.equal(patchedPassability({ objectId: DOOR, openingState: 'closed', locked: true, material: 'wood', present: true, destroyed: false }).blocksMovement, true);
  assert.equal(patchedPassability({ objectId: DOOR, openingState: 'unknown', locked: null, material: null, present: true, destroyed: false }).blocksMovement, null);
  assert.equal(patchedPassability(null).blocksMovement, null);
});

test('§18.4 对象引用归一：短引用全限定到本空间，别的空间的写法直接拒', () => {
  assert.deepEqual(resolvePatchObjectId({ patch: { objectId: 'D1' }, locationId: LOC }), { objectId: DOOR, reasonCode: 'OK' });
  assert.equal(resolvePatchObjectId({ patch: { objectId: 'space:L_OTHER:furn:D1' }, locationId: LOC }).reasonCode, 'FOREIGN_LOCATION');
  assert.equal(resolvePatchObjectId({ patch: { objectId: '' }, locationId: LOC }).reasonCode, 'MISSING');
});

/* ------------------------------------------------------------------ *
 * 状态事实真实进入正文与决策切片（接线）
 * ------------------------------------------------------------------ */

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

function insertFactRow(seed, { id, predicate, value, layer = 'state-event', clockS = 0 }) {
  insertRows(seed.db, 'construction_progress', [{
    branch_id: seed.branchId,
    id,
    row_rev: 1,
    created_turn_id: seed.seedTurnId,
    updated_turn_id: seed.seedTurnId,
    scope_key: 'world-facts:v1',
    kind: 'target',
    subject_key: `fact:${id}`,
    input_signature: `sig_${id}`,
    status: 'processed',
    last_served_seq: 0,
    payload_json: JSON.stringify({
      payloadKind: 'world-fact/v1',
      version: 1,
      id,
      subjectId: DOOR,
      predicate,
      layer,
      origin: 'story',
      producer: 'program',
      sourceKey: null,
      sourceHash: null,
      sourceSpan: null,
      supersedesFactId: null,
      quality: 'confirmed',
      effectiveTurnId: seed.seedTurnId,
      effectiveClockS: clockS,
      value,
    }),
  }]);
}

test('§18.4 门的状态事实进入正文与 NPC 决策切片（同一个读取口）', async () => {
  const seed = await fixture();
  insertFactRow(seed, { id: 'fact_door_open', predicate: 'opening-state', value: 'open' });

  const facts = readActorSceneFacts({ db: seed.db, branchId: seed.branchId }, {
    actorId: IDS.C1, locationId: LOC, position: { kind: 'at_location', precision: 'coarse' },
  });
  const doorLine = facts.lines.find((line) => line.startsWith('可观察入口'));
  assert.ok(doorLine, '入口行必须在');
  assert.ok(doorLine.includes('木门（open）'), `门的当前状态要如实写进正文：${doorLine}`);

  const context = buildDecisionContext({ actors: [{ entityId: IDS.C1 }], opportunities: [] }, { db: seed.db, branchId: seed.branchId });
  const slice = context.actorSlices.find((entry) => entry.entityId === IDS.C1);
  const door = slice.scene.entrances.find((entry) => entry.objectId === DOOR);
  assert.equal(door.openingState, 'open', '决策切片与正文用同一个状态');
  seed.close();
});

test('§18.4 没有状态事实时门是 unknown：不假设开着，也不假设锁着', async () => {
  const seed = await fixture();
  const facts = readActorSceneFacts({ db: seed.db, branchId: seed.branchId }, {
    actorId: IDS.C1, locationId: LOC, position: { kind: 'at_location', precision: 'coarse' },
  });
  const doorLine = facts.lines.find((line) => line.startsWith('可观察入口'));
  assert.ok(doorLine.includes('木门（unknown）'), doorLine);
  seed.close();
});

test('§18.2 已提升成物品的陈设不再在源空间重复占地', async () => {
  const seed = await fixture();
  const bound = { ...canonical, revision: 2, furnishing: canonical.furnishing.map((entry) => (entry.localId === SHELF ? { ...entry, itemId: 'item_desk' } : entry)) };
  seed.db.run('UPDATE maps SET frame_json = ? WHERE branch_id = ? AND id = ?', [
    JSON.stringify({ origin_x: 0, origin_y: 0, reference_width_cells: 20, reference_height_cells: 15, atlasSpaceCanonical: bound, atlasScene: { version: 1 } }),
    seed.branchId, MAP,
  ]);
  const facts = readActorSceneFacts({ db: seed.db, branchId: seed.branchId }, {
    actorId: IDS.C1, locationId: LOC, position: { kind: 'at_location', precision: 'coarse' },
  });
  const blockers = facts.lines.find((line) => line.startsWith('关键陈设与障碍'));
  assert.equal(blockers?.includes('书架') ?? false, false, '已提升的书架不再作为源空间障碍出现');
  assert.equal(facts.context?.blockers.some((entry) => entry.name === '书架'), false);
  seed.close();
});

/* ------------------------------------------------------------------ *
 * §18.2 编译层：家具不批量变物品 / fromFurnishingRef 真的绑定
 * ------------------------------------------------------------------ */

function compile(seed, responseText, { phase = 'observe', refs = null } = {}) {
  const extracted = extractPayload(responseText);
  const parsed = parseOperations(extracted.payload, { phase });
  const anchor = makeAnchor();
  const context = makeCompileContext({ seed, phase, anchor });
  // 来源快照里 S1 是 story：真实提交链路就是按快照键（S1/W1）引用来源的。
  const compiled = compileOperations({
    operations: parsed.operations,
    anchor,
    phase,
    clockS: 0,
    revision: 0,
    tables: context.tables ?? createTableReadPort(seed.db),
    sources: { phase, snapshot: SOURCE_SNAPSHOT, clockS: 0 },
    knownRefs: refs ? [...seed.refs, ...refs] : seed.refs,
  });
  return { parsed, compiled };
}

test('§18.2 普通生成不把家具批量做成 items', async () => {
  const seed = await fixture();
  const refused = compile(seed, JSON.stringify({ op: 'item.upsert', ref: 'new:desk', data: { name: '木桌', kind: 'object' } }));
  assert.ok(refused.compiled.issues.some((entry) => entry.code === 'FURNITURE_AS_ITEM_REFUSED'));
  assert.equal(refused.compiled.merged.mutations.filter((entry) => entry.table === 'items').length, 0);

  // 剧情真的搬动过 → 允许。
  const allowed = compile(seed, JSON.stringify({ op: 'item.upsert', ref: 'new:desk', data: { name: '木桌', kind: 'object' }, source: 'S1' }));
  assert.deepEqual(allowed.compiled.issues.filter((entry) => entry.severity === 'error'), []);
  assert.equal(allowed.compiled.merged.mutations.filter((entry) => entry.table === 'items').length, 1);
  seed.close();
});

test('§18.2 fromFurnishingRef 在编译层解析目录、绑定 itemId，并在同一条 op 内落 sheet', async () => {
  const seed = await fixture();
  const out = compile(seed, JSON.stringify({
    op: 'item.upsert',
    ref: 'new:moved-desk',
    data: { name: '书架', kind: 'object', placement: { location_ref: 'L3' }, fromFurnishingRef: 'F1' },
    source: 'S1',
  }));
  assert.deepEqual(out.compiled.issues.filter((entry) => entry.severity === 'error'), []);

  const itemMutation = out.compiled.merged.mutations.find((entry) => entry.table === 'items');
  const mapMutation = out.compiled.merged.mutations.find((entry) => entry.table === 'maps');
  assert.ok(itemMutation, '物品行要建');
  assert.ok(mapMutation, 'canonical 绑定要在同一条 op 里');
  // mutation.after 里 JSON 列还是「未序列化的结构化值」，落库时由仓储层 stringify；
  // 两种形态都接受，避免把测试绑死在某一层的表示上。
  const rawProperties = itemMutation.after.properties_json;
  const properties = Array.isArray(rawProperties)
    ? rawProperties
    : JSON.parse(String(rawProperties));
  assert.equal(properties.find((entry) => entry.key === 'fromFurnishing').value, SHELF);
  assert.deepEqual(properties.find((entry) => entry.key === 'sizeM').value, { widthM: 3, heightM: 1 });
  assert.equal(itemMutation.after.location_id, LOC, '没有别的落点时按陈设所在地点');

  const boundCanonical = readSpaceCanonical(mapMutation.after.frame_json, LOC).canonical;
  assert.equal(boundCanonical.furnishing.find((entry) => entry.localId === SHELF).itemId, itemMutation.rowId);

  // 真实应用一遍：第二次同样的提升必须被拒，不能建第二张。
  const db = seed.db;
  db.run('BEGIN');
  applyGroups(db, [{
    id: 'g_p12', opIds: out.compiled.results.map((r) => r.opId), dependsOn: [],
    readSet: out.compiled.merged.readSet, mutations: out.compiled.merged.mutations,
    opIssues: out.compiled.issues.filter((entry) => entry.severity === 'error'),
  }], { branchId: seed.branchId, turnId: seed.seedTurnId, attemptId: 'attempt_p12', validate: true });
  db.run('COMMIT');

  const repeated = compile(seed, JSON.stringify({
    op: 'item.upsert',
    ref: 'new:moved-desk-2',
    data: { name: '书架', kind: 'object', placement: { location_ref: 'L3' }, fromFurnishingRef: 'F1' },
    source: 'S1',
  }));
  assert.ok(
    repeated.compiled.issues.some((entry) => entry.code === 'FURNISHING_ALREADY_PROMOTED'),
    '重试/重复事件必须被挡下，而不是新建第二件',
  );
  const itemCount = queryBound(seed.db, 'SELECT COUNT(*) AS n FROM items WHERE branch_id = ?', [seed.branchId])[0].n;
  assert.equal(Number(itemCount), 2, 'seed 的剑 + 提升出来的一张 = 2，没有第三件');
  seed.close();
});

test('§18.2 歧义/未知的陈设引用在编译层直接拒，不凭名字造一件', async () => {
  const seed = await fixture();
  const unknown = compile(seed, JSON.stringify({
    op: 'item.upsert',
    ref: 'new:x',
    data: { name: '书架', kind: 'object', placement: { location_ref: 'L3' }, fromFurnishingRef: 'F9' },
    source: 'S1',
  }));
  assert.ok(unknown.compiled.issues.some((entry) => entry.code === 'PROMOTION_FURNISHING_UNKNOWN'));

  const noLocation = compile(seed, JSON.stringify({
    op: 'item.upsert',
    ref: 'new:y',
    data: { name: '书架', kind: 'object', fromFurnishingRef: 'F1' },
    source: 'S1',
  }));
  assert.ok(noLocation.compiled.issues.some((entry) => entry.code === 'FURNISHING_REF_LOCATION_REQUIRED'));
  seed.close();
});
