/**
 * atlas-world-completion.test.mjs — M3-09 验收（W01/W02/W03/W04/W07/W11）。
 *
 * 这些断言落在 **helper 层**：任务该不该发、候选与缺项对不对、语义去重怎么改写、
 * 质量是否被强制降级。提示词字符串只作辅助检查，核心断言是「有效操作与候选结果」。
 * 夹具只用测试实体（L1/L2/L3/圣罗兰城等 seed 实体 + T_* 测试地点），
 * 绝不把任何用户世界书内容带进测试。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadSqlModule } from '../src/atlas-db-runtime.ts';
import { createTableReadPort } from '../src/atlas-db-readport.ts';
import { createRow } from '../src/atlas-db-defaults.ts';
import {
  WORLD_CONSTRUCTION_OPS,
  WORLD_FILL_FRAME_KEY,
  buildSqlWorldCompletionTask,
  normalizeConstructionOps,
} from '../src/atlas-sql-world-completion.ts';
import { dedupeWorldConstructionOps } from '../src/atlas-sql-world-dedupe.ts';
import { IDS, insertRows, makeSeedWith, inTransaction } from './fixtures/atlas-sql/seed.mjs';

const BRANCH = IDS.branchMain;
const TURN = IDS.seedTurn;

const c = (id) => ({ branchId: BRANCH, id, turnId: TURN, clockS: 0, nowWallMs: 1_700_000_000_000, rulesetVersion: 'atlas-1' });
const locationRow = (id, over = {}) => createRow('locations', { name: id, kind: 'city', ...over }, c(id));
const mapRow = (id, over = {}) => createRow('maps', { name: id, kind: 'site', ...over }, c(id));

/** 额外测试实体：只在测试库内存在。 */
const T = {
  BLD: 'T_BLD',
  MAP: 'T_MAP',
  ROOM_A: 'T_ROOM_A',
  OTHER_BLD: 'T_OTHER_BLD',
  ROOM_B: 'T_ROOM_B',
  DUP_1: 'T_DUP_1',
  DUP_2: 'T_DUP_2',
};

async function fixture() {
  const SQL = await loadSqlModule();
  const seed = await makeSeedWith(SQL);
  const db = seed.db;

  const locations = [
    locationRow(T.BLD, { name: '测试建筑甲', kind: 'building' }),
    locationRow(T.OTHER_BLD, { name: '测试建筑乙', kind: 'building' }),
    // 同父唯一匹配：名称 + 别名
    locationRow(T.ROOM_A, { name: '测试功能间甲', aliases_json: ['功能间甲'], kind: 'room' }),
    // 不同父的同名地点：绝不与 T_ROOM_A 合并
    locationRow(T.ROOM_B, { name: '测试功能间甲', kind: 'room' }),
    // 同父两个候选 → 歧义
    locationRow(T.DUP_1, { name: '重复间', kind: 'room' }),
    locationRow(T.DUP_2, { name: '重复间', kind: 'room' }),
  ];
  const maps = [mapRow(T.MAP, { frame_json: JSON.stringify({ origin_x: 0, origin_y: 0, reference_width_cells: 40, reference_height_cells: 30 }) })];

  insertRows(db, 'entity_keys', locations.map((row) => ({ branch_id: BRANCH, id: row.id, kind: 'location' })));
  // 外键可延迟：先落 parent/map 全空的地点 → 再落地图 → 再回填
  insertRows(db, 'locations', locations);
  insertRows(db, 'maps', maps);
  db.run('BEGIN');
  for (const id of Object.values(T)) db.run(`UPDATE locations SET map_id = ? WHERE branch_id = ? AND id = ?`, [T.MAP, BRANCH, id]);
  for (const id of [T.ROOM_A, T.DUP_1, T.DUP_2]) db.run(`UPDATE locations SET parent_location_id = ? WHERE branch_id = ? AND id = ?`, [T.BLD, BRANCH, id]);
  db.run(`UPDATE locations SET parent_location_id = ? WHERE branch_id = ? AND id = ?`, [T.OTHER_BLD, BRANCH, T.ROOM_B]);
  db.run('COMMIT');

  const tables = createTableReadPort(db);
  return {
    db,
    tables,
    /** 已解码的现网地点行——去重与状态判定必须以数据库为准，而不是测试里手写的数组。 */
    locations: () => tables.selectWhere('locations', { branch_id: BRANCH }, 1000),
    close: () => seed.close(),
  };
}

const baseInput = (over = {}) => ({
  mode: 'local',
  focusLocationIds: [],
  chatUid: IDS.chatA,
  baseRevision: 0,
  baseStorageRevision: 0,
  ...over,
});

/** 读出某地图 frame_json 的明文对象。 */
function readFrame(db, mapId) {
  const rows = db.exec(`SELECT frame_json FROM maps WHERE branch_id = ? AND id = ?`, [BRANCH, mapId]);
  const raw = rows[0]?.values?.[0]?.[0];
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function writeFrame(db, mapId, frame) {
  db.run(`UPDATE maps SET frame_json = ? WHERE branch_id = ? AND id = ?`, [JSON.stringify(frame), BRANCH, mapId]);
}

// ---------------------------------------------------------------------------
// W01 · 允许真正新增地点
// ---------------------------------------------------------------------------

test('W01: 有明确功能的建筑可以真的新增内部地点，parent 只能是真实父地，质量默认 inferred', async () => {
  const f = await fixture();
  const task = buildSqlWorldCompletionTask(
    f.tables,
    BRANCH,
    baseInput({
      focusLocationIds: [T.BLD],
      sourceSnapshot: [{ key: 'LB_BUILDING_A', kind: 'lorebook', hash: 'h1', text: '测试建筑甲是一座带门厅与阅览室的公共建筑。' }],
      focusTerms: ['测试建筑甲'],
    }),
    TURN,
    4,
  );
  assert.ok(task, '存在缺项时必须发出建设任务，而不是直接放弃');
  assert.deepEqual([...task.request.allowedOps], [...WORLD_CONSTRUCTION_OPS]);
  assert.equal(task.request.phase, 'geography');
  assert.ok(task.contextHash.length > 0);
  assert.ok(task.focusLocationIds.includes(T.BLD));

  // 目录必须包含焦点与完整祖先（L1 不在 T_BLD 链上，故此处只需 T_BLD 自身可解析）
  const aliases = task.catalogue.knownRefs.map((ref) => ref.alias);
  assert.ok(aliases.every((alias) => typeof alias === 'string' && alias.length > 0), '不允许出现 undefined alias');
  assert.ok(task.catalogue.knownRefs.some((ref) => ref.id === T.BLD), '焦点地点必须在冻结目录里');

  // 缺项：T_BLD 无子地点、无场景 → NO_INTERNAL_STRUCTURE
  const prompt = task.request.messages.map((m) => m.content).join('\n');
  assert.ok(prompt.includes(T.BLD), '提示词必须给出焦点地点引用');
  assert.ok(/单层建筑无需楼层，单间载具无需多个房间/.test(prompt), '必须明确禁止机械补齐');
  assert.ok(/existence_quality=inferred/.test(prompt), '必须要求未获支持的新地点标 inferred');

  // 模型回两条 new room：parent 只能是真实父地 T_BLD，且质量被强制 inferred
  const modelOps = [
    { op: 'location.upsert', ref: 'new:entry-a', data: { name: '测试入口甲', kind: 'room', parent_ref: T.BLD, existence_quality: 'confirmed' }, why: '该场所需要可进入的常规入口空间' },
    { op: 'location.upsert', ref: 'new:room-a', data: { name: '测试功能间乙', kind: 'room', parent_ref: T.BLD }, why: '依据该建筑的已知功能合理建设' },
  ];
  const deduped = dedupeWorldConstructionOps({ operations: modelOps, existingLocations: f.locations() });
  assert.equal(deduped.reusedIds.length, 0, '名称在旧集合中不存在 → 保持新建，不误合并');
  assert.equal(deduped.issues.length, 0);
  const normalized = normalizeConstructionOps({ operations: deduped.operations, supportedNewRefs: [], knownIds: f.locations().map((row) => row.id) });
  assert.equal(normalized.operations.length, 2);
  for (const op of normalized.operations) {
    assert.equal(op.data.parent_ref, T.BLD, 'parent 必须是真实父地，不能从名称后缀强推');
    assert.equal(op.data.existence_quality, 'inferred', '未获已注册事实支持 → 强制 inferred');
  }
  assert.deepEqual(normalized.downgraded.sort(), ['new:entry-a', 'new:room-a']);
  // 时钟不变：建设阶段不允许任何事件/时间操作
  assert.ok(!WORLD_CONSTRUCTION_OPS.some((op) => op.startsWith('event.')), '建设阶段不得提交事件');
  f.close();
});

// ---------------------------------------------------------------------------
// W02 · 不机械补齐
// ---------------------------------------------------------------------------

test('W02: 单室小载具——noop 合法，不造城区/楼层/走廊，也不需要每轮重建', async () => {
  const f = await fixture();
  // 单间载具：一个合法地点，没有子地点
  const op = { op: 'location.upsert', ref: 'new:vehicle', data: { name: '测试单室载具', kind: 'vehicle', existence_quality: 'inferred' } };
  const normalized = normalizeConstructionOps({ operations: [op, { op: 'noop' }] });
  assert.equal(normalized.operations.length, 2);
  assert.equal(normalized.issues.filter((issue) => issue.code === 'WORLD_CONSTRUCTION_OP_FORBIDDEN').length, 0, 'noop 与合法新地点不得被误拒');

  // 模型只回 noop：程序不补任何实体
  const noopOnly = normalizeConstructionOps({ operations: [{ op: 'noop' }] });
  assert.deepEqual(noopOnly.operations, [{ op: 'noop' }]);
  assert.equal(noopOnly.downgraded.length, 0);

  // 任务本身不得包含「造城区 / 造楼层」的任何操作或强制配额
  assert.ok(!WORLD_CONSTRUCTION_OPS.includes('map.layout.request'), '布局是独立阶段，建设阶段不偷偷造图元');
  const task = buildSqlWorldCompletionTask(f.tables, BRANCH, baseInput({ focusLocationIds: [T.ROOM_A] }), TURN, 4);
  if (task) {
    const prompt = task.request.messages.map((m) => m.content).join('\n');
    assert.ok(/单层建筑无需楼层，单间载具无需多个房间/.test(prompt));
    assert.ok(!/必须生成\s*城区/.test(prompt), '不得强制生成城区');
    assert.ok(task.request.maxTokens > 0);
    // 小房间没有 child 也是合法目标：缺项只是「没有内部结构」，不要求父环
    assert.ok(task.focusLocationIds.length <= 64);
  }
  f.close();
});

// ---------------------------------------------------------------------------
// W03 · 语义去重
// ---------------------------------------------------------------------------

test('W03: 同父唯一匹配复用并改写子引用；不同父不合并；同父多匹配 AMBIGUOUS 拒依赖组', async () => {
  const f = await fixture();
  const existingLocations = f.locations();

  const ops = [
    // 1) 同父唯一匹配（名称命中）
    { op: 'location.upsert', ref: 'new:room-x', data: { name: '测试功能间甲', kind: 'room', parent_ref: T.BLD } },
    // 2) 依赖被复用的新父引用 → 必须改写到旧 ID
    { op: 'location.upsert', ref: 'new:child-c', data: { name: '测试里间', kind: 'room', parent_ref: 'new:room-x' } },
    // 3) 不同父的同名 → 不合并（T_ROOM_B 挂在 T_OTHER_BLD 下）
    { op: 'location.upsert', ref: 'new:room-y', data: { name: '测试功能间甲', kind: 'room', parent_ref: T.OTHER_BLD } },
    // 4) 同父两个候选 → 歧义
    { op: 'location.upsert', ref: 'new:dup', data: { name: '重复间', kind: 'room', parent_ref: T.BLD } },
    // 5) 依赖歧义 ref → 整个依赖组拒绝
    { op: 'location.upsert', ref: 'new:dep', data: { name: '测试依赖间', kind: 'room', parent_ref: 'new:dup' } },
  ];
  const result = dedupeWorldConstructionOps({ operations: ops, existingLocations });

  // 1) 唯一匹配复用：两个不同父地的同名地点各自复用到**自己父地**下的那条
  assert.equal(result.reusedIds.length, 2);
  const byRefNew = new Map(result.reusedIds.map((item) => [item.ref, item]));
  assert.deepEqual(byRefNew.get('new:room-x'), { ref: 'new:room-x', id: T.ROOM_A, name: '测试功能间甲', parentId: T.BLD });
  assert.deepEqual(byRefNew.get('new:room-y'), { ref: 'new:room-y', id: T.ROOM_B, name: '测试功能间甲', parentId: T.OTHER_BLD });

  const byRef = new Map(result.operations.map((op) => [op.ref, op]));
  // 被复用的 new 引用改写成旧 ID
  assert.ok(byRef.has(T.ROOM_A), 'new:room-x 应改写成既有 ID');
  assert.equal(byRef.has('new:room-x'), false);
  // 子引用一并改到旧 ID（不是只改父声明）
  assert.ok(byRef.has('new:child-c'), '未被复用的新地点保持 new 引用');
  assert.equal(byRef.get('new:child-c').data.parent_ref, T.ROOM_A, '子引用必须改到被复用的旧 ID');

  // 3) 不同父不合并：T_OTHER_BLD 下的同名地点**绝不**并入 T_BLD 下的那一条
  assert.notEqual(byRefNew.get('new:room-y').id, T.ROOM_A, '不同父的同名地点不得跨父合并');
  assert.equal(byRef.has('new:room-y'), false);
  assert.ok(byRef.has(T.ROOM_B));

  // 4) 歧义 + 依赖组拒绝
  const ambiguous = result.issues.filter((issue) => issue.code === 'LOCATION_NAME_AMBIGUOUS');
  assert.equal(ambiguous.length, 1);
  assert.match(ambiguous[0].message, /T_DUP_1|T_DUP_2/);
  assert.ok(result.rejectedRefs.includes('new:dup'));
  assert.equal(byRef.has('new:dup'), false, '歧义的新地点不得输出');
  assert.equal(byRef.has('new:dep'), false, '依赖歧义 ref 的操作整体出局');
  assert.ok(result.issues.some((issue) => issue.code === 'WORLD_DEPENDENCY_GROUP_REJECTED'));
  f.close();
});

test('W03: 名称为空的 location.upsert 被拒绝，不写入不可去重的实体', async () => {
  const f = await fixture();
  const result = dedupeWorldConstructionOps({
    operations: [{ op: 'location.upsert', ref: 'new:nameless', data: { kind: 'room', parent_ref: T.BLD } }],
    existingLocations: f.locations(),
  });
  assert.ok(result.issues.some((issue) => issue.code === 'LOCATION_NAME_REQUIRED'));
  assert.equal(result.operations.length, 0);
  assert.ok(result.rejectedRefs.includes('new:nameless'));
  f.close();
});

// ---------------------------------------------------------------------------
// W04 · 64+1 目标
// ---------------------------------------------------------------------------

test('W04: 65 个目标 → 处理 64 个，第 65 个完整 ID 进 remaining，alias 无一 undefined', async () => {
  const SQL = await loadSqlModule();
  const seed = await makeSeedWith(SQL);
  const db = seed.db;
  const ids = Array.from({ length: 65 }, (_, i) => `T_${String(i + 1).padStart(3, '0')}`);
  const rows = ids.map((id) => locationRow(id, { name: `未分类地 ${id}`, kind: 'city' }));
  insertRows(db, 'entity_keys', rows.map((row) => ({ branch_id: BRANCH, id: row.id, kind: 'location' })));
  insertRows(db, 'locations', rows);

  const tables = createTableReadPort(db);
  const task = buildSqlWorldCompletionTask(tables, BRANCH, baseInput({ focusLocationIds: ids }), TURN, 4);
  assert.ok(task);
  assert.equal(task.focusLocationIds.length, 64, '目录上限 64，不静默超发');
  assert.ok(task.remainingLocationIds.includes('T_065'), '第 65 个的完整 ID 必须留在 remainingLocationIds');
  assert.ok(task.catalogue.knownRefs.every((ref) => typeof ref.alias === 'string' && ref.alias.length > 0));
  assert.ok(task.catalogue.knownRefs.every((ref) => typeof ref.id === 'string' && ref.id.length > 0));
  assert.ok(task.catalogue.issues.some((issue) => issue.code === 'WORLD_TARGETS_TRUNCATED'));
  seed.close();
});

// ---------------------------------------------------------------------------
// W07 · 纯短对话复用
// ---------------------------------------------------------------------------

test('W07: 结构已 ready 且 contextHash 未变 → 不发建设请求；来源变化或没预算才重新发', async () => {
  const f = await fixture();
  const input = baseInput({ focusLocationIds: [T.BLD], focusTerms: ['测试建筑甲'], policy: { maxAdditionalDepth: 0 } });

  // T_MAP 已有场景（结构可绘制）→ 本子树的缺项为空，这是「已建设场所」的前提
  const scene = { kind: 'atlas-scene', version: 1, generator: 'test', mapId: T.MAP, branchId: BRANCH, sourceRevision: 1, units: 'cells', metersPerCell: 1, metricQuality: 'estimated', inputSignature: 'test', layout: {} };
  writeFrame(f.db, T.MAP, { ...(readFrame(f.db, T.MAP) ?? {}), atlasScene: scene });

  // 第一次：没有 atlasWorldFill → 必须发任务
  const first = buildSqlWorldCompletionTask(f.tables, BRANCH, input, TURN, 4);
  assert.ok(first, '没有建设状态时必须发任务');
  assert.deepEqual(first.focusLocationIds, [T.BLD], '结构已建成的焦点不产生缺项');

  // 模拟上一层：布局完成 → 写 atlasWorldFill（M3-12 的口径）
  writeFrame(f.db, T.MAP, { ...(readFrame(f.db, T.MAP) ?? {}), [WORLD_FILL_FRAME_KEY]: {
    version: 1, policyVersion: 1, contextHash: first.contextHash, status: 'ready',
    completedTurnId: TURN, createdLocationIds: [], createdRouteIds: [], remainingLocationIds: [], reasonCode: null,
  } });

  // 第二轮：一切未变 → 直接 null，不发建设请求
  assert.equal(buildSqlWorldCompletionTask(f.tables, BRANCH, input, TURN, 4), null, '普通短对话不得重建设');
  // 连续三轮短对话同样不发
  for (let i = 0; i < 3; i += 1) assert.equal(buildSqlWorldCompletionTask(f.tables, BRANCH, input, TURN, 4), null);

  // 世界书内容变了 → contextHash 变 → 重新发
  const changed = buildSqlWorldCompletionTask(f.tables, BRANCH, {
    ...input,
    sourceSnapshot: [{ key: 'LB_NEW', kind: 'lorebook', hash: 'h2', text: '新资料：测试建筑甲新开了一条走廊。' }],
  }, TURN, 4);
  assert.ok(changed, '来源变化后必须重新评估建设');
  assert.notEqual(changed.contextHash, first.contextHash);

  // 没有预算 → null（由调用方记 deferred，不伪装成功）
  assert.equal(buildSqlWorldCompletionTask(f.tables, BRANCH, input, TURN, 0), null);
  // Empty caller focus derives the real POV location from the candidate.
  assert.ok(buildSqlWorldCompletionTask(f.tables, BRANCH, baseInput({ focusLocationIds: [] }), TURN, 4));
  f.close();
});

// ---------------------------------------------------------------------------
// W11 · 建设重试幂等
// ---------------------------------------------------------------------------

test('W11: 相同输入第二次重试复用已建地点，不造同名重复地点', async () => {
  const f = await fixture();
  const input = baseInput({
    focusLocationIds: [T.BLD],
    sourceSnapshot: [{ key: 'LB_BUILDING_A', kind: 'lorebook', hash: 'h1', text: '测试建筑甲是一座带门厅与阅览室的公共建筑。' }],
  });
  const first = buildSqlWorldCompletionTask(f.tables, BRANCH, input, TURN, 4);
  assert.ok(first);
  const again = buildSqlWorldCompletionTask(f.tables, BRANCH, input, TURN, 4);
  assert.ok(again);
  assert.equal(again.contextHash, first.contextHash, '相同 anchor/input → 同一 contextHash');
  assert.equal(again.catalogue.catalogueHash, first.catalogue.catalogueHash, '冻结目录不得重编号');
  assert.deepEqual(again.focusLocationIds, first.focusLocationIds);

  const modelOps = [
    { op: 'location.upsert', ref: 'new:entry-a', data: { name: '测试入口甲', kind: 'room', parent_ref: T.BLD, existence_quality: 'inferred' }, why: '入口空间' },
    { op: 'location.upsert', ref: 'new:room-b', data: { name: '测试阅览室', kind: 'room', parent_ref: T.BLD, existence_quality: 'inferred' }, why: '功能空间' },
  ];

  // 第一次：全是新地点
  const attempt1 = dedupeWorldConstructionOps({ operations: modelOps, existingLocations: f.locations() });
  assert.equal(attempt1.reusedIds.length, 0);

  // 模拟第一次已落库
  insertRows(f.db, 'entity_keys', [
    { branch_id: BRANCH, id: 'T_NEW_ENTRY', kind: 'location' },
    { branch_id: BRANCH, id: 'T_NEW_ROOM', kind: 'location' },
  ]);
  insertRows(f.db, 'locations', [
    locationRow('T_NEW_ENTRY', { name: '测试入口甲', kind: 'room', parent_location_id: T.BLD, map_id: T.MAP }),
    locationRow('T_NEW_ROOM', { name: '测试阅览室', kind: 'room', parent_location_id: T.BLD, map_id: T.MAP }),
  ]);

  // 第二次同输入同输出：必须复用，不新增重复地点
  const attempt2 = dedupeWorldConstructionOps({ operations: modelOps, existingLocations: f.locations() });
  assert.equal(attempt2.reusedIds.length, 2, '重试必须复用旧地点，而不是再造两个');
  assert.deepEqual(attempt2.reusedIds.map((item) => item.id).sort(), ['T_NEW_ENTRY', 'T_NEW_ROOM']);
  assert.equal(attempt2.issues.filter((issue) => issue.code === 'LOCATION_NAME_AMBIGUOUS').length, 0);
  assert.deepEqual(attempt2.operations.map((op) => op.ref).sort(), ['T_NEW_ENTRY', 'T_NEW_ROOM']);
  f.close();
});
