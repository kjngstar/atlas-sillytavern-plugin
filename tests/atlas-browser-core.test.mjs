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
import { createStProxyFetch, atlasCustomIncludeHeaders, normalizeAtlasClaudeBase, normalizeAtlasGeminiBase, normalizeAtlasExcludeBody, normalizeAtlasPromptPostProcessing, ATLAS_ST_GENERATE_PATH } from "../src/atlas-proxy-fetch.ts";
import { createAtlasServerCore, createMemoryDocumentStore } from "../src/atlas-server.ts";
import { ATLAS_ERROR_CODES } from "../src/atlas-contract.ts";
import { callAtlasWorldTurnApi, parseAtlasWorldTurnDraft } from "../src/atlas-api-client.ts";

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

test("local api: PUT/GET /settings 走同一 store（进程内零网络，ATLAS-18 v2 命令）", async () => {
  const core = createAtlasServerCore({ store: createMemoryDocumentStore() });
  const api = createLocalAtlasApi(core);
  const saved = await api.request("PUT", "/settings", {
    action: "api.save",
    preset: {
      name: "p1",
      endpoint: "https://api.example.com/v1/chat/completions",
      model: "m1",
      maxTokens: 1024,
      temperature: 0.5,
      topP: 0.95,
      timeoutMs: 30_000,
    },
    apiKeyMode: "replace",
    apiKey: "sk-local-test",
  });
  assert.equal(saved.status, 200);
  const activated = await api.request("PUT", "/settings", {
    action: "api.activate",
    id: saved.body.data.apiPresets[0].id,
  });
  assert.equal(activated.status, 200);
  const runtime = await api.request("PUT", "/settings", { action: "runtime.update", autoCommit: false });
  assert.equal(runtime.status, 200);

  const get = await api.request("GET", "/settings");
  assert.equal(get.status, 200);
  assert.equal(get.body.data.schemaVersion, 2, "GET 出 v2 形状");
  assert.equal(get.body.data.autoCommit, false);
  assert.equal(get.body.data.apiPresets.length, 1);
  assert.equal(get.body.data.apiPresets[0].model, "m1");
  assert.equal(get.body.data.activeApiPresetId, saved.body.data.apiPresets[0].id, "活动引用持久化");
  // 0.9.12（作者令，照抄 shujuku）：GET 回传明文 Key 供编辑器回填 / 测试连接复用
  assert.equal(get.body.data.apiPresets[0].apiKey, "sk-local-test");
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


// ---------------------------------------------------------------------------
// 0.9.6：响应形状兼容（作者真实酒馆报「返回为空或不支持的格式」）
// ---------------------------------------------------------------------------

test("callAtlasWorldTurnApi：content 分段数组 / ollama 形状 / SSE 强制流式均可取正文", async () => {
  const input = { injectionText: "c", userText: "u", assistantText: "a" };
  const preset = { name: "t", endpoint: "https://api.example.com/v1/chat/completions", model: "m1", apiKey: "" };
  const withBody = (body) =>
    callAtlasWorldTurnApi(preset, input, {
      fetchFn: async () => ({ ok: true, status: 200, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) }),
    });

  const parts = await withBody({ choices: [{ message: { content: [{ type: "text", text: "{\"duration\":1}" }] } }] });
  assert.ok(parts.ok, "content 分段数组应可用: " + String(parts.ok ? "" : parts.message));
  assert.ok(parts.text.includes("duration"));

  const ollama = await withBody({ message: { role: "assistant", content: "{\"duration\":2}" } });
  assert.ok(ollama.ok, "ollama 形状应可用: " + String(ollama.ok ? "" : ollama.message));

  const sse = await withBody('data: ' + JSON.stringify({ choices: [{ message: { content: JSON.stringify({ duration: 3 }) } }] }) + '\n\ndata: [DONE]\n');
  assert.ok(sse.ok, "SSE 强制流式应可兜底: " + String(sse.ok ? "" : sse.message));

  const errorShape = await withBody({ error: { message: "quota exceeded" } });
  assert.equal(errorShape.code, ATLAS_ERROR_CODES.RESPONSE_MALFORMED);
  assert.ok(errorShape.message.includes("quota exceeded"), "报错应含响应片段: " + errorShape.message);
  assert.ok(!errorShape.message.includes("Bearer sk-"), "片段不得含密钥");
});

test("0.9.36 reasoning_content 兜底：content 为空、输出全在推理字段 → 救回正文（MiniMax-M3 think-only 形状）", async () => {
  const input = { injectionText: "c", userText: "u", assistantText: "a" };
  const preset = { name: "t", endpoint: "https://api.example.com/v1/chat/completions", model: "MiniMax-M3", apiKey: "" };
  const draft = JSON.stringify({ duration: 3, locationChange: null, npcChanges: [], memoryDrafts: [], summary: "推理字段救回。" });
  const withBody = (body) =>
    callAtlasWorldTurnApi(preset, input, {
      fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }),
    });

  const openaiShape = await withBody({
    choices: [{ message: { content: "", reasoning_content: `让我想一想……\n${draft}`, finish_reason: "tool_calls" } }],
  });
  assert.ok(openaiShape.ok, "reasoning_content 应救回正文: " + String(openaiShape.ok ? "" : openaiShape.message));
  assert.ok(openaiShape.text.includes("推理字段救回"), "正文取自推理字段");

  const contentFirst = await withBody({ choices: [{ message: { content: draft, reasoning_content: "{junk reasoning" } }] });
  assert.ok(contentFirst.ok && contentFirst.text.trim().startsWith("{"), "content 非空时优先 content，不被推理字段污染");

  const stillEmpty = await withBody({ choices: [{ message: { content: "" } }] });
  assert.equal(stillEmpty.ok, false, "无推理字段时仍按空回复报错");
  assert.equal(stillEmpty.code, ATLAS_ERROR_CODES.RESPONSE_MALFORMED);

  const ollama = await withBody({ message: { role: "assistant", content: "", reasoning_content: draft } });
  assert.ok(ollama.ok, "ollama 形状的 reasoning_content 同样兜底");
});


test("callAtlasWorldTurnApi：网关 200 包错误 JSON → 报错带网关 message 与指引", async () => {
  const preset = { name: "t", endpoint: "https://api.example.com/v1", model: "m1", apiKey: "" };
  const result = await callAtlasWorldTurnApi(
    preset,
    { injectionText: "c", userText: "u", assistantText: "a" },
    { fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ error: { message: "Not Found" }, quota_error: false }) }) },
  );
  assert.equal(result.code, ATLAS_ERROR_CODES.RESPONSE_MALFORMED);
  assert.ok(result.message.includes("Not Found"), "报错应含网关错误文本");
  assert.ok(result.message.includes("模型名"), "报错应含模型名指引");
});

test("callAtlasWorldTurnApi：MiniMax 端点 Not Found → 附加 MiniMax 专项提示（sk-cp 订阅密钥指 Anthropic 路由）", async () => {
  const base = { injectionText: "c", userText: "u", assistantText: "a" };
  const notFound = JSON.stringify({ error: { message: "Not Found" }, quota_error: false });
  const fetchOk = async () => ({ ok: true, status: 200, text: async () => notFound });

  // 订阅密钥：提示走 Anthropic 路由
  const sub = await callAtlasWorldTurnApi(
    { name: "t", endpoint: "https://api.minimaxi.com/v1", model: "MiniMax-M3", apiKey: "sk-cp-abc" },
    base,
    { fetchFn: fetchOk },
  );
  assert.ok(sub.message.includes("【MiniMax 检测】"), "MiniMax 端点应附加专项提示");
  assert.ok(sub.message.includes("anthropic"), "订阅密钥应指向 Anthropic 兼容路由");

  // 非订阅密钥：提示平台归属与余额
  const payg = await callAtlasWorldTurnApi(
    { name: "t", endpoint: "https://api.minimaxi.com/v1", model: "MiniMax-M3", apiKey: "sk-api-xyz" },
    base,
    { fetchFn: fetchOk },
  );
  assert.ok(payg.message.includes("密钥不通用"), "应提示国内/国际站密钥不通用");

  // 非 MiniMax 端点：不附加提示
  const other = await callAtlasWorldTurnApi(
    { name: "t", endpoint: "https://api.example.com/v1", model: "m1", apiKey: "sk-cp-abc" },
    base,
    { fetchFn: fetchOk },
  );
  assert.ok(!other.message.includes("【MiniMax 检测】"), "非 MiniMax 端点不应附加专项提示");

  // 非 Not Found 网关错误：不附加提示
  const otherErr = await callAtlasWorldTurnApi(
    { name: "t", endpoint: "https://api.minimaxi.com/v1", model: "MiniMax-M3", apiKey: "sk-cp-abc" },
    base,
    { fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ error: { message: "Insufficient Balance" }, quota_error: true }) }) },
  );
  assert.ok(!otherErr.message.includes("【MiniMax 检测】"), "非 Not Found 不应附加专项提示");
});


test("normalizeAtlasClaudeBase：shujuku 同款 claude 基址归一化", () => {
  // MiniMax 订阅密钥的实际用法：/anthropic → /anthropic/v1
  assert.equal(normalizeAtlasClaudeBase("https://api.minimaxi.com/anthropic"), "https://api.minimaxi.com/anthropic/v1");
  assert.equal(normalizeAtlasClaudeBase("https://api.minimax.io/anthropic"), "https://api.minimax.io/anthropic/v1");
  // 已含 /v1 不重复补
  assert.equal(normalizeAtlasClaudeBase("https://api.anthropic.com/v1"), "https://api.anthropic.com/v1");
  // 引擎经 buildAtlasChatUrl 拼上的 /chat/completions 会被剥掉
  assert.equal(normalizeAtlasClaudeBase("https://api.minimaxi.com/anthropic/chat/completions"), "https://api.minimaxi.com/anthropic/v1");
  assert.equal(normalizeAtlasClaudeBase("https://api.anthropic.com/v1/messages"), "https://api.anthropic.com/v1");
  // 裸域名 / 尾斜杠 / v1beta
  assert.equal(normalizeAtlasClaudeBase("https://api.anthropic.com"), "https://api.anthropic.com/v1");
  assert.equal(normalizeAtlasClaudeBase("https://api.minimaxi.com/anthropic/"), "https://api.minimaxi.com/anthropic/v1");
  assert.equal(normalizeAtlasClaudeBase("https://gw.example.com/v1beta"), "https://gw.example.com/v1");
  // 用户自建子路径视为有意为之，只补 /v1
  assert.equal(normalizeAtlasClaudeBase("https://gw.example.com/claude"), "https://gw.example.com/claude/v1");
  // 空值与非法输入
  assert.equal(normalizeAtlasClaudeBase(""), "");
  assert.equal(normalizeAtlasClaudeBase(null), "");
  assert.equal(normalizeAtlasClaudeBase("not-a-url"), "not-a-url");
});

test("createStProxyFetch：X-Atlas-Api-Format: claude → claude 源映射（reverse_proxy + proxy_password）", async () => {
  const captured = [];
  const fakeFetch = async (input, init) => {
    captured.push({ input: typeof input === "string" ? input : input.toString(), init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
  };
  const proxied = createStProxyFetch({ getContext: () => ({ getRequestHeaders: () => ({ "X-CSRF": "t" }) }), fetchFn: fakeFetch });
  // 引擎对 claude 端点也会先 buildAtlasChatUrl 拼上 /chat/completions，代理层负责剥掉
  await proxied("https://api.minimaxi.com/anthropic/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-cp-abc", "X-Atlas-Api-Format": "claude" },
    body: JSON.stringify({ model: "MiniMax-M3", messages: [{ role: "user", content: "hi" }], stream: false }),
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].input, ATLAS_ST_GENERATE_PATH);
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.chat_completion_source, "claude");
  assert.equal(body.reverse_proxy, "https://api.minimaxi.com/anthropic/v1");
  assert.equal(body.proxy_password, "sk-cp-abc", "claude 源 proxy_password 收裸密钥（无 Bearer 前缀）");
  assert.equal(body.custom_url, "https://api.minimaxi.com/anthropic/chat/completions");
  assert.equal(body.model, "MiniMax-M3");
});

test("createStProxyFetch：无协议头 → 维持 custom 源（0.9.14 shujuku 同款：reverse_proxy=原始端点，proxy_password 空串）", async () => {
  const captured = [];
  const fakeFetch = async (input, init) => {
    captured.push({ init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
  };
  const proxied = createStProxyFetch({ getContext: () => ({ getRequestHeaders: () => ({}) }), fetchFn: fakeFetch });
  await proxied("https://api.example.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-api-xyz" },
    body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }], stream: false }),
  });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.chat_completion_source, "custom");
  // 0.9.14 全抄 shujuku buildCustomApiRequestBody_ACU：custom 源 reverse_proxy = custom_url、proxy_password 空串
  assert.equal(body.reverse_proxy, "https://api.example.com/v1/chat/completions");
  assert.equal(body.proxy_password, "");
  // 无 xAtlasCustomUrl 时 custom_url 回退引擎 URL
  assert.equal(body.custom_url, "https://api.example.com/v1/chat/completions");
  assert.equal(body.custom_include_headers, "Authorization: Bearer sk-api-xyz");
});

test("callAtlasWorldTurnApi：apiFormat claude → 请求带 X-Atlas-Api-Format 头；openai 不带", async () => {
  const seen = [];
  const fetchOk = async (input, init) => {
    seen.push(init?.headers ?? {});
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
  };
  const base = { injectionText: "c", userText: "u", assistantText: "a" };
  await callAtlasWorldTurnApi(
    { name: "t", endpoint: "https://api.minimaxi.com/anthropic", model: "MiniMax-M3", apiKey: "sk-cp-abc", apiFormat: "claude" },
    base,
    { fetchFn: fetchOk },
  );
  assert.equal(seen[0]["X-Atlas-Api-Format"], "claude");
  await callAtlasWorldTurnApi(
    { name: "t", endpoint: "https://api.example.com/v1", model: "m1", apiKey: "k" },
    base,
    { fetchFn: fetchOk },
  );
  assert.equal(seen[1]["X-Atlas-Api-Format"], undefined);
});

// ---------------------------------------------------------------------------
// 0.9.13 全抄 shujuku：gemini 源映射 + 高级字段（include/exclude body / 附加标头 / 后处理）
// ---------------------------------------------------------------------------

test("normalizeAtlasGeminiBase：剥版本段与路径尾巴，不补任何后缀", () => {
  assert.equal(normalizeAtlasGeminiBase("https://generativelanguage.googleapis.com/v1beta"), "https://generativelanguage.googleapis.com");
  assert.equal(normalizeAtlasGeminiBase("https://gw.example.com/v1beta/chat/completions"), "https://gw.example.com");
  assert.equal(normalizeAtlasGeminiBase("https://gw.example.com/v1/"), "https://gw.example.com");
  assert.equal(normalizeAtlasGeminiBase("https://gw.example.com/gemini"), "https://gw.example.com/gemini", "协议根保留");
  assert.equal(normalizeAtlasGeminiBase(""), "");
  assert.equal(normalizeAtlasGeminiBase(null), "");
});

test("normalizeAtlasExcludeBody：裸字段名 → '- key' YAML 行；已是 YAML/JSON 形状原样", () => {
  assert.equal(normalizeAtlasExcludeBody("top_p, reasoning_effort"), "- top_p\n- reasoning_effort");
  assert.equal(normalizeAtlasExcludeBody("top_p\nreasoning_effort"), "- top_p\n- reasoning_effort");
  assert.equal(normalizeAtlasExcludeBody("- top_p"), "- top_p");
  assert.equal(normalizeAtlasExcludeBody("[\"top_p\"]"), "[\"top_p\"]");
  assert.equal(normalizeAtlasExcludeBody("{top_p: 1}"), "{top_p: 1}");
  assert.equal(normalizeAtlasExcludeBody("  "), "");
  assert.equal(normalizeAtlasExcludeBody(42), "");
});

test("normalizeAtlasPromptPostProcessing：八值白名单，非法值回空（不携带）", () => {
  assert.equal(normalizeAtlasPromptPostProcessing("strict"), "strict");
  assert.equal(normalizeAtlasPromptPostProcessing("semi_tools"), "semi_tools");
  assert.equal(normalizeAtlasPromptPostProcessing("single"), "single");
  assert.equal(normalizeAtlasPromptPostProcessing(""), "");
  assert.equal(normalizeAtlasPromptPostProcessing("merge"), "merge");
  assert.equal(normalizeAtlasPromptPostProcessing("nonsense"), "");
  assert.equal(normalizeAtlasPromptPostProcessing(undefined), "");
});

test("createStProxyFetch：X-Atlas-Api-Format: gemini → makersuite 源（reverse_proxy 剥版本段）", async () => {
  const captured = [];
  const fakeFetch = async (input, init) => {
    captured.push({ init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
  };
  const proxied = createStProxyFetch({ getContext: () => ({ getRequestHeaders: () => ({}) }), fetchFn: fakeFetch });
  await proxied("https://generativelanguage.googleapis.com/v1beta/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer AIza-abc", "X-Atlas-Api-Format": "gemini" },
    body: JSON.stringify({ model: "gemini-2.0-flash", messages: [{ role: "user", content: "hi" }], stream: false }),
  });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.chat_completion_source, "makersuite");
  assert.equal(body.reverse_proxy, "https://generativelanguage.googleapis.com");
  assert.equal(body.proxy_password, "AIza-abc", "makersuite 源同样收裸密钥");
});

test("createStProxyFetch：xAtlas* 保留字段 → custom_include_body / custom_exclude_body / 附加标头 / post_processing，且保留字段绝不透传", async () => {
  const captured = [];
  const fakeFetch = async (input, init) => {
    captured.push({ init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
  };
  const proxied = createStProxyFetch({ getContext: () => ({ getRequestHeaders: () => ({}) }), fetchFn: fakeFetch });
  await proxied("https://api.example.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-x", "X-Atlas-Api-Format": "claude" },
    body: JSON.stringify({
      model: "m1",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      xAtlasConnectionMode: "custom",
      xAtlasProfileId: "p1",
      xAtlasBodyParams: "response_format:/n  type: json_object",
      xAtlasExcludeBodyParams: "top_p, reasoning_effort",
      xAtlasExtraHeaders: "X-Custom-Header: value",
      xAtlasPromptPostProcessing: "strict",
    }),
  });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.custom_include_body, "response_format:/n  type: json_object");
  assert.equal(body.custom_exclude_body, "- top_p\n- reasoning_effort");
  assert.equal(body.custom_prompt_post_processing, "strict");
  // 附加标头拼在 Authorization 之后（shujuku 同款：两段 filter(Boolean) join("\n")）
  assert.equal(body.custom_include_headers, "Authorization: Bearer sk-x\nX-Custom-Header: value");
  // 消费即弃：xAtlas* 一个都不许出现在发给酒馆的 body 里
  for (const key of Object.keys(body)) {
    assert.ok(!key.startsWith("xAtlas"), `保留字段 ${key} 不得透传上游`);
  }
  assert.equal(body.xAtlasBodyParams, undefined);
  assert.equal(body.xAtlasConnectionMode, undefined);
});

test("createStProxyFetch：非法 post_processing 值 → 不携带 custom_prompt_post_processing", async () => {
  const captured = [];
  const fakeFetch = async (input, init) => {
    captured.push({ init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
  };
  const proxied = createStProxyFetch({ getContext: () => ({ getRequestHeaders: () => ({}) }), fetchFn: fakeFetch });
  await proxied("https://api.example.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "m1",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      xAtlasPromptPostProcessing: "nonsense",
    }),
  });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.custom_prompt_post_processing, undefined);
});

test("callAtlasWorldTurnApi：main/profile 模式 → atlas://host 占位 + 保留字段入 body；custom 不带", async () => {
  const seen = [];
  const fetchOk = async (input, init) => {
    seen.push({ input: typeof input === "string" ? input : input.toString(), init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
  };
  const base = { injectionText: "c", userText: "u", assistantText: "a" };
  await callAtlasWorldTurnApi(
    { name: "t", endpoint: "", model: "", apiKey: "", connectionMode: "main", maxTokens: 512 },
    base,
    { fetchFn: fetchOk },
  );
  assert.equal(seen[0].input, "atlas://host", "main 模式端点仅占位");
  const mainBody = JSON.parse(seen[0].init.body);
  assert.equal(mainBody.xAtlasConnectionMode, "main");
  assert.equal(mainBody.xAtlasProfileId, undefined);

  await callAtlasWorldTurnApi(
    { name: "t", endpoint: "", model: "", apiKey: "", connectionMode: "profile", profileId: "p1", bodyParams: "k: v", excludeBodyParams: "top_p", requestHeaders: "X-A: b", promptPostProcessing: "merge" },
    base,
    { fetchFn: fetchOk },
  );
  assert.equal(seen[1].input, "atlas://host");
  const profileBody = JSON.parse(seen[1].init.body);
  assert.equal(profileBody.xAtlasConnectionMode, "profile");
  assert.equal(profileBody.xAtlasProfileId, "p1");
  assert.equal(profileBody.xAtlasBodyParams, "k: v");
  assert.equal(profileBody.xAtlasExcludeBodyParams, "top_p");
  assert.equal(profileBody.xAtlasExtraHeaders, "X-A: b");
  assert.equal(profileBody.xAtlasPromptPostProcessing, "merge");

  await callAtlasWorldTurnApi(
    { name: "t", endpoint: "https://api.example.com/v1/chat/completions", model: "m1", apiKey: "k", connectionMode: "custom" },
    base,
    { fetchFn: fetchOk },
  );
  const customBody = JSON.parse(seen[2].init.body);
  assert.equal(seen[2].input, "https://api.example.com/v1/chat/completions");
  assert.equal(customBody.xAtlasConnectionMode, undefined, "custom 模式不带路由保留字段");
});

// ---------------------------------------------------------------------------
// 0.9.14 全盘对齐 shujuku 请求构造（逐字段同构）+ MiniMax 订阅密钥自动救场
// ---------------------------------------------------------------------------

test("callAtlasWorldTurnApi：请求体逐字段同构 shujuku buildCustomApiRequestBody_ACU", async () => {
  const bodies = [];
  const fetchOk = async (input, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
  };
  await callAtlasWorldTurnApi(
    { name: "t", endpoint: "https://api.example.com/v1", model: "models/MiniMax-M3", apiKey: "k" },
    { injectionText: "c", userText: "u", assistantText: "a" },
    { fetchFn: fetchOk },
  );
  const b = bodies[0];
  // shujuku 字段口径：默认值 + 显式 false + 空数组 + role 小写 + models/ 前缀剥离
  assert.equal(b.model, "MiniMax-M3", "strip models/ 前缀（shujuku 同款）");
  assert.deepEqual(
    b.messages.map((m) => m.role),
    ["system", "assistant", "user", "assistant", "user", "assistant", "user", "assistant"],
    "0.9.39 多轮分段默认（shujuku 剧情推进同款 user/assistant 交替）",
  );
  assert.equal(b.max_tokens, 20_000, "maxTokens 缺省 20000（shujuku 同款）");
  assert.equal(b.temperature, 1.0, "temperature 缺省 1.0");
  assert.equal(b.top_p, 0.95, "top_p 缺省 0.95（shujuku 同款）");
  assert.equal(b.stream, false);
  assert.deepEqual(b.group_names, []);
  assert.equal(b.include_reasoning, false);
  assert.equal(b.reasoning_effort, "medium");
  assert.equal(b.enable_web_search, false);
  assert.equal(b.request_images, false);
  assert.equal(b.xAtlasCustomUrl, "https://api.example.com/v1", "原始端点随 body 下发（代理层用作 custom_url）");
});

test("createStProxyFetch：xAtlasCustomUrl → custom_url/reverse_proxy 发用户原始端点（shujuku 同构）", async () => {
  const captured = [];
  const fakeFetch = async (input, init) => {
    captured.push({ init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
  };
  const proxied = createStProxyFetch({ getContext: () => ({ getRequestHeaders: () => ({}) }), fetchFn: fakeFetch });
  await proxied("https://api.example.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-x" },
    body: JSON.stringify({
      model: "m1",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      xAtlasCustomUrl: "https://api.example.com/v1",
    }),
  });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.chat_completion_source, "custom");
  assert.equal(body.custom_url, "https://api.example.com/v1", "custom_url = 用户原始端点，ST 后端自行拼接");
  assert.equal(body.reverse_proxy, "https://api.example.com/v1", "custom 源也带 reverse_proxy（shujuku buildCustomApiRequestBody_ACU 同款）");
  assert.equal(body.proxy_password, "");
});

test("callAtlasWorldTurnApi：MiniMax 订阅密钥 Not Found → 自动换 anthropic 路由救场成功（notice 落档）", async () => {
  const seen = [];
  const fetchFn = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = JSON.parse(init.body);
    seen.push({ url, format: init.headers?.["X-Atlas-Api-Format"] ?? null, body });
    if (url.includes("/anthropic")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "救场成功" } }] }) };
    }
    // 模拟 MiniMax 官方对订阅密钥打 /v1/chat/completions 的 Not Found（HTTP 200 包错误 JSON）
    return { ok: true, status: 200, text: async () => JSON.stringify({ error: { message: "Not Found" }, quota_error: false }) };
  };
  const result = await callAtlasWorldTurnApi(
    { name: "t", endpoint: "https://api.minimaxi.com/v1", model: "MiniMax-M3", apiKey: "sk-cp-sub" },
    { injectionText: "c", userText: "u", assistantText: "a" },
    { fetchFn },
  );
  assert.equal(result.ok, true);
  assert.equal(result.text, "救场成功");
  assert.match(result.notice ?? "", /anthropic/);
  assert.equal(seen.length, 2, "两次请求：原路径 + 救场");
  assert.equal(seen[1].url, "https://api.minimaxi.com/anthropic/chat/completions");
  assert.equal(seen[1].format, "claude", "救场请求带 claude 协议头");
});

test("callAtlasWorldTurnApi：非 MiniMax 域 / 非 sk-cp- 密钥 / claude 协议 → 不触发救场", async () => {
  const makeFetch = () => {
    const calls = [];
    const fetchFn = async (input, init) => {
      calls.push(1);
      return { ok: true, status: 200, text: async () => JSON.stringify({ error: { message: "Not Found" }, quota_error: false }) };
    };
    return { fetchFn, calls };
  };

  // 非 MiniMax 域
  let t = makeFetch();
  let r = await callAtlasWorldTurnApi(
    { name: "t", endpoint: "https://api.example.com/v1", model: "m", apiKey: "sk-cp-sub" },
    { injectionText: "c", userText: "u", assistantText: "a" },
    { fetchFn: t.fetchFn },
  );
  assert.equal(t.calls.length, 1);
  assert.equal(r.ok, false);

  // 非 sk-cp- 密钥
  t = makeFetch();
  r = await callAtlasWorldTurnApi(
    { name: "t", endpoint: "https://api.minimaxi.com/v1", model: "m", apiKey: "sk-api-pay" },
    { injectionText: "c", userText: "u", assistantText: "a" },
    { fetchFn: t.fetchFn },
  );
  assert.equal(t.calls.length, 1);
  assert.equal(r.ok, false);

  // 已是 claude 协议
  t = makeFetch();
  r = await callAtlasWorldTurnApi(
    { name: "t", endpoint: "https://api.minimaxi.com/anthropic", model: "m", apiKey: "sk-cp-sub", apiFormat: "claude" },
    { injectionText: "c", userText: "u", assistantText: "a" },
    { fetchFn: t.fetchFn },
  );
  assert.equal(t.calls.length, 1);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// 0.9.16 内容替换规则库接管 think 剥离（0.9.15 的解析层强制剥离已撤——预制规则可关才成立）
// 引擎流程等价：applyContentReplaceRules(text, settings.contentReplaceRules) → parseAtlasWorldTurnDraft
// ---------------------------------------------------------------------------

const VALID_DRAFT = JSON.stringify({ summary: "捏了脸", duration: 1, npcChanges: [] });
const { applyContentReplaceRules, DEFAULT_CONTENT_REPLACE_RULES } = await import("../src/atlas-content-replace.ts");
const builtinRules = DEFAULT_CONTENT_REPLACE_RULES.map((rule, index) => ({ ...rule, id: `cr-builtin-${index + 1}` }));

test("替换规则：<think>…</think> 包着的 JSON 经预制规则后正常解析（MiniMax-M3 实测形状）", () => {
  const text = `<think>Let me analyze this turn carefully to produce the structured JSON output.\n\n**Context Summary:**\n- World time: Period 0</think>\n${VALID_DRAFT}`;
  const draft = parseAtlasWorldTurnDraft(applyContentReplaceRules(text, builtinRules));
  assert.equal(draft.summary, "捏了脸");
});

test("替换规则：<thinking> 变体 + json 围栏混合也剥", () => {
  const text = `<thinking>推理中…</thinking>\n\`\`\`json\n${VALID_DRAFT}\n\`\`\``;
  const draft = parseAtlasWorldTurnDraft(applyContentReplaceRules(text, builtinRules));
  assert.equal(draft.summary, "捏了脸");
});

test("替换规则：规则可关——0.9.25 容错抢救下停用规则仍可解析，但 think 正文残留进摘要（预制与手动同库平等）", () => {
  // 0.9.25 shujuku 容错口径：think 不再剥时括号配平仍能从杂讯里抢救 JSON——
  // 但 think 里若含花括号杂讯会先被当成 JSON 候选，规则的「净化」价值体现在干净摘要上。
  const thinkWithJunk = `<think>{"bad": true} 推理中</think>${VALID_DRAFT}`;
  const text = `<think>推理中</think>${VALID_DRAFT}`;
  const disabled = builtinRules.map((r) => (r.start === "<think" && r.end === "</think>" ? { ...r, enabled: false } : r));
  const stillOn = builtinRules.map((r) => (r.start === "<think" && r.end === "</think>" ? { ...r, enabled: true } : r));
  // 规则关：无花括号杂讯 → 抢救成功、摘要干净；有花括号杂讯 → 抢救失败（杂讯对象缺 summary）
  const draftOff = parseAtlasWorldTurnDraft(applyContentReplaceRules(text, disabled));
  assert.equal(draftOff.summary, "捏了脸", "关掉的规则不再剥，但配平抢救出干净 JSON");
  assert.throws(() => parseAtlasWorldTurnDraft(applyContentReplaceRules(thinkWithJunk, disabled)), /缺少 summary/, "think 内花括号杂讯先被当成候选 → 缺摘要失败");
  const draft = parseAtlasWorldTurnDraft(applyContentReplaceRules(thinkWithJunk, stillOn));
  assert.equal(draft.summary, "捏了脸", "开着的规则正常剥——杂讯被规则清除后解析成功");
});

test("替换规则：未闭合 <think>（shujuku 同款：孤立开始词不删）→ 解析报错", () => {
  const text = `<think>只有推理没有正文`;
  assert.throws(() => parseAtlasWorldTurnDraft(applyContentReplaceRules(text, builtinRules)), /不是合法的 JSON 对象/);
});

test("替换规则：无 think 的普通输出不受影响；嵌套词对整体删除", () => {
  const draft = parseAtlasWorldTurnDraft(applyContentReplaceRules(VALID_DRAFT, builtinRules));
  assert.equal(draft.summary, "捏了脸");
  const nested = applyContentReplaceRules(`A<think>B<think>C</think>D</think>E`, builtinRules.filter((r) => r.start === "<think" && r.end === "</think>"));
  assert.equal(nested, "AE", "栈式配对：嵌套段整体删除");
});

test("0.9.29 动向扩展：npcChanges 支持 moveEntity / setFlag 映射（白名单二次校验仍把关）", () => {
  const text = JSON.stringify({
    duration: 2,
    locationChange: null,
    npcChanges: [
      { entityId: "npc-1", toPointId: "point-9", toRegionId: "region-3" },
      { entityId: "npc-2", pointId: "point-7" },
      { flag: "storm-passed", value: "yes" },
      { flag: "curse-lifted" },
      { entityId: "npc-3", key: "mood", value: "放松" },
      { entityId: "npc-4", tag: "负伤" },
      { entityId: "npc-5", targetEntityId: "npc-6", key: "trust", value: 3 },
    ],
    memoryDrafts: [],
    summary: "林拾移步远镇；商会风_flag。",
  });
  const draft = parseAtlasWorldTurnDraft(text);
  assert.deepEqual(
    draft.rawEffects,
    [
      { kind: "moveEntity", entityId: "npc-1", pointId: "point-9", regionId: "region-3" },
      { kind: "moveEntity", entityId: "npc-2", pointId: "point-7" },
      { kind: "setFlag", key: "storm-passed", value: "yes" },
      { kind: "setFlag", key: "curse-lifted" },
      { kind: "setTemporalField", entityId: "npc-3", key: "mood", value: "放松" },
      { kind: "addTag", entityId: "npc-4", tag: "负伤" },
      { kind: "adjustRelation", entityId: "npc-5", targetEntityId: "npc-6", key: "trust", value: 3 },
    ],
    "七种形状全部映射到白名单 effect",
  );
});

test("0.9.31 解析：newLocations 名称制清单（坏条目丢弃计数，不整单炸）", () => {
  const draft = parseAtlasWorldTurnDraft(JSON.stringify({
    duration: 1,
    npcChanges: [],
    memoryDrafts: [],
    newLocations: [
      { name: "钟楼", regionName: "旧城区", description: "立在潮门旁。" },
      { regionName: "没名字的不算" },
      "junk",
    ],
    summary: "提到钟楼。",
  }));
  assert.equal(draft.newLocations.length, 1, "合法条目保留");
  assert.equal(draft.newLocations[0].name, "钟楼");
  assert.equal(draft.newLocations[0].regionName, "旧城区");
  assert.ok(draft.summary.includes("2 条残缺新地点"), "坏条目丢弃计数进摘要");
});

// ---------------------------------------------------------------------------
// 0.9.18 分段提示词：promptSegments 逐段装配 + 占位符替换；全非法回退旧两条
// ---------------------------------------------------------------------------

test("callAtlasWorldTurnApi：promptSegments 装配消息数组，占位符替换，非法段剔除", async () => {
  let capturedBody = null;
  const fetchFn = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{}" } }] }) };
  };
  const input = { injectionText: "世界上下文A", userText: "用户行动B", assistantText: "回复C" };
  const result = await callAtlasWorldTurnApi(
    {
      name: "t", endpoint: "https://api.example.com/v1/chat/completions", model: "m1", apiKey: "",
      promptSegments: [
        { role: "system", content: "你是推演引擎，{{userAction}} 是本轮行动。" },
        { role: "user", content: "状态：{{worldState}}\n回复：{{assistantReply}}" },
        { role: "assistant", content: "好的，我会只输出 JSON。" },
        { role: "carrier", content: "非法角色应被剔除" },
        { role: "user", content: "   " },
      ],
    },
    input,
    { fetchFn },
  );
  assert.ok(result.ok, result.ok ? "分段请求成功" : `分段请求应成功：${result.message}`);
  const messages = capturedBody.messages;
  assert.equal(messages.length, 3, "非法角色与空白段被剔除");
  assert.equal(messages[0].role, "system");
  assert.equal(messages[2].role, "assistant");
  assert.ok(messages[0].content.includes("用户行动B"), "{{userAction}} 已替换");
  assert.ok(messages[1].content.includes("世界上下文A"), "{{worldState}} 已替换");
  assert.ok(messages[1].content.includes("回复C"), "{{assistantReply}} 已替换");
  assert.ok(!messages.some((m) => m.content.includes("{{")), "消息中无残留占位符");

  // 全部段非法 → 回退整套内置默认分段（0.9.39 多轮结构：8 段）
  await callAtlasWorldTurnApi(
    { name: "t", endpoint: "https://api.example.com/v1/chat/completions", model: "m1", apiKey: "", promptSegments: [{ role: "dragon", content: "x" }] },
    input,
    { fetchFn },
  );
  assert.equal(capturedBody.messages.length, 8, "全非法回退整套内置默认（8 段）");
  assert.ok(capturedBody.messages[0].content.includes("阿特拉斯世界推演引擎"), "回退内置默认 system");

  // 无 promptSegments → 同样使用整套内置默认分段
  await callAtlasWorldTurnApi(
    { name: "t", endpoint: "https://api.example.com/v1/chat/completions", model: "m1", apiKey: "" },
    input,
    { fetchFn },
  );
  assert.equal(capturedBody.messages.length, 8, "无分段使用内置默认 8 段");
  assert.equal(capturedBody.messages[capturedBody.messages.length - 1].content, "{", "末段输出引导（JSON prefill）");

  // 0.9.21 世界书资料块：loreSupplement 非空 → 资料进「背景设定」段（$1）；{{worldLore}} 可引用
  await callAtlasWorldTurnApi(
    { name: "t", endpoint: "https://api.example.com/v1/chat/completions", model: "m1", apiKey: "" },
    { ...input, loreSupplement: "- 低语森林：卡书里的地点描述" },
    { fetchFn },
  );
  assert.equal(capturedBody.messages.length, 8, "带资料仍是整套默认分段");
  const loreSegment = capturedBody.messages.find((m) => m.content.includes("【世界书资料（当前角色卡"));
  assert.ok(loreSegment, "资料块进入背景设定段");
  assert.ok(loreSegment.content.includes("低语森林"), "资料内容进正文");
  assert.ok(loreSegment.content.includes("用户行动B") === false, "背景段不混入本轮素材（$8 在触发段）");

  await callAtlasWorldTurnApi(
    {
      name: "t", endpoint: "https://api.example.com/v1/chat/completions", model: "m1", apiKey: "",
      promptSegments: [{ role: "user", content: "资料：{{worldLore}}｜状态：{{worldState}}" }],
    },
    { ...input, loreSupplement: "卡书条目X" },
    { fetchFn },
  );
  assert.ok(capturedBody.messages[0].content.includes("资料：卡书条目X"), "{{worldLore}} 已替换");
  assert.ok(!capturedBody.messages[0].content.includes("【世界书资料（当前角色卡"), "分段模式下资料块只走占位符不重复追加");

  // 无 supplement → 无资料块（占位符空值原样删除）
  await callAtlasWorldTurnApi(
    { name: "t", endpoint: "https://api.example.com/v1/chat/completions", model: "m1", apiKey: "" },
    input,
    { fetchFn },
  );
  assert.ok(!capturedBody.messages.some((m) => m.content.includes("【世界书资料（当前角色卡")), "无 supplement 不出现资料块");
});
