/**
 * atlas-world-build-rollback.test.mjs — P05 §11.1/§11.2：楼层归属与回退。
 *
 * 走真实路径：prepareTurn → confirmSaved（真候选 + 真 journal），再 prepareRollback。
 * 验证的是「批次跟着楼层走」：回退哪一层就撤哪一层的进度，别的层原样保留。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { readProgressRows, scopeKeyFor } from '../src/atlas-construction-progress.ts';
import { createTableReadPort } from '../src/atlas-db-readport.ts';
import { summarizeSources } from '../src/atlas-construction-sources.ts';
import { makeSeedWith, IDS } from './fixtures/atlas-sql/seed.mjs';

const SQL = await (await import('sql.js')).default();
const BRANCH = IDS.branchMain;
const CHAT = IDS.chatA;
const noop = '{"op":"noop"}';

let sequence = 0;

const model = (fn) => ({
  calls: [],
  async request(req) {
    this.calls.push(req);
    return { batchId: req.batchId, text: fn(req, this.calls.length), httpStatus: 200, durationMs: 1 };
  },
});

const constructionCalls = (port) => port.calls.filter((call) => call.batchId.startsWith('construction_'));

async function fixture(port) {
  const seed = await makeSeedWith(SQL);
  const bytes = seed.exportBytes();
  seed.close();
  const repo = createSqlRepository({ chatUid: CHAT, branchId: BRANCH, modelPort: port });
  await repo.open({ bytes });
  return repo;
}

function turnInput(repo, extra = {}) {
  const id = `wb-rollback-${++sequence}`;
  return {
    anchor: {
      chatUid: CHAT,
      branchId: BRANCH,
      parentTurnId: repo.internal.currentHeadTurnId() ?? IDS.seedTurn,
      hostMessageUid: id,
      variantKey: 'author',
      inputHash: id,
      baseRevision: repo.internal.currentRevision(),
      baseStorageRevision: repo.storageRevision,
    },
    userText: '建设回退',
    assistantText: '建设回退',
    sourceSnapshot: [],
    manual: false,
    sceneOnly: true,
    phaseBatches: ['observe'],
    worldCompletion: { mode: 'local', focusLocationIds: [IDS.L2] },
    constructionContinue: true,
    ...extra,
  };
}

const save = (repo, prepared) => repo.confirmSaved({
  token: prepared.token,
  snapshotSha256: prepared.snapshotSha256,
  result: 'saved',
});

const progressRows = (db) => queryBound(db, 'SELECT * FROM construction_progress WHERE branch_id = ? ORDER BY id', [BRANCH]);
const progressCount = (repo) => progressRows(repo.db).length;

/** 足够长、会切多块并自带唯一尾部标记的来源。 */
const LONG_TEXT = `${'甲'.repeat(2600)}TAILMARK_ROLLBACK_7${'乙'.repeat(300)}`;
const sourceEntry = (text, hash) => [{ key: 'wb-rollback-lore', kind: 'lorebook', text, hash }];

/** 模型：建设请求里给一个真实的新房间，其余 noop。 */
const roomModel = () => model((req) => {
  if (!req.batchId.startsWith('construction_')) return noop;
  return `\n${JSON.stringify({
    op: 'location.upsert',
    ref: 'new:wb_rollback_room',
    data: { name: '回退试建房间', kind: 'room', parent_ref: IDS.L2 },
  })}`;
});

test('P05: 建设批次随楼层一起回退——来源/块/进度行回到本批之前', async () => {
  const port = roomModel();
  const repo = await fixture(port);
  try {
    const baseline = progressCount(repo);
    const prepared = await repo.prepareTurn(turnInput(repo, { sourceSnapshot: sourceEntry(LONG_TEXT, 'wb_hash_1') }));
    await save(repo, prepared);

    const afterRows = progressRows(repo.db);
    assert.ok(afterRows.length > baseline, '本批必须真的写了来源账本');
    assert.ok(afterRows.some((row) => row.kind === 'source'), '要有 source 行');
    assert.ok(afterRows.some((row) => row.kind === 'chunk'), '要有 chunk 行');
    assert.equal(constructionCalls(port).length, 1, '本批确实发过一次建设请求');

    const revision = repo.internal.currentRevision();
    const rollback = await repo.prepareRollback({
      chatUid: CHAT,
      branchId: BRANCH,
      targetParentTurnId: prepared.receipt.turnId,
      expectedRevision: revision,
    });
    await save(repo, rollback);

    assert.equal(progressCount(repo), baseline, '回退后进度行必须回到本批之前，不多不少');
    assert.deepEqual(queryBound(repo.db, 'PRAGMA foreign_key_check'), [], '回退后外键必须干净');

    const branch = queryBound(repo.db, 'SELECT head_turn_id, revision FROM branches WHERE id = ?', [BRANCH])[0];
    assert.equal(branch.head_turn_id, IDS.seedTurn, 'head 回到父楼');
    assert.equal(Number(branch.revision) > revision, true, '回退本身是一次新发布');
  } finally {
    await repo.close();
  }
});

test('P05: 回退只撤当前楼层，前一层建设进度原样保留', async () => {
  const port = roomModel();
  const repo = await fixture(port);
  try {
    const baseline = progressCount(repo);

    const first = await repo.prepareTurn(turnInput(repo, { sourceSnapshot: sourceEntry(LONG_TEXT, 'wb_hash_A') }));
    await save(repo, first);
    const afterFirst = progressCount(repo);
    assert.ok(afterFirst > baseline, '第一层要留下进度');

    const second = await repo.prepareTurn(turnInput(repo, {
      sourceSnapshot: sourceEntry(`${LONG_TEXT}补充`, 'wb_hash_B'),
    }));
    await save(repo, second);
    const afterSecond = progressCount(repo);
    assert.ok(afterSecond > afterFirst, '第二层要再留一批进度');

    const rollback = await repo.prepareRollback({
      chatUid: CHAT,
      branchId: BRANCH,
      targetParentTurnId: second.receipt.turnId,
      expectedRevision: repo.internal.currentRevision(),
    });
    await save(repo, rollback);

    assert.equal(progressCount(repo), afterFirst, '回退第二层：只撤第二层的进度，第一层原样保留');
    assert.ok(progressCount(repo) > baseline, '不能把前一层一起抹掉');
  } finally {
    await repo.close();
  }
});

test('P05: 回退之后来源账本仍可读出，且不残留已撤回的块', async () => {
  const port = roomModel();
  const repo = await fixture(port);
  try {
    const prepared = await repo.prepareTurn(turnInput(repo, { sourceSnapshot: sourceEntry(LONG_TEXT, 'wb_hash_C') }));
    await save(repo, prepared);

    const scopeKey = scopeKeyFor('local', [IDS.L2]);
    const rowsBefore = readProgressRows(createTableReadPort(repo.db), BRANCH);
    const summaryBefore = summarizeSources(rowsBefore, scopeKey);
    assert.ok(summaryBefore.totalChars > 0, '回退前账本里有内容');

    const rollback = await repo.prepareRollback({
      chatUid: CHAT,
      branchId: BRANCH,
      targetParentTurnId: prepared.receipt.turnId,
      expectedRevision: repo.internal.currentRevision(),
    });
    await save(repo, rollback);

    const rowsAfter = readProgressRows(createTableReadPort(repo.db), BRANCH);
    const summaryAfter = summarizeSources(rowsAfter, scopeKey);
    assert.equal(summaryAfter.totalChars, 0, '撤回楼层后，该 scope 的来源账本不应再声称读过这些内容');
    assert.equal(rowsAfter.filter((row) => row.kind === 'chunk').length, 0, '块行必须一起撤销');
  } finally {
    await repo.close();
  }
});
