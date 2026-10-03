/** Automatic chat compatibility boundary. Business writes use the SQL session only. */
import { parseAtlasTurnCommitRequest, parseAtlasTurnPrepareRequest } from './atlas-contract.ts';
import { stableHexHash } from './atlas-hash.ts';
import { AtlasDbError, queryBound } from './atlas-db-runtime.ts';
import { toLegacyStateDto, toLegacyTurnReceipt } from './atlas-db-state-adapter.ts';
import { runSqlTurn, runSqlRollback } from './atlas-sql-session.ts';
import type { SqlSession } from './atlas-sql-session.ts';
import type { TurnAnchor, TurnInput } from './atlas-ops-contract.ts';

const preparations = new WeakMap<SqlSession, Map<string, { anchor: TurnAnchor; messageId: string; userText: string }>>();
const text = (v: unknown): string => typeof v === 'string' ? v : '';
function branch(session: SqlSession): Record<string, unknown> {
  return queryBound(session.repo.db, 'SELECT * FROM branches WHERE id=?', [session.branchId])[0];
}
function protagonist(session: SqlSession): string | undefined {
  const id = branch(session).pov_character_id;
  if (id) return String(id);
  const rows = queryBound(session.repo.db, "SELECT id FROM characters WHERE branch_id=? AND role='protagonist' AND status='active'", [session.branchId]);
  return rows.length === 1 ? String(rows[0].id) : undefined;
}
function location(session: SqlSession): string | null {
  const pov = branch(session).pov_character_id;
  const rows = pov ? queryBound(session.repo.db, 'SELECT location_id FROM characters WHERE branch_id=? AND id=? AND status=?', [session.branchId, String(pov), 'active'])
    : queryBound(session.repo.db, "SELECT location_id FROM characters WHERE branch_id=? AND role='protagonist' AND status='active'", [session.branchId]);
  return rows.length === 1 && rows[0].location_id ? String(rows[0].location_id) : null;
}
function binding(session: SqlSession): Record<string, unknown> {
  const atlas = session.chatMetadata.atlas as Record<string, unknown> | undefined;
  const old = atlas?.binding as { enabled?: boolean } | undefined;
  const last = latestFloor(session);
  return { schemaVersion: 1, chatId: session.chatUid, worldId: session.worldUid, branchId: session.branchId,
    enabled: typeof atlas?.sqlChatEnabled === 'boolean' ? atlas.sqlChatEnabled : old?.enabled !== false,
    worldTimeCursor: Number(branch(session).clock_s), currentLocationId: location(session),
    lastCommittedMessageId: last ? floorIndex(last) : null, lastCommittedSwipeId: null };
}
function latestFloor(session: SqlSession): Record<string, unknown> | undefined {
  return queryBound(session.repo.db, "SELECT id, host_message_uid, decisions_json FROM turns WHERE branch_id=? AND kind='narrative' AND status IN ('committed','partial') ORDER BY committed_revision DESC, created_wall_ms DESC LIMIT 1", [session.branchId])[0];
}
function floorIndex(row: Record<string, unknown>): string {
  const decisions = JSON.parse(String(row.decisions_json)) as { host_message_index?: string };
  return decisions.host_message_index ?? String(row.host_message_uid);
}
function assertEnabled(session: SqlSession): void {
  if (!binding(session).enabled) throw new AtlasDbError('SQL_CHAT_DISABLED', '本聊天推演已停用', {});
}

/** Called by the explicit /sql/chat/* routes; no old session document is returned. */
export async function handleSqlChatRequest(session: SqlSession, action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (action === 'binding') return { binding: binding(session), coreSaved: false };
  if (action === 'state') {
    const query = { kind: 'map' as const, branchId: session.branchId, viewMode: 'author' as const };
    const state = toLegacyStateDto(await session.repo.queryView(query), query);
    const nearbyQuery = { kind: 'nearby' as const, branchId: session.branchId, povId: protagonist(session), viewMode: 'author' as const };
    const near = toLegacyStateDto(await session.repo.queryView(nearbyQuery), nearbyQuery);
    const logicalBinding = binding(session);
    return { ...state, chatId: session.chatUid, worldId: session.worldUid, worldName: session.branchName,
      currentTime: logicalBinding.worldTimeCursor, currentLocationId: logicalBinding.currentLocationId,
      binding: logicalBinding, relevantNpcIds: near.relevantNpcIds,
      tableMap: { ...(state.tableMap as object), nearby: (near.tableMap as Record<string, unknown>).nearby },
      sqlMode: true, coreSaved: false };
  }
  assertEnabled(session);
  if (action === 'prepare') {
    const parsed = parseAtlasTurnPrepareRequest(body);
    if (!parsed.ok || parsed.value.chatId !== session.chatUid) throw new AtlasDbError('INVALID_PAYLOAD', 'SQL prepare 请求形状或聊天身份不符', {});
    const request = parsed.value;
    const anchor: TurnAnchor = { chatUid: session.chatUid, branchId: session.branchId, parentTurnId: session.repo.internal.currentHeadTurnId(),
      hostMessageUid: request.messageId, variantKey: 'prepare', baseRevision: session.repo.internal.currentRevision(),
      baseStorageRevision: session.repo.storageRevision, inputHash: stableHexHash(request.userText) };
    const turnId = 'sql-prepare-' + stableHexHash(JSON.stringify(anchor)).slice(0, 40);
    let records = preparations.get(session);
    if (!records) { records = new Map(); preparations.set(session, records); }
    records.set(turnId, { anchor, messageId: request.messageId, userText: request.userText });
    while (records.size > 32) records.delete(records.keys().next().value!);
    return { response: { turnId, injectionText: '', sourceRefs: [], relevantNpcIds: [], triggerIds: [],
      currentTime: Number(branch(session).clock_s), currentLocationId: location(session) }, coreSaved: false };
  }
  if (action === 'commit') {
    const parsed = parseAtlasTurnCommitRequest(body);
    if (!parsed.ok || parsed.value.chatId !== session.chatUid) throw new AtlasDbError('INVALID_PAYLOAD', 'SQL commit 请求形状或聊天身份不符', {});
    const request = parsed.value;
    const manual = request.turnId.startsWith('turn-manual-');
    const prepared = preparations.get(session)?.get(request.turnId);
    if (!manual && (!prepared || prepared.messageId !== request.userMessageId || prepared.userText !== request.userText)) {
      throw new AtlasDbError('SQL_PREPARE_EXPIRED', '本轮 SQL prepare 已失效，请重新生成；不会回落到三表写入', {});
    }
    const sources: TurnInput['sourceSnapshot'] = [];
    const add = (key: string, kind: TurnInput['sourceSnapshot'][number]['kind'], value: string) => {
      if (value) sources.push({ key, kind, text: value, hash: stableHexHash(value) });
    };
    add('user:' + request.userMessageId, 'user', request.userText);
    add('story:' + request.assistantMessageId, 'story', request.assistantText);
    (request.recentAssistantTexts ?? []).forEach((value, index) => add('recent:' + index, 'story', value));
    add('player', 'user', JSON.stringify({ name: text(body.playerName), description: request.personaDescription ?? '' }));
    add('card', 'lorebook', request.charDescription ?? '');
    add('lore', 'lorebook', request.loreSupplement ?? '');
    const variantKey = text(body.variantKey) || request.swipeId || 'original';
    const input: TurnInput = { anchor: { ...(prepared?.anchor ?? { chatUid: session.chatUid, branchId: session.branchId,
        parentTurnId: session.repo.internal.currentHeadTurnId(), baseRevision: session.repo.internal.currentRevision(), baseStorageRevision: session.repo.storageRevision }),
        hostMessageUid: text(body.hostMessageUid) || request.assistantMessageId, variantKey,
        inputHash: stableHexHash(JSON.stringify([request.userMessageId, request.assistantMessageId, variantKey, sources])) },
      userText: request.userText, assistantText: request.assistantText, sourceSnapshot: sources, phaseBatches: ['observe'], manual: false,
      narrativeKind: manual ? 'manual' : 'narrative',
      hostMessageIndex: request.assistantMessageId,
      isCurrent: typeof body.isCurrent === 'function' ? body.isCurrent as () => boolean : undefined };
    const result = await runSqlTurn(session, input);
    const receipt = toLegacyTurnReceipt(result.receipt, { coreSaved: result.coreSaved });
    receipt.status = result.coreSaved ? result.duplicate ? 'duplicate' : 'committed' : 'failed';
    if (!result.coreSaved) {
      receipt.summary = result.issues.map(i => i.message).join('；') || '宿主保存尚未确认，世界未发布。';
      receipt.retryable = result.issues.every(i => !['CHAT_CHANGED', 'SESSION_STALE', 'STALE_BASE', 'TURN_CANCELLED'].includes(i.code));
    }
    return { receipt, nativeReceipt: result.receipt, coreSaved: result.coreSaved, issues: result.issues };
  }
  if (action === 'rollback') {
    const floor = text(body.assistantMessageId);
    const row = latestFloor(session);
    if (!row) return { coreSaved: true, duplicate: true, binding: binding(session) };
    if (floorIndex(row) !== floor) throw new AtlasDbError('SQL_ROLLBACK_FLOOR_MISMATCH', '该楼层不是最近一次 SQL 推演楼层，不能隐式回退后续剧情', {});
    const result = await runSqlRollback(session, { chatUid: session.chatUid, branchId: session.branchId,
      targetParentTurnId: String(row.id), expectedRevision: session.repo.internal.currentRevision() });
    return { coreSaved: result.coreSaved, receipt: toLegacyTurnReceipt(result.receipt, { coreSaved: result.coreSaved }), issues: result.issues };
  }
  throw new AtlasDbError('INVALID_PAYLOAD', '未知 SQL 聊天动作：' + action, {});
}
