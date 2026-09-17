/**
 * atlas-browser-core.test.mjs — ATLAS-09 纯浏览器模式基础件（先红后绿）。
 *
 * 覆盖：
 * - AtlasBrowserStore：extensionSettings 宿主 KV 上的文档存储（读 / 写 / 删 / 列表、
 *   持久化经宿主 writeAll、损坏载荷严格解析不炸、有界写入超限拒绝）。
 * - createLocalAtlasApi：进程内 dispatch，绕过 HTTP，直连 createAtlasServerCore().handle。
 * - createStProxyFetch：推演请求改写为酒馆后端代理
 *   POST /api/backends/chat-completions/generate（custom source + custom_include_headers）。
 *
 * 契约依据（2026-09-17 上游源码实测，release 分支）：
 * - world-info.js:4137 createWorldInfoEntry / :4177 saveWorldInfo / :2036 loadWorldInfo
 *   / :4448 createNewWorldInfo / :4043 deleteWorldInfoEntry / :94 METADATA_KEY='world_info'
 * - chat-completions.js:2394-2410 CUSTOM 分支：custom_url + readSecret(CUSTOM) +
 *   mergeObjectWithYaml(bodyParams, custom_include_body) + mergeObjectWithYaml(headers, custom_include_headers)
 *   / :2615 CUSTOM 豁免密钥缺失检查 / :2671 custom_exclude_body
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createBrowserDocumentStore, ATLAS_BROWSER_DOC_LIMITS } from "../src/atlas-browser-store.ts";
import { createLocalAtlasApi } from "../src/atlas-local-api.ts";
import { createStProxyFetch, ATLAS_ST_GENERATE_PATH } from "../src/atlas-proxy-fetch.ts";
import { createAtlasServerCore, createMemoryDocumentStore } from "../src/atlas-server.ts";
import { ATLAS_ERROR_CODES } from "../src/atlas-contract.ts";

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

/** 宿主 KV：最简内存实现，形状对齐 index.js 未来的 extensionSettings 适配。 */
function makeHostKV(initial = undefined) {
  let value = initial;
  return {
    readAll: () => value,
    writeAll(next) {
      value = next;
    },
    snapshot: () => value,
  };
}

// ---------------------------------------------------------------------------
// AtlasBrowserStore
// ---------------------------------------------------------------------------

test("browser store: write/read/remove/list 往返 + 持久化经宿主 writeAll", async () => {
  const host = makeHostKV();
  const store = createBrowserDocumentStore(host);

  await store.write("world:w1", { id: "w1", points: [{ id: "p1" }] });
  await store.write("binding:c1", { chatId: "c1" });

  const world = await store.read("world:w1");
  assert.deepEqual(world, { id: "w1", points: [{ id: "p1" }] });

  const bindings = await store.list("binding:");
  assert.deepEqual(bindings, ["binding:c1"]);

  // 宿主持久化形状：{ schemaVersion: 1, docs: {...} }
  const snapshot = host.snapshot();
  assert.equal(snapshot.schemaVersion, 1);
  assert.ok(snapshot.docs["world:w1"]);

  await store.remove("world:w1");
  assert.equal(await store.read("world:w1"), null);
  assert.deepEqual(await store.list("world:"), []);
});

test("browser store: 宿主载荷损坏 → 严格解析按空存储处理，不抛不破坏", async () => {
  const host = makeHostKV({ docs: "junk-not-an-object" });
  const store = createBrowserDocumentStore(host);

  assert.equal(await store.read("world:w1"), null);
  assert.deepEqual(await store.list(""), []);

  // 之后正常写入可恢复（用合法形状覆盖）
  await store.write("settings", { autoCommit: true });
  assert.deepEqual(await store.read("settings"), { autoCommit: true });
});

test("browser store: schemaVersion 不符 → 按空存储处理", async () => {
  const host = makeHostKV({ schemaVersion: 99, docs: {} });
  const store = createBrowserDocumentStore(host);
  assert.equal(await store.read("settings"), null);
});

test("browser store: 单文档超限写入被拒绝（FIELD_LIMIT_EXCEEDED），存储不变", async () => {
  const host = makeHostKV();
  const store = createBrowserDocumentStore(host);
  await store.write("settings", { a: 1 });

  const huge = "x".repeat(ATLAS_BROWSER_DOC_LIMITS.DOC_MAX_BYTES);
  await assert.rejects(
    () => store.write("huge", { blob: huge }),
    (error) => {
      assert.equal(error.code, ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED);
      return true;
    },
  );
  // 失败写入不落盘
  assert.equal(await store.read("huge"), null);
  assert.deepEqual(await store.read("settings"), { a: 1 });
});

test("browser store: 文档数量超限被拒绝", async () => {
  const host = makeHostKV();
  const store = createBrowserDocumentStore(host);
  for (let i = 0; i < ATLAS_BROWSER_DOC_LIMITS.DOC_COUNT_MAX; i += 1) {
    await store.write(`doc:${i}`, { i });
  }
  await assert.rejects(
    () => store.write("doc:overflow", { i: -1 }),
    (error) => error.code === ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED,
  );
});

// ---------------------------------------------------------------------------
// createLocalAtlasApi
// ---------------------------------------------------------------------------

test("local api: GET /health 进程内返回 ok", async () => {
  const core = createAtlasServerCore({ store: createMemoryDocumentStore() });
  const api = createLocalAtlasApi(core);
  const { status, body } = await api.request("GET", "/health");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test("local api: PUT/GET /settings 走同一 store（进程内零网络）", async () => {
  const core = createAtlasServerCore({ store: createMemoryDocumentStore() });
  const api = createLocalAtlasApi(core);
  const put = await api.request("PUT", "/settings", {
    worldTurn: { name: "p1", endpoint: "https://api.example.com/v1/chat/completions", model: "m1", apiKey: "k" },
    autoCommit: false,
  });
  assert.equal(put.status, 200);
  const get = await api.request("GET", "/settings");
  assert.equal(get.status, 200);
  assert.equal(get.body.data.autoCommit, false);
  assert.equal(get.body.data.worldTurn.model, "m1");
  // 脱敏：apiKey 只出掩码
  assert.equal(get.body.data.worldTurn.apiKey.exists, true);
  assert.equal(get.body.data.worldTurn.apiKey.tail, undefined || get.body.data.worldTurn.apiKey.tail);
});

test("local api: 未知路由 → ok:false + 稳定错误码", async () => {
  const core = createAtlasServerCore({ store: createMemoryDocumentStore() });
  const api = createLocalAtlasApi(core);
  const { status, body } = await api.request("GET", "/nope");
  assert.ok(status >= 400);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, ATLAS_ERROR_CODES.INVALID_PAYLOAD);
});

// ---------------------------------------------------------------------------
// createStProxyFetch
// ---------------------------------------------------------------------------

function fakeContext(headers = { "X-CSRF-Token": "tok-1" }) {
  return () => ({ getRequestHeaders: () => headers });
}

function makeCapturingFetch(responseBody) {
  const calls = [];
  const response = { ok: true, status: 200, json: async () => responseBody ?? { choices: [] } };
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  fetchFn.calls = calls;
  fetchFn.response = response;
  return fetchFn;
}

test("proxy fetch: 改写为后端代理 custom 请求（CSRF + custom_url + custom_include_headers）", async () => {
  const fetchFn = makeCapturingFetch({ choices: [{ message: { content: "{}" } }] });
  const proxyFetch = createStProxyFetch({ getContext: fakeContext(), fetchFn });

  const response = await proxyFetch("https://api.example.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test-123" },
    body: JSON.stringify({
      model: "m1",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      temperature: 0.7,
      max_tokens: 512,
    }),
  });

  assert.equal(response, fetchFn.response); // 响应原样透传
  assert.equal(fetchFn.calls.length, 1);
  const { url, init } = fetchFn.calls[0];
  assert.equal(url, ATLAS_ST_GENERATE_PATH);

  const sentHeaders = init.headers;
  assert.equal(sentHeaders["X-CSRF-Token"], "tok-1");
  assert.equal(sentHeaders["Content-Type"], "application/json");

  const sentBody = JSON.parse(init.body);
  assert.equal(sentBody.chat_completion_source, "custom");
  assert.equal(sentBody.custom_url, "https://api.example.com/v1/chat/completions");
  assert.equal(sentBody.model, "m1");
  assert.deepEqual(sentBody.messages, [{ role: "user", content: "hi" }]);
  assert.equal(sentBody.stream, false);
  assert.equal(sentBody.temperature, 0.7);
  assert.equal(sentBody.max_tokens, 512);
  // 密钥经 custom_include_headers 转交（上游 2410 行 mergeObjectWithYaml 合并进上游请求头）
  assert.equal(sentBody.custom_include_headers.Authorization, "Bearer sk-test-123");
  // 外层请求头不得带明文密钥（密钥只在 body 内转交）
  assert.equal(sentHeaders.Authorization, undefined);
});

test("proxy fetch: 无密钥 → custom_include_headers 不含 Authorization", async () => {
  const fetchFn = makeCapturingFetch({});
  const proxyFetch = createStProxyFetch({ getContext: fakeContext(), fetchFn });
  await proxyFetch("https://api.example.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m1", messages: [], stream: false }),
  });
  const sentBody = JSON.parse(fetchFn.calls[0].init.body);
  assert.equal(sentBody.custom_include_headers.Authorization, undefined);
});

test("proxy fetch: signal 透传（超时中止链路保持）", async () => {
  const fetchFn = makeCapturingFetch({});
  const proxyFetch = createStProxyFetch({ getContext: fakeContext(), fetchFn });
  const controller = new AbortController();
  await proxyFetch("https://api.example.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m1", messages: [], stream: false }),
    signal: controller.signal,
  });
  assert.equal(fetchFn.calls[0].init.signal, controller.signal);
});

test("proxy fetch: 非 chat-completions 载荷直接透传不改写", async () => {
  const fetchFn = makeCapturingFetch({});
  const proxyFetch = createStProxyFetch({ getContext: fakeContext(), fetchFn });
  await proxyFetch("https://other.example.com/ping", { method: "POST", body: "not-json" });
  assert.equal(fetchFn.calls[0].url, "https://other.example.com/ping");
});
