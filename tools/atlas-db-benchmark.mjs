/**
 * atlas-db-benchmark.mjs — T30 体积与性能基准（§11.3 / §18.3 T30）。
 *
 * 用法：node tools/atlas-db-benchmark.mjs [--scale small|large|both] [--json]
 *
 * 规模（§11.3 性能验收至少使用）：
 * - small：5 地图 / 50 人 / 200 物
 * - large：约十倍实体规模（50 地图 / 500 人 / 2000 物）+ 1000 楼变更历史
 *
 * 输出：DB 原始字节 / 编码后（base64 信封）字节 / 加载 / 相关查询 / 导出 / 宿主保存（模拟）
 * 耗时。**失败必须记录，不能漏记**：任一阶段抛错都会进 `failures` 并以非零码退出。
 */

import { performance } from 'node:perf_hooks';
import initSqlJs from 'sql.js';
import { installSchema } from '../src/atlas-db-schema.ts';
import { encodeSnapshot } from '../src/atlas-db-envelope.ts';
import { queryBound, runBound, enableForeignKeys } from '../src/atlas-db-runtime.ts';
import { queryMapView, queryNearby, queryEntityDetail, queryChanges } from '../src/atlas-db-views.ts';

const SCALES = {
  small: { maps: 5, characters: 50, items: 200, turns: 50 },
  large: { maps: 50, characters: 500, items: 2000, turns: 1000 },
};

const BRANCH = 'bench-main';
const CHAT = 'bench-chat';
const TURN = 'turn_bench_seed';

function seedRows(scale) {
  const rows = { entity_keys: [], maps: [], locations: [], characters: [], items: [], factions: [] };
  const turn = { created_turn_id: TURN, updated_turn_id: TURN };
  for (let i = 0; i < scale.maps; i += 1) {
    const id = `M${i}`;
    rows.maps.push({
      branch_id: BRANCH, id, row_rev: 1, ...turn,
      name: `地图 ${i}`, kind: i === 0 ? 'world' : 'region', container_location_id: null, description: '',
      frame_json: JSON.stringify({ origin_x: 0, origin_y: 0, reference_width_cells: 200, reference_height_cells: 150 }),
      meters_per_cell: 100, scale_min_meters_per_cell: 100, scale_max_meters_per_cell: 100,
      scale_quality: 'confirmed', scale_basis_json: '{}', scale_locked: 0, calibration_rev: 1,
      background_asset_key: null, default_terrain: 'road', status: 'active',
    });
  }
  const locations = Math.max(20, Math.round(scale.characters / 2));
  for (let i = 0; i < locations; i += 1) {
    const id = `L${i}`;
    rows.entity_keys.push({ branch_id: BRANCH, id, kind: 'location' });
    rows.locations.push({
      branch_id: BRANCH, id, row_rev: 1, ...turn,
      name: `地点 ${i}`, aliases_json: '[]', kind: i % 5 === 0 ? 'city' : 'building', description: '',
      parent_location_id: null, mobility: 'fixed', anchor_location_id: null,
      map_id: `M${i % scale.maps}`, grid_x: (i % 40) + 0.5, grid_y: (i % 30) + 0.5, coord_precision: 'exact',
      uncertainty_radius_cells: null, area_geometry_json: null, terrain: 'road', access_rules_json: null,
      vehicle_profile_json: null, existence_quality: 'confirmed', status: 'active', merged_into_id: null,
    });
  }
  for (let i = 0; i < scale.characters; i += 1) {
    const id = `C${i}`;
    rows.entity_keys.push({ branch_id: BRANCH, id, kind: 'character' });
    rows.characters.push({
      branch_id: BRANCH, id, row_rev: 1, ...turn,
      name: `人物 ${i}`, aliases_json: '[]', role: i < 3 ? 'protagonist' : 'npc', identity: `身份 ${i}`,
      description: '', personality: '', importance: 'supporting', importance_reason: '基准', thought: '',
      action_tendency: '', physical_status: 'alive', condition_note: '',
      location_id: `L${i % locations}`, map_id: null, grid_x: null, grid_y: null, coord_precision: 'unknown',
      uncertainty_radius_cells: null, mobility_profiles_json: '[]', capabilities_json: '[]', status: 'active',
      merged_into_id: null,
    });
  }
  for (let i = 0; i < scale.items; i += 1) {
    const id = `I${i}`;
    rows.entity_keys.push({ branch_id: BRANCH, id, kind: 'item' });
    rows.items.push({
      branch_id: BRANCH, id, row_rev: 1, ...turn,
      name: `物品 ${i}`, aliases_json: '[]', kind: 'object', description: '', quantity: 1, unit: '件',
      condition_note: '', owner_entity_id: null, holder_character_id: i % 2 === 0 ? `C${i % scale.characters}` : null,
      container_item_id: null, location_id: i % 2 === 0 ? null : `L${i % locations}`, map_id: null, grid_x: null,
      grid_y: null, coord_precision: 'unknown', uncertainty_radius_cells: null, properties_json: '[]',
      status: 'active', merged_into_id: null,
    });
  }
  rows.factions.push({
    branch_id: BRANCH, id: 'F0', row_rev: 1, ...turn,
    name: '基准势力', aliases_json: '[]', kind: 'organization', description: '', goal: '',
    headquarters_location_id: 'L0', capabilities_json: '[]', status: 'active', merged_into_id: null,
  });
  rows.entity_keys.push({ branch_id: BRANCH, id: 'F0', kind: 'faction' });
  return rows;
}

function insertAll(db, table, rows) {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  for (const row of rows) {
    runBound(db, sql, columns.map((c) => {
      const v = row[c];
      if (v === null || v === undefined) return null;
      if (typeof v === 'object') return JSON.stringify(v);
      return v;
    }));
  }
}

export async function runBenchmark(scaleName) {
  const scale = SCALES[scaleName];
  if (!scale) throw new Error(`未知规模：${scaleName}（可用 ${Object.keys(SCALES).join(' / ')}）`);
  const timings = {};
  const failures = [];
  const mark = (name, start) => {
    timings[name] = Math.round((performance.now() - start) * 100) / 100;
  };

  let SQL;
  let db = null;
  try {
    let start = performance.now();
    SQL = await initSqlJs();
    mark('loadSqlJsMs', start);

    start = performance.now();
    db = new SQL.Database();
    enableForeignKeys(db);
    installSchema(db);
    mark('installSchemaMs', start);

    start = performance.now();
    db.run('BEGIN');
    db.run(
      `INSERT INTO turns (id, branch_id, parent_turn_id, host_message_uid, host_variant_key, kind, input_hash, story_hash, base_revision, committed_revision, clock_before_s, elapsed_json, clock_after_s, rng_seed, ruleset_version, decisions_json, receipt_json, attempts_json, status, created_wall_ms, prepared_wall_ms)
       VALUES (?, ?, NULL, NULL, NULL, 'migration', 'h', NULL, 0, 0, 0, '{}', 0, 'r', 'atlas-1', '{}', NULL, '[]', 'committed', 1, 1)`,
      [TURN, BRANCH],
    );
    db.run(
      `INSERT INTO branches (id, parent_branch_id, fork_turn_id, head_turn_id, revision, name, pov_character_id, root_map_id, clock_s, clock_min_s, clock_max_s, calendar_label, simulation_cursor_s, simulation_status, ruleset_version, status, created_wall_ms)
       VALUES (?, NULL, NULL, ?, 0, '基准', NULL, 'M0', 0, 0, 0, NULL, 0, 'current', 'atlas-1', 'active', 1)`,
      [BRANCH, TURN],
    );
    const rows = seedRows(scale);
    for (const [table, list] of Object.entries(rows)) insertAll(db, table, list);
    db.run('COMMIT');
    mark('seedMs', start);

    // 1000 楼变更历史（large）或 50 楼（small）
    start = performance.now();
    db.run('BEGIN');
    const changeColumns = ['id', 'turn_id', 'sequence', 'attempt_id', 'group_id', 'operation_id', 'target_table', 'target_row_id', 'operation', 'before_json', 'after_json', 'basis_json', 'summary'];
    const changeSql = `INSERT INTO turn_changes (${changeColumns.join(', ')}) VALUES (${changeColumns.map(() => '?').join(', ')})`;
    for (let i = 0; i < scale.turns; i += 1) {
      const turnId = `t_${i}`;
      db.run(
        `INSERT INTO turns (id, branch_id, parent_turn_id, host_message_uid, host_variant_key, kind, input_hash, story_hash, base_revision, committed_revision, clock_before_s, elapsed_json, clock_after_s, rng_seed, ruleset_version, decisions_json, receipt_json, attempts_json, status, created_wall_ms, prepared_wall_ms)
         VALUES (?, ?, ?, ?, 'v1', 'narrative', ?, NULL, 0, 1, ?, '{}', ?, 'r', 'atlas-1', '{}', NULL, '[]', 'committed', ?, NULL)`,
        [turnId, BRANCH, i === 0 ? TURN : `t_${i - 1}`, `msg_${i}`, `h_${i}`, i * 30, i * 30, 1000 + i],
      );
      runBound(db, changeSql, [`chg_${i}`, turnId, 1, 'att', `G${i}`, `OP${i}`, 'characters', `C${i % scale.characters}`, 'update', null, JSON.stringify({ thought: `想法 ${i}` }), '{}', `变更 ${i}`]);
    }
    db.run('COMMIT');
    mark('historyMs', start);

    start = performance.now();
    const exported = db.export();
    mark('exportMs', start);
    const rawBytes = exported.length;

    start = performance.now();
    const envelope = await encodeSnapshot(exported, {
      chatUid: CHAT,
      worldUid: 'bench-world',
      storageRevision: 1,
      activeBranchId: BRANCH,
    });
    mark('encodeEnvelopeMs', start);

    start = performance.now();
    const reloaded = new SQL.Database(exported);
    enableForeignKeys(reloaded);
    mark('reloadMs', start);

    const ctx = { db: reloaded, branchId: BRANCH, revision: scale.turns, viewMode: 'author', povId: null };
    start = performance.now();
    const mapView = queryMapView(ctx, { kind: 'map', branchId: BRANCH });
    mark('queryMapViewMs', start);
    start = performance.now();
    const nearby = queryNearby(ctx, { kind: 'nearby', branchId: BRANCH, entityId: 'C0' });
    mark('queryNearbyMs', start);
    start = performance.now();
    const detail = queryEntityDetail(ctx, { kind: 'entity', branchId: BRANCH, entityId: 'C0' });
    mark('queryEntityDetailMs', start);
    start = performance.now();
    const changes = queryChanges(ctx, { kind: 'changes', branchId: BRANCH, limit: 100 });
    mark('queryChangesMs', start);

    // 宿主保存（模拟：把信封放进一个对象，测序列化成本）
    start = performance.now();
    const serialized = JSON.stringify(envelope);
    mark('hostSaveSerializeMs', start);

    const result = {
      scale: scaleName,
      requested: scale,
      counts: {
        maps: queryBound(reloaded, 'SELECT COUNT(*) AS n FROM maps')[0].n,
        locations: queryBound(reloaded, 'SELECT COUNT(*) AS n FROM locations')[0].n,
        characters: queryBound(reloaded, 'SELECT COUNT(*) AS n FROM characters')[0].n,
        items: queryBound(reloaded, 'SELECT COUNT(*) AS n FROM items')[0].n,
        turnChanges: queryBound(reloaded, 'SELECT COUNT(*) AS n FROM turn_changes')[0].n,
      },
      bytes: {
        rawDb: rawBytes,
        envelopeJson: serialized.length,
        encodedData: envelope.data.length,
        sha256: envelope.sha256,
        byteLengthField: envelope.byte_length,
      },
      timings,
      queryResults: {
        mapItems: mapView.items.length,
        mapPoints: mapView.metadata.pointCount,
        coarseCount: mapView.metadata.coarseCount,
        nearby: nearby.items.length,
        detailItems: detail.items.length,
        changeRows: changes.items.length,
      },
      failures,
    };
    reloaded.close();
    return result;
  } catch (err) {
    failures.push({ scale: scaleName, message: String(err && err.message ? err.message : err) });
    return { scale: scaleName, requested: scale, failures, timings, bytes: null, counts: null, queryResults: null };
  } finally {
    try {
      db?.close();
    } catch {
      /* 已关闭 */
    }
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (invokedDirectly) {
  const scaleArg = process.argv.includes('--scale') ? process.argv[process.argv.indexOf('--scale') + 1] : 'both';
  const names = scaleArg === 'both' ? ['small', 'large'] : [scaleArg];
  const results = [];
  for (const name of names) results.push(await runBenchmark(name));
  const failed = results.some((r) => r.failures.length > 0);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      console.log(`\n=== ${r.scale} ===`);
      if (r.failures.length > 0) {
        console.log(`FAILED: ${r.failures.map((f) => f.message).join('; ')}`);
        continue;
      }
      console.log(`counts: ${JSON.stringify(r.counts)}`);
      console.log(`bytes : raw=${r.bytes.rawDb} envelopeJson=${r.bytes.envelopeJson} encodedData=${r.bytes.encodedData}`);
      console.log(`time  : ${JSON.stringify(r.timings)}`);
      console.log(`query : ${JSON.stringify(r.queryResults)}`);
    }
  }
  if (failed) process.exitCode = 1;
}
