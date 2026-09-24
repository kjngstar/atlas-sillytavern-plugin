/**
 * atlas-table-migration.ts — A03：旧 `world` + `maps` → 三表的**确定性**迁移。
 *
 * 契约（计划 §1、§3-A03）：
 * - 纯函数、零 IO：不读 store、不写会话、不调模型；返回 `{ tables, warnings }`，由调用方落盘。
 * - 输入必须是**该分支可见**的 world（调用方负责分支/游标过滤，见 A08），
 *   `branchId` 用于 `CharacterState` 的分支过滤，`at` 是账本投影游标（缺省 = 不过滤时间）。
 * - 旧点（含 `parentPointId` 父子链）→ 地点行；`characters ∪ entityRecords[type=npc]`
 *   的分支可见事实 → 人物行；`entityRecords` 里的非人物物件 → 物品行。
 * - 位置换算：地点用画布坐标 → **零起始格序号**；子地点用父图 sidecar 布局（子图自有的
 *   0..100 格空间）。拿不到布局/坐标的行保留位置未知（`gridX/gridY = null`），
 *   绝不把它们丢到「起点」或编造房间坐标。
 * - 迁移结果必须能通过 A01 校验（超限截断并记 `ROWS_TRUNCATED`，不产出非法表）。
 *
 * 明确不做：不迁移地区（`world.regions`）、世界书、账本、检查点、地图底图；它们继续留在
 * `world` 里由现有引擎使用。也不删除/改写任何旧数据。
 */

import {
  W0_LIMITS,
  type CharacterState,
  type EntityRecord,
  type MapPoint,
  type World,
} from "../lib/world-schema.ts";
import type { AtlasMapDoc } from "./atlas-geo-apply.ts";
import { resolveAtlasRuntimeView } from "./atlas-runtime-view.ts";
import {
  ATLAS_TABLE_LIMITS,
  characterIdFromRowId,
  characterRowId,
  entityIdFromItemRowId,
  itemRowId,
  locationRowId,
  pointIdFromLocationRowId,
  type AtlasCharacterRow,
  type AtlasItemRow,
  type AtlasLocationRow,
  type AtlasThreeTablesV1,
} from "./atlas-tables.ts";

export type AtlasTableMigrationWarningCode =
  | "POINT_ID_INVALID"
  | "POINT_PARENT_SELF"
  | "POINT_PARENT_UNKNOWN"
  | "POINT_POSITION_UNKNOWN"
  | "SUBMAP_LAYOUT_MISSING"
  | "CHARACTER_LOCATION_UNKNOWN"
  | "ENTITY_ID_INVALID"
  | "ENTITY_ID_TOO_LONG"
  | "ITEM_HOLDER_UNKNOWN"
  | "TEXT_TRUNCATED"
  | "ROWS_TRUNCATED"
  | "WARNINGS_TRUNCATED";

/** 迁移警告：只有具名代码与可复制的路径，不含模型原文或长自由文本（日志纪律）。 */
export interface AtlasTableMigrationWarning {
  code: AtlasTableMigrationWarningCode;
  path: string;
}

export interface AtlasTableMigrationInput {
  world: World;
  /** 该世界的地图 sidecar（已 sanitize）；缺省视为空文档。 */
  maps?: AtlasMapDoc | null;
  /** 当前分支；null = 正史基线。 */
  branchId?: string | null;
  /** 账本投影游标（= 绑定 worldTimeCursor）。缺省 = 不过滤时间，只依赖调用方传来的可见 world。 */
  at?: number;
}

export interface AtlasTableMigrationResult {
  tables: AtlasThreeTablesV1;
  warnings: AtlasTableMigrationWarning[];
}

/** 警告条数上限：迁移可能面对上千行，日志只留前 N 条 + 一条截断提示。 */
const WARNING_MAX = 200;
/** 人物实体类型（这些 `entityRecords` 是人物而不是物品）。 */
const NPC_ENTITY_TYPES = new Set(["npc", "character", "person", "char", "人物", "角色"]);
/**
 * 非物件实体类型（规格 §3-A03 是「非 NPC **物件**→物品」）：势力 / 城市 / 地区这类实体
 * 不属于三表，必须留在 `world.entityRecords` 里由现有引擎继续用；
 * 若误迁成物品行，A04 镜像会把它们改写成 `type:"item"`——那是静默的数据损坏。
 * 未列出的类型仍按物件处理（作者自定义的物件类型不受影响）。
 */
const NON_ITEM_ENTITY_TYPES = new Set([
  "faction", "organization", "org", "group", "guild", "clan", "party",
  "city", "region", "nation", "country", "realm", "location", "place",
  "势力", "组织", "团体", "公会", "阵营", "城市", "地区", "国家", "地点",
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function migrateLegacyToTables(input: AtlasTableMigrationInput): AtlasTableMigrationResult {
  const warnings: AtlasTableMigrationWarning[] = [];
  const pushWarning = (code: AtlasTableMigrationWarningCode, path: string): void => {
    if (warnings.length < WARNING_MAX) warnings.push({ code, path });
    else if (warnings[warnings.length - 1]?.code !== "WARNINGS_TRUNCATED") {
      warnings.push({ code: "WARNINGS_TRUNCATED", path: "$" });
    }
  };
  const clipText = (value: unknown, path: string): string => {
    if (typeof value !== "string") return "";
    const text = value.trim();
    if (text.length <= ATLAS_TABLE_LIMITS.textChars) return text;
    pushWarning("TEXT_TRUNCATED", path);
    return text.slice(0, ATLAS_TABLE_LIMITS.textChars);
  };

  const world = input.world;
  const maps = input.maps ?? null;
  const branchId = input.branchId ?? null;
  const at = isFiniteNumber(input.at) ? input.at : Number.POSITIVE_INFINITY;

  // 1) 可见地点（只认正整数 id；与 lib/ 与 sidecar 的口径一致）
  interface LegacyPoint { id: number; name: string; x: number; y: number; parentPointId: number }
  const points: LegacyPoint[] = [];
  for (const point of world.points ?? []) {
    const id = Number(point?.id);
    if (!Number.isInteger(id) || id <= 0) {
      pushWarning("POINT_ID_INVALID", `$.locations[${points.length}]`);
      continue;
    }
    points.push({
      id,
      name: String(point.name ?? ""),
      x: point.x,
      y: point.y,
      parentPointId: Number(point.parentPointId),
    });
  }
  points.sort((a, b) => a.id - b.id);
  const pointById = new Map(points.map((point) => [point.id, point]));

  // 2) 父链：父不存在 / 自引用时**保留地点本身**（视为根）并记警告，绝不因此丢地点
  const parentOf = new Map<number, number>();
  for (const point of points) {
    const parentId = point.parentPointId;
    if (!Number.isInteger(parentId) || parentId <= 0) continue;
    if (parentId === point.id) {
      pushWarning("POINT_PARENT_SELF", `$.locations[${points.length}]`);
      continue;
    }
    if (!pointById.has(parentId)) {
      pushWarning("POINT_PARENT_UNKNOWN", locationRowId(point.id));
      continue;
    }
    parentOf.set(point.id, parentId);
  }

  // 3) 画布 → 格序号：1 画布单位 = 1 格（world mapAnchor 的 0..100 上限、子图 0..100 布局空间、
  //    frame 100×100 三处同口径）。负坐标不夹到 0（那等于挪到原点）——按位置未知处理。
  const worldGrid = (x: unknown, y: unknown): { gridX: number; gridY: number } | null => {
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
    if (x < 0 || y < 0) return null;
    return { gridX: Math.round(x), gridY: Math.round(y) };
  };

  // 4) 地点行
  const locations: AtlasLocationRow[] = [];
  let locationsTruncated = false;
  for (const point of points) {
    if (locations.length >= ATLAS_TABLE_LIMITS.locations) {
      locationsTruncated = true;
      break;
    }
    const path = `$.locations[${locations.length}]`;
    const parentId = parentOf.get(point.id) ?? null;
    const mapId = parentId === null ? "world" : locationRowId(parentId);
    let grid: { gridX: number; gridY: number } | null = null;
    if (parentId === null) {
      grid = worldGrid(point.x, point.y);
      if (grid === null) pushWarning("POINT_POSITION_UNKNOWN", locationRowId(point.id));
    } else {
      // 子地点在父图 sidecar 的布局里（子图自有的 0..100 格空间）；找不到就保留位置未知
      const layout = maps?.submaps?.[String(parentId)]?.points?.find((item) => String(item.id) === String(point.id));
      if (layout && isFiniteNumber(layout.x) && isFiniteNumber(layout.y)) {
        grid = { gridX: Math.max(0, Math.round(layout.x)), gridY: Math.max(0, Math.round(layout.y)) };
      } else {
        pushWarning("SUBMAP_LAYOUT_MISSING", locationRowId(point.id));
      }
    }
    locations.push({
      id: locationRowId(point.id),
      // 名称为空时用 id 派生标签：A01 要求非空名，但绝不编造地名
      name: clipText(point.name, `${path}.name`) || `地点 ${point.id}`,
      parentLocationId: parentId === null ? null : locationRowId(parentId),
      description: clipText(maps?.pointMeta?.[String(point.id)]?.description, `${path}.description`),
      rumors: [],
      factions: [],
      mapId,
      gridX: grid?.gridX ?? null,
      gridY: grid?.gridY ?? null,
    });
  }
  if (locationsTruncated) pushWarning("ROWS_TRUNCATED", "$.locations");
  const locationById = new Map(locations.map((row) => [row.id, row]));

  // 5) 人物行：注册表与账本投影复用 R04 唯一读取口径（分支 + 游标感知）
  const views = resolveAtlasRuntimeView(world, { branchId, at }).npcs
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const characters: AtlasCharacterRow[] = [];
  let charactersTruncated = false;
  for (const view of views) {
    if (characters.length >= ATLAS_TABLE_LIMITS.characters) {
      charactersTruncated = true;
      break;
    }
    const rowId = characterRowId(view.id);
    if (rowId.length > ATLAS_TABLE_LIMITS.idChars) {
      pushWarning("ENTITY_ID_TOO_LONG", rowId.slice(0, ATLAS_TABLE_LIMITS.idChars));
      continue;
    }
    const path = `$.characters[${characters.length}]`;
    const locationRow = view.pointId !== null ? locationById.get(locationRowId(view.pointId)) : undefined;
    if (view.pointId !== null && !locationRow) {
      pushWarning("CHARACTER_LOCATION_UNKNOWN", rowId);
    }
    characters.push({
      id: rowId,
      name: clipText(view.name, `${path}.name`) || view.id,
      locationId: locationRow ? locationRow.id : null,
      // 旧数据没有「想法 / 行动倾向」字段：留空字符串，绝不用 status 冒充
      thought: "",
      actionTendency: "",
      currentAction: clipText(view.status, `${path}.currentAction`),
      targetLocationId: null,
      // 有已知位置即视为在场；账本明确 left 时如实保留；否则未知（不猜离场）
      presence: view.presence === "left" ? "left" : locationRow ? "present" : "unknown",
      // ledger = 由正文推演出的叙事事实；state/legacy/none 来源不明
      positionSource: view.source === "ledger" ? "narrative" : "unknown",
      // 人物只精确到「在哪个地点」：mapId 取该地点所在的图，格序号留空（§1）
      mapId: locationRow ? locationRow.mapId : null,
      gridX: null,
      gridY: null,
    });
  }
  if (charactersTruncated) pushWarning("ROWS_TRUNCATED", "$.characters");
  const characterIds = new Set(characters.map((row) => row.id));

  // 6) 物品行：非人物实体 → 物品；归属取基线字段，持有与地点互斥
  const items: AtlasItemRow[] = [];
  let itemsTruncated = false;
  for (const record of world.entityRecords ?? []) {
    const entityId = String(record?.id ?? "").trim();
    if (entityId.length === 0) {
      pushWarning("ENTITY_ID_INVALID", `$.items[${items.length}]`);
      continue;
    }
    if (NPC_ENTITY_TYPES.has(String(record.type ?? "").toLowerCase())) continue;
    if (NON_ITEM_ENTITY_TYPES.has(String(record.type ?? "").toLowerCase())) continue;
    const rowId = itemRowId(entityId);
    if (characterIds.has(characterRowId(entityId))) continue; // 已在人物表里的实体不再登记为物品
    if (rowId.length > ATLAS_TABLE_LIMITS.idChars) {
      pushWarning("ENTITY_ID_TOO_LONG", rowId.slice(0, ATLAS_TABLE_LIMITS.idChars));
      continue;
    }
    if (items.length >= ATLAS_TABLE_LIMITS.items) {
      itemsTruncated = true;
      break;
    }
    const path = `$.items[${items.length}]`;
    const baseline = (record.baseline ?? {}) as Record<string, unknown>;
    const holderRaw = [baseline.holderCharacterId, baseline.holder, baseline.owner]
      .find((value) => typeof value === "string" && value.trim().length > 0);
    const holderId = typeof holderRaw === "string" ? characterRowId(holderRaw) : null;
    const holderExists = holderId !== null && characterIds.has(holderId);
    if (holderId !== null && !holderExists) pushWarning("ITEM_HOLDER_UNKNOWN", rowId);
    const anchorPointId = record.mapAnchor?.pointId;
    const locationRow = anchorPointId !== undefined && anchorPointId !== null
      ? locationById.get(locationRowId(anchorPointId))
      : undefined;
    const anchorGrid = record.mapAnchor
      ? worldGrid(record.mapAnchor.x, record.mapAnchor.y)
      : null;
    items.push({
      id: rowId,
      name: clipText(record.name, `${path}.name`) || entityId,
      description: clipText(baseline.description ?? baseline.summary, `${path}.description`),
      // 持有物：locationId = null 且坐标置空（地图视图按持有人位置临时推导，不重复持久化）
      locationId: holderExists ? null : locationRow ? locationRow.id : null,
      holderCharacterId: holderExists ? holderId : null,
      status: clipText(baseline.status, `${path}.status`),
      mapId: holderExists ? null : anchorGrid ? "world" : locationRow ? locationRow.mapId : null,
      gridX: holderExists ? null : anchorGrid?.gridX ?? null,
      gridY: holderExists ? null : anchorGrid?.gridY ?? null,
    });
  }
  if (itemsTruncated) pushWarning("ROWS_TRUNCATED", "$.items");

  return { tables: { locations, characters, items }, warnings };
}

/* ================================================================== *
 * A04：三表 → 旧 World 兼容镜像
 * ================================================================== */

export type AtlasTablesToWorldWarningCode =
  | "WORLD_ID_MISSING"
  | "POINT_ID_NOT_NUMERIC"
  | "DUPLICATE_POINT_ID"
  | "PARENT_NOT_MIRRORED"
  | "POSITION_DERIVED"
  | "CHARACTER_ID_NOT_MIRRORED"
  | "CHARACTER_LOCATION_NOT_MIRRORED"
  | "PRESENCE_NOT_MIRRORED"
  | "ITEM_ID_NOT_MIRRORED"
  | "ANCHOR_COORDS_DROPPED"
  | "MIRROR_ROWS_TRUNCATED";

export interface AtlasTablesToWorldWarning {
  code: AtlasTablesToWorldWarningCode;
  path: string;
}

export interface AtlasTablesToWorldInput {
  tables: AtlasThreeTablesV1;
  /**
   * 基底世界：账本 / 地图底图 / 世界书 / 人物档案 / 角色旧字段 / 三表不覆盖的实体
   * 全部原样透传，本函数不改写它们。
   */
  world: World;
  /** 三表快照所属分支；写入镜像 characterStates 的 branchId（null = 正史基线）。 */
  branchId?: string | null;
  /** 镜像 characterStates 的 updatedAt；缺省取 world.updatedAt（不读系统时钟，保持纯函数）。 */
  at?: number;
}

export interface AtlasTablesToWorldResult {
  world: World;
  warnings: AtlasTablesToWorldWarning[];
}

/**
 * 把三表投影成旧 `World` 的**兼容镜像**（A04，纯函数）。
 *
 * 口径（计划 §1「唯一写入规则」+ 决定 D-01/D-02/D-03）：
 * - 地点 → `world.points`（格序号 1:1 还原为画布坐标；保留基底世界的 `regionId` 与地点世界书）；
 * - 人物 → `world.characterStates`（**只替换本分支本表覆盖的人物**，其他分支/其他人物原样保留）；
 * - 物品与「只有三表、没有档案」的人物 → `world.entityRecords`；
 * - 其余一切（账本、地图底图、世界书、人物档案、三表不覆盖的实体、检查点…）原样透传。
 * - 镜像是**有界子集**：`entityRecords ≤ W0_LIMITS.maxEntityRecords`、
 *   `characterStates ≤ W0_LIMITS.maxCharacterStates`（超限会让整份 world 解析失败）；
 *   截断必记 `MIRROR_ROWS_TRUNCATED`。实体现值读取口径是 D01/D02（直读三表），
 *   因此镜像上限不会隐藏 UI 数据。
 * - 镜像**不得作为迁移输入**（迁移只在 tables 缺失时发生一次，见 A08）。
 */
export function tablesToLegacyWorld(input: AtlasTablesToWorldInput): AtlasTablesToWorldResult {
  const warnings: AtlasTablesToWorldWarning[] = [];
  const pushWarning = (code: AtlasTablesToWorldWarningCode, path: string): void => {
    if (warnings.length < WARNING_MAX) warnings.push({ code, path });
  };
  const world = input.world;
  const branchId = input.branchId ?? null;
  const updatedAt = isFiniteNumber(input.at)
    ? input.at
    : isFiniteNumber(world.updatedAt) ? world.updatedAt : 0;
  const worldId = typeof world.id === "string" && world.id.length > 0 ? world.id : "";
  if (worldId.length === 0) pushWarning("WORLD_ID_MISSING", "$");

  const basePoints = new Map<string, MapPoint>();
  for (const point of world.points ?? []) basePoints.set(String(point.id), point);

  // --- 地点 → world.points ---
  interface LocationSlot {
    row: AtlasLocationRow;
    pointId: number;
    parentPointId: number | null;
    x: number | null;
    y: number | null;
  }
  const slots: LocationSlot[] = [];
  const pointIdOfRow = new Map<string, number>();
  const usedPointIds = new Set<number>();
  for (const row of input.tables.locations) {
    const pointId = pointIdFromLocationRowId(row.id);
    if (pointId === null) {
      pushWarning("POINT_ID_NOT_NUMERIC", row.id);
      continue;
    }
    if (usedPointIds.has(pointId)) {
      pushWarning("DUPLICATE_POINT_ID", row.id);
      continue;
    }
    usedPointIds.add(pointId);
    pointIdOfRow.set(row.id, pointId);
    const base = basePoints.get(String(pointId));
    const hasGrid = row.gridX !== null && row.gridY !== null;
    slots.push({
      row,
      pointId,
      parentPointId: row.parentLocationId === null ? null : pointIdFromLocationRowId(row.parentLocationId),
      x: hasGrid ? row.gridX : base ? base.x : null,
      y: hasGrid ? row.gridY : base ? base.y : null,
    });
  }
  const slotByPointId = new Map(slots.map((slot) => [slot.pointId, slot]));
  const resolveXY = (slot: LocationSlot): { x: number; y: number } => {
    if (slot.parentPointId !== null) {
      // 子地点在世界图上与父地点**重合**：它的格序号是「父图自己的 0..100 布局空间」，
      // 直接当世界画布坐标写会让"进房间"变成跨城旅行（C06 实测暴露）。
      // 子图内的真实位置由 sidecar 投影（D01/D02）负责，不靠世界点坐标表达。
      const parent = slotByPointId.get(slot.parentPointId);
      if (parent) {
        const resolved = parent.x !== null && parent.y !== null ? { x: parent.x, y: parent.y } : resolveXY(parent);
        return resolved;
      }
      return { x: 0, y: 0 };
    }
    if (slot.x !== null && slot.y !== null) return { x: slot.x, y: slot.y };
    pushWarning("POSITION_DERIVED", slot.row.id);
    return { x: 0, y: 0 };
  };

  const points: MapPoint[] = slots.map((slot) => {
    const { x, y } = resolveXY(slot);
    const base = basePoints.get(String(slot.pointId));
    const keepParent = slot.parentPointId !== null && slotByPointId.has(slot.parentPointId);
    if (slot.parentPointId !== null && !keepParent) pushWarning("PARENT_NOT_MIRRORED", slot.row.id);
    return {
      id: slot.pointId,
      name: slot.row.name,
      x,
      y,
      regionId: base?.regionId ?? null,
      ...(keepParent ? { parentPointId: slot.parentPointId } : {}),
      ...(base?.worldBook ? { worldBook: base.worldBook } : {}),
    };
  });
  const regionOfPointId = new Map(points.map((point) => [String(point.id), point.regionId ?? null]));

  // --- 人物 → world.characterStates（只替换本分支本表覆盖的人物）---
  const characterCap = Math.min(input.tables.characters.length, W0_LIMITS.maxCharacterStates);
  if (input.tables.characters.length > characterCap) pushWarning("MIRROR_ROWS_TRUNCATED", "$.characters");
  const mirroredStates: CharacterState[] = [];
  const mirroredCharacterIds = new Set<string>();
  for (const row of input.tables.characters.slice(0, characterCap)) {
    const characterId = characterIdFromRowId(row.id);
    if (characterId === null) {
      pushWarning("CHARACTER_ID_NOT_MIRRORED", row.id);
      continue;
    }
    mirroredCharacterIds.add(characterId);
    const pointId = row.locationId !== null ? pointIdOfRow.get(row.locationId) : undefined;
    if (row.locationId !== null && pointId === undefined) {
      pushWarning("CHARACTER_LOCATION_NOT_MIRRORED", row.id);
    }
    // 离场者不写位置（CharacterState 没有 presence 字段，写位置等于说「他还在这」）
    const left = row.presence === "left";
    if (left) pushWarning("PRESENCE_NOT_MIRRORED", row.id);
    const mirroredPointId = left ? undefined : pointId;
    mirroredStates.push({
      characterId,
      currentRegionId: mirroredPointId !== undefined
        ? regionOfPointId.get(String(mirroredPointId)) ?? null
        : null,
      ...(mirroredPointId !== undefined ? { currentPointId: String(mirroredPointId) } : {}),
      ...(row.currentAction.trim().length > 0 ? { status: row.currentAction } : {}),
      updatedAt,
      branchId,
    });
  }
  const characterStates: CharacterState[] = [
    ...(world.characterStates ?? []).filter((state) => {
      if (!mirroredCharacterIds.has(String(state.characterId))) return true;
      return (state.branchId ?? null) !== branchId;
    }),
    ...mirroredStates,
  ];

  // --- 物品 / 无档案人物 → world.entityRecords（基底世界里三表不覆盖的实体原样保留）---
  const tableCharacterIds = new Set<string>();
  for (const row of input.tables.characters.slice(0, characterCap)) {
    const characterId = characterIdFromRowId(row.id);
    if (characterId !== null) tableCharacterIds.add(characterId);
  }
  const tableItemIds = new Set<string>();
  for (const row of input.tables.items) {
    const entityId = entityIdFromItemRowId(row.id);
    if (entityId !== null) tableItemIds.add(entityId);
  }
  const passthroughRecords = (world.entityRecords ?? []).filter((record) => {
    const id = String(record.id);
    return !tableCharacterIds.has(id) && !tableItemIds.has(id);
  });
  const archiveIds = new Set((world.characters ?? []).map((character) => String(character.id)));
  const synthesized: EntityRecord[] = [];
  if (worldId.length > 0) {
    for (const row of input.tables.characters.slice(0, characterCap)) {
      const characterId = characterIdFromRowId(row.id);
      // 有档案的人物走 world.characters（档案是作者资产，本函数不改写）；只有三表的人物用 npc 实体登记
      if (characterId === null || archiveIds.has(characterId)) continue;
      synthesized.push({
        id: characterId,
        worldId,
        type: "npc",
        name: row.name,
        baseline: {},
        temporalSchema: [],
        ...(updatedAt > 0 ? { updatedAt } : {}),
      });
    }
    for (const row of input.tables.items) {
      const entityId = entityIdFromItemRowId(row.id);
      if (entityId === null) {
        pushWarning("ITEM_ID_NOT_MIRRORED", row.id);
        continue;
      }
      const baseline: Record<string, unknown> = {};
      const temporalSchema: EntityRecord["temporalSchema"] = [];
      if (row.description.trim().length > 0) {
        baseline.description = row.description;
        temporalSchema.push({ key: "description", kind: "base", valueType: "string" });
      }
      if (row.status.trim().length > 0) {
        baseline.status = row.status;
        temporalSchema.push({ key: "status", kind: "base", valueType: "string" });
      }
      // 持有关系不进镜像（决定 D-02）：EntityRecord 没有持有人字段，且 baseline 键必须已声明
      const pointId = row.locationId !== null ? pointIdOfRow.get(row.locationId) : undefined;
      const grid = row.gridX !== null && row.gridY !== null ? { x: row.gridX, y: row.gridY } : null;
      // lib 对 mapAnchor.x/y 有 0..100 硬上限：超范围宁可不写坐标，也不让整份 world 解析失败
      const anchorCoords = grid !== null && grid.x <= 100 && grid.y <= 100 ? grid : null;
      if (grid !== null && anchorCoords === null) pushWarning("ANCHOR_COORDS_DROPPED", row.id);
      const mapAnchor: EntityRecord["mapAnchor"] = pointId !== undefined
        ? { pointId: String(pointId), ...(anchorCoords ?? {}) }
        : anchorCoords !== null && row.mapId === "world" ? { ...anchorCoords } : undefined;
      synthesized.push({
        id: entityId,
        worldId,
        type: "item",
        name: row.name,
        baseline,
        temporalSchema,
        ...(mapAnchor !== undefined ? { mapAnchor } : {}),
        ...(updatedAt > 0 ? { updatedAt } : {}),
      });
    }
  }
  const mirroredRecords = [...passthroughRecords, ...synthesized];
  const entityRecords = mirroredRecords.slice(0, W0_LIMITS.maxEntityRecords);
  if (mirroredRecords.length > entityRecords.length) pushWarning("MIRROR_ROWS_TRUNCATED", "$.entityRecords");

  // 人物档案（world.characters）原样透传：名字/简介是作者资产，本函数不代模型改写
  return { world: { ...world, points, characterStates, entityRecords }, warnings };
}
