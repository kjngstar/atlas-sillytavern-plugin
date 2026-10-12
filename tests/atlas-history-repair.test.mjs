/**
 * atlas-history-repair.test.mjs — P15/§22 历史修复预览（HIST01–HIST05）
 *
 * 纪律：
 *  - 夹具是**真实 SQL 档**（种子库 + 真实行），不是手搓的 DTO；每张实体表都先登记
 *    `entity_keys` 身份（否则 BEFORE INSERT 触发器直接 ABORT —— 这正是真档的样子）；
 *  - 不构造 schema 不允许的状态（例如同一容器的两张 active 图会违反
 *    `idx_maps_container_unique`）：候选口径必须能在合法旧档里真实出现；
 *  - 「只读」用**存档字节哈希**证明，不靠「没报错」；
 *  - 「全库检索」用插入 > 一页（`HISTORY_SCAN_PAGE`）的真实行证明分页确实读完了；
 *  - 应用必须显式选择新鲜预览，并经候选事务、ACK、journal 与恢复。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSeedWith, IDS, insertRows, inTransaction } from './fixtures/atlas-sql/seed.mjs';
import { createRow } from '../src/atlas-db-defaults.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { encodeSnapshot, sha256Hex } from '../src/atlas-db-envelope.ts';
import { openSqlSession } from '../src/atlas-sql-session.ts';
import { handleSqlChatRequest } from '../src/atlas-sql-chat.ts';
import * as Kit from '../vendor/atlas-spatial/index.mjs';
import {
  HISTORY_SCAN_PAGE, MERGE_REDIRECT_MAX_DEPTH, applyHistoryRepair, assertHistoryPreviewFresh, buildHistoryRepairPreview, resolveMergedId,
} from '../src/atlas-history-repair.ts';

const SQL = await (await import('sql.js')).default();
const BRANCH = IDS.branchMain;
const TURN = IDS.seedTurn;
const ctx = (id) => ({ branchId: BRANCH, id, turnId: TURN, clockS: 0, nowWallMs: 1_700_000_000_000, rulesetVersion: 'atlas-1' });

/** 实体表 → entity_keys.kind。真实档里四张实体表的 id 必须先登记身份。 */
const ENTITY_KIND = { locations: 'location', characters: 'character', items: 'item', factions: 'faction' };

/** 插入实体行：先补 `entity_keys` 身份（已存在的不重复插），再插本体。 */
function insertEntities(db, table, rows) {
  const kind = ENTITY_KIND[table];
  if (kind) {
    const missing = rows.map((row) => row.id).filter((id) => queryBound(
      db, 'SELECT 1 AS n FROM entity_keys WHERE branch_id = ? AND id = ?', [BRANCH, id]).length === 0);
    if (missing.length) insertRows(db, 'entity_keys', missing.map((id) => ({ branch_id: BRANCH, id, kind })));
  }
  insertRows(db, table, rows);
}

const locationRow = (id, over = {}) => createRow('locations', { name: id, kind: 'room', ...over }, ctx(id));
const mapRow = (id, container, over = {}) => createRow('maps', { name: id, kind: 'interior', container_location_id: container, ...over }, ctx(id));
const routeRow = (id, from, to, mapId = null) => createRow('routes', { from_location_id: from, to_location_id: to, map_id: mapId }, ctx(id));

/**
 * 空间权威（P12 §19）真实形状：`{version:1, locationId, revision, size, furnishing}`。
 * 尺寸记录放在 frame 里 —— 这正是「父子尺寸冲突」在真实档里的落点。
 */
const canonicalFrame = (locationId, widthM, heightM, { quality = 'estimated', locked = false, basis = 'first-estimate' } = {}) => ({
  cols: 12, rows: 8,
  atlasSpaceCanonical: { version: 1, locationId, revision: 1, size: { widthM, heightM, quality, locked, basis: { kind: basis, referenceId: null } }, furnishing: [] },
});

/** 父图已保存场景：父图房间里带着子地点的轮廓（这是 canonical 的投影，不是第二份权威）。 */
const sceneFrame = (mapId, rooms) => ({
  cols: 40, rows: 40,
  atlasScene: { kind: 'atlas-scene', version: 1, mapId, branchId: BRANCH, units: 'meters', metersPerCell: 1,
    layout: { kind: 'floor', bounds: { x: 0, y: 0, w: 40, h: 40 }, rooms }, generator: 'history-repair-fixture' },
});

async function world(setup) {
  const seed = await makeSeedWith(SQL);
  if (setup) setup(seed.db);
  const bytes = seed.exportBytes();
  seed.close();
  const chatUid = `history-repair-${Math.random().toString(36).slice(2, 8)}`;
  const chatMetadata = {};
  const modelPort = { calls: [], async request(req) { this.calls.push(req); return { batchId: req.batchId, text: '{"op":"noop"}', finishReason: 'stop', httpStatus: 200, durationMs: 1 }; } };
  const envelope = await encodeSnapshot(bytes, { chatUid, worldUid: chatUid, storageRevision: 0, activeBranchId: BRANCH });
  chatMetadata.atlas = { sqlMode: true, database: envelope };
  const session = await openSqlSession({ chatUid, chatMetadata, saveSession: async () => true, modelPort, now: () => 1_700_000_000_000 });
  return { session, bytes };
}
const snapshotOf = (session) => sha256Hex(session.repo.exportCurrent());
const previewOf = (session, extra = {}) => buildHistoryRepairPreview({
  db: session.repo.db, branchId: session.branchId,
  revision: session.repo.internal.currentRevision(), headTurnId: session.repo.internal.currentHeadTurnId(), ...extra,
});
const findMerge = (preview, id) => preview.actions.find((action) => action.kind === 'merge-location'
  && (action.retainedId === id || action.retiredIds.includes(id)));
const mergeActionsOf = (preview) => preview.actions.filter((action) => action.kind === 'merge-location');

test('选定历史合并通过候选、ACK 与 journal 保存，独立恢复接口可还原',async()=>{
 const {session}=await world(db=>inTransaction(db,()=>{
  insertEntities(db,'locations',[locationRow('RP',{kind:'building'}),locationRow('RA',{name:'重复房间',parent_location_id:'RP'}),locationRow('RB',{name:'重复房间',parent_location_id:'RP'})]);
  insertEntities(db,'characters',[createRow('characters',{name:'甲',location_id:'RA'},ctx('RCA')),createRow('characters',{name:'乙',location_id:'RA'},ctx('RCB')),createRow('characters',{name:'丙',location_id:'RB'},ctx('RCC')),createRow('characters',{name:'丁',location_id:'RA'},ctx('RCD')),createRow('characters',{name:'戊',location_id:'RA'},ctx('RCE'))]);
  insertRows(db,'maps',[mapRow('RMAP','RB')]);
  insertRows(db,'routes',[routeRow('RROUTE','RP','RB')]);
 }));
 try{
  const preview=previewOf(session),index=preview.actions.findIndex(a=>a.kind==='merge-location'&&a.retiredIds.includes('RB'));
  assert.ok(index>=0);const before=await snapshotOf(session);
  const compiled=applyHistoryRepair({db:session.repo.db,branchId:BRANCH,revision:preview.baseRevision,headTurnId:preview.baseHeadTurnId,previewHash:preview.previewHash,actionIndexes:[index],turnId:'inspect-only'});
  assert.ok(compiled.mutations.length>=4);assert.equal(await snapshotOf(session),before,'编译候选不改正式库');
  const result=await handleSqlChatRequest(session,'history-repair-apply',{previewHash:preview.previewHash,actionIndexes:[index],viewMode:'author'}).catch(error=>{throw new Error(JSON.stringify(error.details??error));});
  assert.equal(result.coreSaved,true,JSON.stringify(result));
  assert.equal(queryBound(session.repo.db,'SELECT status,merged_into_id FROM locations WHERE id=?',['RB'])[0].merged_into_id,'RA');
  assert.equal(queryBound(session.repo.db,'SELECT location_id FROM characters WHERE id=?',['RCC'])[0].location_id,'RA');
  assert.equal(queryBound(session.repo.db,'SELECT container_location_id,status FROM maps WHERE id=?',['RMAP'])[0].container_location_id,'RA');
  assert.equal(queryBound(session.repo.db,'SELECT status FROM maps WHERE id=?',['RMAP'])[0].status,'active','唯一容器图保留');
  assert.ok(queryBound(session.repo.db,'SELECT id FROM turn_changes WHERE turn_id=?',[result.nativeReceipt.turnId]).length>=4);
  const restored=await handleSqlChatRequest(session,'history-repair-restore',{turnId:result.nativeReceipt.turnId,expectedRevision:session.repo.internal.currentRevision(),viewMode:'author'});
  assert.equal(restored.coreSaved,true);
  assert.equal(queryBound(session.repo.db,'SELECT status,merged_into_id FROM locations WHERE id=?',['RB'])[0].status,'active');
  assert.equal(queryBound(session.repo.db,'SELECT location_id FROM characters WHERE id=?',['RCC'])[0].location_id,'RB');
  assert.equal(queryBound(session.repo.db,'SELECT container_location_id FROM maps WHERE id=?',['RMAP'])[0].container_location_id,'RB');
  assert.deepEqual(session.repo.db.exec('PRAGMA foreign_key_check'),[]);
 }finally{await session.close?.();}
});

test('过期、未选定、冲突与 POV 的历史修复不会修改原库',async()=>{
 const {session}=await world(db=>inTransaction(db,()=>insertEntities(db,'locations',[locationRow('SA',{name:'根歧义'}),locationRow('SB',{name:'根歧义'})])));
 try{
  const preview=previewOf(session),before=await snapshotOf(session);
  for(const body of [{previewHash:'expired',actionIndexes:[0]},{previewHash:preview.previewHash,actionIndexes:[]},{previewHash:preview.previewHash,actionIndexes:[999]},{previewHash:preview.previewHash,actionIndexes:[0],viewMode:'pov'}]){
   await assert.rejects(()=>handleSqlChatRequest(session,'history-repair-apply',body));
   assert.equal(await snapshotOf(session),before);
  }
 }finally{await session.close?.();}
});

test('历史修复保存失败时原库不变，历史 journal 不被重写',async()=>{
 const {session}=await world(db=>inTransaction(db,()=>insertEntities(db,'locations',[locationRow('FA',{name:'同名'}),locationRow('FB',{name:'同名'})])));
 try{
  const preview=previewOf(session),before=await snapshotOf(session),oldJournal=queryBound(session.repo.db,'SELECT * FROM turn_changes ORDER BY id');
  const input={anchor:{chatUid:session.chatUid,branchId:BRANCH,parentTurnId:session.repo.internal.currentHeadTurnId(),hostMessageUid:'author:history-repair:failed',variantKey:'history-repair',baseRevision:session.repo.internal.currentRevision(),baseStorageRevision:session.repo.storageRevision,inputHash:'failed-save'},userText:'',assistantText:'',sourceSnapshot:[],phaseBatches:[],manual:true,sceneOnly:true,historyRepair:{previewHash:preview.previewHash,actionIndexes:[0]}};
  const prepared=await session.repo.prepareTurn(input);
  assert.equal(await snapshotOf(session),before,'ACK 前正式库不变');
  await session.repo.confirmSaved({token:prepared.token,snapshotSha256:prepared.snapshotSha256,result:'failed'});
  assert.equal(await snapshotOf(session),before);assert.deepEqual(queryBound(session.repo.db,'SELECT * FROM turn_changes ORDER BY id'),oldJournal);
 }finally{await session.close?.();}
});

test('采纳 canonical 尺寸会实际重建父图投影，恢复时还原父图场景',async()=>{
 const {session}=await world(db=>inTransaction(db,()=>{
  const parent=mapRow('SIZE_PARENT','SIZE_BLD',{frame_json:{cols:40,rows:40},meters_per_cell:1,scale_quality:'estimated'});
  const locations=[locationRow('SIZE_BLD',{kind:'building'}),locationRow('SIZE_ROOM',{parent_location_id:'SIZE_BLD',map_id:'SIZE_PARENT'})];
  const scope={chatId:'fixture',branchId:BRANCH,revision:0,viewMode:'author'};
  const built=Kit.buildLayoutContext({scope,mapRow:parent,locations,characters:[],items:[],routes:[]});
  const generated=Kit.generateFloor({rooms:[{id:'SIZE_ROOM',name:'书房',w:4,h:3,side:'north'}]},built.context);
  assert.equal(generated.ok,true,JSON.stringify(generated.issues));
  parent.frame_json={cols:40,rows:40,atlasScene:generated.scene};
  insertEntities(db,'locations',locations);insertRows(db,'maps',[parent,mapRow('SIZE_CHILD','SIZE_ROOM',{frame_json:canonicalFrame('SIZE_ROOM',9,6),meters_per_cell:1})]);
 }));
 try{
  const preview=previewOf(session),index=preview.actions.findIndex(a=>a.kind==='adopt-space-size'&&a.retainedId==='SIZE_ROOM');assert.ok(index>=0);
  const before=queryBound(session.repo.db,'SELECT frame_json FROM maps WHERE id=?',['SIZE_PARENT'])[0].frame_json;
  const result=await handleSqlChatRequest(session,'history-repair-apply',{previewHash:preview.previewHash,actionIndexes:[index],viewMode:'author'});
  assert.equal(result.coreSaved,true);
  const frame=JSON.parse(queryBound(session.repo.db,'SELECT frame_json FROM maps WHERE id=?',['SIZE_PARENT'])[0].frame_json);
  assert.deepEqual(frame.atlasScene.layout.rooms.map(r=>[r.w,r.h]),[[9,6]]);
  await handleSqlChatRequest(session,'history-repair-restore',{turnId:result.nativeReceipt.turnId,expectedRevision:session.repo.internal.currentRevision(),viewMode:'author'});
  assert.equal(queryBound(session.repo.db,'SELECT frame_json FROM maps WHERE id=?',['SIZE_PARENT'])[0].frame_json,before);
 }finally{await session.close?.();}
});

test('合并链恰好到深度上限时仍可解析终点',async()=>{
 const {session}=await world(db=>inTransaction(db,()=>insertEntities(db,'locations',[
  locationRow('LIMIT_A',{status:'merged',merged_into_id:'LIMIT_B'}),locationRow('LIMIT_B'),
 ])));
 try{
  assert.equal(resolveMergedId({db:session.repo.db,branchId:BRANCH,id:'LIMIT_A',maxDepth:1}).resolvedId,'LIMIT_B');
 }finally{await session.close?.();}
});

test('引用列读取失败必须中止历史预览，不能遗漏后报告完整',async()=>{
 const {session}=await world();
 try{
  const db=new Proxy(session.repo.db,{get(target,key){
   if(key==='prepare')return function(sql,...args){
    if(/ AS ref FROM /.test(sql))throw Error('injected reference read failure');
    return target.prepare(sql,...args);
   };
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  assert.throws(()=>buildHistoryRepairPreview({db,branchId:BRANCH,revision:0,headTurnId:null}),
   error=>error.code==='HISTORY_REFERENCE_SCAN_FAILED');
 }finally{await session.close?.();}
});

/* ── HIST01 · 同父重复 vs 不同父同名 ── */

test('HIST01 · 只有同父同名进候选；父地点不同的同名对象保持独立、不许出现在任何动作里', async () => {
  const { session } = await world((db) => {
    insertEntities(db, 'locations', [
      locationRow('P1', { name: '青石镇', kind: 'building' }),
      locationRow('P2', { name: '白石镇', kind: 'building' }),
      locationRow('D1', { name: '青石附楼', parent_location_id: 'P1', kind: 'building' }),
      locationRow('D2', { name: '青石附楼', parent_location_id: 'P1', kind: 'building' }),
      locationRow('D3', { name: '青石附楼', parent_location_id: 'P2', kind: 'building' }),
    ]);
  });
  try {
    const preview = previewOf(session);
    const merge = findMerge(preview, 'D1');
    assert.ok(merge, '同父同名必须进候选');
    assert.deepEqual([merge.retainedId, ...merge.retiredIds].sort(), ['D1', 'D2'], '候选只覆盖同父的两个');
    assert.equal(merge.retiredIds.includes('D3'), false, '父地点不同的同名对象保持独立');
    assert.equal(preview.actions.some((action) => action.kind === 'merge-location'
      && (action.retainedId === 'D3' || action.retiredIds.includes('D3'))), false, '不同父的同名对象不许进任何合并动作');
    assert.ok(preview.counts.sameNameDifferentParent >= 1, '不同父同名必须被单独统计（说明它被看见但没有合并）');
    assert.equal(preview.counts.sameNameSameParent, 1);
    assert.equal(merge.applicable, true, '既没有容器图归属歧义、也没有确认几何分歧 → 该候选可直接应用');
    assert.deepEqual(merge.conflicts, []);
  } finally { await session.close?.(); }
});

test('HIST01 · 引用清点逐列核对：退役方身上的人物/物品/子地点/路线/容器图都要被重定向', async () => {
  const { session } = await world((db) => {
    insertEntities(db, 'locations', [
      locationRow('P1', { name: '青石镇', kind: 'building' }),
      locationRow('D1', { name: '青石附楼', parent_location_id: 'P1', kind: 'building' }),
      locationRow('D2', { name: '青石附楼', parent_location_id: 'P1', kind: 'building' }),
      locationRow('D3', { name: '青石附楼', parent_location_id: 'P1', kind: 'building' }),
      locationRow('D7', { name: '灶房', parent_location_id: 'D2', kind: 'room' }),
      locationRow('D8', { name: '柴房', parent_location_id: 'D1', kind: 'room' }),
    ]);
    // 退役方（D1）身上挂着人物/物品/子地点/路线四类引用；保留方（D2）引用更多。
    insertEntities(db, 'characters', [
      createRow('characters', { name: '住户', location_id: 'D1' }, ctx('HIST_C1')),
      createRow('characters', { name: '更夫', location_id: 'D2' }, ctx('HIST_C2')),
    ]);
    insertEntities(db, 'items', [createRow('items', { name: '钥匙', location_id: 'D1' }, ctx('HIST_I1'))]);
    insertRows(db, 'routes', [routeRow('R1', 'D1', 'P1'), routeRow('R2', 'P1', 'D2'), routeRow('R3', 'D2', 'P1')]);
    insertRows(db, 'maps', [mapRow('M_D2', 'D2', { status: 'active' }), mapRow('M_D3', 'D3', { status: 'active' })]);
  });
  try {
    const preview = previewOf(session);
    assert.equal(mergeActionsOf(preview).length, 1, '三个同父同名只产生一个候选');
    const merge = findMerge(preview, 'D1');
    assert.ok(merge);
    // 引用计数：D2 被引用 5 次，D1 4 次，D3 1 次 → 保留 D2，退役代价最小。
    assert.equal(merge.retainedId, 'D2', '保留引用最多的那个，退役代价最小');
    assert.deepEqual(merge.retiredIds.slice().sort(), ['D1', 'D3']);
    const seen = new Set(merge.referenceChanges.map((change) => `${change.table}.${change.column}=${change.from}`));
    for (const expected of ['characters.location_id=D1', 'items.location_id=D1', 'locations.parent_location_id=D1',
      'routes.from_location_id=D1', 'maps.container_location_id=D3']) {
      assert.ok(seen.has(expected), `引用清点漏了 ${expected}（实际 ${[...seen].join(', ')}）`);
    }
    assert.ok(merge.referenceChanges.every((change) => change.to === merge.retainedId), '重定向目标必须是保留 ID');
    // 保留方自己身上的引用不需要改写 —— 它不会消失。
    assert.equal(seen.has('characters.location_id=D2'), false, '指向保留实体的引用不产生重定向');
    assert.equal(seen.has('routes.to_location_id=D2'), false, '指向保留实体的引用不产生重定向');
    // 引用方自己也在退役集合里的行不产生重定向（整行都要走）。
    const untouched = queryBound(session.repo.db,
      "SELECT id, container_location_id FROM maps WHERE id = 'M_D3'", [])[0];
    assert.deepEqual([untouched.id, untouched.container_location_id], ['M_D3', 'D3'], '预览不动退役方的容器图（只是列出来）');
    assert.deepEqual(merge.childMapChanges.map((change) => [change.mapId, change.action]),
      [['M_D3', 'retire'], ['M_D2', 'keep']], '退役方的容器图列进地图变更；保留方的图保持不动');
    // 两个候选各有 active 容器图 → 还是归属歧义，先定唯一容器图才可应用（§22 合并约束第 5 条）。
    assert.equal(merge.applicable, false, '两个候选各有 active 容器图时不许直接应用');
    assert.ok(merge.conflicts.some((item) => item.code === 'REPAIR_CONTAINER_AMBIGUOUS'));
  } finally { await session.close?.(); }
});

/* ── HIST02 · 根层两个帝国：歧义，禁止自动合并 ── */

test('HIST02 · 根层同名且有各自子树 → 报歧义、不选保留对象，也不产生合并动作', async () => {
  const { session } = await world((db) => {
    insertEntities(db, 'locations', [
      locationRow('E1', { name: '帝国', kind: 'region', parent_location_id: null }),
      locationRow('E2', { name: '帝国', kind: 'region', parent_location_id: null }),
    ]);
    insertRows(db, 'maps', [mapRow('M_E1', 'E1', { status: 'active' }), mapRow('M_E2', 'E2', { status: 'active' })]);
  });
  try {
    const preview = previewOf(session);
    const merge = mergeActionsOf(preview)[0];
    assert.ok(merge, '歧义也必须被列出来（看得见才谈得上人工判断）');
    assert.equal(merge.retainedId, null, '歧义时明确「不选」，不许随便挑一个');
    assert.deepEqual(merge.retiredIds.slice().sort(), ['E1', 'E2']);
    assert.equal(merge.applicable, false);
    assert.ok(merge.conflicts.some((item) => item.code === 'REPAIR_AMBIGUOUS_SAME_NAME_ROOT'));
    assert.ok(merge.conflicts.some((item) => item.severity === 'error'), '歧义必须是阻断级，不只是提示');
    assert.equal(preview.counts.ambiguousSameNameRoot >= 1, true);
  } finally { await session.close?.(); }
});

/* ── HIST03 · 双方都有 active 子图：归属冲突 ── */

test('HIST03 · 两个候选各有 active 容器图 → 列出归属冲突，且一张图都不会被动过', async () => {
  const { session } = await world((db) => {
    insertEntities(db, 'locations', [
      locationRow('P1', { name: '青石镇', kind: 'building' }),
      locationRow('D1', { name: '青石附楼', parent_location_id: 'P1', kind: 'building' }),
      locationRow('D2', { name: '青石附楼', parent_location_id: 'P1', kind: 'building' }),
    ]);
    insertRows(db, 'maps', [mapRow('M_D1', 'D1', { status: 'active' }), mapRow('M_D2', 'D2', { status: 'active' })]);
  });
  try {
    const before = await snapshotOf(session);
    const preview = previewOf(session);
    const merge = findMerge(preview, 'D1');
    assert.equal(merge.applicable, false, '唯一容器图未定之前不可应用');
    assert.ok(merge.conflicts.some((item) => item.code === 'REPAIR_CONTAINER_AMBIGUOUS'));
    // 不产生唯一约束破坏：两张图仍是 active，容器地点仍是各自原值。
    const maps = queryBound(session.repo.db, "SELECT id, container_location_id, status FROM maps WHERE id IN ('M_D1','M_D2') ORDER BY id", []);
    assert.deepEqual(maps.map((row) => [row.id, row.container_location_id, row.status]),
      [['M_D1', 'D1', 'active'], ['M_D2', 'D2', 'active']]);
    assert.equal(await snapshotOf(session), before, '预览不得改动存档');
  } finally { await session.close?.(); }
});

/* ── HIST04 · 确认几何不覆盖；旧 map_id=null 路线只列唯一可推导的 ── */

test('HIST04 · 确认几何冲突 → 不可应用；旧路线只在两端归属唯一时进建议', async () => {
  const { session } = await world((db) => {
    insertEntities(db, 'locations', [
      locationRow('P1', { name: '青石镇', kind: 'building' }),
      locationRow('D1', { name: '青石附楼', parent_location_id: 'P1', kind: 'building',
        area_geometry_json: { quality: 'confirmed', kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 6 }, { x: 0, y: 6 }] } }),
      locationRow('D2', { name: '青石附楼', parent_location_id: 'P1', kind: 'building',
        area_geometry_json: { quality: 'confirmed', kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 12 }, { x: 0, y: 12 }] } }),
      // 唯一可推导：两端都直接带 map_id 且同一个（种子世界的 M1）。
      locationRow('A1', { name: '东门', kind: 'room', map_id: IDS.M1 }),
      locationRow('A2', { name: '西门', kind: 'room', map_id: IDS.M1 }),
      // 不可推导：两端都没有任何可推导的容器图 → 不唯一。
      locationRow('B1', { name: '北门', kind: 'room', map_id: null }),
      locationRow('B2', { name: '南门', kind: 'room', map_id: null }),
    ]);
    insertRows(db, 'maps', [mapRow('M_D2', 'D2', { status: 'active' })]);
    insertRows(db, 'routes', [
      routeRow('ROK', 'A1', 'A2', null),
      routeRow('RBAD', 'B1', 'B2', null),
      routeRow('RCONFLICT', 'A1', 'B1', null),
    ]);
  });
  try {
    const before = await snapshotOf(session);
    const preview = previewOf(session);
    const merge = findMerge(preview, 'D1');
    assert.equal(merge.applicable, false, '确认几何不一致时不许合并');
    assert.ok(merge.conflicts.some((item) => item.code === 'REPAIR_CONFIRMED_GEOMETRY_CONFLICT'));
    const geometries = queryBound(session.repo.db, "SELECT id, area_geometry_json FROM locations WHERE id IN ('D1','D2') ORDER BY id", []);
    assert.equal(JSON.parse(geometries[1].area_geometry_json).points[1].x, 20, '确认几何一个字都不许被预览改写');
    const fixed = preview.actions.filter((action) => action.kind === 'repair-route-map');
    assert.deepEqual(fixed.map((action) => action.referenceChanges[0].rowId), ['ROK'], '只有唯一可推导的那条路线进建议');
    assert.equal(fixed[0].referenceChanges[0].from, null);
    assert.equal(fixed[0].referenceChanges[0].to, IDS.M1);
    assert.ok(preview.counts.routeUndetermined >= 2, '无法唯一推导的路线单独计数，不硬猜');
    assert.ok(preview.counts.routeMapNull >= 3);
    assert.equal(await snapshotOf(session), before);
  } finally { await session.close?.(); }
});

test('HIST04 · 父子尺寸冲突只给 canonical 推荐；已锁定/已确认时不自动采纳', async () => {
  const { session } = await world((db) => inTransaction(db, () => {
    // 地点 ↔ 地图互相引用（location.map_id / map.container_location_id），
    // 真实档里就是一个事务内一起成立的原子组 —— 用事务让 DEFERRABLE 外键在 COMMIT 时统一校验。
    insertEntities(db, 'locations', [
      locationRow('P1', { name: '青石镇', kind: 'building' }),
      locationRow('S1', { name: '书房', kind: 'room', parent_location_id: 'P1', map_id: 'M_P1' }),
      locationRow('T1', { name: '档案室', kind: 'room', parent_location_id: 'P1', map_id: 'M_P1' }),
      locationRow('U1', { name: '储藏室', kind: 'room', parent_location_id: 'P1', map_id: 'M_P1' }),
      locationRow('V1', { name: '门厅', kind: 'room', parent_location_id: 'P1', map_id: 'M_P1' }),
    ]);
    insertRows(db, 'maps', [
      // 父图：房间里带着四个子地点各自的轮廓（canonical 的投影）。
      mapRow('M_P1', 'P1', { status: 'active', frame_json: sceneFrame('M_P1', [
        { id: 'S1', name: '书房', w: 9, h: 6 }, { id: 'T1', name: '档案室', w: 20, h: 20 },
        { id: 'U1', name: '储藏室', w: 20, h: 20 }, { id: 'V1', name: '门厅', w: 10, h: 8 },
      ]) }),
      // 子图：各自持有 canonical。S1 估计值不一致；T1 已锁定；U1 已确认；V1 与投影一致（对照组）。
      mapRow('M_S1', 'S1', { status: 'active', frame_json: canonicalFrame('S1', 18, 12) }),
      mapRow('M_T1', 'T1', { status: 'active', frame_json: canonicalFrame('T1', 7, 5, { quality: 'confirmed', locked: true }) }),
      mapRow('M_U1', 'U1', { status: 'active', frame_json: canonicalFrame('U1', 7, 5, { quality: 'confirmed' }) }),
      mapRow('M_V1', 'V1', { status: 'active', frame_json: canonicalFrame('V1', 10, 8) }),
    ]);
  }));
  try {
    const preview = previewOf(session);
    const sizes = preview.actions.filter((action) => action.kind === 'adopt-space-size');
    assert.deepEqual(sizes.map((action) => action.retainedId).sort(), ['S1', 'T1', 'U1'],
      '只有真的两边都有记录且不一致的地点进候选（V1 一致 → 不进）');
    assert.equal(preview.counts.sizeConflicts, 3);

    const estimated = sizes.find((action) => action.retainedId === 'S1');
    assert.equal(estimated.applicable, true, '双方都是估计值时给出可采纳的 canonical 推荐');
    assert.ok(estimated.conflicts.some((item) => item.code === 'REPAIR_SIZE_MISMATCH'));
    assert.deepEqual([estimated.recommendation.widthM, estimated.recommendation.heightM], [18, 12]);
    assert.equal(estimated.recommendation.locationId, 'S1');
    assert.ok(estimated.recommendation.impact.some((text) => text.includes('M_P1')), '影响范围含父图投影');
    assert.ok(estimated.recommendation.impact.some((text) => text.includes('M_S1')), '影响范围含 canonical 持有者');

    const locked = sizes.find((action) => action.retainedId === 'T1');
    assert.equal(locked.applicable, false, '有锁定事实就不许自动采纳');
    assert.ok(locked.conflicts.some((item) => item.code === 'REPAIR_LOCKED_FACT'));

    const confirmed = sizes.find((action) => action.retainedId === 'U1');
    assert.equal(confirmed.applicable, false, '已确认尺寸不被自动覆盖');
    assert.ok(confirmed.conflicts.some((item) => item.code === 'REPAIR_CONFIRMED_SIZE_CONFLICT'));

    // 推荐值不写回：四张图的 frame 仍然各说各话。
    const frames = queryBound(session.repo.db, "SELECT frame_json FROM maps WHERE id IN ('M_P1','M_S1','M_T1','M_U1')", []);
    const widths = frames.map((row) => JSON.parse(row.frame_json).atlasSpaceCanonical?.size.widthM ?? null);
    assert.equal(widths.filter((value) => value === null).length, 1, '父图不持有 canonical（它只有投影）');
    assert.deepEqual(widths.filter((value) => value !== null).sort((a, b) => a - b), [7, 7, 18]);
  } finally { await session.close?.(); }
});

/* ── HIST04 · 旧 ID 的当前态解析（§22.2 第 2 条） ── */

test('HIST04 · 已合并的旧 ID：当前态解析到保留实体、journal 不被改写、预览不重复提同一件事', async () => {
  const { session } = await world((db) => {
    insertEntities(db, 'locations', [
      locationRow('P1', { name: '青石镇', kind: 'building' }),
      locationRow('D2', { name: '青石附楼', parent_location_id: 'P1', kind: 'building' }),
      locationRow('D1', { name: '青石附楼', parent_location_id: 'P1', kind: 'building', status: 'merged', merged_into_id: 'D2' }),
    ]);
  });
  try {
    const before = await snapshotOf(session);
    const changes = Number(queryBound(session.repo.db, 'SELECT COUNT(*) AS n FROM turn_changes')[0].n);
    const preview = previewOf(session);
    assert.equal(preview.counts.locationsMerged, 1, '已合并的行被单独计数');
    assert.equal(mergeActionsOf(preview).length, 0, '对已经修好的档，预览是幂等的：不重复提同一件事');

    const resolved = await handleSqlChatRequest(session, 'merged-id-resolve', { id: 'D1' });
    assert.equal(resolved.coreSaved, false, '解析不是保存结果');
    assert.equal(resolved.resolution.resolvedId, 'D2', '当前态读取旧 ID 指向保留实体');
    assert.deepEqual(resolved.resolution.chain, ['D1']);
    assert.equal(resolved.resolution.merged, true);
    const live = await handleSqlChatRequest(session, 'merged-id-resolve', { id: 'D2' });
    assert.equal(live.resolution.resolvedId, 'D2', '保留实体解析回自己');
    assert.deepEqual(live.resolution.chain, []);

    assert.equal(await snapshotOf(session), before, '解析必须是纯读');
    assert.equal(Number(queryBound(session.repo.db, 'SELECT COUNT(*) AS n FROM turn_changes')[0].n), changes, 'journal 行数不变');
    // 旧 ID 的记录原样保留（历史就是历史，不用今天的 redirect 改写过去）。
    assert.deepEqual(queryBound(session.repo.db, "SELECT status, merged_into_id FROM locations WHERE id = 'D1'", []),
      [{ status: 'merged', merged_into_id: 'D2' }]);
  } finally { await session.close?.(); }
});

test('HIST04 · 合并链有环或超深 → 明确报错，不挑一个当答案', async () => {
  const chainIds = Array.from({ length: MERGE_REDIRECT_MAX_DEPTH + 2 }, (_, index) => `CH_${String(index).padStart(2, '0')}`);
  const { session } = await world((db) => inTransaction(db, () => {
    insertEntities(db, 'locations', [
      locationRow('CYC_A', { name: '环一', kind: 'building', status: 'merged', merged_into_id: 'CYC_B' }),
      locationRow('CYC_B', { name: '环二', kind: 'building', status: 'merged', merged_into_id: 'CYC_A' }),
    ]);
    insertEntities(db, 'locations', chainIds.map((id, index) => locationRow(id, {
      name: `链 ${index}`, kind: 'building',
      status: index === chainIds.length - 1 ? 'active' : 'merged',
      merged_into_id: index === chainIds.length - 1 ? null : chainIds[index + 1],
    })));
  }));
  try {
    await assert.rejects(() => handleSqlChatRequest(session, 'merged-id-resolve', { id: 'CYC_A' }),
      (error) => error.code === 'HISTORY_MERGE_CYCLE');
    await assert.rejects(() => handleSqlChatRequest(session, 'merged-id-resolve', { id: 'CH_00' }),
      (error) => error.code === 'HISTORY_MERGE_DEPTH_EXCEEDED');
    // 表名白名单：不许拿未校验的表名拼 SQL。
    await assert.rejects(() => handleSqlChatRequest(session, 'merged-id-resolve', { id: 'D1', table: 'turns' }),
      (error) => error.code === 'HISTORY_MERGE_UNKNOWN_TABLE');
  } finally { await session.close?.(); }
});

/* ── HIST05 · 全库分页、只读、失效、明确不执行 ── */

test('HIST05 · 全库检索按页读完（超过一页也真的扫到），不是「前 200 行没发现问题」', async () => {
  const total = HISTORY_SCAN_PAGE + 37;
  const { session } = await world((db) => {
    const rows = [];
    for (let i = 0; i < total; i += 1) rows.push(locationRow(`BULK_${String(i).padStart(4, '0')}`, { name: `批量地点 ${i}`, kind: 'room' }));
    insertEntities(db, 'locations', rows);
  });
  try {
    const preview = previewOf(session);
    const seeded = queryBound(session.repo.db, 'SELECT COUNT(*) AS n FROM locations WHERE branch_id = ?', [BRANCH])[0].n;
    assert.ok(seeded > HISTORY_SCAN_PAGE, `夹具必须真的超过一页（实际 ${seeded}）`);
    assert.equal(preview.counts.locations, Number(seeded), '报告的扫描行数必须等于库里真实行数');
    assert.ok(preview.scanned.locations >= 2, `必须至少翻了 2 页，实际 ${preview.scanned.locations}`);
    assert.ok(preview.scanned.pages >= 2);
  } finally { await session.close?.(); }
});

test('HIST05 · 预览是纯读：反复预览不改存档，也不新增 journal', async () => {
  const { session } = await world((db) => {
    insertEntities(db, 'locations', [
      locationRow('P1', { name: '青石镇', kind: 'building' }),
      locationRow('D1', { name: '青石附楼', parent_location_id: 'P1', kind: 'building' }),
      locationRow('D2', { name: '青石附楼', parent_location_id: 'P1', kind: 'building' }),
    ]);
  });
  try {
    const before = await snapshotOf(session);
    const changes = Number(queryBound(session.repo.db, 'SELECT COUNT(*) AS n FROM turn_changes')[0].n);
    const first = previewOf(session);
    const second = previewOf(session);
    assert.equal(first.previewHash, second.previewHash, '同一状态下的预览必须可重复');
    assert.equal(await snapshotOf(session), before, '存档字节必须一间不变');
    assert.equal(Number(queryBound(session.repo.db, 'SELECT COUNT(*) AS n FROM turn_changes')[0].n), changes);
  } finally { await session.close?.(); }
});

test('HIST05 · 预览失效与无选择的应用都要明确报错，不许静默', async () => {
  const { session } = await world();
  try {
    const preview = previewOf(session);
    assertHistoryPreviewFresh(preview, { branchId: BRANCH, revision: preview.baseRevision, headTurnId: preview.baseHeadTurnId });
    for (const wrong of [{ branchId: 'other-branch', revision: preview.baseRevision, headTurnId: preview.baseHeadTurnId },
      { branchId: BRANCH, revision: preview.baseRevision + 1, headTurnId: preview.baseHeadTurnId },
      { branchId: BRANCH, revision: preview.baseRevision, headTurnId: 'some-other-turn' }]) {
      assert.throws(() => assertHistoryPreviewFresh(preview, wrong), (error) => error.code === 'HISTORY_PREVIEW_STALE');
    }
    assert.throws(() => applyHistoryRepair(), (error) => error.code === 'HISTORY_SELECTION_INVALID');
  } finally { await session.close?.(); }
});

test('HIST05 · 真实命令链：/sql/chat/history-repair-preview 只读、coreSaved=false、旧指纹作废', async () => {
  const { session } = await world((db) => {
    insertEntities(db, 'locations', [
      locationRow('P1', { name: '青石镇', kind: 'building' }),
      locationRow('D1', { name: '青石附楼', parent_location_id: 'P1', kind: 'building' }),
      locationRow('D2', { name: '青石附楼', parent_location_id: 'P1', kind: 'building' }),
    ]);
  });
  try {
    const before = await snapshotOf(session);
    const ok = await handleSqlChatRequest(session, 'history-repair-preview', {});
    assert.ok(ok.preview, '真实命令必须返回预览');
    assert.equal(ok.coreSaved, false, '预览不是保存结果');
    assert.equal(ok.preview.branchId, session.branchId);
    assert.equal(ok.preview.baseRevision, session.repo.internal.currentRevision());
    assert.ok(ok.preview.actions.some((action) => action.kind === 'merge-location' && action.retiredIds.length === 1));
    assert.equal(await snapshotOf(session), before, '命令不得改动存档');
    // 旧指纹（作者看过的那份）对不上 → 作废，不拿旧方案强写新库。
    await assert.rejects(() => handleSqlChatRequest(session, 'history-repair-preview', { expectedPreviewHash: 'deadbeef' }),
      (error) => error.code === 'HISTORY_PREVIEW_STALE');
    const again = await handleSqlChatRequest(session, 'history-repair-preview', { expectedPreviewHash: ok.preview.previewHash });
    assert.equal(again.preview.previewHash, ok.preview.previewHash, '指纹一致时照常返回');
    assert.equal(await snapshotOf(session), before);
  } finally { await session.close?.(); }
});
