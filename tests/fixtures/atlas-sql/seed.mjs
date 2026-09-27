/**
 * tests/fixtures/atlas-sql/seed.mjs — T00 公用离线夹具（§18.1）。
 *
 * 单一合成世界：chat-A/main-A、chat-B/main-B；城市 L1、学校 L2、教室 L3；
 * 人物 C1 艾琳 / C2 信使 / C3 刺客 / C4 国王；物品 I1 剑；势力 F1 王国；
 * 世界图 M1 米/格=100、教室图 M2 米/格=1；A—B 路 12km、B—C 路 8km；
 * C2 步行速度固定 6km/h；初始 clock=08:00 相对基准的 0。
 *
 * 短引用由 seed 提供；**不含真实用户文本、密钥或外部网络数据**。
 * 测试 case 自己在事务内创建附加行；不要为了让测试成功关闭 foreign_keys。
 */

import initSqlJs from 'sql.js';
import { installSchema, ATLAS_SCHEMA_VERSION } from '../../../src/atlas-db-schema.ts';

export const CLOCK_BASE_S = 0; // 08:00
export const WALK_MPS = 6 * 1000 / 3600; // 6 km/h ≈ 1.6667 m/s

export const IDS = {
  branchMain: 'main-A',
  branchB: 'main-B',
  chatA: 'chat-A',
  chatB: 'chat-B',
  seedTurn: 'turn_seed_A',
  seedTurnB: 'turn_seed_B',
  L1: 'L1',
  L2: 'L2',
  L3: 'L3',
  C1: 'C1',
  C2: 'C2',
  C3: 'C3',
  C4: 'C4',
  I1: 'I1',
  F1: 'F1',
  M1: 'M1',
  M2: 'M2',
  R_AB: 'R_AB',
  R_BC: 'R_BC',
};

const nowWallMs = 1_700_000_000_000;

/** 短引用表：模型在上下文里看到的就是这些，不需要记数据库 ID。 */
export function shortRefs() {
  return [
    { alias: 'L1', id: IDS.L1, kind: 'location' },
    { alias: 'L2', id: IDS.L2, kind: 'location' },
    { alias: 'L3', id: IDS.L3, kind: 'location' },
    { alias: 'C1', id: IDS.C1, kind: 'character' },
    { alias: 'C2', id: IDS.C2, kind: 'character' },
    { alias: 'C3', id: IDS.C3, kind: 'character' },
    { alias: 'C4', id: IDS.C4, kind: 'character' },
    { alias: 'I1', id: IDS.I1, kind: 'item' },
    { alias: 'F1', id: IDS.F1, kind: 'faction' },
    { alias: 'M1', id: IDS.M1, kind: 'map' },
    { alias: 'M2', id: IDS.M2, kind: 'map' },
  ];
}

function c(branchId, id, turnId = IDS.seedTurn) {
  return { branch_id: branchId, id, row_rev: 1, created_turn_id: turnId, updated_turn_id: turnId };
}

function rowsFor(branchId, turnId) {
  return {
    entity_keys: [
      { branch_id: branchId, id: IDS.L1, kind: 'location' },
      { branch_id: branchId, id: IDS.L2, kind: 'location' },
      { branch_id: branchId, id: IDS.L3, kind: 'location' },
      { branch_id: branchId, id: IDS.C1, kind: 'character' },
      { branch_id: branchId, id: IDS.C2, kind: 'character' },
      { branch_id: branchId, id: IDS.C3, kind: 'character' },
      { branch_id: branchId, id: IDS.C4, kind: 'character' },
      { branch_id: branchId, id: IDS.I1, kind: 'item' },
      { branch_id: branchId, id: IDS.F1, kind: 'faction' },
    ],
    maps: [
      {
        ...c(branchId, IDS.M1, turnId),
        name: '世界图',
        kind: 'world',
        container_location_id: null,
        description: '',
        frame_json: JSON.stringify({ origin_x: 0, origin_y: 0, reference_width_cells: 120, reference_height_cells: 80 }),
        meters_per_cell: 100,
        scale_min_meters_per_cell: 100,
        scale_max_meters_per_cell: 100,
        scale_quality: 'confirmed',
        scale_basis_json: '{}',
        scale_locked: 0,
        calibration_rev: 1,
        background_asset_key: null,
        default_terrain: 'unknown',
        status: 'active',
      },
      {
        ...c(branchId, IDS.M2, turnId),
        name: '教室图',
        kind: 'interior',
        container_location_id: IDS.L3,
        description: '',
        frame_json: JSON.stringify({ origin_x: 0, origin_y: 0, reference_width_cells: 20, reference_height_cells: 15 }),
        meters_per_cell: 1,
        scale_min_meters_per_cell: 1,
        scale_max_meters_per_cell: 1,
        scale_quality: 'confirmed',
        scale_basis_json: '{}',
        scale_locked: 0,
        calibration_rev: 1,
        background_asset_key: null,
        default_terrain: 'unknown',
        status: 'active',
      },
    ],
    locations: [
      {
        ...c(branchId, IDS.L1, turnId),
        name: '圣罗兰城',
        aliases_json: '["圣罗兰"]',
        kind: 'city',
        description: '城墙与市场',
        parent_location_id: null,
        mobility: 'fixed',
        anchor_location_id: null,
        map_id: IDS.M1,
        grid_x: 10,
        grid_y: 10,
        coord_precision: 'exact',
        uncertainty_radius_cells: null,
        area_geometry_json: null,
        terrain: 'road',
        access_rules_json: null,
        vehicle_profile_json: null,
        existence_quality: 'confirmed',
        status: 'active',
        merged_into_id: null,
      },
      {
        ...c(branchId, IDS.L2, turnId),
        name: '圣光学校',
        aliases_json: '[]',
        kind: 'building',
        description: '',
        parent_location_id: IDS.L1,
        mobility: 'fixed',
        anchor_location_id: null,
        map_id: IDS.M1,
        grid_x: 12,
        grid_y: 11,
        coord_precision: 'approximate',
        uncertainty_radius_cells: 0.5,
        area_geometry_json: null,
        terrain: 'road',
        access_rules_json: null,
        vehicle_profile_json: null,
        existence_quality: 'confirmed',
        status: 'active',
        merged_into_id: null,
      },
      {
        ...c(branchId, IDS.L3, turnId),
        name: '教室',
        aliases_json: '[]',
        kind: 'room',
        description: '',
        parent_location_id: IDS.L2,
        mobility: 'fixed',
        anchor_location_id: null,
        map_id: IDS.M2,
        grid_x: 5,
        grid_y: 6,
        coord_precision: 'exact',
        uncertainty_radius_cells: null,
        area_geometry_json: null,
        terrain: 'unknown',
        access_rules_json: null,
        vehicle_profile_json: null,
        existence_quality: 'confirmed',
        status: 'active',
        merged_into_id: null,
      },
    ],
    characters: [
      {
        ...c(branchId, IDS.C1, turnId),
        name: '艾琳',
        aliases_json: '[]',
        role: 'npc',
        identity: '学校教师',
        description: '',
        personality: '',
        importance: 'recurring',
        importance_reason: '世界书明确描述',
        thought: '',
        action_tendency: '',
        physical_status: 'alive',
        condition_note: '',
        location_id: IDS.L2,
        map_id: null,
        grid_x: null,
        grid_y: null,
        coord_precision: 'unknown',
        uncertainty_radius_cells: null,
        mobility_profiles_json: JSON.stringify([{ key: 'walk', label: '步行', mode: 'walk', speed_min_mps: 0.8, speed_nominal_mps: 1.4, speed_max_mps: 1.8, speed_basis: 'preset', constraints: { terrain_allow: [], terrain_deny: [], requirements: [] }, basis_refs: [], enabled: true }]),
        capabilities_json: '[]',
        status: 'active',
        merged_into_id: null,
      },
      {
        ...c(branchId, IDS.C2, turnId),
        name: '信使',
        aliases_json: '[]',
        role: 'npc',
        identity: '王家信使',
        description: '',
        personality: '',
        importance: 'supporting',
        importance_reason: '送信',
        thought: '',
        action_tendency: '',
        physical_status: 'alive',
        condition_note: '',
        location_id: IDS.L1,
        map_id: IDS.M1,
        grid_x: 10.5,
        grid_y: 10.5,
        coord_precision: 'approximate',
        uncertainty_radius_cells: 0.25,
        // 固定 6km/h 的步行能力（§18.1）
        mobility_profiles_json: JSON.stringify([{ key: 'walk6', label: '步行（固定 6km/h）', mode: 'walk', speed_min_mps: WALK_MPS, speed_nominal_mps: WALK_MPS, speed_max_mps: WALK_MPS, speed_basis: 'worldbook', constraints: { terrain_allow: [], terrain_deny: [], requirements: [] }, basis_refs: [], enabled: true }]),
        capabilities_json: '[]',
        status: 'active',
        merged_into_id: null,
      },
      {
        ...c(branchId, IDS.C3, turnId),
        name: '刺客',
        aliases_json: '[]',
        role: 'npc',
        identity: '不明的杀手',
        description: '',
        personality: '',
        importance: 'core',
        importance_reason: '后台剧情关键',
        thought: '',
        action_tendency: '',
        physical_status: 'alive',
        condition_note: '',
        location_id: IDS.L1,
        map_id: null,
        grid_x: null,
        grid_y: null,
        coord_precision: 'unknown',
        uncertainty_radius_cells: null,
        mobility_profiles_json: '[]',
        capabilities_json: '[]',
        status: 'active',
        merged_into_id: null,
      },
      {
        ...c(branchId, IDS.C4, turnId),
        name: '国王',
        aliases_json: '[]',
        role: 'npc',
        identity: '在位君主',
        description: '',
        personality: '',
        importance: 'core',
        importance_reason: '典礼主角',
        thought: '',
        action_tendency: '',
        physical_status: 'alive',
        condition_note: '',
        location_id: IDS.L1,
        map_id: null,
        grid_x: null,
        grid_y: null,
        coord_precision: 'unknown',
        uncertainty_radius_cells: null,
        mobility_profiles_json: '[]',
        capabilities_json: '[]',
        status: 'active',
        merged_into_id: null,
      },
    ],
    items: [
      {
        ...c(branchId, IDS.I1, turnId),
        name: '剑',
        aliases_json: '[]',
        kind: 'equipment',
        description: '',
        quantity: 1,
        unit: '把',
        condition_note: '',
        owner_entity_id: IDS.C1,
        holder_character_id: IDS.C1,
        container_item_id: null,
        location_id: null,
        map_id: null,
        grid_x: null,
        grid_y: null,
        coord_precision: 'unknown',
        uncertainty_radius_cells: null,
        properties_json: '[]',
        status: 'active',
        merged_into_id: null,
      },
    ],
    factions: [
      {
        ...c(branchId, IDS.F1, turnId),
        name: '王国',
        aliases_json: '[]',
        kind: 'nation',
        description: '',
        goal: '',
        headquarters_location_id: IDS.L1,
        capabilities_json: '[]',
        status: 'active',
        merged_into_id: null,
      },
    ],
    routes: [
      {
        ...c(branchId, IDS.R_AB, turnId),
        from_location_id: IDS.L1,
        to_location_id: IDS.L2,
        kind: 'road',
        bidirectional: 1,
        map_id: IDS.M1,
        geometry_json: null,
        geometry_quality: 'estimated',
        geometry_rev: 1,
        distance_m: 12000,
        distance_min_m: 12000,
        distance_max_m: 12000,
        distance_basis: 'narrative',
        terrain: 'road',
        allowed_modes_json: '["walk","ride"]',
        access_rules_json: null,
        travel_time_override_json: null,
        status: 'open',
        status_reason: '',
      },
    ],
    relations: [
      {
        ...c(branchId, 'REL_C1_F1', turnId),
        subject_entity_id: IDS.C1,
        object_entity_id: IDS.F1,
        kind: 'member_of',
        label: '教师',
        attitude: 'supportive',
        trust: 'medium',
        description: '',
        basis_quality: 'confirmed',
        secrecy: 'public',
        valid_from_s: 0,
        valid_until_s: null,
        status: 'active',
      },
    ],
  };
}

/** 用参数绑定写入固定列（列名来自代码常量，值全部绑定）。 */
export function insertRows(db, table, rows) {
  for (const row of rows) {
    const columns = Object.keys(row);
    const placeholders = columns.map(() => '?').join(', ');
    const params = columns.map((col) => {
      const value = row[col];
      if (value === null || value === undefined) return null;
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (typeof value === 'object') return JSON.stringify(value);
      return value;
    });
    db.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`, params);
  }
}

export async function makeSeed() {
  const SQL = await initSqlJs();
  return makeSeedWith(SQL);
}

export async function makeSeedWith(SQL) {
  const db = new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  installSchema(db);

  const branchIds = [
    { branchId: IDS.branchMain, turnId: IDS.seedTurn, name: '主线' },
    { branchId: IDS.branchB, turnId: IDS.seedTurnB, name: '另一分支' },
  ];

  db.run('BEGIN');
  for (const { branchId, turnId, name } of branchIds) {
    db.run(
      `INSERT INTO turns (id, branch_id, parent_turn_id, host_message_uid, host_variant_key, kind, input_hash, story_hash, base_revision, committed_revision, clock_before_s, elapsed_json, clock_after_s, rng_seed, ruleset_version, decisions_json, receipt_json, attempts_json, status, created_wall_ms, prepared_wall_ms)
       VALUES (?, ?, NULL, NULL, NULL, 'migration', ?, NULL, 0, 0, 0, ?, 0, ?, 'atlas-1', ?, NULL, ?, 'committed', ?, ?)`,
      [
        turnId,
        branchId,
        `hash_${turnId}`,
        JSON.stringify({ min_s: 0, nominal_s: 0, max_s: 0, quality: 'explicit', basis_refs: [] }),
        `rng_${turnId}`,
        JSON.stringify({ operations: [], attention_decisions: [], outcome_decisions: [], random_draws: [] }),
        JSON.stringify([]),
        nowWallMs,
        nowWallMs,
      ],
    );
    db.run(
      `INSERT INTO branches (id, parent_branch_id, fork_turn_id, head_turn_id, revision, name, pov_character_id, root_map_id, clock_s, clock_min_s, clock_max_s, calendar_label, simulation_cursor_s, simulation_status, ruleset_version, status, created_wall_ms)
       VALUES (?, NULL, NULL, ?, 0, ?, ?, ?, 0, 0, 0, ?, 0, 'current', 'atlas-1', 'active', ?)`,
      [branchId, turnId, name, IDS.C1, IDS.M1, '第一天早晨', nowWallMs],
    );

    const rows = rowsFor(branchId, turnId);
    for (const [table, list] of Object.entries(rows)) {
      insertRows(db, table, list);
    }
  }
  db.run('COMMIT');

  return {
    SQL,
    db,
    branchId: IDS.branchMain,
    branchBId: IDS.branchB,
    chatUid: IDS.chatA,
    chatBUid: IDS.chatB,
    seedTurnId: IDS.seedTurn,
    ids: IDS,
    refs: shortRefs(),
    schemaVersion: ATLAS_SCHEMA_VERSION,
    /** 复制一份独立库（测试之间互不污染）。 */
    cloneFrom(bytes) {
      const copy = new SQL.Database(bytes);
      copy.run('PRAGMA foreign_keys = ON');
      return copy;
    },
    exportBytes() {
      return db.export();
    },
    close() {
      db.close();
    },
  };
}

/** 在事务内执行一段构造，返回结果（失败自动回滚并抛出）。 */
export function inTransaction(db, fn) {
  db.run('BEGIN');
  try {
    const result = fn();
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

/** 便捷：读取单行（明文对象）。 */
export function selectOne(db, table, branchId, id) {
  const rows = db.exec(`SELECT * FROM ${table} WHERE branch_id = ? AND id = ?`, [branchId, id]);
  if (!rows || rows.length === 0) return null;
  const { columns, values } = rows[0];
  const out = {};
  columns.forEach((col, i) => {
    out[col] = values[0][i];
  });
  return out;
}

export function countRows(db, table, branchId) {
  const rows = db.exec(`SELECT COUNT(*) FROM ${table} WHERE branch_id = ?`, [branchId]);
  return rows.length ? Number(rows[0].values[0][0]) : 0;
}

export function foreignKeyCheck(db) {
  const rows = db.exec('PRAGMA foreign_key_check');
  return rows.length ? rows[0].values : [];
}

export function userTables(db) {
  const rows = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  return rows.length ? rows[0].values.map((r) => String(r[0])) : [];
}
