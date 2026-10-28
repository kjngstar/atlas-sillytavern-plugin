/**
 * atlas-sim-decision-context.ts — F13：每个角色的决策切片（§9.1 / §10.4 / §5.4 / §16.6）。
 *
 * 固定行为（T13/F13 完成定义）：
 * - 每个 actor 只拿到**自己**的 knowledge 行（按 knower 过滤；未绑定主角人物时才是 `is_pov` 行）；
 *   自己的计划/行动与未结束行程；以及**发给自己的**机会。
 * - 绝不把作者视角的秘密、别的角色的隐藏想法作为该角色的已知输入：本函数不返回 `characters.thought`，
 *   也不返回其它主体的 knowledge / information 正文。
 * - 机会不是已知：`opportunities` 只包含 `receiverEntityId === actor` 的条目；地点级的
 *   `receiverEntityId=null` 机会不塞给任何个人。
 *
 * 纯查询层：不调用模型、不写库、不使用 `Date.now()`。
 */

import { queryBound } from './atlas-db-runtime.ts';
import { decodeRow } from './atlas-db-codec.ts';
import { resolveEffectivePosition } from './atlas-sim-position.ts';
import { readActorSceneFacts, summarizeSceneFacts } from './atlas-scene-facts.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { Opportunity } from './atlas-sim-opportunities.ts';
import type { DecisionSceneV1 } from './atlas-scene-facts.ts';

export type DecisionActorSlice = {
  entityId: string;
  knowledge: Array<Record<string, unknown>>;
  activeActions: Array<Record<string, unknown>>;
  journeys: Array<Record<string, unknown>>;
  opportunities: Opportunity[];
  /** Only the contents this actor knows or can presently encounter; truth labels stay author-only. */
  information: Array<Record<string, unknown>>;
  /**
   * §17.2：该 actor **自己**的现场空间事实（地点链 / 入口开关 / 关键障碍占地 / 空间约束）。
   *
   * 来自与正文注入同一个读取口（`atlas-scene-facts.ts`），因此不会出现
   * 「正文说门锁着、决策以为门开着」的两套事实。位置未知时是 null，不拿目录名字填空。
   * 只读自己的位置：别人的位置、玩家地图缓存、author DTO 都不进这里。
   */
  scene: DecisionSceneV1 | null;
};

export type DecisionContext = { actorSlices: DecisionActorSlice[]; refs: string[] };

export type DecisionWorld = { db: SqlDatabase; branchId: string };

function decodeRows(table: string, rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const decoded = decodeRow(table as never, row, { allowExtra: true });
    if (decoded.ok) out.push(decoded.row as Record<string, unknown>);
  }
  return out;
}

/**
 * §17.2：这个 actor 自己能看到的现场空间。
 *
 * 位置只从 `resolveEffectivePosition` 来：在途就是「在途」，未知就是 null。
 * 地点行的 `location_id` 只在**有效坐标**（at_grid）时作为房间归属使用 ——
 * 因为网格坐标本身不带房间，而 at_location 已经直接给了地点。
 */
function actorScene(world: DecisionWorld, entityId: string): DecisionSceneV1 | null {
  const position = resolveEffectivePosition({ db: world.db, branchId: world.branchId }, entityId);
  const character = queryBound(world.db, 'SELECT location_id FROM characters WHERE branch_id=? AND id=? LIMIT 1', [world.branchId, entityId])[0];
  const locationId = position.kind === 'at_location'
    ? position.locationId
    : position.kind === 'at_grid' && character?.location_id
      ? String(character.location_id)
      : null;
  const facts = readActorSceneFacts(world, { actorId: entityId, locationId, position });
  return summarizeSceneFacts(facts.context);
}

/**
 * F13：每角色认知切片 + 相关计划 + 真实机会。
 * `refs` 是切片引用的短引用键（`kind:id`），供提示词层生成短引用。
 */
export function buildDecisionContext(
  batch: { actors: Array<{ entityId: string }>; opportunities: Opportunity[] },
  world: DecisionWorld,
): DecisionContext {
  const branchRows = queryBound(world.db, 'SELECT pov_character_id FROM branches WHERE id = ? LIMIT 1', [world.branchId]);
  const povCharacterId = branchRows.length > 0 && typeof branchRows[0].pov_character_id === 'string' ? String(branchRows[0].pov_character_id) : null;

  const actorSlices: DecisionActorSlice[] = [];
  const refs = new Set<string>();
  const seenActors = new Set<string>();

  for (const actor of batch?.actors ?? []) {
    const entityId = typeof actor?.entityId === 'string' ? actor.entityId : '';
    if (entityId === '' || seenActors.has(entityId)) continue;
    seenActors.add(entityId);

    // 只按 knower 取自己的认知；主角未绑定人物时才回落到 is_pov 行（§5.4）。
    const knowledgeWhere =
      povCharacterId === entityId
        ? "status IN ('active','outdated') AND (knower_character_id = ? OR is_pov = 1)"
        : "status IN ('active','outdated') AND knower_character_id = ?";
    const knowledge = decodeRows(
      'knowledge',
      queryBound(world.db, `SELECT * FROM knowledge WHERE branch_id = ? AND ${knowledgeWhere} ORDER BY first_received_at_s, id`, [
        world.branchId,
        entityId,
      ]),
    );
    const activeActions = decodeRows(
      'actions',
      queryBound(
        world.db,
        `SELECT * FROM actions WHERE branch_id = ? AND actor_entity_id = ? AND status IN ('planned','ready','active','paused','blocked') ORDER BY id`,
        [world.branchId, entityId],
      ),
    );
    const journeys = decodeRows(
      'journeys',
      queryBound(
        world.db,
        `SELECT * FROM journeys WHERE branch_id = ? AND mover_entity_id = ? AND status IN ('moving','paused','blocked') ORDER BY started_at_s, id`,
        [world.branchId, entityId],
      ),
    );
    const opportunities = (batch?.opportunities ?? []).filter((o) => o.receiverEntityId === entityId);

    for (const row of knowledge) refs.add(`knowledge:${String(row.id)}`);
    for (const row of knowledge) refs.add(`information:${String(row.information_id)}`);
    for (const row of activeActions) refs.add(`action:${String(row.id)}`);
    for (const row of journeys) refs.add(`journey:${String(row.id)}`);
    for (const opportunity of opportunities) {
      refs.add(`opportunity:${opportunity.id}`);
      if (opportunity.informationId) refs.add(`information:${opportunity.informationId}`);
      if (opportunity.locationId) refs.add(`location:${opportunity.locationId}`);
    }

    const informationIds = new Set([...knowledge.map(k => String(k.information_id)),
      ...opportunities.map(o => o.informationId).filter((id): id is string => typeof id === 'string')]);
    const information = [...informationIds].flatMap(id => queryBound(world.db,
      'SELECT id,title,content,kind FROM information WHERE branch_id=? AND id=?', [world.branchId,id]));

    // §17.2：自己的现场空间。位置未知就是 null —— 不许退回「他大概在城里」再编一间屋子。
    const scene = actorScene(world, entityId);
    if (scene?.location) refs.add(`location:${scene.location.locationId}`);

    actorSlices.push({ entityId, knowledge, activeActions, journeys, opportunities, information, scene });
  }

  actorSlices.sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));
  return { actorSlices, refs: [...refs].sort() };
}
