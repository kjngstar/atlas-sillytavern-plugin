/**
 * atlas-spatial-city-open.test.mjs — M4-27 验收（G07 · 水城与无墙城市）。
 *
 * 纪律：走真实 generateCity；断言落在可观察几何（wall/gates/roads/enclosure/river）与
 * checkSceneDocument 诊断，不 mock 布局求解器。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as Kit from '../vendor/atlas-spatial/index.mjs';

const SCOPE = { chatId: 'chat-1', branchId: 'b1', revision: 3, viewMode: 'author' };

const cityCtx = (over = {}) => ({
  scope: SCOPE,
  currentScope: SCOPE,
  map: { id: 'M_C', name: '城市', metersPerCell: 10, frame: { cols: 120, rows: 100 }, ...(over.map ?? {}) },
  entities: { locations: ['d1', 'd2', 'b1', 'b2'], characters: [], items: [], routes: [] },
  previousScene: over.previousScene ?? null,
});

const BASE = {
  districts: [
    { id: 'd1', name: '西城区', bank: 'west', order: 0 },
    { id: 'd2', name: '东城区', bank: 'east', order: 1 },
  ],
  buildings: [
    { id: 'b1', districtId: 'd1', name: '市场', w: 40, h: 30 },
    { id: 'b2', districtId: 'd2', name: '码头仓库', w: 36, h: 26 },
  ],
};

// ───────────────────────── G07-A · 新城市默认开放：不画假城墙 ─────────────────────────

test('G07：enclosure=open + riverWidth=0 → 无假城墙、无城门、无环城墙道路', () => {
  const result = Kit.generateCity({ ...BASE, enclosure: 'open', riverWidth: 0 }, cityCtx());
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const layout = result.scene.layout;

  assert.equal(layout.kind, 'city');
  assert.equal(layout.enclosure, 'open', '开放城市必须显式标 open');
  assert.deepEqual(layout.wall, [], '开放城市不得画城墙多边形');
  assert.deepEqual(layout.gates, [], '开放城市不得画城门');
  assert.equal(layout.river, null, 'riverWidth=0 时不得塞河');
  assert.deepEqual(layout.riverPolygon, []);
  assert.equal(layout.dock, null);
  assert.deepEqual(Kit.checkSceneDocument(result.scene), []);

  // 不得留下"环城墙道路"：open 城市只有连通干道，没有 ring / ring-access。
  const roadIds = layout.roads.map((r) => r.id);
  assert.equal(roadIds.some((id) => id === 'avenue'), true, '开放城市仍需一条连通干道');
  assert.equal(roadIds.some((id) => String(id).startsWith('ring')), false, `开放城市不得有环路：${JSON.stringify(roadIds)}`);

  // 道路仍可绘制：每条都有有限端点与正宽度。
  for (const road of layout.roads) {
    assert.ok(Number.isFinite(road.a.x) && Number.isFinite(road.b.x), `道路 ${road.id} 端点必须有限`);
    assert.ok(Number.isFinite(road.width) && road.width > 0, `道路 ${road.id} 宽度必须为正`);
  }

  // 城市仍要有实质内容：街区轮廓 + 真实建筑（装饰街区纹理另有其数，不算实体）。
  assert.equal(layout.districts.length, 2);
  assert.ok(layout.districts.every((d) => d.polygon.length >= 3));
  const realBuildings = layout.buildings.filter((b) => !b.decorative);
  assert.equal(realBuildings.length, 2, `两座登记建筑都要落下：${JSON.stringify(layout.buildings.map((b) => b.id))}`);
  assert.deepEqual(realBuildings.map((b) => b.id).sort(), ['b1', 'b2']);
  assert.ok(layout.buildings.some((b) => b.decorative === true), '装饰街区纹理可以有，但必须标 decorative');
  assert.equal(layout.origin === null || Number.isFinite(layout.origin.x), true);
});

test('G07：默认（省略 enclosure）的新城市也是开放边界，不再默认套墙', () => {
  const result = Kit.generateCity({ ...BASE, riverWidth: 0 }, cityCtx());
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.scene.layout.enclosure, 'open', '新城市默认必须是 open（02 §6.3 步 7）');
  assert.deepEqual(result.scene.layout.wall, []);
  assert.deepEqual(result.scene.layout.gates, []);
});

// ───────────────────────── G07-B · wall 城市仍完整可用 ─────────────────────────

test('G07：enclosure=wall → 城墙与城门照常生成，并有环城墙道路', () => {
  const result = Kit.generateCity({ ...BASE, enclosure: 'wall', riverWidth: 0 }, cityCtx());
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const layout = result.scene.layout;

  assert.equal(layout.enclosure, 'wall');
  assert.ok(layout.wall.length >= 3, `有城墙的城市必须画墙：${layout.wall.length}`);
  for (const p of layout.wall) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), '城墙顶点必须有限');
  assert.ok(layout.gates.length >= 2, `城墙城市必须有城门：${layout.gates.length}`);
  assert.ok(layout.gates.every((g) => Number.isFinite(g.x) && Number.isFinite(g.y)), '城门坐标必须有限');
  assert.deepEqual(Kit.checkSceneDocument(result.scene), []);

  const roadIds = layout.roads.map((r) => r.id);
  assert.equal(roadIds.some((id) => String(id).startsWith('ring')), true, `城墙城市应保留环路：${JSON.stringify(roadIds)}`);
});

test('G07：wall + riverWidth>0 → 水域与码头齐备，无河时不得留残影', () => {
  const wet = Kit.generateCity({ ...BASE, enclosure: 'wall', riverWidth: 40 }, cityCtx());
  assert.equal(wet.ok, true, JSON.stringify(wet.issues));
  const layout = wet.scene.layout;
  assert.ok(layout.river && Number.isFinite(layout.river.cx), '有河城市必须有河');
  assert.ok(layout.river.width > 0 && layout.river.height > 0);
  assert.ok(layout.riverPolygon.length >= 3, '河岸多边形必须可绘制');
  assert.ok(layout.dock && Number.isFinite(layout.dock.x), '有河必须有码头');
  assert.deepEqual(Kit.checkSceneDocument(wet.scene), []);

  const dry = Kit.generateCity({ ...BASE, enclosure: 'wall', riverWidth: 0 }, cityCtx());
  assert.equal(dry.ok, true);
  assert.equal(dry.scene.layout.river, null);
  assert.equal(dry.scene.layout.dock, null);
  assert.deepEqual(dry.scene.layout.riverPolygon, []);
  assert.deepEqual(Kit.checkSceneDocument(dry.scene), []);
});

// ───────────────────────── G07-C · 旧档不被升级拆墙 ─────────────────────────

test('G07：旧档 spec 无 enclosure 且旧场景约束里也没有 → 保持原有城墙输出', () => {
  // 先造一个有墙的旧档，模拟升级前保存的城市。
  const walled = Kit.generateCity({ ...BASE, enclosure: 'wall', riverWidth: 0 }, cityCtx());
  assert.equal(walled.ok, true, JSON.stringify(walled.issues));
  const legacyScene = Kit.clone(walled.scene);
  // 升级前的约束里根本没有 enclosure 这个键。
  delete legacyScene.constraints.enclosure;
  assert.equal('enclosure' in legacyScene.constraints, false);

  // 新代码处理旧档：不给 enclosure → 必须按旧行为继续出墙，不许突然拆掉旧城墙。
  const upgraded = Kit.generateCity({ ...BASE, riverWidth: 0 }, cityCtx({ previousScene: legacyScene }));
  assert.equal(upgraded.ok, true, JSON.stringify(upgraded.issues));
  assert.equal(upgraded.scene.layout.enclosure, 'wall', '旧档必须保持 wall，而不是被升级改成 open');
  assert.ok(upgraded.scene.layout.wall.length >= 3, '旧城墙不得消失');
  assert.ok(upgraded.scene.layout.gates.length >= 2, '旧城门不得消失');
  // 旧档的墙几何逐点不变。
  assert.deepEqual(upgraded.scene.layout.wall, walled.scene.layout.wall, '旧城墙几何不得因升级重排');
  assert.deepEqual(Kit.checkSceneDocument(upgraded.scene), []);
});

test('G07：非法 enclosure 值 → 记诊断并按既有/默认策略处理，不写坏场景', () => {
  const result = Kit.generateCity({ ...BASE, enclosure: 'fortress', riverWidth: 0 }, cityCtx());
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.ok(result.issues.some((i) => i.code === 'ENCLOSURE_INVALID'), JSON.stringify(result.issues));
  assert.ok(['open', 'wall'].includes(result.scene.layout.enclosure), '必须落到合法枚举之一');
  assert.deepEqual(Kit.checkSceneDocument(result.scene), []);
});

// ───────────────────────── 稳定性：同一输入可复现、增量不重排 ─────────────────────────

test('G07：开放城市同一输入字节级可复现；增加建筑不重排既有街区', () => {
  const first = Kit.generateCity({ ...BASE, enclosure: 'open', riverWidth: 0 }, cityCtx());
  const rerun = Kit.generateCity({ ...BASE, enclosure: 'open', riverWidth: 0 }, cityCtx());
  assert.deepEqual(rerun.scene.layout, first.scene.layout, '同一输入必须可复现');

  const grown = Kit.generateCity(
    { ...BASE, enclosure: 'open', riverWidth: 0, buildings: [BASE.buildings[0]] },
    cityCtx({ previousScene: first.scene, map: { id: 'M_C' } }),
  );
  assert.equal(grown.ok, true, JSON.stringify(grown.issues));
  assert.equal(grown.scene.layout.enclosure, 'open', '增量更新不得把开放城市改回墙城');
  assert.deepEqual(grown.scene.layout.wall, []);
  for (const before of first.scene.layout.districts) {
    const after = grown.scene.layout.districts.find((d) => d.id === before.id);
    assert.ok(after, `街区 ${before.id} 不得消失`);
    assert.deepEqual(after.polygon, before.polygon, `街区 ${before.id} 不得因增量而重排`);
  }
});
