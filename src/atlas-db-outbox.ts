/**
 * atlas-db-outbox.ts — G12–G14 世界书同步任务（§6.6 / §7.3）。
 *
 * 规则：
 * - 在保存候选中登记 revision 专属同步意图，**不是 SQL 提交前直接写世界书**。
 * - 保存确认后串行同步；过期版本取消/重建；结果走 prepareMaintenance。
 * - 只管理 Atlas 专属 chat/branch 条目，不覆盖用户原有世界书。
 * - outbox 不复制世界正文：发送时从对应的有效版本构造投影。
 */

import { queryBound, runBound } from './atlas-db-runtime.ts';
import { decodeRow } from './atlas-db-codec.ts';
import { createRow } from './atlas-db-defaults.ts';
import { sha256HexSync } from './atlas-db-envelope.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { Issue } from './atlas-ops-contract.ts';

export type OutboxStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'superseded';

export type OutboxRow = {
  id: string;
  branch_id: string;
  requested_by_turn_id: string | null;
  target: 'managed_lorebook';
  projection_scope: 'pov' | 'scene_portrayal';
  target_revision: number;
  idempotency_key: string;
  payload_hash: string;
  status: OutboxStatus;
  attempt_count: number;
  next_retry_wall_ms: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_wall_ms: number;
  completed_wall_ms: number | null;
};

function decodeOutboxRows(db: SqlDatabase, sql: string, params: Array<string | number | null>): OutboxRow[] {
  return queryBound(db, sql, params).map((raw) => {
    const decoded = decodeRow('sync_outbox', raw, { allowExtra: true });
    return (decoded.ok ? decoded.row : raw) as unknown as OutboxRow;
  });
}

export function listOutbox(db: SqlDatabase, branchId: string, statuses?: OutboxStatus[]): OutboxRow[] {
  if (statuses && statuses.length > 0) {
    const placeholders = statuses.map(() => '?').join(',');
    return decodeOutboxRows(db, `SELECT * FROM sync_outbox WHERE branch_id = ? AND status IN (${placeholders}) ORDER BY created_wall_ms`, [
      branchId,
      ...statuses,
    ]);
  }
  return decodeOutboxRows(db, 'SELECT * FROM sync_outbox WHERE branch_id = ? ORDER BY created_wall_ms', [branchId]);
}

/**
 * G12 enqueueProjectionSync：在候选库中登记同步意图（幂等键唯一）。
 * 完成定义：不是 SQL 提交前直接写世界书。
 */
export function enqueueProjectionSync(
  db: SqlDatabase,
  input: {
    branchId: string;
    turnId: string | null;
    targetRevision: number;
    projectionScope: 'pov' | 'scene_portrayal';
    payloadHash: string;
    nowWallMs: number;
    makeId: (key: string) => string;
  },
): { enqueued: boolean; taskId: string; superseded: string[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const idempotencyKey = `${input.branchId}:${input.projectionScope}:${input.targetRevision}:${input.payloadHash}`;
  const existing = queryBound(db, 'SELECT id, status FROM sync_outbox WHERE idempotency_key = ? LIMIT 1', [idempotencyKey]);
  if (existing.length > 0) {
    return { enqueued: false, taskId: String(existing[0].id), superseded: [], issues };
  }

  // 旧 revision 任务取消/重建：标记 superseded（不删除，保留诊断）。
  const stale = queryBound(
    db,
    `SELECT id FROM sync_outbox WHERE branch_id = ? AND status IN ('pending','running','failed') AND target_revision < ?`,
    [input.branchId, input.targetRevision],
  );
  const superseded: string[] = [];
  for (const row of stale) {
    const id = String(row.id);
    runBound(db, `UPDATE sync_outbox SET status = 'superseded', completed_wall_ms = ? WHERE id = ?`, [input.nowWallMs, id]);
    superseded.push(id);
  }

  const taskId = input.makeId(idempotencyKey);
  runBound(
    db,
    `INSERT INTO sync_outbox (id, branch_id, requested_by_turn_id, target, projection_scope, target_revision, idempotency_key, payload_hash, status, attempt_count, created_wall_ms)
     VALUES (?, ?, ?, 'managed_lorebook', ?, ?, ?, ?, 'pending', 0, ?)`,
    [taskId, input.branchId, input.turnId, input.projectionScope, input.targetRevision, idempotencyKey, input.payloadHash, input.nowWallMs],
  );
  return { enqueued: true, taskId, superseded, issues };
}

/** 计算规范化投影内容哈希（不复制正文）。 */
export function projectionHash(payload: unknown): string {
  return sha256HexSync(stableStringify(payload));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export type ManagedLorebookEntry = {
  /** 只管理 Atlas 专属条目：key 必须带 chat/branch 身份。 */
  key: string;
  chatUid: string;
  branchId: string;
  scope: 'pov' | 'scene_portrayal';
  revision: number;
  content: string;
};

export type LorebookPort = {
  listKeys(): Promise<string[]>;
  read(key: string): Promise<string | null>;
  write(entries: ManagedLorebookEntry[]): Promise<void>;
  remove(keys: string[]): Promise<void>;
};

export type SyncOutcome = {
  taskId: string;
  status: 'succeeded' | 'failed';
  errorCode?: string;
  errorMessage?: string;
  nextRetryWallMs?: number;
  attemptCount: number;
  issues: Issue[];
};

/**
 * G13 runNextSync：保存确认后串行同步；过期版本取消/重建。
 * 完成定义：同步失败不丢核心回合；保存同步结果不生成无限新任务。
 */
export async function runNextSync(
  db: SqlDatabase,
  port: LorebookPort,
  input: { branchId: string; chatUid: string; nowWallMs: number; buildProjection: (scope: 'pov' | 'scene_portrayal', revision: number) => ManagedLorebookEntry[] },
): Promise<SyncOutcome | null> {
  const pending = listOutbox(db, input.branchId, ['pending', 'failed']).filter(
    (t) => t.next_retry_wall_ms === null || t.next_retry_wall_ms <= input.nowWallMs,
  );
  if (pending.length === 0) return null;
  const task = pending[0];

  runBound(db, `UPDATE sync_outbox SET status = 'running', attempt_count = attempt_count + 1 WHERE id = ?`, [task.id]);
  const attemptCount = task.attempt_count + 1;

  try {
    const entries = input.buildProjection(task.projection_scope, task.target_revision);
    // 只管理带 chat/branch 身份的 Atlas 条目；不覆盖用户原有世界书。
    const managed = entries.filter((e) => e.key.startsWith(`atlas:${input.chatUid}:${input.branchId}:`));
    if (managed.length !== entries.length) {
      throw new Error('WORLD_SYNC_SCOPE_VIOLATION: 投影里含非 Atlas 专属条目');
    }
    await port.write(managed);
    runBound(db, `UPDATE sync_outbox SET status = 'succeeded', completed_wall_ms = ? WHERE id = ?`, [input.nowWallMs, task.id]);
    return { taskId: task.id, status: 'succeeded', attemptCount, issues: [] };
  } catch (err) {
    const message = (err as Error).message;
    const code = message.startsWith('WORLD_SYNC_SCOPE_VIOLATION') ? 'WORLD_SYNC_FAILED' : 'WORLD_SYNC_FAILED';
    const backoff = Math.min(60_000, 1000 * 2 ** Math.min(6, attemptCount));
    runBound(
      db,
      `UPDATE sync_outbox SET status = 'failed', last_error_code = ?, last_error_message = ?, next_retry_wall_ms = ? WHERE id = ?`,
      [code, message.slice(0, 300), input.nowWallMs + backoff, task.id],
    );
    return {
      taskId: task.id,
      status: 'failed',
      errorCode: code,
      errorMessage: message.slice(0, 300),
      nextRetryWallMs: input.nowWallMs + backoff,
      attemptCount,
      issues: [
        {
          code: 'WORLD_SYNC_FAILED',
          path: '$.sync_outbox',
          message: `世界书同步失败（核心数据已保存）：${message.slice(0, 200)}`,
          severity: 'error',
          retryable: true,
        },
      ],
    };
  }
}

/**
 * G14 rebuildManagedLorebook：只管理 Atlas 专属 chat/branch 条目。
 * 回退后重建有效投影；旧同步任务不得把另一聊天或旧分支内容写进来。
 */
export async function rebuildManagedLorebook(
  port: LorebookPort,
  input: {
    chatUid: string;
    branchId: string;
    revision: number;
    buildProjection: () => ManagedLorebookEntry[];
  },
): Promise<{ removed: string[]; written: number; skippedForeign: string[] }> {
  const keys = await port.listKeys();
  const prefix = `atlas:${input.chatUid}:${input.branchId}:`;
  const foreignAtlasKeys = keys.filter((k) => k.startsWith('atlas:') && !k.startsWith(prefix));
  const ours = keys.filter((k) => k.startsWith(prefix));
  // 本聊天旧分支/旧版本的条目先移除再重建（不影响用户原有条目）。
  if (ours.length > 0) await port.remove(ours);
  const entries = input.buildProjection().filter((e) => e.key.startsWith(prefix));
  if (entries.length > 0) await port.write(entries);
  return { removed: ours, written: entries.length, skippedForeign: foreignAtlasKeys };
}

/** 维护结果形状（供 Repository.prepareMaintenance 使用）。 */
export type MaintenanceOutboxUpdate = {
  taskId: string;
  expectedStatus: OutboxStatus;
  nextStatus: OutboxStatus;
  attemptCount: number;
  nextRetryWallMs?: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  completedWallMs?: number;
};

export function outboxRowForInsert(
  input: Parameters<typeof enqueueProjectionSync>[1],
): Record<string, unknown> {
  return createRow(
    'sync_outbox',
    {
      branch_id: input.branchId,
      requested_by_turn_id: input.turnId,
      target: 'managed_lorebook',
      projection_scope: input.projectionScope,
      target_revision: input.targetRevision,
      idempotency_key: `${input.branchId}:${input.projectionScope}:${input.targetRevision}:${input.payloadHash}`,
      payload_hash: input.payloadHash,
      status: 'pending',
      attempt_count: 0,
      created_wall_ms: input.nowWallMs,
    },
    {
      branchId: input.branchId,
      id: input.makeId('outbox'),
      turnId: input.turnId ?? '',
      clockS: 0,
      nowWallMs: input.nowWallMs,
      rulesetVersion: 'atlas-1',
    },
  );
}
