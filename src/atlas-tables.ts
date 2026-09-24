/**
 * atlas-tables.ts — 三表（地点 / 人物 / 物品）纯数据层：固定行类型、统一上限、校验、深拷贝与变更函数。
 *
 * 依据《Atlas 三表迁移、推进协议替换和地图接线执行计划》§1「固定存储契约」与 A01 / A02 / B01–B04：
 * - 三表是**实体现值的唯一权威**；`world.points / characterStates / entityRecords` 只是供现有
 *   世界引擎使用的兼容镜像（镜像由 A04 生成，本模块不碰 `world`，也不写任何存储）。
 * - 本模块零副作用、零 IO：不读 store、不调模型、不改会话文档。
 * - 位置一律是**零起始网格格序号**（`gridX / gridY`），不是画布坐标。旧 `world.points[].x/y`
 *   必须经 frame / cellPx 换算后才能进来（属 A04 / E 段职责），不允许直接塞格序号。
 * - 契约里的 `Position` 在本模块命名为 `AtlasTablePosition`：字段与语义逐字照抄，
 *   只避免在共享命名空间里占用过于通用的类型名。
 */

import { SUBMAP_DEPTH_MAX } from "./atlas-geo-apply.ts";

/** 位置：`mapId` 是所在子图的宿主（根地点恒为 "world"；子地点为其父地点 id），格序号从 0 起。 */
export interface AtlasTablePosition {
  mapId: string | null;
  gridX: number | null;
  gridY: number | null;
}

export type AtlasCharacterPresence = "present" | "left" | "unknown";
export type AtlasCharacterPositionSource = "narrative" | "simulation" | "manual" | "routine" | "unknown";

/** 地点行：`parentLocationId` 是上级地点（用它派生子图，不另存 children 数组）。 */
export interface AtlasLocationRow extends AtlasTablePosition {
  id: string;
  name: string;
  parentLocationId: string | null;
  description: string;
  rumors: string[];
  factions: string[];
}

/** 人物行：名称 / 想法 / 行动倾向 / 当前位置各自独立字段。 */
export interface AtlasCharacterRow extends AtlasTablePosition {
  id: string;
  name: string;
  locationId: string | null;
  thought: string;
  actionTendency: string;
  currentAction: string;
  targetLocationId: string | null;
  presence: AtlasCharacterPresence;
  positionSource: AtlasCharacterPositionSource;
}

/** 物品行：由人物持有时 `holderCharacterId` 有值、`locationId = null` 且坐标置空。 */
export interface AtlasItemRow extends AtlasTablePosition {
  id: string;
  name: string;
  description: string;
  locationId: string | null;
  holderCharacterId: string | null;
  status: string;
}

export interface AtlasThreeTablesV1 {
  locations: AtlasLocationRow[];
  characters: AtlasCharacterRow[];
  items: AtlasItemRow[];
}

/** `chatMetadata.atlas` 里新增的可选 `tables`：按分支存快照，`worldId` 必须等于会话绑定的世界。 */
export interface AtlasTablesStoreV1 {
  schemaVersion: 1;
  worldId: string;
  branches: Record<string, AtlasThreeTablesV1>;
}

/**
 * 行数 / 文本 / 数组上限：**唯一权威**，禁止在别处再抄一份数字（§1「上限通过常量统一管理」）。
 * 各业务上限（如 B01 的子图深度）继续沿用既有常量，不在此重复定义。
 */
export const ATLAS_TABLE_LIMITS = {
  locations: 1000,
  characters: 2000,
  items: 5000,
  /** 每行文本字段上限（字）：按 UTF-16 长度计，与仓库既有口径一致。 */
  textChars: 500,
  /** 行内数组（`rumors` / `factions`）的元素个数上限。 */
  listItems: 20,
  /** 行 id 长度上限：与 lib 的 maxSourceLabel 同口径，便于镜像投影不被截断。 */
  idChars: 120,
} as const;

export const ATLAS_CHARACTER_PRESENCES: readonly AtlasCharacterPresence[] = ["present", "left", "unknown"];
export const ATLAS_CHARACTER_POSITION_SOURCES: readonly AtlasCharacterPositionSource[] =
  ["narrative", "simulation", "manual", "routine", "unknown"];

/**
 * 校验错误码：只描述**结构性事实**，中文文案由调用方（回执 / 日志）自行映射，
 * 避免把措辞散落在数据层里重写。
 */
export type AtlasTableErrorCode =
  | "STORE_NOT_OBJECT"
  | "STORE_SCHEMA_VERSION"
  | "WORLD_ID_MISSING"
  | "CROSS_WORLD"
  | "BRANCH_NOT_OBJECT"
  | "TABLE_NOT_ARRAY"
  | "ROWS_EXCEEDED"
  | "ROW_NOT_OBJECT"
  | "FIELD_MISSING"
  | "FIELD_TYPE"
  | "TEXT_TOO_LONG"
  | "NAME_REQUIRED"
  | "ID_MISSING"
  | "ID_TOO_LONG"
  | "DUPLICATE_ID"
  | "GRID_PARTIAL"
  | "GRID_INVALID"
  | "MAP_ID_MISMATCH"
  | "MAP_ID_UNKNOWN"
  | "PARENT_MISSING"
  | "PARENT_CYCLE"
  | "REF_MISSING"
  | "HOLDER_AND_LOCATION"
  | "HELD_ITEM_GRID"
  | "PRESENCE_INVALID"
  | "POSITION_SOURCE_INVALID"
  | "LIST_TOO_LONG"
  | "LIST_ITEM_INVALID";

export interface AtlasTableError {
  path: string;
  code: AtlasTableErrorCode;
}

export type AtlasTableValidation =
  | { ok: true; errors: [] }
  | { ok: false; errors: AtlasTableError[] };

export interface AtlasTablesStoreValidationOptions {
  /** 会话绑定的世界 ID；传入即执行「跨世界」检查。 */
  expectedWorldId?: string;
}

/* ------------------------------------------------------------------ *
 * 内部工具（纯函数，不导出）
 * ------------------------------------------------------------------ */

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStr(value: unknown): value is string {
  return typeof value === "string";
}

function has(row: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, key);
}

function isGridIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/** 表名 → 行数上限，供 A01 校验与 B 段复用同一份数字。 */
const TABLE_CAPS = {
  locations: ATLAS_TABLE_LIMITS.locations,
  characters: ATLAS_TABLE_LIMITS.characters,
  items: ATLAS_TABLE_LIMITS.items,
} as const;

class Errors {
  list: AtlasTableError[] = [];
  push(path: string, code: AtlasTableErrorCode): void {
    this.list.push({ path, code });
  }
}

/** 文本字段：必须存在、必须是字符串、不得超长（空字符串合法，命名另有要求）。 */
function checkText(
  row: Record<string, unknown>,
  key: string,
  path: string,
  err: Errors,
  options: { required?: boolean } = {},
): void {
  const value = row[key];
  if (value === undefined) {
    if (options.required !== false) err.push(`${path}.${key}`, "FIELD_MISSING");
    return;
  }
  if (!isStr(value)) {
    err.push(`${path}.${key}`, "FIELD_TYPE");
    return;
  }
  if (value.length > ATLAS_TABLE_LIMITS.textChars) err.push(`${path}.${key}`, "TEXT_TOO_LONG");
}

/** 可空 id 字段：存在时必须为 null 或非空字符串（超长交给 id 规则统一处理）。 */
function checkNullableId(row: Record<string, unknown>, key: string, path: string, err: Errors): string | null {
  const value = row[key];
  if (value === undefined) {
    err.push(`${path}.${key}`, "FIELD_MISSING");
    return null;
  }
  if (value === null) return null;
  if (!isStr(value)) {
    err.push(`${path}.${key}`, "FIELD_TYPE");
    return null;
  }
  if (value.length === 0) {
    err.push(`${path}.${key}`, "ID_MISSING");
    return null;
  }
  if (value.length > ATLAS_TABLE_LIMITS.idChars) err.push(`${path}.${key}`, "ID_TOO_LONG");
  return value;
}

/** 行 id：必填、非空、有长度上限。返回可用于查重的值（非法时返回 null）。 */
function checkRowId(row: Record<string, unknown>, path: string, err: Errors): string | null {
  const value = row.id;
  if (value === undefined) {
    err.push(`${path}.id`, "FIELD_MISSING");
    return null;
  }
  if (!isStr(value)) {
    err.push(`${path}.id`, "FIELD_TYPE");
    return null;
  }
  if (value.length === 0) {
    err.push(`${path}.id`, "ID_MISSING");
    return null;
  }
  if (value.length > ATLAS_TABLE_LIMITS.idChars) err.push(`${path}.id`, "ID_TOO_LONG");
  return value;
}

/** 行名：必填、非空（名称可重名，但不允许没有名字）。 */
function checkName(row: Record<string, unknown>, path: string, err: Errors): void {
  const value = row.name;
  if (value === undefined) {
    err.push(`${path}.name`, "FIELD_MISSING");
    return;
  }
  if (!isStr(value)) {
    err.push(`${path}.name`, "FIELD_TYPE");
    return;
  }
  if (value.length === 0) err.push(`${path}.name`, "NAME_REQUIRED");
  else if (value.length > ATLAS_TABLE_LIMITS.textChars) err.push(`${path}.name`, "TEXT_TOO_LONG");
}

/** 位置三字段：都为空，或都是有限非负整数格序号（§1）。 */
function checkPosition(row: Record<string, unknown>, path: string, err: Errors): void {
  const mapId = row.mapId;
  if (mapId === undefined) err.push(`${path}.mapId`, "FIELD_MISSING");
  else if (mapId !== null && !isStr(mapId)) err.push(`${path}.mapId`, "FIELD_TYPE");
  else if (isStr(mapId) && mapId.length === 0) err.push(`${path}.mapId`, "ID_MISSING");

  const gridX = row.gridX;
  const gridY = row.gridY;
  if (gridX === undefined) err.push(`${path}.gridX`, "FIELD_MISSING");
  if (gridY === undefined) err.push(`${path}.gridY`, "FIELD_MISSING");
  if (gridX === undefined || gridY === undefined) return;

  const xNull = gridX === null;
  const yNull = gridY === null;
  if (xNull !== yNull) {
    err.push(`${path}.gridX`, "GRID_PARTIAL");
    return;
  }
  if (xNull && yNull) return;
  if (!isGridIndex(gridX)) err.push(`${path}.gridX`, "GRID_INVALID");
  if (!isGridIndex(gridY)) err.push(`${path}.gridY`, "GRID_INVALID");
}

/** 行内字符串数组：必须存在、必须是数组、条数与单条长度都受限。 */
function checkStringList(row: Record<string, unknown>, key: string, path: string, err: Errors): void {
  const value = row[key];
  if (value === undefined) {
    err.push(`${path}.${key}`, "FIELD_MISSING");
    return;
  }
  if (!Array.isArray(value)) {
    err.push(`${path}.${key}`, "FIELD_TYPE");
    return;
  }
  if (value.length > ATLAS_TABLE_LIMITS.listItems) err.push(`${path}.${key}`, "LIST_TOO_LONG");
  value.forEach((item, index) => {
    if (!isStr(item) || item.length === 0 || item.length > ATLAS_TABLE_LIMITS.textChars) {
      err.push(`${path}.${key}[${index}]`, "LIST_ITEM_INVALID");
    }
  });
}

function asRowArray(value: unknown, path: string, cap: number, err: Errors): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    err.push(path, "TABLE_NOT_ARRAY");
    return [];
  }
  if (value.length > cap) err.push(path, "ROWS_EXCEEDED");
  const rows: Array<Record<string, unknown>> = [];
  value.forEach((item, index) => {
    if (!isObj(item)) {
      err.push(`${path}[${index}]`, "ROW_NOT_OBJECT");
      return;
    }
    rows.push(item);
  });
  return rows;
}

/** 父链成环检测：沿 parentLocationId 上溯，步数超过地点总数即判定成环。 */
function markParentCycles(
  locations: Array<{ id: string; parent: string | null; index: number }>,
  err: Errors,
): void {
  const parentOf = new Map<string, string>();
  for (const item of locations) if (item.parent !== null) parentOf.set(item.id, item.parent);
  const indexOf = new Map<string, number>();
  for (const item of locations) indexOf.set(item.id, item.index);
  for (const item of locations) {
    const seen = new Set<string>([item.id]);
    let cursor = parentOf.get(item.id);
    let hops = 0;
    while (cursor !== undefined && hops <= parentOf.size) {
      if (seen.has(cursor)) {
        err.push(`$.locations[${item.index}].parentLocationId`, "PARENT_CYCLE");
        break;
      }
      seen.add(cursor);
      cursor = parentOf.get(cursor);
      hops += 1;
    }
  }
}

/* ------------------------------------------------------------------ *
 * A01：校验
 * ------------------------------------------------------------------ */

/**
 * 校验一个分支的三表快照（纯函数，不改输入）。
 *
 * 覆盖 §1 点名的禁止项：字段缺失 / 类型错 / 超长、NaN 与非整数格序号、格序号只填一半、
 * 父地点不存在或成环、地点 mapId 与父不符、人物与物品的悬空引用、
 * 物品同时有持有人与地点、持有物坐标未置空、重复 id、行数或数组超限。
 *
 * 行本身不带世界标识，因此「跨世界 ID」的可执行口径是**快照的 worldId 必须等于会话绑定的
 * 世界**，在 `validateAtlasTablesStore` 里执行。
 */
export function validateAtlasTables(tables: unknown): AtlasTableValidation {
  const err = new Errors();
  if (!isObj(tables)) {
    return { ok: false, errors: [{ path: "$", code: "STORE_NOT_OBJECT" }] };
  }

  const locations = asRowArray(tables.locations, "$.locations", TABLE_CAPS.locations, err);
  const characters = asRowArray(tables.characters, "$.characters", TABLE_CAPS.characters, err);
  const items = asRowArray(tables.items, "$.items", TABLE_CAPS.items, err);

  // --- 地点 ---
  const locationIdSet = new Set<string>();
  const locationParents: Array<{ id: string; parent: string | null; index: number }> = [];
  locations.forEach((row, index) => {
    const path = `$.locations[${index}]`;
    const id = checkRowId(row, path, err);
    if (id !== null) {
      if (locationIdSet.has(id)) err.push(`${path}.id`, "DUPLICATE_ID");
      locationIdSet.add(id);
    }
    checkName(row, path, err);
    checkText(row, "description", path, err);
    checkStringList(row, "rumors", path, err);
    checkStringList(row, "factions", path, err);
    checkPosition(row, path, err);
    if (!has(row, "parentLocationId")) {
      err.push(`${path}.parentLocationId`, "FIELD_MISSING");
    } else if (row.parentLocationId !== null && !isStr(row.parentLocationId)) {
      err.push(`${path}.parentLocationId`, "FIELD_TYPE");
    }
    const parent = isStr(row.parentLocationId) ? row.parentLocationId : null;
    if (id !== null) locationParents.push({ id, parent, index });
  });

  // 父存在性 + 成环 + mapId 与父一致（根地点恒为 "world"）
  for (const entry of locationParents) {
    const path = `$.locations[${entry.index}].parentLocationId`;
    if (entry.parent !== null) {
      if (!locationIdSet.has(entry.parent)) {
        err.push(path, "PARENT_MISSING");
        continue;
      }
      const row = locations[entry.index]!;
      if (isStr(row.mapId) && row.mapId !== entry.parent) {
        err.push(`$.locations[${entry.index}].mapId`, "MAP_ID_MISMATCH");
      }
      continue;
    }
    const row = locations[entry.index]!;
    if (isStr(row.mapId) && row.mapId !== "world") {
      err.push(`$.locations[${entry.index}].mapId`, "MAP_ID_MISMATCH");
    }
  }
  markParentCycles(locationParents, err);

  // --- 人物 ---
  const characterIdSet = new Set<string>();
  characters.forEach((row, index) => {
    const path = `$.characters[${index}]`;
    const id = checkRowId(row, path, err);
    if (id !== null) {
      if (characterIdSet.has(id)) err.push(`${path}.id`, "DUPLICATE_ID");
      characterIdSet.add(id);
    }
    checkName(row, path, err);
    checkText(row, "thought", path, err);
    checkText(row, "actionTendency", path, err);
    checkText(row, "currentAction", path, err);
    checkPosition(row, path, err);
    checkNullableId(row, "locationId", path, err);
    checkNullableId(row, "targetLocationId", path, err);
    const presence = row.presence;
    if (presence === undefined) err.push(`${path}.presence`, "FIELD_MISSING");
    else if (!isStr(presence) || !ATLAS_CHARACTER_PRESENCES.includes(presence as AtlasCharacterPresence)) {
      err.push(`${path}.presence`, "PRESENCE_INVALID");
    }
    const source = row.positionSource;
    if (source === undefined) err.push(`${path}.positionSource`, "FIELD_MISSING");
    else if (!isStr(source) || !ATLAS_CHARACTER_POSITION_SOURCES.includes(source as AtlasCharacterPositionSource)) {
      err.push(`${path}.positionSource`, "POSITION_SOURCE_INVALID");
    }
  });

  // --- 物品 ---
  const itemIdSet = new Set<string>();
  items.forEach((row, index) => {
    const path = `$.items[${index}]`;
    const id = checkRowId(row, path, err);
    if (id !== null) {
      if (itemIdSet.has(id)) err.push(`${path}.id`, "DUPLICATE_ID");
      itemIdSet.add(id);
    }
    checkName(row, path, err);
    checkText(row, "description", path, err);
    checkText(row, "status", path, err);
    checkPosition(row, path, err);
    const locationId = checkNullableId(row, "locationId", path, err);
    const holderId = checkNullableId(row, "holderCharacterId", path, err);
    if (locationId !== null && holderId !== null) {
      err.push(`${path}.holderCharacterId`, "HOLDER_AND_LOCATION");
    }
    if (holderId !== null && (row.gridX !== null || row.gridY !== null)) {
      err.push(`${path}.gridX`, "HELD_ITEM_GRID");
    }
  });

  // --- 悬空引用（人物/物品 → 地点、物品 → 人物；人物/物品的 mapId 必须是 world 或已知地点）---
  characters.forEach((row, index) => {
    const path = `$.characters[${index}]`;
    const locationId = isStr(row.locationId) ? row.locationId : null;
    if (locationId !== null && !locationIdSet.has(locationId)) {
      err.push(`${path}.locationId`, "REF_MISSING");
    }
    const target = isStr(row.targetLocationId) ? row.targetLocationId : null;
    if (target !== null && !locationIdSet.has(target)) {
      err.push(`${path}.targetLocationId`, "REF_MISSING");
    }
    if (isStr(row.mapId) && row.mapId !== "world" && !locationIdSet.has(row.mapId)) {
      err.push(`${path}.mapId`, "MAP_ID_UNKNOWN");
    }
  });
  items.forEach((row, index) => {
    const path = `$.items[${index}]`;
    const locationId = isStr(row.locationId) ? row.locationId : null;
    if (locationId !== null && !locationIdSet.has(locationId)) {
      err.push(`${path}.locationId`, "REF_MISSING");
    }
    const holder = isStr(row.holderCharacterId) ? row.holderCharacterId : null;
    if (holder !== null && !characterIdSet.has(holder)) {
      err.push(`${path}.holderCharacterId`, "REF_MISSING");
    }
    if (isStr(row.mapId) && row.mapId !== "world" && !locationIdSet.has(row.mapId)) {
      err.push(`${path}.mapId`, "MAP_ID_UNKNOWN");
    }
  });

  return err.list.length === 0 ? { ok: true, errors: [] } : { ok: false, errors: err.list };
}

/**
 * 校验整份 `tables` 存储：外壳（schemaVersion / worldId / branches）+ 每个分支的三表。
 * `expectedWorldId` 传入时执行「跨世界」检查——快照 worldId 与会话绑定的世界不一致即拒绝。
 */
export function validateAtlasTablesStore(
  store: unknown,
  options: AtlasTablesStoreValidationOptions = {},
): AtlasTableValidation {
  const err = new Errors();
  if (!isObj(store)) {
    return { ok: false, errors: [{ path: "$", code: "STORE_NOT_OBJECT" }] };
  }
  if (store.schemaVersion !== 1) err.push("$.schemaVersion", "STORE_SCHEMA_VERSION");
  const worldId = isStr(store.worldId) ? store.worldId : "";
  if (worldId.length === 0) err.push("$.worldId", "WORLD_ID_MISSING");
  else if (worldId.length > ATLAS_TABLE_LIMITS.idChars) err.push("$.worldId", "ID_TOO_LONG");
  if (options.expectedWorldId !== undefined && worldId !== options.expectedWorldId) {
    err.push("$.worldId", "CROSS_WORLD");
  }
  const branches = store.branches;
  if (!isObj(branches)) {
    err.push("$.branches", "BRANCH_NOT_OBJECT");
    return { ok: false, errors: err.list };
  }
  for (const [branchId, tables] of Object.entries(branches)) {
    const prefix = `$.branches["${branchId}"]`;
    if (!isObj(tables)) {
      err.push(prefix, "BRANCH_NOT_OBJECT");
      continue;
    }
    const result = validateAtlasTables(tables);
    if (!result.ok) {
      for (const item of result.errors) {
        // 行级错误路径的根 `$` 换成该分支前缀，保证回执能定位到具体分支
        err.push(item.path === "$" ? prefix : prefix + item.path.slice(1), item.code);
      }
    }
  }
  return err.list.length === 0 ? { ok: true, errors: [] } : { ok: false, errors: err.list };
}

/* ------------------------------------------------------------------ *
 * 行 id 方案（A03 / A04 / B04 共用的唯一权威）
 * ------------------------------------------------------------------ */

/**
 * 行 id 一律带类型前缀，且**对旧世界可逆**：
 * - 地点 `loc:<world.points[].id 数字>`——数字段是与 `world.points` 互转的桥（A04 反解）；
 * - 人物 `npc:<world.characters[].id 原文>`；
 * - 物品 `item:<world.entityRecords[].id 原文>`。
 * 迁移（A03）与新增分配（B04）都走这三个函数，禁止在各处手拼前缀。
 */
export function locationRowId(pointId: number | string): string {
  return `loc:${String(pointId).trim()}`;
}

/** 地点行 id → 旧世界数字点 id；不是本方案生成的行返回 null。 */
export function pointIdFromLocationRowId(rowId: string): number | null {
  const matched = /^loc:(\d{1,15})$/.exec(rowId);
  if (!matched) return null;
  const value = Number(matched[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function characterRowId(characterId: string): string {
  return `npc:${String(characterId).trim()}`;
}

export function characterIdFromRowId(rowId: string): string | null {
  return rowId.startsWith("npc:") && rowId.length > 4 ? rowId.slice(4) : null;
}

export function itemRowId(entityId: string): string {
  return `item:${String(entityId).trim()}`;
}

export function entityIdFromItemRowId(rowId: string): string | null {
  return rowId.startsWith("item:") && rowId.length > 5 ? rowId.slice(5) : null;
}

/* ------------------------------------------------------------------ *
 * B01–B04：编辑操作、引用解析与三表变更函数
 *
 * 数据流（计划 §2 + §3-B）：
 *   B05 `parseAtlasEditBlock` 解析出逐行 `AtlasTableEdit`（含行号、quote、basis）
 *   → B04 `resolveTableRef` / `allocateTableRowId` 把引用解析成候选表里的正式行 id
 *   → B01/B02/B03 各自的 `applyXxxEdit` 依源顺序改**候选副本**
 *   → B06 用 `validateAtlasTables` 复核整份候选，不通过则整轮回退。
 *
 * 纪律：
 * - AI 永远不能直接写 id / mapId / 格序号 / 时间 / 比例尺：这些字段只能由本模块推导。
 * - 引用只有两种合法形态：候选表里的正式行 id，或**本块内**已声明的 `new:*` 临时引用；
 *   名称不是 id（同父同名只用于提示歧义，不做解析、不按名字全局合并）。
 * - 失败不占号：正式 id 一律在「确定要写入」时才分配，且分配是候选表的纯函数
 *   （同一候选 + 同一临时引用 → 同一 id），因此失败行既不留号也不会复用到旧行身份。
 * ------------------------------------------------------------------ */

export type AtlasEditOp = "add" | "set" | "remove";
export type AtlasEditBasis = "observed" | "inferred";

export interface AtlasEditCommon {
  /** 协议块内行号（1 起）：B05 解析时填入，逐行回执靠它定位。 */
  line?: number;
  /** 证据来源（`msg:u` / `msg:a`）：B05 依引文命中位置决定，模型不需要也不能编。 */
  sourceId?: string;
  /** 证据：助手/用户正文里的连续原文片段；`basis="observed"` 的位置与归属改动必须有。 */
  quote?: string;
  basis?: AtlasEditBasis;
}

/** 地点行内的父引用槽位（`patch.parentRef` 与顶层 `parentRef` 同义）。 */
export interface AtlasLocationPatch {
  name?: string;
  description?: string;
  parentRef?: string | null;
  rumors?: string[];
  factions?: string[];
}

export interface AtlasLocationEdit extends AtlasEditCommon {
  table: "location";
  op: AtlasEditOp;
  /** add：本块局部临时引用 `new:loc:*`；set/remove：正式行 id 或本块已声明的临时引用。 */
  ref: string;
  name?: string;
  description?: string;
  parentRef?: string | null;
  rumors?: string[];
  factions?: string[];
  patch?: AtlasLocationPatch;
}

export interface AtlasCharacterPatch {
  name?: string;
  locationRef?: string | null;
  thought?: string;
  actionTendency?: string;
  currentAction?: string;
  targetLocationRef?: string | null;
  presence?: AtlasCharacterPresence;
}

export interface AtlasCharacterEdit extends AtlasEditCommon {
  table: "character";
  op: AtlasEditOp;
  ref: string;
  name?: string;
  locationRef?: string | null;
  thought?: string;
  actionTendency?: string;
  currentAction?: string;
  targetLocationRef?: string | null;
  presence?: AtlasCharacterPresence;
  patch?: AtlasCharacterPatch;
}

export interface AtlasItemPatch {
  name?: string;
  description?: string;
  status?: string;
  locationRef?: string | null;
  holderRef?: string | null;
}

export interface AtlasItemEdit extends AtlasEditCommon {
  table: "item";
  op: AtlasEditOp;
  ref: string;
  name?: string;
  description?: string;
  status?: string;
  locationRef?: string | null;
  holderRef?: string | null;
  patch?: AtlasItemPatch;
}

export type AtlasTableEdit = AtlasLocationEdit | AtlasCharacterEdit | AtlasItemEdit;

export type AtlasTableEditErrorCode =
  | "EDIT_NOT_OBJECT"
  | "EDIT_TABLE_INVALID"
  | "EDIT_OP_INVALID"
  | "NAME_REQUIRED"
  | "TEXT_TOO_LONG"
  | "LIST_TOO_LONG"
  | "FIELD_TYPE"
  | "PRESENCE_INVALID"
  | "REF_INVALID"
  | "REF_UNKNOWN"
  | "REF_TYPE_MISMATCH"
  | "ROW_NOT_FOUND"
  | "DUPLICATE_SIBLING_NAME"
  | "PARENT_CYCLE"
  | "PARENT_DEPTH_EXCEEDED"
  | "HAS_CHILDREN"
  | "HOLDER_AND_LOCATION"
  | "PROTAGONIST_PROTECTED"
  | "ROW_LIMIT_EXCEEDED";

export interface AtlasTableEditError {
  code: AtlasTableEditErrorCode;
  path: string;
  /** 相关引用（回执里能直接指出是哪一行引用了什么）。 */
  ref?: string;
}

export type AtlasTableEditResult =
  | { ok: true; id: string; op: AtlasEditOp; created: boolean }
  | { ok: false; error: AtlasTableEditError };

export interface AtlasTableEditOptions {
  /** 主人公等**不可被模型改写身份**的人物行 id（由调用方依据 world.characters[].role 给出）。 */
  protectedCharacterIds?: ReadonlySet<string>;
  /** 地点父链深度上限（沿 parent 上溯的跳数）；缺省沿用地图侧 SUBMAP_DEPTH_MAX。 */
  maxLocationDepth?: number;
}

/** 物品「软删除」状态：remove 不删行，只清归属并标记销毁（§2「默认软删除」）。 */
export const ATLAS_ITEM_DESTROYED_STATUS = "已销毁";

const REF_PATTERNS: Record<AtlasRefKind, RegExp> = {
  location: /^new:loc:[a-z0-9_-]{1,40}$/,
  character: /^new:npc:[a-z0-9_-]{1,40}$/,
  item: /^new:item:[a-z0-9_-]{1,40}$/,
};

export type AtlasRefKind = "location" | "character" | "item";

const ROW_PREFIX: Record<AtlasRefKind, string> = { location: "loc:", character: "npc:", item: "item:" };

/** B04：本块局部的临时引用表——作用域只在当前 `parseAtlasEditBlock` 的一次结果里。 */
export interface AtlasTableRefScope {
  locations: Map<string, string>;
  characters: Map<string, string>;
  items: Map<string, string>;
}

export function createAtlasRefScope(): AtlasTableRefScope {
  return { locations: new Map(), characters: new Map(), items: new Map() };
}

/** 记录「本块临时引用 → 正式行 id」；重复声明同一临时引用视为协议错误。 */
export function declareAtlasRef(
  scope: AtlasTableRefScope,
  kind: AtlasRefKind,
  tempRef: string,
  id: string,
): AtlasTableEditResult {
  const bucket = scope[REF_BUCKET[kind]];
  if (bucket.has(tempRef)) {
    return { ok: false, error: { code: "REF_INVALID", path: `$.ref`, ref: tempRef } };
  }
  bucket.set(tempRef, id);
  return { ok: true, id, op: "add", created: true };
}

const REF_BUCKET: Record<AtlasRefKind, keyof AtlasTableRefScope> = {
  location: "locations",
  character: "characters",
  item: "items",
};

/** 从引用字面量推断类型：`new:*` 临时引用与带前缀的正式行 id 都认。 */
export function refKindOf(rawRef: string): AtlasRefKind | null {
  for (const [kind, pattern] of Object.entries(REF_PATTERNS) as Array<[AtlasRefKind, RegExp]>) {
    if (pattern.test(rawRef)) return kind;
  }
  const prefixed = (Object.entries(ROW_PREFIX) as Array<[AtlasRefKind, string]>)
    .find(([, prefix]) => rawRef.startsWith(prefix));
  return prefixed ? prefixed[0] : null;
}

function rowsOf(tables: AtlasThreeTablesV1, kind: AtlasRefKind): Array<{ id: string }> {
  if (kind === "location") return tables.locations;
  if (kind === "character") return tables.characters;
  return tables.items;
}

/**
 * B04：把引用解析成候选表里的正式行 id。
 * - `new:*` 临时引用：只认本块已声明的映射；类型不符 → `REF_TYPE_MISMATCH`，未声明 → `REF_UNKNOWN`
 *   （后者在 B06 里表现为 `dependency_failed`）。**绝不**回落到同名的已有行。
 * - 其他引用：按前缀判定类型后必须命中候选表，否则 `ROW_NOT_FOUND`。
 */
export function resolveTableRef(
  tables: AtlasThreeTablesV1,
  scope: AtlasTableRefScope,
  rawRef: string,
  expected: AtlasRefKind,
): { ok: true; id: string } | { ok: false; error: AtlasTableEditError } {
  if (typeof rawRef !== "string" || rawRef.length === 0) {
    return { ok: false, error: { code: "REF_INVALID", path: "$.ref", ref: String(rawRef) } };
  }
  const kind = refKindOf(rawRef);
  if (kind === null) {
    return { ok: false, error: { code: "REF_INVALID", path: "$.ref", ref: rawRef } };
  }
  if (kind !== expected) {
    return { ok: false, error: { code: "REF_TYPE_MISMATCH", path: "$.ref", ref: rawRef } };
  }
  const isTemp = REF_PATTERNS[kind].test(rawRef);
  if (isTemp) {
    const declared = scope[REF_BUCKET[kind]].get(rawRef);
    if (declared === undefined) {
      return { ok: false, error: { code: "REF_UNKNOWN", path: "$.ref", ref: rawRef } };
    }
    return { ok: true, id: declared };
  }
  if (!rowsOf(tables, kind).some((row) => row.id === rawRef)) {
    return { ok: false, error: { code: "ROW_NOT_FOUND", path: "$.ref", ref: rawRef } };
  }
  return { ok: true, id: rawRef };
}

/**
 * B04：为新增行分配正式 id。
 * - 地点：`loc:<最大数字点 id + 1>`（与 A03/A04 的旧世界桥一致）；
 * - 人物 / 物品：由临时引用 slug 派生（`npc:keeper` / `item:key`），冲突时确定性追加 `-2`、`-3`…
 * 分配只读候选表，不维护计数器：失败行因此不占号，同一候选重复分配结果相同。
 */
export function allocateTableRowId(
  tables: AtlasThreeTablesV1,
  kind: AtlasRefKind,
  tempRef: string,
): { ok: true; id: string } | { ok: false; error: AtlasTableEditError } {
  if (!REF_PATTERNS[kind].test(tempRef)) {
    return { ok: false, error: { code: "REF_INVALID", path: "$.ref", ref: tempRef } };
  }
  if (kind === "location") {
    let max = 0;
    for (const row of tables.locations) {
      const matched = /^loc:(\d{1,15})$/.exec(row.id);
      if (!matched) continue;
      const value = Number(matched[1]);
      if (Number.isSafeInteger(value) && value > max) max = value;
    }
    return { ok: true, id: locationRowId(max + 1) };
  }
  const slug = tempRef.slice(`new:${kind === "character" ? "npc" : "item"}:`.length);
  const taken = new Set(rowsOf(tables, kind).map((row) => row.id));
  let candidate = `${ROW_PREFIX[kind]}${slug}`;
  let suffix = 2;
  while (taken.has(candidate) || candidate.length > ATLAS_TABLE_LIMITS.idChars) {
    candidate = `${ROW_PREFIX[kind]}${slug}-${suffix}`;
    suffix += 1;
    if (suffix > 999) return { ok: false, error: { code: "REF_INVALID", path: "$.ref", ref: tempRef } };
  }
  return { ok: true, id: candidate };
}

/* ------------------------------ 内部工具 ------------------------------ */

function textError(value: unknown, path: string): AtlasTableEditError | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return { code: "FIELD_TYPE", path };
  if (value.length > ATLAS_TABLE_LIMITS.textChars) return { code: "TEXT_TOO_LONG", path };
  return null;
}

function listError(value: unknown, path: string): AtlasTableEditError | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return { code: "FIELD_TYPE", path };
  if (value.length > ATLAS_TABLE_LIMITS.listItems) return { code: "LIST_TOO_LONG", path };
  if (!value.every((item) => typeof item === "string" && item.length > 0 && item.length <= ATLAS_TABLE_LIMITS.textChars)) {
    return { code: "FIELD_TYPE", path };
  }
  return null;
}

/** 沿父链上溯的跳数（根 = 0）；成环或父缺失返回 null。 */
function locationHops(locations: AtlasLocationRow[], id: string): number | null {
  const byId = new Map(locations.map((row) => [row.id, row]));
  let hops = 0;
  let current = byId.get(id);
  const seen = new Set<string>([id]);
  while (current && current.parentLocationId !== null) {
    if (seen.has(current.parentLocationId)) return null;
    seen.add(current.parentLocationId);
    hops += 1;
    current = byId.get(current.parentLocationId);
    if (!current) return null;
  }
  return current ? hops : null;
}

function isDescendant(locations: AtlasLocationRow[], candidate: string, ancestor: string): boolean {
  const byId = new Map(locations.map((row) => [row.id, row]));
  let current = byId.get(candidate);
  const seen = new Set<string>();
  while (current && current.parentLocationId !== null) {
    if (current.parentLocationId === ancestor) return true;
    if (seen.has(current.parentLocationId)) return false;
    seen.add(current.parentLocationId);
    current = byId.get(current.parentLocationId);
  }
  return false;
}

/* ------------------------------ B01 地点 ------------------------------ */

/**
 * B01：地点 `add/set/remove`。
 * - `add`：名称必填；`parentRef` 可空（根地点，`mapId="world"`）；同父同名 → 提示歧义；
 *   父链不得超过深度上限；子图不需要另外生成——`mapId=父行 id` 后由 D01 的
 *   `projectWorldSubmaps` 口径派生（§1「不另存 children 数组」）。
 * - `set`：只允许白名单字段（名称 / 描述 / 父引用 / 传闻 / 势力）；换父必须无环且不超深，
 *   换父后坐标回到未知（格序号属于旧父图，保留就是错的）。
 * - `remove`：有子地点直接拒绝（绝不级联）；被人物 / 物品引用的归属就地撤离（置空），
 *   否则候选表会留下悬空引用、整轮被 A01 拒。
 */
export function applyLocationEdit(
  tables: AtlasThreeTablesV1,
  edit: AtlasLocationEdit,
  scope: AtlasTableRefScope,
  options: AtlasTableEditOptions = {},
): AtlasTableEditResult {
  const maxDepth = options.maxLocationDepth ?? SUBMAP_DEPTH_MAX;
  if (edit === null || typeof edit !== "object" || edit.table !== "location") {
    return { ok: false, error: { code: "EDIT_TABLE_INVALID", path: "$.table" } };
  }
  if (edit.op === "add") {
    if (tables.locations.length >= ATLAS_TABLE_LIMITS.locations) {
      return { ok: false, error: { code: "ROW_LIMIT_EXCEEDED", path: "$.locations" } };
    }
    if (typeof edit.name !== "string" || edit.name.trim().length === 0) {
      return { ok: false, error: { code: "NAME_REQUIRED", path: "$.name" } };
    }
    for (const [key, value] of [["name", edit.name], ["description", edit.description]] as const) {
      const failure = textError(value, `$.${key}`);
      if (failure) return { ok: false, error: failure };
    }
    for (const [key, value] of [["rumors", edit.rumors], ["factions", edit.factions]] as const) {
      const failure = listError(value, `$.${key}`);
      if (failure) return { ok: false, error: failure };
    }
    let parentId: string | null = null;
    if (edit.parentRef !== undefined && edit.parentRef !== null) {
      const resolved = resolveTableRef(tables, scope, edit.parentRef, "location");
      if (!resolved.ok) return { ok: false, error: { ...resolved.error, path: "$.parentRef" } };
      parentId = resolved.id;
    }
    // 同父同名 → 歧义提示（不合并、不拒绝整块）
    const duplicate = tables.locations.find((row) => row.parentLocationId === parentId && row.name === edit.name);
    if (duplicate) {
      return { ok: false, error: { code: "DUPLICATE_SIBLING_NAME", path: "$.name", ref: duplicate.id } };
    }
    if (parentId !== null) {
      const parentHops = locationHops(tables.locations, parentId);
      if (parentHops === null) return { ok: false, error: { code: "PARENT_CYCLE", path: "$.parentRef", ref: parentId } };
      if (parentHops + 1 > maxDepth) {
        return { ok: false, error: { code: "PARENT_DEPTH_EXCEEDED", path: "$.parentRef", ref: parentId } };
      }
    }
    const allocated = allocateTableRowId(tables, "location", edit.ref);
    if (!allocated.ok) return { ok: false, error: allocated.error };
    // 先声明本块临时引用：同一块内重复声明同一 ref 必须在写入任何行之前失败
    const declared = declareAtlasRef(scope, "location", edit.ref, allocated.id);
    if (!declared.ok) return { ok: false, error: declared.error };
    const row: AtlasLocationRow = {
      id: allocated.id,
      name: edit.name,
      parentLocationId: parentId,
      description: typeof edit.description === "string" ? edit.description : "",
      rumors: Array.isArray(edit.rumors) ? [...edit.rumors] : [],
      factions: Array.isArray(edit.factions) ? [...edit.factions] : [],
      // 格序号只能由程序推导；新地点一律位置未知（§1）
      mapId: parentId === null ? "world" : parentId,
      gridX: null,
      gridY: null,
    };
    tables.locations.push(row);
    return { ok: true, id: row.id, op: "add", created: true };
  }

  const resolved = resolveTableRef(tables, scope, edit.ref, "location");
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const index = tables.locations.findIndex((row) => row.id === resolved.id);
  if (index < 0) return { ok: false, error: { code: "ROW_NOT_FOUND", path: "$.ref", ref: resolved.id } };
  const row = tables.locations[index]!;

  if (edit.op === "remove") {
    if (tables.locations.some((item) => item.parentLocationId === row.id)) {
      return { ok: false, error: { code: "HAS_CHILDREN", path: "$.ref", ref: row.id } };
    }
    tables.locations.splice(index, 1);
    // 撤离引用：人物 / 物品的归属就地置空，避免留下悬空引用
    for (const character of tables.characters) {
      if (character.locationId === row.id) character.locationId = null;
      if (character.targetLocationId === row.id) character.targetLocationId = null;
    }
    for (const item of tables.items) {
      if (item.locationId === row.id) item.locationId = null;
    }
    return { ok: true, id: row.id, op: "remove", created: false };
  }

  if (edit.op !== "set") return { ok: false, error: { code: "EDIT_OP_INVALID", path: "$.op" } };
  const patch = edit.patch;
  if (patch === undefined || patch === null || typeof patch !== "object") {
    return { ok: false, error: { code: "FIELD_TYPE", path: "$.patch" } };
  }
  const failure = textError(patch.name, "$.patch.name") ?? textError(patch.description, "$.patch.description");
  if (failure) return { ok: false, error: failure };
  for (const [key, value] of [["rumors", patch.rumors], ["factions", patch.factions]] as const) {
    const listFailure = listError(value, `$.patch.${key}`);
    if (listFailure) return { ok: false, error: listFailure };
  }
  if (patch.name !== undefined && patch.name.trim().length === 0) {
    return { ok: false, error: { code: "NAME_REQUIRED", path: "$.patch.name" } };
  }
  if (patch.parentRef !== undefined) {
    const nextParent = patch.parentRef === null
      ? null
      : (() => {
          const parentResolved = resolveTableRef(tables, scope, patch.parentRef as string, "location");
          return parentResolved.ok ? parentResolved.id : null;
        })();
    if (patch.parentRef !== null && nextParent === null) {
      return { ok: false, error: { code: "ROW_NOT_FOUND", path: "$.patch.parentRef", ref: String(patch.parentRef) } };
    }
    if (nextParent === row.id) {
      return { ok: false, error: { code: "PARENT_CYCLE", path: "$.patch.parentRef", ref: row.id } };
    }
    if (nextParent !== null && isDescendant(tables.locations, nextParent, row.id)) {
      return { ok: false, error: { code: "PARENT_CYCLE", path: "$.patch.parentRef", ref: nextParent } };
    }
    if (nextParent !== null) {
      const parentHops = locationHops(tables.locations, nextParent);
      if (parentHops === null) {
        return { ok: false, error: { code: "PARENT_CYCLE", path: "$.patch.parentRef", ref: nextParent } };
      }
      if (parentHops + 1 > maxDepth) {
        return { ok: false, error: { code: "PARENT_DEPTH_EXCEEDED", path: "$.patch.parentRef", ref: nextParent } };
      }
    }
    if (nextParent !== row.parentLocationId) {
      row.parentLocationId = nextParent;
      row.mapId = nextParent === null ? "world" : nextParent;
      // 旧格序号属于旧父图：换父后必须回到未知，不能把坐标带到新图
      row.gridX = null;
      row.gridY = null;
    }
  }
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.rumors !== undefined) row.rumors = [...patch.rumors];
  if (patch.factions !== undefined) row.factions = [...patch.factions];
  return { ok: true, id: row.id, op: "set", created: false };
}

/* ------------------------------ B02 人物 ------------------------------ */

/**
 * B02：人物 `add/set/remove`。
 * - 名称 / 想法 / 行动倾向 / 当前位置是四个独立字段，绝不互相冒充。
 * - 位置改动只写 `locationId` 与 `mapId`（该地点所在的图）；**格序号一律留空**——
 *   人物只精确到「在哪个地点」，细坐标要等程序按距离 / 日程推演出来。
 * - `protectedCharacterIds` 里的人（主人公等）：名称不可被模型改写、整行不可被 remove。
 * - `remove` = 撤离：`presence="left"`、位置与目标清空，行保留（§2「默认软删除或撤离」）。
 */
export function applyCharacterEdit(
  tables: AtlasThreeTablesV1,
  edit: AtlasCharacterEdit,
  scope: AtlasTableRefScope,
  options: AtlasTableEditOptions = {},
): AtlasTableEditResult {
  const protectedIds = options.protectedCharacterIds ?? new Set<string>();
  if (edit === null || typeof edit !== "object" || edit.table !== "character") {
    return { ok: false, error: { code: "EDIT_TABLE_INVALID", path: "$.table" } };
  }
  const locationRowOf = (locationId: string | null): AtlasLocationRow | undefined =>
    locationId === null ? undefined : tables.locations.find((row) => row.id === locationId);

  if (edit.op === "add") {
    if (tables.characters.length >= ATLAS_TABLE_LIMITS.characters) {
      return { ok: false, error: { code: "ROW_LIMIT_EXCEEDED", path: "$.characters" } };
    }
    if (typeof edit.name !== "string" || edit.name.trim().length === 0) {
      return { ok: false, error: { code: "NAME_REQUIRED", path: "$.name" } };
    }
    for (const [key, value] of [["name", edit.name], ["thought", edit.thought],
      ["actionTendency", edit.actionTendency], ["currentAction", edit.currentAction]] as const) {
      const failure = textError(value, `$.${key}`);
      if (failure) return { ok: false, error: failure };
    }
    let locationId: string | null = null;
    if (edit.locationRef !== undefined && edit.locationRef !== null) {
      const resolved = resolveTableRef(tables, scope, edit.locationRef, "location");
      if (!resolved.ok) return { ok: false, error: { ...resolved.error, path: "$.locationRef" } };
      locationId = resolved.id;
    }
    const allocated = allocateTableRowId(tables, "character", edit.ref);
    if (!allocated.ok) return { ok: false, error: allocated.error };
    const declared = declareAtlasRef(scope, "character", edit.ref, allocated.id);
    if (!declared.ok) return { ok: false, error: declared.error };
    const location = locationRowOf(locationId);
    const row: AtlasCharacterRow = {
      id: allocated.id,
      name: edit.name,
      locationId,
      thought: typeof edit.thought === "string" ? edit.thought : "",
      actionTendency: typeof edit.actionTendency === "string" ? edit.actionTendency : "",
      currentAction: typeof edit.currentAction === "string" ? edit.currentAction : "",
      targetLocationId: null,
      presence: edit.presence ?? (locationId === null ? "unknown" : "present"),
      positionSource: edit.basis === "inferred" ? "unknown" : "narrative",
      mapId: location ? location.mapId : null,
      gridX: null,
      gridY: null,
    };
    tables.characters.push(row);
    return { ok: true, id: row.id, op: "add", created: true };
  }

  const resolved = resolveTableRef(tables, scope, edit.ref, "character");
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const index = tables.characters.findIndex((row) => row.id === resolved.id);
  if (index < 0) return { ok: false, error: { code: "ROW_NOT_FOUND", path: "$.ref", ref: resolved.id } };
  const row = tables.characters[index]!;
  const isProtected = protectedIds.has(row.id);

  if (edit.op === "remove") {
    if (isProtected) return { ok: false, error: { code: "PROTAGONIST_PROTECTED", path: "$.ref", ref: row.id } };
    row.presence = "left";
    row.locationId = null;
    row.targetLocationId = null;
    row.mapId = null;
    row.gridX = null;
    row.gridY = null;
    return { ok: true, id: row.id, op: "remove", created: false };
  }
  if (edit.op !== "set") return { ok: false, error: { code: "EDIT_OP_INVALID", path: "$.op" } };
  const patch = edit.patch;
  if (patch === undefined || patch === null || typeof patch !== "object") {
    return { ok: false, error: { code: "FIELD_TYPE", path: "$.patch" } };
  }
  if (patch.name !== undefined) {
    if (isProtected) return { ok: false, error: { code: "PROTAGONIST_PROTECTED", path: "$.patch.name", ref: row.id } };
    if (patch.name.trim().length === 0) return { ok: false, error: { code: "NAME_REQUIRED", path: "$.patch.name" } };
  }
  for (const [key, value] of [["name", patch.name], ["thought", patch.thought],
    ["actionTendency", patch.actionTendency], ["currentAction", patch.currentAction]] as const) {
    const failure = textError(value, `$.patch.${key}`);
    if (failure) return { ok: false, error: failure };
  }
  if (patch.presence !== undefined && !ATLAS_CHARACTER_PRESENCES.includes(patch.presence)) {
    return { ok: false, error: { code: "PRESENCE_INVALID", path: "$.patch.presence" } };
  }
  let nextLocationId: string | null | undefined;
  if (patch.locationRef !== undefined) {
    if (patch.locationRef === null) {
      nextLocationId = null;
    } else {
      const locationResolved = resolveTableRef(tables, scope, patch.locationRef, "location");
      if (!locationResolved.ok) return { ok: false, error: { ...locationResolved.error, path: "$.patch.locationRef" } };
      nextLocationId = locationResolved.id;
    }
  }
  let nextTargetId: string | null | undefined;
  if (patch.targetLocationRef !== undefined) {
    if (patch.targetLocationRef === null) {
      nextTargetId = null;
    } else {
      const targetResolved = resolveTableRef(tables, scope, patch.targetLocationRef, "location");
      if (!targetResolved.ok) return { ok: false, error: { ...targetResolved.error, path: "$.patch.targetLocationRef" } };
      nextTargetId = targetResolved.id;
    }
  }
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.thought !== undefined) row.thought = patch.thought;
  if (patch.actionTendency !== undefined) row.actionTendency = patch.actionTendency;
  if (patch.currentAction !== undefined) row.currentAction = patch.currentAction;
  if (patch.presence !== undefined) row.presence = patch.presence;
  if (nextTargetId !== undefined) row.targetLocationId = nextTargetId;
  if (nextLocationId !== undefined) {
    row.locationId = nextLocationId;
    const location = locationRowOf(nextLocationId);
    row.mapId = location ? location.mapId : null;
    // 地点粒度以下的坐标只能由程序推导：换地点即回到未知
    row.gridX = null;
    row.gridY = null;
    if (nextLocationId !== null && patch.presence === undefined && row.presence === "unknown") {
      row.presence = "present";
    }
    row.positionSource = patch.locationRef === null ? "unknown" : (edit.basis === "inferred" ? "unknown" : "narrative");
  }
  return { ok: true, id: row.id, op: "set", created: false };
}

/* ------------------------------ B03 物品 ------------------------------ */

/**
 * B03：物品 `add/set/remove`。
 * - 地点与持有人**互斥**：写一个必须清另一个；持有物坐标置空、不写 `locationId`，
 *   因此不会出现在地面的物品图钉里（D01 的投影口径）。
 * - `remove` = 软删除：状态标 `ATLAS_ITEM_DESTROYED_STATUS` 并清归属，行保留可追溯。
 */
export function applyItemEdit(
  tables: AtlasThreeTablesV1,
  edit: AtlasItemEdit,
  scope: AtlasTableRefScope,
): AtlasTableEditResult {
  if (edit === null || typeof edit !== "object" || edit.table !== "item") {
    return { ok: false, error: { code: "EDIT_TABLE_INVALID", path: "$.table" } };
  }
  const applyOwnership = (
    row: AtlasItemRow,
    locationRef: string | null | undefined,
    holderRef: string | null | undefined,
  ): AtlasTableEditResult | null => {
    if (locationRef !== undefined && locationRef !== null && holderRef !== undefined && holderRef !== null) {
      return { ok: false, error: { code: "HOLDER_AND_LOCATION", path: "$.holderRef" } };
    }
    let locationId: string | null | undefined;
    if (locationRef !== undefined) {
      if (locationRef === null) {
        locationId = null;
      } else {
        const resolved = resolveTableRef(tables, scope, locationRef, "location");
        if (!resolved.ok) return { ok: false, error: { ...resolved.error, path: "$.locationRef" } };
        locationId = resolved.id;
      }
    }
    let holderId: string | null | undefined;
    if (holderRef !== undefined) {
      if (holderRef === null) {
        holderId = null;
      } else {
        const resolved = resolveTableRef(tables, scope, holderRef, "character");
        if (!resolved.ok) return { ok: false, error: { ...resolved.error, path: "$.holderRef" } };
        holderId = resolved.id;
      }
    }
    if (holderId !== undefined && holderId !== null) {
      // 归人：地点必须同时清掉，否则候选表会被 A01 判 HOLDER_AND_LOCATION
      row.holderCharacterId = holderId;
      row.locationId = null;
      row.mapId = null;
      row.gridX = null;
      row.gridY = null;
      return null;
    }
    if (locationId !== undefined) {
      row.locationId = locationId;
      row.holderCharacterId = null;
      const location = locationId === null ? undefined : tables.locations.find((item) => item.id === locationId);
      row.mapId = location ? location.mapId : null;
      row.gridX = null;
      row.gridY = null;
      return null;
    }
    if (holderId === null) {
      // 明确「放下」：清持有人但地点未给 → 位置未知，不猜原地
      row.holderCharacterId = null;
      row.locationId = null;
      row.mapId = null;
      row.gridX = null;
      row.gridY = null;
    }
    return null;
  };

  if (edit.op === "add") {
    if (tables.items.length >= ATLAS_TABLE_LIMITS.items) {
      return { ok: false, error: { code: "ROW_LIMIT_EXCEEDED", path: "$.items" } };
    }
    if (typeof edit.name !== "string" || edit.name.trim().length === 0) {
      return { ok: false, error: { code: "NAME_REQUIRED", path: "$.name" } };
    }
    for (const [key, value] of [["name", edit.name], ["description", edit.description], ["status", edit.status]] as const) {
      const failure = textError(value, `$.${key}`);
      if (failure) return { ok: false, error: failure };
    }
    // 先解析归属（互斥），再分配 id 与声明引用：任何失败都不留下半行
    const hasLocation = edit.locationRef !== undefined && edit.locationRef !== null;
    const hasHolder = edit.holderRef !== undefined && edit.holderRef !== null;
    if (hasLocation && hasHolder) {
      return { ok: false, error: { code: "HOLDER_AND_LOCATION", path: "$.holderRef" } };
    }
    let locationId: string | null = null;
    if (hasLocation) {
      const resolved = resolveTableRef(tables, scope, edit.locationRef as string, "location");
      if (!resolved.ok) return { ok: false, error: { ...resolved.error, path: "$.locationRef" } };
      locationId = resolved.id;
    }
    let holderId: string | null = null;
    if (hasHolder) {
      const resolved = resolveTableRef(tables, scope, edit.holderRef as string, "character");
      if (!resolved.ok) return { ok: false, error: { ...resolved.error, path: "$.holderRef" } };
      holderId = resolved.id;
    }
    const allocated = allocateTableRowId(tables, "item", edit.ref);
    if (!allocated.ok) return { ok: false, error: allocated.error };
    const declared = declareAtlasRef(scope, "item", edit.ref, allocated.id);
    if (!declared.ok) return { ok: false, error: declared.error };
    const location = holderId !== null || locationId === null
      ? undefined
      : tables.locations.find((item) => item.id === locationId);
    const row: AtlasItemRow = {
      id: allocated.id,
      name: edit.name,
      description: typeof edit.description === "string" ? edit.description : "",
      // 持有与地点互斥：归人时地点与坐标一律置空
      locationId: holderId !== null ? null : locationId,
      holderCharacterId: holderId,
      status: typeof edit.status === "string" ? edit.status : "",
      mapId: holderId !== null ? null : location?.mapId ?? null,
      gridX: null,
      gridY: null,
    };
    tables.items.push(row);
    return { ok: true, id: row.id, op: "add", created: true };
  }

  const resolved = resolveTableRef(tables, scope, edit.ref, "item");
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const index = tables.items.findIndex((row) => row.id === resolved.id);
  if (index < 0) return { ok: false, error: { code: "ROW_NOT_FOUND", path: "$.ref", ref: resolved.id } };
  const row = tables.items[index]!;

  if (edit.op === "remove") {
    row.status = ATLAS_ITEM_DESTROYED_STATUS;
    row.locationId = null;
    row.holderCharacterId = null;
    row.mapId = null;
    row.gridX = null;
    row.gridY = null;
    return { ok: true, id: row.id, op: "remove", created: false };
  }
  if (edit.op !== "set") return { ok: false, error: { code: "EDIT_OP_INVALID", path: "$.op" } };
  const patch = edit.patch;
  if (patch === undefined || patch === null || typeof patch !== "object") {
    return { ok: false, error: { code: "FIELD_TYPE", path: "$.patch" } };
  }
  for (const [key, value] of [["name", patch.name], ["description", patch.description], ["status", patch.status]] as const) {
    const failure = textError(value, `$.patch.${key}`);
    if (failure) return { ok: false, error: failure };
  }
  if (patch.name !== undefined) {
    if (patch.name.trim().length === 0) return { ok: false, error: { code: "NAME_REQUIRED", path: "$.patch.name" } };
    row.name = patch.name;
  }
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.status !== undefined) row.status = patch.status;
  const ownership = applyOwnership(row, patch.locationRef, patch.holderRef);
  if (ownership) return ownership;
  return { ok: true, id: row.id, op: "set", created: false };
}

/* ------------------------------------------------------------------ *
 * A02：深拷贝与稳定序列化
 * ------------------------------------------------------------------ */

/** 逐层复制：对象与数组都换成新引用，原始值直接返回（不依赖宿主 structuredClone）。 */
function copyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => copyValue(item));
  if (isObj(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = copyValue(item);
    return out;
  }
  return value;
}

/** 行的规范键序：已知字段按契约顺序，未知字段按原顺序追加（保留而不静默丢弃）。 */
function canonicalRow(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (has(row, key)) out[key] = copyValue(row[key]);
  }
  for (const key of Object.keys(row)) {
    if (keys.includes(key)) continue;
    out[key] = copyValue(row[key]);
  }
  return out;
}

const LOCATION_KEYS = ["id", "name", "parentLocationId", "description", "rumors", "factions", "mapId", "gridX", "gridY"] as const;
const CHARACTER_KEYS = [
  "id", "name", "locationId", "thought", "actionTendency", "currentAction",
  "targetLocationId", "presence", "positionSource", "mapId", "gridX", "gridY",
] as const;
const ITEM_KEYS = ["id", "name", "description", "locationId", "holderCharacterId", "status", "mapId", "gridX", "gridY"] as const;

/**
 * 深拷贝一个分支的三表：所有对象/数组都是新引用，改拷贝不会影响输入；键序按契约规范化，
 * 使同一份数据任何时候序列化结果一致（供 §1 的「镜像与三表一致性比较」使用）。
 */
export function cloneAtlasTables(tables: AtlasThreeTablesV1): AtlasThreeTablesV1 {
  const source = tables as unknown as Record<string, unknown>;
  // 非法行（非对象）**原样保留**、不做清洗：清洗与拒绝是 A01 的职责，克隆静默丢数据会掩盖损坏档。
  const rows = (value: unknown, keys: readonly string[]): Array<Record<string, unknown>> => {
    const list: unknown[] = Array.isArray(value) ? value : [];
    return list.map((row) => (isObj(row) ? canonicalRow(row, keys) : (copyValue(row) as Record<string, unknown>)));
  };
  return {
    locations: rows(source.locations, LOCATION_KEYS),
    characters: rows(source.characters, CHARACTER_KEYS),
    items: rows(source.items, ITEM_KEYS),
  } as unknown as AtlasThreeTablesV1;
}

/**
 * 稳定指纹：三表 → 规范键序 + 行按 id 排序后的 JSON 字符串。
 * 与 `cloneAtlasTables` 的区别是**行序无关**：两份额外相同的快照即使行序不同也得到同一指纹，
 * 因此可以拿来做「镜像 vs 三表」的一致性断言，而不会因为展示顺序差异误报不一致。
 */
export function atlasTablesFingerprint(tables: AtlasThreeTablesV1): string {
  const cloned = cloneAtlasTables(tables);
  const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return JSON.stringify({
    locations: [...cloned.locations].sort(byId),
    characters: [...cloned.characters].sort(byId),
    items: [...cloned.items].sort(byId),
  });
}
