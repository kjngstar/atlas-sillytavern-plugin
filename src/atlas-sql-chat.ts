/** Automatic chat compatibility boundary. Business writes use the SQL session only. */
import { parseAtlasTurnCommitRequest, parseAtlasTurnPrepareRequest } from './atlas-contract.ts';
import type { AtlasTurnCommitRequest } from './atlas-contract.ts';
import { stableHexHash } from './atlas-hash.ts';
import { AtlasDbError, queryBound } from './atlas-db-runtime.ts';
import { querySqlSceneState } from './atlas-sql-view-state.ts';
import { querySqlCharacterTimeline } from './atlas-sql-timeline.ts';
import { handleSqlMapAction } from './atlas-sql-map-actions.ts';
import { toLegacyTurnReceipt } from './atlas-db-state-adapter.ts';
import { runSqlTurn, runSqlRollback } from './atlas-sql-session.ts';
import { runSqlModelRetry } from './atlas-sql-retry.ts';
import type { SqlSession } from './atlas-sql-session.ts';
import type { TurnAnchor, TurnInput } from './atlas-ops-contract.ts';
import type { AtlasEnvelope } from './atlas-db-contract.ts';

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
function chatSources(request: AtlasTurnCommitRequest, playerName: string): TurnInput['sourceSnapshot'] {
  const sources: TurnInput['sourceSnapshot'] = [];
  const add = (key: string, kind: TurnInput['sourceSnapshot'][number]['kind'], value: string) => {
    if (value) sources.push({ key, kind, text: value, hash: stableHexHash(value) });
  };
  add('user:' + request.userMessageId, 'user', request.userText);
  add('story:' + request.assistantMessageId, 'story', request.assistantText);
  (request.recentAssistantTexts ?? []).forEach((value, index) => add('recent:' + index, 'story', value));
  add('player', 'user', JSON.stringify({ name: playerName, description: request.personaDescription ?? '' }));
  add('card', 'lorebook', request.charDescription ?? '');
  add('lore', 'lorebook', request.loreSupplement ?? '');
  return sources;
}

/** Called by the explicit /sql/chat/* routes; no old session document is returned. */
export async function handleSqlChatRequest(session: SqlSession, action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (action === 'binding') return { binding: binding(session), coreSaved: false };
  if (action === 'timeline') return querySqlCharacterTimeline({db:session.repo.db,branchId:session.branchId,revision:session.repo.internal.currentRevision(),viewMode:'author'},
    {characterId:text(body.characterId),offset:typeof body.offset==='number'?body.offset:undefined,limit:typeof body.limit==='number'?body.limit:undefined});
  if (action === 'state') {
    const logicalBinding=binding(session);
    return {...querySqlSceneState({db:session.repo.db,branchId:session.branchId,revision:session.repo.internal.currentRevision(),
      povId:protagonist(session),viewMode:'author',assets:((session.chatMetadata.atlas as {database?:AtlasEnvelope}|undefined)?.database?.assets??[])}, {chatUid:session.chatUid,worldUid:session.worldUid,worldName:session.branchName}),binding:logicalBinding};
  }
  assertEnabled(session);
  if(action.startsWith('map/'))return handleSqlMapAction(session,action,body);
  if (action === 'retry') {
    const parsed = parseAtlasTurnCommitRequest(body);
    if (!parsed.ok || parsed.value.chatId !== session.chatUid) throw new AtlasDbError('INVALID_PAYLOAD', 'SQL 补交素材不属于当前聊天', {});
    const result = await runSqlModelRetry(session, { turnId: text(body.sqlTurnId), sourceSnapshot: chatSources(parsed.value, text(body.playerName)),
      isCurrent: typeof body.isCurrent === 'function' ? body.isCurrent as () => boolean : undefined });
    const receipt = toLegacyTurnReceipt(result.receipt, { coreSaved: result.coreSaved });
    receipt.status = result.coreSaved ? 'committed' : 'failed';
    if (!result.coreSaved) {
      receipt.summary = result.issues.map(i => i.message).join('；') || '失败组尚未补交，已保存结果保持原状。';
      receipt.retryable = true;
    }
    return { receipt, nativeReceipt: result.receipt, coreSaved: result.coreSaved, issues: result.issues };
  }
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
    const sources = chatSources(request, text(body.playerName));
    const variantKey = text(body.variantKey) || request.swipeId || 'original';
    const input: TurnInput = { anchor: { ...(prepared?.anchor ?? { chatUid: session.chatUid, branchId: session.branchId,
        parentTurnId: session.repo.internal.currentHeadTurnId(), baseRevision: session.repo.internal.currentRevision(), baseStorageRevision: session.repo.storageRevision }),
        hostMessageUid: text(body.hostMessageUid) || request.assistantMessageId, variantKey,
        inputHash: stableHexHash(JSON.stringify([request.userMessageId, request.assistantMessageId, variantKey, sources])) },
      userText: request.userText, assistantText: request.assistantText, sourceSnapshot: sources, phaseBatches: ['observe'], manual: false,
      narrativeKind: manual ? 'manual' : 'narrative',
      hostMessageIndex: request.assistantMessageId,
      sceneMaps:true,
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
    const rows=queryBound(session.repo.db,"SELECT id,host_message_uid,decisions_json FROM turns WHERE branch_id=? AND kind='narrative' AND status IN ('committed','partial') ORDER BY committed_revision DESC,created_wall_ms DESC",[session.branchId]);
    if (!rows.length) return { coreSaved: true, duplicate: true, binding: binding(session) };
    const row=rows.find(row=>floorIndex(row)===floor);
    if (!row) throw new AtlasDbError('SQL_ROLLBACK_FLOOR_MISMATCH', '目标楼层没有当前分支的有效 SQL 推演记录', {});
    const result = await runSqlRollback(session, { chatUid: session.chatUid, branchId: session.branchId,
      targetParentTurnId: String(row.id), expectedRevision: session.repo.internal.currentRevision() });
    return { coreSaved: result.coreSaved, receipt: toLegacyTurnReceipt(result.receipt, { coreSaved: result.coreSaved }), issues: result.issues };
  }
  throw new AtlasDbError('INVALID_PAYLOAD', '未知 SQL 聊天动作：' + action, {});
}
