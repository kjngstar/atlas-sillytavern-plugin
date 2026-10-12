/**
 * atlas-construction-scheduler.ts — P09B/R01：只读调度规划（不写库）。
 *
 * 规则（交接稿 §16.3）：
 * - 新单元与重试单元按 **3 新 : 1 重试** 轮转；某一类为空时把名额释放给另一类。
 * - 同类内按 last_served_seq 升序、再按稳定 ID 升序；失败单元排到该类尾部（靠 seq 体现）。
 * - 目标归属一个活动单元：已被待办单元占用的目标不再参与新单元分配。
 *
 * 这个文件不产生任何写入；调用方拿到选择结果后自己构造 RowMutation 并交给 ACK。
 */

import { NEW_UNITS_PER_RETRY, UNIT_TARGET_LIMIT, type ProgressRow } from './atlas-construction-progress.ts';

export type ScheduledUnit = {
  unitId: string;
  status: 'pending' | 'retry';
  lastServedSeq: number;
  targetIds: string[];
  sourceChunkKeys: string[];
  inputSignature: string;
  catalogueHash: string;
  attemptCount: number;
  /** P10/R02：已接受的 `new:` 别名 → 真实 ID（重试时先做绑定转换）。 */
  bindings: Record<string, string>;
};

function byId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter((item) => item.length > 0) : [];
}

function asBindingMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [alias, id] of Object.entries(value as Record<string, unknown>)) {
    const key = String(alias);
    const target = String(id ?? '');
    if (key.length > 0 && target.length > 0) out[key] = target;
  }
  return out;
}

export function toScheduledUnit(row: ProgressRow): ScheduledUnit {
  const payload = row.payload;
  return {
    unitId: row.subjectKey || row.id,
    status: row.status === 'retry' ? 'retry' : 'pending',
    lastServedSeq: row.lastServedSeq,
    targetIds: asStringArray(payload.targetIds).slice(0, UNIT_TARGET_LIMIT),
    sourceChunkKeys: asStringArray(payload.sourceChunkKeys),
    inputSignature: row.inputSignature,
    catalogueHash: typeof payload.catalogueHash === 'string' ? payload.catalogueHash : '',
    attemptCount: typeof payload.attemptCount === 'number' && Number.isFinite(payload.attemptCount) ? Math.max(0, Math.floor(payload.attemptCount)) : 0,
    bindings: asBindingMap(payload.bindings),
  };
}

/** 可被调度的工作单元：pending（新）与 retry（重试）。processed/suspended 不入队。 */
export function schedulableUnits(rows: readonly ProgressRow[]): ScheduledUnit[] {
  return rows
    .filter((row) => row.kind === 'unit' && (row.status === 'pending' || row.status === 'retry'))
    .map(toScheduledUnit)
    .sort((left, right) => {
      if (left.lastServedSeq !== right.lastServedSeq) return left.lastServedSeq - right.lastServedSeq;
      return byId(left.unitId, right.unitId);
    });
}

/**
 * 3 新 : 1 重试 的确定性交错。
 *
 * `startSlot` 是本轮在轮转里的位置（由**持久** schedulerSeq 派生），因此「每 4 批里有 1 批
 * 先照顾重试」跨回合、跨刷新、跨 fork 都成立 —— 不是靠内存里的一个计数器。
 * 某类为空时名额释放给另一类。
 */
export function rotationOrder(
  pending: readonly ScheduledUnit[],
  retry: readonly ScheduledUnit[],
  startSlot = 0,
): ScheduledUnit[] {
  const fresh = [...pending].sort((a, b) => (a.lastServedSeq - b.lastServedSeq) || byId(a.unitId, b.unitId));
  const again = [...retry].sort((a, b) => (a.lastServedSeq - b.lastServedSeq) || byId(a.unitId, b.unitId));
  const out: ScheduledUnit[] = [];
  let freshIndex = 0;
  let retryIndex = 0;
  const total = fresh.length + again.length;
  const base = Math.max(0, Math.floor(startSlot));
  for (let slot = 0; slot < total; slot += 1) {
    const wantsRetry = (base + slot) % (NEW_UNITS_PER_RETRY + 1) === NEW_UNITS_PER_RETRY;
    const takeFresh = (): boolean => {
      if (freshIndex >= fresh.length) return false;
      out.push(fresh[freshIndex]);
      freshIndex += 1;
      return true;
    };
    const takeRetry = (): boolean => {
      if (retryIndex >= again.length) return false;
      out.push(again[retryIndex]);
      retryIndex += 1;
      return true;
    };
    if (wantsRetry) {
      // 该轮到重试；重试用完就把名额释放给新单元。
      if (!takeRetry()) takeFresh();
    } else {
      // 该轮到新单元；新单元用完就把名额释放给重试。
      if (!takeFresh()) takeRetry();
    }
  }
  return out;
}

export type NextUnitPlan = {
  unit: ScheduledUnit | null;
  /** 这一轮被跳过的单元（用于回执里的「重试单元数」「待处理数」）。 */
  queued: ScheduledUnit[];
  freshCount: number;
  retryCount: number;
  /** 本轮的轮转位置（持久 schedulerSeq 派生），调用方据此写回。 */
  slot: number;
};

/**
 * 选出下一批要处理的工作单元（一次建设请求只吃一个单元）。
 *
 * `schedulerSeq` 是持久序号：本轮在 3 新 : 1 重试的轮转里处于第几个位置由它决定，
 * 因此重试不会被无限饿死，新工作也不会被重试堵住。
 */
export function planNextUnits(rows: readonly ProgressRow[], limit = 1, schedulerSeq = 0): NextUnitPlan {
  const units = schedulableUnits(rows);
  const fresh = units.filter((unit) => unit.status === 'pending');
  const retry = units.filter((unit) => unit.status === 'retry');
  const slot = Math.max(0, Math.floor(schedulerSeq));
  const ordered = rotationOrder(fresh, retry, slot);
  const take = Math.max(0, Math.floor(limit));
  return {
    unit: ordered[0] ?? null,
    queued: ordered.slice(0, take),
    freshCount: fresh.length,
    retryCount: retry.length,
    slot,
  };
}

/** 已被待办单元占用的目标：不能被另一个待办单元重复处理。 */
export function claimedTargets(units: readonly ScheduledUnit[]): Set<string> {
  const claimed = new Set<string>();
  for (const unit of units) for (const id of unit.targetIds) claimed.add(id);
  return claimed;
}

/**
 * 用一个单元的冻结目标覆盖候选（§16.2）：既有单元 → 只处理它的目标；
 * 没有既有单元 → 从 pending 目标里切出一个新单元。
 *
 * **保持调用方给的顺序**：调用方已经按原 planCandidates 的优先级排好（无结构 → 未分类祖先 →
 * 缺连通 → 展开子地点 → 其余），这里不重排，否则「先补无结构的当前场所」会被 ID 序打乱。
 */
export type UnitAllocation = {
  targetIds: string[];
  sourceChunkKeys: string[];
  /** 复用了既有单元时给出它的 ID；新分配时为 null。 */
  existingUnitId: string | null;
};

export function allocateTargets(input: {
  pendingTargetIds: readonly string[];
  existingUnits: readonly ScheduledUnit[];
  chosen: ScheduledUnit | null;
}): UnitAllocation {
  if (input.chosen) return { targetIds: [...input.chosen.targetIds], sourceChunkKeys: [...input.chosen.sourceChunkKeys], existingUnitId: input.chosen.unitId };
  const claimed = claimedTargets(input.existingUnits);
  const targetIds = [...new Set(input.pendingTargetIds)]
    .filter((id) => !claimed.has(id))
    .slice(0, UNIT_TARGET_LIMIT);
  return { targetIds, sourceChunkKeys: [], existingUnitId: null };
}
