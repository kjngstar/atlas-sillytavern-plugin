/**
 * atlas-sql-generation-budget.ts — M3-03 / M3-03A：单回合模型预算（固定 4）。
 *
 * 纪律（改这个文件前先读一遍）：
 * 1. 预算约束的是**真实传输发送**，不是 `modelPort.request` 的调用次数：一次调用内部
 *    可能因兼容路由再发第二次 fetch（M3-03A），两次都必须占额度。
 * 2. 纯 prompt 预览（`preview`）不占额度；只有真正发请求才 claim。
 * 3. 同一 `batchId` 的重复候选不重复发请求：逻辑批次幂等由 `claimBatch` 保证。
 * 4. 后台保留额度 ≤1，且**不计入已用**；未使用必须显式 `releaseBackground()`。
 * 5. 领取失败绝不制造假的模型 attempt success——只记 `deferred` 并交出明确原因，
 *    让调用方把「没发出去的任务」如实标成待办，而不是报 MODEL_HTTP_COMPLETE。
 * 6. 预算是**实例**，由调用方传入，不用全局单例：不同聊天 / 并发任务互相隔离。
 * 7. HTTP 失败**不退还**额度（否则失败即触发请求风暴）。
 */

import type { AtlasModelPort } from './atlas-db-contract.ts';

/** 单回合硬上限：4 个真实传输发送。 */
export const GENERATION_BUDGET_LIMIT = 4;

export type BudgetAttemptStatus = 'requested' | 'completed' | 'failed';
export type BudgetAttempt = { stage: string; batchId: string; status: BudgetAttemptStatus };
export type BudgetDeferred = { stage: string; batchId: string; reason: string };

export type BudgetClaimFailureCode = 'MODEL_BUDGET_EXHAUSTED' | 'MODEL_BATCH_DUPLICATE';
export type BudgetClaim = { ok: true; duplicate?: false } | { ok: false; code: BudgetClaimFailureCode; reason: string };

export type GenerationBudgetPort = {
  readonly limit: number;
  /** 已占用的真实传输发送数（含失败）。 */
  used(): number;
  remaining(): number;
  /** 该阶段可用余额：前景阶段看得见被后台保留的那 1 个名额。 */
  stageRemaining(stage: string): number;
  attempts(): readonly BudgetAttempt[];
  deferred(): readonly BudgetDeferred[];
  /** 逻辑批次：同一 batchId 只认一次；重复返回 MODEL_BATCH_DUPLICATE，不占额度。 */
  claimBatch(stage: string, batchId: string): BudgetClaim;
  /** 真实发送：每次都占额度，失败不退还。 */
  claimTransport(stage: string, batchId: string): BudgetClaim;
  /**
   * 折入一次**已经发生**的真实发送（不由本 port 发出，例如 settle 内部按数值预算自管的批次）。
   * 不做余额校验——因为它确实已经发出去了，假装没发才是造假；只把账补平。
   */
  recordTransport(stage: string, batchId: string): void;
  finishBatch(batchId: string, status: 'completed' | 'failed'): void;
  reserveBackground(batchId: string): boolean;
  releaseBackground(): void;
  backgroundReserved(): boolean;
  /** 被保留名额的后台批次 id；未保留时为 null。 */
  backgroundBatchId(): string | null;
  defer(stage: string, batchId: string, reason: string): void;
};

export type CreateGenerationBudgetInput = {
  /** 本回合已经发出的尝试（前景 / 纠错），用来接着排队计数，不重算。 */
  attempts?: readonly BudgetAttempt[];
};

function cloneAttempts(attempts: readonly BudgetAttempt[] | undefined): BudgetAttempt[] {
  return (attempts ?? []).map((attempt) => ({ stage: String(attempt.stage), batchId: String(attempt.batchId), status: attempt.status }));
}

export function createGenerationBudget(input: CreateGenerationBudgetInput = {}): GenerationBudgetPort {
  const limit = GENERATION_BUDGET_LIMIT;
  const attemptList = cloneAttempts(input.attempts);
  const deferredList: BudgetDeferred[] = [];
  // 每个既有 attempt 都对应一次已经发出的真实传输（含失败），所以它同样占额度。
  let transports = attemptList.length;
  let reserved = false;
  let reservedBatchId: string | null = null;

  const attemptOf = (batchId: string): BudgetAttempt | undefined => attemptList.find((attempt) => attempt.batchId === batchId);
  const defer = (stage: string, batchId: string, reason: string): void => {
    if (deferredList.some((item) => item.batchId === batchId && item.reason === reason)) return;
    deferredList.push({ stage, batchId, reason });
  };

  return {
    limit,
    used: () => transports,
    remaining: () => Math.max(0, limit - transports),
    stageRemaining: (stage) => {
      const held = reserved && stage !== 'background' ? 1 : 0;
      return Math.max(0, limit - transports - held);
    },
    attempts: () => attemptList.map((attempt) => ({ ...attempt })),
    deferred: () => deferredList.map((item) => ({ ...item })),

    claimBatch: (stage, batchId) => {
      if (attemptOf(batchId)) {
        return { ok: false, code: 'MODEL_BATCH_DUPLICATE', reason: `批次 ${batchId} 已在本回合发出过，不重复发送` };
      }
      attemptList.push({ stage, batchId, status: 'requested' });
      return { ok: true };
    },

    claimTransport: (stage, batchId) => {
      const held = reserved && stage !== 'background' ? 1 : 0;
      if (transports + held >= limit) {
        const reason = held > 0
          ? `本回合模型预算 ${limit} 已用尽（实际发送 ${transports} 次），其中 1 个名额保留给已到期的后台任务`
          : `本回合模型预算 ${limit} 已用尽（实际发送 ${transports} 次），不再发送`;
        defer(stage, batchId, reason);
        return { ok: false, code: 'MODEL_BUDGET_EXHAUSTED', reason };
      }
      transports += 1;
      const existing = attemptOf(batchId);
      if (existing) {
        if (existing.status !== 'failed') existing.status = 'requested';
      } else {
        attemptList.push({ stage, batchId, status: 'requested' });
      }
      return { ok: true };
    },

    finishBatch: (batchId, status) => {
      const existing = attemptOf(batchId);
      if (existing) existing.status = status;
      else attemptList.push({ stage: 'unknown', batchId, status });
    },

    recordTransport: (stage, batchId) => {
      transports += 1;
      if (!attemptOf(batchId)) attemptList.push({ stage, batchId, status: 'completed' });
    },

    reserveBackground: (batchId) => {
      if (reserved) return false;
      // 保留额度不记入已用；但总账（已用 + 保留）不能超过上限。
      if (transports + 1 > limit) {
        defer('background', batchId, `本回合模型预算 ${limit} 已用尽，后台任务未保留名额`);
        return false;
      }
      reserved = true;
      reservedBatchId = batchId;
      return true;
    },

    releaseBackground: () => {
      if (!reserved) return;
      reserved = false;
      reservedBatchId = null;
    },

    backgroundReserved: () => reserved,

    backgroundBatchId: () => (reserved ? reservedBatchId : null),

    defer,
  };
}

/** 把预算包成传输层领取口（传给 API 客户端的兼容路由第二次发送）。 */
export function transportBudgetPort(
  budget: GenerationBudgetPort,
  stage: string,
  batchId: string,
): { claim(): { ok: boolean; reason?: string } } {
  return {
    claim: () => {
      const claim = budget.claimTransport(stage, batchId);
      return claim.ok ? { ok: true } : { ok: false, reason: claim.reason };
    },
  };
}

function budgetError(claim: Extract<BudgetClaim, { ok: false }>): Error {
  return Object.assign(new Error(claim.reason), { code: claim.code, retryable: false, deferred: true });
}

/**
 * budgetedModelPort：给任意模型端口包一层「真实发送前必须领到额度」。
 *
 * - `preview` 原样透传（纯预览不占额度）。
 * - `request` 先做逻辑批次幂等（重复候选直接拒），再领传输额度；领不到就抛
 *   `MODEL_BUDGET_EXHAUSTED` 并已在预算里记下 deferred，绝不发请求、绝不谎报成功。
 * - 成功 / 失败都如实 `finishBatch`；失败的额度不退还。
 */
export function budgetedModelPort(port: AtlasModelPort, budget: GenerationBudgetPort, stage: string): AtlasModelPort {
  return {
    ...port,
    /** 阶段名优先取请求自带的 phase（observe/geography/decision/outcome/repair），否则用端口默认。 */
    async request(request) {
      const phase = stage === 'background' ? 'background' : request.phase || stage;
      const logical = budget.claimBatch(phase, request.batchId);
      if (!logical.ok) throw budgetError(logical);
      const claim = budget.claimTransport(phase, request.batchId);
      if (!claim.ok) throw budgetError(claim);
      try {
        const response = await port.request(request);
        budget.finishBatch(request.batchId, 'completed');
        return response;
      } catch (error) {
        budget.finishBatch(request.batchId, 'failed');
        throw error;
      }
    },
  };
}

/** Production ports also bind their internal compatibility sends to this budget. */
export function bindModelBudget(port: AtlasModelPort, budget: GenerationBudgetPort, stage = 'observe'): AtlasModelPort {
  return port.withBudget ? port.withBudget(budget, stage) : budgetedModelPort(port, budget, stage);
}
