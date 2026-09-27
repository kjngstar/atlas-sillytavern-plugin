/**
 * atlas-ops-prompts.test.mjs — T23 分阶段提示词（§18.3 / §19 / §8.2 / §8.3）。
 *
 * §18.3 必须覆盖的断言：
 * - 阶段只给允许操作：每个阶段的提示词与 allowedOpsForPhase 完全一致，且列出的名字出现在正文里；
 * - 14 种不会每轮全塞：observe 不含 plan.propose/map.estimate/route.propose/attention.propose/channel.upsert，
 *   列出的条数严格小于 14，任何阶段都不会列出全部 14 种；
 * - 原分段角色与内容保留：messages[0] 是 system 且含固定格式段，messages[1] 是 user，
 *   用户可编辑段逐字保留且排在格式段之后；`{{allowedOperationHelp}}` 占位符不得残留在输出里；
 * - 没有一边要求 SQL 一边要求 JSON：所有阶段 promptForbidsSql 为真，
 *   且 CREATE TABLE/PRAGMA/INSERT INTO/UPDATE … SET/ATTACH DATABASE 出现 0 次，同时含规范 JSON 示例行。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStagePrompt, promptForbidsSql, promptOperationNames, STAGE_PROMPT_TEMPLATES } from '../src/atlas-ops-prompts.ts';
import { PHASE_ALLOWED_OPS, allowedOpsForPhase, ATLAS_SEMANTIC_OPS } from '../src/atlas-ops-contract.ts';

/** §18.3 / §8.2：四个常规阶段（repair 的允许集合来自原失败组，单独测）。 */
const PHASES = ['observe', 'geography', 'decision', 'outcome'];
const FULL_TEXT = (request) => request.messages.map((m) => m.content).join('\n');
const CANONICAL_JSON_LINE = '{"op":"character.upsert","ref":"C1","data":{"thought":"先观察。"}}';

test('T23-01 阶段只给允许操作：每阶段列出的操作与该阶段允许集合完全一致且出现在正文', () => {
  let checkedHelpLines = 0;
  for (const phase of PHASES) {
    const request = buildStagePrompt({ phase });
    const allowed = allowedOpsForPhase(phase);
    assert.deepEqual(promptOperationNames(request), [...allowed], `${phase}: 提示词列出的操作必须等于 allowedOpsForPhase(${phase})`);
    assert.deepEqual([...request.allowedOps], [...allowed], `${phase}: request.allowedOps 必须与之一致`);
    assert.equal(request.phase, phase);
    const text = FULL_TEXT(request);
    for (const name of allowed) {
      assert.ok(text.includes(name), `${phase}: 允许的操作 ${name} 必须出现在提示词正文里`);
    }
    // 「本次允许的操作与最少参数」清单里，出现的操作名必须恰好是允许集合，一个都不多
    const helpSection = text.slice(text.indexOf('本次允许的操作与最少参数：'));
    const listedInHelp = [...helpSection.matchAll(/^- ([a-z]+\.[a-z]+)：/gm)].map((m) => m[1]);
    assert.deepEqual(listedInHelp, [...allowed], `${phase}: 操作清单里只能有本阶段允许的操作`);
    checkedHelpLines += listedInHelp.length;
  }
  assert.ok(checkedHelpLines > 0, '最少参数清单必须真的被检查到');
});

test('T23-02 14 种不会每轮全塞：observe 不含 5 种越权操作，且没有任何阶段列出全部 14 种', () => {
  const observe = buildStagePrompt({ phase: 'observe' });
  const observeText = FULL_TEXT(observe);
  for (const forbidden of ['plan.propose', 'map.estimate', 'route.propose', 'attention.propose', 'channel.upsert']) {
    assert.equal(promptOperationNames(observe).includes(forbidden), false, `observe 不得列出 ${forbidden}`);
    assert.equal(observeText.includes(forbidden), false, `observe 正文不得出现 ${forbidden}`);
  }
  assert.ok(promptOperationNames(observe).length < ATLAS_SEMANTIC_OPS.length, 'observe 的条数必须严格小于 14 种全量');
  assert.equal(ATLAS_SEMANTIC_OPS.length, 14, '§8.4 固定为 14 种语义操作');

  for (const phase of [...PHASES, 'repair']) {
    const listed = promptOperationNames(buildStagePrompt({ phase }));
    assert.ok(listed.length < ATLAS_SEMANTIC_OPS.length, `${phase} 不得列出全部 14 种操作`);
    const unique = [...new Set(listed)];
    assert.equal(unique.length, listed.length, `${phase} 不得重复列出同一操作`);
  }
  // 各阶段集合是真正的分工，不是同一份全量
  assert.deepEqual([...PHASE_ALLOWED_OPS.geography].sort(), ['location.upsert', 'map.estimate', 'route.propose']);
  assert.deepEqual([...PHASE_ALLOWED_OPS.outcome].sort(), ['event.propose', 'information.propose']);
  assert.notDeepEqual([...PHASE_ALLOWED_OPS.observe].sort(), [...PHASE_ALLOWED_OPS.decision].sort());

  // 提示词里给出的是「本次允许的操作与最少参数」，不是二十张表的建表语句
  assert.ok(observeText.includes('本次允许的操作与最少参数：'));
  assert.equal(/CREATE\s+TABLE/i.test(observeText), false);
  assert.equal(observeText.split('\n').length < 100, true, '提示词不应膨胀成整份 schema 文档');
});

test('T23-03 原分段角色与内容保留：system/user 分段不变，用户可编辑段逐字保留且不丢不换序', () => {
  const preset = '【用户风格段】\n请保持简短，偶尔使用口语。\n【世界推演策略段】先地理后人物。';
  const request = buildStagePrompt({
    phase: 'observe',
    entityRefs: ['C1=艾琳（人物）', 'L2=圣光学校（地点）'],
    lorebookSources: ['W1'],
    userSource: '用户行动',
    assistantSource: '本轮正文',
    userPresetSegment: preset,
  });

  assert.equal(request.messages.length, 2, '固定两段：system + user');
  assert.equal(request.messages[0].role, 'system');
  assert.equal(request.messages[1].role, 'user');
  const system = request.messages[0].content;
  const user = request.messages[1].content;

  // 固定格式段仍在 system 里，且是第 1 段
  assert.ok(system.startsWith(STAGE_PROMPT_TEMPLATES.FORMAT_SEGMENT.slice(0, STAGE_PROMPT_TEMPLATES.FORMAT_SEGMENT.indexOf('{{allowedOperationHelp}}'))), 'system 必须以固定格式段开头');
  assert.ok(system.includes('你负责 Atlas 的本次状态任务。'), 'system 必须含 §19.1 固定格式段');
  assert.ok(system.includes('只输出本次允许的操作，每行一个完整 JSON 对象。'));
  assert.ok(system.includes('不要输出整份世界、SQL、解释段或思考过程。'));

  // 用户可编辑段逐字保留，且排在格式段之后（不被丢、不被换序）
  assert.ok(system.includes(preset), 'userPresetSegment 必须逐字保留在 system 内容里');
  assert.ok(system.indexOf(preset) > system.indexOf('你负责 Atlas 的本次状态任务。'), '用户段必须排在固定格式段之后');
  assert.ok(system.endsWith(preset), '用户段是最后一段，不能被别的段挤到前面');
  assert.equal(user.includes(preset), false, '用户可编辑段不得被塞进 user 段');

  // 该阶段内容段（§19.2）原样保留在 user 里
  for (const line of STAGE_PROMPT_TEMPLATES.PHASE_TASK.observe) {
    assert.ok(user.includes(line), `user 段必须保留该阶段原句：${line}`);
  }
  assert.ok(user.includes('现有对象短引用：C1=艾琳（人物）、L2=圣光学校（地点）'));
  assert.ok(user.includes('相关世界书：W1'));
  assert.ok(user.includes('本轮用户行动：用户行动'));
  assert.ok(user.includes('本轮正文：本轮正文'));

  // 占位符不得残留
  assert.equal(system.includes('{{allowedOperationHelp}}'), false, 'system 里不得残留 {{allowedOperationHelp}}');
  assert.equal(user.includes('{{'), false, 'user 里不得残留任何 {{...}} 占位符');
  assert.equal(FULL_TEXT(request).includes('{{'), false, '整份提示词里不得残留任何 {{...}} 占位符');
});

test('T23-04 没有一边要求 SQL 一边要求 JSON：全部阶段禁 SQL 且含规范 JSON 示例行', () => {
  const sqlPatterns = [
    ['CREATE TABLE', /CREATE\s+TABLE/i],
    ['PRAGMA', /PRAGMA/i],
    ['INSERT INTO', /\bINSERT\s+INTO\b/i],
    ['UPDATE … SET', /\bUPDATE\s+\w+\s+SET\b/i],
    ['ATTACH DATABASE', /ATTACH\s+DATABASE/i],
  ];
  for (const phase of [...PHASES, 'repair']) {
    const request = buildStagePrompt({ phase });
    assert.equal(promptForbidsSql(request), true, `${phase}: promptForbidsSql 必须为真`);
    const text = FULL_TEXT(request);
    for (const [label, pattern] of sqlPatterns) {
      assert.equal((text.match(pattern) ?? []).length, 0, `${phase}: 不得出现 ${label}`);
    }
    assert.ok(text.includes(CANONICAL_JSON_LINE), `${phase}: 必须含 §19.1 规范 JSON 示例行`);
    assert.ok(text.includes('每行一个完整 JSON 对象。'), `${phase}: 必须明确要求 JSON 逐行输出`);
    assert.equal(/output\s+SQL/i.test(text), false, `${phase}: 不得要求 SQL`);
  }

  // 反向对照：一旦混入 SQL，判定函数必须报 false（不是恒真）
  const smuggled = buildStagePrompt({ phase: 'observe' });
  smuggled.messages[1].content += '\n请直接使用 CREATE TABLE characters (...) 并 PRAGMA foreign_keys=ON。';
  assert.equal(promptForbidsSql(smuggled), false, '混入 SQL 后 promptForbidsSql 必须为 false');
});

test('T23-05 repair 阶段：含失败票据与 ticket 示例，并明确不重复已成功操作', () => {
  const request = buildStagePrompt({
    phase: 'repair',
    allowedOps: ['character.upsert', 'location.upsert'],
    repairTickets: '[{"ticket":"R1","reason":"REF_UNKNOWN","op":{"op":"character.upsert","ref":"C1","data":{"location_ref":"L9"}}}]',
    repairRefs: 'C1=艾琳（人物）',
    repairSources: 'W1',
    repairOfBatchId: 'observe_batch_1',
  });

  assert.equal(request.phase, 'repair');
  assert.equal(request.repairOfBatchId, 'observe_batch_1');
  assert.deepEqual(promptOperationNames(request), ['character.upsert', 'location.upsert'], 'repair 只用原本允许的操作');
  const text = FULL_TEXT(request);

  assert.ok(text.includes('失败票据、原操作、准确错误：'), '必须给出票据段');
  assert.ok(text.includes('"ticket":"R1"'), '必须包含失败票据 R1 的内容');
  assert.ok(text.includes('{"ticket":"R1","op":"character.upsert","ref":"C1","data":{"location_ref":"L2"}}'), '必须包含 §19.6 的 ticket 示例行');
  assert.ok(text.includes('相关对象：C1=艾琳（人物）'));
  assert.ok(text.includes('相关来源/机会：W1'));
  assert.ok(text.includes('逐条使用给定 ticket 修正原操作，每行一个完整 JSON 对象。'));
  assert.ok(
    text.includes('其它成功操作已经保留，禁止重复输出或修改它们') ||
      text.includes('不要重复准备/旅行尚未完成的动作'),
    '必须明确不重复已成功的操作',
  );
  assert.ok(text.includes('不要重新输出整个世界，不要改用 SQL，不要编造不存在的引用或证据。'));
  assert.equal(text.includes('{{'), false, 'repair 提示词里不得残留占位符');
  assert.equal(promptForbidsSql(request), true, 'repair 也不得要求 SQL');
  assert.ok(text.includes(CANONICAL_JSON_LINE), 'repair 仍使用同一种 JSON 格式');
});

test('T23-06 同阶段重复装配稳定：同一输入产出同一份提示词（含 allowedOps 顺序）', () => {
  const input = {
    phase: 'decision',
    timeWindow: '08:00-08:10',
    actorSlices: 'C1=艾琳（人物）',
    activeActions: '无',
    opportunities: '无',
    userPresetSegment: '用户段',
  };
  const first = buildStagePrompt(input);
  const second = buildStagePrompt(input);
  assert.deepEqual(second, first, '同一输入必须产出逐字段相同的请求');
  assert.deepEqual(promptOperationNames(first), [...PHASE_ALLOWED_OPS.decision], 'decision 顺序按 §8.2 表');
  const text = FULL_TEXT(first);
  for (const line of STAGE_PROMPT_TEMPLATES.PHASE_TASK.decision) {
    assert.ok(text.includes(line), `decision 内容段必须原样保留：${line}`);
  }
  assert.ok(text.includes('本轮可用时间与时刻：08:00-08:10'));
  assert.ok(text.includes('程序给出的接触机会：无'));
  // 每个允许操作都要有「最少参数」说明（§19.1 的 {{allowedOperationHelp}} 已填入）
  for (const op of PHASE_ALLOWED_OPS.decision) {
    assert.ok(text.includes(`- ${op}：`), `${op} 必须有最少参数说明行`);
    assert.ok((STAGE_PROMPT_TEMPLATES.MINIMUM_HELP[op] ?? '').length > 0, `${op} 必须在 MINIMUM_HELP 里有定义`);
  }
});
