/**
 * atlas-db-migrate.test.mjs — T15：旧会话文档迁移（E11–E14）。
 *
 * 覆盖（§17E E11–E14 / §7.2 / §18.3 T15）：
 * - 旧三表数量与稳定 ID 不减；`entity_keys` 为每个实体建行；
 * - 旧 rumors → information + 当地 front，且**零** knowledge 行（不让人人知）；
 * - 旧抽象 period 不折算成秒（时间轴从相对 0 开始，标签只进 calendar_label）；
 * - `mapId` 显式换算（旧「mapId 等于地点 ID」约定已死；解析不了的记具名警告且不静默丢坐标）；
 * - 空档 / 损坏档 / 已迁移档 / 新格式档互不混淆（损坏档绝不判成「无数据」）；
 * - 导入两次不重复插入（ALREADY_IMPORTED）；
 * - 旧 simulation → actions/information/front，无法映射的保留 blocked；
 * - finalizeMigration 幂等、重开不重建世界；legacyBackupPayload 只构造负载、不写库。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ATLAS_SCHEMA_VERSION, installSchema } from '../src/atlas-db-schema.ts';
import {
  finalizeMigration,
  inspectLegacySession,
  legacyBackupPayload,
  migrateLegacyEntities,
  migrateLegacySimulation,
} from '../src/atlas-db-migrate.ts';
import { countRows, foreignKeyCheck, insertRows, selectOne, userTables } from './fixtures/atlas-sql/seed.mjs';

const SQL = await (await import('sql.js')).default();

const BRANCH = 'main-A';
const TURN = 'turn_migration_A';
const nowWallMs = 1_700_000_000_000;

/** 确定性 makeId：同输入必得同 ID（不使用 Math.random）。 */
function makeId(kind, opId, alias) {
  let h = 0x811c9dc5;
  const text = `${kind}\u0000${opId}\u0000${alias}`;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${kind}_${h.toString(16).padStart(8, '0')}`;
}

function entityCtx() {
  return { branchId: BRANCH, turnId: TURN, makeId, nowWallMs, rulesetVersion: 'atlas-1', clockS: 0 };
}

function simulationCtx() {
  return { branchId: BRANCH, turnId: TURN, makeId, nowWallMs, rulesetVersion: 'atlas-1' };
}

/** 只建 schema + 迁移用的分支/推演记录（不预置任何实体）。 */
function makeEmptyWorld() {
  const db = new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  installSchema(db);
  db.run('BEGIN');
  insertRows(db, 'turns', [
    {
      id: TURN,
      branch_id: BRANCH,
      parent_turn_id: null,
      host_message_uid: null,
      host_variant_key: null,
      kind: 'migration',
      input_hash: 'hash_migration_A',
      story_hash: null,
      base_revision: 0,
      committed_revision: 0,
      clock_before_s: 0,
      elapsed_json: JSON.stringify({ min_s: 0, nominal_s: 0, max_s: 0, quality: 'explicit', basis_refs: [] }),
      clock_after_s: 0,
      rng_seed: 'rng_migration_A',
      ruleset_version: 'atlas-1',
      decisions_json: JSON.stringify({ operations: [], attention_decisions: [], outcome_decisions: [], random_draws: [] }),
      receipt_json: null,
      attempts_json: '[]',
      status: 'committed',
      created_wall_ms: nowWallMs,
      prepared_wall_ms: nowWallMs,
    },
  ]);
  insertRows(db, 'branches', [
    {
      id: BRANCH,
      parent_branch_id: null,
      fork_turn_id: null,
      head_turn_id: TURN,
      revision: 0,
      name: '主线',
      pov_character_id: null,
      root_map_id: null,
      clock_s: 0,
      clock_min_s: 0,
      clock_max_s: 0,
      calendar_label: null,
      simulation_cursor_s: 0,
      simulation_status: 'current',
      ruleset_version: 'atlas-1',
      status: 'active',
      created_wall_ms: nowWallMs,
    },
  ]);
  db.run('COMMIT');
  return db;
}

function branchRow(db) {
  const rows = db.exec('SELECT * FROM branches WHERE id = ?', [BRANCH]);
  const out = {};
  rows[0].columns.forEach((column, index) => {
    out[column] = rows[0].values[0][index];
  });
  return out;
}

function scalar(db, sql, params = []) {
  const rows = db.exec(sql, params);
  return rows.length ? rows[0].values[0][0] : null;
}

/** 合成旧档：3 地点 / 4 人物 / 2 物品 / 1 张旧世界图 / 2 条风声 / 1 个旧任务。 */
function legacyDoc() {
  return {
    chatMetadata: {
      atlas: {
        worldId: 'world-1',
        period: '第4期',
        tables: {
          schemaVersion: 1,
          worldId: 'world-1',
          branches: {
            canon: {
              locations: [
                {
                  id: 'loc:1',
                  name: '旧城',
                  kind: 'city',
                  description: '城墙与市场',
                  mapId: 'world',
                  gridX: 3,
                  gridY: 4,
                  coordinateStatus: 'confirmed',
                  rumors: ['城主病重', '河道将开'],
                  factions: ['旧王国'],
                  period: 4,
                },
                { id: 'loc:2', name: '旧学校', kind: 'building', parentLocationId: 'loc:1', mapId: 'loc:1', gridX: 1, gridY: 2, rumors: [] },
                { id: 'loc:3', name: '旧教室', kind: 'room', parentLocationId: 'loc:2', mapId: 'map:missing', gridX: 5, gridY: 6, rumors: [] },
              ],
              characters: [
                {
                  id: 'npc:1',
                  name: '艾琳',
                  identity: '学校教师',
                  locationId: 'loc:2',
                  thought: '先观察',
                  actionTendency: '等待放学',
                  importance: 'recurring',
                },
                { id: 'npc:2', name: '信使', locationId: 'loc:1' },
                { id: '', name: '无名旅人', locationId: 'loc:3' },
                { id: 'npc:4', name: '国王', locationId: 'loc:unknown' },
              ],
              items: [
                { id: 'item:1', name: '旧剑', kind: 'weapon', holderCharacterId: 'npc:1' },
                { id: 'item:2', name: '旧地图', locationId: 'loc:1' },
              ],
              relations: [
                { id: 'rel:1', subjectId: 'npc:1', objectId: 'loc:2', kind: 'controls', label: '任教', description: '在学校教书' },
                { id: 'rel:2', subjectId: 'npc:2', description: '与某位旧友失和（对象不明）' },
              ],
            },
          },
        },
        maps: { schemaVersion: 2, pointMeta: {}, submaps: {}, calibrations: {} },
        simulation: {
          schemaVersion: 1,
          worldId: 'world-1',
          branches: {
            canon: {
              tasks: [
                {
                  id: 'task:1',
                  kind: 'intent',
                  status: 'active',
                  actorCharacterId: 'npc:1',
                  originLocationId: 'loc:2',
                  targetLocationId: 'loc:1',
                  topic: '前往旧城',
                  signalId: null,
                  visibility: 'known',
                  source: 'character-intent',
                  createdTurnKey: 't1',
                  lastAppliedTurnKey: null,
                  createdPeriod: 4,
                  nextEligiblePeriod: 5,
                  reasonCode: null,
                },
              ],
              signals: [
                {
                  id: 'sig:1',
                  originLocationId: 'loc:1',
                  topic: '城主病重',
                  sourceTurnKey: 't1',
                  sourceQuoteId: 'q1',
                  publishedPeriod: 4,
                  visibility: 'known',
                  status: 'active',
                  propagationCursor: 0,
                },
              ],
              deliveries: [
                {
                  id: 'dlv:1',
                  signalId: 'sig:1',
                  recipientType: 'location',
                  recipientId: 'loc:1',
                  via: 'witness',
                  fromLocationId: 'loc:1',
                  receivedPeriod: 5,
                  confidence: 'rumor',
                },
              ],
              geoTopology: { edges: [], areas: [{ id: 'area:1' }], vehicles: [] },
            },
          },
        },
      },
    },
  };
}

async function migratedWorld() {
  const db = makeEmptyWorld();
  const doc = legacyDoc();
  const inspection = inspectLegacySession(doc);
  const entities = migrateLegacyEntities(inspection, doc, db, entityCtx());
  return { db, doc, inspection, entities };
}

test('T15-01 旧三表数量与稳定 ID 不减，entity_keys 为每个实体建行', async () => {
  const { db, doc, inspection, entities } = await migratedWorld();
  try {
    assert.equal(inspection.kind, 'legacy');
    assert.deepEqual(inspection.counts, { locations: 3, characters: 4, items: 2, maps: 1, rumors: 2, simulationTasks: 1 });
    assert.equal(inspection.plan.entityKeys, 10);
    assert.equal(inspection.plan.information, 2);
    assert.equal(inspection.plan.fronts, 2);
    assert.equal(inspection.plan.skipped, 0);
    assert.equal(entities.issues.filter((issue) => issue.severity === 'error').length, 0);

    // 数量
    assert.equal(countRows(db, 'locations', BRANCH), 3);
    assert.equal(countRows(db, 'characters', BRANCH), 4);
    assert.equal(countRows(db, 'items', BRANCH), 2);
    assert.equal(countRows(db, 'maps', BRANCH), 1);
    assert.equal(entities.mapped['kind:locations'], 3);
    assert.equal(entities.mapped['kind:characters'], 4);
    assert.equal(entities.mapped['kind:items'], 2);

    // 稳定 ID 逐条保留
    for (const id of ['loc:1', 'loc:2', 'loc:3']) assert.ok(selectOne(db, 'locations', BRANCH, id), `地点 ${id} 应保留原 ID`);
    for (const id of ['npc:1', 'npc:2', 'npc:4']) assert.ok(selectOne(db, 'characters', BRANCH, id), `人物 ${id} 应保留原 ID`);
    for (const id of ['item:1', 'item:2']) assert.ok(selectOne(db, 'items', BRANCH, id), `物品 ${id} 应保留原 ID`);

    // entity_keys：3 地点 + 4 人物 + 2 物品 + 1 势力
    assert.equal(countRows(db, 'entity_keys', BRANCH), 10);
    assert.equal(selectOne(db, 'entity_keys', BRANCH, 'loc:1').kind, 'location');
    assert.equal(selectOne(db, 'entity_keys', BRANCH, 'npc:1').kind, 'character');
    assert.equal(selectOne(db, 'entity_keys', BRANCH, 'item:1').kind, 'item');

    // 字段与引用
    const location = selectOne(db, 'locations', BRANCH, 'loc:1');
    assert.equal(location.name, '旧城');
    assert.equal(location.kind, 'city');
    assert.equal(location.parent_location_id, null);
    assert.equal(location.map_id, 'world', '旧世界图应换算成真实 maps 行（ID 保持 world）');
    assert.equal(Number(location.grid_x), 3);
    assert.equal(Number(location.grid_y), 4);
    assert.equal(selectOne(db, 'locations', BRANCH, 'loc:2').parent_location_id, 'loc:1');
    const character = selectOne(db, 'characters', BRANCH, 'npc:1');
    assert.equal(character.location_id, 'loc:2');
    assert.equal(character.thought, '先观察');
    assert.equal(character.action_tendency, '等待放学');
    assert.equal(character.physical_status, 'unknown', '未知生理状态不是 alive');
    const heldItem = selectOne(db, 'items', BRANCH, 'item:1');
    assert.equal(heldItem.holder_character_id, 'npc:1');
    assert.equal(heldItem.location_id, null, '持有人与放置位置互斥');
    const placedItem = selectOne(db, 'items', BRANCH, 'item:2');
    assert.equal(placedItem.location_id, 'loc:1');
    assert.equal(placedItem.holder_character_id, null);
    const faction = selectOne(db, 'factions', BRANCH, makeId('faction', 'migration.faction', 'faction:旧王国#0'));
    assert.ok(faction, '旧地点行内嵌的 factions 名单应建档');
    assert.equal(faction.name, '旧王国');
    assert.deepEqual(foreignKeyCheck(db), []);
    void doc;
  } finally {
    db.close();
  }
});

test('T15-02 旧 rumors → information + 当地 front，且零 knowledge（不让人人知）', async () => {
  const { db } = await migratedWorld();
  try {
    assert.equal(countRows(db, 'information', BRANCH), 2);
    assert.equal(countRows(db, 'rumor_fronts', BRANCH), 2);
    assert.equal(countRows(db, 'knowledge', BRANCH), 0, '旧 rumors 不能让所有人知情');

    const rows = db.exec('SELECT id, kind, truth_status, created_at_s, origin_location_id, content FROM information WHERE branch_id = ? ORDER BY id', [
      BRANCH,
    ]);
    assert.equal(rows[0].values.length, 2);
    for (const value of rows[0].values) {
      assert.equal(String(value[1]), 'rumor');
      assert.equal(String(value[2]), 'unknown', '无法识别真假的内容应为 unknown');
      assert.equal(Number(value[3]), 0, '世界内时间从迁移基点相对 0 开始');
      assert.equal(String(value[4]), 'loc:1');
    }
    const contents = rows[0].values.map((value) => String(value[5])).sort();
    assert.deepEqual(contents, ['城主病重', '河道将开']);

    const fronts = db.exec('SELECT information_id, location_id, reach, status, first_available_at_s FROM rumor_fronts WHERE branch_id = ?', [BRANCH]);
    for (const value of fronts[0].values) {
      assert.equal(String(value[1]), 'loc:1');
      assert.equal(String(value[2]), 'local');
      assert.equal(String(value[3]), 'active');
      assert.equal(Number(value[4]), 0);
    }
  } finally {
    db.close();
  }
});

test('T15-03 旧 period 不编秒数：只在 calendar_label 留历史标签，时间字段保持相对 0', async () => {
  const { db, entities } = await migratedWorld();
  try {
    assert.ok(entities.issues.some((issue) => issue.code === 'PERIOD_NOT_CONVERTED'));
    const branch = branchRow(db);
    assert.equal(Number(branch.clock_s), 0, '旧 period 不得推进时钟');
    assert.equal(Number(branch.clock_min_s), 0);
    assert.equal(Number(branch.clock_max_s), 0);
    assert.equal(Number(branch.simulation_cursor_s), 0);
    assert.ok(String(branch.calendar_label).includes('第4期'), '历史标签保留在 calendar_label（不参与算术）');
    assert.equal(Number(scalar(db, 'SELECT COUNT(*) FROM relations WHERE branch_id = ? AND valid_from_s <> 0', [BRANCH])), 0);
    assert.equal(Number(scalar(db, 'SELECT COUNT(*) FROM rumor_fronts WHERE branch_id = ? AND first_available_at_s <> 0', [BRANCH])), 0);
  } finally {
    db.close();
  }
});

test('T15-04 mapId 显式换算：旧地图 ID 不成坐标就丢，未解析的图记具名警告', async () => {
  const { db, entities } = await migratedWorld();
  try {
    // 旧世界图 → 真实 maps 行，ID 保持 world
    const map = selectOne(db, 'maps', BRANCH, 'world');
    assert.ok(map);
    assert.equal(map.kind, 'world');
    assert.equal(Number(map.meters_per_cell) === null, false);
    assert.equal(Number(map.scale_locked), 0);

    // 「mapId 等于地点 ID」不再被当成地图：坐标不静默丢弃，而是清空坐标并记具名警告
    const school = selectOne(db, 'locations', BRANCH, 'loc:2');
    assert.equal(school.map_id, null);
    assert.equal(school.grid_x, null);
    assert.equal(school.grid_y, null);
    assert.equal(school.parent_location_id, 'loc:1', '粗位置（父子关系）保留');
    const unresolved = entities.issues.filter((issue) => issue.code === 'LEGACY_MAP_UNRESOLVED');
    assert.equal(unresolved.length, 2, 'loc:1 与 map:missing 各记一条');
    assert.ok(unresolved.some((issue) => issue.message.includes('map:missing')));

    // 人物坐标：地图解析成功才写，且必须带 map_id
    const messenger = selectOne(db, 'characters', BRANCH, 'npc:2');
    assert.equal(messenger.location_id, 'loc:1');
    assert.equal(messenger.map_id, null, '未提供 mapId 时不猜地图');

    // 未解析地点的人物：保留 NULL 粗位置并记警告，不塞进别的地点
    const king = selectOne(db, 'characters', BRANCH, 'npc:4');
    assert.equal(king.location_id, null);
    assert.ok(entities.issues.some((issue) => issue.code === 'LEGACY_LOCATION_UNRESOLVED' && issue.message.includes('npc:4')));
  } finally {
    db.close();
  }
});

test('T15-05 旧地图文档描述过的子图才做显式转换（LEGACY_MAP_CONVERTED）', async () => {
  const db = makeEmptyWorld();
  try {
    const doc = legacyDoc();
    doc.chatMetadata.atlas.maps = { schemaVersion: 2, pointMeta: {}, submaps: { '1': { frame: { cols: 20, rows: 15 } } }, calibrations: {} };
    const inspection = inspectLegacySession(doc);
    assert.equal(inspection.counts.maps, 2, '根图 + 旧档确实描述的一张子图');
    const result = migrateLegacyEntities(inspection, doc, db, entityCtx());
    assert.ok(result.issues.some((issue) => issue.code === 'LEGACY_MAP_CONVERTED'));
    assert.equal(countRows(db, 'maps', BRANCH), 2);
    const school = selectOne(db, 'locations', BRANCH, 'loc:2');
    assert.ok(school.map_id, '被描述过的旧子图应换算成独立 map 行');
    assert.equal(Number(school.grid_x), 1);
    assert.equal(selectOne(db, 'maps', BRANCH, school.map_id).container_location_id, 'loc:1');
  } finally {
    db.close();
  }
});

test('T15-06 旧 id 缺失时铸造确定性 ID 并记录 LEGACY_ID_MINTED', async () => {
  const { db, entities } = await migratedWorld();
  try {
    const minted = makeId('character', 'migration.character', 'character:无名旅人#2');
    const row = selectOne(db, 'characters', BRANCH, minted);
    assert.ok(row, '缺失 id 的旧人物应有一个确定性 ID');
    assert.equal(row.name, '无名旅人');
    assert.equal(row.location_id, 'loc:3');
    assert.ok(entities.issues.some((issue) => issue.code === 'LEGACY_ID_MINTED' && issue.message.includes(minted)));
    // 确定性：同样输入再算一次结果相同（重复导入因此可识别）
    assert.equal(minted, makeId('character', 'migration.character', 'character:无名旅人#2'));
  } finally {
    db.close();
  }
});

test('T15-07 旧关系没有明确对象时保留描述、不按同名匹配；有明确 ID 才落地', async () => {
  const { db, entities } = await migratedWorld();
  try {
    assert.equal(countRows(db, 'relations', BRANCH), 1);
    const relation = selectOne(db, 'relations', BRANCH, 'rel:1');
    assert.equal(relation.subject_entity_id, 'npc:1');
    assert.equal(relation.object_entity_id, 'loc:2');
    assert.equal(relation.kind, 'controls');
    const skipped = entities.skipped.find((entry) => entry.kind === 'relation');
    assert.ok(skipped, '对象不明的旧关系必须出现在 skipped 里');
    assert.ok(skipped.reason.includes('与某位旧友失和'), '描述必须原样保留待识别');
    assert.ok(entities.issues.some((issue) => issue.code === 'RELATION_OBJECT_UNRESOLVED'));
  } finally {
    db.close();
  }
});

test('T15-08 空档 / 损坏档 / 已迁移档 / 新格式档互不混淆', async () => {
  // 空档：没有 atlas 元数据
  assert.equal(inspectLegacySession({ chatMetadata: {} }).kind, 'empty');
  assert.equal(inspectLegacySession({ chatMetadata: { atlas: { binding: { worldId: 'w' } } } }).kind, 'empty');
  assert.equal(inspectLegacySession(null).kind, 'empty');
  // 损坏档：结构在但内容坏 → 绝不报「无数据」
  const corruptTables = inspectLegacySession({ chatMetadata: { atlas: { tables: { locations: '不是数组' } } } });
  assert.equal(corruptTables.kind, 'corrupt');
  assert.ok(corruptTables.reason.includes('LOCATIONS_NOT_ARRAY'));
  assert.equal(inspectLegacySession({ chatMetadata: { atlas: '不是对象' } }).kind, 'corrupt');
  assert.equal(inspectLegacySession('{"chatMetadata":{"atlas":').kind, 'corrupt');
  assert.equal(inspectLegacySession({ chatMetadata: { atlas: { database: { format: 'atlas-sqlite', data: '' } } } }).kind, 'corrupt');
  // 新格式 / 已迁移
  const envelope = { format: 'atlas-sqlite', storage_version: 1, schema_version: 1, data: 'AAAA', encoding: 'sqlite-base64' };
  assert.equal(inspectLegacySession({ chatMetadata: { atlas: { database: envelope } } }).kind, 'new_format');
  const doc = legacyDoc();
  doc.chatMetadata.atlas.database = envelope;
  assert.equal(inspectLegacySession(doc).kind, 'already_migrated');
});

test('T15-09 迁移两次不重复插行：第二次报 ALREADY_IMPORTED', async () => {
  const { db, doc, inspection } = await migratedWorld();
  try {
    const before = {
      locations: countRows(db, 'locations', BRANCH),
      characters: countRows(db, 'characters', BRANCH),
      items: countRows(db, 'items', BRANCH),
      entityKeys: countRows(db, 'entity_keys', BRANCH),
      maps: countRows(db, 'maps', BRANCH),
      information: countRows(db, 'information', BRANCH),
      fronts: countRows(db, 'rumor_fronts', BRANCH),
      relations: countRows(db, 'relations', BRANCH),
    };
    const second = migrateLegacyEntities(inspectLegacySession(doc), doc, db, entityCtx());
    assert.equal(second.mapped['kind:locations'], undefined);
    assert.equal(second.mapped['kind:characters'], undefined);
    assert.ok(second.mapped['kind:alreadyImported'] > 0);
    assert.ok(second.issues.some((issue) => issue.code === 'ALREADY_IMPORTED'));
    assert.deepEqual(
      {
        locations: countRows(db, 'locations', BRANCH),
        characters: countRows(db, 'characters', BRANCH),
        items: countRows(db, 'items', BRANCH),
        entityKeys: countRows(db, 'entity_keys', BRANCH),
        maps: countRows(db, 'maps', BRANCH),
        information: countRows(db, 'information', BRANCH),
        fronts: countRows(db, 'rumor_fronts', BRANCH),
        relations: countRows(db, 'relations', BRANCH),
      },
      before,
      '重复导入不得新增任何行',
    );
    // 已迁移档的 plan 直接拒绝重复导入
    const migratedPlan = inspectLegacySession((() => {
      const withEnvelope = legacyDoc();
      withEnvelope.chatMetadata.atlas.database = { format: 'atlas-sqlite', schema_version: 1, data: 'AAAA' };
      return withEnvelope;
    })());
    assert.equal(migratedPlan.kind, 'already_migrated');
    const refused = migrateLegacyEntities(migratedPlan, doc, db, entityCtx());
    assert.equal(refused.mapped['kind:locations'], undefined);
    assert.ok(refused.issues.some((issue) => issue.code === 'ALREADY_IMPORTED'));
    void inspection;
  } finally {
    db.close();
  }
});

test('T15-10 旧 simulation → actions/information/front，无法映射的保留 blocked', async () => {
  const { db, doc, inspection } = await migratedWorld();
  try {
    const before = {
      actions: countRows(db, 'actions', BRANCH),
      information: countRows(db, 'information', BRANCH),
      fronts: countRows(db, 'rumor_fronts', BRANCH),
      knowledge: countRows(db, 'knowledge', BRANCH),
    };
    assert.deepEqual(before, { actions: 0, information: 2, fronts: 2, knowledge: 0 });

    const result = migrateLegacySimulation(inspection, doc, db, simulationCtx());
    assert.equal(result.mapped['kind:actions'], 1);
    assert.equal(result.mapped['kind:information'], 1);
    assert.equal(result.mapped['kind:fronts'], 1);
    assert.equal(result.mapped['kind:knowledge'], undefined, '地点收件人只建 front，不建人物认知');
    assert.deepEqual(result.blocked.map((entry) => entry.kind), ['area']);
    assert.ok(result.blocked[0].reason.includes('TOPOLOGY_AREAS_UNMAPPED'));
    assert.ok(result.issues.some((issue) => issue.code === 'PERIOD_NOT_CONVERTED'));

    const action = selectOne(db, 'actions', BRANCH, 'task:1');
    assert.ok(action);
    assert.equal(action.actor_entity_id, 'npc:1');
    assert.equal(action.kind, 'goal');
    assert.equal(action.status, 'active');
    assert.equal(Number(action.progress_s), 0);
    assert.equal(Number(action.evaluated_until_s), 0, '旧 period 不写进任何 *_s 字段');
    assert.equal(Number(action.started_at_s ?? 0), 0);

    const signal = selectOne(db, 'information', BRANCH, 'sig:1');
    assert.ok(signal);
    assert.equal(signal.content, '城主病重');
    assert.equal(Number(signal.created_at_s), 0);
    assert.equal(signal.origin_location_id, 'loc:1');

    const front = selectOne(db, 'rumor_fronts', BRANCH, 'rf_dlv:1');
    assert.ok(front);
    assert.equal(front.information_id, 'sig:1');
    assert.equal(front.location_id, 'loc:1');
    assert.equal(Number(front.first_available_at_s), 0);

    // 重复迁移旧 simulation 不重复插入
    const again = migrateLegacySimulation(inspection, doc, db, simulationCtx());
    assert.equal(again.mapped['kind:actions'], undefined);
    assert.equal(countRows(db, 'actions', BRANCH), 1);
    assert.equal(countRows(db, 'information', BRANCH), 3);
    assert.equal(countRows(db, 'rumor_fronts', BRANCH), 3);
  } finally {
    db.close();
  }
});

test('T15-11 finalizeMigration 校验后标记版本；重开不重复迁移、不重建世界', async () => {
  const { db, doc } = await migratedWorld();
  let reopened = null;
  try {
    db.run('PRAGMA user_version = 0');
    const first = finalizeMigration(db, { branchId: BRANCH });
    assert.equal(first.ok, true, JSON.stringify(first.issues));
    assert.equal(Number(scalar(db, 'PRAGMA user_version')), ATLAS_SCHEMA_VERSION);
    assert.deepEqual(foreignKeyCheck(db), []);
    assert.equal(userTables(db).length, 20);

    const second = finalizeMigration(db, { branchId: BRANCH });
    assert.equal(second.ok, true);
    assert.ok(second.issues.some((issue) => issue.code === 'MIGRATION_ALREADY_FINALIZED'));

    // 重开存档：行数与版本都不变，世界不被重建
    const bytes = db.export();
    reopened = new SQL.Database(bytes);
    reopened.run('PRAGMA foreign_keys = ON');
    assert.equal(Number(scalar(reopened, 'PRAGMA user_version')), ATLAS_SCHEMA_VERSION);
    assert.equal(countRows(reopened, 'locations', BRANCH), 3);
    assert.equal(countRows(reopened, 'characters', BRANCH), 4);
    assert.equal(countRows(reopened, 'items', BRANCH), 2);
    const third = finalizeMigration(reopened, { branchId: BRANCH });
    assert.equal(third.ok, true);
    assert.ok(third.issues.some((issue) => issue.code === 'MIGRATION_ALREADY_FINALIZED'));
    assert.equal(countRows(reopened, 'locations', BRANCH), 3);
    void doc;
  } finally {
    reopened?.close();
    db.close();
  }
});

test('T15-12 finalizeMigration 在外键/身份详情不齐时拒绝标记版本', async () => {
  const db = makeEmptyWorld();
  try {
    db.run('PRAGMA user_version = 0');
    insertRows(db, 'entity_keys', [{ branch_id: BRANCH, id: 'LONELY', kind: 'location' }]);
    const result = finalizeMigration(db, { branchId: BRANCH });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === 'MIGRATION_ENTITY_DETAIL_MISSING'));
    assert.equal(Number(scalar(db, 'PRAGMA user_version')), 0, '校验失败不得标记版本');
  } finally {
    db.close();
  }
});

test('T15-14 旧送达按收件人分流：地点→当地 front、人物→knowledge（送达是收到的证据）', async () => {
  const { db, doc, inspection } = await migratedWorld();
  try {
    const simulation = doc.chatMetadata.atlas.simulation.branches.canon;
    simulation.deliveries.push({
      id: 'dlv:2',
      signalId: 'sig:1',
      recipientType: 'character',
      recipientId: 'npc:1',
      via: 'messenger',
      fromLocationId: 'loc:1',
      receivedPeriod: 6,
      confidence: 'confirmed',
    });
    const result = migrateLegacySimulation(inspection, doc, db, simulationCtx());
    assert.equal(result.mapped['kind:knowledge'], 1);
    assert.equal(countRows(db, 'knowledge', BRANCH), 1, '只有明确送达的人才建认知，不是全城皆知');
    const knowledge = selectOne(db, 'knowledge', BRANCH, 'kn_dlv:2');
    assert.ok(knowledge);
    assert.equal(knowledge.knower_character_id, 'npc:1');
    assert.equal(knowledge.information_id, 'sig:1');
    assert.equal(Number(knowledge.is_pov), 0);
    assert.equal(knowledge.belief, 'believed');
    assert.equal(Number(knowledge.first_received_at_s), 0);
    assert.deepEqual(foreignKeyCheck(db), []);
  } finally {
    db.close();
  }
});

test('T15-13 legacyBackupPayload 只构造负载、不写任何存储', async () => {  const db = makeEmptyWorld();
  try {
    const doc = legacyDoc();
    const before = { locations: countRows(db, 'locations', BRANCH), information: countRows(db, 'information', BRANCH) };
    const backup = legacyBackupPayload(doc, { capturedWallMs: 42 });
    assert.equal(backup.kind, 'legacy_backup');
    assert.equal(backup.capturedWallMs, 42);
    assert.deepEqual(backup.payload, doc.chatMetadata.atlas);
    assert.notEqual(backup.payload, doc.chatMetadata.atlas, '负载必须是脱钩副本，不是原对象引用');
    assert.deepEqual({ locations: countRows(db, 'locations', BRANCH), information: countRows(db, 'information', BRANCH) }, before);
    assert.equal(typeof legacyBackupPayload('不是 JSON').capturedWallMs, 'number');
  } finally {
    db.close();
  }
});
