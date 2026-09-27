/**
 * atlas-host-port.ts — B15 / H01 宿主入口适配：把 §16.4 的 AtlasHostPort 接到现有酒馆入口。
 *
 * 规则：
 * - 世界数据的唯一落盘路径仍是 `chatMetadata.atlas`（在现有 `writeAtlasSession` 语义之上追加
 *   `atlas.database` 信封字段），不另开存储、不额外 saveMetadata。
 * - `save` 函数缺失 → HOST_SAVE_UNAVAILABLE，**不能返回 true**。
 * - 切到 B 之后不恢复、不覆盖 B 的 metadata（异步迟到写入一律拒绝）。
 * - SQL 完成只是 PreparedCommit；只有宿主保存成功才发布正式状态（由 Repository.confirmSaved 承担）。
 */

import type { AtlasEnvelope, AtlasHostPort, HostAnchor, HostSaveRequest } from './atlas-db-contract.ts';
import type { Issue, SaveAck } from './atlas-ops-contract.ts';

export const ATLAS_SESSION_KEY = 'atlas';
export const ATLAS_DATABASE_KEY = 'database';

export type HostContextLike = {
  chatId?: string | null;
  chatMetadata?: Record<string, unknown> | null;
  saveMetadata?: (() => Promise<unknown> | unknown) | null;
  /** 现有人工导入路径用的显式写回函数（index.js::writeAtlasSession）。 */
  writeAtlasSession?: (context: () => HostContextLike, session: unknown, expectedChatId?: string | null, expectedMetadata?: unknown) => Promise<unknown>;
};

export type HostPortOptions = {
  context: () => HostContextLike;
  /** 会话文档（三表 / 世界镜像）的写回函数；缺失时只写 envelope 字段。 */
  writeSession?: (context: () => HostContextLike, session: unknown, expectedChatId?: string | null, expectedMetadata?: unknown) => Promise<unknown>;
  /** 分支/修订读取（由 repository 提供）。 */
  readBranchState?: (chatUid: string) => { branchId: string; revision: number; storageRevision: number } | null;
  now?: () => number;
  /** 宿主是否提供保存读回/确认能力（Z01 实测结果）。 */
  canConfirm?: boolean;
};

export type HostCapabilityReport = {
  hasChatMetadata: boolean;
  hasSaveMetadata: boolean;
  hasWriteSession: boolean;
  canConfirm: boolean;
  hostChatId: string | null;
};

/** 宿主能力探测：缺失保存函数必须被明确报出，而不是静默当成功。 */
export function describeHostCapabilities(options: HostPortOptions): HostCapabilityReport {
  const ctx = options.context() ?? {};
  return {
    hasChatMetadata: Boolean(ctx.chatMetadata && typeof ctx.chatMetadata === 'object'),
    hasSaveMetadata: typeof ctx.saveMetadata === 'function',
    hasWriteSession: typeof options.writeSession === 'function',
    canConfirm: options.canConfirm ?? typeof ctx.saveMetadata === 'function',
    hostChatId: ctx.chatId === null || ctx.chatId === undefined ? null : String(ctx.chatId),
  };
}

function metadataOf(ctx: HostContextLike): Record<string, unknown> | null {
  const metadata = ctx?.chatMetadata;
  return metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : null;
}

function atlasOf(metadata: Record<string, unknown>): Record<string, unknown> {
  const existing = metadata[ATLAS_SESSION_KEY];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) return existing as Record<string, unknown>;
  const created: Record<string, unknown> = {};
  metadata[ATLAS_SESSION_KEY] = created;
  return created;
}

export function readEnvelope(options: HostPortOptions): AtlasEnvelope | null {
  const metadata = metadataOf(options.context() ?? {});
  if (!metadata) return null;
  const atlas = metadata[ATLAS_SESSION_KEY];
  if (!atlas || typeof atlas !== 'object') return null;
  const envelope = (atlas as Record<string, unknown>)[ATLAS_DATABASE_KEY];
  if (!envelope || typeof envelope !== 'object') return null;
  return envelope as AtlasEnvelope;
}

/**
 * B15 / H01：创建宿主端口。
 * `captureAnchor` 捕获发起请求时的身份与修订；`isCurrent` 在写回前核对身份。
 */
export function createAtlasHostPort(options: HostPortOptions): AtlasHostPort & {
  capabilities(): HostCapabilityReport;
  readEnvelope(): AtlasEnvelope | null;
  /** 明确失败时恢复本次尚未持久化的 metadata 值（仅在仍为同聊天/同对象时）。 */
  restoreMetadata(input: { chatUid: string; expectedIdentity: unknown; previous: unknown }): boolean;
} {
  const now = options.now ?? (() => Date.now());

  return {
    capabilities(): HostCapabilityReport {
      return describeHostCapabilities(options);
    },

    readEnvelope(): AtlasEnvelope | null {
      return readEnvelope(options);
    },

    captureAnchor(): HostAnchor {
      const ctx = options.context() ?? {};
      const metadata = metadataOf(ctx);
      const state = options.readBranchState?.(String(ctx.chatId ?? '')) ?? null;
      return {
        chatUid: String(ctx.chatId ?? ''),
        hostChatId: ctx.chatId === null || ctx.chatId === undefined ? null : String(ctx.chatId),
        metadataIdentity: metadata,
        branchId: state?.branchId ?? 'main',
        revision: state?.revision ?? 0,
        storageRevision: state?.storageRevision ?? 0,
      };
    },

    isCurrent(anchor: HostAnchor): boolean {
      const ctx = options.context() ?? {};
      const metadata = metadataOf(ctx);
      if (metadata === null) return false;
      if (anchor.hostChatId !== null && String(ctx.chatId ?? '') !== anchor.hostChatId) return false;
      if (anchor.metadataIdentity && metadata !== anchor.metadataIdentity) return false;
      return true;
    },

    async saveCandidate(input: HostSaveRequest): Promise<SaveAck> {
      const token = input.prepared.token;
      const sha = input.prepared.snapshotSha256;
      const fail = (code: string, message: string): SaveAck => ({
        token,
        snapshotSha256: sha,
        result: 'failed',
        error: { code, path: '$.saveCandidate', message, severity: 'error', retryable: false } satisfies Issue,
      });

      const ctx = options.context() ?? {};
      const metadata = metadataOf(ctx);
      if (!metadata) return fail('HOST_SAVE_UNAVAILABLE', '当前聊天没有可写的 chatMetadata');

      // 写回前核对身份：切过聊天就拒绝写。
      if (!this.isCurrent(input.capturedHostAnchor)) {
        return fail('CHAT_CHANGED', '保存前聊天身份/修订已变化：拒绝写入，不恢复、不覆盖当前聊天的 metadata');
      }

      const atlas = atlasOf(metadata);
      atlas[ATLAS_DATABASE_KEY] = input.envelope;

      // 已有会话文档时走既有写回函数（保持三表/世界镜像与 envelope 同一次落盘）。
      const session = atlas.session ?? metadata.atlasSession ?? null;
      try {
        if (options.writeSession) {
          await options.writeSession(options.context, session, input.capturedHostAnchor.hostChatId, input.capturedHostAnchor.metadataIdentity);
        } else if (typeof ctx.saveMetadata === 'function') {
          await ctx.saveMetadata();
        } else {
          return fail('HOST_SAVE_UNAVAILABLE', '宿主没有可核实的保存函数（saveMetadata / writeSession 都缺失）');
        }
      } catch (err) {
        return fail('SESSION_WRITE_FAILED', `宿主保存失败：${(err as Error).message}`);
      }

      // 保存后再核对一次身份：保存过程中切换聊天不能算成功。
      if (!this.isCurrent(input.capturedHostAnchor)) {
        return fail('CHAT_CHANGED', '保存过程中聊天身份发生变化：交由调用方核对耐久存档');
      }

      if (options.canConfirm === false) {
        return {
          token,
          snapshotSha256: sha,
          result: 'requested',
          error: {
            code: 'HOST_SAVE_UNCONFIRMED',
            path: '$.saveCandidate',
            message: '宿主不提供保存确认/读回能力：保持只读待核对，不伪造 saved',
            severity: 'warning',
            retryable: true,
          },
        };
      }
      return { token, snapshotSha256: sha, result: 'saved', confirmedWallMs: now() };
    },

    async refreshViews(): Promise<void> {
      /* 视图刷新由 UI 层承担（H06/H07）；端口本身不持有 DOM。 */
    },

    restoreMetadata(input: { chatUid: string; expectedIdentity: unknown; previous: unknown }): boolean {
      const ctx = options.context() ?? {};
      const metadata = metadataOf(ctx);
      if (!metadata) return false;
      if (input.expectedIdentity && metadata !== input.expectedIdentity) return false;
      if (String(ctx.chatId ?? '') !== input.chatUid) return false;
      if (input.previous === undefined) delete metadata[ATLAS_SESSION_KEY];
      else metadata[ATLAS_SESSION_KEY] = input.previous;
      return true;
    },
  };
}
