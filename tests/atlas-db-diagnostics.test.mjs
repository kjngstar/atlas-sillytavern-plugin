/**
 * atlas-db-diagnostics.test.mjs — T24（§18.3 / §16.8 / §18.4 / §17G G10+G11）。
 *
 * 覆盖：
 * - 所有失败组可定位 `line/op/path/dependencyId`（真实 `applyGroups` 产出的 rejected/blocked 组
 *   + `normalizeWorldIssueList`）；
 * - 同一回执投影与日志时间线引用**同一个 log id**（回执 turnId → `turn_<id>` 在 queryDiagnostics 里）；
 * - `diagnosticsExportPage`：分页 100 条不等于导出截断；超出留存范围明确给 `droppedCount` 与原因；
 * - 密钥脱敏：`sk-…`、`Bearer …`、`api_key=…`、32+ 位十六进制串在 `message` 与 `details` 里都被抹掉；
 * - HTTP 200 不伪装提交成功：`coreSaved:false` 的诊断不会带 `coreSaved:true`；
 * - `module` 为空时明确报 `DIAGNOSTIC_MODULE_REQUIRED`（不静默）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, countRows } from './fixtures/atlas-sql/seed.mjs';
import { SOURCE_SNAPSHOT } from './fixtures/atlas-sql/model-cases.mjs';
import { applyGroups } from '../src/atlas-db-commit.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { queryDiagnostics } from '../src/atlas-db-views.ts';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { makeAnchor, makeCompileContext } from './helpers/atlas-compile-context.mjs';
import { extractPayload, parseOperations } from '../src/atlas-ops-parser.ts';
import { compileOperations } from '../src/atlas-ops-compile.ts';
import {
  atlasRefFingerprint,
  diagnosticsExportPage,
  normalizeWorldIssue,
  normalizeWorldIssueList,
  redactWorldSecrets,
} from '../src/atlas-diagnostics.ts';
import { ATLAS_RUNTIME_LIMITS } from '../src/atlas-runtime-limits.ts';

const SQL = await (await import('sql.js')).default();
const FIXED_AT = 1_700_000_000_000;
const FIXED_ISO = new Date(FIXED_AT).toISOString();
const HEX64 = 'a1b2c3d4'.repeat(8); // 64 位十六进制串（32+ 必须被抹掉）
const SECRET_SK = 'sk-live-abcdef1234567890';
const SECRET_BEARER = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
const SECRET_APIKEY = 'api_key=AKIA1234567890ABCDEF';

function compile(seed, responseText, { phase = 'observe' } = {}) {
  const extracted = extractPayload(responseText);
  const parsed = parseOperations(extracted.payload, { phase });
  const anchor = makeAnchor();
  const context = makeCompileContext({ seed, phase, anchor });
  return compileOperations({
    operations: parsed.operations,
    anchor,
    phase,
    clockS: 0,
    revision: 0,
    tables: context.tables,
    sources: { phase, snapshot: [], clockS: 0 },
    knownRefs: seed.refs,
  });
}

function scriptedModel(responses) {
  return {
    calls: [],
    async request(req) {
      this.calls.push(req);
      const text = responses.length > 0 ? responses.shift() : '{"op":"noop"}';
      return { batchId: req.batchId, text, finishReason: 'stop', httpStatus: 200, durationMs: 5 };
    },
  };
}

/* ───────────────────────────── T24 ───────────────────────────── */

test('T24-01 失败组可定位：真实 applyGroups 的 rejected/blocked 组带 line/op/path/dependencyId', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const compiled = compile(
      seed,
      [
        '{"op":"character.upsert","ref":"new:bad","data":{"name":"无名氏"}}',
        '{"op":"character.upsert","ref":"C1","data":{"thought":"继续观察。"}}',
      ].join('\n'),
    );
    const badOp = compiled.results[0];
    const goodOp = compiled.results[1];
    assert.ok(badOp.result.issues.some((i) => i.code === 'MINIMUM_FIELD_MISSING'), '第一行必须是真实编译错误');
    assert.equal(badOp.result.issues[0].line, 1);

    // 真实应用：坏组 = 最小字段缺失；依赖它的组读取了坏组本该建好的新角色 → blocked。
    seed.db.run('BEGIN');
    let applied;
    try {
      applied = applyGroups(
        seed.db,
        [
          {
            id: 'g_bad_item',
            opIds: [badOp.opId],
            dependsOn: [],
            readSet: badOp.result.readSet,
            mutations: badOp.result.mutations,
            opIssues: badOp.result.issues,
          },
          {
            id: 'g_dependent',
            opIds: [goodOp.opId],
            dependsOn: ['g_bad_item'],
            readSet: goodOp.result.readSet,
            mutations: goodOp.result.mutations,
            opIssues: goodOp.result.issues,
          },
        ],
        { branchId: IDS.branchMain, turnId: IDS.seedTurn, attemptId: 'attempt_diag' },
      );
      seed.db.run('COMMIT');
    } catch (err) {
      seed.db.run('ROLLBACK');
      throw err;
    }

    const statuses = applied.groups.map((g) => `${g.groupId}:${g.status}`);
    assert.deepEqual(statuses, ['g_bad_item:rejected', 'g_dependent:blocked'], '失败组与依赖组独立记账');

    const issues = applied.groups.flatMap((g) => g.issues);
    const records = normalizeWorldIssueList(issues, {
      module: 'atlas-db-commit',
      chatUid: IDS.chatA,
      branchId: IDS.branchMain,
      turnId: IDS.seedTurn,
      attemptId: 'attempt_diag',
      batchId: 'batch_1',
    }, () => FIXED_AT);

    const rejected = records.find((r) => r.code === 'MINIMUM_FIELD_MISSING');
    assert.ok(rejected, '拒绝组的问题必须进入诊断');
    assert.equal(rejected.line, 1, '能定位到原始行号');
    assert.equal(rejected.opId, badOp.opId, '能定位到具体 operation');
    assert.equal(rejected.path, '$.data.identity', '能定位到具体字段路径');
    assert.equal(rejected.groupId, 'g_bad_item');
    assert.equal(rejected.details.severity, 'error');
    assert.equal(rejected.details.retryable, true);
    assert.equal(rejected.level, 'error');
    assert.equal(rejected.at, FIXED_ISO);

    const blocked = records.find((r) => r.code === 'DEPENDENCY_FAILED');
    assert.ok(blocked, '被阻塞的组同样进入诊断');
    assert.equal(blocked.groupId, 'g_dependent');
    assert.equal(blocked.details.dependencyId, 'g_bad_item', '必须指出上游组，而不是只刷一句失败');
    assert.equal(blocked.path, '$');
    assert.equal(rejected.batchId, atlasRefFingerprint('batch_1'));

    // 原始标识不落日志：只有确定性脱敏指纹。
    const dumped = JSON.stringify(records);
    assert.ok(!dumped.includes(IDS.chatA), '不得出现原始 chatUid');
    assert.ok(!dumped.includes(IDS.seedTurn), '不得出现原始 turnId');
    assert.match(String(records[0].chatUid), /^ref-[0-9a-f]{16}$/);
    assert.match(String(records[0].turnId), /^ref-[0-9a-f]{16}$/);
    assert.equal(records[0].chatUid, atlasRefFingerprint(IDS.chatA), '同一输入永远同一指纹');
    assert.deepEqual(foreignKeyCheckOf(seed.db), []);
  } finally {
    seed.close();
  }
});

function foreignKeyCheckOf(db) {
  const rows = db.exec('PRAGMA foreign_key_check');
  return rows.length ? rows[0].values : [];
}

test('T24-02 回执投影与日志时间线引用同一个 log id（回执 turn → turn_<id>）', async () => {
  const model = scriptedModel([
    [
      '{"op":"character.upsert","ref":"C1","data":{"thought":"先观察。"}}',
      '{"op":"character.upsert","ref":"new:bad","data":{"name":"无名氏"}}',
    ].join('\n'),
    '{"op":"noop"}',
  ]);
  const repo = createSqlRepository({
    chatUid: IDS.chatA,
    branchId: IDS.branchMain,
    branchName: '主线',
    modelPort: model,
    now: () => FIXED_AT,
    makeId: (kind, opId, alias) => `${kind.slice(0, 3)}_${Buffer.from(`${opId}:${alias}`).toString('hex').slice(0, 20)}`,
  });
  const seed = await makeSeedWith(SQL);
  const bytes = seed.exportBytes();
  seed.close();
  try {
    await repo.open({ bytes });
    const prepared = await repo.prepareTurn({
      anchor: {
        chatUid: IDS.chatA,
        branchId: IDS.branchMain,
        parentTurnId: IDS.seedTurn,
        hostMessageUid: 'msg_diag_1',
        variantKey: 'v1',
        baseRevision: 0,
        baseStorageRevision: 0,
        inputHash: 'input_diag_1',
      },
      userText: '',
      assistantText: '她在观察，剑却不见踪影。',
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    assert.equal(prepared.receipt.status, 'partial', '部分提交必须如实标 partial');
    await repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'saved' });

    const receipt = prepared.receipt;
    const rejectedGroup = receipt.groups.find((g) => g.status === 'rejected');
    assert.ok(rejectedGroup, '回执里必须有被拒绝的组');
    assert.equal(rejectedGroup.issues[0].code, 'MINIMUM_FIELD_MISSING');
    assert.equal(rejectedGroup.issues[0].line, 2);
    assert.equal(rejectedGroup.issues[0].path, '$.data.identity');

    const branch = queryBound(repo.db, 'SELECT revision FROM branches WHERE id = ?', [IDS.branchMain])[0];
    const timeline = queryDiagnostics(
      { db: repo.db, branchId: IDS.branchMain, revision: Number(branch.revision) },
      { kind: 'diagnostics', branchId: IDS.branchMain, limit: 100 },
    );

    // 推进页拿到的回执错误，点进日志页是同一个 log id。
    const receiptLogId = `turn_${receipt.turnId}`;
    const timelineItem = timeline.items.find((item) => item.logId === receiptLogId);
    assert.ok(timelineItem, '回执的 turn 必须在同一时间线上出现');
    assert.equal(timelineItem.kind, 'failed_turn');
    assert.equal(timelineItem.turnId, receipt.turnId, '两处引用同一个 turn');
    assert.equal(timelineItem.status, 'partial');
    const timelineRejected = timelineItem.receipt.groups.find((g) => g.groupId === rejectedGroup.groupId);
    assert.equal(timelineRejected.status, 'rejected');
    assert.deepEqual(timelineRejected.issues, rejectedGroup.issues, '回执投影与日志是同一份失败组');

    // 已提交的组也在同一 turn 的日志里，groupId 与回执一致（不是两栏各找一遍）。
    const appliedGroup = receipt.groups.find((g) => g.status === 'applied');
    const changeGroups = timeline.items
      .filter((item) => item.kind === 'change' && item.turnId === receipt.turnId)
      .map((item) => item.groupId);
    assert.ok(changeGroups.length >= 1, '本轮变更必须有日志行');
    assert.ok(changeGroups.includes(appliedGroup.groupId), '同一 group 在日志里有对应 log id');

    // 失败组的问题同样能用 §16.8 形状定位（真实回执 + G10）。
    const records = normalizeWorldIssueList(receipt.issues, {
      module: 'atlas-db-repository',
      chatUid: IDS.chatA,
      branchId: IDS.branchMain,
      turnId: receipt.turnId,
      batchId: 'batch_receipt',
      coreSaved: true,
    }, () => FIXED_AT);
    const located = records.find((r) => r.code === 'MINIMUM_FIELD_MISSING');
    assert.ok(located, '回执问题应能转成统一诊断');
    assert.equal(located.line, 2);
    assert.equal(located.path, '$.data.identity');
    assert.equal(located.coreSaved, true, '宿主确认保存后才是 true');
    assert.equal(countRows(repo.db, 'characters', IDS.branchMain), 4);
  } finally {
    await repo.close();
  }
});

test('T24-03 diagnosticsExportPage：分页 100 不截断导出，超留存给 droppedCount 与原因', () => {
  const entries = Array.from({ length: 250 }, (_v, i) =>
    normalizeWorldIssue(
      { at: FIXED_AT + i, module: 'atlas-db-views', code: 'CHANGE_ROW', message: `第 ${i} 条`, details: { index: i } },
      () => FIXED_AT,
    ),
  );

  const page1 = diagnosticsExportPage(entries);
  assert.equal(page1.items.length, ATLAS_RUNTIME_LIMITS.diagnosticPageSize, '默认页 100 条');
  assert.equal(page1.total, 250, 'total 是全部匹配记录');
  assert.equal(page1.nextCursor, '100');
  assert.equal(page1.droppedCount, 0);
  assert.equal(page1.exportComplete, false, '还有下一页时导出没走完');

  const page2 = diagnosticsExportPage(entries, page1.nextCursor);
  assert.equal(page2.items.length, 100);
  assert.equal(page2.nextCursor, '200');
  const page3 = diagnosticsExportPage(entries, page2.nextCursor);
  assert.equal(page3.items.length, 50);
  assert.equal(page3.nextCursor, undefined);
  assert.equal(page3.exportComplete, true, '翻完最后一页 = 全部匹配记录都导出了（不是只导 100 条）');
  assert.equal(page1.items.length + page2.items.length + page3.items.length, 250);
  assert.equal(page1.items[0].message, '第 0 条');
  assert.equal(page3.items[49].message, '第 249 条');

  // 超出留存范围：如实给 droppedCount + 原因，并且不假装完整。
  const withRetentionLoss = [
    ...entries.slice(-150),
    normalizeWorldIssue(
      {
        at: FIXED_AT,
        level: 'warn',
        module: 'atlas-diagnostics',
        code: 'DIAGNOSTICS_RETENTION_DROPPED',
        message: '留存范围外的旧记录已被淘汰',
        details: { droppedCount: 37, droppedReason: 'retention' },
      },
      () => FIXED_AT,
    ),
  ];
  const lossy = diagnosticsExportPage(withRetentionLoss, null, 500);
  assert.equal(lossy.droppedCount, 37);
  assert.equal(lossy.droppedReason, 'retention');
  assert.equal(lossy.exportComplete, false, '有丢弃就不算完整导出');
  assert.equal(lossy.total, 151);
});

test('T24-04 密钥脱敏：message 与 details 里的 sk-/Bearer/api_key/32+hex 全部抹掉', () => {
  const record = normalizeWorldIssue(
    {
      at: FIXED_AT,
      level: 'error',
      module: 'atlas-api-client',
      code: 'HTTP_ERROR',
      chatUid: IDS.chatA,
      turnId: IDS.seedTurn,
      message: `请求失败：Authorization: ${SECRET_BEARER}，${SECRET_APIKEY}，key=${SECRET_SK}`,
      details: {
        authorization: SECRET_BEARER,
        api_key: SECRET_SK,
        requestHeader: `Authorization: ${SECRET_BEARER}`,
        responseHash: HEX64,
        inputHash: 'f'.repeat(64),
        retryable: true,
        durationMs: 1234,
        httpStatus: 200,
      },
    },
    () => FIXED_AT,
  );

  const dump = JSON.stringify(record);
  for (const secret of [SECRET_SK, SECRET_BEARER, SECRET_APIKEY, HEX64, 'f'.repeat(64), 'AKIA1234567890ABCDEF']) {
    assert.ok(!dump.includes(secret), `不得出现密钥原文：${secret.slice(0, 24)}…`);
  }
  assert.ok(!dump.includes('sk-live'), 'sk- 片段必须被抹掉');
  assert.ok(!dump.includes('Bearer eyJ'), 'Bearer 令牌必须被抹掉');
  assert.ok(/^[a-fA-F0-9]{32,}$/.test(HEX64), '用例本身是 32+ 位十六进制串');
  assert.ok(!/[a-fA-F0-9]{32,}/.test(dump), '输出里不允许残留 32+ 位十六进制串');
  // 密钥型键直接丢，不进 details；正常诊断摘要保留。
  assert.equal(record.details.authorization, undefined);
  assert.equal(record.details.api_key, undefined);
  assert.equal(record.details.retryable, true);
  assert.equal(record.details.durationMs, 1234);
  assert.equal(record.details.httpStatus, 200);
  assert.match(String(record.details.responseHash), /^sha256:[a-f0-9]{12}…\(64\)$/, '哈希只留安全摘要');
  assert.ok(String(record.message).includes('请求失败'), 'message 仍然给人读');

  // 正文型键只留长度，不进原文。
  const promptText = '这是一段很长的提示词正文';
  const responseText = '这是模型正文';
  const withStory = normalizeWorldIssue(
    {
      at: FIXED_AT,
      module: 'atlas-model',
      code: 'MODEL_BATCH',
      message: '模型批次完成',
      details: { prompt: promptText, response: responseText, completion: 'x'.repeat(50) },
    },
    () => FIXED_AT,
  );
  assert.equal(withStory.details.prompt, `[text:${promptText.length}chars]`);
  assert.equal(withStory.details.response, `[text:${responseText.length}chars]`);
  assert.ok(!JSON.stringify(withStory).includes(promptText));
});

test('T24-05 redactWorldSecrets 与 module 缺失：明确报 DIAGNOSTIC_MODULE_REQUIRED，不静默', () => {
  assert.equal(redactWorldSecrets(SECRET_SK), 'sk-***');
  assert.equal(redactWorldSecrets(`token=${SECRET_SK}`), 'token=***');
  assert.equal(redactWorldSecrets(`x-api-key: ${SECRET_SK}`), 'x-api-key: ***');
  assert.equal(redactWorldSecrets(HEX64), 'sha256:a1b2c3d4a1b2…(64)');
  assert.equal(redactWorldSecrets('没有密钥的普通文本'), '没有密钥的普通文本');

  const record = normalizeWorldIssue(
    { at: FIXED_AT, level: 'info', module: '', code: 'G10_SMOKE', message: '缺少模块名' },
    () => FIXED_AT,
  );
  assert.equal(record.module, '');
  assert.equal(record.details.diagnosticCode, 'DIAGNOSTIC_MODULE_REQUIRED');
  assert.equal(record.details.moduleRequired, true);
  assert.equal(record.level, 'info');
  // 非法 code 不能冒充合法错误码。
  const bad = normalizeWorldIssue({ at: FIXED_AT, module: 'atlas-db-commit', code: 'not a code', message: '坏了' }, () => FIXED_AT);
  assert.equal(bad.code, 'UNEXPECTED_ERROR');
  // 默认 level = error，默认 at = 传入的时钟。
  const defaults = normalizeWorldIssue({ module: 'atlas-db-commit', code: 'X', message: 'm' }, () => FIXED_AT);
  assert.equal(defaults.level, 'error');
  assert.equal(defaults.at, FIXED_ISO);
});

test('T24-06 HTTP 200 不伪装提交成功：coreSaved 只取自显式确认', () => {
  const unsaved = normalizeWorldIssue(
    {
      at: FIXED_AT,
      level: 'error',
      module: 'atlas-db-repository',
      code: 'SESSION_WRITE_FAILED',
      chatUid: IDS.chatA,
      turnId: IDS.seedTurn,
      message: '宿主保存未确认（HTTP 200 只说明请求成功）',
      details: { httpStatus: 200, coreSaved: true, stage: 'host-save' },
      coreSaved: false,
    },
    () => FIXED_AT,
  );
  assert.equal(unsaved.coreSaved, false, 'HTTP 200 / details 里的 coreSaved 都不能推导已保存');
  assert.equal(unsaved.details.coreSaved, undefined, 'details 不得另造第二份 coreSaved');
  assert.equal(unsaved.details.httpStatus, 200);
  assert.equal(unsaved.code, 'SESSION_WRITE_FAILED');

  const omitted = normalizeWorldIssue({ at: FIXED_AT, module: 'atlas-db-repository', code: 'SESSION_WRITE_FAILED', message: '未确认' }, () => FIXED_AT);
  assert.equal(omitted.coreSaved, false, '缺省一律是未保存');

  const saved = normalizeWorldIssue(
    { at: FIXED_AT, module: 'atlas-db-repository', code: 'TURN_COMMIT', message: '保存已确认', coreSaved: true },
    () => FIXED_AT,
  );
  assert.equal(saved.coreSaved, true, '只有显式 true 才是已保存');

  // §16.8 固定形状：键集合与顺序固定。
  assert.deepEqual(Object.keys(saved), [
    'at', 'level', 'module', 'code', 'chatUid', 'branchId', 'turnId', 'attemptId', 'batchId',
    'message', 'details', 'coreSaved',
  ]);
  assert.equal(saved.chatUid, null);
  assert.equal(saved.branchId, null);
  assert.equal(saved.turnId, null);
  assert.equal(saved.attemptId, null);
  assert.equal(saved.batchId, null);
});
