// src/atlas-contract.ts
var ATLAS_PROTOCOL_VERSION = 1;
var ATLAS_ERROR_CODES = {
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
  SESSION_STALE: "SESSION_STALE"
};
var ATLAS_LIMITS = {
  /** ID 类字段最大字符数 */
  ID_CHARS: 128,
  /** 用户行动文本最大字符数 */
  USER_TEXT_CHARS: 12e3,
  /** 助手回复文本最大字符数 */
  ASSISTANT_TEXT_CHARS: 24e3,
  /** 注入文本最大字符数（有界上下文预算） */
  INJECTION_CHARS: 8e3,
  /** 摘要最大字符数 */
  SUMMARY_CHARS: 2e3,
  /** 来源 / NPC / 触发等 ID 数组最大长度 */
  REF_ARRAY: 128,
  /** 最近消息引用最大条数 */
  RECENT_MESSAGES: 32,
  /** 旅行预览因素最大条数 */
  TRAVEL_FACTORS: 16,
  /** 世界时间上限（毫秒级时间戳量级） */
  TIME_MAX: Number.MAX_SAFE_INTEGER,
  /** 单回合推演时长上限（时段数） */
  TURN_DURATION_MAX: 1e4,
  /** 0.9.21 世界书资料补充块最大字符数（推演请求专用；主聊天注入不带） */
  LORE_SUPPLEMENT_CHARS: 6e3,
  /** Server Plugin 响应体最大字节数 */
  RESPONSE_BODY_BYTES: 262144
};
var AtlasError = class extends Error {
  code;
  details;
  constructor(code, message, details) {
    super(message);
    this.name = "AtlasError";
    this.code = code;
    this.details = details ?? {};
  }
};
var FORBIDDEN_KEY_PATTERN = /(api[-_]?key|authorization|secret|password|token)/i;
var ABSOLUTE_PATH_PATTERN = /(?:[A-Za-z]:[\\/][^\s"'`,;)\]]*|\/(?:home|Users|root|mnt|workspace)\/[^\s"'`,;)\]]*)/g;
var PATH_PLACEHOLDER = "[path]";
function scrubString(value) {
  return value.replace(ABSOLUTE_PATH_PATTERN, PATH_PLACEHOLDER);
}
function sanitizeDetails(input) {
  const output = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    if (FORBIDDEN_KEY_PATTERN.test(rawKey)) {
      output[rawKey] = "[REDACTED]";
      continue;
    }
    if (typeof rawValue === "string") {
      output[rawKey] = scrubString(rawValue);
    } else if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      output[rawKey] = sanitizeDetails(rawValue);
    } else if (Array.isArray(rawValue)) {
      output[rawKey] = rawValue.map((item) => typeof item === "string" ? scrubString(item) : item);
    } else {
      output[rawKey] = rawValue;
    }
  }
  return output;
}
function serializeAtlasError(error) {
  return {
    code: error.code,
    message: scrubString(error.message),
    details: sanitizeDetails(error.details)
  };
}
function toSerializedError(thrown) {
  if (thrown instanceof AtlasError) {
    return serializeAtlasError(thrown);
  }
  const message = scrubString(
    typeof thrown === "object" && thrown !== null && "message" in thrown && typeof thrown.message === "string" ? thrown.message : String(thrown)
  ).slice(0, 500);
  return { code: ATLAS_ERROR_CODES.INVALID_PAYLOAD, message, details: {} };
}
function fail(code, message, details) {
  throw new AtlasError(code, message, details);
}
function asRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `${label} 必须是对象`);
  }
  return value;
}
function requireString(record, key, label, maxChars) {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `${label}.${key} 必须是非空字符串`);
  }
  if (value.length > maxChars) {
    fail(ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED, `${label}.${key} 超过 ${maxChars} 字符上限`);
  }
  return value;
}
function requireStringOrNull(record, key, label) {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (value === void 0) {
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
function optionalIdOrNull(record, key, label) {
  if (!(key in record)) {
    return void 0;
  }
  return requireStringOrNull(record, key, label);
}
function requireTime(record, key, label) {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > ATLAS_LIMITS.TIME_MAX) {
    fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `${label}.${key} 必须是 0..MAX_SAFE_INTEGER 的有限数字`);
  }
  return value;
}
function requireIdArray(record, key, label, max) {
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
function requireProtocolVersion(record, label) {
  const version = record.schemaVersion;
  if (version === void 0) {
    fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `${label}.schemaVersion 缺失`);
  }
  if (version !== ATLAS_PROTOCOL_VERSION) {
    fail(
      ATLAS_ERROR_CODES.PROTOCOL_INCOMPATIBLE,
      `${label}.schemaVersion=${String(version)} 与协议版本 ${ATLAS_PROTOCOL_VERSION} 不兼容`
    );
  }
  return ATLAS_PROTOCOL_VERSION;
}
function requireEnabled(record, label) {
  const value = record.enabled;
  if (typeof value !== "boolean") {
    fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `${label}.enabled 必须是布尔值`);
  }
  return value;
}
function requireText(record, key, label, maxChars) {
  const value = record[key];
  if (typeof value !== "string") {
    fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `${label}.${key} 必须是字符串`);
  }
  if (value.length > maxChars) {
    fail(ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED, `${label}.${key} 超过 ${maxChars} 字符上限`);
  }
  return value;
}
function parseTravelPreview(value) {
  const record = asRecord(value, "travelPreview");
  return {
    destinationId: requireString(record, "destinationId", "travelPreview", ATLAS_LIMITS.ID_CHARS),
    distance: requireTime(record, "distance", "travelPreview"),
    estimatedDuration: requireTime(record, "estimatedDuration", "travelPreview"),
    factors: requireIdArray(record, "factors", "travelPreview", ATLAS_LIMITS.TRAVEL_FACTORS)
  };
}
function runParse(parse) {
  try {
    return { ok: true, value: parse() };
  } catch (thrown) {
    return { ok: false, error: thrown instanceof AtlasError ? thrown : new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, String(thrown)) };
  }
}
function parseAtlasChatBinding(raw) {
  return runParse(() => {
    const record = asRecord(raw, "AtlasChatBinding");
    const binding = {
      schemaVersion: requireProtocolVersion(record, "AtlasChatBinding"),
      enabled: requireEnabled(record, "AtlasChatBinding"),
      chatId: requireString(record, "chatId", "AtlasChatBinding", ATLAS_LIMITS.ID_CHARS),
      characterId: optionalIdOrNull(record, "characterId", "AtlasChatBinding"),
      worldId: requireString(record, "worldId", "AtlasChatBinding", ATLAS_LIMITS.ID_CHARS),
      branchId: requireStringOrNull(record, "branchId", "AtlasChatBinding"),
      currentLocationId: optionalIdOrNull(record, "currentLocationId", "AtlasChatBinding"),
      worldTimeCursor: requireTime(record, "worldTimeCursor", "AtlasChatBinding"),
      lastCommittedMessageId: optionalIdOrNull(record, "lastCommittedMessageId", "AtlasChatBinding"),
      lastCheckpointId: optionalIdOrNull(record, "lastCheckpointId", "AtlasChatBinding")
    };
    return binding;
  });
}
function parseAtlasTurnPrepareRequest(raw) {
  return runParse(() => {
    const record = asRecord(raw, "AtlasTurnPrepareRequest");
    const refsRaw = record.recentMessageRefs;
    if (!Array.isArray(refsRaw)) {
      fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "AtlasTurnPrepareRequest.recentMessageRefs 必须是数组");
    }
    if (refsRaw.length > ATLAS_LIMITS.RECENT_MESSAGES) {
      fail(ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED, `recentMessageRefs 超过 ${ATLAS_LIMITS.RECENT_MESSAGES} 条上限`);
    }
    const recentMessageRefs = refsRaw.map((item, index) => {
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
      recentMessageRefs
    };
  });
}
function parseAtlasTurnPrepareResponse(raw) {
  return runParse(() => {
    const record = asRecord(raw, "AtlasTurnPrepareResponse");
    const response = {
      turnId: requireString(record, "turnId", "AtlasTurnPrepareResponse", ATLAS_LIMITS.ID_CHARS),
      injectionText: requireText(record, "injectionText", "AtlasTurnPrepareResponse", ATLAS_LIMITS.INJECTION_CHARS),
      sourceRefs: requireIdArray(record, "sourceRefs", "AtlasTurnPrepareResponse", ATLAS_LIMITS.REF_ARRAY),
      relevantNpcIds: requireIdArray(record, "relevantNpcIds", "AtlasTurnPrepareResponse", ATLAS_LIMITS.REF_ARRAY),
      triggerIds: requireIdArray(record, "triggerIds", "AtlasTurnPrepareResponse", ATLAS_LIMITS.REF_ARRAY),
      currentTime: requireTime(record, "currentTime", "AtlasTurnPrepareResponse"),
      currentLocationId: requireStringOrNull(record, "currentLocationId", "AtlasTurnPrepareResponse")
    };
    if ("travelPreview" in record && record.travelPreview !== void 0) {
      response.travelPreview = parseTravelPreview(record.travelPreview);
    }
    return response;
  });
}
function parseAtlasTurnCommitRequest(raw) {
  return runParse(() => {
    const record = asRecord(raw, "AtlasTurnCommitRequest");
    const request = {
      turnId: requireString(record, "turnId", "AtlasTurnCommitRequest", ATLAS_LIMITS.ID_CHARS),
      chatId: requireString(record, "chatId", "AtlasTurnCommitRequest", ATLAS_LIMITS.ID_CHARS),
      userMessageId: requireString(record, "userMessageId", "AtlasTurnCommitRequest", ATLAS_LIMITS.ID_CHARS),
      assistantMessageId: requireString(record, "assistantMessageId", "AtlasTurnCommitRequest", ATLAS_LIMITS.ID_CHARS),
      userText: requireText(record, "userText", "AtlasTurnCommitRequest", ATLAS_LIMITS.USER_TEXT_CHARS),
      assistantText: requireText(record, "assistantText", "AtlasTurnCommitRequest", ATLAS_LIMITS.ASSISTANT_TEXT_CHARS)
    };
    if ("swipeId" in record && record.swipeId !== void 0) {
      request.swipeId = requireStringOrNull(record, "swipeId", "AtlasTurnCommitRequest");
    }
    if (typeof record.loreSupplement === "string" && record.loreSupplement.trim().length > 0) {
      request.loreSupplement = record.loreSupplement.slice(0, ATLAS_LIMITS.LORE_SUPPLEMENT_CHARS);
    }
    if (Array.isArray(record.recentAssistantTexts)) {
      const texts = record.recentAssistantTexts.filter((item) => typeof item === "string" && item.trim().length > 0).slice(0, 10).map((item) => item.slice(0, ATLAS_LIMITS.ASSISTANT_TEXT_CHARS));
      if (texts.length > 0) request.recentAssistantTexts = texts;
    }
    if (typeof record.personaDescription === "string" && record.personaDescription.trim().length > 0) {
      request.personaDescription = record.personaDescription.slice(0, 2e3);
    }
    if (typeof record.charDescription === "string" && record.charDescription.trim().length > 0) {
      request.charDescription = record.charDescription.slice(0, 4e3);
    }
    return request;
  });
}
function parseAtlasTurnReceipt(raw) {
  return runParse(() => {
    const record = asRecord(raw, "AtlasTurnReceipt");
    const status = record.status;
    if (status !== "committed" && status !== "duplicate" && status !== "pending-review" && status !== "failed") {
      fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `AtlasTurnReceipt.status 非法：${String(status)}`);
    }
    const receipt = {
      receiptId: requireString(record, "receiptId", "AtlasTurnReceipt", ATLAS_LIMITS.ID_CHARS),
      status,
      branchId: requireStringOrNull(record, "branchId", "AtlasTurnReceipt"),
      previousTime: requireTime(record, "previousTime", "AtlasTurnReceipt"),
      currentTime: requireTime(record, "currentTime", "AtlasTurnReceipt"),
      triggeredNpcIds: requireIdArray(record, "triggeredNpcIds", "AtlasTurnReceipt", ATLAS_LIMITS.REF_ARRAY),
      adoptedEventIds: requireIdArray(record, "adoptedEventIds", "AtlasTurnReceipt", ATLAS_LIMITS.REF_ARRAY),
      summary: requireText(record, "summary", "AtlasTurnReceipt", ATLAS_LIMITS.SUMMARY_CHARS),
      retryable: typeof record.retryable === "boolean" ? record.retryable : fail(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "AtlasTurnReceipt.retryable 必须是布尔值")
    };
    if ("checkpointId" in record && record.checkpointId !== void 0) {
      receipt.checkpointId = requireString(record, "checkpointId", "AtlasTurnReceipt", ATLAS_LIMITS.ID_CHARS);
    }
    if ("previousLocationId" in record && record.previousLocationId !== void 0) {
      receipt.previousLocationId = requireStringOrNull(record, "previousLocationId", "AtlasTurnReceipt");
    }
    if ("currentLocationId" in record && record.currentLocationId !== void 0) {
      receipt.currentLocationId = requireStringOrNull(record, "currentLocationId", "AtlasTurnReceipt");
    }
    return receipt;
  });
}
function atlasCommitIdempotencyKey(request) {
  return [request.chatId, request.userMessageId, request.assistantMessageId, request.swipeId ?? ""].join("::");
}

// src/atlas-lorebook.ts
var ATLAS_LOREBOOK_LIMITS = {
  /** 单条目关键词上限 */
  KEYS_MAX: 8,
  /** 关键词单条最大字符 */
  KEY_CHARS: 64,
  /** 条目内容最大字符 */
  CONTENT_CHARS: 480,
  /** 近期动向单行最大字符 */
  RECENT_LINE_CHARS: 160,
  /** 近期动向保留条数 */
  RECENT_LINES_MAX: 5,
  /** comment 最大字符 */
  COMMENT_CHARS: 96,
  /** 书名最大字符（含前缀） */
  BOOK_NAME_CHARS: 72
};
var ATLAS_LOREBOOK_PREFIX = {
  /** 0.9.40 唯一在产条目前缀（滚动条目 comment 与前缀相同，固定不带时段） */
  moves: "Atlas 动向",
  /** 0.9.39 及之前的逐轮事件条目（仅用于回喂排除与存量清理，不再生成） */
  events: "Atlas 事件",
  /** 0.9.35 常驻聚合条目（0.9.40 起废弃；保留前缀用于回喂排除与存量清理） */
  status: "Atlas 状态总览"
};
var ATLAS_MOVES_ENTRY_COMMENT = ATLAS_LOREBOOK_PREFIX.moves;
var ATLAS_MOVES_ENTRY_KEY = "Atlas 动向-Key";
function lorebookNameFor(worldName) {
  const clean = String(worldName ?? "").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 32);
  const base = clean.length > 0 ? clean : "未命名世界";
  return `Atlas · ${base}`.slice(0, ATLAS_LOREBOOK_LIMITS.BOOK_NAME_CHARS);
}
function buildNameIndex(world) {
  const points = /* @__PURE__ */ new Map();
  for (const p of world.points ?? []) {
    if (p && p.id !== void 0 && p.name) points.set(String(p.id), String(p.name).slice(0, ATLAS_LOREBOOK_LIMITS.KEY_CHARS));
  }
  return { points };
}
function clip(text, max) {
  const clean = String(text ?? "").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}
function stripEngineNotes(text) {
  return String(text ?? "").replace(/（本轮无[^）]*）/g, "").replace(/本轮无世界变化。?/g, "").trim();
}
function buildLorebookPlans(world, receipt) {
  if (receipt.status !== "committed") return null;
  const index = buildNameIndex(world);
  const locationName = receipt.currentLocationId !== void 0 && receipt.currentLocationId !== null ? index.points.get(String(receipt.currentLocationId)) ?? "未知地点" : null;
  const recent = (world.stateEvents ?? []).slice(-ATLAS_LOREBOOK_LIMITS.RECENT_LINES_MAX).reverse().map((e) => `· [第 ${String(e.at)} 时段] ${clip(stripEngineNotes(e.narrativeSummary ?? ""), ATLAS_LOREBOOK_LIMITS.RECENT_LINE_CHARS)}`);
  const lines = [
    "【世界动向】本条目由 Atlas 每轮推演后自动更新：以下是当前时间点的权威世界动向，进行剧情分析时以此最新数据为准，优先级高于其他背景设定。",
    `当前时间：第 ${String(receipt.currentTime)} 时段`,
    ...locationName ? [`当前位置：${locationName}`] : [],
    "近期动向：",
    ...recent.length > 0 ? recent : ["· （暂无已归档的世界变化）"]
  ];
  const entry = {
    category: "moves",
    comment: ATLAS_MOVES_ENTRY_COMMENT,
    keys: [ATLAS_MOVES_ENTRY_KEY],
    content: lines.join("\n").slice(0, ATLAS_LOREBOOK_LIMITS.CONTENT_CHARS),
    constant: true
  };
  return {
    bookName: lorebookNameFor(String(world.name ?? "")),
    entries: [entry]
  };
}
function asBoundedString(value, max) {
  if (typeof value !== "string") return null;
  if (value.length > max) return null;
  return value;
}
function parseAtlasLorebookPlans(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "lorebook 载荷必须是对象") };
  }
  const record = raw;
  const bookName = asBoundedString(record.bookName, ATLAS_LOREBOOK_LIMITS.BOOK_NAME_CHARS);
  if (!bookName || bookName.trim().length === 0) {
    return { ok: false, error: new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "lorebook.bookName 非法") };
  }
  if (!Array.isArray(record.entries) || record.entries.length === 0 || record.entries.length > 1) {
    return { ok: false, error: new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "lorebook.entries 数量非法") };
  }
  const item = record.entries[0];
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return { ok: false, error: new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "lorebook 条目必须是对象") };
  }
  const entry = item;
  const category = entry.category === "moves" || entry.category === "events" ? entry.category : null;
  const comment = asBoundedString(entry.comment, ATLAS_LOREBOOK_LIMITS.COMMENT_CHARS);
  const content = asBoundedString(entry.content, ATLAS_LOREBOOK_LIMITS.CONTENT_CHARS);
  if (!category || !comment || !content) {
    return { ok: false, error: new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "lorebook 条目字段非法或超限") };
  }
  if (!Array.isArray(entry.keys) || entry.keys.length === 0 || entry.keys.length > ATLAS_LOREBOOK_LIMITS.KEYS_MAX) {
    return { ok: false, error: new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "lorebook 条目 keys 数量非法") };
  }
  const keys = [];
  for (const key of entry.keys) {
    const bounded = asBoundedString(key, ATLAS_LOREBOOK_LIMITS.KEY_CHARS);
    if (!bounded || bounded.trim().length === 0) {
      return { ok: false, error: new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "lorebook 条目 key 非法") };
    }
    keys.push(bounded);
  }
  return {
    ok: true,
    value: {
      bookName,
      entries: [{ category, comment, keys, content, ...entry.constant === true ? { constant: true } : {} }]
    }
  };
}
function asEntriesRecord(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data;
  if (!record.entries || typeof record.entries !== "object" || Array.isArray(record.entries)) return null;
  return record;
}
function entryView(raw) {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw;
  const comment = typeof entry.comment === "string" ? entry.comment : "";
  const category = comment.startsWith(ATLAS_LOREBOOK_PREFIX.moves) ? "moves" : comment.startsWith(ATLAS_LOREBOOK_PREFIX.events) ? "events" : null;
  if (!category) return null;
  const keys = Array.isArray(entry.key) ? entry.key.map((k) => String(k)).slice(0, ATLAS_LOREBOOK_LIMITS.KEYS_MAX) : [];
  const content = typeof entry.content === "string" ? entry.content.slice(0, ATLAS_LOREBOOK_LIMITS.CONTENT_CHARS) : "";
  return { category, comment, keys, content };
}
function collectAtlasEntries(data) {
  const entries = data.entries;
  const out = [];
  for (const [uid, raw] of Object.entries(entries)) {
    const view = entryView(raw);
    if (view) out.push({ uid, view });
  }
  return out;
}
function createAtlasLorebookWriter(port, opts = {}) {
  const now = opts.now ?? Date.now;
  async function loadOrCreate(name) {
    const loaded = await port.loadBook(name);
    const existing = asEntriesRecord(loaded);
    if (existing) return { data: existing, created: false };
    if (loaded !== null && loaded !== void 0) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "目标世界书载荷异常，跳过 Atlas 条目写入。");
    }
    await port.createBook(name);
    const created = await port.loadBook(name);
    const data = asEntriesRecord(created);
    if (!data) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "Atlas 世界书创建后无法读取。");
    }
    return { data, created: true };
  }
  return {
    /**
     * 把一轮的条目规划写入目标世界书（作者 2026-09-18 拍板：角色卡世界书优先）：
     * 0. 端口能解析出角色卡主世界书 → 直接写该书（cardMode，不占聊天绑定槽）；
     *    否则目标 = plans.bookName（Atlas 专属书）；
     * 1. 书不存在 → createBook；存在但非法 → 拒绝（不覆盖）；
     * 2. 按 comment upsert（同轮重复同步不产生重复条目）；
     * 3. 0.9.40 收口：书里只保留唯一的「Atlas 动向」滚动条目——旧版逐轮条目
     *    （「Atlas 动向 · 第 X → Y 时段」「Atlas 事件 · …」）与「Atlas 状态总览」
     *    一律清除（作者 2026-09-21 拍板：世界书只要动向、不强调时段）；
     * 4. 整书保存一次；保存后不再改动 data（酒馆缓存不深拷贝）；
     * 5. 专属书模式下：聊天绑定槽为空才绑定；已绑定别的书 → conflict（绝不静默覆盖）。
     */
    async syncTurn(plans) {
      if (!plans || !Array.isArray(plans.entries) || plans.entries.length === 0) {
        throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "lorebook 规划为空，跳过写入。");
      }
      let targetName = plans.bookName;
      let cardMode = false;
      if (typeof port.resolvePreferredBook === "function") {
        try {
          const preferred = await port.resolvePreferredBook();
          if (typeof preferred === "string" && preferred.trim()) {
            targetName = preferred;
            cardMode = true;
          }
        } catch {
        }
      }
      const { data, created } = await loadOrCreate(targetName);
      const entriesRecord = data.entries;
      let written = 0;
      for (const plan of plans.entries) {
        const isConstant = plan.constant === true;
        const existingUid = Object.keys(entriesRecord).find((uid) => {
          const raw = entriesRecord[uid];
          return raw && typeof raw.comment === "string" && raw.comment === plan.comment;
        });
        if (existingUid !== void 0) {
          const entry = entriesRecord[existingUid];
          entry.key = [...plan.keys];
          entry.keysecondary = [];
          entry.content = plan.content;
          entry.disable = false;
          entry.constant = isConstant;
          if (isConstant) entry.prevent_recursion = true;
        } else {
          port.createEntry(data, {
            comment: plan.comment,
            keys: [...plan.keys],
            content: plan.content,
            ...isConstant ? { constant: true, order: 9998, position: 0, preventRecursion: true } : {}
          });
        }
        written += 1;
      }
      let pruned = 0;
      const atlasPrefixes = Object.values(ATLAS_LOREBOOK_PREFIX);
      for (const [uid, raw] of Object.entries(entriesRecord)) {
        const comment = raw && typeof raw === "object" && typeof raw.comment === "string" ? raw.comment : "";
        const isAtlas = atlasPrefixes.some((prefix) => comment.startsWith(prefix));
        if (isAtlas && comment !== ATLAS_MOVES_ENTRY_COMMENT) {
          port.deleteEntry(data, uid);
          pruned += 1;
        }
      }
      const finalEntries = collectAtlasEntries(data).map((item) => item.view);
      await port.saveBook(targetName, data);
      let binding;
      let existingBookName = null;
      if (cardMode) {
        binding = "char-primary";
      } else {
        const chatBook = await port.getChatBookName();
        if (chatBook === null || chatBook === "") {
          await port.bindChatBook(targetName);
          binding = "bound-by-atlas";
        } else if (chatBook === targetName) {
          binding = "already-bound";
        } else {
          binding = "conflict";
          existingBookName = chatBook;
        }
      }
      return {
        bookName: targetName,
        created,
        written,
        pruned,
        binding,
        existingBookName,
        entries: finalEntries
      };
    },
    /** 面板可见性快照（调用方持久化到 store 的 "lorebook" 文档）。 */
    snapshot(plans, result) {
      return {
        schemaVersion: 1,
        bookName: result.bookName,
        updatedAt: now(),
        created: result.created,
        written: result.written,
        pruned: result.pruned,
        binding: result.binding,
        existingBookName: result.existingBookName,
        entries: result.entries
      };
    }
  };
}

// src/atlas-api-client.ts
function buildAtlasChatUrl(endpoint) {
  let url;
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
var DEFAULT_PROMPT_SEGMENTS = [
  {
    role: "system",
    name: "引擎身份与输出契约",
    mainSlot: "A",
    content: "你是阿特拉斯世界推演引擎。你将收到一份本轮的剧情素材（世界状态、前文、用户行动、助手回复），你的唯一职责：推断本轮对世界造成的**有界结构化变化**——谁出现在哪里、人物状态与关系如何变化、势力格局有无变动、时间推进多少。\n严格要求：只输出一个 JSON 对象，不要输出任何多余说明、推理过程或代码围栏。字段契约：\nduration（本轮消耗的时段数，非负数字，≤10000）、\nlocationChange（对象或 null：{toPointId, toRegionId}，id 必须来自上下文中出现的地点）、\nnpcChanges（数组，积极挖掘本轮动向，形状：{entityId, key, value} 更新人物状态 / {entityId, toPointId} 人物移动到上下文中出现的地点 / {entityId, toRegionId} 移动到已知地区 / {entityId, tag} 加标签 / {entityId, removeTag} 删标签 / {flag, value} 记录世界标记（里程碑、禁忌、传言等）/ {entityId, targetEntityId, key, value} 改关系；entityId 必须来自上下文）、\nmemoryDrafts（数组，每条 {entityId, text}，为人物追加一条记忆，≤500 字）、\nnewLocations（数组，本轮剧情里**新出现**的地点 / 地区：{name, regionName?, description?, submap?}；regionName 必须是本轮输出 regions 或上下文已有的地区名；已有地点不要重复列；教室 / 学校 / 商店 / 车站等剧情真实发生的具体场所也算地点（校园日常类故事尤其如此），剧情所在的主要场所应列出；没有就输出空数组；只有当剧情真的走进某地点内部（楼 / 院 / 遗迹内部）时，才给该地点挂可选的 submap: {scale?: {distancePerCell, unit}, points: [{name}]}——只给内部点位名字即可，坐标由算法决定；剧情没进去就不要编内部结构）、\neventDrafts（数组，事件摘要文字，仅叙述用）、\ntriggerResults（数组，本轮命中的触发器 id）、\nsummary（本轮世界变化的一句话摘要，≤500 字）。\n禁止：输出时间地点之外的世界重写；输出任何密钥、路径或代码。"
  },
  {
    role: "assistant",
    name: "确认·身份",
    content: "收到，我将以世界推演引擎的身份工作：只推断有界的世界变化，严格按 JSON 契约输出，绝不输出契约之外的任何内容。"
  },
  {
    role: "user",
    name: "背景设定（只读参考）",
    content: "【背景设定（只供理解世界，与本轮推演任务无直接关系）】\n<用户设定>\n$U\n</用户设定>\n<角色描述>\n$C\n</角色描述>\n$1\n============================此处为分割线====================\n请充分阅读以上资料；后续推演将以此为世界背景，不得改写其中任何既有设定。"
  },
  {
    role: "assistant",
    name: "确认·背景",
    content: "收到，我已通读背景设定，将把其中的人物、地点与规则运用到后续推演当中，绝不改动任何既有设定。"
  },
  {
    role: "user",
    name: "推演任务指令（HARD GATE）",
    mainSlot: "B",
    content: "---BEGIN PROMPT---\n[System]\n你是执行型世界推演 AI，专注于本轮有界结构化变化的推断，禁止发散叙事。\n\n[Input]\n- WORLD_STATE: 当前世界状态与可达内容（已在上方提供）\n- LAST_TURN: 上轮世界变化（已在上方提供）\n- PREVIOUS_PLOT: 前文故事发展（已在上方提供）\n- USER_ACTION: 本轮用户行动（稍后提供）\n- ASSISTANT_REPLY: 本轮助手回复（稍后提供）\n\n============================================================\n【核心规则 - HARD GATE】\n============================================================\n\n**一、id 纪律**\n上下文提供「人物 id 对照 / 地点 id 对照 / 地区 id 对照」：npcChanges 与 locationChange 的 id 一律使用对照表里的 id 原文，不要用名字当 id，禁止编造对照表之外的实体 id 或地点 id。\n\n**二、推断姿态**\n主动而非保守——只要剧情暗示了人物去了别处、态度与关系起了变化、状态被事件改变、出现了值得铭记或标记的事，就输出对应变化；只在整轮确实平静无事时才输出空数组。\n\n**三、时间与位置**\nduration 按剧情如实推断（注意「一整天 / 半天 / 许久 / 一会儿」等时间词）；无人物 / 关系 / 记忆变化时 npcChanges 与 memoryDrafts 输出空数组，duration 与 locationChange 仍须如实填写，不要为凑数编造变化。\n\n**四、newLocations**\n只列本轮剧情新出现或被明确抵达 / 提及的地点与地区；已有地点不要重复；宁缺毋滥。\n\n**五、纪律红线**\n禁止输出时间地点之外的世界重写；禁止输出任何密钥、路径或代码；全程只输出一个 JSON 对象，不输出说明文字或代码围栏。"
  },
  {
    role: "assistant",
    name: "确认·规则",
    content: "收到命令，我将严格遵守 HARD GATE：只使用对照表 id 原文、积极推断而不越界、如实填写时间与位置、newLocations 宁缺毋滥。"
  },
  {
    role: "user",
    name: "本轮素材（触发）",
    content: "现在开始本轮推演，以下是你尚未看到的两份素材。\n\n【本轮用户行动】\n$8\n\n【本轮助手回复】\n{{assistantReply}}\n\n请立即按契约只输出一个 JSON 对象。"
  },
  {
    role: "assistant",
    name: "输出引导",
    content: "{"
  }
];
var LEGACY_WORLD_TURN_TASK_CONTENT = "【当前世界状态与可达内容】\n$5\n\n$1\n【上轮世界变化】\n$6\n\n【前文故事发展（AI 输出）】\n$7\n\n【用户设定】\n$U\n\n【角色描述】\n$C\n\n【本轮用户行动】\n$8\n\n【本轮助手回复】\n{{assistantReply}}\n\n请按系统要求只输出一个 JSON 对象。";
var DEFAULT_WORLD_TURN_SYSTEM_PROMPT = DEFAULT_PROMPT_SEGMENTS[0].content;
var LORE_SUPPLEMENT_HEADER = "【世界书资料（当前角色卡，可能有噪声，仅供理解世界）】";
function wrapWorldbookContext(content) {
  const text = String(content ?? "");
  return text ? `
<worldbook_context>
${text}
</worldbook_context>
` : "";
}
function substitutePromptPlaceholders(content, input) {
  if (!content) return "";
  let processed = String(content);
  const loreRaw = input.loreSupplement ?? "";
  const loreText = loreRaw ? `${LORE_SUPPLEMENT_HEADER}${wrapWorldbookContext(loreRaw)}` : "";
  const replacements = {
    $1: loreText,
    $9: "",
    $5: input.injectionText ?? "",
    $6: input.lastTurnSummary ?? "",
    $7: input.recentContextText ?? "",
    $8: input.userText ?? "",
    $U: input.personaDescription ?? "",
    $C: input.charDescription ?? ""
  };
  for (const [key, value] of Object.entries(replacements)) {
    processed = processed.replace(new RegExp(`(?<!\\\\)\\${key}`, "g"), () => value);
  }
  processed = processed.replace(/\{\{\s*worldState\s*\}\}/g, input.injectionText ?? "").replace(/\{\{\s*userAction\s*\}\}/g, input.userText ?? "").replace(/\{\{\s*worldLore\s*\}\}/g, loreRaw).replace(/\{\{\s*assistantReply\s*\}\}/g, input.assistantText ?? "");
  return processed;
}
var PROMPT_MESSAGE_ROLES = ["system", "user", "assistant"];
function buildWorldTurnMessages(preset, input) {
  const rawSegments = Array.isArray(preset.promptSegments) ? preset.promptSegments : [];
  const messages = rawSegments.map((segment) => ({
    role: typeof segment?.role === "string" ? segment.role.trim().toLowerCase() : "",
    content: typeof segment?.content === "string" ? segment.content : ""
  })).filter((segment) => PROMPT_MESSAGE_ROLES.includes(segment.role) && segment.content.trim().length > 0).map((segment) => ({ role: segment.role, content: substitutePromptPlaceholders(segment.content, input) }));
  if (messages.length > 0) return messages;
  const connectionSystem = preset.systemPrompt?.trim() || "";
  if (connectionSystem) {
    return [
      { role: "system", content: substitutePromptPlaceholders(connectionSystem, input) },
      { role: "user", content: substitutePromptPlaceholders(LEGACY_WORLD_TURN_TASK_CONTENT, input) }
    ].filter((segment) => segment.content.trim().length > 0);
  }
  return DEFAULT_PROMPT_SEGMENTS.map((segment) => ({ role: segment.role, content: substitutePromptPlaceholders(segment.content, input) })).filter((segment) => segment.content.trim().length > 0);
}
function errorMessageForStatus(status) {
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
async function callAtlasWorldTurnApi(preset, input, deps = {}) {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const fail4 = (code, message, retryable, status) => ({
    ok: false,
    code,
    message,
    retryable,
    ...typeof status === "number" ? { status } : {},
    durationMs: now() - startedAt
  });
  const mode = preset.connectionMode ?? "custom";
  const url = mode === "custom" ? buildAtlasChatUrl(preset.endpoint) : "atlas://host";
  if (!url) return fail4(ATLAS_ERROR_CODES.API_NOT_CONFIGURED, "推演 API 地址无效，无法构造请求。", false);
  if (mode === "custom" && !preset.model.trim()) return fail4(ATLAS_ERROR_CODES.API_NOT_CONFIGURED, "推演预设未填写模型名称。", false);
  const bodyMessages = buildWorldTurnMessages(preset, input).map((m) => ({ ...m, role: m.role.toLowerCase() }));
  const bodyModel = preset.model.trim().replace(/^models\//, "") || "host";
  const maxTokens = typeof preset.maxTokens === "number" && preset.maxTokens > 0 ? preset.maxTokens : 2e4;
  const temperature = typeof preset.temperature === "number" ? preset.temperature : 1;
  const topP = typeof preset.topP === "number" ? preset.topP : 0.95;
  const timeoutMs = Math.min(Math.max(preset.timeoutMs ?? 3e4, 1e3), 12e4);
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const buildPayload = (forClaude) => {
    const requestUrl = forClaude ? rescueAnthropicUrl(url) : url;
    const headers = {
      "Content-Type": "application/json",
      ...preset.apiKey.trim() ? { Authorization: `Bearer ${preset.apiKey.trim()}` } : {},
      // 浏览器代理适配层据此映射为酒馆 claude / gemini 源；直连（测试）时无副作用
      ...preset.apiFormat === "claude" || forClaude ? { "X-Atlas-Api-Format": "claude" } : {},
      ...preset.apiFormat === "gemini" ? { "X-Atlas-Api-Format": "gemini" } : {}
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
      ...mode !== "custom" ? { xAtlasConnectionMode: mode } : {},
      ...mode === "profile" && preset.profileId?.trim() ? { xAtlasProfileId: preset.profileId.trim() } : {},
      // 0.9.14 shujuku 同款：custom_url 用「用户原始端点」，ST 后端自己决定拼接，
      // 不由引擎预拼 /chat/completions（与 shujuku 走同一条 URL 构造路径）。
      ...mode === "custom" && preset.endpoint.trim() ? { xAtlasCustomUrl: preset.endpoint.trim() } : {},
      ...preset.bodyParams?.trim() ? { xAtlasBodyParams: preset.bodyParams } : {},
      ...preset.excludeBodyParams?.trim() ? { xAtlasExcludeBodyParams: preset.excludeBodyParams } : {},
      ...preset.requestHeaders?.trim() ? { xAtlasExtraHeaders: preset.requestHeaders } : {},
      ...preset.promptPostProcessing?.trim() ? { xAtlasPromptPostProcessing: preset.promptPostProcessing } : {}
    });
    return { url: requestUrl, headers, body };
  };
  try {
    let response;
    let rescueAttempted = false;
    const initial = buildPayload(false);
    try {
      response = await fetchFn(initial.url, {
        method: "POST",
        headers: initial.headers,
        body: initial.body,
        signal: controller.signal
      });
    } catch {
      if (controller.signal.aborted) return fail4(ATLAS_ERROR_CODES.API_TIMEOUT, `推演请求超过 ${timeoutMs}ms 超时。`, true);
      return fail4(ATLAS_ERROR_CODES.SERVICE_OFFLINE, "无法连接推演服务，请检查网络或服务状态。", true);
    }
    const parseCall = async (resp) => {
      let rawText = "";
      try {
        rawText = typeof resp.text === "function" ? await resp.text() : JSON.stringify(await resp.json());
      } catch {
        rawText = "";
      }
      let payload = null;
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = firstSsePayload(rawText);
      }
      const text2 = extractAssistantText(payload);
      if (text2 === null || text2.trim().length === 0) {
        const emptyChoices = Boolean(
          payload && typeof payload === "object" && Array.isArray(payload.choices) && payload.choices.length === 0
        );
        return { text: null, gatewayError: gatewayErrorMessage(payload), rawText, emptyChoices };
      }
      return { text: text2.trim(), gatewayError: null, rawText, emptyChoices: false };
    };
    let parsed = await parseCall(response);
    let status = response.status;
    if (mode === "custom" && preset.apiFormat !== "claude" && parsed.gatewayError && /Not Found/i.test(parsed.gatewayError) && isMinimaxUrl(url) && /^sk-cp-/i.test(preset.apiKey.trim())) {
      const rescue = buildPayload(true);
      try {
        const rescueResponse = await fetchFn(rescue.url, {
          method: "POST",
          headers: rescue.headers,
          body: rescue.body,
          signal: controller.signal
        });
        status = rescueResponse.status;
        const rescueParsed = await parseCall(rescueResponse);
        if (rescueParsed.text !== null) {
          parsed = rescueParsed;
          rescueAttempted = true;
        }
      } catch {
      }
    }
    if (!response.ok && !rescueAttempted) {
      const mapped = errorMessageForStatus(status);
      return fail4(mapped.code, mapped.message, mapped.retryable, status);
    }
    const text = parsed.text;
    if (text === null || text.length === 0) {
      if (parsed.emptyChoices) {
        return fail4(
          ATLAS_ERROR_CODES.RESPONSE_MALFORMED,
          "模型返回了空回复（choices 为空、0 补全 token）——通常是供应商安全过滤静默拦截了本次输入（Gemini 系常见），也可能是上游网关故障。可选：在「推进」页关闭「世界书资料」缩小输入，或换模型 / 供应商。",
          false
        );
      }
      const gatewayError = parsed.gatewayError;
      if (gatewayError) {
        const moderationLike = /sensitive|unprocessable|敏感|审核/i.test(gatewayError) || /unprocessable_entity_error|new_sensitive/i.test(parsed.rawText);
        if (moderationLike) {
          const snippet2 = parsed.rawText.replace(/\s+/g, " ").trim().slice(0, 200);
          return fail4(
            ATLAS_ERROR_CODES.RESPONSE_MALFORMED,
            `推演被模型服务商内容审核拦截（HTTP 200 包 422 unprocessable / sensitive）——本次推演的输入触发了供应商的敏感内容检测，重试同样会被拦。可选：换模型 / 换供应商，或调整涉及的卡书条目与行动文本。原始错误：${snippet2}`,
            false
          );
        }
        const minimaxHint = minimaxNotFoundHint(url, gatewayError, preset.apiKey);
        return fail4(
          ATLAS_ERROR_CODES.RESPONSE_MALFORMED,
          `推演服务返回错误：${gatewayError}（HTTP 200，但响应体是错误 JSON）——通常是模型名在网关上不存在 / 无可用渠道，或端点路径不完整（一般应为 http(s)://地址/v1，Atlas 会自动补 /chat/completions）。请到「日志」页核对实际发送的目标与模型名。${minimaxHint}`,
          false
        );
      }
      const snippet = parsed.rawText.replace(/\s+/g, " ").trim().slice(0, 200);
      return fail4(
        ATLAS_ERROR_CODES.RESPONSE_MALFORMED,
        `推演服务返回为空或不支持的格式${snippet ? `（响应开头：${snippet}）` : "（响应体为空）"}。`,
        false
      );
    }
    return {
      ok: true,
      text,
      status,
      durationMs: now() - startedAt,
      ...rescueAttempted ? { notice: "已按 MiniMax 订阅密钥自动切换 Anthropic 路由（…/anthropic）重试成功。建议到「API」页把该连接的接口协议改为 Claude（Anthropic）、端点改为 …/anthropic 并保存。" } : {}
    };
  } finally {
    clearTimeout(timer);
  }
}
function isMinimaxUrl(url) {
  return /minimax/i.test(url);
}
function rescueAnthropicUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.pathname = "/anthropic/chat/completions";
    return parsed.toString();
  } catch {
    return url;
  }
}
function gatewayErrorMessage(payload) {
  if (!payload || typeof payload !== "object") return null;
  const error = payload.error;
  if (typeof error === "string") return error.slice(0, 120) || null;
  if (error && typeof error === "object") {
    const message = error.message;
    if (typeof message === "string" && message.trim()) return message.slice(0, 120);
  }
  return null;
}
function minimaxNotFoundHint(url, gatewayError, apiKey) {
  if (!/Not Found/i.test(gatewayError)) return "";
  if (!/minimax/i.test(url)) return "";
  const isSubscriptionKey = /^sk-cp-/i.test(apiKey.trim());
  if (isSubscriptionKey) {
    return " 【MiniMax 检测】你的密钥是 Token Plan 订阅密钥（sk-cp- 开头），它只能走 Anthropic Messages 协议——在 Atlas「API」页把接口协议切到 Claude（Anthropic），端点填 https://api.minimaxi.com/anthropic（国际站用 https://api.minimax.io/anthropic）；如需 OpenAI 兼容调用，请改用按量付费密钥（sk-api- 开头）并确保账户有余额。";
  }
  return " 【MiniMax 检测】① 国内站（minimaxi.com / minimax.chat）与国际站（minimax.io）密钥不通用，请确认密钥归属的平台与 API 地址一致；② 订阅密钥（sk-cp- 开头）只能走 Anthropic Messages 协议（Atlas「API」页把接口协议切到 Claude（Anthropic），端点填 …/anthropic），按量付费密钥（sk-api- 开头）才能用 /v1/chat/completions 且账户需有余额；③ 到控制台「模型列表」核对 MiniMax-M3 是否为该账号可调用名称。";
}
function firstSsePayload(raw) {
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
function textContentOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof part.text === "string") {
        return part;
      }
      return null;
    }).filter((part) => part !== null).map((part) => part.text).join("");
    return parts.length > 0 ? parts : null;
  }
  return null;
}
function pickFirstNonEmpty(values) {
  for (const value of values) {
    if (value !== null && value.trim().length > 0) return value;
  }
  for (const value of values) {
    if (value !== null) return value;
  }
  return null;
}
function extractAssistantText(payload) {
  if (!payload || typeof payload !== "object") return null;
  const p = payload;
  if (Array.isArray(p.choices) && p.choices.length > 0) {
    const choice = p.choices[0];
    const fromMessage = textContentOf(choice?.message?.content);
    const fromReasoning = textContentOf(choice?.message?.reasoning_content) ?? textContentOf(choice?.message?.reasoning);
    const picked = pickFirstNonEmpty([
      fromMessage,
      fromReasoning,
      typeof choice?.text === "string" ? choice.text : null
    ]);
    if (picked !== null) return picked;
  }
  const fromOllamaMessage = pickFirstNonEmpty([
    textContentOf(p.message?.content),
    textContentOf(p.message?.reasoning_content)
  ]);
  if (fromOllamaMessage !== null) return fromOllamaMessage;
  for (const key of ["text", "content", "response"]) {
    const value = textContentOf(p[key]);
    if (value !== null) return value;
  }
  return null;
}
function extractJsonObject(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1] ?? "", text, extractBalancedJsonObject(text)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const sanitized = sanitizeJsonText(candidate);
    if (!sanitized) continue;
    try {
      const parsed = JSON.parse(sanitized);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
    }
  }
  return null;
}
function extractBalancedJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
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
function sanitizeJsonText(jsonStr) {
  if (!jsonStr) return "";
  let sanitized = String(jsonStr).replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/^[^{]*?(\{)/s, "$1").trim();
  sanitized = extractBalancedJsonObject(sanitized) || sanitized;
  return sanitized.replace(/,\s*([}\]])/g, "$1").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
function toDuration(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return null;
}
function toLocationChange(value) {
  if (value === null || value === void 0) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AtlasError(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "locationChange 必须是对象或 null");
  }
  const record = value;
  const toPointId = typeof record.toPointId === "string" && record.toPointId.trim() ? record.toPointId.trim() : null;
  const toRegionId = typeof record.toRegionId === "string" && record.toRegionId.trim() ? record.toRegionId.trim() : null;
  if (!toPointId && !toRegionId) return null;
  return { toPointId, toRegionId };
}
function npcChangeToEffect(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw;
  const entityId = typeof record.entityId === "string" ? record.entityId.trim() : "";
  const entityIdOk = entityId !== "" && entityId.length <= ATLAS_LIMITS.ID_CHARS;
  if (entityIdOk && typeof record.targetEntityId === "string" && record.targetEntityId.trim() && typeof record.key === "string" && record.key.trim() && "value" in record) {
    return { kind: "adjustRelation", entityId, targetEntityId: record.targetEntityId.trim(), key: record.key.trim(), value: record.value };
  }
  if (typeof record.key === "string" && record.key.trim() && "value" in record && entityIdOk) {
    return { kind: "setTemporalField", entityId, key: record.key.trim(), value: record.value };
  }
  if (entityIdOk) {
    const toPointId = typeof (record.toPointId ?? record.pointId) === "string" ? String(record.toPointId ?? record.pointId).trim() : "";
    const toRegionId = typeof (record.toRegionId ?? record.regionId) === "string" ? String(record.toRegionId ?? record.regionId).trim() : "";
    if (toPointId || toRegionId) {
      return {
        kind: "moveEntity",
        entityId,
        ...toPointId ? { pointId: toPointId } : {},
        ...toRegionId ? { regionId: toRegionId } : {}
      };
    }
  }
  if (typeof record.tag === "string" && record.tag.trim() && entityIdOk) {
    return { kind: "addTag", entityId, tag: record.tag.trim() };
  }
  if (typeof record.removeTag === "string" && record.removeTag.trim() && entityIdOk) {
    return { kind: "removeTag", entityId, tag: record.removeTag.trim() };
  }
  if (typeof record.flag === "string" && record.flag.trim()) {
    const flagValue = typeof record.value === "string" && record.value.trim() ? record.value.trim() : void 0;
    return { kind: "setFlag", key: record.flag.trim(), ...flagValue ? { value: flagValue } : {} };
  }
  return null;
}
function parseAtlasWorldTurnDraft(text) {
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
  const rawEffects = [];
  let droppedEffects = 0;
  if (draftSource.npcChanges !== void 0 && draftSource.npcChanges !== null) {
    if (!Array.isArray(draftSource.npcChanges)) {
      throw new AtlasError(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "推演输出 npcChanges 必须是数组。");
    }
    draftSource.npcChanges.forEach((item) => {
      const effect = npcChangeToEffect(item);
      if (!effect) {
        droppedEffects += 1;
        return;
      }
      if (rawEffects.length >= ATLAS_LIMITS.REF_ARRAY) return;
      rawEffects.push(effect);
    });
  }
  const memoryDrafts = [];
  let droppedMemories = 0;
  if (draftSource.memoryDrafts !== void 0 && draftSource.memoryDrafts !== null) {
    if (!Array.isArray(draftSource.memoryDrafts)) {
      throw new AtlasError(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "推演输出 memoryDrafts 必须是数组。");
    }
    draftSource.memoryDrafts.forEach((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        droppedMemories += 1;
        return;
      }
      const record = item;
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
  const newLocations = [];
  let droppedLocations = 0;
  if (draftSource.newLocations !== void 0 && draftSource.newLocations !== null) {
    if (!Array.isArray(draftSource.newLocations)) {
      throw new AtlasError(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "推演输出 newLocations 必须是数组。");
    }
    for (const item of draftSource.newLocations) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        droppedLocations += 1;
        continue;
      }
      const record = item;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      if (!name) {
        droppedLocations += 1;
        continue;
      }
      const regionName = typeof record.regionName === "string" && record.regionName.trim() ? record.regionName.trim() : void 0;
      const description = typeof record.description === "string" && record.description.trim() ? record.description.trim() : void 0;
      const submap = record.submap && typeof record.submap === "object" && !Array.isArray(record.submap) ? record.submap : void 0;
      newLocations.push({ name, ...regionName ? { regionName } : {}, ...description ? { description } : {}, ...submap ? { submap } : {} });
    }
  }
  const droppedTotal = droppedEffects + droppedMemories + droppedLocations;
  return {
    duration: rawDuration,
    locationChange,
    rawEffects,
    memoryDrafts,
    ...newLocations.length > 0 ? { newLocations } : {},
    summary: droppedTotal > 0 ? `${summary}（解析时丢弃 ${droppedEffects} 条无法识别的变化、${droppedMemories} 条残缺记忆、${droppedLocations} 条残缺新地点）` : summary
  };
}
function salvageDraftContainerFromRawText(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const summary = extractRawStringField(raw, "summary");
  const durationText = extractRawStringField(raw, "duration");
  if (!summary && !durationText) return null;
  const container = {};
  if (summary) container.summary = summary;
  if (durationText) container.duration = durationText;
  const effects = salvageObjectArrayFromRawText(raw, "npcChanges").map((item) => npcChangeToEffect(item)).filter((item) => item !== null).slice(0, ATLAS_LIMITS.REF_ARRAY);
  if (effects.length > 0) container.npcChanges = effects;
  const memories = salvageObjectArrayFromRawText(raw, "memoryDrafts").filter((item) => typeof item.entityId === "string" && item.entityId.trim() && typeof item.text === "string" && item.text.trim()).slice(0, ATLAS_LIMITS.REF_ARRAY);
  if (memories.length > 0) container.memoryDrafts = memories;
  const newLocations = salvageObjectArrayFromRawText(raw, "newLocations").filter((item) => typeof item.name === "string" && item.name.trim()).slice(0, 12);
  if (newLocations.length > 0) container.newLocations = newLocations;
  const locationRaw = extractRawStringField(raw, "toPointId");
  const regionRaw = extractRawStringField(raw, "toRegionId");
  if (locationRaw || regionRaw) container.locationChange = { toPointId: locationRaw ?? null, toRegionId: regionRaw ?? null };
  return container;
}
function extractRawStringField(source, fieldName) {
  if (typeof source !== "string" || !fieldName) return "";
  const match = new RegExp(`"${fieldName}"\\s*:\\s*"`).exec(source);
  if (!match) return "";
  let i = match.index + match[0].length;
  let result = "";
  let escaped = false;
  while (i < source.length) {
    const ch = source[i];
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
  return result.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "	").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
function salvageObjectArrayFromRawText(raw, fieldName) {
  const arrayMatch = new RegExp(`"${fieldName}"\\s*:\\s*\\[`).exec(raw);
  if (!arrayMatch) return [];
  const arrayStart = raw.indexOf("[", arrayMatch.index);
  if (arrayStart < 0) return [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let arrayEnd = -1;
  for (let i = arrayStart; i < raw.length; i += 1) {
    const ch = raw[i];
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
  const objects = [];
  let objStart = -1;
  depth = 0;
  inString = false;
  escaped = false;
  for (let i = 0; i < arrayContent.length; i += 1) {
    const ch = arrayContent[i];
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
          const obj = JSON.parse(sanitizeJsonText(objText));
          if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            objects.push(obj);
          }
        } catch {
        }
        objStart = -1;
      }
    }
  }
  return objects;
}

// src/atlas-proxy-fetch.ts
var ATLAS_ST_GENERATE_PATH = "/api/backends/chat-completions/generate";
function atlasCustomIncludeHeaders(headerValue) {
  const value = (headerValue ?? "").trim();
  return value ? `Authorization: ${value}` : "";
}
function normalizeAtlasClaudeBase(rawUrl) {
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
    return base;
  }
  if (path === "" || path === "/") return `${base}/v1`;
  if (!base.endsWith("/v1")) return `${base}/v1`;
  return base;
}
function normalizeAtlasGeminiBase(rawUrl) {
  let base = String(rawUrl || "").trim().replace(/\/+$/, "");
  if (!base) return "";
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
function normalizeAtlasExcludeBody(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("- ") || trimmed.startsWith("[") || trimmed.startsWith("{")) return trimmed;
  const keys = trimmed.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  return keys.map((key) => `- ${key}`).join("\n");
}
function normalizeAtlasPromptPostProcessing(raw) {
  const allowed = ["", "merge_tools", "semi_tools", "strict_tools", "merge", "semi", "strict", "single"];
  return typeof raw === "string" && allowed.includes(raw) ? raw : "";
}
function pickAuthorization(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  const record = headers;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === "authorization" && typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
function pickAtlasApiFormat(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  const record = headers;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === "x-atlas-api-format" && typeof value === "string") {
      const format = value.trim().toLowerCase();
      if (format === "claude" || format === "gemini") return format;
    }
  }
  return null;
}
function stripBearerPrefix(authorization) {
  if (!authorization) return "";
  return authorization.replace(/^Bearer\s+/i, "");
}
function createStProxyFetch(deps) {
  const innerFetch = deps.fetchFn ?? globalThis.fetch.bind(globalThis);
  return async function atlasProxiedFetch(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "POST").toUpperCase();
    let payload = null;
    if (method === "POST" && typeof init?.body === "string" && init.body.trimStart().startsWith("{")) {
      try {
        const parsed = JSON.parse(init.body);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "model" in parsed && "messages" in parsed) {
          payload = parsed;
        }
      } catch {
        payload = null;
      }
    }
    if (!payload) {
      return innerFetch(input, init);
    }
    const authorization = pickAuthorization(init?.headers);
    const apiFormat = pickAtlasApiFormat(init?.headers);
    const csrfHeaders = deps.getContext().getRequestHeaders() ?? {};
    const bodyParams = typeof payload.xAtlasBodyParams === "string" ? payload.xAtlasBodyParams.trim() : "";
    const excludeBody = typeof payload.xAtlasExcludeBodyParams === "string" ? payload.xAtlasExcludeBodyParams : "";
    const extraHeaders = typeof payload.xAtlasExtraHeaders === "string" ? payload.xAtlasExtraHeaders.trim() : "";
    const promptPost = normalizeAtlasPromptPostProcessing(payload.xAtlasPromptPostProcessing);
    const customUrlRaw = typeof payload.xAtlasCustomUrl === "string" && payload.xAtlasCustomUrl.trim() ? payload.xAtlasCustomUrl.trim() : url;
    const nativeBase = apiFormat === "claude" ? normalizeAtlasClaudeBase(url) : apiFormat === "gemini" ? normalizeAtlasGeminiBase(url) : null;
    const nativeSource = apiFormat === "claude" ? "claude" : apiFormat === "gemini" ? "makersuite" : null;
    const includeHeaders = [atlasCustomIncludeHeaders(authorization), extraHeaders].filter(Boolean).join("\n");
    const proxyBody = {
      chat_completion_source: nativeSource ?? "custom",
      // shujuku buildCustomApiRequestBody_ACU：custom 源也带 reverse_proxy = 原始端点
      // （ST 后端 custom 源优先走 reverse_proxy；shujuku 的 custom_url/reverse_proxy 都填 apiUrl）
      ...nativeBase ? { reverse_proxy: nativeBase, proxy_password: stripBearerPrefix(authorization) } : { reverse_proxy: customUrlRaw, proxy_password: "" },
      custom_url: customUrlRaw,
      model: payload.model,
      messages: payload.messages,
      stream: payload.stream ?? false,
      ...payload.temperature !== void 0 ? { temperature: payload.temperature } : {},
      ...payload.max_tokens !== void 0 ? { max_tokens: payload.max_tokens } : {},
      custom_include_headers: includeHeaders,
      ...bodyParams ? { custom_include_body: bodyParams } : {},
      ...excludeBody.trim() ? { custom_exclude_body: normalizeAtlasExcludeBody(excludeBody) } : {},
      ...promptPost ? { custom_prompt_post_processing: promptPost } : {}
    };
    return innerFetch(ATLAS_ST_GENERATE_PATH, {
      method: "POST",
      headers: {
        ...csrfHeaders,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(proxyBody),
      signal: init?.signal
    });
  };
}

// src/atlas-ui-core.ts
function atlasClampZoom(value) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(3, Math.max(1, value));
}
var ATLAS_UI_EVENTS = [
  "APP_READY",
  "CHAT_CHANGED",
  "MESSAGE_SENT",
  "MESSAGE_RECEIVED",
  "GENERATION_ENDED",
  "GENERATION_STOPPED",
  "GENERATION_STARTED",
  "MESSAGE_SWIPED",
  "MESSAGE_EDITED",
  "MESSAGE_DELETED"
];
var HEALTH_CACHE_MS = 3e4;
function modeHintFor(mode, bindingInvalid, protocolVersion, bindingDisabled) {
  if (bindingInvalid) return "聊天中的 Atlas 绑定数据损坏，已按未绑定处理；可重新绑定世界。";
  if (bindingDisabled && mode === "unbound") return "已在当前聊天停用 Atlas 推演；可随时重新启用。";
  switch (mode) {
    case "offline":
      return "Atlas 本地引擎未就绪：刷新页面或重进聊天即可恢复；酒馆聊天不受影响。";
    case "protocol-incompatible":
      return `Atlas 引擎协议版本（${String(protocolVersion)}）与扩展（${ATLAS_PROTOCOL_VERSION}）不一致，安装包可能不完整：请重新安装最新版插件。`;
    case "unbound":
      return "当前聊天未绑定 Atlas 世界。发送第一条消息会按角色卡自动建世；也可在「概览」的高级区绑定已有世界。";
    case "world-missing":
      return "绑定的世界不存在或已被删除。请解绑后重新选择世界。";
    case "ready":
      return null;
  }
}
function createAtlasUiCore(deps) {
  const { api, host, emitter } = deps;
  const now = deps.now ?? Date.now;
  let state = {
    mode: "unbound",
    page: "overview",
    worldInitialization: "idle",
    worldInitializationError: null,
    panelOpen: false,
    serviceStatus: "checking",
    serviceProtocolVersion: null,
    binding: null,
    bindingInvalid: false,
    chatId: null,
    stateData: null,
    destinationPreview: null,
    pendingTurn: null,
    receipts: [],
    retryableCommit: null,
    modeHint: modeHintFor("unbound", false, null, false),
    lorebookHint: null,
    lastError: null,
    worldNotice: null,
    rearmTurn: null
  };
  let initialized = false;
  let disposed = false;
  let healthCheckedAt = -Infinity;
  let commitInFlight = false;
  let lastPrepareTask = null;
  let generationGate = false;
  let swipeIdForNextCommit = null;
  let endedTimer = null;
  let mutationTimer = null;
  let lastEndedEvent = null;
  let mutationQueue = [];
  const rolledBackFloors = /* @__PURE__ */ new Set();
  const listeners = [];
  function setState(patch) {
    state = { ...state, ...patch };
    if (patch.mode !== void 0 || patch.bindingInvalid !== void 0 || patch.serviceProtocolVersion !== void 0) {
      state.modeHint = modeHintFor(state.mode, state.bindingInvalid, state.serviceProtocolVersion, state.binding !== null && !state.binding.enabled);
    }
    deps.onStateChange?.();
  }
  const RECEIPTS_MAX = 10;
  const RECEIPTS_CHATS_MAX = 20;
  let legacyReceiptsCleared = false;
  function sanitizeReceiptRecord(raw, fallbackChatId) {
    if (!raw || typeof raw !== "object") return null;
    const record = raw;
    if (typeof record.receiptId !== "string" || typeof record.summary !== "string") return null;
    return {
      receiptId: record.receiptId,
      chatId: typeof record.chatId === "string" && record.chatId ? record.chatId : fallbackChatId,
      status: typeof record.status === "string" ? record.status : "committed",
      summary: record.summary.slice(0, 300),
      previousTime: typeof record.previousTime === "number" ? record.previousTime : 0,
      currentTime: typeof record.currentTime === "number" ? record.currentTime : 0,
      currentLocationId: typeof record.currentLocationId === "string" ? record.currentLocationId : null,
      adoptedEventCount: typeof record.adoptedEventCount === "number" ? record.adoptedEventCount : 0,
      recordedAt: typeof record.recordedAt === "number" ? record.recordedAt : 0
    };
  }
  function readReceiptBuckets() {
    const raw = host.readData("receiptsByChat");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const buckets = {};
    for (const [chatId, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      const records = list.slice(0, RECEIPTS_MAX).map((item) => sanitizeReceiptRecord(item, chatId)).filter((item) => item !== null);
      if (records.length > 0) buckets[chatId] = records;
    }
    return buckets;
  }
  function persistReceipts(chatId, receipts) {
    const buckets = readReceiptBuckets();
    if (receipts.length > 0) buckets[chatId] = receipts;
    else delete buckets[chatId];
    const kept = Object.entries(buckets).sort((left, right) => (right[1][0]?.recordedAt ?? 0) - (left[1][0]?.recordedAt ?? 0)).slice(0, RECEIPTS_CHATS_MAX);
    host.writeData("receiptsByChat", Object.fromEntries(kept));
    if (!legacyReceiptsCleared) {
      legacyReceiptsCleared = true;
      host.writeData("receipts", null);
    }
  }
  function restoreReceiptsForChat(chatId) {
    if (chatId === null) {
      setState({ receipts: [] });
      return;
    }
    setState({ receipts: readReceiptBuckets()[chatId] ?? [] });
  }
  function addReceipt(receipt, chatId) {
    if (chatId !== state.chatId) return;
    if (state.receipts.some((r) => r.receiptId === receipt.receiptId)) return;
    const record = {
      receiptId: receipt.receiptId,
      chatId,
      status: receipt.status,
      summary: receipt.summary.slice(0, 300),
      previousTime: receipt.previousTime,
      currentTime: receipt.currentTime,
      currentLocationId: typeof receipt.currentLocationId === "string" ? receipt.currentLocationId : null,
      adoptedEventCount: receipt.adoptedEventIds.length,
      recordedAt: now()
    };
    const receipts = [record, ...state.receipts].slice(0, RECEIPTS_MAX);
    setState({ receipts });
    persistReceipts(chatId, receipts);
  }
  function lorebookHintFromResult(result) {
    if (!result || typeof result !== "object" || Array.isArray(result)) return null;
    const record = result;
    if (record.binding === "conflict") {
      const existing = typeof record.existingBookName === "string" ? record.existingBookName : "";
      return `Atlas 条目已写入《${String(record.bookName ?? "")}》，但本聊天已绑定世界书《${existing}》——条目要生效需在酒馆世界书里切换或同时激活。`;
    }
    return null;
  }
  async function syncLorebookAfterCommit(body) {
    if (!deps.onLorebookSync) return;
    const data = body?.data;
    const lorebookRaw = data?.lorebook;
    if (!lorebookRaw) return;
    const parsed = parseAtlasLorebookPlans(lorebookRaw);
    if (!parsed.ok) {
      setState({ lorebookHint: "世界书条目载荷异常，本轮跳过写入。" });
      return;
    }
    try {
      const result = await deps.onLorebookSync(parsed.value);
      setState({ lorebookHint: lorebookHintFromResult(result) });
    } catch (error) {
      setState({ lorebookHint: `世界书写入失败：${error instanceof Error ? error.message : String(error)}` });
    }
  }
  function register(event, handler) {
    emitter.on(event, handler);
    listeners.push({ event, handler });
  }
  async function checkHealth() {
    if (now() - healthCheckedAt < HEALTH_CACHE_MS && state.serviceStatus !== "checking") return;
    healthCheckedAt = now();
    try {
      const result = await api.request("GET", "/health");
      const body = result.body;
      const payload = body?.data;
      const version = payload && typeof payload.protocolVersion === "number" ? payload.protocolVersion : null;
      if (version !== ATLAS_PROTOCOL_VERSION) {
        setState({ serviceStatus: "incompatible", serviceProtocolVersion: version, mode: "protocol-incompatible" });
        return;
      }
      setState({ serviceStatus: "online", serviceProtocolVersion: version });
    } catch {
      setState({ serviceStatus: "offline", serviceProtocolVersion: null, mode: "offline" });
    }
  }
  async function syncFromHost() {
    const chatId = host.getChatId();
    const panelOpen = host.readPanelOpen();
    setState({ chatId, panelOpen, destinationPreview: null });
    if (state.serviceStatus === "offline" || state.serviceStatus === "incompatible") return;
    if (chatId === null) {
      setState({ binding: null, bindingInvalid: false, mode: "unbound", stateData: null });
      return;
    }
    const raw = await host.readBinding();
    if (raw === null || raw === void 0) {
      setState({ binding: null, bindingInvalid: false, mode: "unbound", stateData: null });
      return;
    }
    const parsed = parseAtlasChatBinding(raw);
    if (!parsed.ok) {
      setState({ binding: null, bindingInvalid: true, mode: "unbound", stateData: null });
      return;
    }
    const binding = parsed.value;
    if (binding.chatId !== chatId) {
      setState({ binding: null, bindingInvalid: false, mode: "unbound", stateData: null });
      return;
    }
    setState({ binding, bindingInvalid: false });
  }
  async function loadStateData() {
    const binding = state.binding;
    if (!binding || state.serviceStatus !== "online" || state.chatId === null) return;
    if (!binding.enabled) {
      setState({ mode: "unbound", stateData: null });
      return;
    }
    if (binding.chatId !== state.chatId) {
      setState({ binding: null, mode: "unbound", stateData: null });
      return;
    }
    try {
      const result = await api.request("POST", "/state", { chatId: binding.chatId });
      const body = result.body;
      if (state.chatId === null || binding.chatId !== state.chatId) return;
      if (result.status === 200 && body.ok && body.data) {
        const responseChatId = typeof body.data.chatId === "string" ? body.data.chatId : binding.chatId;
        if (responseChatId !== state.chatId) return;
        setState({ mode: "ready", stateData: body.data, lastError: null });
        return;
      }
      const code = body.error?.code ?? "";
      if (code === ATLAS_ERROR_CODES.WORLD_NOT_FOUND) {
        setState({ mode: "world-missing", stateData: null });
        return;
      }
      if (code === ATLAS_ERROR_CODES.NOT_BOUND) {
        setState({ mode: "unbound", stateData: null });
        return;
      }
      setState({ lastError: body.error?.message ?? `状态读取失败（HTTP ${result.status}）` });
    } catch {
      setState({ serviceStatus: "offline", mode: "offline", stateData: null });
    }
  }
  async function refresh() {
    await checkHealth();
    await syncFromHost();
    if (state.binding && state.serviceStatus === "online") {
      await loadStateData();
    }
  }
  let asyncWork = [];
  function track(task) {
    asyncWork.push(task);
    return task;
  }
  async function flushAsyncWork() {
    while (asyncWork.length > 0) {
      const batch = asyncWork;
      asyncWork = [];
      await Promise.allSettled(batch);
    }
  }
  function handleEventSync(event, payload) {
    if (disposed) return;
    if (event === "APP_READY" || event === "CHAT_CHANGED") {
      healthCheckedAt = -Infinity;
      generationGate = false;
      swipeIdForNextCommit = null;
      clearTimers();
      rolledBackFloors.clear();
      setState({ rearmTurn: null });
      setState({
        binding: null,
        stateData: null,
        mode: "unbound",
        modeHint: null,
        pendingTurn: null,
        retryableCommit: null,
        lastError: null
      });
      restoreReceiptsForChat(host.getChatId());
      void track(refresh());
      return;
    }
    const adapted = deps.adaptEvent?.(event, payload) ?? null;
    if (!adapted) return;
    if (adapted.kind === "message-sent") {
      if (generationGate) return;
      setState({ rearmTurn: null });
      const task = onMessageSent(adapted.messageId, adapted.userText);
      lastPrepareTask = task;
      void track(task);
    } else if (adapted.kind === "generation-started") {
      generationGate = adapted.gated;
    } else if (adapted.kind === "generation-ended") {
      if (generationGate) {
        generationGate = false;
        return;
      }
      scheduleGenerationEnded(adapted);
    } else if (adapted.kind === "generation-stopped") {
      generationGate = false;
      onGenerationStopped();
    } else {
      scheduleMutation(adapted);
    }
  }
  function clearTimers() {
    if (endedTimer) {
      clearTimeout(endedTimer);
      endedTimer = null;
    }
    if (mutationTimer) {
      clearTimeout(mutationTimer);
      mutationTimer = null;
    }
    lastEndedEvent = null;
    mutationQueue = [];
  }
  function scheduleGenerationEnded(adapted) {
    lastEndedEvent = { assistantMessageId: adapted.assistantMessageId, assistantText: adapted.assistantText };
    if (endedTimer) clearTimeout(endedTimer);
    endedTimer = setTimeout(() => {
      endedTimer = null;
      void track(consumeGenerationEnded());
    }, Math.max(0, deps.endedDebounceMs ?? 350));
  }
  async function consumeGenerationEnded() {
    const fromHost = deps.resolveAssistantFloor?.() ?? null;
    const resolved = fromHost && fromHost.assistantMessageId && fromHost.assistantText.trim() ? fromHost : lastEndedEvent;
    lastEndedEvent = null;
    if (!resolved || !resolved.assistantMessageId) return;
    await onGenerationEnded(resolved.assistantMessageId, String(resolved.assistantText ?? ""));
  }
  function scheduleMutation(adapted) {
    mutationQueue.push(adapted);
    if (mutationTimer) clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      mutationTimer = null;
      const queue = mutationQueue;
      mutationQueue = [];
      void track(processMutations(queue));
    }, Math.max(0, deps.mutationDebounceMs ?? 400));
  }
  async function waitPendingTurn(timeoutMs = 1e4) {
    const task = lastPrepareTask;
    if (!task) return;
    try {
      await Promise.race([
        task.catch(() => {
        }),
        new Promise((resolve) => setTimeout(resolve, Math.max(0, timeoutMs)))
      ]);
    } catch {
    }
  }
  async function onMessageSent(messageId, userText) {
    if (disposed || !messageId) return;
    const chatId = state.chatId;
    if (!chatId || state.serviceStatus !== "online") return;
    if (state.pendingTurn) return;
    let binding = state.binding;
    if (!binding && deps.ensureWorld) {
      setState({ worldInitialization: "initializing", worldInitializationError: null });
      let ensured = false;
      try {
        ensured = await deps.ensureWorld();
      } catch {
        ensured = false;
      }
      if (disposed) return;
      binding = state.binding;
      if (!ensured || !binding) {
        setState({
          worldInitialization: "failed",
          worldInitializationError: "世界初始化未完成——可在「概览」重试，本条消息未推演。"
        });
        return;
      }
      setState({ worldInitialization: "ready", worldInitializationError: null });
    }
    if (!binding?.enabled) return;
    const request = {
      chatId,
      messageId: messageId.slice(0, ATLAS_LIMITS.ID_CHARS),
      worldId: binding.worldId,
      branchId: binding.branchId,
      userText: String(userText ?? "").slice(0, ATLAS_LIMITS.USER_TEXT_CHARS),
      recentMessageRefs: []
    };
    const parsed = parseAtlasTurnPrepareRequest(request);
    if (!parsed.ok) return;
    try {
      const result = await api.request("POST", "/turns/prepare", parsed.value);
      const body = result.body;
      if (result.status === 200 && body.ok && body.data?.response) {
        const parsedResponse = parseAtlasTurnPrepareResponse(body.data.response);
        if (!parsedResponse.ok) {
          setState({ lastError: "prepare 响应形状异常，本轮不注入。" });
          return;
        }
        const response = parsedResponse.value;
        setState({
          pendingTurn: {
            turnId: response.turnId,
            chatId: parsed.value.chatId,
            messageId: parsed.value.messageId,
            userText: parsed.value.userText,
            injectionText: response.injectionText,
            sourceRefs: response.sourceRefs,
            relevantNpcIds: response.relevantNpcIds,
            triggerIds: response.triggerIds
          },
          lastError: null
        });
        return;
      }
      setState({ lastError: body.error?.message ?? `本轮未注入阿特拉斯上下文（HTTP ${result.status}）` });
    } catch {
      setState({ lastError: "本轮未注入阿特拉斯上下文：服务不可用。" });
    }
  }
  async function safeCommitContext(hook, assistantText) {
    try {
      const raw = await hook(assistantText);
      if (!raw || typeof raw !== "object") return null;
      const texts = Array.isArray(raw.recentAssistantTexts) ? raw.recentAssistantTexts.filter((item) => typeof item === "string" && item.trim().length > 0).filter((item) => item !== assistantText).slice(-10) : [];
      return {
        ...texts.length > 0 ? { recentAssistantTexts: texts } : {},
        ...typeof raw.personaDescription === "string" && raw.personaDescription.trim() ? { personaDescription: raw.personaDescription } : {},
        ...typeof raw.charDescription === "string" && raw.charDescription.trim() ? { charDescription: raw.charDescription } : {}
      };
    } catch {
      return null;
    }
  }
  async function onGenerationEnded(assistantMessageId, assistantText) {
    if (disposed) return;
    let pending = state.pendingTurn;
    if (!pending && state.rearmTurn) {
      const rearm = state.rearmTurn;
      await onMessageSent(rearm.userMessageId, rearm.userText);
      pending = state.pendingTurn;
      if (pending) {
        swipeIdForNextCommit = rearm.swipeId;
      } else {
        setState({ rearmTurn: null });
        return;
      }
    }
    if (!pending) return;
    if (commitInFlight) return;
    if (!assistantMessageId || !assistantText || assistantText.trim().length === 0) {
      setState({ pendingTurn: null });
      return;
    }
    const commitSwipeId = swipeIdForNextCommit;
    swipeIdForNextCommit = null;
    let loreSupplement;
    if (deps.getLoreSupplement) {
      try {
        const text = await deps.getLoreSupplement();
        if (disposed) return;
        if (typeof text === "string" && text.trim().length > 0) loreSupplement = text;
      } catch {
        loreSupplement = void 0;
      }
    }
    const commitContext = deps.getCommitContext ? await safeCommitContext(deps.getCommitContext, assistantText) : null;
    const request = {
      turnId: pending.turnId,
      chatId: pending.chatId,
      userMessageId: pending.messageId,
      assistantMessageId: assistantMessageId.slice(0, ATLAS_LIMITS.ID_CHARS),
      swipeId: commitSwipeId,
      userText: pending.userText,
      assistantText: assistantText.slice(0, ATLAS_LIMITS.ASSISTANT_TEXT_CHARS),
      ...loreSupplement ? { loreSupplement } : {},
      ...commitContext?.recentAssistantTexts?.length ? { recentAssistantTexts: commitContext.recentAssistantTexts } : {},
      ...commitContext?.personaDescription ? { personaDescription: commitContext.personaDescription } : {},
      ...commitContext?.charDescription ? { charDescription: commitContext.charDescription } : {}
    };
    const parsed = parseAtlasTurnCommitRequest(request);
    if (!parsed.ok) {
      setState({ pendingTurn: null, rearmTurn: null });
      return;
    }
    await executeCommitRequest(parsed.value, commitSwipeId);
  }
  async function executeCommitRequest(value, swipeId) {
    commitInFlight = true;
    try {
      const result = await api.request("POST", "/turns/commit", value);
      const body = result.body;
      const receiptParsed = body.data?.receipt ? parseAtlasTurnReceipt(body.data.receipt) : null;
      const stale = state.chatId !== value.chatId;
      if (result.status === 200 && body.ok && receiptParsed?.ok) {
        addReceipt(receiptParsed.value, value.chatId);
        setState({ pendingTurn: null, rearmTurn: null, ...stale ? {} : { lastError: null } });
        if (receiptParsed.value.status === "committed" || receiptParsed.value.status === "duplicate") {
          healthCheckedAt = -Infinity;
          if (!stale) await refresh();
        }
        await syncLorebookAfterCommit(body);
        return;
      }
      setState({
        pendingTurn: null,
        rearmTurn: null,
        ...stale ? {} : {
          retryableCommit: {
            chatId: value.chatId,
            userMessageId: value.userMessageId,
            assistantMessageId: value.assistantMessageId,
            swipeId
          },
          lastError: body.error?.message ?? `世界推演失败（HTTP ${result.status}），可从「变化」页重试。`
        }
      });
    } catch {
      const stale = state.chatId !== value.chatId;
      setState({
        pendingTurn: null,
        rearmTurn: null,
        ...stale ? {} : {
          retryableCommit: {
            chatId: value.chatId,
            userMessageId: value.userMessageId,
            assistantMessageId: value.assistantMessageId,
            swipeId
          },
          lastError: "世界推演失败：服务不可用，可从「变化」页重试。"
        }
      });
    } finally {
      commitInFlight = false;
    }
  }
  async function manualAdvance() {
    if (disposed || commitInFlight) return;
    const chatId = state.chatId;
    const binding = state.binding;
    if (!chatId || state.serviceStatus !== "online") {
      setState({ lastError: "引擎未就绪，无法立即推演。" });
      return;
    }
    if (!binding?.enabled) {
      setState({ lastError: "本聊天推演未启用——先在「推进」页启用再立即推演。" });
      return;
    }
    if (state.pendingTurn) {
      setState({ lastError: "有回合正在推演，稍后再试。" });
      return;
    }
    let loreSupplement;
    if (deps.getLoreSupplement) {
      try {
        const text = await deps.getLoreSupplement();
        if (disposed) return;
        if (typeof text === "string" && text.trim().length > 0) loreSupplement = text;
      } catch {
        loreSupplement = void 0;
      }
    }
    const ts = now();
    let lastAssistant = "";
    try {
      const text = await deps.getLastAssistantText?.();
      if (disposed) return;
      if (typeof text === "string") lastAssistant = text;
    } catch {
      lastAssistant = "";
    }
    const manualAssistantText = (lastAssistant.trim().length > 0 ? lastAssistant : "（无新剧情，仅时间与日程流动。）").slice(0, ATLAS_LIMITS.ASSISTANT_TEXT_CHARS);
    const commitContext = deps.getCommitContext ? await safeCommitContext(deps.getCommitContext, manualAssistantText) : null;
    const request = {
      turnId: `turn-manual-${ts}`,
      chatId,
      userMessageId: `manual-u-${ts}`,
      assistantMessageId: `manual-a-${ts}`,
      swipeId: null,
      userText: "（手动推进：不新增剧情，仅让世界按日程与惯性流动。）",
      assistantText: manualAssistantText,
      ...loreSupplement ? { loreSupplement } : {},
      ...commitContext?.recentAssistantTexts?.length ? { recentAssistantTexts: commitContext.recentAssistantTexts } : {},
      ...commitContext?.personaDescription ? { personaDescription: commitContext.personaDescription } : {},
      ...commitContext?.charDescription ? { charDescription: commitContext.charDescription } : {}
    };
    const parsed = parseAtlasTurnCommitRequest(request);
    if (!parsed.ok) {
      setState({ lastError: "立即推演请求组装失败（契约校验未过）。" });
      return;
    }
    await executeCommitRequest(parsed.value, null);
  }
  function onGenerationStopped() {
    if (disposed) return;
    if (state.pendingTurn) setState({ pendingTurn: null });
  }
  async function processMutations(queue) {
    for (const event of queue) {
      if (disposed) return;
      const binding = state.binding;
      if (!binding?.enabled || !state.chatId || state.serviceStatus !== "online") return;
      if (binding.lastCommittedMessageId !== event.messageId) continue;
      if (rolledBackFloors.has(`${state.chatId}:${event.messageId}`)) continue;
      if (event.kind === "message-swiped") {
        if (event.regenerating === false) continue;
        if (event.regenerating === null) continue;
        const rolledBack = await rollbackLastTurn(event.messageId);
        if (rolledBack) {
          rolledBackFloors.add(`${state.chatId}:${event.messageId}`);
          if (event.userMessageId && event.userText) {
            setState({
              rearmTurn: { userMessageId: event.userMessageId, userText: event.userText, swipeId: `swipe-${now()}` },
              worldNotice: "已回退到本回合之前；新变体生成完成后将重新推演为同级结果。"
            });
          }
        }
      } else {
        const rolledBack = await rollbackLastTurn(event.messageId);
        if (rolledBack) {
          rolledBackFloors.add(`${state.chatId}:${event.messageId}`);
          setState({
            worldNotice: event.kind === "message-edited" ? "该回复已编辑：世界已回退到本回合之前；如需按新文本重新推演，请重新生成（swipe）该回复。" : "该回复已删除：世界已回退到本回合之前（推演历史保留在检查点里，可追溯）。"
          });
        }
      }
    }
  }
  async function rollbackLastTurn(assistantMessageId) {
    const chatId = state.chatId;
    if (!chatId) return false;
    try {
      const result = await api.request("POST", "/turns/rollback", { chatId, assistantMessageId });
      if (result.status === 200) {
        healthCheckedAt = -Infinity;
        await refresh();
        return true;
      }
      const body = result.body;
      setState({ lastError: body.error?.message ?? `世界回退被拒绝（HTTP ${result.status}）。` });
      return false;
    } catch {
      setState({ lastError: "世界回退失败：服务不可用。" });
      return false;
    }
  }
  async function retryLastCommit() {
    if (disposed) return;
    const failed = state.retryableCommit;
    if (!failed) return;
    if (failed.chatId !== state.chatId) {
      setState({ retryableCommit: null });
      return;
    }
    try {
      const result = await api.request("POST", "/turns/retry", failed);
      const body = result.body;
      const receiptParsed = body.data?.receipt ? parseAtlasTurnReceipt(body.data.receipt) : null;
      if (result.status === 200 && body.ok && receiptParsed?.ok) {
        addReceipt(receiptParsed.value, failed.chatId);
        setState({ retryableCommit: null, lastError: null });
        if (receiptParsed.value.status === "committed" || receiptParsed.value.status === "duplicate") {
          healthCheckedAt = -Infinity;
          await refresh();
        }
        await syncLorebookAfterCommit(body);
        return;
      }
      if (state.chatId === failed.chatId) {
        setState({ lastError: body.error?.message ?? `重试失败（HTTP ${result.status}）` });
      }
    } catch {
      if (state.chatId === failed.chatId) {
        setState({ lastError: "重试失败：服务不可用。" });
      }
    }
  }
  return {
    init() {
      if (initialized || disposed) return;
      initialized = true;
      for (const event of ATLAS_UI_EVENTS) {
        register(event, (payload) => handleEventSync(event, payload));
      }
      setState({ panelOpen: host.readPanelOpen() });
      restoreReceiptsForChat(host.getChatId());
      void refresh();
    },
    dispose() {
      disposed = true;
      clearTimers();
      for (const { event, handler } of listeners) {
        emitter.off(event, handler);
      }
      listeners.length = 0;
      initialized = false;
    },
    async handleEvent(event, payload) {
      if (disposed) return;
      handleEventSync(event, payload);
      await flushAsyncWork();
    },
    async refresh() {
      if (disposed) return;
      await refresh();
    },
    getState() {
      return { ...state, binding: state.binding ? { ...state.binding } : null };
    },
    setPanelOpen(open) {
      setState({ panelOpen: open });
      host.writePanelOpen(open);
    },
    /** 0.9.22 立即推演：不发言也让世界流动（推进页按钮）。 */
    manualAdvance,
    /** ATLAS-18：概览页「重试初始化」按钮用（未注入 ensureWorld 时安全无操作）。 */
    async initializeWorld() {
      if (disposed) return false;
      if (state.binding) {
        setState({ worldInitialization: "ready", worldInitializationError: null });
        return true;
      }
      if (!deps.ensureWorld) return false;
      setState({ worldInitialization: "initializing", worldInitializationError: null });
      try {
        const ensured = await deps.ensureWorld();
        if (disposed) return false;
        setState(ensured && state.binding ? { worldInitialization: "ready", worldInitializationError: null } : { worldInitialization: "failed", worldInitializationError: "世界初始化未完成，可重试。" });
        return Boolean(ensured && state.binding);
      } catch {
        if (!disposed) setState({ worldInitialization: "failed", worldInitializationError: "世界初始化失败，可重试。" });
        return false;
      }
    },
    setPage(page) {
      setState({ page });
    },
    async bindToWorld(worldId) {
      const chatId = host.getChatId();
      if (!chatId) {
        setState({ lastError: "当前没有可绑定的聊天。" });
        return;
      }
      const binding = {
        schemaVersion: 1,
        enabled: true,
        chatId,
        characterId: null,
        worldId,
        branchId: null,
        currentLocationId: null,
        worldTimeCursor: 0,
        lastCommittedMessageId: null,
        lastCheckpointId: null
      };
      const result = await api.request("POST", "/bindings", { action: "bind", binding });
      const body = result.body;
      if (result.status !== 200 || !body.ok) {
        setState({ lastError: body.error?.message ?? `绑定失败（HTTP ${result.status}）` });
        return;
      }
      await host.writeBinding(binding);
      healthCheckedAt = -Infinity;
      await refresh();
    },
    async unbind() {
      const chatId = host.getChatId();
      if (!chatId) return;
      const result = await api.request("POST", "/bindings", { action: "unbind", chatId });
      const body = result.body;
      if (result.status !== 200 || !body.ok) {
        setState({ lastError: body.error?.message ?? `解绑失败（HTTP ${result.status}）` });
        return;
      }
      await host.clearBinding();
      await refresh();
    },
    async setEnabled(enabled) {
      const binding = state.binding;
      if (!binding) return;
      const next = { ...binding, enabled };
      const result = await api.request("POST", "/bindings", { action: "bind", binding: next });
      const body = result.body;
      if (result.status !== 200 || !body.ok) {
        setState({ lastError: body.error?.message ?? `更新启用状态失败（HTTP ${result.status}）` });
        return;
      }
      await host.writeBinding(next);
      await refresh();
    },
    /** 设置页世界列表（绑定用）；失败返回空数组并记录错误。 */
    async requestWorlds() {
      try {
        const result = await api.request("GET", "/worlds");
        const body = result.body;
        if (result.status === 200 && body.ok && body.data?.worlds) return body.data.worlds;
        setState({ lastError: `世界列表读取失败（HTTP ${result.status}）` });
        return [];
      } catch {
        setState({ lastError: "世界列表读取失败：服务不可用。" });
        return [];
      }
    },
    /** 地图点击目的地：只读旅行预览（不推进时间、不改状态）。 */
    async selectDestination(pointId) {
      const binding = state.binding;
      const chatId = state.chatId;
      if (!binding || !binding.enabled || !chatId) return;
      const points = state.stateData?.map?.points ?? [];
      const point = points.find((p) => String(p.id) === String(pointId));
      try {
        const result = await api.request("POST", "/map/travel-preview", {
          chatId,
          destinationPointId: String(pointId).slice(0, ATLAS_LIMITS.ID_CHARS)
        });
        const body = result.body;
        if (result.status === 200 && body.ok) {
          const preview = body.data?.preview ?? null;
          if (preview) {
            setState({
              destinationPreview: {
                destinationId: preview.destinationId,
                destinationName: typeof point?.name === "string" ? point.name : preview.destinationId,
                distance: preview.distance,
                estimatedDuration: preview.estimatedDuration,
                factors: Array.isArray(preview.factors) ? preview.factors.map(String) : []
              },
              lastError: null
            });
          } else {
            setState({ lastError: "无法预览该目的地（未知起点或终点）。" });
          }
          return;
        }
        setState({ lastError: body.error?.message ?? `旅行预览失败（HTTP ${result.status}）` });
      } catch {
        setState({ lastError: "旅行预览失败：服务不可用。" });
      }
    },
    /** 确认出发：只把建议行动填入酒馆输入框，绝不自动发送。 */
    confirmTravel() {
      const preview = state.destinationPreview;
      if (!preview) return;
      host.fillInput(`前往 ${preview.destinationName}。`);
      setState({ destinationPreview: null });
    },
    cancelTravel() {
      setState({ destinationPreview: null });
    },
    /** MESSAGE_SENT：建 pending turn 并调用 prepare（失败不阻断酒馆生成，只提示）。 */
    onMessageSent,
    /** 最终回复完成：commit（至多 1 次请求；重复通知 / 空回复 / 停止不推进世界）。 */
    onGenerationEnded,
    /** 停止 / 生成失败：放弃 pending，不推进世界。 */
    onGenerationStopped,
    /** 重试失败的 commit（沿用原幂等键；服务端 retry 端点）。 */
    retryLastCommit,
    /** 等待最近一次 prepare 落定（有界；生成拦截器注入前必调）。 */
    waitPendingTurn
  };
}

// lib/world-schema.ts
var SCHEMA_VERSION = 1;
var WORLD_BIBLE_MAX_ENTRIES = 80;
var WORLD_BIBLE_MAX_KEYS = 24;
var WORLD_BIBLE_KEY_MAX_LENGTH = 80;
var WORLD_BIBLE_ACTIVATION_MODES = ["always", "keywords"];
var ENTITY_FIELD_KINDS = ["base", "temporal", "computed", "private"];
var ENTITY_FIELD_VALUE_TYPES = ["string", "number", "boolean", "string[]"];
var STATE_EVENT_SOURCES = ["author", "action", "ai-adopted"];
var STATE_EFFECT_KINDS = [
  "setTemporalField",
  "moveEntity",
  "adjustRelation",
  "addTag",
  "removeTag",
  "appendMemoryRef",
  "attachNarrativeEntry",
  "closeNarrativeEntry",
  "setFlag"
];
var W0_LIMITS = {
  maxCharacterStates: 500,
  maxCharacterMemories: 1e3,
  maxMemoryContent: 2e3,
  maxTriggers: 200,
  maxTriggerTitle: 120,
  maxTriggerSummary: 500,
  maxOutcomeTemplate: 2e3,
  maxOutcomeTags: 20,
  maxTagLength: 60,
  maxStoryRuntimes: 50,
  maxCompanions: 24,
  maxWorldFlags: 100,
  maxFlagLength: 80,
  maxActions: 500,
  maxOutcomes: 500,
  maxViaPoints: 24,
  maxCandidateSources: 60,
  maxSourceLabel: 120,
  maxStatusLength: 500,
  maxAgentSessions: 50,
  maxSessionSummary: 4e3,
  maxOpenThreads: 50,
  maxThreadLength: 500,
  maxChangeRefs: 50,
  maxReasonLength: 1e3,
  // --- N4：创作反馈（可编辑行动摘要） ---
  maxActionSummary: 400,
  // --- R5-01：世界定义版本与实体目录 ---
  maxDefinitionRevisions: 200,
  maxEntityRecords: 500,
  maxEntityTemporalFields: 50,
  maxEntityBaselineFields: 50,
  maxEntityFieldKey: 60,
  maxEntityTypeName: 40,
  maxRevisionNote: 500,
  // --- R5-02：状态事件账本 ---
  maxStateEvents: 5e3,
  // --- R5-04：检查点与游玩头 ---
  maxCheckpoints: 200,
  maxCheckpointName: 120,
  maxCheckpointReason: 200,
  maxStateEventEffects: 20,
  maxStateEventSummary: 500,
  maxStateEntityRefs: 40,
  maxNarrativeEntry: 2e3,
  // --- R4-04：酒馆式扮演会话 ---
  maxRoleplaySessions: 24,
  maxRoleplayMessages: 120,
  maxRoleplayMessageChars: 8e3,
  maxRoleplayChoices: 12,
  maxRoleplayChanges: 24,
  maxRoleplayChangeLabel: 120,
  maxRoleplayChangeDetail: 600,
  maxRoleplayContextTitles: 60
};
var DURATION_SOURCES = ["baseline", "worldAgent", "manual"];
var CARD_TYPES = ["event", "point", "character", "story"];
var CARD_PARTICIPATIONS = ["passive", "focusable"];
var CARD_SESSION_STATUSES = ["idle", "active", "paused", "archived"];
var ENTRY_POLICIES = ["read-canon", "branch-if", "import-moment", "direct-play"];
var NARRATIVE_PRESENTATION_MODES = ["firstPerson", "reader"];
var W0_CARD_LIMITS = {
  maxProfiles: 300,
  maxSessions: 600,
  maxAnchors: 300,
  maxSourceRefs: 60,
  maxRoleConstraints: 2e3,
  maxSummary: 2e3,
  maxContextSummary: 4e3,
  maxCheckpointSummary: 2e3,
  maxCheckpointFlags: 100,
  maxManualEditedFields: 40,
  maxActiveCardSessions: 24,
  maxKnowledgeScope: 2e3,
  maxTerrainFactors: 200,
  maxDistanceUnit: 24
};
var DEFAULT_TRAVEL_BASELINE_VERSION = "dtb-1";
var DEFAULT_TRAVEL_BASELINE = {
  version: DEFAULT_TRAVEL_BASELINE_VERSION,
  distanceFormula: "网格距离 = round(√((x2-x1)² + (y2-y1)²))，按地图 0-100 网格坐标计算；地图已标定每格距离时，再乘以每格距离换算为实际距离。",
  speedTiers: [
    { id: "slow", label: "缓行（负重 / 侦查）", cellsPerPeriod: 4 },
    { id: "normal", label: "常速（默认）", cellsPerPeriod: 8 },
    { id: "fast", label: "疾行（轻装 / 赶路）", cellsPerPeriod: 14 }
  ],
  terrainTiers: [
    { id: "road", label: "大道 / 平原", factor: 1 },
    { id: "rough", label: "丘陵 / 林地", factor: 1.4 },
    { id: "mountain", label: "山地 / 沼泽", factor: 2 }
  ],
  abstractRule: "地图未标定时不换算真实里数，只用「格程」与「时段」表达：先给网格距离，再按速度档得出需要多少个时段；作者确认后才写入 duration，绝不生成伪精确数字。",
  outputConstraint: '只输出 JSON：{ "duration": <数字>, "basis": "<一句话依据：网格距离 / 速度档 / 地形档 / 是否已标定>" }。不要输出正文，不要编造地图比例，不要修改世界状态。'
};
var WORLD_AGENT_STATUSES = ["ready", "optimizing", "active", "stale"];
function parseMapPoint(raw) {
  if (!isObject(raw)) return null;
  if (!isNumber(raw.id)) return null;
  if (!isString(raw.name)) return null;
  if (!isNumber(raw.x) || !isNumber(raw.y)) return null;
  if (raw.regionId !== void 0 && raw.regionId !== null && !isString(raw.regionId)) return null;
  if (raw.worldBook !== void 0) {
    if (!Array.isArray(raw.worldBook) || raw.worldBook.length > WORLD_BIBLE_MAX_ENTRIES) return null;
    for (const entry of raw.worldBook) {
      if (parseWorldBibleEntry(entry) === null) return null;
    }
  }
  return {
    id: raw.id,
    name: raw.name,
    x: raw.x,
    y: raw.y,
    ...raw.regionId !== void 0 ? { regionId: raw.regionId } : {},
    ...Array.isArray(raw.worldBook) ? { worldBook: raw.worldBook.map((entry) => parseWorldBibleEntry(entry)).filter((entry) => entry !== null) } : {}
  };
}
function parseWorldBibleEntry(raw) {
  if (!isObject(raw)) return null;
  if (!isString(raw.id) || raw.id.length === 0) return null;
  if (!isString(raw.category) || raw.category.length === 0) return null;
  if (!isString(raw.title) || !isString(raw.content)) return null;
  if (raw.tags !== void 0 && (!Array.isArray(raw.tags) || !raw.tags.every(isString))) return null;
  if (raw.enabled !== void 0 && typeof raw.enabled !== "boolean") return null;
  if (raw.activationMode !== void 0 && !WORLD_BIBLE_ACTIVATION_MODES.includes(raw.activationMode)) return null;
  if (raw.keys !== void 0 && (!Array.isArray(raw.keys) || raw.keys.length > WORLD_BIBLE_MAX_KEYS || !raw.keys.every((key) => isString(key) && key.trim().length > 0 && key.length <= WORLD_BIBLE_KEY_MAX_LENGTH))) return null;
  if (raw.updatedAt !== void 0 && !isNumber(raw.updatedAt)) return null;
  return {
    id: raw.id,
    category: raw.category,
    title: raw.title,
    content: raw.content,
    ...Array.isArray(raw.tags) ? { tags: raw.tags } : {},
    ...typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {},
    ...raw.activationMode === "always" || raw.activationMode === "keywords" ? { activationMode: raw.activationMode } : {},
    ...Array.isArray(raw.keys) ? { keys: raw.keys } : {},
    ...isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}
  };
}
function parseRegion(raw) {
  if (!isObject(raw)) return null;
  if (!isString(raw.id) || raw.id.length === 0) return null;
  if (!isString(raw.worldId) || raw.worldId.length === 0) return null;
  if (!isString(raw.name)) return null;
  const validTypes = ["city", "forest", "mountain", "sea", "plain", "other"];
  if (!isString(raw.type) || !validTypes.includes(raw.type)) return null;
  if (!isString(raw.description)) return null;
  if (!isObject(raw.coordinates)) return null;
  if (!isNumber(raw.coordinates.x) || !isNumber(raw.coordinates.y)) return null;
  if (raw.subtitle !== void 0 && !isString(raw.subtitle)) return null;
  if (raw.tone !== void 0 && !isString(raw.tone)) return null;
  const safeSceneImage = isString(raw.sceneImage) && /^(https?:\/\/|data:image\/|\/|\.\/|\.\.\/)/i.test(raw.sceneImage) ? raw.sceneImage : null;
  if (raw.worldBook !== void 0) {
    if (!Array.isArray(raw.worldBook) || raw.worldBook.length > WORLD_BIBLE_MAX_ENTRIES) return null;
    for (const entry of raw.worldBook) {
      if (parseWorldBibleEntry(entry) === null) return null;
    }
  }
  return {
    id: raw.id,
    worldId: raw.worldId,
    name: raw.name,
    type: raw.type,
    description: raw.description,
    coordinates: { x: raw.coordinates.x, y: raw.coordinates.y },
    ...isString(raw.subtitle) ? { subtitle: raw.subtitle } : {},
    ...isString(raw.tone) ? { tone: raw.tone } : {},
    ...safeSceneImage ? { sceneImage: safeSceneImage } : {},
    ...Array.isArray(raw.worldBook) ? { worldBook: raw.worldBook.map((entry) => parseWorldBibleEntry(entry)).filter((entry) => entry !== null) } : {}
  };
}
function parseStory(raw) {
  if (!isObject(raw)) return null;
  if (!isString(raw.id) || raw.id.length === 0) return null;
  if (!isString(raw.worldId) || raw.worldId.length === 0) return null;
  if (raw.mode !== "canon" && raw.mode !== "if") return null;
  if (!isString(raw.title)) return null;
  if (!Array.isArray(raw.steps)) return null;
  const steps = [];
  for (const step of raw.steps) {
    if (!isObject(step)) return null;
    if (!isString(step.eventId) || step.eventId.length === 0) return null;
    if (step.choice !== null && !isString(step.choice)) return null;
    if (step.note !== void 0 && !isString(step.note)) return null;
    steps.push({
      eventId: step.eventId,
      choice: step.choice,
      ...typeof step.note === "string" ? { note: step.note } : {}
    });
  }
  if (raw.parentStoryId !== void 0 && raw.parentStoryId !== null && !isString(raw.parentStoryId)) return null;
  if (raw.divergenceEventId !== void 0 && raw.divergenceEventId !== null && !isString(raw.divergenceEventId)) return null;
  if (raw.createdAt !== void 0 && !isNumber(raw.createdAt)) return null;
  if (raw.updatedAt !== void 0 && !isNumber(raw.updatedAt)) return null;
  let chapters;
  if (raw.chapters !== void 0) {
    if (!Array.isArray(raw.chapters)) return null;
    chapters = [];
    for (const ch of raw.chapters) {
      if (!isObject(ch)) return null;
      if (!isString(ch.id) || ch.id.length === 0) return null;
      if (!isString(ch.title)) return null;
      if (!isNumber(ch.fromStep)) return null;
      chapters.push({ id: ch.id, title: ch.title, fromStep: ch.fromStep });
    }
  }
  let ifOrigin;
  if (raw.ifOrigin !== void 0 && raw.ifOrigin !== null) {
    ifOrigin = parseIFOrigin(raw.ifOrigin);
    if (ifOrigin === null) return null;
  } else if (raw.ifOrigin === null) {
    ifOrigin = null;
  }
  return {
    id: raw.id,
    worldId: raw.worldId,
    mode: raw.mode,
    title: raw.title,
    steps,
    ...chapters ? { chapters } : {},
    ...raw.parentStoryId !== void 0 ? { parentStoryId: raw.parentStoryId } : {},
    ...raw.divergenceEventId !== void 0 ? { divergenceEventId: raw.divergenceEventId } : {},
    ...isNumber(raw.createdAt) ? { createdAt: raw.createdAt } : {},
    ...isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {},
    ...ifOrigin !== void 0 ? { ifOrigin } : {}
  };
}
function parseIFOrigin(raw) {
  if (!isObject(raw)) return null;
  if (!isString(raw.rootStoryId) || raw.rootStoryId.length === 0) return null;
  if (!isString(raw.sourceStoryId) || raw.sourceStoryId.length === 0) return null;
  const anchorEventId = raw.anchorEventId === null || raw.anchorEventId === void 0 ? null : isString(raw.anchorEventId) ? raw.anchorEventId : null;
  if (raw.anchorEventId !== null && raw.anchorEventId !== void 0 && !isString(raw.anchorEventId)) return null;
  const anchorStep = raw.anchorStep === null || raw.anchorStep === void 0 ? null : isNumber(raw.anchorStep) && raw.anchorStep >= 0 ? raw.anchorStep : null;
  if (raw.anchorStep !== null && raw.anchorStep !== void 0 && (!isNumber(raw.anchorStep) || raw.anchorStep < 0)) return null;
  if (!isNumber(raw.anchorAt)) return null;
  const viewpointCharacterId = raw.viewpointCharacterId === null || raw.viewpointCharacterId === void 0 ? null : isString(raw.viewpointCharacterId) ? raw.viewpointCharacterId : null;
  if (raw.viewpointCharacterId !== null && raw.viewpointCharacterId !== void 0 && !isString(raw.viewpointCharacterId)) return null;
  const variant = isNumber(raw.variant) && Number.isInteger(raw.variant) && raw.variant >= 1 ? raw.variant : 1;
  if (raw.variant !== void 0 && (!isNumber(raw.variant) || !Number.isInteger(raw.variant) || raw.variant < 1)) return null;
  if (raw.label !== void 0 && raw.label !== null && !isString(raw.label)) return null;
  if (raw.approx !== void 0 && typeof raw.approx !== "boolean") return null;
  return {
    rootStoryId: raw.rootStoryId,
    sourceStoryId: raw.sourceStoryId,
    anchorEventId,
    anchorStep,
    anchorAt: raw.anchorAt,
    viewpointCharacterId,
    variant,
    ...isString(raw.label) ? { label: raw.label } : {},
    ...typeof raw.approx === "boolean" ? { approx: raw.approx } : {}
  };
}
var ROLEPLAY_INPUT_MODES = ["narrative", "dialogue", "ooc"];
var ROLEPLAY_ENTRY_MODES = ["reader", "firstPerson", "npc"];
var ROLEPLAY_CHANGE_KINDS = ["time", "location", "npc", "memory", "flag", "note"];
function parseRoleplaySession(raw) {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  const sessionKey = parseId(raw.sessionKey);
  if (!sessionKey) return null;
  const sourceStoryId = parseId(raw.sourceStoryId);
  if (!sourceStoryId) return null;
  const rootStoryId = parseId(raw.rootStoryId);
  if (!rootStoryId) return null;
  const targetStoryId = parseOptionalId(raw.targetStoryId);
  if (targetStoryId === false) return null;
  const anchorEventId = parseOptionalId(raw.anchorEventId);
  if (anchorEventId === false) return null;
  let anchorStep = null;
  if (raw.anchorStep !== null && raw.anchorStep !== void 0) {
    if (!isNumber(raw.anchorStep) || raw.anchorStep < 0) return null;
    anchorStep = raw.anchorStep;
  }
  if (!isNumber(raw.anchorAt)) return null;
  const viewpointCharacterId = parseOptionalId(raw.viewpointCharacterId);
  if (viewpointCharacterId === false) return null;
  const entryMode = ROLEPLAY_ENTRY_MODES.includes(raw.entryMode) ? raw.entryMode : "reader";
  if (raw.entryMode !== void 0 && !ROLEPLAY_ENTRY_MODES.includes(raw.entryMode)) return null;
  const inputMode = ROLEPLAY_INPUT_MODES.includes(raw.inputMode) ? raw.inputMode : "narrative";
  if (raw.inputMode !== void 0 && !ROLEPLAY_INPUT_MODES.includes(raw.inputMode)) return null;
  const messages = parseBoundedArray(raw.messages ?? [], W0_LIMITS.maxRoleplayMessages, parseRoleplayMessage);
  if (messages === null) return null;
  let contextSummary = null;
  if (raw.contextSummary !== void 0 && raw.contextSummary !== null) {
    contextSummary = parseRoleplayContextSummary(raw.contextSummary);
    if (contextSummary === null) return null;
  }
  if (!isNumber(raw.createdAt) || !isNumber(raw.updatedAt)) return null;
  return {
    id,
    sessionKey,
    sourceStoryId,
    rootStoryId,
    targetStoryId: targetStoryId ?? null,
    anchorEventId: anchorEventId ?? null,
    anchorStep,
    anchorAt: raw.anchorAt,
    viewpointCharacterId: viewpointCharacterId ?? null,
    entryMode,
    inputMode,
    messages,
    contextSummary,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };
}
function parseRoleplayMessage(raw) {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  if (raw.role !== "user" && raw.role !== "assistant") return null;
  const inputMode = ROLEPLAY_INPUT_MODES.includes(raw.inputMode) ? raw.inputMode : "narrative";
  if (raw.inputMode !== void 0 && !ROLEPLAY_INPUT_MODES.includes(raw.inputMode)) return null;
  if (!isString(raw.text) || raw.text.length > W0_LIMITS.maxRoleplayMessageChars) return null;
  if (!isNumber(raw.at)) return null;
  let draft = null;
  if (raw.draft !== void 0 && raw.draft !== null) {
    draft = parseRoleplayDraft(raw.draft);
    if (draft === null) return null;
  }
  let appliedChangeIndexes;
  if (raw.appliedChangeIndexes !== void 0) {
    if (!Array.isArray(raw.appliedChangeIndexes)) return null;
    if (!raw.appliedChangeIndexes.every((n) => isNumber(n) && Number.isInteger(n) && n >= 0)) return null;
    appliedChangeIndexes = raw.appliedChangeIndexes;
  }
  const savedStoryId = parseOptionalId(raw.savedStoryId);
  if (savedStoryId === false) return null;
  let error = null;
  if (raw.error !== void 0 && raw.error !== null) {
    if (!isString(raw.error) || raw.error.length > W0_LIMITS.maxReasonLength) return null;
    error = raw.error;
  }
  if (raw.presetName !== void 0 && raw.presetName !== null && !isString(raw.presetName)) return null;
  if (raw.model !== void 0 && raw.model !== null && !isString(raw.model)) return null;
  return {
    id,
    role: raw.role,
    inputMode,
    text: raw.text,
    at: raw.at,
    ...draft !== null ? { draft } : {},
    ...appliedChangeIndexes ? { appliedChangeIndexes } : {},
    ...savedStoryId !== void 0 ? { savedStoryId } : {},
    ...error !== null ? { error } : {},
    ...isString(raw.presetName) ? { presetName: raw.presetName } : {},
    ...isString(raw.model) ? { model: raw.model } : {}
  };
}
function parseRoleplayDraft(raw) {
  if (!isObject(raw)) return null;
  if (!isString(raw.narrative)) return null;
  if (!isBoundedStringList(raw.choices ?? [], W0_LIMITS.maxRoleplayChoices, 400)) return null;
  let durationSuggestion = null;
  if (raw.durationSuggestion !== void 0 && raw.durationSuggestion !== null) {
    if (!isNumber(raw.durationSuggestion) || raw.durationSuggestion < 0) return null;
    durationSuggestion = raw.durationSuggestion;
  }
  const changes = parseBoundedArray(raw.changes ?? [], W0_LIMITS.maxRoleplayChanges, parseRoleplayChange);
  if (changes === null) return null;
  if (!isBoundedStringList(raw.sourceIds ?? [], 40, 120)) return null;
  return {
    narrative: raw.narrative,
    choices: raw.choices ?? [],
    durationSuggestion,
    changes,
    sourceIds: raw.sourceIds ?? [],
    raw: isString(raw.raw) ? raw.raw : raw.narrative
  };
}
function parseRoleplayChange(raw) {
  if (!isObject(raw)) return null;
  if (!ROLEPLAY_CHANGE_KINDS.includes(raw.kind)) return null;
  if (!isString(raw.label) || raw.label.length === 0 || raw.label.length > W0_LIMITS.maxRoleplayChangeLabel) return null;
  if (!isString(raw.detail) || raw.detail.length > W0_LIMITS.maxRoleplayChangeDetail) return null;
  let duration = null;
  if (raw.duration !== void 0 && raw.duration !== null) {
    if (!isNumber(raw.duration) || raw.duration < 0) return null;
    duration = raw.duration;
  }
  const pointId = parseOptionalId(raw.pointId);
  if (pointId === false) return null;
  const characterId = parseOptionalId(raw.characterId);
  if (characterId === false) return null;
  const flag = parseOptionalId(raw.flag);
  if (flag === false) return null;
  return {
    kind: raw.kind,
    label: raw.label,
    detail: raw.detail,
    ...duration !== null ? { duration } : {},
    ...pointId ? { pointId } : {},
    ...characterId ? { characterId } : {},
    ...flag ? { flag } : {}
  };
}
function parseRoleplayContextSummary(raw) {
  if (!isObject(raw)) return null;
  const lists = ["worldBookTitles", "pointNames", "characterNames", "memoryIds", "keptActionIds", "ownActionIds", "excluded"];
  for (const key of lists) {
    if (!isBoundedStringList(raw[key] ?? [], W0_LIMITS.maxRoleplayContextTitles, 300)) return null;
  }
  const regionName = raw.regionName === null || raw.regionName === void 0 ? null : isString(raw.regionName) ? raw.regionName : null;
  if (raw.regionName !== null && raw.regionName !== void 0 && !isString(raw.regionName)) return null;
  if (raw.approx !== void 0 && typeof raw.approx !== "boolean") return null;
  const pick = (key) => (raw[key] ?? []).slice();
  return {
    worldBookTitles: pick("worldBookTitles"),
    regionName,
    pointNames: pick("pointNames"),
    characterNames: pick("characterNames"),
    memoryIds: pick("memoryIds"),
    keptActionIds: pick("keptActionIds"),
    ownActionIds: pick("ownActionIds"),
    excluded: pick("excluded"),
    approx: raw.approx === true
  };
}
function parseReadingProgress(raw) {
  if (!isObject(raw)) return null;
  if (!isString(raw.storyId) || raw.storyId.length === 0) return null;
  if (!isNumber(raw.step) || raw.step < 0) return null;
  if (raw.chapter !== void 0 && raw.chapter !== null && (!isNumber(raw.chapter) || raw.chapter < 0)) return null;
  if (raw.presentationMode !== void 0 && raw.presentationMode !== "visual" && raw.presentationMode !== "reader") return null;
  if (raw.fontSize !== void 0 && (!isNumber(raw.fontSize) || raw.fontSize <= 0)) return null;
  return {
    storyId: raw.storyId,
    step: raw.step,
    ...raw.chapter !== void 0 ? { chapter: raw.chapter } : {},
    ...raw.presentationMode !== void 0 ? { presentationMode: raw.presentationMode } : {},
    ...isNumber(raw.fontSize) ? { fontSize: raw.fontSize } : {}
  };
}
function parseId(v) {
  return isString(v) && v.trim().length > 0 ? v : null;
}
function parseOptionalId(v) {
  if (v === void 0) return void 0;
  if (v === null) return null;
  return isString(v) && v.trim().length > 0 ? v : false;
}
function isBoundedStringList(v, max, itemMax = 0) {
  if (!Array.isArray(v) || v.length > max) return false;
  return v.every((x) => isString(x) && x.trim().length > 0 && (itemMax <= 0 || x.length <= itemMax));
}
function parseBoundedArray(raw, max, parse) {
  if (!Array.isArray(raw) || raw.length > max) return null;
  const out = [];
  for (const item of raw) {
    const p = parse(item);
    if (p === null) return null;
    out.push(p);
  }
  return out;
}
function parseOptionalArray(raw, max, parse) {
  if (raw === void 0) return void 0;
  return parseBoundedArray(raw, max, parse);
}
var WORLD_ACTION_KINDS = ["move", "wait", "interact", "choice"];
var WORLD_OUTCOME_KINDS = ["nothing", "trigger"];
var AGENT_CALL_STRATEGIES = ["manual", "ask-on-major", "ask-each-action"];
function parseCharacterState(raw) {
  if (!isObject(raw)) return null;
  const characterId = parseId(raw.characterId);
  if (!characterId) return null;
  const regionId = raw.currentRegionId === void 0 ? null : raw.currentRegionId;
  if (regionId !== null && !isString(regionId)) return null;
  const pointId = parseOptionalId(raw.currentPointId);
  if (pointId === false) return null;
  if (raw.status !== void 0 && (!isString(raw.status) || raw.status.length > W0_LIMITS.maxStatusLength)) return null;
  if (!isNumber(raw.updatedAt)) return null;
  const branchId = parseOptionalId(raw.branchId);
  if (branchId === false) return null;
  return {
    characterId,
    currentRegionId: regionId,
    ...pointId !== void 0 ? { currentPointId: pointId } : {},
    ...isString(raw.status) ? { status: raw.status } : {},
    updatedAt: raw.updatedAt,
    ...branchId !== void 0 ? { branchId } : {}
  };
}
function parseCharacterMemory(raw) {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  const characterId = parseId(raw.characterId);
  if (!characterId) return null;
  if (!isNumber(raw.at)) return null;
  if (!isString(raw.content) || raw.content.length === 0 || raw.content.length > W0_LIMITS.maxMemoryContent) return null;
  const regionId = parseOptionalId(raw.regionId);
  if (regionId === false) return null;
  const pointId = parseOptionalId(raw.pointId);
  if (pointId === false) return null;
  const eventId = parseOptionalId(raw.eventId);
  if (eventId === false) return null;
  if (raw.important !== void 0 && typeof raw.important !== "boolean") return null;
  if (!isNumber(raw.createdAt)) return null;
  const actionId = parseOptionalId(raw.actionId);
  if (actionId === false) return null;
  const branchId = parseOptionalId(raw.branchId);
  if (branchId === false) return null;
  return {
    id,
    characterId,
    at: raw.at,
    content: raw.content,
    ...regionId !== void 0 ? { regionId } : {},
    ...pointId !== void 0 ? { pointId } : {},
    ...eventId !== void 0 ? { eventId } : {},
    ...typeof raw.important === "boolean" ? { important: raw.important } : {},
    createdAt: raw.createdAt,
    ...actionId !== void 0 ? { actionId } : {},
    ...branchId !== void 0 ? { branchId } : {}
  };
}
function parseWorldTriggerCondition(raw) {
  if (!isObject(raw)) return null;
  if (raw.minTime !== void 0 && raw.minTime !== null && !isNumber(raw.minTime)) return null;
  if (raw.maxTime !== void 0 && raw.maxTime !== null && !isNumber(raw.maxTime)) return null;
  const regionId = parseOptionalId(raw.regionId);
  if (regionId === false) return null;
  const pointId = parseOptionalId(raw.pointId);
  if (pointId === false) return null;
  if (raw.characterIds !== void 0 && !isBoundedStringList(raw.characterIds, W0_LIMITS.maxCompanions)) return null;
  const requiresFlag = parseOptionalId(raw.requiresFlag);
  if (requiresFlag === false) return null;
  const forbidsFlag = parseOptionalId(raw.forbidsFlag);
  if (forbidsFlag === false) return null;
  return {
    ...isNumber(raw.minTime) ? { minTime: raw.minTime } : {},
    ...isNumber(raw.maxTime) ? { maxTime: raw.maxTime } : {},
    ...regionId !== void 0 ? { regionId } : {},
    ...pointId !== void 0 ? { pointId } : {},
    ...Array.isArray(raw.characterIds) ? { characterIds: raw.characterIds } : {},
    ...requiresFlag !== void 0 ? { requiresFlag } : {},
    ...forbidsFlag !== void 0 ? { forbidsFlag } : {}
  };
}
function parseWorldTrigger(raw) {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  if (typeof raw.enabled !== "boolean") return null;
  if (!isString(raw.title) || raw.title.length === 0 || raw.title.length > W0_LIMITS.maxTriggerTitle) return null;
  if (raw.conditionSummary !== void 0 && (!isString(raw.conditionSummary) || raw.conditionSummary.length > W0_LIMITS.maxTriggerSummary)) return null;
  let condition;
  if (raw.condition !== void 0 && raw.condition !== null) {
    condition = parseWorldTriggerCondition(raw.condition) ?? void 0;
    if (!condition) return null;
  }
  if (raw.outcomeTemplate !== void 0 && (!isString(raw.outcomeTemplate) || raw.outcomeTemplate.length > W0_LIMITS.maxOutcomeTemplate)) return null;
  if (raw.outcomeTags !== void 0 && !isBoundedStringList(raw.outcomeTags, W0_LIMITS.maxOutcomeTags, W0_LIMITS.maxTagLength)) return null;
  if (raw.scopeRegionIds !== void 0 && !isBoundedStringList(raw.scopeRegionIds, W0_LIMITS.maxTriggers)) return null;
  if (raw.scopePointIds !== void 0 && !isBoundedStringList(raw.scopePointIds, W0_LIMITS.maxTriggers)) return null;
  if (raw.createdAt !== void 0 && !isNumber(raw.createdAt)) return null;
  if (raw.updatedAt !== void 0 && !isNumber(raw.updatedAt)) return null;
  return {
    id,
    enabled: raw.enabled,
    title: raw.title,
    ...isString(raw.conditionSummary) ? { conditionSummary: raw.conditionSummary } : {},
    ...condition ? { condition } : {},
    ...isString(raw.outcomeTemplate) ? { outcomeTemplate: raw.outcomeTemplate } : {},
    ...Array.isArray(raw.outcomeTags) ? { outcomeTags: raw.outcomeTags } : {},
    ...Array.isArray(raw.scopeRegionIds) ? { scopeRegionIds: raw.scopeRegionIds } : {},
    ...Array.isArray(raw.scopePointIds) ? { scopePointIds: raw.scopePointIds } : {},
    ...isNumber(raw.createdAt) ? { createdAt: raw.createdAt } : {},
    ...isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}
  };
}
function parseStoryRuntime(raw) {
  if (!isObject(raw)) return null;
  const storyId = parseId(raw.storyId);
  if (!storyId) return null;
  if (!isNumber(raw.currentTime)) return null;
  const regionId = raw.currentRegionId === void 0 ? null : raw.currentRegionId;
  if (regionId !== null && !isString(regionId)) return null;
  const pointId = parseOptionalId(raw.currentPointId);
  if (pointId === false) return null;
  if (raw.companions !== void 0 && !isBoundedStringList(raw.companions, W0_LIMITS.maxCompanions)) return null;
  if (raw.worldFlags !== void 0 && !isBoundedStringList(raw.worldFlags, W0_LIMITS.maxWorldFlags, W0_LIMITS.maxFlagLength)) return null;
  if (raw.actionLog !== void 0 && !isBoundedStringList(raw.actionLog, W0_LIMITS.maxActions)) return null;
  const snapshotFrom = parseOptionalId(raw.snapshotFrom);
  if (snapshotFrom === false) return null;
  if (raw.updatedAt !== void 0 && !isNumber(raw.updatedAt)) return null;
  return {
    storyId,
    currentTime: raw.currentTime,
    currentRegionId: regionId,
    ...pointId !== void 0 ? { currentPointId: pointId } : {},
    ...Array.isArray(raw.companions) ? { companions: raw.companions } : {},
    ...Array.isArray(raw.worldFlags) ? { worldFlags: raw.worldFlags } : {},
    ...Array.isArray(raw.actionLog) ? { actionLog: raw.actionLog } : {},
    ...snapshotFrom !== void 0 ? { snapshotFrom } : {},
    ...isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}
  };
}
function parseWorldActionSourceRef(raw) {
  if (!isObject(raw)) return null;
  const kind = raw.kind;
  if (kind !== "region" && kind !== "point" && kind !== "character" && kind !== "worldBook" && kind !== "trigger") return null;
  const id = parseId(raw.id);
  if (!id) return null;
  if (raw.label !== void 0 && (!isString(raw.label) || raw.label.length > W0_LIMITS.maxSourceLabel)) return null;
  return { kind, id, ...isString(raw.label) ? { label: raw.label } : {} };
}
function parseWorldAction(raw) {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  if (!isNumber(raw.at)) return null;
  if (!isString(raw.kind) || !WORLD_ACTION_KINDS.includes(raw.kind)) return null;
  const actorId = parseOptionalId(raw.actorId);
  if (actorId === false) return null;
  const fromRegionId = parseOptionalId(raw.fromRegionId);
  if (fromRegionId === false) return null;
  const fromPointId = parseOptionalId(raw.fromPointId);
  if (fromPointId === false) return null;
  const toRegionId = parseOptionalId(raw.toRegionId);
  if (toRegionId === false) return null;
  const toPointId = parseOptionalId(raw.toPointId);
  if (toPointId === false) return null;
  if (raw.viaPointIds !== void 0 && !isBoundedStringList(raw.viaPointIds, W0_LIMITS.maxViaPoints)) return null;
  if (raw.duration !== void 0 && (!isNumber(raw.duration) || raw.duration < 0)) return null;
  let candidateSources;
  if (raw.candidateSources !== void 0) {
    candidateSources = parseBoundedArray(raw.candidateSources, W0_LIMITS.maxCandidateSources, parseWorldActionSourceRef) ?? void 0;
    if (!candidateSources) return null;
  }
  if (raw.seed !== void 0 && !isNumber(raw.seed)) return null;
  const outcomeId = parseOptionalId(raw.outcomeId);
  if (outcomeId === false) return null;
  if (raw.startedAt !== void 0 && !isNumber(raw.startedAt)) return null;
  if (raw.endedAt !== void 0 && !isNumber(raw.endedAt)) return null;
  if (raw.durationSource !== void 0) {
    if (!isString(raw.durationSource)) return null;
    if (!DURATION_SOURCES.includes(raw.durationSource)) return null;
  }
  if (raw.baselineVersion !== void 0 && (!isString(raw.baselineVersion) || raw.baselineVersion.length === 0 || raw.baselineVersion.length > 40)) return null;
  const worldAgentRevision = parseOptionalId(raw.worldAgentRevision);
  if (worldAgentRevision === false) return null;
  const focusCardId = parseOptionalId(raw.focusCardId);
  if (focusCardId === false) return null;
  if (raw.summary !== void 0 && (!isString(raw.summary) || raw.summary.length > W0_LIMITS.maxActionSummary)) return null;
  return {
    id,
    at: raw.at,
    kind: raw.kind,
    ...actorId !== void 0 ? { actorId } : {},
    ...fromRegionId !== void 0 ? { fromRegionId } : {},
    ...fromPointId !== void 0 ? { fromPointId } : {},
    ...toRegionId !== void 0 ? { toRegionId } : {},
    ...toPointId !== void 0 ? { toPointId } : {},
    ...Array.isArray(raw.viaPointIds) ? { viaPointIds: raw.viaPointIds } : {},
    ...isNumber(raw.duration) ? { duration: raw.duration } : {},
    ...candidateSources ? { candidateSources } : {},
    ...isNumber(raw.seed) ? { seed: raw.seed } : {},
    ...outcomeId !== void 0 ? { outcomeId } : {},
    ...isNumber(raw.startedAt) ? { startedAt: raw.startedAt } : {},
    ...isNumber(raw.endedAt) ? { endedAt: raw.endedAt } : {},
    ...isString(raw.durationSource) ? { durationSource: raw.durationSource } : {},
    ...isString(raw.baselineVersion) ? { baselineVersion: raw.baselineVersion } : {},
    ...worldAgentRevision !== void 0 ? { worldAgentRevision } : {},
    ...focusCardId !== void 0 ? { focusCardId } : {},
    ...isString(raw.summary) ? { summary: raw.summary } : {}
  };
}
function parseWorldOutcome(raw) {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  const actionId = parseId(raw.actionId);
  if (!actionId) return null;
  if (!isString(raw.kind) || !WORLD_OUTCOME_KINDS.includes(raw.kind)) return null;
  const triggerId = parseOptionalId(raw.triggerId);
  if (triggerId === false) return null;
  if (raw.result !== void 0 && (!isString(raw.result) || raw.result.length > W0_LIMITS.maxOutcomeTemplate)) return null;
  if (raw.changeRefs !== void 0 && !isBoundedStringList(raw.changeRefs, W0_LIMITS.maxChangeRefs)) return null;
  if (raw.reason !== void 0 && (!isString(raw.reason) || raw.reason.length > W0_LIMITS.maxReasonLength)) return null;
  if (raw.seed !== void 0 && !isNumber(raw.seed)) return null;
  if (raw.at !== void 0 && !isNumber(raw.at)) return null;
  return {
    id,
    actionId,
    kind: raw.kind,
    ...triggerId !== void 0 ? { triggerId } : {},
    ...isString(raw.result) ? { result: raw.result } : {},
    ...Array.isArray(raw.changeRefs) ? { changeRefs: raw.changeRefs } : {},
    ...isString(raw.reason) ? { reason: raw.reason } : {},
    ...isNumber(raw.seed) ? { seed: raw.seed } : {},
    ...isNumber(raw.at) ? { at: raw.at } : {}
  };
}
function parseEntityBaseline(baseline) {
  if (!isObject(baseline)) return null;
  const keys = Object.keys(baseline);
  if (keys.length > W0_LIMITS.maxEntityBaselineFields) return null;
  const out = {};
  for (const key of keys) {
    if (key.length === 0 || key.length > W0_LIMITS.maxEntityFieldKey) return null;
    const value = baseline[key];
    if (!(isString(value) || isNumber(value) || typeof value === "boolean" || Array.isArray(value) && value.every(isString))) return null;
    out[key] = value;
  }
  return out;
}
function parseEntityTemporalField(raw) {
  if (!isObject(raw)) return null;
  if (!isString(raw.key) || raw.key.length === 0 || raw.key.length > W0_LIMITS.maxEntityFieldKey) return null;
  if (!isString(raw.kind) || !ENTITY_FIELD_KINDS.includes(raw.kind)) return null;
  if (!isString(raw.valueType) || !ENTITY_FIELD_VALUE_TYPES.includes(raw.valueType)) return null;
  const entersAI = raw.entersAI;
  const entersTimeline = raw.entersTimeline;
  const entersMap = raw.entersMap;
  if (entersAI !== void 0 && typeof entersAI !== "boolean") return null;
  if (entersTimeline !== void 0 && typeof entersTimeline !== "boolean") return null;
  if (entersMap !== void 0 && typeof entersMap !== "boolean") return null;
  return {
    key: raw.key,
    kind: raw.kind,
    valueType: raw.valueType,
    ...typeof entersAI === "boolean" ? { entersAI } : {},
    ...typeof entersTimeline === "boolean" ? { entersTimeline } : {},
    ...typeof entersMap === "boolean" ? { entersMap } : {}
  };
}
function parseEntityRecord(raw) {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  const worldId = parseId(raw.worldId);
  if (!worldId) return null;
  if (!isString(raw.type) || raw.type.length === 0 || raw.type.length > W0_LIMITS.maxEntityTypeName) return null;
  if (!isString(raw.name) || raw.name.length === 0 || raw.name.length > W0_LIMITS.maxSourceLabel) return null;
  const baseline = parseEntityBaseline(raw.baseline);
  if (baseline === null) return null;
  if (!Array.isArray(raw.temporalSchema) || raw.temporalSchema.length > W0_LIMITS.maxEntityTemporalFields) return null;
  const schema = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of raw.temporalSchema) {
    const field = parseEntityTemporalField(item);
    if (field === null) return null;
    if (seen.has(field.key)) return null;
    seen.add(field.key);
    schema.push(field);
  }
  for (const key of Object.keys(baseline)) {
    const declared = schema.find((f) => f.key === key);
    if (!declared) return null;
    if (declared.kind === "temporal") return null;
  }
  let mapAnchor;
  if (raw.mapAnchor !== void 0) {
    if (!isObject(raw.mapAnchor)) return null;
    const regionId = parseOptionalId(raw.mapAnchor.regionId);
    if (regionId === false) return null;
    const pointId = parseOptionalId(raw.mapAnchor.pointId);
    if (pointId === false) return null;
    const x = raw.mapAnchor.x;
    const y = raw.mapAnchor.y;
    if (x !== void 0 && (!isNumber(x) || x < 0 || x > 100)) return null;
    if (y !== void 0 && (!isNumber(y) || y < 0 || y > 100)) return null;
    mapAnchor = {
      ...regionId !== void 0 && regionId !== null ? { regionId } : {},
      ...pointId !== void 0 && pointId !== null ? { pointId } : {},
      ...isNumber(x) ? { x } : {},
      ...isNumber(y) ? { y } : {}
    };
  }
  if (raw.createdAt !== void 0 && !isNumber(raw.createdAt)) return null;
  if (raw.updatedAt !== void 0 && !isNumber(raw.updatedAt)) return null;
  if (raw.authorNote !== void 0 && (!isString(raw.authorNote) || raw.authorNote.length > W0_LIMITS.maxRevisionNote)) return null;
  return {
    id,
    worldId,
    type: raw.type,
    name: raw.name,
    baseline,
    temporalSchema: schema,
    ...mapAnchor !== void 0 ? { mapAnchor } : {},
    ...isNumber(raw.createdAt) ? { createdAt: raw.createdAt } : {},
    ...isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {},
    ...isString(raw.authorNote) ? { authorNote: raw.authorNote } : {}
  };
}
function parseDefinitionRevision(raw) {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  const worldId = parseId(raw.worldId);
  if (!worldId) return null;
  if (!isNumber(raw.createdAt)) return null;
  if (!isString(raw.authorNote) || raw.authorNote.length === 0 || raw.authorNote.length > W0_LIMITS.maxRevisionNote) return null;
  const refList = (value) => {
    if (value === void 0) return void 0;
    if (!Array.isArray(value) || value.length > W0_LIMITS.maxCandidateSources || !value.every(isString)) return null;
    return value;
  };
  const baseWorldbookRefs = refList(raw.baseWorldbookRefs);
  if (baseWorldbookRefs === null) return null;
  const mapRefs = refList(raw.mapRefs);
  if (mapRefs === null) return null;
  const ruleRefs = refList(raw.ruleRefs);
  if (ruleRefs === null) return null;
  const entityBaselineRefs = refList(raw.entityBaselineRefs);
  if (entityBaselineRefs === null) return null;
  const parentRevisionId = parseOptionalId(raw.parentRevisionId);
  if (parentRevisionId === false) return null;
  if (raw.isRetcon !== void 0 && typeof raw.isRetcon !== "boolean") return null;
  if (raw.effectiveAt !== void 0 && (!isNumber(raw.effectiveAt) || raw.effectiveAt < 0)) return null;
  const effectiveBranchId = parseOptionalId(raw.effectiveBranchId);
  if (effectiveBranchId === false) return null;
  let snapshot;
  if (raw.snapshot !== void 0) {
    if (!isObject(raw.snapshot)) return null;
    const worldBible = parseOptionalArray(raw.snapshot.worldBible, WORLD_BIBLE_MAX_ENTRIES, parseWorldBibleEntry);
    if (worldBible === null) return null;
    const regions = parseOptionalArray(raw.snapshot.regions, W0_LIMITS.maxCandidateSources, parseRegion);
    if (regions === null) return null;
    const points = parseOptionalArray(raw.snapshot.points, W0_LIMITS.maxCandidateSources, parseMapPoint);
    if (points === null) return null;
    const triggers = parseOptionalArray(raw.snapshot.triggers, W0_LIMITS.maxTriggers, parseWorldTrigger);
    if (triggers === null) return null;
    const entities = parseOptionalArray(raw.snapshot.entities, W0_LIMITS.maxEntityRecords, parseEntityRecord);
    if (entities === null) return null;
    const globalPrompt = raw.snapshot.globalPrompt;
    if (globalPrompt !== void 0 && globalPrompt !== null && !isString(globalPrompt)) return null;
    if (!isString(raw.snapshot.contentHash) || raw.snapshot.contentHash.length === 0) return null;
    snapshot = {
      worldBible: worldBible ?? [],
      regions: regions ?? [],
      points: points ?? [],
      triggers: triggers ?? [],
      entities: entities ?? [],
      globalPrompt: globalPrompt ?? null,
      contentHash: raw.snapshot.contentHash
    };
  }
  return {
    id,
    worldId,
    createdAt: raw.createdAt,
    authorNote: raw.authorNote,
    ...baseWorldbookRefs ? { baseWorldbookRefs } : {},
    ...mapRefs ? { mapRefs } : {},
    ...ruleRefs ? { ruleRefs } : {},
    ...entityBaselineRefs ? { entityBaselineRefs } : {},
    ...parentRevisionId !== void 0 ? { parentRevisionId } : {},
    ...typeof raw.isRetcon === "boolean" ? { isRetcon: raw.isRetcon } : {},
    ...isNumber(raw.effectiveAt) ? { effectiveAt: raw.effectiveAt } : {},
    ...effectiveBranchId !== void 0 ? { effectiveBranchId } : {},
    ...snapshot ? { snapshot } : {}
  };
}
function parseStateEffect(raw) {
  if (!isObject(raw)) return null;
  const entityId = parseOptionalId(raw.entityId);
  if (entityId === false) return null;
  const trim = (v, max) => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t.length > 0 && t.length <= max ? t : null;
  };
  const parseValue = (v) => {
    if (isString(v)) return v.slice(0, W0_LIMITS.maxMemoryContent);
    if (isNumber(v) || typeof v === "boolean") return v;
    if (Array.isArray(v) && v.every(isString) && v.length <= W0_LIMITS.maxTagLength) return v;
    return null;
  };
  switch (raw.kind) {
    case "setTemporalField": {
      if (!entityId) return null;
      const key = trim(raw.key, W0_LIMITS.maxEntityFieldKey);
      if (!key) return null;
      const value = parseValue(raw.value);
      if (value === null) return null;
      return { kind: "setTemporalField", entityId, key, value };
    }
    case "moveEntity": {
      if (!entityId) return null;
      const regionId = parseOptionalId(raw.regionId);
      if (regionId === false) return null;
      const pointId = parseOptionalId(raw.pointId);
      if (pointId === false) return null;
      return {
        kind: "moveEntity",
        entityId,
        ...regionId ? { regionId } : {},
        ...pointId ? { pointId } : {}
      };
    }
    case "adjustRelation": {
      if (!entityId) return null;
      const targetEntityId = parseOptionalId(raw.targetEntityId);
      if (!targetEntityId) return null;
      const key = trim(raw.key, W0_LIMITS.maxEntityFieldKey);
      if (!key) return null;
      const value = raw.value;
      if (!isString(value) && !isNumber(value)) return null;
      return { kind: "adjustRelation", entityId, targetEntityId, key, value };
    }
    case "addTag":
    case "removeTag": {
      if (!entityId) return null;
      const tag = trim(raw.tag, W0_LIMITS.maxFlagLength);
      if (!tag) return null;
      return { kind: raw.kind, entityId, tag };
    }
    case "appendMemoryRef": {
      if (!entityId) return null;
      const memoryId = parseOptionalId(raw.memoryId);
      if (memoryId === false) return null;
      const text = raw.text !== void 0 ? trim(raw.text, W0_LIMITS.maxMemoryContent) : void 0;
      if (raw.text !== void 0 && !text) return null;
      return {
        kind: "appendMemoryRef",
        entityId,
        ...memoryId ? { memoryId } : {},
        ...text ? { text } : {}
      };
    }
    case "attachNarrativeEntry": {
      if (!entityId) return null;
      const text = trim(raw.text, W0_LIMITS.maxNarrativeEntry);
      if (!text) return null;
      return { kind: "attachNarrativeEntry", entityId, text };
    }
    case "closeNarrativeEntry": {
      if (!entityId) return null;
      const entryId = parseOptionalId(raw.entryId);
      if (!entryId) return null;
      return { kind: "closeNarrativeEntry", entityId, entryId };
    }
    case "setFlag": {
      const key = trim(raw.key, W0_LIMITS.maxFlagLength);
      if (!key) return null;
      const value = raw.value !== void 0 ? trim(raw.value, W0_LIMITS.maxFlagLength) : void 0;
      if (raw.value !== void 0 && !value) return null;
      return { kind: "setFlag", key, ...value ? { value } : {} };
    }
    default:
      return null;
  }
}
function parseStateEvent(raw) {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  const worldId = parseId(raw.worldId);
  if (!worldId) return null;
  const branchId = parseOptionalId(raw.branchId);
  if (branchId === false) return null;
  if (!isNumber(raw.at)) return null;
  if (!isNumber(raw.sequence) || raw.sequence < 0 || !Number.isInteger(raw.sequence)) return null;
  if (!isString(raw.source) || !STATE_EVENT_SOURCES.includes(raw.source)) return null;
  const actionId = parseOptionalId(raw.actionId);
  if (actionId === false) return null;
  const sessionId = parseOptionalId(raw.sessionId);
  if (sessionId === false) return null;
  if (!isString(raw.narrativeSummary) || raw.narrativeSummary.length === 0 || raw.narrativeSummary.length > W0_LIMITS.maxStateEventSummary) return null;
  if (!Array.isArray(raw.entityRefs) || raw.entityRefs.length > W0_LIMITS.maxStateEntityRefs || !raw.entityRefs.every(isString)) return null;
  if (!Array.isArray(raw.effects) || raw.effects.length > W0_LIMITS.maxStateEventEffects) return null;
  const effects = [];
  for (const effect of raw.effects) {
    const parsedEffect = parseStateEffect(effect);
    if (parsedEffect === null) return null;
    effects.push(parsedEffect);
  }
  const reversesEventId = parseOptionalId(raw.reversesEventId);
  if (reversesEventId === false) return null;
  if (raw.createdAt !== void 0 && !isNumber(raw.createdAt)) return null;
  return {
    id,
    worldId,
    // 正史线统一归一化为 null（缺失 = 正史）
    branchId: branchId ?? null,
    at: raw.at,
    sequence: raw.sequence,
    source: raw.source,
    ...actionId !== void 0 ? { actionId } : {},
    ...sessionId !== void 0 ? { sessionId } : {},
    narrativeSummary: raw.narrativeSummary,
    entityRefs: raw.entityRefs,
    effects,
    ...reversesEventId !== void 0 ? { reversesEventId } : {},
    ...isNumber(raw.createdAt) ? { createdAt: raw.createdAt } : {}
  };
}
function parseCheckpointSnapshot(raw) {
  if (!isObject(raw)) return null;
  const narrativeDict = (value) => {
    if (value === void 0) return {};
    if (!isObject(value)) return null;
    const out = {};
    for (const key of Object.keys(value)) {
      const inner = value[key];
      if (!isObject(inner)) return null;
      const innerOut = {};
      for (const innerKey of Object.keys(inner)) {
        const entry = inner[innerKey];
        if (!isObject(entry) || !isString(entry.text) || typeof entry.closed !== "boolean") return null;
        innerOut[innerKey] = { text: entry.text, closed: entry.closed };
      }
      out[key] = innerOut;
    }
    return out;
  };
  const strArrayDict = (value) => {
    if (value === void 0) return {};
    if (!isObject(value)) return null;
    const out = {};
    for (const key of Object.keys(value)) {
      if (!Array.isArray(value[key]) || !value[key].every(isString)) return null;
      out[key] = value[key];
    }
    return out;
  };
  const valueDict = (value) => {
    if (value === void 0) return {};
    if (!isObject(value)) return null;
    return value;
  };
  const flagDict = (value) => {
    if (value === void 0) return {};
    if (!isObject(value)) return null;
    const out = {};
    for (const key of Object.keys(value)) {
      const v = value[key];
      if (!isString(v) && typeof v !== "boolean") return null;
      out[key] = v;
    }
    return out;
  };
  const entityStates = valueDict(raw.entityStates);
  if (entityStates === null) return null;
  const flags = flagDict(raw.flags);
  if (flags === null) return null;
  const memoryRefs = strArrayDict(raw.memoryRefs);
  if (memoryRefs === null) return null;
  const narrativeEntries = narrativeDict(raw.narrativeEntries);
  if (narrativeEntries === null) return null;
  if (!Array.isArray(raw.sourceChain) || !raw.sourceChain.every(isString)) return null;
  if (!isString(raw.stateHash) || raw.stateHash.length === 0) return null;
  return {
    entityStates,
    flags,
    memoryRefs,
    narrativeEntries,
    sourceChain: raw.sourceChain,
    stateHash: raw.stateHash
  };
}
function parseCheckpointRuntime(raw) {
  if (!isObject(raw)) return null;
  if (!isNumber(raw.currentTime)) return null;
  const currentRegionId = parseOptionalId(raw.currentRegionId);
  if (currentRegionId === false) return null;
  const currentPointId = raw.currentPointId === null || raw.currentPointId === void 0 ? null : typeof raw.currentPointId === "string" ? raw.currentPointId : String(raw.currentPointId);
  if (currentPointId !== null && typeof currentPointId !== "string") return null;
  if (!Array.isArray(raw.worldFlags) || !raw.worldFlags.every(isString)) return null;
  if (typeof raw.approx !== "boolean") return null;
  const actionLog = Array.isArray(raw.actionLog) && raw.actionLog.every(isString) ? raw.actionLog.slice(-W0_LIMITS.maxActions) : void 0;
  return {
    currentTime: raw.currentTime,
    currentRegionId: currentRegionId ?? null,
    currentPointId,
    worldFlags: raw.worldFlags.slice(0, W0_LIMITS.maxWorldFlags),
    approx: raw.approx,
    ...actionLog ? { actionLog } : {}
  };
}
function parseWorldCheckpoint(raw) {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  const worldId = parseId(raw.worldId);
  if (!worldId) return null;
  if (raw.name !== void 0 && (!isString(raw.name) || raw.name.length > W0_LIMITS.maxCheckpointName)) return null;
  if (!isString(raw.kind) || !["technical", "author"].includes(raw.kind)) return null;
  if (!isString(raw.reason) || raw.reason.length === 0 || raw.reason.length > W0_LIMITS.maxCheckpointReason) return null;
  const branchId = parseOptionalId(raw.branchId);
  if (branchId === false) return null;
  if (!isNumber(raw.at)) return null;
  const ledgerHead = parseOptionalId(raw.ledgerHead);
  if (ledgerHead === false) return null;
  if (!isNumber(raw.ledgerCount) || raw.ledgerCount < 0) return null;
  const definitionRevisionId = parseOptionalId(raw.definitionRevisionId);
  if (definitionRevisionId === false) return null;
  const parentCheckpointId = parseOptionalId(raw.parentCheckpointId);
  if (parentCheckpointId === false) return null;
  const snapshot = parseCheckpointSnapshot(raw.snapshot);
  if (snapshot === null) return null;
  if (raw.createdAt !== void 0 && !isNumber(raw.createdAt)) return null;
  if (raw.runtime !== void 0 && raw.runtime !== null) {
    const runtime = parseCheckpointRuntime(raw.runtime);
    if (runtime === null) return null;
    return {
      id,
      worldId,
      ...isString(raw.name) ? { name: raw.name } : {},
      kind: raw.kind,
      reason: raw.reason,
      // 正史检查点统一归一化为 null（缺失 = 正史）
      branchId: branchId ?? null,
      at: raw.at,
      ledgerHead: ledgerHead ?? null,
      ledgerCount: raw.ledgerCount,
      ...definitionRevisionId !== void 0 ? { definitionRevisionId } : {},
      ...parentCheckpointId !== void 0 ? { parentCheckpointId } : {},
      runtime,
      snapshot,
      ...isNumber(raw.createdAt) ? { createdAt: raw.createdAt } : {}
    };
  }
  return {
    id,
    worldId,
    ...isString(raw.name) ? { name: raw.name } : {},
    kind: raw.kind,
    reason: raw.reason,
    // 正史检查点统一归一化为 null（缺失 = 正史）
    branchId: branchId ?? null,
    at: raw.at,
    ledgerHead: ledgerHead ?? null,
    ledgerCount: raw.ledgerCount,
    ...definitionRevisionId !== void 0 ? { definitionRevisionId } : {},
    ...parentCheckpointId !== void 0 ? { parentCheckpointId } : {},
    snapshot,
    ...isNumber(raw.createdAt) ? { createdAt: raw.createdAt } : {}
  };
}
function parsePlayheadState(raw) {
  if (!isObject(raw)) return null;
  const branchId = parseOptionalId(raw.branchId);
  if (branchId === false) return null;
  if (!isNumber(raw.at)) return null;
  const checkpointId = parseOptionalId(raw.checkpointId);
  if (checkpointId === false) return null;
  if (raw.updatedAt !== void 0 && !isNumber(raw.updatedAt)) return null;
  return {
    branchId: branchId ?? null,
    at: raw.at,
    ...checkpointId !== void 0 ? { checkpointId } : {},
    ...isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}
  };
}
function parseStoryAgentSession(raw) {
  if (!isObject(raw)) return null;
  const storyId = parseId(raw.storyId);
  if (!storyId) return null;
  const connectionId = parseOptionalId(raw.connectionId);
  if (connectionId === false) return null;
  if (raw.strategy !== void 0 && !isString(raw.strategy)) return null;
  if (isString(raw.strategy) && !AGENT_CALL_STRATEGIES.includes(raw.strategy)) return null;
  if (raw.worldSummary !== void 0 && (!isString(raw.worldSummary) || raw.worldSummary.length > W0_LIMITS.maxSessionSummary)) return null;
  if (raw.openThreads !== void 0 && !isBoundedStringList(raw.openThreads, W0_LIMITS.maxOpenThreads, W0_LIMITS.maxThreadLength)) return null;
  if (raw.updatedAt !== void 0 && !isNumber(raw.updatedAt)) return null;
  if (raw.presentationMode !== void 0) {
    if (!isString(raw.presentationMode)) return null;
    if (!NARRATIVE_PRESENTATION_MODES.includes(raw.presentationMode)) return null;
  }
  const viewpointCharacterId = parseOptionalId(raw.viewpointCharacterId);
  if (viewpointCharacterId === false) return null;
  if (raw.knowledgeScope !== void 0 && (!isString(raw.knowledgeScope) || raw.knowledgeScope.length > W0_CARD_LIMITS.maxKnowledgeScope)) return null;
  if (raw.activeCardSessionIds !== void 0 && !isBoundedStringList(raw.activeCardSessionIds, W0_CARD_LIMITS.maxActiveCardSessions)) return null;
  const worldAgentId = parseOptionalId(raw.worldAgentId);
  if (worldAgentId === false) return null;
  const worldAgentRevision = parseOptionalId(raw.worldAgentRevision);
  if (worldAgentRevision === false) return null;
  return {
    storyId,
    ...connectionId !== void 0 ? { connectionId } : {},
    ...isString(raw.strategy) ? { strategy: raw.strategy } : {},
    ...isString(raw.worldSummary) ? { worldSummary: raw.worldSummary } : {},
    ...Array.isArray(raw.openThreads) ? { openThreads: raw.openThreads } : {},
    ...isString(raw.presentationMode) ? { presentationMode: raw.presentationMode } : {},
    ...viewpointCharacterId !== void 0 ? { viewpointCharacterId } : {},
    ...isString(raw.knowledgeScope) ? { knowledgeScope: raw.knowledgeScope } : {},
    ...Array.isArray(raw.activeCardSessionIds) ? { activeCardSessionIds: raw.activeCardSessionIds } : {},
    ...worldAgentId !== void 0 ? { worldAgentId } : {},
    ...worldAgentRevision !== void 0 ? { worldAgentRevision } : {},
    ...isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}
  };
}
function parseCardSessionCheckpoint(raw) {
  if (!isObject(raw)) return null;
  const actionId = parseOptionalId(raw.actionId);
  if (actionId === false) return null;
  if (raw.at !== void 0 && raw.at !== null && !isNumber(raw.at)) return null;
  if (raw.summary !== void 0 && (!isString(raw.summary) || raw.summary.length > W0_CARD_LIMITS.maxCheckpointSummary)) return null;
  if (raw.worldFlags !== void 0 && !isBoundedStringList(raw.worldFlags, W0_CARD_LIMITS.maxCheckpointFlags, W0_LIMITS.maxFlagLength)) return null;
  return {
    ...actionId !== void 0 ? { actionId } : {},
    ...isNumber(raw.at) ? { at: raw.at } : {},
    ...isString(raw.summary) ? { summary: raw.summary } : {},
    ...Array.isArray(raw.worldFlags) ? { worldFlags: raw.worldFlags } : {}
  };
}
function parseCardAgentProfile(raw) {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  if (!isString(raw.cardType) || !CARD_TYPES.includes(raw.cardType)) return null;
  const sourceCardId = parseId(raw.sourceCardId);
  if (!sourceCardId) return null;
  if (typeof raw.enabled !== "boolean") return null;
  if (!isString(raw.participation) || !CARD_PARTICIPATIONS.includes(raw.participation)) return null;
  if (raw.activeFrom !== void 0 && raw.activeFrom !== null && !isNumber(raw.activeFrom)) return null;
  if (raw.activeTo !== void 0 && raw.activeTo !== null && !isNumber(raw.activeTo)) return null;
  if (isNumber(raw.activeFrom) && isNumber(raw.activeTo) && raw.activeFrom > raw.activeTo) return null;
  if (raw.sourceRefs !== void 0 && !isBoundedStringList(raw.sourceRefs, W0_CARD_LIMITS.maxSourceRefs)) return null;
  if (raw.roleConstraints !== void 0 && (!isString(raw.roleConstraints) || raw.roleConstraints.length > W0_CARD_LIMITS.maxRoleConstraints)) return null;
  const defaultConnectionId = parseOptionalId(raw.defaultConnectionId);
  if (defaultConnectionId === false) return null;
  const sourceRevision = parseId(raw.sourceRevision);
  if (!sourceRevision) return null;
  if (raw.manuallyEdited !== void 0 && !isBoundedStringList(raw.manuallyEdited, W0_CARD_LIMITS.maxManualEditedFields)) return null;
  if (raw.needsReview !== void 0 && typeof raw.needsReview !== "boolean") return null;
  if (raw.summary !== void 0 && (!isString(raw.summary) || raw.summary.length > W0_CARD_LIMITS.maxSummary)) return null;
  if (raw.createdAt !== void 0 && !isNumber(raw.createdAt)) return null;
  if (raw.updatedAt !== void 0 && !isNumber(raw.updatedAt)) return null;
  return {
    id,
    cardType: raw.cardType,
    sourceCardId,
    enabled: raw.enabled,
    participation: raw.participation,
    ...isNumber(raw.activeFrom) ? { activeFrom: raw.activeFrom } : {},
    ...isNumber(raw.activeTo) ? { activeTo: raw.activeTo } : {},
    ...Array.isArray(raw.sourceRefs) ? { sourceRefs: raw.sourceRefs } : {},
    ...isString(raw.roleConstraints) ? { roleConstraints: raw.roleConstraints } : {},
    ...defaultConnectionId !== void 0 ? { defaultConnectionId } : {},
    sourceRevision,
    ...Array.isArray(raw.manuallyEdited) ? { manuallyEdited: raw.manuallyEdited } : {},
    ...typeof raw.needsReview === "boolean" ? { needsReview: raw.needsReview } : {},
    ...isString(raw.summary) ? { summary: raw.summary } : {},
    ...isNumber(raw.createdAt) ? { createdAt: raw.createdAt } : {},
    ...isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}
  };
}
function parseCardAgentSession(raw) {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  const profileId = parseId(raw.profileId);
  if (!profileId) return null;
  const storyId = parseId(raw.storyId);
  if (!storyId) return null;
  const branchId = parseId(raw.branchId);
  if (!branchId) return null;
  if (!isString(raw.status) || !CARD_SESSION_STATUSES.includes(raw.status)) return null;
  const startedAtActionId = parseOptionalId(raw.startedAtActionId);
  if (startedAtActionId === false) return null;
  if (raw.contextSummary !== void 0 && (!isString(raw.contextSummary) || raw.contextSummary.length > W0_CARD_LIMITS.maxContextSummary)) return null;
  let checkpoint;
  if (raw.checkpoint !== void 0) {
    if (raw.checkpoint === null) checkpoint = null;
    else {
      checkpoint = parseCardSessionCheckpoint(raw.checkpoint) ?? void 0;
      if (checkpoint === void 0) return null;
    }
  }
  const sourceRevision = parseOptionalId(raw.sourceRevision);
  if (sourceRevision === false) return null;
  if (raw.lastUsedAt !== void 0 && !isNumber(raw.lastUsedAt)) return null;
  if (raw.updatedAt !== void 0 && !isNumber(raw.updatedAt)) return null;
  return {
    id,
    profileId,
    storyId,
    branchId,
    status: raw.status,
    ...startedAtActionId !== void 0 ? { startedAtActionId } : {},
    ...isString(raw.contextSummary) ? { contextSummary: raw.contextSummary } : {},
    ...checkpoint !== void 0 ? { checkpoint } : {},
    ...sourceRevision !== void 0 ? { sourceRevision } : {},
    ...isNumber(raw.lastUsedAt) ? { lastUsedAt: raw.lastUsedAt } : {},
    ...isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}
  };
}
function parseStoryEntryAnchor(raw) {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  const sourceCardId = parseId(raw.sourceCardId);
  if (!sourceCardId) return null;
  if (!isString(raw.cardType) || !CARD_TYPES.includes(raw.cardType)) return null;
  const eventId = parseOptionalId(raw.eventId);
  if (eventId === false) return null;
  if (raw.at !== void 0 && raw.at !== null && !isNumber(raw.at)) return null;
  const regionId = parseOptionalId(raw.regionId);
  if (regionId === false) return null;
  const pointId = parseOptionalId(raw.pointId);
  if (pointId === false) return null;
  if (raw.x !== void 0 && raw.x !== null && !isNumber(raw.x)) return null;
  if (raw.y !== void 0 && raw.y !== null && !isNumber(raw.y)) return null;
  if (!isString(raw.entryPolicy) || !ENTRY_POLICIES.includes(raw.entryPolicy)) return null;
  const snapshotRef = parseOptionalId(raw.snapshotRef);
  if (snapshotRef === false) return null;
  if (raw.invalid !== void 0 && typeof raw.invalid !== "boolean") return null;
  if (raw.createdAt !== void 0 && !isNumber(raw.createdAt)) return null;
  if (raw.completenessNote !== void 0 && !isString(raw.completenessNote)) return null;
  return {
    id,
    sourceCardId,
    cardType: raw.cardType,
    ...eventId !== void 0 ? { eventId } : {},
    ...isNumber(raw.at) ? { at: raw.at } : {},
    ...regionId !== void 0 ? { regionId } : {},
    ...pointId !== void 0 ? { pointId } : {},
    ...isNumber(raw.x) ? { x: raw.x } : {},
    ...isNumber(raw.y) ? { y: raw.y } : {},
    entryPolicy: raw.entryPolicy,
    ...snapshotRef !== void 0 ? { snapshotRef } : {},
    ...typeof raw.invalid === "boolean" ? { invalid: raw.invalid } : {},
    ...isNumber(raw.createdAt) ? { createdAt: raw.createdAt } : {},
    ...isString(raw.completenessNote) ? { completenessNote: raw.completenessNote } : {}
  };
}
function parseMapTravelSettings(raw) {
  if (!isObject(raw)) return null;
  if (typeof raw.enabled !== "boolean") return null;
  if (!isNumber(raw.distancePerCell) || raw.distancePerCell <= 0) return null;
  if (!isString(raw.distanceUnit) || raw.distanceUnit.length === 0 || raw.distanceUnit.length > W0_CARD_LIMITS.maxDistanceUnit) return null;
  if (!isNumber(raw.defaultSpeed) || raw.defaultSpeed <= 0) return null;
  if (raw.terrainFactors !== void 0) {
    if (!isObject(raw.terrainFactors)) return null;
    const entries = Object.entries(raw.terrainFactors);
    if (entries.length > W0_CARD_LIMITS.maxTerrainFactors) return null;
    for (const [key, value] of entries) {
      if (key.length === 0) return null;
      if (!isNumber(value) || value <= 0) return null;
    }
  }
  return {
    enabled: raw.enabled,
    distancePerCell: raw.distancePerCell,
    distanceUnit: raw.distanceUnit,
    defaultSpeed: raw.defaultSpeed,
    ...isObject(raw.terrainFactors) ? { terrainFactors: raw.terrainFactors } : {}
  };
}
function parseWorldAgentTravelGuide(raw) {
  if (!isObject(raw)) return null;
  if (!isString(raw.content) || raw.content.length === 0 || raw.content.length > W0_CARD_LIMITS.maxSummary) return null;
  if (raw.sourceRefs !== void 0 && !isBoundedStringList(raw.sourceRefs, W0_CARD_LIMITS.maxSourceRefs)) return null;
  if (raw.assumptions !== void 0 && !isBoundedStringList(raw.assumptions, W0_CARD_LIMITS.maxSourceRefs)) return null;
  if (raw.updatedAt !== void 0 && !isNumber(raw.updatedAt)) return null;
  return {
    content: raw.content,
    ...Array.isArray(raw.sourceRefs) ? { sourceRefs: raw.sourceRefs } : {},
    ...Array.isArray(raw.assumptions) ? { assumptions: raw.assumptions } : {},
    ...isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}
  };
}
function parseWorldAgentProfile(raw) {
  if (!isObject(raw)) return null;
  const id = parseId(raw.id);
  if (!id) return null;
  const worldId = parseId(raw.worldId);
  if (!worldId) return null;
  if (!isString(raw.status) || !WORLD_AGENT_STATUSES.includes(raw.status)) return null;
  if (!isString(raw.baselineVersion) || raw.baselineVersion.length === 0 || raw.baselineVersion.length > 40) return null;
  if (raw.sourceRefs !== void 0 && !isBoundedStringList(raw.sourceRefs, W0_CARD_LIMITS.maxSourceRefs)) return null;
  if (raw.worldSummary !== void 0 && (!isString(raw.worldSummary) || raw.worldSummary.length > W0_CARD_LIMITS.maxSummary)) return null;
  let travelGuide;
  if (raw.travelGuide !== void 0) {
    if (raw.travelGuide === null) travelGuide = null;
    else {
      travelGuide = parseWorldAgentTravelGuide(raw.travelGuide) ?? void 0;
      if (travelGuide === void 0) return null;
    }
  }
  const sourceRevision = parseId(raw.sourceRevision);
  if (!sourceRevision) return null;
  if (raw.assumptions !== void 0 && !isBoundedStringList(raw.assumptions, W0_CARD_LIMITS.maxSourceRefs)) return null;
  const connectionId = parseOptionalId(raw.connectionId);
  if (connectionId === false) return null;
  if (raw.createdAt !== void 0 && !isNumber(raw.createdAt)) return null;
  if (raw.updatedAt !== void 0 && !isNumber(raw.updatedAt)) return null;
  return {
    id,
    worldId,
    status: raw.status,
    baselineVersion: raw.baselineVersion,
    ...Array.isArray(raw.sourceRefs) ? { sourceRefs: raw.sourceRefs } : {},
    ...isString(raw.worldSummary) ? { worldSummary: raw.worldSummary } : {},
    ...travelGuide !== void 0 ? { travelGuide } : {},
    sourceRevision,
    ...Array.isArray(raw.assumptions) ? { assumptions: raw.assumptions } : {},
    ...connectionId !== void 0 ? { connectionId } : {},
    ...isNumber(raw.createdAt) ? { createdAt: raw.createdAt } : {},
    ...isNumber(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}
  };
}
function parseW0Collections(world) {
  const characterStates = parseOptionalArray(world.characterStates, W0_LIMITS.maxCharacterStates, parseCharacterState);
  if (characterStates === null) return null;
  const characterMemories = parseOptionalArray(world.characterMemories, W0_LIMITS.maxCharacterMemories, parseCharacterMemory);
  if (characterMemories === null) return null;
  const triggers = parseOptionalArray(world.triggers, W0_LIMITS.maxTriggers, parseWorldTrigger);
  if (triggers === null) return null;
  const storyRuntimes = parseOptionalArray(world.storyRuntimes, W0_LIMITS.maxStoryRuntimes, parseStoryRuntime);
  if (storyRuntimes === null) return null;
  const actions = parseOptionalArray(world.actions, W0_LIMITS.maxActions, parseWorldAction);
  if (actions === null) return null;
  const outcomes = parseOptionalArray(world.outcomes, W0_LIMITS.maxOutcomes, parseWorldOutcome);
  if (outcomes === null) return null;
  const agentSessions = parseOptionalArray(world.agentSessions, W0_LIMITS.maxAgentSessions, parseStoryAgentSession);
  if (agentSessions === null) return null;
  const roleplaySessions = parseOptionalArray(world.roleplaySessions, W0_LIMITS.maxRoleplaySessions, parseRoleplaySession);
  if (roleplaySessions === null) return null;
  const cardProfiles = parseOptionalArray(world.cardProfiles, W0_CARD_LIMITS.maxProfiles, parseCardAgentProfile);
  if (cardProfiles === null) return null;
  const cardSessions = parseOptionalArray(world.cardSessions, W0_CARD_LIMITS.maxSessions, parseCardAgentSession);
  if (cardSessions === null) return null;
  const entryAnchors = parseOptionalArray(world.entryAnchors, W0_CARD_LIMITS.maxAnchors, parseStoryEntryAnchor);
  if (entryAnchors === null) return null;
  let travelSettings;
  if (world.travelSettings !== void 0) {
    if (world.travelSettings === null) travelSettings = null;
    else {
      travelSettings = parseMapTravelSettings(world.travelSettings) ?? void 0;
      if (travelSettings === void 0) return null;
    }
  }
  let worldAgent;
  if (world.worldAgent !== void 0) {
    if (world.worldAgent === null) worldAgent = null;
    else {
      worldAgent = parseWorldAgentProfile(world.worldAgent) ?? void 0;
      if (worldAgent === void 0) return null;
    }
  }
  const definitionRevisions = parseOptionalArray(world.definitionRevisions, W0_LIMITS.maxDefinitionRevisions, parseDefinitionRevision);
  if (definitionRevisions === null) return null;
  const entityRecords = parseOptionalArray(world.entityRecords, W0_LIMITS.maxEntityRecords, parseEntityRecord);
  if (entityRecords === null) return null;
  const stateEvents = parseOptionalArray(world.stateEvents, W0_LIMITS.maxStateEvents, parseStateEvent);
  if (stateEvents === null) return null;
  const checkpoints = parseOptionalArray(world.checkpoints, W0_LIMITS.maxCheckpoints, parseWorldCheckpoint);
  if (checkpoints === null) return null;
  const playheads = parseOptionalArray(world.playheads, W0_LIMITS.maxStoryRuntimes, parsePlayheadState);
  if (playheads === null) return null;
  return {
    ...characterStates !== void 0 ? { characterStates } : {},
    ...characterMemories !== void 0 ? { characterMemories } : {},
    ...triggers !== void 0 ? { triggers } : {},
    ...storyRuntimes !== void 0 ? { storyRuntimes } : {},
    ...actions !== void 0 ? { actions } : {},
    ...outcomes !== void 0 ? { outcomes } : {},
    ...agentSessions !== void 0 ? { agentSessions } : {},
    ...roleplaySessions !== void 0 ? { roleplaySessions } : {},
    ...cardProfiles !== void 0 ? { cardProfiles } : {},
    ...cardSessions !== void 0 ? { cardSessions } : {},
    ...entryAnchors !== void 0 ? { entryAnchors } : {},
    ...travelSettings !== void 0 ? { travelSettings } : {},
    ...worldAgent !== void 0 ? { worldAgent } : {},
    // R5-01/R5-02：定义修订、实体目录与状态事件账本（可选集合；非法条目 → 整个世界拒绝）
    ...definitionRevisions !== void 0 ? { definitionRevisions } : {},
    ...entityRecords !== void 0 ? { entityRecords } : {},
    ...stateEvents !== void 0 ? { stateEvents } : {},
    ...checkpoints !== void 0 ? { checkpoints } : {},
    ...playheads !== void 0 ? { playheads } : {}
  };
}
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isString(v) {
  return typeof v === "string";
}
function isNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function normalizeEventIds(events) {
  const out = {};
  for (const [regionId, list] of Object.entries(events)) {
    if (!Array.isArray(list)) continue;
    out[regionId] = list.map(
      (e, i) => e && typeof e.id === "string" && e.id.length > 0 ? e : { ...e, id: `${regionId}__${i}` }
    );
  }
  return out;
}
function parseWorld(raw) {
  if (!isObject(raw)) return null;
  const normalizedEvents = raw.events && isObject(raw.events) ? normalizeEventIds(raw.events) : void 0;
  if (raw.schemaVersion !== SCHEMA_VERSION) return null;
  if (!isString(raw.id) || raw.id.length === 0) return null;
  if (!isString(raw.name)) return null;
  if (!isString(raw.description)) return null;
  if (raw.currentRegionId !== null && !isString(raw.currentRegionId)) return null;
  if (!isNumber(raw.currentYear)) return null;
  if (!isNumber(raw.createdAt)) return null;
  if (raw.mapImage !== void 0 && !isString(raw.mapImage)) return null;
  if (!isNumber(raw.updatedAt)) return null;
  if (raw.globalPrompt !== void 0 && !isString(raw.globalPrompt)) return null;
  if (raw.worldBible !== void 0) {
    if (!Array.isArray(raw.worldBible) || raw.worldBible.length > WORLD_BIBLE_MAX_ENTRIES) return null;
    for (const entry of raw.worldBible) {
      if (parseWorldBibleEntry(entry) === null) return null;
    }
  }
  if (raw.events !== void 0 && !isObject(raw.events)) return null;
  if (raw.characters !== void 0 && !Array.isArray(raw.characters)) return null;
  if (raw.regions !== void 0) {
    if (!Array.isArray(raw.regions)) return null;
    for (const r of raw.regions) {
      if (parseRegion(r) === null) return null;
    }
  }
  if (raw.points !== void 0) {
    if (!Array.isArray(raw.points)) return null;
    for (const p of raw.points) {
      if (parseMapPoint(p) === null) return null;
    }
  }
  if (raw.stories !== void 0) {
    if (!Array.isArray(raw.stories)) return null;
    for (const s of raw.stories) {
      if (parseStory(s) === null) return null;
    }
  }
  if (raw.readingProgress !== void 0) {
    if (raw.readingProgress === null) {
    } else if (!isObject(raw.readingProgress)) {
      return null;
    } else if (parseReadingProgress(raw.readingProgress) === null) {
      return null;
    }
  }
  const w0 = parseW0Collections(raw);
  if (w0 === null) return null;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: raw.id,
    name: raw.name,
    description: raw.description,
    ...Array.isArray(raw.connections) ? { connections: raw.connections } : {},
    ...isObject(raw.bindings) ? { bindings: raw.bindings } : {},
    ...Array.isArray(raw.points) ? { points: raw.points.map((p) => parseMapPoint(p)).filter((p) => p !== null) } : {},
    ...normalizedEvents ? { events: normalizedEvents } : {},
    ...Array.isArray(raw.characters) ? { characters: raw.characters } : {},
    ...Array.isArray(raw.regions) ? { regions: raw.regions.map((r) => parseRegion(r)).filter((r) => r !== null) } : {},
    ...Array.isArray(raw.stories) ? { stories: raw.stories.map((s) => parseStory(s)).filter((s) => s !== null) } : {},
    ...raw.readingProgress !== void 0 ? { readingProgress: raw.readingProgress === null ? null : parseReadingProgress(raw.readingProgress) } : {},
    ...isString(raw.mapImage) ? { mapImage: raw.mapImage } : {},
    ...isString(raw.globalPrompt) ? { globalPrompt: raw.globalPrompt } : {},
    ...Array.isArray(raw.worldBible) ? { worldBible: raw.worldBible.map((entry) => parseWorldBibleEntry(entry)).filter((entry) => entry !== null) } : {},
    ...w0 ? w0 : {},
    currentRegionId: raw.currentRegionId,
    currentYear: raw.currentYear,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };
}
function branchScopeForStory(world, storyId) {
  if (!storyId) return null;
  const story = (world.stories ?? []).find((s) => s.id === storyId);
  if (!story) return null;
  return story.mode === "if" ? story.id : null;
}
function characterStateFor(world, characterId, branchId) {
  const states = world.characterStates ?? [];
  if (branchId) {
    const override = states.find((s) => s.characterId === characterId && s.branchId === branchId);
    if (override) return override;
  }
  return states.find((s) => s.characterId === characterId && !s.branchId) ?? null;
}
function branchCharacterStates(world, branchId) {
  const states = world.characterStates ?? [];
  const baselines = states.filter((s) => !s.branchId);
  if (!branchId) return baselines.map((s) => ({ ...s }));
  const overrides = /* @__PURE__ */ new Map();
  for (const s of states) {
    if (s.branchId === branchId) overrides.set(s.characterId, s);
  }
  const merged = baselines.map((s) => {
    const override = overrides.get(s.characterId);
    if (!override) return { ...s };
    overrides.delete(s.characterId);
    return { ...override };
  });
  for (const override of overrides.values()) merged.push({ ...override });
  return merged;
}

// lib/world-cards.ts
function stableStringify(value) {
  if (value === null || value === void 0) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}
function hashString(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// lib/world-travel.ts
function getDefaultTravelBaseline() {
  return JSON.parse(JSON.stringify(DEFAULT_TRAVEL_BASELINE));
}
var FORBIDDEN_WORLD_AGENT_KEYS = [
  "storyId",
  "branchId",
  "steps",
  "runtime",
  "storyRuntimes",
  "actions",
  "outcomes",
  "characterStates",
  "characterMemories"
];
function worldAgentHasWritableStoryState(agent) {
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) return false;
  const obj = agent;
  return FORBIDDEN_WORLD_AGENT_KEYS.some((key) => key in obj);
}
function isValidWorldAgent(agent) {
  if (!agent || typeof agent !== "object") return false;
  if (typeof agent.id !== "string" || agent.id.length === 0) return false;
  if (typeof agent.worldId !== "string" || agent.worldId.length === 0) return false;
  if (!WORLD_AGENT_STATUSES.includes(agent.status)) return false;
  if (typeof agent.baselineVersion !== "string" || agent.baselineVersion.length === 0) return false;
  if (typeof agent.sourceRevision !== "string" || agent.sourceRevision.length === 0) return false;
  if (worldAgentHasWritableStoryState(agent)) return false;
  return true;
}
function computeWorldSourceRevision(world) {
  const bibleFingerprint = (entries) => entries.map((e) => ({ id: e.id, title: e.title, content: e.content, enabled: e.enabled ?? true }));
  const fingerprint = {
    globalPrompt: world.globalPrompt ?? null,
    worldBible: bibleFingerprint(world.worldBible ?? []),
    regionBooks: (world.regions ?? []).map((r) => ({
      id: r.id,
      book: bibleFingerprint(r.worldBook ?? [])
    })),
    pointBooks: (world.points ?? []).map((p) => ({
      id: p.id,
      book: bibleFingerprint(p.worldBook ?? [])
    })),
    regions: (world.regions ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      x: r.coordinates?.x ?? null,
      y: r.coordinates?.y ?? null
    })),
    points: (world.points ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      regionId: p.regionId ?? null
    })),
    characters: (world.characters ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      description: c.description
    })),
    travelSettings: world.travelSettings ?? null
  };
  return `rev-${hashString(stableStringify(fingerprint))}`;
}
function detectWorldAgentDrift(world) {
  const currentRevision = computeWorldSourceRevision(world);
  const storedRevision = world.worldAgent?.sourceRevision ?? null;
  return {
    stale: storedRevision !== null && storedRevision !== currentRevision,
    storedRevision,
    currentRevision
  };
}
function resolveTravelContext(world) {
  const baseline = getDefaultTravelBaseline();
  const agent = world.worldAgent ?? null;
  if (!agent) {
    return {
      status: "disabled",
      baseline,
      baselineVersion: baseline.version,
      worldAgent: null,
      worldAgentRevision: null,
      stale: false,
      reason: "当前世界没有世界 Agent，按默认移动提示基线游玩。"
    };
  }
  if (!isValidWorldAgent(agent)) {
    return {
      status: "disabled",
      baseline,
      baselineVersion: baseline.version,
      worldAgent: null,
      worldAgentRevision: null,
      stale: false,
      reason: "世界 Agent 配置不完整或不可用，已无条件回退默认移动提示基线。"
    };
  }
  const drift = detectWorldAgentDrift(world);
  const hasGuide = Boolean(agent.travelGuide && agent.travelGuide.content.trim().length > 0);
  let status;
  let reason;
  if (drift.stale) {
    status = "stale";
    reason = "世界资料已变化，世界 Agent 辅助待刷新；可继续使用旧版本，或显式刷新。";
  } else if (hasGuide) {
    status = "active";
    reason = "当前世界 Agent 可为所有故事提供世界观与旅行辅助。";
  } else if (agent.status === "optimizing") {
    status = "optimizing";
    reason = "正在生成世界辅助；其他故事仍可按默认基线游玩。";
  } else {
    status = "ready";
    reason = "世界 Agent 已建立来源清单，可供选择为辅助来源（暂无旅行辅助）。";
  }
  return {
    status,
    baseline,
    baselineVersion: baseline.version,
    worldAgent: agent,
    worldAgentRevision: agent.sourceRevision,
    stale: drift.stale,
    reason
  };
}

// lib/world-engine.ts
var DEFAULT_CLOCK_CONFIG = {
  /** 每天时段数（默认 4：晨 / 午 / 昏 / 夜） */
  periodsPerDay: 4,
  /** 每月天数 */
  daysPerMonth: 30,
  /** 每年月数 */
  monthsPerYear: 12
};
function normalizeClockConfig(cfg = DEFAULT_CLOCK_CONFIG) {
  return {
    periodsPerDay: Math.max(1, Math.floor(cfg.periodsPerDay)),
    daysPerMonth: Math.max(1, Math.floor(cfg.daysPerMonth)),
    monthsPerYear: Math.max(1, Math.floor(cfg.monthsPerYear))
  };
}
function toCalendar(totalPeriods, cfg = DEFAULT_CLOCK_CONFIG) {
  const c = normalizeClockConfig(cfg);
  const t = Math.max(0, Math.floor(totalPeriods));
  const perMonth = c.periodsPerDay * c.daysPerMonth;
  const perYear = perMonth * c.monthsPerYear;
  const year = Math.floor(t / perYear) + 1;
  const restYear = t % perYear;
  const month = Math.floor(restYear / perMonth) + 1;
  const restMonth = restYear % perMonth;
  const day = Math.floor(restMonth / c.periodsPerDay) + 1;
  const period = restMonth % c.periodsPerDay;
  return { year, month, day, period };
}
function formatCalendar(cal) {
  return `第 ${cal.year} 年 ${cal.month} 月 ${cal.day} 日 · 第 ${cal.period + 1} 时段`;
}
function gridDistance(ax, ay, bx, by) {
  return Math.round(Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2));
}
function computeDistance(ax, ay, bx, by, settings) {
  const cells = gridDistance(ax, ay, bx, by);
  if (!settings || settings.enabled !== true || !(settings.distancePerCell > 0)) {
    return { cells, value: null, unit: null, calibrated: false };
  }
  const value = Math.round(cells * settings.distancePerCell * 100) / 100;
  return { cells, value, unit: settings.distanceUnit, calibrated: true };
}
function resolveTerrainCue(keys, settings) {
  const factors = settings && settings.terrainFactors ? settings.terrainFactors : null;
  for (const key of keys) {
    if (factors && Object.prototype.hasOwnProperty.call(factors, key)) {
      const factor = factors[key];
      if (typeof factor === "number" && factor > 0) {
        return { key, label: `自定义地形「${key}」`, factor, source: "settings" };
      }
    }
  }
  const baseline = getDefaultTravelBaseline();
  const road = baseline.terrainTiers[0];
  return {
    key: keys[0] ?? "road",
    label: road ? road.label : "大道 / 平原",
    factor: road ? road.factor : 1,
    source: "baseline"
  };
}
function resolveSpeedTier(speedTierId) {
  const baseline = getDefaultTravelBaseline();
  if (speedTierId) {
    const hit = baseline.speedTiers.find((t) => t.id === speedTierId);
    if (hit) return hit;
  }
  const normal = baseline.speedTiers.find((t) => t.id === "normal");
  return normal ?? baseline.speedTiers[0] ?? null;
}
var DEFAULT_NEARBY_RADIUS = 12;
function findPoint(world, pointId) {
  if (!pointId) return null;
  return (world.points ?? []).find((p) => String(p.id) === pointId) ?? null;
}
function nearbyPoints(world, cx, cy, radius, excludePointId) {
  return (world.points ?? []).filter((p) => String(p.id) !== String(excludePointId ?? "")).filter((p) => gridDistance(cx, cy, p.x, p.y) <= radius).map((p) => String(p.id));
}
function buildTravelHint(world, input = {}) {
  const baseline = getDefaultTravelBaseline();
  const ctx = resolveTravelContext(world);
  const from = findPoint(world, input.fromPointId);
  const to = findPoint(world, input.toPointId);
  const via = (input.viaPointIds ?? []).map((id) => findPoint(world, id)).filter((p) => p !== null).map((p) => ({ pointId: String(p.id), name: p.name, x: p.x, y: p.y }));
  let cells = 0;
  if (from && to) {
    const legs = [];
    let prev = from;
    for (const v of via) {
      legs.push([prev.x, prev.y, v.x, v.y]);
      prev = { ...prev, x: v.x, y: v.y };
    }
    legs.push([prev.x, prev.y, to.x, to.y]);
    cells = legs.reduce((sum, [ax, ay, bx, by]) => sum + gridDistance(ax, ay, bx, by), 0);
  }
  const distance = from && to ? { ...computeDistance(from.x, from.y, to.x, to.y, world.travelSettings), cells } : { cells, value: null, unit: null, calibrated: false };
  const terrainKeys = [];
  if (from && to) terrainKeys.push(`${String(from.id)}->${String(to.id)}`);
  if (to?.regionId) terrainKeys.push(to.regionId);
  if (to) terrainKeys.push(String(to.id));
  const terrainCue = resolveTerrainCue(terrainKeys, world.travelSettings);
  const speedTier = resolveSpeedTier(input.speedTierId);
  const cellsPerPeriod = speedTier ? speedTier.cellsPerPeriod : 0;
  const rawPeriods = cellsPerPeriod > 0 ? cells * terrainCue.factor / cellsPerPeriod : 0;
  const suggestedPeriods = cells > 0 ? Math.max(1, Math.round(rawPeriods)) : 0;
  const suggestedDuration = speedTier && cells > 0 ? suggestedPeriods : null;
  const requiresAuthorConfirmation = !distance.calibrated;
  const abstractExpression = speedTier ? `约 ${cells} 格程 ÷ ${speedTier.label}（${cellsPerPeriod} 格/时段）${terrainCue.factor !== 1 ? ` × 地形 ${terrainCue.factor}` : ""} ≈ ${suggestedPeriods} 个时段` : `约 ${cells} 格程（无可用速度档，需作者确认时长）`;
  const distText = distance.calibrated ? `${distance.cells} 格 ≈ ${distance.value} ${distance.unit}` : `${distance.cells} 格程（地图未标定，不给真实里数）`;
  const basis = `网格距离 ${distText}；地形 ${terrainCue.label} ×${terrainCue.factor}；速度档 ${speedTier ? speedTier.label : "无"}。${requiresAuthorConfirmation ? "未标定地图，需作者确认。" : ""}`;
  const radius = typeof input.radius === "number" && input.radius > 0 ? input.radius : DEFAULT_NEARBY_RADIUS;
  const nearby = to ? nearbyPoints(world, to.x, to.y, Number(radius), String(to.id)) : [];
  const cues = [];
  if (from && to) {
    cues.push(`从「${from.name}」(${from.x},${from.y}) 到「${to.name}」(${to.x},${to.y})：${distText}`);
  } else {
    cues.push("起点或终点尚未选定，无法计算网格距离。");
  }
  if (via.length) cues.push(`途经：${via.map((v) => `「${v.name}」`).join(" → ")}`);
  cues.push(`地形：${terrainCue.label} ×${terrainCue.factor}（来源：${terrainCue.source === "settings" ? "地图设置" : "默认基线"}）`);
  cues.push(`速度档：${speedTier ? `${speedTier.label}（${cellsPerPeriod} 格/时段）` : "无"}`);
  cues.push(abstractExpression);
  if (nearby.length) cues.push(`附近地点（半径 ${radius} 格）：${nearby.length} 个`);
  const guide = ctx.worldAgent?.travelGuide;
  const worldAgentAssistApplied = Boolean(guide && guide.content.trim());
  if (worldAgentAssistApplied && guide) {
    cues.push(`世界 Agent 旅行辅助（revision ${ctx.worldAgentRevision}）：${guide.content.trim()}`);
    if (guide.assumptions && guide.assumptions.length) {
      cues.push(`辅助假设：${guide.assumptions.join("；")}`);
    }
  }
  if (input.storyId) {
    const branch = input.branchId ?? input.storyId;
    const runtime = (world.storyRuntimes ?? []).find((r) => r.storyId === branch) ?? (world.storyRuntimes ?? []).find((r) => r.storyId === input.storyId);
    if (runtime) {
      cues.push(`故事上下文：${formatCalendar(toCalendar(runtime.currentTime))}（第 ${runtime.currentTime} 时段）`);
    }
  }
  if (input.focusCardId) {
    const card = (world.cardProfiles ?? []).find((c) => c.id === input.focusCardId);
    cues.push(card ? `当前焦点卡：${card.summary ?? card.sourceCardId}` : `当前焦点卡：${input.focusCardId}（配置缺失）`);
  }
  return {
    baselineVersion: baseline.version,
    worldAgentRevision: ctx.worldAgentRevision,
    status: ctx.status,
    from: { pointId: from ? String(from.id) : null, name: from ? from.name : null, x: from ? from.x : null, y: from ? from.y : null },
    to: { pointId: to ? String(to.id) : null, name: to ? to.name : null, x: to ? to.x : null, y: to ? to.y : null },
    via,
    distance,
    speedTier: speedTier ? { id: speedTier.id, label: speedTier.label, cellsPerPeriod } : null,
    terrainCue,
    abstractExpression,
    suggestedPeriods,
    suggestedDuration,
    basis,
    requiresAuthorConfirmation,
    nearbyPointIds: nearby,
    cues,
    worldAgentAssistApplied
  };
}
function collectWorldBookIds(world, regionIds, pointIds) {
  const out = [];
  const push = (entries) => {
    for (const e of entries ?? []) {
      if (e.enabled === false) continue;
      out.push(e.id);
    }
  };
  push(world.worldBible);
  const regionSet = new Set(regionIds);
  for (const r of world.regions ?? []) if (regionSet.has(r.id)) push(r.worldBook);
  const pointSet = new Set(pointIds);
  for (const p of world.points ?? []) if (pointSet.has(String(p.id))) push(p.worldBook);
  return out;
}
function resolveActionSources(world, action, opts) {
  const radius = typeof opts?.radius === "number" && opts.radius > 0 ? opts.radius : 12;
  const regionIds = /* @__PURE__ */ new Set();
  const pointIds = /* @__PURE__ */ new Set();
  for (const id of [action.fromRegionId, action.toRegionId]) if (id) regionIds.add(id);
  for (const id of [action.fromPointId, action.toPointId]) if (id) pointIds.add(id);
  for (const id of action.viaPointIds ?? []) if (id) pointIds.add(id);
  for (const p of world.points ?? []) {
    if (pointIds.has(String(p.id)) && p.regionId) regionIds.add(p.regionId);
  }
  const anchorPointId = action.toPointId ?? action.fromPointId;
  const anchor = anchorPointId ? (world.points ?? []).find((p) => String(p.id) === anchorPointId) : null;
  const nearby = anchor ? nearbyPoints(world, anchor.x, anchor.y, radius, String(anchor.id)) : [];
  const characterIds = /* @__PURE__ */ new Set();
  for (const id of opts?.companionIds ?? []) if (id) characterIds.add(id);
  if (action.actorId) characterIds.add(action.actorId);
  const targetPoints = /* @__PURE__ */ new Set([...pointIds, ...nearby]);
  const branch = opts?.branchId ?? branchScopeForStory(world, opts?.storyId ?? null);
  for (const s of branchCharacterStates(world, branch)) {
    if (s.currentPointId && targetPoints.has(String(s.currentPointId))) characterIds.add(s.characterId);
  }
  const worldBookIds = collectWorldBookIds(world, [...regionIds], [...pointIds, ...nearby]);
  const triggerIds = [];
  for (const t of world.triggers ?? []) {
    if (t.enabled === false) continue;
    const scopeRegions = t.scopeRegionIds ?? [];
    const scopePoints = t.scopePointIds ?? [];
    const inScope = scopeRegions.length === 0 && scopePoints.length === 0 ? true : scopeRegions.some((id) => regionIds.has(id)) || scopePoints.some((id) => pointIds.has(id) || nearby.includes(id));
    if (inScope) triggerIds.push(t.id);
  }
  return {
    regionIds: [...regionIds],
    pointIds: [...pointIds],
    characterIds: [...characterIds],
    triggerIds,
    nearbyPointIds: nearby,
    radius,
    worldBookIds
  };
}
function triggerMatches(trigger, ctx) {
  if (trigger.enabled === false) return false;
  const cond = trigger.condition;
  if (!cond) return true;
  if (typeof cond.minTime === "number" && ctx.at < cond.minTime) return false;
  if (typeof cond.maxTime === "number" && ctx.at > cond.maxTime) return false;
  if (cond.regionId && ctx.regionId !== cond.regionId) return false;
  if (cond.pointId && ctx.pointId !== cond.pointId) return false;
  if (cond.characterIds && cond.characterIds.length > 0) {
    const present = new Set(ctx.characterIds);
    if (!cond.characterIds.some((id) => present.has(id))) return false;
  }
  if (cond.requiresFlag && !ctx.flags.includes(cond.requiresFlag)) return false;
  if (cond.forbidsFlag && ctx.flags.includes(cond.forbidsFlag)) return false;
  return true;
}
function selectTriggers(world, sources, ctx) {
  const allowed = new Set(sources.triggerIds);
  return (world.triggers ?? []).filter((t) => allowed.has(t.id) && triggerMatches(t, ctx));
}
function deriveActionSeed(world, storyId, actionCount, at) {
  const raw = `${world.id}|${storyId ?? "-"}|${actionCount}|${at}`;
  return parseInt(hashString(raw).slice(0, 8), 16) >>> 0;
}

// src/atlas-time-intent.ts
var TIME_WORD_TABLE = [
  { pattern: /一整天|整天|大半天/g, periods: 4 },
  { pattern: /半天|半日/g, periods: 3 },
  { pattern: /许久|半晌|好一会儿|好一阵/g, periods: 2 },
  { pattern: /一会儿|一会|片刻|良久/g, periods: 1 }
];
var ACTION_MARKER_PATTERN = /然后|接着|随后|而后|之后|再|又|最后|顺便/g;
function extractAtlasTimeIntent(userText) {
  const text = typeof userText === "string" ? userText : "";
  if (!text.trim()) {
    return { actionMarkers: [], estimatedActions: 0, timeWords: [], suggestedPeriods: null };
  }
  const actionMarkers = [];
  for (const match of text.matchAll(ACTION_MARKER_PATTERN)) {
    if (!actionMarkers.includes(match[0])) actionMarkers.push(match[0]);
  }
  const timeWords = [];
  let suggestedPeriods = null;
  for (const entry of TIME_WORD_TABLE) {
    for (const match of text.matchAll(entry.pattern)) {
      if (!timeWords.includes(match[0])) timeWords.push(match[0]);
      suggestedPeriods = suggestedPeriods === null ? entry.periods : Math.max(suggestedPeriods, entry.periods);
    }
  }
  return {
    actionMarkers,
    estimatedActions: actionMarkers.length > 0 ? actionMarkers.length + 1 : text.trim() ? 1 : 0,
    timeWords,
    suggestedPeriods
  };
}
function renderAtlasTimeHint(userText) {
  const intent = extractAtlasTimeIntent(userText);
  const parts = [];
  if (intent.actionMarkers.length > 0) {
    parts.push(`检测到约 ${intent.estimatedActions} 个连贯动作`);
  }
  if (intent.suggestedPeriods !== null) {
    parts.push(`时间词「${intent.timeWords.join("、")}」→ 至少 ${intent.suggestedPeriods} 时段`);
  }
  if (parts.length === 0) return null;
  return `〔时间估计〕${parts.join("；")}（校准 duration 时参考）`;
}

// src/atlas-adjudicate.ts
function knownEntityIds(world) {
  const ids = /* @__PURE__ */ new Set();
  for (const c of world.characters ?? []) ids.add(String(c.id));
  for (const e of world.entityRecords ?? []) ids.add(String(e.id));
  return ids;
}
function adjudicateAtlasDraft(world, input) {
  const draft = input.draft;
  const notes = [];
  const aiDuration = typeof draft.duration === "number" && Number.isFinite(draft.duration) && draft.duration >= 0 ? Math.floor(draft.duration) : 0;
  const rawEffects = Array.isArray(draft.rawEffects) ? [...draft.rawEffects] : [];
  const memoryDrafts = Array.isArray(draft.memoryDrafts) ? draft.memoryDrafts.map((m) => ({ entityId: String(m?.entityId ?? ""), text: String(m?.text ?? "") })) : [];
  const next = {
    duration: aiDuration,
    locationChange: draft.locationChange ?? null,
    rawEffects,
    memoryDrafts,
    summary: draft.summary,
    // 0.9.32 透传：新地点不在裁定范围（commit 时 sanitizeNewLocations 清洗 + 确定性并入），
    // 但重建 draft 时必须带上——此前被整组丢弃，回执永远不注明「新增地点」。
    ...Array.isArray(draft.newLocations) ? { newLocations: [...draft.newLocations] } : {}
  };
  const rawToPointId = next.locationChange && typeof next.locationChange.toPointId === "string" ? next.locationChange.toPointId.trim() : "";
  if (next.locationChange && rawToPointId) {
    const toPoint = (world.points ?? []).find((p) => String(p.id) === String(rawToPointId));
    if (!toPoint) {
      notes.push(`〔裁定〕忽略未知地点「${rawToPointId.slice(0, 32)}」的移动`);
      next.locationChange = null;
    } else if (input.currentPointId) {
      const hint = buildTravelHint(world, { fromPointId: String(input.currentPointId), toPointId: rawToPointId });
      const travelPeriods = Math.max(0, Math.round(hint.suggestedPeriods));
      if (travelPeriods > aiDuration) {
        notes.push(`〔裁定〕旅程 ${hint.distance.cells} 格 → 耗时 ${travelPeriods} 时段（网格算法；AI 给 ${aiDuration}）`);
        next.duration = travelPeriods;
      }
    }
  }
  if (input.userText) {
    const intent = extractAtlasTimeIntent(input.userText);
    if (intent.suggestedPeriods !== null && intent.suggestedPeriods > (next.duration ?? 0)) {
      notes.push(
        `〔裁定〕行动文本出现时间词「${intent.timeWords.join("、")}」→ 至少 ${intent.suggestedPeriods} 时段（AI 给 ${next.duration ?? 0}）`
      );
      next.duration = intent.suggestedPeriods;
    }
  }
  const hasChange = next.locationChange && (next.locationChange.toPointId || next.locationChange.toRegionId) || (next.rawEffects ?? []).length > 0 || (next.memoryDrafts ?? []).length > 0;
  if (hasChange && (next.duration ?? 0) < 1) {
    notes.push(`〔裁定〕有世界变化但 AI 给 0 时段 → 保底推进 1 时段`);
    next.duration = 1;
  }
  const known = knownEntityIds(world);
  const beforeEffects = rawEffects.length;
  next.rawEffects = rawEffects.filter((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return true;
    const record = raw;
    if (record.kind === "moveEntity") {
      const pointId = typeof record.pointId === "string" ? record.pointId.trim() : "";
      const regionId = typeof record.regionId === "string" ? record.regionId.trim() : "";
      const pointKnown = !pointId || (world.points ?? []).some((p) => String(p.id) === String(pointId));
      const regionKnown = !regionId || (world.regions ?? []).some((r) => String(r.id) === String(regionId));
      if (!pointKnown || !regionKnown) {
        notes.push(`〔裁定〕忽略引用未知${!pointKnown ? "地点" : "地区"}的人物移动`);
        return false;
      }
    }
    const entityId = record.entityId;
    if (typeof entityId !== "string" || entityId.trim() === "") return true;
    return known.has(entityId.trim());
  });
  next.rawEffects = next.rawEffects ?? [];
  const droppedEffects = beforeEffects - (next.rawEffects ?? []).length;
  if (droppedEffects > 0) notes.push(`〔裁定〕丢弃 ${droppedEffects} 条引用未知实体的变化`);
  const beforeMemories = memoryDrafts.length;
  next.memoryDrafts = memoryDrafts.filter(
    (m) => m.entityId.trim() !== "" && m.text.trim() !== "" && known.has(m.entityId.trim())
  );
  next.memoryDrafts = next.memoryDrafts ?? [];
  const droppedMemories = beforeMemories - (next.memoryDrafts ?? []).length;
  if (droppedMemories > 0) notes.push(`〔裁定〕丢弃 ${droppedMemories} 条未知实体的记忆`);
  if (notes.length > 0) {
    const base = next.summary.trim();
    const merged = `${base}${base ? "；" : ""}${notes.join("；")}`;
    next.summary = merged.slice(0, W0_LIMITS.maxStateEventSummary);
  }
  return { draft: next, notes };
}

// lib/world-npc.ts
function resolveCharacterPosition(world, characterId, opts = {}) {
  const state = characterStateFor(world, characterId, opts.branchId ?? null);
  if (state) {
    return {
      characterId,
      regionId: state.currentRegionId ?? null,
      pointId: state.currentPointId ?? null,
      source: "state",
      scope: state.branchId ? "branch" : "canon",
      branchId: state.branchId ?? null
    };
  }
  const legacy = (world.characters ?? []).find((c) => c.id === characterId);
  if (legacy) {
    return {
      characterId,
      regionId: legacy.currentRegionId ?? null,
      pointId: null,
      source: "legacy",
      scope: "legacy",
      branchId: null
    };
  }
  return { characterId, regionId: null, pointId: null, source: "none", scope: "none", branchId: null };
}
function pointBelongsToRegion(world, pointId, regionId) {
  const p = (world.points ?? []).find((x) => String(x.id) === String(pointId));
  if (!p) return false;
  return (p.regionId ?? null) === (regionId ?? null);
}
function moveCharacterTo(world, characterId, regionId, pointId, now = 0, opts = {}) {
  if (!(world.characters ?? []).some((c) => c.id === characterId)) {
    return { world, ok: false, reason: `人物 ${characterId} 不存在，未移动。` };
  }
  if (regionId && !(world.regions ?? []).some((r) => r.id === regionId)) {
    return { world, ok: false, reason: `地区 ${regionId} 不存在，未移动（避免写入悬空引用）。` };
  }
  if (pointId) {
    if (!(world.points ?? []).some((p) => String(p.id) === String(pointId))) {
      return { world, ok: false, reason: `地点 ${pointId} 不存在，未移动。` };
    }
    if (!pointBelongsToRegion(world, pointId, regionId)) {
      return {
        world,
        ok: false,
        reason: `地点 ${pointId} 不属于地区 ${regionId ?? "未指定"}，未移动（地点与地区必须一致）。`
      };
    }
  }
  const branchId = opts.branchId ?? null;
  const states = [...world.characterStates ?? []];
  const idx = states.findIndex(
    (s) => s.characterId === characterId && (branchId ? s.branchId === branchId : !s.branchId)
  );
  const patch = {
    characterId,
    currentRegionId: regionId ?? null,
    currentPointId: pointId ?? null,
    updatedAt: now,
    ...branchId ? { branchId } : {}
  };
  if (idx >= 0) {
    const prev = states[idx];
    states[idx] = { ...prev, ...patch, ...prev.status !== void 0 ? { status: prev.status } : {} };
  } else {
    states.push(patch);
  }
  return { world: { ...world, characterStates: states }, ok: true, reason: "已移动。" };
}
function charactersAtPoint(world, pointId, opts = {}) {
  const target = String(pointId);
  return (world.characters ?? []).map((c) => c.id).filter((id) => {
    const pos = resolveCharacterPosition(world, id, opts);
    return pos.pointId !== null && String(pos.pointId) === target;
  });
}
function charactersInRegion(world, regionId, opts = {}) {
  return (world.characters ?? []).map((c) => c.id).filter((id) => resolveCharacterPosition(world, id, opts).regionId === regionId);
}

// src/atlas-schedule.ts
var DEFAULT_PERIODS_PER_DAY = 12;
var MIN_PERIODS_PER_DAY = 1;
var MAX_PERIODS_PER_DAY = 72;
var MAX_ROUTINE_SEGMENTS = 12;
function periodsPerDayOf(world) {
  const cfg = (world.entityRecords ?? []).find((r) => r.type === "world");
  const raw = cfg?.baseline["periodsPerDay"];
  if (typeof raw === "number" && Number.isFinite(raw) && Number.isInteger(raw) && raw >= MIN_PERIODS_PER_DAY && raw <= MAX_PERIODS_PER_DAY) {
    return raw;
  }
  return DEFAULT_PERIODS_PER_DAY;
}
function parseRoutineSegments(raw) {
  if (!Array.isArray(raw)) return [];
  const segments = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.length === 0 || item.length > 200) continue;
    const match = /^(\d+)-(\d+):(.+)$/.exec(item.trim());
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const pointId = match[3].trim();
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 0 || end <= start || pointId === "") continue;
    segments.push({ start, end, pointId });
    if (segments.length >= MAX_ROUTINE_SEGMENTS) break;
  }
  return segments;
}
function routineFor(world, characterId) {
  const record = (world.entityRecords ?? []).find((r) => String(r.id) === String(characterId));
  if (!record) return [];
  return parseRoutineSegments(record.baseline["routine"]);
}
function routinePointAt(segments, periodOfDay) {
  for (const seg of segments) {
    if (periodOfDay >= seg.start && periodOfDay < seg.end) return seg.pointId;
  }
  return null;
}
var PROTAGONIST_ROLES = /* @__PURE__ */ new Set(["protagonist", "主角", "player", "玩家", "user", "observer", "观察者"]);
function isProtagonistRole(role) {
  if (typeof role !== "string") return false;
  return PROTAGONIST_ROLES.has(role.trim().toLowerCase()) || PROTAGONIST_ROLES.has(role.trim());
}
function settleNpcSchedules(world, input) {
  const prevTime = Math.max(0, Math.floor(input.prevTime));
  const newTime = Math.max(prevTime, Math.floor(input.newTime));
  const periodsPerDay = periodsPerDayOf(world);
  const knownPointIds = new Set((world.points ?? []).map((p) => String(p.id)));
  const nameOf = (id) => (world.characters ?? []).find((c) => String(c.id) === String(id))?.name ?? id;
  const playerAt = (at) => {
    if (input.playerToPointId) {
      return at === newTime ? input.playerToPointId : null;
    }
    return input.playerFromPointId;
  };
  const characters = (world.characters ?? []).filter((c) => !isProtagonistRole(c.role));
  const hasRoutineRecord = new Set(
    (world.entityRecords ?? []).filter((r) => characters.some((c) => String(c.id) === String(r.id))).map((r) => String(r.id))
  );
  const isNpcRole = (id) => {
    const role = (world.characters ?? []).find((c) => String(c.id) === String(id))?.role;
    return typeof role === "string" && role.trim().toLowerCase() === "npc";
  };
  const isEncounterCandidate = (id) => hasRoutineRecord.has(id) || isNpcRole(id);
  const positions = /* @__PURE__ */ new Map();
  for (const c of characters) {
    const pos = resolveCharacterPosition(world, String(c.id), { branchId: input.branchId });
    positions.set(String(c.id), { regionId: pos.regionId, pointId: pos.pointId });
  }
  const routines = /* @__PURE__ */ new Map();
  const droppedUnknownPoints = /* @__PURE__ */ new Map();
  for (const c of characters) {
    const id = String(c.id);
    const segments = routineFor(world, id).filter((seg) => {
      if (knownPointIds.has(seg.pointId)) return true;
      droppedUnknownPoints.set(seg.pointId, id);
      return false;
    });
    routines.set(id, segments);
  }
  const working = world;
  let current = working;
  const moves = [];
  const encounters = [];
  const seenEncounters = /* @__PURE__ */ new Set();
  const now = input.now ?? 0;
  for (let at = prevTime + 1; at <= newTime; at += 1) {
    const periodOfDay = (at % periodsPerDay + periodsPerDay) % periodsPerDay;
    for (const c of characters) {
      const id = String(c.id);
      const segments = routines.get(id) ?? [];
      if (segments.length === 0) continue;
      const target = routinePointAt(segments, periodOfDay);
      const pos = positions.get(id);
      if (!target || target === pos.pointId) continue;
      const point = (world.points ?? []).find((p) => String(p.id) === String(target));
      const regionId = point?.regionId ?? null;
      const fromPointId = pos.pointId;
      const moved = moveCharacterTo(current, id, regionId ?? null, target, now, { branchId: input.branchId });
      if (moved.ok) {
        current = moved.world;
        pos.regionId = regionId ?? null;
        pos.pointId = target;
        moves.push({ characterId: id, characterName: nameOf(id), pointId: target, fromPointId, periodOfDay });
      }
    }
    const playerPointId = playerAt(at);
    if (!playerPointId) continue;
    for (const c of characters) {
      const id = String(c.id);
      if (!isEncounterCandidate(id)) continue;
      const pos = positions.get(id);
      if (!pos.pointId || String(pos.pointId) !== String(playerPointId)) continue;
      const key = `${id}:${pos.pointId}`;
      if (seenEncounters.has(key)) continue;
      seenEncounters.add(key);
      encounters.push({ characterId: id, characterName: nameOf(id), pointId: pos.pointId, at });
    }
  }
  const notes = [];
  for (const unknownPoint of droppedUnknownPoints.keys()) {
    notes.push(`〔日程〕忽略日程里的未知地点「${unknownPoint.slice(0, 32)}」`);
  }
  if (moves.length > 0) {
    const detail = moves.slice(0, 6).map((m) => `${m.characterName} 从「${(m.fromPointId ?? "?").slice(0, 24)}」到「${m.pointId.slice(0, 24)}」（日内第 ${m.periodOfDay} 时段）`).join("；");
    notes.push(`〔日程〕${moves.length} 次 NPC 日常移动：${detail}${moves.length > 6 ? "…" : ""}`);
  }
  if (encounters.length > 0) {
    const detail = encounters.slice(0, 6).map((e) => `${e.characterName} 在「${e.pointId.slice(0, 24)}」相遇（时段 ${e.at}）`).join("；");
    notes.push(`〔日程〕同段同地遭遇：${detail}${encounters.length > 6 ? "…" : ""}`);
  }
  return { world: current, moves, encounters, notes };
}
function mergeSettlementNotes(summary, notes) {
  if (notes.length === 0) return summary;
  const base = summary.trim();
  const merged = `${base}${base ? "；" : ""}${notes.join("；")}`;
  return merged.slice(0, W0_LIMITS.maxStateEventSummary);
}

// src/atlas-content-replace.ts
var DEFAULT_CONTENT_REPLACE_RULES = [
  { name: "思考段 thinking", start: "<thinking", end: "</thinking>", enabled: true, builtin: true },
  { name: "思考段 think", start: "<think", end: "</think>", enabled: true, builtin: true },
  { name: "思考段 thought", start: "<thought", end: "</thought>", enabled: true, builtin: true },
  { name: "免责声明", start: "<disclaimer", end: "</disclaimer>", enabled: true, builtin: true },
  { name: "JSON 补丁", start: "<JSONPatch", end: "</JSONPatch>", enabled: true, builtin: true },
  { name: "分析段", start: "<Analysis", end: "</Analysis>", enabled: true, builtin: true },
  { name: "变量更新", start: "<UpdateVariable", end: "</UpdateVariable>", enabled: true, builtin: true },
  { name: "吐槽段", start: "<tucao", end: "</tucao>", enabled: true, builtin: true },
  { name: "状态栏占位", start: "<StatusPlaceHolderImpl", end: "</StatusPlaceHolderImpl>", enabled: true, builtin: true },
  { name: "摘要段", start: "<summary", end: "</summary>", enabled: true, builtin: true },
  { name: "选项段", start: "<options", end: "</options>", enabled: true, builtin: true },
  { name: "复盘段", start: "<review", end: "</review>", enabled: true, builtin: true },
  { name: "润色段", start: "<refine", end: "</refine>", enabled: true, builtin: true },
  { name: "DM 校验段", start: "<dm_check", end: "</dm_check>", enabled: true, builtin: true },
  { name: "补充段", start: "<supplement", end: "</supplement>", enabled: true, builtin: true }
];
var MAX_REPLACE_RULES = 50;
var MAX_RULE_NAME_CHARS = 64;
var MAX_RULE_BOUNDARY_CHARS = 256;
function removeAllMatchedBoundaries(text, startBoundary, endBoundary) {
  const source = String(text ?? "");
  const start = String(startBoundary || "");
  const end = String(endBoundary || "");
  if (!source || !start || !end) return source;
  const lowerSource = source.toLowerCase();
  const lowerStart = start.toLowerCase();
  const lowerEnd = end.toLowerCase();
  const openStartIndexes = [];
  const matchedRanges = [];
  let searchIndex = 0;
  while (searchIndex < lowerSource.length) {
    const nextStartIdx = lowerSource.indexOf(lowerStart, searchIndex);
    const nextEndIdx = lowerSource.indexOf(lowerEnd, searchIndex);
    if (nextStartIdx === -1 && nextEndIdx === -1) break;
    const isStartBoundary = nextStartIdx !== -1 && (nextEndIdx === -1 || nextStartIdx <= nextEndIdx);
    if (isStartBoundary) {
      openStartIndexes.push(nextStartIdx);
      searchIndex = nextStartIdx + lowerStart.length;
      continue;
    }
    if (openStartIndexes.length > 0) {
      const matchedStartIdx = openStartIndexes.pop();
      const matchedEndIdx = nextEndIdx + lowerEnd.length;
      if (matchedEndIdx > matchedStartIdx) {
        matchedRanges.push({ start: matchedStartIdx, end: matchedEndIdx });
      }
    }
    searchIndex = nextEndIdx + lowerEnd.length;
  }
  if (matchedRanges.length === 0) return source;
  matchedRanges.sort((left, right) => left.start - right.start || left.end - right.end);
  const mergedRanges = [];
  matchedRanges.forEach((range) => {
    const previousRange = mergedRanges[mergedRanges.length - 1];
    if (!previousRange || range.start > previousRange.end) {
      mergedRanges.push({ ...range });
      return;
    }
    previousRange.end = Math.max(previousRange.end, range.end);
  });
  let result = source;
  for (let rangeIndex = mergedRanges.length - 1; rangeIndex >= 0; rangeIndex--) {
    const range = mergedRanges[rangeIndex];
    result = result.slice(0, range.start) + result.slice(range.end);
  }
  return result;
}
function applyContentReplaceRules(text, rules) {
  let result = String(text ?? "");
  if (!result) return result;
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    const start = String(rule.start ?? "").trim();
    const end = String(rule.end ?? "").trim();
    if (!start || !end) continue;
    result = removeAllMatchedBoundaries(result, start, end);
  }
  return result.replace(/\n{3,}/g, "\n\n").trim();
}
function normalizeContentReplaceRules(raw) {
  const normalized = [];
  const seenIds = /* @__PURE__ */ new Set();
  const seenPairs = /* @__PURE__ */ new Set();
  if (!Array.isArray(raw)) return normalized;
  for (const entry of raw.slice(0, MAX_REPLACE_RULES * 2)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry;
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim().slice(0, 128) : null;
    const name = typeof record.name === "string" && record.name.trim() ? record.name.trim().slice(0, MAX_RULE_NAME_CHARS) : null;
    const start = typeof record.start === "string" ? record.start.trim().slice(0, MAX_RULE_BOUNDARY_CHARS) : "";
    const end = typeof record.end === "string" ? record.end.trim().slice(0, MAX_RULE_BOUNDARY_CHARS) : "";
    if (!id || !name || !start || !end) continue;
    if (seenIds.has(id)) continue;
    const pairKey = `${start}\0${end}`;
    if (seenPairs.has(pairKey)) continue;
    seenIds.add(id);
    seenPairs.add(pairKey);
    normalized.push({
      id,
      name,
      start,
      end,
      enabled: record.enabled !== false,
      ...record.builtin === true ? { builtin: true } : {}
    });
  }
  return normalized.slice(0, MAX_REPLACE_RULES);
}

// lib/world-definition.ts
function latestRevision(world) {
  const list = world.definitionRevisions ?? [];
  return list.length > 0 ? list[list.length - 1] : null;
}
function latestDefinitionRevision(world) {
  return latestRevision(world);
}
function captureDefinitionSnapshot(world) {
  const snapshot = {
    worldBible: JSON.parse(JSON.stringify(world.worldBible ?? [])),
    regions: JSON.parse(JSON.stringify(world.regions ?? [])),
    points: JSON.parse(JSON.stringify(world.points ?? [])),
    globalPrompt: world.globalPrompt ?? null,
    triggers: JSON.parse(JSON.stringify(world.triggers ?? [])),
    entities: JSON.parse(JSON.stringify(world.entityRecords ?? [])),
    contentHash: ""
  };
  snapshot.contentHash = `defsnap-${hashString(JSON.stringify(snapshot))}`;
  return snapshot;
}
function definitionRevisionFor(world, at, branchId = null) {
  const candidates = (world.definitionRevisions ?? []).filter((r) => (r.effectiveAt ?? 0) <= at).filter((r) => !r.effectiveBranchId || r.effectiveBranchId === branchId);
  if (candidates.length === 0) {
    const anyRevision = (world.definitionRevisions ?? [])[0] ?? null;
    return {
      revision: anyRevision,
      approx: true,
      reason: anyRevision ? `世界时刻 ${at} 早于最早的定义生效点（最早 effectiveAt=${anyRevision.effectiveAt ?? 0}）；使用最早修订并标注近似` : "世界没有任何定义修订记录；实体基线以当前资料为准并标注近似"
    };
  }
  const selected = [...candidates].sort((a, b) => {
    const ea = a.effectiveAt ?? 0;
    const eb = b.effectiveAt ?? 0;
    if (ea !== eb) return ea - eb;
    return a.createdAt - b.createdAt;
  }).pop() ?? null;
  return { revision: selected, approx: false, reason: null };
}
function appendDefinitionRevision(world, opts) {
  const note = opts.authorNote.trim();
  if (!note) return { ok: false, error: "修订说明不能为空" };
  if (note.length > W0_LIMITS.maxRevisionNote) {
    return { ok: false, error: `修订说明超过上限 ${W0_LIMITS.maxRevisionNote} 字` };
  }
  const list = world.definitionRevisions ?? [];
  if (list.length >= W0_LIMITS.maxDefinitionRevisions) {
    return { ok: false, error: `定义修订数量已达上限（${W0_LIMITS.maxDefinitionRevisions}）；请先归档或压缩历史` };
  }
  const knownEntityIds2 = new Set((world.entityRecords ?? []).map((e) => e.id));
  for (const entityId of opts.changedEntityIds ?? []) {
    if (!knownEntityIds2.has(entityId)) {
      return { ok: false, error: `修订引用了不存在的实体：${entityId}` };
    }
  }
  if (opts.effectiveAt !== void 0 && (!Number.isFinite(opts.effectiveAt) || opts.effectiveAt < 0)) {
    return { ok: false, error: "生效时间必须是非负的世界内时间" };
  }
  if (opts.effectiveBranchId && !(world.stories ?? []).some((st) => st.id === opts.effectiveBranchId)) {
    return { ok: false, error: `生效分支不存在：${opts.effectiveBranchId}` };
  }
  const parent = latestRevision(world);
  const revision = {
    id: `defrev-${hashString(`${world.id}|${list.length}|${note}|${opts.now}`)}`,
    worldId: world.id,
    createdAt: opts.now,
    authorNote: note,
    ...opts.changedEntityIds?.length ? { entityBaselineRefs: [...opts.changedEntityIds] } : {},
    ...parent ? { parentRevisionId: parent.id } : {},
    ...opts.isRetcon ? { isRetcon: true } : {},
    effectiveAt: opts.effectiveAt ?? 0,
    ...opts.effectiveBranchId ? { effectiveBranchId: opts.effectiveBranchId } : {},
    snapshot: captureDefinitionSnapshot(world)
  };
  return { ok: true, value: { ...world, definitionRevisions: [...list, revision] } };
}
function entityRecordById(world, entityId) {
  return (world.entityRecords ?? []).find((e) => e.id === entityId) ?? null;
}
function validateEntity(world, entity) {
  if (entity.worldId !== world.id) return "实体的 worldId 与当前世界不一致";
  if (!entity.type.trim()) return "实体类型不能为空";
  if (!entity.name.trim()) return "实体名称不能为空";
  const keys = /* @__PURE__ */ new Set();
  for (const field of entity.temporalSchema) {
    if (keys.has(field.key)) return `字段声明重复：${field.key}`;
    keys.add(field.key);
  }
  for (const key of Object.keys(entity.baseline)) {
    const declared = entity.temporalSchema.find((f) => f.key === key);
    if (!declared) return `基线字段 ${key} 未在字段声明中登记`;
    if (declared.kind === "temporal") {
      return `字段 ${key} 是时态字段：其值只能由「登记世界变化」产生（R5-02 账本），不能写进基线。如确属设定修订，请改为 base 字段或通过定义修订调整声明`;
    }
    const value = entity.baseline[key];
    if (declared.valueType === "string" && typeof value !== "string") return `字段 ${key} 应为字符串`;
    if (declared.valueType === "number" && typeof value !== "number") return `字段 ${key} 应为数字`;
    if (declared.valueType === "boolean" && typeof value !== "boolean") return `字段 ${key} 应为布尔值`;
    if (declared.valueType === "string[]" && !(Array.isArray(value) && value.every((v) => typeof v === "string"))) {
      return `字段 ${key} 应为字符串数组`;
    }
  }
  for (const temporal of entity.temporalSchema.filter((f) => f.kind === "temporal")) {
    if (temporal.key in entity.baseline) {
      return `时态字段 ${temporal.key} 不能有基线值`;
    }
  }
  if (entity.mapAnchor?.regionId && !(world.regions ?? []).some((r) => r.id === entity.mapAnchor?.regionId)) {
    return `地图锚点引用了不存在的地区：${entity.mapAnchor.regionId}`;
  }
  if (entity.mapAnchor?.pointId && !(world.points ?? []).some((p) => String(p.id) === String(entity.mapAnchor?.pointId))) {
    return `地图锚点引用了不存在的地点：${entity.mapAnchor.pointId}`;
  }
  return null;
}
function upsertEntityRecord(world, entity, opts = { now: 0 }) {
  const invalid = validateEntity(world, entity);
  if (invalid) return { ok: false, error: invalid };
  const list = world.entityRecords ?? [];
  if (!list.some((e) => e.id === entity.id) && list.length >= W0_LIMITS.maxEntityRecords) {
    return { ok: false, error: `实体数量已达上限（${W0_LIMITS.maxEntityRecords}）` };
  }
  const exists = list.some((e) => e.id === entity.id);
  const existing = list.find((e) => e.id === entity.id);
  const stamped = {
    ...entity,
    ...existing ? { createdAt: existing.createdAt ?? opts.now } : { createdAt: opts.now },
    updatedAt: opts.now
  };
  const next = exists ? list.map((e) => e.id === entity.id ? stamped : e) : [...list, stamped];
  return { ok: true, value: { ...world, entityRecords: next } };
}

// lib/world-lineage.ts
function resolveForkAt(world, branchId) {
  const story = (world.stories ?? []).find((s) => s.id === branchId);
  if (!story) return { at: null, basis: "unknown" };
  if (story.ifOrigin?.anchorAt !== void 0 && story.ifOrigin?.anchorAt !== null) {
    return { at: story.ifOrigin.anchorAt, basis: "fork-anchor" };
  }
  const divergenceId = story.divergenceEventId;
  if (divergenceId) {
    for (const list of Object.values(world.events ?? {})) {
      for (const event of list ?? []) {
        if (event.id === divergenceId) {
          const at = Number(event.year);
          if (Number.isFinite(at)) return { at, basis: "fork-anchor" };
        }
      }
    }
  }
  return { at: null, basis: "unknown" };
}
function branchLineage(world, branchId, at) {
  const segments = [];
  const reasons = [];
  let approx = false;
  const chain = [];
  let current = branchId;
  for (let depth = 0; current !== null && depth < W0_LIMITS.maxStoryRuntimes; depth += 1) {
    const story = (world.stories ?? []).find((s) => s.id === current);
    if (!story || story.mode === "canon") break;
    const fork = resolveForkAt(world, current);
    if (fork.at === null) {
      approx = true;
      reasons.push(`分支 ${current} 无法确定 fork 锚点：祖先账本只能按查看时刻截断（可能泄露分歧后的未来）`);
    }
    chain.push({ branchId: current, cutoffAt: fork.at, basis: fork.basis });
    const parent = story?.parentStoryId ?? story?.ifOrigin?.sourceStoryId ?? null;
    if (parent === current) break;
    current = parent;
  }
  if (branchId !== null && chain.length === 0) {
    approx = true;
    reasons.push(`分支 ${branchId} 不是已知的 IF 线（mode 非 if 或不存在）`);
  }
  const ancestorCutoff = (forkAt, basis) => {
    if (forkAt === null) return { cutoffAt: at, basis: "unknown" };
    const bounded = Math.min(forkAt, at);
    return { cutoffAt: bounded, basis: basis === "unknown" ? "unknown" : bounded < at ? "fork-anchor" : "projection-end" };
  };
  const nearestCanonFork = chain.length > 0 ? chain[chain.length - 1] : null;
  if (nearestCanonFork) {
    const cut = ancestorCutoff(nearestCanonFork.cutoffAt, nearestCanonFork.basis);
    segments.push({ branchId: null, cutoffAt: cut.cutoffAt, basis: cut.basis });
  } else {
    segments.push({ branchId: null, cutoffAt: at, basis: "projection-end" });
  }
  for (let i = chain.length - 1; i >= 1; i -= 1) {
    const childFork = chain[i - 1];
    const cut = ancestorCutoff(childFork.cutoffAt, childFork.basis);
    segments.push({ branchId: chain[i].branchId, cutoffAt: cut.cutoffAt, basis: cut.basis });
  }
  if (chain.length > 0) {
    segments.push({ branchId: chain[0].branchId, cutoffAt: at, basis: "projection-end" });
  }
  return { segments, approx, reasons };
}

// lib/world-ledger.ts
var SOURCE_PRIORITY = {
  author: 0,
  action: 1,
  "ai-adopted": 2
};
function stateEventsOf(world) {
  return world.stateEvents ?? [];
}
function isCanonLedgerBranch(world, branchId) {
  if (branchId === null) return true;
  const story = (world.stories ?? []).find((st) => st.id === branchId);
  return story?.mode === "canon";
}
function nextSequence(world, branchId, at) {
  const sameMoment = stateEventsOf(world).filter((e) => e.branchId === branchId && e.at === at).map((e) => e.sequence);
  return sameMoment.length > 0 ? Math.max(...sameMoment) + 1 : 0;
}
function compareStateEvents(a, b) {
  if (a.at !== b.at) return a.at - b.at;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  const pa = SOURCE_PRIORITY[a.source] ?? 3;
  const pb = SOURCE_PRIORITY[b.source] ?? 3;
  if (pa !== pb) return pa - pb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function ledgerForBranch(world, branchId) {
  const canon = isCanonLedgerBranch(world, branchId) && branchId !== null ? null : branchId;
  return stateEventsOf(world).filter((e) => canon === null ? isCanonLedgerBranch(world, e.branchId) : e.branchId === canon).sort(compareStateEvents);
}
function validateEffect(world, effect, entityIds) {
  const entityOf = (id) => entityRecordById(world, id);
  const requireEntity = (id) => {
    if (!entityIds.has(id)) return `实体不存在：${id}`;
    return null;
  };
  switch (effect.kind) {
    case "setTemporalField": {
      const issue = requireEntity(effect.entityId);
      if (issue) return issue;
      const entity = entityOf(effect.entityId);
      const declared = entity?.temporalSchema.find((f) => f.key === effect.key);
      if (!declared) return `实体 ${effect.entityId} 未声明字段 ${effect.key}`;
      if (declared.kind !== "temporal" && declared.kind !== "private") {
        return `字段 ${effect.key} 不可由账本改写（${declared.kind}；仅 temporal / private 可变）`;
      }
      const value = effect.value;
      const typeOk = declared.valueType === "string" && typeof value === "string" || declared.valueType === "number" && typeof value === "number" || declared.valueType === "boolean" && typeof value === "boolean" || declared.valueType === "string[]" && Array.isArray(value) && value.every((v) => typeof v === "string");
      if (!typeOk) return `字段 ${effect.key} 的值类型应为 ${declared.valueType}`;
      return null;
    }
    case "moveEntity": {
      const issue = requireEntity(effect.entityId);
      if (issue) return issue;
      if (effect.regionId && !(world.regions ?? []).some((r) => r.id === effect.regionId)) {
        return `移动目标地区不存在：${effect.regionId}`;
      }
      if (effect.pointId && !(world.points ?? []).some((p) => String(p.id) === String(effect.pointId))) {
        return `移动目标地点不存在：${effect.pointId}`;
      }
      return null;
    }
    case "adjustRelation": {
      const issue = requireEntity(effect.entityId);
      if (issue) return issue;
      const issue2 = requireEntity(effect.targetEntityId);
      if (issue2) return issue2;
      if (!isFinite(Number(effect.value))) return `关系值必须是有限数字或字符串`;
      return null;
    }
    case "addTag": {
      const issue = requireEntity(effect.entityId);
      if (issue) return issue;
      const entity = entityOf(effect.entityId);
      const declared = entity?.temporalSchema.find((f) => f.key === "tags");
      if (!declared) return `实体 ${effect.entityId} 未声明 tags 字段`;
      return null;
    }
    case "removeTag": {
      const issue = requireEntity(effect.entityId);
      if (issue) return issue;
      return null;
    }
    case "appendMemoryRef": {
      const issue = requireEntity(effect.entityId);
      if (issue) return issue;
      if (!effect.memoryId && !effect.text) return "记忆引用必须带 memoryId 或 text";
      return null;
    }
    case "attachNarrativeEntry": {
      const issue = requireEntity(effect.entityId);
      if (issue) return issue;
      return null;
    }
    case "closeNarrativeEntry": {
      const issue = requireEntity(effect.entityId);
      if (issue) return issue;
      return null;
    }
    case "setFlag": {
      return null;
    }
  }
}
function validateStateEvent(world, event) {
  const errors = [];
  const entityIds = new Set((world.entityRecords ?? []).map((e) => e.id));
  const knownEventIds = new Set(stateEventsOf(world).map((e) => e.id));
  for (const ref of event.entityRefs) {
    if (!entityIds.has(ref)) errors.push(`受影响实体不存在：${ref}`);
  }
  for (const effect of event.effects) {
    const issue = validateEffect(world, effect, entityIds);
    if (issue) errors.push(`${effect.kind}：${issue}`);
  }
  if (event.reversesEventId && !knownEventIds.has(event.reversesEventId)) {
    errors.push(`撤销目标事件不存在：${event.reversesEventId}`);
  }
  if (event.branchId && !(world.stories ?? []).some((s) => s.id === event.branchId)) {
    errors.push(`分支不存在：${event.branchId}`);
  }
  return errors;
}
function stateEventContentId(world, input) {
  return `stsev-${hashString(`${world.id}|${input.branchId ?? "-"}|${input.at}|${input.source}|${input.narrativeSummary}|${JSON.stringify(input.effects)}`)}`;
}
function appendStateEvent(world, input, opts = { now: 0 }) {
  const summary = input.narrativeSummary.trim();
  if (!summary) return { ok: false, error: "叙事摘要不能为空" };
  if (summary.length > W0_LIMITS.maxStateEventSummary) {
    return { ok: false, error: `叙事摘要超过上限 ${W0_LIMITS.maxStateEventSummary} 字` };
  }
  if (input.effects.length === 0) return { ok: false, error: "事件至少要包含一个 effect" };
  if (input.effects.length > W0_LIMITS.maxStateEventEffects) {
    return { ok: false, error: `单条事件最多 ${W0_LIMITS.maxStateEventEffects} 个 effect` };
  }
  const list = stateEventsOf(world);
  if (list.length >= W0_LIMITS.maxStateEvents) {
    return { ok: false, error: `账本事件数量已达上限（${W0_LIMITS.maxStateEvents}）` };
  }
  const contentId = stateEventContentId(world, {
    branchId: input.branchId ?? null,
    at: input.at,
    source: input.source,
    narrativeSummary: summary,
    effects: input.effects
  });
  if (list.some((e) => e.id === contentId)) {
    return { ok: false, error: `状态事件已存在（${contentId}）；同一变化只会写入一次` };
  }
  const touched = /* @__PURE__ */ new Set();
  for (const effect of input.effects) {
    if ("entityId" in effect) touched.add(effect.entityId);
  }
  for (const ref of input.entityRefs ?? []) touched.add(ref);
  const event = {
    id: contentId,
    worldId: world.id,
    branchId: input.branchId ?? null,
    at: input.at,
    sequence: nextSequence(world, input.branchId ?? null, input.at),
    source: input.source,
    ...input.actionId ? { actionId: input.actionId } : {},
    ...input.sessionId ? { sessionId: input.sessionId } : {},
    narrativeSummary: summary,
    entityRefs: [...touched],
    effects: input.effects,
    ...input.reversesEventId ? { reversesEventId: input.reversesEventId } : {},
    createdAt: opts.now ?? 0
  };
  const errors = validateStateEvent(world, event);
  if (errors.length > 0) {
    return { ok: false, error: `状态事件校验失败：${errors.join("；")}` };
  }
  if (parseStateEvent(JSON.parse(JSON.stringify(event))) === null) {
    return { ok: false, error: `状态事件形状不可解析（重载后会破坏存档）：${JSON.stringify(event.effects)}` };
  }
  return { ok: true, value: { ...world, stateEvents: [...list, event] } };
}
function applyEffectToState(state, effect) {
  switch (effect.kind) {
    case "setTemporalField":
      state[effect.key] = effect.value;
      break;
    case "moveEntity":
      if (effect.regionId !== void 0) state["_regionId"] = effect.regionId;
      if (effect.pointId !== void 0) state["_pointId"] = effect.pointId;
      break;
    case "adjustRelation":
      state[`relation:${effect.targetEntityId}:${effect.key}`] = effect.value;
      break;
    case "addTag": {
      const tags = new Set(Array.isArray(state["tags"]) ? state["tags"] : []);
      tags.add(effect.tag);
      state["tags"] = [...tags];
      break;
    }
    case "removeTag": {
      const tags = new Set(Array.isArray(state["tags"]) ? state["tags"] : []);
      tags.delete(effect.tag);
      state["tags"] = [...tags];
      break;
    }
    case "appendMemoryRef": {
      const refs = Array.isArray(state["_memoryRefs"]) ? state["_memoryRefs"] : [];
      state["_memoryRefs"] = [...refs, effect.memoryId ?? effect.text ?? ""].filter(Boolean);
      break;
    }
    case "attachNarrativeEntry": {
      const entries = typeof state["_narrativeEntries"] === "object" && state["_narrativeEntries"] !== null && !Array.isArray(state["_narrativeEntries"]) ? state["_narrativeEntries"] : {};
      const entryKey = `entry-${Object.keys(entries).length}`;
      state["_narrativeEntries"] = { ...entries, [entryKey]: { text: effect.text, closed: false } };
      break;
    }
    case "closeNarrativeEntry": {
      const entries = typeof state["_narrativeEntries"] === "object" && state["_narrativeEntries"] !== null && !Array.isArray(state["_narrativeEntries"]) ? state["_narrativeEntries"] : {};
      if (entries[effect.entryId]) state["_narrativeEntries"] = { ...entries, [effect.entryId]: { ...entries[effect.entryId], closed: true } };
      break;
    }
    case "setFlag":
      state[`flag:${effect.key}`] = effect.value ?? true;
      break;
  }
}
function shapeErrorOf(effect, index) {
  if (!effect || typeof effect !== "object") return `第 ${index + 1} 个 effect 不是对象`;
  const kind = effect.kind;
  if (typeof kind !== "string") return `第 ${index + 1} 个 effect 缺少 kind`;
  if (!STATE_EFFECT_KINDS.includes(kind)) {
    return `第 ${index + 1} 个 effect 的 kind 未知：${kind}`;
  }
  if (parseStateEffect(effect) === null) {
    return `第 ${index + 1} 个 effect 形状非法（${kind}：${JSON.stringify(effect)}），写入后会破坏存档`;
  }
  return null;
}
function validateChangeProposal(world, proposal) {
  const errors = [];
  if (proposal.worldId !== void 0 && proposal.worldId !== world.id) {
    errors.push(`提案来自其它世界（${proposal.worldId}），不能在本世界采用`);
  }
  const latestRevision2 = latestDefinitionRevision(world);
  if (proposal.definitionRevisionId !== void 0 && proposal.definitionRevisionId !== null) {
    if (!latestRevision2 || proposal.definitionRevisionId !== latestRevision2.id) {
      errors.push(`提案基于过期定义版本（${proposal.definitionRevisionId}）；当前为 ${latestRevision2?.id ?? "未建立"}，请重新生成`);
    }
  }
  if (!proposal.summary.trim()) errors.push("提案缺少摘要");
  if (proposal.summary.trim().length > W0_LIMITS.maxStateEventSummary) {
    errors.push(`摘要超过上限 ${W0_LIMITS.maxStateEventSummary} 字`);
  }
  if (!Number.isFinite(proposal.at)) errors.push("提案缺少合法时间（at）");
  if (proposal.branchId && !(world.stories ?? []).some((s) => s.id === proposal.branchId)) {
    errors.push(`提案分支不存在：${proposal.branchId}`);
  }
  if (proposal.effects.length === 0) errors.push("提案至少要包含一个 effect");
  if (proposal.effects.length > W0_LIMITS.maxStateEventEffects) {
    errors.push(`单条提案最多 ${W0_LIMITS.maxStateEventEffects} 个 effect`);
  }
  const parsed = [];
  proposal.effects.forEach((effect, index) => {
    const shapeError = shapeErrorOf(effect, index);
    if (shapeError) {
      errors.push(shapeError);
      return;
    }
    const parsedEffect = parseStateEffect(effect);
    if (parsedEffect) parsed.push(parsedEffect);
  });
  if (errors.length > 0) return errors;
  for (const effect of parsed) {
    const entityIds = new Set((world.entityRecords ?? []).map((e) => e.id));
    const issue = validateEffect(world, effect, entityIds);
    if (issue) errors.push(`${effect.kind}：${issue}`);
  }
  return errors;
}
function applyChangeProposal(world, proposal, opts = {}) {
  const acceptedIndexes = (opts.acceptedEffectIndexes ?? proposal.effects.map((_, i) => i)).filter((i, idx, arr) => arr.indexOf(i) === idx).filter((i) => i >= 0 && i < proposal.effects.length);
  if (acceptedIndexes.length === 0) {
    return { ok: true, value: world };
  }
  const partial = { ...proposal, effects: acceptedIndexes.map((i) => proposal.effects[i]) };
  const errors = validateChangeProposal(world, partial);
  if (errors.length > 0) {
    return { ok: false, error: `提案校验失败：${errors.join("；")}` };
  }
  const effects = [];
  for (const raw of partial.effects) {
    const parsed = parseStateEffect(raw);
    if (!parsed) return { ok: false, error: `提案校验失败：effect 形状非法（${JSON.stringify(raw)}）` };
    effects.push(parsed);
  }
  const touched = /* @__PURE__ */ new Set();
  for (const effect of effects) {
    if ("entityId" in effect) touched.add(effect.entityId);
  }
  const appended = appendStateEvent(world, {
    branchId: partial.branchId,
    at: partial.at,
    source: opts.source ?? "ai-adopted",
    narrativeSummary: partial.summary,
    effects,
    entityRefs: [...touched],
    sessionId: partial.id
  }, { now: opts.now ?? 0 });
  if (!appended.ok) return appended;
  const event = appended.value.stateEvents?.[appended.value.stateEvents.length - 1];
  return { ok: true, value: appended.value, appliedEventId: event?.id };
}
function toChangeProposal(pending) {
  return {
    id: pending.id,
    summary: pending.summary,
    at: pending.at,
    branchId: pending.branchId,
    effects: pending.effects,
    worldId: pending.origin.worldId,
    definitionRevisionId: pending.origin.definitionRevisionId
  };
}
function proposalEventId(world, pending, source = "ai-adopted") {
  const effects = [];
  for (const raw of pending.effects ?? []) {
    const parsed = parseStateEffect(raw);
    if (!parsed) return null;
    effects.push(parsed);
  }
  const summary = (pending.summary ?? "").trim();
  if (!summary || effects.length === 0) return null;
  return stateEventContentId(world, {
    branchId: pending.branchId ?? null,
    at: pending.at,
    source,
    narrativeSummary: summary,
    effects
  });
}
function validateProposalOrigin(world, pending) {
  const errors = [];
  const origin = pending.origin;
  if (!origin || typeof origin.worldId !== "string" || origin.worldId.length === 0) {
    errors.push("提案缺少来源世界信息，不能采用（请重新生成提案）");
  } else if (origin.worldId !== world.id) {
    errors.push(`提案来自其它世界（${origin.worldName ?? origin.worldId}），不能写入当前世界`);
  }
  const latest = latestDefinitionRevision(world);
  const pinned = origin ? origin.definitionRevisionId : null;
  if (pinned === null || pinned === void 0) {
    if (latest) errors.push(`提案未记录定义版本；当前为 ${latest.id}，请重新生成`);
  } else if (!latest || pinned !== latest.id) {
    errors.push(`提案基于过期定义版本（${pinned}）；当前为 ${latest?.id ?? "未建立"}，请重新生成`);
  }
  return errors;
}
function validatePendingProposal(world, pending) {
  const originErrors = validateProposalOrigin(world, pending);
  if (originErrors.length > 0) return originErrors;
  return validateChangeProposal(world, toChangeProposal(pending));
}
function notSubmitted(item, reason) {
  return { ...item, ok: false, error: reason };
}
function adoptPendingProposals(world, pendings, opts = {}) {
  if (pendings.length === 0) return { world, ok: true, adopted: [], rejected: [] };
  const rejected = [];
  const prepared = [];
  for (const pending of pendings) {
    const errors = validatePendingProposal(world, pending);
    if (errors.length > 0) {
      rejected.push({ proposalId: pending.id, summary: pending.summary, ok: false, error: errors.join("；") });
      continue;
    }
    prepared.push({ pending, proposal: toChangeProposal(pending) });
  }
  if (rejected.length > 0) {
    const reason = "同批存在被拒绝的提案，整单未提交";
    return {
      world,
      ok: false,
      adopted: [],
      rejected: [
        ...rejected,
        ...prepared.map((entry) => ({
          proposalId: entry.pending.id,
          summary: entry.pending.summary,
          ok: false,
          error: reason
        }))
      ],
      error: `整单未提交：${rejected.length} 条校验失败（草稿保留，可修改后重试）。`
    };
  }
  const source = opts.source ?? "ai-adopted";
  let candidate = world;
  const adopted = [];
  for (const entry of prepared) {
    const existingId = proposalEventId(candidate, entry.pending, source);
    if (existingId && (candidate.stateEvents ?? []).some((e) => e.id === existingId)) {
      adopted.push({ proposalId: entry.pending.id, summary: entry.pending.summary, ok: true, eventId: existingId });
      continue;
    }
    const result = applyChangeProposal(candidate, entry.proposal, {
      now: opts.now ?? 0,
      source
    });
    if (!result.ok) {
      const failure = result.error ?? "写入失败";
      const reason = `同批存在失败项，整单未提交（${failure}）`;
      return {
        world,
        ok: false,
        adopted: [],
        rejected: [
          ...adopted.map((item) => notSubmitted(item, reason)),
          { proposalId: entry.pending.id, summary: entry.pending.summary, ok: false, error: failure },
          ...prepared.slice(adopted.length + 1).map((rest) => ({
            proposalId: rest.pending.id,
            summary: rest.pending.summary,
            ok: false,
            error: reason
          }))
        ],
        error: `整单未提交：${failure}`
      };
    }
    candidate = result.value;
    adopted.push({
      proposalId: entry.pending.id,
      summary: entry.pending.summary,
      ok: true,
      eventId: result.appliedEventId
    });
  }
  return { world: candidate, ok: true, adopted, rejected: [] };
}
function stateProjectionHash(value) {
  return `proj-${hashString(JSON.stringify(value))}`;
}

// lib/world-projection.ts
function emptyAccumulator() {
  return { entityStates: {}, flags: {}, memoryRefs: {}, narrativeEntries: {}, sourceChain: [] };
}
function applyEvent(acc, event) {
  acc.sourceChain.push(event.id);
  for (const effect of event.effects) {
    if (effect.kind === "setFlag") {
      acc.flags[effect.key] = effect.value ?? true;
      continue;
    }
    if (!("entityId" in effect)) continue;
    const entityId = effect.entityId;
    acc.entityStates[entityId] ??= {};
    applyEffectToState(acc.entityStates[entityId], effect);
    if (effect.kind === "appendMemoryRef") {
      const refs = acc.memoryRefs[entityId] ?? [];
      const ref = effect.memoryId ?? effect.text ?? "";
      if (ref && !refs.includes(ref)) acc.memoryRefs[entityId] = [...refs, ref];
    }
    if (effect.kind === "attachNarrativeEntry" || effect.kind === "closeNarrativeEntry") {
      const entries = acc.entityStates[entityId]["_narrativeEntries"];
      if (entries && typeof entries === "object" && !Array.isArray(entries)) {
        acc.narrativeEntries[entityId] = entries;
      }
    }
  }
}
function resolveDefinition(world, branchId, at, pin) {
  if (pin) {
    if (pin.revisionId === null) {
      return { revision: null, approx: true, reason: "检查点未记录定义版本，历史定义为近似" };
    }
    const found = (world.definitionRevisions ?? []).find((r) => r.id === pin.revisionId) ?? null;
    if (!found) {
      return { revision: null, approx: true, reason: `检查点钉住的定义版本 ${pin.revisionId} 已不存在，历史定义为近似` };
    }
    return { revision: found, approx: false };
  }
  const selection = definitionRevisionFor(world, at, branchId);
  return { revision: selection.revision, approx: selection.approx, reason: selection.reason ?? void 0 };
}
function finalize(world, branchId, at, acc, approx, reasons, pin) {
  const selection = resolveDefinition(world, branchId, at, pin);
  const revision = selection.revision;
  const allReasons = [...reasons, ...selection.reason ? [selection.reason] : []];
  return {
    worldId: world.id,
    branchId,
    at,
    definitionRevisionId: revision?.id ?? null,
    definitionSnapshot: revision?.snapshot ?? null,
    entityStates: acc.entityStates,
    flags: acc.flags,
    memoryRefs: acc.memoryRefs,
    narrativeEntries: acc.narrativeEntries,
    sourceChain: acc.sourceChain,
    hash: stateProjectionHash({ e: acc.entityStates, f: acc.flags, m: acc.memoryRefs, n: acc.narrativeEntries, s: acc.sourceChain }),
    approx: approx || selection.approx,
    reasons: allReasons
  };
}
function orderedEventsFor(world, branchId, at) {
  const { segments } = branchLineage(world, branchId, at);
  const ordered = [];
  for (const segment of segments) {
    const cutoff = segment.cutoffAt ?? at;
    const canonSegment = segment.branchId === null;
    ordered.push(...(world.stateEvents ?? []).filter((e) => (canonSegment ? isCanonLedgerBranch(world, e.branchId) : e.branchId === segment.branchId) && e.at <= cutoff).sort(compareStateEvents));
  }
  return ordered;
}
function replayFromLedger(world, branchId, at, pin) {
  const { approx, reasons } = branchLineage(world, branchId, at);
  const acc = emptyAccumulator();
  for (const event of orderedEventsFor(world, branchId, at)) applyEvent(acc, event);
  return finalize(world, branchId, at, acc, approx, reasons, pin);
}
function resolveWorldProjection(world, request) {
  const { worldId, branchId, at } = request;
  const pin = request.pinDefinitionRevisionId !== void 0 ? { revisionId: request.pinDefinitionRevisionId } : void 0;
  if (worldId !== world.id) {
    return finalize(world, branchId, at, emptyAccumulator(), true, [`worldId 不匹配：请求 ${worldId}，世界 ${world.id}`], pin);
  }
  if (branchId !== null && !(world.stories ?? []).some((s) => s.id === branchId)) {
    return finalize(world, branchId, at, emptyAccumulator(), true, [`分支不存在：${branchId}`], pin);
  }
  const hint = request.checkpointHint;
  if (hint && hint.worldId === world.id && hint.branchId === branchId && hint.at <= at) {
    const expected = stateProjectionHash({ e: hint.entityStates, f: hint.flags, m: hint.memoryRefs, n: hint.narrativeEntries, s: hint.sourceChain });
    if (expected === hint.stateHash) {
      const acc = emptyAccumulator();
      acc.entityStates = Object.fromEntries(Object.entries(hint.entityStates).map(([k, v]) => [k, { ...v }]));
      acc.flags = { ...hint.flags };
      acc.memoryRefs = Object.fromEntries(Object.entries(hint.memoryRefs).map(([k, v]) => [k, [...v]]));
      acc.narrativeEntries = Object.fromEntries(Object.entries(hint.narrativeEntries).map(([k, v]) => [k, { ...v }]));
      acc.sourceChain = [...hint.sourceChain];
      const { approx, reasons } = branchLineage(world, branchId, at);
      const pinned = pin !== void 0;
      const ordered = orderedEventsFor(world, branchId, at);
      const chain = hint.sourceChain;
      const baseIsPrefix = chain.length <= ordered.length && chain.every((id, i) => ordered[i]?.id === id);
      if (!pinned && !baseIsPrefix) {
        const fallback = replayFromLedger(world, branchId, at, pin);
        return {
          ...fallback,
          reasons: [...fallback.reasons, "检查点缓存基座已失效（其后有同刻 / 更早时刻的事件被追加），改用全量重放"]
        };
      }
      const tail = pinned ? ordered.filter((e) => e.at > hint.at) : ordered.slice(chain.length);
      for (const event of tail) applyEvent(acc, event);
      return finalize(world, branchId, at, acc, approx, reasons, pin);
    }
  }
  return replayFromLedger(world, branchId, at, pin);
}
function createProjectionCheckpoint(world, branchId, at) {
  const projection = replayFromLedger(world, branchId, at);
  return {
    worldId: world.id,
    branchId,
    at,
    definitionRevisionId: projection.definitionRevisionId,
    entityStates: projection.entityStates,
    flags: projection.flags,
    memoryRefs: projection.memoryRefs,
    narrativeEntries: projection.narrativeEntries,
    sourceChain: projection.sourceChain,
    stateHash: projection.hash
  };
}

// lib/world-timepoint.ts
function actionEndTime(action) {
  if (typeof action.endedAt === "number" && Number.isFinite(action.endedAt)) return action.endedAt;
  if (typeof action.at === "number" && Number.isFinite(action.at)) return action.at;
  return null;
}
var TIME_EPS = 1e-9;
function branchTimeChainIsConsistent(actions) {
  if (actions.length === 0) return false;
  let prevEnd = -Infinity;
  for (const a of actions) {
    if (typeof a.at !== "number" || !Number.isFinite(a.at)) return false;
    const start = typeof a.startedAt === "number" ? a.startedAt : a.at;
    const end = typeof a.endedAt === "number" ? a.endedAt : a.at;
    if (!(start <= a.at + TIME_EPS && a.at <= end + TIME_EPS)) return false;
    if (start < prevEnd - TIME_EPS) return false;
    prevEnd = end;
  }
  return true;
}
function actionSortTime(action, useEndedAt) {
  if (useEndedAt && typeof action.endedAt === "number" && Number.isFinite(action.endedAt)) {
    return action.endedAt;
  }
  if (typeof action.at === "number" && Number.isFinite(action.at)) return action.at;
  return actionEndTime(action);
}
function actionLanding(action) {
  if (action.toPointId) return { regionId: action.toRegionId ?? null, pointId: action.toPointId };
  if (action.toRegionId) return { regionId: action.toRegionId, pointId: null };
  return { regionId: action.fromRegionId ?? null, pointId: action.fromPointId ?? null };
}
var outcomeFlagRefs = (world, actionIds) => {
  const ids = new Set(actionIds);
  const out = [];
  for (const o of world.outcomes ?? []) {
    if (!ids.has(o.actionId)) continue;
    for (const ref of o.changeRefs ?? []) {
      if (ref.startsWith("flag:") && ref.length > 5) out.push(ref.slice(5));
    }
  }
  return out;
};
function projectRuntimeAt(world, storyId, at, opts = {}) {
  if (!storyId?.trim()) return null;
  const source = (world.storyRuntimes ?? []).find((r) => r.storyId === storyId);
  if (!source) return null;
  const anchorAt = typeof at === "number" && Number.isFinite(at) ? at : 0;
  const now = opts.now ?? 0;
  const reasons = [];
  let approx = false;
  const actionById = new Map((world.actions ?? []).map((a) => [a.id, a]));
  const keptActionIds = [];
  const droppedActionIds = [];
  const undatedActionIds = [];
  const orderedActions = (source.actionLog ?? []).map((id) => actionById.get(id)).filter((a) => Boolean(a));
  const useEndedAt = branchTimeChainIsConsistent(orderedActions);
  for (const id of source.actionLog ?? []) {
    const action = actionById.get(id);
    if (!action) {
      droppedActionIds.push(id);
      reasons.push(`行动 ${id} 的引用已失效，未作为历史依据。`);
      approx = true;
      continue;
    }
    const end = actionSortTime(action, useEndedAt);
    if (end === null) {
      droppedActionIds.push(id);
      undatedActionIds.push(id);
      continue;
    }
    if (end <= anchorAt) keptActionIds.push(id);
    else droppedActionIds.push(id);
  }
  if (undatedActionIds.length > 0) {
    approx = true;
    reasons.push(
      `${undatedActionIds.length} 条行动缺少可定位的时间字段，已按「不在锚点之前」处理；该时点为近似起点。`
    );
  }
  let positionSource = "unknown";
  let regionId = null;
  let pointId = null;
  const lastKept = keptActionIds.length ? actionById.get(keptActionIds[keptActionIds.length - 1]) : void 0;
  if (lastKept) {
    const landing = actionLanding(lastKept);
    regionId = landing.regionId;
    pointId = landing.pointId;
    positionSource = "action";
  } else {
    const anchorEventId = opts.anchorEventId ?? null;
    let anchorRegionId = null;
    let anchorEventTitle = null;
    if (anchorEventId) {
      for (const [regionKey, list] of Object.entries(world.events ?? {})) {
        const hit = (list ?? []).find((e) => e.id === anchorEventId);
        if (hit) {
          anchorRegionId = regionKey;
          anchorEventTitle = hit.title;
          break;
        }
      }
    }
    if (anchorRegionId) {
      regionId = anchorRegionId;
      pointId = null;
      positionSource = "event";
      reasons.push(
        `该分支在锚点前没有可定位的行动，起点按事件「${anchorEventTitle ?? anchorEventId}」所在地区近似。`
      );
    } else if (world.currentRegionId) {
      regionId = world.currentRegionId;
      pointId = null;
      positionSource = "event";
      reasons.push("该分支在锚点前没有可定位的行动，起点按世界当前地区近似。");
    } else {
      reasons.push("该分支在锚点前没有可定位的行动，且没有可用的地区锚点：起点未知。");
    }
    approx = true;
  }
  const droppedFlags = new Set(outcomeFlagRefs(world, droppedActionIds));
  const keptFlags = new Set(outcomeFlagRefs(world, keptActionIds));
  const revokedFlags = [...droppedFlags].filter((f) => !keptFlags.has(f));
  const worldFlags = (source.worldFlags ?? []).filter((f) => !revokedFlags.includes(f));
  if (revokedFlags.length > 0) {
    reasons.push(`已撤销 ${revokedFlags.length} 个由锚点之后行动产生的世界标记：${revokedFlags.join("、")}。`);
  }
  const runtime = {
    storyId,
    currentTime: anchorAt,
    currentRegionId: regionId,
    ...source.currentPointId !== void 0 || pointId !== null ? { currentPointId: pointId } : {},
    ...source.companions ? { companions: [...source.companions] } : {},
    ...source.worldFlags || worldFlags.length ? { worldFlags } : {},
    actionLog: keptActionIds.slice(-W0_LIMITS.maxActions),
    snapshotFrom: source.snapshotFrom ?? null,
    updatedAt: now
  };
  return {
    storyId,
    anchorAt,
    runtime,
    keptActionIds,
    droppedActionIds,
    revokedFlags,
    characterPositions: projectCharacterPositionsAt(world, {
      storyId,
      at: anchorAt,
      keptActionIds,
      droppedActionIds,
      actionById
    }),
    positionSource,
    approx: approx || revokedFlags.length > 0,
    reasons
  };
}
function projectCharacterPositionsAt(world, ctx) {
  const droppedByActor = /* @__PURE__ */ new Set();
  for (const id of ctx.droppedActionIds) {
    const action = ctx.actionById.get(id);
    if (action?.actorId) droppedByActor.add(action.actorId);
  }
  const keptByActor = /* @__PURE__ */ new Map();
  for (const id of ctx.keptActionIds) {
    const action = ctx.actionById.get(id);
    if (!action?.actorId) continue;
    const landing = actionLanding(action);
    keptByActor.set(action.actorId, { actionId: action.id, regionId: landing.regionId, pointId: landing.pointId });
  }
  const out = [];
  for (const c of world.characters ?? []) {
    const kept = keptByActor.get(c.id);
    if (kept) {
      out.push({
        characterId: c.id,
        regionId: kept.regionId,
        pointId: kept.pointId,
        source: "action",
        actionId: kept.actionId,
        approx: false
      });
      continue;
    }
    const state = (world.characterStates ?? []).find(
      (s) => s.characterId === c.id && !s.branchId
    );
    if (state) {
      out.push({
        characterId: c.id,
        regionId: state.currentRegionId ?? null,
        pointId: state.currentPointId ?? null,
        source: "baseline",
        actionId: null,
        // 基线可能被本分支锚点之后的行动改写过 → 诚实标近似
        approx: droppedByActor.has(c.id)
      });
      continue;
    }
    if (c.currentRegionId) {
      out.push({
        characterId: c.id,
        regionId: c.currentRegionId,
        pointId: null,
        source: "legacy",
        actionId: null,
        approx: droppedByActor.has(c.id)
      });
      continue;
    }
    out.push({
      characterId: c.id,
      regionId: null,
      pointId: null,
      source: "unknown",
      actionId: null,
      approx: true
    });
  }
  return out;
}

// lib/world-checkpoint.ts
function checkpointSnapshotHash(snapshot) {
  return `proj-${hashString(JSON.stringify({ e: snapshot.entityStates, f: snapshot.flags, m: snapshot.memoryRefs, n: snapshot.narrativeEntries, s: snapshot.sourceChain }))}`;
}
function isCheckpointIntact(checkpoint) {
  return checkpointSnapshotHash(checkpoint.snapshot) === checkpoint.snapshot.stateHash;
}
function createCheckpoint(world, opts) {
  const reason = opts.reason.trim();
  if (!reason) return { ok: false, error: "检查点必须说明创建原因" };
  if (reason.length > W0_LIMITS.maxCheckpointReason) {
    return { ok: false, error: `创建原因超过上限 ${W0_LIMITS.maxCheckpointReason} 字` };
  }
  if (opts.name !== void 0 && opts.name.length > W0_LIMITS.maxCheckpointName) {
    return { ok: false, error: `检查点名称超过上限 ${W0_LIMITS.maxCheckpointName} 字` };
  }
  const list = world.checkpoints ?? [];
  if (list.length >= W0_LIMITS.maxCheckpoints) {
    return { ok: false, error: `检查点数量已达上限（${W0_LIMITS.maxCheckpoints}）；永久压缩需先生成完整备份并二次确认` };
  }
  if (opts.branchId && !(world.stories ?? []).some((s) => s.id === opts.branchId)) {
    return { ok: false, error: `分支不存在：${opts.branchId}` };
  }
  const materialized = createProjectionCheckpoint(world, opts.branchId, opts.at);
  const runtimeSnapshot = captureRuntime(world, opts.branchId, opts.at, { now: opts.now ?? 0 });
  const checkpoint = {
    id: `ckpt-${hashString(`${world.id}|${opts.branchId ?? "-"}|${opts.at}|${list.length}|${reason}`)}`,
    worldId: world.id,
    kind: opts.kind,
    reason,
    ...opts.name ? { name: opts.name } : {},
    branchId: opts.branchId ?? null,
    at: opts.at,
    ledgerHead: materialized.sourceChain.length > 0 ? materialized.sourceChain[materialized.sourceChain.length - 1] : null,
    ledgerCount: materialized.sourceChain.length,
    ...runtimeSnapshot ? { runtime: runtimeSnapshot } : {},
    // R5-RC-01：按检查点时刻选择权威定义修订（而不是最新修订）
    definitionRevisionId: materialized.definitionRevisionId ?? null,
    parentCheckpointId: list.length > 0 ? list[list.length - 1].id : null,
    snapshot: {
      entityStates: materialized.entityStates,
      flags: materialized.flags,
      memoryRefs: materialized.memoryRefs,
      narrativeEntries: materialized.narrativeEntries,
      sourceChain: materialized.sourceChain,
      stateHash: materialized.stateHash
    },
    createdAt: opts.now ?? 0
  };
  return { ok: true, value: { ...world, checkpoints: [...list, checkpoint] } };
}
function runtimeStoryId(world, branchId) {
  if (branchId) return branchId;
  const canon = (world.stories ?? []).find((s) => s.mode === "canon");
  return canon?.id ?? null;
}
function captureRuntime(world, branchId, at, opts = { now: 0 }) {
  const storyId = runtimeStoryId(world, branchId);
  if (!storyId) return null;
  const projection = projectRuntimeAt(world, storyId, at, { now: opts.now ?? 0 });
  if (!projection) return null;
  const rt = projection.runtime;
  return {
    currentTime: rt.currentTime,
    currentRegionId: rt.currentRegionId ?? null,
    currentPointId: rt.currentPointId ?? null,
    worldFlags: [...rt.worldFlags ?? []],
    approx: projection.approx,
    // PLAY-05：连同当时的已播放行动指针一起物化，回退时直接照它还原
    actionLog: [...rt.actionLog ?? []]
  };
}
function checkpointById(world, checkpointId) {
  const hit = (world.checkpoints ?? []).find((c) => c.id === checkpointId);
  return hit && isCheckpointIntact(hit) ? hit : null;
}
function previewRestore(world, checkpointId) {
  const checkpoint = checkpointById(world, checkpointId);
  if (!checkpoint) {
    const known = (world.checkpoints ?? []).some((c) => c.id === checkpointId);
    return { ok: false, error: known ? "检查点数据已损坏（hash 不一致），拒绝作为恢复源；可从上一检查点 + 账本重建" : "检查点不存在" };
  }
  const futureEventCount = (world.stateEvents ?? []).filter(
    (e) => e.branchId === checkpoint.branchId && e.at > checkpoint.at
  ).length;
  return {
    ok: true,
    value: {
      checkpointId: checkpoint.id,
      branchId: checkpoint.branchId,
      at: checkpoint.at,
      ...checkpoint.name ? { name: checkpoint.name } : {},
      reason: checkpoint.reason,
      ledgerHead: checkpoint.ledgerHead,
      ledgerCount: checkpoint.ledgerCount,
      futureEventCount,
      definitionRevisionId: checkpoint.definitionRevisionId ?? null,
      // R5-RC-01：检查点引用的定义修订没有不可变快照（旧数据）→ 诚实标注近似
      ...(() => {
        const revision = checkpoint.definitionRevisionId ? (world.definitionRevisions ?? []).find((r) => r.id === checkpoint.definitionRevisionId) : null;
        return revision && !revision.snapshot ? { definitionApprox: true } : {};
      })()
    }
  };
}
function restoreAsPlayhead(world, checkpointId, opts = { now: 0 }) {
  const checkpoint = checkpointById(world, checkpointId);
  if (!checkpoint) return { ok: false, error: "检查点不存在或已损坏，拒绝作为恢复源" };
  const playhead = {
    branchId: checkpoint.branchId,
    at: checkpoint.at,
    checkpointId: checkpoint.id,
    updatedAt: opts.now ?? 0
  };
  const others = (world.playheads ?? []).filter((p) => p.branchId !== checkpoint.branchId);
  let next = { ...world, playheads: [...others, playhead] };
  const storyId = runtimeStoryId(world, checkpoint.branchId);
  const runtimes = [...world.storyRuntimes ?? []];
  const idx = storyId ? runtimes.findIndex((r) => r.storyId === storyId) : -1;
  const saved = checkpoint.runtime ?? null;
  let replayedActionsDropped = 0;
  if (idx >= 0) {
    const rt = runtimes[idx];
    const savedLog = saved && Array.isArray(saved.actionLog) ? new Set(saved.actionLog) : null;
    const orderedActions = (rt.actionLog ?? []).map((id) => (world.actions ?? []).find((a) => a.id === id)).filter((a) => Boolean(a));
    const useEndedAt = branchTimeChainIsConsistent(orderedActions);
    const kept = (rt.actionLog ?? []).filter((id) => {
      const action = (world.actions ?? []).find((a) => a.id === id);
      if (!action) return true;
      if (savedLog) return savedLog.has(id);
      const end = actionSortTime(action, useEndedAt);
      if (end === null) return true;
      return end <= checkpoint.at;
    });
    replayedActionsDropped = (rt.actionLog ?? []).length - kept.length;
    runtimes[idx] = {
      ...rt,
      // 有 runtime 快照 → 完整还原；没有（旧检查点）→ 至少把时间对齐到检查点
      currentTime: saved ? saved.currentTime : checkpoint.at,
      ...saved ? { currentRegionId: saved.currentRegionId } : {},
      ...saved && saved.currentPointId !== null ? { currentPointId: saved.currentPointId } : {},
      ...saved ? { worldFlags: [...saved.worldFlags] } : {},
      actionLog: kept,
      updatedAt: opts.now ?? 0
    };
    next = { ...next, storyRuntimes: runtimes };
  }
  return {
    ok: true,
    value: next,
    restored: {
      branchId: checkpoint.branchId,
      at: checkpoint.at,
      runtimeRestored: Boolean(saved) && idx >= 0,
      approx: !saved || saved.approx,
      replayedActionsDropped
    }
  };
}

// src/atlas-relevance.ts
function deriveAtlasTurnSeed(world, chatId, messageId, at) {
  const actionCount = parseInt(hashString(`${chatId}|${messageId}`).slice(0, 8), 16) >>> 0;
  return deriveActionSeed(world, `atlas:${chatId}`, actionCount, at);
}
function pointById(world, pointId) {
  if (!pointId) return null;
  return (world.points ?? []).find((p) => String(p.id) === String(pointId)) ?? null;
}
function computeAtlasRelevance(world, input) {
  const radius = typeof input.radius === "number" && input.radius > 0 ? input.radius : DEFAULT_NEARBY_RADIUS;
  const anchor = pointById(world, input.currentPointId);
  const nearbyWithDistance = anchor ? nearbyPoints(world, anchor.x, anchor.y, radius, String(anchor.id)).map((pointId) => {
    const point = pointById(world, pointId);
    return point ? { pointId, x: point.x, y: point.y } : null;
  }).filter((p) => p !== null) : [];
  const nearbyPointIds = nearbyWithDistance.map((p) => ({ ...p, dist: anchor ? gridDistance(anchor.x, anchor.y, p.x, p.y) : 0 })).sort((a, b) => a.dist - b.dist).map((p) => p.pointId);
  const npcReasons = {};
  const orderedNpcIds = [];
  const pushNpc = (characterId, reason) => {
    const list = npcReasons[characterId] ?? [];
    list.push(reason);
    npcReasons[characterId] = list;
    if (!orderedNpcIds.includes(characterId)) orderedNpcIds.push(characterId);
  };
  if (input.currentPointId) {
    for (const id of charactersAtPoint(world, input.currentPointId, { branchId: input.branchId })) {
      pushNpc(id, "samePoint");
    }
  }
  for (const pointId of nearbyPointIds) {
    for (const id of charactersAtPoint(world, pointId, { branchId: input.branchId })) {
      pushNpc(id, "nearbyPoint");
    }
  }
  if (input.currentRegionId) {
    for (const id of charactersInRegion(world, input.currentRegionId, { branchId: input.branchId })) {
      pushNpc(id, "sameRegion");
    }
  }
  const pseudoAction = {
    id: `atlas-prepare-${hashString(`${input.chatId}|${input.messageId}`)}`,
    at: input.at,
    kind: "interact",
    actorId: input.actorId ?? null,
    fromPointId: input.currentPointId,
    fromRegionId: input.currentRegionId,
    toPointId: input.currentPointId,
    toRegionId: input.currentRegionId
  };
  const sources = resolveActionSources(world, pseudoAction, {
    radius,
    branchId: input.branchId,
    companionIds: input.actorId ? [input.actorId] : []
  });
  const triggers = selectTriggers(world, sources, {
    at: input.at,
    regionId: input.currentRegionId,
    pointId: input.currentPointId,
    characterIds: sources.characterIds,
    flags: input.flags ?? []
  });
  return {
    seed: deriveAtlasTurnSeed(world, input.chatId, input.messageId, input.at),
    nearbyPointIds,
    relevantNpcIds: orderedNpcIds.slice(0, ATLAS_LIMITS.REF_ARRAY),
    npcReasons,
    triggerIds: triggers.map((t) => t.id).slice(0, ATLAS_LIMITS.REF_ARRAY),
    sourceRefs: sources.worldBookIds.slice(0, ATLAS_LIMITS.REF_ARRAY),
    characterIds: sources.characterIds.slice(0, ATLAS_LIMITS.REF_ARRAY),
    radius
  };
}
function atlasTravelPreview(world, input) {
  const hint = buildTravelHint(world, {
    fromPointId: input.fromPointId,
    toPointId: input.toPointId,
    ...input.speedTierId ? { speedTierId: input.speedTierId } : {}
  });
  if (!hint.from.pointId || !hint.to.pointId) return null;
  return {
    destinationId: String(hint.to.pointId),
    distance: Math.max(0, hint.distance.cells),
    estimatedDuration: Math.max(0, Math.round(hint.suggestedPeriods)),
    factors: [hint.basis]
  };
}

// lib/context-plan.ts
var LEDGER_SUMMARY_COUNT = 10;
function memoryScopesFor(world, branchId, at) {
  return branchLineage(world, branchId, at).segments.map((segment) => ({
    branchId: segment.branchId,
    cutoffAt: segment.cutoffAt ?? at
  }));
}
function buildContextPlan(world, input) {
  const excluded = new Set(input.excludeSourceIds ?? []);
  const budgetChars = input.budgetChars ?? 12e3;
  const projection = resolveWorldProjection(world, {
    worldId: world.id,
    branchId: input.branchId,
    at: input.at
  });
  const definitionSelection = definitionRevisionFor(world, input.at, input.branchId ?? null);
  const snapshotEntities = definitionSelection.revision?.snapshot?.entities ?? null;
  const sources = [];
  for (const entry of world.worldBible ?? []) {
    if (entry.enabled === false || excluded.has(entry.id)) continue;
    sources.push({ id: entry.id, title: entry.title, kind: "worldBook" });
  }
  const regionId = world.currentRegionId ?? null;
  const region = (world.regions ?? []).find((r) => r.id === regionId);
  if (region) sources.push({ id: region.id, title: region.name, kind: "region" });
  const points = (world.points ?? []).filter((p) => !regionId || p.regionId === regionId).slice(0, 12);
  for (const point of points) sources.push({ id: String(point.id), title: point.name, kind: "point" });
  const entities = [];
  const entitySource = snapshotEntities ?? world.entityRecords ?? [];
  for (const entity of entitySource) {
    if (excluded.has(entity.id)) continue;
    const state = projection.entityStates[entity.id] ?? {};
    const temporal = {};
    for (const field of entity.temporalSchema) {
      if (field.kind === "private" && field.entersAI !== true) continue;
      if (field.kind === "base") continue;
      const value = state[field.key];
      if (value === void 0) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        temporal[field.key] = value;
      } else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
        temporal[field.key] = value;
      }
    }
    entities.push({ id: entity.id, name: entity.name, temporal });
    sources.push({ id: entity.id, title: entity.name, kind: "entity" });
  }
  const allowed = memoryScopesFor(world, input.branchId, input.at);
  const memories = (world.characterMemories ?? []).filter((m) => {
    const mBranch = m.branchId ?? null;
    if (excluded.has(m.id)) return false;
    if (m.at > input.at) return false;
    return allowed.some((scope) => scope.branchId === mBranch && m.at <= scope.cutoffAt);
  }).slice(0, W0_LIMITS.maxRoleplayContextTitles).map((m) => ({ id: m.id, characterId: m.characterId, at: m.at }));
  for (const m of memories) sources.push({ id: m.id, title: `记忆@${m.at}`, kind: "memory" });
  const ledger = ledgerForBranch(world, input.branchId ?? null).filter((e) => e.at <= input.at).slice(-LEDGER_SUMMARY_COUNT).map((e) => ({ id: e.id, at: e.at, source: e.source, summary: e.narrativeSummary }));
  const session = (world.agentSessions ?? []).find((s) => s.storyId === (input.branchId ?? ""));
  const viewpoint = session?.viewpointCharacterId ? (world.characters ?? []).find((c) => c.id === session.viewpointCharacterId)?.name ?? null : null;
  const plan = {
    purpose: input.purpose,
    worldId: world.id,
    branchId: input.branchId,
    at: input.at,
    definitionRevisionId: definitionSelection.revision?.id ?? null,
    sources,
    excludedSourceIds: [...excluded],
    entities,
    memories,
    ledger,
    flags: projection.flags,
    viewpoint,
    budgetChars,
    truncatedSources: [],
    hash: ""
  };
  plan.hash = `plan-${hashString(JSON.stringify({ ...plan, hash: void 0 }))}`;
  return plan;
}
function renderContextPlan(plan) {
  const lines = [];
  lines.push(`【上下文装配单 · ${plan.purpose}】`);
  lines.push(`世界 ${plan.worldId} · 分支 ${plan.branchId ?? "正史"} · 时刻 ${plan.at} · 定义版本 ${plan.definitionRevisionId ?? "未建立"}`);
  if (plan.viewpoint) lines.push(`视角人物：${plan.viewpoint}`);
  const included = plan.sources.filter((s) => !plan.excludedSourceIds.includes(s.id));
  for (const source of included) {
    if (source.kind === "entity") {
      const entity = plan.entities.find((e) => e.id === source.id);
      if (entity && Object.keys(entity.temporal).length > 0) {
        lines.push(`实体 ${entity.name}：${Object.entries(entity.temporal).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("，")}`);
      }
    } else if (source.kind === "worldBook") {
      lines.push(`世界书：${source.title}`);
    }
  }
  if (plan.memories.length > 0) {
    lines.push(`记忆引用 ${plan.memories.length} 条（按分支与时间过滤）。`);
  }
  if (plan.ledger.length > 0) {
    lines.push("最近账本：");
    for (const entry of plan.ledger) {
      lines.push(`- ${entry.at}（${entry.source}）：${entry.summary}`);
    }
  }
  const flags = Object.entries(plan.flags);
  if (flags.length > 0) lines.push(`世界标记：${flags.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("，")}`);
  lines.push("未采用草稿与密钥永不进入本计划。");
  const text = lines.join("\n");
  if (text.length <= plan.budgetChars) return text;
  return `${text.slice(0, plan.budgetChars)}
【已截断：超出 ${plan.budgetChars} 字符预算】`;
}

// src/atlas-geo-apply.ts
var NEW_LOCATIONS_MAX = 12;
var NAME_CHARS = 40;
var DESC_CHARS = 300;
var SUBMAP_POINTS_MAX = 40;
function sanitizeSubMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void 0;
  const record = raw;
  let scale;
  const scaleRaw = record.scale;
  if (scaleRaw && typeof scaleRaw === "object" && !Array.isArray(scaleRaw)) {
    const distance = Number(scaleRaw.distancePerCell);
    if (Number.isFinite(distance) && distance > 0) {
      const unit = String(scaleRaw.unit ?? "").trim().slice(0, 12);
      scale = { distancePerCell: Math.round(distance * 100) / 100, ...unit ? { unit } : {} };
    }
  }
  const rawPoints = Array.isArray(record.points) ? record.points : [];
  const points = [];
  for (const item of rawPoints.slice(0, SUBMAP_POINTS_MAX * 2)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const name = String(item.name ?? "").trim().replace(/\s+/g, " ").slice(0, NAME_CHARS);
    if (!name) continue;
    const description = String(item.description ?? "").trim().replace(/\s+/g, " ").slice(0, DESC_CHARS);
    points.push({ name, ...description ? { description } : {} });
    if (points.length >= SUBMAP_POINTS_MAX) break;
  }
  if (points.length === 0) return void 0;
  return { ...scale ? { scale } : {}, points };
}
function sanitizeNewLocations(raw) {
  if (!Array.isArray(raw)) return [];
  const result = [];
  for (const item of raw.slice(0, NEW_LOCATIONS_MAX * 2)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item;
    const name = String(record.name ?? "").trim().replace(/\s+/g, " ").slice(0, NAME_CHARS);
    if (!name) continue;
    const regionName = String(record.regionName ?? "").trim().replace(/\s+/g, " ").slice(0, NAME_CHARS);
    const description = String(record.description ?? "").trim().replace(/\s+/g, " ").slice(0, DESC_CHARS);
    const submap = sanitizeSubMap(record.submap);
    result.push({
      name,
      ...regionName ? { regionName } : {},
      ...description ? { description } : {},
      ...submap ? { submap } : {}
    });
    if (result.length >= NEW_LOCATIONS_MAX) break;
  }
  return result;
}
function applyNewLocations(world, locations, options) {
  const empty = {
    world,
    regionsAdded: 0,
    pointsAdded: 0,
    skipped: 0,
    regionNames: [],
    pointNames: [],
    revisionAppended: false,
    createdPoints: []
  };
  if (!Array.isArray(locations) || locations.length === 0) return empty;
  const clean = (text) => String(text ?? "").trim().replace(/\s+/g, " ");
  const norm = (text) => text.toLowerCase();
  const existingRegionNames = new Set((world.regions ?? []).map((r) => norm(clean(r.name))));
  const existingPointNames = new Set((world.points ?? []).map((p) => norm(clean(p.name))));
  const regionIdByName = new Map((world.regions ?? []).map((r) => [norm(clean(r.name)), String(r.id)]));
  let skipped = 0;
  const newRegions = [];
  for (const item of locations) {
    if (newRegions.length >= 6) break;
    if (existingRegionNames.has(norm(item.name))) {
      skipped += 1;
      continue;
    }
    const id = `turn-r-${hashString(`${world.id}|r|${item.name}|${options.now}`)}`;
    newRegions.push({
      id,
      worldId: world.id,
      name: item.name,
      type: "other",
      description: item.description || "由剧情推演提炼。",
      coordinates: { x: 0, y: 0 }
    });
    existingRegionNames.add(norm(item.name));
    regionIdByName.set(norm(item.name), id);
  }
  const nextPointIdBase = (world.points ?? []).reduce((max, p) => Math.max(max, Number(p.id) || 0), 0) + 1;
  const newPoints = [];
  for (const item of locations) {
    if (newPoints.length >= NEW_LOCATIONS_MAX) break;
    if (existingPointNames.has(norm(item.name))) {
      skipped += 1;
      continue;
    }
    const regionId = (item.regionName ? regionIdByName.get(norm(item.regionName)) : null) ?? "start";
    const index = newPoints.length;
    const angle = index * 2.39996;
    const radius = 14 + 3.4 * Math.sqrt(index + 1);
    newPoints.push({
      id: nextPointIdBase + newPoints.length,
      name: item.name,
      x: Math.round(Math.min(96, Math.max(4, 50 + radius * Math.cos(angle)))),
      y: Math.round(Math.min(96, Math.max(4, 50 + radius * Math.sin(angle)))),
      regionId
    });
    existingPointNames.add(norm(item.name));
  }
  if (newRegions.length === 0 && newPoints.length === 0) {
    return { ...empty, skipped };
  }
  let updated = {
    ...world,
    regions: [...world.regions ?? [], ...newRegions],
    points: [...world.points ?? [], ...newPoints],
    updatedAt: options.now
  };
  const revision = appendDefinitionRevision(updated, {
    authorNote: `剧情推演新地点：+${newRegions.length} 地区 +${newPoints.length} 地点`,
    now: options.now
  });
  if (revision.ok) updated = revision.value;
  const createdPoints = newPoints.map((p) => {
    const source = locations.find((item) => norm(item.name) === norm(p.name));
    return {
      id: p.id,
      name: p.name,
      ...source?.description ? { description: source.description } : {},
      ...source?.submap ? { submap: source.submap } : {}
    };
  });
  return {
    world: updated,
    regionsAdded: newRegions.length,
    pointsAdded: newPoints.length,
    skipped,
    regionNames: newRegions.map((r) => r.name),
    pointNames: newPoints.map((p) => p.name),
    revisionAppended: revision.ok,
    createdPoints
  };
}
function emptyMapDoc() {
  return { schemaVersion: 1, pointMeta: {}, submaps: {} };
}
function sanitizeMapDoc(raw) {
  const doc = emptyMapDoc();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return doc;
  const record = raw;
  const meta = record.pointMeta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    for (const [key, value] of Object.entries(meta).slice(0, 120)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const description = String(value.description ?? "").trim().slice(0, 300);
      if (description) doc.pointMeta[key] = { description };
    }
  }
  const submaps = record.submaps;
  if (submaps && typeof submaps === "object" && !Array.isArray(submaps)) {
    for (const [key, value] of Object.entries(submaps).slice(0, 60)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const subRecord = value;
      let scale;
      const scaleRaw = subRecord.scale;
      if (scaleRaw && typeof scaleRaw === "object" && !Array.isArray(scaleRaw)) {
        const distance = Number(scaleRaw.distancePerCell);
        if (Number.isFinite(distance) && distance > 0) {
          const unit = String(scaleRaw.unit ?? "").trim().slice(0, 12);
          scale = { distancePerCell: Math.round(distance * 100) / 100, ...unit ? { unit } : {} };
        }
      }
      const points = [];
      if (Array.isArray(subRecord.points)) {
        for (const item of subRecord.points.slice(0, SUBMAP_POINTS_MAX)) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const pointRecord = item;
          const name = String(pointRecord.name ?? "").trim().slice(0, NAME_CHARS);
          const x = Number(pointRecord.x);
          const y = Number(pointRecord.y);
          if (!name || !Number.isFinite(x) || !Number.isFinite(y)) continue;
          const description = String(pointRecord.description ?? "").trim().slice(0, 300);
          points.push({
            id: String(pointRecord.id ?? `${key}-${points.length + 1}`).slice(0, 64),
            name,
            x: Math.round(x),
            y: Math.round(y),
            ...description ? { description } : {}
          });
        }
      }
      if (points.length > 0) doc.submaps[key] = { ...scale ? { scale } : {}, points };
    }
  }
  return doc;
}
function buildSubMapFromDraft(draft, context) {
  const points = [];
  for (const item of draft.points.slice(0, SUBMAP_POINTS_MAX)) {
    const index = points.length;
    const angle = index * 2.39996;
    const radius = index === 0 ? 0 : 12 + 3.2 * Math.sqrt(index);
    const x = Math.round(Math.min(96, Math.max(4, 50 + radius * Math.cos(angle))));
    const y = Math.round(Math.min(96, Math.max(4, 50 + radius * Math.sin(angle))));
    points.push({
      id: `sub-${hashString(`${context.worldId}|${context.pointId}|${item.name}|${context.now}`)}-${index}`,
      name: item.name,
      x,
      y,
      ...item.description ? { description: item.description } : {}
    });
  }
  return { ...draft.scale ? { scale: draft.scale } : {}, points };
}

// src/atlas-turn.ts
function pointName(world, pointId) {
  if (!pointId) return null;
  const point = (world.points ?? []).find((p) => String(p.id) === String(pointId));
  return point ? point.name : null;
}
function prepareAtlasTurn(world, input) {
  const request = input.request;
  const currentTime = input.currentTime;
  if (!Number.isFinite(currentTime) || currentTime < 0) {
    throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `currentTime 非法：${String(currentTime)}`);
  }
  const relevance = computeAtlasRelevance(world, {
    at: currentTime,
    branchId: request.branchId,
    chatId: request.chatId,
    messageId: request.messageId,
    currentPointId: input.currentPointId,
    currentRegionId: input.currentRegionId,
    flags: input.flags,
    radius: input.radius,
    actorId: input.actorId ?? null
  });
  const budgetChars = Math.min(input.budgetChars ?? ATLAS_LIMITS.INJECTION_CHARS, ATLAS_LIMITS.INJECTION_CHARS);
  const plan = buildContextPlan(world, {
    purpose: "atlas-turn",
    branchId: request.branchId,
    at: currentTime,
    budgetChars
  });
  const planText = renderContextPlan(plan);
  const headerLines = [];
  const locationName = pointName(world, input.currentPointId);
  headerLines.push(`【阿特拉斯】当前位置：${locationName ?? "未知地点"}${input.currentRegionId ? `（地区 ${input.currentRegionId}）` : ""}`);
  headerLines.push(`世界时间：第 ${currentTime} 时段`);
  if (relevance.relevantNpcIds.length > 0) {
    headerLines.push(`附近人物：${relevance.relevantNpcIds.join("、")}`);
  }
  const entityRoster = [
    ...(world.characters ?? []).map((c) => ({ id: String(c.id), name: String(c.name ?? c.id) })),
    ...(world.entityRecords ?? []).map((e) => ({ id: String(e.id), name: String(e.name ?? e.id) }))
  ].slice(0, 60).map((item) => `${item.id}=${item.name}`).join("；");
  if (entityRoster) headerLines.push(`人物 id 对照：${entityRoster}`);
  const pointRoster = (world.points ?? []).slice(0, 60).map((p) => `${String(p.id)}=${p.name}`).join("；");
  if (pointRoster) headerLines.push(`地点 id 对照：${pointRoster}`);
  const regionRoster = (world.regions ?? []).slice(0, 60).map((r) => `${r.id}=${r.name}`).join("；");
  if (regionRoster) headerLines.push(`地区 id 对照：${regionRoster}`);
  const timeHint = renderAtlasTimeHint(request.userText);
  if (timeHint) headerLines.push(timeHint);
  const full = `${headerLines.join("\n")}
${planText}`;
  const injectionText = full.length <= budgetChars ? full : `${full.slice(0, budgetChars)}
【已截断：超出 ${budgetChars} 字符预算】`;
  const sourceRefs = [];
  for (const id of [...plan.sources.map((s) => s.id), ...relevance.triggerIds]) {
    if (!sourceRefs.includes(id)) sourceRefs.push(id);
  }
  let travelPreview;
  if (input.destinationPointId) {
    const preview = atlasTravelPreview(world, {
      fromPointId: String(input.currentPointId ?? ""),
      toPointId: input.destinationPointId
    });
    if (preview) travelPreview = preview;
  }
  const response = {
    turnId: `turn-${hashString(`${request.chatId}|${request.messageId}`)}`,
    injectionText,
    sourceRefs: sourceRefs.slice(0, ATLAS_LIMITS.REF_ARRAY),
    relevantNpcIds: relevance.relevantNpcIds,
    triggerIds: relevance.triggerIds,
    currentTime,
    currentLocationId: input.currentPointId,
    ...travelPreview ? { travelPreview } : {}
  };
  return { response, npcReasons: relevance.npcReasons, relevance };
}
function fail2(code, message) {
  throw new AtlasError(code, message);
}
function requireKnownPoint(world, pointId, label) {
  if (pointId === void 0 || pointId === null) return null;
  const found = (world.points ?? []).some((p) => String(p.id) === String(pointId));
  if (!found) fail2(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, `${label} 引用未知地点：${String(pointId)}`);
  return String(pointId);
}
function requireKnownRegion(world, regionId, label) {
  if (regionId === void 0 || regionId === null) return null;
  const found = (world.regions ?? []).some((r) => r.id === regionId);
  if (!found) fail2(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, `${label} 引用未知地区：${String(regionId)}`);
  return String(regionId);
}
function draftToEffects(world, draft) {
  const duration = draft.duration ?? 0;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
    fail2(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, `草稿 duration 非法：${String(duration)}`);
  }
  if (duration > ATLAS_LIMITS.TURN_DURATION_MAX) {
    fail2(ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED, `草稿 duration 超过上限 ${ATLAS_LIMITS.TURN_DURATION_MAX}`);
  }
  const summary = draft.summary.trim();
  if (!summary) fail2(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "草稿缺少摘要");
  if (summary.length > W0_LIMITS.maxStateEventSummary) {
    fail2(ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED, `草稿摘要超过上限 ${W0_LIMITS.maxStateEventSummary} 字`);
  }
  const rawEffects = Array.isArray(draft.rawEffects) ? draft.rawEffects : [];
  const memoryDrafts = Array.isArray(draft.memoryDrafts) ? draft.memoryDrafts : [];
  if (rawEffects.length + memoryDrafts.length > W0_LIMITS.maxStateEventEffects) {
    fail2(ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED, `草稿 effect 总数超过上限 ${W0_LIMITS.maxStateEventEffects}`);
  }
  const effects = [];
  rawEffects.forEach((raw, index) => {
    const parsed = parseStateEffect(raw);
    if (!parsed) fail2(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, `草稿第 ${index} 条 effect 无法解析（非白名单形状）`);
    effects.push(parsed);
  });
  for (const memory of memoryDrafts) {
    const entityId = typeof memory?.entityId === "string" ? memory.entityId : "";
    const text = typeof memory?.text === "string" ? memory.text.trim() : "";
    if (!entityId || !text) fail2(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "memoryDrafts 每条都需要 entityId 与非空 text");
    if (text.length > W0_LIMITS.maxMemoryContent) {
      fail2(ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED, `memoryDrafts.text 超过上限 ${W0_LIMITS.maxMemoryContent} 字`);
    }
    effects.push({ kind: "appendMemoryRef", entityId, text });
  }
  return { effects, at: Math.floor(duration) };
}
function referencedEntityIdsOf(effects) {
  const ids = /* @__PURE__ */ new Set();
  for (const effect of effects) {
    const record = effect;
    for (const key of ["entityId", "targetEntityId"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) ids.add(value);
    }
  }
  return ids;
}
function inferValueType(value) {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return "string[]";
  return null;
}
function provisionReferencedCharacters(world, effects, now) {
  const referenced = referencedEntityIdsOf(effects);
  if (referenced.size === 0) return world;
  const knownRecords = new Set((world.entityRecords ?? []).map((e) => String(e.id)));
  const characters = new Map((world.characters ?? []).map((c) => [String(c.id), c]));
  const toProvision = [...referenced].filter((id) => !knownRecords.has(id) && characters.has(id));
  if (toProvision.length === 0) return world;
  let next = world;
  const provisionedNames = [];
  for (const id of toProvision) {
    const character = characters.get(id);
    const upsert = upsertEntityRecord(
      next,
      {
        id,
        worldId: next.id,
        type: "npc",
        name: (String(character.name ?? "").trim() || id).slice(0, 60),
        baseline: {},
        temporalSchema: []
      },
      { now }
    );
    if (!upsert.ok) continue;
    next = upsert.value;
    provisionedNames.push(`${String(character.name ?? "").trim() || id}(${id})`);
  }
  if (provisionedNames.length === 0) return world;
  const provisionedIds = new Set(toProvision);
  for (const effect of effects) {
    if (effect.kind !== "setTemporalField") continue;
    if (!provisionedIds.has(effect.entityId)) continue;
    const record = (next.entityRecords ?? []).find((e) => e.id === effect.entityId);
    if (!record) continue;
    if (record.temporalSchema.some((f) => f.key === effect.key)) continue;
    const valueType = inferValueType(effect.value);
    if (!valueType) continue;
    const updated = {
      ...record,
      temporalSchema: [...record.temporalSchema, { key: effect.key, kind: "temporal", valueType }]
    };
    const upsert = upsertEntityRecord(next, updated, { now });
    if (upsert.ok) next = upsert.value;
  }
  const revision = appendDefinitionRevision(next, {
    authorNote: `角色自动建档（回合推演）：${provisionedNames.join("、")}`,
    now,
    changedEntityIds: [...provisionedIds].filter((id) => (next.entityRecords ?? []).some((e) => e.id === id))
  });
  if (revision.ok) next = revision.value;
  return next;
}
function commitAtlasTurn(world, input) {
  const request = input.request;
  const idempotencyKey = atlasCommitIdempotencyKey(request);
  const turnMarker = `atlas::${idempotencyKey}`;
  const branchId = input.branchId;
  if (branchId !== null && !(world.stories ?? []).some((s) => s.id === branchId)) {
    fail2(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `分支不存在：${branchId}`);
  }
  if (!Number.isFinite(input.currentTime) || input.currentTime < 0) {
    fail2(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `currentTime 非法：${String(input.currentTime)}`);
  }
  const existing = (world.stateEvents ?? []).find((e) => e.sessionId === turnMarker);
  if (existing) {
    return {
      world,
      receipt: {
        receiptId: `rcpt-${existing.id}`,
        status: "duplicate",
        branchId: existing.branchId,
        previousTime: input.currentTime,
        currentTime: existing.at,
        triggeredNpcIds: [],
        adoptedEventIds: [existing.id],
        summary: existing.narrativeSummary,
        retryable: false
      }
    };
  }
  const { effects, at: duration } = draftToEffects(world, input.draft);
  const effectiveWorld = provisionReferencedCharacters(world, effects, input.now ?? 0);
  const at = input.currentTime + duration;
  const locationChange = input.draft.locationChange ?? null;
  const toPointId = locationChange ? requireKnownPoint(world, locationChange.toPointId, "locationChange") : null;
  const toRegionId = locationChange ? requireKnownRegion(world, locationChange.toRegionId, "locationChange") : null;
  const newLocations = sanitizeNewLocations(input.draft.newLocations);
  const summary = input.draft.summary.trim();
  if (effects.length === 0) {
    const cursorAdvanced = duration > 0 || toPointId !== null || toRegionId !== null;
    let zeroWorld = effectiveWorld;
    let geoNote2 = "";
    let zeroGeo;
    if (newLocations.length > 0) {
      const geo = applyNewLocations(effectiveWorld, newLocations, { now: input.now ?? 0 });
      zeroWorld = geo.world;
      if (geo.pointsAdded + geo.regionsAdded > 0) {
        geoNote2 = `；新增地点 ${geo.pointNames.join("、")}${geo.regionNames.length > 0 ? `（地区 ${geo.regionNames.join("、")}）` : ""}`;
        zeroGeo = {
          regionsAdded: geo.regionsAdded,
          pointsAdded: geo.pointsAdded,
          createdPoints: geo.createdPoints.map((p) => ({ id: p.id, name: p.name, ...p.description ? { description: p.description } : {}, ...p.submap ? { submap: p.submap } : {} }))
        };
      }
    }
    return {
      world: zeroWorld,
      ...zeroGeo ? { geo: zeroGeo } : {},
      receipt: {
        receiptId: `rcpt-${hashString(idempotencyKey)}`,
        status: "committed",
        branchId,
        previousTime: input.currentTime,
        currentTime: at,
        previousLocationId: input.currentPointId,
        ...toPointId !== null ? { currentLocationId: toPointId } : {},
        triggeredNpcIds: [],
        adoptedEventIds: [],
        summary: cursorAdvanced ? `${summary}（本轮无实体变化：仅时间 / 位置推进，未写入账本）${geoNote2}` : geoNote2 ? `${summary}${geoNote2}` : "本轮无世界变化。",
        retryable: false
      }
    };
  }
  const pending = {
    id: turnMarker,
    summary,
    at,
    branchId,
    effects,
    origin: {
      worldId: effectiveWorld.id,
      branchId,
      definitionRevisionId: latestDefinitionRevision(effectiveWorld)?.id ?? null,
      requestId: idempotencyKey,
      ...input.now !== void 0 ? { createdAt: input.now } : {}
    },
    selected: true
  };
  const result = adoptPendingProposals(effectiveWorld, [pending], { now: input.now ?? 0, source: "ai-adopted" });
  if (!result.ok) {
    const firstReason = result.rejected.find(
      (item) => item.ok === false && item.error && item.error !== "同批存在被拒绝的提案，整单未提交"
    )?.error;
    const detail = firstReason ? ` 失败原因：${firstReason.slice(0, 300)}` : "";
    return {
      world,
      receipt: {
        receiptId: `rcpt-${hashString(idempotencyKey)}`,
        status: "failed",
        branchId,
        previousTime: input.currentTime,
        currentTime: input.currentTime,
        previousLocationId: input.currentPointId,
        currentLocationId: input.currentPointId,
        triggeredNpcIds: [],
        adoptedEventIds: [],
        summary: `${result.error ?? "写入失败"}${detail}`,
        retryable: true
      }
    };
  }
  let finalWorld = result.world;
  let geoNote = "";
  let successGeo;
  if (newLocations.length > 0) {
    const geo = applyNewLocations(result.world, newLocations, { now: input.now ?? 0 });
    finalWorld = geo.world;
    if (geo.pointsAdded + geo.regionsAdded > 0) {
      geoNote = `；新增地点 ${geo.pointNames.join("、")}${geo.regionNames.length > 0 ? `（地区 ${geo.regionNames.join("、")}）` : ""}`;
      successGeo = {
        regionsAdded: geo.regionsAdded,
        pointsAdded: geo.pointsAdded,
        createdPoints: geo.createdPoints.map((p) => ({ id: p.id, name: p.name, ...p.description ? { description: p.description } : {}, ...p.submap ? { submap: p.submap } : {} }))
      };
    }
  }
  return {
    world: finalWorld,
    ...successGeo ? { geo: successGeo } : {},
    receipt: {
      receiptId: `rcpt-${result.adopted[0]?.eventId ?? hashString(idempotencyKey)}`,
      status: "committed",
      branchId,
      previousTime: input.currentTime,
      currentTime: at,
      previousLocationId: input.currentPointId,
      ...toPointId !== null || toRegionId !== null ? { currentLocationId: toPointId ?? input.currentPointId } : {},
      triggeredNpcIds: [],
      adoptedEventIds: result.adopted.map((item) => item.eventId ?? "").filter((id) => id.length > 0),
      summary: `${summary}${geoNote}`,
      retryable: false
    }
  };
}

// src/atlas-settings.ts
var ATLAS_SETTINGS_SCHEMA_VERSION = 2;
var BUILTIN_PROMPT_PRESET_ID = "builtin-default";
var MAX_PRESETS_PER_LIBRARY = 20;
var MAX_NAME_CHARS = 64;
var MAX_ENDPOINT_CHARS = 2048;
var MAX_MODEL_CHARS = 128;
var MAX_API_KEY_CHARS = 4096;
var MIN_MAX_TOKENS = 1;
var MAX_MAX_TOKENS = 65536;
var MIN_TEMPERATURE = 0;
var MAX_TEMPERATURE = 2;
var MIN_TOP_P = 0;
var MAX_TOP_P = 1;
var MIN_TIMEOUT_MS = 1e3;
var MAX_TIMEOUT_MS = 12e4;
var MAX_PROMPT_CHARS = 8e3;
var MIN_RPM = 1;
var MAX_RPM = 600;
var ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
var CONNECTION_MODES = ["custom", "main", "profile"];
var API_FORMATS = ["openai", "openai_responses", "claude", "gemini"];
var PROMPT_POST_PROCESSING = ["", "merge_tools", "semi_tools", "strict_tools", "merge", "semi", "strict", "single"];
function normalizeConnectionMode(raw) {
  return CONNECTION_MODES.includes(raw) ? raw : "custom";
}
function normalizeApiFormat(raw) {
  if (raw === "openai_responses") return "openai";
  return API_FORMATS.includes(raw) ? raw : "openai";
}
function normalizePromptPostProcessing(raw) {
  if (typeof raw !== "string") return "strict";
  const normalized = raw.trim();
  if (normalized === "") return "";
  return PROMPT_POST_PROCESSING.includes(normalized) ? normalized : "strict";
}
var PROMPT_SEGMENT_ROLES = ["system", "user", "assistant"];
var MAX_PROMPT_SEGMENTS = 16;
function normalizePromptSegments(raw) {
  if (!Array.isArray(raw)) return [];
  const segments = [];
  for (const entry of raw.slice(0, MAX_PROMPT_SEGMENTS * 2)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry;
    const role = typeof record.role === "string" ? record.role.trim().toLowerCase() : "";
    if (!PROMPT_SEGMENT_ROLES.includes(role)) continue;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (!content) continue;
    if (segments.length >= MAX_PROMPT_SEGMENTS) break;
    const segment = { role, content: content.slice(0, MAX_PROMPT_CHARS) };
    if (typeof record.name === "string" && record.name.trim()) segment.name = record.name.trim().slice(0, 64);
    if (record.mainSlot === "A" || record.mainSlot === "B" || record.mainSlot === "") {
      segment.mainSlot = record.mainSlot;
    }
    if (record.deletable === false) segment.deletable = false;
    segments.push(segment);
  }
  return segments;
}
function nowOf(deps) {
  return deps.now ? deps.now() : 0;
}
function generateId() {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  const rand = Math.floor(Math.random() * 4294967295).toString(16);
  return `p-${Date.now().toString(36)}-${rand}`;
}
function normalizeId(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 128);
  if (!cleaned || !ID_PATTERN.test(cleaned)) return null;
  return cleaned;
}
function isFiniteIntIn(value, min, max) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= min && value <= max;
}
function isFiniteIn(value, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function isHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(value);
}
function fingerprintOfConnection(input) {
  return [input.endpoint, input.model, input.apiKey, input.maxTokens, input.temperature, input.topP, input.timeoutMs].join("\0");
}
function uniqueName(base, used) {
  const trimmed = base.trim().slice(0, MAX_NAME_CHARS) || "未命名";
  if (!used.has(trimmed)) {
    used.add(trimmed);
    return trimmed;
  }
  for (let n = 2; n < 1e3; n += 1) {
    const candidate = `${trimmed} (${n})`.slice(0, MAX_NAME_CHARS);
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  const fallback = `${trimmed} (${Date.now()})`.slice(0, MAX_NAME_CHARS);
  used.add(fallback);
  return fallback;
}
function resolveId(kind, index, fingerprint, deps, usedIds) {
  const injected = deps.legacyIdFor ? normalizeId(deps.legacyIdFor(kind, index, fingerprint)) : null;
  const base = injected ?? generateId();
  let candidate = base;
  let salt = 0;
  while (usedIds.has(candidate)) {
    salt += 1;
    candidate = normalizeId(`${base}-${salt}`) ?? `${base}-${salt}`.slice(0, 128);
  }
  usedIds.add(candidate);
  return candidate;
}
function createDefaultSettingsV2() {
  return {
    schemaVersion: ATLAS_SETTINGS_SCHEMA_VERSION,
    apiPresets: [],
    promptPresets: [],
    activeApiPresetId: null,
    activePromptPresetId: null,
    autoCommit: true,
    rpmLimit: 30,
    loreSupplementEnabled: true,
    contentReplaceRules: DEFAULT_CONTENT_REPLACE_RULES.map((rule, index) => ({
      ...rule,
      id: `cr-builtin-${index + 1}`
    }))
  };
}
function parseConnectionPreset(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw;
  const id = normalizeId(record.id);
  if (!id) return null;
  if (typeof record.name !== "string" || !record.name.trim() || record.name.length > MAX_NAME_CHARS) return null;
  const connectionMode = normalizeConnectionMode(record.connectionMode);
  const endpointOk = connectionMode !== "custom" || typeof record.endpoint === "string" && record.endpoint.length <= MAX_ENDPOINT_CHARS && isHttpUrl(record.endpoint);
  if (!endpointOk) return null;
  const modelOk = connectionMode !== "custom" || typeof record.model === "string" && !!record.model.trim() && record.model.length <= MAX_MODEL_CHARS;
  if (!modelOk) return null;
  if (typeof record.apiKey !== "string" || record.apiKey.length > MAX_API_KEY_CHARS) return null;
  if (!isFiniteIntIn(record.maxTokens, MIN_MAX_TOKENS, MAX_MAX_TOKENS)) return null;
  if (!isFiniteIn(record.temperature, MIN_TEMPERATURE, MAX_TEMPERATURE)) return null;
  if (!isFiniteIntIn(record.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)) return null;
  return {
    id,
    name: record.name.trim(),
    connectionMode,
    endpoint: typeof record.endpoint === "string" ? record.endpoint : "",
    model: typeof record.model === "string" ? record.model.trim() : "",
    apiKey: record.apiKey,
    maxTokens: record.maxTokens,
    temperature: record.temperature,
    // 0.9.14 新字段：旧存档没有 topP → 宽容回退 0.95（shujuku 同款默认），绝不因此丢条目
    topP: isFiniteIn(record.topP, MIN_TOP_P, MAX_TOP_P) ? record.topP : 0.95,
    timeoutMs: record.timeoutMs,
    ...normalizeApiFormat(record.apiFormat) !== "openai" ? { apiFormat: normalizeApiFormat(record.apiFormat) } : {},
    ...typeof record.profileId === "string" && record.profileId.trim() ? { profileId: record.profileId.trim().slice(0, 128) } : {},
    ...typeof record.bodyParams === "string" && record.bodyParams.trim() ? { bodyParams: record.bodyParams.slice(0, 4e3) } : {},
    ...typeof record.excludeBodyParams === "string" && record.excludeBodyParams.trim() ? { excludeBodyParams: record.excludeBodyParams.slice(0, 2e3) } : {},
    ...typeof record.requestHeaders === "string" && record.requestHeaders.trim() ? { requestHeaders: record.requestHeaders.slice(0, 2e3) } : {},
    ...typeof record.promptPostProcessing === "string" ? { promptPostProcessing: normalizePromptPostProcessing(record.promptPostProcessing) } : {},
    ...typeof record.systemPrompt === "string" && record.systemPrompt.trim() ? { systemPrompt: record.systemPrompt.slice(0, MAX_PROMPT_CHARS) } : {}
  };
}
function parsePromptPreset(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw;
  const id = normalizeId(record.id);
  if (!id || id === BUILTIN_PROMPT_PRESET_ID) return null;
  if (typeof record.name !== "string" || !record.name.trim() || record.name.length > MAX_NAME_CHARS) return null;
  if (typeof record.systemPrompt !== "string") return null;
  const prompt = record.systemPrompt.trim();
  const segments = normalizePromptSegments(record.segments);
  if ((!prompt || prompt.length > MAX_PROMPT_CHARS) && segments.length === 0) return null;
  return {
    id,
    name: record.name.trim(),
    systemPrompt: prompt.slice(0, MAX_PROMPT_CHARS),
    ...segments.length > 0 ? { segments } : {},
    ...normalizeContextTurnCount(record.contextTurnCount) !== null ? { contextTurnCount: normalizeContextTurnCount(record.contextTurnCount) } : {}
  };
}
function normalizeContextTurnCount(raw) {
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(value)) return null;
  const truncated = Math.trunc(value);
  return truncated >= 1 && truncated <= 10 ? truncated : null;
}
function sanitizeSettingsV2(raw, deps = {}) {
  const diagnostics = { skipped: 0, apiSkipped: 0, promptSkipped: 0, legacyMajorEventPreserved: false };
  const base = createDefaultSettingsV2();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { settings: base, diagnostics };
  const record = raw;
  const seenIds = /* @__PURE__ */ new Set();
  const apiPresets = [];
  if (Array.isArray(record.apiPresets)) {
    for (const entry of record.apiPresets.slice(0, MAX_PRESETS_PER_LIBRARY * 4)) {
      const parsed = parseConnectionPreset(entry);
      if (!parsed || seenIds.has(parsed.id)) {
        diagnostics.skipped += 1;
        diagnostics.apiSkipped += 1;
        continue;
      }
      if (apiPresets.length >= MAX_PRESETS_PER_LIBRARY) {
        diagnostics.skipped += 1;
        diagnostics.apiSkipped += 1;
        continue;
      }
      seenIds.add(parsed.id);
      const updatedAt = entry.updatedAt;
      apiPresets.push({ ...parsed, updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : nowOf(deps) });
    }
  }
  const promptPresets = [];
  if (Array.isArray(record.promptPresets)) {
    for (const entry of record.promptPresets.slice(0, MAX_PRESETS_PER_LIBRARY * 4)) {
      const parsed = parsePromptPreset(entry);
      if (!parsed || seenIds.has(parsed.id)) {
        diagnostics.skipped += 1;
        diagnostics.promptSkipped += 1;
        continue;
      }
      if (promptPresets.length >= MAX_PRESETS_PER_LIBRARY) {
        diagnostics.skipped += 1;
        diagnostics.promptSkipped += 1;
        continue;
      }
      seenIds.add(parsed.id);
      const updatedAt = entry.updatedAt;
      promptPresets.push({ ...parsed, updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : nowOf(deps) });
    }
  }
  const activeApi = normalizeId(record.activeApiPresetId);
  const activePrompt = normalizeId(record.activePromptPresetId);
  const settings = {
    schemaVersion: ATLAS_SETTINGS_SCHEMA_VERSION,
    apiPresets,
    promptPresets,
    // 悬挂引用归一为 null（= 未配置 / 内置默认），绝不回退列表首项
    activeApiPresetId: activeApi && apiPresets.some((p) => p.id === activeApi) ? activeApi : null,
    activePromptPresetId: activePrompt && promptPresets.some((p) => p.id === activePrompt) ? activePrompt : null,
    autoCommit: typeof record.autoCommit === "boolean" ? record.autoCommit : true,
    rpmLimit: isFiniteIntIn(record.rpmLimit, MIN_RPM, MAX_RPM) ? record.rpmLimit : 30,
    loreSupplementEnabled: typeof record.loreSupplementEnabled === "boolean" ? record.loreSupplementEnabled : true
  };
  if (record.contentReplaceRules === void 0) {
    settings.contentReplaceRules = base.contentReplaceRules;
  } else {
    settings.contentReplaceRules = normalizeContentReplaceRules(record.contentReplaceRules);
  }
  if ("legacyMajorEvent" in record) {
    settings.legacyMajorEvent = record.legacyMajorEvent;
    diagnostics.legacyMajorEventPreserved = record.legacyMajorEvent !== null && record.legacyMajorEvent !== void 0;
  }
  return { settings, diagnostics };
}
function parseLegacyPreset(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw;
  if (typeof record.name !== "string" || !record.name.trim() || record.name.length > MAX_NAME_CHARS) return null;
  if (typeof record.endpoint !== "string" || record.endpoint.length > MAX_ENDPOINT_CHARS || !isHttpUrl(record.endpoint)) return null;
  if (typeof record.model !== "string" || !record.model.trim() || record.model.length > MAX_MODEL_CHARS) return null;
  const apiKey = typeof record.apiKey === "string" && record.apiKey.length <= MAX_API_KEY_CHARS ? record.apiKey : null;
  if (apiKey === null) return null;
  const maxTokens = isFiniteIntIn(record.maxTokens, MIN_MAX_TOKENS, MAX_MAX_TOKENS) ? record.maxTokens : 1024;
  const temperature = isFiniteIn(record.temperature, MIN_TEMPERATURE, MAX_TEMPERATURE) ? record.temperature : 0.7;
  const timeoutMs = isFiniteIntIn(record.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS) ? record.timeoutMs : 3e4;
  const systemPrompt = typeof record.systemPrompt === "string" ? record.systemPrompt : "";
  return { name: record.name.trim(), endpoint: record.endpoint, model: record.model.trim(), apiKey, maxTokens, temperature, topP: 0.95, timeoutMs, systemPrompt };
}
function migrateAtlasSettings(raw, deps = {}) {
  const diagnostics = { skipped: 0, apiSkipped: 0, promptSkipped: 0, legacyMajorEventPreserved: false };
  const settings = createDefaultSettingsV2();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { settings, diagnostics };
  const record = raw;
  const library = record.presetLibrary && typeof record.presetLibrary === "object" && !Array.isArray(record.presetLibrary) ? record.presetLibrary : {};
  const list = [];
  if (Array.isArray(library.worldTurn)) list.push(...library.worldTurn);
  if (record.worldTurn !== void 0 && record.worldTurn !== null) list.push(record.worldTurn);
  const usedIds = /* @__PURE__ */ new Set();
  const usedApiNames = /* @__PURE__ */ new Set();
  const usedPromptNames = /* @__PURE__ */ new Set();
  const byFingerprint = /* @__PURE__ */ new Map();
  const promptByText = /* @__PURE__ */ new Map();
  let apiIndex = 0;
  for (const entry of list) {
    const legacy = parseLegacyPreset(entry);
    if (!legacy) {
      diagnostics.skipped += 1;
      diagnostics.apiSkipped += 1;
      continue;
    }
    const fingerprint = fingerprintOfConnection(legacy);
    let apiId = byFingerprint.get(fingerprint);
    if (!apiId) {
      apiId = resolveId("api", apiIndex, fingerprint, deps, usedIds);
      apiIndex += 1;
      byFingerprint.set(fingerprint, apiId);
      settings.apiPresets.push({
        id: apiId,
        name: uniqueName(legacy.name, usedApiNames),
        endpoint: legacy.endpoint,
        model: legacy.model,
        apiKey: legacy.apiKey,
        maxTokens: legacy.maxTokens,
        temperature: legacy.temperature,
        topP: legacy.topP,
        timeoutMs: legacy.timeoutMs,
        updatedAt: nowOf(deps)
      });
    }
    const isActiveSource = entry === record.worldTurn;
    if (isActiveSource) settings.activeApiPresetId = apiId;
    const promptText = legacy.systemPrompt.trim();
    if (!promptText || promptText.length > MAX_PROMPT_CHARS) continue;
    if (!promptByText.has(promptText)) {
      const promptId = resolveId("prompt", promptByText.size, promptText, deps, usedIds);
      promptByText.set(promptText, promptId);
      settings.promptPresets.push({
        id: promptId,
        name: uniqueName(`${legacy.name} · 提示词`, usedPromptNames),
        systemPrompt: promptText,
        updatedAt: nowOf(deps)
      });
    }
    if (isActiveSource) settings.activePromptPresetId = promptByText.get(promptText) ?? null;
  }
  if (settings.activeApiPresetId === null && record.worldTurn === null && settings.apiPresets.length > 0) {
    settings.activeApiPresetId = null;
  }
  const legacyMajor = [];
  if (record.majorEvent !== void 0 && record.majorEvent !== null) legacyMajor.push(record.majorEvent);
  if (Array.isArray(library.majorEvent)) legacyMajor.push(...library.majorEvent);
  if (legacyMajor.length > 0) {
    settings.legacyMajorEvent = JSON.parse(JSON.stringify(legacyMajor));
    diagnostics.legacyMajorEventPreserved = true;
  }
  if (typeof record.autoCommit === "boolean") settings.autoCommit = record.autoCommit;
  if (isFiniteIntIn(record.rpmLimit, MIN_RPM, MAX_RPM)) settings.rpmLimit = record.rpmLimit;
  if (typeof record.loreSupplementEnabled === "boolean") settings.loreSupplementEnabled = record.loreSupplementEnabled;
  return { settings, diagnostics };
}
function fail3(settings, code, message) {
  return { ok: false, settings, code, message };
}
function applySettingsCommand(settings, command, deps = {}) {
  const now = nowOf(deps);
  switch (command.action) {
    case "api.save": {
      const preset = command.preset;
      const connectionMode = normalizeConnectionMode(preset.connectionMode);
      if (typeof preset.name !== "string" || !preset.name.trim() || preset.name.length > MAX_NAME_CHARS) {
        return fail3(settings, "INVALID_PAYLOAD", "连接名称必填且不超过 64 字。");
      }
      if (connectionMode === "custom") {
        if (typeof preset.endpoint !== "string" || preset.endpoint.length > MAX_ENDPOINT_CHARS || !isHttpUrl(preset.endpoint)) {
          return fail3(settings, "INVALID_PAYLOAD", "端点必须是 http(s) 绝对地址。");
        }
        if (typeof preset.model !== "string" || !preset.model.trim() || preset.model.length > MAX_MODEL_CHARS) {
          return fail3(settings, "INVALID_PAYLOAD", "模型名必填且不超过 128 字。");
        }
      } else if (connectionMode === "profile" && !(typeof preset.profileId === "string" && !!preset.profileId.trim())) {
        return fail3(settings, "INVALID_PAYLOAD", "酒馆连接预设模式需要选择连接预设。");
      }
      if (typeof preset.bodyParams === "string" && preset.bodyParams.length > 4e3) {
        return fail3(settings, "INVALID_PAYLOAD", "附加请求体参数不超过 4000 字。");
      }
      if (typeof preset.excludeBodyParams === "string" && preset.excludeBodyParams.length > 2e3) {
        return fail3(settings, "INVALID_PAYLOAD", "排除请求体字段不超过 2000 字。");
      }
      if (typeof preset.requestHeaders === "string" && preset.requestHeaders.length > 2e3) {
        return fail3(settings, "INVALID_PAYLOAD", "附加请求标头不超过 2000 字。");
      }
      if (typeof preset.systemPrompt === "string" && preset.systemPrompt.length > MAX_PROMPT_CHARS) {
        return fail3(settings, "INVALID_PAYLOAD", `System Prompt 不超过 ${MAX_PROMPT_CHARS} 字。`);
      }
      if (!isFiniteIntIn(preset.maxTokens, MIN_MAX_TOKENS, MAX_MAX_TOKENS)) {
        return fail3(settings, "INVALID_PAYLOAD", `最大回复长度必须是 ${MIN_MAX_TOKENS}..${MAX_MAX_TOKENS} 的整数。`);
      }
      if (!isFiniteIn(preset.temperature, MIN_TEMPERATURE, MAX_TEMPERATURE)) {
        return fail3(settings, "INVALID_PAYLOAD", `温度必须在 ${MIN_TEMPERATURE}..${MAX_TEMPERATURE}。`);
      }
      if (!isFiniteIn(preset.topP, MIN_TOP_P, MAX_TOP_P)) {
        return fail3(settings, "INVALID_PAYLOAD", `top_p 必须在 ${MIN_TOP_P}..${MAX_TOP_P}。`);
      }
      if (!isFiniteIntIn(preset.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)) {
        return fail3(settings, "INVALID_PAYLOAD", `超时必须是 ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS} 毫秒。`);
      }
      const targetId = preset.id === void 0 ? null : normalizeId(preset.id);
      if (preset.id !== void 0 && targetId === null) {
        return fail3(settings, "INVALID_PAYLOAD", "预设 ID 形状非法。");
      }
      const existingIndex = targetId ? settings.apiPresets.findIndex((p) => p.id === targetId) : -1;
      if (targetId && existingIndex < 0) {
        return fail3(settings, "INVALID_PAYLOAD", "要更新的连接不存在（另存为请省略 id）。");
      }
      let apiKey;
      if (command.apiKeyMode === "keep") {
        if (existingIndex < 0) return fail3(settings, "INVALID_PAYLOAD", "新建连接必须提供密钥（可用空字符串表示无需密钥）。");
        apiKey = settings.apiPresets[existingIndex].apiKey;
      } else if (command.apiKeyMode === "clear") {
        apiKey = "";
      } else {
        const rawKey = command.apiKey ?? "";
        if (typeof rawKey !== "string" || rawKey.length > MAX_API_KEY_CHARS) {
          return fail3(settings, "INVALID_PAYLOAD", "密钥必须是字符串且不超过 4096 字。");
        }
        apiKey = rawKey;
      }
      if (existingIndex < 0 && settings.apiPresets.length >= MAX_PRESETS_PER_LIBRARY) {
        return fail3(settings, "FIELD_LIMIT_EXCEEDED", `最多保存 ${MAX_PRESETS_PER_LIBRARY} 条 API 连接。`);
      }
      const usedApiNames = new Set(settings.apiPresets.filter((_, i) => i !== existingIndex).map((p) => p.name));
      const entry = {
        id: targetId ?? resolveId("api", settings.apiPresets.length, fingerprintOfConnection({
          endpoint: preset.endpoint,
          model: preset.model,
          apiKey,
          maxTokens: preset.maxTokens,
          temperature: preset.temperature,
          topP: preset.topP,
          timeoutMs: preset.timeoutMs
        }), deps, new Set(settings.apiPresets.map((p) => p.id))),
        name: uniqueName(preset.name, usedApiNames),
        ...connectionMode !== "custom" ? { connectionMode } : {},
        endpoint: preset.endpoint,
        model: preset.model.trim(),
        apiKey,
        maxTokens: preset.maxTokens,
        temperature: preset.temperature,
        topP: preset.topP,
        timeoutMs: preset.timeoutMs,
        ...normalizeApiFormat(preset.apiFormat) !== "openai" ? { apiFormat: normalizeApiFormat(preset.apiFormat) } : {},
        ...connectionMode === "profile" && typeof preset.profileId === "string" && preset.profileId.trim() ? { profileId: preset.profileId.trim().slice(0, 128) } : {},
        ...typeof preset.bodyParams === "string" && preset.bodyParams.trim() ? { bodyParams: preset.bodyParams.slice(0, 4e3) } : {},
        ...typeof preset.excludeBodyParams === "string" && preset.excludeBodyParams.trim() ? { excludeBodyParams: preset.excludeBodyParams.slice(0, 2e3) } : {},
        ...typeof preset.requestHeaders === "string" && preset.requestHeaders.trim() ? { requestHeaders: preset.requestHeaders.slice(0, 2e3) } : {},
        ...typeof preset.promptPostProcessing === "string" ? { promptPostProcessing: normalizePromptPostProcessing(preset.promptPostProcessing) } : {},
        ...typeof preset.systemPrompt === "string" && preset.systemPrompt.trim() ? { systemPrompt: preset.systemPrompt.trim().slice(0, MAX_PROMPT_CHARS) } : {},
        updatedAt: now
      };
      const apiPresets = existingIndex >= 0 ? settings.apiPresets.map((p, i) => i === existingIndex ? entry : p) : [...settings.apiPresets, entry];
      return { ok: true, settings: { ...settings, apiPresets } };
    }
    case "api.delete": {
      const id = normalizeId(command.id);
      if (!id) return fail3(settings, "INVALID_PAYLOAD", "预设 ID 形状非法。");
      if (!settings.apiPresets.some((p) => p.id === id)) {
        return fail3(settings, "INVALID_PAYLOAD", "要删除的连接不存在。");
      }
      return {
        ok: true,
        settings: {
          ...settings,
          apiPresets: settings.apiPresets.filter((p) => p.id !== id),
          // 删除活动项必须在同一次快照里清引用
          activeApiPresetId: settings.activeApiPresetId === id ? null : settings.activeApiPresetId
        }
      };
    }
    case "api.activate": {
      if (command.id === null) return { ok: true, settings: { ...settings, activeApiPresetId: null } };
      const id = normalizeId(command.id);
      if (!id || !settings.apiPresets.some((p) => p.id === id)) {
        return fail3(settings, "INVALID_PAYLOAD", "要启用的连接不存在。");
      }
      return { ok: true, settings: { ...settings, activeApiPresetId: id } };
    }
    case "prompt.save": {
      const preset = command.preset;
      if (preset.id !== void 0 && normalizeId(preset.id) === BUILTIN_PROMPT_PRESET_ID) {
        return fail3(settings, "INVALID_PAYLOAD", "内置默认提示词不可覆盖，请另存为新预设。");
      }
      if (typeof preset.name !== "string" || !preset.name.trim() || preset.name.length > MAX_NAME_CHARS) {
        return fail3(settings, "INVALID_PAYLOAD", "提示词名称必填且不超过 64 字。");
      }
      const text = typeof preset.systemPrompt === "string" ? preset.systemPrompt.trim() : "";
      const segments = normalizePromptSegments(preset.segments);
      if (!text && segments.length === 0) return fail3(settings, "INVALID_PAYLOAD", "提示词正文不能为空（空 = 内置默认，无需保存；分段预设请至少给出 1 段）。");
      if (text.length > MAX_PROMPT_CHARS) return fail3(settings, "FIELD_LIMIT_EXCEEDED", `提示词不超过 ${MAX_PROMPT_CHARS} 字。`);
      const targetId = preset.id === void 0 ? null : normalizeId(preset.id);
      if (preset.id !== void 0 && targetId === null) return fail3(settings, "INVALID_PAYLOAD", "预设 ID 形状非法。");
      const existingIndex = targetId ? settings.promptPresets.findIndex((p) => p.id === targetId) : -1;
      if (targetId && existingIndex < 0) return fail3(settings, "INVALID_PAYLOAD", "要更新的提示词预设不存在（另存为请省略 id）。");
      if (existingIndex < 0 && settings.promptPresets.length >= MAX_PRESETS_PER_LIBRARY) {
        return fail3(settings, "FIELD_LIMIT_EXCEEDED", `最多保存 ${MAX_PRESETS_PER_LIBRARY} 条提示词预设。`);
      }
      const usedNames = new Set(settings.promptPresets.filter((_, i) => i !== existingIndex).map((p) => p.name));
      const entry = {
        id: targetId ?? resolveId("prompt", settings.promptPresets.length, text, deps, new Set(settings.promptPresets.map((p) => p.id))),
        name: uniqueName(preset.name, usedNames),
        systemPrompt: text,
        ...segments.length > 0 ? { segments } : {},
        ...normalizeContextTurnCount(preset.contextTurnCount) !== null ? { contextTurnCount: normalizeContextTurnCount(preset.contextTurnCount) } : {},
        updatedAt: now
      };
      const promptPresets = existingIndex >= 0 ? settings.promptPresets.map((p, i) => i === existingIndex ? entry : p) : [...settings.promptPresets, entry];
      return { ok: true, settings: { ...settings, promptPresets } };
    }
    case "prompt.delete": {
      const id = normalizeId(command.id);
      if (!id) return fail3(settings, "INVALID_PAYLOAD", "预设 ID 形状非法。");
      if (id === BUILTIN_PROMPT_PRESET_ID) return fail3(settings, "INVALID_PAYLOAD", "内置默认提示词不可删除。");
      if (!settings.promptPresets.some((p) => p.id === id)) return fail3(settings, "INVALID_PAYLOAD", "要删除的提示词预设不存在。");
      return {
        ok: true,
        settings: {
          ...settings,
          promptPresets: settings.promptPresets.filter((p) => p.id !== id),
          activePromptPresetId: settings.activePromptPresetId === id ? null : settings.activePromptPresetId
        }
      };
    }
    case "prompt.activate": {
      if (command.id === null) return { ok: true, settings: { ...settings, activePromptPresetId: null } };
      const id = normalizeId(command.id);
      if (!id || !settings.promptPresets.some((p) => p.id === id)) {
        return fail3(settings, "INVALID_PAYLOAD", "要启用的提示词预设不存在。");
      }
      return { ok: true, settings: { ...settings, activePromptPresetId: id } };
    }
    case "runtime.update": {
      const next = { ...settings };
      if (command.autoCommit !== void 0) {
        if (typeof command.autoCommit !== "boolean") return fail3(settings, "INVALID_PAYLOAD", "自动提交必须是布尔值。");
        next.autoCommit = command.autoCommit;
      }
      if (command.loreSupplementEnabled !== void 0) {
        if (typeof command.loreSupplementEnabled !== "boolean") return fail3(settings, "INVALID_PAYLOAD", "世界书资料开关必须是布尔值。");
        next.loreSupplementEnabled = command.loreSupplementEnabled;
      }
      if (command.rpmLimit !== void 0) {
        if (!isFiniteIntIn(command.rpmLimit, MIN_RPM, MAX_RPM)) {
          return fail3(settings, "INVALID_PAYLOAD", `RPM 上限必须是 ${MIN_RPM}..${MAX_RPM} 的整数。`);
        }
        next.rpmLimit = command.rpmLimit;
      }
      return { ok: true, settings: next };
    }
    case "replace.save": {
      const preset = command.preset;
      const name = typeof preset.name === "string" ? preset.name.trim().slice(0, MAX_NAME_CHARS) : "";
      const start = typeof preset.start === "string" ? preset.start.trim().slice(0, 256) : "";
      const end = typeof preset.end === "string" ? preset.end.trim().slice(0, 256) : "";
      if (!name || !start || !end) {
        return fail3(settings, "INVALID_PAYLOAD", "规则名称、开始词、结束词都不能为空。");
      }
      const enabled = preset.enabled !== false;
      const rules = [...settings.contentReplaceRules ?? []];
      const targetId = preset.id === void 0 ? null : normalizeId(preset.id);
      if (preset.id !== void 0 && targetId === null) {
        return fail3(settings, "INVALID_PAYLOAD", "规则 ID 形状非法。");
      }
      const existingIndex = targetId ? rules.findIndex((r) => r.id === targetId) : -1;
      if (preset.id !== void 0 && existingIndex < 0) {
        return fail3(settings, "INVALID_PAYLOAD", "要编辑的规则不存在（另存请省略 id）。");
      }
      if (existingIndex < 0 && rules.length >= MAX_REPLACE_RULES) {
        return fail3(settings, "FIELD_LIMIT_EXCEEDED", `最多保存 ${MAX_REPLACE_RULES} 条替换规则。`);
      }
      const rule = { id: targetId ?? generateId(), name, start, end, enabled };
      if (existingIndex >= 0) rules[existingIndex] = rule;
      else rules.push(rule);
      return { ok: true, settings: { ...settings, contentReplaceRules: rules } };
    }
    case "replace.delete": {
      const targetId = normalizeId(command.id);
      if (!targetId) return fail3(settings, "INVALID_PAYLOAD", "规则 ID 形状非法。");
      const rules = (settings.contentReplaceRules ?? []).filter((r) => r.id !== targetId);
      if (rules.length === (settings.contentReplaceRules ?? []).length) {
        return fail3(settings, "INVALID_PAYLOAD", "要删除的规则不存在。");
      }
      return { ok: true, settings: { ...settings, contentReplaceRules: rules } };
    }
    case "replace.reset": {
      return { ok: true, settings: { ...settings, contentReplaceRules: createDefaultSettingsV2().contentReplaceRules } };
    }
    default:
      return fail3(settings, "INVALID_PAYLOAD", "未知的设置命令。");
  }
}
function applyLegacySettingsPatch(settings, body, deps = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail3(settings, "INVALID_PAYLOAD", "设置必须是对象");
  }
  const record = body;
  const now = nowOf(deps);
  let next = { ...settings };
  const usedIds = new Set(next.apiPresets.map((p) => p.id));
  const usedPromptIds = new Set(next.promptPresets.map((p) => p.id));
  const upsertConnection = (legacy) => {
    const fingerprint = fingerprintOfConnection(legacy);
    const existing = next.apiPresets.find((p) => fingerprintOfConnection({
      endpoint: p.endpoint,
      model: p.model,
      apiKey: p.apiKey,
      maxTokens: p.maxTokens,
      temperature: p.temperature,
      topP: typeof p.topP === "number" ? p.topP : 0.95,
      timeoutMs: p.timeoutMs
    }) === fingerprint);
    if (existing) return existing.id;
    if (next.apiPresets.length >= MAX_PRESETS_PER_LIBRARY) return null;
    const id = resolveId("api", next.apiPresets.length, fingerprint, deps, usedIds);
    const names = new Set(next.apiPresets.map((p) => p.name));
    next = {
      ...next,
      apiPresets: [...next.apiPresets, {
        id,
        name: uniqueName(legacy.name, names),
        endpoint: legacy.endpoint,
        model: legacy.model,
        apiKey: legacy.apiKey,
        maxTokens: legacy.maxTokens,
        temperature: legacy.temperature,
        topP: typeof legacy.topP === "number" ? legacy.topP : 0.95,
        timeoutMs: legacy.timeoutMs,
        updatedAt: now
      }]
    };
    return id;
  };
  const upsertPrompt = (legacy) => {
    const text = legacy.systemPrompt.trim();
    if (!text || text.length > MAX_PROMPT_CHARS) return null;
    const existing = next.promptPresets.find((p) => p.systemPrompt === text);
    if (existing) return existing.id;
    if (next.promptPresets.length >= MAX_PRESETS_PER_LIBRARY) return null;
    const id = resolveId("prompt", next.promptPresets.length, text, deps, usedPromptIds);
    const names = new Set(next.promptPresets.map((p) => p.name));
    next = {
      ...next,
      promptPresets: [...next.promptPresets, {
        id,
        name: uniqueName(`${legacy.name} · 提示词`, names),
        systemPrompt: text,
        updatedAt: now
      }]
    };
    return id;
  };
  const library = record.presetLibrary && typeof record.presetLibrary === "object" && !Array.isArray(record.presetLibrary) ? record.presetLibrary : null;
  if (library && Array.isArray(library.worldTurn)) {
    for (const entry of library.worldTurn) {
      const legacy = parseLegacyPreset(entry);
      if (!legacy) return fail3(settings, "INVALID_PAYLOAD", "presetLibrary.worldTurn 存在非法预设（name / endpoint / model / apiKey 或数值超限）");
      upsertConnection(legacy);
      upsertPrompt(legacy);
    }
  }
  const legacyMajor = [];
  if (record.majorEvent !== void 0 && record.majorEvent !== null) legacyMajor.push(record.majorEvent);
  if (library && Array.isArray(library.majorEvent)) legacyMajor.push(...library.majorEvent);
  if (legacyMajor.length > 0) {
    next = { ...next, legacyMajorEvent: JSON.parse(JSON.stringify(legacyMajor)) };
  }
  if (record.worldTurn !== void 0) {
    if (record.worldTurn === null) {
      next = { ...next, activeApiPresetId: null, activePromptPresetId: null };
    } else {
      const legacy = parseLegacyPreset(record.worldTurn);
      if (!legacy) return fail3(settings, "INVALID_PAYLOAD", "worldTurn 预设字段非法（name / endpoint / model / apiKey 或数值超限）");
      const apiId = upsertConnection(legacy);
      if (!apiId) return fail3(settings, "FIELD_LIMIT_EXCEEDED", `最多保存 ${MAX_PRESETS_PER_LIBRARY} 条 API 连接。`);
      const promptId = upsertPrompt(legacy);
      next = { ...next, activeApiPresetId: apiId, activePromptPresetId: promptId };
    }
  }
  if (record.autoCommit !== void 0) {
    if (typeof record.autoCommit !== "boolean") return fail3(settings, "INVALID_PAYLOAD", "autoCommit 必须是布尔值");
    next = { ...next, autoCommit: record.autoCommit };
  }
  if (record.loreSupplementEnabled !== void 0) {
    if (typeof record.loreSupplementEnabled !== "boolean") return fail3(settings, "INVALID_PAYLOAD", "loreSupplementEnabled 必须是布尔值");
    next = { ...next, loreSupplementEnabled: record.loreSupplementEnabled };
  }
  if (record.rpmLimit !== void 0) {
    if (!isFiniteIntIn(record.rpmLimit, MIN_RPM, MAX_RPM)) return fail3(settings, "INVALID_PAYLOAD", "rpmLimit 必须是 1..600 的数字");
    next = { ...next, rpmLimit: record.rpmLimit };
  }
  return { ok: true, settings: next };
}
function settingsViewV2(settings) {
  const activeApi = settings.activeApiPresetId && settings.apiPresets.some((p) => p.id === settings.activeApiPresetId) ? settings.activeApiPresetId : null;
  const activePrompt = settings.activePromptPresetId && settings.promptPresets.some((p) => p.id === settings.activePromptPresetId) ? settings.activePromptPresetId : null;
  return {
    schemaVersion: ATLAS_SETTINGS_SCHEMA_VERSION,
    apiPresets: settings.apiPresets.map((p) => {
      const key = p.apiKey ?? "";
      return {
        id: p.id,
        name: p.name,
        connectionMode: normalizeConnectionMode(p.connectionMode),
        endpoint: p.endpoint,
        model: p.model,
        maxTokens: p.maxTokens,
        temperature: p.temperature,
        topP: typeof p.topP === "number" ? p.topP : 0.95,
        timeoutMs: p.timeoutMs,
        apiFormat: normalizeApiFormat(p.apiFormat),
        profileId: p.profileId ?? "",
        bodyParams: p.bodyParams ?? "",
        excludeBodyParams: p.excludeBodyParams ?? "",
        requestHeaders: p.requestHeaders ?? "",
        promptPostProcessing: normalizePromptPostProcessing(p.promptPostProcessing),
        systemPrompt: p.systemPrompt ?? "",
        // 0.9.12（作者令，照抄 shujuku）：GET 返回明文密钥，编辑器回填 / 测试连接复用，不再每次重输
        apiKey: key
      };
    }),
    promptPresets: settings.promptPresets.map((p) => ({ ...p })),
    activeApiPresetId: activeApi,
    activePromptPresetId: activePrompt,
    builtInPrompt: {
      id: BUILTIN_PROMPT_PRESET_ID,
      name: "内置默认",
      readOnly: true,
      systemPrompt: DEFAULT_WORLD_TURN_SYSTEM_PROMPT,
      // 0.9.40（作者反馈「怎么还是长这样」）：内置默认以只读分段展示，
      // 让 0.9.39 的 8 段多轮结构在推进页直接可见、可复制
      segments: DEFAULT_PROMPT_SEGMENTS.map((s) => ({ ...s }))
    },
    autoCommit: settings.autoCommit,
    loreSupplementEnabled: settings.loreSupplementEnabled ?? true,
    rpmLimit: settings.rpmLimit,
    contentReplaceRules: settings.contentReplaceRules ?? []
  };
}
function resolveWorldTurnPreset(settings) {
  const connection = settings.apiPresets.find((p) => p.id === settings.activeApiPresetId);
  if (!connection) return null;
  const prompt = settings.promptPresets.find((p) => p.id === settings.activePromptPresetId);
  const mode = normalizeConnectionMode(connection.connectionMode);
  const format = normalizeApiFormat(connection.apiFormat);
  const connectionPrompt = typeof connection.systemPrompt === "string" ? connection.systemPrompt.trim() : "";
  return {
    name: connection.name,
    endpoint: connection.endpoint,
    model: connection.model,
    apiKey: connection.apiKey,
    maxTokens: connection.maxTokens,
    temperature: connection.temperature,
    topP: typeof connection.topP === "number" ? connection.topP : 0.95,
    timeoutMs: connection.timeoutMs,
    ...mode !== "custom" ? { connectionMode: mode } : {},
    ...format !== "openai" ? { apiFormat: format } : {},
    ...mode === "profile" && connection.profileId ? { profileId: connection.profileId } : {},
    ...connection.bodyParams ? { bodyParams: connection.bodyParams } : {},
    ...connection.excludeBodyParams ? { excludeBodyParams: connection.excludeBodyParams } : {},
    ...connection.requestHeaders ? { requestHeaders: connection.requestHeaders } : {},
    ...normalizePromptPostProcessing(connection.promptPostProcessing) ? { promptPostProcessing: normalizePromptPostProcessing(connection.promptPostProcessing) } : {},
    // 0.9.18 systemPrompt 优先级：连接级覆盖 > 提示词预设分段模式 > 提示词预设单条 > 空（内置默认兜底）
    ...connectionPrompt ? { systemPrompt: connectionPrompt } : prompt && prompt.segments && prompt.segments.length > 0 ? { promptSegments: prompt.segments } : prompt ? { systemPrompt: prompt.systemPrompt } : {},
    // 0.9.25 shujuku contextTurnCount：$7 前文条数（预设级设置，缺省 3 由引擎侧兜底）
    ...prompt?.contextTurnCount ? { contextTurnCount: prompt.contextTurnCount } : {}
  };
}

// src/atlas-server.ts
var ATLAS_SESSION_SCHEMA_VERSION = 1;
var SESSION_TURNS_MAX = 2e3;
function createEmptySessionDoc() {
  return {
    schemaVersion: ATLAS_SESSION_SCHEMA_VERSION,
    rev: 0,
    binding: null,
    world: null,
    maps: null,
    turns: {},
    geoAuto: {}
  };
}
function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseAtlasSessionDoc(raw) {
  const session = createEmptySessionDoc();
  if (!isPlainRecord(raw) || raw.schemaVersion !== ATLAS_SESSION_SCHEMA_VERSION) return session;
  session.rev = typeof raw.rev === "number" && Number.isFinite(raw.rev) && raw.rev >= 0 ? Math.floor(raw.rev) : 0;
  if (isPlainRecord(raw.turns)) {
    for (const [key, value] of Object.entries(raw.turns).slice(0, SESSION_TURNS_MAX)) {
      if (key) session.turns[key] = value;
    }
  }
  if (isPlainRecord(raw.geoAuto)) {
    for (const [key, value] of Object.entries(raw.geoAuto)) {
      if (key) session.geoAuto[key] = value;
    }
  }
  session.binding = raw.binding ?? null;
  session.world = raw.world ?? null;
  session.maps = raw.maps ?? null;
  return session;
}
function cloneSessionDoc(session) {
  try {
    return JSON.parse(JSON.stringify(session));
  } catch {
    return createEmptySessionDoc();
  }
}
function idOfDoc(value) {
  if (!isPlainRecord(value)) return "";
  const id = value.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : "";
}
function chatIdOfBinding(binding) {
  if (!isPlainRecord(binding)) return "";
  const chatId = binding.chatId;
  return typeof chatId === "string" ? chatId : "";
}
function createSessionOverlayStore(session, fallback) {
  let mutated = false;
  const OWNED_PREFIXES = ["world:", "binding:", "maps:", "geo-auto:", "turn:"];
  function worldName() {
    return session.world !== null ? `world:${idOfDoc(session.world)}` : null;
  }
  function bindingName() {
    return session.binding !== null ? `binding:${chatIdOfBinding(session.binding)}` : null;
  }
  function mapsName() {
    if (session.maps === null) return null;
    const worldId = idOfDoc(session.world);
    return worldId ? `maps:${worldId}` : null;
  }
  return {
    changed() {
      return mutated;
    },
    async read(name) {
      if (name === "settings" || name.startsWith("pending:")) return fallback.read(name);
      if (name.startsWith("world:")) {
        const current = worldName();
        return current === name ? session.world : null;
      }
      if (name.startsWith("binding:")) {
        const current = bindingName();
        return current === name ? session.binding : null;
      }
      if (name.startsWith("maps:")) {
        const current = mapsName();
        return current === name ? session.maps : null;
      }
      if (name.startsWith("geo-auto:")) {
        const worldId = name.slice("geo-auto:".length);
        return worldId in session.geoAuto ? session.geoAuto[worldId] : null;
      }
      if (name.startsWith("turn:")) {
        return name in session.turns ? session.turns[name] : null;
      }
      return fallback.read(name);
    },
    async write(name, value) {
      if (name === "settings" || name.startsWith("pending:")) return fallback.write(name, value);
      if (name.startsWith("world:")) {
        const id = name.slice("world:".length);
        const currentId = idOfDoc(session.world);
        if (session.world !== null && currentId !== id) {
          throw new AtlasError(
            ATLAS_ERROR_CODES.INVALID_PAYLOAD,
            "当前聊天会话已包含另一个世界，拒绝覆盖；请先解绑再导入 / 初始化。"
          );
        }
        session.world = value;
        mutated = true;
        return;
      }
      if (name.startsWith("binding:")) {
        session.binding = value;
        mutated = true;
        return;
      }
      if (name.startsWith("maps:")) {
        const worldId = name.slice("maps:".length);
        const currentId = idOfDoc(session.world);
        if (session.world !== null && currentId !== worldId) {
          throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "地图文档与当前会话世界不一致，拒绝写入。");
        }
        session.maps = value;
        mutated = true;
        return;
      }
      if (name.startsWith("geo-auto:")) {
        session.geoAuto[name.slice("geo-auto:".length)] = value;
        mutated = true;
        return;
      }
      if (name.startsWith("turn:")) {
        if (!(name in session.turns) && Object.keys(session.turns).length >= SESSION_TURNS_MAX) {
          throw new AtlasError(ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED, `会话回合映射超过 ${SESSION_TURNS_MAX} 条上限。`);
        }
        session.turns[name] = value;
        mutated = true;
        return;
      }
      return fallback.write(name, value);
    },
    async remove(name) {
      if (name === "settings" || name.startsWith("pending:")) return fallback.remove(name);
      if (name.startsWith("binding:")) {
        session.binding = null;
        mutated = true;
        return;
      }
      if (name.startsWith("world:")) {
        if (worldName() === name) {
          session.world = null;
          mutated = true;
        }
        return;
      }
      if (name.startsWith("maps:")) {
        if (mapsName() === name) {
          session.maps = null;
          mutated = true;
        }
        return;
      }
      if (name.startsWith("geo-auto:")) {
        const worldId = name.slice("geo-auto:".length);
        if (worldId in session.geoAuto) {
          delete session.geoAuto[worldId];
          mutated = true;
        }
        return;
      }
      if (name.startsWith("turn:")) {
        if (name in session.turns) {
          delete session.turns[name];
          mutated = true;
        }
        return;
      }
      return fallback.remove(name);
    },
    async list(prefix) {
      if (prefix === "settings" || prefix.startsWith("pending:")) return fallback.list(prefix);
      if (OWNED_PREFIXES.some((p) => prefix.startsWith(p))) {
        const names = [];
        if (prefix.startsWith("turn:")) {
          for (const key of Object.keys(session.turns)) {
            if (key.startsWith(prefix)) names.push(key);
          }
        }
        const world = worldName();
        if (world && world.startsWith(prefix)) names.push(world);
        const binding = bindingName();
        if (binding && binding.startsWith(prefix)) names.push(binding);
        const maps = mapsName();
        if (maps && maps.startsWith(prefix)) names.push(maps);
        for (const worldId of Object.keys(session.geoAuto)) {
          const name = `geo-auto:${worldId}`;
          if (name.startsWith(prefix)) names.push(name);
        }
        return names.sort();
      }
      return fallback.list(prefix);
    }
  };
}
var SETTINGS_DOC = "settings";
var RPM_WINDOW_MS = 6e4;
var ATLAS_SESSION_ROUTES = /* @__PURE__ */ new Set([
  "POST /worlds/import",
  "POST /worlds/ensure-starter",
  "POST /worlds/geo/adopt",
  "POST /worlds/move-author",
  "POST /bindings",
  "POST /state",
  "POST /map/image",
  "POST /turns/prepare",
  "POST /turns/commit",
  "POST /turns/retry",
  "POST /turns/restore",
  "POST /turns/rollback",
  "POST /map/travel-preview"
]);
var MAP_POINTS_MAX = 200;
var MAP_POINT_NAME_CHARS = 80;
function httpStatusFor(code) {
  switch (code) {
    case ATLAS_ERROR_CODES.INVALID_PAYLOAD:
    case ATLAS_ERROR_CODES.PROTOCOL_INCOMPATIBLE:
    case ATLAS_ERROR_CODES.NOT_BOUND:
      return 400;
    case ATLAS_ERROR_CODES.FORBIDDEN:
      return 403;
    case ATLAS_ERROR_CODES.WORLD_NOT_FOUND:
      return 404;
    case ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED:
      return 413;
    case ATLAS_ERROR_CODES.API_NOT_CONFIGURED:
    case ATLAS_ERROR_CODES.DUPLICATE_COMMIT:
    case ATLAS_ERROR_CODES.SESSION_STALE:
      return 409;
    case ATLAS_ERROR_CODES.API_RATE_LIMITED:
      return 429;
    case ATLAS_ERROR_CODES.API_TIMEOUT:
      return 504;
    case ATLAS_ERROR_CODES.RESPONSE_MALFORMED:
    case ATLAS_ERROR_CODES.API_AUTH_FAILED:
    case ATLAS_ERROR_CODES.API_NOT_FOUND:
    case ATLAS_ERROR_CODES.API_REQUEST_FAILED:
      return 502;
    case ATLAS_ERROR_CODES.SERVICE_OFFLINE:
      return 503;
    case ATLAS_ERROR_CODES.WRITE_FAILED:
      return 500;
    default:
      return 500;
  }
}
function okResult(data) {
  return { status: 200, body: { ok: true, data } };
}
function errorResult(thrown) {
  const error = toSerializedError(thrown);
  return { status: httpStatusFor(error.code), body: { ok: false, error } };
}
async function withSharedMutex(map, key, task) {
  const previous = map.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  map.set(
    key,
    next.then(
      () => void 0,
      () => void 0
    )
  );
  return next;
}
function createCoreInstance(store, deps, shared) {
  const now = deps.now ?? Date.now;
  let settings = createDefaultSettingsV2();
  let settingsLoaded = false;
  const worldCache = /* @__PURE__ */ new Map();
  const bindingCache = /* @__PURE__ */ new Map();
  const receiptCache = /* @__PURE__ */ new Map();
  const queues = /* @__PURE__ */ new Map();
  const rpmTimestamps = shared.rpmTimestamps;
  function pushLog(entry) {
    const logs = shared.logs;
    logs.push(entry);
    if (logs.length > 200) logs.shift();
  }
  async function loadSettings() {
    if (shared.settingsOverride) return shared.settingsOverride;
    if (settingsLoaded) return settings;
    const raw = await store.read(SETTINGS_DOC);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw;
      if (record.schemaVersion === ATLAS_SETTINGS_SCHEMA_VERSION) {
        const sanitized = sanitizeSettingsV2(record, { now });
        settings = sanitized.settings;
        if (sanitized.diagnostics.skipped > 0) {
          pushLog({ at: now(), kind: "settings-sanitize", skipped: sanitized.diagnostics.skipped });
        }
      } else {
        const migrated = migrateAtlasSettings(record, { now });
        settings = migrated.settings;
        pushLog({
          at: now(),
          kind: "settings-migrate",
          from: typeof record.schemaVersion === "number" ? record.schemaVersion : "unknown",
          to: ATLAS_SETTINGS_SCHEMA_VERSION,
          apiPresets: migrated.settings.apiPresets.length,
          promptPresets: migrated.settings.promptPresets.length,
          skipped: migrated.diagnostics.skipped
        });
      }
    }
    settingsLoaded = true;
    return settings;
  }
  async function persistSettings(next) {
    await store.write(SETTINGS_DOC, next);
    settings = next;
    settingsLoaded = true;
    return settings;
  }
  async function getWorld(worldId) {
    if (worldCache.has(worldId)) return worldCache.get(worldId);
    const raw = await store.read(`world:${worldId}`);
    const world = raw ? parseWorld(raw) : null;
    worldCache.set(worldId, world);
    return world;
  }
  async function getBinding(chatId) {
    if (bindingCache.has(chatId)) return bindingCache.get(chatId);
    const raw = await store.read(`binding:${chatId}`);
    if (!raw) {
      bindingCache.set(chatId, null);
      return null;
    }
    const parsed = parseAtlasChatBinding(raw);
    const binding = parsed.ok ? parsed.value : null;
    bindingCache.set(chatId, binding);
    return binding;
  }
  function flagsFor(world, branchId, at) {
    const flags = [];
    for (const event of ledgerForBranch(world, branchId)) {
      if (event.at > at) continue;
      for (const effect of event.effects) {
        if (effect.kind === "setFlag" && !flags.includes(effect.key)) flags.push(effect.key);
      }
    }
    return flags;
  }
  function requireBoundBinding(binding) {
    if (!binding || !binding.enabled) {
      throw new AtlasError(ATLAS_ERROR_CODES.NOT_BOUND, "当前聊天未绑定 Atlas 世界。");
    }
    return binding;
  }
  async function requireWorld(binding) {
    const world = await getWorld(binding.worldId);
    if (!world) throw new AtlasError(ATLAS_ERROR_CODES.WORLD_NOT_FOUND, `绑定的世界不存在：${binding.worldId}`);
    return world;
  }
  function pointRegionId(world, pointId) {
    if (!pointId) return null;
    return (world.points ?? []).find((p) => String(p.id) === String(pointId))?.regionId ?? null;
  }
  function checkRpm() {
    const { rpmLimit } = settings;
    const windowStart = now() - RPM_WINDOW_MS;
    while (rpmTimestamps.length > 0 && rpmTimestamps[0] < windowStart) rpmTimestamps.shift();
    if (rpmTimestamps.length >= rpmLimit) {
      throw new AtlasError(ATLAS_ERROR_CODES.API_RATE_LIMITED, `推演请求超过每分钟 ${rpmLimit} 次限额，请稍后再试。`);
    }
  }
  function enqueue(chatId, task) {
    const previous = queues.get(chatId) ?? Promise.resolve();
    const next = previous.then(task, task);
    queues.set(
      chatId,
      next.catch(() => void 0)
    );
    return next;
  }
  async function handleHealth() {
    return okResult({
      ok: true,
      plugin: "atlas",
      // 0.9.18 起与 ATLAS_PLUGIN_VERSION 同步（此前自 0.9.2 起一直烂着没人查——
      // tests/atlas-server-plugin.test.mjs 的 health 版本一致性断言防再犯）
      version: "0.9.46",
      protocolVersion: 1,
      time: now()
    });
  }
  async function handleGetSettings() {
    const current = await loadSettings();
    return okResult(settingsViewV2(current));
  }
  async function handlePutSettings(body, ctx) {
    if (!ctx.local) throw new AtlasError(ATLAS_ERROR_CODES.FORBIDDEN, "只有本机已登录会话可以修改 Atlas 设置。");
    const current = await loadSettings();
    const isCommand = Boolean(body) && typeof body === "object" && !Array.isArray(body) && typeof body.action === "string";
    const result = isCommand ? applySettingsCommand(current, body, { now }) : applyLegacySettingsPatch(current, body, { now });
    if (!result.ok) {
      throw new AtlasError(
        result.code === "FIELD_LIMIT_EXCEEDED" ? ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED : ATLAS_ERROR_CODES.INVALID_PAYLOAD,
        result.message ?? "设置更新被拒绝。"
      );
    }
    const saved = await persistSettings(result.settings);
    if (!isCommand) {
      pushLog({ at: now(), kind: "settings-legacy-patch", apiPresets: saved.apiPresets.length });
    }
    return okResult(settingsViewV2(saved));
  }
  function worldSummary(world) {
    return {
      id: world.id,
      name: world.name,
      pointCount: (world.points ?? []).length,
      regionCount: (world.regions ?? []).length,
      characterCount: (world.characters ?? []).length,
      branchCount: (world.stories ?? []).length,
      updatedAt: world.updatedAt
    };
  }
  async function handleListWorlds() {
    const names = await store.list("world:");
    const summaries = [];
    for (const name of names.slice(0, 200)) {
      const worldId = name.slice("world:".length);
      const world = await getWorld(worldId);
      if (world) summaries.push(worldSummary(world));
    }
    return okResult({ worlds: summaries });
  }
  async function handleImportWorld(body, ctx) {
    if (!ctx.local) throw new AtlasError(ATLAS_ERROR_CODES.FORBIDDEN, "只有本机已登录会话可以导入 Atlas 世界。");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "导入请求必须是对象");
    }
    const parsed = parseWorld(body.world);
    if (!parsed) throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "世界数据无法通过 schema 校验，已拒绝导入。");
    await store.write(`world:${parsed.id}`, parsed);
    worldCache.set(parsed.id, parsed);
    return okResult(worldSummary(parsed));
  }
  async function handleEnsureStarter(body, ctx) {
    if (!ctx.local) throw new AtlasError(ATLAS_ERROR_CODES.FORBIDDEN, "只有本机已登录会话可以初始化 Atlas 世界。");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "ensure-starter 请求必须是对象");
    }
    const parsed = parseWorld(body.world);
    if (!parsed) throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "自动建世数据无法通过 schema 校验，已拒绝。");
    return withSharedMutex(shared.ensureMutex, `ensure:${parsed.id}`, async () => {
      const existing = await getWorld(parsed.id);
      if (existing) {
        return okResult({ created: false, world: worldSummary(existing) });
      }
      await store.write(`world:${parsed.id}`, parsed);
      worldCache.set(parsed.id, parsed);
      return okResult({ created: true, world: worldSummary(parsed) });
    });
  }
  const GEO_LIMITS = { REGIONS_MAX: 12, POINTS_MAX: 40, NAME_CHARS: 40, DESC_CHARS: 300 };
  async function handleGeoAdopt(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "geo/adopt 请求必须是对象");
    }
    const record = body;
    const chatId = typeof record.chatId === "string" ? record.chatId : "";
    if (!chatId || chatId.length > ATLAS_LIMITS.ID_CHARS) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "chatId 非法");
    }
    const lore = typeof record.loreSupplement === "string" ? record.loreSupplement.trim() : "";
    const recentTexts = Array.isArray(record.recentTexts) ? record.recentTexts.filter((item) => typeof item === "string" && item.trim().length > 0).slice(0, 10).map((item) => item.slice(0, 2e3)) : [];
    const storyMode = recentTexts.length > 0;
    if (!lore && !storyMode) {
      throw new AtlasError(
        ATLAS_ERROR_CODES.INVALID_PAYLOAD,
        "没有可用的提炼素材——剧情模式需要近期 AI 楼层，世界书模式需要卡书启用条目（或「世界书资料」开关未关闭）。"
      );
    }
    const binding = requireBoundBinding(await getBinding(chatId));
    const world = await requireWorld(binding);
    const current = await loadSettings();
    const preset = resolveWorldTurnPreset(current);
    if (!preset) {
      throw new AtlasError(ATLAS_ERROR_CODES.API_NOT_CONFIGURED, "未配置推演 API，无法提炼地理。");
    }
    checkRpm();
    rpmTimestamps.push(now());
    const outcome = await runGeoExtraction({ world, preset, lore, recentTexts, source: "manual" });
    if (outcome.regionsAdded === 0 && outcome.pointsAdded === 0) {
      return okResult({
        regionsAdded: 0,
        pointsAdded: 0,
        skipped: outcome.skipped,
        message: "没有提炼出新的地理实体（可能都已存在，或资料里没有地理描述）。"
      });
    }
    return okResult({
      regionsAdded: outcome.regionsAdded,
      pointsAdded: outcome.pointsAdded,
      skipped: outcome.skipped,
      revisionAppended: outcome.revisionAppended,
      regionNames: outcome.regionNames,
      pointNames: outcome.pointNames
    });
  }
  async function runGeoExtraction(input) {
    const world = input.world;
    const preset = input.preset;
    const lore = input.lore;
    const recentTexts = input.recentTexts;
    const storyMode = recentTexts.length > 0;
    const contractRule = '只输出一个 JSON 对象：{"regions":[{"name":"...","description":"..."}],"points":[{"name":"...","regionName":"..."}]}';
    const commonRules = '规则：name ≤20 字；regionName 必须是 regions 里出现过的名字（没有合适地区就省略该字段）；只提炼明确或强烈暗示的地理实体——城市 / 森林 / 遗迹 / 建筑等，教室 / 学校 / 商店 / 车站等剧情人物真实所处的具体场所也算地点（校园日常类故事尤其如此），角色、文风、格式规则一律不要；宁缺毋滥；最多 12 个地区、40 个地点；没有地理信息就输出 {"regions":[],"points":[]}。';
    const existingGeoNames = [
      ...(world.regions ?? []).map((r) => String(r.name)),
      ...(world.points ?? []).map((p) => String(p.name))
    ].slice(0, 60);
    const userContent = storyMode ? [
      "从下面的近期剧情中提炼**剧情里新出现或被明确抵达 / 提及**的地点与地区（已有地点名单里的不要重复输出）。",
      contractRule,
      commonRules,
      ...existingGeoNames.length > 0 ? [`已有地理（禁止重复输出这些名字）：${existingGeoNames.join("、")}`] : [],
      ...lore ? ["【世界书背景资料（帮助理解地名归属，不要从中提炼——只提炼剧情里的）】", lore.slice(0, ATLAS_LIMITS.LORE_SUPPLEMENT_CHARS)] : [],
      "【近期剧情（AI 输出，按时间先后）】",
      recentTexts.join("\n---\n").slice(0, ATLAS_LIMITS.LORE_SUPPLEMENT_CHARS)
    ].join("\n") : [
      "从下面的角色卡世界书资料中提炼「地区 / 地点」。",
      contractRule,
      commonRules,
      "【世界书资料】",
      lore.slice(0, ATLAS_LIMITS.LORE_SUPPLEMENT_CHARS)
    ].join("\n");
    const extractionSegments = [
      {
        role: "system",
        content: "你是地理信息抽取器。只输出一个 JSON 对象，不输出任何其它文字、解释或代码围栏。"
      },
      { role: "user", content: userContent }
    ];
    const call = await callAtlasWorldTurnApi(
      { ...preset, promptSegments: extractionSegments },
      { injectionText: "", userText: "", assistantText: "" },
      { fetchFn: deps.fetchFn, now }
    );
    pushLog({
      at: now(),
      kind: "world-geo-extract",
      presetName: preset.name,
      model: preset.model,
      ok: call.ok,
      status: call.status,
      durationMs: call.durationMs
    });
    if (!call.ok) {
      throw new AtlasError(call.code, call.message, { retryable: call.retryable });
    }
    const spec = extractJsonObject(call.text);
    if (!spec) {
      pushLog({
        at: now(),
        kind: "world-geo-extract-fallback",
        worldId: world.id,
        source: input.source,
        excerpt: call.text.slice(0, 1500)
      });
      return { regionsAdded: 0, pointsAdded: 0, skipped: 0, revisionAppended: false, regionNames: [], pointNames: [] };
    }
    const cleanName = (value) => {
      const text = String(value ?? "").trim().replace(/\s+/g, " ");
      return text ? text.slice(0, GEO_LIMITS.NAME_CHARS) : null;
    };
    const cleanDesc = (value) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, GEO_LIMITS.DESC_CHARS);
    const norm = (text) => text.toLowerCase();
    const existingRegionNames = new Set((world.regions ?? []).map((r) => norm(String(r.name))));
    const existingPointNames = new Set((world.points ?? []).map((p) => norm(String(p.name))));
    const regionIdByName = new Map((world.regions ?? []).map((r) => [norm(String(r.name)), String(r.id)]));
    let skipped = 0;
    const newRegions = [];
    for (const raw of (Array.isArray(spec.regions) ? spec.regions : []).slice(0, GEO_LIMITS.REGIONS_MAX + 8)) {
      if (newRegions.length >= GEO_LIMITS.REGIONS_MAX) break;
      const name = cleanName(raw?.name);
      if (!name || existingRegionNames.has(norm(name)) || newRegions.some((r) => norm(r.name) === norm(name))) {
        skipped += 1;
        continue;
      }
      const id = `geo-r-${hashString(`${world.id}|r|${name}|${now()}`)}`;
      newRegions.push({ id, worldId: world.id, name, type: "other", description: cleanDesc(raw?.description) || "由世界书提炼。", coordinates: { x: 0, y: 0 } });
      regionIdByName.set(norm(name), id);
    }
    let nextPointId = (world.points ?? []).reduce((max, p) => Math.max(max, Number(p.id) || 0), 0) + 1;
    const newPoints = [];
    for (const raw of (Array.isArray(spec.points) ? spec.points : []).slice(0, GEO_LIMITS.POINTS_MAX + 8)) {
      if (newPoints.length >= GEO_LIMITS.POINTS_MAX) break;
      const name = cleanName(raw?.name);
      if (!name || existingPointNames.has(norm(name)) || newPoints.some((p) => norm(p.name) === norm(name))) {
        skipped += 1;
        continue;
      }
      const regionName = cleanName(raw?.regionName);
      const regionId = (regionName ? regionIdByName.get(norm(regionName)) : null) ?? "start";
      const index = newPoints.length;
      const angle = index * 2.39996;
      const radius = 14 + 3.4 * Math.sqrt(index + 1);
      newPoints.push({
        id: nextPointId,
        name,
        x: Math.round(Math.min(96, Math.max(4, 50 + radius * Math.cos(angle)))),
        y: Math.round(Math.min(96, Math.max(4, 50 + radius * Math.sin(angle)))),
        regionId
      });
      nextPointId += 1;
    }
    if (newRegions.length === 0 && newPoints.length === 0) {
      pushLog({ at: now(), kind: "world-geo-adopt", worldId: world.id, source: input.source, regionsAdded: 0, pointsAdded: 0, skipped });
      return { regionsAdded: 0, pointsAdded: 0, skipped, revisionAppended: false, regionNames: [], pointNames: [] };
    }
    let updated = {
      ...world,
      regions: [...world.regions ?? [], ...newRegions],
      points: [...world.points ?? [], ...newPoints],
      updatedAt: now()
    };
    const revision = appendDefinitionRevision(updated, {
      authorNote: `${input.source === "auto" ? "首轮自动建图" : "世界书提炼地理"}：+${newRegions.length} 地区 +${newPoints.length} 地点`,
      now: now()
    });
    if (revision.ok) updated = revision.value;
    await store.write(`world:${world.id}`, updated);
    worldCache.set(world.id, updated);
    pushLog({
      at: now(),
      kind: "world-geo-adopt",
      worldId: world.id,
      source: input.source,
      regionsAdded: newRegions.length,
      pointsAdded: newPoints.length,
      skipped,
      revisionAppended: revision.ok
    });
    return {
      regionsAdded: newRegions.length,
      pointsAdded: newPoints.length,
      skipped,
      revisionAppended: revision.ok,
      regionNames: newRegions.map((r) => r.name),
      pointNames: newPoints.map((p) => p.name)
    };
  }
  async function handleBindings(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "绑定请求必须是对象");
    }
    const record = body;
    if (record.action === "unbind") {
      const chatId = typeof record.chatId === "string" ? record.chatId : "";
      if (!chatId || chatId.length > ATLAS_LIMITS.ID_CHARS) {
        throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "unbind.chatId 非法");
      }
      await store.remove(`binding:${chatId}`);
      bindingCache.set(chatId, null);
      return okResult({ chatId, bound: false });
    }
    const parsed = parseAtlasChatBinding(record.binding);
    if (!parsed.ok) throw parsed.error;
    const binding = parsed.value;
    const world = await getWorld(binding.worldId);
    if (!world) throw new AtlasError(ATLAS_ERROR_CODES.WORLD_NOT_FOUND, `世界不存在：${binding.worldId}`);
    await store.write(`binding:${binding.chatId}`, binding);
    bindingCache.set(binding.chatId, binding);
    return okResult({ chatId: binding.chatId, worldId: binding.worldId, bound: binding.enabled });
  }
  function chatIdFromRequest(body) {
    if (!isPlainRecord(body)) return "";
    if (typeof body.chatId === "string" && body.chatId) return body.chatId;
    const session = body.session;
    if (isPlainRecord(session)) {
      const chatId = chatIdOfBinding(session.binding);
      if (chatId) return chatId;
    }
    return "";
  }
  async function handleState(body) {
    const chatId = chatIdFromRequest(body);
    if (!chatId || chatId.length > ATLAS_LIMITS.ID_CHARS) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "chatId 非法");
    }
    const binding = requireBoundBinding(await getBinding(chatId));
    const world = await requireWorld(binding);
    const relevance = computeAtlasRelevance(world, {
      at: binding.worldTimeCursor,
      branchId: binding.branchId,
      chatId,
      messageId: `state-view-${binding.worldTimeCursor}`,
      currentPointId: binding.currentLocationId ?? null,
      currentRegionId: pointRegionId(world, binding.currentLocationId ?? null),
      flags: flagsFor(world, binding.branchId, binding.worldTimeCursor)
    });
    const mapPoints = (world.points ?? []).slice(0, MAP_POINTS_MAX).map((p) => ({
      id: String(p.id),
      name: String(p.name).slice(0, MAP_POINT_NAME_CHARS),
      x: p.x,
      y: p.y,
      regionId: p.regionId ?? null
    }));
    const pointById2 = new Map((world.points ?? []).map((p) => [String(p.id), p]));
    const branchEvents = ledgerForBranch(world, binding.branchId).filter((e) => e.at <= binding.worldTimeCursor);
    const npcDirectory = (world.characters ?? []).filter((c) => relevance.relevantNpcIds.includes(String(c.id))).slice(0, 48).map((c) => {
      const pos = resolveCharacterPosition(world, String(c.id), { branchId: binding.branchId });
      const anchorPoint = pos.pointId !== null ? pointById2.get(String(pos.pointId)) : void 0;
      const npcId = String(c.id);
      const status = (world.characterStates ?? []).filter((s) => String(s.characterId) === npcId && (!s.branchId || s.branchId === binding.branchId)).sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0)).map((s) => String(s.status ?? "").trim()).find((t) => t.length > 0) ?? null;
      const recentNarratives = branchEvents.filter((e) => (e.entityRefs ?? []).map(String).includes(npcId)).slice(-2).reverse().map((e) => e.narrativeSummary.slice(0, 140));
      const anchorName = anchorPoint ? String(anchorPoint.name ?? "") : null;
      return {
        id: npcId,
        name: String(c.name ?? c.id).slice(0, MAP_POINT_NAME_CHARS),
        pointId: pos.pointId,
        regionId: pos.regionId ?? (anchorPoint ? anchorPoint.regionId ?? null : null),
        x: anchorPoint ? anchorPoint.x : null,
        y: anchorPoint ? anchorPoint.y : null,
        reason: relevance.npcReasons[npcId] ?? null,
        status: status ? status.slice(0, 160) : null,
        recentNarratives,
        pointName: anchorName ? anchorName.slice(0, MAP_POINT_NAME_CHARS) : null
      };
    });
    const regions = (world.regions ?? []).slice(0, 64).map((r) => ({
      id: String(r.id),
      name: String(r.name ?? r.id).slice(0, MAP_POINT_NAME_CHARS)
    }));
    const objectDirectory = (world.entityRecords ?? []).filter((e) => {
      if (String(e.type).toLowerCase() === "npc") return false;
      const anchor = e.mapAnchor;
      return Boolean(anchor && (anchor.pointId || anchor.regionId));
    }).slice(0, 32).map((e) => {
      const anchor = e.mapAnchor;
      const anchorPoint = anchor.pointId ? pointById2.get(String(anchor.pointId)) : void 0;
      const baseline = e.baseline ?? {};
      const rawDesc = ["description", "desc", "text", "summary"].map((k) => typeof baseline[k] === "string" ? String(baseline[k]).trim() : "").find((t) => t.length > 0) ?? null;
      return {
        id: String(e.id),
        name: String(e.name ?? e.id).slice(0, MAP_POINT_NAME_CHARS),
        type: String(e.type).slice(0, 32),
        pointId: anchor.pointId ?? null,
        regionId: anchor.regionId ?? (anchorPoint ? anchorPoint.regionId ?? null : null),
        x: typeof anchor.x === "number" ? anchor.x : anchorPoint ? anchorPoint.x : null,
        y: typeof anchor.y === "number" ? anchor.y : anchorPoint ? anchorPoint.y : null,
        description: rawDesc ? rawDesc.slice(0, 200) : null,
        pointName: anchorPoint ? String(anchorPoint.name ?? "").slice(0, MAP_POINT_NAME_CHARS) : null
      };
    });
    const lastEvent = branchEvents.at(-1) ?? null;
    const lastAdvance = lastEvent ? { at: lastEvent.at, summary: lastEvent.narrativeSummary.slice(0, 200), source: lastEvent.source } : null;
    const mapDoc = sanitizeMapDoc(await store.read(`maps:${world.id}`).catch(() => null));
    const pointMetaEntries = Object.entries(mapDoc.pointMeta).slice(0, 80);
    const submapEntries = Object.entries(mapDoc.submaps).slice(0, 40).map(([key, sub]) => ({
      pointId: key,
      scale: sub.scale ?? null,
      points: sub.points.slice(0, 40),
      pointCount: sub.points.length
    }));
    return okResult({
      chatId,
      worldId: world.id,
      worldName: world.name,
      branchId: binding.branchId,
      currentTime: binding.worldTimeCursor,
      currentLocationId: binding.currentLocationId ?? null,
      nearbyPointIds: relevance.nearbyPointIds,
      relevantNpcIds: relevance.relevantNpcIds,
      npcReasons: relevance.npcReasons,
      triggerIds: relevance.triggerIds,
      map: {
        points: mapPoints,
        pointCount: (world.points ?? []).length,
        mapImagePresent: Boolean(world.mapImage),
        pointMeta: Object.fromEntries(pointMetaEntries),
        submaps: Object.fromEntries(submapEntries.map((entry) => [entry.pointId, { scale: entry.scale, points: entry.points }])),
        submapCount: submapEntries.length
      },
      npcDirectory,
      regions,
      objectDirectory,
      lastAdvance
    });
  }
  async function handleMapImage(body) {
    const chatId = chatIdFromRequest(body);
    if (!chatId || chatId.length > ATLAS_LIMITS.ID_CHARS) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "chatId 非法");
    }
    const binding = requireBoundBinding(await getBinding(chatId));
    const world = await requireWorld(binding);
    return okResult({ dataUrl: typeof world.mapImage === "string" ? world.mapImage : null });
  }
  async function handlePrepare(body) {
    const parsed = parseAtlasTurnPrepareRequest(body);
    if (!parsed.ok) throw parsed.error;
    const request = parsed.value;
    const binding = requireBoundBinding(await getBinding(request.chatId));
    if (request.worldId !== binding.worldId) {
      throw new AtlasError(ATLAS_ERROR_CODES.WORLD_NOT_FOUND, "请求的世界与当前绑定不一致。");
    }
    if (request.branchId !== binding.branchId) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "请求分支与绑定分支不一致，拒绝注入。");
    }
    const world = await requireWorld(binding);
    const record = body;
    const destinationPointId = typeof record.destinationPointId === "string" && record.destinationPointId.trim() ? record.destinationPointId.trim().slice(0, ATLAS_LIMITS.ID_CHARS) : null;
    const output = prepareAtlasTurn(world, {
      request,
      currentTime: binding.worldTimeCursor,
      currentPointId: binding.currentLocationId ?? null,
      currentRegionId: pointRegionId(world, binding.currentLocationId ?? null),
      flags: flagsFor(world, binding.branchId, binding.worldTimeCursor),
      ...destinationPointId ? { destinationPointId } : {}
    });
    return okResult({
      response: output.response,
      npcReasons: output.npcReasons
    });
  }
  async function executeCommit(binding, request) {
    const world = await requireWorld(binding);
    const idempotencyKey = atlasCommitIdempotencyKey(request);
    const turnDocKey = `turn:${binding.chatId}:${idempotencyKey}`;
    if (receiptCache.has(idempotencyKey)) {
      const cached = receiptCache.get(idempotencyKey);
      return okResult({ receipt: { ...cached, status: "duplicate" }, duplicate: true });
    }
    const storedTurnDoc = await store.read(turnDocKey);
    if (storedTurnDoc && storedTurnDoc.receipt && !storedTurnDoc.rolledBack) {
      receiptCache.set(idempotencyKey, storedTurnDoc.receipt);
      return okResult({ receipt: { ...storedTurnDoc.receipt, status: "duplicate" }, duplicate: true });
    }
    const current = await loadSettings();
    const preset = resolveWorldTurnPreset(current);
    if (!preset) {
      throw new AtlasError(ATLAS_ERROR_CODES.API_NOT_CONFIGURED, "未配置独立推演 API，世界不会更新。");
    }
    checkRpm();
    const currentPointId = binding.currentLocationId ?? null;
    const currentRegionId = pointRegionId(world, currentPointId);
    const flags = flagsFor(world, binding.branchId, binding.worldTimeCursor);
    const prepareOutput = prepareAtlasTurn(world, {
      request: {
        chatId: request.chatId,
        messageId: request.userMessageId,
        worldId: binding.worldId,
        branchId: binding.branchId,
        userText: request.userText,
        recentMessageRefs: []
      },
      currentTime: binding.worldTimeCursor,
      currentPointId,
      currentRegionId,
      flags
    });
    const pending = {
      request,
      binding: {
        branchId: binding.branchId,
        currentPointId,
        currentRegionId,
        worldTimeCursor: binding.worldTimeCursor
      },
      savedAt: now()
    };
    await store.write(`pending:${idempotencyKey}`, pending);
    rpmTimestamps.push(now());
    const branchEvents = ledgerForBranch(world, binding.branchId).filter((e) => e.at <= binding.worldTimeCursor);
    const lastLedgerEvent = branchEvents.at(-1) ?? null;
    const lastTurnSummary = lastLedgerEvent ? lastLedgerEvent.narrativeSummary.slice(0, 500) : "";
    const turnCount = Math.min(Math.max(typeof preset.contextTurnCount === "number" ? preset.contextTurnCount : 3, 1), 10);
    const recentAssistantTexts = (Array.isArray(request.recentAssistantTexts) ? request.recentAssistantTexts : []).slice(-turnCount);
    const recentContextText = recentAssistantTexts.length > 0 ? `以下是前文的故事发展（AI输出）：
${recentAssistantTexts.map((text) => `assistant："${String(text).replace(/<br\s*\/?>/gi, "\n").replace(/<\/?[^>]+(>|$)/g, "").trim()}"`).join(" \n ")}` : "";
    const call = await callAtlasWorldTurnApi(preset, {
      injectionText: prepareOutput.response.injectionText,
      userText: request.userText,
      assistantText: request.assistantText,
      // 0.9.21 世界书资料块：宿主侧卡书条目（有界），只进推演请求
      ...request.loreSupplement ? { loreSupplement: request.loreSupplement } : {},
      ...lastTurnSummary ? { lastTurnSummary } : {},
      ...recentContextText ? { recentContextText } : {},
      ...request.personaDescription ? { personaDescription: request.personaDescription } : {},
      ...request.charDescription ? { charDescription: request.charDescription } : {}
    }, { fetchFn: deps.fetchFn, now });
    pushLog({
      at: now(),
      kind: "world-turn",
      presetName: preset.name,
      model: preset.model,
      ok: call.ok,
      ...call.ok ? {} : { code: call.code },
      status: call.status,
      durationMs: call.durationMs,
      requestChars: request.userText.length + request.assistantText.length,
      responseChars: call.ok ? call.text.length : 0,
      // 0.9.14 自动救场提示（如 MiniMax 订阅密钥自动切换 Anthropic 路由）随日志落档
      ...call.ok && call.notice ? { notice: call.notice } : {}
    });
    if (!call.ok) {
      throw new AtlasError(call.code, call.message, { retryable: call.retryable });
    }
    let draft;
    let output;
    let baseWorld = world;
    let checkpointId = null;
    const ckpt = createCheckpoint(world, {
      branchId: pending.binding.branchId,
      at: pending.binding.worldTimeCursor,
      kind: "technical",
      reason: `atlas-turn:${request.assistantMessageId}`.slice(0, 200),
      now: now()
    });
    if (ckpt.ok) {
      baseWorld = ckpt.value;
      const list = baseWorld.checkpoints ?? [];
      checkpointId = list.length > 0 ? list[list.length - 1].id : null;
    }
    try {
      const cleanedText = applyContentReplaceRules(call.text, current.contentReplaceRules ?? []);
      try {
        draft = parseAtlasWorldTurnDraft(cleanedText);
      } catch {
        try {
          draft = parseAtlasWorldTurnDraft(call.text);
        } catch {
          pushLog({
            at: now(),
            kind: "world-turn-parse-fallback",
            chatId: request.chatId,
            presetName: preset.name,
            model: preset.model,
            excerpt: call.text.slice(0, 1500)
          });
          draft = {
            duration: 0,
            locationChange: null,
            rawEffects: [],
            memoryDrafts: [],
            summary: "推演输出无法解析为 JSON，本轮按无结构变化处理（原文前 1500 字见日志页）。"
          };
        }
      }
      const adjudication = adjudicateAtlasDraft(baseWorld, {
        branchId: pending.binding.branchId,
        currentPointId: pending.binding.currentPointId,
        userText: request.userText,
        draft
      });
      if (adjudication.notes.length > 0) {
        pushLog({
          at: now(),
          kind: "world-turn-adjudication",
          chatId: request.chatId,
          notes: adjudication.notes
        });
      }
      draft = adjudication.draft;
      output = commitAtlasTurn(baseWorld, {
        request,
        branchId: pending.binding.branchId,
        currentTime: pending.binding.worldTimeCursor,
        currentPointId: pending.binding.currentPointId,
        currentRegionId: pending.binding.currentRegionId,
        draft,
        now: now()
      });
    } catch (thrown) {
      if (thrown instanceof AtlasError && thrown.details.retryable === void 0) {
        throw new AtlasError(thrown.code, thrown.message, { ...thrown.details, retryable: true });
      }
      throw thrown;
    }
    const receipt = output.receipt;
    if (receipt.status === "failed") {
      pushLog({
        at: now(),
        kind: "world-turn-commit-failed",
        chatId: request.chatId,
        worldId: binding.worldId,
        summary: receipt.summary
      });
      return okResult({ receipt });
    }
    let settledWorld = output.world;
    if (receipt.status === "committed") {
      const settlement = settleNpcSchedules(output.world, {
        branchId: pending.binding.branchId,
        prevTime: pending.binding.worldTimeCursor,
        newTime: receipt.currentTime,
        playerFromPointId: pending.binding.currentPointId,
        playerToPointId: receipt.currentLocationId ?? null,
        now: now()
      });
      settledWorld = settlement.world;
      if (settlement.encounters.length > 0) {
        receipt.triggeredNpcIds = settlement.encounters.map((e) => e.characterId);
      }
      if (settlement.notes.length > 0) {
        receipt.summary = mergeSettlementNotes(receipt.summary, settlement.notes);
        pushLog({
          at: now(),
          kind: "world-turn-settlement",
          chatId: request.chatId,
          moves: settlement.moves.length,
          encounters: settlement.encounters.length,
          notes: settlement.notes
        });
      }
    }
    await store.write(`world:${binding.worldId}`, settledWorld);
    worldCache.set(binding.worldId, settledWorld);
    const nextBinding = {
      ...binding,
      worldTimeCursor: receipt.currentTime,
      currentLocationId: receipt.currentLocationId ?? binding.currentLocationId,
      lastCommittedMessageId: request.assistantMessageId
    };
    await store.write(`binding:${binding.chatId}`, nextBinding);
    bindingCache.set(binding.chatId, nextBinding);
    await store.remove(`pending:${idempotencyKey}`);
    receiptCache.set(idempotencyKey, receipt);
    if (checkpointId) {
      await store.write(`turn:${binding.chatId}:${idempotencyKey}`, {
        schemaVersion: 1,
        chatId: binding.chatId,
        idempotencyKey,
        userMessageId: request.userMessageId,
        assistantMessageId: request.assistantMessageId,
        swipeId: request.swipeId,
        checkpointId,
        committedAt: now(),
        // 0.9.42 会话承载：回执进回合映射文档（幂等判定不再依赖进程内存）
        receipt,
        previousBinding: {
          worldTimeCursor: binding.worldTimeCursor,
          currentLocationId: binding.currentLocationId,
          lastCommittedMessageId: binding.lastCommittedMessageId
        }
      });
    }
    const lorebook = buildLorebookPlans(output.world, receipt);
    try {
      if (output.geo && output.geo.createdPoints.length > 0) {
        const docKey = `maps:${binding.worldId}`;
        const doc = sanitizeMapDoc(await store.read(docKey).catch(() => null));
        let changed = false;
        for (const created of output.geo.createdPoints) {
          const key = String(created.id);
          if (created.description && !doc.pointMeta[key]) {
            doc.pointMeta[key] = { description: created.description };
            changed = true;
          }
          if (created.submap && !doc.submaps[key]) {
            doc.submaps[key] = buildSubMapFromDraft(created.submap, {
              worldId: binding.worldId,
              pointId: key,
              now: now()
            });
            changed = true;
          }
        }
        if (changed) await store.write(docKey, doc);
      }
    } catch (thrown) {
      pushLog({
        at: now(),
        level: "error",
        kind: "world-turn-sidecar-failed",
        chatId: request.chatId,
        worldId: binding.worldId,
        summary: `子图 / 点位描述落库失败（回合本身已提交成功，无需重试推演）：${thrown instanceof Error ? thrown.message : String(thrown)}`.slice(0, 300)
      });
    }
    if (receipt.status === "committed" && (settledWorld.points ?? []).length <= 1) {
      const markerKey = `geo-auto:${binding.worldId}`;
      const GEO_AUTO_ATTEMPTS_MAX = 3;
      const currentFloorText = typeof request.assistantText === "string" ? request.assistantText.trim() : "";
      const autoTexts = [
        ...recentAssistantTexts,
        ...currentFloorText ? [currentFloorText.slice(0, 2e3)] : []
      ];
      const autoLore = typeof request.loreSupplement === "string" ? request.loreSupplement.trim() : "";
      if (autoTexts.length === 0 && !autoLore) {
      } else {
        let markerRecord = null;
        try {
          const raw = await store.read(markerKey);
          if (raw && typeof raw === "object" && !Array.isArray(raw)) {
            markerRecord = raw;
          }
        } catch {
          markerRecord = null;
        }
        const attempts = typeof markerRecord?.attempts === "number" && Number.isFinite(markerRecord.attempts) && markerRecord.attempts >= 0 ? Math.floor(markerRecord.attempts) : 0;
        const done = markerRecord?.done === true;
        if (!done && attempts < GEO_AUTO_ATTEMPTS_MAX) {
          await store.write(markerKey, { at: now(), attempts: attempts + 1 });
          try {
            const geo = await runGeoExtraction({
              world: settledWorld,
              preset,
              lore: autoLore,
              recentTexts: autoTexts,
              source: "auto"
            });
            if (geo.pointsAdded + geo.regionsAdded > 0) {
              await store.write(markerKey, { at: now(), done: true });
              receipt.summary = `${receipt.summary}；首轮自动建图：+${geo.regionsAdded} 地区 +${geo.pointsAdded} 地点`.slice(0, 480);
            } else {
              pushLog({
                at: now(),
                kind: "world-geo-auto",
                worldId: binding.worldId,
                ok: true,
                code: "ZERO_YIELD",
                message: `自动建图提炼 0 产出（第 ${attempts + 1}/${GEO_AUTO_ATTEMPTS_MAX} 次），留待后续回合重试`.slice(0, 200)
              });
            }
          } catch (thrown) {
            pushLog({
              at: now(),
              kind: "world-geo-auto",
              worldId: binding.worldId,
              ok: false,
              code: thrown instanceof AtlasError ? thrown.code : "INTERNAL",
              message: thrown instanceof Error ? thrown.message.slice(0, 200) : String(thrown).slice(0, 200)
            });
          }
        }
      }
    }
    return okResult(lorebook ? { receipt, lorebook } : { receipt });
  }
  async function handleCommit(body) {
    const parsed = parseAtlasTurnCommitRequest(body);
    if (!parsed.ok) throw parsed.error;
    const request = parsed.value;
    const binding = requireBoundBinding(await getBinding(request.chatId));
    if (!(await loadSettings()).autoCommit) {
      throw new AtlasError(ATLAS_ERROR_CODES.API_NOT_CONFIGURED, "当前聊天已关闭自动推演，commit 被拒绝。");
    }
    return enqueue(request.chatId, () => executeCommit(binding, request));
  }
  async function handleRetry(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "retry 请求必须是对象");
    }
    const record = body;
    const chatId = typeof record.chatId === "string" ? record.chatId : "";
    const userMessageId = typeof record.userMessageId === "string" ? record.userMessageId : "";
    const assistantMessageId = typeof record.assistantMessageId === "string" ? record.assistantMessageId : "";
    const swipeId = typeof record.swipeId === "string" && record.swipeId.trim() ? record.swipeId.trim() : null;
    if (!chatId || !userMessageId || !assistantMessageId) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "retry 需要 chatId / userMessageId / assistantMessageId。");
    }
    const binding = requireBoundBinding(await getBinding(chatId));
    const key = atlasCommitIdempotencyKey({ chatId, userMessageId, assistantMessageId, swipeId });
    return enqueue(chatId, async () => {
      if (receiptCache.has(key)) {
        return okResult({ receipt: { ...receiptCache.get(key), status: "duplicate" }, duplicate: true });
      }
      const storedTurnDoc = await store.read(`turn:${chatId}:${key}`);
      if (storedTurnDoc && storedTurnDoc.receipt && !storedTurnDoc.rolledBack) {
        receiptCache.set(key, storedTurnDoc.receipt);
        return okResult({ receipt: { ...storedTurnDoc.receipt, status: "duplicate" }, duplicate: true });
      }
      const stored = await store.read(`pending:${key}`);
      if (!stored) {
        throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "没有可重试的待处理回合。");
      }
      return executeCommit(binding, stored.request);
    });
  }
  async function handleRestore(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "restore 请求必须是对象");
    }
    const record = body;
    const chatId = typeof record.chatId === "string" ? record.chatId : "";
    const checkpointId = typeof record.checkpointId === "string" ? record.checkpointId.trim() : "";
    if (!chatId || !checkpointId || checkpointId.length > ATLAS_LIMITS.ID_CHARS) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "restore 需要 chatId 与 checkpointId。");
    }
    const binding = requireBoundBinding(await getBinding(chatId));
    const world = await requireWorld(binding);
    const preview = previewRestore(world, checkpointId);
    if (!preview.ok) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, preview.error);
    }
    return okResult({ preview: preview.value });
  }
  async function handleRollback(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "rollback 请求必须是对象");
    }
    const record = body;
    const chatId = typeof record.chatId === "string" ? record.chatId.trim() : "";
    const assistantMessageId = typeof record.assistantMessageId === "string" ? record.assistantMessageId.trim() : "";
    const swipeId = typeof record.swipeId === "string" && record.swipeId.trim() ? record.swipeId.trim() : void 0;
    if (!chatId || !assistantMessageId || assistantMessageId.length > ATLAS_LIMITS.ID_CHARS) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "rollback 需要 chatId 与 assistantMessageId。");
    }
    const binding = requireBoundBinding(await getBinding(chatId));
    const keys = await store.list(`turn:${chatId}:`);
    const entries = [];
    for (const key of keys) {
      const doc = await store.read(key);
      if (doc && !doc.rolledBack) entries.push({ key, doc });
    }
    entries.sort((a, b) => Number(b.doc.committedAt ?? 0) - Number(a.doc.committedAt ?? 0));
    const target = entries.find(
      (e) => e.doc.assistantMessageId === assistantMessageId && (swipeId === void 0 || e.doc.swipeId === swipeId)
    );
    if (!target) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "没有找到该楼层的推演回合映射（可能该回合未推演或已回退）。");
    }
    const latest = entries[0];
    if (latest && latest.key !== target.key) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "只能回退最近一次已推演的回合；回退中间楼层会连带抹掉其后所有推演。");
    }
    if (binding.lastCommittedMessageId !== assistantMessageId) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "该楼层不是当前最近一次已推演的回复，拒绝回退。");
    }
    const checkpointId = typeof target.doc.checkpointId === "string" ? target.doc.checkpointId : "";
    if (!checkpointId) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "回合映射缺少检查点，无法回退。");
    }
    const world = await requireWorld(binding);
    const restored = restoreAsPlayhead(world, checkpointId, { now: now() });
    if (!restored.ok) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, restored.error);
    }
    await store.write(`world:${binding.worldId}`, restored.value);
    worldCache.set(binding.worldId, restored.value);
    const previous = target.doc.previousBinding ?? {};
    const nextBinding = {
      ...binding,
      worldTimeCursor: typeof previous.worldTimeCursor === "number" ? previous.worldTimeCursor : binding.worldTimeCursor,
      currentLocationId: previous.currentLocationId ?? binding.currentLocationId,
      lastCommittedMessageId: previous.lastCommittedMessageId ?? null
    };
    await store.write(`binding:${binding.chatId}`, nextBinding);
    bindingCache.set(binding.chatId, nextBinding);
    await store.write(target.key, { ...target.doc, rolledBack: true, rolledBackAt: now() });
    const oldKey = typeof target.doc.idempotencyKey === "string" ? target.doc.idempotencyKey : null;
    if (oldKey) receiptCache.delete(oldKey);
    return okResult({
      rolledBack: { assistantMessageId, checkpointId },
      restored: restored.restored ?? null
    });
  }
  async function handleMoveAuthor(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "move-author 请求必须是对象");
    }
    const record = body;
    const chatId = typeof record.chatId === "string" ? record.chatId.trim() : "";
    const entityId = typeof record.entityId === "string" ? record.entityId.trim().slice(0, ATLAS_LIMITS.ID_CHARS) : "";
    const toPointId = typeof record.toPointId === "string" ? record.toPointId.trim().slice(0, ATLAS_LIMITS.ID_CHARS) : "";
    if (!chatId || !entityId || !toPointId) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "move-author 需要 chatId、entityId 与 toPointId。");
    }
    const binding = requireBoundBinding(await getBinding(chatId));
    const world = await requireWorld(binding);
    const character = (world.characters ?? []).find((c) => String(c.id) === entityId);
    if (!character) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `人物不存在：${entityId}`);
    }
    const point = (world.points ?? []).find((p) => String(p.id) === toPointId);
    if (!point) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `目标地点不存在：${toPointId}`);
    }
    const regionId = point.regionId ?? null;
    const moved = moveCharacterTo(world, entityId, regionId, toPointId, now(), { branchId: binding.branchId });
    if (!moved.ok) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, moved.reason);
    }
    const effect = parseStateEffect({
      kind: "moveEntity",
      entityId,
      ...regionId ? { regionId } : {},
      pointId: toPointId
    });
    if (!effect) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "moveEntity effect 形状非法");
    }
    const provisioned = provisionReferencedCharacters(moved.world, [effect], now());
    const pointName2 = String(point.name ?? toPointId);
    const characterName = String(character.name ?? entityId);
    const appended = appendStateEvent(
      provisioned,
      {
        branchId: binding.branchId,
        at: binding.worldTimeCursor,
        source: "author",
        narrativeSummary: `作者纠偏：${characterName} 移动到 ${pointName2}`.slice(0, 300),
        effects: [effect],
        entityRefs: [entityId]
      },
      { now: now() }
    );
    if (!appended.ok) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, appended.error);
    }
    const nextWorld = appended.value;
    const ledgerEventId = nextWorld.stateEvents?.[nextWorld.stateEvents.length - 1]?.id ?? "";
    await store.write(`world:${binding.worldId}`, nextWorld);
    worldCache.set(binding.worldId, nextWorld);
    let cursorMoved = false;
    if (isProtagonistRole(character.role)) {
      const nextBinding = {
        ...binding,
        currentLocationId: toPointId
      };
      await store.write(`binding:${binding.chatId}`, nextBinding);
      bindingCache.set(binding.chatId, nextBinding);
      cursorMoved = true;
    }
    pushLog({
      at: now(),
      kind: "world-move-author",
      chatId: binding.chatId,
      worldId: binding.worldId,
      entityId,
      toPointId,
      protagonist: cursorMoved
    });
    return okResult({
      moved: { entityId, characterName, pointId: toPointId, pointName: pointName2, regionId },
      ledgerEventId,
      cursorMoved,
      summary: `作者纠偏：${characterName} 移动到 ${pointName2}`
    });
  }
  async function handleTravelPreview(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "travel-preview 请求必须是对象");
    }
    const record = body;
    const chatId = typeof record.chatId === "string" ? record.chatId : "";
    const destinationPointId = typeof record.destinationPointId === "string" ? record.destinationPointId.trim() : "";
    const speedTierId = typeof record.speedTierId === "string" && record.speedTierId.trim() ? record.speedTierId.trim() : null;
    if (!chatId || !destinationPointId) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "travel-preview 需要 chatId 与 destinationPointId。");
    }
    const binding = requireBoundBinding(await getBinding(chatId));
    const world = await requireWorld(binding);
    const fromPointId = binding.currentLocationId ?? null;
    if (!fromPointId) throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "当前绑定没有位置游标，无法预览路线。");
    const preview = atlasTravelPreview(world, {
      fromPointId,
      toPointId: destinationPointId.slice(0, ATLAS_LIMITS.ID_CHARS),
      ...speedTierId ? { speedTierId } : {}
    });
    return okResult({ preview });
  }
  async function handleSessionExport(body) {
    if (!isPlainRecord(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "session/export 请求必须是对象");
    }
    const chatId = typeof body.chatId === "string" ? body.chatId : "";
    const worldId = typeof body.worldId === "string" ? body.worldId : "";
    if (!chatId || chatId.length > ATLAS_LIMITS.ID_CHARS || !worldId || worldId.length > ATLAS_LIMITS.ID_CHARS) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "session/export 需要 chatId 与 worldId。");
    }
    const binding = await store.read(`binding:${chatId}`);
    const world = await store.read(`world:${worldId}`);
    const maps = await store.read(`maps:${worldId}`);
    const geoAuto = await store.read(`geo-auto:${worldId}`);
    const turns = {};
    for (const key of await store.list(`turn:${chatId}:`)) {
      turns[key] = await store.read(key);
    }
    const session = {
      ...createEmptySessionDoc(),
      ...binding ? { binding } : {},
      ...world ? { world } : {},
      ...maps ? { maps } : {},
      turns,
      ...geoAuto ? { geoAuto: { [worldId]: geoAuto } } : {}
    };
    return okResult({ session, found: Boolean(world || binding) });
  }
  async function handleSessionPurge(body, ctx) {
    if (!ctx.local) throw new AtlasError(ATLAS_ERROR_CODES.FORBIDDEN, "只有本机已登录会话可以清理旧世界文档。");
    if (!isPlainRecord(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "session/purge 请求必须是对象");
    }
    const chatId = typeof body.chatId === "string" ? body.chatId : "";
    const worldId = typeof body.worldId === "string" ? body.worldId : "";
    if (!chatId || chatId.length > ATLAS_LIMITS.ID_CHARS || !worldId || worldId.length > ATLAS_LIMITS.ID_CHARS) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "session/purge 需要 chatId 与 worldId。");
    }
    await store.remove(`binding:${chatId}`);
    await store.remove(`world:${worldId}`);
    await store.remove(`maps:${worldId}`);
    await store.remove(`geo-auto:${worldId}`);
    const turnKeys = await store.list(`turn:${chatId}:`);
    for (const key of turnKeys) await store.remove(key);
    worldCache.delete(worldId);
    bindingCache.delete(chatId);
    return okResult({ purged: true, turnDocs: turnKeys.length });
  }
  async function handle(method, path, body, ctx = {}) {
    try {
      const [, cleanPath = ""] = path.match(/^\/api\/plugins\/atlas(\/.*)$/) ?? [null, path];
      const route = (cleanPath ?? path).replace(/\/+$/, "") || "/";
      if (method === "GET" && route === "/health") return await handleHealth();
      if (method === "GET" && route === "/settings") return await handleGetSettings();
      if (method === "PUT" && route === "/settings") return await handlePutSettings(body, ctx);
      if (method === "GET" && route === "/worlds") return await handleListWorlds();
      if (method === "POST" && route === "/worlds/import") return await handleImportWorld(body, ctx);
      if (method === "POST" && route === "/worlds/ensure-starter") return await handleEnsureStarter(body, ctx);
      if (method === "POST" && route === "/worlds/geo/adopt") return await handleGeoAdopt(body);
      if (method === "POST" && route === "/worlds/move-author") return await handleMoveAuthor(body);
      if (method === "POST" && route === "/bindings") return await handleBindings(body);
      if (method === "POST" && route === "/state") return await handleState(body);
      if (method === "POST" && route === "/map/image") return await handleMapImage(body);
      if (method === "POST" && route === "/turns/prepare") return await handlePrepare(body);
      if (method === "POST" && route === "/turns/commit") return await handleCommit(body);
      if (method === "POST" && route === "/turns/retry") return await handleRetry(body);
      if (method === "POST" && route === "/turns/restore") return await handleRestore(body);
      if (method === "POST" && route === "/turns/rollback") return await handleRollback(body);
      if (method === "POST" && route === "/map/travel-preview") return await handleTravelPreview(body);
      if (method === "POST" && route === "/session/export") return await handleSessionExport(body);
      if (method === "POST" && route === "/session/purge") return await handleSessionPurge(body, ctx);
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `未知路由：${method} ${route}`);
    } catch (thrown) {
      return errorResult(thrown);
    }
  }
  return { handle };
}
function createAtlasServerCore(deps) {
  const shared = {
    rpmTimestamps: [],
    logs: [],
    settingsOverride: null,
    revByChat: /* @__PURE__ */ new Map(),
    chatMutex: /* @__PURE__ */ new Map(),
    ensureMutex: /* @__PURE__ */ new Map()
  };
  const globalCore = createCoreInstance(deps.store, deps, shared);
  async function handle(method, path, body, ctx = {}) {
    try {
      const [, cleanPath = ""] = path.match(/^\/api\/plugins\/atlas(\/.*)$/) ?? [null, path];
      const route = (cleanPath ?? path).replace(/\/+$/, "") || "/";
      if (!ATLAS_SESSION_ROUTES.has(`${method} ${route}`)) {
        return await globalCore.handle(method, path, body, ctx);
      }
      const record = isPlainRecord(body) ? body : {};
      const session = parseAtlasSessionDoc(record.session);
      const chatId = typeof record.chatId === "string" && record.chatId || chatIdOfBinding(session.binding);
      const run = async () => {
        if (chatId) {
          const known = shared.revByChat.get(chatId);
          if (known !== void 0 && known > session.rev) {
            throw new AtlasError(
              ATLAS_ERROR_CODES.SESSION_STALE,
              "世界数据已被其他窗口更新，请刷新页面或重新进入聊天后重试。"
            );
          }
        }
        const overlay = createSessionOverlayStore(session, deps.store);
        const instance = createCoreInstance(overlay, deps, shared);
        const result = await instance.handle(method, path, body, ctx);
        if (result.status === 200 && isPlainRecord(result.body) && result.body.ok === true && overlay.changed()) {
          const next = cloneSessionDoc(session);
          next.rev = session.rev + 1;
          if (chatId) rememberRev(chatId, next.rev);
          result.body.session = next;
        } else if (chatId) {
          rememberRev(chatId, session.rev);
        }
        return result;
      };
      if (chatId) {
        return await withSharedMutex(shared.chatMutex, chatId, run);
      }
      return run();
    } catch (thrown) {
      return errorResult(thrown);
    }
  }
  function rememberRev(chatId, rev) {
    const current = shared.revByChat.get(chatId) ?? 0;
    if (rev > current) shared.revByChat.set(chatId, rev);
  }
  return {
    handle,
    /** 诊断 / 测试用：脱敏日志副本（含会话路由内产生的日志） */
    logs() {
      return shared.logs.map((entry) => ({ ...entry }));
    },
    /** 测试辅助：注入设置（跳过 PUT 校验流程；仅供测试进程使用） */
    __setSettingsForTest(next) {
      shared.settingsOverride = { ...createDefaultSettingsV2(), ...next };
    }
  };
}

// src/atlas-browser-store.ts
var ATLAS_BROWSER_STORE_SCHEMA_VERSION = 1;
var ATLAS_BROWSER_DOC_LIMITS = {
  /** 单文档 JSON 序列化后最大字节数（UTF-8 按 2 字符≈1 字符保守估算用字符串长度） */
  DOC_MAX_BYTES: 4e6,
  /** 全部文档总字节上限 */
  TOTAL_MAX_BYTES: 16e6,
  /** 文档数量上限 */
  DOC_COUNT_MAX: 256
};
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseStored(raw) {
  if (!isRecord(raw)) return null;
  if (raw.schemaVersion !== ATLAS_BROWSER_STORE_SCHEMA_VERSION) return null;
  if (!isRecord(raw.docs)) return null;
  return { schemaVersion: ATLAS_BROWSER_STORE_SCHEMA_VERSION, docs: raw.docs };
}
function serializedLength(value) {
  try {
    return JSON.stringify(value ?? null)?.length ?? 0;
  } catch {
    throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "文档载荷无法 JSON 序列化（循环引用或非可序列化值）");
  }
}
function createBrowserDocumentStore(host) {
  function loadDocs() {
    const parsed = parseStored(host.readAll());
    return parsed ? parsed.docs : {};
  }
  function persistDocs(docs) {
    host.writeAll({ schemaVersion: ATLAS_BROWSER_STORE_SCHEMA_VERSION, docs });
  }
  function assertWithinLimits(name, value, docs) {
    if (!(name in docs) && Object.keys(docs).length >= ATLAS_BROWSER_DOC_LIMITS.DOC_COUNT_MAX) {
      throw new AtlasError(
        ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED,
        `浏览器存储文档数已达上限 ${ATLAS_BROWSER_DOC_LIMITS.DOC_COUNT_MAX}`
      );
    }
    const docLength = serializedLength(value);
    if (docLength > ATLAS_BROWSER_DOC_LIMITS.DOC_MAX_BYTES) {
      throw new AtlasError(
        ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED,
        `单文档超过 ${ATLAS_BROWSER_DOC_LIMITS.DOC_MAX_BYTES} 字符上限`
      );
    }
    const otherDocs = Object.keys(docs).filter((key) => key !== name).reduce((sum, key) => sum + serializedLength(docs[key]), 0);
    if (otherDocs + docLength > ATLAS_BROWSER_DOC_LIMITS.TOTAL_MAX_BYTES) {
      throw new AtlasError(
        ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED,
        `浏览器存储总量超过 ${ATLAS_BROWSER_DOC_LIMITS.TOTAL_MAX_BYTES} 字符上限`
      );
    }
  }
  return {
    async read(name) {
      const docs = loadDocs();
      return name in docs ? docs[name] : null;
    },
    async write(name, value) {
      const docs = loadDocs();
      assertWithinLimits(name, value, docs);
      docs[name] = value;
      persistDocs(docs);
    },
    async remove(name) {
      const docs = loadDocs();
      if (!(name in docs)) return;
      delete docs[name];
      persistDocs(docs);
    },
    async list(prefix) {
      const docs = loadDocs();
      return Object.keys(docs).filter((key) => key.startsWith(prefix)).sort();
    }
  };
}

// src/atlas-local-api.ts
function createLocalAtlasApi(core, ctx = { local: true }) {
  return {
    async request(method, path, body) {
      const result = await core.handle(method, path, body, ctx);
      return { status: result.status, body: result.body };
    }
  };
}

// lib/demo-events.ts
var aurelianEvents = {
  north: [
    { year: "312.04", title: "要塞陷落", summary: "黑潮军在暴雪中抵达城下，要塞守军在第三日城破。", branches: 3 },
    { year: "309.11", title: "寒鸦盟约", summary: "七位领主在无火大厅宣誓，共抗黑潮。", branches: 1 },
    { year: "307.02", title: "北境大疫", summary: "霜热病从边境村庄蔓延，三千人病亡。", branches: 0 },
    { year: "303.08", title: "白狼现世", summary: "守夜人报告城北雪原出现双头白狼。", branches: 2 },
    { year: "298.05", title: "寒铁开采", summary: "矿工在冰层下发现寒铁矿脉，可铸永不生锈的刀剑。", branches: 0 },
    { year: "295.12", title: "雪原狼群", summary: "狼群规模空前，袭击商队，迫使商路改道。", branches: 0 },
    { year: "291.07", title: "北境粮荒", summary: "连续两年歉收，北境出现饥荒。", branches: 0 },
    { year: "287.03", title: "守夜人叛乱", summary: "守夜人指挥官率部哗变，被镇压。", branches: 0 }
  ],
  capital: [
    { year: "312.06", title: "白塔政变", summary: "王冠在黎明前更换了主人，旧王被软禁。", branches: 4 },
    { year: "304.02", title: "开放天门", summary: "失传百年的浮空梯再度运转，星环城向天空开放。", branches: 0 },
    { year: "310.09", title: "御前会议", summary: "新王召开御前会议，重组内阁。", branches: 0 },
    { year: "308.11", title: "冬日祭典", summary: "一年一度的星环城冬日祭典，吸引十万游客。", branches: 0 },
    { year: "305.05", title: "白塔大火", summary: "白塔顶层失火，皇家图书馆三分之二藏书被毁。", branches: 2 },
    { year: "300.08", title: "御花园建成", summary: "新王下令在星环城中心修建御花园。", branches: 0 },
    { year: "296.10", title: "王后加冕", summary: "现任王后加冕，开启长达 20 年的盛世。", branches: 0 },
    { year: "292.04", title: "浮空议会", summary: "议会通过《浮空法案》，正式承认浮空城邦自治。", branches: 1 }
  ],
  isles: [
    { year: "313.01", title: "群舰叛乱", summary: "十二艘战舰熄灭帝国旗灯，宣布独立。", branches: 2 },
    { year: "298.08", title: "蓝鲸回游", summary: "海民在鲸鸣中找到了新航路。", branches: 1 },
    { year: "306.06", title: "潮汐神祭", summary: "海民举行三年一度的潮汐神祭，祈求风调雨顺。", branches: 0 },
    { year: "302.11", title: "无名之王", summary: "群岛出现一位自称无名之王的神秘人物。", branches: 3 },
    { year: "299.04", title: "海上丝路", summary: "群岛与南方大陆开通海上丝路，商贸繁荣。", branches: 0 },
    { year: "294.09", title: "海盗联盟", summary: "群岛海盗组成联盟，袭击帝国商船。", branches: 1 },
    { year: "289.12", title: "暴风季", summary: "连续 90 天暴风，群岛与世隔绝。", branches: 0 }
  ]
};
var aelanEvents = {
  north: [
    { year: "1120.05", title: "龙脊山会战", summary: "龙脊山三大部族联军与帝国先锋军决战。", branches: 2 },
    { year: "1118.09", title: "雪山朝圣", summary: "数千信徒徒步前往龙脊山朝圣。", branches: 0 },
    { year: "1115.11", title: "石巨人苏醒", summary: "矿工在雪山深处挖出沉睡千年的石巨人。", branches: 3 },
    { year: "1110.02", title: "永夜降临", summary: "龙脊山以北出现连续 30 天极夜。", branches: 1 },
    { year: "1105.07", title: "冰原商道", summary: "新开辟的冰原商道连通帝国与北方蛮族。", branches: 0 },
    { year: "1100.04", title: "北风之歌", summary: "吟游诗人传唱北风之歌，名动帝国。", branches: 0 },
    { year: "1095.10", title: "雪狼盟约", summary: "蛮族与帝国签订为期十年的雪狼盟约。", branches: 0 },
    { year: "1090.06", title: "雪山崩塌", summary: "龙脊山主峰崩塌，掩埋三个村庄。", branches: 1 }
  ],
  capital: [
    { year: "1121.01", title: "圣城加冕", summary: "新任大主教在圣城加冕，开启改革时代。", branches: 1 },
    { year: "1119.04", title: "金叶议会", summary: "帝国议会通过《金叶法案》，税制改革。", branches: 0 },
    { year: "1117.10", title: "白塔学园", summary: "帝国最高学府白塔学园建成，招收首批学生。", branches: 0 },
    { year: "1114.03", title: "圣战宣告", summary: "大主教宣告对异端发动圣战。", branches: 2 },
    { year: "1110.08", title: "圣城大火", summary: "圣城遭遇不明原因大火，半城被毁。", branches: 1 },
    { year: "1106.11", title: "金叶王朝", summary: "金叶王朝建立，结束了长达 50 年的乱世。", branches: 0 },
    { year: "1101.05", title: "金币发行", summary: "帝国发行统一金币，取代地方铸币。", branches: 0 },
    { year: "1096.09", title: "御前改制", summary: "新王推行御前改制，削弱贵族权力。", branches: 0 }
  ],
  isles: [
    { year: "1119.07", title: "海神祭典", summary: "群岛举行盛大海神祭典，祈求渔获丰收。", branches: 0 },
    { year: "1116.12", title: "深海渔场", summary: "群岛发现深海渔场，可支撑十年口粮。", branches: 0 },
    { year: "1112.04", title: "海盗之王", summary: "传说中的海盗之王再度现身，袭击商船。", branches: 2 },
    { year: "1108.08", title: "海市蜃楼", summary: "群岛海域出现持续一周的海市蜃楼。", branches: 1 },
    { year: "1103.02", title: "珊瑚迷宫", summary: "渔民发现海底珊瑚迷宫，疑为古代遗迹。", branches: 3 },
    { year: "1098.10", title: "海风之乱", summary: "群岛出现神秘海风，引发动乱。", branches: 0 },
    { year: "1092.05", title: "潮汐异变", summary: "群岛海域潮汐异变，渔村被迫迁移。", branches: 0 }
  ]
};
var starsEvents = {
  north: [
    { year: "2347.11", title: "极光站建成", summary: "人类在北极建成第一座极光观测站。", branches: 1 },
    { year: "2345.06", title: "冰下文明", summary: "科考队在冰层下发现疑似远古文明遗迹。", branches: 3 },
    { year: "2342.03", title: "极昼危机", summary: "北极出现持续 60 天的极昼，动植物异变。", branches: 0 },
    { year: "2338.10", title: "极光通讯", summary: "科学家发现极光可携带信号，实现跨极通讯。", branches: 0 },
    { year: "2335.04", title: "冰原基地", summary: "人类在冰原建成第一座永久基地。", branches: 0 },
    { year: "2330.09", title: "冰芯样本", summary: "科考队钻取百万年冰芯，发现气候周期。", branches: 0 },
    { year: "2326.01", title: "极夜实验", summary: "极夜期间进行的 30 天科学实验，成果丰硕。", branches: 0 }
  ],
  capital: [
    { year: "2348.02", title: "星际港落成", summary: "首都星际港落成，可同时停泊 100 艘飞船。", branches: 1 },
    { year: "2346.07", title: "联邦议会", summary: "人类联邦召开首次跨星球议会。", branches: 0 },
    { year: "2343.11", title: "时空跃迁", summary: "联邦科学家实现首次时空跃迁试航。", branches: 2 },
    { year: "2340.05", title: "能源革命", summary: "首都宣布掌握可控聚变，能源价格降至 1/100。", branches: 0 },
    { year: "2336.10", title: "星际联邦", summary: "地球、火星、木卫二联合组建星际联邦。", branches: 0 },
    { year: "2332.04", title: "首艘星舰", summary: "联邦首艘星舰「星环号」下水。", branches: 0 },
    { year: "2328.08", title: "轨道电梯", summary: "首都建成首条太空轨道电梯。", branches: 0 },
    { year: "2324.12", title: "首都迁都", summary: "人类正式将首都迁至新首都（现首都）。", branches: 0 }
  ],
  isles: [
    { year: "2347.08", title: "深空信号", summary: "木卫二接收疑似外星文明信号。", branches: 4 },
    { year: "2344.05", title: "海洋世界", summary: "探测器发现木卫二冰下海洋存在生命迹象。", branches: 2 },
    { year: "2341.09", title: "冰下基地", summary: "人类在木卫二冰下建成第一座研究基地。", branches: 0 },
    { year: "2337.03", title: "外星细菌", summary: "木卫二海洋中发现外星细菌，引发争议。", branches: 1 },
    { year: "2333.11", title: "冰下航行", summary: "无人潜艇完成木卫二冰下 100 公里航行。", branches: 0 },
    { year: "2329.06", title: "潮汐能站", summary: "木卫二建成首座潮汐能发电站。", branches: 0 },
    { year: "2325.10", title: "远航计划", summary: "联邦启动「远航计划」，目标半人马座。", branches: 0 }
  ]
};
var fogEvents = {
  north: [
    { year: "1923.10", title: "雾门开启", summary: "雾都北区的雾门传说中第一次被打开。", branches: 3 },
    { year: "1920.05", title: "北境探案", summary: "私家侦探接手北境失踪案，揭开百年阴谋。", branches: 2 },
    { year: "1918.02", title: "雾中小屋", summary: "北境发现一座无人小屋，屋内钟表停在凌晨 3 点。", branches: 1 },
    { year: "1915.09", title: "白色访客", summary: "北境居民报告看见白色访客，疑为亡灵。", branches: 2 },
    { year: "1912.04", title: "雾号列车", summary: "北境最后一班雾号列车神秘失踪。", branches: 1 },
    { year: "1908.11", title: "北境雾歌", summary: "吟游诗人传唱北境雾歌，凡听者皆泪流。", branches: 0 }
  ],
  capital: [
    { year: "1924.07", title: "雾都议会", summary: "雾都议会通过《雾中法案》，允许监控一切异象。", branches: 2 },
    { year: "1921.11", title: "侦探事务所", summary: "雾都最著名的侦探事务所开张。", branches: 0 },
    { year: "1919.06", title: "雾钟敲响", summary: "雾都中心的雾钟敲响十三声，预言末日。", branches: 3 },
    { year: "1917.03", title: "红衣女子", summary: "雾都红衣女子在多个地点同时出现，案件悬而未决。", branches: 2 },
    { year: "1914.10", title: "雾中剧院", summary: "雾都剧院上演《雾中奇谭》，观众席出现空椅。", branches: 1 },
    { year: "1910.08", title: "雾都建城", summary: "雾都正式建立，命名「雾都」以警示后人。", branches: 0 },
    { year: "1906.01", title: "大雾之夜", summary: "雾都遭遇史上最浓大雾，能见度不足 1 米。", branches: 0 }
  ],
  isles: [
    { year: "1922.04", title: "雾船迷航", summary: "群岛渔民发现一艘无人雾船，船上留有半瓶墨水。", branches: 2 },
    { year: "1919.09", title: "雾灯熄灭", summary: "群岛灯塔的雾灯同时熄灭，疑为超自然现象。", branches: 1 },
    { year: "1916.12", title: "无名岛", summary: "群岛海域出现一座无名岛，岛上有房屋但无人。", branches: 3 },
    { year: "1913.05", title: "海雾之门", summary: "渔民在海雾中发现一座门，跨过后回到过去。", branches: 2 },
    { year: "1910.10", title: "群岛雾咒", summary: "群岛遭受持续三年的雾咒，民不聊生。", branches: 1 },
    { year: "1907.02", title: "海雾升起", summary: "群岛海域首次记录到海雾升起现象。", branches: 0 }
  ]
};
var completeExperienceEvents = {
  north: [
    {
      id: "chronicle-letter",
      year: "418.02",
      title: "霜原来信",
      summary: "雪线驿站送来一封没有署名的信：白塔将在七次月落后响起不该存在的第十三声。",
      content: '雪停在午夜。薇尔·星环站在雪线驿站的檐下，手里那封信没有蜡印，纸却仍带着温度。\n\n信上只写了一句话："第十三声响起时，不要让任何人握住钟锤。"\n\n塔尔说这像个拙劣的圈套；薇尔却认出了信纸边缘的潮盐。群岛有人冒着封海，把答案送到了北境。她把信折回胸前，决定先去无火大厅。',
      branches: 0,
      characterIds: ["chronicle-c1", "chronicle-c3"]
    },
    {
      id: "chronicle-hall",
      year: "418.04",
      title: "无火大厅",
      summary: "北境三位守望者在熄灭的壁炉前交出旧王留下的半枚钥匙。",
      content: '无火大厅没有窗，只有三面被烟熏黑的墙。守望者们把半枚钥匙放在石桌中央，钥匙的切面像一道没有愈合的伤。\n\n"白塔的钟不是报时，"最年长的守望者说，"它在替某个世界记住没有发生过的事。"\n\n薇尔收下钥匙时，远方冰原传来第一声鲸鸣。那声音不该越过群山，却准确地叫出了她的名字。',
      branches: 0,
      characterIds: ["chronicle-c1", "chronicle-c3"]
    }
  ],
  capital: [
    {
      id: "chronicle-bell",
      year: "418.07",
      title: "白塔第十三声",
      summary: "白塔在正午敲响第十三声，整座王都在同一瞬间记起了彼此矛盾的昨天。",
      content: "第十二声结束后，王都所有的影子都先于人群转过了身。\n\n第十三声随即落下。市场里的母亲认得一个从未出生的孩子；卫兵拔剑，却说不清自己是在保护王冠还是推翻它。伊莱恩站在钟锤旁，像早已等候这一刻。\n\n薇尔将半枚钥匙嵌进钟座，听见海潮从石头深处涌来。她可以放下钟锤，让这座城忘记一切；也可以再敲一次，让所有被抹去的可能性都有名字。",
      branches: 2,
      singularity: true,
      characterIds: ["chronicle-c1", "chronicle-c2", "chronicle-c4"]
    },
    {
      id: "chronicle-key",
      year: "418.08",
      title: "钥匙交接",
      summary: "白塔钟声之后，伊莱恩将另一半钥匙交给薇尔，承认自己一直在阻止更坏的结局。",
      content: '钟声散去时，伊莱恩没有逃。他把另一半钥匙放在台阶上，手背满是被钟锤震裂的血痕。\n\n"我不是来夺走王冠的，"他说，"我是来替所有已经失去王冠的你们守门。"\n\n薇尔没有立刻相信他，却把钥匙拾起。两枚钥匙合拢的一刻，白塔地下的潮门显出一道细缝，缝隙另一端是正在退潮的群岛。',
      branches: 0,
      characterIds: ["chronicle-c1", "chronicle-c2"]
    },
    {
      id: "chronicle-lantern",
      year: "418.10",
      title: "玻璃温室的灯",
      summary: "一个与主线无关的温室守夜人点亮旧灯，留下可单独阅读的事件详情样本。",
      content: "玻璃温室位于王都最安静的角落。钟声之后，守夜人把一盏从未点过的蓝灯挂在藤架上。\n\n他不知道白塔发生了什么，也不知道这盏灯会不会引来什么人；他只记得园丁曾说，世界越乱，越要给晚归的人留一扇看得见的窗。\n\n这不是任何故事线的一步。它只是一个地点、一个人和一个晚上留下的记录。",
      branches: 0,
      characterIds: ["chronicle-c2"]
    },
    {
      id: "chronicle-garden",
      year: "418.12",
      title: "静默花园",
      summary: "选择放下钟锤后，王都保住了秩序，却开始遗忘所有无法被证明的奇迹。",
      content: "薇尔放下钟锤。第十四声没有到来，王都的街道重新安静，仿佛那十三次震动只是集体的幻觉。\n\n只有温室里的蓝灯还在燃烧。赛芙说，海会记住这一天，但陆地会把它忘得很干净。\n\n薇尔把两枚钥匙埋进花园，决定让人们继续过平常的日子；代价是，那些本可以被拯救的世界线，只能在梦里敲门。",
      branches: 1,
      characterIds: ["chronicle-c1", "chronicle-c4"]
    },
    {
      id: "chronicle-fourteenth",
      year: "418.12",
      title: "第十四声之后",
      summary: "选择再敲一次钟后，王都看见了无数相互重叠的自己。",
      content: "第十四声没有声音。它像一滴墨落进水里，王都的每一扇窗都映出另一座王都。\n\n薇尔看见自己在不同的世界里戴冠、流亡、死去，又在每一次结尾回到钟座前。伊莱恩跪在石阶上，终于承认他怕的从来不是混乱，而是人们拥有选择。\n\n潮门彻底打开。赛芙在海那边唱起引航歌，歌里说：记得所有可能的人，必须亲手选择自己要失去哪一种。",
      branches: 1,
      characterIds: ["chronicle-c1", "chronicle-c2", "chronicle-c4"]
    }
  ],
  isles: [
    {
      id: "chronicle-departure",
      year: "418.11",
      title: "潮门启航",
      summary: "钥匙开启潮门，薇尔与赛芙驾船前往鲸骨档案馆寻找王都记忆的源头。",
      content: "潮门不是一扇门，而是一片竖起来的海。船穿过它时，甲板上的雪融成盐，北境的寒风从桅杆间退去。\n\n赛芙把耳朵贴在船舷上，说鲸群正在替所有迷路的世界唱同一首歌。塔尔第一次离开群山，却没有回头。\n\n他们驶向鲸骨档案馆。那里收藏的不是书，而是每一个被放弃的结局留下的骨白色回声。",
      branches: 0,
      characterIds: ["chronicle-c1", "chronicle-c3", "chronicle-c4"]
    },
    {
      id: "chronicle-whale",
      year: "418.13",
      title: "鲸骨档案",
      summary: "档案馆证实白塔钟声是三百年前一场未完成的选择，且每个选择都仍在等待归属。",
      content: '鲸骨档案馆的穹顶像一艘倒扣的船。每一根骨梁都刻着一座已经不存在的城名。\n\n薇尔在最深处找到一页没有写完的航海日志：三百年前，有人第一次听见第十三声，却在敲下第十四声前把钟锤沉进海里。于是所有分歧被封存，没有消失。\n\n赛芙问薇尔："现在轮到你了。你是要替它们选一个结局，还是让每一个结局都自己活下去？"',
      branches: 1,
      characterIds: ["chronicle-c1", "chronicle-c4"]
    },
    {
      id: "chronicle-return",
      year: "419.01",
      title: "归航的晨星",
      summary: "众人带着可被选择的未来回到王都，白塔不再替任何人决定结局。",
      content: "新年的第一束光穿过潮门时，王都的钟没有响。人们仍然记得混乱，也仍然记得彼此不同的昨天，但再没有谁要求另一个人忘掉。\n\n薇尔把两枚钥匙交给守夜人、园丁和船夫，让它们不再属于王冠，也不再属于白塔。\n\n晨星升起，赛芙说这不是最好的结局，只是一个被所有人共同写下的结局。薇尔望向海面，第一次相信未被选择的世界也许并没有死去。",
      branches: 0,
      characterIds: ["chronicle-c1", "chronicle-c2", "chronicle-c3", "chronicle-c4"]
    }
  ]
};
var completeExperienceTemplate = {
  id: "chronicle",
  name: "完整体验 · 星环余烬",
  description: "可完整阅读的示例世界：3 地区、6 地点、10 事件、4 人物、1 条正史与 2 条 IF。用于体验地图、时间轴、事件详情、特异点与两种阅读器；不含 API 密钥。",
  defaultYear: 418,
  events: completeExperienceEvents,
  characters: [
    { id: "chronicle-c1", worldId: "demo", name: "薇尔·星环", role: "持钥人", description: "流亡王族的后裔。她想守住王都，却不愿再让一个人的选择替所有人决定未来。", currentRegionId: "capital", tags: ["主角", "持钥人", "王族"] },
    { id: "chronicle-c2", worldId: "demo", name: "伊莱恩·莫尔", role: "白塔守钟人", description: "看守第十三声多年的守钟人。他既是阻止者，也是把选择推到薇尔面前的人。", currentRegionId: "capital", tags: ["守钟人", "灰色角色", "白塔"] },
    { id: "chronicle-c3", worldId: "demo", name: "塔尔·霜铁", role: "北境守望者", description: "无火大厅的最后一位年轻守望者，习惯用最实际的方式保护看不见的承诺。", currentRegionId: "north", tags: ["北境", "守望者", "同伴"] },
    { id: "chronicle-c4", worldId: "demo", name: "赛芙·潮歌", role: "群岛引航人", description: "能听懂鲸鸣中的旧航线。她相信每个被放弃的结局都值得拥有自己的名字。", currentRegionId: "isles", tags: ["群岛", "引航人", "神秘"] }
  ],
  regions: [
    { id: "north", name: "霜线北境", type: "mountain", description: "雪线驿站与无火大厅所在的边境。这里的人负责守住王都不愿记起的旧约。", coordinates: { x: 28, y: 24 }, subtitle: "北境", tone: "#b7d1d1" },
    { id: "capital", name: "白塔王都", type: "city", description: "钟塔、玻璃温室与潮门都藏在这座曾经只相信唯一历史的城市里。", coordinates: { x: 54, y: 47 }, subtitle: "王都", tone: "#e4c77f" },
    { id: "isles", name: "鲸歌群岛", type: "sea", description: "潮门彼端的群岛；鲸骨档案馆在这里保存被放弃的可能性。", coordinates: { x: 77, y: 72 }, subtitle: "群岛", tone: "#85bcc8" }
  ],
  points: [
    { id: 4101, name: "雪线驿站", x: 20, y: 20, regionId: "north" },
    { id: 4102, name: "无火大厅", x: 34, y: 28, regionId: "north" },
    { id: 4103, name: "白塔钟座", x: 53, y: 42, regionId: "capital" },
    { id: 4104, name: "玻璃温室", x: 63, y: 54, regionId: "capital" },
    { id: 4105, name: "潮门港", x: 71, y: 68, regionId: "isles" },
    { id: 4106, name: "鲸骨档案馆", x: 82, y: 76, regionId: "isles" }
  ],
  stories: [
    {
      id: "chronicle-canon",
      mode: "canon",
      title: "正史 · 星环余烬",
      steps: [
        { eventId: "chronicle-letter", choice: null },
        { eventId: "chronicle-hall", choice: null },
        { eventId: "chronicle-bell", choice: null },
        { eventId: "chronicle-key", choice: null },
        { eventId: "chronicle-departure", choice: null },
        { eventId: "chronicle-return", choice: null }
      ],
      chapters: [
        { id: "chronicle-canon-c1", title: "第一章 · 雪线来信", fromStep: 0 },
        { id: "chronicle-canon-c2", title: "第二章 · 白塔回声", fromStep: 2 },
        { id: "chronicle-canon-c3", title: "第三章 · 潮门归航", fromStep: 4 }
      ]
    },
    {
      id: "chronicle-if-silence",
      mode: "if",
      title: "IF · 静默花园",
      parentStoryId: "chronicle-canon",
      divergenceEventId: "chronicle-bell",
      steps: [
        { eventId: "chronicle-letter", choice: null },
        { eventId: "chronicle-hall", choice: null },
        { eventId: "chronicle-bell", choice: "放下钟锤，保全沉默" },
        { eventId: "chronicle-garden", choice: "把钥匙埋进温室" },
        { eventId: "chronicle-return", choice: "让未被书写的名字随潮水离去" }
      ],
      chapters: [
        { id: "chronicle-if-silence-c1", title: "分歧 · 没有第十四声的夜", fromStep: 0 },
        { id: "chronicle-if-silence-c2", title: "结局 · 被保全的平静", fromStep: 3 }
      ]
    },
    {
      id: "chronicle-if-echo",
      mode: "if",
      title: "IF · 第十四声之后",
      parentStoryId: "chronicle-canon",
      divergenceEventId: "chronicle-bell",
      steps: [
        { eventId: "chronicle-letter", choice: null },
        { eventId: "chronicle-hall", choice: null },
        { eventId: "chronicle-bell", choice: "敲响第十四声，接受回响" },
        { eventId: "chronicle-fourteenth", choice: "允许所有可能性显形" },
        { eventId: "chronicle-whale", choice: "让每个结局自己寻找归宿" },
        { eventId: "chronicle-return", choice: "带着多重记忆归航" }
      ],
      chapters: [
        { id: "chronicle-if-echo-c1", title: "分歧 · 所有窗都映出另一座城", fromStep: 0 },
        { id: "chronicle-if-echo-c2", title: "结局 · 选择仍在继续", fromStep: 3 }
      ]
    }
  ],
  // --- W0-07：无需世界规则条目即可游玩的完整演示世界 ---
  // 地图标定：移动即可产生真实距离/时长，不依赖任何世界书条目。
  mapTravelSettings: {
    enabled: true,
    distancePerCell: 2,
    distanceUnit: "里",
    defaultSpeed: 8,
    terrainFactors: { north: 1.4, capital: 1, isles: 1.2 }
  },
  // 人物动态状态（与 Character 档案分离）：4 人物各处的当前地区/地点。
  characterStates: [
    { characterId: "chronicle-c1", currentRegionId: "capital", currentPointId: "4103", status: "持钥人，已在白塔钟座", updatedAt: 0 },
    { characterId: "chronicle-c2", currentRegionId: "capital", currentPointId: "4103", status: "白塔守钟人，等待第十三声", updatedAt: 0 },
    { characterId: "chronicle-c3", currentRegionId: "north", currentPointId: "4102", status: "无火大厅守望者", updatedAt: 0 },
    { characterId: "chronicle-c4", currentRegionId: "isles", currentPointId: "4105", status: "潮门引航人", updatedAt: 0 }
  ],
  // 人物记忆（含 branchId）：第一人称镜头按时间+分支过滤，不泄露未来/他人记忆。
  characterMemories: [
    {
      id: "chronicle-mem-c1-hall",
      characterId: "chronicle-c1",
      at: 418.04,
      content: "无火大厅里，三位守望者交出旧王留下的半枚钥匙；鲸鸣越过群山叫出了我的名字。",
      regionId: "north",
      pointId: "4102",
      eventId: "chronicle-hall",
      important: true,
      createdAt: 0,
      branchId: null
    },
    {
      id: "chronicle-mem-c1-silence",
      characterId: "chronicle-c1",
      at: 418.12,
      content: "我放下钟锤，把两枚钥匙埋进温室花园——王都保住了秩序，却开始遗忘所有无法被证明的奇迹。",
      regionId: "capital",
      pointId: "4104",
      eventId: "chronicle-garden",
      important: true,
      createdAt: 0,
      branchId: "chronicle-if-silence"
    },
    {
      id: "chronicle-mem-c4-whale",
      characterId: "chronicle-c4",
      at: 418.13,
      content: "鲸骨档案馆证实：三百年前有人第一次听见第十三声，却在敲下第十四声前把钟锤沉进海里。",
      regionId: "isles",
      pointId: "4106",
      eventId: "chronicle-whale",
      important: true,
      createdAt: 0,
      branchId: "chronicle-if-echo"
    }
  ],
  // 预置运行态：正史 + 两条 IF 创建后立即可游玩（带当前时间/地点/日志）。
  storyRuntimes: [
    {
      storyId: "chronicle-canon",
      currentTime: 418.07,
      currentRegionId: "capital",
      currentPointId: "4103",
      worldFlags: ["bell-rung"],
      actionLog: ["act-c-letter", "act-c-hall", "act-c-bell"],
      updatedAt: 0
    },
    {
      storyId: "chronicle-if-silence",
      currentTime: 418.12,
      currentRegionId: "capital",
      currentPointId: "4104",
      worldFlags: ["key-buried"],
      actionLog: [],
      snapshotFrom: "chronicle-canon",
      updatedAt: 0
    },
    {
      storyId: "chronicle-if-echo",
      currentTime: 418.13,
      currentRegionId: "isles",
      currentPointId: "4106",
      worldFlags: ["echo-open"],
      actionLog: [],
      snapshotFrom: "chronicle-canon",
      updatedAt: 0
    }
  ],
  // 预置会话：两种阅读镜头演示预设（第一人称视觉小说 / 阅读式叙事）。
  agentSessions: [
    {
      storyId: "chronicle-canon",
      presentationMode: "reader",
      knowledgeScope: "全知作者视角：展示整条正史分支",
      updatedAt: 0
    },
    {
      storyId: "chronicle-if-silence",
      presentationMode: "firstPerson",
      viewpointCharacterId: "chronicle-c1",
      updatedAt: 0
    },
    {
      storyId: "chronicle-if-echo",
      presentationMode: "firstPerson",
      viewpointCharacterId: "chronicle-c1",
      updatedAt: 0
    }
  ],
  // 可运行事件钩子：抵达王都时触发「白塔余响」（不依赖世界书，演示触发路径）。
  triggers: [
    {
      id: "chronicle-trig-bell",
      enabled: true,
      title: "白塔余响",
      conditionSummary: "抵达王都（capital）时，钟座残留第十三声的回响",
      condition: { regionId: "capital" },
      outcomeTemplate: "钟座深处传来第十三声的余响，薇尔指尖一颤。",
      // N1：outcomeTags 与运行态 worldFlags 必须同名，否则「哪个行动产生了哪个标记」
      // 无法回溯，历史时点投影也就无法撤销锚点之后的标记。
      outcomeTags: ["bell-rung"],
      createdAt: 0,
      updatedAt: 0
    }
  ],
  // 预置已游玩行动：让「正史·星环余烬」的阅读镜头立即可见已发生的事（无需用户先手动游玩）。
  actions: [
    {
      id: "act-c-letter",
      at: 418.02,
      kind: "interact",
      actorId: "chronicle-c1",
      fromRegionId: "north",
      fromPointId: "4101",
      toRegionId: "north",
      toPointId: "4101",
      duration: 1,
      durationSource: "baseline",
      baselineVersion: "dtb-1",
      startedAt: 418.02,
      endedAt: 419.02,
      outcomeId: "out-c-letter"
    },
    {
      id: "act-c-hall",
      at: 418.04,
      kind: "move",
      actorId: "chronicle-c1",
      fromRegionId: "north",
      fromPointId: "4101",
      toRegionId: "north",
      toPointId: "4102",
      duration: 2,
      durationSource: "baseline",
      baselineVersion: "dtb-1",
      startedAt: 419.02,
      endedAt: 421.02,
      outcomeId: "out-c-hall"
    },
    {
      id: "act-c-bell",
      at: 418.07,
      kind: "choice",
      actorId: "chronicle-c1",
      fromRegionId: "capital",
      fromPointId: "4103",
      toRegionId: "capital",
      toPointId: "4103",
      duration: 1,
      durationSource: "baseline",
      baselineVersion: "dtb-1",
      startedAt: 421.02,
      endedAt: 422.02,
      outcomeId: "out-c-bell"
    }
  ],
  outcomes: [
    { id: "out-c-letter", actionId: "act-c-letter", kind: "nothing", result: "薇尔读到无火大厅的来信，决定前往北境。", reason: "已确收信件" },
    { id: "out-c-hall", actionId: "act-c-hall", kind: "nothing", result: "北境雪原，薇尔在无火大厅接过旧王留下的半枚钥匙。", reason: "抵达无火大厅" },
    // N1：changeRefs 记录「这个标记由哪次行动的结果产生」，历史时点投影据此撤销锚点之后的标记。
    { id: "out-c-bell", actionId: "act-c-bell", kind: "trigger", triggerId: "chronicle-trig-bell", result: "白塔第十三声落下；余响在钟座深处震动，王都记起了彼此矛盾的昨天。", reason: "抵达王都触发白塔余响", changeRefs: ["trigger:chronicle-trig-bell", "flag:bell-rung"] }
  ],
  // N3：预置一个「故事中段导入」入口锚点，演示地图 / 时间轴进入同一入口
  entryAnchors: [
    {
      id: "anc-chronicle-letter",
      sourceCardId: "chronicle-letter",
      cardType: "event",
      eventId: "chronicle-letter",
      at: 200.5,
      regionId: "north",
      pointId: "4101",
      x: 20,
      y: 20,
      entryPolicy: "import-moment",
      completenessNote: "中段导入：雪线来信的正文与北境背景",
      createdAt: 0
    }
  ]
};
var DEMO_TEMPLATES = [
  completeExperienceTemplate,
  {
    id: "aurelia",
    name: "Aurelia",
    description: "帝国末期 3 大地区：北境要塞、星环王都、潮汐群岛。30+ 事件覆盖政治、军事、宗教、神秘。",
    defaultYear: 312,
    events: aurelianEvents,
    // UI-004 v1：4 人物（主角 + 反派 + 2 配角），跨 3 地区
    characters: [
      { id: "aurelia-c1", worldId: "demo", name: "艾兰·星环", role: "末代公主", description: "星环王都末代公主，黑潮入侵后流亡北境，召集七领主抵抗。", currentRegionId: "north", tags: ["主角", "皇室", "法师"] },
      { id: "aurelia-c2", worldId: "demo", name: "黑潮将军", role: "反派首领", description: "北方黑潮军首领，真实身份为被流放的皇室血脉。", currentRegionId: "north", tags: ["反派", "将军", "皇室"] },
      { id: "aurelia-c3", worldId: "demo", name: "守夜人总长", role: "北境守将", description: "北境要塞守夜人总长，坚守要塞 30 年。", currentRegionId: "north", tags: ["配角", "军人"] },
      { id: "aurelia-c4", worldId: "demo", name: "群岛女祭司", role: "海神代言人", description: "潮汐群岛海神祭司，能听懂鲸鸣中的预言。", currentRegionId: "isles", tags: ["配角", "祭司", "神秘"] }
    ],
    // B1 v1：每个模板独立的 3 个地区（不能与 Aurelia 共享；worldId 占位由 createNewWorld 替换）
    regions: [
      { id: "north", name: "北境要塞", type: "mountain", description: "冬日王冠的最后防线，黑潮军三度叩关。", coordinates: { x: 35, y: 24 }, subtitle: "北境", tone: "#b6d9d1" },
      { id: "capital", name: "星环王都", type: "city", description: "帝国心脏与浮空之城，白塔议事厅所在。", coordinates: { x: 57, y: 48 }, subtitle: "王都", tone: "#e7c982" },
      { id: "isles", name: "潮汐群岛", type: "sea", description: "风暴、商船与无名之王的群岛。", coordinates: { x: 76, y: 72 }, subtitle: "群岛", tone: "#8bc0cc" }
    ]
  },
  {
    id: "aelan",
    name: "埃兰大陆",
    description: "金叶王朝治下 3 大地区：龙脊山、圣城、群岛。30+ 事件聚焦宗教改革、王朝更替、海洋探索。",
    defaultYear: 1120,
    events: aelanEvents,
    characters: [
      { id: "aelan-c1", worldId: "demo", name: "金叶王子", role: "改革派", description: "金叶王朝王子，推行税制改革削弱大主教权力。", currentRegionId: "capital", tags: ["主角", "皇室", "改革派"] },
      { id: "aelan-c2", worldId: "demo", name: "大主教", role: "保守派首领", description: "圣城大主教，垄断宗教权威，反对任何改革。", currentRegionId: "capital", tags: ["反派", "祭司", "保守派"] },
      { id: "aelan-c3", worldId: "demo", name: "雪山贤者", role: "龙脊山智者", description: "龙脊山隐居贤者，发现石巨人苏醒真相。", currentRegionId: "north", tags: ["配角", "贤者", "神秘"] },
      { id: "aelan-c4", worldId: "demo", name: "群岛海盗王", role: "海洋霸主", description: "群岛海盗联盟首领，传说中为无名之王的后裔。", currentRegionId: "isles", tags: ["配角", "海盗", "传奇"] }
    ],
    regions: [
      { id: "north", name: "龙脊山", type: "mountain", description: "永夜降临之地，部族与雪山贤者隐居其间。", coordinates: { x: 30, y: 18 }, subtitle: "龙脊", tone: "#a5b3a3" },
      { id: "capital", name: "圣城", type: "city", description: "金叶王朝都城，大主教驻锡之地。", coordinates: { x: 55, y: 42 }, subtitle: "圣城", tone: "#c9b687" },
      { id: "isles", name: "群岛", type: "sea", description: "海盗联盟领地，无名之王传说的源头。", coordinates: { x: 78, y: 70 }, subtitle: "群岛", tone: "#7faab5" }
    ]
  },
  {
    id: "stars",
    name: "群星历险记",
    description: "2348 年星际联邦时代 3 大地区：极光站、星际首都、木卫二基地。30+ 事件聚焦星际探索、能源革命、外星生命。",
    defaultYear: 2348,
    events: starsEvents,
    characters: [
      { id: "stars-c1", worldId: "demo", name: "星际舰长", role: "远航者", description: "联邦「星环号」舰长，带领团队首次完成半人马座远航。", currentRegionId: "capital", tags: ["主角", "舰长", "探索者"] },
      { id: "stars-c2", worldId: "demo", name: "科学狂人", role: "AI 失控者", description: "联邦首席科学家，私自开发外星细菌武器。", currentRegionId: "capital", tags: ["反派", "科学家", "狂人"] },
      { id: "stars-c3", worldId: "demo", name: "极光站长", role: "北极守望者", description: "极光站站长，发现跨极通讯的科学家。", currentRegionId: "north", tags: ["配角", "科学家", "守望者"] },
      { id: "stars-c4", worldId: "demo", name: "外星先知", role: "外星接触者", description: "首个与外星信号建立对话的人类，开启星际外交。", currentRegionId: "isles", tags: ["配角", "外星", "先知"] }
    ],
    regions: [
      { id: "north", name: "极光站", type: "plain", description: "北极首座永久基地，极光通讯的源头。", coordinates: { x: 32, y: 20 }, subtitle: "极光", tone: "#3b4a52" },
      { id: "capital", name: "星际首都", type: "city", description: "联邦首府，星际港与议会大厦所在。", coordinates: { x: 58, y: 50 }, subtitle: "首都", tone: "#4d6a72" },
      { id: "isles", name: "木卫二基地", type: "sea", description: "冰下海洋研究基地，外星细菌的发现地。", coordinates: { x: 72, y: 75 }, subtitle: "木卫二", tone: "#6e7d8c" }
    ]
  },
  {
    id: "fog",
    name: "雾都异闻",
    description: "1920s 雾都 3 大地区：北境探案、雾都议会、群岛雾咒。30+ 事件聚焦超自然现象、悬案、神秘预言。",
    defaultYear: 1924,
    events: fogEvents,
    characters: [
      { id: "fog-c1", worldId: "demo", name: "雾都侦探", role: "私家侦探", description: "雾都最负盛名的私家侦探，专接超自然案件。", currentRegionId: "capital", tags: ["主角", "侦探", "理性派"] },
      { id: "fog-c2", worldId: "demo", name: "红衣女子", role: "超自然实体", description: "雾都传说中的超自然实体，真身无人知晓。", currentRegionId: "capital", tags: ["反派", "超自然", "神秘"] },
      { id: "fog-c3", worldId: "demo", name: "北境守林人", role: "雾门守护者", description: "北境守林人，世代守护传说中的雾门。", currentRegionId: "north", tags: ["配角", "守林人", "神秘"] },
      { id: "fog-c4", worldId: "demo", name: "群岛祭司", role: "海雾术士", description: "群岛唯一能施海雾咒的术士，可召唤雾船迷航。", currentRegionId: "isles", tags: ["配角", "术士", "海雾"] }
    ],
    regions: [
      { id: "north", name: "北境探案", type: "plain", description: "雾都北境，守林人与雾门传说的源头。", coordinates: { x: 28, y: 22 }, subtitle: "北境", tone: "#7a7670" },
      { id: "capital", name: "雾都议会", type: "city", description: "雾都中心，议会与雾钟所在。", coordinates: { x: 52, y: 48 }, subtitle: "议会", tone: "#9e9489" },
      { id: "isles", name: "群岛雾咒", type: "sea", description: "群岛海雾术士与无名岛传说的核心。", coordinates: { x: 74, y: 72 }, subtitle: "群岛", tone: "#8a8b7e" }
    ]
  }
];
function getDemoTemplate(id) {
  return DEMO_TEMPLATES.find((t) => t.id === id) ?? null;
}
function getDemoTemplateByName(name) {
  return DEMO_TEMPLATES.find((t) => t.name === name) ?? null;
}
function cloneTravelSettings(src) {
  if (!src) return void 0;
  return {
    enabled: src.enabled,
    distancePerCell: src.distancePerCell,
    distanceUnit: src.distanceUnit,
    defaultSpeed: src.defaultSpeed,
    ...src.terrainFactors ? { terrainFactors: { ...src.terrainFactors } } : {}
  };
}
function buildWorldFromTemplate(template, opts) {
  const worldId = opts.id;
  const regions = template.regions.map((r) => ({ ...r, worldId }));
  const events = normalizeEventIds(
    Object.fromEntries(
      Object.entries(template.events).map(([regionId, evs]) => [
        regionId,
        evs.map((event) => ({
          ...event,
          ...event.characterIds ? { characterIds: [...event.characterIds] } : {}
        }))
      ])
    )
  );
  const characters = template.characters.map((character) => ({
    ...character,
    worldId,
    ...character.tags ? { tags: [...character.tags] } : {}
  }));
  const points = template.points?.map((p) => ({ ...p }));
  const stories = template.stories?.map((story) => ({
    ...story,
    worldId,
    steps: story.steps.map((step) => ({ ...step })),
    ...story.chapters ? { chapters: story.chapters.map((chapter) => ({ ...chapter })) } : {}
  }));
  const characterStates = template.characterStates?.map((s) => ({ ...s }));
  const characterMemories = template.characterMemories?.map((m) => ({ ...m }));
  const storyRuntimes = template.storyRuntimes?.map((rt) => ({
    ...rt,
    ...rt.companions ? { companions: [...rt.companions] } : {},
    ...rt.worldFlags ? { worldFlags: [...rt.worldFlags] } : {},
    ...rt.actionLog ? { actionLog: [...rt.actionLog] } : {}
  }));
  const agentSessions = template.agentSessions?.map((s) => ({
    ...s,
    ...s.openThreads ? { openThreads: [...s.openThreads] } : {},
    ...s.activeCardSessionIds ? { activeCardSessionIds: [...s.activeCardSessionIds] } : {}
  }));
  const triggers = template.triggers?.map((t) => ({ ...t }));
  const actions = template.actions?.map((a) => ({
    ...a,
    ...a.viaPointIds ? { viaPointIds: [...a.viaPointIds] } : {},
    ...a.candidateSources ? { candidateSources: [...a.candidateSources] } : {}
  }));
  const outcomes = template.outcomes?.map((o) => ({ ...o }));
  const entryAnchors = template.entryAnchors?.map((a) => ({ ...a }));
  const travelSettings = cloneTravelSettings(template.mapTravelSettings);
  const defaultRegionId = opts.regionId === null || typeof opts.regionId === "string" && opts.regionId.length > 0 ? opts.regionId : regions[0]?.id ?? null;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: worldId,
    name: opts.name?.trim() || template.name,
    description: opts.description?.trim() || template.description,
    currentRegionId: defaultRegionId,
    currentYear: template.defaultYear,
    createdAt: opts.now,
    updatedAt: opts.now,
    regions,
    events,
    characters,
    ...points ? { points } : {},
    ...stories ? { stories } : {},
    ...characterStates ? { characterStates } : {},
    ...characterMemories ? { characterMemories } : {},
    ...storyRuntimes ? { storyRuntimes } : {},
    ...agentSessions ? { agentSessions } : {},
    ...triggers ? { triggers } : {},
    ...actions ? { actions } : {},
    ...outcomes ? { outcomes } : {},
    ...entryAnchors ? { entryAnchors } : {},
    ...travelSettings ? { travelSettings } : {}
  };
}

// src/atlas-host-connections.ts
function toResponse(like) {
  return like;
}
function textResponse(text) {
  const body = JSON.stringify({ choices: [{ message: { content: text } }] });
  return toResponse({
    ok: true,
    status: 200,
    text: async () => body,
    json: async () => JSON.parse(body),
    clone: () => ({ text: async () => body })
  });
}
function hostErrorJsonResponse(message) {
  const body = JSON.stringify({ error: { message } });
  return toResponse({
    ok: true,
    status: 200,
    text: async () => body,
    json: async () => JSON.parse(body),
    clone: () => ({ text: async () => body })
  });
}
function parseHostPayload(init) {
  if (typeof init?.body !== "string" || !init.body.trimStart().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(init.body);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
function orderedPromptsOf(payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  return messages.filter((m) => !!m && typeof m === "object" && typeof m.role === "string" && typeof m.content === "string").map((m) => ({ role: m.role, content: m.content }));
}
function isTavernMainAvailable(getHost) {
  const helper = getHost();
  return !!helper && typeof helper.generateRaw === "function";
}
function isConnectionManagerAvailable(getContext) {
  const ctx = getContext();
  return !!ctx?.ConnectionManagerRequestService && typeof ctx.ConnectionManagerRequestService.sendRequest === "function";
}
function getConnectionManagerProfiles(getContext) {
  const ctx = getContext();
  const profiles = ctx?.extensionSettings?.connectionManager?.profiles;
  if (!Array.isArray(profiles)) return [];
  return profiles.filter((p) => !!p && typeof p === "object" && typeof p.id === "string").map((p) => ({ id: p.id, name: String(p.name ?? p.id) }));
}
function createTavernMainFetch(deps) {
  return async (_input, init) => {
    const payload = parseHostPayload(init);
    const helper = deps.getTavernHelper();
    if (!helper || typeof helper.generateRaw !== "function") {
      return hostErrorJsonResponse("主API生成不可用：未检测到酒馆助手（TavernHelper.generateRaw）。请安装酒馆助手（JS-Slash-Runner），或改用自定义 API 连接。");
    }
    const prompts = payload ? orderedPromptsOf(payload) : [];
    if (prompts.length === 0) return hostErrorJsonResponse("主API生成失败：请求缺少有效的 messages。");
    const maxTokens = typeof payload?.max_tokens === "number" ? payload.max_tokens : void 0;
    try {
      const response = await helper.generateRaw({ ordered_prompts: prompts, should_stream: false, ...maxTokens ? { max_tokens: maxTokens } : {} });
      const text = typeof response === "string" ? response : String(response ?? "");
      if (!text.trim()) return hostErrorJsonResponse("主API生成返回为空。");
      return textResponse(text.trim());
    } catch (error) {
      return hostErrorJsonResponse(`主API生成失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
var profileCallTail = Promise.resolve();
function triggerSlash(helper, command) {
  const fn = helper?.triggerSlash;
  if (typeof fn !== "function") return Promise.resolve("");
  return fn(command);
}
function createTavernProfileFetch(deps) {
  return async (_input, init) => {
    const payload = parseHostPayload(init);
    const ctx = deps.getContext();
    const service = ctx?.ConnectionManagerRequestService;
    if (!service || typeof service.sendRequest !== "function") {
      return hostErrorJsonResponse("ConnectionManagerRequestService 不可用。请检查酒馆版本或连接管理器配置。");
    }
    const profileId = typeof payload?.xAtlasProfileId === "string" ? payload.xAtlasProfileId.trim() : "";
    if (!profileId) return hostErrorJsonResponse("酒馆连接预设模式未选择连接预设。");
    const prompts = payload ? orderedPromptsOf(payload) : [];
    if (prompts.length === 0) return hostErrorJsonResponse("酒馆连接预设调用失败：请求缺少有效的 messages。");
    const maxTokens = typeof payload?.max_tokens === "number" ? payload.max_tokens : 1024;
    const profiles = getConnectionManagerProfiles(deps.getContext);
    const target = profiles.find((p) => p.id === profileId);
    const targetName = target?.name ?? profileId;
    const run = async () => {
      const helper = deps.getTavernHelper();
      const originalProfile = await triggerSlash(helper, "/profile");
      const needSwitch = !!originalProfile && originalProfile !== targetName;
      try {
        if (needSwitch) {
          await triggerSlash(helper, `/profile await=true "${targetName.replace(/"/g, '\\"')}"`);
        }
        const response = await service.sendRequest(profileId, prompts, maxTokens);
        const content = response?.result?.choices?.[0]?.message?.content ?? response?.content;
        const text = typeof content === "string" ? content : "";
        if (!text.trim()) return hostErrorJsonResponse("酒馆连接预设返回为空或形状不支持。");
        return textResponse(text.trim());
      } catch (error) {
        return hostErrorJsonResponse(`酒馆连接预设调用失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (needSwitch) {
          try {
            const current = await triggerSlash(helper, "/profile");
            if (current !== originalProfile) {
              await triggerSlash(helper, `/profile await=true "${originalProfile.replace(/"/g, '\\"')}"`);
            }
          } catch {
          }
        }
      }
    };
    const result = profileCallTail.then(run, run);
    profileCallTail = result.catch(() => void 0);
    return result;
  };
}

// src/atlas-starter-world.ts
var MAX_NAME_CHARS2 = 60;
var MAX_DESCRIPTION_CHARS = 2e3;
var FNV_OFFSET_64 = 0xcbf29ce484222325n;
var FNV_PRIME_64 = 0x100000001b3n;
var MASK_64 = 0xffffffffffffffffn;
function starterWorldIdForChat(chatId) {
  const bytes = new TextEncoder().encode(typeof chatId === "string" ? chatId : "");
  let hash = FNV_OFFSET_64;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = hash * FNV_PRIME_64 & MASK_64;
  }
  return `world-auto-${hash.toString(16).padStart(16, "0")}`;
}
function buildStarterWorld(options) {
  const cardName = (options.name ?? "").trim().slice(0, MAX_NAME_CHARS2);
  const worldName = cardName ? `${cardName} 的世界` : "新世界";
  const description = (options.description ?? "").trim().slice(0, MAX_DESCRIPTION_CHARS);
  return {
    schemaVersion: 1,
    id: options.id,
    name: worldName,
    description,
    currentRegionId: "start",
    currentYear: 1,
    createdAt: options.now,
    updatedAt: options.now,
    regions: [
      {
        id: "start",
        worldId: options.id,
        name: "起点",
        type: "other",
        description: description ? description.slice(0, 500) : "故事开始的地方。",
        coordinates: { x: 0, y: 0 }
      }
    ],
    points: [{ id: 1, name: "起点", x: 50, y: 50, regionId: "start" }],
    characters: [
      {
        id: "char-main",
        worldId: options.id,
        name: cardName || "主角",
        role: "主角",
        description: description.slice(0, 1e3),
        currentRegionId: "start"
      }
    ]
  };
}
export {
  ATLAS_BROWSER_DOC_LIMITS,
  ATLAS_ERROR_CODES,
  ATLAS_LIMITS,
  ATLAS_LOREBOOK_LIMITS,
  ATLAS_LOREBOOK_PREFIX,
  ATLAS_PROTOCOL_VERSION,
  ATLAS_ST_GENERATE_PATH,
  ATLAS_UI_EVENTS,
  AtlasError,
  DEFAULT_WORLD_TURN_SYSTEM_PROMPT,
  DEMO_TEMPLATES,
  atlasClampZoom,
  atlasCustomIncludeHeaders,
  buildStarterWorld,
  buildWorldFromTemplate,
  createAtlasLorebookWriter,
  createAtlasServerCore,
  createAtlasUiCore,
  createBrowserDocumentStore,
  createLocalAtlasApi,
  createStProxyFetch,
  createTavernMainFetch,
  createTavernProfileFetch,
  getConnectionManagerProfiles,
  getDemoTemplate,
  getDemoTemplateByName,
  isConnectionManagerAvailable,
  isTavernMainAvailable,
  lorebookNameFor,
  normalizeAtlasClaudeBase,
  normalizeAtlasExcludeBody,
  normalizeAtlasGeminiBase,
  normalizeAtlasPromptPostProcessing,
  parseAtlasChatBinding,
  starterWorldIdForChat
};
