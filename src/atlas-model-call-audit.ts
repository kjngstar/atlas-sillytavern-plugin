/** Compact, turn-local transport journal. No prompts, responses or credentials. */
import { atlasRefFingerprint, isAtlasRefFingerprint, sanitizeDiagnostic, type AtlasDiagnosticInput } from './atlas-diagnostics.ts';
import { ATLAS_RUNTIME_LIMITS } from './atlas-runtime-limits.ts';
import { transportMetricsFromDetails } from './atlas-response-metrics.ts';
import type { ModelWorkClass } from './atlas-work-batching.ts';

export { MODEL_CALL_REASONS } from './atlas-work-batching.ts';
import { MODEL_CALL_REASONS, type ModelCallReason } from './atlas-work-batching.ts';
const CLASSES = ['observe', 'construction', 'evidence', 'maps', 'characters', 'outcomes'] as const;
const STATUSES = ['sent', 'completed', 'failed', 'compatibility_retry'] as const;
export type ModelCallRecord = {
  sequence: number;
  batchRef: string;
  stage: string;
  workClass: ModelWorkClass;
  reason: ModelCallReason;
  status: (typeof STATUSES)[number];
  retryOfBatchRef?: string;
  targetCount?: number;
  targetRefs?: string[];
  targetRefsDropped?: number;
  requestRef?: string;
  transportAttempt?: number;
  startedAt?: string;
  logicalDurationMs?: number;
  httpStatus?: number;
  errorCode?: string;
  finishReason?: string;
  promptChars?: number;
  /** 旧口径：原始传输正文长度（含 JSON / SSE 包装）。**保留原语义，不改**。 */
  responseChars?: number;
  /** P14 §20.3：与 responseChars 同值的显式命名，供新读取方按口径取值。 */
  rawResponseChars?: number;
  /** P14 §20.3：助手可见正文字符数；响应无正文载体时为 null（未知 ≠ 0）。 */
  visibleTextChars?: number | null;
  /** P14 §20.3：推理字段字符数；响应无明确推理字段时为 null，**绝不由差值推断**。 */
  reasoningTextChars?: number | null;
  /** P14 §20.3：观测到响应头的耗时。 */
  headersMs?: number;
  /** P14 §20.3：正文接收耗时。 */
  bodyMs?: number;
  /** P14 §20.3：true = 本次 logicalDurationMs 覆盖了兼容重发的第二次 fetch，不可当单次累加。 */
  durationIncludesCompatibilityRetry?: boolean;
  modelRef?: string;
};
export type ModelCallAudit = {
  version: 1;
  transports: number;
  byWorkClass: Partial<Record<ModelWorkClass, number>>;
  calls: ModelCallRecord[];
  droppedCalls: number;
};
export type ModelCallMetadata = {
  kind?: ModelWorkClass;
  retry?: boolean;
  cause?: ModelCallReason;
  retryOf?: string;
  targetCount?: number;
  targetIds?: readonly string[];
};
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const ref = (value: unknown) => isAtlasRefFingerprint(value) ? value : undefined;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function modelWorkClass(stage: string, kind?: ModelWorkClass): ModelWorkClass {
  return kind ?? (stage === 'decision' ? 'characters' : stage === 'outcome' ? 'outcomes' : stage === 'geography' ? 'construction' : 'observe');
}

/** Stored snapshots and imported saves are projected through the same allowlist. */
export function sanitizeModelCallAudit(value: unknown): ModelCallAudit | null {
  const raw = object(value);
  if (raw.version !== 1 || !integer(raw.transports) || !Array.isArray(raw.calls)) return null;
  const calls: ModelCallRecord[] = [];
  for (const entry of raw.calls.slice(-ATLAS_RUNTIME_LIMITS.modelCallAuditLimit)) {
    const row = object(entry);
    if (!integer(row.sequence) || !ref(row.batchRef) || !CLASSES.includes(row.workClass as ModelWorkClass)
      || !MODEL_CALL_REASONS.includes(row.reason as ModelCallReason) || !STATUSES.includes(row.status as ModelCallRecord['status'])) continue;
    const call: ModelCallRecord = { sequence: row.sequence, batchRef: String(row.batchRef),
      stage: typeof row.stage === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(row.stage) ? row.stage : 'unknown',
      workClass: row.workClass as ModelWorkClass, reason: row.reason as ModelCallReason, status: row.status as ModelCallRecord['status'] };
    for (const key of ['retryOfBatchRef', 'requestRef', 'modelRef'] as const) if (ref(row[key])) call[key] = String(row[key]);
    for (const key of ['targetCount', 'targetRefsDropped', 'transportAttempt', 'logicalDurationMs', 'httpStatus', 'promptChars', 'responseChars', 'rawResponseChars', 'headersMs', 'bodyMs'] as const) if (integer(row[key])) call[key] = row[key] as number;
    // P14 §20.3：可见/推理长度允许显式 null（＝探测过、无该字段），其余只收非负整数。
    for (const key of ['visibleTextChars', 'reasoningTextChars'] as const) {
      if (row[key] === null) call[key] = null;
      else if (integer(row[key])) call[key] = row[key] as number;
    }
    if (row.durationIncludesCompatibilityRetry === true) call.durationIncludesCompatibilityRetry = true;
    if (Array.isArray(row.targetRefs)) call.targetRefs = row.targetRefs.filter(isAtlasRefFingerprint).slice(0, 128);
    if (typeof row.startedAt === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(row.startedAt) && Number.isFinite(Date.parse(row.startedAt))) call.startedAt = row.startedAt;
    if (typeof row.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(row.errorCode)) call.errorCode = row.errorCode;
    if (typeof row.finishReason === 'string') {
      const safe = sanitizeDiagnostic({ level: 'info', source: 'model', code: 'MODEL_REQUEST_COMPLETED', operation: 'generation', phase: 'response', outcome: 'success', details: { finishReason: row.finishReason } });
      if (typeof safe?.details?.finishReason === 'string') call.finishReason = safe.details.finishReason;
    }
    calls.push(call);
  }
  const byWorkClass: ModelCallAudit['byWorkClass'] = {};
  for (const kind of CLASSES) if (integer(object(raw.byWorkClass)[kind])) byWorkClass[kind] = object(raw.byWorkClass)[kind] as number;
  return { version: 1, transports: raw.transports, calls, byWorkClass, droppedCalls: Math.max(integer(raw.droppedCalls) ? raw.droppedCalls : 0, raw.transports - calls.length) };
}

export function createModelCallAudit(initial?: ModelCallAudit | null) {
  const journal: ModelCallAudit = sanitizeModelCallAudit(initial) ?? { version: 1, transports: 0, byWorkClass: {}, calls: [], droppedCalls: 0 };
  return {
    sent(stage: string, batchId: string, metadata: ModelCallMetadata = {}) {
      const kind = modelWorkClass(stage, metadata.kind);
      journal.transports++;
      journal.byWorkClass[kind] = (journal.byWorkClass[kind] ?? 0) + 1;
      const call: ModelCallRecord = { sequence: journal.transports, batchRef: atlasRefFingerprint(batchId), stage, workClass: kind,
        reason: metadata.cause ?? (metadata.retry ? 'retry_unspecified' : 'scheduled'), status: 'sent' };
      if (metadata.retryOf) call.retryOfBatchRef = atlasRefFingerprint(metadata.retryOf);
      if (integer(metadata.targetCount)) call.targetCount = metadata.targetCount;
      else if (metadata.targetIds) call.targetCount = metadata.targetIds.length;
      if (metadata.targetIds && metadata.targetIds.length > 128) call.targetRefsDropped = metadata.targetIds.length - 128;
      if (metadata.targetIds) call.targetRefs = metadata.targetIds.slice(0, 128).map(atlasRefFingerprint);
      journal.calls.push(call);
      if (journal.calls.length > ATLAS_RUNTIME_LIMITS.modelCallAuditLimit) { journal.calls.shift(); journal.droppedCalls++; }
    },
    observe(event: AtlasDiagnosticInput) {
      // Diagnostics enrich a claimed send; preparation/budget failures cannot invent one.
      const safe = sanitizeDiagnostic(event);
      if (!safe || !['MODEL_REQUEST_STARTED', 'MODEL_RESPONSE_HEADERS', 'MODEL_REQUEST_COMPLETED', 'MODEL_REQUEST_FAILED'].includes(safe.code)) return;
      const details = safe.details ?? {};
      const call = [...journal.calls].reverse().find(row => row.batchRef === details.batchRef);
      if (!call || details.transportAttempt === 0) return;
      if (safe.requestRef) call.requestRef = safe.requestRef;
      if (integer(details.transportAttempt)) call.transportAttempt = details.transportAttempt;
      if (safe.code === 'MODEL_REQUEST_STARTED') {
        call.startedAt = safe.at;
        if (details.retryKind === 'compatibility') {
          call.reason = 'transport_retry';
          const previous = journal.calls[journal.calls.indexOf(call) - 1];
          if (previous?.batchRef === call.batchRef) previous.status = 'compatibility_retry';
        }
      }
      if (integer(safe.httpStatus)) call.httpStatus = safe.httpStatus;
      if (typeof details.modelRef === 'string') call.modelRef = details.modelRef;
      if (integer(details.promptChars)) call.promptChars = details.promptChars;
      if (integer(details.responseChars)) call.responseChars = details.responseChars;
      // P14 §20.3：长度三口径与分段耗时进审计记录。缺字段＝未知，不写 0。
      const { metrics, timing } = transportMetricsFromDetails(details);
      Object.assign(call, metrics, timing);
      if (typeof details.finishReason === 'string') call.finishReason = details.finishReason;
      if (safe.code === 'MODEL_REQUEST_COMPLETED' || safe.code === 'MODEL_REQUEST_FAILED') {
        call.status = safe.code === 'MODEL_REQUEST_COMPLETED' ? 'completed' : 'failed';
        if (integer(safe.durationMs)) call.logicalDurationMs = safe.durationMs;
        if (safe.errorCode) call.errorCode = safe.errorCode;
      }
    },
    finish(batchId: string, status: 'completed' | 'failed') {
      const call = [...journal.calls].reverse().find(row => row.batchRef === atlasRefFingerprint(batchId));
      if (call && call.status === 'sent') call.status = status;
    },
    snapshot(): ModelCallAudit { return structuredClone(journal); },
  };
}
