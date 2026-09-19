/**
 * atlas-settings.ts — ATLAS-18 设置纯层（schemaVersion 2）。
 *
 * 职责（开发规格README.md 0.4 / 0.5 / 0.6）：
 * - 两套**互不引用**的预设库：API 连接预设（endpoint/Key/模型/参数）与提示词预设（systemPrompt）。
 * - v1（组合式 worldTurn/majorEvent/presetLibrary）→ v2 的**纯函数**迁移；不在此处写 store。
 * - 设置写入命令 reducer：调用方（server）负责「读当前 → 应用命令 → store.write → 成功后替换缓存」。
 * - GET 脱敏视图：Key 只出 `{ exists, tail }`，永不返回明文字符串。
 * - 运行时组合：活动 API 连接 + 活动提示词 → 现有 `AtlasApiPreset`（供 callAtlasWorldTurnApi 复用）。
 *
 * 硬规则（违反即 bug）：
 * 1. 预设 ID 形状固定 `[A-Za-z0-9_-]{1,128}`，**绝不以名称作主键**；重命名不换 ID。
 * 2. 活动引用指向不存在的 ID → 视为「未配置」（null）；**绝不偷偷回退到列表第一条**。
 * 3. 删除活动项时必须在同一次返回的新快照里把引用清为 null（调用方原子写入）。
 * 4. 内置默认提示词不是持久化记录：`activePromptPresetId = null` 即代表它。
 * 5. 纯函数：无 DOM、无 IO、无随机（随机 ID 只出现在命令 reducer 且依赖可注入）。
 */

import {
  DEFAULT_WORLD_TURN_SYSTEM_PROMPT,
  type AtlasApiPreset,
} from "./atlas-api-client.ts";

export const ATLAS_SETTINGS_SCHEMA_VERSION = 2;
/** 内置默认提示词的虚拟 ID（只在 UI 层出现；持久层用 activePromptPresetId = null 表示）。 */
export const BUILTIN_PROMPT_PRESET_ID = "builtin-default";

const MAX_PRESETS_PER_LIBRARY = 20;
const MAX_NAME_CHARS = 64;
const MAX_ENDPOINT_CHARS = 2048;
const MAX_MODEL_CHARS = 128;
const MAX_API_KEY_CHARS = 4096;
const MIN_MAX_TOKENS = 1;
const MAX_MAX_TOKENS = 8192;
const MIN_TEMPERATURE = 0;
const MAX_TEMPERATURE = 2;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_PROMPT_CHARS = 8000;
const MIN_RPM = 1;
const MAX_RPM = 600;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** API 连接预设：连接资料的唯一载体（不含提示词）。 */
export interface AtlasApiConnectionPreset {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  /** 只持久化；GET 响应永不返回明文（见 settingsViewV2）。 */
  apiKey: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  updatedAt: number;
}

/** 提示词预设：只承载 systemPrompt，与连接完全解耦。 */
export interface AtlasPromptPreset {
  id: string;
  name: string;
  systemPrompt: string;
  updatedAt: number;
}

export interface AtlasServerSettingsV2 {
  schemaVersion: 2;
  apiPresets: AtlasApiConnectionPreset[];
  promptPresets: AtlasPromptPreset[];
  /** null = 未配置 API（提交时必须报 API_NOT_CONFIGURED，零 fetch）。 */
  activeApiPresetId: string | null;
  /** null = 使用内置默认提示词。 */
  activePromptPresetId: string | null;
  autoCommit: boolean;
  rpmLimit: number;
  /** v1 的 majorEvent 旧数据：只兼容保留，不执行、不展示。 */
  legacyMajorEvent?: unknown;
}

export interface AtlasSettingsDeps {
  now?: () => number;
  /** 稳定 ID 注入（测试 / 迁移复用）：同 (kind, index, fingerprint) 必须返回同 ID。 */
  legacyIdFor?: (kind: "api" | "prompt", index: number, fingerprint: string) => string;
}

export interface AtlasSettingsDiagnostics {
  skipped: number;
  apiSkipped: number;
  promptSkipped: number;
  legacyMajorEventPreserved: boolean;
}

export interface AtlasSettingsCommandResult {
  ok: boolean;
  settings: AtlasServerSettingsV2;
  code?: string;
  message?: string;
}

export type AtlasSettingsCommand =
  | {
      action: "api.save";
      preset: {
        id?: string;
        name: string;
        endpoint: string;
        model: string;
        maxTokens: number;
        temperature: number;
        timeoutMs: number;
      };
      apiKeyMode: "keep" | "replace" | "clear";
      apiKey?: string;
    }
  | { action: "api.delete"; id: string }
  | { action: "api.activate"; id: string | null }
  | { action: "prompt.save"; preset: { id?: string; name: string; systemPrompt: string } }
  | { action: "prompt.delete"; id: string }
  | { action: "prompt.activate"; id: string | null }
  | { action: "runtime.update"; autoCommit?: boolean; rpmLimit?: number };

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function nowOf(deps: AtlasSettingsDeps): number {
  return deps.now ? deps.now() : 0;
}

function generateId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  // 无 randomUUID 环境的回退：时间戳 + 随机字节（仍满足 ID 形状）
  const rand = Math.floor(Math.random() * 0xffffffff).toString(16);
  return `p-${Date.now().toString(36)}-${rand}`;
}

/** 把注入 / 外部 ID 归一为合法形状（迁移与命令共用；非法字符以 - 替代，超长截断）。 */
function normalizeId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 128);
  if (!cleaned || !ID_PATTERN.test(cleaned)) return null;
  return cleaned;
}

function isFiniteIntIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= min && value <= max;
}

function isFiniteIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value);
}

/** 连接指纹（迁移去重用）：除名称与提示词外的全部连接字段。 */
function fingerprintOfConnection(input: {
  endpoint: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}): string {
  return [input.endpoint, input.model, input.apiKey, input.maxTokens, input.temperature, input.timeoutMs].join("\u0000");
}

/** 名称冲突顺延：`名字`、`名字 (2)`、`名字 (3)`…（不覆盖已有项）。 */
function uniqueName(base: string, used: Set<string>): string {
  const trimmed = base.trim().slice(0, MAX_NAME_CHARS) || "未命名";
  if (!used.has(trimmed)) {
    used.add(trimmed);
    return trimmed;
  }
  for (let n = 2; n < 1000; n += 1) {
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

function resolveId(kind: "api" | "prompt", index: number, fingerprint: string, deps: AtlasSettingsDeps, usedIds: Set<string>): string {
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

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

export function createDefaultSettingsV2(): AtlasServerSettingsV2 {
  return {
    schemaVersion: ATLAS_SETTINGS_SCHEMA_VERSION,
    apiPresets: [],
    promptPresets: [],
    activeApiPresetId: null,
    activePromptPresetId: null,
    autoCommit: true,
    rpmLimit: 30,
  };
}

// ---------------------------------------------------------------------------
// 解析（v2 存储 → 合法设置；非法条目丢弃、悬挂引用归一）
// ---------------------------------------------------------------------------

function parseConnectionPreset(raw: unknown): Omit<AtlasApiConnectionPreset, "id" | "updatedAt"> & { id: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = normalizeId(record.id);
  if (!id) return null;
  if (typeof record.name !== "string" || !record.name.trim() || record.name.length > MAX_NAME_CHARS) return null;
  if (typeof record.endpoint !== "string" || record.endpoint.length > MAX_ENDPOINT_CHARS || !isHttpUrl(record.endpoint)) return null;
  if (typeof record.model !== "string" || !record.model.trim() || record.model.length > MAX_MODEL_CHARS) return null;
  if (typeof record.apiKey !== "string" || record.apiKey.length > MAX_API_KEY_CHARS) return null;
  if (!isFiniteIntIn(record.maxTokens, MIN_MAX_TOKENS, MAX_MAX_TOKENS)) return null;
  if (!isFiniteIn(record.temperature, MIN_TEMPERATURE, MAX_TEMPERATURE)) return null;
  if (!isFiniteIntIn(record.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)) return null;
  return {
    id,
    name: record.name.trim(),
    endpoint: record.endpoint,
    model: record.model.trim(),
    apiKey: record.apiKey,
    maxTokens: record.maxTokens,
    temperature: record.temperature,
    timeoutMs: record.timeoutMs,
  };
}

function parsePromptPreset(raw: unknown): { id: string; name: string; systemPrompt: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = normalizeId(record.id);
  if (!id || id === BUILTIN_PROMPT_PRESET_ID) return null;
  if (typeof record.name !== "string" || !record.name.trim() || record.name.length > MAX_NAME_CHARS) return null;
  if (typeof record.systemPrompt !== "string") return null;
  const prompt = record.systemPrompt.trim();
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) return null;
  return { id, name: record.name.trim(), systemPrompt: prompt };
}

/**
 * v2 存储 → 合法设置。非法条目丢弃；活动引用悬挂 → null（绝不偷切第一条）；
 * autoCommit / rpmLimit 越界 → 缺省值。
 */
export function sanitizeSettingsV2(raw: unknown, deps: AtlasSettingsDeps = {}): { settings: AtlasServerSettingsV2; diagnostics: AtlasSettingsDiagnostics } {
  const diagnostics: AtlasSettingsDiagnostics = { skipped: 0, apiSkipped: 0, promptSkipped: 0, legacyMajorEventPreserved: false };
  const base = createDefaultSettingsV2();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { settings: base, diagnostics };
  const record = raw as Record<string, unknown>;

  const seenIds = new Set<string>();
  const apiPresets: AtlasApiConnectionPreset[] = [];
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
      const updatedAt = (entry as { updatedAt?: unknown }).updatedAt;
      apiPresets.push({ ...parsed, updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : nowOf(deps) });
    }
  }

  const promptPresets: AtlasPromptPreset[] = [];
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
      const updatedAt = (entry as { updatedAt?: unknown }).updatedAt;
      promptPresets.push({ ...parsed, updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : nowOf(deps) });
    }
  }

  const activeApi = normalizeId(record.activeApiPresetId);
  const activePrompt = normalizeId(record.activePromptPresetId);
  const settings: AtlasServerSettingsV2 = {
    schemaVersion: ATLAS_SETTINGS_SCHEMA_VERSION,
    apiPresets,
    promptPresets,
    // 悬挂引用归一为 null（= 未配置 / 内置默认），绝不回退列表首项
    activeApiPresetId: activeApi && apiPresets.some((p) => p.id === activeApi) ? activeApi : null,
    activePromptPresetId: activePrompt && promptPresets.some((p) => p.id === activePrompt) ? activePrompt : null,
    autoCommit: typeof record.autoCommit === "boolean" ? record.autoCommit : true,
    rpmLimit: isFiniteIntIn(record.rpmLimit, MIN_RPM, MAX_RPM) ? record.rpmLimit : 30,
  };
  if ("legacyMajorEvent" in record) {
    settings.legacyMajorEvent = record.legacyMajorEvent;
    diagnostics.legacyMajorEventPreserved = record.legacyMajorEvent !== null && record.legacyMajorEvent !== undefined;
  }
  return { settings, diagnostics };
}

// ---------------------------------------------------------------------------
// v1 → v2 迁移（纯函数；不写 store）
// ---------------------------------------------------------------------------

interface LegacyPresetShape {
  name: string;
  endpoint: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  /** 旧组合预设的提示词正文（缺省 = 空串，表示使用内置默认）。 */
  systemPrompt: string;
}

function parseLegacyPreset(raw: unknown): LegacyPresetShape | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.name !== "string" || !record.name.trim() || record.name.length > MAX_NAME_CHARS) return null;
  if (typeof record.endpoint !== "string" || record.endpoint.length > MAX_ENDPOINT_CHARS || !isHttpUrl(record.endpoint)) return null;
  if (typeof record.model !== "string" || !record.model.trim() || record.model.length > MAX_MODEL_CHARS) return null;
  const apiKey = typeof record.apiKey === "string" && record.apiKey.length <= MAX_API_KEY_CHARS ? record.apiKey : null;
  if (apiKey === null) return null;
  const maxTokens = isFiniteIntIn(record.maxTokens, MIN_MAX_TOKENS, MAX_MAX_TOKENS) ? record.maxTokens : 1024;
  const temperature = isFiniteIn(record.temperature, MIN_TEMPERATURE, MAX_TEMPERATURE) ? record.temperature : 0.7;
  const timeoutMs = isFiniteIntIn(record.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS) ? record.timeoutMs : 30_000;
  const systemPrompt = typeof record.systemPrompt === "string" ? record.systemPrompt : "";
  return { name: record.name.trim(), endpoint: record.endpoint, model: record.model.trim(), apiKey, maxTokens, temperature, timeoutMs, systemPrompt };
}

/**
 * v1 → v2 无损迁移。
 * 顺序（规格 0.5）：库内 worldTurn → 追加活动 worldTurn；连接按完整指纹去重、名称冲突顺延；
 * 非空 systemPrompt 按正文去重成提示词预设；活动组合预设决定两个活动引用；
 * majorEvent 原样深拷贝进 legacyMajorEvent；非法项跳过并计数（诊断不含密钥与正文）。
 */
export function migrateAtlasSettings(raw: unknown, deps: AtlasSettingsDeps = {}): {
  settings: AtlasServerSettingsV2;
  diagnostics: AtlasSettingsDiagnostics;
} {
  const diagnostics: AtlasSettingsDiagnostics = { skipped: 0, apiSkipped: 0, promptSkipped: 0, legacyMajorEventPreserved: false };
  const settings = createDefaultSettingsV2();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { settings, diagnostics };
  const record = raw as Record<string, unknown>;

  const library = record.presetLibrary && typeof record.presetLibrary === "object" && !Array.isArray(record.presetLibrary)
    ? (record.presetLibrary as Record<string, unknown>)
    : {};
  const list: unknown[] = [];
  if (Array.isArray(library.worldTurn)) list.push(...library.worldTurn);
  if (record.worldTurn !== undefined && record.worldTurn !== null) list.push(record.worldTurn);

  const usedIds = new Set<string>();
  const usedApiNames = new Set<string>();
  const usedPromptNames = new Set<string>();
  const byFingerprint = new Map<string, string>();
  const promptByText = new Map<string, string>();
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
        timeoutMs: legacy.timeoutMs,
        updatedAt: nowOf(deps),
      });
    }
    // 活动引用必须在处理提示词之前落定：空提示词时 activePromptPresetId = null（内置默认）
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
        updatedAt: nowOf(deps),
      });
    }
    if (isActiveSource) settings.activePromptPresetId = promptByText.get(promptText) ?? null;
  }

  // 活动项也可能来自库内最后一项（v1 的 worldTurn 为 null 时不存在活动项）
  if (settings.activeApiPresetId === null && record.worldTurn === null && settings.apiPresets.length > 0) {
    // 仅当 v1 明确没有活动项时保持未配置；不偷切第一条
    settings.activeApiPresetId = null;
  }

  const legacyMajor: unknown[] = [];
  if (record.majorEvent !== undefined && record.majorEvent !== null) legacyMajor.push(record.majorEvent);
  if (Array.isArray(library.majorEvent)) legacyMajor.push(...library.majorEvent);
  if (legacyMajor.length > 0) {
    settings.legacyMajorEvent = JSON.parse(JSON.stringify(legacyMajor));
    diagnostics.legacyMajorEventPreserved = true;
  }

  if (typeof record.autoCommit === "boolean") settings.autoCommit = record.autoCommit;
  if (isFiniteIntIn(record.rpmLimit, MIN_RPM, MAX_RPM)) settings.rpmLimit = record.rpmLimit;
  return { settings, diagnostics };
}

// ---------------------------------------------------------------------------
// 命令 reducer（纯函数；调用方负责持久化与缓存替换）
// ---------------------------------------------------------------------------

function fail(settings: AtlasServerSettingsV2, code: string, message: string): AtlasSettingsCommandResult {
  return { ok: false, settings, code, message };
}

export function applySettingsCommand(
  settings: AtlasServerSettingsV2,
  command: AtlasSettingsCommand,
  deps: AtlasSettingsDeps = {},
): AtlasSettingsCommandResult {
  const now = nowOf(deps);
  switch (command.action) {
    case "api.save": {
      const preset = command.preset;
      if (typeof preset.name !== "string" || !preset.name.trim() || preset.name.length > MAX_NAME_CHARS) {
        return fail(settings, "INVALID_PAYLOAD", "连接名称必填且不超过 64 字。");
      }
      if (typeof preset.endpoint !== "string" || preset.endpoint.length > MAX_ENDPOINT_CHARS || !isHttpUrl(preset.endpoint)) {
        return fail(settings, "INVALID_PAYLOAD", "端点必须是 http(s) 绝对地址。");
      }
      if (typeof preset.model !== "string" || !preset.model.trim() || preset.model.length > MAX_MODEL_CHARS) {
        return fail(settings, "INVALID_PAYLOAD", "模型名必填且不超过 128 字。");
      }
      if (!isFiniteIntIn(preset.maxTokens, MIN_MAX_TOKENS, MAX_MAX_TOKENS)) {
        return fail(settings, "INVALID_PAYLOAD", `最大回复长度必须是 ${MIN_MAX_TOKENS}..${MAX_MAX_TOKENS} 的整数。`);
      }
      if (!isFiniteIn(preset.temperature, MIN_TEMPERATURE, MAX_TEMPERATURE)) {
        return fail(settings, "INVALID_PAYLOAD", `温度必须在 ${MIN_TEMPERATURE}..${MAX_TEMPERATURE}。`);
      }
      if (!isFiniteIntIn(preset.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)) {
        return fail(settings, "INVALID_PAYLOAD", `超时必须是 ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS} 毫秒。`);
      }
      const targetId = preset.id === undefined ? null : normalizeId(preset.id);
      if (preset.id !== undefined && targetId === null) {
        return fail(settings, "INVALID_PAYLOAD", "预设 ID 形状非法。");
      }
      const existingIndex = targetId ? settings.apiPresets.findIndex((p) => p.id === targetId) : -1;
      if (targetId && existingIndex < 0) {
        return fail(settings, "INVALID_PAYLOAD", "要更新的连接不存在（另存为请省略 id）。");
      }
      let apiKey: string;
      if (command.apiKeyMode === "keep") {
        if (existingIndex < 0) return fail(settings, "INVALID_PAYLOAD", "新建连接必须提供密钥（可用空字符串表示无需密钥）。");
        apiKey = settings.apiPresets[existingIndex]!.apiKey;
      } else if (command.apiKeyMode === "clear") {
        apiKey = "";
      } else {
        const rawKey = command.apiKey ?? "";
        if (typeof rawKey !== "string" || rawKey.length > MAX_API_KEY_CHARS) {
          return fail(settings, "INVALID_PAYLOAD", "密钥必须是字符串且不超过 4096 字。");
        }
        apiKey = rawKey;
      }
      if (existingIndex < 0 && settings.apiPresets.length >= MAX_PRESETS_PER_LIBRARY) {
        return fail(settings, "FIELD_LIMIT_EXCEEDED", `最多保存 ${MAX_PRESETS_PER_LIBRARY} 条 API 连接。`);
      }
      const usedApiNames = new Set(settings.apiPresets.filter((_, i) => i !== existingIndex).map((p) => p.name));
      const entry: AtlasApiConnectionPreset = {
        id: targetId ?? normalizeId(`api-${now.toString(36)}-${settings.apiPresets.length}`) ?? `api-${settings.apiPresets.length}`,
        name: uniqueName(preset.name, usedApiNames),
        endpoint: preset.endpoint,
        model: preset.model.trim(),
        apiKey,
        maxTokens: preset.maxTokens,
        temperature: preset.temperature,
        timeoutMs: preset.timeoutMs,
        updatedAt: now,
      };
      const apiPresets = existingIndex >= 0
        ? settings.apiPresets.map((p, i) => (i === existingIndex ? entry : p))
        : [...settings.apiPresets, entry];
      return { ok: true, settings: { ...settings, apiPresets } };
    }
    case "api.delete": {
      const id = normalizeId(command.id);
      if (!id) return fail(settings, "INVALID_PAYLOAD", "预设 ID 形状非法。");
      if (!settings.apiPresets.some((p) => p.id === id)) {
        return fail(settings, "INVALID_PAYLOAD", "要删除的连接不存在。");
      }
      return {
        ok: true,
        settings: {
          ...settings,
          apiPresets: settings.apiPresets.filter((p) => p.id !== id),
          // 删除活动项必须在同一次快照里清引用
          activeApiPresetId: settings.activeApiPresetId === id ? null : settings.activeApiPresetId,
        },
      };
    }
    case "api.activate": {
      if (command.id === null) return { ok: true, settings: { ...settings, activeApiPresetId: null } };
      const id = normalizeId(command.id);
      if (!id || !settings.apiPresets.some((p) => p.id === id)) {
        return fail(settings, "INVALID_PAYLOAD", "要启用的连接不存在。");
      }
      return { ok: true, settings: { ...settings, activeApiPresetId: id } };
    }
    case "prompt.save": {
      const preset = command.preset;
      if (preset.id !== undefined && normalizeId(preset.id) === BUILTIN_PROMPT_PRESET_ID) {
        return fail(settings, "INVALID_PAYLOAD", "内置默认提示词不可覆盖，请另存为新预设。");
      }
      if (typeof preset.name !== "string" || !preset.name.trim() || preset.name.length > MAX_NAME_CHARS) {
        return fail(settings, "INVALID_PAYLOAD", "提示词名称必填且不超过 64 字。");
      }
      const text = typeof preset.systemPrompt === "string" ? preset.systemPrompt.trim() : "";
      if (!text) return fail(settings, "INVALID_PAYLOAD", "提示词正文不能为空（空 = 内置默认，无需保存）。");
      if (text.length > MAX_PROMPT_CHARS) return fail(settings, "FIELD_LIMIT_EXCEEDED", `提示词不超过 ${MAX_PROMPT_CHARS} 字。`);
      const targetId = preset.id === undefined ? null : normalizeId(preset.id);
      if (preset.id !== undefined && targetId === null) return fail(settings, "INVALID_PAYLOAD", "预设 ID 形状非法。");
      const existingIndex = targetId ? settings.promptPresets.findIndex((p) => p.id === targetId) : -1;
      if (targetId && existingIndex < 0) return fail(settings, "INVALID_PAYLOAD", "要更新的提示词预设不存在（另存为请省略 id）。");
      if (existingIndex < 0 && settings.promptPresets.length >= MAX_PRESETS_PER_LIBRARY) {
        return fail(settings, "FIELD_LIMIT_EXCEEDED", `最多保存 ${MAX_PRESETS_PER_LIBRARY} 条提示词预设。`);
      }
      const usedNames = new Set(settings.promptPresets.filter((_, i) => i !== existingIndex).map((p) => p.name));
      const entry: AtlasPromptPreset = {
        id: targetId ?? normalizeId(`prompt-${now.toString(36)}-${settings.promptPresets.length}`) ?? `prompt-${settings.promptPresets.length}`,
        name: uniqueName(preset.name, usedNames),
        systemPrompt: text,
        updatedAt: now,
      };
      const promptPresets = existingIndex >= 0
        ? settings.promptPresets.map((p, i) => (i === existingIndex ? entry : p))
        : [...settings.promptPresets, entry];
      return { ok: true, settings: { ...settings, promptPresets } };
    }
    case "prompt.delete": {
      const id = normalizeId(command.id);
      if (!id) return fail(settings, "INVALID_PAYLOAD", "预设 ID 形状非法。");
      if (id === BUILTIN_PROMPT_PRESET_ID) return fail(settings, "INVALID_PAYLOAD", "内置默认提示词不可删除。");
      if (!settings.promptPresets.some((p) => p.id === id)) return fail(settings, "INVALID_PAYLOAD", "要删除的提示词预设不存在。");
      return {
        ok: true,
        settings: {
          ...settings,
          promptPresets: settings.promptPresets.filter((p) => p.id !== id),
          activePromptPresetId: settings.activePromptPresetId === id ? null : settings.activePromptPresetId,
        },
      };
    }
    case "prompt.activate": {
      if (command.id === null) return { ok: true, settings: { ...settings, activePromptPresetId: null } };
      const id = normalizeId(command.id);
      if (!id || !settings.promptPresets.some((p) => p.id === id)) {
        return fail(settings, "INVALID_PAYLOAD", "要启用的提示词预设不存在。");
      }
      return { ok: true, settings: { ...settings, activePromptPresetId: id } };
    }
    case "runtime.update": {
      const next: AtlasServerSettingsV2 = { ...settings };
      if (command.autoCommit !== undefined) {
        if (typeof command.autoCommit !== "boolean") return fail(settings, "INVALID_PAYLOAD", "自动提交必须是布尔值。");
        next.autoCommit = command.autoCommit;
      }
      if (command.rpmLimit !== undefined) {
        if (!isFiniteIntIn(command.rpmLimit, MIN_RPM, MAX_RPM)) {
          return fail(settings, "INVALID_PAYLOAD", `RPM 上限必须是 ${MIN_RPM}..${MAX_RPM} 的整数。`);
        }
        next.rpmLimit = command.rpmLimit;
      }
      return { ok: true, settings: next };
    }
    default:
      return fail(settings, "INVALID_PAYLOAD", "未知的设置命令。");
  }
}

/**
 * 兼容适配器（规格 0.6）：v1 部分更新载荷 → v2 语义。
 * 只在兼容期内使用；UI 新代码一律发命令。语义：
 * - `worldTurn` 非 null → upsert 连接（按指纹）并**激活**它；其提示词非空则 upsert + 激活。
 * - `worldTurn: null` → 清空两个活动引用（等价 api.activate null）。
 * - `presetLibrary.worldTurn` → 逐条 upsert（不激活）；`majorEvent` / `presetLibrary.majorEvent` → legacyMajorEvent。
 * - `autoCommit` / `rpmLimit` → runtime.update。
 */
export function applyLegacySettingsPatch(
  settings: AtlasServerSettingsV2,
  body: unknown,
  deps: AtlasSettingsDeps = {},
): AtlasSettingsCommandResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail(settings, "INVALID_PAYLOAD", "设置必须是对象");
  }
  const record = body as Record<string, unknown>;
  const now = nowOf(deps);
  let next: AtlasServerSettingsV2 = { ...settings };
  const usedIds = new Set<string>(next.apiPresets.map((p) => p.id));
  const usedPromptIds = new Set<string>(next.promptPresets.map((p) => p.id));

  const upsertConnection = (legacy: LegacyPresetShape): string | null => {
    const fingerprint = fingerprintOfConnection(legacy);
    const existing = next.apiPresets.find((p) => fingerprintOfConnection({
      endpoint: p.endpoint, model: p.model, apiKey: p.apiKey,
      maxTokens: p.maxTokens, temperature: p.temperature, timeoutMs: p.timeoutMs,
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
        timeoutMs: legacy.timeoutMs,
        updatedAt: now,
      }],
    };
    return id;
  };

  const upsertPrompt = (legacy: LegacyPresetShape): string | null => {
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
        updatedAt: now,
      }],
    };
    return id;
  };

  // 预设库（只入库，不改活动引用）
  const library = record.presetLibrary && typeof record.presetLibrary === "object" && !Array.isArray(record.presetLibrary)
    ? (record.presetLibrary as Record<string, unknown>)
    : null;
  if (library && Array.isArray(library.worldTurn)) {
    for (const entry of library.worldTurn) {
      const legacy = parseLegacyPreset(entry);
      if (!legacy) return fail(settings, "INVALID_PAYLOAD", "presetLibrary.worldTurn 存在非法预设（name / endpoint / model / apiKey 或数值超限）");
      upsertConnection(legacy);
      upsertPrompt(legacy);
    }
  }
  const legacyMajor: unknown[] = [];
  if (record.majorEvent !== undefined && record.majorEvent !== null) legacyMajor.push(record.majorEvent);
  if (library && Array.isArray(library.majorEvent)) legacyMajor.push(...library.majorEvent);
  if (legacyMajor.length > 0) {
    next = { ...next, legacyMajorEvent: JSON.parse(JSON.stringify(legacyMajor)) };
  }

  // 活动组合预设 → 两库 + 两个活动引用
  if (record.worldTurn !== undefined) {
    if (record.worldTurn === null) {
      next = { ...next, activeApiPresetId: null, activePromptPresetId: null };
    } else {
      const legacy = parseLegacyPreset(record.worldTurn);
      if (!legacy) return fail(settings, "INVALID_PAYLOAD", "worldTurn 预设字段非法（name / endpoint / model / apiKey 或数值超限）");
      const apiId = upsertConnection(legacy);
      if (!apiId) return fail(settings, "FIELD_LIMIT_EXCEEDED", `最多保存 ${MAX_PRESETS_PER_LIBRARY} 条 API 连接。`);
      const promptId = upsertPrompt(legacy);
      next = { ...next, activeApiPresetId: apiId, activePromptPresetId: promptId };
    }
  }

  if (record.autoCommit !== undefined) {
    if (typeof record.autoCommit !== "boolean") return fail(settings, "INVALID_PAYLOAD", "autoCommit 必须是布尔值");
    next = { ...next, autoCommit: record.autoCommit };
  }
  if (record.rpmLimit !== undefined) {
    if (!isFiniteIntIn(record.rpmLimit, MIN_RPM, MAX_RPM)) return fail(settings, "INVALID_PAYLOAD", "rpmLimit 必须是 1..600 的数字");
    next = { ...next, rpmLimit: record.rpmLimit };
  }
  return { ok: true, settings: next };
}

// ---------------------------------------------------------------------------
// 脱敏视图 + 运行时组合
// ---------------------------------------------------------------------------

export interface AtlasSettingsView {
  schemaVersion: 2;
  apiPresets: Array<{
    id: string;
    name: string;
    endpoint: string;
    model: string;
    maxTokens: number;
    temperature: number;
    timeoutMs: number;
    apiKey: { exists: boolean; tail: string | null };
  }>;
  promptPresets: AtlasPromptPreset[];
  activeApiPresetId: string | null;
  activePromptPresetId: string | null;
  builtInPrompt: { id: string; name: string; readOnly: true; systemPrompt: string };
  autoCommit: boolean;
  rpmLimit: number;
}

/** GET /settings 的唯一视图：Key 只给 exists + 尾号；悬挂引用归一为 null。 */
export function settingsViewV2(settings: AtlasServerSettingsV2): AtlasSettingsView {
  const activeApi = settings.activeApiPresetId && settings.apiPresets.some((p) => p.id === settings.activeApiPresetId)
    ? settings.activeApiPresetId
    : null;
  const activePrompt = settings.activePromptPresetId && settings.promptPresets.some((p) => p.id === settings.activePromptPresetId)
    ? settings.activePromptPresetId
    : null;
  return {
    schemaVersion: ATLAS_SETTINGS_SCHEMA_VERSION,
    apiPresets: settings.apiPresets.map((p) => {
      const key = p.apiKey ?? "";
      return {
        id: p.id,
        name: p.name,
        endpoint: p.endpoint,
        model: p.model,
        maxTokens: p.maxTokens,
        temperature: p.temperature,
        timeoutMs: p.timeoutMs,
        apiKey: { exists: key.trim().length > 0, tail: key.trim().length >= 4 ? key.trim().slice(-4) : null },
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
    },
    autoCommit: settings.autoCommit,
    rpmLimit: settings.rpmLimit,
  };
}

/**
 * 运行时组合：活动 API 连接 + 活动提示词 → 现有 AtlasApiPreset。
 * 未配置活动 API → null（提交必须报 API_NOT_CONFIGURED，零 fetch）。
 * 活动提示词为 null → systemPrompt 空串（交给 DEFAULT_WORLD_TURN_SYSTEM_PROMPT 兜底）。
 */
export function resolveWorldTurnPreset(settings: AtlasServerSettingsV2): AtlasApiPreset | null {
  const connection = settings.apiPresets.find((p) => p.id === settings.activeApiPresetId);
  if (!connection) return null;
  const prompt = settings.promptPresets.find((p) => p.id === settings.activePromptPresetId);
  return {
    name: connection.name,
    endpoint: connection.endpoint,
    model: connection.model,
    apiKey: connection.apiKey,
    maxTokens: connection.maxTokens,
    temperature: connection.temperature,
    timeoutMs: connection.timeoutMs,
    ...(prompt ? { systemPrompt: prompt.systemPrompt } : {}),
  };
}
