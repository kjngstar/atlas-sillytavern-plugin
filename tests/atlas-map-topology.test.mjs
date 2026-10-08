/**
 * M2-02：T01–T04 地图拓扑纯函数验收。
 *
 * 纪律：
 * - 全部为对象输入，不建库、不调外网；合成数据只存在本文件。
 * - 每次调用前后对输入做深拷贝对比，证明纯函数不改输入（等价于「SQL 值未改」）。
 * - 每个坏图场景都断言：问题带实体/地图 ID；无死循环（测试会自然超时兜底）；
 *   所有地图恰好出现一次，且要么可达、要么在 unlinked 列表。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveMapTopology } from '../src/atlas-map-topology.ts';
import { ATLAS_RUNTIME_LIMITS } from '../src/atlas-runtime-limits.ts';
import { queryMapView } from '../src/atlas-db-views.ts';
import { IDS, makeSeedWith } from './fixtures/atlas-sql/seed.mjs';

const SQL = await (await import('sql.js')).default();

const BRANCH = 'branch';

function loc(over = {}) {
  return {
    id: 'L',
    branchId: BRANCH,
    kind: 'city',
    parentLocationId: null,
    anchorLocationId: null,
    mobility: 'fixed',
    mapId: null,
    status: 'active',
    ...over,
  };
}

function map(over = {}) {
  return { id: 'M', branchId: BRANCH, containerLocationId: null, status: 'active', ...over };
}

const node = (topology, mapId) => topology.nodes.find((n) => n.mapId === mapId);
const codes = (topology) => topology.issues.map((i) => i.code);
const issueOf = (topology, code) => topology.issues.find((i) => i.code === code);

/** T03 公共断言：不丢不重、可达或在 unlinked、问题都带定位。 */
function assertCoverage(input, topology) {
  const activeMapIds = input.maps
    .filter((m) => m.branchId === input.branchId && m.status === 'active')
    .map((m) => m.id)
    .sort();
  const nodeIds = topology.nodes.map((n) => n.mapId);

  assert.deepEqual([...nodeIds].sort(), activeMapIds, '每张 active 地图必须恰好出现一次');
  assert.equal(new Set(nodeIds).size, nodeIds.length, '节点不得重复');
  assert.deepEqual(
    topology.rootMapIds,
    [...topology.rootMapIds].sort(),
    'rootMapIds 必须稳定排序',
  );

  const reachable = new Set(
    topology.nodes.filter((n) => n.connectionQuality === 'root' || n.parentMapId !== null).map((n) => n.mapId),
  );
  const covered = new Set([...reachable, ...topology.unlinkedMapIds]);
  for (const id of activeMapIds) {
    assert.ok(covered.has(id), `${id} 既不可达也不在 unlinkedMapIds`);
  }
  for (const n of topology.nodes) {
    if (!reachable.has(n.mapId)) {
      assert.ok(topology.unlinkedMapIds.includes(n.mapId), `${n.mapId} 不可达就必须进 unlinkedMapIds`);
    }
  }

  for (const issue of topology.issues) {
    assert.ok(
      issue.mapId || issue.locationId || (Array.isArray(issue.relatedIds) && issue.relatedIds.length > 0),
      `问题 ${issue.code} 必须带实体或地图 ID`,
    );
    assert.ok(['warning', 'error'].includes(issue.severity), `问题 ${issue.code} 的 severity 非法`);
  }
}

test('T01 导航与坐标解耦：建筑内图挂城区内图，不挂世界图，且不改输入', () => {
  const input = {
    branchId: BRANCH,
    rootMapId: 'M_world',
    maxDepth: ATLAS_RUNTIME_LIMITS.locationDepth,
    maps: [
      map({ id: 'M_world', containerLocationId: null }),
      map({ id: 'M_district', containerLocationId: 'L_district' }),
      map({ id: 'M_building', containerLocationId: 'L_building' }),
    ],
    locations: [
      // 建筑 map_id 仍登记在世界图（旧数据常见）；导航不能因此被带偏。
      loc({ id: 'L_district', kind: 'city', parentLocationId: null, mapId: 'M_world' }),
      loc({ id: 'L_building', kind: 'building', parentLocationId: 'L_district', mapId: 'M_world' }),
    ],
  };
  const snapshot = structuredClone(input);

  const topology = resolveMapTopology(input);

  assert.equal(node(topology, 'M_world').connectionQuality, 'root');
  assert.equal(node(topology, 'M_world').parentMapId, null);
  assert.equal(node(topology, 'M_district').parentMapId, 'M_world', '城区顶图无祖先 → 只挂根图');
  assert.equal(node(topology, 'M_district').connectionQuality, 'unclassified');
  assert.equal(node(topology, 'M_building').parentMapId, 'M_district', '建筑内图必须挂城区内图');
  assert.notEqual(node(topology, 'M_building').parentMapId, 'M_world', '不能照 map_id 挂世界图');
  assert.equal(node(topology, 'M_building').connectionQuality, 'contained');
  assert.equal(node(topology, 'M_building').containerLocationId, 'L_building');

  assertCoverage(input, topology);
  assert.deepEqual(input, snapshot, '纯函数不得修改输入（SQL 值未改）');

  // map_id 变化（跨图迁移）不影响固定地点的包含导航。
  const migrated = structuredClone(input);
  migrated.locations.find((l) => l.id === 'L_building').mapId = 'M_district';
  const after = resolveMapTopology(migrated);
  assert.equal(node(after, 'M_building').parentMapId, 'M_district', 'map_id 改了，导航结果必须一致');
  assert.deepEqual(
    after.nodes,
    topology.nodes,
    '仅改地点 map_id 不得改变任何节点归属',
  );
});

test('T02 载具停靠：anchored 到停靠点内图，不改 parent_location_id 与内图 ID', () => {
  const base = {
    branchId: BRANCH,
    rootMapId: 'M_world',
    maxDepth: ATLAS_RUNTIME_LIMITS.locationDepth,
    maps: [
      map({ id: 'M_world', containerLocationId: null }),
      map({ id: 'M_alpha', containerLocationId: 'L_alpha' }),
      map({ id: 'M_beta', containerLocationId: 'L_beta' }),
      map({ id: 'M_stop_a', containerLocationId: 'L_stop_a' }),
      map({ id: 'M_stop_b', containerLocationId: 'L_stop_b' }),
      map({ id: 'M_vehicle', containerLocationId: 'L_vehicle' }),
    ],
    locations: [
      loc({ id: 'L_alpha', kind: 'city' }),
      loc({ id: 'L_beta', kind: 'city' }),
      loc({ id: 'L_stop_a', kind: 'district', parentLocationId: 'L_alpha' }),
      loc({ id: 'L_stop_b', kind: 'district', parentLocationId: 'L_beta' }),
      loc({ id: 'L_vehicle', kind: 'vehicle', mobility: 'mobile', anchorLocationId: 'L_stop_a' }),
    ],
  };
  const snapshot = structuredClone(base);

  const parked = resolveMapTopology(base);
  assert.equal(node(parked, 'M_vehicle').parentMapId, 'M_stop_a', '停靠甲 → 挂甲的内图');
  assert.equal(node(parked, 'M_vehicle').connectionQuality, 'anchored');
  assert.equal(node(parked, 'M_vehicle').containerLocationId, 'L_vehicle', '内图 ID 不变');
  assert.deepEqual(codes(parked).filter((c) => c !== 'ROOT_MAP_MISSING'), []);

  // 下一轮在途前往乙：只换 anchor，父链与内图都不动。
  const inTransit = structuredClone(base);
  inTransit.locations.find((l) => l.id === 'L_vehicle').anchorLocationId = 'L_stop_b';
  const moved = resolveMapTopology(inTransit);
  assert.equal(node(moved, 'M_vehicle').parentMapId, 'M_stop_b', '在途 → 挂目的地停靠内图');
  assert.equal(node(moved, 'M_vehicle').connectionQuality, 'anchored');
  assert.equal(node(moved, 'M_vehicle').containerLocationId, 'L_vehicle', '内图仍同 ID');
  assert.equal(
    inTransit.locations.find((l) => l.id === 'L_vehicle').parentLocationId,
    null,
    'parent_location_id 不得被改写',
  );

  assertCoverage(base, parked);
  assertCoverage(inTransit, moved);
  assert.deepEqual(base, snapshot, '纯函数不得修改输入');
});

test('T03 坏拓扑隔离：父环/自引用/缺父/重复容器 各自报问题且互不波及', () => {
  const input = {
    branchId: BRANCH,
    rootMapId: 'M_world',
    maxDepth: ATLAS_RUNTIME_LIMITS.locationDepth,
    maps: [
      map({ id: 'M_world', containerLocationId: null }),
      map({ id: 'M_good', containerLocationId: 'L_good' }),
      map({ id: 'M_cycle', containerLocationId: 'L_a' }),
      map({ id: 'M_self', containerLocationId: 'L_self' }),
      map({ id: 'M_orphan', containerLocationId: 'L_orphan' }),
      map({ id: 'M_dup_1', containerLocationId: 'L_dup' }),
      map({ id: 'M_dup_2', containerLocationId: 'L_dup' }),
      map({ id: 'M_ghostmap', containerLocationId: 'L_ghostloc' }),
    ],
    locations: [
      loc({ id: 'L_good', kind: 'city', mapId: 'M_world' }),
      // 父环
      loc({ id: 'L_a', kind: 'district', parentLocationId: 'L_b' }),
      loc({ id: 'L_b', kind: 'district', parentLocationId: 'L_a' }),
      // 自引用：地点落自己的内图
      loc({ id: 'L_self', kind: 'room', mapId: 'M_self' }),
      // 缺父
      loc({ id: 'L_orphan', kind: 'district', parentLocationId: 'L_ghost' }),
      // 同一容器两张地图
      loc({ id: 'L_dup', kind: 'city' }),
    ],
  };
  const snapshot = structuredClone(input);

  const topology = resolveMapTopology(input);
  const found = new Set(codes(topology));

  assert.ok(found.has('LOCATION_PARENT_CYCLE'), '父环必须报 LOCATION_PARENT_CYCLE');
  assert.ok(issueOf(topology, 'LOCATION_PARENT_CYCLE').locationId, '父环问题必须带地点 ID');
  assert.ok(found.has('MAP_SELF_CONTAINED'), '地点落自己内图必须报 MAP_SELF_CONTAINED');
  assert.equal(issueOf(topology, 'MAP_SELF_CONTAINED').mapId, 'M_self');
  assert.equal(issueOf(topology, 'MAP_SELF_CONTAINED').locationId, 'L_self');
  assert.ok(found.has('LOCATION_PARENT_MISSING'), '缺父必须报 LOCATION_PARENT_MISSING');
  assert.equal(issueOf(topology, 'LOCATION_PARENT_MISSING').locationId, 'L_ghost');
  assert.ok(found.has('AMBIGUOUS_CONTAINER_MAP'), '同容器两图必须报 AMBIGUOUS_CONTAINER_MAP');
  const ambiguous = issueOf(topology, 'AMBIGUOUS_CONTAINER_MAP');
  assert.equal(ambiguous.locationId, 'L_dup');
  assert.deepEqual([...ambiguous.relatedIds].sort(), ['M_dup_1', 'M_dup_2'], '歧义必须带全部冲突地图 ID');
  assert.ok(found.has('CONTAINER_LOCATION_MISSING'), '容器地点缺失必须报 CONTAINER_LOCATION_MISSING');
  assert.equal(issueOf(topology, 'CONTAINER_LOCATION_MISSING').mapId, 'M_ghostmap');
  assert.equal(issueOf(topology, 'CONTAINER_LOCATION_MISSING').locationId, 'L_ghostloc');

  for (const bad of ['M_cycle', 'M_self', 'M_orphan', 'M_dup_1', 'M_dup_2', 'M_ghostmap']) {
    assert.ok(topology.unlinkedMapIds.includes(bad), `${bad} 必须进 unlinkedMapIds`);
  }
  // 独立合法组不受波及。
  assert.equal(node(topology, 'M_good').parentMapId, 'M_world');
  assert.equal(node(topology, 'M_good').connectionQuality, 'unclassified');
  assert.ok(!topology.unlinkedMapIds.includes('M_good'), '合法图不得被坏图连坐');

  assertCoverage(input, topology);
  assert.deepEqual(input, snapshot, '纯函数不得修改输入');
});

test('T03b 多根与根缺失：给出明确问题且每图仍可达一次', () => {
  // 多顶图 + 指定根 → 其余顶图归属不明。
  const multiRoot = {
    branchId: BRANCH,
    rootMapId: 'M_r1',
    maxDepth: ATLAS_RUNTIME_LIMITS.locationDepth,
    maps: [
      map({ id: 'M_r1', containerLocationId: null }),
      map({ id: 'M_r2', containerLocationId: null }),
      map({ id: 'M_child', containerLocationId: 'L_c' }),
    ],
    locations: [loc({ id: 'L_c', kind: 'city' })],
  };
  const multi = resolveMapTopology(multiRoot);
  assert.ok(codes(multi).includes('MULTIPLE_ROOT_MAPS'), '多顶图必须报 MULTIPLE_ROOT_MAPS');
  assert.deepEqual([...issueOf(multi, 'MULTIPLE_ROOT_MAPS').relatedIds].sort(), ['M_r1', 'M_r2']);
  assert.deepEqual(multi.rootMapIds, ['M_r1', 'M_r2']);
  assert.ok(multi.unlinkedMapIds.includes('M_r2'), '非回落根顶图必须进未挂接');
  assert.equal(node(multi, 'M_child').parentMapId, 'M_r1', '无祖先图只挂回落根，不改 SQL parent');
  assertCoverage(multiRoot, multi);

  // 指定根不存在。
  const missingRoot = {
    branchId: BRANCH,
    rootMapId: 'M_nope',
    maxDepth: ATLAS_RUNTIME_LIMITS.locationDepth,
    maps: [map({ id: 'M_world', containerLocationId: null }), map({ id: 'M_iso', containerLocationId: 'L_iso' })],
    locations: [loc({ id: 'L_iso', kind: 'city' })],
  };
  const missing = resolveMapTopology(missingRoot);
  assert.ok(codes(missing).includes('ROOT_MAP_MISSING'));
  assert.equal(issueOf(missing, 'ROOT_MAP_MISSING').mapId, 'M_nope');
  assert.equal(node(missing, 'M_iso').parentMapId, 'M_world', '仅回落挂根，不伪造根');
  assertCoverage(missingRoot, missing);

  // 空输入：不抛错，明确缺根。
  const empty = resolveMapTopology({ branchId: BRANCH, rootMapId: null, maxDepth: 12, maps: [], locations: [] });
  assert.deepEqual(empty.nodes, []);
  assert.deepEqual(empty.unlinkedMapIds, []);
  assert.ok(codes(empty).includes('ROOT_MAP_MISSING'));

  // 地图 ID 与地点 ID 不同名（容器地点 ID ≠ 地图 ID），归属仍按容器推导。
  const distinct = {
    branchId: BRANCH,
    rootMapId: 'map:world',
    maxDepth: 12,
    maps: [
      map({ id: 'map:world', containerLocationId: null }),
      map({ id: 'map:a', containerLocationId: 'loc:a' }),
      map({ id: 'map:b', containerLocationId: 'loc:b' }),
    ],
    locations: [
      loc({ id: 'loc:a', kind: 'city', mapId: 'map:world' }),
      loc({ id: 'loc:b', kind: 'building', parentLocationId: 'loc:a', mapId: 'map:world' }),
    ],
  };
  const t = resolveMapTopology(distinct);
  assert.equal(node(t, 'map:b').parentMapId, 'map:a', '不得按 ID 字符串相似度推父子');
  assert.equal(node(t, 'map:b').connectionQuality, 'contained');
  assertCoverage(distinct, t);
});

test('T04 深层链：7/12 父边通过，13 父边报 LOCATION_DEPTH_LIMIT，且不动物品容器上限', () => {
  assert.equal(ATLAS_RUNTIME_LIMITS.locationDepth, 12, '地点父链上限固定 12 条父边');
  assert.equal(ATLAS_RUNTIME_LIMITS.containerDepth, 4, '物品容器深度上限必须保持 4 不动');

  const chainInput = (edges) => {
    const locations = [];
    for (let i = 0; i <= edges; i += 1) {
      locations.push(
        loc({ id: `L_${i}`, kind: 'room', parentLocationId: i === edges ? null : `L_${i + 1}`, mapId: 'M_world' }),
      );
    }
    return {
      branchId: BRANCH,
      rootMapId: 'M_world',
      maxDepth: ATLAS_RUNTIME_LIMITS.locationDepth,
      maps: [map({ id: 'M_world', containerLocationId: null }), map({ id: 'M_deep', containerLocationId: 'L_0' })],
      locations,
    };
  };

  for (const edges of [7, 12]) {
    const input = chainInput(edges);
    const snapshot = structuredClone(input);
    const topology = resolveMapTopology(input);
    assert.ok(
      !codes(topology).includes('LOCATION_DEPTH_LIMIT'),
      `${edges} 条父边不得报 LOCATION_DEPTH_LIMIT`,
    );
    assert.equal(node(topology, 'M_deep').parentMapId, 'M_world', `${edges} 边应回落到根图`);
    assert.equal(node(topology, 'M_deep').connectionQuality, 'unclassified');
    assertCoverage(input, topology);
    assert.deepEqual(input, snapshot);
  }

  const deep = chainInput(13);
  const topology = resolveMapTopology(deep);
  assert.ok(codes(topology).includes('LOCATION_DEPTH_LIMIT'), '13 条父边必须报 LOCATION_DEPTH_LIMIT');
  assert.equal(node(topology, 'M_deep').connectionQuality, 'invalid');
  assert.ok(topology.unlinkedMapIds.includes('M_deep'), '超深链的图必须进未挂接而不是硬挂');
  assertCoverage(deep, topology);

  // 正好 12 条父边时，第 13 条才越界：上限语义是「父边数」，不是节点数。
  const boundary = chainInput(12);
  assert.equal(boundary.locations.length, 13, '12 边链含 13 个地点');
  assert.ok(!codes(resolveMapTopology(boundary)).includes('LOCATION_DEPTH_LIMIT'));
});

test('M2-05 queryMapView 导航字段：视图侧同样按容器父链算 parentMapId，不看 map_id（T01/T02）', async () => {
  const seed = await makeSeedWith(SQL);
  try {
    const ctx = { db: seed.db, branchId: IDS.branchMain, revision: 0, viewMode: 'author', povId: null };
    const result = queryMapView(ctx, { kind: 'map', branchId: IDS.branchMain });
    const world = result.items.find((m) => m.mapId === IDS.M1);
    const room = result.items.find((m) => m.mapId === IDS.M2);
    assert.ok(world && room, '夹具应有世界图与教室图');

    assert.equal(world.connectionQuality, 'root');
    assert.equal(world.parentMapId, null);
    assert.deepEqual(world.topologyIssueCodes, []);

    // 夹具的教室图 M2 是「旧式自容器图」：M2 的容器是教室 L3，而 L3 又画在 M2 上。
    // 生产路径（compileSqlSceneMaps）一律把地点画在**父地点**的内图上，不会产生这种形状；
    // 夹具是手写旧档，按 02 §3「旧坏档只读仍展示目录，在未挂接地图组列出」处理。
    assert.equal(room.connectionQuality, 'invalid');
    assert.equal(room.containerLocationId, IDS.L3);
    assert.deepEqual(room.topologyIssueCodes, ['MAP_SELF_CONTAINED']);
    assert.equal(result.metadata.publicRootMapId, IDS.M1);
    assert.deepEqual(result.metadata.unlinkedMapIds, [IDS.M2], '旧坏图进未挂接清单，不静默挂错');
    assert.ok(
      result.metadata.topologyIssues.some((issue) => issue.code === 'MAP_SELF_CONTAINED' && issue.locationId === IDS.L3),
      '作者视图必须说明是哪张图、哪条容器关系坏了',
    );

    // POV：不出现 invalid，也不下发任何坏图诊断；坏图只能挂到公开根图，不泄露隐藏祖先。
    const pov = queryMapView({ ...ctx, viewMode: 'pov', povId: 'nobody' }, { kind: 'map', branchId: IDS.branchMain });
    assert.deepEqual(pov.metadata.topologyIssues, []);
    assert.deepEqual(pov.metadata.unlinkedMapIds, []);
    const povRoom = pov.items.find((m) => m.mapId === IDS.M2);
    assert.equal(povRoom.connectionQuality, 'unclassified');
    assert.equal(povRoom.parentMapId, IDS.M1);
    for (const item of pov.items) {
      assert.ok(['root', 'contained', 'anchored', 'unclassified'].includes(item.connectionQuality), 'POV 不出现 invalid');
      assert.deepEqual(item.topologyIssueCodes, []);
    }

    // 作者视图：造一张坏图（父环）后必须出现逐图诊断码，而不是静默吞掉。
    // 先让教室不再画在自己的内图上（否则会先命中自容器、走不到父链），再制造 L1↔L2 父环。
    seed.db.run("UPDATE locations SET map_id = 'M1' WHERE branch_id = ? AND id = ?", [IDS.branchMain, IDS.L3]);
    seed.db.run("UPDATE locations SET parent_location_id = 'L1' WHERE branch_id = ? AND id = ?", [IDS.branchMain, IDS.L2]);
    seed.db.run("UPDATE locations SET parent_location_id = 'L2' WHERE branch_id = ? AND id = ?", [IDS.branchMain, IDS.L1]);
    const broken = queryMapView(ctx, { kind: 'map', branchId: IDS.branchMain });
    assert.ok(
      broken.metadata.topologyIssues.some((issue) => issue.code === 'LOCATION_PARENT_CYCLE'),
      '作者视图必须暴露父环诊断',
    );
    assert.ok(
      broken.items.some((item) => item.topologyIssueCodes.length > 0),
      '坏图涉及的图行必须带 topologyIssueCodes',
    );
  } finally {
    seed.close();
  }
});

test('M2-06 inspect 只读诊断：坏图给明确错误，孤立/未知包含只给需推断提示（T03）', async () => {
  const { buildInspectDiagnostics } = await import('../src/atlas-sql-inspect.ts');
  const diag = buildInspectDiagnostics({
    branchId: 'b',
    rootMapId: 'M_world',
    mapRows: [
      { id: 'M_world', container_location_id: null, status: 'active' },
      { id: 'M_city', container_location_id: 'L_city', status: 'active' },
      { id: 'M_self', container_location_id: 'L_self', status: 'active' },
      // 同容器两张图在真实库里被部分唯一索引挡住，这里模拟旧档/手改档。
      { id: 'M_dup1', container_location_id: 'L_dup', status: 'active' },
      { id: 'M_dup2', container_location_id: 'L_dup', status: 'active' },
    ],
    locationRows: [
      { id: 'L_city', kind: 'city', parent_location_id: null, anchor_location_id: null, mobility: 'fixed', map_id: 'M_world', grid_x: 1, grid_y: 1, coord_precision: 'exact', area_geometry_json: null, name: '城', status: 'active' },
      { id: 'L_self', kind: 'room', parent_location_id: 'L_city', anchor_location_id: null, mobility: 'fixed', map_id: 'M_self', grid_x: 2, grid_y: 2, coord_precision: 'exact', area_geometry_json: null, name: '自容器房', status: 'active' },
      { id: 'L_dup', kind: 'district', parent_location_id: 'L_city', anchor_location_id: null, mobility: 'fixed', map_id: 'M_world', grid_x: 3, grid_y: 3, coord_precision: 'layout', area_geometry_json: null, name: '重复容器区', status: 'active' },
      // 无父地点却画在非根图上 → 未知包含（需推断）
      { id: 'L_orphan', kind: 'district', parent_location_id: null, anchor_location_id: null, mobility: 'fixed', map_id: 'M_city', grid_x: 4, grid_y: 4, coord_precision: 'layout', area_geometry_json: null, name: '孤儿区', status: 'active' },
      // 确认坐标落在父地点内图之外的坐标系 → 坐标迁移冲突
      { id: 'L_frame', kind: 'building', parent_location_id: 'L_city', anchor_location_id: null, mobility: 'fixed', map_id: 'M_world', grid_x: 5, grid_y: 5, coord_precision: 'exact', area_geometry_json: '{"kind":"polygon"}', name: '跨系建筑', status: 'active' },
    ],
    routeRows: [
      { id: 'R1', from_location_id: 'L_city', to_location_id: 'L_self' },
      // L_dup 与 L_orphan 之间没有路线 → 自成孤立分量（提示，不判错）
    ],
  });

  const codes = diag.topologyIssues.map((issue) => issue.code);
  assert.ok(codes.includes('AMBIGUOUS_CONTAINER_MAP'), '重复容器必须报错');
  assert.ok(codes.includes('MAP_SELF_CONTAINED'), '自容器图必须报错');
  assert.deepEqual(
    diag.topologyIssues.filter((issue) => issue.kind !== 'error'),
    [],
    '拓扑问题都算明确错误，不是「需推断」',
  );
  for (const issue of diag.topologyIssues) {
    assert.ok(issue.mapId || issue.locationId || issue.relatedIds.length > 0, `问题 ${issue.code} 必须带定位`);
  }
  assert.deepEqual([...diag.unlinkedMapIds].sort(), ['M_dup1', 'M_dup2', 'M_self']);

  // 未知包含：只给 warning + inference，绝不判 error（可能是合理的顶层区域）。
  assert.equal(diag.unknownContainment.length, 1);
  assert.equal(diag.unknownContainment[0].locationId, 'L_orphan');
  assert.equal(diag.unknownContainment[0].kind, 'inference');
  assert.equal(diag.unknownContainment[0].severity, 'warning');

  // 交通孤立分量：主分量 L_city/L_self；L_dup、L_orphan 各自孤立。
  assert.ok(diag.isolatedComponents.length >= 1, '必须识别出孤立分量');
  const flat = diag.isolatedComponents.flatMap((component) => component.locationIds);
  assert.ok(flat.includes('L_orphan'));
  for (const component of diag.isolatedComponents) {
    assert.equal(component.connectedToMain, false);
    assert.equal(component.size, component.locationIds.length);
  }

  // 坐标迁移冲突：只读甄别，带出当前系与应有系，交给作者决定是否变换。
  const conflict = diag.coordinateConflicts.find((entry) => entry.locationId === 'L_frame');
  assert.ok(conflict, '确认坐标跨系的地点必须被甄别出来');
  assert.equal(conflict.mapId, 'M_world');
  assert.equal(conflict.expectedMapId, 'M_city');
  assert.equal(conflict.hasArea, true);
  assert.ok(
    diag.coordinateConflicts.every((entry) => entry.mapId !== entry.expectedMapId),
    '只有「当前系 ≠ 应有系」才进冲突清单',
  );
});
