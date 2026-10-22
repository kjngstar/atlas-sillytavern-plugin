/**
 * atlas-layout-signature.test.mjs — P05 / N05：每图布局输入指纹（SIG01–SIG05）。
 *
 * 缺陷（N05）：旧指纹只哈希「成员描述 + 幅面」，且每图共用一份 `layout-v2` 结构：
 * - 路线新增/封路/改端点不使负责该图失效（路上少了/多了路也不重画）；
 * - 各图结构差异被批次指纹抹平，A 图改路线会连累 B 图；
 * - 生成器自己回写的估计坐标会被算成「结构变化」，生成一次立刻再判失效。
 *
 * 覆盖：
 * - SIG01 路线新增 / 关闭 / 方向 / 端点 / 确认几何变化 → 负责该图的指纹失效；
 * - SIG02 人物移动 / 远处无关实体 / row_rev 变化 → 该图指纹不变；
 * - SIG03 A 图改路线不影响 B 图（判断的是每图指纹，不是批次指纹）；
 * - SIG04 成功生成后连续两次构建都不再选该图；生成器自身写回不形成循环；
 * - SIG05 旧 v2 指纹触发一次合理刷新；新生成失败时旧 scene 与旧指纹都保留。
 *
 * 全程走真实路径：computeLayoutInputSignature（纯函数）+ buildSqlLayoutTask /
 * computeMapLayoutSignature（真实只读端口）+ 真实 repository 回合。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, selectOne, insertRows } from './fixtures/atlas-sql/seed.mjs';
import { SOURCE_SNAPSHOT } from './fixtures/atlas-sql/model-cases.mjs';
import { createTableReadPort } from '../src/atlas-db-readport.ts';
import {
  LAYOUT_CONTEXT_FRAME_KEY,
  buildSqlLayoutTask,
  computeMapLayoutSignature,
} from '../src/atlas-sql-layout-task.ts';
import {
  LAYOUT_SIGNATURE_POLICY_VERSION,
  computeLayoutInputSignature,
} from '../src/atlas-layout-signature.ts';
import { createSqlRepository } from '../src/atlas-db-repository.ts';
import { createAtlasHostPort } from '../src/atlas-host-port.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';

const SQL = await (await import('sql.js')).default();
const BRANCH = IDS.branchMain;
const TURN = IDS.seedTurn;

/* ------------------------------------------------------------------ *
 * 夹具辅助
 * ------------------------------------------------------------------ */

function turnInput(extra = {}) {
  return {
    anchor: {
      chatUid: IDS.chatA,
      branchId: BRANCH,
      parentTurnId: TURN,
      hostMessageUid: 'msg_sig',
      variantKey: 'v1',
      baseRevision: 0,
      baseStorageRevision: 0,
      inputHash: 'input_sig',
    },
    userText: '看一眼地图。',
    assistantText: '角色站在城里。',
    sourceSnapshot: [],
    phaseBatches: [],
    manual: false,
    layoutMaps: 'active',
    ...extra,
  };
}

function frameOf(db, mapId) {
  const row = selectOne(db, 'maps', BRANCH, mapId);
  const raw = row.frame_json;
  return typeof raw === 'string' ? JSON.parse(raw) : { ...raw };
}

function writeFrame(db, mapId, frame) {
  db.run('UPDATE maps SET frame_json = ? WHERE branch_id = ? AND id = ?', [JSON.stringify(frame), BRANCH, mapId]);
}

function setLocation(db, id, patch) {
  const keys = Object.keys(patch);
  db.run(
    `UPDATE locations SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE branch_id = ? AND id = ?`,
    [...keys.map((k) => patch[k]), BRANCH, id],
  );
}

function setRoute(db, id, patch) {
  const keys = Object.keys(patch);
  db.run(
    `UPDATE routes SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE branch_id = ? AND id = ?`,
    [...keys.map((k) => patch[k]), BRANCH, id],
  );
}

function addRoute(db, row) {
  insertRows(db, 'routes', [
    { branch_id: BRANCH, row_rev: 1, created_turn_id: TURN, updated_turn_id: TURN, bidirectional: 1, geometry_quality: 'unknown', geometry_rev: 1, distance_basis: 'unknown', terrain: 'unknown', allowed_modes_json: '[]', status: 'open', status_reason: '', ...row },
  ]);
}

/** 每图当前指纹（走真实只读端口）。 */
function signatureOf(db, mapId) {
  const hash = computeMapLayoutSignature(createTableReadPort(db), BRANCH, mapId);
  assert.ok(hash, `地图 ${mapId} 应能算出指纹`);
  return hash;
}

/** 模拟「一次成功的布局已保存」：写入合法 scene 与当前指纹。 */
function saveFingerprints(db, mapIds = [IDS.M1, IDS.M2]) {
  const tables = createTableReadPort(db);
  for (const mapId of mapIds) {
    const frame = frameOf(db, mapId);
    frame.atlasScene = {
      kind: 'atlas-scene',
      version: 1,
      mapId,
      branchId: BRANCH,
      units: 'meters',
      metersPerCell: 1,
      layout: { kind: 'overview', bounds: { x: 0, y: 0, w: 10, h: 10 } },
      generator: 'sig-test',
    };
    frame[LAYOUT_CONTEXT_FRAME_KEY] = {
      version: 3,
      hash: computeMapLayoutSignature(tables, BRANCH, mapId),
      completedTurnId: TURN,
    };
    writeFrame(db, mapId, frame);
  }
}

/* ------------------------------------------------------------------ *
 * 纯函数：稳定性与排除项
 * ------------------------------------------------------------------ */

test('SIG00 同一输入与顺序无关；策略版本变化会改变指纹', () => {
  const member = (id) => ({ id, name: `地点${id}`, kind: 'city', parent: null, anchor: null, description: '', mobility: 'fixed' });
  const route = (id, to) => ({ id, from: 'a', to, mapId: 'M1', status: 'open', bidirectional: 1, kind: 'road', geometry: null, geometryQuality: 'unknown', geometryRev: 1 });
  const base = {
    mapId: 'M1',
    layoutKind: 'overview',
    profile: null,
    units: 'meters',
    extent: { width: 100, height: 80 },
    members: [member('a'), member('b')],
    authorIntent: [],
    routes: [route('r1', 'b'), route('r2', 'c')],
    structureLocked: false,
    sizeLedgerRev: 1,
  };
  const shuffled = { ...base, members: [member('b'), member('a')], routes: [route('r2', 'c'), route('r1', 'b')] };
  assert.equal(computeLayoutInputSignature(base), computeLayoutInputSignature(shuffled), '数组顺序不得影响指纹');

  const otherPolicy = computeLayoutInputSignature({ ...base, policyVersion: 'layout-v99' });
  assert.notEqual(otherPolicy, computeLayoutInputSignature(base));
  assert.equal(LAYOUT_SIGNATURE_POLICY_VERSION, 'layout-v12');

  const locked = computeLayoutInputSignature({ ...base, structureLocked: true });
  assert.notEqual(locked, computeLayoutInputSignature(base), '权威结构锁必须参与指纹');
  const recalibrated = computeLayoutInputSignature({ ...base, sizeLedgerRev: 2 });
  assert.notEqual(recalibrated, computeLayoutInputSignature(base), '尺寸账本修订必须参与指纹');
});

/* ------------------------------------------------------------------ *
 * SIG01：路线责任变化使负责图失效
 * ------------------------------------------------------------------ */

test('SIG01 路线新增 / 关闭 / 方向 / 端点 / 确认几何变化都让 M1 失效', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const base = signatureOf(seed.db, IDS.M1);

    // 新增一条 M1 上的路线（L1—L2 方向拓扑，另给一条）
    const afterAdd = (() => {
      addRoute(seed.db, { id: 'R_NEW', from_location_id: IDS.L1, to_location_id: IDS.L2, kind: 'path', map_id: IDS.M1, distance_basis: 'estimated' });
      return signatureOf(seed.db, IDS.M1);
    })();
    assert.notEqual(afterAdd, base, '新增路线必须使负责该图失效');

    // 关闭既有路线
    const afterClose = (() => {
      setRoute(seed.db, IDS.R_AB, { status: 'closed', status_reason: '塌方' });
      return signatureOf(seed.db, IDS.M1);
    })();
    assert.notEqual(afterClose, afterAdd, '封路/关闭必须使指纹变化');

    // 方向变化
    const afterDirection = (() => {
      setRoute(seed.db, IDS.R_AB, { bidirectional: 0 });
      return signatureOf(seed.db, IDS.M1);
    })();
    assert.notEqual(afterDirection, afterClose, '方向变化必须使指纹变化');

    // 端点变化（L2 → 新地点 L4）
    const afterEndpoint = (() => {
      insertRows(seed.db, 'entity_keys', [{ branch_id: BRANCH, id: 'L4', kind: 'location' }]);
      insertRows(seed.db, 'locations', [{
        branch_id: BRANCH, id: 'L4', row_rev: 1, created_turn_id: TURN, updated_turn_id: TURN,
        name: '郊区', aliases_json: '[]', kind: 'other', description: '', parent_location_id: null,
        mobility: 'fixed', anchor_location_id: null, map_id: IDS.M1, grid_x: 20, grid_y: 20,
        coord_precision: 'approximate', uncertainty_radius_cells: 0.5, area_geometry_json: null,
        terrain: 'road', access_rules_json: null, vehicle_profile_json: null,
        existence_quality: 'confirmed', status: 'active', merged_into_id: null,
      }]);
      setRoute(seed.db, IDS.R_AB, { to_location_id: 'L4' });
      return signatureOf(seed.db, IDS.M1);
    })();
    assert.notEqual(afterEndpoint, afterDirection, '端点变化必须使指纹变化');

    // 确认几何变化（几何 + 质量 + 修订）
    const afterGeometry = (() => {
      setRoute(seed.db, IDS.R_AB, {
        geometry_json: JSON.stringify({ kind: 'line', coordinates: [[10, 10], [20, 20]] }),
        geometry_quality: 'confirmed',
        geometry_rev: 2,
      });
      return signatureOf(seed.db, IDS.M1);
    })();
    assert.notEqual(afterGeometry, afterEndpoint, '确认几何变化必须使指纹变化');

    // 关掉路线（删除）同样进指纹
    const afterDelete = (() => {
      seed.db.run('DELETE FROM routes WHERE branch_id = ? AND id = ?', [BRANCH, 'R_NEW']);
      return signatureOf(seed.db, IDS.M1);
    })();
    assert.notEqual(afterDelete, afterGeometry, '删除路线必须使指纹变化');
  } finally {
    seed.close();
  }
});

/* ------------------------------------------------------------------ *
 * SIG02：无关变化不使该图失效
 * ------------------------------------------------------------------ */

test('确认长宽变化使父图失效，生成的估计落点不触发循环',async()=>{
  const seed=await makeSeedWith(SQL);
  try{
    const setSize=(widthM)=>seed.db.run('UPDATE locations SET area_geometry_json = ?, coord_precision = ? WHERE id = ? AND branch_id = ?',[JSON.stringify({kind:'dimensions',widthM,heightM:8,quality:'confirmed',source:'story'}),'layout',IDS.L1,BRANCH]);
    setSize(12);
    const first=signatureOf(seed.db,IDS.M1);
    seed.db.run('UPDATE locations SET grid_x = 15, grid_y = 20 WHERE id = ? AND branch_id = ?',[IDS.L1,BRANCH]);
    assert.equal(signatureOf(seed.db,IDS.M1),first);
    setSize(13);
    assert.notEqual(signatureOf(seed.db,IDS.M1),first);
  }finally{seed.close();}
});

test('SIG02 人物移动 / 远处无关实体 / row_rev 变化都不动 M1 指纹', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const base = signatureOf(seed.db, IDS.M1);

    // 人物普通移动：C1 从 L2 走到 L1，并带上自己的估计坐标
    seed.db.run('UPDATE characters SET location_id = ?, map_id = ?, grid_x = ?, grid_y = ? WHERE branch_id = ? AND id = ?', [IDS.L1, IDS.M1, 10.5, 10.5, BRANCH, IDS.C1]);
    assert.equal(signatureOf(seed.db, IDS.M1), base, '人物普通移动不得使该图结构失效');

    // row_rev 整体变化（任何表）
    seed.db.run('UPDATE locations SET row_rev = row_rev + 5 WHERE branch_id = ?', [BRANCH]);
    seed.db.run('UPDATE maps SET row_rev = row_rev + 5 WHERE branch_id = ?', [BRANCH]);
    assert.equal(signatureOf(seed.db, IDS.M1), base, 'row_rev 变化不得进指纹');

    // 远处无关实体：在 M2 上新增地点
    insertRows(seed.db, 'entity_keys', [{ branch_id: BRANCH, id: 'L_FAR', kind: 'location' }]);
    insertRows(seed.db, 'locations', [{
      branch_id: BRANCH, id: 'L_FAR', row_rev: 1, created_turn_id: TURN, updated_turn_id: TURN,
      name: '远方的塔', aliases_json: '[]', kind: 'building', description: '', parent_location_id: IDS.L3,
      mobility: 'fixed', anchor_location_id: null, map_id: IDS.M2, grid_x: 1, grid_y: 1,
      coord_precision: 'approximate', uncertainty_radius_cells: null, area_geometry_json: null,
      terrain: 'unknown', access_rules_json: null, vehicle_profile_json: null,
      existence_quality: 'confirmed', status: 'active', merged_into_id: null,
    }]);
    assert.equal(signatureOf(seed.db, IDS.M1), base, '别的地图上的变化不得使 M1 失效');
  } finally {
    seed.close();
  }
});

/* ------------------------------------------------------------------ *
 * SIG03：每图各算各的
 * ------------------------------------------------------------------ */

test('SIG03 A 图改路线不影响 B 图，判断的是每图指纹', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const beforeM1 = signatureOf(seed.db, IDS.M1);
    const beforeM2 = signatureOf(seed.db, IDS.M2);
    assert.notEqual(beforeM1, beforeM2, '不同图的指纹本来就不同');

    addRoute(seed.db, { id: 'R_M1', from_location_id: IDS.L1, to_location_id: IDS.L2, kind: 'road', map_id: IDS.M1, distance_basis: 'estimated' });
    assert.notEqual(signatureOf(seed.db, IDS.M1), beforeM1, 'M1 路线变化必须失效 M1');
    assert.equal(signatureOf(seed.db, IDS.M2), beforeM2, 'M1 的路线变化不得波及 M2');

    // M2 自己的新路线（M2 上第二个地点）
    insertRows(seed.db, 'entity_keys', [{ branch_id: BRANCH, id: 'L3B', kind: 'location' }]);
    insertRows(seed.db, 'locations', [{
      branch_id: BRANCH, id: 'L3B', row_rev: 1, created_turn_id: TURN, updated_turn_id: TURN,
      name: '隔壁教室', aliases_json: '[]', kind: 'room', description: '', parent_location_id: IDS.L2,
      mobility: 'fixed', anchor_location_id: null, map_id: IDS.M2, grid_x: 8, grid_y: 6,
      coord_precision: 'approximate', uncertainty_radius_cells: null, area_geometry_json: null,
      terrain: 'unknown', access_rules_json: null, vehicle_profile_json: null,
      existence_quality: 'confirmed', status: 'active', merged_into_id: null,
    }]);
    addRoute(seed.db, { id: 'R_M2', from_location_id: IDS.L3, to_location_id: 'L3B', kind: 'door', map_id: IDS.M2, distance_basis: 'estimated' });
    assert.notEqual(signatureOf(seed.db, IDS.M2), beforeM2, 'M2 自己的路线变化必须失效 M2');
    assert.notEqual(signatureOf(seed.db, IDS.M1), beforeM1, 'M1 仍然只受自己的路线影响');
  } finally {
    seed.close();
  }
});

/* ------------------------------------------------------------------ *
 * SIG04：成功生成后不再重复选图；自身写回不形成循环
 * ------------------------------------------------------------------ */

test('SIG04 记录指纹后，连续两次正常构建都不再选该图', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const tables = createTableReadPort(seed.db);
    // 构建一次，拿到本轮每图指纹（真实构建路径）
    const first = buildSqlLayoutTask(seed.db, BRANCH, turnInput(), 'turn_sig_1');
    assert.ok(first, '首次构建应选出需要布局的图');
    const mapIds = first.mapIds;
    assert.ok(mapIds.length > 0);

    // 保存指纹（模拟生成成功）
    const frame0 = frameOf(seed.db, mapIds[0]);
    frame0.atlasScene = { kind: 'atlas-scene', version: 1, mapId: mapIds[0], branchId: BRANCH, units: 'meters', layout: { kind: 'overview', bounds: { x: 0, y: 0, w: 10, h: 10 } } };
    writeFrame(seed.db, mapIds[0], frame0);
    const entry = first.contextHashes?.[mapIds[0]];
    assert.equal(entry, computeMapLayoutSignature(tables, BRANCH, mapIds[0]), '构建时算的指纹必须等于保存时重算的指纹');

    saveFingerprints(seed.db, mapIds);

    const second = buildSqlLayoutTask(seed.db, BRANCH, turnInput(), 'turn_sig_2');
    assert.equal(second, null, '指纹未变时不得重复请求（第一次）');
    const third = buildSqlLayoutTask(seed.db, BRANCH, turnInput(), 'turn_sig_3');
    assert.equal(third, null, '指纹未变时不得重复请求（第二次）');
  } finally {
    seed.close();
  }
});

test('SIG04b 生成器估计落位被排除（反复回写不形成循环）；作者确认的落位才进指纹', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    // L2 原本是 approximate 手工落位 → 属于作者意图。
    const baseline = signatureOf(seed.db, IDS.M1);

    // 本轮生成把 L2 改写成自己的估计落位（真实写入路径：coord_precision 变 'layout'）。
    setLocation(seed.db, IDS.L2, {
      coord_precision: 'layout',
      grid_x: 3.25,
      grid_y: 4.75,
      area_geometry_json: JSON.stringify({ kind: 'polygon', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], quality: 'estimated', source: 'estimate' }),
    });
    const afterGeneratorWrite = signatureOf(seed.db, IDS.M1);
    assert.notEqual(afterGeneratorWrite, baseline, '落位从作者意图变成生成器估计，语义确实变了');

    // 关键：一旦是生成器自己的估计落位，反复回写不同坐标/轮廓都不再改变指纹。
    setLocation(seed.db, IDS.L2, { grid_x: 88, grid_y: 77 });
    assert.equal(signatureOf(seed.db, IDS.M1), afterGeneratorWrite, '估计坐标反复变动不得进指纹（否则自己写自己）');
    setLocation(seed.db, IDS.L2, {
      area_geometry_json: JSON.stringify({ kind: 'polygon', points: [{ x: 9, y: 9 }, { x: 5, y: 5 }], quality: 'estimated', source: 'estimate' }),
    });
    assert.equal(signatureOf(seed.db, IDS.M1), afterGeneratorWrite, '估计轮廓反复变动不得进指纹');

    // 作者把它确认成 exact + confirmed 面积 → 重新进入指纹。
    setLocation(seed.db, IDS.L2, {
      coord_precision: 'exact',
      area_geometry_json: JSON.stringify({ kind: 'polygon', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], quality: 'confirmed', source: 'author' }),
    });
    const confirmed = signatureOf(seed.db, IDS.M1);
    assert.notEqual(confirmed, afterGeneratorWrite, '作者修改的布局意图必须进指纹');

    setLocation(seed.db, IDS.L2, {
      area_geometry_json: JSON.stringify({ kind: 'polygon', points: [{ x: 1, y: 1 }, { x: 3, y: 3 }], quality: 'confirmed', source: 'author' }),
    });
    assert.notEqual(signatureOf(seed.db, IDS.M1), confirmed, '作者确认的面积变化必须进指纹');
  } finally {
    seed.close();
  }
});

/* ------------------------------------------------------------------ *
 * SIG05：旧 v2 指纹触发一次刷新；失败保留旧 scene
 * ------------------------------------------------------------------ */

test('SIG05 旧 v2 指纹触发一次刷新，之后不再重复选图', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    saveFingerprints(seed.db, [IDS.M1, IDS.M2]);
    // 把 M1 的指纹改写成旧版本记录
    const frame = frameOf(seed.db, IDS.M1);
    frame[LAYOUT_CONTEXT_FRAME_KEY] = { version: 2, hash: 'legacy-v2-hash', completedTurnId: TURN };
    writeFrame(seed.db, IDS.M1, frame);

    const first = buildSqlLayoutTask(seed.db, BRANCH, turnInput(), 'turn_sig_5');
    assert.ok(first, '旧 v2 指纹必须触发一次合理刷新');
    assert.ok(first.mapIds.includes(IDS.M1), `期望刷新 M1，实际 ${JSON.stringify(first.mapIds)}`);

    // 刷新成功后：把新指纹存回去，再构建两次都不应再选 M1
    const fresh = first.contextHashes[IDS.M1];
    assert.ok(fresh && fresh !== 'legacy-v2-hash');
    const frame2 = frameOf(seed.db, IDS.M1);
    frame2[LAYOUT_CONTEXT_FRAME_KEY] = { version: 3, hash: fresh, completedTurnId: 'turn_sig_5' };
    writeFrame(seed.db, IDS.M1, frame2);

    const second = buildSqlLayoutTask(seed.db, BRANCH, turnInput(), 'turn_sig_6');
    assert.equal(second, null, '刷新一次后不得无限重复');
  } finally {
    seed.close();
  }
});

test('SIG05b 新生成失败时，旧 scene 与旧指纹都保留', async () => {
  const seed = await makeSeedWith(SQL);
  const bytes = seed.exportBytes();
  seed.close();

  const model = {
    async request(req) {
      // 观察与布局一律返回 noop：本轮布局拿不到任何 map.layout.request。
      return { batchId: req.batchId, text: req.batchId.includes('_evidence_') ? '{"facts":[]}' : '{"op":"noop"}', finishReason: 'stop', httpStatus: 200, durationMs: 2 };
    },
  };
  const state = { ctx: { chatId: IDS.chatA, chatMetadata: { atlas: { schemaVersion: 1, world: { id: 'world_sig' } } }, saveMetadata: async () => true } };
  const repo = createSqlRepository({ chatUid: IDS.chatA, branchId: BRANCH, branchName: '主线', modelPort: model, now: () => 1_700_000_000_000 });
  await repo.open({ bytes });
  const host = createAtlasHostPort({
    context: () => state.ctx,
    readBranchState: () => ({ branchId: BRANCH, revision: Number(queryBound(repo.db, 'SELECT revision FROM branches WHERE id = ?', [BRANCH])[0].revision), storageRevision: 0 }),
  });

  try {
    // 预置：M1 已经有旧 scene 与旧指纹（用 v2 记录，模拟历史存档）
    const oldScene = { kind: 'atlas-scene', version: 1, mapId: IDS.M1, branchId: BRANCH, units: 'meters', layout: { kind: 'overview', bounds: { x: 0, y: 0, w: 10, h: 10 } } };
    const frame = frameOf(repo.db, IDS.M1);
    frame.atlasScene = oldScene;
    frame[LAYOUT_CONTEXT_FRAME_KEY] = { version: 2, hash: 'legacy-v2-hash', completedTurnId: TURN };
    writeFrame(repo.db, IDS.M1, frame);
    const sceneBefore = JSON.stringify(frameOf(repo.db, IDS.M1).atlasScene);

    const prepared = await repo.prepareTurn({
      anchor: {
        chatUid: IDS.chatA, branchId: BRANCH, parentTurnId: TURN, hostMessageUid: 'msg_sig_fail',
        variantKey: 'v1', baseRevision: 0, baseStorageRevision: 0, inputHash: 'input_sig_fail',
      },
      userText: '看一眼地图。',
      assistantText: '角色看着地图。',
      sourceSnapshot: SOURCE_SNAPSHOT,
      phaseBatches: ['observe'],
      manual: false,
      layoutMaps: [IDS.M1],
    });
    // 布局没生成 → 本轮回执是 partial（可保存），但绝不能是 failed。
    assert.notEqual(prepared.receipt.status, 'failed');
    assert.ok(
      (prepared.receipt?.issues ?? []).some((issue) => issue.code === 'LAYOUT_NOT_GENERATED'),
      `期望 LAYOUT_NOT_GENERATED，实际 ${JSON.stringify((prepared.receipt?.issues ?? []).map((i) => i.code))}`,
    );

    const ack = await host.saveCandidate({ capturedHostAnchor: host.captureAnchor(), prepared, envelope: prepared.snapshot ? await repo.currentEnvelope() : null });
    assert.equal(ack.result, 'saved');
    await repo.confirmSaved(ack);

    const after = frameOf(repo.db, IDS.M1);
    assert.equal(JSON.stringify(after.atlasScene), sceneBefore, '新生成失败必须保留旧 scene');
    assert.equal(after[LAYOUT_CONTEXT_FRAME_KEY].hash, 'legacy-v2-hash', '失败不得写入新指纹（否则会假装这轮布局已完成）');
  } finally {
    await repo.close();
  }
});
