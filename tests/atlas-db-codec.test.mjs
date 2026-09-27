/**
 * atlas-db-codec.test.mjs — T03 codec 断言（§17A A29/A30/A31、§18.3 T03）。
 *
 * 覆盖：encode/decode 往返（JSON 列、布尔列 0/1、NULL 保持 null）；Unicode 与单引号逐字不损坏；
 * 损坏 JSON 列报具体字段而不是静默变成 []；未知列报路径；NaN/Infinity 与类型错误拒绝；
 * INSERT/UPDATE/DELETE 模板形状；createRow 的默认值（位置字段为 NULL 而不是 0）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, inTransaction, selectOne } from './fixtures/atlas-sql/seed.mjs';
import {
  encodeRow,
  decodeRow,
  decodeRowToCamel,
  buildInsertSql,
  buildUpdateSql,
  buildDeleteSql,
  snakeToCamel,
  camelToSnake,
} from '../src/atlas-db-codec.ts';
import { createRow } from '../src/atlas-db-defaults.ts';
import { tableColumnNames } from '../src/atlas-db-schema.ts';

const SQL = await (await import('sql.js')).default();

async function fresh() {
  return makeSeedWith(SQL);
}

/** createRow 的固定上下文（P 字段一律由程序注入，不由模型提供）。 */
function ctx(overrides = {}) {
  return {
    branchId: IDS.branchMain,
    id: 'T03-NEW',
    turnId: IDS.seedTurn,
    clockS: 0,
    nowWallMs: 1_700_000_000_000,
    rulesetVersion: 'atlas-1',
    ...overrides,
  };
}

/** 用一个 id 参数读回整行原始 SQL 值（sql.js 的 getAsObject 参数数组形态不一致，统一用 exec）。 */
function rawRow(db, table, id) {
  const result = db.exec(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  if (!result.length) return null;
  const { columns, values } = result[0];
  const out = {};
  columns.forEach((name, i) => {
    out[name] = values[0][i];
  });
  return out;
}

/** encodeRow → 参数绑定 INSERT。返回编码结果，便于断言列序与值。 */
function encodeInsert(db, table, row, options = {}) {
  const encoded = encodeRow(table, row, options);
  if (!encoded.ok) throw new Error(`encodeRow(${table}) 失败：${JSON.stringify(encoded.issues)}`);
  db.run(buildInsertSql(table, encoded.columns), encoded.values);
  return encoded;
}

test('T03-01 encode/decode 往返：aliases 数组、geometry 为 null、NULL 保持 null', async () => {
  const seed = await fresh();
  try {
    const geometry = { kind: 'polygon', coordinates: [[1, 2], [3, 4], [5, 6]] };
    // 新地点先登记实体身份（§2.2：四张实体表的 id 引用 entity_keys）。
    inTransaction(seed.db, () => {
      seed.db.run('INSERT INTO entity_keys (branch_id, id, kind) VALUES (?, ?, ?)', [IDS.branchMain, 'L_CODEC', 'location']);
    });
    const row = createRow(
      'locations',
      {
        name: '码头仓房',
        aliases_json: ['仓房', '码头'],
        kind: 'building',
        parent_location_id: IDS.L1,
        map_id: IDS.M1,
        grid_x: 12,
        grid_y: 11,
        coord_precision: 'exact',
        area_geometry_json: geometry,
        terrain: 'road',
      },
      ctx({ id: 'L_CODEC' }),
    );
    const encoded = encodeInsert(seed.db, 'locations', row);
    // 固定列序来自 schema 常量，不是 JS 对象键顺序。
    assert.deepEqual(encoded.columns, tableColumnNames('locations'));
    assert.deepEqual(
      ['name', 'grid_x', 'aliases_json'].map((c) => encoded.values[encoded.columns.indexOf(c)]),
      ['码头仓房', 12, '["仓房","码头"]'],
    );

    const decoded = decodeRow('locations', rawRow(seed.db, 'locations', 'L_CODEC'));
    assert.equal(decoded.ok, true);
    assert.deepEqual(decoded.row.aliases_json, ['仓房', '码头']);
    assert.deepEqual(decoded.row.area_geometry_json, geometry);
    assert.equal(decoded.row.uncertainty_radius_cells, null);
    assert.equal(decoded.row.merged_into_id, null);
    assert.equal(decoded.row.anchor_location_id, null);
    assert.equal(decoded.row.access_rules_json, null);
    assert.equal(decoded.row.description, '');
    assert.equal(decoded.row.grid_x, 12);
    assert.equal(decoded.row.parent_location_id, IDS.L1);
  } finally {
    seed.close();
  }
});

test('T03-01b 布尔列按 SQL 存 0/1，decode 后还原为 JS boolean', async () => {
  const seed = await fresh();
  try {
    const row = createRow(
      'maps',
      {
        name: '标定图',
        kind: 'world',
        frame_json: { origin_x: 0, origin_y: 0, reference_width_cells: 40, reference_height_cells: 30 },
        meters_per_cell: 25,
        scale_min_meters_per_cell: 25,
        scale_max_meters_per_cell: 25,
        scale_quality: 'confirmed',
        scale_locked: 1,
      },
      ctx({ id: 'M9' }),
    );
    const encoded = encodeInsert(seed.db, 'maps', row);
    assert.equal(encoded.values[encoded.columns.indexOf('scale_locked')], 1);

    const raw = rawRow(seed.db, 'maps', 'M9');
    assert.equal(raw.scale_locked, 1);
    const decoded = decodeRow('maps', raw);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.row.scale_locked, true);
  } finally {
    seed.close();
  }
});

test('T03-02 Unicode/单引号/分号/注入串逐字往返，characters 表仍然存在', async () => {
  const seed = await fresh();
  try {
    const evil = "O'Neil；“渡鸦”; DROP TABLE characters;--";
    inTransaction(seed.db, () => {
      seed.db.run('INSERT INTO entity_keys (branch_id, id, kind) VALUES (?, ?, ?)', [IDS.branchMain, 'C_EVIL', 'character']);
    });
    encodeInsert(seed.db, 'characters', createRow('characters', {
      name: evil,
      identity: '港口联络人',
      thought: `引号 " 与分号 ; 与反斜杠 \\ 都在`,
    }, ctx({ id: 'C_EVIL' })));

    const stored = selectOne(seed.db, 'characters', IDS.branchMain, 'C_EVIL');
    assert.equal(stored.name, evil);
    const decoded = decodeRow('characters', rawRow(seed.db, 'characters', 'C_EVIL'));
    assert.equal(decoded.ok, true);
    assert.equal(decoded.row.name, evil);
    assert.equal(decoded.row.thought, `引号 " 与分号 ; 与反斜杠 \\ 都在`);

    const tables = seed.db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='characters'");
    assert.equal(tables[0].values[0][0], 'characters');
  } finally {
    seed.close();
  }
});

test('T03-03 损坏的 JSON 列报具体字段（不得静默变成 []）', async () => {
  const seed = await fresh();
  try {
    encodeInsert(seed.db, 'maps', createRow(
      'maps',
      { name: '坏标定图', kind: 'world', scale_quality: 'uncalibrated', scale_locked: 0 },
      ctx({ id: 'M8' }),
    ));
    seed.db.run('UPDATE maps SET scale_basis_json = ? WHERE id = ?', ['["a"', 'M8']);

    const decoded = decodeRow('maps', rawRow(seed.db, 'maps', 'M8'));
    assert.equal(decoded.ok, false);
    assert.deepEqual(decoded.issues.map((i) => [i.code, i.path]), [['CODEC_JSON_INVALID', 'maps.scale_basis_json']]);
  } finally {
    seed.close();
  }
});

test('T03-04 未知列报 CODEC_UNKNOWN_COLUMN 并带上该列路径', async () => {
  const seed = await fresh();
  try {
    const row = selectOne(seed.db, 'characters', IDS.branchMain, IDS.C1);
    const decoded = decodeRow('characters', { ...row, mystery_json: '[]' });
    assert.equal(decoded.ok, false);
    assert.deepEqual(decoded.issues.map((i) => [i.code, i.path]), [['CODEC_UNKNOWN_COLUMN', 'characters.mystery_json']]);
  } finally {
    seed.close();
  }
});

test('T03-05 encodeRow 拒绝 NaN/Infinity/-Infinity 并点名列', async () => {
  const seed = await fresh();
  try {
    const row = selectOne(seed.db, 'characters', IDS.branchMain, IDS.C2);
    const bad = [
      [NaN, 'characters.grid_x'],
      [Infinity, 'characters.grid_x'],
      [-Infinity, 'characters.grid_x'],
    ];
    const seen = [];
    for (const [value, path] of bad) {
      const encoded = encodeRow('characters', { ...row, grid_x: value });
      assert.equal(encoded.ok, false);
      assert.deepEqual(encoded.issues.map((i) => [i.code, i.path]), [['CODEC_NUMBER_NOT_FINITE', path]]);
      seen.push(encoded.issues[0].path);
    }
    assert.deepEqual(seen, ['characters.grid_x', 'characters.grid_x', 'characters.grid_x']);
  } finally {
    seed.close();
  }
});

test('T03-05b encodeRow 拒绝非布尔列上的 boolean', async () => {
  const seed = await fresh();
  try {
    const row = selectOne(seed.db, 'characters', IDS.branchMain, IDS.C2);
    const encoded = encodeRow('characters', { ...row, name: true });
    assert.equal(encoded.ok, false);
    assert.deepEqual(encoded.issues.map((i) => [i.code, i.path]), [['CODEC_TYPE_INVALID', 'characters.name']]);
  } finally {
    seed.close();
  }
});

test('T03-06 encodeRow 拒绝把非空值写进 NOT NULL 列', async () => {
  const seed = await fresh();
  try {
    const row = createRow('characters', { name: '艾琳', identity: '教师' }, ctx({ id: 'C_NOTNULL' }));
    const encoded = encodeRow('characters', { ...row, name: null });
    assert.equal(encoded.ok, false);
    assert.deepEqual([...new Set(encoded.issues.map((i) => i.code))], ['CODEC_REQUIRED_NULL']);
    assert.ok(encoded.issues.some((i) => i.path === 'characters.name'));
    assert.equal(encoded.issues.every((i) => i.code === 'CODEC_REQUIRED_NULL'), true);
  } finally {
    seed.close();
  }
});

test('T03-07 INSERT/UPDATE/DELETE 模板按主键形状生成', async () => {
  const seed = await fresh();
  try {
    assert.equal(
      buildInsertSql('locations', ['branch_id', 'id', 'name']),
      'INSERT INTO locations (branch_id, id, name) VALUES (?, ?, ?)',
    );
    assert.equal(
      buildUpdateSql('locations', ['name']),
      'UPDATE locations SET name = ? WHERE branch_id = ? AND id = ?',
    );
    assert.equal(buildDeleteSql('locations'), 'DELETE FROM locations WHERE branch_id = ? AND id = ?');
    const idOnly = ['branches', 'turns', 'turn_changes', 'sync_outbox'].map((t) => buildDeleteSql(t));
    for (const table of ['branches', 'turns', 'turn_changes', 'sync_outbox']) {
      assert.equal(buildDeleteSql(table), `DELETE FROM ${table} WHERE id = ?`);
      assert.equal(buildUpdateSql(table, ['status']), `UPDATE ${table} SET status = ? WHERE id = ?`);
    }
    assert.equal(idOnly.length, 4);
  } finally {
    seed.close();
  }
});

test('T03-08 createRow 新人物只填 name+identity：默认值正确且位置字段为 NULL', async () => {
  const seed = await fresh();
  try {
    const row = createRow('characters', { name: '艾琳', identity: '教师' }, ctx({ id: IDS.L3 }));
    assert.deepEqual(
      {
        physical_status: row.physical_status,
        role: row.role,
        importance: row.importance,
        location_id: row.location_id,
        map_id: row.map_id,
        grid_x: row.grid_x,
        grid_y: row.grid_y,
        uncertainty_radius_cells: row.uncertainty_radius_cells,
        coord_precision: row.coord_precision,
        aliases_json: row.aliases_json,
      },
      {
        physical_status: 'unknown',
        role: 'npc',
        importance: 'supporting',
        location_id: null,
        map_id: null,
        grid_x: null,
        grid_y: null,
        uncertainty_radius_cells: null,
        coord_precision: 'unknown',
        aliases_json: [],
      },
    );
    assert.deepEqual([row.grid_x, row.map_id].map((v) => v === null), [true, true]);
    assert.equal(row.grid_x === 0, false);
  } finally {
    seed.close();
  }
});

test('T03-08b createRow 人物行过 encodeRow({requireAll:true}) 后可以真正插入', async () => {
  const seed = await fresh();
  try {
    const row = createRow('characters', { name: '艾琳', identity: '教师' }, ctx({ id: 'C_TEACHER' }));
    // 位置字段为 NULL，人物仍必须能建档（A31 完成定义）。
    assert.equal(row.location_id, null);
    inTransaction(seed.db, () => {
      seed.db.run('INSERT INTO entity_keys (branch_id, id, kind) VALUES (?, ?, ?)', [IDS.branchMain, 'C_TEACHER', 'character']);
      encodeInsert(seed.db, 'characters', row, { requireAll: true });
    });
    const decoded = decodeRow('characters', rawRow(seed.db, 'characters', 'C_TEACHER'));
    assert.equal(decoded.ok, true);
    assert.deepEqual(
      [decoded.row.physical_status, decoded.row.location_id, decoded.row.grid_x, decoded.row.grid_y],
      ['unknown', null, null, null],
    );
  } finally {
    seed.close();
  }
});

test('T03-09 createRow 新地点：kind/mobility/coord 默认与空坐标', async () => {
  const seed = await fresh();
  try {
    const row = createRow('locations', { name: '某地' }, ctx({ id: 'L_NEW' }));
    assert.deepEqual(
      {
        kind: row.kind,
        mobility: row.mobility,
        coord_precision: row.coord_precision,
        grid_x: row.grid_x,
        map_id: row.map_id,
      },
      { kind: 'other', mobility: 'fixed', coord_precision: 'unknown', grid_x: null, map_id: null },
    );
  } finally {
    seed.close();
  }
});

test('T03-10 各表默认状态机：势力/关系/信息/事件/计划/渠道/知情', async () => {
  const seed = await fresh();
  try {
    const faction = createRow('factions', { name: '某组织' }, ctx({ id: 'F_NEW' }));
    assert.equal(faction.kind, 'other');
    const relation = createRow('relations', { subject_entity_id: IDS.C1, object_entity_id: IDS.C2 }, ctx({ id: 'REL_NEW' }));
    assert.deepEqual(
      [relation.trust, relation.attitude, relation.secrecy],
      ['unknown', 'unknown', 'restricted'],
    );
    const information = createRow('information', { content: '城门今晚戒严。' }, ctx({ id: 'INF_NEW' }));
    assert.deepEqual([information.truth_status, information.secrecy], ['unknown', 'restricted']);
    const event = createRow('events', { title: '城门典礼' }, ctx({ id: 'EV_NEW' }));
    assert.deepEqual([event.status, event.occurred_at_s], ['scheduled', null]);
    const action = createRow('actions', { actor_entity_id: IDS.C3, title: '踩点' }, ctx({ id: 'ACT_NEW' }));
    assert.equal(action.status, 'planned');
    const channel = createRow('channels', { name: '暗卫报告网', owner_entity_id: IDS.F1 }, ctx({ id: 'CH_NEW' }));
    assert.equal(channel.secrecy, 'restricted');
    const knowledge = createRow('knowledge', { information_id: 'INF_NEW' }, ctx({ id: 'K_NEW' }));
    assert.equal(knowledge.status, 'active');
  } finally {
    seed.close();
  }
});

test('T03-11 snakeToCamel/camelToSnake 往返', async () => {
  const names = ['created_turn_id', 'meters_per_cell', 'is_pov'];
  assert.deepEqual(names.map((n) => snakeToCamel(n)), ['createdTurnId', 'metersPerCell', 'isPov']);
  assert.deepEqual(names.map((n) => camelToSnake(snakeToCamel(n))), names);
});

test('T03-12 decodeRowToCamel 返回 camelCase 键', async () => {
  const seed = await fresh();
  try {
    const decoded = decodeRowToCamel('characters', rawRow(seed.db, 'characters', IDS.C1));
    assert.equal(decoded.ok, true);
    assert.deepEqual(
      [decoded.row.createdTurnId, decoded.row.actionTendency, decoded.row.name],
      [IDS.seedTurn, '', '艾琳'],
    );
    assert.equal('created_turn_id' in decoded.row, false);
  } finally {
    seed.close();
  }
});

test('T03-13 JSON 列里的引号与分号 encode→insert→decode 逐字保留', async () => {
  const seed = await fresh();
  try {
    const payload = { note: 'he said "hi"; then left', tags: ['a"b', 'c;d'] };
    encodeInsert(seed.db, 'information', createRow('information', {
      content: '城门今晚戒严。',
      payload_json: payload,
    }, ctx({ id: 'INF_JSON' })));

    const raw = rawRow(seed.db, 'information', 'INF_JSON');
    assert.equal(typeof raw.payload_json, 'string');
    const decoded = decodeRow('information', raw);
    assert.equal(decoded.ok, true);
    assert.deepEqual(decoded.row.payload_json, payload);
  } finally {
    seed.close();
  }
});
