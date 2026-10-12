/**
 * atlas-route-attribution.test.mjs — P04 / N02：路线归属与候选事实（RTE01–RTE06）。
 *
 * 计划来源：§10.1 路线归属真值表。
 *
 * 缺陷现象（N02）：旧实现里「同一张图上的合法路线」只要省略 map_ref 就永远拿不到可绘制归属
 * （新路线一律落 map_id=null），于是地图上「明明同图却画不出来」，跨图几何的判断也失去依据。
 *
 * 真值表（每条都有对应用例）：
 * - 新路线、省略 map_ref、两端同图 M       → map_id = M（RTE01）；
 * - 新路线、省略 map_ref、两端不同图/无法确定 → map_id = null，仍保留为拓扑连接（RTE02）；
 * - 显式 map_ref 指向别的图                 → ROUTE_MAP_MISMATCH，不静默改归属、不落库（RTE03）；
 * - 显式 map_ref = null / = 正确图           → 分别落 null / 该图（RTE04）；
 * - 跨图 + 直接几何                         → ROUTE_GEOMETRY_CROSS_MAP（RTE04b）；
 * - status 贯通（open/blocked/closed）与非法枚举拒绝（RTE05）；
 * - 已有路线未给 map_ref → 保持旧 map_id，不自动重新归属（RTE06）。
 *
 * 全程走真实编译路径：extractPayload → parseOperations → compileOperations
 * → createTableReadPort → applyGroups（真实事务与不变量校验）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, selectOne, foreignKeyCheck } from './fixtures/atlas-sql/seed.mjs';
import { makeAnchor } from './helpers/atlas-compile-context.mjs';
import { extractPayload, parseOperations } from '../src/atlas-ops-parser.ts';
import { compileOperations } from '../src/atlas-ops-compile.ts';
import { applyGroups } from '../src/atlas-db-commit.ts';
import { createTableReadPort } from '../src/atlas-db-readport.ts';

const SQL = await (await import('sql.js')).default();
const BRANCH = IDS.branchMain;
const PHASE = 'geography';

/** 已有路线 R_AB 的短引用（seed 的 refs 只覆盖地点/人物/物品/势力/地图，不含路线）。 */
const ROUTE_REF = { alias: 'R_AB', id: IDS.R_AB, kind: 'route', rowRev: 1 };

/** 真实编译路径：ops 对象数组 → 文本 → 解析 → 编译（不执行 SQL）。 */
function compile(seed, ops, { phase = PHASE, anchor = makeAnchor(), refs = null } = {}) {
  const text = ops.map((o) => JSON.stringify(o)).join('\n');
  const extracted = extractPayload(text);
  const parsed = parseOperations(extracted.payload, { phase });
  const compiled = compileOperations({
    operations: parsed.operations,
    anchor,
    phase,
    clockS: 0,
    revision: 0,
    tables: createTableReadPort(seed.db),
    sources: { phase, snapshot: [], clockS: 0 },
    knownRefs: refs ? [...seed.refs, ...refs] : seed.refs,
  });
  return { extracted, parsed, compiled };
}

/** 把一个编译结果当一个原子组真实应用（默认开启不变量校验）。 */
function applyCompiled(seed, compiled, { turnId = IDS.seedTurn, attemptId = 'attempt_rte' } = {}) {
  const db = seed.db;
  db.run('BEGIN');
  try {
    const group = {
      id: 'g_rte',
      opIds: compiled.results.map((r) => r.opId),
      dependsOn: [],
      readSet: compiled.merged.readSet,
      mutations: compiled.merged.mutations,
      opIssues: compiled.issues.filter((i) => i.severity === 'error'),
    };
    const result = applyGroups(db, [group], { branchId: BRANCH, turnId, attemptId, validate: true });
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

function errorCodes(compiled) {
  return compiled.issues.filter((i) => i.severity === 'error').map((i) => i.code);
}

function routeMutation(compiled) {
  return compiled.merged.mutations.find((m) => m.table === 'routes') ?? null;
}

/* ------------------------------------------------------------------ *
 * RTE01：省略 map_ref、两端同图 → 推导出该图
 * ------------------------------------------------------------------ */

test('RTE01 新路线省略 map_ref，两端同在 M1 → map_id 推导为 M1 并真实落库', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const { compiled } = compile(seed, [
      { op: 'route.propose', ref: 'new:road_ab', data: { from_ref: 'L1', to_ref: 'L2', kind: 'road' } },
    ]);
    assert.deepEqual(errorCodes(compiled), [], '同图合法路线不得报错');

    const m = routeMutation(compiled);
    assert.ok(m, '必须产出候选变更');
    assert.equal(m.after.map_id, IDS.M1, '两端同在 M1，新路线归属应推导为 M1');
    assert.equal(m.after.from_location_id, IDS.L1);
    assert.equal(m.after.to_location_id, IDS.L2);
    assert.equal(m.after.status, 'open', '未给 status 时默认 open');

    applyCompiled(seed, compiled);
    const row = selectOne(seed.db, 'routes', BRANCH, m.rowId);
    assert.ok(row, '路线行必须真实写入');
    assert.equal(row.map_id, IDS.M1);
    assert.equal(row.status, 'open');
    assert.deepEqual(foreignKeyCheck(seed.db), []);
  } finally {
    seed.close();
  }
});

/* ------------------------------------------------------------------ *
 * RTE02：省略 map_ref、两端不同图 / 无法确定 → null（保留拓扑）
 * ------------------------------------------------------------------ */

test('RTE02 新路线省略 map_ref，两端分属 M1/M2 → map_id=null 且不报错（拓扑连接）', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const { compiled } = compile(seed, [
      { op: 'route.propose', ref: 'new:cross', data: { from_ref: 'L1', to_ref: 'L3', kind: 'door' } },
    ]);
    assert.deepEqual(errorCodes(compiled), [], '跨图但没有几何时是合法拓扑连接');

    const m = routeMutation(compiled);
    assert.ok(m);
    assert.equal(m.after.map_id, null, '两端不共图就不能给可绘制归属');

    applyCompiled(seed, compiled);
    assert.equal(selectOne(seed.db, 'routes', BRANCH, m.rowId).map_id, null);
    assert.deepEqual(foreignKeyCheck(seed.db), []);
  } finally {
    seed.close();
  }
});

test('RTE02b 一端无地图归属（map_id 为 NULL）→ 无法确定，落到 null 而不是猜一张图', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    // 造一个没有地图归属的拓扑地点（容器/抽象区域），只用于验证“无法确定”分支。
    // 先登记身份键：locations 与 entity_keys 的 kind 必须一致（触发器强约束）。
    seed.db.run(
      `INSERT INTO entity_keys (branch_id, id, kind) VALUES (?, ?, 'location')`,
      [BRANCH, 'L_TOPOLOGY'],
    );
    seed.db.run(
      `INSERT INTO locations (branch_id, id, row_rev, created_turn_id, updated_turn_id, name, aliases_json, kind, description,
        parent_location_id, mobility, anchor_location_id, map_id, grid_x, grid_y, coord_precision, uncertainty_radius_cells,
        area_geometry_json, terrain, access_rules_json, vehicle_profile_json, existence_quality, status, merged_into_id)
       VALUES (?, ?, 1, ?, ?, ?, '[]', 'other', '', NULL, 'fixed', NULL, NULL, NULL, NULL, 'unknown', NULL,
        NULL, 'unknown', NULL, NULL, 'confirmed', 'active', NULL)`,
      [BRANCH, 'L_TOPOLOGY', IDS.seedTurn, IDS.seedTurn, '无名区域'],
    );

    const { compiled } = compile(
      seed,
      [{ op: 'route.propose', ref: 'new:topo', data: { from_ref: 'L1', to_ref: 'L_TOPOLOGY', kind: 'estimated' } }],
      { refs: [{ alias: 'L_TOPOLOGY', id: 'L_TOPOLOGY', kind: 'location', rowRev: 1 }] },
    );
    assert.deepEqual(errorCodes(compiled), []);
    assert.equal(routeMutation(compiled).after.map_id, null, '一端无图就不能推导归属');
  } finally {
    seed.close();
  }
});

/* ------------------------------------------------------------------ *
 * RTE03：显式 map_ref 指向别的图 → ROUTE_MAP_MISMATCH，不静默改归属
 * ------------------------------------------------------------------ */

test('RTE03 显式 map_ref 指向端点之外的图 → ROUTE_MAP_MISMATCH 且不落库', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const { compiled } = compile(seed, [
      { op: 'route.propose', ref: 'new:bad', data: { from_ref: 'L1', to_ref: 'L2', map_ref: 'M2' } },
    ]);
    assert.ok(errorCodes(compiled).includes('ROUTE_MAP_MISMATCH'), `期望 ROUTE_MAP_MISMATCH，实际 ${JSON.stringify(errorCodes(compiled))}`);
    assert.equal(routeMutation(compiled), null, '归属冲突时不得产出任何路线变更');
    assert.equal(selectOne(seed.db, 'routes', BRANCH, IDS.R_AB).row_rev, 1, '既有路线不得被顺手改动');
  } finally {
    seed.close();
  }
});

/* ------------------------------------------------------------------ *
 * RTE04：显式 map_ref = null（拓扑）/ = 正确图
 * ------------------------------------------------------------------ */

test('RTE04 显式 map_ref=null 只留拓扑；显式正确图则落该图', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const topological = compile(seed, [
      { op: 'route.propose', ref: 'new:topo', data: { from_ref: 'L1', to_ref: 'L2', map_ref: null } },
    ]).compiled;
    assert.deepEqual(errorCodes(topological), []);
    assert.equal(routeMutation(topological).after.map_id, null, '调用方显式选择只保留拓扑');

    const owned = compile(seed, [
      { op: 'route.propose', ref: 'new:owned', data: { from_ref: 'L1', to_ref: 'L2', map_ref: 'M1' } },
    ]).compiled;
    assert.deepEqual(errorCodes(owned), []);
    assert.equal(routeMutation(owned).after.map_id, IDS.M1, '显式给出的图与端点一致就采纳');
  } finally {
    seed.close();
  }
});

test('RTE04b 跨图 + 直接几何 → ROUTE_GEOMETRY_CROSS_MAP（不同坐标系不相减）', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const { compiled } = compile(seed, [
      {
        op: 'route.propose',
        ref: 'new:badgeom',
        data: { from_ref: 'L1', to_ref: 'L3', kind: 'road', geometry: { kind: 'line', coordinates: [[1, 1], [2, 2]] } },
      },
    ]);
    assert.ok(errorCodes(compiled).includes('ROUTE_GEOMETRY_CROSS_MAP'), `实际 ${JSON.stringify(errorCodes(compiled))}`);
    assert.equal(routeMutation(compiled), null);

    // 同图 + 几何是合法的（回归保护：不能把 N02 修成“几何一律拒绝”）。
    const sameMapGeometry = compile(seed, [
      {
        op: 'route.propose',
        ref: 'new:geom',
        data: { from_ref: 'L1', to_ref: 'L2', kind: 'road', geometry: { kind: 'line', coordinates: [[10, 10], [12, 11]] } },
      },
    ]).compiled;
    assert.deepEqual(errorCodes(sameMapGeometry), []);
    const m = routeMutation(sameMapGeometry);
    assert.equal(m.after.map_id, IDS.M1);
    assert.equal(m.after.geometry_quality, 'confirmed');
    assert.equal(m.after.geometry_rev, 1);
  } finally {
    seed.close();
  }
});

/* ------------------------------------------------------------------ *
 * RTE05：status 贯通与非法枚举
 * ------------------------------------------------------------------ */

test('RTE05 status：open/blocked/closed 三个合法值真实落库，非法枚举拒绝', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    for (const status of ['open', 'blocked', 'closed']) {
      const { compiled } = compile(seed, [
        { op: 'route.propose', ref: `new:st_${status}`, data: { from_ref: 'L1', to_ref: 'L2', status } },
      ]);
      assert.deepEqual(errorCodes(compiled), [], `status=${status} 应合法`);
      const m = routeMutation(compiled);
      assert.equal(m.after.status, status);
      applyCompiled(seed, compiled, { turnId: IDS.seedTurn, attemptId: `attempt_${status}` });
      assert.equal(selectOne(seed.db, 'routes', BRANCH, m.rowId).status, status, `status=${status} 必须真实落库`);
    }

    const bad = compile(seed, [
      { op: 'route.propose', ref: 'new:st_bad', data: { from_ref: 'L1', to_ref: 'L2', status: 'melted' } },
    ]).compiled;
    assert.ok(errorCodes(bad).includes('ENUM_INVALID'), `实际 ${JSON.stringify(errorCodes(bad))}`);
    assert.equal(routeMutation(bad), null);
  } finally {
    seed.close();
  }
});

/* ------------------------------------------------------------------ *
 * RTE06：已有路线不自动重新归属
 * ------------------------------------------------------------------ */

test('RTE06 更新既有路线且未给 map_ref → 保持旧 map_id；显式冲突图才报错', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const before = selectOne(seed.db, 'routes', BRANCH, IDS.R_AB);
    assert.equal(before.map_id, IDS.M1, '夹具前提：R_AB 归属 M1');

    // 更新既有路线仍须重述两端点（route.propose 的最少字段契约），但归属必须沿用旧值。
    const kept = compile(
      seed,
      [{ op: 'route.propose', ref: 'R_AB', data: { from_ref: 'L1', to_ref: 'L2', kind: 'path' } }],
      { refs: [ROUTE_REF] },
    ).compiled;
    assert.deepEqual(errorCodes(kept), []);
    const m = routeMutation(kept);
    assert.ok(m && m.before, '更新既有路线必须是 update 候选');
    assert.equal(m.after.map_id, IDS.M1, '省略 map_ref 不得把既有归属改成 null（不自动重新归属）');
    assert.equal(m.after.status, 'open', '既有 status 应被保留');
    assert.equal(m.after.row_rev, Number(before.row_rev) + 1);

    applyCompiled(seed, kept);
    const after = selectOne(seed.db, 'routes', BRANCH, IDS.R_AB);
    assert.equal(after.map_id, IDS.M1);
    assert.equal(after.kind, 'path');
    assert.equal(after.row_rev, Number(before.row_rev) + 1);

    const conflict = compile(
      seed,
      [{ op: 'route.propose', ref: 'R_AB', data: { from_ref: 'L1', to_ref: 'L2', map_ref: 'M2' } }],
      { refs: [ROUTE_REF] },
    ).compiled;
    assert.ok(errorCodes(conflict).includes('ROUTE_MAP_MISMATCH'), `实际 ${JSON.stringify(errorCodes(conflict))}`);
    assert.equal(routeMutation(conflict), null);

    const explicitNull = compile(
      seed,
      [{ op: 'route.propose', ref: 'R_AB', data: { from_ref: 'L1', to_ref: 'L2', map_ref: null } }],
      { refs: [ROUTE_REF] },
    ).compiled;
    assert.deepEqual(errorCodes(explicitNull), []);
    assert.equal(routeMutation(explicitNull).after.map_id, null, '显式 null 才是调用方主动降级为拓扑');
  } finally {
    seed.close();
  }
});
