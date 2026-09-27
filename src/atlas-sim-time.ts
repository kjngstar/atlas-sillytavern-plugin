/**
 * atlas-sim-time.ts — F01 `deriveElapsedInterval`（§9.2 时间算法 / §16.7 时间首版确定规则）。
 *
 * 优先级（§16.7 原文）：
 *   明确持续时间/时刻变化 → 已完成旅行计算 → 已完成活动的范围估计 → 短对话 0 → 无法判断为 TIME_UNRESOLVED。
 * 规则：
 * - `explicitElapsedS` 最高优先：明确时间约束与动作估计冲突时，采用正文明确事实。
 * - 同区间活动取 max（`same_interval_as`，以及缺关系时的保守同区间），明确先后活动相加（`after_ref` 链）。
 * - `after_ref` 与 `same_interval_as` 互斥且无环；同时出现或有环时记入 `conflicts` 并退回同区间 max。
 * - **未知不是 0**（§2.1 / §16.2 / §16.7）：只要有一个「已完成」活动的时长无从判断，
 *   整体返回 `quality:'unknown'` + `basisRefs:['TIME_UNRESOLVED']`。
 *   本函数的返回类型固定为三个 number，因此这种情形下三个数值字段写 0 只作为**占位**，
 *   调用方必须读 `quality` 判断——0 值绝不能当作「本轮没有经过时间」使用（这正是 §2.1 禁止的「未知当 0」）。
 *   只有真正的零区间（短对话、未完成的活动、明确 elapsed=0）才返回 `quality:'explicit'` 的 0。
 * - 「打算睡觉」「刚吃一口」等未完成活动只贡献 `{0,0,0}`：计划不能让时钟前进。
 *
 * 本文件是纯函数：不读库、不取 `Date.now()`、不使用 `Math.random`。
 */

export type ElapsedFacts = {
  activities?: Array<{
    kind: 'dialogue' | 'meal' | 'rest' | 'sleep' | 'travel' | 'combat' | 'other';
    completed: boolean;
    hint?: { elapsed_s?: number; min_s?: number; max_s?: number; same_interval_as?: string; after_ref?: string; text?: string };
  }>;
  explicitElapsedS?: number | null;
};

export type ElapsedActivity = NonNullable<ElapsedFacts['activities']>[number];

export type ElapsedInterval = {
  minS: number;
  nominalS: number;
  maxS: number;
  quality: 'explicit' | 'estimated' | 'unknown';
  basisRefs: string[];
  conflicts: string[];
};

/** §16.7 活动默认区间（可调整的插件推演估计，不是现实通用定律）。 */
export const ACTIVITY_DEFAULTS: Record<string, { min_s: number; nominal_s: number; max_s: number }> = {
  dialogue: { min_s: 0, nominal_s: 0, max_s: 0 },
  meal: { min_s: 900, nominal_s: 1800, max_s: 3600 },
  rest: { min_s: 300, nominal_s: 1200, max_s: 3600 },
  sleep: { min_s: 14400, nominal_s: 28800, max_s: 36000 },
  combat: { min_s: 30, nominal_s: 120, max_s: 600 },
};

/** §16.7 查表；没有先验的种类（travel 由路程计算、other 无依据）返回 null，绝不补 0。 */
export function activityDefault(kind: string): { min_s: number; nominal_s: number; max_s: number } | null {
  const found = ACTIVITY_DEFAULTS[kind];
  return found ? { ...found } : null;
}

type Bound = { min: number; nominal: number; max: number };

const ZERO: Bound = { min: 0, nominal: 0, max: 0 };

type Node = {
  index: number;
  label: string;
  aliases: string[];
  /** null = 无从判断（未知），不是 0。 */
  interval: Bound | null;
  quality: 'explicit' | 'estimated' | 'unknown';
  basis: string[];
  /** 明确 0：未完成计划或 0 秒短对话。 */
  zero: boolean;
  afterRef: string | null;
  sameRef: string | null;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegative(value: unknown): number | null {
  const n = finite(value);
  return n !== null && n >= 0 ? n : null;
}

function normalize(bound: Bound): Bound {
  const min = Math.max(0, bound.min);
  const nominal = Math.max(min, bound.nominal);
  const max = Math.max(nominal, bound.max);
  return { min, nominal, max };
}

function add(a: Bound, b: Bound): Bound {
  return { min: a.min + b.min, nominal: a.nominal + b.nominal, max: a.max + b.max };
}

function maxBound(a: Bound, b: Bound): Bound {
  return { min: Math.max(a.min, b.min), nominal: Math.max(a.nominal, b.nominal), max: Math.max(a.max, b.max) };
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) if (value !== '' && !out.includes(value)) out.push(value);
  return out;
}

/** 运行时可能带 `ref`/`id`/`key` 额外字段：作为 after_ref / same_interval_as 的稳定指向。 */
function explicitRef(activity: ElapsedActivity): string | null {
  const raw = activity as unknown as Record<string, unknown>;
  for (const key of ['ref', 'id', 'key']) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

function buildNode(activity: ElapsedActivity, index: number, conflicts: string[]): Node {
  const kind = typeof activity?.kind === 'string' ? activity.kind : 'other';
  const label = `a${index}:${kind}`;
  const hint = isPlainObject(activity?.hint) ? activity.hint : {};
  const afterRef = typeof hint.after_ref === 'string' && hint.after_ref.trim() !== '' ? hint.after_ref : null;
  const sameRef = typeof hint.same_interval_as === 'string' && hint.same_interval_as.trim() !== '' ? hint.same_interval_as : null;
  if (afterRef && sameRef) {
    // 两者互斥（§16.7）；明确先后更强，这里保留 after_ref 并登记冲突。
    conflicts.push(`CONFLICT_AFTER_AND_SAME:${label}`);
  }

  const node: Node = {
    index,
    label,
    aliases: [label, `a${index}`],
    interval: null,
    quality: 'unknown',
    basis: [],
    zero: false,
    afterRef,
    sameRef: afterRef ? null : sameRef,
  };
  const ref = explicitRef(activity);
  if (ref) node.aliases.push(ref);

  if (!activity?.completed) {
    // 计划不是经过的时间：「打算睡觉」「刚吃一口」贡献 0。
    node.interval = { ...ZERO };
    node.quality = 'explicit';
    node.zero = true;
    node.basis.push(`INCOMPLETE_ACTIVITY_ZERO:${kind}`);
    return node;
  }

  const elapsed = nonNegative(hint.elapsed_s);
  if (elapsed !== null) {
    node.interval = { min: elapsed, nominal: elapsed, max: elapsed };
    node.quality = 'explicit';
    node.zero = elapsed === 0;
    node.basis.push(kind === 'travel' ? 'TRAVEL_COMPUTED' : 'HINT_ELAPSED');
    return node;
  }
  if (typeof hint.elapsed_s === 'number' && Number.isFinite(hint.elapsed_s) && hint.elapsed_s < 0) {
    conflicts.push(`HINT_ELAPSED_NEGATIVE:${label}`);
  }

  const hintNominal = nonNegative((hint as Record<string, unknown>).nominal_s);
  const minS = nonNegative(hint.min_s);
  const maxS = nonNegative(hint.max_s);
  if (minS !== null || maxS !== null || hintNominal !== null) {
    const min = minS ?? hintNominal ?? maxS ?? 0;
    const max = maxS ?? hintNominal ?? minS ?? 0;
    const nominal = hintNominal ?? (min + max) / 2;
    node.interval = normalize({ min, nominal, max });
    node.quality = 'estimated';
    node.basis.push(
      minS !== null && maxS !== null
        ? 'HINT_RANGE'
        : minS !== null
          ? 'HINT_MIN_ONLY'
          : maxS !== null
            ? 'HINT_MAX_ONLY'
            : 'HINT_NOMINAL_ONLY',
    );
    return node;
  }

  const fallback = activityDefault(kind);
  if (fallback) {
    if (kind === 'dialogue') {
      node.interval = { ...ZERO };
      node.quality = 'explicit';
      node.zero = true;
      node.basis.push('ACTIVITY_DEFAULT:dialogue');
      return node;
    }
    node.interval = normalize({ min: fallback.min_s, nominal: fallback.nominal_s, max: fallback.max_s });
    node.quality = 'estimated';
    node.basis.push(`ACTIVITY_DEFAULT:${kind}`);
    return node;
  }

  // travel 需要由路程/速度算出；other 需要叙述依据。缺失时保持未知。
  node.interval = null;
  node.quality = 'unknown';
  node.basis.push(`TIME_UNRESOLVED:${kind}`);
  return node;
}

/**
 * §16.7 / §9.2 时间区间推导。
 * 返回满足 `0 ≤ minS ≤ nominalS ≤ maxS`；`quality:'unknown'` 时三个数值字段只是占位（见文件头说明）。
 */
export function deriveElapsedInterval(facts: ElapsedFacts, base: { clockS: number }): ElapsedInterval {
  const conflicts: string[] = [];
  const clockRef = `clock_s:${finite(base?.clockS) ?? 0}`;

  const explicit = facts?.explicitElapsedS;
  if (explicit !== null && explicit !== undefined) {
    const value = nonNegative(explicit);
    if (value === null) {
      conflicts.push('EXPLICIT_ELAPSED_INVALID');
    } else {
      return {
        minS: value,
        nominalS: value,
        maxS: value,
        quality: 'explicit',
        basisRefs: ['EXPLICIT_ELAPSED', clockRef],
        conflicts,
      };
    }
  }

  const activities = Array.isArray(facts?.activities) ? facts.activities : [];
  const nodes = activities.map((activity, index) => buildNode(activity, index, conflicts));

  if (nodes.length === 0) {
    return { minS: 0, nominalS: 0, maxS: 0, quality: 'unknown', basisRefs: ['TIME_UNRESOLVED', clockRef], conflicts };
  }

  const unresolved = nodes.filter((n) => n.interval === null);
  if (unresolved.length > 0) {
    const basis = dedupe([...nodes.flatMap((n) => n.basis), 'TIME_UNRESOLVED', clockRef]);
    return { minS: 0, nominalS: 0, maxS: 0, quality: 'unknown', basisRefs: basis, conflicts };
  }

  // —— 引用解析：a<i> / 显式 ref / 唯一的 kind 名都可作为指向。
  const kindCount = new Map<string, number>();
  for (const node of nodes) {
    const kind = node.label.split(':')[1] ?? '';
    kindCount.set(kind, (kindCount.get(kind) ?? 0) + 1);
  }
  const refMap = new Map<string, number>();
  nodes.forEach((node) => {
    const kind = node.label.split(':')[1] ?? '';
    const aliases = [...node.aliases];
    if ((kindCount.get(kind) ?? 0) === 1) aliases.push(kind);
    for (const alias of aliases) if (!refMap.has(alias)) refMap.set(alias, node.index);
  });
  const resolve = (raw: string | null): number | null => {
    if (!raw) return null;
    const hit = refMap.get(raw);
    if (hit === undefined) {
      conflicts.push(`UNRESOLVED_ACTIVITY_REF:${raw}`);
      return null;
    }
    return hit;
  };

  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => {
    let cursor = i;
    while (parent[cursor] !== cursor) {
      parent[cursor] = parent[parent[cursor] as number] as number;
      cursor = parent[cursor] as number;
    }
    return cursor;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };

  const afterEdges: Array<{ from: number; to: number }> = [];
  let implicitSameGroup = false;
  for (const node of nodes) {
    if (node.sameRef) {
      if (node.sameRef === node.aliases[0] || node.sameRef === `a${node.index}`) {
        conflicts.push(`SAME_INTERVAL_SELF:${node.label}`);
        continue;
      }
      const target = resolve(node.sameRef);
      if (target !== null && target !== node.index) union(node.index, target);
    }
    if (node.afterRef) {
      const target = resolve(node.afterRef);
      if (target !== null && target !== node.index) afterEdges.push({ from: target, to: node.index });
      else if (target === node.index) conflicts.push(`AFTER_REF_SELF:${node.label}`);
    }
  }

  // —— 缺关系的活动按同区间保守处理（§16.7），标记 estimated 避免重复累计。
  const referenced = new Set<number>(afterEdges.map((e) => e.to));
  const unrelated = nodes.filter((n) => !n.afterRef && !referenced.has(n.index)).map((n) => n.index);
  if (unrelated.length > 1) {
    implicitSameGroup = true;
    for (let i = 1; i < unrelated.length; i += 1) union(unrelated[0] as number, unrelated[i] as number);
  }

  let groupOf = nodes.map((_, i) => find(i));
  let groupIds = [...new Set(groupOf)];
  let edges = afterEdges
    .map((e) => ({ from: find(e.from), to: find(e.to) }))
    .filter((e) => {
      if (e.from === e.to) {
        conflicts.push('ORDER_INSIDE_SAME_INTERVAL');
        return false;
      }
      return true;
    });

  // 环检测：有环则退回同区间 max（§16.7 无环要求）。
  const detectCycle = (): boolean => {
    const indeg = new Map<number, number>();
    for (const id of groupIds) indeg.set(id, 0);
    for (const e of edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    const queue = groupIds.filter((id) => (indeg.get(id) ?? 0) === 0);
    let seen = 0;
    while (queue.length > 0) {
      const id = queue.shift() as number;
      seen += 1;
      for (const e of edges) {
        if (e.from !== id) continue;
        const next = (indeg.get(e.to) ?? 0) - 1;
        indeg.set(e.to, next);
        if (next === 0) queue.push(e.to);
      }
    }
    return seen < groupIds.length;
  };

  if (edges.length > 0 && detectCycle()) {
    conflicts.push('CYCLE_AFTER_REF');
    edges = [];
    const root = groupOf[0] as number;
    for (const id of groupIds) union(root, id);
    groupOf = nodes.map((_, i) => find(i));
    groupIds = [...new Set(groupOf)];
    implicitSameGroup = true;
  }

  const groupBounds = new Map<number, Bound>();
  for (const node of nodes) {
    const id = groupOf[node.index] as number;
    const bound = node.interval as Bound;
    const previous = groupBounds.get(id);
    groupBounds.set(id, previous ? maxBound(previous, bound) : bound);
  }

  const predecessorBounds = (id: number): Bound => {
    const preds = edges.filter((e) => e.to === id);
    if (preds.length === 0) return { ...ZERO };
    let acc: Bound | null = null;
    for (const pred of preds) {
      const bound = finish.get(pred.from);
      if (!bound) continue;
      acc = acc ? maxBound(acc, bound) : bound;
    }
    return acc ?? { ...ZERO };
  };

  const indeg = new Map<number, number>();
  for (const id of groupIds) indeg.set(id, 0);
  for (const e of edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const ready = groupIds.filter((id) => (indeg.get(id) ?? 0) === 0);
  const finish = new Map<number, Bound>();
  while (ready.length > 0) {
    const id = ready.shift() as number;
    const own = groupBounds.get(id) ?? { ...ZERO };
    finish.set(id, add(predecessorBounds(id), own));
    for (const e of edges) {
      if (e.from !== id) continue;
      const next = (indeg.get(e.to) ?? 0) - 1;
      indeg.set(e.to, next);
      if (next === 0) ready.push(e.to);
    }
  }

  let total: Bound | null = null;
  for (const id of groupIds) {
    const bound = finish.get(id);
    if (!bound) continue;
    total = total ? maxBound(total, bound) : bound;
  }
  const resolved = normalize(total ?? { ...ZERO });

  const allExplicit = nodes.every((n) => n.quality === 'explicit');
  const estimated = nodes.some((n) => n.quality === 'estimated') || implicitSameGroup;
  const quality: ElapsedInterval['quality'] = allExplicit && !estimated ? 'explicit' : 'estimated';

  const basis = dedupe([...nodes.flatMap((n) => n.basis), ...(implicitSameGroup ? ['SAME_INTERVAL_INFERRED'] : []), clockRef]);

  return {
    minS: resolved.min,
    nominalS: resolved.nominal,
    maxS: resolved.max,
    quality,
    basisRefs: basis,
    conflicts,
  };
}
