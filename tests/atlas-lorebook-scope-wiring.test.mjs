/**
 * atlas-lorebook-scope-wiring.test.mjs — B05 适配点①（世界书聊天作用域）接线验收。
 *
 * 背景：B05 的隔离逻辑（专属世界书按 chatId + worldId 命名、共享主卡书只读只清）
 * 早已实现并有单测，但 `index.js` 的 `createLorebookPort` 一直**没实现**
 * `resolveChatScope`，于是生产上永远回退 0.9.58 旧行为：**同一张角色卡的所有聊天
 * 共用一本世界书**，A 聊天的动向会出现在 B 聊天里。
 *
 * 本文件锁住接线后的语义（模块文档 §B05 适配点① 原文口径）：
 *  - chatId 取 context().chatId，为空 → null；
 *  - worldId 取当前聊天绑定的世界，为空 → null；
 *  - 两个都拿不到 → null（宁可回退旧行为，也**绝不拿半个身份硬凑作用域**）；
 *  - 读绑定抛错 → null，绝不把异常抛给写入路径。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const dom = new JSDOM("<!doctype html><head></head><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;

const source = readFileSync(join(root, "index.js"), "utf8");
const { createLorebookPort } = await import(
  "data:text/javascript;base64," + Buffer.from(source).toString("base64")
);

const worldInfoStub = {
  loadWorldInfo: async () => null,
  createNewWorldInfo: async () => {},
  saveWorldInfo: async () => {},
  createWorldInfoEntry: () => null,
};

function portFor(chatId, readScopeBinding) {
  return createLorebookPort(() => ({ chatId }), worldInfoStub, readScopeBinding);
}

test("B05 接线：chatId + 绑定世界都在 → 给出作用域（两个聊天因此各写各的书）", async () => {
  const portA = portFor("chat-a", async () => ({ worldId: "w-1" }));
  const portB = portFor("chat-b", async () => ({ worldId: "w-1" }));
  assert.deepEqual(await portA.resolveChatScope(), { chatId: "chat-a", worldId: "w-1" });
  assert.deepEqual(await portB.resolveChatScope(), { chatId: "chat-b", worldId: "w-1" });
  // 同一张卡、同一个世界，但聊天不同 → 作用域不同 → 世界书名不同（不串档）
  const a = await portA.resolveChatScope();
  const b = await portB.resolveChatScope();
  assert.notDeepEqual(a, b, "同一世界的两个聊天必须是不同作用域");
});

test("B05 接线：缺任一字段一律 null，绝不拿半个身份硬凑作用域", async () => {
  assert.equal(await portFor("", async () => ({ worldId: "w-1" })).resolveChatScope(), null, "没有聊天");
  assert.equal(await portFor("chat-a", async () => null).resolveChatScope(), null, "未绑定世界");
  assert.equal(await portFor("chat-a", async () => ({ worldId: "" })).resolveChatScope(), null, "世界 id 为空");
  assert.equal(await portFor("chat-a", async () => ({})).resolveChatScope(), null, "绑定里没有 worldId");
  // 旧调用点（不传第三个参数）→ 恒 null → 回退 0.9.58 行为，不擅自改变部署形态
  assert.equal(await createLorebookPort(() => ({ chatId: "chat-a" }), worldInfoStub).resolveChatScope(), null,
    "未接作用域的旧调用点必须保持旧行为");
});

test("B05 接线：读绑定抛错时返回 null，绝不把异常抛进写入路径", async () => {
  const port = portFor("chat-a", async () => { throw new Error("metadata 读失败"); });
  assert.equal(await port.resolveChatScope(), null, "异常必须被吞成 null（宁可不隔离，也不能写错人）");
});

test("B05 接线：chatId 两侧空白被裁剪；非字符串 chatId 视为没有聊天", async () => {
  assert.deepEqual(await portFor("  chat-a  ", async () => ({ worldId: "w-1" })).resolveChatScope(),
    { chatId: "chat-a", worldId: "w-1" });
  assert.equal(await portFor(undefined, async () => ({ worldId: "w-1" })).resolveChatScope(), null);
  assert.equal(await portFor(12345, async () => ({ worldId: "w-1" })).resolveChatScope(), null);
});

test("B05 接线：注入通道按 IN_CHAT 深度 4 写入，与生成拦截器同档位", async () => {
  const calls = [];
  const port = createLorebookPort(
    () => ({ chatId: "chat-a", setExtensionPrompt: (...args) => calls.push(args) }),
    worldInfoStub,
    async () => ({ worldId: "w-1" }),
  );
  await port.injectTurn("atlas:scope:abc", "动向正文");
  assert.deepEqual(calls, [["atlas:scope:abc", "动向正文", 2, 4]],
    "位置 2（IN_CHAT）、深度 4 —— 与 installGenerateInterceptor 一致");

  // 清空：酒馆语义是传空串
  await port.injectTurn("atlas:scope:abc", "");
  assert.equal(calls[1][1], "", "清空传空串，而不是 undefined");
});

test("B05 接线：注入不可用时必须 **throw**（静默返回会让动态内容凭空消失）", async () => {
  // 酒馆没提供 setExtensionPrompt
  const noApi = createLorebookPort(() => ({ chatId: "chat-a" }), worldInfoStub, async () => ({ worldId: "w-1" }));
  await assert.rejects(() => noApi.injectTurn("k", "v"), /setExtensionPrompt/,
    "必须抛错，writer 才会回退专属世界书路径");

  // 上下文整个取不到
  const noCtx = createLorebookPort(() => { throw new Error("no context"); }, worldInfoStub, async () => ({ worldId: "w-1" }));
  await assert.rejects(() => noCtx.injectTurn("k", "v"),
    "取不到上下文同样必须抛错，不能静默当作注入成功");
});
