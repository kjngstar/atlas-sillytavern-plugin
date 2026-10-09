import {readSqlMapImage} from './atlas-sql-map-assets.ts';
import {previewSqlTravel} from './atlas-sql-travel-preview.ts';
import {inspectSqlWorld} from './atlas-sql-inspect.ts';
import {buildSqlForegroundRequest} from './atlas-sql-model-context.ts';
import {createTableReadPort} from './atlas-db-readport.ts';
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
import { VIEW_KINDS, CATALOG_ENTITY_KINDS, type ViewQuery } from './atlas-ops-contract.ts';
import type { AtlasEnvelope } from './atlas-db-contract.ts';
import { ATLAS_RUNTIME_LIMITS } from './atlas-runtime-limits.ts';
import {
  WORLD_FEED_CATEGORIES,
  type FeedFilter,
  type WorldCompletionInput,
  type WorldFeedCategory,
} from './atlas-world-contract.ts';

/** world-feed 过滤条件里唯一允许出现的键；别的键直接 INVALID_PAYLOAD。 */
const FEED_FILTER_KEYS = ['category', 'mapId', 'entityId', 'currentTurnOnly'] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * M5-08：把客户端传来的 feedFilter 收敛成契约字段。
 *
 * 纪律：绝不 `{...body}` 或 `{...body.feedFilter}` 透传 —— 只认白名单里这四个键，
 * 值和类型也要对；任何越界一律 INVALID_PAYLOAD（含「未知键」，不静默丢弃）。
 */
function parseFeedFilter(raw: unknown): FeedFilter | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainRecord(raw)) throw new AtlasDbError('INVALID_PAYLOAD', 'feedFilter 必须是对象', {});
  for (const key of Object.keys(raw)) {
    if (!(FEED_FILTER_KEYS as readonly string[]).includes(key)) {
      throw new AtlasDbError('INVALID_PAYLOAD', `feedFilter 不接受字段 ${key}`, { key });
    }
  }
  const filter: FeedFilter = {};
  if (raw.category !== undefined) {
    const category = String(raw.category);
    if (!(WORLD_FEED_CATEGORIES as readonly string[]).includes(category)) {
      throw new AtlasDbError('INVALID_PAYLOAD', `未知的事件流分类 ${category}`, { category });
    }
    filter.category = category as WorldFeedCategory;
  }
  if (raw.mapId !== undefined) {
    if (typeof raw.mapId !== 'string' || !raw.mapId) throw new AtlasDbError('INVALID_PAYLOAD', 'feedFilter.mapId 必须是非空字符串', {});
    filter.mapId = raw.mapId;
  }
  if (raw.entityId !== undefined) {
    if (typeof raw.entityId !== 'string' || !raw.entityId) throw new AtlasDbError('INVALID_PAYLOAD', 'feedFilter.entityId 必须是非空字符串', {});
    filter.entityId = raw.entityId;
  }
  if (raw.currentTurnOnly !== undefined) {
    if (typeof raw.currentTurnOnly !== 'boolean') throw new AtlasDbError('INVALID_PAYLOAD', 'feedFilter.currentTurnOnly 必须是布尔值', {});
    filter.currentTurnOnly = raw.currentTurnOnly;
  }
  return Object.keys(filter).length ? filter : undefined;
}

/**
 * M5-08：事件流的 POV 身份只认宿主已绑定的主角。
 *
 * 客户端不能拿一个字符 id 就借别人的视角看世界（敌对方角色就是典型越权）。
 * 拒绝时统一用同一句、同一个码：**不查、不区分**「不存在」与「没授权」——
 * 一旦消息有差别，就等于告诉客户端某个隐藏 id 到底存不存在。
 */
function resolveFeedPovId(session: SqlSession, asked: string): string | undefined {
  const allowed = protagonist(session);
  if (!asked) return allowed;
  if (asked === allowed) return allowed;
  throw new AtlasDbError('INVALID_PAYLOAD', '该视角不属于当前分支或宿主未授权', { chatId: session.chatUid });
}

/**
 * M3-14：普通楼层的建设焦点 = **主角当前实际所在地点**。
 *
 * 焦点由观察已应用的候选数据库解析：优先 branches.pov_character_id →
 * characters.location_id；首轮也可使用本轮刚登记的地点，不用旧快照猜起点。
 */
/** M3-14：让 builder 在观察阶段之后解析本轮 local 建设焦点。 */
function localWorldCompletion(_session: SqlSession, _manual: boolean): WorldCompletionInput | undefined {
  const maps=createTableReadPort(_session.repo.db).selectWhere('maps',{branch_id:_session.branchId,status:'active'});
  const unfinished=maps.some(m=>{let frame=m.frame_json;try{if(typeof frame==='string')frame=JSON.parse(frame);}catch{return true;}const fill=(frame as Record<string,unknown>)?.atlasWorldFill as Record<string,unknown>|undefined;return fill?.status==='deferred'||fill?.status==='partial';});
  const firstConstruction=!maps.some(m=>String(m.frame_json??'').includes('atlasWorldFill')||typeof m.frame_json==='object'&&m.frame_json!==null&&'atlasWorldFill' in m.frame_json);
  return {
    mode: unfinished||firstConstruction?'bootstrap':'local',
    // Derive from the observe-applied candidate, including a newly registered POV.
    focusLocationIds: [],
    policy: {
      version: 1,
      density: 'balanced',
      maxNewLocations: ATLAS_RUNTIME_LIMITS.newLocationsPerBatch,
      maxNewRoutes: ATLAS_RUNTIME_LIMITS.newRoutesPerBatch,
      maxAdditionalDepth: 2,
    },
  };
}

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
  if(action==='ui-read'){
    const kind=text(body.kind);
    if(!(VIEW_KINDS as readonly string[]).includes(kind))throw new AtlasDbError('INVALID_PAYLOAD','未知的只读视图',{});
    // M5-08：事件流的过滤与视角单独走白名单；别的视图保持原样（不把新字段塞进旧只读口）。
    const isFeed=kind==='world-feed';
    const feedFilter=isFeed?parseFeedFilter(body.feedFilter):undefined;
    const maxLimit=isFeed?ATLAS_RUNTIME_LIMITS.feedPageMax:200;
    const query:ViewQuery={kind:kind as ViewQuery['kind'],branchId:session.branchId,viewMode:body.viewMode==='author'?'author':'pov',
      revision:typeof body.revision==='number'?body.revision:undefined,entityId:text(body.entityId)||undefined,mapId:text(body.mapId)||undefined,
      entityKind:(CATALOG_ENTITY_KINDS as readonly string[]).includes(text(body.entityKind))?body.entityKind as ViewQuery['entityKind']:undefined,
      cursor:text(body.cursor)||undefined,limit:Math.min(maxLimit,Math.max(1,typeof body.limit==='number'?body.limit:maxLimit))};
    if(isFeed){query.povId=resolveFeedPovId(session,text(body.povId));if(feedFilter)query.feedFilter=feedFilter;}
    // cursor 过期/形状不对由 queryWorldFeed 走 VIEW_CURSOR_STALE / VIEW_CURSOR_INVALID，
    // 这里原样返回回执里的 code，让 UI 知道该重读第一页而不是误报 500。
    const result=await session.repo.queryView(query),last=latestFloor(session);
    return {...result,metadata:{...result.metadata,protagonistId:protagonist(session)??null,rollbackMessageId:last?floorIndex(last):null,
      canUndo:!!last,snapshotSaved:!!(session.chatMetadata.atlas as {database?:AtlasEnvelope}|undefined)?.database}};
  }
  if(action==='map/image')return readSqlMapImage(session,body.mapId);
  if(action==='travel-preview')return previewSqlTravel(session,body.destinationPointId);
  if(action==='inspect')return {report:inspectSqlWorld(session),coreSaved:false};
  if (action === 'binding') return { binding: binding(session), coreSaved: false };
  if (action === 'timeline') return querySqlCharacterTimeline({db:session.repo.db,branchId:session.branchId,revision:session.repo.internal.currentRevision(),viewMode:'author'},
    {characterId:text(body.characterId),offset:typeof body.offset==='number'?body.offset:undefined,limit:typeof body.limit==='number'?body.limit:undefined});
  if(action==='preview'){
    if(!session.modelPort?.preview)throw new AtlasDbError('SQL_PREVIEW_UNAVAILABLE','当前模型端口未提供请求预览，未调用模型',{});
    const sources=chatSources({...body,userText:text(body.userText),assistantText:text(body.assistantText),userMessageId:'preview',assistantMessageId:'preview'} as AtlasTurnCommitRequest,text(body.playerName));
    const input:TurnInput={anchor:{chatUid:session.chatUid,branchId:session.branchId,parentTurnId:session.repo.internal.currentHeadTurnId(),hostMessageUid:'preview',variantKey:'preview',baseRevision:session.repo.internal.currentRevision(),baseStorageRevision:session.repo.storageRevision,inputHash:'preview'},userText:text(body.userText),assistantText:text(body.assistantText),sourceSnapshot:sources,phaseBatches:['observe'],manual:false};
    return session.modelPort.preview(buildSqlForegroundRequest(createTableReadPort(session.repo.db),session.branchId,input,'observe','preview'));
  }
  if (action === 'state') {
    const logicalBinding=binding(session);
    const head=session.repo.internal.currentHeadTurnId();
    const headRow=head?queryBound(session.repo.db,"SELECT id, host_message_uid, host_variant_key, decisions_json, receipt_json FROM turns WHERE id=? AND branch_id=? AND kind='narrative' AND status='partial'",[head,session.branchId])[0]:null;
    const nativeReceipt=headRow?JSON.parse(String(headRow.receipt_json)):null;
    const retryContext=headRow&&toLegacyTurnReceipt(nativeReceipt).retryable===true?{
      turnId:String(headRow.id),assistantMessageId:floorIndex(headRow),hostMessageUid:String(headRow.host_message_uid),variantKey:String(headRow.host_variant_key),
    }:null;
    const receipts = queryBound(session.repo.db, "SELECT receipt_json, attempts_json, created_wall_ms FROM turns WHERE branch_id=? AND status IN ('committed','partial','failed') ORDER BY created_wall_ms DESC, rowid DESC LIMIT 10", [session.branchId]).flatMap(row => {
      try {
        const native = JSON.parse(String(row.receipt_json));
        if (!native?.turnId || !Array.isArray(native.groups) || !Array.isArray(native.issues)) return [];
        const legacy = toLegacyTurnReceipt(native, { coreSaved: true });
        const attempts = JSON.parse(String(row.attempts_json ?? '[]')).map((attempt: Record<string, unknown>) => ({ stage: attempt.kind ?? attempt.phase, phase: attempt.phase, httpStatus: attempt.http_status, errorCode: attempt.error_code, message: attempt.error, responseChars:attempt.response_chars,finishReason:attempt.finish_reason,durationMs:typeof attempt.started_wall_ms==='number'&&typeof attempt.finished_wall_ms==='number'?attempt.finished_wall_ms-attempt.started_wall_ms:undefined,status: attempt.error ? 'failed' : 'completed' }));
        return [{ ...legacy, status: native.status === 'noop' ? 'committed' : legacy.status, chatId: session.chatUid, recordedAt: Number(row.created_wall_ms), adoptedEventCount: 0, detail: { receipt: legacy.receipt, issues: legacy.issues, attempts, coreSaved: true } }];
      } catch { return []; }
    });
    return {...querySqlSceneState({db:session.repo.db,branchId:session.branchId,revision:session.repo.internal.currentRevision(),
      povId:protagonist(session),viewMode:'author',assets:((session.chatMetadata.atlas as {database?:AtlasEnvelope}|undefined)?.database?.assets??[])}, {chatUid:session.chatUid,worldUid:session.worldUid,worldName:session.branchName}),binding:logicalBinding,retryContext,receipts};
  }
  assertEnabled(session);
  // M3/W08：UI 显式重试布局 —— 只给这张地图的 failed 请求开新 ticket/opID，
  // 走受控 manual turn（不重放事件、不推进时间），成功与否都把回执原样交给 UI。
  if (action === 'layout-retry') {
    const mapId = text(body.mapId);
    if (!mapId) throw new AtlasDbError('INVALID_PAYLOAD', '重试布局需要指定地图', {});
    const rows = queryBound(session.repo.db, 'SELECT id, frame_json FROM maps WHERE branch_id=? AND id=?', [session.branchId, mapId]);
    let frame: Record<string, unknown> = {};
    if (rows.length) {
      try {
        const parsed: unknown = JSON.parse(String(rows[0].frame_json));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) frame = parsed as Record<string, unknown>;
      } catch { frame = {}; }
    }
    const request = frame.atlasLayoutRequest as Record<string, unknown> | undefined;
    if (!request || String(request.status ?? '') !== 'failed') {
      return { coreSaved: false, noop: true, issues: [], receipt: null };
    }
    const ticket = stableHexHash(JSON.stringify([session.branchId, mapId, text(request.requestId), text(request.failedAtTurnId), session.repo.internal.currentRevision()]));
    const suffix = ticket.slice(0, 24);
    const operationId = `op_layout_retry_${suffix}`;
    const requestId = `req_layout_retry_${suffix}`;
    const input: TurnInput = {
      anchor: { chatUid: session.chatUid, branchId: session.branchId, parentTurnId: session.repo.internal.currentHeadTurnId(),
        hostMessageUid: `layout-retry:${mapId}`, variantKey: 'layout-retry', baseRevision: session.repo.internal.currentRevision(),
        baseStorageRevision: session.repo.storageRevision, inputHash: stableHexHash(JSON.stringify([mapId, ticket])) },
      userText: '', assistantText: '', sourceSnapshot: [], phaseBatches: ['observe'], manual: true, narrativeKind: 'manual',
      operations: [], sceneMaps: false, layoutRetry: { mapId, requestId, operationId },
      isCurrent: typeof body.isCurrent === 'function' ? body.isCurrent as () => boolean : undefined,
    };
    const result = await runSqlTurn(session, input);
    const receipt = toLegacyTurnReceipt(result.receipt, { coreSaved: result.coreSaved });
    receipt.status = result.coreSaved ? (result.duplicate ? 'duplicate' : 'committed') : 'failed';
    if (!result.coreSaved) {
      receipt.summary = result.issues.map(i => i.message).join('；') || '布局重试未通过校验，旧图保持原状。';
      receipt.retryable = result.issues.every(i => !['CHAT_CHANGED', 'SESSION_STALE', 'STALE_BASE', 'TURN_CANCELLED'].includes(i.code));
    }
    return { receipt, nativeReceipt: result.receipt, coreSaved: result.coreSaved, issues: result.issues, noop: false };
  }
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
      povName: text(body.playerName),
      layoutMaps:'active',
      worldCompletion: localWorldCompletion(session, manual),
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
