/**
 * atlas-r12-atomic-commit.test.mjs — R12 多文档原子提交与 pending 恢复测试。
 *
 * 对应《Atlas_剩余工作实施计划》阶段 B 与主计划 R12：
 * - 0.9.42 会话承载已让 world/binding/turn 落在同一 session 对象（单文档原子），
 *   唯一的全局 IO 残留是 pending.remove。R12 把 pending.remove 包 best-effort（失
 *   败记日志不抛错），并新增 reconcilePendingCommits 在启动时清 orphan。
 * - 本测试聚焦 reconcilePendingCommits 的单测（不依赖完整 prepare-commit 路由链路）：
 *   1. orphan pending（commit 已成功但 pending 没删）→ 清
 *   2. 合法 pending（commit 未完成）→ 保留
 *   3. malformed pending（数据损坏）→ 保留（宁可不删也别误删）
 *   4. rolledBack turn 不应被清（pending 可能合法供 retry）
 *   5. 同名多 chatId 各自独立清理
 *   6. store.read 失败时保留 pending 不删
 *
 * 端到端的"pending.remove 注入失败 → commit 仍 200" 由 R12 实施记录说明覆盖
 * （executeCommit 步骤 7 try/catch 包裹 + pushLog 警告），行为证据来自
 * logs() 输出，不在本测试重复构造完整世界 / 绑定 / 推演链路。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(resolve(root, p)).href);

const { createMemoryDocumentStore, createSessionOverlayStore, parseAtlasSessionDoc, parseAtlasSessionDocDetailed, cloneSessionDoc, ensureSessionTables } = await imp("src/atlas-server.ts");
const { buildWorldFromTemplate, getDemoTemplate } = await imp("lib/demo-events.ts");
const { parseWorld } = await imp("lib/world-schema.ts");
const { migrateLegacyToTables } = await imp("src/atlas-table-migration.ts");
const { atlasTablesFingerprint } = await imp("src/atlas-tables.ts");
const { reconcilePendingCommits, scanPendingEntries } = await imp("src/atlas-pending-reconcile.ts");

function newStore() {
  return createMemoryDocumentStore();
}

// ---- 测试 1：orphan pending 被清 ----
test("R12-T1: orphan pending (turn exists) is cleaned", async () => {
  const store = newStore();
  await store.write("pending:orphan-key-1", {
    binding: { chatId: "c1" },
    savedAt: 0,
    request: { chatId: "c1" },
  });
  await store.write("turn:c1:orphan-key-1", {
    schemaVersion: 1,
    receipt: { receiptId: "r1", status: "committed" },
  });

  const report = await reconcilePendingCommits(store);
  assert.equal(report.scanned, 1);
  assert.equal(report.cleaned, 1);
  assert.equal(report.kept, 0);
  assert.equal(report.errors.length, 0);
  const remaining = await store.list("pending:");
  assert.equal(remaining.length, 0);
});

// ---- 测试 2：合法 pending 保留 ----
test("R12-T2: legitimate pending (turn missing) is kept", async () => {
  const store = newStore();
  await store.write("pending:legit-key-1", {
    binding: { chatId: "c1" },
    savedAt: 0,
    request: { chatId: "c1" },
  });

  const report = await reconcilePendingCommits(store);
  assert.equal(report.scanned, 1);
  assert.equal(report.cleaned, 0);
  assert.equal(report.kept, 1);
  const remaining = await store.list("pending:");
  assert.deepEqual(remaining, ["pending:legit-key-1"]);
});

// ---- 测试 3：malformed pending 保留 ----
test("R12-T3: malformed pending is kept (better safe than sorry)", async () => {
  const store = newStore();
  await store.write("pending:bad-1", { garbage: true });                // 无 binding
  await store.write("pending:bad-2", { binding: { chatId: 123 } });     // chatId 非字符串
  await store.write("pending:bad-3", { binding: null });                // binding 为 null

  const report = await reconcilePendingCommits(store);
  assert.equal(report.scanned, 0, "malformed 不应进 entries");
  assert.equal(report.malformed, 3);
  assert.equal(report.cleaned, 0);
  assert.equal(report.kept, 0);
  const remaining = await store.list("pending:");
  assert.equal(remaining.length, 3, "malformed 全部保留");
});

// ---- 测试 4：rolledBack turn 不应被清（pending 合法供 retry） ----
test("R12-T4: rolledBack turn leaves pending alone (retry path may reuse)", async () => {
  const store = newStore();
  await store.write("pending:rb-key-1", {
    binding: { chatId: "c1" },
    savedAt: 0,
    request: { chatId: "c1" },
  });
  await store.write("turn:c1:rb-key-1", {
    schemaVersion: 1,
    rolledBack: true,
    receipt: { receiptId: "r1", status: "committed" },
  });

  const report = await reconcilePendingCommits(store);
  assert.equal(report.cleaned, 0, "rolledBack 不应触发 orphan 删除");
  assert.equal(report.kept, 1);
  const remaining = await store.list("pending:");
  assert.deepEqual(remaining, ["pending:rb-key-1"]);
});

// ---- 测试 5：多 chatId 各自独立 ----
test("R12-T5: multi-chat independent (orphan in chat-A, legit in chat-B)", async () => {
  const store = newStore();
  await store.write("pending:orphan-c1", { binding: { chatId: "c1" } });
  await store.write("turn:c1:orphan-c1", { schemaVersion: 1, receipt: { receiptId: "r" } });
  await store.write("pending:legit-c2", { binding: { chatId: "c2" } });
  // chat-c2 没有 turn 文档

  const report = await reconcilePendingCommits(store);
  assert.equal(report.scanned, 2);
  assert.equal(report.cleaned, 1);
  assert.equal(report.kept, 1);
  const remaining = await store.list("pending:");
  assert.deepEqual(remaining, ["pending:legit-c2"]);
});

// ---- 测试 6：store.read 失败时保留 pending ----
test("R12-T6: store.read failure on turn doc keeps pending + records error", async () => {
  const store = newStore();
  await store.write("pending:io-fail", { binding: { chatId: "c1" } });

  // 把 read 包成失败
  const origRead = store.read.bind(store);
  store.read = async (name) => {
    if (name.startsWith("turn:")) throw new Error("模拟 turn 文档 IO 失败");
    return origRead(name);
  };

  const report = await reconcilePendingCommits(store);
  assert.equal(report.kept, 1);
  assert.equal(report.cleaned, 0);
  assert.ok(report.errors.length >= 1, "应记录错误");
  assert.ok(report.errors[0].includes("模拟 turn 文档 IO 失败"));
  const remaining = await store.list("pending:");
  assert.deepEqual(remaining, ["pending:io-fail"]);
});

// ---- 测试 7：scanPendingEntries 自身可单元化 ----
test("R12-T7: scanPendingEntries returns parsed entries and counts malformed", async () => {
  const store = newStore();
  await store.write("pending:good-1", { binding: { chatId: "c1" } });
  await store.write("pending:good-2", { binding: { chatId: "c2" } });
  await store.write("pending:bad", { foo: 1 });
  await store.write("settings", { hello: "world" }); // 非 pending: 前缀应被过滤

  const { entries, malformed } = await scanPendingEntries(store);
  assert.equal(entries.length, 2);
  assert.equal(malformed, 1);
  const chatIds = entries.map((e) => e.chatId).sort();
  assert.deepEqual(chatIds, ["c1", "c2"]);
});

// ---- 测试 8：limit 选项限制处理量 ----
test("R12-T8: reconcilePendingCommits honors limit option", async () => {
  const store = newStore();
  for (let i = 0; i < 5; i++) {
    await store.write(`pending:k${i}`, { binding: { chatId: "c1" } });
    await store.write(`turn:c1:k${i}`, { schemaVersion: 1, receipt: { receiptId: `r${i}` } });
  }
  const report = await reconcilePendingCommits(store, { limit: 3 });
  assert.equal(report.scanned, 5);
  assert.equal(report.cleaned, 3, "limit 应限制处理量");
  const remaining = await store.list("pending:");
  assert.equal(remaining.length, 2, "未处理的 orphan pending 仍留着");
});
test("scene sidecar joins one session snapshot and legacy scene remains readable", async () => {
  const fallback = createMemoryDocumentStore();
  await fallback.write("scene:w1", { schemaVersion: 1, retiredPointIds: ["1"], lastConfirmed: null, bootstrap: null });
  const session = parseAtlasSessionDoc({
    schemaVersion: 1, rev: 4, world: { id: "w1" }, binding: { chatId: "c1" },
    maps: null, turns: {}, geoAuto: {},
  });
  const overlay = createSessionOverlayStore(session, fallback);
  const old = await overlay.read("scene:w1");
  assert.deepEqual(old.retiredPointIds, ["1"], "旧独立文档可只读回退");
  assert.equal(overlay.changed(), false, "读取不写会话");
  await overlay.write("scene:w1", { ...old, lastConfirmed: { branchId: null, pointId: "2", at: 9 } });
  assert.equal(overlay.changed(), true);
  assert.equal(session.scene.lastConfirmed.pointId, "2", "场景进入单会话快照");
  assert.equal((await fallback.read("scene:w1")).lastConfirmed, null, "旧文档不被顺手改写");
  await assert.rejects(() => overlay.write("scene:other", old), /场景文档与当前会话世界不一致/);
});

/* ================================================================== *
 * A05：会话文档携带三表 + 具名迁移错误
 * A06：覆盖层的 tables:<worldId> 读 / 写 / 移除
 * ================================================================== */

/** 合法三表快照夹具（A01 校验口径）。 */
function validTablesStore(worldId = "w1") {
  return {
    schemaVersion: 1,
    worldId,
    branches: {
      canon: {
        locations: [{
          id: "loc:1", name: "钟楼", parentLocationId: null, description: "", rumors: [], factions: [],
          mapId: "world", gridX: 3, gridY: 4,
        }],
        characters: [],
        items: [],
      },
    },
  };
}

function sessionRaw(overrides = {}) {
  return {
    schemaVersion: 1, rev: 3, world: { id: "w1" }, binding: { chatId: "c1" },
    maps: null, scene: null, turns: {}, geoAuto: {}, ...overrides,
  };
}

test("A05 旧会话（无 tables）解析行为不变", () => {
  const detailed = parseAtlasSessionDocDetailed(sessionRaw());
  assert.equal(detailed.session.tables, null);
  assert.equal(detailed.tablesError, null, "没有 tables 不是错误");
  assert.equal(detailed.session.rev, 3);
  assert.equal(parseAtlasSessionDoc(sessionRaw()).tables, null, "旧签名仍返回同一结果");
});

test("A05 合法 tables 进会话；损坏 tables 保持 null + 具名错误 + 原文保留", () => {
  const good = parseAtlasSessionDocDetailed(sessionRaw({ tables: validTablesStore("w1") }));
  assert.equal(good.tablesError, null, JSON.stringify(good.tablesError));
  assert.equal(good.session.tables.branches.canon.locations[0].id, "loc:1");

  const broken = validTablesStore("w1");
  broken.branches.canon.locations[0].gridX = null; // 格序号只填一半 → GRID_PARTIAL
  const raw = sessionRaw({ rev: 7, turns: { "turn:c1:k": { a: 1 } }, tables: broken });
  const parsed = parseAtlasSessionDocDetailed(raw);
  assert.equal(parsed.session.tables, null, "损坏的 tables 绝不进引擎");
  assert.deepEqual(parsed.tablesError, {
    code: "TABLE_SESSION_CORRUPT",
    path: '$.branches["canon"].locations[0].gridX',
  });
  assert.equal(parsed.session.world.id, "w1", "其余会话字段照常解析，不清成空世界");
  assert.equal(parsed.session.turns["turn:c1:k"].a, 1);
  assert.equal(parsed.raw, raw, "原文原样带出，供「保留旧数据 + 明确提示」使用");
  assert.equal(parsed.rawTables, broken, "未通过校验的原始 tables 也保留，供导出排障");
});

test("A05 跨世界 / 缺世界的 tables 都拒绝且各有具名错误", () => {
  const cross = parseAtlasSessionDocDetailed(sessionRaw({ tables: validTablesStore("w2") }));
  assert.equal(cross.session.tables, null);
  assert.equal(cross.tablesError.code, "TABLE_SESSION_WORLD_MISMATCH");
  assert.equal(cross.tablesError.path, "$.worldId");

  const noWorld = parseAtlasSessionDocDetailed(sessionRaw({ world: null, tables: validTablesStore("w1") }));
  assert.equal(noWorld.session.tables, null);
  assert.equal(noWorld.tablesError.code, "TABLE_SESSION_NO_WORLD");

  const legacySchema = parseAtlasSessionDocDetailed({ schemaVersion: 99, world: { id: "w1" }, tables: validTablesStore("w1") });
  assert.equal(legacySchema.session.rev, 0, "schemaVersion 不匹配仍走旧宽容路径");
  assert.equal(legacySchema.session.tables, null);
  assert.equal(legacySchema.rawTables !== undefined, true, "原文里的 tables 照样带出");
});

test("A05 cloneSessionDoc 覆盖 tables（深拷贝、不共享引用）", () => {
  const parsed = parseAtlasSessionDocDetailed(sessionRaw({ tables: validTablesStore("w1") }));
  const clone = cloneSessionDoc(parsed.session);
  assert.deepEqual(clone.tables, parsed.session.tables);
  clone.tables.branches.canon.locations[0].name = "改名";
  assert.equal(parsed.session.tables.branches.canon.locations[0].name, "钟楼", "克隆体与原件不共享引用");
});

test("A06 覆盖层：tables:<worldId> 读 / 写 / 移除 + changed() 与 list", async () => {
  const fallback = createMemoryDocumentStore();
  const session = parseAtlasSessionDoc(sessionRaw({ tables: validTablesStore("w1") }));
  const overlay = createSessionOverlayStore(session, fallback);

  const read = await overlay.read("tables:w1");
  assert.equal(read.branches.canon.locations[0].name, "钟楼");
  assert.equal(await overlay.read("tables:w2"), null, "别的世界读不到");
  assert.equal(overlay.changed(), false, "读取不标记变更");

  await overlay.write("tables:w1", validTablesStore("w1"));
  assert.equal(overlay.changed(), true, "写会话键必须标记变更");
  assert.equal(session.tables.branches.canon.locations.length, 1);

  await assert.rejects(() => overlay.write("tables:w2", validTablesStore("w2")), /世界不一致/);
  await assert.rejects(() => overlay.write("tables:w1", validTablesStore("w9")), /worldId/);

  assert.deepEqual(await overlay.list("tables:"), ["tables:w1"]);

  await overlay.remove("tables:w1");
  assert.equal(session.tables, null);
  assert.equal(await overlay.read("tables:w1"), null);
  assert.equal((await overlay.list("tables:")).length, 0);
});

/* ================================================================== *
 * A08：真实旧会话的懒迁移入口
 * ================================================================== */

/** 合法旧会话夹具：chronicle 世界 + 绑定，没有 tables。 */
function legacySessionFixture(overrides = {}) {
  const world = parseWorld(JSON.parse(JSON.stringify(
    buildWorldFromTemplate(getDemoTemplate("chronicle"), { id: "w-mig", now: 1000 }),
  )));
  assert.ok(world, "夹具世界可解析");
  const binding = {
    schemaVersion: 1, enabled: true, chatId: "c1", characterId: null,
    worldId: "w-mig", branchId: null, currentLocationId: "4103", worldTimeCursor: 418.12,
    lastCommittedMessageId: null, lastCheckpointId: null,
    ...overrides.binding,
  };
  const raw = {
    schemaVersion: 1, rev: 2, world: JSON.parse(JSON.stringify(world)), binding,
    maps: null, scene: null, turns: {}, geoAuto: {}, ...overrides.raw,
  };
  return { world, binding, raw };
}

async function runEnsure(fixture, options = {}) {
  const store = options.store ?? createMemoryDocumentStore();
  const raw = options.raw ?? fixture.raw;
  const parsed = parseAtlasSessionDocDetailed(raw);
  const overlay = createSessionOverlayStore(parsed.session, store);
  const diagnostics = [];
  const outcome = await ensureSessionTables({
    session: parsed.session,
    parse: parsed,
    overlay,
    store,
    now: () => 1_700_000_000_000,
    onDiagnostic: (event) => diagnostics.push(event),
  });
  return { parsed, overlay, outcome, diagnostics, store };
}

test("A08 旧会话懒迁移：挂到会话、只读请求不推 rev、写请求随响应落盘", async () => {
  const fixture = legacySessionFixture();
  const { parsed, overlay, outcome, diagnostics } = await runEnsure(fixture);

  assert.equal(outcome.status, "migrated", JSON.stringify(outcome));
  assert.equal(outcome.branchKey, "canon", "正史基线用保留键 canon");
  assert.equal(overlay.changed(), false, "纯读路径不得因迁移写会话 / 推 rev");
  assert.equal(parsed.session.tables.worldId, "w-mig");
  const rows = parsed.session.tables.branches.canon;
  assert.equal(rows.locations.length, 6, "chronicle 的 6 个地点");
  assert.equal(rows.characters.length, 4);

  // 迁移结果与直接迁移逐字一致
  const direct = migrateLegacyToTables({ world: fixture.world, maps: null, branchId: null, at: 418.12 });
  assert.equal(atlasTablesFingerprint(rows), atlasTablesFingerprint(direct.tables));

  // engine 侧经覆盖层就能读到刚建的三表
  assert.deepEqual(await overlay.read("tables:w-mig"), parsed.session.tables);

  // 一旦本次请求真的写了会话（正常回合提交就是如此），带三表的会话随响应落盘
  await overlay.write("binding:c1", { ...fixture.binding, worldTimeCursor: 419 });
  assert.equal(overlay.changed(), true);
  assert.equal(cloneSessionDoc(parsed.session).tables.branches.canon.locations.length, 6, "落盘快照含三表");

  const codes = diagnostics.map((item) => item.code);
  assert.ok(codes.includes("TABLE_MIGRATION_COMPLETE"));
  assert.ok(diagnostics.every((item) => ["debug", "info", "warn"].includes(item.level)));
});

test("A08 重复运行不新增行 / 不改 ID：第二次是 skipped", async () => {
  const fixture = legacySessionFixture();
  const store = createMemoryDocumentStore();
  const first = await runEnsure(fixture);

  // 用第一次的结果当作「浏览器已落盘」的会话再跑
  const rawAfter = { ...fixture.raw, rev: 3, tables: first.parsed.session.tables };
  const parsed = parseAtlasSessionDocDetailed(rawAfter);
  const overlay = createSessionOverlayStore(parsed.session, store);
  const before = atlasTablesFingerprint(parsed.session.tables.branches.canon);
  const outcome = await ensureSessionTables({
    session: parsed.session, parse: parsed, overlay, store, now: () => 1,
  });

  assert.equal(outcome.status, "skipped");
  assert.equal(outcome.reasonCode, "TABLE_ALREADY_PRESENT");
  assert.equal(overlay.changed(), false, "已迁移的会话不应再被标记变更");
  assert.equal(atlasTablesFingerprint(parsed.session.tables.branches.canon), before, "行与 ID 不变");
});

test("A08 损坏 tables / 世界不可解析 / 绑定缺失：不迁移、绝不动会话", async () => {
  // (1) 损坏 tables：解析已给具名错误 → failed，且不写入
  const broken = validTablesStore("w-mig");
  broken.branches.canon.locations[0].gridX = null;
  const damaged = await runEnsure(legacySessionFixture(), { raw: legacySessionFixture({
    raw: { tables: broken },
  }).raw });
  assert.equal(damaged.outcome.status, "failed");
  assert.equal(damaged.outcome.reasonCode, "TABLE_SESSION_CORRUPT");
  assert.equal(damaged.parsed.session.tables, null);
  assert.equal(damaged.overlay.changed(), false, "损坏档绝不能被迁移顺手改写");

  // (2) 世界不可解析
  const badWorld = await runEnsure(legacySessionFixture({ raw: { world: { id: "w-mig", points: "坏" } } }));
  assert.equal(badWorld.outcome.status, "failed");
  assert.equal(badWorld.outcome.reasonCode, "TABLE_WORLD_UNPARSEABLE");

  // (3) 没有绑定（旧会话未绑定）
  const noBinding = await runEnsure(legacySessionFixture({ raw: { binding: null } }));
  assert.equal(noBinding.outcome.status, "skipped");
  assert.equal(noBinding.outcome.reasonCode, "TABLE_NO_BINDING");
  assert.equal(noBinding.parsed.session.tables, null);

  // (4) 绑定指向另一个世界
  const mismatch = await runEnsure(legacySessionFixture({ binding: { worldId: "w-other" } }));
  assert.equal(mismatch.outcome.status, "failed");
  assert.equal(mismatch.outcome.reasonCode, "TABLE_WORLD_MISMATCH");
});

test("A08 分支作用域：IF 用 story id 建档，正史线归入 canon", async () => {
  const canonical = await runEnsure(legacySessionFixture({ binding: { branchId: "chronicle-canon" } }));
  assert.equal(canonical.outcome.branchKey, "canon", "正史故事线（mode=canon）归入基线");

  const ifBranch = await runEnsure(legacySessionFixture({ binding: { branchId: "chronicle-if-silence" } }));
  assert.equal(ifBranch.outcome.status, "migrated", JSON.stringify(ifBranch.outcome));
  assert.equal(ifBranch.outcome.branchKey, "chronicle-if-silence", "IF 分支用自己的 story id 建档");
  assert.deepEqual(Object.keys(ifBranch.parsed.session.tables.branches), ["chronicle-if-silence"]);
});

test("T08 分支隔离：别的分支之后才出现的地点 / 实体不进正史三表", async () => {
  /** 夹具：世界里存在一个「IF 分支回合创建的」地点与实体，账本记住它们属于 IF。 */
  const buildFixture = (branchId) => {
    const fixture = legacySessionFixture({ binding: { branchId } });
    fixture.raw.world.points = [...(fixture.raw.world.points ?? []), { id: 7777, name: "IF 专属地窖", x: 55, y: 45, regionId: "capital" }];
    fixture.raw.world.entityRecords = [...(fixture.raw.world.entityRecords ?? []), {
      id: "if-relic", worldId: "w-mig", type: "item", name: "IF 遗物", baseline: {}, temporalSchema: [], createdAt: 1,
    }];
    return fixture;
  };
  const store = createMemoryDocumentStore();
  await store.write("turn:c1:if-turn", {
    schemaVersion: 1, chatId: "c1", branchId: "chronicle-if-silence", effectiveAt: 10,
    createdPointIds: ["7777"], createdEntityIds: ["if-relic"], rolledBack: false,
  });

  const canon = await runEnsure(buildFixture(null), { store });
  const canonRows = canon.parsed.session.tables.branches.canon;
  assert.equal(canon.outcome.status, "migrated");
  assert.equal(canonRows.locations.some((row) => row.id === "loc:7777"), false, "正史不能拿到 IF 之后才出现的地点");
  assert.equal(canonRows.items.some((row) => row.id === "item:if-relic"), false, "实体同样不能越分支");

  const ifRun = await runEnsure(buildFixture("chronicle-if-silence"), { store });
  const ifRows = ifRun.parsed.session.tables.branches["chronicle-if-silence"];
  assert.equal(ifRun.outcome.status, "migrated");
  assert.equal(ifRows.locations.some((row) => row.id === "loc:7777"), true, "IF 自己分支的回合必须可见");
  assert.equal(ifRows.items.some((row) => row.id === "item:if-relic"), true);
});
