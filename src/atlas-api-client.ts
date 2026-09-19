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
  timeoutMs?: number;
  /** 自定义系统提示词；留空 / 省略 = 使用内置默认（DEFAULT_WORLD_TURN_SYSTEM_PROMPT）。 */
  systemPrompt?: string;
}

export interface AtlasApiCallResult {
  ok: true;
  text: string;
  status: number;
  durationMs: number;
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
 * 内置默认系统提示词（UI「API」页可查看；预设 systemPrompt 留空时生效）。
 * 修改输出契约（字段名 / 形状）必须同步 parseAtlasWorldTurnDraft，否则解析会整单失败。
 */
export const DEFAULT_WORLD_TURN_SYSTEM_PROMPT =
  "你是阿特拉斯世界推演引擎。基于给定的当前世界状态（位置、时间、附近人物、可达内容）与本轮用户行动、助手回复，" +
  "推断本轮对世界造成的**有界结构化变化**。\n" +
  "严格要求：只输出一个 JSON 对象，不要输出任何多余说明或代码围栏；字段：\n" +
  "duration（本轮消耗的时段数，非负数字，≤10000）、\n" +
  "locationChange（对象或 null：{toPointId, toRegionId}，id 必须来自上下文中出现的地点）、\n" +
  "npcChanges（数组，每条形如 {entityId, key, value} 更新人物状态 / {entityId, tag} 加标签 / " +
  "{entityId, removeTag} 删标签 / {entityId, targetEntityId, key, value} 改关系；entityId 必须来自上下文）、\n" +
  "memoryDrafts（数组，每条 {entityId, text}，为人物追加一条记忆，≤500 字）、\n" +
  "eventDrafts（数组，事件的摘要文字，仅叙述用）、\n" +
  "triggerResults（数组，本轮命中的触发器 id）、\n" +
  "summary（本轮世界变化的一句话摘要，≤500 字）。\n" +
  "禁止：编造上下文之外的实体 id；输出时间地点之外的世界重写；输出任何密钥、路径或代码。";

export interface AtlasWorldTurnPromptInput {
  injectionText: string;
  userText: string;
  assistantText: string;
}

/** 组装 world-turn 请求的用户正文（有界：调用方注入文本已过预算）。 */
export function buildWorldTurnUserContent(input: AtlasWorldTurnPromptInput): string {
  return [
    "【当前世界状态与可达内容】",
    input.injectionText,
    "",
    "【本轮用户行动】",
    input.userText,
    "",
    "【本轮助手回复】",
    input.assistantText,
    "",
    "请按系统要求只输出一个 JSON 对象。",
  ].join("\n");
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

  const url = buildAtlasChatUrl(preset.endpoint);
  if (!url) return fail(ATLAS_ERROR_CODES.API_NOT_CONFIGURED, "推演 API 地址无效，无法构造请求。", false);
  if (!preset.model.trim()) return fail(ATLAS_ERROR_CODES.API_NOT_CONFIGURED, "推演预设未填写模型名称。", false);

  const timeoutMs = Math.min(Math.max(preset.timeoutMs ?? 30_000, 1_000), 120_000);
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(preset.apiKey.trim() ? { Authorization: `Bearer ${preset.apiKey.trim()}` } : {}),
        },
        body: JSON.stringify({
          model: preset.model.trim(),
          messages: [
            { role: "system", content: preset.systemPrompt?.trim() || DEFAULT_WORLD_TURN_SYSTEM_PROMPT },
            { role: "user", content: buildWorldTurnUserContent(input) },
          ],
          stream: false,
          ...(typeof preset.temperature === "number" ? { temperature: preset.temperature } : {}),
          ...(typeof preset.maxTokens === "number" ? { max_tokens: preset.maxTokens } : {}),
        }),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) return fail(ATLAS_ERROR_CODES.API_TIMEOUT, `推演请求超过 ${timeoutMs}ms 超时。`, true);
      return fail(ATLAS_ERROR_CODES.SERVICE_OFFLINE, "无法连接推演服务，请检查网络或服务状态。", true);
    }

    if (!response.ok) {
      const mapped = errorMessageForStatus(response.status);
      return fail(mapped.code, mapped.message, mapped.retryable, response.status);
    }

    // 0.9.6：先取原始文本（响应片段可进诊断日志/报错），JSON 解析失败再尝试 SSE data: 行
    // （部分网关无视 stream:false 强制流式返回）。
    let rawText = "";
    try {
      rawText = typeof response.text === "function" ? await response.text() : JSON.stringify(await response.json());
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
      const snippet = rawText.replace(/\s+/g, " ").trim().slice(0, 200);
      return fail(
        ATLAS_ERROR_CODES.RESPONSE_MALFORMED,
        `推演服务返回为空或不支持的格式${snippet ? `（响应开头：${snippet}）` : "（响应体为空）"}。`,
        false,
      );
    }
    return { ok: true, text, status: response.status, durationMs: now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
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
  const candidates = [fenced?.[1] ?? "", text];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 尝试下一个候选
    }
  }
  return null;
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
 * 解析 world-turn 模型输出为 AtlasWorldChangeDraft。
 * JSON 损坏 / 缺摘要 / duration 非法 → AtlasError(RESPONSE_MALFORMED 或 FIELD_LIMIT_EXCEEDED)。
 * eventDrafts / triggerResults 仅叙述性字段，v1 不映射为 effect（记入 summary 语境）。
 */
export function parseAtlasWorldTurnDraft(text: string): AtlasWorldChangeDraft {
  const parsed = extractJsonObject(text ?? "");
  if (!parsed) {
    throw new AtlasError(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "推演输出不是合法的 JSON 对象。");
  }
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  if (!summary) {
    throw new AtlasError(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "推演输出缺少 summary 摘要。");
  }

  const rawDuration = "duration" in parsed ? toDuration(parsed.duration) : 0;
  if (rawDuration === null) {
    throw new AtlasError(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, `推演输出 duration 非法：${String(parsed.duration)}`);
  }

  const rawEffects: unknown[] = [];
  if (parsed.npcChanges !== undefined && parsed.npcChanges !== null) {
    if (!Array.isArray(parsed.npcChanges)) {
      throw new AtlasError(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "推演输出 npcChanges 必须是数组。");
    }
    if (parsed.npcChanges.length > ATLAS_LIMITS.REF_ARRAY) {
      throw new AtlasError(ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED, `npcChanges 超过 ${ATLAS_LIMITS.REF_ARRAY} 项上限`);
    }
    parsed.npcChanges.forEach((item, index) => {
      const effect = npcChangeToEffect(item);
      if (!effect) {
        throw new AtlasError(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, `npcChanges[${index}] 不是可识别的变化形状。`);
      }
      rawEffects.push(effect);
    });
  }

  const memoryDrafts: Array<{ entityId: string; text: string }> = [];
  if (parsed.memoryDrafts !== undefined && parsed.memoryDrafts !== null) {
    if (!Array.isArray(parsed.memoryDrafts)) {
      throw new AtlasError(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "推演输出 memoryDrafts 必须是数组。");
    }
    if (parsed.memoryDrafts.length > ATLAS_LIMITS.REF_ARRAY) {
      throw new AtlasError(ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED, `memoryDrafts 超过 ${ATLAS_LIMITS.REF_ARRAY} 项上限`);
    }
    parsed.memoryDrafts.forEach((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new AtlasError(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, `memoryDrafts[${index}] 必须是对象。`);
      }
      const record = item as Record<string, unknown>;
      const entityId = typeof record.entityId === "string" ? record.entityId.trim() : "";
      const memoryText = typeof record.text === "string" ? record.text.trim() : "";
      if (!entityId || !memoryText) {
        throw new AtlasError(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, `memoryDrafts[${index}] 需要 entityId 与非空 text。`);
      }
      memoryDrafts.push({ entityId, text: memoryText });
    });
  }

  const locationChange = toLocationChange(parsed.locationChange);
  return {
    duration: rawDuration,
    locationChange,
    rawEffects,
    memoryDrafts,
    summary,
  };
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
