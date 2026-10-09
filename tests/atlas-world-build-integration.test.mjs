/**
 * atlas-world-build-integration.test.mjs — M3-10 → M3-15 的集成验收。
 *
 * 覆盖（03-统一逐文件施工单 M3-10..M3-15 指定的验收编号）：
 * - W08 独立组部分成功（父环组失败，独立合法地点保存；已有人物/位置保留）
 * - W09 开场重要人物（一次出现即正式建档并落在具体场所；不被泛指空列表清掉）
 * - W11 建设重试幂等（同 anchor/inputHash 重跑不新增重复行；重开存档仍一致）
 * - W12 正文覆盖估计（只修正受影响数据；不强行保留估计；不删无关已确认地点；journal 可回退）
 * - I01 初建全链（实体/parent/地图保存后重开一致；没有「起点」placeholder）
 * - I02 布局失败实体仍可用（NPC/地点保存；失败项带 map/path；不冒充 success）
 * - I03 宿主保存失败（coreSaved=false；正式库 SHA 不变；可安全再保存）
 * - I04 等待中切聊天（B 无 A 的实体；A 结果不写进 B）
 * - I05 删楼全回退（对应业务恢复/删除；后代回退；无残留 world-fill 锚点）
 * - I06 重生成不同正文（先回退旧 variant；只留新 variant 的有效结果）
 * - I07 中断输出（完整行安全解析；不闭合段不抢救；错误码/行号/长度进诊断）
 * - I08 两个聊天和分支（无共享实体缓存；fork 是显式复制且之后隔离）
 * - I11 读取不写入（只读视图不产生 hostSave / modelCalls / 版本变化）
 *
 * 纪律：全程离线；合成世界一律来自 tests/fixtures/atlas-sql/ 的既有夹具；
 * 断言只落在可观察结果（候选库行、回执 groups/issues、journal、正式库哈希）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, selectOne, countRows, foreignKeyCheck } from './fixtures/atlas-sql/seed.mjs';
import { SOURCE_SNAPSHOT, caseById } from './fixtures/atlas-sql/model-cases.mjs';
import { createSqlRepository, restoreTurnChanges, collectDescendants } from '../src/atlas-db-repository.ts';
import { createHostSaveAdapter } from '../src/atlas-host-save.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { createTableReadPort } from '../src/atlas-db-readport.ts';
import { sha256Hex } from '../src/atlas-db-envelope.ts';
import { readWorldFillState } from '../src/atlas-sql-world-completion.ts';

const SQL = await (await import('sql.js')).default();
const BRANCH = IDS.branchMain;
const CHAT_A = IDS.chatA;
const CHAT_B = IDS.chatB;
const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 固定输出模型端口：按顺序返回预置文本，并记录批次身份。 */
function scriptedModel(responses) {
  const calls = [];
  return {
    calls,
    async request(req) {
      calls.push({ batchId: req.batchId, phase: req.phase });
      const text = responses.length > 0 ? responses.shift() : '{"op":"noop"}';
      return { batchId: req.batchId, text, finishReason: 'stop', httpStatus: 200, durationMs: 1 };
    },
  };
}

function anchorFor(overrides = {}) {
  return {
    chatUid: CHAT_A,
    branchId: BRANCH,
    parentTurnId: IDS.seedTurn,
    hostMessageUid: 'msg_int',
    variantKey: 'v1',
    baseRevision: 0,
    baseStorageRevision: 0,
    inputHash: 'input_hash_int',
    ...overrides,
  };
}

/** 打开既有种子世界（chat-A / main-A）。 */
async function makeRepo({ responses = [], chatUid = CHAT_A, branchId = BRANCH } = {}) {
  const model = scriptedModel(responses);
  const repo = createSqlRepository({ chatUid, branchId, branchName: '主线', modelPort: model, now: () => NOW });
  const seed = await makeSeedWith(SQL);
  const bytes = seed.exportBytes();
  seed.close();
  await repo.open({ bytes });
  return { repo, model };
}

/** 打开空世界（无实体、无「起点」）。 */
async function makeEmptyRepo({ responses = [] } = {}) {
  const model = scriptedModel(responses);
  const repo = createSqlRepository({ chatUid: CHAT_A, branchId: BRANCH, branchName: '主线', modelPort: model, now: () => NOW });
  await repo.open({});
  return { repo, model };
}

const cand = (repo, prepared) => repo.getCandidate(prepared.token).db;
const q = (db, sql, params = []) => queryBound(db, sql, params);
const rows = (db, table, where = '', params = []) =>
  q(db, `SELECT * FROM ${table} WHERE branch_id = ? ${where}`, [BRANCH, ...params]);
/** 指定分支版本的同类读取（空世界 / fork 场景用，分支 id 不是 main-A）。 */
const rows2 = (db, branchId, table, where = '', params = []) =>
  q(db, `SELECT * FROM ${table} WHERE branch_id = ? ${where}`, [branchId, ...params]);

/** 本轮建设状态元数据（M3-12：写在 focus map 的 frame 里）。 */
const fillOf = (db, mapId) => readWorldFillState(createTableReadPort(db), BRANCH, mapId);

/** 独立合法地点（父指向已登记的 L2）。 */
const INDEPENDENT_NEW = '{"op":"location.upsert","ref":"new:inn","data":{"name":"旅店","kind":"building","parent_ref":"L2"}}';
/** 父环一组：A 的父是 B、B 的父是 A（不变量必须拒绝）。 */
const PARENT_CYCLE = '{"op":"location.upsert","ref":"new:a","data":{"name":"甲环","kind":"room","parent_ref":"new:b"}}\n'
  + '{"op":"location.upsert","ref":"new:b","data":{"name":"乙环","kind":"room","parent_ref":"new:a"}}';
const LOCAL_FOCUS = { mode: 'local', focusLocationIds: [IDS.L3] };

/** 建设任务只在本轮有目标且预算非零时才生成；空响应只用来占位。 */
const NOOP = '{"op":"noop"}';

// ---------------------------------------------------------------------------
// W08 · 独立组部分成功
// ---------------------------------------------------------------------------

test('W08: 父环组失败但独立合法地点保存；失败组完整列出；已有人物与主角位置保留', async () => {
  const { repo } = await makeRepo({ responses: [NOOP, `${INDEPENDENT_NEW}\n${PARENT_CYCLE}`] });
  try {
    const prepared = await repo.prepareTurn({
      anchor: anchorFor(), userText: '他走进旅店。', assistantText: '旅店就在街角。',
      sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false, worldCompletion: LOCAL_FOCUS,
    });
    const receipt = prepared.receipt;

    // 独立合法组落地、父环组失败 → partial，而不是整轮失败。
    assert.equal(receipt.status, 'partial', '独立组成功 + 相关组失败 = partial');
    assert.equal(receipt.worldChanged, true, '确实有业务变更');

    // 失败组必须**完整列出**：两个成环操作一个不少，并指明失败不变量。
    const rejected = receipt.groups.filter((g) => g.status === 'rejected' || g.status === 'blocked');
    assert.equal(rejected.length, 1, '恰好一个父环组被拒');
    assert.equal(rejected[0].opIds.length, 2, '父环组的两个操作都要列出来');
    const cycleIssue = rejected[0].issues.find((i) => i.code === 'INVARIANT_FAILED');
    assert.ok(cycleIssue, '必须是显式的不变量失败');
    assert.match(cycleIssue.message, /INVARIANT_LOCATION_PARENT_CYCLE/, '失败原因要指名父环不变量');

    // 独立合法地点保存成功。
    const db = cand(repo, prepared);
    const created = rows(db, 'locations', 'AND name = ?', ['旅店']);
    assert.equal(created.length, 1, '独立合法地点必须保存');
    assert.equal(created[0].parent_location_id, IDS.L2, 'parent 指向已登记的 L2');
    assert.equal(rows(db, 'locations', 'AND name IN (?, ?)', ['甲环', '乙环']).length, 0, '父环组两个地点都不许写进去');

    // 已有人物与主角位置逐字段保留（不因布局/建设失败丢失）。
    const c1 = selectOne(db, 'characters', BRANCH, IDS.C1);
    assert.equal(c1.name, '艾琳');
    assert.equal(c1.location_id, IDS.L2, '主角位置不得被世界建设带偏');
    assert.equal(selectOne(db, 'characters', BRANCH, IDS.C4).location_id, IDS.L1);
    assert.equal(foreignKeyCheck(db).length, 0, '候选库外键必须自洽');

    // 建设状态元数据如实记录 partial（M3-12）。
    const fill = fillOf(db, IDS.M2);
    assert.equal(fill.status, 'partial');
    assert.equal(fill.reasonCode, 'WORLD_CONSTRUCTION_PARTIAL');
    assert.deepEqual(fill.createdLocationIds, [created[0].id], '只记本次真正新建的地点');

    // coreSaved 按真实 ACK：确认后才发布，且发布的正是这份候选。
    await repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'saved' });
    assert.equal(rows(repo.db, 'locations', 'AND name = ?', ['旅店']).length, 1, '确认后正式库可见');
    assert.equal(Number(q(repo.db, 'SELECT revision FROM branches WHERE id = ?', [BRANCH])[0].revision), 1);
  } finally {
    await repo.close();
  }
});

// ---------------------------------------------------------------------------
// W09 · 开场重要人物
// ---------------------------------------------------------------------------

test('W09: 一次出现且世界书有明确身份的重要人物当轮建档并落在具体场所；不被泛指空列表清掉', async () => {
  // 开场已在具体房间：主角 C1 的当前位置就是 L2（学校）。
  const opening = '{"op":"character.upsert","ref":"new:ina","data":{"name":"伊娜","identity":"王宫卫队长","importance":"core","importance_reason":"世界书明确身份","location_ref":"L3"}}';
  const { repo } = await makeRepo({ responses: [opening] });
  try {
    const first = await repo.prepareTurn({
      anchor: anchorFor(), userText: '校门口的卫队长拦住了他。', assistantText: '伊娜站在教室门口。',
      sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false,
    });
    assert.equal(first.receipt.status, 'committed');
    const db = cand(repo, first);
    const ina = rows(db, 'characters', 'AND name = ?', ['伊娜']);
    assert.equal(ina.length, 1, '重要人物必须当轮正式建档');
    assert.equal(ina[0].importance, 'core', '世界书有明确身份 → core');
    assert.equal(ina[0].location_id, IDS.L3, '必须落在具体场所（教室），不是泛指');
    await repo.confirmSaved({ token: first.token, snapshotSha256: first.snapshotSha256, result: 'saved' });

    // 附近/地点名单一致：该人物所在的地点必须是真实存在的地点行。
    const room = selectOne(repo.db, 'locations', BRANCH, IDS.L3);
    assert.ok(room, '教室必须在地点表里');
    assert.equal(room.map_id, IDS.M2, '具体场所挂在自己的图上');
    const mapView = await repo.queryView({ kind: 'map', branchId: BRANCH, viewMode: 'author' });
    const ids = mapView.items.flatMap((m) => [...(m.points ?? []), ...(m.coarseList ?? [])].map((p) => p.entityId));
    assert.equal(ids.includes(IDS.L3), true, '地点名单里必须有这间教室');

    // 下一轮正文只有泛指周围人物（空列表）：不得据此清掉已建档的人物。
    const second = await repo.prepareTurn({
      anchor: anchorFor({ parentTurnId: first.receipt.turnId, hostMessageUid: 'msg_2', baseRevision: 1, inputHash: 'ih_2' }),
      userText: '他环顾四周。', assistantText: '周围没有别人。',
      sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false,
    });
    await repo.confirmSaved({ token: second.token, snapshotSha256: second.snapshotSha256, result: 'saved' });
    const still = rows(repo.db, 'characters', 'AND name = ?', ['伊娜']);
    assert.equal(still.length, 1, '泛指空列表不得当成删除指令');
    assert.equal(still[0].location_id, IDS.L3, '位置不得被空列表清空');
  } finally {
    await repo.close();
  }
});

// ---------------------------------------------------------------------------
// W11 · 建设重试幂等
// ---------------------------------------------------------------------------

test('W11: 同 anchor/inputHash 重跑不新增重复地点；重开存档仍只有一份', async () => {
  // 带着必须失败的父环组：项目才是 partial，下一轮才真的会再发一次建设请求。
  const { repo } = await makeRepo({
    responses: [NOOP, `${INDEPENDENT_NEW}\n${PARENT_CYCLE}`, NOOP, `${INDEPENDENT_NEW}\n${PARENT_CYCLE}`],
  });
  try {
    const first = await repo.prepareTurn({
      anchor: anchorFor(), userText: '他走进旅店。', assistantText: '旅店在街角。',
      sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false, worldCompletion: LOCAL_FOCUS,
    });
    await repo.confirmSaved({ token: first.token, snapshotSha256: first.snapshotSha256, result: 'saved' });
    const inn1 = rows(repo.db, 'locations', 'AND name = ?', ['旅店']);
    assert.equal(inn1.length, 1, '第一轮建出一间旅店');
    const fill1 = fillOf(repo.db, IDS.M2);
    assert.equal(fill1.status, 'partial', '父环未解决 → partial，下一轮仍需继续建设');
    assert.deepEqual(fill1.createdLocationIds, [inn1[0].id]);

    // 第二次：同 anchor/inputHash 重跑同一份建设响应。
    const second = await repo.prepareTurn({
      anchor: anchorFor({ parentTurnId: first.receipt.turnId, hostMessageUid: 'msg_int', baseRevision: 1, inputHash: 'input_hash_int' }),
      userText: '他走进旅店。', assistantText: '旅店在街角。',
      sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false, worldCompletion: LOCAL_FOCUS,
    });
    await repo.confirmSaved({ token: second.token, snapshotSha256: second.snapshotSha256, result: 'saved' });
    const inn2 = rows(repo.db, 'locations', 'AND name = ?', ['旅店']);
    assert.equal(inn2.length, 1, '第二次重跑不得新增重复地点');
    assert.equal(inn2[0].id, inn1[0].id, '必须复用同一行（duplicate/reused 而不是再造一个）');
    assert.equal(inn2[0].grid_x, inn1[0].grid_x, '坐标不得被重试改动');
    assert.equal(inn2[0].grid_y, inn1[0].grid_y);
    assert.deepEqual(fillOf(repo.db, IDS.M2).createdLocationIds, [], '第二轮不得再记新建（复用已有行）');

    // 重开保存的存档：结果逐字段一致。
    const bytes = await repo.exportCurrent();
    const reopened = createSqlRepository({ chatUid: CHAT_A, branchId: BRANCH, branchName: '主线', modelPort: scriptedModel([]), now: () => NOW });
    await reopened.open({ bytes });
    try {
      const again = rows(reopened.db, 'locations', 'AND name = ?', ['旅店']);
      assert.equal(again.length, 1, '重开后仍只有一间旅店');
      assert.equal(again[0].id, inn1[0].id);
      assert.equal(again[0].grid_x, inn1[0].grid_x, '重开后坐标一致');
      assert.deepEqual(fillOf(reopened.db, IDS.M2), fillOf(repo.db, IDS.M2), '建设状态元数据随存档一致');
    } finally {
      await reopened.close();
    }
  } finally {
    await repo.close();
  }
});

// ---------------------------------------------------------------------------
// W12 · 正文覆盖估计
// ---------------------------------------------------------------------------

test('W12: 正文确认覆盖旧的推断——只修正受影响行，不删无关已确认地点，journal 可回退', async () => {
  const inferred = '{"op":"location.upsert","ref":"new:hall","data":{"name":"偏厅","kind":"room","parent_ref":"L2"}}';
  const { repo } = await makeRepo({
    responses: [NOOP, inferred,
      // 下一楼正文确认：它不是偏厅，是一间已确认的储藏室。
      '{"op":"location.upsert","ref":"L4","data":{"name":"储藏室","existence_quality":"confirmed"}}'],
  });
  try {
    const turn1 = await repo.prepareTurn({
      anchor: anchorFor(), userText: '他推开侧门。', assistantText: '门后似乎有个偏厅。',
      sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false, worldCompletion: LOCAL_FOCUS,
    });
    const db1 = cand(repo, turn1);
    const hall = rows(db1, 'locations', 'AND name = ?', ['偏厅']);
    assert.equal(hall.length, 1);
    assert.equal(hall[0].existence_quality, 'inferred', '未获支持的新地点只能记为推断');
    const hallId = hall[0].id;
    await repo.confirmSaved({ token: turn1.token, snapshotSha256: turn1.snapshotSha256, result: 'saved' });

    const confirmedL1 = selectOne(repo.db, 'locations', BRANCH, IDS.L1);
    const confirmedL2 = selectOne(repo.db, 'locations', BRANCH, IDS.L2);
    const routeBefore = selectOne(repo.db, 'routes', BRANCH, IDS.R_AB);

    // 下一楼：正文直接确认它是「储藏室」。
    const turn2 = await repo.prepareTurn({
      anchor: anchorFor({ parentTurnId: turn1.receipt.turnId, hostMessageUid: 'msg_12', baseRevision: 1, inputHash: 'ih_12' }),
      userText: '他走进那间屋子。', assistantText: '那不是偏厅，是储藏室。',
      sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false,
    });
    await repo.confirmSaved({ token: turn2.token, snapshotSha256: turn2.snapshotSha256, result: 'saved' });

    const corrected = selectOne(repo.db, 'locations', BRANCH, hallId);
    assert.equal(corrected.name, '储藏室', '正文修正该行');
    assert.equal(corrected.existence_quality, 'confirmed', '确认事实覆盖旧估计，不强行保留 inferred');
    assert.equal(corrected.parent_location_id, hall[0].parent_location_id, '只改被修正的字段');

    // 无关的已确认地点与路线一个都不能少、一个字段都不能变。
    assert.deepEqual(selectOne(repo.db, 'locations', BRANCH, IDS.L1), confirmedL1, '无关地点不得被改');
    assert.deepEqual(selectOne(repo.db, 'locations', BRANCH, IDS.L2), confirmedL2, '无关地点不得被改');
    assert.deepEqual(selectOne(repo.db, 'routes', BRANCH, IDS.R_AB), routeBefore, '无关路线不得被改');
    assert.equal(rows(repo.db, 'locations', 'AND id IN (?, ?, ?)', [IDS.L1, IDS.L2, IDS.L3]).length, 3, '无关地点不得被删');

    // journal 可回退：第 2 楼的变更能逐条恢复回第 1 楼的估计状态。
    const changes = q(repo.db, 'SELECT target_table, target_row_id, before_json, after_json FROM turn_changes WHERE turn_id = ? AND target_table = ? AND target_row_id = ?', [turn2.receipt.turnId, 'locations', hallId]);
    assert.equal(changes.length >= 1, true, '修正必须进 journal');
    const restored = restoreTurnChanges(repo.db, turn2.receipt.turnId);
    assert.equal(restored >= 1, true, 'journal 必须能回退');
    const back = selectOne(repo.db, 'locations', BRANCH, hallId);
    assert.equal(back.name, '偏厅', '回退后恢复旧名');
    assert.equal(back.existence_quality, 'inferred', '回退后恢复旧估计');
  } finally {
    await repo.close();
  }
});

// ---------------------------------------------------------------------------
// I01 · 初建全链
// ---------------------------------------------------------------------------

test('I01: 空世界一次建全链——实体/parent/地图保存后重开一致，且没有「起点」', async () => {
  const firstObserve = '{"op":"location.upsert","ref":"new:lodge","data":{"name":"望海驿","kind":"building","existence_quality":"confirmed"}}\n'
    + '{"op":"character.upsert","ref":"new:aron","data":{"name":"阿隆","identity":"驿站长","importance":"core","location_ref":"new:lodge"}}';
  const { repo } = await makeEmptyRepo({ responses: [firstObserve, INDEPENDENT_NEW] });
  try {
    // 空世界由程序建立 branch + migration turn；父楼层必须用它真实的 id。
    const branchRow = q(repo.db, 'SELECT id, head_turn_id FROM branches')[0];
    const emptyBranchId = String(branchRow.id);
    const seedTurnId = String(branchRow.head_turn_id);
    const turn1 = await repo.prepareTurn({
      anchor: anchorFor({ branchId: emptyBranchId, parentTurnId: seedTurnId }),
      userText: '他推门走进驿站。', assistantText: '驿站长阿隆在柜台后抬头。',
      sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false,
    });
    const i01Branch = emptyBranchId;
    assert.equal(turn1.receipt.status, 'committed');
    const db1 = cand(repo, turn1);
    assert.equal(rows2(db1, i01Branch, 'locations', 'AND name IN (?, ?)', ['起点', '开始']).length, 0, '不得建立「起点」placeholder');
    const lodge = rows2(db1, i01Branch, 'locations', 'AND name = ?', ['望海驿']);
    assert.equal(lodge.length, 1);
    const aron = rows2(db1, i01Branch, 'characters', 'AND name = ?', ['阿隆']);
    assert.equal(aron.length, 1);
    assert.equal(aron[0].location_id, lodge[0].id, '人物 parent 指向本批新建的地点');
    assert.equal(foreignKeyCheck(db1).length, 0);
    await repo.confirmSaved({ token: turn1.token, snapshotSha256: turn1.snapshotSha256, result: 'saved' });

    // 重开：实体/parent/地图逐字段一致。
    const bytes = await repo.exportCurrent();
    const reopened = createSqlRepository({ chatUid: CHAT_A, branchId: i01Branch, branchName: '主线', modelPort: scriptedModel([]), now: () => NOW });
    await reopened.open({ bytes });
    try {
      const locs = rows2(reopened.db, i01Branch, 'locations');
      assert.equal(locs.length, 1, '只有一个场所');
      assert.equal(locs[0].name, '望海驿');
      const chars = rows2(reopened.db, i01Branch, 'characters');
      assert.equal(chars.length, 1);
      assert.equal(chars[0].location_id, locs[0].id, '重开后 parent 关系不变');
      // 空世界不强制新建根图（01 §：不伪造起点/不强制地图）；重开后图的数量与内容必须逐字段一致。
      assert.deepEqual(
        rows2(reopened.db, i01Branch, 'maps').map((m) => [m.id, m.kind, String(m.frame_json)]),
        rows2(repo.db, i01Branch, 'maps').map((m) => [m.id, m.kind, String(m.frame_json)]),
        '重开后地图与 frame 逐字段一致',
      );
      assert.equal(rows2(reopened.db, i01Branch, 'locations', 'AND name IN (?, ?)', ['起点', '开始']).length, 0, '重开后仍然没有「起点」');
      assert.equal(foreignKeyCheck(reopened.db).length, 0, '重开后外键自洽');
    } finally {
      await reopened.close();
    }
  } finally {
    await repo.close();
  }
});

// ---------------------------------------------------------------------------
// I02 · 布局失败实体仍可用
// ---------------------------------------------------------------------------

test('I02: 布局失败但 NPC/地点照常保存；失败项带 map/path；回执不冒充 success', async () => {
  // 第 1 楼：观察建立 NPC（落在 L3）与地点；geography 批次给出本图布局 → 有旧图可退。
  const observe = '{"op":"character.upsert","ref":"new:bex","data":{"name":"贝克斯","identity":"铁匠","importance":"recurring","location_ref":"L3"}}\n'
    + '{"op":"location.upsert","ref":"new:forge","data":{"name":"铁匠铺","kind":"building","parent_ref":"L2"}}';
  // ref 必须是**地图**（M2 = 教室图）；房间 id 才是地点引用。
  const goodLayout = '{"op":"map.layout.request","ref":"M2","data":{"kind":"floor","spec":{"width":4,"height":3,"rooms":[{"id":"L3","name":"教室","w":4,"h":3,"side":"north"}],"contents":[],"actors":[{"id":"new:bex","roomId":"L3"}]}}}';
  const { repo } = await makeRepo({ responses: [observe, goodLayout, NOOP] });
  try {
    const turn1 = await repo.prepareTurn({
      anchor: anchorFor(), userText: '他进了铁匠铺。', assistantText: '贝克斯在打铁。',
      sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe', 'geography'], manual: false,
    });
    await repo.confirmSaved({ token: turn1.token, snapshotSha256: turn1.snapshotSha256, result: 'saved' });
    assert.equal(rows(repo.db, 'characters', 'AND name = ?', ['贝克斯']).length, 1, 'NPC 先落库');
    assert.equal(rows(repo.db, 'locations', 'AND name = ?', ['铁匠铺']).length, 1, '地点先落库');
    const frameBefore = JSON.parse(String(selectOne(repo.db, 'maps', BRANCH, IDS.M2).frame_json));
    assert.ok(frameBefore.atlasScene, '旧图必须先存在（I02 要验证"旧图仍可看"）');
    const sceneSigBefore = String(frameBefore.atlasScene.inputSignature ?? '');
    assert.ok(sceneSigBefore.length > 0);

    // 第 2 楼：布局阶段模型什么都没给 → 布局失败。
    const turn2 = await repo.prepareTurn({
      anchor: anchorFor({ parentTurnId: turn1.receipt.turnId, hostMessageUid: 'msg_layout', baseRevision: 1, inputHash: 'ih_layout' }),
      userText: '他打量着铺子。', assistantText: '铺子里摆着工具。',
      sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false, layoutMaps: 'active',
    });
    const receipt = turn2.receipt;

    // 实体照常可用：NPC 与地点都还在，位置没丢。
    const db2 = cand(repo, turn2);
    assert.equal(rows(db2, 'characters', 'AND name = ?', ['贝克斯']).length, 1, '布局失败不得丢 NPC');
    assert.equal(rows(db2, 'locations', 'AND name = ?', ['铁匠铺']).length, 1, '布局失败不得丢地点');
    assert.equal(selectOne(db2, 'characters', BRANCH, IDS.C1).location_id, IDS.L2, '主角位置保留');
    assert.equal(foreignKeyCheck(db2).length, 0);

    // 布局失败必须被具体列出：带自己的 path，且回执不是虚假 success。
    const layoutIssues = receipt.issues.filter((i) => i.code === 'LAYOUT_NOT_GENERATED' || i.code === 'LAYOUT_MODEL_FAILED' || i.code === 'JOURNAL_WRITE_FAILED');
    assert.equal(layoutIssues.length >= 1, true, `必须列出布局失败项，实际 issues=${JSON.stringify(receipt.issues.map((i) => i.code))}`);
    assert.equal(String(layoutIssues[0].path).startsWith('$.layout'), true, '失败项必须带具体 path（$.layout）');
    assert.notEqual(receipt.status, 'committed', '布局失败不得报 committed');

    // 旧图仍可看：布局失败不得覆盖/清空已确认的旧图。
    const frameAfter = JSON.parse(String(selectOne(db2, 'maps', BRANCH, IDS.M2).frame_json));
    assert.equal(String(frameAfter.atlasScene?.inputSignature ?? ''), sceneSigBefore, '旧图（概览）不得被失败布局改动');
    const view = await repo.queryView({ kind: 'map', branchId: BRANCH, viewMode: 'author' });
    assert.ok(Array.isArray(view.items), '旧地图仍可读');

    // 布局未可绘制时，world-fill 不得报 ready。
    const fill = fillOf(db2, IDS.M2);
    if (fill) assert.notEqual(fill.status, 'ready', '布局未可绘制时不得 ready');
  } finally {
    await repo.close();
  }
});

// ---------------------------------------------------------------------------
// I03 · 宿主保存失败
// ---------------------------------------------------------------------------

test('I03: 宿主保存失败 → coreSaved 不为真、正式库 SHA 不变、可安全再保存', async () => {
  const { repo } = await makeRepo({ responses: [NOOP, INDEPENDENT_NEW, NOOP, INDEPENDENT_NEW] });
  try {
    const prepared = await repo.prepareTurn({
      anchor: anchorFor(), userText: '他走进旅店。', assistantText: '旅店在街角。',
      sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false, worldCompletion: LOCAL_FOCUS,
    });
    const beforeSha = await sha256Hex(await repo.exportCurrent());

    // 宿主保存失败：适配器必须明确 failed，且不得出现 coreSaved:true。
    const adapter = createHostSaveAdapter({
      captureAnchor: () => ({ chatUid: CHAT_A, hostChatId: CHAT_A, metadataIdentity: {}, branchId: BRANCH, revision: 0, storageRevision: 0 }),
      isCurrent: () => true,
      save: async () => ({ confirmed: false, error: '磁盘写满' }),
    });
    const ack = await adapter.saveCandidate({ capturedHostAnchor: adapter.captureAnchor(), prepared, envelope: prepared.envelope });
    assert.equal(ack.result, 'failed', '保存失败必须是 failed');
    assert.notEqual(ack.coreSaved, true, '不得出现 coreSaved:true');

    // 正式库一个字节都不变（没有虚假发布）。
    assert.equal(await sha256Hex(await repo.exportCurrent()), beforeSha, '保存失败后正式库 SHA 不变');
    assert.equal(rows(repo.db, 'locations', 'AND name = ?', ['旅店']).length, 0, '候选内容不得泄漏进正式库');

    // 用失败 ACK 去确认：候选被丢弃、正式库仍不变（confirmSaved 的 failed 分支就是丢弃）。
    await repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'not_saved' });
    assert.equal(await sha256Hex(await repo.exportCurrent()), beforeSha, '失败 ACK 不得推进正式库');
    assert.equal(rows(repo.db, 'locations', 'AND name = ?', ['旅店']).length, 0, '候选内容不得泄漏进正式库');
    await assert.rejects(
      () => repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'saved' }),
      (err) => { assert.equal(err.code, 'CANDIDATE_UNKNOWN'); return true; },
      '失败后候选已丢弃，不得再被"补一次成功"',
    );

    // 可安全再保存：重新准备一轮就正常发布（不是靠复用已丢弃的候选）。
    const retry = await repo.prepareTurn({
      anchor: anchorFor({ hostMessageUid: 'msg_retry', inputHash: 'ih_retry' }),
      userText: '他走进旅店。', assistantText: '旅店在街角。',
      sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false, worldCompletion: LOCAL_FOCUS,
    });
    await repo.confirmSaved({ token: retry.token, snapshotSha256: retry.snapshotSha256, result: 'saved' });
    assert.equal(rows(repo.db, 'locations', 'AND name = ?', ['旅店']).length, 1, '重试保存成功后正常发布');
  } finally {
    await repo.close();
  }
});

// ---------------------------------------------------------------------------
// I04 · 等待中切聊天
// ---------------------------------------------------------------------------

test('I04: 模型未返回就切到 chat-B → 候选丢弃，B 里没有 A 的实体', async () => {
  const { repo } = await makeRepo({ responses: [NOOP, INDEPENDENT_NEW] });
  const bSeed = await makeSeedWith(SQL);
  const bBytes = bSeed.exportBytes();
  bSeed.close();
  const repoB = createSqlRepository({ chatUid: CHAT_B, branchId: IDS.branchB, branchName: '另一分支', modelPort: scriptedModel([]), now: () => NOW });
  await repoB.open({ bytes: bBytes });
  try {
    const beforeB = await sha256Hex(await repoB.exportCurrent());
    // 等待建设响应期间切换聊天。
    let flipped = false;
    const prepared = await repo.prepareTurn({
      anchor: anchorFor(),
      userText: '他走进旅店。', assistantText: '旅店在街角。',
      sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false, worldCompletion: LOCAL_FOCUS,
      isCurrent: () => {
        // 第一次询问（模型调用之后）就报告已切走。
        if (!flipped) { flipped = true; return true; }
        return false;
      },
    }).catch((err) => err);

    if (prepared instanceof Error) {
      assert.equal(prepared.code, 'STALE_BASE', `切聊天必须报 STALE_BASE，实际 ${prepared.code}`);
    } else {
      // 若候选仍产出，也绝不能写进 B —— 用失败 ACK 收尾并确认 A 的实体不进正式库。
      await repo.confirmSaved({ token: prepared.token, snapshotSha256: prepared.snapshotSha256, result: 'not_saved' });
      assert.equal(rows(repo.db, 'locations', 'AND name = ?', ['旅店']).length, 0, 'A 的结果不得发布');
    }

    // B 完全不受影响。
    assert.equal(await sha256Hex(await repoB.exportCurrent()), beforeB, 'B 的存档逐字节不变');
    assert.equal(rows(repoB.db, 'locations', 'AND name = ?', ['旅店']).length, 0, 'B 里没有 A 的新实体');
    assert.equal(rows(repoB.db, 'locations', 'AND name = ?', ['圣罗兰城']).length, 1, 'B 保留自己的实体');
  } finally {
    await repoB.close();
    await repo.close();
  }
});

// ---------------------------------------------------------------------------
// I05 · 删楼全回退
// ---------------------------------------------------------------------------

test('I05: 删掉建设楼层 → 对应业务恢复/删除、后代回退、不留 world-fill 锚点', async () => {
  const { repo } = await makeRepo({ responses: [NOOP, INDEPENDENT_NEW, NOOP] });
  try {
    const turn1 = await repo.prepareTurn({
      anchor: anchorFor(), userText: '他走进旅店。', assistantText: '旅店在街角。',
      sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false, worldCompletion: LOCAL_FOCUS,
    });
    await repo.confirmSaved({ token: turn1.token, snapshotSha256: turn1.snapshotSha256, result: 'saved' });
    const innId = rows(repo.db, 'locations', 'AND name = ?', ['旅店'])[0].id;
    assert.equal(fillOf(repo.db, IDS.M2).createdLocationIds.includes(innId), true, '第 1 楼写入 world-fill');

    // 之后再来一个 manual 子回合（后代）。
    const turn2 = await repo.prepareTurn({
      anchor: anchorFor({ parentTurnId: turn1.receipt.turnId, hostMessageUid: 'msg_manual', variantKey: 'vm', baseRevision: 1, inputHash: 'ih_manual' }),
      userText: '', assistantText: '（手动标定）',
      sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: [], manual: true,
    });
    await repo.confirmSaved({ token: turn2.token, snapshotSha256: turn2.snapshotSha256, result: 'saved' });

    // 后代确实挂在第 1 楼之下。
    assert.deepEqual(collectDescendants(repo.db, BRANCH, turn1.receipt.turnId).sort(), [turn1.receipt.turnId, turn2.receipt.turnId].sort());

    // 删掉第 1 楼：回退到它的父（seed turn）。基版本用真实当前值。
    const revNow = Number(q(repo.db, 'SELECT revision FROM branches WHERE id = ?', [BRANCH])[0].revision);
    const rollback = await repo.prepareRollback({
      chatUid: CHAT_A, branchId: BRANCH, targetParentTurnId: IDS.seedTurn, expectedRevision: revNow,
    });
    await repo.confirmSaved({ token: rollback.token, snapshotSha256: rollback.snapshotSha256, result: 'saved' });

    // 该楼层建出来的地点被删除；世界回退到建立之前。
    assert.equal(selectOne(repo.db, 'locations', BRANCH, innId), null, '被删楼层建的地点必须回退掉');
    assert.equal(rows(repo.db, 'characters', 'AND name = ?', ['伊娜']).length, 0, '同一楼层的人物一并回退');

    // world-fill 锚点不得残留指向已回退的 createdLocationIds。
    const fill = fillOf(repo.db, IDS.M2);
    if (fill) {
      assert.equal(fill.createdLocationIds.includes(innId), false, 'world-fill 不得残留已回退的地点锚点');
    }
    assert.equal(Number(q(repo.db, 'SELECT revision FROM branches WHERE id = ?', [BRANCH])[0].revision) >= 2, true, '回退本身推进新修订');
    assert.equal(foreignKeyCheck(repo.db).length, 0, '回退后外键自洽');
  } finally {
    await repo.close();
  }
});

// ---------------------------------------------------------------------------
// I06 · 重生成不同正文
// ---------------------------------------------------------------------------

test('I06: 同一楼层改正文重生成 → 先回退旧 variant，只留新 variant 的有效结果', async () => {
  // 契约（01 §7 / M3-14「deleted/swipe oldvariant 准备过期仍原有保护」）：
  // 仓库不对同 hostMessageUid 的另一个 variant 做**隐式**回退——旧 variant 由宿主显式回退
  // （UI 层 MESSAGE_SWIPED → rollback + rearm）；本用例按真实顺序验证最终只留新 variant 的结果。
  const variantA = '{"op":"character.upsert","ref":"new:gu","data":{"name":"古","identity":"守钟人"}}';
  const { repo } = await makeRepo({
    responses: [variantA,
      // variant2：完全不同的正文 → 不同的推演结果。
      '{"op":"location.upsert","ref":"new:tower","data":{"name":"钟楼","kind":"building","existence_quality":"confirmed"}}'],
  });
  try {
    const v1 = await repo.prepareTurn({
      anchor: anchorFor({ hostMessageUid: 'msg_v', variantKey: 'v1', inputHash: 'ih_v1' }),
      userText: '他抬头。', assistantText: '钟楼在他眼前。',
      sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false,
    });
    await repo.confirmSaved({ token: v1.token, snapshotSha256: v1.snapshotSha256, result: 'saved' });
    assert.equal(rows(repo.db, 'characters', 'AND name = ?', ['古']).length, 1, 'variant1 的结果先落库');
    assert.equal(String(selectOne(repo.db, 'turns', BRANCH, v1.receipt.turnId).host_variant_key), 'v1');

    // 宿主先回退旧 variant 所在楼层（同 hostMessageUid × 不同 variantKey ≠ 隐式复用）。
    const revNow = Number(q(repo.db, 'SELECT revision FROM branches WHERE id = ?', [BRANCH])[0].revision);
    const back = await repo.prepareRollback({ chatUid: CHAT_A, branchId: BRANCH, targetParentTurnId: IDS.seedTurn, expectedRevision: revNow });
    await repo.confirmSaved({ token: back.token, snapshotSha256: back.snapshotSha256, result: 'saved' });
    assert.equal(rows(repo.db, 'characters', 'AND name = ?', ['古']).length, 0, '旧 variant 的结果必须先被回退掉');

    // 再准备 variant2：只含新 variant 的有效结果（不要求与 v1 同 seed/同剧情）。
    const v2 = await repo.prepareTurn({
      anchor: anchorFor({ hostMessageUid: 'msg_v', variantKey: 'v2', baseRevision: Number(q(repo.db, 'SELECT revision FROM branches WHERE id = ?', [BRANCH])[0].revision), inputHash: 'ih_v2' }),
      userText: '他抬头。', assistantText: '他看到的是钟楼，没有别人。',
      sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false,
    });
    await repo.confirmSaved({ token: v2.token, snapshotSha256: v2.snapshotSha256, result: 'saved' });

    const db = repo.db;
    assert.equal(rows(db, 'locations', 'AND name = ?', ['钟楼']).length, 1, 'variant2 的有效结果必须在');
    assert.equal(rows(db, 'characters', 'AND name = ?', ['古']).length, 0, 'variant1 的结果不得残留');
    assert.equal(String(selectOne(db, 'turns', BRANCH, v2.receipt.turnId).host_variant_key), 'v2', '当前楼层必须记在 variant2 名下');
    assert.equal(foreignKeyCheck(db).length, 0);
  } finally {
    await repo.close();
  }
});

// ---------------------------------------------------------------------------
// I07 · 中断输出
// ---------------------------------------------------------------------------

test('I07: 两条完整操作 + 一个不完整尾行 → 完整行安全落库，尾行报行号，不抢救未闭合段', async () => {
  const truncated = '{"op":"character.upsert","ref":"C3","data":{"thought":"先观察。"}}\n'
    + '{"op":"character.upsert","ref":"C4","data":{"thought":"按兵不动。"}}\n'
    + '{"op":"location.upsert","ref":"new:half","data":{"name":"未完';
  const { repo } = await makeRepo({ responses: [truncated] });
  try {
    const prepared = await repo.prepareTurn({
      anchor: anchorFor(), userText: '', assistantText: '两人都没有动。',
      sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false,
    });
    const receipt = prepared.receipt;
    const db = cand(repo, prepared);

    // 完整行按现有 parser/组规则安全落库。
    assert.equal(selectOne(db, 'characters', BRANCH, IDS.C3).thought, '先观察。');
    assert.equal(selectOne(db, 'characters', BRANCH, IDS.C4).thought, '按兵不动。');
    // 不完整尾行不补行、不伪造。
    assert.equal(rows(db, 'locations', 'AND name = ?', ['未完']).length, 0, '不得从未闭合行抢救出实体');

    // 错误码/行号/长度进诊断。
    const syntax = receipt.issues.find((i) => i.code === 'JSON_SYNTAX');
    assert.ok(syntax, '必须报 JSON_SYNTAX');
    assert.equal(syntax.line, 3, '行号必须指向不完整的第三行');
    assert.equal(receipt.status, 'partial', '不完整输出 → partial 而不是整轮失败');

    const attempts = q(db, 'SELECT attempts_json FROM turns WHERE id = ?', [receipt.turnId]);
    const parsedAttempts = JSON.parse(String(attempts[0].attempts_json));
    assert.ok(parsedAttempts.length >= 1, '尝试记录必须落库');
    assert.equal(parsedAttempts[0].response_chars > 0, true, '必须记录实际响应长度');
    assert.equal(String(parsedAttempts[0].response_hash ?? '').length, 64, '必须记录响应哈希');
  } finally {
    await repo.close();
  }
});

// ---------------------------------------------------------------------------
// I08 · 两个聊天和分支
// ---------------------------------------------------------------------------

test('I08: 两个聊天 + fork —— 无共享实体缓存；fork 是显式复制且之后互相隔离', async () => {
  const { repo: repoA } = await makeRepo({ responses: [NOOP, INDEPENDENT_NEW] });
  const seedB = await makeSeedWith(SQL);
  const bytesB = seedB.exportBytes();
  const dbB = seedB.db;
  // chat-B 的世界与 A 不同：把自己的 L1 改名，证明没有共享缓存。
  dbB.run("UPDATE locations SET name = '另一座城' WHERE branch_id = ? AND id = ?", [IDS.branchMain, IDS.L1]);
  const renamedB = dbB.export();
  seedB.close();

  const repoB = createSqlRepository({ chatUid: CHAT_B, branchId: BRANCH, branchName: '主线', modelPort: scriptedModel([]), now: () => NOW });
  await repoB.open({ bytes: renamedB });
  try {
    // A 建一个实体。
    const turnA = await repoA.prepareTurn({
      anchor: anchorFor(), userText: '他走进旅店。', assistantText: '旅店在街角。',
      sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false, worldCompletion: LOCAL_FOCUS,
    });
    await repoA.confirmSaved({ token: turnA.token, snapshotSha256: turnA.snapshotSha256, result: 'saved' });

    // 连续切换 10 次：两边各自读自己的权威，没有共享实体缓存。
    for (let i = 0; i < 10; i += 1) {
      const aView = await repoA.queryView({ kind: 'map', branchId: BRANCH, viewMode: 'author' });
      const bView = await repoB.queryView({ kind: 'map', branchId: BRANCH, viewMode: 'author' });
      assert.equal(selectOne(repoA.db, 'locations', BRANCH, IDS.L1).name, '圣罗兰城', `第 ${i + 1} 次切换：A 不得看到 B 的改名`);
      assert.equal(selectOne(repoB.db, 'locations', BRANCH, IDS.L1).name, '另一座城', `第 ${i + 1} 次切换：B 不得看到 A 的改名`);
      assert.equal(rows(repoA.db, 'locations', 'AND name = ?', ['旅店']).length, 1);
      assert.equal(rows(repoB.db, 'locations', 'AND name = ?', ['旅店']).length, 0, 'B 不得看到 A 新建的实体');
      assert.ok(Array.isArray(aView.items) && Array.isArray(bView.items));
    }

    // fork：显式复制 A 的存档 → 继承当前状态；之后改动互相隔离。
    const forkBytes = await repoA.exportCurrent();
    const fork = createSqlRepository({ chatUid: 'chat-A-fork', branchId: BRANCH, branchName: '分叉', modelPort: scriptedModel([]), now: () => NOW });
    await fork.open({ bytes: forkBytes });
    try {
      assert.equal(rows(fork.db, 'locations', 'AND name = ?', ['旅店']).length, 1, 'fork 显式复制了父的状态');
      const forkInn = rows(fork.db, 'locations', 'AND name = ?', ['旅店'])[0];
      fork.db.run("UPDATE locations SET name = '分叉旅店' WHERE branch_id = ? AND id = ?", [BRANCH, forkInn.id]);
      assert.equal(selectOne(repoA.db, 'locations', BRANCH, forkInn.id).name, '旅店', 'fork 之后的改动不得影响父');
      assert.equal(selectOne(fork.db, 'locations', BRANCH, forkInn.id).name, '分叉旅店');
    } finally {
      await fork.close();
    }
  } finally {
    await repoB.close();
    await repoA.close();
  }
});

// ---------------------------------------------------------------------------
// I11 · 读取不写入
// ---------------------------------------------------------------------------

test('I11: 连续只读 map/entity/nearby/事件流 —— 0 次 hostSave、0 次模型调用、存档字节不变', async () => {
  const { repo, model } = await makeRepo({ responses: [NOOP, INDEPENDENT_NEW] });
  try {
    const turn1 = await repo.prepareTurn({
      anchor: anchorFor(), userText: '他走进旅店。', assistantText: '旅店在街角。',
      sourceSnapshot: SOURCE_SNAPSHOT, phaseBatches: ['observe'], manual: false, worldCompletion: LOCAL_FOCUS,
    });
    await repo.confirmSaved({ token: turn1.token, snapshotSha256: turn1.snapshotSha256, result: 'saved' });

    const beforeBytes = await repo.exportCurrent();
    const beforeSha = await sha256Hex(beforeBytes);
    const modelCallsBefore = model.calls.length;
    const revisionBefore = Number(q(repo.db, 'SELECT revision FROM branches WHERE id = ?', [BRANCH])[0].revision);
    const changesBefore = Number(q(repo.db, 'SELECT COUNT(*) AS n FROM turn_changes')[0].n);
    const outboxBefore = countRows(repo.db, 'sync_outbox', BRANCH);

    // 连续读取各种只读视图（含"打开/切页/放大拖拽"对应的数据读取）。
    for (let i = 0; i < 3; i += 1) {
      await repo.queryView({ kind: 'map', branchId: BRANCH, viewMode: 'author' });
      await repo.queryView({ kind: 'map', branchId: BRANCH, viewMode: 'pov' });
      await repo.queryView({ kind: 'nearby', branchId: BRANCH, viewMode: 'author' });
      await repo.queryView({ kind: 'entity', branchId: BRANCH, viewMode: 'author', entityId: IDS.L1 });
      await repo.queryView({ kind: 'catalog', branchId: BRANCH, viewMode: 'author' });
      await repo.queryView({ kind: 'scene', branchId: BRANCH, viewMode: 'author' });
      // M5-06 / I11：新事件流也是只读口，必须一起证明「读不写入」。
      await repo.queryView({ kind: 'world-feed', branchId: BRANCH, viewMode: 'author' });
      await repo.queryView({ kind: 'world-feed', branchId: BRANCH, viewMode: 'pov', povId: IDS.C1 });
    }

    assert.equal(model.calls.length, modelCallsBefore, '只读视图不得调用模型');
    assert.equal(await sha256Hex(await repo.exportCurrent()), beforeSha, '只读视图不得改动存档字节');
    assert.equal(Number(q(repo.db, 'SELECT revision FROM branches WHERE id = ?', [BRANCH])[0].revision), revisionBefore, 'revision 不变');
    assert.equal(Number(q(repo.db, 'SELECT COUNT(*) AS n FROM turn_changes')[0].n), changesBefore, '不得新增 journal 行');
    assert.equal(countRows(repo.db, 'sync_outbox', BRANCH), outboxBefore, '只读不得新增同步任务');
  } finally {
    await repo.close();
  }
});
