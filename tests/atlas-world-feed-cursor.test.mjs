/**
 * atlas-world-feed-cursor.test.mjs — M5-12 验收（E08 同刻多回合 / E09 分页失效 / E10 完整大回合）。
 *
 * 走真实 repo.queryView({kind:'world-feed'})；E09 的「API 只允许合法筛选键 + 冲突/参数状态码」
 * 另外走真实路由分发（注入 sessionProvider），验证的是 HTTP 状态本身。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS } from './fixtures/atlas-sql/seed.mjs';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { createAtlasSqlRouteGroup } from '../src/atlas-sql-routes.ts';
import { handleSqlChatRequest } from '../src/atlas-sql-chat.ts';

const SQL = await (await import('sql.js')).default();
const NOW_WALL_MS = 1_700_000_000_000;
const BRANCH = IDS.branchMain;

function scriptedModel() {
  const calls = [];
  return {
    calls,
    async request(req) {
      calls.push(req.phase);
      return { batchId: req.batchId, text: '{"op":"noop"}', finishReason: 'stop', httpStatus: 200, durationMs: 1 };
    },
  };
}

async function makeSystem() {
  const seed = await makeSeedWith(SQL);
  const bytes = seed.exportBytes();
  seed.close();
  const model = scriptedModel();
  const repo = createSqlRepository({ chatUid: IDS.chatA, branchId: BRANCH, branchName: '主线', modelPort: model, now: () => NOW_WALL_MS });
  await repo.open({ bytes });
  return { repo, model };
}

function addTurn(db, id, rev, clockS, kind = 'narrative') {
  db.run(
    `INSERT INTO turns (id, branch_id, parent_turn_id, host_message_uid, host_variant_key, kind, input_hash, story_hash,
       base_revision, committed_revision, clock_before_s, elapsed_json, clock_after_s, rng_seed, ruleset_version,
       decisions_json, receipt_json, attempts_json, status, created_wall_ms, prepared_wall_ms)
     VALUES (?, ?, NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?, '{"min_s":0,"nominal_s":0,"max_s":0,"quality":"explicit","basis_refs":[]}', ?, ?, 'atlas-1', '{}', NULL, '[]', 'committed', ?, NULL)`,
    [id, BRANCH, kind, `hash_${id}`, rev - 1, rev, clockS, clockS, `rng_${id}`, NOW_WALL_MS],
  );
}

function journal(db, id, turn, seq, table, rowId, before, after, groupId, opId) {
  const operation = before === null ? 'insert' : after === null ? 'delete' : 'update';
  db.run(
    `INSERT INTO turn_changes (id, turn_id, sequence, attempt_id, group_id, operation_id, target_table, target_row_id,
       operation, before_json, after_json, basis_json, summary)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, '{}', '')`,
    [
      id, turn, seq, groupId, opId, table, rowId, operation,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
    ],
  );
}

function addEvent(db, id, turn, clockS, extra = {}) {
  const row = {
    branch_id: BRANCH, id, row_rev: 1, created_turn_id: turn, updated_turn_id: turn,
    title: extra.title ?? `事件${id}`, kind: 'incident', summary: '', location_id: IDS.L1,
    route_id: null, route_progress_m: null, subject_entity_id: null, participants_json: '[]',
    cause_action_id: null, parent_event_id: null, scheduled_start_s: null, trigger_json: null,
    occurred_at_s: clockS, ended_at_s: null, outcome: '', secrecy: 'public', status: 'occurred',
  };
  const cols = Object.keys(row);
  db.run(`INSERT INTO events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
  journal(db, `je_${id}`, turn, 1, 'events', id, null, row, `ge_${id}`, `oe_${id}`);
}

const itemSnap = (id, qty) => ({
  branch_id: BRANCH, id, row_rev: 1, name: id, quantity: qty,
  holder_character_id: IDS.C1, location_id: null, container_item_id: null, status: 'active',
});

const readFeed = (repo, extra = {}) =>
  repo.queryView({ kind: 'world-feed', branchId: BRANCH, viewMode: 'author', ...extra });

/* ─────────────────────────────── E08 ─────────────────────────────── */

test('E08-01 同一时刻多回合：按 time/revision/id 稳定排序，latestNarrative 来自真实叙事回合', async () => {
  const { repo } = await makeSystem();
  try {
    const db = repo.db;
    // 三轮叙事，故事时钟完全相同（同一时刻的多个楼层），只有 revision 不同。
    for (const [i, id] of ['T1', 'T2', 'T3'].entries()) {
      addTurn(db, id, i + 1, 100);
      addEvent(db, `E${i + 1}`, id, 100);
    }
    db.run(`UPDATE branches SET revision=3, head_turn_id='T3' WHERE id=?`, [BRANCH]);

    const result = await readFeed(repo);
    const cards = result.items.filter((i) => i.category === 'event');
    assert.equal(cards.length, 3);
    assert.deepEqual(
      cards.map((c) => c.turnId),
      ['T3', 'T2', 'T1'],
      '同刻时按 revision 降序，最新提交在前',
    );
    assert.deepEqual(cards.map((c) => c.occurredAtS), [100, 100, 100], '三张卡的时刻确实相同');

    assert.equal(result.metadata.latestNarrativeTurnId, 'T3', '最新叙事回合来自真实 turns.kind');

    // 再来一个 manual 回合，时钟更大：它绝不能顶替 latestNarrativeTurnId。
    addTurn(db, 'T4', 4, 999, 'manual');
    db.run(`UPDATE branches SET revision=4, head_turn_id='T4' WHERE id=?`, [BRANCH]);
    const after4 = await readFeed(repo);
    assert.equal(after4.metadata.latestNarrativeTurnId, 'T3', 'manual 标定不改变最新叙事回合');
    assert.equal(after4.items.some((i) => i.turnId === 'T4'), false, 'manual 回合不产出剧情卡');
  } finally {
    await repo.close();
  }
});

/* ─────────────────────────────── E09 ─────────────────────────────── */

test('E09-01 分支/revision/视角/POV/筛选任一改变 → VIEW_CURSOR_STALE', async () => {
  const { repo } = await makeSystem();
  try {
    const db = repo.db;
    for (const [i, id] of ['T1', 'T2', 'T3'].entries()) {
      addTurn(db, id, i + 1, 100 + i);
      addEvent(db, `E${i + 1}`, id, 100 + i);
    }
    db.run(`UPDATE branches SET revision=3, head_turn_id='T3' WHERE id=?`, [BRANCH]);

    // 用 author 视角做基线：这三件事件发生在 L1，而主角在 L2 且无情报，
    // POV 视角下本来就一条都看不到（那是 M5-11 的判定），不适合用来测游标。
    const page1 = await readFeed(repo, { limit: 2, povId: IDS.C1, viewMode: 'author' });
    assert.equal(page1.items.length, 2, '第一页应有 2 条');
    assert.ok(page1.nextCursor, '应给出下一页游标');
    const cursor = page1.nextCursor;

    const expectStale = async (label, extra) => {
      await assert.rejects(
        () => repo.queryView({ kind: 'world-feed', branchId: BRANCH, viewMode: 'author', povId: IDS.C1, limit: 2, cursor, ...extra }),
        (err) => {
          assert.equal(err.code, 'VIEW_CURSOR_STALE', `${label}：期望 VIEW_CURSOR_STALE，实际 ${err.code}`);
          return true;
        },
        label,
      );
    };

    await expectStale('revision 变化', (() => {
      db.run(`UPDATE branches SET revision=4 WHERE id=?`, [BRANCH]);
      return {};
    })());
    db.run(`UPDATE branches SET revision=3 WHERE id=?`, [BRANCH]);

    await expectStale('branch 变化', { branchId: IDS.branchB });
    await expectStale('viewMode 变化', { viewMode: 'pov' });
    await expectStale('povId 变化', { povId: IDS.C2 });
    await expectStale('filter 变化', { feedFilter: { category: 'event' } });

    // 形状坏掉的游标是 INVALID（参数问题），不是 STALE（冲突）。
    await assert.rejects(
      () => readFeed(repo, { limit: 2, povId: IDS.C1, viewMode: 'author', cursor: 'not-a-cursor' }),
      (err) => {
        assert.equal(err.code, 'VIEW_CURSOR_INVALID');
        return true;
      },
    );

    // 不换任何条件时，同一游标必须继续可用（不能说变就变）。
    const page2 = await readFeed(repo, { limit: 2, povId: IDS.C1, viewMode: 'author', cursor });
    assert.ok(page2.items.length >= 1, '游标未失效时应能继续翻页');
    const ids1 = new Set(page1.items.map((i) => i.id));
    assert.equal(page2.items.some((i) => ids1.has(i.id)), false, '翻页不得重复返回同一条');
  } finally {
    await repo.close();
  }
});

test('E09-02 API 只允许合法筛选键；冲突 409 / 参数 400 各自明确', async () => {
  const { repo } = await makeSystem();
  try {
    const db = repo.db;
    for (const [i, id] of ['T1', 'T2', 'T3'].entries()) {
      addTurn(db, id, i + 1, 100 + i);
      addEvent(db, `E${i + 1}`, id, 100 + i);
    }
    db.run(`UPDATE branches SET revision=3, head_turn_id='T3' WHERE id=?`, [BRANCH]);

    const session = {
      repo, source: 'existing', envelopePresent: true, issues: [],
      chatUid: IDS.chatA, worldUid: 'world_A', branchId: BRANCH, branchName: '主线', rulesetVersion: 'atlas-1',
      chatMetadata: {}, saveSession: null, modelPort: null, now: () => NOW_WALL_MS, confirmSave: false,
      hostPort: {}, lorebookPort: null, buildProjection: null, closed: false,
    };
    const group = createAtlasSqlRouteGroup({
      repository: repo,
      sessionProvider: {
        enabled: () => true,
        runtime: async () => ({ handleSqlChatRequest }),
        session: async () => session,
        saved: () => {},
        close: async () => {},
      },
    });
    const post = (body) => group.handle('POST', '/sql/chat/ui-read', { chatUid: IDS.chatA, branchId: BRANCH, kind: 'world-feed', ...body });

    // 合法筛选键 → 200
    const legal = await post({ feedFilter: { category: 'event', currentTurnOnly: false } });
    assert.equal(legal.status, 200, `合法筛选应 200，实际 ${legal.status}：${JSON.stringify(legal.body)?.slice(0, 300)}`);

    // 未知键 → 400
    const extraKey = await post({ feedFilter: { category: 'event', dropTable: 'users' } });
    assert.equal(extraKey.status, 400, '未知筛选键必须 400');
    assert.equal(extraKey.body.error.code, 'INVALID_PAYLOAD');

    // 非法取值 → 400
    const badValue = await post({ feedFilter: { category: '不存在的分类' } });
    assert.equal(badValue.status, 400);
    assert.equal(badValue.body.error.code, 'INVALID_PAYLOAD');

    // 客户端想借别人（敌对方）角色的视角 → 400，且不区分「不存在/没授权」
    const foreignPov = await post({ povId: IDS.C3 });
    assert.equal(foreignPov.status, 400, '不允许任意选择视角');
    assert.equal(foreignPov.body.error.code, 'INVALID_PAYLOAD');

    // 拿旧游标重来 → 409（客户端应重读第一页，而不是当成服务 500）
    const first = await post({ limit: 2, viewMode: 'author' });
    assert.equal(first.status, 200);
    const cursor = first.body.data?.nextCursor;
    assert.ok(cursor, '第一页应带游标');
    db.run(`UPDATE branches SET revision=9 WHERE id=?`, [BRANCH]);
    const stale = await post({ limit: 2, viewMode: 'author', cursor });
    assert.equal(stale.status, 409, `游标过期必须 409，实际 ${stale.status}`);
    assert.equal(stale.body.error.code, 'VIEW_CURSOR_STALE');

    await group.close();
  } finally {
    await repo.close();
  }
});

/* ─────────────────────────────── E10 ─────────────────────────────── */

test('E10-01 单轮 150 条业务 journal：整轮算净变化，跨页不重不漏', async () => {
  const { repo } = await makeSystem();
  try {
    const db = repo.db;
    const TOTAL = 150;
    const ids = [];
    for (let i = 0; i < TOTAL; i += 1) {
      const id = i === 0 ? IDS.I1 : `B${String(i).padStart(3, '0')}`;
      ids.push(id);
      if (id !== IDS.I1) {
        db.run(`INSERT INTO entity_keys (branch_id, id, kind) VALUES (?, ?, 'item')`, [BRANCH, id]);
      }
    }
    addTurn(db, 'T1', 1, 100);
    // 每条一行净变化；数量从 1 → 2，整轮必须都算到。
    for (const [i, id] of ids.entries()) {
      journal(db, `jb${i}`, 'T1', i + 1, 'items', id, itemSnap(id, 1), itemSnap(id, 2), `gb${i}`, `ob${i}`);
    }
    db.run(`UPDATE branches SET revision=1, head_turn_id='T1' WHERE id=?`, [BRANCH]);

    // 跨页收集：默认一页 50。
    const seen = [];
    let cursor;
    for (let page = 0; page < 10; page += 1) {
      const result = await readFeed(repo, cursor ? { limit: 50, cursor } : { limit: 50 });
      for (const item of result.items) seen.push(item.id);
      cursor = result.nextCursor;
      if (!cursor || result.items.length === 0) break;
    }

    assert.equal(seen.length, TOTAL, `应恰好取到 ${TOTAL} 张卡，实际 ${seen.length}`);
    assert.equal(new Set(seen).size, TOTAL, '跨页不得重复（也不能丢）');
    assert.equal(seen.includes(`feed:item:item-quantity:${IDS.I1}:T1`), true, '第一行（seq 1）必须成卡——不允许行级截断');
    assert.equal(seen.includes(`feed:item:item-quantity:${ids[TOTAL - 1]}:T1`), true, '最后一行（seq 150）也必须成卡');
  } finally {
    await repo.close();
  }
});

test('E10-02 单轮 journal 超过 2000 行：整轮跳过并明确 FEED_TURN_TOO_LARGE，绝不造半轮卡', async () => {
  const { repo } = await makeSystem();
  try {
    const db = repo.db;
    addTurn(db, 'T1', 1, 100);
    // 2001 条同轮变更：超过 feedTurnJournalMax(2000)。
    const OVER = 2001;
    for (let i = 0; i < OVER; i += 1) {
      journal(db, `jx${i}`, 'T1', i + 1, 'items', IDS.I1, itemSnap(IDS.I1, 1 + i), itemSnap(IDS.I1, 2 + i), `gx${i}`, `ox${i}`);
    }
    db.run(`UPDATE branches SET revision=1, head_turn_id='T1' WHERE id=?`, [BRANCH]);

    const result = await readFeed(repo);
    assert.deepEqual(result.items, [], '整轮跳过：不能返回半轮故事');
    const issues = result.metadata.issues ?? [];
    assert.ok(
      issues.some((i) => i.code === 'FEED_TURN_TOO_LARGE'),
      `应明确报 FEED_TURN_TOO_LARGE，实际 issues=${JSON.stringify(issues).slice(0, 300)}`,
    );
    const metaKeys = Object.keys(result.metadata);
    for (const key of metaKeys) assert.equal(/hidden/i.test(key), false, `不得出现隐藏计数键「${key}」`);
  } finally {
    await repo.close();
  }
});
