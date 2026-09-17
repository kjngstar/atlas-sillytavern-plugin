// Pure utility functions extracted from app/WorldStudio.tsx so that the
// connection lifecycle and model fetching can be exercised by node:test
// without a DOM. Everything here must remain side-effect free and depend
// only on its inputs.

export const AI_SETTINGS_STORAGE_KEY = "atlasia.ai-settings.v1";

export const GRID_STEP = 2.5;

export type AIConnection = {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  model: string;
  /**
   * Optional soft-disable flag. Missing in legacy v1 payloads; treated as
   * `true` whenever undefined so older saved settings keep working.
   */
  active?: boolean;
};

export type AIBindings = {
  search: string;
  analysis: string;
  story: string;
  /**
   * W0：世界运转 Agent 的默认连接（可选，向后兼容）。
   * 空字符串表示「未绑定」——UI 必须显示未绑定，绝不静默挑一个模型顶上。
   */
  worldRuntime?: string;
  /**
   * W0-05b：当前世界 Agent 创建 / 刷新的默认 API 预设（可选，向后兼容）。
   * 与 `worldRuntime` 一样，缺失 / 失效一律置空（未绑定），不回退到第一个可用连接。
   */
  worldAgent?: string;
};

/**
 * R5-06：生成预设（每个功能独立一份，互不覆盖）。
 * 修改某一个功能的温度 / 输出上限，绝不影响其它功能或连接档案。
 */
export interface GenerationPreset {
  temperature?: number;
  maxTokens?: number;
}

export type GenerationPresets = Partial<Record<keyof AIBindings, GenerationPreset>>;

export type StoredAISettings = {
  version: 1;
  connections: AIConnection[];
  bindings: AIBindings;
  /** R5-06：每功能生成预设（可选；旧设置无此字段照常解析） */
  generationPresets?: GenerationPresets;
};

/** 读取某功能的生成预设（未配置 → undefined，由网关用默认参数）。 */
export function generationPresetFor(
  presets: GenerationPresets | undefined,
  feature: keyof AIBindings,
): GenerationPreset | undefined {
  return presets?.[feature];
}

/** 更新某功能的生成预设：纯函数、按功能独立（其余功能的对象引用不变）。 */
export function updateGenerationPreset(
  presets: GenerationPresets | undefined,
  feature: keyof AIBindings,
  patch: GenerationPreset,
): GenerationPresets {
  const base = presets ?? {};
  // patch 两个键都缺席 = 清除该功能的预设（恢复网关默认参数）
  if (patch.temperature === undefined && patch.maxTokens === undefined) {
    const cleared = { ...base };
    delete cleared[feature];
    return cleared;
  }
  const merged: GenerationPreset = { ...base[feature], ...patch };
  // 全 undefined 视为「恢复默认」，删除该功能的条目
  if (merged.temperature === undefined && merged.maxTokens === undefined) {
    const next = { ...base };
    delete next[feature];
    return next;
  }
  return { ...base, [feature]: merged };
}

export type ConnectionDraft = {
  name: string;
  endpoint: string;
  apiKey: string;
  model: string;
};

export type MapClickBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type MapClickPoint = { x: number; y: number };

/**
 * Clamp a raw map percentage to the 0-100 range and snap it to the nearest
 *grid step. Mirrors the inline math previously in WorldStudio.placeMapPoint.
 */
export function clampMapCoordinate(value: number, gridStep: number = GRID_STEP): number {
  const clamped = Math.min(100, Math.max(0, value));
  return Math.round(clamped / gridStep) * gridStep;
}

/**
 * Convert a browser click event into bounded, grid-aligned map percentages.
 */
export function snapMapClickToGrid(
  clientX: number,
  clientY: number,
  bounds: MapClickBounds,
  gridStep: number = GRID_STEP,
): MapClickPoint {
  const rawX = ((clientX - bounds.left) / bounds.width) * 100;
  const rawY = ((clientY - bounds.top) / bounds.height) * 100;
  return {
    x: clampMapCoordinate(rawX, gridStep),
    y: clampMapCoordinate(rawY, gridStep),
  };
}
/**
 * Append `/models` to a base URL while preserving trailing slashes and
 * avoiding duplicate `/models` segments. Returns null when the endpoint is
 * not a valid absolute URL.
 */
export function buildModelsUrl(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  const cleanPath = url.pathname.replace(/\/+$/, "");
  url.pathname = cleanPath.endsWith("/models") ? cleanPath : `${cleanPath}/models`;
  return url.toString();
}

/**
 * Normalize a /models response payload into a deduplicated list of model ids.
 * Accepts OpenAI-style `{ data: [...] }`, Ollama-style `{ models: [...] }`,
 * plain arrays of strings, and entries that surface the id under `id`,
 * `name`, or `model`. Empty strings and non-object entries are skipped.
 */
export function parseModelList(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const envelope = payload as { data?: unknown; models?: unknown };
  let entries: unknown;
  if (Array.isArray(payload)) entries = payload;
  else if (Array.isArray(envelope.data)) entries = envelope.data;
  else if (Array.isArray(envelope.models)) entries = envelope.models;
  else return [];
  const seen = new Set<string>();
  for (const entry of entries as unknown[]) {
    if (typeof entry === "string") {
      if (entry.length > 0) seen.add(entry);
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { id?: unknown; name?: unknown; model?: unknown };
    const value = [candidate.id, candidate.name, candidate.model].find(
      (candidate) => typeof candidate === "string" && candidate.length > 0,
    );
    if (typeof value === "string") seen.add(value);
  }
  return Array.from(seen);
}

/**
 * Validate the minimum fields required to save an AI connection.
 * Returns null when the draft is acceptable, otherwise a localized hint.
 */
export function validateConnectionDraft(draft: ConnectionDraft): string | null {
  if (!draft.name.trim()) return "请填写连接名称。";
  if (!draft.endpoint.trim()) return "请填写 API 地址。";
  if (!draft.model.trim()) return "请填写模型名称。";
  return null;
}
/**
 * Apply a connection draft to a list, either appending a new connection with
 * a generated id or replacing an existing one in place while preserving its
 * id. The original list is never mutated.
 */
export function applyConnectionDraft(
  connections: AIConnection[],
  draft: ConnectionDraft,
  editingId: string | null,
  now: number = Date.now(),
): AIConnection[] {
  const values = {
    name: draft.name.trim(),
    endpoint: draft.endpoint.trim(),
    apiKey: draft.apiKey,
    model: draft.model.trim(),
  };
  if (editingId) {
    return connections.map((item) => (item.id === editingId ? { ...item, ...values } : item));
  }
  return [...connections, { id: `connection-${now}`, ...values }];
}

/**
 * Remove a connection by id and re-point any bindings that referenced it
 * back at the first remaining *active* connection (or the first remaining
 * entry when none is active, or empty string if nothing is left). Bindings
 * pointing elsewhere are kept intact.
 */
export function removeConnectionWithFallback(
  connections: AIConnection[],
  bindings: AIBindings,
  idToRemove: string,
): { connections: AIConnection[]; bindings: AIBindings } {
  const remaining = connections.filter((item) => item.id !== idToRemove);
  const activeFallback = remaining.find(isConnectionActive)?.id;
  const fallback = activeFallback ?? remaining[0]?.id ?? "";
  return {
    connections: remaining,
    bindings: {
      search: bindings.search === idToRemove ? fallback : bindings.search,
      analysis: bindings.analysis === idToRemove ? fallback : bindings.analysis,
      story: bindings.story === idToRemove ? fallback : bindings.story,
      // W0 / W0-05b：worldRuntime 与 worldAgent 与 search/analysis/story 不同。
      // 指向已删除连接时一律置空（显示「未绑定」），**绝不**静默回退到第一个可用连接——
      // 那会让世界运转悄悄用上作者从未选择过的模型。
      worldRuntime: bindings.worldRuntime === idToRemove ? "" : (bindings.worldRuntime ?? ""),
      worldAgent: bindings.worldAgent === idToRemove ? "" : (bindings.worldAgent ?? ""),
    },
  };
}

/**
 * Restore AI settings from an unknown localStorage payload. Returns the
 * sanitized connections plus bindings, or null when nothing usable was found
 * at all. Bindings that point at a connection that no longer exists fall
 * back to the first remaining connection id.
 */
export function restoreAISettings(
  stored: unknown,
): { connections: AIConnection[]; bindings: AIBindings; generationPresets: GenerationPresets } | null {
  if (!stored || typeof stored !== "object") return null;
  const parsed = stored as Partial<StoredAISettings>;
  if (!Array.isArray(parsed.connections)) return null;

  const restoredConnections: AIConnection[] = [];
  for (const raw of parsed.connections) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Partial<AIConnection>;
    if (typeof item.id !== "string" || item.id.length === 0) continue;
    if (typeof item.name !== "string" || item.name.length === 0) continue;
    restoredConnections.push({
      id: item.id,
      name: item.name,
      endpoint: typeof item.endpoint === "string" ? item.endpoint : "",
      model: typeof item.model === "string" ? item.model : "",
      apiKey: typeof item.apiKey === "string" ? item.apiKey : "",
      active: typeof item.active === "boolean" ? item.active : true,
    });
  }

  const fallback = restoredConnections[0]?.id ?? "";
  const availableIds = new Set(restoredConnections.map((item) => item.id));
  const storedBindings = parsed.bindings && typeof parsed.bindings === "object"
    ? (parsed.bindings as Partial<AIBindings>)
    : null;
  const pick = (key: keyof AIBindings): string => {
    const value = storedBindings?.[key];
    return typeof value === "string" && availableIds.has(value) ? value : fallback;
  };
  // W0：worldRuntime 是新增绑定，旧设置里没有它。缺失 / 失效时一律置空（未绑定），
  // 绝不静默回退到「第一个可用连接」——那会让世界运转悄悄用上作者没选过的模型。
  const pickOptional = (key: keyof AIBindings): string => {
    const value = storedBindings?.[key];
    return typeof value === "string" && availableIds.has(value) ? value : "";
  };

  // R5-06：生成预设按功能独立恢复（非法值 / 非对象按缺失处理，绝不部分污染）
  const rawPresets = parsed.generationPresets;
  const generationPresets: GenerationPresets = {};
  if (rawPresets && typeof rawPresets === "object") {
    for (const feature of ["search", "analysis", "story", "worldRuntime", "worldAgent"] as const) {
      const raw = (rawPresets as Record<string, unknown>)[feature];
      if (!raw || typeof raw !== "object") continue;
      const item = raw as { temperature?: unknown; maxTokens?: unknown };
      const preset: GenerationPreset = {};
      if (typeof item.temperature === "number" && Number.isFinite(item.temperature) && item.temperature >= 0 && item.temperature <= 2) {
        preset.temperature = item.temperature;
      }
      if (typeof item.maxTokens === "number" && Number.isFinite(item.maxTokens) && item.maxTokens > 0) {
        preset.maxTokens = Math.round(item.maxTokens);
      }
      if (preset.temperature !== undefined || preset.maxTokens !== undefined) {
        generationPresets[feature] = preset;
      }
    }
  }

  return {
    connections: restoredConnections,
    bindings: {
      search: pick("search"),
      analysis: pick("analysis"),
      story: pick("story"),
      worldRuntime: pickOptional("worldRuntime"),
      worldAgent: pickOptional("worldAgent"),
    },
    generationPresets,
  };
}
/**
 * Parse a raw localStorage payload and return restored settings, or null when
 * nothing usable was found. This wraps JSON.parse + restoreAISettings so that
 * malformed JSON does not throw and the caller can fall back to the default
 * connections. It is the function the component uses for the first-time-init
 * path (no stored value), the legitimate-restoration path, and the
 * corrupt-data degraded path.
 */
export function parseStoredAISettings(
  raw: string | null | undefined,
): { connections: AIConnection[]; bindings: AIBindings; generationPresets: GenerationPresets } | null {
  if (raw === null || raw === undefined || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return restoreAISettings(parsed);
}

/**
 * Apply a connection draft to a list while returning the bindings alongside
 * the updated connections. Bindings are passed through unchanged so editing
 * a connection can never silently break the search/analysis/story feature
 * bindings that referenced it.
 */
export function applyConnectionEdit(
  connections: AIConnection[],
  bindings: AIBindings,
  draft: ConnectionDraft,
  editingId: string | null,
  now: number = Date.now(),
): { connections: AIConnection[]; bindings: AIBindings } {
  return {
    connections: applyConnectionDraft(connections, draft, editingId, now),
    bindings: { ...bindings },
  };
}
/**
 * Current export schema. Legacy v1 settings files keep version: 1 and have
 * no `format` or `exportedAt`; the importer accepts both shapes.
 */
export const AI_SETTINGS_EXPORT_VERSION = 2;
export const AI_SETTINGS_EXPORT_FORMAT = "atlasia.ai-connections";

export type ExportedAISettings = {
  version: 1 | 2;
  format?: typeof AI_SETTINGS_EXPORT_FORMAT;
  exportedAt?: string;
  connections: AIConnection[];
  bindings?: Partial<AIBindings>;
};

/**
 * Outcome of merging an imported payload into the live connection list.
 * The caller surfaces addedCount / renamedCount so the user knows exactly
 * what happened without exposing the id mapping. Per-entry skip counts are
 * computed by the parser (parseImportedSettings) before this stage runs.
 */
export type MergeImportResult = {
  connections: AIConnection[];
  bindings: AIBindings;
  addedCount: number;
  renamedCount: number;
};

/**
 * Case-insensitive substring search across name, endpoint, and model. The
 * original array is never mutated; order is preserved and an empty query
 * returns a shallow copy of every connection.
 */
export function searchConnections(
  connections: AIConnection[],
  query: string,
): AIConnection[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return connections.slice();
  return connections.filter((connection) => {
    const haystacks = [connection.name, connection.endpoint, connection.model];
    return haystacks.some((field) => field.toLowerCase().includes(needle));
  });
}

/**
 * Duplicate a connection under a fresh id. The new name appends " 副本";
 * when that name is already taken, " 副本 2", " 副本 3", ... is used. The
 * source id is preserved so existing bindings keep working. Returns the
 * original array when the source id is not found.
 */
export function duplicateConnection(
  connections: AIConnection[],
  sourceId: string,
  now: number = Date.now(),
): AIConnection[] {
  const source = connections.find((connection) => connection.id === sourceId);
  if (!source) return connections;
  const usedNames = new Set(connections.map((connection) => connection.name));
  const usedIds = new Set(connections.map((connection) => connection.id));
  let candidate = `${source.name} 副本`;
  let counter = 2;
  while (usedNames.has(candidate)) {
    candidate = `${source.name} 副本 ${counter}`;
    counter += 1;
  }
  let newId = `connection-${now}`;
  let suffix = 0;
  while (usedIds.has(newId)) {
    suffix += 1;
    newId = `connection-${now}-${suffix}`;
  }
  return [
    ...connections,
    {
      id: newId,
      name: candidate,
      endpoint: source.endpoint,
      apiKey: source.apiKey,
      model: source.model,
      active: source.active,
    },
  ];
}
/**
 * Whether a connection is currently usable as a binding target. Missing
 * `active` is treated as true so legacy data is never silently disabled.
 */
export function isConnectionActive(connection: AIConnection): boolean {
  return connection.active !== false;
}

/**
 * Toggle a connection's `active` flag by id. Returns the original array
 * unchanged when the id is not found so callers can detect no-ops without
 * comparing references.
 */
export function setConnectionActive(
  connections: AIConnection[],
  id: string,
  active: boolean,
): AIConnection[] {
  let touched = false;
  const next = connections.map((connection) => {
    if (connection.id !== id) return connection;
    touched = true;
    return { ...connection, active };
  });
  return touched ? next : connections;
}

/**
 * Mask an API key for display. Returns a non-secret placeholder when the
 * key is empty so the resulting string is safe to render in any DOM node
 * without leaking credentials via tooltips or attributes.
 */
export function maskApiKey(apiKey: string): string {
  if (!apiKey) return "（无密钥）";
  return "•".repeat(Math.min(apiKey.length, 12));
}
/**
 * Build the export payload. When `includeSecrets` is false every `apiKey`
 * is stripped so a careless share does not leak credentials; the format
 * version and timestamp are always present so the importer can route the
 * payload correctly and the user can recognise stale exports.
 */
export function serializeAISettings(
  connections: AIConnection[],
  bindings: AIBindings,
  options: { includeSecrets?: boolean; now?: Date } = {},
): ExportedAISettings {
  const includeSecrets = options.includeSecrets === true;
  const exportedAt = (options.now ?? new Date()).toISOString();
  const exportedConnections = connections.map((connection) => ({
    ...connection,
    apiKey: includeSecrets ? connection.apiKey : "",
  }));
  return {
    version: AI_SETTINGS_EXPORT_VERSION,
    format: AI_SETTINGS_EXPORT_FORMAT,
    exportedAt,
    connections: exportedConnections,
    bindings,
  };
}
/**
 * Parse a raw JSON string from an import file. Accepts the current v2
 * export shape (version: 2 + matching format) or the legacy v1 settings
 * payload (version: 1, no format envelope). Returns null when the envelope
 * is unrecognisable or fundamentally wrong; partial damage inside the
 * connection list is reported via skippedCount instead of throwing the
 * whole payload away.
 */
export function parseImportedSettings(
  raw: string,
): { connections: AIConnection[]; bindings: AIBindings; skippedCount: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const envelope = parsed as Partial<ExportedAISettings>;
// Envelope shape must be either current v2 (with matching format) or the
  // explicitly recognised v1 historical payload. Anything else is rejected
  // so we never silently ingest random JSON as connection settings.
  if (envelope.version === 2) {
    if (envelope.format !== AI_SETTINGS_EXPORT_FORMAT) return null;
  } else if (envelope.version !== 1) {
    return null;
  }
  if (!Array.isArray(envelope.connections)) return null;

  const accepted: AIConnection[] = [];
  let skippedCount = 0;
  for (const entry of envelope.connections) {
    if (!entry || typeof entry !== "object") {
      skippedCount += 1;
      continue;
    }
    const item = entry as Partial<AIConnection>;
    // Every field the runtime actually requires must be a non-empty string;
    // entries that fail any check are skipped and counted so the user can
    // see how much of their file was discarded.
    if (typeof item.name !== "string" || item.name.trim().length === 0) {
      skippedCount += 1;
      continue;
    }
    if (typeof item.endpoint !== "string" || item.endpoint.trim().length === 0) {
      skippedCount += 1;
      continue;
    }
    if (typeof item.model !== "string" || item.model.trim().length === 0) {
      skippedCount += 1;
      continue;
    }
    if (typeof item.apiKey !== "string") {
      skippedCount += 1;
      continue;
    }
    if (item.active !== undefined && typeof item.active !== "boolean") {
      skippedCount += 1;
      continue;
    }
    const id = typeof item.id === "string" && item.id.length > 0
      ? item.id
      : `connection-imported-${accepted.length}`;
    accepted.push({
      id,
      name: item.name.trim(),
      endpoint: item.endpoint.trim(),
      apiKey: item.apiKey,
      model: item.model.trim(),
      active: item.active ?? true,
    });
  }

  const incoming = envelope.bindings && typeof envelope.bindings === "object"
    ? (envelope.bindings as Partial<AIBindings>)
    : null;
  const available = new Set(accepted.map((connection) => connection.id));
  const fallback = accepted[0]?.id ?? "";
  const pick = (key: keyof AIBindings): string => {
    const value = incoming?.[key];
    return typeof value === "string" && available.has(value) ? value : fallback;
  };
  // W0：worldRuntime 与 search/analysis/story 不同——导入时若来源没有指定，
  // 保持「未绑定」而不是顺手指向第一个连接。
  const pickOptional = (key: keyof AIBindings): string => {
    const value = incoming?.[key];
    return typeof value === "string" && available.has(value) ? value : "";
  };

  return {
    connections: accepted,
    bindings: {
      search: pick("search"),
      analysis: pick("analysis"),
      story: pick("story"),
      worldRuntime: pickOptional("worldRuntime"),
      worldAgent: pickOptional("worldAgent"),
    },
    skippedCount,
  };
}
/**
 * Merge the imported connections into the live list. Existing ids are
 * preserved; colliding ids get a fresh `connection-imported-<ts>-<n>` id so
 * the user never loses their own setup. Bindings are kept untouched so the
 * user's chosen search/analysis/story targets survive the import. The
 * imported bindings are intentionally discarded to avoid hijacking the
 * user's current feature bindings with stale ids.
 */
export function mergeImportedConnections(
  current: AIConnection[],
  bindings: AIBindings,
  imported: AIConnection[],
  now: number = Date.now(),
): MergeImportResult {
  const existingIds = new Set(current.map((connection) => connection.id));
  const accepted: AIConnection[] = [];
  let renamedCount = 0;
  let counter = 0;
  for (const item of imported) {
    if (!existingIds.has(item.id)) {
      existingIds.add(item.id);
      accepted.push({ ...item });
      continue;
    }
    let fresh = `connection-imported-${now}-${counter}`;
    counter += 1;
    while (existingIds.has(fresh)) {
      fresh = `connection-imported-${now}-${counter}`;
      counter += 1;
    }
    existingIds.add(fresh);
    accepted.push({ ...item, id: fresh });
    renamedCount += 1;
  }
  return {
    connections: [...current, ...accepted],
    bindings,
    addedCount: accepted.length,
    renamedCount,
  };
}