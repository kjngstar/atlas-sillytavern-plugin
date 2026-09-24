/**
 * Safe, bounded diagnostics shared by the browser shell, UI core and engine.
 * Only explicitly named metadata survives sanitization. Never put prompts,
 * responses, URLs, chat IDs or Error objects into an input field.
 *
 * A04：需要在日志里按「聊天 / 分支 / 回合」定位，又**不得**出现原始 chatId / 分支名 /
 * turnKey —— 因此新增 `atlasRefFingerprint`（确定性 64 位 FNV-1a + 雪崩收尾，输出
 * `ref-<16 位小写十六进制>`）与一组只接受该形态的 `*Ref` 详情键。指纹单向、与进程无关，
 * 同一输入永远同一指纹，跨会话比对同一聊天/分支/回合时不会泄漏原文。
 */
export type AtlasDiagnosticLevel = "debug" | "info" | "warn" | "error";
export type AtlasDiagnosticSource = "host" | "ui" | "engine" | "model" | "storage" | "lorebook" | "map";
export type AtlasDiagnosticOutcome = "started" | "success" | "skipped" | "failed" | "recovered";

export interface AtlasDiagnostic {
  schemaVersion: 1;
  id: string;
  at: string;
  level: AtlasDiagnosticLevel;
  source: AtlasDiagnosticSource;
  code: string;
  operation: string;
  phase: string;
  outcome: AtlasDiagnosticOutcome;
  traceId?: string;
  attemptId?: string;
  chatRef?: string;
  /** A04：当前聊天的脱敏指纹（`ref-<16 位十六进制>`）。与 `chatRef` 并存，不改变旧字段含义。 */
  chatFingerprint?: string;
  httpStatus?: number;
  errorCode?: string;
  retryable?: boolean;
  durationMs?: number;
  details?: Record<string, string | number | boolean | null>;
  count?: number;
  truncated?: boolean;
}

export type AtlasDiagnosticInput = Omit<AtlasDiagnostic, "schemaVersion" | "id" | "at"> &
  Partial<Pick<AtlasDiagnostic, "id" | "at">>;

type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const LEVELS = new Set(["debug", "info", "warn", "error"]);
const SOURCES = new Set(["host", "ui", "engine", "model", "storage", "lorebook", "map"]);
const OUTCOMES = new Set(["started", "success", "skipped", "failed", "recovered"]);
const DETAIL_KEYS = new Set([
  "route", "mode", "reasonCode", "schemaPath", "protocolVersion",
  "responseChars", "capability", "event", "build", "coreCommitted",
  "count", "stage", "attempt", "scanned", "cleaned", "kept", "malformed",
  // A04：具名诊断的安全定位字段。`*Ref` 只接受 atlasRefFingerprint 的形态
  // （原始 chatId / 分支名 / turnKey 一律丢弃）；collection 与计数字段见下方校验。
  // 聊天指纹只走顶层 `chatFingerprint`（注册表把它列为可传键，组装时镜像到顶层），
  // 不在 details 里另留一份，避免同一条日志出现两个含义相同的键。
  "branchRef", "turnRef", "worldRef", "actorRef", "locationRef", "signalRef", "taskRef",
  "collection",
  "droppedCount", "limitCount", "keptCount", "truncatedCount", "scannedCount",
]);
// 0.9.54 A9/A11：允许 `$` `[` `]`，否则 JSON 路径（$.relationUpdates[0].value）永远过不了
// safeToken —— `$` 是 JSONPath 的根记号，缺它整条 schemaPath 都进不了诊断。
// URL 仍由调用处的 `://` 检查挡住（该类含 `:` 与 `/`，故该检查不可省略）。
const SAFE_ATOM = /^[a-zA-Z0-9_.$:\[\]-]{1,120}$/;
const SAFE_ROUTES = new Set([
  "model-proxy", "host-model", "model-status", "/health", "/settings", "/worlds",
  "/worlds/import", "/worlds/ensure-starter", "/worlds/geo/adopt", "/worlds/move-author",
  "/worlds/scale/calibrate", "/bindings", "/state", "/map/image", "/turns/prepare",
  "/turns/preview", "/scene/bootstrap", "/turns/commit", "/turns/retry",
  "/turns/restore", "/turns/rollback", "/map/travel-preview",
  "/session/export", "/session/purge",
]);
const SAFE_CAPABILITIES = new Set(["setExtensionPrompt", "eventSource", "getContext", "generateRaw"]);
const SAFE_MODES = new Set(["main", "profile", "custom", "openai", "claude", "gemini", "v1", "v2"]);
// A04：simulationUndo.collection 的精确取值域（§2.1 的四个数组 + 地理拓扑三数组）。
const SAFE_COLLECTIONS = new Set(["tasks", "signals", "deliveries", "edges", "areas", "vehicles"]);
// A04：计数字段（有限非负整数 + 上界钳制）。键名不在集合内时沿用旧的通用数值分支。
const SAFE_COUNT_KEYS = new Set([
  "droppedCount", "limitCount", "keptCount", "truncatedCount", "scannedCount",
]);
let nextId = 0;

// ---------------------------------------------------------------------------
// A04：脱敏引用指纹
// ---------------------------------------------------------------------------

const REF_PREFIX = "ref-";
const REF_HEX_CHARS = 16;
const REF_DIGITS = REF_HEX_CHARS * 4;
const REF_MASK = (1n << BigInt(REF_DIGITS)) - 1n;
const REF_PATTERN = /^ref-[a-f0-9]{8,16}$/;
// 64 位 FNV-1a 常量（与 atlas-starter-world 的哈希基座同源：UTF-8 字节、确定性、无符号）
const REF_OFFSET_64 = 0xcbf29ce484222325n;
const REF_PRIME_64 = 0x100000001b3n;
// 雪崩收尾乘子（splitmix64 的 64 位奇数常量，十进制）：FNV 低位雪崩偏弱，收尾后
// 只差一个字符的输入也会把差异扩散到全部 64 位，把相邻 chatId 的碰撞概率压到 2^-64。
const REF_MIX_1 = 0xbf58476d1ce4e5b9n;
const REF_MIX_2 = 0x94d049bb133111ebn;

function refUtf8Bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(typeof value === "string" ? value : "");
}

/**
 * A04：把 chatId / branchKey / turnKey / 实体 ID 之类的原始标识换成**确定性脱敏指纹**。
 *
 * - 输出固定为 `ref-` + 16 位小写十六进制；同一输入永远同一指纹，不依赖 `Date.now` /
 *   `Math.random` / 进程状态，因此跨刷新、跨会话可以比对「是不是同一个聊天/分支/回合」；
 * - 指纹单向：日志里能定位，却看不到原始 chatId、分支名或 turnKey（也不含任何原文片段）；
 * - 非字符串输入按空串处理（`atlasRefFingerprint(null)` 是稳定常量），不抛异常。
 *
 * 不得用它承载正文/key：指纹只用于定位，`sanitizeDiagnostic` 也只在 `*Ref` 形态匹配时保留。
 */
export function atlasRefFingerprint(raw: unknown): string {
  const bytes = refUtf8Bytes(raw);
  let hash = REF_OFFSET_64;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= BigInt(bytes[index]);
    hash = (hash * REF_PRIME_64) & REF_MASK;
  }
  hash ^= hash >> 30n;
  hash = (hash * REF_MIX_1) & REF_MASK;
  hash ^= hash >> 27n;
  hash = (hash * REF_MIX_2) & REF_MASK;
  hash ^= hash >> 31n;
  return REF_PREFIX + hash.toString(16).padStart(REF_HEX_CHARS, "0");
}

/** A04：某个值是否已经是合法的脱敏指纹（8–16 位小写十六进制）。 */
export function isAtlasRefFingerprint(value: unknown): value is string {
  return typeof value === "string" && REF_PATTERN.test(value);
}

/**
 * A04：details 里属于「定位指纹」的键 —— 七个 `*Ref`（`branchRef` / `turnRef` / `worldRef` /
 * `actorRef` / `locationRef` / `signalRef` / `taskRef`）。它们只接受 `isAtlasRefFingerprint`
 * 的形态，其它任何值（原始 ID、分支名、正文、布尔、null、数字）都直接丢弃，绝不写进诊断。
 * 聊天指纹不在此列：它固定走顶层 `chatFingerprint` 字段。
 */
function isAtlasRefDetailKey(key: string): boolean {
  return key.length > 3 && key.endsWith("Ref");
}

/**
 * A04：把顶层 `chatRef`（`chat-<hex>`）或裸 chatId 统一成脱敏指纹；非法输入返回 null。
 * 两种写法会被归一到同一指纹（服务端只有 ref、浏览器只有裸 id，两边日志要能对上）；
 * 非法输入返回 null 而不是原文，调用方不得把 null 当字符串写进诊断。
 */
export function chatFingerprintFromRef(chatRef: unknown): string | null {
  if (typeof chatRef !== "string" || !SAFE_ATOM.test(chatRef) || chatRef.includes("://")) return null;
  const source = /^chat-[a-z0-9]{4,16}$/.test(chatRef) ? chatRef.slice("chat-".length) : chatRef;
  return atlasRefFingerprint(source);
}

// ---------------------------------------------------------------------------
// A04：具名诊断注册表
// ---------------------------------------------------------------------------

export type AtlasNamedDiagnosticCode =
  | "SESSION_IDENTITY_MISMATCH"
  | "SIMULATION_CORRUPT"
  | "SIMULATION_TRUNCATED"
  | "LOREBOOK_STALE_CHAT_DROPPED"
  | "BACKGROUND_BLOCKED";

export interface AtlasNamedDiagnosticSpec {
  readonly code: AtlasNamedDiagnosticCode;
  readonly level: AtlasDiagnosticLevel;
  readonly source: AtlasDiagnosticSource;
  /**
   * 该诊断允许写入的定位/枚举键。键名之外一律不进日志。
   * `*Ref` 只接受脱敏指纹形态；`chatFingerprint` 是顶层字段（`namedDiagnosticInput` 会把它
   * 镜像到顶层，不落 details）；计数字段与 `collection` 另有形状校验。
   */
  readonly details: readonly string[];
}

/**
 * A04：五个具名诊断的固定契约。后续阶段（B/C/D 的迁移丢弃、推演损坏/截断、后台阻塞）
 * 直接引用这里的 code / level / source / 允许键，避免各处再手写自由字符串——
 * 自由字符串正是把正文、URL、密钥带进日志的主要途径。
 *
 * 有意**不**提供任何正文型键：没有 quote / excerpt / prompt / response / summary / url。
 */
export const ATLAS_NAMED_DIAGNOSTICS: Readonly<Record<AtlasNamedDiagnosticCode, AtlasNamedDiagnosticSpec>> =
  Object.freeze({
    // B：异步迁移 / 写入迟到的聊天身份已与当前上下文不符 → 丢弃，不写回任何表。
    SESSION_IDENTITY_MISMATCH: Object.freeze({
      code: "SESSION_IDENTITY_MISMATCH",
      level: "warn",
      source: "storage",
      details: Object.freeze(["chatFingerprint", "branchRef", "reasonCode", "stage"]),
    }),
    // C05：simulation 损坏 → 读视图报错并保留用户原文，绝不静默归空覆盖。
    SIMULATION_CORRUPT: Object.freeze({
      code: "SIMULATION_CORRUPT",
      level: "error",
      source: "storage",
      details: Object.freeze(["chatFingerprint", "branchRef", "schemaPath", "reasonCode"]),
    }),
    // C：有界截断如实上报（必须同时给出保留/丢弃数量，不能悄悄丢数据）。
    SIMULATION_TRUNCATED: Object.freeze({
      code: "SIMULATION_TRUNCATED",
      level: "warn",
      source: "engine",
      details: Object.freeze([
        "chatFingerprint", "branchRef", "collection", "droppedCount", "keptCount", "limitCount", "reasonCode",
      ]),
    }),
    // B04/B05/D10：世界书重建发现条目属于别的聊天 → 丢弃，不写共享主卡书。
    LOREBOOK_STALE_CHAT_DROPPED: Object.freeze({
      code: "LOREBOOK_STALE_CHAT_DROPPED",
      level: "warn",
      source: "lorebook",
      details: Object.freeze(["chatFingerprint", "branchRef", "reasonCode", "stage"]),
    }),
    // D01/D02：后台任务/信号传播被阻塞（NO_PATH / NO_TIME / TOO_FAR…）→ 如实记录，不假装已抵达。
    BACKGROUND_BLOCKED: Object.freeze({
      code: "BACKGROUND_BLOCKED",
      level: "info",
      source: "engine",
      details: Object.freeze([
        "chatFingerprint", "branchRef", "turnRef", "taskRef", "actorRef", "locationRef", "reasonCode",
      ]),
    }),
  } as Record<AtlasNamedDiagnosticCode, AtlasNamedDiagnosticSpec>);

/** A04：取某个具名诊断的契约；未知 code 返回 null（调用方不得自造键名）。 */
export function namedDiagnosticSpec(code: string): AtlasNamedDiagnosticSpec | null {
  const registry: Record<string, AtlasNamedDiagnosticSpec | undefined> =
    ATLAS_NAMED_DIAGNOSTICS as unknown as Record<string, AtlasNamedDiagnosticSpec | undefined>;
  return registry[code] ?? null;
}

/** A04：某个 details 键是否被任一具名诊断允许（供 UI / 迁移期做键名白名单提示）。 */
export function isAllowedNamedDiagnosticDetail(key: string): boolean {
  return Object.values(ATLAS_NAMED_DIAGNOSTICS).some((spec) => spec.details.includes(key));
}

export interface AtlasNamedDiagnosticInput {
  readonly code: AtlasNamedDiagnosticCode;
  readonly operation: string;
  readonly phase: string;
  readonly outcome: AtlasDiagnosticOutcome;
  readonly chatRef?: string;
  readonly chatFingerprint?: string;
  readonly errorCode?: string;
  readonly retryable?: boolean;
  readonly durationMs?: number;
  readonly traceId?: string;
  readonly attemptId?: string;
  readonly details?: Record<string, string | number | boolean | null>;
}

/**
 * A04：按注册表组装具名诊断输入，自动补默认 level / source，并**剔除契约之外的 details 键**
 * 与未匹配指纹形态的 `*Ref`。返回 null 表示 code 不在注册表内（宁可不记，也不用自由字符串）。
 *
 * 注意：这只是「构造期」过滤；真正的安全边界始终是 `sanitizeDiagnostic`，两者都保留。
 */
export function namedDiagnosticInput(input: AtlasNamedDiagnosticInput): AtlasDiagnosticInput | null {
  const spec = namedDiagnosticSpec(input.code);
  if (!spec) return null;
  const entry: AtlasDiagnosticInput = {
    level: spec.level,
    source: spec.source,
    code: spec.code,
    operation: input.operation,
    phase: input.phase,
    outcome: input.outcome,
    ...(input.chatRef ? { chatRef: input.chatRef } : {}),
    ...(input.chatFingerprint ? { chatFingerprint: input.chatFingerprint } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(typeof input.retryable === "boolean" ? { retryable: input.retryable } : {}),
    ...(typeof input.durationMs === "number" ? { durationMs: input.durationMs } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
  };
  if (!input.details) return entry;
  const allowed = new Set(spec.details);
  const details: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input.details)) {
    if (!allowed.has(key)) continue;
    // 定位类字段只接受指纹形态；`chatFingerprint` 额外镜像到顶层字段（不重复留在 details）。
    if (key === "chatFingerprint") {
      if (isAtlasRefFingerprint(value) && !entry.chatFingerprint) entry.chatFingerprint = value;
      continue;
    }
    if (key.endsWith("Ref")) {
      if (isAtlasRefFingerprint(value)) details[key] = value;
      continue;
    }
    details[key] = value;
  }
  if (Object.keys(details).length > 0) return { ...entry, details };
  return entry;
}

function safeToken(value: unknown, fallback = ""): string {
  return typeof value === "string" && SAFE_ATOM.test(value) && !value.includes("://")
    ? value : fallback;
}

export function sanitizeDiagnostic(raw: unknown, now: () => number = Date.now): AtlasDiagnostic | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const level = LEVELS.has(value.level as string) ? value.level as AtlasDiagnosticLevel : null;
  const source = SOURCES.has(value.source as string) ? value.source as AtlasDiagnosticSource : null;
  const outcome = OUTCOMES.has(value.outcome as string) ? value.outcome as AtlasDiagnosticOutcome : null;
  if (!level || !source || !outcome) return null;
  const code = typeof value.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code)
    ? value.code : "UNEXPECTED_ERROR";
  const at = typeof value.at === "string" && Number.isFinite(Date.parse(value.at))
    ? new Date(value.at).toISOString() : new Date(now()).toISOString();
  const entry: AtlasDiagnostic = {
    schemaVersion: 1,
    id: "diag-" + now().toString(36) + "-" + (++nextId).toString(36),
    at, level, source, code,
    operation: safeToken(value.operation, "unknown"),
    phase: safeToken(value.phase, "unknown"),
    outcome,
  };
  const traceId = safeToken(value.traceId);
  if (/^turn-[a-z0-9]+-[0-9]+$/.test(traceId)) entry.traceId = traceId;
  const attemptId = safeToken(value.attemptId);
  if (/^attempt-[0-9]+$/.test(attemptId)) entry.attemptId = attemptId;
  const chatRef = safeToken(value.chatRef);
  if (/^chat-[a-z0-9]{4,16}$/.test(chatRef)) entry.chatRef = chatRef;
  // A04：顶层聊天指纹。只接受指纹形态；裸 chatId（原始字符串）到不了这里，也不会被回退成 chatRef。
  const chatFingerprint = safeToken(value.chatFingerprint);
  if (isAtlasRefFingerprint(chatFingerprint)) entry.chatFingerprint = chatFingerprint;
  if (typeof value.errorCode === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.errorCode)) {
    entry.errorCode = value.errorCode;
  }
  if (typeof value.httpStatus === "number" && Number.isInteger(value.httpStatus) &&
      value.httpStatus >= 100 && value.httpStatus <= 599) entry.httpStatus = value.httpStatus;
  if (typeof value.retryable === "boolean") entry.retryable = value.retryable;
  if (typeof value.durationMs === "number" && Number.isFinite(value.durationMs) &&
      value.durationMs >= 0 && value.durationMs <= 86_400_000) entry.durationMs = Math.round(value.durationMs);
  if (typeof value.count === "number" && Number.isInteger(value.count) && value.count > 1) {
    entry.count = Math.min(value.count, 1_000_000);
  }
  if (value.details && typeof value.details === "object" && !Array.isArray(value.details)) {
    const details: Record<string, string | number | boolean | null> = {};
    for (const [key, detail] of Object.entries(value.details as Record<string, unknown>)) {
      if (!DETAIL_KEYS.has(key)) continue;
      if (typeof detail === "string") {
        const token = safeToken(detail);
        if (key === "route" && SAFE_ROUTES.has(token)) details[key] = token;
        else if (key === "mode" && SAFE_MODES.has(token)) details[key] = token;
        else if (key === "capability" && SAFE_CAPABILITIES.has(token)) details[key] = token;
        else if (key === "reasonCode" && /^[A-Z][A-Z0-9_]{0,63}$/.test(token)) details[key] = token;
        // 根路径 `$` 也是真实的 JSONPath：JSON 无法解析或顶层不是对象时解析器只返回 `$`。
        // 0.9.54 A9/A11：其余路径必须以 `$.` 或 `$[` 开头，
        // 否则任意「字母数字下划线点」字符串（例如一段裸密钥）都能冒充 schemaPath 混进诊断。
        // 旧字符集还缺 `[`、`]`，导致真正的数组下标路径（$.relationUpdates[0].value）
        // 反而被丢弃——「记录真实拒绝原因位置」形同虚设。此处两个方向一起收口：
        // 允许下标，但要求根记号，并继续拒绝引号 / 空格 / 中文 / 冒号。
        else if (key === "schemaPath" && (token === "$" || /^\$(?:\.[A-Za-z0-9_]+|\[\d+\])+(?:\.[A-Za-z0-9_]+|\[\d+\])*$/.test(token))) details[key] = token;
        else if (key === "protocolVersion" && /^v?[0-9.]{1,16}$/.test(token)) details[key] = token;
        else if (key === "event" && /^[A-Z][A-Z0-9_]{0,63}$/.test(token)) details[key] = token;
        else if (key === "stage" && /^[a-z][a-z0-9_-]{0,63}$/.test(token)) details[key] = token;
        // A04：定位指纹键只接受 atlasRefFingerprint 的形态。原始 chatId / 分支名 /
        // turnKey / npc-* 原始 ID / 长段正文都不是 `ref-<8..16 位小写十六进制>`，
        // 在这里被丢弃 —— 日志能按指纹定位，却看不到任何原始标识或文本。
        else if (key.endsWith("Ref")) {
          if (isAtlasRefFingerprint(token)) details[key] = token;
        }
        // A04：集合名走精确白名单（simulationUndo.collection 的取值域）。
        else if (key === "collection") {
          if (SAFE_COLLECTIONS.has(token)) details[key] = token;
        }
      } else if (isAtlasRefDetailKey(key)) {
        // A04：`*Ref` 是字符串型定位字段，boolean / null / 数字都不得冒充（原始 ID 更不行）。
        continue;
      } else if (SAFE_COUNT_KEYS.has(key)) {
        // A04：计数字段只接受有限非负整数，布尔 / null / 小数 / 负数一律丢弃，并钳到上界。
        if (typeof detail === "number" && Number.isInteger(detail) && detail >= 0) {
          details[key] = Math.min(detail, 1_000_000);
        }
      } else if (typeof detail === "boolean" || detail === null) {
        details[key] = detail;
      } else if (typeof detail === "number" && Number.isFinite(detail)) {
        details[key] = detail;
      }
    }
    if (Object.keys(details).length > 0) entry.details = details;
  }
  if (new TextEncoder().encode(JSON.stringify(entry)).length > 2048) {
    delete entry.details;
    entry.truncated = true;
  }
  return entry;
}

export function createAtlasDiagnosticsSink(options: {
  now?: () => number;
  capacity?: number;
  persist?: StoragePort | null;
  storageKey?: string;
  archive?: StoragePort | null;
  archiveEnabled?: boolean;
  archiveKey?: string;
  archiveTtlMs?: number;
} = {}) {
  const now = options.now ?? Date.now;
  const capacity = Math.max(100, Math.min(2000, Math.trunc(options.capacity ?? 500)));
  const storageKey = options.storageKey ?? "atlas:safe-diagnostics:v1";
  const archiveKey = options.archiveKey ?? "atlas:safe-diagnostics-archive:v1";
  const archiveTtlMs = Math.max(60_000, Math.min(30 * 86_400_000, options.archiveTtlMs ?? 7 * 86_400_000));
  let archiveEnabled = options.archiveEnabled === true;
  let archiveUnavailable = false;
  const entries: AtlasDiagnostic[] = [];
  const listeners = new Set<() => void>();
  let storageUnavailable = false;

  function notify(): void {
    for (const listener of listeners) {
      try { listener(); } catch { /* observers never affect game flow */ }
    }
  }

  function persistArchive(): void {
    if (!archiveEnabled || !options.archive || archiveUnavailable) return;
    try {
      const saved = entries.filter((entry) =>
        (entry.level === "warn" || entry.level === "error") &&
        Date.parse(entry.at) >= now() - archiveTtlMs).slice(-200);
      options.archive.setItem(archiveKey, JSON.stringify({ savedAt: now(), entries: saved }));
    } catch {
      archiveUnavailable = true;
      const unavailable = sanitizeDiagnostic({
        level: "warn", source: "storage", code: "DIAGNOSTICS_STORAGE_UNAVAILABLE",
        operation: "diagnostics", phase: "archive", outcome: "failed",
      }, now);
      if (unavailable) {
        if (entries.length >= capacity) entries.shift();
        entries.push(unavailable);
      }
      notify();
    }
  }

  function persist(): void {
    if (!options.persist || storageUnavailable) {
      persistArchive();
      return;
    }
    try {
      const saved = entries.filter((entry) => entry.level === "warn" || entry.level === "error").slice(-100);
      options.persist.setItem(storageKey, JSON.stringify(saved));
    } catch {
      storageUnavailable = true;
      const unavailable = sanitizeDiagnostic({
        level: "warn", source: "storage", code: "DIAGNOSTICS_STORAGE_UNAVAILABLE",
        operation: "diagnostics", phase: "persist", outcome: "failed",
      }, now);
      if (unavailable) {
        if (entries.length >= capacity) {
          const lowIndex = entries.findIndex((item) => item.level === "debug" || item.level === "info");
          entries.splice(lowIndex >= 0 ? lowIndex : 0, 1);
        }
        entries.push(unavailable);
      }
      notify();
    }
    persistArchive();
  }

  try {
    const saved = options.persist?.getItem(storageKey);
    if (saved) {
      const parsed: unknown = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        for (const raw of parsed.slice(-100)) {
          const entry = sanitizeDiagnostic(raw, now);
          if (entry && (entry.level === "warn" || entry.level === "error")) entries.push(entry);
        }
      }
    }
  } catch { storageUnavailable = true; }

  if (archiveEnabled && options.archive) {
    try {
      const raw = options.archive.getItem(archiveKey);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const stored = parsed as { entries?: unknown };
          if (Array.isArray(stored.entries)) {
            const seen = new Set(entries.map((entry) =>
              [entry.at, entry.code, entry.phase, entry.traceId ?? ""].join("|")));
            for (const value of stored.entries.slice(-200)) {
              const entry = sanitizeDiagnostic(value, now);
              if (!entry || (entry.level !== "warn" && entry.level !== "error") ||
                  Date.parse(entry.at) < now() - archiveTtlMs) continue;
              const key = [entry.at, entry.code, entry.phase, entry.traceId ?? ""].join("|");
              if (seen.has(key)) continue;
              seen.add(key);
              entries.push(entry);
            }
            entries.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
            if (entries.length > capacity) entries.splice(0, entries.length - capacity);
          }
        }
      }
    } catch { archiveUnavailable = true; }
  }

  return {
    emit(raw: AtlasDiagnosticInput): AtlasDiagnostic | null {
      try {
        const entry = sanitizeDiagnostic(raw, now);
        if (!entry) return null;
        const last = entries[entries.length - 1];
        if (last && last.code === entry.code && last.phase === entry.phase &&
            last.traceId === entry.traceId && last.source === entry.source &&
            Date.parse(entry.at) - Date.parse(last.at) < 2000) {
          last.count = (last.count ?? 1) + 1;
          last.at = entry.at;
          persist();
          notify();
          return { ...last };
        }
        if (entries.length >= capacity) {
          const lowIndex = entries.findIndex((item) => item.level === "debug" || item.level === "info");
          entries.splice(lowIndex >= 0 ? lowIndex : 0, 1);
        }
        entries.push(entry);
        persist();
        notify();
        return { ...entry };
      } catch { return null; }
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot(): AtlasDiagnostic[] {
      return entries.map((entry) => ({ ...entry, ...(entry.details ? { details: { ...entry.details } } : {}) }));
    },
    clear(): void {
      entries.length = 0;
      try { options.persist?.removeItem(storageKey); } catch { storageUnavailable = true; }
      try { options.archive?.removeItem(archiveKey); } catch { archiveUnavailable = true; }
      notify();
    },
    getArchiveEnabled(): boolean { return archiveEnabled; },
    setArchiveEnabled(enabled: boolean): void {
      archiveEnabled = enabled === true;
      if (archiveEnabled) persistArchive();
      else {
        try { options.archive?.removeItem(archiveKey); } catch { archiveUnavailable = true; }
      }
      notify();
    },
    exportSafe(chatRef?: string): string {
      return entries.filter((entry) => !chatRef || entry.chatRef === chatRef)
        .map((entry) => JSON.stringify(entry)).join("\n");
    },
  };
}
