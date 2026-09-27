/**
 * atlas-db-defaults.ts — §2.1 / §16.2 创建器统一补默认（A31）。
 *
 * 规则：
 * - 省略的可空字段为 NULL；普通描述为 ""；列表为 []；状态默认按各表状态机。
 * - coordinates 默认 unknown，不能默认 0。
 * - 人物 physical_status 默认 unknown、role 默认 npc、importance 默认 supporting。
 * - 地点 kind 默认 other、mobility 默认 fixed；势力 kind 默认 other。
 * - 关系 trust/attitude 默认 unknown；关系/计划/信息/渠道 secrecy 无依据时默认 restricted。
 * - information.truth_status 默认 unknown；事件不能仅凭标题默认 occurred。
 * - P 字段只从 ctx 注入，模型给的值一律被改写并记 SYSTEM_FIELD_IGNORED（在 normalize 层）。
 */

import type { AtlasTableName } from './atlas-db-contract.ts';
import { isKnownTable } from './atlas-db-schema.ts';

export type CreateRowContext = {
  branchId: string;
  id: string;
  turnId: string;
  clockS: number;
  nowWallMs: number;
  rulesetVersion: string;
  /** 固定 ID 生成器（程序分配，不透明）。 */
  newId?: (prefix: string) => string;
};

const LIST_COLUMNS = new Set([
  'aliases_json',
  'mobility_profiles_json',
  'capabilities_json',
  'properties_json',
  'depends_on_json',
  'participants_json',
  'allowed_modes_json',
  'segments_json',
  'recent_turn_ids_json',
  'lorebook_source_keys_json',
]);

function listDefault(table: AtlasTableName, column: string): unknown {
  if (!LIST_COLUMNS.has(column)) return null;
  if (table === 'journeys' && column === 'segments_json') return [];
  return [];
}

/** 各表字段表的默认值（除 C 列；C 列一律来自 ctx）。 */
function defaultsFor(table: AtlasTableName): Record<string, unknown> {
  switch (table) {
    case 'maps':
      return {
        name: '',
        kind: 'world',
        container_location_id: null,
        description: '',
        frame_json: { origin_x: 0, origin_y: 0, reference_width_cells: 1, reference_height_cells: 1 },
        meters_per_cell: null,
        scale_min_meters_per_cell: null,
        scale_max_meters_per_cell: null,
        scale_quality: 'uncalibrated',
        scale_basis_json: { refs: [], note: '' },
        scale_locked: 0,
        calibration_rev: 1,
        background_asset_key: null,
        default_terrain: 'unknown',
        status: 'active',
      };
    case 'locations':
      return {
        name: '',
        aliases_json: [],
        kind: 'other',
        description: '',
        parent_location_id: null,
        mobility: 'fixed',
        anchor_location_id: null,
        map_id: null,
        grid_x: null,
        grid_y: null,
        coord_precision: 'unknown',
        uncertainty_radius_cells: null,
        area_geometry_json: null,
        terrain: 'unknown',
        access_rules_json: null,
        vehicle_profile_json: null,
        existence_quality: 'confirmed',
        status: 'active',
        merged_into_id: null,
      };
    case 'characters':
      return {
        name: '',
        aliases_json: [],
        role: 'npc',
        identity: '',
        description: '',
        personality: '',
        importance: 'supporting',
        importance_reason: '',
        thought: '',
        action_tendency: '',
        physical_status: 'unknown',
        condition_note: '',
        location_id: null,
        map_id: null,
        grid_x: null,
        grid_y: null,
        coord_precision: 'unknown',
        uncertainty_radius_cells: null,
        mobility_profiles_json: [],
        capabilities_json: [],
        status: 'active',
        merged_into_id: null,
      };
    case 'items':
      return {
        name: '',
        aliases_json: [],
        kind: 'other',
        description: '',
        quantity: null,
        unit: '件',
        condition_note: '',
        owner_entity_id: null,
        holder_character_id: null,
        container_item_id: null,
        location_id: null,
        map_id: null,
        grid_x: null,
        grid_y: null,
        coord_precision: 'unknown',
        uncertainty_radius_cells: null,
        properties_json: [],
        status: 'active',
        merged_into_id: null,
      };
    case 'factions':
      return {
        name: '',
        aliases_json: [],
        kind: 'other',
        description: '',
        goal: '',
        headquarters_location_id: null,
        capabilities_json: [],
        status: 'active',
        merged_into_id: null,
      };
    case 'relations':
      return {
        subject_entity_id: '',
        object_entity_id: '',
        kind: 'other',
        label: '',
        attitude: 'unknown',
        trust: 'unknown',
        description: '',
        basis_quality: 'inferred',
        secrecy: 'restricted',
        valid_from_s: 0,
        valid_until_s: null,
        status: 'active',
      };
    case 'routes':
      return {
        from_location_id: '',
        to_location_id: '',
        kind: 'estimated',
        bidirectional: 1,
        map_id: null,
        geometry_json: null,
        geometry_quality: 'unknown',
        geometry_rev: 1,
        distance_m: null,
        distance_min_m: null,
        distance_max_m: null,
        distance_basis: 'unknown',
        terrain: 'unknown',
        allowed_modes_json: [],
        access_rules_json: null,
        travel_time_override_json: null,
        status: 'open',
        status_reason: '',
      };
    case 'actions':
      return {
        actor_entity_id: '',
        parent_action_id: null,
        kind: 'act',
        title: '',
        intent: '',
        target_entity_id: null,
        target_location_id: null,
        target_event_id: null,
        trigger_json: null,
        depends_on_json: [],
        payload_json: null,
        duration_json: null,
        progress_s: 0,
        earliest_start_s: null,
        deadline_s: null,
        next_check_s: null,
        started_at_s: null,
        finished_at_s: null,
        evaluated_until_s: 0,
        secrecy: 'restricted',
        priority: 'normal',
        status: 'planned',
        reason_code: null,
        result_event_id: null,
      };
    case 'journeys':
      return {
        action_id: '',
        mover_entity_id: '',
        origin_location_id: '',
        destination_location_id: '',
        segments_json: [],
        segment_index: 0,
        segment_distance_done_m: null,
        segment_time_done_s: 0,
        last_reached_location_id: null,
        stop_location_id: null,
        started_at_s: 0,
        last_advanced_at_s: 0,
        estimated_arrival_min_s: null,
        estimated_arrival_max_s: null,
        arrived_at_s: null,
        position_quality: 'unlocated',
        status: 'moving',
        stop_reason: null,
      };
    case 'events':
      return {
        title: '',
        kind: 'other',
        summary: '',
        location_id: null,
        route_id: null,
        route_progress_m: null,
        subject_entity_id: null,
        participants_json: [],
        cause_action_id: null,
        parent_event_id: null,
        scheduled_start_s: null,
        trigger_json: null,
        occurred_at_s: null,
        ended_at_s: null,
        outcome: '',
        secrecy: 'restricted',
        status: 'scheduled',
      };
    case 'information':
      return {
        kind: 'observation',
        title: '',
        content: '',
        source_event_id: null,
        subject_entity_id: null,
        payload_json: null,
        origin_location_id: null,
        originator_entity_id: null,
        parent_information_id: null,
        truth_status: 'unknown',
        secrecy: 'restricted',
        topic_key: '',
        content_hash: '',
        created_at_s: 0,
        expires_at_s: null,
        supersedes_information_id: null,
        status: 'active',
      };
    case 'rumor_fronts':
      return {
        information_id: '',
        location_id: '',
        via_channel_id: null,
        source_front_id: null,
        source_action_id: null,
        first_available_at_s: 0,
        last_reinforced_at_s: 0,
        next_spread_check_s: null,
        expires_at_s: null,
        reach: 'local',
        audience_json: { access: 'public', tags: [] },
        status: 'active',
      };
    case 'knowledge':
      return {
        knower_character_id: null,
        knower_faction_id: null,
        is_pov: 0,
        information_id: '',
        source_entity_id: null,
        source_front_id: null,
        source_channel_id: null,
        first_received_at_s: 0,
        last_confirmed_at_s: null,
        belief: 'heard',
        attention: 'normal',
        reaction_note: '',
        status: 'active',
      };
    case 'channels':
      return {
        name: '',
        kind: 'other',
        owner_entity_id: '',
        source_entity_id: null,
        source_location_id: null,
        recipient_entity_id: null,
        recipient_location_id: null,
        scope_json: { location_refs: [], entity_refs: [], topics: [] },
        requirements_json: null,
        latency_json: { quality: 'unknown', basis_refs: [] },
        transport_mode_key: null,
        reliability: 'unknown',
        secrecy: 'restricted',
        basis_quality: 'inferred',
        valid_from_s: 0,
        valid_until_s: null,
        status: 'active',
      };
    case 'entity_keys':
      return { branch_id: '', id: '', kind: 'location' };
    case 'branches':
      return {
        parent_branch_id: null,
        fork_turn_id: null,
        head_turn_id: null,
        revision: 0,
        name: '',
        pov_character_id: null,
        root_map_id: null,
        clock_s: 0,
        clock_min_s: 0,
        clock_max_s: 0,
        calendar_label: null,
        simulation_cursor_s: 0,
        simulation_status: 'current',
        ruleset_version: '',
        status: 'active',
        created_wall_ms: 0,
      };
    case 'turns':
      return {
        branch_id: '',
        parent_turn_id: null,
        host_message_uid: null,
        host_variant_key: null,
        kind: 'narrative',
        input_hash: '',
        story_hash: null,
        base_revision: 0,
        committed_revision: null,
        clock_before_s: 0,
        elapsed_json: { quality: 'unknown', basis_refs: [] },
        clock_after_s: 0,
        rng_seed: '',
        ruleset_version: '',
        decisions_json: { operations: [], attention_decisions: [], outcome_decisions: [], random_draws: [] },
        receipt_json: null,
        attempts_json: [],
        status: 'pending',
        created_wall_ms: 0,
        prepared_wall_ms: null,
      };
    case 'turn_changes':
      return {
        turn_id: '',
        sequence: 1,
        attempt_id: '',
        group_id: '',
        operation_id: '',
        target_table: '',
        target_row_id: '',
        operation: 'update',
        before_json: null,
        after_json: null,
        basis_json: {},
        summary: '',
      };
    case 'mention_candidates':
      return {
        name: '',
        normalized_name: '',
        context_key: '',
        kind_hint: 'unknown',
        first_turn_id: '',
        last_turn_id: '',
        distinct_turn_count: 1,
        recent_turn_ids_json: [],
        context_summary: '',
        lorebook_source_keys_json: [],
        importance_hint: 'none',
        promoted_entity_id: null,
        status: 'watching',
      };
    case 'sync_outbox':
      return {
        branch_id: '',
        requested_by_turn_id: null,
        target: 'managed_lorebook',
        projection_scope: 'pov',
        target_revision: 0,
        idempotency_key: '',
        payload_hash: '',
        status: 'pending',
        attempt_count: 0,
        next_retry_wall_ms: null,
        last_error_code: null,
        last_error_message: null,
        created_wall_ms: 0,
        completed_wall_ms: null,
      };
    default:
      return {};
  }
}

const COMMON_TABLE_SET = new Set<string>([
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
]);

/**
 * A31 createRow：按字段表补默认；P 字段从 ctx 注入。
 * 完成定义：新人物只填 name + identity 可成功，位置保持 NULL。
 */
export function createRow(
  table: AtlasTableName,
  input: Record<string, unknown>,
  ctx: CreateRowContext,
): Record<string, unknown> {
  if (!isKnownTable(table)) throw new Error(`CODEC_UNKNOWN_TABLE: ${String(table)}`);
  const out: Record<string, unknown> = { ...defaultsFor(table), ...input };

  if (COMMON_TABLE_SET.has(table)) {
    out.branch_id = ctx.branchId;
    out.id = ctx.id;
    out.row_rev = 1;
    out.created_turn_id = ctx.turnId;
    out.updated_turn_id = ctx.turnId;
  }
  if (table === 'entity_keys') {
    out.branch_id = ctx.branchId;
    out.id = ctx.id;
  }
  if (table === 'mention_candidates') {
    out.branch_id = ctx.branchId;
    out.id = ctx.id;
  }
  if (table === 'branches') {
    out.id = ctx.id;
  }
  if (table === 'turns') {
    out.id = ctx.id;
    out.branch_id = ctx.branchId;
  }
  if (table === 'sync_outbox') {
    out.id = ctx.id;
    out.branch_id = ctx.branchId;
  }

  // 列表列即使被显式写成 null 也要回到 []（列表默认不是 NULL）。
  for (const key of LIST_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(out, key) && out[key] === null) {
      out[key] = listDefault(table, key);
    }
  }

  // 时间/墙钟字段由程序注入，不接受默认 0 冒充已发生过的时间。
  if (table === 'branches') out.created_wall_ms = ctx.nowWallMs;
  if (table === 'turns') out.created_wall_ms = ctx.nowWallMs;
  if (table === 'sync_outbox') out.created_wall_ms = ctx.nowWallMs;
  if (table === 'information' && (out.created_at_s === 0 || out.created_at_s === null)) out.created_at_s = ctx.clockS;
  if (table === 'rumor_fronts') {
    if (out.first_available_at_s === 0 || out.first_available_at_s === null) out.first_available_at_s = ctx.clockS;
    if (out.last_reinforced_at_s === 0 || out.last_reinforced_at_s === null) out.last_reinforced_at_s = ctx.clockS;
  }
  if (table === 'knowledge' && (out.first_received_at_s === 0 || out.first_received_at_s === null)) {
    out.first_received_at_s = ctx.clockS;
  }
  if (table === 'relations' && (out.valid_from_s === 0 || out.valid_from_s === null)) out.valid_from_s = ctx.clockS;
  if (table === 'channels' && (out.valid_from_s === 0 || out.valid_from_s === null)) out.valid_from_s = ctx.clockS;
  if (table === 'journeys') {
    if (out.started_at_s === 0 || out.started_at_s === null) out.started_at_s = ctx.clockS;
    if (out.last_advanced_at_s === 0 || out.last_advanced_at_s === null) out.last_advanced_at_s = ctx.clockS;
  }
  if (table === 'actions' && (out.evaluated_until_s === 0 || out.evaluated_until_s === null)) out.evaluated_until_s = ctx.clockS;
  if (table === 'turns') {
    out.ruleset_version = out.ruleset_version || ctx.rulesetVersion;
    out.clock_before_s = out.clock_before_s ?? ctx.clockS;
    out.clock_after_s = out.clock_after_s ?? ctx.clockS;
  }
  if (table === 'branches') out.ruleset_version = out.ruleset_version || ctx.rulesetVersion;

  return out;
}

/** 供测试断言：地点/人物必须有精确可测的默认值。 */
export function defaultsSnapshot(table: AtlasTableName): Record<string, unknown> {
  return { ...defaultsFor(table) };
}
