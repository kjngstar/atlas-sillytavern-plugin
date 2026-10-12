/**
 * atlas-request-duration.test.mjs — P02 / R06：模型请求耗时的真实起止记账。
 *
 * 覆盖：
 * - T01 假时钟 5,000→10,000：建设请求起止正确、duration_ms = 5,000
 * - T02 请求抛错（超时 / 取消）同样留真实起止与 failure_kind，且不伪造 http_status
 * - T03 复用、未触发模型的路径不新增「0 ms 的模型请求」
 * - T04 请求期间聊天变化 → 候选仍被丢弃（计时不绕过 stale guard）
 *
 * 纪律：全程离线；模型端口是可注入 stub；断言只落在可观察结果（候选库 attempts_json、model 调用数、抛出的错误码）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS } from './fixtures/atlas-sql/seed.mjs';
import { SOURCE_SNAPSHOT } from './fixtures/atlas-sql/model-cases.mjs';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';

const SQL = await (await import('sql.js')).default();
const BRANCH = IDS.branchMain;
const CHAT_A = IDS.chatA;
const LOCAL_FOCUS = { mode: 'local', focusLocationIds: [IDS.L3] };
const NOOP = '{"op":"noop"}';
const NEW_PLACE = '{"op":"location.upsert","ref":"new:inn","data":{"name":"旅店","kind":"building","parent_ref":"L2"}}';

const q = (db, sql, params = []) => queryBound(db, sql, params);
const attemptsOf = (db, turnId) => JSON.parse(q(db, 'SELECT attempts_json FROM turns WHERE id = ?', [turnId])[0].attempts_json);

function anchorFor(overrides = {}) {
  return {
    chatUid: CHAT_A, branchId: BRANCH, parentTurnId: IDS.seedTurn,
    hostMessageUid: 'msg_dur', variantKey: 'v1',
    baseRevision: 0, baseStorageRevision: 0, inputHash: 'input_hash_dur',
    ...overrides,
  };
}

/**
 * 可注入时钟 + 可编程模型端口。
 * `advanceDuring` 收到第 n 次请求（0 基）时执行，用来模拟「请求期间时间前进」。
 */
async function makeRepo({ responses = [], advanceDuring, throwOn } = {}) {
  const calls = [];
  let clock = 5_000;
  const setClock = value => { clock = value; };
  const model = {
    calls,
    async request(req) {
      const index = calls.length;
      calls.push({ batchId: req.batchId, phase: req.phase });
      if (advanceDuring) advanceDuring(index, setClock);
      const planned = throwOn?.[index];
      if (planned) throw planned;
      const text = responses.length > 0 ? responses.shift() : NOOP;
      return { batchId: req.batchId, text, finishReason: 'stop', httpStatus: 200, durationMs: 5 };
    },
  };
  const repo = createSqlRepository({
    chatUid: CHAT_A, branchId: BRANCH, branchName: '主线',
    modelPort: model, now: () => clock,
  });
  const seed = await makeSeedWith(SQL);
  const bytes = seed.exportBytes();
  seed.close();
  await repo.open({ bytes });
  return { repo, model, setClock, getClock: () => clock };
}

test('T01 假时钟 5000→10000：建设请求起止正确、耗时 5000ms', async () => {
  // 第 0 次请求是观察阶段（时钟不动），第 1 次是建设请求（期间时钟从 5000 走到 10000）。
  const { repo, model } = await makeRepo({
    responses: [NOOP, NEW_PLACE],
    advanceDuring: (index, setClock) => { if (index === 1) setClock(10_000); },
  });
  try {
    const prepared = await repo.prepareTurn({
      anchor: anchorFor(), userText: '他走进旅店。', assistantText: '旅店就在街角。',
      sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false, worldCompletion: LOCAL_FOCUS,
    });
    const db = repo.getCandidate(prepared.token).db;
    const attempts = attemptsOf(db, prepared.receipt.turnId);
    const construction = attempts.find(a => a.kind === 'construction');
    assert.ok(construction, `必须有建设请求记账，实际：${JSON.stringify(attempts)}`);
    assert.equal(construction.started_wall_ms, 5_000, '起时必须在发起请求前取到');
    assert.equal(construction.finished_wall_ms, 10_000, '止时必须在请求返回后取到');
    assert.equal(construction.duration_ms, 5_000, '耗时 = 止 - 起');
    assert.equal(construction.http_status, 200);
    assert.ok(model.calls.length >= 2, '观察 + 建设各发过一次请求');
  } finally {
    await repo.close();
  }
});

test('T02 请求超时/取消：留真实起止与 failure_kind，且不伪造 http_status', async () => {
  const timeoutError = Object.assign(new Error('模型超时'), { code: 'MODEL_TIMEOUT' });
  const cancelledError = Object.assign(new Error('请求已取消'), { name: 'AbortError' });

  for (const [label, thrown, expectedKind] of [
    ['超时', timeoutError, 'timeout'],
    ['取消', cancelledError, 'cancelled'],
  ]) {
    const { repo } = await makeRepo({
      responses: [NOOP],           // 观察阶段
      throwOn: { 1: thrown },      // 建设请求抛错
    });
    try {
      const prepared = await repo.prepareTurn({
        anchor: anchorFor(), userText: '他走进旅店。', assistantText: '旅店就在街角。',
        sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false, worldCompletion: LOCAL_FOCUS,
      });
      const db = repo.getCandidate(prepared.token).db;
      const attempts = attemptsOf(db, prepared.receipt.turnId);
      const construction = attempts.find(a => a.kind === 'construction');
      assert.ok(construction, `${label}：必须有建设请求记账`);
      assert.equal(construction.failure_kind, expectedKind, `${label}：failure_kind 必须分类正确`);
      assert.ok(Number.isFinite(construction.started_wall_ms), `${label}：必须有起时`);
      assert.ok(Number.isFinite(construction.finished_wall_ms), `${label}：必须有止时`);
      assert.equal(construction.duration_ms, construction.finished_wall_ms - construction.started_wall_ms, `${label}：耗时一致`);
      assert.ok(construction.duration_ms >= 0, `${label}：耗时不小于 0`);
      assert.ok(!Object.hasOwn(construction, 'http_status'), `${label}：没有 HTTP 响应就不能写 http_status`);
      assert.match(String(construction.error), new RegExp(thrown.message), `${label}：保留错误原因`);
      // 请求失败不得把候选改写成「成功」。
      assert.notEqual(prepared.receipt.status, 'committed', `${label}：失败轮不得标为 committed`);
    } finally {
      await repo.close();
    }
  }
});

test('T03 复用/未触发模型：不新增「0 ms 的模型请求」', async () => {
  const { repo, model } = await makeRepo({ responses: [] });
  try {
    const prepared = await repo.prepareTurn({
      anchor: anchorFor({ hostMessageUid: 'dur_manual', variantKey: 'manual' }),
      userText: '手动改', assistantText: '', sourceSnapshot: [], phaseBatches: [],
      manual: true,
      operations: [{ op: 'character.upsert', ref: 'C1', data: { thought: '手动编辑的想法' } }],
    });
    const db = repo.getCandidate(prepared.token).db;
    const attempts = attemptsOf(db, prepared.receipt.turnId);
    assert.equal(model.calls.length, 0, '手动操作不调用模型');
    assert.equal(attempts.length, 0, '没有模型请求就不该出现任何 attempt（尤其不是 0ms 的假请求）');
  } finally {
    await repo.close();
  }
});

test('T04 请求期间聊天变化：候选仍被丢弃，计时不绕过 stale guard', async () => {
  // 观察阶段 isCurrent 仍为真；建设请求**进行中**才切聊天。
  let switched = false;
  const { repo, model } = await makeRepo({
    responses: [NOOP, NEW_PLACE],
    advanceDuring: (index) => { if (index === 1) switched = true; },
  });
  try {
    await assert.rejects(
      () => repo.prepareTurn({
        anchor: anchorFor(), userText: '他走进旅店。', assistantText: '旅店就在街角。',
        sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false, worldCompletion: LOCAL_FOCUS,
        isCurrent: () => !switched,
      }),
      (err) => err?.code === 'STALE_BASE',
      '请求期间聊天变化必须抛 STALE_BASE，而不是被计时路径吞掉',
    );
    assert.ok(model.calls.length >= 1, '请求确实发出过（下面证明它没有绕过守卫）');
    // 正式库没有被写入本轮业务实体。
    const rows = q(repo.db, 'SELECT COUNT(*) n FROM locations WHERE branch_id = ? AND name = ?', [BRANCH, '旅店']);
    assert.equal(rows[0].n, 0, 'stale 候选不得写入正式库');
  } finally {
    await repo.close();
  }
});
