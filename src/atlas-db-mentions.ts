/**
 * atlas-db-mentions.ts — E15 updateMentionCandidates / promoteMention（§6.5 / §17E）。
 *
 * 本文件是 `mention_candidates`（临时提及候选）生命周期的**唯一权威**：
 * - `distinct_turn_count` 按**去重后的出现楼层**计数：重试同一楼不加第二次；
 * - `recent_turn_ids_json` 最多 8 条；`context_summary` 至多 200 字；`lorebook_source_keys_json` 至多 8 个；
 * - `normalized_name` 只是搜索辅助，**不是永久唯一身份**：同名不同 `context_key` 必须是两条候选，
 *   绝不按名字合并；
 * - `importance_hint`：重要人物或带**实质**世界书资料的角色可以首楼就标 `core`；出现两次只触发
 *   **评估**（`review`），不强迫建档；
 * - 未建档候选超过 256 时优先淘汰「长期未出现且没有重要依据」的（`importance_hint === 'none'`
 *   且 `last_turn_id` 最旧）；淘汰写 `status: 'dismissed'` 并把该变更记到**当前 turn**（保证可回退）；
 *   `importance_hint === 'core'` 的候选**永不自动淘汰**；
 * - 本函数**不写库**：只返回 `RowMutation[]`，由调用方放进当前组的同一事务；
 *   命中已有候选时 `before` 必须是**读到的原行**。
 */

import { decodeRow } from './atlas-db-codec.ts';
import { createRow } from './atlas-db-defaults.ts';
import { AtlasDbError, queryBound } from './atlas-db-runtime.ts';
import type { TableReadPort } from './atlas-ops-compile-types.ts';
import { normalizeName } from './atlas-ops-entities.ts';
import {
  ATLAS_RUNTIME_LIMITS,
  MENTION_CONTEXT_SUMMARY_CHARS,
  MENTION_LOREBOOK_LIMIT,
  MENTION_RECENT_LIMIT,
} from './atlas-runtime-limits.ts';
import type { SqlDatabase } from './atlas-db-runtime.ts';
import type { Issue, RowMutation } from './atlas-ops-contract.ts';

/** §6.5 / §16.2：未建档候选上限（单一来源 = ATLAS_RUNTIME_LIMITS.mentionCandidates）。 */
export const MENTION_CANDIDATE_LIMIT: number = ATLAS_RUNTIME_LIMITS.mentionCandidates;

/** §6.5：`recent_turn_ids_json` 最多保留 8 条（单一来源 = ATLAS_FIELD_LIMITS.mentionRecentLimit）。 */
export const MENTION_RECENT_TURNS_LIMIT: number = MENTION_RECENT_LIMIT;

export type MentionKindHint = 'character' | 'location' | 'item' | 'faction' | 'unknown';
export type MentionImportanceHint = 'none' | 'review' | 'core';

export type MentionObservation = {
  name: string;
  kindHint: MentionKindHint;
  identity?: string;
  contextSummary?: string;
  lorebookSourceKeys?: string[];
  importanceHint?: MentionImportanceHint;
  /** 该名字在**本楼**是否已计过一次。 */
  alreadyCountedThisTurn?: boolean;
};

export type MentionUpdateInput = {
  /** 持有真实连接的调用方（repository / 迁移 / 测试）。与 `reads` 二者必居其一。 */
  db?: SqlDatabase;
  /**
   * 只读端口：编译器没有 SqlDatabase（它被刻意设计成纯函数、不写 SQL），
   * 之前把端口 cast 成 db 会让内部查询抛错、整条 op 退化成 INTERNAL_ERROR。
   * 提供它以后，编译器也能走同一套候选生命周期规则。
   */
  reads?: TableReadPort;
  branchId: string;
  turnId: string;
  clockS: number;
  nowWallMs: number;
  rulesetVersion: string;
  observations: MentionObservation[];
  makeId: (kind: string, opId: string, alias: string) => string;
};

export type MentionUpdateResult = {
  mutations: RowMutation[];
  created: number;
  updated: number;
  /** 已建档（`status = 'promoted'`）的候选 id：它们不参与上限回收。 */
  promoted: string[];
  /** 本次被淘汰（写 `dismissed`）的候选 id。 */
  evicted: string[];
  issues: Issue[];
};

type Row = Record<string, unknown>;

const KIND_HINTS: readonly MentionKindHint[] = ['character', 'location', 'item', 'faction', 'unknown'];
const IMPORTANCE_HINTS: readonly MentionImportanceHint[] = ['none', 'review', 'core'];
const IMPORTANCE_RANK: Record<MentionImportanceHint, number> = { none: 0, review: 1, core: 2 };

function warning(code: string, path: string, message: string, extra: Partial<Issue> = {}): Issue {
  return { code, path, message, severity: 'warning', retryable: false, ...extra };
}

function decodeMentionRow(raw: Record<string, unknown>): Row {
  const decoded = decodeRow('mention_candidates', raw, { allowExtra: true });
  if (!decoded.ok) {
    throw new AtlasDbError('CODEC_DECODE_FAILED', `mention_candidates 行解码失败：${decoded.issues.map((i) => i.path).join(', ')}`, {
      issues: decoded.issues,
    });
  }
  return decoded.row as Row;
}

/** E15 需要的三种读：按名取候选、取 watching 候选、取楼层墙钟时间。 */
type MentionReader = {
  candidatesByName(branchId: string, normalizedName: string): Row[];
  watchingCandidates(branchId: string): Row[];
  turnWallTimes(branchId: string): Map<string, number>;
};

function readerFromDb(db: SqlDatabase): MentionReader {
  return {
    candidatesByName: (branchId, normalizedName) =>
      readCandidates(db, branchId, 'normalized_name = ?', [normalizedName]),
    watchingCandidates: (branchId) => readCandidates(db, branchId, "status = 'watching'"),
    turnWallTimes: (branchId) => turnWallTimes(db, branchId),
  };
}

/**
 * 端口实现：`selectWhere` 已经返回解码后的行，因此这里不再二次 decode；
 * 「长期未出现」所需的楼层墙钟时间在 JS 里排序（端口不暴露 ORDER BY）。
 */
function readerFromPort(reads: TableReadPort): MentionReader {
  const rows = (where: Record<string, unknown>, limit: number): Row[] =>
    reads.selectWhere('mention_candidates', where, limit) as unknown as Row[];
  return {
    candidatesByName: (branchId, normalizedName) =>
      rows({ branch_id: branchId, normalized_name: normalizedName }, 1000),
    watchingCandidates: (branchId) => rows({ branch_id: branchId, status: 'watching' }, 1000),
    turnWallTimes: (branchId) => {
      const turns = reads.selectWhere('turns', { branch_id: branchId }, 5000) as Array<Record<string, unknown>>;
      const out = new Map<string, number>();
      for (const row of turns) {
        const wall = Number(row.created_wall_ms);
        out.set(String(row.id), Number.isFinite(wall) ? wall : 0);
      }
      return out;
    },
  };
}
function readCandidates(db: SqlDatabase, branchId: string, where = '', params: Array<string | number | null> = []): Row[] {
  const rows = queryBound(
    db,
    `SELECT * FROM mention_candidates WHERE branch_id = ?${where ? ` AND ${where}` : ''} ORDER BY id ASC`,
    [branchId, ...params],
  );
  return rows.map(decodeMentionRow);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
}

function clampSummary(text: string): string {
  return text.trim().slice(0, MENTION_CONTEXT_SUMMARY_CHARS);
}

function uniqueStrings(values: string[], limit: number): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (value.length === 0 || out.includes(value)) continue;
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

/** 观察去重：同一 (normalized name, context key) 在同一次调用里只处理一次。 */
function dedupeObservations(observations: MentionObservation[]): MentionObservation[] {
  const seen = new Set<string>();
  const out: MentionObservation[] = [];
  for (const observation of observations) {
    const name = typeof observation?.name === 'string' ? observation.name.trim() : '';
    if (name.length === 0) continue;
    const key = `${normalizeName(name)}\u0000${(observation.identity ?? '').trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(observation);
  }
  return out;
}

function basisFor(turnId: string, reason: string, hasEvidence: boolean): Record<string, unknown> {
  return {
    kind: 'story',
    sources: [],
    causes: [{ kind: 'turn', id: turnId }],
    reason,
    verification: hasEvidence ? 'source_bound' : 'causal',
    certainty: hasEvidence ? 'confirmed' : 'inferred',
  };
}

/** §6.5：实质世界书资料 = 至少一条来源引用，且带身份线索（不是只出现一个名字）。 */
function hasSubstantialLorebook(observation: MentionObservation, sourceKeys: string[]): boolean {
  const clue = `${observation.identity ?? ''}${observation.contextSummary ?? ''}`.trim();
  return sourceKeys.length > 0 && clue.length > 0;
}

function desiredImportance(
  observation: MentionObservation,
  sourceKeys: string[],
  distinctTurnCount: number,
): MentionImportanceHint {
  const hint = observation.importanceHint && IMPORTANCE_HINTS.includes(observation.importanceHint) ? observation.importanceHint : 'none';
  if (hint === 'core' || hasSubstantialLorebook(observation, sourceKeys)) return 'core';
  // 出现两次只触发评估，不强迫建档。
  if (distinctTurnCount >= 2) return 'review';
  return hint === 'review' ? 'review' : 'none';
}

function maxImportance(a: unknown, b: MentionImportanceHint): MentionImportanceHint {
  const left = typeof a === 'string' && IMPORTANCE_HINTS.includes(a as MentionImportanceHint) ? (a as MentionImportanceHint) : 'none';
  return IMPORTANCE_RANK[left] >= IMPORTANCE_RANK[b] ? left : b;
}

/**
 * E15 updateMentionCandidates。
 * 返回 `RowMutation[]`（不直接写库），由调用方放进当前组；命中已有候选时 `before` 是读到的原行。
 */
export function updateMentionCandidates(input: MentionUpdateInput): MentionUpdateResult {
  const issues: Issue[] = [];
  const mutations: RowMutation[] = [];
  if (!input.db && !input.reads) {
    throw new AtlasDbError(
      'MENTION_READ_SOURCE_REQUIRED',
      'updateMentionCandidates 需要 db 或 reads 之一（只读端口即可，不能两者都缺）',
      { branchId: input.branchId },
    );
  }
  const reader: MentionReader = input.reads ? readerFromPort(input.reads) : readerFromDb(input.db as SqlDatabase);
  const branchId = input.branchId;
  const turnId = input.turnId;
  const makeId = input.makeId;
  const observations = dedupeObservations(input.observations ?? []);

  const byName = new Map<string, Row[]>();
  const projected = new Map<string, Row>();
  const createdInBatch = new Set<string>();
  const promoted: string[] = [];
  let created = 0;
  let updated = 0;

  for (const observation of observations) {
    const name = observation.name.trim();
    const normalized = normalizeName(name);
    if (normalized.length === 0) {
      issues.push(warning('MENTION_NAME_REQUIRED', '$.observations.name', '候选必须有非空 name'));
      continue;
    }
    const contextKey = (observation.identity ?? '').trim();
    const summary = clampSummary(observation.contextSummary ?? observation.identity ?? '');
    const sourceKeys = uniqueStrings(stringList(observation.lorebookSourceKeys), MENTION_LOREBOOK_LIMIT);
    if (observation.kindHint !== undefined && !KIND_HINTS.includes(observation.kindHint)) {
      issues.push(warning('MENTION_KIND_INVALID', '$.observations.kindHint', `kind_hint 非法：${String(observation.kindHint)}`, { retryable: true }));
    }
    if (observation.importanceHint !== undefined && !IMPORTANCE_HINTS.includes(observation.importanceHint)) {
      issues.push(
        warning('MENTION_IMPORTANCE_INVALID', '$.observations.importanceHint', `importance_hint 非法：${String(observation.importanceHint)}`, {
          retryable: true,
        }),
      );
    }

    if (!byName.has(normalized)) byName.set(normalized, reader.candidatesByName(branchId, normalized));
    const rows = byName.get(normalized)!;

    // 同名区分：先精确匹配 context_key；只有一条且上下文可补全时复用它；
    // 两条非空且不同的 context_key → 各自一条候选，绝不按名字合并。
    const exact = rows.find((row) => String(row.context_key ?? '') === contextKey);
    const compatible = rows.filter((row) => {
      const existingKey = String(row.context_key ?? '');
      if (existingKey.length === 0 || contextKey.length === 0) return true;
      return existingKey === contextKey;
    });
    const existing = exact ?? (compatible.length === 1 ? compatible[0] : null);

    if (!existing) {
      const id = makeId('mention', contextKey.length > 0 ? contextKey : normalized, `mention:${normalized}:${observation.kindHint ?? 'unknown'}`);
      const row = createRow(
        'mention_candidates',
        {
          name,
          normalized_name: normalized,
          context_key: contextKey,
          kind_hint: observation.kindHint ?? 'unknown',
          first_turn_id: turnId,
          last_turn_id: turnId,
          distinct_turn_count: 1,
          recent_turn_ids_json: [turnId],
          context_summary: summary,
          lorebook_source_keys_json: sourceKeys,
          importance_hint: desiredImportance(observation, sourceKeys, 1),
          promoted_entity_id: null,
          status: 'watching',
        },
        { branchId, id, turnId, clockS: input.clockS, nowWallMs: input.nowWallMs, rulesetVersion: input.rulesetVersion },
      );
      mutations.push({
        table: 'mention_candidates',
        rowId: id,
        before: null,
        after: row,
        sourceOpIds: [`mention.observe:${id}`],
        basis: basisFor(turnId, `首次提及「${name}」（${observation.kindHint ?? 'unknown'}）`, summary.length > 0 || sourceKeys.length > 0),
      });
      projected.set(id, row);
      createdInBatch.add(id);
      created += 1;
      continue;
    }

    const id = String(existing.id);
    const recent = uniqueStrings(stringList(existing.recent_turn_ids_json), MENTION_RECENT_TURNS_LIMIT);
    const alreadyCounted = observation.alreadyCountedThisTurn === true || recent.includes(turnId);
    const distinctBefore = Math.max(1, Number(existing.distinct_turn_count ?? 1) || 1);
    const distinctTurnCount = alreadyCounted ? distinctBefore : distinctBefore + 1;
    // 最近至多 8 条：保留**最新**的 8 次（不是最早的 8 次）。
    const recentAfter = alreadyCounted
      ? recent
      : [...recent.filter((value) => value !== turnId), turnId].slice(-MENTION_RECENT_TURNS_LIMIT);
    const status = String(existing.status ?? 'watching');
    const lorebookAfter = uniqueStrings([...stringList(existing.lorebook_source_keys_json), ...sourceKeys], MENTION_LOREBOOK_LIMIT);

    const after: Row = {
      ...existing,
      last_turn_id: turnId,
      distinct_turn_count: distinctTurnCount,
      recent_turn_ids_json: recentAfter,
      context_key: String(existing.context_key ?? '').length > 0 ? existing.context_key : contextKey,
      kind_hint: observation.kindHint && observation.kindHint !== 'unknown' ? observation.kindHint : existing.kind_hint,
      context_summary: summary.length > 0 ? summary : existing.context_summary,
      lorebook_source_keys_json: lorebookAfter,
      importance_hint: maxImportance(existing.importance_hint, desiredImportance(observation, lorebookAfter, distinctTurnCount)),
      // 再次出现时把曾被淘汰的候选放回 watching；已建档（promoted）的候选保持指向实体。
      status: status === 'dismissed' ? 'watching' : status,
    };
    mutations.push({
      table: 'mention_candidates',
      rowId: id,
      before: existing,
      after,
      sourceOpIds: [`mention.observe:${id}`],
      basis: basisFor(
        turnId,
        `${alreadyCounted ? '同一楼重试' : '再次提及'}「${name}」：distinct_turn_count=${distinctTurnCount}`,
        summary.length > 0 || lorebookAfter.length > 0,
      ),
    });
    projected.set(id, after);
    updated += 1;
    if (String(after.status) === 'promoted' && !promoted.includes(id)) promoted.push(id);
  }

  // —— §6.5 上限回收：未建档候选（watching）超过 256 时优先淘汰长期未出现且无重要依据的 ——
  const watchingRows = reader.watchingCandidates(branchId);
  const watchingIds = new Set(watchingRows.map((row) => String(row.id)));
  const watchingAfter: Row[] = [];
  for (const row of watchingRows) {
    const id = String(row.id);
    const after = projected.get(id) ?? row;
    if (String(after.status) === 'watching') watchingAfter.push(after);
  }
  for (const [id, row] of projected) {
    if (watchingIds.has(id)) continue; // 已在 DB watching 集合里（上面按投影算过）
    if (String(row.status) === 'watching') watchingAfter.push(row);
  }

  const over = watchingAfter.length - MENTION_CANDIDATE_LIMIT;
  const evicted: string[] = [];
  if (over > 0) {
    const wallOf = reader.turnWallTimes(branchId);
    const evictable = watchingAfter
      .filter((row) => !createdInBatch.has(String(row.id)))
      .filter((row) => String(row.importance_hint ?? 'none') !== 'core')
      .sort((a, b) => {
        const rankA = String(a.importance_hint ?? 'none') === 'none' ? 0 : 1;
        const rankB = String(b.importance_hint ?? 'none') === 'none' ? 0 : 1;
        if (rankA !== rankB) return rankA - rankB;
        const lastA = String(a.last_turn_id ?? '');
        const lastB = String(b.last_turn_id ?? '');
        const wallA = wallOf.get(lastA) ?? 0;
        const wallB = wallOf.get(lastB) ?? 0;
        if (wallA !== wallB) return wallA - wallB;
        return lastA < lastB ? -1 : lastA > lastB ? 1 : 0;
      });
    for (const row of evictable) {
      if (evicted.length >= over) break;
      const id = String(row.id);
      const after: Row = {
        ...row,
        // 淘汰也记到当前 turn：变更属于本楼，回退时一并恢复（不是「悄悄消失」）。
        last_turn_id: turnId,
        status: 'dismissed',
      };
      mutations.push({
        table: 'mention_candidates',
        rowId: id,
        before: row,
        after,
        sourceOpIds: [`mention.evict:${id}`],
        basis: basisFor(turnId, `候选上限 ${MENTION_CANDIDATE_LIMIT} 回收：「${String(row.name ?? '')}」长期未出现且无重要依据`, false),
      });
      projected.set(id, after);
      evicted.push(id);
    }
    const remaining = watchingAfter.length - evicted.length;
    issues.push(
      warning(
        'MENTION_EVICTED',
        '$.mention_candidates',
        `未建档候选 ${watchingAfter.length} 超过上限 ${MENTION_CANDIDATE_LIMIT}：淘汰 ${evicted.length} 条` +
          `（理由：importance_hint=none 且 last_turn_id 最旧；core/promoted 不淘汰）；剩余 ${remaining}`,
        { retryable: false },
      ),
    );
  }

  return { mutations, created, updated, promoted, evicted, issues };
}

/** turnId → created_wall_ms（「长期未出现」按真实楼层时间比较，不按 ID 字符串猜）。 */
function turnWallTimes(db: SqlDatabase, branchId: string): Map<string, number> {
  const rows = queryBound(db, 'SELECT id, created_wall_ms FROM turns WHERE branch_id = ?', [branchId]);
  const out = new Map<string, number>();
  for (const row of rows) {
    const wall = Number(row.created_wall_ms);
    out.set(String(row.id), Number.isFinite(wall) ? wall : 0);
  }
  return out;
}

/**
 * E15 promoteMention：正式建档后把候选置 `promoted` 并写 `promoted_entity_id`。
 * `entityId` 必须已在 `entity_keys`（否则 `REF_UNKNOWN`）；候选行不存在同样 `REF_UNKNOWN`。
 * 返回的 `RowMutation` 由调用方放进当前组（与建档同批提交）。
 */
export function promoteMention(db: SqlDatabase, branchId: string, mentionId: string, entityId: string): RowMutation {
  const key = queryBound(db, 'SELECT kind FROM entity_keys WHERE branch_id = ? AND id = ? LIMIT 1', [branchId, entityId]);
  if (key.length === 0) {
    throw new AtlasDbError('REF_UNKNOWN', `promoteMention 的实体身份不存在：${entityId}`, { branchId, mentionId, entityId });
  }
  const rows = queryBound(db, 'SELECT * FROM mention_candidates WHERE branch_id = ? AND id = ? LIMIT 1', [branchId, mentionId]);
  if (rows.length === 0) {
    throw new AtlasDbError('REF_UNKNOWN', `找不到提及候选：${mentionId}`, { branchId, mentionId, entityId });
  }
  const before = decodeMentionRow(rows[0]);
  const after: Row = { ...before, status: 'promoted', promoted_entity_id: entityId };
  return {
    table: 'mention_candidates',
    rowId: mentionId,
    before,
    after,
    sourceOpIds: [`mention.promote:${mentionId}`],
    basis: {
      kind: 'story',
      sources: [],
      causes: [{ kind: String(key[0].kind ?? 'character'), id: entityId }],
      reason: `提及候选「${String(before.name ?? mentionId)}」正式建档为实体 ${entityId}`,
      verification: 'causal',
      certainty: 'confirmed',
    },
  };
}
