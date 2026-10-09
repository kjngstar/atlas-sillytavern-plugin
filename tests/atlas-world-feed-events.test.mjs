/**
 * atlas-world-feed-events.test.mjs — M5-09 验收（E01 事件与修改记录分离 / E02 事件生命周期）。
 *
 * 全部走**真实** repo.queryView({kind:'world-feed'}) 读最终 DTO，断言的是返回的卡片，
 * 不是内部函数被调到过。
 *
 * 硬要求（05 §E01/§E02）：
 *  - 真人内容只来自 events 行：标题/摘要里绝不能出现 journal 的技术 summary（row_rev 之类）。
 *  - scheduled 只进计划：还没发生的事件不许出现「发生卡」。
 *  - 进入 occurred 只发一次：之后仅改标题不新发。
 *  - 未知 occurred_at 不填本机墙钟，标成推断。
 *  - 读操作零副作用：业务行指纹与模型调用次数前后一致。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS } from './fixtures/atlas-sql/seed.mjs';
import { createSqlRepository } from '../src/atlas-db-repository.ts';

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

/** 读业务行指纹：条数 + row_rev 和 + id 长度和。读视图不许改动它。 */
function fingerprint(db) {
  const tables = ['events', 'items', 'characters', 'knowledge', 'information', 'journeys', 'actions'];
  return tables
    .map((t) => {
      const r = db.exec(
        `SELECT COUNT(*) || ':' || IFNULL(SUM(row_rev), 0) || ':' || IFNULL(SUM(length(id)), 0) FROM ${t} WHERE branch_id = ?`,
        [BRANCH],
      );
      return `${t}=${String(r[0].values[0][0])}`;
    })
    .join(';');
}

function addTurn(db, id, rev, clockS) {
  db.run(
    `INSERT INTO turns (id, branch_id, parent_turn_id, host_message_uid, host_variant_key, kind, input_hash, story_hash,
       base_revision, committed_revision, clock_before_s, elapsed_json, clock_after_s, rng_seed, ruleset_version,
       decisions_json, receipt_json, attempts_json, status, created_wall_ms, prepared_wall_ms)
     VALUES (?, ?, NULL, NULL, NULL, 'narrative', ?, NULL, ?, ?, ?, '{"min_s":0,"nominal_s":0,"max_s":0,"quality":"explicit","basis_refs":[]}', ?, ?, 'atlas-1', '{}', NULL, '[]', 'committed', ?, NULL)`,
    [id, BRANCH, `hash_${id}`, rev - 1, rev, clockS, clockS, `rng_${id}`, NOW_WALL_MS],
  );
}

/**
 * 写一条 journal。operation 按 before/after 自动取值，满足表上的 CHECK 约束；
 * summary 故意写成「技术摘要」，用来断言它不会漏进读者看到的卡片。
 */
function journal(db, id, turn, seq, table, rowId, before, after, groupId, opId, summary = '') {
  const operation = before === null ? 'insert' : after === null ? 'delete' : 'update';
  db.run(
    `INSERT INTO turn_changes (id, turn_id, sequence, attempt_id, group_id, operation_id, target_table, target_row_id,
       operation, before_json, after_json, basis_json, summary)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
    [
      id,
      turn,
      seq,
      groupId,
      opId,
      table,
      rowId,
      operation,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      summary,
    ],
  );
}

function addEvent(db, id, status, extra = {}) {
  const row = {
    branch_id: BRANCH,
    id,
    row_rev: 1,
    created_turn_id: extra.turn ?? 'T1',
    updated_turn_id: extra.turn ?? 'T1',
    title: extra.title ?? '城门失火',
    kind: extra.kind ?? 'incident',
    summary: extra.summary ?? '火从东市烧起来',
    location_id: extra.location_id ?? IDS.L1,
    route_id: null,
    route_progress_m: null,
    subject_entity_id: extra.subject_entity_id ?? IDS.C1,
    participants_json: '[]',
    cause_action_id: null,
    parent_event_id: null,
    scheduled_start_s: null,
    trigger_json: null,
    occurred_at_s: extra.occurred_at_s ?? null,
    ended_at_s: extra.ended_at_s ?? null,
    outcome: extra.outcome ?? '',
    secrecy: extra.secrecy ?? 'restricted',
    status,
  };
  const cols = Object.keys(row);
  db.run(`INSERT INTO events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
}

/** 事件行快照：journal 里 before/after 的形状。 */
function eventSnap(status, occurredAtS, extra = {}) {
  return {
    branch_id: BRANCH,
    id: 'E1',
    row_rev: 1,
    created_turn_id: 'T1',
    updated_turn_id: 'T2',
    title: extra.title ?? '城门失火',
    kind: 'incident',
    summary: extra.summary ?? '火从东市烧起来',
    location_id: IDS.L1,
    subject_entity_id: IDS.C1,
    participants_json: '[]',
    occurred_at_s: occurredAtS,
    ended_at_s: null,
    outcome: '',
    secrecy: 'restricted',
    status,
  };
}

const readFeed = (repo, extra = {}) =>
  repo.queryView({ kind: 'world-feed', branchId: BRANCH, viewMode: 'author', ...extra });

const eventCards = (result) => result.items.filter((i) => i.category === 'event');

/* ─────────────────────────────── E01 ─────────────────────────────── */

test('E01-01 真人事件卡只取 events 行：不出现 journal 技术摘要', async () => {
  const { repo } = await makeSystem();
  try {
    const db = repo.db;
    addTurn(db, 'T1', 1, 100);
    addEvent(db, 'E1', 'scheduled', { turn: 'T1' });
    journal(db, 'j1', 'T1', 1, 'events', 'E1', null, eventSnap('scheduled', null), 'g-plan', 'op-plan');

    addTurn(db, 'T2', 2, 200);
    db.run(`UPDATE events SET status='occurred', occurred_at_s=200, updated_turn_id='T2', row_rev=2 WHERE branch_id=? AND id='E1'`, [BRANCH]);
    // 同组还改了一件物品的持有者：它属于本次事件的效果，必须被事件卡吸收，不单独发「物品动向」。
    db.run(`UPDATE items SET holder_character_id=? , location_id=NULL, updated_turn_id='T2', row_rev=2 WHERE branch_id=? AND id=?`, [IDS.C2, BRANCH, IDS.I1]);
    journal(db, 'j2', 'T2', 1, 'events', 'E1',
      eventSnap('scheduled', null),
      eventSnap('occurred', 200),
      'g-event', 'op-occurred',
      '修改events「E1」：row_rev 1→2');
    journal(db, 'j3', 'T2', 2, 'items', IDS.I1,
      { branch_id: BRANCH, id: IDS.I1, row_rev: 1, holder_character_id: IDS.C1, location_id: null, quantity: 1, status: 'active' },
      { branch_id: BRANCH, id: IDS.I1, row_rev: 2, holder_character_id: IDS.C2, location_id: null, quantity: 1, status: 'active' },
      'g-event', 'op-item-effect',
      '修改items「剑」：holder_character_id');
    db.run(`UPDATE branches SET revision=2, head_turn_id='T2' WHERE id=?`, [BRANCH]);

    const result = await readFeed(repo);
    const cards = eventCards(result);
    assert.equal(cards.length, 1, '只应有一张事件卡（scheduled 那张不进已发生流）');
    const card = cards[0];
    assert.equal(card.title, '城门失火', '标题来自 events.title');
    assert.equal(card.summary, '火从东市烧起来', '摘要来自 events.summary');
    assert.equal(card.turnId, 'T2', '发生时刻所属回合是 T2');
    assert.equal(card.target?.kind, 'event');
    assert.equal(card.target?.id, 'E1');

    const blob = JSON.stringify(result);
    assert.equal(blob.includes('row_rev'), false, '整份响应不得出现 row_rev 这类技术字段名');
    assert.equal(blob.includes('修改events'), false, '整份响应不得出现 journal 的技术摘要');

    assert.equal(result.items.some((i) => i.category === 'item'), false, '事件同组的物品变更不得再单独发卡');
  } finally {
    await repo.close();
  }
});

test('E01-02 读事件流零副作用：业务指纹与模型调用次数不变', async () => {
  const { repo, model } = await makeSystem();
  try {
    const db = repo.db;
    addTurn(db, 'T1', 1, 100);
    addEvent(db, 'E1', 'occurred', { turn: 'T1', occurred_at_s: 100 });
    journal(db, 'j1', 'T1', 1, 'events', 'E1', null, eventSnap('occurred', 100), 'g1', 'op1');
    db.run(`UPDATE branches SET revision=1, head_turn_id='T1' WHERE id=?`, [BRANCH]);

    const before = fingerprint(db);
    const result = await readFeed(repo);
    const after = fingerprint(db);

    assert.equal(after, before, '读事件流不得改动任何业务行');
    assert.equal(model.calls.length, 0, '读事件流不得调用模型');
    assert.equal(eventCards(result).length, 1, '顺带确认这次读确实产出了卡片（不是空跑）');
  } finally {
    await repo.close();
  }
});

test('E01-03 技术表变更（地图 frame / 分支时钟）不得成为故事卡', async () => {
  const { repo } = await makeSystem();
  try {
    const db = repo.db;
    addTurn(db, 'T1', 1, 100);
    // 典型的「技术更新」：地图框改了、分支时钟推进了。这些是账本，不是剧情。
    journal(db, 'jt1', 'T1', 1, 'maps', IDS.M1,
      { branch_id: BRANCH, id: IDS.M1, row_rev: 1, frame_json: '{"origin_x":0,"origin_y":0}' },
      { branch_id: BRANCH, id: IDS.M1, row_rev: 2, frame_json: '{"origin_x":5,"origin_y":5}' },
      'g-tech', 'op-map',
      '修改maps「世界图」：frame_json');
    journal(db, 'jt2', 'T1', 2, 'branches', BRANCH,
      { branch_id: BRANCH, id: BRANCH, row_rev: 1, clock_s: 0 },
      { branch_id: BRANCH, id: BRANCH, row_rev: 2, clock_s: 600 },
      'g-tech', 'op-clock',
      '修改branches「主线」：clock_s');
    db.run(`UPDATE branches SET revision=1, head_turn_id='T1' WHERE id=?`, [BRANCH]);

    const result = await readFeed(repo);
    assert.deepEqual(result.items, [], '纯技术变更的回合，读者侧应为空');
    const blob = JSON.stringify(result);
    for (const tech of ['frame_json', 'clock_s', 'row_rev', '已提交', '应用']) {
      assert.equal(blob.includes(tech), false, `响应不得出现技术文案「${tech}」`);
    }
  } finally {
    await repo.close();
  }
});

/* ─────────────────────────────── E02 ─────────────────────────────── */
test('E02-01 scheduled 只进计划：还没发生的事件不出现发生卡', async () => {
  const { repo } = await makeSystem();
  try {
    const db = repo.db;
    addTurn(db, 'T1', 1, 100);
    addEvent(db, 'E1', 'scheduled', { turn: 'T1' });
    journal(db, 'j1', 'T1', 1, 'events', 'E1', null, eventSnap('scheduled', null), 'g-plan', 'op-plan');
    db.run(`UPDATE branches SET revision=1, head_turn_id='T1' WHERE id=?`, [BRANCH]);

    const result = await readFeed(repo);
    assert.equal(eventCards(result).length, 0, 'scheduled 不是「已发生」');
    assert.deepEqual(result.items, [], '该回合只有计划中的事件，读者视角应为空');
  } finally {
    await repo.close();
  }
});

test('E02-02 进入 occurred 只发一次：之后仅改标题不再新发', async () => {
  const { repo } = await makeSystem();
  try {
    const db = repo.db;
    addTurn(db, 'T1', 1, 100);
    addEvent(db, 'E1', 'scheduled', { turn: 'T1' });
    journal(db, 'j1', 'T1', 1, 'events', 'E1', null, eventSnap('scheduled', null), 'g-plan', 'op-plan');

    addTurn(db, 'T2', 2, 200);
    journal(db, 'j2', 'T2', 1, 'events', 'E1', eventSnap('scheduled', null), eventSnap('occurred', 200), 'g-ev', 'op-ev');

    // T3：仍是 occurred，只改了标题（发生时刻不变）→ 不得再发一张发生卡。
    addTurn(db, 'T3', 3, 300);
    journal(db, 'j3', 'T3', 1, 'events', 'E1',
      eventSnap('occurred', 200),
      eventSnap('occurred', 200, { title: '城门大火（改名）', summary: '火势蔓延到西市' }),
      'g-edit', 'op-edit');
    db.run(`UPDATE branches SET revision=3, head_turn_id='T3' WHERE id=?`, [BRANCH]);

    const result = await readFeed(repo);
    const cards = eventCards(result);
    assert.equal(cards.length, 1, '改标题不该再发一张');
    assert.equal(cards[0].turnId, 'T2', '发生卡仍来自真正发生的那一轮');
    assert.ok(cards[0].id.includes(':occurred:E1:T2'), `发生卡 id 应含 event/回合，实际 ${cards[0].id}`);
    assert.equal(cards[0].title, '城门失火', 'T3 的标题修改不回改历史卡');
  } finally {
    await repo.close();
  }
});

test('E02-03 未知 occurred_at 不填本机墙钟，标为推断', async () => {
  const { repo } = await makeSystem();
  try {
    const db = repo.db;
    // DDL 有 CHECK：occurred 必然带 occurred_at_s，所以「已发生却无时刻」只可能出现在
    // **旧档/journal 的不完整快照**里。这里就按旧档来造：活动行是好的，历史快照缺字段。
    addTurn(db, 'T1', 1, 777);
    addEvent(db, 'E1', 'occurred', { turn: 'T1', occurred_at_s: 500 });
    journal(db, 'j1', 'T1', 1, 'events', 'E1', null, eventSnap('occurred', null), 'g1', 'op1');
    db.run(`UPDATE branches SET revision=1, head_turn_id='T1' WHERE id=?`, [BRANCH]);

    const result = await readFeed(repo);
    const cards = eventCards(result);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].factQuality, 'inferred', '快照缺 occurred_at_s 时只能是推断');
    assert.equal(cards[0].occurredAtS, 777, '时间退回该回合的故事时刻，而不是本机墙钟');
    assert.notEqual(cards[0].occurredAtS, Math.floor(NOW_WALL_MS / 1000), '绝不能拿创建墙钟充当故事时间');
  } finally {
    await repo.close();
  }
});

test('E02-04 不同组的事件效果仍会正常发卡（抑制是按组、不是一刀切）', async () => {
  const { repo } = await makeSystem();
  try {
    const db = repo.db;
    addTurn(db, 'T1', 1, 100);
    addEvent(db, 'E1', 'occurred', { turn: 'T1', occurred_at_s: 100 });
    journal(db, 'j1', 'T1', 1, 'events', 'E1', null, eventSnap('occurred', 100), 'g-ev', 'op-ev');
    // 另一次单独的行为：与事件不同组，不该被吸收。
    db.run(`UPDATE items SET quantity=3, row_rev=2, updated_turn_id='T1' WHERE branch_id=? AND id=?`, [BRANCH, IDS.I1]);
    journal(db, 'j2', 'T1', 2, 'items', IDS.I1,
      { branch_id: BRANCH, id: IDS.I1, row_rev: 1, quantity: 1, status: 'active', holder_character_id: IDS.C1, location_id: null },
      { branch_id: BRANCH, id: IDS.I1, row_rev: 2, quantity: 3, status: 'active', holder_character_id: IDS.C1, location_id: null },
      'g-stock', 'op-stock');
    db.run(`UPDATE branches SET revision=1, head_turn_id='T1' WHERE id=?`, [BRANCH]);

    const result = await readFeed(repo);
    assert.equal(eventCards(result).length, 1);
    const itemCards = result.items.filter((i) => i.category === 'item');
    assert.equal(itemCards.length, 1, '与事件无关的数量变化应当照常成卡');
    assert.equal(itemCards[0].target?.id, IDS.I1);
  } finally {
    await repo.close();
  }
});
