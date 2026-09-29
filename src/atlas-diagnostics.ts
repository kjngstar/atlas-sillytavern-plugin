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
import { ATLAS_RUNTIME_LIMITS } from "./atlas-runtime-limits.ts";
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
  "route", "mode", "sourceMode", "activationMode", "reason", "reasonCode", "schemaPath", "protocolVersion",
  "responseChars", "capability", "event", "build", "coreCommitted",
  "count", "stage", "attempt", "scanned", "cleaned", "kept", "malformed", "rowLine",
  // A04：具名诊断的安全定位字段。`*Ref` 只接受 atlasRefFingerprint 的形态
  // （原始 chatId / 分支名 / turnKey 一律丢弃）；collection 与计数字段见下方校验。
  // 聊天指纹只走顶层 `chatFingerprint`（注册表把它列为可传键，组装时镜像到顶层），
  // 不在 details 里另留一份，避免同一条日志出现两个含义相同的键。
  "branchRef", "turnRef", "worldRef", "actorRef", "locationRef", "signalRef", "taskRef",
  "collection",
  "droppedCount", "limitCount", "keptCount", "truncatedCount", "scannedCount",
  "candidateCount", "selectedCount", "outputChars", "chatMatch",
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
const SAFE_MODES = new Set(["main", "profile", "custom", "openai", "claude", "gemini", "v1", "v2", "turn", "geo", "bootstrap"]);
const SAFE_LORE_ACTIVATION_MODES = new Set(["host-activated", "context-fallback", "disabled"]);
const SAFE_LORE_REASONS = new Set(["settings_disabled", "host_api_unavailable", "no_matching_turn_event", "selector_undefined"]);
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
        else if ((key === "mode" || key === "sourceMode") && SAFE_MODES.has(token)) details[key] = token;
        else if (key === "activationMode" && SAFE_LORE_ACTIVATION_MODES.has(token)) details[key] = token;
        else if (key === "reason" && SAFE_LORE_REASONS.has(token)) details[key] = token;
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
      } else if (key === "rowLine") {
        if (typeof detail === "number" && Number.isInteger(detail) && detail >= 0 && detail <= 100_000) {
          details[key] = detail;
        }
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
            const archiveIdentity = (entry: AtlasDiagnostic): string =>
              JSON.stringify([entry.at, entry.code, entry.phase, entry.traceId ?? "", entry.errorCode, entry.details]);
            const seen = new Set(entries.map(archiveIdentity));
            for (const value of stored.entries.slice(-200)) {
              const entry = sanitizeDiagnostic(value, now);
              if (!entry || (entry.level !== "warn" && entry.level !== "error") ||
                  Date.parse(entry.at) < now() - archiveTtlMs) continue;
              const key = archiveIdentity(entry);
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
            last.errorCode === entry.errorCode && JSON.stringify(last.details) === JSON.stringify(entry.details) &&
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

// ---------------------------------------------------------------------------
// G10（§16.8）：世界数据链路的统一诊断对象
// ---------------------------------------------------------------------------
//
// §16.8 固定形状：
//   {at,level,module,code,chatUid,branchId,turnId,attemptId,batchId,opId?,groupId?,line?,path?,message,details,coreSaved}
//
// 安全口径与本文件既有部分保持一致（不是另造一套）：
// - `message` 给人读，但先过 `redactWorldSecrets`：`sk-…` / `Bearer …` / `api_key=…` /
//   32 位以上十六进制串一律抹掉 —— **复制 Authorization / API key 到日志为零**；
// - `chatUid` / `branchId` / `turnId` / `attemptId` / `batchId` 走 A04 的脱敏指纹
//   （`atlasRefFingerprint`，确定性 `ref-<16 位小写十六进制>`）：日志能按指纹定位同一个聊天/分支/回合，
//   却看不到原始标识；输入本身已是指纹时原样通过；
// - `details` 只保留有限深度/长度的标量摘要：拒绝值、依赖 id、哈希摘要、耗时；
//   正文型键（prompt/response/content/chatName…）只留长度，不进原文；
// - `coreSaved` **只**取自显式输入：HTTP 200 或“看起来成功”都不推导成已保存（§7.3 / §16.8）。

/** §16.8：世界数据链路统一诊断对象的输入。 */
export interface AtlasWorldIssueInput {
  /** 毫秒时间戳；缺省用当前时间（可注入 `now` 以便测试）。 */
  at?: number;
  level?: AtlasDiagnosticLevel;
  module: string;
  code: string;
  chatUid?: string;
  branchId?: string;
  turnId?: string;
  attemptId?: string;
  batchId?: string;
  opId?: string;
  groupId?: string;
  line?: number;
  path?: string;
  message: string;
  details?: Record<string, unknown>;
  coreSaved?: boolean;
}

const WORLD_TEXT_KEYS = new Set([
  "prompt", "response", "content", "body", "text", "raw", "rawtext", "storytext",
  "chatname", "charactername", "excerpt", "quote", "completion", "message", "assistanttext", "usertext",
]);
const WORLD_SECRET_KEYS = new Set([
  "authorization", "apikey", "api_key", "access_token", "accesstoken", "auth_token", "authtoken",
  "password", "passwd", "secret", "token", "bearertoken", "bearer_token", "cookie", "setcookie",
  "x-api-key", "xapikey",
]);
const WORLD_MESSAGE_MAX_CHARS = 500;
const WORLD_DETAIL_STRING_MAX_CHARS = 200;
const WORLD_DETAIL_MAX_BYTES = 2048;
const WORLD_DETAIL_DEPTH = 2;

/**
 * G10：抹掉密钥形态的片段（Authorization / API key 复制到日志为零）。
 * 32 位以上的十六进制串同样抹掉：完整 64 位摘要是高熵串，日志只保留前缀 + 长度作为摘要。
 */
export function redactWorldSecrets(value: string): string {
  let out = value;
  // 替换标记里**不放** `[` `]`：否则后续「api_key=…」规则会把标记的方括号当成值的一部分，
  // 留下半个密钥形态的残片。
  out = out.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "sk-***");
  out = out.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***");
  out = out.replace(
    /((?:x-)?api[_-]?key|apikey|access[_-]?token|auth[_-]?token|authorization|password|passwd|secret|token)(\s*[:=]\s*)["']?[^\s"',;}\]]{4,}/gi,
    "$1$2***",
  );
  out = out.replace(/\b[a-fA-F0-9]{32,}\b/g, (match) => `sha256:${match.slice(0, 12)}…(${match.length})`);
  return out;
}

function worldRefFingerprint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = safeToken(value);
  if (!token) return null;
  return isAtlasRefFingerprint(token) ? token : atlasRefFingerprint(token);
}

function worldToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = safeToken(value);
  return token.length > 0 ? token : undefined;
}

function worldMessage(value: unknown): string {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  const redacted = redactWorldSecrets(text).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return redacted.length > WORLD_MESSAGE_MAX_CHARS ? `${redacted.slice(0, WORLD_MESSAGE_MAX_CHARS)}…` : redacted;
}

function worldPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = safeToken(value);
  if (token === "$") return token;
  return /^\$(?:\.[A-Za-z0-9_]+|\[\d+\])+$/.test(token) ? token : undefined;
}

function sanitizeWorldDetails(details: Record<string, unknown> | undefined, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!details || typeof details !== "object" || Array.isArray(details)) return out;
  for (const [key, value] of Object.entries(details)) {
    const lowered = key.toLowerCase();
    // 密钥键直接丢弃；coreSaved 只能来自顶层显式输入，details 不得另造第二份。
    if (WORLD_SECRET_KEYS.has(lowered) || lowered === "coresaved") continue;
    const safeKey = safeToken(key);
    if (!safeKey) continue;
    if (WORLD_TEXT_KEYS.has(lowered)) {
      out[safeKey] = typeof value === "string" ? `[text:${value.length}chars]` : "[text]";
      continue;
    }
    out[safeKey] = sanitizeWorldDetailValue(value, depth);
  }
  return out;
}

function sanitizeWorldDetailValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const redacted = redactWorldSecrets(value);
    return redacted.length > WORLD_DETAIL_STRING_MAX_CHARS
      ? `${redacted.slice(0, WORLD_DETAIL_STRING_MAX_CHARS)}…(${redacted.length})`
      : redacted;
  }
  if (Array.isArray(value)) {
    if (depth >= WORLD_DETAIL_DEPTH) return `[array:${value.length}]`;
    return value.slice(0, 16).map((item) => sanitizeWorldDetailValue(item, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= WORLD_DETAIL_DEPTH) return "[object]";
    const nested = sanitizeWorldDetails(value as Record<string, unknown>, depth + 1);
    return Object.keys(nested).length > 0 ? nested : "[object]";
  }
  return null;
}

/**
 * G10 normalizeWorldIssue：所有来源统一的 §16.8 诊断对象。
 * 完成定义（§17G）：详细报错能在日志找到 —— 保留 group/op/path/line 与 details。
 * `module` 为空/非法时**不静默**：details 里明确给出 `DIAGNOSTIC_MODULE_REQUIRED`。
 */
export function normalizeWorldIssue(
  input: AtlasWorldIssueInput,
  now: () => number = Date.now,
): Record<string, unknown> {
  const rawAt = typeof input?.at === "number" && Number.isFinite(input.at) ? input.at : now();
  const level: AtlasDiagnosticLevel = LEVELS.has(input?.level as string) ? (input.level as AtlasDiagnosticLevel) : "error";
  const moduleToken = worldToken(input?.module);
  const codeToken = typeof input?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(input.code) ? input.code : "UNEXPECTED_ERROR";

  const details = sanitizeWorldDetails(input?.details);
  // §16.8：诊断必须能按聊天/分支/回合/尝试/批次定位；原始标识只以脱敏指纹进入日志。
  const chatUid = worldRefFingerprint(input?.chatUid);
  const branchId = worldRefFingerprint(input?.branchId);
  const turnId = worldRefFingerprint(input?.turnId);
  const attemptId = worldRefFingerprint(input?.attemptId);
  const batchId = worldRefFingerprint(input?.batchId);
  const opId = worldToken(input?.opId);
  const groupId = worldToken(input?.groupId);
  const path = worldPath(input?.path);
  const line = typeof input?.line === "number" && Number.isInteger(input.line) && input.line >= 0 && input.line <= 100_000
    ? input.line
    : undefined;

  if (!moduleToken) {
    details.diagnosticCode = "DIAGNOSTIC_MODULE_REQUIRED";
    details.moduleRequired = true;
  }
  const detailBudget = new TextEncoder().encode(JSON.stringify(details)).length;
  if (detailBudget > WORLD_DETAIL_MAX_BYTES) {
    for (const key of Object.keys(details)) {
      if (key === "diagnosticCode" || key === "moduleRequired") continue;
      delete details[key];
      if (new TextEncoder().encode(JSON.stringify(details)).length <= WORLD_DETAIL_MAX_BYTES) break;
    }
    details.detailsTruncated = true;
    details.droppedDetailBytes = detailBudget;
  }

  const issue: Record<string, unknown> = {
    at: new Date(rawAt).toISOString(),
    level,
    module: moduleToken ?? "",
    code: codeToken,
    chatUid,
    branchId,
    turnId,
    attemptId,
    batchId,
  };
  if (opId !== undefined) issue.opId = opId;
  if (groupId !== undefined) issue.groupId = groupId;
  if (line !== undefined) issue.line = line;
  if (path !== undefined) issue.path = path;
  issue.message = worldMessage(input?.message ?? input?.code ?? "");
  issue.details = details;
  // §7.3 / §16.8：只有显式 coreSaved=true 才是已保存；HTTP 200 不推导成功。
  issue.coreSaved = input?.coreSaved === true;
  return issue;
}

/** G10：统一 `Issue[]` → §16.8 诊断（保留 group/op/path/line/dependencyId 定位）。 */
export function normalizeWorldIssueList(
  issues: Array<{
    code: string;
    path?: string;
    message: string;
    severity?: string;
    line?: number;
    opId?: string;
    groupId?: string;
    dependencyId?: string;
    retryable?: boolean;
  }>,
  base: {
    module: string;
    chatUid?: string;
    branchId?: string;
    turnId?: string;
    attemptId?: string;
    batchId?: string;
    coreSaved?: boolean;
  },
  now: () => number = Date.now,
): Array<Record<string, unknown>> {
  const list = Array.isArray(issues) ? issues : [];
  const at = now();
  return list.map((issue) => {
    const severity = typeof issue?.severity === "string" ? issue.severity : "error";
    const level: AtlasDiagnosticLevel = severity === "warning" ? "warn" : LEVELS.has(severity) ? (severity as AtlasDiagnosticLevel) : "error";
    const details: Record<string, unknown> = {};
    if (issue?.severity !== undefined) details.severity = severity;
    if (issue?.retryable !== undefined) details.retryable = issue.retryable === true;
    if (issue?.dependencyId !== undefined) details.dependencyId = issue.dependencyId;
    return normalizeWorldIssue(
      {
        at,
        level,
        module: base?.module ?? "",
        code: issue?.code ?? "UNEXPECTED_ERROR",
        chatUid: base?.chatUid,
        branchId: base?.branchId,
        turnId: base?.turnId,
        attemptId: base?.attemptId,
        batchId: base?.batchId,
        opId: issue?.opId,
        groupId: issue?.groupId,
        line: issue?.line,
        path: issue?.path,
        message: issue?.message ?? "",
        details,
        coreSaved: base?.coreSaved,
      },
      () => at,
    );
  });
}

/**
 * G10 diagnosticsExportPage：§16.8 的分页 ≠ 导出截断。
 * - `items` 是当前页；`total` 是全部匹配记录数；翻到最后一页才算这一轮导出走完；
 * - 留存范围之外被丢弃的记录由调用方以摘要条目表达（`details.droppedCount` + `details.droppedReason`），
 *   导出如实给出 `droppedCount` 与原因：**有丢弃就不算 exportComplete**，不假装完整。
 */
export function diagnosticsExportPage(
  entries: Array<Record<string, unknown>>,
  cursor?: string | null,
  pageSize?: number,
): {
  items: Array<Record<string, unknown>>;
  nextCursor?: string;
  total: number;
  droppedCount: number;
  exportComplete: boolean;
  droppedReason?: string;
} {
  const all = Array.isArray(entries) ? entries : [];
  const requested = Number(pageSize);
  const size = Number.isFinite(requested) && requested >= 1
    ? Math.min(500, Math.trunc(requested))
    : ATLAS_RUNTIME_LIMITS.diagnosticPageSize;
  const requestedOffset = Number(cursor ?? 0);
  const offset = Number.isFinite(requestedOffset) && requestedOffset > 0 ? Math.trunc(requestedOffset) : 0;
  const items = all.slice(offset, offset + size);
  const nextOffset = offset + items.length;

  let droppedCount = 0;
  let droppedReason: string | undefined;
  for (const entry of all) {
    const details = entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry.details as Record<string, unknown> | undefined)
      : undefined;
    const reported = Number(details?.droppedCount ?? (entry as Record<string, unknown> | undefined)?.droppedCount);
    if (!Number.isFinite(reported) || reported <= 0) continue;
    droppedCount += Math.trunc(reported);
    if (!droppedReason) {
      const reason = details?.droppedReason ?? details?.reason;
      droppedReason = typeof reason === "string" && reason.length > 0 ? redactWorldSecrets(reason).slice(0, 120) : "retention";
    }
  }

  const page: {
    items: Array<Record<string, unknown>>;
    nextCursor?: string;
    total: number;
    droppedCount: number;
    exportComplete: boolean;
    droppedReason?: string;
  } = {
    items,
    total: all.length,
    droppedCount,
    exportComplete: nextOffset >= all.length && droppedCount === 0,
  };
  if (nextOffset < all.length) page.nextCursor = String(nextOffset);
  if (droppedCount > 0) page.droppedReason = droppedReason ?? "retention";
  return page;
}
