/**
 * atlas-world-fact-policy.ts — 来源断言、静态优先与状态演变（P01）。
 *
 * 来源：Atlas 全局建图与空间行为开发执行计划 v2 §5.3、§7「冲突真值表」。
 *
 * 这一层只回答一个问题：**同一主体同一断言，谁说了算，为什么**。
 * 它不写 SQL、不改几何、不重写正文——解析结果交给业务行与 canonical 去落盘。
 *
 * 纪律：
 * - 解析结果必须能追到原因：返回「选中哪条、覆盖了哪条、冲突在哪、能不能写」，
 *   不返回一个看不出理由的布尔值。
 * - 同级同源互相矛盾时**不定胜负**，保留依据并标记阻塞；不许按输入数组顺序取最后一条。
 * - 世界书静态优先于剧情静态；真实状态事件（剧情明确发生）可以改变当前状态，
 *   但历史几何保留——「房子被烧了」不等于「这张图从来没存在过」。
 * - 普通推测（inferred / model）不得覆盖已确认或作者锁定的断言。
 */

import type { WorldBuildDecodeIssue } from './atlas-world-build-contract.ts';

/* ------------------------------------------------------------------ *
 * 1 白名单
 * ------------------------------------------------------------------ */

export const WORLD_FACT_LAYERS = ['baseline', 'state-event'] as const;
export type WorldFactLayer = (typeof WORLD_FACT_LAYERS)[number];

export const WORLD_FACT_ORIGINS = ['lorebook', 'story', 'inferred'] as const;
export type WorldFactOrigin = (typeof WORLD_FACT_ORIGINS)[number];

export const WORLD_FACT_PRODUCERS = ['program', 'model'] as const;
export type WorldFactProducer = (typeof WORLD_FACT_PRODUCERS)[number];

export const WORLD_FACT_QUALITIES = ['estimated', 'confirmed'] as const;
export type WorldFactQuality = (typeof WORLD_FACT_QUALITIES)[number];

/**
 * predicate 白名单：只有这些断言允许进库，且每条 predicate 的 value 形状固定。
 * 不加开放字段——「任意对象写进 SQL 列」是数据污染最快的入口。
 */
export const WORLD_FACT_PREDICATES = [
  'exists',
  'presence',
  'size',
  'contains',
  'entrance',
  'opening-state',
  'material',
  'owner-lock',
] as const;
export type WorldFactPredicate = (typeof WORLD_FACT_PREDICATES)[number];

const SPATIAL_MATERIALS = ['solid', 'glass', 'wood', 'fabric', 'other', 'unknown'] as const;
const OPENING_STATES = ['open', 'closed', 'not-applicable', 'unknown'] as const;
const SIZE_UNITS = ['meters', 'cells'] as const;

/* ------------------------------------------------------------------ *
 * 2 契约
 * ------------------------------------------------------------------ */

export type WorldFactV1 = {
  version: 1;
  id: string;
  subjectId: string;
  predicate: WorldFactPredicate;
  layer: WorldFactLayer;
  origin: WorldFactOrigin;
  producer: WorldFactProducer;
  sourceKey: string | null;
  sourceHash: string | null;
  sourceSpan: { start: number; end: number } | null;
  quality: WorldFactQuality;
  effectiveTurnId: string;
  effectiveClockS: number | null;
  supersedesFactId: string | null;
  value: unknown;
};

/** 冲突类别：每个码对应真值表里的一行，方便测试逐条断言。 */
export const WORLD_FACT_CONFLICT_CODES = [
  /** 同级同源、值不同、无法判明——保留依据，该字段不写。 */
  'SAME_LEVEL_CONFLICT',
  /** 低优先级断言被高优先级盖过（世界书压剧情、确认压估计）。 */
  'OVERRIDDEN_BY_PRIORITY',
  /** 普通推测试图覆盖已确认 / 作者锁定的断言——拒绝，不覆盖。 */
  'LOCKED_OVERRIDE_REFUSED',
  /** 两条状态事件时点相同且值不同，无法判定谁更晚。 */
  'STATE_TIE',
  /** 同一 fact id 重复出现且内容不一致，数据本身坏了。 */
  'DUPLICATE_FACT_ID',
] as const;
export type WorldFactConflictCode = (typeof WORLD_FACT_CONFLICT_CODES)[number];

export type WorldFactConflict = {
  code: WorldFactConflictCode;
  subjectId: string;
  predicate: string;
  /** 参与冲突的断言 ID，按稳定顺序排列，不按输入顺序。 */
  factIds: readonly string[];
  message: string;
  /**
   * true：该 subject+predicate 的当前值**不可判定**，调用方不得写这一项。
   * false：已有明确胜者，冲突只是留痕（例如世界书压过剧情描述）。
   */
  blocking: boolean;
};

export type WorldFactResolution = {
  /** 选中的基线断言：同一 subject+predicate 至多一条。 */
  baseline: readonly WorldFactV1[];
  /** 生效的状态事件覆盖层：同一 subject+predicate 至多一条，按世界时钟取最新。 */
  stateOverlay: readonly WorldFactV1[];
  conflicts: readonly WorldFactConflict[];
  /** 被更高优先级或更新事件替代的断言 ID（含被拒绝覆盖的低优先级断言）。 */
  supersededFactIds: readonly string[];
  /** 输入本身是否可用于写当前状态。false 时调用方应当整批回退，而不是挑着写。 */
  mayWriteCurrentState: boolean;
  /** 不能写的具体原因（机器可读短语）。 */
  blockedReasons: readonly string[];
};

export type WorldFactResolutionInput = {
  baselineFacts: readonly WorldFactV1[];
  stateEvents: readonly WorldFactV1[];
  /** 当前回合：用于标注本回合新增事件，不参与先后排序（排序看 effectiveClockS）。 */
  currentTurnId: string;
};

/* ------------------------------------------------------------------ *
 * 3 解码
 * ------------------------------------------------------------------ */

export type WorldFactDecodeResult =
  | { ok: true; value: WorldFactV1 }
  | { ok: false; issues: readonly WorldBuildDecodeIssue[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined（字段缺失）';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (typeof value === 'object') return `object{${Object.keys(value as Record<string, unknown>).slice(0, 6).join(',')}}`;
  return `${typeof value}:${String(value)}`;
}

/**
 * 按 predicate 校验 value 形状。
 * 返回 null 表示通过；返回字符串表示具体原因。
 */
function validateFactValue(predicate: WorldFactPredicate, value: unknown, layer?: unknown): string | null {
  switch (predicate) {
    case 'exists':
    case 'presence':
      return typeof value === 'boolean' ? null : `必须是 boolean，实际是 ${describe(value)}`;
    case 'owner-lock':
      // §18.4：锁是布尔状态，**解锁**必须能作为状态事件记录下来。
      // 静态断言（baseline）仍只允许 true —— 扫描不到锁，不等于能断言「这扇门没锁」。
      if (typeof value === 'boolean' && String(layer ?? '') === 'state-event') return null;
      return value === true ? null : `必须是 true（只有 layer=state-event 的状态事件才能记 false=已解锁），实际是 ${describe(value)}`;
    case 'opening-state':
      return typeof value === 'string' && (OPENING_STATES as readonly string[]).includes(value)
        ? null
        : `必须是 ${OPENING_STATES.join(' / ')}，实际是 ${describe(value)}`;
    case 'material':
      return typeof value === 'string' && (SPATIAL_MATERIALS as readonly string[]).includes(value)
        ? null
        : `必须是 ${SPATIAL_MATERIALS.join(' / ')}，实际是 ${describe(value)}`;
    case 'size': {
      if (!isPlainObject(value)) return `必须是 { w, h, units } 对象，实际是 ${describe(value)}`;
      const { w, h, units } = value;
      if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) return `w 必须是正数，实际是 ${describe(w)}`;
      if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) return `h 必须是正数，实际是 ${describe(h)}`;
      if (typeof units !== 'string' || !(SIZE_UNITS as readonly string[]).includes(units)) {
        return `units 必须是 ${SIZE_UNITS.join(' / ')}，实际是 ${describe(units)}`;
      }
      return null;
    }
    case 'contains':
    case 'entrance': {
      if (!Array.isArray(value)) return `必须是字符串 ID 数组，实际是 ${describe(value)}`;
      for (let index = 0; index < value.length; index += 1) {
        const item: unknown = value[index];
        if (typeof item !== 'string' || item.trim().length === 0) {
          return `元素 [${index}] 必须是非空字符串，实际是 ${describe(item)}`;
        }
      }
      return null;
    }
  }
}

/** 解码一条来源断言。version / 枚举 / value 形状全部严格校验。 */
export function decodeWorldFact(value: unknown): WorldFactDecodeResult {
  const issues: WorldBuildDecodeIssue[] = [];
  const fail = (path: string, code: string, message: string): void => {
    issues.push({ path, code, message });
  };

  if (!isPlainObject(value)) {
    fail('fact', 'WORLD_FACT_SHAPE_INVALID', `事实必须是普通对象，实际是 ${describe(value)}`);
    return { ok: false, issues };
  }
  const root = value;

  if (root['version'] !== 1) {
    fail('fact.version', 'WORLD_FACT_VERSION_UNSUPPORTED', `只接受 version=1，实际是 ${describe(root['version'])}`);
  }

  const readString = (key: string): string | null => {
    const item = root[key];
    if (typeof item !== 'string' || item.trim().length === 0) {
      fail(`fact.${key}`, 'WORLD_FACT_FIELD_INVALID', `字段 ${key} 必须是非空字符串，实际是 ${describe(item)}`);
      return null;
    }
    return item;
  };

  const readNullableString = (key: string): string | null => {
    if (!Object.prototype.hasOwnProperty.call(root, key)) {
      fail(`fact.${key}`, 'WORLD_FACT_FIELD_MISSING', `缺少字段 ${key}（可空字段也必须显式给出 null）`);
      return null;
    }
    const item = root[key];
    if (item === null) return null;
    if (typeof item !== 'string') {
      fail(`fact.${key}`, 'WORLD_FACT_FIELD_INVALID', `字段 ${key} 必须是字符串或 null，实际是 ${describe(item)}`);
      return null;
    }
    return item;
  };

  const readEnum = <T extends string>(key: string, allowed: readonly T[]): T | null => {
    const item = root[key];
    if (typeof item !== 'string' || !(allowed as readonly string[]).includes(item)) {
      fail(
        `fact.${key}`,
        'WORLD_FACT_ENUM_INVALID',
        `字段 ${key} 必须是 ${allowed.join(' / ')}，实际是 ${describe(item)}`,
      );
      return null;
    }
    return item as T;
  };

  const id = readString('id');
  const subjectId = readString('subjectId');
  const predicate = readEnum('predicate', WORLD_FACT_PREDICATES);
  const layer = readEnum('layer', WORLD_FACT_LAYERS);
  const origin = readEnum('origin', WORLD_FACT_ORIGINS);
  const producer = readEnum('producer', WORLD_FACT_PRODUCERS);
  const quality = readEnum('quality', WORLD_FACT_QUALITIES);
  const effectiveTurnId = readString('effectiveTurnId');
  const sourceKey = readNullableString('sourceKey');
  const sourceHash = readNullableString('sourceHash');
  const supersedesFactId = readNullableString('supersedesFactId');

  const effectiveClockS = root['effectiveClockS'];
  if (effectiveClockS !== null && (typeof effectiveClockS !== 'number' || !Number.isFinite(effectiveClockS))) {
    fail(
      'fact.effectiveClockS',
      'WORLD_FACT_FIELD_INVALID',
      `effectiveClockS 必须是有限数字或 null，实际是 ${describe(effectiveClockS)}`,
    );
  }

  const span = root['sourceSpan'];
  if (span !== null) {
    if (!isPlainObject(span)) {
      fail('fact.sourceSpan', 'WORLD_FACT_FIELD_INVALID', `sourceSpan 必须是对象或 null，实际是 ${describe(span)}`);
    } else {
      const start = span['start'];
      const end = span['end'];
      if (typeof start !== 'number' || !Number.isInteger(start) || start < 0) {
        fail('fact.sourceSpan.start', 'WORLD_FACT_FIELD_INVALID', `start 必须是非负整数，实际是 ${describe(start)}`);
      }
      if (typeof end !== 'number' || !Number.isInteger(end) || end < 0) {
        fail('fact.sourceSpan.end', 'WORLD_FACT_FIELD_INVALID', `end 必须是非负整数，实际是 ${describe(end)}`);
      }
      if (typeof start === 'number' && typeof end === 'number' && end < start) {
        fail('fact.sourceSpan', 'WORLD_FACT_FIELD_INVALID', `end(${end}) 不能小于 start(${start})`);
      }
    }
  }

  if (predicate) {
    const valueIssue = validateFactValue(predicate, root['value'], root['layer']);
    if (valueIssue) {
      fail('fact.value', 'WORLD_FACT_VALUE_INVALID', `predicate=${predicate} 的 value ${valueIssue}`);
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      version: 1,
      id: id as string,
      subjectId: subjectId as string,
      predicate: predicate as WorldFactPredicate,
      layer: layer as WorldFactLayer,
      origin: origin as WorldFactOrigin,
      producer: producer as WorldFactProducer,
      sourceKey,
      sourceHash,
      sourceSpan: span === null ? null : {
        start: (span as Record<string, unknown>)['start'] as number,
        end: (span as Record<string, unknown>)['end'] as number,
      },
      quality: quality as WorldFactQuality,
      effectiveTurnId: effectiveTurnId as string,
      effectiveClockS: effectiveClockS as number | null,
      supersedesFactId,
      value: root['value'],
    },
  };
}

/* ------------------------------------------------------------------ *
 * 4 优先级
 * ------------------------------------------------------------------ */

/**
 * 静态来源优先级：世界书 > 剧情 > 推测。
 * 这是「世界书静态优先于普通剧情静态描述」的直接编码，不看输入顺序。
 */
const ORIGIN_RANK: Record<WorldFactOrigin, number> = {
  lorebook: 3,
  story: 2,
  inferred: 1,
};

/** 质量优先级：明确资料 > 估计。仅在 origin 同层时兜底，不跨层翻盘。 */
const QUALITY_RANK: Record<WorldFactQuality, number> = {
  confirmed: 2,
  estimated: 1,
};

function priorityScore(fact: WorldFactV1): number {
  return ORIGIN_RANK[fact.origin] * 10 + QUALITY_RANK[fact.quality];
}

/** 已确认且由程序产出的断言视为作者锁 / 确认事实：普通推测不得覆盖。 */
function isLockedAcknowledgement(fact: WorldFactV1): boolean {
  return fact.quality === 'confirmed' && fact.producer === 'program';
}

/** 真实剧情事件：剧情来源 + 已确认。只有它能改被锁定对象的存在状态。 */
function isRealStoryEvent(fact: WorldFactV1): boolean {
  return fact.layer === 'state-event' && fact.origin === 'story' && fact.quality === 'confirmed';
}

function factKey(fact: WorldFactV1): string {
  return `${fact.subjectId}\u0000${fact.predicate}`;
}

function byFactId(left: WorldFactV1, right: WorldFactV1): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** 稳定值指纹：用于「值是否相同」判定，与键顺序无关。 */
export function factValueKey(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => factValueKey(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${factValueKey(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

/* ------------------------------------------------------------------ *
 * 5 冲突解析
 * ------------------------------------------------------------------ */

/**
 * 解析同一 subject+predicate 的基线断言。
 *
 * 返回选中的一条（或 null）；无法判明时返回 conflict 且不选任何一条。
 */
function resolveBaselineGroup(
  group: readonly WorldFactV1[],
  conflicts: WorldFactConflict[],
  superseded: Set<string>,
): WorldFactV1 | null {
  if (group.length === 0) return null;
  const sorted = [...group].sort(byFactId);

  if (sorted.length === 1) return sorted[0];

  // 同文重复：内容完全一致就是同一条断言写了两次，取字典序最小的一条，其余记为被替代。
  const distinctValues = new Set(sorted.map((fact) => factValueKey(fact.value)));
  if (distinctValues.size === 1) {
    for (const fact of sorted.slice(1)) superseded.add(fact.id);
    return sorted[0];
  }

  const best = sorted.reduce((winner, candidate) => {
    const winnerScore = priorityScore(winner);
    const candidateScore = priorityScore(candidate);
    if (candidateScore > winnerScore) return candidate;
    return winner;
  }, sorted[0]);

  const sameLevel = sorted.filter((fact) => priorityScore(fact) === priorityScore(best)
    && factValueKey(fact.value) !== factValueKey(best.value));

  if (sameLevel.length > 0) {
    // 同级同源矛盾：不是「谁最后写谁赢」。保留依据，这一项不写。
    conflicts.push({
      code: 'SAME_LEVEL_CONFLICT',
      subjectId: best.subjectId,
      predicate: best.predicate,
      factIds: [best, ...sameLevel].map((fact) => fact.id).sort(),
      message: `同级断言值不同且无法判明（${best.origin}/${best.quality}）：${distinctValues.size} 种取值`,
      blocking: true,
    });
    return null;
  }

  // 有明确胜者：落败者记为被替代，并留一条非阻塞痕迹说明为什么被压。
  const losers = sorted.filter((fact) => fact.id !== best.id);
  for (const loser of losers) superseded.add(loser.id);
  if (losers.length > 0) {
    conflicts.push({
      code: 'OVERRIDDEN_BY_PRIORITY',
      subjectId: best.subjectId,
      predicate: best.predicate,
      factIds: [best.id, ...losers.map((fact) => fact.id)].sort(),
      message: `采用 ${best.origin}/${best.quality}（${best.id}），覆盖 ${losers.map((fact) => `${fact.origin}/${fact.quality}`).join('、')}`,
      blocking: false,
    });
  }
  return best;
}

/**
 * 解析状态事件组。
 *
 * - 只在时点可比较时取最新；时点相同且值不同 → STATE_TIE（阻塞）。
 * - 无 effectiveClockS 的事件按 effectiveTurnId 无法排序，此时要求至多一条；
 *   多于一条且值不同 → 阻塞，不猜顺序。
 */
function resolveStateGroup(
  group: readonly WorldFactV1[],
  conflicts: WorldFactConflict[],
  superseded: Set<string>,
): WorldFactV1 | null {
  if (group.length === 0) return null;
  const sorted = [...group].sort(byFactId);

  if (sorted.length === 1) return sorted[0];

  const withClock = sorted.filter((fact) => typeof fact.effectiveClockS === 'number');
  if (withClock.length !== sorted.length) {
    const distinct = new Set(sorted.map((fact) => factValueKey(fact.value)));
    if (distinct.size === 1) {
      for (const fact of sorted.slice(1)) superseded.add(fact.id);
      return sorted[0];
    }
    conflicts.push({
      code: 'STATE_TIE',
      subjectId: sorted[0].subjectId,
      predicate: sorted[0].predicate,
      factIds: sorted.map((fact) => fact.id).sort(),
      message: '状态事件缺少可比较的世界时钟，无法判定先后，拒绝按输入顺序取最后一条',
      blocking: true,
    });
    return null;
  }

  const latestClock = Math.max(...withClock.map((fact) => fact.effectiveClockS as number));
  const latest = withClock.filter((fact) => fact.effectiveClockS === latestClock);
  const distinctAtLatest = new Set(latest.map((fact) => factValueKey(fact.value)));
  if (distinctAtLatest.size > 1) {
    conflicts.push({
      code: 'STATE_TIE',
      subjectId: sorted[0].subjectId,
      predicate: sorted[0].predicate,
      factIds: latest.map((fact) => fact.id).sort(),
      message: `同一世界时钟（${latestClock}s）上存在不同取值，无法判定`,
      blocking: true,
    });
    return null;
  }

  const winner = latest.sort(byFactId)[0];
  for (const fact of sorted) {
    if (fact.id !== winner.id) superseded.add(fact.id);
  }
  return winner;
}

/* ------------------------------------------------------------------ *
 * 6 主入口
 * ------------------------------------------------------------------ */

/**
 * 解析世界事实冲突（真值表实现）。
 *
 * 真值表对应关系：
 * 1. 世界书静态 A vs 普通剧情静态 B → A 优先，B 记 OVERRIDDEN_BY_PRIORITY（非阻塞）。
 * 2. 明确资料 vs 常识估计 → confirmed 高于 estimated；inferred 整体垫底。
 * 3. 酒馆存在 + 后来明确被烧毁 → state-event 覆盖 baseline 的 exists，几何留在历史。
 * 4. 门最初关闭 + 后来明确打开 → 同 3，取时钟最新的状态事件。
 * 5. 同级同源互相矛盾 → SAME_LEVEL_CONFLICT，阻塞，不选任何一条。
 * 6. 普通补全改确认家具/作者锁 → LOCKED_OVERRIDE_REFUSED，不覆盖，也不阻塞其他字段。
 * 7. 真实拆毁影响被锁空间 → 允许 state-event 覆盖存在状态（origin=story 且 confirmed）。
 */
export function resolveWorldFactConflict(input: WorldFactResolutionInput): WorldFactResolution {
  const conflicts: WorldFactConflict[] = [];
  const superseded = new Set<string>();
  const blockedReasons: string[] = [];
  let mayWriteCurrentState = true;

  // ── 输入自检：同一 fact id 出现两次且内容不同，是坏数据 ──
  const seen = new Map<string, string>();
  for (const fact of [...input.baselineFacts, ...input.stateEvents]) {
    const fingerprint = `${fact.layer}|${factKey(fact)}|${factValueKey(fact.value)}`;
    const previous = seen.get(fact.id);
    if (previous !== undefined && previous !== fingerprint) {
      conflicts.push({
        code: 'DUPLICATE_FACT_ID',
        subjectId: fact.subjectId,
        predicate: fact.predicate,
        factIds: [fact.id],
        message: '同一 fact id 出现多次且内容不一致，输入不可信',
        blocking: true,
      });
      mayWriteCurrentState = false;
      blockedReasons.push('duplicate-fact-id');
    }
    seen.set(fact.id, fingerprint);
  }

  // ── 基线分组 ──
  const baselineGroups = new Map<string, WorldFactV1[]>();
  for (const fact of input.baselineFacts) {
    if (fact.layer !== 'baseline') {
      // 传错层的断言不能当基线用，也不能悄悄升级成状态事件。
      conflicts.push({
        code: 'SAME_LEVEL_CONFLICT',
        subjectId: fact.subjectId,
        predicate: fact.predicate,
        factIds: [fact.id],
        message: `baselineFacts 中出现 layer=${fact.layer} 的断言，已忽略`,
        blocking: true,
      });
      blockedReasons.push('layer-mismatch');
      continue;
    }
    const key = factKey(fact);
    const bucket = baselineGroups.get(key);
    if (bucket) bucket.push(fact);
    else baselineGroups.set(key, [fact]);
  }

  const baseline: WorldFactV1[] = [];
  for (const group of baselineGroups.values()) {
    const winner = resolveBaselineGroup(group, conflicts, superseded);
    if (winner) baseline.push(winner);
    else blockedReasons.push(`undecidable:${group[0].subjectId}:${group[0].predicate}`);
  }

  // ── 状态事件分组 ──
  const stateGroups = new Map<string, WorldFactV1[]>();
  for (const fact of input.stateEvents) {
    if (input.stateEvents.some(later => later.id !== fact.id && later.supersedesFactId === fact.id && later.subjectId === fact.subjectId && later.predicate === fact.predicate)) {
      superseded.add(fact.id);
      continue;
    }
    if (fact.layer !== 'state-event') {
      conflicts.push({
        code: 'SAME_LEVEL_CONFLICT',
        subjectId: fact.subjectId,
        predicate: fact.predicate,
        factIds: [fact.id],
        message: `stateEvents 中出现 layer=${fact.layer} 的断言，已忽略`,
        blocking: true,
      });
      blockedReasons.push('layer-mismatch');
      continue;
    }
    const key = factKey(fact);
    const bucket = stateGroups.get(key);
    if (bucket) bucket.push(fact);
    else stateGroups.set(key, [fact]);
  }

  const baselineByKey = new Map(baseline.map((fact) => [factKey(fact), fact]));
  const stateOverlay: WorldFactV1[] = [];

  for (const [key, group] of stateGroups) {
    const candidate = resolveStateGroup(group, conflicts, superseded);
    if (!candidate) {
      blockedReasons.push(`undecidable:${group[0].subjectId}:${group[0].predicate}`);
      continue;
    }

    const confirmedBaseline = baselineByKey.get(key);
    if (confirmedBaseline && isLockedAcknowledgement(confirmedBaseline) && !isRealStoryEvent(candidate)) {
      // 规则 6：普通补全不许改确认事实 / 作者锁。
      conflicts.push({
        code: 'LOCKED_OVERRIDE_REFUSED',
        subjectId: candidate.subjectId,
        predicate: candidate.predicate,
        factIds: [confirmedBaseline.id, candidate.id].sort(),
        message: `${candidate.origin}/${candidate.quality} 的状态事件试图覆盖已确认断言（${confirmedBaseline.id}），已拒绝；请补独立缺项`,
        blocking: false,
      });
      superseded.add(candidate.id);
      continue;
    }

    // 规则 3/4/7：真实状态事件覆盖当前状态；baseline 保留在历史（不进 superseded 的语义是
    // 「它仍解释这张图为什么这样画」）。这里只在冲突记录里留痕。
    const existingBaseline = baselineByKey.get(key);
    if (existingBaseline && factValueKey(existingBaseline.value) !== factValueKey(candidate.value)) {
      conflicts.push({
        code: 'OVERRIDDEN_BY_PRIORITY',
        subjectId: candidate.subjectId,
        predicate: candidate.predicate,
        factIds: [existingBaseline.id, candidate.id].sort(),
        message: `状态事件（${candidate.effectiveTurnId}）改变当前值；基线保留为历史几何依据`,
        blocking: false,
      });
    }
    stateOverlay.push(candidate);
  }

  // ── 冲突排序：稳定输出，不依赖输入顺序 ──
  conflicts.sort((left, right) => {
    if (left.subjectId !== right.subjectId) return left.subjectId < right.subjectId ? -1 : 1;
    if (left.predicate !== right.predicate) return left.predicate < right.predicate ? -1 : 1;
    if (left.code !== right.code) return left.code < right.code ? -1 : 1;
    return left.factIds.join(',') < right.factIds.join(',') ? -1 : 1;
  });

  return {
    baseline: [...baseline].sort(byFactId),
    stateOverlay: [...stateOverlay].sort(byFactId),
    conflicts,
    supersededFactIds: [...superseded].sort(),
    mayWriteCurrentState,
    blockedReasons: [...new Set(blockedReasons)].sort(),
  };
}

/**
 * 取某个 subject+predicate 的当前值：状态覆盖层优先，其次基线。
 * 返回 null 表示「不可判定或没有断言」——调用方不得拿 null 当 false 用。
 */
export function currentFactOf(
  resolution: WorldFactResolution,
  subjectId: string,
  predicate: WorldFactPredicate,
): WorldFactV1 | null {
  for (const fact of resolution.stateOverlay) {
    if (fact.subjectId === subjectId && fact.predicate === predicate) return fact;
  }
  for (const fact of resolution.baseline) {
    if (fact.subjectId === subjectId && fact.predicate === predicate) return fact;
  }
  return null;
}

/** 该字段是否被阻塞（不可写）。 */
export function isFactFieldBlocked(
  resolution: WorldFactResolution,
  subjectId: string,
  predicate: WorldFactPredicate,
): boolean {
  return resolution.conflicts.some((conflict) => conflict.blocking
    && conflict.subjectId === subjectId
    && conflict.predicate === predicate);
}

/* ------------------------------------------------------------------ *
 * 6 §18.1 状态演变：变化原因与「静态扫描不复原」
 * ------------------------------------------------------------------ */

/**
 * 一条断言为什么变成现在这样。
 *
 * §18.1 明确禁止「全都叫 rebuild」：纠正旧推测、真实剧情变化、改建是三种不同的事，
 * 回退策略也不同 —— 只有 `source-correction` 可以随世界书重扫而更新，
 * `story-change` 与 `rebuild` 一旦发生，静态来源**不得复原**。
 */
export const WORLD_FACT_CHANGE_REASONS = [
  /** 第一次落值（没有旧断言）：解释性估计，后续可被任何明确资料纠正。 */
  'initial-estimate',
  /** 新的明确资料纠正旧推测/旧估计：世界书或剧情给出更可靠的描述。 */
  'source-correction',
  /** 真实剧情变化：门被打开、物品被拿走、人离开了 —— 状态演变，不是纠正。 */
  'story-change',
  /** 拆改：几何/结构/包含关系被真实事件改变（拆除、改建、隔断）。 */
  'rebuild',
  /** 静态来源试图复原已经被剧情改变的事实：拒绝，并说明原因。 */
  'rescan-refused',
] as const;
export type WorldFactChangeReason = (typeof WORLD_FACT_CHANGE_REASONS)[number];

export type WorldFactChangeVerdict = {
  reason: WorldFactChangeReason;
  /** 是否允许把 `next` 写成当前值。 */
  applies: boolean;
  /** 被替代的旧断言 ID（没有旧断言时为 null）。 */
  supersedes: string | null;
  message: string;
};

/** 结构类断言：改它们等于改造空间，跟「门开了」不是一个量级。 */
const STRUCTURAL_PREDICATES = new Set(['size', 'contains', 'entrance']);

/** 静态来源：重扫世界书会重新产生它们。 */
function isStaticOrigin(origin: WorldFactOrigin): boolean {
  return origin === 'lorebook';
}

/**
 * §18.1：判定一条新断言相对旧断言意味着什么。
 *
 * 关键规则只有一条：**旧的是剧情演变（state-event），新的是静态来源（baseline/lorebook）→ 拒绝**。
 * 这一条同时挡住三种最常见的退化：被毁的建筑被世界书扫回来、搬走的桌子重新出现在原位、
 * 已经打开的门被静态描述改回关闭。
 */
export function classifyWorldFactChange(input: {
  previous: WorldFactV1 | null | undefined;
  next: WorldFactV1;
}): WorldFactChangeVerdict {
  const previous = input?.previous ?? null;
  const next = input?.next as WorldFactV1;

  if (!previous) {
    return {
      reason: 'initial-estimate',
      applies: true,
      supersedes: null,
      message: '首次落值：按解释性估计记录，后续明确资料可纠正',
    };
  }

  // 静态来源试图盖掉已经发生的剧情变化 → 拒绝复原。
  if (previous.layer === 'state-event' && next.layer === 'baseline' && isStaticOrigin(next.origin)) {
    return {
      reason: 'rescan-refused',
      applies: false,
      supersedes: null,
      message: `静态来源不能复原已被剧情改变的事实（${previous.id} 是 state-event）：世界书重扫不把毁掉的建筑、搬走的家具、打开的门改回去`,
    };
  }

  if (next.layer === 'state-event') {
    const rebuild = STRUCTURAL_PREDICATES.has(next.predicate);
    return {
      reason: rebuild ? 'rebuild' : 'story-change',
      applies: true,
      supersedes: previous.id,
      message: rebuild
        ? '真实拆改：几何/结构/包含关系按事件更新，历史布局保留用于回退'
        : '真实剧情变化：按事件更新当前状态，历史值保留',
    };
  }

  // 都是静态来源：只有明确资料纠正推测才算「纠正」，其余算同级重建。
  if (isStaticOrigin(next.origin) && previous.origin === 'inferred') {
    return {
      reason: 'source-correction',
      applies: true,
      supersedes: previous.id,
      message: '新明确资料纠正旧推测：替换的是「依据」，不是世界发生了什么',
    };
  }

  return {
    reason: 'rebuild',
    applies: true,
    supersedes: previous.id,
    message: '同类来源重新给出值：按重建处理并保留旧值为历史',
  };
}

/**
 * §18.1：世界书/布局补缺在写回之前必须问一次。
 *
 * `applied: false` 时调用方**不得**写这一项，也不得把它记成「用户撤销」——
 * 它是被规则挡下的复原尝试。
 */
export function staticRescanVerdict(input: {
  existing: WorldFactV1 | null | undefined;
  incoming: WorldFactV1;
}): { applied: boolean; reason: WorldFactChangeReason; supersedes: string | null; message: string } {
  const existing = input?.existing ?? null;
  const verdict = classifyWorldFactChange({ previous: existing, next: input?.incoming as WorldFactV1 });
  if (verdict.reason === 'rescan-refused') {
    return { applied: false, reason: verdict.reason, supersedes: null, message: verdict.message };
  }
  // 静态扫描只负责基线层：它不该替剧情写 state-event。
  if (existing?.layer === 'state-event' && input?.incoming?.layer === 'state-event') {
    return { applied: false, reason: 'rescan-refused', supersedes: null, message: '静态扫描不产生状态事件：剧情变化只能来自真实发生的事件' };
  }
  return { applied: verdict.applies, reason: verdict.reason, supersedes: verdict.supersedes, message: verdict.message };
}

/** 已经提升/已搬走/已打开的对象：静态补缺看到原 slot 时不得再补一份。 */
export function staticReplenishVerdict(input: {
  previous: WorldFactV1 | null | undefined;
  /** 陈设是否已经提升为真实物品（canonical.itemId 非空）。 */
  promotedItemId?: string | null;
  /** 对象当前是否存在（被拆毁/被拿走则为 false）。 */
  present?: boolean;
}): { replenish: boolean; reason: string } {
  if (typeof input?.promotedItemId === 'string' && input.promotedItemId !== '') {
    return { replenish: false, reason: `该陈设已提升为物品 ${input.promotedItemId}：按真实当前位置表示，不再补一张同款` };
  }
  if (input?.present === false) {
    return { replenish: false, reason: '该对象已不存在（拆毁/搬走）：静态补缺不复原' };
  }
  const previous = input?.previous ?? null;
  if (previous && previous.layer === 'state-event') {
    return { replenish: false, reason: '已有剧情状态事件：静态补缺不覆盖当前状态' };
  }
  return { replenish: true, reason: '没有已经被改变的证据，可以按补缺规则生成基线断言' };
}
