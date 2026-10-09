/**
 * atlas-world-feed-visibility.test.mjs — M5-11 验收（E04 消息与事件秘密 / E05 过去不能看现在 / E06 同城不全知）。
 *
 * 全部走真实 repo.queryView({kind:'world-feed'}) 读最终 DTO，并且对**整份响应 JSON** 做泄漏扫描——
 * 只在 UI 上「看着是空」不算通过，服务端下发的东西里就不能有秘密。
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

function addEvent(db, id, status, extra = {}) {
  const row = {
    branch_id: BRANCH, id, row_rev: 1,
    created_turn_id: extra.turn ?? 'T1', updated_turn_id: extra.turn ?? 'T1',
    title: extra.title ?? '一场事故', kind: extra.kind ?? 'incident',
    summary: extra.summary ?? '', location_id: extra.location_id ?? null,
    route_id: null, route_progress_m: null,
    subject_entity_id: extra.subject ?? null, participants_json: '[]', cause_action_id: null,
    parent_event_id: null, scheduled_start_s: null, trigger_json: null,
    occurred_at_s: extra.occurred_at_s ?? null, ended_at_s: null, outcome: '',
    secrecy: extra.secrecy ?? 'restricted', status,
  };
  const cols = Object.keys(row);
  db.run(`INSERT INTO events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
}

const eventSnap = (id, status, extra = {}) => ({
  branch_id: BRANCH, id, row_rev: 1, created_turn_id: 'T1', updated_turn_id: 'T1',
  title: extra.title ?? '一场事故', kind: 'incident', summary: extra.summary ?? '',
  location_id: extra.location_id ?? null, subject_entity_id: extra.subject ?? null,
  participants_json: '[]', occurred_at_s: extra.occurred_at_s ?? null, ended_at_s: null,
  outcome: '', secrecy: extra.secrecy ?? 'restricted', status,
});

function addInformation(db, id, extra = {}) {
  const row = {
    branch_id: BRANCH, id, row_rev: 1,
    created_turn_id: extra.turn ?? 'T2', updated_turn_id: extra.turn ?? 'T2',
    kind: extra.kind ?? 'report', title: extra.title ?? '', content: extra.content ?? '',
    source_event_id: extra.source_event_id ?? null, subject_entity_id: null, payload_json: null,
    origin_location_id: extra.origin_location_id ?? null, originator_entity_id: null,
    parent_information_id: null, truth_status: extra.truth_status ?? 'unknown',
    secrecy: extra.secrecy ?? 'restricted', topic_key: '', content_hash: '',
    created_at_s: extra.created_at_s ?? 0, expires_at_s: null, supersedes_information_id: null,
    status: 'active',
  };
  const cols = Object.keys(row);
  db.run(`INSERT INTO information (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
}

const knowledgeSnap = (id, informationId, extra = {}) => ({
  branch_id: BRANCH, id, row_rev: 1,
  created_turn_id: extra.turn ?? 'T2', updated_turn_id: extra.turn ?? 'T2',
  knower_character_id: extra.knower ?? null, knower_faction_id: null,
  is_pov: extra.isPov ?? 0, information_id: informationId,
  source_entity_id: null, source_front_id: null, source_channel_id: null,
  first_received_at_s: extra.receivedAt ?? 200, last_confirmed_at_s: null,
  belief: extra.belief ?? 'heard', attention: 'normal', reaction_note: '', status: extra.status ?? 'active',
});

const charSnap = (locationId, rev) => ({
  branch_id: BRANCH, id: IDS.C1, row_rev: rev, name: '艾琳', location_id: locationId,
  map_id: null, grid_x: null, grid_y: null, coord_precision: 'unknown', status: 'active',
});

const readFeed = (repo, extra = {}) =>
  repo.queryView({ kind: 'world-feed', branchId: BRANCH, povId: IDS.C1, viewMode: 'pov', ...extra });

/* ─────────────────────────────── E04 ─────────────────────────────── */

test('E04-01 秘密事件：POV 只拿到转述内容，秘密摘要/参与人一个字都不下发', async () => {
  const { repo } = await makeSystem();
  try {
    const db = repo.db;
    const SECRET_SUMMARY = '国王密令：处决信使，尸体沉入西河';

    addTurn(db, 'T1', 1, 100);
    // 秘密事件：发生在 L1，主角（当时在 L2）不在场，参与人是刺客 C3。
    addEvent(db, 'E1', 'occurred', {
      turn: 'T1', title: '夜间行动', summary: SECRET_SUMMARY, location_id: IDS.L1,
      subject: IDS.C3, secrecy: 'secret', occurred_at_s: 100,
    });
    journal(db, 'e1', 'T1', 1, 'events', 'E1', null,
      eventSnap('E1', 'occurred', { title: '夜间行动', summary: SECRET_SUMMARY, location_id: IDS.L1, subject: IDS.C3, secrecy: 'secret', occurred_at_s: 100 }),
      'g-ev', 'op-ev');

    // 主角只收到一条转述（report），指向同一事件。
    addTurn(db, 'T2', 2, 200);
    addInformation(db, 'R1', { kind: 'report', title: '夜里的消息', content: '听说今夜有行动', source_event_id: 'E1', truth_status: 'mixed', turn: 'T2' });
    const k = knowledgeSnap('K1', 'R1', { isPov: 1, turn: 'T2', receivedAt: 200 });
    db.run(
      `INSERT INTO knowledge (branch_id, id, row_rev, created_turn_id, updated_turn_id, knower_character_id, knower_faction_id, is_pov, information_id, source_entity_id, source_front_id, source_channel_id, first_received_at_s, last_confirmed_at_s, belief, attention, reaction_note, status)
       VALUES (?, 'K1', 1, 'T2', 'T2', NULL, NULL, 1, 'R1', NULL, NULL, NULL, 200, NULL, 'heard', 'normal', '', 'active')`,
      [BRANCH],
    );
    journal(db, 'k1', 'T2', 1, 'knowledge', 'K1', null, k, 'g-msg', 'op-msg');
    // 信息行本身也要进 journal：历史重建只认 journal 依据，不认「现在表里有什么」。
    journal(db, 'r1', 'T2', 2, 'information', 'R1', null, {
      branch_id: BRANCH, id: 'R1', row_rev: 1, created_turn_id: 'T2', updated_turn_id: 'T2',
      kind: 'report', title: '夜里的消息', content: '听说今夜有行动',
      source_event_id: 'E1', truth_status: 'mixed', secrecy: 'restricted',
      status: 'active', origin_location_id: null, subject_entity_id: null,
    }, 'g-msg', 'op-info');
    db.run(`UPDATE branches SET revision=2, head_turn_id='T2' WHERE id=?`, [BRANCH]);

    const before = fingerprint(db);
    const pov = await readFeed(repo);
    assert.equal(fingerprint(db), before, '读事件流不得改动业务行');

    assert.equal(pov.items.filter((i) => i.category === 'event').length, 0, '只拿到转述：事件卡必须撤掉');
    const messages = pov.items.filter((i) => i.category === 'message');
    assert.equal(messages.length, 1, '转述应以消息卡出现');
    assert.ok(messages[0].summary.includes('听说今夜有行动'), `消息卡应展示 information.content，实际「${messages[0].summary}」`);
    assert.ok(messages[0].summary.includes('mixed'), '消息卡应带上这条消息自己的可信度');
    assert.equal(messages[0].target?.id, 'R1', '消息卡指向 information，而不是事件');

    const blob = JSON.stringify(pov);
    for (const secret of [SECRET_SUMMARY, '国王密令', '沉入西河', IDS.C3, '刺客', IDS.L1, '圣罗兰城']) {
      assert.equal(blob.includes(secret), false, `POV 响应泄漏了「${secret}」`);
    }

    // 作者看得到后台事件，但只是 background。
    const author = await repo.queryView({ kind: 'world-feed', branchId: BRANCH, viewMode: 'author' });
    const authorEvents = author.items.filter((i) => i.category === 'event');
    assert.equal(authorEvents.length, 1, '作者应能看到发生后的事件');
    assert.equal(authorEvents[0].title, '夜间行动');
    assert.equal(authorEvents[0].visibility, 'background', '作者视角的卡片不冒充「主角已知」');
  } finally {
    await repo.close();
  }
});

test('E04-02 秘密事件即使同场也不靠「在场」放行（需要直接观察证据）', async () => {
  const { repo } = await makeSystem();
  try {
    const db = repo.db;
    addTurn(db, 'T1', 1, 100);
    // 主角就在 L2（seed 默认），事件也在 L2，但它是 secret 且没有任何一手观察记录。
    addEvent(db, 'E1', 'occurred', {
      turn: 'T1', title: '密室里的交易', summary: '国王把王冠交给了刺客',
      location_id: IDS.L2, subject: IDS.C3, secrecy: 'secret', occurred_at_s: 100,
    });
    journal(db, 'e1', 'T1', 1, 'events', 'E1', null,
      eventSnap('E1', 'occurred', { title: '密室里的交易', summary: '国王把王冠交给了刺客', location_id: IDS.L2, subject: IDS.C3, secrecy: 'secret', occurred_at_s: 100 }),
      'g-ev', 'op-ev');
    db.run(`UPDATE branches SET revision=1, head_turn_id='T1' WHERE id=?`, [BRANCH]);

    const pov = await readFeed(repo);
    assert.equal(pov.items.filter((i) => i.category === 'event').length, 0, '秘密事件不能只凭「同场」就下发');
    assert.equal(JSON.stringify(pov).includes('王冠'), false, '秘密摘要不得泄漏');

    const author = await repo.queryView({ kind: 'world-feed', branchId: BRANCH, viewMode: 'author' });
    assert.equal(author.items.filter((i) => i.category === 'event').length, 1, '作者仍应看得到');
  } finally {
    await repo.close();
  }
});

/* ─────────────────────────────── E05 ─────────────────────────────── */

test('E05-01 过去的目击不能看现在：位置按当时快照判定，不看当前位置', async () => {
  const { repo } = await makeSystem();
  try {
    const db = repo.db;
    // T1：主角从 L2 走到 L1；此刻 L1 的事件他确实在场。
    addTurn(db, 'T1', 1, 100);
    journal(db, 'c1', 'T1', 1, 'characters', IDS.C1, charSnap(IDS.L2, 1), charSnap(IDS.L1, 2), 'g-move1', 'op-move1');
    addEvent(db, 'E_A', 'occurred', { turn: 'T1', title: '广场集会', summary: '人群在广场聚集', location_id: IDS.L1, occurred_at_s: 100, secrecy: 'public' });
    journal(db, 'a1', 'T1', 2, 'events', 'E_A', null,
      eventSnap('E_A', 'occurred', { title: '广场集会', summary: '人群在广场聚集', location_id: IDS.L1, occurred_at_s: 100, secrecy: 'public' }),
      'g-ev-a', 'op-ev-a');

    // T2：主角已不在 L2 —— 此时 L2 发生的事，他既没在场也不知情报。
    addTurn(db, 'T2', 2, 200);
    addEvent(db, 'E_B', 'occurred', { turn: 'T2', title: '学校失火', summary: '教室被烧毁', location_id: IDS.L2, occurred_at_s: 200, secrecy: 'public' });
    journal(db, 'b1', 'T2', 1, 'events', 'E_B', null,
      eventSnap('E_B', 'occurred', { title: '学校失火', summary: '教室被烧毁', location_id: IDS.L2, occurred_at_s: 200, secrecy: 'public' }),
      'g-ev-b', 'op-ev-b');

    // T3：主角现在到了 L2。当前位置与 E_B 相同 —— 这正是要防的陷阱。
    addTurn(db, 'T3', 3, 300);
    journal(db, 'c3', 'T3', 1, 'characters', IDS.C1, charSnap(IDS.L1, 2), charSnap(IDS.L2, 3), 'g-move3', 'op-move3');
    db.run(`UPDATE characters SET location_id=?, row_rev=3 WHERE branch_id=? AND id=?`, [IDS.L2, BRANCH, IDS.C1]);
    db.run(`UPDATE branches SET revision=3, head_turn_id='T3' WHERE id=?`, [BRANCH]);

    const pov = await readFeed(repo);
    const events = pov.items.filter((i) => i.category === 'event');
    const titles = events.map((e) => e.title);

    assert.equal(events.length, 1, `只应看到当时确实在场的那一件，实际：${titles.join(' | ')}`);
    assert.equal(titles[0], '广场集会', '当时在场的才可见');
    const blob = JSON.stringify(pov);
    assert.equal(blob.includes('学校失火'), false, '主角当时不在 L2，旧事件不能因为现在在 L2 就冒出来');
    assert.equal(blob.includes('E_B'), false, '更不该泄漏事件 ID');

    // 作者视角两件都在，证明被挡掉的是可见性判定而不是数据本身。
    const author = await repo.queryView({ kind: 'world-feed', branchId: BRANCH, viewMode: 'author' });
    assert.equal(author.items.filter((i) => i.category === 'event').length, 2);
  } finally {
    await repo.close();
  }
});

/* ─────────────────────────────── E06 ─────────────────────────────── */

test('E06-01 同一城市不全员知情：地点发现不等于事件已知，也不下发隐藏数量', async () => {
  const { repo } = await makeSystem();
  try {
    const db = repo.db;
    // T1/T2：主角先去 L3（教室），再回到 L2（学校）。因此 L3 属于「已知地点」。
    addTurn(db, 'T1', 1, 100);
    journal(db, 'c1', 'T1', 1, 'characters', IDS.C1, charSnap(IDS.L2, 1), charSnap(IDS.L3, 2), 'g-m1', 'op-m1');
    addTurn(db, 'T2', 2, 200);
    journal(db, 'c2', 'T2', 1, 'characters', IDS.C1, charSnap(IDS.L3, 2), charSnap(IDS.L2, 3), 'g-m2', 'op-m2');

    // T3：L3 发生一件 public 事件。主角当时在 L2（同城 L1 的另一栋楼），没有任何转述或目击。
    addTurn(db, 'T3', 3, 300);
    addEvent(db, 'E9', 'occurred', { turn: 'T3', title: '教室失窃', summary: '讲台下的箱子不见了', location_id: IDS.L3, occurred_at_s: 300, secrecy: 'public' });
    journal(db, 'e9', 'T3', 1, 'events', 'E9', null,
      eventSnap('E9', 'occurred', { title: '教室失窃', summary: '讲台下的箱子不见了', location_id: IDS.L3, occurred_at_s: 300, secrecy: 'public' }),
      'g-ev9', 'op-ev9');
    db.run(`UPDATE characters SET location_id=?, row_rev=3 WHERE branch_id=? AND id=?`, [IDS.L2, BRANCH, IDS.C1]);
    db.run(`UPDATE branches SET revision=3, head_turn_id='T3' WHERE id=?`, [BRANCH]);

    const pov = await readFeed(repo);
    assert.equal(pov.items.filter((i) => i.category === 'event').length, 0, '同城不同楼 + public 不等于知情');
    const blob = JSON.stringify(pov);
    assert.equal(blob.includes('教室失窃'), false, '不该泄漏事件标题');
    assert.equal(blob.includes('讲台下的箱子'), false, '不该泄漏事件摘要');
    assert.equal(blob.includes('E9'), false, '不该泄漏事件 ID');

    // 不下发隐藏数量：metadata 里不能有 hidden 计数，count 必须等于真实条数。
    const metaKeys = Object.keys(pov.metadata);
    for (const key of metaKeys) {
      assert.equal(/hidden/i.test(key), false, `metadata 不得出现隐藏计数键「${key}」`);
    }
    assert.equal(pov.metadata.count, pov.items.length, 'count 只能是实际下发条数');
    assert.equal(pov.metadata.latestNarrativeTurnId, 'T3', '最新叙事回合仍然照常给出（它本身不是秘密）');

    const author = await repo.queryView({ kind: 'world-feed', branchId: BRANCH, viewMode: 'author' });
    assert.equal(author.items.filter((i) => i.category === 'event').length, 1, '作者应看得到这件后台事件');
  } finally {
    await repo.close();
  }
});

test('E06-02 作者读取事件流不修改 knowledge（读就是读）', async () => {
  const { repo, model } = await makeSystem();
  try {
    const db = repo.db;
    addTurn(db, 'T1', 1, 100);
    addEvent(db, 'E1', 'occurred', { turn: 'T1', title: '广场集会', location_id: IDS.L1, occurred_at_s: 100, secrecy: 'public' });
    journal(db, 'e1', 'T1', 1, 'events', 'E1', null,
      eventSnap('E1', 'occurred', { title: '广场集会', location_id: IDS.L1, occurred_at_s: 100, secrecy: 'public' }),
      'g-ev', 'op-ev');
    db.run(`UPDATE branches SET revision=1, head_turn_id='T1' WHERE id=?`, [BRANCH]);

    const before = fingerprint(db);
    await repo.queryView({ kind: 'world-feed', branchId: BRANCH, viewMode: 'author' });
    assert.equal(fingerprint(db), before, '作者读取不得写入或改写任何业务行');
    assert.equal(model.calls.length, 0, '读取不得调用模型');
  } finally {
    await repo.close();
  }
});
