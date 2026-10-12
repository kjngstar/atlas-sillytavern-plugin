/**
 * atlas-ref-required-catalogue.test.mjs — P08 / R05 必要引用与冻结目录（REF01–REF06）。
 *
 * 缺陷（R05）：合法必要引用掉出旧的定长截取目录后，真实前景/编译链拿不到 alias ——
 * 第 206 个人、第 51 张图都无法用真实 ID 更新/标定；而只改提示词目录也修不好，因为
 * 提示词目录与编译目录当时是**两次独立扫描**。
 *
 * 覆盖：
 * - REF01 206 人：排序末尾的主角仍能生成/编译真实 ID 更新，手动设置主角成功；
 * - REF02 51 张图：人工标定/确认坐标可解析，且 **没有** 抬高 maps 每表 50 条上限；
 * - REF03 同一批内：候选新增实体后 alias 不重编号，纠错沿用同一冻结目录与同一 ID；
 * - REF04 必要引用 513 项不可拆：发送次数 0、错误明确；
 * - REF05 超过 1,001 行可分页读到最后一项；缺失或其他分支 ID 仍被拒绝；
 * - REF06 程序注入的必需对象进入目录，但不让隐藏人物/地点出现在 POV 画面、诊断或导出。
 *
 * 全程走真实入口：handleSqlMapAction / runSqlTurn / scanKnownRefs / 只读视图导出。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';

import { makeSeedWith, IDS, insertRows } from './fixtures/atlas-sql/seed.mjs';
import { createRow } from '../src/atlas-db-defaults.ts';
import { encodeSnapshot } from '../src/atlas-db-envelope.ts';
import { createBrowserSqlHost } from '../src/atlas-browser-sql-host.ts';
import { loadAtlasSqlRuntime, runSqlTurn } from '../src/atlas-sql-session.ts';
import { handleSqlMapAction } from '../src/atlas-sql-map-actions.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { createTableReadPort, pageAllRows } from '../src/atlas-db-readport.ts';
import { collectKnownRefs, scanKnownRefs } from '../src/atlas-sql-refs.ts';
import { findByNameExact, findRowByIdPaged } from '../src/atlas-sql-ref-pages.ts';
import { projectReferenceData } from '../ui/atlas-reference-data.mjs';
import { buildMapAnalysisExport } from '../ui/atlas-map-export.mjs';

const SQL = await initSqlJs();
const BRANCH = IDS.branchMain;
const OTHER_BRANCH = IDS.branchB;
const TURN = IDS.seedTurn;

const ctx = (id) => ({ branchId: BRANCH, id, turnId: TURN, clockS: 0, nowWallMs: 1_700_000_000_000, rulesetVersion: 'atlas-1' });

const locationRow = (id, over = {}) => createRow('locations', { name: id, kind: 'building', ...over }, ctx(id));
const mapRow = (id, over = {}) => createRow('maps', { name: id, kind: 'interior', ...over }, ctx(id));
const characterRow = (id, over = {}) => createRow('characters', { name: id, ...over }, ctx(id));

/** 身份行必须先行（locations/characters/items 有 BEFORE INSERT 触发器校验 kind）。 */
function insertEntities(db, kind, table, rows) {
  insertRows(db, 'entity_keys', rows.map((row) => ({ branch_id: row.branch_id, id: row.id, kind })));
  insertRows(db, table, rows);
}

/**
 * 把 seed（可先做任意夹具改写）编码成存档信封，再经真实浏览器宿主开会话。
 * 这样既保留 seed 的合成实体，又拿到 handleSqlMapAction 需要的真实 SqlSession。
 */
async function openSeeded(chatUid, { setup, port = null, branchId = BRANCH } = {}) {
  const seed = await makeSeedWith(SQL);
  setup?.(seed.db);
  const bytes = seed.exportBytes();
  seed.close();
  const envelope = await encodeSnapshot(bytes, {
    chatUid, worldUid: `world_${chatUid}`, storageRevision: 0, activeBranchId: branchId,
  });
  const host = { chatUid, branchId, chatMetadata: { atlas: { database: envelope } }, saveMetadata: async () => true };
  const provider = createBrowserSqlHost({
    enabled: () => true, context: () => host, loadRuntime: loadAtlasSqlRuntime, modelPort: port,
  });
  const session = await provider.session(chatUid);
  return { provider, session, host, read: () => session.repo.db };
}

const aliasOf = (refs, id) => refs.find((ref) => ref.id === id)?.alias ?? null;

/* ------------------------------------------------------------------ *
 * REF01：206 人，排序末尾的主角
 * ------------------------------------------------------------------ */

const CHAR_COUNT = 206;
const LAST_NAME = `市民${String(CHAR_COUNT).padStart(3, '0')}`;
const FIRST_NAME = '市民001';

test('REF01 206 人排序末尾的主角仍能拿到 alias 并写入真实 ID；每次都不抬 characters 上限', async () => {
  const { provider, session, host, read } = await openSeeded('ref01', {
    setup: (db) => {
      const rows = [];
      for (let i = 1; i <= CHAR_COUNT; i += 1) {
        const n = String(i).padStart(3, '0');
        rows.push(characterRow(`CH_${n}`, { name: `市民${n}` }));
      }
      insertEntities(db, 'character', 'characters', rows);
    },
  });
  try {
    // 前置证据：旧口径（每表固定 200 条）确实看不到排序末尾的角色。
    const oldRefs = collectKnownRefs(createTableReadPort(read()), BRANCH);
    const oldCharacters = oldRefs.filter((ref) => ref.kind === 'character');
    assert.equal(oldCharacters.length, 200, '不得抬高 characters 每表 200 条上限');
    const lastRow = queryBound(read(), 'SELECT id FROM characters WHERE branch_id = ? AND name = ?', [BRANCH, LAST_NAME])[0];
    assert.ok(lastRow, '夹具必须造出第 206 个人');
    assert.equal(aliasOf(oldCharacters, String(lastRow.id)), null, '前置：旧目录里没有排序末尾的角色');

    // 必要引用追加后，同一个真实 ID 有了 alias，编号接在 200 之后。
    const scan = scanKnownRefs(createTableReadPort(read()), BRANCH, {
      requiredRefs: [{ kind: 'character', id: String(lastRow.id) }],
    });
    assert.equal(scan.requiredResolved, 1);
    assert.equal(aliasOf(scan.refs, String(lastRow.id)), 'C201', '必要引用必须接在旧上限之后，既有 alias 一个不动');

    // 第一次：把目录内的角色设为主角（旧实现也能过，作为对照）。
    const first = await handleSqlMapAction(session, 'map/protagonist', { chatId: host.chatUid, name: FIRST_NAME });
    assert.equal(first.coreSaved, true, JSON.stringify(first.issues));
    const firstId = String(queryBound(read(), 'SELECT id FROM characters WHERE branch_id = ? AND name = ?', [BRANCH, FIRST_NAME])[0].id);
    assert.equal(queryBound(read(), 'SELECT role FROM characters WHERE branch_id = ? AND id = ?', [BRANCH, firstId])[0].role, 'protagonist');

    // 第二次：把排序末尾的角色设为主角 —— 旧实现会在 ref() 上抛 REF_UNKNOWN。
    const last = await handleSqlMapAction(session, 'map/protagonist', { chatId: host.chatUid, name: LAST_NAME });
    assert.equal(last.coreSaved, true, JSON.stringify(last.issues));
    const lastId = String(lastRow.id);
    assert.equal(queryBound(read(), 'SELECT role FROM characters WHERE branch_id = ? AND id = ?', [BRANCH, lastId])[0].role, 'protagonist',
      '末尾角色必须按真实 ID 更新为主角');
    assert.equal(queryBound(read(), 'SELECT role FROM characters WHERE branch_id = ? AND id = ?', [BRANCH, firstId])[0].role, 'npc',
      '旧主角必须按真实 ID 被降级');
    assert.equal(queryBound(read(), 'SELECT pov_character_id FROM branches WHERE id = ?', [BRANCH])[0].pov_character_id !== null, true);
  } finally {
    await provider.close();
  }
});

/* ------------------------------------------------------------------ *
 * REF02：第 51 张图
 * ------------------------------------------------------------------ */

const MAP_COUNT = 51;
const TARGET_MAP = 'ZMAP_051';
const TARGET_CONTAINER = 'ZCON_051';
const TARGET_ROOM = 'ZROOM';

function manyMapsSetup(db) {
  const locations = [];
  const maps = [];
  for (let i = 1; i <= MAP_COUNT; i += 1) {
    const n = String(i).padStart(3, '0');
    const container = `ZCON_${n}`;
    // 容器地点没有 map_id 时 grid 必须同为 null、精度只能 unknown（表级 CHECK）。
    locations.push(locationRow(container, { map_id: null, grid_x: null, grid_y: null, coord_precision: 'unknown', uncertainty_radius_cells: null }));
    maps.push(mapRow(`ZMAP_${n}`, {
      name: `场地图 ${n}`, container_location_id: container,
      frame_json: JSON.stringify({ origin_x: 0, origin_y: 0, reference_width_cells: 20, reference_height_cells: 15 }),
    }));
  }
  locations.push(locationRow(TARGET_ROOM, { kind: 'room', parent_location_id: TARGET_CONTAINER, map_id: TARGET_MAP, grid_x: 1, grid_y: 1, coord_precision: 'approximate' }));
  // 外键顺序：先落地点（parent/map 指向未存在行的列先用 null），再落地图，最后回填。
  // 注意 `CHECK (grid_x IS NULL OR map_id IS NOT NULL)`：map_id 为 null 时 grid 必须同为 null。
  insertRows(db, 'entity_keys', locations.map((row) => ({ branch_id: BRANCH, id: row.id, kind: 'location' })));
  insertRows(db, 'locations', locations.map((row) => ({
    ...row, parent_location_id: null, map_id: null, grid_x: null, grid_y: null, coord_precision: 'unknown', uncertainty_radius_cells: null,
  })));
  insertRows(db, 'maps', maps);
  for (const row of locations) {
    db.run('UPDATE locations SET parent_location_id = ?, map_id = ?, grid_x = ?, grid_y = ?, coord_precision = ?, uncertainty_radius_cells = ? WHERE branch_id = ? AND id = ?', [
      row.parent_location_id, row.map_id, row.grid_x ?? null, row.grid_y ?? null, row.coord_precision, row.uncertainty_radius_cells ?? null, BRANCH, row.id,
    ]);
  }
}

test('REF02 第 51 张图的人工标定与坐标确认可解析，且 maps 每表上限仍是 50', async () => {
  const calls = [];
  const { provider, session, host, read } = await openSeeded('ref02', {
    setup: manyMapsSetup,
    port: { async request(req) { calls.push(req.batchId); throw new Error('REF02 不应发模型请求'); } },
  });
  try {
    const mapIds = queryBound(read(), 'SELECT id FROM maps WHERE branch_id = ? ORDER BY id ASC', [BRANCH]).map((row) => String(row.id));
    assert.ok(mapIds.includes(TARGET_MAP), '夹具必须造出第 51 张图');
    assert.ok(mapIds.length > 50);

    // 前置证据：旧目录（每表 maps 50 条）里没有第 51 张图 —— 旧实现的 ref(m.id) 必然 REF_UNKNOWN。
    const oldRefs = collectKnownRefs(createTableReadPort(read()), BRANCH);
    const oldMaps = oldRefs.filter((ref) => ref.kind === 'map');
    assert.equal(oldMaps.length, 50, '不得抬高 maps 每表 50 条上限');
    assert.equal(aliasOf(oldMaps, TARGET_MAP), null, '前置：旧目录确实漏掉第 51 张图');

    // 人工标定（不调模型）：第 51 张图必须能解析并写入。
    const scale = await handleSqlMapAction(session, 'map/scale', { chatId: host.chatUid, mapId: TARGET_MAP, userMetersPerCell: 2 });
    assert.equal(scale.coreSaved, true, JSON.stringify(scale.issues));
    assert.equal(Number(queryBound(read(), 'SELECT meters_per_cell FROM maps WHERE branch_id = ? AND id = ?', [BRANCH, TARGET_MAP])[0].meters_per_cell), 2);

    // 坐标确认走 alias（ref(m.id)）：旧实现会在这里抛 REF_UNKNOWN。
    const coords = await handleSqlMapAction(session, 'map/topology', {
      chatId: host.chatUid, operation: 'confirm-coordinate', locationId: TARGET_ROOM, mapId: TARGET_MAP, gridX: 3, gridY: 4,
    });
    assert.equal(coords.coreSaved, true, JSON.stringify(coords.issues));
    const room = queryBound(read(), 'SELECT map_id, grid_x, grid_y, coord_precision FROM locations WHERE branch_id = ? AND id = ?', [BRANCH, TARGET_ROOM])[0];
    assert.equal(String(room.map_id), TARGET_MAP);
    assert.equal(Number(room.grid_x), 3);
    assert.equal(Number(room.grid_y), 4);
    assert.equal(room.coord_precision, 'exact');
    assert.deepEqual(calls, [], '人工路径不得发送模型请求');
  } finally {
    await provider.close();
  }
});

/* ------------------------------------------------------------------ *
 * REF03：同一批内的冻结目录
 * ------------------------------------------------------------------ */

/** 从提示词/纠错文本里取某个名字对应的 alias（`C1=艾琳（character）` 形式）。 */
function aliasForName(text, name) {
  const match = text.match(new RegExp(`([A-Z]\\d+)=${name}（`));
  return match ? match[1] : null;
}

test('REF03 同批新增实体后 alias 不重编号：提示词、编译、纠错共用同一 ID', async () => {
  const prompts = [];
  const port = {
    async request(req) {
      const content = `${req.promptInput?.injectionText ?? ''}\n${req.messages?.[1]?.content ?? ''}`;
      prompts.push({ batchId: req.batchId, phase: req.phase, content });
      if (req.phase === 'repair') {
        // 纠错只能沿用原冻结目录：alias 必须与首批提示词里的一致。
        const alias = aliasForName(content, '教室');
        const ticket = (content.match(/\{"ticket":"(R\d+)","op":"location\.upsert"/) ?? [])[1] ?? 'R1';
        return {
          batchId: req.batchId,
          text: alias ? JSON.stringify({ ticket, op: 'location.upsert', ref: alias, data: { description: '纠错成功' } }) : '{"op":"noop"}',
          httpStatus: 200, finishReason: 'stop',
        };
      }
      const alias = aliasForName(content, '教室');
      return {
        batchId: req.batchId,
        text: [
          // 五个新建角色：让候选库在首批之后真的多出行来（alias 编号最容易在这里漂移）。
          ...Array.from({ length: 5 }, (_, index) => JSON.stringify({ op: 'character.upsert', ref: `new:extra${index}`, data: { name: `新面孔${index}`, identity: '测试人物' } })),
          // 一个必然被拒的操作（kind 非法），用来触发同批纠错。
          JSON.stringify({ op: 'location.upsert', ref: alias ?? 'L1', data: { kind: 'spaceship' } }),
        ].join('\n'),
        httpStatus: 200,
        finishReason: 'stop',
      };
    },
  };
  const { provider, session, read } = await openSeeded('ref03', { port });
  try {
    const result = await runSqlTurn(session, {
      anchor: {
        chatUid: 'ref03', branchId: BRANCH, parentTurnId: TURN, hostMessageUid: 'ref03',
        variantKey: 'v1', baseRevision: 0, baseStorageRevision: 0, inputHash: 'ref03',
      },
      userText: '甲在城里走动。', assistantText: '甲走进城里。', sourceSnapshot: [],
      phaseBatches: ['observe'], manual: false, sceneMaps: false, sceneOnly: true,
    });

    const initial = prompts.find((prompt) => prompt.phase !== 'repair');
    assert.ok(initial, '必须发出观察批次');
    const initialAlias = aliasForName(initial.content, '教室');
    assert.match(String(initialAlias), /^L\d+$/, `提示词里必须有可解析的 alias：${initial.content}`);

    const repair = prompts.find((prompt) => prompt.phase === 'repair');
    assert.ok(repair, '被拒操作必须触发同批纠错');
    const repairAlias = aliasForName(repair.content, '教室');
    assert.equal(repairAlias, initialAlias, '同批新增实体不得让 alias 重编号');
    // 纠错文本里必须同时出现**新增实体之后**的 alias 与同一真实 ID 的旧 alias。
    assert.match(repair.content, /extra0=新面孔0（character）/, `纠错目录必须带上首批已声明的对象：${repair.content.slice(-400)}`);

    // 纠错用同一 alias 写进了真实 ID：教室这一行必须真的被改。
    const room = queryBound(read(), 'SELECT id, description FROM locations WHERE branch_id = ? AND name = ?', [BRANCH, '教室'])[0];
    assert.equal(String(room.description), '纠错成功', '纠错必须落到真实 ID 上');
    assert.equal(queryBound(read(), 'SELECT COUNT(*) n FROM characters WHERE branch_id = ? AND name LIKE ?', [BRANCH, '新面孔%'])[0].n, 5, '首批新增的实体必须保留');
    assert.equal(result.coreSaved, true, JSON.stringify(result.issues));
  } finally {
    await provider.close();
  }
});

/* ------------------------------------------------------------------ *
 * REF04：必要引用 513 项
 * ------------------------------------------------------------------ */

const REQUIRED_OVER_BUDGET = 513;

test('REF04 必要引用 513 项不可拆：发送次数 0，错误明确，不删必要项凑数', async () => {
  const calls = [];
  const requiredIds = [];
  const { provider, session } = await openSeeded('ref04', {
    setup: (db) => {
      const rows = [];
      for (let i = 1; i <= REQUIRED_OVER_BUDGET; i += 1) {
        const id = `RQ_${String(i).padStart(3, '0')}`;
        requiredIds.push(id);
        rows.push(locationRow(id, { kind: 'city' }));
      }
      insertEntities(db, 'location', 'locations', rows);
    },
    port: { async request(req) { calls.push(req.batchId); return { batchId: req.batchId, text: '{"op":"noop"}', httpStatus: 200, finishReason: 'stop' }; } },
  });
  try {
    let failure = null;
    try {
      await runSqlTurn(session, {
        anchor: {
          chatUid: 'ref04', branchId: BRANCH, parentTurnId: TURN, hostMessageUid: 'ref04',
          variantKey: 'v1', baseRevision: 0, baseStorageRevision: 0, inputHash: 'ref04',
        },
        userText: '整理必要引用。', assistantText: '整理完成。', sourceSnapshot: [],
        phaseBatches: ['observe'], manual: false, sceneMaps: false, sceneOnly: true,
        requiredRefs: requiredIds.map((id) => ({ kind: 'location', id })),
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, '必要引用超预算时本轮不能假装成功');
    const issues = failure.detail?.receipt?.issues ?? [];
    const budgetIssue = issues.find((item) => item.code === 'REF_REQUIRED_BUDGET_EXCEEDED');
    assert.ok(budgetIssue, `必须明确报 REF_REQUIRED_BUDGET_EXCEEDED，实际 ${JSON.stringify(issues)}`);
    assert.equal(budgetIssue.retryable, false);
    assert.deepEqual(calls, [], '必要引用装不下时发送次数必须是 0');
  } finally {
    await provider.close();
  }
});

/* ------------------------------------------------------------------ *
 * REF05：分页、缺失与他分支
 * ------------------------------------------------------------------ */

const PAGE_ROWS = 1100;

test('REF05 超过 1,001 行可分页读到最后一项；缺失或其他分支 ID 仍被拒绝', async () => {
  const seed = await makeSeedWith(SQL);
  const rows = [];
  for (let i = 1; i <= PAGE_ROWS; i += 1) rows.push(characterRow(`PG_${String(i).padStart(4, '0')}`, { name: `市民${i}` }));
  insertEntities(seed.db, 'character', 'characters', rows);
  insertRows(seed.db, 'entity_keys', [{ branch_id: OTHER_BRANCH, id: 'FOREIGN_CH', kind: 'character' }]);
  insertRows(seed.db, 'characters', [createRow('characters', { name: '他分支角色' }, { ...ctx('FOREIGN_CH'), branchId: OTHER_BRANCH, turnId: IDS.seedTurnB })]);
  const port = createTableReadPort(seed.db);

  // 固定上限仍然存在：一次 selectWhere 看不到最后一项。
  const capped = port.selectWhere('characters', { branch_id: BRANCH, status: 'active' }, 1000);
  assert.equal(capped.length, 1000, 'selectWhere 的 1,001 行硬上限不得被抬高');

  const all = pageAllRows(port, 'characters', BRANCH, 500);
  assert.ok(all.length >= PAGE_ROWS, `分页必须能读完 ${PAGE_ROWS} 行，实际 ${all.length}`);
  const last = all[all.length - 1];
  assert.equal(String(last.name), `市民${PAGE_ROWS}`);
  assert.ok(!capped.some((row) => String(row.id) === String(last.id)), '前置：旧口径确实读不到最后一项');

  assert.equal(String(findRowByIdPaged(port, 'characters', BRANCH, String(last.id))?.name), `市民${PAGE_ROWS}`);
  assert.equal(findRowByIdPaged(port, 'characters', BRANCH, 'PG_NOT_EXIST'), null, '不存在的 ID 必须返回 null');
  assert.equal(findRowByIdPaged(port, 'characters', BRANCH, 'FOREIGN_CH'), null, '其他分支的 ID 必须被拒绝');
  assert.deepEqual(findByNameExact(port, 'characters', BRANCH, `市民${PAGE_ROWS}`).ids, [String(last.id)]);

  const scan = scanKnownRefs(port, BRANCH, {
    requiredRefs: [
      { kind: 'character', id: 'PG_NOT_EXIST' },
      { kind: 'character', id: 'FOREIGN_CH' },
      { kind: 'character', id: String(last.id) },
    ],
  });
  assert.equal(scan.requiredResolved, 1, '只有真实存在且在本分支的必要引用才算解析成功');
  assert.deepEqual(scan.missingRequired.map((item) => item.id).sort(), ['FOREIGN_CH', 'PG_NOT_EXIST']);
  assert.ok(!scan.refs.some((ref) => ref.id === 'PG_NOT_EXIST' || ref.id === 'FOREIGN_CH'), '缺失/他分支 ID 绝不进目录');
});

/* ------------------------------------------------------------------ *
 * REF06：必要对象进目录，但不进 POV
 * ------------------------------------------------------------------ */

const SECRET_LOCATION = 'ZL_SECRET_DEN';
const SECRET_CHARACTER = 'ZC_SECRET_ONE';
/** 填充实体数量：让秘密对象排在每表 200/50 条窗口之外（真正的 R05 场景）。 */
const FILLER_COUNT = 205;

test('REF06 程序注入的必需对象进入目录，但不让隐藏地点/人物出现在 POV 画面、诊断或导出', async () => {
  const { provider, session, host, read } = await openSeeded('ref06', {
    setup: (db) => {
      const locations = [];
      for (let i = 1; i <= FILLER_COUNT; i += 1) {
        const n = String(i).padStart(3, '0');
        locations.push(locationRow(`FL_${n}`, { name: `填充地点${n}`, kind: 'city', map_id: IDS.M1, grid_x: 1, grid_y: 1, coord_precision: 'approximate' }));
      }
      locations.push(locationRow(SECRET_LOCATION, { name: '秘密据点', kind: 'building', parent_location_id: IDS.L2, map_id: IDS.M1, grid_x: 8, grid_y: 8, coord_precision: 'approximate' }));
      insertEntities(db, 'location', 'locations', locations);

      const characters = [];
      for (let i = 1; i <= FILLER_COUNT; i += 1) {
        const n = String(i).padStart(3, '0');
        characters.push(characterRow(`FC_${n}`, { name: `填充人物${n}`, location_id: IDS.L2, map_id: IDS.M1 }));
      }
      characters.push(characterRow(SECRET_CHARACTER, { name: '秘密人物', location_id: IDS.L3, map_id: IDS.M2 }));
      insertEntities(db, 'character', 'characters', characters);
    },
    port: { async request() { throw new Error('REF06 不应发模型请求'); } },
  });
  try {
    const port = createTableReadPort(read());
    // 前置：旧目录里没有这两个必要对象 —— 旧实现的 ref() 会直接抛 REF_UNKNOWN。
    const oldRefs = collectKnownRefs(port, BRANCH);
    assert.equal(aliasOf(oldRefs, SECRET_LOCATION), null, '前置：秘密地点确实掉在旧目录之外');
    assert.equal(aliasOf(oldRefs, SECRET_CHARACTER), null, '前置：秘密人物确实掉在旧目录之外');
    const appended = scanKnownRefs(port, BRANCH, {
      requiredRefs: [{ kind: 'location', id: SECRET_LOCATION }, { kind: 'character', id: SECRET_CHARACTER }],
    });
    assert.equal(appended.requiredResolved, 2, '程序声明的必要对象必须无条件进目录');
    assert.ok(aliasOf(appended.refs, SECRET_LOCATION));
    assert.ok(aliasOf(appended.refs, SECRET_CHARACTER));

    // 作者纠偏：把秘密人物移进秘密据点（声明两个必要引用，且不改变 POV 可见性）。
    const moved = await handleSqlMapAction(session, 'map/move', { chatId: host.chatUid, entityId: SECRET_CHARACTER, toPointId: SECRET_LOCATION });
    assert.equal(moved.coreSaved, true, JSON.stringify(moved.issues));
    assert.equal(String(queryBound(read(), 'SELECT location_id FROM characters WHERE branch_id = ? AND id = ?', [BRANCH, SECRET_CHARACTER])[0].location_id), SECRET_LOCATION);
    const diagnostics = JSON.stringify(moved.issues);
    assert.doesNotMatch(diagnostics, /秘密/, `作者阶段诊断不得回显隐藏对象：${diagnostics}`);

    // POV：隐藏对象一个字节都不能出现在画面、导出里。
    const povName = String(queryBound(read(), 'SELECT pov_character_id FROM branches WHERE id = ?', [BRANCH])[0].pov_character_id ?? '');
    const povView = async (kind) => session.repo.queryView({ kind, branchId: BRANCH, viewMode: 'pov', povId: povName });
    const povMap = await povView('map');
    const povScene = await povView('scene');
    const povCatalog = await povView('catalog');
    const povData = projectReferenceData({ mapView: povMap, sceneView: povScene, catalogView: povCatalog, viewMode: 'pov' });
    const povExport = buildMapAnalysisExport({ data: povData, mapView: povMap, sceneView: povScene, catalogView: povCatalog, mapId: IDS.M1, exportedAt: '2026-10-11T00:00:00Z' });
    const povJson = JSON.stringify(povExport);
    for (const secret of [SECRET_LOCATION, SECRET_CHARACTER, '秘密据点', '秘密人物']) {
      assert.doesNotMatch(povJson, new RegExp(secret), `POV 导出不得包含 ${secret}`);
    }
    assert.doesNotMatch(JSON.stringify(povData), /秘密/, 'POV 画面数据不得包含隐藏对象');

    // 作者视图仍然要能看到它们（可证明过滤只对 POV 生效，而不是被整体删掉）。
    const authorMap = await session.repo.queryView({ kind: 'map', branchId: BRANCH, viewMode: 'author' });
    assert.match(JSON.stringify(authorMap), /秘密据点/, '作者视图必须仍能看到作者刚纠偏的秘密地点');
  } finally {
    await provider.close();
  }
});
