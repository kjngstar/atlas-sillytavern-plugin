/**
 * M3-02：定向引用目录的验收（W05）。
 *
 * 核心要证明的一件事：**图多于旧上限（maps 50）时，目标图仍然在目录里、且 alias 稳定**。
 * 所以夹具造 70 张图，把焦点放在第 70 张上；随后往库里插入「排序更靠前」的无关实体，
 * 用同一份 input 再收一次目录——`catalogueHash` 与 alias→id 映射必须逐字不变。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadSqlModule } from '../src/atlas-db-runtime.ts';
import { createTableReadPort } from '../src/atlas-db-readport.ts';
import { createRow } from '../src/atlas-db-defaults.ts';
import { collectTaskRefs } from '../src/atlas-sql-task-refs.ts';
import { collectKnownRefs } from '../src/atlas-sql-refs.ts';
import { IDS, insertRows, makeSeedWith } from './fixtures/atlas-sql/seed.mjs';

const BRANCH = IDS.branchMain;
const TURN = IDS.seedTurn;
const MAP_COUNT = 70;
const FOCUS_MAP = 'MAP_070';
const FOCUS_CONTAINER = 'CON_070';
const ANCESTORS = ['ANC_1', 'ANC_2'];
const CHILDREN = ['CHILD_1', 'CHILD_2', 'CHILD_3'];
const ROUTE = 'RTE_1';
const OCCUPANT = 'OC_1';
const GROUND_ITEM = 'IT_1';

const c = (id) => ({ branchId: BRANCH, id, turnId: TURN, clockS: 0, nowWallMs: 1_700_000_000_000, rulesetVersion: 'atlas-1' });

// 用 createRow 补全各表默认值：NOT NULL / CHECK 约束由权威默认值满足，测试不再手抄列清单。
const locationRow = (id, over = {}) => createRow('locations', { name: id, kind: 'city', ...over }, c(id));
const mapRow = (id, container) => createRow('maps', { name: id, kind: 'site', container_location_id: container }, c(id));
const routeRow = (id, from, to, mapId) =>
  createRow('routes', { from_location_id: from, to_location_id: to, map_id: mapId }, c(id));
const characterRow = (id, locationId, mapId) =>
  createRow('characters', { name: id, location_id: locationId, map_id: mapId }, c(id));
const itemRow = (id, locationId, mapId) =>
  createRow('items', { name: id, location_id: locationId, map_id: mapId }, c(id));

async function fixture() {
  const SQL = await loadSqlModule();
  const seed = await makeSeedWith(SQL);
  const db = seed.db;

  const locations = [];
  const maps = [];
  for (let i = 1; i <= MAP_COUNT; i += 1) {
    const n = String(i).padStart(3, '0');
    const container = `CON_${n}`;
    // 容器地点：除焦点容器外都挂在根上，只有焦点容器有祖先链，便于断言祖先收集。
    locations.push(locationRow(container, container === FOCUS_CONTAINER ? { parent_location_id: 'ANC_2' } : {}));
    maps.push(mapRow(`MAP_${n}`, container));
  }
  locations.push(locationRow('ANC_1', { kind: 'region', map_id: 'MAP_001' }));
  locations.push(locationRow('ANC_2', { kind: 'region', parent_location_id: 'ANC_1', map_id: 'MAP_001' }));
  for (const id of CHILDREN) {
    locations.push(locationRow(id, { kind: 'building', parent_location_id: FOCUS_CONTAINER, map_id: FOCUS_MAP }));
  }

  // entity_keys 是身份权威：locations / characters / items 的插入有 BEFORE INSERT 触发器校验 kind。
  const keys = (ids, kind) => ids.map((id) => ({ branch_id: BRANCH, id, kind }));
  insertRows(db, 'entity_keys', [
    ...keys(locations.map((row) => row.id), 'location'),
    ...keys(['OC_1'], 'character'),
    ...keys(['IT_1'], 'item'),
  ]);

  // 外键顺序：先落 parent/map 全空的地点 → 再落地图（container 指向地点）→ 再回填 parent/map。
  insertRows(db, 'locations', locations.map((row) => ({ ...row, parent_location_id: null, map_id: null })));
  insertRows(db, 'maps', maps);
  for (const row of locations) {
    db.run('UPDATE locations SET parent_location_id = ?, map_id = ? WHERE branch_id = ? AND id = ?', [
      row.parent_location_id,
      row.map_id,
      BRANCH,
      row.id,
    ]);
  }

  insertRows(db, 'routes', [routeRow(ROUTE, CHILDREN[0], CHILDREN[1], FOCUS_MAP)]);
  insertRows(db, 'characters', [characterRow(OCCUPANT, CHILDREN[0], FOCUS_MAP)]);
  insertRows(db, 'items', [itemRow(GROUND_ITEM, CHILDREN[0], FOCUS_MAP)]);
  return db;
}

const INPUT = {
  branchId: BRANCH,
  focusMapIds: [FOCUS_MAP],
  focusLocationIds: [FOCUS_CONTAINER],
  includeAncestors: true,
  includeDirectChildren: true,
  includeRoutes: true,
  includeOccupants: true,
  maxEntries: 512,
};

const aliasMap = (cat) => Object.fromEntries(cat.knownRefs.map((ref) => [ref.alias, ref.id]));
const idsOf = (cat) => new Set(cat.knownRefs.map((ref) => ref.id));
const idOfKind = (cat, kind) => cat.knownRefs.filter((ref) => ref.kind === kind).map((ref) => ref.id);

test('W05 70 图下目标图与祖先/成员/路线/端点都在目录，且 alias 连续可解析', async () => {
  const db = await fixture();
  const cat = collectTaskRefs(createTableReadPort(db), INPUT);
  const ids = idsOf(cat);

  // 旧实现（每表 maps 只取 50 条）拿不到第 70 张图；定向目录必须拿到。
  const limited = collectKnownRefs(createTableReadPort(db), BRANCH);
  assert.ok(!limited.some((ref) => ref.id === FOCUS_MAP), '前置：旧的全表上限确实漏掉第 70 张图');
  assert.ok(ids.has(FOCUS_MAP), '定向目录必须包含目标图 MAP_070');

  const focusRef = cat.knownRefs.find((ref) => ref.id === FOCUS_MAP);
  assert.equal(focusRef.kind, 'map', '目标图必须以 map 身份进入目录');
  assert.ok(Number.isInteger(focusRef.rowRev) && focusRef.rowRev >= 1, 'rowRev 必须可审计');
  assert.ok(cat.rows.maps.some((row) => row.id === FOCUS_MAP), 'rows.maps 要带上可解析的整行');

  for (const id of [...ANCESTORS, FOCUS_CONTAINER, ...CHILDREN]) {
    assert.ok(ids.has(id), `必要地点 ${id} 必须在目录里`);
  }
  assert.ok(ids.has(ROUTE), '与已选地点相连的路线必须在目录里');
  assert.ok(ids.has(ROUTE) && ids.has(CHILDREN[1]) && ids.has(CHILDREN[0]), '路线双端点都要能 resolve');
  assert.ok(ids.has(OCCUPANT), '必要 occupants（角色）必须在目录里');
  assert.ok(ids.has(GROUND_ITEM), '必要 occupants（物品）必须在目录里');

  // alias 连续、唯一、格式固定，且每个都能解析回真实 ID。
  const aliases = cat.knownRefs.map((ref) => ref.alias);
  assert.equal(new Set(aliases).size, aliases.length, 'alias 不得重复');
  for (const alias of aliases) assert.match(alias, /^[A-Z]\d+$/, `alias 形状不合法：${alias}`);
  const mapAliases = cat.knownRefs.filter((ref) => ref.kind === 'map').map((ref) => ref.alias);
  assert.deepEqual(mapAliases, mapAliases.map((_, index) => `M${index + 1}`), '每 kind 的 alias 必须从 1 连续编号');
  assert.ok(!aliases.some((alias) => alias.includes('undefined')), '绝不许出现 undefined alias');
  assert.equal(idOfKind(cat, 'map').includes(FOCUS_MAP), true);

  assert.equal(cat.issues.length, 0, `未超上限时不该有诊断：${JSON.stringify(cat.issues)}`);
  assert.equal(cat.remainingIds.length, 0);
  assert.match(cat.catalogueHash, /^[0-9a-f]{16,}$/, 'catalogueHash 必须是稳定十六进制串');
});

test('W05 候选期间插入更早排序的无关实体：catalogueHash 与 alias 映射逐字不变', async () => {
  const db = await fixture();
  const read = createTableReadPort(db);
  const before = collectTaskRefs(read, INPUT);
  const beforeAliases = aliasMap(before);

  // 排序上必然更靠前的无关实体：不挂在任何已选地点下、不带任何已选 map_id。
  insertRows(db, 'entity_keys', [
    ...['AAA_A', 'AAA_B'].map((id) => ({ branch_id: BRANCH, id, kind: 'location' })),
    { branch_id: BRANCH, id: 'AAA_C', kind: 'character' },
  ]);
  insertRows(db, 'locations', [
    locationRow('AAA_A', { kind: 'city' }),
    locationRow('AAA_B', { kind: 'region' }),
  ]);
  insertRows(db, 'maps', [mapRow('AAA_MAP', null)]);
  insertRows(db, 'characters', [characterRow('AAA_C', null, null)]);

  const after = collectTaskRefs(read, INPUT);
  assert.equal(after.catalogueHash, before.catalogueHash, '同一 input 必须命中同一目录（hash 不变）');
  assert.deepEqual(aliasMap(after), beforeAliases, 'alias → id 映射必须逐字不变，否则旧 alias 会改指向');
  assert.ok(!idsOf(after).has('AAA_A') && !idsOf(after).has('AAA_MAP'), '无关实体不得被卷进定向目录');
});

test('W05 超上限：必要项全留、完整 remainingIds + 明确 Issue（不静默丢）', async () => {
  const db = await fixture();
  const cat = collectTaskRefs(createTableReadPort(db), { ...INPUT, maxEntries: 8 });
  const ids = idsOf(cat);

  assert.ok(ids.has(FOCUS_MAP), '超上限时目标图仍必须保留');
  for (const id of [...ANCESTORS, FOCUS_CONTAINER]) assert.ok(ids.has(id), `必要祖先/目标 ${id} 不得因上限消失`);
  assert.ok(cat.knownRefs.length >= 4, '必要项优先占位');
  assert.ok(cat.remainingIds.length > 0, '超出部分必须完整列入 remainingIds');
  assert.equal(new Set(cat.remainingIds).size, cat.remainingIds.length, 'remainingIds 不得重复');
  assert.ok(!ids.has(cat.remainingIds[0]), 'remainingIds 里的 ID 不该同时出现在目录里');
  assert.equal(cat.issues.length, 1);
  assert.equal(cat.issues[0].code, 'REF_CATALOGUE_TRUNCATED');
  assert.equal(cat.issues[0].severity, 'warning');
  assert.equal(cat.issues[0].retryable, true);
});
