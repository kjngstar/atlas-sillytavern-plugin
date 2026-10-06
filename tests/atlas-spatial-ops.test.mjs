/**
 * atlas-spatial-ops.test.mjs — M2/P07：`map.layout.request` 协议回归。
 *
 * 全部走**真实编译入口**（parseOperations → compileOperations），不测常量是否存在：
 * - 有效请求 → 变更行、依赖、原 frame 与 row_rev 一致性；
 * - 未知引用 / 类型不符 → 精确路径的 error 且不产生变更；
 * - 局部 group 引用（家具）→ 不建 entity_keys、不进依赖；
 * - 程序独占字段 → 警告并剥离，不写入；
 * - 无 source → 正常编译（不因缺 source 改判）；
 * - 同批前向声明 → 先建房间再请求图可解析；
 * - 重复请求 → 幂等，不重复写行；
 * - 一行坏、其他有效 → 坏行只拒绝自己；
 * - repair 票据 → 只带失败行与其错误码。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS } from './fixtures/atlas-sql/seed.mjs';
import { SOURCE_SNAPSHOT } from './fixtures/atlas-sql/model-cases.mjs';
import { parseOperations } from '../src/atlas-ops-parser.ts';
import { compileOperations, compilerTable } from '../src/atlas-ops-compile.ts';
import { buildRepairBatch } from '../src/atlas-ops-repair.ts';
import { buildStagePrompt } from '../src/atlas-ops-prompts.ts';
import { allowedOpsForPhase } from '../src/atlas-ops-contract.ts';
import { makeAnchor } from './helpers/atlas-compile-context.mjs';
import { createTableReadPort } from '../src/atlas-db-readport.ts';

const SQL = await (await import('sql.js')).default();

const ANCHOR = makeAnchor();
const BRANCH = IDS.branchMain;
const MAP_FLOOR = IDS.M2; // 教室图（interior，L3 归它）
const MAP_WORLD = IDS.M1; // 世界图（L1/L2 归它）

async function fresh() {
  return makeSeedWith(SQL);
}

/** 真实编译路径：parser → compileOperations（上下文与生产同源）。 */
function compileText(seed, text, { phase = 'geography', clockS = 0, extraRefs = [] } = {}) {
  const parsed = parseOperations(text, { phase });
  const out = compileOperations({
    operations: parsed.operations,
    anchor: ANCHOR,
    phase,
    clockS,
    revision: 0,
    tables: createTableReadPort(seed.db),
    sources: { phase, snapshot: SOURCE_SNAPSHOT, clockS },
    knownRefs: [...seed.refs.map((ref) => ({ alias: ref.alias, id: ref.id, kind: ref.kind })), ...extraRefs],
  });
  return { parsed, out };
}

function errorsOf(out) {
  return out.issues.filter((i) => i.severity === 'error');
}

test('P07-01 编译器注册：map.layout.request 在编译表里且 15 个操作都在', () => {
  const table = compilerTable();
  assert.ok(table.includes('map.layout.request'), 'COMPILERS 必须注册 map.layout.request');
  assert.equal(table.length, 15, '14 个原有操作 + map.layout.request = 15');
  assert.ok(allowedOpsForPhase('geography').includes('map.layout.request'), 'geography 阶段必须放行');
});

test('P07-02 有效请求：一条 maps 变更、依赖完整、原 frame 与 row_rev 一致、原数据未被改写', async () => {
  const seed = await fresh();
  const text = [
    '{"op":"location.upsert","ref":"new:l3b","data":{"name":"讲台","parent_ref":"L3"}}',
    '{"op":"map.layout.request","ref":"M2","data":{"kind":"floor","spec":{"rooms":[{"id":"new:l3b","side":"south","w":4,"h":3}]}}}',
  ].join('\n');
  const { parsed, out } = compileText(seed, text);
  assert.deepEqual(errorsOf(out), [], `不应有 error：${JSON.stringify(out.issues)}`);

  const entry = out.results[1];
  const mut = entry.result.mutations[0];
  assert.equal(entry.result.mutations.length, 1, '只有一条 maps 变更');
  assert.equal(mut.table, 'maps');
  assert.equal(mut.rowId, MAP_FLOOR);

  const roomId = out.aliasById.get('l3b');
  assert.match(roomId, /^loc_/, '前向声明的房间必须解析成 location 规范 ID');
  assert.ok(entry.result.dependencies.includes(MAP_FLOOR), '依赖必须含地图');
  assert.ok(entry.result.dependencies.includes(roomId), '依赖必须含新房间');

  const before = mut.before;
  const after = mut.after;
  assert.equal(before.row_rev, 1);
  assert.equal(after.row_rev, 2, 'row_rev 必须自增 1');
  assert.equal(before.frame_json.atlasLayoutRequest, undefined, '原行不得被就地改写');

  const req = after.frame_json.atlasLayoutRequest;
  assert.equal(req.kind, 'floor');
  assert.equal(req.mapId, MAP_FLOOR);
  assert.equal(req.operationId, entry.opId);
  assert.equal(req.spec.rooms[0].id, roomId, 'spec 里的别名必须换成规范 ID');
  assert.equal(req.spec.rooms[0].side, 'south');
  // 原 frame 保留
  assert.equal(after.frame_json.origin_x, 0);
  assert.equal(after.frame_json.reference_width_cells, 20);
  assert.equal(after.meters_per_cell, 1, '其他列不动');

  // 原数据未被改写（编译只能读）
  assert.equal(parsed.operations[1].value.data.spec.rooms[0].id, 'new:l3b');
});

test('P07-03 未知引用：REF_UNKNOWN 带精确路径，且不产生变更', async () => {
  const seed = await fresh();
  const text = '{"op":"map.layout.request","ref":"M2","data":{"kind":"floor","spec":{"rooms":[{"id":"new:ghost","side":"north"}]}}}';
  const { out } = compileText(seed, text);
  const errs = errorsOf(out);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, 'REF_UNKNOWN');
  assert.equal(errs[0].path, '$.data.spec.rooms[0].id');
  assert.equal(out.results[0].result.mutations.length, 0, '坏行不产生变更');
});

test('P07-04 类型不符：rooms.id 指向人物时 REF_TYPE_MISMATCH', async () => {
  const seed = await fresh();
  const text = '{"op":"map.layout.request","ref":"M2","data":{"kind":"floor","spec":{"rooms":[{"id":"C1","side":"north"}]}}}';
  const { out } = compileText(seed, text);
  const errs = errorsOf(out);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, 'REF_TYPE_MISMATCH');
  assert.equal(errs[0].path, '$.data.spec.rooms[0].id');
});

test('P07-05 父图/子图混用：别图的地点进不来，同图的可以', async () => {
  const seed = await fresh();
  // L3 归教室图 M2，放进世界图 M1 的 city 请求 → 冲突
  const bad = '{"op":"map.layout.request","ref":"M1","data":{"kind":"city","spec":{"districts":[{"id":"L3"}]}}}';
  const badOut = compileText(seed, bad).out;
  const errs = errorsOf(badOut);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, 'LAYOUT_REQUEST_CONFLICT');

  // L1/L2 归世界图 M1 → 正常
  const ok = '{"op":"map.layout.request","ref":"M1","data":{"kind":"city","spec":{"districts":[{"id":"L1"}],"buildings":[{"id":"L2","districtId":"L1"}]}}}';
  const okOut = compileText(seed, ok).out;
  assert.deepEqual(errorsOf(okOut), []);
  const req = okOut.results[0].result.mutations[0].after.frame_json.atlasLayoutRequest;
  assert.equal(req.kind, 'city');
  assert.equal(req.spec.buildings[0].districtId, 'L1');
  assert.ok(okOut.results[0].result.dependencies.includes('L2'));
});

test('P07-06 局部 group 引用：家具 ID 不建 entity_keys、不进依赖', async () => {
  const seed = await fresh();
  const text =
    '{"op":"map.layout.request","ref":"M2","data":{"kind":"floor","spec":{"contents":[{"id":"table-1","kind":"table"}],"actors":[{"id":"C1","near":"table-1"}],"items":[{"id":"I1","on":"new:table-1"}]}}}';
  const { out } = compileText(seed, text);
  assert.deepEqual(errorsOf(out), [], JSON.stringify(out.issues));
  const entry = out.results[0];
  const req = entry.result.mutations[0].after.frame_json.atlasLayoutRequest;
  assert.equal(req.spec.contents[0].id, 'table-1');
  assert.equal(req.spec.actors[0].near, 'table-1', '局部视觉 ID 原样保留');
  assert.equal(req.spec.items[0].on, 'new:table-1');
  assert.ok(entry.result.dependencies.includes('C1'), '人物短引用要规范化并进入依赖');
  assert.ok(entry.result.dependencies.includes('I1'));
  assert.equal(entry.result.dependencies.includes('table-1'), false, '家具组不是实体');
  assert.deepEqual(entry.result.entityKeyWrites ?? [], [], '不得写 entity_keys');
});

test('P07-07 程序独占字段：警告并剥离，不写进请求', async () => {
  const seed = await fresh();
  const text =
    '{"op":"map.layout.request","ref":"M2","data":{"kind":"floor","spec":{"seed":123,"locks":[],"metersPerCell":2,"rooms":[{"id":"L3","side":"north"}]}}}';
  const { out } = compileText(seed, text);
  const warnings = out.issues.filter((i) => i.code === 'SYSTEM_FIELD_IGNORED');
  assert.equal(warnings.length, 3, 'seed / locks / metersPerCell 各一条警告');
  assert.deepEqual(errorsOf(out), []);
  const req = out.results[0].result.mutations[0].after.frame_json.atlasLayoutRequest;
  assert.equal(req.spec.seed, undefined);
  assert.equal(req.spec.locks, undefined);
  assert.equal(req.spec.metersPerCell, undefined);
  assert.equal(req.spec.rooms[0].id, 'L3');
});

test('P07-08 无 source 也能编译：不因缺 source 改判', async () => {
  const seed = await fresh();
  const text = '{"op":"map.layout.request","ref":"M2","data":{"kind":"floor","spec":{"rooms":[{"id":"L3"}]}}}';
  const { out } = compileText(seed, text);
  assert.deepEqual(errorsOf(out), [], JSON.stringify(out.issues));
  assert.equal(out.results[0].result.mutations.length, 1);
  assert.equal(out.issues.some((i) => i.code.startsWith('SOURCE_')), false);
});

test('P07-09 重复请求：幂等，第二次不再写行', async () => {
  const seed = await fresh();
  const text = '{"op":"map.layout.request","ref":"M2","data":{"kind":"floor","spec":{"rooms":[{"id":"L3","side":"north"}]}}}';
  const first = compileText(seed, text);
  const mut = first.out.results[0].result.mutations[0];
  assert.equal(mut.table, 'maps');

  // 把第一次的候选写回基态（模拟已提交），再编一次
  seed.db.run('UPDATE maps SET frame_json = ?, row_rev = ?, updated_turn_id = ? WHERE branch_id = ? AND id = ?', [
    JSON.stringify(mut.after.frame_json),
    mut.after.row_rev,
    mut.after.updated_turn_id,
    BRANCH,
    MAP_FLOOR,
  ]);

  const second = compileText(seed, text);
  assert.deepEqual(errorsOf(second.out), [], JSON.stringify(second.out.issues));
  assert.equal(second.out.results[0].result.mutations.length, 0, '重复相同请求不产生新变更');
  assert.equal(second.out.results[0].result.readSet.length, 1, '仍要回报读集');
  assert.equal(second.out.results[0].result.readSet[0].rowId, MAP_FLOOR);
});

test('P07-10 同批独立请求：后一个不抹掉前一个的房间', async () => {
  const seed = await fresh();
  const text = [
    '{"op":"map.layout.request","ref":"M2","data":{"kind":"floor","spec":{"rooms":[{"id":"L3","side":"north"}]}}}',
    '{"op":"map.layout.request","ref":"M2","data":{"kind":"floor","spec":{"actors":[{"id":"C1","roomId":"L3"}]}}}',
  ].join('\n');
  const { out } = compileText(seed, text);
  assert.deepEqual(errorsOf(out), [], JSON.stringify(out.issues));
  const req = out.results[1].result.mutations[0].after.frame_json.atlasLayoutRequest;
  const ids = req.spec.rooms.map((r) => r.id);
  assert.ok(ids.includes('L3'), '第一个请求的房间必须在合并结果里');
  assert.equal(req.spec.actors[0].roomId, 'L3');
});

test('P07-11 同批同 id 不同值：LAYOUT_REQUEST_CONFLICT，不静默挑一个', async () => {
  const seed = await fresh();
  const text = [
    '{"op":"map.layout.request","ref":"M2","data":{"kind":"floor","spec":{"rooms":[{"id":"L3","side":"north"}]}}}',
    '{"op":"map.layout.request","ref":"M2","data":{"kind":"floor","spec":{"rooms":[{"id":"L3","side":"south"}]}}}',
  ].join('\n');
  const { out } = compileText(seed, text);
  const errs = errorsOf(out);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, 'LAYOUT_REQUEST_CONFLICT');
  assert.equal(out.results[1].result.mutations.length, 0);
});

test('P07-12 一行坏、其他有效：坏行只拒绝自己', async () => {
  const seed = await fresh();
  const text = [
    '{"op":"location.upsert","ref":"new:ok1","data":{"name":"储藏室","parent_ref":"L3"}}',
    '{"op":"map.layout.request","ref":"M2","data":{"kind":"floor","spec":{"rooms":[{"id":"new:ghost"}]}}}',
    '{"op":"map.layout.request","ref":"M2","data":{"kind":"floor","spec":{"rooms":[{"id":"new:ok1","side":"east"}]}}}',
  ].join('\n');
  const { out } = compileText(seed, text);
  assert.equal(errorsOf(out).length, 1, '只有坏行报错');
  assert.equal(out.results[1].result.mutations.length, 0, '坏行无变更');
  assert.equal(out.results[2].result.mutations.length, 1, '独立的有效行照常编译');
  assert.ok(
    out.results[0].result.mutations.some((m) => m.table === 'locations'),
    '建房间那行不受影响（locations 变更 + entity_keys）',
  );
  assert.equal(
    (out.results[0].result.entityKeyWrites ?? []).some((k) => k.kind === 'location'),
    true,
    '新房间要写 entity_keys',
  );
});

test('P07-13 repair 票据：只带失败行与其错误码，不夹带已成功的行', async () => {
  const seed = await fresh();
  const text = [
    '{"op":"location.upsert","ref":"new:ok1","data":{"name":"储藏室","parent_ref":"L3"}}',
    '{"op":"map.layout.request","ref":"M2","data":{"kind":"floor","spec":{"rooms":[{"id":"new:ghost"}]}}}',
  ].join('\n');
  const { out } = compileText(seed, text);
  const failed = out.results[1];
  const batch = buildRepairBatch(
    [{ op: { opId: failed.opId, line: 2, rawHash: '', value: { op: 'map.layout.request', ref: 'M2', data: { kind: 'floor', spec: { rooms: [{ id: 'new:ghost' }] } } } }, issues: failed.result.issues, readSet: failed.result.readSet }],
    { phase: 'geography', allowedOps: [...allowedOpsForPhase('geography')] },
  );
  assert.equal(batch.tickets.length, 1);
  assert.equal(batch.tickets[0].ticket, 'R1');
  const joined = batch.promptLines.join('\n');
  assert.ok(joined.includes('R1'));
  assert.ok(joined.includes('REF_UNKNOWN'), '票据必须带准确错误码');
  assert.ok(joined.includes('map.layout.request'));
  assert.equal(joined.includes('储藏室'), false, '已成功操作不得出现在 repair 段');
  assert.ok(batch.tickets[0].allowedOps.includes('map.layout.request'), 'repair 只能使用原允许集合');
});

test('P07-14 提示词：geography 含新操作说明与程序注入的 ID/尺寸/锁摘要', () => {
  const request = buildStagePrompt({
    phase: 'geography',
    mapLayoutIds: 'M2=教室图、L3=教室',
    mapLayoutFrame: '20×15 格、米/格=1',
    mapLayoutLocks: '教室边界已确认',
  });
  const text = request.messages.map((m) => m.content).join('\n');
  assert.ok(text.includes('map.layout.request'));
  assert.ok(text.includes('布局可用 ID：M2=教室图、L3=教室'));
  assert.ok(text.includes('幅面尺寸：20×15 格、米/格=1'));
  assert.ok(text.includes('已确认/锁定结构：教室边界已确认'));
  assert.ok(text.includes('不要输出完整 scene'), '必须明确不输出完整 scene');
  assert.ok(text.includes('没有河流/水域资料时不要选 city 模板'));
  assert.ok(request.allowedOps.includes('map.layout.request'));
});
