/**
 * atlas-space-canonical.test.mjs — P12/R03 §19：父子共享尺寸与陈设（SPACE01–SPACE07）。
 *
 * 纪律：走**真实链路** —— installSchema / 真实候选事务 / applyPendingSpatialRequests /
 * buildLayoutContext / generateFloor / buildSceneMutation / sceneLocationGeometry /
 * filterSceneForView / publicSpaceCanonical / forkBranch / buildSqlLayoutTask。
 * 不 mock 几何、不自己造 context、不断言常量存在。
 *
 * 覆盖：
 *   SPACE01 父图房间 7.5×8 m → 子图生成后**物理**宽高匹配（extent 与 frame 双证据）。
 *   SPACE02 canonical 不变时再次进入子图：不再第二次估计尺寸、不出现第二套家具。
 *   SPACE03 同一书桌 localId 可核对；真实 itemId 与布局 localId 不混淆。
 *   SPACE04 父子确认尺寸矛盾：双方原事实保留 + SPACE_SIZE_CONFLICT；作者锁不被覆盖。
 *   SPACE05 修订尺寸失败不发布半边变化；回退恢复 size/revision/家具与场景。
 *   SPACE06 7.5:8、24:2 能适配未锁 frame；锁定/确认幅面不符 → 诊断且不动锁。
 *   SPACE07 fork 复制 canonical 且分支独立；POV 不下发尺寸依据与隐藏家具。
 *
 * 边界：不调用外网；数据只存在于内存。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as Kit from '../vendor/atlas-spatial/index.mjs';
import { makeSeedWith, IDS, insertRows, selectOne, foreignKeyCheck } from './fixtures/atlas-sql/seed.mjs';
import { applyGroups } from '../src/atlas-db-commit.ts';
import { queryBound } from '../src/atlas-db-runtime.ts';
import { decodeRow } from '../src/atlas-db-codec.ts';
import { applyPendingSpatialRequests } from '../src/atlas-spatial-candidate.ts';
import {
  FRAME_FIT_MAX_CELLS,
  alignSqlFrameToPhysicalSize,
  fitFrameToPhysicalSize,
  normalizeSqlMapFrame,
} from '../src/atlas-spatial-frame.ts';
import {
  SPACE_CANONICAL_FRAME_KEY,
  SPACE_CANONICAL_MAX_FURNISHING,
  isSpaceLocalId,
  locationSpaceSize,
  parseSpaceLocalId,
  readSpaceCanonical,
  resolveMapSpaceSize,
  resolveSpaceSize,
  spaceCanonicalHolder,
  spaceLocalId,
} from '../src/atlas-space-canonical.ts';
import { buildSqlLayoutTask } from '../src/atlas-sql-layout-task.ts';
import { forkBranch } from '../src/atlas-db-branches.ts';
import { CAPABILITY_SPACE_CANONICAL, SPATIAL_CAPABILITIES, hasSpatialCapability } from '../src/atlas-world-contract.ts';

const SQL = await (await import('sql.js')).default();
const BRANCH = IDS.branchMain;
const SCOPE = { chatId: IDS.chatA, branchId: BRANCH, revision: 5, viewMode: 'author' };
const TURN = 'turn_space';

const SITE = 'L_SITE';
const BLD = 'L_BLD';
const ROOM = 'L_ROOM';
const HALL = 'L_HALL';
const MAP_BLD = 'M_BLD';
const MAP_ROOM = 'M_ROOM';
const ITEM_DESK = 'I_DESK';
const ROOM_W = 7.5;
const ROOM_H = 8;
const EPS = 1e-9;

// ───────────────────────────── 夹具 ─────────────────────────────

function loc(id, over = {}) {
  return {
    branch_id: BRANCH, id, name: id, aliases_json: '[]', kind: 'room', description: '',
    parent_location_id: BLD, mobility: 'fixed', anchor_location_id: null, map_id: null,
    grid_x: null, grid_y: null, coord_precision: 'unknown', uncertainty_radius_cells: null,
    area_geometry_json: null, terrain: 'unknown', access_rules_json: null, vehicle_profile_json: null,
    existence_quality: 'confirmed', status: 'active', merged_into_id: null, row_rev: 1,
    created_turn_id: IDS.seedTurn, updated_turn_id: IDS.seedTurn, ...over,
  };
}

function itemRow(id, name, locationId) {
  return {
    branch_id: BRANCH, id, name, aliases_json: '[]', kind: 'object', description: '',
    quantity: 1, unit: '个', condition_note: '', owner_entity_id: null,
    holder_character_id: null, container_item_id: null, location_id: locationId,
    map_id: locationId ? MAP_ROOM : null, grid_x: null, grid_y: null, coord_precision: 'unknown',
    uncertainty_radius_cells: null, properties_json: '[]', status: 'active', merged_into_id: null,
    row_rev: 1, created_turn_id: IDS.seedTurn, updated_turn_id: IDS.seedTurn,
  };
}

function mapRow(id, over = {}) {
  return {
    branch_id: BRANCH, id, name: `${id} 图`, kind: 'interior', container_location_id: null,
    description: '',
    frame_json: { origin_x: 0, origin_y: 0, cols: 100, rows: 80 },
    meters_per_cell: null, scale_min_meters_per_cell: null, scale_max_meters_per_cell: null,
    scale_quality: 'uncalibrated', scale_basis_json: '{}', scale_locked: 0, calibration_rev: 1,
    background_asset_key: null, default_terrain: 'unknown', status: 'active', row_rev: 1,
    created_turn_id: IDS.seedTurn, updated_turn_id: IDS.seedTurn, ...over,
  };
}

function pendingRequest(requestId, spec, kind = 'floor') {
  return { requestId, operationId: `op_${requestId}`, kind, spec, status: 'pending', createdTurnId: 'turn_prev' };
}

function insertTurn(db, id) {
  db.run(
    `INSERT INTO turns (id, branch_id, parent_turn_id, host_message_uid, host_variant_key, kind, input_hash, story_hash, base_revision, committed_revision, clock_before_s, elapsed_json, clock_after_s, rng_seed, ruleset_version, decisions_json, receipt_json, attempts_json, status, created_wall_ms, prepared_wall_ms)
     VALUES (?, ?, NULL, NULL, NULL, 'manual', ?, NULL, 0, 0, 0, ?, 0, ?, 'atlas-1', ?, NULL, ?, 'pending', ?, ?)`,
    [id, BRANCH, `hash_${id}`, JSON.stringify({ min_s: 0, nominal_s: 0, max_s: 0, quality: 'explicit', basis_refs: [] }), `rng_${id}`, JSON.stringify({ operations: [], attention_decisions: [], outcome_decisions: [], random_draws: [] }), JSON.stringify([]), 1_700_000_000_000, 1_700_000_000_000],
  );
}

function makePorts() {
  return {
    applyGroups: (db, groups, ctx) => applyGroups(db, groups, ctx),
    queryBound,
    decodeRow,
    isCurrent: () => true,
    branchId: BRANCH,
    turnId: TURN,
    attemptId: 'attempt_space',
  };
}

/** 真实路径构造「父图已保存场景」：父图房间里就有 L_ROOM 的 7.5×8 轮廓。 */
function parentFrameWithRoomFootprint() {
  const parentMap = mapRow(MAP_BLD, {
    container_location_id: BLD, frame_json: { cols: 40, rows: 40 },
    meters_per_cell: 1, scale_quality: 'confirmed',
  });
  const locations = [
    loc(SITE, { kind: 'region', parent_location_id: null }),
    loc(BLD, { kind: 'building', parent_location_id: SITE }),
    loc(ROOM, { parent_location_id: BLD, map_id: MAP_BLD, name: '书房' }),
    loc(HALL, { parent_location_id: BLD, map_id: MAP_BLD, name: '前厅' }),
  ];
  const built = Kit.buildLayoutContext({ scope: SCOPE, mapRow: parentMap, locations, characters: [], items: [], routes: [] });
  assert.equal(built.ok, true, JSON.stringify(built.issues));
  const generated = Kit.generateFloor({
    corridorWidth: 2,
    rooms: [
      { id: ROOM, name: '书房', side: 'north', w: ROOM_W, h: ROOM_H },
      { id: HALL, name: '前厅', side: 'south', w: 4, h: 3 },
    ],
  }, built.context);
  assert.equal(generated.ok, true, JSON.stringify(generated.issues));
  const saved = Kit.buildSceneMutation({
    result: generated, mapRow: parentMap, scope: SCOPE, currentScope: SCOPE,
    turnId: TURN, operationId: 'op_parent_scene', expectedRowRev: 1,
  });
  assert.equal(saved.ok, true, JSON.stringify(saved.issues));
  const frame = saved.mutation.after.frame_json;
  const room = frame.atlasScene.layout.rooms.find((r) => r.id === ROOM);
  assert.equal(room.w, ROOM_W);
  assert.equal(room.h, ROOM_H);
  return frame;
}

/** 一个「书房子图」DB：父图带 7.5×8 足迹，子图未标定、带一条待处理布局请求。 */
async function roomSeed(spec, over = {}) {
  const seed = await makeSeedWith(SQL);
  insertTurn(seed.db, TURN);
  const parentFrame = parentFrameWithRoomFootprint();
  const childSpec = spec ?? {
    rooms: [{ id: ROOM, name: '书房', side: 'north', w: ROOM_W, h: ROOM_H }],
    contents: [{ id: 'desk-1', name: '书桌', type: 'desk', roomId: ROOM, w: 2, h: 1 }],
    items: [{ id: ITEM_DESK, on: 'desk-1' }],
  };
  insertRows(seed.db, 'entity_keys', [
    { branch_id: BRANCH, id: SITE, kind: 'location' },
    { branch_id: BRANCH, id: BLD, kind: 'location' },
    { branch_id: BRANCH, id: ROOM, kind: 'location' },
    { branch_id: BRANCH, id: HALL, kind: 'location' },
    { branch_id: BRANCH, id: ITEM_DESK, kind: 'item' },
  ]);
  // 顺序受外键约束：地点先落（map_id 暂空）→ 地图 → 回填地点的 map_id → 物品。
  insertRows(seed.db, 'locations', [
    loc(SITE, { kind: 'region', parent_location_id: null }),
    loc(BLD, { kind: 'building', parent_location_id: SITE }),
    loc(ROOM, { parent_location_id: BLD, name: '书房' }),
    loc(HALL, { parent_location_id: BLD, name: '前厅' }),
  ]);
  insertRows(seed.db, 'maps', [
    mapRow(MAP_BLD, { container_location_id: BLD, frame_json: parentFrame, meters_per_cell: 1, scale_quality: 'confirmed' }),
    mapRow(MAP_ROOM, {
      container_location_id: ROOM,
      frame_json: { origin_x: 0, origin_y: 0, cols: 100, rows: 80, atlasLayoutRequest: pendingRequest('req_room_1', childSpec) },
      ...(over.child ?? {}),
    }),
  ]);
  seed.db.run('UPDATE locations SET map_id = ? WHERE id IN (?, ?)', [MAP_BLD, ROOM, HALL]);
  insertRows(seed.db, 'items', [itemRow(ITEM_DESK, '黄铜台灯', ROOM)]);
  return seed;
}

function readRow(db, mapId) {
  return selectOne(db, 'maps', BRANCH, mapId);
}

/** frame_json 只是 frame；`meters_per_cell` 是 maps 的**列**，不在 frame 里（别混）。 */
function frameOf(row) {
  return typeof row.frame_json === 'string' ? JSON.parse(row.frame_json) : row.frame_json;
}

function readFrame(db, mapId) {
  return frameOf(readRow(db, mapId));
}

function writeFrame(db, mapId, frame) {
  db.run('UPDATE maps SET frame_json = ?, row_rev = row_rev + 1 WHERE id = ?', [JSON.stringify(frame), mapId]);
}

/** 在已落库的 frame 上挂一条新的待处理请求（模拟下一轮布局请求）。 */
function armRequest(db, mapId, request) {
  const frame = readFrame(db, mapId);
  frame.atlasLayoutRequest = request;
  writeFrame(db, mapId, frame);
}

const canonicalOf = (frame, locationId) => readSpaceCanonical(frame, locationId).canonical;

/** 从真实布局任务的提示里取出所有 floor scope（每张图一行「本图：…」）。 */
function floorScopesOf(task) {
  const scopes = [];
  for (const line of String(task.request.messages[1].content).split('\n')) {
    if (!line.startsWith('本图：')) continue;
    const parsed = JSON.parse(line.slice('本图：'.length));
    for (const item of parsed) if (item?.kind === 'floor') scopes.push(item);
  }
  return scopes;
}

// ───────────────────────── SPACE01 · 父子物理尺寸一致 ─────────────────────────

test('SPACE01：父图房间 7.5×8 m → 生成子图后物理宽高匹配（extent 与 frame 双证据）', async () => {
  const seed = await roomSeed();
  const db = seed.db;
  db.run('BEGIN');
  try {
    // 1) 程序先把父图足迹当作子空间的尺寸依据。
    const before = readFrame(db, MAP_ROOM);
    const resolved = resolveMapSpaceSize({
      maps: [selectOne(db, 'maps', BRANCH, MAP_BLD), { ...selectOne(db, 'maps', BRANCH, MAP_ROOM), frame_json: before }],
      locations: ['L_SITE', BLD, ROOM, HALL].map((id) => selectOne(db, 'locations', BRANCH, id)),
      mapRow: { ...selectOne(db, 'maps', BRANCH, MAP_ROOM), frame_json: before },
      branchId: BRANCH,
    });
    assert.ok(resolved, '子图有可追踪的父图足迹，必须解析出尺寸');
    assert.equal(resolved.resolution.source, 'parent-footprint');
    assert.equal(resolved.resolution.widthM, ROOM_W);
    assert.equal(resolved.resolution.heightM, ROOM_H);
    assert.equal(resolved.resolution.basis.referenceId, MAP_BLD);

    // 2) 真实候选处理：未标定子图必须先按 7.5×8 调整幅面，再生成。
    const out = applyPendingSpatialRequests({ db, scope: SCOPE, turnId: TURN, ports: makePorts() });
    assert.deepEqual(out.issues.filter((i) => i.severity === 'error'), [], JSON.stringify(out.issues));
    assert.deepEqual(out.processed, ['req_room_1'], JSON.stringify(out.issues));

    const roomRowAfter = readRow(db, MAP_ROOM);
    const frame = frameOf(roomRowAfter);
    const normalized = normalizeSqlMapFrame(frame);
    assert.equal(normalized.ok, true, JSON.stringify(normalized.issues));
    assert.ok(Number.isFinite(roomRowAfter.meters_per_cell) && roomRowAfter.meters_per_cell > 0, `幅面调整必须同时写入比例尺：${roomRowAfter.meters_per_cell}`);
    const physicalW = normalized.cols * roomRowAfter.meters_per_cell;
    const physicalH = normalized.rows * roomRowAfter.meters_per_cell;
    assert.ok(Math.abs(physicalW - ROOM_W) / ROOM_W <= 0.005, `子图物理宽 ${physicalW} 与 ${ROOM_W} 不符`);
    assert.ok(Math.abs(physicalH - ROOM_H) / ROOM_H <= 0.005, `子图物理高 ${physicalH} 与 ${ROOM_H} 不符`);
    assert.ok(Number.isInteger(normalized.cols) && Number.isInteger(normalized.rows), '幅面必须是整数格');
    assert.ok(normalized.cols <= FRAME_FIT_MAX_CELLS && normalized.rows <= FRAME_FIT_MAX_CELLS);

    // 3) 场景本身也必须是 7.5×8（不是只把标签改了）。
    const scene = frame.atlasScene;
    assert.ok(scene, JSON.stringify(out.issues));
    assert.ok(Math.abs(scene.layout.bounds.w - ROOM_W) < EPS, `场景宽 ${scene.layout.bounds.w}`);
    assert.ok(Math.abs(scene.layout.bounds.h - ROOM_H) < EPS, `场景高 ${scene.layout.bounds.h}`);
    assert.equal(scene.units, 'meters');

    // 4) 空间权威与场景在同一条 maps 变更里落盘，尺寸就是父图足迹。
    const canonical = canonicalOf(frame, ROOM);
    assert.ok(canonical, '子图 frame 必须持有本空间的权威记录');
    assert.equal(canonical.locationId, ROOM);
    assert.equal(canonical.size.widthM, ROOM_W);
    assert.equal(canonical.size.heightM, ROOM_H);
    assert.equal(canonical.revision, 1);
    // 5) 几何回写仍是格坐标，且与幅面一致（同一物理尺寸两种表达）。
    const mapped = Kit.sceneLocationGeometry(scene);
    assert.equal(mapped.length, 1);
    assert.equal(mapped[0].entityId, ROOM);
  } finally {
    db.run('ROLLBACK');
    seed.close();
  }
});

// ───────────────────────── SPACE02 · 复进不二次估计/不第二套家具 ─────────────────────────

test('无成功场景的失败请求也向下次规划提供稳定陈设约束及错误',async()=>{
 const seed=await roomSeed(),db=seed.db;
 try{
  const frame=readFrame(db,MAP_ROOM);
  frame.atlasLayoutRequest.status='failed';
  frame.atlasLayoutRequest.issues=[{code:'DETAIL_NO_SPACE',message:'desk-1 未放下',severity:'error'}];
  writeFrame(db,MAP_ROOM,frame);
  const task=buildSqlLayoutTask(db,BRANCH,{anchor:{chatUid:IDS.chatA,branchId:BRANCH,baseRevision:0,baseStorageRevision:0},userText:'',assistantText:'',sourceSnapshot:[],layoutMaps:[MAP_ROOM]},'retry-constraints');
  assert.ok(task);
  const [scope]=floorScopesOf(task);
  assert.equal(scope.constraintStatus,'failed');
  assert.ok(scope.savedConstraints.contents.some(c=>c.id==='desk-1'));
  assert.ok(scope.layoutIssues.some(i=>i.code==='DETAIL_NO_SPACE'));
  assert.equal(readFrame(db,MAP_ROOM).atlasScene,undefined,'构造任务不假造成功场景');
 }finally{seed.close();}
});

test('首次计划的矩形幅面在生成前实际标定，不把物理长宽套进旧正方格框',async()=>{
 const seed=await roomSeed(),db=seed.db;db.run('BEGIN');try{
  db.run('UPDATE maps SET frame_json=?,meters_per_cell=NULL,scale_quality=? WHERE id=?',[JSON.stringify({cols:100,rows:100}),'uncalibrated',MAP_BLD]);
  armRequest(db,MAP_BLD,pendingRequest('rect-first',{width:26,height:51,rooms:[{id:ROOM,w:ROOM_W,h:ROOM_H,side:'north'},{id:HALL,w:4,h:3,side:'south'}],contents:[],actors:[],items:[]}));
  const out=applyPendingSpatialRequests({db,scope:SCOPE,turnId:TURN,ports:makePorts(),autoPlan:true,plannedExtents:{[MAP_BLD]:{width:26,height:51,units:'meters'}}});
  assert.deepEqual(out.issues.filter(i=>i.severity==='error'),[],JSON.stringify(out.issues));
  const frame=readFrame(db,MAP_BLD),map=readRow(db,MAP_BLD);
  assert.deepEqual([frame.atlasScene.layout.bounds.w,frame.atlasScene.layout.bounds.h],[26,51]);
  assert.ok(Math.abs(frame.cols*map.meters_per_cell-26)<1e-8);
  assert.ok(Math.abs(frame.rows*map.meters_per_cell-51)<1e-8);
  assert.deepEqual(foreignKeyCheck(db),[]);
 }finally{db.run('ROLLBACK');seed.close();}
});

test('未标定父图中的确认长宽走真实候选提交，父子共享尺寸且原事实保留',async()=>{
  const seed=await roomSeed(),db=seed.db;
  db.run('BEGIN');
  try{
    const dimensions={kind:'dimensions',widthM:12,heightM:8,quality:'confirmed',source:'story'};
    db.run('UPDATE locations SET area_geometry_json = ?, coord_precision = ? WHERE id = ? AND branch_id = ?',[JSON.stringify(dimensions),'layout',ROOM,BRANCH]);
    // 模拟刚登记的父图：尚未得到比例尺，旧默认约束只有 7.5×8。
    db.run('UPDATE maps SET meters_per_cell = NULL, scale_quality = ? WHERE id = ? AND branch_id = ?',['uncalibrated',MAP_BLD,BRANCH]);
    const out=applyPendingSpatialRequests({db,scope:SCOPE,turnId:TURN,ports:makePorts(),autoPlan:true});
    assert.deepEqual(out.issues.filter(i=>i.severity==='error'),[],JSON.stringify(out.issues));
    assert.ok(out.processed.includes('req_room_1'));
    const child=readFrame(db,MAP_ROOM),parent=readFrame(db,MAP_BLD);
    assert.deepEqual([child.atlasScene.layout.bounds.w,child.atlasScene.layout.bounds.h],[12,8]);
    assert.deepEqual([canonicalOf(child,ROOM).size.widthM,canonicalOf(child,ROOM).size.heightM],[12,8]);
    const footprint=parent.atlasScene.layout.rooms.find(r=>r.id===ROOM);
    assert.deepEqual([footprint.w,footprint.h],[12,8]);
    assert.notEqual(footprint.quality,'confirmed','确认长宽不确认父图落位');
    const location=selectOne(db,'locations',BRANCH,ROOM);
    assert.deepEqual(JSON.parse(location.area_geometry_json),dimensions);
    assert.deepEqual(foreignKeyCheck(db),[]);
  }finally{db.run('ROLLBACK');seed.close();}
});

test('父图复用子空间陈设账本与真实物品绑定，不把子空间家具登记到建筑账本',async()=>{
 const seed=await roomSeed(),db=seed.db;db.run('BEGIN');
 try{
  applyPendingSpatialRequests({db,scope:SCOPE,turnId:TURN,ports:makePorts()});
  const childBefore=canonicalOf(readFrame(db,MAP_ROOM),ROOM);
  armRequest(db,MAP_BLD,pendingRequest('parent-furnishing',{rooms:[{id:ROOM,name:'书房',side:'north',w:3,h:3},{id:HALL,name:'前厅',side:'south',w:4,h:3}]}));
  const result=applyPendingSpatialRequests({db,scope:SCOPE,turnId:TURN,ports:makePorts()});
  assert.equal(result.issues.some(i=>i.severity==='error'),false,JSON.stringify(result.issues));
  const parent=readFrame(db,MAP_BLD),room=parent.atlasScene.layout.rooms.find(r=>r.id===ROOM);
  assert.deepEqual([room.w,room.h],[ROOM_W,ROOM_H]);
  const desk=parent.atlasScene.layout.groups.find(g=>g.id===spaceLocalId(ROOM,'desk-1'));
  assert.ok(desk);assert.equal(desk.roomId,ROOM);assert.equal(parent.atlasScene.layout.items.find(i=>i.id===ITEM_DESK).on,desk.id,JSON.stringify(parent.atlasScene.layout.items));
  assert.deepEqual(canonicalOf(parent,BLD).furnishing,[],'建筑账本不把书房的书桌据为己有');
  assert.deepEqual(canonicalOf(readFrame(db,MAP_ROOM),ROOM),childBefore,'未变陈设不跳修订，也不产生第二套');
 }finally{db.run('ROLLBACK');seed.close();}
});

test('自动生成在同一空间组扩展估计房间并同步父图、物品绑定和账本',async()=>{
 const seed=await roomSeed({rooms:[{id:ROOM,name:'书房',side:'north',w:ROOM_W,h:ROOM_H}],contents:[{id:'desk-1',name:'书桌',type:'desk',roomId:ROOM,w:10,h:8}],items:[{id:ITEM_DESK,on:'desk-1'}]});
 const db=seed.db;db.run('BEGIN');try{
  const out=applyPendingSpatialRequests({db,scope:SCOPE,turnId:TURN,ports:makePorts(),autoPlan:true});
  assert.equal(out.issues.some(i=>i.severity==='error'),false,JSON.stringify(out.issues));
  assert.deepEqual(out.processed,['req_room_1']);
  const child=readFrame(db,MAP_ROOM),parent=readFrame(db,MAP_BLD),size=canonicalOf(child,ROOM).size;
  assert.ok(size.widthM>ROOM_W);
  const outline=parent.atlasScene.layout.rooms.find(r=>r.id===ROOM);
  assert.deepEqual([outline.w,outline.h],[size.widthM,size.heightM]);
  assert.deepEqual([child.atlasScene.layout.bounds.w,child.atlasScene.layout.bounds.h],[size.widthM,size.heightM]);
  assert.equal(child.atlasScene.layout.groups.length,1);
  assert.equal(child.atlasScene.layout.groups[0].w*child.atlasScene.layout.groups[0].h,80);
  assert.equal(child.atlasScene.layout.items[0].on,'desk-1');
  const group=out.groups.find(g=>g.changedRows>2);assert.ok(group,'关联图必须同组提交');
 }finally{db.run('ROLLBACK');seed.close();}
});

test('自动规划遇到锁定父图容量冲突时保留原父子场景与账本',async()=>{
 const seed=await roomSeed();const db=seed.db;db.run('BEGIN');try{
  applyPendingSpatialRequests({db,scope:SCOPE,turnId:TURN,ports:makePorts()});
  const childBefore=readFrame(db,MAP_ROOM),parentBefore=readFrame(db,MAP_BLD);
  db.run('UPDATE maps SET frame_json=?,scale_locked=1 WHERE id=?',[JSON.stringify({...parentBefore,cols:9,rows:12}),MAP_BLD]);
  const lockedParent=readFrame(db,MAP_BLD);
  armRequest(db,MAP_ROOM,pendingRequest('large-locked',{rooms:[{id:ROOM,w:ROOM_W,h:ROOM_H,side:'north'}],contents:[{id:'desk-1',roomId:ROOM,type:'desk',w:10,h:8}]}));
  const out=applyPendingSpatialRequests({db,scope:SCOPE,turnId:TURN,ports:makePorts(),autoPlan:true});
  assert.equal(out.processed.length,0,JSON.stringify({out,child:readFrame(db,MAP_ROOM).atlasSpaceCanonical,parent:readFrame(db,MAP_BLD).atlasSpaceCanonical}));assert.ok(out.issues.some(i=>i.severity==='error'));
  const child=readFrame(db,MAP_ROOM),parent=readFrame(db,MAP_BLD);
  assert.deepEqual(child.atlasScene,childBefore.atlasScene);assert.deepEqual(child.atlasSpaceCanonical,childBefore.atlasSpaceCanonical);
  assert.deepEqual(parent,lockedParent);
 }finally{db.run('ROLLBACK');seed.close();}
});

test('父子同轮生成只建一份共享陈设，后排的旧请求不重建第二套',async()=>{
 const seed=await roomSeed(),db=seed.db;db.run('BEGIN');try{
  armRequest(db,MAP_BLD,pendingRequest('a-parent',{rooms:[{id:ROOM,w:ROOM_W,h:ROOM_H,side:'north'},{id:HALL,w:4,h:3,side:'south'}],contents:[{id:'shared-desk',roomId:ROOM,type:'desk',name:'书桌',w:2,h:1}],items:[{id:ITEM_DESK,on:'shared-desk'}]}));
  const out=applyPendingSpatialRequests({db,scope:SCOPE,turnId:TURN,ports:makePorts(),autoPlan:true});
  assert.equal(out.issues.some(i=>i.severity==='error'),false,JSON.stringify(out.issues));
  const child=readFrame(db,MAP_ROOM),parent=readFrame(db,MAP_BLD);
  assert.equal(child.atlasScene.layout.groups.length,1);assert.equal(child.atlasScene.layout.groups[0].id,'shared-desk');
  assert.equal(parent.atlasScene.layout.groups.length,1);assert.equal(parent.atlasScene.layout.groups[0].id,spaceLocalId(ROOM,'shared-desk'));
  assert.equal(child.atlasScene.layout.items[0].on,'shared-desk');
  assert.ok(out.completedMapIds.includes(MAP_ROOM));assert.deepEqual(new Set(out.processed),new Set(['a-parent','req_room_1']));
 }finally{db.run('ROLLBACK');seed.close();}
});

test('SPACE02：canonical 不变时再次进入子图不产生第二次尺寸估计、不出现第二套家具', async () => {
  const seed = await roomSeed();
  const db = seed.db;
  db.run('BEGIN');
  try {
    const out1 = applyPendingSpatialRequests({ db, scope: SCOPE, turnId: TURN, ports: makePorts() });
    assert.deepEqual(out1.processed, ['req_room_1'], JSON.stringify(out1.issues));
    const frame1 = readFrame(db, MAP_ROOM);
    const canonical1 = canonicalOf(frame1, ROOM);
    assert.equal(canonical1.revision, 1);
    assert.deepEqual(canonical1.furnishing.map((f) => f.localId), [spaceLocalId(ROOM, 'desk-1')]);
    assert.equal(canonical1.furnishing[0].itemId, ITEM_DESK);

    // 第二次请求与第一次逐字段相同：结构未变 → 复用，权威一个数字都不跳。
    armRequest(db, MAP_ROOM, pendingRequest('req_room_2', {
      rooms: [{ id: ROOM, name: '书房', side: 'north', w: ROOM_W, h: ROOM_H }],
      contents: [{ id: 'desk-1', name: '书桌', type: 'desk', roomId: ROOM, w: 2, h: 1 }],
      items: [{ id: ITEM_DESK, on: 'desk-1' }],
    }));
    const out2 = applyPendingSpatialRequests({ db, scope: SCOPE, turnId: TURN, ports: makePorts() });
    assert.deepEqual(out2.issues.filter((i) => i.severity === 'error'), [], JSON.stringify(out2.issues));
    const frame2 = readFrame(db, MAP_ROOM);
    const canonical2 = canonicalOf(frame2, ROOM);
    assert.equal(canonical2.revision, canonical1.revision, '场景没变 → 权威 revision 不该跳');
    assert.deepEqual(canonical2.size, canonical1.size, '不得出现第二次尺寸估计');
    assert.deepEqual(canonical2.furnishing, canonical1.furnishing, '不得出现第二套家具');
    assert.deepEqual(frame2.atlasScene.layout.bounds, frame1.atlasScene.layout.bounds);
    assert.deepEqual(frame2.atlasScene.layout.groups.map((g) => g.id), ['desk-1']);
    assert.deepEqual(frame2.atlasScene.layout.items.map((i) => [i.id, i.on]), [[ITEM_DESK, 'desk-1']]);

    // 第三次请求**不含 contents/items**：既有账本必须顶上来（身份、尺寸、支撑关系一起沿用），
    // 而不是重建一套新家具、也不是把物品掉到地上。
    armRequest(db, MAP_ROOM, pendingRequest('req_room_3', { rooms: [{ id: ROOM, name: '书房', side: 'north', w: ROOM_W, h: ROOM_H }] }));
    const out3 = applyPendingSpatialRequests({ db, scope: SCOPE, turnId: TURN, ports: makePorts() });
    assert.deepEqual(out3.issues.filter((i) => i.severity === 'error'), [], JSON.stringify(out3.issues));
    const canonical3 = canonicalOf(readFrame(db, MAP_ROOM), ROOM);
    assert.deepEqual(canonical3, canonical1, '账本应原样顶上来：尺寸、revision、家具与 itemId 都不变');
    const scene3 = readFrame(db, MAP_ROOM).atlasScene;
    assert.deepEqual(scene3.layout.groups.map((g) => g.id), ['desk-1']);
    assert.deepEqual(scene3.layout.items.map((i) => [i.id, i.on]), [[ITEM_DESK, 'desk-1']], '物品仍摆在原陈设上，不掉到地上');
    assert.deepEqual(scene3.layout.bounds, frame1.atlasScene.layout.bounds);
  } finally {
    db.run('ROLLBACK');
    seed.close();
  }
});

// ───────────────────────── SPACE03 · 陈设身份 ─────────────────────────

test('SPACE03：同一书桌 localId 可核对；真实 itemId 与布局 localId 不混淆', async () => {
  const seed = await roomSeed();
  const db = seed.db;
  db.run('BEGIN');
  try {
    applyPendingSpatialRequests({ db, scope: SCOPE, turnId: TURN, ports: makePorts() });
    const frame = readFrame(db, MAP_ROOM);
    const canonical = canonicalOf(frame, ROOM);
    const desk = canonical.furnishing.find((f) => f.localId === spaceLocalId(ROOM, 'desk-1'));
    assert.ok(desk, JSON.stringify(canonical.furnishing));

    // 1) 布局 localId 是「空间 + 局部 ID」，不是 SQL entityId；真实 item 引用单独一个字段。
    assert.equal(desk.localId, 'space:L_ROOM:furn:desk-1');
    assert.equal(desk.itemId, ITEM_DESK);
    assert.deepEqual(parseSpaceLocalId(desk.localId), { locationId: ROOM, contentId: 'desk-1' });
    assert.equal(isSpaceLocalId(ITEM_DESK), false, '真实 item ID 绝不能被当成布局 localId');
    assert.equal(parseSpaceLocalId(ITEM_DESK), null);
    assert.equal(desk.type, 'desk');
    assert.equal(desk.widthM, 2);
    assert.equal(desk.heightM, 1);

    // 2) 场景里的陈设仍是短局部 ID：父摘要（canonical）与子详情（scene）能对上同一个条目。
    const groups = frame.atlasScene.layout.groups;
    assert.deepEqual(groups.map((g) => g.id), ['desk-1']);
    assert.ok(canonical.furnishing.some((f) => f.localId === spaceLocalId(ROOM, groups[0].id)));

    // 3) itemId 只认已登记 item：把 item 行停用后按真实链路再生成一次，itemId 必须落成 null（不虚构）。
    db.run("UPDATE items SET status='archived' WHERE id=?", [ITEM_DESK]);
    armRequest(db, MAP_ROOM, pendingRequest('req_room_retired', { rooms: [{ id: ROOM, name: '书房', side: 'north', w: ROOM_W, h: ROOM_H }] }));
    const outRetired = applyPendingSpatialRequests({ db, scope: SCOPE, turnId: TURN, ports: makePorts() });
    assert.deepEqual(outRetired.processed, ['req_room_retired'], JSON.stringify(outRetired.issues));
    const retiredFrame = readFrame(db, MAP_ROOM);
    const later = canonicalOf(retiredFrame, ROOM);
    assert.equal(later.furnishing[0].localId, desk.localId, '陈设身份不变');
    assert.equal(later.furnishing[0].itemId, null, '不在登记表里的 item 不能出现在账本上');
    assert.deepEqual(retiredFrame.atlasScene.layout.items, [], '停用的物品不得再落到场景里');

    // 4) 不同房间的同名书桌是不同 localId。
    assert.notEqual(spaceLocalId(ROOM, 'desk-1'), spaceLocalId(HALL, 'desk-1'));
  } finally {
    db.run('ROLLBACK');
    seed.close();
  }
});

// ───────────────────────── SPACE04 · 确认尺寸矛盾 ─────────────────────────

test('SPACE04：父子确认尺寸矛盾保留双方原事实并给冲突；作者锁不被生成器覆盖', async () => {
  const canonical = {
    version: 1, locationId: ROOM, revision: 4,
    size: {
      widthM: 6, heightM: 6, quality: 'confirmed', locked: true,
      basis: { kind: 'source', referenceId: 'doc:旧平面图', note: '来源图纸上标注 6×6' },
    },
    furnishing: [],
  };
  // 1) 解析：作者轮廓 7.5×8 与权威 6×6 都是确认事实 → 冲突 + 列出两个来源。
  const resolution = resolveSpaceSize({
    locationId: ROOM,
    author: { widthM: ROOM_W, heightM: ROOM_H, referenceId: ROOM, note: '作者确认的轴对齐轮廓' },
    canonical,
    firstEstimate: { widthM: 24, heightM: 24 },
  });
  assert.equal(resolution.conflict, true);
  assert.equal(resolution.source, 'author');
  assert.equal(resolution.widthM, ROOM_W);
  const conflict = resolution.issues.find((i) => i.code === 'SPACE_SIZE_CONFLICT');
  assert.ok(conflict, '必须给 SPACE_SIZE_CONFLICT');
  assert.match(conflict.message, /7\.5×8/);
  assert.match(conflict.message, /6×6/);
  assert.match(conflict.message, /doc:旧平面图/);
  assert.deepEqual(resolution.sources.map((s) => s.source), ['author', 'canonical', 'first-estimate']);

  // 2) 真实链路：地点上有作者确认轮廓 7.5×8 + 账本里是确认过的 6×6 → 生成器**不得改写**权威记录。
  const seed = await roomSeed();
  const db = seed.db;
  db.run('BEGIN');
  try {
    const seeded = readFrame(db, MAP_ROOM);
    writeFrame(db, MAP_ROOM, { ...seeded, [SPACE_CANONICAL_FRAME_KEY]: canonical });
    db.run('UPDATE locations SET area_geometry_json = ? WHERE id = ?', [
      JSON.stringify({ kind: 'polygon', quality: 'confirmed', points: [{ x: 0, y: 0 }, { x: ROOM_W, y: 0 }, { x: ROOM_W, y: ROOM_H }, { x: 0, y: ROOM_H }] }),
      ROOM,
    ]);
    const out = applyPendingSpatialRequests({ db, scope: SCOPE, turnId: TURN, ports: makePorts() });
    assert.deepEqual(out.processed, ['req_room_1'], JSON.stringify(out.issues));
    assert.ok(out.issues.some((i) => i.code === 'SPACE_SIZE_CONFLICT'), JSON.stringify(out.issues));

    const afterFrame = readFrame(db, MAP_ROOM);
    const afterCanonical = canonicalOf(afterFrame, ROOM);
    assert.equal(afterCanonical.size.widthM, 6, '权威记录不被生成器覆盖');
    assert.equal(afterCanonical.size.heightM, 6);
    assert.equal(afterCanonical.size.locked, true, '尺寸锁不得被清掉');
    assert.equal(afterCanonical.size.quality, 'confirmed');
    assert.equal(afterCanonical.size.basis.referenceId, 'doc:旧平面图', '依据事实也保留原样');
    assert.deepEqual(afterCanonical.size, canonical.size, '冲突不改变尺寸事实：宽高 / 质量 / 锁 / 依据全保留');
    assert.ok(afterCanonical.revision >= canonical.revision, 'revision 只前进不回退');
    assert.equal(afterCanonical.furnishing[0].localId, spaceLocalId(ROOM, 'desk-1'), '陈设账本照常推进（这是 revision 前进的唯一原因）');
    // 作者事实也没丢：地点上的确认轮廓原样保留。
    const locationRow = selectOne(db, 'locations', BRANCH, ROOM);
    const area = typeof locationRow.area_geometry_json === 'string' ? JSON.parse(locationRow.area_geometry_json) : locationRow.area_geometry_json;
    assert.equal(area.quality, 'confirmed');
    assert.equal(Math.max(...area.points.map((p) => p.x)) - Math.min(...area.points.map((p) => p.x)), ROOM_W, '作者轮廓仍是 7.5 宽（没被抹掉）');
  } finally {
    db.run('ROLLBACK');
    seed.close();
  }

  // 3) 只有一方确认时不冲突：canonical 只是估计 → 采用确认事实。
  const soft = resolveSpaceSize({
    locationId: ROOM,
    author: { widthM: ROOM_W, heightM: ROOM_H, referenceId: ROOM, note: '' },
    canonical: { ...canonical, size: { ...canonical.size, quality: 'estimated', locked: false } },
  });
  assert.equal(soft.conflict, false);
});

// ───────────────────────── SPACE05 · 失败不发布半边 + 回退 ─────────────────────────

test('SPACE05：修订尺寸失败不发布半边变化；回退恢复 size/revision/家具与场景', async () => {
  const seed = await roomSeed();
  const db = seed.db;
  db.run('BEGIN');
  try {
    const seedFrame = readFrame(db, MAP_ROOM);
    const seedMpp = readRow(db, MAP_ROOM).meters_per_cell;
    applyPendingSpatialRequests({ db, scope: SCOPE, turnId: TURN, ports: makePorts() });
    const baseline = readFrame(db, MAP_ROOM);
    const baselineCanonical = canonicalOf(baseline, ROOM);
    assert.ok(baselineCanonical);
    assert.equal(baselineCanonical.revision, 1);

    // 作者把本空间的确认轮廓改成 12×9（真实来源：locations.area_geometry_json）—— 但幅面已被比例尺锁住。
    db.run('UPDATE locations SET area_geometry_json = ? WHERE id = ?', [
      JSON.stringify({ kind: 'polygon', quality: 'confirmed', points: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 9 }, { x: 0, y: 9 }] }),
      ROOM,
    ]);
    db.run('UPDATE maps SET scale_locked = 1 WHERE id = ?', [MAP_ROOM]);

    // 单元证据：直接调用时明确拒绝，且**零变更**（没有半边 mutation）。
    const lockedRow = { ...selectOne(db, 'maps', BRANCH, MAP_ROOM), scale_locked: 1 };
    const refused = alignSqlFrameToPhysicalSize({
      mapRow: lockedRow, widthM: 12, heightM: 9, scope: SCOPE, currentScope: SCOPE,
      expectedRowRev: Number(lockedRow.row_rev), turnId: TURN, operationId: 'op_fit',
      source: { kind: 'author', referenceId: ROOM },
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 'refused');
    assert.equal(refused.mutation, null, '拒绝时绝不能给出半边变更');
    assert.equal(refused.issues[0].code, 'FRAME_SCALE_LOCKED_ASPECT_CONFLICT');
    assert.match(refused.issues[0].message, /不修改比例尺锁/);

    // 集成证据：真实候选里同一条请求也不得带病生成。
    armRequest(db, MAP_ROOM, pendingRequest('req_room_locked', { rooms: [{ id: ROOM, name: '书房', side: 'north', w: 12, h: 9 }] }));
    const before = readFrame(db, MAP_ROOM);
    const beforeRow = readRow(db, MAP_ROOM);
    const beforeCanonical = canonicalOf(before, ROOM);
    assert.deepEqual(beforeCanonical, baselineCanonical, '拒绝之前账本还是基线那一版');
    const outLocked = applyPendingSpatialRequests({ db, scope: SCOPE, turnId: TURN, ports: makePorts() });
    assert.equal(outLocked.processed.includes('req_room_locked'), false, JSON.stringify(outLocked.issues));
    assert.ok(outLocked.issues.some((i) => i.code === 'FRAME_SCALE_LOCKED_ASPECT_CONFLICT'), JSON.stringify(outLocked.issues));
    const afterLocked = readFrame(db, MAP_ROOM);
    assert.equal(JSON.stringify(afterLocked.atlasScene), JSON.stringify(before.atlasScene), '失败不得替换场景');
    assert.deepEqual(canonicalOf(afterLocked, ROOM), beforeCanonical, '失败不得动账本');
    assert.equal(afterLocked.cols, before.cols, '失败不得改幅面');
    assert.equal(afterLocked.rows, before.rows);
    assert.equal(readRow(db, MAP_ROOM).meters_per_cell, beforeRow.meters_per_cell, '失败不得改比例尺');
    assert.equal(afterLocked.atlasLayoutRequest.status, 'failed', '失败请求必须落库为 failed，不得留在 pending');

    // 2) 解锁后同一权威尺寸可以成交：幅面按权威重排、场景与账本一起前进（不是半边）。
    db.run('UPDATE maps SET scale_locked = 0 WHERE id = ?', [MAP_ROOM]);
    armRequest(db, MAP_ROOM, pendingRequest('req_room_unlocked', { rooms: [{ id: ROOM, name: '书房', side: 'north', w: 12, h: 9 }] }));
    const outFit = applyPendingSpatialRequests({ db, scope: SCOPE, turnId: TURN, ports: makePorts() });
    assert.deepEqual(outFit.processed, ['req_room_unlocked'], JSON.stringify(outFit.issues));
    const fittedRow = readRow(db, MAP_ROOM);
    const fittedFrame = frameOf(fittedRow);
    const fittedCanonical = canonicalOf(fittedFrame, ROOM);
    assert.equal(fittedCanonical.size.widthM, 12);
    assert.equal(fittedCanonical.size.heightM, 9);
    assert.equal(fittedCanonical.size.quality, 'confirmed', '作者确认轮廓必须被记成确认尺寸');
    assert.equal(fittedCanonical.size.basis.kind, 'author', '账本必须记下尺寸来源是作者确认');
    assert.equal(fittedCanonical.size.basis.referenceId, ROOM);
    assert.equal(fittedCanonical.revision, baselineCanonical.revision + 1, '尺寸真的前进了一版');
    assert.ok(Math.abs(fittedRow.meters_per_cell * fittedFrame.cols - 12) / 12 <= 0.005, `幅面宽 ${fittedRow.meters_per_cell * fittedFrame.cols}`);
    assert.ok(Math.abs(fittedRow.meters_per_cell * fittedFrame.rows - 9) / 9 <= 0.005, `幅面高 ${fittedRow.meters_per_cell * fittedFrame.rows}`);
    assert.ok(Math.abs(fittedFrame.atlasScene.layout.bounds.w - 12) < EPS, `场景宽 ${fittedFrame.atlasScene.layout.bounds.w}`);
    assert.ok(Math.abs(fittedFrame.atlasScene.layout.bounds.h - 9) < EPS, `场景高 ${fittedFrame.atlasScene.layout.bounds.h}`);
    assert.equal(fittedCanonical.furnishing[0].itemId, ITEM_DESK, '换幅面不得丢家具身份');
    assert.equal(fittedCanonical.furnishing.length, beforeCanonical.furnishing.length, '换幅面不得产生第二套家具');

    // 3) 回退：整轮回滚后 frame（含场景 / 账本 / 请求）逐字节回到**回合前**，什么都没泄漏出去。
    db.run('ROLLBACK');
    db.run('BEGIN');
    const reverted = readFrame(db, MAP_ROOM);
    assert.deepEqual(reverted, seedFrame, '回滚后 frame 必须逐字节回到回合前');
    assert.equal(readRow(db, MAP_ROOM).meters_per_cell, seedMpp, '回滚后比例尺必须回到回合前');
    assert.equal(canonicalOf(reverted, ROOM), null, '回滚后不得留下任何空间权威');
  } finally {
    db.run('ROLLBACK');
    seed.close();
  }
});

// ───────────────────────── SPACE06 · 幅面与宽高比 ─────────────────────────

test('SPACE06：7.5:8、24:2 能适配未锁 frame；锁定/确认幅面不符 → 诊断且不动锁', () => {
  // 1) 两轴共用一个 mpp，且相对误差 ≤0.5%。
  for (const [widthM, heightM] of [[7.5, 8], [24, 2], [12, 8], [9, 6]]) {
    const fit = fitFrameToPhysicalSize({ widthM, heightM });
    assert.equal(fit.ok, true, `${widthM}×${heightM}: ${JSON.stringify(fit.issues)}`);
    assert.ok(Number.isInteger(fit.cols) && Number.isInteger(fit.rows));
    assert.ok(fit.cols >= 1 && fit.cols <= FRAME_FIT_MAX_CELLS);
    assert.ok(fit.rows >= 1 && fit.rows <= FRAME_FIT_MAX_CELLS);
    assert.ok(fit.metersPerCell > 0);
    assert.ok(Math.abs(fit.cols * fit.metersPerCell - widthM) / widthM <= 0.005);
    assert.ok(Math.abs(fit.rows * fit.metersPerCell - heightM) / heightM <= 0.005);
  }
  assert.deepEqual(
    [fitFrameToPhysicalSize({ widthM: 24, heightM: 2 }).cols, fitFrameToPhysicalSize({ widthM: 24, heightM: 2 }).rows],
    [108, 9],
  );

  // 2) 已匹配的现有 frame 原样保留（不重新网格化）。
  const retained = fitFrameToPhysicalSize({ widthM: 7.5, heightM: 8, cols: 105, rows: 112, metersPerCell: 7.5 / 105 });
  assert.equal(retained.changed, false);
  assert.deepEqual([retained.cols, retained.rows], [105, 112]);

  // 3) 表达不了 → 明确诊断，不量化成另一个事实。
  const tooFine = fitFrameToPhysicalSize({ widthM: 10007, heightM: 1 });
  assert.equal(tooFine.ok, false);
  assert.equal(tooFine.issues[0].code, 'FRAME_FIT_UNREPRESENTABLE');
  const bad = fitFrameToPhysicalSize({ widthM: -1, heightM: 8 });
  assert.equal(bad.ok, false);
  assert.equal(bad.issues[0].code, 'FRAME_FIT_INPUT_INVALID');

  // 4) 锁定幅面：拒绝 + 诊断，绝不改锁。
  const locked = mapRow(MAP_ROOM, { scale_locked: 1, frame_json: { cols: 100, rows: 80 }, meters_per_cell: null });
  const lockedFit = alignSqlFrameToPhysicalSize({
    mapRow: locked, widthM: ROOM_W, heightM: ROOM_H, scope: SCOPE, currentScope: SCOPE,
    expectedRowRev: 1, turnId: TURN, operationId: 'op_lock', source: { kind: 'canonical', referenceId: ROOM },
  });
  assert.equal(lockedFit.status, 'refused');
  assert.equal(lockedFit.mutation, null);
  assert.equal(lockedFit.issues[0].code, 'FRAME_SCALE_LOCKED_ASPECT_CONFLICT');
  assert.equal(locked.scale_locked, 1);
  assert.deepEqual(locked.frame_json, { cols: 100, rows: 80 }, '锁定幅面一个字节都不许动');

  // 5) 已确认比例尺同理：不把确认尺寸量化成另一事实。
  const confirmed = mapRow(MAP_ROOM, { scale_quality: 'confirmed', frame_json: { cols: 100, rows: 80 }, meters_per_cell: null });
  const confirmedFit = alignSqlFrameToPhysicalSize({
    mapRow: confirmed, widthM: ROOM_W, heightM: ROOM_H, scope: SCOPE, currentScope: SCOPE,
    expectedRowRev: 1, turnId: TURN, operationId: 'op_confirmed', source: { kind: 'canonical', referenceId: ROOM },
  });
  assert.equal(confirmedFit.status, 'refused');
  assert.equal(confirmedFit.issues[0].code, 'FRAME_CONFIRMED_ASPECT_CONFLICT');
  assert.equal(confirmedFit.mutation, null);

  // 6) 未锁定 → 给出真实 maps 变更（同一 mpp、两轴都在误差内）。
  const open = mapRow(MAP_ROOM, { frame_json: { cols: 100, rows: 80 }, meters_per_cell: null, row_rev: 7 });
  const aligned = alignSqlFrameToPhysicalSize({
    mapRow: open, widthM: ROOM_W, heightM: ROOM_H, scope: SCOPE, currentScope: SCOPE,
    expectedRowRev: 7, turnId: TURN, operationId: 'op_open', source: { kind: 'parent-footprint', referenceId: MAP_BLD },
  });
  assert.equal(aligned.status, 'aligned', JSON.stringify(aligned.issues));
  const after = aligned.mutation.after;
  assert.equal(after.row_rev, 8);
  assert.equal(after.calibration_rev, Number(open.calibration_rev) + 1);
  assert.equal(after.frame_json.reference_width_cells, after.frame_json.cols);
  assert.equal(after.frame_json.reference_height_cells, after.frame_json.rows);
  assert.ok(Math.abs(after.frame_json.cols * after.meters_per_cell - ROOM_W) / ROOM_W <= 0.005);
  assert.ok(Math.abs(after.frame_json.rows * after.meters_per_cell - ROOM_H) / ROOM_H <= 0.005);
  assert.equal(after.scale_basis_json.locationId, MAP_BLD);
});

// ───────────────────────── SPACE07 · fork 与 POV ─────────────────────────

test('SPACE07：fork 复制 canonical 且分支独立；POV 不下发尺寸依据与隐藏家具', async () => {
  const seed = await roomSeed();
  const db = seed.db;
  try {
    // forkBranch 自己开事务：先把本轮候选落定（COMMIT），再分叉。
    db.run('BEGIN');
    applyPendingSpatialRequests({ db, scope: SCOPE, turnId: TURN, ports: makePorts() });
    db.run('COMMIT');
    const parentCanonical = canonicalOf(readFrame(db, MAP_ROOM), ROOM);
    assert.ok(parentCanonical);

    // 1) fork 复制 maps（含 frame 里的 atlasSpaceCanonical）。
    const forkTurnId = 'turn_fork';
    db.run(
      `INSERT INTO turns (id, branch_id, parent_turn_id, host_message_uid, host_variant_key, kind, input_hash, story_hash, base_revision, committed_revision, clock_before_s, elapsed_json, clock_after_s, rng_seed, ruleset_version, decisions_json, receipt_json, attempts_json, status, created_wall_ms, prepared_wall_ms)
       VALUES (?, ?, NULL, NULL, NULL, 'manual', ?, NULL, 0, 0, 0, ?, 0, ?, 'atlas-1', ?, NULL, ?, 'pending', ?, ?)`,
      [forkTurnId, BRANCH, `hash_${forkTurnId}`, JSON.stringify({ min_s: 0, nominal_s: 0, max_s: 0, quality: 'explicit', basis_refs: [] }), `rng_${forkTurnId}`, JSON.stringify({ operations: [], attention_decisions: [], outcome_decisions: [], random_draws: [] }), JSON.stringify([]), 1_700_000_000_000, 1_700_000_000_000],
    );
    forkBranch({
      parentBranchId: BRANCH, newBranchId: 'main-A-space', name: '空间分叉', forkTurnId,
      makeId: (kind, opId, alias) => `${kind}_${String(opId)}_${String(alias)}`.replace(/[^a-zA-Z0-9_]/g, '_'),
      nowWallMs: 1_700_000_000_002, rulesetVersion: 'atlas-1',
    }, db);
    const forkFrameRow = selectOne(db, 'maps', 'main-A-space', MAP_ROOM);
    assert.ok(forkFrameRow, 'fork 必须复制子图行');
    const forkFrame = typeof forkFrameRow.frame_json === 'string' ? JSON.parse(forkFrameRow.frame_json) : forkFrameRow.frame_json;
    const forkCanonical = canonicalOf(forkFrame, ROOM);
    assert.deepEqual(forkCanonical, parentCanonical, 'fork 复制空间权威');

    // 2) 分支独立：改父分支的账本不影响 fork，反之亦然。
    db.run('UPDATE maps SET frame_json = ? WHERE branch_id = ? AND id = ?', [
      JSON.stringify({ ...readFrame(db, MAP_ROOM), [SPACE_CANONICAL_FRAME_KEY]: { ...parentCanonical, revision: 9, size: { ...parentCanonical.size, widthM: 11, heightM: 11 } } }),
      BRANCH, MAP_ROOM,
    ]);
    db.run('UPDATE maps SET frame_json = ? WHERE branch_id = ? AND id = ?', [
      JSON.stringify({ ...forkFrame, [SPACE_CANONICAL_FRAME_KEY]: { ...forkCanonical, revision: 3 } }),
      'main-A-space', MAP_ROOM,
    ]);
    assert.equal(canonicalOf(readFrame(db, MAP_ROOM), ROOM).revision, 9);
    const refetchedFork = selectOne(db, 'maps', 'main-A-space', MAP_ROOM);
    const refetchedForkFrame = typeof refetchedFork.frame_json === 'string' ? JSON.parse(refetchedFork.frame_json) : refetchedFork.frame_json;
    assert.equal(canonicalOf(refetchedForkFrame, ROOM).revision, 3);
    assert.equal(canonicalOf(refetchedForkFrame, ROOM).size.widthM, ROOM_W, 'fork 的空间尺寸不被父分支改动带走');

    // 3) POV：尺寸**原始依据**与隐藏家具都不下发。
    const author = Kit.publicSpaceCanonical(parentCanonical, { viewMode: 'author' });
    assert.ok(author.size.basis, '作者视图必须能看到尺寸依据');
    assert.equal(author.furnishing.length, parentCanonical.furnishing.length);
    const pov = Kit.publicSpaceCanonical(parentCanonical, { viewMode: 'pov' });
    assert.equal(pov.size.widthM, parentCanonical.size.widthM);
    assert.equal('basis' in pov.size, false, 'POV 不得下发尺寸原始依据');
    assert.deepEqual(pov.furnishing, [], 'POV 没有可见集合时不下发任何家具');
    const serialized = JSON.stringify(pov);
    assert.ok(!serialized.includes('author'), 'POV 结果里不能出现依据内容');
    assert.ok(!serialized.includes(ITEM_DESK), '隐藏家具的真实 itemId 不得泄漏');
    const partial = Kit.publicSpaceCanonical(parentCanonical, { viewMode: 'pov', visibleLocalIds: new Set([spaceLocalId(ROOM, 'desk-1')]) });
    assert.deepEqual(partial.furnishing.map((f) => f.localId), [spaceLocalId(ROOM, 'desk-1')]);

    // 4) 公开 frame 白名单永远不会带出 canonical（POV/author 都一样）。
    const pub = Kit.publicMapFrame(readFrame(db, MAP_ROOM));
    assert.equal(Object.hasOwn(pub, SPACE_CANONICAL_FRAME_KEY), false);
    assert.deepEqual(Object.keys(pub).sort(), ['cols', 'origin_x', 'origin_y', 'reference_height_cells', 'reference_width_cells', 'rows']);
  } finally {
    seed.close();
  }
});

// ───────────────────────── 账本边界与布局任务接线 ─────────────────────────

test('空间权威有界：超上限明确 deferred 且保留原记录，坏记录不被采用', async () => {
  const furnishing = (count) => Array.from({ length: count }, (_, i) => ({
    localId: spaceLocalId(ROOM, `f-${i}`), type: 'chair', name: `椅${i}`,
    itemId: null, widthM: 0.5, heightM: 0.5, quality: 'layout',
  }));
  const canonical = { version: 1, locationId: ROOM, revision: 2, size: null, furnishing: furnishing(SPACE_CANONICAL_MAX_FURNISHING + 1) };

  // 1) 真实写入路径（候选 → buildSceneMutation）遇到超限旧账本：**明确 deferred 且原记录逐字节保留**，
  //    绝不静默裁剪成 128 条、也不放宽 LIMITS.sceneBytes 去装新家具。
  const seed = await roomSeed();
  const db = seed.db;
  db.run('BEGIN');
  try {
    writeFrame(db, MAP_ROOM, { ...readFrame(db, MAP_ROOM), [SPACE_CANONICAL_FRAME_KEY]: canonical });
    const beforeWrite = readFrame(db, MAP_ROOM)[SPACE_CANONICAL_FRAME_KEY];
    const out = applyPendingSpatialRequests({ db, scope: SCOPE, turnId: TURN, ports: makePorts() });
    assert.ok(out.issues.some((i) => i.code === 'SPACE_FURNISHING_DEFERRED'), JSON.stringify(out.issues));
    const afterWrite = readFrame(db, MAP_ROOM)[SPACE_CANONICAL_FRAME_KEY];
    assert.equal(afterWrite.furnishing.length, SPACE_CANONICAL_MAX_FURNISHING + 1, '原记录不被裁剪');
    assert.deepEqual(afterWrite, beforeWrite, '超限时原记录逐字节保留');
    assert.equal(SPACE_CANONICAL_MAX_FURNISHING, Kit.SPACE_CANONICAL_MAX_FURNISHING, '宿主上限与 kit 上限是同一个数');
  } finally {
    db.run('ROLLBACK');
    seed.close();
  }

  // 2) 读取超限 → 记录仍在、明确 deferred（不静默裁剪成 128 条）。
  const read = readSpaceCanonical({ cols: 100, rows: 80, [SPACE_CANONICAL_FRAME_KEY]: canonical }, ROOM);
  assert.equal(read.ok, true);
  assert.equal(read.deferred, true);
  assert.equal(read.canonical.furnishing.length, SPACE_CANONICAL_MAX_FURNISHING + 1);

  // 3) 身份不符 / 结构损坏 → 不采用。
  const mismatch = readSpaceCanonical({ [SPACE_CANONICAL_FRAME_KEY]: canonical }, HALL);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.canonical, null);
  assert.equal(mismatch.issues[0].code, 'SPACE_CANONICAL_IDENTITY_MISMATCH');
  const broken = readSpaceCanonical({ [SPACE_CANONICAL_FRAME_KEY]: { version: 99, locationId: ROOM } }, ROOM);
  assert.equal(broken.ok, false);
  assert.equal(broken.issues[0].code, 'SPACE_CANONICAL_VERSION_UNSUPPORTED');

  // 4) 多持有者 → 不随机挑一个。
  const holder = spaceCanonicalHolder([
    mapRow('M_A', { container_location_id: ROOM }),
    mapRow('M_B', { container_location_id: ROOM }),
  ], ROOM);
  assert.equal(holder.holder, null);
  assert.equal(holder.issues[0].code, 'SPACE_CONTAINER_AMBIGUOUS');
  assert.deepEqual(holder.issues[0].relatedIds, ['M_A', 'M_B']);
});

test('布局任务读 canonical 尺寸：extent 与 baselineRooms 都以权威为准，能力清单同步', async () => {
  const seed = await roomSeed();
  const db = seed.db;
  db.run('BEGIN');
  try {
    // 先写入一份权威尺寸（9×6），父图足迹是 7.5×8：canonical 优先（它在顺序上更高）。
    const frame = readFrame(db, MAP_ROOM);
    writeFrame(db, MAP_ROOM, { ...frame, meters_per_cell: 0.12, scale_quality: 'estimated',
      [SPACE_CANONICAL_FRAME_KEY]: {
        version: 1, locationId: ROOM, revision: 2,
        size: { widthM: 9, heightM: 6, quality: 'estimated', locked: false, basis: { kind: 'first-estimate', referenceId: null, note: '旧估计' } },
        furnishing: [],
      } });
    const row = selectOne(db, 'maps', BRANCH, MAP_ROOM);
    const resolved = resolveMapSpaceSize({
      maps: [selectOne(db, 'maps', BRANCH, MAP_BLD), row],
      locations: [SITE, BLD, ROOM, HALL].map((id) => selectOne(db, 'locations', BRANCH, id)),
      mapRow: row, branchId: BRANCH,
      firstEstimate: { widthM: 12, heightM: 10 },
    });
    assert.equal(resolved.resolution.source, 'canonical');
    assert.equal(resolved.resolution.widthM, 9);
    assert.equal(resolved.resolution.heightM, 6);
    assert.equal(resolved.canonical.revision, 2);

    // 真实布局任务：scope 的 extent 与 baselineRooms 都读取权威尺寸，并下发权威来源。
    const task = buildSqlLayoutTask(db, BRANCH, {
      anchor: { chatUid: IDS.chatA, branchId: BRANCH, baseRevision: 0, baseStorageRevision: 0 },
      userText: '', assistantText: '', sourceSnapshot: [],
      layoutMaps: [MAP_ROOM],
    }, 'turn_layout_space');
    assert.ok(task, '有具体图必须产出布局任务');
    const extents = task.extents[MAP_ROOM];
    assert.equal(extents.width, 9);
    assert.equal(extents.height, 6);
    assert.equal(extents.units, 'meters');
    const [scope] = floorScopesOf(task);
    assert.ok(scope, '子图任务必须带一份 floor scope');
    assert.equal(scope.spaceSize.source, 'canonical');
    assert.equal(scope.spaceSize.revision, 2);
    assert.equal(scope.spaceSize.widthM, 9);
    assert.equal(scope.spaceSize.heightM, 6);
    assert.deepEqual(scope.childSpaces, [], '书房自己没有下级空间，不许凭空列子空间');
    assert.ok(scope.baselineRooms.length > 0, '子图必须有基线房间示意');
    assert.ok(scope.baselineRooms.every((r) => r.w <= 9 && r.h <= 6), JSON.stringify(scope.baselineRooms));
    assert.deepEqual(scope.baselineRooms.map(r=>[r.w,r.h]),[[9,6]],'自身完整空间不得再缩为 75%');
    assert.ok(task.request.messages[1].content.includes('space-canonical/v1'), '能力为真时必须把契约发给模型');

    // 父图（MAP_BLD）的任务里，父子共享尺寸：子空间以同一条权威下发。
    const parentTask = buildSqlLayoutTask(db, BRANCH, {
      anchor: { chatUid: IDS.chatA, branchId: BRANCH, baseRevision: 0, baseStorageRevision: 0 },
      userText: '', assistantText: '', sourceSnapshot: [],
      layoutMaps: [MAP_BLD],
    }, 'turn_layout_parent');
    assert.ok(parentTask, '父图也必须产出布局任务');
    const [parentScope] = floorScopesOf(parentTask);
    assert.ok(parentScope, '父图任务必须带一份 floor scope');
    const roomChild = parentScope.childSpaces.find((c) => c.ref === 'L3');
    assert.ok(roomChild, JSON.stringify(parentScope.childSpaces));
    assert.deepEqual([roomChild.name, roomChild.w, roomChild.h, roomChild.source], ['书房', 9, 6, 'canonical']);
    const baselineChild=parentScope.baselineRooms.find(r=>r.id===roomChild.ref);
    assert.deepEqual([baselineChild.w,baselineChild.h],[9,6],'父图基线不得压缩子空间权威');
    // 能力清单纪律（§21.5）：只有 normalize/编译/生成/存储/DTO/命令全部打通的能力才在表里。
    // P13 完成后 spatial-profile/v1 满足这一条件，因此清单是三项而不是两项。
    assert.deepEqual([...SPATIAL_CAPABILITIES], ['corridor-binding/v1', 'space-canonical/v1', 'spatial-profile/v1']);
    for (const capability of SPATIAL_CAPABILITIES) assert.equal(hasSpatialCapability(capability), true);
    assert.equal(hasSpatialCapability('unimplemented/v1'), false, '未实现的能力字符串不得被当成已声明');
    assert.equal(CAPABILITY_SPACE_CANONICAL, 'space-canonical/v1');
  } finally {
    db.run('ROLLBACK');
    seed.close();
  }
});
