/**
 * atlas-sim-propagation.ts — F09/F10：风声传播调度与实际到达（§9.4 / §16.7 / §5.3）。
 *
 * §16.7 初版固定规则：
 * - **公开**风声每 3600 世界秒检查一次可通行的外出连接；真实到达耗时按选用的携带方式/路线算。
 * - 私密信息不自动进入地理扩散：只有明确渠道（信使/联络，带来源地与收件地）才可能传递。
 * - 按 `(information, 目的地)` 去重：已有 front 的地点不再重复投递（`idx_rumor_fronts_unique` 兜底）。
 * - 传播任务使用稳定 ID（`prop_*` / `propchk_*`），重复检查不会重复投递。
 * - **不为每一对相邻地点建立 channel**（§5.5）：地理扩散只用 routes，本文件不写 channels 行。
 * - `deliverDueInformation` 只在消息**实际到达**时建立 `rumor_fronts`（`first_available_at_s = 到达时刻`），
 *   绝不提前建 front；机会由 `collectOpportunities` 产生，**不是**直接写 knowledge。
 *
 * 纯程序层：不调用模型、不使用 `Math.random`/`Date.now()`；时间由调用方传入。
 */

import { queryBound, runBound } from './atlas-db-runtime.ts';
import { decodeRow } from './atlas-db-codec.ts';
import { tableColumnNames } from './atlas-db-schema.ts';
import { MOVEMENT_SPEED_PRESETS, TERRAIN_MULTIPLIERS } from './atlas-sim-motion.ts';
import { collectOpportunities } from './atlas-sim-opportunities.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { Issue } from './atlas-ops-contract.ts';
import type { SqlValue } from './atlas-db-contract.ts';
import type { Opportunity } from './atlas-sim-opportunities.ts';

/**
 * §16.7 公开风声的传播检查周期（世界秒）。
 * 说明：§16.2 要求默认值集中在 atlas-runtime-limits.ts；本任务不允许改动既有文件，先在本模块导出。
 */
export const PROPAGATION_CHECK_INTERVAL_S = 3600;

/** 携带方式优先顺序：普通旅人 → 骑乘 → 车 → 船 → 飞行。 */
const CARRIER_PREFERENCE = ['walk', 'ride', 'ground_vehicle', 'water', 'flight', 'flight_narrative_aircraft'];

const TERRAIN_TABLE: Readonly<Record<string, number>> = TERRAIN_MULTIPLIERS;

export type PropagationWorld = {
  db: SqlDatabase;
  branchId: string;
  clockS: number;
  makeId: (kind: string, opId: string, alias: string) => string;
  turnId: string;
};

export type DeliverWorld = {
  db: SqlDatabase;
  branchId: string;
  clockS: number;
  makeId: (...args: never[]) => string;
  turnId: string;
};

function issue(code: string, path: string, message: string, severity: 'warning' | 'error' = 'warning'): Issue {
  return { code, path, message, severity, retryable: false };
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

function hashId(prefix: string, material: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i += 1) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function openRoutesFrom(world: { db: SqlDatabase; branchId: string }, locationId: string): Array<Record<string, unknown>> {
  const rows = queryBound(
    world.db,
    `SELECT * FROM routes WHERE branch_id = ? AND status = 'open' AND (from_location_id = ? OR (bidirectional = 1 AND to_location_id = ?))`,
    [world.branchId, locationId, locationId],
  );
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const decoded = decodeOrNull('routes', row);
    if (decoded) out.push(decoded);
  }
  return out;
}

function otherEnd(route: Record<string, unknown>, locationId: string): string | null {
  const from = str(route.from_location_id);
  const to = str(route.to_location_id);
  if (from === locationId) return to;
  if (to === locationId && (route.bidirectional === true || route.bidirectional === 1)) return from;
  if (to === locationId) return from;
  return null;
}

/**
 * 特殊通信的延迟（§2.4 TimeEstimate / §16.7）：
 * 取名义值用于一致运行，缺名义值时用 min（更保守）。
 *
 * `quality` 描述的是「数字怎么来的」，不是「有没有数字」：因此**只要给出了可用的
 * min/nominal 数值就采用**（并按 estimated 对待），只有三个数都为空时才返回 null——
 * 此时未知就是未知，调用方必须放弃投递，**绝不因未知当作 0 立即送达**。
 */
function latencySeconds(raw: unknown): number | null {
  const parsed = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!parsed || typeof parsed !== 'object') return null;
  const estimate = parsed as Record<string, unknown>;
  const nominal = num(estimate.nominal_s);
  if (nominal !== null && nominal >= 0) return nominal;
  const min = num(estimate.min_s);
  if (min !== null && min >= 0) return min;
  return null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pickCarrier(route: Record<string, unknown>, channel: Record<string, unknown> | null): string {
  const channelMode = channel ? str(channel.transport_mode_key) : null;
  if (channelMode && MOVEMENT_SPEED_PRESETS[channelMode] !== undefined) return channelMode;
  const allowed = asArray(route.allowed_modes_json).filter((m): m is string => typeof m === 'string');
  const pool = allowed.length > 0 ? allowed : ['walk'];
  for (const mode of CARRIER_PREFERENCE) if (pool.includes(mode)) return mode;
  return pool[0] as string;
}

function carrierSpeed(route: Record<string, unknown>, mode: string): number | null {
  const preset = MOVEMENT_SPEED_PRESETS[mode] ?? null;
  if (!preset) return null;
  const terrain = String(route.terrain ?? 'unknown').trim().toLowerCase();
  const factor = mode === 'flight' || mode === 'flight_narrative_aircraft' ? 1 : TERRAIN_TABLE[terrain] ?? 1;
  const speed = preset.nominal_mps * factor;
  return speed > 0 ? speed : null;
}

function routeDistanceM(route: Record<string, unknown>): { value: number | null; quality: string } {
  const nominal = num(route.distance_m);
  if (nominal !== null) return { value: nominal, quality: String(route.distance_basis ?? 'unknown') === 'unknown' ? 'estimated' : 'confirmed' };
  const min = num(route.distance_min_m);
  const max = num(route.distance_max_m);
  if (min !== null && max !== null) return { value: (min + max) / 2, quality: 'estimated' };
  if (min !== null) return { value: min, quality: 'estimated' };
  if (max !== null) return { value: max, quality: 'estimated' };
  return { value: null, quality: 'unknown' };
}

function findRoute(world: { db: SqlDatabase; branchId: string }, fromId: string, toId: string): Record<string, unknown> | null {
  if (fromId === toId) return null;
  for (const route of openRoutesFrom(world, fromId)) {
    if (otherEnd(route, fromId) === toId) return route;
  }
  return null;
}

function frontIndex(world: { db: SqlDatabase; branchId: string }): Set<string> {
  const out = new Set<string>();
  for (const row of queryBound(world.db, 'SELECT information_id, location_id FROM rumor_fronts WHERE branch_id = ?', [world.branchId])) {
    out.add(`${String(row.information_id)}|${String(row.location_id)}`);
  }
  return out;
}

function informationOf(world: { db: SqlDatabase; branchId: string }, informationId: string): Record<string, unknown> | null {
  const rows = queryBound(world.db, 'SELECT * FROM information WHERE branch_id = ? AND id = ? LIMIT 1', [world.branchId, informationId]);
  return rows.length > 0 ? decodeOrNull('information', rows[0]) : null;
}

/**
 * F09：按 §16.7 周期与真实路径生成传播任务。
 * 只读、只返回任务（`spread_check` / `delivery`），不写库、不建 channel：
 * 调用方（调度层）把任务放进队列，到期后由 `deliverDueInformation` 落实 front。
 */
export function scheduleDeliveries(
  fronts: Array<Record<string, unknown>>,
  channels: Array<Record<string, unknown>>,
  world: PropagationWorld,
): { tasks: Array<Record<string, unknown>>; issues: Issue[] } {
  const tasks: Array<Record<string, unknown>> = [];
  const issues: Issue[] = [];
  const clockS = num(world.clockS) ?? 0;
  const existing = frontIndex(world);
  const scheduled = new Set<string>();

  for (const front of fronts ?? []) {
    const frontId = str(front?.id);
    const informationId = str(front?.information_id);
    const locationId = str(front?.location_id);
    if (!frontId || !informationId || !locationId) continue;
    if (String(front.status ?? 'active') !== 'active') continue;
    const nextCheck = num(front.next_spread_check_s);
    if (nextCheck !== null && nextCheck > clockS) continue; // 未到检查时刻

    const information = informationOf(world, informationId);
    if (!information) {
      issues.push(issue('PROPAGATION_INFORMATION_UNKNOWN', 'information', `风声 ${frontId} 引用的信息不存在，不能传播`));
      continue;
    }
    const secrecy = String(information.secrecy ?? 'restricted');
    const isPublic = secrecy === 'public';
    // 出发时刻取「front 可用后的第一次检查」：传播按 3600 秒周期发车，重复检查得到同一到达时刻，
    // 因此重复调用不会重复投递，也不会因为后一次检查把已经上路的信使再发一遍（§16.7 / §9.4 去重）。
    const firstAvailable = num(front.first_available_at_s) ?? clockS;
    const firstCheck = firstAvailable + PROPAGATION_CHECK_INTERVAL_S;
    const departAt = Math.max(firstCheck, 0);

    tasks.push({
      id: hashId('propchk', `${frontId}|${clockS}`),
      task_kind: 'spread_check',
      front_id: frontId,
      information_id: informationId,
      from_location_id: locationId,
      check_at_s: clockS,
      next_check_s: clockS + PROPAGATION_CHECK_INTERVAL_S,
      due_at_s: clockS + PROPAGATION_CHECK_INTERVAL_S,
      dedupe_key: `${informationId}|check|${clockS}`,
    });

    if (!isPublic) {
      // 私密信息不自动进入地理扩散（§16.7）：只有明确渠道才可能送达。
      for (const channel of channels ?? []) {
        const channelId = str(channel?.id);
        const sourceLocation = str(channel?.source_location_id);
        const recipientLocation = str(channel?.recipient_location_id);
        const mode = str(channel?.transport_mode_key);
        if (!channelId || !sourceLocation || !recipientLocation) continue;
        if (String(channel?.status ?? 'active') !== 'active') continue;
        if (sourceLocation !== locationId) continue;
        if (existing.has(`${informationId}|${recipientLocation}`)) continue;
        const channelDepart = Math.max(departAt, num(channel.valid_from_s) ?? 0);

        /**
         * 两选一，绝不叠加（§16.7 / §9.4）：
         * - 有 transport_mode_key：信使/载具沿地理路线走，用时 = 距离 / 载具速度；
         * - 无 transport_mode_key：特殊通信（magic/broadcast 等）用 latency_json，
         *   延迟可为 0（立即到达），此时**没有**地理路程，因此不存在「两遍相同距离」。
         */
        if (!mode) {
          const latency = latencySeconds(channel?.latency_json);
          if (latency === null) {
            issues.push(
              issue('PROPAGATION_LATENCY_UNKNOWN', 'channels', `渠道 ${channelId} 既没有信使方式也没有可用延迟依据，到达时间未知（不提前投递）`),
            );
            continue;
          }
          tasks.push({
            id: hashId('prop', `${informationId}|${locationId}|${recipientLocation}|${channelId}`),
            task_kind: 'delivery',
            front_id: frontId,
            information_id: informationId,
            via_channel_id: channelId,
            from_location_id: sourceLocation,
            to_location_id: recipientLocation,
            route_id: null,
            mobility_key: null,
            transport: 'latency',
            depart_at_s: channelDepart,
            arrive_at_s: channelDepart + latency,
            flight_time_s: latency,
            due_at_s: channelDepart + latency,
            dedupe_key: `${informationId}|${recipientLocation}|${channelId}`,
          });
          continue;
        }

        const route = findRoute(world, sourceLocation, recipientLocation);
        if (!route) continue;
        const speed = carrierSpeed(route, mode);
        const distance = routeDistanceM(route);
        if (speed === null || distance.value === null) {
          issues.push(issue('PROPAGATION_ETA_UNKNOWN', 'routes', `渠道 ${channelId} 的路径缺少速度/距离依据，到达时间未知（不提前投递）`));
          continue;
        }
        const arriveAt = channelDepart + distance.value / speed;
        tasks.push({
          id: hashId('prop', `${informationId}|${locationId}|${recipientLocation}|${channelId}`),
          task_kind: 'delivery',
          front_id: frontId,
          information_id: informationId,
          via_channel_id: channelId,
          from_location_id: sourceLocation,
          to_location_id: recipientLocation,
          route_id: str(route.id),
          mobility_key: mode,
          speed_mps: speed,
          distance_m: distance.value,
          depart_at_s: channelDepart,
          arrive_at_s: arriveAt,
          due_at_s: arriveAt,
          quality: distance.quality,
          secrecy,
          dedupe_key: `${informationId}|${recipientLocation}`,
        });
      }
      continue;
    }

    for (const route of openRoutesFrom(world, locationId)) {
      const destination = otherEnd(route, locationId);
      if (!destination) continue;
      if (existing.has(`${informationId}|${destination}`) || scheduled.has(`${informationId}|${destination}`)) continue; // 去重
      const mode = pickCarrier(route, null);
      const speed = carrierSpeed(route, mode);
      const distance = routeDistanceM(route);
      if (speed === null || distance.value === null) {
        issues.push(
          issue('PROPAGATION_ETA_UNKNOWN', 'routes', `到 ${destination} 的路段缺少速度/距离依据：保留未知，不提前到达也不假装立刻送达`),
        );
        continue;
      }
      const departAtPublic = departAt;
      const arriveAt = departAtPublic + distance.value / speed;
      scheduled.add(`${informationId}|${destination}`);
      tasks.push({
        id: hashId('prop', `${informationId}|${locationId}|${destination}`),
        task_kind: 'delivery',
        front_id: frontId,
        information_id: informationId,
        via_channel_id: null,
        from_location_id: locationId,
        to_location_id: destination,
        route_id: str(route.id),
        mobility_key: mode,
        speed_mps: speed,
        distance_m: distance.value,
        depart_at_s: departAtPublic,
        arrive_at_s: arriveAt,
        due_at_s: arriveAt,
        quality: distance.quality,
        secrecy,
        dedupe_key: `${informationId}|${destination}`,
      });
    }
  }

  return { tasks, issues };
}

function insertFront(world: DeliverWorld, row: Record<string, unknown>): void {
  const columns = tableColumnNames('rumor_fronts').filter((column) => Object.prototype.hasOwnProperty.call(row, column));
  const values: SqlValue[] = columns.map((column) => {
    const value = row[column];
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'object') return JSON.stringify(value);
    if (typeof value === 'string' || typeof value === 'number') return value;
    throw new Error(`rumor_fronts.${column} 不可绑定的值类型：${typeof value}`);
  });
  runBound(
    world.db,
    `INSERT INTO rumor_fronts (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ON CONFLICT DO NOTHING`,
    values,
  );
}

/**
 * F10：把**实际到期**的传播任务落实为 `rumor_fronts`。
 * 到达时刻之前绝不建立 front；同时推进来源 front 的下次检查时刻。
 * 返回的 `opportunities` 只是候选接触机会（不是知识）——是否注意/相信由后续 AI 决策。
 */
export function deliverDueInformation(
  untilS: number,
  world: DeliverWorld,
): { frontsCreated: number; opportunities: Opportunity[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const makeId = world.makeId as unknown as (kind: string, opId: string, alias: string) => string;
  let frontsCreated = 0;
  let earliestArrival: number | null = null;

  const dueFronts: Array<Record<string, unknown>> = [];
  for (const raw of queryBound(
    world.db,
    `SELECT * FROM rumor_fronts WHERE branch_id = ? AND status = 'active' AND (next_spread_check_s IS NULL OR next_spread_check_s <= ?)`,
    [world.branchId, untilS],
  )) {
    const decoded = decodeOrNull('rumor_fronts', raw);
    if (decoded) dueFronts.push(decoded);
  }

  const channels: Array<Record<string, unknown>> = [];
  for (const raw of queryBound(world.db, `SELECT * FROM channels WHERE branch_id = ? AND status = 'active'`, [world.branchId])) {
    const decoded = decodeOrNull('channels', raw);
    if (decoded) channels.push(decoded);
  }

  const seen = new Set<string>();
  for (const front of dueFronts) {
    const frontId = String(front.id);
    const base = num(front.next_spread_check_s) ?? (num(front.first_available_at_s) ?? 0) + PROPAGATION_CHECK_INTERVAL_S;
    const checkAt = Math.min(untilS, base);
    const scheduled = scheduleDeliveries([{ ...front, next_spread_check_s: front.next_spread_check_s ?? checkAt }], channels, {
      db: world.db,
      branchId: world.branchId,
      clockS: checkAt,
      makeId,
      turnId: world.turnId,
    });
    issues.push(...scheduled.issues);

    for (const task of scheduled.tasks) {
      if (String(task.task_kind) !== 'delivery') continue;
      const arriveAt = num(task.arrive_at_s);
      const destination = str(task.to_location_id);
      const informationId = str(task.information_id);
      if (arriveAt === null || !destination || !informationId) continue;
      const dedupeKey = `${informationId}|${destination}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      if (arriveAt > untilS) continue; // 还没到，绝不提前建立 front
      const viaChannel = str(task.via_channel_id);
      insertFront(world, {
        branch_id: world.branchId,
        id: makeId('rumor_front', informationId, destination),
        row_rev: 1,
        created_turn_id: world.turnId,
        updated_turn_id: world.turnId,
        information_id: informationId,
        location_id: destination,
        via_channel_id: viaChannel,
        source_front_id: frontId,
        source_action_id: null,
        first_available_at_s: arriveAt,
        last_reinforced_at_s: arriveAt,
        next_spread_check_s: arriveAt + PROPAGATION_CHECK_INTERVAL_S,
        expires_at_s: null,
        reach: 'local',
        audience_json: JSON.stringify({ access: 'public', tags: [] }),
        status: 'active',
      });
      frontsCreated += 1;
      earliestArrival = earliestArrival === null ? arriveAt : Math.min(earliestArrival, arriveAt);
    }

    // 推进来源 front 的下次检查周期（重复检查不会重复投递）。
    runBound(
      world.db,
      'UPDATE rumor_fronts SET next_spread_check_s = ?, row_rev = row_rev + 1 WHERE branch_id = ? AND id = ?',
      [checkAt + PROPAGATION_CHECK_INTERVAL_S, world.branchId, frontId],
    );
  }

  const windowFrom = earliestArrival ?? untilS;
  const opportunities = frontsCreated > 0 ? collectOpportunities({ fromS: windowFrom, untilS }, { db: world.db, branchId: world.branchId }) : [];
  return { frontsCreated, opportunities, issues };
}
