/**
 * atlas-ops-entities.test.mjs — T06（§18.3 / §18.2 / §6.5）。
 *
 * 覆盖：
 * - 粗位置：只给 `location_ref` 时精坐标保持 NULL（不写 0 冒充已知）；
 * - 物品转移与未知数量：散装数量为 NULL 而不是虚构很多件；明确单件可以是 1；数量 0 转 consumed；
 * - 持有与所有权分开：偷来的剑换了持有人，原主人不变；
 * - 首楼重要角色可以建档；`registration=watch` 只进候选且**不建人物实体**；
 * - 第二次不同楼层提及只触发评估（review），不强迫晋升；
 * - 聊天标题（只有名字、无身份线索）不自动建人；
 * - 载具父关系：mobile 载具的子地点挂在载具下，停靠写 anchor 而不是永久挂到城市；
 * - E15 `updateMentionCandidates`：同楼重试不重复计数、recent 至多 8 条、summary 至多 200 字、
 *   同名不同 context_key 是两条候选、256 上限回收写 dismissed 且 core 永不自动淘汰。
 *
 * 全程走真实编译路径：`extractPayload` → `parseOperations` → `compileOperations`
 * → `createTableReadPort` + `makeCompileContext` → `applyGroups`（真实事务与不变量校验）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeSeedWith,
  IDS,
  countRows,
  foreignKeyCheck,
  inTransaction,
  selectOne,
} from './fixtures/atlas-sql/seed.mjs';
import { SOURCE_SNAPSHOT } from './fixtures/atlas-sql/model-cases.mjs';
import { makeAnchor, makeCompileContext } from './helpers/atlas-compile-context.mjs';
import { extractPayload, parseOperations } from '../src/atlas-ops-parser.ts';
import { compileOperations } from '../src/atlas-ops-compile.ts';
import { applyGroups } from '../src/atlas-db-commit.ts';
import { createTableReadPort } from '../src/atlas-db-readport.ts';
import {
  MENTION_CANDIDATE_LIMIT,
  MENTION_RECENT_TURNS_LIMIT,
  promoteMention,
  updateMentionCandidates,
} from '../src/atlas-db-mentions.ts';

const SQL = await (await import('sql.js')).default();
const WALL_OLD = 1_700_000_000_000;

/** 真实编译路径：模型原始文本 → 解析 → 编译（不执行 SQL）。 */
function compile(seed, responseText, { phase = 'observe', sources = null, anchor = makeAnchor(), refs = null } = {}) {
  const extracted = extractPayload(responseText);
  const parsed = parseOperations(extracted.payload, { phase });
  const context = makeCompileContext({ seed, phase, anchor, sources });
  const knownRefs = refs ? [...seed.refs, ...refs] : seed.refs;
  const compiled = compileOperations({
    operations: parsed.operations,
    anchor,
    phase,
    clockS: 0,
    revision: 0,
    tables: context.tables ?? createTableReadPort(seed.db),
    sources: sources ?? { phase, snapshot: [], clockS: 0 },
    knownRefs,
  });
  return { extracted, parsed, compiled };
}

/** 把一次编译结果作为一个原子组真实应用（默认开启不变量校验与变更日志）。 */
function applyCompiled(seed, compiled, { turnId = IDS.seedTurn, attemptId = 'attempt_1', validate = true } = {}) {
  const db = seed.db;
  db.run('BEGIN');
  try {
    const group = {
      id: 'g_t06',
      opIds: compiled.results.map((r) => r.opId),
      dependsOn: [],
      readSet: compiled.merged.readSet,
      mutations: compiled.merged.mutations,
      opIssues: compiled.issues.filter((i) => i.severity === 'error'),
    };
    const result = applyGroups(db, [group], { branchId: IDS.branchMain, turnId, attemptId, validate });
    db.run('COMMIT');
    return result;
  } catch (err) {
    try {
      db.run('ROLLBACK');
    } catch {
      /* 保留原始错误 */
    }
    throw err;
  }
}

function issuesOfCode(compiled, code) {
  return compiled.issues.filter((i) => i.code === code);
}

function characterByName(db, name) {
  const rows = db.exec('SELECT * FROM characters WHERE branch_id = ? AND name = ?', [IDS.branchMain, name]);
  if (!rows.length) return null;
  const out = {};
  rows[0].columns.forEach((column, index) => {
    out[column] = rows[0].values[0][index];
  });
  return out;
}

function locationByName(db, name) {
  const rows = db.exec('SELECT * FROM locations WHERE branch_id = ? AND name = ?', [IDS.branchMain, name]);
  if (!rows.length) return null;
  const out = {};
  rows[0].columns.forEach((column, index) => {
    out[column] = rows[0].values[0][index];
  });
  return out;
}

function itemByName(db, name) {
  const rows = db.exec('SELECT * FROM items WHERE branch_id = ? AND name = ? ORDER BY id', [IDS.branchMain, name]);
  return rows.length
    ? rows[0].values.map((value, index) => {
        const out = {};
        rows[0].columns.forEach((column, i) => {
          out[column] = value[i];
        });
        return out;
      })
    : [];
}

function mentionById(db, id) {
  return selectOne(db, 'mention_candidates', IDS.branchMain, id);
}

/** 追加一个真实 turn 行（提及计数按楼层，必须真的有这一楼）。 */
function addTurn(db, turnId, parentTurnId = IDS.seedTurn, wallMs = WALL_OLD + 1000) {
  inTransaction(db, () => {
    db.run(
      `INSERT INTO turns (id, branch_id, parent_turn_id, host_message_uid, host_variant_key, kind, input_hash, story_hash,
                          base_revision, committed_revision, clock_before_s, elapsed_json, clock_after_s, rng_seed,
                          ruleset_version, decisions_json, receipt_json, attempts_json, status, created_wall_ms, prepared_wall_ms)
       VALUES (?, ?, ?, NULL, NULL, 'narrative', ?, NULL, 0, 0, 0, ?, 0, ?, 'atlas-1', '{}', NULL, '[]', 'committed', ?, ?)`,
      [
        turnId,
        IDS.branchMain,
        parentTurnId,
        `hash_${turnId}`,
        JSON.stringify({ min_s: 0, nominal_s: 0, max_s: 0, quality: 'explicit', basis_refs: [] }),
        `rng_${turnId}`,
        wallMs,
        wallMs,
      ],
    );
  });
}

/** 应用一批提及变更（真实事务），返回结果。 */
function applyMentions(seed, result, turnId) {
  const db = seed.db;
  db.run('BEGIN');
  try {
    const group = {
      id: 'g_mentions',
      opIds: result.mutations.flatMap((m) => m.sourceOpIds),
      dependsOn: [],
      readSet: [],
      mutations: result.mutations,
    };
    const applied = applyGroups(db, [group], { branchId: IDS.branchMain, turnId, attemptId: 'attempt_m' });
    db.run('COMMIT');
    return applied;
  } catch (err) {
    try {
      db.run('ROLLBACK');
    } catch {
      /* 保留原始错误 */
    }
    throw err;
  }
}

/* ───────────────────────────── T06 ───────────────────────────── */

test('T06-01 粗位置：只给 location_ref 的人物不写精坐标（NULL 而不是 0）', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const response = [
      '{"op":"character.upsert","ref":"new:newteacher","data":{"name":"新来的教师","identity":"学校教师","location_ref":"new:annex"}}',
      '{"op":"location.upsert","ref":"new:annex","data":{"name":"附属教室","kind":"building"}}',
    ].join('\n');
    const { compiled } = compile(seed, response);
    assert.deepEqual(compiled.issues.filter((i) => i.severity === 'error'), []);
    const applied = applyCompiled(seed, compiled);
    assert.equal(applied.groups[0].status, 'applied');

    const annex = locationByName(seed.db, '附属教室');
    assert.ok(annex, '新地点必须建立');
    assert.equal(annex.map_id, null, '粗位置地图为 NULL');
    assert.equal(annex.grid_x, null);
    assert.equal(annex.grid_y, null);
    assert.equal(annex.coord_precision, 'unknown');

    const teacher = characterByName(seed.db, '新来的教师');
    assert.ok(teacher, '有人物身份线索的角色首楼建档');
    assert.equal(teacher.location_id, annex.id, '粗位置指向新地点');
    assert.equal(teacher.map_id, null, '没有 map_ref 时不写地图');
    assert.equal(teacher.grid_x, null, '未知坐标必须是 NULL，不能补 0');
    assert.equal(teacher.grid_y, null);
    assert.equal(teacher.coord_precision, 'unknown');
    assert.deepEqual(foreignKeyCheck(seed.db), []);
  } finally {
    seed.close();
  }
});

test('T06-02 物品数量：未知为 NULL、明确单件为 1、数量 0 转 consumed', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    // 未知数量：不虚构「很多件」。
    const created = compile(seed, '{"op":"item.upsert","ref":"new:rope","data":{"name":"绳子","kind":"resource"}}');
    applyCompiled(seed, created.compiled);
    let rope = itemByName(seed.db, '绳子');
    assert.equal(rope.length, 1);
    assert.equal(rope[0].quantity, null, '散装未知数量必须是 NULL');
    assert.equal(rope[0].unit, '件');
    assert.equal(rope[0].status, 'active');

    // 明确单件可以是 1。
    const single = compile(seed, '{"op":"item.upsert","ref":"new:lamp","data":{"name":"提灯","kind":"equipment","quantity":1}}');
    applyCompiled(seed, single.compiled);
    const lamp = itemByName(seed.db, '提灯');
    assert.equal(lamp[0].quantity, 1, '明确单件可以是 1');
    assert.equal(lamp[0].status, 'active');

    // 数量 0 转 consumed。
    const zero = compile(seed, '{"op":"item.upsert","ref":"I1","data":{"quantity":0}}');
    applyCompiled(seed, zero.compiled);
    const sword = selectOne(seed.db, 'items', IDS.branchMain, IDS.I1);
    assert.equal(sword.quantity, 0);
    assert.equal(sword.status, 'consumed', '数量 0 必须转 consumed');
    assert.deepEqual(foreignKeyCheck(seed.db), []);
  } finally {
    seed.close();
  }
});

test('T06-03 物品转移：未知数量不猜件数，数量全转后转 consumed', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    // 不带 quantity 的转移：数量保持原值（1），不因为「转移」而虚构数量。
    const move = compile(seed, '{"op":"item.transfer","ref":"I1","data":{"to":{"holder_ref":"C2"}}}');
    assert.deepEqual(move.compiled.issues.filter((i) => i.severity === 'error'), []);
    applyCompiled(seed, move.compiled);
    let sword = selectOne(seed.db, 'items', IDS.branchMain, IDS.I1);
    assert.equal(sword.holder_character_id, IDS.C2, '持有人变成信使');
    assert.equal(sword.quantity, 1, '未给数量时保持 1');
    assert.equal(sword.container_item_id, null);
    assert.equal(sword.location_id, null, '持有与放置互斥');
    assert.equal(sword.status, 'active');

    // 全部转走后数量 0 → consumed（不是丢掉行）。
    const moveAll = compile(seed, '{"op":"item.transfer","ref":"I1","data":{"to":{"holder_ref":"C3"},"quantity":1}}');
    applyCompiled(seed, moveAll.compiled);
    sword = selectOne(seed.db, 'items', IDS.branchMain, IDS.I1);
    assert.equal(sword.quantity, 0);
    assert.equal(sword.status, 'consumed');
    assert.equal(sword.holder_character_id, IDS.C3);
    assert.deepEqual(foreignKeyCheck(seed.db), []);
  } finally {
    seed.close();
  }
});

test('T06-04 物品拆分：明确单件可为 1，剩余留在原行', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const make = compile(seed, '{"op":"item.upsert","ref":"new:coins","data":{"name":"金币","kind":"resource","quantity":3,"unit":"枚"}}');
    applyCompiled(seed, make.compiled);
    const before = itemByName(seed.db, '金币');
    assert.equal(before.length, 1);
    assert.equal(before[0].quantity, 3);

    const split = compile(seed, '{"op":"item.transfer","ref":"COINS","data":{"to":{"holder_ref":"C2"},"quantity":1}}', {
      refs: [{ alias: 'COINS', id: before[0].id, kind: 'item' }],
    });
    assert.deepEqual(split.compiled.issues.filter((i) => i.severity === 'error'), []);
    applyCompiled(seed, split.compiled);
    const after = itemByName(seed.db, '金币');
    assert.equal(after.length, 2, '按数量拆分：原行 + 转移出去的一件');
    const remaining = after.find((row) => row.id === before[0].id);
    const moved = after.find((row) => row.id !== before[0].id);
    assert.equal(remaining.quantity, 2, '剩余数量 2');
    assert.equal(moved.quantity, 1, '明确单件就是 1，不虚构');
    assert.equal(moved.holder_character_id, IDS.C2);
    assert.equal(moved.unit, '枚', '单位随拆分保留');
    assert.deepEqual(foreignKeyCheck(seed.db), []);
  } finally {
    seed.close();
  }
});

test('T06-05 持有与所有权分开：偷来的剑仍有原主人', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const steal = compile(seed, '{"op":"item.transfer","ref":"I1","data":{"to":{"holder_ref":"C3"}}}');
    applyCompiled(seed, steal.compiled);
    const sword = selectOne(seed.db, 'items', IDS.branchMain, IDS.I1);
    assert.equal(sword.holder_character_id, IDS.C3, '持有人变成刺客');
    assert.equal(sword.owner_entity_id, IDS.C1, '所有权不变：剑仍属于艾琳');

    // 明确改所有权才改（丢弃/赠予是显式语义）。
    const gift = compile(seed, '{"op":"item.transfer","ref":"I1","data":{"to":{"holder_ref":"C2"},"owner_ref":"C4"}}');
    applyCompiled(seed, gift.compiled);
    const gifted = selectOne(seed.db, 'items', IDS.branchMain, IDS.I1);
    assert.equal(gifted.holder_character_id, IDS.C2);
    assert.equal(gifted.owner_entity_id, IDS.C4);
    assert.deepEqual(foreignKeyCheck(seed.db), []);
  } finally {
    seed.close();
  }
});

test('T06-06 首楼重要角色可建档；世界书资料不把她放到主角位置', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const { compiled } = compile(
      seed,
      '{"op":"character.upsert","ref":"new:captain","data":{"name":"伊娜","identity":"世界书明确描述的王宫卫队长","importance":"core"},"source":"W1"}',
      { sources: { phase: 'observe', snapshot: SOURCE_SNAPSHOT, clockS: 0 } },
    );
    assert.deepEqual(compiled.issues.filter((i) => i.severity === 'error'), []);
    applyCompiled(seed, compiled);
    const captain = characterByName(seed.db, '伊娜');
    assert.ok(captain, '首楼重要角色可以立即建档');
    assert.equal(captain.importance, 'core');
    assert.equal(captain.location_id, null, '世界书静态资料不把她放在当前主角位置');
    assert.equal(captain.map_id, null);
    assert.equal(captain.grid_x, null);
    assert.equal(captain.grid_y, null);
    assert.equal(countRows(seed.db, 'characters', IDS.branchMain), 5, '只有一个人物新增');
    assert.deepEqual(foreignKeyCheck(seed.db), []);
  } finally {
    seed.close();
  }
});

test('T06-07 registration=watch 只进候选且不建人物实体', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const { compiled } = compile(
      seed,
      '{"op":"character.upsert","ref":"new:passerby","data":{"registration":"watch","name":"路人甲","identity":"市场里的摊主"}}',
    );
    const watched = issuesOfCode(compiled, 'MENTION_TRACKED');
    assert.equal(watched.length, 1, 'watch 必须留下 MENTION_TRACKED 警告');
    assert.equal(characterByName(seed.db, '路人甲'), null, 'watch 不建人物实体');
    assert.equal(compiled.merged.mutations.filter((m) => m.table === 'characters').length, 0);
    const mentionMutations = compiled.merged.mutations.filter((m) => m.table === 'mention_candidates');
    assert.equal(mentionMutations.length, 1, 'watch 只写提及候选');
    assert.equal(mentionMutations[0].after.status, 'watching');
    assert.equal(mentionMutations[0].after.promoted_entity_id, null);
    assert.equal(mentionMutations[0].before, null);

    const applied = applyCompiled(seed, compiled);
    assert.equal(applied.groups[0].status, 'applied');
    assert.equal(countRows(seed.db, 'characters', IDS.branchMain), 4, '人物数量不变');
    assert.equal(countRows(seed.db, 'mention_candidates', IDS.branchMain), 1);
    assert.deepEqual(foreignKeyCheck(seed.db), []);

    // E15 是候选生命周期的唯一权威：compile 产出的候选直接交给 updateMentionCandidates 续写。
    const response = updateMentionCandidates({
      db: seed.db,
      branchId: IDS.branchMain,
      turnId: IDS.seedTurn,
      clockS: 0,
      nowWallMs: WALL_OLD,
      rulesetVersion: 'atlas-1',
      observations: [{ name: '路人甲', kindHint: 'character', identity: '市场里的摊主' }],
      makeId: (kind, opId, alias) => `${kind}_${opId}_${alias}`.replace(/[^A-Za-z0-9_]/g, '_'),
    });
    assert.equal(response.created + response.updated, 1, '已有候选被续写而不是重复建档');
    assert.equal(response.mutations[0].before === null, false, '命中已有候选时 before 必须是读到的原行');
    assert.equal(response.mutations[0].after.status, 'watching');
  } finally {
    seed.close();
  }
});

test('T06-08 聊天标题不自动建人：只有名字的名字最多成为候选', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const before = selectOne(seed.db, 'characters', IDS.branchMain, IDS.C1);
    const chatTitle = '与艾琳的夏日冒险';
    const sources = { phase: 'observe', snapshot: [{ key: 'chat', text: chatTitle, hash: 'hash_chat', kind: 'user' }], clockS: 0 };

    // auto + 只有名字：最小合同就拒绝（不是静默建一个人物实体，也不是静默吞掉）。
    const auto = compile(seed, `{"op":"character.upsert","ref":"new:title","data":{"name":"${chatTitle}"}}`, { sources });
    const minimum = auto.compiled.issues.filter((i) => i.code === 'MINIMUM_FIELD_MISSING');
    assert.equal(minimum.length, 1, '只有名字的 auto 建档必须报最小字段缺失');
    assert.equal(minimum[0].path, '$.data.identity');
    assert.equal(characterByName(seed.db, chatTitle), null);
    const applied = applyCompiled(seed, auto.compiled);
    assert.equal(applied.groups[0].status, 'rejected', '不合格操作不写库');
    assert.equal(countRows(seed.db, 'characters', IDS.branchMain), 4);
    assert.equal(countRows(seed.db, 'mention_candidates', IDS.branchMain), 0);

    // 显式 watch：允许，但只进候选，仍然不建人物实体。
    const watch = compile(
      seed,
      `{"op":"character.upsert","ref":"new:titlewatch","data":{"registration":"watch","name":"${chatTitle}"}}`,
      { sources },
    );
    assert.equal(issuesOfCode(watch.compiled, 'MENTION_TRACKED').length, 1);
    assert.equal(watch.compiled.merged.mutations.filter((m) => m.table === 'characters').length, 0);
    applyCompiled(seed, watch.compiled);
    assert.equal(characterByName(seed.db, chatTitle), null, '聊天标题不建人物实体');
    const mention = seed.db.exec('SELECT name, normalized_name, status, promoted_entity_id FROM mention_candidates WHERE branch_id = ?', [
      IDS.branchMain,
    ]);
    assert.equal(mention[0].values.length, 1);
    assert.equal(mention[0].values[0][1], chatTitle.toLowerCase(), '只有 normalized_name 作为搜索辅助');
    assert.equal(mention[0].values[0][2], 'watching');
    assert.equal(mention[0].values[0][3], null);

    const after = selectOne(seed.db, 'characters', IDS.branchMain, IDS.C1);
    assert.deepEqual(after, before, '既有角色不被聊天标题影响');
    assert.equal(countRows(seed.db, 'characters', IDS.branchMain), 4);
    assert.deepEqual(foreignKeyCheck(seed.db), []);
  } finally {
    seed.close();
  }
});

test('T06-09 载具父关系：内部子地点挂载具，停靠写 anchor 而不是永久挂到城市', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const created = compile(
      seed,
      [
        '{"op":"location.upsert","ref":"new:cart","data":{"name":"马车","kind":"vehicle","mobility":"mobile","description":"两匹马拉的货车"}}',
        '{"op":"location.upsert","ref":"new:cabin","data":{"name":"车厢","kind":"room","parent_ref":"new:cart"}}',
      ].join('\n'),
    );
    assert.deepEqual(created.compiled.issues.filter((i) => i.severity === 'error'), []);
    applyCompiled(seed, created.compiled);
    let cart = locationByName(seed.db, '马车');
    const cabin = locationByName(seed.db, '车厢');
    assert.ok(cart, '载具是地点，可以独立建立');
    assert.equal(cart.mobility, 'mobile');
    assert.equal(cart.kind, 'vehicle');
    assert.equal(cart.parent_location_id, null, '载具不是城市的建筑子地点');
    assert.equal(cabin.parent_location_id, cart.id, '子地点的父是载具本身');
    assert.notEqual(cabin.parent_location_id, IDS.L1, '不能挂到城市');

    // 停靠：程序提供短引用（模型不猜 ID），只写 anchor_ref，不改 parent。
    const dock = compile(seed, '{"op":"location.upsert","ref":"CARRIAGE","data":{"anchor_ref":"L1"}}', {
      refs: [{ alias: 'CARRIAGE', id: cart.id, kind: 'location' }],
    });
    assert.deepEqual(dock.compiled.issues.filter((i) => i.severity === 'error'), []);
    applyCompiled(seed, dock.compiled);
    cart = locationByName(seed.db, '马车');
    assert.equal(cart.anchor_location_id, IDS.L1, '停靠城市写 anchor');
    assert.equal(cart.parent_location_id, null, 'parent 仍然是 NULL');
    assert.equal(cart.mobility, 'mobile');
    assert.equal(locationByName(seed.db, '车厢').parent_location_id, cart.id, '子地点仍然挂在载具下');
    assert.deepEqual(foreignKeyCheck(seed.db), []);
  } finally {
    seed.close();
  }
});

test('T06-10 E15：同一楼重试不算第二次出现；第二次不同楼层只触发评估', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    addTurn(seed.db, 'turn_A2', IDS.seedTurn, WALL_OLD + 1000);
    const makeId = (kind, opId, alias) => `${kind}_${opId}_${alias}`.replace(/[^A-Za-z0-9_]/g, '_');
    const observe = (turnId, extra = {}) =>
      updateMentionCandidates({
        db: seed.db,
        branchId: IDS.branchMain,
        turnId,
        clockS: 0,
        nowWallMs: WALL_OLD,
        rulesetVersion: 'atlas-1',
        observations: [{ name: '神秘旅人', kindHint: 'character', identity: '酒馆里打听消息的陌生人', ...extra }],
        makeId,
      });

    // 第一楼：首楼没有重要依据 → none，还没有建档。
    const first = observe(IDS.seedTurn);
    assert.equal(first.created, 1);
    assert.equal(first.updated, 0);
    assert.equal(first.mutations[0].before, null);
    assert.equal(first.mutations[0].after.distinct_turn_count, 1);
    assert.equal(first.mutations[0].after.importance_hint, 'none');
    assert.deepEqual(first.mutations[0].after.recent_turn_ids_json, [IDS.seedTurn]);
    applyMentions(seed, first, IDS.seedTurn);
    const id = first.mutations[0].rowId;

    // 重试同一楼：recent 已含本 turn → 不重复计数。
    const retry = observe(IDS.seedTurn, { alreadyCountedThisTurn: true });
    assert.equal(retry.created, 0);
    assert.equal(retry.updated, 1);
    assert.equal(retry.mutations[0].after.distinct_turn_count, 1, '重试同一楼不算第二次');
    assert.deepEqual(retry.mutations[0].after.recent_turn_ids_json, [IDS.seedTurn]);
    assert.equal(retry.mutations[0].before.distinct_turn_count, 1, 'before 是读到的原行');
    applyMentions(seed, retry, IDS.seedTurn);

    // 第二次不同楼层：触发评估（review），但不强迫晋升、不建人物实体。
    const second = observe('turn_A2');
    assert.equal(second.updated, 1);
    assert.equal(second.mutations[0].rowId, id, '同一 context_key 复用同一条候选');
    assert.equal(second.mutations[0].after.distinct_turn_count, 2);
    assert.equal(second.mutations[0].after.importance_hint, 'review', '出现两次只触发评估');
    assert.equal(second.mutations[0].after.status, 'watching', '不强迫建档');
    assert.equal(second.mutations[0].after.promoted_entity_id, null);
    applyMentions(seed, second, 'turn_A2');

    const row = mentionById(seed.db, id);
    assert.equal(row.distinct_turn_count, 2);
    assert.equal(row.importance_hint, 'review');
    assert.equal(row.status, 'watching');
    assert.equal(characterByName(seed.db, '神秘旅人'), null, '评估不等于建人物实体');
    assert.equal(countRows(seed.db, 'characters', IDS.branchMain), 4);
    assert.deepEqual(foreignKeyCheck(seed.db), []);
  } finally {
    seed.close();
  }
});

test('T06-11 E15：recent 至多 8 条、summary 至多 200 字、同名不同 context_key 是两条候选', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const makeId = (kind, opId, alias) => `${kind}_${opId}_${alias}`.replace(/[^A-Za-z0-9_]/g, '_');
    const longSummary = '身份线索'.repeat(80); // 320 字
    for (let i = 0; i < 10; i += 1) {
      const turnId = i === 0 ? IDS.seedTurn : `turn_floor_${i}`;
      if (i > 0) addTurn(seed.db, turnId, i === 1 ? IDS.seedTurn : `turn_floor_${i - 1}`, WALL_OLD + i * 1000);
      const result = updateMentionCandidates({
        db: seed.db,
        branchId: IDS.branchMain,
        turnId,
        clockS: 0,
        nowWallMs: WALL_OLD + i * 1000,
        rulesetVersion: 'atlas-1',
        observations: [{ name: '同名人', kindHint: 'character', identity: '第一个上下文', contextSummary: longSummary }],
        makeId,
      });
      applyMentions(seed, result, turnId);
      if (i === 0) {
        assert.equal(result.mutations[0].after.context_summary.length, 200, 'context_summary 截断到 200 字');
        assert.equal(result.mutations[0].after.lorebook_source_keys_json.length, 0);
      }
    }
    const rows = seed.db.exec('SELECT * FROM mention_candidates WHERE branch_id = ?', [IDS.branchMain]);
    const first = rows[0].values.map((value) => {
      const out = {};
      rows[0].columns.forEach((column, i) => {
        out[column] = value[i];
      });
      return out;
    })[0];
    assert.equal(first.distinct_turn_count, 10, '10 个不同楼层 = 10 次');
    const recent = JSON.parse(first.recent_turn_ids_json);
    assert.equal(recent.length, MENTION_RECENT_TURNS_LIMIT, 'recent_turn_ids_json 至多 8 条');
    assert.equal(recent[recent.length - 1], 'turn_floor_9', '保留最新 8 次');
    assert.ok(!recent.includes(IDS.seedTurn), '最旧的楼层被挤出');
    assert.equal(first.context_summary.length, 200);

    // 同名不同 context_key：两条候选，不按名字合并。
    const other = updateMentionCandidates({
      db: seed.db,
      branchId: IDS.branchMain,
      turnId: 'turn_floor_9',
      clockS: 0,
      nowWallMs: WALL_OLD,
      rulesetVersion: 'atlas-1',
      observations: [{ name: '同名人', kindHint: 'location', identity: '另一个上下文（同名的地点）' }],
      makeId,
    });
    assert.equal(other.created, 1, '同名不同 context_key 必须新建第二条候选');
    assert.equal(other.mutations[0].before, null);
    assert.notEqual(other.mutations[0].rowId, first.id);
    assert.equal(countRows(seed.db, 'mention_candidates', IDS.branchMain), 1, '本函数不直接写库');
    applyMentions(seed, other, 'turn_floor_9');
    assert.equal(countRows(seed.db, 'mention_candidates', IDS.branchMain), 2);
  } finally {
    seed.close();
  }
});

test('T06-12 E15：超过 256 个未建档候选时淘汰最旧的无依据候选，core 永不自动淘汰', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    addTurn(seed.db, 'turn_A2', IDS.seedTurn, WALL_OLD + 5000);
    const makeId = (kind, opId, alias) => `${kind}_${opId}_${alias}`.replace(/[^A-Za-z0-9_]/g, '_');

    // 255 条 importance=none（其中 mc_oldest 的 last_turn_id 最旧）+ 1 条 core。
    inTransaction(seed.db, () => {
      const insert = (id, importance, lastTurnId) =>
        seed.db.run(
          `INSERT INTO mention_candidates (branch_id, id, name, normalized_name, context_key, kind_hint, first_turn_id, last_turn_id,
             distinct_turn_count, recent_turn_ids_json, context_summary, lorebook_source_keys_json, importance_hint, promoted_entity_id, status)
           VALUES (?, ?, ?, ?, '', 'character', ?, ?, 1, ?, '', '[]', ?, NULL, 'watching')`,
          [IDS.branchMain, id, id, id, IDS.seedTurn, lastTurnId, JSON.stringify([lastTurnId]), importance],
        );
      insert('mc_oldest', 'none', IDS.seedTurn);
      for (let i = 0; i < 254; i += 1) insert(`mc_fill_${String(i).padStart(3, '0')}`, 'none', 'turn_A2');
      insert('mc_core', 'core', 'turn_A2');
    });

    const result = updateMentionCandidates({
      db: seed.db,
      branchId: IDS.branchMain,
      turnId: 'turn_A2',
      clockS: 0,
      nowWallMs: WALL_OLD,
      rulesetVersion: 'atlas-1',
      observations: [{ name: '新面孔', kindHint: 'character', identity: '刚进城的商人' }],
      makeId,
    });
    assert.equal(result.created, 1);
    assert.deepEqual(result.evicted, ['mc_oldest'], '优先淘汰长期未出现且无重要依据的候选');
    const warning = result.issues.filter((i) => i.code === 'MENTION_EVICTED');
    assert.equal(warning.length, 1, '淘汰数量与理由进一条 MENTION_EVICTED warning');
    assert.equal(warning[0].severity, 'warning');
    assert.ok(warning[0].message.includes(String(MENTION_CANDIDATE_LIMIT)));
    assert.equal(result.mutations.filter((m) => m.after?.status === 'dismissed').length, 1);
    const evictedMutation = result.mutations.find((m) => m.rowId === 'mc_oldest');
    assert.equal(evictedMutation.before.status, 'watching', 'before 是读到的原行');
    assert.equal(evictedMutation.after.last_turn_id, 'turn_A2', '淘汰记到当前 turn（可回退）');
    assert.ok(!result.mutations.some((m) => m.rowId === 'mc_core'), 'core 永不自动淘汰');

    applyMentions(seed, result, 'turn_A2');
    assert.equal(mentionById(seed.db, 'mc_oldest').status, 'dismissed');
    assert.equal(mentionById(seed.db, 'mc_core').status, 'watching', 'core 保持候选');
    assert.equal(countRows(seed.db, 'mention_candidates', IDS.branchMain), MENTION_CANDIDATE_LIMIT + 1);
    assert.deepEqual(foreignKeyCheck(seed.db), []);
  } finally {
    seed.close();
  }
});

test('T06-13 promoteMention：正式建档后置 promoted；实体身份不存在时 REF_UNKNOWN', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const makeId = (kind, opId, alias) => `${kind}_${opId}_${alias}`.replace(/[^A-Za-z0-9_]/g, '_');
    const result = updateMentionCandidates({
      db: seed.db,
      branchId: IDS.branchMain,
      turnId: IDS.seedTurn,
      clockS: 0,
      nowWallMs: WALL_OLD,
      rulesetVersion: 'atlas-1',
      observations: [{ name: '铁匠', kindHint: 'character', identity: '城里的铁匠' }],
      makeId,
    });
    applyMentions(seed, result, IDS.seedTurn);
    const mentionId = result.mutations[0].rowId;

    assert.throws(() => promoteMention(seed.db, IDS.branchMain, mentionId, 'C_missing'), (err) => err.code === 'REF_UNKNOWN');
    assert.throws(() => promoteMention(seed.db, IDS.branchMain, 'mc_missing', IDS.C1), (err) => err.code === 'REF_UNKNOWN');

    const promotion = promoteMention(seed.db, IDS.branchMain, mentionId, IDS.C1);
    assert.equal(promotion.table, 'mention_candidates');
    assert.equal(promotion.rowId, mentionId);
    assert.equal(promotion.before.status, 'watching', 'before 是读到的原行');
    assert.equal(promotion.after.status, 'promoted');
    assert.equal(promotion.after.promoted_entity_id, IDS.C1);

    inTransaction(seed.db, () => {
      seed.db.run('UPDATE mention_candidates SET status = ?, promoted_entity_id = ? WHERE branch_id = ? AND id = ?', [
        'promoted',
        IDS.C1,
        IDS.branchMain,
        mentionId,
      ]);
    });
    const promotedRow = mentionById(seed.db, mentionId);
    assert.equal(promotedRow.status, 'promoted');
    assert.equal(promotedRow.promoted_entity_id, IDS.C1);

    // 已建档候选再次被提及时留在 promoted，并出现在 promoted 列表里。
    const again = updateMentionCandidates({
      db: seed.db,
      branchId: IDS.branchMain,
      turnId: IDS.seedTurn,
      clockS: 0,
      nowWallMs: WALL_OLD,
      rulesetVersion: 'atlas-1',
      observations: [{ name: '铁匠', kindHint: 'character', identity: '城里的铁匠' }],
      makeId,
    });
    assert.deepEqual(again.promoted, [mentionId]);
    assert.equal(again.mutations[0].after.status, 'promoted');
    assert.equal(again.mutations[0].after.promoted_entity_id, IDS.C1);
    assert.deepEqual(foreignKeyCheck(seed.db), []);
  } finally {
    seed.close();
  }
});
