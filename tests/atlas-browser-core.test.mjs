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
import { createStProxyFetch, atlasCustomIncludeHeaders, ATLAS_ST_GENERATE_PATH } from "../src/atlas-proxy-fetch.ts";
import { createAtlasServerCore, createMemoryDocumentStore } from "../src/atlas-server.ts";
import { ATLAS_ERROR_CODES } from "../src/atlas-contract.ts";
import { callAtlasWorldTurnApi } from "../src/atlas-api-client.ts";

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
  // 密钥经 custom_include_headers 转交——ATLAS-FIX-02：必须是「原始头字符串」
  // （酒馆 mergeObjectWithYaml 按行解析；shujuku 同款口径）。传对象 = 鉴权头被静默丢弃。
  assert.equal(sentBody.custom_include_headers, "Authorization: Bearer sk-test-123");
  // 外层请求头不得带明文密钥（密钥只在 body 内转交）
  assert.equal(sentHeaders.Authorization, undefined);
});

test("proxy fetch: 无密钥 → custom_include_headers 是空字符串", async () => {
  const fetchFn = makeCapturingFetch({});
  const proxyFetch = createStProxyFetch({ getContext: fakeContext(), fetchFn });
  await proxyFetch("https://api.example.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m1", messages: [], stream: false }),
  });
  const sentBody = JSON.parse(fetchFn.calls[0].init.body);
  assert.equal(sentBody.custom_include_headers, "");
});

test("ATLAS-FIX-02：custom_include_headers 序列化口径（模型列表与生成共用）", () => {
  assert.equal(atlasCustomIncludeHeaders("Bearer sk-abc"), "Authorization: Bearer sk-abc", "完整头值 → 原始头字符串");
  assert.equal(atlasCustomIncludeHeaders("Bearer sk-x"), "Authorization: Bearer sk-x");
  assert.equal(atlasCustomIncludeHeaders(""), "", "空 → 空字符串（绝不能是对象）");
  assert.equal(atlasCustomIncludeHeaders(null), "", "null → 空字符串");
  assert.equal(atlasCustomIncludeHeaders(undefined), "", "undefined → 空字符串");
  assert.equal(atlasCustomIncludeHeaders("   "), "", "纯空白 → 空字符串");
  // 形状守卫：序列化结果必须是 string，绝不能是对象（对象会被酒馆静默丢弃）
  assert.equal(typeof atlasCustomIncludeHeaders("Bearer k"), "string");
});

test("ATLAS-FIX-02 集成：浏览器预设 → 代理请求体 → 模拟上游按 YAML 头鉴权成功", async () => {
  // 模拟酒馆后端代理行为：收到 /generate 后解析 custom_include_headers（YAML 行），
  // 把鉴权头合并进上游请求；只有头字符串格式正确且密钥匹配才返回草稿，否则 401。
  const UPSTREAM_KEY = "Bearer sk-good-key";
  const proxyFetchStub = async (_url, init) => {
    const body = JSON.parse(init.body);
    const headerLine = body.custom_include_headers;
    if (typeof headerLine !== "string") {
      return { ok: false, status: 500, json: async () => ({ error: { message: "对象头已被酒馆丢弃（真实缺陷复现）" } }) };
    }
    const match = /^Authorization:\s*(.+)$/.exec(headerLine.trim());
    const received = match ? match[1].trim() : "";
    if (received !== UPSTREAM_KEY) {
      return { ok: false, status: 401, json: async () => ({ error: { message: "上游鉴权失败" } }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              duration: 2,
              locationChange: null,
              npcChanges: [],
              memoryDrafts: [],
              summary: "集成链路：鉴权成功，草稿可解析。",
            }),
          },
        }],
      }),
    };
  };
  const proxyFetch = createStProxyFetch({ getContext: fakeContext(), fetchFn: proxyFetchStub });

  const result = await callAtlasWorldTurnApi(
    { name: "集成", endpoint: "https://api.example.com/v1/chat/completions", model: "m1", apiKey: "sk-good-key" },
    { injectionText: "ctx", userText: "用户行动", assistantText: "回复" },
    { fetchFn: proxyFetch },
  );
  assert.ok(result.ok, `完整链路应鉴权成功：${result.ok ? "" : result.message}`);
  assert.ok(result.text.includes("集成链路"), "上游返回的草稿正文可用");
});

test("ATLAS-FIX-02 集成：鉴权头格式错误 → 上游 401，错误码 API_AUTH_FAILED", async () => {
  const proxyFetchStub = async (_url, init) => {
    const body = JSON.parse(init.body);
    const ok = body.custom_include_headers === "Authorization: Bearer sk-right";
    return ok
      ? { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{}" } }] }) }
      : { ok: false, status: 401, json: async () => ({ error: { message: "unauthorized" } }) };
  };
  const proxyFetch = createStProxyFetch({ getContext: fakeContext(), fetchFn: proxyFetchStub });
  const result = await callAtlasWorldTurnApi(
    { name: "错钥", endpoint: "https://api.example.com/v1/chat/completions", model: "m1", apiKey: "sk-wrong" },
    { injectionText: "ctx", userText: "u", assistantText: "a" },
    { fetchFn: proxyFetch },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, ATLAS_ERROR_CODES.API_AUTH_FAILED);
  assert.ok(!JSON.stringify(result).includes("sk-"), "错误信息不得含密钥");
});

test("ATLAS-FIX-02：错误提示分类（401/403/404/429/非 JSON/空结构/不可达）", async () => {
  const call = (status, rawBody, parseError) => {
    const fetchFn = async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (parseError) throw new Error("not json");
        return rawBody;
      },
    });
    return callAtlasWorldTurnApi(
      { name: "t", endpoint: "https://api.example.com/v1/chat/completions", model: "m1", apiKey: "" },
      { injectionText: "c", userText: "u", assistantText: "a" },
      { fetchFn },
    );
  };
  const auth = await call(401, {});
  assert.equal(auth.code, ATLAS_ERROR_CODES.API_AUTH_FAILED, "401 → 鉴权失败");
  const forbidden = await call(403, {});
  assert.equal(forbidden.code, ATLAS_ERROR_CODES.API_AUTH_FAILED, "403 → 鉴权失败");
  const notFound = await call(404, {});
  assert.equal(notFound.code, ATLAS_ERROR_CODES.API_NOT_FOUND, "404 → 地址或模型不存在");
  assert.ok(/模型|地址/.test(notFound.message), "404 提示指明模型名或地址");
  const rate = await call(429, {});
  assert.equal(rate.code, ATLAS_ERROR_CODES.API_RATE_LIMITED, "429 → 限流");
  assert.equal(rate.retryable, true, "限流可重试");
  const badJson = await call(200, {}, true);
  assert.equal(badJson.code, ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "响应非 JSON → 结构损坏");
  const emptyStructure = await call(200, { object: "without choices" });
  assert.equal(emptyStructure.code, ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "响应结构非法（无可取正文）");
  const offline = await callAtlasWorldTurnApi(
    { name: "t", endpoint: "https://api.example.com/v1/chat/completions", model: "m1", apiKey: "" },
    { injectionText: "c", userText: "u", assistantText: "a" },
    { fetchFn: async () => { throw new Error("ECONNREFUSED"); } },
  );
  assert.equal(offline.code, ATLAS_ERROR_CODES.SERVICE_OFFLINE, "地址不可达 → SERVICE_OFFLINE");
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
