/**
 * atlas-db-isolation.test.mjs — T12 聊天/分支隔离与读视图缓存（§18.3 / §7.1 / §7.3 / §10.1）。
 *
 * §18.3 必须覆盖的断言：
 * - 新聊天同角色卡无旧事件/人物位置：不同 chatUid 各自打开同一份合成种子，
 *   chat-A 里新建的人物/移动/事件（confirmSaved 已提交）在 chat-B 完全不可见；
 * - 同名不同 chat：两个聊天里同名的人物各自是一条独立行，字段可以各自发散；
 * - 分支独立：main-A 的写入不影响 main-B 的行（比较完整解码行）；
 * - 读缓存空结果清除：有结果的视图之后，换一个没有位置的实体查询必须返回 `items: []`，
 *   不能拿旧缓存顶上；重复第一次查询仍应正常，且结果带自己被请求的 branchId/revision。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, selectOne } from './fixtures/atlas-sql/seed.mjs';
import { SOURCE_SNAPSHOT } from './fixtures/atlas-sql/model-cases.mjs';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { decodeRow } from '../src/atlas-db-codec.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';

const SQL = await (await import('sql.js')).default();
const WALL = 1_700_000_000_000;

/** 确定性 makeId：同 (kind, opId, alias) → 同 ID，便于断言「跨聊天同名行」。 */
function makeId(kind, opId, alias) {
  let h = 0x811c9dc5;
  const text = `${kind}\u0000${opId}\u0000${alias}`;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${kind.slice(0, 3)}_${h.toString(16).padStart(8, '0')}_${Buffer.from(text).toString('hex').slice(-16)}`;
}

/** 固定输出模型端口：按调用顺序返回预置文本。 */
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

/** 同一份合成种子的字节，供两个聊天分别打开（模拟「同角色卡的新聊天」）。 */
async function seedBytes() {
  const seed = await makeSeedWith(SQL);
  const bytes = seed.exportBytes();
  seed.close();
  return bytes;
}

async function openRepo({ chatUid, branchId = IDS.branchMain, responses = [], bytes }) {
  const model = scriptedModel(responses);
  const repo = createSqlRepository({
    chatUid,
    branchId,
    branchName: '主线',
    modelPort: model,
    now: () => WALL,
    makeId,
  });
  const payload = bytes ?? (await seedBytes());
  await repo.open({ bytes: payload });
  return { repo, model };
}

function anchorFor(chatUid, branchId, baseRevision, overrides = {}) {
  return {
    chatUid,
    branchId,
    parentTurnId: IDS.seedTurn,
    hostMessageUid: 'msg_iso',
    variantKey: 'v1',
    baseRevision,
    baseStorageRevision: 0,
    inputHash: 'input_iso',
    ...overrides,
  };
}

function turnInput(anchor, assistantText, overrides = {}) {
  return {
    anchor,
    userText: '',
    assistantText,
    sourceSnapshot: SOURCE_SNAPSHOT,
    phaseBatches: ['observe'],
    manual: false,
    ...overrides,
  };
}

/** 整行（全部列）按列名排序解码；用于「完整解码行逐字段相同」的比较。 */
function fullRow(db, table, branchId, id) {
  const raw = queryBound(db, `SELECT * FROM ${table} WHERE branch_id = ? AND id = ?`, [branchId, id])[0];
  if (!raw) return null;
  const decoded = decodeRow(table, raw, { allowExtra: true });
  assert.equal(decoded.ok, true, `${table}.${id} 应能解码：${decoded.ok ? '' : decoded.issues.map((i) => i.code).join(',')}`);
  const row = decoded.row;
  return Object.fromEntries(Object.keys(row).sort().map((key) => [key, row[key]]));
}

/** internal 表的行数（没有 branch_id 列的表按全局计数）。 */
const GLOBAL_TABLES = new Set(['turns', 'turn_changes', 'sync_outbox']);
function rowCount(db, table, branchId) {
  const sql = GLOBAL_TABLES.has(table)
    ? `SELECT COUNT(*) AS n FROM ${table}`
    : `SELECT COUNT(*) AS n FROM ${table} WHERE branch_id = ?`;
  const params = GLOBAL_TABLES.has(table) ? [] : [branchId];
  return Number(queryBound(db, sql, params)[0].n);
}

/* ───────────── T12-01：新聊天同角色卡无旧事件/人物位置 ───────────── */

test('T12-01 新聊天同角色卡：chat-A 已提交的人物/位置/事件在 chat-B 完全不可见', async () => {
  const bytes = await seedBytes();
  const { repo: chatA } = await openRepo({ chatUid: IDS.chatA, responses: [
    [
      '{"op":"character.upsert","ref":"new:watcher","data":{"name":"夜枭","identity":"码头线人","importance":"supporting"}}',
      '{"op":"location.upsert","ref":"new:wharf","data":{"name":"旧码头","kind":"building","parent_ref":"L1"}}',
      '{"op":"character.upsert","ref":"C1","data":{"location_ref":"new:wharf","thought":"去码头看看。"}}',
      '{"op":"event.propose","data":{"title":"码头灯火","phase":"observed","location_ref":"new:wharf","subject_ref":"C1"}}',
    ].join('\n'),
  ], bytes });
  const { repo: chatB } = await openRepo({ chatUid: IDS.chatB, bytes });
  try {
    const beforeB = {
      characters: rowCount(chatB.db, 'characters', IDS.branchMain),
      locations: rowCount(chatB.db, 'locations', IDS.branchMain),
      events: rowCount(chatB.db, 'events', IDS.branchMain),
    };

    const prepared = await chatA.prepareTurn(turnInput(anchorFor(IDS.chatA, IDS.branchMain, 0), '他走向旧码头。'));
    assert.equal(prepared.receipt.status, 'committed', `chat-A 本轮应提交：${prepared.receipt.issues.map((i) => i.code).join(',')}`);
    await chatA.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'saved' });

    const newChar = queryBound(chatA.db, "SELECT id FROM characters WHERE branch_id = ? AND name = '夜枭'", [IDS.branchMain]);
    const newLoc = queryBound(chatA.db, "SELECT id FROM locations WHERE branch_id = ? AND name = '旧码头'", [IDS.branchMain]);
    const newEvent = queryBound(chatA.db, 'SELECT id FROM events WHERE branch_id = ?', [IDS.branchMain]);
    assert.equal(newChar.length, 1, 'chat-A 应新建一个「夜枭」');
    assert.equal(newLoc.length, 1, 'chat-A 应新建一个「旧码头」');
    assert.equal(newEvent.length, 1, 'chat-A 应有本轮事件');
    assert.equal(selectOne(chatA.db, 'characters', IDS.branchMain, IDS.C1).location_id, newLoc[0].id, 'chat-A 里 C1 应被移动到新地点');

    // chat-B 同角色卡：实体、位置、事件、身份键一个都不能看到
    assert.equal(queryBound(chatB.db, "SELECT id FROM characters WHERE name = '夜枭'").length, 0, 'chat-B 不得看到 chat-A 新建的人物');
    assert.equal(queryBound(chatB.db, "SELECT id FROM locations WHERE name = '旧码头'").length, 0, 'chat-B 不得看到 chat-A 新建的地点');
    assert.equal(rowCount(chatB.db, 'events', IDS.branchMain), 0, 'chat-B 不得看到 chat-A 的事件');
    assert.equal(selectOne(chatB.db, 'characters', IDS.branchMain, IDS.C1).location_id, IDS.L2, 'chat-B 里 C1 仍应在原地点');
    assert.equal(selectOne(chatB.db, 'characters', IDS.branchMain, IDS.C1).thought, '', 'chat-B 里 C1 心理不得被 chat-A 带偏');
    assert.equal(
      queryBound(chatB.db, 'SELECT id FROM entity_keys WHERE branch_id = ? AND id = ?', [IDS.branchMain, newChar[0].id]).length,
      0,
      'chat-B 不得注册 chat-A 新建的实体身份',
    );
    assert.equal(
      queryBound(chatB.db, 'SELECT id FROM entity_keys WHERE branch_id = ? AND id = ?', [IDS.branchMain, newLoc[0].id]).length,
      0,
      'chat-B 不得注册 chat-A 新建的地点身份',
    );
    assert.deepEqual(
      {
        characters: rowCount(chatB.db, 'characters', IDS.branchMain),
        locations: rowCount(chatB.db, 'locations', IDS.branchMain),
        events: rowCount(chatB.db, 'events', IDS.branchMain),
      },
      beforeB,
      'chat-B 的实体/位置/事件计数必须完全不变',
    );

    // 两个聊天各自有独立的推进版本与头指针
    assert.equal(Number(queryBound(chatA.db, 'SELECT revision FROM branches WHERE id = ?', [IDS.branchMain])[0].revision), 1);
    const branchB = queryBound(chatB.db, 'SELECT revision, head_turn_id FROM branches WHERE id = ?', [IDS.branchMain])[0];
    assert.equal(Number(branchB.revision), 0, 'chat-B 的 revision 不得被 chat-A 推进');
    assert.equal(branchB.head_turn_id, IDS.seedTurn);
  } finally {
    await chatB.close();
    await chatA.close();
  }
});

/* ───────────── T12-02：同名不同 chat ───────────── */

test('T12-02 同名不同 chat：同名人物在各自聊天里是独立行，字段可各自发散', async () => {
  const bytes = await seedBytes();
  const { repo: chatA } = await openRepo({
    chatUid: IDS.chatA,
    responses: ['{"op":"character.upsert","ref":"new:twin","data":{"name":"双子","identity":"A 侧身份"}}'],
    bytes,
  });
  const { repo: chatB } = await openRepo({
    chatUid: IDS.chatB,
    responses: ['{"op":"character.upsert","ref":"new:twin","data":{"name":"双子","identity":"B 侧身份"}}'],
    bytes,
  });
  try {
    for (const [repo, chatUid, msg] of [
      [chatA, IDS.chatA, 'm_a'],
      [chatB, IDS.chatB, 'm_b'],
    ]) {
      const prepared = await repo.prepareTurn(
        turnInput(anchorFor(chatUid, IDS.branchMain, 0, { hostMessageUid: msg }), '两个双子。'),
      );
      assert.equal(prepared.receipt.status, 'committed', `${chatUid} 本轮应提交`);
      await repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'saved' });
    }

    const rowA = queryBound(chatA.db, "SELECT id, name, identity FROM characters WHERE branch_id = ? AND name = '双子'", [IDS.branchMain]);
    const rowB = queryBound(chatB.db, "SELECT id, name, identity FROM characters WHERE branch_id = ? AND name = '双子'", [IDS.branchMain]);
    assert.equal(rowA.length, 1, 'chat-A 恰有一条「双子」');
    assert.equal(rowB.length, 1, 'chat-B 恰有一条「双子」');
    assert.equal(rowA[0].name, rowB[0].name, '两行同名');
    assert.notEqual(rowA[0].id, rowB[0].id, '同名但必须是两条不同 id 的行');

    // 写一侧的字段，另一侧逐列不变
    const beforeB = fullRow(chatB.db, 'characters', IDS.branchMain, rowB[0].id);
    const patch = await chatA.prepareTurn({
      ...turnInput(anchorFor(IDS.chatA, IDS.branchMain, 1, { hostMessageUid: 'm_a2', parentTurnId: IDS.seedTurn }), '甲侧更新。'),
      manual: true,
      sourceSnapshot: [],
      phaseBatches: [],
      operations: [{ op: 'character.upsert', ref: rowA[0].id, data: { identity: 'A 侧改过的身份', thought: 'A 侧的想法' } }],
    });
    assert.equal(patch.receipt.status, 'committed');
    await chatA.confirmSaved({ token: patch.token, snapshotSha256: patch.snapshotSha256, result: 'saved' });

    assert.equal(queryBound(chatA.db, 'SELECT identity FROM characters WHERE id = ?', [rowA[0].id])[0].identity, 'A 侧改过的身份');
    assert.deepEqual(fullRow(chatB.db, 'characters', IDS.branchMain, rowB[0].id), beforeB, 'chat-B 的同名行必须逐列不变');
    assert.equal(queryBound(chatB.db, 'SELECT identity FROM characters WHERE id = ?', [rowB[0].id])[0].identity, 'B 侧身份');
  } finally {
    await chatB.close();
    await chatA.close();
  }
});

/* ───────────── T12-03：分支独立 ───────────── */

test('T12-03 分支独立：main-A 的写入不改变 main-B 的完整行', async () => {
  const bytes = await seedBytes();
  const { repo: repoA } = await openRepo({
    chatUid: IDS.chatA,
    branchId: IDS.branchMain,
    responses: [
      [
        '{"op":"character.upsert","ref":"C1","data":{"thought":"主线改的想法"}}',
        '{"op":"item.upsert","ref":"I1","data":{"quantity":7}}',
        '{"op":"location.upsert","ref":"L2","data":{"description":"主线改过的说明"}}',
      ].join('\n'),
    ],
    bytes,
  });
  const { repo: repoB } = await openRepo({ chatUid: IDS.chatB, branchId: IDS.branchB, bytes });
  try {
    const before = {
      character: fullRow(repoB.db, 'characters', IDS.branchB, IDS.C1),
      item: fullRow(repoB.db, 'items', IDS.branchB, IDS.I1),
      location: fullRow(repoB.db, 'locations', IDS.branchB, IDS.L2),
      count: rowCount(repoB.db, 'characters', IDS.branchB),
    };
    assert.ok(before.character && before.item && before.location, 'main-B 的种子行必须存在');

    const prepared = await repoA.prepareTurn(turnInput(anchorFor(IDS.chatA, IDS.branchMain, 0), '主线发生了什么。'));
    assert.equal(prepared.receipt.status, 'committed', `main-A 本轮应提交：${prepared.receipt.issues.map((i) => i.code).join(',')}`);
    await repoA.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'saved' });

    assert.equal(queryBound(repoA.db, 'SELECT thought FROM characters WHERE branch_id = ? AND id = ?', [IDS.branchMain, IDS.C1])[0].thought, '主线改的想法');
    assert.deepEqual(fullRow(repoB.db, 'characters', IDS.branchB, IDS.C1), before.character, 'main-B 的人物行必须逐列不变');
    assert.deepEqual(fullRow(repoB.db, 'items', IDS.branchB, IDS.I1), before.item, 'main-B 的物品行必须逐列不变');
    assert.deepEqual(fullRow(repoB.db, 'locations', IDS.branchB, IDS.L2), before.location, 'main-B 的地点行必须逐列不变');
    assert.equal(rowCount(repoB.db, 'characters', IDS.branchB), before.count);
    const branchB = queryBound(repoB.db, 'SELECT revision, head_turn_id FROM branches WHERE id = ?', [IDS.branchB])[0];
    assert.equal(Number(branchB.revision), 0, 'main-B 的 revision 不得被 main-A 推进');
    assert.equal(branchB.head_turn_id, IDS.seedTurnB);
  } finally {
    await repoB.close();
    await repoA.close();
  }
});

/* ───────────── T12-04：读缓存空结果清除 ───────────── */

test('T12-04 读缓存空结果清除：空结果替换旧内容，重复首次查询仍正常且带请求的 branch/revision', async () => {
  const bytes = await seedBytes();
  const { repo } = await openRepo({
    chatUid: IDS.chatA,
    responses: ['{"op":"character.upsert","ref":"new:ghost","data":{"name":"无位者","identity":"来历不明"}}'],
    bytes,
  });
  try {
    const prepared = await repo.prepareTurn(turnInput(anchorFor(IDS.chatA, IDS.branchMain, 0), '一个没有位置的陌生人。'));
    assert.equal(prepared.receipt.status, 'committed');
    await repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'saved' });

    const revision = Number(queryBound(repo.db, 'SELECT revision FROM branches WHERE id = ?', [IDS.branchMain])[0].revision);
    assert.equal(revision, 1);

    // 1) 有内容的视图（C2 在 L1 有位置 → 同场相关者）
    const withContent = await repo.queryView({ kind: 'nearby', branchId: IDS.branchMain, entityId: IDS.C2, revision });
    assert.equal(withContent.branchId, IDS.branchMain, '视图必须带上被请求的 branchId');
    assert.equal(withContent.revision, revision, '视图必须带上被请求的 revision');
    assert.ok(withContent.items.length > 0, '第一次查询应有内容，否则这条缓存断言没有意义');
    assert.equal(withContent.items.every((item) => item.entityId !== IDS.C2), true, '自己不应出现在自己的附近名单里');

    // 2) 换成没有位置的实体：空结果必须真的清掉旧内容，不能被旧缓存顶上
    const ghost = queryBound(repo.db, "SELECT id FROM characters WHERE branch_id = ? AND name = '无位者'", [IDS.branchMain]);
    assert.equal(ghost.length, 1);
    const empty = await repo.queryView({ kind: 'nearby', branchId: IDS.branchMain, entityId: ghost[0].id, revision });
    assert.deepEqual(empty.items, [], '没有位置的实体必须返回空 items');
    assert.equal(empty.metadata.reason, 'POSITION_UNKNOWN');
    assert.equal(empty.branchId, IDS.branchMain);
    assert.equal(empty.revision, revision);

    // 3) 再查一次第一次的视图：没有交叉污染，仍然正常
    const again = await repo.queryView({ kind: 'nearby', branchId: IDS.branchMain, entityId: IDS.C2, revision });
    assert.deepEqual(again.items, withContent.items, '重复第一次查询必须仍返回同一份内容');
    assert.equal(again.branchId, withContent.branchId);
    assert.equal(again.revision, withContent.revision);

    // 4) 不存在的实体同样是空结果（不是旧的邻近名单）
    const unknown = await repo.queryView({ kind: 'nearby', branchId: IDS.branchMain, entityId: 'NO_SUCH_ENTITY', revision });
    assert.deepEqual(unknown.items, []);

    // 5) 空结果也带正确的 branch/revision；另一分支的查询不被本分支缓存冒充
    const otherBranch = await repo.queryView({ kind: 'map', branchId: IDS.branchB, revision });
    assert.equal(otherBranch.branchId, IDS.branchB, 'main-B 的查询必须返回 main-B');
    assert.equal(otherBranch.revision, revision);
    const map = await repo.queryView({ kind: 'map', branchId: IDS.branchMain, revision });
    assert.equal(map.branchId, IDS.branchMain);
    assert.equal(map.revision, revision);
    assert.ok(map.items.length > 0, '正式数据里的地图仍然可见');
  } finally {
    await repo.close();
  }
});
