/**
 * atlas-host-connections.test.mjs — 0.9.13 酒馆主 API / 酒馆连接预设 适配层。
 *
 * 口径来源：shujuku src/service/ai/api-call.ts（串行队列 + /profile 切换恢复语义）。
 * 只测纯适配层：fake TavernHelper / fake ConnectionManager，不碰真实酒馆。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  isTavernMainAvailable,
  isConnectionManagerAvailable,
  getConnectionManagerProfiles,
  createTavernMainFetch,
  createTavernProfileFetch,
} from "../src/atlas-host-connections.ts";

/** 构造引擎形状的宿主请求（callAtlasWorldTurnApi main/profile 模式发出的 body）。 */
function hostInit(overrides = {}) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "host",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      stream: false,
      max_tokens: 768,
      xAtlasConnectionMode: "main",
      ...overrides,
    }),
  };
}

async function readJson(response) {
  assert.equal(response.ok, true, "宿主侧失败必须是 200 包错误 JSON");
  assert.equal(response.status, 200);
  return response.json();
}

test("isTavernMainAvailable：generateRaw 存在且为函数才算可用", () => {
  assert.equal(isTavernMainAvailable(() => ({ generateRaw: async () => "x" })), true);
  assert.equal(isTavernMainAvailable(() => ({ generateRaw: "not-a-fn" })), false);
  assert.equal(isTavernMainAvailable(() => null), false);
  assert.equal(isTavernMainAvailable(() => undefined), false);
});

test("isConnectionManagerAvailable：sendRequest 存在且为函数才算可用", () => {
  assert.equal(isConnectionManagerAvailable(() => ({ ConnectionManagerRequestService: { sendRequest: async () => ({}) } })), true);
  assert.equal(isConnectionManagerAvailable(() => ({ ConnectionManagerRequestService: {} })), false);
  assert.equal(isConnectionManagerAvailable(() => ({})), false);
  assert.equal(isConnectionManagerAvailable(() => null), false);
});

test("getConnectionManagerProfiles：非数组/缺 id 过滤，name 缺省回退 id", () => {
  const ctx = () => ({
    extensionSettings: {
      connectionManager: {
        profiles: [
          { id: "p1", name: "MiniMax 订阅" },
          { id: "p2" },
          { name: "no-id" },
          "junk",
        ],
      },
    },
  });
  assert.deepEqual(getConnectionManagerProfiles(ctx), [
    { id: "p1", name: "MiniMax 订阅" },
    { id: "p2", name: "p2" },
  ]);
  assert.deepEqual(getConnectionManagerProfiles(() => ({})), []);
  assert.deepEqual(getConnectionManagerProfiles(() => null), []);
});

test("main fetch：TavernHelper 缺失 → 200 包错误 JSON，提示装酒馆助手", async () => {
  const fetchFn = createTavernMainFetch({ getTavernHelper: () => null });
  const response = await fetchFn("atlas://host", hostInit());
  const body = await readJson(response);
  assert.match(body.error.message, /酒馆助手|TavernHelper/);
});

test("main fetch：合法请求 → generateRaw({ ordered_prompts, max_tokens, should_stream:false })，回包 OpenAI 形状", async () => {
  const seen = [];
  const helper = {
    generateRaw: async (opts) => {
      seen.push(opts);
      return "  星辰女王在北境升起了旗帜。  ";
    },
  };
  const fetchFn = createTavernMainFetch({ getTavernHelper: () => helper });
  const response = await fetchFn("atlas://host", hostInit());
  const body = await readJson(response);

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].ordered_prompts, [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(seen[0].max_tokens, 768);
  assert.equal(seen[0].should_stream, false);

  // OpenAI 形状 + 正文去首尾空白
  assert.equal(body.choices[0].message.content, "星辰女王在北境升起了旗帜。");
  // clone() 供日志层使用（引擎日志路径 clone().text()）
  assert.equal((await response.clone().text()).includes("星辰女王"), true);
});

test("main fetch：messages 全无效 → 200 包错误 JSON，不调 generateRaw", async () => {
  let called = 0;
  const helper = { generateRaw: async () => { called += 1; return "x"; } };
  const fetchFn = createTavernMainFetch({ getTavernHelper: () => helper });
  const body = await readJson(await fetchFn("atlas://host", hostInit({ messages: [{ role: "user" }, "junk"] })));
  assert.equal(called, 0);
  assert.match(body.error.message, /messages/);
});

test("main fetch：generateRaw 抛错 → 200 包错误 JSON 带原文", async () => {
  const helper = { generateRaw: async () => { throw new Error("宿主网络断了"); } };
  const fetchFn = createTavernMainFetch({ getTavernHelper: () => helper });
  const body = await readJson(await fetchFn("atlas://host", hostInit()));
  assert.match(body.error.message, /宿主网络断了/);
});

test("main fetch：generateRaw 返回空串 → 200 包错误 JSON", async () => {
  const helper = { generateRaw: async () => "   " };
  const fetchFn = createTavernMainFetch({ getTavernHelper: () => helper });
  const body = await readJson(await fetchFn("atlas://host", hostInit()));
  assert.match(body.error.message, /为空/);
});

test("profile fetch：服务缺失 / 未选预设 / 无 messages → 200 包错误 JSON", async () => {
  const noService = createTavernProfileFetch({ getContext: () => ({}), getTavernHelper: () => null });
  assert.match((await readJson(await noService("atlas://host", hostInit({ xAtlasConnectionMode: "profile" })))).error.message, /ConnectionManagerRequestService/);

  const ctx = () => ({ ConnectionManagerRequestService: { sendRequest: async () => ({ content: "ok" }) } });
  const noProfile = createTavernProfileFetch({ getContext: ctx, getTavernHelper: () => null });
  assert.match((await readJson(await noProfile("atlas://host", hostInit({ xAtlasConnectionMode: "profile", xAtlasProfileId: "  " })))).error.message, /未选择连接预设/);

  const noMessages = createTavernProfileFetch({ getContext: ctx, getTavernHelper: () => null });
  assert.match(
    (await readJson(await noMessages("atlas://host", hostInit({ xAtlasConnectionMode: "profile", xAtlasProfileId: "p1", messages: [] })))).error.message,
    /messages/,
  );
});

test("profile fetch：同预设不切换 → sendRequest(profileId, prompts, maxTokens)，回包取 content", async () => {
  const slashes = [];
  const helper = { triggerSlash: async (cmd) => { slashes.push(cmd); return cmd === "/profile" ? "p1" : ""; } };
  const sent = [];
  const ctx = () => ({
    extensionSettings: { connectionManager: { profiles: [{ id: "p1", name: "p1" }] } },
    ConnectionManagerRequestService: { sendRequest: async (id, msgs, max) => { sent.push({ id, msgs, max }); return { content: "结果正文" }; } },
  });
  const fetchFn = createTavernProfileFetch({ getContext: ctx, getTavernHelper: () => helper });
  const body = await readJson(await fetchFn("atlas://host", hostInit({ xAtlasConnectionMode: "profile", xAtlasProfileId: "p1" })));

  assert.deepEqual(sent, [{ id: "p1", msgs: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }], max: 768 }]);
  assert.equal(body.choices[0].message.content, "结果正文");
  // 同名预设：不切换、不恢复
  assert.ok(!slashes.some((c) => c.startsWith("/profile await=true")), "同预设不得触发切换");
});

test("profile fetch：不同预设 → /profile await=true 切换后发送，finally 恢复原预设", async () => {
  let currentProfile = "原预设";
  const slashes = [];
  const helper = {
    triggerSlash: async (cmd) => {
      slashes.push(cmd);
      if (cmd === "/profile") return currentProfile;
      const m = cmd.match(/^\/profile await=true "(.*)"$/);
      if (m) currentProfile = m[1];
      return "";
    },
  };
  const sent = [];
  const ctx = () => ({
    extensionSettings: { connectionManager: { profiles: [{ id: "p2", name: "目标预设" }] } },
    ConnectionManagerRequestService: {
      sendRequest: async (id) => {
        sent.push({ id, profileAtSend: currentProfile });
        return { content: "ok" };
      },
    },
  });
  const fetchFn = createTavernProfileFetch({ getContext: ctx, getTavernHelper: () => helper });
  await readJson(await fetchFn("atlas://host", hostInit({ xAtlasConnectionMode: "profile", xAtlasProfileId: "p2" })));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].profileAtSend, "目标预设", "发送时必须在目标预设上");
  const switchIdx = slashes.findIndex((c) => c.startsWith("/profile await=true"));
  assert.equal(slashes[switchIdx], '/profile await=true "目标预设"');
  const restoreIdx = slashes.findIndex((c, i) => i > switchIdx && c === "/profile");
  assert.ok(restoreIdx > switchIdx, "finally 里先查当前再恢复");
  assert.ok(slashes.slice(restoreIdx + 1).includes('/profile await=true "原预设"'), "完成后恢复原预设");
  assert.equal(currentProfile, "原预设");
});

test("profile fetch：串行队列——并发调用排队执行，切换互不踩踏（shujuku 同款）", async () => {
  let currentProfile = "原预设";
  let inFlight = 0;
  let maxInFlight = 0;
  const helper = {
    triggerSlash: async (cmd) => {
      if (cmd === "/profile") return currentProfile;
      const m = cmd.match(/^\/profile await=true "(.*)"$/);
      if (m) currentProfile = m[1];
      return "";
    },
  };
  const ctx = () => ({
    extensionSettings: { connectionManager: { profiles: [{ id: "p1", name: "p1" }] } },
    ConnectionManagerRequestService: {
      sendRequest: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
        return { content: "ok" };
      },
    },
  });
  const fetchFn = createTavernProfileFetch({ getContext: ctx, getTavernHelper: () => helper });
  const [a, b] = await Promise.all([
    fetchFn("atlas://host", hostInit({ xAtlasConnectionMode: "profile", xAtlasProfileId: "p1" })),
    fetchFn("atlas://host", hostInit({ xAtlasConnectionMode: "profile", xAtlasProfileId: "p1" })),
  ]);
  await readJson(a);
  await readJson(b);
  assert.equal(maxInFlight, 1, "sendRequest 不得并发重入");
});
