/** Request-local diagnostic evidence. Observers never participate in business success/failure. */
import { atlasRefFingerprint, type AtlasDiagnosticInput } from './atlas-diagnostics.ts';

export type DiagnosticObserver = (event: AtlasDiagnosticInput) => unknown;
export type DiagnosticContext = Pick<AtlasDiagnosticInput, 'chatFingerprint' | 'requestRef' | 'details'>;
const signalContexts = new WeakMap<AbortSignal, DiagnosticContext>();
export function setDiagnosticSignalContext(signal: AbortSignal, context: DiagnosticContext): void {
  signalContexts.set(signal, { ...context, details: { ...context.details } });
}
export function diagnosticSignalContext(signal?: AbortSignal | null): DiagnosticContext {
  return signal ? signalContexts.get(signal) ?? {} : {};
}
let sequence = 0;
export function newDiagnosticRequestRef(): string {
  return atlasRefFingerprint(`${Date.now()}:${++sequence}:${Math.random()}`);
}
export function atlasDiagnosticContext(value: Record<string, unknown> = {}): DiagnosticContext {
  const chat = String(value.chatUid ?? value.chatId ?? '');
  const branch = String(value.branchId ?? 'main');
  const floor = value.hostMessageUid ?? value.assistantMessageId ?? value.messageId;
  const details: NonNullable<AtlasDiagnosticInput['details']> = {};
  if (chat) details.branchRef = atlasRefFingerprint(JSON.stringify([chat, branch]));
  if (chat && floor) details.turnRef = atlasRefFingerprint(JSON.stringify([chat, branch, String(floor), String(value.variantKey || value.swipeId || 'original')]));
  if (value.mapId) details.mapRef = atlasRefFingerprint(String(value.mapId));
  if (typeof value.baseRevision === 'number') details.baseRevision = value.baseRevision;
  if (typeof value.baseStorageRevision === 'number') details.storageRevision = value.baseStorageRevision;
  return { ...(chat ? { chatFingerprint: atlasRefFingerprint(chat) } : {}), details };
}
export function observeDiagnostic(emit: DiagnosticObserver | undefined, event: AtlasDiagnosticInput): void {
  try { emit?.(event); } catch { /* Logging must not fail, retry or roll back a turn. */ }
}
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)) : [];
}
export function diagnosticIssues(...values: unknown[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  return values.flatMap(records).filter(issue => {
    const key = JSON.stringify([issue.code, issue.path ?? issue.schemaPath, issue.line, issue.opId, issue.groupId, issue.mapId]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
export function emitAtlasIssueDiagnostics(emit: DiagnosticObserver, base: AtlasDiagnosticInput, values: unknown): void {
  const issues = diagnosticIssues(values);
  issues.forEach((issue, index) => {
    const path = typeof issue.path === 'string' ? issue.path : typeof issue.schemaPath === 'string' ? issue.schemaPath : '';
    // A dynamic map key becomes a wildcard path plus a separate hashed map reference.
    const mapKey = /^\$\.maps\.([^.\[\]]+)/.exec(path)?.[1];
    const mapId = issue.mapId ?? mapKey;
    const schemaPath = mapKey ? path.replace(`$.maps.${mapKey}`, '$.maps[*]') : path;
    observeDiagnostic(emit, { ...base, level: issue.severity === 'warning' ? 'warn' : 'error',
      code: 'REQUEST_ISSUE', phase: 'validation', outcome: 'failed',
      errorCode: typeof issue.code === 'string' ? issue.code : 'UNEXPECTED_ERROR', retryable: issue.retryable === true,
      details: { ...base.details, issueCount: issues.length, issueIndex: index + 1,
        ...(schemaPath ? { schemaPath, pathRef: atlasRefFingerprint(path) } : {}),
        ...(mapId ? { mapRef: atlasRefFingerprint(String(mapId)) } : {}),
        ...(issue.opId ? { operationRef: atlasRefFingerprint(String(issue.opId)) } : {}),
        ...(typeof issue.line === 'number' ? { rowLine: issue.line } : {}) } });
  });
}

/** Used by the real host API wrapper; captures identity before awaiting a response. */
export function createAtlasApiDiagnosticLogger(options: {
  emit: DiagnosticObserver;
  context?: () => Record<string, unknown>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  return async function logCall<T>(method: string, path: string, run: () => Promise<T>, payload?: Record<string, unknown>): Promise<T> {
    let liveContext: Record<string, unknown> = {};
    try { liveContext = options.context?.() ?? {}; } catch { /* Context lookup is optional diagnostic evidence. */ }
    const captured = atlasDiagnosticContext({ ...liveContext, ...payload });
    const polling = method === 'GET' || ['/sql/chat/state', '/sql/chat/ui-read', '/sql/upgrade-backup'].includes(path);
    const requestRef = polling ? undefined : newDiagnosticRequestRef();
    const startedAt = now();
    const base: AtlasDiagnosticInput = { ...captured, requestRef, level: 'info', source: 'engine',
      code: 'API_CALL_STARTED', operation: 'api', phase: 'request', outcome: 'started',
      details: { ...captured.details, route: path, method, module: 'atlas-request-diagnostics', function: 'logCall' } };
    if (!polling) observeDiagnostic(options.emit, base);
    try {
      const result = await run();
      const response = result as { status?: number; body?: { ok?: boolean; data?: Record<string, unknown>; error?: { code?: string; details?: Record<string, unknown> } } };
      const data = response.body?.data ?? {};
      const error = response.body?.error;
      const native = (data.nativeReceipt ?? data.receipt ?? error?.details?.receipt) as Record<string, unknown> | undefined;
      const anchor = native?.anchor as Record<string, unknown> | undefined;
      const scoped = anchor ? atlasDiagnosticContext(anchor) : captured;
      const issues = diagnosticIssues(data.issues, native?.issues, error?.details?.issues);
      const groups = records(native?.groups);
      const failed = response.body?.ok === false || native?.status === 'failed' || (response.status ?? 0) >= 400;
      const partial = native?.status === 'partial';
      const duplicate = native?.status === 'duplicate';
      const cause = issues.find(issue => issue.severity !== 'warning' && issue.code !== 'TURN_FAILED')?.code;
      const plan = native?.requestPlan as { usage?: { transports?: number } } | undefined;
      const event: AtlasDiagnosticInput = { ...base, ...scoped,
        level: failed ? 'error' : partial ? 'warn' : 'info',
        code: failed ? 'API_CALL_FAILED' : partial ? 'API_CALL_PARTIAL' : duplicate ? 'TURN_DUPLICATE' : 'API_CALL_COMPLETE',
        phase: 'response', outcome: failed || partial ? 'failed' : duplicate ? 'skipped' : 'success',
        httpStatus: response.status, errorCode: error?.code, causeCode: typeof cause === 'string' ? cause : undefined,
        durationMs: now() - startedAt,
        details: { ...base.details, ...scoped.details, issueCount: issues.length,
          ...(typeof native?.status === 'string' ? { receiptStatus: native.status } : {}),
          ...(typeof data.coreSaved === 'boolean' ? { coreSaved: data.coreSaved, saveConfirmed: data.coreSaved } : {}),
          ...(typeof data.sceneSaved === 'boolean' ? { sceneSaved: data.sceneSaved } : {}),
          ...(typeof data.revision === 'number' ? { revision: data.revision } : {}),
          ...(groups.length ? { groupCount: groups.length, changedRows: groups.reduce((n, g) => n + (typeof g.changedRows === 'number' ? g.changedRows : 0), 0),
            rejectedGroups: groups.filter(g => g.status === 'rejected' || g.status === 'blocked').length } : {}),
          ...(typeof plan?.usage?.transports === 'number' ? { modelRequests: plan.usage.transports } : {}) } };
      observeDiagnostic(options.emit, event);
      emitAtlasIssueDiagnostics(options.emit, event, issues);
      return result;
    } catch (error) {
      const thrown = error as { code?: string; name?: string };
      observeDiagnostic(options.emit, { ...base, level: 'error', code: 'API_DISPATCH_EXCEPTION', outcome: 'failed',
        errorCode: thrown?.code, durationMs: now() - startedAt,
        details: { ...base.details, failureStage: 'request', errorName: thrown?.name ?? 'Error' } });
      throw error;
    }
  };
}
