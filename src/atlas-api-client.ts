/**
 * atlas-api-client.ts — Atlas 独立推演 API 客户端（服务端安全模块）。
 *
 * 职责边界（上级 README 第 4.3 / 7 节）：
 * - OpenAI 兼容 chat/completions 单请求调用；密钥只进 Authorization 头，
 *   结果、错误与日志**绝不携带 apiKey 或完整 endpoint**。
 * - 错误分类映射到契约稳定错误码：401/403→API_AUTH_FAILED、404→API_NOT_FOUND、
 *   429→API_RATE_LIMITED、超时→API_TIMEOUT、断网→SERVICE_OFFLINE、
 *   5xx/其他→API_REQUEST_FAILED、非 JSON / 空→RESPONSE_MALFORMED。
 * - 模型输出按不可信数据解析：只能产出 AtlasWorldChangeDraft 形状；
 *   JSON 损坏或缺摘要直接 RESPONSE_MALFORMED，绝不猜测。
 * - 本文件保持零 DOM、零文件系统；fetch 由调用方注入以便 mock。
 */

import type { AtlasWorldChangeDraft } from "./atlas-turn.ts";
import {
  ATLAS_ERROR_CODES,
  ATLAS_LIMITS,
  AtlasError,
  type AtlasErrorCode,
} from "./atlas-contract.ts";

/** 独立推演预设（服务端保存；apiKey 永不出本模块的 Authorization 头）。 */
export interface AtlasApiPreset {
  name: string;
  endpoint: string;
  model: string;
  apiKey: string;
  maxTokens?: number;
  temperature?: number;
  /** top_p（0.9.14 全抄 shujuku buildCustomApiRequestBody_ACU；缺省 0.95）。 */
  topP?: number;
  timeoutMs?: number;
  /** 自定义系统提示词；留空 / 省略 = 使用内置默认（DEFAULT_WORLD_TURN_SYSTEM_PROMPT）。 */
  systemPrompt?: string;
  /** 接口协议（0.9.13 对齐 shujuku）：缺省 openai；claude = Anthropic Messages；gemini 映射 makersuite；openai_responses 原版酒馆等同 openai。 */
  apiFormat?: "openai" | "openai_responses" | "claude" | "gemini";
  /** 连接方式（0.9.13 全抄 shujuku）：缺省 custom；main = 酒馆主 API；profile = 酒馆连接预设（由宿主适配 fetch 承接）。 */
  connectionMode?: "custom" | "main" | "profile";
  /** 酒馆连接预设模式的 profile id。 */
  profileId?: string;
  /** 附加请求体参数（custom_include_body）。 */
  bodyParams?: string;
  /** 排除请求体字段（custom_exclude_body）。 */
  excludeBodyParams?: string;
  /** 附加请求标头（每行 Header: Value）。 */
  requestHeaders?: string;
  /** 提示词后处理（custom_prompt_post_processing）；"" = 不携带。 */
  promptPostProcessing?: string;
  /** 0.9.18 分段提示词（shujuku prompt-builder 同款）：非空时取代固定 system+user 两条，逐段装配 + 占位符替换。
   *  0.9.25 升级为 shujuku promptGroup 栏位段：段可带 name / mainSlot("A"|"B"|"") / deletable（全部可选，旧形状兼容）。 */
  promptSegments?: Array<{ role: string; name?: string; mainSlot?: string; deletable?: boolean; content: string }>;
  /** 0.9.25 shujuku 占位符体系：前文上下文条数（$7 取最近 N 条 AI 楼层；宿主采集端使用，预设级设置）。 */
  contextTurnCount?: number;
}

export interface AtlasApiCallResult {
  ok: true;
  text: string;
  status: number;
  durationMs: number;
  /** 0.9.14 自动救场提示（如 MiniMax 订阅密钥自动切换 Anthropic 路由），随引擎 world-turn 日志落档。 */
  notice?: string;
}

export interface AtlasApiCallFailure {
  ok: false;
  code: AtlasErrorCode;
  /** 已脱敏、可展示给用户的错误说明 */
  message: string;
  status?: number;
  retryable: boolean;
  durationMs: number;
}

/** 归一化 endpoint → /chat/completions URL；非法返回 null（与共享网关同语义，不复制其文件依赖）。 */
export function buildAtlasChatUrl(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const cleanPath = url.pathname.replace(/\/+$/, "");
  if (cleanPath.endsWith("/chat/completions")) return url.toString();
  const base = cleanPath.replace(/\/models$/, "").replace(/\/chat$/, "");
  url.pathname = `${base}/chat/completions`;
  return url.toString();
}

/**
 * 内置默认提示词（UI「API」页可查看；预设留空时生效）。
 * 0.9.25 重写为 shujuku promptGroup 栏位段结构：主系统提示词（mainSlot A，system）+
 * 推演任务指令（mainSlot B，user），占位符发送时替换。
 * 修改输出契约（字段名 / 形状）必须同步 parseAtlasWorldTurnDraft，否则解析会整单失败。
 */
export const DEFAULT_PROMPT_SEGMENTS: Array<{ role: string; name: string; mainSlot: string; content: string }> = [
  {
    role: "system",
    name: "主系统提示词（推演引擎职责）",
    mainSlot: "A",
    content:
      "你是阿特拉斯世界推演引擎。你收到一份本轮的剧情素材（世界状态、前文、用户行动、助手回复），" +
      "你的唯一职责：推断本轮对世界造成的**有界结构化变化**——谁出现在哪里、人物状态与关系如何变化、势力格局有无变动、时间推进多少。\n" +
      "严格要求：只输出一个 JSON 对象，不要输出任何多余说明、推理过程或代码围栏。字段契约：\n" +
      "duration（本轮消耗的时段数，非负数字，≤10000）、\n" +
      "locationChange（对象或 null：{toPointId, toRegionId}，id 必须来自上下文中出现的地点）、\n" +
      "npcChanges（数组，每条形如 {entityId, key, value} 更新人物状态 / {entityId, tag} 加标签 / " +
      "{entityId, removeTag} 删标签 / {entityId, targetEntityId, key, value} 改关系；entityId 必须来自上下文）、\n" +
      "memoryDrafts（数组，每条 {entityId, text}，为人物追加一条记忆，≤500 字）、\n" +
      "eventDrafts（数组，事件摘要文字，仅叙述用）、\n" +
      "triggerResults（数组，本轮命中的触发器 id）、\n" +
      "summary（本轮世界变化的一句话摘要，≤500 字）。\n" +
      "禁止：编造上下文之外的实体 id；输出时间地点之外的世界重写；输出任何密钥、路径或代码。",
  },
  {
    role: "user",
    name: "推演任务指令（本轮素材）",
    mainSlot: "B",
    content:
      "【当前世界状态与可达内容】\n$5\n\n" +
      "$1\n" +
      "【上轮世界变化】\n$6\n\n" +
      "【前文故事发展（AI 输出）】\n$7\n\n" +
      "【用户设定】\n$U\n\n" +
      "【角色描述】\n$C\n\n" +
      "【本轮用户行动】\n$8\n\n" +
      "【本轮助手回复】\n{{assistantReply}}\n\n" +
      "请按系统要求只输出一个 JSON 对象。",
  },
];

/** 兼容旧调用方：内置默认单条系统提示词（= 栏位 A 原文）。 */
export const DEFAULT_WORLD_TURN_SYSTEM_PROMPT = DEFAULT_PROMPT_SEGMENTS[0]!.content;

export interface AtlasWorldTurnPromptInput {
  injectionText: string;
  userText: string;
  assistantText: string;
  /** 0.9.21 可选：宿主侧卡书条目有界文本（世界书资料块；缺省 = 不出现该块） */
  loreSupplement?: string;
  /** 0.9.25 shujuku 占位符体系：$6 上轮推演结果（绑定分支最后一条账本摘要；缺省 = 空串） */
  lastTurnSummary?: string;
  /** 0.9.25 shujuku 占位符体系：$7 前文上下文（最近 N 条 AI 楼层正文；缺省 = 空串） */
  recentContextText?: string;
  /** 0.9.25 shujuku 占位符体系：$U 用户设定描述（persona；缺省 = 空串） */
  personaDescription?: string;
  /** 0.9.25 shujuku 占位符体系：$C 角色描述（缺省 = 空串） */
  charDescription?: string;
}

/** 0.9.21 世界书资料块标题（只进推演请求；主聊天注入不带，避免与酒馆世界书激活重复） */
const LORE_SUPPLEMENT_HEADER = "【世界书资料（当前角色卡，可能有噪声，仅供理解世界）】";

/** shujuku 占位符包裹：<worldbook_context> 里的内容不参与剧情复述，仅供理解世界。 */
function wrapWorldbookContext(content: string): string {
  const text = String(content ?? "");
  return text ? `\n<worldbook_context>\n${text}\n</worldbook_context>\n` : "";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 0.9.25 shujuku 占位符替换引擎（照抄 plot-task-engine performReplacements 口径）：
 * $1 世界书资料（<worldbook_context> 包裹）/ $9 排除库资料（Atlas 无表格库，恒空）/ $5 世界状态 /
 * $6 上轮推演结果 / $7 前文上下文 / $8 本轮用户行动 / $U 用户设定 / $C 角色描述。
 * 空 value 原样删除占位符（shujuku 同款：空内容不留孤立标题）。
 * 兼容旧 0.9.18 别名：{{worldState}} / {{userAction}} / {{assistantReply}} / {{worldLore}}。
 */
export function substitutePromptPlaceholders(content: string, input: AtlasWorldTurnPromptInput): string {
  if (!content) return "";
  let processed = String(content);
  const loreRaw = input.loreSupplement ?? "";
  const loreText = loreRaw
    ? `${LORE_SUPPLEMENT_HEADER}${wrapWorldbookContext(loreRaw)}`
    : "";
  const replacements: Record<string, string> = {
    $1: loreText,
    $9: "",
    $5: input.injectionText ?? "",
    $6: input.lastTurnSummary ?? "",
    $7: input.recentContextText ?? "",
    $8: input.userText ?? "",
    $U: input.personaDescription ?? "",
    $C: input.charDescription ?? "",
  };
  for (const [key, value] of Object.entries(replacements)) {
    processed = processed.replace(new RegExp(`(?<!\\\\)\\${key}`, "g"), () => value);
  }
  // 旧别名兼容（0.9.18 预设零迁移）
  processed = processed
    .replace(/\{\{\s*worldState\s*\}\}/g, input.injectionText ?? "")
    .replace(/\{\{\s*userAction\s*\}\}/g, input.userText ?? "")
    .replace(/\{\{\s*worldLore\s*\}\}/g, loreRaw)
    .replace(/\{\{\s*assistantReply\s*\}\}/g, input.assistantText ?? "");
  return processed;
}

const PROMPT_MESSAGE_ROLES: readonly string[] = ["system", "user", "assistant"];

/**
 * 装配 world-turn 消息数组（0.9.25 shujuku promptGroup 栏位段模式）：
 * preset.promptSegments 非空 → 占位符替换后逐段入列（角色白名单过滤，全非法回退内置栏位组）；
 * 否则使用内置默认栏位组（主系统提示词 A + 推演任务指令 B）。
 * 输出契约不变：无论分段怎么写，模型仍须只输出一个 JSON 对象（parseAtlasWorldTurnDraft 把关）。
 */
export function buildWorldTurnMessages(preset: AtlasApiPreset, input: AtlasWorldTurnPromptInput): Array<{ role: string; content: string }> {
  const rawSegments = Array.isArray(preset.promptSegments) ? preset.promptSegments : [];
  const messages = rawSegments
    .map((segment) => ({
      role: typeof segment?.role === "string" ? segment.role.trim().toLowerCase() : "",
      content: typeof segment?.content === "string" ? segment.content : "",
    }))
    .filter((segment) => PROMPT_MESSAGE_ROLES.includes(segment.role) && segment.content.trim().length > 0)
    .map((segment) => ({ role: segment.role, content: substitutePromptPlaceholders(segment.content, input) }));
  if (messages.length > 0) return messages;
  // 无分段：连接级 systemPrompt 覆盖主系统提示词（0.9.17 语义保留），任务指令固定用内置 B 槽
  const systemContent = preset.systemPrompt?.trim() || DEFAULT_PROMPT_SEGMENTS[0]!.content;
  return [
    { role: "system", content: substitutePromptPlaceholders(systemContent, input) },
    { role: "user", content: substitutePromptPlaceholders(DEFAULT_PROMPT_SEGMENTS[1]!.content, input) },
  ].filter((segment) => segment.content.trim().length > 0);
}

function errorMessageForStatus(status: number): { code: AtlasErrorCode; retryable: boolean; message: string } {
  if (status === 401 || status === 403) {
    return { code: ATLAS_ERROR_CODES.API_AUTH_FAILED, retryable: false, message: "推演服务鉴权失败（HTTP 401/403），请检查密钥。" };
  }
  if (status === 404) {
    return { code: ATLAS_ERROR_CODES.API_NOT_FOUND, retryable: false, message: "推演服务返回 HTTP 404：API 地址或模型名可能不存在。" };
  }
  if (status === 429) {
    return { code: ATLAS_ERROR_CODES.API_RATE_LIMITED, retryable: true, message: "推演服务限流（HTTP 429），请稍后重试。" };
  }
  if (status >= 500) {
    return { code: ATLAS_ERROR_CODES.API_REQUEST_FAILED, retryable: true, message: `推演服务错误（HTTP ${status}）：酒馆后端代理没能从你的 API 端点拿到正常响应，请先在「API」页测试连接，确认端点/网关本身可用。` };
  }
  return { code: ATLAS_ERROR_CODES.API_REQUEST_FAILED, retryable: false, message: `推演服务返回 HTTP ${status}。` };
}

/**
 * 发起一次 world-turn 推演请求（恰好 1 条 HTTP 请求）。
 * fetch 由调用方注入；超时用 AbortController 实现并被分类为 API_TIMEOUT。
 */
export async function callAtlasWorldTurnApi(
  preset: AtlasApiPreset,
  input: AtlasWorldTurnPromptInput,
  deps: { fetchFn?: typeof fetch; now?: () => number } = {},
): Promise<AtlasApiCallResult | AtlasApiCallFailure> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const fail = (code: AtlasErrorCode, message: string, retryable: boolean, status?: number): AtlasApiCallFailure => ({
    ok: false,
    code,
    message,
    retryable,
    ...(typeof status === "number" ? { status } : {}),
    durationMs: now() - startedAt,
  });

  const mode = preset.connectionMode ?? "custom";
  // main / profile 模式不走自定义端点（宿主适配 fetch 承接），URL 仅作占位供日志与代理识别
  const url = mode === "custom" ? buildAtlasChatUrl(preset.endpoint) : "atlas://host";
  if (!url) return fail(ATLAS_ERROR_CODES.API_NOT_CONFIGURED, "推演 API 地址无效，无法构造请求。", false);
  if (mode === "custom" && !preset.model.trim()) return fail(ATLAS_ERROR_CODES.API_NOT_CONFIGURED, "推演预设未填写模型名称。", false);

  // 0.9.14 全抄 shujuku buildCustomApiRequestBody_ACU 的字段口径（能跑通是唯一标准）：
  // max_tokens 默认 20000 / temperature 默认 1.0 / top_p 默认 0.95 / reasoning_effort 'medium'
  // / include_reasoning·enable_web_search·request_images 显式 false / group_names 空数组；
  // role 归一小写、model 去 'models/' 前缀——与 shujuku 发出的请求逐字段同构。
  // 请求消息装配（0.9.18 分段模式优先，见 buildWorldTurnMessages）；role 归一小写与 shujuku 同款
  const bodyMessages = buildWorldTurnMessages(preset, input).map((m) => ({ ...m, role: m.role.toLowerCase() }));
  const bodyModel = preset.model.trim().replace(/^models\//, "") || "host";
  const maxTokens = typeof preset.maxTokens === "number" && preset.maxTokens > 0 ? preset.maxTokens : 20_000;
  const temperature = typeof preset.temperature === "number" ? preset.temperature : 1.0;
  const topP = typeof preset.topP === "number" ? preset.topP : 0.95;

  const timeoutMs = Math.min(Math.max(preset.timeoutMs ?? 30_000, 1_000), 120_000);
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  /** 组装 fetch 载荷（0.9.14：rescue 模式改走 Anthropic 路由）。 */
  const buildPayload = (forClaude: boolean): { url: string; headers: Record<string, string>; body: string } => {
    const requestUrl = forClaude ? rescueAnthropicUrl(url) : url;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(preset.apiKey.trim() ? { Authorization: `Bearer ${preset.apiKey.trim()}` } : {}),
      // 浏览器代理适配层据此映射为酒馆 claude / gemini 源；直连（测试）时无副作用
      ...(preset.apiFormat === "claude" || forClaude ? { "X-Atlas-Api-Format": "claude" } : {}),
      ...(preset.apiFormat === "gemini" ? { "X-Atlas-Api-Format": "gemini" } : {}),
    };
    const body = JSON.stringify({
      model: bodyModel,
      messages: bodyMessages,
      max_tokens: maxTokens,
      temperature,
      top_p: topP,
      stream: false,
      group_names: [],
      include_reasoning: false,
      reasoning_effort: "medium",
      enable_web_search: false,
      request_images: false,
      // 0.9.13 宿主适配通道（shujuku 同款能力）：代理层消费这些保留字段并映射为
      // custom_include_body / custom_exclude_body / 附加标头 / custom_prompt_post_processing，
      // 绝不透传上游；main / profile 模式据此路由到 TavernHelper / ConnectionManager。
      ...(mode !== "custom" ? { xAtlasConnectionMode: mode } : {}),
      ...(mode === "profile" && preset.profileId?.trim() ? { xAtlasProfileId: preset.profileId.trim() } : {}),
      // 0.9.14 shujuku 同款：custom_url 用「用户原始端点」，ST 后端自己决定拼接，
      // 不由引擎预拼 /chat/completions（与 shujuku 走同一条 URL 构造路径）。
      ...(mode === "custom" && preset.endpoint.trim() ? { xAtlasCustomUrl: preset.endpoint.trim() } : {}),
      ...(preset.bodyParams?.trim() ? { xAtlasBodyParams: preset.bodyParams } : {}),
      ...(preset.excludeBodyParams?.trim() ? { xAtlasExcludeBodyParams: preset.excludeBodyParams } : {}),
      ...(preset.requestHeaders?.trim() ? { xAtlasExtraHeaders: preset.requestHeaders } : {}),
      ...(preset.promptPostProcessing?.trim() ? { xAtlasPromptPostProcessing: preset.promptPostProcessing } : {}),
    });
    return { url: requestUrl, headers, body };
  };

  try {
    let response: Response;
    let rescueAttempted = false;
    const initial = buildPayload(false);
    try {
      response = await fetchFn(initial.url, {
        method: "POST",
        headers: initial.headers,
        body: initial.body,
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) return fail(ATLAS_ERROR_CODES.API_TIMEOUT, `推演请求超过 ${timeoutMs}ms 超时。`, true);
      return fail(ATLAS_ERROR_CODES.SERVICE_OFFLINE, "无法连接推演服务，请检查网络或服务状态。", true);
    }

    const parseCall = async (resp: Response): Promise<{ text: string | null; gatewayError: string | null; rawText: string; emptyChoices: boolean }> => {
      let rawText = "";
      try {
        rawText = typeof resp.text === "function" ? await resp.text() : JSON.stringify(await resp.json());
      } catch {
        rawText = "";
      }
      let payload: unknown = null;
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = firstSsePayload(rawText);
      }
      const text = extractAssistantText(payload);
      if (text === null || text.trim().length === 0) {
        // 0.9.24 空回复专项：choices 数组存在且为空（Gemini 系安全过滤静默拦截的典型形状）
        const emptyChoices = Boolean(
          payload && typeof payload === "object" &&
          Array.isArray((payload as { choices?: unknown }).choices) &&
          (payload as { choices: unknown[] }).choices.length === 0,
        );
        return { text: null, gatewayError: gatewayErrorMessage(payload), rawText, emptyChoices };
      }
      return { text: text.trim(), gatewayError: null, rawText, emptyChoices: false };
    };

    let parsed = await parseCall(response);
    let status = response.status;

    // 0.9.14 自动救场（第二层保险）：MiniMax 订阅密钥（sk-cp-）打 OpenAI 路径挨 Not Found 时，
    // 自动改走官方 Anthropic 兼容路由（origin + /anthropic）重试一次——成功即通，notice 落引擎日志；
    // 失败则保留原错误与专项提示。非 MiniMax 域 / 非 sk-cp- 密钥不做任何魔法。
    if (
      mode === "custom" &&
      preset.apiFormat !== "claude" &&
      parsed.gatewayError &&
      /Not Found/i.test(parsed.gatewayError) &&
      isMinimaxUrl(url) &&
      /^sk-cp-/i.test(preset.apiKey.trim())
    ) {
      const rescue = buildPayload(true);
      try {
        const rescueResponse = await fetchFn(rescue.url, {
          method: "POST",
          headers: rescue.headers,
          body: rescue.body,
          signal: controller.signal,
        });
        status = rescueResponse.status;
        const rescueParsed = await parseCall(rescueResponse);
        if (rescueParsed.text !== null) {
          parsed = rescueParsed;
          rescueAttempted = true;
        }
      } catch { /* 救场失败 → 落回原错误路径 */ }
    }

    if (!response.ok && !rescueAttempted) {
      const mapped = errorMessageForStatus(status);
      return fail(mapped.code, mapped.message, mapped.retryable, status);
    }

    const text = parsed.text;
    if (text === null || text.length === 0) {
      // 0.9.24 空回复（choices 空 + 0 补全）：Gemini 系安全过滤静默拦截的典型形状——
      // 不报错直接给空气，重试大概率同样被拦
      if (parsed.emptyChoices) {
        return fail(
          ATLAS_ERROR_CODES.RESPONSE_MALFORMED,
          "模型返回了空回复（choices 为空、0 补全 token）——通常是供应商安全过滤静默拦截了本次输入（Gemini 系常见），也可能是上游网关故障。可选：在「推进」页关闭「世界书资料」缩小输入，或换模型 / 供应商。",
          false,
        );
      }
      // 网关「200 包错误 JSON」形状（new-api / one-api 系常见）：{"error":{"message":"..."},"quota_error":false}
      const gatewayError = parsed.gatewayError;
      if (gatewayError) {
        // 0.9.22 内容审核拦截专项：MiniMax 等供应商对输入做敏感检测（422 unprocessable_entity /
        // new_sensitive），HTTP 200 包错误 JSON。重试同样被拦，必须换模型 / 供应商或调整文本。
        const moderationLike =
          /sensitive|unprocessable|敏感|审核/i.test(gatewayError) ||
          /unprocessable_entity_error|new_sensitive/i.test(parsed.rawText);
        if (moderationLike) {
          const snippet = parsed.rawText.replace(/\s+/g, " ").trim().slice(0, 200);
          return fail(
            ATLAS_ERROR_CODES.RESPONSE_MALFORMED,
            `推演被模型服务商内容审核拦截（HTTP 200 包 422 unprocessable / sensitive）——本次推演的输入触发了供应商的敏感内容检测，重试同样会被拦。可选：换模型 / 换供应商，或调整涉及的卡书条目与行动文本。原始错误：${snippet}`,
            false,
          );
        }
        const minimaxHint = minimaxNotFoundHint(url, gatewayError, preset.apiKey);
        return fail(
          ATLAS_ERROR_CODES.RESPONSE_MALFORMED,
          `推演服务返回错误：${gatewayError}（HTTP 200，但响应体是错误 JSON）——通常是模型名在网关上不存在 / 无可用渠道，或端点路径不完整（一般应为 http(s)://地址/v1，Atlas 会自动补 /chat/completions）。请到「日志」页核对实际发送的目标与模型名。${minimaxHint}`,
          false,
        );
      }
      const snippet = parsed.rawText.replace(/\s+/g, " ").trim().slice(0, 200);
      return fail(
        ATLAS_ERROR_CODES.RESPONSE_MALFORMED,
        `推演服务返回为空或不支持的格式${snippet ? `（响应开头：${snippet}）` : "（响应体为空）"}。`,
        false,
      );
    }
    return {
      ok: true,
      text,
      status,
      durationMs: now() - startedAt,
      ...(rescueAttempted ? { notice: "已按 MiniMax 订阅密钥自动切换 Anthropic 路由（…/anthropic）重试成功。建议到「API」页把该连接的接口协议改为 Claude（Anthropic）、端点改为 …/anthropic 并保存。" } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** MiniMax 域判定（国内站 / 国际站）。 */
function isMinimaxUrl(url: string): boolean {
  return /minimax/i.test(url);
}

/**
 * 订阅密钥救场 URL：OpenAI 路径 URL → 同源 Anthropic 兼容路由。
 * https://api.minimaxi.com/v1/chat/completions → https://api.minimaxi.com/anthropic/chat/completions
 * （代理层 normalizeAtlasClaudeBase 会把基址归一为 …/anthropic/v1 后交 claude 源。）
 */
function rescueAnthropicUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.pathname = "/anthropic/chat/completions";
    return parsed.toString();
  } catch {
    return url;
  }
}


/** 提取网关错误 JSON 的 message（如 new-api 的 {"error":{"message":"Not Found"}}）。 */
function gatewayErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") return error.slice(0, 120) || null;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.slice(0, 120);
  }
  return null;
}

/**
 * MiniMax 专项提示：官方 API 对「Token Plan 订阅密钥（sk-cp-…）走 /v1 OpenAI 兼容路径」
 * 会返回 Not Found（HTTP 200 包错误 JSON / 或 404）——订阅密钥只能走 Anthropic 兼容路由
 * （…/anthropic），按量付费密钥（sk-api-…）才能用 /v1/chat/completions。
 * 另外国际站（minimax.io）与国内站（minimaxi.com / minimax.chat）密钥不通用。
 */
function minimaxNotFoundHint(url: string, gatewayError: string, apiKey: string): string {
  if (!/Not Found/i.test(gatewayError)) return "";
  if (!/minimax/i.test(url)) return "";
  const isSubscriptionKey = /^sk-cp-/i.test(apiKey.trim());
  if (isSubscriptionKey) {
    return " 【MiniMax 检测】你的密钥是 Token Plan 订阅密钥（sk-cp- 开头），它只能走 Anthropic Messages 协议——在 Atlas「API」页把接口协议切到 Claude（Anthropic），端点填 https://api.minimaxi.com/anthropic（国际站用 https://api.minimax.io/anthropic）；如需 OpenAI 兼容调用，请改用按量付费密钥（sk-api- 开头）并确保账户有余额。";
  }
  return " 【MiniMax 检测】① 国内站（minimaxi.com / minimax.chat）与国际站（minimax.io）密钥不通用，请确认密钥归属的平台与 API 地址一致；② 订阅密钥（sk-cp- 开头）只能走 Anthropic Messages 协议（Atlas「API」页把接口协议切到 Claude（Anthropic），端点填 …/anthropic），按量付费密钥（sk-api- 开头）才能用 /v1/chat/completions 且账户需有余额；③ 到控制台「模型列表」核对 MiniMax-M3 是否为该账号可调用名称。";
}

/** 从 SSE 文本里取第一个可解析的 data: 载荷（网关强制流式化时的兜底）。 */
function firstSsePayload(raw: string): unknown {
  if (!raw.includes("data:")) return null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      return JSON.parse(data);
    } catch {
      continue;
    }
  }
  return null;
}

/** content 字段兼容：字符串 / OpenAI 分段数组（[{type:"text",text:"..."}]）/ 纯文本数组。 */
function textContentOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return part as { text: string };
        }
        return null;
      })
      .filter((part): part is { text: string } => part !== null)
      .map((part) => part.text)
      .join("");
    return parts.length > 0 ? parts : null;
  }
  return null;
}

/** 从 OpenAI 风格或兼容响应中取助手正文。 */
function extractAssistantText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as {
    choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
    text?: unknown;
    content?: unknown;
    response?: unknown;
    message?: { content?: unknown };
  };
  if (Array.isArray(p.choices) && p.choices.length > 0) {
    const choice = p.choices[0];
    const fromMessage = textContentOf(choice?.message?.content);
    if (fromMessage !== null) return fromMessage;
    if (typeof choice?.text === "string") return choice.text;
  }
  // ollama 原生 /api/chat 形状：{ message: { content } }
  const fromOllamaMessage = textContentOf(p.message?.content);
  if (fromOllamaMessage !== null) return fromOllamaMessage;
  for (const key of ["text", "content", "response"] as const) {
    const value = textContentOf(p[key]);
    if (value !== null) return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 模型输出 → AtlasWorldChangeDraft（不可信数据；损坏一律 RESPONSE_MALFORMED）
// ---------------------------------------------------------------------------

/** 从可能被 ```json 围栏或夹带说明文字的响应中取第一个 JSON 对象。 */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1] ?? "", text, extractBalancedJsonObject(text)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const sanitized = sanitizeJsonText(candidate);
    if (!sanitized) continue;
    try {
      const parsed = JSON.parse(sanitized) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 尝试下一个候选
    }
  }
  return null;
}

/** shujuku extractBalancedJsonObject 同款：从第一个 { 起做字符串感知的括号配平扫描（容忍字符串里的花括号）。 */
function extractBalancedJsonObject(text: string): string {
  const start = text.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

/** shujuku sanitize 同款：剥围栏残留、弯引号转直引号、掐掉对象前导垃圾、去尾逗号。 */
function sanitizeJsonText(jsonStr: string): string {
  if (!jsonStr) return "";
  let sanitized = String(jsonStr)
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/^[^{]*?(\{)/s, "$1")
    .trim();
  sanitized = extractBalancedJsonObject(sanitized) || sanitized;
  return sanitized
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function toDuration(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return null;
}

function toLocationChange(value: unknown): AtlasWorldChangeDraft["locationChange"] {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AtlasError(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "locationChange 必须是对象或 null");
  }
  const record = value as Record<string, unknown>;
  const toPointId = typeof record.toPointId === "string" && record.toPointId.trim() ? record.toPointId.trim() : null;
  const toRegionId = typeof record.toRegionId === "string" && record.toRegionId.trim() ? record.toRegionId.trim() : null;
  if (!toPointId && !toRegionId) return null;
  return { toPointId, toRegionId };
}

/** npcChanges 的白名单映射（映射后仍会经共享 parseStateEffect 二次校验）。 */
function npcChangeToEffect(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const entityId = typeof record.entityId === "string" ? record.entityId.trim() : "";
  if (!entityId || entityId.length > ATLAS_LIMITS.ID_CHARS) return null;
  if (typeof record.key === "string" && record.key.trim() && "value" in record) {
    return { kind: "setTemporalField", entityId, key: record.key.trim(), value: record.value };
  }
  if (typeof record.tag === "string" && record.tag.trim()) {
    return { kind: "addTag", entityId, tag: record.tag.trim() };
  }
  if (typeof record.removeTag === "string" && record.removeTag.trim()) {
    return { kind: "removeTag", entityId, tag: record.removeTag.trim() };
  }
  if (
    typeof record.targetEntityId === "string" && record.targetEntityId.trim() &&
    typeof record.key === "string" && record.key.trim() && "value" in record
  ) {
    return { kind: "adjustRelation", entityId, targetEntityId: record.targetEntityId.trim(), key: record.key.trim(), value: record.value };
  }
  return null;
}

/**
 * 解析 world-turn 模型输出为 AtlasWorldChangeDraft（0.9.25 shujuku 容错口径）：
 * 三层 JSON 抢救（围栏 / 括号配平 / 消毒）→ 字段级白名单映射；
 * npcChanges / memoryDrafts 逐条抢救——无法识别的条目**丢弃并计数**（shujuku filter(Boolean) 同款），
 * 不再因单条垃圾整单炸掉；summary 仍必填（缺摘要 = 无法归档，必须失败）。
 * JSON 完全损坏时走 salvageDraftFromRawText 兜底（原始文本字段级提取）。
 * eventDrafts / triggerResults 仅叙述性字段，v1 不映射为 effect（记入 summary 语境）。
 */
export function parseAtlasWorldTurnDraft(text: string): AtlasWorldChangeDraft {
  const source = text ?? "";
  const parsed = extractJsonObject(source);
  const draftSource = parsed ?? salvageDraftContainerFromRawText(source);
  if (!draftSource) {
    throw new AtlasError(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "推演输出不是合法的 JSON 对象。");
  }
  const summary = typeof draftSource.summary === "string" ? draftSource.summary.trim() : "";
  if (!summary) {
    throw new AtlasError(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "推演输出缺少 summary 摘要。");
  }

  const rawDuration = "duration" in draftSource ? toDuration(draftSource.duration) : 0;
  if (rawDuration === null) {
    throw new AtlasError(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, `推演输出 duration 非法：${String(draftSource.duration)}`);
  }

  const rawEffects: unknown[] = [];
  let droppedEffects = 0;
  if (draftSource.npcChanges !== undefined && draftSource.npcChanges !== null) {
    if (!Array.isArray(draftSource.npcChanges)) {
      throw new AtlasError(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "推演输出 npcChanges 必须是数组。");
    }
    draftSource.npcChanges.forEach((item) => {
      const effect = npcChangeToEffect(item);
      if (!effect) {
        droppedEffects += 1; // shujuku 同款：坏条丢弃，不整单拒绝（白名单仍由 parseStateEffect 二次把关）
        return;
      }
      if (rawEffects.length >= ATLAS_LIMITS.REF_ARRAY) return;
      rawEffects.push(effect);
    });
  }

  const memoryDrafts: Array<{ entityId: string; text: string }> = [];
  let droppedMemories = 0;
  if (draftSource.memoryDrafts !== undefined && draftSource.memoryDrafts !== null) {
    if (!Array.isArray(draftSource.memoryDrafts)) {
      throw new AtlasError(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "推演输出 memoryDrafts 必须是数组。");
    }
    draftSource.memoryDrafts.forEach((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        droppedMemories += 1;
        return;
      }
      const record = item as Record<string, unknown>;
      const entityId = typeof record.entityId === "string" ? record.entityId.trim() : "";
      const memoryText = typeof record.text === "string" ? record.text.trim() : "";
      if (!entityId || !memoryText) {
        droppedMemories += 1;
        return;
      }
      if (memoryDrafts.length >= ATLAS_LIMITS.REF_ARRAY) return;
      memoryDrafts.push({ entityId, text: memoryText });
    });
  }

  const locationChange = toLocationChange(draftSource.locationChange);
  return {
    duration: rawDuration,
    locationChange,
    rawEffects,
    memoryDrafts,
    summary: droppedEffects + droppedMemories > 0
      ? `${summary}（解析时丢弃 ${droppedEffects} 条无法识别的变化、${droppedMemories} 条残缺记忆）`
      : summary,
  };
}

/** JSON 完全损坏时的兜底：从原始文本里按平衡扫描抽 NPC / 记忆对象数组，逐字段提取（shujuku salvage 同款思路）。 */
function salvageDraftContainerFromRawText(raw: string): Record<string, unknown> | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const summary = extractRawStringField(raw, "summary");
  const durationText = extractRawStringField(raw, "duration");
  if (!summary && !durationText) return null;
  const container: Record<string, unknown> = {};
  if (summary) container.summary = summary;
  if (durationText) container.duration = durationText;
  const effects = salvageObjectArrayFromRawText(raw, "npcChanges")
    .map((item) => npcChangeToEffect(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .slice(0, ATLAS_LIMITS.REF_ARRAY);
  if (effects.length > 0) container.npcChanges = effects;
  const memories = salvageObjectArrayFromRawText(raw, "memoryDrafts")
    .filter((item) => typeof item.entityId === "string" && item.entityId.trim() && typeof item.text === "string" && item.text.trim())
    .slice(0, ATLAS_LIMITS.REF_ARRAY);
  if (memories.length > 0) container.memoryDrafts = memories;
  const locationRaw = extractRawStringField(raw, "toPointId");
  const regionRaw = extractRawStringField(raw, "toRegionId");
  if (locationRaw || regionRaw) container.locationChange = { toPointId: locationRaw ?? null, toRegionId: regionRaw ?? null };
  return container;
}

/** 从原始文本提取 "field": "value" 的字符串值（处理转义；shujuku extractStringField 同款）。 */
function extractRawStringField(source: string, fieldName: string): string {
  if (typeof source !== "string" || !fieldName) return "";
  const match = new RegExp(`"${fieldName}"\\s*:\\s*"`).exec(source);
  if (!match) return "";
  let i = match.index + match[0].length;
  let result = "";
  let escaped = false;
  while (i < source.length) {
    const ch = source[i]!;
    if (escaped) {
      result += ch;
      escaped = false;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      result += ch;
      escaped = true;
      i += 1;
      continue;
    }
    if (ch === '"') break;
    result += ch;
    i += 1;
  }
  return result
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/** 从原始文本提取 "field": [ ... ] 里的对象数组（括号配平逐个抽对象）。 */
function salvageObjectArrayFromRawText(raw: string, fieldName: string): Array<Record<string, unknown>> {
  const arrayMatch = new RegExp(`"${fieldName}"\\s*:\\s*\\[`).exec(raw);
  if (!arrayMatch) return [];
  const arrayStart = raw.indexOf("[", arrayMatch.index);
  if (arrayStart < 0) return [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let arrayEnd = -1;
  for (let i = arrayStart; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "[") depth += 1;
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        arrayEnd = i;
        break;
      }
    }
  }
  if (arrayEnd < 0) return [];
  const arrayContent = raw.slice(arrayStart + 1, arrayEnd);
  const objects: Array<Record<string, unknown>> = [];
  let objStart = -1;
  depth = 0;
  inString = false;
  escaped = false;
  for (let i = 0; i < arrayContent.length; i += 1) {
    const ch = arrayContent[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") {
      if (depth === 0) objStart = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && objStart >= 0) {
        const objText = arrayContent.slice(objStart, i + 1);
        try {
          const obj = JSON.parse(sanitizeJsonText(objText)) as unknown;
          if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            objects.push(obj as Record<string, unknown>);
          }
        } catch {
          // 单对象抢救失败 → 丢弃该条
        }
        objStart = -1;
      }
    }
  }
  return objects;
}

// ---------------------------------------------------------------------------
// 脱敏日志
// ---------------------------------------------------------------------------

export interface AtlasApiLogEntry {
  at: number;
  /** 预设名（非秘密） */
  presetName: string;
  model: string;
  ok: boolean;
  /** 失败时的契约错误码 */
  code?: AtlasErrorCode;
  status?: number;
  durationMs: number;
  /** 发送正文与响应正文的字符数（只记数量，不记内容） */
  requestChars: number;
  responseChars: number;
}

/** 预设脱敏视图：GET 响应只允许出现 exists + 尾号掩码。 */
export function maskPreset(preset: AtlasApiPreset | null): Record<string, unknown> | null {
  if (!preset) return null;
  const key = preset.apiKey ?? "";
  return {
    name: preset.name,
    endpoint: preset.endpoint,
    model: preset.model,
    maxTokens: preset.maxTokens ?? null,
    temperature: preset.temperature ?? null,
    timeoutMs: preset.timeoutMs ?? null,
    apiKey: { exists: key.trim().length > 0, tail: key.trim().length >= 4 ? key.trim().slice(-4) : null },
  };
}
