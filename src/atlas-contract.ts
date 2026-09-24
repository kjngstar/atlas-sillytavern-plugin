/**
 * atlas-contract.ts — Atlas UI Extension ↔ Atlas Server Plugin 纯数据契约。
 *
 * 规则（见上级 README.md 第 4 节）：
 * - 所有结构带显式协议版本；不兼容时拒绝并说明，不静默猜测。
 * - 所有字符串 / 数组 / 上下文有硬上限；超限返回稳定错误码。
 * - 错误序列化只允许白名单字段，禁止 apiKey / Authorization / 本地绝对路径。
 * - 本文件必须保持零依赖、无 DOM、无 Node API，可同时被浏览器与 Node 加载。
 */

export const ATLAS_PROTOCOL_VERSION = 1;

/** 稳定错误码。集合一经发布不得改动已有取值，只能追加。 */
export const ATLAS_ERROR_CODES = {
  /** 协议版本不兼容 */
  PROTOCOL_INCOMPATIBLE: "PROTOCOL_INCOMPATIBLE",
  /** 当前聊天未绑定世界 */
  NOT_BOUND: "NOT_BOUND",
  /** 世界不存在 */
  WORLD_NOT_FOUND: "WORLD_NOT_FOUND",
  /** 字段超限（超长 / 超量数组） */
  FIELD_LIMIT_EXCEEDED: "FIELD_LIMIT_EXCEEDED",
  /** 载荷缺失必填字段或类型非法 */
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  /** Server Plugin 离线 */
  SERVICE_OFFLINE: "SERVICE_OFFLINE",
  /** 独立推演 API 未配置 */
  API_NOT_CONFIGURED: "API_NOT_CONFIGURED",
  /** 独立推演 API 限流 */
  API_RATE_LIMITED: "API_RATE_LIMITED",
  /** 独立推演 API 超时 */
  API_TIMEOUT: "API_TIMEOUT",
  /** 模型响应损坏（非 JSON / 部分 JSON / 引用未知实体） */
  RESPONSE_MALFORMED: "RESPONSE_MALFORMED",
  /** 独立推演 API 认证失败（401 / 403；密钥缺失或被拒） */
  API_AUTH_FAILED: "API_AUTH_FAILED",
  /** 独立推演 API 端点不存在（404） */
  API_NOT_FOUND: "API_NOT_FOUND",
  /** 独立推演 API 其他 HTTP 错误（5xx 等） */
  API_REQUEST_FAILED: "API_REQUEST_FAILED",
  /** 未授权操作（Server Plugin 写操作仅限本机会话） */
  FORBIDDEN: "FORBIDDEN",
  /** 重复提交（沿用原 receipt，幂等） */
  DUPLICATE_COMMIT: "DUPLICATE_COMMIT",
  /** 世界账本写入失败（零部分写入） */
  WRITE_FAILED: "WRITE_FAILED",
  /** 0.9.42 会话承载：携带的世界文档落后于最新已接受版本（双开同聊天等场景），拒绝提交 */
  SESSION_STALE: "SESSION_STALE",
  /**
   * C04（§2）：模型输出的形态与 `settings.worldTurnProtocol` 不符。
   * 不猜、不偷偷换管线——指明当前选项让作者自己切（推进页协议下拉）。
   */
  PROTOCOL_MISMATCH: "PROTOCOL_MISMATCH",
} as const;

export type AtlasErrorCode = (typeof ATLAS_ERROR_CODES)[keyof typeof ATLAS_ERROR_CODES];

/** 硬上限。所有解析与序列化路径共用，禁止调用方绕过。 */
export const ATLAS_LIMITS = {
  /** ID 类字段最大字符数 */
  ID_CHARS: 128,
  /** 用户行动文本最大字符数 */
  USER_TEXT_CHARS: 12_000,
  /** 助手回复文本最大字符数 */
  ASSISTANT_TEXT_CHARS: 24_000,
  /** 注入文本最大字符数（有界上下文预算） */
  INJECTION_CHARS: 8_000,
  /** 摘要最大字符数 */
  SUMMARY_CHARS: 2_000,
  /** 来源 / NPC / 触发等 ID 数组最大长度 */
  REF_ARRAY: 128,
  /** 最近消息引用最大条数 */
  RECENT_MESSAGES: 32,
  /** 旅行预览因素最大条数 */
  TRAVEL_FACTORS: 16,
  /** 世界时间上限（毫秒级时间戳量级） */
  TIME_MAX: Number.MAX_SAFE_INTEGER,
  /** 单回合推演时长上限（时段数） */
  TURN_DURATION_MAX: 10_000,
  /** 0.9.21 世界书资料补充块最大字符数（推演请求专用；主聊天注入不带） */
  LORE_SUPPLEMENT_CHARS: 6_000,
  /** Server Plugin 响应体最大字节数 */
  RESPONSE_BODY_BYTES: 262_144,
} as const;

export interface AtlasChatBinding {
  schemaVersion: 1;
  enabled: boolean;
  chatId: string;
  characterId?: string | null;
  worldId: string;
  branchId: string | null;
  currentLocationId?: string | null;
  worldTimeCursor: number;
  lastCommittedMessageId?: string | null;
  lastCheckpointId?: string | null;
}

export interface AtlasRecentMessageRef {
  id: string;
  role: "user" | "assistant";
}

export interface AtlasTurnPrepareRequest {
  chatId: string;
  messageId: string;
  worldId: string;
  branchId: string | null;
  userText: string;
  recentMessageRefs: AtlasRecentMessageRef[];
}

export interface AtlasTravelPreview {
  destinationId: string;
  distance: number;
  estimatedDuration: number;
  factors: string[];
}

export interface AtlasTurnPrepareResponse {
  turnId: string;
  injectionText: string;
  sourceRefs: string[];
  relevantNpcIds: string[];
  triggerIds: string[];
  currentTime: number;
  currentLocationId: string | null;
  travelPreview?: AtlasTravelPreview;
}

export interface AtlasTurnCommitRequest {
  turnId: string;
  chatId: string;
  userMessageId: string;
  assistantMessageId: string;
  swipeId?: string | null;
  userText: string;
  assistantText: string;
  /** 0.9.21 可选：宿主侧卡书条目有界文本（只进推演请求，不进主聊天注入） */
  loreSupplement?: string;
  /** 0.9.25 shujuku 占位符体系：$7 前文上下文——最近 N 条 AI 楼层正文（宿主采集，有界） */
  recentAssistantTexts?: string[];
  /** 0.9.25 shujuku 占位符体系：$U 用户设定描述（persona，有界） */
  personaDescription?: string;
  /** 0.9.25 shujuku 占位符体系：$C 角色描述（有界） */
  charDescription?: string;
}

export type AtlasTurnReceiptStatus = "committed" | "duplicate" | "pending-review" | "failed";

export interface AtlasTurnReceipt {
  receiptId: string;
  status: AtlasTurnReceiptStatus;
  checkpointId?: string;
  branchId: string | null;
  previousTime: number;
  currentTime: number;
  previousLocationId?: string | null;
  currentLocationId?: string | null;
  triggeredNpcIds: string[];
  adoptedEventIds: string[];
  summary: string;
  retryable: boolean;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: AtlasError };

/** 安全错误：message 不得包含密钥或本地路径；details 进入序列化前会被清洗。 */
export class AtlasError extends Error {
  readonly code: AtlasErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: AtlasErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AtlasError";
    this.code = code;
    this.details = details ?? {};
  }
}

const FORBIDDEN_KEY_PATTERN = /(api[-_]?key|authorization|secret|password|token)/i;
/** Windows 盘符路径与 POSIX 根路径；序列化前替换为占位符。 */
const ABSOLUTE_PATH_PATTERN = /(?:[A-Za-z]:[\\/][^\s"'`,;)\]]*|\/(?:home|Users|root|mnt|workspace)\/[^\s"'`,;)\]]*)/g;
const PATH_PLACEHOLDER = "[path]";

function scrubString(value: string): string {
  return value.replace(ABSOLUTE_PATH_PATTERN, PATH_PLACEHOLDER);
}

function sanitizeDetails(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    if (FORBIDDEN_KEY_PATTERN.test(rawKey)) {
      output[rawKey] = "[REDACTED]";
      continue;
    }
    if (typeof rawValue === "string") {
      output[rawKey] = scrubString(rawValue);
    } else if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      output[rawKey] = sanitizeDetails(rawValue as Record<string, unknown>);
    } else if (Array.isArray(rawValue)) {
      output[rawKey] = rawValue.map((item) => (typeof item === "string" ? scrubString(item) : item));
    } else {
      output[rawKey] = rawValue;
    }
  }
  return output;
}

export interface SerializedAtlasError {
  code: AtlasErrorCode;
  message: string;
  details: Record<string, unknown>;
}

export function serializeAtlasError(error: AtlasError): SerializedAtlasError {
  return {
    code: error.code,
    message: scrubString(error.message),
    details: sanitizeDetails(error.details),
  };
}

/** 把任意 thrown 值转为可安全序列化的错误（Unknown 来源一律不可信）。 */
export function toSerializedError(thrown: unknown): SerializedAtlasError {
  if (thrown instanceof AtlasError) {
    return serializeAtlasError(thrown);
  }
  const message = scrubString(
    typeof thrown === "object" && thrown !== null && "message" in thrown && typeof (thrown as { message: unknown }).message === "string"
      ? (thrown as { message: string }).message
      : String(thrown),
  ).slice(0, 500);
  return { code: ATLAS_ERROR_CODES.INVALID_PAYLOAD, message, details: {} };
}

// ---------------------------------------------------------------------------
// 严格解析辅助。所有解析失败抛 AtlasError，公开入口统一转 ParseResult。
// ---------------------------------------------------------------------------

function fail(code: AtlasErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new AtlasError(code, message, details);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, label: string, maxChars: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `${label}.${key} 必须是非空字符串`);
  }
  if (value.length > maxChars) {
    fail(ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED, `${label}.${key} 超过 ${maxChars} 字符上限`);
  }
  return value;
}

function requireStringOrNull(record: Record<string, unknown>, key: string, label: string): string | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `${label}.${key} 缺失必填字段`);
  }
  if (typeof value !== "string" || value.length === 0) {
    fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `${label}.${key} 必须是非空字符串或 null`);
  }
  if (value.length > ATLAS_LIMITS.ID_CHARS) {
    fail(ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED, `${label}.${key} 超过 ${ATLAS_LIMITS.ID_CHARS} 字符上限`);
  }
  return value;
}

function optionalIdOrNull(record: Record<string, unknown>, key: string, label: string): string | null | undefined {
  if (!(key in record)) {
    return undefined;
  }
  return requireStringOrNull(record, key, label) as string | null | undefined;
}

function requireTime(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > ATLAS_LIMITS.TIME_MAX) {
    fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `${label}.${key} 必须是 0..MAX_SAFE_INTEGER 的有限数字`);
  }
  return value;
}

function requireIdArray(record: Record<string, unknown>, key: string, label: string, max: number): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `${label}.${key} 必须是数组`);
  }
  if (value.length > max) {
    fail(ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED, `${label}.${key} 超过 ${max} 项上限`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.length === 0 || item.length > ATLAS_LIMITS.ID_CHARS) {
      fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `${label}.${key}[${index}] 必须是非空 ID 字符串`);
    }
    return item;
  });
}

function requireProtocolVersion(record: Record<string, unknown>, label: string): 1 {
  const version = record.schemaVersion;
  if (version === undefined) {
    fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `${label}.schemaVersion 缺失`);
  }
  if (version !== ATLAS_PROTOCOL_VERSION) {
    fail(
      ATLAS_ERROR_CODES.PROTOCOL_INCOMPATIBLE,
      `${label}.schemaVersion=${String(version)} 与协议版本 ${ATLAS_PROTOCOL_VERSION} 不兼容`,
    );
  }
  return ATLAS_PROTOCOL_VERSION;
}

function requireEnabled(record: Record<string, unknown>, label: string): boolean {
  const value = record.enabled;
  if (typeof value !== "boolean") {
    fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `${label}.enabled 必须是布尔值`);
  }
  return value;
}

function requireText(record: Record<string, unknown>, key: string, label: string, maxChars: number): string {
  const value = record[key];
  if (typeof value !== "string") {
    fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `${label}.${key} 必须是字符串`);
  }
  if (value.length > maxChars) {
    fail(ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED, `${label}.${key} 超过 ${maxChars} 字符上限`);
  }
  return value;
}

function parseTravelPreview(value: unknown): AtlasTravelPreview {
  const record = asRecord(value, "travelPreview");
  return {
    destinationId: requireString(record, "destinationId", "travelPreview", ATLAS_LIMITS.ID_CHARS),
    distance: requireTime(record, "distance", "travelPreview"),
    estimatedDuration: requireTime(record, "estimatedDuration", "travelPreview"),
    factors: requireIdArray(record, "factors", "travelPreview", ATLAS_LIMITS.TRAVEL_FACTORS),
  };
}

// ---------------------------------------------------------------------------
// 公开解析入口
// ---------------------------------------------------------------------------

function runParse<T>(parse: () => T): ParseResult<T> {
  try {
    return { ok: true, value: parse() };
  } catch (thrown) {
    return { ok: false, error: thrown instanceof AtlasError ? thrown : new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, String(thrown)) };
  }
}

export function parseAtlasChatBinding(raw: unknown): ParseResult<AtlasChatBinding> {
  return runParse(() => {
    const record = asRecord(raw, "AtlasChatBinding");
    const binding: AtlasChatBinding = {
      schemaVersion: requireProtocolVersion(record, "AtlasChatBinding"),
      enabled: requireEnabled(record, "AtlasChatBinding"),
      chatId: requireString(record, "chatId", "AtlasChatBinding", ATLAS_LIMITS.ID_CHARS),
      characterId: optionalIdOrNull(record, "characterId", "AtlasChatBinding"),
      worldId: requireString(record, "worldId", "AtlasChatBinding", ATLAS_LIMITS.ID_CHARS),
      branchId: requireStringOrNull(record, "branchId", "AtlasChatBinding"),
      currentLocationId: optionalIdOrNull(record, "currentLocationId", "AtlasChatBinding"),
      worldTimeCursor: requireTime(record, "worldTimeCursor", "AtlasChatBinding"),
      lastCommittedMessageId: optionalIdOrNull(record, "lastCommittedMessageId", "AtlasChatBinding"),
      lastCheckpointId: optionalIdOrNull(record, "lastCheckpointId", "AtlasChatBinding"),
    };
    return binding;
  });
}

export function parseAtlasTurnPrepareRequest(raw: unknown): ParseResult<AtlasTurnPrepareRequest> {
  return runParse(() => {
    const record = asRecord(raw, "AtlasTurnPrepareRequest");
    const refsRaw = record.recentMessageRefs;
    if (!Array.isArray(refsRaw)) {
      fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "AtlasTurnPrepareRequest.recentMessageRefs 必须是数组");
    }
    if (refsRaw.length > ATLAS_LIMITS.RECENT_MESSAGES) {
      fail(ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED, `recentMessageRefs 超过 ${ATLAS_LIMITS.RECENT_MESSAGES} 条上限`);
    }
    const recentMessageRefs: AtlasRecentMessageRef[] = refsRaw.map((item, index) => {
      const ref = asRecord(item, `recentMessageRefs[${index}]`);
      const role = ref.role;
      if (role !== "user" && role !== "assistant") {
        fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `recentMessageRefs[${index}].role 必须是 "user" 或 "assistant"`);
      }
      return { id: requireString(ref, "id", `recentMessageRefs[${index}]`, ATLAS_LIMITS.ID_CHARS), role };
    });
    return {
      chatId: requireString(record, "chatId", "AtlasTurnPrepareRequest", ATLAS_LIMITS.ID_CHARS),
      messageId: requireString(record, "messageId", "AtlasTurnPrepareRequest", ATLAS_LIMITS.ID_CHARS),
      worldId: requireString(record, "worldId", "AtlasTurnPrepareRequest", ATLAS_LIMITS.ID_CHARS),
      branchId: requireStringOrNull(record, "branchId", "AtlasTurnPrepareRequest"),
      userText: requireText(record, "userText", "AtlasTurnPrepareRequest", ATLAS_LIMITS.USER_TEXT_CHARS),
      recentMessageRefs,
    };
  });
}

export function parseAtlasTurnPrepareResponse(raw: unknown): ParseResult<AtlasTurnPrepareResponse> {
  return runParse(() => {
    const record = asRecord(raw, "AtlasTurnPrepareResponse");
    const response: AtlasTurnPrepareResponse = {
      turnId: requireString(record, "turnId", "AtlasTurnPrepareResponse", ATLAS_LIMITS.ID_CHARS),
      injectionText: requireText(record, "injectionText", "AtlasTurnPrepareResponse", ATLAS_LIMITS.INJECTION_CHARS),
      sourceRefs: requireIdArray(record, "sourceRefs", "AtlasTurnPrepareResponse", ATLAS_LIMITS.REF_ARRAY),
      relevantNpcIds: requireIdArray(record, "relevantNpcIds", "AtlasTurnPrepareResponse", ATLAS_LIMITS.REF_ARRAY),
      triggerIds: requireIdArray(record, "triggerIds", "AtlasTurnPrepareResponse", ATLAS_LIMITS.REF_ARRAY),
      currentTime: requireTime(record, "currentTime", "AtlasTurnPrepareResponse"),
      currentLocationId: requireStringOrNull(record, "currentLocationId", "AtlasTurnPrepareResponse"),
    };
    if ("travelPreview" in record && record.travelPreview !== undefined) {
      response.travelPreview = parseTravelPreview(record.travelPreview);
    }
    return response;
  });
}

export function parseAtlasTurnCommitRequest(raw: unknown): ParseResult<AtlasTurnCommitRequest> {
  return runParse(() => {
    const record = asRecord(raw, "AtlasTurnCommitRequest");
    const request: AtlasTurnCommitRequest = {
      turnId: requireString(record, "turnId", "AtlasTurnCommitRequest", ATLAS_LIMITS.ID_CHARS),
      chatId: requireString(record, "chatId", "AtlasTurnCommitRequest", ATLAS_LIMITS.ID_CHARS),
      userMessageId: requireString(record, "userMessageId", "AtlasTurnCommitRequest", ATLAS_LIMITS.ID_CHARS),
      assistantMessageId: requireString(record, "assistantMessageId", "AtlasTurnCommitRequest", ATLAS_LIMITS.ID_CHARS),
      userText: requireText(record, "userText", "AtlasTurnCommitRequest", ATLAS_LIMITS.USER_TEXT_CHARS),
      assistantText: requireText(record, "assistantText", "AtlasTurnCommitRequest", ATLAS_LIMITS.ASSISTANT_TEXT_CHARS),
    };
    if ("swipeId" in record && record.swipeId !== undefined) {
      request.swipeId = requireStringOrNull(record, "swipeId", "AtlasTurnCommitRequest") as string | null | undefined;
    }
    // 0.9.21 世界书资料补充：可选宽容字段——非字符串直接丢弃（绝不因宿主噪声拒整单）
    if (typeof record.loreSupplement === "string" && record.loreSupplement.trim().length > 0) {
      request.loreSupplement = record.loreSupplement.slice(0, ATLAS_LIMITS.LORE_SUPPLEMENT_CHARS);
    }
    // 0.9.25 shujuku 占位符体系：$7 / $U / $C 宿主采集字段，全部宽容可选——形状不对就丢弃，不拒整单
    if (Array.isArray(record.recentAssistantTexts)) {
      const texts = record.recentAssistantTexts
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .slice(0, 10)
        .map((item) => item.slice(0, ATLAS_LIMITS.ASSISTANT_TEXT_CHARS));
      if (texts.length > 0) request.recentAssistantTexts = texts;
    }
    if (typeof record.personaDescription === "string" && record.personaDescription.trim().length > 0) {
      request.personaDescription = record.personaDescription.slice(0, 2000);
    }
    if (typeof record.charDescription === "string" && record.charDescription.trim().length > 0) {
      request.charDescription = record.charDescription.slice(0, 4000);
    }
    return request;
  });
}

export function parseAtlasTurnReceipt(raw: unknown): ParseResult<AtlasTurnReceipt> {
  return runParse(() => {
    const record = asRecord(raw, "AtlasTurnReceipt");
    const status = record.status;
    if (status !== "committed" && status !== "duplicate" && status !== "pending-review" && status !== "failed") {
      fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `AtlasTurnReceipt.status 非法：${String(status)}`);
    }
    const receipt: AtlasTurnReceipt = {
      receiptId: requireString(record, "receiptId", "AtlasTurnReceipt", ATLAS_LIMITS.ID_CHARS),
      status,
      branchId: requireStringOrNull(record, "branchId", "AtlasTurnReceipt"),
      previousTime: requireTime(record, "previousTime", "AtlasTurnReceipt"),
      currentTime: requireTime(record, "currentTime", "AtlasTurnReceipt"),
      triggeredNpcIds: requireIdArray(record, "triggeredNpcIds", "AtlasTurnReceipt", ATLAS_LIMITS.REF_ARRAY),
      adoptedEventIds: requireIdArray(record, "adoptedEventIds", "AtlasTurnReceipt", ATLAS_LIMITS.REF_ARRAY),
      summary: requireText(record, "summary", "AtlasTurnReceipt", ATLAS_LIMITS.SUMMARY_CHARS),
      retryable: typeof record.retryable === "boolean"
        ? record.retryable
        : fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "AtlasTurnReceipt.retryable 必须是布尔值"),
    };
    if ("checkpointId" in record && record.checkpointId !== undefined) {
      receipt.checkpointId = requireString(record, "checkpointId", "AtlasTurnReceipt", ATLAS_LIMITS.ID_CHARS);
    }
    if ("previousLocationId" in record && record.previousLocationId !== undefined) {
      receipt.previousLocationId = requireStringOrNull(record, "previousLocationId", "AtlasTurnReceipt") as string | null | undefined;
    }
    if ("currentLocationId" in record && record.currentLocationId !== undefined) {
      receipt.currentLocationId = requireStringOrNull(record, "currentLocationId", "AtlasTurnReceipt") as string | null | undefined;
    }
    return receipt;
  });
}

/** 幂等键：同一 chatId + 消息 + swipe 只允许一次世界推进。 */
export function atlasCommitIdempotencyKey(request: Pick<AtlasTurnCommitRequest, "chatId" | "userMessageId" | "assistantMessageId" | "swipeId">): string {
  return [request.chatId, request.userMessageId, request.assistantMessageId, request.swipeId ?? ""].join("::");
}
