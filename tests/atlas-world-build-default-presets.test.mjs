/**
 * atlas-world-build-default-presets.test.mjs — P13 §19.3 / §19.4：默认与自定义严格分开。
 *
 * 最容易造成的伤害是「升级顺手改坏了用户预设」。所以这里钉的是**不变性**：
 * 1. 只有带结构标记（origin/builtinId/builtinVersion）的段才算内置；
 *    叫「默认」但没标记的用户副本一律按自定义处理，一个字节都不改；
 * 2. 内置段升级只换自己的文字与版本号，顺序、角色、启用状态、作者加段全部原样；
 * 3. 自定义预设只提示、不追加说明、不自动切换；
 * 4. 预览与实际请求共用一个组装函数，消息逐条一致。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_SEGMENT_ORIGIN,
  builtinSegments,
  classifyPreset,
  isBuiltinSegment,
  planBuiltinPresetUpgrade,
  presetCompatibilityNotice,
} from '../src/atlas-prompt-preset-migrate.ts';
import {
  DEFAULT_SQL_PROMPT_SEGMENTS,
  SQL_BUILTIN_PROMPT_CATALOG,
  SQL_PROMPT_CATALOG_VERSION,
  sqlPromptPresetNotice,
  upgradeBuiltinSqlPromptPreset,
} from '../src/atlas-sql-prompts.ts';
import { PROMPT_POLICY_VERSION } from '../src/atlas-prompt-layers.ts';

const catalog = [
  { builtinId: 'seg-a', version: 'v2', name: 'A', role: 'system', content: '新 A 文字' },
  { builtinId: 'seg-b', version: 'v2', name: 'B', role: 'system', content: '新 B 文字' },
];

function builtin(overrides = {}) {
  return {
    origin: BUILTIN_SEGMENT_ORIGIN,
    builtinId: 'seg-a',
    builtinVersion: 'v1',
    role: 'system',
    name: 'A',
    content: '旧 A 文字',
    enabled: true,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * §19.3 识别
 * ------------------------------------------------------------------ */

test('§19.3 内置身份只认结构标记，不认名字', () => {
  assert.equal(isBuiltinSegment(builtin()), true);
  assert.equal(isBuiltinSegment({ ...builtin(), origin: undefined }), false);
  assert.equal(isBuiltinSegment({ ...builtin(), builtinVersion: '' }), false);

  // 名字叫「默认」但没有任何标记 → 自定义，绝不能被当成内置改写。
  const fakeDefault = [{ role: 'system', name: '默认', content: '作者自己写的默认预设' }];
  assert.equal(classifyPreset(fakeDefault), 'custom');
  assert.equal(classifyPreset([builtin(), { role: 'system', name: '作者加的段', content: 'x' }]), 'mixed');
  assert.equal(classifyPreset([builtin()]), 'builtin');
});

/* ------------------------------------------------------------------ *
 * §19.3 升级
 * ------------------------------------------------------------------ */

test('§19.3 自定义预设原样返回：changed=false，字节不变', () => {
  const custom = [
    { role: 'system', name: '默认', content: '我的规则：简短。' },
    { role: 'user', name: '输入', content: '{{worldState}}' },
  ];
  const snapshot = JSON.stringify(custom);
  const plan = planBuiltinPresetUpgrade({ segments: custom, catalog });
  assert.equal(plan.presetClass, 'custom');
  assert.equal(plan.changed, false);
  assert.equal(JSON.stringify(plan.segments), snapshot, '自定义预设不允许被改一个字节');
  assert.deepEqual(plan.upgradedSegmentIds, []);
});

test('§19.3 内置段只换自己：顺序/角色/启用状态/作者加段全部保留', () => {
  const segments = [
    builtin({ builtinId: 'seg-a', content: '旧 A 文字', enabled: false }),
    { role: 'user', name: '作者加的输入段', content: '{{lastTurn}}', enabled: true },
    builtin({ builtinId: 'seg-b', builtinVersion: 'v2', name: 'B', content: '新 B 文字' }),
  ];
  const plan = planBuiltinPresetUpgrade({ segments, catalog });
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.upgradedSegmentIds, ['seg-a'], '已是最新的 seg-b 不再重复升级');
  assert.equal(plan.segments.length, 3, '不增不删段');
  assert.equal(plan.segments[0].content, '新 A 文字');
  assert.equal(plan.segments[0].enabled, false, '作者的停用状态不能被升级顺手打开');
  assert.equal(plan.segments[0].name, 'A', '段名不因升级而变化');
  assert.equal(plan.segments[1].role, 'user');
  assert.equal(plan.segments[1].content, '{{lastTurn}}', '作者段原样保留');
  assert.equal(plan.segments[2].content, '新 B 文字');
});

test('§19.3 内置段已下架：原文保留并报告，不删段也不清空', () => {
  const plan = planBuiltinPresetUpgrade({
    segments: [builtin({ builtinId: 'seg-gone', content: '旧文字' })],
    catalog,
  });
  assert.equal(plan.changed, false);
  assert.equal(plan.segments[0].content, '旧文字');
  assert.deepEqual(plan.unknownBuiltinIds, ['seg-gone']);
  assert.ok(plan.issues.some((issue) => issue.code === 'PRESET_BUILTIN_SEGMENT_UNKNOWN'));
});

/* ------------------------------------------------------------------ *
 * §19.3 提示（只提示，不自动切换）
 * ------------------------------------------------------------------ */

test('§19.3 自定义预设只给兼容提示，且永远 autoSwitch=false', () => {
  const notice = presetCompatibilityNotice({
    segments: [{ role: 'system', name: '默认', content: '作者写的' }],
  });
  assert.equal(notice.needsAttention, true);
  assert.equal(notice.code, 'PRESET_CUSTOM_POLICY_MAYBE_BEHIND');
  assert.equal(notice.autoSwitch, false);
  assert.ok(notice.message.includes(PROMPT_POLICY_VERSION), '提示里要带当前策略版本号，用户才知道差在哪');
  assert.ok(notice.message.includes('不会追加'), '要明说程序不会偷偷补说明');
});

test('§19.3 内置预设落后时提示可另存，而不是自动替换', () => {
  const notice = presetCompatibilityNotice({
    segments: [builtin({ builtinVersion: 'v0' })],
  });
  assert.equal(notice.code, 'PRESET_BUILTIN_OUTDATED');
  assert.equal(notice.autoSwitch, false);
  assert.ok(notice.message.includes('不会自动替换'));

  const ok = presetCompatibilityNotice({ segments: [builtin({ builtinVersion: PROMPT_POLICY_VERSION })] });
  assert.equal(ok.needsAttention, false, '内置已是最新时不要打扰用户');
});

/* ------------------------------------------------------------------ *
 * §19.3 真实内置目录
 * ------------------------------------------------------------------ */

test('§19.3 内置目录一段一身份，默认段可直接升级且不产生空升级', () => {
  assert.ok(SQL_BUILTIN_PROMPT_CATALOG.length >= 6);
  const ids = SQL_BUILTIN_PROMPT_CATALOG.map((entry) => entry.builtinId);
  assert.equal(new Set(ids).size, ids.length, '内置 ID 必须唯一');
  for (const entry of SQL_BUILTIN_PROMPT_CATALOG) {
    assert.ok(entry.content.trim().length > 0, `${entry.builtinId} 不能是空段`);
    assert.ok(entry.version.trim().length > 0);
  }

  assert.equal(classifyPreset(DEFAULT_SQL_PROMPT_SEGMENTS), 'builtin');
  const upgrade = upgradeBuiltinSqlPromptPreset(DEFAULT_SQL_PROMPT_SEGMENTS);
  assert.equal(upgrade.changed, false, '默认段就是当前版本：升级必须是空操作');

  const notice = sqlPromptPresetNotice(DEFAULT_SQL_PROMPT_SEGMENTS);
  assert.equal(notice.needsAttention, false);
});

test('§19.3 旧版本内置段按目录文字更新，其余不动', () => {
  const stale = DEFAULT_SQL_PROMPT_SEGMENTS.map((segment) => (
    segment.builtinId === 'sql-policy' ? { ...segment, builtinVersion: 'atlas-policy/2026-01-01', content: '旧策略文字' } : { ...segment }
  ));
  const upgrade = upgradeBuiltinSqlPromptPreset(stale);
  assert.equal(upgrade.changed, true);
  assert.deepEqual(upgrade.upgradedSegmentIds, ['sql-policy']);
  const policy = upgrade.segments.find((segment) => segment.builtinId === 'sql-policy');
  assert.equal(policy.builtinVersion, PROMPT_POLICY_VERSION);
  assert.notEqual(policy.content, '旧策略文字');
  assert.equal(upgrade.segments.length, DEFAULT_SQL_PROMPT_SEGMENTS.length, '段数不变');
});

test('§19.3 目录派生：builtinSegments 产出的段都带身份标记', () => {
  const segments = builtinSegments(catalog);
  assert.equal(segments.length, 2);
  for (const segment of segments) {
    assert.equal(segment.origin, BUILTIN_SEGMENT_ORIGIN);
    assert.ok(segment.builtinId);
    assert.ok(segment.builtinVersion);
    assert.equal(segment.enabled, true);
  }
  assert.equal(SQL_PROMPT_CATALOG_VERSION.startsWith('atlas-sql-prompt/'), true);
});

/* ------------------------------------------------------------------ *
 * §19.4 预览与实际请求一致
 * ------------------------------------------------------------------ */

test('§19.4 预览与请求共用组装：同一输入逐条同角色同文本', async () => {
  const { assemblePromptLayers } = await import('../src/atlas-prompt-layers.ts');
  const input = {
    protocol: '固定协议：只输出本阶段允许的操作',
    policy: [{ role: 'system', content: '作者策略段' }],
    task: ['本批阶段：observe', '本批焦点：L1'],
  };
  const preview = assemblePromptLayers(input);
  const request = assemblePromptLayers(input);
  assert.deepEqual(
    preview.map((message) => [message.role, message.content]),
    request.map((message) => [message.role, message.content]),
    '预览与实际请求必须是同一份消息序列',
  );
  assert.equal(preview[0].role, 'system', '协议层永远是第一条');
  assert.equal(preview.length, 1 + input.policy.length + input.task.length);
});
