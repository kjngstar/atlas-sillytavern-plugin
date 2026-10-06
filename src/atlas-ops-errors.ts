/**
 * atlas-ops-errors.ts — C10 / §16.3 / §18.4：统一错误码、Issue 映射与脱敏。
 *
 * 设计要点：
 * - `Issue` 形状固定来自 atlas-ops-contract.ts，任何模块都不再自造错误对象。
 * - SQL / 语法 / 业务错误一律经 `toIssue` 收敛，(code, path, message, severity, retryable) 齐全，
 *   并按 §18.4 保留 line / opId / groupId / dependencyId 供诊断跳转。
 * - §16.8：诊断 message 绝不复制 Authorization / API key；`toIssue` 出站前强制过一遍 `redactSecrets`。
 * - 本模块没有任何 import 期副作用。
 */

import type { Issue } from './atlas-ops-contract.ts';

/** 规格中出现的固定错误码（§8.3 / §8.5 / §16.2 / §18.4）。 */
export const ATLAS_ERROR_CODES = Object.freeze({
  JSON_SYNTAX: 'JSON_SYNTAX',
  WRAPPER_INCOMPLETE: 'WRAPPER_INCOMPLETE',
  UNTERMINATED_REASONING: 'UNTERMINATED_REASONING',
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  UNSUPPORTED_RESPONSE_FORMAT: 'UNSUPPORTED_RESPONSE_FORMAT',
  RESPONSE_TOO_LARGE: 'RESPONSE_TOO_LARGE',
  TOO_MANY_OPERATIONS: 'TOO_MANY_OPERATIONS',
  OPERATION_TOO_LARGE: 'OPERATION_TOO_LARGE',
  JSON_TOO_DEEP: 'JSON_TOO_DEEP',
  UNKNOWN_OPERATION: 'UNKNOWN_OPERATION',
  MINIMUM_FIELD_MISSING: 'MINIMUM_FIELD_MISSING',
  FIELD_IGNORED: 'FIELD_IGNORED',
  SYSTEM_FIELD_IGNORED: 'SYSTEM_FIELD_IGNORED',
  REF_UNKNOWN: 'REF_UNKNOWN',
  REF_AMBIGUOUS: 'REF_AMBIGUOUS',
  SOURCE_UNKNOWN: 'SOURCE_UNKNOWN',
  DEPENDENCY_FAILED: 'DEPENDENCY_FAILED',
  SQL_CONSTRAINT: 'SQL_CONSTRAINT',
  INVARIANT_FAILED: 'INVARIANT_FAILED',
  SESSION_STALE: 'SESSION_STALE',
  STALE_BASE: 'STALE_BASE',
  CHAT_CHANGED: 'CHAT_CHANGED',
  SESSION_WRITE_FAILED: 'SESSION_WRITE_FAILED',
  HOST_SAVE_UNAVAILABLE: 'HOST_SAVE_UNAVAILABLE',
  HOST_SAVE_UNCONFIRMED: 'HOST_SAVE_UNCONFIRMED',
  MODEL_TIMEOUT: 'MODEL_TIMEOUT',
  HTTP_ERROR: 'HTTP_ERROR',
  REPAIR_SCOPE_VIOLATION: 'REPAIR_SCOPE_VIOLATION',
  RETRY_BASE_CHANGED: 'RETRY_BASE_CHANGED',
  REPLAY_REQUIRED: 'REPLAY_REQUIRED',
  WORLD_SYNC_FAILED: 'WORLD_SYNC_FAILED',
  DB_WASM_LOAD_FAILED: 'DB_WASM_LOAD_FAILED',
  DB_SCHEMA_UNSUPPORTED: 'DB_SCHEMA_UNSUPPORTED',
  MENTION_TRACKED: 'MENTION_TRACKED',
  CONDITION_UNCOMPILED: 'CONDITION_UNCOMPILED',
  TIME_UNRESOLVED: 'TIME_UNRESOLVED',
  // M2：同一张图上的布局请求互相矛盾（mapId 不一致、kind 冲突、同批同 id 不同值、父图/子图混用）。
  LAYOUT_REQUEST_CONFLICT: 'LAYOUT_REQUEST_CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const);

export type AtlasErrorCode = (typeof ATLAS_ERROR_CODES)[keyof typeof ATLAS_ERROR_CODES];

/** `toIssue` 的定位上下文：全部可选，调用者只填手上确有的信息。 */
export type IssueWhere = {
  opId?: string;
  groupId?: string;
  line?: number;
  path?: string;
  code?: string;
  dependencyId?: string;
  severity?: 'warning' | 'error';
  retryable?: boolean;
  message?: string;
};

/**
 * §16.8：脱敏。三类目标全部替换为 `[redacted]`：
 * 1. `sk-...` 形式的 API key（含 `sk-proj-...`）；
 * 2. `Bearer <token>` / `Authorization` 头值；
 * 3. 32 位以上的 hex / base64 风格密钥串，以及 `api_key=...` 之类的显式键值。
 */
const SECRET_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{4,}/gi, '[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, '[redacted]'],
  [
    /\b(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key|authorization)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{8,}["']?/gi,
    '[redacted]',
  ],
  [/\b[A-Fa-f0-9]{32,}\b/g, '[redacted]'],
  [/[A-Za-z0-9+/]{32,}={0,2}/g, '[redacted]'],
];

export function redactSecrets(text: string): string {
  if (typeof text !== 'string') return String(text ?? '');
  let out = text;
  for (const [pattern, replacement] of SECRET_RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** 带 Issue 的错误：抛出后由调用者用 `toIssue` 还原成固定形状。 */
export class AtlasIssueError extends Error {
  readonly issue: Issue;
  /** 与 `issue.code` 一致，便于 `catch (e) { e.code }` 的常规写法。 */
  readonly code: string;

  constructor(issue: Issue) {
    super(redactSecrets(issue.message));
    this.name = 'AtlasIssueError';
    this.issue = { ...issue, message: redactSecrets(issue.message) };
    this.code = this.issue.code;
  }
}

/** 由 Issue 数据直接抛出；`severity` 默认 error，`retryable` 默认 false。 */
export function failIssue(
  issue: Omit<Issue, 'severity' | 'retryable'> & Partial<Pick<Issue, 'severity' | 'retryable'>>,
): never {
  throw new AtlasIssueError({
    ...issue,
    severity: issue.severity ?? 'error',
    retryable: issue.retryable ?? false,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeText(error: unknown): string {
  if (typeof error === 'string') return error;
  const rec = asRecord(error);
  const message = rec ? str(rec['message']) : undefined;
  if (message !== undefined) return message;
  try {
    return String(error);
  } catch {
    return '';
  }
}

/**
 * 把任意抛出物（Error / SQL 错误 / 带 `issue` 的 AtlasIssueError / 字符串）收敛成 Issue。
 *
 * 取值优先级：
 * - `code`：错误对象自带的 `.code` > `where.code` > 内嵌 issue.code > `INTERNAL_ERROR`；
 * - `message`：`where.message` > 错误自身 message > 内嵌 issue.message > `code` 占位；
 * - `path/line/opId/groupId/dependencyId`：`where` 显式提供的优先，其次错误对象自带；
 * - `severity`：`where` > 错误自带 > 内嵌 issue > `error`；`retryable` 默认 false。
 *
 * 返回前 message 一定过 `redactSecrets`，绝不会把 API key 写进诊断。
 */
export function toIssue(error: unknown, where: IssueWhere = {}): Issue {
  const rec = asRecord(error);
  const embedded = rec ? asRecord(rec['issue']) : null;
  const hasEmbedded =
    embedded !== null && typeof embedded['code'] === 'string' && typeof embedded['message'] === 'string';

  const errorCode = rec ? str(rec['code']) : undefined;
  const code =
    (errorCode !== undefined && errorCode !== '' ? errorCode : undefined) ??
    (where.code !== undefined && where.code !== '' ? where.code : undefined) ??
    (hasEmbedded ? str(embedded['code']) : undefined) ??
    ATLAS_ERROR_CODES.INTERNAL_ERROR;

  let message = where.message ?? (rec ? str(rec['message']) : undefined);
  if (message === undefined && hasEmbedded) message = str(embedded['message']);
  if (message === undefined) message = safeText(error);
  if (message.trim() === '') message = `atlas error: ${code}`;

  const path =
    where.path ??
    (rec ? str(rec['path']) : undefined) ??
    (hasEmbedded ? str(embedded['path']) : undefined) ??
    '$';

  const line =
    where.line ?? (rec ? num(rec['line']) : undefined) ?? (hasEmbedded ? num(embedded['line']) : undefined);

  const opId =
    where.opId ??
    (rec ? str(rec['opId']) : undefined) ??
    (hasEmbedded ? str(embedded['opId']) : undefined);

  const groupId =
    where.groupId ??
    (rec ? str(rec['groupId']) : undefined) ??
    (hasEmbedded ? str(embedded['groupId']) : undefined);

  const dependencyId =
    where.dependencyId ??
    (rec ? str(rec['dependencyId']) : undefined) ??
    (hasEmbedded ? str(embedded['dependencyId']) : undefined);

  const severity =
    where.severity ??
    (rec?.['severity'] === 'warning' || rec?.['severity'] === 'error'
      ? (rec['severity'] as 'warning' | 'error')
      : undefined) ??
    (hasEmbedded ? (embedded['severity'] === 'warning' ? 'warning' : 'error') : undefined) ??
    'error';

  const retryable =
    where.retryable ??
    (typeof rec?.['retryable'] === 'boolean' ? (rec['retryable'] as boolean) : undefined) ??
    (hasEmbedded && typeof embedded['retryable'] === 'boolean' ? (embedded['retryable'] as boolean) : undefined) ??
    false;

  const issue: Issue = {
    code,
    path,
    message: redactSecrets(message),
    severity,
    retryable,
  };
  if (line !== undefined) issue.line = line;
  if (opId !== undefined) issue.opId = opId;
  if (groupId !== undefined) issue.groupId = groupId;
  if (dependencyId !== undefined) issue.dependencyId = dependencyId;
  return issue;
}
