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
 * 0.9.10 Claude 协议（shujuku 同款）：引擎核心带 X-Atlas-Api-Format: claude 头时改映射为
 *   { chat_completion_source: "claude", reverse_proxy: <归一化基址（补 /v1）>,
 *     proxy_password: <裸密钥>, custom_url, model, messages, ... }
 *   由酒馆后端做 Anthropic 变形（MiniMax 订阅密钥走 /anthropic 即靠这条路）。
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

/**
 * Claude（Anthropic Messages）反向代理基址归一化（0.9.10，照搬 shujuku
 * normalizeSTNativeProxyBase_ACU 的 claude 分支语义）：
 * 原版 ST claude 源 fetch(apiUrl + '/messages')，基址须含 /v1（ST 官方常量即
 * https://api.anthropic.com/v1）。剥显式协议路径段防重复（/messages、/v1beta 等），
 * 并按 ST 惯例补 /v1；不改写用户自建代理的其他子路径段。
 * 例：https://api.minimaxi.com/anthropic → https://api.minimaxi.com/anthropic/v1
 */
export function normalizeAtlasClaudeBase(rawUrl: unknown): string {
  let base = String(rawUrl || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  for (const suffix of ["/chat/completions", "/messages", "/responses", "/interactions"]) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length).replace(/\/+$/, "");
      break;
    }
  }
  if (base.endsWith("/v1beta")) base = base.slice(0, -"/v1beta".length).replace(/\/+$/, "");
  let path = "";
  try {
    path = new URL(base).pathname.replace(/\/+$/, "");
  } catch {
    return base; // 非法 URL 原样透传，交由后端报错
  }
  if (path === "" || path === "/") return `${base}/v1`;
  if (!base.endsWith("/v1")) return `${base}/v1`;
  return base;
}

/**
 * Gemini（makersuite 源）反向代理基址归一化（0.9.13，shujuku makersuite 分支同款语义）：
 * 原版 ST makersuite 源 fetch(`${apiUrl}/${apiVersion}/models/...`)，服务端自补 /v1beta
 * ——基址**不得带版本段**（剥 /v1beta、/v1 与显式协议路径段）。
 */
export function normalizeAtlasGeminiBase(rawUrl: unknown): string {
  let base = String(rawUrl || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  // 引擎会拼 /chat/completions，用户端点又自带版本段 → 循环剥到没有可剥后缀
  for (let changed = true; changed && base; ) {
    changed = false;
    for (const suffix of ["/chat/completions", "/messages", "/responses", "/interactions", "/v1beta", "/v1"]) {
      if (base.endsWith(suffix)) {
        base = base.slice(0, -suffix.length).replace(/\/+$/, "");
        changed = true;
        break;
      }
    }
  }
  return base;
}

/** custom_exclude_body 归一化（shujuku 同款）：裸字段名（逗号 / 换行分隔）→ "- key" YAML 行；已是 YAML/JSON 形状则原样。 */
export function normalizeAtlasExcludeBody(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("- ") || trimmed.startsWith("[") || trimmed.startsWith("{")) return trimmed;
  const keys = trimmed.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  return keys.map((key) => `- ${key}`).join("\n");
}

/** 提示词后处理白名单（SillyTavern custom_prompt_post_processing 全集；"" = 不携带）。 */
export function normalizeAtlasPromptPostProcessing(raw: unknown): string {
  const allowed = ["", "merge_tools", "semi_tools", "strict_tools", "merge", "semi", "strict", "single"];
  return typeof raw === "string" && allowed.includes(raw) ? raw : "";
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
  // 0.9.13 宿主适配保留字段（引擎下发，代理层消费后绝不透传上游）
  xAtlasConnectionMode?: unknown;
  xAtlasProfileId?: unknown;
  xAtlasBodyParams?: unknown;
  xAtlasExcludeBodyParams?: unknown;
  xAtlasExtraHeaders?: unknown;
  xAtlasPromptPostProcessing?: unknown;
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

/** 引擎核心经请求头声明的接口协议（X-Atlas-Api-Format: claude / gemini）。 */
function pickAtlasApiFormat(headers: unknown): "claude" | "gemini" | null {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  const record = headers as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === "x-atlas-api-format" && typeof value === "string") {
      const format = value.trim().toLowerCase();
      if (format === "claude" || format === "gemini") return format;
    }
  }
  return null;
}

/** "Bearer xxx" → "xxx"（claude 源 proxy_password 收裸密钥，shujuku 同款）。 */
function stripBearerPrefix(authorization: string | null): string {
  if (!authorization) return "";
  return authorization.replace(/^Bearer\s+/i, "");
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
    const apiFormat = pickAtlasApiFormat(init?.headers);
    const csrfHeaders = deps.getContext().getRequestHeaders() ?? {};

    // 0.9.13 宿主适配保留字段（消费即弃，绝不透传上游）
    const bodyParams = typeof payload.xAtlasBodyParams === "string" ? payload.xAtlasBodyParams.trim() : "";
    const excludeBody = typeof payload.xAtlasExcludeBodyParams === "string" ? payload.xAtlasExcludeBodyParams : "";
    const extraHeaders = typeof payload.xAtlasExtraHeaders === "string" ? payload.xAtlasExtraHeaders.trim() : "";
    const promptPost = normalizeAtlasPromptPostProcessing(payload.xAtlasPromptPostProcessing);

    // claude / gemini 协议（shujuku 同款映射）：映射到酒馆原生协议源，服务端做协议变形。
    // claude → chat_completion_source:"claude"（基址补 /v1，x-api-key=proxy_password）；
    // gemini → "makersuite"（基址剥版本段，服务端自补 /v1beta）。
    const nativeBase = apiFormat === "claude"
      ? normalizeAtlasClaudeBase(url)
      : apiFormat === "gemini"
        ? normalizeAtlasGeminiBase(url)
        : null;
    const nativeSource = apiFormat === "claude" ? "claude" : apiFormat === "gemini" ? "makersuite" : null;

    // custom_include_headers：Authorization 在前 + 附加标头（shujuku 同款拼接口径，原始头字符串）
    const includeHeaders = [atlasCustomIncludeHeaders(authorization), extraHeaders].filter(Boolean).join("\n");

    const proxyBody: Record<string, unknown> = {
      chat_completion_source: nativeSource ?? "custom",
      ...(nativeBase ? { reverse_proxy: nativeBase } : {}),
      ...(nativeBase ? { proxy_password: stripBearerPrefix(authorization) } : {}),
      custom_url: url,
      model: payload.model,
      messages: payload.messages,
      stream: payload.stream ?? false,
      ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
      ...(payload.max_tokens !== undefined ? { max_tokens: payload.max_tokens } : {}),
      custom_include_headers: includeHeaders,
      ...(bodyParams ? { custom_include_body: bodyParams } : {}),
      ...(excludeBody.trim() ? { custom_exclude_body: normalizeAtlasExcludeBody(excludeBody) } : {}),
      ...(promptPost ? { custom_prompt_post_processing: promptPost } : {}),
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
