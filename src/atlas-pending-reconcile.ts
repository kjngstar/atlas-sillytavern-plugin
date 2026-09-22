/**
 * atlas-pending-reconcile.ts — R12 待处理回合文档清理（纯函数 + IO）。
 *
 * 为什么需要这个：
 * - /turns/commit 步骤 7 顺序写 world / binding / pending.remove / turn。其中 world /
 *   binding / turn 落在会话覆盖层（同一 session 对象），由 createAtlasServerCore 整
 *   体带回——原子性已由 0.9.42 会话承载满足。**但 pending:* 文档在全局 store，移除
 *   是分开的 IO**——如果 pending.remove 抛错（IO 异常），要么响应不返回 200（数据
 *   安全但用户体验差：作者以为失败去重试），要么吞掉异常（用户体验好但留下孤儿）。
 * - 现状采用 try/catch 兜底（pending.remove 失败 → 记日志不抛错）。代价：可能在全局
 *   store 留下 orphan pending——下次相同 idempotencyKey 重试时，retry 路径会读
 *   pending、误以为还没 commit，调一次 API 重做（浪费 token 但不破坏数据）。
 * - reconcilePendingCommits 在路由初始化 / 启动钩子被调用，扫所有 pending:* 文档，
 *   对照 turn:<chatId>:<idempotencyKey> 是否存在：
 *     - 存在 → pending 是 orphan（commit 已成功但 pending 没删），安全删除
 *     - 不存在 → pending 合法（commit 还没成功或已回滚），保留
 *
 * 设计纪律：
 * - 纯函数 + IO 分离，process 函数接受 store，可独立测试
 * - 单条失败不阻断整体清理（一条坏 pending 删不掉不影响其他）
 * - 不修改世界、绑定、turn 文档——只动 pending:*
 */

import type { AtlasDocumentStore } from "./atlas-server.ts";

export interface ScannedPending {
  /** pending 文档全名（含 `pending:` 前缀）。 */
  name: string;
  /** 文档名里夹带的 idempotencyKey（剥离前缀）。 */
  idempotencyKey: string;
  /** pending 内部 binding.chatId。 */
  chatId: string;
}

export interface ReconcileReport {
  /** 扫到的 pending 文档总数。 */
  scanned: number;
  /** 实际删除的 orphan 数量（commit 已成功但 pending 没删）。 */
  cleaned: number;
  /** 保留的 pending 数量（commit 未完成或合法待重试）。 */
  kept: number;
  /** 解析失败的 pending 数量（坏数据，保留以免误删）。 */
  malformed: number;
  /** 扫描 / 删除过程中的错误清单（不抛错，便于启动钩子调用）。 */
  errors: string[];
}

export interface ReconcileOptions {
  /** 测试 / 诊断用：限制处理条目数（默认不限制）。 */
  limit?: number;
  /** 当 orphan 删除失败时是否记入 errors（默认 true）。 */
  reportDeleteErrors?: boolean;
}

/**
 * 列出全局 store 中所有 pending 文档名，提取 chatId 与 idempotencyKey。
 * 形状不可信——失败条目计入 malformed（保留以免误删）。
 *
 * 注意：pending 文档名形如 `pending:<完整 idempotencyKey>`。StoredPendingCommit 不
 * 单独存 idempotencyKey 字段；idempotencyKey 从文档名剥离，chatId 从
 * binding.chatId 读。
 */
export async function scanPendingEntries(
  store: Pick<AtlasDocumentStore, "list" | "read">,
): Promise<{ entries: ScannedPending[]; malformed: number; errors: string[] }> {
  const errors: string[] = [];
  let names: string[];
  try {
    names = await store.list("pending:");
  } catch (thrown) {
    return { entries: [], malformed: 0, errors: [`扫描 pending 列表失败：${describeError(thrown)}`] };
  }
  const entries: ScannedPending[] = [];
  let malformed = 0;
  for (const name of names) {
    if (!name.startsWith("pending:")) continue;
    const idempotencyKey = name.slice("pending:".length);
    if (!idempotencyKey) {
      malformed += 1;
      continue;
    }
    let raw: unknown;
    try {
      raw = await store.read(name);
    } catch (thrown) {
      errors.push(`读取 ${name} 失败：${describeError(thrown)}`);
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      malformed += 1;
      continue;
    }
    const binding = (raw as Record<string, unknown>).binding;
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      malformed += 1;
      continue;
    }
    const chatId = (binding as Record<string, unknown>).chatId;
    if (typeof chatId !== "string" || chatId.length === 0) {
      malformed += 1;
      continue;
    }
    entries.push({ name, idempotencyKey, chatId });
  }
  return { entries, malformed, errors };
}

/**
 * 扫所有 pending:* 文档，孤儿删除。
 * - orphan：同 chatId 的 turn:<chatId>:<idempotencyKey> 已存在 → commit 已成功但
 *   pending 没删，安全删除。
 * - 合法：turn 文档不存在 → commit 未成功（prepare 后失败 / 浏览器中断），保留。
 * - malformed：数据损坏 → 保留（宁可不删也别误删）。
 */
export async function reconcilePendingCommits(
  store: Pick<AtlasDocumentStore, "list" | "read" | "remove">,
  options: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const { entries, malformed, errors: scanErrors } = await scanPendingEntries(store);
  const errors = [...scanErrors];
  let cleaned = 0;
  let kept = 0;
  const limit = options.limit ?? Infinity;
  for (const entry of entries) {
    if (cleaned + kept >= limit) break;
    let turnDoc: unknown;
    try {
      turnDoc = await store.read(`turn:${entry.chatId}:${entry.idempotencyKey}`);
    } catch (thrown) {
      // 读 turn 失败视为不确定：保留 pending，记一次错
      errors.push(`读取 turn:${entry.chatId}:${entry.idempotencyKey} 失败：${describeError(thrown)}`);
      kept += 1;
      continue;
    }
    if (isTurnCommitted(turnDoc)) {
      // orphan：commit 已成功但 pending 没删
      try {
        await store.remove(entry.name);
        cleaned += 1;
      } catch (thrown) {
        if (options.reportDeleteErrors !== false) {
          errors.push(`删除 orphan ${entry.name} 失败：${describeError(thrown)}`);
        }
        kept += 1;
      }
    } else {
      kept += 1;
    }
  }
  return {
    scanned: entries.length,
    cleaned,
    kept,
    malformed,
    errors,
  };
}

/** turn 文档判定：存在 receipt 且非回退即视为已提交。 */
function isTurnCommitted(doc: unknown): boolean {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
  const record = doc as Record<string, unknown>;
  if (record.rolledBack === true) return false; // 回退过，pending 可能合法（retry 路径仍能用）
  const receipt = record.receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  return true;
}

function describeError(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}