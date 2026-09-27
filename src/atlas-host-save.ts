/**
 * atlas-host-save.ts — 宿主保存适配（B16，配合 B15 / Z01 能力结果）。
 *
 * 规则（§16.4）：
 * - 只有宿主明确返回 saved 才算落盘；只排队返回 requested（保留候选并显示「保存待确认」）。
 * - 保存函数缺失 → HOST_SAVE_UNAVAILABLE，**不能返回 true**。
 * - 宿主没有确认/读回能力 → HOST_SAVE_UNCONFIRMED，保持只读待核对，不伪造 saved。
 * - 捕获的原 metadata 身份在保存前后都要核对：切到 B 不恢复/覆盖 B 的 metadata。
 */

import type { AtlasEnvelope, AtlasHostPort, HostAnchor, HostSaveRequest } from './atlas-db-contract.ts';
import type { Issue, PreparedCommit, PreparedMaintenance, SaveAck } from './atlas-ops-contract.ts';

export type HostSaveOutcome = {
  result: 'saved' | 'requested' | 'failed' | 'unconfirmed';
  ack: SaveAck;
  restoredMetadata: boolean;
  issues: Issue[];
};

export type HostSaveFunction = (input: {
  chatUid: string;
  envelope: AtlasEnvelope;
  expectedMetadataIdentity: unknown;
  expectedRevision: number;
  snapshotSha256: string;
}) => Promise<{ confirmed: boolean; durableSha256?: string; error?: string } | void>;

export type HostSaveAdapterOptions = {
  captureAnchor: () => HostAnchor;
  isCurrent: (anchor: HostAnchor) => boolean;
  /** 宿主实际保存函数；缺失时为 null。 */
  save?: HostSaveFunction | null;
  /** 宿主是否提供读回/确认能力。 */
  canConfirm?: boolean;
  /** 明确失败时恢复本次尚未持久化的 metadata 值（只在同聊天/同哈希/无后继写入时）。 */
  restoreMetadata?: (input: { chatUid: string; expectedIdentity: unknown }) => boolean;
  now?: () => number;
};

export function createHostSaveAdapter(options: HostSaveAdapterOptions): AtlasHostPort {
  const saveFn = options.save ?? null;
  const canConfirm = options.canConfirm ?? Boolean(saveFn);

  return {
    captureAnchor: options.captureAnchor,
    isCurrent: options.isCurrent,
    async refreshViews() {
      /* 视图刷新由宿主/UI 层承担；适配器不持有 UI。 */
    },
    async saveCandidate(input: HostSaveRequest): Promise<SaveAck> {
      const outcome = await saveCandidate(input, { ...options, save: saveFn, canConfirm });
      return outcome.ack;
    },
  };
}

/**
 * B16 saveCandidate：调宿主已核实保存接口，返回 saved/requested/failed。
 * 不把没有完成信号的保存排队宣称为已落盘。
 */
export async function saveCandidate(
  input: HostSaveRequest,
  options: HostSaveAdapterOptions,
): Promise<HostSaveOutcome> {
  const issues: Issue[] = [];
  const token = input.prepared.token;
  const sha = input.prepared.snapshotSha256;

  const failed = (code: string, message: string, retryable = true): HostSaveOutcome => {
    const issue: Issue = { code, path: '$.saveCandidate', message, severity: 'error', retryable };
    return { result: 'failed', ack: { token, snapshotSha256: sha, result: 'failed', error: issue }, restoredMetadata: false, issues: [issue] };
  };

  const current = options.isCurrent(input.capturedHostAnchor);
  if (!current) {
    const issue: Issue = {
      code: 'CHAT_CHANGED',
      path: '$.saveCandidate',
      message: '保存前聊天身份/分支/修订已变化：拒绝写入，不恢复、不覆盖当前聊天的 metadata',
      severity: 'error',
      retryable: false,
    };
    return { result: 'failed', ack: { token, snapshotSha256: sha, result: 'failed', error: issue }, restoredMetadata: false, issues: [issue] };
  }

  if (!options.save) {
    return failed('HOST_SAVE_UNAVAILABLE', '宿主没有可核实的保存函数：不能把未落盘的候选当成已保存', false);
  }

  let raw: Awaited<ReturnType<HostSaveFunction>>;
  try {
    raw = await options.save({
      chatUid: input.capturedHostAnchor.chatUid,
      envelope: input.envelope,
      expectedMetadataIdentity: input.capturedHostAnchor.metadataIdentity,
      expectedRevision: input.capturedHostAnchor.revision,
      snapshotSha256: sha,
    });
  } catch (err) {
    const outcome = failed('SESSION_WRITE_FAILED', `宿主保存调用抛错：${(err as Error).message}`);
    outcome.restoredMetadata = tryRestore(options, input);
    return outcome;
  }

  // 保存后再核对身份：保存期间切到 B 不能污染 B。
  if (!options.isCurrent(input.capturedHostAnchor)) {
    const issue: Issue = {
      code: 'CHAT_CHANGED',
      path: '$.saveCandidate',
      message: '保存过程中聊天身份发生变化：不回写、不恢复，交由调用方核对耐久存档',
      severity: 'error',
      retryable: false,
    };
    return { result: 'failed', ack: { token, snapshotSha256: sha, result: 'failed', error: issue }, restoredMetadata: false, issues: [issue] };
  }

  const confirmed = raw && typeof raw === 'object' && 'confirmed' in raw ? Boolean((raw as { confirmed: boolean }).confirmed) : false;
  const durableSha = raw && typeof raw === 'object' && 'durableSha256' in raw ? (raw as { durableSha256?: string }).durableSha256 : undefined;
  const hostError = raw && typeof raw === 'object' && 'error' in raw ? (raw as { error?: string }).error : undefined;

  if (hostError) {
    const outcome = failed('SESSION_WRITE_FAILED', `宿主保存明确失败：${hostError}`);
    outcome.restoredMetadata = tryRestore(options, input);
    return outcome;
  }

  if (options.canConfirm === false) {
    const issue: Issue = {
      code: 'HOST_SAVE_UNCONFIRMED',
      path: '$.saveCandidate',
      message: '宿主不提供保存确认/读回能力：保持只读待核对，不伪造 saved',
      severity: 'warning',
      retryable: true,
    };
    issues.push(issue);
    return {
      result: 'requested',
      ack: { token, snapshotSha256: sha, result: 'requested', error: issue },
      restoredMetadata: false,
      issues,
    };
  }

  if (!confirmed) {
    const issue: Issue = {
      code: 'HOST_SAVE_REQUESTED',
      path: '$.saveCandidate',
      message: '宿主只表示已排队、未给出落盘完成信号：保留候选并显示「保存待确认」',
      severity: 'warning',
      retryable: true,
    };
    issues.push(issue);
    return {
      result: 'requested',
      ack: { token, snapshotSha256: sha, result: 'requested', error: issue },
      restoredMetadata: false,
      issues,
    };
  }

  // 有确认能力且已确认：核对耐久 hash（证明界面对象相同之外的磁盘相同）。
  if (durableSha && durableSha !== sha) {
    const issue: Issue = {
      code: 'HOST_SAVE_HASH_MISMATCH',
      path: '$.saveCandidate',
      message: `宿主耐久存档 hash 与候选不一致：declared=${sha} durable=${durableSha}`,
      severity: 'error',
      retryable: false,
    };
    return { result: 'failed', ack: { token, snapshotSha256: sha, result: 'failed', error: issue }, restoredMetadata: false, issues: [issue] };
  }

  return {
    result: 'saved',
    ack: { token, snapshotSha256: sha, result: 'saved', confirmedWallMs: options.now ? options.now() : Date.now() },
    restoredMetadata: false,
    issues,
  };
}

function tryRestore(options: HostSaveAdapterOptions, input: HostSaveRequest): boolean {
  if (!options.restoreMetadata) return false;
  try {
    return options.restoreMetadata({
      chatUid: input.capturedHostAnchor.chatUid,
      expectedIdentity: input.capturedHostAnchor.metadataIdentity,
    });
  } catch {
    return false;
  }
}

/**
 * 保存结果未知（已发出但确认丢失）时的核对：只能用耐久存档 hash 比对。
 * 不能假定未保存而重新增加一轮。
 */
export function reconcileUnknownSave(
  ack: SaveAck,
  durableSnapshotSha256: string | null,
): { verdict: 'saved' | 'not_saved' | 'unknown'; issue?: Issue } {
  if (ack.result === 'saved') return { verdict: 'saved' };
  if (durableSnapshotSha256 === null) {
    return {
      verdict: 'unknown',
      issue: {
        code: 'HOST_SAVE_UNCONFIRMED',
        path: '$.reconcile',
        message: '宿主不提供读回能力：保存结果未知，保持只读待核对',
        severity: 'warning',
        retryable: true,
      },
    };
  }
  if (durableSnapshotSha256 === ack.snapshotSha256) return { verdict: 'saved' };
  return { verdict: 'not_saved' };
}

export type { PreparedCommit, PreparedMaintenance };
