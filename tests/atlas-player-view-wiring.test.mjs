/**
 * atlas-player-view-wiring.test.mjs — P08 §14 的**接线**证据（不是纯函数自证）。
 *
 * 前面 atlas-player-view-scope.test.mjs 证明决策层说得对；这里证明它真的接进了查询链：
 * 1. 玩家地图出现主角不知道的地点，POV 地图不出现（§14.1/§14.2）。
 * 2. 玩家人物详情与近邻列表有已记录行动、没有后台想法；作者两者都有（§14.6/§14.7）。
 * 3. 玩家状态页把 thought 清零但保留 actionTendency，并自报 viewScope（§14.9）。
 * 4. 这些读取不改库、不写 knowledge、不产生事件（§14.3）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { makeSeedWith, insertRows, IDS } from './fixtures/atlas-sql/seed.mjs';
import { createRow } from '../src/atlas-db-defaults.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { queryMapView, queryNearby, queryEntityDetail } from '../src/atlas-db-views.ts';
import { querySqlSceneState } from '../src/atlas-sql-view-state.ts';
import { visibleWorkbenchMaps } from '../ui/atlas-workbench-data.mjs';

const SQL = await initSqlJs();

const SECRET = 'L_SECRET';

/** 一间接主角从没去过、也没听说过的密室：用来区分「完整世界」与「主角所知」。 */
async function fixture() {
  const { db } = await makeSeedWith(SQL);
  // 地点必须先有 entity_keys 身份行，否则触发器直接拒绝（schema 里的 ENTITY_KEY_KIND_MISMATCH）。
  insertRows(db, 'entity_keys', [{ branch_id: IDS.branchMain, id: SECRET, kind: 'location' }]);
  insertRows(db, 'locations', [createRow('locations', {
    name: '锁着的密室', kind: 'room', parent_location_id: IDS.L2, map_id: IDS.M1,
    grid_x: 13, grid_y: 12, coord_precision: 'exact', existence_quality: 'hypothetical',
  }, { branchId: IDS.branchMain, id: SECRET, turnId: IDS.seedTurn, clockS: 0, nowWallMs: 1, rulesetVersion: 'atlas-1' })]);
  db.run("UPDATE characters SET thought='他怀疑艾琳在说谎', action_tendency='在门口来回踱步' WHERE branch_id=? AND id=?", [IDS.branchMain, IDS.C2]);
  const ctx = (viewMode) => ({ db, branchId: IDS.branchMain, revision: 0, viewMode, povId: IDS.C1 });
  return { db, ctx };
}

const pointIds = (view) => (view.items ?? []).flatMap((item) => (item.points ?? []).map((point) => String(point.entityId)));

test('P08 接线：玩家地图有主角不知道的密室，POV 地图没有', async () => {
  const f = await fixture();
  try {
    const player = queryMapView(f.ctx('player'), { kind: 'map', branchId: IDS.branchMain, viewMode: 'player' });
    const pov = queryMapView(f.ctx('pov'), { kind: 'map', branchId: IDS.branchMain, viewMode: 'pov' });
    assert.ok(pointIds(player).includes(SECRET), '玩家看完整已记录世界：密室必须画出来');
    assert.equal(pointIds(pov).includes(SECRET), false, 'POV 只画主角知道的：密室不许出现');
    assert.ok(pointIds(player).length > pointIds(pov).length, 'POV 的图是玩家的真子集');
  } finally { f.db.close(); }
});

test('P08 接线：玩家人物详情保留已记录行动，去掉后台想法；作者两者都有', async () => {
  const f = await fixture();
  try {
    const detail = (viewMode) => queryEntityDetail(f.ctx(viewMode), { kind: 'entity', branchId: IDS.branchMain, entityId: IDS.C2, entityKind: 'character' }).items[0].character;
    const player = detail('player');
    assert.equal(player.thought, undefined, '§14.7 后台想法不进玩家详情');
    assert.equal(player.importance_reason, undefined, '重要性理由属于作者账本');
    assert.equal(player.action_tendency, '在门口来回踱步', '§14.6 已记录行动必须可查');
    assert.equal(player.name, '信使');
    const author = detail('author');
    assert.equal(author.thought, '他怀疑艾琳在说谎', '作者后台照样能看到后台想法');
    assert.equal(author.action_tendency, '在门口来回踱步');
  } finally { f.db.close(); }
});

test('P08 接线：近邻列表在玩家作用域给行动、不给想法；POV 两个都不给', async () => {
  const f = await fixture();
  try {
    f.db.run('UPDATE characters SET location_id=? WHERE branch_id=? AND id=?', [IDS.L2, IDS.branchMain, IDS.C1]);
    f.db.run('UPDATE characters SET location_id=? WHERE branch_id=? AND id=?', [IDS.L2, IDS.branchMain, IDS.C2]);
    const nearby = (viewMode) => queryNearby(f.ctx(viewMode), { kind: 'nearby', branchId: IDS.branchMain, viewMode, entityId: IDS.C1, limit: 50 })
      .items.find((entry) => String(entry.entityId) === IDS.C2);
    const player = nearby('player');
    assert.equal(player.actionTendency, '在门口来回踱步');
    assert.equal(player.thought, undefined, '玩家不给后台想法');
    const author = nearby('author');
    assert.equal(author.thought, '他怀疑艾琳在说谎');
    const pov = nearby('pov');
    assert.equal(pov.actionTendency, undefined, 'POV 连行动倾向都不下发');
    assert.equal(pov.thought, undefined);
  } finally { f.db.close(); }
});

test('P08 接线：状态页自报作用域，玩家 npcDirectory 没有思想但有行动', async () => {
  const f = await fixture();
  try {
    const state = (viewMode) => querySqlSceneState(f.ctx(viewMode), { chatUid: IDS.chatA, worldUid: 'world-A', worldName: '合成世界' });
    const player = state('player');
    assert.equal(player.viewScope, 'player', '§14.9 作用域随状态下发，UI 不用猜');
    const npc = player.npcDirectory.find((entry) => entry.id === IDS.C2);
    assert.equal(npc.thought, '', '玩家视图的 thought 必须是空字符串而不是残留正文');
    assert.equal(npc.actionTendency, '在门口来回踱步');
    assert.equal(npc.currentAction, '在门口来回踱步');
    const author = state('author');
    assert.equal(author.viewScope, 'author');
    assert.equal(author.npcDirectory.find((entry) => entry.id === IDS.C2).thought, '他怀疑艾琳在说谎');
    const pov = state('pov');
    assert.equal(pov.viewScope, 'pov', '内部 pov 作用域仍然可表达');
  } finally { f.db.close(); }
});

test('P08 接线：玩家读地图不写库、不新增 knowledge、不改事件', async () => {
  const f = await fixture();
  try {
    const count = (table) => Number(queryBound(f.db, `SELECT COUNT(*) AS n FROM ${table} WHERE branch_id=?`, [IDS.branchMain])[0].n);
    const knowledge = count('knowledge'), events = count('events'), revisions = Number(queryBound(f.db, 'SELECT revision FROM branches WHERE id=?', [IDS.branchMain])[0].revision);
    const before = Buffer.from(f.db.export());
    for (let i = 0; i < 10; i += 1) {
      queryMapView(f.ctx('player'), { kind: 'map', branchId: IDS.branchMain, viewMode: 'player' });
      queryEntityDetail(f.ctx('player'), { kind: 'entity', branchId: IDS.branchMain, entityId: SECRET, entityKind: 'location' });
    }
    assert.deepEqual(Buffer.from(f.db.export()), before, '§14.3 看地图不写库');
    assert.equal(count('knowledge'), knowledge, '§14.3 地图可见不写 knowledge/visited/received');
    assert.equal(count('events'), events);
    assert.equal(Number(queryBound(f.db, 'SELECT revision FROM branches WHERE id=?', [IDS.branchMain])[0].revision), revisions);
  } finally { f.db.close(); }
});

test('P08 接线：UI 侧玩家作用域拿到全部地图，不再按主角探索裁图', () => {
  const rows = [
    { mapId: 'M1', containerLocationId: null, points: [] },
    { mapId: 'M_SECRET', containerLocationId: 'L_SECRET', containerLocationKind: null, points: [] },
  ];
  assert.equal(visibleWorkbenchMaps(rows, 'player').length, 2, '玩家视图不裁图');
  assert.equal(visibleWorkbenchMaps(rows, 'author').length, 2);
  assert.equal(visibleWorkbenchMaps(rows, 'pov').length, 1, 'POV 才按已知容器裁图');
});
