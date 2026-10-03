/**
 * atlas-ops-sources.ts — 依据绑定（C07；§2.3、§8.4、§16.6、§18.2 P01/P12、§18.4）。
 *
 * 硬边界：
 * - `source` 是**可选**的。省略时由程序绑定本次输入：observe/geography 绑 story/user 快照，
 *   decision/outcome/repair 记后台因果（simulation）。后台刺客准备行动不需要在主角正文里
 *   找到一句不存在的引文（§2.3、§16.6）。
 * - 本模块**永不**返回 QUOTE_REQUIRED / QUOTE_NOT_FOUND：没有逐字引文门槛。
 * - 从不伪造 span、从不假装找到了引文：定位失败就降级为 source_bound 并留 warning。
 * - `causes` 里只放已解析/已声明的 ID，绝不放 `new:` 别名（拿不到声明 ID 时留 warning，
 *   由调用者把 declareRefs 得到的确定性 ID 放进 ctx.causes）。
 */

import { WHY_MAX_CHARS } from './atlas-runtime-limits.ts';
import type { Issue, ModelOperation, Phase, SourceSnapshotEntry } from './atlas-ops-contract.ts';

export type BasisObject = {
  kind: 'story' | 'lorebook' | 'user' | 'simulation' | 'estimate' | 'migration';
  sources: Array<{
    source_key: string;
    content_hash: string;
    spans: Array<{ start: number; end: number }>;
    excerpt?: string;
  }>;
  causes: Array<{ kind: string; id: string }>;
  reason: string;
  verification: 'source_bound' | 'explicit_span' | 'causal' | 'unverified';
  certainty: 'confirmed' | 'inferred' | 'hypothetical';
};

export type SourceBindContext = {
  phase: Phase;
  snapshot: SourceSnapshotEntry[];
  clockS: number;
  /** Ephemeral, program-generated contacts; not character knowledge until accepted. */
  opportunities?: Array<{ id: string; receiverEntityId: string | null; informationId: string | null; atS: number }>;
  dueEventIds?: string[];
  causes?: Array<{ kind: string; id: string }>;
  /** 当前操作的确定性 ID（如 op_0_xxxxxxxx）：诊断与 repair 票据都要靠它定位（§16.8/§18.4）。 */
  opId?: string;
  /** 把本批已声明的 `new:` 别名解析成确定性 ID（前向引用合法，不该告警）。 */
  resolveAlias?: (alias: string) => string | null;
};

/* ───────────────────────── Issue 构造 ───────────────────────── */

function makeIssue(
  code: string,
  path: string,
  message: string,
  severity: 'warning' | 'error',
  retryable: boolean,
  opId?: string,
  line?: number,
): Issue {
  const issue: Issue = { code, path, message, severity, retryable };
  if (opId !== undefined) issue.opId = opId;
  if (line !== undefined) issue.line = line;
  return issue;
}

function truncateReason(text: string): string {
  const value = typeof text === 'string' ? text : '';
  return value.length > WHY_MAX_CHARS ? value.slice(0, WHY_MAX_CHARS) : value;
}

/* ───────────────────────── 辅助读取 ───────────────────────── */

function requestedSourceKeys(source: unknown): string[] {
  if (typeof source === 'string') {
    const trimmed = source.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (Array.isArray(source)) {
    const out: string[] = [];
    for (const item of source) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
    }
    return out;
  }
  return [];
}

/** 操作里可选的辅助引文（§8.4：`source` 不是必须逐字复制的 quote，但给了就要能定位）。 */
function opExcerpts(op: ModelOperation): string[] {
  const data = (op?.data ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ['excerpt', 'quote', 'evidence']) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) out.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.length > 0) out.push(item);
      }
    }
  }
  return out;
}

/** 心理/倾向类修改 → inferred（§16.6「记角色推断；不要求 quote」）。 */
const MENTAL_FIELDS: readonly string[] = [
  'thought',
  'action_tendency',
  'personality',
  'attention',
  'belief',
  'reaction_note',
  'reaction_goal',
  'attitude',
  'trust',
];

function isMentalUpdate(op: ModelOperation): boolean {
  const name = typeof op?.op === 'string' ? op.op : '';
  if (name === 'attention.propose') return true;
  if (name === 'plan.propose' || name === 'plan.revise') return true;
  const data = op?.data;
  if (!data || typeof data !== 'object') return false;
  const keys = Object.keys(data);
  if (keys.length === 0) return false;
  const mental = keys.filter((key) => MENTAL_FIELDS.includes(key));
  return mental.length > 0 && mental.length === keys.length;
}

/** 操作里可以派生因果的引用字段 → causes[].kind（§2.3 的 kind 白名单）。 */
const CAUSE_FIELD_KINDS: Record<string, string> = {
  action_ref: 'action',
  requires_action_ref: 'action',
  cause_action_ref: 'action',
  event_ref: 'event',
  target_event_ref: 'event',
  wait_for_event_ref: 'event',
  source_event_ref: 'event',
  information_ref: 'information',
  channel_ref: 'channel',
  route_ref: 'route',
  opportunity_ref: 'operation',
  location_ref: 'entity',
  target_location_ref: 'entity',
  anchor_ref: 'entity',
  headquarters_ref: 'entity',
  destination_ref: 'entity',
  spread_at_ref: 'entity',
  place_ref: 'entity',
  origin_ref: 'entity',
  via_refs: 'entity',
  from_ref: 'entity',
  to_ref: 'entity',
  holder_ref: 'entity',
  container_ref: 'entity',
  owner_ref: 'entity',
  sender_ref: 'entity',
  originator_ref: 'entity',
  actor_ref: 'entity',
  recipient_ref: 'entity',
  subject_ref: 'entity',
  object_ref: 'entity',
  entity_ref: 'entity',
  item_ref: 'entity',
  target_ref: 'entity',
  other_ref: 'entity',
};

function causeKindFor(op: ModelOperation, field: string): string {
  if (field === 'parent_ref') {
    return typeof op?.op === 'string' && op.op.startsWith('information.') ? 'information' : 'entity';
  }
  const table: Record<string, string | undefined> = CAUSE_FIELD_KINDS;
  return table[field] ?? 'entity';
}

function collectCauses(op: ModelOperation, ctx: SourceBindContext, issues: Issue[]): Array<{ kind: string; id: string }> {
  const out: Array<{ kind: string; id: string }> = [];
  const seen = new Set<string>();
  // 注意：不能用 op.op（那是操作名，如 'plan.propose'）冒充 opId——
  // 那会让 §16.8 的诊断无法定位到具体操作，也会让 repair 票据映射错位。
  const opId = typeof ctx.opId === 'string' && ctx.opId !== '' ? ctx.opId : undefined;
  const push = (kind: string, id: string): void => {
    const trimmed = typeof id === 'string' ? id.trim() : '';
    if (trimmed.length === 0) return;
    if (trimmed.startsWith('new:')) return;
    const key = `${kind}\u0000${trimmed}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, id: trimmed });
  };

  for (const cause of ctx.causes ?? []) {
    if (!cause || typeof cause !== 'object') continue;
    const id = typeof cause.id === 'string' ? cause.id.trim() : '';
    if (id.startsWith('new:')) {
      const resolved = ctx.resolveAlias ? ctx.resolveAlias(id.slice(4)) : null;
      if (resolved) {
        push(typeof cause.kind === 'string' ? cause.kind : 'entity', resolved);
        continue;
      }
      issues.push(
        makeIssue(
          'SOURCE_CAUSE_UNRESOLVED',
          '$.causes',
          `因果引用「${id}」仍是 new: 别名；causes 只接受已声明/已解析的 ID，` +
            '请调用方把 declareRefs 得到的确定性 ID 放进 ctx.causes。',
          'warning',
          false,
          opId,
        ),
      );
      continue;
    }
    push(typeof cause.kind === 'string' ? cause.kind : 'entity', id);
  }

  const data = (op?.data ?? {}) as Record<string, unknown>;
  for (const [field, value] of Object.entries(data)) {
    if (!(field in CAUSE_FIELD_KINDS) && field !== 'parent_ref') continue;
    const kind = causeKindFor(op, field);
    if (typeof value === 'string') {
      if (value.trim().startsWith('new:')) {
        const resolvedField = ctx.resolveAlias ? ctx.resolveAlias(value.trim().slice(4)) : null;
        if (resolvedField) {
          push(kind, resolvedField);
          continue;
        }
        issues.push(
          makeIssue(
            'SOURCE_CAUSE_UNRESOLVED',
            `$.data.${field}`,
            `因果字段「${field}」的值是未声明的 new: 别名，未写入 causes（causes 只放已声明的确定性 ID）。`,
            'warning',
            false,
            opId,
          ),
        );
        continue;
      }
      push(kind, value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') push(kind, item);
      }
    }
  }

  return out;
}

function defaultReason(op: ModelOperation, ctx: SourceBindContext): string {
  const name = typeof op?.op === 'string' && op.op.length > 0 ? op.op : '未知操作';
  if (ctx.phase === 'observe' || ctx.phase === 'geography') {
    return `${ctx.phase} 阶段按本次输入快照记录 ${name}。`;
  }
  return `${ctx.phase} 阶段按后台因果推进记录 ${name}。`;
}

function resolveCertainty(op: ModelOperation, ctx: SourceBindContext, boundCount: number): BasisObject['certainty'] {
  const data = (op?.data ?? {}) as Record<string, unknown>;
  // 世界书/推演里明确写成假设或假消息 → hypothetical（§16.6）
  if (data.existence_quality === 'hypothetical' || data.truth === 'false') return 'hypothetical';
  if (isMentalUpdate(op)) return 'inferred';
  if (ctx.phase === 'observe' || ctx.phase === 'geography') return boundCount > 0 ? 'confirmed' : 'inferred';
  return 'inferred';
}

/* ───────────────────────── C07：bindSources ───────────────────────── */

export function bindSources(op: ModelOperation, ctx: SourceBindContext): { basis: BasisObject; issues: Issue[] } {
  const issues: Issue[] = [];
  const keys = requestedSourceKeys(op?.source);
  const snapshot = Array.isArray(ctx?.snapshot) ? ctx.snapshot : [];
  const byKey = new Map<string, SourceSnapshotEntry>();
  for (const entry of snapshot) {
    if (!entry || typeof entry.key !== 'string') continue;
    const key = entry.key.trim();
    if (key.length > 0 && !byKey.has(key)) byKey.set(key, entry);
  }

  const causes = collectCauses(op, ctx, issues);
  const reason = truncateReason(
    typeof op?.why === 'string' && op.why.trim().length > 0 ? op.why : defaultReason(op, ctx),
  );

  /* —— 没填 source：按阶段绑定 —— */
  if (keys.length === 0) {
    if (ctx.phase === 'observe' || ctx.phase === 'geography') {
      const bound = snapshot.filter((entry) => entry && (entry.kind === 'story' || entry.kind === 'user'));
      const kind: BasisObject['kind'] = bound.some((entry) => entry.kind === 'story') ? 'story' : 'user';
      if (bound.length === 0) {
        issues.push(
          makeIssue(
            'SOURCE_SNAPSHOT_EMPTY',
            '$.source',
            `${ctx.phase} 阶段省略 source，但本次来源快照里没有 story/user 条目可绑定；` +
              '按 unverified 记录，不伪造来源也不阻塞该操作。',
            'warning',
            false,
          ),
        );
      }
      return {
        basis: {
          kind,
          sources:
            bound.length === 0
              ? []
              : bound.map((entry) => ({ source_key: entry.key, content_hash: entry.hash, spans: [] })),
          causes,
          reason,
          verification: bound.length === 0 ? 'unverified' : 'source_bound',
          certainty: resolveCertainty(op, ctx, bound.length),
        },
        issues,
      };
    }

    // decision / outcome / repair：后台因果，不去正文里找不存在的引文（§2.3、§16.6）
    return {
      basis: {
        kind: 'simulation',
        sources: [],
        causes,
        reason,
        verification: 'causal',
        certainty: resolveCertainty(op, ctx, 0),
      },
      issues,
    };
  }

  /* —— 填了 source：校验存在性，再尝试定位辅助引文 —— */
  const unknown: string[] = [];
  const boundEntries: SourceSnapshotEntry[] = [];
  for (const key of keys) {
    const entry = byKey.get(key);
    if (!entry) unknown.push(key);
    else boundEntries.push(entry);
  }
  if (unknown.length > 0) {
    issues.push(
      makeIssue(
        'SOURCE_UNKNOWN',
        '$.source',
        `请求的来源 ${unknown.map((key) => `「${key}」`).join('、')} 不在本次来源快照中；` +
          `可用来源：${snapshot.map((entry) => entry.key).join('、') || '（空）'}。不伪造引文。`,
        'error',
        true,
        typeof op?.op === 'string' ? op.op : undefined,
      ),
    );
  }

  const excerpts = opExcerpts(op);
  let locatedAny = false;
  let missedAny = false;
  const sources: BasisObject['sources'] = [];

  for (const entry of boundEntries) {
    const text = typeof entry.text === 'string' ? entry.text : '';
    const spans: Array<{ start: number; end: number }> = [];
    let excerpt: string | undefined;
    const seenSpans = new Set<string>();
    for (const candidate of excerpts) {
      const at = text.indexOf(candidate);
      if (at < 0) {
        missedAny = true;
        issues.push(
          makeIssue(
            'SOURCE_EXCERPT_NOT_FOUND',
            '$.source',
            `在来源「${entry.key}」中找不到引文（前 ${Math.min(24, candidate.length)} 字：` +
              `「${candidate.slice(0, 24)}」）；保留该来源并降级为 source_bound，不编造 span。`,
            'warning',
            false,
            typeof op?.op === 'string' ? op.op : undefined,
          ),
        );
        continue;
      }
      locatedAny = true;
      if (excerpt === undefined) excerpt = candidate;
      const span = { start: at, end: at + candidate.length };
      const spanKey = `${span.start}:${span.end}`;
      if (!seenSpans.has(spanKey)) {
        seenSpans.add(spanKey);
        spans.push(span);
      }
    }
    spans.sort((left, right) => left.start - right.start || left.end - right.end);
    const item: BasisObject['sources'][number] = {
      source_key: entry.key,
      content_hash: typeof entry.hash === 'string' ? entry.hash : '',
      spans,
    };
    if (excerpt !== undefined) item.excerpt = excerpt;
    sources.push(item);
  }

  const primaryKind: BasisObject['kind'] = boundEntries.length > 0 ? boundEntries[0].kind : 'simulation';
  const verification: BasisObject['verification'] =
    locatedAny && !missedAny ? 'explicit_span' : boundEntries.length > 0 ? 'source_bound' : 'unverified';

  return {
    basis: {
      kind: primaryKind,
      sources,
      causes,
      reason,
      verification,
      certainty: resolveCertainty(op, ctx, boundEntries.length),
    },
    issues,
  };
}

/** 没有可用依据时的空依据：宁可 unverified，也不伪装成已绑定。 */
export function emptyBasis(kind: BasisObject['kind'], reason: string): BasisObject {
  return {
    kind,
    sources: [],
    causes: [],
    reason: truncateReason(reason),
    verification: 'unverified',
    certainty: 'inferred',
  };
}
