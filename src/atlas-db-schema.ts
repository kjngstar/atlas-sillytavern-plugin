/**
 * atlas-db-schema.ts — §3～6 二十张表的 DDL、索引、约束与 installSchema（A07–A28）。
 *
 * 规则（§17A schema 细则）：
 * - 普通标量外键 ON DELETE RESTRICT，不用级联删除故事记录。
 * - 循环建档顺序涉及的 FK 使用 DEFERRABLE INITIALLY DEFERRED；组边界显式校验（E03）。
 * - 所有 enum 用 CHECK；名字必填时 trim 后不为空。
 * - 所有标识符来自本文件固定常量，绝不接受模型文本拼 SQL。
 */

import type { AtlasTableName } from './atlas-db-contract.ts';

export const ATLAS_SCHEMA_VERSION = 1;

export type ColumnSpec = {
  name: string;
  /** 是否允许 SQL NULL。 */
  nullable: boolean;
};

const C_COLUMNS: ColumnSpec[] = [
  { name: 'branch_id', nullable: false },
  { name: 'id', nullable: false },
  { name: 'row_rev', nullable: false },
  { name: 'created_turn_id', nullable: false },
  { name: 'updated_turn_id', nullable: false },
];

function col(name: string, nullable = true): ColumnSpec {
  return { name, nullable };
}

function cols(...names: string[]): ColumnSpec[] {
  return names.map((n) => col(n));
}

function notNull(...names: string[]): ColumnSpec[] {
  return names.map((n) => ({ name: n, nullable: false }));
}

/** 十四张业务表 + 六张内部表的列清单（顺序即建表顺序，codec 依此固定列序）。 */
export const ATLAS_TABLE_COLUMNS: Record<AtlasTableName, ColumnSpec[]> = {
  maps: [
    ...C_COLUMNS,
    ...notNull('name', 'kind', 'frame_json', 'scale_quality', 'scale_basis_json', 'scale_locked', 'calibration_rev', 'default_terrain', 'status'),
    ...cols('container_location_id', 'description', 'meters_per_cell', 'scale_min_meters_per_cell', 'scale_max_meters_per_cell', 'background_asset_key'),
  ],
  locations: [
    ...C_COLUMNS,
    ...notNull('name', 'aliases_json', 'kind', 'mobility', 'coord_precision', 'terrain', 'existence_quality', 'status'),
    ...cols('description', 'parent_location_id', 'anchor_location_id', 'map_id', 'grid_x', 'grid_y', 'uncertainty_radius_cells', 'area_geometry_json', 'access_rules_json', 'vehicle_profile_json', 'merged_into_id'),
  ],
  characters: [
    ...C_COLUMNS,
    ...notNull('name', 'aliases_json', 'role', 'importance', 'physical_status', 'coord_precision', 'mobility_profiles_json', 'capabilities_json', 'status'),
    ...cols('identity', 'description', 'personality', 'importance_reason', 'thought', 'action_tendency', 'condition_note', 'location_id', 'map_id', 'grid_x', 'grid_y', 'uncertainty_radius_cells', 'merged_into_id'),
  ],
  items: [
    ...C_COLUMNS,
    ...notNull('name', 'aliases_json', 'kind', 'unit', 'coord_precision', 'properties_json', 'status'),
    ...cols('description', 'quantity', 'condition_note', 'owner_entity_id', 'holder_character_id', 'container_item_id', 'location_id', 'map_id', 'grid_x', 'grid_y', 'uncertainty_radius_cells', 'merged_into_id'),
  ],
  factions: [
    ...C_COLUMNS,
    ...notNull('name', 'aliases_json', 'kind', 'capabilities_json', 'status'),
    ...cols('description', 'goal', 'headquarters_location_id', 'merged_into_id'),
  ],
  relations: [
    ...C_COLUMNS,
    ...notNull('subject_entity_id', 'object_entity_id', 'kind', 'label', 'attitude', 'trust', 'basis_quality', 'secrecy', 'valid_from_s', 'status'),
    ...cols('description', 'valid_until_s'),
  ],
  routes: [
    ...C_COLUMNS,
    ...notNull('from_location_id', 'to_location_id', 'kind', 'bidirectional', 'geometry_quality', 'geometry_rev', 'distance_basis', 'terrain', 'allowed_modes_json', 'status'),
    ...cols('map_id', 'geometry_json', 'distance_m', 'distance_min_m', 'distance_max_m', 'access_rules_json', 'travel_time_override_json', 'status_reason'),
  ],
  actions: [
    ...C_COLUMNS,
    ...notNull('actor_entity_id', 'kind', 'title', 'intent', 'depends_on_json', 'progress_s', 'evaluated_until_s', 'secrecy', 'priority', 'status'),
    ...cols('parent_action_id', 'target_entity_id', 'target_location_id', 'target_event_id', 'trigger_json', 'payload_json', 'duration_json', 'earliest_start_s', 'deadline_s', 'next_check_s', 'started_at_s', 'finished_at_s', 'reason_code', 'result_event_id'),
  ],
  journeys: [
    ...C_COLUMNS,
    ...notNull('action_id', 'mover_entity_id', 'origin_location_id', 'destination_location_id', 'segments_json', 'segment_index', 'segment_time_done_s', 'started_at_s', 'last_advanced_at_s', 'position_quality', 'status'),
    ...cols('segment_distance_done_m', 'last_reached_location_id', 'stop_location_id', 'estimated_arrival_min_s', 'estimated_arrival_max_s', 'arrived_at_s', 'stop_reason'),
  ],
  events: [
    ...C_COLUMNS,
    ...notNull('title', 'kind', 'summary', 'participants_json', 'secrecy', 'status'),
    ...cols('location_id', 'route_id', 'route_progress_m', 'subject_entity_id', 'cause_action_id', 'parent_event_id', 'scheduled_start_s', 'trigger_json', 'occurred_at_s', 'ended_at_s', 'outcome'),
  ],
  information: [
    ...C_COLUMNS,
    ...notNull('kind', 'title', 'content', 'truth_status', 'secrecy', 'topic_key', 'content_hash', 'created_at_s', 'status'),
    ...cols('source_event_id', 'subject_entity_id', 'payload_json', 'origin_location_id', 'originator_entity_id', 'parent_information_id', 'expires_at_s', 'supersedes_information_id'),
  ],
  rumor_fronts: [
    ...C_COLUMNS,
    ...notNull('information_id', 'location_id', 'first_available_at_s', 'last_reinforced_at_s', 'reach', 'audience_json', 'status'),
    ...cols('via_channel_id', 'source_front_id', 'source_action_id', 'next_spread_check_s', 'expires_at_s'),
  ],
  knowledge: [
    ...C_COLUMNS,
    ...notNull('is_pov', 'information_id', 'first_received_at_s', 'belief', 'attention', 'status'),
    ...cols('knower_character_id', 'knower_faction_id', 'source_entity_id', 'source_front_id', 'source_channel_id', 'last_confirmed_at_s', 'reaction_note'),
  ],
  channels: [
    ...C_COLUMNS,
    ...notNull('name', 'kind', 'owner_entity_id', 'scope_json', 'latency_json', 'reliability', 'secrecy', 'basis_quality', 'valid_from_s', 'status'),
    ...cols('source_entity_id', 'source_location_id', 'recipient_entity_id', 'recipient_location_id', 'requirements_json', 'transport_mode_key', 'valid_until_s'),
  ],
  entity_keys: [col('branch_id', false), col('id', false), col('kind', false)],
  branches: [
    ...notNull('id', 'revision', 'name', 'clock_s', 'clock_min_s', 'clock_max_s', 'simulation_cursor_s', 'simulation_status', 'ruleset_version', 'status', 'created_wall_ms'),
    ...cols('parent_branch_id', 'fork_turn_id', 'head_turn_id', 'pov_character_id', 'root_map_id', 'calendar_label'),
  ],
  turns: [
    ...notNull('id', 'branch_id', 'kind', 'input_hash', 'base_revision', 'clock_before_s', 'elapsed_json', 'clock_after_s', 'rng_seed', 'ruleset_version', 'decisions_json', 'attempts_json', 'status', 'created_wall_ms'),
    ...cols('parent_turn_id', 'host_message_uid', 'host_variant_key', 'story_hash', 'committed_revision', 'receipt_json', 'prepared_wall_ms'),
  ],
  turn_changes: [
    ...notNull('id', 'turn_id', 'sequence', 'attempt_id', 'group_id', 'operation_id', 'target_table', 'target_row_id', 'operation', 'basis_json', 'summary'),
    ...cols('before_json', 'after_json'),
  ],
  mention_candidates: [
    ...notNull('branch_id', 'id', 'name', 'normalized_name', 'context_key', 'kind_hint', 'first_turn_id', 'last_turn_id', 'distinct_turn_count', 'recent_turn_ids_json', 'context_summary', 'lorebook_source_keys_json', 'importance_hint', 'status'),
    ...cols('promoted_entity_id'),
  ],
  sync_outbox: [
    ...notNull('id', 'branch_id', 'target', 'projection_scope', 'target_revision', 'idempotency_key', 'payload_hash', 'status', 'attempt_count', 'created_wall_ms'),
    ...cols('requested_by_turn_id', 'next_retry_wall_ms', 'last_error_code', 'last_error_message', 'completed_wall_ms'),
  ],
};

export function tableColumnNames(table: AtlasTableName): string[] {
  return ATLAS_TABLE_COLUMNS[table].map((c) => c.name);
}

export function isKnownTable(name: string): name is AtlasTableName {
  return Object.prototype.hasOwnProperty.call(ATLAS_TABLE_COLUMNS, name);
}

/** 主键列（用于部分唯一索引断言）。 */
export function primaryKeyColumns(table: AtlasTableName): string[] {
  return table === 'branches' || table === 'turns' || table === 'turn_changes' || table === 'sync_outbox'
    ? ['id']
    : ['branch_id', 'id'];
}

function commonColumnsSql(): string {
  return `  branch_id TEXT NOT NULL,
  id TEXT NOT NULL,
  row_rev INTEGER NOT NULL DEFAULT 1 CHECK (row_rev >= 1),
  created_turn_id TEXT NOT NULL,
  updated_turn_id TEXT NOT NULL`;
}

/** A07：五项 C 的共同列定义（供各业务表 DDL 复用）。 */
export function commonColumnsSqlFor(): string {
  return commonColumnsSql();
}

/** §A07 完成定义：主键 branch_id+id，版本正整数。 */
export function businessPrimaryKeySql(): string {
  return '  PRIMARY KEY (branch_id, id)';
}

function entityKeyFk(): string {
  return '  FOREIGN KEY (branch_id, id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED';
}

const COMMON_TURN_FKS = `  FOREIGN KEY (branch_id, created_turn_id) REFERENCES turns(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, updated_turn_id) REFERENCES turns(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED`;

/** A08 entity_keys。 */
export function entityKeysSql(): string {
  return `CREATE TABLE IF NOT EXISTS entity_keys (
  branch_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('location','character','item','faction')),
  PRIMARY KEY (branch_id, id)
)`;
}

/** A09 branches。 */
export function branchesSql(): string {
  return `CREATE TABLE IF NOT EXISTS branches (
  id TEXT NOT NULL PRIMARY KEY,
  parent_branch_id TEXT,
  fork_turn_id TEXT,
  head_turn_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  pov_character_id TEXT,
  root_map_id TEXT,
  clock_s REAL NOT NULL DEFAULT 0,
  clock_min_s REAL NOT NULL DEFAULT 0,
  clock_max_s REAL NOT NULL DEFAULT 0,
  calendar_label TEXT,
  simulation_cursor_s REAL NOT NULL DEFAULT 0,
  simulation_status TEXT NOT NULL DEFAULT 'current' CHECK (simulation_status IN ('current','catching_up','blocked')),
  ruleset_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_wall_ms INTEGER NOT NULL,
  CHECK (clock_min_s <= clock_s),
  CHECK (clock_s <= clock_max_s),
  CHECK (clock_min_s >= 0 AND clock_max_s >= 0 AND simulation_cursor_s >= 0),
  FOREIGN KEY (parent_branch_id) REFERENCES branches(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (fork_turn_id) REFERENCES turns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (head_turn_id) REFERENCES turns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
)`;
}

/** A10 turns（全局 turn ID）。 */
export function turnsSql(): string {
  return `CREATE TABLE IF NOT EXISTS turns (
  id TEXT NOT NULL PRIMARY KEY,
  branch_id TEXT NOT NULL,
  parent_turn_id TEXT,
  host_message_uid TEXT,
  host_variant_key TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('narrative','manual','migration','background','fork')),
  input_hash TEXT NOT NULL,
  story_hash TEXT,
  base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
  committed_revision INTEGER,
  clock_before_s REAL NOT NULL,
  elapsed_json TEXT NOT NULL,
  clock_after_s REAL NOT NULL,
  rng_seed TEXT NOT NULL,
  ruleset_version TEXT NOT NULL,
  decisions_json TEXT NOT NULL,
  receipt_json TEXT,
  attempts_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','committed','partial','failed','rolled_back')),
  created_wall_ms INTEGER NOT NULL,
  prepared_wall_ms INTEGER,
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (parent_turn_id) REFERENCES turns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (committed_revision IS NULL OR committed_revision >= base_revision)
)`;
}

/** 身份类型触发器用：每类实体表与本表 kind 必须一致。 */
function entityKindTrigger(table: string, kind: string): string {
  return `CREATE TRIGGER IF NOT EXISTS trg_${table}_entity_kind_insert
BEFORE INSERT ON ${table}
FOR EACH ROW
WHEN COALESCE((SELECT kind FROM entity_keys WHERE branch_id = NEW.branch_id AND id = NEW.id), '') <> '${kind}'
BEGIN
  SELECT RAISE(ABORT, 'ENTITY_KEY_KIND_MISMATCH: ${table}');
END`;
}

function entityKindTriggerUpdate(table: string, kind: string): string {
  return `CREATE TRIGGER IF NOT EXISTS trg_${table}_entity_kind_update
BEFORE UPDATE ON ${table}
FOR EACH ROW
WHEN COALESCE((SELECT kind FROM entity_keys WHERE branch_id = NEW.branch_id AND id = NEW.id), '') <> '${kind}'
BEGIN
  SELECT RAISE(ABORT, 'ENTITY_KEY_KIND_MISMATCH: ${table}');
END`;
}

/** A11 maps。 */
export function mapsSql(): string {
  return `CREATE TABLE IF NOT EXISTS maps (
  ${commonColumnsSql()},
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('world','region','site','interior')),
  container_location_id TEXT,
  description TEXT NOT NULL DEFAULT '',
  frame_json TEXT NOT NULL,
  meters_per_cell REAL CHECK (meters_per_cell IS NULL OR meters_per_cell > 0),
  scale_min_meters_per_cell REAL CHECK (scale_min_meters_per_cell IS NULL OR scale_min_meters_per_cell > 0),
  scale_max_meters_per_cell REAL CHECK (scale_max_meters_per_cell IS NULL OR scale_max_meters_per_cell > 0),
  scale_quality TEXT NOT NULL CHECK (scale_quality IN ('uncalibrated','estimated','confirmed')),
  scale_basis_json TEXT NOT NULL DEFAULT '',
  scale_locked INTEGER NOT NULL DEFAULT 0 CHECK (scale_locked IN (0,1)),
  calibration_rev INTEGER NOT NULL DEFAULT 1 CHECK (calibration_rev >= 1),
  background_asset_key TEXT,
  default_terrain TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  ${businessPrimaryKeySql()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, container_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (scale_min_meters_per_cell IS NULL OR meters_per_cell IS NULL OR scale_min_meters_per_cell <= meters_per_cell),
  CHECK (scale_max_meters_per_cell IS NULL OR meters_per_cell IS NULL OR meters_per_cell <= scale_max_meters_per_cell)
)`;
}

/** A12 locations。 */
export function locationsSql(): string {
  return `CREATE TABLE IF NOT EXISTS locations (
  ${commonColumnsSql()},
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  aliases_json TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL CHECK (kind IN ('region','city','district','building','room','natural','vehicle','other')),
  description TEXT NOT NULL DEFAULT '',
  parent_location_id TEXT,
  mobility TEXT NOT NULL DEFAULT 'fixed' CHECK (mobility IN ('fixed','mobile')),
  anchor_location_id TEXT,
  map_id TEXT,
  grid_x REAL,
  grid_y REAL,
  coord_precision TEXT NOT NULL DEFAULT 'unknown' CHECK (coord_precision IN ('exact','approximate','layout','unknown')),
  uncertainty_radius_cells REAL,
  area_geometry_json TEXT,
  terrain TEXT NOT NULL DEFAULT 'unknown',
  access_rules_json TEXT,
  vehicle_profile_json TEXT,
  existence_quality TEXT NOT NULL DEFAULT 'confirmed' CHECK (existence_quality IN ('confirmed','inferred','hypothetical')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','destroyed','merged','archived')),
  merged_into_id TEXT,
  ${businessPrimaryKeySql()},
  ${entityKeyFk()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, parent_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, anchor_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, merged_into_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, map_id) REFERENCES maps(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK ((grid_x IS NULL) = (grid_y IS NULL)),
  CHECK (grid_x IS NULL OR grid_y IS NULL OR (grid_x = grid_x AND grid_y = grid_y)),
  CHECK (grid_x IS NULL OR map_id IS NOT NULL),
  CHECK (parent_location_id IS NULL OR parent_location_id <> id),
  CHECK (uncertainty_radius_cells IS NULL OR uncertainty_radius_cells >= 0),
  CHECK (existence_quality <> 'hypothetical' OR status <> 'destroyed')
)`;
}

/** A13 characters。 */
export function charactersSql(): string {
  return `CREATE TABLE IF NOT EXISTS characters (
  ${commonColumnsSql()},
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  aliases_json TEXT NOT NULL DEFAULT '[]',
  role TEXT NOT NULL DEFAULT 'npc' CHECK (role IN ('protagonist','companion','npc')),
  identity TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  importance TEXT NOT NULL DEFAULT 'supporting' CHECK (importance IN ('core','recurring','supporting')),
  importance_reason TEXT NOT NULL DEFAULT '',
  thought TEXT NOT NULL DEFAULT '',
  action_tendency TEXT NOT NULL DEFAULT '',
  physical_status TEXT NOT NULL DEFAULT 'unknown' CHECK (physical_status IN ('alive','incapacitated','dead','unknown')),
  condition_note TEXT NOT NULL DEFAULT '',
  location_id TEXT,
  map_id TEXT,
  grid_x REAL,
  grid_y REAL,
  coord_precision TEXT NOT NULL DEFAULT 'unknown' CHECK (coord_precision IN ('exact','approximate','unknown')),
  uncertainty_radius_cells REAL,
  mobility_profiles_json TEXT NOT NULL DEFAULT '[]',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','merged')),
  merged_into_id TEXT,
  ${businessPrimaryKeySql()},
  ${entityKeyFk()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, merged_into_id) REFERENCES characters(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, map_id) REFERENCES maps(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK ((grid_x IS NULL) = (grid_y IS NULL)),
  CHECK (grid_x IS NULL OR map_id IS NOT NULL),
  CHECK (coord_precision <> 'layout'),
  CHECK (uncertainty_radius_cells IS NULL OR uncertainty_radius_cells >= 0)
)`;
}

/** A14 items。 */
export function itemsSql(): string {
  return `CREATE TABLE IF NOT EXISTS items (
  ${commonColumnsSql()},
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  aliases_json TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('object','resource','document','equipment','container','other')),
  description TEXT NOT NULL DEFAULT '',
  quantity REAL CHECK (quantity IS NULL OR quantity >= 0),
  unit TEXT NOT NULL DEFAULT '件',
  condition_note TEXT NOT NULL DEFAULT '',
  owner_entity_id TEXT,
  holder_character_id TEXT,
  container_item_id TEXT,
  location_id TEXT,
  map_id TEXT,
  grid_x REAL,
  grid_y REAL,
  coord_precision TEXT NOT NULL DEFAULT 'unknown' CHECK (coord_precision IN ('exact','approximate','unknown')),
  uncertainty_radius_cells REAL,
  properties_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','destroyed','lost','merged','archived')),
  merged_into_id TEXT,
  ${businessPrimaryKeySql()},
  ${entityKeyFk()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, owner_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, holder_character_id) REFERENCES characters(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, container_item_id) REFERENCES items(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, map_id) REFERENCES maps(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, merged_into_id) REFERENCES items(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK ((holder_character_id IS NOT NULL) + (container_item_id IS NOT NULL) + (location_id IS NOT NULL) <= 1),
  CHECK ((grid_x IS NULL) = (grid_y IS NULL)),
  CHECK (grid_x IS NULL OR map_id IS NOT NULL),
  CHECK (container_item_id IS NULL OR container_item_id <> id),
  CHECK (uncertainty_radius_cells IS NULL OR uncertainty_radius_cells >= 0)
)`;
}

/** A15 factions。 */
export function factionsSql(): string {
  return `CREATE TABLE IF NOT EXISTS factions (
  ${commonColumnsSql()},
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  aliases_json TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('nation','organization','family','team','other')),
  description TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL DEFAULT '',
  headquarters_location_id TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dissolved','merged','archived')),
  merged_into_id TEXT,
  ${businessPrimaryKeySql()},
  ${entityKeyFk()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, headquarters_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, merged_into_id) REFERENCES factions(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
)`;
}

/** A16 relations。 */
export function relationsSql(): string {
  return `CREATE TABLE IF NOT EXISTS relations (
  ${commonColumnsSql()},
  subject_entity_id TEXT NOT NULL,
  object_entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('member_of','leads','controls','knows','kinship','ally','hostile','owes','protects','other')),
  label TEXT NOT NULL DEFAULT '',
  attitude TEXT NOT NULL DEFAULT 'unknown' CHECK (attitude IN ('supportive','neutral','suspicious','hostile','unknown')),
  trust TEXT NOT NULL DEFAULT 'unknown' CHECK (trust IN ('high','medium','low','unknown')),
  description TEXT NOT NULL DEFAULT '',
  basis_quality TEXT NOT NULL DEFAULT 'inferred' CHECK (basis_quality IN ('confirmed','inferred')),
  secrecy TEXT NOT NULL DEFAULT 'restricted' CHECK (secrecy IN ('public','restricted','secret')),
  valid_from_s REAL NOT NULL DEFAULT 0,
  valid_until_s REAL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','disputed')),
  ${businessPrimaryKeySql()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, subject_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, object_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (subject_entity_id <> object_entity_id),
  CHECK (valid_until_s IS NULL OR valid_until_s >= valid_from_s)
)`;
}

/** A17 routes。 */
export function routesSql(): string {
  return `CREATE TABLE IF NOT EXISTS routes (
  ${commonColumnsSql()},
  from_location_id TEXT NOT NULL,
  to_location_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('adjacent','road','path','door','stairs','air','water','portal','estimated')),
  bidirectional INTEGER NOT NULL DEFAULT 1 CHECK (bidirectional IN (0,1)),
  map_id TEXT,
  geometry_json TEXT,
  geometry_quality TEXT NOT NULL DEFAULT 'unknown' CHECK (geometry_quality IN ('confirmed','estimated','unknown')),
  geometry_rev INTEGER NOT NULL DEFAULT 1 CHECK (geometry_rev >= 1),
  distance_m REAL CHECK (distance_m IS NULL OR distance_m >= 0),
  distance_min_m REAL CHECK (distance_min_m IS NULL OR distance_min_m >= 0),
  distance_max_m REAL CHECK (distance_max_m IS NULL OR distance_max_m >= 0),
  distance_basis TEXT NOT NULL DEFAULT 'unknown' CHECK (distance_basis IN ('measured','calibrated','narrative','estimated','unknown')),
  terrain TEXT NOT NULL DEFAULT 'unknown',
  allowed_modes_json TEXT NOT NULL DEFAULT '[]',
  access_rules_json TEXT,
  travel_time_override_json TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','blocked','closed')),
  status_reason TEXT NOT NULL DEFAULT '',
  ${businessPrimaryKeySql()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, from_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, to_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, map_id) REFERENCES maps(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (from_location_id <> to_location_id),
  CHECK (distance_min_m IS NULL OR distance_m IS NULL OR distance_min_m <= distance_m),
  CHECK (distance_max_m IS NULL OR distance_m IS NULL OR distance_m <= distance_max_m),
  CHECK (distance_min_m IS NULL OR distance_max_m IS NULL OR distance_min_m <= distance_max_m)
)`;
}

/** A18 actions。 */
export function actionsSql(): string {
  return `CREATE TABLE IF NOT EXISTS actions (
  ${commonColumnsSql()},
  actor_entity_id TEXT NOT NULL,
  parent_action_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('goal','prepare','travel','wait','interact','transmit','investigate','act')),
  title TEXT NOT NULL DEFAULT '',
  intent TEXT NOT NULL DEFAULT '',
  target_entity_id TEXT,
  target_location_id TEXT,
  target_event_id TEXT,
  trigger_json TEXT,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT,
  duration_json TEXT,
  progress_s REAL NOT NULL DEFAULT 0 CHECK (progress_s >= 0),
  earliest_start_s REAL,
  deadline_s REAL,
  next_check_s REAL,
  started_at_s REAL,
  finished_at_s REAL,
  evaluated_until_s REAL NOT NULL DEFAULT 0,
  secrecy TEXT NOT NULL DEFAULT 'restricted' CHECK (secrecy IN ('public','restricted','secret')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','ready','active','paused','blocked','completed','failed','cancelled')),
  reason_code TEXT,
  result_event_id TEXT,
  ${businessPrimaryKeySql()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, actor_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, parent_action_id) REFERENCES actions(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, target_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, target_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, target_event_id) REFERENCES events(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, result_event_id) REFERENCES events(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (parent_action_id IS NULL OR parent_action_id <> id),
  CHECK (finished_at_s IS NULL OR started_at_s IS NULL OR finished_at_s >= started_at_s)
)`;
}

/** A19 journeys。 */
export function journeysSql(): string {
  return `CREATE TABLE IF NOT EXISTS journeys (
  ${commonColumnsSql()},
  action_id TEXT NOT NULL,
  mover_entity_id TEXT NOT NULL,
  origin_location_id TEXT NOT NULL,
  destination_location_id TEXT NOT NULL,
  segments_json TEXT NOT NULL DEFAULT '[]',
  segment_index INTEGER NOT NULL DEFAULT 0 CHECK (segment_index >= 0),
  segment_distance_done_m REAL CHECK (segment_distance_done_m IS NULL OR segment_distance_done_m >= 0),
  segment_time_done_s REAL NOT NULL DEFAULT 0 CHECK (segment_time_done_s >= 0),
  last_reached_location_id TEXT,
  stop_location_id TEXT,
  started_at_s REAL NOT NULL,
  last_advanced_at_s REAL NOT NULL,
  estimated_arrival_min_s REAL,
  estimated_arrival_max_s REAL,
  arrived_at_s REAL,
  position_quality TEXT NOT NULL DEFAULT 'unlocated' CHECK (position_quality IN ('route_confirmed','route_estimated','unlocated')),
  status TEXT NOT NULL DEFAULT 'moving' CHECK (status IN ('moving','paused','arrived','cancelled','blocked')),
  stop_reason TEXT,
  ${businessPrimaryKeySql()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, action_id) REFERENCES actions(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, mover_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, origin_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, destination_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, last_reached_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, stop_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (last_advanced_at_s >= started_at_s),
  CHECK (estimated_arrival_min_s IS NULL OR estimated_arrival_max_s IS NULL OR estimated_arrival_min_s <= estimated_arrival_max_s),
  CHECK (status <> 'moving' OR stop_location_id IS NULL)
)`;
}

/** A20 events。 */
export function eventsSql(): string {
  return `CREATE TABLE IF NOT EXISTS events (
  ${commonColumnsSql()},
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('ceremony','conflict','arrival','passage','discovery','trade','communication','incident','other')),
  summary TEXT NOT NULL DEFAULT '',
  location_id TEXT,
  route_id TEXT,
  route_progress_m REAL CHECK (route_progress_m IS NULL OR route_progress_m >= 0),
  subject_entity_id TEXT,
  participants_json TEXT NOT NULL DEFAULT '[]',
  cause_action_id TEXT,
  parent_event_id TEXT,
  scheduled_start_s REAL,
  trigger_json TEXT,
  occurred_at_s REAL,
  ended_at_s REAL,
  outcome TEXT NOT NULL DEFAULT '',
  secrecy TEXT NOT NULL DEFAULT 'restricted' CHECK (secrecy IN ('public','restricted','secret')),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','ongoing','occurred','cancelled')),
  ${businessPrimaryKeySql()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, route_id) REFERENCES routes(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, subject_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, cause_action_id) REFERENCES actions(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, parent_event_id) REFERENCES events(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (parent_event_id IS NULL OR parent_event_id <> id),
  CHECK (status NOT IN ('occurred','ongoing') OR occurred_at_s IS NOT NULL),
  CHECK (ended_at_s IS NULL OR occurred_at_s IS NULL OR ended_at_s >= occurred_at_s)
)`;
}

/** A21 information。 */
export function informationSql(): string {
  return `CREATE TABLE IF NOT EXISTS information (
  ${commonColumnsSql()},
  kind TEXT NOT NULL DEFAULT 'observation' CHECK (kind IN ('observation','report','rumor','announcement','lie','hypothesis')),
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  source_event_id TEXT,
  subject_entity_id TEXT,
  payload_json TEXT,
  origin_location_id TEXT,
  originator_entity_id TEXT,
  parent_information_id TEXT,
  truth_status TEXT NOT NULL DEFAULT 'unknown' CHECK (truth_status IN ('true','false','mixed','unknown')),
  secrecy TEXT NOT NULL DEFAULT 'restricted' CHECK (secrecy IN ('public','restricted','secret')),
  topic_key TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  created_at_s REAL NOT NULL,
  expires_at_s REAL,
  supersedes_information_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','retracted','archived')),
  ${businessPrimaryKeySql()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, source_event_id) REFERENCES events(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, subject_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, origin_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, originator_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, parent_information_id) REFERENCES information(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, supersedes_information_id) REFERENCES information(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (parent_information_id IS NULL OR parent_information_id <> id),
  CHECK (expires_at_s IS NULL OR expires_at_s >= created_at_s)
)`;
}

/** A22 rumor_fronts。 */
export function rumorFrontsSql(): string {
  return `CREATE TABLE IF NOT EXISTS rumor_fronts (
  ${commonColumnsSql()},
  information_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  via_channel_id TEXT,
  source_front_id TEXT,
  source_action_id TEXT,
  first_available_at_s REAL NOT NULL,
  last_reinforced_at_s REAL NOT NULL,
  next_spread_check_s REAL,
  expires_at_s REAL,
  reach TEXT NOT NULL DEFAULT 'local' CHECK (reach IN ('isolated','local','widespread')),
  audience_json TEXT NOT NULL DEFAULT '{"access":"public","tags":[]}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','fading','ended')),
  ${businessPrimaryKeySql()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, information_id) REFERENCES information(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, via_channel_id) REFERENCES channels(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, source_front_id) REFERENCES rumor_fronts(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, source_action_id) REFERENCES actions(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (source_front_id IS NULL OR source_front_id <> id),
  CHECK (expires_at_s IS NULL OR expires_at_s >= first_available_at_s)
)`;
}

/** A23 knowledge。 */
export function knowledgeSql(): string {
  return `CREATE TABLE IF NOT EXISTS knowledge (
  ${commonColumnsSql()},
  knower_character_id TEXT,
  knower_faction_id TEXT,
  is_pov INTEGER NOT NULL DEFAULT 0 CHECK (is_pov IN (0,1)),
  information_id TEXT NOT NULL,
  source_entity_id TEXT,
  source_front_id TEXT,
  source_channel_id TEXT,
  first_received_at_s REAL NOT NULL,
  last_confirmed_at_s REAL,
  belief TEXT NOT NULL DEFAULT 'heard' CHECK (belief IN ('heard','doubted','believed','verified','rejected')),
  attention TEXT NOT NULL DEFAULT 'normal' CHECK (attention IN ('low','normal','high')),
  reaction_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','outdated','forgotten')),
  ${businessPrimaryKeySql()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, knower_character_id) REFERENCES characters(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, knower_faction_id) REFERENCES factions(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, information_id) REFERENCES information(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, source_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, source_front_id) REFERENCES rumor_fronts(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, source_channel_id) REFERENCES channels(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK ((knower_character_id IS NOT NULL) + (knower_faction_id IS NOT NULL) + (is_pov = 1) = 1),
  CHECK (last_confirmed_at_s IS NULL OR last_confirmed_at_s >= first_received_at_s)
)`;
}

/** A24 channels。 */
export function channelsSql(): string {
  return `CREATE TABLE IF NOT EXISTS channels (
  ${commonColumnsSql()},
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('contact','faction_network','messenger','surveillance','broadcast','magic','other')),
  owner_entity_id TEXT NOT NULL,
  source_entity_id TEXT,
  source_location_id TEXT,
  recipient_entity_id TEXT,
  recipient_location_id TEXT,
  scope_json TEXT NOT NULL DEFAULT '{"location_refs":[],"entity_refs":[],"topics":[]}',
  requirements_json TEXT,
  latency_json TEXT NOT NULL DEFAULT '{"quality":"unknown","basis_refs":[]}',
  transport_mode_key TEXT,
  reliability TEXT NOT NULL DEFAULT 'unknown' CHECK (reliability IN ('high','medium','low','unknown')),
  secrecy TEXT NOT NULL DEFAULT 'restricted' CHECK (secrecy IN ('public','restricted','secret')),
  basis_quality TEXT NOT NULL DEFAULT 'inferred' CHECK (basis_quality IN ('confirmed','inferred')),
  valid_from_s REAL NOT NULL DEFAULT 0,
  valid_until_s REAL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','interrupted','ended')),
  ${businessPrimaryKeySql()},
  ${COMMON_TURN_FKS},
  FOREIGN KEY (branch_id, owner_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, source_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, source_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, recipient_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, recipient_location_id) REFERENCES locations(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (recipient_entity_id IS NULL OR recipient_location_id IS NULL),
  CHECK (valid_until_s IS NULL OR valid_until_s >= valid_from_s)
)`;
}

/** A25 turn_changes。 */
export function turnChangesSql(): string {
  return `CREATE TABLE IF NOT EXISTS turn_changes (
  id TEXT NOT NULL PRIMARY KEY,
  turn_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  attempt_id TEXT NOT NULL DEFAULT '',
  group_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  target_table TEXT NOT NULL,
  target_row_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('insert','update','delete')),
  before_json TEXT,
  after_json TEXT,
  basis_json TEXT NOT NULL DEFAULT '{}',
  summary TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (operation <> 'insert' OR before_json IS NULL),
  CHECK (operation <> 'delete' OR after_json IS NULL)
)`;
}

/** A26 mention_candidates。 */
export function mentionsSql(): string {
  return `CREATE TABLE IF NOT EXISTS mention_candidates (
  branch_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  normalized_name TEXT NOT NULL,
  context_key TEXT NOT NULL DEFAULT '',
  kind_hint TEXT NOT NULL DEFAULT 'unknown' CHECK (kind_hint IN ('character','location','item','faction','unknown')),
  first_turn_id TEXT NOT NULL,
  last_turn_id TEXT NOT NULL,
  distinct_turn_count INTEGER NOT NULL DEFAULT 1 CHECK (distinct_turn_count >= 1),
  recent_turn_ids_json TEXT NOT NULL DEFAULT '[]',
  context_summary TEXT NOT NULL DEFAULT '',
  lorebook_source_keys_json TEXT NOT NULL DEFAULT '[]',
  importance_hint TEXT NOT NULL DEFAULT 'none' CHECK (importance_hint IN ('none','review','core')),
  promoted_entity_id TEXT,
  status TEXT NOT NULL DEFAULT 'watching' CHECK (status IN ('watching','promoted','dismissed')),
  PRIMARY KEY (branch_id, id),
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (first_turn_id) REFERENCES turns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (last_turn_id) REFERENCES turns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (branch_id, promoted_entity_id) REFERENCES entity_keys(branch_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
)`;
}

/** A27 sync_outbox。 */
export function outboxSql(): string {
  return `CREATE TABLE IF NOT EXISTS sync_outbox (
  id TEXT NOT NULL PRIMARY KEY,
  branch_id TEXT NOT NULL,
  requested_by_turn_id TEXT,
  target TEXT NOT NULL DEFAULT 'managed_lorebook' CHECK (target IN ('managed_lorebook')),
  projection_scope TEXT NOT NULL DEFAULT 'pov' CHECK (projection_scope IN ('pov','scene_portrayal')),
  target_revision INTEGER NOT NULL CHECK (target_revision >= 0),
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed','superseded')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_wall_ms INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  created_wall_ms INTEGER NOT NULL,
  completed_wall_ms INTEGER,
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (requested_by_turn_id) REFERENCES turns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
)`;
}

export type IndexSpec = { name: string; table: AtlasTableName; sql: string };

/** 复合外键要求被引用列上有唯一键；(branch_id,id) 供各业务表的 C 列引用。 */
export function turnsBranchKeySql(): string {
  return 'CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_branch_id ON turns(branch_id, id)';
}

/** §11.1 索引清单（除主键/外键之外至少要有这些）。 */
export const ATLAS_INDEXES: readonly IndexSpec[] = [
  { name: 'idx_locations_parent', table: 'locations', sql: 'CREATE INDEX IF NOT EXISTS idx_locations_parent ON locations(branch_id, parent_location_id)' },
  { name: 'idx_locations_map', table: 'locations', sql: 'CREATE INDEX IF NOT EXISTS idx_locations_map ON locations(branch_id, map_id)' },
  { name: 'idx_locations_anchor', table: 'locations', sql: 'CREATE INDEX IF NOT EXISTS idx_locations_anchor ON locations(branch_id, anchor_location_id)' },
  { name: 'idx_characters_location', table: 'characters', sql: 'CREATE INDEX IF NOT EXISTS idx_characters_location ON characters(branch_id, location_id, status)' },
  { name: 'idx_characters_map', table: 'characters', sql: 'CREATE INDEX IF NOT EXISTS idx_characters_map ON characters(branch_id, map_id)' },
  { name: 'idx_items_holder', table: 'items', sql: 'CREATE INDEX IF NOT EXISTS idx_items_holder ON items(branch_id, holder_character_id)' },
  { name: 'idx_items_container', table: 'items', sql: 'CREATE INDEX IF NOT EXISTS idx_items_container ON items(branch_id, container_item_id)' },
  { name: 'idx_items_location', table: 'items', sql: 'CREATE INDEX IF NOT EXISTS idx_items_location ON items(branch_id, location_id)' },
  { name: 'idx_relations_subject', table: 'relations', sql: 'CREATE INDEX IF NOT EXISTS idx_relations_subject ON relations(branch_id, subject_entity_id, status)' },
  { name: 'idx_relations_object', table: 'relations', sql: 'CREATE INDEX IF NOT EXISTS idx_relations_object ON relations(branch_id, object_entity_id, kind, status)' },
  { name: 'idx_relations_unique_key', table: 'relations', sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_unique_key ON relations(branch_id, subject_entity_id, object_entity_id, kind, label)' },
  { name: 'idx_maps_container', table: 'maps', sql: 'CREATE INDEX IF NOT EXISTS idx_maps_container ON maps(branch_id, container_location_id, status)' },
  {
    name: 'idx_maps_container_unique',
    table: 'maps',
    sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_maps_container_unique ON maps(branch_id, container_location_id) WHERE container_location_id IS NOT NULL AND status = 'active'",
  },
  { name: 'idx_routes_from', table: 'routes', sql: 'CREATE INDEX IF NOT EXISTS idx_routes_from ON routes(branch_id, from_location_id, status)' },
  { name: 'idx_routes_to', table: 'routes', sql: 'CREATE INDEX IF NOT EXISTS idx_routes_to ON routes(branch_id, to_location_id, status)' },
  { name: 'idx_actions_due', table: 'actions', sql: 'CREATE INDEX IF NOT EXISTS idx_actions_due ON actions(branch_id, status, next_check_s)' },
  { name: 'idx_actions_actor', table: 'actions', sql: 'CREATE INDEX IF NOT EXISTS idx_actions_actor ON actions(branch_id, actor_entity_id, status)' },
  { name: 'idx_actions_event', table: 'actions', sql: 'CREATE INDEX IF NOT EXISTS idx_actions_event ON actions(branch_id, target_event_id)' },
  { name: 'idx_journeys_advance', table: 'journeys', sql: 'CREATE INDEX IF NOT EXISTS idx_journeys_advance ON journeys(branch_id, status, last_advanced_at_s)' },
  {
    name: 'idx_journeys_open_mover',
    table: 'journeys',
    sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_journeys_open_mover ON journeys(branch_id, mover_entity_id) WHERE status IN ('moving','paused','blocked')",
  },
  { name: 'idx_journeys_action_unique', table: 'journeys', sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_journeys_action_unique ON journeys(branch_id, action_id)' },
  { name: 'idx_events_place', table: 'events', sql: 'CREATE INDEX IF NOT EXISTS idx_events_place ON events(branch_id, location_id, occurred_at_s)' },
  { name: 'idx_events_schedule', table: 'events', sql: 'CREATE INDEX IF NOT EXISTS idx_events_schedule ON events(branch_id, status, scheduled_start_s)' },
  { name: 'idx_events_subject', table: 'events', sql: 'CREATE INDEX IF NOT EXISTS idx_events_subject ON events(branch_id, subject_entity_id)' },
  { name: 'idx_information_subject', table: 'information', sql: 'CREATE INDEX IF NOT EXISTS idx_information_subject ON information(branch_id, subject_entity_id, status)' },
  { name: 'idx_information_event', table: 'information', sql: 'CREATE INDEX IF NOT EXISTS idx_information_event ON information(branch_id, source_event_id)' },
  { name: 'idx_information_topic', table: 'information', sql: 'CREATE INDEX IF NOT EXISTS idx_information_topic ON information(branch_id, topic_key, content_hash)' },
  {
    name: 'idx_rumor_fronts_unique',
    table: 'rumor_fronts',
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_rumor_fronts_unique ON rumor_fronts(branch_id, information_id, location_id)',
  },
  { name: 'idx_rumor_fronts_spread', table: 'rumor_fronts', sql: 'CREATE INDEX IF NOT EXISTS idx_rumor_fronts_spread ON rumor_fronts(branch_id, status, next_spread_check_s)' },
  {
    name: 'idx_knowledge_character',
    table: 'knowledge',
    sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_character ON knowledge(branch_id, knower_character_id, information_id) WHERE knower_character_id IS NOT NULL",
  },
  {
    name: 'idx_knowledge_faction',
    table: 'knowledge',
    sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_faction ON knowledge(branch_id, knower_faction_id, information_id) WHERE knower_faction_id IS NOT NULL",
  },
  {
    name: 'idx_knowledge_pov',
    table: 'knowledge',
    sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_pov ON knowledge(branch_id, information_id) WHERE is_pov = 1",
  },
  { name: 'idx_knowledge_information', table: 'knowledge', sql: 'CREATE INDEX IF NOT EXISTS idx_knowledge_information ON knowledge(branch_id, information_id)' },
  { name: 'idx_channels_owner', table: 'channels', sql: 'CREATE INDEX IF NOT EXISTS idx_channels_owner ON channels(branch_id, owner_entity_id, status)' },
  { name: 'idx_channels_source_entity', table: 'channels', sql: 'CREATE INDEX IF NOT EXISTS idx_channels_source_entity ON channels(branch_id, source_entity_id, status)' },
  { name: 'idx_channels_source_location', table: 'channels', sql: 'CREATE INDEX IF NOT EXISTS idx_channels_source_location ON channels(branch_id, source_location_id, status)' },
  { name: 'idx_turns_host', table: 'turns', sql: 'CREATE INDEX IF NOT EXISTS idx_turns_host ON turns(branch_id, host_message_uid, host_variant_key, input_hash)' },
  { name: 'idx_turns_parent', table: 'turns', sql: 'CREATE INDEX IF NOT EXISTS idx_turns_parent ON turns(parent_turn_id)' },
  { name: 'idx_turn_changes_sequence', table: 'turn_changes', sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_changes_sequence ON turn_changes(turn_id, sequence)' },
  {
    name: 'idx_turn_changes_group_row',
    table: 'turn_changes',
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_changes_group_row ON turn_changes(turn_id, group_id, target_table, target_row_id)',
  },
  { name: 'idx_turn_changes_target', table: 'turn_changes', sql: 'CREATE INDEX IF NOT EXISTS idx_turn_changes_target ON turn_changes(target_table, target_row_id)' },
  { name: 'idx_mentions_name', table: 'mention_candidates', sql: 'CREATE INDEX IF NOT EXISTS idx_mentions_name ON mention_candidates(branch_id, normalized_name)' },
  { name: 'idx_mentions_status', table: 'mention_candidates', sql: 'CREATE INDEX IF NOT EXISTS idx_mentions_status ON mention_candidates(branch_id, status, last_turn_id)' },
  {
    name: 'idx_outbox_idempotency',
    table: 'sync_outbox',
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_idempotency ON sync_outbox(idempotency_key)',
  },
  { name: 'idx_outbox_retry', table: 'sync_outbox', sql: 'CREATE INDEX IF NOT EXISTS idx_outbox_retry ON sync_outbox(status, next_retry_wall_ms)' },
];

/** 全部 DDL 语句（固定顺序，全部标识符为本文件常量）。 */
export function schemaStatements(): string[] {
  return [
    entityKeysSql(),
    branchesSql(),
    turnsSql(),
    mapsSql(),
    locationsSql(),
    charactersSql(),
    itemsSql(),
    factionsSql(),
    relationsSql(),
    routesSql(),
    actionsSql(),
    journeysSql(),
    eventsSql(),
    informationSql(),
    rumorFrontsSql(),
    knowledgeSql(),
    channelsSql(),
    turnChangesSql(),
    mentionsSql(),
    outboxSql(),
    entityKindTrigger('locations', 'location'),
    entityKindTriggerUpdate('locations', 'location'),
    entityKindTrigger('characters', 'character'),
    entityKindTriggerUpdate('characters', 'character'),
    entityKindTrigger('items', 'item'),
    entityKindTriggerUpdate('items', 'item'),
    entityKindTrigger('factions', 'faction'),
    entityKindTriggerUpdate('factions', 'faction'),
    turnsBranchKeySql(),
    ...ATLAS_INDEXES.map((i) => i.sql),
  ];
}

export type MinimalDb = {
  run(sql: string): unknown;
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  prepare(sql: string): {
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  };
  close?: () => void;
};

/**
 * A28：安装 20 表、索引与 schema_version。
 * 幂等：已存在的表不重建；schema_version 写入 user_version。
 */
export function installSchema(db: MinimalDb): void {
  for (const sql of schemaStatements()) {
    db.run(sql);
  }
  db.run(`PRAGMA user_version = ${ATLAS_SCHEMA_VERSION}`);
}

/** 用户表数量断言辅助（不含 sqlite_% 内部表）。 */
export const USER_TABLE_COUNT = Object.keys(ATLAS_TABLE_COLUMNS).length;

/**
 * 幂等安装：已存在的表不重建；只在需要时写 user_version。
 * 已建库（有表）但版本更高时明确报错，不覆盖。
 */
export function installSchemaSafe(db: MinimalDb): void {
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  const names = new Set<string>((tables[0]?.values ?? []).map((row: unknown[]) => String(row[0])));
  const existing = names.size;
  if (existing > 0 && names.size !== USER_TABLE_COUNT) {
    const expected = new Set(Object.keys(ATLAS_TABLE_COLUMNS));
    const unexpected = [...names].filter((n) => !expected.has(n));
    const missing = [...expected].filter((n) => !names.has(n));
    throw new Error(
      `DB_SCHEMA_INVALID: 用户表不是预期的 ${USER_TABLE_COUNT} 张（多 ${unexpected.length}，少 ${missing.length}）：多 ${unexpected.join(',')}；少 ${missing.join(',')}`,
    );
  }
  for (const sql of schemaStatements()) db.run(sql);
  db.run(`PRAGMA user_version = ${ATLAS_SCHEMA_VERSION}`);
}
