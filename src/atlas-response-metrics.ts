/**
 * atlas-response-metrics.ts — P14 §20.3：响应长度与耗时的**口径分离**。
 *
 * 计划原文的三条硬要求，逐条对应到这里的实现：
 *
 * 1. 「区分 rawResponseChars、visibleTextChars、reasoningTextChars，后者只在响应有明确可识别
 *    字段时计算，否则 null」——`measureResponseLengths()`。未知就是 `null`，绝不写 0 冒充
 *    「测到了，长度为零」。
 * 2. 「不能用 raw-visible 差值猜 reasoning」——这里**从不**做减法：`reasoningTextChars` 只从
 *    真实存在的推理字段读取；没有该字段就 `null`。JSON 包装、转义、SSE 前缀都会让差值失真，
 *    算术推断出来的「推理长度」是伪造证据。
 * 3. 「headersMs 是观测到响应头的时间，bodyMs 是正文接收时长；logicalDurationMs 包含兼容重发时
 *    不能再作为单次重复加总」——`summarizeTransportTiming()` 只对**同一 transport 批次**累加，
 *    带 `durationIncludesCompatibilityRetry` 的记录只进「覆盖了重发的耗时」一栏，不进单次加总。
 *
 * 边界：本模块只算**长度与毫秒**，一个字符的正文都不留；不 import 任何 Node 专有对象，
 * 浏览器与 Worker 可直接引用。
 */

/* ------------------------------------------------------------------ *
 * 1 长度口径
 * ------------------------------------------------------------------ */

export type ResponseLengthMetrics = {
  /** 原始传输正文长度（含 JSON / SSE 包装，未解码）。旧 `responseChars` 就是这个口径。 */
  rawResponseChars: number;
  /** 助手可见正文字符数；响应里没有可识别的正文载体时为 null。 */
  visibleTextChars: number | null;
  /** 推理字段字符数；响应里**没有明确推理字段**时为 null（不从差值推断）。 */
  reasoningTextChars: number | null;
};

/** 推理字段的识别顺序：与 `extractAssistantText` 的兜底顺序保持一致，但不参与取正文。 */
const REASONING_KEYS = ['reasoning_content', 'reasoning', 'thinking'] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * 取字段的「文本形态」。返回 `undefined` 表示**字段不存在**（与「存在但为空」区分开：
 * 前者长度未知，后者长度是 0）。这是本模块唯一允许区分 null 与 0 的地方。
 */
function readText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  let joined = '';
  let sawPart = false;
  for (const part of value) {
    if (typeof part === 'string') {
      joined += part;
      sawPart = true;
      continue;
    }
    const row = asRecord(part);
    if (row && typeof row['text'] === 'string') {
      joined += row['text'];
      sawPart = true;
    }
  }
  return sawPart ? joined : undefined;
}

function firstDefined(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const text = readText(source[key]);
    if (text !== undefined) return text;
  }
  return undefined;
}

/**
 * 量一次响应。
 *
 * `rawText` 是真正收到的传输正文（已含 SSE 包装）；`payload` 是解码后的对象。
 * payload 解不出来时可见/推理长度一律 `null`——原始长度仍然真实可报。
 *
 * 支持四种可识别形状（与 `extractAssistantText` 同一批）：
 * - Google 原生 / SillyTavern 的 `responseContent.parts`（`thought === true` 归推理）；
 * - OpenAI 兼容 `choices[0].message`；
 * - ollama 原生 `message`；
 * - 顶层 `text` / `content` / `response`。
 */
export function measureResponseLengths(payload: unknown, rawText: string): ResponseLengthMetrics {
  const rawResponseChars = typeof rawText === 'string' ? rawText.length : 0;
  const root = asRecord(payload);
  if (!root) return { rawResponseChars, visibleTextChars: null, reasoningTextChars: null };

  /* ---- Google / responseContent.parts ---- */
  const google = root as { responseContent?: { parts?: unknown }; candidates?: Array<{ content?: { parts?: unknown } }> };
  const rawParts = google.responseContent?.parts ?? google.candidates?.[0]?.content?.parts;
  if (Array.isArray(rawParts)) {
    let visible = 0;
    let sawVisible = false;
    let reasoning = 0;
    let sawReasoning = false;
    for (const part of rawParts) {
      const row = asRecord(part);
      if (!row) continue;
      const text = readText(row['text']);
      if (text === undefined) continue;
      if (row['thought'] === true) {
        reasoning += text.length;
        sawReasoning = true;
      } else {
        visible += text.length;
        sawVisible = true;
      }
    }
    return {
      rawResponseChars,
      visibleTextChars: sawVisible ? visible : null,
      reasoningTextChars: sawReasoning ? reasoning : null,
    };
  }

  /* ---- OpenAI 兼容 choices ---- */
  const choices = root['choices'];
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = asRecord(choices[0]);
    const message = choice ? asRecord(choice['message']) : null;
    if (message) {
      const visible = firstDefined(message, ['content']);
      const reasoning = firstDefined(message, REASONING_KEYS);
      // tool_calls 载体：正文在 function.arguments.content 里，长度照实算。
      let carrier: string | undefined;
      if (visible === undefined) carrier = readToolCarrier(message['tool_calls']);
      return {
        rawResponseChars,
        visibleTextChars: visible !== undefined ? visible.length : carrier !== undefined ? carrier.length : null,
        reasoningTextChars: reasoning !== undefined ? reasoning.length : null,
      };
    }
    if (choice && Object.prototype.hasOwnProperty.call(choice, 'text')) {
      const legacy = readText(choice['text']);
      if (legacy !== undefined) return { rawResponseChars, visibleTextChars: legacy.length, reasoningTextChars: null };
    }
  }

  /* ---- ollama 原生 ---- */
  const ollama = asRecord(root['message']);
  if (ollama) {
    const visible = firstDefined(ollama, ['content']);
    const reasoning = firstDefined(ollama, REASONING_KEYS);
    if (visible !== undefined || reasoning !== undefined) {
      return {
        rawResponseChars,
        visibleTextChars: visible !== undefined ? visible.length : null,
        reasoningTextChars: reasoning !== undefined ? reasoning.length : null,
      };
    }
  }

  /* ---- 顶层 text / content / response ---- */
  for (const key of ['text', 'content', 'response'] as const) {
    if (!Object.prototype.hasOwnProperty.call(root, key)) continue;
    const text = readText(root[key]);
    if (text === undefined) continue;
    return { rawResponseChars, visibleTextChars: text.length, reasoningTextChars: null };
  }

  // 形状认不出来：两项都未知，不拿 raw 长度顶替。
  return { rawResponseChars, visibleTextChars: null, reasoningTextChars: null };
}

/** 响应函数载体的正文（数据信封，不执行任何工具）。 */
function readToolCarrier(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const fn = asRecord(asRecord(value[0])?.['function']);
  if (!fn) return undefined;
  const raw = fn['arguments'];
  if (typeof raw !== 'string') {
    const inline = asRecord(raw);
    return inline && typeof inline['content'] === 'string' ? inline['content'] : undefined;
  }
  try {
    const parsed = asRecord(JSON.parse(raw));
    return parsed && typeof parsed['content'] === 'string' ? parsed['content'] : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * 2 耗时口径
 * ------------------------------------------------------------------ */

export type TransportTimingRecord = {
  /** 观测到响应头的时间（从发起 fetch 算起）。 */
  headersMs?: number | null;
  /** 正文接收时长（从拿到响应头到正文读完）。 */
  bodyMs?: number | null;
  /** 从发起请求到拿完整结果；**可能覆盖兼容重发的第二次 fetch**。 */
  logicalDurationMs?: number | null;
  /** true = 该 logicalDurationMs 覆盖了同一批次内的兼容重发，不能当单次请求耗时累加。 */
  durationIncludesCompatibilityRetry?: boolean;
};

export type TransportTimingSummary = {
  /** 有 headersMs 的 transport 数（其余为未知，不补 0）。 */
  transportsWithHeaders: number;
  transportsWithBody: number;
  /** 单次可加总的 logicalDurationMs 合计；覆盖重发的记录**不**计入。 */
  singleRequestLogicalMs: number;
  /** 覆盖兼容重发的记录条数与它们的 logicalDurationMs 合计（单列，不混算）。 */
  transportsCoveringRetry: number;
  retryCoveringLogicalMs: number;
  /** 没有任何计时证据时 true —— 调用方必须显示「未知」，不能显示 0 ms。 */
  timingUnknown: boolean;
};

const NON_NEGATIVE = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * 汇总一段 transport 记录的耗时。
 *
 * 「不能当单次加总」的那一类**单独一栏**：混进 `singleRequestLogicalMs` 会让「5 次请求用了
 * 12 秒」这种数字凭空虚高，而这正是计划点名要避免的。
 */
export function summarizeTransportTiming(records: readonly TransportTimingRecord[]): TransportTimingSummary {
  let transportsWithHeaders = 0;
  let transportsWithBody = 0;
  let singleRequestLogicalMs = 0;
  let transportsCoveringRetry = 0;
  let retryCoveringLogicalMs = 0;
  for (const record of records ?? []) {
    if (NON_NEGATIVE(record?.headersMs)) transportsWithHeaders += 1;
    if (NON_NEGATIVE(record?.bodyMs)) transportsWithBody += 1;
    if (!NON_NEGATIVE(record?.logicalDurationMs)) continue;
    if (record.durationIncludesCompatibilityRetry === true) {
      transportsCoveringRetry += 1;
      retryCoveringLogicalMs += record.logicalDurationMs;
    } else {
      singleRequestLogicalMs += record.logicalDurationMs;
    }
  }
  return {
    transportsWithHeaders,
    transportsWithBody,
    singleRequestLogicalMs,
    transportsCoveringRetry,
    retryCoveringLogicalMs,
    timingUnknown: transportsWithHeaders === 0 && transportsWithBody === 0 && singleRequestLogicalMs === 0
      && retryCoveringLogicalMs === 0,
  };
}

/* ------------------------------------------------------------------ *
 * 3 审计记录投影（诊断 → 审计）
 * ------------------------------------------------------------------ */

const INTEGER_IN_RANGE = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000;

/**
 * 从诊断 details 里取出本次 transport 的长度与耗时字段。
 * 缺什么就**不写**什么：审计记录上缺字段 = 未知，写 0 等于伪造。
 */
export function transportMetricsFromDetails(details: Record<string, unknown> | null | undefined): {
  metrics: { rawResponseChars?: number; visibleTextChars?: number | null; reasoningTextChars?: number | null };
  timing: { headersMs?: number; bodyMs?: number; durationIncludesCompatibilityRetry?: true };
} {
  const source = details ?? {};
  const metrics: { rawResponseChars?: number; visibleTextChars?: number | null; reasoningTextChars?: number | null } = {};
  const timing: { headersMs?: number; bodyMs?: number; durationIncludesCompatibilityRetry?: true } = {};
  if (INTEGER_IN_RANGE(source['rawResponseChars'])) metrics.rawResponseChars = source['rawResponseChars'];
  else if (INTEGER_IN_RANGE(source['responseChars'])) metrics.rawResponseChars = source['responseChars'];
  // 可见/推理长度允许显式 null（＝已探测但没有该字段），也允许非负整数。
  if (source['visibleTextChars'] === null || INTEGER_IN_RANGE(source['visibleTextChars'])) {
    metrics.visibleTextChars = source['visibleTextChars'] as number | null;
  }
  if (source['reasoningTextChars'] === null || INTEGER_IN_RANGE(source['reasoningTextChars'])) {
    metrics.reasoningTextChars = source['reasoningTextChars'] as number | null;
  }
  if (INTEGER_IN_RANGE(source['headersMs'])) timing.headersMs = source['headersMs'];
  if (INTEGER_IN_RANGE(source['bodyMs'])) timing.bodyMs = source['bodyMs'];
  if (source['durationIncludesCompatibilityRetry'] === true) timing.durationIncludesCompatibilityRetry = true;
  return { metrics, timing };
}
