/**
 * atlas-prompt-layers.test.mjs — P14/§21.5 提示词分层（PROMPT01–PROMPT04）
 *
 * 纪律：
 *  - 预览与实际发送的等价性用**真实 port**证明：`port.preview()` 的结果与 stub 捕获到的
 *    `fetch` body 逐字比较，不是拿自己的复制品跟自己比；
 *  - 能力门控用**真实布局任务**证明：只有 `SPATIAL_CAPABILITIES` 里声明过的能力文字会进提示词，
 *    未实现的字符串一个字都不许出现；
 *  - 策略版本与自定义预设：升级只增加一份带版本的内置策略，用户已另存的预设**逐字节不变**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSqlModelPort } from '../src/atlas-sql-model-port.ts';
import { buildStagePrompt } from '../src/atlas-ops-prompts.ts';
import { createDefaultSettingsV2, settingsViewV2, resolveWorldTurnPreset, applySettingsCommand } from '../src/atlas-settings.ts';
import { DEFAULT_SQL_PROMPT_SEGMENTS } from '../src/atlas-sql-prompts.ts';
import {
  DEFAULT_POLICY_CONTENT, POLICY_SEGMENT_NAME, PROMPT_LAYER_ORDER, PROMPT_POLICY_VERSION,
  TASK_CONTEXT_TEMPLATE, PromptLayerError, assemblePromptLayers, formatTaskContext, promptLayerReport,
} from '../src/atlas-prompt-layers.ts';
import { CAPABILITY_CORRIDOR_BINDING, CAPABILITY_SPACE_CANONICAL, CAPABILITY_SPATIAL_PROFILE, SPATIAL_CAPABILITIES, hasSpatialCapability } from '../src/atlas-world-contract.ts';
import { buildSqlLayoutTask } from '../src/atlas-sql-layout-task.ts';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { makeSeedWith, IDS } from './fixtures/atlas-sql/seed.mjs';

const SQL = await (await import('sql.js')).default();
const clone = (value) => JSON.parse(JSON.stringify(value));
const placeholderLeft = (text) => [...String(text).matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map((m) => m[0]);

/** 自定义预设：一段启用、一段停用（停用段也必须逐字节保留）。 */
const CUSTOM_PRESET = {
  id: 'author-prompt', name: '作者自己的预设', systemPrompt: '', updatedAt: 7,
  segments: [
    { role: 'system', name: '作者策略', content: '按作者自己的口径登记世界；不确定就留空。', enabled: true },
    { role: 'user', name: '停用段', content: '这一段被停用了，升级不许把它删掉。', enabled: false },
  ],
};

function settingsWithCustom() {
  const settings = createDefaultSettingsV2();
  settings.apiPresets = [{ id: 'connection', name: '现有连接', endpoint: 'https://example.test/v1', apiKey: 'fixture-key',
    model: 'fixture-model', maxTokens: 9000, timeoutMs: 30000, temperature: 0.4, updatedAt: 1 }];
  settings.activeApiPresetId = 'connection';
  settings.promptPresets = [clone(CUSTOM_PRESET)];
  settings.activePromptPresetId = CUSTOM_PRESET.id;
  return settings;
}
function portFor(settings) {
  const calls = [];
  const port = createSqlModelPort({ readSettings: async () => settings, fetchFn: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"op":"noop"}' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  return { calls, port };
}
const observeRequest = (batchId = 'observe_probe') => buildStagePrompt({
  phase: 'observe', userSource: '走进图书馆', assistantSource: '你已经来到图书馆。',
  batchId, sourceSnapshot: [{ key: 'story:1', kind: 'story', text: '主角走进图书馆。', hash: 'h-1' }],
});

/* ── PROMPT01 · 自定义预设升级前后深比较一致；新默认策略版本明确 ── */

test('PROMPT01 · 升级策略不动用户已另存的预设：读取视图与运行时组合都逐字节一致', () => {
  const settings = settingsWithCustom();
  const before = clone(CUSTOM_PRESET);
  const stored = clone(settings.promptPresets[0]);
  const view = settingsViewV2(settings);
  const resolved = resolveWorldTurnPreset(settings);
  assert.deepEqual(settings.promptPresets[0], stored, '读取设置视图不得改写用户预设');
  assert.deepEqual(view.promptPresets[0], before, '视图里的用户预设必须与存储一致（含停用段）');
  assert.equal(view.promptPresets[0].segments.length, 2);
  assert.equal(view.promptPresets[0].segments[1].enabled, false, '停用段不许被升级顺手删掉');
  assert.equal(resolved.promptSegments[0].content, before.segments[0].content, '运行时用的是作者原文');
  // 迁移草稿只**新增**一套，原预设仍在且未变。
  const built = applySettingsCommand(settings, { action: 'prompt.migrate-sql', id: CUSTOM_PRESET.id }, { now: () => 2, makeId: () => 'draft' });
  assert.equal(built.ok, true);
  assert.equal(built.settings.activePromptPresetId, CUSTOM_PRESET.id, '迁移不得悄悄改活动预设');
  assert.deepEqual(built.settings.promptPresets[0], stored);
});

test('PROMPT01 · 新默认策略带明确版本标记，且版本号只出现在内置建议预设里', () => {
  assert.equal(PROMPT_POLICY_VERSION, 'atlas-policy/2026-10-11');
  const last = DEFAULT_SQL_PROMPT_SEGMENTS.at(-1);
  assert.equal(last.name, POLICY_SEGMENT_NAME);
  assert.ok(last.name.includes(PROMPT_POLICY_VERSION), '策略版本必须写在段名里，作者一眼能看出新旧');
  assert.equal(last.content, DEFAULT_POLICY_CONTENT);
  for (const line of ['同名但父地点不同的对象保持独立', '不要输出完整 scene、画布坐标、seed', '不要把「已保存」「发过请求」或「有一个场景」声称为整个地图建设完成']) {
    assert.ok(DEFAULT_POLICY_CONTENT.includes(line), `策略文字必须包含「${line}」`);
  }
  const settings = settingsWithCustom();
  const view = settingsViewV2(settings);
  assert.equal(view.promptPolicyVersion, PROMPT_POLICY_VERSION, '设置视图必须上报策略版本供界面显示');
  assert.deepEqual(view.spatialCapabilities, [...SPATIAL_CAPABILITIES], '界面只能照着程序真实声明的能力显示');
  assert.equal(view.builtInSqlPrompt.segments.at(-1).name, POLICY_SEGMENT_NAME);
  for (const segment of view.promptPresets[0].segments) assert.ok(!String(segment.name).includes(PROMPT_POLICY_VERSION),
    '版本标记只属于内置建议预设，不许加到用户预设上');
});

/* ── PROMPT02 · 预览与真实发送的 messages 相等；任务上下文由程序填实 ── */

test('PROMPT02 · 预览与 stub 捕获到的实际 messages 逐字相等，且分层顺序固定', async () => {
  const settings = settingsWithCustom();
  const { calls, port } = portFor(settings);
  const request = observeRequest();
  const preview = await port.preview(request);
  await port.request(request);
  assert.equal(calls.length, 1);
  const sent = calls[0].body.messages;
  assert.deepEqual(preview.messages.map((m) => m.content), sent.map((m) => m.content),
    '预览与实际发送必须是同一组装函数的同一结果');
  assert.deepEqual(preview.messages.map((m) => m.role), sent.map((m) => m.role), '角色也必须一致（作者可能选 user/assistant）');
  assert.equal(preview.promptSource, 'preset');
  // 分层：0 固定协议 → 用户策略 → 任务上下文。
  assert.equal(sent[0].role, 'system');
  assert.ok(sent[0].content.includes('character.upsert'), '第 1 段是程序固定协议（含允许操作帮助）');
  assert.equal(sent[1].content, CUSTOM_PRESET.segments[0].content, '第 2 段是用户策略');
  const policyCount = preview.messages.length - 1 - (sent.length - 2);
  const report = promptLayerReport(sent, policyCount);
  assert.deepEqual(report.map((row) => row.layer), sent.map((_, i) => (i === 0 ? 'protocol' : i <= policyCount ? 'policy' : 'task')));
  assert.equal(report[0].layer, 'protocol');
  assert.equal(report.at(-1).layer, 'task');
  assert.deepEqual([...PROMPT_LAYER_ORDER], ['protocol', 'policy', 'task']);
  assert.equal(preview.coreSaved, false, '预览不是保存结果');
});

test('PROMPT02 · 布局任务的程序任务上下文：目录哈希真实、单位/锁/目标/来源块都填实、无残留花括号', async () => {
  const seed = await makeSeedWith(SQL);
  const bytes = seed.exportBytes(); seed.close();
  const repo = createSqlRepository({ chatUid: IDS.chatA, branchId: IDS.branchMain, modelPort: { calls: [], async request(req) { this.calls.push(req); return { batchId: req.batchId, text: '{"op":"noop"}', httpStatus: 200, durationMs: 1 }; } } });
  await repo.open({ bytes });
  try {
    const anchor = { chatUid: IDS.chatA, branchId: IDS.branchMain, parentTurnId: IDS.seedTurn, hostMessageUid: 'prompt-layers', variantKey: 'v1', baseRevision: 0, baseStorageRevision: 0, inputHash: 'prompt-layers' };
    const task = buildSqlLayoutTask(repo.db, IDS.branchMain, {
      anchor, userText: '注视大地', assistantText: '你看见一座城镇。', manual: false,
      sourceSnapshot: [{ key: 'story:1', kind: 'story', text: '你看见一座城镇。', hash: 'hash-story-1' }],
      phaseBatches: ['observe'], sceneOnly: true, worldCompletion: undefined, layoutMaps: 'active',
    }, 'prompt-layers');
    assert.ok(task, '夹具必须能生成布局任务');
    const text = task.request.messages[1].content;
    assert.ok(text.includes('【本批任务上下文（程序填写，不是可选项）】'), '任务上下文段必须由程序附上');
    assert.deepEqual(placeholderLeft(text), [], '不许把没填的模板花括号发给模型');
    const hash = text.split('\n').find((line) => line.startsWith('冻结目录哈希：')).slice('冻结目录哈希：'.length).trim();
    assert.ok(hash.length >= 8 && hash !== '（无）', `冻结目录哈希必须是真实值，实际 ${JSON.stringify(hash)}`);
    for (const label of ['本批阶段：geography', '允许操作与地图 kind：', '单位与有效幅面：', '锁定事实：', '本批目标：', '未发送待办只作摘要：']) {
      assert.ok(text.includes(label), `任务上下文必须包含「${label}」`);
    }
    assert.match(text, /冻结目录哈希：[^\n]+/);
    // 来源块身份来自真实快照（key/hash），不是编的。
    assert.ok(text.includes('sourceKey=story:1'), '来源块必须列出真实 sourceKey');
    assert.ok(text.includes('contentHash=hash-story-1'), '来源块必须列出真实 contentHash');
    assert.ok(text.includes('chunkKey=story:1#0'));
    // 模板本身也必须逐条落地（不放任模板漂移）。
    for (const line of TASK_CONTEXT_TEMPLATE.split('\n')) {
      if (line.includes('{')) continue;
      assert.ok(text.includes(line), `模板固定行「${line}」必须真的进提示词`);
    }
  } finally { await repo.close(); }
});

test('PROMPT02 · 缺数据就抛错，不许用空串/花括号糊过去', () => {
  const base = {
    phase: 'geography', chatUid: 'c', branchId: 'main', revision: 1, storageRevision: 1, catalogueHash: 'abc123',
    allowedOpsAndKinds: 'map.layout.request', extents: 'M1: 100×100 cells', locks: '（无）',
    deferredSummary: '无未发送待办',
  };
  assert.equal(formatTaskContext(base).includes('{'), false);
  for (const [field, label] of [['chatUid', 'chatUid'], ['catalogueHash', '冻结目录哈希'], ['extents', '单位与有效幅面'], ['deferredSummary', '未发送待办摘要']]) {
    assert.throws(() => formatTaskContext({ ...base, [field]: '' }), (error) => error instanceof PromptLayerError && error.code === 'PROMPT_TASK_CONTEXT_INCOMPLETE',
      `${label} 为空必须报错`);
  }
  assert.throws(() => formatTaskContext({ ...base, revision: Number.NaN }), (error) => error.code === 'PROMPT_TASK_CONTEXT_INCOMPLETE');
  // 组装层也不允许残留模板变量，且三层缺一不可。
  assert.throws(() => assemblePromptLayers({ protocol: '', policy: [], task: ['x'] }), (error) => error.code === 'PROMPT_PROTOCOL_MISSING');
  assert.throws(() => assemblePromptLayers({ protocol: 'p', policy: [], task: [] }), (error) => error.code === 'PROMPT_TASK_MISSING');
  assert.throws(() => assemblePromptLayers({ protocol: 'p', policy: [], task: ['{catalogueHash} 没填'] }), (error) => error.code === 'PROMPT_PLACEHOLDER_UNFILLED');
  // 资料正文里的花括号是资料，不是模板 —— 必须放行。
  const withBraces = assemblePromptLayers({ protocol: 'p', policy: [], task: ['正文里写着 {"op":"noop"} 和 {自定义}'] });
  assert.equal(withBraces.at(-1).content.includes('{自定义}'), true);
});

/* ── PROMPT03 · 能力门控：只有声明过的能力进提示词，且 schema/类型同步 ── */

test('PROMPT03 · 能力门控：声明的能力文字进提示词，未声明的字符串一个字都不出现', () => {
  assert.deepEqual([...SPATIAL_CAPABILITIES], ['corridor-binding/v1', 'space-canonical/v1', 'spatial-profile/v1']);
  assert.equal(hasSpatialCapability('unimplemented/v1'), false, '未实现的字符串不得被当成已声明');
  assert.equal(CAPABILITY_CORRIDOR_BINDING, 'corridor-binding/v1');
  assert.equal(CAPABILITY_SPACE_CANONICAL, 'space-canonical/v1');
  assert.equal(CAPABILITY_SPATIAL_PROFILE, 'spatial-profile/v1');
});

test('PROMPT03 · 每项声明的能力都有真实契约对应：字段 / scope / 命令 / DTO', async () => {
  // 入口：能力字符串是「程序契约」的声明，所以每一条都必须在真实实现里有落点。
  const normalize = await import('../src/atlas-ops-normalize.ts');
  assert.ok([...normalize.LAYOUT_FLOOR_ONLY_SCALARS].includes('corridorLocationRef'),
    'corridor-binding/v1 声明的唯一新增输入必须在 normalize 白名单里');
  const profile = await import('../src/atlas-spatial-profile.ts');
  assert.ok(profile.SPATIAL_PROFILE_MODES.length > 0, 'spatial-profile/v1 声明必须有真实档案模式枚举');
  assert.equal(typeof profile.normalizeRequestedProfileMode, 'function');
  const canonical = await import('../src/atlas-space-canonical.ts');
  assert.equal(canonical.SPACE_CANONICAL_VERSION, 1, 'space-canonical/v1 声明必须有真实版本常量');

  // 布局提示词里必须能看到三项能力的契约文字（否则等于声明了却没告诉模型）。
  const seed = await makeSeedWith(SQL);
  const bytes = seed.exportBytes(); seed.close();
  const repo = createSqlRepository({ chatUid: IDS.chatA, branchId: IDS.branchMain, modelPort: { calls: [], async request(req) { this.calls.push(req); return { batchId: req.batchId, text: '{"op":"noop"}', httpStatus: 200, durationMs: 1 }; } } });
  await repo.open({ bytes });
  try {
    const anchor = { chatUid: IDS.chatA, branchId: IDS.branchMain, parentTurnId: IDS.seedTurn, hostMessageUid: 'caps', variantKey: 'v1', baseRevision: 0, baseStorageRevision: 0, inputHash: 'caps' };
    const task = buildSqlLayoutTask(repo.db, IDS.branchMain, {
      anchor, userText: 'u', assistantText: 'a', manual: false, sourceSnapshot: [], phaseBatches: ['observe'], sceneOnly: true, layoutMaps: 'active',
    }, 'caps');
    const text = task.request.messages[1].content;
    assert.ok(text.includes(CAPABILITY_CORRIDOR_BINDING), 'corridor-binding/v1 已声明 → 文字必须进提示词');
    assert.ok(text.includes('corridorLocationRef'), '已声明能力对应的字段必须出现在提示词里');
    assert.ok(text.includes(CAPABILITY_SPACE_CANONICAL));
    assert.ok(text.includes(CAPABILITY_SPATIAL_PROFILE), 'spatial-profile/v1 已声明 → 文字必须进提示词');
    // 反向：能力清单外的字符串不许因为「写了文案」就出现。
    for (const ghost of ['corridor-binding/v2', 'space-canonical/v2', 'spatial-profile/v2', 'indoor-template/v1']) {
      assert.ok(!text.includes(ghost), `未声明的能力 ${ghost} 不得出现在提示词里`);
    }
    // scope 里确实带了空间权威与子空间尺寸（space-canonical/v1 的真实落点）。
    const scopes = JSON.parse(text.split('\n').find((line) => line.startsWith('本图：')).slice('本图：'.length));
    assert.ok(Array.isArray(scopes) && scopes.length > 0);
    for (const scope of scopes) {
      assert.ok('spaceSize' in scope, '每个 scope 必须带 spaceSize（canonical 的真实落点）');
      assert.ok('childSpaces' in scope);
      assert.ok('profile' in scope, '每个 scope 必须带绘图档案（spatial-profile/v1 的真实落点）');
    }
  } finally { await repo.close(); }
});

/* ── PROMPT04 · 三种任务各用其真实绑定，不是编辑器里那份文本 ── */

test('PROMPT04 · 预览跟随任务的真实绑定：换活动预设，预览与实发同时改变', async () => {
  const settings = settingsWithCustom();
  const { calls, port } = portFor(settings);
  const first = observeRequest('observe_a');
  const previewA = await port.preview(first);
  assert.ok(previewA.messages.some((m) => m.content.includes('按作者自己的口径登记世界')), '预览必须用活动预设的内容');
  await port.request(first);
  assert.deepEqual(previewA.messages.map((m) => m.content), calls[0].body.messages.map((m) => m.content));

  // 换成另一套预设：预览与实发必须一起变，且旧文本不在其中。
  settings.promptPresets = [{ id: 'other-prompt', name: '另一套', systemPrompt: '', updatedAt: 8,
    segments: [{ role: 'system', name: '另一套策略', content: '另一套口径：只登记正文明确写出的事实。', enabled: true }] }];
  settings.activePromptPresetId = 'other-prompt';
  const second = observeRequest('observe_b');
  const previewB = await port.preview(second);
  await port.request(second);
  assert.ok(previewB.messages.some((m) => m.content.includes('只登记正文明确写出的事实')), '预览必须跟随新绑定');
  assert.equal(previewB.messages.some((m) => m.content.includes('按作者自己的口径登记世界')), false, '旧绑定内容不得残留');
  assert.deepEqual(previewB.messages.map((m) => m.content), calls[1].body.messages.map((m) => m.content));
});

test('PROMPT04 · 修复任务用 repair 的真实模板与操作集，不复用推进阶段', async () => {
  const settings = settingsWithCustom();
  const { port } = portFor(settings);
  const advance = await port.preview(observeRequest('advance_probe'));
  const repairRequest = buildStagePrompt({ phase: 'repair', repairTickets: 'R1: 缺 name', batchId: 'repair_probe' });
  const repair = await port.preview(repairRequest);
  assert.notDeepEqual(repair.messages.at(-1).content, advance.messages.at(-1).content, '修复阶段必须用自己的任务上下文');
  assert.ok(repair.messages.at(-1).content.includes('失败票据、原操作、准确错误：R1: 缺 name'), '修复预览必须带真实票据');
  assert.deepEqual([...repairRequest.allowedOps].sort(), [...buildStagePrompt({ phase: 'repair' }).allowedOps].sort(), '修复阶段的操作集来自 repair 自己的允许集');
  assert.ok(!repair.messages.some((m) => m.content.includes('从本轮已完成正文提取实际变化')), '修复阶段不得夹带推进阶段的任务说明');
});
