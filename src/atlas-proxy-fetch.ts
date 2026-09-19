/**
 * atlas-proxy-fetch.ts — ATLAS-09 推演请求 → 酒馆后端代理适配层。
 *
 * 引擎核心 callAtlasWorldTurnApi 直接向预设 endpoint（用户的 OpenAI 兼容地址）发
 * POST { model, messages, stream:false, temperature?, max_tokens? } + Authorization: Bearer。
 * 浏览器里直连第三方端点会被 CORS 拦截，因此注入本 fetchFn 把请求改写为酒馆自带代理：
 *
 *   POST /api/backends/chat-completions/generate
 *   { chat_completion_source: "custom", custom_url: <原地址>, model, messages, stream:false,
 *     temperature?, max_tokens?, custom_include_headers: "Authorization: Bearer <key>" }
 *
 * 契约依据（2026-09-17 上游源码实测，release 分支 chat-completions.js）：
 * - :2394-2410 CUSTOM 分支：apiUrl=custom_url；密钥读服务端 secret（CUSTOM 豁免缺失检查 :2615）；
 *   mergeObjectWithYaml(bodyParams, custom_include_body)；mergeObjectWithYaml(headers, custom_include_headers)。
 *   custom_include_headers 只接受**原始头字符串**（按行解析；传对象 = 头被静默丢弃，
 *   0.9.1 及之前生成路径的真实缺陷，ATLAS-FIX-02 修复）。
 *   → 我们把密钥放进 custom_include_headers，由代理合并进上游请求头，服务端无需预存 secret。
 * - 非流式响应原样透传上游 JSON（→ response.json() 兼容）。
 * - CSRF：酒馆 /api 路由要求 token，经 context().getRequestHeaders() 合并（P0-05 同模式）。
 *
 * 安全：明文密钥只出现在请求体 custom_include_headers 内（酒馆代理自身就是这样转交的），
 * 绝不放进外层请求头；日志不含密钥（核心日志只记长度与状态码）。
 */

export const ATLAS_ST_GENERATE_PATH = "/api/backends/chat-completions/generate";

/**
 * custom_include_headers 的**唯一序列化口径**（ATLAS-FIX-02）：
 * 酒馆后端经 `mergeObjectWithYaml` 按行解析该字段——只接受「原始头字符串」
 * （shujuku 同款口径）。传对象会被**静默丢弃**，上游收不到 Authorization。
 * - 有值 → `Authorization: <headerValue>`（headerValue 通常已是 "Bearer xxx"）
 * - 无值 → ""（空字符串，绝不能是对象 / undefined）
 * 模型列表（index.js loadModels → /status）与生成（/generate）共用本函数。
 */
export function atlasCustomIncludeHeaders(headerValue: string | null | undefined): string {
  const value = (headerValue ?? "").trim();
  return value ? `Authorization: ${value}` : "";
}

export interface StProxyFetchDeps {
  /** 通常 = SillyTavern.getContext；测试注入 fake。 */
  getContext(): { getRequestHeaders(): Record<string, string> };
  /** 实际发请求的 fetch（默认 globalThis.fetch；测试注入捕获型 fake）。 */
  fetchFn?: typeof fetch;
}

interface ChatCompletionBody {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  temperature?: unknown;
  max_tokens?: unknown;
}

function pickAuthorization(headers: unknown): string | null {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  const record = headers as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === "authorization" && typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

export function createStProxyFetch(deps: StProxyFetchDeps): typeof fetch {
  const innerFetch = deps.fetchFn ?? globalThis.fetch.bind(globalThis);

  return async function atlasProxiedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "POST").toUpperCase();

    let payload: ChatCompletionBody | null = null;
    if (method === "POST" && typeof init?.body === "string" && init.body.trimStart().startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(init.body);
        if (
          parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
          "model" in parsed && "messages" in parsed
        ) {
          payload = parsed as ChatCompletionBody;
        }
      } catch {
        payload = null;
      }
    }

    // 非 chat-completions 载荷：原样透传，不猜测不改写
    if (!payload) {
      return innerFetch(input, init);
    }

    const authorization = pickAuthorization(init?.headers);
    const csrfHeaders = deps.getContext().getRequestHeaders() ?? {};

    const proxyBody: Record<string, unknown> = {
      chat_completion_source: "custom",
      custom_url: url,
      model: payload.model,
      messages: payload.messages,
      stream: payload.stream ?? false,
      ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
      ...(payload.max_tokens !== undefined ? { max_tokens: payload.max_tokens } : {}),
      custom_include_headers: atlasCustomIncludeHeaders(authorization),
    };

    return innerFetch(ATLAS_ST_GENERATE_PATH, {
      method: "POST",
      headers: {
        ...csrfHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(proxyBody),
      signal: init?.signal,
    });
  };
}
