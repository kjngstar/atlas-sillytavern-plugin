/**
 * atlas-db-contract.ts — §16.3 / §16.4 SQL 行类型、Repository 与宿主边界（A06）。
 *
 * 规则：
 * - SQL 行字段名 = §3～6 字段表的 snake_case；TypeScript DTO 用 camelCase，由 codec 唯一转换。
 * - 本文件只放类型与接口，不依赖 UI、宿主或 sql.js 运行时。
 * - `Record<string, unknown>` 是检查前表示；handler 必须收窄到这里的固定行类型。
 */

import type {
  AtomicGroup,
  MaintenanceInput,
  PreparedCommit,
  PreparedMaintenance,
  RollbackInput,
  RowMutation,
  SaveAck,
  TurnAnchor,
  TurnInput,
  TurnReceipt,
  ViewQuery,
  ViewResult,
} from './atlas-ops-contract.ts';

/** sql.js 参数绑定可接受的值。undefined 由 codec 归一为 NULL。 */
export type SqlValue = string | number | null | Uint8Array | undefined;

/** 14 张业务表共有的五项 C 列。 */
export type CommonColumns = {
  branch_id: string;
  id: string;
  row_rev: number;
  created_turn_id: string;
  updated_turn_id: string;
};

export type CoordPrecision = 'exact' | 'approximate' | 'layout' | 'unknown';
export type EntityStatusActive = 'active' | 'archived';

export type MapRow = CommonColumns & {
  name: string;
  kind: 'world' | 'region' | 'site' | 'interior';
  container_location_id: string | null;
  description: string;
  frame_json: string;
  meters_per_cell: number | null;
  scale_min_meters_per_cell: number | null;
  scale_max_meters_per_cell: number | null;
  scale_quality: 'uncalibrated' | 'estimated' | 'confirmed';
  scale_basis_json: string;
  scale_locked: number;
  calibration_rev: number;
  background_asset_key: string | null;
  default_terrain: string;
  status: 'active' | 'archived';
};

export type LocationRow = CommonColumns & {
  name: string;
  aliases_json: string;
  kind: 'region' | 'city' | 'district' | 'building' | 'room' | 'natural' | 'vehicle' | 'other';
  description: string;
  parent_location_id: string | null;
  mobility: 'fixed' | 'mobile';
  anchor_location_id: string | null;
  map_id: string | null;
  grid_x: number | null;
  grid_y: number | null;
  coord_precision: CoordPrecision;
  uncertainty_radius_cells: number | null;
  area_geometry_json: string | null;
  terrain: string;
  access_rules_json: string | null;
  vehicle_profile_json: string | null;
  existence_quality: 'confirmed' | 'inferred' | 'hypothetical';
  status: 'active' | 'destroyed' | 'merged' | 'archived';
  merged_into_id: string | null;
};

export type CharacterRow = CommonColumns & {
  name: string;
  aliases_json: string;
  role: 'protagonist' | 'companion' | 'npc';
  identity: string;
  description: string;
  personality: string;
  importance: 'core' | 'recurring' | 'supporting';
  importance_reason: string;
  thought: string;
  action_tendency: string;
  physical_status: 'alive' | 'incapacitated' | 'dead' | 'unknown';
  condition_note: string;
  location_id: string | null;
  map_id: string | null;
  grid_x: number | null;
  grid_y: number | null;
  coord_precision: 'exact' | 'approximate' | 'unknown';
  uncertainty_radius_cells: number | null;
  mobility_profiles_json: string;
  capabilities_json: string;
  status: 'active' | 'archived' | 'merged';
  merged_into_id: string | null;
};

export type ItemRow = CommonColumns & {
  name: string;
  aliases_json: string;
  kind: 'object' | 'resource' | 'document' | 'equipment' | 'container' | 'other';
  description: string;
  quantity: number | null;
  unit: string;
  condition_note: string;
  owner_entity_id: string | null;
  holder_character_id: string | null;
  container_item_id: string | null;
  location_id: string | null;
  map_id: string | null;
  grid_x: number | null;
  grid_y: number | null;
  coord_precision: 'exact' | 'approximate' | 'unknown';
  uncertainty_radius_cells: number | null;
  properties_json: string;
  status: 'active' | 'consumed' | 'destroyed' | 'lost' | 'merged' | 'archived';
  merged_into_id: string | null;
};

export type FactionRow = CommonColumns & {
  name: string;
  aliases_json: string;
  kind: 'nation' | 'organization' | 'family' | 'team' | 'other';
  description: string;
  goal: string;
  headquarters_location_id: string | null;
  capabilities_json: string;
  status: 'active' | 'dissolved' | 'merged' | 'archived';
  merged_into_id: string | null;
};

export type RelationRow = CommonColumns & {
  subject_entity_id: string;
  object_entity_id: string;
  kind:
    | 'member_of'
    | 'leads'
    | 'controls'
    | 'knows'
    | 'kinship'
    | 'ally'
    | 'hostile'
    | 'owes'
    | 'protects'
    | 'other';
  label: string;
  attitude: 'supportive' | 'neutral' | 'suspicious' | 'hostile' | 'unknown';
  trust: 'high' | 'medium' | 'low' | 'unknown';
  description: string;
  basis_quality: 'confirmed' | 'inferred';
  secrecy: 'public' | 'restricted' | 'secret';
  valid_from_s: number;
  valid_until_s: number | null;
  status: 'active' | 'ended' | 'disputed';
};

export type RouteRow = CommonColumns & {
  from_location_id: string;
  to_location_id: string;
  kind:
    | 'adjacent'
    | 'road'
    | 'path'
    | 'door'
    | 'stairs'
    | 'air'
    | 'water'
    | 'portal'
    | 'estimated';
  bidirectional: number;
  map_id: string | null;
  geometry_json: string | null;
  geometry_quality: 'confirmed' | 'estimated' | 'unknown';
  geometry_rev: number;
  distance_m: number | null;
  distance_min_m: number | null;
  distance_max_m: number | null;
  distance_basis: 'measured' | 'calibrated' | 'narrative' | 'estimated' | 'unknown';
  terrain: string;
  allowed_modes_json: string;
  access_rules_json: string | null;
  travel_time_override_json: string | null;
  status: 'open' | 'blocked' | 'closed';
  status_reason: string;
};

export type ActionRow = CommonColumns & {
  actor_entity_id: string;
  parent_action_id: string | null;
  kind:
    | 'goal'
    | 'prepare'
    | 'travel'
    | 'wait'
    | 'interact'
    | 'transmit'
    | 'investigate'
    | 'act';
  title: string;
  intent: string;
  target_entity_id: string | null;
  target_location_id: string | null;
  target_event_id: string | null;
  trigger_json: string | null;
  depends_on_json: string;
  payload_json: string | null;
  duration_json: string | null;
  progress_s: number;
  earliest_start_s: number | null;
  deadline_s: number | null;
  next_check_s: number | null;
  started_at_s: number | null;
  finished_at_s: number | null;
  evaluated_until_s: number;
  secrecy: 'public' | 'restricted' | 'secret';
  priority: 'low' | 'normal' | 'high';
  status: 'planned' | 'ready' | 'active' | 'paused' | 'blocked' | 'completed' | 'failed' | 'cancelled';
  reason_code: string | null;
  result_event_id: string | null;
};

export type JourneyRow = CommonColumns & {
  action_id: string;
  mover_entity_id: string;
  origin_location_id: string;
  destination_location_id: string;
  segments_json: string;
  segment_index: number;
  segment_distance_done_m: number | null;
  segment_time_done_s: number;
  last_reached_location_id: string | null;
  stop_location_id: string | null;
  started_at_s: number;
  last_advanced_at_s: number;
  estimated_arrival_min_s: number | null;
  estimated_arrival_max_s: number | null;
  arrived_at_s: number | null;
  position_quality: 'route_confirmed' | 'route_estimated' | 'unlocated';
  status: 'moving' | 'paused' | 'arrived' | 'cancelled' | 'blocked';
  stop_reason: string | null;
};

export type EventRow = CommonColumns & {
  title: string;
  kind:
    | 'ceremony'
    | 'conflict'
    | 'arrival'
    | 'passage'
    | 'discovery'
    | 'trade'
    | 'communication'
    | 'incident'
    | 'other';
  summary: string;
  location_id: string | null;
  route_id: string | null;
  route_progress_m: number | null;
  subject_entity_id: string | null;
  participants_json: string;
  cause_action_id: string | null;
  parent_event_id: string | null;
  scheduled_start_s: number | null;
  trigger_json: string | null;
  occurred_at_s: number | null;
  ended_at_s: number | null;
  outcome: string;
  secrecy: 'public' | 'restricted' | 'secret';
  status: 'scheduled' | 'ongoing' | 'occurred' | 'cancelled';
};

export type InformationRow = CommonColumns & {
  kind: 'observation' | 'report' | 'rumor' | 'announcement' | 'lie' | 'hypothesis';
  title: string;
  content: string;
  source_event_id: string | null;
  subject_entity_id: string | null;
  payload_json: string | null;
  origin_location_id: string | null;
  originator_entity_id: string | null;
  parent_information_id: string | null;
  truth_status: 'true' | 'false' | 'mixed' | 'unknown';
  secrecy: 'public' | 'restricted' | 'secret';
  topic_key: string;
  content_hash: string;
  created_at_s: number;
  expires_at_s: number | null;
  supersedes_information_id: string | null;
  status: 'active' | 'superseded' | 'retracted' | 'archived';
};

export type RumorFrontRow = CommonColumns & {
  information_id: string;
  location_id: string;
  via_channel_id: string | null;
  source_front_id: string | null;
  source_action_id: string | null;
  first_available_at_s: number;
  last_reinforced_at_s: number;
  next_spread_check_s: number | null;
  expires_at_s: number | null;
  reach: 'isolated' | 'local' | 'widespread';
  audience_json: string;
  status: 'active' | 'fading' | 'ended';
};

export type KnowledgeRow = CommonColumns & {
  knower_character_id: string | null;
  knower_faction_id: string | null;
  is_pov: number;
  information_id: string;
  source_entity_id: string | null;
  source_front_id: string | null;
  source_channel_id: string | null;
  first_received_at_s: number;
  last_confirmed_at_s: number | null;
  belief: 'heard' | 'doubted' | 'believed' | 'verified' | 'rejected';
  attention: 'low' | 'normal' | 'high';
  reaction_note: string;
  status: 'active' | 'outdated' | 'forgotten';
};

export type ChannelRow = CommonColumns & {
  name: string;
  kind: 'contact' | 'faction_network' | 'messenger' | 'surveillance' | 'broadcast' | 'magic' | 'other';
  owner_entity_id: string;
  source_entity_id: string | null;
  source_location_id: string | null;
  recipient_entity_id: string | null;
  recipient_location_id: string | null;
  scope_json: string;
  requirements_json: string | null;
  latency_json: string;
  transport_mode_key: string | null;
  reliability: 'high' | 'medium' | 'low' | 'unknown';
  secrecy: 'public' | 'restricted' | 'secret';
  basis_quality: 'confirmed' | 'inferred';
  valid_from_s: number;
  valid_until_s: number | null;
  status: 'active' | 'interrupted' | 'ended';
};

/* —— 六张内部表：不套用共同字段 C —— */

export type EntityKeyRow = {
  branch_id: string;
  id: string;
  kind: 'location' | 'character' | 'item' | 'faction';
};

export type BranchRow = {
  id: string;
  parent_branch_id: string | null;
  fork_turn_id: string | null;
  head_turn_id: string | null;
  revision: number;
  name: string;
  pov_character_id: string | null;
  root_map_id: string | null;
  clock_s: number;
  clock_min_s: number;
  clock_max_s: number;
  calendar_label: string | null;
  simulation_cursor_s: number;
  simulation_status: 'current' | 'catching_up' | 'blocked';
  ruleset_version: string;
  status: 'active' | 'archived';
  created_wall_ms: number;
};

export type TurnRow = {
  id: string;
  branch_id: string;
  parent_turn_id: string | null;
  host_message_uid: string | null;
  host_variant_key: string | null;
  kind: 'narrative' | 'manual' | 'migration' | 'background' | 'fork';
  input_hash: string;
  story_hash: string | null;
  base_revision: number;
  committed_revision: number | null;
  clock_before_s: number;
  elapsed_json: string;
  clock_after_s: number;
  rng_seed: string;
  ruleset_version: string;
  decisions_json: string;
  receipt_json: string | null;
  attempts_json: string;
  status: 'pending' | 'committed' | 'partial' | 'failed' | 'rolled_back';
  created_wall_ms: number;
  prepared_wall_ms: number | null;
};

export type TurnChangeRow = {
  id: string;
  turn_id: string;
  sequence: number;
  attempt_id: string;
  group_id: string;
  operation_id: string;
  target_table: string;
  target_row_id: string;
  operation: 'insert' | 'update' | 'delete';
  before_json: string | null;
  after_json: string | null;
  basis_json: string;
  summary: string;
};

export type MentionCandidateRow = {
  branch_id: string;
  id: string;
  name: string;
  normalized_name: string;
  context_key: string;
  kind_hint: 'character' | 'location' | 'item' | 'faction' | 'unknown';
  first_turn_id: string;
  last_turn_id: string;
  distinct_turn_count: number;
  recent_turn_ids_json: string;
  context_summary: string;
  lorebook_source_keys_json: string;
  importance_hint: 'none' | 'review' | 'core';
  promoted_entity_id: string | null;
  status: 'watching' | 'promoted' | 'dismissed';
};

export type SyncOutboxRow = {
  id: string;
  branch_id: string;
  requested_by_turn_id: string | null;
  target: 'managed_lorebook';
  projection_scope: 'pov' | 'scene_portrayal';
  target_revision: number;
  idempotency_key: string;
  payload_hash: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'superseded';
  attempt_count: number;
  next_retry_wall_ms: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_wall_ms: number;
  completed_wall_ms: number | null;
};

/** §3～6 全部 20 张表的行类型表。键名即 SQL 表名。 */
export type AtlasRowMap = {
  maps: MapRow;
  locations: LocationRow;
  characters: CharacterRow;
  items: ItemRow;
  factions: FactionRow;
  relations: RelationRow;
  routes: RouteRow;
  actions: ActionRow;
  journeys: JourneyRow;
  events: EventRow;
  information: InformationRow;
  rumor_fronts: RumorFrontRow;
  knowledge: KnowledgeRow;
  channels: ChannelRow;
  entity_keys: EntityKeyRow;
  branches: BranchRow;
  turns: TurnRow;
  turn_changes: TurnChangeRow;
  mention_candidates: MentionCandidateRow;
  sync_outbox: SyncOutboxRow;
};

export type AtlasTableName = keyof AtlasRowMap;

/** 14 张业务表（套用共同字段 C）。 */
export const BUSINESS_TABLES: readonly AtlasTableName[] = [
  'maps',
  'locations',
  'characters',
  'items',
  'factions',
  'relations',
  'routes',
  'actions',
  'journeys',
  'events',
  'information',
  'rumor_fronts',
  'knowledge',
  'channels',
];

/** 四张实体表（id 同时引用 entity_keys）。 */
export const ENTITY_TABLES: readonly AtlasTableName[] = ['locations', 'characters', 'items', 'factions'];

export const INTERNAL_TABLES: readonly AtlasTableName[] = [
  'entity_keys',
  'branches',
  'turns',
  'turn_changes',
  'mention_candidates',
  'sync_outbox',
];

/** §6.4 记录范围：14 业务表 + entity_keys + mention_candidates + branches 的可回退字段。 */
export const JOURNALED_TABLES: readonly string[] = [...BUSINESS_TABLES, 'entity_keys', 'mention_candidates', 'branches'];

/** §1.1 全部 20 张用户表（用于「恰 20 张用户表」断言）。 */
export const ATLAS_USER_TABLES: readonly AtlasTableName[] = [...BUSINESS_TABLES, ...INTERNAL_TABLES];

export type AtlasRow<T extends AtlasTableName> = AtlasRowMap[T];

/* —— §16.4 端口接口 —— */

export interface AtlasSqlRepository {
  open(bytes?: Uint8Array): Promise<void>;
  queryView(query: ViewQuery): Promise<ViewResult>;
  prepareTurn(input: TurnInput): Promise<PreparedCommit>;
  confirmSaved(ack: SaveAck): Promise<void>;
  discardPrepared(token: string): Promise<void>;
  prepareRollback(input: RollbackInput): Promise<PreparedCommit>;
  prepareMaintenance(input: MaintenanceInput): Promise<PreparedMaintenance>;
  exportCurrent(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface AtlasModelPort {
  preview?(request:import('./atlas-ops-contract.ts').ModelBatchRequest):Promise<{messages:Array<{role:string;content:string;chars:number}>;promptSource:string;missing:Record<string,boolean>;coreSaved:boolean}>;
  request(input: import('./atlas-ops-contract.ts').ModelBatchRequest): Promise<import('./atlas-ops-contract.ts').ModelBatchResponse>;
}

export type HostAnchor = {
  chatUid: string;
  hostChatId: string | null;
  metadataIdentity: unknown;
  /** Immutable copy of the envelope fields captured before awaiting host work. */
  databaseSnapshot?: unknown;
  branchId: string;
  revision: number;
  storageRevision: number;
};

export type HostSaveRequest = {
  capturedHostAnchor: HostAnchor;
  prepared: PreparedCommit | PreparedMaintenance;
  envelope: AtlasEnvelope;
};

export interface AtlasHostPort {
  captureAnchor(): HostAnchor;
  isCurrent(anchor: HostAnchor): boolean;
  saveCandidate(input: HostSaveRequest): Promise<SaveAck>;
  refreshViews(input: { branchId: string; revision: number }): Promise<void>;
}

/* —— §7.1 存档信封 —— */

export type AtlasAssetRef = {
  key: string;
  mime: string;
  sha256: string;
  storage_ref: string;
};

export type AtlasEnvelope = {
  format: 'atlas-sqlite';
  storage_version: 1;
  chat_uid: string;
  world_uid: string;
  storage_revision: number;
  active_branch_id: string;
  schema_version: number;
  encoding: 'sqlite-base64' | 'gzip-sqlite-base64';
  byte_length: number;
  sha256: string;
  data: string;
  assets: AtlasAssetRef[];
};

/** 检查前表示：通用 SQL 行。 */
export type RawSqlRow = Record<string, SqlValue>;

/** codec 收窄结果：固定列序 + 绑定参数。 */
export type EncodedRow = {
  table: AtlasTableName;
  columns: string[];
  values: SqlValue[];
};

export type DecodeResult<T> = { ok: true; row: T } | { ok: false; path: string; message: string };

export type { AtomicGroup, RowMutation, TurnReceipt, PreparedCommit, PreparedMaintenance, SaveAck, TurnInput, RollbackInput, MaintenanceInput, ViewQuery, ViewResult, TurnAnchor };
