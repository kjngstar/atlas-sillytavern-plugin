/**
 * atlas-scene-entry.test.mjs — P10 §16.1/§16.2/§16.3 进入触发与正文空间投影。
 *
 * 核心纪律：
 * 1. 意图（我想进去）、点地图、hover、生成按钮都**不触发**建设。
 * 2. 触发要同时具备：已确认事件 + 合法编译后位置变化 + 楼层已保存。
 * 3. 主角从父层粗归属细化到同一房间的坐标，不重复触发。
 * 4. 进入一个设施只激活它和必要已知子空间，不扩成整座城。
 * 5. 正文投影原子保留 frame/自身/障碍；超预算只丢可选条目，并且必须可诊断。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENE_ENTRY_NON_TRIGGERS,
  buildActorSceneContext,
  collectConfirmedSceneEntries,
  interiorContextReadiness,
  renderActorSceneContextLines,
  sceneEntryActivation,
  sceneEntryDedupeKey,
} from '../src/atlas-scene-entry.ts';

const event = (overrides = {}) => ({
  eventId: 'E1', turnId: 'turn-7', type: 'enter', actorId: 'C1',
  fromLocationId: 'L1', toLocationId: 'L2', occurredAtS: 100, confirmed: true, ...overrides,
});
const move = (overrides = {}) => ({
  actorId: 'C1', turnId: 'turn-7', previousLocationId: 'L1', locationId: 'L2', compiled: true, kind: 'moved', interiorMapId: null, ...overrides,
});
const collect = (overrides = {}) => collectConfirmedSceneEntries({
  events: [event()], positionChanges: [move()], savedFloorIds: ['turn-7'], protagonistId: 'C1', ...overrides,
});

// ── 1. 什么算进入 ───────────────────────────────────────────────────────────

test('P10: 已确认事件 + 编译后移位 + 楼层已保存 → 产生一条进入', () => {
  const { entries, issues } = collect();
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.actorId, 'C1');
  assert.equal(entry.fromLocationId, 'L1');
  assert.equal(entry.toLocationId, 'L2');
  assert.equal(entry.isProtagonist, true);
  assert.equal(entry.turnId, 'turn-7');
  assert.equal(issues.length, 0);
});

test('P10: 用户意图/点地图/hover/生成按钮都不在触发来源里', () => {
  for (const source of ['user-intent', 'map-click', 'map-hover', 'generate-button']) {
    assert.ok(SCENE_ENTRY_NON_TRIGGERS.includes(source), `${source} 必须被显式列为不触发`);
  }
  // 即使把意图塞进来，没有确认事件也不会产生进入。
  const { entries } = collectConfirmedSceneEntries({ events: [], positionChanges: [], savedFloorIds: ['turn-7'], intents: [{ source: 'user-intent' }] });
  assert.equal(entries.length, 0);
});

test('P10: 未确认来源的事件不触发（模型提议不是剧情进入）', () => {
  const { entries, issues } = collect({ events: [event({ confirmed: false })] });
  assert.equal(entries.length, 0);
  assert.ok(issues.some((entry) => entry.code === 'SCENE_ENTRY_NOT_CONFIRMED'));
});

test('P10: 楼层没保存时先记账不建内部 —— 正文 N 不能提前看到内部布局', () => {
  const { entries, issues } = collect({ savedFloorIds: [] });
  assert.equal(entries.length, 0);
  assert.ok(issues.some((entry) => entry.code === 'SCENE_ENTRY_FLOOR_UNSAVED'));
});

test('P10: 没有合法编译后的位置变化就不算进入', () => {
  assert.equal(collect({ positionChanges: [] }).entries.length, 0);
  assert.equal(collect({ positionChanges: [move({ compiled: false })] }).entries.length, 0);
  assert.ok(collect({ positionChanges: [move({ compiled: false })] }).issues.some((entry) => entry.code === 'SCENE_ENTRY_NO_COMPILED_MOVE'));
});

test('P10: 主角从父层粗归属细化到同一房间不重复触发', () => {
  const { entries, issues } = collect({ positionChanges: [move({ kind: 'precision-refined' })] });
  assert.equal(entries.length, 0);
  assert.ok(issues.some((entry) => entry.code === 'SCENE_ENTRY_PRECISION_ONLY'));
});

test('P10: 编译后位置与事件说法不一致时以编译结果为准，不触发', () => {
  const { entries, issues } = collect({ positionChanges: [move({ locationId: 'L3' })] });
  assert.equal(entries.length, 0);
  assert.ok(issues.some((entry) => entry.code === 'SCENE_ENTRY_POSITION_MISMATCH'));
});

test('P10: 本来就在该地点不算进入', () => {
  const { entries, issues } = collect({ positionChanges: [move({ previousLocationId: 'L2' })] });
  assert.equal(entries.length, 0);
  assert.ok(issues.some((entry) => entry.code === 'SCENE_ENTRY_NO_MOVEMENT'));
});

test('P10: 重复 received/ended 与同文重放不建第二个 job', () => {
  const twice = collect({ events: [event(), event({ eventId: 'E1-replay' })] });
  assert.equal(twice.entries.length, 1);
  assert.ok(twice.issues.some((entry) => entry.code === 'SCENE_ENTRY_DUPLICATE'));
  assert.equal(
    sceneEntryDedupeKey({ actorId: 'C1', toLocationId: 'L2', turnId: 'turn-7' }),
    sceneEntryDedupeKey({ actorId: 'C1', toLocationId: 'L2', turnId: 'turn-7', interiorMapId: null }),
  );
});

test('P10: NPC 先抵达不算主角进入，NPC 可以先用设施拓扑', () => {
  const { entries } = collect({
    events: [event({ actorId: 'C2', eventId: 'E2' })],
    positionChanges: [move({ actorId: 'C2' })],
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].actorId, 'C2');
  assert.equal(entries[0].isProtagonist, false, 'NPC 到达不能冒充主角进入');
});

test('P10: 进入记录按 dedupeKey 稳定排序，便于逐条核对', () => {
  const { entries } = collect({
    events: [event({ actorId: 'C3', eventId: 'E3', toLocationId: 'L9' }), event()],
    positionChanges: [move({ actorId: 'C3', locationId: 'L9' }), move()],
  });
  assert.deepEqual(entries.map((entry) => entry.actorId), ['C1', 'C3']);
});

// ── 2. 激活范围 ─────────────────────────────────────────────────────────────

test('P10: 进入设施只激活该设施与必要已知子空间，不扩成整座城', () => {
  const { entries } = collect();
  const targets = [
    { id: 'T1', subjectId: 'L2', workKind: 'map-layout', status: 'waiting-for-entry' },
    { id: 'T2', subjectId: 'L3', workKind: 'map-layout', status: 'waiting-for-entry' },
    { id: 'T3', subjectId: 'L9', workKind: 'map-layout', status: 'waiting-for-entry' },
    { id: 'T4', subjectId: 'L2', workKind: 'map-layout', status: 'pending' },
  ];
  const activation = sceneEntryActivation(entries[0], targets, ['L3']);
  assert.deepEqual(activation.activateTargetIds, ['T1', 'T2'], '只有设施本身与已知子空间');
  assert.equal(activation.expandToSettlement, false, '进入一个设施不等于要求建设整片聚落');
  const narrow = sceneEntryActivation(entries[0], targets);
  assert.deepEqual(narrow.activateTargetIds, ['T1'], '没给已知子空间时只激活设施本身');
});

// ── 3. 时序 ─────────────────────────────────────────────────────────────────

test('P10: 本轮刚进入时内部布局从下一轮才提供', () => {
  const readiness = interiorContextReadiness({ interiorMapId: 'M2', layoutSaved: true, entryTurnId: 'turn-7', currentTurnId: 'turn-7' });
  assert.equal(readiness.ready, false);
  assert.match(readiness.note, /下一轮/);
});

test('P10: 布局没保存就说未就绪，不编造家具与尺寸', () => {
  const readiness = interiorContextReadiness({ interiorMapId: 'M2', layoutSaved: false, entryTurnId: 'turn-7', currentTurnId: 'turn-8' });
  assert.equal(readiness.ready, false);
  assert.match(readiness.note, /不编造家具或尺寸/);
  assert.equal(interiorContextReadiness({ interiorMapId: 'M2', layoutSaved: true, entryTurnId: 'turn-7', currentTurnId: 'turn-8' }).ready, true);
});

// ── 4. 正文空间投影 ─────────────────────────────────────────────────────────

const contextInput = (overrides = {}) => ({
  actorId: 'C1',
  location: { locationId: 'L3', name: '教室', kind: 'room', mapId: 'M2', units: 'meters', metersPerCell: 0.5, precision: 'exact' },
  ancestors: [{ locationId: 'L1', name: '圣罗兰城', kind: 'city' }, { locationId: 'L2', name: '圣光学校', kind: 'building' }, { locationId: 'L3', name: '教室', kind: 'room' }],
  position: { kind: 'at_grid', precision: 'exact' },
  entrances: [{ objectId: 'D1', name: '木门', kind: 'door', openingState: 'closed', locked: true }],
  obstacles: [
    { objectId: 'F1', name: '书架', kind: 'furniture', footprintMeters: { widthM: 3, heightM: 1 } },
    { objectId: 'G1', name: '玻璃隔断', kind: 'glass', material: 'glass', footprintCells: 2 },
  ],
  ...overrides,
});

test('P10: 正文投影给真实占地与通行状态，不给整世界几何', () => {
  const context = buildActorSceneContext(contextInput());
  assert.equal(context.location.locationId, 'L3');
  assert.deepEqual(context.location.chain.map((node) => node.name), ['圣罗兰城', '圣光学校', '教室']);
  const shelf = context.blockers.find((blocker) => blocker.objectId === 'F1');
  assert.deepEqual(shelf.footprintMeters, { widthM: 3, heightM: 1 });
  assert.equal(shelf.footprintCells, 12, '3×1 米在 0.5 米/格下是 12 格');
  assert.equal(shelf.blocksMovement, true, '家具占位就是挡路：占地大小只影响挡不挡视线');
  assert.equal(shelf.blocksSight, true, '3×1 米换算成 12 格，够高够大要挡视线');
  const glass = context.blockers.find((blocker) => blocker.objectId === 'G1');
  assert.equal(glass.blocksMovement, true, '玻璃是实体隔断');
  assert.equal(glass.blocksSight, false, '玻璃可透视');
  assert.deepEqual(context.diagnostics, []);
});

test('P10: 通行状态未知时明确禁止假设可以穿过', () => {
  const context = buildActorSceneContext(contextInput({ obstacles: [{ objectId: 'D9', name: '暗门', kind: 'door' }] }));
  assert.ok(context.constraints.some((constraint) => constraint.code === 'UNKNOWN_OBSTRUCTION'));
  const lines = renderActorSceneContextLines(context);
  assert.ok(lines.some((line) => line.includes('不得假设可以穿过')), '正文必须看到这条约束');
});

test('P10: 容量不足时原子保留自身与障碍，只丢可选人物并报诊断', () => {
  const actors = Array.from({ length: 40 }, (_, index) => ({ entityId: `C${index}`, name: `路人${index}`, presence: 'here', lastKnownLocationId: 'L3' }));
  const context = buildActorSceneContext(contextInput({ actors, charLimit: 600 }));
  assert.equal(context.truncated, true);
  assert.ok(context.diagnostics.some((entry) => entry.code === 'SCENE_CONTEXT_TRUNCATED'));
  assert.equal(context.blockers.length, 2, '障碍一个都不许丢：丢了就等于说「没写＝不挡路」');
  assert.equal(context.entrances.length, 1);
  assert.ok(context.actors.length < actors.length);
  assert.equal(context.capacity.dropped, actors.length - context.actors.length);
});

test('P10: 没有地点时只给位置状态，不编造场景', () => {
  const context = buildActorSceneContext({ actorId: 'C1', location: null, position: { kind: 'unknown' } });
  assert.equal(context.location, null);
  assert.equal(context.self.label, '位置未知');
  assert.ok(context.diagnostics.some((entry) => entry.code === 'SCENE_CONTEXT_LOCATION_MISSING'));
});

test('P10: 内部未就绪写成结构状态约束，不当成缺数据丢掉', () => {
  const context = buildActorSceneContext(contextInput({
    interior: interiorContextReadiness({ interiorMapId: 'M2', layoutSaved: false, entryTurnId: 'turn-7', currentTurnId: 'turn-8' }),
  }));
  assert.ok(context.constraints.some((constraint) => constraint.code === 'INTERIOR_LAYOUT_NOT_READY'));
});

test('P10: 渲染行含地点链、尺度用「约」、障碍带占地', () => {
  const lines = renderActorSceneContextLines(buildActorSceneContext(contextInput()));
  assert.ok(lines.some((line) => line.startsWith('所在地点：圣罗兰城 › 圣光学校 › 教室')));
  assert.ok(lines.some((line) => line.includes('约每格 0.5 米')), '尺度必须用「约」表达精度');
  assert.ok(lines.some((line) => line.includes('书架（3×1 米')));
});
