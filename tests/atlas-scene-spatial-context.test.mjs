/**
 * atlas-scene-spatial-context.test.mjs — P10 §16.3 接线证据。
 *
 * 这里不测纯函数（那是 atlas-scene-entry.test.mjs 的事），只测**真实链路**：
 * SQL 里的地点链 / 地图帧 / 空间 canonical → `buildPovSceneLines` → `renderSqlSceneContext` 的正文行。
 *
 * 要证明的四件事：
 * 1. 书架带真实占地进入注入文本（米→格换算过），不是一句「有书架」。
 * 2. 只注入当前地点，别的房间（含秘密房间）的名字不泄漏。
 * 3. 布局没保存时只说「未就绪」，不编造家具与尺寸。
 * 4. 零请求：这条路径不写库、不发模型。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { makeSeedWith, insertRows, IDS } from './fixtures/atlas-sql/seed.mjs';
import { createRow } from '../src/atlas-db-defaults.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { buildPovSceneLines, renderSqlSceneContext } from '../src/atlas-db-knowledge-view.ts';
import { readActorSceneFacts, summarizeSceneFacts } from '../src/atlas-scene-facts.ts';

const SQL = await initSqlJs();
const SECRET = 'L_SECRET';
const FRAME_KEY = 'atlasSpaceCanonical';

/** 教室 M2 的空间权威：一张 6×4 米的房间 + 书架 / 玻璃隔断 / 木门。 */
const canonical = {
  version: 1,
  locationId: IDS.L3,
  revision: 1,
  size: { widthM: 6, heightM: 4 },
  // localId 必须是 `space:<locationId>:furn:<id>`，否则空间账本整条丢弃（SPACE_FURNISHING_INVALID）。
  furnishing: [
    { localId: `space:${IDS.L3}:furn:F1`, type: 'shelf', name: '书架', itemId: null, widthM: 3, heightM: 1, quality: 'confirmed' },
    { localId: `space:${IDS.L3}:furn:G1`, type: 'partition', name: '玻璃隔断', itemId: null, widthM: 2, heightM: 0.2, quality: 'confirmed' },
    { localId: `space:${IDS.L3}:furn:D1`, type: 'door', name: '木门', itemId: null, widthM: 1, heightM: 0.2, quality: 'confirmed' },
  ],
};

async function fixture({ withCanonical = true, withScene = true } = {}) {
  const { db } = await makeSeedWith(SQL);
  // 主角走进教室，并把教室作为「当前地点」。
  db.run('UPDATE characters SET location_id=?, map_id=?, grid_x=?, grid_y=?, coord_precision=? WHERE branch_id=? AND id=?',
    [IDS.L3, IDS.M2, 5, 6, 'exact', IDS.branchMain, IDS.C1]);
  // 门后藏一个主角没去过的密室：它的名字绝不能出现在正文注入里。
  insertRows(db, 'entity_keys', [{ branch_id: IDS.branchMain, id: SECRET, kind: 'location' }]);
  insertRows(db, 'locations', [createRow('locations', {
    name: '无人知晓的密室', kind: 'room', parent_location_id: IDS.L2, map_id: IDS.M2,
    grid_x: 1, grid_y: 1, coord_precision: 'exact',
  }, { branchId: IDS.branchMain, id: SECRET, turnId: IDS.seedTurn, clockS: 0, nowWallMs: 1, rulesetVersion: 'atlas-1' })]);
  if (withCanonical) {
    const frame = withScene ? { [FRAME_KEY]: canonical, atlasScene: { kind: 'atlas-scene', version: 1, mapId: IDS.M2 } } : { [FRAME_KEY]: canonical };
    // M2 的 scale_min 是 1：把 meters_per_cell 设成 0.5 会违反 CHECK，所以沿用 1 米/格。
    db.run('UPDATE maps SET frame_json=?, meters_per_cell=? WHERE branch_id=? AND id=?', [JSON.stringify(frame), 1, IDS.branchMain, IDS.M2]);
  } else {
    db.run('UPDATE maps SET frame_json=?, meters_per_cell=? WHERE branch_id=? AND id=?', ['{}', null, IDS.branchMain, IDS.M2]);
  }
  const world = { db, branchId: IDS.branchMain };
  return { db, world };
}

const position = { kind: 'at_grid', precision: 'exact' };

test('T-S07/T-S16 real SQL coordinates and saved shelf geometry survive narration and NPC projection', async () => {
  const f = await fixture();
  try {
    const frame = JSON.parse(String(queryBound(f.db, 'SELECT frame_json FROM maps WHERE branch_id=? AND id=?', [IDS.branchMain, IDS.M2])[0].frame_json));
    frame.atlasScene = { kind: 'atlas-scene', version: 1, generator: 'fixture', mapId: IDS.M2, branchId: IDS.branchMain, sourceRevision: 0,
      units: 'meters', metersPerCell: 1, metricQuality: 'estimated', layout: { kind: 'floor', bounds: { x: 0, y: 0, w: 20, h: 20 },
        furniture: [{ id: `space:${IDS.L3}:furn:F1`, roomId: IDS.L3, x: 7, y: 4, w: 3, h: 1 }] } };
    f.db.run('UPDATE maps SET frame_json=? WHERE branch_id=? AND id=?', [JSON.stringify(frame), IDS.branchMain, IDS.M2]);
    const before = renderSqlSceneContext(f.world);
    assert.match(before, /坐标 \(5, 6\) 格/);
    assert.match(before, /坐标 \(7, 4\) 米/);
    assert.match(before, new RegExp(`frame=${IDS.M2}`));
    assert.match(before, /不挡视线/);
    f.db.run('UPDATE characters SET grid_x=15,grid_y=16 WHERE branch_id=? AND id=?', [IDS.branchMain, IDS.C1]);
    const after = renderSqlSceneContext(f.world);
    assert.notEqual(before, after);
    assert.match(after, /坐标 \(15, 16\) 格/);
    const facts = readActorSceneFacts(f.world, { actorId: IDS.C1, locationId: IDS.L3, position: { ...position, mapId: IDS.M2, x: 15, y: 16 } });
    const npc = summarizeSceneFacts(facts.context);
    const shelf = npc.blockers.find(entry => entry.objectId.endsWith(':F1'));
    assert.deepEqual(shelf.geometry, { mapId: IDS.M2, units: 'meters', x: 7, y: 4, width: 3, height: 1, rotation: null });
    assert.deepEqual(shelf.footprintMeters, { widthM: 3, heightM: 1 });
    frame.atlasScene.layout.furniture[0].hidden = true;
    f.db.run('UPDATE maps SET frame_json=? WHERE branch_id=? AND id=?', [JSON.stringify(frame), IDS.branchMain, IDS.M2]);
    assert.equal(renderSqlSceneContext(f.world).includes('书架'), false, 'explicitly hidden object is removed by the actor projection');
  } finally { f.db.close(); }
});

test('P10 接线：正文注入拿到地点链、真实占地与门', async () => {
  const f = await fixture();
  try {
    const { lines } = buildPovSceneLines(f.world, { povId: IDS.C1, locationId: IDS.L3, position });
    const joined = lines.join('\n');
    assert.match(joined, /所在地点：圣罗兰城 › 圣光学校 › 教室/, '地点链要完整');
    assert.match(joined, /书架（3×1 米/, '关键家具必须带真实占地');
    assert.match(joined, /玻璃隔断/, '玻璃隔断要在场');
    assert.match(joined, /可观察入口：木门/, '入口单独一行');
    assert.match(joined, /约每格 1 米/, '尺度用「约」表达');
  } finally { f.db.close(); }
});

test('P10 接线：只注入当前地点，密室名字不泄漏', async () => {
  const f = await fixture();
  try {
    const text = renderSqlSceneContext(f.world);
    assert.match(text, /教室/, '当前地点要在');
    assert.equal(text.includes('无人知晓的密室'), false, '别的房间（尤其是秘密房间）不注入');
    assert.equal(text.includes('/api/'), false, '注入文本不含任何请求痕迹');
  } finally { f.db.close(); }
});

test('P10 接线：布局没保存时只说未就绪，不编造家具与尺寸', async () => {
  const f = await fixture({ withCanonical: false });
  try {
    const text = renderSqlSceneContext(f.world);
    assert.match(text, /内部布局未就绪/, '没有空间记录就说未就绪');
    assert.equal(/书架|玻璃隔断/.test(text), false, '不许凭空出现家具');
  } finally { f.db.close(); }
});

test('P10 接线：这条路径只读，不写库也不改修订', async () => {
  const f = await fixture();
  try {
    const before = Buffer.from(f.db.export());
    const revision = Number(queryBound(f.db, 'SELECT revision FROM branches WHERE id=?', [IDS.branchMain])[0].revision);
    for (let i = 0; i < 5; i += 1) renderSqlSceneContext(f.world);
    assert.deepEqual(Buffer.from(f.db.export()), before, '注入路径不改库');
    assert.equal(Number(queryBound(f.db, 'SELECT revision FROM branches WHERE id=?', [IDS.branchMain])[0].revision), revision);
  } finally { f.db.close(); }
});

test('P10 接线：没有当前地点时不给空间行，也不报错', async () => {
  const f = await fixture();
  try {
    const { lines, diagnostics } = buildPovSceneLines(f.world, { povId: IDS.C1, locationId: null, position: { kind: 'unknown' } });
    assert.deepEqual(lines, []);
    assert.deepEqual(diagnostics, []);
  } finally { f.db.close(); }
});
