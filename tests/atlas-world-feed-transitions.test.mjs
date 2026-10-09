/**
 * atlas-world-feed-transitions.test.mjs — M5-10 验收（E03 回合净变化 / E07 旅行与后台故事）。
 *
 * 全部走真实 repo.queryView({kind:'world-feed'}) 读最终 DTO。
 *
 * 硬要求（05 §E03/§E07）：
 *  - 同一(回合,行)的乱序 journal 必须还原成「第一次 before → 最后一次 after」；
 *    A→B→A 净变化为零 → 不发卡。
 *  - 事件 effects 同组的子变更不重复拆成技术项。
 *  - 旅程 出发/停留/恢复/改道/到达、行动 完成/失败/取消 都要有可读卡片，
 *    绝不允许出现「journeys updated」这种表名级技术文案。
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
  return { repo, model, seedTurn: IDS.seedTurn };
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

function journal(db, id, turn, seq, table, rowId, before, after, groupId, opId, summary = '') {
  const operation = before === null ? 'insert' : after === null ? 'delete' : 'update';
  db.run(
    `INSERT INTO turn_changes (id, turn_id, sequence, attempt_id, group_id, operation_id, target_table, target_row_id,
       operation, before_json, after_json, basis_json, summary)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
    [
      id, turn, seq, groupId, opId, table, rowId, operation,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      summary,
    ],
  );
}

const itemSnap = (qty, holder, location) => ({
  branch_id: BRANCH, id: IDS.I1, row_rev: 1, name: '剑', quantity: qty,
  holder_character_id: holder, location_id: location, container_item_id: null, status: 'active',
});

const item2Snap = (qty) => ({
  branch_id: BRANCH, id: 'I2', row_rev: 1, name: '干粮', quantity: qty,
  holder_character_id: IDS.C1, location_id: null, container_item_id: null, status: 'active',
});

const journeySnap = (status, extra = {}) => ({
  branch_id: BRANCH, id: 'J1', row_rev: 1,
  action_id: 'A_J', mover_entity_id: IDS.C2,
  origin_location_id: IDS.L1, destination_location_id: extra.destination ?? IDS.L2,
  stop_location_id: extra.stop ?? null, last_reached_location_id: extra.lastReached ?? null,
  arrived_at_s: extra.arrivedAt ?? null, status,
});

const actionSnap = (status, extra = {}) => ({
  branch_id: BRANCH, id: extra.id ?? 'A1', row_rev: 1, actor_entity_id: extra.actor ?? IDS.C3,
  kind: extra.kind ?? 'act', title: extra.title ?? '刺杀国王', intent: '', progress_s: extra.progress ?? 0,
  result_event_id: extra.resultEvent ?? null, target_location_id: null, status,
});

const readFeed = (repo) => repo.queryView({ kind: 'world-feed', branchId: BRANCH, viewMode: 'author' });

/* ─────────────────────────────── E03 ─────────────────────────────── */

test('E03-01 同回合 A→B→A 无卡；乱序 journal 还原为第一 before / 最后 after', async () => {
  const { repo } = await makeSystem();
  try {
    const db = repo.db;
    db.run(`INSERT INTO entity_keys (branch_id, id, kind) VALUES (?, 'I2', 'item')`, [BRANCH]);
    db.run(
      `INSERT INTO items (branch_id, id, row_rev, created_turn_id, updated_turn_id, name, aliases_json, kind, description, quantity, unit, condition_note, owner_entity_id, holder_character_id, container_item_id, location_id, map_id, grid_x, grid_y, coord_precision, uncertainty_radius_cells, properties_json, status, merged_into_id)
       VALUES (?, 'I2', 1, ?, ?, '干粮', '[]', 'resource', '', 1, '件', '', ?, ?, NULL, NULL, NULL, NULL, NULL, 'unknown', NULL, '[]', 'active', NULL)`,
      [BRANCH, IDS.seedTurn, IDS.seedTurn, IDS.C1, IDS.C1],
    );

    addTurn(db, 'T1', 1, 100);
    // 剑：1 → 2 → 3 → 1，净变化为零 → 不该有卡。
    // 注意 turn_changes 有 UNIQUE(回合, 组, 表, 行) 与 UNIQUE(回合, sequence)：
    // 一步一个组、序号全局唯一，不能挤在同一组里。
    journal(db, 'j1', 'T1', 1, 'items', IDS.I1, itemSnap(1, IDS.C1, null), itemSnap(2, IDS.C1, null), 'g-a1', 'op1');
    journal(db, 'j2', 'T1', 2, 'items', IDS.I1, itemSnap(2, IDS.C1, null), itemSnap(3, IDS.C1, null), 'g-a2', 'op2');
    journal(db, 'j3', 'T1', 3, 'items', IDS.I1, itemSnap(3, IDS.C1, null), itemSnap(1, IDS.C1, null), 'g-a3', 'op3');
    // 干粮：故意乱序写入（seq 6 先插），净变化应为 1 → 5。
    journal(db, 'j6', 'T1', 6, 'items', 'I2', item2Snap(1), item2Snap(5), 'g-b3', 'op6');
    journal(db, 'j4', 'T1', 4, 'items', 'I2', item2Snap(1), item2Snap(2), 'g-b1', 'op4');
    journal(db, 'j5', 'T1', 5, 'items', 'I2', item2Snap(2), item2Snap(3), 'g-b2', 'op5');
    db.run(`UPDATE branches SET revision=1, head_turn_id='T1' WHERE id=?`, [BRANCH]);

    const before = fingerprint(db);
    const result = await readFeed(repo);
    assert.equal(fingerprint(db), before, '读事件流不得改动业务行');

    const cards = result.items.filter((i) => i.category === 'item');
    assert.equal(cards.length, 1, 'A→B→A 的那件不该成卡，只有真变化的那件成卡');
    assert.equal(cards[0].target?.id, 'I2');
    assert.ok(cards[0].summary.includes('1 → 5'), `净变化应为第一 before 到最后 after，实际「${cards[0].summary}」`);
  } finally {
    await repo.close();
  }
});

test('E03-02 事件 effects 同组子变更不再被拆成技术项', async () => {
  const { repo } = await makeSystem();
  try {
    const db = repo.db;
    addTurn(db, 'T1', 1, 100);
    const ev = {
      branch_id: BRANCH, id: 'E1', row_rev: 1, created_turn_id: 'T1', updated_turn_id: 'T1',
      title: '城门失火', kind: 'incident', summary: '火从东市烧起来', location_id: IDS.L1,
      subject_entity_id: IDS.C1, participants_json: '[]', occurred_at_s: 100, ended_at_s: null,
      outcome: '', secrecy: 'restricted', status: 'occurred',
    };
    const cols = Object.keys(ev);
    db.run(`INSERT INTO events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => ev[c]));
    journal(db, 'j1', 'T1', 1, 'events', 'E1', null, ev, 'g-hit', 'op-ev');
    // 同一次原子的物品效果：必须被事件卡吸收。
    journal(db, 'j2', 'T1', 2, 'items', IDS.I1, itemSnap(1, IDS.C1, null), itemSnap(1, IDS.C2, null), 'g-hit', 'op-it');
    db.run(`UPDATE branches SET revision=1, head_turn_id='T1' WHERE id=?`, [BRANCH]);

    const result = await readFeed(repo);
    assert.equal(result.items.filter((i) => i.category === 'event').length, 1, '事件应有一张发生卡');
    assert.equal(result.items.filter((i) => i.category === 'item').length, 0, '同组物品效果不该再发一张技术动向');
    assert.equal(JSON.stringify(result).includes('row_rev'), false);
  } finally {
    await repo.close();
  }
});

/* ─────────────────────────────── E07 ─────────────────────────────── */

test('E07-01 旅程 出发→停留→恢复→到达 与 行动完成 都有稳定可读卡片', async () => {
  const { repo } = await makeSystem();
  try {
    const db = repo.db;
    // 旅程挂靠的行程行动：直接建好（不进 journal），否则它自己也会发一张行动卡，干扰计数。
    db.run(
      `INSERT INTO actions (branch_id, id, row_rev, created_turn_id, updated_turn_id, actor_entity_id, parent_action_id, kind, title, intent, target_entity_id, target_location_id, target_event_id, trigger_json, depends_on_json, payload_json, duration_json, progress_s, earliest_start_s, deadline_s, next_check_s, started_at_s, finished_at_s, evaluated_until_s, secrecy, priority, status, reason_code, result_event_id)
       VALUES (?, 'A_J', 1, ?, ?, ?, NULL, 'travel', '前往学校', '', NULL, ?, NULL, NULL, '[]', NULL, NULL, 0, NULL, NULL, NULL, 0, NULL, 0, 'restricted', 'normal', 'active', NULL, NULL)`,
      [BRANCH, IDS.seedTurn, IDS.seedTurn, IDS.C2, IDS.L2],
    );
    db.run(
      `INSERT INTO journeys (branch_id, id, row_rev, created_turn_id, updated_turn_id, action_id, mover_entity_id, origin_location_id, destination_location_id, segments_json, segment_index, segment_distance_done_m, segment_time_done_s, last_reached_location_id, stop_location_id, started_at_s, last_advanced_at_s, estimated_arrival_min_s, estimated_arrival_max_s, arrived_at_s, position_quality, status, stop_reason)
       VALUES (?, 'J1', 1, ?, ?, 'A_J', ?, ?, ?, '[]', 0, NULL, 0, NULL, NULL, 100, 100, NULL, NULL, NULL, 'unlocated', 'moving', NULL)`,
      [BRANCH, IDS.seedTurn, IDS.seedTurn, IDS.C2, IDS.L1, IDS.L2],
    );

    addTurn(db, 'T1', 1, 100);
    // 第一次出现 = 出发。
    journal(db, 'k1', 'T1', 1, 'journeys', 'J1', null, journeySnap('moving'), 'g-j1', 'op-j1');

    addTurn(db, 'T2', 2, 200);
    journal(db, 'k2', 'T2', 1, 'journeys', 'J1', journeySnap('moving'), journeySnap('paused', { stop: IDS.L1, lastReached: IDS.L1 }), 'g-j2', 'op-j2');

    addTurn(db, 'T3', 3, 300);
    journal(db, 'k3', 'T3', 1, 'journeys', 'J1', journeySnap('paused', { stop: IDS.L1, lastReached: IDS.L1 }), journeySnap('moving', { lastReached: IDS.L1 }), 'g-j3', 'op-j3');

    addTurn(db, 'T4', 4, 400);
    journal(db, 'k4', 'T4', 1, 'journeys', 'J1', journeySnap('moving'), journeySnap('arrived', { arrivedAt: 400 }), 'g-j4', 'op-j4');

    addTurn(db, 'T5', 5, 500);
    db.run(
      `INSERT INTO actions (branch_id, id, row_rev, created_turn_id, updated_turn_id, actor_entity_id, parent_action_id, kind, title, intent, target_entity_id, target_location_id, target_event_id, trigger_json, depends_on_json, payload_json, duration_json, progress_s, earliest_start_s, deadline_s, next_check_s, started_at_s, finished_at_s, evaluated_until_s, secrecy, priority, status, reason_code, result_event_id)
       VALUES (?, 'A2', 1, ?, ?, ?, NULL, 'act', '刺杀国王', '', NULL, NULL, NULL, NULL, '[]', NULL, NULL, 0, NULL, NULL, NULL, NULL, 500, 0, 'secret', 'high', 'planned', NULL, NULL)`,
      [BRANCH, IDS.seedTurn, 'T5', IDS.C3],
    );
    journal(db, 'k5', 'T5', 1, 'actions', 'A2', actionSnap('planned', { title: '刺杀国王' }), actionSnap('completed', { title: '刺杀国王' }), 'g-a2', 'op-a2');

    db.run(`UPDATE branches SET revision=5, head_turn_id='T5' WHERE id=?`, [BRANCH]);

    const result = await readFeed(repo);
    const journeys = result.items.filter((i) => i.category === 'journey');
    const actions = result.items.filter((i) => i.category === 'action');

    assert.equal(journeys.length, 4, `出发/停留/恢复/到达 各一张，实际 ${journeys.length}：${journeys.map((j) => j.title).join(' | ')}`);
    assert.equal(actions.length, 1, '只应有 T5 的完成卡（A_J 没进 journal，不该凭空出现）');

    const titles = journeys.map((j) => j.title);
    assert.ok(titles.includes('信使出发前往圣光学校'), `出发卡缺失：${titles.join(' | ')}`);
    assert.ok(titles.includes('信使在圣罗兰城停留'), `停留卡缺失：${titles.join(' | ')}`);
    assert.ok(titles.includes('信使继续前往圣光学校'), `恢复卡缺失：${titles.join(' | ')}`);
    assert.ok(titles.includes('信使到达圣光学校'), `到达卡缺失：${titles.join(' | ')}`);
    assert.ok(actions[0].title.includes('完成'), `行动结果卡应是完成语义，实际「${actions[0].title}」`);

    const blob = JSON.stringify(result);
    for (const tech of ['journeys updated', 'actions updated', 'row_rev', '修改journeys']) {
      assert.equal(blob.includes(tech), false, `响应不得出现技术文案「${tech}」`);
    }
    // 到达卡应落在目的地，而不是出发地。
    const arrived = journeys.find((j) => j.title.includes('到达'));
    assert.equal(arrived.locationId, IDS.L2);
  } finally {
    await repo.close();
  }
});

test('E07-02 人工纠偏回合不伪装成剧情移动', async () => {
  const { repo } = await makeSystem();
  try {
    const db = repo.db;
    addTurn(db, 'T1', 1, 100);
    journal(db, 'k1', 'T1', 1, 'journeys', 'J1', null, journeySnap('moving'), 'g-j1', 'op-j1');
    // 把这一轮改成 manual：作者手工纠偏，不是故事里真的开拔。
    db.run(`UPDATE turns SET kind='manual' WHERE id='T1' AND branch_id=?`, [BRANCH]);
    db.run(`UPDATE branches SET revision=1, head_turn_id='T1' WHERE id=?`, [BRANCH]);

    const result = await readFeed(repo);
    assert.equal(result.items.length, 0, 'manual 回合不得产出任何剧情卡');
  } finally {
    await repo.close();
  }
});
