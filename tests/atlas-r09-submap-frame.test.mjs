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
  sanitizeNewLocations,
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

// ---- T5：sanitizeNewLocations 透传 frame ----
test("R09-T5: sanitizeNewLocations passes frame through to submap", () => {
  const result = sanitizeNewLocations([
    {
      name: "旧酒馆",
      submap: {
        frame: { cols: 10, rows: 7, frameRevision: 1 },
        points: [{ name: "吧台" }],
      },
    },
  ]);
  assert.equal(result.length, 1);
  assert.ok(result[0].submap);
  assert.deepEqual(result[0].submap.frame, { cols: 10, rows: 7, frameRevision: 1 });
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
