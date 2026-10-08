/**
 * atlas-generation-budget.test.mjs — M3-04 验收（W06 预算4 / W13 兼容路由第二次发送也占预算）
 *
 * 纪律（写这个文件前先读一遍）：
 * 1. 预算约束的是**真实传输发送**，不是 modelPort.request 的调用次数。一次 request 内部
 *    可能因兼容路由再发一次 fetch（M3-03A），两次都要占额度。
 * 2. 断言必须落在**传输层发送计数**（mock fetchFn 的调用序列），不能只断言 modelPort 调用次数。
 * 3. 领取失败不生成虚假 attempt success：只记 deferred 并交出明确原因。
 * 4. 失败 HTTP 与纠错同样占额度，且**失败不退还**（否则失败即触发请求风暴）。
 * 5. 预算是实例：不同聊天 / 并发任务互相隔离，不存在全局 activeBudget。
 * 6. 全程不调外网：mock fetchFn 按调用序列断言。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GENERATION_BUDGET_LIMIT,
  budgetedModelPort,
  createGenerationBudget,
  transportBudgetPort,
} from '../src/atlas-sql-generation-budget.ts';
import { createSqlModelPort } from '../src/atlas-sql-model-port.ts';
import { createDefaultSettingsV2 } from '../src/atlas-settings.ts';
import { buildStagePrompt } from '../src/atlas-ops-prompts.ts';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function attempt(stage, batchId, status = 'completed') {
  return { stage, batchId, status };
}

/** 最小 ModelBatchRequest：只填预算路径真正读到的字段。 */
function request(batchId, phase = 'geography') {
  const built = buildStagePrompt({ phase, userSource: 'u', assistantSource: 'a' });
  built.batchId = batchId;
  built.phase = phase;
  return built;
}

/** 记录真实发送次数的假模型端口。 */
function fakeModelPort(outcome) {
  const sends = [];
  return {
    sends,
    port: {
      async request(req) {
        sends.push({ batchId: req.batchId, phase: req.phase });
        if (outcome === 'fail') throw Object.assign(new Error('上游 500'), { code: 'API_REQUEST_FAILED', retryable: true });
        return { batchId: req.batchId, text: '{}', finishReason: null, httpStatus: 200, durationMs: 1 };
      },
    },
  };
}

/** MiniMax 订阅密钥连接 + 可注入 fetchFn 的 SQL 模型端口。 */
function minimaxFixture({ budget, fetchFn }) {
  const settings = {
    ...createDefaultSettingsV2(),
    activeApiPresetId: 'connection',
    apiPresets: [{
      id: 'connection', name: 'MiniMax 订阅', endpoint: 'https://api.minimaxi.com/v1',
      apiKey: 'sk-cp-sub', model: 'MiniMax-M3', maxTokens: 9000, timeoutMs: 30000, temperature: 0.4, updatedAt: 1,
    }],
  };
  return createSqlModelPort({ readSettings: async () => settings, fetchFn, budget, stage: 'geography' });
}

/** 触发兼容路由的假 fetchFn：OpenAI 路径回 Not Found，/anthropic 路径回正文。 */
function rescueFetch(outcome = 'success') {
  const calls = [];
  const fetchFn = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    if (url.includes('/anthropic')) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ ops: [] }) } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // MiniMax 订阅密钥打 OpenAI 路径的典型形状：HTTP 200 包错误 JSON
    if (outcome === 'http-404') {
      return new Response(JSON.stringify({ error: { message: 'Not Found' } }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: { message: 'Not Found' }, quota_error: false }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetchFn, calls };
}

// ---------------------------------------------------------------------------
// W06 · 预算 4
// ---------------------------------------------------------------------------

test('W06: 记账基础——limit 固定 4，从既有 attempts 初始化，失败不退还，剩下余额如实', () => {
  const budget = createGenerationBudget();
  assert.equal(budget.limit, GENERATION_BUDGET_LIMIT);
  assert.equal(budget.limit, 4);
  assert.equal(budget.used(), 0);
  assert.equal(budget.remaining(), 4);

  // 逻辑批次 + 真实发送各记一笔
  assert.equal(budget.claimBatch('observe', 'obs_1').ok, true);
  assert.equal(budget.used(), 0, '仅逻辑批次不占真实发送额度');
  assert.equal(budget.claimTransport('observe', 'obs_1').ok, true);
  assert.equal(budget.used(), 1);
  assert.equal(budget.remaining(), 3);

  // 重复逻辑批次 → 明确拒绝，且不占额度
  const dup = budget.claimBatch('observe', 'obs_1');
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'MODEL_BATCH_DUPLICATE');
  assert.equal(budget.used(), 1, '重复候选不重复发请求，也不占额度');

  // 失败 HTTP 照样占额度，且不退还
  assert.equal(budget.claimTransport('repair', 'rep_1').ok, true);
  budget.finishBatch('rep_1', 'failed');
  assert.equal(budget.used(), 2, '失败不退还令牌');
  assert.equal(budget.remaining(), 2);
  assert.equal(budget.attempts().find((a) => a.batchId === 'rep_1').status, 'failed');

  // 从既有 attempts 初始化：每个既有 attempt 对应一次已发出的真实传输
  const resumed = createGenerationBudget({ attempts: [attempt('observe', 'obs_1'), attempt('repair', 'rep_1', 'failed')] });
  assert.equal(resumed.used(), 2, '既有 attempts 接着排队，不重算');
  assert.equal(resumed.remaining(), 2);
});

test('W06: 固定优先级——observe1 + repair1 + 到期后台1，前景只剩 1，建设与布局二选一，另一个 deferred', () => {
  // 本回合已发出：observe 1 + repair 1（纠错也计数）
  const budget = createGenerationBudget({
    attempts: [attempt('observe', 'obs_1'), attempt('repair', 'rep_1')],
  });
  assert.equal(budget.used(), 2);

  // 到期后台任务保留 1 个名额（保留不计入已用，但总账封顶）
  assert.equal(budget.reserveBackground('bg_due'), true);
  assert.equal(budget.backgroundReserved(), true);
  assert.equal(budget.backgroundBatchId(), 'bg_due');
  assert.equal(budget.used(), 2, '保留额度不记为已请求');
  assert.equal(budget.stageRemaining('geography'), 1, '前景阶段看得见被后台保留的那 1 个名额');

  // 建设优先，领到那 1 个名额
  assert.equal(budget.claimTransport('geography', 'build_1').ok, true);
  assert.equal(budget.used(), 3);

  // 布局只能 deferred——不生成虚假 attempt success
  const layout = budget.claimTransport('outcome', 'layout_1');
  assert.equal(layout.ok, false);
  assert.equal(layout.code, 'MODEL_BUDGET_EXHAUSTED');
  assert.deepEqual(budget.deferred(), [{ stage: 'outcome', batchId: 'layout_1', reason: layout.reason }]);

  // 后台未使用必须显式释放；释放后可拿下第 4 个名额
  budget.releaseBackground();
  assert.equal(budget.backgroundReserved(), false);
  assert.equal(budget.backgroundBatchId(), null);
  assert.equal(budget.claimTransport('background', 'bg_due').ok, true);

  // 4 次之后不能发第 5 次
  assert.equal(budget.used(), 4);
  assert.equal(budget.remaining(), 0);
  const fifth = budget.claimTransport('outcome', 'layout_retry');
  assert.equal(fifth.ok, false);
  assert.equal(fifth.code, 'MODEL_BUDGET_EXHAUSTED');
});

test('W06: 后台保留也不能越过上限（总账封顶），且 reservation 未使用时可释放重领', () => {
  const budget = createGenerationBudget({ attempts: [attempt('observe', 'a'), attempt('repair', 'b'), attempt('decision', 'c')] });
  assert.equal(budget.used(), 3);
  assert.equal(budget.reserveBackground('bg_1'), true, '还剩 1 个名额，可保留');
  assert.equal(budget.stageRemaining('geography'), 0, '保留占满后前景无余额');
  budget.releaseBackground();
  budget.claimTransport('geography', 'build_1');
  assert.equal(budget.used(), 4);
  assert.equal(budget.reserveBackground('bg_2'), false, '总账已满，后台不再保留');
  assert.equal(budget.backgroundReserved(), false);
  assert.equal(budget.deferred().some((d) => d.batchId === 'bg_2'), true, '拒绝必须留下明确 deferred 原因');
});

test('W06: budgetedModelPort 统一 claim 真实请求；4 次后第 5 次拒绝并 deferred（含失败与纠错计数）', async () => {
  const budget = createGenerationBudget();
  const failing = fakeModelPort('fail');
  const ok = fakeModelPort('ok');

  // 1) observe 成功
  await budgetedModelPort(ok.port, budget, 'observe').request(request('obs_1', 'observe'));
  // 2) repair 失败——失败同样占额度且不退还
  await assert.rejects(
    () => budgetedModelPort(failing.port, budget, 'repair').request(request('rep_1', 'repair')),
    (error) => error.code === 'API_REQUEST_FAILED',
  );
  assert.equal(budget.used(), 2, '失败 HTTP 计入额度');
  assert.equal(budget.attempts().find((a) => a.batchId === 'rep_1').status, 'failed');

  // 3) 建设 + 4) 布局
  await budgetedModelPort(ok.port, budget, 'geography').request(request('build_1'));
  await budgetedModelPort(ok.port, budget, 'outcome').request(request('layout_1', 'outcome'));
  assert.equal(budget.used(), 4);

  // 5) 第 5 次：明确拒绝，绝不放行
  await assert.rejects(
    () => budgetedModelPort(ok.port, budget, 'outcome').request(request('layout_2', 'outcome')),
    (error) => {
      assert.equal(error.code, 'MODEL_BUDGET_EXHAUSTED');
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(ok.sends.length, 3, '只发了 3 次；被拒的那次没有落到传输层');
  assert.equal(budget.deferred().length, 1);
  assert.equal(budget.deferred()[0].batchId, 'layout_2');
});

// ---------------------------------------------------------------------------
// W13 · 兼容路由第二次发送也占预算
// ---------------------------------------------------------------------------

test('W13: 一次 modelPort.request 内部第二次 fetchFn 发送也占额度——逻辑批次 1 条，传输发送 2 次', async () => {
  const budget = createGenerationBudget();
  const { fetchFn, calls } = rescueFetch();
  const port = minimaxFixture({ budget, fetchFn });

  const result = await port.request(request('construction_1'));
  assert.equal(result.httpStatus, 200);

  // 传输层：原路径 + 兼容路由救场 = 2 次真实发送
  assert.equal(calls.length, 2, '断言传输层发送计数，不只是 modelPort 调用次数');
  assert.match(calls[0], /\/v1\/chat\/completions$/);
  assert.ok(calls[1].includes('/anthropic'), '第二次是兼容路由发送');

  // 记账：2 次传输，1 条逻辑批次
  assert.equal(budget.used(), 2, '第二次发送必须再次领取额度');
  assert.equal(budget.remaining(), 2);
  assert.equal(budget.attempts().length, 1, '逻辑批次仍只有 1 条');
  assert.equal(budget.attempts()[0].batchId, 'construction_1');
  assert.equal(budget.attempts()[0].status, 'completed');
  assert.equal(budget.deferred().length, 0);
});

test('W13: 无余额时不发隐藏重试——只发首次，返回明确原因，保留首次失败原错误', async () => {
  // 前景只剩 1 个名额：首次发送吃掉它，兼容路由的第二次必然领不到
  const budget = createGenerationBudget({ attempts: [attempt('observe', 'a'), attempt('repair', 'b'), attempt('decision', 'c')] });
  assert.equal(budget.remaining(), 1);
  const { fetchFn, calls } = rescueFetch();
  const port = minimaxFixture({ budget, fetchFn });

  await assert.rejects(
    () => port.request(request('construction_1')),
    (error) => {
      assert.equal(error.code, 'MODEL_BUDGET_EXHAUSTED', '返回明确原因，而不是静默重试');
      assert.match(error.message, /未自动重试/, '明确说明未发出第二次请求');
      assert.match(error.message, /Not Found/, '保留首次失败的原始错误用于诊断');
      return true;
    },
  );

  assert.equal(calls.length, 1, '不许隐藏重试：传输层只有 1 次发送');
  assert.equal(budget.used(), 4, '首次发送照常占用额度；整个 prepareTurn 实际发送 ≤4');
  assert.equal(budget.deferred().length, 1, '被拒的第二次发送留下 deferred');
  assert.match(budget.deferred()[0].reason, /已用尽/);
});

test('W13: 首次发送本身被拒时也不落到传输层（预算先于网络）', async () => {
  const budget = createGenerationBudget({ attempts: [attempt('a', 'a'), attempt('b', 'b'), attempt('c', 'c'), attempt('d', 'd')] });
  const { fetchFn, calls } = rescueFetch();
  const port = minimaxFixture({ budget, fetchFn });

  await assert.rejects(
    () => port.request(request('construction_1')),
    (error) => error.code === 'MODEL_BUDGET_EXHAUSTED',
  );
  assert.equal(calls.length, 0, '没有余额就不发任何请求');
});

test('W13: 非兼容路由的单次请求只计一次', async () => {
  const budget = createGenerationBudget();
  const calls = [];
  const fetchFn = async (input) => {
    calls.push(typeof input === 'string' ? input : input.toString());
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ops: [] }) } }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  const settings = {
    ...createDefaultSettingsV2(),
    activeApiPresetId: 'connection',
    apiPresets: [{
      id: 'connection', name: '普通 OpenAI 兼容', endpoint: 'https://api.example.com/v1',
      apiKey: 'plain-key', model: 'm1', maxTokens: 9000, timeoutMs: 30000, temperature: 0.4, updatedAt: 1,
    }],
  };
  const port = createSqlModelPort({ readSettings: async () => settings, fetchFn, budget, stage: 'geography' });

  await port.request(request('observe_1'));
  assert.equal(calls.length, 1);
  assert.equal(budget.used(), 1, '非兼容路由只计一次');
});

test('W13: 不同聊天 / 并发任务的预算互相隔离（无全局 activeBudget）', async () => {
  const chatA = createGenerationBudget();
  const chatB = createGenerationBudget();

  // 把 A 的额度打满
  for (let i = 0; i < 4; i += 1) {
    assert.equal(chatA.claimTransport('geography', `a_${i}`).ok, true);
  }
  assert.equal(chatA.remaining(), 0);
  assert.equal(chatA.claimTransport('geography', 'a_overflow').ok, false);

  // B 完全不受影响
  assert.equal(chatB.used(), 0);
  assert.equal(chatB.remaining(), 4);
  assert.equal(chatB.claimTransport('geography', 'b_0').ok, true);
  assert.equal(chatB.deferred().length, 0);
});

test('M3-03A: transportBudgetPort 是预算的传输层领取口，拒绝时带出原因', () => {
  const budget = createGenerationBudget({ attempts: [attempt('a', 'a'), attempt('b', 'b'), attempt('c', 'c'), attempt('d', 'd')] });
  const claim = transportBudgetPort(budget, 'geography', 'build_1').claim();
  assert.equal(claim.ok, false);
  assert.match(claim.reason, /已用尽/);

  const roomy = createGenerationBudget();
  assert.deepEqual(transportBudgetPort(roomy, 'geography', 'build_1').claim(), { ok: true });
  assert.equal(roomy.used(), 1);
});
