/**
 * atlas-schema-parent-point.test.mjs — 0.9.55 S1：MapPoint.parentPointId 字段契约。
 *
 * 目的：v2 子图的父子关系权威来源是 World.points[].parentPointId（不是 maps sidecar）。
 * 本文件锁定三件事：
 * 1. 字段往返不丢（parseWorld 序列化 → 解析 → 再序列化稳定）；
 * 2. 只接受 null / 缺省 / 有限正整数，其余一律拒绝（含字符串、负数、0、小数、NaN、Infinity）；
 * 3. 老存档（无该字段）照常读取。
 *
 * 说明：lib/ 是 Atlasia 世界核心快照，本字段是其第 2 处蓄意偏差，见 lib/VENDORED.md。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseWorld, parseMapPoint } from "../lib/world-schema.ts";
import { buildWorldFromTemplate, getDemoTemplate } from "../lib/demo-events.ts";

function baseWorld() {
  const world = buildWorldFromTemplate(getDemoTemplate("chronicle"), { id: "s1-world", now: 1000 });
  const parsed = parseWorld(JSON.parse(JSON.stringify(world)));
  assert.ok(parsed, "夹具世界可解析");
  return parsed;
}

test("S1：parentPointId 往返不丢（缺省 / null / 正整数三种形态）", () => {
  const world = baseWorld();
  const withParent = {
    ...world,
    points: [
      { id: 1, name: "钟楼", x: 0, y: 0, regionId: null },                      // 缺省
      { id: 2, name: "大堂", x: 1, y: 1, regionId: null, parentPointId: 1 },     // 正整数
      { id: 3, name: "根点", x: 2, y: 2, regionId: null, parentPointId: null },  // 显式 null
    ],
  };
  const once = parseWorld(JSON.parse(JSON.stringify(withParent)));
  assert.ok(once, "带 parentPointId 的世界可解析");

  const p1 = once.points.find((p) => p.id === 1);
  const p2 = once.points.find((p) => p.id === 2);
  const p3 = once.points.find((p) => p.id === 3);
  assert.equal("parentPointId" in p1, false, "缺省点不凭空补字段");
  assert.equal(p2.parentPointId, 1, "正整数原样保留");
  assert.equal(p3.parentPointId, null, "显式 null 保留");

  // 二次往返稳定（不因重解析而被丢弃或改写）
  const twice = parseWorld(JSON.parse(JSON.stringify(once)));
  assert.ok(twice, "二次解析仍可解析");
  assert.deepEqual(
    twice.points.map((p) => [p.id, p.parentPointId ?? null]),
    [[1, null], [2, 1], [3, null]],
    "二次往返后父链不变",
  );
});

test("S1：parseMapPoint 只接受 null / 缺省 / 有限正整数", () => {
  const shape = (extra) => ({ id: 7, name: "点", x: 0, y: 0, ...extra });

  for (const good of [undefined, null, 1, 42, 999999]) {
    const point = parseMapPoint(shape(good === undefined ? {} : { parentPointId: good }));
    assert.ok(point, `parentPointId=${String(good)} 应接受`);
  }

  for (const [label, bad] of [
    ["字符串数字", "1"],
    ["非数字字符串", "abc"],
    ["负数", -1],
    ["零", 0],
    ["小数", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["布尔", true],
    ["对象", {}],
    ["数组", []],
  ]) {
    assert.equal(
      parseMapPoint(shape({ parentPointId: bad })),
      null,
      `parentPointId=${label} 必须拒绝（不做宽松转换）`,
    );
  }
});

test("S1：老存档（无 parentPointId 字段）照常读取且不报错", () => {
  const world = baseWorld();
  const legacy = {
    ...world,
    // 模拟 0.9.54 及更早的存档：points 完全没有父字段
    points: (world.points ?? []).map(({ parentPointId, ...rest }) => rest),
  };
  const parsed = parseWorld(JSON.parse(JSON.stringify(legacy)));
  assert.ok(parsed, "旧存档仍可解析");
  assert.ok(
    parsed.points.every((p) => p.parentPointId === undefined),
    "旧存档不被动补父字段",
  );
});
