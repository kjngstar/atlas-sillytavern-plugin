/**
 * atlas-time-intent.ts — 0.9.1 时间意图抽取器（纯规则、确定性、零请求）。
 *
 * 作者反馈：user 的扮演常含多个连贯动作（"起身…然后洗漱…接着出门"）或
 * 时间词（"用了一会儿""花了半天"），AI 自报 duration 容易瞎猜。
 * 本模块用纯规则从用户行动文本里抽取时间线索：
 * - 动作连接词（然后 / 接着 / 随后…）→ 动作数量估计（软参考，只进 prepare 提示）；
 * - 显式时间词（一会儿 / 片刻 / 半天 / 许久…）→ 时段下限（硬参考，裁决层强制 max）。
 *
 * 纪律：零随机、零网络、零 DOM；同输入 → 同输出。规则表有界，宁缺毋滥——
 * 只有高置信度的显式时间词才作为硬下限，模糊表达（"很久""一段时间"）不参与。
 *
 * D03（计划 §2.3「定时语义」）：本模块另提供 `deriveElapsedPeriods`——在显式时间词之上
 * 只认助手正文的**完成态**行为词（"吃完饭""睡到翌日""赶了半天路"）保守推导时段；用户显式
 * 时间词与既有旅行引擎算好的路线耗时只作下限；开场识别恒 0。口径见文件尾部 D03 分节注释。
 * 该函数同样是纯函数：不读地图、不读写 world 的时间数据结构（D03 纪律）。
 */

import { ATLAS_LIMITS } from "./atlas-contract.ts";

export interface AtlasTimeIntent {
  /** 命中的动作连接词（去重，原文顺序） */
  actionMarkers: string[];
  /** 动作数量估计 = 连接词数 + 1（仅软参考） */
  estimatedActions: number;
  /** 命中的显式时间词（原文，按出现顺序去重） */
  timeWords: string[];
  /** 显式时间词推导的时段下限；无命中 → null */
  suggestedPeriods: number | null;
}

/** 显式时间词表：pattern → 时段下限。保持小表 + 高置信度，不猜模糊词。 */
const TIME_WORD_TABLE: Array<{ pattern: RegExp; periods: number }> = [
  { pattern: /一整天|整天|大半天/g, periods: 4 },
  { pattern: /半天|半日/g, periods: 3 },
  { pattern: /许久|半晌|好一会儿|好一阵/g, periods: 2 },
  { pattern: /一会儿|一会|片刻|良久/g, periods: 1 },
];

const ACTION_MARKER_PATTERN = /然后|接着|随后|而后|之后|再|又|最后|顺便/g;

/** 从用户行动文本抽取时间线索（纯规则；空 / 无命中 → 零线索）。 */
export function extractAtlasTimeIntent(userText: string): AtlasTimeIntent {
  const text = typeof userText === "string" ? userText : "";
  if (!text.trim()) {
    return { actionMarkers: [], estimatedActions: 0, timeWords: [], suggestedPeriods: null };
  }

  const actionMarkers: string[] = [];
  for (const match of text.matchAll(ACTION_MARKER_PATTERN)) {
    if (!actionMarkers.includes(match[0])) actionMarkers.push(match[0]);
  }

  const timeWords: string[] = [];
  let suggestedPeriods: number | null = null;
  for (const entry of TIME_WORD_TABLE) {
    for (const match of text.matchAll(entry.pattern)) {
      if (!timeWords.includes(match[0])) timeWords.push(match[0]);
      suggestedPeriods = suggestedPeriods === null ? entry.periods : Math.max(suggestedPeriods, entry.periods);
    }
  }

  return {
    actionMarkers,
    estimatedActions: actionMarkers.length > 0 ? actionMarkers.length + 1 : (text.trim() ? 1 : 0),
    timeWords,
    suggestedPeriods,
  };
}

/* ------------------------------------------------------------------------- *
 * D03：时段推导（计划 §2.3「定时语义」+ 阶段 D03 原文）
 *
 *   §2.3 原文：「没有时间推进 → 可以记录意图/状态，但人物不得完成旅行或跨区信息送达。
 *   数分钟谈话没有明确流逝 → 0 时段；助手正文明确完成吃饭、过夜、赶路等，可由程序保守
 *   推导时段，用户显式时间词仍是下限，地图路线耗时仍由现有引擎估计。任何推导都进回执
 *   说明来源（user-explicit / assistant-event / travel），绝不让模型填 duration 数字。」
 *
 * 三条口径（必须一起读，别只读一半）：
 * 1. **只认完成态**：「吃完饭」「睡到翌日」「赶了半天路」计时；「准备吃饭」「打算睡到翌日」
 *    「还没吃完饭」这类未完成 / 计划 / 假设一律不计——命中所在**分句**出现准备态标记即整条
 *    作废。所以「准备吃饭 → 0 时段」是规则的结果，不是巧合；
 * 2. **下限取最大，不叠加**：用户显式时间词、助手完成行为、旅行耗时三者取最大（同一段时间
 *    常被三种说法同时描述，相加就等于替模型编 duration）；
 * 3. **不猜距离**：「抵达城门」本身不计时段——旅行耗时必须由既有旅行引擎按已确认路线与
 *    标尺算好后经 `travelPeriods` 传入；本模块零 IO，不读地图、不改 world 的时间数据结构。
 * ------------------------------------------------------------------------- */

/** 时段推导来源；`none` = 无推进（0 时段），此时不冒充下面三个来源中的任何一个。 */
export type AtlasElapsedPeriodSource = "user-explicit" | "assistant-event" | "travel" | "none";

export interface AtlasElapsedPeriodInput {
  /** 用户行动原文（显式时间词 → 下限；缺省不参与） */
  userText?: string | null;
  /** 助手**本轮**正文（只为完成态行为计时；缺省不参与） */
  assistantText?: string | null;
  /** 既有旅行引擎算好的路线耗时（时段）；缺省 0。本模块不自己算距离 / 米数 */
  travelPeriods?: number | null;
  /** 开场识别（scene bootstrap）：按 E06「开场禁止时间流逝」恒 0 时段 */
  sceneBootstrap?: boolean;
  /** 调用方已算好的旧抽取结果（避免重复抽取；缺省时用 userText 现算） */
  intent?: AtlasTimeIntent | null;
}

export interface AtlasElapsedPeriods {
  /** 本回合保守推导的时间推进时段数（下限；无任何依据 → 0） */
  periods: number;
  /** 人话说明：为什么是这么多（直接进回执；有界截断） */
  reason: string;
  /** 推导来源；`periods === 0` 时为 "none" */
  source: AtlasElapsedPeriodSource;
}

/** 回执说明的最大长度（禁止无界字符串进回执）。 */
const ATLAS_ELAPSED_REASON_MAX_CHARS = 160;

/**
 * 「过夜 / 翌日」这类日界完成行为 → 时段数。
 * 与 `TIME_WORD_TABLE` 的「一整天 = 4」同口径（世界时钟缺省一天 4 时段：晨 / 午 / 昏 / 夜）。
 * D03 明确不改 world 的时间数据结构，所以这里只用一个保守常量，不去读世界配置。
 */
const ATLAS_ELAPSED_DAY_PERIODS = 4;
/** 半天级完成行为（赶了半天路 / 忙了半天）→ 时段数，与「半天 = 3」同口径。 */
const ATLAS_ELAPSED_HALF_DAY_PERIODS = 3;
/** 一餐（吃完饭）→ 时段数：比「数分钟谈话」长、比半天短，取最保守的 1。 */
const ATLAS_ELAPSED_MEAL_PERIODS = 1;

/** 完成态判定的分句切分：把「吃完饭，准备出门」切成两段，后段的准备态才不会误杀已完成的饭。 */
const CLAUSE_SPLIT_PATTERN = /[，。！？；：、…,.!?;:\n\r]+/g;

/**
 * 未完成 / 计划 / 假设标记：命中所在分句出现任一词 → 该分句的完成行为整条作废。
 * 「准备吃饭」「打算睡到翌日」「还没吃完」「如果吃完饭」「明天再赶路」都在这里被挡住。
 */
const UNFINISHED_MARKERS =
  /准备|打算|想要|正想|正要|即将|马上|就要|待会|待会儿|回头|计划|还没|尚未|未曾|没有|要不要|想着|再说|说好|约定|约好|如果|若是|要是|明天|明日|后天/;

/**
 * 未完成态里的**耗时动作**词：分句同时含准备 / 打算类标记与这些动作时，只把动作记进
 * `pendingLabels`（reason 如实说明「未完成不计」），**绝不**产生任何时段。
 * 存在的理由是 §2.3 点名的「准备吃饭 → 0」：规则挡下它不算完，回执里也要看得出为什么是 0。
 */
const PENDING_ACTION_TABLE: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /吃(饭|东西|早饭|午饭|晚饭|早餐|午餐|晚餐|宵夜|夜宵)|用餐/, label: "吃饭（准备态）" },
  { pattern: /睡|就寝|歇息|休息|过夜|留宿/, label: "睡下/过夜（准备态）" },
  { pattern: /赶路|赶车|上路|出发|动身|出行|跋涉|长途|赶(往|去|回)/, label: "赶路（准备态）" },
  { pattern: /忙|收拾|整理|清点|干活|做工/, label: "忙一阵（准备态）" },
];

/** 助手**完成态**行为词表：pattern → 保守时段数 + 回执用标签。
 * 宁缺毋滥，只收高置信度、确实跨过一段时间的完成行为；「喝茶」「洗漱」「打了个盹」这类
 * 分钟级动作一律不收（§2.3：数分钟谈话没有明确流逝 → 0 时段）。
 */
const ASSISTANT_EVENT_TABLE: Array<{ pattern: RegExp; periods: number; label: string }> = [
  // 日界级：明确过夜 / 翌日（等价于跨过一天）
  {
    pattern:
      /睡到(了)?(翌日|次日|第二天|天亮|日上三竿)|一觉睡到|过了一(夜|宿)|睡了一(夜|宿)|留宿一(夜|晚)|住了一晚|翌日|次日|(到了?)?第二天(一早|清晨|早上|天刚亮|醒来|起床|拂晓)|一夜(过去|无话)|熬了一(夜|宿)|通宵(达旦|未眠|未睡)/g,
    periods: ATLAS_ELAPSED_DAY_PERIODS,
    label: "过夜/翌日",
  },
  // 整天级赶路
  {
    pattern:
      /(赶|走|行|跑)了?(一整天|整天|一天)(的)?(路|路程|车)?|长途跋涉|(星夜|昼夜)兼程|连夜(赶|行|奔|回|上路)/g,
    periods: ATLAS_ELAPSED_DAY_PERIODS,
    label: "整日赶路",
  },
  // 整天级劳作
  {
    pattern: /(忙|干|做|收拾|整理|清点)了?(一整天|整天|一天)/g,
    periods: ATLAS_ELAPSED_DAY_PERIODS,
    label: "整日劳作",
  },
  // 半天级赶路
  {
    pattern: /(赶|走|行|跑)了?(大半天|半天|半日)(的)?(路|路程|车)?/g,
    periods: ATLAS_ELAPSED_HALF_DAY_PERIODS,
    label: "半天赶路",
  },
  // 半天级劳作
  {
    pattern: /(忙|干|做|收拾|整理|清点)了?(大半天|半天|半日)/g,
    periods: ATLAS_ELAPSED_HALF_DAY_PERIODS,
    label: "半天劳作",
  },
  // 一觉醒来 / 醒来时天色已变：至少跨过数小时，但未必到日界，取 3 更保守
  {
    pattern: /一觉醒来|醒来(时)?(天|日)(已|都)?(亮|大亮|黑|晚)/g,
    periods: ATLAS_ELAPSED_HALF_DAY_PERIODS,
    label: "一觉醒来",
  },
  // 一餐：必须带宾语（"吃完了饭" 计；"吃完药" 不算）
  {
    pattern:
      /吃(完|过|罢)(了)?(饭|早饭|午饭|晚饭|早餐|午餐|晚餐|宵夜|夜宵|干粮|东西)|用(完|过)(了)?(餐|饭|早饭|午饭|晚饭)|饭(已经)?吃(完|过)了/g,
    periods: ATLAS_ELAPSED_MEAL_PERIODS,
    label: "吃完饭",
  },
];

interface AtlasCompletedEventScan {
  periods: number;
  /** 计入时段的完成行为标签（去重，表顺序） */
  labels: string[];
  /** 看着像完成、实则被未完成 / 计划态挡下的行为标签（去重；只进 reason，不计时段） */
  pendingLabels: string[];
}

/** 外部传入的时段数归一化：只有有限正数才作下限；非法值按「没有该来源」处理，不猜。 */
function normalizeElapsedPeriods(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  // 与 atlas-contract 的单回合推演时长上限同口径，避免外部传入天文数字当时段下限
  return Math.min(ATLAS_LIMITS.TURN_DURATION_MAX, Math.floor(value));
}

/** 用户侧下限：优先用调用方算好的抽取结果（D03「在 extractAtlasTimeIntent 的结果上」）。 */
function resolveUserLowerBound(input: AtlasElapsedPeriodInput): { periods: number; words: string[] } {
  const provided = input.intent;
  if (provided && typeof provided === "object" && Array.isArray(provided.timeWords)) {
    return {
      periods: normalizeElapsedPeriods(provided.suggestedPeriods),
      words: provided.timeWords.map((word) => String(word)),
    };
  }
  const intent = extractAtlasTimeIntent(typeof input.userText === "string" ? input.userText : "");
  return { periods: normalizeElapsedPeriods(intent.suggestedPeriods), words: [...intent.timeWords] };
}

/**
 * 扫助手正文里的**完成态**行为词。
 * 同一分句出现 UNFINISHED_MARKERS → 该分句的命中全部降级为 pendingLabels（不计时段）。
 */
function scanCompletedAssistantEvents(assistantText: string | null | undefined): AtlasCompletedEventScan {
  const scan: AtlasCompletedEventScan = { periods: 0, labels: [], pendingLabels: [] };
  const text = typeof assistantText === "string" ? assistantText : "";
  if (!text.trim()) return scan;

  const clauses: Array<{ start: number; end: number; text: string }> = [];
  let start = 0;
  for (const match of text.matchAll(CLAUSE_SPLIT_PATTERN)) {
    const index = match.index ?? 0;
    clauses.push({ start, end: index, text: text.slice(start, index) });
    start = index + match[0].length;
  }
  clauses.push({ start, end: text.length, text: text.slice(start) });

  for (const entry of ASSISTANT_EVENT_TABLE) {
    for (const match of text.matchAll(entry.pattern)) {
      const index = match.index ?? 0;
      const clause = clauses.find((candidate) => index >= candidate.start && index < candidate.end);
      const context = clause ? clause.text : text;
      if (UNFINISHED_MARKERS.test(context)) {
        if (!scan.pendingLabels.includes(entry.label)) scan.pendingLabels.push(entry.label);
        continue;
      }
      if (!scan.labels.includes(entry.label)) scan.labels.push(entry.label);
      scan.periods = Math.max(scan.periods, entry.periods);
    }
  }

  // 未完成 / 计划态里的耗时动作：只登记标签供 reason 说明，一律不计时段
  for (const clause of clauses) {
    if (!UNFINISHED_MARKERS.test(clause.text)) continue;
    for (const hint of PENDING_ACTION_TABLE) {
      if (hint.pattern.test(clause.text) && !scan.pendingLabels.includes(hint.label)) {
        scan.pendingLabels.push(hint.label);
      }
    }
  }
  return scan;
}

function clipElapsedReason(reason: string): string {
  return reason.length > ATLAS_ELAPSED_REASON_MAX_CHARS ? reason.slice(0, ATLAS_ELAPSED_REASON_MAX_CHARS) : reason;
}

/**
 * D03：在旧抽取结果之上保守推导本回合的时间推进时段数。
 *
 * 顺序：开场识别 → 0；否则取「用户显式时间词 / 助手完成行为 / 旅行耗时」三者最大值为下限，
 * 任一来源都不成立 → 0 时段、source="none"（无时间推进一律 0，意图可以记、人物不许动）。
 *
 * 纯函数：零 IO、零随机；不读也不改 world 的时间数据结构；同输入 → 同输出。
 */
export function deriveElapsedPeriods(input: AtlasElapsedPeriodInput = {}): AtlasElapsedPeriods {
  // 0) 开场识别：E06「开场专用指令禁止时间流逝与背景任务执行」→ 硬 0（用户时间词也不推翻）
  if (input.sceneBootstrap === true) {
    return {
      periods: 0,
      source: "none",
      reason: "开场识别（scene bootstrap）不推进时间 → 0 时段（§2.3 第 0 时段 / E06 禁止时间流逝）",
    };
  }

  const user = resolveUserLowerBound(input);
  const assistant = scanCompletedAssistantEvents(input.assistantText);
  const travel = normalizeElapsedPeriods(input.travelPeriods);

  const candidates: Array<{ source: AtlasElapsedPeriodSource; periods: number; note: string }> = [];
  if (user.periods > 0) {
    candidates.push({
      source: "user-explicit",
      periods: user.periods,
      note: `用户显式时间词「${user.words.join("、")}」→ ${user.periods} 时段`,
    });
  }
  if (assistant.periods > 0) {
    candidates.push({
      source: "assistant-event",
      periods: assistant.periods,
      note: `助手正文已完成行为「${assistant.labels.join("、")}」→ ${assistant.periods} 时段`,
    });
  }
  if (travel > 0) {
    candidates.push({
      source: "travel",
      periods: travel,
      note: `地图路线耗时 ${travel} 时段（既有旅行引擎估计）`,
    });
  }

  // 下限取最大；同值时按数组顺序（用户 > 助手完成行为 > 旅行）归属来源——不叠加。
  let winner: { source: AtlasElapsedPeriodSource; periods: number; note: string } | null = null;
  for (const candidate of candidates) {
    if (!winner || candidate.periods > winner.periods) winner = candidate;
  }

  if (!winner) {
    const pending =
      assistant.pendingLabels.length > 0
        ? `；助手正文的「${assistant.pendingLabels.join("、")}」是未完成 / 计划态，按 §2.3 不计时段`
        : "";
    return {
      periods: 0,
      source: "none",
      reason: clipElapsedReason(
        `无时间推进依据（0 时段）：用户未给显式时间词、助手正文无已完成行为、无旅行耗时${pending}`,
      ),
    };
  }

  const detail = candidates.map((candidate) => candidate.note).join("；");
  const head =
    candidates.length === 1
      ? `时间推进 ${winner.periods} 时段（下限）`
      : `时间推进 ${winner.periods} 时段（三来源取最大、不叠加）`;
  return {
    periods: winner.periods,
    source: winner.source,
    reason: clipElapsedReason(`${head}：${detail}`),
  };
}

/** prepare 注入用的时间提示行；无任何线索 → null。 */
export function renderAtlasTimeHint(userText: string): string | null {
  const intent = extractAtlasTimeIntent(userText);
  const parts: string[] = [];
  if (intent.actionMarkers.length > 0) {
    parts.push(`检测到约 ${intent.estimatedActions} 个连贯动作`);
  }
  if (intent.suggestedPeriods !== null) {
    parts.push(`时间词「${intent.timeWords.join("、")}」→ 至少 ${intent.suggestedPeriods} 时段`);
  }
  if (parts.length === 0) return null;
  return `〔时间估计〕${parts.join("；")}（校准 duration 时参考）`;
}
