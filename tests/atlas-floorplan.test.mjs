import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFloorplan, isBuildingScene } from '../src/atlas-floorplan.ts';
import { selectTaskBackground } from '../src/atlas-task-context.ts';

test('王宫已有寝殿时显示房间范围、通道与入口；布局不登记新地点', () => {
  const input = { name: '晨星王宫', cols: 100, rows: 100, children: [{ id: '2', name: '小公主寝殿' }] };
  const before = structuredClone(input);
  const plan = buildFloorplan(input);
  assert.equal(plan.regions.filter(area => area.childId).length, 1);
  assert.ok(plan.regions.length >= 4);
  assert.deepEqual(plan.passages.map(area => area.name), ['通道', '入口']);
  const room = plan.regions.find(area => area.childId === '2');
  const marker = plan.markers.find(point => point.id === '2');
  assert.ok(marker.x > room.x && marker.x < room.x + room.width);
  assert.ok(marker.y > room.y && marker.y < room.y + room.height);
  assert.deepEqual(input, before);
  assert.deepEqual(plan, buildFloorplan({ ...input, children: [...input.children].reverse() }));
});

test('建筑分区适配实际幅面，多房间不重叠且 ID 稳定', () => {
  for (const [cols, rows] of [[12, 8], [100, 60], [48, 120]]) {
    const children = Array.from({ length: 20 }, (_, i) => ({ id: String(i + 1), name: `房间${i}` }));
    const plan = buildFloorplan({ name: '教学楼', cols, rows, children });
    assert.equal(plan.markers.length, 20);
    assert.equal(new Set(plan.markers.map(point => `${point.x}|${point.y}`)).size, 20);
    assert.ok(plan.regions.every(area => area.x >= 0 && area.y >= 0 && area.x + area.width <= cols && area.y + area.height <= rows));
    assert.deepEqual(plan, buildFloorplan({ name: '教学楼', cols, rows, children: children.reverse() }));
  }
});

test('建筑里已确认的位置保持原坐标，范围包含它；房间与街道不套建筑布局', () => {
  const plan = buildFloorplan({ name: '晨星王宫', cols: 100, rows: 100, children: [{ id: '2', name: '正殿', x: 210, y: 130 }] });
  assert.equal(plan.markers.length, 0);
  const room = plan.regions[0];
  assert.equal(room.x + room.width / 2, 210);
  assert.equal(room.y + room.height / 2, 130);
  assert.ok(plan.bounds.x + plan.bounds.width > 210);
  assert.equal(buildFloorplan({ name: '小公主寝殿', cols: 100, rows: 100, children: [] }), null);
  assert.equal(isBuildingScene('商业街路口'), false);
  assert.equal(isBuildingScene('学校'), false);
});

test('背景摘录只选择任务事实，不改写连续原文，也不引入另一条模型调用', () => {
  const text = '<think>世界在推理标签里。</think>\n姓名：艾琳。她是一名教师。\n这座王宫位于城市北侧。\n今天的晚餐做法很复杂。';
  const selected = selectTaskBackground(text);
  assert.ok(selected.includes('姓名：艾琳。'));
  assert.ok(selected.includes('这座王宫位于城市北侧。'));
  assert.equal(selected.includes('晚餐'), false);
  assert.equal(selected.includes('推理标签'), false);
  assert.ok(selectTaskBackground(text, 25).length <= 25);
  assert.equal(selectTaskBackground('', 100), '');
});
