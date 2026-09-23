/**
 * Safe, bounded diagnostics shared by the browser shell, UI core and engine.
 * Only explicitly named metadata survives sanitization. Never put prompts,
 * responses, URLs, chat IDs or Error objects into an input field.
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
]);
// 0.9.53 A9/A11：允许 `$` `[` `]`，否则 JSON 路径（$.relationUpdates[0].value）永远过不了
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
let nextId = 0;

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
        // 0.9.53 A9/A11：schemaPath 必须是真正的 JSONPath —— 强制以 `$.` 或 `$[` 开头，
        // 否则任意「字母数字下划线点」字符串（例如一段裸密钥）都能冒充 schemaPath 混进诊断。
        // 旧字符集还缺 `[`、`]`，导致真正的数组下标路径（$.relationUpdates[0].value）
        // 反而被丢弃——「记录真实拒绝原因位置」形同虚设。此处两个方向一起收口：
        // 允许下标，但要求根记号，并继续拒绝引号 / 空格 / 中文 / 冒号。
        else if (key === "schemaPath" && /^\$(?:\.[A-Za-z0-9_]+|\[\d+\])+(?:\.[A-Za-z0-9_]+|\[\d+\])*$/.test(token)) details[key] = token;
        else if (key === "protocolVersion" && /^v?[0-9.]{1,16}$/.test(token)) details[key] = token;
        else if (key === "event" && /^[A-Z][A-Z0-9_]{0,63}$/.test(token)) details[key] = token;
        else if (key === "stage" && /^[a-z][a-z0-9_-]{0,63}$/.test(token)) details[key] = token;
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
