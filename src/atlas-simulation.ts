/**
 * atlas-simulation.ts — 会话级「后台推演模块」纯数据层。
 *
 * 依据《Atlas v0.9.58 → 下一版本：后台动向、推演表、协议收口、地图与会话隔离施工计划》
 * §2.1（存储与归属）、§2.3（可见性与定时语义）、§2.5（层级 / 载具 / 传播）与 C01 / C02 / C03。
 *
 * 三条不可动摇的纪律：
 * 1. 三表（地点 / 人物 / 物品）仍是**实体现值的唯一权威**；本模块只记录「行动计划与状态」，
 *    不复制实体、不成为第二套时间 / 空间数据库。坐标与比例尺仍在原地图与三表里。
 * 2. **人物得知某消息必须由 deliveries 中的一条有来源的送达记录证实**；
 *    signals 的存在本身不能改变任何人的知识或反应（无送达 → 不得产生异地 reaction）。
 * 3. 本模块**零 IO、零副作用、纯函数**：不读 store、不调模型、不改会话文档、不用 `Date.now()` 造 ID。
 */

import type { AtlasGeoTopology } from "./atlas-geo-topology.ts";
import { planSignalSpread } from "./atlas-signal-propagation.ts";

export const ATLAS_SIMULATION_SCHEMA_VERSION = 1;

/** 默认分支键（正史）；IF 分支沿用 `branchScopeForStory` 的返回值。 */
export const DEFAULT_SIMULATION_BRANCH = "canon";

/* ------------------------------------------------------------------ *
 * §2.1 固定结构（字段名 / 类型 / 字面量联合一字不改）
 * ------------------------------------------------------------------ */

export type AtlasSimulationKind = "intent" | "travel" | "reaction";
export type AtlasSimulationStatus = "queued" | "active" | "blocked" | "resolved" | "cancelled";
export type AtlasSimulationVisibility = "known" | "hidden";
export type AtlasSimulationSource = "observed" | "character-intent" | "schedule" | "engine";
export type AtlasDeliveryVia =
  | "witness" | "travel" | "messenger" | "contact" | "faction" | "explicit-channel";
export type AtlasDeliveryConfidence = "confirmed" | "rumor" | "disputed";

export interface AtlasSimulationTask {
  id: string;
  kind: AtlasSimulationKind;
  status: AtlasSimulationStatus;
  actorCharacterId: string | null;
  originLocationId: string | null;
  targetLocationId: string | null;
  topic: string;
  /** 反应任务须指向**已送达该人**的消息；其他类型为 null。 */
  signalId: string | null;
  visibility: AtlasSimulationVisibility;
  source: AtlasSimulationSource;
  createdTurnKey: string;
  lastAppliedTurnKey: string | null;
  createdPeriod: number;
  nextEligiblePeriod: number | null;
  reasonCode: string | null;
}

export interface AtlasSignal {
  id: string;
  originLocationId: string;
  /** 只存有界摘要，绝不保存完整剧情正文。 */
  topic: string;
  sourceTurnKey: string;
  /** 验证后由**引擎**生成；绝不接受模型自报的 sourceId。 */
  sourceQuoteId: string;
  publishedPeriod: number;
  visibility: AtlasSimulationVisibility;
  status: "active" | "cancelled";
  /** 下一批候选的确定性排序下标；回退一起还原。 */
  propagationCursor: number;
}

export interface AtlasDelivery {
  id: string;
  signalId: string;
  recipientType: "location" | "character";
  /** 正式 `loc:*` / `npc:*` ID，引用同一分支三表。 */
  recipientId: string;
  via: AtlasDeliveryVia;
  fromLocationId: string;
  receivedPeriod: number;
  /** 风声不等于已核实事实。 */
  confidence: AtlasDeliveryConfidence;
}

export interface AtlasSimulationBranch {
  tasks: AtlasSimulationTask[];
  signals: AtlasSignal[];
  deliveries: AtlasDelivery[];
  geoTopology: AtlasGeoTopology;
}

export interface AtlasSimulationStore {
  schemaVersion: 1;
  worldId: string;
  branches: Record<string, AtlasSimulationBranch>;
}

export type AtlasSimulationEventStatus =
  | "intent-recorded" | "started" | "progressed" | "arrived"
  | "blocked" | "resolved" | "published" | "delivered";

/** 每一回合实际发生的行动记录；由 C09 / D04 归档到 `session.turns[turnKey].simulationEvents`。 */
export interface AtlasSimulationEvent {
  id: string;
  simulationId: string;
  kind: AtlasSimulationKind | "signal" | "delivery";
  actorCharacterId: string | null;
  fromLocationId: string | null;
  toLocationId: string | null;
  status: AtlasSimulationEventStatus;
  reasonCode: string | null;
  /** 只说明已验证事实；被阻止时绝不写「已抵达」。 */
  summary: string;
  visibility: AtlasSimulationVisibility;
  period: number;
}

/** 精确到行的逆操作；禁止逐回合复制整个模块。 */
export interface AtlasSimulationUndoEntry {
  collection: "tasks" | "signals" | "deliveries" | "edges" | "areas" | "vehicles";
  id: string;
  before: unknown | null;
}

export interface AtlasSimulationDiagnostic {
  code: string;
  path: string;
  detail?: string;
}

/**
 * 上限：**唯一权威**，禁止在别处再抄一份数字。
 * 整体 JSON 硬上限按 §2.1 定为 240000 字；A05 的体积实测若与此冲突，先改此处与对应测试，
 * **不得**截断后伪称成功。
 */
export const ATLAS_SIMULATION_LIMITS = {
  branches: 32,
  tasks: 128,
  activeTasks: 64,
  signals: 64,
  deliveries: 256,
  edges: 256,
  areas: 64,
  areaCells: 256,
  vehicles: 64,
  topicChars: 160,
  idChars: 120,
  eventChars: 160,
  eventsPerTurn: 16,
  jsonChars: 240000,
} as const;

const KINDS: readonly AtlasSimulationKind[] = ["intent", "travel", "reaction"];
const STATUSES: readonly AtlasSimulationStatus[] = ["queued", "active", "blocked", "resolved", "cancelled"];
const SOURCES: readonly AtlasSimulationSource[] = ["observed", "character-intent", "schedule", "engine"];
const VISIBILITIES: readonly AtlasSimulationVisibility[] = ["known", "hidden"];
const VIAS: readonly AtlasDeliveryVia[] =
  ["witness", "travel", "messenger", "contact", "faction", "explicit-channel"];
const CONFIDENCES: readonly AtlasDeliveryConfidence[] = ["confirmed", "rumor", "disputed"];

/** 终态任务可保留已被删除的历史实体引用。 */
export function isTerminalSimulationStatus(status: AtlasSimulationStatus): boolean {
  return status === "resolved" || status === "cancelled";
}

/**
 * 状态转换白名单（C02）：只允许
 * `queued→active/blocked/cancelled`、`active/blocked→active/resolved/cancelled`。
 * `resolved/cancelled` 是终态，**不复活同 ID**。
 */
export function canTransitionSimulationStatus(from: AtlasSimulationStatus, to: AtlasSimulationStatus): boolean {
  if (from === to) return true;
  if (from === "resolved" || from === "cancelled") return false;
  if (from === "queued") return to === "active" || to === "blocked" || to === "cancelled";
  // active / blocked
  return to === "active" || to === "resolved" || to === "cancelled";
}

/* ------------------------------------------------------------------ *
 * 确定性 ID：同输入必得同 ID，绝不使用 Date.now / Math.random
 * ------------------------------------------------------------------ */

function fnv1a(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 16 位小写十六进制稳定摘要（双 seed FNV-1a，避免单 32 位碰撞过早出现）。 */
export function simulationDigest(text: string): string {
  const low = fnv1a(text, 0x811c9dc5).toString(16).padStart(8, "0");
  const high = fnv1a(`${text}#atlas`, 0x1000193).toString(16).padStart(8, "0");
  return low + high;
}

function joinParts(parts: readonly (string | number | null | undefined)[]): string {
  return parts.map((part) => (part === null || part === undefined ? "-" : String(part))).join("|");
}

export function simulationTaskId(input: {
  chatId: string; branchKey: string; turnKey: string;
  actorCharacterId: string | null; kind: AtlasSimulationKind; sequence: number;
}): string {
  return "task:" + simulationDigest(joinParts([
    input.chatId, input.branchKey, input.turnKey, input.actorCharacterId, input.kind, input.sequence,
  ]));
}

export function simulationSignalId(input: {
  chatId: string; branchKey: string; sourceTurnKey: string; originLocationId: string; topic: string;
}): string {
  return "sig:" + simulationDigest(joinParts([
    input.chatId, input.branchKey, input.sourceTurnKey, input.originLocationId, input.topic,
  ]));
}

/** 送达 ID = signalId + recipientType + recipientId 的确定性 ID（§2.1）。 */
export function simulationDeliveryId(signalId: string, recipientType: "location" | "character", recipientId: string): string {
  return "dlv:" + simulationDigest(joinParts([signalId, recipientType, recipientId]));
}

/** 事件 ID = turnKey + 行序号（§2.1）。 */
export function simulationEventId(turnKey: string, sequence: number): string {
  return "evt:" + simulationDigest(joinParts([turnKey, sequence]));
}

/* ------------------------------------------------------------------ *
 * C01 —— 空模块
 * ------------------------------------------------------------------ */

function emptyTopology(): AtlasGeoTopology {
  // 结构上等同 `createEmptyTopology()`；此处就地构造以免与 H01 模块形成运行时耦合。
  return { edges: [], areas: [], vehicles: [] };
}

export function createEmptySimulationBranch(): AtlasSimulationBranch {
  return { tasks: [], signals: [], deliveries: [], geoTopology: emptyTopology() };
}

/**
 * C01：`worldId` 显式提供；canon 分支存在且四个数组全为空。
 * 空模块**合法**——旧会话 simulation 字段缺失等价于此，而不是「损坏」。
 */
export function createEmptySimulation(worldId: string): AtlasSimulationStore {
  return {
    schemaVersion: ATLAS_SIMULATION_SCHEMA_VERSION,
    worldId,
    branches: { [DEFAULT_SIMULATION_BRANCH]: createEmptySimulationBranch() },
  };
}

export function cloneSimulationStore(store: AtlasSimulationStore): AtlasSimulationStore {
  try {
    return JSON.parse(JSON.stringify(store)) as AtlasSimulationStore;
  } catch {
    return createEmptySimulation(store.worldId);
  }
}

function branchOf(store: AtlasSimulationStore, branchKey: string): AtlasSimulationBranch {
  const existing = store.branches[branchKey];
  if (existing) return existing;
  const created = createEmptySimulationBranch();
  store.branches[branchKey] = created;
  return created;
}

/* ------------------------------------------------------------------ *
 * C02 —— 校验
 * ------------------------------------------------------------------ */

export type AtlasSimulationErrorCode =
  | "STORE_NOT_OBJECT"
  | "STORE_SCHEMA_VERSION"
  | "WORLD_ID_MISSING"
  | "CROSS_WORLD"
  | "BRANCH_NOT_OBJECT"
  | "BRANCH_LIMIT"
  | "COLLECTION_NOT_ARRAY"
  | "ROWS_EXCEEDED"
  | "ACTIVE_ROWS_EXCEEDED"
  | "ROW_NOT_OBJECT"
  | "FIELD_MISSING"
  | "FIELD_TYPE"
  | "TEXT_TOO_LONG"
  | "ID_TOO_LONG"
  | "DUPLICATE_ID"
  | "ENUM_INVALID"
  | "PERIOD_INVALID"
  | "REF_MISSING"
  | "DELIVERY_DUPLICATE"
  | "DELIVERY_BEFORE_PUBLISH"
  | "REACTION_WITHOUT_DELIVERY"
  | "JSON_TOO_LARGE";

export interface AtlasSimulationError {
  code: AtlasSimulationErrorCode;
  path: string;
}

export type AtlasSimulationValidation =
  | { ok: true; errors: [] }
  | { ok: false; errors: AtlasSimulationError[] };

export interface AtlasSimulationTablesView {
  locations?: readonly { id: string }[] | undefined;
  characters?: readonly { id: string }[] | undefined;
}

export interface AtlasSimulationValidationOptions {
  /** 会话绑定的世界 ID；传入即执行「跨世界」检查。 */
  expectedWorldId?: string | undefined;
  /** 引用解析用三表投影；缺省时无法解析正式 ID，跳过引用检查。 */
  tables?: AtlasSimulationTablesView | null | undefined;
  /** 按分支给出的三表投影（优先于 `tables`）：推演模块按分支隔离，引用也必须按分支解析。 */
  tablesByBranch?: Record<string, AtlasSimulationTablesView> | null | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function branchPath(branchKey: string, collection: string, index?: number): string {
  const head = `$.simulation.branches.${branchKey}.${collection}`;
  return index === undefined ? head : `${head}[${index}]`;
}

/**
 * C02：结构、上限、唯一 ID、枚举白名单与**同分支三表引用**校验。
 *
 * 引用规则：**非终态** task 的地点 / 人物正式 ID、signal 的发起地、delivery 的消息与收件人、
 * geoTopology 的边 / 面 / 载具都必须能在本分支三表解析；**终态 task 可保留被删除的历史引用**。
 */
export function validateSimulationStore(
  input: unknown,
  options: AtlasSimulationValidationOptions = {},
): AtlasSimulationValidation {
  const errors: AtlasSimulationError[] = [];
  if (!isRecord(input)) return { ok: false, errors: [{ code: "STORE_NOT_OBJECT", path: "$.simulation" }] };
  if (input.schemaVersion !== ATLAS_SIMULATION_SCHEMA_VERSION) {
    return { ok: false, errors: [{ code: "STORE_SCHEMA_VERSION", path: "$.simulation.schemaVersion" }] };
  }
  const worldId = input.worldId;
  if (typeof worldId !== "string" || worldId.length === 0) {
    return { ok: false, errors: [{ code: "WORLD_ID_MISSING", path: "$.simulation.worldId" }] };
  }
  if (options.expectedWorldId !== undefined && options.expectedWorldId !== worldId) {
    return { ok: false, errors: [{ code: "CROSS_WORLD", path: "$.simulation.worldId" }] };
  }
  if (!isRecord(input.branches)) {
    return { ok: false, errors: [{ code: "BRANCH_NOT_OBJECT", path: "$.simulation.branches" }] };
  }
  const branchKeys = Object.keys(input.branches);
  if (branchKeys.length > ATLAS_SIMULATION_LIMITS.branches) {
    errors.push({ code: "BRANCH_LIMIT", path: "$.simulation.branches" });
  }

  const knownLocations = options.tables?.locations
    ? new Set(options.tables.locations.map((row) => row.id)) : null;
  const knownCharacters = options.tables?.characters
    ? new Set(options.tables.characters.map((row) => row.id)) : null;

  for (const branchKey of branchKeys) {
    const branch = input.branches[branchKey];
    if (!isRecord(branch)) {
      errors.push({ code: "BRANCH_NOT_OBJECT", path: `$.simulation.branches.${branchKey}` });
      continue;
    }
    // 引用必须按**本分支**三表解析：IF 分支不能拿正史的人物 / 地点蒙混过关
    const branchTables = options.tablesByBranch?.[branchKey] ?? options.tables ?? null;
    const branchLocations = branchTables?.locations
      ? new Set(branchTables.locations.map((row) => row.id)) : knownLocations;
    const branchCharacters = branchTables?.characters
      ? new Set(branchTables.characters.map((row) => row.id)) : knownCharacters;
    const tasks = branch.tasks;
    const signals = branch.signals;
    const deliveries = branch.deliveries;
    if (!Array.isArray(tasks)) errors.push({ code: "COLLECTION_NOT_ARRAY", path: branchPath(branchKey, "tasks") });
    if (!Array.isArray(signals)) errors.push({ code: "COLLECTION_NOT_ARRAY", path: branchPath(branchKey, "signals") });
    if (!Array.isArray(deliveries)) errors.push({ code: "COLLECTION_NOT_ARRAY", path: branchPath(branchKey, "deliveries") });
    if (!Array.isArray(tasks) || !Array.isArray(signals) || !Array.isArray(deliveries)) continue;

    if (tasks.length > ATLAS_SIMULATION_LIMITS.tasks) {
      errors.push({ code: "ROWS_EXCEEDED", path: branchPath(branchKey, "tasks") });
    }
    if (signals.length > ATLAS_SIMULATION_LIMITS.signals) {
      errors.push({ code: "ROWS_EXCEEDED", path: branchPath(branchKey, "signals") });
    }
    if (deliveries.length > ATLAS_SIMULATION_LIMITS.deliveries) {
      errors.push({ code: "ROWS_EXCEEDED", path: branchPath(branchKey, "deliveries") });
    }

    const signalIds = new Set<string>();
    const publishedPeriods = new Map<string, number>();

    for (let index = 0; index < signals.length; index += 1) {
      const row = signals[index];
      const path = branchPath(branchKey, "signals", index);
      if (!isRecord(row)) { errors.push({ code: "ROW_NOT_OBJECT", path }); continue; }
      if (typeof row.id !== "string" || row.id.length === 0) {
        errors.push({ code: "FIELD_MISSING", path: `${path}.id` });
      } else {
        if (row.id.length > ATLAS_SIMULATION_LIMITS.idChars) errors.push({ code: "ID_TOO_LONG", path: `${path}.id` });
        if (signalIds.has(row.id)) errors.push({ code: "DUPLICATE_ID", path: `${path}.id` });
        signalIds.add(row.id);
      }
      if (typeof row.originLocationId !== "string" || row.originLocationId.length === 0) {
        errors.push({ code: "FIELD_MISSING", path: `${path}.originLocationId` });
      } else if (branchLocations && !branchLocations.has(row.originLocationId)) {
        errors.push({ code: "REF_MISSING", path: `${path}.originLocationId` });
      }
      if (typeof row.topic !== "string") errors.push({ code: "FIELD_TYPE", path: `${path}.topic` });
      else if (row.topic.length > ATLAS_SIMULATION_LIMITS.topicChars) {
        errors.push({ code: "TEXT_TOO_LONG", path: `${path}.topic` });
      }
      if (typeof row.sourceTurnKey !== "string" || row.sourceTurnKey.length === 0) {
        errors.push({ code: "FIELD_MISSING", path: `${path}.sourceTurnKey` });
      }
      // sourceQuoteId 由引擎生成；模型自报的虚构 id 不在此接受
      if (typeof row.sourceQuoteId !== "string" || row.sourceQuoteId.length === 0) {
        errors.push({ code: "FIELD_MISSING", path: `${path}.sourceQuoteId` });
      }
      if (!isFiniteNumber(row.publishedPeriod) || row.publishedPeriod < 0) {
        errors.push({ code: "PERIOD_INVALID", path: `${path}.publishedPeriod` });
      } else if (typeof row.id === "string") {
        publishedPeriods.set(row.id, row.publishedPeriod);
      }
      if (!VISIBILITIES.includes(row.visibility as AtlasSimulationVisibility)) {
        errors.push({ code: "ENUM_INVALID", path: `${path}.visibility` });
      }
      if (row.status !== "active" && row.status !== "cancelled") {
        errors.push({ code: "ENUM_INVALID", path: `${path}.status` });
      }
      if (!isFiniteNumber(row.propagationCursor) || row.propagationCursor < 0) {
        errors.push({ code: "PERIOD_INVALID", path: `${path}.propagationCursor` });
      }
    }

    const taskIds = new Set<string>();
    let activeTaskCount = 0;
    for (let index = 0; index < tasks.length; index += 1) {
      const row = tasks[index];
      const path = branchPath(branchKey, "tasks", index);
      if (!isRecord(row)) { errors.push({ code: "ROW_NOT_OBJECT", path }); continue; }
      if (typeof row.id !== "string" || row.id.length === 0) {
        errors.push({ code: "FIELD_MISSING", path: `${path}.id` });
      } else {
        if (row.id.length > ATLAS_SIMULATION_LIMITS.idChars) errors.push({ code: "ID_TOO_LONG", path: `${path}.id` });
        if (taskIds.has(row.id)) errors.push({ code: "DUPLICATE_ID", path: `${path}.id` });
        taskIds.add(row.id);
      }
      if (!KINDS.includes(row.kind as AtlasSimulationKind)) {
        errors.push({ code: "ENUM_INVALID", path: `${path}.kind` });
      }
      if (!STATUSES.includes(row.status as AtlasSimulationStatus)) {
        errors.push({ code: "ENUM_INVALID", path: `${path}.status` });
      } else if (!isTerminalSimulationStatus(row.status as AtlasSimulationStatus)) {
        activeTaskCount += 1;
      }
      if (!SOURCES.includes(row.source as AtlasSimulationSource)) {
        errors.push({ code: "ENUM_INVALID", path: `${path}.source` });
      }
      if (!VISIBILITIES.includes(row.visibility as AtlasSimulationVisibility)) {
        errors.push({ code: "ENUM_INVALID", path: `${path}.visibility` });
      }
      const terminal = isTerminalSimulationStatus(row.status as AtlasSimulationStatus);
      const refs: [string, unknown, Set<string> | null][] = [
        ["actorCharacterId", row.actorCharacterId, branchCharacters],
        ["originLocationId", row.originLocationId, branchLocations],
        ["targetLocationId", row.targetLocationId, branchLocations],
      ];
      for (const [field, value, known] of refs) {
        if (value === null) continue;
        if (typeof value !== "string" || value.length === 0) {
          errors.push({ code: "FIELD_TYPE", path: `${path}.${field}` });
          continue;
        }
        // 终态任务可保留后来被删除的历史实体引用
        if (!terminal && known && !known.has(value)) {
          errors.push({ code: "REF_MISSING", path: `${path}.${field}` });
        }
      }
      if (row.signalId !== null) {
        if (typeof row.signalId !== "string" || !signalIds.has(row.signalId)) {
          errors.push({ code: "REF_MISSING", path: `${path}.signalId` });
        } else if (row.kind === "reaction") {
          // 因果倒置：反应任务必须指向一条**已送达该人**的消息
          const actor = row.actorCharacterId;
          const delivered = deliveries.some((delivery) => isRecord(delivery) &&
            delivery.signalId === row.signalId &&
            delivery.recipientType === "character" &&
            delivery.recipientId === actor);
          if (!delivered) errors.push({ code: "REACTION_WITHOUT_DELIVERY", path: `${path}.signalId` });
        }
      } else if (row.kind === "reaction") {
        errors.push({ code: "FIELD_MISSING", path: `${path}.signalId` });
      }
      if (typeof row.topic !== "string") errors.push({ code: "FIELD_TYPE", path: `${path}.topic` });
      else if (row.topic.length > ATLAS_SIMULATION_LIMITS.topicChars) {
        errors.push({ code: "TEXT_TOO_LONG", path: `${path}.topic` });
      }
      if (typeof row.createdTurnKey !== "string" || row.createdTurnKey.length === 0) {
        errors.push({ code: "FIELD_MISSING", path: `${path}.createdTurnKey` });
      }
      if (row.lastAppliedTurnKey !== null && typeof row.lastAppliedTurnKey !== "string") {
        errors.push({ code: "FIELD_TYPE", path: `${path}.lastAppliedTurnKey` });
      }
      if (!isFiniteNumber(row.createdPeriod) || row.createdPeriod < 0) {
        errors.push({ code: "PERIOD_INVALID", path: `${path}.createdPeriod` });
      }
      if (row.nextEligiblePeriod !== null && (!isFiniteNumber(row.nextEligiblePeriod) || row.nextEligiblePeriod < 0)) {
        errors.push({ code: "PERIOD_INVALID", path: `${path}.nextEligiblePeriod` });
      }
      if (row.reasonCode !== null && typeof row.reasonCode !== "string") {
        errors.push({ code: "FIELD_TYPE", path: `${path}.reasonCode` });
      }
    }
    if (activeTaskCount > ATLAS_SIMULATION_LIMITS.activeTasks) {
      errors.push({ code: "ACTIVE_ROWS_EXCEEDED", path: branchPath(branchKey, "tasks") });
    }

    const deliveryKeys = new Set<string>();
    for (let index = 0; index < deliveries.length; index += 1) {
      const row = deliveries[index];
      const path = branchPath(branchKey, "deliveries", index);
      if (!isRecord(row)) { errors.push({ code: "ROW_NOT_OBJECT", path }); continue; }
      if (typeof row.id !== "string" || row.id.length === 0) {
        errors.push({ code: "FIELD_MISSING", path: `${path}.id` });
      } else if (row.id.length > ATLAS_SIMULATION_LIMITS.idChars) {
        errors.push({ code: "ID_TOO_LONG", path: `${path}.id` });
      }
      if (typeof row.signalId !== "string" || !signalIds.has(row.signalId)) {
        errors.push({ code: "REF_MISSING", path: `${path}.signalId` });
      }
      if (row.recipientType !== "location" && row.recipientType !== "character") {
        errors.push({ code: "ENUM_INVALID", path: `${path}.recipientType` });
      } else if (typeof row.recipientId === "string") {
        const known = row.recipientType === "location" ? branchLocations : branchCharacters;
        if (known && !known.has(row.recipientId)) {
          errors.push({ code: "REF_MISSING", path: `${path}.recipientId` });
        }
        // 同一 (signal, recipientType, recipientId) 不能重复
        const key = joinParts([row.signalId as string, row.recipientType, row.recipientId]);
        if (deliveryKeys.has(key)) errors.push({ code: "DELIVERY_DUPLICATE", path: `${path}.recipientId` });
        deliveryKeys.add(key);
      } else {
        errors.push({ code: "FIELD_MISSING", path: `${path}.recipientId` });
      }
      if (!VIAS.includes(row.via as AtlasDeliveryVia)) {
        errors.push({ code: "ENUM_INVALID", path: `${path}.via` });
      }
      if (typeof row.fromLocationId !== "string" || row.fromLocationId.length === 0) {
        errors.push({ code: "FIELD_MISSING", path: `${path}.fromLocationId` });
      } else if (branchLocations && !branchLocations.has(row.fromLocationId)) {
        errors.push({ code: "REF_MISSING", path: `${path}.fromLocationId` });
      }
      if (!isFiniteNumber(row.receivedPeriod) || row.receivedPeriod < 0) {
        errors.push({ code: "PERIOD_INVALID", path: `${path}.receivedPeriod` });
      } else if (typeof row.signalId === "string") {
        const published = publishedPeriods.get(row.signalId);
        // 因果倒置：送达不得早于发布
        if (published !== undefined && row.receivedPeriod < published) {
          errors.push({ code: "DELIVERY_BEFORE_PUBLISH", path: `${path}.receivedPeriod` });
        }
      }
      if (!CONFIDENCES.includes(row.confidence as AtlasDeliveryConfidence)) {
        errors.push({ code: "ENUM_INVALID", path: `${path}.confidence` });
      }
    }

    // geoTopology 的深度校验由 H02 / validateGeoTopology 负责；此处只保证形状与分支隔离。
    if (!isRecord(branch.geoTopology)) {
      errors.push({ code: "FIELD_MISSING", path: `$.simulation.branches.${branchKey}.geoTopology` });
    }
  }

  if (errors.length > 0) return { ok: false, errors: errors.slice(0, 64) };
  // 部分采纳也不得突破整个模块的 JSON 总上限
  let chars = 0;
  try { chars = JSON.stringify(input).length; } catch { chars = Number.MAX_SAFE_INTEGER; }
  if (chars > ATLAS_SIMULATION_LIMITS.jsonChars) {
    return { ok: false, errors: [{ code: "JSON_TOO_LARGE", path: "$.simulation" }] };
  }
  return { ok: true, errors: [] };
}

/* ------------------------------------------------------------------ *
 * C03 —— 效果应用（纯函数）
 * ------------------------------------------------------------------ */

/** 已由三表增量接受的一条编辑（供推演侧推导意图 / 移动任务）。 */
export interface AtlasSimulationAcceptedEdit {
  table: "location" | "character" | "item";
  op: "add" | "set" | "remove";
  ref: string;
  /** 该行应用后的新值（人物行可含 `locationId` / `targetLocationId` / `actionTendency` / `currentAction`）。 */
  row?: Record<string, unknown> | null;
}

/** 日程 / 后台移动：由引擎（而非模型）算出的实际行动结果。 */
export interface AtlasSimulationMove {
  actorCharacterId: string;
  kind: "travel" | "schedule";
  fromLocationId: string | null;
  toLocationId: string | null;
  /** 本轮是否真的完成移动；false = 仍在途或受阻。 */
  arrived: boolean;
  reasonCode: string | null;
  periodsUsed: number;
  visibility?: AtlasSimulationVisibility | undefined;
}

/** E04 接好解析后启用的 `simulation.propose` 候选（模型只能提「待传播事实」，不能令人物移动）。 */
export interface AtlasSignalProposal {
  originLocationId: string;
  topic: string;
  /** 已通过「连续逐字出现在助手本轮正文中」校验的引文 id。 */
  sourceQuoteId: string;
  visibility?: AtlasSimulationVisibility | undefined;
}

export interface AtlasSimulationCharacterLocation {
  id: string;
  locationId: string | null;
}

export interface AtlasSimulationEffectInput {
  chatId: string;
  branchKey: string;
  /** 上一模块（不被修改）。 */
  previous: AtlasSimulationStore;
  turnKey: string;
  /** 当前时间游标（时段序号）。 */
  period: number;
  /** 本轮由 D03 推得的**完整**新时段数；0 = 时间未推进。 */
  periodsElapsed: number;
  acceptedEdits?: readonly AtlasSimulationAcceptedEdit[] | undefined;
  proposal?: AtlasSignalProposal | null | undefined;
  /** E04：同一块里可以有多条 `simulation.propose`（缺省为空）。 */
  proposals?: readonly AtlasSignalProposal[] | undefined;
  moves?: readonly AtlasSimulationMove[] | undefined;
  /** 当前分支人物的位置投影（引擎从三表取），用于同地目击与逐跳传播。 */
  characterLocations?: readonly AtlasSimulationCharacterLocation[] | undefined;
  /**
   * D02：本分支**已确认**的地理拓扑（`geoTopology`）。
   * 有它才会做跨区逐跳传播；没有就只登记发起地与真正同地目击（保守，不猜路径）。
   */
  topology?: AtlasGeoTopology | null | undefined;
}

export interface AtlasSimulationEffectResult {
  next: AtlasSimulationStore;
  events: AtlasSimulationEvent[];
  undo: AtlasSimulationUndoEntry[];
  diagnostics: AtlasSimulationDiagnostic[];
  /** 事件超出一轮上限时为 true（**显式**告知，不静默丢弃）。 */
  eventsTruncated: boolean;
  droppedEventCount: number;
}

function clipText(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit);
}

function taskSummary(task: AtlasSimulationTask, status: AtlasSimulationEventStatus): string {
  const who = task.actorCharacterId ?? "某人";
  const topic = task.topic.length > 0 ? task.topic : "行动";
  switch (status) {
    case "intent-recorded": return clipText(`${who} 记下意图：${topic}`, ATLAS_SIMULATION_LIMITS.eventChars);
    case "started": return clipText(`${who} 依计划出发：${topic}`, ATLAS_SIMULATION_LIMITS.eventChars);
    case "progressed": return clipText(`${who} 仍在路上：${topic}`, ATLAS_SIMULATION_LIMITS.eventChars);
    case "arrived": return clipText(`${who} 已抵达：${topic}`, ATLAS_SIMULATION_LIMITS.eventChars);
    case "resolved": return clipText(`${who} 已完成：${topic}`, ATLAS_SIMULATION_LIMITS.eventChars);
    case "blocked": return clipText(`${who} 暂不能行动：${topic}`, ATLAS_SIMULATION_LIMITS.eventChars);
    default: return clipText(`${who}：${topic}`, ATLAS_SIMULATION_LIMITS.eventChars);
  }
}

/**
 * C03：把「已接受的三表编辑 + 已确认的行动结果 + 可选 signal.propose」折算成
 * 新的推演模块、本轮事件、逐行 undo 与诊断。
 *
 * 定时语义（§2.3）：`periodsElapsed === 0` 时**只记录意图与状态**，
 * 人物不得完成旅行、消息不得跨区送达。
 */
export function applySimulationEffects(input: AtlasSimulationEffectInput): AtlasSimulationEffectResult {
  const next = cloneSimulationStore(input.previous);
  const branch = branchOf(next, input.branchKey);
  const rawEvents: AtlasSimulationEvent[] = [];
  const undo: AtlasSimulationUndoEntry[] = [];
  const diagnostics: AtlasSimulationDiagnostic[] = [];
  const noTime = input.periodsElapsed <= 0;

  function pushEvent(event: Omit<AtlasSimulationEvent, "id">): void {
    rawEvents.push({ ...event, id: simulationEventId(input.turnKey, rawEvents.length) });
  }

  /* ---- 1) 一件已公开事实 → 一条 signal + 发起地送达 + 同地目击 ---- */
  const proposalList = [
    ...(input.proposal ? [input.proposal] : []),
    ...(input.proposals ?? []),
  ];
  for (const proposal of proposalList) {
    if (proposal.topic.length === 0 || proposal.originLocationId.length === 0) continue;
    const signalId = simulationSignalId({
      chatId: input.chatId, branchKey: input.branchKey,
      sourceTurnKey: input.turnKey, originLocationId: proposal.originLocationId, topic: proposal.topic,
    });
    if (!branch.signals.some((row) => row.id === signalId)) {
      if (branch.signals.length >= ATLAS_SIMULATION_LIMITS.signals) {
        diagnostics.push({ code: "LIMIT_REACHED", path: "$.simulation.branches." + input.branchKey + ".signals" });
      } else {
        const signal: AtlasSignal = {
          id: signalId,
          originLocationId: proposal.originLocationId,
          topic: clipText(proposal.topic, ATLAS_SIMULATION_LIMITS.topicChars),
          sourceTurnKey: input.turnKey,
          sourceQuoteId: proposal.sourceQuoteId,
          publishedPeriod: input.period,
          visibility: proposal.visibility ?? "known",
          status: "active",
          propagationCursor: 0,
        };
        branch.signals.push(signal);
        undo.push({ collection: "signals", id: signalId, before: null });
        pushEvent({
          simulationId: signalId, kind: "signal", actorCharacterId: null,
          fromLocationId: signal.originLocationId, toLocationId: signal.originLocationId,
          status: "published", reasonCode: null,
          summary: clipText(`消息已公开：${signal.topic}`, ATLAS_SIMULATION_LIMITS.eventChars),
          visibility: signal.visibility, period: input.period,
        });

        // 发起地本身算一处送达（风声到达该地点）
        const locationDeliveryId = simulationDeliveryId(signalId, "location", signal.originLocationId);
        if (!branch.deliveries.some((row) => row.id === locationDeliveryId)) {
          branch.deliveries.push({
            id: locationDeliveryId, signalId, recipientType: "location",
            recipientId: signal.originLocationId, via: "witness",
            fromLocationId: signal.originLocationId, receivedPeriod: input.period, confidence: "confirmed",
          });
          undo.push({ collection: "deliveries", id: locationDeliveryId, before: null });
        }

        // 真正**同地**的人物目击：第 0 时段也只允许这一种人物送达
        for (const person of input.characterLocations ?? []) {
          if (person.locationId !== signal.originLocationId) continue;
          const deliveryId = simulationDeliveryId(signalId, "character", person.id);
          if (branch.deliveries.some((row) => row.id === deliveryId)) continue;
          if (branch.deliveries.length >= ATLAS_SIMULATION_LIMITS.deliveries) {
            diagnostics.push({ code: "LIMIT_REACHED", path: "$.simulation.branches." + input.branchKey + ".deliveries" });
            break;
          }
          branch.deliveries.push({
            id: deliveryId, signalId, recipientType: "character", recipientId: person.id,
            via: "witness", fromLocationId: signal.originLocationId,
            receivedPeriod: input.period, confidence: "confirmed",
          });
          undo.push({ collection: "deliveries", id: deliveryId, before: null });
          pushEvent({
            simulationId: deliveryId, kind: "delivery", actorCharacterId: person.id,
            fromLocationId: signal.originLocationId, toLocationId: signal.originLocationId,
            status: "delivered", reasonCode: null,
            summary: clipText(`${person.id} 当时在场，已知：${signal.topic}`, ATLAS_SIMULATION_LIMITS.eventChars),
            visibility: signal.visibility, period: input.period,
          });
        }
      }
    }
  }

  /* ---- 1.5) 消息逐跳传播（D02）：只有时间真的推进才跨区 ---- */
  if (input.topology) {
    const spread = planSignalSpread({
      topology: input.topology,
      signals: branch.signals,
      deliveries: branch.deliveries,
      characterLocations: input.characterLocations ?? [],
      period: input.period,
      periodsElapsed: input.periodsElapsed,
    });
    for (const request of spread.deliveries) {
      if (branch.deliveries.length >= ATLAS_SIMULATION_LIMITS.deliveries) {
        diagnostics.push({
          code: "LIMIT_REACHED",
          path: "$.simulation.branches." + input.branchKey + ".deliveries",
        });
        break;
      }
      const deliveryId = simulationDeliveryId(request.signalId, request.recipientType, request.recipientId);
      // 同一 (signal, recipientType, recipientId) 天然幂等：重放不会重复写入
      if (branch.deliveries.some((row) => row.id === deliveryId)) continue;
      const signalRow = branch.signals.find((row) => row.id === request.signalId);
      branch.deliveries.push({
        id: deliveryId,
        signalId: request.signalId,
        recipientType: request.recipientType,
        recipientId: request.recipientId,
        via: request.via,
        fromLocationId: request.fromLocationId,
        receivedPeriod: request.receivedPeriod,
        confidence: request.confidence,
      });
      undo.push({ collection: "deliveries", id: deliveryId, before: null });
      // 事件只说明「谁在何时何地获知」；**不指定**此人的态度、立场与移动
      const topic = signalRow?.topic ?? "";
      pushEvent({
        simulationId: deliveryId,
        kind: "delivery",
        actorCharacterId: request.recipientType === "character" ? request.recipientId : null,
        fromLocationId: request.fromLocationId,
        toLocationId: request.recipientType === "location" ? request.recipientId : null,
        status: "delivered",
        reasonCode: null,
        summary: clipText(
          request.recipientType === "character" ? `获知消息：${topic}` : `风声传到新地点：${topic}`,
          ATLAS_SIMULATION_LIMITS.eventChars,
        ),
        visibility: signalRow?.visibility ?? "known",
        period: input.period,
      });
    }
    // 传播游标必须一起回退（§2.1：propagationCursor 参与回退还原）
    for (const [signalId, cursor] of Object.entries(spread.cursors)) {
      const signalRow = branch.signals.find((row) => row.id === signalId);
      if (!signalRow || signalRow.propagationCursor === cursor) continue;
      undo.push({ collection: "signals", id: signalId, before: { ...signalRow } });
      signalRow.propagationCursor = cursor;
    }
    for (const entry of spread.diagnostics) {
      diagnostics.push({
        code: entry.code,
        path: "$.simulation.branches." + input.branchKey + ".deliveries",
        ...(entry.signalId === null ? {} : { detail: entry.signalId }),
      });
    }
  }

  /* ---- 2) 已接受的三表编辑 → 意图 / 移动任务 ---- */
  /** 本轮刚创建的行：undo 只记 `before: null` 一次，避免同一 id 出现两条逆操作。 */
  const createdThisTurn = new Set<string>();
  let sequence = 0;
  for (const edit of input.acceptedEdits ?? []) {
    if (edit.table !== "character" || edit.op === "remove") continue;
    const row = edit.row ?? null;
    if (!row) continue;
    const targetLocationId = typeof row.targetLocationId === "string" ? row.targetLocationId : null;
    const locationId = typeof row.locationId === "string" ? row.locationId : null;
    const actionTendency = typeof row.actionTendency === "string" ? row.actionTendency : "";
    const currentAction = typeof row.currentAction === "string" ? row.currentAction : "";
    const topic = clipText(actionTendency.length > 0 ? actionTendency : currentAction, ATLAS_SIMULATION_LIMITS.topicChars);
    if (topic.length === 0 && targetLocationId === null) continue;
    const kind: AtlasSimulationKind = targetLocationId !== null && targetLocationId !== locationId ? "travel" : "intent";
    const taskId = simulationTaskId({
      chatId: input.chatId, branchKey: input.branchKey, turnKey: input.turnKey,
      actorCharacterId: edit.ref, kind, sequence,
    });
    sequence += 1;
    // 同一 turnKey 重放：ID 相同即视为已处理，零新增
    if (branch.tasks.some((existing) => existing.id === taskId)) continue;
    if (branch.tasks.length >= ATLAS_SIMULATION_LIMITS.tasks) {
      diagnostics.push({ code: "LIMIT_REACHED", path: "$.simulation.branches." + input.branchKey + ".tasks" });
      continue;
    }
    const task: AtlasSimulationTask = {
      id: taskId,
      kind,
      // 没有时间进展 → 只记录意图，绝不推进
      status: noTime ? "queued" : "active",
      actorCharacterId: edit.ref,
      originLocationId: locationId,
      targetLocationId,
      topic,
      signalId: null,
      visibility: "known",
      source: "character-intent",
      createdTurnKey: input.turnKey,
      lastAppliedTurnKey: input.turnKey,
      createdPeriod: input.period,
      nextEligiblePeriod: noTime ? null : input.period,
      reasonCode: noTime ? "NO_TIME" : null,
    };
    branch.tasks.push(task);
    undo.push({ collection: "tasks", id: taskId, before: null });
    createdThisTurn.add(taskId);
    pushEvent({
      simulationId: taskId, kind: task.kind, actorCharacterId: task.actorCharacterId,
      fromLocationId: task.originLocationId, toLocationId: task.targetLocationId,
      status: "intent-recorded", reasonCode: task.reasonCode,
      summary: taskSummary(task, "intent-recorded"), visibility: task.visibility, period: input.period,
    });
  }

  /* ---- 3) 日程 / 后台移动结果 ---- */
  for (const move of input.moves ?? []) {
    const existing = branch.tasks.find((task) =>
      task.actorCharacterId === move.actorCharacterId && task.kind === "travel");
    const taskId = existing?.id ?? simulationTaskId({
      chatId: input.chatId, branchKey: input.branchKey, turnKey: input.turnKey,
      actorCharacterId: move.actorCharacterId, kind: "travel", sequence: 900 + sequence,
    });
    sequence += 1;
    if (!existing) {
      if (branch.tasks.length >= ATLAS_SIMULATION_LIMITS.tasks) {
        diagnostics.push({ code: "LIMIT_REACHED", path: "$.simulation.branches." + input.branchKey + ".tasks" });
        continue;
      }
      const created: AtlasSimulationTask = {
        id: taskId, kind: "travel", status: "active",
        actorCharacterId: move.actorCharacterId,
        originLocationId: move.fromLocationId, targetLocationId: move.toLocationId,
        topic: "", signalId: null, visibility: move.visibility ?? "known",
        // 日程与后台自主行动都记为 travel 任务，来源不同以便 UI 区分
        source: move.kind === "schedule" ? "schedule" : "engine",
        createdTurnKey: input.turnKey, lastAppliedTurnKey: input.turnKey,
        createdPeriod: input.period, nextEligiblePeriod: input.period, reasonCode: null,
      };
      branch.tasks.push(created);
      undo.push({ collection: "tasks", id: taskId, before: null });
      createdThisTurn.add(taskId);
    }
    const task = branch.tasks.find((row) => row.id === taskId)!;
    const snapshot = JSON.parse(JSON.stringify(task)) as AtlasSimulationTask;
    const previousStatus = task.status;
    const previousReason = task.reasonCode;
    if (move.arrived && !noTime) {
      task.status = "resolved";
      task.reasonCode = null;
      task.targetLocationId = move.toLocationId ?? task.targetLocationId;
      task.lastAppliedTurnKey = input.turnKey;
      task.nextEligiblePeriod = input.period;
    } else if (noTime) {
      // 时间未推进：既不能算在途位移，也不能伪造抵达
      task.status = "queued";
      task.reasonCode = "NO_TIME";
    } else {
      task.status = "blocked";
      task.reasonCode = move.reasonCode ?? "NO_PATH";
    }
    if (task.status !== previousStatus || task.reasonCode !== previousReason) {
      // 本轮刚建的行已有 `before: null` 逆操作，不再重复记录
      if (!createdThisTurn.has(taskId)) {
        undo.push({ collection: "tasks", id: taskId, before: snapshot });
      }
      // 时间没推进时只说明「暂不能行动」，绝不写「已在路上 / 已抵达」
      const status: AtlasSimulationEventStatus =
        task.status === "resolved" ? "arrived"
          : task.status === "blocked" || task.status === "queued" ? "blocked"
            : "progressed";
      const kindForEvent: AtlasSimulationKind = task.kind;
      pushEvent({
        simulationId: taskId, kind: kindForEvent, actorCharacterId: task.actorCharacterId,
        fromLocationId: move.fromLocationId, toLocationId: move.toLocationId,
        status, reasonCode: task.reasonCode,
        summary: taskSummary(task, status), visibility: task.visibility, period: input.period,
      });
    }
  }

  /* ---- 4) 终态归档后的回收：只在事件已进回合记录之后清理 ---- */
  const reclaimed: AtlasSimulationTask[] = [];
  for (let index = 0; index < branch.tasks.length; index += 1) {
    const task = branch.tasks[index]!;
    if (!isTerminalSimulationStatus(task.status)) continue;
    // 本轮刚变终态的任务保留到事件归档之后；上一轮之前终态的（lastAppliedTurnKey 不同）才回收
    if (task.lastAppliedTurnKey === input.turnKey) continue;
    reclaimed.push(task);
  }
  if (reclaimed.length > 0) {
    const reclaimedIds = new Set(reclaimed.map((task) => task.id));
    branch.tasks = branch.tasks.filter((task) => !reclaimedIds.has(task.id));
    for (const task of reclaimed) {
      // before 记录被回收的行，供 C10 回退时精确恢复
      undo.push({ collection: "tasks", id: task.id, before: task });
    }
  }

  /* ---- 5) 未送达消息留队列；队列满明确报 LIMIT_REACHED ---- */
  for (const signal of branch.signals) {
    if (signal.status !== "active") continue;
    const delivered = branch.deliveries.some((delivery) => delivery.signalId === signal.id);
    if (!delivered) {
      diagnostics.push({
        code: "SIGNAL_PENDING",
        path: "$.simulation.branches." + input.branchKey + ".signals",
        detail: signal.id,
      });
    }
  }

  /* ---- 6) 一轮事件上限：显式报告，不静默丢弃 ---- */
  const limit = ATLAS_SIMULATION_LIMITS.eventsPerTurn;
  const eventsTruncated = rawEvents.length > limit;
  const droppedEventCount = eventsTruncated ? rawEvents.length - limit : 0;
  const events = eventsTruncated ? rawEvents.slice(0, limit) : rawEvents;
  if (eventsTruncated) {
    diagnostics.push({
      code: "SIMULATION_EVENT_LIMIT",
      path: "$.simulation.events",
      detail: String(rawEvents.length),
    });
  }

  return { next, events, undo, diagnostics, eventsTruncated, droppedEventCount };
}

/* ------------------------------------------------------------------ *
 * 旧稿兼容：`rows` → `tasks` 的一次显式迁移（§2.1）
 * ------------------------------------------------------------------ */

export interface AtlasLegacySimulationMigration {
  store: AtlasSimulationStore;
  migrated: number;
  skipped: number;
}

/**
 * §2.1 明确要求：如果曾按本计划**旧稿**试做过 `rows`，必须先做显式 `rows`→`tasks` 一次迁移，
 * **不允许把已有行清空**。本函数只认领旧稿形状，识别不出就原样返回空模块并由调用方保留原文。
 */
export function migrateLegacySimulationRows(raw: unknown, worldId: string): AtlasLegacySimulationMigration {
  const store = createEmptySimulation(worldId);
  let migrated = 0;
  let skipped = 0;
  if (!isRecord(raw) || !isRecord(raw.branches)) return { store, migrated, skipped };
  for (const [branchKey, value] of Object.entries(raw.branches)) {
    if (!isRecord(value) || !Array.isArray(value.rows)) continue;
    const branch = branchOf(store, branchKey);
    for (const row of value.rows) {
      if (!isRecord(row) || typeof row.id !== "string") { skipped += 1; continue; }
      const kind = KINDS.includes(row.kind as AtlasSimulationKind) ? row.kind as AtlasSimulationKind : "intent";
      const status = STATUSES.includes(row.status as AtlasSimulationStatus)
        ? row.status as AtlasSimulationStatus : "queued";
      branch.tasks.push({
        id: row.id,
        kind,
        status,
        actorCharacterId: typeof row.actorCharacterId === "string" ? row.actorCharacterId : null,
        originLocationId: typeof row.originLocationId === "string" ? row.originLocationId : null,
        targetLocationId: typeof row.targetLocationId === "string" ? row.targetLocationId : null,
        topic: typeof row.topic === "string" ? clipText(row.topic, ATLAS_SIMULATION_LIMITS.topicChars) : "",
        signalId: null,
        visibility: row.visibility === "hidden" ? "hidden" : "known",
        source: SOURCES.includes(row.source as AtlasSimulationSource)
          ? row.source as AtlasSimulationSource : "engine",
        createdTurnKey: typeof row.createdTurnKey === "string" ? row.createdTurnKey : "legacy",
        lastAppliedTurnKey: typeof row.lastAppliedTurnKey === "string" ? row.lastAppliedTurnKey : null,
        createdPeriod: isFiniteNumber(row.createdPeriod) ? row.createdPeriod : 0,
        nextEligiblePeriod: isFiniteNumber(row.nextEligiblePeriod) ? row.nextEligiblePeriod : null,
        reasonCode: typeof row.reasonCode === "string" ? row.reasonCode : null,
      });
      migrated += 1;
    }
  }
  return { store, migrated, skipped };
}
