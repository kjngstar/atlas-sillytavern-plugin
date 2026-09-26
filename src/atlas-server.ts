/**
 * atlas-server.ts — Atlas Server Plugin 纯 dispatch 核心。
 *
 * 边界（上级 README 第 4.4 / 7 / 11 节）：
 * - 所有端点逻辑在此集中，可被 node:test 以内存 store + mock fetch 完整覆盖；
 *   真实 Express 接线在 atlas-server-plugin/index.mjs（薄适配，不做业务）。
 * - 密钥只在 store 的 settings 文档与本模块的 Authorization 头中出现；
 *   任何响应 / 日志 / 错误只允许脱敏视图（maskPreset / serializeAtlasError）。
 * - prepare 零模型请求；commit 正常 1 条请求；引文错误导致零有效行时最多追加 1 次修正；重复提交 0 条新请求。
 * - 每聊天串行队列：同聊天同一时刻至多一个在途 commit / retry。
 * - RPM 保护：超过窗口限额直接 API_RATE_LIMITED，不发请求。
 * - 写入经 store；回合候选数据需通过校验后提交。
 */

import { sanitizeDiagnostic, type AtlasDiagnostic } from "./atlas-diagnostics.ts";
import type { EntityRecord, World } from "../lib/world-schema.ts";
import { parseWorld, branchScopeForStory } from "../lib/world-schema.ts";
import { settleNpcSchedules, mergeSettlementNotes, isProtagonistRole } from "./atlas-schedule.ts";
import { planBackgroundMoves, ATLAS_BACKGROUND_CELLS_PER_PERIOD } from "./atlas-background.ts";
import { reachableLocationsWithin } from "./atlas-signal-propagation.ts";
import type { AtlasBackgroundMove } from "./atlas-background.ts";
import {
  validateGeoTopology,
  geoEdgeId,
  geoAreaId,
  judgeGeoRelation,
  moveVehicleAnchor,
  cloneGeoTopology,
  ATLAS_GEO_LIMITS,
  ATLAS_GEO_PARENT_DEPTH_MAX,
  type AtlasGeoDiagnostic,
  type AtlasGeoEdge,
  type AtlasGeoMoveEvent,
  type AtlasGeoTopology,
  type AtlasGeoUndoEntry,
  type AtlasVehicleAnchor,
} from "./atlas-geo-topology.ts";
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
import { prepareAtlasTurn, provisionReferencedCharacters } from "./atlas-turn.ts";
import { projectWorldSubmaps, sanitizeMapDoc, mapDocOverCapLosses, SUBMAP_FRAME_DEFAULT, validateSubmapDepth, type AtlasMapDoc } from "./atlas-geo-apply.ts";
import { detectStartPlaceholder, resolveSceneStatus, retireStartPlaceholder, sanitizeSceneDoc, sceneDocKey, type SceneDoc } from "./atlas-scene.ts";
import { validateScaleResponse, roundPositiveScale, scaleCalibrationKey, type FrameRef, type MapScaleCalibration } from "./atlas-scale.ts";
import { buildLorebookPlans } from "./atlas-lorebook.ts";
import { reconcilePendingCommits, type ReconcileReport } from "./atlas-pending-reconcile.ts";
import {
  buildWorldTurnMessages,
  callAtlasWorldTurnApi,
  extractJsonObject,
  DEFAULT_PROMPT_SEGMENTS_TABLE_DELTA,
  TABLE_DELTA_BOOTSTRAP_TASK_CONTENT,
  type AtlasApiPreset,
  type AtlasWorldTurnPromptInput,
} from "./atlas-api-client.ts";
import {
  ATLAS_SETTINGS_SCHEMA_VERSION,
  applyLegacySettingsPatch,
  applySettingsCommand,
  createDefaultSettingsV2,
  migrateAtlasSettings,
  normalizeWorldTurnProtocol,
  resolveWorldTurnPreset,
  sanitizeSettingsV2,
  settingsViewV2,
  type AtlasServerSettingsV2,
  type AtlasSettingsCommand,
} from "./atlas-settings.ts";
import { validateAtlasTables, validateAtlasTablesStore, cloneAtlasTables, characterRowId, locationRowId, pointIdFromLocationRowId, refKindOf, ATLAS_ITEM_DESTROYED_STATUS, type AtlasCharacterRow, type AtlasLocationRow, type AtlasTablesStoreV1, type AtlasThreeTablesV1 } from "./atlas-tables.ts";
import { migrateLegacyToTables, tablesToLegacyWorld } from "./atlas-table-migration.ts";
import { applyAtlasEditText, parseAtlasEditBlock, type AtlasSignalProposalRow } from "./atlas-table-delta.ts";
import { projectTablesToMapView } from "./atlas-table-map-view.ts";
import { deriveElapsedPeriods } from "./atlas-time-intent.ts";
import {
  validateSimulationStore,
  applySimulationEffects,
  createEmptySimulation,
  createEmptySimulationBranch,
  cloneSimulationStore,
  type AtlasSimulationAcceptedEdit,
  type AtlasSimulationEvent,
  type AtlasSimulationMove,
  type AtlasSimulationStore,
  type AtlasSimulationUndoEntry,
} from "./atlas-simulation.ts";

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
  /**
   * A05：三表快照（按分支，见 `src/atlas-tables.ts`）。
   * null = 旧会话（尚未迁移）或 tables 校验未通过——两种情况的处理完全不同，
   * 因此解析结果另带 `tablesError`，调用方不得用 `tables === null` 推断「需要迁移」。
   */
  tables: AtlasTablesStoreV1 | null;
  /**
   * C04：会话级「后台推演模块」（见 `src/atlas-simulation.ts`）。
   * null = 旧会话（本字段不存在）或 simulation 校验未通过；两者处理完全不同，
   * 因此解析结果另带 `simulationError`，调用方**不得**用 `simulation === null` 推断「需要迁移」。
   */
  simulation: AtlasSimulationStore | null;
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
    tables: null,
    simulation: null,
  };
}

/** A05：tables 的具名迁移错误（拒绝使用损坏数据，但绝不改写旧会话原文）。 */
export type AtlasSessionTablesErrorCode =
  | "TABLE_SESSION_CORRUPT"
  | "TABLE_SESSION_WORLD_MISMATCH"
  | "TABLE_SESSION_NO_WORLD";

export interface AtlasSessionTablesError {
  code: AtlasSessionTablesErrorCode;
  path: string;
}

/** C05：simulation 的具名迁移错误（同样是「拒绝使用损坏数据，但绝不改写旧会话原文」）。 */
export type AtlasSessionSimulationErrorCode =
  | "SIMULATION_CORRUPT"
  | "SIMULATION_WORLD_MISMATCH"
  | "SIMULATION_NO_WORLD";

export interface AtlasSessionSimulationError {
  code: AtlasSessionSimulationErrorCode;
  path: string;
}

export interface AtlasSessionParseResult {
  session: AtlasSessionDoc;
  /** 会话原文（未解析）：tables / simulation 损坏时调用方必须原样保留它，不得回写空会话。 */
  raw: unknown;
  /** 未通过校验的原始 tables（不存在时为 undefined）；仅供导出 / 排障，绝不进引擎。 */
  rawTables: unknown;
  /** 具名错误；null = 没有 tables（旧会话）或 tables 合法。 */
  tablesError: AtlasSessionTablesError | null;
  /** C05：未通过校验的原始 simulation（不存在时为 undefined）；仅供导出 / 排障。 */
  rawSimulation: unknown;
  /** 具名错误；null = 没有 simulation（旧会话）或 simulation 合法。 */
  simulationError: AtlasSessionSimulationError | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 宽容解析：任何损坏形状按空会话处理（绝不抛错、绝不破坏浏览器侧数据）。
 * A05：三表单独校验——损坏时 session.tables 保持 null，并把具名错误交给调用方，
 * 附带原文与原始 tables，供「保留旧数据 + 明确提示」的路径使用。
 */
export function parseAtlasSessionDocDetailed(raw: unknown): AtlasSessionParseResult {
  const session = createEmptySessionDoc();
  const rawTables = isPlainRecord(raw) ? raw.tables : undefined;
  const rawSimulation = isPlainRecord(raw) ? raw.simulation : undefined;
  const result: AtlasSessionParseResult = {
    session, raw, rawTables, tablesError: null, rawSimulation, simulationError: null,
  };
  if (!isPlainRecord(raw) || raw.schemaVersion !== ATLAS_SESSION_SCHEMA_VERSION) return result;
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

  // tables 校验必须在 world 解析之后：跨世界判定要用会话绑定的世界 ID
  if (rawTables !== undefined && rawTables !== null) {
    const worldId = idOfDoc(session.world);
    if (worldId.length === 0) {
      result.tablesError = { code: "TABLE_SESSION_NO_WORLD", path: "$.tables" };
    } else {
      const validation = validateAtlasTablesStore(rawTables, { expectedWorldId: worldId });
      if (validation.ok) {
        session.tables = rawTables as AtlasTablesStoreV1;
      } else {
        const first = validation.errors[0]!;
        result.tablesError = {
          code: first.code === "CROSS_WORLD" ? "TABLE_SESSION_WORLD_MISMATCH" : "TABLE_SESSION_CORRUPT",
          path: first.path,
        };
      }
    }
  }

  // C05：simulation **单独**校验——三表合法而 simulation 损坏时，绝不能把三表一起误判为损坏。
  if (rawSimulation !== undefined && rawSimulation !== null) {
    const worldId = idOfDoc(session.world);
    if (worldId.length === 0) {
      result.simulationError = { code: "SIMULATION_NO_WORLD", path: "$.simulation" };
    } else {
      const validation = validateSimulationStore(rawSimulation, {
        expectedWorldId: worldId,
        tablesByBranch: simulationTablesByBranch(session.tables),
      });
      if (validation.ok) {
        session.simulation = rawSimulation as AtlasSimulationStore;
      } else {
        const first = validation.errors[0]!;
        result.simulationError = {
          code: first.code === "CROSS_WORLD" ? "SIMULATION_WORLD_MISMATCH" : "SIMULATION_CORRUPT",
          path: first.path,
        };
      }
    }
  }
  return result;
}

function rowIds(rows: unknown): { id: string }[] {
  if (!Array.isArray(rows)) return [];
  const out: { id: string }[] = [];
  for (const row of rows) {
    if (isPlainRecord(row) && typeof row.id === "string") out.push({ id: row.id });
  }
  return out;
}

/** C05：把已通过校验的三表按分支投影成推演校验所需的引用索引。 */
function simulationTablesByBranch(
  store: AtlasTablesStoreV1 | null,
): Record<string, { locations: { id: string }[]; characters: { id: string }[] }> {
  const view: Record<string, { locations: { id: string }[]; characters: { id: string }[] }> = {};
  if (!store || !isPlainRecord(store.branches)) return view;
  for (const [branchKey, tables] of Object.entries(store.branches)) {
    if (!isPlainRecord(tables)) continue;
    view[branchKey] = { locations: rowIds(tables.locations), characters: rowIds(tables.characters) };
  }
  return view;
}

export function parseAtlasSessionDoc(raw: unknown): AtlasSessionDoc {
  return parseAtlasSessionDocDetailed(raw).session;
}

/** 深拷贝（JSON 口径；响应本来就要过 JSON，不可序列化值按 undefined 丢弃）。tables 随会话一起拷贝。 */
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
  const OWNED_PREFIXES = ["world:", "binding:", "maps:", "scene:", "tables:", "simulation:", "geo-auto:", "turn:"];

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

  /** A06：三表快照的会话键（与 world / maps / scene 同一把世界锁）。 */
  function tablesName(): string | null {
    if (session.tables === null) return null;
    const worldId = idOfDoc(session.world);
    return worldId ? "tables:" + worldId : null;
  }

  /** C06：推演模块的会话键——只使用当前 session，绝不在全局 store 另开永久文件。 */
  function simulationName(): string | null {
    if (session.simulation === null) return null;
    const worldId = idOfDoc(session.world);
    return worldId ? "simulation:" + worldId : null;
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
      if (name.startsWith("tables:")) {
        // A06：三表没有旧独立文档可回退——会话里没有就是没有（旧会话由 A08 懒迁移）
        const current = tablesName();
        return current === name ? session.tables : null;
      }
      if (name.startsWith("simulation:")) {
        // C06：与 tables 同口径——会话里没有就是没有，绝不回退到全局 store
        const current = simulationName();
        return current === name ? session.simulation : null;
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
      if (name.startsWith("tables:")) {
        const worldId = name.slice("tables:".length);
        if (idOfDoc(session.world) !== worldId) {
          throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "三表快照与当前会话世界不一致，拒绝写入。");
        }
        // 键与快照自带的 worldId 也必须一致，否则同一个会话里会同时存在两个世界身份
        const valueWorldId = isPlainRecord(value) ? value.worldId : undefined;
        if (typeof valueWorldId === "string" && valueWorldId !== worldId) {
          throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "三表快照的 worldId 与会话世界不一致，拒绝写入。");
        }
        session.tables = value as AtlasTablesStoreV1 | null;
        mutated = true;
        return;
      }
      if (name.startsWith("simulation:")) {
        const worldId = name.slice("simulation:".length);
        // 拒绝跨世界 / 空绑定：键必须等于当前会话世界
        if (worldId.length === 0 || idOfDoc(session.world) !== worldId) {
          throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "推演模块与当前会话世界不一致，拒绝写入。");
        }
        const valueWorldId = isPlainRecord(value) ? value.worldId : undefined;
        if (typeof valueWorldId === "string" && valueWorldId !== worldId) {
          throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "推演模块的 worldId 与会话世界不一致，拒绝写入。");
        }
        session.simulation = value as AtlasSimulationStore | null;
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
      if (name.startsWith("tables:")) {
        if (tablesName() === name) {
          session.tables = null;
          mutated = true;
        }
        return;
      }
      if (name.startsWith("simulation:")) {
        if (simulationName() === name) {
          session.simulation = null;
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
        const tables = tablesName();
        if (tables && tables.startsWith(prefix)) names.push(tables);
        const simulation = simulationName();
        if (simulation && simulation.startsWith(prefix)) names.push(simulation);
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

/**
 * 该分支可见的世界：账本里由其他分支 / 未来回合创建的实体，按分支血缘与游标过滤掉。
 * （原为 `createCoreInstance` 内的闭包，A08 抽到模块级，供懒迁移复用同一份口径。）
 */
async function visibleWorldForBindingWith(
  store: AtlasDocumentStore,
  world: World,
  binding: AtlasChatBinding,
): Promise<World> {
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

/**
 * A08：真实旧会话的懒迁移入口（每个聊天只成功一次）。
 *
 * 纪律：
 * - 只在「`session.tables === null` 且解析无 tables 错误」时迁移；**损坏的 tables 绝不迁移、
 *   也绝不清空会话**（返回 `failed`，由 UI 提示用户导出 / 修复）。
 * - 只有合法世界 + 合法绑定 + 能确定分支作用域才生成三表；否则 `skipped`。
 * - 迁移输入是**该分支可见世界**（`visibleWorldForBindingWith`）+ 该分支游标，
 *   因此新分支拿到的是分叉基线，不会偷取另一分支的未来事实。
 * - 结果必须通过 A01 校验才写入；迁移结果**先挂到会话对象**（`session.tables`），
 *   由本次请求正常使用；是否落盘交给调用方原有的 `overlay.changed()` 判定——
 *   纯读请求（如 GET /state、只读检查）不得因此推 rev / 写 chatMetadata，
 *   而任何真正的写请求都会把带三表的会话随响应带回浏览器持久化。
 * - 重复运行不会新增行 / 改 ID：A03 是确定性纯函数，且首次成功后 `session.tables` 已存在。
 */
export type AtlasSessionTablesEnsureStatus = "migrated" | "skipped" | "failed";

export interface AtlasSessionTablesEnsureOutcome {
  status: AtlasSessionTablesEnsureStatus;
  reasonCode: string;
  branchKey?: string;
  rows?: { locations: number; characters: number; items: number };
  warnings?: number;
}

export async function ensureSessionTables(options: {
  session: AtlasSessionDoc;
  parse: AtlasSessionParseResult;
  overlay: AtlasDocumentStore & { changed(): boolean };
  store: AtlasDocumentStore;
  now: () => number;
  onDiagnostic?: (event: AtlasDiagnostic) => void;
}): Promise<AtlasSessionTablesEnsureOutcome> {
  const { session, parse } = options;
  const emit = (
    level: "debug" | "info" | "warn",
    outcome: "success" | "skipped" | "failed",
    code: string,
    reasonCode: string,
    count?: number,
  ): void => {
    try {
      const diagnostic = sanitizeDiagnostic({
        level, source: "storage", code, operation: "migration", phase: "session", outcome,
        details: { reasonCode, ...(count !== undefined ? { count } : {}) },
      }, options.now);
      if (diagnostic) options.onDiagnostic?.(diagnostic);
    } catch { /* 诊断绝不影响迁移本身 */ }
  };
  const skip = (reasonCode: string): AtlasSessionTablesEnsureOutcome => {
    emit("debug", "skipped", "TABLE_MIGRATION_SKIPPED", reasonCode);
    return { status: "skipped", reasonCode };
  };
  const fail = (reasonCode: string): AtlasSessionTablesEnsureOutcome => {
    emit("warn", "failed", "TABLE_MIGRATION_FAILED", reasonCode);
    return { status: "failed", reasonCode };
  };

  if (session.tables !== null) return skip("TABLE_ALREADY_PRESENT");
  if (parse.tablesError !== null) return fail(parse.tablesError.code);
  if (!isPlainRecord(session.world)) return skip("TABLE_NO_WORLD");
  const world = parseWorld(session.world);
  if (!world) return fail("TABLE_WORLD_UNPARSEABLE");
  const bindingParsed = parseAtlasChatBinding(session.binding);
  if (!bindingParsed.ok) return skip("TABLE_NO_BINDING");
  const binding = bindingParsed.value;
  if (String(world.id) !== binding.worldId) return fail("TABLE_WORLD_MISMATCH");
  // 分支作用域：正史线 → null（基线）；IF → 该 IF 的 story id；"canon" 是基线保留键，不允许被 IF 占用
  const scope = branchScopeForStory(world, binding.branchId);
  if (scope === "canon") return fail("TABLE_BRANCH_KEY_RESERVED");
  const branchKey = scope ?? "canon";

  const visible = await visibleWorldForBindingWith(options.store, world, binding);
  const mapsDoc = sanitizeMapDoc(await options.overlay.read(`maps:${binding.worldId}`).catch(() => null));
  const migrated = migrateLegacyToTables({
    world: visible,
    maps: mapsDoc,
    branchId: scope,
    at: binding.worldTimeCursor,
  });
  const validation = validateAtlasTables(migrated.tables);
  if (!validation.ok) {
    emit("warn", "failed", "TABLE_MIGRATION_FAILED", "TABLE_MIGRATION_INVALID", validation.errors.length);
    return { status: "failed", reasonCode: "TABLE_MIGRATION_INVALID" };
  }
  // 直接挂到会话对象（不调 overlay.write）：只读请求因此不会推 rev / 写 chatMetadata，
  // engine 侧经覆盖层 `tables:<worldId>` 正常读到；任何写请求都会把这棵会话树带回浏览器落盘。
  session.tables = {
    schemaVersion: 1,
    worldId: binding.worldId,
    branches: { [branchKey]: migrated.tables },
  };
  const rows = {
    locations: migrated.tables.locations.length,
    characters: migrated.tables.characters.length,
    items: migrated.tables.items.length,
  };
  emit("info", "success", "TABLE_MIGRATION_COMPLETE", "TABLE_MIGRATED", rows.locations + rows.characters + rows.items);
  return { status: "migrated", reasonCode: "TABLE_MIGRATED", branchKey, rows, warnings: migrated.warnings.length };
}

/**
 * E05：把三表重建到「回退后的世界」状态（纯函数 + 两次只读）。
 *
 * 用途：旧回合映射没有 `tablesBefore` 快照（行增量协议之前提交的回合）时，
 * `/turns/rollback` 只能按**回退后可见的世界**重新迁移一次——不借用其他分支、
 * 不制造空世界。与 A08 的懒迁移同一套口径（可见世界 + maps sidecar + 分支作用域）。
 */
async function rebuildBranchTablesFromWorld(options: {
  store: AtlasDocumentStore;
  binding: AtlasChatBinding;
  world: World;
  branchKey: string;
}): Promise<{ ok: true; tables: AtlasThreeTablesV1 } | { ok: false; reasonCode: string }> {
  // 分支作用域口径与 A08 完全一致：正史线 / 未知故事 → null（落保留键 "canon"）；
  // 只有 IF 的 story id 恰好叫 "canon" 时才冲突（D-08）。注意 `branchKey === "canon"`
  // 本身是**正常**情况（正史线就落在这个键上），不是错误。
  const scope = branchScopeForStory(options.world, options.binding.branchId);
  if (scope === "canon") return { ok: false, reasonCode: "TABLE_BRANCH_KEY_RESERVED" };
  const mapsDoc = sanitizeMapDoc(await options.store.read(`maps:${options.binding.worldId}`).catch(() => null));
  const visible = await visibleWorldForBindingWith(options.store, options.world, options.binding);
  const migrated = migrateLegacyToTables({
    world: visible,
    maps: mapsDoc,
    branchId: scope,
    at: options.binding.worldTimeCursor,
  });
  const validation = validateAtlasTables(migrated.tables);
  if (!validation.ok) return { ok: false, reasonCode: "TABLE_MIGRATION_INVALID" };
  return { ok: true, tables: migrated.tables };
}

/**
 * E03/E02/E01/E04：旧写入口（拖动纠偏 / 地理提炼 / 导入建世 / 场景定位）改完 `world` 之后，
 * 把该分支的三表按**新世界**补齐一次。
 *
 * 为什么必须有这一步：计划 §1 定的唯一写入规则是「迁移完成后实体现值以三表为准」，
 * 而 `table-delta` 回合只认三表。旧入口若只改世界镜像、不同步三表，下一次行增量回合
 * 就会把作者的修正**静默回退**（拖动纠偏最典型：作者把 A 拖到 B，下一回合三表说 A 还在原地）。
 *
 * 合并纪律（**只增不覆盖**）：
 * - 世界里**新出现**的地点行 / 人物行 → 追加进三表（地理提炼、纠偏顺手建档都靠这条）；
 * - 已存在的行**只**在同一实体位置确实变了时更新位置四元组（locationId / mapId / gridX / gridY）；
 * - 其余字段（想法 / 行动倾向 / 在场语义 / 持有人 / 物品状态）一律保留三表现值——
 *   它们是三表独有的事实，重新推导会把它们抹成空，等于用镜像覆盖真值；
 * - 不过 A01 校验就**不动三表**并记诊断，绝不让坏快照进会话；
 * - 该分支本来没有三表时什么都不做（旧会话由 A08 懒迁移按同一份世界建立，语义一致）。
 */
async function syncBranchTablesFromWorld(options: {
  store: AtlasDocumentStore;
  binding: AtlasChatBinding;
  world: World;
  /** 诊断来源（`worlds/move-author`、`worlds/geo/adopt`…），只进日志不落业务数据。 */
  source: string;
}): Promise<{ status: "skipped" | "synced" | "failed"; reasonCode: string; added: { locations: number; characters: number }; moved: number }> {
  const raw = await options.store.read(`tables:${options.binding.worldId}`).catch(() => null);
  const doc = isPlainRecord(raw) ? (raw as unknown as AtlasTablesStoreV1) : null;
  const branchKey = branchScopeForStory(options.world, options.binding.branchId) ?? "canon";
  const existingRaw = doc?.branches?.[branchKey];
  if (!isPlainRecord(existingRaw)) {
    return { status: "skipped", reasonCode: "TABLE_BRANCH_MISSING", added: { locations: 0, characters: 0 }, moved: 0 };
  }
  const existing = existingRaw as unknown as AtlasThreeTablesV1;
  const projected = await rebuildBranchTablesFromWorld({
    store: options.store,
    binding: options.binding,
    world: options.world,
    branchKey,
  });
  if (!projected.ok) {
    return { status: "failed", reasonCode: projected.reasonCode, added: { locations: 0, characters: 0 }, moved: 0 };
  }
  const next = cloneAtlasTables(existing);
  const locationIds = new Set(next.locations.map((row) => row.id));
  const characterIds = new Set(next.characters.map((row) => row.id));
  let addedLocations = 0;
  let addedCharacters = 0;
  let moved = 0;
  for (const row of projected.tables.locations) {
    if (locationIds.has(row.id)) continue;
    next.locations.push(row);
    addedLocations += 1;
  }
  for (const row of projected.tables.characters) {
    if (characterIds.has(row.id)) continue;
    next.characters.push(row);
    addedCharacters += 1;
  }
  // 已有行：只认「同一实体、位置确实变了」（拖动纠偏的落点、日程未覆盖的移动）
  const projectedCharacters = new Map(projected.tables.characters.map((row) => [row.id, row]));
  for (const row of next.characters) {
    const fresh = projectedCharacters.get(row.id);
    if (!fresh) continue;
    const changed = fresh.locationId !== row.locationId || fresh.mapId !== row.mapId
      || fresh.gridX !== row.gridX || fresh.gridY !== row.gridY;
    if (!changed) continue;
    row.locationId = fresh.locationId;
    row.mapId = fresh.mapId;
    row.gridX = fresh.gridX;
    row.gridY = fresh.gridY;
    row.positionSource = fresh.positionSource;
    moved += 1;
  }
  const validation = validateAtlasTables(next);
  if (!validation.ok) {
    return { status: "failed", reasonCode: "TABLE_SYNC_INVALID", added: { locations: 0, characters: 0 }, moved: 0 };
  }
  await options.store.write(`tables:${options.binding.worldId}`, {
    schemaVersion: 1,
    worldId: options.binding.worldId,
    branches: { ...(doc?.branches ?? {}), [branchKey]: next },
  });
  return {
    status: "synced",
    reasonCode: "TABLE_SYNCED_FROM_WORLD",
    added: { locations: addedLocations, characters: addedCharacters },
    moved,
  };
}

/* ------------------------------------------------------------------ *
 * H04 / H05：地理提炼的两趟规划（纯函数，零 IO、零模型、零写入）
 *
 * 第一趟（登记 / 解析唯一名称）在 `runGeoExtraction` 里完成：模型给的每个名字先解析到
 * 正式 `loc:*` id（已存在的**复用**，不存在的新建并分配 id）。第二趟（关系）就是本文件
 * 的 `planGeoRelations`：contained / adjacent / mobile 三项各自独立过证据与结构校验，
 * 不通过的一律进 `pending`（留待用户确认），**绝不硬写、也绝不丢掉已确认的地点**。
 *
 * 硬规则（对应 H04 / H05 的完成口径）：
 * - 只有**逐字出现在本轮世界书或正文里**的 `evidenceQuote` 才算证据；缺引文 → `NO_EVIDENCE`，
 *   引文找不到 → `QUOTE_NOT_FOUND`；
 * - 名字相似**不是**证据（「圣罗兰外城区」不会因为名字里含「圣罗兰城」而被写进城里）；
 * - 缺对端、自指、成环、超过 4 层 → 该关系进 pending，三表/拓扑一个字段都不写；
 * - 旧 `parentLocationId` **不因补地理而被改写**（H03）：已有人工/结构化父关系保持原样，
 *   新提的包含关系进 pending（`PARENT_KEPT_MANUAL`）；只有「原本无父 + 有确证引文」才落定。
 * ------------------------------------------------------------------ */

/** H04：模型可选的包含 / 邻接关系（缺省或证据不足一律按 pending / none 处理）。 */
export type AtlasGeoRelationKind = "contained" | "adjacent" | "none";

/** H05：可预览的提炼结果行 —— 字段与施工单 `{id,parent,adjacent,vehicle,pending,reasonCode}` 一字不差。 */
export interface AtlasGeoExtractPreviewRow {
  id: string;
  name: string;
  /** 已确认的包含关系（写入三表 `parentLocationId` / 世界镜像 `parentPointId`）。 */
  parent: string | null;
  /** 已确认的邻接对端（写入 `geoTopology.edges`，kind="adjacent"。 */
  adjacent: string[];
  /** 已确认的移动载具锚点（`stopped` 必须带停靠点；不明时 `unknown` + null）。 */
  vehicle: { atLocationId: string | null; status: "stopped" | "unknown" } | null;
  pending: boolean;
  reasonCode: string;
}

/** H05：证据不足 / 引用不明，**留待用户确认**的关系（绝不静默丢弃，也绝不硬写）。 */
export interface AtlasGeoPendingRelation {
  id: string;
  kind: "contained" | "adjacent" | "vehicle" | "anchor";
  fromLocationId: string | null;
  fromName: string;
  toName: string | null;
  reasonCode: string;
}

/** 关系规划用的地点索引项（三表现值 ∪ 世界镜像）。 */
export interface AtlasGeoPlanLocation {
  id: string;
  name: string;
  parentLocationId: string | null;
}

/** 关系规划用的候选（第一趟已把名字解析成正式 id）。 */
export interface AtlasGeoPlanCandidate {
  id: string;
  name: string;
  /** true = 该名字在已有地点里已经存在（复用既有地点，绝不新建同名点）。 */
  existing: boolean;
  relation: AtlasGeoRelationKind;
  /** contained = 上级（容器）名；adjacent = 邻接对端名。 */
  counterpartName: string | null;
  mobile: "vehicle" | "fixed" | null;
  anchorName: string | null;
  evidenceQuote: string | null;
}

export interface AtlasGeoRelationPlan {
  parents: Array<{ childId: string; parentId: string }>;
  adjacencies: Array<{ fromLocationId: string; toLocationId: string; evidence: "worldbook" | "story" }>;
  /**
   * H11：**载具路线**边（`kind="route"`、`channel="vehicle"`）。
   *
   * 来源与 adjacencies 同一份证据，但语义不同：候选本身是移动载具（`mobile="vehicle"`）时，
   * 「与某地相邻」对一辆车唯一可执行的解释就是**它往返的那条已确认路段**——H11 只认
   * 与载具本体地点行相连的 route 边，普通相邻边（channel="walk"）不会让车动起来。
   * 端点一定是「载具地点行 ↔ 对端地点」，因此 `moveVehicleAnchor` 的 `ROUTE_MISMATCH`
   * 守卫天然满足；没有引文的关系照样只进 pending。
   */
  routes: Array<{ fromLocationId: string; toLocationId: string; evidence: "worldbook" | "story" }>;
  vehicles: Array<{ locationId: string; atLocationId: string | null; evidence: "worldbook" | "story" }>;
  preview: AtlasGeoExtractPreviewRow[];
  pending: AtlasGeoPendingRelation[];
}

/**
 * H05 第二趟：把「已确认的关系」算出来，未确认的原样记进 `pending`。
 *
 * 纯函数：不改入参、不读存储、不发请求。调用方负责把结果落到
 * 世界镜像 / 三表 / maps.pointMeta / simulation.geoTopology（同一个候选会话一次写回）。
 */
export function planGeoRelations(input: {
  locations: readonly AtlasGeoPlanLocation[];
  candidates: readonly AtlasGeoPlanCandidate[];
  /** 引文核验：返回该引文来自哪份材料；null = 引文不在本轮材料里（不得当作证据）。 */
  quoteSource: (quote: string) => "worldbook" | "story" | null;
  /** parent 链最大层数（缺省 4，与 SUBMAP_DEPTH_MAX / ATLAS_GEO_PARENT_DEPTH_MAX 同口径）。 */
  maxDepth?: number;
}): AtlasGeoRelationPlan {
  const maxDepth = Number.isInteger(input.maxDepth) && (input.maxDepth as number) > 0
    ? (input.maxDepth as number)
    : 4;
  const norm = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, " ");

  /** 名称 → 正式 id 集合（同名不同 id = 歧义，必须留待用户确认）。 */
  const idsByName = new Map<string, Set<string>>();
  const addName = (name: string, id: string): void => {
    const key = norm(name);
    if (!key || !id) return;
    const bucket = idsByName.get(key) ?? new Set<string>();
    bucket.add(id);
    idsByName.set(key, bucket);
  };
  for (const row of input.locations) addName(row.name, row.id);
  for (const cand of input.candidates) if (!cand.existing) addName(cand.name, cand.id);

  const parentOf = new Map<string, string | null>();
  for (const row of input.locations) parentOf.set(row.id, row.parentLocationId);
  for (const cand of input.candidates) if (!parentOf.has(cand.id)) parentOf.set(cand.id, null);

  /** 沿父链上溯的跳数（根 = 0）；成环 / 父缺失返回 null。 */
  const hops = (id: string): number | null => {
    const seen = new Set<string>([id]);
    let cursor = parentOf.get(id) ?? null;
    let count = 0;
    while (cursor !== null) {
      if (seen.has(cursor)) return null;
      if (!parentOf.has(cursor)) return null;
      seen.add(cursor);
      count += 1;
      cursor = parentOf.get(cursor) ?? null;
    }
    return count;
  };
  /** 从 from 沿父链上溯是否能碰到 target（成环判定）。 */
  const reaches = (from: string, target: string): boolean => {
    const seen = new Set<string>();
    let cursor: string | null = from;
    while (cursor !== null && !seen.has(cursor)) {
      if (cursor === target) return true;
      seen.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
    return false;
  };

  const preview = new Map<string, AtlasGeoExtractPreviewRow>();
  const pending: AtlasGeoPendingRelation[] = [];
  const parents: AtlasGeoRelationPlan["parents"] = [];
  const adjacencies: AtlasGeoRelationPlan["adjacencies"] = [];
  const routes: AtlasGeoRelationPlan["routes"] = [];
  const vehicles: AtlasGeoRelationPlan["vehicles"] = [];

  const rowFor = (cand: AtlasGeoPlanCandidate): AtlasGeoExtractPreviewRow => {
    const found = preview.get(cand.id);
    if (found) return found;
    const created: AtlasGeoExtractPreviewRow = {
      id: cand.id,
      name: cand.name,
      parent: parentOf.get(cand.id) ?? null,
      adjacent: [],
      vehicle: null,
      pending: false,
      reasonCode: cand.existing ? "EXISTING_REUSED" : "NO_RELATION",
    };
    preview.set(cand.id, created);
    return created;
  };
  const markPending = (
    cand: AtlasGeoPlanCandidate,
    kind: AtlasGeoPendingRelation["kind"],
    toName: string | null,
    reasonCode: string,
  ): void => {
    const row = rowFor(cand);
    row.pending = true;
    if (row.reasonCode === "NO_RELATION" || row.reasonCode === "EXISTING_REUSED") row.reasonCode = reasonCode;
    pending.push({
      id: `${kind}|${norm(cand.name)}|${norm(toName ?? "")}`,
      kind,
      fromLocationId: cand.id,
      fromName: cand.name,
      toName,
      reasonCode,
    });
  };
  /** 引文凭据：非空且逐字命中本轮材料，才给出可写入的 evidence。 */
  const quoteOf = (cand: AtlasGeoPlanCandidate): { evidence: "worldbook" | "story" | null; reasonCode: string | null } => {
    const quote = typeof cand.evidenceQuote === "string" ? cand.evidenceQuote.trim() : "";
    if (!quote) return { evidence: null, reasonCode: "NO_EVIDENCE" };
    const source = input.quoteSource(quote);
    if (source === null) return { evidence: null, reasonCode: "QUOTE_NOT_FOUND" };
    return { evidence: source, reasonCode: null };
  };
  /**
   * 对端名字解析：0 个 → 未列出；≥2 个 → 重名歧义。两种都**不猜**，留待用户确认。
   * 名字只用于查找 id，绝不参与「像不像」的判定（H01 / H04）。
   */
  const resolveCounterpart = (
    rawName: string | null,
    missingCode: string,
  ): { id: string | null; reasonCode: string | null } => {
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name) return { id: null, reasonCode: missingCode };
    const bucket = idsByName.get(norm(name));
    if (!bucket || bucket.size === 0) return { id: null, reasonCode: missingCode };
    if (bucket.size > 1) return { id: null, reasonCode: "LOCATION_NAME_AMBIGUOUS" };
    return { id: [...bucket][0] ?? null, reasonCode: null };
  };

  for (const cand of input.candidates) {
    rowFor(cand);
    const judged = judgeGeoRelation({
      relation: cand.relation,
      evidenceQuote: cand.evidenceQuote,
      // 提炼来源只有 worldbook / story；`manual` 是用户在会话里显式确认，不走本函数
      evidence: null,
      fromName: cand.name,
      toName: cand.counterpartName ?? undefined,
    });

    if (judged.verdict === "contained" || judged.verdict === "adjacent") {
      const counterpart = resolveCounterpart(cand.counterpartName, "PARENT_UNRESOLVED");
      const quote = quoteOf(cand);
      // 失败原因按「引文 → 对端 → 结构」的顺序只报第一个（回执要指得出具体理由）
      if (quote.reasonCode !== null) {
        markPending(cand, judged.verdict, cand.counterpartName, quote.reasonCode);
      } else if (counterpart.reasonCode !== null) {
        markPending(cand, judged.verdict, cand.counterpartName, counterpart.reasonCode);
      } else if (counterpart.id === null) {
        markPending(cand, judged.verdict, cand.counterpartName, "PARENT_UNRESOLVED");
      } else if (counterpart.id === cand.id) {
        markPending(cand, judged.verdict, cand.counterpartName, "PARENT_SELF");
      } else if (judged.verdict === "adjacent") {
        const row = rowFor(cand);
        if (!row.adjacent.includes(counterpart.id)) row.adjacent.push(counterpart.id);
        // (A,B) 与 (B,A) 由 geoEdgeId 无向去重，这里按候选出现顺序给出，不去重也不重复报错
        if (cand.mobile === "vehicle") {
          // H11：移动载具的「相邻」= 它往返的那条已确认路段（route / vehicle），
          // 这样 H11 才有与载具本体相连的路线可走（普通 adjacent 边只能走人）。
          routes.push({
            fromLocationId: cand.id,
            toLocationId: counterpart.id,
            evidence: quote.evidence ?? "worldbook",
          });
        } else {
          adjacencies.push({
            fromLocationId: cand.id,
            toLocationId: counterpart.id,
            evidence: quote.evidence ?? "worldbook",
          });
        }
        row.reasonCode = "EVIDENCE_CONFIRMED";
      } else {
        const currentParent = parentOf.get(cand.id) ?? null;
        /**
         * H03：**旧 parent 不因补地理而被改写**。
         * 已有父关系（人工确认或既有结构化事实）原样保留；新提的包含关系进 pending。
         * 只有「原本没有父」的地点才接受本轮**有引文确证**的包含关系。
         */
        if (currentParent !== null && currentParent !== counterpart.id) {
          markPending(cand, "contained", cand.counterpartName, "PARENT_KEPT_MANUAL");
        } else if (currentParent === counterpart.id) {
          // 已经是这个父：无变化，不重写、不报错，如实标为已确认关系
          rowFor(cand).reasonCode = "EVIDENCE_CONFIRMED";
        } else if (reaches(counterpart.id, cand.id)) {
          markPending(cand, "contained", cand.counterpartName, "PARENT_CYCLE");
        } else {
          const parentHops = hops(counterpart.id);
          if (parentHops === null) {
            markPending(cand, "contained", cand.counterpartName, "PARENT_CYCLE");
          } else if (parentHops + 1 > maxDepth) {
            markPending(cand, "contained", cand.counterpartName, "PARENT_DEPTH_EXCEEDED");
          } else {
            parents.push({ childId: cand.id, parentId: counterpart.id });
            parentOf.set(cand.id, counterpart.id);
            const row = rowFor(cand);
            row.parent = counterpart.id;
            row.reasonCode = "EVIDENCE_CONFIRMED";
          }
        }
      }
    } else if (judged.verdict === "pending") {
      /**
       * 模型**声明了**关系，却没有可核验的引文（或引文不在本轮材料里）。
       *
       * 计划 H05 原文：「重名、缺 parent、环、**没有引文或引文不在世界书/正文**时把该关系
       * **留待用户确认**」。所以这里必须进 pending，而不是退化成「本来就没有关系」——
       * 作者要能看出「模型主张过这条关系、只是缺证据」，否则这条主张就被静默吞掉了。
       *
       * `judgeGeoRelation` 本来就返回 `verdict:"pending"` + `NO_EVIDENCE`，
       * 此前只是这个分支没被接住（只处理了 contained / adjacent）。
       */
      markPending(
        cand,
        cand.relation === "adjacent" ? "adjacent" : "contained",
        cand.counterpartName,
        judged.reasonCode ?? "NO_EVIDENCE",
      );
    }

    if (cand.mobile === "vehicle") {
      const quote = quoteOf(cand);
      if (quote.reasonCode !== null) {
        markPending(cand, "vehicle", null, quote.reasonCode);
      } else {
        const anchor = resolveCounterpart(cand.anchorName, "ANCHOR_UNRESOLVED");
        if (anchor.reasonCode !== null) {
          // 车确实存在（有引文），只是停靠点不明：锚点按 unknown 落库，同时留待用户确认位置
          markPending(cand, "anchor", cand.anchorName, anchor.reasonCode);
          const row = rowFor(cand);
          row.vehicle = { atLocationId: null, status: "unknown" };
          vehicles.push({ locationId: cand.id, atLocationId: null, evidence: quote.evidence ?? "worldbook" });
          if (row.reasonCode === "NO_RELATION" || row.reasonCode === "EXISTING_REUSED") row.reasonCode = anchor.reasonCode;
        } else if (anchor.id === cand.id) {
          markPending(cand, "anchor", cand.anchorName, "ANCHOR_SELF");
        } else {
          const row = rowFor(cand);
          row.vehicle = anchor.id === null
            ? { atLocationId: null, status: "unknown" }
            : { atLocationId: anchor.id, status: "stopped" };
          vehicles.push({
            locationId: cand.id,
            atLocationId: anchor.id,
            evidence: quote.evidence ?? "worldbook",
          });
          if (row.reasonCode === "NO_RELATION" || row.reasonCode === "EXISTING_REUSED") {
            row.reasonCode = "EVIDENCE_CONFIRMED";
          }
        }
      }
    }
  }

  return { parents, adjacencies, routes, vehicles, preview: [...preview.values()], pending };
}

/**
 * H18c：本轮**确实新建**了子图（宿主地点）的 mapId 列表 —— 纯函数、确定性、有界。
 *
 * 「新建了一张子图」= 该地点在提交后的三表里**有孩子**，**并且这个宿主地点本身就是本轮新增的**
 * ——例如本轮新建了「圣罗兰学校」，教室里同时落进学校子图（T27：学校 / 教室每图独立标定状态）。
 * mapId 用宿主地点的数字点位 id（与 `/worlds/scale/calibrate` 的 mapId 同口径）。
 *
 * 有意**不**把「给既有地点添房间」算进来（计入 `extendedCount`）：那只是扩充一张**已经存在**的
 * 子图，它的尺度状态属于该图既有标定 / 界面的人工流程；在这里再发一次模型请求既不是「新建图」，
 * 也会把一次普通回合变成两次请求。两种情形都不静默：调用方对排队数量记具名日志。
 *
 * `max`（缺省 2）之外的一律进 `queued`，同样由调用方记录名诊断，绝不静默少标。
 */
export function atlasNewSubmapHosts(input: {
  /** 本轮开始前就存在的地点行 id（不在这个集合里 = 本轮新增）。 */
  priorLocationIds: ReadonlySet<string>;
  locations: readonly { id: string; parentLocationId: string | null }[];
  max?: number;
}): { mapIds: string[]; queued: number; extendedCount: number } {
  const max = Number.isInteger(input.max) && (input.max as number) > 0 ? (input.max as number) : 2;
  const childCount = new Map<string, number>();
  const parentsWithNewChild = new Set<string>();
  for (const row of input.locations) {
    const parent = row.parentLocationId;
    if (parent === null) continue;
    childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
    if (!input.priorLocationIds.has(row.id)) parentsWithNewChild.add(parent);
  }
  const hosts: number[] = [];
  let extendedCount = 0;
  const seen = new Set<string>();
  for (const row of input.locations) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if ((childCount.get(row.id) ?? 0) === 0) continue;
    if (input.priorLocationIds.has(row.id)) {
      // 既有子图被扩充：不在这里发标定请求，只计数（调用方记日志，界面可手动触发）
      if (parentsWithNewChild.has(row.id)) extendedCount += 1;
      continue;
    }
    const pointId = pointIdFromLocationRowId(row.id);
    if (pointId === null) continue; // 子图键只能是数字点位 id
    hosts.push(pointId);
  }
  hosts.sort((a, b) => a - b);
  return {
    mapIds: hosts.slice(0, max).map((id) => String(id)),
    queued: Math.max(0, hosts.length - max),
    extendedCount,
  };
}

/**
 * C03：`table-delta-v1` 的上下文装配（有界纯函数）。
 *
 * §2 要求每轮只送：当前位置与上级链、附近行简写、与本轮相关的人物及少量远方关键人物、
 * 当前可见地图的 frame / 比例尺、上轮摘要（由 $6/$7 段负责）。
 * 「5 张地图 / 50 人物不能每回合整库重发」——因此这里全部按常量截断，并把**实际截取数量**
 * 返回给调用方记诊断，绝不静默裁掉。
 */
export const ATLAS_TABLE_CONTEXT_LIMITS = {
  /** 整段文本上限（字符）；超出先裁远方背景，当前位置链与必要 ID 永不裁。 */
  chars: 6000,
  /** 当前位置周围列出多少个地点（子地点优先，其次同父兄弟）。 */
  nearLocations: 24,
  /** 同地点 / 附近人物上限。 */
  characters: 30,
  /** 远方关键人物（有行动倾向的）上限。 */
  distantCharacters: 5,
  /** 本轮可见物品上限。 */
  items: 20,
} as const;

export interface AtlasTableContextInput {
  tables: AtlasThreeTablesV1;
  world: World;
  binding: Pick<AtlasChatBinding, "currentLocationId" | "branchId" | "worldTimeCursor">;
  maps?: AtlasMapDoc | null;
}

export interface AtlasTableContextResult {
  text: string;
  /** 实际被截掉的行数（记诊断用；不静默）。 */
  truncated: { locations: number; characters: number; items: number };
}

/**
 * E05：自定义提示词的**形态检查**（纯字符串判定，零 IO）。
 *
 * 目的：作者可能还留着一份 v1/v2 时代的自定义提示词。把它原样送给增量解析器，
 * 只会得到一句 "response malformed"，作者看不出真实原因。这里在**发请求之前**认出来，
 * 并给出迁移入口：
 * - `table-delta`：正文里已经有 `<atlasEdit>` 块格式 → 兼容，照常发送；
 * - `legacy-v2`：出现 v2 封套字段（`"schemaVersion": 2` / `narrativeSummary` / `mapScaleHints`…）；
 * - `legacy-v1`：只出现旧 v1 草稿字段（`"duration"` 与 `"summary"` 同现、`npcChanges`）；
 * - `unknown`：既没有块格式也没有任何旧协议特征 → 允许（纯粹是作者措辞），只在预览里提示一次。
 */
export type AtlasLegacyPromptShape = "none" | "table-delta" | "legacy-v1" | "legacy-v2" | "unknown";

export function detectLegacyPromptShape(text: string): AtlasLegacyPromptShape {
  const value = typeof text === "string" ? text : "";
  if (value.trim().length === 0) return "none";
  if (value.includes("<atlasEdit>") || value.includes("atlasEdit")) return "table-delta";
  if (/"schemaVersion"\s*:\s*2/.test(value)
    || /narrativeSummary|mapScaleHints|discoveries|identityUpdates|relationUpdates|baseRevision|locationChange/.test(value)) {
    return "legacy-v2";
  }
  if (/"duration"\s*:/.test(value) || /"summary"\s*:/.test(value) || /npcChanges|memoryDrafts|eventDrafts|triggerResults/.test(value)) {
    return "legacy-v1";
  }
  return "unknown";
}

/** E05：旧协议自定义提示词的阻断文案（给出可执行的迁移入口，不静默替换原文）。 */
export function legacyPromptBlockMessage(shape: AtlasLegacyPromptShape): string {
  const label = shape === "legacy-v1" ? "旧「v1 世界草稿」" : "旧「v2 世界封套」";
  return `提示词预设里仍是${label}的输出格式，而当前唯一契约是「表格增量」（一个 <atlasEdit> 块，块内每行一个独立 JSON）。`
    + "为避免把不兼容的提示词送进增量解析器，本轮**在发请求之前**就停下（零 API 调用、世界与时间未变化）。"
    + "迁移入口：到「推进」页点「创建兼容增量草稿」（会新建一份预设，原文保留不动），或改用内置默认六段。";
}

/** 当前地点在表里的行（binding.currentLocationId 是旧世界点 id，需按行 id 方案换算）。 */
function currentLocationRow(tables: AtlasThreeTablesV1, currentLocationId: string | null | undefined): AtlasLocationRow | null {
  if (typeof currentLocationId !== "string" || currentLocationId.length === 0) return null;
  const rowId = currentLocationId.startsWith("loc:") ? currentLocationId : locationRowId(currentLocationId);
  return tables.locations.find((row) => row.id === rowId) ?? null;
}

/** 上级链：从根到当前地点（含自身）。 */
function locationChain(tables: AtlasThreeTablesV1, row: AtlasLocationRow): AtlasLocationRow[] {
  const byId = new Map(tables.locations.map((item) => [item.id, item]));
  const chain: AtlasLocationRow[] = [];
  const seen = new Set<string>();
  let cursor: AtlasLocationRow | undefined = row;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.unshift(cursor);
    cursor = cursor.parentLocationId === null ? undefined : byId.get(cursor.parentLocationId);
  }
  return chain;
}

function characterLine(row: AtlasCharacterRow): string {
  const bits = [`${row.id}=${row.name}`];
  bits.push(`在场:${row.presence}`);
  if (row.thought) bits.push(`想法:${row.thought}`);
  if (row.actionTendency) bits.push(`倾向:${row.actionTendency}`);
  if (row.currentAction) bits.push(`当前:${row.currentAction}`);
  return bits.join("｜");
}

export function buildTableDeltaContext(input: AtlasTableContextInput): AtlasTableContextResult {
  const tables = input.tables;
  const current = currentLocationRow(tables, input.binding.currentLocationId);
  const lines: string[] = [];
  const truncated = { locations: 0, characters: 0, items: 0 };

  // 1) 当前位置与上级链（永不被裁）
  if (current) {
    const chain = locationChain(tables, current);
    lines.push(`【当前位置】${chain.map((row) => `${row.id}=${row.name}`).join(" > ")}`);
    if (current.description) lines.push(`【当前地点描述】${current.description}`);
  } else {
    lines.push("【当前位置】未知（对照表里没有当前地点；不要猜，需要时先登记新地点）");
  }

  // 2) 附近行简写：子地点优先，其次同父兄弟
  const currentId = current?.id ?? null;
  const children = currentId === null ? [] : tables.locations.filter((row) => row.parentLocationId === currentId);
  const siblings = currentId === null || current === null
    ? []
    : tables.locations.filter((row) => row.id !== currentId && row.parentLocationId === current.parentLocationId);
  const near = [...children, ...siblings];
  const nearShown = near.slice(0, ATLAS_TABLE_CONTEXT_LIMITS.nearLocations);
  truncated.locations = Math.max(0, near.length - nearShown.length);
  if (nearShown.length > 0) {
    lines.push(`【附近地点】${nearShown.map((row) => `${row.id}=${row.name}${row.id === currentId ? "(当前)" : ""}`).join("；")}`);
  }

  // 3) 相关人物：当前位置及其子地点的人优先，再补少量有行动倾向的远方人物
  const nearIds = new Set<string>([...(currentId === null ? [] : [currentId]), ...nearShown.map((row) => row.id)]);
  const nearbyCharacters = tables.characters.filter((row) => row.locationId !== null && nearIds.has(row.locationId));
  const distantCharacters = tables.characters.filter((row) =>
    !nearbyCharacters.includes(row) && row.actionTendency.trim().length > 0);
  const charactersShown = [
    ...nearbyCharacters.slice(0, ATLAS_TABLE_CONTEXT_LIMITS.characters),
    ...distantCharacters.slice(0, ATLAS_TABLE_CONTEXT_LIMITS.distantCharacters),
  ];
  truncated.characters = Math.max(0, tables.characters.length - charactersShown.length);
  if (charactersShown.length > 0) {
    lines.push(`【人物】\n${charactersShown.map(characterLine).join("\n")}`);
  }

  // 4) 本轮可见物品：附近地点上的地面物品 + 已列出人物手里的东西
  const shownCharacterIds = new Set(charactersShown.map((row) => row.id));
  const visibleItems = tables.items.filter((row) =>
    row.status !== ATLAS_ITEM_DESTROYED_STATUS
    && ((row.locationId !== null && nearIds.has(row.locationId))
      || (row.holderCharacterId !== null && shownCharacterIds.has(row.holderCharacterId))));
  const itemsShown = visibleItems.slice(0, ATLAS_TABLE_CONTEXT_LIMITS.items);
  truncated.items = Math.max(0, visibleItems.length - itemsShown.length);
  if (itemsShown.length > 0) {
    lines.push(`【物品】${itemsShown.map((row) => row.holderCharacterId !== null
      ? `${row.id}=${row.name}(由 ${row.holderCharacterId} 持有)`
      : `${row.id}=${row.name}(在 ${row.locationId ?? "位置未知"})`).join("；")}`);
  }

  // 5) 当前地图的 frame 与比例尺（没有标定就写「未标定」，不编数字）
  const mapId = current?.mapId ?? "world";
  const frame = input.maps?.submaps?.[mapId]?.frame ?? { cols: 100, rows: 100, frameRevision: 1 };
  const calibration = input.maps?.calibrations?.[mapId] ?? null;
  lines.push(calibration
    ? `【地图】${mapId}：${frame.cols}×${frame.rows} 格；每格 ${calibration.metersPerCell} 米（来源：${calibration.source}${calibration.locked ? "，人工锁定" : ""}）。不要自行换算距离或时间。`
    : `【地图】${mapId}：${frame.cols}×${frame.rows} 格；未标定（按格计算）。不要自行编造距离或时间。`);

  // 6) 可用 ID 对照（必要 ID 必须留下；其余按上限截断）
  const locationRoster = tables.locations.slice(0, 80).map((row) => `${row.id}=${row.name}`).join("；");
  const characterRoster = tables.characters.slice(0, 48).map((row) => `${row.id}=${row.name}`).join("；");
  lines.push(`【地点 id 对照】${locationRoster || "（空）"}`);
  lines.push(`【人物 id 对照】${characterRoster || "（空）"}`);
  if (truncated.locations + truncated.characters + truncated.items > 0) {
    lines.push(`【截断说明】地点 ${truncated.locations} 行、人物 ${truncated.characters} 行、物品 ${truncated.items} 行未随本轮下发（需要时用 ID 对照表里的正式 ID 引用）。`);
  }

  let text = lines.join("\n");
  if (text.length > ATLAS_TABLE_CONTEXT_LIMITS.chars) {
    // 超预算先裁远方背景（人物段之后的物品与截断说明），位置链与 ID 对照始终保留在最前面
    const head = lines.slice(0, lines.findIndex((line) => line.startsWith("【人物】")) + 1).join("\n");
    const rosterLines = lines.filter((line) => line.startsWith("【地点 id 对照】") || line.startsWith("【人物 id 对照】")).join("\n");
    text = `${head}\n【预算提示】本轮上下文超限，已省略远处背景；请只依据上面的位置链与 ID 对照输出变化。\n${rosterLines}`;
  }
  return { text: text.slice(0, ATLAS_TABLE_CONTEXT_LIMITS.chars), truncated };
}

/**
 * C05：`table-delta-v1` 的一次回合提交（纯函数，零 IO）。
 *
 * 顺序严格按计划 §3-C05：
 *   候选三表（B06 应用行增量）
 *   → 旧世界兼容镜像（A04）
 *   → 旧 `settleNpcSchedules` **恰好一次**
 *   → 把日程造成的 NPC 移动**回写三表**（否则"人物移动成功、附近不变"会重演）
 *   → 最终候选再过一次 A01 校验（不过就整轮回退，调用方不会写任何东西）。
 *
 * 时间只由**用户文本里的显式时间词**决定（`extractAtlasTimeIntent`），绝不采信模型给的数字；
 * 没有时间词就是 0 段（短对话默认不推进）。
 */
export interface AtlasTableDeltaCommitInput {
  /** 该分支当前的三表快照（已通过 A01 校验）。 */
  tables: AtlasThreeTablesV1;
  /** 完整的 tables 文档（用于保留其他分支的快照）。 */
  tablesDoc: AtlasTablesStoreV1 | null;
  branchKey: string;
  /** 镜像基底世界（已含回合前检查点）。 */
  baseWorld: World;
  binding: AtlasChatBinding;
  request: { userText: string; assistantText: string };
  /** 模型原始输出（内容替换规则由调用方先跑）。 */
  text: string;
  now: number;
  protectedCharacterIds?: ReadonlySet<string>;
  /**
   * D01：本分支**已确认**的地理拓扑。有它时超距 / 跨图目标沿确认边逐段接近，
   * 取代 0.9.58 的「>60 格永久 TOO_FAR」；没有就保持原语义（不猜路径）。
   */
  topology?: AtlasGeoTopology | null;
  /**
   * H11：本轮回合键（调用方传幂等键）。载具移动事件的 id 由它 + 序号 + 载具 + 状态确定性拼出，
   * 因此「同一回合重复提交」不会产生第二份事件；缺省时按 chatId + 提交时刻派生（仍确定性）。
   */
  turnKey?: string;
}

export interface AtlasTableDeltaCommitOk {
  ok: true;
  world: World;
  receipt: AtlasTurnReceipt;
  tablesDoc: AtlasTablesStoreV1;
  branchKey: string;
  applied: number;
  rejected: number;
  /** 日程结算已在本函数内完成——调用方**不要**再结算一次。 */
  settled: true;
  /** E07：后台自主行动的可播报摘要（人数口径；调用方转成 pushLog 事件）。 */
  background: { at: number; kind: string; moves: number; skipped: number; scanned: number };
  /**
   * C08：本轮**被接受**的行级回执（`table`/`op`/正式 id），供推演侧推导意图与移动。
   * 只带 id 与操作，**不带任何正文**，因此可以安全地进 HTTP / UI 日志。
   */
  acceptedRows: AtlasAcceptedRowReceipt[];
  /** Rejected rows also survive partial commits for complete, safe diagnostics. */
  rejectedRows: Array<{ line: number; code: string; path?: string; ref?: string }>;
  /** C08：日程结算造成的具名移动（人物 + 地点），供推演侧与回执核对。 */
  scheduleMoves: AtlasScheduleMoveReceipt[];
  /** C08：后台自主行动的**全量具名动作**（不只人数），为阶段 D 提供 effect 输入。 */
  backgroundMoves: AtlasBackgroundMove[];
  /**
   * E04：本块中通过校验的 `simulation.propose` 候选（待传播事实）。
   * 由调用方交给 `applySimulationEffects`，**不**在这里写入任何状态。
   */
  signalProposals: AtlasSignalProposalRow[];
  /**
   * H11：本轮**载具行动**的结果 —— 新的 geoTopology（null = 拓扑未变）、逐辆具名动作、
   * 精确 undo 与诊断。由调用方写进同一份候选会话（`simulation.branches[].geoTopology`），
   * 并把 undo 追加进 `turn.simulationUndo`（C10 回退）。
   */
  vehicleTopology: AtlasGeoTopology | null;
  vehicleMoves: AtlasVehicleMoveReceipt[];
  vehicleUndo: AtlasGeoUndoEntry[];
  vehicleDiagnostics: AtlasGeoDiagnostic[];
}

export interface AtlasAcceptedRowReceipt {
  line: number;
  table: "location" | "character" | "item" | "unknown";
  op: string;
  /** 正式行 id（`loc:*` / `npc:*` / `item:*`）。 */
  ref: string;
}

export interface AtlasScheduleMoveReceipt {
  characterId: string;
  characterName: string;
  pointId: string;
  fromPointId: string | null;
}

export interface AtlasTableDeltaCommitFailure {
  ok: false;
  code: "PARSE_REJECTED" | "DELTA_REJECTED";
  message: string;
  rejectedRows: Array<{ line: number; code: string; path?: string; ref?: string }>;
}

/**
 * H11：载具行动的唯一生产入口 —— 把「哪个锚点走哪条已确认路线、还剩几段」算成
 * `moveVehicleAnchor` 的调用，并按「停靠 → 在途 → 到达」逐辆推进。
 *
 * 纯函数：不读存储、不发请求、不改入参（`moveVehicleAnchor` 返回的始终是深拷贝）。
 *
 * 规则（每条都对应 §2.5 / H11 的硬约束）：
 * - **0 时段不动**：`periods ≤ 0` 直接返回空计划，连事件都不产生；
 * - **只走已确认路线**：只认 `kind="route"` 且 channel 为 walk / vehicle 的边，且该边必须
 *   与**载具本体地点行**相连（与 H11 的 `ROUTE_MISMATCH` 同口径）；没有这样的边 → 不动，
 *   计入 `unrouted`（调用方记日志），绝不猜一条路；
 * - **状态不明不动**：`status="unknown"` 或「停靠但没有确认地点」的锚点一律跳过（人工确认走 H07a）；
 * - **剩余时段只由已确认几何推出**：起讫两点在同一张图且都有已确认格坐标时，
 *   `remainingPeriods = ceil(格距 / 每段格数)`；跨图 / 缺坐标 → `null`
 *   （H11 会保持 en-route + `TRAVEL_PERIODS_UNKNOWN`，**绝不到达**、绝不猜米数）；
 * - **车厢内人物不被本函数触碰**：乘员相对车厢的位置不变（§2.5），乘员世界位置由锚点解析；
 * - 每轮最多 `maxMoves` 辆（缺省 2），其余计入 `skipped`（具名日志，不静默少动）。
 */
export interface AtlasVehicleMoveReceipt {
  vehicleLocationId: string;
  eventId: string;
  status: AtlasGeoMoveEvent["status"];
  fromLocationId: string | null;
  toLocationId: string | null;
  routeEdgeId: string | null;
  reasonCode: string | null;
  periods: number;
  remainingPeriods: number | null;
  crewCharacterIds: string[];
}

export function planVehicleMoves(input: {
  topology: AtlasGeoTopology | null;
  locations: readonly AtlasLocationRow[];
  characters: readonly AtlasCharacterRow[];
  /** 本次可用的完整新时段数；0 = 时间未推进 → 载具一动不动。 */
  periods: number;
  turnKey: string;
  /** 时段号，仅回带进事件。 */
  period?: number | null;
  maxMoves?: number;
  /** 每时段可走格数（缺省与后台人物行动同一常量：不发明载具速度）。 */
  cellsPerPeriod?: number;
}): {
  topology: AtlasGeoTopology | null;
  moves: AtlasVehicleMoveReceipt[];
  undo: AtlasGeoUndoEntry[];
  diagnostics: AtlasGeoDiagnostic[];
  /** 有锚点但**没有已确认路线**（或状态不明）而没动的载具数。 */
  unrouted: number;
  /** 因为每轮上限没排上的载具数。 */
  skipped: number;
  candidateCount: number;
} {
  const empty = {
    topology: null,
    moves: [] as AtlasVehicleMoveReceipt[],
    undo: [] as AtlasGeoUndoEntry[],
    diagnostics: [] as AtlasGeoDiagnostic[],
    unrouted: 0,
    skipped: 0,
    candidateCount: 0,
  };
  const topology = input.topology;
  if (!topology || !Array.isArray(topology.vehicles) || topology.vehicles.length === 0) return empty;
  const periods = Math.max(0, Math.floor(input.periods));
  // 0 时段：车辆一个字段都不动（§2.5 第 0 时段规则），也不产生 blocked 噪声
  if (periods <= 0) return { ...empty, candidateCount: topology.vehicles.length };

  const maxMoves = Number.isInteger(input.maxMoves) && (input.maxMoves as number) > 0
    ? (input.maxMoves as number)
    : 2;
  const cellsPerPeriod = Number.isFinite(input.cellsPerPeriod) && (input.cellsPerPeriod as number) > 0
    ? (input.cellsPerPeriod as number)
    : ATLAS_BACKGROUND_CELLS_PER_PERIOD;

  const byId = new Map(input.locations.map((row) => [row.id, row]));
  /** 起讫两点都在同一张图且都有已确认格坐标时，才给出可验证的剩余段数。 */
  const remainingPeriodsOf = (fromLocationId: string | null, toLocationId: string): number | null => {
    if (fromLocationId === null) return null;
    const from = byId.get(fromLocationId);
    const to = byId.get(toLocationId);
    if (!from || !to) return null;
    if (typeof from.gridX !== "number" || typeof from.gridY !== "number") return null;
    if (typeof to.gridX !== "number" || typeof to.gridY !== "number") return null;
    if (String(from.mapId ?? "world") !== String(to.mapId ?? "world")) return null;
    const distance = Math.hypot(to.gridX - from.gridX, to.gridY - from.gridY);
    if (!Number.isFinite(distance) || distance <= 0) return null;
    return Math.max(1, Math.ceil(distance / cellsPerPeriod));
  };

  let working = cloneGeoTopology(topology);
  const moves: AtlasVehicleMoveReceipt[] = [];
  const undo: AtlasGeoUndoEntry[] = [];
  const diagnostics: AtlasGeoDiagnostic[] = [];
  let unrouted = 0;
  let skipped = 0;
  let eventIndex = 0;

  const anchors = [...working.vehicles].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const anchor of anchors) {
    if (moves.length >= maxMoves) {
      skipped += 1;
      continue;
    }
    // 状态不明 / 停靠却没有确认地点：不允许凭空出发（H11 同口径，人工确认走 H07a）
    if (anchor.status === "unknown" || (anchor.status === "stopped" && anchor.atLocationId === null)) {
      unrouted += 1;
      continue;
    }
    const incident = working.edges
      .filter((edge): edge is AtlasGeoEdge =>
        edge.kind === "route"
        && (edge.channel === "walk" || edge.channel === "vehicle")
        && (edge.fromLocationId === anchor.locationId || edge.toLocationId === anchor.locationId))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let edge: AtlasGeoEdge | undefined;
    if (anchor.status === "en-route") {
      // 一段没走完不许换路：只认锚点自己记着的那条已确认路线
      edge = anchor.routeEdgeId === null ? undefined : incident.find((item) => item.id === anchor.routeEdgeId);
    } else {
      // 停靠：在已确认路线里挑一条**不是当前停靠点**的下一段（按边 id 确定性排序）
      edge = incident.find((item) => {
        const other = item.fromLocationId === anchor.locationId ? item.toLocationId : item.fromLocationId;
        return other !== anchor.atLocationId;
      });
    }
    if (!edge) {
      unrouted += 1;
      continue;
    }
    const destination = edge.fromLocationId === anchor.locationId ? edge.toLocationId : edge.fromLocationId;
    // 起算点：停靠时用确认的停靠地点；在途时锚点已不保存停靠点 → 不猜剩余时间（保持 en-route）
    const originLocationId = anchor.status === "stopped" ? anchor.atLocationId : null;
    const remaining = remainingPeriodsOf(originLocationId, destination);
    const result = moveVehicleAnchor({
      turnKey: input.turnKey,
      topology: working,
      vehicleLocationId: anchor.locationId,
      intent: {
        kind: "depart",
        toLocationId: destination,
        routeEdgeId: edge.id,
        remainingPeriods: remaining,
      },
      periods,
      eventIndex,
      period: input.period ?? null,
      locations: input.locations,
      characters: input.characters,
    });
    eventIndex += 1;
    working = result.next;
    undo.push(...result.undo);
    diagnostics.push(...result.diagnostics);
    const event = result.events[0];
    if (!event) continue;
    moves.push({
      vehicleLocationId: anchor.locationId,
      eventId: event.id,
      status: event.status,
      fromLocationId: event.fromLocationId,
      toLocationId: event.toLocationId,
      routeEdgeId: event.routeEdgeId,
      reasonCode: event.reasonCode,
      periods: event.periods,
      remainingPeriods: event.remainingPeriods,
      crewCharacterIds: [...event.crewCharacterIds],
    });
  }

  if (moves.length === 0 && unrouted === 0 && skipped === 0) return { ...empty, candidateCount: anchors.length };
  return { topology: working, moves, undo, diagnostics, unrouted, skipped, candidateCount: anchors.length };
}

export function commitTableDeltaTurn(
  input: AtlasTableDeltaCommitInput,
): AtlasTableDeltaCommitOk | AtlasTableDeltaCommitFailure {
  const parsed = applyAtlasEditText(
    input.tables,
    input.text,
    { "msg:u": input.request.userText, "msg:a": input.request.assistantText },
    input.protectedCharacterIds ? { protectedCharacterIds: input.protectedCharacterIds } : {},
  );
  if (parsed.parse.status === "rejected" || parsed.delta === null) {
    return {
      ok: false,
      code: "PARSE_REJECTED",
      message: `行增量块不可用（${parsed.parse.error?.code ?? "UNKNOWN"}）。本轮未提交，世界与时间未变化；可重试推演。`,
      rejectedRows: parsed.parse.rejected.map((row) => ({ line: row.line, code: row.code, path: row.path, ...(row.ref === undefined ? {} : { ref: row.ref }) })),
    };
  }
  const delta = parsed.delta;
  if (!delta.ok) {
    return {
      ok: false,
      code: "DELTA_REJECTED",
      message: `候选三表未通过校验（${delta.error?.code ?? "UNKNOWN"} @ ${delta.error?.path ?? "$"}）。本轮未提交，可重试推演。`,
      rejectedRows: delta.rejected.map((row) => ({ line: row.line, code: String(row.code ?? "REJECTED"), ...(row.path === undefined ? {} : { path: row.path }), ...(row.ref === undefined ? {} : { ref: row.ref }) })),
    };
  }
  // §2 / T05：零条有效且不是 noop → 整轮失败，世界与时间都不变（哪怕只是引用错，也不"空提交"）
  if (delta.applied.length === 0 && delta.rejected.length > 0) {
    return {
      ok: false,
      code: "DELTA_REJECTED",
      message: `行增量没有任何一行可应用（${delta.rejected.length} 行被拒）。本轮未提交，世界与时间未变化；可重试推演。`,
      rejectedRows: delta.rejected.map((row) => ({ line: row.line, code: String(row.code ?? "REJECTED"), ...(row.path === undefined ? {} : { path: row.path }), ...(row.ref === undefined ? {} : { ref: row.ref }) })),
    };
  }

  const previousTime = input.binding.worldTimeCursor;

  // 兼容镜像（updatedAt 用回合前时间；真正的时间推进在下面算完再交给日程结算）
  const mirrorForTravel = tablesToLegacyWorld({
    tables: delta.tables,
    world: input.baseWorld,
    branchId: input.binding.branchId,
    at: previousTime,
  });
  const playerRowId = input.binding.characterId ? characterRowId(String(input.binding.characterId)) : null;
  const playerRow = playerRowId === null ? undefined : delta.tables.characters.find((row) => row.id === playerRowId);
  const playerPointId = playerRow?.locationId ? pointIdFromLocationRowId(playerRow.locationId) : null;
  const previousLocationId = input.binding.currentLocationId ?? null;
  const currentLocationId = playerPointId !== null ? String(playerPointId) : previousLocationId;

  // C06 / D03：时间由**三个来源取最大、不叠加**决定（§2.3）：
  //   ① 用户文本里的显式时间词；② 助手正文里**已完成**的行为；③ 既有旅行引擎的耗时。
  // 模型自报的数字一律忽略（模型无权替作者决定时间流逝）。
  // D03 补线（0.9.59）：`deriveElapsedPeriods` 之前是死代码——只接了 ① 和 ③，
  // 「助手正文写『赶了半天路 / 睡到翌日』」在行增量回合里完全不计时段。
  // 现在统一走这一个纯函数：同值按 用户 > 助手完成行为 > 旅行 归属来源，
  // 未完成 / 计划态（「打算去」）明确**不**计时，且理由随 elapsed.reason 落日志。
  let travelPeriods = 0;
  let travelNote = "";
  // 地点归属守卫：同一次进入内部（父↔子 / 同父兄弟）不算旅行，不推进时间。
  const locationAncestors = (pointId: string): Set<string> => {
    const chain = new Set<string>();
    const byPointId = new Map<string, AtlasLocationRow>();
    for (const row of delta.tables.locations) {
      const numeric = pointIdFromLocationRowId(row.id);
      if (numeric !== null) byPointId.set(String(numeric), row);
    }
    let cursor = byPointId.get(pointId);
    while (cursor && !chain.has(cursor.id)) {
      chain.add(cursor.id);
      cursor = cursor.parentLocationId === null ? undefined : delta.tables.locations.find((row) => row.id === cursor!.parentLocationId);
    }
    return chain;
  };
  const localMove = previousLocationId !== null && currentLocationId !== null
    && (() => {
      const from = locationRowId(previousLocationId);
      const to = locationRowId(currentLocationId);
      if (from === to) return true;
      return locationAncestors(currentLocationId).has(from) || locationAncestors(previousLocationId).has(to);
    })();
  if (
    previousLocationId !== null && currentLocationId !== null
    && previousLocationId !== currentLocationId && !localMove
  ) {
    const preview = atlasTravelPreview(mirrorForTravel.world, {
      fromPointId: previousLocationId,
      toPointId: currentLocationId,
    });
    if (preview) {
      travelPeriods = Math.max(0, Math.round(preview.estimatedDuration));
      if (travelPeriods > 0) travelNote = `跨场景 ${preview.distance} 格 → 至少 ${travelPeriods} 时段`;
    }
  }
  const elapsed = deriveElapsedPeriods({
    userText: input.request.userText,
    assistantText: input.request.assistantText,
    travelPeriods,
  });
  const duration = Math.max(0, Math.min(10_000, elapsed.periods));
  const currentTime = previousTime + duration;

  // 日程结算一次 → 回写三表（用同一份镜像）
  const mirror = { world: mirrorForTravel.world };
  const settlement = settleNpcSchedules(mirror.world, {
    branchId: input.binding.branchId,
    prevTime: previousTime,
    newTime: currentTime,
    playerFromPointId: previousLocationId,
    playerToPointId: currentLocationId,
    now: input.now,
  });
  const settledWorld = settlement.world;

  // 日程造成的移动必须回到三表：否则世界镜像走了、附近列表不动（D05 老问题重演）
  let nextTables = cloneAtlasTables(delta.tables);
  const locationByPointId = new Map<string, AtlasLocationRow>();
  for (const row of nextTables.locations) {
    const pointId = pointIdFromLocationRowId(row.id);
    if (pointId !== null) locationByPointId.set(String(pointId), row);
  }
  const characterByRowId = new Map(nextTables.characters.map((row) => [row.id, row]));
  for (const state of settledWorld.characterStates ?? []) {
    const row = characterByRowId.get(characterRowId(String(state.characterId)));
    if (!row) continue;
    const pointId = state.currentPointId === null || state.currentPointId === undefined ? null : String(state.currentPointId);
    const location = pointId === null ? undefined : locationByPointId.get(pointId);
    const nextLocationId = location ? location.id : null;
    if (row.locationId === nextLocationId) continue;
    row.locationId = nextLocationId;
    row.mapId = location ? location.mapId : null;
    row.gridX = null;
    row.gridY = null;
    // 日程只改位置：离场语义不去动它，位置未知也不假装在场
    if (nextLocationId === null && row.presence === "present") row.presence = "unknown";
    row.positionSource = "routine";
  }

  /**
   * E06 / E07：**在本轮故事事实之后**执行远方 NPC 的自主行动。
   *
   * 顺序是有意的：先让日程（作息表）说话，再让"有目标的人"朝目标走一步——
   * 日程回答"作息表说他此刻在哪"，后台行动回答"他自己想动且时间够走多远"。
   * 时间没推进（短对话 0 段）时 `planBackgroundMoves` 直接返回原表：远方宣战不会一轮传遍全图。
   * 主角由 `protectedCharacterIds` 挡住（与 B02 的模型保护名单同一份）。
   */
  const background = planBackgroundMoves({
    tables: nextTables,
    prevTime: previousTime,
    newTime: currentTime,
    protectedCharacterIds: input.protectedCharacterIds,
    // D01：已确认路线逐段接近；缺省 null = 与 0.9.58 完全一致
    topology: input.topology ?? null,
  });
  nextTables = background.tables;
  /** E07：后台行动必须留痕（有几个人真的动了 / 谁在途 / 谁因上限没排上）。 */
  const backgroundDiagnostic = {
    at: input.now,
    kind: "world-turn-background-moves",
    moves: background.moves.length,
    // pushLog 的数值白名单只放行 pointsAdded/skipped/scanned 等；用 skipped 记"未排上的人数"
    skipped: background.skipped,
    scanned: background.blocked,
  };

  /**
   * H11：**载具行动段**。位置在这里是有意的——排在人物日程与后台行动之后、候选三表校验之前：
   * - 车辆只沿**已确认 route 边**走（`planVehicleMoves` 里逐条校验），没路线就不动；
   * - 0 时段时它一个字段都不改（连事件都不产生）；
   * - 车厢内人物由它**完全不动**：乘员位置不变，世界位置由锚点解析；
   * - 返回的 undo 交给调用方写进 `turn.simulationUndo`，C10 回退时按行还原锚点。
   */
  const vehiclePlan = planVehicleMoves({
    topology: input.topology ?? null,
    locations: nextTables.locations,
    characters: nextTables.characters,
    periods: Math.max(0, currentTime - previousTime),
    turnKey: typeof input.turnKey === "string" && input.turnKey.length > 0
      ? input.turnKey
      : `td:${input.binding.chatId}:${input.now}`,
    period: currentTime,
    maxMoves: 2,
  });

  const validation = validateAtlasTables(nextTables);
  if (!validation.ok) {
    const first = validation.errors[0]!;
    return {
      ok: false,
      code: "DELTA_REJECTED",
      message: `日程回写后的候选三表未通过校验（${first.code} @ ${first.path}）。本轮未提交。`,
      rejectedRows: [{ line: 0, code: first.code, path: first.path }],
    };
  }
  const notes: string[] = [];
  if (settlement.moves.length > 0) notes.push(`日程移动 ${settlement.moves.length} 人`);
  if (settlement.encounters.length > 0) notes.push(`同地遭遇 ${settlement.encounters.length} 人`);
  // E07：后台行动的注记与日程注记同一处合入（回执 summary 尾部，有界截断由调用方负责）
  notes.push(...background.notes);
  // H11：载具行动进回执（人类可读；只有已确认路线上的真实位移才会出现在这里）
  const vehicleArrived = vehiclePlan.moves.filter((move) => move.status === "arrived").length;
  const vehicleEnRoute = vehiclePlan.moves.filter((move) => move.status === "started" || move.status === "progressed").length;
  const vehicleBlocked = vehiclePlan.moves.filter((move) => move.status === "blocked").length;
  if (vehicleArrived > 0) notes.push(`载具到位 ${vehicleArrived} 辆`);
  if (vehicleEnRoute > 0) notes.push(`载具在途 ${vehicleEnRoute} 辆`);
  if (vehicleBlocked > 0) notes.push(`载具受阻 ${vehicleBlocked} 辆`);
  if (vehiclePlan.unrouted > 0) notes.push(`载具待确认路线 ${vehiclePlan.unrouted} 辆`);
  const parseRejected = parsed.parse.rejected.length;
  const deltaRejected = delta.rejected.length;
  const summary = [
    `表格增量：应用 ${delta.applied.length} 行`,
    deltaRejected + parseRejected > 0 ? `拒绝 ${deltaRejected + parseRejected} 行（可重试或修正提示词）` : "",
    duration > 0 ? `时间推进 ${duration} 段` : "时间未推进",
    travelNote,
    notes.join("；"),
  ].filter((part) => part.length > 0).join("；");

  const receipt: AtlasTurnReceipt = {
    receiptId: `rcpt-${hashString(`table-delta:${input.binding.chatId}:${input.now}:${delta.applied.length}`)}`,
    status: "committed",
    branchId: input.binding.branchId,
    previousTime,
    currentTime,
    previousLocationId,
    currentLocationId,
    triggeredNpcIds: settlement.encounters.map((item) => item.characterId),
    adoptedEventIds: [],
    summary: settlement.notes.length > 0 ? mergeSettlementNotes(summary, settlement.notes) : summary,
    retryable: false,
  };

  return {
    ok: true,
    world: settledWorld,
    receipt,
    branchKey: input.branchKey,
    tablesDoc: {
      schemaVersion: 1,
      worldId: input.binding.worldId,
      branches: { ...(input.tablesDoc?.branches ?? {}), [input.branchKey]: nextTables },
    },
    applied: delta.applied.length,
    rejected: deltaRejected + parseRejected,
    rejectedRows: [
      ...parsed.parse.rejected.map((row) => ({ line: row.line, code: row.code, path: row.path })),
      ...delta.rejected.map((row) => ({ line: row.line, code: String(row.code ?? "REJECTED"), path: row.path })),
    ],
    settled: true,
    background: backgroundDiagnostic,
    // C08：结构化动作输出——「应用 5 行 / 后台 1 人移动」这类数字之外，还能按人物 ID 逐条核对
    acceptedRows: delta.applied.map((row) => {
      const ref = typeof row.id === "string" ? row.id : (row.ref ?? "");
      const kind = ref.length > 0 ? refKindOf(ref) : null;
      return {
        line: row.line,
        table: kind ?? ("unknown" as const),
        op: typeof row.op === "string" ? row.op : "set",
        ref,
      };
    }),
    scheduleMoves: settlement.moves.map((move) => ({
      characterId: move.characterId,
      characterName: move.characterName,
      pointId: move.pointId,
      fromPointId: move.fromPointId ?? null,
    })),
    backgroundMoves: background.moves,
    signalProposals: parsed.parse.signalProposals,
    // H11：载具行动（新拓扑 + 具名动作 + 精确 undo + 诊断）
    vehicleTopology: vehiclePlan.topology,
    vehicleMoves: vehiclePlan.moves,
    vehicleUndo: vehiclePlan.undo,
    vehicleDiagnostics: vehiclePlan.diagnostics,
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
  { method: "POST", path: "/maps/topology/confirm" },
  { method: "POST", path: "/maps/areas/upsert" },
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
  // H07a：作者手动确认归属 / 邻接 / 载具 / 坐标（会话路由：带 session + rev 校验）
  "POST /maps/topology/confirm",
  // H15a：作者手动涂色范围（只写 evidence=manual）
  "POST /maps/areas/upsert",
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
    // C04：协议不符 = 「设置与响应形态冲突」，不是格式错（400）也不是服务故障（502）——
    // 作者要做的动作是回推进页切协议，409 与既有前端错误呈现一致。
    case ATLAS_ERROR_CODES.PROTOCOL_MISMATCH:
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
    // C08：table-delta 的整轮拒绝（块缺失 / 行全被拒 / 候选校验不过 / 分支无三表）
    // 必须与 v2 拒绝同级记 error——否则「世界没更新」在日志里看起来像一次正常回合。
    "world-turn-delta-rejected", "world-turn-delta-row-rejected",
  ]);
  const warnKinds = new Set([
    "settings-sanitize", "world-geo-extract-fallback", "world-scale-extract-fallback",
    "world-scale-hint-skipped", "world-scale-reject", "world-turn-parse-fallback",
    "world-turn-v2-warnings", "scene-bootstrap-warnings",
    // 0.9.55 投影期可恢复异常
    "map-projection-sidecar-read-failed", "map-projection-points-truncated",
    "map-projection-ghost-submaps-dropped", "map-projection-maps-truncated",
    "map-projection-name-collisions-kept",
    // C08：部分应用（有行被拒但世界确实变了）与协议不匹配（设置与输出形态不符）都是可恢复的
    // 「要人看一眼」的状态，记 warn 而不是静默 info。
    "world-turn-delta-partial", "world-turn-delta-row-skipped", "world-turn-protocol-mismatch",
    // E07：后台自主行动（有人真的动了 / 有人因上限没排上）——可恢复但要人看一眼，
    // 否则"我没让他动他怎么走了"只能靠翻三表才发现。
    "world-turn-background-moves",
    // C08：懒迁移失败（损坏 tables / 世界不可解析 / 分支基线不可用）——旧会话没被改写，但作者要知道。
    "table-migration-failed",
    // E05：回退时三表跟着还原（或按回退后的世界重建）。info/warn 取决于是否走了重建兜底，
    // 但两种都必须留痕——否则"地图回到过去、三表停在未来"这种错位只能靠肉眼发现。
    "world-turn-table-rollback",
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
        ...(typeof entry.schemaPath === "string" ? { schemaPath: entry.schemaPath } : {}),
        ...(typeof entry.rowLine === "number" ? { rowLine: entry.rowLine } : {}),
        ...(typeof entry.droppedCount === "number" ? { droppedCount: entry.droppedCount } : {}),
        ...(typeof entry.coreCommitted === "boolean" ? { coreCommitted: entry.coreCommitted } : {}),
      },
    }, now);
    if (diagnostic) {
      try { deps.onDiagnostic?.(diagnostic); } catch { /* diagnostics do not affect commit */ }
    }
  }

  /** Log each rejected field without storing model text, quotes, names, or raw entity IDs. */
  function logRejectedDeltaRows(
    rows: Array<{ line: number; code: string; path?: string; ref?: string }>,
    chatId: string,
    committed: boolean,
  ): void {
    const limit = 100;
    for (const row of rows.slice(0, limit)) {
      pushLog({
        kind: committed ? "world-turn-delta-row-skipped" : "world-turn-delta-row-rejected",
        chatId,
        reasonCode: row.code,
        schemaPath: row.path ?? "$",
        rowLine: row.line,
        coreCommitted: committed,
      });
    }
    if (rows.length > limit) {
      pushLog({
        kind: committed ? "world-turn-delta-partial" : "world-turn-delta-rejected",
        chatId,
        reasonCode: "REJECTED_ROWS_TRUNCATED",
        errorCount: rows.length,
        droppedCount: rows.length - limit,
        coreCommitted: committed,
      });
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

  /**
   * 模型偶尔漏掉地点首行的 quote，导致本块所有 new: 引用一起失败。只在**零有效行**且
   * 拒绝项完全由引文错误和依赖错误组成时追加一次纠错请求。第二次仍走原校验器；
   * 无证据就应省略变更，不从人物名字或世界书中自动编引文。
   */
  async function repairQuoteOnlyReply(input: {
    text: string;
    preset: AtlasApiPreset;
    prompt: AtlasWorldTurnPromptInput;
    userText: string;
    assistantText: string;
    chatId: string;
  }): Promise<string | null> {
    const parsed = parseAtlasEditBlock(input.text, { "msg:u": input.userText, "msg:a": input.assistantText });
    if (parsed.status !== "rejected" || parsed.rejected.length === 0) return null;
    const quoteCodes = new Set(["QUOTE_REQUIRED", "QUOTE_NOT_FOUND"]);
    if (!parsed.rejected.some((row) => quoteCodes.has(row.code))
        || parsed.rejected.some((row) => !quoteCodes.has(row.code) && row.code !== "DEPENDENCY_FAILED")) return null;

    try {
      checkRpm();
    } catch {
      pushLog({ at: now(), kind: "world-turn-quote-repair-skipped", chatId: input.chatId,
        reasonCode: "API_RATE_LIMITED", coreCommitted: false });
      return null;
    }
    const blockStart = input.text.lastIndexOf("<atlasEdit>");
    const rejectedBlock = blockStart >= 0 ? input.text.slice(blockStart, blockStart + 3_000) : "";
    const issues = parsed.rejected.slice(0, 8)
      .map((row) => `第 ${row.line} 行 ${row.code} @ ${row.path}`).join("；");
    const instruction =
      `上一次 <atlasEdit> 提交没有任何有效行：${issues}。请只输出一份修正后的完整 <atlasEdit> 块。\n`
      + "新增地点和实际位置/归属变化必须有 quote，逐字复制本轮用户行动或助手正文里的连续原文。"
      + "如果正文没有证据证明地点出现或人物抵达，就删除对应行及依赖行；全无变化就写 {\"kind\":\"noop\"}。"
      + "不可从角色卡、世界书、旧剧情编造引文，不可把推测位置当作已到达。\n"
      + (rejectedBlock ? `待修正的块（仅供定位错误）：\n${rejectedBlock}` : "");
    rpmTimestamps.push(now());
    const result = await callAtlasWorldTurnApi(
      { ...input.preset, maxTokens: Math.min(input.preset.maxTokens ?? 4_096, 4_096), temperature: 0.2 },
      { ...input.prompt, repairInstruction: instruction },
      { fetchFn: deps.fetchFn, now },
    );
    pushLog({ at: now(), kind: result.ok ? "world-turn-quote-repair-complete" : "world-turn-quote-repair-failed",
      chatId: input.chatId, reasonCode: result.ok ? "QUOTE_REPAIRED_RESPONSE" : result.code,
      durationMs: result.durationMs, responseChars: result.ok ? result.text.length : 0, coreCommitted: false });
    return result.ok ? result.text : null;
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
      version: "0.9.60",
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
    const view = settingsViewV2(saved);
    /**
     * E02：`prompt.migrate-legacy` 的结果随视图一起返回，UI 据此：
     * ① 预览新草稿（原文一字未改，只新建了一份）；② 让作者显式选择是否启用。
     * 旧预设仍在 `promptPresets` 里原样可见、可复制。
     */
    if (result.migratedPresetId) {
      return okResult({
        ...view,
        migratedPromptPresetId: result.migratedPresetId,
        migratedPromptPresetName: result.migratedPresetName ?? "",
        replacedKeywords: result.replacedKeywords ?? [],
      });
    }
    return okResult(view);
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

    const outcome = await runGeoExtraction({ world, preset, lore, recentTexts, source: "manual", binding });
    if (outcome.regionsAdded === 0 && outcome.pointsAdded === 0) {
      const aborted = outcome.tables.status === "failed";
      return okResult({
        regionsAdded: 0,
        pointsAdded: 0,
        skipped: outcome.skipped,
        // H05：即使一个新地点都没有，也要把「待确认归属」如实带回（不静默丢掉提炼结果）
        preview: outcome.preview,
        pending: outcome.pending,
        pendingTotal: outcome.pending.length,
        tables: outcome.tables,
        aborted,
        message: aborted
          ? `提炼结果没有写回：三表候选未通过校验（${outcome.tables.reasonCode}）。世界、三表、地图与推演模块都保持原样，可修正后重试。`
          : outcome.pending.length > 0
            ? "没有新增地理实体，但有关系证据不足——已列入「待确认」，请到地图详情人工确认归属。"
            : "没有提炼出新的地理实体（可能都已存在，或资料里没有地理描述）。",
      });
    }
    return okResult({
      regionsAdded: outcome.regionsAdded,
      pointsAdded: outcome.pointsAdded,
      skipped: outcome.skipped,
      revisionAppended: outcome.revisionAppended,
      regionNames: outcome.regionNames,
      pointNames: outcome.pointNames,
      // E02：如实报告三表补齐结果（UI 可据此提示"地图已更新"，排障也能看到 skipped 原因）
      tables: outcome.tables,
      /** H05：可预览的提炼结果 `{id,parent,adjacent,vehicle,pending,reasonCode}`。 */
      preview: outcome.preview,
      /** H05：证据 / 引用不足、留待用户确认的关系（已存进会话 geoAuto，见 pending 键）。 */
      pending: outcome.pending,
      pendingTotal: outcome.pending.length,
      /** H18b：首次建出世界图时的尺度状态（null = 已有世界图，不额外发模型请求）。 */
      mapScale: outcome.mapScale,
    });
  }

  /**
   * H05（0.9.59）：提炼核心（手动 /worlds/geo/adopt 与首轮自动建图共用）。
   *
   * **两趟**：
   * 1. 登记 / 解析：模型给的每个名字先解析到正式 `loc:*` id——已存在的**复用**
   *    （绝不造第二个同名地点），不存在的新建并分配确定性 id；
   * 2. 关系：contained / adjacent / mobile 各自过证据与结构校验（`planGeoRelations`），
   *    重名、缺对端、环、超深、没引文或引文不在世界书 / 正文里 → 该关系进 `pending`
   *    （留待用户用 H07a 的 `/maps/topology/confirm` 确认），**已确认的地点一个都不丢**。
   *
   * **写入纪律**：world / tables / maps / simulation 先在内存里算成同一个候选，
   * 全部校验通过后**一次写回**。旧实现「先 `store.write(world)` 再补三表」在补表失败时
   * 会留下「世界长了、地图没长」的半截提交——那段顺序已删除。
   *
   * **坐标纪律**：模型不输出 gridX/Y 与 metersPerCell；新点的世界镜像 x/y 只是确定性
   * 示意排版（旧 schema 要求有限数字），同时写 `maps.pointMeta[].coordinateStatus="schematic"`，
   * 三表行的 `gridX/gridY` 恒为 `null`（H06b / H06c）。程序物理路径只读三表确认坐标与拓扑。
   */
  async function runGeoExtraction(input: {
    world: World;
    preset: NonNullable<ReturnType<typeof resolveWorldTurnPreset>>;
    lore: string;
    recentTexts: string[];
    source: "manual" | "auto";
    /** E02：提炼成功后要把新地点补进**这个绑定所在分支**的三表；没有绑定（纯导入场景）就不补。 */
    binding: AtlasChatBinding | null;
  }): Promise<{
    regionsAdded: number;
    pointsAdded: number;
    skipped: number;
    revisionAppended: boolean;
    regionNames: string[];
    pointNames: string[];
    /** E02：三表补齐结果（没有绑定 / 该分支还没有三表时是 skipped，不算失败）。 */
    tables: { status: "skipped" | "synced" | "failed"; reasonCode: string; added: { locations: number; characters: number }; moved: number };
    /** H05：可预览的提炼结果（`{id,parent,adjacent,vehicle,pending,reasonCode}`）。 */
    preview: AtlasGeoExtractPreviewRow[];
    /** H05：证据 / 引用不足、留待用户确认的关系。 */
    pending: AtlasGeoPendingRelation[];
    /** H18b：本轮首次建出世界图时的尺度建立结果（其余情况为 null：不额外发模型请求）。 */
    mapScale: { status: string; reasonCode?: string } | null;
  }> {
    const world = input.world;
    const preset = input.preset;
    const lore = input.lore;
    const recentTexts = input.recentTexts;
    const binding = input.binding;
    const storyMode = recentTexts.length > 0;
    const branchKey = binding === null ? "canon" : (branchScopeForStory(world, binding.branchId) ?? "canon");
    // 恰好 1 条推演请求：分段模式注入提炼指令（复用 callAtlasWorldTurnApi 的
    // 超时 / 救场 / 错误分类，不新开 fetch 路径）
    /**
     * H04：契约扩展——**向后兼容**（旧模型只回 `name` / `regionName` 照样能用）。
     * 新增字段全部可选，且模型**不许**输出坐标 / 每格米数 / 边界 / 凭空城市：
     * 只说得出关系却拿不出原文的，一律留待程序判 pending。
     */
    const contractRule =
      '只输出一个 JSON 对象：{"regions":[{"name":"...","description":"..."}],"points":[{"name":"...","regionName":"...","parentName":"...","relation":"contained|adjacent|none","mobile":"vehicle|fixed","anchorName":"...","evidenceQuote":"..."}]}';
    const commonRules = [
      "规则：name ≤20 字；regionName 必须是 regions 里出现过的名字（没有合适地区就省略该字段）；只提炼明确或强烈暗示的地理实体——城市 / 森林 / 遗迹 / 建筑等，教室 / 学校 / 商店 / 车站等剧情人物真实所处的具体场所也算地点（校园日常类故事尤其如此），角色、文风、格式规则一律不要；宁缺毋滥；最多 12 个地区、40 个地点；没有地理信息就输出 {\"regions\":[],\"points\":[]}。",
      "可选关系字段（只有资料里写清楚才填，其余一律省略或给 none）：parentName = 包含它的地点名（relation=contained 时）或与它相邻 / 接壤的地点名（relation=adjacent 时）；relation 只能是 contained（确实在其内部）/ adjacent（只是相邻）/ none（没有确证关系）；mobile 只能是 vehicle（这本身是移动载具：车厢 / 船 / 飞艇）/ fixed（固定地点）；anchorName = 载具当前停靠 / 所在的地点名（只有资料明确时才给）。",
      "evidenceQuote = 证明上面那条关系的那句原文，必须**逐字连续**出现在下面的资料里；找不到这样的原句就**不要写关系字段**（程序会把它留待作者确认）。",
      "绝对不要输出 gridX / gridY / 坐标 / 每格米数 / 边界范围；不要因为地名相似（例如「XX外城区」与「XX城」）就当成包含关系；拿不准就省略——宁可留待确认，也不要编。",
    ].join("\n");
    const existingGeoNames = [
      ...(world.regions ?? []).map((r) => String(r.name)),
      ...(world.points ?? []).map((p) => String(p.name)),
    ].slice(0, 60);
    const userContent = storyMode
      ? [
          "从下面的近期剧情中提炼**剧情里新出现或被明确抵达 / 提及**的地点与地区（已有地点名单里的不要重复输出；已有地点可以直接用作 parentName / anchorName）。",
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
      return {
        regionsAdded: 0, pointsAdded: 0, skipped: 0, revisionAppended: false, regionNames: [], pointNames: [],
        tables: { status: "skipped", reasonCode: "TABLE_GEO_NO_YIELD", added: { locations: 0, characters: 0 }, moved: 0 },
        preview: [], pending: [], mapScale: null,
      };
    }

    const cleanName = (value: unknown): string | null => {
      const text = String(value ?? "").trim().replace(/\s+/g, " ");
      return text ? text.slice(0, GEO_LIMITS.NAME_CHARS) : null;
    };
    const cleanDesc = (value: unknown): string =>
      String(value ?? "").trim().replace(/\s+/g, " ").slice(0, GEO_LIMITS.DESC_CHARS);
    const cleanQuote = (value: unknown): string | null => {
      const text = String(value ?? "").trim().replace(/\s+/g, " ");
      // 引文只做「逐字命中」判定，过长直接丢弃（不接受整段粘贴当证据）
      return text && text.length <= 200 ? text : null;
    };
    const cleanRelation = (value: unknown): AtlasGeoRelationKind => {
      const text = String(value ?? "").trim().toLowerCase();
      return text === "contained" || text === "adjacent" ? text : "none";
    };
    const cleanMobile = (value: unknown): "vehicle" | "fixed" | null => {
      const text = String(value ?? "").trim().toLowerCase();
      return text === "vehicle" || text === "fixed" ? text : null;
    };
    const norm = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

    const existingRegionNames = new Set((world.regions ?? []).map((r) => norm(String(r.name))));
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
      // 纪律 3：ID 确定性——不含 now，同一世界同一地区名永远同一个 id
      const id = `geo-r-${hashString(`${world.id}|r|${name}`)}`;
      newRegions.push({ id, worldId: world.id, name, type: "other", description: cleanDesc((raw as { description?: unknown })?.description) || "由世界书提炼。", coordinates: { x: 0, y: 0 } });
      regionIdByName.set(norm(name), id);
    }

    /* ---------- 第一趟：登记 / 解析唯一名称到正式 loc:* id（H05） ---------- */

    /** 已有地点索引：三表（实体现值权威）∪ 世界镜像。同名不同 id = 歧义，不猜。 */
    const planLocations: AtlasGeoPlanLocation[] = [];
    const knownLocationIds = new Set<string>();
    const tablesKey = `tables:${world.id}`;
    const tablesRaw = binding === null ? null : await store.read(tablesKey).catch(() => null);
    const tablesDoc = isPlainRecord(tablesRaw) ? (tablesRaw as unknown as AtlasTablesStoreV1) : null;
    const branchTablesRaw = isPlainRecord(tablesDoc?.branches) ? tablesDoc?.branches?.[branchKey] : undefined;
    const branchTables = isPlainRecord(branchTablesRaw) ? (branchTablesRaw as unknown as AtlasThreeTablesV1) : null;
    const pushPlanLocation = (id: string, name: string, parentLocationId: string | null): void => {
      if (!id || knownLocationIds.has(id)) return;
      knownLocationIds.add(id);
      planLocations.push({ id, name, parentLocationId });
    };
    for (const row of branchTables?.locations ?? []) {
      pushPlanLocation(row.id, row.name, row.parentLocationId);
    }
    for (const point of world.points ?? []) {
      const parentPointId = Number(point.parentPointId);
      pushPlanLocation(
        locationRowId(point.id),
        String(point.name ?? ""),
        Number.isInteger(parentPointId) && parentPointId > 0 ? locationRowId(parentPointId) : null,
      );
    }
    const existingIdsByName = new Map<string, Set<string>>();
    for (const row of planLocations) {
      const key = norm(row.name);
      if (!key) continue;
      const bucket = existingIdsByName.get(key) ?? new Set<string>();
      bucket.add(row.id);
      existingIdsByName.set(key, bucket);
    }
    const resolveExistingName = (name: string): { id: string | null; ambiguous: boolean } => {
      const bucket = existingIdsByName.get(norm(name));
      if (!bucket || bucket.size === 0) return { id: null, ambiguous: false };
      if (bucket.size > 1) return { id: null, ambiguous: true };
      return { id: [...bucket][0] ?? null, ambiguous: false };
    };

    let nextPointId = (world.points ?? []).reduce((max, p) => Math.max(max, Number(p.id) || 0), 0) + 1;
    const newPoints: Array<{ id: number; name: string; x: number; y: number; regionId?: string | null }> = [];
    const planCandidates: AtlasGeoPlanCandidate[] = [];
    /** 同名歧义（同一名字对应多个正式 id）：既不新建也不猜归属，进 pending。 */
    const ambiguousNames: string[] = [];
    for (const raw of (Array.isArray(spec.points) ? spec.points : []).slice(0, GEO_LIMITS.POINTS_MAX + 8)) {
      if (newPoints.length >= GEO_LIMITS.POINTS_MAX) break;
      const record = (raw ?? {}) as Record<string, unknown>;
      const name = cleanName(record.name);
      if (!name) {
        skipped += 1;
        continue;
      }
      const regionName = cleanName(record.regionName);
      const relation = cleanRelation(record.relation);
      const mobile = cleanMobile(record.mobile);
      const counterpartName = cleanName(record.parentName);
      const anchorName = cleanName(record.anchorName);
      const evidenceQuote = cleanQuote(record.evidenceQuote);
      const existing = resolveExistingName(name);
      if (existing.ambiguous) {
        // 重名：不新建第二个同名地点，也不替作者挑一个——留待确认
        skipped += 1;
        ambiguousNames.push(name);
        continue;
      }
      if (existing.id !== null) {
        // 复用已存在的地点（绝不再造一个同名点）；它的关系仍可被本轮提炼补上
        skipped += 1;
        planCandidates.push({
          id: existing.id, name, existing: true, relation,
          counterpartName, mobile, anchorName, evidenceQuote,
        });
        continue;
      }
      if (planCandidates.some((item) => !item.existing && norm(item.name) === norm(name))) {
        skipped += 1;
        continue;
      }
      // R06：未知地区回退 null，不自动归入「起点」——新世界是空地理，写死 "start"
      // 会造出指向不存在地区的悬空引用；旧世界里真有 start 地区时沿用原口径。
      const fallbackRegionId = (world.regions ?? []).some((r) => String(r.id) === "start") ? "start" : null;
      const regionId = (regionName ? regionIdByName.get(norm(regionName)) ?? null : null) ?? fallbackRegionId;
      // 黄金角螺旋布点：绕「起点」外圈散开，绝不与已有点重叠坐标。
      // H06b：这只是**示意排版**——三表行 gridX/gridY 仍为 null，镜像坐标标 schematic。
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
      planCandidates.push({
        id: locationRowId(nextPointId), name, existing: false, relation,
        counterpartName, mobile, anchorName, evidenceQuote,
      });
      nextPointId += 1;
    }

    /* ---------- 第二趟：关系（证据 + 结构） ---------- */

    const plan = planGeoRelations({
      locations: planLocations,
      candidates: planCandidates,
      // 引文必须**逐字**出现在本轮材料里：世界书 → worldbook，近期正文 → story
      quoteSource: (quote: string) => {
        if (lore.length > 0 && lore.includes(quote)) return "worldbook";
        return recentTexts.some((text) => text.includes(quote)) ? "story" : null;
      },
      maxDepth: ATLAS_GEO_PARENT_DEPTH_MAX,
    });
    const pendingRows: AtlasGeoPendingRelation[] = [
      ...ambiguousNames.map((name) => ({
        id: `location|${norm(name)}|`,
        kind: "contained" as const,
        fromLocationId: null,
        fromName: name,
        toName: null,
        reasonCode: "LOCATION_NAME_AMBIGUOUS",
      })),
      ...plan.pending,
    ];

    /** H05：pending 也要留痕（会话 geoAuto，键与自动建图标记分开，互不覆盖）。 */
    const persistGeoPending = async (): Promise<void> => {
      if (binding === null || pendingRows.length === 0) return;
      try {
        await store.write(`geo-auto:pending:${world.id}`, {
          at: now(),
          worldId: world.id,
          branchKey,
          source: input.source,
          rows: pendingRows.slice(0, 40),
          total: pendingRows.length,
        });
      } catch {
        // 留痕失败绝不影响已经算好的提炼结果
      }
    };

    if (newRegions.length === 0 && newPoints.length === 0) {
      await persistGeoPending();
      pushLog({ at: now(), kind: "world-geo-adopt", worldId: world.id, source: input.source, regionsAdded: 0, pointsAdded: 0, skipped });
      return {
        regionsAdded: 0, pointsAdded: 0, skipped, revisionAppended: false, regionNames: [], pointNames: [],
        tables: { status: "skipped", reasonCode: "TABLE_GEO_NO_YIELD", added: { locations: 0, characters: 0 }, moved: 0 },
        preview: plan.preview, pending: pendingRows, mapScale: null,
      };
    }

    /* ---------- 候选世界（含父链；只改副本） ---------- */

    const nextPoints = (world.points ?? []).map((point) => ({ ...point }));
    const pointById = new Map(nextPoints.map((point) => [String(point.id), point]));
    let mirrorLinks = 0;
    let mirrorLinksSkipped = 0;
    for (const link of plan.parents) {
      const childPointId = pointIdFromLocationRowId(link.childId);
      const parentPointId = pointIdFromLocationRowId(link.parentId);
      const point = childPointId === null ? undefined : pointById.get(String(childPointId));
      if (childPointId === null || parentPointId === null || !point) {
        // 非数字 id 的旧式子图点无法进世界镜像：只记数量，绝不瞎编 parentPointId
        mirrorLinksSkipped += 1;
        continue;
      }
      point.parentPointId = parentPointId;
      mirrorLinks += 1;
    }
    let updated: World = {
      ...world,
      regions: [...(world.regions ?? []), ...newRegions],
      points: [...nextPoints, ...newPoints],
      updatedAt: now(),
    };
    const revision = appendDefinitionRevision(updated, {
      authorNote: `${input.source === "auto" ? "首轮自动建图" : "世界书提炼地理"}：+${newRegions.length} 地区 +${newPoints.length} 地点`,
      now: now(),
    });
    if (revision.ok) updated = revision.value;

    /* ---------- 候选 maps（H06b/H06a：只标 schematic，保留原始条目不清洗截断） ---------- */

    const mapsKey = `maps:${world.id}`;
    const rawMaps = await store.read(mapsKey).catch(() => null);
    if (rawMaps !== null && rawMaps !== undefined && !isPlainRecord(rawMaps)) {
      pushLog({ at: now(), kind: "map-doc-not-object-replaced", worldId: world.id });
    }
    const mapsBase: Record<string, unknown> = isPlainRecord(rawMaps) ? (rawMaps as Record<string, unknown>) : {};
    const pointMetaBase: Record<string, unknown> = isPlainRecord(mapsBase.pointMeta)
      ? { ...(mapsBase.pointMeta as Record<string, unknown>) }
      : {};
    for (const point of newPoints) {
      const previous = isPlainRecord(pointMetaBase[String(point.id)])
        ? (pointMetaBase[String(point.id)] as Record<string, unknown>)
        : {};
      pointMetaBase[String(point.id)] = { ...previous, coordinateStatus: "schematic" };
    }
    // H06a：这里**故意不整份 sanitize**——清洗会把 calibrations / pointMeta 截到上限，
    // 等于把作者已保存的第 41 张标定悄悄删掉。只并点元数据，其余条目原样保留。
    const nextMapsDoc = {
      schemaVersion: 2,
      pointMeta: pointMetaBase,
      submaps: isPlainRecord(mapsBase.submaps) ? mapsBase.submaps : {},
      calibrations: isPlainRecord(mapsBase.calibrations) ? mapsBase.calibrations : {},
    } as unknown as AtlasMapDoc;
    const previousMaps = sanitizeMapDoc(rawMaps);

    /* ---------- 候选三表（H06c：新行 schematic → gridX/Y=null；父关系只来自已确认提炼） ---------- */

    let nextTablesDoc: AtlasTablesStoreV1 | null = null;
    let tableSync: { status: "skipped" | "synced" | "failed"; reasonCode: string; added: { locations: number; characters: number }; moved: number } =
      binding === null
        ? { status: "skipped", reasonCode: "TABLE_NO_BINDING", added: { locations: 0, characters: 0 }, moved: 0 }
        : { status: "skipped", reasonCode: "TABLE_BRANCH_MISSING", added: { locations: 0, characters: 0 }, moved: 0 };
    if (binding !== null && branchTables !== null) {
      const projected = await rebuildBranchTablesFromWorld({ store, binding, world: updated, branchKey });
      if (!projected.ok) {
        tableSync = { status: "failed", reasonCode: projected.reasonCode, added: { locations: 0, characters: 0 }, moved: 0 };
      } else {
        const next = cloneAtlasTables(branchTables);
        /** 合并**前**就存在的地点行 id：这些行（人工坐标 / 旧 parent）一律不碰（H03 / H06b）。 */
        const priorLocationIds = new Set(next.locations.map((row) => row.id));
        const knownLocationIds = new Set(priorLocationIds);
        const existingCharacterIds = new Set(next.characters.map((row) => row.id));
        let addedLocations = 0;
        let addedCharacters = 0;
        let moved = 0;
        for (const row of projected.tables.locations) {
          if (knownLocationIds.has(row.id)) continue;
          next.locations.push(row);
          knownLocationIds.add(row.id);
          addedLocations += 1;
        }
        for (const row of projected.tables.characters) {
          if (existingCharacterIds.has(row.id)) continue;
          next.characters.push(row);
          existingCharacterIds.add(row.id);
          addedCharacters += 1;
        }
        // 已有行：只认「同一实体、位置确实变了」（与 syncBranchTablesFromWorld 同口径）
        const projectedCharacters = new Map(projected.tables.characters.map((row) => [row.id, row]));
        for (const row of next.characters) {
          const fresh = projectedCharacters.get(row.id);
          if (!fresh) continue;
          const changed = fresh.locationId !== row.locationId || fresh.mapId !== row.mapId
            || fresh.gridX !== row.gridX || fresh.gridY !== row.gridY;
          if (!changed) continue;
          row.locationId = fresh.locationId;
          row.mapId = fresh.mapId;
          row.gridX = fresh.gridX;
          row.gridY = fresh.gridY;
          row.positionSource = fresh.positionSource;
          moved += 1;
        }
        /**
         * H06c：本轮**新增**的地点行按 `maps.pointMeta[].coordinateStatus` 定坐标——
         * `schematic`（含旧档 `legacy-unknown`）→ `gridX/gridY` 置 **null**；
         * `confirmed`（人工确认过）→ 保留人工数值。
         * 合并前就存在的行一律不碰：人工锁定坐标不重排，旧 parent 也不因补地理被改写（H03）。
         */
        for (const row of next.locations) {
          if (priorLocationIds.has(row.id)) continue;
          const pointId = pointIdFromLocationRowId(row.id);
          if (pointId === null) continue;
          if (previousMaps.pointMeta[String(pointId)]?.coordinateStatus === "confirmed") continue;
          row.gridX = null;
          row.gridY = null;
        }
        const validation = validateAtlasTables(next);
        if (!validation.ok) {
          tableSync = { status: "failed", reasonCode: "TABLE_SYNC_INVALID", added: { locations: 0, characters: 0 }, moved: 0 };
        } else {
          nextTablesDoc = {
            schemaVersion: 1,
            worldId: world.id,
            branches: { ...(tablesDoc?.branches ?? {}), [branchKey]: next },
          };
          tableSync = {
            status: "synced",
            reasonCode: "TABLE_SYNCED_FROM_WORLD",
            added: { locations: addedLocations, characters: addedCharacters },
            moved,
          };
        }
      }
    }

    /* ---------- 候选 simulation.geoTopology（邻接边 / 载具锚点） ---------- */

    let nextSimulationDoc: AtlasSimulationStore | null = null;
    const topologyPending: AtlasGeoPendingRelation[] = [];
    if (binding !== null && (plan.adjacencies.length > 0 || plan.routes.length > 0 || plan.vehicles.length > 0)) {
      const simulationRaw = await store.read(`simulation:${world.id}`).catch(() => null);
      let candidateSimulation: AtlasSimulationStore | null = null;
      if (simulationRaw === null || simulationRaw === undefined) {
        candidateSimulation = createEmptySimulation(world.id);
      } else {
        const check = validateSimulationStore(simulationRaw, {
          expectedWorldId: world.id,
          tablesByBranch: simulationTablesByBranch(tablesDoc),
        });
        if (check.ok) candidateSimulation = cloneSimulationStore(simulationRaw as AtlasSimulationStore);
        else pushLog({ at: now(), kind: "world-geo-simulation-corrupt", worldId: world.id, reasonCode: "SIMULATION_CORRUPT" });
      }
      if (candidateSimulation !== null) {
        const simulationBranch = candidateSimulation.branches[branchKey] ?? createEmptySimulationBranch();
        candidateSimulation.branches[branchKey] = simulationBranch;
        const geoLocations = nextTablesDoc?.branches?.[branchKey]?.locations ?? branchTables?.locations ?? [];
        const geoCharacters = nextTablesDoc?.branches?.[branchKey]?.characters ?? branchTables?.characters ?? [];
        // 逐条加入、逐条校验：坏的那一条单独退回并记 pending，不因一条坏边丢掉整轮提炼
        const rejectTopology = (kind: AtlasGeoPendingRelation["kind"], fromName: string, toName: string | null, code: string): void => {
          topologyPending.push({ id: `${kind}|${norm(fromName)}|${norm(toName ?? "")}|rejected`, kind, fromLocationId: null, fromName, toName, reasonCode: code });
          pushLog({ at: now(), kind: "world-geo-topology-rejected", worldId: world.id, reasonCode: code });
        };
        for (const adjacency of plan.adjacencies) {
          const edgeId = geoEdgeId(branchKey, adjacency.fromLocationId, adjacency.toLocationId, "adjacent");
          if (simulationBranch.geoTopology.edges.some((row) => row.id === edgeId)) continue; // 幂等：同一条边只留一行
          simulationBranch.geoTopology.edges.push({
            id: edgeId,
            fromLocationId: adjacency.fromLocationId,
            toLocationId: adjacency.toLocationId,
            kind: "adjacent",
            evidence: adjacency.evidence,
            channel: "walk",
          });
          const check = validateGeoTopology(simulationBranch.geoTopology, {
            branchKey, locations: geoLocations, characters: geoCharacters, frame: { ...SUBMAP_FRAME_DEFAULT },
          });
          if (!check.ok) {
            simulationBranch.geoTopology.edges.pop();
            rejectTopology("adjacent", adjacency.fromLocationId, adjacency.toLocationId, check.errors[0]!.code);
          }
        }
        /**
         * H11：移动载具的路线边（`kind="route"`、`channel="vehicle"`）。
         *
         * 端点一定包含载具本体地点行，正是 `moveVehicleAnchor` 要求的形状；
         * 没有引文的关系在上一步就进了 pending，绝不会到这里凭空造出一条路。
         */
        for (const route of plan.routes) {
          const edgeId = geoEdgeId(branchKey, route.fromLocationId, route.toLocationId, "route");
          if (simulationBranch.geoTopology.edges.some((row) => row.id === edgeId)) continue; // 幂等
          simulationBranch.geoTopology.edges.push({
            id: edgeId,
            fromLocationId: route.fromLocationId,
            toLocationId: route.toLocationId,
            kind: "route",
            evidence: route.evidence,
            channel: "vehicle",
          });
          const check = validateGeoTopology(simulationBranch.geoTopology, {
            branchKey, locations: geoLocations, characters: geoCharacters, frame: { ...SUBMAP_FRAME_DEFAULT },
          });
          if (!check.ok) {
            simulationBranch.geoTopology.edges.pop();
            rejectTopology("adjacent", route.fromLocationId, route.toLocationId, check.errors[0]!.code);
          }
        }
        for (const vehicle of plan.vehicles) {
          const anchor: AtlasVehicleAnchor = {
            // §2.1：载具锚点 id 恒等于其地点行 id（供精确覆写与 undo 查找）
            id: vehicle.locationId,
            locationId: vehicle.locationId,
            atLocationId: vehicle.atLocationId,
            routeEdgeId: null,
            status: vehicle.atLocationId === null ? "unknown" : "stopped",
            evidence: vehicle.evidence,
          };
          const index = simulationBranch.geoTopology.vehicles.findIndex((row) => row.id === anchor.id);
          const previous = index >= 0 ? simulationBranch.geoTopology.vehicles[index]! : null;
          if (index >= 0) simulationBranch.geoTopology.vehicles[index] = anchor;
          else simulationBranch.geoTopology.vehicles.push(anchor);
          const check = validateGeoTopology(simulationBranch.geoTopology, {
            branchKey, locations: geoLocations, characters: geoCharacters, frame: { ...SUBMAP_FRAME_DEFAULT },
          });
          if (!check.ok) {
            if (previous !== null) simulationBranch.geoTopology.vehicles[index] = previous;
            else simulationBranch.geoTopology.vehicles.pop();
            rejectTopology("vehicle", vehicle.locationId, vehicle.atLocationId, check.errors[0]!.code);
          }
        }
        // 一切改动之后再过一次完整校验（与 H02 单闸门口径一致）
        const finalCheck = validateSimulationStore(candidateSimulation, {
          expectedWorldId: world.id,
          tablesByBranch: simulationTablesByBranch(nextTablesDoc ?? tablesDoc),
        });
        if (finalCheck.ok) nextSimulationDoc = candidateSimulation;
        else pushLog({ at: now(), kind: "world-geo-simulation-rejected", worldId: world.id, reasonCode: finalCheck.errors[0]!.code });
      }
    }
    const pendingAll: AtlasGeoPendingRelation[] = [...pendingRows, ...topologyPending];

    /* ---------- 一次校验、一次写回（H05：绝不半截提交） ---------- */

    /**
     * 三表同步**被尝试过**却失败（该分支本来有三表，却因为候选不合法同步不了）→
     * 整轮**零写入**：只写世界会让「世界长了、三表没长」，正是要删掉的那种半截提交。
     * 分支本来就没有三表（导入 / 未懒迁移）不算失败——那种情况旧行为就是只写世界。
     */
    const tablesSyncAttempted = binding !== null && branchTables !== null;
    if (tablesSyncAttempted && tableSync.status === "failed") {
      pushLog({
        at: now(),
        level: "warn",
        kind: "world-geo-adopt-aborted",
        worldId: world.id,
        source: input.source,
        reasonCode: tableSync.reasonCode,
        coreCommitted: false,
      });
      return {
        regionsAdded: 0, pointsAdded: 0, skipped, revisionAppended: false, regionNames: [], pointNames: [],
        tables: tableSync,
        preview: plan.preview,
        pending: pendingAll,
        mapScale: null,
      };
    }

    await store.write(`world:${world.id}`, updated);
    worldCache.set(world.id, updated);
    if (nextTablesDoc !== null) await store.write(tablesKey, nextTablesDoc);
    if (newPoints.length > 0) await store.write(mapsKey, nextMapsDoc);
    if (nextSimulationDoc !== null) await store.write(`simulation:${world.id}`, nextSimulationDoc);
    if (pendingAll.length > 0) {
      try {
        await store.write(`geo-auto:pending:${world.id}`, {
          at: now(),
          worldId: world.id,
          branchKey,
          source: input.source,
          rows: pendingAll.slice(0, 40),
          total: pendingAll.length,
        });
      } catch {
        // 同上：留痕失败不影响已提交的提炼
      }
    }

    /**
     * H18b：**建世界图**时顺带给当前图建立尺度状态。
     *
     * 只有本轮真的「从无到有」建出世界图（提炼前一个地点都没有）才走这一步；
     * 已有世界图的提炼**不额外发模型请求**（作者要重估可在界面上手动触发）。
     * 尺度失败只是 `scale-pending`：地图照常保留、界面显示「未标定 · 按格」，
     * 绝不阻断提炼本身（世界与三表已经写回）。
     */
    let mapScale: { status: string; reasonCode?: string } | null = null;
    if (binding !== null && (world.points ?? []).length === 0 && (updated.points ?? []).length > 0) {
      try {
        const ensured = await ensureMapScaleOnCreate({
          chatId: binding.chatId,
          branchKey,
          mapId: "world",
          revision: SUBMAP_FRAME_DEFAULT.frameRevision,
          frame: { ...SUBMAP_FRAME_DEFAULT },
          ...(lore ? { loreEvidence: lore.slice(0, ATLAS_LIMITS.LORE_SUPPLEMENT_CHARS) } : {}),
        });
        mapScale = ensured.status === "scale-pending"
          ? { status: ensured.status, reasonCode: ensured.reasonCode }
          : { status: ensured.status };
      } catch (thrown) {
        mapScale = { status: "scale-pending", reasonCode: thrown instanceof AtlasError ? thrown.code : "INTERNAL" };
        pushLog({ at: now(), kind: "world-scale-pending", worldId: world.id, mapId: "world", reasonCode: mapScale.reasonCode });
      }
    }

    pushLog({
      at: now(),
      kind: "world-geo-adopt",
      worldId: world.id,
      source: input.source,
      regionsAdded: newRegions.length,
      pointsAdded: newPoints.length,
      skipped,
      revisionAppended: revision.ok,
      reasonCode: tableSync.reasonCode,
    });
    if (skipped > 0 || pendingAll.length > 0 || mirrorLinksSkipped > 0) {
      // 越限 / 待确认都不静默：只记数量与代码，不记故事原文
      pushLog({
        at: now(),
        kind: "world-geo-adopt-pending",
        worldId: world.id,
        skipped: pendingAll.length,
        scanned: planCandidates.length,
      });
    }
    if (mirrorLinksSkipped > 0) {
      // 非数字 loc id 的子图点无法进世界镜像：记数量（绝不瞎编 parentPointId）
      pushLog({ at: now(), kind: "world-geo-mirror-links-skipped", worldId: world.id, skipped: mirrorLinksSkipped, scanned: mirrorLinks });
    }
    return {
      regionsAdded: newRegions.length,
      pointsAdded: newPoints.length,
      skipped,
      revisionAppended: revision.ok,
      regionNames: newRegions.map((r) => r.name),
      pointNames: newPoints.map((p) => p.name),
      tables: tableSync,
      preview: plan.preview,
      pending: pendingAll,
      mapScale,
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
    /**
     * H18e（0.9.59）：分支身份**从绑定推**，不接受客户端自报分支。
     *
     * 标定键按分支作用域映射：正史（`canon`）沿用旧的 `calibrations[mapId]`，
     * 0.9.58 存档照读；IF 用 `branchKey|mapId`——IF 重标教室绝不覆盖正史教室的数值
     * （T12 / T27 / T28）。**每张图各标一次**，世界图尺度不会外溢到车厢 / 教室图。
     */
    const calibrateBranchKey = branchScopeForStory(world, binding.branchId) ?? "canon";
    const calibrationKey = scaleCalibrationKey(calibrateBranchKey, mapId);

    const docKey = `maps:${world.id}`;
    const rawDoc = await store.read(docKey).catch(() => null);
    /**
     * H06a：这条路径会把清洗后的文档**写回**存档，所以清洗上限必须够宽且有据可查：
     * calibrations 上限已由 40 提到 80（容纳 IF 的 `branchKey|mapId` 键），
     * 任何仍然超限的截断都要留下具名日志——绝不静默删掉作者已保存的标定。
     */
    const docOverCap = mapDocOverCapLosses(rawDoc);
    const docOverCapTotal = docOverCap.pointMeta + docOverCap.submaps + docOverCap.calibrations + docOverCap.submapPoints;
    if (docOverCapTotal > 0) {
      pushLog({
        at: now(),
        level: "warn",
        kind: "map-doc-over-cap-truncated",
        worldId: world.id,
        mapId,
        skipped: docOverCapTotal,
        scanned: docOverCap.calibrations,
      });
    }
    const doc = sanitizeMapDoc(rawDoc);
    const existing = doc.calibrations[calibrationKey] ?? null;
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
        /**
         * 行增量建出的内层地图：`maps.submaps` **只由 geo-apply（提炼/采纳）写入**，
         * 而行增量开场/回合建出的图不走那条路。结果就是界面（`/state` 的 `map.submaps`
         * 由三表投影现算）看得到子图、标定接口却回 400「宿主点位或父图不存在」——
         * 「待定 → 人工锁定」在这类图上直接不可用。
         *
         * 修法：三表是实体现值的唯一来源，所以这里按**三表投影**再认一次宿主——
         * 只要该 `loc:<mapId>` 行存在、且确实有孩子挂在它下面，它就是一张真子图。
         */
        const tablesRaw = await store.read(`tables:${world.id}`).catch(() => null);
        const tablesDoc = isPlainRecord(tablesRaw) ? tablesRaw : null;
        const branchRows = tablesDoc && isPlainRecord(tablesDoc.branches)
          ? (tablesDoc.branches as Record<string, unknown>)[calibrateBranchKey]
          : undefined;
        const locationRows = isPlainRecord(branchRows) && Array.isArray((branchRows as { locations?: unknown }).locations)
          ? (branchRows as { locations: Array<Record<string, unknown>> }).locations
          : [];
        const hostRowId = `loc:${mapId}`;
        const hostRow = locationRows.find((row) => String(row?.id ?? "") === hostRowId);
        const childCount = locationRows.filter((row) => String(row?.parentLocationId ?? "") === hostRowId).length;
        if (hostRow && childCount > 0) {
          hostPoint = { id: mapId, name: String(hostRow.name ?? mapId) };
          valid = true;
        }
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
      doc.calibrations[calibrationKey] = calibration;
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
    doc.calibrations[calibrationKey] = calibration;
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

  /**
   * 该分支可见世界：实现已抽到模块级 `visibleWorldForBindingWith`——A08 的懒迁移
   * 必须与请求路径共用同一份可见性口径（否则迁移会把别的分支的未来事实偷进三表）。
   */
  const visibleWorldForBinding = (world: World, binding: AtlasChatBinding): Promise<World> =>
    visibleWorldForBindingWith(store, world, binding);

  /**
   * E09（0.9.59）：`rejectHiddenV2Refs`（v2 封套的跨分支不可见引用守卫）已随 v2 执行链一起删除。
   * 分支可见性现在由三表路径自身保证：行增量回合只读当前分支的三表，引用不存在的 ID
   * 直接按 `DEPENDENCY_FAILED` / `TABLE_VALIDATION_FAILED` 拒绝该行（见 atlas-table-delta.ts），
   * 不存在「引用到别的分支未来实体」的通路。
   */
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
    // S11（0.9.55）：主角只读标记。主角判定的唯一权威是 world.characters[].role
    // （atlas-schedule 的 isProtagonistRole，与 move-author、日程安全网同一口径）。
    // 附近人物页改为按 relevantNpcIds 过滤后，主角会被上面「同地点补入相关」那条算进来
    //（玩家确实在该地点），但主角不能显示为「附近 NPC」——故由服务端给出标记，
    // UI 不必去猜 id（写死 char-main 会在用户自建世界上出错）。
    const protagonistById = new Map(
      (world.characters ?? []).map((c) => [String(c.id), isProtagonistRole(c.role)] as const),
    );
    // D02：目录分页——旧实现硬编码 slice(0, 48) / slice(0, 32)，超过就**静默消失**。
    // 现在接收可选分页（缺省仍是原来的 48 / 32，UI 行为不变），并把 total / truncated 一并下发，
    // 让 UI 能分区加载到全部实体（§3-D02「不静默 slice」）。
    const directoryPaging = isPlainRecord(body) && isPlainRecord(body.directory) ? body.directory : {};
    const readPaging = (value: unknown, fallback: number, cap: number): number => {
      const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
      return Math.max(0, Math.min(cap, parsed));
    };
    const npcOffset = readPaging((directoryPaging as Record<string, unknown>).npcOffset, 0, 10_000);
    const npcLimit = Math.max(1, readPaging((directoryPaging as Record<string, unknown>).npcLimit, 48, 500));
    const objectOffset = readPaging((directoryPaging as Record<string, unknown>).objectOffset, 0, 10_000);
    const objectLimit = Math.max(1, readPaging((directoryPaging as Record<string, unknown>).objectLimit, 32, 500));
    const npcDirectoryAll = runtimeView.npcs;
    const npcDirectory = npcDirectoryAll.slice(npcOffset, npcOffset + npcLimit).map((view) => {
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
        isProtagonist: protagonistById.get(String(view.id)) === true,
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
      .slice(objectOffset, objectOffset + objectLimit)
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
    // S5/S6 补刀（0.9.55）：投影把三样东西挡在视图外——坏 sidecar 引用（宿主地点已不存在 /
    // 父链不可达 / 超深度的幽灵子图）、超过 40 张地图上限的可见子图、v1 虚拟点与 v2 新点同名。
    // 施工单 S5 要求「丢弃于视图并记录数目」、S6 要求「不得静默吞掉」：三样都记只含数量的
    // 具名诊断（kind → code 由 pushLog 统一转换），让「东西不见了」有据可查。
    const ghostSubmapCount = Object.keys(projected.submaps).filter((key) => !visibleSubmapIds.has(key)).length;
    if (ghostSubmapCount > 0) {
      pushLog({ kind: "map-projection-ghost-submaps-dropped", skipped: ghostSubmapCount });
    }
    const visibleSubmapCount = Object.keys(projected.submaps).filter((key) => visibleSubmapIds.has(key)).length;
    const mapsOverCap = Math.max(0, visibleSubmapCount - submapEntries.length);
    if (mapsOverCap > 0) {
      pushLog({ kind: "map-projection-maps-truncated", skipped: mapsOverCap });
    }
    if (projection.nameCollisions > 0) {
      pushLog({ kind: "map-projection-name-collisions-kept", skipped: projection.nameCollisions });
    }
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
      // H06a：上限由 40 提到 80 —— 容纳 IF 分支的 `branchKey|mapId` 键，
      // 不允许无提示地把用户已保存的第 41 张标定截掉。
      .slice(0, 80);
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
        /**
         * H09：当前分支**已确认**的地理拓扑（只读）。
         *
         * 只读本 session 当前分支——切 IF 之后城墙 / 已送达范围 / 车辆状态与标尺
         * 都要按当前分支重算，不能沿用上一分支的图。每类各自有界并给出真实 total/truncated；
         * 旧 /state 没有该字段仍然可解析（客户端整段跳过）。
         */
        geoTopology: await (async () => {
          const branchKey = branchScopeForStory(world, binding.branchId) ?? "canon";
          const raw = await store.read(`simulation:${binding.worldId}`).catch(() => null);
          const doc = isPlainRecord(raw) ? (raw as unknown as AtlasSimulationStore) : null;
          const branch = doc && isPlainRecord(doc.branches) ? doc.branches[branchKey] : undefined;
          const topology = branch && isPlainRecord(branch.geoTopology)
            ? (branch.geoTopology as { edges?: unknown; areas?: unknown; vehicles?: unknown })
            : null;
          const edges = Array.isArray(topology?.edges) ? topology.edges : [];
          const areas = Array.isArray(topology?.areas) ? topology.areas : [];
          const vehicles = Array.isArray(topology?.vehicles) ? topology.vehicles : [];
          return {
            branchKey,
            edges: edges.slice(0, 256),
            areas: areas.slice(0, 64),
            vehicleAnchors: vehicles.slice(0, 64),
            counts: { edges: edges.length, areas: areas.length, vehicles: vehicles.length },
            truncated: {
              edges: Math.max(0, edges.length - 256),
              areas: Math.max(0, areas.length - 64),
              vehicles: Math.max(0, vehicles.length - 64),
            },
          };
        })(),
      },
      npcDirectory,
      regions,
      objectDirectory,
      lastAdvance,
      /**
       * D02：目录的可达性信息——UI 据此分区加载，不再有"第 49 个人物永远看不见"。
       * total 用**三表权威计数**（有 tables 时）或旧路径全量长度；truncated 是本次响应没放进来的条数。
       */
      directoryTotals: await (async () => {
        const branchKey = branchScopeForStory(world, binding.branchId) ?? "canon";
        const raw = await store.read(`tables:${binding.worldId}`).catch(() => null);
        const branches = isPlainRecord(raw) && isPlainRecord(raw.branches)
          ? (raw.branches as Record<string, unknown>)
          : null;
        const branchTables = branches === null ? undefined : branches[branchKey];
        const tableCounts = isPlainRecord(branchTables)
          ? {
              characters: Array.isArray((branchTables as { characters?: unknown }).characters)
                ? ((branchTables as { characters: unknown[] }).characters.length) : 0,
              items: Array.isArray((branchTables as { items?: unknown }).items)
                ? ((branchTables as { items: unknown[] }).items.length) : 0,
            }
          : null;
        const objectTotalAll = (world.entityRecords ?? []).filter((e) => {
          if (String(e.type).toLowerCase() === "npc") return false;
          const anchor = e.mapAnchor;
          return Boolean(anchor && (anchor.pointId || anchor.regionId));
        }).length;
        const npcTotal = tableCounts ? tableCounts.characters : npcDirectoryAll.length;
        const objectTotal = tableCounts ? tableCounts.items : objectTotalAll;
        return {
          npc: { offset: npcOffset, limit: npcLimit, total: npcTotal, returned: npcDirectory.length,
            truncated: Math.max(0, npcTotal - npcOffset - npcDirectory.length) },
          object: { offset: objectOffset, limit: objectLimit, total: objectTotal, returned: objectDirectory.length,
            truncated: Math.max(0, objectTotal - objectOffset - objectDirectory.length) },
          source: tableCounts ? "tables" : "legacy",
        };
      })(),
      /**
       * D02：三表地图视图（D01 投影）。**只在已经迁移过的分支上出现**——
       * 旧会话（还没有 tables）仍是上面那套世界派生的字段，行为一字不变。
       * 新通道带 total/truncated，UI 可以分区加载；ID 口径与既有字段对齐（数字点 id）。
       */
      tableMap: await (async () => {
        const branchKey = branchScopeForStory(world, binding.branchId) ?? "canon";
        const raw = await store.read(`tables:${binding.worldId}`).catch(() => null);
        const branches = isPlainRecord(raw) && isPlainRecord(raw.branches)
          ? (raw.branches as Record<string, unknown>)
          : null;
        const branchTables = branches === null ? undefined : branches[branchKey];
        if (!isPlainRecord(branchTables)) return null;
        const view = projectTablesToMapView(
          branchTables as unknown as AtlasThreeTablesV1,
          projected,
          world,
          binding.currentLocationId ?? null,
          // E04a：与旧字段路径同一口径——已退役 / 仍是占位的「起点」不冒充真实地点
          hiddenPointIds,
        );
        return {
          branchKey,
          world: view.world,
          submaps: view.submaps,
          nearby: view.nearby,
          objects: view.objects,
          unknownPosition: view.unknownPosition,
          // F01/F02：未知坐标地点名单、附近原因、按地点的在场成员与徽标人数
          unplacedLocations: view.unplacedLocations,
          nearReasonCode: view.nearReasonCode,
          locationOccupants: view.locationOccupants,
          current: view.current,
          totals: view.totals,
          dropped: view.dropped,
        };
      })(),
      /**
       * D05：后台推演模块的**只读**视图。
       * 只读本 session 当前分支的 turn 与时间游标；**先按可见性筛选，再各自有界截断**，
       * 并给出真实 total / truncated。默认只出「已知」，hidden 不进主聊天注入。
       */
      simulationView: await (async () => {
        const branchKey = branchScopeForStory(world, binding.branchId) ?? "canon";
        const raw = await store.read(`simulation:${binding.worldId}`).catch(() => null);
        const doc = isPlainRecord(raw) ? (raw as unknown as AtlasSimulationStore) : null;
        const branch = doc && isPlainRecord(doc.branches) ? doc.branches[branchKey] : undefined;
        // §2.3：作者界面可显式选择「全部（含未被主角得知）」；默认只给已知
        const showHidden = isPlainRecord(body) && body.simulationVisibility === "all";
        const tasksAll = (branch?.tasks ?? []).filter((row) => showHidden || row.visibility !== "hidden");
        const signalsAll = (branch?.signals ?? []).filter((row) => showHidden || row.visibility !== "hidden");
        const signalIds = new Set(signalsAll.map((row) => row.id));
        const deliveriesAll = (branch?.deliveries ?? [])
          .filter((row) => showHidden || signalIds.has(row.signalId));
        // 事件只从**本 session、本分支**的回合记录里取；旧回合没有该字段视为空
        const turnNames = await store.list(`turn:${chatId}:`).catch(() => [] as string[]);
        const events: AtlasSimulationEvent[] = [];
        for (const name of turnNames) {
          const turn = await store.read(name).catch(() => null);
          if (!isPlainRecord(turn) || turn.branchId !== binding.branchId) continue;
          // C10：已回退的回合，其 simulationEvents 不再可见（文档保留 = 可审计）
          if (turn.rolledBack === true) continue;
          const rows = Array.isArray(turn.simulationEvents) ? turn.simulationEvents : [];
          for (const item of rows) {
            if (!isPlainRecord(item)) continue;
            if (!showHidden && item.visibility === "hidden") continue;
            events.push(item as unknown as AtlasSimulationEvent);
          }
        }
        const LIMIT = { tasks: 20, signals: 12, deliveries: 24, events: 16 } as const;
        return {
          branchKey,
          tasks: tasksAll.slice(-LIMIT.tasks),
          signals: signalsAll.slice(-LIMIT.signals),
          deliveries: deliveriesAll.slice(-LIMIT.deliveries),
          recentEvents: events.slice(-LIMIT.events),
          counts: {
            tasks: tasksAll.length,
            signals: signalsAll.length,
            deliveries: deliveriesAll.length,
            events: events.length,
            activeTasks: tasksAll.filter((row) => row.status === "active" || row.status === "queued").length,
            blockedTasks: tasksAll.filter((row) => row.status === "blocked").length,
          },
          truncated: {
            tasks: Math.max(0, tasksAll.length - LIMIT.tasks),
            signals: Math.max(0, signalsAll.length - LIMIT.signals),
            deliveries: Math.max(0, deliveriesAll.length - LIMIT.deliveries),
            events: Math.max(0, events.length - LIMIT.events),
          },
          // 「尚未确定当前位置」与「附近没有人」是两件事（§2.4 / T09）
          currentLocationKnown: (binding.currentLocationId ?? null) !== null,
          visibility: showHidden ? "all" : "known",
          corrupt: doc === null && raw !== null && raw !== undefined,
        };
      })(),
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
    // E05：开场识别与普通回合同一道闸——旧协议自定义提示词在发请求前阻断（零 API 调用）
    if (prepared.customPromptShape === "legacy-v1" || prepared.customPromptShape === "legacy-v2") {
      pushLog({
        at: now(),
        kind: "world-turn-protocol-mismatch",
        chatId: binding.chatId,
        presetName: preset.name,
        model: preset.model,
        reasonCode: prepared.customPromptShape === "legacy-v2" ? "LEGACY_V2_PROMPT_PRESET" : "LEGACY_V1_PROMPT_PRESET",
        coreCommitted: false,
      });
      throw new AtlasError(
        ATLAS_ERROR_CODES.PROTOCOL_MISMATCH,
        legacyPromptBlockMessage(prepared.customPromptShape),
        { schemaPath: "$.promptPreset", retryable: false },
      );
    }

    // 首次推演请求；只有引文错误导致零有效行时才追加一次纠错请求。
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

    let cleanedText = applyContentReplaceRules(call.text, current.contentReplaceRules ?? []);
    const bootstrapRepair = await repairQuoteOnlyReply({
      text: cleanedText, preset: prepared.effectivePreset, prompt: prepared.input,
      userText, assistantText, chatId: binding.chatId,
    });
    if (bootstrapRepair !== null) cleanedText = applyContentReplaceRules(bootstrapRepair, current.contentReplaceRules ?? []);
    /**
     * E06（0.9.59）：开场识别走**与普通回合同一条**行增量契约。
     *
     * 旧实现无条件解析 v2 整份封套——即使设置已经是 `table-delta-v1`，开场仍要模型
     * 再吐一份 v2。这正是 F5「直接删 v2 会让开场失效」的成因，也是 T02/T17 的停机线。
     * 现在开场复用 `applyAtlasEditText`（内部即 parseAtlasEditBlock + 三表校验）
     * 与普通回合同一套三表候选组装，并且**铁律不变**：duration 恒为 0，不跑自主后台移动。
     */
    const bootstrapBranchKey = branchScopeForStory(world, binding.branchId) ?? "canon";
    const bootstrapTablesRaw = await store.read(`tables:${binding.worldId}`).catch(() => null);
    const bootstrapTablesDoc = isPlainRecord(bootstrapTablesRaw)
      ? (bootstrapTablesRaw as unknown as AtlasTablesStoreV1) : null;
    const bootstrapBranchTables = bootstrapTablesDoc?.branches?.[bootstrapBranchKey];
    if (!bootstrapTablesDoc || !isPlainRecord(bootstrapBranchTables)) {
      pushLog({
        at: now(),
        kind: "scene-bootstrap-rejected",
        chatId: binding.chatId,
        reasonCode: "TABLE_BRANCH_MISSING",
      });
      throw new AtlasError(
        ATLAS_ERROR_CODES.RESPONSE_MALFORMED,
        "本分支还没有三表快照（懒迁移未完成或会话损坏）。开场未提交；请刷新后重试。",
        { retryable: true },
      );
    }
    const bootstrapBaseTables = bootstrapBranchTables as unknown as AtlasThreeTablesV1;
    const parsed = applyAtlasEditText(
      bootstrapBaseTables,
      cleanedText,
      {
        "msg:u": userText,
        "msg:a": assistantText,
        ...(prepared.input.loreSupplement ? { lore: prepared.input.loreSupplement } : {}),
      },
    );
    if (parsed.parse.status === "rejected" || parsed.delta === null) {
      const first = parsed.parse.error;
      pushLog({
        at: now(),
        kind: "scene-bootstrap-rejected",
        chatId: binding.chatId,
        reasonCode: first?.code ?? "BLOCK_MISSING",
        errorCount: parsed.parse.rejected.length,
      });
      throw new AtlasError(
        ATLAS_ERROR_CODES.RESPONSE_MALFORMED,
        `开场识别输出缺少可用的行增量块（${first?.code ?? "BLOCK_MISSING"} @ ${first?.path ?? "$.block"}）：开场未提交，可重试识别。`,
        { retryable: true },
      );
    }
    const delta = parsed.delta;
    if (!delta.ok) {
      const error = delta.error;
      pushLog({
        at: now(),
        kind: "scene-bootstrap-rejected",
        chatId: binding.chatId,
        reasonCode: error?.code ?? "DELTA_REJECTED",
      });
      throw new AtlasError(
        ATLAS_ERROR_CODES.RESPONSE_MALFORMED,
        `开场候选三表未通过校验（${error?.code ?? "UNKNOWN"} @ ${error?.path ?? "$"}）：开场未提交，可重试识别。`,
        { retryable: true },
      );
    }

    // 候选与基线做差：preview / apply 都只报**本轮真正新增**的行
    const baseLocationIds = new Set(bootstrapBaseTables.locations.map((row) => row.id));
    const baseCharacterIds = new Set(bootstrapBaseTables.characters.map((row) => row.id));
    const newLocationRows = delta.tables.locations.filter((row) => !baseLocationIds.has(row.id));
    const newCharacterRows = delta.tables.characters.filter((row) => !baseCharacterIds.has(row.id));
    const acceptedRows = delta.applied.map((row) => ({
      line: row.line, id: typeof row.id === "string" ? row.id : "", op: typeof row.op === "string" ? row.op : "set",
    }));
    const rejectedRows = [
      ...parsed.parse.rejected.map((row) => ({ line: row.line, code: String(row.code), path: row.path, ...(row.ref === undefined ? {} : { ref: row.ref }) })),
      ...delta.rejected.map((row) => ({
        line: row.line,
        code: String(row.code ?? "REJECTED"),
        path: typeof row.path === "string" ? row.path : "$",
        ...(row.ref === undefined ? {} : { ref: row.ref }),
      })),
    ];

    if (!apply) {
      // preview 只返回**解析后的候选与拒绝行**，不做任何存储
      return okResult({
        status: "preview",
        protocol: "table-delta-v1",
        callCount: 1,
        baseRevision: binding.worldTimeCursor,
        duration: 0,
        newLocations: newLocationRows.map((row) => ({ id: row.id, name: row.name, parentLocationId: row.parentLocationId })),
        newCharacters: newCharacterRows.map((row) => ({ id: row.id, name: row.name, locationId: row.locationId })),
        acceptedRows,
        rejectedRows,
      });
    }

    /**
     * apply：候选三表 → 世界镜像（与普通回合**同一条**投影），
     * 再把定位写进绑定与 scene。开场铁律：duration 恒为 0，不跑自主后台移动。
     */
    const mirrored = tablesToLegacyWorld({
      tables: delta.tables,
      world,
      branchId: binding.branchId,
      at: binding.worldTimeCursor,
    });
    let finalWorld = mirrored.world;
    const placeholder = detectStartPlaceholder(world);
    const sceneDoc = sanitizeSceneDoc(await store.read(sceneDocKey(world.id)).catch(() => null));
    /**
     * 当前位置只随**已接受的主角行**锚定；没有就诚实保持未知——
     * 绝不"造一个起点"（§2.4 / E06「未定位只返回未知」）。
     */
    const bootstrapPlayerRowId = binding.characterId ? characterRowId(String(binding.characterId)) : null;
    const bootstrapPlayerRow = bootstrapPlayerRowId === null
      ? undefined : delta.tables.characters.find((row) => row.id === bootstrapPlayerRowId);
    const anchoredPointId = bootstrapPlayerRow?.locationId
      ? pointIdFromLocationRowId(bootstrapPlayerRow.locationId) : null;
    const anchored = anchoredPointId !== null;

    let nextDoc: SceneDoc = {
      ...sceneDoc,
      bootstrap: {
        attempts: (sceneDoc.bootstrap?.attempts ?? 0) + 1,
        lastAt: now(),
        lastStatus: anchored ? "committed" : "unknown",
      },
    };
    if (anchored) {
      const retire = retireStartPlaceholder(finalWorld, nextDoc, { now: now(), info: placeholder });
      finalWorld = retire.world;
      nextDoc = retire.doc;
      nextDoc = { ...nextDoc, lastConfirmed: { branchId: binding.branchId, pointId: String(anchoredPointId), at: binding.worldTimeCursor } };
    }
    await store.write(`world:${binding.worldId}`, finalWorld);
    worldCache.set(binding.worldId, finalWorld);
    // 三表候选与 world 在**同一次会话响应**里落盘，不出现"世界建了、三表还没有"的半截状态
    await store.write(`tables:${binding.worldId}`, {
      schemaVersion: 1,
      worldId: binding.worldId,
      branches: { ...(bootstrapTablesDoc.branches ?? {}), [bootstrapBranchKey]: delta.tables },
    } satisfies AtlasTablesStoreV1);
    if (anchored) {
      const nextBinding: AtlasChatBinding = {
        ...binding,
        currentLocationId: String(anchoredPointId),
        // 开场不推进时间：游标原样保持
        worldTimeCursor: binding.worldTimeCursor,
      };
      await store.write(`binding:${binding.chatId}`, nextBinding);
      bindingCache.set(binding.chatId, nextBinding);
    }
    await store.write(sceneDocKey(world.id), nextDoc);
    /**
     * E06b / H18a：只为**本次实际创建**的内层地图尝试一次尺度标定。
     *
     * - 时段始终为零，也不启动任何背景旅行（上一段的 duration=0 不变）；
     * - 已有有效尺度 → 零新模型请求；
     * - 缺依据 / 缺 API / 模型 unknown → `scale-pending`：地图照常保留并标记待定，
     *   界面显示「未标定 · 按格」，绝不继承世界图单位，也绝不走旧 v2 的比例尺提示。
     * 标定失败**不影响开场本身**——世界与三表已经落盘。
     */
    const newHostMapIds = newLocationRows
      .map((row) => pointIdFromLocationRowId(row.id))
      .filter((pointId): pointId is number => pointId !== null)
      .filter((pointId) => delta.tables.locations.some((child) => child.parentLocationId === `loc:${pointId}`));
    const mapScale: Array<{ mapId: string; status: string; reasonCode?: string }> = [];
    for (const hostPointId of newHostMapIds.slice(0, 4)) {
      const hostRow = delta.tables.locations.find((row) => row.id === `loc:${hostPointId}`);
      try {
        const ensured = await ensureMapScaleOnCreate({
          chatId: binding.chatId,
          branchKey: bootstrapBranchKey,
          mapId: String(hostPointId),
          revision: 1,
          frame: { ...SUBMAP_FRAME_DEFAULT },
          ...(hostRow && hostRow.description ? { description: hostRow.description } : {}),
        });
        mapScale.push(ensured.status === "scale-pending"
          ? { mapId: String(hostPointId), status: ensured.status, reasonCode: ensured.reasonCode }
          : { mapId: String(hostPointId), status: ensured.status });
      } catch {
        mapScale.push({ mapId: String(hostPointId), status: "scale-pending", reasonCode: "INTERNAL" });
      }
    }
    return okResult({
      status: anchored ? "committed" : "unknown",
      protocol: "table-delta-v1",
      callCount: 1,
      duration: 0,
      anchoredLocationId: anchored ? String(anchoredPointId) : null,
      placeholderRetired: nextDoc.retiredPointIds.length > sceneDoc.retiredPointIds.length,
      newLocations: newLocationRows.map((row) => ({ id: row.id, name: row.name, parentLocationId: row.parentLocationId })),
      newCharacters: newCharacterRows.map((row) => ({ id: row.id, name: row.name, locationId: row.locationId })),
      acceptedRows,
      rejectedRows,
      // H18a：新建内层地图的标定结果（scale-pending = 地图保留、按格显示）
      mapScale,
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
      // 为历史提示词预设的 $B 占位符提供世界时间游标。
      baseRevision: binding.worldTimeCursor,
    };
    /**
     * E05（0.9.59）：所有 `mode=normal|bootstrap` 的 effectivePreset 统一使用**增量契约**。
     *
     * 旧实现按 `settings.worldTurnProtocol` 分流：v2 时装 v2 封套分段、v1 时装旧草稿分段。
     * 现在只有一种契约，因此：
     * - 未自定义提示词 → 内置六段行增量分段（bootstrap 只换掉「本轮行动」段）；
     * - 作者自定义了连接级 systemPrompt / 预设分段 → **尊重作者措辞**，但 $5 素材仍换成
     *   三表派生的有界上下文（素材属于协议，措辞属于作者）；若自定义内容仍写着旧 v1/v2
     *   封套格式（`"schemaVersion": 2` / `narrativeSummary` 等），在**发请求之前**明确阻断并
     *   指向迁移入口——绝不把 v2 提示词送进行增量解析器再记一句 "response malformed"。
     */
    const protocol = normalizeWorldTurnProtocol((await loadSettings()).worldTurnProtocol);
    const authorOverridden = Boolean(preset.systemPrompt?.trim()) || (Array.isArray(preset.promptSegments) && preset.promptSegments.length > 0);
    const authorPromptText = [
      preset.systemPrompt ?? "",
      ...(Array.isArray(preset.promptSegments) ? preset.promptSegments.map((segment) => String(segment.content ?? "")) : []),
    ].join("\n");
    const customPromptShape = authorOverridden ? detectLegacyPromptShape(authorPromptText) : "none";
    let effectivePreset = preset;
    let tableContextTruncated: AtlasTableContextResult["truncated"] | null = null;
    {
      // A08 的懒迁移只挂内存；这里按分支取三表，取不到就退回世界状态文本（并记截断为 null 表示未用三表）
      const branchKey = branchScopeForStory(world, binding.branchId) ?? "canon";
      const doc = await store.read(`tables:${binding.worldId}`).catch(() => null);
      const branchTables = isPlainRecord(doc) && isPlainRecord(doc.branches)
        ? (doc.branches as Record<string, unknown>)[branchKey]
        : undefined;
      if (isPlainRecord(branchTables)) {
        const mapsDoc = sanitizeMapDoc(await store.read(`maps:${binding.worldId}`).catch(() => null));
        const built = buildTableDeltaContext({
          tables: branchTables as unknown as AtlasThreeTablesV1,
          world,
          binding,
          maps: mapsDoc,
        });
        input.injectionText = built.text;
        tableContextTruncated = built.truncated;
      }
      if (!authorOverridden) {
        const segments = options?.mode === "bootstrap"
          ? [...DEFAULT_PROMPT_SEGMENTS_TABLE_DELTA.slice(0, 4), { role: "user", name: "开场识别任务（mode=bootstrap）", mainSlot: "B", content: TABLE_DELTA_BOOTSTRAP_TASK_CONTENT }, DEFAULT_PROMPT_SEGMENTS_TABLE_DELTA[5]!]
          : DEFAULT_PROMPT_SEGMENTS_TABLE_DELTA;
        effectivePreset = { ...preset, promptSegments: segments.map((s) => ({ ...s })) };
      }
    }
    return {
      world, prepareOutput, currentPointId, currentRegionId, input, recentAssistantTexts,
      effectivePreset, protocol, tableContextTruncated, authorOverridden, customPromptShape,
    };
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
    /**
     * E05：作者自定义提示词仍写着旧 v1/v2 封套格式 → **发请求之前**阻断（零 API 调用），
     * 明确指向迁移入口；绝不把旧协议提示词送给增量解析器再记一句 "response malformed"。
     */
    if (prepared.customPromptShape === "legacy-v1" || prepared.customPromptShape === "legacy-v2") {
      pushLog({
        at: now(),
        kind: "world-turn-protocol-mismatch",
        chatId: request.chatId,
        presetName: preset.name,
        model: preset.model,
        reasonCode: prepared.customPromptShape === "legacy-v2" ? "LEGACY_V2_PROMPT_PRESET" : "LEGACY_V1_PROMPT_PRESET",
        coreCommitted: false,
      });
      throw new AtlasError(
        ATLAS_ERROR_CODES.PROTOCOL_MISMATCH,
        legacyPromptBlockMessage(prepared.customPromptShape),
        { schemaPath: "$.promptPreset", retryable: false },
      );
    }

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

    // 5. 首次推演请求；只有引文错误导致零有效行时才追加一次纠错请求。
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
    //    E07：不再有「draft」中间量——唯一入口是 <atlasEdit> 行增量块，直接产出 output。
    let output;
    /** C05：table-delta 路径算好的整份三表文档（含本分支更新），与 world 同一次会话响应写回。 */
    let nextTablesDoc: AtlasTablesStoreV1 | null = null;
    /**
     * E05：本回合**提交前**的三表快照（table-delta 路径才有）。
     * swipe / 编辑 / 删除触发的 `/turns/rollback` 必须把三表一起还原到回合前——
     * 否则世界回退了、三表还带着"未来"的地点/人物/物品，地图与附近列表会与正文错位。
     * 只在本轮真的走行增量协议时记录；v1/v2 回合没有三表快照，回退时按回退后的世界重建（见 handleRollback）。
     */
    let tablesBeforeTurn: { branchKey: string; tables: AtlasThreeTablesV1 } | null = null;
    /** C05：table-delta 路径已在本轮内做过日程结算——公共段不得重复结算。 */
    let settledInTablePath = false;
    /**
     * C09：table-delta 路径算好的推演模块候选。与 world / tables / maps / binding / turn
     * **同一次会话响应**写回；任一校验或写入失败就整轮不向 chatMetadata 发布，
     * 绝不「先返回 receipt 成功、再单独补第四表」。
     */
    let nextSimulationDoc: AtlasSimulationStore | null = null;
    /** C09：本轮归档的推演事件（C10 回退时按 turn 记录删除）。 */
    let simulationEvents: AtlasSimulationEvent[] = [];
    /** C11/C10：本轮逐行逆操作（禁止逐回合复制整模块）。 */
    let simulationUndo: AtlasSimulationUndoEntry[] = [];
    /** C04：主人公等不可被模型改写身份的**三表行 id**（B02 的保护名单口径）。 */
    const protectedCharacterIds = new Set(
      (world.characters ?? [])
        .filter((character) => isProtagonistRole(character.role))
        .map((character) => characterRowId(String(character.id))),
    );
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
      let cleanedText = applyContentReplaceRules(call.text, current.contentReplaceRules ?? []);
      const repairedText = await repairQuoteOnlyReply({
        text: cleanedText, preset: prepared.effectivePreset, prompt: prepared.input,
        userText: request.userText, assistantText: request.assistantText, chatId: request.chatId,
      });
      if (repairedText !== null) cleanedText = applyContentReplaceRules(repairedText, current.contentReplaceRules ?? []);
      /**
       * E07（0.9.59）：**唯一入口只解析最后一个完整 `<atlasEdit>` 块**。
       *
       * 已删除的旧行为（计划 §3-E07 原文）：
       * - 按 `settings.worldTurnProtocol` 在 v1 草稿 / v2 封套 / 行增量之间分流；
       * - 「从正文猜协议」的补救路径（全文正则命中 `"schemaVersion":2` 就悄悄换管线）。
       * 两者都会让「装错提示词的作者」看到与真实原因无关的报错。
       *
       * 现在的形态正则**只用于诊断与迁移提示**，不参与分派：
       * - 响应里出现 v2 封套 → `PROTOCOL_MISMATCH`（指向 `$.schemaVersion` 与迁移入口），
       *   明确**不当作 noop**（旧实现会静默成功提交、世界零变化）；
       * - 响应里出现旧 v1 草稿特征 → 同样 `PROTOCOL_MISMATCH`，同样给迁移入口。
       */
      const looksV2Text = /"schemaVersion"\s*:\s*2/.test(cleanedText) || /"schemaVersion"\s*:\s*2/.test(call.text);
      const looksTableDeltaText = /<\/atlasEdit>/.test(cleanedText) || /<\/atlasEdit>/.test(call.text);
      if (!looksTableDeltaText && looksV2Text) {
        pushLog({
          at: now(),
          kind: "world-turn-protocol-mismatch",
          chatId: request.chatId,
          presetName: preset.name,
          model: preset.model,
          reasonCode: "LEGACY_V2_ENVELOPE",
          schemaPath: "$.schemaVersion",
          coreCommitted: false,
        });
        throw new AtlasError(
          ATLAS_ERROR_CODES.PROTOCOL_MISMATCH,
          "响应是旧「v2 世界封套」（$.schemaVersion = 2），而当前唯一输出契约是「表格增量」"
            + "（一个 <atlasEdit> 块、块内每行一个独立 JSON）。本轮未提交，世界与时间未变化。"
            + "迁移入口：到「推进」页把提示词预设换成「表格增量（table-delta-v1）」内置六段或"
            + "用「创建兼容增量草稿」生成新预设；旧预设原文不会被改动。",
          { schemaPath: "$.schemaVersion", retryable: true },
        );
      }
      {
        const branchKey = branchScopeForStory(prepared.world, binding.branchId) ?? "canon";
        const tablesRaw = await store.read(`tables:${binding.worldId}`).catch(() => null);
        const tablesDoc = isPlainRecord(tablesRaw) ? (tablesRaw as unknown as AtlasTablesStoreV1) : null;
        const branchTables = tablesDoc && isPlainRecord(tablesDoc.branches)
          ? (tablesDoc.branches as Record<string, unknown>)[branchKey]
          : undefined;
        if (!isPlainRecord(branchTables)) {
          pushLog({
            at: now(),
            kind: "world-turn-delta-rejected",
            chatId: request.chatId,
            worldId: binding.worldId,
            reasonCode: "TABLE_BRANCH_MISSING",
            coreCommitted: false,
          });
          throw new AtlasError(
            ATLAS_ERROR_CODES.RESPONSE_MALFORMED,
            "本分支还没有三表快照（懒迁移未完成或会话损坏）。本轮未提交；请刷新后重试，或到变化页查看迁移错误。",
            { retryable: true },
          );
        }
        /**
         * D01/D02：推演模块必须在三表提交**之前**读出来——D01 要用它的 `geoTopology`
         * 逐段规划后台行动，D02 要用它做消息传播。一次读取、同一份候选，
         * 避免中途再读一次拿到不同版本。
         *
         * 旧会话缺 `simulation` 字段 = **合法空模块**（不是损坏）；损坏则明确报错并保留原文，
         * 绝不静默覆盖成空模块，也绝不「先回执成功再补第四表」。
         */
        const simulationRaw = await store.read(`simulation:${binding.worldId}`).catch(() => null);
        let previousSimulation: AtlasSimulationStore | null;
        if (simulationRaw === null || simulationRaw === undefined) {
          previousSimulation = createEmptySimulation(binding.worldId);
        } else {
          const simulationValidation = validateSimulationStore(simulationRaw, {
            expectedWorldId: binding.worldId,
            tablesByBranch: simulationTablesByBranch(tablesDoc),
          });
          previousSimulation = simulationValidation.ok ? (simulationRaw as AtlasSimulationStore) : null;
        }
        if (previousSimulation === null) {
          pushLog({
            at: now(),
            level: "warn",
            kind: "world-turn-simulation-corrupt",
            chatId: request.chatId,
            worldId: binding.worldId,
            reasonCode: "SIMULATION_CORRUPT",
            coreCommitted: false,
          });
          throw new AtlasError(
            ATLAS_ERROR_CODES.RESPONSE_MALFORMED,
            "会话里的推演模块未通过校验：已保留原始数据，本轮未提交。请到变化页导出确认后再继续推演。",
            { retryable: false },
          );
        }
        const committed = commitTableDeltaTurn({
          tables: branchTables as unknown as AtlasThreeTablesV1,
          tablesDoc,
          branchKey,
          baseWorld,
          binding,
          request: { userText: request.userText, assistantText: request.assistantText },
          text: cleanedText,
          now: now(),
          protectedCharacterIds,
          topology: previousSimulation.branches[branchKey]?.geoTopology ?? null,
          // H11：载具移动事件的 id 由幂等键派生 → 同回合重复提交不产生第二份事件
          turnKey: idempotencyKey,
        });
        if (!committed.ok) {
          // C08：回执里带上**具体行号与字段路径**（可复制），而不是笼统的"格式错误"。
          // 原始模型正文绝不进日志/回执（只留字符数与错误码）。
          const first = committed.rejectedRows.slice(0, 3)
            .map((row) => `第 ${row.line} 行 ${row.code}${row.path ? ` @ ${row.path}` : ""}${row.ref ? ` (${row.ref})` : ""}`)
            .join("；");
          pushLog({
            at: now(),
            kind: "world-turn-delta-rejected",
            chatId: request.chatId,
            worldId: binding.worldId,
            reasonCode: committed.code,
            errorCount: committed.rejectedRows.length,
            responseChars: repairedText !== null ? repairedText.length : call.text.length,
            coreCommitted: false,
          });
          logRejectedDeltaRows(committed.rejectedRows, request.chatId, false);
          throw new AtlasError(
            ATLAS_ERROR_CODES.RESPONSE_MALFORMED,
            `${committed.message}${first ? ` 首个问题：${first}` : ""}`,
            { retryable: true },
          );
        }
        nextTablesDoc = committed.tablesDoc;
        settledInTablePath = true;
        // E05：冻结回合前的三表（深拷贝，避免后续任何原地修改污染回退基线）
        tablesBeforeTurn = { branchKey, tables: cloneAtlasTables(branchTables as unknown as AtlasThreeTablesV1) };

        /**
         * C09：推演模块候选（`previousSimulation` 已在三表提交**之前**读好并校验过），
         * 这里只负责算效果——与 world / tables 同一份候选会话写回。
         */
        const branchAfter = nextTablesDoc?.branches?.[branchKey];
        const simulationEdits: AtlasSimulationAcceptedEdit[] = [];
        for (const row of committed.acceptedRows) {
          if (row.table !== "location" && row.table !== "character" && row.table !== "item") continue;
          const post = row.table === "character" && branchAfter
            ? branchAfter.characters.find((item) => item.id === row.ref) ?? null
            : null;
          simulationEdits.push({
            table: row.table,
            op: row.op === "add" || row.op === "remove" ? row.op : "set",
            ref: row.ref,
            // 人物行的**新值**供推演侧判断意图与目标；其它表不需要正文
            row: post === null ? null : (post as unknown as Record<string, unknown>),
          });
        }
        const periodsThisTurn = Math.max(0, committed.receipt.currentTime - committed.receipt.previousTime);
        /**
         * D02 跳数预算（§2.3「每完整新时段普通风声最多沿一条确认邻接边走 1 跳」）。
         *
         * **必须自消息发布起累计**，不能只交「本轮增量」：`planSignalSpread` 每轮都是从发起地
         * 按这个数字重算候选集，而 `propagationCursor` 是候选集里的下标。只给增量时，连续的单
         * 时段回合里第 2 轮的候选集仍是同一批「1 跳可达且已送达」的地点 → 0 条新送达，消息永远
         * 停在第 1 跳（只有一轮跨多时段才会一次跳多跳）。
         *
         * 口径（**按已送达前沿推进**）：每条活动消息的 `propagationCursor` 已经指出它走到第几跳
         * ——把候选集合按「跳数、id」排好，第 cursor 个候选所在跳数就是它的前沿 F。本轮预算取
         * `F + 本轮段数` 与「本轮段数」的较大者，于是：
         * - 每个新时段**恰好再走一跳**（单时段回合不再卡住，收件人集合严格增长）；
         * - 同轮跨多时段仍按真实段数一次跳多跳；
         * - 预算只会随 cursor 单调不减，**不会**出现候选集缩小把游标夹回去（那会让风声倒退 / 卡死）；
         * - `periodsThisTurn === 0` → 传 0：第 0 时段只记意图、绝不跨区送达，同时让
         *   `applySimulationEffects` 的 `noTime` 与旧语义逐字一致。
         *
         * 已知边界（如实记录）：`planSignalSpread` 的预算是**全局**参数，同一分支里同时存在多条
         * 活动消息时，前沿较浅的那条会借用较深那条的预算（最多多走「前沿差」跳，且多跳一律记
         * `confidence="rumor"`）。逐信号精确需要把预算改成按 `signal.publishedPeriod` / 各自前沿
         * 分别计算，那要改 `atlas-signal-propagation.ts`（不在本次施工边界内）。
         */
        const hopBudget = (() => {
          if (periodsThisTurn <= 0) return 0;
          const budgetTopology = previousSimulation.branches[branchKey]?.geoTopology ?? null;
          const activeSignals = (previousSimulation.branches[branchKey]?.signals ?? [])
            .filter((row) => row.status === "active" && row.propagationCursor > 0);
          if (budgetTopology === null || activeSignals.length === 0) return periodsThisTurn;
          // 任何简单路径都不会超过「边数 + 1」跳；用它做 BFS 上界，既够用又有界
          const maxHops = Math.max(1, budgetTopology.edges.length + 1);
          let frontier = 0;
          for (const signal of activeSignals) {
            const reachable = reachableLocationsWithin(budgetTopology, signal.originLocationId, maxHops);
            // 与 planSignalSpread 的候选排序逐字同口径：先近后远，同跳按 id 升序
            const candidates = [...reachable.entries()]
              .filter(([locationId]) => locationId !== signal.originLocationId)
              .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] - b[1]));
            if (candidates.length === 0) continue;
            const consumed = candidates[Math.min(signal.propagationCursor, candidates.length) - 1];
            frontier = Math.max(frontier, consumed?.[1] ?? 0);
          }
          return Math.max(periodsThisTurn, frontier + periodsThisTurn);
        })();
        const simulationMoves: AtlasSimulationMove[] = [
          ...committed.scheduleMoves.map((move) => ({
            actorCharacterId: characterRowId(move.characterId),
            kind: "schedule" as const,
            fromLocationId: move.fromPointId === null ? null : locationRowId(move.fromPointId),
            toLocationId: locationRowId(move.pointId),
            arrived: true,
            reasonCode: null,
            periodsUsed: periodsThisTurn,
          })),
          ...committed.backgroundMoves.map((move) => ({
            actorCharacterId: move.characterId,
            kind: "travel" as const,
            fromLocationId: move.fromLocationId,
            toLocationId: move.toLocationId,
            arrived: move.status === "moved",
            reasonCode: move.reasonCode ?? null,
            periodsUsed: periodsThisTurn,
          })),
        ];
        const simulationEffect = applySimulationEffects({
          chatId: binding.chatId,
          branchKey,
          previous: previousSimulation,
          turnKey: idempotencyKey,
          period: committed.receipt.currentTime,
          // D02：自发布起累计的跳数预算（见上面的 `hopBudget`），不是本轮增量
          periodsElapsed: hopBudget,
          acceptedEdits: simulationEdits,
          // E04 → D02：模型只能「提出一件已公开的事实」；到达时间与传播对象由算法决定
          proposals: committed.signalProposals.map((row) => ({
            originLocationId: row.originRef,
            topic: row.topic,
            sourceQuoteId: row.sourceQuoteId,
            visibility: row.visibility,
          })),
          moves: simulationMoves,
          characterLocations: (branchAfter?.characters ?? []).map((row) => ({
            id: row.id, locationId: row.locationId,
          })),
          // D02：只有**已确认**的拓扑才让风声逐跳走；没有边就是 NO_PATH，绝不猜
          topology: previousSimulation.branches[branchKey]?.geoTopology ?? null,
        });
        nextSimulationDoc = simulationEffect.next;
        simulationEvents = simulationEffect.events;
        simulationUndo = simulationEffect.undo;
        /**
         * H11：把载具行动的**新拓扑**写进同一份候选会话，并把逐行 undo 追加到本回合的
         * `simulationUndo`（C10 回退按行还原锚点；`applySimulationEffects` 只读拓扑、不改
         * edges/vehicles，所以这里整体替换不会丢掉任何东西）。
         *
         * 载具动作同时并入本轮 `simulationEvents`（有界 16 条）：左栏「幕后动向」因此能看到
         * 「载具在途 / 已抵达」，而不是只有回执里的一行数字。超出上限时如实记日志，不静默丢。
         */
        if (committed.vehicleTopology !== null) {
          const simBranchForVehicles = nextSimulationDoc.branches[branchKey] ?? createEmptySimulationBranch();
          simBranchForVehicles.geoTopology = committed.vehicleTopology;
          nextSimulationDoc.branches[branchKey] = simBranchForVehicles;
        }
        if (committed.vehicleUndo.length > 0) {
          simulationUndo = [...simulationUndo, ...committed.vehicleUndo];
        }
        if (committed.vehicleMoves.length > 0) {
          const eventLimit = 16;
          const room = Math.max(0, eventLimit - simulationEvents.length);
          const accepted = committed.vehicleMoves.slice(0, room);
          for (const move of accepted) {
            const status: AtlasSimulationEvent["status"] =
              move.status === "arrived" ? "arrived"
                : move.status === "blocked" ? "blocked"
                  : move.status === "started" ? "started" : "progressed";
            simulationEvents.push({
              id: move.eventId,
              simulationId: `vehicle:${move.vehicleLocationId}`,
              kind: "travel",
              actorCharacterId: null,
              fromLocationId: move.fromLocationId,
              toLocationId: move.toLocationId,
              status,
              reasonCode: move.reasonCode,
              // 只写 id 与状态，不带故事正文；160 字上限与 §2.1 一致
              summary: `移动载具 ${move.vehicleLocationId} ${status === "arrived" ? "已抵达" : status === "blocked" ? "暂不能出发" : "在路上"}`.slice(0, 160),
              visibility: "known",
              period: committed.receipt.currentTime,
            });
          }
          if (accepted.length < committed.vehicleMoves.length) {
            pushLog({
              at: now(),
              level: "warn",
              kind: "world-turn-simulation-event-limit",
              chatId: request.chatId,
              worldId: binding.worldId,
              reasonCode: "SIMULATION_EVENT_LIMIT",
              skipped: committed.vehicleMoves.length - accepted.length,
              scanned: simulationEvents.length,
            });
          }
          pushLog({
            at: now(),
            kind: "world-turn-vehicle-moves",
            chatId: request.chatId,
            worldId: binding.worldId,
            skipped: committed.vehicleMoves.filter((move) => move.status === "blocked").length,
            scanned: committed.vehicleMoves.length,
          });
        }
        if (committed.vehicleDiagnostics.length > 0) {
          pushLog({
            at: now(),
            kind: "world-turn-vehicle-blocked",
            chatId: request.chatId,
            worldId: binding.worldId,
            // blocked=true 表示这次调用**一个字段都没改**（车辆仍停在原处）
            skipped: committed.vehicleDiagnostics.filter((item) => item.blocked).length,
            scanned: committed.vehicleDiagnostics.length,
          });
        }
        /**
         * D04：回执 summary 改为**人类可读的后台摘要**——
         * F1 的症状正是「应用 5 行」反复刷屏却看不到任何人物动向。
         * 顺序固定：意图 → 在途 / 到位 → 消息发布 → 送达 → 待传播 → 时间。
         * 不重复写两次「表格增量：应用 N 行」；拒绝行数仍然如实报出。
         */
        {
          const simBranchNext = simulationEffect.next.branches[branchKey];
          const countOf = (status: AtlasSimulationEvent["status"]): number =>
            simulationEffect.events.filter((event) => event.status === status).length;
          const arrivedCount = committed.backgroundMoves.filter((move) => move.status === "moved").length;
          const enrouteCount = committed.backgroundMoves.filter((move) => move.status === "enroute").length;
          const blockedCount = committed.backgroundMoves.filter((move) => move.status === "blocked").length;
          const pendingSignals = simBranchNext.signals.filter((row) => row.status === "active").length;
          const parts = [
            countOf("intent-recorded") > 0 ? `${countOf("intent-recorded")} 位人物记下行动意图` : "",
            enrouteCount > 0 ? `${enrouteCount} 人在途` : "",
            arrivedCount > 0 ? `${arrivedCount} 人已到位` : "",
            countOf("published") > 0 ? `新消息 ${countOf("published")} 条` : "",
            countOf("delivered") > 0 ? `消息送达 ${countOf("delivered")} 处` : "",
            pendingSignals > 0 ? `${pendingSignals} 条消息待继续传播` : "",
            blockedCount > 0 ? `${blockedCount} 人暂不能行动` : "",
            periodsThisTurn > 0 ? `时间推进 ${periodsThisTurn} 段` : "等待时间推进",
            committed.rejected > 0 ? `拒绝 ${committed.rejected} 行（可修正提示词后重试）` : "",
          ].filter((part) => part.length > 0);
          committed.receipt.summary = (parts.join("；") || "本轮无后台变化").slice(0, 480);
          committed.receipt.simulationCounts = {
            tasks: simBranchNext.tasks.length,
            signals: simBranchNext.signals.length,
            deliveries: simBranchNext.deliveries.length,
            blocked: blockedCount,
          };
        }
        if (simulationEffect.eventsTruncated) {
          pushLog({
            at: now(),
            level: "warn",
            kind: "world-turn-simulation-event-limit",
            chatId: request.chatId,
            worldId: binding.worldId,
            reasonCode: "SIMULATION_EVENT_LIMIT",
            skipped: simulationEffect.droppedEventCount,
            scanned: simulationEffect.events.length,
          });
        }
        if (committed.rejected > 0) {
          pushLog({
            at: now(),
            kind: "world-turn-delta-partial",
            chatId: request.chatId,
            skipped: committed.rejected,
            scanned: committed.applied,
          });
          logRejectedDeltaRows(committed.rejectedRows, request.chatId, true);
        }
        output = { world: committed.world, receipt: committed.receipt };
        // E07：后台自主行动记具名诊断（人数口径；上限与"只更新行动"的条数都如实报出）
        pushLog({
          at: now(),
          kind: committed.background.kind,
          chatId: request.chatId,
          worldId: binding.worldId,
          scanned: committed.background.moves,
          skipped: committed.background.skipped,
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
      // 校验失败时保留 pending 供 retry。
      return okResult({ receipt });
    }

    // 6.5 ATLAS-13 回合边界 NPC 日程结算：只结算新鲜提交（duplicate 的位置已是
    //     确定性重算结果，重放只会重复注记）。结算读提交后的世界与时间——
    //     玩家先提交的事实即现实；NPC 移动只写 NPC 自己的 CharacterState；
    //     同段同地遭遇进 triggeredNpcIds + 〔日程〕注记（可审计）。
    let settledWorld = output.world;
    if (receipt.status === "committed" && !settledInTablePath) {
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

    /**
     * S7（0.9.55）：按**最终世界**的 parentPointId 与 createdPointIds 报告子图增量。
     *
     * 0.9.59 修正：这一段过去被裹在 `!settledInTablePath` 的日程结算分支里，于是
     * **只在旧的非行增量路径**才会写日志——现行唯一执行链（table-delta）上永远不写，
     * 等于把「子图增量不静默」的纪律悄悄丢了。它只读已经算好的 `settledWorld` / `world`，
     * 与日程结算没有依赖关系，因此提到条件之外。
     * 只在真正 committed 时记（duplicate / failed 不报告创建成功）；
     * 只记数量、父子 ID 与最大层级，绝不记故事原文或地点名以外的自由文本。
     */
    if (receipt.status === "committed") {
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
  }

    // 7. 成功：原子保存新世界 + 更新绑定游标 + 清理 pending + 缓存回执
    await store.write(`world:${binding.worldId}`, settledWorld);
    // C05：三表与镜像世界**同一次会话响应**写回（覆盖层保证二者落在同一个 session 对象里）
    if (nextTablesDoc !== null) {
      await store.write(`tables:${binding.worldId}`, nextTablesDoc);
    }
    // C09：推演模块与三表同一份候选会话写回——任一校验/写入失败整轮不发布，不出现半截新态。
    if (nextSimulationDoc !== null) {
      await store.write(`simulation:${binding.worldId}`, nextSimulationDoc);
    }
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
      /**
       * E05：回退用的三表基线（`{branchKey, tables}`）。缺这个字段的回合映射
       * （table-delta 之前的旧回合）由 handleRollback 从**回退后的**可见世界重建，
       * 不借用另一分支、也不凭空造空世界。
       */
      tablesBefore: tablesBeforeTurn,
      /**
       * C09 / C10：本轮的推演事件与**逐行**逆操作。
       * 旧回合没有这两个字段时视为空，不凭空迁移其他分支；回退按行恢复而不复制整模块。
       */
      simulationEvents,
      simulationUndo,
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
    /**
     * H18c：本轮**确实新建**了城市 / 建筑子图（宿主地点本轮新建、parent / mapId 已确定）→
     * **逐张**调用 H18a 建立尺度状态，最多 2 张 / 轮。
     *
     * 纪律：
     * - 位置在回合文本提交**之后**：世界 / 三表 / 推演都已经写回，标定失败绝不回滚它们；
     * - 给**既有**地点添房间只扩充已有子图，不在这里发标定请求（`extendedCount` 记日志，
     *   由作者打开地图时手动触发），普通回合因此仍然只花 1 条模型请求；
     * - 超过 2 张的新图只记 `map-scale-queue-pending`（带数量），绝不静默少标；
     * - 已有有效标定（含人工锁定）时 H18a 零模型请求直接复用；
     * - 任何失败只记 `world-scale-pending`，不影响本轮回合与回执。
     */
    if (receipt.status === "committed" && nextTablesDoc !== null && tablesBeforeTurn !== null) {
      const scaleBranchKey = tablesBeforeTurn.branchKey;
      const committedBranch = nextTablesDoc.branches?.[scaleBranchKey];
      if (committedBranch) {
        const hosts = atlasNewSubmapHosts({
          priorLocationIds: new Set(tablesBeforeTurn.tables.locations.map((row) => row.id)),
          locations: committedBranch.locations,
          max: 2,
        });
        for (const mapId of hosts.mapIds) {
          const hostRow = committedBranch.locations.find((row) => row.id === locationRowId(mapId));
          try {
            await ensureMapScaleOnCreate({
              chatId: binding.chatId,
              branchKey: scaleBranchKey,
              mapId,
              revision: SUBMAP_FRAME_DEFAULT.frameRevision,
              frame: { ...SUBMAP_FRAME_DEFAULT },
              ...(hostRow && hostRow.description ? { description: hostRow.description } : {}),
            });
          } catch (thrown) {
            pushLog({
              at: now(),
              level: "warn",
              kind: "world-scale-pending",
              chatId: request.chatId,
              worldId: binding.worldId,
              mapId,
              reasonCode: thrown instanceof AtlasError ? thrown.code : "INTERNAL",
            });
          }
        }
        if (hosts.queued > 0 || hosts.extendedCount > 0) {
          // 未自动标定的新图（超 2 张）与被扩充的既有子图都留痕：作者打开地图时手动触发
          pushLog({
            at: now(),
            kind: "map-scale-queue-pending",
            worldId: binding.worldId,
            skipped: hosts.queued + hosts.extendedCount,
            scanned: hosts.mapIds.length,
          });
        }
      }
    }
    // 8. 世界书条目规划（纯派生，零 IO；写入由 UI 扩展经酒馆 world-info API 完成）。
    //    duplicate / failed 不产出规划：duplicate 本就写过了，failed 零部分写入。
    //    E08：行增量回合把该分支的三表上下文（位置链 / 身边人物的想法与行动倾向 / 地面物品）
    //    一并注入条目——**只读本分支快照**（分支隔离），条数有界，绝不把三表整库写进世界书。
    const lorebookTableDelta = (() => {
      if (nextTablesDoc === null || tablesBeforeTurn === null) return null;
      const branch = nextTablesDoc.branches?.[tablesBeforeTurn.branchKey];
      if (!branch) return null;
      return {
        tables: branch,
        branchKey: tablesBeforeTurn.branchKey,
        currentLocationId: receipt.currentLocationId ?? null,
      };
    })();
    /**
     * D09：把本分支的推演事件与送达记录交给世界书规划——「近期动向」优先取它们，
     * 旧 `world.stateEvents` 只在没有推演事件时兜底。可见性规则在 buildLorebookPlans 里：
     * hidden 与尚未送达的消息不透出到主聊天注入。
     */
    const lorebookSimulationDelta = (() => {
      if (nextSimulationDoc === null) return null;
      const branchKey = tablesBeforeTurn?.branchKey
        ?? (branchScopeForStory(output.world, binding.branchId) ?? "canon");
      const branch = nextSimulationDoc.branches[branchKey];
      if (!branch) return null;
      const playerRowId = binding.characterId ? characterRowId(String(binding.characterId)) : null;
      const playerLocationId = playerRowId === null
        ? null
        : (nextTablesDoc?.branches?.[branchKey]?.characters.find((row) => row.id === playerRowId)?.locationId ?? null);
      return {
        branchKey,
        events: simulationEvents,
        deliveries: branch.deliveries,
        protagonistLocationIds: playerLocationId === null ? [] : [playerLocationId],
        authorOmniscient: false,
      };
    })();
    const lorebook = buildLorebookPlans(output.world, receipt, lorebookTableDelta, lorebookSimulationDelta);

    // 子地图由三表 parentLocationId 投影；比例尺由建图标定接口管理。

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
              binding,
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
    /**
     * E05（第一半）：三表必须跟着世界一起回退。
     * 在此之前这里只回退 world + binding：世界回到了回合前，三表却还带着「未来」的
     * 地点 / 人物 / 物品，于是地图、附近、地点面板与正文错位——正是计划 §5 停机线
     * 「回退后地图不一致」的那一条。
     * 1) 优先用回合映射里的 `tablesBefore` 快照（table-delta 提交时冻结的回合前状态）：瞬时、精确；
     * 2) 老回合没有快照 → 用**回退后的**世界重建一次（A08 同口径），不借用其他分支、不造空世界。
     * 重建失败时世界回退**照常生效**（数据不多不少地退回去了），但明确报错并留痕——
     * 绝不静默留下「世界回去了、三表还在未来」的半状态。
     */
    const branchKey = branchScopeForStory(world, binding.branchId) ?? "canon";
    const snapshotRaw = (target.doc as { tablesBefore?: unknown }).tablesBefore;
    let rolledTables: AtlasThreeTablesV1 | null = null;
    let rollbackReason = "";
    if (
      isPlainRecord(snapshotRaw)
      && typeof snapshotRaw.branchKey === "string"
      && snapshotRaw.branchKey === branchKey
      && isPlainRecord(snapshotRaw.tables)
      && validateAtlasTables(snapshotRaw.tables as unknown as AtlasThreeTablesV1).ok
    ) {
      rolledTables = snapshotRaw.tables as unknown as AtlasThreeTablesV1;
      rollbackReason = "TABLES_ROLLED_BACK";
    } else {
      const rebuilt = await rebuildBranchTablesFromWorld({
        store, binding, world: restored.value, branchKey,
      });
      if (rebuilt.ok) {
        rolledTables = rebuilt.tables;
        rollbackReason = "TABLES_REBUILT_FROM_WORLD";
      } else {
        pushLog({
          at: now(),
          kind: "world-turn-table-rollback",
          chatId,
          worldId: binding.worldId,
          reasonCode: `TABLES_ROLLBACK_REBUILD_FAILED:${rebuilt.reasonCode}`,
          coreCommitted: false,
        });
        throw new AtlasError(
          ATLAS_ERROR_CODES.SESSION_STALE,
          `世界已回退，但三表无法还原（${rebuilt.reasonCode}）。本轮回退未完成：请重新打开该聊天后再试，或到变化页查看迁移错误。`,
          { retryable: true },
        );
      }
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
    /**
     * E05：三表随世界一起落盘到该分支（其他分支的快照原样保留）。
     * 写入位置在 world / binding 之后：任一步失败都是明确异常，不返回"回退成功"。
     */
    const tablesDocRaw = await store.read(`tables:${binding.worldId}`).catch(() => null);
    const priorDoc = isPlainRecord(tablesDocRaw) ? (tablesDocRaw as unknown as AtlasTablesStoreV1) : null;
    // 只在该分支本来就有三表时写回：没有三表的旧聊天不该因为一次回退凭空长出三表。
    // 有快照却读不到文档（会话损坏）也写：让三表回到回退后的真值，而不是继续停在"未来"。
    if (isPlainRecord(priorDoc?.branches?.[branchKey]) || snapshotRaw !== undefined) {
      await store.write(`tables:${binding.worldId}`, {
        schemaVersion: 1,
        worldId: binding.worldId,
        branches: { ...(priorDoc?.branches ?? {}), [branchKey]: rolledTables },
      });
      pushLog({
        at: now(),
        kind: "world-turn-table-rollback",
        chatId: binding.chatId,
        worldId: binding.worldId,
        reasonCode: rollbackReason,
        // 该分支回退后的行数（不记任何自由文本 / 地点名）
        scanned: rolledTables.locations.length + rolledTables.characters.length + rolledTables.items.length,
      });
    }
    /**
     * C10：推演模块必须跟世界 / 三表一起回退。
     *
     * 语义：读回合映射里的 `simulationUndo`（**逐行**逆操作），逆序恢复 tasks / signals /
     * deliveries 与 geoTopology 的三个集合；本轮归档的 `simulationEvents` 随 `rolledBack`
     * 标记一起从可见视图消失（文档保留 = 可审计）。
     * 旧回合没有 `simulationUndo` 字段时视为空：**只**恢复世界与三表，不凭空造幕后事件。
     */
    const simulationUndoRaw = (target.doc as { simulationUndo?: unknown }).simulationUndo;
    if (Array.isArray(simulationUndoRaw) && simulationUndoRaw.length > 0) {
      const simRaw = await store.read(`simulation:${binding.worldId}`).catch(() => null);
      if (isPlainRecord(simRaw)) {
        const simulationDoc = simRaw as unknown as AtlasSimulationStore;
        const simBranch = isPlainRecord(simulationDoc.branches)
          ? (simulationDoc.branches as unknown as Record<string, Record<string, unknown>>)[branchKey]
          : undefined;
        if (isPlainRecord(simBranch)) {
          const collections: Record<string, unknown> = {
            tasks: simBranch.tasks,
            signals: simBranch.signals,
            deliveries: simBranch.deliveries,
          };
          const topology = isPlainRecord(simBranch.geoTopology)
            ? (simBranch.geoTopology as Record<string, unknown>) : null;
          let restoredRows = 0;
          // 逆序回放：同一 id 的多条记录按"后进先出"才能还原到回合前
          for (const rawEntry of [...simulationUndoRaw].reverse()) {
            if (!isPlainRecord(rawEntry)) continue;
            const id = rawEntry.id;
            if (typeof id !== "string") continue;
            const list = typeof rawEntry.collection === "string"
              ? collections[rawEntry.collection]
                ?? (topology ? topology[rawEntry.collection] : undefined)
              : undefined;
            if (!Array.isArray(list)) continue;
            const index = list.findIndex((row) => isPlainRecord(row) && row.id === id);
            const before = rawEntry.before;
            if (before === null || before === undefined) {
              if (index >= 0) { list.splice(index, 1); restoredRows += 1; }
            } else if (isPlainRecord(before)) {
              if (index >= 0) list[index] = before;
              else list.push(before);
              restoredRows += 1;
            }
          }
          if (restoredRows > 0) {
            // 回退后必须仍是合法模块：不合法就明确失败，不写半截状态
            const check = validateSimulationStore(simulationDoc, {
              expectedWorldId: binding.worldId,
              tablesByBranch: simulationTablesByBranch(priorDoc),
            });
            if (!check.ok) {
              pushLog({
                at: now(),
                level: "warn",
                kind: "world-turn-simulation-rollback",
                chatId: binding.chatId,
                worldId: binding.worldId,
                reasonCode: `SIMULATION_ROLLBACK_INVALID:${check.errors[0]!.code}`,
                coreCommitted: false,
              });
              throw new AtlasError(
                ATLAS_ERROR_CODES.SESSION_STALE,
                `世界与三表已回退，但推演模块还原后未通过校验（${check.errors[0]!.code} @ ${check.errors[0]!.path}）。`
                  + "请重新打开该聊天后再试；原始存档未被覆盖。",
                { retryable: true },
              );
            }
            await store.write(`simulation:${binding.worldId}`, simulationDoc);
            pushLog({
              at: now(),
              kind: "world-turn-simulation-rollback",
              chatId: binding.chatId,
              worldId: binding.worldId,
              reasonCode: "SIMULATION_ROLLED_BACK",
              scanned: restoredRows,
            });
          }
        }
      }
    }
    // 标记该回合已回退（文档保留 = 可审计的历史）；清幂等缓存让同变体之后的重提交能重新推进
    await store.write(target.key, { ...target.doc, rolledBack: true, rolledBackAt: now() });
    const oldKey = typeof target.doc.idempotencyKey === "string" ? target.doc.idempotencyKey : null;
    if (oldKey) receiptCache.delete(oldKey);
    return okResult({
      rolledBack: { assistantMessageId, checkpointId },
      restored: restored.restored ?? null,
      tables: rolledTables === null ? null : { branchKey, reasonCode: rollbackReason },
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
  /**
   * H07a（0.9.59）：作者**手动确认**地点归属 / 邻接 / 载具 / 坐标。
   *
   * 这是人工写入 `geoTopology` 与坐标确认状态的唯一入口：
   * - 分支身份从服务端绑定派生，绝不接受客户端自报分支（A chatId 写不进 B）；
   * - `parent` 链最大 4 层且无环；载具的停靠点必须真实存在；
   * - 成功 = **一次候选提交**（tables + simulation + maps 同一份会话），
   *   失败只报字段路径，绝不改任何一表；
   * - `set-parent` 的 `targetLocationId = null` 表示解除包含。
   */
  /**
   * H18a（0.9.59）：**建图时**的单一尺度标定入口。
   *
   * 纪律（§2.5 / H18a）：
   * 1. 已有有效标定（含人工锁定）→ **零模型请求**，直接返回 `existing`；
   * 2. 同（世界, 分支, 图, revision）并发调用合并成**同一个 pending Promise**——
   *    连续两轮建图不会发两次请求；
   * 3. `await` 之后**复核身份**：绑定世界变了就放弃写回，
   *    绝不把 A 聊天的标定写进 B（A 的迟到响应不得污染 B）；
   * 4. 缺 API、模型 `unknown` / `conflict`、解析失败、frame 对不上 →
   *    `scale-pending`：**地图照常保留**并标记待定，绝不猜一个米数（T25 / T29）。
   */
  const mapScaleInFlight = new Map<string, Promise<AtlasMapScaleEnsureResult>>();

  async function ensureMapScaleOnCreate(input: {
    chatId: string;
    branchKey: string;
    mapId: string;
    revision: string | number;
    frame: FrameRef;
    description?: string;
    loreEvidence?: string;
  }): Promise<AtlasMapScaleEnsureResult> {
    const binding = requireBoundBinding(await getBinding(input.chatId));
    const world = await requireWorld(binding);
    const branchKey = input.branchKey.length > 0
      ? input.branchKey
      : (branchScopeForStory(world, binding.branchId) ?? "canon");
    const flightKey = [world.id, branchKey, input.mapId, String(input.revision)].join("|");
    const running = mapScaleInFlight.get(flightKey);
    if (running) return running;

    const task = (async (): Promise<AtlasMapScaleEnsureResult> => {
      const docKey = `maps:${world.id}`;
      const calibrationKey = scaleCalibrationKey(branchKey, input.mapId);
      const doc = sanitizeMapDoc(await store.read(docKey).catch(() => null));
      const existing = doc.calibrations[calibrationKey] ?? null;
      // ① 已有有效标定（人工锁定也算）→ 零模型请求
      if (existing) return { status: "existing", calibration: existing };

      const current = await loadSettings();
      const preset = resolveWorldTurnPreset(current);
      if (!preset) return { status: "scale-pending", reasonCode: "API_NOT_CONFIGURED" };

      const contractRule =
        '只输出一个完整 JSON 对象：{"mapRef":"给定 mapId","frameRevision":给定 frameRevision,'
        + '"status":"estimated|grounded|unknown|conflict","extentMeters":{"width":<正数米>,"height":<正数米>}或null,'
        + '"coverage":"...","basis":"...","confidence":"low|medium|high","evidence":[{"sourceId":"来源ID","quote":"原文片段"}]}';
      const userContent = [
        `判断地图 ${input.mapId} 的实际地理范围（尺度标定）。`,
        contractRule,
        `frameRevision=${input.frame.frameRevision}，cols=${input.frame.cols}，rows=${input.frame.rows}，coordinateMode=等距方格。`,
        "屏幕像素、缩放倍率、地点数量及随机排版都不是物理尺度证据；有整图明确尺度才用 grounded，"
          + "仅语义范围用 estimated，材料不足用 unknown，证据矛盾用 conflict。unknown / conflict 的 extentMeters 必须为 null。",
        ...(input.description ? [`地图描述：${input.description.slice(0, 300)}`] : []),
        ...(input.loreEvidence
          ? ["【世界书摘录（可能包含明确距离 / 尺寸证据）】", input.loreEvidence.slice(0, ATLAS_LIMITS.LORE_SUPPLEMENT_CHARS)]
          : []),
      ].join("\n");
      checkRpm();
      rpmTimestamps.push(now());
      const call = await callAtlasWorldTurnApi(
        {
          ...preset,
          promptSegments: [
            { role: "system", content: "你是 Atlas 地图范围估计器。只根据有来源的地图语义、地点描述与明确距离判断整图物理范围。只输出一个完整 JSON 对象，不输出其它文字、解释或代码围栏。" },
            { role: "user", content: userContent },
          ],
        },
        { injectionText: "", userText: "", assistantText: "" },
        { fetchFn: deps.fetchFn, now },
      );
      if (!call.ok) return { status: "scale-pending", reasonCode: call.code };

      /**
       * ② 身份复核：`await` 期间作者可能切了聊天，或地图 revision 变了。
       * 任一不符就放弃写回——结果只属于发起它的那次建图。
       */
      const afterBinding = await getBinding(input.chatId).catch(() => null);
      if (!afterBinding || String(afterBinding.worldId ?? "") !== world.id) {
        return { status: "scale-pending", reasonCode: "IDENTITY_CHANGED" };
      }
      const spec = extractJsonObject(call.text);
      if (!spec) return { status: "scale-pending", reasonCode: "UNPARSEABLE" };
      if ((spec.mapRef !== undefined && spec.mapRef !== input.mapId) ||
          (spec.frameRevision !== undefined && spec.frameRevision !== input.frame.frameRevision)) {
        return { status: "scale-pending", reasonCode: "FRAME_MISMATCH" };
      }
      const validation = validateScaleResponse(spec, { cols: input.frame.cols, rows: input.frame.rows });
      if (!validation.ok) {
        return { status: "scale-pending", reasonCode: String(validation.status || "unknown").toUpperCase() };
      }
      // ③ 重新读一次文档再写：不覆盖 await 期间别人写进去的东西
      const rawNext = await store.read(docKey).catch(() => null);
      /**
       * H06a：写回前先算「清洗会截掉多少」。`sanitizeMapDoc` 有刻意的条目上限
       * （pointMeta 120 / submaps 60 / calibrations 80 / 每图 60 点），超限时**必须留痕**，
       * 不能静默把作者已保存的条目删掉。日志只带数量，不带地点名或正文。
       */
      const overCap = mapDocOverCapLosses(rawNext);
      const overCapTotal = overCap.pointMeta + overCap.submaps + overCap.calibrations + overCap.submapPoints;
      if (overCapTotal > 0) {
        pushLog({
          at: now(),
          level: "warn",
          kind: "map-doc-over-cap-truncated",
          worldId: world.id,
          mapId: input.mapId,
          skipped: overCapTotal,
          scanned: overCap.calibrations,
        });
      }
      const next = sanitizeMapDoc(rawNext);
      const calibration: MapScaleCalibration = {
        revision: (next.calibrations[calibrationKey]?.revision ?? 0) + 1,
        ...validation.calibration,
        at: now(),
      };
      next.calibrations[calibrationKey] = calibration;
      await store.write(docKey, next);
      pushLog({
        at: now(),
        kind: "world-scale-calibrate",
        worldId: world.id,
        mapId: input.mapId,
        source: "ai-estimated",
        metersPerCell: calibration.metersPerCell,
      });
      return { status: "calibrated", calibration };
    })();

    mapScaleInFlight.set(flightKey, task);
    try {
      return await task;
    } finally {
      mapScaleInFlight.delete(flightKey);
    }
  }

  async function handleTopologyConfirm(body: unknown): Promise<AtlasRouteResult> {
    if (!isPlainRecord(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "topology/confirm 请求必须是对象");
    }
    const record = body as Record<string, unknown>;
    const chatId = typeof record.chatId === "string" ? record.chatId.trim() : "";
    if (!chatId || chatId.length > ATLAS_LIMITS.ID_CHARS) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "chatId 非法（$.chatId）");
    }
    const operation = typeof record.operation === "string" ? record.operation : "";
    if (operation !== "set-parent" && operation !== "set-adjacent"
      && operation !== "set-vehicle" && operation !== "confirm-coordinate") {
      throw new AtlasError(
        ATLAS_ERROR_CODES.INVALID_PAYLOAD,
        "operation 只能是 set-parent / set-adjacent / set-vehicle / confirm-coordinate（$.operation）。",
      );
    }
    const binding = requireBoundBinding(await getBinding(chatId));
    const world = await requireWorld(binding);
    // 分支从绑定推，不信客户端
    const branchKey = branchScopeForStory(world, binding.branchId) ?? "canon";
    const locationId = typeof record.locationId === "string" ? record.locationId.trim() : "";
    if (!locationId) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "locationId 必填（$.locationId）。");
    }
    const targetRaw = record.targetLocationId;
    const targetLocationId = typeof targetRaw === "string" && targetRaw.trim().length > 0
      ? targetRaw.trim() : null;

    const tablesRaw = await store.read(`tables:${binding.worldId}`).catch(() => null);
    const tablesDoc = isPlainRecord(tablesRaw) ? (tablesRaw as unknown as AtlasTablesStoreV1) : null;
    const branchTables = tablesDoc?.branches?.[branchKey];
    if (!tablesDoc || !branchTables) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "本分支还没有三表快照，无法确认地理关系。");
    }
    // 只在**副本**上改：任何一步失败都不落盘、不污染会话
    const nextTables = cloneAtlasTables(branchTables);
    const locationRow = nextTables.locations.find((row) => row.id === locationId);
    if (!locationRow) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `地点不存在：${locationId}（$.locationId）。`);
    }
    const pointId = pointIdFromLocationRowId(locationId);
    if (pointId === null) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `地点 id 不是 loc:* 正式 id：${locationId}（$.locationId）。`);
    }

    const simulationRaw = await store.read(`simulation:${binding.worldId}`).catch(() => null);
    let simulationDoc: AtlasSimulationStore;
    if (simulationRaw === null || simulationRaw === undefined) {
      simulationDoc = createEmptySimulation(binding.worldId);
    } else {
      const check = validateSimulationStore(simulationRaw, {
        expectedWorldId: binding.worldId,
        tablesByBranch: simulationTablesByBranch(tablesDoc),
      });
      if (!check.ok) {
        throw new AtlasError(
          ATLAS_ERROR_CODES.SESSION_STALE,
          `推演模块未通过校验（${check.errors[0]!.code} @ ${check.errors[0]!.path}）：原始数据已保留，本次未做任何写入。`,
        );
      }
      // 深拷贝：下面的改动绝不能漏进会话原文
      simulationDoc = cloneSimulationStore(simulationRaw as AtlasSimulationStore);
    }
    const branchSimulation = simulationDoc.branches[branchKey]
      ?? { tasks: [], signals: [], deliveries: [], geoTopology: { edges: [], areas: [], vehicles: [] } };
    simulationDoc.branches[branchKey] = branchSimulation;
    const topology = branchSimulation.geoTopology;
    let nextMapsDoc: AtlasMapDoc | null = null;

    if (operation === "set-parent") {
      if (targetLocationId !== null) {
        if (targetLocationId === locationId) {
          throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "地点不能以自己为上级（$.targetLocationId）。");
        }
        if (!nextTables.locations.some((row) => row.id === targetLocationId)) {
          throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `上级地点不存在：${targetLocationId}（$.targetLocationId）。`);
        }
        // 环 + 深度：从新上级往上走，不能回到自己，且总层数 ≤ 4
        const seen = new Set<string>([locationId]);
        let cursor: string | null = targetLocationId;
        let depth = 1;
        while (cursor !== null) {
          if (seen.has(cursor)) {
            throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `上级链成环：${cursor}（$.targetLocationId）。`);
          }
          seen.add(cursor);
          if (depth > 4) {
            throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "上级链超过 4 层（$.targetLocationId）。");
          }
          cursor = nextTables.locations.find((row) => row.id === cursor)?.parentLocationId ?? null;
          depth += 1;
        }
      }
      const previousMapId = locationRow.mapId;
      locationRow.parentLocationId = targetLocationId;
      /**
       * 子地点住在**父地点的子图**里——三表 schema 要求 `mapId` 等于 `parentLocationId`
       * （根地点恒为 "world"）。不改这一项会被 `MAP_ID_MISMATCH` 挡下。
       */
      locationRow.mapId = targetLocationId === null ? "world" : targetLocationId;
      if (locationRow.mapId !== previousMapId) {
        // 换了图，旧图上的格号不再有意义：清空而不是沿用（绝不把 A 图的坐标搬到 B 图）
        locationRow.gridX = null;
        locationRow.gridY = null;
      }
    } else if (operation === "set-adjacent") {
      if (targetLocationId === null) {
        throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "set-adjacent 需要 targetLocationId（$.targetLocationId）。");
      }
      if (!nextTables.locations.some((row) => row.id === targetLocationId)) {
        throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `邻接地点不存在：${targetLocationId}（$.targetLocationId）。`);
      }
      // 边 id 由分支 + 两端 + 关系类型稳定生成；(A,B) 与 (B,A) 是同一 id → 天然去重
      const edgeId = geoEdgeId(branchKey, locationId, targetLocationId, "adjacent");
      if (!topology.edges.some((row) => row.id === edgeId)) {
        topology.edges.push({
          id: edgeId,
          fromLocationId: locationId, toLocationId: targetLocationId,
          kind: "adjacent", evidence: "manual", channel: "walk",
        });
      }
    } else if (operation === "set-vehicle") {
      if (targetLocationId !== null && !nextTables.locations.some((row) => row.id === targetLocationId)) {
        throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `停靠地点不存在：${targetLocationId}（$.targetLocationId）。`);
      }
      const anchor: AtlasVehicleAnchor = {
        // §2.1：载具锚点 id 恒等于其地点行 id，便于精确覆写与 undo 查找
        id: locationId,
        locationId,
        atLocationId: targetLocationId,
        routeEdgeId: null,
        status: targetLocationId === null ? "unknown" : "stopped",
        evidence: "manual",
      };
      const index = topology.vehicles.findIndex((row) => row.id === locationId);
      if (index >= 0) topology.vehicles[index] = anchor;
      else topology.vehicles.push(anchor);
    } else {
      // confirm-coordinate：同时写三表格坐标与 maps.pointMeta 的确认状态（H06a）
      const gridX = typeof record.gridX === "number" && Number.isFinite(record.gridX) ? Math.floor(record.gridX) : null;
      const gridY = typeof record.gridY === "number" && Number.isFinite(record.gridY) ? Math.floor(record.gridY) : null;
      if (gridX === null || gridY === null || gridX < 0 || gridY < 0) {
        throw new AtlasError(
          ATLAS_ERROR_CODES.INVALID_PAYLOAD,
          "confirm-coordinate 需要非负整数 gridX / gridY（$.gridX / $.gridY）。",
        );
      }
      const mapId = typeof record.mapId === "string" && record.mapId.trim().length > 0
        ? record.mapId.trim() : "world";
      locationRow.mapId = mapId;
      locationRow.gridX = gridX;
      locationRow.gridY = gridY;
      const mapsRaw = await store.read(`maps:${binding.worldId}`).catch(() => null);
      const mapsDoc = sanitizeMapDoc(mapsRaw);
      mapsDoc.pointMeta[String(pointId)] = {
        ...(mapsDoc.pointMeta[String(pointId)] ?? {}),
        coordinateStatus: "confirmed",
      };
      nextMapsDoc = mapsDoc;
    }

    // 候选校验：三表 + 拓扑都必须过，否则一个字段都不写
    const tablesValidation = validateAtlasTables(nextTables);
    if (!tablesValidation.ok) {
      const first = tablesValidation.errors[0]!;
      throw new AtlasError(
        ATLAS_ERROR_CODES.INVALID_PAYLOAD,
        `候选三表未通过校验（${first.code} @ ${first.path}）：本次未做任何写入。`,
      );
    }
    const topologyValidation = validateGeoTopology(topology, {
      branchKey,
      locations: nextTables.locations,
      characters: nextTables.characters,
    });
    if (!topologyValidation.ok) {
      const first = topologyValidation.errors[0]!;
      throw new AtlasError(
        ATLAS_ERROR_CODES.INVALID_PAYLOAD,
        `候选地理拓扑未通过校验（${first.code} @ ${first.path}）：本次未做任何写入。`,
      );
    }

    const nextTablesDoc: AtlasTablesStoreV1 = {
      schemaVersion: 1,
      worldId: binding.worldId,
      branches: { ...(tablesDoc.branches ?? {}), [branchKey]: nextTables },
    };
    await store.write(`tables:${binding.worldId}`, nextTablesDoc);
    await store.write(`simulation:${binding.worldId}`, simulationDoc);
    if (nextMapsDoc !== null) await store.write(`maps:${binding.worldId}`, nextMapsDoc);
    pushLog({
      at: now(),
      kind: "map-topology-confirm",
      chatId: binding.chatId,
      worldId: binding.worldId,
      reasonCode: operation.toUpperCase().replace(/-/g, "_"),
    });
    return okResult({ status: "saved", branchKey, operation, locationId });
  }

  /**
   * H15a（0.9.59）：作者手动涂色范围（`POST /maps/areas/upsert`）。
   *
   * - 分支身份从服务端绑定派生；`areaId = branchKey|mapId|locationId`，同一 id 更新取代上次范围；
   * - 只写 `evidence: "manual"`：本端点**绝不**随正文自动创造范围；
   * - `cells: []` 表示删除**用户自己涂的那一块**（worldbook / story 的范围不动）；
   * - 格数 ≤256、坐标必须是非负整数且落在该图 frame 内，单分支 area ≤64；
   * - 与 simulation 同一次候选提交；会话 rev 过时由外层返回 409 并保留旧图。
   */
  async function handleAreasUpsert(body: unknown): Promise<AtlasRouteResult> {
    if (!isPlainRecord(body)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "maps/areas/upsert 请求必须是对象");
    }
    const record = body as Record<string, unknown>;
    const chatId = typeof record.chatId === "string" ? record.chatId.trim() : "";
    if (!chatId || chatId.length > ATLAS_LIMITS.ID_CHARS) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "chatId 非法（$.chatId）");
    }
    const binding = requireBoundBinding(await getBinding(chatId));
    const world = await requireWorld(binding);
    const branchKey = branchScopeForStory(world, binding.branchId) ?? "canon";
    const mapId = typeof record.mapId === "string" && record.mapId.trim().length > 0 ? record.mapId.trim() : "";
    if (!mapId) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "mapId 必填（$.mapId）。");
    }
    const locationId = typeof record.locationId === "string" ? record.locationId.trim() : "";
    if (!locationId) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "locationId 必填（$.locationId）。");
    }
    if (!Array.isArray(record.cells)) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "cells 必须是数组（$.cells）；空数组表示删除该块。");
    }

    const tablesRaw = await store.read(`tables:${binding.worldId}`).catch(() => null);
    const tablesDoc = isPlainRecord(tablesRaw) ? (tablesRaw as unknown as AtlasTablesStoreV1) : null;
    const branchTables = tablesDoc?.branches?.[branchKey];
    if (!tablesDoc || !branchTables) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "本分支还没有三表快照，无法保存范围。");
    }
    const locationRow = branchTables.locations.find((row) => row.id === locationId);
    if (!locationRow) {
      throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `地点不存在：${locationId}（$.locationId）。`);
    }
    // 地点必须真的住在请求的那张图上（房间不能被涂到世界图上）
    const rowMapKey = locationRow.mapId === null
      ? null
      : (locationRow.mapId === "world"
          ? "world"
          : String(pointIdFromLocationRowId(locationRow.mapId) ?? locationRow.mapId));
    if (rowMapKey !== mapId) {
      throw new AtlasError(
        ATLAS_ERROR_CODES.INVALID_PAYLOAD,
        `地点 ${locationId} 不在图 ${mapId} 上（它属于 ${rowMapKey ?? "未知图"}）（$.mapId）。`,
      );
    }

    const mapsRaw = await store.read(`maps:${binding.worldId}`).catch(() => null);
    const mapsDoc = sanitizeMapDoc(mapsRaw);
    // frame：子图读它自己的；世界图按已确认坐标点的包围盒（至少默认 100×100）
    let frame: { cols: number; rows: number };
    if (mapId === "world") {
      let maxX = 0;
      let maxY = 0;
      for (const row of branchTables.locations) {
        if (row.mapId !== "world") continue;
        if (typeof row.gridX === "number" && Number.isFinite(row.gridX) && row.gridX > maxX) maxX = row.gridX;
        if (typeof row.gridY === "number" && Number.isFinite(row.gridY) && row.gridY > maxY) maxY = row.gridY;
      }
      frame = {
        cols: Math.max(SUBMAP_FRAME_DEFAULT.cols, Math.ceil(maxX) + 1),
        rows: Math.max(SUBMAP_FRAME_DEFAULT.rows, Math.ceil(maxY) + 1),
      };
    } else {
      const subFrame = mapsDoc.submaps[mapId]?.frame;
      frame = subFrame ? { cols: subFrame.cols, rows: subFrame.rows } : { ...SUBMAP_FRAME_DEFAULT };
    }

    // 归一化格集合：整数、非负、去重、在 frame 内、≤256
    const seenCells = new Set<string>();
    const cells: Array<{ x: number; y: number }> = [];
    for (const raw of record.cells) {
      if (!isPlainRecord(raw)) {
        throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "cells 里每一项必须是 {x,y}（$.cells）。");
      }
      const x = typeof raw.x === "number" && Number.isFinite(raw.x) ? Math.floor(raw.x) : null;
      const y = typeof raw.y === "number" && Number.isFinite(raw.y) ? Math.floor(raw.y) : null;
      if (x === null || y === null) {
        throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, "格子坐标必须是有限数值（$.cells）。");
      }
      if (x < 0 || y < 0 || x >= frame.cols || y >= frame.rows) {
        throw new AtlasError(
          ATLAS_ERROR_CODES.INVALID_PAYLOAD,
          `格子 (${x},${y}) 超出图 ${mapId} 的 frame（${frame.cols}×${frame.rows}）（$.cells）。`,
        );
      }
      const key = `${x}|${y}`;
      if (seenCells.has(key)) continue;
      seenCells.add(key);
      cells.push({ x, y });
      if (cells.length > ATLAS_GEO_LIMITS.areaCells) {
        throw new AtlasError(
          ATLAS_ERROR_CODES.INVALID_PAYLOAD,
          `单个范围最多 ${ATLAS_GEO_LIMITS.areaCells} 格（$.cells）。`,
        );
      }
    }

    const simulationRaw = await store.read(`simulation:${binding.worldId}`).catch(() => null);
    let simulationDoc: AtlasSimulationStore;
    if (simulationRaw === null || simulationRaw === undefined) {
      simulationDoc = createEmptySimulation(binding.worldId);
    } else {
      const check = validateSimulationStore(simulationRaw, {
        expectedWorldId: binding.worldId,
        tablesByBranch: simulationTablesByBranch(tablesDoc),
      });
      if (!check.ok) {
        throw new AtlasError(
          ATLAS_ERROR_CODES.SESSION_STALE,
          `推演模块未通过校验（${check.errors[0]!.code} @ ${check.errors[0]!.path}）：原始数据已保留，本次未做任何写入。`,
        );
      }
      simulationDoc = cloneSimulationStore(simulationRaw as AtlasSimulationStore);
    }
    const branchSimulation = simulationDoc.branches[branchKey]
      ?? { tasks: [], signals: [], deliveries: [], geoTopology: { edges: [], areas: [], vehicles: [] } };
    simulationDoc.branches[branchKey] = branchSimulation;
    const topology = branchSimulation.geoTopology;
    const areaId = geoAreaId(branchKey, mapId, locationId);
    const existingIndex = topology.areas.findIndex((row) => row.id === areaId);

    if (cells.length === 0) {
      // 删除：只删**人工**范围，绝不碰 worldbook / story 推出来的边界
      if (existingIndex < 0) {
        throw new AtlasError(ATLAS_ERROR_CODES.INVALID_PAYLOAD, `没有可删除的人工范围：${areaId}（$.cells）。`);
      }
      if (topology.areas[existingIndex]!.evidence !== "manual") {
        throw new AtlasError(
          ATLAS_ERROR_CODES.INVALID_PAYLOAD,
          `该范围来自 ${topology.areas[existingIndex]!.evidence}，不能由人工涂色端点删除（$.cells）。`,
        );
      }
      topology.areas.splice(existingIndex, 1);
    } else {
      if (existingIndex < 0 && topology.areas.length >= ATLAS_GEO_LIMITS.areas) {
        throw new AtlasError(
          ATLAS_ERROR_CODES.FIELD_LIMIT_EXCEEDED,
          `本分支最多 ${ATLAS_GEO_LIMITS.areas} 块范围，已满（$.cells）。`,
        );
      }
      const area = {
        id: areaId,
        locationId,
        mapId,
        cells,
        evidence: "manual" as const,
      };
      if (existingIndex >= 0) topology.areas[existingIndex] = area;
      else topology.areas.push(area);
    }

    const topologyValidation = validateGeoTopology(topology, {
      branchKey,
      locations: branchTables.locations,
      characters: branchTables.characters,
      frames: { [mapId]: frame },
    });
    if (!topologyValidation.ok) {
      const first = topologyValidation.errors[0]!;
      throw new AtlasError(
        ATLAS_ERROR_CODES.INVALID_PAYLOAD,
        `候选地理拓扑未通过校验（${first.code} @ ${first.path}）：本次未做任何写入。`,
      );
    }

    await store.write(`simulation:${binding.worldId}`, simulationDoc);
    pushLog({
      at: now(),
      kind: "map-area-upsert",
      chatId: binding.chatId,
      worldId: binding.worldId,
      scanned: cells.length,
    });
    return okResult({
      status: "saved",
      areaId,
      mapId,
      locationId,
      cells: cells.length,
      removed: cells.length === 0,
    });
  }

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
    /**
     * E03：拖动纠偏必须同时改三表。
     * 行增量回合只认三表：不同步的话，作者把谁拖到哪里，下一回合就会被三表里的旧位置**静默回退**
     * （拖动看起来生效了、地图也确实动了一下，然后下一轮又回去）。
     */
    const tableSync = await syncBranchTablesFromWorld({
      store, binding, world: nextWorld, source: "worlds/move-author",
    });
    pushLog({
      at: now(),
      kind: "world-move-author",
      chatId: binding.chatId,
      worldId: binding.worldId,
      entityId,
      toPointId,
      protagonist: cursorMoved,
      reasonCode: tableSync.reasonCode,
      coreCommitted: tableSync.status === "synced",
    });
    return okResult({
      moved: { entityId, characterName, pointId: toPointId, pointName, regionId },
      ledgerEventId,
      cursorMoved,
      tables: tableSync,
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
      if (method === "POST" && route === "/maps/topology/confirm") return await handleTopologyConfirm(body);
      if (method === "POST" && route === "/maps/areas/upsert") return await handleAreasUpsert(body);
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
/**
 * H18a（0.9.59）：建图标定的结果。
 *
 * `calibrated` / `existing` 都表示「这张图现在有可信尺度」；
 * `scale-pending` 表示**没有**——地图照常保留，界面显示「未标定 · 按格」，
 * 绝不拿一个猜出来的米数冒充已标定（T25 / T29）。
 */
export type AtlasMapScaleEnsureResult =
  | { status: "calibrated" | "existing"; calibration: MapScaleCalibration }
  | { status: "scale-pending"; reasonCode: string };

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
      const sessionParse = parseAtlasSessionDocDetailed(record.session);
      const session = sessionParse.session;
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
        // A08：真实旧会话懒迁移——成功后经 overlay 写入并置 changed()，随本次响应带回浏览器落盘；
        // 失败/跳过绝不动 session（旧世界数据原样保留）。
        await ensureSessionTables({
          session,
          parse: sessionParse,
          overlay,
          store: deps.store,
          now: () => (deps.now ?? Date.now)(),
          onDiagnostic: deps.onDiagnostic,
        });
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
