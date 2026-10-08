/**
 * atlas-db-commit.ts — E05 applyGroups（§16.5 保存点算法）。
 *
 * 伪代码对齐：
 *   开启 foreign_keys；BEGIN
 *   写入候选 turn（此时不是已保存成功）
 *   for group in topologicalOrder:
 *     依赖失败 → blocked；幂等键已成功 → duplicate
 *     SAVEPOINT group_internal_id
 *     按固定 handler 应用全部参数化 SQL
 *     检查该组引用、行约束与涉及的不变量
 *     显式检查 foreign_key_check（不以 RELEASE 作为外键验证）
 *     成功：写 turn_changes、RELEASE   失败：ROLLBACK TO；RELEASE；记该组错误
 *   最终检查候选核心一致性、写回执和同步任务
 *   COMMIT；export → PreparedCommit
 */

import { runBound, savepoint, releaseSavepoint, rollbackToSavepoint, foreignKeyCheck, assertSafeIdentifier, AtlasDbError, queryBound } from './atlas-db-runtime.ts';
import { buildDeleteSql, buildInsertOrIgnoreSql, buildInsertSql, buildUpdateSql, encodePartialRow, encodeRow } from './atlas-db-codec.ts';
import { isKnownTable } from './atlas-db-schema.ts';
import { mergeGroupMutations, recordGroupChanges, mutationOperationKind, operationAlreadyApplied } from './atlas-db-journal.ts';
import { validateGroup } from './atlas-db-invariants.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { AtomicGroup, GroupResult, Issue, RowMutation } from './atlas-ops-contract.ts';
import type { AtlasTableName } from './atlas-db-contract.ts';

export type ApplyGroupsContext = {
  branchId: string;
  turnId: string;
  attemptId: string;
  /** 已经成功的幂等键（operation_id + table + row）。 */
  appliedKeys?: Set<string>;
  /** 是否执行组边界不变量检查（默认 true）。 */
  validate?: boolean;
  /** 是否写入变更日志（默认 true）。 */
  journal?: boolean;
};

export type ApplyGroupsResult = {
  groups: GroupResult[];
  appliedKeys: Set<string>;
  sequencesUsed: number;
  journalIssues: string[];
};

function issue(code: string, message: string, extra: Partial<Issue> = {}): Issue {
  return { code, path: '$', message, severity: 'error', retryable: true, ...extra };
}

function applyMutation(db: SqlDatabase, m: RowMutation, branchId: string): void {
  if (!isKnownTable(m.table)) throw new AtlasDbError('SQL_UNKNOWN_TABLE', `不在白名单的表：${m.table}`, { table: m.table });
  const table = m.table;
  assertSafeIdentifier(table);
  const kind = mutationOperationKind(m);

  if (kind === 'insert') {
    // entity_keys 只有三列、没有 C 列：用部分列插入校验（仍拒绝未知列）而不是完整行校验。
    const encoded = table === 'entity_keys'
      ? encodePartialRow(table, m.after!)
      : encodeRow(table, m.after!, { requireAll: true });
    if (!encoded.ok) {
      throw new AtlasDbError('CODEC_ENCODE_FAILED', `写入前编码失败：${encoded.issues.map((i) => i.path).join(', ')}`, {
        issues: encoded.issues,
      });
    }
    // entity_keys 是纯身份索引（无 C 列、无历史语义），重复声明不应让整组失败；
    // 其余表一律显式 INSERT，不用 INSERT OR REPLACE（§16.5 禁止通用 upsert）。
    const sql = table === 'entity_keys'
      ? buildInsertOrIgnoreSql(table, encoded.columns)
      : buildInsertSql(table, encoded.columns);
    runBound(db, sql, encoded.values as Array<string | number | null>);
    return;
  }
  if (kind === 'delete') {
    const params = table === 'branches' || table === 'turns' || table === 'turn_changes' || table === 'sync_outbox'
      ? [m.rowId]
      : [branchId, m.rowId];
    runBound(db, buildDeleteSql(table), params);
    return;
  }
  // update：用完整行覆盖（同组同行的 before/after 已在 journal 合并）。
  const encoded = encodeRow(table, m.after!, { requireAll: true });
  if (!encoded.ok) {
    throw new AtlasDbError('CODEC_ENCODE_FAILED', `写入前编码失败：${encoded.issues.map((i) => i.path).join(', ')}`, {
      issues: encoded.issues,
    });
  }
  const params = table === 'branches' || table === 'turns' || table === 'turn_changes' || table === 'sync_outbox'
    ? [...encoded.values, m.rowId]
    : [...encoded.values, branchId, m.rowId];
  runBound(db, buildUpdateSql(table, encoded.columns), params as Array<string | number | null>);
}

/**
 * E05 applyGroups。
 * 完成定义：验证失败回滚本组，依赖组不执行；成功/失败独立记账。
 */
export function applyGroups(
  db: SqlDatabase,
  orderedGroups: AtomicGroup[],
  ctx: ApplyGroupsContext,
): ApplyGroupsResult {
  const appliedKeys = ctx.appliedKeys ? new Set(ctx.appliedKeys) : new Set<string>();
  const results: GroupResult[] = [];
  const journalIssues: string[] = [];
  const validate = ctx.validate !== false;
  const journal = ctx.journal !== false;
  const blockedGroups = new Set<string>();
  let sequencesUsed = 0;
  let sequence = 1;

  // 该 turn 已用过的 sequence（重试/补交时接着排）。
  const maxSeq = queryBound(db, 'SELECT COALESCE(MAX(sequence), 0) AS m FROM turn_changes WHERE turn_id = ?', [ctx.turnId]);
  sequence = Number(maxSeq[0]?.m ?? 0) + 1;

  for (const group of orderedGroups) {
    const gid = group.id;
    const failedDep = group.dependsOn.find((dep) => {
      const r = results.find((x) => x.groupId === dep);
      return !r || r.status === 'rejected' || r.status === 'blocked';
    });
    if (failedDep || blockedGroups.has(gid)) {
      const root = failedDep ?? [...blockedGroups][0] ?? 'unknown';
      results.push({
        groupId: gid,
        opIds: group.opIds,
        status: 'blocked',
        issues: [issue('DEPENDENCY_FAILED', `上游组 ${root} 未成功：本组不执行`, { groupId: gid, dependencyId: root, retryable: true })],
        changedRows: 0,
      });
      blockedGroups.add(gid);
      continue;
    }

    // 幂等：同一成功操作重试只能返回 duplicate。
    const groupKeys = group.mutations.map((m) => `${m.table}\u0000${m.rowId}\u0000${m.sourceOpIds.join('+')}`);
    const allApplied = groupKeys.length > 0 && groupKeys.every((k) => appliedKeys.has(k));
    if (allApplied) {
      results.push({ groupId: gid, opIds: group.opIds, status: 'duplicate', issues: [], changedRows: 0 });
      continue;
    }
    const anyDuplicate = group.mutations.some(
      (m) =>
        operationAlreadyApplied(db, ctx.turnId, m.sourceOpIds.join('+'), m.table, m.rowId) ||
        groupKeys.some((k) => appliedKeys.has(k)),
    );

    // §8.5：编译期就报错的 op 不写库；同组其它有效 op 仍然提交，但整组状态是 rejected。
    const fatalOpIds = new Set((group.opIssues ?? []).filter((i) => i.severity === 'error' && i.opId).map((i) => String(i.opId)));
    const fatalIssues = (group.opIssues ?? []).filter((i) => i.severity === 'error');
    const writableMutations = group.mutations.filter((m) => !m.sourceOpIds.some((id) => fatalOpIds.has(id)));
    if (fatalIssues.length === 0 && group.mutations.length === 0) {
      // 零变更且无错误的组（例如 noop / 仅副作用）：不写库，也不记 applied。
      results.push({ groupId: gid, opIds: group.opIds, status: 'applied', issues: [], changedRows: 0 });
      blockedGroups.add(gid);
      continue;
    }
    if (fatalIssues.length > 0 && writableMutations.length === 0) {
      // 整组只有坏 op：不写库，记 rejected（依赖它的组一律 blocked）。
      blockedGroups.add(gid);
      results.push({
        groupId: gid,
        opIds: group.opIds,
        status: 'rejected',
        issues: fatalIssues.map((i) => ({ ...i, groupId: gid })),
        changedRows: 0,
      });
      continue;
    }

    const savepointName = `g_${gid.replace(/[^A-Za-z0-9_]/g, '_')}`;
    savepoint(db, savepointName);
    try {
      const merged = mergeGroupMutations(writableMutations);
      // §16.5：幂等键已成功就不执行，且**回执必须如实**——一行没写就不能报 applied/有变更行数。
      // 原来只在调用方回传 appliedKeys 时才报 duplicate；未回传时逐行被 already-applied 挡住，
      // 却仍按 merged.length 记 changedRows 并报 applied（谎报）。这里按实际写入数记账。
      let writtenRows = 0;
      for (const m of merged) {
        if (anyDuplicate && operationAlreadyApplied(db, ctx.turnId, m.sourceOpIds.join('+'), m.table, m.rowId)) {
          continue; // 该行已在本 turn 成功写入过，不重复执行。
        }
        for (const table of [m.table]) {
          if (!isKnownTable(table)) throw new AtlasDbError('SQL_UNKNOWN_TABLE', `不在白名单的表：${table}`, { table });
        }
        applyMutation(db, m, ctx.branchId);
        writtenRows += 1;
      }

      if (validate) {
        const tables = [...new Set(merged.map((m) => m.table))].filter((t): t is AtlasTableName => isKnownTable(t));
        const rowIds = [...new Set(merged.map((m) => m.rowId))];
        // M2-03：带上 before，组边界才能判断坏拓扑是本次候选引入/恶化还是旧档自带。
        const pendingRows = merged.map((m) => ({ table: m.table, rowId: m.rowId, row: m.after, before: m.before }));
        const validation = validateGroup(db, ctx.branchId, tables, rowIds, pendingRows);
        if (!validation.ok) {
          const violations = validation.violations.slice(0, 8).map((v) => `${v.code}@${v.table}.${v.field}`).join('; ');
          throw new AtlasDbError('INVARIANT_FAILED', `组边界不变量校验失败：${violations}`, {
            violations: validation.violations,
          });
        }
      }

      // 组边界只查本组写集。外键检查是全局的（PRAGMA foreign_key_check 无表过滤），
      // 中间组看不到尚未执行的后续组新建的实体行，因此外键在整批应用完成后、
      // COMMIT 之前由 applyGroups 统一显式检查一次（§16.5：不用 RELEASE 代替）。

      if (journal) {
        const rec = recordGroupChanges(
          db,
          { id: gid, mutations: merged, opIds: group.opIds },
          { turnId: ctx.turnId, attemptId: ctx.attemptId, startSequence: sequence },
        );
        journalIssues.push(...rec.issues);
        sequencesUsed += rec.written;
        sequence = rec.nextSequence;
      }

      releaseSavepoint(db, savepointName);
      for (const k of groupKeys) appliedKeys.add(k);
      // 一行未写 = duplicate（不是 applied）；写了才谈 changedRows。
      const nothingWritten = writtenRows === 0 && merged.length > 0;
      results.push({
        groupId: gid,
        opIds: group.opIds,
        status: fatalIssues.length > 0 ? 'rejected' : nothingWritten ? 'duplicate' : 'applied',
        issues: fatalIssues.map((i) => ({ ...i, groupId: gid })),
        changedRows: writtenRows,
      });
    } catch (err) {
      rollbackToSavepoint(db, savepointName);
      try {
        releaseSavepoint(db, savepointName);
      } catch {
        // 回滚后释放失败不影响本组记账；真正的错误在下面记录。
      }
      const dbErr = err as AtlasDbError;
      const code = dbErr.code ?? 'SQL_CONSTRAINT';
      results.push({
        groupId: gid,
        opIds: group.opIds,
        status: 'rejected',
        issues: [
          issue(code, dbErr.message ?? String(err), {
            groupId: gid,
            retryable: code !== 'INVARIANT_FAILED',
          }),
        ],
        changedRows: 0,
      });
      blockedGroups.add(gid);
    }
  }

  // §16.5：最终 COMMIT 前显式执行外键检查（不以 RELEASE SAVEPOINT 代替 deferred FK 检查）。
  // 此时整批组的写入都在同一事务里可见。
  const finalFk = foreignKeyCheck(db);
  if (finalFk.length > 0) {
    const summary = finalFk.map((v) => `${v.table}->${v.parent}`).join(', ');
    // 整个批次的外键失败：把最后成功写入的表对应组标记出来不可靠，
    // 因此明确作为一个独立错误返回，调用方（Repository）拒绝候选。
    return {
      groups: [
        ...results,
        {
          groupId: '__foreign_key_check__',
          opIds: [],
          status: 'rejected',
          issues: [
            issue('SQL_CONSTRAINT', `整批应用后外键检查未通过：${summary}`, {
              retryable: false,
            }),
          ],
          changedRows: 0,
        },
      ],
      appliedKeys,
      sequencesUsed,
      journalIssues,
    };
  }

  return { groups: results, appliedKeys, sequencesUsed, journalIssues };
}
