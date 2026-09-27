/**
 * atlas-db-knowledge-view.ts — G05 / G06 主角认知投影与在场塑造区（§10.4）。
 *
 * 核心规则：
 * - 主角视图必须通过 knowledge → information.payload 构建**字段级**投影；
 *   不是给角色加个 known=true 就把全档案、未来行程和完整关系图暴露出去。
 * - 知道名字不等于读到全档案；上次见于… 不冒充当前跟踪。
 * - 当前在场 NPC 的隐藏想法可用于塑造表现，但放在独立 narrator_portrayal 区，
 *   并指明「可指导言行，不等于主角已知」。
 * - 作者地图开关只改变 UI，不自动改变剧情注入范围。
 */

import { queryBound } from './atlas-db-runtime.ts';
import { decodeRow } from './atlas-db-codec.ts';
import { resolveEffectivePosition } from './atlas-sim-position.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';

export type KnowledgeWorld = { db: SqlDatabase; branchId: string };

function rows(db: SqlDatabase, table: string, sql: string, params: Array<string | number | null>): Array<Record<string, unknown>> {
  return queryBound(db, sql, params).map((raw) => {
    const decoded = decodeRow(table as never, raw, { allowExtra: true });
    return decoded.ok ? (decoded.row as Record<string, unknown>) : (raw as Record<string, unknown>);
  });
}

export type PovProjection = {
  povId: string | null;
  isPovRow: boolean;
  knownLocations: Array<{ locationId: string; name: string; source: string; firstReceivedAtS: number; belief: string }>;
  knownCharacters: Array<{ entityId: string; name: string; belief: string; attention: string; reactionNote: string; identityKnown: boolean }>;
  /** 上次见于…（明确标注是旧信息，不冒充当前跟踪）。 */
  lastSeen: Array<{ entityId: string; name: string; locationId: string | null; atS: number }>;
  knownFacts: Array<{ informationId: string; title: string; content: string; truthForAuthor: string; belief: string; payload: unknown }>;
  /** 主角自己已知的秘密/渠道（不包含作者私有）。 */
  knownChannels: Array<{ channelId: string; name: string; kind: string }>;
  /** 明确写出的边界说明，供提示词审计。 */
  boundaries: string[];
};

const BASE_BOUNDARIES = [
  '字段级投影：只包含 knowledge 指向的信息与主角已确认的位置/身份。',
  '知道名字不等于读到全档案：description/personality/关系图不随名字一起暴露。',
  '上次见于…是历史信息，不是当前跟踪。',
  '作者视图开关不改变本投影。',
];

/**
 * G05 projectForPov：字段级知识、历史位置/消息更新。
 * 完成定义：知道名字不等于读到全档案；上次见于不冒充现位置。
 */
export function projectForPov(world: KnowledgeWorld, pov: { characterId: string | null; isPovRow?: boolean }): PovProjection {
  const povId = pov.characterId;
  // §5.4：已绑定 branches.pov_character_id 时主角认知直接用该人物行；尚未绑定时用 is_pov。
  // 两种持有者必须且只能选择一种，因此这里按优先级二选一，绝不相加。
  const knowledgeRows = povId
    ? rows(
        world.db,
        'knowledge',
        'SELECT * FROM knowledge WHERE branch_id = ? AND knower_character_id = ? AND status = ?',
        [world.branchId, povId, 'active'],
      )
    : rows(
        world.db,
        'knowledge',
        'SELECT * FROM knowledge WHERE branch_id = ? AND is_pov = 1 AND status = ?',
        [world.branchId, 'active'],
      );

  const informationIds = new Set(knowledgeRows.map((k) => String(k.information_id)));
  const informations = new Map<string, Record<string, unknown>>();
  for (const id of informationIds) {
    const found = rows(world.db, 'information', 'SELECT * FROM information WHERE branch_id = ? AND id = ?', [world.branchId, id]);
    if (found.length > 0) informations.set(id, found[0]);
  }

  const knownLocations: PovProjection['knownLocations'] = [];
  const knownCharacters: PovProjection['knownCharacters'] = [];
  const knownFacts: PovProjection['knownFacts'] = [];
  const lastSeen: PovProjection['lastSeen'] = [];

  for (const k of knowledgeRows) {
    const info = informations.get(String(k.information_id));
    if (!info) continue;
    const payload = (info.payload_json as Record<string, unknown> | null) ?? null;
    const subjectId = info.subject_entity_id ? String(info.subject_entity_id) : null;
    const firstReceived = Number(k.first_received_at_s ?? 0);

    knownFacts.push({
      informationId: String(info.id),
      title: String(info.title ?? ''),
      content: String(info.content ?? ''),
      truthForAuthor: String(info.truth_status ?? 'unknown'),
      belief: String(k.belief ?? 'heard'),
      payload,
    });

    if (subjectId) {
      const key = rows(world.db, 'entity_keys', 'SELECT kind FROM entity_keys WHERE branch_id = ? AND id = ?', [world.branchId, subjectId]);
      const kind = key.length > 0 ? String(key[0].kind) : '';
      if (kind === 'location') {
        const loc = rows(world.db, 'locations', 'SELECT name FROM locations WHERE branch_id = ? AND id = ?', [world.branchId, subjectId]);
        knownLocations.push({
          locationId: subjectId,
          name: loc.length > 0 ? String(loc[0].name ?? '') : '',
          source: String(info.kind ?? ''),
          firstReceivedAtS: firstReceived,
          belief: String(k.belief ?? 'heard'),
        });
      } else if (kind === 'character') {
        const ch = rows(world.db, 'characters', 'SELECT name, identity FROM characters WHERE branch_id = ? AND id = ?', [world.branchId, subjectId]);
        // 字段级：只有名字与「身份是否已知」由 payload 的 predicate=identity 决定，
        // description/personality/关系图不进主角投影。
        const identityKnown = Boolean(payload && String(payload.predicate ?? '') === 'identity');
        knownCharacters.push({
          entityId: subjectId,
          name: ch.length > 0 ? String(ch[0].name ?? '') : '',
          belief: String(k.belief ?? 'heard'),
          attention: String(k.attention ?? 'normal'),
          reactionNote: String(k.reaction_note ?? ''),
          identityKnown,
        });
        if (payload && String(payload.predicate ?? '') === 'located_at') {
          const value = payload.value as Record<string, unknown> | string | null;
          const locationId = typeof value === 'string' ? value : value && typeof value === 'object' ? String((value as { entity_ref?: string }).entity_ref ?? '') : '';
          lastSeen.push({
            entityId: subjectId,
            name: ch.length > 0 ? String(ch[0].name ?? '') : '',
            locationId: locationId || null,
            atS: typeof payload.as_of_s === 'number' ? payload.as_of_s : firstReceived,
          });
        }
      }
    }
  }

  const knownChannels = rows(
    world.db,
    'channels',
    'SELECT * FROM channels WHERE branch_id = ? AND status = ? AND secrecy != ?',
    [world.branchId, 'active', 'secret'],
  )
    .filter((c) => (povId ? String(c.owner_entity_id) === povId || String(c.recipient_entity_id ?? '') === povId : false))
    .map((c) => ({ channelId: String(c.id), name: String(c.name ?? ''), kind: String(c.kind ?? '') }));

  return {
    povId,
    isPovRow: Boolean(pov.isPovRow),
    knownLocations,
    knownCharacters,
    lastSeen,
    knownFacts,
    knownChannels,
    boundaries: [...BASE_BOUNDARIES],
  };
}

export type NarratorPortrayal = {
  /** 仅在场/实际接触的 NPC。 */
  entries: Array<{
    entityId: string;
    name: string;
    identity: string;
    thought: string;
    actionTendency: string;
    physicalStatus: string;
    conditionNote: string;
    position: string;
    /** 明确标注：可指导言行，不等于主角已知。 */
    disclosure: 'narrator_only';
  }>;
  exclusions: string[];
  boundaries: string[];
};

/**
 * G06 projectPortrayal：仅在场/实际接触 NPC 的允许思想塑造区。
 * 完成定义：作者地图开关不扩大注入范围；远方全量秘密不注入正文。
 */
export function projectPortrayal(
  world: KnowledgeWorld,
  scene: { locationId?: string | null; mapId?: string | null; actorIds?: string[]; entityIds?: string[] },
): NarratorPortrayal {
  const present = new Set<string>(scene.actorIds ?? scene.entityIds ?? []);
  const exclusions: string[] = [];

  if (present.size === 0 && scene.locationId) {
    const here = rows(
      world.db,
      'characters',
      'SELECT id FROM characters WHERE branch_id = ? AND location_id = ? AND status = ?',
      [world.branchId, scene.locationId, 'active'],
    );
    for (const row of here) present.add(String(row.id));
  }

  const entries: NarratorPortrayal['entries'] = [];
  for (const entityId of present) {
    const found = rows(
      world.db,
      'characters',
      'SELECT * FROM characters WHERE branch_id = ? AND id = ? AND status = ?',
      [world.branchId, entityId, 'active'],
    );
    if (found.length === 0) {
      exclusions.push(`${entityId}: 不在本分支的在场人物中`);
      continue;
    }
    const ch = found[0];
    const position = resolveEffectivePosition({ db: world.db, branchId: world.branchId }, entityId);
    // 只有在场/粗定位在同一场景才注入：in_transit 或位置未知的远方角色不进塑造区。
    if (scene.locationId && position.kind === 'at_location' && position.locationId !== scene.locationId) {
      exclusions.push(`${entityId}: 不在当前场景`);
      continue;
    }
    if (position.kind === 'unknown') {
      exclusions.push(`${entityId}: 位置未知，不作为在场角色注入`);
      continue;
    }
    entries.push({
      entityId,
      name: String(ch.name ?? ''),
      identity: String(ch.identity ?? ''),
      thought: String(ch.thought ?? ''),
      actionTendency: String(ch.action_tendency ?? ''),
      physicalStatus: String(ch.physical_status ?? 'unknown'),
      conditionNote: String(ch.condition_note ?? ''),
      position: position.kind,
      disclosure: 'narrator_only',
    });
  }

  return {
    entries,
    exclusions,
    boundaries: [
      '可指导言行，不等于主角已知；主角知识仍由 knowledge 决定。',
      '只包含在场/实际接触的 NPC；远方角色的秘密计划不注入。',
      '作者地图开关只改变 UI，不扩大本区范围。',
    ],
  };
}

/** 供 ViewQuery kind='prompt' 使用：一次返回两个投影与其边界说明。 */
export function projectPromptView(
  world: KnowledgeWorld,
  query: { povId?: string | null; sceneLocationId?: string | null; actorIds?: string[]; viewMode?: 'pov' | 'author' },
): { pov: PovProjection; portrayal: NarratorPortrayal | null; promptScope: string[] } {
  const pov = projectForPov(world, { characterId: query.povId ?? null });
  // author 视图只影响 portrayal 是否附带；主角投影范围不变（§10.4）。
  const portrayal = query.sceneLocationId || query.actorIds?.length
    ? projectPortrayal(world, { locationId: query.sceneLocationId ?? null, actorIds: query.actorIds })
    : null;
  return {
    pov,
    portrayal,
    promptScope: [
      `主角已知信息 ${pov.knownFacts.length} 条、已知人物 ${pov.knownCharacters.length} 名、已知地点 ${pov.knownLocations.length} 处`,
      portrayal ? `在场塑造 ${portrayal.entries.length} 人（narrator_only）` : '无在场塑造区',
    ],
  };
}
