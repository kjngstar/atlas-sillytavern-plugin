/**
 * atlas-r10-scale-hints.test.mjs — R10 v2 mapScaleHints 接入提交链路测试。
 *
 * 对应主计划 R10 / 外部计划 M04-M05：
 * - v2 草稿的 mapScaleHints 由 atlas-turn-v2 转发到 AtlasV2TurnOutput.scaleHints
 * - atlas-server executeCommit 接到后，应用到 maps:<worldId> sidecar 的 calibrations
 * - applyScaleHintsToDoc 纯函数纪律：
 *   - 人工锁定值永不自动覆盖（skipped-locked）
 *   - frame 不匹配 / frameRevision 不匹配 → 跳过（skipped-frame-mismatch）
 *   - unknown / conflict / 数值校验不过 → 跳过（skipped-unknown / skipped-invalid）
 *   - 通过校验 → 写 calibrations[mapId]（applied）
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(resolve(root, p)).href);

const {
  applyScaleHintsToDoc,
  validateScaleResponse,
  computeScaleBar,
  formatDistanceMeters,
} = await imp("src/atlas-scale.ts");

function emptyDoc() {
  return { calibrations: {} };
}

function defaultFrame() {
  return { cols: 100, rows: 100, frameRevision: 1 };
}

// ---- T1：estimated + extentMeters 合法 → applied ----
test("R10-T1: estimated hint with valid extent applies to calibrations", () => {
  const doc = emptyDoc();
  const hint = {
    mapRef: "world",
    frameRevision: 1,
    status: "estimated",
    extentMeters: { width: 1000, height: 1000 },
    basis: "估算：典型城镇范围",
    confidence: "medium",
    evidenceIds: [],
  };
  const results = applyScaleHintsToDoc([hint], doc, {
    existing: doc.calibrations,
    framesByMapId: { world: defaultFrame() },
    now: 1700000000000,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, "applied");
  assert.equal(doc.calibrations.world.metersPerCell, 10); // 1000 / 100
  assert.equal(doc.calibrations.world.source, "ai-estimated");
  assert.equal(doc.calibrations.world.locked, false);
  assert.equal(doc.calibrations.world.at, 1700000000000);
  assert.equal(doc.calibrations.world.revision, 1);
});

// ---- T2：unknown / conflict → skipped-unknown ----
test("R10-T2: unknown / conflict hints skip without writing", () => {
  const doc = emptyDoc();
  const unknownHint = { mapRef: "world", frameRevision: 1, status: "unknown", extentMeters: null, basis: "", confidence: "low", evidenceIds: [] };
  const conflictHint = { mapRef: "tavern", frameRevision: 1, status: "conflict", extentMeters: null, basis: "", confidence: "low", evidenceIds: [] };
  const results = applyScaleHintsToDoc([unknownHint, conflictHint], doc, {
    existing: doc.calibrations,
    framesByMapId: { world: defaultFrame(), tavern: defaultFrame() },
    now: 1,
  });
  assert.equal(results[0].outcome, "skipped-unknown");
  assert.equal(results[1].outcome, "skipped-unknown");
  assert.equal(Object.keys(doc.calibrations).length, 0, "calibrations 不应被写入");
});

// ---- T3：人工锁定值不被覆盖 ----
test("R10-T3: locked human calibration is not overwritten", () => {
  const doc = {
    calibrations: {
      world: {
        revision: 3,
        metersPerCell: 25,
        source: "user",
        locked: true,
        basis: "人工标定",
        coverage: "",
        confidence: "",
        at: 1,
      },
    },
  };
  const hint = {
    mapRef: "world",
    frameRevision: 1,
    status: "estimated",
    extentMeters: { width: 500, height: 500 },
    basis: "AI 想改",
    confidence: "high",
    evidenceIds: [],
  };
  const results = applyScaleHintsToDoc([hint], doc, {
    existing: doc.calibrations,
    framesByMapId: { world: defaultFrame() },
    now: 2,
  });
  assert.equal(results[0].outcome, "skipped-locked");
  assert.equal(doc.calibrations.world.metersPerCell, 25, "锁定值不变");
  assert.equal(doc.calibrations.world.revision, 3, "revision 不变");
});

// ---- T4：frameRevision 不匹配 → 跳过 ----
test("R10-T4: frameRevision mismatch skips without writing", () => {
  const doc = emptyDoc();
  const hint = {
    mapRef: "world",
    frameRevision: 5,
    status: "estimated",
    extentMeters: { width: 1000, height: 1000 },
    basis: "AI 估计",
    confidence: "low",
    evidenceIds: [],
  };
  const results = applyScaleHintsToDoc([hint], doc, {
    existing: doc.calibrations,
    framesByMapId: { world: { cols: 100, rows: 100, frameRevision: 1 } },
    now: 1,
  });
  assert.equal(results[0].outcome, "skipped-frame-mismatch");
  assert.ok(results[0].reason.includes("frameRevision 不匹配"));
  assert.equal(Object.keys(doc.calibrations).length, 0);
});

// ---- T5：frameRevision=null 不做匹配校验 ----
test("R10-T5: frameRevision=null skips frame-revision check (0.9.51 兼容)", () => {
  const doc = emptyDoc();
  const hint = {
    mapRef: "world",
    frameRevision: null,
    status: "estimated",
    extentMeters: { width: 1000, height: 1000 },
    basis: "AI 估计",
    confidence: "low",
    evidenceIds: [],
  };
  const results = applyScaleHintsToDoc([hint], doc, {
    existing: doc.calibrations,
    framesByMapId: { world: defaultFrame() },
    now: 1,
  });
  assert.equal(results[0].outcome, "applied");
});

// ---- T6：未注册的 mapId → skipped-frame-mismatch ----
test("R10-T6: unregistered mapId skips (no frame known)", () => {
  const doc = emptyDoc();
  const hint = {
    mapRef: "ghost-map",
    frameRevision: 1,
    status: "estimated",
    extentMeters: { width: 1000, height: 1000 },
    basis: "AI 估计",
    confidence: "low",
    evidenceIds: [],
  };
  const results = applyScaleHintsToDoc([hint], doc, {
    existing: doc.calibrations,
    framesByMapId: { world: defaultFrame() }, // ghost-map 不在表
    now: 1,
  });
  assert.equal(results[0].outcome, "skipped-frame-mismatch");
  assert.ok(results[0].reason.includes("未注册 frame"));
});

// ---- T7：横纵每格距离超容差 → conflict ----
test("R10-T7: width/cols vs height/rows > 1% mismatch is rejected", () => {
  const doc = emptyDoc();
  const hint = {
    mapRef: "world",
    frameRevision: null,
    status: "estimated",
    extentMeters: { width: 1000, height: 500 }, // 10 m/格 vs 5 m/格 → 100% 差
    basis: "",
    confidence: "low",
    evidenceIds: [],
  };
  const results = applyScaleHintsToDoc([hint], doc, {
    existing: doc.calibrations,
    framesByMapId: { world: defaultFrame() },
    now: 1,
  });
  assert.equal(results[0].outcome, "skipped-unknown");
  assert.ok(results[0].reason.includes("横纵每格距离不一致"));
});

// ---- T8：revision 自增 ----
test("R10-T8: revision increments on each applied hint", () => {
  const doc = {
    calibrations: {
      world: {
        revision: 7,
        metersPerCell: 5,
        source: "ai-estimated",
        locked: false,
        basis: "首次",
        coverage: "",
        confidence: "low",
        at: 0,
      },
    },
  };
  const hint = {
    mapRef: "world",
    frameRevision: null,
    status: "estimated",
    extentMeters: { width: 1000, height: 1000 },
    basis: "二次",
    confidence: "high",
    evidenceIds: [],
  };
  applyScaleHintsToDoc([hint], doc, {
    existing: doc.calibrations,
    framesByMapId: { world: defaultFrame() },
    now: 2,
  });
  assert.equal(doc.calibrations.world.revision, 8);
});

// ---- T9：validateScaleResponse 拒绝负值 / 零 / 字符串伪数值 ----
test("R10-T9: validateScaleResponse rejects bad numerics", () => {
  // 直接调函数做契约测试
  const bad1 = validateScaleResponse({ status: "estimated", extentMeters: { width: 0, height: 100 }, coverage: "", basis: "" }, { cols: 100, rows: 100 });
  assert.equal(bad1.ok, false);
  assert.equal(bad1.status, "invalid");

  const bad2 = validateScaleResponse({ status: "estimated", extentMeters: { width: -10, height: 100 }, coverage: "", basis: "" }, { cols: 100, rows: 100 });
  assert.equal(bad2.ok, false);

  const bad3 = validateScaleResponse({ status: "estimated", extentMeters: { width: "100", height: 100 }, coverage: "", basis: "" }, { cols: 100, rows: 100 });
  assert.equal(bad3.ok, false);
  assert.ok(bad3.reason.includes("正的有限数字"));
});

// ---- T10：computeScaleBar 选标尺距离 ----
test("R10-T10: computeScaleBar picks distance in 80-160px window", () => {
  // 1 格 = 50 米，cellPx = 20px → 50/20 = 2.5 米/像素
  // 想让 100 米 → 100/2.5 = 40 px（窗外偏小），50 米 → 20 px（窗外）
  // 250 米 → 100 px（窗内首选附近）
  const result = computeScaleBar({ metersPerCell: 50, cellPx: 20, zoom: 1 });
  assert.ok(result !== null);
  assert.ok(result.barWidthPx >= 80 && result.barWidthPx <= 160, `标尺应在 80-160 px，actual=${result.barWidthPx}`);
});

// ---- T11：formatDistanceMeters 自动单位 ----
test("R10-T11: formatDistanceMeters auto unit", () => {
  assert.equal(formatDistanceMeters(0.5), "50 厘米");
  assert.equal(formatDistanceMeters(50), "50 米");
  assert.equal(formatDistanceMeters(1500), "1.5 公里");
  assert.equal(formatDistanceMeters(0), "");
  assert.equal(formatDistanceMeters(-1), "");
});