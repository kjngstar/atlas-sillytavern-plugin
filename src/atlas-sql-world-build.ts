import { stableHexHash } from './atlas-hash.ts';
import { AtlasDbError } from './atlas-db-runtime.ts';
import { runSqlTurn } from './atlas-sql-session.ts';
import type { SqlSession, SqlTurnResult } from './atlas-sql-session.ts';
import { buildProgressFingerprint, buildSourceManifestHash, currentBuildJob, pendingWorldBuildEntries } from './atlas-world-build-execution.ts';
import { normalizeControlRequest, runnerOwnershipKey } from './atlas-world-build-runner.ts';
import type { WorldBuildControlAction } from './atlas-world-build-runner.ts';
import type { SourceSnapshotEntry, TurnInput } from './atlas-ops-contract.ts';
import { sanitizeModelCallAudit } from './atlas-model-call-audit.ts';

type BuildFlight = { session: SqlSession; cancelled: boolean; promise: Promise<void>; error: string | null; resume?: { onSaved?: () => void } };
const flights = new Map<string, BuildFlight>();
const materials = new WeakMap<SqlSession, readonly SourceSnapshotEntry[]>();
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function rememberWorldBuildSources(session: SqlSession, sources: readonly SourceSnapshotEntry[]): void {
  const before = materials.get(session);
  if (before && before.filter(source=>source.kind==='lorebook').some(old=>!sources.some(source=>source.kind==='lorebook'&&source.key===old.key&&source.hash===old.hash))) {
    const flight = flights.get(runnerOwnershipKey(session.chatUid));
    if (flight?.session === session) flight.cancelled = true;
  }
  materials.set(session, sources.map(source => ({ ...source })));
}

function sourcesFrom(body: Record<string, unknown>, session: SqlSession): SourceSnapshotEntry[] {
  if (body['charDescription'] !== undefined || body['loreSupplement'] !== undefined) {
    const sources: SourceSnapshotEntry[] = [];
    for (const [field, key] of [['charDescription', 'card'], ['loreSupplement', 'lore']]) {
      const text = body[field];
      if (text !== undefined && typeof text !== 'string') throw new AtlasDbError('INVALID_PAYLOAD', '来源原文必须为字符串', {});
      if (typeof text === 'string' && text.trim()) sources.push({ key, text, hash: stableHexHash(text), kind: 'lorebook' });
    }
    rememberWorldBuildSources(session, sources);
    return sources;
  }
  if (body['sourceSnapshot'] === undefined) return [...(materials.get(session) ?? [])];
  const raw = body['sourceSnapshot'];
  if (!Array.isArray(raw)) throw new AtlasDbError('INVALID_PAYLOAD', 'sourceSnapshot 必须为来源数组', {});
  const sources: SourceSnapshotEntry[] = [];
  for (const entry of raw) {
    if (!object(entry) || typeof entry['key'] !== 'string' || !entry['key'].trim() || typeof entry['text'] !== 'string' || typeof entry['hash'] !== 'string' || !entry['hash'])
      throw new AtlasDbError('INVALID_PAYLOAD', '来源必须包含真实 key、hash 与原文', {});
    const kind = entry['kind'];
    if (kind !== 'lorebook' && kind !== 'story' && kind !== 'user' && kind !== 'estimate' && kind !== 'simulation' && kind !== 'migration')
      throw new AtlasDbError('INVALID_PAYLOAD', '来源 kind 非法', {});
    sources.push({ key: entry['key'], text: entry['text'], hash: entry['hash'], kind });
  }
  rememberWorldBuildSources(session, sources);
  return sources;
}

function current(session: SqlSession): boolean {
  return !session.closed && (!session.isCurrentHost || session.isCurrentHost());
}

function inputFor(session: SqlSession, sources: SourceSnapshotEntry[], action: WorldBuildControlAction, isCurrent?: () => boolean): TurnInput {
  const job = currentBuildJob(session.repo.db, session.branchId);
  const identity = [job?.id ?? 'new', job?.runEpoch ?? 0, job?.nextWindowSequence ?? 0, action];
  return { anchor: { chatUid: session.chatUid, branchId: session.branchId, parentTurnId: session.repo.internal.currentHeadTurnId(),
    hostMessageUid: `world-build:${stableHexHash(JSON.stringify(identity))}`, variantKey: action,
    baseRevision: session.repo.internal.currentRevision(), baseStorageRevision: session.repo.storageRevision,
    inputHash: stableHexHash(JSON.stringify([identity, sources.map(source => [source.key, source.hash])])) },
    userText: '', assistantText: '', sourceSnapshot: sources, phaseBatches: [], manual: false, narrativeKind: 'manual', sceneOnly: true,
    constructionContinue: true, worldBuild: { action, ...(job ? { jobId: job.id, expectedEpoch: job.runEpoch } : {}) },
    isCurrent: () => current(session) && (!isCurrent || isCurrent()) };
}

async function batch(session: SqlSession, sources: SourceSnapshotEntry[], action: WorldBuildControlAction, isCurrent?: () => boolean, pauseReason?: string, onSaved?: () => void): Promise<SqlTurnResult> {
  if (action !== 'stop' && session.readWorldBuildSources) {
    sources = [...await session.readWorldBuildSources()];
    materials.set(session, sources.map(source=>({...source})));
  }
  const input = inputFor(session, sources, action, isCurrent);
  if (input.worldBuild && pauseReason) input.worldBuild.pauseReason = pauseReason;
  if (action !== 'stop' && session.readWorldBuildSources) input.beforePublish = async () => {
    const fresh = [...await session.readWorldBuildSources!()];
    materials.set(session, fresh.map(source=>({...source})));
    return sources.filter(source=>source.kind==='lorebook').every(old=>fresh.some(source=>source.kind==='lorebook'&&source.key===old.key&&source.hash===old.hash));
  };
  const accountAborted = async (audit: unknown) => {
    if (action==='stop'||!object(audit)||typeof audit['transports']!=='number'||audit['transports']<=0||!current(session)
      || currentBuildJob(session.repo.db,session.branchId)?.id!==input.worldBuild?.jobId) return;
    const accounting=inputFor(session,sources,'stop');
    if (accounting.worldBuild) { accounting.worldBuild.pauseReason=currentBuildJob(session.repo.db,session.branchId)?.stopReason??'WORLD_BUILD_CANDIDATE_REJECTED';
      accounting.worldBuild.abortedWindow={id:stableHexHash(JSON.stringify(input.anchor)),transports:audit['transports'],
        requestAudit:sanitizeModelCallAudit(audit)??undefined,
        windowSequence:currentBuildJob(session.repo.db,session.branchId)?.nextWindowSequence}; }
    const saved=await runSqlTurn(session,accounting);
    if(saved.coreSaved)onSaved?.();
  };
  try {
    const result=await runSqlTurn(session, input);
    if(!result.coreSaved)await accountAborted(result.receipt.requestAudit);
    return result;
  } catch(error) {
    if(error instanceof AtlasDbError)await accountAborted(error.detail['requestAudit']);
    throw error;
  }
}

function launch(session: SqlSession, sources: SourceSnapshotEntry[], onSaved?: () => void): BuildFlight {
  const key = runnerOwnershipKey(session.chatUid);
  const existing = flights.get(key);
  if (existing) return existing;
  const flight: BuildFlight = { session, cancelled: false, promise: Promise.resolve(), error: null };
  flights.set(key, flight);
  flight.promise = (async () => {
    while (!flight.cancelled && current(session)) {
      const job = currentBuildJob(session.repo.db, session.branchId);
      if (!job || job.status !== 'running') return;
      const before = buildProgressFingerprint(session.repo.db, session.branchId);
      sources = [...(materials.get(session) ?? sources)];
      const result = await batch(session, sources, 'next-window', () => !flight.cancelled, undefined, onSaved);
      if (!result.coreSaved) {
        flight.error = result.issues.map(issue => issue.code).join(',') || 'WORLD_BUILD_SAVE_NOT_ACKED';
        if (!flight.cancelled && current(session)) {
          const paused = await batch(session, sources, 'stop', undefined, flight.error);
          if (paused.coreSaved) onSaved?.();
        }
        return;
      }
      onSaved?.();
      if (flight.cancelled || !current(session)) return;
      const after = buildProgressFingerprint(session.repo.db, session.branchId);
      const next = currentBuildJob(session.repo.db, session.branchId);
      if (!next) return;
      if (next.status !== 'running') {
        const latestSources = [...(materials.get(session) ?? sources)];
        if (['completed', 'completed-with-issues'].includes(next.status) && next.sourceManifestHash !== buildSourceManifestHash(latestSources)) {
          const started = await batch(session, latestSources, 'start');
          if (started.coreSaved) { onSaved?.(); sources = latestSources; continue; }
        }
        return;
      }
      if (before === after) {
        await batch(session, sources, 'stop', undefined, 'WORLD_BUILD_NO_PROGRESS');
        onSaved?.();
        return;
      }
    }
  })().catch(async error => {
    flight.error = error instanceof Error ? error.message : 'WORLD_BUILD_FAILED';
    if (!flight.cancelled && current(session)) {
      try {
        const paused = await batch(session, sources, 'stop', undefined, error instanceof AtlasDbError ? error.code : 'WORLD_BUILD_FAILED');
        if (paused.coreSaved) onSaved?.();
        else flight.error += '; WORLD_BUILD_PAUSE_SAVE_FAILED';
      } catch { flight.error += '; WORLD_BUILD_PAUSE_SAVE_FAILED'; }
    }
  }).finally(async () => {
    if (flights.get(key) === flight) flights.delete(key);
    if (current(session)) onSaved?.();
    if (flight.resume && current(session)) {
      try { await startWorldBuildAfterTurn(session, materials.get(session) ?? sources, flight.resume.onSaved); }
      catch (error) {
        flight.error = error instanceof Error ? error.message : 'WORLD_BUILD_RESUME_FAILED';
        try { const paused = await batch(session, [...(materials.get(session) ?? sources)], 'stop', undefined, 'WORLD_BUILD_RESUME_FAILED'); if (paused.coreSaved) flight.resume.onSaved?.(); }
        catch { flight.error += '; WORLD_BUILD_PAUSE_SAVE_FAILED'; }
      }
    }
  });
  return flight;
}

export async function waitWorldBuildIdle(session: SqlSession): Promise<void> {
  const key=runnerOwnershipKey(session.chatUid);
  while(flights.has(key))await flights.get(key)?.promise;
}

export function hasActiveWorldBuild(session: SqlSession): boolean {
  const flight=flights.get(runnerOwnershipKey(session.chatUid));
  return Boolean(flight?.session===session&&!flight.cancelled);
}

export function hasWorldBuildOwnership(session: SqlSession): boolean {
  return flights.get(runnerOwnershipKey(session.chatUid))?.session === session;
}

export function suspendWorldBuildForForeground(session: SqlSession): void {
  const flight = flights.get(runnerOwnershipKey(session.chatUid));
  if (flight?.session === session) flight.cancelled = true;
}

export async function startWorldBuildAfterTurn(session: SqlSession, sources: readonly SourceSnapshotEntry[], onSaved?: () => void): Promise<void> {
  if (!current(session)) return;
  const job = currentBuildJob(session.repo.db, session.branchId);
  // Hosts that supply a full permission-checked source reader may initialize automatically after a saved floor.
  if (!job && !session.readWorldBuildSources) return;
  if (session.readWorldBuildSources) sources = await session.readWorldBuildSources();
  const entry = pendingWorldBuildEntries(session.repo.db, session.branchId).length > 0;
  if (!sources.some(source => source.kind === 'lorebook' && source.text.trim()) && !entry) return;
  if (job && ['completed', 'completed-with-issues'].includes(job.status) && job.sourceManifestHash === buildSourceManifestHash(sources) && !entry) return;
  rememberWorldBuildSources(session, sources);
  const existing = flights.get(runnerOwnershipKey(session.chatUid));
  if (existing) {
    existing.cancelled = true;
    existing.resume = { onSaved };
    return;
  }
  if (!current(session)) return;
  const result = await batch(session, [...sources], 'start');
  if (result.coreSaved) { onSaved?.(); launch(session, [...sources], onSaved); }
}

/** Only authenticated host routes call this controller; sources are data, never operations. */
export async function handleWorldBuildRequest(session: SqlSession, route: string, body: Record<string, unknown>, onSaved?: () => void): Promise<Record<string, unknown>> {
  const action = route === 'start' ? 'start' : route === 'batch' ? 'batch' : body['action'];
  const head = session.repo.internal.currentHeadTurnId();
  const normalized = normalizeControlRequest({ ...body, action, chatUid: session.chatUid, branchId: body['branchId'] ?? session.branchId,
    floorId: body['floorId'] ?? head, revision: body['revision'] ?? session.repo.internal.currentRevision(), storageRevision: body['storageRevision'] ?? session.repo.storageRevision });
  if (!normalized.ok) throw new AtlasDbError(normalized.code, normalized.message, {});
  const scope = normalized.scope;
  if (scope.branchId !== session.branchId || scope.floorId !== head || scope.revision !== session.repo.internal.currentRevision() || scope.storageRevision !== session.repo.storageRevision)
    throw new AtlasDbError('STALE_BASE', '控制请求所属楼层/分支/修订已变化', {});
  const job = currentBuildJob(session.repo.db, session.branchId);
  if (scope.jobId && scope.jobId !== job?.id) throw new AtlasDbError('WORLD_BUILD_JOB_STALE', '控制请求属于旧建设任务', {});
  const sources = sourcesFrom(body, session);
  if (!sources.length && scope.action !== 'stop') throw new AtlasDbError('WORLD_BUILD_SOURCES_REQUIRED', '需要当前允许读取的来源快照；下次合法世界更新会重新读取', {});
  const key = runnerOwnershipKey(session.chatUid);
  const running = flights.get(key);
  if (scope.action === 'start' && job && ['completed', 'completed-with-issues'].includes(job.status) && job.sourceManifestHash === buildSourceManifestHash(sources) && !pendingWorldBuildEntries(session.repo.db, session.branchId).length)
    return { coreSaved: true, duplicate: true, job, running: false };
  if (scope.action === 'stop') {
    if (running) running.cancelled = true;
    if (job?.status === 'paused' && job.stopReason === 'stopped') return { coreSaved: true, duplicate: true, job, running: false };
    const result = await batch(session, sources, 'stop');
    if (result.coreSaved) onSaved?.();
    return { coreSaved: result.coreSaved, job: currentBuildJob(session.repo.db, session.branchId), running: false, issues: result.issues };
  }
  if (running) {
    if (scope.action === 'start') return { coreSaved: true, duplicate: true, job, running: true };
    throw new AtlasDbError('WORLD_BUILD_BUSY', '同一聊天已有建设窗口在运行', {});
  }
  const result = await batch(session, sources, scope.action, undefined, undefined, onSaved);
  if (result.coreSaved) onSaved?.();
  const flight = result.coreSaved && body['autoContinue'] !== false && scope.action !== 'batch' ? launch(session, sources, onSaved) : null;
  if (body['wait'] === true) await flight?.promise;
  return { coreSaved: result.coreSaved, job: currentBuildJob(session.repo.db, session.branchId), running: flights.has(key), issues: result.issues, receipt: result.receipt,
    ...(flight?.error ? { error: flight.error } : {}) };
}
