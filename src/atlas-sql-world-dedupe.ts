/**
 * atlas-sql-world-dedupe.ts — M3-07：建设操作语义去重与依赖改写。
 *
 * 纪律（改这个文件前先读一遍）：
 * 1. 去重键：branchId + parent（解析后）+ kind + normalizeName(name)/aliases。
 *    先解析本批 new 父引用，再比较——否则「挂在新建父地下」的 child 永远匹配不上。
 * 2. 唯一旧匹配 → 复用该 ID，并把**所有**依赖该 new: 引用的位置一起改写；
 *    同父多个匹配 → LOCATION_NAME_AMBIGUOUS，整个依赖组拒绝（不能挑一个凑数）；
 *    不同父的同名 → **不合并**（外城区的「东门」不是城内的「东门」）。
 * 3. 本模块**不写 DB、不重新编号冻结 alias**：只做语义改写与诊断，落库由编译层负责。
 * 4. 显式新物件（模型明确说要新增的、名称在旧集合里不存在）不因同名而全局合并：
 *    只有「父 + kind + 名称」三者同时命中才算同一条。
 * 5. 名称为空的 location.upsert 直接拒绝：无法安全去重。
 */

import type { Issue, ModelOperation } from './atlas-ops-contract.ts';

export type DedupeWorldOpsInput = {
  operations: readonly ModelOperation[];
  /** 现有地点行（已解码的 locations 行）；由调用方从冻结目录读出。 */
  existingLocations?: readonly Record<string, unknown>[];
  /**
   * 本批 new: 引用 → 已确定的旧地点 ID。
   * 用于「先解析本批新父引用再比较」，也用于跨批次重试时复用上一轮已建成的地点。
   */
  newRefToExistingId?: Readonly<Record<string, string>>;
};

export type DedupeWorldOpResult = {
  operations: ModelOperation[];
  issues: Issue[];
  /** 复用到的旧地点：new: 引用 → 既有 ID。 */
  reusedIds: Array<{ ref: string; id: string; name: string; parentId: string | null }>;
  /** 因歧义被整体拒绝的依赖组（new: 引用清单）。 */
  rejectedRefs: string[];
};

function makeIssue(code: string, path: string, message: string, severity: 'warning' | 'error', retryable: boolean, opId?: string): Issue {
  const issue: Issue = { code, path, message, severity, retryable };
  if (opId !== undefined) issue.opId = opId;
  return issue;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function asId(value: unknown): string {
  return asText(value).trim();
}

/** 名称归一：去首尾空白、折叠内部空白、统一小写、剥掉常见包裹符号。 */
export function normalizeLocationName(name: unknown): string {
  return asText(name)
    .trim()
    .replace(/^[「『"'（(【\[]+|[」』"'）)】\]]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** 已解码行里的 aliases（可能是数组，也可能是 JSON 字符串）。 */
function aliasesOf(row: Record<string, unknown>): string[] {
  const raw = row.aliases_json ?? row.aliases;
  if (Array.isArray(raw)) return raw.map(asText);
  const text = asText(raw).trim();
  if (text.length === 0) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map(asText) : [];
  } catch {
    return [];
  }
}

type ExistingEntry = {
  id: string;
  parentId: string | null;
  kind: string;
  names: Set<string>;
};

function indexExisting(rows: readonly Record<string, unknown>[]): ExistingEntry[] {
  return rows
    .filter((row) => isPlainObject(row) && asId(row.id).length > 0)
    .map((row) => {
      const names = new Set<string>();
      const primary = normalizeLocationName(row.name);
      if (primary.length > 0) names.add(primary);
      for (const alias of aliasesOf(row)) {
        const normalized = normalizeLocationName(alias);
        if (normalized.length > 0) names.add(normalized);
      }
      return {
        id: asId(row.id),
        parentId: asId(row.parent_location_id) || null,
        kind: asText(row.kind).trim(),
        names,
      };
    });
}

/**
 * 建设操作语义去重（W03 / W11）。
 *
 * - 唯一旧匹配：new: 引用改写成既有 ID，依赖它的位置一并改写（子引用改到旧 ID）；
 * - 同父多匹配：LOCATION_NAME_AMBIGUOUS，拒绝整个依赖组；
 * - 不同父同名：不合并；
 * - 名称为空：拒绝。
 */
export function dedupeWorldConstructionOps(input: DedupeWorldOpsInput): DedupeWorldOpResult {
  const operations = Array.isArray(input?.operations) ? input.operations : [];
  const existing = indexExisting(input?.existingLocations ?? []);
  const issues: Issue[] = [];
  const reusedIds: DedupeWorldOpResult['reusedIds'] = [];
  const rejectedRefs: string[] = [];

  /** new: 引用 → 已解析出的旧地点 ID（复用）。 */
  const resolved = new Map<string, string>();
  for (const [ref, id] of Object.entries(input?.newRefToExistingId ?? {})) {
    if (asText(ref).trim().length > 0 && asText(id).trim().length > 0) resolved.set(asText(ref).trim(), asText(id).trim());
  }
  /** 本批声明的新地点：ref → 解析后的父（旧 ID / null）与 kind。 */
  const declared = new Map<string, { parentId: string | null; kind: string }>();
  /** 歧义 / 非法引用：这些 new: 及其依赖者整体拒绝。 */
  const poisoned = new Set<string>();

  const resolveParent = (ref: unknown): string | null => {
    const raw = asId(ref);
    if (raw.length === 0) return null;
    if (raw.startsWith('new:')) {
      const mapped = resolved.get(raw);
      return mapped ?? null;
    }
    return raw;
  };

  /* ── 第 1 遍：解析本批声明的 new 地点（父引用先解析，再比较） ── */
  for (const op of operations) {
    if (asText(op?.op).trim() !== 'location.upsert') continue;
    const ref = asId(op?.ref);
    if (!ref.startsWith('new:')) continue;
    const data = isPlainObject(op.data) ? op.data : {};
    const name = asText(data.name).trim();
    if (name.length === 0) {
      poisoned.add(ref);
      issues.push(makeIssue('LOCATION_NAME_REQUIRED', `$.operations.location.upsert.${ref}`, `${ref} 没有 name，无法安全去重；该操作与依赖它的操作一并拒绝。`, 'error', true, ref));
      continue;
    }
    // 复用映射里已经有这个 ref（调用方给的，或上一轮重试留下的）→ 直接算已解析
    if (resolved.has(ref)) continue;

    const parentId = resolveParent(data.parent_ref);
    const kind = asText(data.kind).trim();
    declared.set(ref, { parentId, kind });

    // 匹配：父 + kind + 名称/别名 三者同时命中
    const normalizedNames = new Set<string>([normalizeLocationName(name)]);
    // 本批同一 new 声明的别名也参与匹配
    const opAliases = data.aliases;
    if (Array.isArray(opAliases)) for (const alias of opAliases) {
      const normalized = normalizeLocationName(alias);
      if (normalized.length > 0) normalizedNames.add(normalized);
    }

    const matches = existing.filter((entry) => {
      if (entry.parentId !== parentId) return false; // 不同父不合并
      if (kind.length > 0 && entry.kind.length > 0 && entry.kind !== kind) return false;
      for (const candidate of entry.names) if (normalizedNames.has(candidate)) return true;
      return false;
    });

    if (matches.length === 1) {
      resolved.set(ref, matches[0].id);
      reusedIds.push({ ref, id: matches[0].id, name, parentId: matches[0].parentId });
      continue;
    }
    if (matches.length > 1) {
      poisoned.add(ref);
      issues.push(
        makeIssue(
          'LOCATION_NAME_AMBIGUOUS',
          `$.operations.location.upsert.${ref}.data.name`,
          `父地点 ${parentId ?? '（无父）'} 下存在 ${matches.length} 个同名/同别名地点（${matches.map((entry) => entry.id).join('、')}），无法确定复用哪个；整个依赖组拒绝，不挑一个凑数。`,
          'error',
          true,
          ref,
        ),
      );
      continue;
    }
    // 没有任何匹配 → 保持新建
  }

  /* ── 第 2 遍：依赖污染传播（引用被拒 new: 的操作整体出局） ── */
  const referencedNew = (op: ModelOperation): string[] => {
    const refs: string[] = [];
    const ref = asId(op?.ref);
    if (ref.startsWith('new:')) refs.push(ref);
    const data = isPlainObject(op?.data) ? op.data : {};
    for (const key of ['parent_ref', 'from_ref', 'to_ref', 'anchor_ref', 'location_ref', 'holder_ref', 'container_ref']) {
      const value = asId(data[key]);
      if (value.startsWith('new:')) refs.push(value);
    }
    return refs;
  };

  /* ── 第 3 遍：改写 + 输出 ── */
  const out: ModelOperation[] = [];
  for (const op of operations) {
    const refs = referencedNew(op);
    const blockedBy = refs.filter((ref) => poisoned.has(ref));
    if (blockedBy.length > 0) {
      for (const ref of blockedBy) if (!rejectedRefs.includes(ref)) rejectedRefs.push(ref);
      issues.push(
        makeIssue(
          'WORLD_DEPENDENCY_GROUP_REJECTED',
          `$.operations.${asText(op?.op)}`,
          `该操作依赖无法解析的新引用 ${blockedBy.join('、')}；依赖组整体拒绝，其余互不依赖的有效组仍可提交。`,
          'error',
          true,
          asId(op?.ref) || undefined,
        ),
      );
      continue;
    }

    const ref = asId(op?.ref);
    if (ref.startsWith('new:')) {
      const mapped = resolved.get(ref);
      if (mapped) {
        // 唯一旧匹配 → 复用到既有 ID，并同步改写父引用等依赖
        const data = isPlainObject(op.data) ? { ...op.data } : op.data;
        if (isPlainObject(data)) {
          if (resolved.has(asId(data.parent_ref))) data.parent_ref = resolved.get(asId(data.parent_ref));
          else if (asId(data.parent_ref).startsWith('new:') && declared.has(asId(data.parent_ref))) data.parent_ref = asId(data.parent_ref);
        }
        out.push({ ...op, ref: mapped, data });
        continue;
      }
    }

    const data = isPlainObject(op.data) ? { ...op.data } : op.data;
    if (isPlainObject(data)) {
      for (const key of ['parent_ref', 'from_ref', 'to_ref', 'anchor_ref', 'location_ref', 'holder_ref', 'container_ref']) {
        const value = asId(data[key]);
        if (value.startsWith('new:')) {
          const mapped = resolved.get(value);
          if (mapped) data[key] = mapped;
        }
      }
    }
    out.push(isPlainObject(op.data) ? { ...op, data } : op);
  }

  // 名称为空导致的中文重复诊断去重（同一 ref 只报一次）
  const dedupedIssues: Issue[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const key = `${issue.code}|${issue.path}|${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedIssues.push(issue);
  }

  return { operations: out, issues: dedupedIssues, reusedIds, rejectedRefs };
}
