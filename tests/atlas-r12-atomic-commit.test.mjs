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

const { createMemoryDocumentStore } = await imp("src/atlas-server.ts");
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