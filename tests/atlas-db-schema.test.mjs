/**
 * atlas-db-schema.test.mjs — T02 schema 断言（§17A A07–A28 完成定义）。
 *
 * 覆盖：恰 20 用户表、复合 FK 跨分支拒绝、零/有限负坐标有效、未知坐标 NULL、
 * 知识持有者互斥、同人双行程拒绝，以及各表 CHECK 的实际拒绝行为。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, insertRows, inTransaction, foreignKeyCheck, userTables } from './fixtures/atlas-sql/seed.mjs';
import {
  ATLAS_TABLE_COLUMNS,
  ATLAS_SCHEMA_VERSION,
  installSchema,
  isKnownTable,
  primaryKeyColumns,
  tableColumnNames,
  USER_TABLE_COUNT,
  ATLAS_INDEXES,
} from '../src/atlas-db-schema.ts';

const SQL = await (await import('sql.js')).default();

async function fresh() {
  return makeSeedWith(SQL);
}

test('T02-01 用户表恰好 20 张，且覆盖 §1.1 总表单', async () => {
  const seed = await fresh();
  try {
    const tables = userTables(seed.db);
    assert.equal(tables.length, 20);
    assert.equal(USER_TABLE_COUNT, 20);
    assert.deepEqual(tables, [...tables].sort());
    const expected = [
      'maps', 'locations', 'characters', 'items', 'factions', 'relations', 'routes', 'actions', 'journeys',
      'events', 'information', 'rumor_fronts', 'knowledge', 'channels',
      'entity_keys', 'branches', 'turns', 'turn_changes', 'mention_candidates', 'sync_outbox',
    ].sort();
    assert.deepEqual(tables, expected);
  } finally {
    seed.close();
  }
});

test('T02-02 schema_version 写入 user_version；foreign_key_check 为空', async () => {
  const seed = await fresh();
  try {
    const version = seed.db.exec('PRAGMA user_version');
    assert.equal(Number(version[0].values[0][0]), ATLAS_SCHEMA_VERSION);
    assert.deepEqual(foreignKeyCheck(seed.db), []);
  } finally {
    seed.close();
  }
});

test('T02-03 打开连接后、开启事务之前外键已读回为 1', async () => {
  const seed = await fresh();
  try {
    const fk = seed.db.exec('PRAGMA foreign_keys');
    assert.equal(Number(fk[0].values[0][0]), 1);
  } finally {
    seed.close();
  }
});

test('T02-04 复合外键跨分支拒绝：C1 的 location_id 不能指向另一分支的地点', async () => {
  const seed = await fresh();
  try {
    // main-B 里没有 L2；用 main-B 的 branch_id + L2 组合应被拒绝。
    assert.throws(
      () =>
        inTransaction(seed.db, () => {
          seed.db.run(`INSERT INTO entity_keys (branch_id, id, kind) VALUES ('main-B','L9','location')`);
          seed.db.run(
            `INSERT INTO locations (branch_id, id, row_rev, created_turn_id, updated_turn_id, name, aliases_json, kind, mobility, coord_precision, terrain, existence_quality, status)
             VALUES ('main-B','L9',1,'turn_seed_B','turn_seed_B','跨分支','[]','city','fixed','unknown','unknown','confirmed','active')`,
          );
          seed.db.run(`UPDATE characters SET location_id = 'L9' WHERE branch_id = 'main-A' AND id = 'C1'`);
        }),
      /FOREIGN KEY|constraint/i,
    );
    // 失败后 C1 位置保持不变
    const row = seed.db.exec(`SELECT location_id FROM characters WHERE branch_id='main-A' AND id='C1'`);
    assert.equal(row[0].values[0][0], IDS.L2);
  } finally {
    seed.close();
  }
});

test('T02-05 实体身份类型必须与详情表一致（触发器拒绝）', async () => {
  const seed = await fresh();
  try {
    assert.throws(
      () =>
        inTransaction(seed.db, () => {
          seed.db.run(
            `INSERT INTO factions (branch_id, id, row_rev, created_turn_id, updated_turn_id, name, aliases_json, kind, capabilities_json, status)
             VALUES ('main-A','C1',1,'turn_seed_A','turn_seed_A','错类型','[]','other','[]','active')`,
          );
        }),
      /ENTITY_KEY_KIND_MISMATCH/,
    );
  } finally {
    seed.close();
  }
});

test('T02-06 只有身份没有详情时闭合校验能发现（不静默）', async () => {
  const seed = await fresh();
  try {
    inTransaction(seed.db, () => {
      seed.db.run(`INSERT INTO entity_keys (branch_id, id, kind) VALUES ('main-A','LONELY','location')`);
    });
    const { validateCandidate } = await import('../src/atlas-db-invariants.ts');
    const result = validateCandidate(seed.db, { branchId: 'main-A' });
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.code === 'INVARIANT_KEY_WITHOUT_ENTITY'));
  } finally {
    seed.close();
  }
});

test('T02-07 坐标：零与有限负数合法；单边坐标非法；未知坐标保持 NULL', async () => {
  const seed = await fresh();
  try {
    inTransaction(seed.db, () => {
      seed.db.run(`UPDATE locations SET grid_x = 0, grid_y = -3.5 WHERE branch_id='main-A' AND id='L1'`);
    });
    const row = seed.db.exec(`SELECT grid_x, grid_y FROM locations WHERE branch_id='main-A' AND id='L1'`);
    assert.equal(row[0].values[0][0], 0);
    assert.equal(row[0].values[0][1], -3.5);

    assert.throws(
      () => inTransaction(seed.db, () => seed.db.run(`UPDATE locations SET grid_x = 5, grid_y = NULL WHERE branch_id='main-A' AND id='L1'`)),
      /CHECK/i,
    );
    assert.throws(
      () => inTransaction(seed.db, () => seed.db.run(`UPDATE locations SET map_id = NULL WHERE branch_id='main-A' AND id='L1'`)),
      /CHECK/i,
    );
    // 未知坐标：粗定位人物保持三列为 NULL（人物不把 layout 当实际位置另有 CHECK）
    const c3 = seed.db.exec(`SELECT map_id, grid_x, grid_y, coord_precision FROM characters WHERE branch_id='main-A' AND id='C3'`);
    assert.deepEqual(c3[0].values[0], [null, null, null, 'unknown']);
  } finally {
    seed.close();
  }
});

test('T02-08 人物 coord_precision 不接受 layout', async () => {
  const seed = await fresh();
  try {
    assert.throws(
      () => inTransaction(seed.db, () => seed.db.run(`UPDATE characters SET coord_precision='layout' WHERE branch_id='main-A' AND id='C1'`)),
      /CHECK/i,
    );
  } finally {
    seed.close();
  }
});

test('T02-09 知识持有者互斥（人物/势力/pov 恰选一个）', async () => {
  const seed = await fresh();
  try {
    inTransaction(seed.db, () => {
      seed.db.run(
        `INSERT INTO information (branch_id, id, row_rev, created_turn_id, updated_turn_id, kind, title, content, truth_status, secrecy, topic_key, content_hash, created_at_s, status)
         VALUES ('main-A','INFO1',1,'turn_seed_A','turn_seed_A','rumor','传言','城里有传言','unknown','public','t1','h1',0,'active')`,
      );
      seed.db.run(
        `INSERT INTO knowledge (branch_id, id, row_rev, created_turn_id, updated_turn_id, knower_character_id, knower_faction_id, is_pov, information_id, first_received_at_s, belief, attention, status)
         VALUES ('main-A','K1',1,'turn_seed_A','turn_seed_A','C1',NULL,0,'INFO1',0,'heard','normal','active')`,
      );
    });
    assert.throws(
      () =>
        inTransaction(seed.db, () => {
          seed.db.run(
            `INSERT INTO knowledge (branch_id, id, row_rev, created_turn_id, updated_turn_id, knower_character_id, knower_faction_id, is_pov, information_id, first_received_at_s, belief, attention, status)
             VALUES ('main-A','K2',1,'turn_seed_A','turn_seed_A','C2','F1',0,'INFO1',0,'heard','normal','active')`,
          );
        }),
      /CHECK/i,
    );
    assert.throws(
      () =>
        inTransaction(seed.db, () => {
          seed.db.run(
            `INSERT INTO knowledge (branch_id, id, row_rev, created_turn_id, updated_turn_id, knower_character_id, knower_faction_id, is_pov, information_id, first_received_at_s, belief, attention, status)
             VALUES ('main-A','K3',1,'turn_seed_A','turn_seed_A',NULL,NULL,0,'INFO1',0,'heard','normal','active')`,
          );
        }),
      /CHECK/i,
    );
  } finally {
    seed.close();
  }
});

test('T02-10 同一持有者对同一信息只有一条当前认知（部分唯一索引）', async () => {
  const seed = await fresh();
  try {
    inTransaction(seed.db, () => {
      seed.db.run(
        `INSERT INTO information (branch_id, id, row_rev, created_turn_id, updated_turn_id, kind, title, content, truth_status, secrecy, topic_key, content_hash, created_at_s, status)
         VALUES ('main-A','INFO1',1,'turn_seed_A','turn_seed_A','rumor','传言','城里有传言','unknown','public','t1','h1',0,'active')`,
      );
      seed.db.run(
        `INSERT INTO knowledge (branch_id, id, row_rev, created_turn_id, updated_turn_id, knower_character_id, is_pov, information_id, first_received_at_s, belief, attention, status)
         VALUES ('main-A','K1',1,'turn_seed_A','turn_seed_A','C1',0,'INFO1',0,'heard','normal','active')`,
      );
    });
    assert.throws(
      () =>
        inTransaction(seed.db, () => {
          seed.db.run(
            `INSERT INTO knowledge (branch_id, id, row_rev, created_turn_id, updated_turn_id, knower_character_id, is_pov, information_id, first_received_at_s, belief, attention, status)
             VALUES ('main-A','K2',1,'turn_seed_A','turn_seed_A','C1',0,'INFO1',0,'believed','high','active')`,
          );
        }),
      /UNIQUE/i,
    );
    // pov 与人物两条互不冲突；但 pov 自己也只能一条
    inTransaction(seed.db, () => {
      seed.db.run(
        `INSERT INTO knowledge (branch_id, id, row_rev, created_turn_id, updated_turn_id, knower_character_id, is_pov, information_id, first_received_at_s, belief, attention, status)
         VALUES ('main-A','K3',1,'turn_seed_A','turn_seed_A',NULL,1,'INFO1',0,'heard','normal','active')`,
      );
    });
    assert.throws(
      () =>
        inTransaction(seed.db, () => {
          seed.db.run(
            `INSERT INTO knowledge (branch_id, id, row_rev, created_turn_id, updated_turn_id, knower_character_id, is_pov, information_id, first_received_at_s, belief, attention, status)
             VALUES ('main-A','K4',1,'turn_seed_A','turn_seed_A',NULL,1,'INFO1',0,'heard','normal','active')`,
          );
        }),
      /UNIQUE/i,
    );
  } finally {
    seed.close();
  }
});

test('T02-11 同一 mover 不能有两条未结束行程（部分唯一索引）', async () => {
  const seed = await fresh();
  try {
    const insertJourney = (id, status) =>
      inTransaction(seed.db, () => {
        seed.db.run(
          `INSERT INTO actions (branch_id, id, row_rev, created_turn_id, updated_turn_id, actor_entity_id, kind, title, intent, depends_on_json, progress_s, evaluated_until_s, secrecy, priority, status)
           VALUES ('main-A','${id}_A',1,'turn_seed_A','turn_seed_A','C2','travel','去学校','','[]',0,0,'restricted','normal','active')`,
        );
        seed.db.run(
          `INSERT INTO journeys (branch_id, id, row_rev, created_turn_id, updated_turn_id, action_id, mover_entity_id, origin_location_id, destination_location_id, segments_json, segment_index, segment_time_done_s, started_at_s, last_advanced_at_s, position_quality, status)
           VALUES ('main-A','${id}','1','turn_seed_A','turn_seed_A','${id}_A','C2','L1','L2','[]',0,0,0,0,'route_estimated','${status}')`,
        );
      });

    insertJourney('J1', 'moving');
    assert.throws(() => insertJourney('J2', 'paused'), /UNIQUE/i);

    // arrived 不算未结束：可以再开一条
    inTransaction(seed.db, () => {
      seed.db.run(`UPDATE journeys SET status='arrived', arrived_at_s=10 WHERE branch_id='main-A' AND id='J1'`);
    });
    insertJourney('J3', 'moving');
    const count = seed.db.exec(`SELECT COUNT(*) FROM journeys WHERE branch_id='main-A'`);
    assert.equal(Number(count[0].values[0][0]), 2);
  } finally {
    seed.close();
  }
});

test('T02-12 一件物品只能有一个实际位置来源（holder/container/location 互斥）', async () => {
  const seed = await fresh();
  try {
    assert.throws(
      () =>
        inTransaction(seed.db, () => {
          seed.db.run(`UPDATE items SET location_id='L1' WHERE branch_id='main-A' AND id='I1'`);
        }),
      /CHECK/i,
    );
  } finally {
    seed.close();
  }
});

test('T02-13 数量非负或 NULL；数量为 0 仍可写但业务层转 consumed', async () => {
  const seed = await fresh();
  try {
    inTransaction(seed.db, () => {
      seed.db.run(`UPDATE items SET quantity=NULL WHERE branch_id='main-A' AND id='I1'`);
    });
    assert.throws(
      () => inTransaction(seed.db, () => seed.db.run(`UPDATE items SET quantity=-1 WHERE branch_id='main-A' AND id='I1'`)),
      /CHECK/i,
    );
  } finally {
    seed.close();
  }
});

test('T02-14 地点父链：不能以自己为父', async () => {
  const seed = await fresh();
  try {
    assert.throws(
      () => inTransaction(seed.db, () => seed.db.run(`UPDATE locations SET parent_location_id='L1' WHERE branch_id='main-A' AND id='L1'`)),
      /CHECK/i,
    );
  } finally {
    seed.close();
  }
});

test('T02-15 events：occurred 必须有实际时刻；scheduled 可以没有', async () => {
  const seed = await fresh();
  try {
    inTransaction(seed.db, () => {
      seed.db.run(
        `INSERT INTO events (branch_id, id, row_rev, created_turn_id, updated_turn_id, title, kind, summary, participants_json, secrecy, status)
         VALUES ('main-A','E1',1,'turn_seed_A','turn_seed_A','国王典礼','ceremony','','[]','public','scheduled')`,
      );
    });
    assert.throws(
      () =>
        inTransaction(seed.db, () => {
          seed.db.run(
            `INSERT INTO events (branch_id, id, row_rev, created_turn_id, updated_turn_id, title, kind, summary, participants_json, secrecy, status)
             VALUES ('main-A','E2',1,'turn_seed_A','turn_seed_A','假装发生','other','','[]','public','occurred')`,
          );
        }),
      /CHECK/i,
    );
  } finally {
    seed.close();
  }
});

test('T02-16 information：false 的谣言可以没有 source_event', async () => {
  const seed = await fresh();
  try {
    inTransaction(seed.db, () => {
      seed.db.run(
        `INSERT INTO information (branch_id, id, row_rev, created_turn_id, updated_turn_id, kind, title, content, truth_status, secrecy, topic_key, content_hash, created_at_s, status)
         VALUES ('main-A','INFO_R',1,'turn_seed_A','turn_seed_A','rumor','假传言','国王已死','false','public','t','h',0,'active')`,
      );
    });
    const row = seed.db.exec(`SELECT source_event_id, truth_status FROM information WHERE id='INFO_R'`);
    assert.deepEqual(row[0].values[0], [null, 'false']);
  } finally {
    seed.close();
  }
});

test('T02-17 rumor_fronts 同消息同地点不会无限重复插入', async () => {
  const seed = await fresh();
  try {
    const insert = () =>
      inTransaction(seed.db, () => {
        seed.db.run(
          `INSERT INTO rumor_fronts (branch_id, id, row_rev, created_turn_id, updated_turn_id, information_id, location_id, first_available_at_s, last_reinforced_at_s, reach, audience_json, status)
           VALUES ('main-A','FR1',1,'turn_seed_A','turn_seed_A','INFO_R','L1',0,0,'local','{"access":"public","tags":[]}','active')`,
        );
      });
    seed.db.run(
      `INSERT INTO information (branch_id, id, row_rev, created_turn_id, updated_turn_id, kind, title, content, truth_status, secrecy, topic_key, content_hash, created_at_s, status)
       VALUES ('main-A','INFO_R',1,'turn_seed_A','turn_seed_A','rumor','假传言','国王已死','false','public','t','h',0,'active')`,
    );
    insert();
    assert.throws(() => insert(), /UNIQUE/i);
  } finally {
    seed.close();
  }
});

test('T02-18 channels：不接受同时两个 recipient；范围不能为空字符串容器', async () => {
  const seed = await fresh();
  try {
    assert.throws(
      () =>
        inTransaction(seed.db, () => {
          seed.db.run(
            `INSERT INTO channels (branch_id, id, row_rev, created_turn_id, updated_turn_id, name, kind, owner_entity_id, source_entity_id, source_location_id, recipient_entity_id, recipient_location_id, scope_json, latency_json, reliability, secrecy, basis_quality, valid_from_s, status)
             VALUES ('main-A','CH1',1,'turn_seed_A','turn_seed_A','暗卫','surveillance','F1','C4','L1','C1','L1','{}','{}','high','secret','confirmed',0,'active')`,
          );
        }),
      /CHECK/i,
    );
  } finally {
    seed.close();
  }
});

test('T02-19 turn_changes：turn+sequence 唯一，group+table+row 唯一，operation_id 不单独唯一', async () => {
  const seed = await fresh();
  try {
    const insert = (id, sequence, groupId, table, rowId, operationId) =>
      inTransaction(seed.db, () => {
        seed.db.run(
          `INSERT INTO turn_changes (id, turn_id, sequence, attempt_id, group_id, operation_id, target_table, target_row_id, operation, before_json, after_json, basis_json, summary)
           VALUES (?, 'turn_seed_A', ?, 'att', ?, ?, ?, ?, 'update', NULL, '{}', '{}', '')`,
          [id, sequence, groupId, operationId, table, rowId],
        );
      });
    insert('TC1', 1, 'G1', 'characters', 'C1', 'OP1');
    assert.throws(() => insert('TC2', 1, 'G2', 'characters', 'C2', 'OP2'), /UNIQUE/i);
    assert.throws(() => insert('TC3', 2, 'G1', 'characters', 'C1', 'OP3'), /UNIQUE/i);
    // 同一 operation_id 改不同行是合法的（一个 op 可改多行）
    insert('TC4', 3, 'G2', 'characters', 'C2', 'OP1');
    const n = seed.db.exec('SELECT COUNT(*) FROM turn_changes');
    assert.equal(Number(n[0].values[0][0]), 2);
  } finally {
    seed.close();
  }
});

test('T02-20 sync_outbox：idempotency_key 唯一；重试用 wall 时间', async () => {
  const seed = await fresh();
  try {
    const insert = () =>
      inTransaction(seed.db, () => {
        seed.db.run(
          `INSERT INTO sync_outbox (id, branch_id, requested_by_turn_id, target, projection_scope, target_revision, idempotency_key, payload_hash, status, attempt_count, created_wall_ms)
           VALUES ('O1','main-A','turn_seed_A','managed_lorebook','pov',1,'K1','H1','pending',0,1000)`,
        );
      });
    insert();
    assert.throws(() => insert(), /UNIQUE/i);
    const row = seed.db.exec('SELECT next_retry_wall_ms, created_wall_ms FROM sync_outbox');
    assert.equal(row[0].values[0][0], null);
    assert.equal(Number(row[0].values[0][1]), 1000);
  } finally {
    seed.close();
  }
});

test('T02-21 branches 时钟顺序：clock_min ≤ clock ≤ clock_max，负时间非法', async () => {
  const seed = await fresh();
  try {
    assert.throws(
      () => inTransaction(seed.db, () => seed.db.run(`UPDATE branches SET clock_s = -1 WHERE id='main-A'`)),
      /CHECK/i,
    );
    inTransaction(seed.db, () => seed.db.run(`UPDATE branches SET clock_min_s = 0, clock_s = 5, clock_max_s = 10 WHERE id='main-A'`));
    assert.throws(
      () => inTransaction(seed.db, () => seed.db.run(`UPDATE branches SET clock_s = 11 WHERE id='main-A'`)),
      /CHECK/i,
    );
  } finally {
    seed.close();
  }
});

test('T02-22 routes 距离区间次序合法；两端不能相同', async () => {
  const seed = await fresh();
  try {
    assert.throws(
      () => inTransaction(seed.db, () => seed.db.run(`UPDATE routes SET distance_min_m = 20000 WHERE branch_id='main-A' AND id='R_AB'`)),
      /CHECK/i,
    );
    assert.throws(
      () => inTransaction(seed.db, () => seed.db.run(`UPDATE routes SET to_location_id = 'L1' WHERE branch_id='main-A' AND id='R_AB'`)),
      /CHECK/i,
    );
  } finally {
    seed.close();
  }
});

test('T02-23 maps 比例尺为正或 NULL；活跃非空容器唯一', async () => {
  const seed = await fresh();
  try {
    assert.throws(
      () => inTransaction(seed.db, () => seed.db.run(`UPDATE maps SET meters_per_cell = 0 WHERE branch_id='main-A' AND id='M1'`)),
      /CHECK/i,
    );
    assert.throws(
      () =>
        inTransaction(seed.db, () => {
          seed.db.run(
            `INSERT INTO maps (branch_id, id, row_rev, created_turn_id, updated_turn_id, name, kind, container_location_id, frame_json, scale_quality, scale_basis_json, scale_locked, calibration_rev, default_terrain, status)
             VALUES ('main-A','M3',1,'turn_seed_A','turn_seed_A','重复教室图','interior','L3','{}','uncalibrated','',0,1,'unknown','active')`,
          );
        }),
      /UNIQUE/i,
    );
  } finally {
    seed.close();
  }
});

test('T02-24 mention_candidates：distinct_turn_count ≥ 1；same-turn 重试不叠加由业务层保证', async () => {
  const seed = await fresh();
  try {
    assert.throws(
      () =>
        inTransaction(seed.db, () => {
          seed.db.run(
            `INSERT INTO mention_candidates (branch_id, id, name, normalized_name, context_key, kind_hint, first_turn_id, last_turn_id, distinct_turn_count, recent_turn_ids_json, context_summary, lorebook_source_keys_json, importance_hint, status)
             VALUES ('main-A','MNT1','路人','路人','','unknown','turn_seed_A','turn_seed_A',0,'[]','','[]','none','watching')`,
          );
        }),
      /CHECK/i,
    );
  } finally {
    seed.close();
  }
});

test('T02-25 内部表不套用共同字段 C；业务表主键为 (branch_id, id)', async () => {
  assert.deepEqual(primaryKeyColumns('locations'), ['branch_id', 'id']);
  assert.deepEqual(primaryKeyColumns('characters'), ['branch_id', 'id']);
  assert.deepEqual(primaryKeyColumns('branches'), ['id']);
  assert.deepEqual(primaryKeyColumns('turns'), ['id']);
  assert.deepEqual(primaryKeyColumns('turn_changes'), ['id']);
  assert.deepEqual(primaryKeyColumns('sync_outbox'), ['id']);
  assert.deepEqual(primaryKeyColumns('mention_candidates').slice().sort(), ['branch_id', 'id']);
});

test('T02-26 所有 20 张表都有列清单；未知表名不通过 isKnownTable', () => {
  const tables = Object.keys(ATLAS_TABLE_COLUMNS);
  assert.equal(tables.length, 20);
  for (const table of tables) {
    assert.ok(tableColumnNames(table).length > 2, `${table} 列数异常`);
  }
  assert.equal(isKnownTable('sqlite_master'), false);
  assert.equal(isKnownTable('world'), false);
});

test('T02-27 业务表都含五项共同字段', () => {
  const business = [
    'maps', 'locations', 'characters', 'items', 'factions', 'relations', 'routes', 'actions', 'journeys',
    'events', 'information', 'rumor_fronts', 'knowledge', 'channels',
  ];
  for (const table of business) {
    const cols = tableColumnNames(table);
    for (const c of ['branch_id', 'id', 'row_rev', 'created_turn_id', 'updated_turn_id']) {
      assert.ok(cols.includes(c), `${table} 缺少 ${c}`);
    }
  }
});

test('T02-28 索引清单落地：核心索引存在', async () => {
  const seed = await fresh();
  try {
    const rows = seed.db.exec("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'");
    const names = new Set(rows[0].values.map((r) => String(r[0])));
    assert.ok(ATLAS_INDEXES.length >= 40, `索引数量偏少：${ATLAS_INDEXES.length}`);
    for (const spec of ATLAS_INDEXES) {
      assert.ok(names.has(spec.name), `缺索引 ${spec.name}`);
    }
  } finally {
    seed.close();
  }
});

test('T02-29 installSchema 幂等：重复安装不报错且表数不变', async () => {
  const seed = await fresh();
  try {
    installSchema(seed.db);
    installSchema(seed.db);
    assert.equal(userTables(seed.db).length, 20);
  } finally {
    seed.close();
  }
});

test('T02-30 row_rev 必须正整数', async () => {
  const seed = await fresh();
  try {
    assert.throws(
      () => inTransaction(seed.db, () => seed.db.run(`UPDATE characters SET row_rev = 0 WHERE branch_id='main-A' AND id='C1'`)),
      /CHECK/i,
    );
  } finally {
    seed.close();
  }
});
