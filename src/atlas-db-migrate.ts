/**
 * atlas-db-migrate.ts — E11–E14：旧会话文档（`chatMetadata.atlas`）→ SQL 的一次性迁移。
 *
 * 依据 §7.2 / §7.4 / §16.9 与 §17E：
 * - **E11 inspectLegacySession**：区分空档、旧档、损坏档、已迁移档与新格式档。
 *   损坏数据**绝不**被判定成「无数据」（`corrupt` ≠ `empty`）。
 * - **E12 migrateLegacyEntities**：旧 locations/characters/items → SQL；
 *   先写 `entity_keys`（四张实体表的 BEFORE INSERT 触发器要求同分支同 ID 的身份行已在）；
 *   数量与稳定 ID 不减；`mapId` 显式换算（旧「mapId 等于地点 ID」约定已死）；
 *   旧 `rumors` 字符串 → `information` + 当地 `rumor_fronts`，**不给每个 NPC 建 knowledge**；
 *   旧抽象 period **不折算成秒**，历史标签进 `branches.calendar_label`，新时间轴从相对 0 开始；
 *   旧关系没有明确对象时保留描述待识别，不按同名随机匹配。
 * - **E13 migrateLegacySimulation**：旧 task/signal/delivery/topology → actions/information/
 *   rumor_fronts/knowledge/routes/channels；无法映射的保留 `blocked` 与原因，绝不静默丢弃。
 * - **E14 finalizeMigration**：校验（`foreign_key_check` + 20 表齐全 + 身份/详情配对）后写
 *   `PRAGMA user_version`；重开不会重复迁移、重复造世界。
 * - `legacyBackupPayload`：只构造旧档备份负载，不写任何存储。
 *
 * 幂等：重复导入同一份旧档时，已存在的行报 `ALREADY_IMPORTED` 并跳过，不重复插入。
 * 确定性：不使用 `Math.random`；所有铸造 ID 只依赖旧档内容与调用方注入的 `makeId`。
 */

import {
  AtlasDbError,
  beginTransaction,
  commitTransaction,
  foreignKeyCheck,
  queryBound,
  queryOne,
  releaseSavepoint,
  rollbackToSavepoint,
  rollbackTransaction,
  runBound,
  savepoint,
  userTableNames,
} from './atlas-db-runtime.ts';
import { buildInsertOrIgnoreSql, buildInsertSql, encodePartialRow, encodeRow } from './atlas-db-codec.ts';
import { createRow } from './atlas-db-defaults.ts';
import { ATLAS_SCHEMA_VERSION, ATLAS_TABLE_COLUMNS } from './atlas-db-schema.ts';
import type { CreateRowContext } from './atlas-db-defaults.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { AtlasTableName } from './atlas-db-contract.ts';
import type { Issue } from './atlas-ops-contract.ts';

/* ================================================================== *
 * 固定类型
 * ================================================================== */

export type LegacySession = { chatMetadata?: Record<string, unknown>; [key: string]: unknown };

export type LegacyCounts = {
  locations: number;
  characters: number;
  items: number;
  maps: number;
  rumors: number;
  simulationTasks: number;
};

export type LegacyPlan = {
  entityKeys: number;
  locations: number;
  characters: number;
  items: number;
  factions: number;
  information: number;
  fronts: number;
  skipped: number;
};

export type LegacyInspection = {
  kind: 'empty' | 'legacy' | 'corrupt' | 'already_migrated' | 'new_format';
  counts: LegacyCounts;
  reason: string;
  plan: LegacyPlan;
};

export type LegacyEntityContext = {
  branchId: string;
  turnId: string;
  makeId: (kind: string, opId: string, alias: string) => string;
  nowWallMs: number;
  rulesetVersion: string;
  /** 迁移基点的相对时间；缺省 0（旧 period 不折算秒）。 */
  clockS?: number;
};

export type LegacySimulationContext = {
  branchId: string;
  turnId: string;
  /** 与 §17E E13 固定签名一致；内部按三参数调用。 */
  makeId: (...args: never[]) => string;
  nowWallMs: number;
  rulesetVersion: string;
};

export type MigrationSkip = { kind: string; legacyId: string; reason: string };

export type LegacyMapped = Record<string, number>;

export type LegacyEntityMigrationResult = {
  mapped: LegacyMapped;
  issues: Issue[];
  skipped: MigrationSkip[];
};

export type LegacySimulationMigrationResult = {
  mapped: LegacyMapped;
  issues: Issue[];
  blocked: MigrationSkip[];
};

export type MigrationFinalizeResult = { ok: boolean; issues: Issue[] };

export type LegacyBackup = { kind: 'legacy_backup'; capturedWallMs: number; payload: unknown };

/** 旧根图的稳定 ID（旧约定里世界图就叫 `world`）。 */
const LEGACY_WORLD_MAP_ID = 'world';

/** 20 张用户表（来自 schema 常量，不另抄一份表名清单）。 */
const USER_TABLES: readonly string[] = Object.keys(ATLAS_TABLE_COLUMNS);

/* ================================================================== *
 * 小工具
 * ================================================================== */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function str(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function strList(value: unknown, max = 8): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = str(item);
    if (text.length > 0 && !out.includes(text) && out.length < max) out.push(text);
  }
  return out;
}

/** 稳定短哈希（FNV-1a）：只用于确定性 topic_key/content_hash，不是安全哈希。 */
function stableHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

function issue(code: string, path: string, message: string, severity: Issue['severity'] = 'warning', retryable = false): Issue {
  return { code, path, message, severity, retryable };
}

function bump(mapped: LegacyMapped, key: string, by = 1): void {
  mapped[key] = (mapped[key] ?? 0) + by;
}

/* ================================================================== *
 * E11：读取旧档结构（容错，不抛异常）
 * ================================================================== */

type BranchPayload = { key: string; payload: Record<string, unknown> };

type LegacySources = {
  atlas: Record<string, unknown>;
  tables: BranchPayload[];
  tablesPresent: boolean;
  world: Record<string, unknown> | null;
  maps: Record<string, unknown> | null;
  simulation: Record<string, unknown> | null;
  periodLabels: string[];
  /** 结构性损坏的描述（存在即说明这一块**不是**「没有数据」）。 */
  problems: string[];
};

/** 定位 `chatMetadata.atlas`（也接受把 atlas 文档本身直接传进来）。 */
function locateAtlas(raw: unknown): { atlas: Record<string, unknown> | null; problems: string[] } {
  const problems: string[] = [];
  if (!isPlainObject(raw)) return { atlas: null, problems: ['SESSION_NOT_OBJECT'] };
  const meta = (raw as LegacySession).chatMetadata;
  if (meta !== undefined && meta !== null && !isPlainObject(meta)) {
    problems.push('CHAT_METADATA_NOT_OBJECT');
  }
  let atlas: unknown = isPlainObject(meta) ? meta.atlas : undefined;
  if (atlas === undefined || atlas === null) atlas = raw.atlas;
  if (atlas === undefined || atlas === null) return { atlas: null, problems };
  if (!isPlainObject(atlas)) {
    problems.push('ATLAS_NOT_OBJECT');
    return { atlas: null, problems };
  }
  return { atlas, problems };
}

function collectPeriodLabels(atlas: Record<string, unknown>): string[] {
  const labels: string[] = [];
  const push = (value: unknown): void => {
    const text = str(value);
    if (text.length > 0 && !labels.includes(text)) labels.push(text);
  };
  push(atlas.period);
  push(atlas.periodLabel);
  push(atlas.calendarLabel);
  push(atlas.calendar_label);
  const world = atlas.world;
  if (isPlainObject(world)) {
    push(world.period);
    push(world.periodLabel);
    push(world.calendarLabel);
  }
  return labels;
}

/** 读取旧档的 tables / world / maps / simulation 四块；损坏只记 problem，绝不吞掉。 */
function readLegacySources(atlas: Record<string, unknown>): LegacySources {
  const problems: string[] = [];
  const tables: BranchPayload[] = [];
  let tablesPresent = false;

  const tablesRaw = atlas.tables;
  if (tablesRaw !== undefined && tablesRaw !== null) {
    tablesPresent = true;
    if (!isPlainObject(tablesRaw)) {
      problems.push('TABLES_NOT_OBJECT');
    } else if (hasOwn(tablesRaw, 'locations') || hasOwn(tablesRaw, 'characters') || hasOwn(tablesRaw, 'items')) {
      for (const key of ['locations', 'characters', 'items'] as const) {
        if (hasOwn(tablesRaw, key) && !Array.isArray(tablesRaw[key])) problems.push(`${key.toUpperCase()}_NOT_ARRAY`);
      }
      tables.push({ key: 'flat', payload: tablesRaw });
    } else if (isPlainObject(tablesRaw.branches)) {
      const branchIds = Object.keys(tablesRaw.branches).sort();
      if (branchIds.length === 0) problems.push('TABLES_BRANCHES_EMPTY');
      for (const branchKey of branchIds) {
        const payload = tablesRaw.branches[branchKey];
        if (!isPlainObject(payload)) {
          problems.push(`TABLES_BRANCH_${branchKey}_NOT_OBJECT`);
          continue;
        }
        for (const key of ['locations', 'characters', 'items'] as const) {
          if (hasOwn(payload, key) && !Array.isArray(payload[key])) problems.push(`${key.toUpperCase()}_NOT_ARRAY`);
        }
        tables.push({ key: branchKey, payload });
      }
    } else {
      problems.push('TABLES_SHAPE_UNKNOWN');
    }
  }

  let world: Record<string, unknown> | null = null;
  if (atlas.world !== undefined && atlas.world !== null) {
    if (!isPlainObject(atlas.world)) {
      problems.push('WORLD_NOT_OBJECT');
    } else {
      world = atlas.world;
      for (const key of ['points', 'characterStates', 'entityRecords', 'characters'] as const) {
        if (hasOwn(world, key) && !Array.isArray(world[key])) problems.push(`WORLD_${key.toUpperCase()}_NOT_ARRAY`);
      }
    }
  }

  let maps: Record<string, unknown> | null = null;
  if (atlas.maps !== undefined && atlas.maps !== null) {
    if (!isPlainObject(atlas.maps)) problems.push('MAPS_NOT_OBJECT');
    else maps = atlas.maps;
  }

  let simulation: Record<string, unknown> | null = null;
  if (atlas.simulation !== undefined && atlas.simulation !== null) {
    if (!isPlainObject(atlas.simulation)) {
      problems.push('SIMULATION_NOT_OBJECT');
    } else {
      simulation = atlas.simulation;
      if (hasOwn(simulation, 'branches') && !isPlainObject(simulation.branches)) problems.push('SIMULATION_BRANCHES_NOT_OBJECT');
      for (const key of ['tasks', 'signals', 'deliveries'] as const) {
        if (hasOwn(simulation, key) && !Array.isArray(simulation[key])) problems.push(`SIMULATION_${key.toUpperCase()}_NOT_ARRAY`);
      }
    }
  }

  return { atlas, tables, tablesPresent, world, maps, simulation, periodLabels: collectPeriodLabels(atlas), problems };
}

function hasLegacyPayload(sources: LegacySources): boolean {
  return sources.tablesPresent || sources.world !== null || sources.maps !== null || sources.simulation !== null;
}

/** 选择要迁移的分支载荷：优先同名分支，其次 `canon`，最后字典序最小；其余分支记诊断。 */
function selectBranchPayload(sources: LegacySources, branchId: string): { selected: BranchPayload | null; others: string[] } {
  if (sources.tables.length === 0) return { selected: null, others: [] };
  const byKey = new Map(sources.tables.map((entry) => [entry.key, entry]));
  const preferred = byKey.get(branchId) ?? byKey.get('canon') ?? [...sources.tables].sort((a, b) => (a.key < b.key ? -1 : 1))[0];
  return { selected: preferred ?? null, others: sources.tables.filter((entry) => entry !== preferred).map((entry) => entry.key) };
}

/* ================================================================== *
 * 旧行 → 候选（供 inspect 与 migrate 共用同一读数口径）
 * ================================================================== */

type CandidateKind = 'location' | 'character' | 'item' | 'faction' | 'relation';

type EntityCandidate = {
  kind: CandidateKind;
  legacyId: string;
  /** 旧档里的 0 起下标（铸造 ID 的稳定输入之一）。 */
  index: number;
  raw: Record<string, unknown>;
  /** 该行在旧档中的来源路径，仅用于诊断。 */
  origin: string;
};

type RumorCandidate = { locationId: string; locationName: string; text: string; origin: string };

type EntityCandidates = {
  locations: EntityCandidate[];
  characters: EntityCandidate[];
  items: EntityCandidate[];
  factions: EntityCandidate[];
  relations: EntityCandidate[];
  rumors: RumorCandidate[];
  skipped: MigrationSkip[];
  problems: string[];
};

function rowList(payload: Record<string, unknown>, key: 'locations' | 'characters' | 'items' | 'factions' | 'relations'): unknown[] {
  const value = payload[key];
  return Array.isArray(value) ? value : [];
}

function toCandidates(
  rows: unknown[],
  kind: CandidateKind,
  origin: string,
  skipped: MigrationSkip[],
): EntityCandidate[] {
  const out: EntityCandidate[] = [];
  rows.forEach((row, index) => {
    if (!isPlainObject(row)) {
      skipped.push({ kind, legacyId: '', reason: `ROW_NOT_OBJECT@${origin}[${index}]` });
      return;
    }
    out.push({ kind, legacyId: str(row.id), index, raw: row, origin: `${origin}[${index}]` });
  });
  return out;
}

/** 旧 `world` 镜像 → 三表候选（tables 缺失时的回退口径，§7.2「旧 world 只作一次迁移输入」）。 */
function worldCandidates(world: Record<string, unknown>, skipped: MigrationSkip[]): {
  locations: EntityCandidate[];
  characters: EntityCandidate[];
  items: EntityCandidate[];
} {
  const locations: EntityCandidate[] = [];
  const characters: EntityCandidate[] = [];
  const items: EntityCandidate[] = [];

  const points = Array.isArray(world.points) ? world.points : [];
  points.forEach((point, index) => {
    if (!isPlainObject(point)) {
      skipped.push({ kind: 'location', legacyId: '', reason: `WORLD_POINT_NOT_OBJECT[${index}]` });
      return;
    }
    const raw = point.id;
    const pointId = str(raw);
    if (pointId.length === 0) {
      skipped.push({ kind: 'location', legacyId: '', reason: `WORLD_POINT_ID_MISSING[${index}]` });
      return;
    }
    const parentId = str(point.parentPointId);
    locations.push({
      kind: 'location',
      legacyId: `loc:${pointId}`,
      index,
      origin: `$.world.points[${index}]`,
      raw: {
        id: `loc:${pointId}`,
        name: str(point.name) || `地点 ${pointId}`,
        mapId: LEGACY_WORLD_MAP_ID,
        gridX: point.x,
        gridY: point.y,
        parentLocationId: parentId.length > 0 ? `loc:${parentId}` : null,
        description: '',
        aliases: [],
        rumors: [],
        coordinateStatus: 'legacy-unknown',
      },
    });
  });

  const archiveNames = new Map<string, { name: string; description: string; role: string }>();
  for (const entry of Array.isArray(world.characters) ? world.characters : []) {
    if (!isPlainObject(entry)) continue;
    const id = str(entry.id);
    if (id.length === 0) continue;
    archiveNames.set(id, { name: str(entry.name), description: str(entry.description), role: str(entry.role) });
  }
  const records = Array.isArray(world.entityRecords) ? world.entityRecords : [];
  for (const record of records) {
    if (!isPlainObject(record)) continue;
    const id = str(record.id);
    if (id.length === 0) continue;
    const type = str(record.type).toLowerCase();
    if (isCharacterType(type)) {
      const baseline = isPlainObject(record.baseline) ? record.baseline : {};
      archiveNames.set(id, { name: str(record.name), description: str(baseline.description ?? baseline.summary), role: str(baseline.role ?? archiveNames.get(id)?.role) });
    }
  }
  const states = Array.isArray(world.characterStates) ? world.characterStates : [];
  const seenCharacters = new Set<string>();
  states.forEach((state, index) => {
    if (!isPlainObject(state)) {
      skipped.push({ kind: 'character', legacyId: '', reason: `WORLD_CHARACTER_STATE_NOT_OBJECT[${index}]` });
      return;
    }
    const characterId = str(state.characterId);
    if (characterId.length === 0) {
      skipped.push({ kind: 'character', legacyId: '', reason: `WORLD_CHARACTER_ID_MISSING[${index}]` });
      return;
    }
    seenCharacters.add(characterId);
    const archive = archiveNames.get(characterId);
    const pointId = str(state.currentPointId);
    characters.push({
      kind: 'character',
      legacyId: `npc:${characterId}`,
      index,
      origin: `$.world.characterStates[${index}]`,
      raw: {
        id: `npc:${characterId}`,
        name: archive?.name || characterId,
        description: archive?.description ?? '',
        role: archive?.role ?? '',
        locationId: pointId.length > 0 ? `loc:${pointId}` : null,
        currentAction: str(state.status),
        presence: null,
      },
    });
  });
  let archiveIndex = 0;
  for (const [id, archive] of [...archiveNames.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (seenCharacters.has(id)) continue;
    characters.push({
      kind: 'character',
      legacyId: `npc:${id}`,
      index: archiveIndex,
      origin: '$.world.characters',
      raw: { id: `npc:${id}`, name: archive.name || id, description: archive.description, role: archive.role, locationId: null },
    });
    archiveIndex += 1;
  }

  let itemIndex = 0;
  for (const record of records) {
    if (!isPlainObject(record)) {
      skipped.push({ kind: 'item', legacyId: '', reason: 'WORLD_ENTITY_NOT_OBJECT' });
      continue;
    }
    const id = str(record.id);
    if (id.length === 0) {
      skipped.push({ kind: 'item', legacyId: '', reason: 'WORLD_ENTITY_ID_MISSING' });
      continue;
    }
    const type = str(record.type).toLowerCase();
    if (isCharacterType(type) || isFactionType(type) || isNonItemType(type)) continue;
    const baseline = isPlainObject(record.baseline) ? record.baseline : {};
    const anchor = isPlainObject(record.mapAnchor) ? record.mapAnchor : null;
    const pointId = anchor ? str(anchor.pointId) : '';
    items.push({
      kind: 'item',
      legacyId: `item:${id}`,
      index: itemIndex,
      origin: `$.world.entityRecords[${itemIndex}]`,
      raw: {
        id: `item:${id}`,
        name: str(record.name) || id,
        description: str(baseline.description ?? baseline.summary),
        status: str(baseline.status),
        holderCharacterId: str(baseline.holderCharacterId ?? baseline.holder ?? baseline.owner) || null,
        locationId: pointId.length > 0 ? `loc:${pointId}` : null,
      },
    });
    itemIndex += 1;
  }

  return { locations, characters, items };
}

const CHARACTER_TYPES = new Set(['npc', 'character', 'person', 'char', '人物', '角色']);
const FACTION_TYPES = new Set(['faction', 'organization', 'org', 'group', 'guild', 'clan', 'party', '势力', '组织', '团体', '公会', '阵营']);
const NON_ITEM_TYPES = new Set(['city', 'region', 'nation', 'country', 'realm', 'location', 'place', '城市', '地区', '国家', '地点']);

function isCharacterType(type: string): boolean {
  return CHARACTER_TYPES.has(type);
}
function isFactionType(type: string): boolean {
  return FACTION_TYPES.has(type);
}
function isNonItemType(type: string): boolean {
  return NON_ITEM_TYPES.has(type);
}

/** 收集 14 类实体/关系/风声候选；inspect 与 migrate 用同一口径。 */
function collectEntityCandidates(raw: unknown, branchId: string): EntityCandidates & { branchKey: string; others: string[]; problems: string[] } {
  const skipped: MigrationSkip[] = [];
  const located = locateAtlas(raw);
  const atlas = located.atlas ?? {};
  const sources = readLegacySources(atlas);
  const problems = [...located.problems, ...sources.problems];
  const { selected, others } = selectBranchPayload(sources, branchId);
  const branchKey = selected?.key ?? '';

  let locations: EntityCandidate[] = [];
  let characters: EntityCandidate[] = [];
  let items: EntityCandidate[] = [];

  if (selected) {
    locations = toCandidates(rowList(selected.payload, 'locations'), 'location', `$.tables.${selected.key}.locations`, skipped);
    characters = toCandidates(rowList(selected.payload, 'characters'), 'character', `$.tables.${selected.key}.characters`, skipped);
    items = toCandidates(rowList(selected.payload, 'items'), 'item', `$.tables.${selected.key}.items`, skipped);
    // Stable IDs supply archive-only identity fields; current table positions remain authoritative.
    if (sources.world) {
      const archives = new Map(worldCandidates(sources.world, []).characters.map(row => [row.legacyId, row.raw]));
      characters = characters.map(row => {
        const archive = archives.get(row.legacyId);
        return archive && !str(row.raw.role) ? {...row, raw:{...row.raw, role:archive.role}} : row;
      });
    }
  } else if (sources.world) {
    const fromWorld = worldCandidates(sources.world, skipped);
    locations = fromWorld.locations;
    characters = fromWorld.characters;
    items = fromWorld.items;
  }

  const retired = new Set(isPlainObject(atlas.scene)&&Array.isArray(atlas.scene.retiredPointIds)
    ? atlas.scene.retiredPointIds.map(value=>String(value).replace(/^loc:/,'')) : []);
  locations=locations.map(row=>retired.has(row.legacyId.replace(/^loc:/,''))
    ? {...row,raw:{...row.raw,status:'archived'}} : row);

  const factions: EntityCandidate[] = [];
  if (selected) {
    factions.push(...toCandidates(rowList(selected.payload, 'factions'), 'faction', `$.tables.${selected.key}.factions`, skipped));
    // 旧地点行内嵌的 `factions: string[]` 名单：按名字建档（名字本身就是稳定输入）。
    const byName = new Map<string, EntityCandidate>();
    for (const location of locations) {
      for (const name of strList(location.raw.factions, 20)) {
        if (byName.has(name)) continue;
        byName.set(name, {
          kind: 'faction',
          legacyId: '',
          index: byName.size,
          origin: `${location.origin}.factions`,
          raw: { id: '', name, kind: 'other', description: '', _fromLocation: location.legacyId },
        });
      }
    }
    factions.push(...byName.values());
  }
  if (sources.world) {
    const records = Array.isArray(sources.world.entityRecords) ? sources.world.entityRecords : [];
    records.forEach((record, index) => {
      if (!isPlainObject(record)) return;
      if (!isFactionType(str(record.type).toLowerCase())) return;
      const id = str(record.id);
      const baseline = isPlainObject(record.baseline) ? record.baseline : {};
      factions.push({
        kind: 'faction',
        legacyId: id,
        index,
        origin: `$.world.entityRecords[${index}]`,
        raw: { id, name: str(record.name) || id, description: str(baseline.description ?? baseline.summary) },
      });
    });
  }

  const relations: EntityCandidate[] = [];
  if (selected) {
    relations.push(...toCandidates(rowList(selected.payload, 'relations'), 'relation', `$.tables.${selected.key}.relations`, skipped));
  }
  // 人物行内嵌的 `relations`：只有显式 ID 才能解析，绝不按同名匹配。
  for (const character of characters) {
    const list = character.raw.relations;
    if (!Array.isArray(list)) continue;
    list.forEach((entry, index) => {
      const raw2: Record<string, unknown> = isPlainObject(entry)
        ? { subjectId: character.legacyId, ...entry }
        : { subjectId: character.legacyId, description: str(entry) };
      relations.push({
        kind: 'relation',
        legacyId: str(raw2.id),
        index,
        raw: raw2,
        origin: `${character.origin}.relations[${index}]`,
      });
    });
  }

  const rumors: RumorCandidate[] = [];
  for (const location of locations) {
    for (const text of strList(location.raw.rumors, 20)) {
      rumors.push({ locationId: location.legacyId, locationName: str(location.raw.name), text, origin: `${location.origin}.rumors` });
    }
  }

  return { locations, characters, items, factions, relations, rumors, skipped, branchKey, others, problems };
}

function emptyPlan(): LegacyPlan {
  return { entityKeys: 0, locations: 0, characters: 0, items: 0, factions: 0, information: 0, fronts: 0, skipped: 0 };
}

function countMaps(sources: LegacySources): number {
  let maps = sources.world !== null && Array.isArray(sources.world.points) && sources.world.points.length > 0 ? 1 : 0;
  if (sources.maps) {
    maps = 1; // 旧地图文档本身就描述根世界图
    const submaps = sources.maps.submaps;
    if (isPlainObject(submaps)) maps += Object.keys(submaps).length;
  }
  return maps;
}

function countSimulationTasks(sources: LegacySources): number {
  const simulation = sources.simulation;
  if (!simulation) return 0;
  if (Array.isArray(simulation.tasks)) return simulation.tasks.length;
  const branches = simulation.branches;
  if (!isPlainObject(branches)) return 0;
  let total = 0;
  for (const key of Object.keys(branches).sort()) {
    const branch = branches[key];
    if (isPlainObject(branch) && Array.isArray(branch.tasks)) total += branch.tasks.length;
  }
  return total;
}

/**
 * E11 inspectLegacySession。
 * 完成定义：损坏数据不判定为「无数据」。
 */
export function inspectLegacySession(raw: unknown): LegacyInspection {
  const emptyCounts: LegacyCounts = { locations: 0, characters: 0, items: 0, maps: 0, rumors: 0, simulationTasks: 0 };
  const empty = (kind: LegacyInspection['kind'], reason: string): LegacyInspection => ({
    kind,
    counts: { ...emptyCounts },
    reason,
    plan: emptyPlan(),
  });

  // 传进来的是（可能被截断的）JSON 文本：语法错误就是损坏档，不是空档。
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text.length === 0) return empty('empty', 'EMPTY_TEXT');
    try {
      return inspectLegacySession(JSON.parse(text));
    } catch (err) {
      return empty('corrupt', `JSON_SYNTAX: ${(err as Error).message}`);
    }
  }
  if (raw === undefined || raw === null) return empty('empty', 'NO_SESSION_DOCUMENT');
  if (!isPlainObject(raw)) return empty('corrupt', `SESSION_NOT_OBJECT: ${typeof raw}`);

  const located = locateAtlas(raw);
  if (located.problems.length > 0 && located.atlas === null) {
    return empty('corrupt', located.problems.join(', '));
  }
  if (located.atlas === null) return empty('empty', 'NO_ATLAS_METADATA');
  const atlas = located.atlas;

  // 新格式信封：`chatMetadata.atlas.database`（§7.1 存档）。
  if (atlas.database !== undefined && atlas.database !== null) {
    if (!isPlainObject(atlas.database)) return empty('corrupt', 'DATABASE_ENVELOPE_NOT_OBJECT');
    const envelope = atlas.database;
    const format = str(envelope.format);
    const data = typeof envelope.data === 'string' ? envelope.data : '';
    const schemaVersion = num(envelope.schema_version);
    if (format !== 'atlas-sqlite' || schemaVersion === null || data.length === 0) {
      return empty('corrupt', `DATABASE_ENVELOPE_INVALID: format=${format || 'missing'}, data=${data.length}B, schema_version=${schemaVersion ?? 'missing'}`);
    }
    const sources = readLegacySources(atlas);
    if (hasLegacyPayload(sources)) {
      return {
        kind: 'already_migrated',
        counts: { ...emptyCounts },
        reason: 'SQLITE_ENVELOPE_PRESENT_LEGACY_KEPT_AS_BACKUP',
        plan: emptyPlan(),
      };
    }
    return { kind: 'new_format', counts: { ...emptyCounts }, reason: 'SQLITE_ENVELOPE_ONLY', plan: emptyPlan() };
  }

  const sources = readLegacySources(atlas);
  if (!hasLegacyPayload(sources)) {
    if (sources.problems.length > 0) return empty('corrupt', sources.problems.join(', '));
    return empty('empty', 'NO_LEGACY_PAYLOAD');
  }

  const candidates = collectEntityCandidates(raw, '');
  // 有载荷且结构可读 → 旧档；结构问题与可用数据并存时仍报 legacy，但把问题留在 reason 中。
  const usableRows =
    candidates.locations.length + candidates.characters.length + candidates.items.length + candidates.factions.length + candidates.relations.length;
  if (usableRows === 0 && candidates.problems.length > 0) {
    return empty('corrupt', candidates.problems.join(', '));
  }

  const skipped = [...candidates.skipped];
  let locations = 0;
  let characters = 0;
  let items = 0;
  let factions = 0;
  for (const candidate of candidates.locations) {
    if (str(candidate.raw.name).length === 0) {
      skipped.push({ kind: 'location', legacyId: candidate.legacyId, reason: 'NAME_MISSING' });
      continue;
    }
    locations += 1;
  }
  for (const candidate of candidates.characters) {
    if (str(candidate.raw.name).length === 0) {
      skipped.push({ kind: 'character', legacyId: candidate.legacyId, reason: 'NAME_MISSING' });
      continue;
    }
    characters += 1;
  }
  for (const candidate of candidates.items) {
    if (str(candidate.raw.name).length === 0) {
      skipped.push({ kind: 'item', legacyId: candidate.legacyId, reason: 'NAME_MISSING' });
      continue;
    }
    items += 1;
  }
  for (const candidate of candidates.factions) {
    if (str(candidate.raw.name).length === 0) {
      skipped.push({ kind: 'faction', legacyId: candidate.legacyId, reason: 'NAME_MISSING' });
      continue;
    }
    factions += 1;
  }

  const knownLocations = new Set(candidates.locations.filter((c) => str(c.raw.name).length > 0).map((c) => c.legacyId));
  const fronts = candidates.rumors.filter((rumor) => knownLocations.has(rumor.locationId)).length;

  const plan: LegacyPlan = {
    entityKeys: locations + characters + items + factions,
    locations,
    characters,
    items,
    factions,
    information: candidates.rumors.length,
    fronts,
    skipped: skipped.length,
  };
  const counts: LegacyCounts = {
    locations,
    characters,
    items,
    maps: countMaps(sources),
    rumors: candidates.rumors.length,
    simulationTasks: countSimulationTasks(sources),
  };

  const reasons: string[] = [`LEGACY_DOCUMENT@${candidates.branchKey || 'flat'}`];
  if (candidates.others.length > 0) reasons.push(`OTHER_BRANCHES_NOT_MIGRATED: ${candidates.others.join(',')}`);
  if (candidates.problems.length > 0) reasons.push(`STRUCTURE_PROBLEMS: ${candidates.problems.join(',')}`);

  return { kind: 'legacy', counts, reason: reasons.join(' | '), plan };
}

/* ================================================================== *
 * E12：旧实体 → SQL
 * ================================================================== */

const LOCATION_KINDS = new Set(['region', 'city', 'district', 'building', 'room', 'natural', 'vehicle', 'other']);
const ITEM_KINDS = new Set(['object', 'resource', 'document', 'equipment', 'container', 'other']);
const ITEM_STATUSES = new Set(['active', 'consumed', 'destroyed', 'lost', 'merged', 'archived']);
const FACTION_KINDS = new Set(['nation', 'organization', 'family', 'team', 'other']);
const RELATION_KINDS = new Set(['member_of', 'leads', 'controls', 'knows', 'kinship', 'ally', 'hostile', 'owes', 'protects', 'other']);

function mapLocationKind(value: unknown): string {
  const key = str(value).toLowerCase();
  if (LOCATION_KINDS.has(key)) return key;
  const aliases: Record<string, string> = {
    town: 'city',
    village: 'city',
    city: 'city',
    street: 'district',
    area: 'district',
    market: 'district',
    house: 'building',
    shop: 'building',
    temple: 'building',
    inn: 'building',
    forest: 'natural',
    mountain: 'natural',
    lake: 'natural',
    sea: 'natural',
    river: 'natural',
    wild: 'natural',
    carriage: 'vehicle',
    cart: 'vehicle',
    ship: 'vehicle',
    boat: 'vehicle',
    point: 'other',
    '城市': 'city',
    '地区': 'region',
    '区域': 'region',
    '建筑': 'building',
    '房屋': 'building',
    '房间': 'room',
    '室内': 'room',
    '自然': 'natural',
    '载具': 'vehicle',
    '车辆': 'vehicle',
  };
  return aliases[key] ?? 'other';
}

function containerMapKind(locationKind: string): 'region' | 'site' | 'interior' {
  if (locationKind === 'region' || locationKind === 'city' || locationKind === 'district') return 'region';
  if (locationKind === 'room' || locationKind === 'vehicle') return 'interior';
  return 'site';
}

function mapItemKind(value: unknown): string {
  const key = str(value).toLowerCase();
  if (ITEM_KINDS.has(key)) return key;
  if (['weapon', 'armor', 'tool', 'equipment', '武器', '装备', '护甲'].includes(key)) return 'equipment';
  if (['book', 'letter', 'document', '书籍', '信件', '文件'].includes(key)) return 'document';
  if (['bag', 'box', 'container', '箱', '包'].includes(key)) return 'container';
  if (['resource', 'material', '资源', '材料'].includes(key)) return 'resource';
  return 'other';
}

function mapItemStatus(value: unknown): string {
  const key = str(value).toLowerCase();
  if (ITEM_STATUSES.has(key)) return key;
  if (['已销毁', 'destroyed', 'destroy'].includes(key)) return 'destroyed';
  if (['已消耗', 'consumed', 'used'].includes(key)) return 'consumed';
  if (['丢失', 'lost'].includes(key)) return 'lost';
  if (['已合并', 'merged'].includes(key)) return 'merged';
  if (['已归档', 'archived'].includes(key)) return 'archived';
  return 'active';
}

function mapPhysicalStatus(value: unknown): string {
  const key = str(value).toLowerCase();
  if (['alive', 'incapacitated', 'dead', 'unknown'].includes(key)) return key;
  if (['存活', '活着', 'alive'].includes(key)) return 'alive';
  if (['死亡', '已死', 'dead'].includes(key)) return 'dead';
  if (['重伤', '昏迷', 'incapacitated'].includes(key)) return 'incapacitated';
  return 'unknown';
}

function mapImportance(value: unknown): string {
  const key = str(value).toLowerCase();
  if (['core', 'recurring', 'supporting'].includes(key)) return key;
  if (['核心', '关键', 'core', 'main'].includes(key)) return 'core';
  if (['常驻', '重要', 'recurring'].includes(key)) return 'recurring';
  return 'supporting';
}

function mapRole(value: unknown): string {
  const key = str(value).toLowerCase();
  if (['protagonist', 'companion', 'npc'].includes(key)) return key;
  if (['主角', '主人公', 'protagonist'].includes(key)) return 'protagonist';
  if (['同伴', '伙伴', 'companion'].includes(key)) return 'companion';
  return 'npc';
}

function mapFactionKind(value: unknown): string {
  const key = str(value).toLowerCase();
  if (FACTION_KINDS.has(key)) return key;
  if (['国家', '王国', 'nation', 'country'].includes(key)) return 'nation';
  if (['家族', 'family', 'clan'].includes(key)) return 'family';
  if (['小队', 'team', 'party'].includes(key)) return 'team';
  if (['组织', '团体', 'organization', 'org', 'guild'].includes(key)) return 'organization';
  return 'other';
}

function mapRelationKind(value: unknown): string {
  const key = str(value).toLowerCase();
  if (RELATION_KINDS.has(key)) return key;
  const aliases: Record<string, string> = {
    member: 'member_of',
    belongs_to: 'member_of',
    '成员': 'member_of',
    lead: 'leads',
    '首领': 'leads',
    control: 'controls',
    '控制': 'controls',
    know: 'knows',
    '认识': 'knows',
    family: 'kinship',
    '亲属': 'kinship',
    friend: 'ally',
    '盟友': 'ally',
    enemy: 'hostile',
    '敌对': 'hostile',
    debt: 'owes',
    protect: 'protects',
    '保护': 'protects',
  };
  return aliases[key] ?? 'other';
}

/** 行是否已存在（幂等检测：同一旧 ID 不重复插入）。 */
function rowExists(db: SqlDatabase, table: AtlasTableName, branchId: string, id: string): boolean {
  if (id.length === 0) return false;
  const rows = queryBound(db, `SELECT 1 AS present FROM ${table} WHERE branch_id = ? AND id = ? LIMIT 1`, [branchId, id]);
  return rows.length > 0;
}

function insertRow(db: SqlDatabase, table: AtlasTableName, input: Record<string, unknown>, ctx: CreateRowContext): void {
  const row = createRow(table, input, ctx);
  const encoded = encodeRow(table, row, { requireAll: true });
  if (!encoded.ok) {
    throw new AtlasDbError('CODEC_ENCODE_FAILED', `迁移写入前编码失败：${encoded.issues.map((i) => i.path).join(', ')}`, {
      issues: encoded.issues,
      table,
    });
  }
  runBound(db, buildInsertSql(table, encoded.columns), encoded.values);
}

function insertEntityKey(db: SqlDatabase, branchId: string, id: string, kind: 'location' | 'character' | 'item' | 'faction'): void {
  const encoded = encodePartialRow('entity_keys', { branch_id: branchId, id, kind });
  if (!encoded.ok) {
    throw new AtlasDbError('CODEC_ENCODE_FAILED', `entity_keys 编码失败：${encoded.issues.map((i) => i.path).join(', ')}`, {
      issues: encoded.issues,
    });
  }
  runBound(db, buildInsertOrIgnoreSql('entity_keys', encoded.columns), encoded.values);
}

/** 逐行 SAVEPOINT：单行失败只丢掉该行并留诊断，不拖垮整次迁移。 */
let savepointCounter = 0;
function withSavepoint(db: SqlDatabase, fn: () => void): { ok: true } | { ok: false; message: string } {
  savepointCounter += 1;
  const name = `mig_row_${savepointCounter}`;
  savepoint(db, name);
  try {
    fn();
    releaseSavepoint(db, name);
    return { ok: true };
  } catch (err) {
    try {
      rollbackToSavepoint(db, name);
    } catch {
      /* 回滚失败不影响下面的记账 */
    }
    try {
      releaseSavepoint(db, name);
    } catch {
      /* 同上 */
    }
    return { ok: false, message: (err as Error).message };
  }
}

/** 旧 period / 时间抽象字段名：**不**折算成秒，只保留标签。 */
const PERIOD_FIELDS = ['period', 'createdPeriod', 'publishedPeriod', 'receivedPeriod', 'nextEligiblePeriod', 'worldTimeCursor', 'periodLabel'] as const;

function findPeriodLabel(raw: Record<string, unknown>): string | null {
  for (const field of PERIOD_FIELDS) {
    if (hasOwn(raw, field)) {
      const value = str(raw[field]);
      if (value.length > 0) return `${field}=${value}`;
    }
  }
  return null;
}

type MapResolverState = {
  cache: Map<string, string | null>;
  issues: Issue[];
  created: number;
};

function describeProblem(path: string, message: string, code: string): Issue {
  return issue(code, path, message, 'warning', true);
}

/** `mapId` 显式换算（旧「mapId 等于地点 ID」约定已死）。 */
function resolveMapRef(
  db: SqlDatabase,
  ctx: LegacyEntityContext,
  state: MapResolverState,
  legacyMapId: string,
  mapsDoc: Record<string, unknown> | null,
  locationById: Map<string, { name: string; kind: string }>,
): string | null {
  if (legacyMapId.length === 0) return null;
  const cached = state.cache.get(legacyMapId);
  if (cached !== undefined) return cached;

  const existing = queryOne(db, 'SELECT id FROM maps WHERE branch_id = ? AND id = ? LIMIT 1', [ctx.branchId, legacyMapId]);
  if (existing) {
    const id = String(existing.id);
    state.cache.set(legacyMapId, id);
    return id;
  }

  const frame = mapsFrame(mapsDoc,legacyMapId);
  const calibration = mapsCalibration(mapsDoc, legacyMapId);

  // 1) 旧根世界图：没有根图就按需建一张（这就是「旧 maps 文档确实描述过」的那张图）。
  if (legacyMapId === LEGACY_WORLD_MAP_ID) {
    const root = queryOne(
      db,
      "SELECT id FROM maps WHERE branch_id = ? AND container_location_id IS NULL AND status = 'active' ORDER BY id LIMIT 1",
      [ctx.branchId],
    );
    if (root) {
      const id = String(root.id);
      state.cache.set(legacyMapId, id);
      return id;
    }
    if (rowExists(db, 'maps', ctx.branchId, LEGACY_WORLD_MAP_ID)) {
      state.cache.set(legacyMapId, LEGACY_WORLD_MAP_ID);
      return LEGACY_WORLD_MAP_ID;
    }
    const created = withSavepoint(db, () => {
      insertRow(
        db,
        'maps',
        {
          name: str(mapsDoc?.name) || '世界图',
          kind: 'world',
          frame_json: frame,
          meters_per_cell: calibration,
          scale_min_meters_per_cell: calibration,
          scale_max_meters_per_cell: calibration,
          scale_quality: calibration === null ? 'uncalibrated' : 'estimated',
          scale_basis_json: { refs: [], note: '迁移自旧地图文档；未标定则保持 uncalibrated' },
        },
        { ...ctx, id: LEGACY_WORLD_MAP_ID, clockS: ctx.clockS ?? 0 },
      );
    });
    if (!created.ok) {
      state.issues.push(issue('LEGACY_MAP_CREATE_FAILED', `$.maps.${legacyMapId}`, `旧根图建档失败：${created.message}`, 'warning', true));
      state.cache.set(legacyMapId, null);
      return null;
    }
    state.created += 1;
    state.issues.push(
      issue('LEGACY_MAP_CREATED', `$.maps.${legacyMapId}`, `按旧地图文档建立根图 rows=1（id=${LEGACY_WORLD_MAP_ID}）`, 'warning', false),
    );
    state.cache.set(legacyMapId, LEGACY_WORLD_MAP_ID);
    return LEGACY_WORLD_MAP_ID;
  }

  // 2) 旧 sidecar **确实描述过**的子图（键是宿主地点 id）：建立容器图，完成显式换算。
  //    只有旧地图文档描述过的图才会被建出来；「mapId 恰好等于某个地点 ID」不会凭空造图。
  if (mapsDoc) {
    const submaps = isPlainObject(mapsDoc.submaps) ? mapsDoc.submaps : null;
    const pointKey = legacyMapId.startsWith('loc:') ? legacyMapId.slice(4) : legacyMapId;
    const described = submaps !== null && (hasOwn(submaps, legacyMapId) || hasOwn(submaps, pointKey));
    const host = locationById.get(legacyMapId);
    if (described) {
      const existingContainer = queryOne(
        db,
        "SELECT id FROM maps WHERE branch_id = ? AND container_location_id = ? AND status = 'active' LIMIT 1",
        [ctx.branchId, legacyMapId],
      );
      if (existingContainer) {
        const id = String(existingContainer.id);
        state.cache.set(legacyMapId, id);
        return id;
      }
      const mapId = ctx.makeId('map', 'migration.container_map', `${ctx.branchId}:${legacyMapId}`);
      const created = withSavepoint(db, () => {
        insertRow(
          db,
          'maps',
          {
            name: `${host?.name ?? legacyMapId}·内部`,
            kind: containerMapKind(host?.kind ?? 'other'),
            container_location_id: host ? legacyMapId : null,
            frame_json: frame,
            meters_per_cell: calibration,
            scale_min_meters_per_cell: calibration,
            scale_max_meters_per_cell: calibration,
            scale_quality: calibration === null ? 'uncalibrated' : 'estimated',
            scale_basis_json: { refs: [], note: '迁移自旧地图文档的子图' },
          },
          { ...ctx, id: mapId, clockS: ctx.clockS ?? 0 },
        );
      });
      if (!created.ok) {
        state.issues.push(issue('LEGACY_MAP_CREATE_FAILED', `$.maps.${legacyMapId}`, `旧子图建档失败：${created.message}`, 'warning', true));
        state.cache.set(legacyMapId, null);
        return null;
      }
      state.created += 1;
      state.issues.push(
        issue(
          'LEGACY_MAP_CONVERTED',
          `$.maps.${legacyMapId}`,
          `旧「mapId 等于地点 ID」约定已死：为 ${legacyMapId} 建立独立容器图 ${mapId}（不再把地点 ID 当地图 ID）`,
          'warning',
          false,
        ),
      );
      state.cache.set(legacyMapId, mapId);
      return mapId;
    }
  }

  // 3) 无法解析：坐标不静默丢弃，改为保留粗位置 + 具名警告。
  if (!state.cache.has(legacyMapId)) {
    state.issues.push(
      issue(
        'LEGACY_MAP_UNRESOLVED',
        `$.maps.${legacyMapId}`,
        `旧 mapId「${legacyMapId}」不对应任何真实地图：保留实体粗位置，坐标置空（不猜地图，也不把坐标塞进别的地图）`,
        'warning',
        false,
      ),
    );
  }
  state.cache.set(legacyMapId, null);
  return null;
}

function mapsFrame(mapsDoc: Record<string, unknown> | null,mapId='world'): Record<string, number> {
  const fallback = { origin_x: 0, origin_y: 0, cols:100,rows:100,reference_width_cells: 100, reference_height_cells: 100 };
  if (!mapsDoc) return fallback;
  const submaps=isPlainObject(mapsDoc.submaps)?mapsDoc.submaps:{};
  const sub=submaps[mapId]??submaps[mapId.replace(/^loc:/,'')];
  const frame = mapId!=='world'&&isPlainObject(sub)&&isPlainObject(sub.frame)?sub.frame:isPlainObject(mapsDoc.frame) ? mapsDoc.frame : null;
  if (!frame) return fallback;
  const cols = num(frame.cols) ?? num(frame.reference_width_cells);
  const rows = num(frame.rows) ?? num(frame.reference_height_cells);
  return {
    origin_x: num(frame.origin_x) ?? 0,
    origin_y: num(frame.origin_y) ?? 0,
    cols:cols!==null&&cols>0?cols:100,
    rows:rows!==null&&rows>0?rows:100,
    reference_width_cells: cols !== null && cols > 0 ? cols : fallback.reference_width_cells,
    reference_height_cells: rows !== null && rows > 0 ? rows : fallback.reference_height_cells,
  };
}

function mapsCalibration(mapsDoc: Record<string, unknown> | null, mapId: string): number | null {
  if (!mapsDoc) return null;
  const calibrations = isPlainObject(mapsDoc.calibrations) ? mapsDoc.calibrations : null;
  if (!calibrations) return null;
  const entry = calibrations[mapId];
  if (!isPlainObject(entry)) return null;
  const distancePerCell = num(entry.metersPerCell) ?? num(entry.meters_per_cell) ?? (str(entry.unit).toLowerCase()==='m'||str(entry.unit)==='米'?num(entry.distancePerCell):null);
  return distancePerCell !== null && distancePerCell > 0 ? distancePerCell : null;
}

/**
 * E12 migrateLegacyEntities。
 * 完成定义：数量与稳定 ID 不减；持有人坐标正确；旧 rumors 不让人人知；旧 period 不编秒数。
 */
/** Restore legacy map references only after real SQL container maps have been created. */
export function restoreLegacySceneMaps(raw:unknown,db:SqlDatabase,ctx:{branchId:string}):Issue[]{
  const issues:Issue[]=[],candidates=collectEntityCandidates(raw,ctx.branchId);
  const sources=readLegacySources(locateAtlas(raw).atlas??{});
  const maps=queryBound(db,"SELECT id,container_location_id,frame_json FROM maps WHERE branch_id=? AND status='active'",[ctx.branchId]);
  const locations=new Set(queryBound(db,'SELECT id FROM locations WHERE branch_id=?',[ctx.branchId]).map(row=>String(row.id)));
  const resolveMap=(legacyId:string)=>maps.find(map=>legacyId==='world'?!map.container_location_id:
    map.container_location_id===legacyId||map.container_location_id===`loc:${legacyId}`);
  for(const [table,rows] of [['locations',candidates.locations],['characters',candidates.characters],['items',candidates.items]] as const){
    for(const candidate of rows){
      const x=num(candidate.raw.gridX??candidate.raw.x),y=num(candidate.raw.gridY??candidate.raw.y),legacyMapId=str(candidate.raw.mapId??candidate.raw.map_id);
      if(x===null||y===null||!legacyMapId)continue;
      const row=queryOne(db,`SELECT * FROM ${table} WHERE branch_id=? AND id=?`,[ctx.branchId,candidate.legacyId]);
      if(!row||row.status==='archived'||table==='items'&&(row.holder_character_id||row.container_item_id))continue;
      const map=resolveMap(legacyMapId);if(!map)continue;
      const expected=table==='locations'?row.parent_location_id:row.location_id;
      if(table==='locations'?(map.container_location_id??null)!==(expected??null):!expected||map.container_location_id!==expected)continue;
      const frame=JSON.parse(String(map.frame_json)) as {cols?:number;rows?:number};
      if(x<0||y<0||x>(frame.cols??100)||y>(frame.rows??100)){
        issues.push(describeProblem(candidate.origin,'旧坐标超出当前地图；原坐标保留在旧档，显示布局另行估计','LEGACY_COORDS_OUT_OF_FRAME'));continue;
      }
      runBound(db,`UPDATE ${table} SET map_id=?,grid_x=?,grid_y=?,coord_precision=? WHERE branch_id=? AND id=?`,
        [String(map.id),x,y,candidate.raw.coordinateStatus==='confirmed'?'exact':'approximate',ctx.branchId,candidate.legacyId]);
    }
  }
  const calibrations=isPlainObject(sources.maps?.calibrations)?sources.maps.calibrations:{};
  for(const [legacyId,rawCalibration] of Object.entries(calibrations)){
    if(!isPlainObject(rawCalibration))continue;
    const locationId=legacyId.startsWith('loc:')?legacyId:`loc:${legacyId}`;
    if(legacyId!=='world'&&!locations.has(locationId)&&!locations.has(legacyId))continue;
    const map=resolveMap(legacyId),meters=num(rawCalibration.metersPerCell??rawCalibration.meters_per_cell);
    // Legacy distances with an unknown unit are not re-labelled as metres.
    if(!map||meters===null||meters<=0)continue;
    const locked=rawCalibration.locked===true;
    runBound(db,'UPDATE maps SET meters_per_cell=?,scale_min_meters_per_cell=?,scale_max_meters_per_cell=?,scale_quality=?,scale_locked=?,calibration_rev=? WHERE branch_id=? AND id=?',
      [meters,meters,meters,locked?'confirmed':'estimated',locked?1:0,Math.max(1,num(rawCalibration.revision)??1),ctx.branchId,String(map.id)]);
  }
  return issues;
}

export function migrateLegacyEntities(
  plan: LegacyInspection,
  raw: unknown,
  db: SqlDatabase,
  ctx: LegacyEntityContext,
): LegacyEntityMigrationResult {
  const issues: Issue[] = [];
  const skipped: MigrationSkip[] = [];
  const mapped: LegacyMapped = {};
  const clockS = ctx.clockS ?? 0;
  if (plan.kind === 'corrupt') {
    // 损坏档绝不静默当成「没有数据」：拒绝迁移并留下具体原因。
    return {
      mapped,
      issues: [issue('LEGACY_CORRUPT', '$', `旧档损坏（${plan.reason}）：拒绝迁移，先修复或导出旧档备份`, 'error', false)],
      skipped,
    };
  }
  if (plan.kind === 'new_format' || plan.kind === 'already_migrated') {
    return {
      mapped,
      issues: [
        issue(
          'ALREADY_IMPORTED',
          '$',
          `会话文档里已有 SQLite 存档信封（${plan.kind}）：不重复导入旧三表，避免重复造世界`,
          'warning',
          false,
        ),
      ],
      skipped,
    };
  }
  const located = locateAtlas(raw);
  const atlas = located.atlas ?? {};
  const sources = readLegacySources(atlas);
  const candidates = collectEntityCandidates(raw, ctx.branchId);
  for (const problem of [...located.problems, ...sources.problems, ...candidates.problems]) {
    issues.push(describeProblem('$', `旧档结构问题：${problem}`, 'LEGACY_STRUCTURE_PROBLEM'));
  }
  if (candidates.others.length > 0) {
    issues.push(
      describeProblem(
        '$',
        `旧档里还有未迁移的分支快照：${candidates.others.join(', ')}（本分支 ${candidates.branchKey || 'flat'} 已迁移，其余分支保留在旧档备份里待显式导入）`,
        'LEGACY_OTHER_BRANCHES_SKIPPED',
      ),
    );
  }
  skipped.push(...candidates.skipped);

  const mapsDoc = sources.maps;
  const mapState: MapResolverState = { cache: new Map(), issues: [], created: 0 };
  const rowCtx: CreateRowContext = {
    branchId: ctx.branchId,
    id: '',
    turnId: ctx.turnId,
    clockS,
    nowWallMs: ctx.nowWallMs,
    rulesetVersion: ctx.rulesetVersion,
  };

  const branch = queryOne(db, 'SELECT id FROM branches WHERE id = ? LIMIT 1', [ctx.branchId]);
  if (!branch) {
    return {
      mapped,
      issues: [issue('REF_UNKNOWN', '$.branchId', `目标分支不存在：${ctx.branchId}`, 'error', true)],
      skipped,
    };
  }

  // 旧 period 只是历史标签：写进 branches.calendar_label（不参与算术），时间轴从相对 0 开始。
  const periodLabels = [...sources.periodLabels];
  for (const candidate of [...candidates.locations, ...candidates.characters, ...candidates.items, ...candidates.factions]) {
    const label = findPeriodLabel(candidate.raw);
    if (label !== null && !periodLabels.includes(label)) periodLabels.push(label);
  }
  for (const label of periodLabels) {
    issues.push(
      issue(
        'PERIOD_NOT_CONVERTED',
        '$.period',
        `旧时间抽象「${label}」没有可靠现实分钟含义：保留为日历标签（branches.calendar_label），新时间轴从迁移基点相对 0 开始，不折算成秒`,
        'warning',
        false,
      ),
    );
  }
  if (periodLabels.length > 0) {
    const created = withSavepoint(db, () => {
      runBound(db, 'UPDATE branches SET calendar_label = COALESCE(calendar_label, ?) WHERE id = ?', [periodLabels.join(' / '), ctx.branchId]);
    });
    if (!created.ok) {
      issues.push(issue('LEGACY_CALENDAR_LABEL_FAILED', '$.period', `旧日历标签写入失败：${created.message}`, 'warning', true));
    }
  }

  let ownsTransaction = false;
  try {
    beginTransaction(db);
    ownsTransaction = true;
  } catch {
    ownsTransaction = false;
  }

  const failed = (message: string): void => {
    if (ownsTransaction) rollbackTransaction(db);
    throw new AtlasDbError('MIGRATION_FAILED', `旧实体迁移失败：${message}`, { branchId: ctx.branchId });
  };

  try {
    // 1) 地点：entity_keys 先写，detail 后写（触发器要求同分支同 ID 的身份行已在）。
    const locationById = new Map<string, { name: string; kind: string }>();
    const legacyToSql = new Map<string, string>();
    const parentLinks: Array<{id:string; parentLegacyId:string; origin:string; name:string}> = [];
    for (const candidate of candidates.locations) {
      const name = str(candidate.raw.name);
      if (name.length === 0) {
        skipped.push({ kind: 'location', legacyId: candidate.legacyId, reason: 'NAME_MISSING' });
        issues.push(describeProblem(candidate.origin, `旧地点缺少名称：不编造地名，保留在 skipped`, 'LEGACY_NAME_MISSING'));
        continue;
      }
      const id = resolveCandidateId(candidate, ctx, issues);
      const kind = mapLocationKind(candidate.raw.kind ?? candidate.raw.type);
      if (candidate.legacyId.length > 0) locationById.set(candidate.legacyId, { name, kind });
      locationById.set(id, { name, kind });

      if (rowExists(db, 'locations', ctx.branchId, id)) {
        bump(mapped, 'kind:alreadyImported');
        issues.push(describeProblem(candidate.origin, `旧地点 ${candidate.legacyId || id} 已经在库里，跳过重复导入`, 'ALREADY_IMPORTED'));
        legacyToSql.set(candidate.legacyId, id);
        continue;
      }
      const keyKind = checkEntityKey(db, ctx.branchId, id, 'location');
      if (keyKind !== null) {
        skipped.push({ kind: 'location', legacyId: candidate.legacyId, reason: keyKind });
        issues.push(issue('ENTITY_KEY_KIND_CONFLICT', candidate.origin, `entity_keys 里 ${id} 已是 ${keyKind}，不能同时是地点`, 'error', false));
        continue;
      }

      const parentLegacyId = str(candidate.raw.parentLocationId ?? candidate.raw.parentRef ?? candidate.raw.parentId);
      const legacyMapId = str(candidate.raw.mapId ?? candidate.raw.map_id);
      const mapId = resolveMapRef(db, ctx, mapState, legacyMapId, mapsDoc, locationById);
      const gridX = num(candidate.raw.gridX ?? candidate.raw.x);
      const gridY = num(candidate.raw.gridY ?? candidate.raw.y);
      const hasGrid = mapId !== null && gridX !== null && gridY !== null;

      const created = withSavepoint(db, () => {
        insertEntityKey(db, ctx.branchId, id, 'location');
        insertRow(
          db,
          'locations',
          {
            name,
            aliases_json: strList(candidate.raw.aliases ?? candidate.raw.aliases_json),
            kind,
            description: str(candidate.raw.description),
            parent_location_id: null,
            mobility: str(candidate.raw.mobility) === 'mobile' ? 'mobile' : 'fixed',
            map_id: hasGrid ? mapId : null,
            grid_x: hasGrid ? gridX : null,
            grid_y: hasGrid ? gridY : null,
            coord_precision: hasGrid ? (str(candidate.raw.coordinateStatus) === 'confirmed' ? 'exact' : 'approximate') : 'unknown',
            terrain: str(candidate.raw.terrain) || 'unknown',
            existence_quality: 'confirmed',
            status: mapLocationStatus(candidate.raw.status),
          },
          { ...rowCtx, id },
        );
      });
      if (!created.ok) {
        skipped.push({ kind: 'location', legacyId: candidate.legacyId, reason: `SQL_CONSTRAINT: ${created.message}` });
        issues.push(issue('LEGACY_ROW_REJECTED', candidate.origin, `旧地点「${name}」写入被拒：${created.message}`, 'error', true));
        continue;
      }
      if (legacyMapId.length > 0 && !hasGrid) {
        issues.push(
          describeProblem(
            candidate.origin,
            `旧地点「${name}」的坐标因地图未解析而未写入（map_id=NULL，粗位置保留）`,
            'LEGACY_COORDS_DROPPED',
          ),
        );
      }
      parentLinks.push({id,parentLegacyId,origin:candidate.origin,name});
      legacyToSql.set(candidate.legacyId, id);
      bump(mapped, 'kind:locations');
      bump(mapped, 'kind:entityKeys');
      mapped[`legacy:${candidate.legacyId || id}`] = mapped['kind:locations'] ?? 1;
    }

    // Resolve after all locations exist: parents may appear later in the old array.
    for (const link of parentLinks) {
      if (!link.parentLegacyId) continue;
      const parentId = legacyToSql.get(link.parentLegacyId)
        ?? (rowExists(db, 'locations', ctx.branchId, link.parentLegacyId) ? link.parentLegacyId : null);
      if (!parentId) {
        issues.push(describeProblem(link.origin, `旧父地点 ${link.parentLegacyId} 不存在：${link.name} 保留为根地点`, 'LEGACY_PARENT_UNRESOLVED'));
        continue;
      }
      runBound(db, 'UPDATE locations SET parent_location_id=? WHERE branch_id=? AND id=?', [parentId,ctx.branchId,link.id]);
    }
    const parents = new Map(queryBound(db,'SELECT id,parent_location_id FROM locations WHERE branch_id=?',[ctx.branchId]).map(row => [String(row.id),row.parent_location_id ? String(row.parent_location_id) : null]));
    for (const id of parents.keys()) {
      const seen = new Set<string>(); let cursor:string|null = id;
      while(cursor) {
        if(seen.has(cursor)) throw new AtlasDbError('MIGRATION_FAILED','旧地点包含关系存在循环，拒绝发布候选',{locationId:id});
        seen.add(cursor); cursor=parents.get(cursor)??null;
      }
    }

    // 2) 势力：地点行内嵌的 factions 名单与旧 factions 数组都要有稳定 ID。
    const factionIds = new Map<string, string>();
    for (const candidate of candidates.factions) {
      const name = str(candidate.raw.name);
      if (name.length === 0) {
        skipped.push({ kind: 'faction', legacyId: candidate.legacyId, reason: 'NAME_MISSING' });
        continue;
      }
      if (factionIds.has(name)) continue;
      const id = resolveCandidateId(candidate, ctx, issues, name);
      if (rowExists(db, 'factions', ctx.branchId, id)) {
        factionIds.set(name, id);
        bump(mapped, 'kind:alreadyImported');
        issues.push(describeProblem(candidate.origin, `旧势力 ${name} 已在库里，跳过重复导入`, 'ALREADY_IMPORTED'));
        continue;
      }
      const keyKind = checkEntityKey(db, ctx.branchId, id, 'faction');
      if (keyKind !== null) {
        skipped.push({ kind: 'faction', legacyId: candidate.legacyId || name, reason: keyKind });
        continue;
      }
      const headquartersRef = str(candidate.raw.headquartersLocationId ?? candidate.raw.headquartersRef);
      const headquartersId = headquartersRef.length > 0 ? (legacyToSql.get(headquartersRef) ?? null) : null;
      const created = withSavepoint(db, () => {
        insertEntityKey(db, ctx.branchId, id, 'faction');
        insertRow(
          db,
          'factions',
          {
            name,
            aliases_json: strList(candidate.raw.aliases),
            kind: mapFactionKind(candidate.raw.kind ?? candidate.raw.type),
            description: str(candidate.raw.description),
            goal: str(candidate.raw.goal),
            headquarters_location_id: headquartersId,
          },
          { ...rowCtx, id },
        );
      });
      if (!created.ok) {
        skipped.push({ kind: 'faction', legacyId: candidate.legacyId || name, reason: `SQL_CONSTRAINT: ${created.message}` });
        issues.push(issue('LEGACY_ROW_REJECTED', candidate.origin, `旧势力「${name}」写入被拒：${created.message}`, 'error', true));
        continue;
      }
      factionIds.set(name, id);
      bump(mapped, 'kind:factions');
      bump(mapped, 'kind:entityKeys');
    }

    // 3) 人物。位置只取「能解析的既有地点」；解析不了就留 NULL，不塞进别的同地点。
    for (const candidate of candidates.characters) {
      const name = str(candidate.raw.name);
      if (name.length === 0) {
        skipped.push({ kind: 'character', legacyId: candidate.legacyId, reason: 'NAME_MISSING' });
        issues.push(describeProblem(candidate.origin, '旧人物缺少名称：不编造人名，保留在 skipped', 'LEGACY_NAME_MISSING'));
        continue;
      }
      const id = resolveCandidateId(candidate, ctx, issues);
      if (rowExists(db, 'characters', ctx.branchId, id)) {
        bump(mapped, 'kind:alreadyImported');
        issues.push(describeProblem(candidate.origin, `旧人物 ${candidate.legacyId || id} 已经在库里，跳过重复导入`, 'ALREADY_IMPORTED'));
        legacyToSql.set(candidate.legacyId, id);
        continue;
      }
      const keyKind = checkEntityKey(db, ctx.branchId, id, 'character');
      if (keyKind !== null) {
        skipped.push({ kind: 'character', legacyId: candidate.legacyId, reason: keyKind });
        issues.push(issue('ENTITY_KEY_KIND_CONFLICT', candidate.origin, `entity_keys 里 ${id} 已是 ${keyKind}，不能同时是人物`, 'error', false));
        continue;
      }
      const locationLegacyId = str(candidate.raw.locationId ?? candidate.raw.locationRef ?? candidate.raw.location_id);
      const locationId =
        locationLegacyId.length > 0
          ? legacyToSql.get(locationLegacyId) ?? (rowExists(db, 'locations', ctx.branchId, locationLegacyId) ? locationLegacyId : null)
          : null;
      if (locationLegacyId.length > 0 && locationId === null) {
        issues.push(
          describeProblem(
            candidate.origin,
            `旧人物 ${candidate.legacyId || id}「${name}」所在地点 ${locationLegacyId} 未迁移：location_id 置空（粗位置未知，不塞进别的地点）`,
            'LEGACY_LOCATION_UNRESOLVED',
          ),
        );
      }
      const legacyMapId = str(candidate.raw.mapId ?? candidate.raw.map_id);
      const mapId = resolveMapRef(db, ctx, mapState, legacyMapId, mapsDoc, locationById);
      const gridX = num(candidate.raw.gridX ?? candidate.raw.x);
      const gridY = num(candidate.raw.gridY ?? candidate.raw.y);
      const hasGrid = mapId !== null && gridX !== null && gridY !== null;
      const created = withSavepoint(db, () => {
        insertEntityKey(db, ctx.branchId, id, 'character');
        const absent=candidate.raw.presence==='left'||candidate.raw.status==='archived';
        insertRow(
          db,
          'characters',
          {
            name,
            aliases_json: strList(candidate.raw.aliases),
            role: mapRole(candidate.raw.role),
            identity: str(candidate.raw.identity),
            description: str(candidate.raw.description),
            personality: str(candidate.raw.personality),
            importance: mapImportance(candidate.raw.importance),
            importance_reason: str(candidate.raw.importanceReason) || '迁移自旧档',
            thought: str(candidate.raw.thought),
            action_tendency: str(candidate.raw.actionTendency ?? candidate.raw.action_tendency),
            physical_status: mapPhysicalStatus(candidate.raw.physicalStatus ?? candidate.raw.physical_status),
            condition_note: str(candidate.raw.conditionNote),
            location_id: absent?null:locationId,
            map_id: !absent&&hasGrid ? mapId : null,
            grid_x: !absent&&hasGrid ? gridX : null,
            grid_y: !absent&&hasGrid ? gridY : null,
            coord_precision: !absent&&hasGrid ? (str(candidate.raw.coordinateStatus) === 'confirmed' ? 'exact' : 'approximate') : 'unknown',
            mobility_profiles_json: Array.isArray(candidate.raw.mobilityProfiles) ? candidate.raw.mobilityProfiles : [],
            capabilities_json: Array.isArray(candidate.raw.capabilities) ? candidate.raw.capabilities : [],
            status: absent?'archived':'active',
          },
          { ...rowCtx, id },
        );
      });
      if (!created.ok) {
        skipped.push({ kind: 'character', legacyId: candidate.legacyId, reason: `SQL_CONSTRAINT: ${created.message}` });
        issues.push(issue('LEGACY_ROW_REJECTED', candidate.origin, `旧人物「${name}」写入被拒：${created.message}`, 'error', true));
        continue;
      }
      legacyToSql.set(candidate.legacyId, id);
      bump(mapped, 'kind:characters');
      bump(mapped, 'kind:entityKeys');
      mapped[`legacy:${candidate.legacyId || id}`] = mapped['kind:characters'] ?? 1;
    }

    // 4) 物品：持有 / 容器 / 独立放置互斥；持有人未解析就不写 holder。
    for (const candidate of candidates.items) {
      const name = str(candidate.raw.name);
      if (name.length === 0) {
        skipped.push({ kind: 'item', legacyId: candidate.legacyId, reason: 'NAME_MISSING' });
        issues.push(describeProblem(candidate.origin, '旧物品缺少名称：不编造名称，保留在 skipped', 'LEGACY_NAME_MISSING'));
        continue;
      }
      const id = resolveCandidateId(candidate, ctx, issues);
      if (rowExists(db, 'items', ctx.branchId, id)) {
        bump(mapped, 'kind:alreadyImported');
        issues.push(describeProblem(candidate.origin, `旧物品 ${candidate.legacyId || id} 已经在库里，跳过重复导入`, 'ALREADY_IMPORTED'));
        legacyToSql.set(candidate.legacyId, id);
        continue;
      }
      const keyKind = checkEntityKey(db, ctx.branchId, id, 'item');
      if (keyKind !== null) {
        skipped.push({ kind: 'item', legacyId: candidate.legacyId, reason: keyKind });
        continue;
      }
      const holderLegacyId = str(candidate.raw.holderCharacterId ?? candidate.raw.holderRef ?? candidate.raw.holder);
      const holderId =
        holderLegacyId.length > 0
          ? legacyToSql.get(holderLegacyId) ?? (rowExists(db, 'characters', ctx.branchId, holderLegacyId) ? holderLegacyId : null)
          : null;
      if (holderLegacyId.length > 0 && holderId === null) {
        issues.push(
          describeProblem(
            candidate.origin,
            `旧物品 ${candidate.legacyId || id}「${name}」的持有人 ${holderLegacyId} 未迁移：不写 holder，按放置位置处理`,
            'LEGACY_HOLDER_UNRESOLVED',
          ),
        );
      }
      const locationLegacyId = str(candidate.raw.locationId ?? candidate.raw.locationRef ?? candidate.raw.location_id);
      const locationId =
        holderId !== null
          ? null
          : locationLegacyId.length > 0
            ? legacyToSql.get(locationLegacyId) ?? (rowExists(db, 'locations', ctx.branchId, locationLegacyId) ? locationLegacyId : null)
            : null;
      if (holderId === null && locationLegacyId.length > 0 && locationId === null) {
        issues.push(
          describeProblem(
            candidate.origin,
            `旧物品 ${candidate.legacyId || id}「${name}」的放置地点 ${locationLegacyId} 未迁移：location_id 置空（位置未知）`,
            'LEGACY_LOCATION_UNRESOLVED',
          ),
        );
      }
      const legacyMapId = str(candidate.raw.mapId ?? candidate.raw.map_id);
      const mapId = holderId === null ? resolveMapRef(db, ctx, mapState, legacyMapId, mapsDoc, locationById) : null;
      const gridX = num(candidate.raw.gridX ?? candidate.raw.x);
      const gridY = num(candidate.raw.gridY ?? candidate.raw.y);
      const hasGrid = mapId !== null && gridX !== null && gridY !== null;
      const ownerLegacyId = str(candidate.raw.ownerEntityId ?? candidate.raw.ownerRef ?? candidate.raw.owner);
      const ownerId =
        ownerLegacyId.length > 0
          ? legacyToSql.get(ownerLegacyId) ?? (entityKeyExists(db, ctx.branchId, ownerLegacyId) ? ownerLegacyId : null)
          : null;
      const quantity = num(candidate.raw.quantity);
      const created = withSavepoint(db, () => {
        insertEntityKey(db, ctx.branchId, id, 'item');
        insertRow(
          db,
          'items',
          {
            name,
            aliases_json: strList(candidate.raw.aliases),
            kind: mapItemKind(candidate.raw.kind ?? candidate.raw.type),
            description: str(candidate.raw.description),
            quantity: quantity !== null && quantity >= 0 ? quantity : null,
            unit: str(candidate.raw.unit) || '件',
            condition_note: str(candidate.raw.conditionNote),
            owner_entity_id: ownerId,
            holder_character_id: holderId,
            location_id: locationId,
            map_id: hasGrid ? mapId : null,
            grid_x: hasGrid ? gridX : null,
            grid_y: hasGrid ? gridY : null,
            coord_precision: hasGrid ? (str(candidate.raw.coordinateStatus) === 'confirmed' ? 'exact' : 'approximate') : 'unknown',
            properties_json: Array.isArray(candidate.raw.properties) ? candidate.raw.properties : [],
            status: mapItemStatus(candidate.raw.status),
          },
          { ...rowCtx, id },
        );
      });
      if (!created.ok) {
        skipped.push({ kind: 'item', legacyId: candidate.legacyId, reason: `SQL_CONSTRAINT: ${created.message}` });
        issues.push(issue('LEGACY_ROW_REJECTED', candidate.origin, `旧物品「${name}」写入被拒：${created.message}`, 'error', true));
        continue;
      }
      legacyToSql.set(candidate.legacyId, id);
      bump(mapped, 'kind:items');
      bump(mapped, 'kind:entityKeys');
      mapped[`legacy:${candidate.legacyId || id}`] = mapped['kind:items'] ?? 1;
    }

    // 5) 旧 rumors（纯字符串列表）→ information(kind=rumor, truth_status=unknown) + 当地 front。
    //    **不**给每个 NPC 建 knowledge：风声到达谁由后续机会/渠道推演决定。
    for (const rumor of candidates.rumors) {
      const content = rumor.text.trim();
      if (content.length === 0) continue;
      const originLocationId = legacyToSql.get(rumor.locationId) ?? null;
      if (originLocationId === null) {
        issues.push(
          describeProblem(rumor.origin, `风声「${clip(content, 40)}」的起源地点 ${rumor.locationId} 未迁移：仍建 information，但不建当地 front`, 'LEGACY_RUMOR_ORIGIN_UNKNOWN'),
        );
      }
      const contentHash = `rumor_${stableHash(content)}`;
      const existingInfo = queryOne(db, 'SELECT id FROM information WHERE branch_id = ? AND content_hash = ? LIMIT 1', [
        ctx.branchId,
        contentHash,
      ]);
      if (existingInfo) {
        bump(mapped, 'kind:alreadyImported');
        issues.push(describeProblem(rumor.origin, `风声「${clip(content, 40)}」已导入（id=${String(existingInfo.id)}），跳过重复插入`, 'ALREADY_IMPORTED'));
        continue;
      }
      const informationId = ctx.makeId('information', 'migration.rumor', `${ctx.branchId}:${rumor.locationId}:${contentHash}`);
      const created = withSavepoint(db, () => {
        insertRow(
          db,
          'information',
          {
            kind: 'rumor',
            title: clip(content, 24),
            content,
            // 无法识别真假的内容一律 unknown；created_at_s 用迁移基点（相对 0），不是旧 period。
            truth_status: 'unknown',
            topic_key: `rumor:${stableHash(`${rumor.locationId}:${content}`)}`,
            content_hash: contentHash,
            created_at_s: clockS,
            origin_location_id: originLocationId,
            status: 'active',
          },
          { ...rowCtx, id: informationId },
        );
        if (originLocationId !== null) {
          const frontId = ctx.makeId('rumor_front', 'migration.rufror_front', `${informationId}:${originLocationId}`);
          insertRow(
            db,
            'rumor_fronts',
            {
              information_id: informationId,
              location_id: originLocationId,
              first_available_at_s: clockS,
              last_reinforced_at_s: clockS,
              reach: 'local',
              audience_json: { access: 'public', tags: [] },
              status: 'active',
            },
            { ...rowCtx, id: frontId },
          );
        }
      });
      if (!created.ok) {
        skipped.push({ kind: 'information', legacyId: contentHash, reason: `SQL_CONSTRAINT: ${created.message}` });
        issues.push(issue('LEGACY_ROW_REJECTED', rumor.origin, `风声「${clip(content, 40)}」写入被拒：${created.message}`, 'error', true));
        continue;
      }
      bump(mapped, 'kind:information');
      if (originLocationId !== null) bump(mapped, 'kind:fronts');
    }

    // 6) 关系：只有显式对象 ID 才能落地；没有明确对象时保留描述待识别，不按同名匹配。
    for (const candidate of candidates.relations) {
      const description = str(candidate.raw.description ?? candidate.raw.text ?? candidate.raw.note);
      const subjectRef = str(candidate.raw.subjectId ?? candidate.raw.subjectEntityId ?? candidate.raw.subjectRef ?? candidate.raw.from ?? candidate.raw.subject);
      const objectRef = str(candidate.raw.objectId ?? candidate.raw.objectEntityId ?? candidate.raw.objectRef ?? candidate.raw.to ?? candidate.raw.object);
      const subjectId = subjectRef.length > 0 ? legacyToSql.get(subjectRef) ?? (entityKeyExists(db, ctx.branchId, subjectRef) ? subjectRef : null) : null;
      const objectId = objectRef.length > 0 ? legacyToSql.get(objectRef) ?? (entityKeyExists(db, ctx.branchId, objectRef) ? objectRef : null) : null;
      if (subjectId === null || objectId === null) {
        const reason =
          objectRef.length === 0 && subjectId !== null
            ? `RELATION_OBJECT_UNRESOLVED: ${clip(description || str(candidate.raw.label) || '(无描述)', 120)}`
            : `RELATION_ENDPOINT_UNRESOLVED: subject=${subjectRef || 'missing'} object=${objectRef || 'missing'} description=${clip(description, 120)}`;
        skipped.push({ kind: 'relation', legacyId: candidate.legacyId, reason });
        issues.push(
          describeProblem(
            candidate.origin,
            `旧关系缺少可解析的对象（subject=${subjectRef || 'missing'}, object=${objectRef || 'missing'}）：保留描述待识别，不按同名人物随机匹配`,
            'RELATION_OBJECT_UNRESOLVED',
          ),
        );
        continue;
      }
      if (subjectId === objectId) {
        skipped.push({ kind: 'relation', legacyId: candidate.legacyId, reason: 'RELATION_SELF_REFERENCE' });
        continue;
      }
      const kind = mapRelationKind(candidate.raw.kind);
      const label = str(candidate.raw.label);
      const duplicate = queryOne(
        db,
        'SELECT id FROM relations WHERE branch_id = ? AND subject_entity_id = ? AND object_entity_id = ? AND kind = ? AND label = ? LIMIT 1',
        [ctx.branchId, subjectId, objectId, kind, label],
      );
      if (duplicate) {
        bump(mapped, 'kind:alreadyImported');
        continue;
      }
      const relationId =
        candidate.legacyId.length > 0
          ? candidate.legacyId
          : ctx.makeId('relation', 'migration.relation', `${subjectId}:${objectId}:${kind}:${label}:${stableHash(description)}`);
      const created = withSavepoint(db, () => {
        insertRow(
          db,
          'relations',
          {
            subject_entity_id: subjectId,
            object_entity_id: objectId,
            kind,
            label,
            attitude: 'unknown',
            trust: 'unknown',
            description,
            basis_quality: 'inferred',
            secrecy: 'restricted',
            valid_from_s: clockS,
            status: 'active',
          },
          { ...rowCtx, id: relationId },
        );
      });
      if (!created.ok) {
        skipped.push({ kind: 'relation', legacyId: candidate.legacyId, reason: `SQL_CONSTRAINT: ${created.message}` });
        issues.push(issue('LEGACY_ROW_REJECTED', candidate.origin, `旧关系写入被拒：${created.message}`, 'error', true));
        continue;
      }
      bump(mapped, 'kind:relations');
    }

    issues.push(...mapState.issues);
    bump(mapped, 'kind:maps', mapState.created);
    bump(mapped, 'kind:skipped', skipped.length);

    if (ownsTransaction) commitTransaction(db);
  } catch (err) {
    if (err instanceof AtlasDbError) failed(err.message);
    failed((err as Error).message);
  }

  return { mapped, issues, skipped };
}

function entityKeyExists(db: SqlDatabase, branchId: string, id: string): boolean {
  if (id.length === 0) return false;
  return queryBound(db, 'SELECT 1 AS present FROM entity_keys WHERE branch_id = ? AND id = ? LIMIT 1', [branchId, id]).length > 0;
}

/** 返回 null 表示可以建该类型实体；否则返回冲突原因。 */
function checkEntityKey(db: SqlDatabase, branchId: string, id: string, kind: 'location' | 'character' | 'item' | 'faction'): string | null {
  const existing = queryOne(db, 'SELECT kind FROM entity_keys WHERE branch_id = ? AND id = ? LIMIT 1', [branchId, id]);
  if (!existing) return null;
  const existingKind = String(existing.kind);
  return existingKind === kind ? null : `ENTITY_KEY_KIND_CONFLICT: ${id} 已是 ${existingKind}`;
}

/** 稳定 ID：旧 ID 是非空字符串时原样保留；缺失时按旧档内容铸造确定性 ID 并记 LEGACY_ID_MINTED。 */
function resolveCandidateId(candidate: EntityCandidate, ctx: LegacyEntityContext, issues: Issue[], extraAlias = ''): string {
  const legacyId = candidate.legacyId;
  if (legacyId.length > 0) return legacyId;
  const alias = `${candidate.kind}:${extraAlias || str(candidate.raw.name)}#${candidate.index}`;
  const minted = ctx.makeId(candidate.kind, `migration.${candidate.kind}`, alias);
  issues.push(
    issue(
      'LEGACY_ID_MINTED',
      candidate.origin,
      `旧${candidate.kind}「${str(candidate.raw.name)}」缺少 id：按旧档内容铸造确定性 ID ${minted}（同输入必得同 ID，重复导入可识别）`,
      'warning',
      false,
    ),
  );
  return minted;
}

function mapLocationStatus(value: unknown): string {
  const key = str(value).toLowerCase();
  if (['active', 'destroyed', 'merged', 'archived'].includes(key)) return key;
  if (['已毁灭', 'destroyed'].includes(key)) return 'destroyed';
  if (['已合并', 'merged'].includes(key)) return 'merged';
  if (['已归档', 'archived'].includes(key)) return 'archived';
  return 'active';
}

/* ================================================================== *
 * E13：旧 simulation → actions / information / fronts / knowledge / routes
 * ================================================================== */

function simulationBranch(simulation: Record<string, unknown>, branchId: string): { key: string; branch: Record<string, unknown> } | null {
  if (isPlainObject(simulation.branches)) {
    const keys = Object.keys(simulation.branches).sort();
    const key = keys.includes(branchId) ? branchId : keys.includes('canon') ? 'canon' : keys[0];
    const branch = key === undefined ? undefined : simulation.branches[key];
    if (isPlainObject(branch)) return { key, branch };
    return null;
  }
  if (Array.isArray(simulation.tasks) || Array.isArray(simulation.signals) || Array.isArray(simulation.deliveries)) {
    return { key: 'flat', branch: simulation };
  }
  return null;
}

function simRows(branch: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = branch[key];
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is Record<string, unknown> => isPlainObject(row));
}

function mapActionKind(kind: string): string {
  switch (kind) {
    case 'intent':
      return 'goal';
    case 'travel':
      return 'travel';
    case 'reaction':
      return 'act';
    default:
      return 'act';
  }
}

function mapActionStatus(status: string): string {
  switch (status) {
    case 'queued':
      return 'planned';
    case 'active':
      return 'active';
    case 'blocked':
      return 'blocked';
    case 'resolved':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'planned';
  }
}

/**
 * E13 migrateLegacySimulation。
 * 完成定义：不把旧时期单位假装成秒；无 silent drop。
 */
export function migrateLegacySimulation(
  plan: LegacyInspection,
  raw: unknown,
  db: SqlDatabase,
  ctx: LegacySimulationContext,
): LegacySimulationMigrationResult {
  const issues: Issue[] = [];
  const blocked: MigrationSkip[] = [];
  const mapped: LegacyMapped = {};
  // 固定签名是 `(...args: never[]) => string`；实际调用按三参数（程序内约定）走。
  const makeId = ctx.makeId as unknown as (kind: string, opId: string, alias: string) => string;
  const rowCtx: CreateRowContext = {
    branchId: ctx.branchId,
    id: '',
    turnId: ctx.turnId,
    clockS: 0,
    nowWallMs: ctx.nowWallMs,
    rulesetVersion: ctx.rulesetVersion,
  };

  const located = locateAtlas(raw);
  const atlas = located.atlas ?? {};
  const sources = readLegacySources(atlas);
  if (plan.kind === 'corrupt') {
    return {
      mapped,
      issues: [issue('LEGACY_CORRUPT', '$.simulation', `旧档损坏（${plan.reason}）：拒绝迁移推演段`, 'error', false)],
      blocked,
    };
  }
  if (plan.kind === 'new_format' || plan.kind === 'already_migrated') {
    return {
      mapped,
      issues: [issue('ALREADY_IMPORTED', '$.simulation', `会话文档里已有 SQLite 存档信封（${plan.kind}）：不重复导入旧推演段`, 'warning', false)],
      blocked,
    };
  }
  const simulation = sources.simulation;
  if (!simulation) {
    issues.push(issue('LEGACY_SIMULATION_ABSENT', '$.simulation', '旧档没有 simulation 段：没有需要迁移的推演任务', 'warning', false));
    return { mapped, issues, blocked };
  }
  const selected = simulationBranch(simulation, ctx.branchId);
  if (!selected) {
    issues.push(issue('LEGACY_SIMULATION_SHAPE_UNKNOWN', '$.simulation', '旧 simulation 段既不是 branches 映射也不是平铺 tasks/signals/deliveries', 'error', false));
    return { mapped, issues, blocked };
  }

  const branch = queryOne(db, 'SELECT id FROM branches WHERE id = ? LIMIT 1', [ctx.branchId]);
  if (!branch) {
    return { mapped, issues: [issue('REF_UNKNOWN', '$.branchId', `目标分支不存在：${ctx.branchId}`, 'error', true)], blocked };
  }

  for (const label of sources.periodLabels) {
    issues.push(
      issue(
        'PERIOD_NOT_CONVERTED',
        '$.simulation',
        `旧 period「${label}」不折算成秒：迁移后的时间字段一律使用迁移基点相对 0`,
        'warning',
        false,
      ),
    );
  }

  let ownsTransaction = false;
  try {
    beginTransaction(db);
    ownsTransaction = true;
  } catch {
    ownsTransaction = false;
  }

  const actionIds = new Map<string, string>();
  const informationIds = new Map<string, string>();
  const channelIds = new Map<string, string>();

  try {
    // 1) tasks → actions（无法解析 actor 的保留 blocked 待审）。
    for (const task of simRows(selected.branch, 'tasks')) {
      const legacyId = str(task.id);
      const topic = str(task.topic);
      const title = clip(topic || legacyId || '旧推演任务', 60);
      const actorRef = str(task.actorCharacterId);
      const actorId = actorRef.length > 0 ? (entityKeyExists(db, ctx.branchId, actorRef) ? actorRef : null) : null;
      const periodLabel = findPeriodLabel(task);
      if (periodLabel !== null) {
        issues.push(issue('PERIOD_NOT_CONVERTED', `$.simulation.tasks.${legacyId}`, `任务 ${legacyId} 的 ${periodLabel} 不折算成秒`, 'warning', false));
      }
      if (actorId === null) {
        blocked.push({
          kind: 'task',
          legacyId,
          reason: `ACTOR_UNRESOLVED: actorCharacterId=${actorRef || 'missing'}${periodLabel ? ` (${periodLabel})` : ''}`,
        });
        issues.push(
          issue(
            'LEGACY_TASK_BLOCKED',
            `$.simulation.tasks.${legacyId}`,
            `旧任务 ${legacyId}「${title}」的 actor 无法解析：保留 blocked 待审，不编造执行者`,
            'warning',
            true,
          ),
        );
        continue;
      }
      const actionId = legacyId.length > 0 ? legacyId : makeId('action', 'migration.action', `${ctx.branchId}:${title}:${str(task.createdTurnKey)}`);
      if (rowExists(db, 'actions', ctx.branchId, actionId)) {
        bump(mapped, 'kind:alreadyImported');
        actionIds.set(legacyId, actionId);
        issues.push(describeProblem(`$.simulation.tasks.${legacyId}`, `旧任务 ${legacyId} 已导入，跳过`, 'ALREADY_IMPORTED'));
        continue;
      }
      const targetLocationRef = str(task.targetLocationId);
      const originLocationRef = str(task.originLocationId);
      const targetLocationId = targetLocationRef.length > 0 && rowExists(db, 'locations', ctx.branchId, targetLocationRef) ? targetLocationRef : null;
      const kind = mapActionKind(str(task.kind));
      const created = withSavepoint(db, () => {
        insertRow(
          db,
          'actions',
          {
            actor_entity_id: actorId,
            kind,
            title,
            intent: topic,
            target_location_id: kind === 'travel' ? targetLocationId : null,
            payload_json: { migration: { source: 'legacy_simulation', legacyId, originLocationId: originLocationRef || null, visibility: str(task.visibility) || null } },
            progress_s: 0,
            // 旧 period 不写进任何 *_s 字段：时间轴从相对 0 开始。
            evaluated_until_s: 0,
            secrecy: str(task.visibility) === 'hidden' ? 'secret' : 'restricted',
            priority: 'normal',
            status: mapActionStatus(str(task.status)),
            reason_code: periodLabel !== null ? `PERIOD_NOT_CONVERTED:${periodLabel}` : str(task.reasonCode) || null,
          },
          { ...rowCtx, id: actionId },
        );
      });
      if (!created.ok) {
        blocked.push({ kind: 'task', legacyId, reason: `SQL_CONSTRAINT: ${created.message}` });
        issues.push(issue('LEGACY_TASK_BLOCKED', `$.simulation.tasks.${legacyId}`, `旧任务写入被拒：${created.message}`, 'error', true));
        continue;
      }
      actionIds.set(legacyId, actionId);
      bump(mapped, 'kind:actions');
    }

    // 2) signals → information（topic 只作摘要，正文不复制；时间用相对 0）。
    for (const signal of simRows(selected.branch, 'signals')) {
      const legacyId = str(signal.id);
      const topic = str(signal.topic);
      const originRef = str(signal.originLocationId);
      const originLocationId = originRef.length > 0 && rowExists(db, 'locations', ctx.branchId, originRef) ? originRef : null;
      if (originLocationId === null && originRef.length > 0) {
        issues.push(
          describeProblem(`$.simulation.signals.${legacyId}`, `旧 signal ${legacyId} 的发起地 ${originRef} 未迁移：information 仍建立，origin_location_id 置空`, 'LEGACY_LOCATION_UNRESOLVED'),
        );
      }
      const periodLabel = findPeriodLabel(signal);
      if (periodLabel !== null) {
        issues.push(issue('PERIOD_NOT_CONVERTED', `$.simulation.signals.${legacyId}`, `signal ${legacyId} 的 ${periodLabel} 不折算成秒`, 'warning', false));
      }
      const contentHash = `signal_${stableHash(topic)}`;
      const existing = queryOne(db, 'SELECT id FROM information WHERE branch_id = ? AND content_hash = ? LIMIT 1', [ctx.branchId, contentHash]);
      if (existing) {
        informationIds.set(legacyId, String(existing.id));
        bump(mapped, 'kind:alreadyImported');
        continue;
      }
      const informationId = legacyId.length > 0 ? legacyId : makeId('information', 'migration.signal', `${ctx.branchId}:${contentHash}`);
      if (rowExists(db, 'information', ctx.branchId, informationId)) {
        informationIds.set(legacyId, informationId);
        bump(mapped, 'kind:alreadyImported');
        continue;
      }
      const created = withSavepoint(db, () => {
        insertRow(
          db,
          'information',
          {
            kind: 'report',
            title: clip(topic, 24),
            content: topic,
            truth_status: 'unknown',
            secrecy: str(signal.visibility) === 'hidden' ? 'secret' : 'restricted',
            topic_key: `signal:${stableHash(topic)}`,
            content_hash: contentHash,
            created_at_s: 0,
            origin_location_id: originLocationId,
            status: str(signal.status) === 'cancelled' ? 'retracted' : 'active',
          },
          { ...rowCtx, id: informationId },
        );
      });
      if (!created.ok) {
        blocked.push({ kind: 'signal', legacyId, reason: `SQL_CONSTRAINT: ${created.message}` });
        continue;
      }
      informationIds.set(legacyId, informationId);
      bump(mapped, 'kind:information');
    }

    // 3) 旧 channels（若旧档确实带了）：→ channels。
    for (const channel of simRows(selected.branch, 'channels')) {
      const name = str(channel.name);
      const ownerRef = str(channel.ownerEntityId ?? channel.ownerId);
      const ownerId = ownerRef.length > 0 && entityKeyExists(db, ctx.branchId, ownerRef) ? ownerRef : null;
      const legacyId = str(channel.id);
      if (name.length === 0 || ownerId === null) {
        blocked.push({ kind: 'channel', legacyId, reason: `CHANNEL_OWNER_UNRESOLVED: owner=${ownerRef || 'missing'}` });
        continue;
      }
      const channelId = legacyId.length > 0 ? legacyId : makeId('channel', 'migration.channel', `${ctx.branchId}:${name}`);
      if (rowExists(db, 'channels', ctx.branchId, channelId)) {
        channelIds.set(legacyId, channelId);
        bump(mapped, 'kind:alreadyImported');
        continue;
      }
      const created = withSavepoint(db, () => {
        insertRow(
          db,
          'channels',
          {
            name,
            kind: ['contact', 'faction_network', 'messenger', 'surveillance', 'broadcast', 'magic', 'other'].includes(str(channel.kind))
              ? str(channel.kind)
              : 'other',
            owner_entity_id: ownerId,
            source_entity_id: entityKeyExists(db, ctx.branchId, str(channel.sourceEntityId)) ? str(channel.sourceEntityId) : null,
            source_location_id: rowExists(db, 'locations', ctx.branchId, str(channel.sourceLocationId)) ? str(channel.sourceLocationId) : null,
            recipient_entity_id: entityKeyExists(db, ctx.branchId, str(channel.recipientEntityId)) ? str(channel.recipientEntityId) : null,
            recipient_location_id: rowExists(db, 'locations', ctx.branchId, str(channel.recipientLocationId)) ? str(channel.recipientLocationId) : null,
            scope_json: { location_refs: [], entity_refs: [], topics: strList(channel.topics) },
            latency_json: { quality: 'unknown', basis_refs: [], note: '旧 period 不折算成秒' },
            reliability: 'unknown',
            secrecy: 'restricted',
            basis_quality: 'inferred',
            valid_from_s: 0,
          },
          { ...rowCtx, id: channelId },
        );
      });
      if (!created.ok) {
        blocked.push({ kind: 'channel', legacyId, reason: `SQL_CONSTRAINT: ${created.message}` });
        continue;
      }
      channelIds.set(legacyId, channelId);
      bump(mapped, 'kind:channels');
    }

    // 4) deliveries → 地点风声 front / 人物认知 knowledge（送达是「确实收到」的证据，不是「人人皆知」）。
    for (const delivery of simRows(selected.branch, 'deliveries')) {
      const legacyId = str(delivery.id);
      const signalId = str(delivery.signalId);
      const informationId = informationIds.get(signalId) ?? (rowExists(db, 'information', ctx.branchId, signalId) ? signalId : null);
      if (informationId === null) {
        blocked.push({ kind: 'delivery', legacyId, reason: `SIGNAL_UNRESOLVED: signalId=${signalId || 'missing'}` });
        issues.push(
          issue('LEGACY_DELIVERY_BLOCKED', `$.simulation.deliveries.${legacyId}`, `旧送达 ${legacyId} 的信号未迁移：保留 blocked 待审`, 'warning', true),
        );
        continue;
      }
      const periodLabel = findPeriodLabel(delivery);
      if (periodLabel !== null) {
        issues.push(issue('PERIOD_NOT_CONVERTED', `$.simulation.deliveries.${legacyId}`, `送达 ${legacyId} 的 ${periodLabel} 不折算成秒`, 'warning', false));
      }
      const recipientType = str(delivery.recipientType);
      const recipientRef = str(delivery.recipientId);
      const via = str(delivery.via);
      if (recipientType === 'character') {
        if (!rowExists(db, 'characters', ctx.branchId, recipientRef)) {
          blocked.push({ kind: 'delivery', legacyId, reason: `RECIPIENT_UNRESOLVED: character=${recipientRef || 'missing'}` });
          continue;
        }
        const knowledgeId = legacyId.length > 0 ? `kn_${legacyId}` : makeId('knowledge', 'migration.knowledge', `${informationId}:${recipientRef}`);
        if (rowExists(db, 'knowledge', ctx.branchId, knowledgeId)) {
          bump(mapped, 'kind:alreadyImported');
          continue;
        }
        const created = withSavepoint(db, () => {
          insertRow(
            db,
            'knowledge',
            {
              knower_character_id: recipientRef,
              is_pov: 0,
              information_id: informationId,
              source_entity_id: entityKeyExists(db, ctx.branchId, str(delivery.fromLocationId)) ? str(delivery.fromLocationId) : null,
              first_received_at_s: 0,
              // 旧 confidence：confirmed→believed、rumor→heard、disputed→doubted。
              belief: str(delivery.confidence) === 'confirmed' ? 'believed' : str(delivery.confidence) === 'disputed' ? 'doubted' : 'heard',
              attention: 'normal',
              reaction_note: via.length > 0 ? `旧渠道：${via}` : '',
              status: 'active',
            },
            { ...rowCtx, id: knowledgeId },
          );
        });
        if (!created.ok) {
          blocked.push({ kind: 'delivery', legacyId, reason: `SQL_CONSTRAINT: ${created.message}` });
          continue;
        }
        bump(mapped, 'kind:knowledge');
        continue;
      }
      if (!rowExists(db, 'locations', ctx.branchId, recipientRef)) {
        blocked.push({ kind: 'delivery', legacyId, reason: `RECIPIENT_UNRESOLVED: location=${recipientRef || 'missing'}` });
        continue;
      }
      const frontId = legacyId.length > 0 ? `rf_${legacyId}` : makeId('rumor_front', 'migration.front', `${informationId}:${recipientRef}`);
      if (rowExists(db, 'rumor_fronts', ctx.branchId, frontId)) {
        bump(mapped, 'kind:alreadyImported');
        continue;
      }
      const created = withSavepoint(db, () => {
        insertRow(
          db,
          'rumor_fronts',
          {
            information_id: informationId,
            location_id: recipientRef,
            first_available_at_s: 0,
            last_reinforced_at_s: 0,
            reach: 'local',
            audience_json: { access: 'public', tags: [] },
            status: 'active',
          },
          { ...rowCtx, id: frontId },
        );
      });
      if (!created.ok) {
        blocked.push({ kind: 'delivery', legacyId, reason: `SQL_CONSTRAINT: ${created.message}` });
        continue;
      }
      if (via.length > 0) {
        issues.push(
          describeProblem(
            `$.simulation.deliveries.${legacyId}`,
            `旧送达方式「${via}」没有对应的新渠道行：front 已建立，via_channel_id 留空（不伪造渠道）`,
            'LEGACY_VIA_NOT_MAPPED',
          ),
        );
      }
      bump(mapped, 'kind:fronts');
    }

    // 5) geoTopology.edges → routes（两端都能解析才迁移；其余 blocked 待审）。
    const topology = isPlainObject(selected.branch.geoTopology) ? selected.branch.geoTopology : null;
    if (topology) {
      const edges = Array.isArray(topology.edges) ? topology.edges : [];
      for (const edge of edges) {
        if (!isPlainObject(edge)) continue;
        const legacyId = str(edge.id);
        const fromRef = str(edge.fromPointId ?? edge.fromLocationId ?? edge.from);
        const toRef = str(edge.toPointId ?? edge.toLocationId ?? edge.to);
        const fromId = rowExists(db, 'locations', ctx.branchId, fromRef) ? fromRef : null;
        const toId = rowExists(db, 'locations', ctx.branchId, toRef) ? toRef : null;
        if (fromId === null || toId === null || fromId === toId) {
          blocked.push({ kind: 'edge', legacyId, reason: `EDGE_ENDPOINT_UNRESOLVED: from=${fromRef || 'missing'} to=${toRef || 'missing'}` });
          continue;
        }
        const routeId = legacyId.length > 0 ? legacyId : makeId('route', 'migration.route', `${ctx.branchId}:${fromId}:${toId}`);
        if (rowExists(db, 'routes', ctx.branchId, routeId)) {
          bump(mapped, 'kind:alreadyImported');
          continue;
        }
        const created = withSavepoint(db, () => {
          insertRow(
            db,
            'routes',
            {
              from_location_id: fromId,
              to_location_id: toId,
              kind: 'adjacent',
              bidirectional: edge.bidirectional === false ? 0 : 1,
              // 旧格数不是米：没有标定时距离保持 NULL，绝不按格数编造米数。
              distance_basis: 'unknown',
              geometry_quality: 'unknown',
              allowed_modes_json: [],
              status: str(edge.status) === 'blocked' ? 'blocked' : 'open',
            },
            { ...rowCtx, id: routeId },
          );
        });
        if (!created.ok) {
          blocked.push({ kind: 'edge', legacyId, reason: `SQL_CONSTRAINT: ${created.message}` });
          continue;
        }
        bump(mapped, 'kind:routes');
      }
      for (const key of ['areas', 'vehicles'] as const) {
        const rows = Array.isArray(topology[key]) ? topology[key] : [];
        for (const row of rows) {
          if (!isPlainObject(row)) continue;
          const id=str(row.locationId??row.id),location=queryOne(db,'SELECT id,map_id FROM locations WHERE branch_id=? AND id=?',[ctx.branchId,id]);
          if(location&&key==='areas'&&Array.isArray(row.cells)&&row.cells.length<=256&&row.cells.every(cell=>isPlainObject(cell)&&Number.isInteger(cell.x)&&Number.isInteger(cell.y)&&Number(cell.x)>=0&&Number(cell.y)>=0)){
            runBound(db,'UPDATE locations SET area_geometry_json=?,updated_turn_id=? WHERE branch_id=? AND id=?',
              [JSON.stringify({kind:'cells',cells:row.cells,source:['manual','story','worldbook'].includes(str(row.evidence))?str(row.evidence):'migration',quality:'confirmed'}),ctx.turnId,ctx.branchId,id]);
            bump(mapped,'kind:areas');continue;
          }
          if(location&&key==='vehicles'){
            const anchor=str(row.atLocationId),resolved=anchor&&rowExists(db,'locations',ctx.branchId,anchor)?anchor:null;
            runBound(db,'UPDATE locations SET mobility=?,anchor_location_id=?,vehicle_profile_json=?,updated_turn_id=? WHERE branch_id=? AND id=?',
              ['mobile',str(row.status)==='stopped'?resolved:null,JSON.stringify({legacy_status:row.status,legacy_route_id:row.routeEdgeId??null}),ctx.turnId,ctx.branchId,id]);
            // Abstract old periods cannot become a moving SQL journey. Preserve an explicit blocked diagnostic.
            if(row.status==='en-route')issues.push(issue('LEGACY_VEHICLE_TRANSIT_BLOCKED','$.simulation.geoTopology.vehicles','旧载具在途记录缺少真实耗时；保留移动载具和旧行程，停靠地点未知','warning',false));
            bump(mapped,'kind:vehicles');continue;
          }
          blocked.push({
            kind: key === 'areas' ? 'area' : 'vehicle',
            legacyId: str(row.id),
            reason: `TOPOLOGY_${key.toUpperCase()}_UNMAPPED: 旧地块/载具缺少有效地点或范围，保留在旧档备份待审`,
          });
        }
      }
    }

    bump(mapped, 'kind:blocked', blocked.length);
    if (ownsTransaction) commitTransaction(db);
  } catch (err) {
    if (ownsTransaction) rollbackTransaction(db);
    if (err instanceof AtlasDbError) throw err;
    throw new AtlasDbError('MIGRATION_FAILED', `旧推演迁移失败：${(err as Error).message}`, { branchId: ctx.branchId });
  }

  return { mapped, issues, blocked };
}

/* ================================================================== *
 * E14：收尾校验与版本标记
 * ================================================================== */

/** 20 张表的行数快照（收尾诊断用）。 */
export function tableCounts(db: SqlDatabase): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of USER_TABLES) {
    const row = queryOne(db, `SELECT COUNT(*) AS n FROM ${table}`, []);
    counts[table] = Number(row?.n ?? 0);
  }
  return counts;
}

function readUserVersion(db: SqlDatabase): number {
  const rows = queryBound(db, 'PRAGMA user_version', []);
  const value = rows[0]?.user_version;
  return Number(value ?? 0);
}

/**
 * E14 finalizeMigration：校验后写 `PRAGMA user_version`。
 * 完成定义：重开不重复迁移、重复造世界（`user_version` 已是当前版本时不再做任何写入）。
 */
export function finalizeMigration(db: SqlDatabase, ctx: { branchId: string; fromSchemaVersion?: number }): MigrationFinalizeResult {
  const issues: Issue[] = [];
  const current = readUserVersion(db);
  const fromSchemaVersion = ctx.fromSchemaVersion ?? current;

  const names = userTableNames(db);
  const unexpected = names.filter((name) => !USER_TABLES.includes(name));
  const missing = USER_TABLES.filter((name) => !names.includes(name));
  if (unexpected.length > 0 || missing.length > 0) {
    issues.push(
      issue(
        'DB_SCHEMA_INVALID',
        '$',
        `用户表不是预期的 ${USER_TABLES.length} 张（多 ${unexpected.length}，少 ${missing.length}）：多 ${unexpected.join(',')}；少 ${missing.join(',')}`,
        'error',
        false,
      ),
    );
  }

  const violations = foreignKeyCheck(db);
  if (violations.length > 0) {
    issues.push(
      issue(
        'SQL_CONSTRAINT',
        '$',
        `外键检查未通过：${violations.map((v) => `${v.table}->${v.parent}`).join(', ')}`,
        'error',
        false,
      ),
    );
  }

  const orphans = queryBound(
    db,
    `SELECT k.id AS id, k.kind AS kind FROM entity_keys k
      WHERE k.branch_id = ?
        AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.branch_id = k.branch_id AND l.id = k.id AND k.kind = 'location')
        AND NOT EXISTS (SELECT 1 FROM characters c WHERE c.branch_id = k.branch_id AND c.id = k.id AND k.kind = 'character')
        AND NOT EXISTS (SELECT 1 FROM items i WHERE i.branch_id = k.branch_id AND i.id = k.id AND k.kind = 'item')
        AND NOT EXISTS (SELECT 1 FROM factions f WHERE f.branch_id = k.branch_id AND f.id = k.id AND k.kind = 'faction')
      LIMIT 20`,
    [ctx.branchId],
  );
  for (const orphan of orphans) {
    issues.push(
      issue('MIGRATION_ENTITY_DETAIL_MISSING', '$.entity_keys', `身份 ${String(orphan.id)}（${String(orphan.kind)}）没有对应详情行`, 'error', false),
    );
  }

  const failed = issues.some((i) => i.severity === 'error');
  if (failed) return { ok: false, issues };

  if (fromSchemaVersion >= ATLAS_SCHEMA_VERSION && current >= ATLAS_SCHEMA_VERSION) {
    issues.push(
      issue(
        'MIGRATION_ALREADY_FINALIZED',
        '$',
        `schema_version 已经是 ${current}：不重复迁移、不重建世界（幂等）`,
        'warning',
        false,
      ),
    );
    return { ok: true, issues };
  }

  try {
    // schema_version 是程序常量（不是用户输入），与 installSchema 同一写法。
    db.run(`PRAGMA user_version = ${ATLAS_SCHEMA_VERSION}`);
  } catch (err) {
    issues.push(issue('MIGRATION_FINALIZE_FAILED', '$', `写入 schema_version 失败：${(err as Error).message}`, 'error', true));
    return { ok: false, issues };
  }
  return { ok: true, issues };
}

/* ================================================================== *
 * 旧档备份负载
 * ================================================================== */

function detach(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return value;
  }
}

/**
 * 旧档只保留**一次**备份：本函数只构造负载，由调用方写进聊天的导出/附件区。
 * 不写任何存储（不碰数据库、不碰 chatMetadata），也不改动传入的旧档。
 */
export function legacyBackupPayload(raw: unknown, options: { capturedWallMs?: number } = {}): LegacyBackup {
  const located = locateAtlas(raw);
  return {
    kind: 'legacy_backup',
    capturedWallMs: options.capturedWallMs ?? Date.now(),
    payload: detach(located.atlas ?? raw),
  };
}
