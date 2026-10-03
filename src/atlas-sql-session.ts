/**
 * atlas-sql-session.ts — H01–H03 单聊天 SQL 会话桥（§7.1–§7.3 / §16.1 / §16.4）。
 *
 * 固定决策：SQL 世界数据是**显式 opt-in**（`settings.atlas.sqlMode`，默认关闭）。
 * - 打开（OFF）：所有既有代码路径一字不变，三表 `chatMetadata.atlas.tables` 仍是唯一写入者。
 * - 打开（ON）：SQL 是**唯一**业务写入目标；旧 world/tables/simulation 只能作为一次迁移输入
 *   或只读兼容投影，**绝不双向同步**（§16.1 第 3 条）。
 *
 * 本文件承担的固定顺序（§7.3）：
 *   捕获聊天身份 + 分支 + head + revision
 *   → 候选态构建（Repository.prepareTurn）
 *   → 导出候选并校验（PreparedCommit.snapshotSha256）
 *   → **提交前再检查聊天身份、head、revision、单写者锁**（withChatCommitLock + 复核 baseRevision）
 *   → 保存到宿主并等宿主保存结果（SaveAck）
 *   → 只有 saved 才 confirmSaved 发布新状态与 coreSaved=true
 *   → 之后才做可重试的世界书同步（失败只说「世界已更新，世界书待同步」）
 *
 * 宿主保存失败（failed）丢弃候选并恢复本次尚未持久化的 metadata；
 * 宿主没有完成信号（requested）保留候选、明确「保存待确认」，**不伪造 saved**。
 */

import { ATLAS_DATABASE_KEY, ATLAS_SESSION_KEY, createAtlasHostPort } from './atlas-host-port.ts';
import { decodeSnapshot } from './atlas-db-envelope.ts';
import { AtlasDbError } from './atlas-db-runtime.ts';
import { withChatCommitLock } from './atlas-db-queue.ts';
import {
  finalizeMigration,
  inspectLegacySession,
  legacyBackupPayload,
  migrateLegacyEntities,
  migrateLegacySimulation,
  tableCounts,
} from './atlas-db-migrate.ts';
import { runNextSync } from './atlas-db-outbox.ts';
import { ATLAS_RUNTIME_LIMITS } from './atlas-runtime-limits.ts';
import type { AtlasEnvelope, AtlasModelPort } from './atlas-db-contract.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { FailedGroupRetryInput, FailedGroupRetryResult } from './atlas-db-retry.ts';
import type { NarratorPortrayal, PovProjection } from './atlas-db-knowledge-view.ts';
import type { LegacyBackup, LegacyInspection, LegacyMapped } from './atlas-db-migrate.ts';
import type { LorebookPort, ManagedLorebookEntry } from './atlas-db-outbox.ts';
import type { AtlasSqlRepositoryWithHelpers } from './atlas-db-repository.ts';
import type {
  Issue,
  PreparedCommit,
  PreparedMaintenance,
  RollbackInput,
  SaveAck,
  TurnAnchor,
  TurnInput,
  TurnReceipt,
} from './atlas-ops-contract.ts';

/* ================================================================== *
 * 模式开关（默认 false：既有行为一字不变）
 * ================================================================== */

export const ATLAS_SQL_MODE_KEY = 'sqlMode';

/**
 * 是否启用「SQL 世界数据」。
 * 接受 `true/false`、`{sqlMode:true}`、`{atlas:{sqlMode:true}}`；其它一切形状（含缺省）都是 false。
 * 只有严格 `true` 才打开：字符串 "true"、1、缺失都不算启用（不猜用户意图）。
 */
export function isSqlModeEnabled(settings: unknown): boolean {
  if (typeof settings === 'boolean') return settings;
  if (settings === null || typeof settings !== 'object') return false;
  const record = settings as Record<string, unknown>;
  const direct = record[ATLAS_SQL_MODE_KEY];
  if (typeof direct === 'boolean') return direct;
  const atlas = record.atlas;
  if (atlas !== null && typeof atlas === 'object' && !Array.isArray(atlas)) {
    const nested = (atlas as Record<string, unknown>)[ATLAS_SQL_MODE_KEY];
    if (typeof nested === 'boolean') return nested;
  }
  return false;
}

/* ================================================================== *
 * 固定类型
 * ================================================================== */

export type SqlSessionOptions = {
  chatUid: string;
  worldUid?: string;
  branchId?: string;
  branchName?: string;
  rulesetVersion?: string;
  chatMetadata: Record<string, unknown>;
  saveSession: () => Promise<unknown>;
  modelPort?: AtlasModelPort | null;
  writeSession?: (
    context: () => unknown,
    session: unknown,
    expectedChatId?: string | null,
    expectedMetadata?: unknown,
  ) => Promise<unknown>;
  now?: () => number;
  confirmSave?: boolean;
  /** Live host guard checked before publishing a candidate; never serialize this callback. */
  isCurrentHost?: () => boolean;
  /** H13：宿主/服务端已持有的 Repository（同一核心，不新建第二份世界权威）。 */
  repository?: AtlasSqlRepositoryWithHelpers | null;
  /** 世界书端口；缺失即不做同步（核心数据照常保存）。 */
  lorebookPort?: LorebookPort | null;
  /** 世界书投影构造（runNextSync 需要）。 */
  buildProjection?: (scope: 'pov' | 'scene_portrayal', revision: number) => ManagedLorebookEntry[];
  /** 迁移是否顺手保存（缺省 true）；false 时只改运行态，由调用方决定何时落盘。 */
  persist?: boolean;
};

export type AtlasSqlHostPort = ReturnType<typeof createAtlasHostPort>;

export type SqlSession = {
  repo: AtlasSqlRepositoryWithHelpers;
  source: 'existing' | 'new' | 'migrated';
  envelopePresent: boolean;
  issues: Issue[];
  chatUid: string;
  worldUid: string;
  branchId: string;
  branchName: string;
  rulesetVersion: string;
  chatMetadata: Record<string, unknown>;
  saveSession: (() => Promise<unknown>) | null;
  modelPort: AtlasModelPort | null;
  now: () => number;
  confirmSave: boolean;
  isCurrentHost?: () => boolean;
  hostPort: AtlasSqlHostPort;
  lorebookPort: LorebookPort | null;
  buildProjection: ((scope: 'pov' | 'scene_portrayal', revision: number) => ManagedLorebookEntry[]) | null;
  closed: boolean;
};

/** openSqlSession 的返回值：既是 §17H 的固定结果，也是后续 persist/run/close 的会话句柄。 */
export type OpenSqlSessionResult = {
  repo: AtlasSqlRepositoryWithHelpers;
  source: 'existing' | 'new' | 'migrated';
  envelopePresent: boolean;
  issues: Issue[];
} & SqlSession;

export type PersistSqlOptions = {
  /** 无候选时强制导出当前正式库（默认也会导出）。 */
  force?: boolean;
  /** 待保存的候选（turn/rollback/maintenance）；缺省时导出当前正式库。 */
  commit?: PreparedCommit | PreparedMaintenance | null;
  /** 直接给出信封（已编码；避免重复导出）。 */
  envelope?: AtlasEnvelope | null;
};

export type PersistSqlResult = {
  saved: boolean;
  ack?: SaveAck;
  envelope?: AtlasEnvelope;
  issues: Issue[];
};

export type SqlTurnResult = {
  receipt: TurnReceipt;
  saved: boolean;
  commit: PreparedCommit;
  issues: Issue[];
  /** 宿主确认字段（§16.3）：只有宿主 saved 才为 true，不在导出前伪造。 */
  coreSaved: boolean;
};

export type SqlRollbackResult = {
  receipt: TurnReceipt;
  saved: boolean;
  issues: Issue[];
  coreSaved: boolean;
};

export type SqlMigrationResult = {
  inspection: LegacyInspection;
  mapped: LegacyMapped;
  backup: LegacyBackup;
  issues: Issue[];
  /** 迁移后的会话句柄（损坏档拒绝迁移时为 null）。 */
  session: SqlSession | null;
  saved: boolean;
  counts: Record<string, number>;
};

/* ================================================================== *
 * 小工具
 * ================================================================== */

function issue(
  code: string,
  message: string,
  severity: Issue['severity'] = 'error',
  retryable = false,
  extra: Partial<Issue> = {},
): Issue {
  return { code, path: '$', message, severity, retryable, ...extra };
}

function atlasOf(metadata: Record<string, unknown>): Record<string, unknown> | null {
  const existing = metadata[ATLAS_SESSION_KEY];
  if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  return null;
}

/** 只读读取 `chatMetadata.atlas.database`；不改动任何字段。 */
export function readSqlEnvelope(chatMetadata: Record<string, unknown> | null | undefined): unknown {
  if (!chatMetadata || typeof chatMetadata !== 'object') return null;
  const atlas = atlasOf(chatMetadata as Record<string, unknown>);
  if (!atlas) return null;
  const envelope = atlas[ATLAS_DATABASE_KEY];
  return envelope === undefined ? null : envelope;
}

function makeIdOf(repo: AtlasSqlRepositoryWithHelpers): (kind: string, opId: string, alias: string) => string {
  return repo.internal.makeId;
}

/**
 * 保存前快照 `chatMetadata.atlas`（浅拷贝 + 旧信封引用）。
 * 宿主端口会就地把新信封写进 `atlas.database`；明确失败时要能恢复**未持久化前**的值，
 * 所以不能把同一个 atlas 对象交回去（那是被改过的那个）。信封本身不被就地修改，
 * 因此这里只浅拷贝 atlas、保留旧信封引用，避免每轮深拷贝几百 KB 的 base64。
 */
function snapshotAtlasForRestore(metadata: Record<string, unknown>): unknown {
  const atlas = metadata[ATLAS_SESSION_KEY];
  if (atlas === null || typeof atlas !== 'object' || Array.isArray(atlas)) return atlas;
  const record = atlas as Record<string, unknown>;
  const copy: Record<string, unknown> = { ...record };
  if (record[ATLAS_DATABASE_KEY] === undefined) delete copy[ATLAS_DATABASE_KEY];
  return copy;
}

/** 是否已经打开：用只读 getter 探测，避免重复 open 泄漏 wasm 句柄。 */
function isRepositoryOpen(repo: AtlasSqlRepositoryWithHelpers): boolean {
  try {
    repo.internal.currentRevision();
    return true;
  } catch {
    return false;
  }
}

function anchorOf(session: SqlSession, overrides: Partial<TurnAnchor> = {}): TurnAnchor {
  let parentTurnId: string | null = null;
  let baseRevision = 0;
  try {
    parentTurnId = session.repo.internal.currentHeadTurnId();
    baseRevision = session.repo.internal.currentRevision();
  } catch {
    parentTurnId = null;
    baseRevision = 0;
  }
  return {
    chatUid: session.chatUid,
    branchId: session.branchId,
    parentTurnId,
    hostMessageUid: '',
    variantKey: '',
    baseRevision,
    baseStorageRevision: session.repo.storageRevision,
    inputHash: '',
    ...overrides,
  };
}

/** 迁移/维护：不改 head/revision/clock 的内部锚点。 */
function maintenanceAnchor(session: SqlSession, tag: string): TurnAnchor {
  return anchorOf(session, {
    hostMessageUid: `${tag}:${session.chatUid}`,
    variantKey: tag,
    inputHash: tag,
  });
}

async function createRepositoryFor(options: {
  chatUid: string;
  worldUid: string;
  branchId: string;
  branchName: string;
  rulesetVersion: string;
  modelPort: AtlasModelPort | null;
  now: () => number;
}): Promise<AtlasSqlRepositoryWithHelpers> {
  // 动态导入：只有真正启用 SQL 模式时才把 sql.js 运行时拉进来
  // （server 的 /sql/* 路由在没有注入 Repository 时返回 SQL_MODE_DISABLED，不加载它）。
  const mod = await import('./atlas-db-repository.ts');
  return mod.createSqlRepository({
    chatUid: options.chatUid,
    worldUid: options.worldUid,
    branchId: options.branchId,
    branchName: options.branchName,
    rulesetVersion: options.rulesetVersion,
    modelPort: options.modelPort,
    now: options.now,
  });
}

/* ================================================================== *
 * B15 / H01：打开单聊天 SQL 会话
 * ================================================================== */

/**
 * 打开（或新建）一个聊天的 SQL 世界。
 *
 * - `chatMetadata.atlas.database` 存在 → `decodeSnapshot`；**损坏或更高 schema 一律失败**
 *   （`ENVELOPE_*` / `DB_SCHEMA_UNSUPPORTED`），**绝不**因此建一个空世界。
 * - 不存在 → 新库（branch + migration turn），`source:'new'`；第一轮成功提交时才落盘。
 * - `chatUid` 一律以**宿主聊天身份**为准；信封里的 `chat_uid` 不一致 → `CHAT_CHANGED`（§7.4 复制聊天守卫）。
 */
export async function openSqlSession(options: SqlSessionOptions): Promise<OpenSqlSessionResult> {
  const issues: Issue[] = [];
  const now = options.now ?? (() => Date.now());
  const chatUid = typeof options.chatUid === 'string' ? options.chatUid : '';
  if (chatUid.length === 0) {
    throw new AtlasDbError('CHAT_UID_REQUIRED', 'SQL 会话必须由宿主聊天身份发起：chatUid 不能为空', {});
  }
  const branchId = options.branchId ?? 'main';
  const branchName = options.branchName ?? '主线';
  const worldUid = options.worldUid ?? `world_${chatUid}`;
  const rulesetVersion = options.rulesetVersion ?? 'atlas-1';

  const raw = readSqlEnvelope(options.chatMetadata);
  let source: 'existing' | 'new' = 'new';
  let bytes: Uint8Array | undefined;
  let envelope: AtlasEnvelope | null = null;
  if (raw !== null && raw !== undefined) {
    const decoded = await decodeSnapshot(raw);
    if (!decoded.ok) {
      // 损坏/更高版本：保留原存档并明确失败，绝不建空世界覆盖它。
      throw new AtlasDbError(decoded.code, `${decoded.message}（保留原存档，不新建空世界）`, decoded.detail);
    }
    envelope = decoded.envelope;
    if (envelope.chat_uid !== chatUid) {
      throw new AtlasDbError(
        'CHAT_CHANGED',
        `存档属于聊天 ${envelope.chat_uid}，当前聊天是 ${chatUid}：宿主复制聊天必须显式 fork/import，不能继续写入这份世界`,
        { envelopeChatUid: envelope.chat_uid, currentChatUid: chatUid },
      );
    }
    bytes = decoded.bytes;
    source = 'existing';
  }

  const repo =
    options.repository ??
    (await createRepositoryFor({ chatUid, worldUid, branchId, branchName, rulesetVersion, modelPort: options.modelPort ?? null, now }));
  if (repo.chatUid !== chatUid) {
    throw new AtlasDbError('CHAT_CHANGED', `注入的 Repository 属于聊天 ${repo.chatUid}，当前聊天是 ${chatUid}`, {
      repositoryChatUid: repo.chatUid,
      currentChatUid: chatUid,
    });
  }
  if (!isRepositoryOpen(repo)) {
    if (bytes) await repo.open({ bytes, envelope });
    else await repo.open({});
  } else if (envelope && repo.storageRevision !== Number(envelope.storage_revision ?? 0)) {
    // 注入的 Repository 已经打开：沿用运行态（**不重复导入**），但把不一致留在诊断里。
    issues.push(
      issue(
        'SESSION_STALE',
        `注入的 Repository 已打开（storageRevision=${repo.storageRevision}），与信封的 ${envelope.storage_revision} 不一致：沿用运行态，不重复导入`,
        'warning',
        true,
        { path: '$.repository' },
      ),
    );
  }

  const saveSession = typeof options.saveSession === 'function' ? options.saveSession : null;
  if (!saveSession && typeof options.writeSession !== 'function') {
    issues.push(
      issue(
        'HOST_SAVE_UNAVAILABLE',
        '宿主没有可核实的保存函数（saveSession / writeSession 都缺失）：本轮 SQL 完成只是候选，不能声称已保存',
        'warning',
        true,
        { path: '$.saveSession' },
      ),
    );
  }

  const hostPort = createAtlasHostPort({
    context: () => ({
      chatId: chatUid,
      chatMetadata: options.chatMetadata,
      saveMetadata: saveSession,
    }),
    writeSession: options.writeSession,
    readBranchState: () => ({ branchId: repo.branchId, revision: safeRevision(repo), storageRevision: repo.storageRevision }),
    now,
    canConfirm: options.confirmSave ?? true,
  });

  const session: SqlSession = {
    repo,
    source,
    envelopePresent: raw !== null && raw !== undefined,
    issues,
    chatUid,
    worldUid,
    branchId: repo.branchId,
    branchName,
    rulesetVersion,
    chatMetadata: options.chatMetadata,
    saveSession,
    modelPort: options.modelPort ?? null,
    now,
    confirmSave: options.confirmSave ?? true,
    isCurrentHost: options.isCurrentHost,
    hostPort,
    lorebookPort: options.lorebookPort ?? null,
    buildProjection: options.buildProjection ?? null,
    closed: false,
  };
  return session;
}

function safeRevision(repo: AtlasSqlRepositoryWithHelpers): number {
  try {
    return repo.internal.currentRevision();
  } catch {
    return 0;
  }
}

/* ================================================================== *
 * B15 / H01：保存并等宿主确认
 * ================================================================== */

/**
 * 导出 → encodeSnapshot → 写 `chatMetadata.atlas.database`（经宿主端口）→ 调宿主保存 → 返回 SaveAck。
 * **宿主说 requested/failed 时绝不 report saved**；明确失败还要恢复本次尚未持久化的 metadata 值。
 */
export async function persistSqlSession(session: SqlSession, options: PersistSqlOptions = {}): Promise<PersistSqlResult> {
  const issues: Issue[] = [];
  if (session.closed) {
    issues.push(issue('SESSION_CLOSED', 'SQL 会话已关闭：拒绝保存', 'error', false));
    return { saved: false, issues };
  }

  const commit = options.commit ?? null;
  let envelope = options.envelope ?? null;
  if (!envelope && commit) envelope = session.repo.getCandidate(commit.token)?.envelope ?? null;
  if (!envelope) envelope = await session.repo.currentEnvelope();

  const token = commit ? commit.token : `prep_export_${envelope.sha256.slice(0, 16)}`;
  const prepared: PreparedCommit | PreparedMaintenance =
    commit ??
    ({
      kind: 'maintenance',
      token,
      anchor: anchorOf(session, { hostMessageUid: `export:${session.chatUid}`, variantKey: 'export', inputHash: 'export' }),
      // 宿主端口只用 token + snapshotSha256；这里不重复导出整库字节。
      snapshot: new Uint8Array(0),
      snapshotSha256: envelope.sha256,
      expiresWallMs: session.now() + ATLAS_RUNTIME_LIMITS.pendingCandidateTtlMs,
      receipt: null,
    } satisfies PreparedMaintenance);

  const previousAtlas = snapshotAtlasForRestore(session.chatMetadata);
  const captured = session.hostPort.captureAnchor();
  const ack = await session.hostPort.saveCandidate({ capturedHostAnchor: captured, prepared, envelope });

  if (ack.result === 'saved') {
    if (commit) await session.repo.confirmSaved(ack);
    session.envelopePresent = true;
    return { saved: true, ack, envelope, issues };
  }

  if (ack.result === 'requested') {
    // 保存结果未知/无完成信号：保留候选，界面显示「保存待确认」，核对耐久存档的 snapshotSha256（§16.4）。
    if (commit) {
      try {
        await session.repo.confirmSaved(ack);
      } catch (err) {
        issues.push(
          issue('HOST_SAVE_UNCONFIRMED', `保存待确认，但候选核对失败：${(err as Error).message}`, 'warning', true, {
            path: '$.confirmSaved',
          }),
        );
      }
    }
    issues.push(
      ack.error ??
        issue('HOST_SAVE_UNCONFIRMED', '宿主没有给出保存完成信号：保持 requested，不伪造 saved', 'warning', true),
    );
    return { saved: false, ack, envelope, issues };
  }

  // failed：恢复本次尚未持久化的 metadata（仅在仍是同聊天/同对象时），丢弃候选。
  const restored = session.hostPort.restoreMetadata({
    chatUid: session.chatUid,
    expectedIdentity: session.chatMetadata,
    previous: previousAtlas,
  });
  issues.push(
    ack.error ??
      issue('SESSION_WRITE_FAILED', '宿主保存失败：候选已丢弃，世界不发布', 'error', false),
  );
  if (!restored) {
    issues.push(
      issue('SESSION_WRITE_FAILED', '宿主保存失败且无法恢复 metadata（聊天对象已变化）：交由调用方核对耐久存档', 'warning', true, {
        path: '$.restoreMetadata',
      }),
    );
  }
  await session.repo.discardPrepared(token);
  return { saved: false, ack, envelope, issues };
}

/* ================================================================== *
 * H01 / H02：提交一轮推演
 * ================================================================== */

/**
 * prepareTurn → 提交锁内复核 revision → 保存确认 → confirmSaved → （之后）世界书同步。
 *
 * - 宿主保存失败：丢弃候选，报 `SESSION_WRITE_FAILED` 且 `coreSaved:false`；世界**不发布**。
 * - 世界书同步失败：核心数据已保存，回执明确「世界已更新，世界书待同步」（`WORLD_SYNC_FAILED`），
 *   绝不与 `COMMIT_FAILED` 混为一谈。
 */
export async function runSqlTurn(session: SqlSession, input: TurnInput): Promise<SqlTurnResult> {
  const commit = await session.repo.prepareTurn(input);
  return await commitPreparedTurn(session, commit);
}

/** H03：回退同样走「候选 → 提交锁复核 → 宿主确认」这一段。 */
export async function runSqlRollback(session: SqlSession, input: RollbackInput): Promise<SqlRollbackResult> {
  const commit = await session.repo.prepareRollback(input);
  const result = await commitPreparedTurn(session, commit);
  return { receipt: result.receipt, saved: result.saved, issues: result.issues, coreSaved: result.coreSaved };
}

async function commitPreparedTurn(session: SqlSession, commit: PreparedCommit): Promise<SqlTurnResult> {
  return await withChatCommitLock(session.chatUid, async () => {
    if (session.isCurrentHost && !session.isCurrentHost()) {
      await session.repo.discardPrepared(commit.token);
      throw new AtlasDbError('SESSION_STALE', '提交前宿主聊天、分支或快照已变化，候选已丢弃', {});
    }
    // §7.3：保存前再检查聊天身份、head、revision、单写者锁。
    const current = safeRevision(session.repo);
    if (commit.anchor.baseRevision !== current) {
      await session.repo.discardPrepared(commit.token);
      throw new AtlasDbError(
        'STALE_BASE',
        `提交前基版本已变化：候选基于 ${commit.anchor.baseRevision}，当前 ${current}（候选已丢弃，不覆盖新状态）`,
        { base: commit.anchor.baseRevision, current },
      );
    }
    const persisted = await persistSqlSession(session, { commit });
    const issues = [...persisted.issues];
    if (!persisted.saved) {
      if (persisted.ack?.result === 'failed') {
        await session.repo.discardPrepared(commit.token);
        if (!issues.some((i) => i.code === 'SESSION_WRITE_FAILED')) {
          issues.push(issue('SESSION_WRITE_FAILED', '宿主保存失败：本轮世界变更不发布（coreSaved=false）', 'error', false));
        }
      }
      return { receipt: commit.receipt, saved: false, commit, issues, coreSaved: false };
    }

    // 核心数据已由宿主确认保存：此后的世界书同步失败不改变 coreSaved。
    issues.push(...(await tryWorldSync(session, commit)));
    return { receipt: commit.receipt, saved: true, commit, issues, coreSaved: true };
  });
}

/** G13：保存确认后才做可重试同步；这里只把失败分类，结果落库由 /sql/maintenance 串行承担。 */
async function tryWorldSync(session: SqlSession, commit: PreparedCommit): Promise<Issue[]> {
  if (commit.kind !== 'turn') return [];
  if (!session.lorebookPort || !session.buildProjection) return [];
  const buildProjection = session.buildProjection;
  try {
    const outcome = await runNextSync(session.repo.db, session.lorebookPort, {
      branchId: session.branchId,
      chatUid: session.chatUid,
      nowWallMs: session.now(),
      buildProjection,
    });
    if (!outcome || outcome.status === 'succeeded') return [];
    // 只保留一条具名 WORLD_SYNC_FAILED（固定说法：世界已更新，世界书待同步），其它问题原样带上。
    return [
      ...outcome.issues.filter((item) => item.code !== 'WORLD_SYNC_FAILED'),
      worldSyncIssue(outcome.errorMessage ?? outcome.errorCode ?? '未知原因'),
    ];
  } catch (err) {
    return [worldSyncIssue((err as Error).message)];
  }
}

function worldSyncIssue(detail: string): Issue {
  return issue(
    'WORLD_SYNC_FAILED',
    `世界已更新，世界书待同步（核心数据已由宿主确认保存）：${detail.slice(0, 200)}`,
    'warning',
    true,
    { path: '$.sync_outbox' },
  );
}

/* ================================================================== *
 * E11–E14：把旧档一次性迁进 SQL（唯一一次迁移输入，之后旧档只读）
 * ================================================================== */

/**
 * 旧档迁移：`inspectLegacySession` → 实体 + 推演段 → `finalizeMigration` → 返回备份负载。
 *
 * - 损坏档**拒绝迁移**（绝不判成「没有数据」），也不建空世界。
 * - 备份只**构造负载**返回，由调用方存成附件；不写进每一楼、不重复备份。
 * - 已迁移过（已有实体行 / 已是新格式 / 已带旧载荷标记）再调一次不会重复插入、不重建世界。
 */
export async function migrateSessionToSql(
  options: SqlSessionOptions & { legacy: unknown },
): Promise<SqlMigrationResult> {
  const now = options.now ?? (() => Date.now());
  const issues: Issue[] = [];
  const inspection = inspectLegacySession(options.legacy);
  const backup = legacyBackupPayload(options.legacy, { capturedWallMs: now() });

  if (inspection.kind === 'corrupt') {
    issues.push(
      issue(
        'LEGACY_CORRUPT',
        `旧档损坏（${inspection.reason}）：拒绝迁移，先修复或导出旧档备份（不当作「没有数据」）`,
        'error',
        false,
        { path: '$.legacy' },
      ),
    );
    return { inspection, mapped: {}, backup, issues, session: null, saved: false, counts: {} };
  }

  const session = await openSqlSession(options);
  try {
    issues.push(...session.issues);
    if (inspection.kind === 'empty') {
      issues.push(
        issue('LEGACY_EMPTY', `旧档没有可迁移载荷（${inspection.reason}）：不重建世界、不建空实体`, 'warning', false, {
          path: '$.legacy',
        }),
      );
      return { inspection, mapped: {}, backup, issues, session, saved: false, counts: tableCounts(session.repo.db) };
    }

    const counts = tableCounts(session.repo.db);
    const entityRows =
      Number(counts.locations ?? 0) + Number(counts.characters ?? 0) + Number(counts.items ?? 0) + Number(counts.factions ?? 0);
    const alreadyApplied =
      inspection.kind === 'new_format' ||
      inspection.kind === 'already_migrated' ||
      entityRows > 0;
    if (alreadyApplied) {
      issues.push(
        issue(
          'MIGRATION_ALREADY_APPLIED',
          `目标分支已有 ${entityRows} 行实体，或旧档已标记为 ${inspection.kind}：不重复导入、不重建世界（旧档保留为备份）`,
          'warning',
          false,
          { path: '$.legacy' },
        ),
      );
      return { inspection, mapped: {}, backup, issues, session, saved: false, counts };
    }

    const turnId = session.repo.internal.currentHeadTurnId() ?? `turn_migration_${session.chatUid}`;
    const makeId = makeIdOf(session.repo);
    const nowWallMs = now();
    const entities = migrateLegacyEntities(inspection, options.legacy, session.repo.db, {
      branchId: session.branchId,
      turnId,
      makeId,
      nowWallMs,
      rulesetVersion: session.rulesetVersion,
      clockS: 0,
    });
    issues.push(...entities.issues);

    const simulation = migrateLegacySimulation(inspection, options.legacy, session.repo.db, {
      branchId: session.branchId,
      turnId,
      // 固定签名是 `(...args: never[]) => string`，内部按三参数调用（与 E13 一致）。
      makeId: makeId as unknown as (...args: never[]) => string,
      nowWallMs,
      rulesetVersion: session.rulesetVersion,
    });
    issues.push(...simulation.issues);

    const finalized = finalizeMigration(session.repo.db, { branchId: session.branchId });
    issues.push(...finalized.issues);

    session.source = 'migrated';
    let saved = false;
    if (options.persist !== false) {
      // 迁移结果走内部维护入口串行保存：不改 head/revision/clock，也不生成世界书同步任务。
      const maintenance = await session.repo.prepareMaintenance({ anchor: maintenanceAnchor(session, 'migration') });
      const persisted = await persistSqlSession(session, { commit: maintenance });
      issues.push(...persisted.issues);
      saved = persisted.saved;
    }

    return {
      inspection,
      mapped: { ...entities.mapped, ...simulation.mapped },
      backup,
      issues,
      session,
      saved,
      counts: tableCounts(session.repo.db),
    };
  } catch (err) {
    issues.push(
      issue(
        'MIGRATION_FAILED',
        `迁移失败：${(err as Error).message}（旧档保持原样，SQL 库为候选，不发布半成品）`,
        'error',
        true,
        { path: '$.legacy' },
      ),
    );
    return { inspection, mapped: {}, backup, issues, session, saved: false, counts: tableCounts(session.repo.db) };
  }
}

/* ================================================================== *
 * 关闭
 * ================================================================== */

/** 关闭会话与其正式库/候选库；重复调用不累积句柄。 */
export async function closeSqlSession(session: SqlSession): Promise<void> {
  if (session.closed) return;
  session.closed = true;
  await session.repo.close();
}

/* ================================================================== *
 * H13：SQL 运行时桥（**唯一**把 sql.js 拉进内存的入口）
 * ================================================================== */

/**
 * H13 注入用的 SQL 运行时函数集。
 *
 * 为什么要有这个对象：`atlas-server.ts` 属于**浏览器核心包**（`atlas-ui-core.mjs`，见
 * `src/atlas-browser-entry.ts`），而 sql.js/wasm 必须是独立产物（H14：体积大，启用 SQL 时才加载）。
 * 因此 server 核心只持有这个接口，运行时由宿主注入——本地模式从 `atlas-sql.mjs` 注入，
 * Node 模式注入自己那份；**server 核心本身不静态引用任何 sql.js 模块**。
 */
export type AtlasSqlRuntime = {
  openSqlSession: typeof openSqlSession;
  persistSqlSession: typeof persistSqlSession;
  runSqlTurn: typeof runSqlTurn;
  runSqlRollback: typeof runSqlRollback;
  migrateSessionToSql: typeof migrateSessionToSql;
  closeSqlSession: typeof closeSqlSession;
  retryFailedGroups: (input: FailedGroupRetryInput) => FailedGroupRetryResult;
  projectPromptView: (
    world: { db: SqlDatabase; branchId: string },
    query: { povId?: string | null; sceneLocationId?: string | null; actorIds?: string[]; viewMode?: 'pov' | 'author' },
  ) => { pov: PovProjection; portrayal: NarratorPortrayal | null; promptScope: string[] };
};

/**
 * 组装 SQL 运行时（只会在这个模块被加载时才执行 → sql.js 只随 SQL 产物进入内存）。
 * 宿主注入用：`sqlRuntime: await loadAtlasSqlRuntime()`。
 */
export async function loadAtlasSqlRuntime(): Promise<AtlasSqlRuntime> {
  const [retry, knowledge] = await Promise.all([
    import('./atlas-db-retry.ts'),
    import('./atlas-db-knowledge-view.ts'),
  ]);
  return {
    openSqlSession,
    persistSqlSession,
    runSqlTurn,
    runSqlRollback,
    migrateSessionToSql,
    closeSqlSession,
    retryFailedGroups: retry.retryFailedGroups,
    projectPromptView: knowledge.projectPromptView,
  };
}
