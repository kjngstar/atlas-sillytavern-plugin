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
 */

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
