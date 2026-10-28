/**
 * atlas-player-view-scope.test.mjs — P08 §14 统一玩家地图与独立角色知识。
 *
 * 核心纪律：
 * 1. 玩家看的是**完整已记录世界**（秘密地点、隐藏房间、全部 NPC），不是主角走过的部分。
 * 2. 玩家看不到内部独白 / 供应商正文 / 未提交候选，正文也不贴质量徽标 —— 但信息进诊断。
 * 3. 地图可见不写 knowledge、不触发 discover；打开/切图/搜索/收纳/换皮肤零模型调用。
 * 4. author 与 player 的缓存、查询、导出作用域分开，不能共用后再抹名字。
 * 5. 未知位置显示未知，界面不许拿目录名字填空。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYER_READ_ONLY_TABLES,
  PLAYER_ZERO_MODEL_ACTIONS,
  assertPlayerReadIsPure,
  cacheMayServe,
  isAuthorScope,
  isPovScope,
  migrateViewModePreference,
  playerActionEffect,
  playerDetailPresentation,
  playerPositionLabel,
  presentScaleLabel,
  resolveMapGeometrySource,
  resolveViewScope,
  scopeDisclosure,
  seesRecordedAction,
  seesWholeRecordedWorld,
  stripScopeFields,
  summarizePlayerActions,
  toRequestViewMode,
  viewScopeKey,
} from '../src/atlas-player-view-scope.ts';

// ── 1. 作用域归一 ───────────────────────────────────────────────────────────

test('P08: 缺字段/空串/未知值一律落到玩家视图，作者后台必须显式声明', () => {
  for (const value of [undefined, null, '', '   ', 'nonsense', 0, {}, []]) {
    assert.equal(resolveViewScope(value), 'player', `${JSON.stringify(value)} 必须默认玩家视图`);
  }
  assert.equal(resolveViewScope('author'), 'author', '作者后台必须能显式进入');
  assert.equal(resolveViewScope('  AUTHOR '), 'author', '大小写与空白不该决定作用域');
});

test('P08: 旧写法 world/full/all 收敛到玩家视图，不收敛到作者', () => {
  for (const legacy of ['world', 'full', 'all', 'viewer']) {
    assert.equal(resolveViewScope(legacy), 'player', `${legacy} 是旧客户端的全量写法`);
    assert.equal(isAuthorScope(legacy), false, `${legacy} 不能顺手拿到作者字段`);
  }
});

test('P08: UI 偏好迁移永远不返回 pov —— 升级后不能仍落回半张地图', () => {
  for (const stored of ['pov', 'player', '主角所知', undefined, null, '', 'POV']) {
    assert.notEqual(migrateViewModePreference(stored), 'pov', `${String(stored)} 迁移后不允许还是 pov`);
  }
  assert.equal(migrateViewModePreference('pov'), 'player', '旧 pov 偏好 → 玩家视图');
  assert.equal(migrateViewModePreference('author'), 'author', '作者偏好保留');
});

test('P08: 请求体 viewMode 由 UI 状态派生，且从不产出 pov（不污染正文 query）', () => {
  assert.equal(toRequestViewMode('player'), 'player');
  assert.equal(toRequestViewMode('author'), 'author');
  assert.equal(toRequestViewMode('pov'), 'player', 'UI 上没有「主角所知」这个模式了');
  for (const value of [undefined, null, 'pov', 'world', 42]) {
    assert.notEqual(toRequestViewMode(value), 'pov');
  }
});

test('P08: player 与 author 都看完整已记录世界，只有 pov 按认知裁剪', () => {
  assert.equal(seesWholeRecordedWorld('player'), true);
  assert.equal(seesWholeRecordedWorld('author'), true);
  assert.equal(seesWholeRecordedWorld('pov'), false);
  assert.equal(isPovScope('pov'), true);
  assert.equal(isPovScope('player'), false);
});

test('P08: 已记录行动对玩家可见，内部独白只有作者可见', () => {
  assert.equal(seesRecordedAction('player'), true, '§14.6 NPC 已记录行动对玩家可见');
  assert.equal(seesRecordedAction('author'), true);
  assert.equal(seesRecordedAction('pov'), false);
  const player = scopeDisclosure('player');
  assert.equal(player.internalMonologue, false, 'thought 是后台想法，玩家不给');
  assert.equal(player.supplierProse, false);
  assert.equal(player.unsubmittedCandidates, false);
  assert.equal(player.technicalProvenance, false);
  assert.equal(player.qualityBadges, false);
  const author = scopeDisclosure('author');
  for (const key of Object.keys(author)) assert.equal(author[key], true, `author.${key} 必须为真`);
  const pov = scopeDisclosure('pov');
  assert.equal(pov.internalMonologue, false);
  assert.equal(pov.technicalProvenance, false);
});

// ── 2. 行级清洗 ─────────────────────────────────────────────────────────────

test('P08: 玩家行清洗掉 thought/importance_reason 与供应商正文，保留已记录行动', () => {
  const row = {
    id: 'C1', name: '老王', thought: '他怀疑主角在说谎', importance_reason: '线索节点',
    action_tendency: '在柜台后擦杯子', reasoning: '供应商推理正文', raw_response: '原始响应',
    candidates: [{ op: 'character.upsert' }], location_id: 'L1', status: 'active',
  };
  const player = stripScopeFields(row, 'player', 'characters');
  assert.equal(player.thought, undefined, '内部独白不进玩家视图');
  assert.equal(player.importance_reason, undefined, '重要性理由属于作者账本');
  assert.equal(player.reasoning, undefined);
  assert.equal(player.raw_response, undefined);
  assert.equal(player.candidates, undefined, '未提交候选不许导出');
  assert.equal(player.action_tendency, '在柜台后擦杯子', '已记录行动必须保留');
  assert.equal(player.name, '老王');
  assert.equal(player.location_id, 'L1');
});

test('P08: 作者作用域原样返回同一个引用，不做无意义拷贝', () => {
  const row = { id: 'C1', thought: '后台想法', action_tendency: '行动' };
  assert.equal(stripScopeFields(row, 'author', 'characters'), row, 'author 不拷贝');
  assert.equal(stripScopeFields(row, 'pov', 'characters').thought, undefined, 'pov 同样不给独白');
});

test('P08: 表名只影响结构性字段，供应商正文对任何表都清', () => {
  const row = { id: 'L1', name: '月台', prompt: '生成提示词', completion: '模型输出' };
  const cleaned = stripScopeFields(row, 'player', 'locations');
  assert.deepEqual(Object.keys(cleaned).sort(), ['id', 'name']);
});

// ── 3. 位置与尺度文案 ───────────────────────────────────────────────────────

test('P08: 未知位置显示未知，即使调用方塞了名字也不显示', () => {
  const label = playerPositionLabel({ kind: 'unknown' }, '雾港·下层');
  assert.equal(label.text, '位置未知');
  assert.equal(label.quality, 'unknown');
  assert.equal(label.fabricated, false);
  assert.equal(label.text.includes('雾港'), false, '界面不许拿目录名字填空');
});

test('P08: 地点级位置用「约」，精确格位才敢说确定', () => {
  assert.deepEqual(
    (({ text, quality, approximate }) => ({ text, quality, approximate }))(playerPositionLabel({ kind: 'at_grid', precision: 'exact' })),
    { text: '图上精确位置', quality: 'exact', approximate: false },
  );
  const rough = playerPositionLabel({ kind: 'at_grid', precision: 'approximate' });
  assert.equal(rough.quality, 'approximate');
  assert.equal(rough.approximate, true);
  const coarse = playerPositionLabel({ kind: 'at_location', locationId: 'L1' }, '月台');
  assert.equal(coarse.text, '约在 月台');
  assert.equal(coarse.quality, 'approximate');
});

test('P08: 格位精度 unknown 与 kind unknown 同等对待，不冒充实测', () => {
  const label = playerPositionLabel({ kind: 'at_grid', precision: 'unknown' });
  assert.equal(label.text, '位置未知');
  assert.equal(label.quality, 'unknown');
  const transit = playerPositionLabel({ kind: 'in_transit' });
  assert.equal(transit.approximate, true);
  assert.equal(transit.fabricated, false);
});

test('P08: 尺度用「约」表达，锁定过才是确定值', () => {
  const open = presentScaleLabel({ metersPerCell: 0.5, quality: 'estimated' });
  assert.equal(open.text, '约每格 0.5 米');
  assert.equal(open.approximate, true);
  assert.deepEqual(open.diagnostics, []);
  const locked = presentScaleLabel({ metersPerCell: 0.5, quality: 'confirmed' });
  assert.equal(locked.text, '每格 0.5 米');
  assert.equal(locked.approximate, false);
  const missing = presentScaleLabel({ metersPerCell: null });
  assert.equal(missing.text, '尺度未知');
  assert.equal(missing.diagnostics[0].code, 'SCALE_UNKNOWN');
});

// ── 4. 详情展示路由 ─────────────────────────────────────────────────────────

test('P08: 玩家详情不贴质量徽标，但推测补全照样进诊断', () => {
  const player = playerDetailPresentation({
    scope: 'player', existenceQuality: 'inferred', sourceBasis: 'lorebook:W1#h1',
    scale: { metersPerCell: 0.5, quality: 'estimated' },
  });
  assert.deepEqual(player.badges, [], '§14.7 不强制贴「推测补全」徽标');
  assert.equal(player.scale, '约每格 0.5 米');
  assert.ok(player.diagnostics.some((entry) => entry.code === 'EXISTENCE_INFERRED'), '信息不丢，只是换通道');
  assert.ok(player.diagnostics.some((entry) => entry.code === 'SOURCE_BASIS'));
  assert.ok(player.diagnostics.some((entry) => entry.code === 'SCALE_UNKNOWN') === false, '有尺度就不该报未知');
});

test('P08: 作者视图可以拿徽标，玩家视图恒为空数组', () => {
  const author = playerDetailPresentation({ scope: 'author', existenceQuality: 'hypothetical', sourceBasis: 'story:S1' });
  assert.deepEqual(author.badges, ['existence:hypothetical', 'source:basis']);
  const player = playerDetailPresentation({ scope: 'player', existenceQuality: 'hypothetical' });
  assert.deepEqual(player.badges, []);
  assert.ok(player.diagnostics.some((entry) => entry.code === 'EXISTENCE_HYPOTHETICAL'));
});

test('P08: 已确认记录不产生存在性诊断，避免诊断被噪音淹没', () => {
  const confirmed = playerDetailPresentation({ scope: 'player', existenceQuality: 'confirmed' });
  assert.equal(confirmed.diagnostics.some((entry) => entry.code.startsWith('EXISTENCE_')), false);
});

// ── 5. 几何来源（不残留另一张图的几何）────────────────────────────────────────

test('P08: 已保存帧自报别的 mapId 时整份拒收，不画到当前图上', () => {
  const resolution = resolveMapGeometrySource({
    mapId: 'M2',
    saved: { mapId: 'M1', layout: { kind: 'floor' } },
    overview: { mapId: 'M2', layout: { kind: 'overview' } },
  });
  assert.equal(resolution.source, 'overview', '拒收后应退到本图概览');
  assert.equal(resolution.geometry.mapId, 'M2');
  assert.ok(resolution.rejected.some((entry) => entry.code === 'MAP_GEOMETRY_FOREIGN_MAP'));
});

test('P08: 两份都自报别的图时退回 none，界面显示待生成而不是画错图', () => {
  const resolution = resolveMapGeometrySource({
    mapId: 'M2',
    saved: { mapId: 'M1', layout: { kind: 'floor' } },
    overview: { mapId: 'M9', layout: { kind: 'overview' } },
  });
  assert.equal(resolution.geometry, null);
  assert.equal(resolution.source, 'none');
  assert.equal(resolution.rejected.length, 2);
});

test('P08: 没有自报 mapId 的文档按未校验放行，不假装校验过', () => {
  const resolution = resolveMapGeometrySource({ mapId: 'M2', saved: { layout: { kind: 'floor' } } });
  assert.equal(resolution.source, 'saved');
  assert.equal(resolution.unverified, true, '没校验过就是没校验过');
  const verified = resolveMapGeometrySource({ mapId: 'M2', saved: { mapId: 'M2', layout: { kind: 'floor' } } });
  assert.equal(verified.unverified, false);
  assert.deepEqual(verified.rejected, []);
});

// ── 6. 零模型调用 ───────────────────────────────────────────────────────────

test('P08: 打开/切图/搜索/收纳/换皮肤全部零模型调用', () => {
  for (const action of ['open-map', 'switch-map', 'search', 'collapse', 'skin', 'toggle-layer', 'zoom']) {
    const effect = playerActionEffect(action);
    assert.equal(effect.sendsModel, false, `${action} 不能发模型`);
    assert.equal(effect.modelCalls, 0);
    assert.equal(effect.classified, true, `${action} 必须登记在零模型动作表里`);
  }
  assert.ok(PLAYER_ZERO_MODEL_ACTIONS.includes('skin'), '换皮肤属于纯界面动作');
});

test('P08: 点地图 10 次 = 0 次模型调用，且不留未登记动作', () => {
  const clicks = Array.from({ length: 10 }, (_, index) => (index % 2 ? 'open-map' : 'select-entity'));
  const summary = summarizePlayerActions(clicks);
  assert.equal(summary.actions, 10);
  assert.equal(summary.modelCalls, 0);
  assert.deepEqual(summary.unclassified, []);
});

test('P08: 未登记动作如实报未分类，不冒充「零模型」', () => {
  const summary = summarizePlayerActions(['open-map', 'regenerate-world']);
  assert.equal(summary.modelCalls, 0);
  assert.deepEqual(summary.unclassified, ['regenerate-world'], '未登记动作必须被点名');
});

// ── 7. 只读纯净性 ───────────────────────────────────────────────────────────

test('P08: 地图可见不写 knowledge/events/characters', () => {
  assert.deepEqual(assertPlayerReadIsPure(['knowledge', 'events', 'characters']), ['knowledge', 'events', 'characters']);
  assert.deepEqual(assertPlayerReadIsPure(['ui_preferences']), [], '只读表之外的写入不属于这条守卫的职责');
  assert.ok(PLAYER_READ_ONLY_TABLES.includes('knowledge'));
  assert.ok(PLAYER_READ_ONLY_TABLES.includes('events'));
});

// ── 8. 作用域缓存隔离 ───────────────────────────────────────────────────────

test('P08: author 缓存不能服务玩家请求，哪怕只差一个字段', () => {
  assert.equal(cacheMayServe('author', 'player'), false, '§14.9 不能共用缓存后只抹名字');
  assert.equal(cacheMayServe('player', 'author'), false);
  assert.equal(cacheMayServe('player', 'player'), true);
  assert.equal(cacheMayServe('world', 'player'), true, '归一化后同一个作用域可以共用');
});

test('P08: 作用域键把 scope 与 povId 分开，player/author 不受 povId 影响', () => {
  const base = { chatUid: 'chat-1', branchId: 'main', revision: 7 };
  const playerA = viewScopeKey({ ...base, scope: 'player', povId: 'C1' });
  const playerB = viewScopeKey({ ...base, scope: 'player', povId: 'C2' });
  assert.equal(playerA, playerB, '全量作用域与 POV 无关');
  const author = viewScopeKey({ ...base, scope: 'author', povId: 'C1' });
  assert.notEqual(author, playerA, '作者与玩家的键必须不同');
  const povA = viewScopeKey({ ...base, scope: 'pov', povId: 'C1' });
  const povB = viewScopeKey({ ...base, scope: 'pov', povId: 'C2' });
  assert.notEqual(povA, povB, '角色认知必须按 povId 分开');
  assert.notEqual(povA, playerA);
});

test('P08: 修订变化让作用域键失效，不会拿上一修订的缓存', () => {
  const a = viewScopeKey({ scope: 'player', chatUid: 'c', branchId: 'main', revision: 1 });
  const b = viewScopeKey({ scope: 'player', chatUid: 'c', branchId: 'main', revision: 2 });
  assert.notEqual(a, b);
});
