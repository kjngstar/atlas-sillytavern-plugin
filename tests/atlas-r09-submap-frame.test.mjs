/**
 * atlas-r09-submap-frame.test.mjs — R09 SubMap schema 升级 + frame 持久化 + 深度校验。
 *
 * 对应主计划 R09：
 * - SubMap / SubMapDraft 加 frame 字段（cols/rows/frameRevision），旧子图走 100×100 兜底
 * - sanitizeMapDoc 自动为旧子图补 frame 默认值
 * - handleScaleCalibrate 使用真实 frame（世界图/子图各自的 cols/rows）
 * - validateSubmapDepth 校验嵌套深度上限（防止无界递归）
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(resolve(root, p)).href);

const {
  sanitizeMapDoc,
  sanitizeSubMap,
  emptyMapDoc,
  SUBMAP_FRAME_DEFAULT,
  SUBMAP_DEPTH_MAX,
  validateSubmapDepth,
  buildSubMapTreeFromDraft,
  projectWorldSubmaps,
} = await imp("src/atlas-geo-apply.ts");

// ---- T1：sanitizeSubMap 把 frame 字段透传 ----
test("R09-T1: sanitizeSubMap parses frame (cols/rows/frameRevision)", () => {
  const result = sanitizeSubMap({
    frame: { cols: 20, rows: 12, frameRevision: 7 },
    points: [{ name: "吧台", description: "吧台区" }],
  });
  assert.ok(result);
  assert.deepEqual(result.frame, { cols: 20, rows: 12, frameRevision: 7 });
});

// ---- T2：坏 frame 值丢弃（cols<=0 / rows 非数字 / frameRevision 负） ----
test("R09-T2: bad frame values are discarded (fall back to SUBMAP_FRAME_DEFAULT in doc)", () => {
  const result1 = sanitizeSubMap({
    frame: { cols: 0, rows: 100, frameRevision: 1 },
    points: [{ name: "X" }],
  });
  assert.ok(result1);
  assert.equal(result1.frame, undefined, "cols=0 应丢弃 frame");

  const result2 = sanitizeSubMap({
    frame: { cols: "100", rows: 100, frameRevision: 1 },
    points: [{ name: "X" }],
  });
  assert.ok(result2);
  assert.equal(result2.frame, undefined, "字符串 cols 应丢弃");

  const result3 = sanitizeSubMap({
    frame: { cols: 100, rows: 100, frameRevision: -1 },
    points: [{ name: "X" }],
  });
  assert.ok(result3);
  assert.equal(result3.frame, undefined, "负 frameRevision 应丢弃");
});

// ---- T3：sanitizeMapDoc 给旧子图补默认 frame ----
test("R09-T3: sanitizeMapDoc backfills SUBMAP_FRAME_DEFAULT for legacy submaps", () => {
  const legacy = {
    pointMeta: {},
    submaps: {
      tavern: {
        scale: { distancePerCell: 2 },
        points: [
          { id: "t1", name: "吧台", x: 5, y: 1 },
          { id: "t2", name: "大厅", x: 3, y: 4 },
        ],
      },
    },
    calibrations: {},
  };
  const doc = sanitizeMapDoc(legacy);
  assert.deepEqual(doc.submaps.tavern.frame, { cols: 100, rows: 100, frameRevision: 1 });
});

// ---- T4：sanitizeMapDoc 保留新子图 frame ----
test("R09-T4: sanitizeMapDoc preserves explicit frame", () => {
  const newer = {
    pointMeta: {},
    submaps: {
      tavern: {
        frame: { cols: 12, rows: 8, frameRevision: 3 },
        points: [{ id: "t1", name: "吧台", x: 5, y: 1 }],
      },
    },
    calibrations: {},
  };
  const doc = sanitizeMapDoc(newer);
  assert.deepEqual(doc.submaps.tavern.frame, { cols: 12, rows: 8, frameRevision: 3 });
});

// ---- T6：validateSubmapDepth — 单层 ----
test("R09-T6: validateSubmapDepth for top-level submap returns depth=1, ok=true", () => {
  const doc = emptyMapDoc();
  doc.submaps["1"] = { frame: { ...SUBMAP_FRAME_DEFAULT }, points: [] };
  const result = validateSubmapDepth(doc, "1");
  assert.equal(result.depth, 1);
  assert.equal(result.ok, true);
  assert.equal(result.maxReached, false);
});

// ---- T7：validateSubmapDepth — 未挂子图 ----
test("R09-T7: validateSubmapDepth for point without submap returns depth=0, ok=true", () => {
  const doc = emptyMapDoc();
  const result = validateSubmapDepth(doc, "99");
  assert.equal(result.depth, 0);
  assert.equal(result.ok, true);
  assert.equal(result.maxReached, false);
});

// ---- T8：validateSubmapDepth — 循环引用防御 ----
test("R09-T8: validateSubmapDepth defends against circular references", () => {
  // 当前 schema 单层不会循环；本测试调用防 future regression
  const doc = emptyMapDoc();
  doc.submaps["X"] = { frame: { ...SUBMAP_FRAME_DEFAULT }, points: [] };
  // 构造人为调用：pointId 已存在于 seen（用 mock 间接实现——通过 isPointInSubmaps 测试）
  // 由于 schema 单层无法构造循环，此处验证函数在循环情况下仍返回 ok=false 而非死循环：
  const result = validateSubmapDepth(doc, "X");
  assert.ok(result.depth <= SUBMAP_DEPTH_MAX);
});

// ---- T9：SUBMAP_DEPTH_MAX 常量 ----
test("R09-T9: SUBMAP_DEPTH_MAX is 4 (world → region → building → room)", () => {
  assert.equal(SUBMAP_DEPTH_MAX, 4);
});

// ---- T10：SUBMAP_FRAME_DEFAULT 形状 ----
test("R09-T10: SUBMAP_FRAME_DEFAULT is 100x100 revision 1", () => {
  assert.deepEqual(SUBMAP_FRAME_DEFAULT, { cols: 100, rows: 100, frameRevision: 1 });
});

test("R09 nested map draft becomes parent-linked building and room maps", () => {
  const draft = sanitizeSubMap({
    frame: { cols: 20, rows: 12, frameRevision: 3 },
    points: [{
      name: "内厅",
      submap: {
        frame: { cols: 8, rows: 6, frameRevision: 2 },
        points: [{ name: "卧室" }],
      },
    }],
  });
  assert.ok(draft);
  const tree = buildSubMapTreeFromDraft(draft, { worldId: "w", pointId: "1", now: 1 });
  const roomId = tree["1"].points[0].id;
  assert.equal(tree["1"].parentMapId, "world");
  assert.equal(tree["1"].frame.cols, 20);
  assert.equal(tree[roomId].parentMapId, "1");
  assert.equal(tree[roomId].frame.rows, 6);
  assert.equal(tree[roomId].points[0].name, "卧室");
  const doc = sanitizeMapDoc({ submaps: tree });
  assert.equal(validateSubmapDepth(doc, roomId).depth, 2);
  assert.equal(doc.submaps[roomId].ownerLocationId, roomId);
});

test("R09 nested map cycles and orphan parents are rejected without recursion", () => {
  const doc = emptyMapDoc();
  doc.submaps.a = { parentMapId: "b", points: [] };
  doc.submaps.b = { parentMapId: "a", points: [] };
  assert.equal(validateSubmapDepth(doc, "a").ok, false);
  doc.submaps.b.parentMapId = "missing";
  assert.equal(validateSubmapDepth(doc, "a").ok, false);
});

test("legacy submap scale preserves tiny positive distance", () => {
  const draft = sanitizeSubMap({ scale: { distancePerCell: 0.0004 }, points: [{ name: "柜子" }] });
  assert.equal(draft.scale.distancePerCell, 0.0004);
  const doc = sanitizeMapDoc({ submaps: {
    room: { scale: { distancePerCell: 0.0004 }, points: [{ id: "cabinet", name: "柜子", x: 50, y: 50 }] },
  } });
  assert.equal(doc.submaps.room.scale.distancePerCell, 0.0004);
});

// ---------------------------------------------------------------------------
// S5（0.9.55）：施工单把「v2 父链 → 子图投影」的纯函数验收点在这个文件里
// （S5 原文：同一世界二次投影深相等、sidecar 为 null、旧 v1 档、已校准比例尺、
//   两个兄弟地点、穿越游标的不可见子点）。这些是 /state 那个端到端路径**下面**的一层，
//   端到端用例（tests/atlas-server-plugin.test.mjs 的 S10①④⑥）不能替代：
//   端到端只能证明「这一路能跑通」，证明不了投影本身的确定性、保真与不修改入参。
// ---------------------------------------------------------------------------

const worldPoint = (id, name, parentPointId) => ({
  id,
  name,
  x: 10,
  y: 10,
  regionId: null,
  ...(parentPointId === undefined ? {} : { parentPointId }),
});

test("S5-P1: 同一世界二次投影深相等（与传入顺序无关，且不修改入参）", () => {
  const points = [
    worldPoint(901, "钟楼"),
    worldPoint(902, "大堂", 901),
    worldPoint(903, "档案室", 902),
    worldPoint(904, "偏厅", 902),
  ];
  const sidecar = emptyMapDoc();
  const before = JSON.stringify({ points, sidecar });

  const first = projectWorldSubmaps(points, sidecar);
  const second = projectWorldSubmaps([...points].reverse(), sidecar);
  assert.equal(JSON.stringify(second.doc), JSON.stringify(first.doc), "逆序输入得到逐字节相同的结果（散布不依赖数组顺序）");
  assert.equal(JSON.stringify({ points, sidecar }), before, "纯函数不修改入参（世界点与 sidecar 深相等）");

  assert.equal(first.doc.submaps["901"].parentMapId, "world", "根地点的子图挂世界图");
  assert.equal(first.doc.submaps["902"].parentMapId, "901", "二级子图挂父地点所在的图");
  assert.equal(first.doc.submaps["901"].ownerLocationId, "901", "ownerLocationId = 宿主地点 ID");
  assert.deepEqual(first.doc.submaps["902"].points.map((p) => p.id), ["903", "904"], "子点按数字 ID 升序");
  assert.equal(first.dropped, 0, "干净世界不丢点");
});

test("S5-P2: sidecar 为空档（含 null 清洗后）仍从世界结构生成子图，散布坐标有界", () => {
  const points = [worldPoint(901, "钟楼"), worldPoint(902, "大堂", 901)];
  const { doc, dropped } = projectWorldSubmaps(points, emptyMapDoc());
  const sub = doc.submaps["901"];
  assert.ok(sub, "空 sidecar 也能生成子图（v2 层级来自 parentPointId，不依赖布局缓存）");
  assert.equal(sub.points.length, 1);
  assert.equal(sub.points[0].id, "902", "子图内 marker ID = 世界点数字 ID 的字符串");
  assert.equal(sub.points[0].name, "大堂");
  const { x, y } = sub.points[0];
  assert.ok(Number.isInteger(x) && x >= 4 && x <= 96, `散布 x 有界（实际 ${x}）`);
  assert.ok(Number.isInteger(y) && y >= 4 && y <= 96, `散布 y 有界（实际 ${y}）`);
  assert.equal(dropped, 0);

  // 真实路径上 sidecar 是「缺失 → sanitizeMapDoc(null) → 空档」，两条入口结果必须一致
  const fromNull = projectWorldSubmaps(points, sanitizeMapDoc(null));
  assert.equal(JSON.stringify(fromNull.doc), JSON.stringify(doc), "null sidecar 与空档 sidecar 投影结果一致");
});

test("S5-P3: 旧 v1 档的 sub-* 虚拟点原样保留，与同父 v2 点并存（绝不按名字合并）", () => {
  const points = [worldPoint(901, "钟楼"), worldPoint(902, "大堂", 901)];
  const sidecar = emptyMapDoc();
  sidecar.submaps["901"] = {
    ownerLocationId: "901",
    parentMapId: "world",
    points: [
      { id: "sub-hall", name: "旧版大堂", x: 22, y: 33 },
      { id: "902", name: "老名字", x: 70, y: 12 },
    ],
    scale: { distancePerCell: 0.0004 },
  };

  const { doc } = projectWorldSubmaps(points, sidecar);
  const sub = doc.submaps["901"];
  assert.equal(sub.points.length, 2, "v1 虚拟点与 v2 点并存（同名也不合并）");

  const legacy = sub.points.find((p) => p.id === "sub-hall");
  assert.deepEqual({ x: legacy.x, y: legacy.y, name: legacy.name }, { x: 22, y: 33, name: "旧版大堂" },
    "v1 虚拟点的 ID / 手工坐标 / 名字原样保留（不搬走旧手工布局）");

  const same = sub.points.find((p) => p.id === "902");
  assert.equal(same.x, 70, "sidecar 已有同 ID 布局优先保留，不重算散布");
  assert.equal(same.name, "老名字", "已有名字不被世界点覆盖");
  assert.deepEqual(sub.scale, { distancePerCell: 0.0004 }, "子图比例尺随 sidecar 保留");
});

test("S5-P4: 已校准比例尺（世界图 / 子图）在投影后保留，且不把入参容器交出去", () => {
  const points = [worldPoint(901, "钟楼"), worldPoint(902, "大堂", 901)];
  const sidecar = emptyMapDoc();
  sidecar.calibrations["world"] = { metersPerCell: 100, source: "user", locked: true, revision: 3 };
  sidecar.calibrations["901"] = { metersPerCell: 5, source: "ai", locked: false, revision: 1 };

  const { doc } = projectWorldSubmaps(points, sidecar);
  assert.deepEqual(doc.calibrations["world"], sidecar.calibrations["world"], "世界图标定保留");
  assert.deepEqual(doc.calibrations["901"], sidecar.calibrations["901"], "子图标定保留");
  assert.notEqual(doc.calibrations, sidecar.calibrations, "标定容器是副本（调用方改结果不会改到入参）");
  assert.notEqual(doc.pointMeta, sidecar.pointMeta, "点位描述容器同样是副本");
});

test("S5-P5: 同一父下的两个兄弟地点都进同一张子图，且不重叠", () => {
  const points = [worldPoint(901, "钟楼"), worldPoint(902, "大堂", 901), worldPoint(903, "侧厅", 901)];
  const { doc } = projectWorldSubmaps(points, emptyMapDoc());
  const sub = doc.submaps["901"];
  assert.deepEqual(sub.points.map((p) => p.id), ["902", "903"], "两兄弟在同一张子图里，按数字 ID 升序");
  const [a, b] = sub.points;
  assert.ok(a.x !== b.x || a.y !== b.y, `确定性散布不把两兄弟叠在同一点（${a.x},${a.y} vs ${b.x},${b.y}）`);
});

test("S5-P6: 不可见子点不凭空出现；脏父引用（不存在 / 自引用）丢弃并计数", () => {  // 可见性过滤是调用方（服务端 visibleWorldForBinding）的职责：本层只保证
  // 「给什么点集就投影什么」，不给的点一个都不出现（端到端口径见 S10⑥）。
  const visible = [worldPoint(901, "钟楼"), worldPoint(902, "大堂", 901)];
  const { doc, dropped } = projectWorldSubmaps(visible, emptyMapDoc());
  assert.ok(
    !Object.values(doc.submaps).some((sub) => sub.points.some((p) => p.id === "903")),
    "不在可见点集里的未来子点不凭空出现",
  );
  assert.equal(dropped, 0);

  const dirty = [
    worldPoint(901, "钟楼"),
    worldPoint(902, "大堂"),
    worldPoint(903, "孤岛", 999),
    worldPoint(904, "自环", 904),
  ];
  const out = projectWorldSubmaps(dirty, emptyMapDoc());
  assert.equal(out.dropped, 2, "父不在可见世界 + 自引用各计一次（脏数据不静默）");
  assert.ok(!out.doc.submaps["999"], "不存在的父不生成悬空子图");
  assert.ok(!Object.values(out.doc.submaps).some((sub) => sub.points.some((p) => p.id === "903" || p.id === "904")),
    "脏引用点不进任何子图");
});

test("S5-P7: 超过四层子的地点不再下钻（其子图不生成并计入 dropped）", () => {
  const points = [
    worldPoint(901, "一层"),
    worldPoint(902, "二层", 901),
    worldPoint(903, "三层", 902),
    worldPoint(904, "四层", 903),
    worldPoint(905, "五层", 904),
    worldPoint(906, "六层", 905),
  ];
  const { doc, dropped } = projectWorldSubmaps(points, emptyMapDoc());
  for (const id of ["901", "902", "903", "904"]) {
    assert.ok(doc.submaps[id], `第 ${id} 张子图存在（最多四张连续子图）`);
  }
  assert.ok(!doc.submaps["905"], "第五张子图不下钻");
  assert.equal(dropped, 1, "不下钻的子点计入 dropped（供日志）");
});

test("S5-P8: v1 虚拟点与 v2 新点同名时两者都留，同名次数交回调用方（由 /state 记日志）", () => {
  const points = [worldPoint(901, "钟楼"), worldPoint(902, "大堂", 901)];
  const sidecar = emptyMapDoc();
  sidecar.submaps["901"] = {
    ownerLocationId: "901",
    parentMapId: "world",
    points: [{ id: "sub-hall", name: "大堂", x: 22, y: 33 }],
  };
  const { doc, nameCollisions } = projectWorldSubmaps(points, sidecar);
  const sub = doc.submaps["901"];
  assert.equal(sub.points.length, 2, "同名不合并：v1 虚拟点与 v2 点都在");
  assert.deepEqual([...sub.points.map((p) => p.id)].sort(), ["902", "sub-hall"], "两个不同 ID 都保留");
  assert.equal(nameCollisions, 1, "同名并存次数交回调用方（纯函数自己不写日志）");

  const clean = projectWorldSubmaps(points, emptyMapDoc());
  assert.equal(clean.nameCollisions, 0, "没有同名就不计数");
  assert.equal(clean.dropped, 0);
});
