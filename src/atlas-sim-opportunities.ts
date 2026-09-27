/**
 * atlas-sim-opportunities.ts — F06：候选接触机会（§9.4 / §16.7 / §5.3）。
 *
 * 固定行为：
 * - 候选来源：同地风声 + 在场人物、路过节点的旅客、来源在范围内的渠道、显式可见。
 * - §16.7：普通公众接触要求人物在该地点**停留/活动至少 60 世界秒**，或正文明确听见/看见。
 *   因此「同一座城市里的所有人」不会自动成为候选——只凭 `characters.location_id` 这种粗粒度归属
 *   不算停留证据，必须有行动/行程记录或渠道/显式可见作为依据。
 * - 封闭房间（room 类地点且不是风声所在地）先排除；`audience_json.access=members` 的风声只对
 *   该势力成员开放（§5.3 接触人群不是已知者名单）。
 * - **机会不是已知**：本函数不写 knowledge、不改 thought，只产生「这里有一次可能接触」的候选，
 *   是否注意/相信由后续 AI 决策（§9.4 / §16.7）。
 * - 同一 `information_id + 接收者 + 地点 + 时间桶` 派生稳定 ID，重复检查不会重复投递。
 *
 * 纯程序层：不调用模型、不使用 `Math.random`/`Date.now()`；时间由调用方传入。
 */

import { queryBound } from './atlas-db-runtime.ts';
import { decodeRow } from './atlas-db-codec.ts';
import { resolveEffectivePosition } from './atlas-sim-position.ts';
import { evaluateCondition } from './atlas-sim-actions.ts';
import { nextNodeBoundary } from './atlas-sim-motion.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';

/**
 * §16.7 普通公众接触的默认停留阈值。
 * 说明：§16.2 要求默认值集中在 atlas-runtime-limits.ts；本任务不允许改动既有文件，先在本模块导出。
 */
export const PUBLIC_CONTACT_DWELL_S = 60;

/** 机会 ID 的时间桶宽度（与传播检查周期一致）。 */
export const OPPORTUNITY_BUCKET_S = 3600;

export type Opportunity = {
  id: string;
  kind: 'same_location' | 'route_passage' | 'channel' | 'rumor_front';
  receiverEntityId: string | null;
  informationId: string | null;
  locationId: string | null;
  atS: number;
  requiresDwellS: number;
  basis: Record<string, unknown>;
};

export type OpportunityWorld = { db: SqlDatabase; branchId: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (isPlainObject(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function decodeOrNull(table: string, row: Record<string, unknown>): Record<string, unknown> | null {
  const decoded = decodeRow(table as never, row, { allowExtra: true });
  return decoded.ok ? (decoded.row as Record<string, unknown>) : null;
}

function loadRows(world: OpportunityWorld, table: string, where: string, params: Array<string | number | null>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const row of queryBound(world.db, `SELECT * FROM ${table} WHERE branch_id = ? AND ${where}`, [world.branchId, ...params])) {
    const decoded = decodeOrNull(table, row);
    if (decoded) out.push(decoded);
  }
  return out;
}

/** 稳定 ID：information/channel + 接收者 + 地点 + 时间桶（重复检查不重复投递）。 */
function opportunityId(parts: {
  kind: string;
  subjectId: string | null;
  receiverEntityId: string | null;
  locationId: string | null;
  anchorS: number;
}): string {
  const bucket = Math.floor(Math.max(0, parts.anchorS) / OPPORTUNITY_BUCKET_S);
  const material = [parts.kind, parts.subjectId ?? '-', parts.receiverEntityId ?? '-', parts.locationId ?? '-', `b${bucket}`].join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i += 1) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `opp_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * F06：收集窗口内的候选接触机会。
 * 结果按 `(atS, id)` 排序，保证同一状态重复调用得到同一序列。
 */
export function collectOpportunities(window: { fromS: number; untilS: number }, world: OpportunityWorld): Opportunity[] {
  const fromS = num(window?.fromS) ?? 0;
  const untilS = num(window?.untilS) ?? fromS;
  const opportunities: Opportunity[] = [];

  const branchRows = queryBound(world.db, 'SELECT pov_character_id FROM branches WHERE id = ? LIMIT 1', [world.branchId]);
  const povCharacterId = branchRows.length > 0 ? str(branchRows[0].pov_character_id) : null;

  // —— 已知去重：同一信息同一接收者不重复触发（§9.2 / §9.4）。
  const knowers = new Set<string>();
  for (const row of loadRows(world, 'knowledge', "status <> 'forgotten'", [])) {
    const informationId = str(row.information_id);
    if (!informationId) continue;
    const knower = str(row.knower_character_id) ?? (row.is_pov === true || row.is_pov === 1 ? povCharacterId : null);
    if (knower) knowers.add(`${informationId}:${knower}`);
  }
  const alreadyKnows = (informationId: string | null, actorId: string | null): boolean =>
    informationId !== null && actorId !== null && knowers.has(`${informationId}:${actorId}`);

  // —— 停留证据：只认行动与行程记录，不把粗粒度 location_id 当成 60 秒停留（§16.7）。
  const dwell = new Map<string, number>();
  const addDwell = (actorId: string, locationId: string, seconds: number): void => {
    if (seconds <= 0) return;
    const key = `${actorId}|${locationId}`;
    dwell.set(key, (dwell.get(key) ?? 0) + seconds);
  };
  for (const row of loadRows(world, 'actions', "target_location_id IS NOT NULL AND status IN ('ready','active','paused','blocked','completed')", [])) {
    const actorId = str(row.actor_entity_id);
    const locationId = str(row.target_location_id);
    if (!actorId || !locationId) continue;
    const start = Math.max(fromS, num(row.started_at_s) ?? fromS);
    const end = Math.min(untilS, num(row.finished_at_s) ?? untilS);
    addDwell(actorId, locationId, end - start);
  }
  for (const row of loadRows(world, 'journeys', "status IN ('moving','paused','arrived','blocked')", [])) {
    const actorId = str(row.mover_entity_id);
    if (!actorId) continue;
    const stop = str(row.stop_location_id);
    const status = String(row.status ?? '');
    if (stop && (status === 'paused' || status === 'blocked')) {
      const start = Math.max(fromS, num(row.last_advanced_at_s) ?? fromS);
      addDwell(actorId, stop, Math.min(untilS, num(row.arrived_at_s) ?? untilS) - start);
    }
    if (status === 'arrived') {
      const destination = str(row.destination_location_id);
      if (destination) {
        const start = Math.max(fromS, num(row.arrived_at_s) ?? fromS);
        addDwell(actorId, destination, untilS - start);
      }
    }
  }
  const dwellAt = (actorId: string, locationId: string): number => dwell.get(`${actorId}|${locationId}`) ?? 0;

  const characters = loadRows(world, 'characters', "status = 'active'", []);
  const characterById = new Map<string, Record<string, unknown>>();
  for (const character of characters) characterById.set(String(character.id), character);

  const locationCache = new Map<string, Record<string, unknown> | null>();
  const locationOf = (locationId: string): Record<string, unknown> | null => {
    if (!locationCache.has(locationId)) {
      const rows = queryBound(world.db, 'SELECT * FROM locations WHERE branch_id = ? AND id = ? LIMIT 1', [world.branchId, locationId]);
      locationCache.set(locationId, rows.length > 0 ? decodeOrNull('locations', rows[0]) : null);
    }
    return locationCache.get(locationId) ?? null;
  };

  const locationChain = (locationId: string): string[] => {
    const chain: string[] = [];
    let cursor: string | null = locationId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      chain.push(cursor);
      const row = locationOf(cursor);
      cursor = row ? str(row.parent_location_id) : null;
    }
    return chain;
  };
  const isAncestorOrSelf = (candidate: string, locationId: string): boolean => locationChain(locationId).includes(candidate);

  const factionMembers = new Map<string, Set<string>>();
  const membersOf = (factionId: string): Set<string> => {
    if (!factionMembers.has(factionId)) {
      const members = new Set<string>();
      for (const row of loadRows(world, 'relations', "status = 'active' AND object_entity_id = ?", [factionId])) {
        const subject = str(row.subject_entity_id);
        if (subject) members.add(subject);
      }
      factionMembers.set(factionId, members);
    }
    return factionMembers.get(factionId) as Set<string>;
  };

  // —— 显式可见：渠道来源在这一地点/实体上，属于「明确看见/听见」而不是普通公众接触。
  const explicitVisible = new Set<string>();
  const channels = loadRows(world, 'channels', "status = 'active' AND valid_from_s <= ? AND (valid_until_s IS NULL OR valid_until_s >= ?)", [untilS, fromS]);
  for (const channel of channels) {
    const channelId = String(channel.id);
    const requirements = asObject(channel.requirements_json);
    const sourceEntity = str(channel.source_entity_id);
    const sourceLocation = str(channel.source_location_id);
    const scope = asObject(channel.scope_json) ?? {};
    const scopeLocations = asArray(scope.location_refs).filter((v): v is string => typeof v === 'string');
    const scopeEntities = asArray(scope.entity_refs).filter((v): v is string => typeof v === 'string');
    if (sourceEntity === null && sourceLocation === null && scopeEntities.length === 0 && scopeLocations.length === 0) continue;
    const recipient = str(channel.recipient_entity_id) ?? str(channel.owner_entity_id);
    if (requirements && !evaluateCondition(world, requirements, { clockS: untilS, actorId: recipient }).ok) continue;
    const place = sourceLocation ?? scopeLocations[0] ?? null;
    if (recipient && sourceEntity) explicitVisible.add(`${recipient}|${sourceEntity}`);
    if (recipient && place) explicitVisible.add(`${recipient}|${place}`);

    if (recipient && (sourceEntity || place)) {
      const atS = Math.max(fromS, num(channel.valid_from_s) ?? fromS);
      opportunities.push({
        id: opportunityId({ kind: 'channel', subjectId: channelId, receiverEntityId: recipient, locationId: place, anchorS: atS }),
        kind: 'channel',
        receiverEntityId: recipient,
        informationId: null,
        locationId: place,
        atS,
        requiresDwellS: 0,
        basis: {
          channelId,
          channelKind: String(channel.kind ?? 'other'),
          sourceEntityId: sourceEntity,
          sourceLocationId: sourceLocation,
          scopeEntityRefs: scopeEntities,
          scopeLocationRefs: scopeLocations,
          transportModeKey: str(channel.transport_mode_key),
          reason: 'channel_source_in_scope',
        },
      });
    }
    for (const entityId of scopeEntities) {
      if (recipient && recipient !== entityId) explicitVisible.add(`${recipient}|${entityId}`);
      const atS = Math.max(fromS, num(channel.valid_from_s) ?? fromS);
      opportunities.push({
        id: opportunityId({ kind: 'channel', subjectId: `${channelId}:${entityId}`, receiverEntityId: recipient, locationId: place, anchorS: atS }),
        kind: 'channel',
        receiverEntityId: recipient,
        informationId: null,
        locationId: place,
        atS,
        requiresDwellS: 0,
        basis: { channelId, channelKind: String(channel.kind ?? 'other'), watchedEntityId: entityId, reason: 'channel_scope' },
      });
    }
  }

  // —— 风声：同地接触 + 路过节点。
  const fronts = loadRows(
    world,
    'rumor_fronts',
    "status IN ('active','fading') AND first_available_at_s <= ? AND (expires_at_s IS NULL OR expires_at_s >= ?)",
    [untilS, fromS],
  );
  const knownFront = new Set<string>();
  for (const front of fronts) {
    const frontId = String(front.id);
    const informationId = str(front.information_id);
    const locationId = str(front.location_id);
    if (!informationId || !locationId || knownFront.has(`${informationId}|${locationId}`)) continue;
    knownFront.add(`${informationId}|${locationId}`);
    const firstAvailableAtS = num(front.first_available_at_s) ?? fromS;
    const audience = asObject(front.audience_json) ?? {};
    const access = String(audience.access ?? 'public');
    const audienceFaction = str(audience.faction_id);
    const reach = String(front.reach ?? 'local');

    if (firstAvailableAtS >= fromS && firstAvailableAtS <= untilS) {
      opportunities.push({
        id: opportunityId({ kind: 'rumor_front', subjectId: informationId, receiverEntityId: null, locationId, anchorS: firstAvailableAtS }),
        kind: 'rumor_front',
        receiverEntityId: null,
        informationId,
        locationId,
        atS: firstAvailableAtS,
        requiresDwellS: PUBLIC_CONTACT_DWELL_S,
        basis: { frontId, reach, access, firstAvailableAtS, reason: 'front_now_available' },
      });
    }

    for (const character of characters) {
      const actorId = String(character.id);
      if (alreadyKnows(informationId, actorId)) continue;
      if (actorId === str(front.originator_entity_id)) continue; // 造谣/目击者本来就知道，不需要再听一次
      if (access === 'members' && audienceFaction && !membersOf(audienceFaction).has(actorId)) continue;

      const position = resolveEffectivePosition({ db: world.db, branchId: world.branchId }, actorId);
      const presenceLocation =
        position.kind === 'at_location'
          ? position.locationId
          : position.kind === 'in_transit'
            ? null
            : str(character.location_id);
      // 封闭房间先排除：人在别的 room 里，且不是该风声地点。
      if (presenceLocation && presenceLocation !== locationId) {
        const presenceRow = locationOf(presenceLocation);
        const isRoom = presenceRow ? String(presenceRow.kind ?? '') === 'room' : false;
        const insideFront = isAncestorOrSelf(locationId, presenceLocation);
        if (isRoom || !insideFront) continue;
      }
      const originator = str(front.originator_entity_id);
      const explicit = explicitVisible.has(`${actorId}|${locationId}`) || (originator !== null && explicitVisible.has(`${actorId}|${originator}`));
      const standing = dwellAt(actorId, locationId);
      const here = presenceLocation === locationId;
      const basisDwell = here ? standing : 0;
      if (basisDwell < PUBLIC_CONTACT_DWELL_S && !explicit) continue; // 同城不等于候选（§16.7）
      const atS = Math.max(firstAvailableAtS, fromS);
      opportunities.push({
        id: opportunityId({ kind: 'same_location', subjectId: informationId, receiverEntityId: actorId, locationId, anchorS: firstAvailableAtS }),
        kind: 'same_location',
        receiverEntityId: actorId,
        informationId,
        locationId,
        atS,
        requiresDwellS: PUBLIC_CONTACT_DWELL_S,
        basis: {
          frontId,
          reach,
          access,
          dwellS: basisDwell,
          presenceLocation,
          explicitVisibility: explicit,
          reason: explicit && basisDwell < PUBLIC_CONTACT_DWELL_S ? 'explicit_hear_or_see' : 'stayed_at_location',
        },
      });
    }

    // 经过节点：明确听见/遭遇可在途触发（§16.7），不强迫所有旅客每个村庄停车。
    for (const journey of loadRows(world, 'journeys', "status = 'moving'", [])) {
      const mover = str(journey.mover_entity_id);
      if (!mover || !characterById.has(mover) || alreadyKnows(informationId, mover)) continue;
      const boundary = nextNodeBoundary(journey);
      if (!boundary || boundary.toLocationId !== locationId) continue;
      if (boundary.atS < Math.max(fromS, firstAvailableAtS) || boundary.atS > untilS) continue;
      opportunities.push({
        id: opportunityId({ kind: 'route_passage', subjectId: informationId, receiverEntityId: mover, locationId, anchorS: boundary.atS }),
        kind: 'route_passage',
        receiverEntityId: mover,
        informationId,
        locationId,
        atS: boundary.atS,
        requiresDwellS: 0,
        basis: { frontId, journeyId: String(journey.id), routeId: boundary.routeId, nodeAtS: boundary.atS, reach, reason: 'passing_node_in_transit' },
      });
    }
  }

  opportunities.sort((a, b) => (a.atS !== b.atS ? a.atS - b.atS : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return opportunities;
}
