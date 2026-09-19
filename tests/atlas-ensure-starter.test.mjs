/**
 * atlas-ensure-starter.test.mjs — ATLAS-18 自动建世服务端契约（先红后绿）。
 *
 * 口径来源：开发规格README.md 0.9（唯一流程 / 代码设计）与 0.11「自动建世」测试矩阵。
 * - POST /worlds/ensure-starter：先 parseWorld，再按 world.id 串行；
 *   已存在 → { created:false } 且**绝不覆盖**；不存在 → 写入并 { created:true }。
 * - starterWorldIdForChat(chatId)：UTF-8 字节 64 位 FNV-1a → world-auto-<16 hex>；
 *   同 chatId 永远同 ID；不暴露原 chatId。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildStarterWorld, starterWorldIdForChat } from "../src/atlas-starter-world.ts";
import { createAtlasServerCore, createMemoryDocumentStore } from "../src/atlas-server.ts";

const NOW = 1_700_000_000_000;

async function makeCore() {
  const store = createMemoryDocumentStore();
  const core = createAtlasServerCore({ store, now: () => NOW });
  return { store, core };
}

function starterWorld(id, name = "测试角色") {
  return JSON.parse(JSON.stringify(buildStarterWorld({ id, now: NOW, name })));
}

async function ensure(core, world, ctx = { local: true }) {
  return core.handle("POST", "/worlds/ensure-starter", { world }, ctx);
}

// ---------------------------------------------------------------------------
// 稳定 world ID
// ---------------------------------------------------------------------------

test("starterWorldIdForChat：确定性、形状固定、不泄漏 chatId", () => {
  const a1 = starterWorldIdForChat("chat-abc");
  const a2 = starterWorldIdForChat("chat-abc");
  const b = starterWorldIdForChat("chat-xyz");
  assert.equal(a1, a2, "同 chatId 永远同 ID");
  assert.notEqual(a1, b, "不同 chatId 不同 ID");
  assert.match(a1, /^world-auto-[0-9a-f]{16}$/, "形状 world-auto-<16 hex>");
  assert.ok(!a1.includes("chat-abc"), "ID 不暴露原 chatId");

  const cn1 = starterWorldIdForChat("角色卡·张三 的聊天");
  const cn2 = starterWorldIdForChat("角色卡·张三 的聊天");
  assert.equal(cn1, cn2, "非 ASCII（UTF-8 多字节）同样稳定");
  assert.match(cn1, /^world-auto-[0-9a-f]{16}$/);

  assert.notEqual(starterWorldIdForChat(""), starterWorldIdForChat("a"), "空串与短串不碰撞");
  assert.match(starterWorldIdForChat(""), /^world-auto-[0-9a-f]{16}$/, "空 chatId 也能给出合法 ID");
});

test("starterWorldIdForChat：不同 chatId 的分布不集中在同一 ID（抽样 200 个无重复）", () => {
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) ids.add(starterWorldIdForChat(`chat-${i}`));
  assert.equal(ids.size, 200, "200 个不同 chatId 全部映射到不同 ID");
});

// ---------------------------------------------------------------------------
// POST /worlds/ensure-starter
// ---------------------------------------------------------------------------

test("ensure-starter：首次创建 created=true，世界可被后续读取", async () => {
  const { core } = await makeCore();
  const world = starterWorld("world-auto-0123456789abcdef");
  const first = await ensure(core, world);
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.data.created, true, "首次 = created");
  assert.equal(first.body.data.world.id, world.id);
  assert.equal(first.body.data.world.name, world.name, "返回脱敏摘要含世界名");

  const listed = await core.handle("GET", "/worlds");
  assert.ok(
    listed.body.data.worlds.some((w) => w.id === world.id),
    "世界已落库，列表可见",
  );
});

test("ensure-starter：世界已存在 → created=false 且绝不覆盖已有内容", async () => {
  const { core, store } = await makeCore();
  const world = starterWorld("world-auto-aaaaaaaaaaaaaaaa", "原角色");
  await ensure(core, world);

  // 模拟用户/推演已经改动过这个世界（改名 + 加地点）
  const stored = await store.read(`world:${world.id}`);
  stored.name = "被改过的世界名";
  stored.points = [...stored.points, { id: 2, name: "后来加的地点", x: 20, y: 20, regionId: "start" }];
  await store.write(`world:${world.id}`, stored);

  const again = await ensure(core, starterWorld("world-auto-aaaaaaaaaaaaaaaa", "新角色名"));
  assert.equal(again.body.data.created, false, "第二次 = created:false");
  const after = await store.read(`world:${world.id}`);
  assert.equal(after.name, "被改过的世界名", "既有世界名未被覆盖");
  assert.equal(after.points.length, 2, "既有地点未被覆盖");
});

test("ensure-starter：非法世界被拒且零写入", async () => {
  const { core, store } = await makeCore();
  const bad = await ensure(core, { id: "x" });
  assert.equal(bad.body.ok, false);
  assert.equal(bad.body.error.code, "INVALID_PAYLOAD", "parseWorld 不过 → INVALID_PAYLOAD");
  assert.equal(await store.read("world:x"), null, "拒绝时不写任何东西");
});

test("ensure-starter：远端（非本机）调用 403", async () => {
  const { core, store } = await makeCore();
  const world = starterWorld("world-auto-bbbbbbbbbbbbbbbb");
  const denied = await ensure(core, world, { local: false });
  assert.equal(denied.body.ok, false);
  assert.equal(denied.body.error.code, "FORBIDDEN");
  assert.equal(await store.read(`world:${world.id}`), null, "拒绝时不写");
});

test("ensure-starter：并发同名 ensure 串行，只创建一个世界", async () => {
  const { core, store } = await makeCore();
  const id = "world-auto-cccccccccccccccc";
  const results = await Promise.all([
    ensure(core, starterWorld(id, "并发A")),
    ensure(core, starterWorld(id, "并发B")),
    ensure(core, starterWorld(id, "并发C")),
  ]);
  const createdCount = results.filter((r) => r.body.data.created === true).length;
  assert.equal(createdCount, 1, "并发下恰好一次 created:true");
  const stored = await store.read(`world:${id}`);
  assert.ok(stored, "世界确实落库");
  assert.equal(stored.id, id);
});

test("ensure-starter → bindings：建世后可直接绑定，无需 import", async () => {
  const { core } = await makeCore();
  const id = "world-auto-dddddddddddddddd";
  await ensure(core, starterWorld(id));
  const bound = await core.handle("POST", "/bindings", {
    action: "bind",
    binding: {
      schemaVersion: 1,
      enabled: true,
      chatId: "chat-1",
      worldId: id,
      branchId: null,
      currentLocationId: "1",
      worldTimeCursor: 0,
    },
  });
  assert.equal(bound.body.ok, true, "绑定成功");
  const state = await core.handle("GET", "/state/chat-1");
  assert.equal(state.body.ok, true, "绑定后 state 可读");
  assert.equal(state.body.data.binding.worldId ?? state.body.data.worldId, id);
});
