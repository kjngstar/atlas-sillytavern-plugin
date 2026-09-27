/**
 * atlas-db-queue.ts — 每聊天串行提交 + 跨标签单写者锁（B14）。
 *
 * §7.3 / §16.1：同一 chat_uid 的最终提交串行；支持 Web Locks 时使用跨标签锁。
 * 不支持时降到进程内队列，并在结果里明确标记（不声称跨标签强一致）。
 */

export type CommitLockMode = 'web-locks' | 'in-process';

export type CommitLockInfo = {
  chatUid: string;
  mode: CommitLockMode;
  waitedMs: number;
};

type LockManagerLike = {
  request(name: string, options: { mode: 'exclusive' }, callback: () => Promise<unknown>): Promise<unknown>;
};

const inProcessQueues = new Map<string, Promise<unknown>>();

function getWebLocks(): LockManagerLike | null {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  if (nav?.locks && typeof nav.locks.request === 'function') return nav.locks;
  return null;
}

export function commitLockMode(): CommitLockMode {
  return getWebLocks() ? 'web-locks' : 'in-process';
}

/**
 * B14 withChatCommitLock：同一 chatUid 串行执行。
 * 完成定义：同一基版本两次并发只有一个有效提交（由 Repository 的 revision 检查承担）。
 */
export async function withChatCommitLock<T>(chatUid: string, fn: (info: CommitLockInfo) => Promise<T>): Promise<T> {
  const started = Date.now();
  const locks = getWebLocks();

  if (locks) {
    let mode: CommitLockMode = 'web-locks';
    const result = await locks.request(`atlas-commit:${chatUid}`, { mode: 'exclusive' }, async () => {
      try {
        return await fn({ chatUid, mode, waitedMs: Date.now() - started });
      } catch (err) {
        throw err;
      }
    });
    mode = 'web-locks';
    return result as T;
  }

  const previous = inProcessQueues.get(chatUid) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  inProcessQueues.set(
    chatUid,
    previous.then(() => gate),
  );
  await previous.catch(() => undefined);
  try {
    return await fn({ chatUid, mode: 'in-process', waitedMs: Date.now() - started });
  } finally {
    release();
    if (inProcessQueues.get(chatUid) === gate) inProcessQueues.delete(chatUid);
  }
}

/** 测试辅助：清空进程内队列。 */
export function resetCommitQueuesForTests(): void {
  inProcessQueues.clear();
}
