/**
 * atlas-turn-analysis-groups.ts — P14 §20.2：逐轮 / 楼层 / 窗口的关联与计数纪律。
 *
 * 计划里最容易做错的一条是「总数」：
 *
 * > 独立建图窗口有清晰类型/所属楼层，显示其实际发送，**不能在楼层汇总和窗口汇总中重复求总数**。
 *
 * 所以这里不提供「把两栏加起来」的入口。所有汇总都从**同一个 transport 键集合**派生：
 * `requestRef + transportAttempt`。谁去数都数同一个集合，不存在两栏各算一遍再相加的空间。
 *
 * 第二条纪律：
 *
 * > 旧记录无完整账本时次数 null，可能重叠的来源不直接相加。保留明细淘汰数量及有证据下界。
 *
 * 因此 `transports` 只在**每一条相关记录都有完整账本**时给数字，否则 `null`；
 * 同时给一个 `transportsLowerBound`（已知部分）和 `droppedCalls`（有证据的明细淘汰量）。
 * `null` + 下界 ≠ 假 0，也 ≠ 把两个可能重叠的来源加一起。
 */

/* ------------------------------------------------------------------ *
 * 1 单轮归类
 * ------------------------------------------------------------------ */

export type TurnCountingInput = {
  kind: string;
  /** 账本来源：`transport-journal` 才算完整；`work-budget` 只是预算账；`unknown` 是旧记录。 */
  countSource: 'transport-journal' | 'work-budget' | 'unknown';
  recordedModelTransports: number | null;
  worldChanged: boolean;
  timeChanged: boolean;
};

export type TurnCountingVerdict =
  | { countsAsBusinessTurn: true }
  | { countsAsBusinessTurn: false; reason: 'non-generation-turn' | 'local-only' | 'no-transport-evidence' };

/**
 * 非生成类 turn：`turns.kind` 的 `migration`（迁移）与 `manual`（本地手动改动）不算模型业务轮；
 * `rollback` / `maintenance` 是其它调用点的本地动作，一并排除。
 */
const NON_GENERATION_KINDS = new Set(['migration', 'manual', 'rollback', 'maintenance']);

/**
 * 这一轮算不算「模型业务轮」。
 *
 * - `rollback` / `maintenance`：本地动作，不计；
 * - 账本完整且确实是 0 次、又没有世界/时间变化：纯本地示意，不计；
 * - 旧记录（`unknown` / `work-budget`）**不能**因为「读不到次数」就当成 0 次——
 *   那会把真正发过请求的旧轮悄悄从分母里抹掉。因此归为 `no-transport-evidence`：不计入，
 *   但理由如实是「没有证据」，不是「确认没发」。
 */
export function countsAsBusinessTurn(input: TurnCountingInput): TurnCountingVerdict {
  const kind = typeof input?.kind === 'string' ? input.kind : '';
  if (NON_GENERATION_KINDS.has(kind)) return { countsAsBusinessTurn: false, reason: 'non-generation-turn' };
  const transports = input?.recordedModelTransports;
  if (input?.countSource === 'transport-journal' && transports === 0 && !input.worldChanged && !input.timeChanged) {
    return { countsAsBusinessTurn: false, reason: 'local-only' };
  }
  if (input?.countSource !== 'transport-journal') return { countsAsBusinessTurn: false, reason: 'no-transport-evidence' };
  return { countsAsBusinessTurn: true };
}

/* ------------------------------------------------------------------ *
 * 2 transport 去重与汇总
 * ------------------------------------------------------------------ */

export type TransportKeySource = {
  countSource: 'transport-journal' | 'work-budget' | 'unknown';
  /** 审计明细（已脱敏的 ModelCallRecord）。只有完整账本才有。 */
  calls?: ReadonlyArray<{ requestRef?: string; transportAttempt?: number }>;
  /** 该轮自己承认的次数（可用于缺失账本的下界）。 */
  recordedModelTransports?: number | null;
  /** 明细淘汰数量。 */
  droppedCalls?: number | null;
};

/** 一次真实传输的去重键。缺任一半就不是可核对的键——返回 null，不拼一个假键。 */
export function transportKey(call: { requestRef?: string; transportAttempt?: number }): string | null {
  const requestRef = typeof call?.requestRef === 'string' ? call.requestRef : '';
  const attempt = call?.transportAttempt;
  if (!requestRef || typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) return null;
  return `${requestRef}#${attempt}`;
}

export type TurnTransportSummary = {
  /** 去重后的真实传输次数。任一相关记录缺完整账本即为 null。 */
  transports: number | null;
  /** 有证据的下界：已知具体键的数量 + 缺明细但仍承认次数的那部分。 */
  transportsLowerBound: number;
  /** 明细淘汰数量合计（记录被环形上限挤掉，但总量仍然真实）。 */
  droppedCalls: number;
  /** 参与汇总的轮数。 */
  turns: number;
  /** 其中账本不完整的轮数；>0 时 `transports` 必为 null。 */
  turnsWithoutCompleteLedger: number;
  /** 恒 true：这些来源**不能**与其它栏位相加求总数。 */
  sourcesNotAddable: true;
  /** 无法构成去重键的审计记录条数（缺 requestRef / transportAttempt）。 */
  callsWithoutKey: number;
};

/**
 * 汇总一组轮次里的真实传输。
 *
 * 关键点：**重叠**。同一 `requestRef+transportAttempt` 出现在两轮里只算一次；
 * 而缺账本的轮**不补 0**，直接把整栏降级成 `null`，另给下界。
 */
export function summarizeTurnTransports(items: readonly TransportKeySource[]): TurnTransportSummary {
  const keys = new Set<string>();
  let turnsWithoutCompleteLedger = 0;
  let droppedCalls = 0;
  let callsWithoutKey = 0;
  let knownOnlyTransports = 0;
  const rows = Array.isArray(items) ? items : [];
  for (const item of rows) {
    const complete = item?.countSource === 'transport-journal' && Array.isArray(item.calls);
    if (!complete) {
      turnsWithoutCompleteLedger += 1;
      // 没有完整账本的轮：只用它自己承认的次数当下界，绝不并入去重集合。
      const recorded = item?.recordedModelTransports;
      if (typeof recorded === 'number' && Number.isSafeInteger(recorded) && recorded > 0) knownOnlyTransports += recorded;
      continue;
    }
    for (const call of item.calls ?? []) {
      const key = transportKey(call);
      if (key === null) callsWithoutKey += 1;
      else keys.add(key);
    }
    const dropped = item.droppedCalls;
    if (typeof dropped === 'number' && Number.isSafeInteger(dropped) && dropped > 0) droppedCalls += dropped;
  }
  // 键残缺的记录也让账本失去「完整」资格：不知道是哪一次，就没法保证没重复。
  const complete = turnsWithoutCompleteLedger === 0 && callsWithoutKey === 0;
  return {
    transports: complete ? keys.size + droppedCalls : null,
    transportsLowerBound: keys.size + droppedCalls + knownOnlyTransports,
    droppedCalls,
    turns: rows.length,
    turnsWithoutCompleteLedger,
    sourcesNotAddable: true,
    callsWithoutKey,
  };
}

/* ------------------------------------------------------------------ *
 * 3 楼层 / 窗口分组（不重复求总数）
 * ------------------------------------------------------------------ */

export type GroupableTurn = TransportKeySource & {
  /** 该轮所属正文楼层（已脱敏指纹或稳定 ID；同一楼层内多轮共用）。 */
  floorRef: string;
  /** 该轮发起时所在的建图窗口序号；独立建图窗口本轮无序号则为 null。 */
  windowSequence?: number | null;
  /** 该轮所属 job 的稳定引用；非建图轮为 null。 */
  jobRef?: string | null;
};

export type FloorTransportTotal = { floorRef: string; turns: number; transports: number | null; transportsLowerBound: number };
export type WindowTransportTotal = { jobRef?: string; windowSequence: number; turns: number; transports: number | null; transportsLowerBound: number };

export type TurnGroupTotals = {
  /** 每个楼层各自的合计。 */
  byFloor: FloorTransportTotal[];
  /** 每个窗口各自的合计。 */
  byWindow: WindowTransportTotal[];
  /**
   * 全局合计。**由同一个去重键集合派生**，不等于 `byFloor` 之和，也不等于 `byWindow` 之和。
   * 调用方不得把两栏相加。
   */
  overall: TurnTransportSummary;
  /** 恒 false：楼层栏与窗口栏不是两个可以相加的口径。 */
  floorAndWindowTotalsAreIndependent: false;
};

/**
 * 按楼层 / 窗口分组。
 *
 * 楼层栏回答「这句正文发了几次」，窗口栏回答「这个建图窗口发了几次」——同一批传输同时属于
 * 一个楼层和一个窗口，**它们天生重叠**。所以两栏都各自内部去重，而 `overall` 从完整记录重算一次。
 */
export function groupTurnTransportTotals(turns: readonly GroupableTurn[]): TurnGroupTotals {
  const rows = Array.isArray(turns) ? turns : [];
  const floors = new Map<string, GroupableTurn[]>();
  const windows = new Map<string, GroupableTurn[]>();
  for (const turn of rows) {
    const floor = typeof turn?.floorRef === 'string' && turn.floorRef ? turn.floorRef : 'unknown-floor';
    const floorBucket = floors.get(floor);
    if (floorBucket) floorBucket.push(turn);
    else floors.set(floor, [turn]);
    const sequence = turn?.windowSequence;
    if (typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence >= 0) {
      const key=JSON.stringify([turn.jobRef??null,sequence]);
      const windowBucket = windows.get(key);
      if (windowBucket) windowBucket.push(turn);
      else windows.set(key, [turn]);
    }
  }
  const byFloor: FloorTransportTotal[] = [...floors.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([floorRef, list]) => {
      const summary = summarizeTurnTransports(list);
      return { floorRef, turns: list.length, transports: summary.transports, transportsLowerBound: summary.transportsLowerBound };
    });
  const byWindow: WindowTransportTotal[] = [...windows.entries()]
    .map(([, list]) => {
      const summary = summarizeTurnTransports(list);
      return { ...(list[0].jobRef?{jobRef:list[0].jobRef}:{}), windowSequence:list[0].windowSequence!, turns: list.length, transports: summary.transports, transportsLowerBound: summary.transportsLowerBound };
    }).sort((a,b)=>(a.jobRef??'').localeCompare(b.jobRef??'')||a.windowSequence-b.windowSequence);
  return { byFloor, byWindow, overall: summarizeTurnTransports(rows), floorAndWindowTotalsAreIndependent: false };
}

/* ------------------------------------------------------------------ *
 * 4 取消 / 集中重试的计划（§20.1 的可操作项）
 * ------------------------------------------------------------------ */

export type RetryCandidate = {
  targetRef: string;
  workKind: string;
  requirement: string;
  status: string;
  lastErrorCode: string | null;
  attempts: number;
};

export type FailedRetryPlan = {
  /** 只包含真正失败的目标。 */
  candidates: RetryCandidate[];
  /** 已被隔离（达纠错额度）与依赖阻塞分开列：它们的处理方式不同。 */
  isolated: RetryCandidate[];
  dependencyBlocked: RetryCandidate[];
  /** 恒 true：重试计划永远不会带回已完成的目标。 */
  excludesCompleted: true;
  /** 明确说明重建范围，界面与日志用同一句话。 */
  scope: string;
};

/**
 * 集中重试失败项。
 *
 * 计划原文要求「只处理相关失败，不重做成功图」。所以这个函数**只按 status 取**：
 * `failed` 进重试，`blocked` 单列（阻塞要等依赖，不是重试能解决的），
 * `done` / `waiting-for-entry` 一律不进来。
 */
export function planFailedRetry(targets: readonly RetryCandidate[]): FailedRetryPlan {
  const rows = Array.isArray(targets) ? targets : [];
  const candidates = rows.filter((target) => target?.status === 'failed');
  const dependencyBlocked = rows.filter((target) => target?.status === 'blocked');
  return {
    candidates,
    isolated: candidates.filter((target) => target.attempts > 0),
    dependencyBlocked,
    excludesCompleted: true,
    scope: `只重试 ${candidates.length} 个失败目标（不含 ${dependencyBlocked.length} 个依赖阻塞、不含已完成项）`,
  };
}

/* ------------------------------------------------------------------ *
 * 5 矛盾去重（T-D04：同 floor/object/code 不刷屏）
 * ------------------------------------------------------------------ */

export type FloorContradiction = {
  issueId: string;
  code: string;
  objectId: string | null;
  floorRef: string;
  turnRef: string;
  message: string;
};

export type GroupedContradiction = FloorContradiction & {
  /** 同一 floor/object/code 下合并了多少条原始记录。 */
  occurrences: number;
  /** 首次与最近一次出现在哪一轮（都是脱敏引用）。 */
  firstTurnRef: string;
  lastTurnRef: string;
};

/**
 * 同一楼层、同一物体、同一代码的矛盾合并成一条。
 *
 * 为什么必须按楼层而不是按轮：一句话被拆成两条 claim 很常见，下一轮再写一遍同一处
 * 遮挡冲突也很常见——按轮去重会每轮刷一条，按 `floor/object/code` 才真的不刷屏。
 * `issueId` 保留最近一次的值，`occurrences` 如实记下合并了几条。
 */
export function dedupeContradictionsByFloor(items: readonly FloorContradiction[]): GroupedContradiction[] {
  const merged = new Map<string, GroupedContradiction>();
  for (const item of Array.isArray(items) ? items : []) {
    const code = typeof item?.code === 'string' ? item.code : 'UNKNOWN';
    const objectId = typeof item?.objectId === 'string' && item.objectId ? item.objectId : '-';
    const floorRef = typeof item?.floorRef === 'string' && item.floorRef ? item.floorRef : 'unknown-floor';
    const key = `${floorRef}|${objectId}|${code}`;
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, {
        ...item, code, objectId: objectId === '-' ? null : objectId, floorRef,
        occurrences: 1, firstTurnRef: item.turnRef, lastTurnRef: item.turnRef,
      });
      continue;
    }
    previous.occurrences += 1;
    previous.issueId = item.issueId;
    previous.message = item.message;
    previous.lastTurnRef = item.turnRef;
  }
  return [...merged.values()].sort((left, right) => {
    const keyLeft = `${left.floorRef}|${left.objectId ?? ''}|${left.code}`;
    const keyRight = `${right.floorRef}|${right.objectId ?? ''}|${right.code}`;
    return keyLeft < keyRight ? -1 : keyLeft > keyRight ? 1 : 0;
  });
}
