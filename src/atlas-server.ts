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

import { sanitizeDiagnostic, type AtlasDiagnostic } from "./atlas-diagnostics.ts";
import type { EntityRecord, World } from "../lib/world-schema.ts";
import { parseWorld } from "../lib/world-schema.ts";
import { adjudicateAtlasDraft } from "./atlas-adjudicate.ts";
import { settleNpcSchedules, mergeSettlementNotes, isProtagonistRole } from "./atlas-schedule.ts";
import { applyContentReplaceRules } from "./atlas-content-replace.ts";
import { ledgerForBranch, appendStateEvent } from "../lib/world-ledger.ts";
import { branchLineage } from "../lib/world-lineage.ts";
import { parseStateEffect } from "../lib/world-schema.ts";
import { appendDefinitionRevision } from "../lib/world-definition.ts";
import { hashString } from "../lib/world-cards.ts";
import { createCheckpoint, previewRestore, restoreAsPlayhead } from "../lib/world-checkpoint.ts";
import { moveCharacterTo } from "../lib/world-npc.ts";
import { resolveAtlasRuntimeView } from "./atlas-runtime-view.ts";
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
import { prepareAtlasTurn, commitAtlasTurn, provisionReferencedCharacters } from "./atlas-turn.ts";
import { applyAtlasV2Turn } from "./atlas-turn-v2.ts";
import { parseAtlasWorldTurnDraftV2, type AtlasV2Draft } from "./atlas-contract-v2.ts";
import { buildSubMapTreeFromDraft, projectWorldSubmaps, sanitizeMapDoc, SUBMAP_FRAME_DEFAULT, validateSubmapDepth } from "./atlas-geo-apply.ts";
import { detectStartPlaceholder, resolveSceneStatus, retireStartPlaceholder, sanitizeSceneDoc, sceneDocKey, type SceneDoc } from "./atlas-scene.ts";
import { validateScaleResponse, applyScaleHintsToDoc, type FrameRef, roundPositiveScale } from "./atlas-scale.ts";
import { buildLorebookPlans } from "./atlas-lorebook.ts";
import { reconcilePendingCommits, type ReconcileReport } from "./atlas-pending-reconcile.ts";
import {
  buildWorldTurnMessages,
  callAtlasWorldTurnApi,
  extractJsonObject,
  parseAtlasWorldTurnDraft,
  DEFAULT_PROMPT_SEGMENTS_V2,
  V2_BOOTSTRAP_TASK_CONTENT,
  isV2ProtocolEnabled,
  type AtlasWorldTurnPromptInput,
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
// 0.9.42 会话承载：世界文档随请求往返（存聊天 chatMetadata，作者拍板「空间换安全」）
//
// 会话文档 = { schemaVersion, rev, binding, world, maps, turns, geoAuto } 单对象；
// 世界/绑定/地图/回合映射/geo-auto 的读写经会话覆盖层落到该文档，响应带回新会话；
// settings / pending 是全局或瞬态数据，留全局 store。rev 单调递增用于双开冲突检测。
// ---------------------------------------------------------------------------

export const ATLAS_SESSION_SCHEMA_VERSION = 1;
/** 会话内回合映射条数上限（百楼量级 × 安全余量；超额拒绝写入）。 */
const SESSION_TURNS_MAX = 2000;

export interface AtlasSessionDoc {
  schemaVersion: number;
  rev: number;
  binding: unknown | null;
  world: unknown | null;
  maps: unknown | null;
  scene: unknown | null;
  turns: Record<string, unknown>;
  geoAuto: Record<string, unknown>;
}

export function createEmptySessionDoc(): AtlasSessionDoc {
  return {
    schemaVersion: ATLAS_SESSION_SCHEMA_VERSION,
    rev: 0,
    binding: null,
    world: null,
    maps: null,
    scene: null,
    turns: {},
    geoAuto: {},
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 宽容解析：任何损坏形状按空会话处理（绝不抛错、绝不破坏浏览器侧数据）。 */
export function parseAtlasSessionDoc(raw: unknown): AtlasSessionDoc {
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
  session.scene = raw.scene ?? null;
  return session;
}

/** 深拷贝（JSON 口径；响应本来就要过 JSON，不可序列化值按 undefined 丢弃）。 */
export function cloneSessionDoc(session: AtlasSessionDoc): AtlasSessionDoc {
  try {
    return JSON.parse(JSON.stringify(session)) as AtlasSessionDoc;
  } catch {
    return createEmptySessionDoc();
  }
}

function idOfDoc(value: unknown): string {
  if (!isPlainRecord(value)) return "";
  const id = value.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : "";
}

function chatIdOfBinding(binding: unknown): string {
  if (!isPlainRecord(binding)) return "";
  const chatId = binding.chatId;
  return typeof chatId === "string" ? chatId : "";
}

/**
 * 会话覆盖层存储：世界 / 绑定 / 地图 / 回合映射 / geo-auto 的读写落在会话文档；
 * settings / pending 委托全局 store。任何会话键写入都标记 changed（响应带回新会话）。
 * 回合映射以完整存储键（`turn:<chatId>:<幂等键>`）为键，与旧 store 语义一一对应。
 */
export function createSessionOverlayStore(
  session: AtlasSessionDoc,
  fallback: AtlasDocumentStore,
): AtlasDocumentStore & { changed(): boolean } {
  let mutated = false;
  const OWNED_PREFIXES = ["world:", "binding:", "maps:", "scene:", "geo-auto:", "turn:"];

  function worldName(): string | null {
    return session.world !== null ? `world:${idOfDoc(session.world)}` : null;
  }
  function bindingName(): string | null {
    return session.binding !== null ? `binding:${chatIdOfBinding(session.binding)}` : null;
  }
  function mapsName(): string | null {
    if (session.maps === null) return null;
    const worldId = idOfDoc(session.world);
    return worldId ? `maps:${worldId}` : null;
  }

  function sceneName(): string | null {
    if (session.scene === null) return null;
    const worldId = idOfDoc(session.world);
    return worldId ? "scene:" + worldId : null;
  }

  return {
    changed() {
      return mutated;
    },

    async read(name: string) {
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
      if (name.startsWith("scene:")) {
        const current = sceneName();
        if (current === name) return session.scene;
        // Existing 0.9.51 sessions had no scene field; retain a read-only
        // fallback until the next scene write folds it into the session.
        return session.scene === null && idOfDoc(session.world) === name.slice("scene:".length)
          ? fallback.read(name) : null;
      }
      if (name.startsWith("scene:")) {
        if (sceneName() === name) {
          session.scene = null;
          mutated = true;
        }
        return;
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

    async write(name: string, value: unknown) {
      if (name === "settings" || name.startsWith("pending:")) return fallback.write(name, value);
      if (name.startsWith("world:")) {
        const id = name.slice("world:".length);
        const currentId = idOfDoc(session.world);
        if (session.world !== null && currentId !== id) {
          throw new AtlasError(
            ATLAS_ERROR_CODES.INVALID_PAYLOAD,
            "当前聊天会话已包含另一个世界，拒绝覆盖；请先解绑再导入 / 初始化。",
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
      if (name.startsWith("scene:")) {
        const worldId = name.slice("scene:".length);
        if (idOfDoc(session.world) !== worldId) {
          throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "场景文档与当前会话世界不一致，拒绝写入。");
        }
        session.scene = value;
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

    async remove(name: string) {
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

    async list(prefix: string) {
      if (prefix === "settings" || prefix.startsWith("pending:")) return fallback.list(prefix);
      if (OWNED_PREFIXES.some((p) => prefix.startsWith(p))) {
        const names: string[] = [];
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
        const scene = sceneName();
        if (scene && scene.startsWith(prefix)) names.push(scene);
        for (const worldId of Object.keys(session.geoAuto)) {
          const name = `geo-auto:${worldId}`;
          if (name.startsWith(prefix)) names.push(name);
        }
        return names.sort();
      }
      return fallback.list(prefix);
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
  { method: "POST", path: "/worlds/move-author" },
  { method: "POST", path: "/worlds/scale/calibrate" },
  { method: "POST", path: "/bindings" },
  { method: "POST", path: "/state" },
  { method: "POST", path: "/map/image" },
  { method: "POST", path: "/turns/prepare" },
  { method: "POST", path: "/turns/preview" },
  { method: "POST", path: "/scene/bootstrap" },
  { method: "POST", path: "/scene/repair-start" },
  { method: "POST", path: "/turns/commit" },
  { method: "POST", path: "/turns/retry" },
  { method: "POST", path: "/turns/restore" },
  { method: "POST", path: "/turns/rollback" },
  { method: "POST", path: "/map/travel-preview" },
  { method: "POST", path: "/session/export" },
  { method: "POST", path: "/session/purge" },
] as const;

/**
 * 0.9.42 会话承载路由：请求体携带世界会话文档（body.session），
 * 世界/绑定/地图/回合映射/geo-auto 的读写落在会话覆盖层，
 * 响应带回新会话由浏览器写回 chatMetadata。settings / pending 留全局 store。
 */
const ATLAS_SESSION_ROUTES = new Set<string>([
  "POST /worlds/import",
  "POST /worlds/ensure-starter",
  "POST /worlds/geo/adopt",
  "POST /worlds/move-author",
  "POST /worlds/scale/calibrate",
  "POST /bindings",
  "POST /state",
  "POST /map/image",
  "POST /turns/prepare",
  "POST /turns/preview",
  "POST /scene/bootstrap",
  "POST /scene/repair-start",
  "POST /turns/commit",
  "POST /turns/retry",
  "POST /turns/restore",
  "POST /turns/rollback",
  "POST /map/travel-preview",
]);

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
  /** Safe metadata events; subscriber failures never change route results. */
  onDiagnostic?: (event: AtlasDiagnostic) => void;
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

/** 跨请求共享互斥：会话路由按 chatId 串行、ensure 按 worldId 串行（实例按请求重建，互斥必须共享）。 */
async function withSharedMutex<T>(map: Map<string, Promise<void>>, key: string, task: () => Promise<T>): Promise<T> {
  const previous = map.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  map.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** 跨请求共享运行时：RPM 窗口、诊断日志、rev 登记表、测试设置注入（实例可按请求重建，这些必须共享）。 */
interface AtlasSharedRuntime {
  rpmTimestamps: number[];
  logs: Array<Record<string, unknown>>;
  settingsOverride: AtlasServerSettingsV2 | null;
  /** chatId → 已见最新会话 rev（SESSION_STALE 冲突检测；进程重启清零，尽力而为） */
  revByChat: Map<string, number>;
  /** chatId → 在途会话请求链（同聊天请求串行，双开并发不会互相冲账） */
  chatMutex: Map<string, Promise<void>>;
  /** worldId → 在途 ensure 链（并发首条消息只创建一个世界） */
  ensureMutex: Map<string, Promise<void>>;
}

/** 单实例核心：store 决定数据从哪来（全局文档库，或 0.9.42 的会话覆盖层）。 */
function createCoreInstance(
  store: AtlasDocumentStore,
  deps: Pick<AtlasServerCoreDeps, "fetchFn" | "now" | "onDiagnostic">,
  shared: AtlasSharedRuntime,
) {
  const now = deps.now ?? Date.now;

  let settings: AtlasServerSettingsV2 = createDefaultSettingsV2();
  let settingsLoaded = false;
  let settingsPromptRecoveryCount = 0;
  /** 迁移发生在读取路径上：不写 store；第一次成功设置写入时才持久化 v2（规格 0.5）。 */
  const worldCache = new Map<string, World | null>();
  const bindingCache = new Map<string, AtlasChatBinding | null>();
  const receiptCache = new Map<string, AtlasTurnReceipt>();
  const queues = new Map<string, Promise<unknown>>();
  const rpmTimestamps = shared.rpmTimestamps;

  const errorKinds = new Set([
    "pending-remove-failed", "scene-bootstrap-failed", "scene-bootstrap-rejected",
    "world-scale-hint-failed", "world-turn-commit-failed", "world-turn-sidecar-failed",
    "world-turn-v2-rejected",
  ]);
  const warnKinds = new Set([
    "settings-sanitize", "world-geo-extract-fallback", "world-scale-extract-fallback",
    "world-scale-hint-skipped", "world-scale-reject", "world-turn-parse-fallback",
    "world-turn-v2-warnings", "scene-bootstrap-warnings",
    // S6 补刀（0.9.55）：投影期的可恢复异常——读取失败 / 视图侧点位超限被裁，
    // 都要能在「日志」页看见，不能静默当成「这个世界没有子图」。
    "map-projection-sidecar-read-failed", "map-projection-points-truncated",
  ]);
  function pushLog(entry: Record<string, unknown>): void {
    const logs = shared.logs;
    const kind = typeof entry.kind === "string" ? entry.kind : "engine-event";
    const level = errorKinds.has(kind) ? "error" : warnKinds.has(kind) ? "warn" : "info";
    // Legacy logs() remains available, but stores metadata only. Model excerpts,
    // free-form summaries and identifiers must never be retained in this ring.
    const safeLog: Record<string, unknown> = { at: new Date(now()).toISOString(), kind, level };
    if (entry.source === "auto" || entry.source === "user") safeLog.source = entry.source;
    for (const key of ["pointsAdded", "regionsAdded", "skipped", "scanned", "cleaned", "durationMs"]) {
      const value = entry[key];
      if (typeof value === "number" && Number.isFinite(value)) safeLog[key] = value;
    }
    if (typeof entry.excerpt === "string") safeLog.responseChars = entry.excerpt.length;
    // 0.9.54 A9：真实响应长度优先。旧实现一律用 `excerpt`（= call.text.slice(0,1500)）
    // 的长度充当 responseChars，正文一长就恒定 1500，完全无法判断是否被截断。
    const realResponseChars = typeof entry.responseChars === "number" && Number.isFinite(entry.responseChars)
      ? entry.responseChars
      : typeof entry.excerpt === "string" ? entry.excerpt.length : undefined;
    if (typeof realResponseChars === "number") safeLog.responseChars = realResponseChars;
    logs.push(safeLog);
    if (logs.length > 200) logs.shift();
    // v2 拒绝时的首个校验失败路径：只取结构化 path，绝不带 errors[].message
    //（message 可能夹带模型原文 / 引文，属于禁止进持久诊断的内容）。
    const firstSchemaPath = Array.isArray(entry.errors)
      ? (() => {
          for (const item of entry.errors) {
            if (item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string") {
              return (item as { path: string }).path;
            }
          }
          return undefined;
        })()
      : undefined;
    const errorCount = typeof entry.errorCount === "number" && Number.isInteger(entry.errorCount)
      ? entry.errorCount
      : undefined;
    const diagnostic = sanitizeDiagnostic({
      level, source: "engine", code: kind.toUpperCase().replace(/-/g, "_"),
      operation: "engine", phase: kind, outcome: level === "error" ? "failed" : level === "warn" ? "skipped" : "success",
      errorCode: typeof entry.errorCode === "string" ? entry.errorCode : undefined,
      durationMs: typeof entry.durationMs === "number" ? entry.durationMs : undefined,
      details: {
        ...(typeof entry.skipped === "number" ? { count: entry.skipped } : {}),
        ...(typeof entry.scanned === "number" ? { scanned: entry.scanned } : {}),
        ...(typeof realResponseChars === "number" ? { responseChars: realResponseChars } : {}),
        ...(firstSchemaPath !== undefined ? { schemaPath: firstSchemaPath } : {}),
        ...(errorCount !== undefined ? { count: errorCount } : {}),
        ...(typeof entry.reasonCode === "string" ? { reasonCode: entry.reasonCode } : {}),
        ...(typeof entry.coreCommitted === "boolean" ? { coreCommitted: entry.coreCommitted } : {}),
      },
    }, now);
    if (diagnostic) {
      try { deps.onDiagnostic?.(diagnostic); } catch { /* diagnostics do not affect commit */ }
    }
  }

  /**
   * 惰性加载设置：识别 schemaVersion 2 与 v1。
   * - v2：sanitize（非法条目丢弃、悬挂引用归一为 null）。
   * - v1（或形状可疑的旧数据）：纯函数迁移，**不写 store**；首个成功写入时落库 v2。
   */
  async function loadSettings(): Promise<AtlasServerSettingsV2> {
    if (shared.settingsOverride) return shared.settingsOverride;
    if (settingsLoaded) return settings;
    const raw = await store.read(SETTINGS_DOC);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      if (record.schemaVersion === ATLAS_SETTINGS_SCHEMA_VERSION) {
        const sanitized = sanitizeSettingsV2(record, { now });
        settings = sanitized.settings;
        settingsPromptRecoveryCount = sanitized.diagnostics.promptSkipped;
        if (sanitized.diagnostics.skipped > 0) {
          pushLog({ at: now(), kind: "settings-sanitize", skipped: sanitized.diagnostics.skipped });
        }
      } else {
        const migrated = migrateAtlasSettings(record, { now });
        settings = migrated.settings;
        settingsPromptRecoveryCount = migrated.diagnostics.promptSkipped;
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
      version: "0.9.54",
      protocolVersion: 1,
      time: now(),
    });
  }

  async function handleGetSettings(ctx: AtlasRequestContext): Promise<AtlasRouteResult> {
    // 0.9.48（T07 权限闸）：读取与写入同一道门——配置含连接端点与密钥信息，
    // 只有本机会话（浏览器默认模式恒 local=true）或部署方授权的 admin（server plugin）可读。
    // 远程匿名 / 普通用户 403，不再存在「改设置要登录、读配置公网可扫」的不对称。
    if (!ctx.local) throw new AtlasError(ATLAS_ERROR_CODES.FORBIDDEN, "只有本机已登录会话可以读取 Atlas 设置。");
    const current = await loadSettings();
    // 视图语义（0.9.12 作者令，照抄 shujuku）：本机会话回填明文 Key（编辑器免重输）；
    // 该语义以 local 闸为前提——远程非本机用户根本到不了这一行。
    // 0.9.48 补 hasApiKey / apiKeyLast4 供 UI 展示尾号；响应体绝不含密钥以外的敏感头原文。
    return okResult({ ...settingsViewV2(current), recoveryPromptCount: settingsPromptRecoveryCount });
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
    // A sanitized snapshot would irreversibly omit rejected legacy presets.
    if (settingsPromptRecoveryCount > 0) {
      throw new AtlasError(
        ATLAS_ERROR_CODES.INVALID_PAYLOAD,
        "原始设置中有 " + settingsPromptRecoveryCount + " 条提示词预设无法读取。设置写入已暂停，请先备份原始设置并恢复这些预设。",
      );
    }
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
    // 同一 world.id 跨请求串行（并发首条消息只创建一个世界；实例按请求重建，互斥在共享 runtime）
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
      "规则：name ≤20 字；regionName 必须是 regions 里出现过的名字（没有合适地区就省略该字段）；只提炼明确或强烈暗示的地理实体——城市 / 森林 / 遗迹 / 建筑等，教室 / 学校 / 商店 / 车站等剧情人物真实所处的具体场所也算地点（校园日常类故事尤其如此），角色、文风、格式规则一律不要；宁缺毋滥；最多 12 个地区、40 个地点；没有地理信息就输出 {\"regions\":[],\"points\":[]}。";
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
    // 提炼模型夹说明文字或截断 JSON 时能抢出结果。
    // 0.9.34 放宽（0.9.30 主链同口径）：抢不出 JSON 不再 502——MiniMax-M3 实测会只回
    // 纯推理 think（甚至 finish_reason=tool_calls、正文为空），这等价于「没提炼出地理」
    // 而非错误，按 +0 安静处理，原文记日志供作者查看模型回复。
    const spec = extractJsonObject(call.text);
    if (!spec) {
      pushLog({
        at: now(),
        kind: "world-geo-extract-fallback",
        worldId: world.id,
        source: input.source,
        excerpt: call.text.slice(0, 1500),
      });
      return { regionsAdded: 0, pointsAdded: 0, skipped: 0, revisionAppended: false, regionNames: [], pointNames: [] };
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
    const newPoints: Array<{ id: number; name: string; x: number; y: number; regionId?: string | null }> = [];
    for (const raw of (Array.isArray(spec.points) ? spec.points : []).slice(0, GEO_LIMITS.POINTS_MAX + 8)) {
      if (newPoints.length >= GEO_LIMITS.POINTS_MAX) break;
      const name = cleanName((raw as { name?: unknown })?.name);
      if (!name || existingPointNames.has(norm(name)) || newPoints.some((p) => norm(p.name) === norm(name))) {
        skipped += 1;
        continue;
      }
      const regionName = cleanName((raw as { regionName?: unknown })?.regionName);
      // R06：未知地区回退 null，不自动归入「起点」——新世界是空地理，写死 "start"
      // 会造出指向不存在地区的悬空引用；旧世界里真有 start 地区时沿用原口径。
      const fallbackRegionId = (world.regions ?? []).some((r) => String(r.id) === "start") ? "start" : null;
      const regionId = (regionName ? regionIdByName.get(norm(regionName)) ?? null : null) ?? fallbackRegionId;
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

  /**
   * POST /worlds/scale/calibrate — 0.9.50 地图尺度标定（外部 AI 计划 M04）。
   * 两种模式：
   * - 人工模式：body.userMetersPerCell（正有限数字）→ source="user"、locked=true。
   *   人工标定默认锁定；锁定值只有再走人工模式才能改。
   * - AI 模式（恰 1 条推演请求，复用推演预设与救场）：给模型图名 / 层级 /
   *   点位与描述 / 已有尺度 / 世界书摘录，模型只回「整张图的实际宽高」，
   *   每格距离由程序从 frame（100×100 等距方格）推导存储规范值。
   *   unknown / conflict / 数值校验不过 → 不落标定（ok 回执附状态说明），
   *   绝不静默取平均、不套用按类型写死的尺寸。
   * mapId：世界图 = "world"；子图 = 宿主点位 id（String(pointId)）。
   */
  async function handleScaleCalibrate(body: unknown): Promise<AtlasRouteResult> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "标定请求必须是对象");
    }
    const record = body as Record<string, unknown>;
    const chatId = typeof record.chatId === "string" ? record.chatId : "";
    if (!chatId || chatId.length > ATLAS_LIMITS.ID_CHARS) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "chatId 非法");
    }
    const mapId = typeof record.mapId === "string" ? record.mapId.trim().slice(0, 64) : "";
    if (!mapId) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "mapId 非法（世界图用 \"world\"，子图用宿主点位 id）");
    }
    const binding = requireBoundBinding(await getBinding(chatId));
    const world = await requireWorld(binding);

    const docKey = `maps:${world.id}`;
    const doc = sanitizeMapDoc(await store.read(docKey).catch(() => null));
    const existing = doc.calibrations[mapId] ?? null;
    const isWorldMap = mapId === "world";
    const submap = isWorldMap ? null : doc.submaps[mapId] ?? null;
    let hostPoint: { id: string | number; name: string } | null = null;
    if (!isWorldMap) {
      let cursor = mapId;
      let valid = Boolean(submap) && validateSubmapDepth(doc, mapId).ok;
      for (let depth = 0; valid && depth < 4; depth++) {
        const current = doc.submaps[cursor];
        const parent = current?.parentMapId ?? "world";
        const candidate = parent === "world"
          ? (world.points ?? []).find((point) => String(point.id) === cursor)
          : doc.submaps[parent]?.points.find((point) => point.id === cursor);
        if (!candidate) { valid = false; break; }
        if (cursor === mapId) hostPoint = candidate;
        if (parent === "world") break;
        cursor = parent;
      }
      if (!valid || !hostPoint) {
        throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "子图标定的宿主点位或父图不存在");
      }
    }

    // 人工模式：程序不做任何语义判断，数值校验后直接落盘。
    // 人工覆盖锁定值允许（UI 明示「重新填写并保存即可更新」）；锁只挡 AI 语义估计。
    const userMeters = record.userMetersPerCell;
    if (userMeters !== undefined) {
      if (typeof userMeters !== "number" || !Number.isFinite(userMeters) || userMeters <= 0) {
        throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "userMetersPerCell 必须是正的有限数字（米 / 格）");
      }
      const calibration = {
        revision: (existing?.revision ?? 0) + 1,
        metersPerCell: roundPositiveScale(userMeters),
        source: "user" as const,
        locked: true,
        basis: typeof record.basis === "string" ? record.basis.trim().slice(0, 300) : "人工标定",
        coverage: existing?.coverage ?? "",
        confidence: "",
        at: now(),
      };
      doc.calibrations[mapId] = calibration;
      await store.write(docKey, doc);
      pushLog({ at: now(), kind: "world-scale-calibrate", worldId: world.id, mapId, source: "user", metersPerCell: calibration.metersPerCell });
      return okResult({ status: "grounded", calibration, message: `已按人工值标定：1 格 ≈ ${calibration.metersPerCell} 米（已锁定）。` });
    }

    // AI 模式：组装有界材料（图名 / 层级 / 点位与描述 / 已有尺度 / 世界书摘录）。
    // 人工锁定值永不自动覆盖（计划 8.4：人工锁定优先于 AI 语义估计）
    if (existing?.locked) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "该图已有人工锁定标定——AI 估计不会覆盖；重新填写并保存人工标定即可更新。");
    }
    const lore = typeof record.loreSupplement === "string" ? record.loreSupplement.trim() : "";
    const pointList = (isWorldMap ? (world.points ?? []).slice(0, 40) : submap?.points.slice(0, 40) ?? []).map((p) => {
      const description = isWorldMap ? doc.pointMeta[String(p.id)]?.description ?? "" : (p as { description?: string }).description ?? "";
      return `${String(p.name)}${description ? `（${description.slice(0, 60)}）` : ""}`;
    });
    const mapLabel = isWorldMap ? `世界全图「${String(world.name)}」` : `地点「${hostPoint ? String(hostPoint.name) : mapId}」的内部地图`;
    const existingNote = existing
      ? `当前已有标定：1 格 ≈ ${existing.metersPerCell} 米（来源 ${existing.source}${existing.locked ? "、已锁定" : ""}）。`
      : submap?.scale
        ? `当前只有旧式比例尺：1 格 ≈ ${submap.scale.distancePerCell}${submap.scale.unit ? ` ${submap.scale.unit}` : ""}（单位换算未知，仅供参考）。`
        : "当前没有尺度标定。";

    const current = await loadSettings();
    const preset = resolveWorldTurnPreset(current);
    if (!preset) {
      throw new AtlasError(ATLAS_ERROR_CODES.API_NOT_CONFIGURED, "未配置推演 API，无法让 AI 判断地图大小。");
    }
    checkRpm();
    rpmTimestamps.push(now());

    const frame = (isWorldMap ? SUBMAP_FRAME_DEFAULT : submap?.frame) ?? SUBMAP_FRAME_DEFAULT;
    const contractRule =
      '只输出一个完整 JSON 对象：{"mapRef":"给定 mapId","frameRevision":给定 frameRevision,"status":"estimated|grounded|unknown|conflict","extentMeters":{"width":<正数米>,"height":<正数米>}或null,"coverage":"...","basis":"...","confidence":"low|medium|high","evidence":[{"sourceId":"来源ID","quote":"原文片段"}]}';
    const commonRules = [
      "输入地图：mapId=" + JSON.stringify(mapId) + "，frameRevision=" + frame.frameRevision + "，cols=" + frame.cols + "，rows=" + frame.rows + "，coordinateMode=等距方格。",
      "范围是固定 MapFrame 全图，不是当前屏幕、地点最小包围盒或视觉排版。宽对应 cols，高对应 rows；width/cols 与 height/rows 必须在容差内相等。非方形 frame 不必是正方形。",
      "先判断地图语义范围，再结合有来源的尺寸、距离与父子层级；屏幕像素、缩放倍率、地点数量及随机排版都不是物理尺度证据。",
      "有整图明确尺度或可验证映射才用 grounded；仅有语义范围用 estimated；材料不足用 unknown；证据矛盾或等距 frame 不兼容用 conflict。unknown/conflict 的 extentMeters 必须为 null。",
      "mapRef 与 frameRevision 原样回显。basis 说明依据及局限；宁可 unknown，不编造测绘精度、旅行时间或数值。",
    ].join("\n");
    const userContent = [
      `判断${mapLabel}的实际地理范围（尺度标定）。`,
      contractRule,
      commonRules,
      existingNote,
      ...(pointList.length > 0 ? [`图上的${isWorldMap ? "地点" : "内部场所"}（名字 + 描述）：`, ...pointList] : []),
      ...(hostPoint && doc.pointMeta[String(hostPoint.id)]?.description
        ? [`宿主地点描述：${doc.pointMeta[String(hostPoint.id)].description?.slice(0, 200)}`]
        : []),
      ...(lore ? ["【世界书摘录（可能包含明确距离 / 尺寸证据）】", lore.slice(0, ATLAS_LIMITS.LORE_SUPPLEMENT_CHARS)] : []),
    ].join("\n");
    const calibrationSegments = [
      { role: "system", content: "你是 Atlas 地图范围估计器。只根据有来源的地图语义、地点描述、明确距离和父子层级判断整图物理范围。只输出一个完整 JSON 对象，不输出其它文字、解释或代码围栏。" },
      { role: "user", content: userContent },
    ];
    const call = await callAtlasWorldTurnApi(
      { ...preset, promptSegments: calibrationSegments },
      { injectionText: "", userText: "", assistantText: "" },
      { fetchFn: deps.fetchFn, now },
    );
    pushLog({ at: now(), kind: "world-scale-extract", presetName: preset.name, model: preset.model, ok: call.ok, status: call.status, durationMs: call.durationMs });
    if (!call.ok) {
      throw new AtlasError(call.code, call.message, { retryable: call.retryable });
    }
    const spec = extractJsonObject(call.text);
    if (!spec) {
      pushLog({ at: now(), kind: "world-scale-extract-fallback", worldId: world.id, mapId, excerpt: call.text.slice(0, 1500) });
      return okResult({
        status: "unknown",
        calibrated: false,
        message: "模型回复无法解析为标定结果——保持未标定状态，可重试或改用人工标定。",
      });
    }
    // 数值与空间校验：使用请求时的真实 frame，拒绝模型回显其它地图或旧 frame。
    if ((spec.mapRef !== undefined && spec.mapRef !== mapId) ||
        (spec.frameRevision !== undefined && spec.frameRevision !== frame.frameRevision)) {
      return okResult({ status: "conflict", calibrated: false, message: "模型返回的地图或 frameRevision 与请求不一致；保持原标定。" });
    }
    const validation = validateScaleResponse(spec, { cols: frame.cols, rows: frame.rows });
    if (!validation.ok) {
      pushLog({ at: now(), kind: "world-scale-reject", worldId: world.id, mapId, status: validation.status, reason: validation.reason });
      return okResult({
        status: validation.status,
        calibrated: false,
        coverage: validation.coverage,
        basis: validation.basis,
        message: validation.status === "conflict"
          ? `未采用：${validation.reason}`
          : validation.reason || "模型未能给出可用的范围估计——保持未标定状态。",
      });
    }
    const calibration = {
      revision: (existing?.revision ?? 0) + 1,
      ...validation.calibration,
      at: now(),
    };
    doc.calibrations[mapId] = calibration;
    await store.write(docKey, doc);
    pushLog({ at: now(), kind: "world-scale-calibrate", worldId: world.id, mapId, source: "ai-estimated", metersPerCell: calibration.metersPerCell });
    return okResult({
      status: "calibrated",
      calibrated: true,
      calibration,
      message: `已采用 AI 估计：1 格 ≈ ${calibration.metersPerCell} 米。`,
    });
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

  /** 请求体 / 会话绑定里的 chatId（/state、/map/image 无路径参数，随体携带）。 */
  function chatIdFromRequest(body: unknown): string {
    if (!isPlainRecord(body)) return "";
    if (typeof body.chatId === "string" && body.chatId) return body.chatId;
    const session = body.session;
    if (isPlainRecord(session)) {
      const chatId = chatIdOfBinding(session.binding);
      if (chatId) return chatId;
    }
    return "";
  }

  async function visibleWorldForBinding(world: World, binding: AtlasChatBinding): Promise<World> {
    const keys = await store.list("turn:" + binding.chatId + ":");
    if (keys.length === 0) return world;
    const lineage = branchLineage(world, binding.branchId, binding.worldTimeCursor);
    const cutoffs = new Map(lineage.segments.map((segment) => [segment.branchId, segment.cutoffAt]));
    const trackedPoints = new Set<string>();
    const trackedRegions = new Set<string>();
    const trackedEntities = new Set<string>();
    const visiblePoints = new Set<string>();
    const visibleRegions = new Set<string>();
    const visibleEntities = new Set<string>();
    for (const key of keys) {
      const doc = await store.read(key);
      if (!isPlainRecord(doc)) continue;
      const points = Array.isArray(doc.createdPointIds) ? doc.createdPointIds.map(String) : [];
      const regions = Array.isArray(doc.createdRegionIds) ? doc.createdRegionIds.map(String) : [];
      const entities = Array.isArray(doc.createdEntityIds) ? doc.createdEntityIds.map(String) : [];
      for (const id of points) trackedPoints.add(id);
      for (const id of regions) trackedRegions.add(id);
      for (const id of entities) trackedEntities.add(id);
      const recordedBranch = typeof doc.branchId === "string" ? doc.branchId : null;
      const branch = (world.stories ?? []).find((story) => story.id === recordedBranch)?.mode === "canon"
        ? null : recordedBranch;
      const cutoff = cutoffs.get(branch);
      const time = typeof doc.effectiveAt === "number" ? doc.effectiveAt : Infinity;
      if (doc.rolledBack === true || cutoff == null || time > cutoff) continue;
      for (const id of points) visiblePoints.add(id);
      for (const id of regions) visibleRegions.add(id);
      for (const id of entities) visibleEntities.add(id);
    }
    if (trackedPoints.size + trackedRegions.size + trackedEntities.size === 0) return world;
    const showPoint = (id: string | number) => !trackedPoints.has(String(id)) || visiblePoints.has(String(id));
    const showRegion = (id: string) => !trackedRegions.has(String(id)) || visibleRegions.has(String(id));
    const showEntity = (id: string) => !trackedEntities.has(String(id)) || visibleEntities.has(String(id));
    return {
      ...world,
      points: (world.points ?? []).filter((point) => showPoint(point.id)),
      regions: (world.regions ?? []).filter((region) => showRegion(region.id)),
      characters: (world.characters ?? []).filter((character) => showEntity(character.id)),
      entityRecords: (world.entityRecords ?? []).filter((entity) => showEntity(entity.id)),
      characterStates: (world.characterStates ?? []).filter((item) => showEntity(item.characterId)),
    };
  }

  function rejectHiddenV2Refs(raw: World, visible: World, draft: AtlasV2Draft): void {
    const hidden = (rawIds: string[], visibleIds: string[]) => {
      const shown = new Set(visibleIds);
      return new Set(rawIds.filter((id) => !shown.has(id)));
    };
    const points = hidden((raw.points ?? []).map((item) => String(item.id)),
      (visible.points ?? []).map((item) => String(item.id)));
    const regions = hidden((raw.regions ?? []).map((item) => String(item.id)),
      (visible.regions ?? []).map((item) => String(item.id)));
    const entityIds = (world: World) => [
      ...(world.characters ?? []).map((item) => String(item.id)),
      ...(world.entityRecords ?? []).map((item) => String(item.id)),
    ];
    const entities = hidden(entityIds(raw), entityIds(visible));
    const references: Array<[string, string | null | undefined, Set<string>]> = [];
    for (const item of draft.discoveries.locations) {
      references.push(["地区", item.regionRef, regions], ["父地点", item.parentLocationRef, points]);
    }
    references.push(["当前场景", draft.scene.locationRef, points]);
    for (const item of draft.identityUpdates) references.push(["身份", item.entityRef, entities]);
    for (const item of draft.npcUpdates) {
      references.push(["人物", item.entityRef, entities], ["人物位置", item.location.locationRef, points]);
    }
    for (const item of draft.relationUpdates) {
      references.push(["关系源", item.fromRef, entities], ["关系目标", item.toRef, entities]);
    }
    for (const item of draft.memories) references.push(["记忆主体", item.entityRef, entities]);
    for (const item of draft.events) {
      for (const ref of item.entityRefs) references.push(["事件人物", ref, entities]);
    }
    for (const item of draft.mapScaleHints) references.push(["标定地图", item.mapRef, points]);
    for (const [kind, ref, hiddenIds] of references) {
      if (ref && hiddenIds.has(ref)) {
        throw new AtlasError(ATLAS_ERROR_CODES.RESPONSE_MALFORMED,
          kind + "引用了当前分支或游标不可见的 ID：" + ref + "。本轮未提交。", { retryable: true });
      }
    }
  }
  function legacyStartReport(
    world: World,
    binding: AtlasChatBinding,
    sceneDoc: SceneDoc,
    mapDoc: ReturnType<typeof sanitizeMapDoc>,
  ) {
    const start = (world.points ?? []).find((point) => String(point.id) === "1");
    const region = (world.regions ?? []).find((item) => String(item.id) === "start");
    const structuralFingerprint = Boolean(start && region &&
      start.name === "起点" && start.x === 50 && start.y === 50 &&
      start.regionId === "start" && region.name === "起点");
    const fullFingerprint = detectStartPlaceholder(world);
    const branchEvents = ledgerForBranch(world, binding.branchId)
      .filter((event) => event.at <= binding.worldTimeCursor);
    let ledgerPointId: string | null = null;
    for (const event of branchEvents) {
      for (const effect of event.effects) {
        if (effect.kind === "moveEntity" && effect.entityId === "char-main" && effect.pointId) {
          ledgerPointId = String(effect.pointId);
        }
      }
    }
    const knownPointIds = new Set((world.points ?? []).map((point) => String(point.id)));
    const currentPointId = binding.currentLocationId ?? null;
    const confirmedPointId = sceneDoc.lastConfirmed?.branchId === binding.branchId
      ? sceneDoc.lastConfirmed.pointId : null;
    const evidencePointId = ledgerPointId && ledgerPointId !== "1" && knownPointIds.has(ledgerPointId)
      ? ledgerPointId
      : currentPointId && currentPointId !== "1" && knownPointIds.has(currentPointId)
        ? currentPointId
        : confirmedPointId && confirmedPointId !== "1" && knownPointIds.has(confirmedPointId)
          ? confirmedPointId : null;
    const conflictingLedger = Boolean(ledgerPointId && ledgerPointId !== evidencePointId);
    const retired = sceneDoc.retiredPointIds.includes("1");
    const orphanPointIds = (world.points ?? [])
      .filter((point) => point.regionId && !(world.regions ?? []).some((item) => item.id === point.regionId))
      .map((point) => String(point.id)).slice(0, 40);
    const orphanSubmapIds = Object.entries(mapDoc.submaps)
      .filter(([id, sub]) => {
        const parent = sub.parentMapId ?? "world";
        return parent === "world"
          ? !knownPointIds.has(id)
          : !mapDoc.submaps[parent]?.points.some((point) => point.id === id);
      })
      .map(([id]) => id).slice(0, 40);
    const characterPositions = (world.characterStates ?? [])
      .slice(0, 32)
      .map((item) => ({ entityId: String(item.characterId ?? ""),
        pointId: item.currentPointId == null ? null : String(item.currentPointId) }));
    const canApply = structuralFingerprint && !retired && Boolean(evidencePointId) && !conflictingLedger;
    const reportToken = [
      world.id, world.updatedAt ?? 0, binding.branchId ?? "",
      binding.worldTimeCursor, currentPointId ?? "", ledgerPointId ?? "",
      sceneDoc.retiredPointIds.join(","),
    ].join("|");
    return {
      structuralFingerprint, fullFingerprint: fullFingerprint.isPlaceholder,
      fingerprintReasons: fullFingerprint.reasons.slice(0, 8),
      retired, bindingPointId: currentPointId, ledgerPointId,
      confirmedPointId, proposedPointId: evidencePointId,
      characterPositions, orphanPointIds, orphanSubmapIds,
      legacySubmapIds: Object.keys(mapDoc.submaps).slice(0, 40),
      eventCount: branchEvents.length, canApply,
      reason: retired ? "已退役" : !structuralFingerprint ? "起点结构指纹不匹配" :
        conflictingLedger ? "账本位置与候选位置冲突" :
        !evidencePointId ? "没有可确认的非起点位置；请先识别当前场景" :
        "可在下载备份后显式退役系统占位",
      reportToken,
    };
  }

  async function handleLegacyStartRepair(body: unknown): Promise<AtlasRouteResult> {
    if (!isPlainRecord(body)) throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "修复请求必须是对象");
    const chatId = typeof body.chatId === "string" ? body.chatId : "";
    const binding = requireBoundBinding(await getBinding(chatId));
    const world = await requireWorld(binding);
    const sceneDoc = sanitizeSceneDoc(await store.read(sceneDocKey(world.id)).catch(() => null));
    const mapDoc = sanitizeMapDoc(await store.read("maps:" + world.id).catch(() => null));
    const report = legacyStartReport(world, binding, sceneDoc, mapDoc);
    if (body.apply !== true) return okResult({ status: "preview", report });
    if (report.retired) return okResult({ status: "unchanged", report });
    if (!report.canApply || body.reportToken !== report.reportToken) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "检查报告已过期或缺少可信位置；请重新检查当前世界。");
    }
    const pointId = report.proposedPointId;
    if (!pointId) throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "修复目标位置缺失");
    const nextDoc: SceneDoc = {
      ...sceneDoc,
      retiredPointIds: [...sceneDoc.retiredPointIds, "1"],
      lastConfirmed: { branchId: binding.branchId, pointId, at: binding.worldTimeCursor },
    };
    const nextBinding = { ...binding, currentLocationId: pointId };
    await store.write(sceneDocKey(world.id), nextDoc);
    await store.write("binding:" + chatId, nextBinding);
    bindingCache.set(chatId, nextBinding);
    pushLog({ at: now(), kind: "legacy-start-repaired" });
    return okResult({ status: "repaired", pointId, report: { ...report, retired: true, canApply: false } });
  }

  async function handleState(body: unknown): Promise<AtlasRouteResult> {
    const chatId = chatIdFromRequest(body);
    if (!chatId || chatId.length > ATLAS_LIMITS.ID_CHARS) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "chatId 非法");
    }
    const binding = requireBoundBinding(await getBinding(chatId));
    const world = await visibleWorldForBinding(await requireWorld(binding), binding);
    const relevance = computeAtlasRelevance(world, {
      at: binding.worldTimeCursor,
      branchId: binding.branchId,
      chatId,
      messageId: `state-view-${binding.worldTimeCursor}`,
      currentPointId: binding.currentLocationId ?? null,
      currentRegionId: pointRegionId(world, binding.currentLocationId ?? null),
      flags: flagsFor(world, binding.branchId, binding.worldTimeCursor),
    });
    // R06 场景状态：占位指纹 + retired 列表 + lastConfirmed（与「当前未知」分开表达）
    // retired 占位点在真实地点语境（地图点列 / 附近）默认过滤，结构保留（引用不悬空）
    const sceneDoc = sanitizeSceneDoc(await store.read(sceneDocKey(world.id)).catch(() => null));
    if (sceneDoc.lastConfirmed &&
        (sceneDoc.lastConfirmed.at > binding.worldTimeCursor ||
         !(world.points ?? []).some((point) => String(point.id) === sceneDoc.lastConfirmed?.pointId))) {
      sceneDoc.lastConfirmed = null;
    }
    // R06：系统占位默认不显示为真实地点——已退役的（retired 列表）与指纹吻合但尚未
    // 退役的「起点」都不进真实地点语境。结构保留、引用不悬空，只是不冒充地理事实。
    const placeholder = detectStartPlaceholder(world);
    const hiddenPointIds = new Set(sceneDoc.retiredPointIds);
    if (placeholder.isPlaceholder && placeholder.pointId) hiddenPointIds.add(placeholder.pointId);
    // 有界地图数据：静态世界结构（地点列表），不含世界书 / 记忆 / 账本
    // S6（0.9.55）：世界图**只下发根地点**（parentPointId 缺省 / null）；
    // 子地点归其父的子图，避免世界图重复标出内层房间。
    const mapPoints = (world.points ?? [])
      .filter((p) => !hiddenPointIds.has(String(p.id)))
      .filter((p) => {
        const parentId = Number(p.parentPointId);
        return !Number.isInteger(parentId) || parentId <= 0;
      })
      .slice(0, MAP_POINTS_MAX)
      .map((p) => ({
        id: String(p.id),
        name: String(p.name).slice(0, MAP_POINT_NAME_CHARS),
        x: p.x,
        y: p.y,
        regionId: p.regionId ?? null,
      }));
    // 相关 NPC 位置目录（ATLAS-09 地图标记）：R04 统一运行时视图——
    // 账本投影（最新事实）覆盖 CharacterState 基线 / 旧档案，单点读取口径（D05 修复）
    const pointById = new Map((world.points ?? []).map((p) => [String(p.id), p]));
    const runtimeView = resolveAtlasRuntimeView(world, {
      branchId: binding.branchId,
      at: binding.worldTimeCursor,
    });
    for (const npc of runtimeView.npcs) {
      if (npc.pointId !== null && String(npc.pointId) === String(binding.currentLocationId ?? "") &&
          npc.presence !== "left" && !relevance.relevantNpcIds.includes(npc.id)) {
        relevance.relevantNpcIds.push(npc.id);
        relevance.npcReasons[npc.id] = ["samePoint"];
      }
    }
    // 0.9.41 人物 popover：分支作用域账本（游标前）供「最近涉及叙事」提取
    const branchEvents = ledgerForBranch(world, binding.branchId).filter((e) => e.at <= binding.worldTimeCursor);
    const npcDirectory = runtimeView.npcs.slice(0, 48).map((view) => {
      const anchorPoint = view.pointId !== null ? pointById.get(String(view.pointId)) : undefined;
      const recentNarratives = branchEvents
        .filter((e) => (e.entityRefs ?? []).map(String).includes(view.id))
        .slice(-2)
        .reverse()
        .map((e) => e.narrativeSummary.slice(0, 140));
      const anchorName = anchorPoint ? String(anchorPoint.name ?? "") : null;
      // R07：最后确认时刻 = 分支内涉及该实体的最后一条账本事件时间（真实已知动向，不猜）
      const lastConfirmedAt = [...branchEvents].reverse().find((e) => (e.entityRefs ?? []).map(String).includes(view.id))?.at ?? null;
      return {
        id: view.id,
        name: String(view.name).slice(0, MAP_POINT_NAME_CHARS),
        pointId: view.pointId,
        regionId: view.regionId,
        x: view.x,
        y: view.y,
        reason: relevance.npcReasons[view.id] ?? null,
        status: view.status ? view.status.slice(0, 160) : null,
        presence: view.presence,
        lastConfirmedAt,
        recentNarratives,
        pointName: anchorName ? anchorName.slice(0, MAP_POINT_NAME_CHARS) : null,
        positionSource: view.source,
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
        // 0.9.41 物品 popover：描述取 baseline（description / desc / text 任一），有界
        const baseline = e.baseline ?? {};
        const rawDesc = ["description", "desc", "text", "summary"]
          .map((k) => (typeof baseline[k] === "string" ? String(baseline[k]).trim() : ""))
          .find((t) => t.length > 0) ?? null;
        return {
          id: String(e.id),
          name: String(e.name ?? e.id).slice(0, MAP_POINT_NAME_CHARS),
          type: String(e.type).slice(0, 32),
          pointId: anchor.pointId ?? null,
          regionId: anchor.regionId ?? (anchorPoint ? anchorPoint.regionId ?? null : null),
          x: typeof anchor.x === "number" ? anchor.x : anchorPoint ? anchorPoint.x : null,
          y: typeof anchor.y === "number" ? anchor.y : anchorPoint ? anchorPoint.y : null,
          description: rawDesc ? rawDesc.slice(0, 200) : null,
          pointName: anchorPoint ? String(anchorPoint.name ?? "").slice(0, MAP_POINT_NAME_CHARS) : null,
        };
      });
    // 最近一次时间推进：分支作用域内、游标之前的最后一条账本事件
    const lastEvent = branchEvents.at(-1) ?? null;
    const lastAdvance = lastEvent
      ? { at: lastEvent.at, summary: lastEvent.narrativeSummary.slice(0, 200), source: lastEvent.source }
      : null;
    // 0.9.32 地图 sidecar（点位描述 + 点挂子图）：独立文档，有界随 /state 下发
    // 0.9.50（M01 子集）：宿主点位已不存在的损坏子图引用直接过滤（可恢复状态，
    // 不让幽灵子图进 UI）；标定摘要随 map 下发（键与 /worlds/scale/calibrate 对齐）
    // S6 补刀（0.9.55）：读取失败**不再静默吞掉**——旧实现 `.catch(() => null)` 把一次
    // 读取失败伪装成「这个世界的子图从来不存在」，施工单要求记具名诊断后再用空 sidecar
    // 继续投影（v2 层级来自 world.points[].parentPointId，仍然可见、可在下次写入时重建）。
    let mapDocRaw: unknown = null;
    try {
      mapDocRaw = await store.read(`maps:${world.id}`);
    } catch {
      pushLog({ kind: "map-projection-sidecar-read-failed" });
    }
    const mapDoc = sanitizeMapDoc(mapDocRaw);
    // S6（0.9.55）：先按 v2 的 World.points[].parentPointId 派生父子地图，与 sidecar 合并。
    // sidecar 写入失败 / 为空时仍能从世界结构展示层级（施工单：不可把一次 sidecar
    // 写入失败伪装成「世界已提交但子图永远丢失」）。
    const projection = projectWorldSubmaps(world.points ?? [], mapDoc);
    const projected = projection.doc;
    const pointMetaEntries = Object.entries(projected.pointMeta).slice(0, 80);
    const worldPointIds = new Set((world.points ?? []).map((p) => String(p.id)));
    // Publish only maps reachable from a real world point. Nested maps use the
    // child point ID as their key, so filtering on worldPointIds alone loses them.
    const visibleSubmapIds = new Set<string>();
    for (let depth = 0; depth < 4; depth++) {
      for (const [key, sub] of Object.entries(projected.submaps)) {
        if (visibleSubmapIds.has(key) || !validateSubmapDepth(projected, key).ok) continue;
        const parent = sub.parentMapId ?? "world";
        const reachable = parent === "world"
          ? worldPointIds.has(key)
          : visibleSubmapIds.has(parent) &&
            projected.submaps[parent]?.points.some((point) => point.id === key);
        if (reachable) visibleSubmapIds.add(key);
      }
    }
    const submapEntries = Object.entries(projected.submaps)
      .filter(([key]) => visibleSubmapIds.has(key))
      .slice(0, 40)
      .map(([key, sub]) => ({
        pointId: key,
        parentMapId: sub.parentMapId ?? "world",
        ownerLocationId: sub.ownerLocationId ?? key,
        frame: sub.frame ?? SUBMAP_FRAME_DEFAULT,
        scale: sub.scale ?? null,
        points: sub.points.slice(0, 40),
      }));
    // S6 补刀（0.9.55）：视图侧每个子图仍下发最多 40 个点（施工单优先「限制单世界上限」，
    // 超限提交已在 S3 整轮拒绝）。万一既有存档已超限，绝不能静默裁掉——记一条只含数量的
    // 具名诊断，让「点不见了」有据可查，而不是看起来像地图坏了。
    const truncatedSubmapPoints = Object.entries(projected.submaps)
      .filter(([key]) => visibleSubmapIds.has(key))
      .reduce((sum, [, sub]) => sum + Math.max(0, sub.points.length - 40), 0);
    if (truncatedSubmapPoints > 0) {
      pushLog({ kind: "map-projection-points-truncated", skipped: truncatedSubmapPoints });
    }
    const calibrationEntries = Object.entries(projected.calibrations)
      .filter(([key]) => key === "world" || visibleSubmapIds.has(key))
      .slice(0, 40);
    // R06 场景状态：占位指纹 + retired 列表 + lastConfirmed（与「当前未知」分开表达）
    const scene = resolveSceneStatus(world, sceneDoc, binding.currentLocationId ?? null);
    const legacyRepair = legacyStartReport(world, binding, sceneDoc, mapDoc);
    const lastConfirmedPointName = scene.lastConfirmed
      ? (world.points ?? []).find((p) => String(p.id) === scene.lastConfirmed!.pointId)?.name ?? null
      : null;
    return okResult({
      chatId,
      worldId: world.id,
      worldName: world.name,
      branchId: binding.branchId,
      currentTime: binding.worldTimeCursor,
      currentLocationId: binding.currentLocationId ?? null,
      scene: {
        known: scene.known,
        placeholder: {
          isPlaceholder: scene.placeholder.isPlaceholder,
          pointId: scene.placeholder.pointId,
          retired: scene.placeholder.retired,
          reasons: scene.placeholder.reasons.slice(0, 5),
        },
        lastConfirmed: scene.lastConfirmed
          ? { pointId: scene.lastConfirmed.pointId, pointName: lastConfirmedPointName, at: scene.lastConfirmed.at }
          : null,
        bootstrap: sceneDoc.bootstrap,
        legacyRepair,
      },
      nearbyPointIds: relevance.nearbyPointIds,
      relevantNpcIds: relevance.relevantNpcIds,
      npcReasons: relevance.npcReasons,
      triggerIds: relevance.triggerIds,
      map: {
        points: mapPoints,
        // S6（0.9.55）：全部可见、非占位地点数（含子地点）；mapPoints 只含根地点，
        // 因此本值可大于 points.length —— 前端据此知道世界图外还有内层地点。
        pointCount: (world.points ?? []).filter((p) => !hiddenPointIds.has(String(p.id))).length,
        // S8（0.9.55）：子地点 → 直接父地点的**有界**映射。世界图只下发根地点，
        // 前端无法自行上溯祖先；「定位当前位置」需要它把玩家所在的房间回溯到最近的
        // 根祖先并在世界图标出。只下发有父的点，避免重复整份点列。
        pointParents: Object.fromEntries(
          (world.points ?? [])
            .filter((p) => !hiddenPointIds.has(String(p.id)))
            .map((p) => [String(p.id), Number(p.parentPointId)] as const)
            .filter(([, parentId]) => Number.isInteger(parentId) && parentId > 0)
            .slice(0, MAP_POINTS_MAX),
        ),
        mapImagePresent: Boolean(world.mapImage),
        // R01：底图版本（世界更新时间）——前端缓存键的失效依据，换图 / 删图必换键
        mapImageRevision: world.updatedAt ?? 0,
        pointMeta: Object.fromEntries(pointMetaEntries),
        submaps: Object.fromEntries(submapEntries.map((entry) => [entry.pointId, { parentMapId: entry.parentMapId, ownerLocationId: entry.ownerLocationId, frame: entry.frame, scale: entry.scale, points: entry.points }])),
        submapCount: submapEntries.length,
        calibrations: Object.fromEntries(calibrationEntries),
      },
      npcDirectory,
      regions,
      objectDirectory,
      lastAdvance,
    });
  }

  /** 底图（base64 dataURL）；独立于 JSON API 的专用只读端点，避免撑爆 /state。 */
  async function handleMapImage(body: unknown): Promise<AtlasRouteResult> {
    const chatId = chatIdFromRequest(body);
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
    const world = await visibleWorldForBinding(await requireWorld(binding), binding);
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

  /**
   * R03（A10）：最终请求预览——用与 executeCommit 完全相同的装配路径
   * （resolveWorldTurnPreset → prepareWorldTurnInputs → buildWorldTurnMessages）
   * 生成模型将看到的 messages，零 API 调用。展示每段 role / 内容 / 长度、
   * 生效提示词来源与缺失块哨兵；素材（userText / assistantText / 前文）缺省为空。
   */
  async function handleTurnPreview(body: unknown): Promise<AtlasRouteResult> {
    const payload = (body ?? {}) as {
      chatId?: unknown;
      userText?: unknown;
      assistantText?: unknown;
      recentAssistantTexts?: unknown;
    };
    const chatId = typeof payload.chatId === "string" ? payload.chatId : "";
    if (!chatId || chatId.length > ATLAS_LIMITS.ID_CHARS) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "chatId 非法");
    }
    const binding = requireBoundBinding(await getBinding(chatId));
    const current = await loadSettings();
    const preset = resolveWorldTurnPreset(current);
    if (!preset) {
      throw new AtlasError(ATLAS_ERROR_CODES.API_NOT_CONFIGURED, "未配置独立推演 API，无法生成请求预览。");
    }
    const prepared = await prepareWorldTurnInputs(binding, preset, {
      chatId,
      userMessageId: "preview",
      userText: typeof payload.userText === "string" ? payload.userText : "",
      assistantText: typeof payload.assistantText === "string" ? payload.assistantText : "",
      recentAssistantTexts: Array.isArray(payload.recentAssistantTexts)
        ? payload.recentAssistantTexts.filter((t): t is string => typeof t === "string")
        : [],
    });
    const messages = buildWorldTurnMessages(prepared.effectivePreset, prepared.input).map((m) => ({
      role: m.role,
      content: m.content,
      chars: m.content.length,
    }));
    // 生效来源判定（与 buildWorldTurnMessages 的分支一致）
    const hasSegments = Array.isArray(preset.promptSegments) && preset.promptSegments.length > 0;
    const promptSource = hasSegments ? "preset" : preset.systemPrompt ? "connection" : "builtin";
    const missing = {
      worldState: prepared.input.injectionText.trim().length > 0,
      lastTurn: (prepared.input.lastTurnSummary ?? "").length > 0,
      recentContext: (prepared.input.recentContextText ?? "").length > 0,
    };
    return okResult({
      messages,
      promptSource,
      protocol: prepared.protocol,
      promptPresetName: preset.name,
      contextTurnCount: Math.min(Math.max(typeof preset.contextTurnCount === "number" ? preset.contextTurnCount : 3, 1), 10),
      missing,
    });
  }

  /**
   * R06：开场识别（mode=bootstrap，duration=0）——已有开场白而尚无普通回合时，
   * 从真实剧情建立初始锚点，不必再发一个「只造地点不定位」的请求。
   * apply=false：预览解析结果（不写世界）；apply=true：一次 v2 提交（不推进时间），
   * 成功后把起始占位标记 retired（审计 + sidecar），并记录 lastConfirmed。
   */
  async function handleSceneBootstrap(body: unknown): Promise<AtlasRouteResult> {
    const payload = (body ?? {}) as {
      chatId?: unknown;
      apply?: unknown;
      userText?: unknown;
      assistantText?: unknown;
      recentAssistantTexts?: unknown;
      personaDescription?: unknown;
      charDescription?: unknown;
      loreSupplement?: unknown;
    };
    const chatId = typeof payload.chatId === "string" ? payload.chatId : "";
    if (!chatId || chatId.length > ATLAS_LIMITS.ID_CHARS) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "chatId 非法");
    }
    const binding = requireBoundBinding(await getBinding(chatId));
    const apply = payload.apply === true;
    const assistantText = typeof payload.assistantText === "string" ? payload.assistantText.trim() : "";
    if (!assistantText) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "开场材料（assistantText）为空——开场识别至少需要一段开场白。");
    }
    const userText = typeof payload.userText === "string" ? payload.userText : "";
    // 2. 未配置推演 API → 明确报错；RPM 保护
    const current = await loadSettings();
    const preset = resolveWorldTurnPreset(current);
    if (!preset) {
      throw new AtlasError(ATLAS_ERROR_CODES.API_NOT_CONFIGURED, "未配置独立推演 API，无法进行开场识别。");
    }
    checkRpm();

    const prepared = await prepareWorldTurnInputs(
      binding,
      preset,
      {
        chatId: binding.chatId,
        userMessageId: "bootstrap",
        userText,
        assistantText,
        recentAssistantTexts: Array.isArray(payload.recentAssistantTexts)
          ? payload.recentAssistantTexts.filter((t): t is string => typeof t === "string")
          : [],
        ...(typeof payload.loreSupplement === "string" ? { loreSupplement: payload.loreSupplement } : {}),
        ...(typeof payload.personaDescription === "string" ? { personaDescription: payload.personaDescription } : {}),
        ...(typeof payload.charDescription === "string" ? { charDescription: payload.charDescription } : {}),
      },
      { mode: "bootstrap" },
    );
    const world = prepared.world;

    // 恰好 1 条推演请求
    rpmTimestamps.push(now());
    const call = await callAtlasWorldTurnApi(prepared.effectivePreset, prepared.input, { fetchFn: deps.fetchFn, now });
    pushLog({
      at: now(),
      kind: "scene-bootstrap",
      chatId: binding.chatId,
      presetName: preset.name,
      model: preset.model,
      ok: call.ok,
      ...(call.ok ? {} : { code: call.code }),
      status: call.status,
      durationMs: call.durationMs,
      apply,
    });
    if (!call.ok) {
      throw new AtlasError(call.code, call.message, { retryable: call.retryable });
    }

    const cleanedText = applyContentReplaceRules(call.text, current.contentReplaceRules ?? []);
    const v2Sources: Record<string, string> = {
      "msg:u": userText,
      "msg:a": assistantText,
      ...(prepared.input.loreSupplement ? { lore: prepared.input.loreSupplement } : {}),
    };
    const v2Ctx = { baseRevision: binding.worldTimeCursor, sources: v2Sources };
    let v2result = parseAtlasWorldTurnDraftV2(cleanedText, v2Ctx);
    if (!v2result.ok && cleanedText !== call.text) {
      v2result = parseAtlasWorldTurnDraftV2(call.text, v2Ctx);
    }
    if (!v2result.ok) {
      pushLog({
        at: now(),
        kind: "scene-bootstrap-rejected",
        chatId: binding.chatId,
        errorCount: v2result.errors.length,
        errors: v2result.errors.slice(0, 10),
        excerpt: call.text.slice(0, 1500),
      });
      throw new AtlasError(
        ATLAS_ERROR_CODES.RESPONSE_MALFORMED,
        `开场识别输出未通过 v2 校验（${v2result.errors.length} 处）：${v2result.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join("；")}。可重试识别。`,
        { retryable: true },
      );
    }
    // bootstrap 铁律：只定位不推进时间
    const draft = { ...v2result.draft, duration: 0 };

    if (!apply) {
      return okResult({
        status: "preview",
        protocol: "v2",
        callCount: 1,
        baseRevision: binding.worldTimeCursor,
        scene: draft.scene,
        newLocations: draft.discoveries.locations.map((l) => ({ ref: l.ref, name: l.name, regionRef: l.regionRef })),
        newCharacters: draft.discoveries.characters.map((c) => ({ ref: c.ref, displayName: c.displayName, description: c.description.slice(0, 120) })),
        npcUpdates: draft.npcUpdates.map((u) => ({ entityRef: u.entityRef, locationRef: u.location.locationRef, presence: u.presence, status: u.status })),
        summary: draft.summary,
      });
    }

    // apply：一次 v2 提交（duration=0；时间游标不动，地点游标随 scene 锚定）
    const placeholder = detectStartPlaceholder(world);
    const sceneDoc = sanitizeSceneDoc(await store.read(sceneDocKey(world.id)).catch(() => null));
    const bootstrapRequest: AtlasTurnCommitRequest = {
      turnId: `bootstrap-${binding.worldTimeCursor}`,
      chatId: binding.chatId,
      userMessageId: `bootstrap-${binding.worldTimeCursor}`,
      assistantMessageId: "scene-identify",
      swipeId: null,
      userText,
      assistantText,
    };
    const output = applyAtlasV2Turn(world, {
      draft,
      request: bootstrapRequest,
      branchId: binding.branchId,
      currentTime: binding.worldTimeCursor,
      currentPointId: binding.currentLocationId ?? null,
      currentRegionId: pointRegionId(world, binding.currentLocationId ?? null),
      now: now(),
    });
    const receipt = output.receipt;
    if (receipt.status === "failed") {
      pushLog({ at: now(), kind: "scene-bootstrap-failed", chatId: binding.chatId, summary: receipt.summary });
      return okResult({ status: "failed", receipt });
    }

    // 成功：占位 retired（修订审计 + sidecar）+ lastConfirmed + bootstrap 簿记 + 世界/绑定落盘
    // 占位退役只在**真的锚定到地点**时执行——识别失败 / 诚实未知（无 locationRef）不迁移
    let finalWorld = output.world;
    let nextDoc: SceneDoc = { ...sceneDoc, bootstrap: { attempts: (sceneDoc.bootstrap?.attempts ?? 0) + 1, lastAt: now(), lastStatus: receipt.status } };
    if (receipt.status === "committed" && receipt.currentLocationId) {
      const retire = retireStartPlaceholder(finalWorld, nextDoc, { now: now(), info: placeholder });
      finalWorld = retire.world;
      nextDoc = retire.doc;
      nextDoc = { ...nextDoc, lastConfirmed: { branchId: binding.branchId, pointId: String(receipt.currentLocationId), at: receipt.currentTime } };
    }
    await store.write(`world:${binding.worldId}`, finalWorld);
    worldCache.set(binding.worldId, finalWorld);
    if (receipt.status === "committed") {
      const nextBinding: AtlasChatBinding = {
        ...binding,
        currentLocationId: receipt.currentLocationId ?? binding.currentLocationId,
        worldTimeCursor: receipt.currentTime,
      };
      await store.write(`binding:${binding.chatId}`, nextBinding);
      bindingCache.set(binding.chatId, nextBinding);
    }
    await store.write(sceneDocKey(world.id), nextDoc);
    if (output.refResolution.warnings.length > 0) {
      pushLog({ at: now(), kind: "scene-bootstrap-warnings", chatId: binding.chatId, warnings: output.refResolution.warnings.slice(0, 10) });
    }
    return okResult({
      status: receipt.status,
      receipt,
      refResolution: output.refResolution,
      placeholderRetired: nextDoc.retiredPointIds.length > sceneDoc.retiredPointIds.length,
      callCount: 1,
    });
  }

  /**
   * R03：回合输入装配的单一来源——commit / retry / 请求预览共用同一条路径，
   * 保证「预览看到的 = 模型实际收到的」（A10）。零 API、零存储写入。
   * 0.9.25 shujuku 占位符体系上下文装配：
   * $6 上轮推演结果 = 绑定分支内、游标前最后一条账本摘要；$7 前文 = 最近 N 条 AI 楼层。
   */
  async function prepareWorldTurnInputs(
    binding: AtlasChatBinding,
    preset: NonNullable<ReturnType<typeof resolveWorldTurnPreset>>,
    request: Pick<AtlasTurnCommitRequest, "chatId" | "userMessageId" | "userText" | "assistantText" | "recentAssistantTexts" | "loreSupplement" | "personaDescription" | "charDescription">,
    options?: { mode?: "turn" | "bootstrap" },
  ) {
    const world = await visibleWorldForBinding(await requireWorld(binding), binding);
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
    const input: AtlasWorldTurnPromptInput = {
      injectionText: prepareOutput.response.injectionText,
      userText: request.userText,
      assistantText: request.assistantText,
      // 0.9.21 世界书资料块：宿主侧卡书条目（有界），只进推演请求
      ...(request.loreSupplement ? { loreSupplement: request.loreSupplement } : {}),
      ...(lastTurnSummary ? { lastTurnSummary } : {}),
      ...(recentContextText ? { recentContextText } : {}),
      ...(request.personaDescription ? { personaDescription: request.personaDescription } : {}),
      ...(request.charDescription ? { charDescription: request.charDescription } : {}),
      // R06 v2：baseRevision = 世界时间游标（$B，模型必须逐字回显）
      baseRevision: binding.worldTimeCursor,
    };
    // R06 协议选择（提示词资产与输出协议分开版本）：
    // - v2（缺省）且作者未自定义提示词（无连接级 systemPrompt / 无预设分段）→ 内置 v2 封套；
    // - bootstrap 模式：追加开场识别任务段（duration=0，只定位不推进）；
    // - 作者自定义内容原样生效（混合模式：v1 输出仍由 v1 管线解析）。
    const protocol = (await loadSettings()).worldTurnProtocol ?? "v2";
    const authorOverridden = Boolean(preset.systemPrompt?.trim()) || (Array.isArray(preset.promptSegments) && preset.promptSegments.length > 0);
    let effectivePreset = preset;
    if (isV2ProtocolEnabled(protocol) && !authorOverridden) {
      const v2Segments = options?.mode === "bootstrap"
        ? [...DEFAULT_PROMPT_SEGMENTS_V2.slice(0, 4), { role: "user", name: "开场识别任务（mode=bootstrap）", mainSlot: "B", content: V2_BOOTSTRAP_TASK_CONTENT }, DEFAULT_PROMPT_SEGMENTS_V2[5]!]
        : DEFAULT_PROMPT_SEGMENTS_V2;
      effectivePreset = { ...preset, promptSegments: v2Segments.map((s) => ({ ...s })) };
    }
    return { world, prepareOutput, currentPointId, currentRegionId, input, recentAssistantTexts, effectivePreset, protocol };
  }

  /** commit / retry 共享的执行体：恰好 1 条 API 请求 + 原子提交。 */
  async function executeCommit(
    binding: AtlasChatBinding,
    request: AtlasTurnCommitRequest,
  ): Promise<AtlasRouteResult> {
    const world = await requireWorld(binding);
    const idempotencyKey = atlasCommitIdempotencyKey(request);
    // 回合映射存储键（0.9.42 起随会话往返；回执持久化进文档，跨请求 / 跨重启幂等）
    const turnDocKey = `turn:${binding.chatId}:${idempotencyKey}`;

    // 1. 幂等：已提交过 → 沿用原回执内容，status 标记为 duplicate，0 fetch
    if (receiptCache.has(idempotencyKey)) {
      const cached = receiptCache.get(idempotencyKey);
      return okResult({ receipt: { ...cached, status: "duplicate" }, duplicate: true });
    }
    const storedTurnDoc = (await store.read(turnDocKey)) as { receipt?: AtlasTurnReceipt; rolledBack?: boolean } | null;
    if (storedTurnDoc && storedTurnDoc.receipt && !storedTurnDoc.rolledBack) {
      receiptCache.set(idempotencyKey, storedTurnDoc.receipt);
      return okResult({ receipt: { ...storedTurnDoc.receipt, status: "duplicate" }, duplicate: true });
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
    // C7：prepareWorldTurnInputs 有副作用（装配注入文本与 pending 素材），必须保留调用；
    // 其返回的 prepareOutput 在本路径未被读取，原先的无用局部变量已删除。
    const prepared = await prepareWorldTurnInputs(binding, preset, request);

    const pending: StoredPendingCommit = {
      request,
      binding: {
        branchId: binding.branchId,
        currentPointId: prepared.currentPointId,
        currentRegionId: prepared.currentRegionId,
        worldTimeCursor: binding.worldTimeCursor,
      },
      savedAt: now(),
    };
    await store.write(`pending:${idempotencyKey}`, pending);

    // 5. 恰好 1 条推演请求
    rpmTimestamps.push(now());
    const call = await callAtlasWorldTurnApi(prepared.effectivePreset, prepared.input, { fetchFn: deps.fetchFn, now });
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
      // R05 协议分流：v2 草稿（schemaVersion:2）走独立契约与应用管线（临时引用 /
      // baseRevision 回显 / 证据包含校验）；无版本字段的输出仍走 v1 解析 + 裁定层。
      const looksV2 = /"schemaVersion"\s*:\s*2/.test(cleanedText) || /"schemaVersion"\s*:\s*2/.test(call.text);
      if (looksV2) {
        const v2Sources: Record<string, string> = {
          "msg:u": request.userText,
          "msg:a": request.assistantText,
          ...(request.loreSupplement ? { lore: request.loreSupplement } : {}),
        };
        const v2Ctx = { baseRevision: pending.binding.worldTimeCursor, sources: v2Sources };
        let v2result = parseAtlasWorldTurnDraftV2(cleanedText, v2Ctx);
        if (!v2result.ok && cleanedText !== call.text) {
          v2result = parseAtlasWorldTurnDraftV2(call.text, v2Ctx);
        }
        if (!v2result.ok) {
          pushLog({
            at: now(),
            kind: "world-turn-v2-rejected",
            chatId: request.chatId,
            presetName: preset.name,
            model: preset.model,
            errorCount: v2result.errors.length,
            errors: v2result.errors.slice(0, 10),
            excerpt: call.text.slice(0, 1500),
            // 0.9.54 A10：真实响应字符数（excerpt 只是截到 1500 的片段，长度不代表响应长度）
            responseChars: call.text.length,
          });
          throw new AtlasError(
            ATLAS_ERROR_CODES.RESPONSE_MALFORMED,
            `v2 协议校验失败（${v2result.errors.length} 处）：${v2result.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join("；")}。本轮未提交，世界与时间未变化；可重试推演。`,
            { retryable: true },
          );
        }
        rejectHiddenV2Refs(baseWorld, await visibleWorldForBinding(baseWorld, binding), v2result.draft);
        output = applyAtlasV2Turn(baseWorld, {
          draft: v2result.draft,
          request,
          branchId: pending.binding.branchId,
          currentTime: pending.binding.worldTimeCursor,
          currentPointId: pending.binding.currentPointId,
          currentRegionId: pending.binding.currentRegionId,
          now: now(),
        });
        if (output.refResolution.warnings.length > 0) {
          pushLog({
            at: now(),
            kind: "world-turn-v2-warnings",
            chatId: request.chatId,
            warnings: output.refResolution.warnings.slice(0, 10),
          });
        }
      } else {
        // 0.9.30 放宽格式校验：推理模型（MiniMax-M3 等）会把 JSON 写进 <think> 里——
        // 剥 think 后可能什么都不剩。解析失败先退回原文再试一次（保留有限格式修复）。
        // 0.9.48（T05）：两连败 = 明确失败，不再伪装成「无结构变化」成功提交——
        // 已付费但世界未更新的事实必须如实呈现：不推进游标、不写账本、不标记已提交。
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
            throw new AtlasError(
              ATLAS_ERROR_CODES.RESPONSE_MALFORMED,
              "推演输出无法解析为 JSON（已尝试剥 think 与原文回退）。本轮未提交，世界与时间未变化；安全诊断代码见日志页，可重试推演。",
              { retryable: true },
            );
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
      }
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
        // 0.9.54 A9：持久诊断只留安全代码；真实中文原因仍由失败 receipt.summary 呈现。
        reasonCode: "LEDGER_VALIDATION_FAILED",
        coreCommitted: false,
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

      // S7（0.9.55）：按**最终世界**的 parentPointId 与 createdPointIds 报告子图增量。
      // 只在真正 committed 时记（duplicate / failed 不报告创建成功）；
      // 只记数量、父子 ID 与最大层级，绝不记故事原文或地点名以外的自由文本。
      const parentById = new Map<number, number>();
      for (const point of settledWorld.points ?? []) {
        const pid = Number(point.parentPointId);
        if (Number.isInteger(pid) && pid > 0) parentById.set(Number(point.id), pid);
      }
      const createdWithParent = Array.from(parentById.keys()).filter((id) => {
        // 只统计本轮真正新增的点：提交前世界没有该 id
        const existedBefore = (world.points ?? []).some((p) => Number(p.id) === id);
        return !existedBefore;
      });
      if (createdWithParent.length > 0) {
        let maxDepth = 0;
        for (const id of createdWithParent) {
          let hops = 0;
          let cursor = parentById.get(Number(id));
          const seen = new Set<number>([Number(id)]);
          while (cursor !== undefined && !seen.has(cursor)) {
            seen.add(cursor);
            hops += 1;
            cursor = parentById.get(cursor);
          }
          maxDepth = Math.max(maxDepth, hops);
        }
        pushLog({
          at: now(),
          kind: "world-turn-hierarchy",
          chatId: request.chatId,
          worldId: binding.worldId,
          // pushLog 的数值白名单只放行 pointsAdded/pointsRemoved/skipped/scanned 等；
          // 这里用 pointsAdded=带父新增数、scanned=最大层级，不新增未登记字段。
          pointsAdded: createdWithParent.length,
          scanned: maxDepth,
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
    receiptCache.set(idempotencyKey, receipt);
    // ATLAS-06：楼层 ↔ 检查点稳定映射（swipe / 编辑 / 删除回退的依据）。
    // 0.9.48（T04 去重解耦）：回合记录不再以检查点存在为条件——检查点耗尽（200 上限）后
    // 幂等判定（turn: 文档 = 去重依据）依然有效，重复事件零新增模型调用。
    // checkpointId = null 表示该回合无回退点（UI 回退能力如实呈现，不假装可回退）。
    const priorPoints = new Set((world.points ?? []).map((point) => String(point.id)));
    const priorRegions = new Set((world.regions ?? []).map((region) => String(region.id)));
    const priorEntities = new Set([
      ...(world.characters ?? []).map((item) => String(item.id)),
      ...(world.entityRecords ?? []).map((item) => String(item.id)),
    ]);
    await store.write(`turn:${binding.chatId}:${idempotencyKey}`, {
      schemaVersion: 1,
      branchId: pending.binding.branchId,
      effectiveAt: receipt.currentTime,
      createdPointIds: (settledWorld.points ?? []).filter((item) => !priorPoints.has(String(item.id))).map((item) => String(item.id)),
      createdRegionIds: (settledWorld.regions ?? []).filter((item) => !priorRegions.has(String(item.id))).map((item) => String(item.id)),
      createdEntityIds: [
        ...(settledWorld.characters ?? []).map((item) => String(item.id)),
        ...(settledWorld.entityRecords ?? []).map((item) => String(item.id)),
      ].filter((id, index, all) => !priorEntities.has(id) && all.indexOf(id) === index),
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
        lastCommittedMessageId: binding.lastCommittedMessageId,
      },
    });
    // R12：pending.remove 是全局 store 的独立 IO，不在会话覆盖层内。失败不阻断
    // 响应（响应已带新 session，author 看到 commit 成功），留 orphan pending——
    // 由启动钩子调 reconcilePendingCommits 清理（atlas-pending-reconcile.ts）。
    try {
      await store.remove(`pending:${idempotencyKey}`);
    } catch (thrown) {
      pushLog({
        at: now(),
        level: "warn",
        kind: "pending-remove-failed",
        chatId: request.chatId,
        worldId: binding.worldId,
        idempotencyKey,
        message: `pending 文档删除失败（commit 已成功，将在下次启动 / 路由初始化时清理）：${thrown instanceof Error ? thrown.message : String(thrown)}`.slice(0, 300),
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
      // R05：v2 草稿的 discoveries 不携带 submap/description（子图层级 R09 接线），
      // geo 增量只存在于 v1 commitAtlasTurn 的输出。
      if ("geo" in output && output.geo && output.geo.createdPoints.length > 0) {
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
            const tree = buildSubMapTreeFromDraft(created.submap, {
              worldId: binding.worldId,
              pointId: key,
              now: now(),
            });
            for (const [mapId, submap] of Object.entries(tree)) {
              if (!doc.submaps[mapId]) {
                doc.submaps[mapId] = submap;
                changed = true;
              }
            }
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

    // R10：v2 mapScaleHints 落地。0.9.50 起标定存 maps sidecar 的 calibrations[mapId]；
    // 此前 v2 协议已解析 hints 但未应用。应用纪律：
    // - 走与 sidecar 同一容错通道（try/catch + 日志）——回合本身已 commit 成功，标定
    //   是增强数据，写失败不应阻断响应。
    // - frame 暂取默认 100×100（0.9.51 子图 schema 未持久化 cols/rows/frameRevision；hint
    //   frameRevision=null 时不校验；非 null 但默认不匹配 → skipped-frame-mismatch）。
    // - 人工锁定 / unknown / conflict / 数值校验不过 → 应用函数内部跳过，warn 入日志。
    if ("scaleHints" in output && output.scaleHints && output.scaleHints.length > 0) {
      try {
        const docKey = `maps:${binding.worldId}`;
        const doc = sanitizeMapDoc(await store.read(docKey).catch(() => null));
        const DEFAULT_FRAME: FrameRef = { cols: 100, rows: 100, frameRevision: 1 };
        const framesByMapId: Record<string, FrameRef> = { world: DEFAULT_FRAME };
        for (const [submapKey, submap] of Object.entries(doc.submaps)) {
          framesByMapId[submapKey] = submap.frame ?? DEFAULT_FRAME;
        }
        const results = applyScaleHintsToDoc(output.scaleHints, doc, {
          existing: doc.calibrations,
          framesByMapId,
          now: now(),
        });
        const applied = results.filter((r) => r.outcome === "applied");
        if (applied.length > 0) {
          await store.write(docKey, doc);
        }
        const skipped = results.filter((r) => r.outcome !== "applied");
        if (skipped.length > 0) {
          pushLog({
            at: now(),
            level: "warn",
            kind: "world-scale-hint-skipped",
            chatId: request.chatId,
            worldId: binding.worldId,
            skipped: skipped.map((s) => ({ mapId: s.mapId, outcome: s.outcome, reason: s.reason })),
          });
        }
        if (applied.length > 0) {
          pushLog({
            at: now(),
            kind: "world-scale-hint-applied",
            chatId: request.chatId,
            worldId: binding.worldId,
            applied: applied.map((a) => ({ mapId: a.mapId, metersPerCell: a.calibration?.metersPerCell })),
          });
        }
      } catch (thrown) {
        pushLog({
          at: now(),
          level: "error",
          kind: "world-scale-hint-failed",
          chatId: request.chatId,
          worldId: binding.worldId,
          summary: `v2 mapScaleHints 应用失败（回合本身已提交成功）：${thrown instanceof Error ? thrown.message : String(thrown)}`.slice(0, 300),
        });
      }
    }

    // 9. 0.9.31 首轮自动建图（作者需求：第一次推演生成当前地图，之后地图有了就不再重复）。
    //    条件：committed + 地图还只有起点（≤1 点）。红线例外记档：本轮最多第 2 条请求
    //    （推演 + 一次性建图），作者 2026-09-21 拍板。
    //    0.9.36 三修（作者实测「根本做不到地图的生成」）：
    //    ① 素材补当前楼层——recentAssistantTexts 是「前文」，明确排除当前楼层；首回合
    //       既无前文又常无卡书 → 提炼请求带着空素材必然 +0。本轮 assistantText 是
    //       首回合唯一的剧情来源，必须进提炼素材。
    //    ② 素材全空 → 不发请求也不烧标记（0.9.31~0.9.35 会白烧 1 条请求并永久放弃建图）。
    //    ③ 标记改「完成标记 + 尝试计数（上限 3）」——产出 0 / 失败不再永久放弃；
    //       旧形状标记（无 done，0.9.35 及之前烧毁）视为 0 次尝试，存量世界升级即自愈。
    if (receipt.status === "committed" && (settledWorld.points ?? []).length <= 1) {
      const markerKey = `geo-auto:${binding.worldId}`;
      const GEO_AUTO_ATTEMPTS_MAX = 3;
      const currentFloorText = typeof request.assistantText === "string" ? request.assistantText.trim() : "";
      const autoTexts = [
        ...prepared.recentAssistantTexts,
        ...(currentFloorText ? [currentFloorText.slice(0, 2000)] : []),
      ];
      const autoLore = typeof request.loreSupplement === "string" ? request.loreSupplement.trim() : "";
      if (autoTexts.length === 0 && !autoLore) {
        // 素材全空（无卡书 / 世界书资料关闭且无楼层）：不发请求，留待后续回合再试
      } else {
        let markerRecord: { done?: unknown; attempts?: unknown } | null = null;
        try {
          const raw = await store.read(markerKey);
          if (raw && typeof raw === "object" && !Array.isArray(raw)) {
            markerRecord = raw as { done?: unknown; attempts?: unknown };
          }
        } catch {
          markerRecord = null;
        }
        const attempts = typeof markerRecord?.attempts === "number" && Number.isFinite(markerRecord.attempts) && markerRecord.attempts >= 0
          ? Math.floor(markerRecord.attempts)
          : 0;
        const done = markerRecord?.done === true;
        if (!done && attempts < GEO_AUTO_ATTEMPTS_MAX) {
          await store.write(markerKey, { at: now(), attempts: attempts + 1 });
          try {
            const geo = await runGeoExtraction({
              world: settledWorld,
              preset,
              lore: autoLore,
              recentTexts: autoTexts,
              source: "auto",
            });
            if (geo.pointsAdded + geo.regionsAdded > 0) {
              await store.write(markerKey, { at: now(), done: true });
              receipt.summary = `${receipt.summary}；首轮自动建图：+${geo.regionsAdded} 地区 +${geo.pointsAdded} 地点`.slice(0, 480);
            } else {
              // 有素材但 0 产出（如模型没提炼出地理）：不烧毁机会，后续回合自动重试（上限 3 次）
              pushLog({
                at: now(),
                kind: "world-geo-auto",
                worldId: binding.worldId,
                ok: true,
                code: "ZERO_YIELD",
                message: `自动建图提炼 0 产出（第 ${attempts + 1}/${GEO_AUTO_ATTEMPTS_MAX} 次），留待后续回合重试`.slice(0, 200),
              });
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
      // 0.9.42 会话承载：回执持久化在回合映射文档里，跨请求可查
      const storedTurnDoc = (await store.read(`turn:${chatId}:${key}`)) as { receipt?: AtlasTurnReceipt; rolledBack?: boolean } | null;
      if (storedTurnDoc && storedTurnDoc.receipt && !storedTurnDoc.rolledBack) {
        receiptCache.set(key, storedTurnDoc.receipt);
        return okResult({ receipt: { ...storedTurnDoc.receipt, status: "duplicate" }, duplicate: true });
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


  /**
   * POST /worlds/move-author — 0.9.47 地图拖动纠偏（作者手动修位置）。
   * 作者在地图上把人物标点拖到目标地点：落账本事件（source="author"，可审计可回滚）
   * + CharacterState 权威位置（与日程结算同款 moveCharacterTo 校验：地点存在、地点归属地区一致）。
   * 主角（role ∈ 主角/玩家/观察者类）：额外推进绑定位置游标（游标端点）；
   *   账本校验只认 entityRecords，characters-only 的主角（自动建世 char-main）先确定性建档（0.9.37 同款）。
   * 时间游标不推进：纠偏是「现在」的事实修正，不是时间推进。
   */
  async function handleMoveAuthor(body: unknown): Promise<AtlasRouteResult> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "move-author 请求必须是对象");
    }
    const record = body as Record<string, unknown>;
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

    // 1. 权威位置写入（moveCharacterTo 校验地点归属地区一致；拒绝则零写入）
    const moved = moveCharacterTo(world, entityId, regionId, toPointId, now(), { branchId: binding.branchId });
    if (!moved.ok) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, moved.reason);
    }

    // 2. 账本审计事件（source="author"）：主角可能只在 characters（自动建世 char-main），
    //    账本校验只认 entityRecords → 先确定性建档（0.9.37 同款，只增不改）。
    const effect = parseStateEffect({
      kind: "moveEntity",
      entityId,
      ...(regionId ? { regionId } : {}),
      pointId: toPointId,
    });
    if (!effect) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "moveEntity effect 形状非法");
    }
    const provisioned = provisionReferencedCharacters(moved.world, [effect], now());
    const pointName = String(point.name ?? toPointId);
    const characterName = String(character.name ?? entityId);
    const appended = appendStateEvent(
      provisioned,
      {
        branchId: binding.branchId,
        at: binding.worldTimeCursor,
        source: "author",
        narrativeSummary: `作者纠偏：${characterName} 移动到 ${pointName}`.slice(0, 300),
        effects: [effect],
        entityRefs: [entityId],
      },
      { now: now() },
    );
    if (!appended.ok) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, appended.error);
    }
    const nextWorld = appended.value;
    const ledgerEventId = nextWorld.stateEvents?.[nextWorld.stateEvents.length - 1]?.id ?? "";

    // 3. 世界落会话覆盖层
    await store.write(`world:${binding.worldId}`, nextWorld);
    worldCache.set(binding.worldId, nextWorld);

    // 4. 主角：绑定位置游标同步到目标端点（位置游标 = 玩家事实位置）
    let cursorMoved = false;
    if (isProtagonistRole(character.role)) {
      const nextBinding: AtlasChatBinding = {
        ...binding,
        currentLocationId: toPointId,
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
      protagonist: cursorMoved,
    });
    return okResult({
      moved: { entityId, characterName, pointId: toPointId, pointName, regionId },
      ledgerEventId,
      cursorMoved,
      summary: `作者纠偏：${characterName} 移动到 ${pointName}`,
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
  // 0.9.42 存量迁移：旧独立文档（server data/ 或浏览器 extensionSettings KV）↔ 会话
  // -------------------------------------------------------------------------

  /** POST /session/export — 从全局 store 读旧世界文档，打包成会话文档返回（只读，不动旧档）。 */
  async function handleSessionExport(body: unknown): Promise<AtlasRouteResult> {
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
    const scene = await store.read(sceneDocKey(worldId));
    const geoAuto = await store.read(`geo-auto:${worldId}`);
    const turns: Record<string, unknown> = {};
    for (const key of await store.list(`turn:${chatId}:`)) {
      turns[key] = await store.read(key);
    }
    const session: AtlasSessionDoc = {
      ...createEmptySessionDoc(),
      ...(binding ? { binding } : {}),
      ...(world ? { world } : {}),
      ...(maps ? { maps } : {}),
      ...(scene ? { scene } : {}),
      turns,
      ...(geoAuto ? { geoAuto: { [worldId]: geoAuto } } : {}),
    };
    return okResult({ session, found: Boolean(world || binding) });
  }

  /** POST /session/purge — 迁移确认后清理全局 store 里的旧世界文档（本机会话限定）。 */
  async function handleSessionPurge(body: unknown, ctx: AtlasRequestContext): Promise<AtlasRouteResult> {
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
    await store.remove(sceneDocKey(worldId));
    await store.remove(`geo-auto:${worldId}`);
    const turnKeys = await store.list(`turn:${chatId}:`);
    for (const key of turnKeys) await store.remove(key);
    worldCache.delete(worldId);
    bindingCache.delete(chatId);
    return okResult({ purged: true, turnDocs: turnKeys.length });
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
      if (method === "GET" && route === "/settings") return await handleGetSettings(ctx);
      if (method === "PUT" && route === "/settings") return await handlePutSettings(body, ctx);
      if (method === "GET" && route === "/worlds") return await handleListWorlds();
      if (method === "POST" && route === "/worlds/import") return await handleImportWorld(body, ctx);
      if (method === "POST" && route === "/worlds/ensure-starter") return await handleEnsureStarter(body, ctx);
      if (method === "POST" && route === "/worlds/geo/adopt") return await handleGeoAdopt(body);
      if (method === "POST" && route === "/worlds/move-author") return await handleMoveAuthor(body);
      if (method === "POST" && route === "/worlds/scale/calibrate") return await handleScaleCalibrate(body);
      if (method === "POST" && route === "/bindings") return await handleBindings(body);
      if (method === "POST" && route === "/state") return await handleState(body);
      if (method === "POST" && route === "/map/image") return await handleMapImage(body);
      if (method === "POST" && route === "/turns/prepare") return await handlePrepare(body);
      if (method === "POST" && route === "/turns/preview") return await handleTurnPreview(body);
      if (method === "POST" && route === "/scene/bootstrap") return await handleSceneBootstrap(body);
      if (method === "POST" && route === "/scene/repair-start") return await handleLegacyStartRepair(body);
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

/**
 * Atlas 核心（0.9.42 会话承载外层）。
 *
 * - 非会话路由（health / settings / worlds 列表 / session export / purge）直接走全局实例。
 * - 会话路由（世界 / 绑定 / 回合相关）：从 body.session 解析会话文档 → 覆盖层 store →
 *   按请求创建单实例核心执行 → 响应带回新会话（rev+1），由浏览器写回 chatMetadata。
 * - rev 冲突检测：内存 registry 记每个聊天见过的最新 rev；携带更旧会话的变更请求
 *   返回 409 SESSION_STALE（双开同聊天防后写覆盖；registry 随进程重启清零，尽力而为）。
 */
export function createAtlasServerCore(deps: AtlasServerCoreDeps) {
  const shared: AtlasSharedRuntime = {
    rpmTimestamps: [],
    logs: [],
    settingsOverride: null,
    revByChat: new Map(),
    chatMutex: new Map(),
    ensureMutex: new Map(),
  };
  const globalCore = createCoreInstance(deps.store, deps, shared);

  async function handle(
    method: string,
    path: string,
    body: unknown,
    ctx: AtlasRequestContext = {},
  ): Promise<AtlasRouteResult> {
    try {
      const [, cleanPath = ""] = path.match(/^\/api\/plugins\/atlas(\/.*)$/) ?? [null, path];
      const route = (cleanPath ?? path).replace(/\/+$/, "") || "/";
      if (!ATLAS_SESSION_ROUTES.has(`${method} ${route}`)) {
        return await globalCore.handle(method, path, body, ctx);
      }
      const record = isPlainRecord(body) ? body : {};
      const session = parseAtlasSessionDoc(record.session);
      const chatId =
        (typeof record.chatId === "string" && record.chatId) || chatIdOfBinding(session.binding);
      const run = async (): Promise<AtlasRouteResult> => {
        if (chatId) {
          // rev 校验在互斥内：前一条请求落账后，后到的旧 rev 立即 409，绝不并发冲账
          const known = shared.revByChat.get(chatId);
          if (known !== undefined && known > session.rev) {
            throw new AtlasError(
              ATLAS_ERROR_CODES.SESSION_STALE,
              "世界数据已被其他窗口更新，请刷新页面或重新进入聊天后重试。",
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
        // 必须 await：异步 rejection 不经过 try/catch 的话，SESSION_STALE 会以未处理异常逃出 409 信封
        return await withSharedMutex(shared.chatMutex, chatId, run);
      }
      return run();
    } catch (thrown) {
      return errorResult(thrown);
    }
  }

  function rememberRev(chatId: string, rev: number): void {
    const current = shared.revByChat.get(chatId) ?? 0;
    if (rev > current) shared.revByChat.set(chatId, rev);
  }

  return {
    handle,
    /** 诊断 / 测试用：脱敏日志副本（含会话路由内产生的日志） */
    logs(): Record<string, unknown>[] {
      return shared.logs.map((entry) => ({ ...entry }));
    },
    /**
     * R12/R15：清理 orphan pending（commit 已成功但 pending 没删）。UI 启动钩子 / 调试用。
     * - 不带 session：对照裸 store（服务端模式 / 旧档迁移场景，turn 文档还在全局 store）。
     * - 带 session：turn: 文档在会话覆盖层（0.9.42 起），必须经 createSessionOverlayStore
     *   读当前会话的 turns 才能判定 orphan——裸 store 永远查不到，清了等于没清。
     *   只能覆盖当前聊天：其他聊天的 turn 在各自 chatMetadata 里，不可见 → 保留（宁留勿删）。
     */
    async reconcilePending(session?: AtlasSessionDoc | null): Promise<ReconcileReport> {
      const view = session ? createSessionOverlayStore(session, deps.store) : deps.store;
      const report = await reconcilePendingCommits(view);
      if (report.cleaned > 0 || report.errors.length > 0) {
        shared.logs.push({
          at: deps.now ? deps.now() : Date.now(),
          kind: "pending-reconcile",
          scanned: report.scanned,
          cleaned: report.cleaned,
          kept: report.kept,
          malformed: report.malformed,
          ...(report.errors.length > 0 ? { errors: report.errors.slice(0, 10) } : {}),
        });
      }
      return report;
    },
    /** 测试辅助：注入设置（跳过 PUT 校验流程；仅供测试进程使用） */
    __setSettingsForTest(next: Partial<AtlasServerSettingsV2>): void {
      shared.settingsOverride = { ...createDefaultSettingsV2(), ...next };
    },
  };
}

export type AtlasServerCore = ReturnType<typeof createAtlasServerCore>;
