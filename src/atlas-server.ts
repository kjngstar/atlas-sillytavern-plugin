/**
 * atlas-server.ts — Atlas Server Plugin 纯 dispatch 核心。
 *
 * 边界（上级 README 第 4.4 / 7 / 11 节）：
 * - 所有端点逻辑在此集中，可被 node:test 以内存 store + mock fetch 完整覆盖；
 *   真实 Express 接线在 atlas-server-plugin/index.mjs（薄适配，不做业务）。
 * - 密钥只在 store 的 settings 文档与本模块的 Authorization 头中出现；
 *   任何响应 / 日志 / 错误只允许脱敏视图（maskPreset / serializeAtlasError）。
 * - prepare 零模型请求；一条最终回复的 commit 恰好 1 条请求；重复提交 0 条新请求。
 * - 每聊天串行队列：同聊天同一时刻至多一个在途 commit / retry。
 * - RPM 保护：超过窗口限额直接 API_RATE_LIMITED，不发请求。
 * - 写入全部经 store（node 实现为临时文件 + 原子替换）；失败零部分写入由
 *   共享 adoptPendingProposals 与 commitAtlasTurn 保证。
 */

import type { EntityRecord, World } from "../lib/world-schema.ts";
import { parseWorld } from "../lib/world-schema.ts";
import { adjudicateAtlasDraft } from "./atlas-adjudicate.ts";
import { settleNpcSchedules, mergeSettlementNotes } from "./atlas-schedule.ts";
import { applyContentReplaceRules } from "./atlas-content-replace.ts";
import { ledgerForBranch } from "../lib/world-ledger.ts";
import { appendDefinitionRevision } from "../lib/world-definition.ts";
import { hashString } from "../lib/world-cards.ts";
import { createCheckpoint, previewRestore, restoreAsPlayhead } from "../lib/world-checkpoint.ts";
import { resolveCharacterPosition } from "../lib/world-npc.ts";
import type {
  AtlasChatBinding,
  AtlasTurnCommitRequest,
  AtlasTurnReceipt,
} from "./atlas-contract.ts";
import {
  ATLAS_ERROR_CODES,
  ATLAS_LIMITS,
  AtlasError,
  atlasCommitIdempotencyKey,
  parseAtlasChatBinding,
  parseAtlasTurnCommitRequest,
  parseAtlasTurnPrepareRequest,
  toSerializedError,
  type SerializedAtlasError,
} from "./atlas-contract.ts";
import { computeAtlasRelevance, atlasTravelPreview } from "./atlas-relevance.ts";
import { prepareAtlasTurn, commitAtlasTurn } from "./atlas-turn.ts";
import { buildSubMapFromDraft, sanitizeMapDoc } from "./atlas-geo-apply.ts";
import { buildLorebookPlans } from "./atlas-lorebook.ts";
import {
  callAtlasWorldTurnApi,
  extractJsonObject,
  parseAtlasWorldTurnDraft,
  type AtlasApiPreset,
} from "./atlas-api-client.ts";
import {
  ATLAS_SETTINGS_SCHEMA_VERSION,
  applyLegacySettingsPatch,
  applySettingsCommand,
  createDefaultSettingsV2,
  migrateAtlasSettings,
  resolveWorldTurnPreset,
  sanitizeSettingsV2,
  settingsViewV2,
  type AtlasServerSettingsV2,
  type AtlasSettingsCommand,
} from "./atlas-settings.ts";

// ---------------------------------------------------------------------------
// 存储契约
// ---------------------------------------------------------------------------

/** 文档存储；node 实现为临时文件 + rename 原子替换（见 atlas-server-plugin/index.mjs）。 */
export interface AtlasDocumentStore {
  read(name: string): Promise<unknown | null>;
  write(name: string, value: unknown): Promise<void>;
  remove(name: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

/** 测试用内存实现。 */
export function createMemoryDocumentStore(): AtlasDocumentStore & { dump(): Map<string, unknown> } {
  const docs = new Map<string, unknown>();
  return {
    async read(name) {
      return docs.has(name) ? docs.get(name)! : null;
    },
    async write(name, value) {
      docs.set(name, value);
    },
    async remove(name) {
      docs.delete(name);
    },
    async list(prefix) {
      return [...docs.keys()].filter((name) => name.startsWith(prefix));
    },
    dump() {
      return docs;
    },
  };
}

// ---------------------------------------------------------------------------
// 设置（独立 API 预设；服务端保存，GET 只出脱敏视图）
// ---------------------------------------------------------------------------

/**
 * ATLAS-18：设置类型已迁移到 `src/atlas-settings.ts`（schemaVersion 2）。
 * 这里保留旧名作为类型别名，避免一次性改动所有引用点；结构以 v2 为准。
 */
export type AtlasServerSettings = AtlasServerSettingsV2;

const SETTINGS_DOC = "settings";
const RPM_WINDOW_MS = 60_000;


// ---------------------------------------------------------------------------
// 路由与错误映射
// ---------------------------------------------------------------------------

export const ATLAS_ROUTE_MANIFEST = [
  { method: "GET", path: "/health" },
  { method: "GET", path: "/settings" },
  { method: "PUT", path: "/settings" },
  { method: "GET", path: "/worlds" },
  { method: "POST", path: "/worlds/import" },
  { method: "POST", path: "/worlds/ensure-starter" },
  { method: "POST", path: "/worlds/geo/adopt" },
  { method: "POST", path: "/bindings" },
  { method: "GET", path: "/state/:chatId" },
  { method: "GET", path: "/map/image/:chatId" },
  { method: "POST", path: "/turns/prepare" },
  { method: "POST", path: "/turns/commit" },
  { method: "POST", path: "/turns/retry" },
  { method: "POST", path: "/turns/restore" },
  { method: "POST", path: "/turns/rollback" },
  { method: "POST", path: "/map/travel-preview" },
] as const;

/** 地图数据上限（有界结果；不返回完整世界）。 */
const MAP_POINTS_MAX = 200;
const MAP_POINT_NAME_CHARS = 80;

function httpStatusFor(code: string): number {
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

export interface AtlasRouteResult {
  status: number;
  body: unknown;
}

function okResult(data: unknown): AtlasRouteResult {
  return { status: 200, body: { ok: true, data } };
}

function errorResult(thrown: unknown): AtlasRouteResult {
  const error: SerializedAtlasError = toSerializedError(thrown);
  return { status: httpStatusFor(error.code), body: { ok: false, error } };
}

// ---------------------------------------------------------------------------
// 核心
// ---------------------------------------------------------------------------

export interface AtlasServerCoreDeps {
  store: AtlasDocumentStore;
  fetchFn?: typeof fetch;
  /** 毫秒时钟（默认 Date.now；测试注入固定时钟） */
  now?: () => number;
}

export interface AtlasRequestContext {
  /** 是否本机已登录会话（Express 侧由 SillyTavern 会话中间件判定） */
  local?: boolean;
}

interface StoredPendingCommit {
  request: AtlasTurnCommitRequest;
  binding: { branchId: string | null; currentPointId: string | null; currentRegionId: string | null; worldTimeCursor: number };
  savedAt: number;
}

export function createAtlasServerCore(deps: AtlasServerCoreDeps) {
  const store = deps.store;
  const now = deps.now ?? Date.now;

  let settings: AtlasServerSettingsV2 = createDefaultSettingsV2();
  let settingsLoaded = false;
  /** 迁移发生在读取路径上：不写 store；第一次成功设置写入时才持久化 v2（规格 0.5）。 */
  const worldCache = new Map<string, World | null>();
  const bindingCache = new Map<string, AtlasChatBinding | null>();
  const receiptCache = new Map<string, AtlasTurnReceipt>();
  const queues = new Map<string, Promise<unknown>>();
  const rpmTimestamps: number[] = [];
  const logs: Array<Record<string, unknown>> = [];

  function pushLog(entry: Record<string, unknown>): void {
    logs.push(entry);
    if (logs.length > 200) logs.shift();
  }

  /**
   * 惰性加载设置：识别 schemaVersion 2 与 v1。
   * - v2：sanitize（非法条目丢弃、悬挂引用归一为 null）。
   * - v1（或形状可疑的旧数据）：纯函数迁移，**不写 store**；首个成功写入时落库 v2。
   */
  async function loadSettings(): Promise<AtlasServerSettingsV2> {
    if (settingsLoaded) return settings;
    const raw = await store.read(SETTINGS_DOC);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
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
          skipped: migrated.diagnostics.skipped,
        });
      }
    }
    settingsLoaded = true;
    return settings;
  }

  /** 写入设置：先落 store，成功后替换内存（失败保持旧值——不留下半更新状态）。 */
  async function persistSettings(next: AtlasServerSettingsV2): Promise<AtlasServerSettingsV2> {
    await store.write(SETTINGS_DOC, next);
    settings = next;
    settingsLoaded = true;
    return settings;
  }

  async function getWorld(worldId: string): Promise<World | null> {
    if (worldCache.has(worldId)) return worldCache.get(worldId)!;
    const raw = await store.read(`world:${worldId}`);
    const world = raw ? parseWorld(raw) : null;
    worldCache.set(worldId, world);
    return world;
  }

  async function getBinding(chatId: string): Promise<AtlasChatBinding | null> {
    if (bindingCache.has(chatId)) return bindingCache.get(chatId)!;
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

  /** 分支作用域内、游标之前的 setFlag 键集合（触发器条件用）。 */
  function flagsFor(world: World, branchId: string | null, at: number): string[] {
    const flags: string[] = [];
    for (const event of ledgerForBranch(world, branchId)) {
      if (event.at > at) continue;
      for (const effect of event.effects) {
        if (effect.kind === "setFlag" && !flags.includes(effect.key)) flags.push(effect.key);
      }
    }
    return flags;
  }

  function requireBoundBinding(binding: AtlasChatBinding | null): AtlasChatBinding {
    if (!binding || !binding.enabled) {
      throw new AtlasError(ATLAS_ERROR_CODES.NOT_BOUND, "当前聊天未绑定 Atlas 世界。");
    }
    return binding;
  }

  async function requireWorld(binding: AtlasChatBinding): Promise<World> {
    const world = await getWorld(binding.worldId);
    if (!world) throw new AtlasError(ATLAS_ERROR_CODES.WORLD_NOT_FOUND, `绑定的世界不存在：${binding.worldId}`);
    return world;
  }

  function pointRegionId(world: World, pointId: string | null): string | null {
    if (!pointId) return null;
    return (world.points ?? []).find((p) => String(p.id) === String(pointId))?.regionId ?? null;
  }

  function checkRpm(): void {
    const { rpmLimit } = settings;
    const windowStart = now() - RPM_WINDOW_MS;
    while (rpmTimestamps.length > 0 && rpmTimestamps[0] < windowStart) rpmTimestamps.shift();
    if (rpmTimestamps.length >= rpmLimit) {
      throw new AtlasError(ATLAS_ERROR_CODES.API_RATE_LIMITED, `推演请求超过每分钟 ${rpmLimit} 次限额，请稍后再试。`);
    }
  }

  /** 每聊天串行队列：同聊天 commit / retry 逐个执行，不并发冲击。 */
  function enqueue<T>(chatId: string, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(chatId) ?? Promise.resolve();
    const next = previous.then(task, task);
    queues.set(
      chatId,
      next.catch(() => undefined),
    );
    return next;
  }

  // -------------------------------------------------------------------------
  // 路由处理
  // -------------------------------------------------------------------------

  async function handleHealth(): Promise<AtlasRouteResult> {
    return okResult({
      ok: true,
      plugin: "atlas",
      // 0.9.18 起与 ATLAS_PLUGIN_VERSION 同步（此前自 0.9.2 起一直烂着没人查——
      // tests/atlas-server-plugin.test.mjs 的 health 版本一致性断言防再犯）
      version: "0.9.33",
      protocolVersion: 1,
      time: now(),
    });
  }

  async function handleGetSettings(): Promise<AtlasRouteResult> {
    const current = await loadSettings();
    // ATLAS-18：唯一脱敏视图（两库 + 两个活动引用 + 内置提示词只读全文）；绝不含明文 Key。
    return okResult(settingsViewV2(current));
  }

  /**
   * PUT /settings：
   * - 新形态 = **命令**（带 action 字段）：校验 → 生成全新 next 快照 → 写 store → 成功后才替换缓存。
   * - 兼容形态 = v1 部分更新载荷（worldTurn / presetLibrary / autoCommit / rpmLimit）：
   *   立即按 v2 语义迁移应用（不保留组合式存储），并在同一次写入里落库 v2。
   */
  async function handlePutSettings(body: unknown, ctx: AtlasRequestContext): Promise<AtlasRouteResult> {
    if (!ctx.local) throw new AtlasError(ATLAS_ERROR_CODES.FORBIDDEN, "只有本机已登录会话可以修改 Atlas 设置。");
    const current = await loadSettings();
    const isCommand = Boolean(body) && typeof body === "object" && !Array.isArray(body) &&
      typeof (body as { action?: unknown }).action === "string";
    const result = isCommand
      ? applySettingsCommand(current, body as AtlasSettingsCommand, { now })
      : applyLegacySettingsPatch(current, body, { now });
    if (!result.ok) {
      throw new AtlasError(
        (result.code === "FIELD_LIMIT_EXCEEDED" ? ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED : ATLAS_ERROR_CODES.INVALID_PAYLOAD),
        result.message ?? "设置更新被拒绝。",
      );
    }
    const saved = await persistSettings(result.settings);
    if (!isCommand) {
      pushLog({ at: now(), kind: "settings-legacy-patch", apiPresets: saved.apiPresets.length });
    }
    return okResult(settingsViewV2(saved));
  }

  function worldSummary(world: World): Record<string, unknown> {
    return {
      id: world.id,
      name: world.name,
      pointCount: (world.points ?? []).length,
      regionCount: (world.regions ?? []).length,
      characterCount: (world.characters ?? []).length,
      branchCount: (world.stories ?? []).length,
      updatedAt: world.updatedAt,
    };
  }

  async function handleListWorlds(): Promise<AtlasRouteResult> {
    const names = await store.list("world:");
    const summaries: Record<string, unknown>[] = [];
    for (const name of names.slice(0, 200)) {
      const worldId = name.slice("world:".length);
      const world = await getWorld(worldId);
      if (world) summaries.push(worldSummary(world));
    }
    return okResult({ worlds: summaries });
  }

  async function handleImportWorld(body: unknown, ctx: AtlasRequestContext): Promise<AtlasRouteResult> {
    if (!ctx.local) throw new AtlasError(ATLAS_ERROR_CODES.FORBIDDEN, "只有本机已登录会话可以导入 Atlas 世界。");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "导入请求必须是对象");
    }
    const parsed = parseWorld((body as Record<string, unknown>).world);
    if (!parsed) throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "世界数据无法通过 schema 校验，已拒绝导入。");
    await store.write(`world:${parsed.id}`, parsed);
    worldCache.set(parsed.id, parsed);
    return okResult(worldSummary(parsed));
  }

  /**
   * ATLAS-18：确定性建世端点（规格 0.9）。
   * 与 `/worlds/import` 的区别 = **幂等且绝不覆盖**：同 id 世界已存在时只回报 created:false。
   * 建世本身零模型调用；只有后续正常 commit 才推演。
   */
  async function handleEnsureStarter(body: unknown, ctx: AtlasRequestContext): Promise<AtlasRouteResult> {
    if (!ctx.local) throw new AtlasError(ATLAS_ERROR_CODES.FORBIDDEN, "只有本机已登录会话可以初始化 Atlas 世界。");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "ensure-starter 请求必须是对象");
    }
    const parsed = parseWorld((body as Record<string, unknown>).world);
    if (!parsed) throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "自动建世数据无法通过 schema 校验，已拒绝。");
    // 同一 world.id 串行（复用每实体队列）：并发首条消息只创建一个世界
    return enqueue(`ensure:${parsed.id}`, async () => {
      const existing = await getWorld(parsed.id);
      if (existing) {
        return okResult({ created: false, world: worldSummary(existing) });
      }
      await store.write(`world:${parsed.id}`, parsed);
      worldCache.set(parsed.id, parsed);
      return okResult({ created: true, world: worldSummary(parsed) });
    });
  }

  /** 0.9.24 世界书提炼地理上限（宁缺毋滥；坐标自动环形布点避免重叠）。 */
  const GEO_LIMITS = { REGIONS_MAX: 12, POINTS_MAX: 40, NAME_CHARS: 40, DESC_CHARS: 300 } as const;

  /**
   * POST /worlds/geo/adopt — 从世界书资料 / 近期剧情提炼地理并原子并入世界（0.9.24 / 0.9.26）。
   * 恰好 1 条推演请求（复用推演预设 + 救场逻辑）；重名跳过；成功后追加定义修订。
   * 产出只增不改：绝不删除 / 改写已有地区与地点。
   * 0.9.26 地图抢救：新增剧情模式——recentTexts（近期 AI 楼层）非空时从剧情提炼新地点；
   * loreSupplement 仍可同时提供作背景。两者都空 → INVALID_PAYLOAD。
   */
  async function handleGeoAdopt(body: unknown): Promise<AtlasRouteResult> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "geo/adopt 请求必须是对象");
    }
    const record = body as Record<string, unknown>;
    const chatId = typeof record.chatId === "string" ? record.chatId : "";
    if (!chatId || chatId.length > ATLAS_LIMITS.ID_CHARS) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "chatId 非法");
    }
    const lore = typeof record.loreSupplement === "string" ? record.loreSupplement.trim() : "";
    // 0.9.26 剧情模式输入：宽容可选，形状不对 / 超界直接丢弃
    const recentTexts = Array.isArray(record.recentTexts)
      ? record.recentTexts
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .slice(0, 10)
          .map((item) => item.slice(0, 2000))
      : [];
    const storyMode = recentTexts.length > 0;
    if (!lore && !storyMode) {
      throw new AtlasError(
        ATLAS_ERROR_CODES.INVALID_PAYLOAD,
        "没有可用的提炼素材——剧情模式需要近期 AI 楼层，世界书模式需要卡书启用条目（或「世界书资料」开关未关闭）。",
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
        message: "没有提炼出新的地理实体（可能都已存在，或资料里没有地理描述）。",
      });
    }
    return okResult({
      regionsAdded: outcome.regionsAdded,
      pointsAdded: outcome.pointsAdded,
      skipped: outcome.skipped,
      revisionAppended: outcome.revisionAppended,
      regionNames: outcome.regionNames,
      pointNames: outcome.pointNames,
    });
  }

  /**
   * 0.9.31 提炼核心（手动 /worlds/geo/adopt 与首轮自动建图共用）：
   * 恰好 1 条推演请求（复用推演预设 + 救场逻辑）；重名跳过；黄金角螺旋布点；
   * 成功后原子写世界 + 追加定义修订。产出只增不改。
   */
  async function runGeoExtraction(input: {
    world: World;
    preset: NonNullable<ReturnType<typeof resolveWorldTurnPreset>>;
    lore: string;
    recentTexts: string[];
    source: "manual" | "auto";
  }): Promise<{
    regionsAdded: number;
    pointsAdded: number;
    skipped: number;
    revisionAppended: boolean;
    regionNames: string[];
    pointNames: string[];
  }> {
    const world = input.world;
    const preset = input.preset;
    const lore = input.lore;
    const recentTexts = input.recentTexts;
    const storyMode = recentTexts.length > 0;
    // 恰好 1 条推演请求：分段模式注入提炼指令（复用 callAtlasWorldTurnApi 的
    // 超时 / 救场 / 错误分类，不新开 fetch 路径）
    const contractRule =
      '只输出一个 JSON 对象：{"regions":[{"name":"...","description":"..."}],"points":[{"name":"...","regionName":"..."}]}';
    const commonRules =
      "规则：name ≤20 字；regionName 必须是 regions 里出现过的名字（没有合适地区就省略该字段）；只提炼明确或强烈暗示的地理实体（城市 / 森林 / 遗迹 / 建筑等），角色、文风、格式规则一律不要；宁缺毋滥；最多 12 个地区、40 个地点；没有地理信息就输出 {\"regions\":[],\"points\":[]}。";
    const existingGeoNames = [
      ...(world.regions ?? []).map((r) => String(r.name)),
      ...(world.points ?? []).map((p) => String(p.name)),
    ].slice(0, 60);
    const userContent = storyMode
      ? [
          "从下面的近期剧情中提炼**剧情里新出现或被明确抵达 / 提及**的地点与地区（已有地点名单里的不要重复输出）。",
          contractRule,
          commonRules,
          ...(existingGeoNames.length > 0 ? [`已有地理（禁止重复输出这些名字）：${existingGeoNames.join("、")}`] : []),
          ...(lore ? ["【世界书背景资料（帮助理解地名归属，不要从中提炼——只提炼剧情里的）】", lore.slice(0, ATLAS_LIMITS.LORE_SUPPLEMENT_CHARS)] : []),
          "【近期剧情（AI 输出，按时间先后）】",
          recentTexts.join("\n---\n").slice(0, ATLAS_LIMITS.LORE_SUPPLEMENT_CHARS),
        ].join("\n")
      : [
          "从下面的角色卡世界书资料中提炼「地区 / 地点」。",
          contractRule,
          commonRules,
          "【世界书资料】",
          lore.slice(0, ATLAS_LIMITS.LORE_SUPPLEMENT_CHARS),
        ].join("\n");
    const extractionSegments = [
      {
        role: "system",
        content: "你是地理信息抽取器。只输出一个 JSON 对象，不输出任何其它文字、解释或代码围栏。",
      },
      { role: "user", content: userContent },
    ];
    const call = await callAtlasWorldTurnApi(
      { ...preset, promptSegments: extractionSegments },
      { injectionText: "", userText: "", assistantText: "" },
      { fetchFn: deps.fetchFn, now },
    );
    pushLog({
      at: now(),
      kind: "world-geo-extract",
      presetName: preset.name,
      model: preset.model,
      ok: call.ok,
      status: call.status,
      durationMs: call.durationMs,
    });
    if (!call.ok) {
      throw new AtlasError(call.code, call.message, { retryable: call.retryable });
    }

    // 解析（不可信）：0.9.26 起复用推演输出的三层容错提取（围栏 / 括号配平 / 消毒）——
    // 提炼模型夹说明文字或截断 JSON 时能抢出结果；完全抢不出才报错
    const spec = extractJsonObject(call.text);
    if (!spec) {
      throw new AtlasError(ATLAS_ERROR_CODES.RESPONSE_MALFORMED, "提炼结果不是合法 JSON——模型没有遵守输出契约，可重试一次。", { retryable: true });
    }

    const cleanName = (value: unknown): string | null => {
      const text = String(value ?? "").trim().replace(/\s+/g, " ");
      return text ? text.slice(0, GEO_LIMITS.NAME_CHARS) : null;
    };
    const cleanDesc = (value: unknown): string =>
      String(value ?? "").trim().replace(/\s+/g, " ").slice(0, GEO_LIMITS.DESC_CHARS);
    const norm = (text: string) => text.toLowerCase();

    const existingRegionNames = new Set((world.regions ?? []).map((r) => norm(String(r.name))));
    const existingPointNames = new Set((world.points ?? []).map((p) => norm(String(p.name))));
    const regionIdByName = new Map((world.regions ?? []).map((r) => [norm(String(r.name)), String(r.id)]));
    let skipped = 0;

    const newRegions: Array<{ id: string; worldId: string; name: string; type: "other"; description: string; coordinates: { x: number; y: number } }> = [];
    for (const raw of (Array.isArray(spec.regions) ? spec.regions : []).slice(0, GEO_LIMITS.REGIONS_MAX + 8)) {
      if (newRegions.length >= GEO_LIMITS.REGIONS_MAX) break;
      const name = cleanName((raw as { name?: unknown })?.name);
      if (!name || existingRegionNames.has(norm(name)) || newRegions.some((r) => norm(r.name) === norm(name))) {
        skipped += 1;
        continue;
      }
      const id = `geo-r-${hashString(`${world.id}|r|${name}|${now()}`)}`;
      newRegions.push({ id, worldId: world.id, name, type: "other", description: cleanDesc((raw as { description?: unknown })?.description) || "由世界书提炼。", coordinates: { x: 0, y: 0 } });
      regionIdByName.set(norm(name), id);
    }

    let nextPointId = (world.points ?? []).reduce((max, p) => Math.max(max, Number(p.id) || 0), 0) + 1;
    const newPoints: Array<{ id: number; name: string; x: number; y: number; regionId?: string }> = [];
    for (const raw of (Array.isArray(spec.points) ? spec.points : []).slice(0, GEO_LIMITS.POINTS_MAX + 8)) {
      if (newPoints.length >= GEO_LIMITS.POINTS_MAX) break;
      const name = cleanName((raw as { name?: unknown })?.name);
      if (!name || existingPointNames.has(norm(name)) || newPoints.some((p) => norm(p.name) === norm(name))) {
        skipped += 1;
        continue;
      }
      const regionName = cleanName((raw as { regionName?: unknown })?.regionName);
      const regionId = (regionName ? regionIdByName.get(norm(regionName)) : null) ?? "start";
      // 黄金角螺旋布点：绕「起点」外圈散开，绝不与已有点重叠坐标
      const index = newPoints.length;
      const angle = index * 2.39996;
      const radius = 14 + 3.4 * Math.sqrt(index + 1);
      newPoints.push({
        id: nextPointId,
        name,
        x: Math.round(Math.min(96, Math.max(4, 50 + radius * Math.cos(angle)))),
        y: Math.round(Math.min(96, Math.max(4, 50 + radius * Math.sin(angle)))),
        regionId,
      });
      nextPointId += 1;
    }

    if (newRegions.length === 0 && newPoints.length === 0) {
      pushLog({ at: now(), kind: "world-geo-adopt", worldId: world.id, source: input.source, regionsAdded: 0, pointsAdded: 0, skipped });
      return { regionsAdded: 0, pointsAdded: 0, skipped, revisionAppended: false, regionNames: [], pointNames: [] };
    }

    let updated: World = {
      ...world,
      regions: [...(world.regions ?? []), ...newRegions],
      points: [...(world.points ?? []), ...newPoints],
      updatedAt: now(),
    };
    const revision = appendDefinitionRevision(updated, {
      authorNote: `${input.source === "auto" ? "首轮自动建图" : "世界书提炼地理"}：+${newRegions.length} 地区 +${newPoints.length} 地点`,
      now: now(),
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
      revisionAppended: revision.ok,
    });
    return {
      regionsAdded: newRegions.length,
      pointsAdded: newPoints.length,
      skipped,
      revisionAppended: revision.ok,
      regionNames: newRegions.map((r) => r.name),
      pointNames: newPoints.map((p) => p.name),
    };
  }

  async function handleBindings(body: unknown): Promise<AtlasRouteResult> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "绑定请求必须是对象");
    }
    const record = body as Record<string, unknown>;
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

  async function handleState(chatId: string): Promise<AtlasRouteResult> {
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
      flags: flagsFor(world, binding.branchId, binding.worldTimeCursor),
    });
    // 有界地图数据：静态世界结构（地点列表），不含世界书 / 记忆 / 账本
    const mapPoints = (world.points ?? []).slice(0, MAP_POINTS_MAX).map((p) => ({
      id: String(p.id),
      name: String(p.name).slice(0, MAP_POINT_NAME_CHARS),
      x: p.x,
      y: p.y,
      regionId: p.regionId ?? null,
    }));
    // 相关 NPC 位置目录（ATLAS-09 地图标记）：动态状态优先，旧档案回退；坐标 = 锚点地点坐标
    const pointById = new Map((world.points ?? []).map((p) => [String(p.id), p]));
    const npcDirectory = (world.characters ?? [])
      .filter((c) => relevance.relevantNpcIds.includes(String(c.id)))
      .slice(0, 48)
      .map((c) => {
        const pos = resolveCharacterPosition(world, String(c.id), { branchId: binding.branchId });
        const anchorPoint = pos.pointId !== null ? pointById.get(String(pos.pointId)) : undefined;
        return {
          id: String(c.id),
          name: String(c.name ?? c.id).slice(0, MAP_POINT_NAME_CHARS),
          pointId: pos.pointId,
          regionId: pos.regionId ?? (anchorPoint ? anchorPoint.regionId ?? null : null),
          x: anchorPoint ? anchorPoint.x : null,
          y: anchorPoint ? anchorPoint.y : null,
          reason: relevance.npcReasons[String(c.id)] ?? null,
        };
      });
    const regions = (world.regions ?? []).slice(0, 64).map((r) => ({
      id: String(r.id),
      name: String(r.name ?? r.id).slice(0, MAP_POINT_NAME_CHARS),
    }));
    // 地图物件标记（ATLAS-09）：带 mapAnchor 的非人物实体，坐标 = mapAnchor 自有坐标或锚点地点坐标
    const objectDirectory = (world.entityRecords ?? [])
      .filter((e: EntityRecord) => {
        if (String(e.type).toLowerCase() === "npc") return false;
        const anchor = e.mapAnchor;
        return Boolean(anchor && (anchor.pointId || anchor.regionId));
      })
      .slice(0, 32)
      .map((e: EntityRecord) => {
        const anchor = e.mapAnchor!;
        const anchorPoint = anchor.pointId ? pointById.get(String(anchor.pointId)) : undefined;
        return {
          id: String(e.id),
          name: String(e.name ?? e.id).slice(0, MAP_POINT_NAME_CHARS),
          type: String(e.type).slice(0, 32),
          pointId: anchor.pointId ?? null,
          regionId: anchor.regionId ?? (anchorPoint ? anchorPoint.regionId ?? null : null),
          x: typeof anchor.x === "number" ? anchor.x : anchorPoint ? anchorPoint.x : null,
          y: typeof anchor.y === "number" ? anchor.y : anchorPoint ? anchorPoint.y : null,
        };
      });
    // 最近一次时间推进：分支作用域内、游标之前的最后一条账本事件
    const branchEvents = ledgerForBranch(world, binding.branchId).filter((e) => e.at <= binding.worldTimeCursor);
    const lastEvent = branchEvents.at(-1) ?? null;
    const lastAdvance = lastEvent
      ? { at: lastEvent.at, summary: lastEvent.narrativeSummary.slice(0, 200), source: lastEvent.source }
      : null;
    // 0.9.32 地图 sidecar（点位描述 + 点挂子图）：独立文档，有界随 /state 下发
    const mapDoc = sanitizeMapDoc(await store.read(`maps:${world.id}`).catch(() => null));
    const pointMetaEntries = Object.entries(mapDoc.pointMeta).slice(0, 80);
    const submapEntries = Object.entries(mapDoc.submaps).slice(0, 40).map(([key, sub]) => ({
      pointId: key,
      scale: sub.scale ?? null,
      points: sub.points.slice(0, 40),
      pointCount: sub.points.length,
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
        submapCount: submapEntries.length,
      },
      npcDirectory,
      regions,
      objectDirectory,
      lastAdvance,
    });
  }

  /** 底图（base64 dataURL）；独立于 JSON API 的专用只读端点，避免撑爆 /state。 */
  async function handleMapImage(chatId: string): Promise<AtlasRouteResult> {
    if (!chatId || chatId.length > ATLAS_LIMITS.ID_CHARS) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "chatId 非法");
    }
    const binding = requireBoundBinding(await getBinding(chatId));
    const world = await requireWorld(binding);
    return okResult({ dataUrl: typeof world.mapImage === "string" ? world.mapImage : null });
  }

  async function handlePrepare(body: unknown): Promise<AtlasRouteResult> {
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
    const record = body as Record<string, unknown>;
    const destinationPointId = typeof record.destinationPointId === "string" && record.destinationPointId.trim()
      ? record.destinationPointId.trim().slice(0, ATLAS_LIMITS.ID_CHARS)
      : null;
    const output = prepareAtlasTurn(world, {
      request,
      currentTime: binding.worldTimeCursor,
      currentPointId: binding.currentLocationId ?? null,
      currentRegionId: pointRegionId(world, binding.currentLocationId ?? null),
      flags: flagsFor(world, binding.branchId, binding.worldTimeCursor),
      ...(destinationPointId ? { destinationPointId } : {}),
    });
    return okResult({
      response: output.response,
      npcReasons: output.npcReasons,
    });
  }

  /** commit / retry 共享的执行体：恰好 1 条 API 请求 + 原子提交。 */
  async function executeCommit(
    binding: AtlasChatBinding,
    request: AtlasTurnCommitRequest,
  ): Promise<AtlasRouteResult> {
    const world = await requireWorld(binding);
    const idempotencyKey = atlasCommitIdempotencyKey(request);

    // 1. 幂等：已提交过 → 沿用原回执内容，status 标记为 duplicate，0 fetch
    if (receiptCache.has(idempotencyKey)) {
      const cached = receiptCache.get(idempotencyKey);
      return okResult({ receipt: { ...cached, status: "duplicate" }, duplicate: true });
    }

    // 2. 未配置推演 API → 明确报错，不假装更新世界。
    //    ATLAS-07 旅程测试暴露的真 bug：这里曾直接读闭包 settings（初始 DEFAULT），
    //    服务重启后首个 commit 会误判「未配置」——必须经 loadSettings 从 store 惰性加载。
    const current = await loadSettings();
    // ATLAS-18：运行时由「活动 API 连接 + 活动提示词」组合，不再读组合式 worldTurn
    const preset = resolveWorldTurnPreset(current);
    if (!preset) {
      throw new AtlasError(ATLAS_ERROR_CODES.API_NOT_CONFIGURED, "未配置独立推演 API，世界不会更新。");
    }

    // 3. RPM 保护（超额 0 fetch）
    checkRpm();

    // 4. 本地重算 prepare（零 API）并保存 pending（供 retry 沿用原请求）
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
        recentMessageRefs: [],
      },
      currentTime: binding.worldTimeCursor,
      currentPointId,
      currentRegionId,
      flags,
    });

    const pending: StoredPendingCommit = {
      request,
      binding: {
        branchId: binding.branchId,
        currentPointId,
        currentRegionId,
        worldTimeCursor: binding.worldTimeCursor,
      },
      savedAt: now(),
    };
    await store.write(`pending:${idempotencyKey}`, pending);

    // 5. 恰好 1 条推演请求
    rpmTimestamps.push(now());
    // 0.9.25 shujuku 占位符体系上下文装配：
    // $6 上轮推演结果 = 绑定分支内、游标前最后一条账本摘要；$7 前文 = 最近 N 条 AI 楼层（shujuku 同款叙述格式）
    const branchEvents = ledgerForBranch(world, binding.branchId).filter((e) => e.at <= binding.worldTimeCursor);
    const lastLedgerEvent = branchEvents.at(-1) ?? null;
    const lastTurnSummary = lastLedgerEvent ? lastLedgerEvent.narrativeSummary.slice(0, 500) : "";
    // $7 前文条数 = 活动提示词预设的 contextTurnCount（shujuku plotSettings 同名设置；缺省 3，上限 10）
    const turnCount = Math.min(Math.max(typeof preset.contextTurnCount === "number" ? preset.contextTurnCount : 3, 1), 10);
    const recentAssistantTexts = (Array.isArray(request.recentAssistantTexts) ? request.recentAssistantTexts : []).slice(-turnCount);
    const recentContextText = recentAssistantTexts.length > 0
      ? `以下是前文的故事发展（AI输出）：\n${recentAssistantTexts
          .map((text) => `assistant："${String(text).replace(/<br\s*\/?>/gi, "\n").replace(/<\/?[^>]+(>|$)/g, "").trim()}"`)
          .join(" \n ")}`
      : "";
    const call = await callAtlasWorldTurnApi(preset, {
      injectionText: prepareOutput.response.injectionText,
      userText: request.userText,
      assistantText: request.assistantText,
      // 0.9.21 世界书资料块：宿主侧卡书条目（有界），只进推演请求
      ...(request.loreSupplement ? { loreSupplement: request.loreSupplement } : {}),
      ...(lastTurnSummary ? { lastTurnSummary } : {}),
      ...(recentContextText ? { recentContextText } : {}),
      ...(request.personaDescription ? { personaDescription: request.personaDescription } : {}),
      ...(request.charDescription ? { charDescription: request.charDescription } : {}),
    }, { fetchFn: deps.fetchFn, now });
    pushLog({
      at: now(),
      kind: "world-turn",
      presetName: preset.name,
      model: preset.model,
      ok: call.ok,
      ...(call.ok ? {} : { code: call.code }),
      status: call.status,
      durationMs: call.durationMs,
      requestChars: request.userText.length + request.assistantText.length,
      responseChars: call.ok ? call.text.length : 0,
      // 0.9.14 自动救场提示（如 MiniMax 订阅密钥自动切换 Anthropic 路由）随日志落档
      ...(call.ok && call.notice ? { notice: call.notice } : {}),
    });
    if (!call.ok) {
      throw new AtlasError(call.code, call.message, { retryable: call.retryable });
    }

    // 6. 解析草稿（不可信）→ 原子提交。此阶段的拒绝都源自模型输出问题，
    //    统一补 retryable=true（重试 = 重新推演一次，可能产出合法草稿）。
    let draft;
    let output;
    // ATLAS-06：提交前落一个「回合前」技术检查点（swipe / 编辑 / 删除的回退锚点）。
    // 失败（如数量达上限）不阻断推演——该回合只是没有回退点，不写映射。
    let baseWorld = world;
    let checkpointId: string | null = null;
    const ckpt = createCheckpoint(world, {
      branchId: pending.binding.branchId,
      at: pending.binding.worldTimeCursor,
      kind: "technical",
      reason: `atlas-turn:${request.assistantMessageId}`.slice(0, 200),
      now: now(),
    });
    if (ckpt.ok) {
      baseWorld = ckpt.value;
      const list = baseWorld.checkpoints ?? [];
      checkpointId = list.length > 0 ? list[list.length - 1]!.id : null;
    }
    try {
      // 0.9.16 内容替换规则库（照抄 shujuku + 开关增强）：推演输出先过启用的词对规则
      // （剥 think / 推理段 / 杂段），再进草稿解析。
      const cleanedText = applyContentReplaceRules(call.text, current.contentReplaceRules ?? []);
      // 0.9.30 放宽格式校验（作者拍板「先把回复格式的校验去掉」）：
      // 推理模型（MiniMax-M3 等）会把 JSON 写进 <think> 里——剥 think 后可能什么都不剩。
      // 解析失败先退回原文再试一次；仍失败则不拒单，按「无结构变化」处理，原文记入日志供诊断。
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
            excerpt: call.text.slice(0, 1500),
          });
          draft = {
            duration: 0,
            locationChange: null,
            rawEffects: [],
            memoryDrafts: [],
            summary: "推演输出无法解析为 JSON，本轮按无结构变化处理（原文前 1500 字见日志页）。",
          };
        }
      }
      // 0.9.0 算法裁决层：网格旅行算法裁定移动耗时、实体白名单强制、未知地点降级丢弃。
      // 裁定说明合入 summary（可审计），独立 notes 记入日志。
      const adjudication = adjudicateAtlasDraft(baseWorld, {
        branchId: pending.binding.branchId,
        currentPointId: pending.binding.currentPointId,
        userText: request.userText,
        draft,
      });
      if (adjudication.notes.length > 0) {
        pushLog({
          at: now(),
          kind: "world-turn-adjudication",
          chatId: request.chatId,
          notes: adjudication.notes,
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
        now: now(),
      });
    } catch (thrown) {
      if (thrown instanceof AtlasError && thrown.details.retryable === undefined) {
        throw new AtlasError(thrown.code, thrown.message, { ...thrown.details, retryable: true });
      }
      throw thrown;
    }
    const receipt = output.receipt;
    if (receipt.status === "failed") {
      // 0.9.17：提交失败也要落日志（带具体校验原因）——否则「1 条校验失败」永远查不到是哪条。
      pushLog({
        at: now(),
        kind: "world-turn-commit-failed",
        chatId: request.chatId,
        worldId: binding.worldId,
        summary: receipt.summary,
      });
      // commitAtlasTurn 保证零部分写入；保留 pending 供 retry
      return okResult({ receipt });
    }

    // 6.5 ATLAS-13 回合边界 NPC 日程结算：只结算新鲜提交（duplicate 的位置已是
    //     确定性重算结果，重放只会重复注记）。结算读提交后的世界与时间——
    //     玩家先提交的事实即现实；NPC 移动只写 NPC 自己的 CharacterState；
    //     同段同地遭遇进 triggeredNpcIds + 〔日程〕注记（可审计）。
    let settledWorld = output.world;
    if (receipt.status === "committed") {
      const settlement = settleNpcSchedules(output.world, {
        branchId: pending.binding.branchId,
        prevTime: pending.binding.worldTimeCursor,
        newTime: receipt.currentTime,
        playerFromPointId: pending.binding.currentPointId,
        playerToPointId: receipt.currentLocationId ?? null,
        now: now(),
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
          notes: settlement.notes,
        });
      }
    }

    // 7. 成功：原子保存新世界 + 更新绑定游标 + 清理 pending + 缓存回执
    await store.write(`world:${binding.worldId}`, settledWorld);
    worldCache.set(binding.worldId, settledWorld);
    const nextBinding: AtlasChatBinding = {
      ...binding,
      worldTimeCursor: receipt.currentTime,
      currentLocationId: receipt.currentLocationId ?? binding.currentLocationId,
      lastCommittedMessageId: request.assistantMessageId,
    };
    await store.write(`binding:${binding.chatId}`, nextBinding);
    bindingCache.set(binding.chatId, nextBinding);
    await store.remove(`pending:${idempotencyKey}`);
    receiptCache.set(idempotencyKey, receipt);
    // ATLAS-06：楼层 ↔ 检查点稳定映射（swipe / 编辑 / 删除回退的依据）。
    // 只在有检查点时写；回滚时标记 rolledBack 保留历史，文档永不删除。
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
        previousBinding: {
          worldTimeCursor: binding.worldTimeCursor,
          currentLocationId: binding.currentLocationId,
          lastCommittedMessageId: binding.lastCommittedMessageId,
        },
      });
    }
    // 8. 世界书条目规划（纯派生，零 IO；写入由 UI 扩展经酒馆 world-info API 完成）。
    //    duplicate / failed 不产出规划：duplicate 本就写过了，failed 零部分写入。
    const lorebook = buildLorebookPlans(output.world, receipt);

    // 9.5 0.9.32 点挂子图 sidecar：newLocations 携带的 submap / description 落到
    //     maps:<worldId> 独立文档（lib/ 点位 schema 不动；只增不改）。
    //     整段容错：世界已在步骤 7 提交，sidecar 只是增强数据——写失败记日志不阻断
    //     （否则回执已缓存、世界已落盘，API 却报 500，作者会以为回合失败去重试）。
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
              now: now(),
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
        summary: `子图 / 点位描述落库失败（回合本身已提交成功，无需重试推演）：${thrown instanceof Error ? thrown.message : String(thrown)}`.slice(0, 300),
      });
    }

    // 9. 0.9.31 首轮自动建图（作者需求：第一次推演生成当前地图，之后地图有了就不再重复）。
    //    条件：committed + 地图还只有起点（≤1 点）+ 本世界从未跑过自动建图（store 标记防零产出重试）。
    //    红线例外记档：本轮最多第 2 条请求（推演 + 一次性建图），作者 2026-09-21 拍板。
    if (receipt.status === "committed" && (settledWorld.points ?? []).length <= 1) {
      const markerKey = `geo-auto:${binding.worldId}`;
      let marker: unknown = null;
      try {
        marker = await store.read(markerKey);
      } catch {
        marker = null;
      }
      if (!marker) {
        await store.write(markerKey, { at: now() });
        try {
          const geo = await runGeoExtraction({
            world: settledWorld,
            preset,
            lore: request.loreSupplement ?? "",
            recentTexts: recentAssistantTexts,
            source: "auto",
          });
          if (geo.pointsAdded + geo.regionsAdded > 0) {
            receipt.summary = `${receipt.summary}；首轮自动建图：+${geo.regionsAdded} 地区 +${geo.pointsAdded} 地点`.slice(0, 480);
          }
        } catch (thrown) {
          // 自动建图失败不阻断回合（世界已提交）；原因记日志，作者可手动提炼兜底
          pushLog({
            at: now(),
            kind: "world-geo-auto",
            worldId: binding.worldId,
            ok: false,
            code: thrown instanceof AtlasError ? thrown.code : "INTERNAL",
            message: thrown instanceof Error ? thrown.message.slice(0, 200) : String(thrown).slice(0, 200),
          });
        }
      }
    }

    return okResult(lorebook ? { receipt, lorebook } : { receipt });
  }

  async function handleCommit(body: unknown): Promise<AtlasRouteResult> {
    const parsed = parseAtlasTurnCommitRequest(body);
    if (!parsed.ok) throw parsed.error;
    const request = parsed.value;
    const binding = requireBoundBinding(await getBinding(request.chatId));
    if (!(await loadSettings()).autoCommit) {
      throw new AtlasError(ATLAS_ERROR_CODES.API_NOT_CONFIGURED, "当前聊天已关闭自动推演，commit 被拒绝。");
    }
    return enqueue(request.chatId, () => executeCommit(binding, request));
  }

  async function handleRetry(body: unknown): Promise<AtlasRouteResult> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "retry 请求必须是对象");
    }
    const record = body as Record<string, unknown>;
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
      // 已成功的回合：重试直接返回 duplicate 回执（不要求 pending 仍存在）
      if (receiptCache.has(key)) {
        return okResult({ receipt: { ...receiptCache.get(key), status: "duplicate" }, duplicate: true });
      }
      const stored = (await store.read(`pending:${key}`)) as StoredPendingCommit | null;
      if (!stored) {
        throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "没有可重试的待处理回合。");
      }
      return executeCommit(binding, stored.request);
    });
  }

  async function handleRestore(body: unknown): Promise<AtlasRouteResult> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "restore 请求必须是对象");
    }
    const record = body as Record<string, unknown>;
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

  /**
   * ATLAS-06：swipe / 编辑 / 删除的世界回退。
   * 语义 = Atlasia「设为游玩头」：回到该回合之前的检查点，**账本未来事件一条不删**（默认保留可返回历史）；
   * 绑定游标照回合映射里的 previousBinding 快照精确还原。
   * 守卫：只允许回退该聊天最近一条未回退回合——中间楼层回退会连带抹掉其后所有推演，必须显式拒绝。
   */
  async function handleRollback(body: unknown): Promise<AtlasRouteResult> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "rollback 请求必须是对象");
    }
    const record = body as Record<string, unknown>;
    const chatId = typeof record.chatId === "string" ? record.chatId.trim() : "";
    const assistantMessageId = typeof record.assistantMessageId === "string" ? record.assistantMessageId.trim() : "";
    const swipeId = typeof record.swipeId === "string" && record.swipeId.trim() ? record.swipeId.trim() : undefined;
    if (!chatId || !assistantMessageId || assistantMessageId.length > ATLAS_LIMITS.ID_CHARS) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "rollback 需要 chatId 与 assistantMessageId。");
    }
    const binding = requireBoundBinding(await getBinding(chatId));
    // 收集该聊天全部未回退的回合映射，按提交时间倒序
    const keys = await store.list(`turn:${chatId}:`);
    const entries: Array<{ key: string; doc: Record<string, unknown> & { committedAt?: number; rolledBack?: boolean; assistantMessageId?: string; swipeId?: string | null } }> = [];
    for (const key of keys) {
      const doc = (await store.read(key)) as Record<string, unknown> | null;
      if (doc && !doc.rolledBack) entries.push({ key, doc });
    }
    entries.sort((a, b) => Number(b.doc.committedAt ?? 0) - Number(a.doc.committedAt ?? 0));
    const target = entries.find(
      (e) => e.doc.assistantMessageId === assistantMessageId && (swipeId === undefined || e.doc.swipeId === swipeId),
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
    // 世界写回游玩头状态（账本未来保留）；绑定游标照 previousBinding 快照还原
    await store.write(`world:${binding.worldId}`, restored.value);
    worldCache.set(binding.worldId, restored.value);
    const previous = (target.doc.previousBinding ?? {}) as {
      worldTimeCursor?: number;
      currentLocationId?: string | null;
      lastCommittedMessageId?: string | null;
    };
    const nextBinding: AtlasChatBinding = {
      ...binding,
      worldTimeCursor: typeof previous.worldTimeCursor === "number" ? previous.worldTimeCursor : binding.worldTimeCursor,
      currentLocationId: previous.currentLocationId ?? binding.currentLocationId,
      lastCommittedMessageId: previous.lastCommittedMessageId ?? null,
    };
    await store.write(`binding:${binding.chatId}`, nextBinding);
    bindingCache.set(binding.chatId, nextBinding);
    // 标记该回合已回退（文档保留 = 可审计的历史）；清幂等缓存让同变体之后的重提交能重新推进
    await store.write(target.key, { ...target.doc, rolledBack: true, rolledBackAt: now() });
    const oldKey = typeof target.doc.idempotencyKey === "string" ? target.doc.idempotencyKey : null;
    if (oldKey) receiptCache.delete(oldKey);
    return okResult({
      rolledBack: { assistantMessageId, checkpointId },
      restored: restored.restored ?? null,
    });
  }

  async function handleTravelPreview(body: unknown): Promise<AtlasRouteResult> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "travel-preview 请求必须是对象");
    }
    const record = body as Record<string, unknown>;
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
      ...(speedTierId ? { speedTierId } : {}),
    });
    return okResult({ preview });
  }

  // -------------------------------------------------------------------------
  // dispatch
  // -------------------------------------------------------------------------

  async function handle(
    method: string,
    path: string,
    body: unknown,
    ctx: AtlasRequestContext = {},
  ): Promise<AtlasRouteResult> {
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
      if (method === "POST" && route === "/bindings") return await handleBindings(body);
      const stateMatch = route.match(/^\/state\/([^/]+)$/);
      if (method === "GET" && stateMatch) return await handleState(decodeURIComponent(stateMatch[1]));
      const imageMatch = route.match(/^\/map\/image\/([^/]+)$/);
      if (method === "GET" && imageMatch) return await handleMapImage(decodeURIComponent(imageMatch[1]));
      if (method === "POST" && route === "/turns/prepare") return await handlePrepare(body);
      if (method === "POST" && route === "/turns/commit") return await handleCommit(body);
      if (method === "POST" && route === "/turns/retry") return await handleRetry(body);
      if (method === "POST" && route === "/turns/restore") return await handleRestore(body);
      if (method === "POST" && route === "/turns/rollback") return await handleRollback(body);
      if (method === "POST" && route === "/map/travel-preview") return await handleTravelPreview(body);
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `未知路由：${method} ${route}`);
    } catch (thrown) {
      return errorResult(thrown);
    }
  }

  return {
    handle,
    /** 诊断 / 测试用：脱敏日志副本 */
    logs(): Record<string, unknown>[] {
      return logs.map((entry) => ({ ...entry }));
    },
    /** 测试辅助：注入设置（跳过 PUT 校验流程；仅供测试进程使用） */
    __setSettingsForTest(next: Partial<AtlasServerSettingsV2>): void {
      settings = { ...settings, ...next };
      settingsLoaded = true;
    },
  };
}

export type AtlasServerCore = ReturnType<typeof createAtlasServerCore>;
