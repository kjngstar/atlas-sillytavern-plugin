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
  DEFAULT_PROMPT_SEGMENTS_TABLE_DELTA,
  DEFAULT_WORLD_TURN_SYSTEM_PROMPT,
  type AtlasApiPreset,
} from "./atlas-api-client.ts";

/**
 * C02 / E01：推进输出协议的类型。
 *
 * 计划 §2.2 明确保留 `table-delta-v1` 这个**已发布**的输出协议名称（v1 在这里表示增量协议
 * 自身的版本，不等于旧 v1 世界草稿），因此联合类型保留 `"v1" | "v2"` 两个历史取值只为
 * **读取旧存档与原样保留用户原始设置**；运行时分派、提示词选择、写入命令一律只认
 * `table-delta-v1`（见 `normalizeWorldTurnProtocol` 与 `applySettingsCommand` 的 runtime.update）。
 */
export type AtlasWorldTurnProtocol = "v1" | "v2" | "table-delta-v1";

/**
 * 新安装 / 缺字段时的缺省协议。
 *
 * E01（0.9.59）：`normalizeWorldTurnProtocol` 现在把**缺失 / 非法 / 旧值 v1 / 旧值 v2**
 * 全部在**读取时**规范成 `table-delta-v1`；旧值本身不写回存储，作者的原始设置与旧预设
 * 全文都原样保留（读取视图另附 `legacy` 诊断）。
 */
export const DEFAULT_WORLD_TURN_PROTOCOL: AtlasWorldTurnProtocol = "table-delta-v1";

/**
 * E01：读取既有存档时的协议归一化——运行时**只存在一种协议**。
 *
 * - `"table-delta-v1"` → 原样；
 * - `"v1"` / `"v2"`（历史设置）→ `"table-delta-v1"`，并由 `settingsViewV2` 的
 *   `legacyWorldTurnProtocol` 告诉作者「历史设置已升级为表格增量」；
 * - 缺失 / 非法 → `"table-delta-v1"`。
 *
 * **注意**：本函数只影响**读取视图**与运行时行为；持久层里的原始值不被改写
 * （见 `settingsViewV2` 与 `applySettingsCommand` 的注释）。
 */
export function normalizeWorldTurnProtocol(value: unknown): AtlasWorldTurnProtocol {
  if (value === "table-delta-v1") return "table-delta-v1";
  // E01：v1 / v2 与任何非法值在读取时统一升级为唯一现行协议
  return DEFAULT_WORLD_TURN_PROTOCOL;
}

/**
 * E01：读取视图里的旧值诊断（null = 没有需要升级的历史值）。
 * 作者能看到「历史设置已升级为表格增量」，且原始设置没有被悄悄覆盖。
 */
export interface AtlasLegacyWorldTurnProtocolNotice {
  /** 持久层里实际保存的旧值（`"v1"` / `"v2"`）。 */
  storedValue: "v1" | "v2";
  /** 运行时实际使用的协议（恒为 `table-delta-v1`）。 */
  effectiveValue: "table-delta-v1";
  /** 面向作者的一句话说明。 */
  message: string;
}

/**
 * C02 / E02：内置提示词分段只按**唯一现行协议**给出。
 *
 * 旧实现按 v1/v2 返回旧契约分段——那正是「提示词资产与输出协议混淆」的根源。
 * 现在无论传入什么（含历史 v1/v2 值），只输出六段 table-delta 默认段；
 * **作者自己保存的旧协议预设全文仍原样保存在 `promptPresets` 里**，编辑器可查看、可复制，
 * 另有「创建兼容增量草稿」命令生成一份新的兼容预设（不做静默字符串替换）。
 */
export function defaultSegmentsForProtocol(
  _protocol?: AtlasWorldTurnProtocol | null,
): Array<{ role: string; name: string; mainSlot?: string; content: string }> {
  return DEFAULT_PROMPT_SEGMENTS_TABLE_DELTA;
}

/**
 * E02：把作者自己保存的旧协议提示词预设**复制**成一份兼容增量草稿的内容。
 *
 * 纪律（计划 §3-E02 原文）：**不做静默字符串替换**——旧预设原文一字不改，
 * 这里只负责产出新预设的**初稿**：把已知的旧协议关键词替换成增量契约说明，
 * 再把内置六段行增量协议接到最前面，让作者在新预设里继续自由编辑。
 */
export function buildTableDeltaCompatiblePrompt(oldPreset: AtlasPromptPreset): {
  name: string;
  systemPrompt: string;
  segments: AtlasPromptSegment[];
  replacedKeywords: string[];
} {
  /** 旧协议关键词 → 增量契约说法（只用于**新草稿**，不改旧预设）。 */
  const KEYWORD_REWRITES: Array<[RegExp, string]> = [
    // 覆盖 `"schemaVersion": 2` / `schemaVersion:2` / `schemaVersion 2` 三种实际写法
    [/["']?schemaVersion["']?\s*[:：]?\s*2/gi, "table-delta-v1"],
    [/narrativeSummary/gi, "表格增量行"],
    [/mapScaleHints/gi, "（尺度改走建图标定接口）"],
    [/identityUpdates/gi, "character/location 行"],
    [/discoveries/gi, "location add 行"],
    [/npcUpdates/gi, "character set 行"],
    [/eventDrafts/gi, "simulation propose 行"],
    [/locationChange/gi, "character set 行的 locationRef"],
  ];
  let body = typeof oldPreset.systemPrompt === "string" ? oldPreset.systemPrompt : "";
  if (Array.isArray(oldPreset.segments) && oldPreset.segments.length > 0) {
    body = oldPreset.segments.map((segment) => String(segment.content ?? "")).join("\n\n");
  }
  const replacedKeywords: string[] = [];
  for (const [pattern, replacement] of KEYWORD_REWRITES) {
    const matched = body.match(pattern);
    if (matched) {
      replacedKeywords.push(...matched.slice(0, 4));
      body = body.replace(pattern, replacement);
    }
  }
  const name = `${oldPreset.name}（增量兼容草稿）`.slice(0, 64);
  const segments: AtlasPromptSegment[] = [
    ...DEFAULT_PROMPT_SEGMENTS_TABLE_DELTA.map((segment) => ({
      role: segment.role as AtlasPromptSegmentRole,
      content: segment.content,
      ...(segment.name ? { name: segment.name } : {}),
      ...(segment.mainSlot ? { mainSlot: segment.mainSlot as "A" | "B" } : {}),
    })),
  ];
  if (body.trim().length > 0) {
    segments.push({
      role: "user",
      name: "原预设摘录（旧协议关键词已在新草稿里改写）",
      content: body.trim().slice(0, MAX_PROMPT_CHARS),
    });
  }
  return {
    name,
    systemPrompt: body.trim().slice(0, MAX_PROMPT_CHARS),
    segments: segments.slice(0, MAX_PROMPT_SEGMENTS),
    replacedKeywords: Array.from(new Set(replacedKeywords)).slice(0, 16),
  };
}

import {
  DEFAULT_CONTENT_REPLACE_RULES,
  MAX_REPLACE_RULES,
  normalizeContentReplaceRules,
  type AtlasContentReplaceRule,
} from "./atlas-content-replace.ts";

export const ATLAS_SETTINGS_SCHEMA_VERSION = 2;
/** 内置默认提示词的虚拟 ID（只在 UI 层出现；持久层用 activePromptPresetId = null 表示）。 */
export const BUILTIN_PROMPT_PRESET_ID = "builtin-default";

const MAX_PRESETS_PER_LIBRARY = 20;
const MAX_NAME_CHARS = 64;
const MAX_ENDPOINT_CHARS = 2048;
const MAX_MODEL_CHARS = 128;
const MAX_API_KEY_CHARS = 4096;
const MIN_MAX_TOKENS = 1;
const MAX_MAX_TOKENS = 65536;
const MIN_TEMPERATURE = 0;
const MAX_TEMPERATURE = 2;
const MIN_TOP_P = 0;
const MAX_TOP_P = 1;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_PROMPT_CHARS = 8000;
const MIN_RPM = 1;
const MAX_RPM = 600;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** 连接方式（0.9.13 全抄 shujuku）：custom = 自定义 API；main = 酒馆主 API（TavernHelper.generateRaw）；profile = 酒馆连接预设（ConnectionManagerRequestService）。 */
export type AtlasConnectionMode = "custom" | "main" | "profile";

/** 接口协议（0.9.13 对齐 shujuku customApiFormat 四值）：openai_responses 在原版酒馆等同 openai（无独立 /responses 路由），gemini 映射 makersuite 源。 */
export type AtlasApiFormat = "openai" | "openai_responses" | "claude" | "gemini";

const CONNECTION_MODES: readonly AtlasConnectionMode[] = ["custom", "main", "profile"];
const API_FORMATS: readonly AtlasApiFormat[] = ["openai", "openai_responses", "claude", "gemini"];
/** 提示词后处理（SillyTavern custom_prompt_post_processing 全集；"" = 不携带，后端按 none 原样透传）。 */
const PROMPT_POST_PROCESSING = ["", "merge_tools", "semi_tools", "strict_tools", "merge", "semi", "strict", "single"] as const;

export function normalizeConnectionMode(raw: unknown): AtlasConnectionMode {
  return CONNECTION_MODES.includes(raw as AtlasConnectionMode) ? (raw as AtlasConnectionMode) : "custom";
}

export function normalizeApiFormat(raw: unknown): AtlasApiFormat {
  // openai_responses 在原版酒馆无独立后端 → 归一为 openai（shujuku 同款回退）
  if (raw === "openai_responses") return "openai";
  return API_FORMATS.includes(raw as AtlasApiFormat) ? (raw as AtlasApiFormat) : "openai";
}

export function normalizePromptPostProcessing(raw: unknown): string {
  // 0.9.17 shujuku 同款语义：显式空串 = 用户选择「未选择」，保留（请求不携带）；
  // 缺失 / 非字符串 / 非法值 → 默认 strict（强制对话角色交替，shujuku 更高级，作者钦定）。
  if (typeof raw !== "string") return "strict";
  const normalized = raw.trim();
  if (normalized === "") return "";
  return (PROMPT_POST_PROCESSING as readonly string[]).includes(normalized) ? normalized : "strict";
}

/** API 连接预设：连接资料的唯一载体（不含提示词）。 */
export interface AtlasApiConnectionPreset {
  id: string;
  name: string;
  connectionMode?: AtlasConnectionMode;
  endpoint: string;
  model: string;
  /** 只持久化；GET 回明文供编辑器回填（0.9.12 作者令）。 */
  apiKey: string;
  maxTokens: number;
  temperature: number;
  /** top_p（0.9.14 全抄 shujuku；0..1）。 */
  topP: number;
  timeoutMs: number;
  /** 接口协议；缺省 openai。 */
  apiFormat?: AtlasApiFormat;
  /** 酒馆连接预设模式的 profile id。 */
  profileId?: string;
  /** 附加请求体参数（custom_include_body，JSON / YAML object 文本）。 */
  bodyParams?: string;
  /** 排除请求体字段（custom_exclude_body，逗号 / 换行分隔字段名）。 */
  excludeBodyParams?: string;
  /** 附加请求标头（每行 Header: Value，追加在 Authorization 之后）。 */
  requestHeaders?: string;
  /** 提示词后处理（custom_prompt_post_processing）；"" = 不携带。 */
  promptPostProcessing?: string;
  /** 0.9.17 按连接覆盖的系统提示词（chatbox 同款「System Prompt（可选）」）；空 = 跟随「推进」页活动提示词预设 / 内置默认。 */
  systemPrompt?: string;
  updatedAt: number;
}

/** 提示词分段角色白名单（0.9.18 shujuku prompt-builder 同款三角色）。 */
export const PROMPT_SEGMENT_ROLES = ["system", "user", "assistant"] as const;
export type AtlasPromptSegmentRole = (typeof PROMPT_SEGMENT_ROLES)[number];

/** 提示词分段（0.9.18 长段多角色预设；0.9.25 升级 shujuku promptGroup 栏位段）：
 *  正文支持 $1/$5/$6/$7/$8/$9/$U/$C 与旧 {{...}} 占位符；name / mainSlot("A"|"B") / deletable 为 shujuku 栏位字段。 */
export interface AtlasPromptSegment {
  role: AtlasPromptSegmentRole;
  content: string;
  /** 栏位显示名（shujuku promptGroup segment.name；缺省 = 未命名栏位）。 */
  name?: string;
  /** 主槽位标记（shujuku mainSlot A/B；仅 UI 语义，发送顺序仍按数组序）。 */
  mainSlot?: "A" | "B" | "";
  deletable?: boolean;
}

export const MAX_PROMPT_SEGMENTS = 16;

/** 分段归一化：角色白名单小写归一、内容 trim、空段丢弃、超限截断；非法输入 → 空数组（回退单提示词模式）。
 *  0.9.25：保留 shujuku 栏位字段 name / mainSlot / deletable（可选，形状不对即丢弃）。 */
export function normalizePromptSegments(raw: unknown): AtlasPromptSegment[] {
  if (!Array.isArray(raw)) return [];
  const segments: AtlasPromptSegment[] = [];
  for (const entry of raw.slice(0, MAX_PROMPT_SEGMENTS * 2)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role.trim().toLowerCase() : "";
    if (!(PROMPT_SEGMENT_ROLES as readonly string[]).includes(role)) continue;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (!content) continue;
    if (segments.length >= MAX_PROMPT_SEGMENTS) break;
    const segment: AtlasPromptSegment = { role: role as AtlasPromptSegmentRole, content: content.slice(0, MAX_PROMPT_CHARS) };
    if (typeof record.name === "string" && record.name.trim()) segment.name = record.name.trim().slice(0, 64);
    if (record.mainSlot === "A" || record.mainSlot === "B" || record.mainSlot === "") {
      segment.mainSlot = record.mainSlot;
    }
    if (record.deletable === false) segment.deletable = false;
    segments.push(segment);
  }
  return segments;
}

/** 提示词预设：单提示词（systemPrompt）或分段预设（segments 非空，优先生效）。 */
export interface AtlasPromptPreset {
  id: string;
  name: string;
  systemPrompt: string;
  /** 0.9.18 分段模式：非空时取代 systemPrompt 单条（引擎逐段装配 + 占位符替换）。 */
  segments?: AtlasPromptSegment[];
  /** 0.9.25 shujuku contextTurnCount：$7 前文上下文条数（1–10，缺省 3）。 */
  contextTurnCount?: number;
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
  /** 0.9.22 推演是否附带世界书资料块（被供应商审核拦截时的逃生门；缺省 true）。 */
  loreSupplementEnabled?: boolean;
  /** R06 推进输出协议："v2"（新封套，缺省）或 "v1"（旧契约逃生门）。 */
  worldTurnProtocol?: AtlasWorldTurnProtocol;
  /** 0.9.16 内容替换规则库（照抄 shujuku + 开关增强；字段缺失时补预制库）。 */
  contentReplaceRules?: AtlasContentReplaceRule[];
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
  /** E02：`prompt.migrate-legacy` 新建的兼容增量草稿 id / 名称（供 UI 预览跳转）。 */
  migratedPresetId?: string;
  migratedPresetName?: string;
  /** E02：新草稿里被改写的旧协议关键词（让作者看到改了什么；旧预设原文不受影响）。 */
  replacedKeywords?: string[];
}

export type AtlasSettingsCommand =
  | {
      action: "api.save";
      preset: {
        id?: string;
        name: string;
        connectionMode?: AtlasConnectionMode;
        endpoint: string;
        model: string;
        maxTokens: number;
        temperature: number;
        topP: number;
        timeoutMs: number;
        apiFormat?: AtlasApiFormat;
        profileId?: string;
        bodyParams?: string;
        excludeBodyParams?: string;
        requestHeaders?: string;
        promptPostProcessing?: string;
        systemPrompt?: string;
      };
      apiKeyMode: "keep" | "replace" | "clear";
      apiKey?: string;
    }
  | { action: "api.delete"; id: string }
  | { action: "api.activate"; id: string | null }
  | { action: "prompt.save"; preset: { id?: string; name: string; systemPrompt: string; segments?: AtlasPromptSegment[]; contextTurnCount?: number } }
  /**
   * E02：把作者自己保存的旧协议提示词预设**复制**成一份兼容增量草稿（新建预设 + 可选激活）。
   * 旧预设原文一字不改；命令返回新建预设的 id 与改写的旧关键词清单供 UI 预览。
   */
  | { action: "prompt.migrate-legacy"; id: string; activate?: boolean }
  | { action: "prompt.delete"; id: string }
  | { action: "prompt.activate"; id: string | null }
  | { action: "replace.save"; preset: { id?: string; name: string; start: string; end: string; enabled?: boolean } }
  | { action: "replace.delete"; id: string }
  | { action: "replace.reset" }
  | { action: "runtime.update"; autoCommit?: boolean; rpmLimit?: number; loreSupplementEnabled?: boolean; worldTurnProtocol?: AtlasWorldTurnProtocol };

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
  topP: number;
  timeoutMs: number;
}): string {
  return [input.endpoint, input.model, input.apiKey, input.maxTokens, input.temperature, input.topP, input.timeoutMs].join("\u0000");
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
    loreSupplementEnabled: true,
    // R06 / D-16：推进输出协议。0.9.57 起**新装默认 = table-delta-v1**（三表行增量）；
    // 既有存档里的合法值原样保留（读取走 normalizeWorldTurnProtocol，非法值仍归 v2）。
    worldTurnProtocol: DEFAULT_WORLD_TURN_PROTOCOL,
    contentReplaceRules: DEFAULT_CONTENT_REPLACE_RULES.map((rule, index) => ({
      ...rule,
      id: `cr-builtin-${index + 1}`,
    })),
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
  const connectionMode = normalizeConnectionMode(record.connectionMode);
  // main / profile 模式不走自定义端点：endpoint / model 允许为空（0.9.13 照抄 shujuku 连接方式）
  const endpointOk =
    connectionMode !== "custom" ||
    (typeof record.endpoint === "string" && record.endpoint.length <= MAX_ENDPOINT_CHARS && isHttpUrl(record.endpoint));
  if (!endpointOk) return null;
  const modelOk =
    connectionMode !== "custom" ||
    (typeof record.model === "string" && !!record.model.trim() && record.model.length <= MAX_MODEL_CHARS);
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
    ...(normalizeApiFormat(record.apiFormat) !== "openai" ? { apiFormat: normalizeApiFormat(record.apiFormat) } : {}),
    ...(typeof record.profileId === "string" && record.profileId.trim() ? { profileId: record.profileId.trim().slice(0, 128) } : {}),
    ...(typeof record.bodyParams === "string" && record.bodyParams.trim() ? { bodyParams: record.bodyParams.slice(0, 4000) } : {}),
    ...(typeof record.excludeBodyParams === "string" && record.excludeBodyParams.trim() ? { excludeBodyParams: record.excludeBodyParams.slice(0, 2000) } : {}),
    ...(typeof record.requestHeaders === "string" && record.requestHeaders.trim() ? { requestHeaders: record.requestHeaders.slice(0, 2000) } : {}),
    ...(typeof record.promptPostProcessing === "string" ? { promptPostProcessing: normalizePromptPostProcessing(record.promptPostProcessing) } : {}),
    ...(typeof record.systemPrompt === "string" && record.systemPrompt.trim() ? { systemPrompt: record.systemPrompt.slice(0, MAX_PROMPT_CHARS) } : {}),
  };
}

function parsePromptPreset(raw: unknown): { id: string; name: string; systemPrompt: string; segments?: AtlasPromptSegment[] } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = normalizeId(record.id);
  if (!id || id === BUILTIN_PROMPT_PRESET_ID) return null;
  if (typeof record.name !== "string" || !record.name.trim() || record.name.length > MAX_NAME_CHARS) return null;
  // Older segment-only presets did not always persist a systemPrompt field.
  // Accept the missing field when there are valid segments, preserving the text.
  if (record.systemPrompt != null && typeof record.systemPrompt !== "string") return null;
  const prompt = typeof record.systemPrompt === "string" ? record.systemPrompt.trim() : "";
  const segments = normalizePromptSegments(record.segments);
  if ((!prompt || prompt.length > MAX_PROMPT_CHARS) && segments.length === 0) return null;
  return {
    id,
    name: record.name.trim(),
    systemPrompt: prompt.slice(0, MAX_PROMPT_CHARS),
    ...(segments.length > 0 ? { segments } : {}),
    ...(normalizeContextTurnCount(record.contextTurnCount) !== null
      ? { contextTurnCount: normalizeContextTurnCount(record.contextTurnCount)! }
      : {}),
  };
}

/** 0.9.25 shujuku contextTurnCount 归一：1–10 整数；非法 → null（缺省 3）。 */
function normalizeContextTurnCount(raw: unknown): number | null {
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(value)) return null;
  const truncated = Math.trunc(value);
  return truncated >= 1 && truncated <= 10 ? truncated : null;
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
    loreSupplementEnabled: typeof record.loreSupplementEnabled === "boolean" ? record.loreSupplementEnabled : true,
    // R06：推进协议（非法值 → 缺省 v2）
    worldTurnProtocol: normalizeWorldTurnProtocol(record.worldTurnProtocol),
  };
  // 0.9.16 内容替换规则：字段缺失（旧存档）→ 预制库兜底；显式空数组 = 用户全删，尊重
  if (record.contentReplaceRules === undefined) {
    settings.contentReplaceRules = base.contentReplaceRules;
  } else {
    settings.contentReplaceRules = normalizeContentReplaceRules(record.contentReplaceRules);
  }
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
  topP: number;
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
  return { name: record.name.trim(), endpoint: record.endpoint, model: record.model.trim(), apiKey, maxTokens, temperature, topP: 0.95, timeoutMs, systemPrompt };
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
        topP: legacy.topP,
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
  if (typeof record.loreSupplementEnabled === "boolean") settings.loreSupplementEnabled = record.loreSupplementEnabled;
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
      const connectionMode = normalizeConnectionMode(preset.connectionMode);
      if (typeof preset.name !== "string" || !preset.name.trim() || preset.name.length > MAX_NAME_CHARS) {
        return fail(settings, "INVALID_PAYLOAD", "连接名称必填且不超过 64 字。");
      }
      // main / profile 模式不走自定义端点：endpoint / model 仅 custom 必填（0.9.13 照抄 shujuku）
      if (connectionMode === "custom") {
        if (typeof preset.endpoint !== "string" || preset.endpoint.length > MAX_ENDPOINT_CHARS || !isHttpUrl(preset.endpoint)) {
          return fail(settings, "INVALID_PAYLOAD", "端点必须是 http(s) 绝对地址。");
        }
        if (typeof preset.model !== "string" || !preset.model.trim() || preset.model.length > MAX_MODEL_CHARS) {
          return fail(settings, "INVALID_PAYLOAD", "模型名必填且不超过 128 字。");
        }
      } else if (connectionMode === "profile" && !(typeof preset.profileId === "string" && !!preset.profileId.trim())) {
        return fail(settings, "INVALID_PAYLOAD", "酒馆连接预设模式需要选择连接预设。");
      }
      if (typeof preset.bodyParams === "string" && preset.bodyParams.length > 4000) {
        return fail(settings, "INVALID_PAYLOAD", "附加请求体参数不超过 4000 字。");
      }
      if (typeof preset.excludeBodyParams === "string" && preset.excludeBodyParams.length > 2000) {
        return fail(settings, "INVALID_PAYLOAD", "排除请求体字段不超过 2000 字。");
      }
      if (typeof preset.requestHeaders === "string" && preset.requestHeaders.length > 2000) {
        return fail(settings, "INVALID_PAYLOAD", "附加请求标头不超过 2000 字。");
      }
      if (typeof preset.systemPrompt === "string" && preset.systemPrompt.length > MAX_PROMPT_CHARS) {
        return fail(settings, "INVALID_PAYLOAD", `System Prompt 不超过 ${MAX_PROMPT_CHARS} 字。`);
      }
      if (!isFiniteIntIn(preset.maxTokens, MIN_MAX_TOKENS, MAX_MAX_TOKENS)) {
        return fail(settings, "INVALID_PAYLOAD", `最大回复长度必须是 ${MIN_MAX_TOKENS}..${MAX_MAX_TOKENS} 的整数。`);
      }
      if (!isFiniteIn(preset.temperature, MIN_TEMPERATURE, MAX_TEMPERATURE)) {
        return fail(settings, "INVALID_PAYLOAD", `温度必须在 ${MIN_TEMPERATURE}..${MAX_TEMPERATURE}。`);
      }
      if (!isFiniteIn(preset.topP, MIN_TOP_P, MAX_TOP_P)) {
        return fail(settings, "INVALID_PAYLOAD", `top_p 必须在 ${MIN_TOP_P}..${MAX_TOP_P}。`);
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
      // 新建 ID：规格 0.4 规则 1 —— 优先 randomUUID（resolveId 内含碰撞兜底）；
      // 同毫秒内「删除→再新建同长度」用 now+length 会撞 ID（复核发现）
      const entry: AtlasApiConnectionPreset = {
        id: targetId ?? resolveId("api", settings.apiPresets.length, fingerprintOfConnection({
          endpoint: preset.endpoint, model: preset.model, apiKey, maxTokens: preset.maxTokens, temperature: preset.temperature, topP: preset.topP, timeoutMs: preset.timeoutMs,
        }), deps, new Set(settings.apiPresets.map((p) => p.id))),
        name: uniqueName(preset.name, usedApiNames),
        ...(connectionMode !== "custom" ? { connectionMode } : {}),
        endpoint: preset.endpoint,
        model: preset.model.trim(),
        apiKey,
        maxTokens: preset.maxTokens,
        temperature: preset.temperature,
        topP: preset.topP,
        timeoutMs: preset.timeoutMs,
        ...(normalizeApiFormat(preset.apiFormat) !== "openai" ? { apiFormat: normalizeApiFormat(preset.apiFormat) } : {}),
        ...(connectionMode === "profile" && typeof preset.profileId === "string" && preset.profileId.trim() ? { profileId: preset.profileId.trim().slice(0, 128) } : {}),
        ...(typeof preset.bodyParams === "string" && preset.bodyParams.trim() ? { bodyParams: preset.bodyParams.slice(0, 4000) } : {}),
        ...(typeof preset.excludeBodyParams === "string" && preset.excludeBodyParams.trim() ? { excludeBodyParams: preset.excludeBodyParams.slice(0, 2000) } : {}),
        ...(typeof preset.requestHeaders === "string" && preset.requestHeaders.trim() ? { requestHeaders: preset.requestHeaders.slice(0, 2000) } : {}),
        ...(typeof preset.promptPostProcessing === "string" ? { promptPostProcessing: normalizePromptPostProcessing(preset.promptPostProcessing) } : {}),
        ...(typeof preset.systemPrompt === "string" && preset.systemPrompt.trim() ? { systemPrompt: preset.systemPrompt.trim().slice(0, MAX_PROMPT_CHARS) } : {}),
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
      // 0.9.18 分段模式：segments 非空时正文可为空（分段取代单提示词）；两者都空才拒绝
      const segments = normalizePromptSegments(preset.segments);
      if (!text && segments.length === 0) return fail(settings, "INVALID_PAYLOAD", "提示词正文不能为空（空 = 内置默认，无需保存；分段预设请至少给出 1 段）。");
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
        id: targetId ?? resolveId("prompt", settings.promptPresets.length, text, deps, new Set(settings.promptPresets.map((p) => p.id))),
        name: uniqueName(preset.name, usedNames),
        systemPrompt: text,
        ...(segments.length > 0 ? { segments } : {}),
        ...(normalizeContextTurnCount(preset.contextTurnCount) !== null
          ? { contextTurnCount: normalizeContextTurnCount(preset.contextTurnCount)! }
          : {}),
        updatedAt: now,
      };
      const promptPresets = existingIndex >= 0
        ? settings.promptPresets.map((p, i) => (i === existingIndex ? entry : p))
        : [...settings.promptPresets, entry];
      return { ok: true, settings: { ...settings, promptPresets } };
    }
    case "prompt.migrate-legacy": {
      /**
       * E02：为作者保存的旧协议预设**新建**一份兼容增量草稿。
       * - 旧预设原样保留（不删、不改、不做静默字符串替换）；
       * - 新预设 = 内置六段行增量协议 + 原预设摘录（旧关键词只在新草稿里改写）；
       * - 名称为「原名（增量兼容草稿）」，重名自动加序号；
       * - `activate=true` 时把新预设设为活动预设（作者显式选择才切，不擅自替换）。
       */
      const id = normalizeId(command.id);
      if (!id) return fail(settings, "INVALID_PAYLOAD", "预设 ID 形状非法。");
      const source = settings.promptPresets.find((p) => p.id === id);
      if (!source) return fail(settings, "INVALID_PAYLOAD", "要迁移的提示词预设不存在。");
      const built = buildTableDeltaCompatiblePrompt(source);
      if (settings.promptPresets.length >= MAX_PRESETS_PER_LIBRARY) {
        return fail(settings, "FIELD_LIMIT_EXCEEDED", `最多保存 ${MAX_PRESETS_PER_LIBRARY} 条提示词预设；请先删除一条再迁移。`);
      }
      const usedNames = new Set(settings.promptPresets.map((p) => p.name));
      const entry: AtlasPromptPreset = {
        id: resolveId("prompt", settings.promptPresets.length, `${built.name}:${built.systemPrompt}`, deps, new Set(settings.promptPresets.map((p) => p.id))),
        name: uniqueName(built.name, usedNames),
        systemPrompt: built.systemPrompt,
        segments: built.segments,
        updatedAt: now,
      };
      return {
        ok: true,
        settings: {
          ...settings,
          promptPresets: [...settings.promptPresets, entry],
          ...(command.activate === true ? { activePromptPresetId: entry.id } : {}),
        },
        migratedPresetId: entry.id,
        migratedPresetName: entry.name,
        replacedKeywords: built.replacedKeywords,
      };
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
      if (command.loreSupplementEnabled !== undefined) {
        if (typeof command.loreSupplementEnabled !== "boolean") return fail(settings, "INVALID_PAYLOAD", "世界书资料开关必须是布尔值。");
        next.loreSupplementEnabled = command.loreSupplementEnabled;
      }
      if (command.worldTurnProtocol !== undefined) {
        /**
         * E01：`runtime.update` **只接受** `table-delta-v1`——想切回 v1/v2 的写请求明确拒绝。
         * 这不是把用户的旧设置「改掉」：存储里的旧值只有在下一次显式写入成功时才更新，
         * 读取视图始终把旧值报告为 `legacyWorldTurnProtocol`（历史设置已升级为表格增量）。
         */
        if (command.worldTurnProtocol !== "table-delta-v1") {
          return fail(settings, "INVALID_PAYLOAD", "推进协议只能是 table-delta-v1；旧 v1/v2 输出已在读取时自动升级为表格增量，请到「推进」页用「创建兼容增量草稿」迁移旧预设。");
        }
        next.worldTurnProtocol = command.worldTurnProtocol;
      }
      if (command.rpmLimit !== undefined) {
        if (!isFiniteIntIn(command.rpmLimit, MIN_RPM, MAX_RPM)) {
          return fail(settings, "INVALID_PAYLOAD", `RPM 上限必须是 ${MIN_RPM}..${MAX_RPM} 的整数。`);
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
        return fail(settings, "INVALID_PAYLOAD", "规则名称、开始词、结束词都不能为空。");
      }
      const enabled = preset.enabled !== false;
      const rules = [...(settings.contentReplaceRules ?? [])];
      const targetId = preset.id === undefined ? null : normalizeId(preset.id);
      if (preset.id !== undefined && targetId === null) {
        return fail(settings, "INVALID_PAYLOAD", "规则 ID 形状非法。");
      }
      const existingIndex = targetId ? rules.findIndex((r) => r.id === targetId) : -1;
      if (preset.id !== undefined && existingIndex < 0) {
        return fail(settings, "INVALID_PAYLOAD", "要编辑的规则不存在（另存请省略 id）。");
      }
      if (existingIndex < 0 && rules.length >= MAX_REPLACE_RULES) {
        return fail(settings, "FIELD_LIMIT_EXCEEDED", `最多保存 ${MAX_REPLACE_RULES} 条替换规则。`);
      }
      const rule: AtlasContentReplaceRule = { id: targetId ?? generateId(), name, start, end, enabled };
      if (existingIndex >= 0) rules[existingIndex] = rule;
      else rules.push(rule);
      return { ok: true, settings: { ...settings, contentReplaceRules: rules } };
    }
    case "replace.delete": {
      const targetId = normalizeId(command.id);
      if (!targetId) return fail(settings, "INVALID_PAYLOAD", "规则 ID 形状非法。");
      const rules = (settings.contentReplaceRules ?? []).filter((r) => r.id !== targetId);
      if (rules.length === (settings.contentReplaceRules ?? []).length) {
        return fail(settings, "INVALID_PAYLOAD", "要删除的规则不存在。");
      }
      return { ok: true, settings: { ...settings, contentReplaceRules: rules } };
    }
    case "replace.reset": {
      return { ok: true, settings: { ...settings, contentReplaceRules: createDefaultSettingsV2().contentReplaceRules } };
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
      maxTokens: p.maxTokens, temperature: p.temperature, topP: typeof p.topP === "number" ? p.topP : 0.95, timeoutMs: p.timeoutMs,
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
  if (record.loreSupplementEnabled !== undefined) {
    if (typeof record.loreSupplementEnabled !== "boolean") return fail(settings, "INVALID_PAYLOAD", "loreSupplementEnabled 必须是布尔值");
    next = { ...next, loreSupplementEnabled: record.loreSupplementEnabled };
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
    connectionMode: AtlasConnectionMode;
    endpoint: string;
    model: string;
    maxTokens: number;
    temperature: number;
    topP: number;
    timeoutMs: number;
    apiFormat: AtlasApiFormat;
    profileId: string;
    bodyParams: string;
    excludeBodyParams: string;
    requestHeaders: string;
    promptPostProcessing: string;
    systemPrompt: string;
    /**
     * 0.9.12（作者令，照抄 shujuku）：GET 返回明文密钥供编辑器回填与测试连接复用——
     * 密钥本就存在作者自己的浏览器存储里。
     * 0.9.48（T07）：该语义以 GET /settings 的 local 闸为前提（非本机/非 admin 403）；
     * hasApiKey / apiKeyLast4 为 UI 尾号展示而设，未保存时 hasApiKey=false 且 apiKey=""。
     */
    apiKey: string;
    hasApiKey: boolean;
    apiKeyLast4: string;
  }>;
  promptPresets: AtlasPromptPreset[];
  activeApiPresetId: string | null;
  activePromptPresetId: string | null;
  /** 0.9.40 内置默认带全套分段（只读展示）：推进页能直接看到 8 段多轮结构 */
  builtInPrompt: {
    id: string;
    name: string;
    readOnly: true;
    systemPrompt: string;
    segments: Array<{ role: string; name: string; mainSlot?: string; content: string }>;
  };
  autoCommit: boolean;
  /** 0.9.22 推演是否附带世界书资料块（审核拦截逃生门）。 */
  loreSupplementEnabled: boolean;
  /** R06 推进输出协议（E01 起运行时恒为 `table-delta-v1`）。 */
  worldTurnProtocol: AtlasWorldTurnProtocol;
  /**
   * E01：持久层里保存的旧协议值（`"v1"` / `"v2"`）；null = 无需升级提示。
   * UI 据此显示「历史设置已升级为表格增量」，且**不擅自覆盖**用户原始设置。
   */
  legacyWorldTurnProtocol: AtlasLegacyWorldTurnProtocolNotice | null;
  rpmLimit: number;
  /** 0.9.16 内容替换规则库（含预制 + 手动，同库平等）。 */
  contentReplaceRules: AtlasContentReplaceRule[];
}

/**
 * E01：持久层原始协议值 → 读取视图的旧值诊断（null = 没有需要升级的历史值）。
 * 只读，不改写：`settings.worldTurnProtocol` 原样留在存储里。
 */
export function legacyWorldTurnProtocolNotice(
  stored: unknown,
): AtlasLegacyWorldTurnProtocolNotice | null {
  if (stored !== "v1" && stored !== "v2") return null;
  return {
    storedValue: stored,
    effectiveValue: "table-delta-v1",
    message: `历史设置已升级为表格增量：存储里保存的是旧「${stored}」协议，`
      + "运行时只走 table-delta-v1（一个 <atlasEdit> 块、块内每行一个独立 JSON）。"
      + "原始设置与旧提示词预设都未被改写；如需继续用旧预设，请到「推进」页点「创建兼容增量草稿」。",
  };
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
        // （0.9.48 起以 GET local 闸为前提；hasApiKey/apiKeyLast4 供 UI 尾号展示）
        apiKey: key,
        hasApiKey: key.length > 0,
        apiKeyLast4: key.slice(-4),
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
      // R06：内置默认按当前协议展示对应分段（v2 = 封套 / table-delta-v1 = 行增量 / v1 = 旧契约逃生门）
      segments: defaultSegmentsForProtocol(normalizeWorldTurnProtocol(settings.worldTurnProtocol)).map((s) => ({ ...s })),
    },
    autoCommit: settings.autoCommit,
    loreSupplementEnabled: settings.loreSupplementEnabled ?? true,
    worldTurnProtocol: normalizeWorldTurnProtocol(settings.worldTurnProtocol),
    // E01：旧值诊断——让作者看到「历史设置已升级为表格增量」，且原始设置未被改写
    legacyWorldTurnProtocol: legacyWorldTurnProtocolNotice(settings.worldTurnProtocol),
    rpmLimit: settings.rpmLimit,
    contentReplaceRules: settings.contentReplaceRules ?? [],
  };
}

/**
 * 运行时组合：活动 API 连接 + 活动提示词 → 现有 AtlasApiPreset。
 * 未配置活动 API → null（提交必须报 API_NOT_CONFIGURED，零 fetch）。
 * systemPrompt 优先级（0.9.17 chatbox 同款 + 0.9.18 分段）：连接级 System Prompt（可选）>
 * 「推进」页活动提示词预设分段模式（segments）> 单条 systemPrompt > 空（DEFAULT_WORLD_TURN_SYSTEM_PROMPT 兜底）。
 */
export function resolveWorldTurnPreset(settings: AtlasServerSettingsV2): AtlasApiPreset | null {
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
    ...(mode !== "custom" ? { connectionMode: mode } : {}),
    ...(format !== "openai" ? { apiFormat: format } : {}),
    ...(mode === "profile" && connection.profileId ? { profileId: connection.profileId } : {}),
    ...(connection.bodyParams ? { bodyParams: connection.bodyParams } : {}),
    ...(connection.excludeBodyParams ? { excludeBodyParams: connection.excludeBodyParams } : {}),
    ...(connection.requestHeaders ? { requestHeaders: connection.requestHeaders } : {}),
    ...(normalizePromptPostProcessing(connection.promptPostProcessing) ? { promptPostProcessing: normalizePromptPostProcessing(connection.promptPostProcessing) } : {}),
    // 0.9.18 systemPrompt 优先级：连接级覆盖 > 提示词预设分段模式 > 提示词预设单条 > 空（内置默认兜底）
    ...(connectionPrompt
      ? { systemPrompt: connectionPrompt }
      : prompt && prompt.segments && prompt.segments.length > 0
        ? { promptSegments: prompt.segments }
        : prompt
          ? { systemPrompt: prompt.systemPrompt }
          : {}),
    // 0.9.25 shujuku contextTurnCount：$7 前文条数（预设级设置，缺省 3 由引擎侧兜底）
    ...(prompt?.contextTurnCount ? { contextTurnCount: prompt.contextTurnCount } : {}),
  };
}
