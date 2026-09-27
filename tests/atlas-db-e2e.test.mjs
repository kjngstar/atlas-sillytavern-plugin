/**
 * atlas-db-e2e.test.mjs — T28 端到端（离线，无真实宿主/无真实 API）。
 *
 * 走完「观察 → 提交 → 宿主保存 → 地图视图 → 消息 → 世界书同步 → 回退」，然后换新聊天。
 * 每一步断言的是**可观察的数据结果**，不是「函数被调到」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, insertRows } from './fixtures/atlas-sql/seed.mjs';
import { SOURCE_SNAPSHOT } from './fixtures/atlas-sql/model-cases.mjs';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { createAtlasHostPort } from '../src/atlas-host-port.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { enqueueProjectionSync, projectionHash, rebuildManagedLorebook, runNextSync } from '../src/atlas-db-outbox.ts';

const SQL = await (await import('sql.js')).default();

function scriptedModel(responses) {
  const calls = [];
  return {
    calls,
    async request(req) {
      calls.push(req.phase);
      const text = responses.length > 0 ? responses.shift() : '{"op":"noop"}';
      return { batchId: req.batchId, text, finishReason: 'stop', httpStatus: 200, durationMs: 3 };
    },
  };
}

function anchorFor(baseRevision, hostMessageUid = 'm1', variantKey = 'v1') {
  return {
    chatUid: IDS.chatA,
    branchId: IDS.branchMain,
    parentTurnId: IDS.seedTurn,
    hostMessageUid,
    variantKey,
    baseRevision,
    baseStorageRevision: 0,
    inputHash: `hash_${hostMessageUid}_${variantKey}`,
  };
}

async function makeSystem(responses) {
  const seed = await makeSeedWith(SQL);
  const bytes = seed.exportBytes();
  seed.close();
  const model = scriptedModel(responses);
  const state = {
    ctx: {
      chatId: IDS.chatA,
      chatMetadata: { atlas: { schemaVersion: 1, world: { id: 'world_A' } } },
      saveMetadata: async () => true,
    },
  };
  const repo = createSqlRepository({
    chatUid: IDS.chatA,
    branchId: IDS.branchMain,
    branchName: '主线',
    modelPort: model,
    now: () => 1_700_000_000_000,
  });
  await repo.open({ bytes });
  const host = createAtlasHostPort({
    context: () => state.ctx,
    readBranchState: () => ({ branchId: IDS.branchMain, revision: Number(queryBound(repo.db, 'SELECT revision FROM branches WHERE id = ?', [IDS.branchMain])[0].revision), storageRevision: 0 }),
  });
  return { repo, host, model, state };
}

test('T28-01 全链路：观察建实体 → 宿主保存 → 地图可见 → 同步任务 → 回退', async () => {
  const { repo, host, state } = await makeSystem([
    '{"op":"character.upsert","ref":"new:elin2","data":{"name":"新来的教师","identity":"代课教师","location_ref":"L2"}}',
  ]);
  try {
    // 1) 观察 + 提交（候选）
    const prepared = await repo.prepareTurn({
      anchor: anchorFor(0, 'm1'),
      userText: '走进学校。',
      assistantText: '一位代课教师在学校里。',
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    assert.equal(prepared.receipt.status, 'committed');

    // 2) 宿主保存（envelope 落到 chatMetadata.atlas.database）
    const hostAnchor = host.captureAnchor();
    const ack = await host.saveCandidate({ capturedHostAnchor: hostAnchor, prepared, envelope: prepared.snapshot ? await repo.currentEnvelope() : null });
    assert.equal(ack.result, 'saved');
    assert.ok(state.ctx.chatMetadata.atlas.database, '存档信封必须落在 chatMetadata.atlas.database');
    // 保存的 envelope 内容必须是**候选**（含新人物）
    const published = await repo.confirmSaved(ack);
    assert.equal(published, undefined);
    const created = queryBound(repo.db, 'SELECT id FROM characters WHERE name = ?', ['新来的教师']);
    assert.equal(created.length, 1);

    // 3) 地图视图读到同一份权威
    const map = await repo.queryView({ kind: 'map', branchId: IDS.branchMain });
    const world = map.items.find((m) => m.mapId === IDS.M1);
    assert.ok(world.coarseList.some((c) => c.entityId === created[0].id && c.locationId === IDS.L2), '新人物以粗定位出现在学校名单');

    // 4) 世界书同步：先失败（核心仍已保存），再成功
    const tasks = queryBound(repo.db, "SELECT id, target_revision, status FROM sync_outbox WHERE status = 'pending'");
    assert.equal(tasks.length, 1, '提交成功应登记一条同步意图');
    const failing = {
      listKeys: async () => [],
      read: async () => null,
      write: async () => {
        throw new Error('世界书暂时不可用');
      },
      remove: async () => {},
    };
    const failed = await runNextSync(repo.db, failing, {
      branchId: IDS.branchMain,
      chatUid: IDS.chatA,
      nowWallMs: 1_700_000_000_000,
      buildProjection: (scope, revision) => [
        { key: `atlas:${IDS.chatA}:${IDS.branchMain}:${scope}`, chatUid: IDS.chatA, branchId: IDS.branchMain, scope, revision, content: '投影内容' },
      ],
    });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCode, 'WORLD_SYNC_FAILED');
    const stillThere = queryBound(repo.db, 'SELECT COUNT(*) AS n FROM characters WHERE name = ?', ['新来的教师']);
    assert.equal(Number(stillThere[0].n), 1, '世界书失败不得丢核心回合');

    const memory = [];
    const working = {
      listKeys: async () => memory.map((m) => m.key),
      read: async (k) => memory.find((m) => m.key === k)?.content ?? null,
      write: async (entries) => {
        for (const e of entries) memory.push(e);
      },
      remove: async (keys) => {
        for (const k of keys) {
          const idx = memory.findIndex((m) => m.key === k);
          if (idx >= 0) memory.splice(idx, 1);
        }
      },
    };
    const okSync = await runNextSync(repo.db, working, {
      branchId: IDS.branchMain,
      chatUid: IDS.chatA,
      nowWallMs: 1_700_000_000_000 + 10 * 60 * 1000,
      buildProjection: (scope, revision) => [
        { key: `atlas:${IDS.chatA}:${IDS.branchMain}:${scope}`, chatUid: IDS.chatA, branchId: IDS.branchMain, scope, revision, content: '投影内容' },
      ],
    });
    assert.equal(okSync.status, 'succeeded');
    const remaining = queryBound(repo.db, "SELECT COUNT(*) AS n FROM sync_outbox WHERE status IN ('pending','running')");
    assert.equal(Number(remaining[0].n), 0, '同步成功后不留待办（且不生成无限新任务）');
    const outboxCount = queryBound(repo.db, 'SELECT COUNT(*) AS n FROM sync_outbox');
    assert.equal(Number(outboxCount[0].n), 1, '同步结果不得产生新任务');

    // 5) 回退：因果后继恢复 before，clock/revision 一致
    const rollback = await repo.prepareRollback({
      chatUid: IDS.chatA,
      branchId: IDS.branchMain,
      targetParentTurnId: IDS.seedTurn,
      expectedRevision: 1,
    });
    await repo.confirmSaved({ token: rollback.token, snapshotSha256: rollback.snapshotSha256, result: 'saved' });
    const afterRollback = queryBound(repo.db, 'SELECT COUNT(*) AS n FROM characters WHERE name = ?', ['新来的教师']);
    assert.equal(Number(afterRollback[0].n), 0, '回退后本轮新建的人物必须消失');
    const head = queryBound(repo.db, 'SELECT head_turn_id FROM branches WHERE id = ?', [IDS.branchMain])[0];
    assert.equal(head.head_turn_id, IDS.seedTurn);
  } finally {
    await repo.close();
  }
});

test('T28-02 换新聊天：同一角色卡不继承上一聊天的位置/风声', async () => {
  const { repo } = await makeSystem(['{"op":"location.upsert","ref":"new:only_a","data":{"name":"A 聊专属地点","kind":"building"}}']);
  let repoB = null;
  try {
    const prepared = await repo.prepareTurn({
      anchor: anchorFor(0, 'm1'),
      userText: '',
      assistantText: '只有一个地点。',
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    await repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'saved' });
    assert.equal(queryBound(repo.db, 'SELECT COUNT(*) AS n FROM locations WHERE name = ?', ['A 聊专属地点'])[0].n, 1);

    // 新聊天：全新 chat_uid + 全新库（同角色卡 => 同一份种子，但世界状态独立）
    const seedB = await makeSeedWith(SQL);
    const bytesB = seedB.exportBytes();
    seedB.close();
    repoB = createSqlRepository({ chatUid: IDS.chatB, branchId: IDS.branchMain, branchName: '主线', modelPort: scriptedModel([]) });
    await repoB.open({ bytes: bytesB });
    assert.equal(queryBound(repoB.db, 'SELECT COUNT(*) AS n FROM locations WHERE name = ?', ['A 聊专属地点'])[0].n, 0);
    assert.equal(repoB.chatUid, IDS.chatB);
  } finally {
    if (repoB) await repoB.close();
    await repo.close();
  }
});

test('T28-03 删楼重生成：同一 hostMessageUid 的新 variant 从共同父状态开始，不叠加旧结果', async () => {
  const { repo } = await makeSystem(['{"op":"character.upsert","ref":"C1","data":{"thought":"第一版的想法"}}']);
  try {
    const first = await repo.prepareTurn({
      anchor: anchorFor(0, 'm1', 'v1'),
      userText: '',
      assistantText: '第一版。',
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
    });
    await repo.confirmSaved({ token: first.token, snapshotSha256: first.snapshotSha256, result: 'saved' });
    assert.equal(queryBound(repo.db, 'SELECT thought FROM characters WHERE id = ?', [IDS.C1])[0].thought, '第一版的想法');

    // 回到共同父状态（删楼），再用同一 hostMessageUid 的另一 variant 重生成
    const rollback = await repo.prepareRollback({
      chatUid: IDS.chatA,
      branchId: IDS.branchMain,
      targetParentTurnId: IDS.seedTurn,
      expectedRevision: 1,
    });
    await repo.confirmSaved({ token: rollback.token, snapshotSha256: rollback.snapshotSha256, result: 'saved' });

    // 换成第二版输出（回退后 revision 已是 2：锚点必须用当前值，否则 STALE_BASE）
    const second = await (async () => {
      const model = scriptedModel(['{"op":"character.upsert","ref":"C1","data":{"thought":"第二版的想法"}}']);
      const bytes = await repo.exportCurrent();
      const next = createSqlRepository({ chatUid: IDS.chatA, branchId: IDS.branchMain, branchName: '主线', modelPort: model });
      await next.open({ bytes });
      try {
        const revision = Number(queryBound(next.db, 'SELECT revision FROM branches WHERE id = ?', [IDS.branchMain])[0].revision);
        const prepared = await next.prepareTurn({
          anchor: anchorFor(revision, 'm1', 'v2'),
          userText: '',
          assistantText: '第二版。',
          sourceSnapshot: SOURCE_SNAPSHOT,
          phaseBatches: ['observe'],
          manual: false,
        });
        await next.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'saved' });
        return queryBound(next.db, 'SELECT thought FROM characters WHERE id = ?', [IDS.C1])[0].thought;
      } finally {
        await next.close();
      }
    })();
    assert.equal(second, '第二版的想法', '新 variant 从共同父状态开始，不叠加第一版结果');
  } finally {
    await repo.close();
  }
});

test('T28-04 rebuildManagedLorebook 只动 Atlas 专属条目，不覆盖用户原有世界书', async () => {
  const books = [
    { key: 'user:我的设定', content: '用户自己的条目' },
    { key: `atlas:${IDS.chatA}:${IDS.branchMain}:pov`, content: '旧投影' },
    { key: 'atlas:other-chat:main-A:pov', content: '别的聊天的投影' },
  ];
  const port = {
    listKeys: async () => books.map((b) => b.key),
    read: async (k) => books.find((b) => b.key === k)?.content ?? null,
    write: async (entries) => {
      for (const e of entries) books.push({ key: e.key, content: e.content });
    },
    remove: async (keys) => {
      for (const k of keys) {
        const idx = books.findIndex((b) => b.key === k);
        if (idx >= 0) books.splice(idx, 1);
      }
    },
  };
  const result = await rebuildManagedLorebook(port, {
    chatUid: IDS.chatA,
    branchId: IDS.branchMain,
    revision: 2,
    buildProjection: () => [
      { key: `atlas:${IDS.chatA}:${IDS.branchMain}:pov`, chatUid: IDS.chatA, branchId: IDS.branchMain, scope: 'pov', revision: 2, content: '新投影' },
    ],
  });
  assert.deepEqual(result.removed, [`atlas:${IDS.chatA}:${IDS.branchMain}:pov`]);
  assert.equal(books.some((b) => b.key === 'user:我的设定'), true, '用户原有条目必须保留');
  assert.equal(books.some((b) => b.key === 'atlas:other-chat:main-A:pov'), true, '别的聊天的条目不动');
  assert.equal(books.find((b) => b.key === `atlas:${IDS.chatA}:${IDS.branchMain}:pov`).content, '新投影');
});

test('T28-05 sync_outbox：旧 revision 任务被 superseded，幂等键不重复插入', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    let seq = 0;
    const makeId = () => `out_${++seq}`;
    const first = enqueueProjectionSync(seed.db, {
      branchId: IDS.branchMain,
      turnId: IDS.seedTurn,
      targetRevision: 1,
      projectionScope: 'pov',
      payloadHash: projectionHash({ a: 1 }),
      nowWallMs: 1000,
      makeId,
    });
    assert.equal(first.enqueued, true);
    const second = enqueueProjectionSync(seed.db, {
      branchId: IDS.branchMain,
      turnId: IDS.seedTurn,
      targetRevision: 2,
      projectionScope: 'pov',
      payloadHash: projectionHash({ a: 2 }),
      nowWallMs: 2000,
      makeId,
    });
    assert.equal(second.enqueued, true);
    assert.deepEqual(second.superseded, [first.taskId], '旧 revision 任务必须被取消');
    const statuses = queryBound(seed.db, 'SELECT id, status FROM sync_outbox ORDER BY created_wall_ms');
    assert.equal(statuses[0].status, 'superseded');
    assert.equal(statuses[1].status, 'pending');
    // 幂等键唯一：同 revision 同 hash 再入队不会新增
    const again = enqueueProjectionSync(seed.db, {
      branchId: IDS.branchMain,
      turnId: IDS.seedTurn,
      targetRevision: 2,
      projectionScope: 'pov',
      payloadHash: projectionHash({ a: 2 }),
      nowWallMs: 3000,
      makeId,
    });
    assert.equal(again.enqueued, false);
    assert.equal(queryBound(seed.db, 'SELECT COUNT(*) AS n FROM sync_outbox')[0].n, 2);
  } finally {
    seed.close();
  }
});

test('T28-06 插入信息后不会自动给全城加认知（front ≠ knowledge）', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    insertRows(seed.db, 'information', [
      {
        branch_id: IDS.branchMain,
        id: 'INFO9',
        row_rev: 1,
        created_turn_id: IDS.seedTurn,
        updated_turn_id: IDS.seedTurn,
        kind: 'rumor',
        title: '城里传言',
        content: '城里有传言',
        truth_status: 'unknown',
        secrecy: 'public',
        topic_key: 'tp',
        content_hash: 'hp',
        created_at_s: 0,
        status: 'active',
      },
    ]);
    insertRows(seed.db, 'rumor_fronts', [
      {
        branch_id: IDS.branchMain,
        id: 'FR9',
        row_rev: 1,
        created_turn_id: IDS.seedTurn,
        updated_turn_id: IDS.seedTurn,
        information_id: 'INFO9',
        location_id: IDS.L1,
        first_available_at_s: 0,
        last_reinforced_at_s: 0,
        reach: 'local',
        audience_json: JSON.stringify({ access: 'public', tags: [] }),
        status: 'active',
      },
    ]);
    const knowledgeCount = queryBound(seed.db, 'SELECT COUNT(*) AS n FROM knowledge')[0].n;
    assert.equal(Number(knowledgeCount), 0, '有风声不等于有人已知情');
    const fronts = queryBound(seed.db, 'SELECT COUNT(*) AS n FROM rumor_fronts')[0].n;
    assert.equal(Number(fronts), 1);
  } finally {
    seed.close();
  }
});
