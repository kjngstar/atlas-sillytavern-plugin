/**
 * atlas-ops-information.ts — D10/D11/D12 信息、注意与渠道（§5.2–5.5）。
 *
 * 关键规则：
 * - 真假与相信分开：数据库可知其为 false，但 NPC 可以相信。
 * - 正常传播引用同一个 information_id；只有内容实质变化才建立子版本。
 * - 有传言不等于全城知情：front 是「当地可能听见」，knowledge 是个体认知。
 * - attention 只能作用于程序提供的有效 opportunity 的接收者与信息，不能换收信人。
 * - 监视动作不自动读取隐藏思想。
 */

import type { Issue, ParsedOperation, RowMutation } from './atlas-ops-contract.ts';
import type { CompileContext, CompileResult } from './atlas-ops-compile-types.ts';
import { emptyCompileResult } from './atlas-ops-compile-types.ts';
import { createRow } from './atlas-db-defaults.ts';
import { resolveRef } from './atlas-ops-refs.ts';
import { fieldIgnoredWarning, asString, applyPatch } from './atlas-ops-entities.ts';

const INFORMATION_KINDS = ['observation', 'report', 'rumor', 'announcement', 'lie', 'hypothesis'];
const TRUTH_STATUS = ['true', 'false', 'mixed', 'unknown'];
const SECRECY = ['public', 'restricted', 'secret'];
const BELIEF = ['heard', 'doubted', 'believed', 'verified', 'rejected'];
const ATTENTION = ['low', 'normal', 'high'];
const REACH = ['isolated', 'local', 'widespread'];
const CHANNEL_KINDS = ['contact', 'faction_network', 'messenger', 'surveillance', 'broadcast', 'magic', 'other'];
const RELIABILITY = ['high', 'medium', 'low', 'unknown'];

function issue(code: string, path: string, message: string, op: ParsedOperation, extra: Partial<Issue> = {}): Issue {
  return { code, path, message, severity: 'error', retryable: true, opId: op.opId, line: op.line, ...extra };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mutation(
  table: string,
  rowId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  op: ParsedOperation,
  basis: Record<string, unknown>,
): RowMutation {
  return { table, rowId, before, after, sourceOpIds: [op.opId], basis };
}

function basisOf(ctx: CompileContext, op: ParsedOperation, causes: Array<{ kind: string; id: string }> = []): Record<string, unknown> {
  if (ctx.basisFor) return ctx.basisFor(op, { causes, certainty: 'inferred' }) as unknown as Record<string, unknown>;
  return {
    kind: ctx.phase === 'observe' ? 'story' : 'simulation',
    sources: [],
    causes,
    reason: op.value.why ?? '信息语义操作',
    verification: ctx.phase === 'observe' ? 'source_bound' : 'causal',
    certainty: ctx.phase === 'observe' ? 'confirmed' : 'inferred',
  };
}

/** 稳定内容哈希：同一内容不会重复生成第二条 information。 */
export function contentHashOf(content: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < content.length; i += 1) {
    const c = content.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (Math.imul(h2 ^ c, 0x85ebca6b) >>> 0) + c;
  }
  return `${h1.toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

/** 程序生成的归并主题：不能只按文字相似度合并（§5.2）。 */
export function topicKeyOf(kind: string, subjectId: string | null, content: string): string {
  const subject = subjectId ?? 'none';
  return `${kind}:${subject}:${contentHashOf(content.slice(0, 120))}`;
}

/** D10 compileInformationPropose。 */
export function compileInformationPropose(op: ParsedOperation, ctx: CompileContext): CompileResult {
  const result = emptyCompileResult();
  const data = (op.value.data ?? {}) as Record<string, unknown>;
  const known = new Set([
    'title', 'content', 'kind', 'event_ref', 'subject_ref', 'origin_ref', 'originator_ref', 'parent_ref',
    'truth', 'secrecy', 'spread_at_ref', 'recipient_ref', 'payload',
  ]);
  const unknown = Object.keys(data).filter((k) => !known.has(k));
  if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));

  const content = asString(data.content);
  if (!content) {
    result.issues.push(issue('MINIMUM_FIELD_MISSING', '$.data.content', 'information.propose 需要 content', op));
    return result;
  }

  const resolveOne = (value: unknown, kinds: string[], field: string): string | null => {
    if (typeof value !== 'string' || value.trim() === '') return null;
    const r = resolveRef(value, kinds as never, ctx.scope, { opId: op.opId, field });
    if (!r.entry) {
      result.issues.push(...r.issues);
      return null;
    }
    return r.entry.id;
  };

  let kind = 'observation';
  if (data.kind !== undefined) {
    const k = String(data.kind);
    if (!INFORMATION_KINDS.includes(k)) {
      result.issues.push(issue('ENUM_INVALID', '$.data.kind', `信息性质非法：${k}`, op));
      return result;
    }
    kind = k;
  }
  let truth = 'unknown';
  if (data.truth !== undefined) {
    const t = String(data.truth);
    if (!TRUTH_STATUS.includes(t)) {
      result.issues.push(issue('ENUM_INVALID', '$.data.truth', `truth 非法：${t}`, op));
      return result;
    }
    truth = t;
  }
  let secrecy = 'restricted';
  if (data.secrecy !== undefined) {
    const s = String(data.secrecy);
    if (!SECRECY.includes(s)) {
      result.issues.push(issue('ENUM_INVALID', '$.data.secrecy', `secrecy 非法：${s}`, op));
      return result;
    }
    secrecy = s;
  }

  const subjectId = resolveOne(data.subject_ref, ['character', 'faction', 'item', 'location'], 'subject_ref');
  const eventId = resolveOne(data.event_ref, ['event'], 'event_ref');
  const originLocationId = resolveOne(data.origin_ref, ['location'], 'origin_ref');
  const originatorId = resolveOne(data.originator_ref, ['character', 'faction'], 'originator_ref');
  const parentId = resolveOne(data.parent_ref, ['information'], 'parent_ref');
  const spreadAtLocationId = resolveOne(data.spread_at_ref, ['location'], 'spread_at_ref');
  const recipientId = resolveOne(data.recipient_ref, ['character', 'faction'], 'recipient_ref');

  if (data.payload !== undefined && data.payload !== null && !isPlainObject(data.payload)) {
    result.issues.push(issue('FIELD_TYPE_INVALID', '$.data.payload', 'payload 必须是 SubjectPayload 对象', op));
    return result;
  }

  const hash = contentHashOf(content);
  const topicKey = topicKeyOf(kind, subjectId, content);
  // 精确内容/结构哈希，防止重复生成同一条消息。
  const duplicate = ctx.tables.selectOne('information', ctx.branchId, ctx.makeId('information', op.opId, `info:${topicKey}:${hash}`));
  const infoId = ctx.makeId('information', op.opId, `info:${topicKey}:${hash}`);
  const turnId = ctx.turnId ?? ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;

  if (duplicate) {
    result.effects = [{ kind: 'information_reused', informationId: infoId, spreadAtLocationId, recipientId }];
    result.mutations.push(
      mutation(
        'information',
        infoId,
        duplicate,
        applyPatch(duplicate, { row_rev: Number(duplicate.row_rev ?? 1) + 1, updated_turn_id: turnId }),
        op,
        basisOf(ctx, op),
      ),
    );
    result.readSet.push({ table: 'information', rowId: infoId, rowRev: Number(duplicate.row_rev ?? 1) });
  } else {
    const row = createRow(
      'information',
      {
        kind,
        title: asString(data.title) ?? content.slice(0, 40),
        content,
        source_event_id: eventId,
        subject_entity_id: subjectId,
        payload_json: data.payload ?? null,
        origin_location_id: originLocationId,
        originator_entity_id: originatorId,
        parent_information_id: parentId,
        truth_status: truth,
        secrecy,
        topic_key: topicKey,
        content_hash: hash,
        created_at_s: ctx.clockS,
      },
      { branchId: ctx.branchId, id: infoId, turnId, clockS: ctx.clockS, nowWallMs: Date.now(), rulesetVersion: 'atlas-1' },
    );
    result.mutations.push(mutation('information', infoId, null, row, op, basisOf(ctx, op)));
    result.effects = [{ kind: 'information_created', informationId: infoId, spreadAtLocationId, recipientId }];
  }

  // spread_at_ref：只建立「当地风声」front（可能听见），不自动给居民加 knowledge。
  if (spreadAtLocationId) {
    const frontId = ctx.makeId('rumor_front', op.opId, `front:${infoId}:${spreadAtLocationId}`);
    const existingFront = ctx.tables.selectOne('rumor_fronts', ctx.branchId, frontId);
    if (existingFront) {
      result.mutations.push(
        mutation(
          'rumor_fronts',
          frontId,
          existingFront,
          applyPatch(existingFront, { last_reinforced_at_s: ctx.clockS, row_rev: Number(existingFront.row_rev ?? 1) + 1, updated_turn_id: turnId }),
          op,
          basisOf(ctx, op),
        ),
      );
    } else {
      const front = createRow(
        'rumor_fronts',
        {
          information_id: infoId,
          location_id: spreadAtLocationId,
          first_available_at_s: ctx.clockS,
          last_reinforced_at_s: ctx.clockS,
          next_spread_check_s: ctx.clockS + 3600,
          reach: 'local',
          audience_json: { access: 'public', tags: [] },
          status: 'active',
        },
        { branchId: ctx.branchId, id: frontId, turnId, clockS: ctx.clockS, nowWallMs: Date.now(), rulesetVersion: 'atlas-1' },
      );
      result.mutations.push(mutation('rumor_fronts', frontId, null, front, op, basisOf(ctx, op)));
    }
    result.effects.push({ kind: 'front_available', informationId: infoId, locationId: spreadAtLocationId, frontId });
  }

  // recipient_ref：明确点对点告知，才建立个体认知。
  if (recipientId) {
    const knowledgeId = ctx.makeId('knowledge', op.opId, `know:${infoId}:${recipientId}`);
    const existingKnowledge = ctx.tables.selectOne('knowledge', ctx.branchId, knowledgeId);
    if (!existingKnowledge) {
      const isFaction = Boolean(ctx.tables.selectOne('factions', ctx.branchId, recipientId));
      const row = createRow(
        'knowledge',
        {
          knower_character_id: isFaction ? null : recipientId,
          knower_faction_id: isFaction ? recipientId : null,
          is_pov: 0,
          information_id: infoId,
          first_received_at_s: ctx.clockS,
          belief: 'heard',
          attention: 'normal',
          status: 'active',
        },
        { branchId: ctx.branchId, id: knowledgeId, turnId, clockS: ctx.clockS, nowWallMs: Date.now(), rulesetVersion: 'atlas-1' },
      );
      result.mutations.push(mutation('knowledge', knowledgeId, null, row, op, basisOf(ctx, op)));
    }
  }

  if (!kind) result.issues.push(issue('ENUM_INVALID', '$.data.kind', '信息性质无法解析', op));
  return result;
}

/** D11 compileAttentionPropose。 */
export function compileAttentionPropose(op: ParsedOperation, ctx: CompileContext): CompileResult {
  const result = emptyCompileResult();
  const data = (op.value.data ?? {}) as Record<string, unknown>;
  const known = new Set(['opportunity_ref', 'belief', 'attention', 'thought', 'action_tendency', 'reaction_goal']);
  const unknown = Object.keys(data).filter((k) => !known.has(k));
  if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));

  const opportunityRef = op.value.ref?.trim() || asString(data.opportunity_ref);
  if (!opportunityRef) {
    result.issues.push(issue('MINIMUM_FIELD_MISSING', '$.data.opportunity_ref', 'attention.propose 需要 opportunity_ref', op));
    return result;
  }
  const opportunity = resolveRef(opportunityRef, ['opportunity'], ctx.scope, { opId: op.opId, line: op.line, field: 'opportunity_ref' });
  if (!opportunity.entry) {
    result.issues.push(
      ...(opportunity.issues.length
        ? opportunity.issues
        : [issue('OPPORTUNITY_UNKNOWN', '$.data.opportunity_ref', `没有这个接触机会：${opportunityRef}；无机会不能让人物凭空获知消息`, op)]),
    );
    return result;
  }

  const belief = data.belief === undefined ? '' : String(data.belief);
  if (!BELIEF.includes(belief)) {
    result.issues.push(issue('MINIMUM_FIELD_MISSING', '$.data.belief', 'attention.propose 需要 belief=heard/doubted/believed/verified/rejected', op));
    return result;
  }
  let attention = 'normal';
  if (data.attention !== undefined) {
    const a = String(data.attention);
    if (!ATTENTION.includes(a)) {
      result.issues.push(issue('ENUM_INVALID', '$.data.attention', `attention 非法：${a}`, op));
      return result;
    }
    attention = a;
  }

  // 机会本身携带接收者与信息：模型不能换收信人。
  const row = ctx.tables.selectOne('knowledge', ctx.branchId, opportunity.entry.id);
  const turnId = ctx.turnId ?? ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;
  const contact = ctx.sources.opportunities?.find(o => o.id === opportunity.entry!.id);
  if (!row) {
    const receiver = contact?.receiverEntityId ? ctx.tables.selectOne('characters', ctx.branchId, contact.receiverEntityId) : null;
    const informationId = contact?.informationId ? ctx.tables.selectOne('information', ctx.branchId, contact.informationId) : null;
    if (!receiver || !informationId) {
      result.issues.push(
        issue(
          'OPPORTUNITY_NOT_MATERIALIZED',
          '$.data.opportunity_ref',
          `机会 ${opportunity.entry.id} 尚未物化为接收者+信息的认知行：请由程序先建立机会`,
          op,
        ),
      );
      return result;
    }
  }

  const target = row ?? createRow('knowledge', {
    knower_character_id: contact!.receiverEntityId, information_id: contact!.informationId,
    first_received_at_s: contact!.atS,
  }, { branchId: ctx.branchId, id: opportunity.entry.id, turnId, clockS: ctx.clockS, nowWallMs: 0, rulesetVersion: 'atlas-1' });

  const after = applyPatch(target, {
    belief,
    attention,
    reaction_note: asString(data.thought) ?? String(target.reaction_note ?? ''),
    last_confirmed_at_s: ctx.clockS,
    row_rev: Number(target.row_rev ?? 1) + 1,
    updated_turn_id: turnId,
  });
  result.mutations.push(mutation('knowledge', String(target.id), row, after, op, basisOf(ctx, op)));
  if (row) result.readSet.push({ table: 'knowledge', rowId: String(target.id), rowRev: Number(row.row_rev ?? 1) });

  // 允许的心理/计划：由程序按已接受结果生成（不直接写坐标，也不瞬移）。
  if (typeof data.action_tendency === 'string' || typeof data.thought === 'string') {
    const knowerId = target.knower_character_id ? String(target.knower_character_id) : null;
    if (knowerId) {
      const character = ctx.tables.selectOne('characters', ctx.branchId, knowerId);
      if (character) {
        const charAfter = applyPatch(character, {
          thought: typeof data.thought === 'string' ? data.thought : character.thought,
          action_tendency: typeof data.action_tendency === 'string' ? data.action_tendency : character.action_tendency,
          row_rev: Number(character.row_rev ?? 1) + 1,
          updated_turn_id: turnId,
        });
        result.mutations.push(mutation('characters', knowerId, character, charAfter, op, basisOf(ctx, op)));
        result.readSet.push({ table: 'characters', rowId: knowerId, rowRev: Number(character.row_rev ?? 1) });
      }
    }
  }
  result.effects = [{ kind: 'attention_accepted', opportunityId: opportunity.entry.id, belief, attention }];
  return result;
}

/** D12 compileChannelUpsert。 */
export function compileChannelUpsert(op: ParsedOperation, ctx: CompileContext): CompileResult {
  const result = emptyCompileResult();
  const data = (op.value.data ?? {}) as Record<string, unknown>;
  const known = new Set([
    'owner_ref', 'kind', 'name', 'source_ref', 'source_location_ref', 'recipient_ref', 'recipient_location_ref',
    'scope', 'requirements', 'latency', 'transport_mode', 'reliability', 'secrecy',
  ]);
  const unknown = Object.keys(data).filter((k) => !known.has(k));
  if (unknown.length) result.issues.push(fieldIgnoredWarning(op, unknown));

  const ref = op.value.ref?.trim();
  const existing = ref && !ref.startsWith('new:') ? resolveRef(ref, 'channel', ctx.scope, { opId: op.opId, line: op.line, field: 'ref' }) : null;
  if (ref && !ref.startsWith('new:') && !existing?.entry) {
    result.issues.push(...(existing?.issues ?? [issue('REF_UNKNOWN', '$.ref', `找不到渠道引用：${ref}`, op)]));
    return result;
  }
  const creating = !existing?.entry;

  const resolveOne = (value: unknown, kinds: string[], field: string): string | null => {
    if (typeof value !== 'string' || value.trim() === '') return null;
    const r = resolveRef(value, kinds as never, ctx.scope, { opId: op.opId, field });
    if (!r.entry) {
      result.issues.push(...r.issues);
      return null;
    }
    return r.entry.id;
  };

  const ownerId = resolveOne(data.owner_ref, ['character', 'faction', 'item'], 'owner_ref');
  if (creating && !ownerId) {
    result.issues.push(issue('MINIMUM_FIELD_MISSING', '$.data.owner_ref', 'channel.upsert 需要 owner_ref', op));
    return result;
  }
  const kind = data.kind === undefined ? '' : String(data.kind);
  if (creating && !CHANNEL_KINDS.includes(kind)) {
    result.issues.push(issue('MINIMUM_FIELD_MISSING', '$.data.kind', `channel.upsert 需要 kind（${CHANNEL_KINDS.join('/')}）`, op));
    return result;
  }
  const name = asString(data.name);
  if (creating && !name) {
    result.issues.push(issue('MINIMUM_FIELD_MISSING', '$.data.name', 'channel.upsert 需要 name', op));
    return result;
  }

  const sourceEntityId = resolveOne(data.source_ref, ['character', 'faction', 'item'], 'source_ref');
  const sourceLocationId = resolveOne(data.source_location_ref, ['location'], 'source_location_ref');
  const recipientEntityId = resolveOne(data.recipient_ref, ['character', 'faction'], 'recipient_ref');
  const recipientLocationId = resolveOne(data.recipient_location_ref, ['location'], 'recipient_location_ref');

  if (recipientEntityId && recipientLocationId) {
    result.issues.push(issue('CHANNEL_RECIPIENT_CONFLICT', '$.data', 'recipient 实体/地点至多一个', op));
    return result;
  }

  if (data.scope !== undefined && data.scope !== null && !isPlainObject(data.scope)) {
    result.issues.push(issue('FIELD_TYPE_INVALID', '$.data.scope', 'scope 必须是 {location_refs,entity_refs,radius_m?,topics}', op));
    return result;
  }
  const scope = isPlainObject(data.scope) ? data.scope : { location_refs: [], entity_refs: [], topics: [] };
  const scopeLocationRefs: string[] = [];
  if (Array.isArray(scope.location_refs)) {
    for (const v of scope.location_refs) {
      const id = resolveOne(v, ['location'], 'scope.location_refs');
      if (id) scopeLocationRefs.push(id);
    }
  }
  const scopeEntityRefs: string[] = [];
  if (Array.isArray(scope.entity_refs)) {
    for (const v of scope.entity_refs) {
      const id = resolveOne(v, null as never, 'scope.entity_refs');
      if (id) scopeEntityRefs.push(id);
    }
  }

  // §5.5：source 可分别为空，但必须至少存在一项或有效 scope。范围不能默认为整个世界。
  const hasScope = scopeLocationRefs.length > 0 || scopeEntityRefs.length > 0;
  if (creating && !sourceEntityId && !sourceLocationId && !hasScope) {
    result.issues.push(
      issue('CHANNEL_SCOPE_REQUIRED', '$.data', '渠道必须至少有一项 source_ref / source_location_ref 或有效 scope；范围不能默认为整个世界', op),
    );
    return result;
  }

  let reliability = 'unknown';
  if (data.reliability !== undefined) {
    const r = String(data.reliability);
    if (!RELIABILITY.includes(r)) {
      result.issues.push(issue('ENUM_INVALID', '$.data.reliability', `reliability 非法：${r}`, op));
      return result;
    }
    reliability = r;
  }
  let secrecy = 'restricted';
  if (data.secrecy !== undefined) {
    const s = String(data.secrecy);
    if (!SECRECY.includes(s)) {
      result.issues.push(issue('ENUM_INVALID', '$.data.secrecy', `secrecy 非法：${s}`, op));
      return result;
    }
    secrecy = s;
  }
  if (data.requirements !== undefined && data.requirements !== null && !isPlainObject(data.requirements)) {
    result.issues.push(issue('FIELD_TYPE_INVALID', '$.data.requirements', 'requirements 必须是条件对象', op));
    return result;
  }

  const turnId = ctx.turnId ?? ctx.anchor.parentTurnId ?? `turn_${ctx.anchor.hostMessageUid}`;
  const rowId = existing?.entry ? existing.entry.id : ctx.makeId('channel', op.opId, ref && ref.startsWith('new:') ? ref : `chan:${name}`);
  const before = existing?.entry ? ctx.tables.selectOne('channels', ctx.branchId, rowId) : null;
  const changes: Record<string, unknown> = {
    name: name ?? before?.name ?? '',
    kind: CHANNEL_KINDS.includes(kind) ? kind : before?.kind ?? 'other',
    owner_entity_id: ownerId ?? before?.owner_entity_id ?? '',
    source_entity_id: sourceEntityId,
    source_location_id: sourceLocationId,
    recipient_entity_id: recipientEntityId,
    recipient_location_id: recipientLocationId,
    scope_json: { location_refs: scopeLocationRefs, entity_refs: scopeEntityRefs, radius_m: scope.radius_m ?? null, topics: Array.isArray(scope.topics) ? scope.topics : [] },
    requirements_json: data.requirements ?? null,
    latency_json: isPlainObject(data.latency) ? data.latency : { quality: 'unknown', basis_refs: [] },
    transport_mode_key: typeof data.transport_mode === 'string' ? data.transport_mode : null,
    reliability,
    secrecy,
  };

  if (result.issues.some((i) => i.severity === 'error')) return result;

  if (before) {
    const after = applyPatch(before, { ...changes, row_rev: Number(before.row_rev ?? 1) + 1, updated_turn_id: turnId });
    result.mutations.push(mutation('channels', rowId, before, after, op, basisOf(ctx, op)));
    result.readSet.push({ table: 'channels', rowId, rowRev: Number(before.row_rev ?? 1) });
  } else {
    const row = createRow('channels', changes, {
      branchId: ctx.branchId,
      id: rowId,
      turnId,
      clockS: ctx.clockS,
      nowWallMs: Date.now(),
      rulesetVersion: 'atlas-1',
    });
    result.mutations.push(mutation('channels', rowId, null, row, op, basisOf(ctx, op)));
  }
  return result;
}

export { REACH };
